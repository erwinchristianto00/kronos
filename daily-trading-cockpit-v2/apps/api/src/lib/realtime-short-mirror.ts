/**
 * Real-time short live-mirror source ("mode 2").
 *
 * The live execution engine mirrors HEADLINE paper orders to the exchange, but only those whose
 * source is FRESH (now − openedAt ≤ 10 min). The CG_WIDE_FAST_SHORT VM lane is a *measurement*
 * engine — its observations carry historical entry-bar timestamps (median ~2.5h old), so every
 * one stale-rejects at admission and the mirror never fires.
 *
 * This module closes that gap WITHOUT relaxing the no-stale gate: each scan cycle it takes the
 * scanner's FRESH short candidates (currentPrice at scan time) and emits HEADLINE paper orders
 * with openedAt = createdAt = now into a DEDICATED store (data/realtime-short/) that ONLY the
 * live engine reads. The measurement paper book is never touched → zero pollution of OOS stats.
 *
 * Safety posture (enforced here + re-checked downstream by the engine):
 *   - SHORT only             — LONG candidates dropped; the controller must allow shorts.
 *   - only the stable lane   — orders are tagged CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT and only
 *                              emitted while that lane is STABLE_CANDIDATE; the engine's
 *                              live-eligibility gate re-checks STABLE at mirror time.
 *   - no stale               — openedAt = now, so the engine's freshness gate passes honestly.
 *   - experimental, env-gated — only runs when REALTIME_SHORT_MIRROR_ENABLED=1 (testnet only).
 *
 * Report/paper-only: this module never calls the exchange. It writes paper orders; the live
 * engine (kill-switches, max-concurrent, leverage/notional caps) owns all real execution.
 */
import {
  PaperExecutionRouterStore,
  PAPER_EQUITY,
  type PaperOrder,
} from "./paper-execution-router.js";

export const REALTIME_SHORT_LANE_VARIANT_ID = "CG_WIDE_FAST_SHORT";
export const REALTIME_SHORT_SELECTED_LANE_ID = `CG_VARIANT_MATRIX:${REALTIME_SHORT_LANE_VARIANT_ID}`;
const DEFAULT_MAX_PER_CYCLE = 3;

// CG_WIDE_FAST_SHORT lane geometry (current-guard-variant-matrix.ts): wide >=300bps stop,
// 0.5R take-profit, exitRule "tp1_full" (bank 100% at TP1). The scanner's own tp1 is computed
// for a different entry-variant anchor and lands ~0.14% from the live price (RR garbage), so we
// DERIVE stop + TP from the live entry and the stop DISTANCE — anchor-independent and coherent.
const STOP_FLOOR_FRAC = 0.03; // 300bps floor (lane stopFloorBps)
const STOP_CAP_FRAC = 0.12; // guard against anchor-mismatch blow-ups (12% max)
const TP_REWARD_MULTIPLE = 0.5; // lane tpRewardMultiple
const REALTIME_SHORT_EXIT_RULE = "tp1_full" as const; // lane exitRule: full exit at TP1, no runner

let _store: PaperExecutionRouterStore | null = null;
/**
 * Dedicated, isolated store (separate file/dir from the measurement paper book). Shared
 * singleton: the emitter (scan cycle) writes and the live engine reads the same in-memory
 * instance within the one API process.
 */
export function getRealtimeShortMirrorStore(): PaperExecutionRouterStore {
  if (!_store) _store = new PaperExecutionRouterStore("data/realtime-short");
  return _store;
}

export function _resetRealtimeShortMirrorStoreForTests(): void {
  _store = null;
}

export function isRealtimeShortMirrorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REALTIME_SHORT_MIRROR_ENABLED === "1";
}

/** Controller modes under which it is safe to OPEN shorts. */
function controllerAllowsShort(mode: string | null | undefined): boolean {
  const m = (mode ?? "").toUpperCase();
  return m === "SHORT_ONLY" || m === "BOTH_ALLOWED";
}

export interface RealtimeShortCandidate {
  symbol: string;
  direction: "LONG" | "SHORT";
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfitLevels: number[];
  stopDistanceBps?: number | null;
}

export interface RealtimeShortMirrorInputs {
  candidates: RealtimeShortCandidate[];
  regime: string | null;
  controllerMode: string | null;
  /** CG_WIDE_FAST_SHORT must currently be STABLE_CANDIDATE (only stable short lanes). */
  stableShortLaneActive: boolean;
  /** ISO timestamp — injected for determinism/testability. */
  now: string;
  maxPerCycle?: number;
}

export interface RealtimeShortMirrorResult {
  emitted: number;
  skipped: number;
  reasons: string[];
}

function isPos(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * The live engine derives every Binance clientOrderId from the TAIL of paperOrderId
 * (`live-execution-engine.ts`: `idTail = paperOrderId.slice(-18)` → `dtc-${idTail}-e/-s/-t`),
 * capped at Binance's 36-char limit. So paperOrderId MUST be short, charset-safe ([a-z0-9-]),
 * and have a UNIQUE last-18 per order. A symbol-then-time layout that is ≤18 chars total makes
 * slice(-18) == the whole id → guaranteed unique per (symbol, cycle); two shorts emitted in the
 * same scan cycle therefore never collide (the -4116 "ClientOrderId is duplicated" bug that
 * emergency-flattened LINK/SOL/ETH and inflated the loss streak).
 */
export function makeRealtimeShortPaperOrderId(symbol: string, nowIso: string): string {
  const ms = new Date(nowIso).getTime();
  const t36 = Number.isFinite(ms) ? ms.toString(36) : "0";
  const sym =
    symbol
      .replace(/USDT$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .slice(0, 6) || "x";
  return `rts-${sym}-${t36}`;
}

export function runRealtimeShortMirror(
  inputs: RealtimeShortMirrorInputs,
  store: PaperExecutionRouterStore = getRealtimeShortMirrorStore(),
): RealtimeShortMirrorResult {
  const result: RealtimeShortMirrorResult = { emitted: 0, skipped: 0, reasons: [] };
  const maxPerCycle = inputs.maxPerCycle ?? DEFAULT_MAX_PER_CYCLE;

  // Only stable short lanes: hard gate on CG_WIDE_FAST_SHORT being STABLE.
  if (!inputs.stableShortLaneActive) {
    result.reasons.push("stable_short_lane_inactive");
    return result;
  }
  // Never open shorts unless the controller explicitly allows them (no-long, regime-gated).
  if (!controllerAllowsShort(inputs.controllerMode)) {
    result.reasons.push(`controller_blocks_short:${(inputs.controllerMode ?? "UNKNOWN").toUpperCase()}`);
    return result;
  }

  const bucket = inputs.now.slice(0, 16); // yyyy-mm-ddThh:mm — one emission per symbol per minute
  for (const c of inputs.candidates) {
    if (result.emitted >= maxPerCycle) {
      result.skipped += 1;
      result.reasons.push(`cap_reached:${c.symbol}`);
      continue;
    }
    if (c.direction !== "SHORT") {
      result.skipped += 1;
      result.reasons.push(`not_short:${c.symbol}`);
      continue;
    }
    const entry = c.currentPrice;
    if (!isPos(entry)) {
      result.skipped += 1;
      result.reasons.push(`bad_geometry:${c.symbol}`);
      continue;
    }
    // Require a real short setup: the scanner's stop must sit ABOVE the live price. If price has
    // already run up through it, the short is stale/invalid — skip rather than chase.
    if (!isPos(c.stopLoss) || !(c.stopLoss > entry)) {
      result.skipped += 1;
      result.reasons.push(`no_short_stop:${c.symbol}`);
      continue;
    }
    // Coherent geometry anchored to the LIVE entry: wide stop (>=300bps, floored/capped) + 0.5R TP.
    const stopDistFrac = Math.min(
      Math.max((c.stopLoss - entry) / entry, STOP_FLOOR_FRAC),
      STOP_CAP_FRAC,
    );
    const stop = entry * (1 + stopDistFrac); // above entry
    const tp1 = entry * (1 - TP_REWARD_MULTIPLE * stopDistFrac); // 0.5R below entry
    const dedupeKey = `RTSHORT:${c.symbol}:${bucket}`;
    if (store.hasOrder(dedupeKey)) {
      result.skipped += 1;
      result.reasons.push(`duplicate:${c.symbol}`);
      continue;
    }
    const paperOrderId = makeRealtimeShortPaperOrderId(c.symbol, inputs.now);
    store.add(
      buildRealtimeShortOrder(c, entry, stop, tp1, stopDistFrac, inputs, dedupeKey, paperOrderId),
    );
    result.emitted += 1;
  }
  return result;
}

function buildRealtimeShortOrder(
  c: RealtimeShortCandidate,
  entry: number,
  stop: number,
  tp1: number,
  stopDistFrac: number,
  inputs: RealtimeShortMirrorInputs,
  dedupeKey: string,
  paperOrderId: string,
): PaperOrder {
  const now = inputs.now;
  const stopDistanceBps = stopDistFrac * 10_000; // coherent with the derived stop
  // Record-only sizing fields — the live engine recomputes real size from its own config
  // (riskUsdPerTrade / maxNotionalPerTrade). These are forensic only and never executed on.
  const plannedRiskAmount = PAPER_EQUITY * 0.01;
  return {
    paperOrderId,
    sourceType: "REALTIME_SHORT_MIRROR",
    sourceObservationId: dedupeKey,
    sourceSignalId: null,
    dedupeKey,
    createdAt: now,
    updatedAt: now,
    openedAt: now, // FRESH — the whole point: passes the no-stale gate honestly
    symbol: c.symbol,
    direction: "SHORT",
    regime: inputs.regime,
    controllerMode: inputs.controllerMode ?? "SHORT_ONLY",
    selectedLaneId: REALTIME_SHORT_SELECTED_LANE_ID,
    routerPermission: "HEADLINE",
    entryPrice: entry,
    stopLoss: stop,
    takeProfitLevels: [tp1],
    variantExitRule: REALTIME_SHORT_EXIT_RULE, // tp1_full → engine banks 100% at TP1 (no runner)
    plannedStopDistanceBps: stopDistanceBps,
    riskPctOfEquity: 1,
    paperEquity: PAPER_EQUITY,
    plannedRiskAmount,
    plannedPositionNotional: plannedRiskAmount / (stopDistanceBps / 10_000),
    plannedRiskR: 1,
    oosUnconfirmed: false,
    infraNotReady: false,
    paperRiskLabel: "EXPERIMENTAL",
    paperOrderMode: "HEADLINE",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: "CREATED",
    grossR: null,
    costR: null,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
  };
}

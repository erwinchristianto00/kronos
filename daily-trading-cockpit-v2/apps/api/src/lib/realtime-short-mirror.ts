/**
 * Real-time stable-candidate live-mirror source ("mode 2").
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
 *   - controller-direction gate — LONG/SHORT candidates require the controller to allow that side.
 *   - stable-candidate only     — only exact STABLE_CANDIDATE VM rows can emit.
 *   - live-supported geometry   — maker_limit lanes are not mirrored as MARKET orders.
 *   - no stale                  — openedAt = now, so the engine's freshness gate passes honestly.
 *   - experimental, env-gated   — only runs when REALTIME_SHORT_MIRROR_ENABLED=1 (testnet only).
 *
 * Report/paper-only: this module never calls the exchange. It writes paper orders; the live
 * engine (kill-switches, max-concurrent, leverage/notional caps) owns all real execution.
 */
import {
  PaperExecutionRouterStore,
  PAPER_EQUITY,
  type PaperOrder,
} from "./paper-execution-router.js";
import {
  LANE_SELECTOR_V2_LIVE_SUPPORTED_VARIANT_IDS,
  estimateLaneSelectorV2Regime,
  isLaneSelectorV2LongCapableVariantId,
  isLaneSelectorV2LongWideStopOverride,
  isLaneSelectorV2SupportedVariantId,
  laneSelectorV2LaneId,
  selectLaneV2,
  type LaneSelectorV2Geometry,
  type LaneSelectorV2EstimatedRegime,
  type LaneSelectorV2LaneState,
} from "./lane-selector-v2.js";
import type { VariantMatrixVariantId } from "./current-guard-variant-matrix.js";
import type { RegimeRotationShortlistReport } from "./regime-rotation-shortlist.js";

export const REALTIME_SHORT_LANE_VARIANT_ID = "CG_WIDE_FAST_SHORT";
export const REALTIME_SHORT_SELECTED_LANE_ID = `CG_VARIANT_MATRIX:${REALTIME_SHORT_LANE_VARIANT_ID}`;
const LONG_WIDE_VARIANT_ID = "CG_WIDE_FAST_LONG"; // LONG lane (operator 2026-06-29): fast 0.5R bank, fires only in WIDE_TREND bull
const MIXED_SYMBOL_BLOCKLIST = new Set(["NEARUSDT"]);
const DEFAULT_MAX_PER_CYCLE = 3;
const MANUAL_ONLY_LIVE_MIRROR_VARIANT_IDS = new Set<string>([
  "CG_EXP_LONG_WIDE_FAST_10X",
  "CG_EXP_LONG_TIGHT_FAST_10X",
  "CG_EXP_LONG_MFE_GIVEBACK_10X",
  "CG_EXP_SHORT_MFE_GIVEBACK_10X",
  "CG_EXP_SHORT_WIDE_FAST_10X",
]);
// Short lanes the operator force-enables BEFORE they naturally reach STABLE_CANDIDATE — lifted to
// STABLE here + allowed through the app.ts eligibility gate. 2026-06-29: CG_WIDE_FAST_SHORT only
// (WATCHABLE, +0.110R — clearly the most deserving); CG_WIDE_STOP_TP_WIDE stays gated until STABLE.
export const FORCE_ELIGIBLE_SHORT_VARIANT_IDS = new Set<string>(["CG_WIDE_FAST_SHORT"]);
// LONG counterpart (operator 2026-07-07: "buka akses CG_WIDE_FAST_LONG, gw mau trade di saat regime
// bullish"): without this, FAST_LONG only ever emitted under the FULL WIDE_TREND+LONG estimate —
// a plain bullish regime (controller LONG-permissive, autopilot allocating FAST_LONG 60-70%) never
// produced a single long candidate. Forcing lifts the lane to STABLE at the emitter; the
// controller-direction gate, bullish rotation shortlist (best-symbols whitelist), proven-symbols
// tier, and all engine caps still apply — so it still trades ONLY when the regime allows longs.
export const FORCE_ELIGIBLE_LONG_VARIANT_IDS = new Set<string>(["CG_WIDE_FAST_LONG"]);

export const REALTIME_SHORT_ALLOWED_VARIANT_IDS = LANE_SELECTOR_V2_LIVE_SUPPORTED_VARIANT_IDS.filter(
  (id) => !MANUAL_ONLY_LIVE_MIRROR_VARIANT_IDS.has(id),
);

export function isRealtimeShortAllowedVariantId(id: string | null | undefined): id is VariantMatrixVariantId {
  return isLaneSelectorV2SupportedVariantId(id) && !MANUAL_ONLY_LIVE_MIRROR_VARIANT_IDS.has(id);
}

export function isRealtimeShortAllowedLaneId(laneId: string | null | undefined): boolean {
  const variantId = laneId?.split(":").pop();
  return isRealtimeShortAllowedVariantId(variantId);
}

export function isRealtimeShortSelectableVariantId(
  id: string | null | undefined,
  manualSelected = false,
): id is VariantMatrixVariantId {
  return isLaneSelectorV2SupportedVariantId(id) &&
    (!MANUAL_ONLY_LIVE_MIRROR_VARIANT_IDS.has(id) || manualSelected);
}

export function isRealtimeShortSelectableLaneId(
  laneId: string | null | undefined,
  manualSelected = false,
): boolean {
  const variantId = laneId?.split(":").pop();
  return isRealtimeShortSelectableVariantId(variantId, manualSelected);
}

export function realtimeShortSelectedLaneId(variantId: VariantMatrixVariantId): string {
  return laneSelectorV2LaneId(variantId);
}

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

export interface RealtimeShortCandidate {
  symbol: string;
  direction: "LONG" | "SHORT";
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfitLevels: number[];
  stopDistanceBps?: number | null;
}

export type RealtimeShortLaneState = LaneSelectorV2LaneState;

export interface RealtimeShortMirrorInputs {
  candidates: RealtimeShortCandidate[];
  regime: string | null;
  controllerMode: string | null;
  controllerConfidence?: string | null;
  estimatedRegime?: LaneSelectorV2EstimatedRegime | null;
  /** Back-compat: CG_WIDE_FAST_SHORT must currently be STABLE_CANDIDATE. Prefer stableShortLanes. */
  stableShortLaneActive?: boolean;
  /** Current VM rows for the only live-testnet-allowed short lanes. Must be STABLE_CANDIDATE. */
  stableShortLanes?: RealtimeShortLaneState[];
  /** Operator force: lift FORCE_ELIGIBLE_SHORT_VARIANT_IDS to STABLE even before they mature. */
  forceFastShort?: boolean;
  /** Operator force: lift FORCE_ELIGIBLE_LONG_VARIANT_IDS to STABLE so FAST_LONG can emit in any
   *  long-permissive regime, not only the strict WIDE_TREND+LONG estimate. */
  forceFastLong?: boolean;
  /** Auto-wire crowding veto: skip entries into a crowd already EXTREME on the SAME side. */
  crowdingVetoEnabled?: boolean;
  /** Per-symbol crowd state at signal time (caller fetches); used by the crowding veto. */
  crowdingBySymbol?: Record<string, { crowdSide: string; crowdingLevel: string }>;
  /** Symbol-specific bullish/bearish rotation allowlist derived from the main VM report. */
  rotationShortlist?: RegimeRotationShortlistReport | null;
  /** Variant ids explicitly picked by the operator allocation selector. Manual-only
   *  high-risk lanes are ignored unless present here. */
  manualEnabledVariantIds?: Set<string>;
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

function isMixedSymbolBlocked(symbol: string, estimatedRegime: LaneSelectorV2EstimatedRegime): boolean {
  return estimatedRegime.direction === "MIXED" && MIXED_SYMBOL_BLOCKLIST.has(symbol.toUpperCase());
}

function effectiveLaneStates(
  inputs: RealtimeShortMirrorInputs,
  estimatedRegime: LaneSelectorV2EstimatedRegime,
): RealtimeShortLaneState[] {
  const baseRaw = inputs.stableShortLanes
    ? inputs.stableShortLanes
    : inputs.stableShortLaneActive
    ? [{ variantId: REALTIME_SHORT_LANE_VARIANT_ID, status: "STABLE_CANDIDATE" }]
    : [];
  const base = baseRaw.filter((state) =>
    isRealtimeShortSelectableVariantId(state.variantId, inputs.manualEnabledVariantIds?.has(state.variantId) === true),
  );
  const withLongWideOverride = isLaneSelectorV2LongWideStopOverride({
    variantId: LONG_WIDE_VARIANT_ID,
    direction: "LONG",
    estimatedRegime,
  })
    ? (() => {
        const found = base.some((state) => state.variantId === LONG_WIDE_VARIANT_ID);
        const lifted = base.map((state) =>
          state.variantId === LONG_WIDE_VARIANT_ID
            ? { ...state, status: "STABLE_CANDIDATE" }
            : state,
        );
        return found
          ? lifted
          : [{ variantId: LONG_WIDE_VARIANT_ID, status: "STABLE_CANDIDATE" }, ...lifted];
      })()
    : base;
  // Force-enabled lanes → lift to STABLE_CANDIDATE so the mirror emits them before they naturally
  // mature. OFF by default (preserves the stable-only safety gate); the operator turns each side on
  // per-instance via REALTIME_SHORT_FORCE_FAST_SHORT / REALTIME_SHORT_FORCE_FAST_LONG. selectLaneV2's
  // direction gate still blocks a forced lane whenever the regime doesn't allow that side.
  //
  // 2026-07-08 (operator: "wire lane baru ke allocation selection, jangan sampe ada blocker"):
  // ALSO force-lift whatever the operator/regime-autopilot has EXPLICITLY allocated right now
  // (manualEnabledVariantIds — e.g. CG_WIDE_LONG_RUNNER, CG_MFE_GIVEBACK), regardless of the fixed
  // FORCE_ELIGIBLE_* sets above. Deliberately NOT added to those sets directly: doing so made the
  // new lane compete on raw score against FAST_SHORT/FAST_LONG in EVERY cycle (even with no
  // allocation active), which regressed the 2026-07-07 "FAST_LONG always wins its forced slot"
  // guarantee. Gating the lift on an ACTIVE allocation keeps today's default behavior byte-for-byte
  // identical when nothing new is allocated, and only a variant the operator actually picked ever
  // gets to compete for (and, via policyPreferredVariants' matching bypass, WIN) the slot.
  const forcedVariantIds = [
    ...(inputs.forceFastShort ? FORCE_ELIGIBLE_SHORT_VARIANT_IDS : []),
    ...(inputs.forceFastLong ? FORCE_ELIGIBLE_LONG_VARIANT_IDS : []),
    ...(inputs.manualEnabledVariantIds ?? []),
  ];
  let withForced = withLongWideOverride;
  for (const variantId of forcedVariantIds) {
    if (!isRealtimeShortSelectableVariantId(variantId, inputs.manualEnabledVariantIds?.has(variantId) === true)) continue;
    withForced = withForced.some((state) => state.variantId === variantId)
      ? withForced.map((state) =>
          state.variantId === variantId ? { ...state, status: "STABLE_CANDIDATE" } : state,
        )
      : [{ variantId, status: "STABLE_CANDIDATE" }, ...withForced];
  }
  return withForced;
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
  const estimatedRegime = inputs.estimatedRegime ?? estimateLaneSelectorV2Regime({
    regime: inputs.regime,
    controllerMode: inputs.controllerMode,
    confidence: inputs.controllerConfidence,
  });
  const laneStates = effectiveLaneStates(inputs, estimatedRegime);

  const hasAnyStableLane = laneStates.some((state) =>
    state.status === "STABLE_CANDIDATE" &&
    isRealtimeShortSelectableVariantId(state.variantId, inputs.manualEnabledVariantIds?.has(state.variantId) === true),
  );
  if (!hasAnyStableLane && !inputs.rotationShortlist) {
    result.reasons.push("stable_lane_inactive");
    return result;
  }

  const bucket = inputs.now.slice(0, 16); // yyyy-mm-ddThh:mm — one emission per symbol per minute
  for (const c of inputs.candidates) {
    if (result.emitted >= maxPerCycle) {
      result.skipped += 1;
      result.reasons.push(`cap_reached:${c.symbol}`);
      continue;
    }
    const entry = c.currentPrice;
    if (isMixedSymbolBlocked(c.symbol, estimatedRegime)) {
      result.skipped += 1;
      result.reasons.push(`mixed_symbol_blocked:${c.symbol}`);
      continue;
    }
    // Auto-wired crowding veto (research edge #1): don't ADD to a crowd already EXTREME on the same
    // side as this trade (over-long longs / over-short shorts squeeze the late entrant). Our
    // short-FADE still fires into a LONG-crowded book (that's the fade we want). Pure risk reducer.
    if (inputs.crowdingVetoEnabled) {
      const cr = inputs.crowdingBySymbol?.[c.symbol];
      if (cr && cr.crowdingLevel === "EXTREME" && cr.crowdSide === c.direction) {
        result.skipped += 1;
        result.reasons.push(`crowded_extreme_same_side:${c.symbol}`);
        continue;
      }
    }
    if (!isPos(entry)) {
      result.skipped += 1;
      result.reasons.push(`bad_geometry:${c.symbol}`);
      continue;
    }
    if (!isPos(c.stopLoss)) {
      result.skipped += 1;
      result.reasons.push(`no_stop:${c.symbol}`);
      continue;
    }
    const selected = selectLaneV2({
      candidate: {
        symbol: c.symbol,
        direction: c.direction,
        currentPrice: entry,
        stopLoss: c.stopLoss,
        takeProfitLevels: c.takeProfitLevels,
        stopDistanceBps: c.stopDistanceBps,
      },
      laneStates,
      regime: inputs.regime,
      controllerMode: inputs.controllerMode,
      controllerConfidence: inputs.controllerConfidence,
      estimatedRegime,
      rotationShortlist: inputs.rotationShortlist,
      // 2026-07-08: an active operator/preset allocation that names a LONG-capable variant ALSO
      // opens the tactical-longs block — without this, a newly-allocated LONG lane (e.g.
      // CG_WIDE_LONG_RUNNER) would force-lift to STABLE via manualEnabledVariantIds above, then
      // still get rejected by policyBlockReason's "long_tactical_disabled" outside a confident
      // WIDE_TREND bull. The controller direction gate still runs first — this only lifts the
      // tactical-longs block, not the regime gate itself. Scoped to LONG-capable variants
      // specifically (not a blanket "any allocation" check) so allocating an unrelated SHORT-only
      // lane (e.g. SHORT_FADE_EXHAUSTION_CROWDED, which isn't even a VM variant id) never
      // incidentally unlocks tactical longs the operator didn't intend to enable.
      allowTacticalLongs:
        inputs.forceFastLong === true ||
        Array.from(inputs.manualEnabledVariantIds ?? []).some((id) => isLaneSelectorV2LongCapableVariantId(id)),
      manualEnabledVariantIds: inputs.manualEnabledVariantIds,
      now: inputs.now,
    });
    if (!selected.selected) {
      result.skipped += 1;
      result.reasons.push(`${selected.rejected[0] ?? "no_live_geometry"}:${c.symbol}`);
      continue;
    }
    const dedupeKey = `RTSHORT:${c.symbol}:${bucket}`;
    if (store.hasOrder(dedupeKey)) {
      result.skipped += 1;
      result.reasons.push(`duplicate:${c.symbol}`);
      continue;
    }
    const paperOrderId = makeRealtimeShortPaperOrderId(c.symbol, inputs.now);
    store.add(
      buildRealtimeShortOrder(c, selected.selected, inputs, dedupeKey, paperOrderId),
    );
    result.emitted += 1;
  }
  return result;
}

function buildRealtimeShortOrder(
  c: RealtimeShortCandidate,
  geometry: LaneSelectorV2Geometry,
  inputs: RealtimeShortMirrorInputs,
  dedupeKey: string,
  paperOrderId: string,
): PaperOrder {
  const now = inputs.now;
  const { lane, entry, stop, tp1, stopDistanceBps } = geometry;
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
    direction: c.direction,
    regime: inputs.regime,
    controllerMode: inputs.controllerMode ?? (c.direction === "SHORT" ? "SHORT_ONLY" : "LONG_ONLY"),
    controllerConfidence: inputs.controllerConfidence ?? null,
    selectedLaneId: lane.selectedLaneId,
    routerPermission: "HEADLINE",
    entryPrice: entry,
    stopLoss: stop,
    takeProfitLevels: [tp1],
    variantExitRule: lane.exitRule,
    fillMode: lane.definition.fillMode,
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

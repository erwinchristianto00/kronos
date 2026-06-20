/**
 * CURRENT-GUARD VARIANT MATRIX (REPORT-ONLY FORWARD A/B HARNESS)
 *
 * Isolated, simulation-only tape that takes the SAME qualifying signal
 * population the F****** post-cutover current-guard lane operates on, then
 * applies 6 fixed stop/TP geometry variants to each signal and resolves each
 * variant prospectively by walking real candles. The point is a clean,
 * apples-to-apples A/B: every variant sees the same signals, every variant is
 * resolved by the same candle-walk engine and the same conventions, so any
 * difference in economics is attributable to geometry — not measurement.
 *
 * HARD CONTRACT (do not weaken):
 *  - report-only. This module never touches normal shadow positions, route
 *    selection, scoring, readiness, admission, or any live behavior.
 *  - never throws to callers; all I/O is wrapped and best-effort.
 *  - its own isolated JSON store (data/current-guard-variant-matrix.json); it
 *    NEVER reads or writes data/shadow-positions.json.
 *  - resolution is conservative and never optimistic. Same-candle SL+TP
 *    ambiguity is refined with 1m candles where available; if it cannot be
 *    refined it resolves SL-first (a loss). We never assume a higher target
 *    "would have" been reached.
 *  - liveBlocked stays true and microPilotAllowed stays false regardless of
 *    what any variant shows here. Promotion remains report-only until explicit
 *    manual approval.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type ShadowPosition } from "@dtc/shared";

import {
  BASE_ROUTE_POLICY_VERSION_V2,
  MIN_ADMISSION_STOP_DISTANCE_BPS_EXPORT,
  REALISTIC_FEE_BPS_PER_SIDE,
  REALISTIC_ROUND_TRIP_FEE_SLIP_BPS,
} from "./shadow-engine.js";
import { isStrongTrendRegime } from "./regime-direction-controller.js";

export const CURRENT_GUARD_VARIANT_MATRIX_LANE = "CURRENT_GUARD_VARIANT_MATRIX_V1" as const;
export const CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION = "current-guard-variant-matrix-v1" as const;

type Direction = "LONG" | "SHORT";

export type VariantMatrixVariantId =
  | "CG_BASELINE_CURRENT"
  | "CG_WIDE_STOP_TP_WIDE"
  | "CG_WIDE_LONG_RUNNER"
  | "CG_WIDE_FAST_SHORT"
  | "CG_TRAIL_AFTER_TP1"
  | "CG_SCALEOUT_TP1_TRAIL"
  | "CG_NO_FIB500_ENTRYSET"
  | "CG_MAKER_LIMIT_SIM"
  | "BL_TREND_R15_STOP200_FULL"
  | "BL_TREND_SCALEOUT_STOP200"
  // Long-only reward-geometry research lanes (GPT deep-research candidates): wide stop floor
  // + 1.2R TP, attacking the "too little realised reward vs cost" long failure mode.
  | "LG_R12_STOP250_FULL"
  | "LG_R12_STOP300_FULL";

export const BULL_TREND_VARIANT_ID = "BL_TREND_R15_STOP200_FULL" as const;
export const BULL_SCALEOUT_VARIANT_ID = "BL_TREND_SCALEOUT_STOP200" as const;

export type VariantExitRule = "tp1_full" | "trail_after_tp1" | "scaleout_tp1_trail";
export type VariantFillMode = "taker" | "maker_limit";

export type VariantObservationStatus =
  | "OPEN"
  | "CLOSED_WIN"
  | "CLOSED_LOSS"
  | "NO_FILL"
  | "EXPIRED"
  | "DATA_FAILURE"
  | "REJECTED";

export type VariantIntrabarStatus =
  | "VALID_5M_ORDERED"
  | "AMBIGUOUS_SAME_CANDLE_SL_FIRST"
  | "RESOLVED_BY_1M"
  | "INTRABAR_UNAVAILABLE"
  | null;

export type VariantMatrixStatus =
  | "COLLECTING"
  | "WATCHABLE"
  | "STABLE_CANDIDATE"
  | "PROMOTION_CANDIDATE"
  | "REJECT";

// --- Cost model (per-variant, honest: cost in R = roundTripBps / stopDistanceBps) ---
// Wider stops therefore carry a smaller cost-in-R, which is the single most
// important geometry fact the edge audit surfaced.
export const TAKER_ROUNDTRIP_BPS = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS; // 22 (fee+slippage, both sides)
// Maker provides liquidity (limit, no spread cross). Binance USD-M maker fee
// ~2bps/side; we add a conservative buffer so we never over-claim the maker edge.
export const MAKER_ROUNDTRIP_BPS = REALISTIC_FEE_BPS_PER_SIDE + 1; // 6 (conservative maker round-trip)
export const STRESS_EXTRA_BPS = 10; // +10bps slippage stress test

// --- Geometry constants ---
export const WIDE_STOP_MIN_BPS = 300; // Paper-admissible wide/trail variants require >= 300bps stops
export const MAKER_FILL_WINDOW_CANDLES = 12; // 1h on 5m candles to get a maker fill
const CANDLE_MS = 5 * 60 * 1000;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Open observations older than this threshold are surfaced as "stale" in diagnostics. */
const STALE_OPEN_WARN_MS = 72 * 60 * 60 * 1000; // 72 h
const MFE_MAE_CAP_R = 20;

// --- Anti-overfit gate thresholds (Part 5) ---
// WATCHABLE = COLLECTING→WATCHABLE gate: how many honest closes a lane needs
// before it leaves SHADOW_ONLY and can trade HEADLINE/live. Env-tunable
// (WATCHABLE_MIN_FRESH) so collection speed can be dialed without a rebuild —
// lower = faster to real trades but thinner evidence. Was 50, then 20; default 20
// here, the running system/VPS sets it lower in .env for the fresh-start collection
// sprint. STABLE/PROMOTION stay high so FULL promotion still needs depth, and the
// edge gate keeps its own EDGE_MIN_SAMPLES=30 before it will veto/allow a slice.
export const WATCHABLE_MIN_FRESH = Number(process.env.WATCHABLE_MIN_FRESH) || 20;
export const STABLE_MIN_FRESH = 100;
export const PROMOTION_MIN_FRESH = 200;
export const NET_STRONG_R = 0.05;
export const PF_STRONG = 1.2;
export const PF_FLOOR = 1.0;
export const PAYOFF_WATCH = 0.5;
export const PAYOFF_STABLE = 0.75;
export const MAX_DRAWDOWN_R_LIMIT = 5;
export const MAX_TOP_SYMBOL_SHARE = 0.4;
export const PROMOTION_MIN_CALENDAR_DAYS = 5;
export const PROMOTION_MIN_DISTINCT_REGIMES = 2;

export interface VariantMatrixVariantDefinition {
  id: VariantMatrixVariantId;
  label: string;
  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  costModel: VariantFillMode; // "taker" or "maker_limit" cost basis
  description: string;
  /**
   * Parameterized wide geometry. When set, the stop is floored at `stopFloorBps` and the paired
   * TP is placed at `tpRewardMultiple` × the (floored) risk distance. Omitted ⇒ raw geometry.
   * (CG_WIDE/CG_TRAIL keep their hardcoded WIDE_STOP_MIN_BPS / 1.0R behavior.)
   */
  stopFloorBps?: number;
  tpRewardMultiple?: number;
  /** Variant only admits/derives on LONG signals (rejected on SHORT). */
  longOnly?: boolean;
  /** Variant only admits/derives on SHORT signals (rejected on LONG). */
  shortOnly?: boolean;
  /** Variant is only collected while the controller is explicitly BULLISH + LONG_ONLY. */
  bullishOnly?: boolean;
  /**
   * Per-variant max-hold (hours) before the resolver marks the position to market.
   * Omitted ⇒ the global PAPER_MAX_HOLD_MS (72h). Let-it-run lanes (wide stop +
   * far TP) extend this so a slow winner is given room to trend instead of being
   * cut at 72h.
   */
  maxHoldHours?: number;
}

export const VARIANT_MATRIX_DEFINITIONS: readonly VariantMatrixVariantDefinition[] = [
  {
    id: "CG_BASELINE_CURRENT",
    label: "Baseline current geometry (tp1 full exit)",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    description: "Benchmark: same entry/stop/tp1 as the post-cutover lane, taker cost, full exit at tp1.",
  },
  {
    id: "CG_WIDE_STOP_TP_WIDE",
    label: "Wide stop (>=300bps) with widened TP (~1R payoff)",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    description: "Widen stop to >=300bps AND widen TP to ~1R so the payoff ratio targets ~1.0 (never widen stop alone).",
  },
  {
    id: "CG_TRAIL_AFTER_TP1",
    label: "Wide stop (>=300bps) with trail after 1R touch",
    exitRule: "trail_after_tp1",
    fillMode: "taker",
    costModel: "taker",
    description: "Use >=300bps paired 1R geometry; on target touch move stop to breakeven and ride the exact candle path.",
  },
  {
    id: "CG_SCALEOUT_TP1_TRAIL",
    label: "Scale out 50% at TP1, trail the runner",
    exitRule: "scaleout_tp1_trail",
    fillMode: "taker",
    costModel: "taker",
    description: "Lock 50% at TP1, trail the remaining 50% at breakeven; blended R from the exact candle path.",
  },
  {
    id: "CG_NO_FIB500_ENTRYSET",
    label: "Baseline excluding fib_500_entry signals",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    description: "Reject fib_500_entry signals (counted separately); otherwise identical to the baseline.",
  },
  {
    id: "CG_MAKER_LIMIT_SIM",
    label: "Maker/limit entry (no-fill risk) with maker cost",
    exitRule: "tp1_full",
    fillMode: "maker_limit",
    costModel: "maker_limit",
    description: "Post-only limit at entry: fills only on a pullback to entry within the fill window, else NO_FILL; maker cost.",
  },
  {
    id: BULL_TREND_VARIANT_ID,
    label: "Bull trend: stop >=200bps, TP 1.5R (full exit)",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 200,
    tpRewardMultiple: 1.5,
    longOnly: true,
    bullishOnly: true,
    description:
      "Pure bullish trend lane: 200bps minimum breathing room with a 1.5R full-exit target. " +
      "At the floor, the 300bps target stays below the observed ~450bps long-move cliff while " +
      "improving payoff asymmetry and keeping 22bps round-trip cost near 0.11R.",
  },
  {
    id: BULL_SCALEOUT_VARIANT_ID,
    label: "Bull trend: stop >=200bps, scaleout 50% at 1R + BE runner",
    exitRule: "scaleout_tp1_trail",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 200,
    tpRewardMultiple: 1.0,
    longOnly: true,
    bullishOnly: true,
    description:
      "A/B sibling of the bull trend lane under identical entry gates: lock 50% at 1R and trail " +
      "the runner at breakeven — the exit family that is proven on the SHORT book. Tests whether " +
      "the long failure mode (losers run to stop, winners exit small) is an exit problem.",
  },
  {
    id: "LG_R12_STOP250_FULL",
    label: "Long: stop ≥250bps, TP 1.2R (full exit)",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 250,
    tpRewardMultiple: 1.2,
    longOnly: true,
    description: "Reward-geometry research (GPT #1): floor stop at 250bps, place TP at 1.2× risk. Tests modest asymmetry while keeping TP inside the realised long-move band (cliff at ~450bps).",
  },
  {
    id: "LG_R12_STOP300_FULL",
    label: "Long: stop ≥300bps, TP 1.2R (full exit)",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 1.2,
    longOnly: true,
    description: "Reward-geometry research (GPT #2): same 300bps breathing room as the proven CG_WIDE long lane, but bank 1.2R instead of 1.0R. Pure 'monetise more of the move' test.",
  },
  {
    // Placed last among the long lanes deliberately: on a no-evidence score tie
    // it must NOT preempt the established BL_TREND collection default (stable
    // sort preserves input order). Once it earns better paper economics the
    // ranker selects it on score — competing on evidence, not list position.
    id: "CG_WIDE_LONG_RUNNER",
    label: "LONG let-it-run: wide >=300bps stop, far 3R TP, ~6-day hold",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300, // same breathing room as CG_WIDE; also routes through the wide-geometry path
    tpRewardMultiple: 3,
    maxHoldHours: 144,
    longOnly: true,
    description:
      "The honest improvement of the wide-stop thesis. CG_WIDE's old 1R payoff loses (1:1 needs " +
      ">50% WR, the book gets ~35%): it banks small at 1R while eating full stops. The exit search " +
      "(scripts/cgwide-exit-search.ts) re-resolved every historical CG_WIDE order under let-it-run " +
      "geometry and found LONG edge climbs monotonically with TP distance and hold (1R −0.03 → 3R " +
      "−6d +0.107R) — longs trend and get marked-to-market above water — while SHORT stays negative " +
      "under every geometry. So this lane keeps the wide stop but places a FAR 3R target and holds " +
      "~6 days, LONG-only. Direction is enforced here (longOnly) and by the regime edge gate.",
  },
  {
    // The SHORT mirror of the long-runner improvement — but the OPPOSITE geometry.
    // The short exit search (scripts/cgwide-short-search.ts) showed shorts get
    // catastrophically worse with a far TP (runner 2-3R ≈ −0.47R) because this
    // market mean-reverts UP against shorts; the WINNER is taking profit FAST
    // (wide stop, TP at 0.5R ≈ +0.055R, ~71% WR — grab the quick move before the
    // bounce). So this lane keeps the wide >=300bps stop but banks at 0.5R,
    // SHORT-only. Placed last so it never preempts a default lane on a score tie.
    id: "CG_WIDE_FAST_SHORT",
    label: "SHORT fast-TP: wide >=300bps stop, near 0.5R TP",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.5,
    shortOnly: true,
    description:
      "Fast-take-profit SHORT: wide >=300bps stop with a near 0.5R target. Shorts in this universe " +
      "mean-revert up, so a far TP (runner) loses badly (−0.47R) while banking quickly at 0.5R is " +
      "honestly positive (+0.055R, ~71% WR). SHORT-only; the wide-stop 1R short stays vetoed by the " +
      "lane edge gate.",
  },
];

export const BASELINE_VARIANT_ID: VariantMatrixVariantId = "CG_BASELINE_CURRENT";

// ---------------------------------------------------------------------------
// Source qualifying signal (geometry-bearing). The route builds these from
// qualifying current-guard ShadowPositions; tests build them synthetically.
// ---------------------------------------------------------------------------
export interface VariantMatrixSignal {
  sourceSignalId: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  stopDistanceBps: number | null;
  regime: string | null;
  entryVariant: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface CurrentGuardVariantMatrixObservation {
  observationId: string;
  variantId: VariantMatrixVariantId;
  variantVersion: typeof CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION;
  sourceSignalId: string;
  sourceObservationKey: string; // `${symbol}|${direction}|${openedAt}`
  symbol: string;
  direction: Direction;
  regime: string | null;
  entryVariant: string | null;
  createdAt: string;
  openedAt: string;
  resolvedAt: string | null;
  updatedAt?: string | null;

  // Original geometry from the source signal.
  originalEntryPrice: number;
  originalStopLoss: number;
  originalTakeProfitLevels: number[];

  // Simulated geometry for this variant.
  simulatedEntryPrice: number;
  simulatedStopLoss: number;
  simulatedTakeProfitLevels: number[];
  stopDistanceBps: number | null;

  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  costModel: VariantFillMode;

  costR: number | null;
  grossR: number | null;
  netR: number | null;
  status: VariantObservationStatus;

  maxMfeR: number | null;
  minMaeR: number | null;
  durationMinutes: number | null;
  resolutionSource: string | null;
  intrabarResolutionStatus: VariantIntrabarStatus;
  isFreshValid: boolean | null;

  reportOnly: true;
  laneVersion: typeof CURRENT_GUARD_VARIANT_MATRIX_LANE;
}

// ---------------------------------------------------------------------------
// Resolver metadata — persisted in the store JSON so the report builder can
// surface last-run diagnostics without re-running the resolver.
// ---------------------------------------------------------------------------
export interface VariantMatrixResolverMeta {
  lastRunAt: string;
  resolvedCount: number;
  expiredCount: number;
  dataFailureCount: number;
  errorCount: number;
}

// ---------------------------------------------------------------------------
// Store (mirrors the proven ParallelShadowExperimentStore pattern). Isolated
// JSON file; load/save swallow all errors so report-only never breaks the app.
// ---------------------------------------------------------------------------
interface VariantMatrixStoreState {
  observations: CurrentGuardVariantMatrixObservation[];
  resolverMeta?: VariantMatrixResolverMeta;
}

export class CurrentGuardVariantMatrixStore {
  private readonly file: string;
  private observations: CurrentGuardVariantMatrixObservation[];
  private resolverMetaInternal: VariantMatrixResolverMeta | null;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "current-guard-variant-matrix.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    const loaded = this._load();
    this.observations = loaded.observations;
    this.resolverMetaInternal = loaded.resolverMeta ?? null;
  }

  get path(): string {
    return this.file;
  }

  get all(): CurrentGuardVariantMatrixObservation[] {
    return this.observations;
  }

  getResolverMeta(): VariantMatrixResolverMeta | null {
    return this.resolverMetaInternal;
  }

  setResolverMeta(meta: VariantMatrixResolverMeta): void {
    this.resolverMetaInternal = meta;
    this.save();
  }

  private _load(): VariantMatrixStoreState {
    try {
      if (!existsSync(this.file)) return { observations: [] };
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (Array.isArray(parsed)) {
        return { observations: parsed as CurrentGuardVariantMatrixObservation[] };
      }
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { observations?: unknown }).observations)) {
        const state = parsed as VariantMatrixStoreState;
        return {
          observations: state.observations,
          resolverMeta: state.resolverMeta,
        };
      }
      return { observations: [] };
    } catch {
      return { observations: [] };
    }
  }

  save(): void {
    try {
      const state: VariantMatrixStoreState = { observations: this.observations };
      if (this.resolverMetaInternal) state.resolverMeta = this.resolverMetaInternal;
      writeFileSync(this.file, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // report-only storage failures must never affect the app
    }
  }

  add(observation: CurrentGuardVariantMatrixObservation): void {
    this.observations.push(observation);
    this.save();
  }

  addMany(observations: CurrentGuardVariantMatrixObservation[]): void {
    if (observations.length === 0) return;
    this.observations.push(...observations);
    this.save();
  }

  update(observationId: string, patch: Partial<CurrentGuardVariantMatrixObservation>): void {
    const idx = this.observations.findIndex((obs) => obs.observationId === observationId);
    if (idx < 0) return;
    this.observations[idx] = {
      ...this.observations[idx]!,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.save();
  }

  hasObservation(sourceObservationKey: string, variantId: VariantMatrixVariantId): boolean {
    return this.observations.some(
      (obs) => obs.sourceObservationKey === sourceObservationKey && obs.variantId === variantId,
    );
  }
}

let singleton: CurrentGuardVariantMatrixStore | null = null;

export function getCurrentGuardVariantMatrixStore(dataDir = "data"): CurrentGuardVariantMatrixStore {
  if (!singleton) singleton = new CurrentGuardVariantMatrixStore(dataDir);
  return singleton;
}

export function _resetCurrentGuardVariantMatrixStoreForTests(): void {
  singleton = null;
}

// ---------------------------------------------------------------------------
// Source population selection (matches the F****** post-cutover population).
// ---------------------------------------------------------------------------
function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function stopDistanceBpsOf(direction: Direction, entry: number, stop: number): number | null {
  if (!(entry > 0) || !(stop > 0)) return null;
  const dist = direction === "LONG" ? entry - stop : stop - entry;
  if (!(dist > 0)) return null;
  return (dist / entry) * 10000;
}

/**
 * Selects the qualifying current-guard signals to mirror. Same selection as the
 * post-cutover lane: current-guard generation (stop175 + anchor-consistent V2),
 * a closed+filled variant with finite realized R, and — when a cutover boundary
 * is supplied — only signals whose closedAt is strictly after the boundary.
 * Report-only; never throws.
 */
export function selectVariantMatrixSignals(
  positions: ShadowPosition[],
  cutoverTimestamp?: string | null,
): VariantMatrixSignal[] {
  const out: VariantMatrixSignal[] = [];
  const cutoverMs = cutoverTimestamp ? toMs(cutoverTimestamp) : null;
  try {
    for (const position of positions) {
      if (position.riskHygieneGuardMinStopDistanceBps !== MIN_ADMISSION_STOP_DISTANCE_BPS_EXPORT) continue;
      if (position.policyVersion !== BASE_ROUTE_POLICY_VERSION_V2) continue;
      const entry = position.entryPrice;
      const stop = position.stopLoss;
      const tp1 = position.tp1;
      if (!(typeof entry === "number" && entry > 0)) continue;
      if (!(typeof stop === "number" && stop > 0)) continue;
      if (!(typeof tp1 === "number" && tp1 > 0)) continue;
      const direction: Direction = position.direction === "SHORT" ? "SHORT" : "LONG";

      // Use the first closed+filled variant with finite realized R (mirrors the
      // post-cutover close-selection logic) to date the signal.
      let openedAt: string | null = null;
      let closedAt: string | null = null;
      for (const variant of position.variants ?? []) {
        if (variant.state !== "CLOSED" || variant.closeReason === "NO_FILL") continue;
        if (typeof variant.realizedGrossR !== "number" || typeof variant.realizedNetR !== "number") continue;
        openedAt = variant.openedAt ?? position.scannedAt ?? null;
        closedAt = variant.closedAt ?? variant.lastUpdatedAt ?? openedAt;
        break;
      }
      if (!openedAt) continue;

      const closedMs = toMs(closedAt);
      if (cutoverMs !== null) {
        if (closedMs === null || closedMs <= cutoverMs) continue; // strict post-cutover
      }

      out.push({
        sourceSignalId: position.id,
        symbol: position.symbol,
        direction,
        entryPrice: entry,
        stopLoss: stop,
        tp1,
        tp2: typeof position.tp2 === "number" ? position.tp2 : null,
        tp3: typeof position.tp3 === "number" ? position.tp3 : null,
        stopDistanceBps:
          typeof position.stopDistanceBps === "number"
            ? position.stopDistanceBps
            : stopDistanceBpsOf(direction, entry, stop),
        regime: position.marketRegime ?? position.marketRegimeAtOpen ?? null,
        entryVariant: position.selectedEntryVariant ?? null,
        openedAt,
        closedAt,
      });
    }
  } catch {
    // report-only; never break the caller
  }
  return out;
}

// ---------------------------------------------------------------------------
// Variant geometry derivation.
// ---------------------------------------------------------------------------
interface DerivedGeometry {
  kind: "ok";
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  stopDistanceBps: number;
  costR: number;
}
interface RejectedGeometry {
  kind: "rejected";
}
interface FailedGeometry {
  kind: "failed";
}
type GeometryResult = DerivedGeometry | RejectedGeometry | FailedGeometry;

function computeVariantCostR(roundTripBps: number, stopDistanceBps: number): number {
  // cost-in-R = (round-trip cost in bps) / (stop distance in bps).
  if (!(stopDistanceBps > 0)) return 0;
  return roundTripBps / stopDistanceBps;
}

export function deriveVariantGeometry(
  signal: VariantMatrixSignal,
  def: VariantMatrixVariantDefinition,
): GeometryResult {
  const dir = signal.direction;
  const E = signal.entryPrice;
  const S = signal.stopLoss;
  const T1 = signal.tp1;
  if (!(E > 0) || !(S > 0) || !(T1 > 0)) return { kind: "failed" };

  const baselineRisk = dir === "LONG" ? E - S : S - E;
  if (!(baselineRisk > 0)) return { kind: "failed" };
  const baselineStopBps = (baselineRisk / E) * 10000;

  const roundTripBps = def.costModel === "maker_limit" ? MAKER_ROUNDTRIP_BPS : TAKER_ROUNDTRIP_BPS;

  if (def.id === "CG_NO_FIB500_ENTRYSET" && signal.entryVariant === "fib_500_entry") {
    return { kind: "rejected" };
  }

  // Long-only research lanes never derive on SHORT signals.
  if (def.longOnly && dir !== "LONG") {
    return { kind: "rejected" };
  }
  // Short-only lanes never derive on LONG signals.
  if (def.shortOnly && dir !== "SHORT") {
    return { kind: "rejected" };
  }

  const usesWidePaperGeometry =
    def.id === "CG_WIDE_STOP_TP_WIDE" ||
    def.id === "CG_TRAIL_AFTER_TP1" ||
    def.stopFloorBps != null;
  if (usesWidePaperGeometry) {
    // Widen the stop to at least the floor, and place the paired TP at `tpRewardMultiple`× the
    // (floored) risk so exit behavior is compared on fair geometry. CG_WIDE/CG_TRAIL default to
    // the 300bps floor and a 1.0R target; LG_* lanes parameterize both knobs. Never widen the
    // stop without widening the paired target.
    const stopFloorBps = def.stopFloorBps ?? WIDE_STOP_MIN_BPS;
    const tpRewardMultiple = def.tpRewardMultiple ?? 1.0;
    const targetStopBps = Math.max(baselineStopBps, stopFloorBps);
    const widenedStop = dir === "LONG" ? E * (1 - targetStopBps / 10000) : E * (1 + targetStopBps / 10000);
    const widenedRisk = dir === "LONG" ? E - widenedStop : widenedStop - E;
    if (!(widenedRisk > 0)) return { kind: "failed" };
    const widenedTarget =
      dir === "LONG" ? E + tpRewardMultiple * widenedRisk : E - tpRewardMultiple * widenedRisk;
    if (!(widenedTarget > 0)) return { kind: "failed" };
    return {
      kind: "ok",
      entryPrice: E,
      stopLoss: widenedStop,
      takeProfitLevels: [widenedTarget],
      stopDistanceBps: targetStopBps,
      costR: computeVariantCostR(roundTripBps, targetStopBps),
    };
  }

  // Remaining variants keep the original entry/stop/tp1 geometry; only the
  // exit rule, fill mode and cost basis differ.
  return {
    kind: "ok",
    entryPrice: E,
    stopLoss: S,
    takeProfitLevels: [T1],
    stopDistanceBps: baselineStopBps,
    costR: computeVariantCostR(roundTripBps, baselineStopBps),
  };
}

let observationSeq = 0;
function makeObservationId(symbol: string, variantId: VariantMatrixVariantId): string {
  observationSeq += 1;
  return `${symbol}-${variantId}-${Date.now()}-${observationSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildVariantMatrixObservationsForSignal(
  signal: VariantMatrixSignal,
  nowIso = new Date().toISOString(),
): CurrentGuardVariantMatrixObservation[] {
  const key = `${signal.symbol}|${signal.direction}|${signal.openedAt}`;
  const originalTps = [signal.tp1, signal.tp2, signal.tp3].filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  const observations: CurrentGuardVariantMatrixObservation[] = [];
  for (const def of VARIANT_MATRIX_DEFINITIONS) {
    const geo = deriveVariantGeometry(signal, def);
    const base = {
      observationId: makeObservationId(signal.symbol, def.id),
      variantId: def.id,
      variantVersion: CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION,
      sourceSignalId: signal.sourceSignalId,
      sourceObservationKey: key,
      symbol: signal.symbol,
      direction: signal.direction,
      regime: signal.regime,
      entryVariant: signal.entryVariant,
      createdAt: nowIso,
      openedAt: signal.openedAt,
      resolvedAt: null,
      originalEntryPrice: signal.entryPrice,
      originalStopLoss: signal.stopLoss,
      originalTakeProfitLevels: originalTps,
      exitRule: def.exitRule,
      fillMode: def.fillMode,
      costModel: def.costModel,
      grossR: null,
      netR: null,
      maxMfeR: null,
      minMaeR: null,
      durationMinutes: null,
      resolutionSource: null,
      intrabarResolutionStatus: null,
      isFreshValid: null,
      reportOnly: true as const,
      laneVersion: CURRENT_GUARD_VARIANT_MATRIX_LANE,
    };

    if (geo.kind === "rejected") {
      observations.push({
        ...base,
        simulatedEntryPrice: signal.entryPrice,
        simulatedStopLoss: signal.stopLoss,
        simulatedTakeProfitLevels: [signal.tp1],
        stopDistanceBps: signal.stopDistanceBps,
        costR: null,
        status: "REJECTED",
        resolutionSource: "ENTRY_FILTER_FIB500_EXCLUDED",
      });
      continue;
    }
    if (geo.kind === "failed") {
      observations.push({
        ...base,
        simulatedEntryPrice: signal.entryPrice,
        simulatedStopLoss: signal.stopLoss,
        simulatedTakeProfitLevels: [signal.tp1],
        stopDistanceBps: signal.stopDistanceBps,
        costR: null,
        status: "DATA_FAILURE",
        resolutionSource: "GEOMETRY_DERIVATION_FAILED",
      });
      continue;
    }

    observations.push({
      ...base,
      simulatedEntryPrice: geo.entryPrice,
      simulatedStopLoss: geo.stopLoss,
      simulatedTakeProfitLevels: geo.takeProfitLevels,
      stopDistanceBps: geo.stopDistanceBps,
      costR: geo.costR,
      status: "OPEN",
    });
  }
  return observations;
}

export function mirrorVariantMatrixSignals(
  signals: VariantMatrixSignal[],
  store: CurrentGuardVariantMatrixStore,
  nowIso = new Date().toISOString(),
): { mirrored: number; duplicates: number } {
  let mirrored = 0;
  let duplicates = 0;
  const toAdd: CurrentGuardVariantMatrixObservation[] = [];
  for (const signal of signals) {
    const candidates = buildVariantMatrixObservationsForSignal(signal, nowIso);
    for (const obs of candidates) {
      if (store.hasObservation(obs.sourceObservationKey, obs.variantId)) {
        duplicates += 1;
        continue;
      }
      // also guard against duplicates within this same batch
      if (toAdd.some((o) => o.sourceObservationKey === obs.sourceObservationKey && o.variantId === obs.variantId)) {
        duplicates += 1;
        continue;
      }
      toAdd.push(obs);
      mirrored += 1;
    }
  }
  store.addMany(toAdd);
  return { mirrored, duplicates };
}

// ---------------------------------------------------------------------------
// Candle-walk resolution engine.
// ---------------------------------------------------------------------------
export type KlineTuple = [number, string, string, string, string, string, number, ...unknown[]];

export interface VariantMatrixBinanceClient {
  getKlines: (
    symbol: string,
    interval: string,
    opts: { startTime: number; endTime: number; limit: number },
  ) => Promise<KlineTuple[]>;
}

export interface VariantWalkInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  target: number;
  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  openedAtMs: number;
  candles: KlineTuple[];
  makerFillWindowCandles?: number;
}

export interface VariantWalkResult {
  status: "CLOSED_WIN" | "CLOSED_LOSS" | "NO_FILL" | "UNRESOLVED";
  grossR: number | null;
  openedAtMs: number | null;
  closedAtMs: number | null;
  maxMfeR: number | null;
  minMaeR: number | null;
  intrabarResolutionStatus: VariantIntrabarStatus;
  isFreshValid: boolean | null;
  resolutionSource: string | null;
}

function rewardR(dir: Direction, entry: number, target: number, risk: number): number {
  if (!(risk > 0)) return 0;
  return dir === "LONG" ? (target - entry) / risk : (entry - target) / risk;
}

/**
 * Walks the 5m candle path for a single variant geometry. Pure aside from the
 * optional async 1m-refinement callback. Conservative: same-candle SL+TP is
 * refined via `resolve1m` when available, else resolves SL-first (a loss).
 * Never assumes an un-touched higher target was reached.
 */
export async function walkVariantPath(
  input: VariantWalkInput,
  resolve1m?: (fillCandleOpenMs: number) => Promise<"SL" | "TP" | null>,
): Promise<VariantWalkResult> {
  const { direction: dir, entryPrice: E, stopLoss: S, target: T, exitRule, fillMode } = input;
  const risk = dir === "LONG" ? E - S : S - E;
  const empty: VariantWalkResult = {
    status: "UNRESOLVED",
    grossR: null,
    openedAtMs: null,
    closedAtMs: null,
    maxMfeR: null,
    minMaeR: null,
    intrabarResolutionStatus: null,
    isFreshValid: null,
    resolutionSource: null,
  };
  if (!(risk > 0) || input.candles.length === 0) return empty;

  const candles = input.candles;
  const candleOpen = (c: KlineTuple) => Number(c[0]);
  const candleHigh = (c: KlineTuple) => Number(c[2]);
  const candleLow = (c: KlineTuple) => Number(c[3]);
  const candleClose = (c: KlineTuple) => Number(c[4]);
  const candleCloseTime = (c: KlineTuple) => {
    const raw = Number(c[6]);
    return Number.isFinite(raw) ? raw : candleOpen(c) + CANDLE_MS;
  };

  // Locate the signal candle (the one containing openedAtMs).
  let signalIdx = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const open = candleOpen(candles[i]!);
    if (open <= input.openedAtMs && input.openedAtMs < open + CANDLE_MS) {
      signalIdx = i;
      break;
    }
    if (open > input.openedAtMs) {
      signalIdx = i;
      break;
    }
  }

  // Determine fill index.
  let fillIdx = -1;
  if (fillMode === "taker") {
    fillIdx = signalIdx; // taker fills at the signal candle
  } else {
    // maker_limit: a resting post-only limit at E fills only on a pullback to E
    // on a candle STRICTLY AFTER the signal candle (we waited rather than crossed
    // the spread). If price never revisits E within the window -> NO_FILL.
    const window = input.makerFillWindowCandles ?? MAKER_FILL_WINDOW_CANDLES;
    const start = signalIdx + 1;
    const end = Math.min(candles.length, start + window);
    for (let i = start; i < end; i += 1) {
      const filled = dir === "LONG" ? candleLow(candles[i]!) <= E : candleHigh(candles[i]!) >= E;
      if (filled) {
        fillIdx = i;
        break;
      }
    }
    if (fillIdx < 0) {
      return { ...empty, status: "NO_FILL", resolutionSource: "MAKER_NO_FILL" };
    }
  }
  if (fillIdx < 0 || fillIdx >= candles.length) return empty;

  const openedAtMs = Math.max(input.openedAtMs, candleOpen(candles[fillIdx]!));
  let maxMfeR = 0;
  let minMaeR = 0;
  let pathValid = true;

  const updatePath = (high: number, low: number) => {
    if (!pathValid) return;
    const favorable = dir === "LONG" ? Math.max(high - E, 0) : Math.max(E - low, 0);
    const adverse = dir === "LONG" ? Math.min(low - E, 0) : Math.min(E - high, 0);
    const mfeR = favorable / risk;
    const maeR = adverse / risk;
    if (!Number.isFinite(mfeR) || !Number.isFinite(maeR) || Math.abs(mfeR) > MFE_MAE_CAP_R || Math.abs(maeR) > MFE_MAE_CAP_R) {
      pathValid = false;
      return;
    }
    if (mfeR > maxMfeR) maxMfeR = mfeR;
    if (maeR < minMaeR) minMaeR = maeR;
  };

  const finalize = (
    status: "CLOSED_WIN" | "CLOSED_LOSS",
    grossR: number,
    closedAtMs: number,
    resolutionSource: string,
    intrabar: VariantIntrabarStatus,
    isFreshValid: boolean,
  ): VariantWalkResult => ({
    status,
    grossR,
    openedAtMs,
    closedAtMs,
    maxMfeR: pathValid ? maxMfeR : null,
    minMaeR: pathValid ? minMaeR : null,
    intrabarResolutionStatus: intrabar,
    isFreshValid,
    resolutionSource,
  });

  const fullRewardR = rewardR(dir, E, T, risk);

  // Shared trail state (trail_after_tp1 / scaleout_tp1_trail).
  let tp1Touched = false;

  for (let i = fillIdx; i < candles.length; i += 1) {
    const candle = candles[i]!;
    const high = candleHigh(candle);
    const low = candleLow(candle);
    const cClose = candleClose(candle);
    const cCloseTime = candleCloseTime(candle);
    const cOpen = candleOpen(candle);
    updatePath(high, low);

    const slHitAtStop = (stop: number) => (dir === "LONG" ? low <= stop : high >= stop);
    const tpHit = dir === "LONG" ? high >= T : low <= T;
    const backToEntry = dir === "LONG" ? low <= E : high >= E;

    if (exitRule === "tp1_full") {
      const slHit = slHitAtStop(S);
      if (slHit && tpHit) {
        const decided = resolve1m ? await resolve1m(cOpen) : null;
        if (decided === "TP") {
          return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "INTRABAR_1M_TP", "RESOLVED_BY_1M", true);
        }
        if (decided === "SL") {
          return finalize("CLOSED_LOSS", -1, cCloseTime, "INTRABAR_1M_SL", "RESOLVED_BY_1M", true);
        }
        // conservative SL-first
        return finalize("CLOSED_LOSS", -1, cCloseTime, "AMBIGUOUS_SL_FIRST", "AMBIGUOUS_SAME_CANDLE_SL_FIRST", true);
      }
      if (slHit) return finalize("CLOSED_LOSS", -1, cCloseTime, "CANDLE_WALK_SL", "VALID_5M_ORDERED", true);
      if (tpHit) return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "CANDLE_WALK_TP", "VALID_5M_ORDERED", true);
      continue;
    }

    // trail_after_tp1 and scaleout_tp1_trail share pre-touch + runner logic.
    if (!tp1Touched) {
      const slHit = slHitAtStop(S);
      if (slHit && tpHit) {
        const decided = resolve1m ? await resolve1m(cOpen) : null;
        if (decided === "SL" || decided === null) {
          return finalize("CLOSED_LOSS", -1, cCloseTime, "AMBIGUOUS_SL_FIRST", decided === "SL" ? "RESOLVED_BY_1M" : "AMBIGUOUS_SAME_CANDLE_SL_FIRST", true);
        }
        // decided === "TP": TP1 reached first this candle.
        tp1Touched = true;
        if (backToEntry) {
          const runnerR = 0;
          const grossR = exitRule === "scaleout_tp1_trail" ? 0.5 * fullRewardR + 0.5 * runnerR : runnerR;
          const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
          return finalize(status, grossR, cCloseTime, "TRAIL_BREAKEVEN_SAME_CANDLE", "RESOLVED_BY_1M", true);
        }
        continue;
      }
      if (slHit) return finalize("CLOSED_LOSS", -1, cCloseTime, "CANDLE_WALK_SL", "VALID_5M_ORDERED", true);
      if (tpHit) {
        tp1Touched = true;
        if (backToEntry) {
          // touched TP1 then returned to entry within the same candle
          const runnerR = 0;
          const grossR = exitRule === "scaleout_tp1_trail" ? 0.5 * fullRewardR + 0.5 * runnerR : runnerR;
          const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
          return finalize(status, grossR, cCloseTime, "TRAIL_BREAKEVEN_SAME_CANDLE", "VALID_5M_ORDERED", true);
        }
        continue;
      }
      continue;
    }

    // tp1Touched: trailing stop is at breakeven (E).
    if (backToEntry) {
      const runnerR = 0;
      const grossR = exitRule === "scaleout_tp1_trail" ? 0.5 * fullRewardR + 0.5 * runnerR : runnerR;
      const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
      return finalize(status, grossR, cCloseTime, "TRAIL_BREAKEVEN_EXIT", "VALID_5M_ORDERED", true);
    }
    // otherwise keep riding
  }

  // Path ended.
  if ((exitRule === "trail_after_tp1" || exitRule === "scaleout_tp1_trail") && tp1Touched) {
    const lastCandle = candles[candles.length - 1]!;
    const lastClose = candleClose(lastCandle);
    const runnerR = dir === "LONG" ? (lastClose - E) / risk : (E - lastClose) / risk;
    const grossR = exitRule === "scaleout_tp1_trail" ? 0.5 * fullRewardR + 0.5 * runnerR : runnerR;
    const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
    return finalize(status, grossR, candleCloseTime(lastCandle), "TRAIL_PATH_END", "VALID_5M_ORDERED", true);
  }

  return empty;
}

export async function resolveVariantMatrixObservations(
  store: CurrentGuardVariantMatrixStore,
  binanceClient: VariantMatrixBinanceClient,
): Promise<{ resolved: number; expired: number; dataFailures: number; errors: number }> {
  let resolved = 0;
  let expired = 0;
  let dataFailures = 0;
  let errors = 0;
  const nowMs = Date.now();
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const candleCache = new Map<string, KlineTuple[]>();

  try {
    for (const obs of store.all) {
      if (obs.status !== "OPEN") continue;

      // Compute age outside the try block so it is always available.
      const openedAtMs = toMs(obs.openedAt) ?? toMs(obs.createdAt) ?? nowMs;

      // ── Part 1: Expiry gate — checked BEFORE candle fetch. ───────────────
      // This guarantees stale observations are marked EXPIRED even when the
      // candle fetch or candle walk would throw (e.g. network error, missing
      // historical data). The expiry check never requires I/O.
      if (nowMs - openedAtMs > EXPIRY_MS) {
        try {
          store.update(obs.observationId, {
            status: "EXPIRED",
            resolvedAt: new Date(nowMs).toISOString(),
            resolutionSource: "EXPIRED_UNRESOLVED",
            intrabarResolutionStatus: "INTRABAR_UNAVAILABLE",
            isFreshValid: null,
          });
          expired += 1;
          resolved += 1;
        } catch {
          errors += 1;
        }
        continue; // skip candle fetch entirely
      }

      // ── Candle fetch + path walk (only for non-expired observations) ─────
      try {
        const closedAtMs = toMs(obs.resolvedAt) ?? null;
        const endBound = Math.min((closedAtMs ?? nowMs) + twoHoursMs, nowMs + twoHoursMs);
        const startTime = openedAtMs - CANDLE_MS;
        const endTime = endBound;
        const cacheKey = `${obs.symbol}|${startTime}|${endTime}`;
        let candles = candleCache.get(cacheKey);
        if (!candles) {
          candles = await binanceClient.getKlines(obs.symbol, "5m", {
            startTime,
            endTime,
            limit: Math.min(Math.max(Math.ceil((endTime - startTime) / CANDLE_MS) + 2, 12), 1000),
          });
          candleCache.set(cacheKey, candles);
        }

        const resolve1m = async (fillCandleOpenMs: number): Promise<"SL" | "TP" | null> => {
          try {
            const raw1m = await binanceClient.getKlines(obs.symbol, "1m", {
              startTime: fillCandleOpenMs,
              endTime: fillCandleOpenMs + CANDLE_MS,
              limit: 6,
            });
            const E = obs.simulatedEntryPrice;
            const S = obs.simulatedStopLoss;
            const T = obs.simulatedTakeProfitLevels[0] ?? null;
            for (const c of raw1m) {
              const high = Number(c[2]);
              const low = Number(c[3]);
              const slHit = obs.direction === "LONG" ? low <= S : high >= S;
              const tpHit = T !== null && (obs.direction === "LONG" ? high >= T : low <= T);
              if (slHit) return "SL";
              if (tpHit) return "TP";
            }
            return null;
          } catch {
            return null;
          }
        };

        const walk = await walkVariantPath(
          {
            direction: obs.direction,
            entryPrice: obs.simulatedEntryPrice,
            stopLoss: obs.simulatedStopLoss,
            target: obs.simulatedTakeProfitLevels[0] ?? obs.simulatedEntryPrice,
            exitRule: obs.exitRule,
            fillMode: obs.fillMode,
            openedAtMs,
            candles,
          },
          resolve1m,
        );

        if (walk.status === "CLOSED_WIN" || walk.status === "CLOSED_LOSS") {
          const grossR = walk.grossR ?? 0;
          const resolvedAtMs = walk.closedAtMs ?? nowMs;
          const effectiveOpenedAtMs = walk.openedAtMs ?? openedAtMs;
          store.update(obs.observationId, {
            status: walk.status,
            grossR,
            netR: grossR - (obs.costR ?? 0),
            resolvedAt: new Date(resolvedAtMs).toISOString(),
            durationMinutes: Math.max(0, Math.round((resolvedAtMs - effectiveOpenedAtMs) / 60000)),
            maxMfeR: walk.maxMfeR,
            minMaeR: walk.minMaeR,
            resolutionSource: walk.resolutionSource,
            intrabarResolutionStatus: walk.intrabarResolutionStatus,
            isFreshValid: walk.isFreshValid ?? true,
          });
          resolved += 1;
        } else if (walk.status === "NO_FILL") {
          store.update(obs.observationId, {
            status: "NO_FILL",
            resolvedAt: new Date(nowMs).toISOString(),
            resolutionSource: walk.resolutionSource ?? "MAKER_NO_FILL",
            isFreshValid: null,
          });
          resolved += 1;
        }
        // else: UNRESOLVED — leave OPEN for a future pass (within EXPIRY_MS)
      } catch {
        // ── Part 2: Harden data-failure path ─────────────────────────────
        // The expiry check already fired for any observation that is old enough,
        // so this catch block only handles observations that are genuinely within
        // the expiry window but whose candle fetch / candle walk threw.
        // Increment the diagnostic counter; leave the observation OPEN so the
        // resolver retries it on the next pass rather than permanently discarding it.
        errors += 1;
        dataFailures += 1;
      }
    }
  } catch {
    // outer report-only guard — never propagates
  }

  // ── Persist resolver metadata so the report builder can surface diagnostics ──
  try {
    store.setResolverMeta({
      lastRunAt: new Date(nowMs).toISOString(),
      resolvedCount: resolved,
      expiredCount: expired,
      dataFailureCount: dataFailures,
      errorCount: errors,
    });
  } catch {
    // meta-save failure must never break the resolver
  }

  return { resolved, expired, dataFailures, errors };
}

// ---------------------------------------------------------------------------
// Report builder.
// ---------------------------------------------------------------------------
function mean(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return finite.length > 0 ? finite.reduce((s, v) => s + v, 0) / finite.length : null;
}

function profitFactor(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const pos = finite.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const neg = finite.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  return pos > 0 && neg < 0 ? pos / Math.abs(neg) : null;
}

function drawdownAndStreak(orderedNetR: number[]): { drawdownR: number | null; streak: number | null } {
  if (orderedNetR.length === 0) return { drawdownR: null, streak: null };
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let curStreak = 0;
  let maxStreak = 0;
  for (const r of orderedNetR) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    if (r < 0) {
      curStreak += 1;
      if (curStreak > maxStreak) maxStreak = curStreak;
    } else {
      curStreak = 0;
    }
  }
  return { drawdownR: maxDd, streak: maxStreak };
}

export interface VariantRollingStat {
  window: string;
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
}

export interface VariantSegmentStat {
  label: string;
  n: number;
  netAvgR: number | null;
}

export interface VariantBreakdownRow {
  key: string;
  n: number;
  netAvgR: number | null;
}

export interface CurrentGuardVariantMatrixRow {
  variantId: VariantMatrixVariantId;
  label: string;
  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  costModel: VariantFillMode;

  total: number;
  open: number;
  resolved: number;
  freshValid: number;
  rejected: number;
  noFill: number;
  expired: number;
  dataFailure: number;

  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;

  // Payoff anatomy (computed on netR; breakEvenWR uses the CORRECT 1/(1+payoff)).
  avgWinR: number | null;
  avgLossR: number | null;
  payoffRatio: number | null;
  breakEvenWR: number | null;
  actualWR: number | null;

  avgCostR: number | null;
  costDragR: number | null;
  noFillRate: number | null;
  expiredRate: number | null;
  avgHoldingMinutes: number | null;
  approxMaxDrawdownR: number | null;
  maxAdverseStreak: number | null;
  topSymbolPnlShare: number | null;

  plus10bpsNetAvgR: number | null;
  plus10bpsStillPositive: boolean;

  calendarDays: number | null;
  distinctRegimes: number;
  byRegime: VariantBreakdownRow[];
  byEntryVariant: VariantBreakdownRow[];

  oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null;
  allThreeOosPositive: boolean;
  rolling: VariantRollingStat[];

  status: VariantMatrixStatus;
  statusReason: string;
  blockers: string[];
  cautions: string[];
}

export interface CurrentGuardVariantMatrixReportOptions {
  capturedAt?: string;
  cutoverTimestamp?: string | null;
  killSwitchReady?: boolean;
  orderReconciliationReady?: boolean;
  exchangeHealthReady?: boolean;
}

export interface VariantMatrixResolverDiagnostics {
  /** ISO timestamp of the last resolver run, or null if the resolver has never run. */
  lastRunAt: string | null;
  /** Number of observations resolved (CLOSED_WIN/CLOSED_LOSS/NO_FILL/EXPIRED) on the last run. */
  resolvedThisRun: number | null;
  /** Number of observations that were newly marked EXPIRED on the last run. */
  expiredThisRun: number | null;
  /** Number of observations where candle fetch / candle walk threw on the last run. */
  dataFailuresThisRun: number | null;
  /** Current count of OPEN observations older than STALE_OPEN_WARN_MS (72 h). */
  staleOpenCount: number;
  /** Age in hours of the oldest OPEN observation in the store, or null when none open. */
  oldestOpenAgeHours: number | null;
  /** Advisory action hint when stale observations are present. */
  nextAction: string | null;
}

/**
 * REPORT-ONLY synthetic "regime-adaptive" lane. Per signal, it takes the CG_WIDE full-exit outcome
 * in a confirmed strong-trend regime and the CG_SCALEOUT outcome otherwise, by PAIRING the existing
 * resolved obs of both variants on the SAME signal (sourceObservationKey). It never admits, resolves
 * or mutates anything — it is a derived measurement that answers "would switching exit by regime beat
 * plain scaleout?". `beatsScaleout` is the bar it must clear to justify a real lane.
 */
export interface RegimeAdaptiveSyntheticReport {
  reportOnly: true;
  note: string;
  /** Signals with a fresh-valid resolved obs in BOTH CG_WIDE and CG_SCALEOUT (the paired population). */
  pairedSignals: number;
  /** Of the paired signals, how many took the full-exit branch (strong trend) vs the scaleout branch (chop). */
  pickedFullExit: number;
  pickedScaleout: number;
  freshValid: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
  oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null;
  allThreeOosPositive: boolean;
  // Apples-to-apples on the SAME paired population:
  scaleoutNetAvgR: number | null;
  fullExitNetAvgR: number | null;
  /** True only when the adaptive netAvgR strictly beats plain scaleout — the promotion bar. */
  beatsScaleout: boolean;
}

export interface CurrentGuardVariantMatrixReport {
  reportOnly: true;
  laneVersion: typeof CURRENT_GUARD_VARIANT_MATRIX_LANE;
  policyVersion: typeof CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION;
  computedAt: string;
  cutoverTimestamp: string | null;
  sourcePopulationNote: string;
  totalObservations: number;
  variantCount: number;
  baselineVariantId: VariantMatrixVariantId;
  rows: CurrentGuardVariantMatrixRow[];
  bestVariantId: VariantMatrixVariantId | null;
  bestVariantNetAvgR: number | null;
  bestBeatsBaseline: boolean;
  /** Resolver run diagnostics — populated from persisted meta + live store state. */
  resolverDiagnostics: VariantMatrixResolverDiagnostics;
  /** Report-only synthetic regime-adaptive lane (full-exit in strong trend, scaleout in chop). */
  regimeAdaptiveSynthetic: RegimeAdaptiveSyntheticReport;
  killSwitchReady: boolean;
  orderReconciliationReady: boolean;
  exchangeHealthReady: boolean;
  /** Always true. The variant matrix never authorizes live trading. */
  liveBlocked: true;
  /** Always false. The variant matrix never enables a micro pilot. */
  microPilotAllowed: false;
  notes: string[];
}

function isFreshValidObs(obs: CurrentGuardVariantMatrixObservation): boolean {
  return (
    (obs.status === "CLOSED_WIN" || obs.status === "CLOSED_LOSS") &&
    obs.isFreshValid !== false &&
    typeof obs.grossR === "number" &&
    Number.isFinite(obs.grossR) &&
    typeof obs.netR === "number" &&
    Number.isFinite(obs.netR)
  );
}

function orderByResolved(a: CurrentGuardVariantMatrixObservation, b: CurrentGuardVariantMatrixObservation): number {
  const am = toMs(a.resolvedAt) ?? toMs(a.openedAt) ?? 0;
  const bm = toMs(b.resolvedAt) ?? toMs(b.openedAt) ?? 0;
  return am - bm;
}

function rollingStat(label: string, ordered: CurrentGuardVariantMatrixObservation[], size: number): VariantRollingStat {
  const slice = ordered.slice(Math.max(0, ordered.length - size));
  const wins = slice.filter((o) => (o.netR ?? 0) > 0).length;
  return {
    window: label,
    n: slice.length,
    netAvgR: mean(slice.map((o) => o.netR)),
    pf: profitFactor(slice.map((o) => o.netR)),
    wr: slice.length > 0 ? wins / slice.length : null,
  };
}

function segmentStat(label: string, slice: CurrentGuardVariantMatrixObservation[]): VariantSegmentStat {
  return { label, n: slice.length, netAvgR: mean(slice.map((o) => o.netR)) };
}

function breakdownRows(
  slice: CurrentGuardVariantMatrixObservation[],
  keyFn: (o: CurrentGuardVariantMatrixObservation) => string,
): VariantBreakdownRow[] {
  const groups = new Map<string, CurrentGuardVariantMatrixObservation[]>();
  for (const o of slice) {
    const k = keyFn(o);
    const arr = groups.get(k) ?? [];
    arr.push(o);
    groups.set(k, arr);
  }
  return Array.from(groups.entries())
    .map(([key, arr]) => ({ key, n: arr.length, netAvgR: mean(arr.map((o) => o.netR)) }))
    .sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0));
}

function topSymbolPnlShare(slice: CurrentGuardVariantMatrixObservation[]): number | null {
  if (slice.length === 0) return null;
  const totalAbs = slice.reduce((s, o) => s + Math.abs(o.netR ?? 0), 0);
  if (!(totalAbs > 0)) return null;
  const bySymbol = new Map<string, number>();
  for (const o of slice) bySymbol.set(o.symbol, (bySymbol.get(o.symbol) ?? 0) + Math.abs(o.netR ?? 0));
  return Math.max(...bySymbol.values()) / totalAbs;
}

function calendarDays(slice: CurrentGuardVariantMatrixObservation[]): number | null {
  const times = slice.map((o) => toMs(o.resolvedAt) ?? toMs(o.openedAt)).filter((v): v is number => v !== null);
  if (times.length === 0) return null;
  return Math.round(((Math.max(...times) - Math.min(...times)) / (24 * 60 * 60 * 1000)) * 100) / 100;
}

function roundTripBpsForCostModel(costModel: VariantFillMode): number {
  return costModel === "maker_limit" ? MAKER_ROUNDTRIP_BPS : TAKER_ROUNDTRIP_BPS;
}

function deriveVariantStatus(
  row: Omit<CurrentGuardVariantMatrixRow, "status" | "statusReason" | "blockers" | "cautions">,
  infra: { killSwitchReady: boolean; orderReconciliationReady: boolean; exchangeHealthReady: boolean },
): { status: VariantMatrixStatus; statusReason: string; blockers: string[]; cautions: string[] } {
  const blockers: string[] = [];
  const cautions: string[] = [];

  const net = row.netAvgR;
  const pf = row.pf;
  const payoff = row.payoffRatio;
  const dd = row.approxMaxDrawdownR;
  const share = row.topSymbolPnlShare;

  // REJECT first: enough sample and clearly value-destructive.
  if (row.freshValid >= WATCHABLE_MIN_FRESH && ((net !== null && net < 0) || (pf !== null && pf < PF_FLOOR))) {
    return {
      status: "REJECT",
      statusReason: `freshValid=${row.freshValid} with net=${net?.toFixed(3) ?? "n/a"}R PF=${pf?.toFixed(2) ?? "n/a"} — value-destructive`,
      blockers: ["negative fresh-valid economics at adequate sample"],
      cautions,
    };
  }

  const drawdownOk = dd === null || dd <= MAX_DRAWDOWN_R_LIMIT;
  const shareOk = share === null || share <= MAX_TOP_SYMBOL_SHARE;
  const infraReady = infra.killSwitchReady && infra.orderReconciliationReady && infra.exchangeHealthReady;

  // PROMOTION_CANDIDATE (still report-only; infra gates are always false today).
  if (
    row.freshValid >= PROMOTION_MIN_FRESH &&
    row.allThreeOosPositive &&
    net !== null && net > NET_STRONG_R &&
    pf !== null && pf > PF_STRONG &&
    payoff !== null && payoff >= PAYOFF_STABLE &&
    drawdownOk && shareOk &&
    (row.calendarDays ?? 0) >= PROMOTION_MIN_CALENDAR_DAYS &&
    row.distinctRegimes >= PROMOTION_MIN_DISTINCT_REGIMES &&
    infraReady
  ) {
    return {
      status: "PROMOTION_CANDIDATE",
      statusReason: "All anti-overfit + multi-day/regime + infra gates pass. Remains report-only until explicit manual approval.",
      blockers,
      cautions: ["report-only: promotion requires explicit manual approval; liveBlocked stays true"],
    };
  }

  // STABLE_CANDIDATE.
  if (
    row.freshValid >= STABLE_MIN_FRESH &&
    row.allThreeOosPositive &&
    net !== null && net > NET_STRONG_R &&
    pf !== null && pf > PF_STRONG &&
    payoff !== null && payoff >= PAYOFF_STABLE &&
    drawdownOk && shareOk
  ) {
    if (row.freshValid < PROMOTION_MIN_FRESH) blockers.push(`freshValid ${row.freshValid} < ${PROMOTION_MIN_FRESH} for promotion`);
    if ((row.calendarDays ?? 0) < PROMOTION_MIN_CALENDAR_DAYS) blockers.push("needs more calendar-day coverage");
    if (row.distinctRegimes < PROMOTION_MIN_DISTINCT_REGIMES) blockers.push("needs multiple market regimes");
    if (!infraReady) blockers.push("live infra gates not ready (kill-switch/order-recon/exchange-health)");
    return {
      status: "STABLE_CANDIDATE",
      statusReason: `freshValid=${row.freshValid}, all OOS thirds positive, payoff=${payoff.toFixed(2)} — stable but not yet promotable`,
      blockers,
      cautions,
    };
  }

  // WATCHABLE.
  const plus10ok = row.plus10bpsStillPositive;
  if (
    row.freshValid >= WATCHABLE_MIN_FRESH &&
    net !== null && net > 0 &&
    pf !== null && pf > PF_STRONG &&
    payoff !== null && payoff >= PAYOFF_WATCH &&
    plus10ok && shareOk
  ) {
    if (row.freshValid < STABLE_MIN_FRESH) blockers.push(`freshValid ${row.freshValid} < ${STABLE_MIN_FRESH} for stable`);
    if (!row.allThreeOosPositive) blockers.push("not all OOS thirds positive");
    if (payoff < PAYOFF_STABLE) blockers.push(`payoff ${payoff.toFixed(2)} < ${PAYOFF_STABLE}`);
    return {
      status: "WATCHABLE",
      statusReason: `freshValid=${row.freshValid}, net=${net.toFixed(3)}R PF=${pf.toFixed(2)} payoff=${payoff.toFixed(2)} — watchable`,
      blockers,
      cautions,
    };
  }

  // COLLECTING (default): list what is missing for WATCHABLE.
  if (row.freshValid < WATCHABLE_MIN_FRESH) blockers.push(`freshValid ${row.freshValid} < ${WATCHABLE_MIN_FRESH}`);
  if (net === null || net <= 0) blockers.push("netAvgR not positive");
  if (pf === null || pf <= PF_STRONG) blockers.push(`PF <= ${PF_STRONG}`);
  if (payoff === null || payoff < PAYOFF_WATCH) blockers.push(`payoffRatio < ${PAYOFF_WATCH}`);
  if (!plus10ok) blockers.push("+10bps stress not positive");
  if (!shareOk) blockers.push("top-symbol PnL share > 40%");
  return {
    status: "COLLECTING",
    statusReason: `freshValid=${row.freshValid} — collecting evidence`,
    blockers,
    cautions,
  };
}

function buildRow(
  def: VariantMatrixVariantDefinition,
  obsForVariant: CurrentGuardVariantMatrixObservation[],
  infra: { killSwitchReady: boolean; orderReconciliationReady: boolean; exchangeHealthReady: boolean },
): CurrentGuardVariantMatrixRow {
  const total = obsForVariant.length;
  const open = obsForVariant.filter((o) => o.status === "OPEN").length;
  const rejected = obsForVariant.filter((o) => o.status === "REJECTED").length;
  const noFill = obsForVariant.filter((o) => o.status === "NO_FILL").length;
  const expired = obsForVariant.filter((o) => o.status === "EXPIRED").length;
  const dataFailure = obsForVariant.filter((o) => o.status === "DATA_FAILURE").length;
  const resolvedObs = obsForVariant.filter((o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS");
  const fresh = resolvedObs.filter(isFreshValidObs).sort(orderByResolved);

  const netVals = fresh.map((o) => o.netR);
  const grossVals = fresh.map((o) => o.grossR);
  const netAvgR = mean(netVals);
  const grossAvgR = mean(grossVals);
  const pf = profitFactor(netVals);

  const netWinners = fresh.filter((o) => (o.netR ?? 0) > 0);
  const netLosers = fresh.filter((o) => (o.netR ?? 0) <= 0);
  const avgWinR = mean(netWinners.map((o) => o.netR));
  const avgLossR = mean(netLosers.map((o) => o.netR));
  const payoffRatio = avgWinR !== null && avgLossR !== null && avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : null;
  const breakEvenWR = payoffRatio !== null ? 1 / (1 + payoffRatio) : null;
  const actualWR = fresh.length > 0 ? netWinners.length / fresh.length : null;
  const wr = actualWR;

  const avgCostR = mean(fresh.map((o) => o.costR));
  const costDragR = grossAvgR !== null && netAvgR !== null ? grossAvgR - netAvgR : null;

  const attemptDenom = total - rejected; // attempts that could fill/resolve
  const noFillRate = attemptDenom > 0 ? noFill / attemptDenom : null;
  const expiredRate = attemptDenom > 0 ? expired / attemptDenom : null;
  const avgHoldingMinutes = mean(fresh.map((o) => o.durationMinutes));

  const { drawdownR, streak } = drawdownAndStreak(fresh.map((o) => o.netR ?? 0));
  const symbolShare = topSymbolPnlShare(fresh);

  const stressRoundTrip = roundTripBpsForCostModel(def.costModel) + STRESS_EXTRA_BPS;
  const plus10Vals = fresh.map((o) => {
    if (typeof o.grossR !== "number" || o.stopDistanceBps === null || !(o.stopDistanceBps > 0)) return null;
    return o.grossR - stressRoundTrip / o.stopDistanceBps;
  });
  const plus10bpsNetAvgR = mean(plus10Vals);
  const plus10bpsStillPositive = plus10bpsNetAvgR !== null && plus10bpsNetAvgR > 0;

  const regimes = new Set(fresh.map((o) => o.regime ?? "UNKNOWN"));
  const distinctRegimes = regimes.size;
  const byRegime = breakdownRows(fresh, (o) => o.regime ?? "UNKNOWN");
  const byEntryVariant = breakdownRows(fresh, (o) => o.entryVariant ?? "unknown");

  let oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null = null;
  let allThreeOosPositive = false;
  if (fresh.length >= 3) {
    const third = Math.floor(fresh.length / 3);
    const s1 = segmentStat("oos_1", fresh.slice(0, third));
    const s2 = segmentStat("oos_2", fresh.slice(third, 2 * third));
    const s3 = segmentStat("oos_3", fresh.slice(2 * third));
    oosThirds = [s1, s2, s3];
    allThreeOosPositive = [s1, s2, s3].every((s) => s.netAvgR !== null && s.netAvgR > 0);
  }

  const rolling = [
    rollingStat("last_10", fresh, 10),
    rollingStat("last_20", fresh, 20),
    rollingStat("last_50", fresh, 50),
  ];

  const partial = {
    variantId: def.id,
    label: def.label,
    exitRule: def.exitRule,
    fillMode: def.fillMode,
    costModel: def.costModel,
    total,
    open,
    resolved: resolvedObs.length,
    freshValid: fresh.length,
    rejected,
    noFill,
    expired,
    dataFailure,
    netAvgR,
    grossAvgR,
    pf,
    wr,
    avgWinR,
    avgLossR,
    payoffRatio,
    breakEvenWR,
    actualWR,
    avgCostR,
    costDragR,
    noFillRate,
    expiredRate,
    avgHoldingMinutes,
    approxMaxDrawdownR: drawdownR,
    maxAdverseStreak: streak,
    topSymbolPnlShare: symbolShare,
    plus10bpsNetAvgR,
    plus10bpsStillPositive,
    calendarDays: calendarDays(fresh),
    distinctRegimes,
    byRegime,
    byEntryVariant,
    oosThirds,
    allThreeOosPositive,
    rolling,
  };

  const { status, statusReason, blockers, cautions } = deriveVariantStatus(partial, infra);
  return { ...partial, status, statusReason, blockers, cautions };
}

/**
 * Builds the report-only synthetic regime-adaptive lane by pairing each signal's existing
 * fresh-valid CG_WIDE (full-exit) and CG_SCALEOUT obs and selecting the full-exit outcome in a
 * confirmed strong-trend regime, else the scaleout outcome. Pure; never admits/resolves/mutates.
 */
function buildRegimeAdaptiveSyntheticReport(
  all: CurrentGuardVariantMatrixObservation[],
): RegimeAdaptiveSyntheticReport {
  const wideByKey = new Map<string, CurrentGuardVariantMatrixObservation>();
  const scaleByKey = new Map<string, CurrentGuardVariantMatrixObservation>();
  for (const o of all) {
    if (!isFreshValidObs(o)) continue;
    if (o.variantId === "CG_WIDE_STOP_TP_WIDE") wideByKey.set(o.sourceObservationKey, o);
    else if (o.variantId === "CG_SCALEOUT_TP1_TRAIL") scaleByKey.set(o.sourceObservationKey, o);
  }

  const picked: CurrentGuardVariantMatrixObservation[] = [];
  const widePaired: CurrentGuardVariantMatrixObservation[] = [];
  const scaleoutPaired: CurrentGuardVariantMatrixObservation[] = [];
  let pickedFullExit = 0;
  let pickedScaleout = 0;
  for (const [key, wide] of wideByKey) {
    const scale = scaleByKey.get(key);
    if (!scale) continue; // pair only — both branches must have an apples-to-apples outcome
    widePaired.push(wide);
    scaleoutPaired.push(scale);
    if (isStrongTrendRegime(wide.regime ?? scale.regime)) {
      picked.push(wide);
      pickedFullExit += 1;
    } else {
      picked.push(scale);
      pickedScaleout += 1;
    }
  }
  picked.sort(orderByResolved);

  const netVals = picked.map((o) => o.netR);
  const netAvgR = mean(netVals);
  const grossAvgR = mean(picked.map((o) => o.grossR));
  const pf = profitFactor(netVals);
  const wins = picked.filter((o) => (o.netR ?? 0) > 0).length;
  const wr = picked.length > 0 ? wins / picked.length : null;

  let oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null = null;
  let allThreeOosPositive = false;
  if (picked.length >= 3) {
    const third = Math.floor(picked.length / 3);
    const s1 = segmentStat("oos_1", picked.slice(0, third));
    const s2 = segmentStat("oos_2", picked.slice(third, 2 * third));
    const s3 = segmentStat("oos_3", picked.slice(2 * third));
    oosThirds = [s1, s2, s3];
    allThreeOosPositive = [s1, s2, s3].every((s) => s.netAvgR !== null && s.netAvgR > 0);
  }

  const scaleoutNetAvgR = mean(scaleoutPaired.map((o) => o.netR));
  const fullExitNetAvgR = mean(widePaired.map((o) => o.netR));
  const beatsScaleout = netAvgR !== null && scaleoutNetAvgR !== null && netAvgR > scaleoutNetAvgR;

  return {
    reportOnly: true,
    note:
      "Report-only synthetic lane: per signal, takes the CG_WIDE (full-exit) outcome in a confirmed " +
      "strong-trend regime, else the CG_SCALEOUT outcome — pairing existing resolved obs on the SAME " +
      "signals. Never admits/resolves. Must beat plain scaleout (beatsScaleout) to justify a real lane.",
    pairedSignals: picked.length,
    pickedFullExit,
    pickedScaleout,
    freshValid: picked.length,
    netAvgR,
    grossAvgR,
    pf,
    wr,
    oosThirds,
    allThreeOosPositive,
    scaleoutNetAvgR,
    fullExitNetAvgR,
    beatsScaleout,
  };
}

export function buildCurrentGuardVariantMatrixReport(
  store: CurrentGuardVariantMatrixStore,
  opts: CurrentGuardVariantMatrixReportOptions = {},
): CurrentGuardVariantMatrixReport {
  const computedAt = opts.capturedAt ?? new Date().toISOString();
  const computedAtMs = new Date(computedAt).getTime();
  const nowMs = Number.isFinite(computedAtMs) ? computedAtMs : Date.now();
  const all = store.all;
  const infra = {
    killSwitchReady: Boolean(opts.killSwitchReady),
    orderReconciliationReady: Boolean(opts.orderReconciliationReady),
    exchangeHealthReady: Boolean(opts.exchangeHealthReady),
  };

  // ── Resolver diagnostics (computed from store state + persisted meta) ─────
  const openObs = all.filter((o) => o.status === "OPEN");
  const staleOpenObs = openObs.filter((o) => {
    const ageMs = nowMs - (toMs(o.openedAt) ?? toMs(o.createdAt) ?? nowMs);
    return ageMs > STALE_OPEN_WARN_MS;
  });
  let oldestOpenAgeHours: number | null = null;
  if (openObs.length > 0) {
    const oldestMs = Math.min(...openObs.map((o) => toMs(o.openedAt) ?? toMs(o.createdAt) ?? nowMs));
    oldestOpenAgeHours = Math.round(((nowMs - oldestMs) / (60 * 60 * 1000)) * 10) / 10;
  }
  const staleOpenCount = staleOpenObs.length;
  const meta = store.getResolverMeta();
  const resolverDiagnostics: VariantMatrixResolverDiagnostics = {
    lastRunAt: meta?.lastRunAt ?? null,
    resolvedThisRun: meta?.resolvedCount ?? null,
    expiredThisRun: meta?.expiredCount ?? null,
    dataFailuresThisRun: meta?.dataFailureCount ?? null,
    staleOpenCount,
    oldestOpenAgeHours,
    nextAction:
      staleOpenCount > 0
        ? `${staleOpenCount} OPEN observation(s) >72h; call /api/shadow/dashboard-audit-summary or operator-brief?resolve=1 to expire them.`
        : openObs.length > 0
        ? "Open observations pending — resolver runs fire-and-forget on each dashboard call."
        : null,
  };

  const rows = VARIANT_MATRIX_DEFINITIONS.map((def) =>
    buildRow(def, all.filter((o) => o.variantId === def.id), infra),
  );

  const baselineRow = rows.find((r) => r.variantId === BASELINE_VARIANT_ID) ?? null;
  const baselineNet = baselineRow?.netAvgR ?? null;

  // Best candidate = highest netAvgR among variants with enough fresh-valid
  // evidence to be watchable.
  let bestVariantId: VariantMatrixVariantId | null = null;
  let bestVariantNetAvgR: number | null = null;
  for (const r of rows) {
    if (r.freshValid < WATCHABLE_MIN_FRESH || r.netAvgR === null) continue;
    if (bestVariantNetAvgR === null || r.netAvgR > bestVariantNetAvgR) {
      bestVariantNetAvgR = r.netAvgR;
      bestVariantId = r.variantId;
    }
  }
  const bestBeatsBaseline =
    bestVariantId !== null &&
    bestVariantId !== BASELINE_VARIANT_ID &&
    bestVariantNetAvgR !== null &&
    baselineNet !== null &&
    bestVariantNetAvgR > baselineNet;

  const notes: string[] = [
    "Report-only forward A/B harness. All variants are simulated against the same qualifying signal population; liveBlocked stays true and microPilotAllowed stays false.",
    "Resolution is conservative: same-candle SL+TP is refined with 1m candles where available, else resolves SL-first (a loss). Never optimistic.",
    "Per-variant cost-in-R = round-trip bps / stop-distance bps (wider stops carry lower cost-in-R). Taker round-trip = fee+slippage; maker = conservative maker fee.",
  ];

  return {
    reportOnly: true,
    laneVersion: CURRENT_GUARD_VARIANT_MATRIX_LANE,
    policyVersion: CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION,
    computedAt,
    cutoverTimestamp: opts.cutoverTimestamp ?? null,
    sourcePopulationNote:
      "Same qualifying current-guard population as the F****** post-cutover lane (stop175 + anchor-consistent V2; post-cutover subset when a boundary is locked).",
    totalObservations: all.length,
    variantCount: VARIANT_MATRIX_DEFINITIONS.length,
    baselineVariantId: BASELINE_VARIANT_ID,
    rows,
    bestVariantId,
    bestVariantNetAvgR,
    bestBeatsBaseline,
    resolverDiagnostics,
    regimeAdaptiveSynthetic: buildRegimeAdaptiveSyntheticReport(all),
    killSwitchReady: infra.killSwitchReady,
    orderReconciliationReady: infra.orderReconciliationReady,
    exchangeHealthReady: infra.exchangeHealthReady,
    liveBlocked: true,
    microPilotAllowed: false,
    notes,
  };
}

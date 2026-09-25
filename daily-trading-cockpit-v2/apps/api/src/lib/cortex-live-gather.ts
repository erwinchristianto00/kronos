/**
 * CORTEX live gather (2026-07-12) — the IMPURE-fetch's PURE core. Turns injected per-lane accessors into
 * a fully-assembled CortexContext for the shadow tick. Every external read is a DEPENDENCY (no singletons
 * imported here) so the semantic mapping — the operator-flagged "rawest part" — is unit-testable with
 * fakes: XSEC %→R, hasReport gating, edge-memory n=0→null, conviction=convictionScore, veto derivation,
 * the two drawdown signals. The thin binding to the real singletons lives in cortex-live-gather-bindings.ts.
 *
 * Contract (locked with the operator 2026-07-12): the actual feature mapping (units, guards, null-vs-0)
 * is done by buildLaneObservationFromRaw in cortex-brain-gather.ts; this module's ONLY job is to POPULATE
 * a CortexLaneRaw honestly from real accessors and derive the two things the raw needs that aren't a
 * single field: the direction-relative `vetoed` boolean and the roster/direction/isXsec of each lane.
 */

import {
  RC_PAPER_LANE_ID,
} from "./regime-composite-edge.js";
import { RCS_PAPER_LANE_ID } from "./regime-composite-short-edge.js";
import { SF_PAPER_LANE_ID } from "./short-fade-edge.js";
import { IM_PAPER_LANE_ID } from "./intraday-momentum-edge.js";
import { PWR_PAPER_LANE_ID } from "./panic-washout-reclaim-edge.js";
import { ceLaneIdForBucket } from "./composite-estimator-edge.js";
import {
  CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
  CROSS_SECTIONAL_TREND_LANE_ID,
  CROSS_SECTIONAL_MIXED_LANE_ID,
} from "./cross-sectional-executor.js";
import {
  buildLaneObservationFromRaw,
  portfolioDrawdownFraction,
  killBudgetUtilization,
  CORTEX_XSEC_STOP_RETURN,
  type CortexLaneRaw,
  type CrowdSide,
  type ControllerBias,
} from "./cortex-brain-gather.js";
import { assembleCortexContext, type CortexContext } from "./cortex-brain.js";

export type CortexLaneDirection = "LONG" | "SHORT" | "NEUTRAL";

/** CG_MFE_GIVEBACK is direction-agnostic at execution time, so CORTEX must never pool its
 * SHORT outcomes under a LONG feature vector. These are separate causal learners. */
export const CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID = "CG_MFE_GIVEBACK_LONG" as const;
export const CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID = "CG_MFE_GIVEBACK_SHORT" as const;

/** `LiveExecutionEngine.laneSelectionWeightPctForLane` (the real allocation table) has no concept of
 *  the LONG/SHORT split above — it only ever matches the single real id "CG_MFE_GIVEBACK" (mirrors
 *  CG_ROSTER's variantId mapping in cortex-refit-runner-bindings.ts, which resolves the same split for
 *  a different accessor). Map the two synthetic roster ids to that real id for the static-weight lookup
 *  ONLY; the synthetic id stays untouched everywhere else (journaling, attribution, edge-memory). */
export function engineLaneIdForStaticWeight(laneId: string): string {
  return laneId === CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID || laneId === CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID
    ? "CG_MFE_GIVEBACK"
    : laneId;
}

/** Code-anchored roster: laneId + direction + isXsec are construction-time literals in app.ts (NOT
 *  available from any runtime getter), so they are pinned here. Direction/isXsec confirmed against the
 *  executor-wiring constants. Keep in sync if a lane's wiring direction changes. */
export interface CortexRosterEntry {
  laneId: string;
  direction: CortexLaneDirection;
  isXsec: boolean;
}
export const CORTEX_LANE_ROSTER: readonly CortexRosterEntry[] = [
  // CG paper-mirror lanes (preset-only; no dedicated executor) — all LONG, BREADTH.
  { laneId: "CG_WIDE_FAST_LONG", direction: "LONG", isXsec: false },
  { laneId: "CG_WIDE_LONG_RUNNER", direction: "LONG", isXsec: false },
  { laneId: CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID, direction: "LONG", isXsec: false },
  { laneId: CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID, direction: "SHORT", isXsec: false },
  // Composite confirmation (RC long / RCS short).
  { laneId: RC_PAPER_LANE_ID, direction: "LONG", isXsec: false },
  { laneId: RCS_PAPER_LANE_ID, direction: "SHORT", isXsec: false },
  // Composite estimator (bidirectional buckets).
  { laneId: ceLaneIdForBucket("WIDE_LONG"), direction: "LONG", isXsec: false },
  { laneId: ceLaneIdForBucket("WIDE_SHORT"), direction: "SHORT", isXsec: false },
  { laneId: ceLaneIdForBucket("FAST_LONG"), direction: "LONG", isXsec: false },
  { laneId: ceLaneIdForBucket("FAST_SHORT"), direction: "SHORT", isXsec: false },
  // Tactical.
  { laneId: SF_PAPER_LANE_ID, direction: "SHORT", isXsec: false },
  { laneId: IM_PAPER_LANE_ID, direction: "LONG", isXsec: false },
  { laneId: PWR_PAPER_LANE_ID, direction: "LONG", isXsec: false },
  // Cross-sectional NEUTRAL baskets.
  { laneId: CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID, direction: "NEUTRAL", isXsec: true },
  { laneId: CROSS_SECTIONAL_TREND_LANE_ID, direction: "NEUTRAL", isXsec: true },
  { laneId: CROSS_SECTIONAL_MIXED_LANE_ID, direction: "NEUTRAL", isXsec: true },
];
/**
 * Lanes DELIBERATELY RETIRED — kept on the roster (six other consumers read it: the default
 * allocation at app.ts, the manual-direction validator, FOUR_BRAIN_LANE_SUPPORT, outcome
 * attribution metadata, deriveDirectionVeto) but excluded from the readiness DENOMINATOR.
 *
 * Why the denominator specifically (2026-07-27): laneCoverage = learningActiveLanes / rosterSize.
 * A lane whose executor is switched off can never reach LEARNING_ACTIVE, so leaving it in the
 * denominator caps the component at 14/16 = 87.5% and the weighted headline at 97.5% — forever,
 * for work nobody intends to do. A progress meter with an unreachable ceiling stops being read.
 *
 * This does NOT remove anything from the roster. Editing CORTEX_LANE_ROSTER would change the
 * default allocation table and the direction validator, which is real blast radius for a
 * reporting fix.
 *
 * Default EMPTY ⇒ byte-identical to pre-2026-07-27 behaviour on every instance. Ids not actually
 * on the roster are ignored rather than silently shrinking the denominator on a typo.
 */
export function cortexRetiredLaneIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = (env.CORTEX_RETIRED_LANE_IDS ?? "").trim();
  if (raw.length === 0) return new Set<string>();
  const onRoster = new Set(CORTEX_LANE_ROSTER.map((e) => e.laneId));
  return new Set(
    raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && onRoster.has(s)),
  );
}

/** Roster size with retired lanes removed. Floored at 1 so the ratio can never divide by zero. */
export function cortexEffectiveRosterSize(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, CORTEX_LANE_ROSTER.length - cortexRetiredLaneIds(env).size);
}


/** A directional lane's OWN rolling realized report (R + PF + resolved count). */
export interface CortexLaneReportLike {
  netAvgR: number | null; // R (net of cost); null at resolvedCount===0 (NOT a fabricated 0)
  pf: number | null;
  resolvedCount: number;
  /** 2026-07-22 bug-hunt fix: the source store's cycleMeta.lastCycleAt, when the store tracks one
   *  (RC/RCS/SF/PWR/CE do; IM currently does not) — omit/undefined for stores that don't, never a
   *  guessed value. Feeds STALE detection in cortex-brain-gather.ts's guard functions. */
  lastCycleAt?: string | null;
  /**
   * 2026-08-02 LIVE-LANE WIRING fix (mirrors four-brain-live-gather-bindings.ts's LaneReportLike,
   * which already gates on these four strictly — see selectBestLaneReportForDirection). Genuinely
   * computed by liveLaneReport() (see lane-edge-report-fields.ts); never defaulted to true.
   * buildCortexLaneRaw below deliberately never reads any of these four — CORTEX's own gather
   * consumes raw netAvgR/pf, not the post-fix-qualified view; only the four-brain layer's
   * bestLaneReportForDirection consumer requires them. */
  conservativeNetR?: number | null;
  postFixExactLineage?: boolean;
  costValid?: boolean;
  fresh?: boolean;
}
/** A NEUTRAL basket's report (fractional per-basket net return + resolved basket count). */
export interface CortexXsecReportLike {
  netAvgReturn: number | null; // FRACTION (not %, not bps, not R)
  resolvedCount: number;
  /** Same as CortexLaneReportLike.lastCycleAt; omitted here since the cross-sectional store
   *  currently tracks no cycle timestamp at all. */
  lastCycleAt?: string | null;
}
/** The regime-edge-memory slice + verdict, keyed by regime×direction. */
export interface CortexEdgeMemoryLike {
  lookup(regimeRaw: string | null, direction: "LONG" | "SHORT"): { avgNetR: number; n: number };
  verdict(regimeRaw: string | null, direction: "LONG" | "SHORT"): { decision: string };
  hasPositiveLane(regimeRaw: string | null, direction: "LONG" | "SHORT"): boolean;
}
/** The graduated regime-direction-controller report (directional conviction, posture, hard-block). */
export interface CortexControllerLike {
  directionalBias: string; // 'LONG'|'SHORT'|'NEUTRAL'|'MIXED'|'UNKNOWN'
  convictionScore: number | null; // the DIRECTIONAL 0..1 conviction — NOT the MEDIUM-floored `confidence` tier
  allowsLong: boolean;
  allowsShort: boolean;
  controllerMode: string; // NO_TRADE_* / WAIT_* / UNKNOWN are hard blocks
  edgeGated: boolean;
}

export interface CortexGatherDeps {
  staticWeightPctForLane(laneId: string): number; // engine.laneSelectionWeightPctForLane
  laneReport(laneId: string): CortexLaneReportLike | null; // directional lanes; null = not sourced
  xsecReport(laneId: string): CortexXsecReportLike | null; // neutral baskets; null = not sourced
  crowdSidesForLane(laneId: string): CrowdSide[]; // [] ⇒ crowdingAlign MISSING (neutral-filled)
  kronosAgreeForLane(laneId: string): number | null; // CE only; null otherwise (~55% MISSING is normal)
  edgeMemory: CortexEdgeMemoryLike;
  controller: CortexControllerLike;
  regimeRaw: string | null;
  axisScore: number | null;
  axisSlopePerHour: number | null;
  killLatched: boolean;
  equityPeak: number | null; // for portfolioDrawdownPct = (peak−current)/peak
  currentEquity: number | null;
  currentDrawdownUsd: number | null; // for killBudgetUtilization = drawdownUsd/killBudget
  killBudgetUsd: number | null;
  /** 2026-07-22 bug-hunt fix: wall-clock "now" for this gather, needed by the STALE-detection guard
   *  in buildCortexLaneRaw (pure — never reads Date.now() itself). */
  nowMs: number;
}

/**
 * `LiveExecutionEngine.laneSelectionWeightPctForLane()` deliberately returns 100 for every
 * lane while no explicit allocation is configured: there it means "not blocked", not "100% of
 * portfolio". CORTEX, however, consumes this field as a portfolio weight. Normalize only an
 * over-100 roster total so explicit partial allocations (for example a deliberate 25% sleeve)
 * retain their cash reserve, while ALL_LANES cannot become an impossible 1500% portfolio.
 */
export function normalizeCortexStaticWeightPctForLane(
  staticWeightPctForLane: (laneId: string) => number,
): (laneId: string) => number {
  // Keyed by the real engine lane id, not the roster id: CG_MFE_GIVEBACK_LONG/_SHORT both resolve to
  // the one real "CG_MFE_GIVEBACK" sleeve, so it must be looked up (and counted toward the over-100
  // clip) exactly once — counting it per roster entry would double it and wrongly shrink every other
  // lane's weight whenever CG_MFE_GIVEBACK has a nonzero real allocation.
  const rawByEngineLane = new Map<string, number>();
  for (const entry of CORTEX_LANE_ROSTER) {
    const engineLaneId = engineLaneIdForStaticWeight(entry.laneId);
    if (rawByEngineLane.has(engineLaneId)) continue;
    const raw = staticWeightPctForLane(engineLaneId);
    rawByEngineLane.set(engineLaneId, Number.isFinite(raw) ? Math.max(0, raw) : 0);
  }
  const total = [...rawByEngineLane.values()].reduce((sum, weight) => sum + weight, 0);
  const scale = total > 100 ? 100 / total : 1;
  return (laneId: string) => (rawByEngineLane.get(engineLaneIdForStaticWeight(laneId)) ?? 0) * scale;
}

/** Map the controller's directionalBias enum to the gather's ControllerBias (only LONG/SHORT change the
 *  directional conviction match; everything else collapses to 0.5 in convictionForLane). */
export function mapControllerBias(bias: string): ControllerBias {
  return bias === "LONG" ? "LONG" : bias === "SHORT" ? "SHORT" : bias === "MIXED" ? "MIXED" : bias === "UNKNOWN" ? "UNKNOWN" : "NONE";
}

/**
 * Derive the `vetoed` boolean to mirror the LIVE mainnet funded-executor gate EXACTLY — which is the
 * per-direction edge-memory veto and nothing else (app.ts `edgeVeto(direction)`, verified 2026-07-12):
 *   - blank/absent regime → allowed (FAIL-OPEN);
 *   - verdict ALLOW_PROVEN / ALLOW_INSUFFICIENT → allowed;
 *   - VETO_NEGATIVE but a proven-positive lane rescues the direction → allowed;
 *   - otherwise (VETO_NEGATIVE, no rescue) → vetoed.
 * It deliberately does NOT consult the controller posture (controllerMode / allowsLong / allowsShort /
 * edgeGated): the mainnet funded lanes gate ONLY on edge-memory (the controller "brain vote" is a
 * TESTNET-only layer). Folding the controller in here over-vetoed lanes the live incumbent actually
 * trades (panic/chop/unknown regimes + a cross-direction edgeGated leak), breaking the core
 * "β=0 == post-federated-veto incumbent" invariant. NEUTRAL baskets have no directional slice → never
 * vetoed. (`edgeGated`/`controllerMode`/posture stay on the controller for the CONVICTION feature only.)
 */
export function deriveDirectionVeto(args: {
  direction: CortexLaneDirection;
  edgeMemory: CortexEdgeMemoryLike;
  regimeRaw: string | null;
}): boolean {
  const { direction, edgeMemory, regimeRaw } = args;
  if (direction !== "LONG" && direction !== "SHORT") return false; // NEUTRAL basket — no directional slice
  if (regimeRaw == null || regimeRaw.trim().length === 0) return false; // fail-open, exactly like edgeVeto
  const v = edgeMemory.verdict(regimeRaw, direction);
  if (v.decision !== "VETO_NEGATIVE") return false; // ALLOW_PROVEN / ALLOW_INSUFFICIENT → allowed
  return !edgeMemory.hasPositiveLane(regimeRaw, direction); // vetoed only if no proven-positive lane rescues
}

/** Build one lane's CortexLaneRaw from the injected accessors. */
export function buildCortexLaneRaw(entry: CortexRosterEntry, deps: CortexGatherDeps): CortexLaneRaw {
  const directional = entry.direction === "LONG" || entry.direction === "SHORT";
  const rep = entry.isXsec ? null : deps.laneReport(entry.laneId);
  const xrep = entry.isXsec ? deps.xsecReport(entry.laneId) : null;
  // Edge-memory: emptyStat returns {n:0,avgNetR:0} for an absent slice — map n=0 to a genuine null
  // (never a fabricated 0), so the model treats "no proven edge" as MISSING, not "zero edge".
  const edgeStat = directional ? deps.edgeMemory.lookup(deps.regimeRaw, entry.direction as "LONG" | "SHORT") : { avgNetR: 0, n: 0 };
  const edgeMemN = Math.max(0, edgeStat.n);
  const edgeMemAvgNetR = edgeMemN > 0 ? edgeStat.avgNetR : null;
  return {
    laneId: entry.laneId,
    direction: entry.direction,
    edgeMemAvgNetR,
    edgeMemN,
    vetoed: deriveDirectionVeto({ direction: entry.direction, edgeMemory: deps.edgeMemory, regimeRaw: deps.regimeRaw }),
    reportNetAvgR: rep?.netAvgR ?? null,
    reportPf: rep?.pf ?? null,
    reportN: entry.isXsec ? xrep?.resolvedCount ?? 0 : rep?.resolvedCount ?? 0,
    hasReport: entry.isXsec ? xrep != null && xrep.resolvedCount > 0 : rep != null && rep.resolvedCount > 0,
    lastCycleAt: entry.isXsec ? xrep?.lastCycleAt ?? null : rep?.lastCycleAt ?? null,
    nowMs: deps.nowMs,
    isXsec: entry.isXsec,
    xsecNetAvgReturn: xrep?.netAvgReturn ?? null,
    xsecStopDistance: CORTEX_XSEC_STOP_RETURN,
    crowdSides: deps.crowdSidesForLane(entry.laneId),
    kronosAgree: deps.kronosAgreeForLane(entry.laneId),
    controllerBias: mapControllerBias(deps.controller.directionalBias),
    controllerConviction: deps.controller.convictionScore,
    staticWeightPct: deps.staticWeightPctForLane(engineLaneIdForStaticWeight(entry.laneId)),
  };
}

/**
 * Assemble the full CortexContext for a shadow tick.
 *
 * Every roster lane is journaled, including lanes with a zero incumbent allocation. An allocation is an
 * execution choice, not an observation filter: omitting zero-weight lanes meant a later paper outcome
 * could not be causally linked to the contemporaneous CORTEX context and silently stayed unlearnable.
 * The zero weight remains in the feature vector and final allocation, so this expands shadow evidence
 * only; it cannot fund a lane or alter live execution.
 */
export function gatherCortexContext(deps: CortexGatherDeps): CortexContext {
  const normalizedStaticWeightPctForLane = normalizeCortexStaticWeightPctForLane(deps.staticWeightPctForLane);
  const normalizedDeps = { ...deps, staticWeightPctForLane: normalizedStaticWeightPctForLane };
  const observations = CORTEX_LANE_ROSTER
    .map((entry) => buildCortexLaneRaw(entry, normalizedDeps))
    .map((raw) => buildLaneObservationFromRaw(raw).obs);
  const top: Omit<CortexContext, "lanes"> = {
    regimeFamily: deps.regimeRaw ?? "UNKNOWN",
    axisScore: deps.axisScore,
    axisSlopePerHour: deps.axisSlopePerHour,
    allowLong: deps.controller.allowsLong,
    allowShort: deps.controller.allowsShort,
    portfolioDrawdownPct: portfolioDrawdownFraction(deps.equityPeak, deps.currentEquity),
    killBudgetUtilization: killBudgetUtilization(deps.currentDrawdownUsd, deps.killBudgetUsd),
    killLatched: deps.killLatched,
  };
  return assembleCortexContext(top, observations);
}

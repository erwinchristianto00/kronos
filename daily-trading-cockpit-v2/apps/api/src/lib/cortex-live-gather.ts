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
  { laneId: "CG_MFE_GIVEBACK", direction: "LONG", isXsec: false },
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

/** A directional lane's OWN rolling realized report (R + PF + resolved count). */
export interface CortexLaneReportLike {
  netAvgR: number | null; // R (net of cost); null at resolvedCount===0 (NOT a fabricated 0)
  pf: number | null;
  resolvedCount: number;
}
/** A NEUTRAL basket's report (fractional per-basket net return + resolved basket count). */
export interface CortexXsecReportLike {
  netAvgReturn: number | null; // FRACTION (not %, not bps, not R)
  resolvedCount: number;
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
    isXsec: entry.isXsec,
    xsecNetAvgReturn: xrep?.netAvgReturn ?? null,
    xsecStopDistance: CORTEX_XSEC_STOP_RETURN,
    crowdSides: deps.crowdSidesForLane(entry.laneId),
    kronosAgree: deps.kronosAgreeForLane(entry.laneId),
    controllerBias: mapControllerBias(deps.controller.directionalBias),
    controllerConviction: deps.controller.convictionScore,
    staticWeightPct: deps.staticWeightPctForLane(entry.laneId),
  };
}

/**
 * Assemble the full CortexContext for a shadow tick. Includes ONLY roster lanes with staticWeightPct > 0
 * (the lanes the incumbent live allocation table actually funds) — filtering keeps the shadow decision
 * aligned to the incumbent's active set. (Degenerate case: if allocations are OFF the accessor returns
 * 100 for every lane and none are filtered; that is a report-only artifact, harmless in shadow.)
 */
export function gatherCortexContext(deps: CortexGatherDeps): CortexContext {
  const observations = CORTEX_LANE_ROSTER
    .map((entry) => buildCortexLaneRaw(entry, deps))
    .filter((raw) => raw.staticWeightPct > 0)
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

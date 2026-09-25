/**
 * Best-lane-report selector for the four-brain Direction Brain's `bestLaneReportForDirection` input
 * (item 2 of the 3 permanent-null data gaps in app.ts's buildFourBrainDeps — see btc-atr-percentile-
 * cache.ts for item 1's near-identical shape of fix: a real producer replacing a permanent stub).
 *
 * PURE CORE (`selectBestLaneReportForDirection`): given the four-brain lane roster (laneId + direction)
 * and a DI per-lane report lookup, picks the single best LaneReportLike for a requested direction.
 * Unit-testable with a fake report map — no store/report-builder imports in this function at all.
 *
 * IMPURE BINDING (`buildLiveBestLaneReportForDirection`): wires the real roster (FOUR_BRAIN_LANE_SUPPORT)
 * + the real per-lane report accessor (`liveLaneReport`, exported from cortex-live-gather-bindings.ts —
 * the SAME six edge-module store+report-builder calls (RC/RCS/SF/IM/PWR/CE) CORTEX's own gather already
 * uses, re-consumed here for a second, independent accessor) into the exact closure shape
 * buildFourBrainDeps needs. Every store getter/report builder `liveLaneReport` calls is a synchronous,
 * idempotent read — safe to call again from this second consumer within the same sync tick.
 *
 * Selection rule (documented — one reasonable choice among several, not the only one): among the roster
 * lanes whose direction matches the request, pick the lane with the HIGHEST netAvgR among those with
 * resolvedCount > 0. This maximizes the edge signal fed into the Direction Brain's longLaneEdge /
 * shortLaneEdge score input (direction-brain.ts's `edgeSub` only rewards POSITIVE edge, so the "best" lane
 * is the one most likely to clear DIRECTION_EDGE_HURDLE_R and contribute a high 0..1 sub-score) — i.e.
 * "best" == "most likely to justify leaning into this direction right now", consistent with the accessor's
 * name. Ties keep the FIRST roster-order lane encountered (the roster is a fixed literal array, so this is
 * fully deterministic, never insertion-order-of-a-Map or iteration-order-of-an-object).
 *
 * Never fabricates: resolvedCount === 0 lanes are NEVER selectable, even if a leftover/fabricated netAvgR
 * would otherwise "win" — matching this codebase's n=0-fabricated-0 convention used everywhere else (see
 * cortex-live-gather-bindings.ts's liveXsecReport doc comment for the sibling convention on the NEUTRAL
 * side, and four-brain-live-gather-bindings.ts's own `longLane && longLane.resolvedCount > 0 ? ... : null`
 * gate at the consumer). If every roster lane for the direction has resolvedCount === 0, or the roster has
 * no lane at all for that direction, this returns null — never a fabricated report.
 */
import { FOUR_BRAIN_LANE_SUPPORT } from "./four-brain-lane-support.js";
import { liveLaneReport, type CEBucketStatsList } from "./cortex-live-gather-bindings.js";
import type { LaneReportLike } from "./four-brain-live-gather-bindings.js";
import type { CortexLaneDirection } from "./cortex-live-gather.js";

/** Minimal roster shape the pure selector needs — structurally satisfied by both FOUR_BRAIN_LANE_SUPPORT
 *  entries and CORTEX_LANE_ROSTER entries, but kept local (no CortexRosterEntry/FourBrainLaneSupport
 *  import) so this function has no hard dependency on either registry's full shape. */
export interface LaneRosterEntryLike {
  laneId: string;
  direction: CortexLaneDirection;
}

/**
 * PURE: pick the single best qualified LaneReportLike for `direction` among
 * `roster`. Raw mean R is deliberately not a ranking input: a report must
 * prove exact post-fix lineage, finite costs, freshness, and a positive
 * conservative expected R before it can represent a Direction-Brain edge.
 *
 * `laneReportForId` is allowed to throw (a defensive DI contract, matching `liveLaneReport`'s own
 * try/catch convention) — a single lane's accessor failing must never abort the selection for the
 * remaining roster lanes.
 */
export function selectBestLaneReportForDirection(
  direction: "LONG" | "SHORT",
  roster: readonly LaneRosterEntryLike[],
  laneReportForId: (laneId: string) => LaneReportLike | null,
): LaneReportLike | null {
  let best: LaneReportLike | null = null;
  for (const entry of roster) {
    if (entry.direction !== direction) continue;
    let report: LaneReportLike | null;
    try {
      report = laneReportForId(entry.laneId);
    } catch {
      continue; // one lane's report accessor throwing must never break selection for the rest
    }
    if (!report) continue;
    if (!(report.resolvedCount > 0)) continue;
    if (report.postFixExactLineage !== true || report.costValid !== true || report.fresh !== true) continue;
    if (!(typeof report.conservativeNetR === "number" && Number.isFinite(report.conservativeNetR) && report.conservativeNetR > 0)) continue;
    if (best === null || report.conservativeNetR > (best.conservativeNetR as number)) {
      best = report;
    }
  }
  return best;
}

/**
 * IMPURE: build the real bestLaneReportForDirection closure for app.ts's buildFourBrainDeps. Mirrors
 * buildLiveCortexGatherDeps's `ceBucketsOnce` memoization contract — the caller must supply ONE
 * memoized-per-tick `ceBucketsOnce`, so the four CE bucket lanes' shared composite-estimator report is
 * built at most once per gather call, not once per direction × per CE lane queried.
 */
export function buildLiveBestLaneReportForDirection(
  dataDir: string,
  ceBucketsOnce: () => CEBucketStatsList,
  nowMs: number = Date.now(),
): (direction: "LONG" | "SHORT") => LaneReportLike | null {
  return (direction) =>
    selectBestLaneReportForDirection(direction, FOUR_BRAIN_LANE_SUPPORT, (laneId) =>
      liveLaneReport(laneId, dataDir, ceBucketsOnce, nowMs),
    );
}

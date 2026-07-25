/**
 * CORTEX live gather — IMPURE bindings (2026-07-12). Wires the real report-builder singletons to the
 * pure CortexGatherDeps interface. Thin + side-effect-free reads only (no writes, no order flow). This is
 * the boundary the pure gather (cortex-live-gather.ts) keeps out of its own body so the semantics stay
 * unit-testable; here we just point each dependency at the production accessor.
 *
 * Phase-1 sourcing decisions (honest, minimal-surface):
 *  - directional laneReport: the six self-contained edge modules (RC/RCS/SF/IM/PWR/CE). CG paper-mirror
 *    lanes have NO standalone report builder here → laneReport returns null (their allocation magnitude is
 *    driven by regime×direction edge-memory, not their own report; the own-report features neutral-fill).
 *  - xsecReport: buildCrossSectionalReport per variant (FILTERED / TREND_BETA_VOL / MIXED_MEAN_REVERSION).
 *  - crowdSides: [] and kronosAgree: null (NOT sourced in this increment → crowdingAlign MISSING / kronos
 *    MISSING, both neutral-filled). Wiring live funding + a current Kronos forecast is a later increment.
 *  - drawdown inputs (equityPeak/currentEquity/currentDrawdownUsd): null unless the caller supplies them
 *    from an engine getter → the two drawdown fractions resolve to 0 (gross G=1, no deleverage) until a
 *    small read-only engine accessor is added. killLatched + killBudgetUsd ARE sourced.
 */

import { buildRegimeCompositeReport, getRegimeCompositeStore, RC_PAPER_LANE_ID } from "./regime-composite-edge.js";
import { buildRegimeCompositeShortReport, getRegimeCompositeShortStore, RCS_PAPER_LANE_ID } from "./regime-composite-short-edge.js";
import { buildShortFadeReport, getShortFadeStore, SF_PAPER_LANE_ID } from "./short-fade-edge.js";
import { buildIntradayMomentumReport, getIntradayMomentumStore, IM_PAPER_LANE_ID } from "./intraday-momentum-edge.js";
import { buildPanicWashoutReport, getPanicWashoutStore, PWR_PAPER_LANE_ID } from "./panic-washout-reclaim-edge.js";
import { buildCompositeEstimatorReport, getCompositeEstimatorStore, ceLaneIdForBucket, type CEBucket } from "./composite-estimator-edge.js";
import {
  buildCrossSectionalReport,
  getCrossSectionalStore,
  type CrossSectionalVariant,
} from "./cross-sectional-edge.js";
import {
  CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
  CROSS_SECTIONAL_TREND_LANE_ID,
  CROSS_SECTIONAL_MIXED_LANE_ID,
} from "./cross-sectional-executor.js";
import type {
  CortexGatherDeps,
  CortexControllerLike,
  CortexEdgeMemoryLike,
  CortexLaneReportLike,
  CortexXsecReportLike,
} from "./cortex-live-gather.js";

const CE_BUCKET_BY_LANE_ID: Record<string, CEBucket> = {
  [ceLaneIdForBucket("WIDE_LONG")]: "WIDE_LONG",
  [ceLaneIdForBucket("WIDE_SHORT")]: "WIDE_SHORT",
  [ceLaneIdForBucket("FAST_LONG")]: "FAST_LONG",
  [ceLaneIdForBucket("FAST_SHORT")]: "FAST_SHORT",
};

const XSEC_VARIANT_BY_LANE_ID: Record<string, CrossSectionalVariant> = {
  [CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID]: "FILTERED",
  [CROSS_SECTIONAL_TREND_LANE_ID]: "TREND_BETA_VOL",
  [CROSS_SECTIONAL_MIXED_LANE_ID]: "MIXED_MEAN_REVERSION",
};

export type CEBucketStatsList = ReturnType<typeof buildCompositeEstimatorReport>["buckets"];

/** Read one directional lane's OWN realized report, mapping laneId → its edge module. null for CG lanes
 *  (no standalone report builder) and anything unrecognized. Never throws (best-effort store read). The
 *  4 CE bucket lanes share ONE composite-estimator report — `ceBucketsOnce` memoizes it so the full
 *  observation scan runs once per tick, not 4× (per-tick load matters: the shadow runs for weeks).
 *
 *  Exported (2026-07-23) so a SECOND, independent consumer — the four-brain layer's
 *  bestLaneReportForDirection (see four-brain-best-lane-report.ts) — can reuse the exact same
 *  laneId→store/report-builder mapping instead of re-deriving it. Every store getter/report builder
 *  this function calls is a synchronous, idempotent read (not a one-shot), so a second caller in the
 *  same tick is safe. */
export function liveLaneReport(laneId: string, dataDir: string, ceBucketsOnce: () => CEBucketStatsList): CortexLaneReportLike | null {
  try {
    if (laneId === RC_PAPER_LANE_ID) {
      const store = getRegimeCompositeStore(dataDir);
      const r = buildRegimeCompositeReport(store.all);
      return { netAvgR: r.netAvgR, pf: r.pf, resolvedCount: r.resolvedCount, lastCycleAt: store.cycleMeta.lastCycleAt };
    }
    if (laneId === RCS_PAPER_LANE_ID) {
      const store = getRegimeCompositeShortStore(dataDir);
      const r = buildRegimeCompositeShortReport(store.all);
      return { netAvgR: r.netAvgR, pf: r.pf, resolvedCount: r.resolvedCount, lastCycleAt: store.cycleMeta.lastCycleAt };
    }
    if (laneId === SF_PAPER_LANE_ID) {
      const store = getShortFadeStore(dataDir);
      const r = buildShortFadeReport(store.all);
      return { netAvgR: r.netAvgR, pf: r.pf, resolvedCount: r.resolvedCount, lastCycleAt: store.cycleMeta.lastCycleAt };
    }
    if (laneId === IM_PAPER_LANE_ID) {
      // 2026-07-22 note: this store does not track a cycleMeta timestamp — lastCycleAt omitted
      // (never guessed), so this lane simply cannot be marked STALE yet, same as before this fix.
      const r = buildIntradayMomentumReport(getIntradayMomentumStore(dataDir).all);
      return { netAvgR: r.netAvgR, pf: r.pf, resolvedCount: r.resolvedCount };
    }
    if (laneId === PWR_PAPER_LANE_ID) {
      const store = getPanicWashoutStore(dataDir);
      const r = buildPanicWashoutReport(store.all);
      return { netAvgR: r.netAvgR, pf: r.pf, resolvedCount: r.resolvedCount, lastCycleAt: store.cycleMeta.lastCycleAt };
    }
    const bucket = CE_BUCKET_BY_LANE_ID[laneId];
    if (bucket) {
      const stats = ceBucketsOnce().find((b) => b.bucket === bucket);
      const lastCycleAt = getCompositeEstimatorStore(dataDir).cycleMeta.lastCycleAt;
      return stats ? { netAvgR: stats.netAvgR, pf: stats.pf, resolvedCount: stats.resolvedCount, lastCycleAt } : null;
    }
    return null; // CG paper-mirror lanes + unknown ids → own-report not sourced (edge-memory drives magnitude)
  } catch {
    return null;
  }
}

/** Read one NEUTRAL basket's report (fractional net return + resolved count), mapping laneId → variant. */
function liveXsecReport(laneId: string, dataDir: string, nowMs: number): CortexXsecReportLike | null {
  const variant = XSEC_VARIANT_BY_LANE_ID[laneId];
  if (!variant) return null;
  try {
    const r = buildCrossSectionalReport(getCrossSectionalStore(dataDir), nowMs, { variant });
    // r.netAvgReturn is mean(nets) and FABRICATES 0 on an empty set — gate on r.closed so a no-basket
    // variant reports null, not a fake 0 (the pure gather's xsecReturnToR also nulls at n===0, but we
    // null the numerator here too so the journal never records a phantom return).
    return { netAvgReturn: r.closed > 0 ? r.netAvgReturn : null, resolvedCount: r.closed };
  } catch {
    return null;
  }
}

export interface LiveCortexGatherInputs {
  /** the live engine (for the per-lane static allocation weight). */
  staticWeightPctForLane(laneId: string): number;
  edgeMemory: CortexEdgeMemoryLike;
  controller: CortexControllerLike;
  regimeRaw: string | null;
  axisScore: number | null;
  axisSlopePerHour: number | null;
  killLatched: boolean;
  killBudgetUsd: number | null;
  /** Optional drawdown inputs; omit (→ null) until a read-only engine getter supplies them. */
  currentDrawdownUsd?: number | null;
  equityPeak?: number | null;
  currentEquity?: number | null;
  dataDir?: string;
  nowMs?: number;
}

/** Bind the production accessors into the pure CortexGatherDeps. */
export function buildLiveCortexGatherDeps(input: LiveCortexGatherInputs): CortexGatherDeps {
  const dataDir = input.dataDir ?? "data";
  const nowMs = input.nowMs ?? Date.now();
  // Memoize the composite-estimator report for THIS gather (one deps instance == one tick): the 4 CE
  // bucket lanes would else each rebuild it (a full scan over all CE observations) → 4× the work per tick.
  let ceBucketsCache: CEBucketStatsList | undefined;
  const ceBucketsOnce = (): CEBucketStatsList => {
    if (ceBucketsCache === undefined) {
      try {
        ceBucketsCache = buildCompositeEstimatorReport(getCompositeEstimatorStore(dataDir).all).buckets;
      } catch {
        ceBucketsCache = [];
      }
    }
    return ceBucketsCache;
  };
  return {
    staticWeightPctForLane: (laneId) => input.staticWeightPctForLane(laneId),
    laneReport: (laneId) => liveLaneReport(laneId, dataDir, ceBucketsOnce),
    xsecReport: (laneId) => liveXsecReport(laneId, dataDir, nowMs),
    crowdSidesForLane: () => [], // Phase 1: not sourced → crowdingAlign MISSING (neutral-filled)
    kronosAgreeForLane: () => null, // Phase 1: not sourced → kronosAgree MISSING (neutral-filled)
    edgeMemory: input.edgeMemory,
    controller: input.controller,
    regimeRaw: input.regimeRaw,
    axisScore: input.axisScore,
    axisSlopePerHour: input.axisSlopePerHour,
    killLatched: input.killLatched,
    equityPeak: input.equityPeak ?? null,
    currentEquity: input.currentEquity ?? null,
    currentDrawdownUsd: input.currentDrawdownUsd ?? null,
    killBudgetUsd: input.killBudgetUsd,
    nowMs,
  };
}

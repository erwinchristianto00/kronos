/**
 * /api/live/* — control surface for the live-execution engine (Binance USD-M mirror).
 *
 * The engine is OPTIONAL: when LIVE_EXECUTION_ENABLED!=1 it is never constructed and
 * these routes report { enabled:false } without touching anything. Keys are never
 * echoed by any endpoint.
 */
import type { FastifyInstance } from "fastify";

import type { LiveExecutionEngine } from "../lib/live-execution-engine.js";
import { type CrossSectionalExecutor } from "../lib/cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor } from "../lib/single-symbol-lane-executor.js";
import type { SingleSymbolPriceTimelineService } from "../lib/single-symbol-price-timeline.js";
import { REGIME_AUTOPILOT_PRESETS, type RegimeAutopilot } from "../lib/regime-autopilot.js";
import { getShortFadeStore, buildShortFadeReport, SF_PAPER_LANE_ID } from "../lib/short-fade-edge.js";
import { getIntradayMomentumStore, buildIntradayMomentumReport, IM_PAPER_LANE_ID } from "../lib/intraday-momentum-edge.js";
import { getRegimeCompositeStore, buildRegimeCompositeReport, RC_PAPER_LANE_ID } from "../lib/regime-composite-edge.js";
import { getRegimeCompositeShortStore, buildRegimeCompositeShortReport, RCS_PAPER_LANE_ID } from "../lib/regime-composite-short-edge.js";
import { getPanicWashoutStore, buildPanicWashoutReport, PWR_PAPER_LANE_ID } from "../lib/panic-washout-reclaim-edge.js";
import { getCompositeEstimatorStore, buildCompositeEstimatorReport, ceLaneIdForBucket, type CEBucket } from "../lib/composite-estimator-edge.js";
import { LANE_SELECTOR_V2_LIVE_SUPPORTED_VARIANT_IDS, laneSelectorV2LaneId } from "../lib/lane-selector-v2.js";
import { buildLiveWalletReconciliationReport } from "../lib/wallet-reconciliation.js";
import { sumExternalClosedFeesUsd, sumExternalRealizedPnlUsd } from "../lib/live-executor-wiring.js";
import type { UnifiedTestnetOrchestrator } from "../lib/unified-testnet-orchestrator.js";
import type { UnifiedTestnetProposalStore } from "../lib/unified-testnet-proposal-source.js";

/** 2026-07-10: was named PROFIT_CORE_SHORT_ENABLED (the flag), but the lane id itself only ever
 *  appears inline in realtime-short-mirror.ts (PROFIT_CORE_SHORT_TRAIL_LANE_ID) — not re-exported
 *  from anywhere routes/live.ts already imports, so it's spelled out here to avoid a wider import. */
const PROFIT_CORE_SHORT_TRAIL_LANE_ID = "PROFIT_CORE_SHORT_TRAIL";

/** Canonical choices for the operator allocation selector. Keep this server-owned so newly
 * wired executors do not disappear just because a frontend fallback list was not updated. */
const OPERATOR_ALLOCATION_LANE_IDS = [
  ...LANE_SELECTOR_V2_LIVE_SUPPORTED_VARIANT_IDS.map((variantId) => laneSelectorV2LaneId(variantId)),
  "CROSS_SECTIONAL_MARKET_NEUTRAL",
  "CROSS_SECTIONAL_TREND",
  "CROSS_SECTIONAL_MIXED",
  PROFIT_CORE_SHORT_TRAIL_LANE_ID,
  SF_PAPER_LANE_ID,
  IM_PAPER_LANE_ID,
  RC_PAPER_LANE_ID,
  RCS_PAPER_LANE_ID,
  PWR_PAPER_LANE_ID,
  ...(["WIDE_LONG", "WIDE_SHORT", "FAST_LONG", "FAST_SHORT"] as CEBucket[]).map(ceLaneIdForBucket),
];

type LiveAccountSnapshot = Awaited<ReturnType<LiveExecutionEngine["getAccountSnapshot"]>>;

export function annotateCrossSectionalAccount(
  snapshot: LiveAccountSnapshot,
  executor: CrossSectionalExecutor | null,
): LiveAccountSnapshot {
  if (!executor) return snapshot;
  // 2026-07-08: generalized from the single hardcoded market-neutral lane id so the SAME function
  // annotates any of the (now multiple) executor instances — each instance reports its own laneId
  // via getStatus(), so calling this once per instance (app.ts's registerLiveRoutes wiring) merges
  // all of them into the one account snapshot without duplicating this logic per variant.
  const laneId = executor.getStatus().laneId;

  // Closed baskets: the engine's realized ledger deliberately excludes executor positions (they
  // are external-managed claims, not engine intents), so banked basket P&L must be merged into
  // closedLanes here — otherwise every realized display stays flat while the actual wallet
  // balance moves (2026-07-07 operator: "+1.45 banked, kok realized ga nambah??").
  const closedSummary = executor.getClosedSummary();
  if (closedSummary.closedCount > 0) {
    const existingClosed = snapshot.closedLanes.find((lane) => lane.laneId === laneId);
    if (existingClosed) {
      existingClosed.closedCount += closedSummary.closedCount;
      existingClosed.wins += closedSummary.wins;
      existingClosed.losses += closedSummary.losses;
      existingClosed.realizedPnlUsd += closedSummary.realizedPnlUsd;
      existingClosed.feesUsd += closedSummary.feesUsd;
      existingClosed.symbols = Array.from(new Set([...existingClosed.symbols, ...closedSummary.symbols])).sort();
      if (closedSummary.lastClosedAt && (!existingClosed.lastClosedAt || closedSummary.lastClosedAt > existingClosed.lastClosedAt)) {
        existingClosed.lastClosedAt = closedSummary.lastClosedAt;
      }
    } else {
      snapshot.closedLanes.push({
        laneId,
        closedCount: closedSummary.closedCount,
        wins: closedSummary.wins,
        losses: closedSummary.losses,
        realizedPnlUsd: closedSummary.realizedPnlUsd,
        feesUsd: closedSummary.feesUsd,
        symbols: closedSummary.symbols,
        lastClosedAt: closedSummary.lastClosedAt,
      });
    }
  }

  // ALL open baskets, not just the first — MAX_OPEN_BASKETS can exceed 1 (testnet runs 4), and
  // Binance nets same-symbol legs from different baskets into one account-level position. Only
  // attributing the first basket left every OTHER basket's real exchange positions silently
  // unattributed on the dashboard (2026-07-07: confirmed on testnet — 4 concurrent baskets, only
  // one basket's symbols got tagged, the rest showed "unattributed").
  const openBaskets = executor.getStatus().openBaskets;
  if (openBaskets.length === 0) return snapshot;

  const laneRow = {
    laneId,
    sourceOrderCount: 0,
    symbols: new Set<string>(),
    notionalUsd: 0,
    unrealizedPnl: 0,
  };

  for (const openBasket of openBaskets) {
    for (const leg of openBasket.legs) {
      if (leg.exitOrderId !== null) continue;
      // Match by SYMBOL (not symbol+direction): with a directional intent on the same symbol the
      // NETTED row's direction can differ from the leg's side, and the basket share must still be
      // attributed (2026-07-08 operator: "pisahkan unrealized antara cross sectional dan directional").
      const row = snapshot.positions.find((position) => position.symbol === leg.symbol);
      if (!row) continue;

      const positionQty = Number(row.quantity);
      const share = Number.isFinite(positionQty) && positionQty > 0 ? Math.min(1, leg.qty / positionQty) : 1;
      row.sourceOrderCount += 1;
      if (!row.laneIds.includes(laneId)) {
        row.laneIds.push(laneId);
      }
      // The basket's OWN P&L for this leg, from ITS entry price — never the exchange's blended
      // average entry of the netted position.
      const legDir = leg.side === "LONG" ? 1 : -1;
      const legUnrealized = row.markPrice !== null && leg.entryPrice > 0 ? (row.markPrice - leg.entryPrice) * leg.qty * legDir : null;
      row.basketQty = (row.basketQty ?? 0) + leg.qty * legDir;
      if (legUnrealized !== null) row.basketUnrealizedPnl = (row.basketUnrealizedPnl ?? 0) + legUnrealized;
      laneRow.sourceOrderCount += 1;
      laneRow.symbols.add(row.symbol);
      laneRow.notionalUsd += Math.abs(leg.qty * leg.entryPrice);
      laneRow.unrealizedPnl += legUnrealized ?? row.unrealizedPnl * share;
    }
  }

  if (laneRow.sourceOrderCount > 0) {
    const existing = snapshot.lanes.find((lane) => lane.laneId === laneId);
    if (existing) {
      existing.sourceOrderCount += laneRow.sourceOrderCount;
      existing.symbols = Array.from(new Set([...existing.symbols, ...laneRow.symbols])).sort();
      existing.notionalUsd += laneRow.notionalUsd;
      existing.unrealizedPnl += laneRow.unrealizedPnl;
    } else {
      snapshot.lanes.push({
        laneId,
        sourceOrderCount: laneRow.sourceOrderCount,
        symbols: Array.from(laneRow.symbols).sort(),
        notionalUsd: laneRow.notionalUsd,
        unrealizedPnl: laneRow.unrealizedPnl,
      });
      snapshot.lanes.sort((left, right) => left.laneId.localeCompare(right.laneId));
    }
  }

  return snapshot;
}

type LiveLaneSeriesReport = ReturnType<LiveExecutionEngine["getLanePerformanceSeries"]>;

/** Merge the cross-sectional executor's CLOSED baskets into the lane-performance timeline as
 *  their own lane. Same rationale as annotateCrossSectionalAccount: basket P&L never passes
 *  through engine intents, so without this the timeline shows a flat foundation lane while the
 *  wallet moves. Baskets carry no regime tag (market-neutral by design), so they are merged only
 *  into the unfiltered ("all") view — a regime-filtered view must not include unclassifiable P&L. */
export function mergeCrossSectionalIntoLaneSeries(
  report: LiveLaneSeriesReport,
  executor: CrossSectionalExecutor | null,
): LiveLaneSeriesReport {
  if (!executor || report.regimeFilter !== "all") return report;
  // 2026-07-08: generalized to executor.getStatus().laneId (see annotateCrossSectionalAccount
  // above) so this same function merges any of the (now multiple) executor instances' closed
  // baskets, called once per instance.
  const laneId = executor.getStatus().laneId;
  const sinceMs = new Date(report.since).getTime();
  const untilMs = new Date(report.until).getTime();
  const bucketStartsMs = report.bucketStarts.map((s) => new Date(s).getTime());

  const perBucket = new Map<string, { realizedPnlUsd: number; closedCount: number; wins: number; losses: number }>();
  let realizedPnlUsd = 0;
  let feesUsd = 0;
  let wins = 0;
  let losses = 0;
  let closedCount = 0;
  const symbols = new Set<string>();
  for (const basket of executor.getClosedBaskets()) {
    if (!basket.closedAt || basket.netPnlUsd === null) continue;
    const closedMs = new Date(basket.closedAt).getTime();
    if (!Number.isFinite(closedMs) || closedMs < sinceMs || closedMs >= untilMs) continue;
    // Greatest bucket start <= closedAt (bucket lengths vary across views, e.g. monthly).
    let bucketIdx = -1;
    for (let i = 0; i < bucketStartsMs.length; i += 1) {
      if (bucketStartsMs[i]! <= closedMs) bucketIdx = i;
      else break;
    }
    if (bucketIdx < 0) continue;
    const key = report.bucketStarts[bucketIdx]!;
    const bucket = perBucket.get(key) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
    bucket.realizedPnlUsd += basket.netPnlUsd;
    bucket.closedCount += 1;
    if (basket.netPnlUsd > 0) bucket.wins += 1;
    if (basket.netPnlUsd < 0) bucket.losses += 1;
    perBucket.set(key, bucket);
    realizedPnlUsd += basket.netPnlUsd;
    feesUsd += basket.feeEstimateUsd ?? 0;
    closedCount += 1;
    if (basket.netPnlUsd > 0) wins += 1;
    if (basket.netPnlUsd < 0) losses += 1;
    for (const leg of basket.legs) symbols.add(leg.symbol);
  }
  if (closedCount === 0) return report;

  const existing = report.lanes.find((lane) => lane.laneId === laneId);
  if (existing) {
    // An engine intent tagged with the same lane id would be rare, but merge pointwise instead of
    // pushing a duplicate laneId the chart would render twice.
    existing.realizedPnlUsd += realizedPnlUsd;
    existing.feesUsd += feesUsd;
    existing.closedCount += closedCount;
    existing.wins += wins;
    existing.losses += losses;
    existing.winRatePct = existing.closedCount > 0 ? (existing.wins / existing.closedCount) * 100 : null;
    existing.symbols = Array.from(new Set([...existing.symbols, ...symbols])).sort();
    let cumulative = 0;
    for (const point of existing.points) {
      const add = perBucket.get(point.bucketStart);
      if (add) {
        point.realizedPnlUsd += add.realizedPnlUsd;
        point.closedCount += add.closedCount;
        point.wins += add.wins;
        point.losses += add.losses;
      }
      cumulative += point.realizedPnlUsd;
      point.cumulativePnlUsd = cumulative;
    }
  } else {
    let cumulative = 0;
    const points = report.bucketStarts.map((bucketStart) => {
      const bucket = perBucket.get(bucketStart) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
      cumulative += bucket.realizedPnlUsd;
      return { bucketStart, ...bucket, cumulativePnlUsd: cumulative };
    });
    report.lanes.push({
      laneId,
      realizedPnlUsd,
      feesUsd,
      closedCount,
      wins,
      losses,
      winRatePct: closedCount > 0 ? (wins / closedCount) * 100 : null,
      symbols: Array.from(symbols).sort(),
      regimes: [],
      points,
    });
  }
  report.lanes.sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd));
  return report;
}

export type SingleSymbolLanePositionRow = {
  laneId: string;
  positionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  stopPrice: number;
  markPrice: number | null;
  unrealizedPnl: number | null;
  peakFavorableR: number;
  openedAt: string;
};

/** One row per lane's OWN open position (2026-07-10: operator wants to inspect/close each lane's
 *  position on a symbol independently — two lanes holding the same symbol net into one exchange
 *  position but can have very different track records/protection, e.g. a proven-ish
 *  trailing-protected lane vs an unproven fixed-target lane with none). Unlike
 *  annotateSingleSymbolAccount (which sums across lanes into the netted-position view), this never
 *  aggregates — every open SingleSymbolPosition across every executor gets its own row. */
export function flattenSingleSymbolPositions(
  executors: SingleSymbolLaneExecutor[],
  markBySymbol: Map<string, number>,
): SingleSymbolLanePositionRow[] {
  return executors.flatMap((exec) => {
    const laneId = exec.getStatus().laneId;
    return exec.getStatus().openPositions.map((p) => {
      const markPrice = markBySymbol.get(p.symbol) ?? null;
      const dir = p.direction === "LONG" ? 1 : -1;
      const unrealizedPnl = markPrice !== null ? (markPrice - p.entryPrice) * p.qty * dir : null;
      return {
        laneId,
        positionId: p.positionId,
        symbol: p.symbol,
        direction: p.direction,
        qty: p.qty,
        entryPrice: p.entryPrice,
        stopPrice: p.stopPrice,
        markPrice,
        unrealizedPnl,
        peakFavorableR: p.peakFavorableR,
        openedAt: p.openedAt,
      };
    });
  });
}

type MeasuredLaneStats = { resolvedCount: number; openCount: number; netAvgR: number | null; wr: number | null; pf: number | null; edgeReady: boolean };
type SingleSymbolExecutorStatus = ReturnType<SingleSymbolLaneExecutor["getStatus"]>;
export type LaneEvaluationRow = {
  laneId: string;
  allocationWeightPct: number;
  allowed: boolean | null;
  realOpenCount: number;
  realClosedCount: number;
  realNetPnlUsd: number;
  measuredResolvedCount: number | null;
  measuredOpenCount: number | null;
  measuredNetAvgR: number | null;
  measuredWr: number | null;
  measuredPf: number | null;
  measuredEdgeReady: boolean | null;
};

/** Pulls each lane's OWN paper/shadow report over its OWN store — the exact same numbers
 *  /api/shadow/*-report already show, just gathered in one place for the evaluation panel below. */
export function buildMeasuredLaneStats(): Map<string, MeasuredLaneStats> {
  const byLane = new Map<string, MeasuredLaneStats>();
  const sf = buildShortFadeReport(getShortFadeStore().all);
  byLane.set(SF_PAPER_LANE_ID, { resolvedCount: sf.resolvedCount, openCount: sf.openCount, netAvgR: sf.netAvgR, wr: sf.wr, pf: sf.pf, edgeReady: sf.edgeReady });
  const im = buildIntradayMomentumReport(getIntradayMomentumStore().all);
  byLane.set(IM_PAPER_LANE_ID, { resolvedCount: im.resolvedCount, openCount: im.openCount, netAvgR: im.netAvgR, wr: im.wr, pf: im.pf, edgeReady: im.edgeReady });
  const rc = buildRegimeCompositeReport(getRegimeCompositeStore().all);
  byLane.set(RC_PAPER_LANE_ID, { resolvedCount: rc.resolvedCount, openCount: rc.openCount, netAvgR: rc.netAvgR, wr: rc.wr, pf: rc.pf, edgeReady: rc.edgeReady });
  const rcs = buildRegimeCompositeShortReport(getRegimeCompositeShortStore().all);
  byLane.set(RCS_PAPER_LANE_ID, { resolvedCount: rcs.resolvedCount, openCount: rcs.openCount, netAvgR: rcs.netAvgR, wr: rcs.wr, pf: rcs.pf, edgeReady: rcs.edgeReady });
  const pwr = buildPanicWashoutReport(getPanicWashoutStore().all);
  byLane.set(PWR_PAPER_LANE_ID, { resolvedCount: pwr.resolvedCount, openCount: pwr.openCount, netAvgR: pwr.netAvgR, wr: pwr.wr, pf: pwr.pf, edgeReady: pwr.edgeReady });
  const ce = buildCompositeEstimatorReport(getCompositeEstimatorStore().all);
  for (const bucket of ce.buckets) {
    byLane.set(ceLaneIdForBucket(bucket.bucket as CEBucket), {
      resolvedCount: bucket.resolvedCount,
      openCount: bucket.openCount,
      netAvgR: bucket.netAvgR,
      wr: bucket.wr,
      pf: bucket.pf,
      edgeReady: bucket.edgeReady,
    });
  }
  return byLane;
}

/** Evaluation section for the lanes being validated on testnet (2026-07-10 operator ask): one row
 *  per lane merging (a) the paper/shadow measurement side (buildMeasuredLaneStats above) and (b)
 *  the real testnet-money execution side — openCount/closedCount/netPnlUsd from the
 *  SingleSymbolLaneExecutor's own getStatus(), plus the lane's current allocation weight/allowed
 *  state. PROFIT_CORE_SHORT_TRAIL has no paper/shadow report (it rides the plain paper->live
 *  mirror, not a SingleSymbolLaneExecutor) — its real side comes from the account snapshot's
 *  closedLanes instead, and its measurement fields are null (honestly, not fabricated 0s — there
 *  is no such report to read for it). */
export function buildLaneEvaluationRows(
  execStatuses: SingleSymbolExecutorStatus[],
  measuredByLane: Map<string, MeasuredLaneStats>,
  profitCoreClosedLane: { closedCount: number; realizedPnlUsd: number } | null,
  fallbackWeightPct: (laneId: string) => number,
): LaneEvaluationRow[] {
  const execByLane = new Map(execStatuses.map((s) => [s.laneId, s]));
  const laneIds = [PROFIT_CORE_SHORT_TRAIL_LANE_ID, ...execStatuses.map((s) => s.laneId)];
  return laneIds.map((laneId) => {
    const exec = execByLane.get(laneId) ?? null;
    const measured = measuredByLane.get(laneId) ?? null;
    return {
      laneId,
      allocationWeightPct: exec?.allocationWeightPct ?? fallbackWeightPct(laneId),
      allowed: exec?.allowed ?? null,
      realOpenCount: exec?.openPositions.length ?? 0,
      realClosedCount: exec?.closedCount ?? profitCoreClosedLane?.closedCount ?? 0,
      realNetPnlUsd: exec?.totalNetPnlUsd ?? profitCoreClosedLane?.realizedPnlUsd ?? 0,
      measuredResolvedCount: measured?.resolvedCount ?? null,
      measuredOpenCount: measured?.openCount ?? null,
      measuredNetAvgR: measured?.netAvgR ?? null,
      measuredWr: measured?.wr ?? null,
      measuredPf: measured?.pf ?? null,
      measuredEdgeReady: measured?.edgeReady ?? null,
    };
  });
}

/** Single-symbol-executor analog of annotateCrossSectionalAccount above — same rationale (a
 *  position opened by SHORT_FADE_EXHAUSTION/INTRADAY_MOMENTUM_BREAKOUT is NOT an engine intent, so
 *  without this its real fill would show up as an "unattributed" exchange position and its banked
 *  P&L would never move the account snapshot's realized figures). Simpler than the basket version:
 *  one leg per position, no multi-basket accumulation needed. */
export function annotateSingleSymbolAccount(
  snapshot: LiveAccountSnapshot,
  executor: SingleSymbolLaneExecutor | null,
): LiveAccountSnapshot {
  if (!executor) return snapshot;
  const status = executor.getStatus();
  const laneId = status.laneId;

  const closedSummary = executor.getClosedSummary();
  if (closedSummary.closedCount > 0) {
    const existingClosed = snapshot.closedLanes.find((lane) => lane.laneId === laneId);
    if (existingClosed) {
      existingClosed.closedCount += closedSummary.closedCount;
      existingClosed.wins += closedSummary.wins;
      existingClosed.losses += closedSummary.losses;
      existingClosed.realizedPnlUsd += closedSummary.realizedPnlUsd;
      existingClosed.feesUsd += closedSummary.feesUsd;
      existingClosed.symbols = Array.from(new Set([...existingClosed.symbols, ...closedSummary.symbols])).sort();
      if (closedSummary.lastClosedAt && (!existingClosed.lastClosedAt || closedSummary.lastClosedAt > existingClosed.lastClosedAt)) {
        existingClosed.lastClosedAt = closedSummary.lastClosedAt;
      }
    } else {
      snapshot.closedLanes.push({
        laneId,
        closedCount: closedSummary.closedCount,
        wins: closedSummary.wins,
        losses: closedSummary.losses,
        realizedPnlUsd: closedSummary.realizedPnlUsd,
        feesUsd: closedSummary.feesUsd,
        symbols: closedSummary.symbols,
        lastClosedAt: closedSummary.lastClosedAt,
      });
    }
  }

  const openPositions = status.openPositions;
  if (openPositions.length === 0) return snapshot;

  const laneRow = { laneId, sourceOrderCount: 0, symbols: new Set<string>(), notionalUsd: 0, unrealizedPnl: 0 };
  for (const pos of openPositions) {
    const row = snapshot.positions.find((position) => position.symbol === pos.symbol);
    if (!row) continue;
    const positionQty = Number(row.quantity);
    const share = Number.isFinite(positionQty) && positionQty > 0 ? Math.min(1, pos.qty / positionQty) : 1;
    row.sourceOrderCount += 1;
    if (!row.laneIds.includes(laneId)) row.laneIds.push(laneId);
    const dir = pos.direction === "LONG" ? 1 : -1;
    const legUnrealized = row.markPrice !== null && pos.entryPrice > 0 ? (row.markPrice - pos.entryPrice) * pos.qty * dir : null;
    row.basketQty = (row.basketQty ?? 0) + pos.qty * dir;
    if (legUnrealized !== null) row.basketUnrealizedPnl = (row.basketUnrealizedPnl ?? 0) + legUnrealized;
    // Real exchange-side protective stop — NOT an engine TP1, never conflate with targetTpPrice
    // (2026-07-09 audit finding: the dashboard was rendering this book type's TP columns as if it
    // were a basket, with no way to show the stop it's ACTUALLY protected by).
    row.singleSymbolStopPrice = pos.stopPrice;
    laneRow.sourceOrderCount += 1;
    laneRow.symbols.add(row.symbol);
    laneRow.notionalUsd += Math.abs(pos.qty * pos.entryPrice);
    laneRow.unrealizedPnl += legUnrealized ?? row.unrealizedPnl * share;
  }

  if (laneRow.sourceOrderCount > 0) {
    const existing = snapshot.lanes.find((lane) => lane.laneId === laneId);
    if (existing) {
      existing.sourceOrderCount += laneRow.sourceOrderCount;
      existing.symbols = Array.from(new Set([...existing.symbols, ...laneRow.symbols])).sort();
      existing.notionalUsd += laneRow.notionalUsd;
      existing.unrealizedPnl += laneRow.unrealizedPnl;
    } else {
      snapshot.lanes.push({
        laneId,
        sourceOrderCount: laneRow.sourceOrderCount,
        symbols: Array.from(laneRow.symbols).sort(),
        notionalUsd: laneRow.notionalUsd,
        unrealizedPnl: laneRow.unrealizedPnl,
      });
      snapshot.lanes.sort((left, right) => left.laneId.localeCompare(right.laneId));
    }
  }
  return snapshot;
}

/** Single-symbol-executor analog of mergeCrossSectionalIntoLaneSeries above. */
export function mergeSingleSymbolIntoLaneSeries(
  report: LiveLaneSeriesReport,
  executor: SingleSymbolLaneExecutor | null,
): LiveLaneSeriesReport {
  if (!executor || report.regimeFilter !== "all") return report;
  const laneId = executor.getStatus().laneId;
  const sinceMs = new Date(report.since).getTime();
  const untilMs = new Date(report.until).getTime();
  const bucketStartsMs = report.bucketStarts.map((s) => new Date(s).getTime());

  const perBucket = new Map<string, { realizedPnlUsd: number; closedCount: number; wins: number; losses: number }>();
  let realizedPnlUsd = 0;
  let feesUsd = 0;
  let wins = 0;
  let losses = 0;
  let closedCount = 0;
  const symbols = new Set<string>();
  for (const pos of executor.getClosedPositions()) {
    if (!pos.closedAt || pos.netPnlUsd === null) continue;
    const closedMs = new Date(pos.closedAt).getTime();
    if (!Number.isFinite(closedMs) || closedMs < sinceMs || closedMs >= untilMs) continue;
    let bucketIdx = -1;
    for (let i = 0; i < bucketStartsMs.length; i += 1) {
      if (bucketStartsMs[i]! <= closedMs) bucketIdx = i;
      else break;
    }
    if (bucketIdx < 0) continue;
    const key = report.bucketStarts[bucketIdx]!;
    const bucket = perBucket.get(key) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
    bucket.realizedPnlUsd += pos.netPnlUsd;
    bucket.closedCount += 1;
    if (pos.netPnlUsd > 0) bucket.wins += 1;
    if (pos.netPnlUsd < 0) bucket.losses += 1;
    perBucket.set(key, bucket);
    realizedPnlUsd += pos.netPnlUsd;
    feesUsd += pos.feeEstimateUsd ?? 0;
    closedCount += 1;
    if (pos.netPnlUsd > 0) wins += 1;
    if (pos.netPnlUsd < 0) losses += 1;
    symbols.add(pos.symbol);
  }
  if (closedCount === 0) return report;

  const existing = report.lanes.find((lane) => lane.laneId === laneId);
  if (existing) {
    existing.realizedPnlUsd += realizedPnlUsd;
    existing.feesUsd += feesUsd;
    existing.closedCount += closedCount;
    existing.wins += wins;
    existing.losses += losses;
    existing.winRatePct = existing.closedCount > 0 ? (existing.wins / existing.closedCount) * 100 : null;
    existing.symbols = Array.from(new Set([...existing.symbols, ...symbols])).sort();
    let cumulative = 0;
    for (const point of existing.points) {
      const add = perBucket.get(point.bucketStart);
      if (add) {
        point.realizedPnlUsd += add.realizedPnlUsd;
        point.closedCount += add.closedCount;
        point.wins += add.wins;
        point.losses += add.losses;
      }
      cumulative += point.realizedPnlUsd;
      point.cumulativePnlUsd = cumulative;
    }
  } else {
    let cumulative = 0;
    const points = report.bucketStarts.map((bucketStart) => {
      const bucket = perBucket.get(bucketStart) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
      cumulative += bucket.realizedPnlUsd;
      return { bucketStart, ...bucket, cumulativePnlUsd: cumulative };
    });
    report.lanes.push({
      laneId,
      realizedPnlUsd,
      feesUsd,
      closedCount,
      wins,
      losses,
      winRatePct: closedCount > 0 ? (wins / closedCount) * 100 : null,
      symbols: Array.from(symbols).sort(),
      regimes: [],
      points,
    });
  }
  report.lanes.sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd));
  return report;
}

export async function registerLiveRoutes(
  app: FastifyInstance,
  engine: LiveExecutionEngine | null,
  opts: {
    configErrors?: string[];
    crossSectionalExecutor?: () => CrossSectionalExecutor | null;
    // 2026-07-08: two more instances (TREND_BETA_VOL / MIXED_MEAN_REVERSION), wired alongside the
    // original FILTERED foundation instance above. Optional/independent — either can be absent
    // (e.g. disabled, or an older deploy) without affecting the other's routes.
    crossSectionalTrendExecutor?: () => CrossSectionalExecutor | null;
    crossSectionalMixedExecutor?: () => CrossSectionalExecutor | null;
    // 2026-07-08: SHORT_FADE_EXHAUSTION / INTRADAY_MOMENTUM_BREAKOUT single-symbol executors.
    // Same optional/independent contract as the cross-sectional getters above.
    shortFadeExecutor?: () => SingleSymbolLaneExecutor | null;
    intradayMomentumExecutor?: () => SingleSymbolLaneExecutor | null;
    // 2026-07-09: REGIME_COMPOSITE_CONFIRMATION_LONG. Same optional/independent contract.
    regimeCompositeExecutor?: () => SingleSymbolLaneExecutor | null;
    regimeCompositeShortExecutor?: () => SingleSymbolLaneExecutor | null;
    // 2026-07-09: COMPOSITE_ESTIMATOR_BIDI's 4 buckets. Same optional/independent contract.
    compositeEstimatorWideLongExecutor?: () => SingleSymbolLaneExecutor | null;
    compositeEstimatorWideShortExecutor?: () => SingleSymbolLaneExecutor | null;
    compositeEstimatorFastLongExecutor?: () => SingleSymbolLaneExecutor | null;
    compositeEstimatorFastShortExecutor?: () => SingleSymbolLaneExecutor | null;
    panicWashoutExecutor?: () => SingleSymbolLaneExecutor | null;
    regimeAutopilot?: () => RegimeAutopilot | null;
    unifiedOrchestrator?: () => UnifiedTestnetOrchestrator | null;
    unifiedProposalStore?: () => UnifiedTestnetProposalStore | null;
    singleSymbolPriceTimeline?: () => SingleSymbolPriceTimelineService | null;
  } = {},
): Promise<void> {
  const allCrossSectionalExecutors = () =>
    [opts.crossSectionalExecutor?.() ?? null, opts.crossSectionalTrendExecutor?.() ?? null, opts.crossSectionalMixedExecutor?.() ?? null].filter(
      (exec): exec is CrossSectionalExecutor => exec !== null,
    );
  const allSingleSymbolExecutors = () =>
    [
      opts.shortFadeExecutor?.() ?? null,
      opts.intradayMomentumExecutor?.() ?? null,
      opts.regimeCompositeExecutor?.() ?? null,
      opts.regimeCompositeShortExecutor?.() ?? null,
      opts.compositeEstimatorWideLongExecutor?.() ?? null,
      opts.compositeEstimatorWideShortExecutor?.() ?? null,
      opts.compositeEstimatorFastLongExecutor?.() ?? null,
      opts.compositeEstimatorFastShortExecutor?.() ?? null,
      opts.panicWashoutExecutor?.() ?? null,
    ].filter((exec): exec is SingleSymbolLaneExecutor => exec !== null);
  app.get("/api/live/status", async () => {
    if (!engine) {
      return {
        enabled: false,
        configErrors: opts.configErrors ?? [],
        reason:
          opts.configErrors && opts.configErrors.length > 0
            ? `live execution enabled but misconfigured: ${opts.configErrors.join("; ")}`
            : "live execution disabled (set LIVE_EXECUTION_ENABLED=1 + LIVE_BINANCE_* env to enable)",
      };
    }
    return {
      ...engine.getStatus(),
      unifiedOrchestrator: opts.unifiedOrchestrator?.()?.getStatus() ?? null,
      unifiedProposalSource: opts.unifiedProposalStore?.()?.getStatus() ?? null,
    };
  });

  app.get("/api/live/allocation-lanes", async () => ({
    lanes: Array.from(new Set(OPERATOR_ALLOCATION_LANE_IDS)).sort(),
  }));

  // Shared BTC/ETH/SOL price timeline for the operator and the optional single-symbol execution
  // overlay. The service uses public candles only; no account or order action happens on GET.
  app.get("/api/live/single-symbol-timeline", async (_request, reply) => {
    const timeline = opts.singleSymbolPriceTimeline?.() ?? null;
    if (!timeline) {
      reply.code(503);
      return { enabled: false, reason: "single-symbol timeline unavailable because live market runtime is disabled" };
    }
    return { enabled: true, ...(await timeline.getSnapshot()) };
  });

  app.post("/api/live/arm", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "ARM") {
      reply.code(400);
      return { ok: false, reason: 'arming requires body {"confirm":"ARM"}' };
    }
    const result = await engine.arm();
    if (!result.ok) reply.code(409);
    return { ...result, armed: engine.isArmed() };
  });

  app.post("/api/live/disarm", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    engine.disarm("manual disarm via /api/live/disarm");
    return { ok: true, armed: engine.isArmed() };
  });

  // Drain NEW entries without disabling reconciliation, protective exits, TP/SL, or policy closes.
  // This is deliberately separate from disarm: the engine can remain armed as an exit manager.
  app.post("/api/live/new-entry-drain", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { enabled?: unknown; confirm?: unknown; reason?: unknown };
    if (typeof body.enabled !== "boolean" || body.confirm !== "DRAIN") {
      reply.code(400);
      return { ok: false, reason: 'body must be {"enabled":true|false,"confirm":"DRAIN","reason":"optional"}' };
    }
    return {
      ok: true,
      ...engine.setNewEntriesPaused(
        body.enabled,
        typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "operator request",
      ),
      armed: engine.isArmed(),
    };
  });

  // RECEIVER (runs on the MAINNET instance): open an exact copy of a testnet
  // position. Requires {"confirm":"COPY"} and the engine to be ARMED. The stop/TP
  // geometry is preserved relative to entry; the protective stop is placed before
  // the intent is considered OPEN (same machinery as the normal mirror).
  app.post("/api/live/copy-intent", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as {
      confirm?: string;
      symbol?: string;
      direction?: "LONG" | "SHORT";
      qty?: number;
      entryPrice?: number;
      stopLossPrice?: number;
      tp1Price?: number;
      exitRule?: string | null;
      sourceLaneId?: string | null;
      sourcePaperOrderId?: string | null;
      sourceEnv?: string | null;
    };
    if (body.confirm !== "COPY") {
      reply.code(400);
      return { ok: false, reason: 'copy requires body {"confirm":"COPY", ...spec} — this opens a REAL position' };
    }
    if (
      typeof body.symbol !== "string" ||
      (body.direction !== "LONG" && body.direction !== "SHORT") ||
      typeof body.qty !== "number" ||
      typeof body.entryPrice !== "number" ||
      typeof body.stopLossPrice !== "number" ||
      typeof body.tp1Price !== "number"
    ) {
      reply.code(400);
      return { ok: false, reason: "spec requires symbol, direction, qty, entryPrice, stopLossPrice, tp1Price" };
    }
    const result = await engine.copyExternalIntent({
      symbol: body.symbol,
      direction: body.direction,
      qty: body.qty,
      entryPrice: body.entryPrice,
      stopLossPrice: body.stopLossPrice,
      tp1Price: body.tp1Price,
      exitRule: (body.exitRule ?? null) as never,
      sourceLaneId: body.sourceLaneId ?? null,
      sourcePaperOrderId: body.sourcePaperOrderId ?? null,
      sourceEnv: body.sourceEnv ?? null,
    });
    if (!result.ok) reply.code(409);
    return result;
  });

  // RELAY (runs on the TESTNET instance): the dashboard's per-position "copy to
  // live" button. Looks up the OPEN testnet intent and forwards its exact spec to
  // the mainnet instance (LIVE_COPY_TARGET_URL, default the local 3103 process).
  app.post("/api/live/copy-to-live", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { paperOrderId?: string };
    if (typeof body.paperOrderId !== "string" || body.paperOrderId.length === 0) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"paperOrderId":"<open intent id>"}' };
    }
    const lookup = engine.getOpenIntentCopySpec(body.paperOrderId);
    if (!lookup.ok || !lookup.spec) {
      reply.code(lookup.reason?.startsWith("no intent") ? 404 : 409);
      return { ok: false, reason: lookup.reason };
    }
    const target = process.env.LIVE_COPY_TARGET_URL ?? "http://127.0.0.1:3103";
    const spec = { confirm: "COPY", ...lookup.spec, sourceEnv: "testnet" };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`${target}/api/live/copy-intent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spec),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const payload = (await response.json()) as { ok?: boolean; reason?: string };
      if (!response.ok || payload.ok === false) {
        reply.code(response.status === 200 ? 409 : response.status);
        return { ok: false, reason: payload.reason ?? `live copy failed (${response.status})`, spec };
      }
      return { ok: true, spec, live: payload };
    } catch (error) {
      reply.code(502);
      return { ok: false, reason: `live instance unreachable: ${(error as Error).message}`, spec };
    }
  });

  // Operator lane selection for the live mirror. Body:
  //   {"lanes": null}                          → all lanes allowed (default)
  //   {"lanes": []}                            → pause every new mirror
  //   {"lanes": ["CG_WIDE_FAST_SHORT", ...]}   → only these lanes may open new positions
  // Ids match a paper order's selectedLaneId as the full id or its variant suffix.
  // Affects NEW entries only — existing open positions keep managing/closing normally.
  app.post("/api/live/lanes", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { lanes?: unknown; confirm?: string };
    // 2026-07-12 fix: this mutates which lanes may open new real positions, with no confirmation
    // phrase — unlike every other state-changing action in this file. No known frontend caller
    // currently exists (superseded by /api/live/lane-allocations), so this closes the gap safely.
    if (body.confirm !== "SET_LANES") {
      reply.code(400);
      return { ok: false, reason: 'setting the lane allow-list requires body {"confirm":"SET_LANES"}' };
    }
    if (body.lanes !== null && !Array.isArray(body.lanes)) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"lanes": null | string[], "confirm":"SET_LANES"}' };
    }
    const result = engine.setAllowedLanes(
      body.lanes === null ? null : (body.lanes as unknown[]).map((v) => String(v)),
    );
    return { ok: true, ...result };
  });

  // Operator close of ONE open directional intent — the dashboard's per-position "Close" button
  // (2026-07-07: full manual control, bank early when the regime turns). Flattens only the
  // engine's own share of the netted position; basket legs on the same symbol stay open.
  app.post("/api/live/close-intent", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { paperOrderId?: string; confirm?: string };
    if (body.confirm !== "CLOSE") {
      reply.code(400);
      return { ok: false, reason: 'closing requires body {"confirm":"CLOSE","paperOrderId":"…"} — this places a REAL market order' };
    }
    if (typeof body.paperOrderId !== "string" || body.paperOrderId.length === 0) {
      reply.code(400);
      return { ok: false, reason: "paperOrderId required" };
    }
    const result = await engine.manualCloseIntent(body.paperOrderId);
    if (!result.ok) reply.code(409);
    return result;
  });

  // Flat per-lane-position list for the "Single-symbol executor — stop-protected" panel
  // (2026-07-10: operator wants to see and close each lane's OWN position on a symbol separately —
  // two lanes independently holding the same symbol net into one exchange position, but they can
  // have very different track records/risk profiles, e.g. a proven-ish trailing-protected lane vs
  // an unproven fixed-target lane with zero interim protection). One entry per open
  // SingleSymbolPosition, tagged with its owning laneId, merged with the current markPrice from the
  // account snapshot (never a second, possibly-stale price source).
  app.get("/api/live/single-symbol/positions", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      const snapshot = await engine.getAccountSnapshot();
      const markBySymbol = new Map(
        snapshot.positions.filter((p) => p.markPrice !== null).map((p) => [p.symbol, p.markPrice as number]),
      );
      const rows = flattenSingleSymbolPositions(allSingleSymbolExecutors(), markBySymbol);
      return { ok: true, positions: rows };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "single-symbol positions fetch failed" };
    }
  });

  app.get("/api/live/lane-evaluation", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      const snapshot = await engine.getAccountSnapshot();
      const execStatuses = allSingleSymbolExecutors().map((exec) => exec.getStatus());
      const measuredByLane = buildMeasuredLaneStats();
      const rows = buildLaneEvaluationRows(
        execStatuses,
        measuredByLane,
        snapshot.closedLanes.find((l) => l.laneId === PROFIT_CORE_SHORT_TRAIL_LANE_ID) ?? null,
        (laneId) => engine.laneSelectionWeightPctForLane(laneId),
      );
      return { ok: true, lanes: rows };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "lane evaluation fetch failed" };
    }
  });

  // Operator close of single-symbol-lane-executor position(s) — the "Single-symbol executor —
  // stop-protected" panel's per-row "Close now" button (2026-07-10, urgent operator ask). Body
  // {"positionId":"…","confirm":"CLOSE"} closes ONE specific lane's position — the operator asked
  // for this after noticing two lanes on the same symbol can have very different track
  // records/protection. Body {"symbol":"…","confirm":"CLOSE"} (legacy, still supported) closes ALL
  // open positions for that symbol across every single-symbol-lane-executor instance (SHORT_FADE_
  // EXHAUSTION_CROWDED, INTRADAY_MOMENTUM_BREAKOUT_LONG, REGIME_COMPOSITE_CONFIRMATION_LONG,
  // COMPOSITE_ESTIMATOR_BIDI_* x4, PANIC_WASHOUT_RECLAIM_LONG) — a symbol row is the SUM across
  // however many of these lanes independently hold that symbol (Binance nets same-symbol positions
  // per account). Either path reuses manualClosePosition()'s exact same reduceOnly-with-fallback
  // path the exit policy uses, sized to ONLY that lane's own tracked qty — never touches basket legs
  // or directional-intent qty on the same symbol from other books.
  app.post("/api/live/single-symbol/close", async (request, reply) => {
    // 2026-07-12 fix: the only mutating route in this file that never checked this — every
    // SingleSymbolLaneExecutor instance is constructed inside the SAME liveConfig.enabled guard as
    // `engine` itself (they share the same liveClient), so engine === null means these are ALL null
    // too. Without this check the route fell through to a less clear 404/"no open positions"
    // response instead of the consistent {enabled:false} contract every other route follows.
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { symbol?: string; positionId?: string; confirm?: string };
    if (body.confirm !== "CLOSE") {
      reply.code(400);
      return { ok: false, reason: 'closing requires body {"confirm":"CLOSE","positionId":"…"} or {"confirm":"CLOSE","symbol":"…"} — this places a REAL market order' };
    }
    if (typeof body.positionId === "string" && body.positionId.length > 0) {
      const owner = allSingleSymbolExecutors().find((exec) =>
        exec.getStatus().openPositions.some((p) => p.positionId === body.positionId),
      );
      if (!owner) {
        reply.code(404);
        return { ok: false, reason: `no open single-symbol-executor position ${body.positionId}` };
      }
      const result = await owner.manualClosePosition(body.positionId);
      if (!result.ok) reply.code(409);
      return result;
    }
    if (typeof body.symbol !== "string" || body.symbol.length === 0) {
      reply.code(400);
      return { ok: false, reason: "positionId or symbol required" };
    }
    const matches = allSingleSymbolExecutors().flatMap((exec) =>
      exec.getStatus().openPositions
        .filter((p) => p.symbol === body.symbol)
        .map((p) => ({ exec, positionId: p.positionId })),
    );
    if (matches.length === 0) {
      reply.code(404);
      return { ok: false, reason: `no open single-symbol-executor position for ${body.symbol}` };
    }
    const results: Array<{ ok: boolean; reason: string | null; netPnlUsd: number | null }> = [];
    for (const { exec, positionId } of matches) {
      results.push(await exec.manualClosePosition(positionId));
    }
    const anyFailed = results.some((r) => !r.ok);
    if (anyFailed) reply.code(409);
    return {
      ok: !anyFailed,
      reason: anyFailed ? (results.find((r) => !r.ok)?.reason ?? "one or more closes failed") : null,
      closedCount: results.filter((r) => r.ok).length,
      netPnlUsd: results.reduce((sum, r) => sum + (r.netPnlUsd ?? 0), 0),
      results,
    };
  });

  // Cross-sectional executor status (testnet-first basket execution of the measured lane).
  app.get("/api/live/cross-sectional-executor", async () => {
    const executor = opts.crossSectionalExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    // 2026-07-12 (profitability Stage 3): attach the report-only regime-skew counterfactual so the
    // operator can see whether CROSS_SECTIONAL_REGIME_SKEW's same-direction tilt is being rewarded.
    return { ...executor.getStatus(), regimeSkewCounterfactual: executor.getRegimeSkewCounterfactual() };
  });

  // 2026-07-08: sibling status endpoints for the two additional variant-targeted instances (same
  // shape as the FILTERED endpoint above, just a different underlying executor).
  app.get("/api/live/cross-sectional-executor-trend", async () => {
    const executor = opts.crossSectionalTrendExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "TREND_BETA_VOL executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/cross-sectional-executor-mixed", async () => {
    const executor = opts.crossSectionalMixedExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "MIXED_MEAN_REVERSION executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });

  // 2026-07-08: single-symbol executor status (SHORT_FADE_EXHAUSTION / INTRADAY_MOMENTUM_BREAKOUT).
  app.get("/api/live/short-fade-executor", async () => {
    const executor = opts.shortFadeExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "SHORT_FADE_EXHAUSTION executor disabled (set SHORT_FADE_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/intraday-momentum-executor", async () => {
    const executor = opts.intradayMomentumExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "INTRADAY_MOMENTUM_BREAKOUT executor disabled (set INTRADAY_MOMENTUM_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  // 2026-07-09: REGIME_COMPOSITE_CONFIRMATION_LONG executor status.
  app.get("/api/live/regime-composite-executor", async () => {
    const executor = opts.regimeCompositeExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "REGIME_COMPOSITE_CONFIRMATION_LONG executor disabled (set REGIME_COMPOSITE_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/regime-composite-short-executor", async () => {
    const executor = opts.regimeCompositeShortExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "REGIME_COMPOSITE_CONFIRMATION_SHORT executor disabled (set REGIME_COMPOSITE_SHORT_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/panic-washout-executor", async () => {
    const executor = opts.panicWashoutExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "PANIC_WASHOUT_RECLAIM_LONG executor disabled (set PANIC_WASHOUT_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  // 2026-07-09: COMPOSITE_ESTIMATOR_BIDI executor status, one per bucket.
  const compositeEstimatorBucketRoutes: Array<[string, () => SingleSymbolLaneExecutor | null]> = [
    ["wide-long", () => opts.compositeEstimatorWideLongExecutor?.() ?? null],
    ["wide-short", () => opts.compositeEstimatorWideShortExecutor?.() ?? null],
    ["fast-long", () => opts.compositeEstimatorFastLongExecutor?.() ?? null],
    ["fast-short", () => opts.compositeEstimatorFastShortExecutor?.() ?? null],
  ];
  for (const [slug, getExecutor] of compositeEstimatorBucketRoutes) {
    app.get(`/api/live/composite-estimator-${slug}-executor`, async () => {
      const executor = getExecutor();
      if (!executor) {
        return { enabled: false, reason: `COMPOSITE_ESTIMATOR_BIDI ${slug} executor disabled (set COMPOSITE_ESTIMATOR_EXEC_ENABLED=1 + live execution env)` };
      }
      return executor.getStatus();
    });
  }

  // Regime auto-pilot status (Tier 1: auto-syncs allocation to detected regime, anti-whipsaw).
  app.get("/api/live/autopilot", async () => {
    const pilot = opts.regimeAutopilot?.() ?? null;
    if (!pilot) {
      return { enabled: false, reason: "auto-pilot disabled (set REGIME_AUTOPILOT_ENABLED=1 + REGIME_ENGINE_ENABLED=1)" };
    }
    return pilot.getStatus();
  });

  // 2026-07-09 fix: the "Regime Engine → Lane Tree" dashboard panel used to hardcode its own COPY
  // of REGIME_AUTOPILOT_PRESETS (apps/web's REGIME_TREE constant) so the "Apply preset" buttons
  // could prefill the allocation form — a real incident: editing the backend preset (removing
  // CG_WIDE_FAST_SHORT after it was proven a real-money loss driver) left the dashboard's copy
  // stale, so the button still showed/would-have-applied the OLD (cut) lane. Serving the actual
  // constant here (pure static data, no pilot instance needed) lets the frontend render the TRUE
  // current preset and eliminates the possibility of the two ever drifting apart again.
  app.get("/api/live/regime-presets", async () => REGIME_AUTOPILOT_PRESETS);

  // WEIGHTED lane allocation (manual intervention: e.g. lane1 70% / lane2 30%).
  // Takes precedence over /api/live/lanes while set. Body:
  //   {"allocations": null}   → off (back to allow-list / all lanes)
  //   {"allocations": [{"laneId":"CG_WIDE_FAST_SHORT","weightPct":70},
  //                    {"laneId":"CG_WIDE_FAST_LONG","weightPct":30}]}
  // Only listed lanes may open NEW positions; each entry's size is scaled by weightPct.
  // Operator toggle: RAW selector mode (bypass the 2b book overlay + regime direction-gate; trade
  // exactly the lane allocation selector). OFF = the current "smart" behavior. Hard safety rails
  // (kill-switch, cluster cap, risk size) are never affected.
  app.post("/api/live/manual-mode", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { enabled?: unknown; confirm?: string };
    // 2026-07-12 fix: this toggles the RAW selector bypass affecting real-money entries, with no
    // confirmation phrase — unlike every other state-changing action in this file.
    if (body.confirm !== "SET_MANUAL_MODE") {
      reply.code(400);
      return { ok: false, reason: 'toggling manual mode requires body {"enabled": true|false, "confirm":"SET_MANUAL_MODE"}' };
    }
    if (typeof body.enabled !== "boolean") {
      reply.code(400);
      return { ok: false, reason: 'body must be {"enabled": true | false, "confirm":"SET_MANUAL_MODE"}' };
    }
    return engine.setManualSelectorMode(body.enabled);
  });

  // Directional manual allocation: the long list is active only when the current scanner Entry
  // Decision says LONG, and the short list only when it says SHORT. This does not place an order by
  // itself; a fresh lane signal with valid stop/TP geometry is still required by the mirror.
  app.post("/api/live/manual-directional-allocations", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as {
      allocations?: unknown;
      confirm?: string;
    };
    if (body.confirm !== "SET_MANUAL_DIRECTIONAL_ALLOCATIONS") {
      reply.code(400);
      return { ok: false, reason: 'setting manual directional allocations requires confirm="SET_MANUAL_DIRECTIONAL_ALLOCATIONS"' };
    }
    if (body.allocations !== null && (typeof body.allocations !== "object" || Array.isArray(body.allocations))) {
      reply.code(400);
      return { ok: false, reason: 'allocations must be null or {long:[{laneId,weightPct}],short:[{laneId,weightPct}]}' };
    }
    const raw = body.allocations as { long?: unknown; short?: unknown } | null;
    if (raw !== null && (!Array.isArray(raw?.long) || !Array.isArray(raw?.short))) {
      reply.code(400);
      return { ok: false, reason: 'allocations.long and allocations.short must both be arrays' };
    }
    const toRows = (rows: unknown[]) => rows.map((row) => {
      const value = row && typeof row === "object" ? row as { laneId?: unknown; weightPct?: unknown } : {};
      return { laneId: String(value.laneId ?? ""), weightPct: Number(value.weightPct) };
    });
    const result = engine.setManualDirectionalLaneAllocations(raw === null ? null : {
      long: toRows(Array.isArray(raw.long) ? raw.long : []),
      short: toRows(Array.isArray(raw.short) ? raw.short : []),
    });
    if (!result.ok) reply.code(400);
    return result;
  });

  app.post("/api/live/lane-allocations", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { allocations?: unknown; confirm?: string };
    // 2026-07-12 fix: this mutates which lanes may open new real positions and at what size, with
    // no confirmation phrase — unlike every other state-changing action in this file.
    if (body.confirm !== "SET_ALLOCATIONS") {
      reply.code(400);
      return { ok: false, reason: 'setting lane allocations requires body {"allocations": …, "confirm":"SET_ALLOCATIONS"}' };
    }
    if (body.allocations !== null && !Array.isArray(body.allocations)) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"allocations": null | [{laneId, weightPct}], "confirm":"SET_ALLOCATIONS"}' };
    }
    // 2026-07-09: operator-explicit path — sets laneAllocationOperatorLock when applying a real
    // allocation so RegimeAutopilot's next tick can't silently revert it (see
    // setLaneAllocationsAsOperator's doc comment for the incident this closes; 2026-07-12 fix:
    // this comment previously named the wrong flag, manualSelectorMode — that was the ORIGINAL
    // mechanism before the 2026-07-09 lane-allocation-lock/raw-bypass conflation fix split it into
    // this dedicated field). Distinct from applyRegimeAutopilotAllocation, which is autopilot's OWN
    // apply path and clears the flag instead.
    const result = engine.setLaneAllocationsAsOperator(
      body.allocations === null
        ? null
        : (body.allocations as Array<{ laneId?: unknown; weightPct?: unknown }>).map((a) => ({
            laneId: String(a.laneId ?? ""),
            weightPct: Number(a.weightPct),
          })),
    );
    if (!result.ok) reply.code(400);
    return result;
  });

  app.post("/api/live/kill", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string; reason?: string };
    if (body.confirm !== "KILL") {
      reply.code(400);
      return { ok: false, reason: 'kill requires body {"confirm":"KILL"} — cancels ALL orders and FLATTENS all engine positions' };
    }
    await engine.kill(body.reason ?? "operator kill");
    return { ok: true, armed: engine.isArmed(), status: engine.getStatus() };
  });

  app.post("/api/live/flatten-exchange", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string; reason?: string };
    if (body.confirm !== "FLATTEN_BINANCE_ALL") {
      reply.code(400);
      return {
        ok: false,
        reason:
          'exchange flatten requires body {"confirm":"FLATTEN_BINANCE_ALL"} — cancels ALL visible Binance USD-M orders and MARKET reduce-only closes ALL exchange positions',
      };
    }
    const result = await engine.flattenAllExchangePositions(body.reason ?? "operator exchange flatten");
    if (!result.ok) reply.code(502);
    return { ...result, armed: engine.isArmed(), status: engine.getStatus() };
  });

  app.get("/api/live/balance", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      const balance = await engine.getUsdtBalance();
      if (!balance) return { ok: true, walletBalance: null, availableBalance: null };
      return { ok: true, ...balance };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "balance fetch failed" };
    }
  });

  app.get("/api/live/account", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      let snapshot = await engine.getAccountSnapshot();
      for (const executor of allCrossSectionalExecutors()) {
        snapshot = annotateCrossSectionalAccount(snapshot, executor);
      }
      for (const executor of allSingleSymbolExecutors()) {
        snapshot = annotateSingleSymbolAccount(snapshot, executor);
      }
      // 2026-07-11: the dashboard's headline "Realized P&L (today/all-time)" summed only the
      // mirror ledger (status.totalRealizedPnlUsd) and the 3 cross-sectional lane ids — every
      // SingleSymbolLaneExecutor's real realized P&L (already correctly folded into closedLanes
      // above via annotateSingleSymbolAccount, just never summed for the headline) was invisible
      // there. Operator caught this live: a real +$1.39 BTC close via REGIME_COMPOSITE_CONFIRMATION_LONG
      // didn't move "all-time" at all. Expose the aggregate directly so the frontend doesn't have to
      // guess/hardcode lane ids that drift every time a new single-symbol lane is wired.
      // (Single-symbol only, deliberately — cross-sectional's own "baskets" total is a SEPARATE
      // frontend calc over the 3 CrossSectionalExecutor lane ids, so passing [] here avoids double-
      // counting; sumExternalRealizedPnlUsd is also reused as-is by the kill-switch and wallet-
      // reconciliation, which DO want the combined cross-sectional+single-symbol total.)
      const singleSymbolExecutorRealizedPnlUsd = sumExternalRealizedPnlUsd([], allSingleSymbolExecutors());
      return { ok: true, ...snapshot, singleSymbolExecutorRealizedPnlUsd };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "account snapshot failed" };
    }
  });

  // Report-only: compares the engine's internal daily realized-P&L ledger against Binance's own
  // /fapi/v1/income for the same UTC day. See wallet-reconciliation.ts's module doc for the full
  // safety rationale — this endpoint only reads and reports; it never corrects anything.
  app.get("/api/live/wallet-reconciliation", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const query = (request.query ?? {}) as { day?: string };
    try {
      const external = sumExternalRealizedPnlUsd(allCrossSectionalExecutors(), allSingleSymbolExecutors());
      const dayUtc = query.day ?? new Date().toISOString().slice(0, 10);
      const closedFees = engine.getClosedTodayFeesUsd() +
        sumExternalClosedFeesUsd(allCrossSectionalExecutors(), allSingleSymbolExecutors(), dayUtc);
      const report = await buildLiveWalletReconciliationReport(engine, query.day, undefined, external.today, closedFees);
      return { ok: true, report };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "wallet reconciliation failed" };
    }
  });

  app.get("/api/live/lane-performance-series", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const query = (request.query ?? {}) as { view?: string; period?: string; anchor?: string; regime?: string };
    try {
      let series = engine.getLanePerformanceSeries({
        view: query.view,
        period: query.period,
        anchor: query.anchor,
        regime: query.regime,
      });
      for (const executor of allCrossSectionalExecutors()) {
        series = mergeCrossSectionalIntoLaneSeries(series, executor);
      }
      for (const executor of allSingleSymbolExecutors()) {
        series = mergeSingleSymbolIntoLaneSeries(series, executor);
      }
      return { ok: true, ...series };
    } catch (err) {
      reply.code(500);
      return { ok: false, reason: err instanceof Error ? err.message : "lane performance series failed" };
    }
  });

  app.post("/api/live/sync-testnet", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    const status = engine.getStatus();
    if (status.env !== "testnet") {
      reply.code(409);
      return { ok: false, reason: "manual mirror sync is testnet-only" };
    }
    if (body.confirm !== "SYNC_TESTNET") {
      reply.code(400);
      return { ok: false, reason: 'sync requires body {"confirm":"SYNC_TESTNET"}' };
    }
    await engine.tick();
    return { ok: true, status: engine.getStatus(), account: await engine.getAccountSnapshot() };
  });

  app.post("/api/live/reset-kill", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "RESET") {
      reply.code(400);
      return { ok: false, reason: 'resetting a latched kill requires body {"confirm":"RESET"}' };
    }
    const result = engine.resetKill();
    if (!result.ok) {
      reply.code(409);
      return { ok: false, reason: result.reason };
    }
    return { ok: true, armed: engine.isArmed() };
  });
}

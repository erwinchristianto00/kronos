import type { Candle } from "@dtc/shared";
import { atr } from "@dtc/shared";
import { contextFromCandles, type FeatureAdapterInput } from "../features/contextFromCandles.js";
import { buildTradingDecision } from "../decision/buildTradingDecision.js";
import { GUARD_THRESHOLDS } from "../constants.js";
import { inRange, passesLaneFloor } from "../lanes/laneKit.js";
import { shortRallyFade } from "../lanes/shortRallyFade.js";
import { breakdownRetestShort } from "../lanes/breakdownRetestShort.js";
import { microMeanReversion } from "../lanes/microMeanReversion.js";
import { pullbackLongScalp } from "../lanes/pullbackLongScalp.js";
import { breakoutRetestLong } from "../lanes/breakoutRetestLong.js";
import { relativeStrengthLong } from "../lanes/relativeStrengthLong.js";
import {
  rejectStrategy,
  runBacktest,
  runBacktestCostScenarios,
  walkForwardBacktest,
  type BacktestBar,
  type BacktestCostScenarioName,
  type BacktestMetrics,
  type RejectionResult,
} from "../backtest/backtestRunner.js";
import type {
  BreadthUniverseKind,
  DecisionTrace,
  FeatureSource,
  FeatureSourceMap,
  LaneId,
  LiquiditySource,
  LiquidityTier,
  MarketContext,
  Regime,
  TradingDecision,
} from "../types.js";

export type ValidationTimeframe = "15m" | "1h" | "4h" | "1d";
export type FundingSourceSummary = "SUPPLIED" | "ASSUMED_BASELINE" | "UNAVAILABLE";
export type LiquiditySourceSummary = LiquiditySource | "UNAVAILABLE";
export type BreadthSourceSummary = "SUPPLIED" | "UNAVAILABLE";

export interface HistoricalCandleSet {
  m15?: Candle[];
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

export interface ValidationMicrostructureOptions {
  spreadBps?: number;
  slippageBps?: number;
  liquidityGood?: boolean;
  liquidityTier?: LiquidityTier;
  liquiditySource?: LiquiditySource;
  quoteVolumeUsd24h?: number;
  orderbookDepthUsd?: number;
  fundingRiskAbnormal?: boolean;
  assumeFundingBaseline?: boolean;
}

export interface HistoricalValidationInput {
  symbol: string;
  candles: HistoricalCandleSet;
  breadth?: FeatureAdapterInput["breadth"];
  microstructure?: ValidationMicrostructureOptions;
  startMs?: number;
  endMs?: number;
  startingEquity?: number;
  decisionEveryBars?: number;
  walkForwardFolds?: number;
}

export interface TimeframeCoverage {
  timeframe: ValidationTimeframe;
  startDate: string | null;
  endDate: string | null;
  candleCount: number;
  missingCandleCount: number;
}

export interface DataCoverageReport {
  symbol: string;
  timeframeCoverage: TimeframeCoverage[];
  startDate: string | null;
  endDate: string | null;
  candleCount: number;
  missingCandleCount: number;
  closedCandleFilterCount: number;
  staleDataRejectionCount: number;
}

export interface FeatureProvenanceReport {
  fundingSource: FundingSourceSummary;
  liquiditySource: LiquiditySourceSummary;
  breadthSource: BreadthSourceSummary;
  breadthUniverseKind: BreadthUniverseKind | "UNAVAILABLE";
  breadthSurvivorshipBiasNote: string;
  featureSourcesSummary: Record<string, Record<string, number>>;
}

export interface DecisionDistributionReport {
  totalDecisions: number;
  totalTrades: number;
  coverageDays: number;
  tradesPerDay: number;
  bearishChoppyDays: number;
  bearishChoppyTradesPerDay: number;
  noTradeRatio: number;
  decisionCountByRegime: Partial<Record<Regime, number>>;
  decisionCountByLane: Record<string, number>;
  rejectedByCounts: Record<string, number>;
  missingExecutionDataCount: number;
  contradictionCount: number;
  staleContextCount: number;
}

export interface NoTradeDiagnosticsReport {
  noTradeRatio: number;
  noTradeCountByReason: Record<string, number>;
  rejectedByCounts: Record<string, number>;
  missingExecutionDataCount: number;
  missingFundingRiskAbnormalCount: number;
  liquidityTooThinCount: number;
  contradictionCount: number;
  staleContextCount: number;
  noValidLaneSetupCount: number;
}

export interface TradeLedgerEntry {
  tradeId: string;
  symbol: string;
  entryTime: string;
  exitTime: string;
  holdingMinutes: number;
  regime: Regime;
  lane: LaneId;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  netPnl: number;
  feeCost: number;
  spreadCost: number;
  slippageCost: number;
  fundingCost: number;
  fundingAssumption: string | null;
  exitReason: string;
  takeProfitATR: number;
  stopLossATR: number;
  atrAtEntry: number;
  featureSourcesUsedByEntryDecision?: FeatureSourceMap;
  rejectedByBeforeEntry?: string | null;
}

export interface LaneOpportunityDiagnostics {
  timesPreconditionsAlmostPassed: number;
  mostCommonBlockingCondition: string | null;
  blockingConditionCounts: Record<string, number>;
  entryCount: number;
  winCount: number;
  lossCount: number;
  grossProfitFactor: number;
  netProfitFactor: number;
  averageNetPnl: number;
  averageHoldingMinutes: number;
}

export interface ScenarioPerformanceReport {
  totalReturn: number;
  profitFactor: number;
  maxDrawdown: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  averageTradeDurationMinutes: number;
  feeImpact: number;
  spreadImpact: number;
  slippageImpact: number;
  fundingImpact: number;
  fundingAssumptionNote: string | null;
}

export interface StrategyRejectionReport {
  byScenario: Record<BacktestCostScenarioName, RejectionResult>;
  baseline: RejectionResult;
  exactRejectionReasons: string[];
  pessimisticProfitFactorAbove1_2: boolean;
  performanceDisappearsAfterSlippage: boolean;
  bearishChoppyTradeCountTooHigh: boolean;
  drawdownAcceptable: boolean;
}

export interface HistoricalValidationReport {
  generatedAt: string;
  validationOnly: true;
  dataCoverage: DataCoverageReport;
  featureProvenance: FeatureProvenanceReport;
  decisionDistribution: DecisionDistributionReport;
  tradingPerformance: Record<BacktestCostScenarioName, ScenarioPerformanceReport>;
  tradeLedger: TradeLedgerEntry[];
  noTradeDiagnostics: NoTradeDiagnosticsReport;
  laneOpportunityDiagnostics: Record<string, LaneOpportunityDiagnostics>;
  strategyRejection: StrategyRejectionReport;
  walkForward: {
    folds: number;
    profitableFolds: number;
    singlePeriodDependence: boolean;
  };
}

const TF_MS: Record<ValidationTimeframe, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const ALL_LANES = [
  shortRallyFade,
  breakdownRetestShort,
  microMeanReversion,
  pullbackLongScalp,
  breakoutRetestLong,
  relativeStrengthLong,
];

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sortCandles(candles: Candle[]): Candle[] {
  return [...candles].sort((a, b) => a.openTime - b.openTime);
}

function closeTime(candle: Candle, timeframe: ValidationTimeframe): number {
  return candle.openTime + TF_MS[timeframe];
}

function candlesClosedBy(candles: Candle[], timeframe: ValidationTimeframe, asOf: number): Candle[] {
  return candles.filter((candle) => closeTime(candle, timeframe) <= asOf);
}

function countMissingCandles(candles: Candle[], timeframe: ValidationTimeframe): number {
  if (candles.length < 2) return 0;
  const sorted = sortCandles(candles);
  let missing = 0;
  const step = TF_MS[timeframe];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i]!.openTime - sorted[i - 1]!.openTime;
    if (gap > step) missing += Math.max(0, Math.round(gap / step) - 1);
  }
  return missing;
}

function coverage(candles: Candle[], timeframe: ValidationTimeframe): TimeframeCoverage {
  const sorted = sortCandles(candles);
  const first = sorted.at(0);
  const last = sorted.at(-1);
  return {
    timeframe,
    startDate: iso(first?.openTime),
    endDate: iso(last ? closeTime(last, timeframe) : undefined),
    candleCount: sorted.length,
    missingCandleCount: countMissingCandles(sorted, timeframe),
  };
}

function addCount(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

function dayKey(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

function daysBetween(startMs: number, endMs: number): number {
  return Math.max(0, (endMs - startMs) / 86_400_000);
}

function profitFactor(wins: number, losses: number): number {
  const grossLoss = Math.abs(losses);
  if (grossLoss > 0) return wins / grossLoss;
  return wins > 0 ? Infinity : 0;
}

function sourceKey(source: FeatureSource): string {
  return source;
}

function mergeFeatureSources(
  summary: Record<string, Record<string, number>>,
  trace: DecisionTrace | undefined,
): void {
  const sources = trace?.featureSources ?? {};
  for (const [feature, values] of Object.entries(sources)) {
    const bucket = (summary[feature] ??= {});
    for (const value of values ?? []) addCount(bucket, sourceKey(value));
  }
}

function firstFundingSource(contexts: MarketContext[]): FundingSourceSummary {
  for (const ctx of contexts) {
    const source = ctx.featureSources?.fundingRiskAbnormal?.[0];
    if (source === "ASSUMED_BASELINE") return "ASSUMED_BASELINE";
    if (source === "SUPPLIED") return "SUPPLIED";
  }
  return "UNAVAILABLE";
}

function firstLiquiditySource(contexts: MarketContext[]): LiquiditySourceSummary {
  for (const ctx of contexts) {
    if (ctx.liquiditySource) return ctx.liquiditySource;
  }
  return "UNAVAILABLE";
}

function breadthBiasNote(input: HistoricalValidationInput): string {
  const kind = input.breadth?.universeKind;
  if (kind === "POINT_IN_TIME") return "Breadth uses a point-in-time universe snapshot.";
  if (kind === "CURRENT_HIGH_LIQUIDITY_MAJORS") {
    return "Breadth uses current high-liquidity majors only; results are not representative of the full historical crypto market.";
  }
  return "Breadth unavailable; breadth-dependent flags remain undefined and no breadth edge is validated.";
}

function defaultMicrostructure(symbol: string, bar: Candle, input?: ValidationMicrostructureOptions): FeatureAdapterInput["microstructure"] {
  const quoteVolumeUsd24h = input?.quoteVolumeUsd24h ?? bar.volume * bar.close * 24;
  const isMajor = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(symbol.toUpperCase());
  return {
    spreadBps: input?.spreadBps ?? 2,
    slippageBps: input?.slippageBps ?? 2,
    liquidityGood: input?.liquidityGood,
    liquidityTier: input?.liquidityTier ?? (isMajor ? "MAJOR" : "ALT"),
    liquiditySource: input?.liquiditySource,
    quoteVolumeUsd24h,
    orderbookDepthUsd: input?.orderbookDepthUsd,
    fundingRiskAbnormal: input?.fundingRiskAbnormal,
    assumeFundingBaseline: input?.assumeFundingBaseline ?? input?.fundingRiskAbnormal === undefined,
  };
}

function performanceReport(metrics: BacktestMetrics, fundingSource: FundingSourceSummary): ScenarioPerformanceReport {
  return {
    totalReturn: metrics.totalReturn,
    profitFactor: metrics.profitFactor,
    maxDrawdown: metrics.maxDrawdown,
    winRate: metrics.winRate,
    averageWin: metrics.avgWin,
    averageLoss: metrics.avgLoss,
    averageTradeDurationMinutes: metrics.avgTradeDurationMinutes,
    feeImpact: metrics.feeImpact,
    spreadImpact: metrics.spreadImpact,
    slippageImpact: metrics.slippageImpact,
    fundingImpact: metrics.fundingImpact,
    fundingAssumptionNote:
      fundingSource === "ASSUMED_BASELINE"
        ? "fundingRiskAbnormal=false is an assumed baseline; scenario funding drag is still charged by the cost model."
        : fundingSource === "UNAVAILABLE"
          ? "funding unavailable; missing execution-data gate should prevent trades."
          : null,
  };
}

type LaneCondition = { name: string; pass: boolean };

function laneConditions(laneId: LaneId, ctx: MarketContext): LaneCondition[] {
  const laneFloor = { name: "lane_floor", pass: passesLaneFloor(ctx) };
  switch (laneId) {
    case "SHORT_RALLY_FADE":
      return [
        { name: "regime_bearish_choppy", pass: ctx.regime === "BEARISH_CHOPPY_DEFENSIVE" },
        { name: "btc_below_key_resistance", pass: ctx.btcBelowKeyResistance === true },
        { name: "pullback_to_vwap_or_ema20", pass: ctx.pricePullbackToVWAPOrEMA20 === true },
        { name: "rsi1h_in_short_fade_range", pass: inRange(ctx.rsi1h, GUARD_THRESHOLDS.shortFadeRsiLow, GUARD_THRESHOLDS.shortFadeRsiHigh) },
        { name: "rejection_candle", pass: ctx.rejectionCandle === true },
        { name: "weak_bounce_volume", pass: ctx.volumeWeakOnBounce === true },
        { name: "market_breadth_weak", pass: ctx.marketBreadthWeak === true },
        laneFloor,
      ];
    case "BREAKDOWN_RETEST_SHORT":
      return [
        { name: "regime_bearish_or_bear_trend", pass: ctx.regime === "BEARISH_CHOPPY_DEFENSIVE" || ctx.regime === "BEAR_TREND" },
        { name: "support_broken", pass: ctx.supportBroken === true },
        { name: "close_below_support", pass: ctx.closeBelowSupport === true },
        { name: "retest_old_support", pass: ctx.retestOldSupport === true },
        { name: "retest_failed", pass: ctx.retestFailed === true },
        { name: "btc_still_weak", pass: ctx.btcStillWeak === true },
        laneFloor,
      ];
    case "MICRO_MEAN_REVERSION":
      return [
        { name: "regime_bearish_choppy", pass: ctx.regime === "BEARISH_CHOPPY_DEFENSIVE" },
        { name: "price_near_lower_range", pass: ctx.priceNearLowerRange === true },
        { name: "rsi_short_tf_below_max", pass: typeof ctx.rsiShortTf === "number" && ctx.rsiShortTf < GUARD_THRESHOLDS.microReversionRsiMax },
        { name: "liquidation_flush_detected", pass: ctx.liquidationFlushDetected === true },
        { name: "btc_not_breaking_major_support", pass: ctx.btcNotBreakingMajorSupport === true },
        laneFloor,
      ];
    case "PULLBACK_LONG_SCALP":
      return [
        { name: "regime_neutral_recovery", pass: ctx.regime === "NEUTRAL_RECOVERY" },
        { name: "btc_4h_above_62000", pass: ctx.btcClose4hAbove62000 === true },
        { name: "pullback_to_support", pass: ctx.pullbackToSupport === true },
        { name: "support_holds", pass: ctx.supportHolds === true },
        { name: "volume_not_dead", pass: ctx.volumeNotDead === true },
        { name: "market_breadth_positive", pass: ctx.marketBreadthPositive === true },
        laneFloor,
      ];
    case "BREAKOUT_RETEST_LONG":
      return [
        { name: "regime_recovery", pass: ctx.regime === "NEUTRAL_RECOVERY" || ctx.regime === "TREND_RECOVERY" },
        { name: "resistance_broken", pass: ctx.resistanceBroken === true },
        { name: "retest_resistance_as_support", pass: ctx.retestResistanceAsSupport === true },
        { name: "higher_low_formed", pass: ctx.higherLowFormed === true },
        { name: "market_breadth_positive", pass: ctx.marketBreadthPositive === true },
        { name: "volume_expansion", pass: ctx.volumeExpansion === true },
        laneFloor,
      ];
    case "RELATIVE_STRENGTH_LONG":
      return [
        { name: "regime_neutral_recovery", pass: ctx.regime === "NEUTRAL_RECOVERY" },
        { name: "btc_stable_above_support", pass: ctx.btcStableAboveSupport === true },
        { name: "coin_outperforms_btc", pass: ctx.coinOutperformsBTC === true },
        { name: "coin_above_vwap", pass: ctx.coinAboveVWAP === true },
        { name: "volume_expansion", pass: ctx.volumeExpansion === true },
        { name: "liquidity_good", pass: ctx.liquidityGood === true },
        laneFloor,
      ];
    default:
      return [];
  }
}

function emptyLaneDiagnostics(): Record<string, LaneOpportunityDiagnostics> {
  return Object.fromEntries(
    ALL_LANES.map((lane) => [
      lane.id,
      {
        timesPreconditionsAlmostPassed: 0,
        mostCommonBlockingCondition: null,
        blockingConditionCounts: {},
        entryCount: 0,
        winCount: 0,
        lossCount: 0,
        grossProfitFactor: 0,
        netProfitFactor: 0,
        averageNetPnl: 0,
        averageHoldingMinutes: 0,
      },
    ]),
  );
}

function finalizeLaneDiagnostics(
  diagnostics: Record<string, LaneOpportunityDiagnostics>,
  metrics: BacktestMetrics,
): Record<string, LaneOpportunityDiagnostics> {
  for (const lane of ALL_LANES) {
    const key = lane.id;
    const d = diagnostics[key]!;
    const trades = metrics.trades.filter((trade) => trade.lane === lane.id);
    const grossWins = trades.filter((trade) => trade.grossPnl > 0).reduce((sum, trade) => sum + trade.grossPnl, 0);
    const grossLosses = trades.filter((trade) => trade.grossPnl <= 0).reduce((sum, trade) => sum + trade.grossPnl, 0);
    const netWins = trades.filter((trade) => trade.netPnl > 0).reduce((sum, trade) => sum + trade.netPnl, 0);
    const netLosses = trades.filter((trade) => trade.netPnl <= 0).reduce((sum, trade) => sum + trade.netPnl, 0);
    const sortedBlocks = Object.entries(d.blockingConditionCounts).sort((a, b) => b[1] - a[1]);

    d.entryCount = trades.length;
    d.winCount = trades.filter((trade) => trade.netPnl > 0).length;
    d.lossCount = trades.filter((trade) => trade.netPnl <= 0).length;
    d.grossProfitFactor = profitFactor(grossWins, grossLosses);
    d.netProfitFactor = profitFactor(netWins, netLosses);
    d.averageNetPnl = trades.length ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length : 0;
    d.averageHoldingMinutes = trades.length ? trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / trades.length : 0;
    d.mostCommonBlockingCondition = sortedBlocks[0]?.[0] ?? null;
  }
  return diagnostics;
}

function buildTradeLedger(
  symbol: string,
  metrics: BacktestMetrics,
  fundingSource: FundingSourceSummary,
  rejectedByBeforeEntry: Map<number, string | null>,
): TradeLedgerEntry[] {
  return metrics.trades.map((trade, index) => ({
    tradeId: `${symbol}-${index + 1}-${trade.entryTs}`,
    symbol,
    entryTime: new Date(trade.entryTs).toISOString(),
    exitTime: new Date(trade.exitTs).toISOString(),
    holdingMinutes: trade.holdMinutes,
    regime: trade.regime,
    lane: trade.lane,
    side: trade.action === "ENTER_LONG" ? "LONG" : "SHORT",
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    grossPnl: trade.grossPnl,
    netPnl: trade.netPnl,
    feeCost: trade.fees,
    spreadCost: trade.spreadCost,
    slippageCost: trade.slippageCost,
    fundingCost: trade.fundingCost,
    fundingAssumption:
      fundingSource === "ASSUMED_BASELINE"
        ? "fundingRiskAbnormal=false assumed baseline; cost model still applies funding drag"
        : null,
    exitReason: trade.exitReason,
    takeProfitATR: trade.takeProfitATR,
    stopLossATR: trade.stopLossATR,
    atrAtEntry: trade.atrAtEntry,
    featureSourcesUsedByEntryDecision: trade.featureSources,
    rejectedByBeforeEntry: rejectedByBeforeEntry.get(trade.entryTs) ?? null,
  }));
}

export function buildHistoricalValidationReport(input: HistoricalValidationInput): HistoricalValidationReport {
  const candles = {
    m15: sortCandles(input.candles.m15 ?? []),
    h1: sortCandles(input.candles.h1),
    h4: sortCandles(input.candles.h4),
    d1: sortCandles(input.candles.d1),
  };
  const startMs = input.startMs ?? candles.h1.at(0)?.openTime ?? 0;
  const endMs = input.endMs ?? (candles.h1.at(-1) ? closeTime(candles.h1.at(-1)!, "1h") : 0);
  const decisionEveryBars = Math.max(1, input.decisionEveryBars ?? 1);
  const startingEquity = input.startingEquity ?? 10_000;

  const bars: BacktestBar[] = [];
  const contexts: MarketContext[] = [];
  const decisionCountByRegime: Partial<Record<Regime, number>> = {};
  const decisionCountByLane: Record<string, number> = {};
  const rejectedByCounts: Record<string, number> = {};
  const noTradeCountByReason: Record<string, number> = {};
  const bearishChoppyDayKeys = new Set<number>();
  const rejectedByBeforeEntry = new Map<number, string | null>();
  const laneDiagnostics = emptyLaneDiagnostics();
  const featureSourcesSummary: Record<string, Record<string, number>> = {};
  let lastRejectedBy: string | null = null;
  let closedCandleFilterCount = 0;
  let contradictionCount = 0;
  let staleContextCount = 0;
  let missingExecutionDataCount = 0;
  let missingFundingRiskAbnormalCount = 0;
  let liquidityTooThinCount = 0;
  let noValidLaneSetupCount = 0;

  for (let i = 0; i < candles.h1.length; i += decisionEveryBars) {
    const bar = candles.h1[i]!;
    const asOf = closeTime(bar, "1h");
    if (asOf < startMs || asOf > endMs) continue;

    const btc = {
      m15: candlesClosedBy(candles.m15, "15m", asOf),
      h1: candlesClosedBy(candles.h1, "1h", asOf),
      h4: candlesClosedBy(candles.h4, "4h", asOf),
      d1: candlesClosedBy(candles.d1, "1d", asOf),
    };
    closedCandleFilterCount +=
      candles.m15.length - btc.m15.length +
      candles.h1.length - btc.h1.length +
      candles.h4.length - btc.h4.length +
      candles.d1.length - btc.d1.length;

    const ctx = contextFromCandles({
      asOf,
      btc,
      breadth: input.breadth,
      microstructure: defaultMicrostructure(input.symbol, bar, input.microstructure),
      governance: {
        dailyLossPct: 0,
        consecutiveLosses: 0,
        openPositions: 0,
        tradesToday: 0,
      },
    });
    contexts.push(ctx);

    const decision = buildTradingDecision(ctx);
    addCount(decisionCountByRegime as Record<string, number>, decision.regime);
    addCount(decisionCountByLane, decision.action === "NO_TRADE" ? "NO_TRADE" : decision.lane);
    if (decision.regime === "BEARISH_CHOPPY_DEFENSIVE") bearishChoppyDayKeys.add(dayKey(asOf));
    if (ctx.liquidityTooThin === true) liquidityTooThinCount += 1;
    if (decision.trace?.rejectedBy) addCount(rejectedByCounts, decision.trace.rejectedBy);
    if (decision.trace?.rejectedBy === "MISSING_EXECUTION_DATA") missingExecutionDataCount += 1;
    if (decision.trace?.noTradeReason?.some((reason) => reason.includes("MISSING_FUNDING_RISK_ABNORMAL"))) {
      missingFundingRiskAbnormalCount += 1;
    }
    if ((decision.trace?.contradictions.length ?? 0) > 0) contradictionCount += 1;
    if (decision.trace?.rejectedBy === "DATA_STALE") staleContextCount += 1;
    if (decision.trace?.rejectedBy === "NO_VALID_LANE_SETUP") noValidLaneSetupCount += 1;
    if (decision.action === "NO_TRADE") {
      const reasons = decision.trace?.noTradeReason ?? ["UNKNOWN_NO_TRADE_REASON"];
      for (const reason of reasons) addCount(noTradeCountByReason, reason);
      if (decision.trace?.rejectedBy) lastRejectedBy = decision.trace.rejectedBy;
    } else {
      rejectedByBeforeEntry.set(asOf, lastRejectedBy);
    }
    const regimeEnrichedCtx = { ...ctx, regime: decision.regime };
    for (const lane of ALL_LANES) {
      const failed = laneConditions(lane.id, regimeEnrichedCtx).filter((condition) => !condition.pass).map((condition) => condition.name);
      if (failed.length === 1) laneDiagnostics[lane.id]!.timesPreconditionsAlmostPassed += 1;
      for (const reason of failed) addCount(laneDiagnostics[lane.id]!.blockingConditionCounts, reason);
    }
    mergeFeatureSources(featureSourcesSummary, decision.trace);

    const atrValue = atr(btc.h1, 14);
    bars.push({
      timestamp: asOf,
      ctx,
      price: bar.close,
      high: bar.high,
      low: bar.low,
      atr: atrValue,
    });
  }

  const baseMetrics = runBacktest({ bars, startingEquity });
  const scenarios = runBacktestCostScenarios({ bars, startingEquity });
  const wf = walkForwardBacktest({ bars, startingEquity }, input.walkForwardFolds ?? 4);
  const fundingSource = firstFundingSource(contexts);
  const coverageDays = daysBetween(startMs, endMs);
  const bearishChoppyDays = bearishChoppyDayKeys.size;
  const rejectionCriteria = { chopDays: Math.max(1, bearishChoppyDays) };
  const rejectionByScenario = {
    optimistic: rejectStrategy(scenarios.optimistic, rejectionCriteria),
    base: rejectStrategy(scenarios.base, rejectionCriteria),
    pessimistic: rejectStrategy(scenarios.pessimistic, rejectionCriteria),
  };
  const baselineRejection = rejectStrategy(baseMetrics, rejectionCriteria);
  const pessimisticReasons = rejectionByScenario.pessimistic.reasons;
  const baselineChopTrades = baseMetrics.trades.filter((trade) => trade.regime === "BEARISH_CHOPPY_DEFENSIVE").length;

  return {
    generatedAt: new Date().toISOString(),
    validationOnly: true,
    dataCoverage: {
      symbol: input.symbol,
      timeframeCoverage: [
        coverage(candles.m15, "15m"),
        coverage(candles.h1, "1h"),
        coverage(candles.h4, "4h"),
        coverage(candles.d1, "1d"),
      ],
      startDate: iso(startMs),
      endDate: iso(endMs),
      candleCount: candles.m15.length + candles.h1.length + candles.h4.length + candles.d1.length,
      missingCandleCount:
        countMissingCandles(candles.m15, "15m") +
        countMissingCandles(candles.h1, "1h") +
        countMissingCandles(candles.h4, "4h") +
        countMissingCandles(candles.d1, "1d"),
      closedCandleFilterCount,
      staleDataRejectionCount: staleContextCount,
    },
    featureProvenance: {
      fundingSource,
      liquiditySource: firstLiquiditySource(contexts),
      breadthSource: input.breadth ? "SUPPLIED" : "UNAVAILABLE",
      breadthUniverseKind: input.breadth?.universeKind ?? "UNAVAILABLE",
      breadthSurvivorshipBiasNote: breadthBiasNote(input),
      featureSourcesSummary,
    },
    decisionDistribution: {
      totalDecisions: bars.length,
      totalTrades: baseMetrics.numTrades,
      coverageDays,
      tradesPerDay: coverageDays > 0 ? baseMetrics.numTrades / coverageDays : 0,
      bearishChoppyDays,
      bearishChoppyTradesPerDay: bearishChoppyDays > 0 ? baselineChopTrades / bearishChoppyDays : 0,
      noTradeRatio: bars.length > 0 ? (decisionCountByLane.NO_TRADE ?? 0) / bars.length : 0,
      decisionCountByRegime,
      decisionCountByLane,
      rejectedByCounts,
      missingExecutionDataCount,
      contradictionCount,
      staleContextCount,
    },
    tradingPerformance: {
      optimistic: performanceReport(scenarios.optimistic, fundingSource),
      base: performanceReport(scenarios.base, fundingSource),
      pessimistic: performanceReport(scenarios.pessimistic, fundingSource),
    },
    tradeLedger: buildTradeLedger(input.symbol, scenarios.base, fundingSource, rejectedByBeforeEntry),
    noTradeDiagnostics: {
      noTradeRatio: bars.length > 0 ? (decisionCountByLane.NO_TRADE ?? 0) / bars.length : 0,
      noTradeCountByReason,
      rejectedByCounts,
      missingExecutionDataCount,
      missingFundingRiskAbnormalCount,
      liquidityTooThinCount,
      contradictionCount,
      staleContextCount,
      noValidLaneSetupCount,
    },
    laneOpportunityDiagnostics: finalizeLaneDiagnostics(laneDiagnostics, scenarios.base),
    strategyRejection: {
      byScenario: rejectionByScenario,
      baseline: baselineRejection,
      exactRejectionReasons: baselineRejection.reasons,
      pessimisticProfitFactorAbove1_2: scenarios.pessimistic.profitFactor >= 1.2,
      performanceDisappearsAfterSlippage: pessimisticReasons.includes("PROFIT_DISAPPEARS_AFTER_SLIPPAGE"),
      bearishChoppyTradeCountTooHigh: baselineRejection.reasons.some((reason) => reason.startsWith("OVERTRADING_IN_CHOP")),
      drawdownAcceptable: scenarios.pessimistic.maxDrawdown <= 0.15,
    },
    walkForward: {
      folds: wf.folds.length,
      profitableFolds: wf.profitableFolds,
      singlePeriodDependence: wf.singlePeriodDependence,
    },
  };
}

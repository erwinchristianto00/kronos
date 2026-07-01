import type { Candle } from "@dtc/shared";
import { atr } from "@dtc/shared";
import { contextFromCandles, type FeatureAdapterInput } from "../features/contextFromCandles.js";
import { buildTradingDecision } from "../decision/buildTradingDecision.js";
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
  LiquiditySource,
  LiquidityTier,
  MarketContext,
  Regime,
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
  noTradeRatio: number;
  decisionCountByRegime: Partial<Record<Regime, number>>;
  decisionCountByLane: Record<string, number>;
  rejectedByCounts: Record<string, number>;
  missingExecutionDataCount: number;
  contradictionCount: number;
  staleContextCount: number;
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
  const featureSourcesSummary: Record<string, Record<string, number>> = {};
  let closedCandleFilterCount = 0;
  let contradictionCount = 0;
  let staleContextCount = 0;
  let missingExecutionDataCount = 0;

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
    if (decision.trace?.rejectedBy) addCount(rejectedByCounts, decision.trace.rejectedBy);
    if (decision.trace?.rejectedBy === "MISSING_EXECUTION_DATA") missingExecutionDataCount += 1;
    if ((decision.trace?.contradictions.length ?? 0) > 0) contradictionCount += 1;
    if (decision.trace?.rejectedBy === "DATA_STALE") staleContextCount += 1;
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
  const rejectionByScenario = {
    optimistic: rejectStrategy(scenarios.optimistic),
    base: rejectStrategy(scenarios.base),
    pessimistic: rejectStrategy(scenarios.pessimistic),
  };
  const baselineRejection = rejectStrategy(baseMetrics);
  const pessimisticReasons = rejectionByScenario.pessimistic.reasons;

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
    strategyRejection: {
      byScenario: rejectionByScenario,
      baseline: baselineRejection,
      exactRejectionReasons: baselineRejection.reasons,
      pessimisticProfitFactorAbove1_2: scenarios.pessimistic.profitFactor >= 1.2,
      performanceDisappearsAfterSlippage: pessimisticReasons.includes("PROFIT_DISAPPEARS_AFTER_SLIPPAGE"),
      bearishChoppyTradeCountTooHigh: pessimisticReasons.some((reason) => reason.startsWith("OVERTRADING_IN_CHOP")),
      drawdownAcceptable: scenarios.pessimistic.maxDrawdown <= 0.15,
    },
    walkForward: {
      folds: wf.folds.length,
      profitableFolds: wf.profitableFolds,
      singlePeriodDependence: wf.singlePeriodDependence,
    },
  };
}

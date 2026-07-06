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
  BreakevenStopMode,
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
  breadthByTimestamp?: Map<number, FeatureAdapterInput["breadth"]>;
  breadthUnavailableCount?: number;
  breadthMetricsSample?: Record<string, unknown>;
  breadthUniverseSymbols?: string[];
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

export interface BreadthDiagnosticsReport {
  source: BreadthSourceSummary;
  universeKind: BreadthUniverseKind | "UNAVAILABLE";
  universeSymbols: string[];
  unavailableDecisionCount: number;
  survivorshipBiasWarning: string;
  metricsSample?: Record<string, unknown>;
}

export interface DecisionDistributionReport {
  totalDecisions: number;
  totalTrades: number;
  enterSignalCount: number;
  actionableEnterSignalCount: number;
  statefulGovernanceSuppressedSignalCount: number;
  closedTradeCount: number;
  skippedBecausePositionOpen: number;
  skippedBecauseCooldown: number;
  skippedBecauseMaxTrades: number;
  skippedBecauseExecutionGuard: number;
  positionManagementDecisionCount: number;
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
  rawBreakevenPrice: number | null;
  netBreakevenPrice: number | null;
  breakevenMode: BreakevenStopMode | null;
  estimatedCostBufferPrice: number | null;
  stopMovedToBreakevenAt: string | null;
  stopMovedToBreakevenReason: string | null;
  grossPnlAtBreakevenStop: number | null;
  netPnlAtBreakevenStop: number | null;
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
  grossProfitFactor: number | null;
  netProfitFactor: number | null;
  averageNetPnl: number;
  averageHoldingMinutes: number;
}

export interface RegimeNoTradeDiagnosticsReport {
  detectorBranchFailureCounts: Partial<Record<Regime, number>>;
  btcBelow60000Count: number;
  btcBelow62000Count: number;
  marketBreadthWeakUnavailableCount: number;
  marketBreadthWeakFalseCount: number;
  missingRecoveryFlagCounts: Record<string, number>;
  bearishChoppyAlmostMatchedButFailedCount: number;
  dayCountByRegime: Partial<Record<Regime, number>>;
}

export interface RegimeDenominatorDiagnostics {
  decisionCount: number;
  dayCount: number;
  tradeCount: number;
  tradesPerDayInRegime: number;
  profitFactor: number | null;
  winRate: number;
  averagePnl: number;
}

export interface CompactCandle {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TradeForensicSummary {
  tradeId: string;
  entryCandleContext: Record<string, unknown>;
  previous3Candles: CompactCandle[];
  next3Candles: CompactCandle[];
  previous3CloseMove: number | null;
  previous3CloseMoveAtr: number | null;
  entryAfterExtendedMove: boolean;
  stopHitBy: "WICK" | "CLOSE" | null;
  mfe: number;
  mfeAtr: number;
  mae: number;
  maeAtr: number;
  netPnlAfterCosts: {
    gross: number;
    afterFees: number;
    afterSpread: number;
    afterSlippage: number;
    afterFunding: number;
  };
  featureSourcesUsed: FeatureSourceMap | undefined;
  heuristicFlagsInvolved: string[];
}

export interface PnlMathAuditReport {
  grossPnlFormula: {
    long: string;
    short: string;
  };
  stopPriceFormula: {
    longStopLoss: string;
    shortStopLoss: string;
    longTakeProfit: string;
    shortTakeProfit: string;
  };
  stopLossAtrAppliedToRealStopPrice: boolean;
  shortPnlSignConvention: string;
  slExitGrossPnlCheck: {
    slTradeCount: number;
    negativeGrossSlCount: number;
    zeroGrossSlCount: number;
    positiveGrossSlCount: number;
    zeroGrossSlTradeIds: string[];
    explanation: string | null;
  };
  breakevenExitCounts: {
    rawBreakevenStopCount: number;
    netBreakevenStopCount: number;
    grossBreakevenStopCount: number;
  };
  costModelReducesNetPnl: boolean;
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
  breadthDiagnostics: BreadthDiagnosticsReport;
  tradeLedger: TradeLedgerEntry[];
  tradeForensics: TradeForensicSummary[];
  pnlMathAudit: PnlMathAuditReport;
  noTradeDiagnostics: NoTradeDiagnosticsReport;
  laneOpportunityDiagnostics: Record<string, LaneOpportunityDiagnostics>;
  regimeNoTradeDiagnostics: RegimeNoTradeDiagnosticsReport;
  regimeDenominatorDiagnostics: Partial<Record<Regime, RegimeDenominatorDiagnostics>>;
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

/** `null` (not a fabricated 0) when there were no trades to measure at all. */
function profitFactor(wins: number, losses: number, tradeCount: number): number | null {
  if (tradeCount === 0) return null;
  const grossLoss = Math.abs(losses);
  if (grossLoss > 0) return wins / grossLoss;
  return wins > 0 ? Infinity : 0;
}

function compactCandle(candle: Candle): CompactCandle {
  return {
    openTime: new Date(candle.openTime).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function regimeBranches(ctx: MarketContext): Record<Exclude<Regime, "NO_TRADE">, boolean> {
  return {
    BEAR_TREND: ctx.btcBreaksBelow55000 === true && ctx.retestFailed === true && ctx.marketBreadthCollapses === true,
    TREND_RECOVERY:
      ctx.btcCloseDailyAbove65000 === true &&
      ctx.pullbackHolds === true &&
      ctx.marketStructureBullish === true &&
      ctx.ethConfirms === true &&
      ctx.altBreadthPositive === true,
    NEUTRAL_RECOVERY:
      ctx.btcClose4hAbove62000 === true &&
      ctx.retest62000Hold === true &&
      ctx.btcHigherLow === true &&
      ctx.ethConfirms === true &&
      ctx.altBreadthImproves === true &&
      ctx.volumeNotDead === true,
    BEARISH_CHOPPY_DEFENSIVE: ctx.btcBelow60000 === true || (ctx.btcBelow62000 === true && ctx.marketBreadthWeak === true),
  };
}

function addMissingRecoveryFlags(out: Record<string, number>, ctx: MarketContext): void {
  for (const [name, pass] of Object.entries({
    btcCloseDailyAbove65000: ctx.btcCloseDailyAbove65000 === true,
    pullbackHolds: ctx.pullbackHolds === true,
    marketStructureBullish: ctx.marketStructureBullish === true,
    ethConfirms: ctx.ethConfirms === true,
    altBreadthPositive: ctx.altBreadthPositive === true,
    btcClose4hAbove62000: ctx.btcClose4hAbove62000 === true,
    retest62000Hold: ctx.retest62000Hold === true,
    btcHigherLow: ctx.btcHigherLow === true,
    altBreadthImproves: ctx.altBreadthImproves === true,
    volumeNotDead: ctx.volumeNotDead === true,
  })) {
    if (!pass) addCount(out, name);
  }
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

function breadthForTimestamp(input: HistoricalValidationInput, asOf: number): FeatureAdapterInput["breadth"] | undefined {
  return input.breadthByTimestamp?.get(asOf) ?? input.breadth;
}

function firstBreadth(input: HistoricalValidationInput): FeatureAdapterInput["breadth"] | undefined {
  if (input.breadth) return input.breadth;
  for (const breadth of input.breadthByTimestamp?.values() ?? []) {
    if (breadth) return breadth;
  }
  return undefined;
}

function breadthBiasNote(input: HistoricalValidationInput): string {
  const kind = firstBreadth(input)?.universeKind;
  if (kind === "POINT_IN_TIME") return "Breadth uses a point-in-time universe snapshot.";
  if (kind === "CURRENT_HIGH_LIQUIDITY_MAJORS" || kind === "CURRENT_LIQUID_UNIVERSE") {
    return "Breadth uses the current liquid scan universe; historical universe snapshots are unavailable, so survivorship bias remains.";
  }
  return "Breadth unavailable; breadth-dependent flags remain undefined and no breadth edge is validated.";
}

function breadthDiagnostics(input: HistoricalValidationInput): BreadthDiagnosticsReport {
  const breadth = firstBreadth(input);
  return {
    source: breadth ? "SUPPLIED" : "UNAVAILABLE",
    universeKind: breadth?.universeKind ?? "UNAVAILABLE",
    universeSymbols: input.breadthUniverseSymbols ?? [],
    unavailableDecisionCount: input.breadthUnavailableCount ?? 0,
    survivorshipBiasWarning: breadthBiasNote(input),
    metricsSample: input.breadthMetricsSample,
  };
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
  const gateConditions = [
    { name: "spread_gate", pass: ctx.spreadBps <= GUARD_THRESHOLDS.maxSpreadBps },
    { name: "slippage_gate", pass: ctx.slippageBps <= GUARD_THRESHOLDS.maxSlippageBps },
    { name: "liquidity_gate", pass: ctx.liquidityTooThin !== true },
    { name: "funding_gate", pass: ctx.fundingRiskAbnormal !== true },
    { name: "daily_loss_gate", pass: ctx.dailyLossPct < GUARD_THRESHOLDS.maxDailyLossPct },
    { name: "consecutive_loss_gate", pass: ctx.consecutiveLosses < GUARD_THRESHOLDS.maxConsecutiveLosses },
    { name: "lane_floor", pass: passesLaneFloor(ctx) },
  ];
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
        ...gateConditions,
      ];
    case "BREAKDOWN_RETEST_SHORT":
      return [
        { name: "regime_bearish_or_bear_trend", pass: ctx.regime === "BEARISH_CHOPPY_DEFENSIVE" || ctx.regime === "BEAR_TREND" },
        { name: "support_broken", pass: ctx.supportBroken === true },
        { name: "close_below_support", pass: ctx.closeBelowSupport === true },
        { name: "retest_old_support", pass: ctx.retestOldSupport === true },
        { name: "retest_failed", pass: ctx.retestFailed === true },
        { name: "btc_still_weak", pass: ctx.btcStillWeak === true },
        ...gateConditions,
      ];
    case "MICRO_MEAN_REVERSION":
      return [
        { name: "regime_bearish_choppy", pass: ctx.regime === "BEARISH_CHOPPY_DEFENSIVE" },
        { name: "price_near_lower_range", pass: ctx.priceNearLowerRange === true },
        { name: "rsi_short_tf_below_max", pass: typeof ctx.rsiShortTf === "number" && ctx.rsiShortTf < GUARD_THRESHOLDS.microReversionRsiMax },
        { name: "liquidation_flush_detected", pass: ctx.liquidationFlushDetected === true },
        { name: "btc_not_breaking_major_support", pass: ctx.btcNotBreakingMajorSupport === true },
        ...gateConditions,
      ];
    case "PULLBACK_LONG_SCALP":
      return [
        { name: "regime_neutral_recovery", pass: ctx.regime === "NEUTRAL_RECOVERY" },
        { name: "btc_4h_above_62000", pass: ctx.btcClose4hAbove62000 === true },
        { name: "pullback_to_support", pass: ctx.pullbackToSupport === true },
        { name: "support_holds", pass: ctx.supportHolds === true },
        { name: "volume_not_dead", pass: ctx.volumeNotDead === true },
        { name: "market_breadth_positive", pass: ctx.marketBreadthPositive === true },
        ...gateConditions,
      ];
    case "BREAKOUT_RETEST_LONG":
      return [
        { name: "regime_recovery", pass: ctx.regime === "NEUTRAL_RECOVERY" || ctx.regime === "TREND_RECOVERY" },
        { name: "resistance_broken", pass: ctx.resistanceBroken === true },
        { name: "retest_resistance_as_support", pass: ctx.retestResistanceAsSupport === true },
        { name: "higher_low_formed", pass: ctx.higherLowFormed === true },
        { name: "market_breadth_positive", pass: ctx.marketBreadthPositive === true },
        { name: "volume_expansion", pass: ctx.volumeExpansion === true },
        ...gateConditions,
      ];
    case "RELATIVE_STRENGTH_LONG":
      return [
        { name: "regime_neutral_recovery", pass: ctx.regime === "NEUTRAL_RECOVERY" },
        { name: "btc_stable_above_support", pass: ctx.btcStableAboveSupport === true },
        { name: "coin_outperforms_btc", pass: ctx.coinOutperformsBTC === true },
        { name: "coin_above_vwap", pass: ctx.coinAboveVWAP === true },
        { name: "volume_expansion", pass: ctx.volumeExpansion === true },
        { name: "liquidity_good", pass: ctx.liquidityGood === true },
        ...gateConditions,
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
        grossProfitFactor: null,
        netProfitFactor: null,
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
    d.grossProfitFactor = profitFactor(grossWins, grossLosses, trades.length);
    d.netProfitFactor = profitFactor(netWins, netLosses, trades.length);
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
    tradeId: tradeId(symbol, trade, index),
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
    rawBreakevenPrice: trade.rawBreakevenPrice,
    netBreakevenPrice: trade.netBreakevenPrice,
    breakevenMode: trade.breakevenMode,
    estimatedCostBufferPrice: trade.estimatedCostBufferPrice,
    stopMovedToBreakevenAt: iso(trade.stopMovedToBreakevenAt ?? undefined),
    stopMovedToBreakevenReason: trade.stopMovedToBreakevenReason,
    grossPnlAtBreakevenStop: trade.grossPnlAtBreakevenStop,
    netPnlAtBreakevenStop: trade.netPnlAtBreakevenStop,
    takeProfitATR: trade.takeProfitATR,
    stopLossATR: trade.stopLossATR,
    atrAtEntry: trade.atrAtEntry,
    featureSourcesUsedByEntryDecision: trade.featureSources,
    rejectedByBeforeEntry: rejectedByBeforeEntry.get(trade.entryTs) ?? null,
  }));
}

function buildRegimeDenominators(
  decisionCountByRegime: Partial<Record<Regime, number>>,
  dayKeysByRegime: Record<Regime, Set<number>>,
  metrics: BacktestMetrics,
): Partial<Record<Regime, RegimeDenominatorDiagnostics>> {
  const out: Partial<Record<Regime, RegimeDenominatorDiagnostics>> = {};
  for (const regime of ["BEAR_TREND", "BEARISH_CHOPPY_DEFENSIVE", "NEUTRAL_RECOVERY", "TREND_RECOVERY", "NO_TRADE"] as Regime[]) {
    const trades = metrics.trades.filter((trade) => trade.regime === regime);
    const wins = trades.filter((trade) => trade.netPnl > 0);
    const losses = trades.filter((trade) => trade.netPnl <= 0);
    const grossWin = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
    const grossLoss = losses.reduce((sum, trade) => sum + trade.netPnl, 0);
    const dayCount = dayKeysByRegime[regime].size;
    out[regime] = {
      decisionCount: decisionCountByRegime[regime] ?? 0,
      dayCount,
      tradeCount: trades.length,
      tradesPerDayInRegime: dayCount > 0 ? trades.length / dayCount : 0,
      profitFactor: profitFactor(grossWin, grossLoss, trades.length),
      winRate: trades.length ? wins.length / trades.length : 0,
      averagePnl: trades.length ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length : 0,
    };
  }
  return out;
}

function heuristicFlags(featureSources: FeatureSourceMap | undefined, ctx: MarketContext | undefined): string[] {
  const heuristicBySource = Object.entries(featureSources ?? {})
    .filter(([name, sources]) => sources?.includes("HEURISTIC") && ctx?.[name as keyof MarketContext] !== undefined)
    .map(([name]) => name);
  const heuristicByDerivation = [
    "supportBroken",
    "closeBelowSupport",
    "supportHolds",
    "retestOldSupport",
    "retestFailed",
    "resistanceBroken",
    "retestResistanceAsSupport",
    "liquidationFlushDetected",
  ].filter((name) => featureSources?.[name as keyof MarketContext] && ctx?.[name as keyof MarketContext] !== undefined);
  return [...new Set([...heuristicBySource, ...heuristicByDerivation])].sort();
}

function buildTradeForensics(
  symbol: string,
  metrics: BacktestMetrics,
  candles: Candle[],
  contextsByTimestamp: Map<number, MarketContext>,
): TradeForensicSummary[] {
  return metrics.trades.map((trade, index) => {
    const entryIndex = candles.findIndex((candle) => closeTime(candle, "1h") === trade.entryTs);
    const exitIndex = candles.findIndex((candle) => closeTime(candle, "1h") === trade.exitTs);
    const entryCandle = candles[Math.max(0, entryIndex)]!;
    const life = candles.filter((candle) => closeTime(candle, "1h") > trade.entryTs && closeTime(candle, "1h") <= trade.exitTs);
    const observed = life.length ? life : entryCandle ? [entryCandle] : [];
    const side = trade.action === "ENTER_LONG" ? "LONG" : "SHORT";
    const highs = observed.map((candle) => candle.high);
    const lows = observed.map((candle) => candle.low);
    const mfe = side === "LONG" ? Math.max(...highs) - trade.entryPrice : trade.entryPrice - Math.min(...lows);
    const mae = side === "LONG" ? trade.entryPrice - Math.min(...lows) : Math.max(...highs) - trade.entryPrice;
    const previous3 = entryIndex >= 0 ? candles.slice(Math.max(0, entryIndex - 3), entryIndex) : [];
    const next3 = entryIndex >= 0 ? candles.slice(entryIndex + 1, entryIndex + 4) : [];
    const previous3CloseMove = previous3.length
      ? entryCandle.close - previous3[0]!.close
      : null;
    const previous3CloseMoveAtr =
      previous3CloseMove !== null && trade.atrAtEntry > 0 ? previous3CloseMove / trade.atrAtEntry : null;
    const exitCandle = exitIndex >= 0 ? candles[exitIndex] : undefined;
    const stopHitBy =
      trade.exitReason === "SL" && exitCandle
        ? side === "LONG"
          ? exitCandle.close <= trade.exitPrice
            ? "CLOSE"
            : "WICK"
          : exitCandle.close >= trade.exitPrice
            ? "CLOSE"
            : "WICK"
        : null;
    const afterFees = trade.grossPnl - trade.fees;
    const afterSpread = afterFees - trade.spreadCost;
    const afterSlippage = afterSpread - trade.slippageCost;
    const ctx = contextsByTimestamp.get(trade.entryTs);

    return {
      tradeId: tradeId(symbol, trade, index),
      entryCandleContext: {
        regime: trade.regime,
        lane: trade.lane,
        btcBelow60000: ctx?.btcBelow60000,
        btcBelow62000: ctx?.btcBelow62000,
        marketBreadthWeak: ctx?.marketBreadthWeak,
        supportBroken: ctx?.supportBroken,
        retestFailed: ctx?.retestFailed,
        liquidationFlushDetected: ctx?.liquidationFlushDetected,
        rsi1h: ctx?.rsi1h,
        rsiShortTf: ctx?.rsiShortTf,
        spreadBps: ctx?.spreadBps,
        slippageBps: ctx?.slippageBps,
        liquiditySource: ctx?.liquiditySource,
        fundingRiskAbnormal: ctx?.fundingRiskAbnormal,
      },
      previous3Candles: previous3.map(compactCandle),
      next3Candles: next3.map(compactCandle),
      previous3CloseMove,
      previous3CloseMoveAtr,
      entryAfterExtendedMove: previous3CloseMoveAtr !== null ? Math.abs(previous3CloseMoveAtr) >= 1 : false,
      stopHitBy,
      mfe,
      mfeAtr: trade.atrAtEntry > 0 ? mfe / trade.atrAtEntry : 0,
      mae,
      maeAtr: trade.atrAtEntry > 0 ? mae / trade.atrAtEntry : 0,
      netPnlAfterCosts: {
        gross: trade.grossPnl,
        afterFees,
        afterSpread,
        afterSlippage,
        afterFunding: trade.netPnl,
      },
      featureSourcesUsed: trade.featureSources,
      heuristicFlagsInvolved: heuristicFlags(trade.featureSources, ctx),
    };
  });
}

function tradeId(symbol: string, trade: BacktestMetrics["trades"][number], index: number): string {
  return `${symbol}-${index + 1}-${trade.entryTs}`;
}

function buildPnlMathAudit(symbol: string, metrics: BacktestMetrics): PnlMathAuditReport {
  const epsilon = 1e-8;
  const slTrades = metrics.trades.filter((trade) => trade.exitReason === "SL");
  const negativeGrossSlTrades = slTrades.filter((trade) => trade.grossPnl < -epsilon);
  const zeroGrossSlTrades = slTrades.filter((trade) => Math.abs(trade.grossPnl) <= epsilon);
  const positiveGrossSlTrades = slTrades.filter((trade) => trade.grossPnl > epsilon);
  const breakevenStopTrades = slTrades.filter((trade) => trade.stopMovedToBreakevenAt !== null);
  const zeroGrossSlTradeIds = zeroGrossSlTrades.map((trade) => {
    const index = metrics.trades.indexOf(trade);
    return tradeId(symbol, trade, index);
  });
  return {
    grossPnlFormula: {
      long: "(exitPrice - entryPrice) * qty",
      short: "(entryPrice - exitPrice) * qty",
    },
    stopPriceFormula: {
      longStopLoss: "entryPrice - stopLossATR * atrAtEntry",
      shortStopLoss: "entryPrice + stopLossATR * atrAtEntry",
      longTakeProfit: "entryPrice + takeProfitATR * atrAtEntry",
      shortTakeProfit: "entryPrice - takeProfitATR * atrAtEntry",
    },
    stopLossAtrAppliedToRealStopPrice: metrics.trades.every((trade) => trade.stopLossATR > 0 && trade.atrAtEntry > 0),
    shortPnlSignConvention: "Short gross PnL is positive when exitPrice is below entryPrice and negative when exitPrice is above entryPrice.",
    slExitGrossPnlCheck: {
      slTradeCount: slTrades.length,
      negativeGrossSlCount: negativeGrossSlTrades.length,
      zeroGrossSlCount: zeroGrossSlTrades.length,
      positiveGrossSlCount: positiveGrossSlTrades.length,
      zeroGrossSlTradeIds,
      explanation:
        zeroGrossSlTradeIds.length > 0
          ? "Zero-gross SL trades should now only appear for RAW_BREAKEVEN mode or exact price coincidences; NET_BREAKEVEN targets enough gross PnL to cover estimated costs before funding variance."
          : null,
    },
    breakevenExitCounts: {
      rawBreakevenStopCount: breakevenStopTrades.filter((trade) => trade.breakevenMode === "RAW_BREAKEVEN").length,
      netBreakevenStopCount: breakevenStopTrades.filter((trade) => trade.breakevenMode === "NET_BREAKEVEN").length,
      grossBreakevenStopCount: zeroGrossSlTrades.length,
    },
    costModelReducesNetPnl: metrics.trades.every((trade) => trade.netPnl <= trade.grossPnl + epsilon),
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
  const contextsByTimestamp = new Map<number, MarketContext>();
  const decisionCountByRegime: Partial<Record<Regime, number>> = {};
  const decisionCountByLane: Record<string, number> = {};
  const rejectedByCounts: Record<string, number> = {};
  const noTradeCountByReason: Record<string, number> = {};
  const bearishChoppyDayKeys = new Set<number>();
  const dayKeysByRegime: Record<Regime, Set<number>> = {
    BEAR_TREND: new Set<number>(),
    BEARISH_CHOPPY_DEFENSIVE: new Set<number>(),
    NEUTRAL_RECOVERY: new Set<number>(),
    TREND_RECOVERY: new Set<number>(),
    NO_TRADE: new Set<number>(),
  };
  const rejectedByBeforeEntry = new Map<number, string | null>();
  const laneDiagnostics = emptyLaneDiagnostics();
  const featureSourcesSummary: Record<string, Record<string, number>> = {};
  const regimeNoTradeFailedBranches: Partial<Record<Regime, number>> = {};
  const missingRecoveryFlagCounts: Record<string, number> = {};
  let lastRejectedBy: string | null = null;
  let closedCandleFilterCount = 0;
  let contradictionCount = 0;
  let staleContextCount = 0;
  let missingExecutionDataCount = 0;
  let missingFundingRiskAbnormalCount = 0;
  let liquidityTooThinCount = 0;
  let noValidLaneSetupCount = 0;
  let noTradeBtcBelow60000Count = 0;
  let noTradeBtcBelow62000Count = 0;
  let noTradeMarketBreadthWeakUnavailableCount = 0;
  let noTradeMarketBreadthWeakFalseCount = 0;
  let bearishChoppyAlmostMatchedButFailedCount = 0;
  let rawEnterSignalCount = 0;

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
      breadth: breadthForTimestamp(input, asOf),
      microstructure: defaultMicrostructure(input.symbol, bar, input.microstructure),
      governance: {
        dailyLossPct: 0,
        consecutiveLosses: 0,
        openPositions: 0,
        tradesToday: 0,
      },
    });
    contexts.push(ctx);
    contextsByTimestamp.set(asOf, ctx);

    const decision = buildTradingDecision(ctx);
    addCount(decisionCountByRegime as Record<string, number>, decision.regime);
    addCount(decisionCountByLane, decision.action === "NO_TRADE" ? "NO_TRADE" : decision.lane);
    if (decision.action !== "NO_TRADE") rawEnterSignalCount += 1;
    dayKeysByRegime[decision.regime].add(dayKey(asOf));
    if (decision.regime === "BEARISH_CHOPPY_DEFENSIVE") bearishChoppyDayKeys.add(dayKey(asOf));
    if (decision.trace?.rejectedBy === "REGIME_NO_TRADE") {
      const branches = regimeBranches(ctx);
      for (const [regime, matched] of Object.entries(branches)) {
        if (!matched) addCount(regimeNoTradeFailedBranches as Record<string, number>, regime);
      }
      if (ctx.btcBelow60000 === true) noTradeBtcBelow60000Count += 1;
      if (ctx.btcBelow62000 === true) noTradeBtcBelow62000Count += 1;
      if (ctx.marketBreadthWeak === undefined) noTradeMarketBreadthWeakUnavailableCount += 1;
      if (ctx.marketBreadthWeak === false) noTradeMarketBreadthWeakFalseCount += 1;
      if (ctx.btcBelow62000 === true && ctx.btcBelow60000 !== true && ctx.marketBreadthWeak !== true) {
        bearishChoppyAlmostMatchedButFailedCount += 1;
      }
      addMissingRecoveryFlags(missingRecoveryFlagCounts, ctx);
    }
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
    // The immediately-following real candle's open — the earliest a decision made
    // from THIS bar's own just-closed data could actually fill. Not `i + decisionEveryBars`:
    // the market still moves bar-by-bar even when decisions are only evaluated every
    // N bars, so a fresh entry always fills on the very next candle, never further out.
    const nextOpen = candles.h1[i + 1]?.open ?? null;
    bars.push({
      timestamp: asOf,
      ctx,
      price: bar.close,
      nextOpen,
      high: bar.high,
      low: bar.low,
      atr: atrValue,
    });
  }

  const baseMetrics = runBacktest({ bars, startingEquity });
  const scenarios = runBacktestCostScenarios({ bars, startingEquity });
  const wf = walkForwardBacktest({ bars, startingEquity }, input.walkForwardFolds ?? 4);
  const fundingSource = firstFundingSource(contexts);
  const breadth = firstBreadth(input);
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
      breadthSource: breadth ? "SUPPLIED" : "UNAVAILABLE",
      breadthUniverseKind: breadth?.universeKind ?? "UNAVAILABLE",
      breadthSurvivorshipBiasNote: breadthBiasNote(input),
      featureSourcesSummary,
    },
    decisionDistribution: {
      totalDecisions: bars.length,
      totalTrades: baseMetrics.numTrades,
      enterSignalCount: rawEnterSignalCount,
      actionableEnterSignalCount: baseMetrics.diagnostics.enterSignalCount,
      statefulGovernanceSuppressedSignalCount: Math.max(0, rawEnterSignalCount - baseMetrics.diagnostics.enterSignalCount),
      closedTradeCount: baseMetrics.diagnostics.closedTradeCount,
      skippedBecausePositionOpen: baseMetrics.diagnostics.skippedBecausePositionOpen,
      skippedBecauseCooldown: baseMetrics.diagnostics.skippedBecauseCooldown,
      skippedBecauseMaxTrades: baseMetrics.diagnostics.skippedBecauseMaxTrades,
      skippedBecauseExecutionGuard: baseMetrics.diagnostics.skippedBecauseExecutionGuard,
      positionManagementDecisionCount: baseMetrics.diagnostics.positionManagementDecisionCount,
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
    breadthDiagnostics: breadthDiagnostics(input),
    tradeLedger: buildTradeLedger(input.symbol, scenarios.base, fundingSource, rejectedByBeforeEntry),
    tradeForensics: buildTradeForensics(input.symbol, scenarios.base, candles.h1, contextsByTimestamp),
    pnlMathAudit: buildPnlMathAudit(input.symbol, scenarios.base),
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
    regimeNoTradeDiagnostics: {
      detectorBranchFailureCounts: regimeNoTradeFailedBranches,
      btcBelow60000Count: noTradeBtcBelow60000Count,
      btcBelow62000Count: noTradeBtcBelow62000Count,
      marketBreadthWeakUnavailableCount: noTradeMarketBreadthWeakUnavailableCount,
      marketBreadthWeakFalseCount: noTradeMarketBreadthWeakFalseCount,
      missingRecoveryFlagCounts,
      bearishChoppyAlmostMatchedButFailedCount,
      dayCountByRegime: Object.fromEntries(
        Object.entries(dayKeysByRegime).map(([regime, days]) => [regime, days.size]),
      ) as Partial<Record<Regime, number>>,
    },
    regimeDenominatorDiagnostics: buildRegimeDenominators(decisionCountByRegime, dayKeysByRegime, scenarios.base),
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

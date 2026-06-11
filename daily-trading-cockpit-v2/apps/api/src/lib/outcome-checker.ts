import type {
  AgreementStats,
  AvgRUnknownReasons,
  Candle,
  ExecutionEntryVariant,
  OutcomeWindow,
  PerformanceStats,
  PerformanceInsightCard,
  PerformanceWindowSnapshot,
  SampleTier,
  ShadowPositionVariant,
  ShadowVariantKey,
  ShadowVariantStats,
  StatusStats,
  SymbolStats,
  TrackedSignal,
  VariantCombinationStats,
} from "@dtc/shared";

import type { BinanceClient } from "./binance.js";
import { collapseTrackedSignals } from "./tracker.js";
import type { SignalTracker } from "./tracker.js";

const OUTCOME_WINDOWS = [
  { key: "30m" as const, ms: 30 * 60 * 1000 },
  { key: "1h" as const, ms: 60 * 60 * 1000 },
  { key: "4h" as const, ms: 4 * 60 * 60 * 1000 },
  { key: "24h" as const, ms: 24 * 60 * 60 * 1000 },
] as const;

const PRIMARY_WINDOW = "1h";
const SECONDARY_WINDOW = "4h";
const DUPLICATE_SUPPRESSION_WINDOW_MINUTES = 60;
const ACTIVE_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FEE_BPS_PER_SIDE = 8;
const DEFAULT_SLIPPAGE_BPS_PER_SIDE = 6;
const SHADOW_VARIANTS: Array<{
  key: ShadowVariantKey;
  label: string;
  category: ShadowVariantStats["category"];
}> = [
  { key: "base_current", label: "Base current", category: "ENTRY" },
  { key: "fib_382_entry", label: "Fib 0.382 entry", category: "ENTRY" },
  { key: "fib_500_entry", label: "Fib 0.500 entry", category: "ENTRY" },
  { key: "fib_618_entry", label: "Fib 0.618 entry", category: "ENTRY" },
  { key: "ema20_pullback_entry", label: "EMA20 pullback entry", category: "ENTRY" },
  { key: "vwap_retest_entry", label: "VWAP retest entry", category: "ENTRY" },
  { key: "no_chase_atr_entry", label: "No-chase ATR entry", category: "ENTRY" },
  { key: "tp1_fast_exit", label: "TP1 fast exit", category: "EXIT" },
  { key: "tp1_50_tp2_runner", label: "TP1 50% + TP2 runner", category: "EXIT" },
  { key: "kronos_runner_exit", label: "Kronos runner exit", category: "EXIT" },
  { key: "kronos_flip_exit", label: "Kronos flip exit", category: "EXIT" },
  { key: "trail_after_tp1", label: "Trail after TP1", category: "EXIT" },
  { key: "whale_conflict_exit", label: "Whale conflict exit", category: "EXIT" },
  { key: "fib_extension_exit", label: "Fib extension exit", category: "EXIT" },
  { key: "kronos_strong_agree_only", label: "Kronos STRONG agree only", category: "COMBINATION" },
  { key: "whale_agree_only", label: "Whale agree only", category: "COMBINATION" },
  { key: "kronos_and_whale_agree", label: "Kronos and whale agree", category: "COMBINATION" },
  { key: "fib_entry_plus_kronos_exit", label: "Fib entry + Kronos exit", category: "COMBINATION" },
  { key: "fib_entry_plus_whale_confirm", label: "Fib entry + whale confirm", category: "COMBINATION" },
  { key: "indicator_confluence_only", label: "Indicator confluence only", category: "COMBINATION" },
];

const REPLAY_ENTRY_VARIANTS: ExecutionEntryVariant[] = [
  "base_current_entry",
  "fib_382_entry",
  "fib_500_entry",
  "fib_618_entry",
  "vwap_retest_entry",
  "ema20_pullback_entry",
  "no_chase_atr_entry",
];

const REPLAY_EXIT_VARIANTS: ShadowPositionVariant[] = [
  "tp1_full_exit",
  "tp1_50_tp2_runner",
  "tp1_70_runner30",
  "trail_after_tp1",
  "kronos_runner_exit",
  "kronos_flip_exit",
  "whale_conflict_exit",
  "vwap_loss_exit",
];

export interface ComputePerformanceTimingBreakdown {
  candidateNormalizationMs: number;
  indicatorAggregationMs: number;
  replayVariantAnalysisMs: number;
  calibrationMs: number;
  routeReasonEvaluationMs: number;
  rankingMs: number;
  filterGateMs: number;
  loggingSerializationMs: number;
  diagnosticsBuildMs: number;
}

export interface TimedPerformanceResult {
  performance: PerformanceStats;
  timing: ComputePerformanceTimingBreakdown;
}

function emptyComputePerformanceTiming(): ComputePerformanceTimingBreakdown {
  return {
    candidateNormalizationMs: 0,
    indicatorAggregationMs: 0,
    replayVariantAnalysisMs: 0,
    calibrationMs: 0,
    routeReasonEvaluationMs: 0,
    rankingMs: 0,
    filterGateMs: 0,
    loggingSerializationMs: 0,
    diagnosticsBuildMs: 0,
  };
}

function addPerformanceTiming(
  timing: ComputePerformanceTimingBreakdown | undefined,
  key: keyof ComputePerformanceTimingBreakdown,
  startMs: number,
): void {
  if (!timing) return;
  timing[key] += Math.max(0, Math.round(Date.now() - startMs));
}

function measurePerformanceTiming<T>(
  timing: ComputePerformanceTimingBreakdown | undefined,
  key: keyof ComputePerformanceTimingBreakdown,
  fn: () => T,
): T {
  const startMs = Date.now();
  try {
    return fn();
  } finally {
    addPerformanceTiming(timing, key, startMs);
  }
}

function readBpsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function executionCostConfig() {
  const feeBpsPerSide = readBpsEnv("PERF_FEE_BPS_PER_SIDE", DEFAULT_FEE_BPS_PER_SIDE);
  const slippageBpsPerSide = readBpsEnv("PERF_SLIPPAGE_BPS_PER_SIDE", DEFAULT_SLIPPAGE_BPS_PER_SIDE);
  return {
    feeBpsPerSide,
    slippageBpsPerSide,
    roundTripCostBps: roundMetric((feeBpsPerSide + slippageBpsPerSide) * 2),
  };
}

function costAssumptionLabel(spreadPercent: number | null | undefined): string {
  const costs = executionCostConfig();
  const spreadBps = spreadPercent !== null && spreadPercent !== undefined && Number.isFinite(spreadPercent)
    ? roundMetric(spreadPercent * 100)
    : 0;
  return `${costs.feeBpsPerSide}bps fee/side + ${costs.slippageBpsPerSide}bps slippage/side + ${spreadBps.toFixed(2)}bps spread`;
}

function midpoint(entryZone: [number, number] | null): number | null {
  if (!entryZone) return null;
  return (entryZone[0] + entryZone[1]) / 2;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function isDirectionAligned(signal: TrackedSignal): boolean {
  const context = signal.analysisContext;
  if (!context) return false;
  if (signal.direction === "LONG") {
    return context.oneHourTrend === "BULLISH" || (context.fiveMinuteTrend === "BULLISH" && context.fifteenMinuteTrend === "BULLISH");
  }
  if (signal.direction === "SHORT") {
    return context.oneHourTrend === "BEARISH" || (context.fiveMinuteTrend === "BEARISH" && context.fifteenMinuteTrend === "BEARISH");
  }
  return false;
}

function whaleAgrees(signal: TrackedSignal): boolean {
  return (signal.direction === "LONG" && signal.whaleSignal === "BULLISH") || (signal.direction === "SHORT" && signal.whaleSignal === "BEARISH");
}

function whaleDisagrees(signal: TrackedSignal): boolean {
  return (signal.direction === "LONG" && signal.whaleSignal === "BEARISH") || (signal.direction === "SHORT" && signal.whaleSignal === "BULLISH");
}

function activeKronosBias(signal: TrackedSignal): TrackedSignal["kronosBias"] {
  return signal.selectedKronosBias ?? signal.kronosBias;
}

function kronosAgrees(signal: TrackedSignal): boolean {
  if (signal.horizonConflict) return false;
  const bias = activeKronosBias(signal);
  return (signal.direction === "LONG" && bias === "LONG") || (signal.direction === "SHORT" && bias === "SHORT");
}

function kronosConflicts(signal: TrackedSignal): boolean {
  const bias = activeKronosBias(signal);
  return (signal.direction === "LONG" && bias === "SHORT") || (signal.direction === "SHORT" && bias === "LONG");
}

function strongKronosContinuation(signal: TrackedSignal): boolean {
  const context = signal.analysisContext;
  if (!context || signal.kronosConfidenceBucket === "WEAK" || !kronosAgrees(signal)) return false;
  return signal.kronosConfidenceBucket === "STRONG" || signal.kronosConfidenceBucket === "MEDIUM";
}

export class OutcomeChecker {
  constructor(
    private readonly tracker: SignalTracker,
    private readonly binanceClient: BinanceClient,
  ) {}

  async checkPending(): Promise<void> {
    const now = Date.now();
    const signals = this.tracker.readAllRaw();

    const pending = signals.filter((s) =>
      OUTCOME_WINDOWS.some(({ key, ms }) => now - new Date(s.scannedAt).getTime() >= ms && s.outcomes[key] === null),
    );
    if (pending.length === 0) {
      this.tracker.setLastOutcomeCheckerRunAt(new Date(now).toISOString());
      return;
    }

    const candlesBySymbol = new Map<string, Candle[]>();
    const pendingBySymbol = new Map<string, TrackedSignal[]>();
    for (const signal of pending) {
      const list = pendingBySymbol.get(signal.symbol) ?? [];
      list.push(signal);
      pendingBySymbol.set(signal.symbol, list);
    }

    for (const [symbol, symbolSignals] of pendingBySymbol.entries()) {
      try {
        const earliestScanTime = Math.min(...symbolSignals.map((signal) => new Date(signal.scannedAt).getTime()));
        const candleCount = Math.min(Math.max(Math.ceil((now - earliestScanTime) / (5 * 60 * 1000)) + 2, 12), 1000);
        candlesBySymbol.set(
          symbol,
          await this.binanceClient.getCandles(symbol, "5m", candleCount, {
            startTime: earliestScanTime,
            endTime: now,
          }),
        );
      } catch {
        // keep existing null outcomes if history fetch fails
      }
    }

    const updated = signals.map((signal) => {
      const candles = candlesBySymbol.get(signal.symbol);
      if (!candles) return signal;
      const scanTime = new Date(signal.scannedAt).getTime();
      const outcomes = { ...signal.outcomes };
      for (const { key, ms } of OUTCOME_WINDOWS) {
        if (now - scanTime >= ms && signal.outcomes[key] === null) {
          outcomes[key] = computeOutcome(signal, candles, scanTime + ms, now);
        }
      }
      return { ...signal, outcomes };
    });

    this.tracker.writeAllRaw(updated);
    this.tracker.writeAll(updated);
    this.tracker.setLastOutcomeCheckerRunAt(new Date(now).toISOString());
  }
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function getSampleTier(resolved: number): SampleTier {
  if (resolved < 30) return "EARLY_SIGNAL";
  if (resolved <= 100) return "PROVISIONAL";
  return "USABLE";
}

function findWindowCandles(candles: Candle[], scanTime: number, windowEndTime: number): Candle[] {
  return candles.filter((candle) => candle.openTime > scanTime && candle.openTime <= windowEndTime);
}

function computeExcursions(signal: TrackedSignal, candles: Candle[]): {
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  priceAtCheck: number;
  slHit: boolean;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
} {
  const lastClose = candles.at(-1)?.close ?? signal.priceAtScan;
  let maxFavorable = 0;
  let maxAdverse = 0;
  let slHit = false;
  let tp1Hit = false;
  let tp2Hit = false;
  let tp3Hit = false;

  for (const candle of candles) {
    const favorablePrice = signal.direction === "LONG" ? candle.high : candle.low;
    const adversePrice = signal.direction === "LONG" ? candle.low : candle.high;
    const favorablePct =
      signal.direction === "LONG"
        ? ((favorablePrice - signal.priceAtScan) / signal.priceAtScan) * 100
        : ((signal.priceAtScan - favorablePrice) / signal.priceAtScan) * 100;
    const adversePct =
      signal.direction === "LONG"
        ? ((adversePrice - signal.priceAtScan) / signal.priceAtScan) * 100
        : ((signal.priceAtScan - adversePrice) / signal.priceAtScan) * 100;

    maxFavorable = Math.max(maxFavorable, favorablePct);
    maxAdverse = Math.min(maxAdverse, adversePct);

    if (signal.stopLoss !== null) {
      slHit ||= signal.direction === "LONG" ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    }
    if (signal.tp1 !== null) {
      tp1Hit ||= signal.direction === "LONG" ? candle.high >= signal.tp1 : candle.low <= signal.tp1;
    }
    if (signal.tp2 !== null) {
      tp2Hit ||= signal.direction === "LONG" ? candle.high >= signal.tp2 : candle.low <= signal.tp2;
    }
    if (signal.tp3 !== null) {
      tp3Hit ||= signal.direction === "LONG" ? candle.high >= signal.tp3 : candle.low <= signal.tp3;
    }
  }

  return {
    maxFavorableExcursionPct: roundMetric(maxFavorable),
    maxAdverseExcursionPct: roundMetric(Math.abs(maxAdverse)),
    priceAtCheck: lastClose,
    slHit,
    tp1Hit,
    tp2Hit,
    tp3Hit,
  };
}

function computeRResult(signal: TrackedSignal, result: OutcomeWindow["result"], priceAtCheck: number): number | null {
  const risk = getRiskDistance(signal);
  if (risk === null) {
    return null;
  }

  if (result === "SL") {
    return -1;
  }
  const rewardAnchor = getRewardAnchor(signal, result) ?? priceAtCheck;
  const rewardFromPrice =
    signal.direction === "LONG"
      ? (rewardAnchor - signal.priceAtScan) / risk
      : (signal.priceAtScan - rewardAnchor) / risk;
  return roundMetric(rewardFromPrice);
}

function computeNetRResult(signal: TrackedSignal, grossRResult: number | null): number | null {
  if (grossRResult === null) {
    return null;
  }
  const risk = getRiskDistance(signal);
  if (risk === null || signal.priceAtScan <= 0) {
    return null;
  }
  const costs = executionCostConfig();
  const roundTripCostPct = (costs.roundTripCostBps + spreadBpsForSignal(signal)) / 100;
  const riskPct = (risk / signal.priceAtScan) * 100;
  if (!Number.isFinite(riskPct) || riskPct <= 0) {
    return null;
  }
  return roundMetric(grossRResult - roundTripCostPct / riskPct);
}

function deriveEntryPrice(signal: TrackedSignal): number | null {
  if (Number.isFinite(signal.priceAtScan) && signal.priceAtScan > 0) {
    return signal.priceAtScan;
  }
  if (signal.entryZone !== null) {
    const midpoint = (signal.entryZone[0] + signal.entryZone[1]) / 2;
    if (Number.isFinite(midpoint) && midpoint > 0) {
      return midpoint;
    }
  }
  return null;
}

function getRiskDistance(signal: TrackedSignal): number | null {
  const entryPrice = deriveEntryPrice(signal);
  if (entryPrice === null || signal.stopLoss === null) {
    return null;
  }
  const risk =
    signal.direction === "LONG"
      ? entryPrice - signal.stopLoss
      : signal.stopLoss - entryPrice;
  if (!Number.isFinite(risk) || risk <= 0) {
    return null;
  }
  return risk;
}

function getRewardAnchor(signal: TrackedSignal, result: OutcomeWindow["result"]): number | null {
  if (result === "TP3") return signal.tp3;
  if (result === "TP2") return signal.tp2;
  if (result === "TP1") return signal.tp1;
  return null;
}

function computePriceChangePct(signal: TrackedSignal, priceAtCheck: number): number {
  const entryPrice = deriveEntryPrice(signal);
  if (entryPrice === null) {
    return 0;
  }
  const raw =
    signal.direction === "LONG"
      ? ((priceAtCheck - entryPrice) / entryPrice) * 100
      : ((entryPrice - priceAtCheck) / entryPrice) * 100;
  return roundMetric(raw);
}

function deriveExitPrice(signal: TrackedSignal, result: OutcomeWindow["result"], priceAtCheck: number): number | null {
  if (result === "TP3") return signal.tp3;
  if (result === "TP2") return signal.tp2;
  if (result === "TP1") return signal.tp1;
  if (result === "SL") return signal.stopLoss;
  if (Number.isFinite(priceAtCheck) && priceAtCheck > 0) {
    return priceAtCheck;
  }
  return null;
}

function deriveResolvedRMetrics(
  signal: TrackedSignal,
  outcome: Pick<OutcomeWindow, "result" | "priceAtCheck">,
): {
  grossRResult: number | null;
  netRResult: number | null;
  profitableAfterCosts: boolean;
  missingReason: keyof AvgRUnknownReasons | null;
} {
  if (outcome.result === "OPEN" || outcome.result === "EXPIRED") {
    return {
      grossRResult: null,
      netRResult: null,
      profitableAfterCosts: false,
      missingReason: outcome.result === "OPEN" ? "openOutcome" : "noCandlePath",
    };
  }

  const entryPrice = deriveEntryPrice(signal);
  if (entryPrice === null) {
    return {
      grossRResult: null,
      netRResult: null,
      profitableAfterCosts: false,
      missingReason: "missingEntry",
    };
  }
  if (signal.stopLoss === null) {
    return {
      grossRResult: null,
      netRResult: null,
      profitableAfterCosts: false,
      missingReason: "missingStopLoss",
    };
  }

  const riskDistance = getRiskDistance(signal);
  if (riskDistance === null) {
    return {
      grossRResult: null,
      netRResult: null,
      profitableAfterCosts: false,
      missingReason: "invalidRisk",
    };
  }

  const exitPrice = deriveExitPrice(signal, outcome.result, outcome.priceAtCheck);
  if (exitPrice === null || !Number.isFinite(exitPrice) || exitPrice <= 0) {
    return {
      grossRResult: null,
      netRResult: null,
      profitableAfterCosts: false,
      missingReason: "missingExit",
    };
  }

  const grossRResult = roundMetric(
    signal.direction === "LONG"
      ? (exitPrice - entryPrice) / Math.abs(entryPrice - signal.stopLoss)
      : (entryPrice - exitPrice) / Math.abs(signal.stopLoss - entryPrice),
  );
  const netRResult = computeNetRResult(
    {
      ...signal,
      priceAtScan: entryPrice,
    },
    grossRResult,
  );

  return {
    grossRResult: Number.isFinite(grossRResult) ? grossRResult : null,
    netRResult: netRResult !== null && Number.isFinite(netRResult) ? netRResult : null,
    profitableAfterCosts: (netRResult ?? Number.NEGATIVE_INFINITY) > 0,
    missingReason: null,
  };
}

function resolveOutcomeMetrics(signal: TrackedSignal, outcome: OutcomeWindow): {
  grossRResult: number | null;
  netRResult: number | null;
  profitableAfterCosts: boolean;
  missingReason: keyof AvgRUnknownReasons | null;
} {
  if (
    outcome.metricsSource === "VARIANT" &&
    outcome.outcomeQuality === "VALID_RISK" &&
    outcome.grossRResult !== null &&
    Number.isFinite(outcome.grossRResult) &&
    outcome.netRResult !== null &&
    Number.isFinite(outcome.netRResult)
  ) {
    return {
      grossRResult: roundMetric(outcome.grossRResult),
      netRResult: roundMetric(outcome.netRResult),
      profitableAfterCosts: outcome.netRResult > 0,
      missingReason: null,
    };
  }

  return deriveResolvedRMetrics(signal, outcome);
}

function computeOutcome(signal: TrackedSignal, candles: Candle[], windowEndTime: number, now: number): OutcomeWindow {
  const scanTime = new Date(signal.scannedAt).getTime();
  const windowCandles = findWindowCandles(candles, scanTime, windowEndTime);
  const { maxFavorableExcursionPct, maxAdverseExcursionPct, priceAtCheck, slHit, tp1Hit, tp2Hit, tp3Hit } =
    computeExcursions(signal, windowCandles);

  let result: OutcomeWindow["result"] = windowCandles.length > 0 ? "OPEN" : "EXPIRED";
  for (const candle of windowCandles) {
    const slTriggered = signal.stopLoss !== null && (signal.direction === "LONG" ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss);
    const tp1Triggered = signal.tp1 !== null && (signal.direction === "LONG" ? candle.high >= signal.tp1 : candle.low <= signal.tp1);
    const tp2Triggered = signal.tp2 !== null && (signal.direction === "LONG" ? candle.high >= signal.tp2 : candle.low <= signal.tp2);
    const tp3Triggered = signal.tp3 !== null && (signal.direction === "LONG" ? candle.high >= signal.tp3 : candle.low <= signal.tp3);

    if (slTriggered) {
      result = "SL";
      break;
    }
    if (tp3Triggered) {
      result = "TP3";
      break;
    }
    if (tp2Triggered) {
      result = "TP2";
      break;
    }
    if (tp1Triggered) {
      result = "TP1";
      break;
    }
  }

  const riskDistance = getRiskDistance(signal);
  const metrics = deriveResolvedRMetrics(signal, { result, priceAtCheck });
  const outcomeQuality: OutcomeWindow["outcomeQuality"] = riskDistance === null ? "INVALID_RISK" : "VALID_RISK";

  return {
    checkedAt: new Date(now).toISOString(),
    priceAtCheck,
    priceChangePct: computePriceChangePct(signal, priceAtCheck),
    maxFavorableExcursionPct,
    maxAdverseExcursionPct,
    metricsSource: "BASE",
    entryFilledAt: signal.scannedAt,
    entryFillPrice: deriveEntryPrice(signal),
    exitPrice: deriveExitPrice(signal, result, priceAtCheck),
    ambiguousSameCandle: false,
    candlePath: windowCandles,
    outcomeQuality,
    rResult: metrics.grossRResult,
    grossRResult: metrics.grossRResult,
    netRResult: metrics.netRResult,
    profitableAfterCosts: metrics.profitableAfterCosts,
    slHit,
    tp1Hit,
    tp2Hit,
    tp3Hit,
    result,
  };
}

function cloneOutcome(base: OutcomeWindow, patch: Partial<OutcomeWindow>): OutcomeWindow {
  return {
    ...base,
    ...patch,
  };
}

function recomputePctFromEntry(entryPrice: number, exitPrice: number, direction: TrackedSignal["direction"]): number {
  const raw =
    direction === "LONG"
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
  return roundMetric(raw);
}

function deriveMetricsFromCustomEntry(signal: TrackedSignal, outcome: OutcomeWindow, entryPrice: number, exitPrice: number | null): {
  grossRResult: number | null;
  netRResult: number | null;
  profitableAfterCosts: boolean;
  outcomeQuality: OutcomeWindow["outcomeQuality"];
  missingReason: keyof AvgRUnknownReasons | null;
  priceChangePct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
} {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      grossRResult: null,
      netRResult: null,
      profitableAfterCosts: false,
      outcomeQuality: "INVALID_RISK",
      missingReason: "missingEntry",
      priceChangePct: 0,
      maxFavorableExcursionPct: outcome.maxFavorableExcursionPct,
      maxAdverseExcursionPct: outcome.maxAdverseExcursionPct,
    };
  }

  const customized = {
    ...signal,
    priceAtScan: entryPrice,
  };
  const metrics = deriveResolvedRMetrics(customized, {
    result: outcome.result,
    priceAtCheck: exitPrice ?? outcome.priceAtCheck,
  });

  const baseEntry = deriveEntryPrice(signal) ?? signal.priceAtScan;
  const favorableAbs = (outcome.maxFavorableExcursionPct / 100) * baseEntry;
  const adverseAbs = (outcome.maxAdverseExcursionPct / 100) * baseEntry;

  return {
    grossRResult: metrics.grossRResult,
    netRResult: metrics.netRResult,
    profitableAfterCosts: metrics.profitableAfterCosts,
    outcomeQuality: metrics.missingReason === null ? "VALID_RISK" : "INVALID_RISK",
    missingReason: metrics.missingReason,
    priceChangePct: exitPrice !== null && Number.isFinite(exitPrice) ? recomputePctFromEntry(entryPrice, exitPrice, signal.direction) : 0,
    maxFavorableExcursionPct: roundMetric(Math.abs((favorableAbs / entryPrice) * 100)),
    maxAdverseExcursionPct: roundMetric(Math.abs((adverseAbs / entryPrice) * 100)),
  };
}

function syntheticExitPrice(signal: TrackedSignal, outcome: OutcomeWindow, result: OutcomeWindow["result"]): number | null {
  return deriveExitPrice(signal, result, outcome.priceAtCheck);
}

function customEntryForVariant(signal: TrackedSignal, variantKey: ShadowVariantKey): number | null {
  const context = signal.analysisContext;
  if (!context) return variantKey === "base_current" ? deriveEntryPrice(signal) : null;

  switch (variantKey) {
    case "base_current":
      return deriveEntryPrice(signal);
    case "fib_382_entry":
      return finiteOrNull(context.fibonacci?.retracement382 ?? null);
    case "fib_500_entry":
      return finiteOrNull(context.fibonacci?.retracement500 ?? null);
    case "fib_618_entry":
      return finiteOrNull(context.fibonacci?.retracement618 ?? null);
    case "ema20_pullback_entry":
      return finiteOrNull(context.fiveMinuteEma20);
    case "vwap_retest_entry":
      return finiteOrNull(context.fiveMinuteVwap);
    case "no_chase_atr_entry":
      return midpoint(signal.entryZone) ?? deriveEntryPrice(signal);
    case "fib_entry_plus_kronos_exit":
    case "fib_entry_plus_whale_confirm": {
      const levels = [
        finiteOrNull(context.fibonacci?.retracement382 ?? null),
        finiteOrNull(context.fibonacci?.retracement500 ?? null),
        finiteOrNull(context.fibonacci?.retracement618 ?? null),
      ].filter((value): value is number => value !== null);
      if (levels.length === 0) return null;
      const reference = deriveEntryPrice(signal) ?? signal.priceAtScan;
      return levels.sort((left, right) => Math.abs(left - reference) - Math.abs(right - reference))[0] ?? null;
    }
    default:
      return deriveEntryPrice(signal);
  }
}

function isVariantEligible(signal: TrackedSignal, outcome: OutcomeWindow, variantKey: ShadowVariantKey): boolean {
  const context = signal.analysisContext;
  switch (variantKey) {
    case "base_current":
    case "tp1_fast_exit":
    case "tp1_50_tp2_runner":
    case "trail_after_tp1":
    case "fib_extension_exit":
      return true;
    case "fib_382_entry":
    case "fib_500_entry":
    case "fib_618_entry":
      return !!context?.fibonacci;
    case "ema20_pullback_entry":
      return finiteOrNull(context?.fiveMinuteEma20 ?? null) !== null;
    case "vwap_retest_entry":
      return finiteOrNull(context?.fiveMinuteVwap ?? null) !== null;
    case "no_chase_atr_entry": {
      const entry = midpoint(signal.entryZone) ?? deriveEntryPrice(signal);
      return entry !== null && finiteOrNull(context?.fiveMinuteAtr14 ?? null) !== null;
    }
    case "kronos_runner_exit":
      return strongKronosContinuation(signal);
    case "kronos_flip_exit":
      return kronosConflicts(signal) || signal.kronosConfidenceBucket === "WEAK";
    case "whale_conflict_exit":
      return whaleDisagrees(signal);
    case "kronos_strong_agree_only":
      return signal.kronosConfidenceBucket === "STRONG" && kronosAgrees(signal);
    case "whale_agree_only":
      return whaleAgrees(signal);
    case "kronos_and_whale_agree":
      return strongKronosContinuation(signal) && whaleAgrees(signal);
    case "fib_entry_plus_kronos_exit":
      return !!context?.fibonacci && signal.kronosBias !== "UNAVAILABLE";
    case "fib_entry_plus_whale_confirm":
      return !!context?.fibonacci && whaleAgrees(signal);
    case "indicator_confluence_only":
      return isDirectionAligned(signal) && (signal.analysisContext?.riskReward ?? 0) >= 1.5;
    default:
      return outcome.result !== "EXPIRED";
  }
}

function evaluateShadowVariant(signal: TrackedSignal, outcome: OutcomeWindow | null, variantKey: ShadowVariantKey): OutcomeWindow | null {
  if (outcome === null || !isVariantEligible(signal, outcome, variantKey)) {
    return null;
  }

  const entryPrice = customEntryForVariant(signal, variantKey) ?? deriveEntryPrice(signal);
  const fastTp1Result: OutcomeWindow["result"] =
    outcome.result === "SL" ? "SL" : outcome.tp1Hit ? "TP1" : outcome.result;
  const kronosRunnerResult: OutcomeWindow["result"] =
    outcome.tp3Hit ? "TP3" : outcome.tp2Hit ? "TP2" : outcome.tp1Hit ? "TP1" : outcome.result;
  const extensionResult: OutcomeWindow["result"] =
    outcome.tp3Hit ? "TP3" : outcome.tp2Hit ? "TP2" : outcome.tp1Hit ? "TP1" : outcome.result;

  let result = outcome.result;
  let exitPrice = syntheticExitPrice(signal, outcome, result);
  let grossOverride: number | null = null;
  let netOverride: number | null = null;

  switch (variantKey) {
    case "tp1_fast_exit":
    case "whale_conflict_exit":
    case "kronos_flip_exit":
      result = fastTp1Result;
      exitPrice = syntheticExitPrice(signal, outcome, result);
      break;
    case "kronos_runner_exit":
      result = strongKronosContinuation(signal) ? kronosRunnerResult : fastTp1Result;
      exitPrice = syntheticExitPrice(signal, outcome, result);
      break;
    case "fib_extension_exit":
      result = extensionResult;
      exitPrice = syntheticExitPrice(signal, outcome, result);
      break;
    case "tp1_50_tp2_runner": {
      const entry = entryPrice ?? deriveEntryPrice(signal);
      if (entry !== null) {
        const tp1Metrics = deriveMetricsFromCustomEntry(signal, cloneOutcome(outcome, { result: outcome.tp1Hit ? "TP1" : outcome.result }), entry, syntheticExitPrice(signal, outcome, outcome.tp1Hit ? "TP1" : outcome.result));
        const tp2Metrics = deriveMetricsFromCustomEntry(signal, cloneOutcome(outcome, { result: outcome.tp2Hit ? "TP2" : outcome.tp1Hit ? "TP1" : outcome.result }), entry, syntheticExitPrice(signal, outcome, outcome.tp2Hit ? "TP2" : outcome.tp1Hit ? "TP1" : outcome.result));
        if (tp1Metrics.grossRResult !== null && tp2Metrics.grossRResult !== null) {
          grossOverride = roundMetric(tp1Metrics.grossRResult * 0.5 + tp2Metrics.grossRResult * 0.5);
          netOverride = tp1Metrics.netRResult !== null && tp2Metrics.netRResult !== null
            ? roundMetric(tp1Metrics.netRResult * 0.5 + tp2Metrics.netRResult * 0.5)
            : null;
          result = outcome.tp2Hit ? "TP2" : outcome.tp1Hit ? "TP1" : outcome.result;
          exitPrice = syntheticExitPrice(signal, outcome, result);
        }
      }
      break;
    }
    case "trail_after_tp1":
      result = outcome.tp2Hit ? "TP2" : outcome.tp1Hit ? "TP1" : outcome.result;
      exitPrice = syntheticExitPrice(signal, outcome, result);
      break;
    default:
      break;
  }

  const metrics = entryPrice !== null
    ? deriveMetricsFromCustomEntry(signal, cloneOutcome(outcome, { result }), entryPrice, exitPrice)
    : {
        grossRResult: null,
        netRResult: null,
        profitableAfterCosts: false,
        outcomeQuality: "INVALID_RISK" as const,
        missingReason: "missingEntry" as const,
        priceChangePct: 0,
        maxFavorableExcursionPct: outcome.maxFavorableExcursionPct,
        maxAdverseExcursionPct: outcome.maxAdverseExcursionPct,
      };

  return cloneOutcome(outcome, {
    metricsSource: "VARIANT",
    result,
    priceAtCheck: exitPrice ?? outcome.priceAtCheck,
    priceChangePct: metrics.priceChangePct,
    maxFavorableExcursionPct: metrics.maxFavorableExcursionPct,
    maxAdverseExcursionPct: metrics.maxAdverseExcursionPct,
    outcomeQuality: metrics.outcomeQuality,
    rResult: grossOverride ?? metrics.grossRResult,
    grossRResult: grossOverride ?? metrics.grossRResult,
    netRResult: netOverride ?? metrics.netRResult,
    profitableAfterCosts: (netOverride ?? metrics.netRResult ?? Number.NEGATIVE_INFINITY) > 0,
    slHit: result === "SL",
    tp1Hit: outcome.tp1Hit || result === "TP1" || result === "TP2" || result === "TP3",
    tp2Hit: outcome.tp2Hit || result === "TP2" || result === "TP3",
    tp3Hit: outcome.tp3Hit || result === "TP3",
  });
}

type ReplayVariantTrade = {
  attempted: boolean;
  filled: boolean;
  noFill: boolean;
  resolved: boolean;
  ambiguousSameCandle: boolean;
  result: OutcomeWindow["result"];
  entryFilledAt: string | null;
  entryFillPrice: number | null;
  exitPrice: number | null;
  grossRResult: number | null;
  netRResult: number | null;
  profitableAfterCosts: boolean;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  slHit: boolean;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  outcomeQuality: OutcomeWindow["outcomeQuality"];
};

function spreadBpsForSignal(signal: TrackedSignal): number {
  const spreadPercent = finiteOrNull(signal.analysisContext?.spreadPercent ?? null);
  return spreadPercent === null ? 0 : roundMetric(spreadPercent * 100);
}

function computeNetRWithSpread(signal: TrackedSignal, entryPrice: number, stopLoss: number | null, grossRResult: number | null): number | null {
  if (grossRResult === null || stopLoss === null || entryPrice <= 0) return null;
  const risk = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const costs = executionCostConfig();
  const roundTripCostPct = (costs.roundTripCostBps + spreadBpsForSignal(signal)) / 100;
  const riskPct = (risk / entryPrice) * 100;
  if (!Number.isFinite(riskPct) || riskPct <= 0) return null;
  return roundMetric(grossRResult - roundTripCostPct / riskPct);
}

function replayEntryAnchor(signal: TrackedSignal, entryVariant: ExecutionEntryVariant): number | null {
  const context = signal.analysisContext;
  switch (entryVariant) {
    case "base_current_entry":
      return deriveEntryPrice(signal);
    case "fib_382_entry":
      return finiteOrNull(context?.fibonacci?.retracement382 ?? null);
    case "fib_500_entry":
      return finiteOrNull(context?.fibonacci?.retracement500 ?? null);
    case "fib_618_entry":
      return finiteOrNull(context?.fibonacci?.retracement618 ?? null);
    case "vwap_retest_entry":
      return finiteOrNull(context?.fiveMinuteVwap ?? null);
    case "ema20_pullback_entry":
      return finiteOrNull(context?.fiveMinuteEma20 ?? null);
    case "no_chase_atr_entry":
      return midpoint(signal.entryZone) ?? deriveEntryPrice(signal);
  }
}

function entryVariantEligible(signal: TrackedSignal, entryVariant: ExecutionEntryVariant): boolean {
  const context = signal.analysisContext;
  switch (entryVariant) {
    case "base_current_entry":
      return deriveEntryPrice(signal) !== null;
    case "fib_382_entry":
    case "fib_500_entry":
    case "fib_618_entry":
      return !!context?.fibonacci;
    case "vwap_retest_entry":
      return finiteOrNull(context?.fiveMinuteVwap ?? null) !== null;
    case "ema20_pullback_entry":
      return finiteOrNull(context?.fiveMinuteEma20 ?? null) !== null;
    case "no_chase_atr_entry":
      return (midpoint(signal.entryZone) ?? deriveEntryPrice(signal)) !== null && finiteOrNull(context?.fiveMinuteAtr14 ?? null) !== null;
  }
}

function candleTouchesLevel(candle: Candle, level: number): boolean {
  return candle.low <= level && candle.high >= level;
}

function candleTouchesZone(candle: Candle, zone: [number, number]): boolean {
  const low = Math.min(zone[0], zone[1]);
  const high = Math.max(zone[0], zone[1]);
  return candle.high >= low && candle.low <= high;
}

function driftAtrAtScan(signal: TrackedSignal): number | null {
  const mid = midpoint(signal.entryZone) ?? deriveEntryPrice(signal);
  const atr = finiteOrNull(signal.analysisContext?.fiveMinuteAtr14 ?? null);
  const price = deriveEntryPrice(signal);
  if (mid === null || atr === null || atr <= 0 || price === null) return null;
  return Math.abs(price - mid) / atr;
}

function timelineBySignalKey(rawSignals: TrackedSignal[]): Map<string, TrackedSignal[]> {
  const map = new Map<string, TrackedSignal[]>();
  for (const raw of rawSignals.map((signal) => normalizeSignalForReplay(signal))) {
    const key = raw.normalizedSignalKey;
    const list = map.get(key) ?? [];
    list.push(raw);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort((left, right) => new Date(left.scannedAt).getTime() - new Date(right.scannedAt).getTime());
  }
  return map;
}

function normalizeSignalForReplay(signal: TrackedSignal): TrackedSignal {
  return {
    ...signal,
    entryZone: signal.entryZone ?? null,
  };
}

function firstConflictTimestamp(
  timeline: TrackedSignal[],
  fillMs: number,
  predicate: (signal: TrackedSignal) => boolean,
): number | null {
  const match = timeline.find((snapshot) => new Date(snapshot.scannedAt).getTime() > fillMs && predicate(snapshot));
  return match ? new Date(match.scannedAt).getTime() : null;
}

function replayTradeOutcome(
  signal: TrackedSignal,
  window: "1h" | "4h",
  entryVariant: ExecutionEntryVariant,
  exitVariant: ShadowPositionVariant,
  timeline: TrackedSignal[],
): ReplayVariantTrade | null {
  const outcome = signal.outcomes[window];
  if (outcome === null || !outcome.candlePath || !entryVariantEligible(signal, entryVariant)) return null;

  const candles = outcome.candlePath;
  const entryAnchor = replayEntryAnchor(signal, entryVariant);
  if (entryAnchor === null || !Number.isFinite(entryAnchor) || entryAnchor <= 0) return null;

  let fillIndex = -1;
  let fillPrice: number | null = null;
  let fillAt: string | null = null;

  if (entryVariant === "base_current_entry") {
    fillIndex = 0;
    fillPrice = entryAnchor;
    fillAt = signal.scannedAt;
  } else if (entryVariant === "no_chase_atr_entry" && (driftAtrAtScan(signal) ?? 0) <= 0.5) {
    fillIndex = 0;
    fillPrice = deriveEntryPrice(signal) ?? entryAnchor;
    fillAt = signal.scannedAt;
  } else {
    const zone: [number, number] = entryVariant === "no_chase_atr_entry" && signal.entryZone
      ? signal.entryZone
      : [entryAnchor, entryAnchor];
    fillIndex = candles.findIndex((candle) => zone[0] === zone[1] ? candleTouchesLevel(candle, entryAnchor) : candleTouchesZone(candle, zone));
    if (fillIndex !== -1) {
      fillPrice = zone[0] === zone[1] ? entryAnchor : midpoint(zone) ?? entryAnchor;
      fillAt = new Date(candles[fillIndex]!.openTime).toISOString();
    }
  }

  if (fillIndex === -1 || fillPrice === null || fillAt === null) {
    return {
      attempted: true,
      filled: false,
      noFill: true,
      resolved: false,
      ambiguousSameCandle: false,
      result: "NO_FILL",
      entryFilledAt: null,
      entryFillPrice: null,
      exitPrice: null,
      grossRResult: null,
      netRResult: null,
      profitableAfterCosts: false,
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
      slHit: false,
      maxFavorableExcursionPct: 0,
      maxAdverseExcursionPct: 0,
      outcomeQuality: "INVALID_RISK",
    };
  }

  const stopLoss = signal.stopLoss;
  let currentStop = stopLoss;
  let state: "PRE_TP1" | "RUNNER" | "CLOSED" = "PRE_TP1";
  let remaining = 1;
  let realizedGross = 0;
  let realizedNet = 0;
  let result: OutcomeWindow["result"] = outcome.result === "EXPIRED" ? "EXPIRED" : "OPEN";
  let exitPrice: number | null = null;
  let ambiguousSameCandle = false;
  let tp1Hit = false;
  let tp2Hit = false;
  let tp3Hit = false;
  let slHit = false;
  let maxFavorableExcursionPct = 0;
  let maxAdverseExcursionPct = 0;

  const riskDistance = stopLoss === null ? null : Math.abs(fillPrice - stopLoss);
  const atr = finiteOrNull(signal.analysisContext?.fiveMinuteAtr14 ?? null) ?? 0;
  const ema20 = finiteOrNull(signal.analysisContext?.fiveMinuteEma20 ?? null);
  const vwap = finiteOrNull(signal.analysisContext?.fiveMinuteVwap ?? null);
  const whaleFlipMs = firstConflictTimestamp(timeline, new Date(fillAt).getTime(), (snapshot) => whaleDisagrees(snapshot));
  const kronosFlipMs = firstConflictTimestamp(timeline, new Date(fillAt).getTime(), (snapshot) => kronosConflicts(snapshot) || snapshot.kronosConfidenceBucket === "WEAK");

  const applyRealizedSlice = (exit: number, size: number) => {
    if (stopLoss === null || riskDistance === null || riskDistance <= 0) return;
    const gross =
      signal.direction === "LONG"
        ? (exit - fillPrice) / riskDistance
        : (fillPrice - exit) / riskDistance;
    const net = computeNetRWithSpread(signal, fillPrice, stopLoss, gross);
    realizedGross = roundMetric(realizedGross + gross * size);
    realizedNet = roundMetric(realizedNet + (net ?? 0) * size);
    remaining = roundMetric(Math.max(0, remaining - size));
  };

  const firstExitIndex = fillAt === signal.scannedAt ? fillIndex : fillIndex + 1;
  for (let index = firstExitIndex; index < candles.length && state !== "CLOSED"; index += 1) {
    const candle = candles[index]!;
    const candleTimeMs = candle.openTime;
    const favorablePrice = signal.direction === "LONG" ? candle.high : candle.low;
    const adversePrice = signal.direction === "LONG" ? candle.low : candle.high;
    maxFavorableExcursionPct = Math.max(maxFavorableExcursionPct, Math.abs(((favorablePrice - fillPrice) / fillPrice) * 100));
    maxAdverseExcursionPct = Math.max(maxAdverseExcursionPct, Math.abs(((adversePrice - fillPrice) / fillPrice) * 100));

    const stopTouched = currentStop !== null && (signal.direction === "LONG" ? candle.low <= currentStop : candle.high >= currentStop);
    const tp1Touched = signal.tp1 !== null && (signal.direction === "LONG" ? candle.high >= signal.tp1 : candle.low <= signal.tp1);
    const tp2Touched = signal.tp2 !== null && (signal.direction === "LONG" ? candle.high >= signal.tp2 : candle.low <= signal.tp2);
    const tp3Touched = signal.tp3 !== null && (signal.direction === "LONG" ? candle.high >= signal.tp3 : candle.low <= signal.tp3);

    if (state === "PRE_TP1") {
      if (stopTouched && (tp1Touched || tp2Touched || tp3Touched)) {
        ambiguousSameCandle = true;
        slHit = true;
        result = "SL";
        exitPrice = currentStop;
        applyRealizedSlice(exitPrice ?? fillPrice, 1);
        state = "CLOSED";
        continue;
      }
      if (stopTouched) {
        slHit = true;
        result = "SL";
        exitPrice = currentStop;
        applyRealizedSlice(exitPrice ?? fillPrice, 1);
        state = "CLOSED";
        continue;
      }
      if (tp1Touched && signal.tp1 !== null) {
        tp1Hit = true;
        if (exitVariant === "tp1_full_exit") {
          result = "TP1";
          exitPrice = signal.tp1;
          applyRealizedSlice(signal.tp1, 1);
          state = "CLOSED";
          continue;
        }
        const tp1Slice = exitVariant === "tp1_70_runner30" ? 0.7 : 0.5;
        applyRealizedSlice(signal.tp1, tp1Slice);
        currentStop = fillPrice;
        state = "RUNNER";
        result = "TP1";
        exitPrice = signal.tp1;
        continue;
      }
    } else if (state === "RUNNER") {
      if (exitVariant === "trail_after_tp1" && atr > 0 && currentStop !== null) {
        currentStop = signal.direction === "LONG"
          ? Math.max(currentStop, candle.close - atr)
          : Math.min(currentStop, candle.close + atr);
      }
      if (stopTouched) {
        slHit = true;
        exitPrice = currentStop;
        applyRealizedSlice(exitPrice ?? fillPrice, remaining);
        state = "CLOSED";
        continue;
      }
      if (exitVariant === "vwap_loss_exit" && ((signal.direction === "LONG" && ((vwap !== null && candle.close < vwap) || (ema20 !== null && candle.close < ema20))) || (signal.direction === "SHORT" && ((vwap !== null && candle.close > vwap) || (ema20 !== null && candle.close > ema20))))) {
        exitPrice = candle.close;
        applyRealizedSlice(exitPrice, remaining);
        state = "CLOSED";
        continue;
      }
      if (exitVariant === "whale_conflict_exit" && whaleFlipMs !== null && candleTimeMs >= whaleFlipMs) {
        exitPrice = candle.close;
        applyRealizedSlice(exitPrice, remaining);
        state = "CLOSED";
        continue;
      }
      if ((exitVariant === "kronos_flip_exit" || exitVariant === "kronos_runner_exit") && kronosFlipMs !== null && candleTimeMs >= kronosFlipMs) {
        exitPrice = candle.close;
        applyRealizedSlice(exitPrice, remaining);
        state = "CLOSED";
        continue;
      }
      if (exitVariant === "kronos_runner_exit" && tp3Touched && signal.tp3 !== null) {
        tp3Hit = true;
        result = "TP3";
        exitPrice = signal.tp3;
        applyRealizedSlice(signal.tp3, remaining);
        state = "CLOSED";
        continue;
      }
      if (tp2Touched && signal.tp2 !== null) {
        tp2Hit = true;
        result = "TP2";
        exitPrice = signal.tp2;
        applyRealizedSlice(signal.tp2, remaining);
        state = "CLOSED";
        continue;
      }
    }
  }

  if (state !== "CLOSED") {
    const lastClose = candles.slice(firstExitIndex).at(-1)?.close ?? fillPrice;
    exitPrice = lastClose;
    if (remaining > 0 && stopLoss !== null && riskDistance !== null && riskDistance > 0) {
      const gross =
        signal.direction === "LONG"
          ? (lastClose - fillPrice) / riskDistance
          : (fillPrice - lastClose) / riskDistance;
      const net = computeNetRWithSpread(signal, fillPrice, stopLoss, gross);
      realizedGross = roundMetric(realizedGross + gross * remaining);
      realizedNet = roundMetric(realizedNet + (net ?? 0) * remaining);
    }
    result = outcome.result === "OPEN" ? "OPEN" : "EXPIRED";
  }

  return {
    attempted: true,
    filled: true,
    noFill: false,
    resolved: !["OPEN", "EXPIRED", "NO_FILL"].includes(result),
    ambiguousSameCandle,
    result,
    entryFilledAt: fillAt,
    entryFillPrice: fillPrice,
    exitPrice,
    grossRResult: Number.isFinite(realizedGross) ? roundMetric(realizedGross) : null,
    netRResult: Number.isFinite(realizedNet) ? roundMetric(realizedNet) : null,
    profitableAfterCosts: realizedNet > 0,
    tp1Hit,
    tp2Hit,
    tp3Hit,
    slHit,
    maxFavorableExcursionPct: roundMetric(maxFavorableExcursionPct),
    maxAdverseExcursionPct: roundMetric(maxAdverseExcursionPct),
    outcomeQuality: stopLoss === null || riskDistance === null || riskDistance <= 0 ? "INVALID_RISK" : "VALID_RISK",
  };
}

function buildReplayVariantCombinationStats(rawSignals: TrackedSignal[], uniqueSignals: TrackedSignal[], window: "1h" | "4h"): VariantCombinationStats[] {
  const timelineMap = timelineBySignalKey(rawSignals);
  const combinations: VariantCombinationStats[] = [];

  for (const entryVariant of REPLAY_ENTRY_VARIANTS) {
    for (const exitVariant of REPLAY_EXIT_VARIANTS) {
      const replays = uniqueSignals
        .map((signal) => replayTradeOutcome(signal, window, entryVariant, exitVariant, timelineMap.get(signal.normalizedSignalKey) ?? [signal]))
        .filter((value): value is ReplayVariantTrade => value !== null);

      if (replays.length === 0) continue;

      const attempted = replays.filter((replay) => replay.attempted).length;
      const filledTrades = replays.filter((replay) => replay.filled);
      const resolvedTrades = filledTrades.filter((replay) => replay.resolved);
      const noFill = replays.filter((replay) => replay.noFill).length;
      const validResolvedTrades = resolvedTrades.filter((replay) => replay.outcomeQuality === "VALID_RISK");
      const winners = validResolvedTrades.filter((replay) => (replay.netRResult ?? Number.NEGATIVE_INFINITY) > 0);
      const losers = validResolvedTrades.filter((replay) => (replay.netRResult ?? 0) < 0);
      const grossSamples = validResolvedTrades.map((replay) => replay.grossRResult).filter((value): value is number => value !== null && Number.isFinite(value));
      const netSamples = validResolvedTrades.map((replay) => replay.netRResult).filter((value): value is number => value !== null && Number.isFinite(value));
      const winSamples = validResolvedTrades.map((replay) => replay.netRResult).filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
      const lossSamples = validResolvedTrades.map((replay) => replay.netRResult).filter((value): value is number => value !== null && Number.isFinite(value) && value < 0);
      const loserMagnitude = Math.abs(losers.reduce((sum, replay) => sum + (replay.netRResult ?? 0), 0));

      combinations.push({
        entryVariant,
        exitVariant,
        attempted,
        filled: filledTrades.length,
        noFill,
        resolved: validResolvedTrades.length,
        validResolved: validResolvedTrades.length,
        tp1: filledTrades.filter((replay) => replay.tp1Hit).length,
        tp2: filledTrades.filter((replay) => replay.tp2Hit).length,
        tp3: filledTrades.filter((replay) => replay.tp3Hit).length,
        profitableTp1: filledTrades.filter((replay) => replay.tp1Hit && replay.profitableAfterCosts).length,
        sl: filledTrades.filter((replay) => replay.slHit).length,
        winRate: validResolvedTrades.length > 0 ? roundMetric(winners.length / validResolvedTrades.length) : 0,
        grossAvgR: grossSamples.length > 0 ? roundMetric(grossSamples.reduce((sum, value) => sum + value, 0) / grossSamples.length) : null,
        netAvgR: netSamples.length > 0 ? roundMetric(netSamples.reduce((sum, value) => sum + value, 0) / netSamples.length) : null,
        profitFactor: validResolvedTrades.length === 0 || loserMagnitude === 0 ? null : roundMetric(winners.reduce((sum, replay) => sum + (replay.netRResult ?? 0), 0) / loserMagnitude),
        avgWinR: winSamples.length > 0 ? roundMetric(winSamples.reduce((sum, value) => sum + value, 0) / winSamples.length) : null,
        avgLossR: lossSamples.length > 0 ? roundMetric(lossSamples.reduce((sum, value) => sum + value, 0) / lossSamples.length) : null,
        expectancyPerTrade: netSamples.length > 0 ? roundMetric(netSamples.reduce((sum, value) => sum + value, 0) / netSamples.length) : null,
        runnerSuccessRate: filledTrades.length > 0 ? roundMetric(filledTrades.filter((replay) => replay.tp2Hit || replay.tp3Hit).length / filledTrades.length) : 0,
        ambiguousSameCandleCount: filledTrades.filter((replay) => replay.ambiguousSameCandle).length,
        sampleTier: toReplayTier(validResolvedTrades.length),
      });
    }
  }

  return combinations.sort((left, right) => {
    const netDiff = (right.netAvgR ?? Number.NEGATIVE_INFINITY) - (left.netAvgR ?? Number.NEGATIVE_INFINITY);
    if (netDiff !== 0) return netDiff;
    return right.filled - left.filled;
  });
}

function toReplayTier(filled: number): "early" | "provisional" | "usable" {
  if (filled > 100) return "usable";
  if (filled >= 30) return "provisional";
  return "early";
}

function summarizeSubset(subset: TrackedSignal[], window: "1h" | "4h"): Omit<StatusStats, "total"> {
  const withOutcome = subset.filter((s) => s.outcomes[window] !== null);
  const resolved = withOutcome.filter((s) => {
    const result = s.outcomes[window]?.result;
    return result !== "OPEN" && result !== "EXPIRED";
  });
  const validRisk = withOutcome.filter((s) => s.outcomes[window]?.outcomeQuality === "VALID_RISK").length;
  const invalidRisk = withOutcome.filter((s) => s.outcomes[window]?.outcomeQuality === "INVALID_RISK").length;
  const tp1Hit = withOutcome.filter((s) => s.outcomes[window]?.tp1Hit).length;
  const profitableTp1Hit = withOutcome.filter((signal) => {
    const outcome = signal.outcomes[window];
    if (!outcome?.tp1Hit) return false;
    const metrics = resolveOutcomeMetrics(signal, outcome);
    return metrics.netRResult !== null && metrics.netRResult > 0;
  }).length;
  const tp2Hit = withOutcome.filter((s) => s.outcomes[window]?.tp2Hit).length;
  const tp3Hit = withOutcome.filter((s) => s.outcomes[window]?.tp3Hit).length;
  const slHit = withOutcome.filter((s) => s.outcomes[window]?.result === "SL").length;
  const open = withOutcome.filter((s) => {
    const result = s.outcomes[window]?.result;
    return result === "OPEN" || result === "EXPIRED";
  }).length;
  const avgMfe =
    withOutcome.length > 0
      ? roundMetric(withOutcome.reduce((sum, s) => sum + (s.outcomes[window]?.maxFavorableExcursionPct ?? 0), 0) / withOutcome.length)
      : 0;
  const avgMae =
    withOutcome.length > 0
      ? roundMetric(withOutcome.reduce((sum, s) => sum + (s.outcomes[window]?.maxAdverseExcursionPct ?? 0), 0) / withOutcome.length)
      : 0;
  const avgRUnknownReasons = withOutcome.reduce<AvgRUnknownReasons>(
    (counts, signal) => {
      const outcome = signal.outcomes[window];
      if (!outcome) return counts;
      const metrics = resolveOutcomeMetrics(signal, outcome);
      if (metrics.missingReason !== null) {
        counts[metrics.missingReason] += 1;
      } else if (outcome.outcomeQuality === "INVALID_RISK") {
        counts.invalidRisk += 1;
      }
      return counts;
    },
    { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 0, noCandlePath: 0 },
  );
  const grossRResults = withOutcome
    .map((signal) => {
      const outcome = signal.outcomes[window];
      if (outcome === null || outcome.outcomeQuality !== "VALID_RISK") return null;
      return resolveOutcomeMetrics(signal, outcome).grossRResult;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const netRResults = withOutcome
    .map((signal) => {
      const outcome = signal.outcomes[window];
      if (outcome === null || outcome.outcomeQuality !== "VALID_RISK") return null;
      return resolveOutcomeMetrics(signal, outcome).netRResult;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const avgGrossRResult =
    grossRResults.length > 0 ? roundMetric(grossRResults.reduce((sum, value) => sum + value, 0) / grossRResults.length) : null;
  const avgNetRResult =
    netRResults.length > 0 ? roundMetric(netRResults.reduce((sum, value) => sum + value, 0) / netRResults.length) : null;

  return {
    withOutcome: withOutcome.length,
    resolved: resolved.length,
    sampleTier: getSampleTier(resolved.length),
    validRisk,
    invalidRisk,
    tp1Hit,
    profitableTp1Hit,
    tp2Hit,
    tp3Hit,
    slHit,
    open,
    hitRate: withOutcome.length > 0 ? Math.round((tp1Hit / withOutcome.length) * 1000) / 1000 : 0,
    tp1Rate: withOutcome.length > 0 ? Math.round((tp1Hit / withOutcome.length) * 1000) / 1000 : 0,
    profitableTp1Rate: withOutcome.length > 0 ? Math.round((profitableTp1Hit / withOutcome.length) * 1000) / 1000 : 0,
    tp2Rate: withOutcome.length > 0 ? Math.round((tp2Hit / withOutcome.length) * 1000) / 1000 : 0,
    slRate: withOutcome.length > 0 ? Math.round((slHit / withOutcome.length) * 1000) / 1000 : 0,
    avgMaxFavorableExcursionPct: avgMfe,
    avgMaxAdverseExcursionPct: avgMae,
    avgRResult: avgGrossRResult,
    avgGrossRResult,
    avgNetRResult,
    avgRUnknownReasons,
  };
}

function makeAgreementStats(subset: TrackedSignal[], window: "1h" | "4h"): AgreementStats {
  const summary = summarizeSubset(subset, window);
  return {
    total: subset.length,
    withOutcome: summary.withOutcome,
    resolved: summary.resolved,
    sampleTier: summary.sampleTier,
    validRisk: summary.validRisk,
    invalidRisk: summary.invalidRisk,
    tp1Hit: summary.tp1Hit,
    profitableTp1Hit: summary.profitableTp1Hit,
    tp2Hit: summary.tp2Hit,
    slHit: summary.slHit,
    hitRate: summary.hitRate,
    tp1Rate: summary.tp1Rate,
    profitableTp1Rate: summary.profitableTp1Rate,
    tp2Rate: summary.tp2Rate,
    slRate: summary.slRate,
    avgMaxFavorableExcursionPct: summary.avgMaxFavorableExcursionPct,
    avgMaxAdverseExcursionPct: summary.avgMaxAdverseExcursionPct,
    avgRResult: summary.avgRResult,
    avgGrossRResult: summary.avgGrossRResult,
    avgNetRResult: summary.avgNetRResult,
    avgRUnknownReasons: summary.avgRUnknownReasons,
  };
}

function makeStatusStats(subset: TrackedSignal[], window: "1h" | "4h"): StatusStats {
  const summary = summarizeSubset(subset, window);
  return {
    total: subset.length,
    ...summary,
  };
}

function buildShadowVariantStats(uniqueSignals: TrackedSignal[], window: "1h" | "4h"): ShadowVariantStats[] {
  return SHADOW_VARIANTS.map((variant) => {
    const eligibleSignals = uniqueSignals
      .map((signal) => {
        const variantOutcome = evaluateShadowVariant(signal, signal.outcomes[window], variant.key);
        if (variantOutcome === null) {
          return null;
        }
        return {
          ...signal,
          outcomes: {
            ...signal.outcomes,
            [window]: variantOutcome,
          },
        } as TrackedSignal;
      })
      .filter((signal): signal is TrackedSignal => signal !== null);
    const summary = summarizeSubset(eligibleSignals, window);
    const variantNetResults = eligibleSignals
      .map((signal) => {
        const outcome = signal.outcomes[window];
        if (outcome === null || outcome.outcomeQuality !== "VALID_RISK") return null;
        return resolveOutcomeMetrics(signal, outcome).netRResult;
      })
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const positiveNet = variantNetResults.filter((value) => value > 0);
    const negativeNetMagnitude = Math.abs(variantNetResults.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    const profitFactor =
      variantNetResults.length === 0 || negativeNetMagnitude === 0
        ? null
        : roundMetric(positiveNet.reduce((sum, value) => sum + value, 0) / negativeNetMagnitude);
    return {
      key: variant.key,
      label: variant.label,
      category: variant.category,
      signals: eligibleSignals.length,
      profitFactor,
      ...summary,
    };
  });
}

function pickBestStatusByTp1Rate(byStatus: Record<string, StatusStats>): string | null {
  return (["TRADE_NOW", "READY", "WAIT", "WATCH"] as const)
    .filter((status) => byStatus[status].resolved > 0)
    .sort((a, b) => byStatus[b].tp1Rate - byStatus[a].tp1Rate)[0] ?? null;
}

function pickBestStatusByAvgR(byStatus: Record<string, StatusStats>): string | null {
  return (["TRADE_NOW", "READY", "WAIT", "WATCH"] as const)
    .filter((status) => byStatus[status].avgNetRResult !== null)
    .sort((a, b) => (byStatus[b].avgNetRResult ?? Number.NEGATIVE_INFINITY) - (byStatus[a].avgNetRResult ?? Number.NEGATIVE_INFINITY))[0] ?? null;
}

function pickWorstStatus(byStatus: Record<string, StatusStats>): string | null {
  return (["TRADE_NOW", "READY", "WAIT", "WATCH"] as const)
    .filter((status) => byStatus[status].resolved > 0)
    .sort((a, b) => {
      const avgDiff = (byStatus[a].avgNetRResult ?? Number.POSITIVE_INFINITY) - (byStatus[b].avgNetRResult ?? Number.POSITIVE_INFINITY);
      if (avgDiff !== 0) return avgDiff;
      return byStatus[a].tp1Rate - byStatus[b].tp1Rate;
    })[0] ?? null;
}

function buildInsights(
  byStatus: Record<string, StatusStats>,
  byDirection: Record<string, AgreementStats>,
  kronosUseful: boolean,
  whaleAgreement: PerformanceStats["whaleAgreement"],
): PerformanceInsightCard[] {
  const bestTp1Status = pickBestStatusByTp1Rate(byStatus);
  const bestAvgRStatus = pickBestStatusByAvgR(byStatus);
  const worstStatus = pickWorstStatus(byStatus);
  const longStats = byDirection.LONG;
  const shortStats = byDirection.SHORT;

  const directionBias =
    longStats.resolved >= 10 && shortStats.resolved >= 10
      ? (longStats.avgNetRResult ?? 0) > (shortStats.avgNetRResult ?? 0)
        ? {
            value: "Long edge stronger",
            tone: "amber" as const,
            detail: `LONG Net Avg R ${(longStats.avgNetRResult ?? 0).toFixed(2)} vs SHORT ${(shortStats.avgNetRResult ?? 0).toFixed(2)} on resolved samples ${longStats.resolved}/${shortStats.resolved}.`,
          }
        : (shortStats.avgNetRResult ?? 0) > (longStats.avgNetRResult ?? 0)
          ? {
              value: "Short edge stronger",
              tone: "amber" as const,
              detail: `SHORT Net Avg R ${(shortStats.avgNetRResult ?? 0).toFixed(2)} vs LONG ${(longStats.avgNetRResult ?? 0).toFixed(2)} on resolved samples ${shortStats.resolved}/${longStats.resolved}.`,
            }
          : {
              value: "Bias balanced",
              tone: "slate" as const,
              detail: `Long and short performance are similar on current resolved samples.`,
            }
      : {
          value: "Bias inconclusive",
          tone: "slate" as const,
          detail: `Need deeper resolved samples before trusting long vs short bias.`,
        };

  const whaleUseful =
    whaleAgreement.agrees.resolved >= 10 &&
    whaleAgreement.disagrees.resolved >= 10 &&
    (whaleAgreement.agrees.avgNetRResult ?? Number.NEGATIVE_INFINITY) > (whaleAgreement.disagrees.avgNetRResult ?? Number.NEGATIVE_INFINITY);

  return [
    {
      label: "Best TP1 status",
      value: bestTp1Status ?? "No resolved sample",
      tone: bestTp1Status ? "green" : "slate",
      detail: bestTp1Status ? `${bestTp1Status} resolves TP1 at ${(byStatus[bestTp1Status].tp1Rate * 100).toFixed(1)}% on ${byStatus[bestTp1Status].resolved} resolved signals.` : "No status has resolved outcomes yet.",
    },
    {
      label: "Best Avg R",
      value: bestAvgRStatus ?? "Unknown",
      tone: bestAvgRStatus ? "green" : "slate",
      detail: bestAvgRStatus ? `${bestAvgRStatus} averages gross ${(byStatus[bestAvgRStatus].avgGrossRResult ?? 0).toFixed(2)}R and net ${(byStatus[bestAvgRStatus].avgNetRResult ?? 0).toFixed(2)}R on valid resolved samples.` : "No status has valid resolved R samples yet.",
    },
    {
      label: "Worst status",
      value: worstStatus ?? "No resolved sample",
      tone: worstStatus ? "amber" : "slate",
      detail: worstStatus ? `${worstStatus} is the weakest current status by Avg R / TP1 mix.` : "No status has enough resolved data to rank the worst bucket.",
    },
    {
      label: "Long vs Short",
      value: directionBias.value,
      tone: directionBias.tone,
      detail: directionBias.detail,
    },
    {
      label: "Kronos signal",
      value: kronosUseful ? "Useful" : "Inconclusive",
      tone: kronosUseful ? "green" : "slate",
      detail: kronosUseful
        ? `Kronos STRONG/MEDIUM agree buckets outperform disagreements on net Avg R. WEAK Kronos stays ignored.`
        : `Kronos STRONG/MEDIUM agree-disagree buckets do not yet show a strong enough resolved net edge. WEAK Kronos stays ignored.`,
    },
    {
      label: "Whale signal",
      value: whaleUseful ? "Useful" : "Inconclusive",
      tone: whaleUseful ? "green" : "slate",
      detail: whaleUseful
        ? `Whale-agree signals outperform disagreements on net Avg R with enough resolved sample.`
        : `Whale agree/disagree buckets do not yet show a strong enough resolved net edge.`,
    },
  ];
}

function buildDedupeAudit(rawSignals: TrackedSignal[], uniqueSignals: TrackedSignal[], suppressedDuplicateScans: number): PerformanceStats["dedupeAudit"] {
  const activeOpenSignals = uniqueSignals.filter((signal) => {
    const followThrough = signal.outcomes[SECONDARY_WINDOW];
    return (followThrough === null || followThrough.result === "OPEN") && Date.now() - new Date(signal.lastSeenAt).getTime() < ACTIVE_SIGNAL_WINDOW_MS;
  }).length;

  let note = "Duplicate suppression is active.";
  if (suppressedDuplicateScans === 0) {
    note = rawSignals.length === uniqueSignals.length
      ? "Dedupe may be too strict or identity fields are too volatile. Recent scans likely changed direction, entry zone, signal family, resolved state, or fell outside the 60 minute cooldown."
      : "No duplicate scans were suppressed in the current sample.";
  }

  return {
    duplicateSuppressionWindowMinutes: DUPLICATE_SUPPRESSION_WINDOW_MINUTES,
    activeOpenSignals,
    rawScans: rawSignals.length,
    uniqueSignals: uniqueSignals.length,
    note,
  };
}

function buildWindowSnapshot(
  rawSignals: TrackedSignal[],
  uniqueSignals: TrackedSignal[],
  window: "1h" | "4h",
  timing?: ComputePerformanceTimingBreakdown,
): PerformanceWindowSnapshot {
  const aggregateStartMs = Date.now();
  const byStatus: Record<string, StatusStats> = {};
  for (const st of ["TRADE_NOW", "READY", "WAIT", "WATCH"] as const) {
    byStatus[st] = makeStatusStats(uniqueSignals.filter((s) => s.finalStatus === st), window);
  }

  const byDirection: Record<string, AgreementStats> = {
    LONG: makeAgreementStats(uniqueSignals.filter((s) => s.direction === "LONG"), window),
    SHORT: makeAgreementStats(uniqueSignals.filter((s) => s.direction === "SHORT"), window),
  };

  const kronosAgreement = {
    agrees: makeAgreementStats(uniqueSignals.filter((s) => kronosAgrees(s)), window),
    disagrees: makeAgreementStats(uniqueSignals.filter((s) => kronosConflicts(s)), window),
    unavailable: makeAgreementStats(uniqueSignals.filter((s) => {
      const bias = activeKronosBias(s);
      return s.horizonConflict || bias === "UNAVAILABLE" || bias === "NEUTRAL";
    }), window),
  };
  const kronosStrongAgreeSignals = uniqueSignals.filter(
    (s) =>
      s.kronosConfidenceBucket === "STRONG" &&
      kronosAgrees(s),
  );
  const kronosStrongDisagreeSignals = uniqueSignals.filter(
    (s) =>
      s.kronosConfidenceBucket === "STRONG" &&
      kronosConflicts(s),
  );
  const kronosMediumAgreeSignals = uniqueSignals.filter(
    (s) =>
      s.kronosConfidenceBucket === "MEDIUM" &&
      kronosAgrees(s),
  );
  const kronosMediumDisagreeSignals = uniqueSignals.filter(
    (s) =>
      s.kronosConfidenceBucket === "MEDIUM" &&
      kronosConflicts(s),
  );
  const kronosWeakSignals = uniqueSignals.filter((s) => s.kronosConfidenceBucket === "WEAK");
  const kronosConfidenceSplit = {
    STRONG: {
      agrees: makeAgreementStats(kronosStrongAgreeSignals, window),
      disagrees: makeAgreementStats(kronosStrongDisagreeSignals, window),
    },
    MEDIUM: {
      agrees: makeAgreementStats(kronosMediumAgreeSignals, window),
      disagrees: makeAgreementStats(kronosMediumDisagreeSignals, window),
    },
    WEAK: {
      ignored: makeAgreementStats(kronosWeakSignals, window),
    },
  };
  const kronosMaterialAgreeSignals = [...kronosStrongAgreeSignals, ...kronosMediumAgreeSignals];
  const kronosMaterialDisagreeSignals = [...kronosStrongDisagreeSignals, ...kronosMediumDisagreeSignals];
  const kronosMaterialAgreeStats = makeAgreementStats(kronosMaterialAgreeSignals, window);
  const kronosMaterialDisagreeStats = makeAgreementStats(kronosMaterialDisagreeSignals, window);
  const kronosUseful =
    kronosMaterialAgreeStats.resolved >= 10 &&
    kronosMaterialDisagreeStats.resolved >= 10 &&
    (kronosMaterialAgreeStats.avgNetRResult ?? Number.NEGATIVE_INFINITY) >
      (kronosMaterialDisagreeStats.avgNetRResult ?? Number.NEGATIVE_INFINITY);

  const whaleAgreement = {
    agrees: makeAgreementStats(
      uniqueSignals.filter(
        (s) =>
          (s.direction === "LONG" && s.whaleSignal === "BULLISH") ||
          (s.direction === "SHORT" && s.whaleSignal === "BEARISH"),
      ),
      window,
    ),
    disagrees: makeAgreementStats(
      uniqueSignals.filter(
        (s) =>
          (s.direction === "LONG" && s.whaleSignal === "BEARISH") ||
          (s.direction === "SHORT" && s.whaleSignal === "BULLISH"),
      ),
      window,
    ),
    unavailable: makeAgreementStats(uniqueSignals.filter((s) => s.whaleSignal === "UNAVAILABLE" || s.whaleSignal === "NEUTRAL"), window),
  };

  const symbolMap = new Map<string, TrackedSignal[]>();
  for (const s of uniqueSignals) {
    const list = symbolMap.get(s.symbol) ?? [];
    list.push(s);
    symbolMap.set(s.symbol, list);
  }
  const bySymbolMapStartMs = Date.now();
  const bySymbolUnsorted: SymbolStats[] = [...symbolMap.entries()]
    .map(([symbol, list]) => {
      const stats = makeAgreementStats(list, window);
      return { symbol, ...stats };
    });
  addPerformanceTiming(timing, "rankingMs", bySymbolMapStartMs);
  const rankingStartMs = Date.now();
  const bySymbol: SymbolStats[] = bySymbolUnsorted.sort((a, b) => b.hitRate - a.hitRate);
  addPerformanceTiming(timing, "rankingMs", rankingStartMs);

  const filterStartMs = Date.now();
  const withOutcome = uniqueSignals.filter((s) => s.outcomes[window] !== null);
  const resolved = withOutcome.filter((s) => {
    const result = s.outcomes[window]?.result;
    return result !== "OPEN" && result !== "EXPIRED";
  });
  const openOutcomes = withOutcome.filter((s) => {
    const result = s.outcomes[window]?.result;
    return result === "OPEN" || result === "EXPIRED";
  });
  addPerformanceTiming(timing, "filterGateMs", filterStartMs);
  addPerformanceTiming(timing, "indicatorAggregationMs", aggregateStartMs);
  const shadowVariants = measurePerformanceTiming(timing, "calibrationMs", () => buildShadowVariantStats(uniqueSignals, window));
  const variantCombinations = measurePerformanceTiming(timing, "replayVariantAnalysisMs", () => buildReplayVariantCombinationStats(rawSignals, uniqueSignals, window));
  const reasonStartMs = Date.now();
  const insights = buildInsights(byStatus, byDirection, kronosUseful, whaleAgreement);
  const tradeReadiness = [
    {
      status: "READY" as const,
      sampleTier: byStatus.READY.sampleTier,
      recommendation:
        byStatus.READY.resolved >= 30 && (byStatus.READY.avgNetRResult ?? 0) > 0
          ? "Paper trade candidate only. READY has at least 30 resolved samples and positive Net Avg R."
          : "Early signal only until READY has 30 resolved samples and positive Net Avg R.",
    },
    {
      status: "WAIT" as const,
      sampleTier: byStatus.WAIT.sampleTier,
      recommendation: "Monitor or pullback candidate. WAIT is for patience, not immediate entry.",
    },
    {
      status: "WATCH" as const,
      sampleTier: byStatus.WATCH.sampleTier,
      recommendation: "No entry. WATCH stays observational until it graduates into a better setup.",
    },
  ];
  const statusTransitions = {
    waitWorked: uniqueSignals.filter((s) => s.finalStatus === "WAIT" && ["TP1", "TP2", "TP3"].includes(s.outcomes[window]?.result ?? "")).length,
    readyFailed: uniqueSignals.filter((s) => s.finalStatus === "READY" && s.outcomes[window]?.result === "SL").length,
  };
  addPerformanceTiming(timing, "routeReasonEvaluationMs", reasonStartMs);

  return {
    window,
    withOutcome: withOutcome.length,
    resolvedOutcomes: resolved.length,
    openOutcomes: openOutcomes.length,
    lowSample: resolved.length < 10,
    byStatus,
    byDirection,
    kronosAgreement,
    kronosConfidenceSplit,
    whaleAgreement,
    bySymbol: bySymbol.filter((symbol) => symbol.resolved >= 5),
    earlySampleSymbols: bySymbol.filter((symbol) => symbol.resolved < 5),
    shadowVariants,
    variantCombinations,
    insights,
    tradeReadiness,
    statusTransitions,
  };
}

function computePerformanceInternal(
  signals: TrackedSignal[],
  lastOutcomeCheckerRunAt: string | null,
  timing?: ComputePerformanceTimingBreakdown,
): PerformanceStats {
  const normalizationStartMs = Date.now();
  const { signals: uniqueSignals, suppressedDuplicateScans } = collapseTrackedSignals(signals);
  addPerformanceTiming(timing, "candidateNormalizationMs", normalizationStartMs);
  const now = Date.now();
  const costs = executionCostConfig();
  const primary = buildWindowSnapshot(signals, uniqueSignals, PRIMARY_WINDOW, timing);
  const secondary = buildWindowSnapshot(signals, uniqueSignals, SECONDARY_WINDOW, timing);
  const diagnosticsStartMs = Date.now();
  const activeOpenSignals = uniqueSignals.filter((signal) => {
    const followThrough = signal.outcomes[SECONDARY_WINDOW];
    return (followThrough === null || followThrough.result === "OPEN") && now - new Date(signal.lastSeenAt).getTime() < ACTIVE_SIGNAL_WINDOW_MS;
  });
  const expiredSignals = uniqueSignals.filter((signal) => {
    const followThrough = signal.outcomes[SECONDARY_WINDOW];
    return followThrough?.result === "EXPIRED" || ((followThrough === null || followThrough.result === "OPEN") && now - new Date(signal.lastSeenAt).getTime() >= ACTIVE_SIGNAL_WINDOW_MS);
  });
  const invalidRiskSignals = uniqueSignals.filter((signal) => signal.outcomes[PRIMARY_WINDOW]?.outcomeQuality === "INVALID_RISK").length;
  const pending1h = uniqueSignals
    .filter((signal) => signal.outcomes["1h"] === null)
    .map((signal) => new Date(signal.scannedAt).getTime() + 60 * 60 * 1000);
  const pending4h = uniqueSignals
    .filter((signal) => signal.outcomes["4h"] === null)
    .map((signal) => new Date(signal.scannedAt).getTime() + 4 * 60 * 60 * 1000);
  const oldestActiveSignalMs =
    activeOpenSignals.length > 0
      ? Math.min(...activeOpenSignals.map((signal) => new Date(signal.firstSeenAt).getTime()))
      : null;

  const performance: PerformanceStats = {
    primaryWindow: PRIMARY_WINDOW,
    secondaryWindow: SECONDARY_WINDOW,
    executionCost: costs,
    totalSignals: uniqueSignals.length,
    rawScans: signals.length,
    uniqueTrackedSignals: uniqueSignals.length,
    suppressedDuplicateScans,
    withOutcome: primary.withOutcome,
    resolvedOutcomes: primary.resolvedOutcomes,
    openOutcomes: primary.openOutcomes,
    activeOpenSignals: activeOpenSignals.length,
    expiredSignals: expiredSignals.length,
    invalidRiskSignals,
    lowSample: primary.lowSample,
    byStatus: primary.byStatus,
    byDirection: primary.byDirection,
    kronosAgreement: primary.kronosAgreement,
    kronosConfidenceSplit: primary.kronosConfidenceSplit,
    whaleAgreement: primary.whaleAgreement,
    bySymbol: primary.bySymbol,
    earlySampleSymbols: primary.earlySampleSymbols,
    insights: primary.insights,
    tradeReadiness: primary.tradeReadiness,
    dedupeAudit: buildDedupeAudit(signals, uniqueSignals, suppressedDuplicateScans),
    migrationAudit: {
      currentCanonicalSample: uniqueSignals.length,
      archivedPreDedupeSample: 0,
      migratedResolvedOutcomes: 0,
      skippedLegacyRecords: 0,
      skippedLegacyReasons: [],
      note: "Migration audit is supplied by the tracker rebuild flow.",
    },
    lifecycle: {
      oldestActiveSignalAgeMinutes: oldestActiveSignalMs === null ? null : roundMetric((now - oldestActiveSignalMs) / (60 * 1000)),
      next1hCheckDueAt: pending1h.length > 0 ? new Date(Math.min(...pending1h)).toISOString() : null,
      next4hCheckDueAt: pending4h.length > 0 ? new Date(Math.min(...pending4h)).toISOString() : null,
      lastOutcomeCheckerRunAt,
    },
    statusTransitions: primary.statusTransitions,
    windows: {
      "1h": primary,
      "4h": secondary,
    },
    generatedAt: new Date().toISOString(),
  };
  addPerformanceTiming(timing, "diagnosticsBuildMs", diagnosticsStartMs);
  return performance;
}

export function computePerformance(signals: TrackedSignal[], lastOutcomeCheckerRunAt: string | null = null): PerformanceStats {
  return computePerformanceInternal(signals, lastOutcomeCheckerRunAt);
}

export function computePerformanceWithTiming(signals: TrackedSignal[], lastOutcomeCheckerRunAt: string | null = null): TimedPerformanceResult {
  const timing = emptyComputePerformanceTiming();
  const performance = computePerformanceInternal(signals, lastOutcomeCheckerRunAt, timing);
  return { performance, timing };
}

import { describe, expect, it } from "vitest";

import {
  buildAtrPlan,
  buildCandidate,
  calculateDangerScore,
  calculateFibonacciLevels,
  calculateTimeframeIndicators,
  chooseDirection,
  classifyStatus,
  roundPrice,
  type Candle,
  type KronosPrediction,
  type PerformanceStats,
} from "../src/index.ts";
import { buildEdgeScore } from "../src/edge.ts";
import { buildVariantSelection } from "../src/execution-plan.ts";
import { buildTradePlan } from "../src/trade-plan.ts";

function makeCandles({
  start = 100,
  step = 1,
  volumeBase = 1000,
  count = 300,
  timeStepMs = 5 * 60 * 1000,
  startTime,
}: {
  start?: number;
  step?: number;
  volumeBase?: number;
  count?: number;
  timeStepMs?: number;
  startTime?: number;
} = {}): Candle[] {
  // All default fixtures finish at the same deterministic scan instant across
  // timeframes.  That models a real snapshot and prevents future 1h candles
  // from accidentally entering a 5m-timed test.
  const seriesStart = startTime ?? Date.UTC(2026, 4, 6, 15, 0, 0) - (count - 1) * timeStepMs;
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * step;
    return {
      openTime: seriesStart + index * timeStepMs,
      open: close - step * 0.25,
      high: close + step * 0.5 + 1,
      low: close - step * 0.5 - 1,
      close,
      volume: volumeBase + index * 10,
    };
  });
}

const unavailableKronos: KronosPrediction = {
  available: false,
  reason: "Disabled adapter.",
};

function makePerfStub(): PerformanceStats {
  return {
    primaryWindow: "1h",
    secondaryWindow: "4h",
    executionCost: { feeBpsPerSide: 8, slippageBpsPerSide: 6, roundTripCostBps: 28 },
    totalSignals: 40,
    rawScans: 40,
    uniqueTrackedSignals: 40,
    suppressedDuplicateScans: 0,
    withOutcome: 30,
    resolvedOutcomes: 20,
    openOutcomes: 10,
    activeOpenSignals: 8,
    expiredSignals: 2,
    invalidRiskSignals: 1,
    lowSample: false,
    byStatus: {
      TRADE_NOW: { total: 5, withOutcome: 5, resolved: 3, sampleTier: "EARLY_SIGNAL", validRisk: 3, invalidRisk: 0, tp1Hit: 2, profitableTp1Hit: 2, tp2Hit: 1, tp3Hit: 0, slHit: 1, open: 2, hitRate: 0.4, tp1Rate: 0.4, profitableTp1Rate: 0.4, tp2Rate: 0.2, slRate: 0.2, avgMaxFavorableExcursionPct: 3, avgMaxAdverseExcursionPct: 1, avgRResult: 0.5, avgGrossRResult: 0.5, avgNetRResult: 0.42, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 2, noCandlePath: 0 } },
      READY: { total: 10, withOutcome: 10, resolved: 8, sampleTier: "PROVISIONAL", validRisk: 8, invalidRisk: 0, tp1Hit: 6, profitableTp1Hit: 5, tp2Hit: 4, tp3Hit: 1, slHit: 2, open: 2, hitRate: 0.6, tp1Rate: 0.6, profitableTp1Rate: 0.5, tp2Rate: 0.4, slRate: 0.2, avgMaxFavorableExcursionPct: 4, avgMaxAdverseExcursionPct: 1.2, avgRResult: 0.7, avgGrossRResult: 0.7, avgNetRResult: 0.58, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 2, noCandlePath: 0 } },
      WAIT: { total: 12, withOutcome: 12, resolved: 10, sampleTier: "PROVISIONAL", validRisk: 10, invalidRisk: 0, tp1Hit: 7, profitableTp1Hit: 6, tp2Hit: 3, tp3Hit: 1, slHit: 2, open: 2, hitRate: 0.583, tp1Rate: 0.583, profitableTp1Rate: 0.5, tp2Rate: 0.25, slRate: 0.166, avgMaxFavorableExcursionPct: 4.2, avgMaxAdverseExcursionPct: 1.3, avgRResult: 0.45, avgGrossRResult: 0.45, avgNetRResult: 0.34, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 2, noCandlePath: 0 } },
      WATCH: { total: 13, withOutcome: 13, resolved: 7, sampleTier: "EARLY_SIGNAL", validRisk: 7, invalidRisk: 0, tp1Hit: 3, profitableTp1Hit: 2, tp2Hit: 1, tp3Hit: 0, slHit: 3, open: 6, hitRate: 0.231, tp1Rate: 0.231, profitableTp1Rate: 0.154, tp2Rate: 0.077, slRate: 0.231, avgMaxFavorableExcursionPct: 2.2, avgMaxAdverseExcursionPct: 1.8, avgRResult: -0.1, avgGrossRResult: -0.1, avgNetRResult: -0.18, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 6, noCandlePath: 0 } },
    },
    byDirection: {
      LONG: { total: 22, withOutcome: 22, resolved: 15, sampleTier: "PROVISIONAL", validRisk: 15, invalidRisk: 0, tp1Hit: 11, profitableTp1Hit: 9, tp2Hit: 6, slHit: 4, hitRate: 0.5, tp1Rate: 0.5, profitableTp1Rate: 0.409, tp2Rate: 0.273, slRate: 0.182, avgMaxFavorableExcursionPct: 4.5, avgMaxAdverseExcursionPct: 1.2, avgRResult: 0.8, avgGrossRResult: 0.8, avgNetRResult: 0.62, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 7, noCandlePath: 0 } },
      SHORT: { total: 18, withOutcome: 18, resolved: 12, sampleTier: "PROVISIONAL", validRisk: 12, invalidRisk: 0, tp1Hit: 5, profitableTp1Hit: 3, tp2Hit: 2, slHit: 5, hitRate: 0.278, tp1Rate: 0.278, profitableTp1Rate: 0.167, tp2Rate: 0.111, slRate: 0.278, avgMaxFavorableExcursionPct: 2.8, avgMaxAdverseExcursionPct: 1.9, avgRResult: -0.2, avgGrossRResult: -0.2, avgNetRResult: -0.28, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 6, noCandlePath: 0 } },
    },
    kronosAgreement: { agrees: { total: 10, withOutcome: 10, resolved: 8, sampleTier: "PROVISIONAL", validRisk: 8, invalidRisk: 0, tp1Hit: 6, profitableTp1Hit: 5, tp2Hit: 3, slHit: 2, hitRate: 0.6, tp1Rate: 0.6, profitableTp1Rate: 0.5, tp2Rate: 0.3, slRate: 0.2, avgMaxFavorableExcursionPct: 4, avgMaxAdverseExcursionPct: 1, avgRResult: 0.8, avgGrossRResult: 0.8, avgNetRResult: 0.65, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 2, noCandlePath: 0 } }, disagrees: { total: 10, withOutcome: 10, resolved: 8, sampleTier: "PROVISIONAL", validRisk: 8, invalidRisk: 0, tp1Hit: 3, profitableTp1Hit: 2, tp2Hit: 1, slHit: 4, hitRate: 0.3, tp1Rate: 0.3, profitableTp1Rate: 0.2, tp2Rate: 0.1, slRate: 0.4, avgMaxFavorableExcursionPct: 2, avgMaxAdverseExcursionPct: 2, avgRResult: -0.2, avgGrossRResult: -0.2, avgNetRResult: -0.3, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 2, noCandlePath: 0 } }, unavailable: { total: 20, withOutcome: 20, resolved: 4, sampleTier: "EARLY_SIGNAL", validRisk: 4, invalidRisk: 0, tp1Hit: 2, profitableTp1Hit: 1, tp2Hit: 0, slHit: 1, hitRate: 0.1, tp1Rate: 0.1, profitableTp1Rate: 0.05, tp2Rate: 0, slRate: 0.05, avgMaxFavorableExcursionPct: 1.8, avgMaxAdverseExcursionPct: 1.4, avgRResult: 0.05, avgGrossRResult: 0.05, avgNetRResult: 0.01, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 16, noCandlePath: 0 } } },
    kronosConfidenceSplit: { STRONG: { agrees: { total: 5, withOutcome: 5, resolved: 4, sampleTier: "EARLY_SIGNAL", validRisk: 4, invalidRisk: 0, tp1Hit: 3, profitableTp1Hit: 3, tp2Hit: 2, slHit: 1, hitRate: 0.6, tp1Rate: 0.6, profitableTp1Rate: 0.6, tp2Rate: 0.4, slRate: 0.2, avgMaxFavorableExcursionPct: 5, avgMaxAdverseExcursionPct: 1, avgRResult: 1, avgGrossRResult: 1, avgNetRResult: 0.84, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 1, noCandlePath: 0 } }, disagrees: { total: 4, withOutcome: 4, resolved: 3, sampleTier: "EARLY_SIGNAL", validRisk: 3, invalidRisk: 0, tp1Hit: 1, profitableTp1Hit: 1, tp2Hit: 0, slHit: 2, hitRate: 0.25, tp1Rate: 0.25, profitableTp1Rate: 0.25, tp2Rate: 0, slRate: 0.5, avgMaxFavorableExcursionPct: 2, avgMaxAdverseExcursionPct: 2, avgRResult: -0.4, avgGrossRResult: -0.4, avgNetRResult: -0.52, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 1, noCandlePath: 0 } } }, MEDIUM: { agrees: { total: 5, withOutcome: 5, resolved: 4, sampleTier: "EARLY_SIGNAL", validRisk: 4, invalidRisk: 0, tp1Hit: 3, profitableTp1Hit: 2, tp2Hit: 1, slHit: 1, hitRate: 0.6, tp1Rate: 0.6, profitableTp1Rate: 0.4, tp2Rate: 0.2, slRate: 0.2, avgMaxFavorableExcursionPct: 4, avgMaxAdverseExcursionPct: 1.3, avgRResult: 0.6, avgGrossRResult: 0.6, avgNetRResult: 0.44, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 1, noCandlePath: 0 } }, disagrees: { total: 6, withOutcome: 6, resolved: 5, sampleTier: "EARLY_SIGNAL", validRisk: 5, invalidRisk: 0, tp1Hit: 2, profitableTp1Hit: 1, tp2Hit: 1, slHit: 2, hitRate: 0.333, tp1Rate: 0.333, profitableTp1Rate: 0.167, tp2Rate: 0.167, slRate: 0.333, avgMaxFavorableExcursionPct: 2.5, avgMaxAdverseExcursionPct: 1.8, avgRResult: -0.1, avgGrossRResult: -0.1, avgNetRResult: -0.18, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 1, noCandlePath: 0 } } }, WEAK: { ignored: { total: 10, withOutcome: 10, resolved: 4, sampleTier: "EARLY_SIGNAL", validRisk: 4, invalidRisk: 0, tp1Hit: 2, profitableTp1Hit: 1, tp2Hit: 0, slHit: 1, hitRate: 0.2, tp1Rate: 0.2, profitableTp1Rate: 0.1, tp2Rate: 0, slRate: 0.1, avgMaxFavorableExcursionPct: 2, avgMaxAdverseExcursionPct: 1.4, avgRResult: 0.05, avgGrossRResult: 0.05, avgNetRResult: 0.01, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 6, noCandlePath: 0 } } } },
    whaleAgreement: { agrees: { total: 14, withOutcome: 14, resolved: 10, sampleTier: "PROVISIONAL", validRisk: 10, invalidRisk: 0, tp1Hit: 8, profitableTp1Hit: 7, tp2Hit: 4, slHit: 2, hitRate: 0.571, tp1Rate: 0.571, profitableTp1Rate: 0.5, tp2Rate: 0.286, slRate: 0.143, avgMaxFavorableExcursionPct: 4.5, avgMaxAdverseExcursionPct: 1.1, avgRResult: 0.9, avgGrossRResult: 0.9, avgNetRResult: 0.72, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 4, noCandlePath: 0 } }, disagrees: { total: 12, withOutcome: 12, resolved: 9, sampleTier: "EARLY_SIGNAL", validRisk: 9, invalidRisk: 0, tp1Hit: 4, profitableTp1Hit: 2, tp2Hit: 1, slHit: 4, hitRate: 0.333, tp1Rate: 0.333, profitableTp1Rate: 0.167, tp2Rate: 0.083, slRate: 0.333, avgMaxFavorableExcursionPct: 2.6, avgMaxAdverseExcursionPct: 1.9, avgRResult: -0.25, avgGrossRResult: -0.25, avgNetRResult: -0.34, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 3, noCandlePath: 0 } }, unavailable: { total: 14, withOutcome: 14, resolved: 1, sampleTier: "EARLY_SIGNAL", validRisk: 1, invalidRisk: 0, tp1Hit: 1, profitableTp1Hit: 0, tp2Hit: 0, slHit: 0, hitRate: 0.071, tp1Rate: 0.071, profitableTp1Rate: 0, tp2Rate: 0, slRate: 0, avgMaxFavorableExcursionPct: 1.5, avgMaxAdverseExcursionPct: 1.2, avgRResult: 0.05, avgGrossRResult: 0.05, avgNetRResult: -0.01, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 13, noCandlePath: 0 } } },
    bySymbol: [{ symbol: "SOLUSDT", total: 8, withOutcome: 8, resolved: 6, sampleTier: "PROVISIONAL", validRisk: 6, invalidRisk: 0, tp1Hit: 5, profitableTp1Hit: 4, tp2Hit: 3, slHit: 1, hitRate: 0.625, tp1Rate: 0.625, profitableTp1Rate: 0.5, tp2Rate: 0.375, slRate: 0.125, avgMaxFavorableExcursionPct: 4.8, avgMaxAdverseExcursionPct: 1.1, avgRResult: 0.9, avgGrossRResult: 0.9, avgNetRResult: 0.71, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 2, noCandlePath: 0 } }],
    earlySampleSymbols: [{ symbol: "BTCUSDT", total: 4, withOutcome: 4, resolved: 4, sampleTier: "EARLY_SIGNAL", validRisk: 4, invalidRisk: 0, tp1Hit: 2, profitableTp1Hit: 2, tp2Hit: 1, slHit: 1, hitRate: 0.5, tp1Rate: 0.5, profitableTp1Rate: 0.5, tp2Rate: 0.25, slRate: 0.25, avgMaxFavorableExcursionPct: 3.5, avgMaxAdverseExcursionPct: 1.3, avgRResult: 0.45, avgGrossRResult: 0.45, avgNetRResult: 0.3, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 0, noCandlePath: 0 } }],
    insights: [],
    tradeReadiness: [],
    dedupeAudit: { duplicateSuppressionWindowMinutes: 60, activeOpenSignals: 8, rawScans: 40, uniqueSignals: 40, note: "Duplicate suppression is active." },
    migrationAudit: { currentCanonicalSample: 40, archivedPreDedupeSample: 0, migratedResolvedOutcomes: 0, skippedLegacyRecords: 0, skippedLegacyReasons: [], note: "No rebuild migration audit recorded yet." },
    lifecycle: { oldestActiveSignalAgeMinutes: 45, next1hCheckDueAt: null, next4hCheckDueAt: null, lastOutcomeCheckerRunAt: null },
    statusTransitions: { waitWorked: 2, readyFailed: 1 },
    windows: {
      "1h": { window: "1h", withOutcome: 30, resolvedOutcomes: 20, openOutcomes: 10, lowSample: false, byStatus: {} as PerformanceStats["byStatus"], byDirection: {} as PerformanceStats["byDirection"], kronosAgreement: {} as PerformanceStats["kronosAgreement"], kronosConfidenceSplit: {} as PerformanceStats["kronosConfidenceSplit"], whaleAgreement: {} as PerformanceStats["whaleAgreement"], bySymbol: [], earlySampleSymbols: [], shadowVariants: [
        { key: "base_current", label: "Base current", category: "ENTRY", signals: 12, withOutcome: 12, resolved: 10, validRisk: 10, invalidRisk: 0, tp1Hit: 7, profitableTp1Hit: 6, tp2Hit: 4, tp3Hit: 1, slHit: 2, open: 2, hitRate: 0.583, tp1Rate: 0.583, profitableTp1Rate: 0.5, tp2Rate: 0.333, slRate: 0.167, avgMaxFavorableExcursionPct: 4.4, avgMaxAdverseExcursionPct: 1.1, avgRResult: 0.8, avgGrossRResult: 0.8, avgNetRResult: 0.64, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 2, noCandlePath: 0 } },
        { key: "kronos_runner_exit", label: "Kronos runner exit", category: "EXIT", signals: 8, withOutcome: 8, resolved: 7, validRisk: 7, invalidRisk: 0, tp1Hit: 5, profitableTp1Hit: 5, tp2Hit: 4, tp3Hit: 1, slHit: 1, open: 1, hitRate: 0.625, tp1Rate: 0.625, profitableTp1Rate: 0.625, tp2Rate: 0.5, slRate: 0.125, avgMaxFavorableExcursionPct: 4.9, avgMaxAdverseExcursionPct: 1.1, avgRResult: 1.05, avgGrossRResult: 1.05, avgNetRResult: 0.88, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 1, noCandlePath: 0 } },
        { key: "whale_conflict_exit", label: "Whale conflict exit", category: "EXIT", signals: 7, withOutcome: 7, resolved: 6, validRisk: 6, invalidRisk: 0, tp1Hit: 4, profitableTp1Hit: 3, tp2Hit: 1, tp3Hit: 0, slHit: 2, open: 1, hitRate: 0.571, tp1Rate: 0.571, profitableTp1Rate: 0.429, tp2Rate: 0.143, slRate: 0.286, avgMaxFavorableExcursionPct: 3.2, avgMaxAdverseExcursionPct: 1.4, avgRResult: 0.22, avgGrossRResult: 0.22, avgNetRResult: 0.1, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 1, noCandlePath: 0 } },
        { key: "fib_500_entry", label: "Fib 0.500 entry", category: "ENTRY", signals: 6, withOutcome: 6, resolved: 5, validRisk: 5, invalidRisk: 0, tp1Hit: 3, profitableTp1Hit: 3, tp2Hit: 2, tp3Hit: 0, slHit: 1, open: 1, hitRate: 0.5, tp1Rate: 0.5, profitableTp1Rate: 0.5, tp2Rate: 0.333, slRate: 0.167, avgMaxFavorableExcursionPct: 4.1, avgMaxAdverseExcursionPct: 1.2, avgRResult: 0.86, avgGrossRResult: 0.86, avgNetRResult: 0.71, avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 1, noCandlePath: 0 } },
      ], variantCombinations: [], insights: [], tradeReadiness: [], statusTransitions: { waitWorked: 2, readyFailed: 1 } },
      "4h": { window: "4h", withOutcome: 32, resolvedOutcomes: 24, openOutcomes: 8, lowSample: false, byStatus: {} as PerformanceStats["byStatus"], byDirection: {} as PerformanceStats["byDirection"], kronosAgreement: {} as PerformanceStats["kronosAgreement"], kronosConfidenceSplit: {} as PerformanceStats["kronosConfidenceSplit"], whaleAgreement: {} as PerformanceStats["whaleAgreement"], bySymbol: [], earlySampleSymbols: [], shadowVariants: [], variantCombinations: [], insights: [], tradeReadiness: [], statusTransitions: { waitWorked: 3, readyFailed: 1 } },
    },
    generatedAt: "2026-05-07T00:00:00.000Z",
  };
}

describe("shared scanner rules", () => {
  it("calculates key indicators", () => {
    const candles = makeCandles();
    const indicators = calculateTimeframeIndicators(candles, "5m", candles.at(-1)!.openTime + 60_000);

    expect(indicators.ema20).toBeGreaterThan(0);
    expect(indicators.ema50).toBeGreaterThan(0);
    expect(indicators.ema200).toBeGreaterThan(0);
    expect(indicators.rsi14).toBeGreaterThan(50);
    expect(indicators.vwap).toBeGreaterThan(0);
  });

  it("keeps every historical fingerprint component on the completed-candle cutoff", () => {
    const candles = makeCandles({ count: 300 });
    const active = candles.at(-1)!;
    const now = active.openTime + 60_000; // the final 5m bar is still active
    const baseline = calculateTimeframeIndicators(candles, "5m", now);
    const withWildActiveBar = candles.map((candle, index) =>
      index === candles.length - 1
        ? { ...candle, high: candle.high * 10, low: candle.low * 0.1, close: candle.close * 5, volume: candle.volume * 100 }
        : candle,
    );
    const observed = calculateTimeframeIndicators(withWildActiveBar, "5m", now);

    expect(observed.ema200Available).toBe(true);
    expect(observed.completedCandleCount).toBe(baseline.completedCandleCount);
    expect(observed.sourceCandleCloseTime).toBe(baseline.sourceCandleCloseTime);
    expect(observed.atr14).toBe(baseline.atr14);
    expect(observed.vwap).toBe(baseline.vwap);
    expect(observed.volumeRatio).toBe(baseline.volumeRatio);
    expect(observed.recentHigh).toBe(baseline.recentHigh);
    expect(observed.recentLow).toBe(baseline.recentLow);
  });

  it("fails EMA200 availability closed when fewer than 250 completed candles exist", () => {
    const candles = makeCandles({ count: 249 });
    const now = candles.at(-1)!.openTime + 5 * 60_000;
    const indicators = calculateTimeframeIndicators(candles, "5m", now);
    expect(indicators.ema200).toBeNull();
    expect(indicators.ema200Available).toBe(false);
  });

  it("builds fibonacci levels in order", () => {
    const fib = calculateFibonacciLevels(makeCandles({ start: 100, step: 2, count: 120, timeStepMs: 60 * 60 * 1000 }));

    expect(fib.recentHigh).toBeGreaterThan(fib.recentLow);
    expect(fib.retracement236).toBeGreaterThan(fib.retracement618);
    expect(fib.extension1618).toBeGreaterThan(fib.extension1272);
  });

  it("creates ATR plans with stop and targets", () => {
    const fib = calculateFibonacciLevels(makeCandles({ step: 1.5, count: 120, timeStepMs: 60 * 60 * 1000 }));
    const plan = buildAtrPlan(210, 4.5, 2.1, "LONG", fib);

    expect(plan.stopLoss).not.toBeNull();
    expect(plan.takeProfit1).not.toBeNull();
    expect(plan.takeProfit3).not.toBeNull();
    expect((plan.riskReward ?? 0)).toBeGreaterThan(0);
  });

  it("separates long and short direction scores", () => {
    expect(chooseDirection(74, 51)).toBe("LONG");
    expect(chooseDirection(48, 69)).toBe("SHORT");
    expect(chooseDirection(58, 55)).toBe("NEUTRAL");
  });

  it("keeps stale and market-data failures out of structural danger", () => {
    const staleNow = Date.UTC(2026, 4, 7, 0, 0, 0);
    const indicators = {
      fiveMinute: calculateTimeframeIndicators(makeCandles({ startTime: Date.UTC(2026, 4, 5, 0, 0, 0) }), "5m", staleNow),
      fifteenMinute: calculateTimeframeIndicators(makeCandles({ timeStepMs: 15 * 60 * 1000, startTime: Date.UTC(2026, 4, 5, 0, 0, 0) }), "15m", staleNow),
      oneHour: calculateTimeframeIndicators(makeCandles({ timeStepMs: 60 * 60 * 1000, startTime: Date.UTC(2026, 4, 5, 0, 0, 0) }), "1h", staleNow),
      fibonacci: calculateFibonacciLevels(makeCandles({ timeStepMs: 60 * 60 * 1000, startTime: Date.UTC(2026, 4, 5, 0, 0, 0) })),
      atr: buildAtrPlan(200, 8, 4, "LONG", calculateFibonacciLevels(makeCandles({ timeStepMs: 60 * 60 * 1000, startTime: Date.UTC(2026, 4, 5, 0, 0, 0) }))),
    };

    const danger = calculateDangerScore({
      direction: "LONG",
      indicators,
      spread: { bid: 100, ask: 100.3, absolute: 0.3, percent: 0.3 },
      volume: { quoteVolume24h: 5_000_000, baseVolume24h: 10_000, volumeRatio5m: 0.6 },
      riskReward: 1.1,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      oneHourTrendConflict: true,
    });

    expect(danger).toBeLessThan(75);
  });

  it("applies classification rules", () => {
    expect(
      classifyStatus({
        dataFresh: true,
        spreadAcceptable: true,
        direction: "LONG",
        opportunityScore: 79,
        confidence: 74,
        dangerScore: 33,
        riskReward: 1.9,
        hasTradePlan: true,
        kronosAgrees: true,
        liquidityScore: 88,
      }),
    ).toBe("TRADE_NOW");

    expect(
      classifyStatus({
        dataFresh: false,
        spreadAcceptable: true,
        direction: "LONG",
        opportunityScore: 82,
        confidence: 80,
        dangerScore: 20,
        riskReward: 2,
        hasTradePlan: true,
        kronosAgrees: true,
        liquidityScore: 88,
      }),
    ).toBe("SKIP");
  });

  it("sorts top candidates by opportunity score", () => {
    const build = (
      symbol: string,
      {
        step,
        volumeRatio5m,
        quoteVolume24h,
        spreadPercent,
        longProbability,
        confidence,
      }: {
        step: number;
        volumeRatio5m: number;
        quoteVolume24h: number;
        spreadPercent: number;
        longProbability: number;
        confidence: number;
      },
    ) =>
      buildCandidate({
        symbol,
        candles5m: makeCandles({ step, count: 300 }),
        candles15m: makeCandles({ step, count: 300, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ step, count: 300, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100 + spreadPercent / 100, absolute: spreadPercent / 100, percent: spreadPercent },
        volume: { quoteVolume24h, baseVolume24h: 3_000_000, volumeRatio5m },
        kronos: {
          available: true,
          kronosLongProbability: longProbability,
          kronosShortProbability: 100 - longProbability,
          kronosBias: "LONG",
          kronosConfidence: confidence,
          kronosRisk: 30,
        },
        whale: { available: false, signal: "UNAVAILABLE", score: 0 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      });

    const sorted = [
      build("B", { step: 0.5, volumeRatio5m: 1.1, quoteVolume24h: 50_000_000, spreadPercent: 0.05, longProbability: 65, confidence: 60 }),
      build("A", { step: 2, volumeRatio5m: 2.2, quoteVolume24h: 300_000_000, spreadPercent: 0.02, longProbability: 88, confidence: 84 }),
      build("C", { step: -0.8, volumeRatio5m: 0.8, quoteVolume24h: 20_000_000, spreadPercent: 0.11, longProbability: 35, confidence: 40 }),
    ].sort(
      (left, right) => right.opportunityScore - left.opportunityScore,
    );

    expect(sorted.map((candidate) => candidate.opportunityScore)).toEqual(
      [...sorted.map((candidate) => candidate.opportunityScore)].sort((left, right) => right - left),
    );
    expect(sorted[0]!.opportunityScore).toBeGreaterThan(sorted[2]!.opportunityScore);
  });

  it("does not boost unavailable whale or sentiment data", () => {
    const base = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.3 }),
      candles15m: makeCandles({ step: 1.3, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.3, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const withUnavailableNonZero = buildCandidate({
      symbol: "ETHUSDT",
      candles5m: makeCandles({ step: 1.3 }),
      candles15m: makeCandles({ step: 1.3, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.3, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 80, reason: "ignored" },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 90, reason: "ignored" },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(withUnavailableNonZero.opportunityScore).toBe(base.opportunityScore);
  });

  it("real Kronos response affects confidence, not structural opportunity", () => {
    const withoutKronos = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 2 }),
      candles15m: makeCandles({ step: 2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const withKronos = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 2 }),
      candles15m: makeCandles({ step: 2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: {
        available: true,
        kronosLongProbability: 85,
        kronosShortProbability: 15,
        kronosBias: "LONG",
        kronosConfidence: 80,
        expectedVolatility: 2,
        kronosRisk: 30,
      },
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(withKronos.opportunityScore).toBe(withoutKronos.opportunityScore);
    expect(withKronos.confidence).toBe(withoutKronos.confidence);
    expect(withKronos.kronosBias).not.toBe("UNAVAILABLE");
  });

  it("real whale signal affects confidence, not structural opportunity", () => {
    const base = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const withWhale = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: true, signal: "BULLISH", score: 75, reason: "oi up" },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(withWhale.opportunityScore).toBe(base.opportunityScore);
    expect(withWhale.confidence).toBe(base.confidence);
    expect(withWhale.whale.signal).toBe("BULLISH");
  });

  it("whale disagreement does not double-count as structural danger", () => {
    const candles5m = makeCandles({ step: 1.2 });
    const candles15m = makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 });
    const candles1h = makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 });
    const indicators = {
      fiveMinute: calculateTimeframeIndicators(candles5m, "5m", candles5m.at(-1)!.openTime + 60_000),
      fifteenMinute: calculateTimeframeIndicators(candles15m, "15m", candles15m.at(-1)!.openTime + 60_000),
      oneHour: calculateTimeframeIndicators(candles1h, "1h", candles1h.at(-1)!.openTime + 60_000),
      fibonacci: calculateFibonacciLevels(candles1h),
      atr: buildAtrPlan(candles5m.at(-1)!.close, 4.5, 2.1, "LONG", calculateFibonacciLevels(candles1h)),
    };

    const alignedDanger = calculateDangerScore({
      direction: "LONG",
      indicators,
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      riskReward: 1.8,
      whale: { available: true, signal: "BULLISH", score: 80, reason: "oi up" },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      oneHourTrendConflict: false,
    });
    const conflictingDanger = calculateDangerScore({
      direction: "LONG",
      indicators,
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      riskReward: 1.8,
      whale: { available: true, signal: "BEARISH", score: 80, reason: "sell pressure" },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      oneHourTrendConflict: false,
    });

    expect(conflictingDanger).toBe(alignedDanger);
  });

  it("real sentiment signal affects confidence, not structural opportunity", () => {
    const base = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0, confidence: 0, source: "none" },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const withSentiment = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: true, signal: "BULLISH", score: 70, confidence: 70, scope: "SYMBOL", source: "reddit", reason: "social up" },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(withSentiment.opportunityScore).toBe(base.opportunityScore);
    expect(withSentiment.confidence).toBe(base.confidence);
    expect(withSentiment.sentiment.signal).toBe("BULLISH");
  });

  it("market sentiment affects confidence lightly, not structural opportunity", () => {
    const base = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0, confidence: 0, source: "none" },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const withFearGreed = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: true, signal: "BULLISH", score: 65, confidence: 55, scope: "MARKET", source: "feargreed", reason: "market bullish" },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(withFearGreed.opportunityScore).toBe(base.opportunityScore);
    expect(Math.abs(withFearGreed.confidence - base.confidence)).toBeLessThan(8);
    expect(withFearGreed.sentiment.scope).toBe("MARKET");
  });

  it("market-wide sentiment is not treated like symbol-level sentiment", () => {
    const base = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0, confidence: 0, source: "none" },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const withFearGreed = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: true, signal: "BULLISH", score: 70, confidence: 60, scope: "MARKET", source: "feargreed", reason: "market bullish" },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const withReddit = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: true, signal: "BULLISH", score: 70, confidence: 60, scope: "SYMBOL", source: "reddit", reason: "symbol bullish" },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(Math.abs(withReddit.opportunityScore - base.opportunityScore)).toBeGreaterThanOrEqual(
      Math.abs(withFearGreed.opportunityScore - base.opportunityScore),
    );
  });

  it("downgrades status one level on Kronos and whale source conflict", () => {
    const candidate = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 2 }),
      candles15m: makeCandles({ step: 2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: {
        available: true,
        kronosLongProbability: 90,
        kronosShortProbability: 10,
        kronosBias: "LONG",
        kronosConfidence: 85,
        expectedVolatility: 2,
        kronosRisk: 25,
      },
      whale: { available: true, signal: "BEARISH", score: 80, reason: "sell pressure" },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(candidate.sourceConflict).toBe(true);
    expect(candidate.status).not.toBe("TRADE_NOW");
    expect(candidate.reason.join(" ")).toContain("SOURCE_CONFLICT");
  });

  it("marks stale data as skip", () => {
    const candidate = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ startTime: Date.UTC(2026, 4, 5, 0, 0, 0) }),
      candles15m: makeCandles({ startTime: Date.UTC(2026, 4, 5, 0, 0, 0), timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ startTime: Date.UTC(2026, 4, 5, 0, 0, 0), timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 7, 15, 0, 0),
    });

    expect(candidate.status).toBe("SKIP");
  });

  it("keeps Kronos unavailable fallback truthful", () => {
    const candidate = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const disguisedUnavailable = buildCandidate({
      symbol: "ETHUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: {
        available: false,
        reason: "Disabled adapter.",
        kronosLongProbability: 99,
        kronosShortProbability: 1,
        kronosConfidence: 99,
      },
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(candidate.kronosScore).toBe(0);
    expect(candidate.kronosBias).toBe("UNAVAILABLE");
    expect(disguisedUnavailable.opportunityScore).toBe(candidate.opportunityScore);
    expect(disguisedUnavailable.confidence).toBe(candidate.confidence);
  });

  it("invalid RR downgrades status", () => {
    const candidate = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 20, 15, 0, 0),
    });

    expect(candidate.status).toBe("SKIP");
    expect(candidate.blockers.join(" ")).toContain("Risk/reward");
  });

  it("missing volume displays unknown without fake zero", () => {
    const candidate = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: null, baseVolume24h: null, volumeRatio5m: null },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(candidate.volume.volumeRatio5m).toBeNull();
    expect(candidate.reason.join(" ")).toContain("unknown");
  });

  it("spread percent normalization works", () => {
    const candidate = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.0002 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    expect(candidate.spread.percent).toBe(0.02);
  });

  it("keeps low-price precision for PEPE-like symbols", () => {
    expect(roundPrice(0.00000414789)).toBe(0.0000041479);
  });

  it("whale agreement lifts Edge Score while disagreement lowers it", () => {
    const baseInput = {
      symbol: "SOLUSDT",
      candles5m: makeCandles({ step: 1.4 }),
      candles15m: makeCandles({ step: 1.4, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.4, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: {
        available: true,
        kronosLongProbability: 80,
        kronosShortProbability: 20,
        kronosBias: "LONG",
        kronosConfidence: 78,
        expectedReturn1h: 1.2,
        expectedReturn4h: 2.1,
        probabilityUp: 68,
        probabilityDown: 32,
        kronosConfidenceBucket: "STRONG",
      },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    } as const;
    const aligned = {
      ...buildCandidate({ ...baseInput, whale: { available: true, signal: "BULLISH", score: 78, reason: "flow up" } }),
      finalDirection: "LONG" as const,
    };
    const conflicting = {
      ...aligned,
      whale: { available: true, signal: "BEARISH" as const, score: 78, reason: "flow down" },
    };
    const perf = makePerfStub();

    const alignedEdge = buildEdgeScore(aligned, perf, "Mixed rotation");
    const conflictingEdge = buildEdgeScore(conflicting, perf, "Mixed rotation");

    expect(alignedEdge.whaleFlowSupport).toBeGreaterThan(conflictingEdge.whaleFlowSupport);
  });

  it("Edge Score stays finite and does not alter candidate visibility", () => {
    const candidate = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.2 }),
      candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 0.7 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });

    const statusBefore = candidate.status;
    const edge = buildEdgeScore(candidate, makePerfStub(), "Mixed rotation");

    expect(Number.isFinite(edge.score)).toBe(true);
    expect(edge.bestShadowEntryVariant).not.toBeNull();
    expect(candidate.status).toBe(statusBefore);
  });

  it("does not substitute a different replay combo for the heuristic selection", () => {
    const candidate = {
      ...buildCandidate({
        symbol: "BTCUSDT",
        candles5m: makeCandles({ step: 1.2 }),
        candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
        kronos: unavailableKronos,
        whale: { available: false, signal: "UNAVAILABLE", score: 0 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      finalDirection: "LONG" as const,
    };
    const perf = makePerfStub();
    perf.windows["1h"].variantCombinations = [{
      entryVariant: "base_current_entry",
      exitVariant: "tp1_full_exit",
      attempted: 60,
      filled: 60,
      noFill: 0,
      resolved: 60,
      validResolved: 60,
      tp1: 12,
      tp2: 4,
      tp3: 0,
      profitableTp1: 12,
      sl: 48,
      winRate: 0.2,
      grossAvgR: -0.3,
      netAvgR: -0.5,
      profitFactor: 0.4,
      avgWinR: 0.8,
      avgLossR: -0.9,
      expectancyPerTrade: -0.5,
      runnerSuccessRate: 0,
      ambiguousSameCandleCount: 0,
      sampleTier: "usable",
    }];
    perf.windows["1h"].shadowVariants = perf.windows["1h"].shadowVariants.map((variant) => ({
      ...variant,
      avgGrossRResult: -0.3,
      avgNetRResult: -0.5,
      profitFactor: 0.4,
      profitableTp1Rate: 0.1,
    }));

    const selection = buildVariantSelection(candidate, perf);

    expect(selection.expectedNetR).toBeNull();
    expect(selection.netEdgeAfterCost).toBeNull();
    expect(selection.routeMode).toBe("DATA_COLLECTION");
    expect(selection.routeReasonCodes).toContain("NO_EVIDENCE");
  });

  it("keeps costR diagnostic separate from net R so costs are not double counted", () => {
    const candidate = {
      ...buildCandidate({
        symbol: "ETHUSDT",
        candles5m: makeCandles({ step: 1.2 }),
        candles15m: makeCandles({ step: 1.2, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ step: 1.2, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100.2, absolute: 0.2, percent: 0.2 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
        kronos: unavailableKronos,
        whale: { available: false, signal: "UNAVAILABLE", score: 0 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      finalDirection: "LONG" as const,
    };
    const perf = makePerfStub();

    const selection = buildVariantSelection(candidate, perf);

    expect(selection.costR).toBeCloseTo((selection.spreadR ?? 0) + (selection.feeSlippageR ?? 0), 5);
    expect(selection.netEdgeAfterCost).toBe(selection.expectedNetR);
  });

  it("direction dominance labels CLEAR, MIXED, and NO_EDGE correctly", () => {
    const clear = buildTradePlan({ ...buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.6 }),
      candles15m: makeCandles({ step: 1.6, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.6, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    }), longScore: 70, shortScore: 50 });
    const mixed = buildTradePlan({ ...buildCandidate({
      symbol: "ETHUSDT",
      candles5m: makeCandles({ step: 1.6 }),
      candles15m: makeCandles({ step: 1.6, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.6, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    }), longScore: 62, shortScore: 53 });
    const noEdge = buildTradePlan({ ...buildCandidate({
      symbol: "SOLUSDT",
      candles5m: makeCandles({ step: 1.6 }),
      candles15m: makeCandles({ step: 1.6, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.6, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    }), longScore: 56, shortScore: 53 });

    expect(clear.directionQuality).toBe("CLEAR");
    expect(mixed.directionQuality).toBe("MIXED");
    expect(noEdge.directionQuality).toBe("NO_EDGE");
  });

  it("builds a long pullback reclaim trade plan", () => {
    const candidate = {
      ...buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ start: 100, step: 0.8 }),
      candles15m: makeCandles({ start: 100, step: 0.8, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ start: 100, step: 0.8, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.2 },
      kronos: unavailableKronos,
      whale: { available: true, signal: "BULLISH", score: 70 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      finalDirection: "LONG" as const,
      direction: "LONG" as const,
      selectedKronosBias: "LONG" as const,
      horizonConflict: false,
      riskReward: 2,
      forecastMaxHigh: 400,
    };
    const plan = buildTradePlan(candidate);

    expect(plan.entryPlaybook).toBe("PULLBACK_RECLAIM");
    expect(plan.exactEntryTrigger).toContain("reclaims VWAP/EMA20");
  });

  it("builds a short retrace rejection trade plan", () => {
    const candidate = {
      ...buildCandidate({
        symbol: "ETHUSDT",
        candles5m: makeCandles({ start: 200, step: -0.8 }),
        candles15m: makeCandles({ start: 200, step: -0.8, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ start: 200, step: -0.8, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 200, ask: 200.03, absolute: 0.03, percent: 0.015 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.2 },
        kronos: unavailableKronos,
        whale: { available: true, signal: "BEARISH", score: 72 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      finalDirection: "SHORT" as const,
      direction: "SHORT" as const,
    };
    const plan = buildTradePlan(candidate);

    expect(plan.entryPlaybook).toBe("RETRACE_REJECTION");
    expect(plan.exactEntryTrigger).toContain("retrac");
  });

  it("marks no-chase when price drifts more than 1 ATR from entry", () => {
    const candidate = {
      ...buildCandidate({
        symbol: "SOLUSDT",
        candles5m: makeCandles({ step: 0.5 }),
        candles15m: makeCandles({ step: 0.5, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ step: 0.5, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 0.8 },
        kronos: unavailableKronos,
        whale: { available: false, signal: "UNAVAILABLE", score: 0 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      entryZone: [95, 96] as [number, number],
      indicators: {
        ...buildCandidate({
          symbol: "TMP",
          candles5m: makeCandles({ step: 0.5 }),
          candles15m: makeCandles({ step: 0.5, timeStepMs: 15 * 60 * 1000 }),
          candles1h: makeCandles({ step: 0.5, timeStepMs: 60 * 60 * 1000 }),
          spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
          volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 0.8 },
          kronos: unavailableKronos,
          whale: { available: false, signal: "UNAVAILABLE", score: 0 },
          sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
          now: Date.UTC(2026, 4, 6, 15, 0, 0),
        }).indicators,
        fiveMinute: {
          ...buildCandidate({
            symbol: "TMP2",
            candles5m: makeCandles({ step: 0.5 }),
            candles15m: makeCandles({ step: 0.5, timeStepMs: 15 * 60 * 1000 }),
            candles1h: makeCandles({ step: 0.5, timeStepMs: 60 * 60 * 1000 }),
            spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
            volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 0.8 },
            kronos: unavailableKronos,
            whale: { available: false, signal: "UNAVAILABLE", score: 0 },
            sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
            now: Date.UTC(2026, 4, 6, 15, 0, 0),
          }).indicators.fiveMinute,
          latestClose: 100,
          atr14: 2,
        },
      },
    };
    const plan = buildTradePlan(candidate);

    expect(plan.entryAction).toBe("NO_CHASE");
    expect(plan.noChaseWarning).not.toBeNull();
  });

  it("does not let external support manufacture runner eligibility", () => {
    const candidate = {
      ...buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.5 }),
      candles15m: makeCandles({ step: 1.5, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.5, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.3 },
      kronos: {
        available: true,
        kronosLongProbability: 82,
        kronosShortProbability: 18,
        kronosBias: "LONG",
        kronosConfidence: 78,
        kronosConfidenceBucket: "STRONG",
        expectedReturn1h: 1.3,
        expectedReturn4h: 2.4,
        probabilityUp: 71,
        probabilityDown: 29,
        forecastMaxHigh: 400,
      },
      whale: { available: true, signal: "BULLISH", score: 78 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      finalDirection: "LONG" as const,
      direction: "LONG" as const,
      kronosBias: "LONG" as const,
      kronosBias1h: "LONG" as const,
      kronosBias4h: "LONG" as const,
      selectedKronosBias: "LONG" as const,
      expectedReturn1h: 1.3,
      expectedReturn4h: 2.4,
      probabilityUp: 71,
      probabilityDown: 29,
      kronosConfidenceBucket: "STRONG" as const,
      horizonConflict: false,
      riskReward: 2,
      forecastMaxHigh: 400,
    };
    const plan = buildTradePlan(candidate);

    expect(plan.runnerAllowed).toBe(false);
  });

  it("uses fast or conflict exit when Kronos or whale conflicts", () => {
    const candidate = {
      ...buildCandidate({
        symbol: "ETHUSDT",
        candles5m: makeCandles({ step: -1.1 }),
        candles15m: makeCandles({ step: -1.1, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ step: -1.1, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 0.7 },
        kronos: {
          available: true,
          kronosLongProbability: 70,
          kronosShortProbability: 30,
          kronosBias: "LONG",
          kronosConfidence: 60,
          kronosConfidenceBucket: "MEDIUM",
          expectedReturn1h: 0.5,
          expectedReturn4h: 0.2,
          probabilityUp: 60,
          probabilityDown: 40,
        },
        whale: { available: true, signal: "BULLISH", score: 72 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      finalDirection: "SHORT" as const,
      direction: "SHORT" as const,
    };
    const plan = buildTradePlan(candidate);

    expect(["EXIT_ON_KRONOS_FLIP", "EXIT_ON_WHALE_FLIP", "TP1_FAST"]).toContain(plan.exitMode);
  });

  it("marks horizon conflict and disables runner guidance", () => {
    const candidate = {
      ...buildCandidate({
        symbol: "FETUSDT",
        candles5m: makeCandles({ step: 1.1 }),
        candles15m: makeCandles({ step: 1.1, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ step: 1.1, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.3 },
        kronos: {
          available: true,
          kronosLongProbability: 72,
          kronosShortProbability: 28,
          kronosBias: "LONG",
          kronosBias1h: "LONG",
          kronosBias4h: "SHORT",
          selectedKronosBias: "LONG",
          kronosConfidence: 70,
          kronosConfidenceBucket: "STRONG",
          expectedReturn1h: 1.2,
          expectedReturn4h: -0.8,
          probabilityUp: 66,
          probabilityDown: 34,
          forecastMaxHigh: 400,
          horizonConflict: true,
        },
        whale: { available: true, signal: "BULLISH", score: 76 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      finalDirection: "LONG" as const,
      direction: "LONG" as const,
      kronosBias: "LONG" as const,
      kronosBias1h: "LONG" as const,
      kronosBias4h: "SHORT" as const,
      selectedKronosBias: "LONG" as const,
      expectedReturn1h: 1.2,
      expectedReturn4h: -0.8,
      probabilityUp: 66,
      probabilityDown: 34,
      kronosConfidenceBucket: "STRONG" as const,
      horizonConflict: true,
      forecastMaxHigh: 400,
    };
    const plan = buildTradePlan(candidate);
    const edge = buildEdgeScore(candidate, makePerfStub(), "Mixed rotation");

    expect(plan.horizonConflict).toBe(true);
    expect(plan.shortHorizonOnly).toBe(true);
    expect(plan.runnerAllowed).toBe(false);
    expect(plan.stagedExitSplit).toContain("no runner");
    expect(edge.horizonConflict).toBe(true);
    expect(edge.shortHorizonOnly).toBe(true);
    expect(edge.kronosExitGuidance).toBe("short-horizon bias only; TP1 fast, no runner");
  });

  it("generates staged entry and exit splits", () => {
    const candidate = buildCandidate({
      symbol: "BTCUSDT",
      candles5m: makeCandles({ step: 1.3 }),
      candles15m: makeCandles({ step: 1.3, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ step: 1.3, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.1 },
      kronos: unavailableKronos,
      whale: { available: true, signal: "BULLISH", score: 65 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const plan = buildTradePlan(candidate);

    expect(plan.stagedEntrySplit.length).toBeGreaterThan(0);
    expect(plan.stagedExitSplit.length).toBeGreaterThan(0);
  });

  it("trade plan helper does not alter scanner ranking data", () => {
    const candidates = [
      buildCandidate({
        symbol: "A",
        candles5m: makeCandles({ step: 2 }),
        candles15m: makeCandles({ step: 2, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ step: 2, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
        kronos: unavailableKronos,
        whale: { available: false, signal: "UNAVAILABLE", score: 0 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
      buildCandidate({
        symbol: "B",
        candles5m: makeCandles({ step: 1 }),
        candles15m: makeCandles({ step: 1, timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ step: 1, timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.2 },
        kronos: unavailableKronos,
        whale: { available: false, signal: "UNAVAILABLE", score: 0 },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
        now: Date.UTC(2026, 4, 6, 15, 0, 0),
      }),
    ].sort((a, b) => b.opportunityScore - a.opportunityScore);
    const before = candidates.map((c) => c.symbol);
    candidates.forEach((candidate) => buildTradePlan(candidate));
    const after = candidates.map((c) => c.symbol);

    expect(after).toEqual(before);
  });

  it("rejects an ATR plan whose stop/target geometry only collapses after price-precision rounding", () => {
    const fib = calculateFibonacciLevels(makeCandles({ step: 1.5, count: 120, timeStepMs: 60 * 60 * 1000 }));
    // A near-flat market: ATR is tiny relative to price, so the raw SHORT stop
    // (entryHigh + atrValue*1.15) sits inside the same rounding tick as entryHigh itself.
    const plan = buildAtrPlan(99.9999, 0.00003, 0.01, "SHORT", {
      ...fib,
      retracement382: 99.9998,
      retracement236: 100.0001,
    });

    expect(plan.stopLoss).toBeNull();
    expect(plan.entryZoneHigh).toBeNull();
    expect(plan.takeProfit1).toBeNull();
  });

  it("keeps the SHORT fallback take-profit ladder monotonic (tp1 nearest, tp3 furthest)", () => {
    const base = buildCandidate({
      symbol: "ETHUSDT",
      candles5m: makeCandles({ start: 200, step: -0.8 }),
      candles15m: makeCandles({ start: 200, step: -0.8, timeStepMs: 15 * 60 * 1000 }),
      candles1h: makeCandles({ start: 200, step: -0.8, timeStepMs: 60 * 60 * 1000 }),
      spread: { bid: 200, ask: 200.03, absolute: 0.03, percent: 0.015 },
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.2 },
      kronos: unavailableKronos,
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
      sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
      now: Date.UTC(2026, 4, 6, 15, 0, 0),
    });
    const candidate = {
      ...base,
      finalDirection: "SHORT" as const,
      direction: "SHORT" as const,
      // Force the trade-plan fallback (both the primary ATR plan and the candidate's own
      // takeProfits are unavailable).
      stopLoss: null,
      takeProfits: { tp1: null, tp2: null, tp3: null },
      atr: { ...base.atr, stopLoss: null, takeProfit1: null, takeProfit2: null, takeProfit3: null },
      fibonacci: { ...base.fibonacci, recentHigh: 110, recentLow: 100, retracement618: 106 },
      indicators: {
        ...base.indicators,
        fiveMinute: { ...base.indicators.fiveMinute, support: 90 },
      },
    };

    const plan = buildTradePlan(candidate);

    expect(plan.takeProfit1).not.toBeNull();
    expect(plan.takeProfit2).not.toBeNull();
    expect(plan.takeProfit3).not.toBeNull();
    // tp1 is the first/nearest SHORT target, so it must require the *least* profit —
    // i.e. sit at or above tp2, which itself sits at or above tp3.
    expect(plan.takeProfit1!).toBeGreaterThanOrEqual(plan.takeProfit2!);
    expect(plan.takeProfit2!).toBeGreaterThanOrEqual(plan.takeProfit3!);
  });
});

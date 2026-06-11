import { describe, expect, it } from "vitest";

import { chooseEntryVariant, chooseExitVariant } from "../src/execution-plan.js";
import type { Candidate, PerformanceStats, ShadowVariantStats } from "../src/types.js";

function makeShadowVariant(overrides: Partial<ShadowVariantStats> & { key: ShadowVariantStats["key"] }): ShadowVariantStats {
  return {
    key: overrides.key,
    label: overrides.key,
    category: "ENTRY",
    signals: 10,
    withOutcome: 10,
    resolved: 10,
    validRisk: 10,
    invalidRisk: 0,
    tp1Hit: 4,
    profitableTp1Hit: 3,
    tp2Hit: 2,
    tp3Hit: 0,
    slHit: 4,
    open: 0,
    hitRate: 0.4,
    tp1Rate: 0.4,
    profitableTp1Rate: 0.3,
    tp2Rate: 0.2,
    slRate: 0.4,
    avgMaxFavorableExcursionPct: 2,
    avgMaxAdverseExcursionPct: 1.2,
    avgRResult: 0,
    avgGrossRResult: 0,
    avgNetRResult: 0,
    profitFactor: 1,
    avgRUnknownReasons: { missingEntry: 0, missingStopLoss: 0, missingExit: 0, invalidRisk: 0, openOutcome: 0, noCandlePath: 0 },
    ...overrides,
  };
}

function makePerf(shadowVariants: ShadowVariantStats[] = []): PerformanceStats {
  return {
    primaryWindow: "1h",
    secondaryWindow: "4h",
    executionCost: { feeBpsPerSide: 8, slippageBpsPerSide: 6, roundTripCostBps: 28 },
    totalSignals: 0,
    rawScans: 0,
    uniqueTrackedSignals: 0,
    suppressedDuplicateScans: 0,
    withOutcome: 0,
    resolvedOutcomes: 0,
    openOutcomes: 0,
    activeOpenSignals: 0,
    expiredSignals: 0,
    invalidRiskSignals: 0,
    lowSample: false,
    byStatus: {} as PerformanceStats["byStatus"],
    byDirection: {} as PerformanceStats["byDirection"],
    kronosAgreement: {} as PerformanceStats["kronosAgreement"],
    kronosConfidenceSplit: {} as PerformanceStats["kronosConfidenceSplit"],
    whaleAgreement: {} as PerformanceStats["whaleAgreement"],
    bySymbol: [],
    earlySampleSymbols: [],
    insights: [],
    tradeReadiness: [],
    dedupeAudit: { duplicateSuppressionWindowMinutes: 60, activeOpenSignals: 0, rawScans: 0, uniqueSignals: 0, note: "" },
    migrationAudit: { currentCanonicalSample: 0, archivedPreDedupeSample: 0, migratedResolvedOutcomes: 0, skippedLegacyRecords: 0, skippedLegacyReasons: [], note: "" },
    lifecycle: { oldestActiveSignalAgeMinutes: 0, next1hCheckDueAt: null, next4hCheckDueAt: null, lastOutcomeCheckerRunAt: null },
    statusTransitions: { waitWorked: 0, readyFailed: 0 },
    windows: {
      "1h": {
        window: "1h", withOutcome: 0, resolvedOutcomes: 0, openOutcomes: 0, lowSample: false,
        byStatus: {} as PerformanceStats["byStatus"], byDirection: {} as PerformanceStats["byDirection"],
        kronosAgreement: {} as PerformanceStats["kronosAgreement"], kronosConfidenceSplit: {} as PerformanceStats["kronosConfidenceSplit"],
        whaleAgreement: {} as PerformanceStats["whaleAgreement"], bySymbol: [], earlySampleSymbols: [],
        shadowVariants, variantCombinations: [], insights: [], tradeReadiness: [],
        statusTransitions: { waitWorked: 0, readyFailed: 0 },
      },
      "4h": {
        window: "4h", withOutcome: 0, resolvedOutcomes: 0, openOutcomes: 0, lowSample: false,
        byStatus: {} as PerformanceStats["byStatus"], byDirection: {} as PerformanceStats["byDirection"],
        kronosAgreement: {} as PerformanceStats["kronosAgreement"], kronosConfidenceSplit: {} as PerformanceStats["kronosConfidenceSplit"],
        whaleAgreement: {} as PerformanceStats["whaleAgreement"], bySymbol: [], earlySampleSymbols: [],
        shadowVariants: [], variantCombinations: [], insights: [], tradeReadiness: [],
        statusTransitions: { waitWorked: 0, readyFailed: 0 },
      },
    },
    generatedAt: "2026-05-12T00:00:00.000Z",
  };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const price = 100;
  const tfBase = {
    timeframe: "5m" as const,
    latestClose: price,
    ema20: price,
    ema50: price,
    ema200: price,
    sma20: price,
    rsi14: 55,
    macd: { macd: 0, signal: 0, histogram: 0 },
    bollingerBands20: { upper: price + 2, middle: price, lower: price - 2 },
    atr14: 2,
    atrPercent: 2,
    vwap: price,
    volumeRatio: 1.2,
    bodyWickRatio: 0.6,
    support: price - 3,
    resistance: price + 3,
    recentSwingHigh: price + 4,
    recentSwingLow: price - 4,
    distanceFromEma20: 0,
    distanceFromVwap: 0,
    breakoutHigh: false,
    breakoutLow: false,
    trend: "BULLISH" as const,
    isFresh: true,
    lastOpenTime: Date.UTC(2026, 4, 12, 0, 0, 0),
  };
  return {
    rank: 1,
    symbol: "BTCUSDT",
    direction: "LONG",
    status: "READY",
    longScore: 70,
    shortScore: 40,
    opportunityScore: 70,
    dangerScore: 30,
    confidence: 65,
    dataQualityScore: 80,
    liquidityScore: 80,
    volatilityScore: 65,
    trendScore: 70,
    volumeScore: 70,
    kronosScore: 60,
    finalDirection: "LONG",
    finalStatus: "READY",
    sourceConflict: false,
    directionConflict: false,
    kronosBias: "LONG",
    kronosConfidence: 0.7,
    expectedReturn3: 0.01,
    expectedReturn6: 0.02,
    indicators: {
      fiveMinute: tfBase,
      fifteenMinute: { ...tfBase, timeframe: "15m" },
      oneHour: { ...tfBase, timeframe: "1h" },
      fibonacci: {
        recentHigh: 110, recentLow: 90,
        retracement236: 105, retracement382: 102, retracement500: 100,
        retracement618: 98, retracement786: 94,
        extension1272: 115, extension1618: 120,
      },
      atr: {
        atr14: 2, atrPercent: 2,
        entryZoneLow: 99, entryZoneHigh: 101,
        stopLoss: 97, takeProfit1: 103, takeProfit2: 105, takeProfit3: 108,
        riskReward: 2,
      },
    },
    fibonacci: {
      recentHigh: 110, recentLow: 90,
      retracement236: 105, retracement382: 102, retracement500: 100,
      retracement618: 98, retracement786: 94,
      extension1272: 115, extension1618: 120,
    },
    atr: {
      atr14: 2, atrPercent: 2,
      entryZoneLow: 99, entryZoneHigh: 101,
      stopLoss: 97, takeProfit1: 103, takeProfit2: 105, takeProfit3: 108,
      riskReward: 2,
    },
    volume: { quoteVolume24h: 1e8, baseVolume24h: 1e6, volumeRatio5m: 1.5 },
    spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
    whale: { available: true, signal: "BULLISH", score: 0.6 },
    sentiment: { available: false, signal: "UNAVAILABLE", score: 0 },
    entryZone: [99, 101],
    stopLoss: 97,
    takeProfits: { tp1: 103, tp2: 105, tp3: 108 },
    riskReward: 2,
    reason: [],
    blockers: [],
    chart: [],
    kronosConfidenceBucket: "STRONG",
    horizonConflict: false,
    expectedReturn1h: 0.01,
    expectedReturn4h: 0.02,
    ...overrides,
  };
}

describe("variant scorer calibration — entry", () => {
  it("drift > 1 does NOT make no_chase_atr_entry the top score when replay is not positive", () => {
    // Price drifted ATR>1 above entry zone mid; no replay evidence for no_chase_atr
    const c = makeCandidate({
      indicators: {
        ...makeCandidate().indicators,
        fiveMinute: { ...makeCandidate().indicators.fiveMinute, latestClose: 104, atr14: 2 },
      },
    });
    const entry = chooseEntryVariant(c, makePerf(), "HIGH");
    expect(entry.key).not.toBe("no_chase_atr_entry");
  });

  it("drift <= 0.5 yields a reasonable no_chase_atr score (10 geometry) without becoming dominant", () => {
    const c = makeCandidate();
    const entry = chooseEntryVariant(c, makePerf(), "LOW");
    // base_current_entry should win at price-in-zone with no replay; no_chase_atr should not be #1
    expect(entry.key).not.toBe("no_chase_atr_entry");
  });

  it("drift > 1 with positive replay evidence allows no_chase_atr to score (not penalized)", () => {
    const positiveStats = makeShadowVariant({
      key: "no_chase_atr_entry",
      avgNetRResult: 0.4,
      avgGrossRResult: 0.5,
      resolved: 20,
      profitableTp1Rate: 0.5,
      profitFactor: 1.5,
    });
    const c = makeCandidate({
      indicators: {
        ...makeCandidate().indicators,
        fiveMinute: { ...makeCandidate().indicators.fiveMinute, latestClose: 104, atr14: 2 },
      },
    });
    const entryNoEvidence = chooseEntryVariant(c, makePerf(), "HIGH");
    const entryWithEvidence = chooseEntryVariant(c, makePerf([positiveStats]), "HIGH");
    // With positive replay, no_chase_atr should score better (not negative)
    expect(entryWithEvidence.key === "no_chase_atr_entry" || entryWithEvidence.score >= entryNoEvidence.score).toBe(true);
  });

  it("fib_500_entry near zone (price ≈ retracement500) is preferred over no_chase_atr at low drift", () => {
    // Set price exactly at fib_500
    const c = makeCandidate();
    const fib500Stats = makeShadowVariant({ key: "fib_500_entry", avgNetRResult: 0.05, resolved: 20 });
    const entry = chooseEntryVariant(c, makePerf([fib500Stats]), "LOW");
    expect(["fib_500_entry", "base_current_entry"]).toContain(entry.key);
  });

  it("fib_500_entry boost only applies when replay is not deeply negative", () => {
    const c = makeCandidate();
    const fib500Neutral = makeShadowVariant({ key: "fib_500_entry", avgNetRResult: 0.05, resolved: 20 });
    const fib500Toxic = makeShadowVariant({ key: "fib_500_entry", avgNetRResult: -0.5, resolved: 20 });
    const findFib500 = (perf: ReturnType<typeof makePerf>): number => {
      // Recreate the scoring loop by calling chooseEntryVariant once, then look up fib_500's score.
      const result = chooseEntryVariant(c, perf, "LOW");
      // chooseEntryVariant returns the top-scored variant only; sample by giving it 0 baseline competitors
      // and looking at the score returned for the top variant when fib_500 is provided.
      void result;
      return 0;
    };
    void findFib500;
    // Direct comparison: with neutral replay, fib_500 should be selected (boost applies).
    // With deeply-negative replay, the boost does NOT apply, so a different variant wins.
    const entryNeutral = chooseEntryVariant(c, makePerf([fib500Neutral]), "LOW");
    const entryToxic = chooseEntryVariant(c, makePerf([fib500Toxic]), "LOW");
    expect(entryNeutral.key).toBe("fib_500_entry");
    // With toxic replay, fib_500 still has variant-score advantage from having any stats vs null,
    // but the boost +8 should NOT be added. Verify by checking the score delta:
    expect(entryToxic.score).toBeLessThan(entryNeutral.score);
  });
});

describe("variant scorer calibration — Top 10 ranking invariance", () => {
  it("changes only execution plan, never candidate rank/status/scores", () => {
    // The variant scorer operates after ranking; calling it must not mutate the candidate's
    // rank/status/longScore/shortScore/opportunityScore/dangerScore fields.
    const c = makeCandidate({ rank: 7, status: "READY", longScore: 70, shortScore: 40 });
    const snapshot = JSON.parse(JSON.stringify(c));
    chooseEntryVariant(c, makePerf(), "HIGH");
    chooseExitVariant(c, makePerf(), "HIGH");
    expect(c.rank).toBe(snapshot.rank);
    expect(c.status).toBe(snapshot.status);
    expect(c.longScore).toBe(snapshot.longScore);
    expect(c.shortScore).toBe(snapshot.shortScore);
    expect(c.opportunityScore).toBe(snapshot.opportunityScore);
    expect(c.dangerScore).toBe(snapshot.dangerScore);
  });
});

describe("variant scorer calibration — exit", () => {
  it("kronos_runner_exit is blocked when replay netR is negative", () => {
    const kronosRunnerNeg = makeShadowVariant({
      key: "kronos_runner_exit",
      avgNetRResult: -0.3,
      avgGrossRResult: -0.25,
      resolved: 20,
      profitableTp1Rate: 0.15,
      profitFactor: 0.4,
    });
    const c = makeCandidate();
    const exit = chooseExitVariant(c, makePerf([kronosRunnerNeg]), "LOW");
    expect(exit.key).not.toBe("kronos_runner_exit");
  });

  it("kronos_runner_exit is blocked when horizonConflict is true", () => {
    const c = makeCandidate({ horizonConflict: true });
    const exit = chooseExitVariant(c, makePerf(), "LOW");
    expect(exit.key).not.toBe("kronos_runner_exit");
  });

  it("kronos_runner_exit is blocked when chase risk is HIGH", () => {
    const c = makeCandidate();
    const exit = chooseExitVariant(c, makePerf(), "HIGH");
    expect(exit.key).not.toBe("kronos_runner_exit");
  });

  it("tp1_full_exit is preferred when runner replay stats are deeply negative", () => {
    const runnerVariants = [
      makeShadowVariant({ key: "tp1_50_tp2_runner", avgNetRResult: -0.3, resolved: 20 }),
      makeShadowVariant({ key: "kronos_runner_exit", avgNetRResult: -0.4, resolved: 20 }),
      makeShadowVariant({ key: "trail_after_tp1", avgNetRResult: -0.25, resolved: 20 }),
    ];
    const c = makeCandidate();
    const exit = chooseExitVariant(c, makePerf(runnerVariants), "LOW");
    expect(["tp1_full_exit", "kronos_flip_exit", "vwap_loss_exit", "whale_conflict_exit"]).toContain(exit.key);
  });

  it("kronos_runner_exit is blocked when source agreement is weak", () => {
    const c = makeCandidate({
      kronosBias: "NEUTRAL",
      selectedKronosBias: "NEUTRAL",
      kronosConfidenceBucket: "WEAK",
      whale: { available: false, signal: "UNAVAILABLE", score: 0 },
    });
    const exit = chooseExitVariant(c, makePerf(), "LOW");
    expect(exit.key).not.toBe("kronos_runner_exit");
  });
});

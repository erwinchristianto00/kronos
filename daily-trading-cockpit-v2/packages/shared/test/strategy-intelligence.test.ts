import { describe, expect, it } from "vitest";

import {
  buildAdaptiveRegimeGateOverlayAssessments,
  buildResolvedTradeOutcomeSnapshot,
  buildStrategyContextSnapshot,
  buildStrategyEvidenceTable,
  buildStrategyExperienceRecords,
  buildStrategyIntelligenceFoundationReport,
} from "../src/strategy-intelligence.js";
import {
  type Candidate,
  type ShadowPosition,
  type VariantSelectionSnapshot,
} from "../src/index.js";

function plan(overrides: Partial<VariantSelectionSnapshot> = {}): VariantSelectionSnapshot {
  return {
    selectedEntryVariant: "vwap_retest_entry",
    selectedExitVariant: "tp1_full_exit",
    expectedGrossR: 0.8,
    expectedNetR: 0.55,
    netEdgeAfterCost: 0.55,
    profitFactor: 1.4,
    fillRate: null,
    noFillRate: null,
    costR: 0.12,
    spreadR: 0.02,
    feeSlippageR: 0.1,
    stopDistanceBps: 150,
    variantSampleSize: 20,
    variantConfidenceTier: "provisional",
    routeMode: "DATA_COLLECTION",
    routeScore: 22,
    routeReasonCodes: ["POSITIVE_NET_EVIDENCE", "KRONOS_AGREES"],
    primaryProfitEligible: false,
    rawExpectedNetR: 0.55,
    calibratedExpectedNetR: 0.25,
    calibrationConfidence: "MEDIUM",
    calibrationSourceUsed: "entry+exit",
    calibrationDiagnosisCodes: ["TEST_DIAG"],
    calibrationVerdict: "CALIBRATED_POSITIVE",
    evidenceEra: "POST_CALIBRATION",
    decisionPolicyVersion: "test-policy",
    selectionSource: "heuristic_fallback",
    costAssumption: "test",
    selectionReason: "test",
    entryDriftPct: 0.1,
    entryDriftAtr: 0.3,
    entryQualityExplanation: [],
    exitPlanExplanation: [],
    chaseRisk: "LOW",
    ...overrides,
  };
}

function position(overrides: Partial<ShadowPosition> = {}): ShadowPosition {
  const variantSelection = overrides.variantSelection ?? plan();
  return {
    id: "pos-1",
    ideaKey: "BTCUSDT|LONG",
    symbol: "BTCUSDT",
    direction: "LONG",
    signalFamily: "TREND_CONTINUATION",
    scannedAt: "2026-05-14T00:00:00.000Z",
    firstSeenAt: "2026-05-14T00:00:00.000Z",
    lastSeenAt: "2026-05-14T00:00:00.000Z",
    lastEvaluatedAt: "2026-05-14T00:00:00.000Z",
    scanCount: 1,
    latestStatus: "READY",
    latestScore: 78,
    latestReason: [],
    entryZone: [100, 101],
    entryState: "FILLED",
    entryPrice: 100,
    entryFilledAt: "2026-05-14T00:01:00.000Z",
    stopDistanceBps: 150,
    costR: 0.12,
    spreadR: 0.02,
    feeSlippageR: 0.1,
    stopLoss: 98.5,
    tp1: 103,
    tp2: 105,
    tp3: null,
    riskReward: 2,
    dangerScore: 30,
    selectedEntryVariant: variantSelection.selectedEntryVariant,
    selectedExitVariant: variantSelection.selectedExitVariant,
    variantSelection,
    primaryVariant: variantSelection.selectedExitVariant,
    tradePlan: {
      directionGap: 20,
      directionQuality: "CLEAR",
      biasSummary: "test",
      entryPlaybook: "BREAKOUT_RETEST",
      entryAction: "ENTER_ON_TRIGGER",
      exactEntryTrigger: "test",
      noChaseWarning: null,
      invalidation: [],
      stopLoss: 98.5,
      takeProfit1: 103,
      takeProfit2: 105,
      takeProfit3: null,
      exitMode: "TP1_FAST",
      earlyExitCondition: "test",
      runnerAllowed: false,
      horizonConflict: false,
      shortHorizonOnly: false,
      stagedEntrySplit: "test",
      stagedExitSplit: "test",
      why: [],
    },
    variants: [{
      variant: variantSelection.selectedExitVariant,
      state: "CLOSED",
      openedAt: "2026-05-14T00:01:00.000Z",
      lastUpdatedAt: "2026-05-14T00:31:00.000Z",
      closedAt: "2026-05-14T00:31:00.000Z",
      remainingSizePct: 0,
      realizedGrossR: 1,
      realizedNetR: 0.82,
      unrealizedR: 0,
      currentPrice: 103,
      stopPrice: 98.5,
      tp1Hit: true,
      tp2Hit: false,
      tp3Hit: false,
      slMovedToBreakeven: false,
      closeReason: "TP1_FULL",
      profitableAfterCosts: true,
    }],
    marketRegime: "TRENDING",
    ...overrides,
  };
}

function candidate(): Candidate {
  return {
    symbol: "BTCUSDT",
    direction: "LONG",
    finalDirection: "LONG",
    finalStatus: "READY",
    status: "READY",
    longScore: 80,
    shortScore: 40,
    opportunityScore: 75,
    confidence: 70,
    dangerScore: 25,
    selectedExecutionPlan: plan(),
    indicators: {
      fiveMinute: { latestClose: 100, trend: "BULLISH", vwap: 99.8, ema20: 99.6, support: 98, resistance: 104, recentSwingHigh: 105, recentSwingLow: 97, volumeRatio: 1.2, atrPercent: 1.1 } as Candidate["indicators"]["fiveMinute"],
      fifteenMinute: { trend: "BULLISH" } as Candidate["indicators"]["fifteenMinute"],
      oneHour: { trend: "BULLISH" } as Candidate["indicators"]["oneHour"],
    },
    fibonacci: { recentHigh: 105, recentLow: 95, retracement236: 102.6, retracement382: 101.2, retracement500: 100, retracement618: 98.8, retracement786: 97.1, extension1272: 107.7, extension1618: 111.2 },
    spread: { percent: 0.02 } as Candidate["spread"],
    volume: { volumeRatio5m: 1.2 } as Candidate["volume"],
    whale: { available: true, signal: "BULLISH", score: 70 },
    sentiment: { available: true, signal: "BULLISH", score: 55 },
    riskReward: 2,
    stopLoss: 98.5,
    takeProfits: { tp1: 103, tp2: 105, tp3: null },
    kronosBias: "LONG",
    kronosBias1h: "LONG",
    kronosBias4h: "LONG",
    selectedKronosBias: "LONG",
    kronosConfidenceBucket: "STRONG",
    expectedReturn1h: 0.8,
    expectedReturn4h: 1.3,
    horizonConflict: false,
  } as Candidate;
}

describe("strategy intelligence foundation", () => {
  it("evaluates adaptive regime overlay policies conservatively", () => {
    const bullish = buildAdaptiveRegimeGateOverlayAssessments({
      marketRegime: "Bullish expansion",
      direction: "LONG",
      evaluatedAt: "2026-05-14T00:00:00.000Z",
    });
    expect(bullish.find((item) => item.policyId === "EXCLUDE_BULLISH_EXPANSION_V1")?.advisoryDecision).toBe("WOULD_EXCLUDE");
    expect(bullish.find((item) => item.policyId === "EXCLUDE_BULLISH_EXPANSION_LONG_V1")?.advisoryDecision).toBe("WOULD_EXCLUDE");

    const bearishShort = buildAdaptiveRegimeGateOverlayAssessments({
      marketRegime: "Bearish pressure",
      direction: "SHORT",
    });
    expect(bearishShort.find((item) => item.policyId === "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1")?.advisoryDecision).toBe("WOULD_INCLUDE");

    const bearishLong = buildAdaptiveRegimeGateOverlayAssessments({
      marketRegime: "Bearish pressure",
      direction: "LONG",
    });
    expect(bearishLong.find((item) => item.policyId === "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1")?.advisoryDecision).toBe("WOULD_EXCLUDE");

    const missing = buildAdaptiveRegimeGateOverlayAssessments({
      marketRegime: null,
      direction: "LONG",
    });
    expect(missing.every((item) => item.advisoryDecision === "INSUFFICIENT_CONTEXT")).toBe(true);
  });

  it("builds a context snapshot safely and captures route, calibration, scanner context", () => {
    const context = buildStrategyContextSnapshot({ candidate: candidate(), scanTimestamp: "2026-05-14T00:00:00.000Z", marketRegime: "TRENDING" });
    expect(context?.symbol).toBe("BTCUSDT");
    expect(context?.selectedEntryVariant).toBe("vwap_retest_entry");
    expect(context?.calibratedExpectedNetR).toBe(0.25);
    expect(context?.opportunityScore).toBe(75);
    expect(context?.directionGap).toBe(40);
    expect(context?.trend5m).toBe("BULLISH");
    expect(context?.trend15m).toBe("BULLISH");
    expect(context?.trend1h).toBe("BULLISH");
    expect(context?.marketRegime).toBe("TRENDING");
    expect(context?.selectedKronosBias).toBe("LONG");
    expect(context?.whaleAgreement).toBe("AGREES");
    expect(context?.adaptiveRegimeGateOverlayAssessments).toHaveLength(3);
    expect(context?.adaptiveRegimeGateOverlayAssessments?.find((item) => item.policyId === "EXCLUDE_BULLISH_EXPANSION_V1")?.advisoryDecision).toBe("WOULD_INCLUDE");
    expect(context?.plannedEntryPrice).toBe(100);
    expect(context?.entryZoneLow).toBeNull();
    expect(buildStrategyContextSnapshot({ selectedExecutionPlan: plan() })).toBeNull();
  });

  it("does not backfill overlay assessments onto historical position-only reconstruction", () => {
    const context = buildStrategyContextSnapshot({ position: position() });
    expect(context?.adaptiveRegimeGateOverlayAssessments).toBeUndefined();
    expect(context?.routeMode).toBe("DATA_COLLECTION");
    expect(position().variantSelection.routeMode).toBe("DATA_COLLECTION");
  });

  it("threads liveSourceConflict from candidate.sourceConflict into StrategyContextSnapshot", () => {
    // sourceConflict=true: Kronos opposes whale direction
    const withConflict = buildStrategyContextSnapshot({
      candidate: { ...candidate(), sourceConflict: true } as Candidate,
      scanTimestamp: "2026-05-14T00:00:00.000Z",
    });
    expect(withConflict?.liveSourceConflict).toBe(true);

    // sourceConflict=false: Kronos and whale agree
    const withoutConflict = buildStrategyContextSnapshot({
      candidate: { ...candidate(), sourceConflict: false } as Candidate,
      scanTimestamp: "2026-05-14T00:00:00.000Z",
    });
    expect(withoutConflict?.liveSourceConflict).toBe(false);

    // No candidate (position-only reconstruction) → null
    const positionOnly = buildStrategyContextSnapshot({ position: position() });
    expect(positionOnly?.liveSourceConflict ?? null).toBeNull();
  });

  it("builds resolved outcomes with win/loss classification and missing fill safety", () => {
    expect(buildResolvedTradeOutcomeSnapshot(position())?.winnerLabel).toBe("WIN");
    const withPath = buildResolvedTradeOutcomeSnapshot(position({
      maxFavorableExcursionR: 1.5,
      maxAdverseExcursionR: 0.4,
      maxFavorablePrice: 104,
      maxAdversePrice: 99,
      maxFavorableAt: "2026-05-14T00:20:00.000Z",
      maxAdverseAt: "2026-05-14T00:05:00.000Z",
    }));
    expect(withPath?.maxFavorableExcursionR).toBe(1.5);
    expect(withPath?.maxAdverseExcursionR).toBe(0.4);
    expect(withPath?.realizedPathAvailable).toBe(true);
    const loss = position({
      variants: [{ ...position().variants[0]!, realizedNetR: -1, realizedGrossR: -1, tp1Hit: false, closeReason: "SL" }],
    });
    expect(buildResolvedTradeOutcomeSnapshot(loss)?.winnerLabel).toBe("LOSS");
    expect(buildResolvedTradeOutcomeSnapshot(position({ variants: [] }))).toBeNull();
  });

  it("only closed positions produce strategy experience records", () => {
    const open = position({ id: "open", variants: [{ ...position().variants[0]!, state: "OPEN", closedAt: null, closeReason: "OPEN" }] });
    const records = buildStrategyExperienceRecords([position(), open]);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome.positionId).toBe("pos-1");
  });

  it("groups evidence by symbol direction route and route regime with sample tiers and verdicts", () => {
    const winners = Array.from({ length: 5 }, (_, i) => position({ id: `w-${i}` }));
    const losers = Array.from({ length: 3 }, (_, i) => position({
      id: `l-${i}`,
      symbol: "BNBUSDT",
      direction: "SHORT",
      variants: [{ ...position().variants[0]!, realizedNetR: -0.7, realizedGrossR: -0.6, tp1Hit: false, closeReason: "SL" }],
    }));
    const table = buildStrategyEvidenceTable(buildStrategyExperienceRecords([...winners, ...losers]));
    expect(table.bySymbolDirectionRoute.find((row) => row.symbol === "BTCUSDT")?.sampleTier).toBe("SMALL");
    expect(table.bySymbolDirectionRoute.find((row) => row.symbol === "BTCUSDT")?.verdict).toBe("WATCHABLE");
    expect(table.bySymbolDirectionRoute.find((row) => row.symbol === "BNBUSDT")?.verdict).toBe("TOXIC_EARLY");
    expect(table.bySymbolDirectionRouteRegime.some((row) => row.marketRegime === "TRENDING")).toBe(true);
  });

  it("builds empty-safe readiness report", () => {
    const report = buildStrategyIntelligenceFoundationReport([]);
    expect(report.metadata.contextSnapshotCount).toBe(0);
    expect(report.metadata.resolvedExperienceRecordCount).toBe(0);
    expect(report.dataReadiness.readyForSymbolRouteEngine).toBe(false);
    expect(report.missingFieldAudit.missing).toContain("mfeR");
    expect(report.missingFieldAudit.completeness.maxFavorableExcursionR).toBe(0);
    expect(report.dataReadiness.technicalStopTpEngine.ready).toBe(false);
    expect(report.dataReadiness.technicalStopTpEngine.reasonsBlocking.length).toBeGreaterThan(0);
  });

  it("surfaces trend and MAE/MFE completeness in readiness audit", () => {
    const noPath = position({ id: "no-path" });
    const withPath = position({
      id: "with-path",
      maxFavorableExcursionR: 1.2,
      maxAdverseExcursionR: 0.3,
    });
    const report = buildStrategyIntelligenceFoundationReport([noPath, withPath]);
    expect(report.missingFieldAudit.completeness.trend5m).toBe(0);
    expect(report.missingFieldAudit.completeness.maxFavorableExcursionR).toBe(0.5);
    expect(report.missingFieldAudit.completeness.maxAdverseExcursionR).toBe(0.5);
    expect(report.dataReadiness.readyForTechnicalStopTpEngine).toBe(false);
  });
});

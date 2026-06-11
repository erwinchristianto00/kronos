import { describe, expect, it } from "vitest";

import type { ShadowPosition, StrategyExperienceRecord } from "@dtc/shared";

import { buildAdaptiveGateCoverageProvenanceReport } from "../src/lib/adaptive-gate-intelligence.js";

let counter = 0;

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    symbol: "BTCUSDT",
    direction: "LONG",
    scanTimestamp: "2026-05-14T00:00:00.000Z",
    evidenceEra: "POST_CALIBRATION",
    marketRegime: "BULLISH",
    ...overrides,
  };
}

function makeClosedPosition(overrides: Record<string, unknown> = {}): ShadowPosition {
  counter += 1;
  return {
    id: `pos-${counter}`,
    ideaKey: `idea-${counter}`,
    marketIdeaKey: `market-${counter}`,
    symbol: "BTCUSDT",
    direction: "LONG",
    signalFamily: "TREND_CONTINUATION",
    scannedAt: "2026-05-14T00:00:00.000Z",
    firstSeenAt: "2026-05-14T00:00:00.000Z",
    lastSeenAt: "2026-05-14T00:00:00.000Z",
    lastEvaluatedAt: "2026-05-14T00:00:00.000Z",
    scanCount: 1,
    latestStatus: "READY",
    latestScore: 70,
    latestReason: [],
    entryZone: null,
    marketEntryZone: null,
    entryState: "FILLED",
    entryPrice: 100,
    stopLoss: 95,
    tp1: 101,
    tp2: 102,
    tp3: 103,
    riskReward: 2,
    dangerScore: 10,
    selectedEntryVariant: "vwap_retest_entry",
    selectedExitVariant: "tp1_full_exit",
    variantSelection: {
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      evidenceEra: "POST_CALIBRATION",
      decisionPolicyVersion: "test-policy",
    },
    primaryVariant: "tp1_full_exit",
    tradePlan: undefined,
    variants: [{
      variant: "tp1_full_exit",
      state: "CLOSED",
      openedAt: "2026-05-14T00:00:00.000Z",
      closedAt: "2026-05-14T01:00:00.000Z",
      remainingSizePct: 0,
      realizedGrossR: 0.5,
      realizedNetR: 0.4,
      unrealizedR: 0,
      currentPrice: 101,
      stopPrice: 95,
      tp1Hit: true,
      tp2Hit: false,
      tp3Hit: false,
      slMovedToBreakeven: false,
      closeReason: "TP1",
      profitableAfterCosts: true,
    }],
    marketRegime: "Bullish expansion",
    strategyContextSnapshot: null,
    ...overrides,
  } as never;
}

function makeOpenSnapshotPosition(overrides: Record<string, unknown> = {}): ShadowPosition {
  counter += 1;
  return {
    id: `open-${counter}`,
    ideaKey: `idea-open-${counter}`,
    marketIdeaKey: `market-open-${counter}`,
    symbol: "ETHUSDT",
    direction: "SHORT",
    signalFamily: "TREND_CONTINUATION",
    scannedAt: "2026-05-14T02:00:00.000Z",
    firstSeenAt: "2026-05-14T02:00:00.000Z",
    lastSeenAt: "2026-05-14T02:00:00.000Z",
    lastEvaluatedAt: "2026-05-14T02:00:00.000Z",
    scanCount: 1,
    latestStatus: "READY",
    latestScore: 75,
    latestReason: [],
    entryZone: null,
    marketEntryZone: null,
    entryState: "PENDING_ENTRY",
    entryPrice: 200,
    stopLoss: 210,
    tp1: 195,
    tp2: 190,
    tp3: 185,
    riskReward: 2,
    dangerScore: 8,
    selectedEntryVariant: "vwap_retest_entry",
    selectedExitVariant: "tp1_full_exit",
    variantSelection: {
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      evidenceEra: "POST_CALIBRATION",
      decisionPolicyVersion: "test-policy",
    },
    primaryVariant: "tp1_full_exit",
    tradePlan: undefined,
    variants: [],
    marketRegime: "Bearish expansion",
    strategyContextSnapshot: makeSnapshot({
      symbol: "ETHUSDT",
      direction: "SHORT",
      selectedKronosBias: "SHORT",
      kronosBias1h: "SHORT",
      kronosBias4h: "SHORT",
      horizonConflict: false,
      whaleAgreement: "AGREES",
      whaleBias: "BEARISH",
      whaleDirection: "BEARISH",
      sentimentSummary: "Market-wide Fear & Greed is bearish at 34.",
      sentimentBucket: "BEARISH",
      marketRegime: "Bearish expansion",
    }),
    ...overrides,
  } as never;
}

describe("buildAdaptiveGateCoverageProvenanceReport", () => {
  it("is safe on empty input", () => {
    const report = buildAdaptiveGateCoverageProvenanceReport([]);
    expect(report.totalResolvedRecords).toBe(0);
    expect(report.perField.length).toBeGreaterThan(0);
  });

  it("identifies expected zero coverage when only forward snapshot-rich records remain unresolved", () => {
    const report = buildAdaptiveGateCoverageProvenanceReport([
      makeClosedPosition(),
      makeOpenSnapshotPosition(),
    ]);
    const kronos = report.perField.find((field) => field.field === "selectedKronosBias");
    expect(report.resolvedRecordsWithStrategyContext).toBe(0);
    expect(report.openPositionsWithStrategyContext).toBe(1);
    expect(kronos?.selectedContextCoveragePct).toBe(1);
    expect(kronos?.resolvedExperienceCoveragePct).toBe(0);
    expect(kronos?.mostLikelyGapReason).toBe("EXPECTED_ZERO_COVERAGE_DUE_TO_NO_RESOLVED_FORWARD_RECORDS");
  });

  it("identifies a true mapping gap when resolved snapshot data exists but the experience records lose it", () => {
    const position = makeClosedPosition({
      strategyContextSnapshot: makeSnapshot({
        selectedKronosBias: "LONG",
        horizonConflict: false,
        whaleAgreement: "AGREES",
      }),
    });
    const syntheticRecords: StrategyExperienceRecord[] = [{
      context: {
        ...position.strategyContextSnapshot,
        selectedKronosBias: null,
      } as StrategyExperienceRecord["context"],
      outcome: {
        schemaVersion: 1,
        positionId: position.id,
        symbol: position.symbol,
        direction: position.direction,
        evidenceEra: "POST_CALIBRATION",
        winnerLabel: "WIN",
        realizedNetR: 0.4,
        realizedGrossR: 0.5,
        tp1Hit: true,
        slHit: false,
        closeReason: "TP1",
      } as StrategyExperienceRecord["outcome"],
    }];
    const report = buildAdaptiveGateCoverageProvenanceReport([position], {
      records: syntheticRecords,
    });
    const kronos = report.perField.find((field) => field.field === "selectedKronosBias");
    expect(report.resolvedRecordsWithStrategyContext).toBe(1);
    expect(kronos?.resolvedSnapshotCoveragePct).toBe(1);
    expect(kronos?.resolvedExperienceCoveragePct).toBe(0);
    expect(kronos?.mostLikelyGapReason).toBe("TRUE_MAPPING_GAP");
  });

  it("marks fear greed fields as source-not-available at scan time", () => {
    const report = buildAdaptiveGateCoverageProvenanceReport([makeOpenSnapshotPosition()]);
    const fearGreed = report.perField.find((field) => field.field === "fearGreedValue");
    expect(fearGreed?.mostLikelyGapReason).toBe("SOURCE_NOT_AVAILABLE_AT_SCAN_TIME");
  });
});

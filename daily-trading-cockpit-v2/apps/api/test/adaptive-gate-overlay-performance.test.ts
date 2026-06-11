import { describe, expect, it } from "vitest";

import type { StrategyExperienceRecord } from "@dtc/shared";

import { buildAdaptiveRegimeGateOverlayPerformanceReport } from "../src/lib/adaptive-gate-overlay-performance.js";

let counter = 0;

interface MakeOpts {
  netR: number;
  grossR?: number;
  policyDecisions?: Partial<Record<"EXCLUDE_BULLISH_EXPANSION_V1" | "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1" | "EXCLUDE_BULLISH_EXPANSION_LONG_V1", "WOULD_INCLUDE" | "WOULD_EXCLUDE" | "INSUFFICIENT_CONTEXT">>;
  withOverlay?: boolean;
}

function makeRecord(opts: MakeOpts): StrategyExperienceRecord {
  const withOverlay = opts.withOverlay ?? true;
  return {
    context: {
      schemaVersion: 1,
      symbol: "BTCUSDT",
      direction: "SHORT",
      scanTimestamp: null,
      evidenceEra: "POST_CALIBRATION",
      marketRegime: "Bearish expansion",
      adaptiveRegimeGateOverlayAssessments: withOverlay ? [
        {
          policyId: "EXCLUDE_BULLISH_EXPANSION_V1",
          policyVersion: "regime-shadow-overlay-v1",
          policyLabel: "Exclude bullish expansion",
          advisoryDecision: opts.policyDecisions?.EXCLUDE_BULLISH_EXPANSION_V1 ?? "WOULD_INCLUDE",
          supportLabel: "REGIME_SUPPORTED",
          reasonCodes: [],
          explanation: "test",
          evaluatedAt: "2026-05-14T00:00:00.000Z",
          marketRegimeAtSelection: "BEARISH_EXPANSION",
          directionAtSelection: "SHORT",
        },
        {
          policyId: "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1",
          policyVersion: "regime-shadow-overlay-v1",
          policyLabel: "Keep only bearish expansion and short",
          advisoryDecision: opts.policyDecisions?.KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1 ?? "WOULD_INCLUDE",
          supportLabel: "REGIME_SUPPORTED",
          reasonCodes: [],
          explanation: "test",
          evaluatedAt: "2026-05-14T00:00:00.000Z",
          marketRegimeAtSelection: "BEARISH_EXPANSION",
          directionAtSelection: "SHORT",
        },
        {
          policyId: "EXCLUDE_BULLISH_EXPANSION_LONG_V1",
          policyVersion: "regime-shadow-overlay-v1",
          policyLabel: "Exclude bullish expansion long",
          advisoryDecision: opts.policyDecisions?.EXCLUDE_BULLISH_EXPANSION_LONG_V1 ?? "WOULD_INCLUDE",
          supportLabel: "REGIME_SUPPORTED",
          reasonCodes: [],
          explanation: "test",
          evaluatedAt: "2026-05-14T00:00:00.000Z",
          marketRegimeAtSelection: "BEARISH_EXPANSION",
          directionAtSelection: "SHORT",
        },
      ] : undefined,
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `overlay-${++counter}`,
      symbol: "BTCUSDT",
      direction: "SHORT",
      evidenceEra: "POST_CALIBRATION",
      realizedNetR: opts.netR,
      realizedGrossR: opts.grossR ?? opts.netR + 0.05,
      winnerLabel: opts.netR > 0 ? "WIN" : opts.netR < 0 ? "LOSS" : "BREAKEVEN",
      tp1Hit: opts.netR > 0,
      slHit: opts.netR < 0,
      closeReason: opts.netR > 0 ? "TP1" : "SL",
    } as StrategyExperienceRecord["outcome"],
  };
}

describe("buildAdaptiveRegimeGateOverlayPerformanceReport", () => {
  it("counts records with and without overlay correctly", () => {
    const report = buildAdaptiveRegimeGateOverlayPerformanceReport([
      makeRecord({ netR: 0.3, withOverlay: true }),
      makeRecord({ netR: -0.4, withOverlay: false }),
    ]);
    expect(report.recordsWithPersistedOverlay).toBe(1);
    expect(report.recordsWithoutPersistedOverlay).toBe(1);
    expect(report.overlayForwardCoveragePct).toBe(0.5);
  });

  it("computes included vs excluded metrics and deltas correctly", () => {
    const report = buildAdaptiveRegimeGateOverlayPerformanceReport([
      makeRecord({ netR: 0.4, policyDecisions: { EXCLUDE_BULLISH_EXPANSION_V1: "WOULD_INCLUDE" } }),
      makeRecord({ netR: 0.3, policyDecisions: { EXCLUDE_BULLISH_EXPANSION_V1: "WOULD_INCLUDE" } }),
      makeRecord({ netR: -0.5, policyDecisions: { EXCLUDE_BULLISH_EXPANSION_V1: "WOULD_EXCLUDE" } }),
      makeRecord({ netR: -0.4, policyDecisions: { EXCLUDE_BULLISH_EXPANSION_V1: "WOULD_EXCLUDE" } }),
    ]);
    const policy = report.policyPerformance.find((item) => item.policyId === "EXCLUDE_BULLISH_EXPANSION_V1");
    expect(policy?.includedCount).toBe(2);
    expect(policy?.excludedCount).toBe(2);
    expect((policy?.includedMetrics.netAvgR ?? 0)).toBeGreaterThan(0);
    expect((policy?.excludedMetrics.netAvgR ?? 0)).toBeLessThan(0);
    expect((policy?.deltaIncludedVsExcluded.netAvgRDelta ?? 0)).toBeGreaterThan(0);
  });

  it("returns no-forward-evidence on tiny sample", () => {
    const report = buildAdaptiveRegimeGateOverlayPerformanceReport([
      makeRecord({ netR: 0.4 }),
      makeRecord({ netR: -0.5 }),
    ]);
    expect(report.policyPerformance.every((item) => item.earlyVerdict === "TOO_EARLY")).toBe(true);
  });

  it("classifies EARLY_SUPPORTIVE on synthetic uplift", () => {
    const records: StrategyExperienceRecord[] = [
      ...Array.from({ length: 6 }, () => makeRecord({ netR: 0.4, policyDecisions: { KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1: "WOULD_INCLUDE" } })),
      ...Array.from({ length: 6 }, () => makeRecord({ netR: -0.4, policyDecisions: { KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1: "WOULD_EXCLUDE" } })),
    ];
    const report = buildAdaptiveRegimeGateOverlayPerformanceReport(records);
    const policy = report.policyPerformance.find((item) => item.policyId === "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1");
    expect(policy?.earlyVerdict).toBe("EARLY_SUPPORTIVE");
  });

  it("classifies EARLY_HARMFUL on synthetic drag", () => {
    const records: StrategyExperienceRecord[] = [
      ...Array.from({ length: 6 }, () => makeRecord({ netR: -0.4, policyDecisions: { EXCLUDE_BULLISH_EXPANSION_LONG_V1: "WOULD_INCLUDE" } })),
      ...Array.from({ length: 6 }, () => makeRecord({ netR: 0.4, policyDecisions: { EXCLUDE_BULLISH_EXPANSION_LONG_V1: "WOULD_EXCLUDE" } })),
    ];
    const report = buildAdaptiveRegimeGateOverlayPerformanceReport(records);
    const policy = report.policyPerformance.find((item) => item.policyId === "EXCLUDE_BULLISH_EXPANSION_LONG_V1");
    expect(policy?.earlyVerdict).toBe("EARLY_HARMFUL");
  });
});

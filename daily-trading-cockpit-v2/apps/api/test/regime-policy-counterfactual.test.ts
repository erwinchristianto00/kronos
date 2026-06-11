import { describe, expect, it } from "vitest";

import type { StrategyExperienceRecord } from "@dtc/shared";

import { buildRegimePolicyCounterfactualReport } from "../src/lib/regime-policy-counterfactual.js";

let counter = 0;

interface MakeOpts {
  marketRegime: string;
  direction: "LONG" | "SHORT";
  netR: number;
  closeReason?: "TP1" | "TP2" | "SL" | "BREAKEVEN" | "TIME";
}

function makeRecord(opts: MakeOpts): StrategyExperienceRecord {
  const closeReason = opts.closeReason ?? (opts.netR >= 0 ? "TP1" : "SL");
  const tp1Hit = closeReason === "TP1" || closeReason === "TP2";
  return {
    context: {
      schemaVersion: 1,
      symbol: "BTCUSDT",
      direction: opts.direction,
      scanTimestamp: null,
      evidenceEra: "POST_CALIBRATION",
      marketRegime: opts.marketRegime,
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `cf-${++counter}`,
      symbol: "BTCUSDT",
      direction: opts.direction,
      evidenceEra: "POST_CALIBRATION",
      realizedNetR: opts.netR,
      realizedGrossR: opts.netR + 0.05,
      winnerLabel: opts.netR > 0 ? "WIN" : opts.netR < 0 ? "LOSS" : "BREAKEVEN",
      tp1Hit,
      slHit: closeReason === "SL" || closeReason === "BREAKEVEN",
      closeReason,
    } as StrategyExperienceRecord["outcome"],
  };
}

function many(count: number, opts: MakeOpts): StrategyExperienceRecord[] {
  return Array.from({ length: count }, () => makeRecord(opts));
}

describe("buildRegimePolicyCounterfactualReport", () => {
  it("computes baseline metrics correctly", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(6, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.5 }),
      ...many(4, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.4 }),
    ]);
    expect(report.baseline.closedCount).toBe(10);
    expect(report.baseline.netAvgR).toBeCloseTo(0.14, 3);
    expect(report.baseline.profitFactor).toBeCloseTo(1.88, 1);
  });

  it("KEEP_ONLY_BEARISH_EXPANSION recomputes correctly", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(12, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.2 }),
      ...many(12, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.5 }),
    ]);
    const scenario = report.scenarios.find((row) => row.scenarioCode === "KEEP_ONLY_BEARISH_EXPANSION");
    expect(scenario?.includedCount).toBe(12);
    expect(scenario?.excludedCount).toBe(12);
    expect((scenario?.netAvgR ?? 0)).toBeGreaterThan(0);
  });

  it("EXCLUDE_BULLISH_EXPANSION recomputes correctly", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(15, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.15 }),
      ...many(15, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.45 }),
    ]);
    const scenario = report.scenarios.find((row) => row.scenarioCode === "EXCLUDE_BULLISH_EXPANSION");
    expect(scenario?.includedCount).toBe(15);
    expect((scenario?.deltaNetAvgRVsBaseline ?? 0)).toBeGreaterThan(0);
  });

  it("KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT recomputes correctly", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(14, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.18 }),
      ...many(6, { marketRegime: "Bearish expansion", direction: "LONG", netR: -0.4 }),
      ...many(10, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.5 }),
    ]);
    const scenario = report.scenarios.find((row) => row.scenarioCode === "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT");
    expect(scenario?.includedCount).toBe(14);
    expect((scenario?.netAvgR ?? 0)).toBeGreaterThan(0);
  });

  it("EXCLUDE_BULLISH_EXPANSION_LONG recomputes correctly", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(12, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.6 }),
      ...many(12, { marketRegime: "Bullish expansion", direction: "SHORT", netR: 0.05 }),
      ...many(12, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.2 }),
    ]);
    const scenario = report.scenarios.find((row) => row.scenarioCode === "EXCLUDE_BULLISH_EXPANSION_LONG");
    expect(scenario?.includedCount).toBe(24);
    expect((scenario?.deltaNetAvgRVsBaseline ?? 0)).toBeGreaterThan(0);
  });

  it("classifies STRONGLY_IMPROVES conservatively", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(22, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.35 }),
      ...many(22, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.45 }),
    ]);
    const scenario = report.scenarios.find((row) => row.scenarioCode === "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT");
    expect(scenario?.interpretation).toBe("STRONGLY_IMPROVES");
  });

  it("classifies MODESTLY_IMPROVES conservatively", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(16, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.1 }),
      ...many(16, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.25 }),
    ]);
    const scenario = report.scenarios.find((row) => row.scenarioCode === "EXCLUDE_BULLISH_EXPANSION");
    expect(scenario?.interpretation).toBe("MODESTLY_IMPROVES");
  });

  it("classifies WORSENS conservatively", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(20, { marketRegime: "Bearish expansion", direction: "SHORT", netR: -0.4 }),
      ...many(20, { marketRegime: "Bullish expansion", direction: "LONG", netR: 0.2 }),
    ]);
    const scenario = report.scenarios.find((row) => row.scenarioCode === "KEEP_ONLY_BEARISH_EXPANSION");
    expect(scenario?.interpretation).toBe("WORSENS");
  });

  it("classifies TOO_FEW_SAMPLES when remaining count is under 10", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(8, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.3 }),
      ...many(20, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.2 }),
    ]);
    const scenario = report.scenarios.find((row) => row.scenarioCode === "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT");
    expect(scenario?.interpretation).toBe("TOO_FEW_SAMPLES");
    expect(scenario?.caution).toBe("SMALL_SAMPLE");
  });

  it("generates policy hypotheses conservatively", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(35, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.3 }),
      ...many(35, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.5 }),
    ]);
    expect(report.policyHypotheses.length).toBeGreaterThan(0);
    expect(report.policyHypotheses.some((row) => row.patchStatus === "READY_FOR_PATCH_DISCUSSION" || row.patchStatus === "AUDIT_DEEPER")).toBe(true);
  });

  it("does not overstate tiny samples to READY_FOR_PATCH_DISCUSSION", () => {
    const report = buildRegimePolicyCounterfactualReport([
      ...many(7, { marketRegime: "Bearish expansion", direction: "SHORT", netR: 0.8 }),
      ...many(30, { marketRegime: "Bullish expansion", direction: "LONG", netR: -0.1 }),
    ]);
    for (const hypothesis of report.policyHypotheses) {
      expect(hypothesis.patchStatus).not.toBe("READY_FOR_PATCH_DISCUSSION");
    }
  });
});

import { describe, expect, it } from "vitest";

import { computeProfitRoute, type ProfitRouteInput } from "../src/profit-routing.js";
import { computeScannerDiagnostics } from "../src/scanner-diagnostics.js";

function baseInput(overrides: Partial<ProfitRouteInput> = {}): ProfitRouteInput {
  return {
    symbol: "BTCUSDT",
    direction: "LONG",
    selectedEntryVariant: "base_current_entry",
    selectedExitVariant: "tp1_full_exit",
    expectedNetR: 0.12,
    expectedGrossR: 0.2,
    variantConfidenceTier: "provisional",
    symbolStats: null,
    sideStats: null,
    variantCombo: null,
    allReplayCombosForVariant: [],
    entryVariantStats: null,
    exitVariantStats: null,
    kronos: { bias: "NEUTRAL", selectedBias: "NEUTRAL", horizonConflict: false },
    whale: { available: false, agrees: false, disagrees: false },
    cost: { costR: 0.2, spreadR: 0.05, feeSlippageR: 0.15, stopDistanceBps: 150 },
    profitableTp1Rate: null,
    runnerSuccessRate: null,
    selectionSource: "replay",
    ...overrides,
  };
}

describe("computeScannerDiagnostics", () => {
  it("PROFIT_CANDIDATE gets high similarity and low risk", () => {
    const input = baseInput({ variantConfidenceTier: "usable", expectedNetR: 0.3 });
    const decision = computeProfitRoute(input);
    expect(decision.routeMode).toBe("PROFIT_CANDIDATE");

    const diag = computeScannerDiagnostics(input, decision);
    expect(diag.profitCandidateSimilarityScore).toBeGreaterThan(60);
    expect(diag.researchRiskScore).toBeLessThan(30);
    expect(diag.closestPathToProfitCandidate).toMatch(/already routed/i);
    expect(diag.topPositiveEvidence.length).toBeGreaterThan(0);
  });

  it("RESEARCH_ONLY with toxic variant gets high risk score", () => {
    const input = baseInput({
      selectedEntryVariant: "ema20_pullback_entry",
      expectedNetR: 0.2,
      variantConfidenceTier: "usable",
    });
    const decision = computeProfitRoute(input);
    expect(decision.routeMode).toBe("RESEARCH_ONLY");

    const diag = computeScannerDiagnostics(input, decision);
    expect(diag.researchRiskScore).toBeGreaterThan(35);
    expect(diag.topNegativeEvidence.some((e) => /toxic/i.test(e))).toBe(true);
    expect(diag.closestPathToProfitCandidate).toMatch(/toxic|symbol/i);
  });

  it("RESEARCH_ONLY with negative net R shows path to positive net R", () => {
    const input = baseInput({ expectedNetR: -0.4, variantConfidenceTier: "usable" });
    const decision = computeProfitRoute(input);
    expect(decision.routeMode).toBe("RESEARCH_ONLY");

    const diag = computeScannerDiagnostics(input, decision);
    expect(diag.topNegativeEvidence.some((e) => /negative/i.test(e))).toBe(true);
    expect(diag.closestPathToProfitCandidate).toMatch(/-0\.40|negative/i);
  });

  it("DATA_COLLECTION no evidence gives guidance to accumulate data", () => {
    const input = baseInput({ expectedNetR: null, variantConfidenceTier: "early" });
    const decision = computeProfitRoute(input);
    expect(decision.routeMode).toBe("DATA_COLLECTION");

    const diag = computeScannerDiagnostics(input, decision);
    expect(diag.closestPathToProfitCandidate).toMatch(/evidence|sample/i);
  });

  it("early sample tier gives lower similarity score than provisional", () => {
    const earlyInput = baseInput({ expectedNetR: 0.15, variantConfidenceTier: "early" });
    const provInput = baseInput({ expectedNetR: 0.15, variantConfidenceTier: "provisional" });
    const earlyDecision = computeProfitRoute(earlyInput);
    const provDecision = computeProfitRoute(provInput);

    const earlyDiag = computeScannerDiagnostics(earlyInput, earlyDecision);
    const provDiag = computeScannerDiagnostics(provInput, provDecision);

    expect(earlyDiag.profitCandidateSimilarityScore).toBeLessThan(provDiag.profitCandidateSimilarityScore);
  });

  it("PROFIT_CANDIDATE with Kronos/whale agrees shows positive evidence labels", () => {
    const input = baseInput({
      variantConfidenceTier: "usable",
      expectedNetR: 0.25,
      kronos: { bias: "LONG", selectedBias: "LONG", horizonConflict: false },
      whale: { available: true, agrees: true, disagrees: false },
    });
    const decision = computeProfitRoute(input);
    const diag = computeScannerDiagnostics(input, decision);

    expect(diag.topPositiveEvidence.some((e) => /kronos/i.test(e))).toBe(true);
    expect(diag.topPositiveEvidence.some((e) => /whale/i.test(e))).toBe(true);
  });

  it("all replay combos negative gives correct blocker in path", () => {
    const input = baseInput({
      expectedNetR: -0.2,
      variantConfidenceTier: "usable",
      allReplayCombosForVariant: [
        { entryVariant: "base_current_entry", exitVariant: "tp1_full_exit", attempted: 10, filled: 8, noFill: 2, resolved: 8, validResolved: 8, tp1: 2, tp2: 0, tp3: 0, profitableTp1: 1, sl: 6, winRate: 0.125, grossAvgR: -0.3, netAvgR: -0.4, profitFactor: 0.2, avgWinR: 0.5, avgLossR: -0.8, expectancyPerTrade: -0.4, runnerSuccessRate: 0, ambiguousSameCandleCount: 0, sampleTier: "usable" },
      ],
    });
    const decision = computeProfitRoute(input);
    const diag = computeScannerDiagnostics(input, decision);

    expect(diag.topNegativeEvidence.some((e) => /replay/i.test(e))).toBe(true);
    expect(diag.closestPathToProfitCandidate).toMatch(/replay|negative/i);
  });
});

import { describe, expect, it } from "vitest";

import { computeProfitRoute, type ProfitRouteInput } from "../src/profit-routing.js";

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

describe("computeProfitRoute", () => {
  it("returns PROFIT_CANDIDATE when net R is positive with usable tier", () => {
    const decision = computeProfitRoute(baseInput({ variantConfidenceTier: "usable", expectedNetR: 0.25 }));
    expect(decision.routeMode).toBe("PROFIT_CANDIDATE");
    expect(decision.primaryProfitEligible).toBe(true);
    expect(decision.routeReasonCodes).toContain("POSITIVE_NET_EVIDENCE");
  });

  it("negative net variant cannot become PROFIT_CANDIDATE", () => {
    const decision = computeProfitRoute(baseInput({ expectedNetR: -0.3, variantConfidenceTier: "usable" }));
    expect(decision.routeMode).toBe("RESEARCH_ONLY");
    expect(decision.primaryProfitEligible).toBe(false);
    expect(decision.routeReasonCodes).toContain("NEGATIVE_NET_EVIDENCE");
  });

  it("does not permanently classify an entry variant without direct selected-combo evidence", () => {
    const noDirectEvidence = computeProfitRoute(
      baseInput({
        selectedEntryVariant: "ema20_pullback_entry",
        expectedNetR: 0.2,
        variantConfidenceTier: "usable",
      }),
    );
    expect(noDirectEvidence.routeReasonCodes).not.toContain("TOXIC_VARIANT");
  });

  it("does not let aggregate replay rows veto a different selected combo", () => {
    const decision = computeProfitRoute(
      baseInput({
        expectedNetR: 0.1,
        variantConfidenceTier: "usable",
        allReplayCombosForVariant: [
          // @ts-expect-error partial stats fixture
          { resolved: 30, netAvgR: -0.1, entryVariant: "base_current_entry", exitVariant: "tp1_full_exit" },
          // @ts-expect-error partial stats fixture
          { resolved: 30, netAvgR: -0.05, entryVariant: "base_current_entry", exitVariant: "tp1_50_tp2_runner" },
        ],
      }),
    );
    expect(decision.routeMode).toBe("PROFIT_CANDIDATE");
    expect(decision.routeReasonCodes).not.toContain("ALL_REPLAY_VARIANTS_NEGATIVE");
  });

  it("Kronos horizon conflict blocks runner exit selection", () => {
    const decision = computeProfitRoute(
      baseInput({
        selectedExitVariant: "kronos_runner_exit",
        expectedNetR: 0.2,
        variantConfidenceTier: "usable",
        kronos: { bias: "LONG", selectedBias: "LONG", horizonConflict: true },
      }),
    );
    expect(decision.routeReasonCodes).toContain("RUNNER_BLOCKED_BY_HORIZON_CONFLICT");
    expect(decision.routeReasonCodes).toContain("KRONOS_HORIZON_CONFLICT");
  });

  it("Whale/Kronos agreement alone cannot upgrade routeMode when net R is negative", () => {
    const decision = computeProfitRoute(
      baseInput({
        expectedNetR: -0.2,
        variantConfidenceTier: "usable",
        kronos: { bias: "LONG", selectedBias: "LONG", confidenceBucket: "STRONG", horizonConflict: false },
        whale: { available: true, agrees: true, disagrees: false },
      }),
    );
    expect(decision.routeMode).toBe("RESEARCH_ONLY");
  });

  it("LONG with deeply negative side net and no symbol positive falls back to DATA_COLLECTION", () => {
    const decision = computeProfitRoute(
      baseInput({
        expectedNetR: 0.1,
        variantConfidenceTier: "usable",
        sideStats: { side: "LONG", netAvgR: -0.3, resolved: 100 },
      }),
    );
    expect(decision.routeMode).toBe("DATA_COLLECTION");
    expect(decision.routeReasonCodes).toContain("SIDE_NET_NEGATIVE");
  });

  it("calibrated expected R ≤ 0 demotes PROFIT_CANDIDATE → DATA_COLLECTION (never RESEARCH_ONLY, shadow keeps collecting)", () => {
    const decision = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.6, // raw heuristic positive
        calibratedExpectedNetR: -0.2, // but calibration says negative
        calibrationVerdict: "RAW_EDGE_NOT_VALIDATED",
        calibrationSampleSize: 9,
      }),
    );
    expect(decision.routeMode).toBe("DATA_COLLECTION");
    expect(decision.routeReasonCodes).toContain("CALIBRATION_BLOCKS_PROMOTION");
    expect(decision.dataCollectionReason).toMatch(/RAW_EDGE_NOT_VALIDATED|Calibrated|Calibration/);
  });

  it("HEURISTIC_OVERCONFIDENT with sample ≥ 5 demotes to DATA_COLLECTION", () => {
    const decision = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.5,
        calibratedExpectedNetR: 0.3, // still positive but...
        calibrationVerdict: "CALIBRATED_POSITIVE",
        calibrationSampleSize: 8,
        calibrationDiagnosisCodes: ["HEURISTIC_OVERCONFIDENT"],
      }),
    );
    expect(decision.routeMode).toBe("DATA_COLLECTION");
    expect(decision.routeReasonCodes).toContain("CALIBRATION_BLOCKS_PROMOTION");
  });

  it("HEURISTIC_OVERCONFIDENT with sample < 5 does NOT block promotion", () => {
    const decision = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.4,
        calibratedExpectedNetR: 0.4,
        calibrationVerdict: "CALIBRATED_POSITIVE",
        calibrationSampleSize: 3, // too small
        calibrationDiagnosisCodes: ["HEURISTIC_OVERCONFIDENT"],
      }),
    );
    expect(decision.routeMode).toBe("PROFIT_CANDIDATE");
    expect(decision.routeReasonCodes).not.toContain("CALIBRATION_BLOCKS_PROMOTION");
  });

  it("calibration absent → routing unchanged (backward compatibility)", () => {
    const decision = computeProfitRoute(
      baseInput({ variantConfidenceTier: "usable", expectedNetR: 0.4 }),
    );
    expect(decision.routeMode).toBe("PROFIT_CANDIDATE");
  });

  it("SHORT near breakeven prefers DATA_COLLECTION over RESEARCH_ONLY", () => {
    const decision = computeProfitRoute(
      baseInput({
        direction: "SHORT",
        expectedNetR: -0.02,
        variantConfidenceTier: "usable",
      }),
    );
    expect(decision.routeMode).toBe("DATA_COLLECTION");
  });

  // ── Ultra-tight stop credibility guard ──────────────────────────────────────

  it("ultra-tight stop: PROFIT_CANDIDATE demoted to DATA_COLLECTION when stopDistanceBps < 100", () => {
    // Candidate that would otherwise qualify as PROFIT_CANDIDATE
    const decision = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.25,
        cost: { costR: 0.1, spreadR: 0.03, feeSlippageR: 0.07, stopDistanceBps: 99 },
      }),
    );
    expect(decision.routeMode).toBe("DATA_COLLECTION");
    expect(decision.primaryProfitEligible).toBe(false);
    expect(decision.routeReasonCodes).toContain("STOP_DISTANCE_ULTRA_TIGHT");
  });

  it("ultra-tight stop boundary: stopDistanceBps = 100 does NOT trigger guard", () => {
    // Exactly at the boundary — guard fires only for strictly < 100
    const decision = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.25,
        cost: { costR: 0.1, spreadR: 0.03, feeSlippageR: 0.07, stopDistanceBps: 100 },
      }),
    );
    expect(decision.routeMode).toBe("PROFIT_CANDIDATE");
    expect(decision.primaryProfitEligible).toBe(true);
    expect(decision.routeReasonCodes).not.toContain("STOP_DISTANCE_ULTRA_TIGHT");
  });

  it("ultra-tight stop: missing stopDistanceBps → no crash, guard does not fire", () => {
    const decision = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.25,
        cost: { costR: 0.1, spreadR: 0.03, feeSlippageR: 0.07, stopDistanceBps: null },
      }),
    );
    // No STOP_DISTANCE_ULTRA_TIGHT in codes
    expect(decision.routeReasonCodes).not.toContain("STOP_DISTANCE_ULTRA_TIGHT");
    // Route is unaffected by the guard
    expect(decision.routeMode).toBe("PROFIT_CANDIDATE");
  });

  it("ultra-tight stop: existing DATA_COLLECTION preserved and reason code added", () => {
    // Candidate already routed DATA_COLLECTION by early-sample rule
    const decision = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "early",        // early tier → DATA_COLLECTION
        expectedNetR: 0.25,
        cost: { costR: 0.1, spreadR: 0.03, feeSlippageR: 0.07, stopDistanceBps: 80 },
      }),
    );
    expect(decision.routeMode).toBe("DATA_COLLECTION");
    expect(decision.primaryProfitEligible).toBe(false);
    expect(decision.routeReasonCodes).toContain("STOP_DISTANCE_ULTRA_TIGHT");
  });

  it("ultra-tight stop: existing RESEARCH_ONLY preserved — guard never loosens stricter mode", () => {
    // Candidate already RESEARCH_ONLY because net R is negative
    const decision = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: -0.4,                    // negative → RESEARCH_ONLY
        cost: { costR: 0.1, spreadR: 0.03, feeSlippageR: 0.07, stopDistanceBps: 80 },
      }),
    );
    expect(decision.routeMode).toBe("RESEARCH_ONLY");
    expect(decision.primaryProfitEligible).toBe(false);
    expect(decision.routeReasonCodes).toContain("STOP_DISTANCE_ULTRA_TIGHT");
  });

  it("ultra-tight stop: backward compatibility — payload without stopDistanceBps routes normally", () => {
    // Simulate an older selection payload where stopDistanceBps is undefined
    const input = baseInput({
      variantConfidenceTier: "usable",
      expectedNetR: 0.25,
    });
    // Manually delete the field to simulate missing key
    (input.cost as Partial<typeof input.cost>).stopDistanceBps = undefined as unknown as null;
    const decision = computeProfitRoute(input);
    expect(decision.routeReasonCodes).not.toContain("STOP_DISTANCE_ULTRA_TIGHT");
    expect(decision.routeMode).toBe("PROFIT_CANDIDATE");
  });

  it("profit-focused admission only promotes LOW-chase, >=500bps stop, RR 5-8", () => {
    const accepted = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.25,
        cost: { costR: 0.05, spreadR: 0.01, feeSlippageR: 0.04, stopDistanceBps: 600 },
        profitAdmission: { chaseRisk: "LOW", riskReward: 6 },
      }),
    );
    expect(accepted.routeMode).toBe("PROFIT_CANDIDATE");

    const chased = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.25,
        cost: { costR: 0.05, spreadR: 0.01, feeSlippageR: 0.04, stopDistanceBps: 600 },
        profitAdmission: { chaseRisk: "HIGH", riskReward: 6 },
      }),
    );
    expect(chased.routeMode).toBe("DATA_COLLECTION");
    expect(chased.routeReasonCodes).toContain("PROFIT_ENTRY_CHASED");

    const narrowStop = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.25,
        cost: { costR: 0.05, spreadR: 0.01, feeSlippageR: 0.04, stopDistanceBps: 499 },
        profitAdmission: { chaseRisk: "LOW", riskReward: 6 },
      }),
    );
    expect(narrowStop.routeMode).toBe("DATA_COLLECTION");
    expect(narrowStop.routeReasonCodes).toContain("PROFIT_STOP_BELOW_EVIDENCE_FLOOR");

    const extremeRr = computeProfitRoute(
      baseInput({
        variantConfidenceTier: "usable",
        expectedNetR: 0.25,
        cost: { costR: 0.05, spreadR: 0.01, feeSlippageR: 0.04, stopDistanceBps: 600 },
        profitAdmission: { chaseRisk: "LOW", riskReward: 8.01 },
      }),
    );
    expect(extremeRr.routeMode).toBe("DATA_COLLECTION");
    expect(extremeRr.routeReasonCodes).toContain("PROFIT_RR_OUTSIDE_EVIDENCE_BAND");
  });
});

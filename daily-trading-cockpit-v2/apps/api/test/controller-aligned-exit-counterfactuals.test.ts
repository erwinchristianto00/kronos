/**
 * Tests for controller-aligned-exit-counterfactuals.ts
 *
 * Verifies pure counterfactual computation for exit variants:
 * TP1_FULL_EXIT, TP2_FULL_EXIT, TP1_50_TP2_50, TP1_50_RUNNER_TP3.
 */

import { describe, it, expect } from "vitest";
import {
  buildExitVariantCounterfactuals,
  type ExitCounterfactualObservation,
} from "../src/lib/controller-aligned-exit-counterfactuals.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWin(
  tp1 = 1.1,
  tp2 = 1.2,
  tp3 = 1.3,
  entry = 1.0,
  stop = 0.9,
  costR = 0.1,
  controllerMode = "LONG_ONLY",
): ExitCounterfactualObservation {
  const stopDist = entry - stop;
  const grossR = (tp1 - entry) / stopDist;
  return {
    status: "CLOSED_WIN",
    entryPrice: entry,
    stopLoss: stop,
    takeProfitLevels: [tp1, tp2, tp3],
    costR,
    grossR,
    netR: grossR - costR,
    controllerMode,
    direction: "LONG",
  };
}

function makeLoss(
  entry = 1.0,
  stop = 0.9,
  costR = 0.1,
  controllerMode = "LONG_ONLY",
): ExitCounterfactualObservation {
  return {
    status: "CLOSED_LOSS",
    entryPrice: entry,
    stopLoss: stop,
    takeProfitLevels: [1.1, 1.2, 1.3],
    costR,
    grossR: -1.0,
    netR: -1.0 - costR,
    controllerMode,
    direction: "LONG",
  };
}

// Precision helper
function round4(n: number | null): number | null {
  if (n === null) return null;
  return Math.round(n * 10000) / 10000;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildExitVariantCounterfactuals", () => {
  // Test 1: TP1_FULL_EXIT grossR for a single win
  it("1. TP1_FULL_EXIT grossR = (tp1 - entry) / (entry - stop)", () => {
    // entry=1.0, stop=0.9, tp1=1.1 → (1.1-1.0)/(1.0-0.9) = 1.0
    const obs = makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0.1);
    // Need a second obs for min-2 check
    const result = buildExitVariantCounterfactuals([obs, makeLoss()]);
    const tp1 = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT");
    expect(tp1).toBeDefined();
    // avgWinGrossR from the single win should be 1.0
    expect(round4(tp1!.avgWinGrossR)).toBe(1.0);
  });

  // Test 2: TP2_FULL_EXIT grossR for a single win
  it("2. TP2_FULL_EXIT grossR = (tp2 - entry) / (entry - stop) = 2.0", () => {
    // entry=1.0, stop=0.9, tp2=1.2 → (1.2-1.0)/(1.0-0.9) = 2.0
    const obs = makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0.1);
    const result = buildExitVariantCounterfactuals([obs, makeLoss()]);
    const tp2 = result.variants.find((v) => v.variantLabel === "TP2_FULL_EXIT");
    expect(round4(tp2!.avgWinGrossR)).toBe(2.0);
  });

  // Test 3: TP1_50_TP2_50 grossR = 0.5*1.0 + 0.5*2.0 = 1.5
  it("3. TP1_50_TP2_50 grossR = 0.5*tp1R + 0.5*tp2R = 1.5", () => {
    const obs = makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0.1);
    const result = buildExitVariantCounterfactuals([obs, makeLoss()]);
    const v = result.variants.find((v) => v.variantLabel === "TP1_50_TP2_50");
    expect(round4(v!.avgWinGrossR)).toBe(1.5);
  });

  // Test 4: TP1_50_RUNNER_TP3 grossR = 0.5*1.0 + 0.5*3.0 = 2.0
  it("4. TP1_50_RUNNER_TP3 grossR = 0.5*tp1R + 0.5*tp3R = 2.0", () => {
    // tp3=1.3, stopDist=0.1 → tp3R=(1.3-1.0)/0.1=3.0; 0.5*1.0+0.5*3.0=2.0
    const obs = makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0.1);
    const result = buildExitVariantCounterfactuals([obs, makeLoss()]);
    const v = result.variants.find((v) => v.variantLabel === "TP1_50_RUNNER_TP3");
    expect(round4(v!.avgWinGrossR)).toBe(2.0);
  });

  // Test 5: CLOSED_LOSS — all variants grossR = -1.0
  it("5. CLOSED_LOSS: all variants have avgLossGrossR = -1.0", () => {
    const loss1 = makeLoss();
    const loss2 = makeLoss(1.0, 0.9, 0.1, "SHORT_ONLY");
    const result = buildExitVariantCounterfactuals([loss1, loss2]);
    for (const v of result.variants) {
      expect(round4(v.avgLossGrossR)).toBe(-1.0);
    }
  });

  // Test 6: WR identical across all variants for same obs set
  it("6. WR identical across all variants", () => {
    const obs = [makeWin(), makeWin(), makeLoss(), makeLoss(), makeLoss()];
    const result = buildExitVariantCounterfactuals(obs);
    const wrs = result.variants.map((v) => v.WR);
    // All WRs should be equal
    expect(wrs[0]).not.toBeNull();
    for (const wr of wrs) {
      expect(round4(wr)).toBe(round4(wrs[0]));
    }
    // 2 wins / 5 total = 0.4
    expect(round4(wrs[0])).toBe(0.4);
  });

  // Test 7: TP2_FULL has higher avgWinGrossR than TP1_FULL
  it("7. TP2_FULL avgWinGrossR > TP1_FULL avgWinGrossR", () => {
    const obs = [makeWin(1.1, 1.2, 1.3), makeWin(1.1, 1.2, 1.3), makeLoss()];
    const result = buildExitVariantCounterfactuals(obs);
    const tp1 = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT")!;
    const tp2 = result.variants.find((v) => v.variantLabel === "TP2_FULL_EXIT")!;
    expect(tp2.avgWinGrossR!).toBeGreaterThan(tp1.avgWinGrossR!);
  });

  // Test 8: payoffRatio = avgWinGrossR / |avgLossGrossR|
  it("8. payoffRatio = avgWinGrossR / |avgLossGrossR|", () => {
    // 1 win (tp1GrossR=1.0), 1 loss (grossR=-1.0)
    const obs = [makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0), makeLoss(1.0, 0.9, 0)];
    const result = buildExitVariantCounterfactuals(obs);
    const tp1 = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT")!;
    // avgWinGrossR=1.0, avgLossGrossR=-1.0 → payoffRatio=1.0
    expect(round4(tp1.payoffRatio)).toBe(1.0);
    const tp2 = result.variants.find((v) => v.variantLabel === "TP2_FULL_EXIT")!;
    // avgWinGrossR=2.0, avgLossGrossR=-1.0 → payoffRatio=2.0
    expect(round4(tp2.payoffRatio)).toBe(2.0);
  });

  // Test 9: netR = grossR - costR per observation
  it("9. avgNetR = avgGrossR - avgCostR (approximately)", () => {
    // 1 win, 1 loss, no TP multi-levels needed
    const obs = [makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0.1), makeLoss(1.0, 0.9, 0.1)];
    const result = buildExitVariantCounterfactuals(obs);
    const tp1 = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT")!;
    // win grossR=1.0, loss grossR=-1.0 → avgGrossR=0.0; costR=0.1 always → avgNetR=-0.1
    expect(round4(tp1.avgGrossR)).toBe(0.0);
    expect(round4(tp1.avgCostR)).toBe(0.1);
    expect(round4(tp1.avgNetR)).toBe(-0.1);
  });

  // Test 10: PF computed correctly
  it("10. PF = sum(positive netR) / |sum(negative netR)|", () => {
    // 2 wins (grossR=1.0, costR=0), 1 loss (grossR=-1.0, costR=0)
    const win1 = makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0);
    const win2 = makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0);
    const loss1 = makeLoss(1.0, 0.9, 0);
    const result = buildExitVariantCounterfactuals([win1, win2, loss1]);
    const tp1 = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT")!;
    // netRs: [1.0, 1.0, -1.0] → positiveSum=2.0, negativeSum=1.0 → PF=2.0
    expect(round4(tp1.PF)).toBe(2.0);
  });

  // Test 11: missing tp2 falls back to tp1
  it("11. missing tp2 falls back to tp1 for TP2_FULL_EXIT", () => {
    const obs: ExitCounterfactualObservation = {
      status: "CLOSED_WIN",
      entryPrice: 1.0,
      stopLoss: 0.9,
      takeProfitLevels: [1.1], // no tp2 or tp3
      costR: 0.1,
      grossR: 1.0,
      netR: 0.9,
      controllerMode: "LONG_ONLY",
      direction: "LONG",
    };
    const result = buildExitVariantCounterfactuals([obs, makeLoss()]);
    const tp1v = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT")!;
    const tp2v = result.variants.find((v) => v.variantLabel === "TP2_FULL_EXIT")!;
    // Without tp2, fallback means tp2R = tp1R
    expect(round4(tp2v.avgWinGrossR)).toBe(round4(tp1v.avgWinGrossR));
  });

  // Test 12: bestByNetAvgR is correctly identified
  it("12. bestByNetAvgR identifies the variant with highest avgNetR", () => {
    // With tp1=1.1, tp2=1.2, tp3=1.3, all wins: TP2 > TP1 for avgWinR
    const obs = [makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0), makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0), makeLoss(1.0, 0.9, 0)];
    const result = buildExitVariantCounterfactuals(obs);
    // TP1_50_RUNNER_TP3 has highest avgWinR = 0.5*1.0 + 0.5*3.0 = 2.0
    // With 2 wins and 1 loss (WR=2/3), it should produce the highest avgNetR
    expect(result.bestByNetAvgR).toBeDefined();
    // TP1_50_RUNNER_TP3 wins by avgWinR
    expect(result.bestByNetAvgR).toBe("TP1_50_RUNNER_TP3");
  });

  // Test 13: SHORT direction grossR computed correctly
  it("13. SHORT direction: grossR = (entry - tp1) / (stop - entry)", () => {
    // SHORT: entry=1.0, stop=1.1 (above entry), tp1=0.9 (below entry)
    // stopDist = stop - entry = 0.1; grossR = (entry - tp1) / stopDist = (1.0-0.9)/0.1 = 1.0
    const shortWin: ExitCounterfactualObservation = {
      status: "CLOSED_WIN",
      entryPrice: 1.0,
      stopLoss: 1.1,
      takeProfitLevels: [0.9, 0.8, 0.7],
      costR: 0.1,
      grossR: 1.0,
      netR: 0.9,
      controllerMode: "SHORT_ONLY",
      direction: "SHORT",
    };
    const shortLoss: ExitCounterfactualObservation = {
      status: "CLOSED_LOSS",
      entryPrice: 1.0,
      stopLoss: 1.1,
      takeProfitLevels: [0.9, 0.8, 0.7],
      costR: 0.1,
      grossR: -1.0,
      netR: -1.1,
      controllerMode: "SHORT_ONLY",
      direction: "SHORT",
    };
    const result = buildExitVariantCounterfactuals([shortWin, shortLoss]);
    const tp1 = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT")!;
    expect(round4(tp1.avgWinGrossR)).toBe(1.0);
    const tp2 = result.variants.find((v) => v.variantLabel === "TP2_FULL_EXIT")!;
    // tp2=0.8 → (1.0-0.8)/0.1 = 2.0
    expect(round4(tp2.avgWinGrossR)).toBe(2.0);
    const tp3 = result.variants.find((v) => v.variantLabel === "TP1_50_RUNNER_TP3")!;
    // tp3=0.7 → (1.0-0.7)/0.1=3.0; 0.5*1.0+0.5*3.0=2.0
    expect(round4(tp3.avgWinGrossR)).toBe(2.0);
  });

  // Test 14: byMode breakdown groups correctly
  it("14. byMode breakdown groups observations by controllerMode", () => {
    const longWin = makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0.1, "LONG_ONLY");
    const shortWin = makeWin(1.1, 1.2, 1.3, 1.0, 0.9, 0.1, "SHORT_ONLY");
    const longLoss = makeLoss(1.0, 0.9, 0.1, "LONG_ONLY");
    const result = buildExitVariantCounterfactuals([longWin, shortWin, longLoss]);
    expect(result.byMode).toHaveLength(2);
    const longMode = result.byMode.find((m) => m.controllerMode === "LONG_ONLY");
    const shortMode = result.byMode.find((m) => m.controllerMode === "SHORT_ONLY");
    expect(longMode).toBeDefined();
    expect(shortMode).toBeDefined();
    // LONG_ONLY has 2 obs (1 win + 1 loss), SHORT_ONLY has 1 obs (1 win)
    expect(longMode!.variants[0]!.resolvedN).toBe(2);
    expect(shortMode!.variants[0]!.resolvedN).toBe(1);
  });

  // Test 15: returns empty/null report gracefully with < 2 resolved obs
  it("15. returns empty report with < 2 resolved observations", () => {
    // 0 observations
    const result0 = buildExitVariantCounterfactuals([]);
    expect(result0.variants).toHaveLength(0);
    expect(result0.bestByNetAvgR).toBeNull();
    expect(result0.bestByPF).toBeNull();

    // 1 observation (below threshold)
    const result1 = buildExitVariantCounterfactuals([makeWin()]);
    expect(result1.variants).toHaveLength(0);

    // Open observations are excluded (not CLOSED_WIN or CLOSED_LOSS)
    const openObs: ExitCounterfactualObservation = {
      status: "OPEN",
      entryPrice: 1.0,
      stopLoss: 0.9,
      takeProfitLevels: [1.1],
      costR: null,
      grossR: null,
      netR: null,
      controllerMode: "LONG_ONLY",
    };
    const result2 = buildExitVariantCounterfactuals([openObs, openObs]);
    expect(result2.variants).toHaveLength(0);
  });

  // Test: reportOnly is always true
  it("reportOnly is always true", () => {
    const result = buildExitVariantCounterfactuals([makeWin(), makeLoss()]);
    expect(result.reportOnly).toBe(true);
  });

  // Test: approximationNote is present
  it("approximationNote is populated", () => {
    const result = buildExitVariantCounterfactuals([makeWin(), makeLoss()]);
    expect(result.approximationNote).toContain("WR identical");
  });

  // Test: direction inferred from stopLoss vs entryPrice when not explicit
  it("direction inferred correctly when not provided", () => {
    const obs: ExitCounterfactualObservation = {
      status: "CLOSED_WIN",
      entryPrice: 1.0,
      stopLoss: 0.9, // stop < entry → infers LONG
      takeProfitLevels: [1.1, 1.2, 1.3],
      costR: 0.1,
      grossR: 1.0,
      netR: 0.9,
      controllerMode: "LONG_ONLY",
      // no direction field
    };
    const result = buildExitVariantCounterfactuals([obs, makeLoss()]);
    const tp1 = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT")!;
    expect(round4(tp1.avgWinGrossR)).toBe(1.0);
  });

  // Test: costR derived from stopDistanceBps when costR field is null
  it("costR derived from stopDistanceBps when costR is null", () => {
    const obs: ExitCounterfactualObservation = {
      status: "CLOSED_WIN",
      entryPrice: 1.0,
      stopLoss: 0.9,
      takeProfitLevels: [1.1, 1.2, 1.3],
      costR: null,          // will be derived
      grossR: 1.0,
      netR: null,
      controllerMode: "LONG_ONLY",
      direction: "LONG",
      stopDistanceBps: 1000, // costR = 28/1000 = 0.028
    };
    const loss: ExitCounterfactualObservation = {
      status: "CLOSED_LOSS",
      entryPrice: 1.0,
      stopLoss: 0.9,
      takeProfitLevels: [1.1],
      costR: null,
      grossR: -1.0,
      netR: null,
      controllerMode: "LONG_ONLY",
      direction: "LONG",
      stopDistanceBps: 1000,
    };
    const result = buildExitVariantCounterfactuals([obs, loss]);
    const tp1 = result.variants.find((v) => v.variantLabel === "TP1_FULL_EXIT")!;
    // avgCostR should be derived: 28/1000 = 0.028
    expect(round4(tp1.avgCostR)).toBe(0.028);
  });

  // Test: winN and lossN counts are correct
  it("winN and lossN counts match input observations", () => {
    const obs = [makeWin(), makeWin(), makeWin(), makeLoss(), makeLoss()];
    const result = buildExitVariantCounterfactuals(obs);
    for (const v of result.variants) {
      expect(v.winN).toBe(3);
      expect(v.lossN).toBe(2);
      expect(v.resolvedN).toBe(5);
    }
  });
});

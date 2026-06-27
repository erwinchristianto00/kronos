import { describe, expect, it } from "vitest";

import {
  estimateLaneSelectorV2Regime,
  laneSelectorV2LaneId,
  selectLaneV2,
} from "../src/lib/lane-selector-v2.js";

describe("LaneSelectorV2", () => {
  it("lets symbol-specific edge override a stronger global lane", () => {
    const result = selectLaneV2({
      candidate: {
        symbol: "BTCUSDT",
        direction: "SHORT",
        currentPrice: 100,
        stopLoss: 104,
        takeProfitLevels: [94],
        stopDistanceBps: 400,
      },
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      now: "2026-06-25T04:00:00.000Z",
      laneStates: [
        {
          variantId: "CG_WIDE_FAST_SHORT",
          status: "STABLE_CANDIDATE",
          freshValid: 300,
          netAvgR: 0.5,
          pf: 2,
          wr: 0.7,
          payoffRatio: 0.75,
          plus10bpsStillPositive: true,
          bySymbol: [{ key: "BTCUSDT", n: 12, netAvgR: -0.45 }],
        },
        {
          variantId: "CG_MFE_GIVEBACK",
          status: "STABLE_CANDIDATE",
          freshValid: 180,
          netAvgR: 0.2,
          pf: 1.5,
          wr: 0.56,
          payoffRatio: 1.2,
          plus10bpsStillPositive: true,
          bySymbol: [{ key: "BTCUSDT", n: 12, netAvgR: 0.6 }],
        },
      ],
    });

    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_MFE_GIVEBACK"));
    expect(result.evaluated[0]!.variantId).toBe("CG_MFE_GIVEBACK");
    expect(result.selected?.scoreBreakdown.symbolEdge).toBeGreaterThan(0);
  });

  it("uses STOP WIDE TP WIDE when estimated regime is extended in the candidate direction", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      confidence: "MEDIUM",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "ETHUSDT",
        direction: "SHORT",
        currentPrice: 100,
        stopLoss: 104,
        takeProfitLevels: [94],
        stopDistanceBps: 400,
      },
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "MEDIUM",
      estimatedRegime,
      now: "2026-06-25T04:00:00.000Z",
      laneStates: [
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_TIGHT_FAST_05", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(estimatedRegime.policy).toBe("WIDE_TREND");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
  });

  it("uses tactical 70/30 policy in mixed or short-lived regimes", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Mixed rotation",
      controllerMode: "VALIDATION_ONLY",
      confidence: "LOW",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "ETHUSDT",
        direction: "SHORT",
        currentPrice: 100,
        stopLoss: 104,
        takeProfitLevels: [94],
        stopDistanceBps: 400,
      },
      regime: "Mixed rotation",
      controllerMode: "VALIDATION_ONLY",
      controllerConfidence: "LOW",
      estimatedRegime,
      now: "2026-06-25T04:00:00.000Z",
      laneStates: [
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_TIGHT_FAST_05", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
      ],
    });

    expect(estimatedRegime.policy).toBe("TACTICAL_70_30");
    expect([
      laneSelectorV2LaneId("CG_EXP_SHORT_MFE_GIVEBACK_10X"),
      laneSelectorV2LaneId("CG_TIGHT_FAST_05"),
    ]).toContain(result.selected?.lane.selectedLaneId);
    expect(result.selected?.lane.selectedLaneId).not.toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
  });
});

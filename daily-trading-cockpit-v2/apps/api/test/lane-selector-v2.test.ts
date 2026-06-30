import { describe, expect, it } from "vitest";

import {
  estimateLaneSelectorV2Regime,
  laneSelectorV2LaneId,
  selectLaneV2,
} from "../src/lib/lane-selector-v2.js";

describe("LaneSelectorV2", () => {
  it("refuses score-only short lanes when recommended policy lanes are unavailable", () => {
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
          // CG_TIGHT_FAST_05 is score-qualified but NOT a regime-policy lane (the policy targets are
          // WIDE_STOP_TP_WIDE / WIDE_FAST_SHORT / EXP_10X), so it must be refused when no policy lane is offered.
          variantId: "CG_TIGHT_FAST_05",
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

    expect(result.selected).toBeNull();
    expect(result.evaluated[0]!.variantId).toBe("CG_MFE_GIVEBACK");
    expect(result.evaluated[0]!.scoreBreakdown.symbolEdge).toBeGreaterThan(0);
    expect(result.rejected).toContain("CG_WIDE_STOP_TP_WIDE:policy_target_unavailable");
  });

  it("keeps STOP WIDE TP WIDE when SHORT_ONLY is an extended trend", () => {
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
        { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_TIGHT_FAST_05", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(estimatedRegime.policy).toBe("WIDE_TREND");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
  });

  it("uses WIDE FAST SHORT for the secondary short-extended bucket", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      confidence: "MEDIUM",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "XRPUSDT", // deterministic bucket 84 at this minute
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
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(estimatedRegime.policy).toBe("WIDE_TREND");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
  });

  it("uses WIDE FAST SHORT for the small short-extended secondary bucket", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      confidence: "MEDIUM",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "DOGEUSDT", // deterministic bucket 99 at this minute
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
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
      ],
    });

    expect(estimatedRegime.policy).toBe("WIDE_TREND");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
  });

  it("uses STOP WIDE for the 75% primary bucket when SHORT_ONLY is not extended", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
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
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "LOW",
      estimatedRegime,
      now: "2026-06-25T04:00:00.000Z",
      laneStates: [
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_TIGHT_FAST_05", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(estimatedRegime.policy).toBe("TACTICAL_70_30");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
  });

  it("falls back to STOP WIDE when disabled EXP is present in the tactical secondary bucket", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      confidence: "LOW",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "DOGEUSDT", // deterministic bucket 99 -> secondary bucket at this minute
        direction: "SHORT",
        currentPrice: 100,
        stopLoss: 104,
        takeProfitLevels: [94],
        stopDistanceBps: 400,
      },
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "LOW",
      estimatedRegime,
      now: "2026-06-25T04:00:00.000Z",
      laneStates: [
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
      ],
    });

    expect(estimatedRegime.policy).toBe("TACTICAL_70_30");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
  });

  it("falls back to STOP WIDE in short-extended even when EXP MFE is not stable", () => {
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
        { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "WATCHABLE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_MFE_GIVEBACK", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.5, pf: 2 },
        { variantId: "CG_TIGHT_FAST_05", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(estimatedRegime.policy).toBe("WIDE_TREND");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
    expect(result.rejected).toContain("CG_EXP_SHORT_MFE_GIVEBACK_10X:status_WATCHABLE");
  });

  it("uses STOP WIDE first in mixed short regimes for the 75% primary bucket", () => {
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
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
  });

  it("blocks NEARUSDT in mixed regimes", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Mixed rotation",
      controllerMode: "VALIDATION_ONLY",
      confidence: "LOW",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "NEARUSDT",
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
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(result.selected).toBeNull();
    expect(result.rejected).toContain("mixed_symbol_blocked:NEARUSDT");
  });

  it("disables longs in tactical/mixed regimes (longs only fire in WIDE_TREND)", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Mixed rotation",
      controllerMode: "VALIDATION_ONLY",
      confidence: "LOW",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "ETHUSDT",
        direction: "LONG",
        currentPrice: 100,
        stopLoss: 97,
        takeProfitLevels: [103],
        stopDistanceBps: 300,
      },
      regime: "Mixed rotation",
      controllerMode: "VALIDATION_ONLY",
      controllerConfidence: "LOW",
      estimatedRegime,
      now: "2026-06-25T04:00:00.000Z",
      laneStates: [
        { variantId: "CG_EXP_LONG_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_WIDE_FAST_LONG", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(result.selected).toBeNull();
    expect(result.rejected).toContain("long_tactical_disabled");
  });

  it("prioritizes CG_WIDE_FAST_LONG (0.5R) for long in a WIDE_TREND bull", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Bullish expansion",
      controllerMode: "LONG_ONLY",
      confidence: "MEDIUM",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "ETHUSDT",
        direction: "LONG",
        currentPrice: 100,
        stopLoss: 97,
        takeProfitLevels: [110],
        stopDistanceBps: 300,
      },
      regime: "Bullish expansion",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "MEDIUM",
      estimatedRegime,
      now: "2026-06-25T04:00:00.000Z",
      laneStates: [
        { variantId: "CG_WIDE_FAST_LONG", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.3, pf: 1.4 },
      ],
    });

    expect(estimatedRegime.policy).toBe("WIDE_TREND");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_LONG"));
    // fast 0.5R on a 300bps wide stop: entry 100, stop 97, TP = 100 + 0.5×3 = 101.5.
    expect(result.selected?.stop).toBeCloseTo(97, 6);
    expect(result.selected?.tp1).toBeCloseTo(101.5, 6);
  });
});

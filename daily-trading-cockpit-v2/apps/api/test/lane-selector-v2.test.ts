import { describe, expect, it } from "vitest";

import {
  estimateLaneSelectorV2Regime,
  laneSelectorV2LaneId,
  selectLaneV2,
} from "../src/lib/lane-selector-v2.js";

describe("LaneSelectorV2", () => {
  it("allows a non-stable lane only when the bearish rotation shortlist proves that exact symbol", () => {
    const result = selectLaneV2({
      candidate: {
        symbol: "INJUSDT",
        direction: "SHORT",
        currentPrice: 100,
        stopLoss: 104,
        takeProfitLevels: [94],
        stopDistanceBps: 400,
      },
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "MEDIUM",
      now: "2026-07-05T04:00:00.000Z",
      rotationShortlist: {
        generatedAt: "2026-07-05T04:00:00.000Z",
        minAllowSample: 10,
        minWatchSample: 5,
        bearishGlobal: [],
        bullishGlobal: [],
        lanes: [
          {
            laneId: laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"),
            variantId: "CG_WIDE_STOP_TP_WIDE",
            label: "Wide",
            bullish: [],
            bearish: [
              {
                symbol: "INJUSDT",
                n: 18,
                netAvgR: 0.22,
                pf: 2.1,
                wr: 0.78,
                score: 30,
                verdict: "ALLOW",
                reason: "test allow",
              },
            ],
          },
        ],
      },
      laneStates: [
        {
          variantId: "CG_WIDE_STOP_TP_WIDE",
          status: "REJECT",
          freshValid: 200,
          netAvgR: -0.3,
          pf: 0.6,
          wr: 0.45,
          byAxisSymbol: [{ key: "SHORT_BEARISH|INJUSDT", n: 18, netAvgR: 0.22 }],
        },
        {
          variantId: "CG_WIDE_FAST_SHORT",
          status: "REJECT",
          freshValid: 200,
          netAvgR: 9,
          pf: 9,
        },
      ],
    });

    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
    expect(result.evaluated.map((item) => item.variantId)).toContain("CG_WIDE_STOP_TP_WIDE");
  });

  it("does not let a rejected lane trade a bearish symbol outside its rotation shortlist", () => {
    const result = selectLaneV2({
      candidate: {
        symbol: "WLDUSDT",
        direction: "SHORT",
        currentPrice: 100,
        stopLoss: 104,
        takeProfitLevels: [94],
        stopDistanceBps: 400,
      },
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "MEDIUM",
      now: "2026-07-05T04:00:00.000Z",
      rotationShortlist: {
        generatedAt: "2026-07-05T04:00:00.000Z",
        minAllowSample: 10,
        minWatchSample: 5,
        bearishGlobal: [],
        bullishGlobal: [],
        lanes: [
          {
            laneId: laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"),
            variantId: "CG_WIDE_STOP_TP_WIDE",
            label: "Wide",
            bullish: [],
            bearish: [
              {
                symbol: "INJUSDT",
                n: 18,
                netAvgR: 0.22,
                pf: 2.1,
                wr: 0.78,
                score: 30,
                verdict: "ALLOW",
                reason: "test allow",
              },
            ],
          },
        ],
      },
      laneStates: [
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(result.selected).toBeNull();
    expect(result.rejected).toContain("CG_WIDE_STOP_TP_WIDE:rotation_shortlist_blocked");
  });

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
    expect(result.rejected).toContain("CG_WIDE_FAST_SHORT:policy_target_unavailable");
  });

  it("never attributes an UNRELATED symbol's cohort edge via substring containment (exact match only)", () => {
    // "1000PEPEUSDT" contains "PEPEUSDT" as a literal substring — a real, not hypothetical, pattern
    // on Binance Futures (rebased/leveraged contracts). Before the fix, matchedCohortNet's
    // `candidateKey.includes(wanted)` fallback would have silently attributed this unrelated
    // symbol's strong +0.9 cohort edge to a PEPEUSDT candidate that has no cohort data of its own.
    const result = selectLaneV2({
      candidate: {
        symbol: "PEPEUSDT",
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
          variantId: "CG_MFE_GIVEBACK",
          status: "STABLE_CANDIDATE",
          freshValid: 200,
          netAvgR: 0.1,
          pf: 1.5,
          wr: 0.55,
          payoffRatio: 1.1,
          plus10bpsStillPositive: true,
          bySymbol: [{ key: "1000PEPEUSDT", n: 20, netAvgR: 0.9 }],
        },
      ],
    });

    // symbolEdge must be exactly 0 (the neutral no-cohort-data fallback) — never influenced by the
    // unrelated "1000PEPEUSDT" row's +0.9 netAvgR.
    expect(result.evaluated[0]!.scoreBreakdown.symbolEdge).toBe(0);
  });

  it("uses WIDE FAST SHORT when SHORT_ONLY is an extended trend (CG_WIDE_STOP_TP_WIDE cut from the split 2026-07-01)", () => {
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
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_TIGHT_FAST_05", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(estimatedRegime.policy).toBe("WIDE_TREND");
    // CG_WIDE_FAST_SHORT is picked even though CG_WIDE_STOP_TP_WIDE scores far higher here —
    // it is no longer a preferred candidate at all, regardless of score.
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
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

  it("uses WIDE FAST SHORT when SHORT_ONLY is not extended (tactical regime, CG_WIDE_STOP_TP_WIDE no longer a candidate)", () => {
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
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
        { variantId: "CG_TIGHT_FAST_05", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
      ],
    });

    expect(estimatedRegime.policy).toBe("TACTICAL_70_30");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
  });

  it("uses WIDE FAST SHORT in the tactical regime even when EXP MFE also scores well", () => {
    const estimatedRegime = estimateLaneSelectorV2Regime({
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      confidence: "LOW",
    });
    const result = selectLaneV2({
      candidate: {
        symbol: "DOGEUSDT",
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
        { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
      ],
    });

    expect(estimatedRegime.policy).toBe("TACTICAL_70_30");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
  });

  it("uses WIDE FAST SHORT in short-extended even when EXP MFE is not stable", () => {
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
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
    expect(result.rejected).toContain("CG_EXP_SHORT_MFE_GIVEBACK_10X:status_WATCHABLE");
  });

  it("uses WIDE FAST SHORT in mixed short regimes (tactical policy)", () => {
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
        { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
        { variantId: "CG_TIGHT_FAST_05", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.1, pf: 1.2 },
      ],
    });

    expect(estimatedRegime.policy).toBe("TACTICAL_70_30");
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
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

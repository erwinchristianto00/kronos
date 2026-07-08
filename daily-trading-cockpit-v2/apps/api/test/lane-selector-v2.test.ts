import { describe, expect, it } from "vitest";

import {
  estimateLaneSelectorV2Regime,
  laneSelectorV2LaneId,
  selectLaneV2,
} from "../src/lib/lane-selector-v2.js";

// 2026-07-08 operator per-symbol audit: CG_WIDE_FAST_SHORT's pooled testnet/live stats looked
// flat-to-negative (WR ~55%, meanR ~-0.2) despite the SAME week showing WLD/SUI/FET at 87-100%
// WR — NEAR/INJ/XRP/SEI sat at 17-48% WR (well under the 66.7% breakeven bar for a 0.5R target)
// in that identical window, on BOTH testnet and live independently. Confirmed genuine per-symbol
// underperformance, not a regime-timing artifact. excludedSymbols blocks REAL admission only —
// measurement (current-guard-variant-matrix.ts) keeps recording all symbols for OOS tracking.
describe("LaneSelectorV2 — excludedSymbols (per-symbol real-admission block)", () => {
  const stableFastShortOnly = [
    { variantId: "CG_WIDE_FAST_SHORT" as const, status: "STABLE_CANDIDATE" as const, freshValid: 200, netAvgR: 0.3, pf: 1.3 },
  ];
  function shortAt(symbol: string) {
    return selectLaneV2({
      candidate: { symbol, direction: "SHORT" as const, currentPrice: 100, stopLoss: 103, takeProfitLevels: [98.5], stopDistanceBps: 300 },
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "MEDIUM",
      now: "2026-07-08T04:00:00.000Z",
      laneStates: stableFastShortOnly,
    });
  }

  it("rejects NEAR/INJ/XRP/SEI for CG_WIDE_FAST_SHORT with an explicit symbol_excluded reason", () => {
    for (const symbol of ["NEARUSDT", "INJUSDT", "XRPUSDT", "SEIUSDT"]) {
      const result = shortAt(symbol);
      expect(result.selected).toBeNull();
      expect(result.rejected).toContain(`CG_WIDE_FAST_SHORT:symbol_excluded_${symbol}`);
    }
  });

  it("still allows the verified-good symbols (WLD/DOGE/SUI/FET) through CG_WIDE_FAST_SHORT", () => {
    for (const symbol of ["WLDUSDT", "DOGEUSDT", "SUIUSDT", "FETUSDT"]) {
      const result = shortAt(symbol);
      expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
    }
  });

  it("is case-insensitive (lowercase candidate symbol still gets blocked)", () => {
    const result = shortAt("nearusdt");
    expect(result.selected).toBeNull();
  });

  // NEARUSDT is excluded from CG_WIDE_FAST_SHORT specifically — but selectLaneV2 hardcodes
  // CG_WIDE_FAST_SHORT as the preferred policy target for ANY plain SHORT candidate (2026-07-01
  // real-money decision, see policyPreferredVariants), so proving "a different lane still works
  // for the same symbol" requires the SAME rotation-shortlist escape hatch the pre-existing tests
  // below use (shortlistEligibleVariantIds.size > 0 bypasses that hardcoded preference).
  it("does NOT block the same symbol for an unrelated lane (scope is per-variant, not global)", () => {
    const result = selectLaneV2({
      candidate: { symbol: "NEARUSDT", direction: "SHORT" as const, currentPrice: 100, stopLoss: 104, takeProfitLevels: [94], stopDistanceBps: 400 },
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "MEDIUM",
      now: "2026-07-08T04:00:00.000Z",
      rotationShortlist: {
        generatedAt: "2026-07-08T04:00:00.000Z",
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
              { symbol: "NEARUSDT", n: 18, netAvgR: 0.22, pf: 2.1, wr: 0.78, score: 30, verdict: "ALLOW", reason: "test allow" },
            ],
          },
        ],
      },
      laneStates: [
        { variantId: "CG_WIDE_STOP_TP_WIDE", status: "REJECT", freshValid: 200, netAvgR: -0.3, pf: 0.6, wr: 0.45, byAxisSymbol: [{ key: "SHORT_BEARISH|NEARUSDT", n: 18, netAvgR: 0.22 }] },
      ],
    });
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_STOP_TP_WIDE"));
  });
});

describe("LaneSelectorV2 — manualEnabledVariantIds bypass (2026-07-08, wiring new lanes into allocation)", () => {
  const twoCompetingShortLanes = [
    { variantId: "CG_WIDE_FAST_SHORT" as const, status: "STABLE_CANDIDATE" as const, freshValid: 200, netAvgR: 0.1, pf: 1.1 },
    { variantId: "CG_MFE_GIVEBACK" as const, status: "STABLE_CANDIDATE" as const, freshValid: 200, netAvgR: 0.5, pf: 2.0 },
  ];
  function shortCandidate(overrides: Partial<Parameters<typeof selectLaneV2>[0]> = {}) {
    return selectLaneV2({
      candidate: { symbol: "BTCUSDT", direction: "SHORT" as const, currentPrice: 100, stopLoss: 104, takeProfitLevels: [94], stopDistanceBps: 400 },
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "MEDIUM",
      now: "2026-07-08T04:00:00.000Z",
      laneStates: twoCompetingShortLanes,
      ...overrides,
    });
  }

  it("without manualEnabledVariantIds, the hardcoded CG_WIDE_FAST_SHORT preference wins regardless of score (unchanged default)", () => {
    const result = shortCandidate();
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
  });

  it("an empty manualEnabledVariantIds set behaves the same as omitted (still hardcoded default)", () => {
    const result = shortCandidate({ manualEnabledVariantIds: new Set() });
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_WIDE_FAST_SHORT"));
  });

  it("a non-empty manualEnabledVariantIds bypasses the hardcoded preference — the higher-scored allocated lane wins", () => {
    const result = shortCandidate({ manualEnabledVariantIds: new Set(["CG_MFE_GIVEBACK"]) });
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_MFE_GIVEBACK"));
  });

  it("bypass still applies even when manualEnabledVariantIds names a THIRD lane not in this candidate's own evaluated set — any active allocation is a global signal, not per-lane", () => {
    const result = shortCandidate({ manualEnabledVariantIds: new Set(["CG_WIDE_LONG_RUNNER"]) });
    // Falls through to score-best among what WAS evaluated (CG_MFE_GIVEBACK, higher netAvgR).
    expect(result.selected?.lane.selectedLaneId).toBe(laneSelectorV2LaneId("CG_MFE_GIVEBACK"));
  });
});

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
        symbol: "BTCUSDT", // placeholder — bySymbol/byAxisSymbol unset in this fixture, so symbol has zero scoring effect here
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

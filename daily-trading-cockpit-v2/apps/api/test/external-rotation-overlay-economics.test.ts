import { describe, it, expect } from "vitest";
import {
  buildExternalRotationOverlayEconomicsReport,
  buildGlobalInterpretability,
  classifyExternalOverlayEconomicsCredibility,
  type ExternalRotationOverlayEconomicsReport,
} from "../src/lib/external-rotation-overlay-economics.js";
import type { ExternalRotationOverlayObservation } from "../src/lib/external-rotation-overlay.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function makeObs(overrides: Partial<ExternalRotationOverlayObservation> = {}): ExternalRotationOverlayObservation {
  const id = `obs-${++_idCounter}`;
  return {
    observationId: id,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    symbol: "ATOMUSDT",
    overlayGroups: ["STRATEGY_FIT_SHORTLIST"],
    evidenceEra: "POST_CALIBRATION",
    selectionBatchId: "batch-1",
    sourceDiscoveryScore: 75,
    sourceStrategyFitScore: 80,
    sourceStrategyFitTier: "HIGH_FIT",
    discoveryRank: 1,
    strategyFitRank: 1,
    lowFitRank: null,
    duplicateKey: id,
    detachedCandidateSnapshot: {
      direction: "LONG",
      hypotheticalEntryVariant: null,
      hypotheticalExitVariant: null,
      hypotheticalExpectedNetR: null,
      setupPlaybookLabel: null,
      stopDistanceBps: 80,
      riskReward: 2.0,
      marketRegime: null,
      plannedEntryPrice: 10.0,
      selectedEntryAnchorPrice: 10.0,
      entryBasis: "VARIANT_ANCHOR",
      entryZone: null,
      stopPrice: 9.92,
      tp1Price: 10.16,
      tp2Price: null,
      tp3Price: null,
      costR: 1.5,
      notes: [],
    },
    observationStatus: "RESOLVED",
    outcome: {
      realizedGrossR: -0.05,
      realizedNetR: -1.55,
      winnerLabel: "LOSS",
      tp1Hit: false,
      tp2Hit: false,
      slHit: true,
      closeReason: "SL",
      openedAt: "2026-05-15T00:00:00.000Z",
      closedAt: "2026-05-15T01:00:00.000Z",
      durationMinutes: 60,
      fillStatus: "FILLED",
    },
    diagnostics: {
      createdByPolicyVersion: "external-rotation-overlay-anchor-consistent-v2",
      reasonCodes: [],
      resolutionSemantics: "candle-based",
    },
    ...overrides,
  };
}

function makeFilledObs(opts: {
  symbol?: string;
  groups?: ExternalRotationOverlayObservation["overlayGroups"];
  stopDistanceBps?: number | null;
  riskReward?: number | null;
  costR?: number | null;
  grossR: number;
  netR: number;
  durationMinutes?: number | null;
}): ExternalRotationOverlayObservation {
  return makeObs({
    symbol: opts.symbol ?? "ATOMUSDT",
    overlayGroups: opts.groups ?? ["STRATEGY_FIT_SHORTLIST"],
    detachedCandidateSnapshot: {
      direction: "LONG",
      hypotheticalEntryVariant: null,
      hypotheticalExitVariant: null,
      hypotheticalExpectedNetR: null,
      setupPlaybookLabel: null,
      stopDistanceBps: opts.stopDistanceBps !== undefined ? opts.stopDistanceBps : 80,
      riskReward: opts.riskReward !== undefined ? opts.riskReward : 2.0,
      marketRegime: null,
      plannedEntryPrice: 10.0,
      selectedEntryAnchorPrice: 10.0,
      entryBasis: "VARIANT_ANCHOR",
      entryZone: null,
      stopPrice: 9.92,
      tp1Price: 10.16,
      tp2Price: null,
      tp3Price: null,
      costR: opts.costR !== undefined ? opts.costR : opts.grossR - opts.netR,
      notes: [],
    },
    observationStatus: "RESOLVED",
    outcome: {
      realizedGrossR: opts.grossR,
      realizedNetR: opts.netR,
      winnerLabel: opts.netR > 0 ? "WIN" : "LOSS",
      tp1Hit: false,
      tp2Hit: false,
      slHit: opts.netR < 0,
      closeReason: "SL",
      openedAt: "2026-05-15T00:00:00.000Z",
      closedAt: "2026-05-15T01:00:00.000Z",
      durationMinutes: opts.durationMinutes ?? 60,
      fillStatus: "FILLED",
    },
  });
}

function makeNoFillObs(groups: ExternalRotationOverlayObservation["overlayGroups"] = ["STRATEGY_FIT_SHORTLIST"]): ExternalRotationOverlayObservation {
  return makeObs({
    overlayGroups: groups,
    observationStatus: "NO_FILL",
    outcome: {
      realizedGrossR: null,
      realizedNetR: null,
      winnerLabel: null,
      tp1Hit: false,
      tp2Hit: false,
      slHit: false,
      closeReason: "NO_FILL",
      openedAt: null,
      closedAt: null,
      durationMinutes: null,
      fillStatus: "NO_FILL",
    },
  });
}

// ─── Empty / safe report ──────────────────────────────────────────────────────

describe("empty input", () => {
  it("returns a valid report with no crash on empty observations", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect(report.totalObservations).toBe(0);
    expect(report.resolvedObservations).toBe(0);
    expect(report.costComponentsAvailable).toBe(false);
    expect(report.groups).toHaveLength(3);
    expect(report.hypotheses.length).toBeGreaterThan(0);
  });

  it("diagnosis is TOO_EARLY when no resolved observations", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect(report.economicsDiagnosis.primaryDiagnosis).toBe("TOO_EARLY");
  });

  it("all group verdicts are INSUFFICIENT_EVIDENCE when empty", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect(report.groups.every((g) => g.economicsVerdict === "INSUFFICIENT_EVIDENCE")).toBe(true);
  });

  it("readyForResolverBehaviorDiscussion is always false", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect(report.readiness.readyForResolverBehaviorDiscussion).toBe(false);
  });

  it("readyForUniverseRotationInterpretation is always false", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect(report.readiness.readyForUniverseRotationInterpretation).toBe(false);
  });

  it("all hypotheses carry doesNotImplementNow=true", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect(report.hypotheses.every((h) => h.doesNotImplementNow === true)).toBe(true);
  });
});

// ─── Group economics — basic computations ────────────────────────────────────

describe("group economics computations", () => {
  it("computes grossAvgR and netAvgR from resolved FILLED observations", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 220, grossR: 0.1, netR: 0.0, costR: 0.1 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 240, grossR: -0.2, netR: -0.3, costR: 0.1 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.grossAvgR).toBeCloseTo(-0.05, 3);
    expect(sf.netAvgR).toBeCloseTo(-0.15, 3);
  });

  it("computes avgCostDragR as grossAvgR minus netAvgR", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 220, grossR: 0.0, netR: -0.2, costR: 0.2 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 260, grossR: 0.05, netR: -0.1, costR: 0.15 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    // grossAvgR = 0.025, netAvgR = -0.15, drag = 0.175
    expect(sf.avgCostDragR).toBeCloseTo(0.175, 3);
  });

  it("NO_FILL observations do not count toward resolved economics", () => {
    const obs = [
      makeNoFillObs(["STRATEGY_FIT_SHORTLIST"]),
      makeNoFillObs(["STRATEGY_FIT_SHORTLIST"]),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], grossR: 0.0, netR: -3.0 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.observationCount).toBe(3);
    expect(sf.resolvedCount).toBe(0); // distorted, excluded from headline
    expect(sf.forensicResolvedSampleSize).toBe(1); // still present for audit
  });

  it("avgCostR from snapshots matches implied cost drag (by linearity)", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 220, grossR: 0.0, netR: -0.4, costR: 0.4 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 260, grossR: 0.0, netR: -0.5, costR: 0.5 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.avgCostR).toBeCloseTo(0.45, 3);
    expect(sf.avgCostDragR).toBeCloseTo(0.45, 3);
  });

  it("excludes distorted resolved observations from headline economics but preserves forensic counts", () => {
    const obs = [
      makeFilledObs({ symbol: "RLUSDUSDT", groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 2, grossR: 0.5, netR: -14.01, costR: 14.51 }),
      makeFilledObs({ symbol: "GOOD1USDT", groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 220, grossR: 0.3, netR: 0.2, costR: 0.1 }),
      makeFilledObs({ symbol: "GOOD2USDT", groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 240, grossR: -0.1, netR: -0.2, costR: 0.1 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.headlineInterpretiveSampleSize).toBe(2);
    expect(sf.forensicResolvedSampleSize).toBe(3);
    expect(sf.distortedExcludedFromHeadline).toBe(1);
    expect(sf.grossAvgR).toBeCloseTo(0.1, 4);
    expect(sf.netAvgR).toBeCloseTo(0.0, 4);
  });

  it("headline sample improves materially after excluding distorted strategy-fit observations", () => {
    const obs = [
      makeFilledObs({ symbol: "RLUSDUSDT", groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 2, grossR: 0.5, netR: -14.01, costR: 14.51 }),
      ...Array.from({ length: 4 }, (_, index) =>
        makeFilledObs({
          symbol: `FIT${index}USDT`,
          groups: ["STRATEGY_FIT_SHORTLIST"],
          stopDistanceBps: 220,
          grossR: index % 2 === 0 ? 0.12 : -0.04,
          netR: index % 2 === 0 ? 0.05 : -0.09,
          costR: 0.07,
        }),
      ),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.forensicResolvedSampleSize).toBe(5);
    expect(sf.headlineInterpretiveSampleSize).toBe(4);
    expect(sf.netAvgR).toBeGreaterThan(-0.2);
    expect(report.forensicDistortedSampleSize).toBe(1);
  });

  it("leaves undistorted metadata baseline behavior unchanged", () => {
    const obs = [
      makeFilledObs({ groups: ["METADATA_DISCOVERY_BASELINE"], stopDistanceBps: 220, grossR: 0.4, netR: 0.3, costR: 0.1 }),
      makeFilledObs({ groups: ["METADATA_DISCOVERY_BASELINE"], stopDistanceBps: 220, grossR: -0.2, netR: -0.3, costR: 0.1 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const mb = report.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!;
    expect(mb.distortedExcludedFromHeadline).toBe(0);
    expect(mb.headlineInterpretiveSampleSize).toBe(2);
    expect(mb.netAvgR).toBeCloseTo(0.0, 4);
  });
});

// ─── Cost-dominated case ──────────────────────────────────────────────────────

describe("cost-dominated verdict", () => {
  function makeCostDominatedObs(count: number): ExternalRotationOverlayObservation[] {
    // gross near flat (~0), net deeply negative — classic cost geometry collapse
    return Array.from({ length: count }, (_, i) =>
      makeFilledObs({
        symbol: `SYM${i}USDT`,
        groups: ["STRATEGY_FIT_SHORTLIST"],
        stopDistanceBps: 60,
        grossR: -0.05 + (i % 3) * 0.03,
        netR: -4.5 - i * 0.2,
        costR: 4.45 + i * 0.2,
      }),
    );
  }

  it("keeps distorted-only groups out of headline economics even when forensic tape is cost-dominated", () => {
    const obs = makeCostDominatedObs(4);
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.economicsVerdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(sf.headlineInterpretiveSampleSize).toBe(0);
    expect(sf.forensicResolvedSampleSize).toBe(4);
    expect(sf.distortedExcludedFromHeadline).toBe(4);
  });

  it("routes distorted-only tape into interpretability audit instead of headline diagnosis", () => {
    const obs = makeCostDominatedObs(5);
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.economicsDiagnosis.primaryDiagnosis).toBe("TOO_EARLY");
    expect(report.externalOverlayInterpretability.netRotationComparisonStatus).toBe("NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION");
  });

  it("includes economics credibility audit hypothesis when distorted tape dominates", () => {
    const obs = makeCostDominatedObs(5);
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(
      report.hypotheses.some((h) => h.likelyFutureAction === "AUDIT_EXTERNAL_OVERLAY_ECONOMICS_CREDIBILITY"),
    ).toBe(true);
  });

  it("includes wait-for-interpretable-samples hypothesis when distorted tape dominates", () => {
    const obs = makeCostDominatedObs(5);
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(
      report.hypotheses.some((h) => h.likelyFutureAction === "WAIT_FOR_INTERPRETABLE_SAMPLES"),
    ).toBe(true);
  });

  it("pctGrossNearFlatButNetDeeplyNegative is high when signature matches", () => {
    const obs = Array.from({ length: 4 }, (_, i) =>
      makeFilledObs({
        symbol: `S${i}USDT`,
        groups: ["STRATEGY_FIT_SHORTLIST"],
        grossR: -0.1,   // near flat
        netR: -4.5,     // deeply negative
      }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.pctGrossNearFlatButNetDeeplyNegative).not.toBeNull();
    expect(sf.pctGrossNearFlatButNetDeeplyNegative!).toBeGreaterThan(0);
  });
});

// ─── Directionally weak case ──────────────────────────────────────────────────

describe("directionally weak verdict", () => {
  function makeDirectionallyWeakObs(count: number): ExternalRotationOverlayObservation[] {
    // gross clearly negative, small cost drag
    return Array.from({ length: count }, (_, i) =>
      makeFilledObs({
        symbol: `DIR${i}USDT`,
        groups: ["STRATEGY_FIT_SHORTLIST"],
        stopDistanceBps: 300,    // wide stop → cost drag is small in R
        grossR: -1.5 - i * 0.1, // clearly directionally negative
        netR: -1.6 - i * 0.1,   // tiny additional cost drag
        costR: 0.1,
      }),
    );
  }

  it("returns GROSS_EDGE_ABSENT when gross clearly negative and cost drag small", () => {
    const obs = makeDirectionallyWeakObs(4);
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.economicsVerdict).toBe("GROSS_EDGE_ABSENT");
  });

  it("returns DIRECTIONALLY_WEAK_EXTERNAL_OVERLAY global diagnosis", () => {
    const obs = makeDirectionallyWeakObs(5);
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.economicsDiagnosis.primaryDiagnosis).toBe("DIRECTIONALLY_WEAK_EXTERNAL_OVERLAY");
  });

  it("does NOT return COST_TO_RISK_GEOMETRY_BROKEN when gross is clearly negative", () => {
    const obs = makeDirectionallyWeakObs(4);
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.economicsVerdict).not.toBe("COST_TO_RISK_GEOMETRY_BROKEN");
  });

  it("includes AUDIT_RESOLVER_PLAN_ASSUMPTIONS hypothesis when directionally weak", () => {
    const obs = makeDirectionallyWeakObs(5);
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(
      report.hypotheses.some((h) => h.likelyFutureAction === "AUDIT_RESOLVER_PLAN_ASSUMPTIONS"),
    ).toBe(true);
  });
});

// ─── Both bad case ────────────────────────────────────────────────────────────

describe("both gross and cost bad", () => {
  it("treats borderline high-cost tape as excluded from headline even when both gross and cost are bad", () => {
    const obs = Array.from({ length: 4 }, (_, i) =>
      makeFilledObs({
        symbol: `BOTH${i}USDT`,
        groups: ["STRATEGY_FIT_SHORTLIST"],
        stopDistanceBps: 250,
        grossR: -1.0,
        netR: -2.5,
        costR: 1.5,
      }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.economicsVerdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(sf.borderlineExcludedFromHeadline).toBe(4);
    expect(report.externalOverlayInterpretability.netRotationComparisonStatus).toBe("TOO_EARLY");
  });
});

// ─── Geometry stats ───────────────────────────────────────────────────────────

describe("geometry statistics", () => {
  it("pctUltraTightStopLt100Bps reflects proportion with stop < 100bps", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 50, grossR: 0.0, netR: -4.0 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 80, grossR: 0.0, netR: -4.0 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 200, grossR: 0.0, netR: -0.5 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 250, grossR: 0.0, netR: -0.5 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.pctUltraTightStopLt100Bps).toBeCloseTo(0.5, 2); // 2 out of 4
  });

  it("pctTightStopLt175Bps includes stops 100-174 bps as well", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 50, grossR: 0.0, netR: -4.0 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 120, grossR: 0.0, netR: -2.0 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 200, grossR: 0.0, netR: -0.5 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 300, grossR: 0.0, netR: -0.3 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.pctTightStopLt175Bps).toBeCloseTo(0.5, 2); // 2 out of 4 (50 and 120)
    expect(sf.pctTightStopLt175Bps!).toBeGreaterThanOrEqual(sf.pctUltraTightStopLt100Bps!);
  });

  it("pctNetLossMoreThan2R and pctNetLossMoreThan4R computed correctly", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], grossR: 0.0, netR: -1.0 }),  // <= -2? no
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], grossR: 0.0, netR: -3.0 }),  // <= -2: yes; <= -4: no
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], grossR: 0.0, netR: -5.0 }),  // both yes
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], grossR: 1.0, netR: 0.5 }),   // positive
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.pctNetLossMoreThan2R).toBeCloseTo(0.5, 2);  // 2/4
    expect(sf.pctNetLossMoreThan4R).toBeCloseTo(0.25, 2); // 1/4
  });

  it("medianStopDistanceBps is computed correctly", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 50, grossR: 0.0, netR: -4.0 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 100, grossR: 0.0, netR: -3.0 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 200, grossR: 0.0, netR: -0.5 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.medianStopDistanceBps).toBe(100);
  });

  it("stop distance null when no stop data available", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: null, grossR: 0.0, netR: -3.0 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: null, grossR: 0.0, netR: -4.0 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: null, grossR: 0.0, netR: -4.5 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.avgStopDistanceBps).toBeNull();
    expect(sf.pctUltraTightStopLt100Bps).toBe(0);
  });
});

// ─── Cost decomposition honesty ───────────────────────────────────────────────

describe("cost decomposition", () => {
  it("costComponentsAvailable is always false", () => {
    const report = buildExternalRotationOverlayEconomicsReport([makeFilledObs({ grossR: 0.0, netR: -3.0 })]);
    expect(report.costComponentsAvailable).toBe(false);
  });

  it("costDecompositionNote explicitly states aggregate-only limitation", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect(report.costDecompositionNote).toContain("aggregate gross-to-net drag");
  });

  it("group costDecompositionNote repeats the same limitation", () => {
    const report = buildExternalRotationOverlayEconomicsReport([makeFilledObs({ grossR: 0.0, netR: -3.0 })]);
    for (const g of report.groups) {
      expect(g.costDecompositionNote).toContain("aggregate gross-to-net drag");
    }
  });
});

// ─── Hypotheses ───────────────────────────────────────────────────────────────

describe("hypotheses", () => {
  it("all hypotheses carry doesNotImplementNow=true", () => {
    const obs = Array.from({ length: 5 }, () =>
      makeFilledObs({ grossR: 0.0, netR: -4.5, stopDistanceBps: 60 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.hypotheses.every((h) => h.doesNotImplementNow === true)).toBe(true);
  });

  it("emits WAIT_FOR_MORE_OVERLAY_DATA when resolved < 5", () => {
    const obs = [makeFilledObs({ grossR: 0.0, netR: -4.5 })];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.hypotheses.some((h) => h.likelyFutureAction === "WAIT_FOR_MORE_OVERLAY_DATA")).toBe(true);
  });

  it("hypothesis patchStatus is restricted to WATCH or AUDIT_DEEPER", () => {
    const obs = Array.from({ length: 5 }, () =>
      makeFilledObs({ grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(
      report.hypotheses.every((h) => h.patchStatus === "WATCH" || h.patchStatus === "AUDIT_DEEPER"),
    ).toBe(true);
  });
});

// ─── Era filtering ────────────────────────────────────────────────────────────

describe("era filtering", () => {
  it("POST_CALIBRATION filters out ALL_TIME observations", () => {
    const postCalibObs = makeFilledObs({ grossR: 0.0, netR: -3.0 });
    const allTimeObs = makeObs({
      evidenceEra: "ALL_TIME" as "POST_CALIBRATION",
      overlayGroups: ["STRATEGY_FIT_SHORTLIST"],
      observationStatus: "RESOLVED",
      outcome: {
        realizedGrossR: 0.0,
        realizedNetR: -3.0,
        winnerLabel: "LOSS",
        tp1Hit: false,
        tp2Hit: false,
        slHit: true,
        closeReason: "SL",
        openedAt: null,
        closedAt: null,
        durationMinutes: null,
        fillStatus: "FILLED",
      },
    });
    const report = buildExternalRotationOverlayEconomicsReport(
      [postCalibObs, allTimeObs],
      { evidenceEra: "POST_CALIBRATION" },
    );
    expect(report.totalObservations).toBe(1);
  });

  it("ALL_TIME includes all observations regardless of evidenceEra", () => {
    const postCalibObs = makeFilledObs({ grossR: 0.0, netR: -3.0 });
    const report = buildExternalRotationOverlayEconomicsReport(
      [postCalibObs],
      { evidenceEra: "ALL_TIME" },
    );
    expect(report.totalObservations).toBe(1);
  });
});

// ─── Multi-group handling ─────────────────────────────────────────────────────

describe("multi-group observations", () => {
  it("observations in multiple groups count in each group independently", () => {
    const multiGroup = makeFilledObs({
      groups: ["STRATEGY_FIT_SHORTLIST", "METADATA_DISCOVERY_BASELINE"],
      grossR: 0.0,
      netR: -3.0,
    });
    const sfOnly = makeFilledObs({
      groups: ["STRATEGY_FIT_SHORTLIST"],
      grossR: 0.0,
      netR: -4.0,
    });
    const report = buildExternalRotationOverlayEconomicsReport([multiGroup, sfOnly, multiGroup, sfOnly]);
    const sf = report.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    const mb = report.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!;
    expect(sf.observationCount).toBe(4); // all 4 have SF
    expect(mb.observationCount).toBe(2); // only multiGroup (x2)
  });

  it("LOW_FIT_CONTROL group returns INSUFFICIENT_EVIDENCE when no observations in that group", () => {
    const obs = makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], grossR: 0.0, netR: -3.0 });
    const report = buildExternalRotationOverlayEconomicsReport([obs]);
    const lf = report.groups.find((g) => g.group === "LOW_FIT_CONTROL")!;
    expect(lf.economicsVerdict).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// ─── No behavior change verification ─────────────────────────────────────────

describe("no behavior change invariants", () => {
  it("report has no fields that could influence live trading", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect("readyForResolverBehaviorDiscussion" in report.readiness).toBe(true);
    expect(report.readiness.readyForResolverBehaviorDiscussion).toBe(false);
    expect(report.readiness.readyForUniverseRotationInterpretation).toBe(false);
  });

  it("generatedAt uses provided now parameter", () => {
    const now = new Date("2026-05-15T10:00:00.000Z");
    const report = buildExternalRotationOverlayEconomicsReport([], {}, now);
    expect(report.generatedAt).toBe("2026-05-15T10:00:00.000Z");
  });
});

// ─── classifyExternalOverlayEconomicsCredibility ──────────────────────────────

describe("classifyExternalOverlayEconomicsCredibility", () => {
  it("returns INSUFFICIENT_DATA for NO_FILL observation", () => {
    const obs = makeNoFillObs();
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("INSUFFICIENT_DATA");
    expect(result.stopGeometryBucket).toBe("UNKNOWN");
    expect(result.netEconomicsInterpretation).toBe("NOT_APPLICABLE");
    expect(result.directionalInterpretation).toBe("NOT_APPLICABLE");
    expect(result.distortionFlags).toHaveLength(0);
  });

  it("returns ECONOMICALLY_DISTORTED when stop < 100bps", () => {
    const obs = makeFilledObs({ stopDistanceBps: 60, grossR: 0.5, netR: 0.4, costR: 0.1 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("ECONOMICALLY_DISTORTED");
    expect(result.stopGeometryBucket).toBe("ULTRA_TIGHT_LT100_BPS");
    expect(result.distortionFlags.some((f) => f.includes("ultra-tight"))).toBe(true);
    expect(result.netEconomicsInterpretation).toBe("NET_DISTORTED_BY_COST");
  });

  it("returns ECONOMICALLY_DISTORTED when costDrag >= 2.0R on normal stop", () => {
    const obs = makeFilledObs({ stopDistanceBps: 300, grossR: 0.0, netR: -3.0, costR: 3.0 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("ECONOMICALLY_DISTORTED");
    expect(result.distortionFlags.some((f) => f.includes("cost drag"))).toBe(true);
  });

  it("returns ECONOMICALLY_DISTORTED when |gross|<=0.25 and net<=-2 on normal stop with cost drag < 2R", () => {
    // stopDistanceBps=200 (normal), |gross|=0.2 <= 0.25, net=-2.1, costDrag=1.9 < 2.0
    const obs = makeFilledObs({ stopDistanceBps: 200, grossR: -0.2, netR: -2.1, costR: 1.9 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("ECONOMICALLY_DISTORTED");
    expect(result.distortionFlags.some((f) => f.includes("gross near flat"))).toBe(true);
  });

  it("GROSS_READABLE when distorted by high cost drag but stop is not ultra-tight", () => {
    const obs = makeFilledObs({ stopDistanceBps: 250, grossR: 0.0, netR: -3.0, costR: 3.0 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("ECONOMICALLY_DISTORTED");
    expect(result.directionalInterpretation).toBe("GROSS_READABLE");
  });

  it("GROSS_BORDERLINE when distorted by ultra-tight stop", () => {
    const obs = makeFilledObs({ stopDistanceBps: 60, grossR: 0.5, netR: 0.4, costR: 0.1 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.directionalInterpretation).toBe("GROSS_BORDERLINE");
  });

  it("returns BORDERLINE when stop is 100-174bps and no other distortion", () => {
    const obs = makeFilledObs({ stopDistanceBps: 130, grossR: 0.5, netR: 0.45, costR: 0.05 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("BORDERLINE");
    expect(result.stopGeometryBucket).toBe("TIGHT_LT175_BPS");
    expect(result.netEconomicsInterpretation).toBe("NET_BORDERLINE");
    expect(result.directionalInterpretation).toBe("GROSS_BORDERLINE");
  });

  it("returns BORDERLINE when cost drag is 1.0-1.99R on normal stop", () => {
    const obs = makeFilledObs({ stopDistanceBps: 250, grossR: 0.5, netR: -0.7, costR: 1.2 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("BORDERLINE");
  });

  it("returns ECONOMICALLY_INTERPRETABLE for clean observation", () => {
    const obs = makeFilledObs({ stopDistanceBps: 250, grossR: 0.8, netR: 0.72, costR: 0.08 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("ECONOMICALLY_INTERPRETABLE");
    expect(result.stopGeometryBucket).toBe("NORMAL_GTE175_BPS");
    expect(result.netEconomicsInterpretation).toBe("NET_READABLE");
    expect(result.directionalInterpretation).toBe("GROSS_READABLE");
    expect(result.distortionFlags).toHaveLength(0);
  });

  it("stop bucket UNKNOWN when stopDistanceBps is null (no ultra-tight distortion flag)", () => {
    const obs = makeFilledObs({ stopDistanceBps: null, grossR: 0.5, netR: 0.45, costR: 0.05 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.stopGeometryBucket).toBe("UNKNOWN");
    expect(result.distortionFlags.some((f) => f.includes("ultra-tight"))).toBe(false);
  });

  it("multiple distortion flags emitted when multiple conditions apply", () => {
    // stop < 100 AND costDrag >= 2R
    const obs = makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -3.0, costR: 3.0 });
    const result = classifyExternalOverlayEconomicsCredibility(obs);
    expect(result.credibilityStatus).toBe("ECONOMICALLY_DISTORTED");
    expect(result.distortionFlags.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Group credibility summaries ──────────────────────────────────────────────

describe("group credibility summaries in report", () => {
  it("report always has 3 credibilityGroups", () => {
    const report = buildExternalRotationOverlayEconomicsReport([]);
    expect(report.credibilityGroups).toHaveLength(3);
    const groups = report.credibilityGroups.map((g) => g.group);
    expect(groups).toContain("STRATEGY_FIT_SHORTLIST");
    expect(groups).toContain("METADATA_DISCOVERY_BASELINE");
    expect(groups).toContain("LOW_FIT_CONTROL");
  });

  it("INSUFFICIENT_DATA verdict for group with < 3 resolved", () => {
    const obs = [makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], grossR: 0.0, netR: -3.0 })];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.credibilityVerdict).toBe("INSUFFICIENT_DATA");
  });

  it("MAJORITY_DISTORTED when >= 70% are distorted", () => {
    const obs = Array.from({ length: 4 }, () =>
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.credibilityVerdict).toBe("MAJORITY_DISTORTED");
    expect(sf.distortedCount).toBe(4);
    expect(sf.pctDistorted).toBeCloseTo(1.0, 2);
  });

  it("ALL_INTERPRETABLE when >= 70% are interpretable", () => {
    const obs = Array.from({ length: 4 }, () =>
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 300, grossR: 0.5, netR: 0.48, costR: 0.02 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.credibilityVerdict).toBe("ALL_INTERPRETABLE");
    expect(sf.interpretableCount).toBe(4);
    expect(sf.pctInterpretable).toBeCloseTo(1.0, 2);
  });

  it("dominantDistortionFlag is ULTRA_TIGHT_STOP when ultra-tight stops dominate", () => {
    const obs = Array.from({ length: 4 }, () =>
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.dominantDistortionFlag).toBe("ULTRA_TIGHT_STOP");
  });

  it("dominantDistortionFlag is null when no distorted observations", () => {
    const obs = Array.from({ length: 4 }, () =>
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 300, grossR: 0.5, netR: 0.45, costR: 0.05 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.dominantDistortionFlag).toBeNull();
  });

  it("avgStopDistanceBpsAmongDistorted is computed only from distorted observations", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 80, grossR: 0.0, netR: -4.5 }),
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 300, grossR: 0.5, netR: 0.45, costR: 0.05 }),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    // avg of 60 and 80 = 70
    expect(sf.avgStopDistanceBpsAmongDistorted).toBeCloseTo(70, 0);
  });

  it("insufficientDataCount counts NO_FILL observations", () => {
    const obs = [
      makeFilledObs({ groups: ["STRATEGY_FIT_SHORTLIST"], stopDistanceBps: 300, grossR: 0.5, netR: 0.45 }),
      makeNoFillObs(["STRATEGY_FIT_SHORTLIST"]),
      makeNoFillObs(["STRATEGY_FIT_SHORTLIST"]),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const sf = report.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(sf.insufficientDataCount).toBe(2);
  });
});

// ─── Global interpretability ──────────────────────────────────────────────────

describe("global interpretability in report", () => {
  it("TOO_EARLY when fewer than 5 resolved observations", () => {
    const obs = Array.from({ length: 3 }, () =>
      makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.externalOverlayInterpretability.netRotationComparisonStatus).toBe("TOO_EARLY");
    expect(report.externalOverlayInterpretability.grossDirectionalComparisonStatus).toBe("TOO_EARLY");
  });

  it("NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION when >= 50% resolved are distorted", () => {
    const obs = Array.from({ length: 6 }, () =>
      makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.externalOverlayInterpretability.netRotationComparisonStatus).toBe("NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION");
    expect(report.externalOverlayInterpretability.grossDirectionalComparisonStatus).toBe("GROSS_ONLY_MAY_BE_READ_WITH_CAUTION");
  });

  it("NET_INTERPRETABLE when < 50% are distorted or borderline", () => {
    const obs = Array.from({ length: 6 }, () =>
      makeFilledObs({ stopDistanceBps: 300, grossR: 0.5, netR: 0.48, costR: 0.02 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.externalOverlayInterpretability.netRotationComparisonStatus).toBe("NET_INTERPRETABLE");
    expect(report.externalOverlayInterpretability.grossDirectionalComparisonStatus).toBe("GROSS_LARGELY_UNCONTAMINATED");
  });

  it("warningMessage is non-null when NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION", () => {
    const obs = Array.from({ length: 6 }, () =>
      makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.externalOverlayInterpretability.warningMessage).not.toBeNull();
    expect(report.externalOverlayInterpretability.warningMessage).toContain("cost-distorted");
  });

  it("warningMessage is null when NET_INTERPRETABLE", () => {
    const obs = Array.from({ length: 6 }, () =>
      makeFilledObs({ stopDistanceBps: 300, grossR: 0.5, netR: 0.48, costR: 0.02 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.externalOverlayInterpretability.warningMessage).toBeNull();
  });

  it("counts sum to totalClassified", () => {
    const obs = [
      makeFilledObs({ stopDistanceBps: 300, grossR: 0.5, netR: 0.45 }),
      makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
      makeFilledObs({ stopDistanceBps: 130, grossR: 0.5, netR: 0.4, costR: 0.1 }),
      makeNoFillObs(),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const interp = report.externalOverlayInterpretability;
    expect(
      interp.interpretableCount + interp.distortedCount + interp.borderlineCount + interp.insufficientDataCount,
    ).toBe(interp.totalClassified);
  });

  it("buildGlobalInterpretability standalone function gives same result as report field", () => {
    const obs = Array.from({ length: 6 }, () =>
      makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const standalone = buildGlobalInterpretability(obs);
    expect(standalone.netRotationComparisonStatus).toBe(report.externalOverlayInterpretability.netRotationComparisonStatus);
    expect(standalone.distortedCount).toBe(report.externalOverlayInterpretability.distortedCount);
  });

  it("includes AUDIT_EXTERNAL_OVERLAY_ECONOMICS_CREDIBILITY hypothesis when NOT_INTERPRETABLE", () => {
    const obs = Array.from({ length: 6 }, () =>
      makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(
      report.hypotheses.some((h) => h.likelyFutureAction === "AUDIT_EXTERNAL_OVERLAY_ECONOMICS_CREDIBILITY"),
    ).toBe(true);
  });

  it("includes WAIT_FOR_INTERPRETABLE_SAMPLES hypothesis when interpretable < 3", () => {
    const obs = Array.from({ length: 6 }, () =>
      makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(
      report.hypotheses.some((h) => h.likelyFutureAction === "WAIT_FOR_INTERPRETABLE_SAMPLES"),
    ).toBe(true);
  });

  it("does not emit future geometry-guard hypothesis when headline diagnosis is intentionally withheld", () => {
    const obs = Array.from({ length: 5 }, () =>
      makeFilledObs({ stopDistanceBps: 60, grossR: -0.02, netR: -4.5, costR: 4.48 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(
      report.hypotheses.some((h) => h.likelyFutureAction === "AUDIT_FUTURE_RESOLVER_GEOMETRY_GUARD"),
    ).toBe(false);
  });

  it("all credibility hypotheses carry doesNotImplementNow=true", () => {
    const obs = Array.from({ length: 6 }, () =>
      makeFilledObs({ stopDistanceBps: 60, grossR: 0.0, netR: -4.5 }),
    );
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.hypotheses.every((h) => h.doesNotImplementNow === true)).toBe(true);
  });

  it("BORDERLINE_INTERPRET_WITH_CAUTION when borderline+distorted pct >= 50% but distorted < 50%", () => {
    // 3 borderline (stop 130bps) + 3 interpretable out of 6 resolved = 50% borderline
    const obs = [
      ...Array.from({ length: 3 }, () =>
        makeFilledObs({ stopDistanceBps: 130, grossR: 0.5, netR: 0.45, costR: 0.05 }),
      ),
      ...Array.from({ length: 3 }, () =>
        makeFilledObs({ stopDistanceBps: 300, grossR: 0.5, netR: 0.48, costR: 0.02 }),
      ),
    ];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.externalOverlayInterpretability.netRotationComparisonStatus).toBe("BORDERLINE_INTERPRET_WITH_CAUTION");
    expect(report.externalOverlayInterpretability.grossDirectionalComparisonStatus).toBe("GROSS_ONLY_MAY_BE_READ_WITH_CAUTION");
    expect(report.externalOverlayInterpretability.warningMessage).not.toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  buildUniverseRotationIntelligenceReport,
} from "../src/lib/universe-rotation-intelligence.js";
import type { StrategyExperienceRecord } from "@dtc/shared";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeRecord(overrides: {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  netR?: number;
  slHit?: boolean;
  tp1Hit?: boolean;
  era?: string;
}): StrategyExperienceRecord {
  const netR = overrides.netR ?? 0.1;
  const symbol = overrides.symbol ?? "AAPL";
  const direction = overrides.direction ?? "LONG";
  return {
    context: {
      symbol,
      direction,
      evidenceEra: (overrides.era ?? "POST_CALIBRATION") as "POST_CALIBRATION" | "PRE_CALIBRATION",
      selectedEntryVariant: "entry_a",
      selectedExitVariant: "exit_x",
    },
    outcome: {
      symbol,
      direction,
      evidenceEra: (overrides.era ?? "POST_CALIBRATION") as "POST_CALIBRATION" | "PRE_CALIBRATION",
      winnerLabel: netR > 0 ? "WIN" : netR < 0 ? "LOSS" : "BREAKEVEN",
      realizedNetR: netR,
      realizedGrossR: netR > 0 ? netR + 0.05 : netR,
      slHit: overrides.slHit ?? (netR < 0),
      closeReason: netR < 0 ? "SL" : "TP1",
      tp1Hit: overrides.tp1Hit ?? (netR > 0),
      selectedEntryVariant: "entry_a",
      selectedExitVariant: "exit_x",
    },
  } as unknown as StrategyExperienceRecord;
}

function makeWinner(symbol = "AAPL", direction: "LONG" | "SHORT" = "LONG"): StrategyExperienceRecord {
  return makeRecord({ symbol, direction, netR: 0.3, tp1Hit: true });
}

function makeLoser(symbol = "AAPL", direction: "LONG" | "SHORT" = "LONG"): StrategyExperienceRecord {
  return makeRecord({ symbol, direction, netR: -0.4, slHit: true });
}

function makeN(n: number, netR: number, symbol = "AAPL", direction: "LONG" | "SHORT" = "LONG"): StrategyExperienceRecord[] {
  return Array.from({ length: n }, () => makeRecord({ symbol, direction, netR }));
}

// ─── Empty input ──────────────────────────────────────────────────────────────

describe("empty input", () => {
  it("returns a valid empty report with zero metadata", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.metadata.resolvedExperienceRecordCount).toBe(0);
    expect(report.metadata.symbolCount).toBe(0);
    expect(report.metadata.symbolsWithAtLeast5Closes).toBe(0);
    expect(report.symbolAssessments).toHaveLength(0);
    expect(report.symbolDirectionAssessments).toHaveLength(0);
    expect(report.coreObservationCandidates).toHaveLength(0);
    expect(report.rotationPressureCandidates).toHaveLength(0);
    expect(report.promisingFingerprints).toHaveLength(0);
    expect(report.toxicFingerprints).toHaveLength(0);
  });

  it("readiness has advisoryEngineReady=false on empty input", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.readiness.advisoryEngineReady).toBe(false);
  });

  it("readyForUniverseInfluence is always false on empty input", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.readiness.readyForUniverseInfluence).toBe(false);
  });

  it("readyForExternalCandidateSearch is always false on empty input", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.readiness.readyForExternalCandidateSearch).toBe(false);
  });

  it("universe contribution summary has zero totalClosedCount on empty input", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.universeContributionSummary.totalClosedCount).toBe(0);
    expect(report.universeContributionSummary.overallNetAvgR).toBeNull();
    expect(report.universeContributionSummary.topContributor).toBeNull();
    expect(report.universeContributionSummary.worstContributor).toBeNull();
  });

  it("fallback patch hypothesis is emitted when there are no concerns", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.patchHypotheses).toHaveLength(1);
    expect(report.patchHypotheses[0]!.likelyFutureAction).toBe("NO_ACTION_YET");
    expect(report.patchHypotheses[0]!.doesNotImplementNow).toBe(true);
  });

  it("generates exactly 5 answer cards", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.answerCards).toHaveLength(5);
  });
});

// ─── Era filtering ────────────────────────────────────────────────────────────

describe("era filtering", () => {
  it("POST_CALIBRATION excludes PRE_CALIBRATION records", () => {
    const records = [
      makeRecord({ symbol: "AAPL", netR: 0.2, era: "POST_CALIBRATION" }),
      makeRecord({ symbol: "AAPL", netR: 0.2, era: "PRE_CALIBRATION" }),
    ];
    const report = buildUniverseRotationIntelligenceReport(records, { evidenceEra: "POST_CALIBRATION" });
    expect(report.metadata.resolvedExperienceRecordCount).toBe(1);
  });

  it("ALL_TIME includes all records regardless of era", () => {
    const records = [
      makeRecord({ symbol: "AAPL", netR: 0.2, era: "POST_CALIBRATION" }),
      makeRecord({ symbol: "AAPL", netR: 0.2, era: "PRE_CALIBRATION" }),
    ];
    const report = buildUniverseRotationIntelligenceReport(records, { evidenceEra: "ALL_TIME" });
    expect(report.metadata.resolvedExperienceRecordCount).toBe(2);
  });

  it("defaults to POST_CALIBRATION era when not specified", () => {
    const records = [
      makeRecord({ symbol: "AAPL", netR: 0.2, era: "POST_CALIBRATION" }),
      makeRecord({ symbol: "TSLA", netR: 0.2, era: "PRE_CALIBRATION" }),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.evidenceEra).toBe("POST_CALIBRATION");
    expect(report.metadata.resolvedExperienceRecordCount).toBe(1);
  });
});

// ─── Sample tier and verdict ──────────────────────────────────────────────────

describe("sample tier and verdict", () => {
  it("single record (1) produces INSUFFICIENT_EVIDENCE", () => {
    const report = buildUniverseRotationIntelligenceReport([makeWinner("AAPL")]);
    const sym = report.symbolAssessments.find((s) => s.symbol === "AAPL")!;
    expect(sym.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(sym.sampleTier).toBe("TOO_EARLY");
  });

  it("4 records produce INSUFFICIENT_EVIDENCE (TOO_EARLY)", () => {
    const report = buildUniverseRotationIntelligenceReport(makeN(4, 0.3));
    const sym = report.symbolAssessments[0]!;
    expect(sym.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(sym.sampleTier).toBe("TOO_EARLY");
  });

  it("5 positive records produce EARLY_PROMISING", () => {
    const records = [
      ...makeN(3, 0.3, "AAPL"),
      ...makeN(2, 0.2, "AAPL"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.sampleTier).toBe("EARLY");
    expect(sym.verdict).toBe("EARLY_PROMISING");
  });

  it("5 negative records produce EARLY_DRAG", () => {
    const records = makeN(5, -0.4, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.sampleTier).toBe("EARLY");
    expect(sym.verdict).toBe("EARLY_DRAG");
  });

  it("15 positive records with good PF produce WATCHABLE_PROMISING", () => {
    const records = [
      ...makeN(12, 0.3, "AAPL"),
      ...makeN(3, -0.1, "AAPL"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.sampleTier).toBe("WATCHABLE");
    expect(sym.verdict).toBe("WATCHABLE_PROMISING");
  });

  it("15 negative records produce WATCHABLE_DRAG", () => {
    const records = makeN(15, -0.3, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.sampleTier).toBe("WATCHABLE");
    expect(sym.verdict).toBe("WATCHABLE_DRAG");
  });

  it("30+ consistently negative records produce TOXIC_PRESSURE", () => {
    const records = makeN(30, -0.3, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.sampleTier).toBe("EVALUABLE");
    expect(sym.verdict).toBe("TOXIC_PRESSURE");
  });

  it("30+ mixed records with netAvgR near 0 produce MIXED not TOXIC_PRESSURE", () => {
    const records = [
      ...makeN(15, 0.05, "AAPL"),
      ...makeN(15, -0.05, "AAPL"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.verdict).toBe("MIXED");
  });
});

// ─── Rotation pressure ────────────────────────────────────────────────────────

describe("rotation pressure", () => {
  it("positive symbol has LOW pressure level when EARLY tier", () => {
    const records = [
      ...makeN(3, 0.3, "AAPL"),
      ...makeN(2, 0.2, "AAPL"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.rotationPressureLevel).toBe("LOW");
  });

  it("negative symbol has MODERATE pressure when EARLY tier (never HIGH)", () => {
    const records = makeN(5, -0.4, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    // EARLY tier can only go up to MODERATE
    expect(sym.rotationPressureLevel).not.toBe("HIGH");
  });

  it("TOO_EARLY tier is always LOW regardless of performance", () => {
    const records = makeN(4, -0.5, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.rotationPressureLevel).toBe("LOW");
  });

  it("WATCHABLE tier with strongly negative performance yields HIGH pressure", () => {
    const records = makeN(15, -0.4, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.sampleTier).toBe("WATCHABLE");
    expect(sym.rotationPressureLevel).toBe("HIGH");
  });

  it("EVALUABLE tier with positive performance has LOW pressure", () => {
    const records = makeN(30, 0.3, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.rotationPressureLevel).toBe("LOW");
  });

  it("pressure score for positive symbol is below 50", () => {
    const records = makeN(30, 0.4, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.rotationPressureScore).toBeLessThan(50);
  });

  it("pressure score for negative symbol is above 50", () => {
    const records = makeN(15, -0.4, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments[0]!;
    expect(sym.rotationPressureScore).toBeGreaterThan(50);
  });
});

// ─── Symbol-direction assessments ────────────────────────────────────────────

describe("symbolDirectionAssessments", () => {
  it("groups records correctly by symbol+direction", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL", "LONG"),
      ...makeN(3, -0.2, "AAPL", "SHORT"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.symbolDirectionAssessments).toHaveLength(2);
    const longA = report.symbolDirectionAssessments.find((s) => s.symbol === "AAPL" && s.direction === "LONG")!;
    const shortA = report.symbolDirectionAssessments.find((s) => s.symbol === "AAPL" && s.direction === "SHORT")!;
    expect(longA).toBeDefined();
    expect(shortA).toBeDefined();
    expect(longA.closedCount).toBe(5);
    expect(shortA.closedCount).toBe(3);
  });

  it("symbol assessment includes both directions in directions array", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL", "LONG"),
      ...makeN(3, -0.2, "AAPL", "SHORT"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const sym = report.symbolAssessments.find((s) => s.symbol === "AAPL")!;
    expect(sym.directions).toContain("LONG");
    expect(sym.directions).toContain("SHORT");
  });

  it("direction verdict follows same ladder as symbol verdict", () => {
    const records = makeN(5, -0.4, "AAPL", "LONG");
    const report = buildUniverseRotationIntelligenceReport(records);
    const dirA = report.symbolDirectionAssessments.find((s) => s.symbol === "AAPL" && s.direction === "LONG")!;
    expect(dirA.verdict).toBe("EARLY_DRAG");
  });
});

// ─── Universe contribution summary ───────────────────────────────────────────

describe("universeContributionSummary", () => {
  it("counts positive and negative contributors correctly", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL"),
      ...makeN(5, -0.4, "TSLA"),
      ...makeN(5, 0.1, "NVDA"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const s = report.universeContributionSummary;
    expect(s.positiveContributorCount).toBe(2);
    expect(s.negativeContributorCount).toBe(1);
  });

  it("identifies top and worst contributors correctly", () => {
    const records = [
      ...makeN(5, 0.4, "AAPL"),
      ...makeN(5, -0.5, "TSLA"),
      ...makeN(5, 0.1, "NVDA"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const s = report.universeContributionSummary;
    expect(s.topContributor?.symbol).toBe("AAPL");
    expect(s.worstContributor?.symbol).toBe("TSLA");
  });

  it("computes overall netAvgR across all records", () => {
    const records = [
      ...makeN(5, 0.2, "AAPL"),
      ...makeN(5, -0.2, "TSLA"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    // 0.2 × 5 + (-0.2) × 5 = 0 → avgR ≈ 0
    expect(report.universeContributionSummary.overallNetAvgR).toBeCloseTo(0, 3);
  });

  it("excludes symbols with fewer than 5 closes from positive/negative counts", () => {
    const records = [
      ...makeN(4, -0.9, "TINY"),   // < 5, excluded
      ...makeN(5, 0.3, "AAPL"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const s = report.universeContributionSummary;
    expect(s.positiveContributorCount).toBe(1);
    expect(s.negativeContributorCount).toBe(0);
  });
});

// ─── Core observation and rotation pressure candidates ────────────────────────

describe("coreObservationCandidates and rotationPressureCandidates", () => {
  it("coreObservationCandidates contains only PROMISING verdict symbols", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL"),
      ...makeN(5, -0.4, "TSLA"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.coreObservationCandidates.every((s) =>
      s.verdict === "EARLY_PROMISING" || s.verdict === "WATCHABLE_PROMISING",
    )).toBe(true);
  });

  it("rotationPressureCandidates contains only DRAG/TOXIC verdict symbols", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL"),
      ...makeN(5, -0.4, "TSLA"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.rotationPressureCandidates.every((s) =>
      s.verdict === "EARLY_DRAG" || s.verdict === "WATCHABLE_DRAG" || s.verdict === "TOXIC_PRESSURE",
    )).toBe(true);
  });

  it("coreObservationCandidates is empty when no symbol is promising", () => {
    const records = makeN(5, -0.4, "TSLA");
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.coreObservationCandidates).toHaveLength(0);
  });

  it("rotationPressureCandidates is capped at 5", () => {
    const symbols = ["A", "B", "C", "D", "E", "F"];
    const records = symbols.flatMap((s) => makeN(5, -0.4, s));
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.rotationPressureCandidates.length).toBeLessThanOrEqual(5);
  });
});

// ─── Fingerprints ─────────────────────────────────────────────────────────────

describe("fingerprints", () => {
  it("promisingFingerprints are generated from symbol-direction combos with >= 5 closes and positive netAvgR", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL", "LONG"),
      ...makeN(3, 0.3, "TSLA", "LONG"),  // < 5 — excluded
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.promisingFingerprints).toHaveLength(1);
    expect(report.promisingFingerprints[0]!.exampleSymbol).toBe("AAPL");
    expect(report.promisingFingerprints[0]!.type).toBe("PROMISING");
  });

  it("toxicFingerprints are generated from symbol-direction combos with >= 5 closes and negative netAvgR", () => {
    const records = makeN(5, -0.4, "TSLA", "SHORT");
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.toxicFingerprints).toHaveLength(1);
    expect(report.toxicFingerprints[0]!.exampleSymbol).toBe("TSLA");
    expect(report.toxicFingerprints[0]!.type).toBe("TOXIC");
  });

  it("fingerprint confidence is LOW for non-EVALUABLE sample", () => {
    const records = makeN(5, 0.3, "AAPL", "LONG");
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.promisingFingerprints[0]!.confidence).toBe("LOW");
  });

  it("fingerprint confidence is MEDIUM for EVALUABLE (30+) sample", () => {
    const records = makeN(30, 0.3, "AAPL", "LONG");
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.promisingFingerprints[0]!.confidence).toBe("MEDIUM");
  });

  it("fingerprints are empty when no qualifying symbol-direction combos exist", () => {
    const records = makeN(3, 0.3, "AAPL");  // < 5 closes
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.promisingFingerprints).toHaveLength(0);
    expect(report.toxicFingerprints).toHaveLength(0);
  });

  it("promising fingerprints are capped at 3", () => {
    const symbols = ["A", "B", "C", "D"];
    const records = symbols.flatMap((s) => makeN(5, 0.3, s, "LONG"));
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.promisingFingerprints.length).toBeLessThanOrEqual(3);
  });
});

// ─── Patch hypotheses ─────────────────────────────────────────────────────────

describe("patchHypotheses", () => {
  it("all patch hypotheses have doesNotImplementNow=true", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL"),
      ...makeN(30, -0.4, "TSLA"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.patchHypotheses.every((h) => h.doesNotImplementNow === true)).toBe(true);
  });

  it("all patch hypothesis patchStatus values are WATCH or AUDIT_DEEPER", () => {
    const records = makeN(30, -0.4, "TSLA");
    const report = buildUniverseRotationIntelligenceReport(records);
    const validStatuses = ["WATCH", "AUDIT_DEEPER"];
    expect(report.patchHypotheses.every((h) => validStatuses.includes(h.patchStatus))).toBe(true);
  });

  it("emits AUDIT_TOXIC_SYMBOL_DEEPER for TOXIC_PRESSURE symbol", () => {
    const records = makeN(30, -0.4, "TSLA");
    const report = buildUniverseRotationIntelligenceReport(records);
    const h = report.patchHypotheses.find((h) => h.likelyFutureAction === "AUDIT_TOXIC_SYMBOL_DEEPER");
    expect(h).toBeDefined();
    expect(h!.patchStatus).toBe("AUDIT_DEEPER");
  });

  it("emits WATCH_PROMISING_SYMBOL_ACCUMULATE for promising symbol", () => {
    const records = makeN(5, 0.3, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    const h = report.patchHypotheses.find((h) => h.likelyFutureAction === "WATCH_PROMISING_SYMBOL_ACCUMULATE");
    expect(h).toBeDefined();
    expect(h!.doesNotImplementNow).toBe(true);
  });

  it("emits AUDIT_DIRECTION_SPECIFIC_DRAG for direction divergence", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL", "LONG"),
      ...makeN(5, -0.4, "AAPL", "SHORT"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const h = report.patchHypotheses.find((h) => h.likelyFutureAction === "AUDIT_DIRECTION_SPECIFIC_DRAG");
    expect(h).toBeDefined();
    expect(h!.patchStatus).toBe("WATCH");
  });

  it("fallback NO_ACTION_YET is emitted when no specific concern", () => {
    const records = makeN(3, 0.1, "AAPL");  // TOO_EARLY, no specific concern
    const report = buildUniverseRotationIntelligenceReport(records);
    const h = report.patchHypotheses.find((h) => h.likelyFutureAction === "NO_ACTION_YET");
    expect(h).toBeDefined();
    expect(h!.doesNotImplementNow).toBe(true);
  });
});

// ─── Readiness ────────────────────────────────────────────────────────────────

describe("readiness", () => {
  it("readyForUniverseInfluence is always false", () => {
    const records = makeN(100, 0.4, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.readiness.readyForUniverseInfluence).toBe(false);
  });

  it("readyForExternalCandidateSearch is always false", () => {
    const records = makeN(100, 0.4, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.readiness.readyForExternalCandidateSearch).toBe(false);
  });

  it("advisoryEngineReady=true when symbols exist", () => {
    const records = makeN(5, 0.3, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.readiness.advisoryEngineReady).toBe(true);
  });

  it("advisoryEngineReady=false when no symbols", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.readiness.advisoryEngineReady).toBe(false);
  });

  it("reasons includes a message about readyForUniverseInfluence always false", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    const reason = report.readiness.reasons.some((r) => r.includes("readyForUniverseInfluence"));
    expect(reason).toBe(true);
  });

  it("reasons includes a message about readyForExternalCandidateSearch always false", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    const reason = report.readiness.reasons.some((r) => r.includes("readyForExternalCandidateSearch"));
    expect(reason).toBe(true);
  });
});

// ─── Answer cards ─────────────────────────────────────────────────────────────

describe("answerCards", () => {
  it("always generates exactly 5 answer cards", () => {
    const records = makeN(20, 0.3, "AAPL");
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.answerCards).toHaveLength(5);
  });

  it("first answer card mentions rotation pressure", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.answerCards[0]!.question).toMatch(/rotation pressure/i);
  });

  it("fifth answer card mentions Phase 2E.2", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    expect(report.answerCards[4]!.answer).toContain("Phase 2E.2");
  });

  it("answer card mentions readyForUniverseInfluence=false", () => {
    const report = buildUniverseRotationIntelligenceReport([]);
    const lastCard = report.answerCards[4]!;
    expect(lastCard.answer).toContain("readyForUniverseInfluence=false");
  });
});

// ─── Metadata ────────────────────────────────────────────────────────────────

describe("metadata", () => {
  it("correctly counts symbolsWithAtLeast5Closes", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL"),
      ...makeN(4, 0.3, "TSLA"),   // < 5, should not count
      ...makeN(15, 0.3, "NVDA"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.metadata.symbolsWithAtLeast5Closes).toBe(2);
  });

  it("correctly counts symbolsWithAtLeast15Closes", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL"),
      ...makeN(15, 0.3, "NVDA"),
      ...makeN(30, 0.3, "MSFT"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.metadata.symbolsWithAtLeast15Closes).toBe(2);
  });

  it("correctly counts symbolsWithAtLeast30Closes", () => {
    const records = [
      ...makeN(29, 0.3, "AAPL"),
      ...makeN(30, 0.3, "MSFT"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.metadata.symbolsWithAtLeast30Closes).toBe(1);
  });

  it("symbolCount matches number of unique symbols", () => {
    const records = [
      ...makeN(3, 0.3, "AAPL"),
      ...makeN(3, 0.3, "TSLA"),
      ...makeN(3, 0.3, "NVDA"),
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.metadata.symbolCount).toBe(3);
  });
});

// ─── Multiple symbols ─────────────────────────────────────────────────────────

describe("multiple symbols", () => {
  it("handles multiple symbols with different verdicts correctly", () => {
    const records = [
      ...makeN(5, 0.3, "AAPL"),        // EARLY_PROMISING
      ...makeN(5, -0.4, "TSLA"),       // EARLY_DRAG
      ...makeN(15, 0.25, "NVDA"),      // WATCHABLE_PROMISING
      ...makeN(30, -0.25, "AMZN"),     // TOXIC_PRESSURE
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    expect(report.metadata.symbolCount).toBe(4);

    const aapl = report.symbolAssessments.find((s) => s.symbol === "AAPL")!;
    const tsla = report.symbolAssessments.find((s) => s.symbol === "TSLA")!;
    const nvda = report.symbolAssessments.find((s) => s.symbol === "NVDA")!;
    const amzn = report.symbolAssessments.find((s) => s.symbol === "AMZN")!;

    expect(aapl.verdict).toBe("EARLY_PROMISING");
    expect(tsla.verdict).toBe("EARLY_DRAG");
    expect(nvda.verdict).toBe("WATCHABLE_PROMISING");
    expect(amzn.verdict).toBe("TOXIC_PRESSURE");
  });

  it("symbolAssessments sorted by rotationPressureScore descending", () => {
    const records = [
      ...makeN(15, 0.3, "GOOD"),    // low pressure
      ...makeN(15, -0.4, "BAD"),    // high pressure
    ];
    const report = buildUniverseRotationIntelligenceReport(records);
    const scores = report.symbolAssessments.map((s) => s.rotationPressureScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    }
  });
});

// ─── generatedAt and evidenceEra ─────────────────────────────────────────────

describe("report metadata fields", () => {
  it("generatedAt uses the provided now date", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const report = buildUniverseRotationIntelligenceReport([], {}, now);
    expect(report.generatedAt).toBe("2026-01-15T10:00:00.000Z");
  });

  it("evidenceEra is reflected correctly in the report", () => {
    const report = buildUniverseRotationIntelligenceReport([], { evidenceEra: "ALL_TIME" });
    expect(report.evidenceEra).toBe("ALL_TIME");
  });
});

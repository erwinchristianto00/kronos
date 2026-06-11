import { describe, expect, it } from "vitest";

import type { StrategyExperienceRecord } from "@dtc/shared";

import { buildAdaptiveProfitPolicySynthesisReport, computeRealisticBasisMetrics, MICRO_PILOT_THRESHOLDS } from "../src/lib/adaptive-profit-policy.js";
import { buildExternalRotationOverlayEconomicsReport } from "../src/lib/external-rotation-overlay-economics.js";
import { buildExternalRotationOverlayPerformanceReport } from "../src/lib/external-rotation-overlay-performance.js";
import type { ExternalRotationOverlayObservation } from "../src/lib/external-rotation-overlay.js";

let counter = 0;

function record(opts: {
  symbol?: string;
  regime: string;
  direction: "LONG" | "SHORT";
  entry?: string;
  exit?: string;
  netR: number;
  directionalAlignmentLabel?: "ALIGNED" | "MIXED" | "CONFLICTED";
  horizonConflict?: boolean;
  selectedKronosBias?: "LONG" | "SHORT";
  whaleAgreement?: "AGREES" | "DISAGREES";
}): StrategyExperienceRecord {
  return {
    context: {
      schemaVersion: 1,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction,
      scanTimestamp: null,
      evidenceEra: "POST_CALIBRATION",
      marketRegime: opts.regime,
      selectedEntryVariant: opts.entry ?? "vwap_retest_entry",
      selectedExitVariant: opts.exit ?? "tp1_full_exit",
      directionalAlignmentLabel: opts.directionalAlignmentLabel,
      horizonConflict: opts.horizonConflict,
      selectedKronosBias: opts.selectedKronosBias,
      whaleAgreement: opts.whaleAgreement,
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `pp-${++counter}`,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction,
      evidenceEra: "POST_CALIBRATION",
      selectedEntryVariant: opts.entry ?? "vwap_retest_entry",
      selectedExitVariant: opts.exit ?? "tp1_full_exit",
      realizedNetR: opts.netR,
      realizedGrossR: opts.netR + 0.05,
      winnerLabel: opts.netR > 0 ? "WIN" : opts.netR < 0 ? "LOSS" : "BREAKEVEN",
      tp1Hit: opts.netR > 0,
      slHit: opts.netR < 0,
      closeReason: opts.netR > 0 ? "TP1" : "SL",
    } as StrategyExperienceRecord["outcome"],
  };
}

function many(count: number, opts: Parameters<typeof record>[0]): StrategyExperienceRecord[] {
  return Array.from({ length: count }, () => record(opts));
}

function overlayObservation(policyVersion: string, id: string, netR: number): ExternalRotationOverlayObservation {
  return {
    observationId: id,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:30:00.000Z",
    symbol: "EXTUSDT",
    overlayGroups: ["STRATEGY_FIT_SHORTLIST"],
    evidenceEra: "POST_CALIBRATION",
    selectionBatchId: "batch",
    sourceDiscoveryScore: 80,
    sourceStrategyFitScore: 80,
    sourceStrategyFitTier: "STRATEGY_FIT_HIGH",
    discoveryRank: 1,
    strategyFitRank: 1,
    lowFitRank: null,
    duplicateKey: id,
    detachedCandidateSnapshot: {
      direction: "SHORT",
      hypotheticalEntryVariant: "vwap_retest_entry",
      hypotheticalExitVariant: "tp1_full_exit",
      hypotheticalExpectedNetR: null,
      setupPlaybookLabel: "HIGH",
      stopDistanceBps: 200,
      riskReward: 1.8,
      marketRegime: "BEARISH_EXPANSION",
      plannedEntryPrice: 100,
      selectedEntryAnchorPrice: policyVersion.includes("anchor-consistent") ? 100 : null,
      entryBasis: policyVersion.includes("anchor-consistent") ? "VARIANT_ANCHOR" : "LEGACY_CURRENT_PRICE",
      entryZone: null,
      stopPrice: 102,
      tp1Price: 97,
      tp2Price: null,
      tp3Price: null,
      costR: 0.05,
      notes: [],
    },
    observationStatus: "RESOLVED",
    outcome: {
      realizedGrossR: netR + 0.05,
      realizedNetR: netR,
      winnerLabel: netR > 0 ? "WIN" : "LOSS",
      tp1Hit: netR > 0,
      tp2Hit: false,
      slHit: netR < 0,
      closeReason: netR > 0 ? "TP1_FULL" : "SL",
      openedAt: "2026-05-15T00:05:00.000Z",
      closedAt: "2026-05-15T00:20:00.000Z",
      durationMinutes: 15,
      fillStatus: "FILLED",
    },
    diagnostics: {
      createdByPolicyVersion: policyVersion,
      reasonCodes: [],
      resolutionSemantics: "test",
    },
  };
}

describe("buildAdaptiveProfitPolicySynthesisReport", () => {
  it("ranks bearish-short high because evidence supports it, while still evaluating bullish-long", () => {
    const report = buildAdaptiveProfitPolicySynthesisReport([
      ...many(24, { regime: "Bearish expansion", direction: "SHORT", netR: 0.18 }),
      ...many(20, { regime: "Bullish expansion", direction: "LONG", netR: -0.35 }),
    ]);
    expect(report.bestOverallPolicy?.direction).toBe("SHORT");
    expect(report.bestShortPolicy?.policyLabel).toContain("BEARISH_EXPANSION + SHORT");
    expect(report.bestLongPolicy?.policyLabel).toContain("BULLISH_EXPANSION + LONG");
    expect(report.currentAdaptiveDirectionBias).toBe("SHORT_BIAS");
  });

  it("can become LONG_BIAS when bullish-long evidence is superior", () => {
    const report = buildAdaptiveProfitPolicySynthesisReport([
      ...many(35, {
        regime: "Bullish expansion",
        direction: "LONG",
        netR: 0.3,
        directionalAlignmentLabel: "ALIGNED",
        horizonConflict: false,
        selectedKronosBias: "LONG",
        whaleAgreement: "AGREES",
      }),
      ...many(18, { regime: "Bearish expansion", direction: "SHORT", netR: -0.2 }),
    ]);
    expect(report.bestOverallPolicy?.direction).toBe("LONG");
    expect(report.currentAdaptiveDirectionBias).toBe("LONG_BIAS");
    expect(report.directionalReadiness.longLaneReadiness).toBe("PROMOTABLE");
    expect(report.bestLongPolicy?.evidenceConsensus.evidenceConsensusVerdict).toBe("HIGH_CONSENSUS");
  });

  it("does not let tiny positive samples outrank larger credible lanes", () => {
    const report = buildAdaptiveProfitPolicySynthesisReport([
      ...many(3, {
        symbol: "TINY",
        regime: "Bullish expansion",
        direction: "LONG",
        netR: 1.2,
        directionalAlignmentLabel: "ALIGNED",
        horizonConflict: false,
        selectedKronosBias: "LONG",
        whaleAgreement: "AGREES",
      }),
      ...many(24, { symbol: "LARGE", regime: "Bearish expansion", direction: "SHORT", netR: 0.16 }),
    ]);
    expect(report.bestOverallPolicy?.direction).toBe("SHORT");
    expect(report.rankedTopPolicies[0]?.sampleSize).toBeGreaterThan(3);
  });

  it("keeps external overlay evidence distinct and excludes legacy V1 tape upstream", () => {
    const observations = [
      overlayObservation("external-rotation-overlay-v1", "legacy", -5),
      overlayObservation("external-rotation-overlay-anchor-consistent-v2", "valid", 0.2),
    ];
    const performance = buildExternalRotationOverlayPerformanceReport(observations);
    const economics = buildExternalRotationOverlayEconomicsReport(observations);
    const report = buildAdaptiveProfitPolicySynthesisReport(
      many(20, { regime: "Bearish expansion", direction: "SHORT", netR: 0.1 }),
      { externalRotationOverlay: performance, externalRotationOverlayEconomics: economics },
    );
    const external = report.candidates.find((candidate) => candidate.sourceType === "EXTERNAL_OVERLAY");
    expect(performance.validityCounts.validObservationCount).toBe(1);
    expect(external?.sampleSize).toBe(1);
    expect(external?.contaminationFlags).toContain("LEGACY_V1_EXCLUDED_FROM_SOURCE_TAPE");
  });

  it("favors high-consensus evidence over otherwise similar conflicted evidence", () => {
    const report = buildAdaptiveProfitPolicySynthesisReport([
      ...many(16, {
        symbol: "BTCUSDT",
        regime: "Bearish expansion",
        direction: "SHORT",
        netR: 0.18,
        directionalAlignmentLabel: "ALIGNED",
        horizonConflict: false,
        selectedKronosBias: "SHORT",
        whaleAgreement: "AGREES",
      }),
      ...many(16, {
        symbol: "ETHUSDT",
        regime: "Bullish expansion",
        direction: "SHORT",
        netR: 0.18,
        directionalAlignmentLabel: "CONFLICTED",
        horizonConflict: true,
        selectedKronosBias: "LONG",
        whaleAgreement: "AGREES",
      }),
    ]);
    const supportive = report.candidates.find((candidate) => candidate.symbolScope === "BTCUSDT");
    const conflicted = report.candidates.find((candidate) => candidate.symbolScope === "ETHUSDT");
    expect(supportive?.evidenceConsensus.evidenceConsensusVerdict).toBe("HIGH_CONSENSUS");
    expect(conflicted?.evidenceConsensus.evidenceConsensusVerdict).toBe("CONFLICTED");
    expect((supportive?.rankingScore ?? 0) > (conflicted?.rankingScore ?? 0)).toBe(true);
    expect(conflicted?.collectionPriority).toBe("OBSERVE_ONLY");
  });

  it("does not promote a conflicted top lane into an operative primary lane", () => {
    const report = buildAdaptiveProfitPolicySynthesisReport([
      ...many(24, {
        regime: "Bearish expansion",
        direction: "SHORT",
        netR: 0.18,
        directionalAlignmentLabel: "CONFLICTED",
        horizonConflict: true,
        selectedKronosBias: "LONG",
        whaleAgreement: "AGREES",
      }),
    ]);
    expect(report.bestOverallPolicy?.evidenceConsensus.evidenceConsensusVerdict).toBe("CONFLICTED");
    expect(report.operativeCollectionPlan.currentOperativePrimaryLane).toBeNull();
    expect(report.operativeCollectionPlan.mode).toBe("VALIDATION_ONLY");
    expect(report.operativeCollectionPlan.secondaryValidationLanes[0]?.operativeCollectionPriority).toBe("SECONDARY_VALIDATION_LANE");
  });

  it("can produce an operative primary lane when economics and consensus are both strong", () => {
    const report = buildAdaptiveProfitPolicySynthesisReport([
      ...many(35, {
        regime: "Bullish expansion",
        direction: "LONG",
        netR: 0.3,
        directionalAlignmentLabel: "ALIGNED",
        horizonConflict: false,
        selectedKronosBias: "LONG",
        whaleAgreement: "AGREES",
      }),
    ]);
    expect(report.operativeCollectionPlan.mode).toBe("PRIMARY_LANE_ACTIVE");
    expect(report.operativeCollectionPlan.currentOperativePrimaryLane?.direction).toBe("LONG");
    expect(report.operativeCollectionPlan.currentOperativePrimaryLane?.operativeCollectionPriority).toBe("PRIMARY_PROFIT_LANE");
  });

  it("does not punish sparse context as conflict by default", () => {
    const report = buildAdaptiveProfitPolicySynthesisReport([
      ...many(12, { regime: "Bullish expansion", direction: "LONG", netR: 0.12 }),
    ]);
    expect(report.bestLongPolicy?.evidenceConsensus.evidenceConsensusVerdict).not.toBe("CONFLICTED");
    expect(report.bestLongPolicy?.evidenceConsensus.conflictingEvidenceCount).toBe(0);
    expect((report.bestLongPolicy?.evidenceConsensus.missingEvidenceCount ?? 0) > 0).toBe(true);
  });

  it("keeps micro-pilot readiness false under merely watchable conditions", () => {
    const report = buildAdaptiveProfitPolicySynthesisReport(
      many(20, { regime: "Bearish expansion", direction: "SHORT", netR: 0.12 }),
    );
    expect(report.bestOverallPolicy?.microPilotReadiness.microPilotReady).toBe(false);
    expect(report.bestOverallPolicy?.microPilotReadiness.verdict).toBe("WATCH_CLOSELY");
  });
});

// ─── Case d & e: EX_TOXIC sibling generation + original unchanged ───

describe("EX_TOXIC sibling generation (Phase 2 Cross-Intelligence)", () => {
  function toxicLaneRecords() {
    // BNB-like: n=6, all SL → tier-1 with rotation pressure
    // (n>=5 needed for EARLY tier in universe rotation → MODERATE pressure with score>=65)
    const bnb = Array.from({ length: 6 }, () =>
      record({ symbol: "BNBUSDT", regime: "Bearish expansion", direction: "SHORT", netR: -1 }),
    );
    // DOGE-like: n=2, all SL → tier-2
    const doge = Array.from({ length: 2 }, () =>
      record({ symbol: "DOGEUSDT", regime: "Bearish expansion", direction: "SHORT", netR: -1 }),
    );
    // Good symbol: n=30, profitable (also ensures SYMBOL_SENSITIVE route heterogeneity fires)
    const good = Array.from({ length: 30 }, () =>
      record({
        symbol: "BTCUSDT",
        regime: "Bearish expansion",
        direction: "SHORT",
        netR: 0.2,
        directionalAlignmentLabel: "ALIGNED",
        horizonConflict: false,
        selectedKronosBias: "SHORT",
        whaleAgreement: "AGREES",
      }),
    );
    return [...bnb, ...doge, ...good];
  }

  it("case d: emits an EX_TOXIC sibling for the best SHORT lane when tier-1 toxic symbols exist", () => {
    const records = toxicLaneRecords();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);
    const sibling = report.bestShortPolicyExToxic;
    expect(sibling).not.toBeNull();
    expect(sibling?.policyId).toContain("_EX_TOXIC");
    expect(sibling?.symbolScope).toBe("ALL_SYMBOLS_EX_TOXIC");
    expect(sibling?.excludedSymbols).toContain("BNBUSDT");
    expect(sibling?.toxicSymbolExclusionReason).toBe("LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT");
  });

  it("case d: sibling metrics are recomputed excluding tier-1 symbols (EX_TOXIC sibling is ALL_SYMBOLS scope)", () => {
    const records = toxicLaneRecords();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);
    const sibling = report.bestShortPolicyExToxic;
    // Sibling is always ALL_SYMBOLS_EX_TOXIC (across all non-toxic symbols)
    expect(sibling?.symbolScope).toBe("ALL_SYMBOLS_EX_TOXIC");
    // BNBUSDT excluded → sibling has fewer records than the ALL_SYMBOLS lane
    const allSymbolsLane = report.candidates.find(
      (c) => c.symbolScope === "ALL_SYMBOLS" && c.sourceType === "CORE" && c.direction === "SHORT",
    );
    expect((sibling?.sampleSize ?? 0)).toBeLessThan((allSymbolsLane?.sampleSize ?? 999));
    // BNBUSDT records removed → better net performance on sibling
    expect((sibling?.netAvgR ?? -99)).toBeGreaterThan((allSymbolsLane?.netAvgR ?? 99));
  });

  it("case e: original ALL_SYMBOLS policy is unchanged", () => {
    const records = toxicLaneRecords();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);
    // The ALL_SYMBOLS CORE candidate should still exist and be unchanged
    const allSymbolsOriginal = report.candidates.find(
      (c) => c.symbolScope === "ALL_SYMBOLS" && c.sourceType === "CORE" && c.direction === "SHORT",
    );
    expect(allSymbolsOriginal).toBeDefined();
    expect(allSymbolsOriginal?.policyId).not.toContain("_EX_TOXIC");
    // original sample includes all records (BNB + DOGE + BTC)
    expect((allSymbolsOriginal?.sampleSize ?? 0)).toBeGreaterThanOrEqual(38); // 6 BNB + 2 DOGE + 30 BTC
    // bestShortPolicy itself is unmodified (could be per-symbol or ALL_SYMBOLS)
    const bestShort = report.bestShortPolicy;
    expect(bestShort?.policyId).not.toContain("_EX_TOXIC");
    expect(bestShort?.symbolScope).not.toBe("ALL_SYMBOLS_EX_TOXIC");
  });

  it("case e: sibling appears in candidates array alongside the original", () => {
    const records = toxicLaneRecords();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);
    const siblings = report.candidates.filter((c) => c.symbolScope === "ALL_SYMBOLS_EX_TOXIC");
    const originals = report.candidates.filter((c) => c.symbolScope === "ALL_SYMBOLS");
    expect(siblings.length).toBeGreaterThanOrEqual(1);
    expect(originals.length).toBeGreaterThanOrEqual(1);
  });

  it("sibling tier2ToxicWatchlistSymbols contains DOGE-like n=2 symbols", () => {
    const records = toxicLaneRecords();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);
    const sibling = report.bestShortPolicyExToxic;
    expect(sibling?.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
  });

  it("sibling has a valid evidenceConsensus (re-run on filtered records)", () => {
    const records = toxicLaneRecords();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);
    const sibling = report.bestShortPolicyExToxic;
    expect(sibling?.evidenceConsensus).toBeDefined();
    expect(sibling?.evidenceConsensus.evidenceConsensusVerdict).not.toBeUndefined();
  });

  it("sibling microPilotReadiness is always microPilotReady=false", () => {
    const records = toxicLaneRecords();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);
    const sibling = report.bestShortPolicyExToxic;
    expect(sibling?.microPilotReadiness.microPilotReady).toBe(false);
  });

  it("case h: MICRO_PILOT_THRESHOLDS are unchanged", () => {
    // Assert that the patch does not change the thresholds
    expect(MICRO_PILOT_THRESHOLDS.minimumResolvedSample).toBe(30);
    expect(MICRO_PILOT_THRESHOLDS.minimumNetAvgR).toBe(0.15);
    expect(MICRO_PILOT_THRESHOLDS.minimumProfitFactor).toBe(1.2);
    expect(MICRO_PILOT_THRESHOLDS.maximumDistortedRatio).toBe(0.1);
    expect(MICRO_PILOT_THRESHOLDS.minimumRecentForwardEvidence).toBe(10);
  });
});

// ─── Refined Promotion (Task 2 / Task 4 tests 6, 7, 8) ──────────────────────

describe("refined policy promotion in buildAdaptiveProfitPolicySynthesisReport", () => {
  /**
   * BNB-like fixture: 6 BNB (all SL) + diverse good records spread across 3+ symbols.
   * ALL_SYMBOLS: n=40+, netAvgR dragged negative by BNB, PF < 1 (toxicity drag).
   * ALL_SYMBOLS_EX_TOXIC: n=34+ (>= 0.75 of parent ✓, >= 30 floor ✓), netAvgR positive.
   * Spreading good records across multiple symbols ensures no single-symbol candidate
   * outranks the ALL_SYMBOLS aggregate, making bestShortPolicy = ALL_SYMBOLS candidate.
   */
  function bnbLikeFixture() {
    // 6 BNB — all stop-out (tier-1 toxic candidate: n>=5, 100% SL)
    const bnb = Array.from({ length: 6 }, () =>
      record({ symbol: "BNBUSDT", regime: "Bearish expansion", direction: "SHORT", netR: -1 }),
    );
    // Good records spread across 3 symbols — each has n<30 individually but ALL_SYMBOLS has n=36
    // Use consensus-positive flags for the aggregate to rank well
    const goodOpts = {
      regime: "Bearish expansion",
      direction: "SHORT" as const,
      netR: 0.22,
      directionalAlignmentLabel: "ALIGNED" as const,
      horizonConflict: false,
      selectedKronosBias: "SHORT" as const,
      whaleAgreement: "AGREES" as const,
    };
    const good1 = Array.from({ length: 12 }, () => record({ symbol: "BTCUSDT", ...goodOpts }));
    const good2 = Array.from({ length: 12 }, () => record({ symbol: "ETHUSDT", ...goodOpts }));
    const good3 = Array.from({ length: 12 }, () => record({ symbol: "SOLUSDT", ...goodOpts }));
    return [...bnb, ...good1, ...good2, ...good3];
  }

  // Test 6: BNB-like fixture → bestShortPolicy becomes sibling, bestShortPolicyParent holds original
  it("test 6: BNB-like fixture → bestShortPolicy promoted to EX_TOXIC sibling; parent preserved in bestShortPolicyParent", () => {
    const records = bnbLikeFixture();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);

    // Promotion should have fired
    expect(report.shortPolicyPromotionResult?.refinedPromotionEligible).toBe(true);
    // bestShortPolicy is now the EX_TOXIC sibling
    expect(report.bestShortPolicy?.symbolScope).toBe("ALL_SYMBOLS_EX_TOXIC");
    // bestShortPolicyParent holds the ALL_SYMBOLS parent
    expect(report.bestShortPolicyParent).toBeDefined();
    expect(report.bestShortPolicyParent?.symbolScope).toBe("ALL_SYMBOLS");
    expect(report.bestShortPolicyParent?.policyId).not.toContain("_EX_TOXIC");
    // EX_TOXIC sibling field is still present
    expect(report.bestShortPolicyExToxic?.symbolScope).toBe("ALL_SYMBOLS_EX_TOXIC");
  });

  // Test 7: when promotion qualifies, rankedTopPolicies does not keep parent ranked above promoted sibling
  it("test 7: rankedTopPolicies places promoted EX_TOXIC sibling above its parent when promotion is active", () => {
    const records = bnbLikeFixture();
    const report = buildAdaptiveProfitPolicySynthesisReport(records);

    if (!report.shortPolicyPromotionResult?.refinedPromotionEligible) {
      // If promotion didn't fire with this data, the test assertion is vacuously safe
      return;
    }

    const promotedSiblingId = report.bestShortPolicy?.policyId;
    const displacedParentId = report.bestShortPolicyParent?.policyId;
    expect(promotedSiblingId).toBeDefined();
    expect(displacedParentId).toBeDefined();

    const promotedIdx = report.rankedTopPolicies.findIndex((p) => p.policyId === promotedSiblingId);
    const parentIdx = report.rankedTopPolicies.findIndex((p) => p.policyId === displacedParentId);

    // Promoted sibling must appear before (lower index = higher rank) parent if both are in top-3
    if (promotedIdx !== -1 && parentIdx !== -1) {
      expect(promotedIdx).toBeLessThan(parentIdx);
    }
    // If parent dropped out of top-3, promoted sibling must still appear
    if (promotedIdx === -1) {
      // Sibling should be in top-3 since it's bestShortPolicy (best) — flag as unexpected
      expect(promotedIdx).not.toBe(-1);
    }
  });

  // Test 8: when no EX_TOXIC sibling exists → no change to bestShortPolicy
  it("test 8: when no EX_TOXIC sibling exists, bestShortPolicy is unchanged and no promotion fields set", () => {
    // All same symbol, all same direction → no cross-symbol toxic detection fires
    const records = Array.from({ length: 35 }, () =>
      record({ symbol: "BTCUSDT", regime: "Bearish expansion", direction: "SHORT", netR: 0.1 }),
    );
    const report = buildAdaptiveProfitPolicySynthesisReport(records);

    // No EX_TOXIC sibling
    expect(report.bestShortPolicyExToxic).toBeNull();
    // bestShortPolicy is the ALL_SYMBOLS parent
    expect(report.bestShortPolicy?.symbolScope).toBe("ALL_SYMBOLS");
    // No parent preservation fields (promotion did not fire)
    expect(report.bestShortPolicyParent).toBeUndefined();
    // shortPolicyPromotionResult should be undefined (no sibling to evaluate against)
    expect(report.shortPolicyPromotionResult).toBeUndefined();
  });
});

// ─── Dual-Basis Cost Reporting (Realistic vs Conservative Basis) ──────────────

function recordWithCostFields(opts: {
  symbol?: string;
  regime: string;
  direction: "LONG" | "SHORT";
  netR: number;
  grossR: number;
  feeSlippageR: number;
  spreadR?: number;
}): StrategyExperienceRecord {
  return {
    context: {
      schemaVersion: 1,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction,
      scanTimestamp: null,
      evidenceEra: "POST_CALIBRATION",
      marketRegime: opts.regime,
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `rb-${++counter}`,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction,
      evidenceEra: "POST_CALIBRATION",
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      realizedNetR: opts.netR,
      realizedGrossR: opts.grossR,
      feeSlippageR: opts.feeSlippageR,
      spreadR: opts.spreadR ?? 0,
      winnerLabel: opts.netR > 0 ? "WIN" : opts.netR < 0 ? "LOSS" : "BREAKEVEN",
      tp1Hit: opts.netR > 0,
      slHit: opts.netR < 0,
      closeReason: opts.netR > 0 ? "TP1" : "SL",
    } as StrategyExperienceRecord["outcome"],
  };
}

describe("Dual-Basis Cost Reporting", () => {
  // 1. realisticNetR computes correctly for a single record
  it("computes realisticNetR correctly: grossR=0.3, feeSlipR=0.2 (28bps basis), spreadR=0.05", () => {
    // realisticFeeSlipR = 0.2 * (22/28) ≈ 0.15714
    // realisticCostR = 0.15714 + 0.05 = 0.20714
    // realisticNetR = 0.3 - 0.20714 ≈ 0.09286
    const r = recordWithCostFields({
      regime: "Bearish expansion",
      direction: "SHORT",
      netR: 0.3 - 0.25, // conservative net = gross - cost(28bps+spread=0.25)
      grossR: 0.3,
      feeSlippageR: 0.2,
      spreadR: 0.05,
    });
    const metrics = computeRealisticBasisMetrics([r], null);
    expect(metrics.realisticBasisCoverage).toBe(1);
    expect(metrics.netAvgRRealisticBasis).toBeCloseTo(0.3 - (0.2 * (22 / 28) + 0.05), 4);
  });

  // 2. Records with missing feeSlippageR → coverage=0, null netAvgR
  it("returns null netAvgRRealisticBasis when feeSlippageR is missing", () => {
    const r = {
      context: {
        schemaVersion: 1,
        symbol: "BTCUSDT",
        direction: "SHORT",
        scanTimestamp: null,
        evidenceEra: "POST_CALIBRATION",
        marketRegime: "Bearish expansion",
        selectedEntryVariant: "vwap_retest_entry",
        selectedExitVariant: "tp1_full_exit",
      },
      outcome: {
        schemaVersion: 1,
        positionId: `rb-missing-${++counter}`,
        symbol: "BTCUSDT",
        direction: "SHORT",
        evidenceEra: "POST_CALIBRATION",
        selectedEntryVariant: "vwap_retest_entry",
        selectedExitVariant: "tp1_full_exit",
        realizedNetR: 0.1,
        realizedGrossR: 0.35,
        feeSlippageR: null, // missing
        winnerLabel: "WIN" as const,
        tp1Hit: true,
        slHit: false,
        closeReason: "TP1",
      },
    } as StrategyExperienceRecord;
    const metrics = computeRealisticBasisMetrics([r], 0.1);
    expect(metrics.realisticBasisCoverage).toBe(0);
    expect(metrics.netAvgRRealisticBasis).toBeNull();
  });

  // 3. Empty records → null netAvgR, coverage=0
  it("returns null netAvgRRealisticBasis and coverage=0 for empty records array", () => {
    const metrics = computeRealisticBasisMetrics([], null);
    expect(metrics.netAvgRRealisticBasis).toBeNull();
    // profitFactor([]) = 0 (wins=0, losses=0 → returns 0 by design)
    expect(metrics.profitFactorRealisticBasis).toBe(0);
    expect(metrics.costDragRealisticBasis).toBeNull();
    expect(metrics.avgCostRRealisticBasis).toBeNull();
    expect(metrics.realisticBasisCoverage).toBe(0);
  });

  // 4. Mix of covered/uncovered → coverage fraction correct
  it("computes coverage fraction correctly with mixed covered/uncovered records", () => {
    const covered = recordWithCostFields({ regime: "Bearish expansion", direction: "SHORT", netR: 0.1, grossR: 0.3, feeSlippageR: 0.15 });
    const uncovered = {
      context: { schemaVersion: 1, symbol: "BTCUSDT", direction: "SHORT", scanTimestamp: null, evidenceEra: "POST_CALIBRATION", marketRegime: "Bearish expansion", selectedEntryVariant: "vwap_retest_entry", selectedExitVariant: "tp1_full_exit" },
      outcome: { schemaVersion: 1, positionId: `rb-unc-${++counter}`, symbol: "BTCUSDT", direction: "SHORT", evidenceEra: "POST_CALIBRATION", selectedEntryVariant: "vwap_retest_entry", selectedExitVariant: "tp1_full_exit", realizedNetR: 0.1, realizedGrossR: 0.35, feeSlippageR: undefined, winnerLabel: "WIN" as const, tp1Hit: true, slHit: false, closeReason: "TP1" },
    } as StrategyExperienceRecord;
    const metrics = computeRealisticBasisMetrics([covered, uncovered], 0.1);
    expect(metrics.realisticBasisCoverage).toBe(0.5);
  });

  // 5. costDragRealisticBasis is positive when realistic is better than conservative
  it("costDragRealisticBasis is positive (realistic > conservative) when fee basis is lower", () => {
    const records = Array.from({ length: 5 }, () =>
      recordWithCostFields({ regime: "Bearish expansion", direction: "SHORT", netR: -0.05, grossR: 0.2, feeSlippageR: 0.2, spreadR: 0.05 }),
    );
    const conservativeNetAvgR = -0.05;
    const metrics = computeRealisticBasisMetrics(records, conservativeNetAvgR);
    // Realistic must show better (higher) netAvgR than conservative
    expect((metrics.netAvgRRealisticBasis ?? 0)).toBeGreaterThan(conservativeNetAvgR);
    // costDrag = realistic - conservative → positive
    expect((metrics.costDragRealisticBasis ?? 0)).toBeGreaterThan(0);
  });

  // 6. Conservative metrics unchanged: candidate-level conservative fields still reflect 28bps
  it("conservative basis metrics (netAvgR, profitFactor) are unaffected by realistic basis computation", () => {
    const records = Array.from({ length: 36 }, (_, i) =>
      recordWithCostFields({
        symbol: "BTCUSDT",
        regime: "Bearish expansion",
        direction: "SHORT",
        netR: i < 18 ? 0.2 : -0.15,
        grossR: i < 18 ? 0.45 : 0.1,
        feeSlippageR: 0.2,
        spreadR: 0.05,
      }),
    );
    const report = buildAdaptiveProfitPolicySynthesisReport(records);
    const lane = report.candidates.find((c) => c.symbolScope === "ALL_SYMBOLS" && c.sourceType === "CORE" && c.direction === "SHORT");
    expect(lane).toBeDefined();
    // Conservative metrics are based on realizedNetR (not recomputed from feeSlippageR)
    // They must equal the average of the netR values we passed in
    const expectedConservativeNetAvgR = (18 * 0.2 + 18 * -0.15) / 36;
    expect(lane?.netAvgR).toBeCloseTo(expectedConservativeNetAvgR, 3);
    // Realistic basis must diverge (be higher than conservative when fee is lower)
    expect((lane?.netAvgRRealisticBasis ?? 0)).toBeGreaterThan(lane?.netAvgR ?? 0);
  });

  // 7. EX_TOXIC sibling gets realistic basis fields populated
  it("EX_TOXIC sibling has realistic basis fields populated", () => {
    const bnb = Array.from({ length: 6 }, () =>
      recordWithCostFields({ symbol: "BNBUSDT", regime: "Bearish expansion", direction: "SHORT", netR: -1, grossR: -0.75, feeSlippageR: 0.2, spreadR: 0.05 }),
    );
    const good = Array.from({ length: 30 }, () =>
      recordWithCostFields({
        symbol: "BTCUSDT",
        regime: "Bearish expansion",
        direction: "SHORT",
        netR: 0.2,
        grossR: 0.45,
        feeSlippageR: 0.2,
        spreadR: 0.05,
      }),
    );
    const report = buildAdaptiveProfitPolicySynthesisReport([...bnb, ...good]);
    const sibling = report.bestShortPolicyExToxic;
    expect(sibling).not.toBeNull();
    expect(sibling?.netAvgRRealisticBasis).toBeDefined();
    expect(sibling?.profitFactorRealisticBasis).toBeDefined();
    expect(sibling?.realisticBasisCoverage).toBeGreaterThan(0);
  });

  // 8. profitFactorRealisticBasis: mixed wins/losses → PF > 1 when wins dominate
  it("profitFactorRealisticBasis > 1.0 when wins dominate over losses on realistic basis", () => {
    // 8 winning records: grossR=0.5, feeSlipR=0.2, spreadR=0.05 → realisticNet≈0.293 (WIN)
    // 2 losing records:  grossR=-0.05, feeSlipR=0.2, spreadR=0.05 → realisticNet≈-0.257 (LOSS)
    const wins = Array.from({ length: 8 }, () =>
      recordWithCostFields({ regime: "Bearish expansion", direction: "SHORT", netR: 0.25, grossR: 0.5, feeSlippageR: 0.2, spreadR: 0.05 }),
    );
    const losses = Array.from({ length: 2 }, () =>
      recordWithCostFields({ regime: "Bearish expansion", direction: "SHORT", netR: -0.3, grossR: -0.05, feeSlippageR: 0.2, spreadR: 0.05 }),
    );
    const metrics = computeRealisticBasisMetrics([...wins, ...losses], 0.1);
    expect((metrics.profitFactorRealisticBasis ?? 0)).toBeGreaterThan(1.0);
  });
});

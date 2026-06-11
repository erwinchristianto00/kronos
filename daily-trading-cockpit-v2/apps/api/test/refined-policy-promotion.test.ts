import { describe, expect, it } from "vitest";

import type { AdaptiveProfitPolicyCandidate } from "../src/lib/adaptive-profit-policy.js";
import {
  evaluateRefinedPromotion,
  REFINED_PROMOTION_MIN_NET_AVG_R_UPLIFT,
  REFINED_PROMOTION_MIN_PROFIT_FACTOR_UPLIFT,
  REFINED_PROMOTION_MIN_SAMPLE_FLOOR,
  REFINED_PROMOTION_MIN_SAMPLE_RATIO,
} from "../src/lib/refined-policy-promotion.js";

function makeCandidate(overrides: Partial<AdaptiveProfitPolicyCandidate>): AdaptiveProfitPolicyCandidate {
  return {
    policyId: "CORE_ALL_BEARISH_SHORT_VWAP_TP1",
    policyLabel: "Test Policy",
    sourceType: "CORE",
    direction: "SHORT",
    dominantRegime: "BEARISH_EXPANSION",
    route: "vwap_retest_entry",
    exitPolicy: "tp1_full_exit",
    symbolScope: "ALL_SYMBOLS",
    sampleSize: 40,
    netAvgR: -0.1327,
    grossAvgR: -0.0121,
    profitFactor: 0.5916,
    deltaVsBaseline: 0.01,
    avgWinR: 0.5,
    avgLossR: -0.8,
    credibility: "CLEAN_EVALUABLE",
    contaminationFlags: [],
    validityFlags: ["POST_CALIBRATION_FILTERED_CORE_RECORDS"],
    policyVerdict: "WATCHABLE",
    blockers: [],
    whyThisPolicyRanksHere: [],
    rankingScore: 15,
    evidenceConsensus: {
      evidenceConsensusScore: 45,
      evidenceConsensusVerdict: "CONFLICTED",
      positiveEvidenceCount: 1,
      negativeEvidenceCount: 3,
      conflictingEvidenceCount: 1,
      missingEvidenceCount: 0,
      keyConsensusReasons: [],
      keyConflictReasons: [],
    },
    collectionPriority: "OBSERVE_ONLY",
    operativeCollectionPriority: "OBSERVE_ONLY",
    collectionPriorityReason: "",
    collectionPriorityScore: 0,
    collectionPriorityBlockers: [],
    microPilotReadiness: { verdict: "WATCH_CLOSELY", microPilotReady: false, blockers: [] },
    ...overrides,
  } as AdaptiveProfitPolicyCandidate;
}

function makeSibling(parent: AdaptiveProfitPolicyCandidate, siblingOverrides: Partial<AdaptiveProfitPolicyCandidate>): AdaptiveProfitPolicyCandidate {
  return makeCandidate({
    policyId: `${parent.policyId}_EX_TOXIC`,
    policyLabel: `${parent.policyLabel} [EX_TOXIC]`,
    symbolScope: "ALL_SYMBOLS_EX_TOXIC",
    sampleSize: 36,
    netAvgR: -0.0046,
    profitFactor: 0.9787,
    evidenceConsensus: {
      ...parent.evidenceConsensus,
      evidenceConsensusVerdict: "MIXED",
      evidenceConsensusScore: 55,
    },
    excludedSymbols: ["SOME_TOKEN"],
    ...siblingOverrides,
  });
}

// ── Test 1: All 7 checks pass → promoted ─────────────────────────────────────
describe("evaluateRefinedPromotion", () => {
  it("promotes when all 7 checks pass (live EX_TOXIC sibling scenario)", () => {
    const parent = makeCandidate({});
    const sibling = makeSibling(parent, {});

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(true);
    expect(result.preferredPolicyVariant).toBe("EX_TOXIC");
    expect(result.refinedPromotionChecks.samePolicyFamily).toBe(true);
    expect(result.refinedPromotionChecks.sampleRetained).toBe(true);
    expect(result.refinedPromotionChecks.netAvgRUplift).toBe(true);
    expect(result.refinedPromotionChecks.profitFactorUplift).toBe(true);
    expect(result.refinedPromotionChecks.verdictNotWorse).toBe(true);
    expect(result.refinedPromotionChecks.consensusNotWorse).toBe(true);
    expect(result.refinedPromotionChecks.contaminationReduced).toBe(true);
    expect(result.refinedPromotionReason).toContain("passes all 7 promotion checks");
  });

  // ── Test 2: sampleSize below floor ───────────────────────────────────────
  it("does NOT promote when sibling sampleSize is below the floor of 30", () => {
    const parent = makeCandidate({});
    const sibling = makeSibling(parent, { sampleSize: 25 });

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(false);
    expect(result.preferredPolicyVariant).toBe("PARENT");
    expect(result.refinedPromotionChecks.sampleRetained).toBe(false);
    expect(result.refinedPromotionReason).toContain("sampleRetained=false");
    // Threshold constant is honoured
    expect(sibling.sampleSize).toBeLessThan(REFINED_PROMOTION_MIN_SAMPLE_FLOOR);
  });

  // ── Test 3: netAvgR uplift below threshold ────────────────────────────────
  it("does NOT promote when netAvgR uplift is only +0.04R (< 0.05 threshold)", () => {
    const parent = makeCandidate({ netAvgR: -0.1327 });
    // parent.netAvgR = -0.1327, sibling needs delta < 0.05 → sibling.netAvgR < -0.0827
    const sibling = makeSibling(parent, { netAvgR: -0.0931 }); // delta = +0.04

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(false);
    expect(result.refinedPromotionChecks.netAvgRUplift).toBe(false);
    expect(result.refinedPromotionReason).toContain("netAvgRUplift=false");
    // Constant check
    expect(REFINED_PROMOTION_MIN_NET_AVG_R_UPLIFT).toBe(0.05);
  });

  // ── Test 4: consensus is worse (CONFLICTED < MIXED) ──────────────────────
  it("does NOT promote when sibling consensus is CONFLICTED and parent is MIXED", () => {
    const parent = makeCandidate({
      evidenceConsensus: {
        evidenceConsensusScore: 55,
        evidenceConsensusVerdict: "MIXED",
        positiveEvidenceCount: 2,
        negativeEvidenceCount: 2,
        conflictingEvidenceCount: 1,
        missingEvidenceCount: 0,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
    });
    const sibling = makeSibling(parent, {
      evidenceConsensus: {
        evidenceConsensusScore: 35,
        evidenceConsensusVerdict: "CONFLICTED",
        positiveEvidenceCount: 1,
        negativeEvidenceCount: 3,
        conflictingEvidenceCount: 2,
        missingEvidenceCount: 0,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
    });

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(false);
    expect(result.refinedPromotionChecks.consensusNotWorse).toBe(false);
    expect(result.refinedPromotionReason).toContain("consensusNotWorse=false");
  });

  // ── Test 5: Different policy family (direction mismatch) ─────────────────
  it("does NOT promote when sibling has a different direction (different policy family)", () => {
    const parent = makeCandidate({ direction: "SHORT" });
    const sibling = makeSibling(parent, { direction: "LONG" });

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(false);
    expect(result.refinedPromotionChecks.samePolicyFamily).toBe(false);
    expect(result.refinedPromotionReason).toContain("samePolicyFamily=false");
  });

  // ── Additional: PF uplift check using exported constant ──────────────────
  it("does NOT promote when PF uplift is below threshold", () => {
    const parent = makeCandidate({ profitFactor: 0.5916 });
    const sibling = makeSibling(parent, { profitFactor: 0.7300 }); // delta = 0.1384 < 0.15

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(false);
    expect(result.refinedPromotionChecks.profitFactorUplift).toBe(false);
    expect(REFINED_PROMOTION_MIN_PROFIT_FACTOR_UPLIFT).toBe(0.15);
  });

  // ── Additional: sibling NOT EX_TOXIC scope fails samePolicyFamily ─────────
  it("does NOT promote when sibling symbolScope is not ALL_SYMBOLS_EX_TOXIC", () => {
    const parent = makeCandidate({});
    const sibling = makeSibling(parent, { symbolScope: "ALL_SYMBOLS" });

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(false);
    expect(result.refinedPromotionChecks.samePolicyFamily).toBe(false);
  });

  // ── Additional: new contamination on sibling ──────────────────────────────
  it("does NOT promote when sibling has new contamination flags parent did not have", () => {
    const parent = makeCandidate({ contaminationFlags: [] });
    const sibling = makeSibling(parent, { contaminationFlags: ["NEW_FLAG"] });

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(false);
    expect(result.refinedPromotionChecks.contaminationReduced).toBe(false);
    expect(result.refinedPromotionReason).toContain("contaminationReduced=false");
  });

  // ── Additional: sample ratio check (below 75% threshold) ─────────────────
  it("does NOT promote when sibling sampleSize < 75% of parent sampleSize (even if >= 30)", () => {
    // parent n=80, 75% = 60; sibling n=30 is below floor but also well below ratio
    const parent = makeCandidate({ sampleSize: 80, netAvgR: -0.2 });
    const sibling = makeSibling(parent, { sampleSize: 30 }); // 30 < 60

    const result = evaluateRefinedPromotion(parent, sibling);

    expect(result.refinedPromotionEligible).toBe(false);
    expect(result.refinedPromotionChecks.sampleRetained).toBe(false);
    expect(REFINED_PROMOTION_MIN_SAMPLE_RATIO).toBe(0.75);
  });
});

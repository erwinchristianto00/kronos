import type { AdaptiveProfitPolicyCandidate } from "./adaptive-profit-policy.js";

// ── Exported threshold constants ─────────────────────────────────────────────
export const REFINED_PROMOTION_MIN_SAMPLE_RATIO = 0.75;
export const REFINED_PROMOTION_MIN_SAMPLE_FLOOR = 30;
export const REFINED_PROMOTION_MIN_NET_AVG_R_UPLIFT = 0.05;
export const REFINED_PROMOTION_MIN_PROFIT_FACTOR_UPLIFT = 0.15;

// ── Verdict ordering (higher index = better) ─────────────────────────────────
const VERDICT_ORDER: Record<string, number> = {
  REJECT: 0,
  WEAK: 1,
  MARGINAL: 2,
  TOO_EARLY: 3,
  WATCHABLE: 4,
  STRONG_WATCHABLE: 5,
  DEPLOYABLE_SHADOW_CANDIDATE: 6,
  PROMOTABLE: 7,
};

// ── Consensus ordering (higher index = better) ───────────────────────────────
const CONSENSUS_ORDER: Record<string, number> = {
  INSUFFICIENT_CONTEXT: 0,
  CONFLICTED: 1,
  MIXED: 2,
  MODERATE_CONSENSUS: 3,
  HIGH_CONSENSUS: 4,
};

function verdictRank(verdict: string): number {
  return VERDICT_ORDER[verdict] ?? 0;
}

function consensusRank(consensus: string): number {
  return CONSENSUS_ORDER[consensus] ?? 0;
}

export interface RefinedPromotionChecks {
  samePolicyFamily: boolean;
  /** sibling.sampleSize >= RATIO * parent.sampleSize AND sibling.sampleSize >= FLOOR */
  sampleRetained: boolean;
  /** sibling.netAvgR - parent.netAvgR >= MIN_NET_AVG_R_UPLIFT */
  netAvgRUplift: boolean;
  /** sibling.profitFactor - parent.profitFactor >= MIN_PROFIT_FACTOR_UPLIFT */
  profitFactorUplift: boolean;
  /** sibling verdict ranks >= parent verdict rank */
  verdictNotWorse: boolean;
  /** sibling consensus ranks >= parent consensus rank */
  consensusNotWorse: boolean;
  /** sibling has no contamination flags that parent did not already have */
  contaminationReduced: boolean;
}

export interface RefinedPromotionResult {
  refinedPromotionEligible: boolean;
  refinedPromotionReason: string;
  refinedPromotionChecks: RefinedPromotionChecks;
  preferredPolicyVariant: "PARENT" | "EX_TOXIC";
}

/**
 * Evaluates whether an EX_TOXIC sibling candidate qualifies to be formally
 * promoted as the preferred representative of its policy family.
 *
 * All 7 checks must pass for promotion to be granted. No hardcoded ticker
 * symbols; all thresholds reference exported named constants.
 */
export function evaluateRefinedPromotion(
  parent: AdaptiveProfitPolicyCandidate,
  sibling: AdaptiveProfitPolicyCandidate,
): RefinedPromotionResult {
  // Check 1: Same policy family
  const samePolicyFamily =
    sibling.dominantRegime === parent.dominantRegime &&
    sibling.direction === parent.direction &&
    sibling.route === parent.route &&
    sibling.exitPolicy === parent.exitPolicy &&
    sibling.symbolScope === "ALL_SYMBOLS_EX_TOXIC";

  // Check 2: Sample retained
  const sampleRetained =
    sibling.sampleSize >= REFINED_PROMOTION_MIN_SAMPLE_RATIO * parent.sampleSize &&
    sibling.sampleSize >= REFINED_PROMOTION_MIN_SAMPLE_FLOOR;

  // Check 3: netAvgR uplift
  const parentNetAvgR = parent.netAvgR ?? Number.NEGATIVE_INFINITY;
  const siblingNetAvgR = sibling.netAvgR ?? Number.NEGATIVE_INFINITY;
  const netAvgRUplift = siblingNetAvgR - parentNetAvgR >= REFINED_PROMOTION_MIN_NET_AVG_R_UPLIFT;

  // Check 4: PF uplift
  // A null sibling PF means all-wins (no losses in the EX_TOXIC window) — treated as
  // Infinity for the uplift comparison so the check always passes in that case.
  const parentPf = parent.profitFactor ?? 0;
  const siblingPf = sibling.profitFactor; // may be null
  const profitFactorUplift =
    siblingPf === null
      ? (parent.profitFactor !== null)  // sibling has zero losses, parent had some → true uplift
      : siblingPf - parentPf >= REFINED_PROMOTION_MIN_PROFIT_FACTOR_UPLIFT;

  // Check 5: Verdict not worse
  const verdictNotWorse =
    verdictRank(sibling.policyVerdict) >= verdictRank(parent.policyVerdict);

  // Check 6: Consensus not worse
  const verdictNotWorseConsensus =
    consensusRank(sibling.evidenceConsensus.evidenceConsensusVerdict) >=
    consensusRank(parent.evidenceConsensus.evidenceConsensusVerdict);

  // Check 7: No new contamination flags on sibling that parent did not already have
  const parentFlagSet = new Set(parent.contaminationFlags);
  const newSiblingFlags = sibling.contaminationFlags.filter((flag) => !parentFlagSet.has(flag));
  const contaminationReduced = newSiblingFlags.length === 0;

  const checks: RefinedPromotionChecks = {
    samePolicyFamily,
    sampleRetained,
    netAvgRUplift,
    profitFactorUplift,
    verdictNotWorse,
    consensusNotWorse: verdictNotWorseConsensus,
    contaminationReduced,
  };

  const eligible =
    samePolicyFamily &&
    sampleRetained &&
    netAvgRUplift &&
    profitFactorUplift &&
    verdictNotWorse &&
    verdictNotWorseConsensus &&
    contaminationReduced;

  let reason: string;
  const pfDeltaDisplay = siblingPf === null
    ? "sibling has no losses (all-win window)"
    : `+${((siblingPf ?? 0) - parentPf).toFixed(4)}`;
  if (eligible) {
    reason =
      `EX_TOXIC sibling passes all 7 promotion checks: same policy family, ` +
      `sample retained (${sibling.sampleSize}/${parent.sampleSize}), ` +
      `netAvgR uplift +${(siblingNetAvgR - parentNetAvgR).toFixed(4)}R, ` +
      `PF uplift ${pfDeltaDisplay}, ` +
      `verdict not worse (${parent.policyVerdict} → ${sibling.policyVerdict}), ` +
      `consensus not worse (${parent.evidenceConsensus.evidenceConsensusVerdict} → ${sibling.evidenceConsensus.evidenceConsensusVerdict}), ` +
      `no new contamination.`;
  } else {
    const failures: string[] = [];
    if (!samePolicyFamily) failures.push("samePolicyFamily=false");
    if (!sampleRetained) failures.push(`sampleRetained=false (sibling.n=${sibling.sampleSize}, floor=${REFINED_PROMOTION_MIN_SAMPLE_FLOOR}, ratio required=${REFINED_PROMOTION_MIN_SAMPLE_RATIO}*${parent.sampleSize}=${REFINED_PROMOTION_MIN_SAMPLE_RATIO * parent.sampleSize})`);
    if (!netAvgRUplift) failures.push(`netAvgRUplift=false (delta=${(siblingNetAvgR - parentNetAvgR).toFixed(4)}, required>=${REFINED_PROMOTION_MIN_NET_AVG_R_UPLIFT})`);
    if (!profitFactorUplift) failures.push(`profitFactorUplift=false (delta=${siblingPf !== null ? (siblingPf - parentPf).toFixed(4) : "sibling PF=null but parent PF=null too"}, required>=${REFINED_PROMOTION_MIN_PROFIT_FACTOR_UPLIFT})`);
    if (!verdictNotWorse) failures.push(`verdictNotWorse=false (parent=${parent.policyVerdict}, sibling=${sibling.policyVerdict})`);
    if (!verdictNotWorseConsensus) failures.push(`consensusNotWorse=false (parent=${parent.evidenceConsensus.evidenceConsensusVerdict}, sibling=${sibling.evidenceConsensus.evidenceConsensusVerdict})`);
    if (!contaminationReduced) failures.push(`contaminationReduced=false (new flags: ${newSiblingFlags.join(", ")})`);
    reason = `EX_TOXIC sibling does not qualify for promotion. Failed checks: ${failures.join("; ")}.`;
  }

  return {
    refinedPromotionEligible: eligible,
    refinedPromotionReason: reason,
    refinedPromotionChecks: checks,
    preferredPolicyVariant: eligible ? "EX_TOXIC" : "PARENT",
  };
}

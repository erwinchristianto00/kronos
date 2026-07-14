/**
 * Simulation provenance hierarchy (Market Digital Twin, Phase-1 foundation). EVERY market frame, feature, event,
 * execution outcome, counterfactual, and experience record carries its provenance so the learning firewall can
 * decide eligibility WITHOUT any silent mixing of real and synthetic data. Pure module — no I/O, no side effects.
 *
 * Historical-first ordering (highest realism → lowest): OBSERVED_HISTORICAL > HISTORICAL_BOOTSTRAP >
 * EMPIRICALLY_CALIBRATED > STRESS_PERTURBATION > ADVERSARIAL_SYNTHETIC > UNCONSTRAINED_SYNTHETIC.
 */

export type SimulationProvenance =
  | "OBSERVED_HISTORICAL"
  | "HISTORICAL_BOOTSTRAP"
  | "EMPIRICALLY_CALIBRATED"
  | "STRESS_PERTURBATION"
  | "ADVERSARIAL_SYNTHETIC"
  | "UNCONSTRAINED_SYNTHETIC";

/** Ordered most-realistic → least. Index doubles as a realism rank (lower = more grounded in observed markets). */
export const PROVENANCE_RANK: readonly SimulationProvenance[] = [
  "OBSERVED_HISTORICAL",
  "HISTORICAL_BOOTSTRAP",
  "EMPIRICALLY_CALIBRATED",
  "STRESS_PERTURBATION",
  "ADVERSARIAL_SYNTHETIC",
  "UNCONSTRAINED_SYNTHETIC",
] as const;

export function provenanceRank(p: SimulationProvenance): number {
  return PROVENANCE_RANK.indexOf(p);
}

/** Learning-eligibility gate for a downstream experience record — this phase NEVER trains, so it is metadata only. */
export type ExperienceLearningEligibility =
  | "STRESS_TEST_ONLY"
  | "RESEARCH_ONLY"
  | "TRANSFER_TEST_REQUIRED"
  | "REAL_DATA_ELIGIBLE";

/** Final direct-learning firewall. This is intentionally stricter than the older Phase-1 research metadata:
 * observed historical paths may be eligible after the Experience Engine's causal audit; every generated path is
 * permanently ineligible to change CORTEX coefficients, even when historically calibrated. */
export type DirectTrainingEligibility = "ELIGIBLE_AFTER_CAUSAL_AUDIT" | "INELIGIBLE_FOR_DIRECT_TRAINING";

export interface ProvenanceEligibility {
  stressTesting: boolean;
  /** Whether the provenance may be used for model RESEARCH (distributional study), not training. */
  modelResearch: "YES" | "LIMITED" | "FAILURE_ANALYSIS_ONLY" | "NO";
  /** The MOST that a future candidate-learning pipeline could ever consider (still gated by transfer proof). */
  futureCandidateLearning: "POTENTIALLY_ELIGIBLE" | "ELIGIBLE_WITH_DISCOUNT_AND_TRANSFER_PROOF" | "EXPERIMENTAL_ONLY" | "NO";
  /** The eligibility label every experience of this provenance MUST carry during THIS phase. */
  phase1Eligibility: ExperienceLearningEligibility;
  directTrainingEligibility: DirectTrainingEligibility;
}

/**
 * The frozen eligibility matrix (operator-specified). During this phase, learning weights are NEVER applied — these
 * are stored as METADATA only. Any experience is at most `TRANSFER_TEST_REQUIRED`; most are `STRESS_TEST_ONLY`.
 */
const ELIGIBILITY: Record<SimulationProvenance, ProvenanceEligibility> = {
  OBSERVED_HISTORICAL: { stressTesting: true, modelResearch: "YES", futureCandidateLearning: "POTENTIALLY_ELIGIBLE", phase1Eligibility: "TRANSFER_TEST_REQUIRED", directTrainingEligibility: "ELIGIBLE_AFTER_CAUSAL_AUDIT" },
  HISTORICAL_BOOTSTRAP: { stressTesting: true, modelResearch: "YES", futureCandidateLearning: "ELIGIBLE_WITH_DISCOUNT_AND_TRANSFER_PROOF", phase1Eligibility: "TRANSFER_TEST_REQUIRED", directTrainingEligibility: "INELIGIBLE_FOR_DIRECT_TRAINING" },
  EMPIRICALLY_CALIBRATED: { stressTesting: true, modelResearch: "YES", futureCandidateLearning: "EXPERIMENTAL_ONLY", phase1Eligibility: "TRANSFER_TEST_REQUIRED", directTrainingEligibility: "INELIGIBLE_FOR_DIRECT_TRAINING" },
  STRESS_PERTURBATION: { stressTesting: true, modelResearch: "LIMITED", futureCandidateLearning: "NO", phase1Eligibility: "STRESS_TEST_ONLY", directTrainingEligibility: "INELIGIBLE_FOR_DIRECT_TRAINING" },
  ADVERSARIAL_SYNTHETIC: { stressTesting: true, modelResearch: "FAILURE_ANALYSIS_ONLY", futureCandidateLearning: "NO", phase1Eligibility: "STRESS_TEST_ONLY", directTrainingEligibility: "INELIGIBLE_FOR_DIRECT_TRAINING" },
  UNCONSTRAINED_SYNTHETIC: { stressTesting: true, modelResearch: "NO", futureCandidateLearning: "NO", phase1Eligibility: "STRESS_TEST_ONLY", directTrainingEligibility: "INELIGIBLE_FOR_DIRECT_TRAINING" },
};

export function eligibilityFor(p: SimulationProvenance): ProvenanceEligibility {
  return ELIGIBILITY[p];
}

/**
 * The single invariant the learning firewall enforces THIS phase: NO simulation experience may be REAL_DATA_ELIGIBLE.
 * (Only genuinely observed live/real trade outcomes could ever be, and those do not flow through this simulator.)
 */
export function isPhase1LearningForbidden(eligibility: ExperienceLearningEligibility): boolean {
  return eligibility !== "REAL_DATA_ELIGIBLE";
}

export function isDirectTrainingForbidden(eligibility: ProvenanceEligibility): boolean {
  return eligibility.directTrainingEligibility === "INELIGIBLE_FOR_DIRECT_TRAINING";
}

/** When two records of differing provenance are combined, the RESULT takes the LEAST-grounded (highest-rank) one —
 *  synthetic contamination is never silently upgraded to look historical. */
export function combineProvenance(a: SimulationProvenance, b: SimulationProvenance): SimulationProvenance {
  return provenanceRank(a) >= provenanceRank(b) ? a : b;
}

/**
 * Four-Brain shadow learning report (report-only). Aggregates FourBrainEconomicExperience rows into
 * a per-brain/per-lane evidence report and a chronological incumbent-vs-challenger comparison, using
 * only the canonical success-goal-contract.ts classifiers — it computes no new goal semantics, and it
 * never selects a lane, changes an allocation, or promotes anything.
 */
import {
  type DatedNetR,
  type EconomicOutcomeInput,
  type ChronologicalWindow,
  type LaneEvidenceState,
  type ImprovementVerdict,
  classifyLaneEvidence,
  summarizeEconomicReinforcement,
  chronologicalDailyMetrics,
  aggregateNetRByUtcDay,
  evaluateHardenedOutOfSampleSharpe,
  evaluateImprovement,
} from "./success-goal-contract.js";
import type { FourBrainEconomicExperience, FourBrainEconomicRejectionReason, FourBrainName } from "./four-brain-economic-experience.js";

export type FourBrainEvidenceStatus = LaneEvidenceState | "EVALUATION_ONLY";

export interface FourBrainOOSWindows {
  readonly trainingWindow: ChronologicalWindow;
  readonly evaluationWindow: ChronologicalWindow;
}

export interface FourBrainShadowLaneReport {
  readonly brain: FourBrainName;
  readonly laneId: string;
  readonly effectiveN: number;
  readonly positiveCount: number;
  readonly neutralCount: number;
  readonly negativeCount: number;
  readonly averageNetR: number | null;
  readonly conservativeExpectedNetR: number | null;
  readonly rawSharpe: number | null;
  readonly trueOutOfSampleSharpe: number | null;
  readonly profitFactor: number | null;
  readonly maxDrawdown: number | null;
  readonly expectedShortfall: number | null;
  readonly costCompletenessRate: number;
  readonly lineageCompletenessRate: number;
  readonly riskViolationCount: number;
  readonly evidenceStatus: FourBrainEvidenceStatus;
}

function seriesOf(experiences: readonly FourBrainEconomicExperience[]): DatedNetR[] {
  return experiences
    .filter((e) => Number.isFinite(e.closedTimeMs) && Number.isFinite(e.netR))
    .map((e) => ({ atMs: e.closedTimeMs!, netR: e.netR! }));
}

/**
 * Builds one brain+lane report from its ELIGIBLE (already DIRECT_LEARNING_ELIGIBLE) experiences plus
 * the adapter's own rejection tally for that same population, so cost/lineage completeness is
 * measured against everything that was CANDIDATE evidence, not only what survived.
 */
export function buildFourBrainShadowLaneReport(
  brain: FourBrainName,
  laneId: string,
  eligibleExperiences: readonly FourBrainEconomicExperience[],
  rejectedCounts: Record<FourBrainEconomicRejectionReason, number>,
  windows: FourBrainOOSWindows | null,
): FourBrainShadowLaneReport {
  const distinctOutcomeIds = new Set(eligibleExperiences.map((e) => e.outcomeId));
  const effectiveN = distinctOutcomeIds.size;

  const inputs: EconomicOutcomeInput[] = eligibleExperiences.map((e) => ({
    exactOwnership: e.exactOwnership,
    originalRisk: e.originalRisk,
    grossR: e.grossR,
    costR: e.costR,
    netR: e.netR,
    costKnownComplete: e.costKnownComplete,
    policyLineageMatches: e.policyLineageMatches,
    resolved: e.resolved,
    intrabarAmbiguous: e.intrabarAmbiguous,
    decisionTimeMs: e.decisionTimeMs,
    openedTimeMs: e.openedTimeMs,
    closedTimeMs: e.closedTimeMs,
  }));
  const reinforcement = summarizeEconomicReinforcement(inputs);

  const series = seriesOf(eligibleExperiences);
  const daily = aggregateNetRByUtcDay(series);
  const dailyMetrics = chronologicalDailyMetrics(daily.map((row) => row.netR));
  const oos = windows ? evaluateHardenedOutOfSampleSharpe(series, windows.trainingWindow, windows.evaluationWindow) : null;
  const trueOutOfSampleSharpe = oos?.status === "AVAILABLE" ? oos.outOfSampleSharpe : null;

  const costRejections = rejectedCounts.INCOMPLETE_COST + rejectedCounts.INVALID_COST_CONVENTION + rejectedCounts.ECONOMIC_ARITHMETIC_MISMATCH;
  const lineageRejections = rejectedCounts.MISSING_CAUSAL_IDENTITY + rejectedCounts.IDENTITY_MISMATCH
    + rejectedCounts.STALE_POLICY_CONTEXT + rejectedCounts.PRE_CUTOVER;
  const costCandidatePool = effectiveN + costRejections;
  const lineageCandidatePool = effectiveN + lineageRejections;
  const costCompletenessRate = costCandidatePool > 0 ? effectiveN / costCandidatePool : 0;
  const lineageCompletenessRate = lineageCandidatePool > 0 ? effectiveN / lineageCandidatePool : 0;
  const riskViolationCount = rejectedCounts.MISSING_IMMUTABLE_RISK;

  const evidenceStatus: FourBrainEvidenceStatus = classifyLaneEvidence({
    effectiveN,
    conservativeExpectedNetR: reinforcement.conservativeExpectedNetR,
    outOfSampleSharpe: trueOutOfSampleSharpe,
    profitFactor: dailyMetrics.profitFactor,
    costCompletenessRate,
    lineageComplete: lineageRejections === 0,
    materialRiskRailViolation: riskViolationCount > 0,
  });

  return {
    brain,
    laneId,
    effectiveN,
    positiveCount: reinforcement.positiveCount,
    neutralCount: reinforcement.neutralCount,
    negativeCount: reinforcement.negativeCount,
    averageNetR: reinforcement.averageRewardR,
    conservativeExpectedNetR: reinforcement.conservativeExpectedNetR,
    rawSharpe: dailyMetrics.rawSharpe,
    trueOutOfSampleSharpe,
    profitFactor: dailyMetrics.profitFactor,
    maxDrawdown: dailyMetrics.maxDrawdown,
    expectedShortfall: dailyMetrics.expectedShortfall,
    costCompletenessRate,
    lineageCompletenessRate,
    riskViolationCount,
    evidenceStatus,
  };
}

/** Exit Brain has no adapter path (see fourBrainExitAttributionStatus) — always report-only. */
export function fourBrainEvaluationOnlyReport(brain: FourBrainName, laneId: string): FourBrainShadowLaneReport {
  return {
    brain,
    laneId,
    effectiveN: 0,
    positiveCount: 0,
    neutralCount: 0,
    negativeCount: 0,
    averageNetR: null,
    conservativeExpectedNetR: null,
    rawSharpe: null,
    trueOutOfSampleSharpe: null,
    profitFactor: null,
    maxDrawdown: null,
    expectedShortfall: null,
    costCompletenessRate: 0,
    lineageCompletenessRate: 0,
    riskViolationCount: 0,
    evidenceStatus: "EVALUATION_ONLY",
  };
}

export interface FourBrainIncumbentChallengerComparison {
  readonly cohortLabel: string;
  readonly incumbentLaneId: string;
  readonly challengerLaneId: string;
  readonly effectiveN: number;
  readonly improvementVerdict: ImprovementVerdict;
}

/** All experiences on one side must share one fourBrainCodeVersion — the caller groups by instance/
 *  cohort before calling (FourBrainEconomicExperience carries no instanceId; see the field-gap
 *  matrix), and this is the one check this pure function CAN make: it refuses to blend two different
 *  Four-Brain schema/policy generations into a single verdict. */
function sameCohort(experiences: readonly FourBrainEconomicExperience[]): boolean {
  if (experiences.length === 0) return true;
  const version = experiences[0]!.fourBrainCodeVersion;
  return experiences.every((e) => e.fourBrainCodeVersion === version);
}

function chronologicalMetricsFor(experiences: readonly FourBrainEconomicExperience[], windows: FourBrainOOSWindows | null) {
  const series = seriesOf(experiences);
  const daily = aggregateNetRByUtcDay(series);
  const dailyMetrics = chronologicalDailyMetrics(daily.map((row) => row.netR));
  const oos = windows ? evaluateHardenedOutOfSampleSharpe(series, windows.trainingWindow, windows.evaluationWindow) : null;
  return {
    meanNetR: dailyMetrics.meanNetR,
    outOfSampleSharpe: oos?.status === "AVAILABLE" ? oos.outOfSampleSharpe : null,
    maxDrawdown: dailyMetrics.maxDrawdown,
    expectedShortfall: dailyMetrics.expectedShortfall,
  };
}

/**
 * Report-only incumbent-vs-challenger verdict. Chronological (both sides run through the hardened,
 * timestamp-gated OOS evaluator), cohort-consistent (refuses to blend Four-Brain schema/policy
 * generations), risk-regression-blocking and OOS-unavailable-blocking (both enforced inside
 * evaluateImprovement — a null/mismatched-cohort input always yields INVALID_COMPARISON, never a
 * fallback to raw Sharpe). Returns a verdict only — never selects a lane or changes an allocation.
 */
export function compareFourBrainIncumbentVsChallenger(input: {
  cohortLabel: string;
  incumbentLaneId: string;
  challengerLaneId: string;
  incumbentExperiences: readonly FourBrainEconomicExperience[];
  challengerExperiences: readonly FourBrainEconomicExperience[];
  incumbentWindows: FourBrainOOSWindows | null;
  challengerWindows: FourBrainOOSWindows | null;
}): FourBrainIncumbentChallengerComparison {
  const cohortConsistent = sameCohort(input.incumbentExperiences) && sameCohort(input.challengerExperiences);
  const incumbentMetrics = chronologicalMetricsFor(input.incumbentExperiences, input.incumbentWindows);
  const challengerMetrics = chronologicalMetricsFor(input.challengerExperiences, input.challengerWindows);
  const effectiveN = new Set(input.challengerExperiences.map((e) => e.outcomeId)).size;

  const improvementVerdict = evaluateImprovement({
    completeLineage: cohortConsistent,
    effectiveN,
    challenger: challengerMetrics,
    incumbent: incumbentMetrics,
  });

  return {
    cohortLabel: input.cohortLabel,
    incumbentLaneId: input.incumbentLaneId,
    challengerLaneId: input.challengerLaneId,
    effectiveN,
    improvementVerdict,
  };
}

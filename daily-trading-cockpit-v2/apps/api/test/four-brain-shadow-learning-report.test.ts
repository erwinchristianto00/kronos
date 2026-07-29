import { describe, expect, it } from "vitest";

import {
  buildFourBrainShadowLaneReport,
  compareFourBrainIncumbentVsChallenger,
  fourBrainEvaluationOnlyReport,
  type FourBrainOOSWindows,
} from "../src/lib/four-brain-shadow-learning-report.js";
import type { FourBrainEconomicExperience, FourBrainEconomicRejectionReason } from "../src/lib/four-brain-economic-experience.js";

const ZERO_REJECTED: Record<FourBrainEconomicRejectionReason, number> = {
  MISSING_CAUSAL_IDENTITY: 0, IDENTITY_MISMATCH: 0, STALE_POLICY_CONTEXT: 0, PRE_CUTOVER: 0,
  MISSING_IMMUTABLE_RISK: 0, INCOMPLETE_COST: 0, INVALID_COST_CONVENTION: 0, ECONOMIC_ARITHMETIC_MISMATCH: 0,
  AMBIGUOUS_INTRABAR: 0, INVALID_OUTCOME_QUALITY: 0, MISSING_FEATURE_SNAPSHOT: 0, SOURCE_ERROR: 0, UNRESOLVED: 0,
};

const DAY_MS = 86_400_000;

function experience(overrides: Partial<FourBrainEconomicExperience> & { netR: number; closedTimeMs: number }): FourBrainEconomicExperience {
  const netR = overrides.netR;
  const costR = 0.02;
  return {
    schemaVersion: "four-brain-economic-experience/1",
    brain: "ENTRY",
    executiveDecisionId: `exec-${overrides.closedTimeMs}`,
    executiveReviewId: `executive-review:exec-${overrides.closedTimeMs}:opp`,
    opportunityId: `opp-${overrides.closedTimeMs}`,
    outcomeId: `outcome-${overrides.closedTimeMs}`,
    laneId: "CG_WIDE_FAST_LONG",
    symbolOrBasketId: "BTCUSDT",
    direction: "LONG",
    attributionEligibility: "DIRECT_LEARNING_ELIGIBLE",
    economicClass: netR > 0.03 ? "POSITIVE" : netR < -0.03 ? "NEGATIVE" : "NEUTRAL",
    fourBrainCodeVersion: "executive/2",
    featureSnapshot: { trendScore: 0.1 },
    featureSchemaVersions: { executive: "executive/2" },
    exactOwnership: true,
    originalRisk: 100,
    grossR: netR + costR,
    costR,
    netR,
    costKnownComplete: true,
    policyLineageMatches: true,
    resolved: true,
    intrabarAmbiguous: false,
    decisionTimeMs: overrides.closedTimeMs - 500,
    openedTimeMs: overrides.closedTimeMs - 200,
    closedTimeMs: overrides.closedTimeMs,
    ...overrides,
  };
}

/** A steady, moderately positive daily series (with a handful of realistic losing days, so
 *  profitFactor is a large finite ratio rather than Infinity) — long enough to qualify
 *  PROVEN_POSITIVE end-to-end. */
function provenPositiveSeries(days: number, startDayMs: number): FourBrainEconomicExperience[] {
  return Array.from({ length: days }, (_, i) =>
    experience({ netR: i % 7 === 0 ? -0.04 : i % 3 === 0 ? 0.06 : 0.05, closedTimeMs: startDayMs + i * DAY_MS }));
}

describe("Four-Brain shadow learning lane report", () => {
  it("aggregates effectiveN, class counts, and completeness rates from eligible experiences", () => {
    const experiences = [
      experience({ netR: 0.05, closedTimeMs: 1_000 }),
      experience({ netR: -0.05, closedTimeMs: 2_000 }),
      experience({ netR: 0.01, closedTimeMs: 3_000 }),
    ];
    const report = buildFourBrainShadowLaneReport("ENTRY", "CG_WIDE_FAST_LONG", experiences, ZERO_REJECTED, null);
    expect(report.effectiveN).toBe(3);
    expect(report.positiveCount).toBe(1);
    expect(report.negativeCount).toBe(1);
    expect(report.neutralCount).toBe(1);
    expect(report.costCompletenessRate).toBe(1);
    expect(report.lineageCompletenessRate).toBe(1);
    expect(report.riskViolationCount).toBe(0);
  });

  it("deduplicates effectiveN by distinct outcomeId even if a duplicate row were ever passed in", () => {
    const one = experience({ netR: 0.05, closedTimeMs: 1_000, outcomeId: "same-outcome" });
    const duplicate = experience({ netR: 0.05, closedTimeMs: 1_000, outcomeId: "same-outcome" });
    const report = buildFourBrainShadowLaneReport("ENTRY", "CG_WIDE_FAST_LONG", [one, duplicate], ZERO_REJECTED, null);
    expect(report.effectiveN).toBe(1);
  });

  it("reflects rejection counts into completeness rates rather than only measuring the survivors", () => {
    const experiences = [experience({ netR: 0.05, closedTimeMs: 1_000 })];
    const rejected = { ...ZERO_REJECTED, INCOMPLETE_COST: 1, MISSING_IMMUTABLE_RISK: 2 };
    const report = buildFourBrainShadowLaneReport("ENTRY", "CG_WIDE_FAST_LONG", experiences, rejected, null);
    expect(report.costCompletenessRate).toBeCloseTo(1 / 2, 9); // 1 eligible / (1 eligible + 1 cost rejection)
    expect(report.riskViolationCount).toBe(2);
  });

  it("never reaches PROVEN_POSITIVE without windows supplied (no true OOS Sharpe available)", () => {
    const experiences = provenPositiveSeries(40, 0);
    const report = buildFourBrainShadowLaneReport("ENTRY", "CG_WIDE_FAST_LONG", experiences, ZERO_REJECTED, null);
    expect(report.trueOutOfSampleSharpe).toBeNull();
    expect(report.evidenceStatus).not.toBe("PROVEN_POSITIVE");
    expect(report.rawSharpe).not.toBeNull(); // raw is still reported, just never substituted as OOS
  });

  it("reaches PROVEN_POSITIVE end-to-end once effectiveN, conservative netR, true OOS Sharpe, and profit factor all qualify", () => {
    const experiences = provenPositiveSeries(80, 0);
    const windows: FourBrainOOSWindows = {
      trainingWindow: { startMs: 0, endMs: 40 * DAY_MS },
      evaluationWindow: { startMs: 40 * DAY_MS, endMs: 80 * DAY_MS },
    };
    const report = buildFourBrainShadowLaneReport("ENTRY", "CG_WIDE_FAST_LONG", experiences, ZERO_REJECTED, windows);
    expect(report.trueOutOfSampleSharpe).not.toBeNull();
    expect(report.evidenceStatus).toBe("PROVEN_POSITIVE");
  });

  it("Exit always reports EVALUATION_ONLY — no adapter path exists to build real experiences", () => {
    const report = fourBrainEvaluationOnlyReport("EXIT", "CG_WIDE_FAST_LONG");
    expect(report.evidenceStatus).toBe("EVALUATION_ONLY");
    expect(report.effectiveN).toBe(0);
  });
});

describe("Four-Brain incumbent vs challenger comparison", () => {
  const windowsFor = (days: number): FourBrainOOSWindows => ({
    trainingWindow: { startMs: 0, endMs: Math.floor(days / 2) * DAY_MS },
    evaluationWindow: { startMs: Math.floor(days / 2) * DAY_MS, endMs: days * DAY_MS },
  });

  it("blocks the comparison when it would mix two different Four-Brain schema/policy cohorts", () => {
    const incumbent = provenPositiveSeries(80, 0);
    const challenger = [
      ...provenPositiveSeries(79, 0),
      experience({ netR: 0.05, closedTimeMs: 79 * DAY_MS, fourBrainCodeVersion: "executive/3" }),
    ];
    const result = compareFourBrainIncumbentVsChallenger({
      cohortLabel: "test-cohort",
      incumbentLaneId: "INCUMBENT",
      challengerLaneId: "CHALLENGER",
      incumbentExperiences: incumbent,
      challengerExperiences: challenger,
      incumbentWindows: windowsFor(80),
      challengerWindows: windowsFor(80),
    });
    expect(result.improvementVerdict).toBe("INVALID_COMPARISON");
  });

  it("blocks the comparison when OOS is unavailable on either side, never falling back to raw Sharpe", () => {
    const incumbent = provenPositiveSeries(80, 0);
    const challenger = provenPositiveSeries(5, 0); // too few days for the hardened evaluator
    const result = compareFourBrainIncumbentVsChallenger({
      cohortLabel: "test-cohort",
      incumbentLaneId: "INCUMBENT",
      challengerLaneId: "CHALLENGER",
      incumbentExperiences: incumbent,
      challengerExperiences: challenger,
      incumbentWindows: windowsFor(80),
      challengerWindows: windowsFor(5),
    });
    expect(result.improvementVerdict).toBe("INVALID_COMPARISON");
  });

  it("blocks (RISK_REGRESSION) when the challenger's drawdown or expected shortfall is worse, even if its mean netR is higher", () => {
    const incumbent = provenPositiveSeries(80, 0);
    const wildChallenger = Array.from({ length: 80 }, (_, i) =>
      experience({ netR: i % 2 === 0 ? 0.4 : -0.35, closedTimeMs: i * DAY_MS }));
    const result = compareFourBrainIncumbentVsChallenger({
      cohortLabel: "test-cohort",
      incumbentLaneId: "INCUMBENT",
      challengerLaneId: "CHALLENGER",
      incumbentExperiences: incumbent,
      challengerExperiences: wildChallenger,
      incumbentWindows: windowsFor(80),
      challengerWindows: windowsFor(80),
    });
    expect(result.improvementVerdict).toBe("RISK_REGRESSION");
  });

  it("reports IMPROVED when the challenger is genuinely better on return and OOS Sharpe without a risk regression", () => {
    const incumbent = Array.from({ length: 80 }, (_, i) => experience({ netR: i % 3 === 0 ? 0.02 : 0.01, closedTimeMs: i * DAY_MS }));
    const challenger = Array.from({ length: 80 }, (_, i) => experience({ netR: i % 3 === 0 ? 0.07 : 0.06, closedTimeMs: i * DAY_MS }));
    const result = compareFourBrainIncumbentVsChallenger({
      cohortLabel: "test-cohort",
      incumbentLaneId: "INCUMBENT",
      challengerLaneId: "CHALLENGER",
      incumbentExperiences: incumbent,
      challengerExperiences: challenger,
      incumbentWindows: windowsFor(80),
      challengerWindows: windowsFor(80),
    });
    expect(result.improvementVerdict).toBe("IMPROVED");
  });

  it("never selects a lane or mutates any runtime state — it only returns a verdict value", () => {
    const incumbent = provenPositiveSeries(80, 0);
    const challenger = provenPositiveSeries(80, 0);
    const before = JSON.stringify(incumbent);
    compareFourBrainIncumbentVsChallenger({
      cohortLabel: "test-cohort",
      incumbentLaneId: "INCUMBENT",
      challengerLaneId: "CHALLENGER",
      incumbentExperiences: incumbent,
      challengerExperiences: challenger,
      incumbentWindows: windowsFor(80),
      challengerWindows: windowsFor(80),
    });
    expect(JSON.stringify(incumbent)).toBe(before); // input untouched — pure function
  });
});

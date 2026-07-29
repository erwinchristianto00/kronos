import { describe, expect, it } from "vitest";

import {
  ECONOMIC_HURDLE_R,
  MIN_OOS_EVALUATION_SAMPLE,
  MIN_OOS_TRAINING_SAMPLE,
  aggregateNetRByUtcDay,
  chronologicalDailyMetrics,
  classifyLaneEvidence,
  classifyTradeEconomic,
  evaluateChronologicalOutOfSampleSharpe,
  evaluateHardenedOutOfSampleSharpe,
  evaluateImprovement,
  normalizeEconomicCostR,
  normalizeSignedCostDragR,
  summarizeEconomicReinforcement,
  type DatedNetR,
  type LaneEconomicMetrics,
} from "../src/lib/success-goal-contract.js";

const valid = (netR: number) => ({
  exactOwnership: true, originalRisk: 1, grossR: netR + 0.01, costR: 0.01, netR,
  costKnownComplete: true, policyLineageMatches: true, resolved: true, intrabarAmbiguous: false,
  decisionTimeMs: 1, openedTimeMs: 2, closedTimeMs: 3,
});

describe("canonical economic goal contract", () => {
  it("classifies continuous realized net R without converting neutral or invalid evidence to a loss", () => {
    expect(ECONOMIC_HURDLE_R).toBe(0.03);
    expect(classifyTradeEconomic(valid(0.04))).toBe("POSITIVE");
    expect(classifyTradeEconomic(valid(0.01))).toBe("NEUTRAL");
    expect(classifyTradeEconomic(valid(-0.02))).toBe("NEUTRAL");
    expect(classifyTradeEconomic(valid(-0.04))).toBe("NEGATIVE");
    expect(classifyTradeEconomic({ ...valid(0.5), costKnownComplete: false })).toBe("INVALID");
    expect(classifyTradeEconomic({ ...valid(0.5), intrabarAmbiguous: true })).toBe("INVALID");
  });

  it("preserves negative magnitude in the reward summary", () => {
    const summary = summarizeEconomicReinforcement([valid(-2), valid(-0.04), valid(0.04)]);
    expect(summary.negativeCount).toBe(2);
    expect(summary.sumRewardR).toBeCloseTo(-2, 9);
    expect(summary.downsideRewardR).toBeCloseTo(-1.02, 9);
  });

  it("uses effective independent N and conservative economics for lane readiness", () => {
    expect(classifyLaneEvidence({ effectiveN: 29, conservativeExpectedNetR: 1, outOfSampleSharpe: 2, profitFactor: 2, costCompletenessRate: 1, lineageComplete: true, materialRiskRailViolation: false })).toBe("INSUFFICIENT");
    expect(classifyLaneEvidence({ effectiveN: 30, conservativeExpectedNetR: -0.01, outOfSampleSharpe: 2, profitFactor: 2, costCompletenessRate: 1, lineageComplete: true, materialRiskRailViolation: false })).toBe("PROVEN_NEGATIVE");
    expect(classifyLaneEvidence({ effectiveN: 30, conservativeExpectedNetR: 0.02, outOfSampleSharpe: 2, profitFactor: 2, costCompletenessRate: 1, lineageComplete: true, materialRiskRailViolation: false })).toBe("MIXED_OR_UNSTABLE");
    expect(classifyLaneEvidence({ effectiveN: 30, conservativeExpectedNetR: 0.04, outOfSampleSharpe: 1.1, profitFactor: 1.3, costCompletenessRate: 1, lineageComplete: true, materialRiskRailViolation: false })).toBe("PROVEN_POSITIVE");
    expect(classifyLaneEvidence({ effectiveN: 30, conservativeExpectedNetR: 0.5, outOfSampleSharpe: 2, profitFactor: 2, costCompletenessRate: 0.99, lineageComplete: true, materialRiskRailViolation: false })).toBe("INVALID_EVIDENCE");
  });

  it("computes raw Sharpe from chronological daily returns but never reports it as out-of-sample", () => {
    const daily = chronologicalDailyMetrics([0.1, -0.05, 0.08, -0.02]);
    expect(daily.rawSharpe).not.toBeNull();
    expect(daily.outOfSampleSharpe).toBeNull();
    expect(daily.maxDrawdown).toBeLessThan(0);
    expect(daily.sharpeConfidenceStatus).toBe("SHARPE_CONFIDENCE_UNAVAILABLE");
  });

  it("blocks improvement when the challenger regresses drawdown or expected shortfall", () => {
    const incumbentRaw = chronologicalDailyMetrics([0.1, -0.02, 0.06, 0.02]);
    const challengerRaw = chronologicalDailyMetrics([0.2, -0.3, 0.15, 0.02]);
    // outOfSampleSharpe is supplied here as an equal stand-in on both sides so this test isolates
    // the drawdown/expected-shortfall regression branch; OOS availability has its own tests below.
    const incumbent = { ...incumbentRaw, outOfSampleSharpe: 1 };
    const challenger = { ...challengerRaw, outOfSampleSharpe: 1 };
    expect(evaluateImprovement({ completeLineage: true, effectiveN: 30, incumbent, challenger })).toBe("RISK_REGRESSION");
  });

  describe("canonical cost sign convention", () => {
    it("accepts a positive-magnitude live/Executive-Review outcome unchanged", () => {
      const outcome = valid(0.04); // costR: 0.01, already the canonical magnitude convention
      expect(classifyTradeEconomic(outcome)).toBe("POSITIVE");
      expect(outcome.grossR - outcome.costR).toBeCloseTo(outcome.netR, 9);
    });

    it("normalizes a signed paper cost drag into the canonical magnitude", () => {
      const canonicalCostR = normalizeSignedCostDragR(-0.1);
      expect(canonicalCostR).toBeCloseTo(0.1, 9);
      const outcome = {
        exactOwnership: true, originalRisk: 1, grossR: 1.0, costR: canonicalCostR!, netR: 0.9,
        costKnownComplete: true, policyLineageMatches: true, resolved: true, intrabarAmbiguous: false,
        decisionTimeMs: 1, openedTimeMs: 2, closedTimeMs: 3,
      };
      expect(classifyTradeEconomic(outcome)).toBe("POSITIVE");
    });

    it("rejects a double-negated (positive) signed-drag cost", () => {
      expect(normalizeSignedCostDragR(0.1)).toBeNull();
      expect(normalizeEconomicCostR({ costConvention: "SIGNED_DRAG", costValue: 0.1 })).toBeNull();
    });

    it("rejects a negative canonical cost even when it is arithmetically self-consistent", () => {
      expect(normalizeEconomicCostR({ costConvention: "CANONICAL_MAGNITUDE", costValue: -0.1 })).toBeNull();
      // 0.8 - (-0.10) = 0.9 is internally consistent, but a negative canonical costR is the exact
      // implicit-sign bug this contract must refuse rather than accept because the sum checks out.
      const outcome = { ...valid(0.9), grossR: 0.8, costR: -0.1, netR: 0.9 };
      expect(classifyTradeEconomic(outcome)).toBe("INVALID");
    });

    it("rejects an arithmetic mismatch between gross, cost, and net", () => {
      const outcome = { ...valid(0.9), grossR: 1.0, costR: 0.05, netR: 0.9 }; // 1.0 - 0.05 = 0.95, not 0.9
      expect(classifyTradeEconomic(outcome)).toBe("INVALID");
    });

    it("preserves the reward magnitude after normalizing a signed cost", () => {
      const direct = {
        exactOwnership: true, originalRisk: 1, grossR: 1.0, costR: 0.1, netR: 0.9,
        costKnownComplete: true, policyLineageMatches: true, resolved: true, intrabarAmbiguous: false,
        decisionTimeMs: 1, openedTimeMs: 2, closedTimeMs: 3,
      };
      const viaAdapter = { ...direct, costR: normalizeSignedCostDragR(-0.1)! };
      expect(viaAdapter.costR).toBeCloseTo(direct.costR, 9);
      expect(classifyTradeEconomic(viaAdapter)).toBe(classifyTradeEconomic(direct));
      expect(direct.grossR - viaAdapter.costR).toBeCloseTo(direct.netR, 9);
    });

    it("fails closed on an unrecognized cost convention rather than guessing its sign", () => {
      expect(normalizeEconomicCostR({ costConvention: "SOME_FUTURE_STORE_TAG", costValue: 0.1 })).toBeNull();
      const outcome = { ...valid(0.9), costR: normalizeEconomicCostR({ costConvention: "SOME_FUTURE_STORE_TAG", costValue: 0.1 }) };
      expect(classifyTradeEconomic(outcome)).toBe("INVALID");
    });
  });

  describe("honest out-of-sample Sharpe", () => {
    const DAY_MS = 86_400_000;
    const TRAINING_DAYS = 40;
    const EVAL_DAYS = 40;
    // Wild training swings: if these ever leaked into the OOS number, it would move sharply.
    const trainingReturns = Array.from({ length: TRAINING_DAYS }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    // Calm, steadily positive evaluation window.
    const evaluationReturns = Array.from({ length: EVAL_DAYS }, (_, i) => (i % 3 === 0 ? 0.02 : 0.01));
    const trainingWindow = { startMs: 0, endMs: TRAINING_DAYS * DAY_MS };
    const evaluationWindow = { startMs: TRAINING_DAYS * DAY_MS, endMs: (TRAINING_DAYS + EVAL_DAYS) * DAY_MS };
    const buildSeries = (training: readonly number[], evaluation: readonly number[]): DatedNetR[] => [
      ...training.map((netR, i) => ({ atMs: i * DAY_MS, netR })),
      ...evaluation.map((netR, i) => ({ atMs: (TRAINING_DAYS + i) * DAY_MS, netR })),
    ];

    it("never lets the raw full-sample metric auto-populate OOS Sharpe", () => {
      const daily = chronologicalDailyMetrics([...trainingReturns, ...evaluationReturns]);
      expect(daily.rawSharpe).not.toBeNull();
      expect(daily.outOfSampleSharpe).toBeNull();
    });

    it("computes chronological holdout Sharpe from only the evaluation window", () => {
      const result = evaluateChronologicalOutOfSampleSharpe(buildSeries(trainingReturns, evaluationReturns), trainingWindow, evaluationWindow);
      expect(result.status).toBe("AVAILABLE");
      expect(result.trainingSampleSize).toBe(TRAINING_DAYS);
      expect(result.evaluationSampleSize).toBe(EVAL_DAYS);
      const mean = evaluationReturns.reduce((sum, value) => sum + value, 0) / evaluationReturns.length;
      const variance = evaluationReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (evaluationReturns.length - 1);
      const expectedSharpe = (mean / Math.sqrt(variance)) * Math.sqrt(365);
      expect(result.outOfSampleSharpe).toBeCloseTo(expectedSharpe, 9);
      // And it must be far from what a full-sample (training+eval) Sharpe would say, proving the
      // wild training swings truly did not leak into the number.
      const rawFullSample = chronologicalDailyMetrics([...trainingReturns, ...evaluationReturns]).rawSharpe!;
      expect(Math.abs(result.outOfSampleSharpe! - rawFullSample)).toBeGreaterThan(0.5);
    });

    it("ignores changes to training-window returns when computing the OOS return series", () => {
      const seriesA = buildSeries(trainingReturns, evaluationReturns);
      const seriesB = buildSeries(trainingReturns.map((value) => value * 100), evaluationReturns);
      const resultA = evaluateChronologicalOutOfSampleSharpe(seriesA, trainingWindow, evaluationWindow);
      const resultB = evaluateChronologicalOutOfSampleSharpe(seriesB, trainingWindow, evaluationWindow);
      expect(resultA.status).toBe("AVAILABLE");
      expect(resultA.outOfSampleSharpe).toBeCloseTo(resultB.outOfSampleSharpe!, 9);
    });

    it("excludes a future return from the training window even when it sits first in the array", () => {
      const sneakyFutureReturn: DatedNetR = { atMs: evaluationWindow.startMs + DAY_MS, netR: 999 };
      const series = [sneakyFutureReturn, ...buildSeries(trainingReturns, evaluationReturns)];
      const result = evaluateChronologicalOutOfSampleSharpe(series, trainingWindow, evaluationWindow);
      expect(result.trainingSampleSize).toBe(TRAINING_DAYS); // membership is by timestamp, not array position
      expect(result.evaluationSampleSize).toBe(EVAL_DAYS + 1); // its timestamp really is inside the evaluation window
    });

    it("refuses to evaluate when the training window does not strictly precede the evaluation window", () => {
      const overlapping = { startMs: evaluationWindow.startMs - DAY_MS, endMs: evaluationWindow.endMs };
      const result = evaluateChronologicalOutOfSampleSharpe(buildSeries(trainingReturns, evaluationReturns), overlapping, evaluationWindow);
      expect(result.status).toBe("INVALID_WINDOWS");
      expect(result.outOfSampleSharpe).toBeNull();
    });

    it("reports an explicit insufficient-sample status rather than a noisy computed number", () => {
      const shortEvaluation = evaluationReturns.slice(0, MIN_OOS_EVALUATION_SAMPLE - 1);
      const shortWindow = { startMs: evaluationWindow.startMs, endMs: evaluationWindow.startMs + shortEvaluation.length * DAY_MS };
      const result = evaluateChronologicalOutOfSampleSharpe(buildSeries(trainingReturns, shortEvaluation), trainingWindow, shortWindow);
      expect(result.status).toBe("INSUFFICIENT_SAMPLE");
      expect(result.outOfSampleSharpe).toBeNull();
      expect(result.evaluationSampleSize).toBe(MIN_OOS_EVALUATION_SAMPLE - 1);
    });

    it("never lets a lane reach PROVEN_POSITIVE without a real out-of-sample Sharpe", () => {
      const metrics: LaneEconomicMetrics = {
        effectiveN: 100, conservativeExpectedNetR: 0.5, outOfSampleSharpe: null, profitFactor: 3,
        costCompletenessRate: 1, lineageComplete: true, materialRiskRailViolation: false,
      };
      expect(classifyLaneEvidence(metrics)).toBe("MIXED_OR_UNSTABLE");
      expect(classifyLaneEvidence(metrics)).not.toBe("PROVEN_POSITIVE");
    });

    it("the improvement gate rejects the comparison rather than falling back to raw Sharpe", () => {
      const incumbent = chronologicalDailyMetrics([0.1, -0.02, 0.06, 0.02]);
      const challenger = chronologicalDailyMetrics([0.2, 0.15, 0.18, 0.12]); // looks better on every raw stat
      expect(incumbent.outOfSampleSharpe).toBeNull();
      expect(challenger.outOfSampleSharpe).toBeNull();
      expect(evaluateImprovement({ completeLineage: true, effectiveN: 30, incumbent, challenger })).toBe("INVALID_COMPARISON");
    });
  });

  describe("hardened daily out-of-sample Sharpe (Four-Brain qualification)", () => {
    const DAY_MS = 86_400_000;
    const TRAINING_DAYS = 40;
    const EVAL_DAYS = 40;
    const trainingReturns = Array.from({ length: TRAINING_DAYS }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    const evaluationReturns = Array.from({ length: EVAL_DAYS }, (_, i) => (i % 3 === 0 ? 0.02 : 0.01));
    const trainingWindow = { startMs: 0, endMs: TRAINING_DAYS * DAY_MS };
    const evaluationWindow = { startMs: TRAINING_DAYS * DAY_MS, endMs: (TRAINING_DAYS + EVAL_DAYS) * DAY_MS };
    const buildSeries = (training: readonly number[], evaluation: readonly number[]): DatedNetR[] => [
      ...training.map((netR, i) => ({ atMs: i * DAY_MS, netR })),
      ...evaluation.map((netR, i) => ({ atMs: (TRAINING_DAYS + i) * DAY_MS, netR })),
    ];

    it("deterministically sums duplicate same-UTC-day observations into one row", () => {
      const series: DatedNetR[] = [
        { atMs: 1_000, netR: 0.02 },
        { atMs: 40_000, netR: 0.01 },
        { atMs: 80_000, netR: -0.005 },
        { atMs: DAY_MS + 1_000, netR: 0.03 },
      ];
      const daily = aggregateNetRByUtcDay(series);
      expect(daily).toHaveLength(2);
      expect(daily[0]!.observationCount).toBe(3);
      expect(daily[0]!.netR).toBeCloseTo(0.02 + 0.01 - 0.005, 9);
      expect(daily[1]!.observationCount).toBe(1);
      expect(daily[1]!.netR).toBeCloseTo(0.03, 9);
      // Aggregation is order-independent — shuffled input folds to the same per-day sums.
      const shuffled = aggregateNetRByUtcDay([series[3]!, series[1]!, series[0]!, series[2]!]);
      expect(shuffled).toEqual(daily);
    });

    it("rejects invalid or empty windows (reversed, non-finite, or non-preceding)", () => {
      const series = buildSeries(trainingReturns, evaluationReturns);
      expect(evaluateHardenedOutOfSampleSharpe(series, { startMs: 100, endMs: 50 }, evaluationWindow).status).toBe("INVALID_WINDOWS");
      expect(evaluateHardenedOutOfSampleSharpe(series, { startMs: Number.NaN, endMs: 50 }, evaluationWindow).status).toBe("INVALID_WINDOWS");
      expect(evaluateHardenedOutOfSampleSharpe(series, trainingWindow, { startMs: 10, endMs: 10 }).status).toBe("INVALID_WINDOWS");
      const overlapping = { startMs: evaluationWindow.startMs - DAY_MS, endMs: evaluationWindow.endMs };
      expect(evaluateHardenedOutOfSampleSharpe(series, overlapping, evaluationWindow).status).toBe("INVALID_WINDOWS");
    });

    it("rejects an empty training sample distinctly from an insufficient one", () => {
      const emptyTrainingWindow = { startMs: -DAY_MS, endMs: 0 }; // strictly precedes, but contains nothing
      const result = evaluateHardenedOutOfSampleSharpe(buildSeries(trainingReturns, evaluationReturns), emptyTrainingWindow, evaluationWindow);
      expect(result.status).toBe("INSUFFICIENT_TRAINING_SAMPLE");
      expect(result.trainingDayCount).toBe(0);
      expect(result.outOfSampleSharpe).toBeNull();
    });

    it("distinguishes insufficient training from insufficient evaluation as separate statuses", () => {
      const shortTraining = trainingReturns.slice(0, MIN_OOS_TRAINING_SAMPLE - 1);
      const shortTrainingWindow = { startMs: 0, endMs: shortTraining.length * DAY_MS };
      const gapEvaluationWindow = { startMs: shortTrainingWindow.endMs, endMs: shortTrainingWindow.endMs + EVAL_DAYS * DAY_MS };
      const series = [
        ...shortTraining.map((netR, i) => ({ atMs: i * DAY_MS, netR })),
        ...evaluationReturns.map((netR, i) => ({ atMs: shortTrainingWindow.endMs + i * DAY_MS, netR })),
      ];
      const insufficientTraining = evaluateHardenedOutOfSampleSharpe(series, shortTrainingWindow, gapEvaluationWindow);
      expect(insufficientTraining.status).toBe("INSUFFICIENT_TRAINING_SAMPLE");
      expect(insufficientTraining.trainingDayCount).toBe(shortTraining.length);

      const shortEvaluation = evaluationReturns.slice(0, MIN_OOS_EVALUATION_SAMPLE - 1);
      const shortEvalWindow = { startMs: evaluationWindow.startMs, endMs: evaluationWindow.startMs + shortEvaluation.length * DAY_MS };
      const insufficientEval = evaluateHardenedOutOfSampleSharpe(buildSeries(trainingReturns, shortEvaluation), trainingWindow, shortEvalWindow);
      expect(insufficientEval.status).toBe("INSUFFICIENT_EVALUATION_SAMPLE");
      expect(insufficientEval.trainingDayCount).toBe(TRAINING_DAYS);
      expect(insufficientEval.evaluationDayCount).toBe(shortEvaluation.length);
    });

    it("never substitutes raw full-sample Sharpe when the hardened evaluator is insufficient/unavailable", () => {
      // A single wild trade-level day dominates the raw full-sample Sharpe...
      const wildValues = [...trainingReturns, ...evaluationReturns, 50];
      const rawWithOutlier = chronologicalDailyMetrics(wildValues).rawSharpe!;
      expect(Number.isFinite(rawWithOutlier)).toBe(true);
      // ...but an evaluation window too short for the hardened minimum reports INSUFFICIENT, never that raw number.
      const tooShortEval = evaluationReturns.slice(0, 5);
      const tooShortWindow = { startMs: evaluationWindow.startMs, endMs: evaluationWindow.startMs + tooShortEval.length * DAY_MS };
      const result = evaluateHardenedOutOfSampleSharpe(buildSeries(trainingReturns, tooShortEval), trainingWindow, tooShortWindow);
      expect(result.status).toBe("INSUFFICIENT_EVALUATION_SAMPLE");
      expect(result.outOfSampleSharpe).toBeNull();
      expect(result.outOfSampleSharpe).not.toBe(rawWithOutlier);
    });

    it("computes the hardened OOS Sharpe from daily-aggregated evaluation returns only", () => {
      const result = evaluateHardenedOutOfSampleSharpe(buildSeries(trainingReturns, evaluationReturns), trainingWindow, evaluationWindow);
      expect(result.status).toBe("AVAILABLE");
      expect(result.trainingDayCount).toBe(TRAINING_DAYS);
      expect(result.evaluationDayCount).toBe(EVAL_DAYS);
      const mean = evaluationReturns.reduce((sum, value) => sum + value, 0) / evaluationReturns.length;
      const variance = evaluationReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (evaluationReturns.length - 1);
      expect(result.outOfSampleSharpe).toBeCloseTo((mean / Math.sqrt(variance)) * Math.sqrt(365), 9);
    });

    it("ignores changes to training-window returns when computing the evaluation return series", () => {
      const resultA = evaluateHardenedOutOfSampleSharpe(buildSeries(trainingReturns, evaluationReturns), trainingWindow, evaluationWindow);
      const resultB = evaluateHardenedOutOfSampleSharpe(buildSeries(trainingReturns.map((v) => v * 100), evaluationReturns), trainingWindow, evaluationWindow);
      expect(resultA.status).toBe("AVAILABLE");
      expect(resultA.outOfSampleSharpe).toBeCloseTo(resultB.outOfSampleSharpe!, 9);
    });

    it("excludes a future observation from training purely by its own timestamp", () => {
      // One UTC day beyond the last day evaluationReturns already fills, so the aggregator folds it
      // into a genuinely NEW day row rather than summing into an existing one.
      const widenedEvaluationWindow = { startMs: evaluationWindow.startMs, endMs: evaluationWindow.endMs + DAY_MS };
      const sneakyFutureReturn: DatedNetR = { atMs: evaluationWindow.endMs, netR: 999 };
      const series = [sneakyFutureReturn, ...buildSeries(trainingReturns, evaluationReturns)];
      const result = evaluateHardenedOutOfSampleSharpe(series, trainingWindow, widenedEvaluationWindow);
      expect(result.trainingDayCount).toBe(TRAINING_DAYS); // membership is by timestamp, not array position
      expect(result.evaluationDayCount).toBe(EVAL_DAYS + 1); // its timestamp really is inside the evaluation window
    });
  });
});

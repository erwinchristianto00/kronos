import { describe, expect, it } from "vitest";

import {
  ECONOMIC_HURDLE_R,
  chronologicalDailyMetrics,
  classifyLaneEvidence,
  classifyTradeEconomic,
  evaluateImprovement,
  summarizeEconomicReinforcement,
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

  it("computes Sharpe from chronological daily returns and exposes confidence as unavailable rather than fabricated", () => {
    const daily = chronologicalDailyMetrics([0.1, -0.05, 0.08, -0.02]);
    expect(daily.outOfSampleSharpe).not.toBeNull();
    expect(daily.maxDrawdown).toBeLessThan(0);
    expect(daily.sharpeConfidenceStatus).toBe("SHARPE_CONFIDENCE_UNAVAILABLE");
  });

  it("blocks improvement when the challenger regresses drawdown or expected shortfall", () => {
    const incumbent = chronologicalDailyMetrics([0.1, -0.02, 0.06, 0.02]);
    const challenger = chronologicalDailyMetrics([0.2, -0.3, 0.15, 0.02]);
    expect(evaluateImprovement({ completeLineage: true, effectiveN: 30, incumbent, challenger })).toBe("RISK_REGRESSION");
  });
});

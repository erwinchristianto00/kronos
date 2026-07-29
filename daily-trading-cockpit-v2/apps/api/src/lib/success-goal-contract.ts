/**
 * Canonical, authority-free economic goal contract shared by CORTEX and the
 * Four-Brain. It classifies evidence and reports readiness; it never changes
 * an order, allocation, promotion, or beta by itself.
 */
export const GOAL_CONTRACT_VERSION = "kronos-economic-goal/1";
export const ECONOMIC_HURDLE_R = 0.03;
export const MIN_EFFECTIVE_INDEPENDENT_N = 30;
const EPSILON = 1e-9;

export type TradeEconomicClass = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "INVALID" | "UNRESOLVED";
export type LaneEvidenceState = "INSUFFICIENT" | "PROVEN_POSITIVE" | "PROVEN_NEGATIVE" | "MIXED_OR_UNSTABLE" | "INVALID_EVIDENCE";
export type ImprovementVerdict = "IMPROVED" | "NOT_IMPROVED" | "RISK_REGRESSION" | "INSUFFICIENT_EVIDENCE" | "INVALID_COMPARISON";

export interface EconomicOutcomeInput {
  exactOwnership: boolean;
  originalRisk: number | null;
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  costKnownComplete: boolean;
  policyLineageMatches: boolean;
  resolved: boolean;
  intrabarAmbiguous: boolean;
  decisionTimeMs: number | null;
  openedTimeMs: number | null;
  closedTimeMs: number | null;
}

export interface EconomicReinforcementSummary {
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  invalidCount: number;
  unresolvedCount: number;
  sumRewardR: number;
  averageRewardR: number | null;
  downsideRewardR: number | null;
  conservativeExpectedNetR: number | null;
}

export interface LaneEconomicMetrics {
  effectiveN: number;
  conservativeExpectedNetR: number | null;
  outOfSampleSharpe: number | null;
  profitFactor: number | null;
  costCompletenessRate: number | null;
  lineageComplete: boolean;
  materialRiskRailViolation: boolean;
}

export interface ChronologicalDailyMetrics {
  rawSharpe: number | null;
  outOfSampleSharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  profitFactor: number | null;
  expectedShortfall: number | null;
  meanNetR: number | null;
  medianNetR: number | null;
  sharpeConfidenceStatus: "SHARPE_CONFIDENCE_UNAVAILABLE";
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function classifyTradeEconomic(input: EconomicOutcomeInput): TradeEconomicClass {
  if (!input.resolved) return "UNRESOLVED";
  if (
    !input.exactOwnership || !input.costKnownComplete || !input.policyLineageMatches || input.intrabarAmbiguous ||
    !finite(input.originalRisk) || input.originalRisk <= 0 || !finite(input.grossR) || !finite(input.costR) || !finite(input.netR) ||
    !finite(input.decisionTimeMs) || !finite(input.openedTimeMs) || !finite(input.closedTimeMs) ||
    input.decisionTimeMs > input.openedTimeMs || input.closedTimeMs < input.openedTimeMs ||
    Math.abs((input.grossR - input.costR) - input.netR) > EPSILON
  ) return "INVALID";
  if (input.netR > ECONOMIC_HURDLE_R) return "POSITIVE";
  if (input.netR < -ECONOMIC_HURDLE_R) return "NEGATIVE";
  return "NEUTRAL";
}

export function summarizeEconomicReinforcement(inputs: readonly EconomicOutcomeInput[]): EconomicReinforcementSummary {
  let positiveCount = 0; let neutralCount = 0; let negativeCount = 0; let invalidCount = 0; let unresolvedCount = 0;
  const rewards: number[] = [];
  for (const input of inputs) {
    const classification = classifyTradeEconomic(input);
    if (classification === "POSITIVE") { positiveCount += 1; rewards.push(input.netR!); }
    else if (classification === "NEUTRAL") { neutralCount += 1; rewards.push(input.netR!); }
    else if (classification === "NEGATIVE") { negativeCount += 1; rewards.push(input.netR!); }
    else if (classification === "INVALID") invalidCount += 1;
    else unresolvedCount += 1;
  }
  const sumRewardR = rewards.reduce((sum, value) => sum + value, 0);
  const downside = rewards.filter((value) => value < 0);
  const mean = rewards.length > 0 ? sumRewardR / rewards.length : null;
  const variance = mean === null || rewards.length < 2 ? null : rewards.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (rewards.length - 1);
  const conservativeExpectedNetR = mean === null || variance === null ? null : mean - 1.96 * Math.sqrt(variance / rewards.length);
  return {
    positiveCount, neutralCount, negativeCount, invalidCount, unresolvedCount, sumRewardR,
    averageRewardR: mean,
    downsideRewardR: downside.length ? downside.reduce((sum, value) => sum + value, 0) / downside.length : null,
    conservativeExpectedNetR,
  };
}

export function classifyLaneEvidence(metrics: LaneEconomicMetrics): LaneEvidenceState {
  if (!metrics.lineageComplete || metrics.costCompletenessRate !== 1 || metrics.materialRiskRailViolation) return "INVALID_EVIDENCE";
  if (!finite(metrics.effectiveN) || metrics.effectiveN < MIN_EFFECTIVE_INDEPENDENT_N) return "INSUFFICIENT";
  if (!finite(metrics.conservativeExpectedNetR) || !finite(metrics.outOfSampleSharpe) || !finite(metrics.profitFactor)) return "MIXED_OR_UNSTABLE";
  if (metrics.conservativeExpectedNetR > ECONOMIC_HURDLE_R && metrics.outOfSampleSharpe >= 1 && metrics.profitFactor > 1.2) return "PROVEN_POSITIVE";
  if (metrics.conservativeExpectedNetR <= 0 || metrics.outOfSampleSharpe <= 0 || metrics.profitFactor <= 1) return "PROVEN_NEGATIVE";
  return "MIXED_OR_UNSTABLE";
}

export function chronologicalDailyMetrics(dailyNetR: readonly number[]): ChronologicalDailyMetrics {
  const values = dailyNetR.filter(finite);
  if (values.length === 0) return { rawSharpe: null, outOfSampleSharpe: null, sortino: null, maxDrawdown: null, profitFactor: null, expectedShortfall: null, meanNetR: null, medianNetR: null, sharpeConfidenceStatus: "SHARPE_CONFIDENCE_UNAVAILABLE" };
  const meanNetR = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - meanNetR) ** 2, 0) / (values.length - 1) : 0;
  const rawSharpe = variance > 0 ? meanNetR / Math.sqrt(variance) * Math.sqrt(365) : null;
  const downside = values.filter((value) => value < 0);
  const downsideDeviation = downside.length > 1 ? Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length) : null;
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const value of values) { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity - peak); }
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const sorted = [...values].sort((left, right) => left - right);
  const tailCount = Math.max(1, Math.ceil(sorted.length * 0.05));
  return {
    rawSharpe, outOfSampleSharpe: rawSharpe,
    sortino: downsideDeviation && downsideDeviation > 0 ? meanNetR / downsideDeviation * Math.sqrt(365) : null,
    maxDrawdown,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Number.POSITIVE_INFINITY : null,
    expectedShortfall: sorted.slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount,
    meanNetR,
    medianNetR: sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2,
    sharpeConfidenceStatus: "SHARPE_CONFIDENCE_UNAVAILABLE",
  };
}

export function evaluateImprovement(input: {
  completeLineage: boolean;
  effectiveN: number;
  challenger: Pick<ChronologicalDailyMetrics, "meanNetR" | "outOfSampleSharpe" | "maxDrawdown" | "expectedShortfall">;
  incumbent: Pick<ChronologicalDailyMetrics, "meanNetR" | "outOfSampleSharpe" | "maxDrawdown" | "expectedShortfall">;
}): ImprovementVerdict {
  if (!input.completeLineage || !finite(input.challenger.meanNetR) || !finite(input.incumbent.meanNetR) || !finite(input.challenger.outOfSampleSharpe) || !finite(input.incumbent.outOfSampleSharpe) || !finite(input.challenger.maxDrawdown) || !finite(input.incumbent.maxDrawdown) || !finite(input.challenger.expectedShortfall) || !finite(input.incumbent.expectedShortfall)) return "INVALID_COMPARISON";
  if (input.effectiveN < MIN_EFFECTIVE_INDEPENDENT_N) return "INSUFFICIENT_EVIDENCE";
  if (input.challenger.maxDrawdown < input.incumbent.maxDrawdown || input.challenger.expectedShortfall < input.incumbent.expectedShortfall) return "RISK_REGRESSION";
  return input.challenger.meanNetR > input.incumbent.meanNetR && input.challenger.outOfSampleSharpe >= input.incumbent.outOfSampleSharpe ? "IMPROVED" : "NOT_IMPROVED";
}

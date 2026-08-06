import type { TournamentMetrics, TournamentRunResult, TournamentStrategyId } from "../tournament-types.js";

export interface OosWindowObservation {
  foldId: string;
  inSampleExpectancyAfterCost: number;
  result: TournamentRunResult;
}

export interface OosSummary {
  windowCount: number;
  validWindowCount: number;
  profitableWindowRatio: number | null;
  meanInSampleExpectancyAfterCost: number | null;
  meanOosExpectancyAfterCost: number | null;
  /** OOS minus in-sample. Negative values are performance degradation. */
  oosExpectancyDegradation: number | null;
}

export interface CostSensitivityFinding {
  strategyId: TournamentStrategyId;
  comparable: boolean;
  expectedExpectancyAfterCost: number | null;
  conservativeExpectancyAfterCost: number | null;
  conservativeMinusExpected: number | null;
  statement: string;
}

export function summarizeOosWindows(observations: readonly OosWindowObservation[]): OosSummary {
  const valid = observations.filter((observation) => observation.result.valid);
  if (valid.length === 0) return { windowCount: observations.length, validWindowCount: 0, profitableWindowRatio: null, meanInSampleExpectancyAfterCost: null, meanOosExpectancyAfterCost: null, oosExpectancyDegradation: null };
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  const inSample = mean(valid.map((observation) => observation.inSampleExpectancyAfterCost));
  const oos = mean(valid.map((observation) => observation.result.strategyMetrics.expectancyAfterCost));
  return {
    windowCount: observations.length,
    validWindowCount: valid.length,
    profitableWindowRatio: valid.filter((observation) => observation.result.strategyMetrics.netPnl > 0).length / valid.length,
    meanInSampleExpectancyAfterCost: inSample,
    meanOosExpectancyAfterCost: oos,
    oosExpectancyDegradation: oos - inSample,
  };
}

/** Expected and Conservative are paired only when both executions actually produced valid ledgers. */
export function assessCostSensitivity(runs: readonly TournamentRunResult[]): CostSensitivityFinding[] {
  const byStrategy = new Map<TournamentStrategyId, Map<string, TournamentRunResult>>();
  for (const run of runs) byStrategy.set(run.manifest.strategyId, (byStrategy.get(run.manifest.strategyId) ?? new Map()).set(run.manifest.executionMode, run));
  return [...byStrategy.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([strategyId, modes]) => {
    const expected = modes.get("EXPECTED"); const conservative = modes.get("CONSERVATIVE");
    const comparable = Boolean(expected?.valid && conservative?.valid);
    return {
      strategyId,
      comparable,
      expectedExpectancyAfterCost: comparable ? expected!.strategyMetrics.expectancyAfterCost : null,
      conservativeExpectancyAfterCost: comparable ? conservative!.strategyMetrics.expectancyAfterCost : null,
      conservativeMinusExpected: comparable ? conservative!.strategyMetrics.expectancyAfterCost - expected!.strategyMetrics.expectancyAfterCost : null,
      statement: comparable ? "Paired cost/execution sensitivity under the same strategy contract." : "NOT_COMPARABLE: expected or conservative ledger is invalid or missing.",
    };
  });
}

export function metricSummary(metrics: TournamentMetrics): Pick<TournamentMetrics, "expectancyAfterCost" | "profitFactor" | "winRate" | "payoffRatio" | "sharpe" | "calmar" | "maxDrawdown"> {
  return { expectancyAfterCost: metrics.expectancyAfterCost, profitFactor: metrics.profitFactor, winRate: metrics.winRate, payoffRatio: metrics.payoffRatio, sharpe: metrics.sharpe, calmar: metrics.calmar, maxDrawdown: metrics.maxDrawdown };
}

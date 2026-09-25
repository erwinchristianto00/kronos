import type { TournamentMetrics } from "../tournament-types.js";

export interface AblationFinding {
  comparison: string;
  comparable: boolean;
  delta: { expectancyAfterCost: number; netPnl: number; maxDrawdown: number } | null;
  statement: string;
}

/**
 * Attribution is allowed only for paired runs with a separately persisted
 * fairness hash: data, point-in-time universe, execution, costs, risk and
 * portfolio must match while the named intervention is intentionally excluded.
 */
export function pairedAblation(input: {
  comparison: string;
  baselineFairnessHash: string;
  treatmentFairnessHash: string;
  sameDataExecutionRiskAndPortfolio: boolean;
  baseline: TournamentMetrics;
  treatment: TournamentMetrics;
}): AblationFinding {
  const comparable = input.sameDataExecutionRiskAndPortfolio
    && Boolean(input.baselineFairnessHash)
    && input.baselineFairnessHash === input.treatmentFairnessHash;
  if (!comparable) return { comparison: input.comparison, comparable: false, delta: null, statement: "NOT_ISOLATED: data, execution, risk, portfolio, or manifest differs." };
  return {
    comparison: input.comparison,
    comparable: true,
    delta: {
      expectancyAfterCost: input.treatment.expectancyAfterCost - input.baseline.expectancyAfterCost,
      netPnl: input.treatment.netPnl - input.baseline.netPnl,
      maxDrawdown: input.treatment.maxDrawdown - input.baseline.maxDrawdown,
    },
    statement: "Paired intervention delta only; it does not attribute other coupled Kronos layers.",
  };
}

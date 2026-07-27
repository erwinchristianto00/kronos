/**
 * Forward-only CORTEX learning epoch. Historical artifacts stay on disk for audit, but only
 * decisions and positions opened on/after this boundary may train or promote the current model.
 */
export const CORTEX_LEARNING_EPOCH_ENV = "CORTEX_LEARNING_EPOCH_START_ISO";

export interface CortexLearningEpoch {
  id: "POST_LINEAGE_V2";
  startIso: string;
  startMs: number;
}

export function cortexLearningEpoch(
  env: NodeJS.ProcessEnv = process.env,
): CortexLearningEpoch | null {
  const raw = (env[CORTEX_LEARNING_EPOCH_ENV] ?? "").trim();
  if (!raw) return null;
  const startMs = Date.parse(raw);
  if (!Number.isFinite(startMs)) return null;
  return {
    id: "POST_LINEAGE_V2",
    startIso: new Date(startMs).toISOString(),
    startMs,
  };
}

export function filterCortexLearningEpochRows<
  TDecision extends { atMs: number },
  TOutcome extends { openedAtMs: number; resolvedAtMs: number },
>(
  decisions: TDecision[],
  outcomes: TOutcome[],
  epoch: CortexLearningEpoch | null,
): {
  decisions: TDecision[];
  outcomes: TOutcome[];
  decisionRowsExcluded: number;
  transitionalOutcomesExcluded: number;
} {
  if (!epoch) {
    return {
      decisions,
      outcomes,
      decisionRowsExcluded: 0,
      transitionalOutcomesExcluded: 0,
    };
  }
  const eligibleDecisions = decisions.filter((row) => row.atMs >= epoch.startMs);
  const eligibleOutcomes = outcomes.filter(
    (outcome) =>
      outcome.openedAtMs >= epoch.startMs
      && outcome.resolvedAtMs >= epoch.startMs,
  );
  return {
    decisions: eligibleDecisions,
    outcomes: eligibleOutcomes,
    decisionRowsExcluded: decisions.length - eligibleDecisions.length,
    transitionalOutcomesExcluded: outcomes.length - eligibleOutcomes.length,
  };
}

import type { TournamentValidationSpec } from "../tournament-types.js";

export interface WalkForwardFold {
  foldId: string;
  train: { startIndex: number; endExclusive: number };
  purge: { startIndex: number; endExclusive: number };
  test: { startIndex: number; endExclusive: number };
  embargo: { startIndex: number; endExclusive: number };
}

export interface TournamentValidationPlan {
  folds: WalkForwardFold[];
  sealedHoldout: { startIndex: number; endExclusive: number };
}

/**
 * Generates chronological walk-forward folds.  No fold may train on a bar inside
 * its purge/embargo zone or at/after the sealed holdout boundary.
 */
export function buildWalkForwardPlan(timestamps: readonly number[], spec: TournamentValidationSpec): TournamentValidationPlan {
  if (timestamps.length === 0) throw new Error("TOURNAMENT_VALIDATION_NO_TIMESTAMPS");
  if (timestamps.some((time, index) => index > 0 && time <= timestamps[index - 1]!)) throw new Error("TOURNAMENT_VALIDATION_TIMESTAMPS_NOT_STRICTLY_MONOTONIC");
  const holdoutStart = timestamps.findIndex((timestamp) => timestamp >= spec.sealedHoldoutStartMs);
  if (holdoutStart < 0) throw new Error("TOURNAMENT_SEALED_HOLDOUT_OUTSIDE_DATASET");
  const folds: WalkForwardFold[] = [];
  for (let trainStart = 0, ordinal = 0; ; trainStart += spec.stepBars, ordinal += 1) {
    const trainEnd = trainStart + spec.trainBars;
    const purgeEnd = trainEnd + spec.purgeBars;
    const testEnd = purgeEnd + spec.testBars;
    const embargoEnd = testEnd + spec.embargoBars;
    if (testEnd > holdoutStart) break;
    folds.push({ foldId: `wf-${ordinal + 1}`, train: { startIndex: trainStart, endExclusive: trainEnd }, purge: { startIndex: trainEnd, endExclusive: purgeEnd }, test: { startIndex: purgeEnd, endExclusive: testEnd }, embargo: { startIndex: testEnd, endExclusive: embargoEnd } });
    if (trainStart + spec.stepBars >= holdoutStart || embargoEnd >= holdoutStart) break;
  }
  if (folds.length === 0) throw new Error("TOURNAMENT_WALK_FORWARD_NO_COMPLETE_FOLD");
  return { folds, sealedHoldout: { startIndex: holdoutStart, endExclusive: timestamps.length } };
}

export function assertNoValidationLeakage(plan: TournamentValidationPlan): void {
  for (const fold of plan.folds) {
    if (fold.train.endExclusive > fold.purge.startIndex || fold.purge.endExclusive > fold.test.startIndex || fold.test.endExclusive > fold.embargo.startIndex) {
      throw new Error(`TOURNAMENT_VALIDATION_OVERLAP_${fold.foldId}`);
    }
    if (fold.test.endExclusive > plan.sealedHoldout.startIndex || fold.train.endExclusive > plan.sealedHoldout.startIndex) {
      throw new Error(`TOURNAMENT_SEALED_HOLDOUT_LEAK_${fold.foldId}`);
    }
  }
}

export function cartesianParameterGrid(grid: Readonly<Record<string, readonly (string | number | boolean)[]>>): Record<string, string | number | boolean>[] {
  const entries = Object.entries(grid).sort(([a], [b]) => a.localeCompare(b));
  if (entries.some(([, values]) => values.length === 0)) throw new Error("TOURNAMENT_PARAMETER_GRID_EMPTY_AXIS");
  return entries.reduce<Record<string, string | number | boolean>[]>((sets, [key, values]) =>
    sets.flatMap((set) => values.map((value) => ({ ...set, [key]: value }))), [{}]);
}

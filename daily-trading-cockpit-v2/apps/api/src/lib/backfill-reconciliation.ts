/**
 * Historical backfill — reconciliation funnel (Phase 9 / requirement #9). Every raw row is accounted for
 * across raw → eligible → attributed → training-valid → rejected, with a reason for each drop. The funnel is
 * arithmetic-checked (`reconciles`): a row can never vanish silently. Pure.
 */
import type { TrainingClass } from "./backfill-schema.js";

export interface FunnelInput {
  rawRows: number;
  /** raw → eligible drops: rows that failed to normalize into a valid outcome/decision. */
  parseDrops: Record<string, number>;
  /** eligible → attributed drops (from the attribution matcher). */
  attributionDrops: Record<string, number>;
  /** class tally over the ATTRIBUTED rows. */
  attributedClassCounts: Record<TrainingClass, number>;
}

export interface ReconciliationFunnel {
  rawRows: number;
  eligible: number;
  attributed: number;
  trainingValid: number;
  replayOnly: number;
  rejected: number;
  rejectionReasons: Record<string, number>;
  stages: Array<{ stage: string; count: number }>;
  /** True iff every arithmetic identity holds (no row lost). */
  reconciles: boolean;
  discrepancies: string[];
}

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, v) => a + v, 0);

export function buildReconciliation(i: FunnelInput): ReconciliationFunnel {
  const parseDropTotal = sum(i.parseDrops);
  const eligible = i.rawRows - parseDropTotal;
  const attrDropTotal = sum(i.attributionDrops);
  const attributed = eligible - attrDropTotal;
  const c = i.attributedClassCounts;
  const trainingValid = c.VALID_FOR_TRAINING;
  const replayOnly = c.VALID_FOR_REPLAY_ONLY;
  const rejected = i.rawRows - trainingValid;

  // Aggregate every rejection reason (parse + attribution + non-training classes) so they sum to `rejected`.
  const rejectionReasons: Record<string, number> = {};
  for (const [k, v] of Object.entries(i.parseDrops)) rejectionReasons[`parse:${k}`] = v;
  for (const [k, v] of Object.entries(i.attributionDrops)) rejectionReasons[`attribution:${k}`] = v;
  rejectionReasons["class:MISSING_FEATURES"] = c.MISSING_FEATURES;
  rejectionReasons["class:LABEL_UNSAFE"] = c.LABEL_UNSAFE;
  rejectionReasons["class:SCHEMA_MISMATCH"] = c.SCHEMA_MISMATCH;
  rejectionReasons["class:VALID_FOR_REPLAY_ONLY"] = c.VALID_FOR_REPLAY_ONLY;

  const attributedClassTotal = trainingValid + replayOnly + c.MISSING_FEATURES + c.LABEL_UNSAFE + c.SCHEMA_MISMATCH;
  const discrepancies: string[] = [];
  if (attributed !== attributedClassTotal) discrepancies.push(`attributed(${attributed}) !== Σ classCounts(${attributedClassTotal})`);
  if (sum(rejectionReasons) !== rejected) discrepancies.push(`Σ rejectionReasons(${sum(rejectionReasons)}) !== rejected(${rejected})`);
  if (eligible < 0 || attributed < 0) discrepancies.push("negative stage count (input drops exceed inputs)");

  return {
    rawRows: i.rawRows,
    eligible,
    attributed,
    trainingValid,
    replayOnly,
    rejected,
    rejectionReasons,
    stages: [
      { stage: "raw", count: i.rawRows },
      { stage: "eligible", count: eligible },
      { stage: "attributed", count: attributed },
      { stage: "training-valid", count: trainingValid },
      { stage: "rejected", count: rejected },
    ],
    reconciles: discrepancies.length === 0,
    discrepancies,
  };
}

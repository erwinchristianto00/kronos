/**
 * Historical backfill — observation classification (Phase 5 / requirement #5). Each historical observation
 * gets EXACTLY ONE verdict, decided in strict precedence so the reconciliation funnel adds up:
 *   SCHEMA_MISMATCH   — a decision existed in-window but only at a stale feature schema (can't train the
 *                       current model on it; not silently dropped).
 *   LABEL_UNSAFE      — the outcome could not be safely labelled (bad/≤0 risk denom, non-finite netR, bad
 *                       timestamps) OR no owning decision was found at all.
 *   MISSING_FEATURES  — safe label + current-schema owner, but the as-of training vector is incomplete (a
 *                       required feature was future-leaked, null, or of unknown provenance).
 *   VALID_FOR_REPLAY_ONLY — sound label + owner + complete vector, but training is deliberately withheld
 *                       (held-out final block, or a source that is replay-only by construction).
 *   VALID_FOR_TRAINING — everything sound.
 * Pure.
 */
import type { TrainingClass } from "./backfill-schema.js";

export interface ClassifyInput {
  /** True ⇒ an owning decision was found at the CURRENT schema. */
  ownerFound: boolean;
  /** True ⇒ the only in-window decision(s) were at a stale schema (owner not found for that reason). */
  schemaMismatchOnly: boolean;
  /** True ⇒ computeOutcomeR returned ok. */
  labelSafe: boolean;
  /** True ⇒ the required as-of training vector was fully reconstructed (projectVector non-null). */
  trainingVectorComplete: boolean;
  /** Caller-set: withhold from training even when everything else is sound (holdout block / replay-only source). */
  replayOnly: boolean;
}

export interface ClassifyResult {
  klass: TrainingClass;
  reason: string;
}

export function classifyObservation(i: ClassifyInput): ClassifyResult {
  // 1. Can we trust the label at all? No owner OR unsafe outcome ⇒ not trainable and not confidently replayable
  //    as a decision. Schema-mismatch is surfaced as its OWN class (it's a "wrong-schema owner", not "no owner").
  if (!i.labelSafe) return { klass: "LABEL_UNSAFE", reason: "outcome label rejected (risk denom / non-finite / timestamps)" };
  if (!i.ownerFound) {
    if (i.schemaMismatchOnly) return { klass: "SCHEMA_MISMATCH", reason: "in-window decision existed only at a stale feature schema" };
    return { klass: "LABEL_UNSAFE", reason: "no owning decision found for the outcome" };
  }
  // 2. Safe label + current-schema owner. Are the training features complete + as-of clean?
  if (!i.trainingVectorComplete) return { klass: "MISSING_FEATURES", reason: "required as-of feature leaked/null/unknown-provenance" };
  // 3. Everything sound — training unless explicitly withheld.
  if (i.replayOnly) return { klass: "VALID_FOR_REPLAY_ONLY", reason: "sound but withheld from training (holdout block / replay-only source)" };
  return { klass: "VALID_FOR_TRAINING", reason: "owner + as-of complete features + safe label" };
}

/** Tally a set of classifications into the reconciliation shape. */
export function tallyClasses(results: Iterable<TrainingClass>): Record<TrainingClass, number> {
  const t: Record<TrainingClass, number> = {
    VALID_FOR_TRAINING: 0, VALID_FOR_REPLAY_ONLY: 0, MISSING_FEATURES: 0, LABEL_UNSAFE: 0, SCHEMA_MISMATCH: 0,
  };
  for (const k of results) t[k] += 1;
  return t;
}

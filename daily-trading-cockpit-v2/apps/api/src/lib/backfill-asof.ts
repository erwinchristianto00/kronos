/**
 * Historical backfill — as-of feature reconstruction (Phase 2 / requirement #2). Reconstruct the feature
 * vector for a decision using ONLY values that were knowable at decisionAt. Any feature whose
 * observedAt/firstSeenAt is AFTER decisionAt is REJECTED (look-ahead leakage) — it is dropped from the
 * reconstructed vector and recorded as a rejection reason, never silently kept. A feature with unknown
 * provenance (observedAtMs null) is also rejected: we cannot prove it was as-of, so we refuse to assume it.
 * Pure + deterministic.
 */
import type { AsOfFeature } from "./backfill-schema.js";

export interface AsOfReconstruction {
  /** Feature key → value, only for features proven knowable at/before decisionAt. */
  present: Record<string, number>;
  /** Keys dropped because observedAt > decisionAt (future leak) — with the offending observedAt. */
  futureLeak: Array<{ key: string; observedAtMs: number }>;
  /** Keys dropped because provenance is unknown (observedAtMs null) or the value itself is null. */
  unknownProvenance: string[];
  nullValue: string[];
}

/**
 * Reconstruct as-of. `skewToleranceMs` (default 0) allows a small clock-skew grace so a feature observed a
 * few ms "after" the decision (same tick, jitter) is not wrongly rejected — keep it TINY; the default is
 * strict-zero. Never let it exceed a single decision cadence.
 */
export function reconstructAsOf(features: AsOfFeature[], decisionAtMs: number, skewToleranceMs = 0): AsOfReconstruction {
  const present: Record<string, number> = {};
  const futureLeak: Array<{ key: string; observedAtMs: number }> = [];
  const unknownProvenance: string[] = [];
  const nullValue: string[] = [];
  const cutoff = decisionAtMs + Math.max(0, skewToleranceMs);

  for (const f of features) {
    if (f.observedAtMs == null || !Number.isFinite(f.observedAtMs)) {
      unknownProvenance.push(f.key); // cannot prove as-of ⇒ refuse (do not assume it was knowable)
      continue;
    }
    if (f.observedAtMs > cutoff) {
      futureLeak.push({ key: f.key, observedAtMs: f.observedAtMs }); // look-ahead ⇒ reject
      continue;
    }
    if (f.value == null || !Number.isFinite(f.value)) {
      nullValue.push(f.key); // knowable-in-time but no value ⇒ MISSING (not fabricated to 0)
      continue;
    }
    // Last write within the window wins for a repeated key (features are pre-ordered by the caller if needed).
    present[f.key] = f.value;
  }
  return { present, futureLeak, unknownProvenance, nullValue };
}

/** Project a reconstruction onto a fixed ordered feature schema. A required key that is not `present`
 *  makes the whole vector unusable for TRAINING (returns null) — the caller then classifies MISSING_FEATURES.
 *  Never fills a gap with 0. */
export function projectVector(recon: AsOfReconstruction, schema: readonly string[]): number[] | null {
  const x: number[] = [];
  for (const k of schema) {
    const v = recon.present[k];
    if (v == null || !Number.isFinite(v)) return null; // a missing required feature ⇒ not trainable
    x.push(v);
  }
  return x;
}

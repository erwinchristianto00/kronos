/**
 * EFFECTIVE-N + CONSERVATIVE-LOWER-BOUND (2026-08-02) — pure, no imports.
 *
 * Two small primitives this repo has reinvented in spirit at least twice already
 * (direction-brain-resolver.ts's horizonBlockKey/computeDirectionEffectiveSampleSize,
 * four-brain-edge-memory.ts's Bucket.blocks Set) and needs again for the six live edge-lane
 * reports (cortex-live-gather-bindings.ts's liveLaneReport()). Extracted here so a THIRD
 * reimplementation doesn't drift from the other two's semantics.
 *
 * WHY effectiveN, not raw n: this repo's own documented failure mode (MEMORY / CLAUDE.md) is
 * several symbols firing off one market-wide regime reading at the same instant — those rows are
 * correlated, not independent observations, and a raw row count inflates the apparent sample size.
 * effectiveN counts DISTINCT (symbol, time-block) pairs instead.
 *
 * WHY a conservative lower bound, not a point estimate: a raw mean netR at small effectiveN can
 * read as "positive edge" purely from variance. A one-sided lower confidence bound is the honest
 * "how bad could this plausibly be", and only a bound that clears the hurdle in the WORST
 * plausible case should ever gate real evidence.
 */

/** Distinct-block count over `items`, keyed by `blockKeyFn`. Never more than `items.length`
 *  (a block key groups items, it cannot invent new ones). */
export function computeEffectiveN<T>(items: readonly T[], blockKeyFn: (item: T) => string | number): number {
  const blocks = new Set<string | number>();
  for (const item of items) blocks.add(blockKeyFn(item));
  return blocks.size;
}

/** One-sided 95% lower confidence bound (z≈1.645) on the mean of `values`, using `effectiveN`
 *  (not `values.length`) as the sample-size denominator in the standard-error term — so a large
 *  raw row count clustered into few independent blocks still produces a WIDE (conservative) bound,
 *  not a falsely tight one.
 *
 * Returns null (never a fabricated bound) when there isn't enough independent evidence to bound at
 * all: `effectiveN < 2` (a single independent block has no estimable spread) or `values` is empty.
 * `effectiveN` is trusted to be `<= values.length` (computeEffectiveN's own invariant); if a caller
 * violates that, the bound is only ever conservative-if-anything (variance still comes from the raw
 * values, so the returned bound is strictly less tight than what a correctly-bounded effectiveN
 * would give — never a source of false confidence).
 */
export function conservativeLowerBoundR(values: readonly number[], effectiveN: number, z = 1.645): number | null {
  if (effectiveN < 2 || values.length < 2) return null;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  const stdev = Math.sqrt(Math.max(0, variance));
  const se = stdev / Math.sqrt(effectiveN);
  return mean - z * se;
}

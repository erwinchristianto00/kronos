/**
 * Walk-forward validation + PBO (Probability of Backtest Overfitting).
 *
 * Two complementary honesty checks over accrued observations (paper-book trades — real fills, not a
 * parameter-fit backtest, but the same overfitting traps apply when comparing many lane variants):
 *
 * 1. ROLLING WALK-FORWARD: split time-ordered observations into consecutive buckets (e.g. weekly) and
 *    report netAvgR/PF/WR per bucket. Answers "is this edge stable across time, or one lucky period?"
 *    A lane whose edge lives in 1 of 8 buckets is fragile even if its all-time average looks great.
 *
 * 2. PBO via CSCV (Combinatorially Symmetric Cross-Validation — Bailey, Borwein, Lopez de Prado, Zhu
 *    2014, "The Probability of Backtest Overfitting"): given N strategy variants measured over the
 *    SAME T time buckets, split the T buckets into S equal partitions, form every combination of S/2
 *    partitions as the "training" half (the complement is "testing"), pick the training-best variant,
 *    then check where that variant RANKS on the testing half. PBO = the fraction of combinations where
 *    the training-winner performs BELOW MEDIAN out-of-sample — i.e. the probability that picking "the
 *    best-looking lane" was overfitting to noise rather than a real, transferable edge. This is exactly
 *    the audit for "is CG_WIDE_LONG_RUNNER's +1.0R real, or did it just look best in this sample."
 *
 * Pure: callers pass an already-built returns matrix; nothing here touches execution or the network.
 */

export interface TimedReturn {
  /** ms timestamp the observation resolved (closedAt), used to bucket by time. */
  atMs: number;
  netR: number;
}

export interface WalkForwardBucket {
  bucketStartMs: number;
  bucketEndMs: number;
  n: number;
  netAvgR: number | null;
  totalR: number;
  wr: number | null;
  pf: number | null;
}

export interface WalkForwardReport {
  bucketMs: number;
  buckets: WalkForwardBucket[];
  /** Fraction of non-empty buckets with netAvgR > 0 — the stability read. */
  positiveBucketShare: number | null;
  /** Standard deviation of per-bucket netAvgR (only over non-empty buckets) — dispersion/consistency. */
  bucketNetAvgRStdDev: number | null;
  /** True only when there are enough non-empty buckets to say anything about stability. */
  hasEnoughBucketsForVerdict: boolean;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Bucket time-ordered observations into consecutive, fixed-width windows starting at the first
 * observation's bucket boundary. Empty buckets are still emitted (n=0) so gaps are visible.
 */
export function buildWalkForwardReport(observations: TimedReturn[], bucketMs = 7 * 24 * 3_600_000): WalkForwardReport {
  const sorted = [...observations].sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 0) {
    return { bucketMs, buckets: [], positiveBucketShare: null, bucketNetAvgRStdDev: null, hasEnoughBucketsForVerdict: false };
  }
  const firstMs = sorted[0]!.atMs;
  const lastMs = sorted[sorted.length - 1]!.atMs;
  const bucketCount = Math.max(1, Math.floor((lastMs - firstMs) / bucketMs) + 1);

  const buckets: WalkForwardBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketStartMs = firstMs + i * bucketMs;
    const bucketEndMs = bucketStartMs + bucketMs;
    const inBucket = sorted.filter((o) => o.atMs >= bucketStartMs && o.atMs < bucketEndMs);
    const nets = inBucket.map((o) => o.netR);
    const positive = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const negative = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
    buckets.push({
      bucketStartMs,
      bucketEndMs,
      n: inBucket.length,
      netAvgR: mean(nets),
      totalR: nets.reduce((a, b) => a + b, 0),
      wr: inBucket.length ? nets.filter((r) => r > 0).length / inBucket.length : null,
      pf: negative > 0 ? positive / negative : positive > 0 ? Infinity : null,
    });
  }

  const nonEmpty = buckets.filter((b) => b.n > 0);
  const bucketAvgs = nonEmpty.map((b) => b.netAvgR as number);
  return {
    bucketMs,
    buckets,
    positiveBucketShare: nonEmpty.length ? nonEmpty.filter((b) => (b.netAvgR ?? 0) > 0).length / nonEmpty.length : null,
    bucketNetAvgRStdDev: stdDev(bucketAvgs),
    hasEnoughBucketsForVerdict: nonEmpty.length >= 4,
  };
}

/**
 * Build a [strategy x time-bucket] returns matrix from independent per-strategy observation series,
 * sharing ONE global set of time buckets (spanning the earliest→latest observation across ALL series)
 * so every strategy's row has the same bucket count (required by computePBO). A bucket with no
 * observations for a given strategy is scored 0 (flat) for that strategy — this is a real limitation:
 * a strategy that trades rarely will look artificially "flat" (neither winning nor losing) in buckets
 * it sat out, which can bias PBO toward strategies that trade more consistently. Callers comparing
 * lanes of very different trade frequency should read the PBO result with that caveat in mind.
 */
export function buildMultiStrategyReturnsMatrix(
  seriesByStrategy: Record<string, TimedReturn[]>,
  bucketMs = 7 * 24 * 3_600_000,
): { strategyIds: string[]; matrix: ReturnsMatrix; bucketCount: number } {
  const strategyIds = Object.keys(seriesByStrategy);
  const allObs = strategyIds.flatMap((id) => seriesByStrategy[id]!);
  if (allObs.length === 0) return { strategyIds, matrix: strategyIds.map(() => []), bucketCount: 0 };

  const firstMs = Math.min(...allObs.map((o) => o.atMs));
  const lastMs = Math.max(...allObs.map((o) => o.atMs));
  const bucketCount = Math.max(1, Math.floor((lastMs - firstMs) / bucketMs) + 1);

  const matrix: ReturnsMatrix = strategyIds.map((id) => {
    const series = seriesByStrategy[id]!;
    return Array.from({ length: bucketCount }, (_, i) => {
      const bucketStart = firstMs + i * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      const inBucket = series.filter((o) => o.atMs >= bucketStart && o.atMs < bucketEnd);
      return inBucket.length ? inBucket.reduce((s, o) => s + o.netR, 0) / inBucket.length : 0;
    });
  });

  return { strategyIds, matrix, bucketCount };
}

// ── PBO via CSCV ─────────────────────────────────────────────────────────────

/** returns[strategyIndex][timeBucketIndex] = mean/aggregate return of that strategy in that bucket. */
export type ReturnsMatrix = number[][];

export interface PboResult {
  /** Probability of Backtest Overfitting: fraction of train/test splits where the IS-best strategy
   *  ranked at/below the OOS median. Low (<0.2) = the edge looks real; high (>0.5) = likely noise. */
  pbo: number;
  splitsEvaluated: number;
  strategyCount: number;
  timeBucketCount: number;
  /** How often each strategy index was the IS-best pick across all splits (diagnostic). */
  isWinCountByStrategy: number[];
}

function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [first, ...rest] = items;
  const withFirst = combinations(rest, k - 1).map((c) => [first as T, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

/**
 * CSCV PBO over a [strategies x time-buckets] returns matrix. `subsets` (S, must be even, default 8)
 * partitions the time buckets into S equal groups; every C(S, S/2) combination of S/2 groups forms
 * one train/test split (the complement is the test set). Requires strategyCount>=2 and enough time
 * buckets to split into `subsets` non-trivial groups, else throws — a PBO on 1 strategy or 1 bucket
 * is not meaningful and must not silently report a fake number.
 */
export function computePBO(returns: ReturnsMatrix, subsets = 8): PboResult {
  const strategyCount = returns.length;
  if (strategyCount < 2) throw new Error("computePBO requires at least 2 strategies to compare");
  const timeBucketCount = returns[0]?.length ?? 0;
  if (returns.some((row) => row.length !== timeBucketCount)) throw new Error("computePBO requires all strategies to share the same time-bucket count");
  if (subsets < 2 || subsets % 2 !== 0) throw new Error("subsets must be an even number >= 2");
  if (timeBucketCount < subsets) throw new Error(`computePBO requires at least ${subsets} time buckets (got ${timeBucketCount})`);

  // Partition bucket INDICES into `subsets` groups (near-equal size, sequential — order doesn't
  // matter for CSCV since we're already working with pre-aggregated per-bucket returns).
  const groupSize = Math.floor(timeBucketCount / subsets);
  const groups: number[][] = [];
  for (let g = 0; g < subsets; g++) {
    const start = g * groupSize;
    const end = g === subsets - 1 ? timeBucketCount : start + groupSize;
    groups.push(Array.from({ length: end - start }, (_, i) => start + i));
  }

  const half = subsets / 2;
  const groupIndices = Array.from({ length: subsets }, (_, i) => i);
  const trainCombos = combinations(groupIndices, half);

  const meanReturn = (strategyIdx: number, bucketIdxs: number[]): number => {
    const row = returns[strategyIdx]!;
    const xs = bucketIdxs.map((i) => row[i]!);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };

  let belowOrAtMedianCount = 0;
  const isWinCountByStrategy = new Array(strategyCount).fill(0);
  let splitsEvaluated = 0;

  for (const trainGroupIdxs of trainCombos) {
    const testGroupIdxs = groupIndices.filter((g) => !trainGroupIdxs.includes(g));
    const trainBucketIdxs = trainGroupIdxs.flatMap((g) => groups[g]!);
    const testBucketIdxs = testGroupIdxs.flatMap((g) => groups[g]!);
    if (trainBucketIdxs.length === 0 || testBucketIdxs.length === 0) continue;

    // Pick the IS (in-sample/training) best strategy by mean return.
    let bestIdx = 0;
    let bestTrainReturn = -Infinity;
    for (let s = 0; s < strategyCount; s++) {
      const r = meanReturn(s, trainBucketIdxs);
      if (r > bestTrainReturn) {
        bestTrainReturn = r;
        bestIdx = s;
      }
    }
    isWinCountByStrategy[bestIdx] += 1;

    // Rank that strategy's OOS (test) performance among ALL strategies' OOS performance.
    const oosReturns = Array.from({ length: strategyCount }, (_, s) => meanReturn(s, testBucketIdxs));
    const sortedOos = [...oosReturns].sort((a, b) => a - b);
    const bestOosReturn = oosReturns[bestIdx]!;
    // Rank = 1-based position in the ascending-sorted OOS returns (ties: use the first matching index).
    const rank = sortedOos.indexOf(bestOosReturn) + 1;
    const relativeRank = rank / (strategyCount + 1); // in (0, 1)
    // logit(relativeRank) <= 0  <=>  relativeRank <= 0.5  <=>  at/below the OOS median.
    if (relativeRank <= 0.5) belowOrAtMedianCount += 1;
    splitsEvaluated += 1;
  }

  return {
    pbo: splitsEvaluated > 0 ? belowOrAtMedianCount / splitsEvaluated : NaN,
    splitsEvaluated,
    strategyCount,
    timeBucketCount,
    isWinCountByStrategy,
  };
}

// ── Lane-variant PBO audit (applies the above to real accrued observations) ─────────────────────

export interface VariantObservation {
  variantId: string;
  atMs: number;
  netR: number | null;
}

export interface LaneVariantPboReport {
  variantIds: string[];
  variantN: Record<string, number>;
  pbo: PboResult | null;
  walkForwardByVariant: Record<string, WalkForwardReport>;
  /** null (with a reason) when there isn't enough data for a meaningful CSCV split. */
  insufficientDataReason: string | null;
}

/**
 * The disciplined answer to "is this lane's edge real, or did it just look best in this sample?" —
 * groups resolved observations by variantId, keeps variants with >= minObsPerVariant, buckets them
 * onto a shared weekly timeline, and runs CSCV PBO across them plus a per-variant walk-forward
 * stability read. Never throws on insufficient data — returns pbo:null with a reason instead, since a
 * fabricated PBO number would be worse than admitting there isn't enough history yet.
 */
export function buildLaneVariantPboReport(
  observations: VariantObservation[],
  opts: { minObsPerVariant?: number; bucketMs?: number; subsets?: number } = {},
): LaneVariantPboReport {
  const minObsPerVariant = opts.minObsPerVariant ?? 30;
  const bucketMs = opts.bucketMs ?? 7 * 24 * 3_600_000;
  const subsets = opts.subsets ?? 8;

  const resolved = observations.filter((o): o is VariantObservation & { netR: number } => typeof o.netR === "number" && Number.isFinite(o.netR));
  const byVariant = new Map<string, VariantObservation[]>();
  for (const o of resolved) {
    const list = byVariant.get(o.variantId);
    if (list) list.push(o);
    else byVariant.set(o.variantId, [o]);
  }

  const eligible = [...byVariant.entries()].filter(([, list]) => list.length >= minObsPerVariant);
  const variantIds = eligible.map(([id]) => id);
  const variantN: Record<string, number> = {};
  for (const [id, list] of byVariant) variantN[id] = list.length;

  const walkForwardByVariant: Record<string, WalkForwardReport> = {};
  for (const [id, list] of eligible) {
    walkForwardByVariant[id] = buildWalkForwardReport(list.map((o) => ({ atMs: o.atMs, netR: o.netR as number })), bucketMs);
  }

  if (eligible.length < 2) {
    return {
      variantIds,
      variantN,
      pbo: null,
      walkForwardByVariant,
      insufficientDataReason: `need >=2 variants with >=${minObsPerVariant} resolved observations (have ${eligible.length})`,
    };
  }

  const seriesByStrategy: Record<string, TimedReturn[]> = {};
  for (const [id, list] of eligible) seriesByStrategy[id] = list.map((o) => ({ atMs: o.atMs, netR: o.netR as number }));
  const { matrix, bucketCount } = buildMultiStrategyReturnsMatrix(seriesByStrategy, bucketMs);

  if (bucketCount < subsets) {
    return {
      variantIds,
      variantN,
      pbo: null,
      walkForwardByVariant,
      insufficientDataReason: `need >=${subsets} time buckets spanning the data (have ${bucketCount}) — accrue more history`,
    };
  }

  return { variantIds, variantN, pbo: computePBO(matrix, subsets), walkForwardByVariant, insufficientDataReason: null };
}

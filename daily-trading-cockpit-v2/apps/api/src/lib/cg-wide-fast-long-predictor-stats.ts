/**
 * CG_WIDE_FAST_LONG predictor-research statistics (operator research brief item 3, 2026-07-10).
 * Pure, offline, read-only math. No I/O, no network, no dependency on live trading state. This
 * module is deliberately generic (no `LiveIntent`/store coupling) — the only coupling to the
 * Task 2 path-classification work is a type-only import of `PathClass` for readability of the
 * bucket-analysis helper's signature.
 *
 * IMPORTANT SAMPLE-SIZE HONESTY (per the operator brief): there are ~79 real CG_WIDE_FAST_LONG
 * trades total, split across 4 path classes — some classes may have single-digit membership. Every
 * function here that aggregates a subset reports its own `n` so callers can (and the accompanying
 * script does) flag any n below a small-sample threshold rather than presenting a rate/mean as if
 * it were a reliable estimate. Nothing in this module hides or silently drops a small-n bucket —
 * it always computes the number and returns/flags it, per the brief's explicit instruction.
 *
 * Everything below is written from scratch with no external stats library (this repo has none for
 * this purpose, per the operator brief) — Spearman's rho is implemented directly as "rank both
 * variables, then Pearson-correlate the ranks", logistic regression as plain gradient descent, the
 * decision tree as a minimal greedy depth-capped Gini-impurity splitter, and permutation
 * importance/tests as literal shuffle-and-remeasure loops.
 */

import type { PathClass } from "./cg-wide-fast-long-path-classification.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small generic numeric helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function mean(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Filters two parallel arrays down to the indices where BOTH values are finite numbers
 *  ("pairwise complete observations" — the standard convention for correlating two columns that
 *  each independently may have missing/null entries, e.g. entryATR is null for some trades). */
export function pairwiseComplete(xs: Array<number | null>, ys: Array<number | null>): { xs: number[]; ys: number[] } {
  const outX: number[] = [];
  const outY: number[] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)) {
      outX.push(x);
      outY.push(y);
    }
  }
  return { xs: outX, ys: outY };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Spearman rank correlation (method 2 of the brief)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Assigns each value its rank (1 = smallest), with tied values receiving the AVERAGE of the
 *  ranks they'd otherwise occupy (the standard tie-handling convention for Spearman's rho). */
export function rankValues(xs: number[]): number[] {
  const n = xs.length;
  const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n);
  let idx = 0;
  while (idx < n) {
    let j = idx;
    while (j + 1 < n && order[j + 1]!.v === order[idx]!.v) j += 1;
    // tie block is [idx, j] (inclusive), 0-indexed positions -> ranks (idx+1)..(j+1)
    const avgRank = (idx + 1 + (j + 1)) / 2;
    for (let k = idx; k <= j; k++) ranks[order[k]!.i] = avgRank;
    idx = j + 1;
  }
  return ranks;
}

export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null; // no variance in one variable -> undefined correlation
  return cov / Math.sqrt(varX * varY);
}

export interface SpearmanResult {
  rho: number | null;
  n: number;
}

/** Spearman's rank correlation coefficient: rank both variables independently (average rank for
 *  ties), then compute the Pearson correlation of the two rank sequences. Null/undefined entries
 *  are dropped pairwise before ranking (see pairwiseComplete). Returns rho=null when fewer than 2
 *  complete pairs remain or either ranked variable has zero variance (e.g. every value in the
 *  surviving sample is identical). */
export function spearmanRho(xs: Array<number | null>, ys: Array<number | null>): SpearmanResult {
  const { xs: cx, ys: cy } = pairwiseComplete(xs, ys);
  if (cx.length < 2) return { rho: null, n: cx.length };
  const rx = rankValues(cx);
  const ry = rankValues(cy);
  return { rho: pearsonCorrelation(rx, ry), n: cx.length };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Bucket analysis (method 1 of the brief)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BucketStats {
  bucket: string;
  n: number;
  expansionRate: number | null;
  scratchRate: number | null;
  toxicRate: number | null;
  deadRate: number | null;
  avgNetR: number | null;
  medianNetR: number | null;
  avgMFE: number | null;
  avgMAE: number | null;
  /** true when n is below the caller's small-sample threshold — the bucket's rates/means above
   *  are still computed and returned (never hidden), just flagged as unreliable. */
  sampleTooSmall: boolean;
}

export interface BucketAnalysisInput<T> {
  records: T[];
  /** Returns null to exclude a record from this particular grouping (e.g. entryATR unavailable
   *  for the ATR-tercile grouping) — excluded records are NOT counted in that bucket's n. */
  bucketOf: (record: T) => string | null;
  getPathClass: (record: T) => PathClass;
  getNetR: (record: T) => number | null;
  getMFE: (record: T) => number | null;
  getMAE: (record: T) => number | null;
  minReliableN?: number;
}

const DEFAULT_MIN_RELIABLE_N = 8;

/** Computes every one of the brief's required per-bucket statistics
 *  (expansionRate/scratchRate/toxicRate/avgNetR/medianNetR/avgMFE/avgMAE/n) in one pass, for
 *  whatever bucketing function the caller supplies (symbol, entryHourUtc, entryRegimeAlignment,
 *  an ATR tercile label, etc.). Buckets are returned in DESCENDING n order (largest, most-reliable
 *  samples first) — the caller decides display order if it wants something else. */
export function computeBucketStats<T>(input: BucketAnalysisInput<T>): BucketStats[] {
  const { records, bucketOf, getPathClass, getNetR, getMFE, getMAE, minReliableN = DEFAULT_MIN_RELIABLE_N } = input;
  const groups = new Map<string, T[]>();
  for (const r of records) {
    const key = bucketOf(r);
    if (key === null) continue;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: BucketStats[] = [];
  for (const [bucket, list] of groups.entries()) {
    const n = list.length;
    const classes = list.map(getPathClass);
    const netRs = list.map(getNetR).filter((x): x is number => x !== null && Number.isFinite(x));
    const mfes = list.map(getMFE).filter((x): x is number => x !== null && Number.isFinite(x));
    const maes = list.map(getMAE).filter((x): x is number => x !== null && Number.isFinite(x));
    out.push({
      bucket,
      n,
      expansionRate: classes.filter((c) => c === "TRUE_EXPANSION").length / n,
      scratchRate: classes.filter((c) => c === "SCRATCHABLE").length / n,
      toxicRate: classes.filter((c) => c === "TOXIC_REVERSAL").length / n,
      deadRate: classes.filter((c) => c === "DEAD_ON_ARRIVAL").length / n,
      avgNetR: mean(netRs),
      medianNetR: median(netRs),
      avgMFE: mean(mfes),
      avgMAE: mean(maes),
      sampleTooSmall: n < minReliableN,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** Splits a numeric feature into terciles (LOW/MID/HIGH, by rank within the surviving non-null
 *  sample) — the brief's own suggested treatment for entryATR. Returns a lookup function usable as
 *  a `bucketOf` for computeBucketStats; records whose feature value is null get bucket label null
 *  (excluded, never coerced into a fabricated bucket). Ties at a tercile boundary fall into the
 *  LOWER tercile (deterministic, simple, documented — not a claim of a statistically ideal tie
 *  rule, just a stable one). */
export function buildTercileBucketer<T>(values: Array<{ record: T; value: number | null }>): (record: T) => string | null {
  const present = values.filter((v): v is { record: T; value: number } => v.value !== null && Number.isFinite(v.value));
  const sorted = [...present].sort((a, b) => a.value - b.value);
  const n = sorted.length;
  const boundary1 = sorted[Math.floor(n / 3) - 1]?.value ?? sorted[0]?.value ?? 0;
  const boundary2 = sorted[Math.floor((2 * n) / 3) - 1]?.value ?? boundary1;
  const byRecord = new Map<T, string | null>();
  for (const v of values) {
    if (v.value === null || !Number.isFinite(v.value)) {
      byRecord.set(v.record, null);
      continue;
    }
    const label = v.value <= boundary1 ? "LOW" : v.value <= boundary2 ? "MID" : "HIGH";
    byRecord.set(v.record, label);
  }
  return (record: T) => byRecord.get(record) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG (mulberry32) — for reproducible permutation tests/importance
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledCopy<T>(xs: T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Logistic regression (method 4 of the brief) — deliberately minimal: fixed learning rate, fixed
// iteration count, no regularization, no CV grid search. z-score standardization is applied
// internally purely to make plain gradient descent converge in a reasonable iteration budget; it
// is NOT a modeling sophistication, it's undone transparently at prediction time.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface LogisticRegressionModel {
  /** Standardized-feature-space weights (one per feature). */
  weights: number[];
  bias: number;
  featureMeans: number[];
  featureStds: number[];
  iterations: number;
  finalLoss: number;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function standardize(X: number[][]): { Z: number[][]; means: number[]; stds: number[] } {
  const nFeatures = X[0]?.length ?? 0;
  const means: number[] = new Array(nFeatures).fill(0);
  const stds: number[] = new Array(nFeatures).fill(1);
  for (let f = 0; f < nFeatures; f++) {
    const col = X.map((row) => row[f]!);
    const m = mean(col)!;
    const variance = mean(col.map((v) => (v - m) * (v - m)))!;
    const sd = Math.sqrt(variance);
    means[f] = m;
    stds[f] = sd > 1e-12 ? sd : 1; // constant column -> leave standardized value at 0, weight can't matter
  }
  const Z = X.map((row) => row.map((v, f) => (v - means[f]!) / stds[f]!));
  return { Z, means, stds };
}

/** Plain batch-gradient-descent logistic regression. y must be 0/1. Intentionally simple per the
 *  operator brief ("keep this genuinely simple ... illustrative/exploratory, not a validated
 *  model") — no regularization, no held-out validation split (n~79, often much less per class,
 *  makes a train/test split its own small-sample problem). */
export function trainLogisticRegression(
  X: number[][],
  y: number[],
  opts: { learningRate?: number; iterations?: number } = {},
): LogisticRegressionModel {
  const learningRate = opts.learningRate ?? 0.3;
  const iterations = opts.iterations ?? 2000;
  const n = X.length;
  const nFeatures = X[0]?.length ?? 0;
  const { Z, means, stds } = standardize(X);
  let weights = new Array(nFeatures).fill(0);
  let bias = 0;
  let finalLoss = NaN;
  for (let it = 0; it < iterations; it++) {
    const gradW = new Array(nFeatures).fill(0);
    let gradB = 0;
    let loss = 0;
    for (let i = 0; i < n; i++) {
      const row = Z[i]!;
      let z = bias;
      for (let f = 0; f < nFeatures; f++) z += weights[f]! * row[f]!;
      const p = sigmoid(z);
      const err = p - y[i]!;
      for (let f = 0; f < nFeatures; f++) gradW[f] += err * row[f]!;
      gradB += err;
      const eps = 1e-12;
      loss += -(y[i]! * Math.log(p + eps) + (1 - y[i]!) * Math.log(1 - p + eps));
    }
    for (let f = 0; f < nFeatures; f++) weights[f] -= (learningRate * gradW[f]!) / n;
    bias -= (learningRate * gradB) / n;
    finalLoss = loss / n;
  }
  return { weights, bias, featureMeans: means, featureStds: stds, iterations, finalLoss };
}

export function predictLogisticProba(model: LogisticRegressionModel, x: number[]): number {
  let z = model.bias;
  for (let f = 0; f < x.length; f++) {
    const std = (x[f]! - model.featureMeans[f]!) / model.featureStds[f]!;
    z += model.weights[f]! * std;
  }
  return sigmoid(z);
}

export function predictLogisticProbaBatch(model: LogisticRegressionModel, X: number[][]): number[] {
  return X.map((x) => predictLogisticProba(model, x));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Minimal depth-capped decision tree (method 5 of the brief) — greedy single-feature-threshold
// splits, Gini impurity, recursion capped at maxDepth (default 2 -> at most 3 internal splits / 4
// leaves). No pruning sophistication, no multi-way splits.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type DecisionTreeNode =
  | { kind: "leaf"; n: number; positiveRate: number }
  | {
      kind: "split";
      featureIndex: number;
      threshold: number;
      n: number;
      gini: number;
      left: DecisionTreeNode;
      right: DecisionTreeNode;
    };

export function giniImpurity(labels: number[]): number {
  const n = labels.length;
  if (n === 0) return 0;
  const p1 = labels.reduce((s, v) => s + v, 0) / n;
  const p0 = 1 - p1;
  return 1 - p0 * p0 - p1 * p1;
}

interface BestSplit {
  featureIndex: number;
  threshold: number;
  weightedGini: number;
  leftIdx: number[];
  rightIdx: number[];
}

function findBestSplit(X: number[][], y: number[], idx: number[], minLeafSize: number): BestSplit | null {
  const nFeatures = X[0]?.length ?? 0;
  let best: BestSplit | null = null;
  for (let f = 0; f < nFeatures; f++) {
    const values = [...new Set(idx.map((i) => X[i]![f]!))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < values.length; k++) {
      const threshold = (values[k]! + values[k + 1]!) / 2;
      const leftIdx = idx.filter((i) => X[i]![f]! <= threshold);
      const rightIdx = idx.filter((i) => X[i]![f]! > threshold);
      if (leftIdx.length < minLeafSize || rightIdx.length < minLeafSize) continue;
      const giniLeft = giniImpurity(leftIdx.map((i) => y[i]!));
      const giniRight = giniImpurity(rightIdx.map((i) => y[i]!));
      const weightedGini = (leftIdx.length * giniLeft + rightIdx.length * giniRight) / idx.length;
      if (best === null || weightedGini < best.weightedGini) {
        best = { featureIndex: f, threshold, weightedGini, leftIdx, rightIdx };
      }
    }
  }
  return best;
}

function makeLeaf(y: number[], idx: number[]): DecisionTreeNode {
  const labels = idx.map((i) => y[i]!);
  return { kind: "leaf", n: idx.length, positiveRate: mean(labels) ?? 0 };
}

function buildNode(X: number[][], y: number[], idx: number[], depth: number, maxDepth: number, minLeafSize: number): DecisionTreeNode {
  const labels = idx.map((i) => y[i]!);
  const parentGini = giniImpurity(labels);
  if (depth >= maxDepth || parentGini === 0 || idx.length < 2 * minLeafSize) {
    return makeLeaf(y, idx);
  }
  const best = findBestSplit(X, y, idx, minLeafSize);
  if (best === null || best.weightedGini >= parentGini) {
    // no split improves impurity (or no split respects minLeafSize) -> stop here, leaf
    return makeLeaf(y, idx);
  }
  return {
    kind: "split",
    featureIndex: best.featureIndex,
    threshold: best.threshold,
    n: idx.length,
    gini: parentGini,
    left: buildNode(X, y, best.leftIdx, depth + 1, maxDepth, minLeafSize),
    right: buildNode(X, y, best.rightIdx, depth + 1, maxDepth, minLeafSize),
  };
}

/** Builds a minimal greedy depth-capped decision tree. y must be 0/1. minLeafSize defaults to 5 —
 *  given n~79 (often far less per class), a smaller minimum would let the tree fit noise; this is
 *  still a small number and the brief explicitly wants this kept simple/shallow, not tuned. */
export function buildDecisionTree(
  X: number[][],
  y: number[],
  opts: { maxDepth?: number; minLeafSize?: number } = {},
): DecisionTreeNode {
  const maxDepth = opts.maxDepth ?? 2;
  const minLeafSize = opts.minLeafSize ?? 5;
  const idx = X.map((_, i) => i);
  return buildNode(X, y, idx, 0, maxDepth, minLeafSize);
}

export function predictTreeProba(node: DecisionTreeNode, x: number[]): number {
  let cur = node;
  while (cur.kind === "split") {
    cur = x[cur.featureIndex]! <= cur.threshold ? cur.left : cur.right;
  }
  return cur.positiveRate;
}

export function predictTreeProbaBatch(node: DecisionTreeNode, X: number[][]): number[] {
  return X.map((x) => predictTreeProba(node, x));
}

/** Flattens a tree into human-readable lines for reporting (e.g. "if entryATRPct <= 0.012 then ...
 *  else ..."), given feature names in the same order as the training X columns. */
export function describeTree(node: DecisionTreeNode, featureNames: string[], indent = ""): string[] {
  if (node.kind === "leaf") {
    return [`${indent}leaf: n=${node.n} positiveRate=${node.positiveRate.toFixed(3)}`];
  }
  const name = featureNames[node.featureIndex] ?? `feature[${node.featureIndex}]`;
  return [
    `${indent}if ${name} <= ${node.threshold.toFixed(4)} (n=${node.n}, gini=${node.gini.toFixed(3)}):`,
    ...describeTree(node.left, featureNames, indent + "  "),
    `${indent}else (${name} > ${node.threshold.toFixed(4)}):`,
    ...describeTree(node.right, featureNames, indent + "  "),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function accuracy(yTrue: number[], yPredProba: number[], threshold = 0.5): number {
  const n = yTrue.length;
  if (n === 0) return NaN;
  let correct = 0;
  for (let i = 0; i < n; i++) {
    const predLabel = yPredProba[i]! >= threshold ? 1 : 0;
    if (predLabel === yTrue[i]) correct += 1;
  }
  return correct / n;
}

export function logLoss(yTrue: number[], yPredProba: number[]): number {
  const n = yTrue.length;
  if (n === 0) return NaN;
  const eps = 1e-12;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - eps, Math.max(eps, yPredProba[i]!));
    sum += -(yTrue[i]! * Math.log(p) + (1 - yTrue[i]!) * Math.log(1 - p));
  }
  return sum / n;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Permutation importance (method 6 of the brief)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PermutationImportanceResult {
  featureIndex: number;
  baselineMetric: number;
  meanMetricAfterShuffle: number;
  /** Positive = shuffling this feature made the metric WORSE (i.e. the feature carries real
   *  signal, in whatever direction "worse" means for this metric — see higherIsBetter). Reported
   *  in metric units, always in the "worse when shuffled" == positive convention regardless of
   *  whether the underlying metric is higher-is-better (accuracy) or lower-is-better (log-loss),
   *  so importances across different metrics/models are directly comparable in sign. */
  importance: number;
  /** Std-dev of the per-permutation metric-after-shuffle across the `permutations` runs — with
   *  n~79 this will typically be large relative to the importance itself; callers should treat a
   *  small importance mean relative to this std as noise, not a reliable ranking signal. */
  importanceStd: number;
  permutations: number;
}

/** Generic permutation importance: for each feature column, shuffle ONLY that column (breaking its
 *  association with y while leaving every other column and the row order of y intact), re-run the
 *  supplied predictFn, remeasure the metric, and record how much worse the metric got relative to
 *  the unshuffled baseline. Repeated `permutations` times per feature to average out shuffle noise
 *  (still noisy at n~79 — see importanceStd above, reported precisely so this isn't overstated). */
export function permutationImportance(
  predictFn: (X: number[][]) => number[],
  X: number[][],
  y: number[],
  opts: {
    metric: (yTrue: number[], yPred: number[]) => number;
    higherIsBetter: boolean;
    permutations?: number;
    rng?: () => number;
  },
): PermutationImportanceResult[] {
  const { metric, higherIsBetter } = opts;
  const permutations = opts.permutations ?? 1000;
  const rng = opts.rng ?? mulberry32(1234567);
  const nFeatures = X[0]?.length ?? 0;
  const baselinePred = predictFn(X);
  const baselineMetric = metric(y, baselinePred);
  const results: PermutationImportanceResult[] = [];
  for (let f = 0; f < nFeatures; f++) {
    const col = X.map((row) => row[f]!);
    const afterShuffle: number[] = [];
    for (let p = 0; p < permutations; p++) {
      const shuffledCol = shuffledCopy(col, rng);
      const XShuffled = X.map((row, i) => row.map((v, ff) => (ff === f ? shuffledCol[i]! : v)));
      const pred = predictFn(XShuffled);
      afterShuffle.push(metric(y, pred));
    }
    const meanAfter = mean(afterShuffle)!;
    const variance = mean(afterShuffle.map((v) => (v - meanAfter) * (v - meanAfter)))!;
    const importance = higherIsBetter ? baselineMetric - meanAfter : meanAfter - baselineMetric;
    results.push({
      featureIndex: f,
      baselineMetric,
      meanMetricAfterShuffle: meanAfter,
      importance,
      importanceStd: Math.sqrt(variance),
      permutations,
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Permutation TEST (null-hypothesis top-vs-bottom group comparison) — the brief's "1,000
// permutations if sample size permits" language refers to THIS, a separate thing from permutation
// IMPORTANCE above (which measures a fitted model's feature reliance, not a null-hypothesis test
// of a raw group difference). Implemented per the brief's explicit "implement both if feasible".
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PermutationTestResult {
  observedDiff: number;
  /** Two-sided: fraction of permuted-label difference magnitudes >= the observed difference
   *  magnitude. With n~79 (often far fewer per compared group) this p-value should be read as
   *  exploratory, not a confirmatory hypothesis test — see the brief's small-sample caveat. */
  pValue: number;
  permutations: number;
  groupASize: number;
  groupBSize: number;
}

/** Permutation test for a difference of means between two groups: pools both groups' values,
 *  repeatedly reshuffles which pooled value belongs to "group A" vs "group B" (preserving the
 *  original group sizes), and asks what fraction of those RANDOM relabelings produce a difference
 *  at least as extreme as the one actually observed. This is model-free (no assumption of
 *  normality) — appropriate for the tiny, almost-certainly-non-normal per-bucket samples here. */
export function permutationTestMeanDifference(
  groupA: number[],
  groupB: number[],
  opts: { permutations?: number; rng?: () => number } = {},
): PermutationTestResult {
  const permutations = opts.permutations ?? 1000;
  const rng = opts.rng ?? mulberry32(987654321);
  const nA = groupA.length;
  const nB = groupB.length;
  const observedDiff = (mean(groupA) ?? 0) - (mean(groupB) ?? 0);
  const pooled = [...groupA, ...groupB];
  let countAsExtreme = 0;
  for (let p = 0; p < permutations; p++) {
    const shuffled = shuffledCopy(pooled, rng);
    const permA = shuffled.slice(0, nA);
    const permB = shuffled.slice(nA, nA + nB);
    const permDiff = (mean(permA) ?? 0) - (mean(permB) ?? 0);
    if (Math.abs(permDiff) >= Math.abs(observedDiff)) countAsExtreme += 1;
  }
  return { observedDiff, pValue: countAsExtreme / permutations, permutations, groupASize: nA, groupBSize: nB };
}

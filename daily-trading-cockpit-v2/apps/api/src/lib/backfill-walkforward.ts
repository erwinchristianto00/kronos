/**
 * Historical backfill — walk-forward validation + metrics (Phase 7 / requirement #7). CHRONOLOGICAL splits
 * only — never a random train/test shuffle (that would leak the future into the past). Expanding-window
 * folds; the FINAL time block is reserved untouched (never a training or a tuning target). Metrics: decision-
 * alpha vs the incumbent, Brier + calibration, max drawdown, concentration, and a reality-gap proxy. Pure.
 */

export interface Timed {
  tMs: number;
}

export interface WalkForwardFold {
  index: number;
  trainEndMs: number;
  testStartMs: number;
  testEndMs: number;
  trainIdx: number[];
  testIdx: number[];
}

export interface WalkForwardPlan<T extends Timed> {
  sorted: T[];
  folds: WalkForwardFold[];
  /** Indices reserved as the untouched final block — never train, never test-fold. */
  holdoutIdx: number[];
  holdoutStartMs: number;
}

/**
 * Build expanding-window chronological folds. `folds` fold count over the non-holdout region; `holdoutFrac`
 * of the time span is reserved as the untouched final block. Splits are by TIME, then rows assigned by tMs, so
 * ties at a boundary go to the earlier side deterministically.
 */
export function planWalkForward<T extends Timed>(rows: T[], folds = 3, holdoutFrac = 0.25): WalkForwardPlan<T> {
  const sorted = [...rows].sort((a, b) => a.tMs - b.tMs);
  const n = sorted.length;
  if (n === 0) return { sorted, folds: [], holdoutIdx: [], holdoutStartMs: 0 };
  const t0 = sorted[0]!.tMs;
  const t1 = sorted[n - 1]!.tMs;
  const span = Math.max(1, t1 - t0);
  const holdoutStartMs = t0 + span * (1 - Math.max(0, Math.min(0.9, holdoutFrac)));
  const holdoutIdx: number[] = [];
  const workingIdx: number[] = [];
  for (let i = 0; i < n; i += 1) (sorted[i]!.tMs >= holdoutStartMs ? holdoutIdx : workingIdx).push(i);

  const wfFolds: WalkForwardFold[] = [];
  if (workingIdx.length >= 2 && folds >= 1) {
    const wStart = sorted[workingIdx[0]!]!.tMs;
    const wEnd = holdoutStartMs;
    const wSpan = Math.max(1, wEnd - wStart);
    // fold k trains on [wStart, wStart + (k+1)/(folds+1)·wSpan), tests on the next slice.
    for (let k = 0; k < folds; k += 1) {
      const trainEndMs = wStart + (wSpan * (k + 1)) / (folds + 1);
      const testEndMs = wStart + (wSpan * (k + 2)) / (folds + 1);
      const trainIdx = workingIdx.filter((i) => sorted[i]!.tMs < trainEndMs);
      const testIdx = workingIdx.filter((i) => sorted[i]!.tMs >= trainEndMs && sorted[i]!.tMs < testEndMs);
      if (trainIdx.length === 0 || testIdx.length === 0) continue;
      wfFolds.push({ index: k, trainEndMs, testStartMs: trainEndMs, testEndMs, trainIdx, testIdx });
    }
  }
  return { sorted, folds: wfFolds, holdoutIdx, holdoutStartMs };
}

// ── Metrics ─────────────────────────────────────────────────────────────────────────────────────

/** Brier score = mean((p − y)²) for probabilistic predictions vs binary outcomes. Lower is better. */
export function brierScore(preds: Array<{ p: number; y: 0 | 1 }>): number | null {
  const usable = preds.filter((d) => Number.isFinite(d.p));
  if (usable.length === 0) return null;
  let s = 0;
  for (const d of usable) s += (d.p - d.y) ** 2;
  return s / usable.length;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  meanPred: number | null;
  empiricalRate: number | null;
}

/** Reliability bins: mean predicted p vs empirical win rate per probability band. */
export function calibrationBins(preds: Array<{ p: number; y: 0 | 1 }>, nBins = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < nBins; b += 1) {
    const lo = b / nBins;
    const hi = (b + 1) / nBins;
    const inBin = preds.filter((d) => Number.isFinite(d.p) && d.p >= lo && (b === nBins - 1 ? d.p <= hi : d.p < hi));
    const count = inBin.length;
    bins.push({
      lo,
      hi,
      count,
      meanPred: count ? inBin.reduce((a, d) => a + d.p, 0) / count : null,
      empiricalRate: count ? inBin.reduce((a, d) => a + d.y, 0) / count : null,
    });
  }
  return bins;
}

/** Max drawdown of the CHRONOLOGICAL cumulative-netR curve (rows must be pre-sorted by time). In R. */
export function maxDrawdownR(netRByTime: number[]): number {
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of netRByTime) {
    if (!Number.isFinite(r)) continue;
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Concentration of realized netR by group (lane/symbol): Herfindahl (0..1) + top-1 share. Uses |netR| so
 *  a few big winners AND a few big losers both register as concentration. */
export function concentration(byGroupNetR: Map<string, number>): { hhi: number; topShare: number; groups: number } {
  const mags = [...byGroupNetR.values()].map((v) => Math.abs(v)).filter((v) => Number.isFinite(v));
  const total = mags.reduce((a, v) => a + v, 0);
  if (total <= 0) return { hhi: 0, topShare: 0, groups: mags.length };
  const shares = mags.map((v) => v / total);
  return { hhi: shares.reduce((a, s) => a + s * s, 0), topShare: Math.max(...shares), groups: mags.length };
}

/** Decision-alpha: mean netR of the rows the candidate would ACT on, minus the incumbent's mean netR over the
 *  same period. Positive ⇒ the candidate's selection adds edge over the incumbent. In R. */
export function decisionAlpha(candidateSelectedNetR: number[], incumbentNetR: number[]): number | null {
  const mean = (a: number[]) => {
    const u = a.filter((v) => Number.isFinite(v));
    return u.length ? u.reduce((x, v) => x + v, 0) / u.length : null;
  };
  const c = mean(candidateSelectedNetR);
  const i = mean(incumbentNetR);
  if (c == null || i == null) return null;
  return c - i;
}

/** Empirical quantile (linear, no interpolation beyond nearest-rank) of a numeric array. q in [0,1]. */
export function quantile(xs: number[], q: number): number | null {
  const u = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (u.length === 0) return null;
  const idx = Math.min(u.length - 1, Math.max(0, Math.round(q * (u.length - 1))));
  return u[idx]!;
}

export interface DecisionMetric {
  name: string;
  /** Where the selection threshold came from — MUST be train-only (never the test/holdout being scored). */
  thresholdSource: string;
  threshold: number | null;
  coverage: number; // fraction of test rows selected
  selectedN: number;
  meanNetR: number | null;
  /** alpha = mean(selected netR) − mean(ALL test netR). null for the all-rows baseline (alpha is 0 by defn). */
  alphaR: number | null;
}

/**
 * PRE-REGISTERED decision metrics — computed together so no single rule is cherry-picked after seeing results.
 * Every selection threshold is derived ONLY from the TRAIN block (`trainScores`, `trainBaseRate`) and then
 * FROZEN onto the test block. The test/holdout being scored never influences a threshold. `coverage` is always
 * reported (alpha on 5% of trades ≠ alpha on 50%).
 */
export function preRegisteredDecisionMetrics(
  test: Array<{ score: number; netR: number }>,
  trainScores: number[],
  trainBaseRate: number,
): DecisionMetric[] {
  const allNetR = test.map((t) => t.netR);
  const meanAll = allNetR.length ? allNetR.reduce((a, v) => a + v, 0) / allNetR.length : null;
  const select = (name: string, src: string, threshold: number | null): DecisionMetric => {
    const sel = threshold == null ? test : test.filter((t) => t.score >= threshold);
    const m = sel.length ? sel.reduce((a, t) => a + t.netR, 0) / sel.length : null;
    return {
      name, thresholdSource: src, threshold,
      coverage: test.length ? sel.length / test.length : 0, selectedN: sel.length,
      meanNetR: m, alphaR: m != null && meanAll != null ? m - meanAll : null,
    };
  };
  return [
    { name: "all-rows", thresholdSource: "none (take-all baseline = incumbent)", threshold: null, coverage: 1, selectedN: test.length, meanNetR: meanAll, alphaR: 0 },
    select("top-10%", "train score p90", quantile(trainScores, 0.9)),
    select("top-25%", "train score p75", quantile(trainScores, 0.75)),
    select("top-50%", "train score p50", quantile(trainScores, 0.5)),
    select("fixed-hurdle", "train base rate", trainBaseRate),
  ];
}

export interface BrierComparison {
  brierModel: number | null;
  brierBaseRate: number | null;
  /** brierBaseRate − brierModel: POSITIVE ⇒ the model beats a constant base-rate predictor. */
  brierSkill: number | null;
}

/** Compare the model's Brier to a CONSTANT predictor that always outputs the TRAIN base rate (not the test
 *  rate). A model only "helps" if it beats this. */
export function brierVsBaseRate(preds: Array<{ p: number; y: 0 | 1 }>, trainBaseRate: number): BrierComparison {
  const bm = brierScore(preds);
  const bb = brierScore(preds.map((d) => ({ p: trainBaseRate, y: d.y })));
  return { brierModel: bm, brierBaseRate: bb, brierSkill: bm != null && bb != null ? bb - bm : null };
}

/** Calibration slope/intercept: OLS of empirical-rate on mean-pred across non-empty reliability bins (weighted
 *  by bin count). Perfect calibration ⇒ slope≈1, intercept≈0. */
export function calibrationLine(bins: CalibrationBin[]): { slope: number | null; intercept: number | null } {
  const pts = bins.filter((b) => b.meanPred != null && b.empiricalRate != null && b.count > 0).map((b) => ({ x: b.meanPred!, y: b.empiricalRate!, w: b.count }));
  const W = pts.reduce((a, p) => a + p.w, 0);
  if (pts.length < 2 || W === 0) return { slope: null, intercept: null };
  const mx = pts.reduce((a, p) => a + p.w * p.x, 0) / W;
  const my = pts.reduce((a, p) => a + p.w * p.y, 0) / W;
  const sxx = pts.reduce((a, p) => a + p.w * (p.x - mx) ** 2, 0);
  const sxy = pts.reduce((a, p) => a + p.w * (p.x - mx) * (p.y - my), 0);
  if (sxx === 0) return { slope: null, intercept: null };
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** Reality-gap proxy: with only counterfactual/paper closes (no live fills), the honest proxy for slippage-to-
 *  reality is the cost DRAG and its DISPERSION — mean(costR)/mean(|grossR|) and the std of costR. A big or
 *  highly-variable cost drag ⇒ paper edge is more likely to evaporate live. */
export function realityGapProxy(rows: Array<{ grossR: number | null; costR: number | null }>): {
  meanCostR: number | null;
  costDragRatio: number | null;
  costStd: number | null;
  n: number;
} {
  const costs = rows.map((r) => r.costR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const gross = rows.map((r) => r.grossR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (costs.length === 0) return { meanCostR: null, costDragRatio: null, costStd: null, n: 0 };
  const meanCost = costs.reduce((a, v) => a + v, 0) / costs.length;
  const meanAbsGross = gross.length ? gross.reduce((a, v) => a + Math.abs(v), 0) / gross.length : null;
  const variance = costs.reduce((a, v) => a + (v - meanCost) ** 2, 0) / costs.length;
  return {
    meanCostR: meanCost,
    costDragRatio: meanAbsGross && meanAbsGross > 0 ? meanCost / meanAbsGross : null,
    costStd: Math.sqrt(variance),
    n: costs.length,
  };
}

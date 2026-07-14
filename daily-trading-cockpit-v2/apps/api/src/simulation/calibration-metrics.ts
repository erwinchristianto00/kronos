/**
 * Pure statistical primitives for realism assessment (Market Digital Twin, Phase-1 foundation). Deterministic, no
 * RNG, no I/O. Every function returns a finite number OR null when the sample is too small to be meaningful — never
 * a fabricated point estimate. These feed realism-assessment.ts + realism-gate.ts.
 */

export function mean(xs: readonly number[]): number | null {
  const v = xs.filter(Number.isFinite);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

export function std(xs: readonly number[]): number | null {
  const v = xs.filter(Number.isFinite);
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** Empirical quantile (linear interpolation) of a copy-sorted sample. q in [0,1]. */
export function quantile(xs: readonly number[], q: number): number | null {
  const v = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0]!;
  const idx = q * (v.length - 1);
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  return v[lo]! + (v[hi]! - v[lo]!) * (idx - lo);
}

/** Two-sample Kolmogorov–Smirnov distance (max CDF gap) in [0,1], or null if either sample is empty. */
export function ksDistance(a: readonly number[], b: readonly number[]): number | null {
  const A = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  const B = b.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (A.length === 0 || B.length === 0) return null;
  let i = 0; let j = 0; let d = 0;
  while (i < A.length && j < B.length) {
    const x = Math.min(A[i]!, B[j]!);
    while (i < A.length && A[i]! <= x) i += 1;
    while (j < B.length && B[j]! <= x) j += 1;
    d = Math.max(d, Math.abs(i / A.length - j / B.length));
  }
  return d;
}

/** 1-D Wasserstein-1 (earth-mover) distance between two empirical samples (interpolated inverse-CDF integral). */
export function wasserstein1(a: readonly number[], b: readonly number[]): number | null {
  const A = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  const B = b.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (A.length === 0 || B.length === 0) return null;
  const grid = 200;
  let acc = 0;
  const qOf = (arr: number[], p: number): number => {
    const idx = p * (arr.length - 1); const lo = Math.floor(idx); const hi = Math.ceil(idx);
    return arr[lo]! + (arr[hi]! - arr[lo]!) * (idx - lo);
  };
  for (let k = 0; k < grid; k += 1) {
    const p = (k + 0.5) / grid;
    acc += Math.abs(qOf(A, p) - qOf(B, p));
  }
  return acc / grid;
}

/** Lag-k autocorrelation of a series, or null if too short. */
export function autocorr(xs: readonly number[], lag: number): number | null {
  const v = xs.filter(Number.isFinite);
  if (v.length <= lag + 1) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  let num = 0; let den = 0;
  for (let i = 0; i < v.length; i += 1) den += (v[i]! - m) ** 2;
  for (let i = 0; i < v.length - lag; i += 1) num += (v[i]! - m) * (v[i + lag]! - m);
  return den === 0 ? null : num / den;
}

/** Hill tail-index estimate on the right tail of |x| (a fat tail ⇒ smaller alpha). k = # order stats used. */
export function hillTailIndex(xs: readonly number[], kFraction = 0.05): number | null {
  const v = xs.map((x) => Math.abs(x)).filter((x) => x > 0 && Number.isFinite(x)).sort((a, b) => b - a);
  const k = Math.floor(v.length * kFraction);
  if (k < 5) return null;
  const xk = v[k]!;
  if (!(xk > 0)) return null;
  let s = 0;
  for (let i = 0; i < k; i += 1) s += Math.log(v[i]! / xk);
  const hill = s / k;
  return hill > 0 ? 1 / hill : null;
}

/** Max drawdown depth (fraction) of a cumulative-return price path built from log-returns. */
export function maxDrawdownDepth(returns: readonly number[]): number | null {
  const v = returns.filter(Number.isFinite);
  if (v.length === 0) return null;
  let logCum = 0; let peak = 0; let maxDd = 0;
  for (const r of v) {
    logCum += r; peak = Math.max(peak, logCum);
    maxDd = Math.max(maxDd, 1 - Math.exp(logCum - peak));
  }
  return maxDd;
}

/** Close-to-close log returns from a close series. */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const a = closes[i - 1]!; const b = closes[i]!;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

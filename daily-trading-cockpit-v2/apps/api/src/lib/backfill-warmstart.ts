/**
 * Historical backfill — warm-start candidate seeding (Phase 8 / requirement #8). Fits CANDIDATE models/priors
 * from the training-valid history. HARD guarantees, enforced structurally:
 *   • it produces ARTIFACTS only — it never writes CORTEX_LIVE_BETA (there is no path to it here),
 *   • it reports whether the 60-day live-shadow floor is met (it is NOT, with ~21 d of data) and NEVER lets
 *     history bypass it — `promotable` is always false while daysOfData < 60,
 *   • every candidate is shadow-only.
 * The logistic fit is a deterministic L2-regularized gradient descent (no RNG) with internal standardization,
 * mirroring the CORTEX pooled-shrinkage intent; the live CORTEX refit re-fits independently. Pure.
 */

export const LIVE_SHADOW_FLOOR_DAYS = 60;

export interface LogisticModel {
  featureKeys: readonly string[];
  weights: number[]; // in STANDARDIZED feature space
  bias: number;
  featureMean: number[];
  featureStd: number[];
  iterations: number;
  converged: boolean;
  logLoss: number;
  n: number;
  positiveRate: number;
}

/** Predict P(y=1) for a raw (un-standardized) feature vector. */
export function predictLogistic(m: LogisticModel, x: number[]): number | null {
  if (x.length !== m.weights.length) return null;
  let z = m.bias;
  for (let j = 0; j < x.length; j += 1) {
    const sd = m.featureStd[j]! || 1;
    z += m.weights[j]! * ((x[j]! - m.featureMean[j]!) / sd);
  }
  return 1 / (1 + Math.exp(-z));
}

export interface FitOpts {
  l2?: number; // ridge strength (shrinkage prior toward 0)
  lr?: number;
  iters?: number;
  tol?: number;
}

/** Deterministic L2-regularized logistic regression via full-batch gradient descent. Standardizes columns. */
export function fitLogisticL2(X: number[][], y: Array<0 | 1>, featureKeys: readonly string[], opts: FitOpts = {}): LogisticModel {
  const l2 = opts.l2 ?? 1.0;
  const lr = opts.lr ?? 0.1;
  const maxIters = opts.iters ?? 500;
  const tol = opts.tol ?? 1e-6;
  const n = X.length;
  const d = featureKeys.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(1);
  if (n > 0) {
    for (let j = 0; j < d; j += 1) {
      let m = 0;
      for (let i = 0; i < n; i += 1) m += X[i]![j]!;
      m /= n;
      let v = 0;
      for (let i = 0; i < n; i += 1) v += (X[i]![j]! - m) ** 2;
      v /= Math.max(1, n);
      mean[j] = m;
      std[j] = Math.sqrt(v) || 1;
    }
  }
  const Z = X.map((row) => row.map((v, j) => (v - mean[j]!) / std[j]!));
  const w = new Array(d).fill(0);
  let b = 0;
  const posRate = n ? y.reduce((a: number, v) => a + v, 0) / n : 0;
  b = Math.log((posRate + 1e-6) / (1 - posRate + 1e-6)); // warm bias at the base log-odds
  let prevLoss = Infinity;
  let iter = 0;
  let converged = false;
  for (; iter < maxIters && n > 0; iter += 1) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    let loss = 0;
    for (let i = 0; i < n; i += 1) {
      let z = b;
      for (let j = 0; j < d; j += 1) z += w[j]! * Z[i]![j]!;
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i]!;
      for (let j = 0; j < d; j += 1) gw[j] += err * Z[i]![j]!;
      gb += err;
      const eps = 1e-12;
      loss += -(y[i]! * Math.log(p + eps) + (1 - y[i]!) * Math.log(1 - p + eps));
    }
    for (let j = 0; j < d; j += 1) {
      gw[j] = gw[j]! / n + l2 * w[j]!; // ridge gradient
      w[j] = w[j]! - lr * gw[j]!;
    }
    b -= lr * (gb / n);
    loss = loss / n + (l2 / 2) * w.reduce((a, v) => a + v * v, 0);
    if (Math.abs(prevLoss - loss) < tol) {
      converged = true;
      iter += 1;
      prevLoss = loss;
      break;
    }
    prevLoss = loss;
  }
  return { featureKeys, weights: w, bias: b, featureMean: mean, featureStd: std, iterations: iter, converged, logLoss: prevLoss === Infinity ? 0 : prevLoss, n, positiveRate: posRate };
}

/** Class priors + reward summary for the discrete-target brains (Direction/Entry/Exit) — base rates the live
 *  brain can be seeded with (NOT a full model). Pure. */
export function computeClassPriors(labels: string[], netRByLabel: Map<string, number[]>): {
  base: Record<string, number>;
  meanNetR: Record<string, number | null>;
  n: number;
} {
  const base: Record<string, number> = {};
  for (const l of labels) base[l] = (base[l] ?? 0) + 1;
  const n = labels.length || 1;
  for (const k of Object.keys(base)) base[k] = base[k]! / n;
  const meanNetR: Record<string, number | null> = {};
  for (const [k, arr] of netRByLabel) {
    const u = arr.filter((v) => Number.isFinite(v));
    meanNetR[k] = u.length ? u.reduce((a, v) => a + v, 0) / u.length : null;
  }
  return { base, meanNetR, n: labels.length };
}

export interface WarmStartGuards {
  /** ALWAYS true here — this module has no reference to CORTEX_LIVE_BETA and cannot mutate it. */
  liveBetaUnchanged: true;
  /** ALWAYS true — candidates are artifacts, never wired to a live decision path. */
  shadowOnly: true;
  daysOfData: number;
  sixtyDayFloorMet: boolean;
  /** A candidate may be promoted to live ONLY if the floor is met AND a separate operator approval is given.
   *  History can never make this true on its own. */
  promotable: boolean;
}

export function warmStartGuards(spanMs: number): WarmStartGuards {
  const days = spanMs / 86_400_000;
  const met = days >= LIVE_SHADOW_FLOOR_DAYS;
  return { liveBetaUnchanged: true, shadowOnly: true, daysOfData: Math.round(days * 10) / 10, sixtyDayFloorMet: met, promotable: false };
}

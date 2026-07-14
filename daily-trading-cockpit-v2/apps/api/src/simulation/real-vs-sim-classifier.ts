/**
 * Real-vs-simulated discriminator (Market Digital Twin, Phase-1 foundation). Task: distinguish REAL market windows
 * from SIMULATED/bootstrap windows. Interpretation is asymmetric — HIGH validation AUC is STRONG evidence the
 * simulator is unrealistic; LOW AUC is NOT sufficient proof of realism (must be combined with distributional +
 * stylized-fact metrics). Implemented as a plain deterministic logistic-regression (batch gradient descent, no
 * heavy/unstable dependency). Dataset split enforces NO WINDOW OVERLAP across calibration / development / untouched
 * realism holdout so the holdout cannot be tuned against. Pure + deterministic given the feature vectors.
 */
import { mean, std, quantile, autocorr, hillTailIndex, maxDrawdownDepth } from "./calibration-metrics.js";

export type ClassifierSplit = "calibration" | "development" | "untouched-realism-holdout";

export interface LabeledWindow {
  /** 1 = REAL, 0 = SIMULATED. */
  label: 0 | 1;
  returns: number[];
  /** Source window [startIndex, endIndex) into its origin series — used for the overlap/leakage guard. */
  windowStart: number;
  windowEnd: number;
  origin: string; // distinct id per source series (real vs each sim path) so overlap is only checked within origin
  split: ClassifierSplit;
}

/** 9 deterministic distributional features per window (no leakage of raw prices/timestamps). */
export function windowFeatures(returns: number[]): number[] {
  const abs = returns.map(Math.abs);
  return [
    mean(returns) ?? 0,
    std(returns) ?? 0,
    quantile(returns, 0.05) ?? 0,
    quantile(returns, 0.95) ?? 0,
    autocorr(returns, 1) ?? 0,
    autocorr(abs, 1) ?? 0,
    hillTailIndex(returns) ?? 0,
    maxDrawdownDepth(returns) ?? 0,
    (quantile(abs, 0.99) ?? 0) - (quantile(abs, 0.5) ?? 0),
  ];
}

export interface LeakageReport { overlappingPairs: number; splitsPresent: ClassifierSplit[]; classBalance: Record<ClassifierSplit, { real: number; sim: number }>; }

/** Check that no window in one split overlaps a window of the SAME origin in another split (temporal leakage). */
export function checkLeakage(windows: readonly LabeledWindow[]): LeakageReport {
  let overlapping = 0;
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i]!; const b = windows[j]!;
      if (a.origin !== b.origin || a.split === b.split) continue;
      if (a.windowStart < b.windowEnd && b.windowStart < a.windowEnd) overlapping += 1;
    }
  }
  const classBalance = { calibration: { real: 0, sim: 0 }, development: { real: 0, sim: 0 }, "untouched-realism-holdout": { real: 0, sim: 0 } } as LeakageReport["classBalance"];
  for (const w of windows) classBalance[w.split][w.label === 1 ? "real" : "sim"] += 1;
  return { overlappingPairs: overlapping, splitsPresent: [...new Set(windows.map((w) => w.split))], classBalance };
}

// ── deterministic logistic regression ────────────────────────────────────────────────────────────────────────
function standardize(rows: number[][]): { z: number[][]; mu: number[]; sd: number[] } {
  const d = rows[0]?.length ?? 0;
  const mu = new Array(d).fill(0); const sd = new Array(d).fill(1);
  for (let k = 0; k < d; k += 1) {
    const col = rows.map((r) => r[k]!);
    mu[k] = mean(col) ?? 0; sd[k] = (std(col) ?? 1) || 1;
  }
  return { z: rows.map((r) => r.map((v, k) => (v - mu[k]!) / sd[k]!)), mu, sd };
}
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

export interface TrainedClassifier { weights: number[]; bias: number; mu: number[]; sd: number[]; }

/** Batch gradient descent (fixed iterations/lr ⇒ deterministic). L2-regularized. */
export function trainLogistic(features: number[][], labels: number[], opts: { iterations?: number; lr?: number; l2?: number } = {}): TrainedClassifier {
  const iterations = opts.iterations ?? 400; const lr = opts.lr ?? 0.1; const l2 = opts.l2 ?? 1e-3;
  const { z, mu, sd } = standardize(features);
  const d = z[0]?.length ?? 0;
  const w = new Array(d).fill(0); let b = 0;
  const n = z.length || 1;
  for (let it = 0; it < iterations; it += 1) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < z.length; i += 1) {
      const p = sigmoid(z[i]!.reduce((a, v, k) => a + v * w[k]!, b));
      const err = p - labels[i]!;
      for (let k = 0; k < d; k += 1) gw[k]! += err * z[i]![k]!;
      gb += err;
    }
    for (let k = 0; k < d; k += 1) w[k]! -= lr * (gw[k]! / n + l2 * w[k]!);
    b -= lr * (gb / n);
  }
  return { weights: w, bias: b, mu, sd };
}

export function predictProba(model: TrainedClassifier, feature: number[]): number {
  const z = feature.map((v, k) => (v - model.mu[k]!) / model.sd[k]!);
  return sigmoid(z.reduce((a, v, k) => a + v * model.weights[k]!, model.bias));
}

/** Rank-based ROC AUC (Mann–Whitney), or null if a class is absent. */
export function rocAuc(scores: readonly number[], labels: readonly number[]): number | null {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  const idx = scores.map((s, i) => ({ s, y: labels[i]! })).sort((a, b) => a.s - b.s);
  let rank = 1; let sumRanksPos = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i; while (j < idx.length && idx[j]!.s === idx[i]!.s) j += 1;
    const avgRank = (rank + (rank + (j - i) - 1)) / 2;
    for (let k = i; k < j; k += 1) if (idx[k]!.y === 1) sumRanksPos += avgRank;
    rank += j - i; i = j;
  }
  return (sumRanksPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/** AUC with orientation handled: rawAuc keeps the model's score direction; separabilityAuc = max(raw, 1-raw) is the
 *  ORIENTATION-INVARIANT detectability (a raw AUC near 0 OR near 1 both mean strong separability — the Phase-1B
 *  0.076 was actually 0.924 separable). The realism GATE must use separabilityAuc. positiveClass = REAL (label 1). */
export interface OrientedAuc { rawAuc: number | null; orientedAuc: number | null; separabilityAuc: number | null; }
export function orientAuc(raw: number | null): OrientedAuc {
  if (raw == null) return { rawAuc: null, orientedAuc: null, separabilityAuc: null };
  const sep = Math.max(raw, 1 - raw);
  return { rawAuc: raw, orientedAuc: raw >= 0.5 ? raw : 1 - raw, separabilityAuc: sep };
}

export interface ClassifierEvaluation {
  positiveClassDefinition: string;
  train: OrientedAuc;
  development: OrientedAuc;
  untouchedValidation: OrientedAuc;
  /** feature-ablation separabilityAuc on the development split (which feature groups drive detectability). */
  ablations: Record<string, number | null>;
  leakage: LeakageReport;
  interpretation: string;
}

const FEATURE_GROUPS: Record<string, number[]> = {
  returnVol: [0, 1, 2, 3], // mean/std/q05/q95
  dependenceAcf: [4, 5], // acf1(raw), acf1(abs)
  tailGeometry: [6, 7, 8], // hillTail, maxDD, tailSpread
};

/** Train on calibration, report ORIENTED AUCs per split + feature-group ablations. Holdout scored ONCE. */
export function evaluateClassifier(windows: readonly LabeledWindow[]): ClassifierEvaluation {
  const leakage = checkLeakage(windows);
  const by = (s: ClassifierSplit): LabeledWindow[] => windows.filter((w) => w.split === s);
  const cal = by("calibration");
  const trainable = cal.length >= 4 && new Set(cal.map((w) => w.label)).size === 2;
  const featOf = (w: LabeledWindow, idx?: number[]): number[] => { const f = windowFeatures(w.returns); return idx ? idx.map((i) => f[i]!) : f; };
  const auc = (idx: number[] | undefined, split: ClassifierSplit): number | null => {
    if (!trainable) return null;
    const model = trainLogistic(cal.map((w) => featOf(w, idx)), cal.map((w) => w.label));
    const ws = by(split); if (ws.length === 0) return null;
    return rocAuc(ws.map((w) => predictProba(model, featOf(w, idx))), ws.map((w) => w.label));
  };
  const ablations: Record<string, number | null> = {};
  for (const [name, idx] of Object.entries(FEATURE_GROUPS)) ablations[name] = orientAuc(auc(idx, "development")).separabilityAuc;
  ablations.fullFeatureSet = orientAuc(auc(undefined, "development")).separabilityAuc;
  return {
    positiveClassDefinition: "label 1 = REAL market window; label 0 = SIMULATED/bootstrap window",
    train: orientAuc(auc(undefined, "calibration")),
    development: orientAuc(auc(undefined, "development")),
    untouchedValidation: orientAuc(auc(undefined, "untouched-realism-holdout")),
    ablations, leakage,
    interpretation: "GATE on separabilityAuc = max(raw,1-raw). HIGH separability ⇒ detectably UNrealistic. LOW separability (~0.5) is necessary but NOT sufficient — combine with distributional + stylized-fact metrics.",
  };
}

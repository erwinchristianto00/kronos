/**
 * Seam-centered real-vs-sim classifier (Market Digital Twin, Phase 2C, Step 14). A full-path chance-level AUC can hide
 * highly-detectable SEAM windows; this evaluates the classifier specifically on windows CENTERED on generated joins vs
 * windows centered on real historical transitions. Reuses the frozen logistic + oriented-AUC machinery. Pure +
 * deterministic. GATE metric: separabilityAuc = max(raw, 1−raw); the seam-only track is the decisive one.
 */
import { windowFeatures, trainLogistic, predictProba, rocAuc, orientAuc, type LabeledWindow } from "./real-vs-sim-classifier.js";

export interface ClassifierRealismResult {
  rawAuc: number | null;
  separabilityAuc: number | null;
  groupedCi: [number, number] | null;
  domainConfounded: boolean;
  monthControlAuc: number | null;
  regimeMatchedAuc: number | null;
  seamExcludedAuc: number | null;
  seamOnlyAuc: number | null;
}

/** Return-windows centered on each seam index (join) of a generated return series: [s−half, s+half). */
export function seamCenteredWindows(returns: readonly number[], seamIndices: readonly number[], half: number): number[][] {
  const out: number[][] = [];
  for (const s of seamIndices) { const from = s - half; const to = s + half; if (from >= 0 && to <= returns.length) out.push(returns.slice(from, to)); }
  return out;
}

/** Non-seam return-windows (windows that do NOT straddle any seam) from a generated series. */
export function seamExcludedWindows(returns: readonly number[], seamIndices: readonly number[], win: number): number[][] {
  const straddles = (from: number, to: number) => seamIndices.some((s) => s > from + 1 && s < to - 1);
  const out: number[][] = [];
  for (let from = 0; from + win <= returns.length; from += win) if (!straddles(from, from + win)) out.push(returns.slice(from, from + win));
  return out;
}

/** Real transition windows: windows of width `win` centered on real adjacent boundaries, subsampled by `stride`. */
export function realTransitionWindows(returns: readonly number[], half: number, stride: number): number[][] {
  const out: number[][] = [];
  for (let c = half; c + half <= returns.length; c += stride) out.push(returns.slice(c - half, c + half));
  return out;
}

/** Grouped-by-origin bootstrap CI of the separability AUC (resample origins with replacement). */
function groupedAucCI(model: ReturnType<typeof trainLogistic>, ws: readonly LabeledWindow[], rng: { nextInt(a: number, b: number): number }, iters = 400, alpha = 0.1): [number, number] | null {
  if (ws.length === 0) return null;
  const byGroup = new Map<string, LabeledWindow[]>();
  for (const w of ws) { const g = byGroup.get(w.origin); if (g) g.push(w); else byGroup.set(w.origin, [w]); }
  const groups = [...byGroup.values()]; const aucs: number[] = [];
  for (let b = 0; b < iters; b += 1) { const sample: LabeledWindow[] = []; for (let g = 0; g < groups.length; g += 1) sample.push(...groups[rng.nextInt(0, groups.length)]!); const raw = rocAuc(sample.map((w) => predictProba(model, windowFeatures(w.returns))), sample.map((w) => w.label)); if (raw != null) aucs.push(orientAuc(raw).separabilityAuc!); }
  if (!aucs.length) return null; aucs.sort((a, b) => a - b);
  return [aucs[Math.floor((alpha / 2) * aucs.length)] ?? aucs[0]!, aucs[Math.min(aucs.length - 1, Math.ceil((1 - alpha / 2) * aucs.length) - 1)] ?? aucs.at(-1)!];
}

/**
 * Train on `trainWindows` (labeled) and evaluate separability on `evalWindows`, with a grouped CI. real = label 1.
 * Returns oriented separability + rawAuc + grouped CI. Windows must carry an `origin` for grouping.
 */
export function evaluateSeamClassifier(trainWindows: readonly LabeledWindow[], evalWindows: readonly LabeledWindow[], rng: { nextInt(a: number, b: number): number }): { rawAuc: number | null; separabilityAuc: number | null; groupedCi: [number, number] | null } {
  const trainable = trainWindows.length >= 4 && new Set(trainWindows.map((w) => w.label)).size === 2 && evalWindows.length > 0 && new Set(evalWindows.map((w) => w.label)).size === 2;
  if (!trainable) return { rawAuc: null, separabilityAuc: null, groupedCi: null };
  const model = trainLogistic(trainWindows.map((w) => windowFeatures(w.returns)), trainWindows.map((w) => w.label));
  const raw = rocAuc(evalWindows.map((w) => predictProba(model, windowFeatures(w.returns))), evalWindows.map((w) => w.label));
  const o = orientAuc(raw);
  return { rawAuc: o.rawAuc, separabilityAuc: o.separabilityAuc, groupedCi: groupedAucCI(model, evalWindows, rng) };
}

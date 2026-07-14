/**
 * Seam realism evaluation (Market Digital Twin, Phase 2B, Step 10). Evaluates SEAM behavior separately from whole-path
 * behavior and compares GENERATED seams against the NATURAL adjacent-hour baseline in the real source, using GROUPED
 * bootstrap confidence intervals (resampled by source day/block, not by individual dependent seams). Pure +
 * deterministic given the injected RNG. Never smooths — only measures.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import { assessStitch, type StitchTolerances, DEFAULT_STITCH_TOLERANCES } from "./historical-block-bootstrap.js";

export interface SeamRealismResult {
  generatedRejectRate: number;
  naturalRejectRate: number;
  excessRejectRate: number;
  rejectRateRatio: number; // generated / natural (null-safe: Infinity if natural is 0 and generated > 0)
  confidenceInterval: [number, number]; // grouped-bootstrap 90% CI on the GENERATED reject rate
  excessConfidenceInterval: [number, number]; // grouped-bootstrap 90% CI on (generated − natural)
  reasons: Record<string, number>; // rejection-reason counts among generated seams
  nSeams: number;
  nGroups: number;
}

/** Classify one assessStitch reason string into a coarse bucket. */
function reasonBucket(reason: string): string {
  if (reason.includes("price gap")) return "priceGap";
  if (reason.includes("volatility ratio")) return "volatilityRatio";
  if (reason.includes("volume ratio")) return "volumeRatio";
  return "other";
}

/** Natural adjacent-candle reject rate + reasons in the REAL source under the SAME tolerances used for seams. Also
 *  returns each adjacency as a grouped item (by source day) so the excess-rate CI can bootstrap the natural baseline's
 *  OWN sampling uncertainty rather than treating it as a fixed constant. */
export function naturalAdjacencyReject(frames: readonly CommonMarketFrame[], symbols: string[], tol: StitchTolerances = DEFAULT_STITCH_TOLERANCES): { rate: number; reasons: Record<string, number>; n: number; items: { value: number; group: string | number }[] } {
  let rejected = 0; let n = 0; const reasons: Record<string, number> = {};
  const items: { value: number; group: string | number }[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const st = assessStitch(frames[i - 1]!, frames[i]!, symbols, tol);
    n += 1;
    const day = new Date(frames[i - 1]!.asOfMs).toISOString().slice(0, 10);
    items.push({ value: st.accepted ? 0 : 1, group: day });
    if (!st.accepted) { rejected += 1; for (const r of st.reasons) reasons[reasonBucket(r)] = (reasons[reasonBucket(r)] ?? 0) + 1; }
  }
  return { rate: n ? rejected / n : 0, reasons, n, items };
}

/** Group item values by their group key. */
function groupBy(items: { value: number; group: string | number }[]): number[][] {
  const byGroup = new Map<string | number, number[]>();
  for (const it of items) { const g = byGroup.get(it.group); if (g) g.push(it.value); else byGroup.set(it.group, [it.value]); }
  return [...byGroup.values()];
}
/** One grouped-bootstrap draw of the mean: resample GROUPS with replacement, pool their items, return the mean. */
function bootstrapMean(groups: number[][], rng: { nextInt(a: number, b: number): number }): number {
  if (groups.length === 0) return 0;
  let sum = 0; let count = 0;
  for (let g = 0; g < groups.length; g += 1) { const pick = groups[rng.nextInt(0, groups.length)]!; for (const v of pick) { sum += v; count += 1; } }
  return count ? sum / count : 0;
}
/** Grouped bootstrap percentile CI of a mean, resampling GROUPS (not items) with replacement. */
export function groupedBootstrapMeanCI(items: { value: number; group: string | number }[], rng: { nextInt(a: number, b: number): number }, iterations = 1000, alpha = 0.1): [number, number] {
  const groups = groupBy(items);
  if (groups.length === 0) return [0, 0];
  const means: number[] = [];
  for (let b = 0; b < iterations; b += 1) means.push(bootstrapMean(groups, rng));
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * means.length)] ?? means[0]!;
  const hi = means[Math.min(means.length - 1, Math.ceil((1 - alpha / 2) * means.length) - 1)] ?? means.at(-1)!;
  return [lo, hi];
}

/**
 * Combine per-seam reject decisions (each with a source-day/block group id) with the natural baseline into a
 * SeamRealismResult. Grouped bootstrap CI accounts for within-day dependence of seams.
 */
export function computeSeamRealism(generatedSeams: { rejected: boolean; reasons: string[]; group: string | number }[], natural: { rate: number; items?: { value: number; group: string | number }[] }, rng: { nextInt(a: number, b: number): number }, iterations = 1000): SeamRealismResult {
  const nSeams = generatedSeams.length;
  const generatedRejectRate = nSeams ? generatedSeams.filter((s) => s.rejected).length / nSeams : 0;
  const reasons: Record<string, number> = {};
  for (const s of generatedSeams) if (s.rejected) for (const r of s.reasons) reasons[reasonBucket(r)] = (reasons[reasonBucket(r)] ?? 0) + 1;
  const items = generatedSeams.map((s) => ({ value: s.rejected ? 1 : 0, group: s.group }));
  const ci = groupedBootstrapMeanCI(items, rng, iterations);
  // Excess CI: bootstrap the generated rate AND (if per-adjacency items are supplied) the natural rate independently,
  // so the CI reflects BOTH sources of uncertainty — not a fixed-constant natural subtracted from the generated CI.
  let excessCi: [number, number];
  if (natural.items && natural.items.length) {
    const excessDraws: number[] = [];
    const genByGroup = groupBy(items); const natByGroup = groupBy(natural.items);
    for (let b = 0; b < iterations; b += 1) excessDraws.push(bootstrapMean(genByGroup, rng) - bootstrapMean(natByGroup, rng));
    excessDraws.sort((a, b) => a - b);
    excessCi = [excessDraws[Math.floor(0.05 * excessDraws.length)] ?? excessDraws[0]!, excessDraws[Math.min(excessDraws.length - 1, Math.ceil(0.95 * excessDraws.length) - 1)] ?? excessDraws.at(-1)!];
  } else {
    excessCi = groupedBootstrapMeanCI(items.map((it) => ({ value: it.value - natural.rate, group: it.group })), rng, iterations);
  }
  const nGroups = new Set(generatedSeams.map((s) => s.group)).size;
  return {
    generatedRejectRate,
    naturalRejectRate: natural.rate,
    excessRejectRate: generatedRejectRate - natural.rate,
    rejectRateRatio: natural.rate > 0 ? generatedRejectRate / natural.rate : (generatedRejectRate > 0 ? Number.POSITIVE_INFINITY : 0),
    confidenceInterval: ci,
    excessConfidenceInterval: excessCi,
    reasons, nSeams, nGroups,
  };
}

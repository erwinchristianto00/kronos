/**
 * Tier-A candle-proof — extra statistics for the six-month analysis. All DETERMINISTIC: the bootstrap uses a
 * SEEDED PRNG (mulberry32) with a fixed seed so the confidence interval is reproducible (preserves the
 * deterministic-rerun property). Pure — no I/O, no Date.now, no global Math.random.
 */

/** Deterministic PRNG (mulberry32). Same seed ⇒ same stream ⇒ reproducible bootstrap. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI { point: number | null; lo: number | null; hi: number | null; iters: number; blocks: number; alpha: number; }

/**
 * CLUSTERED (day-block) bootstrap CI for the mean of `values`, resampling whole TRADING DAYS with replacement.
 * Overlapping-horizon rows within a day are correlated, so the day — not the row — is the independent unit. The
 * statistic is the mean over all rows in the resampled set of days. Deterministic via seed.
 */
export function clusteredBootstrapMeanCI(
  rows: Array<{ dayKey: number; value: number }>,
  opts: { iters?: number; seed?: number; alpha?: number } = {},
): BootstrapCI {
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 0x00c0ffee);
  const usable = rows.filter((r) => Number.isFinite(r.value));
  // group rows by day
  const byDay = new Map<number, number[]>();
  for (const r of usable) { const arr = byDay.get(r.dayKey) ?? []; arr.push(r.value); byDay.set(r.dayKey, arr); }
  const days = [...byDay.keys()];
  const D = days.length;
  const point = usable.length ? usable.reduce((a, r) => a + r.value, 0) / usable.length : null;
  if (D < 2 || point == null) return { point, lo: null, hi: null, iters: 0, blocks: D, alpha };

  const means: number[] = [];
  for (let b = 0; b < iters; b += 1) {
    let sum = 0, cnt = 0;
    for (let k = 0; k < D; k += 1) {
      const day = days[Math.floor(rng() * D)]!; // sample a day with replacement
      const vals = byDay.get(day)!;
      for (const v of vals) { sum += v; cnt += 1; }
    }
    if (cnt > 0) means.push(sum / cnt);
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means.length ? means[Math.min(means.length - 1, Math.max(0, Math.round(p * (means.length - 1))))]! : null;
  return { point, lo: q(alpha / 2), hi: q(1 - alpha / 2), iters: means.length, blocks: D, alpha };
}

/** State persistence: P(family_{t+1} == family_t) within a contiguous per-symbol sequence. transitionRate = 1−persistence. */
export function statePersistence(sequence: string[]): { persistence: number | null; transitionRate: number | null; transitions: number; pairs: number } {
  let same = 0, pairs = 0;
  for (let i = 1; i < sequence.length; i += 1) { pairs += 1; if (sequence[i] === sequence[i - 1]) same += 1; }
  if (pairs === 0) return { persistence: null, transitionRate: null, transitions: 0, pairs: 0 };
  const persistence = same / pairs;
  return { persistence, transitionRate: 1 - persistence, transitions: pairs - same, pairs };
}

/**
 * Overlap-adjusted effective sample size for OVERLAPPING horizon returns. With a horizon of H bars, consecutive
 * decisions share H−1 bars of their outcome window, so the naive row count massively overstates independence.
 * Report BOTH a horizon-deflated estimate (N/H) and the unique-trading-day count as complementary floors.
 */
export function overlapAdjustedEss(nRows: number, horizonBars: number, uniqueDays: number): { nRows: number; horizonBars: number; essByHorizon: number; uniqueDays: number; essFloor: number } {
  const essByHorizon = horizonBars > 0 ? Math.floor(nRows / horizonBars) : nRows;
  return { nRows, horizonBars, essByHorizon, uniqueDays, essFloor: Math.min(essByHorizon, uniqueDays) };
}

/** Coefficient stability across folds/months: per-feature sign-consistency + mean/std of the (standardized) weights. */
export function coefficientStability(featureKeys: readonly string[], perFoldWeights: number[][]): Array<{ feature: string; meanWeight: number | null; stdWeight: number | null; signConsistency: number | null; folds: number }> {
  return featureKeys.map((f, j) => {
    const ws = perFoldWeights.map((w) => w[j]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (ws.length === 0) return { feature: f, meanWeight: null, stdWeight: null, signConsistency: null, folds: 0 };
    const mean = ws.reduce((a, v) => a + v, 0) / ws.length;
    const variance = ws.reduce((a, v) => a + (v - mean) ** 2, 0) / ws.length;
    const pos = ws.filter((v) => v > 0).length, neg = ws.filter((v) => v < 0).length;
    // sign-consistency = share agreeing with the majority sign (1 = all same sign, 0.5 = evenly split).
    const signConsistency = ws.length ? Math.max(pos, neg) / ws.length : null;
    return { feature: f, meanWeight: mean, stdWeight: Math.sqrt(variance), signConsistency, folds: ws.length };
  });
}

export const mean = (a: number[]): number | null => { const u = a.filter((v) => Number.isFinite(v)); return u.length ? u.reduce((x, v) => x + v, 0) / u.length : null; };

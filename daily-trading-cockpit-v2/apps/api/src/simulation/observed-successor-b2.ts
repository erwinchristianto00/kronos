/**
 * METHOD_B2_INDEPENDENT_SUCCESSOR (Phase-2C robustness, Step 5). An INDEPENDENT implementation of the one-step
 * observed-successor concept (same scientific contract as Method B) with a deliberately different code path — to detect
 * implementation-specific success. Differences from Method B (`observed-transition-selection.ts` ONE_STEP_SUCCESSOR):
 *   - candidate lookup: a REGIME×VOL-bucket INDEX (not a linear scan over RELAX levels);
 *   - distance: a normalized L2 over the numeric features + categorical penalties (not the mean-abs + per-component
 *     support gate of assessCompatibility);
 *   - support: a single scalar RADIUS (not per-component supportSigma);
 *   - fallback: bucket → same-regime(any vol) → all (not the RELAX feature-shrink hierarchy);
 *   - tie handling: strict `<` running-min keyed by (distance, then continuationId) — an explicit deterministic rule.
 * Reuses only pure types + the calibration normalizer + computeTerminalState + the continuation library. Deterministic.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import type { BlockRef } from "./historical-block-bootstrap.js";
import type { DeterministicRng } from "./deterministic-rng.js";
import { computeTerminalState, type BlockTransitionState, type CalibrationVolumeBaseline } from "./block-transition-state.js";
import { NUMERIC_FEATURES, type CompatibilityNormalizer } from "./block-compatibility.js";
import type { HistoricalContinuationRecord } from "./historical-continuation-library.js";
import { computeMemoization, type ObservedSeamDiagnostic, type ReplayMemoizationReport } from "./observed-transition-selection.js";

export interface B2Constraints { maxUnchangedRunHours: number; maxSuccessorReuse: number; maxMonthFraction: number; supportRadius: number; minMatches: number; }
export const DEFAULT_B2_CONSTRAINTS: B2Constraints = { maxUnchangedRunHours: 144, maxSuccessorReuse: 4, maxMonthFraction: 0.5, supportRadius: 2.5, minMatches: 5 };

export interface B2SelectionResult { blocks: BlockRef[]; seams: ObservedSeamDiagnostic[]; insufficientSeams: number; status: "OK" | "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT"; memoization: ReplayMemoizationReport; }

const volBucket = (v: number): string => (v > 0.006 ? "H" : v > 0.003 ? "M" : "L");
const bucketKey = (s: BlockTransitionState): string => `${s.regimeFamily ?? "?"}|${volBucket(s.volatilityMedium)}`;
const regimeKey = (s: BlockTransitionState): string => `${s.regimeFamily ?? "?"}`;
const monthOf = (frames: readonly CommonMarketFrame[], start: number): string => new Date(frames[start]?.asOfMs ?? 0).toISOString().slice(0, 7);

/** Independent normalized-L2 distance (numeric features scaled by calibration scales) + hard categorical penalties. */
function l2Distance(t: BlockTransitionState, c: BlockTransitionState, norm: CompatibilityNormalizer): number {
  let sum = 0; let n = 0;
  for (const f of NUMERIC_FEATURES) { const tv = t[f]; const cv = c[f]; if (typeof tv === "number" && typeof cv === "number" && Number.isFinite(tv) && Number.isFinite(cv)) { const d = (tv - cv) / norm.scales[f]; sum += d * d; n += 1; } }
  let dist = n > 0 ? Math.sqrt(sum / n) : Number.POSITIVE_INFINITY; // RMS of normalized component distances
  if (t.regimeFamily !== c.regimeFamily) dist += 1e6; // regime mismatch is disqualifying
  if (t.weekend !== c.weekend) dist += 0.25;
  return dist;
}

export function selectB2SuccessorBlocks(args: { source: readonly CommonMarketFrame[]; library: readonly HistoricalContinuationRecord[]; normalizer: CompatibilityNormalizer; baseline: CalibrationVolumeBaseline; btc: string; eth: string; lookback: number; targetLen: number; rng: DeterministicRng; constraints: B2Constraints }): B2SelectionResult {
  const { source, library, normalizer, baseline, btc, eth, lookback, targetLen, rng, constraints } = args;
  // build the regime×vol bucket index + per-regime index (independent lookup structures)
  const byBucket = new Map<string, HistoricalContinuationRecord[]>(); const byRegime = new Map<string, HistoricalContinuationRecord[]>();
  for (const r of library) { const bk = bucketKey(r.terminalState); const rk = regimeKey(r.terminalState); (byBucket.get(bk) ?? byBucket.set(bk, []).get(bk)!).push(r); (byRegime.get(rk) ?? byRegime.set(rk, []).get(rk)!).push(r); }

  const blocks: BlockRef[] = []; const seams: ObservedSeamDiagnostic[] = [];
  const successorUse = new Map<number, number>(); const monthDur = new Map<string, number>();
  let insufficientSeams = 0; let placed = 0; let total = 0; let unchangedRun = 0; let longestRun = 0;
  const monthDurCap = Math.max(1, constraints.maxMonthFraction * targetLen);
  const eligible = (r: HistoricalContinuationRecord, len: number, prevEnd: number): boolean => {
    if ((successorUse.get(r.successorRef.startIndex) ?? 0) >= constraints.maxSuccessorReuse) return false;
    if ((monthDur.get(monthOf(source, r.successorRef.startIndex)) ?? 0) + len > monthDurCap) return false;
    if (r.successorRef.startIndex === prevEnd && unchangedRun + len > constraints.maxUnchangedRunHours) return false;
    return r.successorRef.startIndex + len <= source.length;
  };
  const commit = (r: HistoricalContinuationRecord) => {
    const s = r.successorRef.startIndex; const len = r.successorRef.length; const contiguous = blocks.length > 0 && s === (blocks.at(-1)!.startIndex + blocks.at(-1)!.length);
    blocks.push({ startIndex: s, length: len });
    successorUse.set(s, (successorUse.get(s) ?? 0) + 1); monthDur.set(monthOf(source, s), (monthDur.get(monthOf(source, s)) ?? 0) + len);
    unchangedRun = contiguous ? unchangedRun + len : len; longestRun = Math.max(longestRun, unchangedRun); placed += 1; total += len;
    return contiguous;
  };

  while (total < targetLen) {
    if (blocks.length === 0) {
      const pool = library.filter((r) => eligible(r, r.successorRef.length, -1));
      const rec = pool[rng.nextInt(0, pool.length)]!; commit(rec);
      seams.push({ seamIndex: 0, matchPoolSize: pool.length, compatibleCount: pool.length, effectiveMatchSampleSize: pool.length, selectedRank: -1, matchDistance: null, fallbackLevel: "SEED_START", sourceContiguous: false, unchangedRunHours: unchangedRun, selectedSuccessorStart: rec.successorRef.startIndex });
      continue;
    }
    const prev = blocks.at(-1)!; const prevEnd = prev.startIndex + prev.length;
    const genTerminal = computeTerminalState(source, prev.startIndex, prev.length, baseline, btc, eth, lookback);
    // independent fallback ladder: bucket → same-regime(any vol) → whole library
    const ladders: { name: string; pool: readonly HistoricalContinuationRecord[] }[] = [
      { name: "BUCKET", pool: byBucket.get(bucketKey(genTerminal)) ?? [] },
      { name: "REGIME", pool: byRegime.get(regimeKey(genTerminal)) ?? [] },
      { name: "ALL", pool: library },
    ];
    let chosen: { rec: HistoricalContinuationRecord; dist: number; level: string; count: number } | null = null;
    for (const l of ladders) {
      const within: { rec: HistoricalContinuationRecord; dist: number }[] = [];
      for (const r of l.pool) { if (!eligible(r, r.successorRef.length, prevEnd)) continue; const d = l2Distance(genTerminal, r.terminalState, normalizer); if (d <= constraints.supportRadius) within.push({ rec: r, dist: d }); }
      if (within.length < constraints.minMatches) continue;
      // deterministic running-min: smaller distance wins; tie → smaller continuationId (explicit, independent rule)
      let best = within[0]!; for (const w of within) if (w.dist < best.dist || (w.dist === best.dist && w.rec.continuationId < best.rec.continuationId)) best = w;
      chosen = { rec: best.rec, dist: best.dist, level: l.name, count: within.length }; break;
    }
    const seamIndex = seams.length;
    if (!chosen) { insufficientSeams += 1; seams.push({ seamIndex, matchPoolSize: library.length, compatibleCount: 0, effectiveMatchSampleSize: 0, selectedRank: -1, matchDistance: null, fallbackLevel: "INSUFFICIENT_COMPATIBLE_BLOCKS", sourceContiguous: false, unchangedRunHours: unchangedRun, selectedSuccessorStart: -1 }); break; }
    const contiguous = commit(chosen.rec);
    seams.push({ seamIndex, matchPoolSize: library.length, compatibleCount: chosen.count, effectiveMatchSampleSize: chosen.count, selectedRank: 0, matchDistance: chosen.dist, fallbackLevel: chosen.level, sourceContiguous: contiguous, unchangedRunHours: unchangedRun, selectedSuccessorStart: chosen.rec.successorRef.startIndex });
  }
  const status = insufficientSeams > 0 ? "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT" : "OK";
  return { blocks, seams, insufficientSeams, status, memoization: computeMemoization(blocks, source, longestRun, btc) };
}

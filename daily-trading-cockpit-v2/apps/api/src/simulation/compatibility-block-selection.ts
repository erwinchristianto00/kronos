/**
 * Compatibility-conditioned synchronized block selection (Market Digital Twin, Phase 2B). Phase 2B improves HOW source
 * blocks are chosen — it never manipulates post-selection candles (the frozen return-space reconstruction math is
 * untouched). BTC and ETH are always selected as ONE synchronized block (a single source [start,len) drives both).
 * Selection conditions each new block's start on the current terminal state via a pre-registered compatibility
 * distance + fallback hierarchy, with anti-memorization / source-concentration constraints. Fully deterministic given
 * the injected RNG. Methods: A random baseline, B hard filter, C top-K nearest, D transition kernel, E compatibility-
 * conditioned stationary bootstrap.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import type { BlockRef } from "./historical-block-bootstrap.js";
import type { DeterministicRng } from "./deterministic-rng.js";
import { computeTerminalState, computeInitialState, type BlockTransitionState, type CalibrationVolumeBaseline, CANDIDATE_PREFIX_LEN } from "./block-transition-state.js";
import { assessCompatibility, RELAX_LEVELS, INSUFFICIENT, type CompatibilityNormalizer, type BlockCompatibilityAssessment } from "./block-compatibility.js";

export type SelectionStrategy = "RANDOM_BASELINE" | "HARD_FILTER" | "NEAREST_K" | "TRANSITION_KERNEL" | "COMPAT_STATIONARY";

export interface ConcentrationConstraints {
  maxUsePerBlock: number; // a source block start may be reused at most this many times
  maxMonthFraction: number; // no single source month may contribute more than this fraction of blocks
  cooldown: number; // a block start may not be reused within this many placements
  topK: number; // for NEAREST_K
  minCompatible: number; // need ≥ this many compatible candidates at a level, else relax/fallback
  minCellSupport: number; // transition-kernel: a from-cell needs ≥ this many observed transitions
}
export const DEFAULT_CONSTRAINTS: ConcentrationConstraints = { maxUsePerBlock: 4, maxMonthFraction: 0.5, cooldown: 8, topK: 12, minCompatible: 5, minCellSupport: 20 };

export interface SeamDiagnostic {
  seamIndex: number;
  candidatePoolSize: number;
  compatibleCount: number;
  effectiveCandidateSampleSize: number;
  selectedCandidateRank: number;
  transitionCellSampleCount: number | null;
  fallbackLevel: string;
  selectedStartIndex: number;
}
export interface ConcentrationReport {
  top1: number; top5: number; top10: number;
  effectiveNumberOfBlocks: number; // (Σn)² / Σn²
  uniqueBlockCoverage: number; // distinct source blocks used / blocks placed
  monthConcentrationMax: number; // largest single-month share
  monthEntropy: number; // Shannon entropy (nats) over source months
  transitionCellConcentrationMax: number; // largest single selected-initial-cell share
  duplicateSequenceCount: number; // repeated consecutive start-subsequences of length ≥ 3
}
export interface CompatibilitySelectionResult {
  strategy: SelectionStrategy;
  blocks: BlockRef[];
  seams: SeamDiagnostic[];
  insufficientSeams: number;
  status: "OK" | "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT";
  concentration: ConcentrationReport;
  fallbackLevelCounts: Record<string, number>;
}

// ── state bucketing for the transition kernel ────────────────────────────────────────────────────────────────────
function volBucket(v: number): string { return v > 0.006 ? "H" : v > 0.003 ? "M" : "L"; }
function vzsBucket(z: number): string { return z > 0.5 ? "P" : z < -0.5 ? "N" : "M"; }
export function stateCell(s: BlockTransitionState): string { return `${s.regimeFamily ?? "?"}|vol${volBucket(s.volatilityMedium)}|vzs${vzsBucket(s.volumeZScore)}`; }

const monthOf = (frames: readonly CommonMarketFrame[], start: number): string => new Date(frames[start]?.asOfMs ?? 0).toISOString().slice(0, 7);

/** Precompute initial states for every candidate start (prefix-only; length-independent). */
export function precomputeInitialStates(frames: readonly CommonMarketFrame[], starts: readonly number[], baseline: CalibrationVolumeBaseline, btc: string, eth: string): Map<number, BlockTransitionState> {
  const m = new Map<number, BlockTransitionState>();
  for (const s of starts) m.set(s, computeInitialState(frames, s, baseline, btc, eth));
  return m;
}

/** Empirical terminal→initial transition counts over REAL adjacencies (frozen state buckets). */
export function buildTransitionKernel(frames: readonly CommonMarketFrame[], baseline: CalibrationVolumeBaseline, btc: string, eth: string, lookback: number): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  // for each interior candle i: from = terminal cell of the window ending at i; to = initial cell of prefix at i+1
  for (let i = lookback; i < frames.length - CANDIDATE_PREFIX_LEN - 1; i += 1) {
    const from = stateCell(computeTerminalState(frames, i - lookback, lookback, baseline, btc, eth, lookback));
    const to = stateCell(computeInitialState(frames, i + 1, baseline, btc, eth));
    let row = counts.get(from); if (!row) { row = new Map(); counts.set(from, row); }
    row.set(to, (row.get(to) ?? 0) + 1);
  }
  return counts;
}

function effectiveSampleSize(weights: readonly number[]): number {
  const sum = weights.reduce((a, w) => a + w, 0); const sumSq = weights.reduce((a, w) => a + w * w, 0);
  return sumSq > 0 ? (sum * sum) / sumSq : 0;
}

interface SelectArgs {
  strategy: SelectionStrategy;
  frames: readonly CommonMarketFrame[];
  candidateStarts: number[]; // valid starts (respecting max block length so start+len ≤ sourceLen)
  initialStates: Map<number, BlockTransitionState>;
  normalizer: CompatibilityNormalizer;
  baseline: CalibrationVolumeBaseline;
  btc: string; eth: string;
  blockLen: number; // fixed length (also the mean for COMPAT_STATIONARY)
  targetLen: number;
  lookback: number;
  rng: DeterministicRng;
  constraints: ConcentrationConstraints;
  kernel?: Map<string, Map<string, number>>;
}

/** Core compatibility-conditioned selection loop (B/C/D/E). */
export function selectCompatibilityBlocks(args: SelectArgs): CompatibilitySelectionResult {
  const { frames, candidateStarts, initialStates, normalizer, baseline, btc, eth, targetLen, lookback, rng, constraints, strategy } = args;
  const blocks: BlockRef[] = [];
  const seams: SeamDiagnostic[] = [];
  const fallbackLevelCounts: Record<string, number> = {};
  const useCount = new Map<number, number>();
  const lastUsedAt = new Map<number, number>();
  const monthCount = new Map<string, number>();
  let insufficientSeams = 0;
  let placed = 0; let total = 0;
  const geoP = 1 / Math.max(1, args.blockLen);

  const passesConcentration = (start: number, len: number): boolean => {
    if ((useCount.get(start) ?? 0) >= constraints.maxUsePerBlock) return false;
    const la = lastUsedAt.get(start); if (la != null && placed - la < constraints.cooldown) return false;
    const mo = monthOf(frames, start);
    const maxForMonth = Math.max(1, Math.ceil((targetLen / Math.max(1, args.blockLen)) * constraints.maxMonthFraction));
    if ((monthCount.get(mo) ?? 0) >= maxForMonth) return false;
    // block must fit
    return start + len <= frames.length;
  };
  const record = (start: number, len: number) => {
    blocks.push({ startIndex: start, length: len });
    useCount.set(start, (useCount.get(start) ?? 0) + 1);
    lastUsedAt.set(start, placed);
    monthCount.set(monthOf(frames, start), (monthCount.get(monthOf(frames, start)) ?? 0) + 1);
    placed += 1; total += len;
  };
  const bump = (lvl: string) => { fallbackLevelCounts[lvl] = (fallbackLevelCounts[lvl] ?? 0) + 1; };

  while (total < targetLen) {
    const len = strategy === "COMPAT_STATIONARY" ? geometricLen(rng, geoP, frames.length) : args.blockLen;
    // First block: seeded random start (no terminal state yet).
    if (blocks.length === 0) {
      const pool = candidateStarts.filter((s) => s + len <= frames.length);
      const start = pool[rng.nextInt(0, pool.length)]!;
      record(start, len);
      seams.push({ seamIndex: 0, candidatePoolSize: pool.length, compatibleCount: pool.length, effectiveCandidateSampleSize: pool.length, selectedCandidateRank: -1, transitionCellSampleCount: null, fallbackLevel: "SEED_START", selectedStartIndex: start });
      bump("SEED_START");
      continue;
    }
    const prev = blocks.at(-1)!;
    const terminal = computeTerminalState(frames, prev.startIndex, prev.length, baseline, btc, eth, lookback);
    const pool = candidateStarts.filter((s) => passesConcentration(s, len));
    const seamIndex = seams.length;

    // ── TRANSITION_KERNEL: sample a target cell first, restrict pool to that cell ──
    if (strategy === "TRANSITION_KERNEL" && args.kernel) {
      const fromCell = stateCell(terminal);
      const row = args.kernel.get(fromCell);
      const rowTotal = row ? [...row.values()].reduce((a, v) => a + v, 0) : 0;
      if (row && rowTotal >= constraints.minCellSupport) {
        const cells = [...row.keys()]; const weights = cells.map((c) => row.get(c)!);
        const targetCell = cells[rng.sampleIndex(weights)]!;
        const cellPool = pool.filter((s) => stateCell(initialStates.get(s)!) === targetCell);
        // Enforce the SAME minCompatible diversity floor the distance hierarchy uses — a thin target cell must NOT be
        // allowed to concentrate on one block; fall through to the distance fallback instead.
        if (cellPool.length >= constraints.minCompatible) {
          const pick = cellPool[rng.nextInt(0, cellPool.length)]!;
          record(pick, len);
          seams.push({ seamIndex, candidatePoolSize: pool.length, compatibleCount: cellPool.length, effectiveCandidateSampleSize: cellPool.length, selectedCandidateRank: 0, transitionCellSampleCount: rowTotal, fallbackLevel: `KERNEL:${fromCell}->${targetCell}`, selectedStartIndex: pick });
          bump("KERNEL");
          continue;
        }
      }
      // kernel unsupported ⇒ fall through to the distance fallback hierarchy (still recorded honestly)
    }

    // ── distance fallback hierarchy (B/C/E, and D's fallback) ──
    let chosen: { start: number; rank: number; ess: number; level: string; compatibleCount: number } | null = null;
    for (const level of RELAX_LEVELS) {
      const assessed: (BlockCompatibilityAssessment & { start: number })[] = [];
      for (const s of pool) {
        const a = assessCompatibility(String(s), terminal, initialStates.get(s)!, normalizer, level.features);
        if (a.withinEmpiricalSupport && Number.isFinite(a.totalDistance)) assessed.push({ ...a, start: s });
      }
      if (assessed.length < constraints.minCompatible) continue;
      assessed.sort((a, b) => a.totalDistance - b.totalDistance);
      assessed.forEach((a, i) => { a.candidateRank = i; });
      if (strategy === "NEAREST_K") {
        const topK = assessed.slice(0, Math.min(constraints.topK, assessed.length));
        const weights = topK.map((a) => 1 / (a.totalDistance + 1e-3));
        const idx = rng.sampleIndex(weights);
        chosen = { start: topK[idx]!.start, rank: idx, ess: effectiveSampleSize(weights), level: level.name, compatibleCount: assessed.length };
      } else {
        // HARD_FILTER / COMPAT_STATIONARY / KERNEL-fallback: uniform seeded pick among compatible
        const weights = assessed.map(() => 1);
        const idx = rng.nextInt(0, assessed.length);
        chosen = { start: assessed[idx]!.start, rank: assessed[idx]!.candidateRank, ess: effectiveSampleSize(weights), level: level.name, compatibleCount: assessed.length };
      }
      break;
    }

    if (!chosen) {
      // no level yielded ≥ minCompatible compatible blocks ⇒ INSUFFICIENT (do NOT fall back to global random)
      insufficientSeams += 1;
      bump(INSUFFICIENT);
      seams.push({ seamIndex, candidatePoolSize: pool.length, compatibleCount: 0, effectiveCandidateSampleSize: 0, selectedCandidateRank: -1, transitionCellSampleCount: null, fallbackLevel: INSUFFICIENT, selectedStartIndex: -1 });
      // terminate the path here (marked STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT) rather than fabricate a join
      break;
    }
    record(chosen.start, len);
    bump(chosen.level);
    seams.push({ seamIndex, candidatePoolSize: pool.length, compatibleCount: chosen.compatibleCount, effectiveCandidateSampleSize: chosen.ess, selectedCandidateRank: chosen.rank, transitionCellSampleCount: null, fallbackLevel: chosen.level, selectedStartIndex: chosen.start });
  }

  const status = insufficientSeams > 0 ? "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT" : "OK";
  return { strategy, blocks, seams, insufficientSeams, status, concentration: computeConcentration(blocks, frames, initialStates), fallbackLevelCounts };
}

function geometricLen(rng: DeterministicRng, p: number, sourceLen: number): number {
  let len = 1; while (rng.nextFloat() > p && len < sourceLen && len < 240) len += 1; return len;
}

/** Concentration diagnostics over the placed block sequence. */
export function computeConcentration(blocks: readonly BlockRef[], frames: readonly CommonMarketFrame[], initialStates: Map<number, BlockTransitionState>): ConcentrationReport {
  const use = new Map<number, number>();
  for (const b of blocks) use.set(b.startIndex, (use.get(b.startIndex) ?? 0) + 1);
  const counts = [...use.values()].sort((a, b) => b - a);
  const totalPlaced = blocks.length || 1;
  const share = (k: number) => counts.slice(0, k).reduce((a, v) => a + v, 0) / totalPlaced;
  const sum = counts.reduce((a, v) => a + v, 0); const sumSq = counts.reduce((a, v) => a + v * v, 0);
  const monthUse = new Map<string, number>();
  for (const b of blocks) { const mo = monthOf(frames, b.startIndex); monthUse.set(mo, (monthUse.get(mo) ?? 0) + 1); }
  const monthShares = [...monthUse.values()].map((v) => v / totalPlaced);
  const monthEntropy = -monthShares.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
  const cellUse = new Map<string, number>();
  for (const b of blocks) { const st = initialStates.get(b.startIndex); const c = st ? stateCell(st) : "?"; cellUse.set(c, (cellUse.get(c) ?? 0) + 1); }
  const cellMax = Math.max(0, ...[...cellUse.values()].map((v) => v / totalPlaced));
  return {
    top1: share(1), top5: share(5), top10: share(10),
    effectiveNumberOfBlocks: sumSq > 0 ? (sum * sum) / sumSq : 0,
    uniqueBlockCoverage: use.size / totalPlaced,
    monthConcentrationMax: Math.max(0, ...monthShares),
    monthEntropy,
    transitionCellConcentrationMax: cellMax,
    duplicateSequenceCount: detectDuplicateSequences(blocks.map((b) => b.startIndex), 3),
  };
}

/** Count repeated consecutive start-index subsequences of length ≥ `minLen` (memorization signal). */
export function detectDuplicateSequences(starts: readonly number[], minLen: number): number {
  const seen = new Map<string, number>(); let dup = 0;
  for (let i = 0; i + minLen <= starts.length; i += 1) {
    const key = starts.slice(i, i + minLen).join(",");
    const c = (seen.get(key) ?? 0) + 1; seen.set(key, c);
    if (c === 2) dup += 1; // count each repeated pattern once
  }
  return dup;
}

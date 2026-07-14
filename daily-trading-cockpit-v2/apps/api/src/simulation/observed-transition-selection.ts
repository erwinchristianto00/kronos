/**
 * Observed-transition block selection (Market Digital Twin, Phase 2C). Instead of joining INDEPENDENTLY-selected blocks
 * (Phase 2B), we match the generated terminal state to historical TERMINAL states and replay the REAL contiguous
 * sequence that actually followed a similar state — so the transition across each join is a real historical transition
 * transplanted (in return space) onto the generated path. Produces a BlockRef[] fed to the FROZEN
 * `assembleReturnSpaceBootstrapPath`; the reconstruction math is untouched. Fully deterministic given the RNG.
 *
 * CAUSALITY: records are ranked ONLY by their terminalState (past of the successor). The successor's future path is
 * NEVER used to rank — candidatePrefixLen = 0 for the successor family. Replay-memorization guards bound the longest
 * unchanged historical run and source reuse so a method cannot "pass" realism by replaying long unchanged history.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import type { BlockRef } from "./historical-block-bootstrap.js";
import type { DeterministicRng } from "./deterministic-rng.js";
import type { BlockTransitionState } from "./block-transition-state.js";
import { computeTerminalState, type CalibrationVolumeBaseline } from "./block-transition-state.js";
import { assessCompatibility, RELAX_LEVELS, INSUFFICIENT, type CompatibilityNormalizer } from "./block-compatibility.js";
import type { HistoricalContinuationRecord } from "./historical-continuation-library.js";

export type ObservedMethod = "ONE_STEP_SUCCESSOR" | "TOPK_SUCCESSOR" | "REAL_TRANSITION_BRIDGE" | "ADJACENT_PAIR" | "NATURAL_BOUNDARY";

export interface ReplayConstraints {
  maxUnchangedRunHours: number; // longest consecutive source-contiguous replay allowed (memorization bound)
  maxSuccessorReuse: number; // a successor start may be reused at most this many times
  maxMonthFraction: number;
  topK: number;
  minMatches: number; // need ≥ this many within-support matches, else relax/fallback
  bridgeLen: number; // for REAL_TRANSITION_BRIDGE
  stepMs: number;
}
export const DEFAULT_REPLAY_CONSTRAINTS: ReplayConstraints = { maxUnchangedRunHours: 144, maxSuccessorReuse: 4, maxMonthFraction: 0.5, topK: 12, minMatches: 5, bridgeLen: 6, stepMs: 3_600_000 };

export interface ObservedSeamDiagnostic {
  seamIndex: number;
  matchPoolSize: number;
  compatibleCount: number;
  effectiveMatchSampleSize: number;
  selectedRank: number;
  matchDistance: number | null;
  fallbackLevel: string;
  sourceContiguous: boolean; // did this placement extend a real historical run?
  unchangedRunHours: number; // running length of the current unchanged run after this placement
  selectedSuccessorStart: number;
}
export interface ReplayMemoizationReport {
  longestUnchangedRunHours: number;
  maxSuccessorReuse: number;
  uniqueContinuationCoverage: number; // distinct successor starts / placements
  effectiveUniqueContinuations: number; // (Σn)²/Σn²
  monthConcentrationMax: number;
  duplicateNHourSequenceRate: number; // repeated consecutive successor-start runs of length ≥ 3
  returnVectorFingerprintDuplicates: number;
}
export interface ObservedSelectionResult {
  method: ObservedMethod;
  blocks: BlockRef[];
  seams: ObservedSeamDiagnostic[];
  insufficientSeams: number;
  status: "OK" | "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT";
  memoization: ReplayMemoizationReport;
  fallbackLevelCounts: Record<string, number>;
}

const monthOf = (frames: readonly CommonMarketFrame[], start: number): string => new Date(frames[start]?.asOfMs ?? 0).toISOString().slice(0, 7);
function effectiveSampleSize(w: readonly number[]): number { const s = w.reduce((a, v) => a + v, 0); const sq = w.reduce((a, v) => a + v * v, 0); return sq > 0 ? (s * s) / sq : 0; }

interface Args {
  method: ObservedMethod;
  source: readonly CommonMarketFrame[];
  library: readonly HistoricalContinuationRecord[];
  normalizer: CompatibilityNormalizer;
  baseline: CalibrationVolumeBaseline;
  btc: string; eth: string;
  lookback: number;
  blockLen: number; // successor length for ONE_STEP/TOPK; base for others
  targetLen: number;
  rng: DeterministicRng;
  constraints: ReplayConstraints;
}

/** Match the generated terminal state to library records; return within-support matches at the first sufficient level.
 *  Every RELAX level requires a regime match, so we prune to the gen-terminal's regime bucket (huge speedup). */
function matchRecords(terminal: BlockTransitionState, candidatePool: readonly HistoricalContinuationRecord[], args: Args, exclude: (r: HistoricalContinuationRecord) => boolean): { matches: { rec: HistoricalContinuationRecord; dist: number }[]; level: string } {
  for (const level of RELAX_LEVELS) {
    const matches: { rec: HistoricalContinuationRecord; dist: number }[] = [];
    for (const rec of candidatePool) {
      if (exclude(rec)) continue;
      const a = assessCompatibility(rec.continuationId, terminal, rec.terminalState, args.normalizer, level.features);
      if (a.withinEmpiricalSupport && Number.isFinite(a.totalDistance)) matches.push({ rec, dist: a.totalDistance });
    }
    if (matches.length >= args.constraints.minMatches) { matches.sort((x, y) => x.dist - y.dist); return { matches, level: level.name }; }
  }
  return { matches: [], level: INSUFFICIENT };
}

/** Core observed-transition generation loop. */
export function selectObservedTransitionBlocks(args: Args): ObservedSelectionResult {
  const { source, library, rng, constraints, method } = args;
  const blocks: BlockRef[] = [];
  const seams: ObservedSeamDiagnostic[] = [];
  const fallbackLevelCounts: Record<string, number> = {};
  const successorUse = new Map<number, number>();
  const monthUse = new Map<string, number>();
  let insufficientSeams = 0; let placed = 0; let total = 0;
  let unchangedRunHours = 0; let longestUnchangedRunHours = 0;
  const bump = (l: string) => { fallbackLevelCounts[l] = (fallbackLevelCounts[l] ?? 0) + 1; };
  // regime index — every RELAX level requires a regime match, so we only ever assess same-regime records.
  const byRegime = new Map<string, HistoricalContinuationRecord[]>();
  for (const r of library) { const k = r.terminalState.regimeFamily ?? "?"; const g = byRegime.get(k); if (g) g.push(r); else byRegime.set(k, [r]); }

  // Month cap is by DURATION (hours), not placement COUNT — count×blockLen breaks for variable-length methods
  // (ADJACENT_PAIR=96, NATURAL_BOUNDARY variable), which previously left the month cap never binding.
  const monthDurationCap = Math.max(1, constraints.maxMonthFraction * args.targetLen);
  const passesReuse = (start: number, len: number): boolean => (successorUse.get(start) ?? 0) < constraints.maxSuccessorReuse && (monthUse.get(monthOf(source, start)) ?? 0) + len <= monthDurationCap;
  // Effective placement of a record: the ACTUAL [start,len) that will be recorded (REAL_TRANSITION_BRIDGE prepends the
  // real run-up, shifting the start back). Used consistently for reuse/run-length checks AND the recorded block.
  const effPlacement = (rec: HistoricalContinuationRecord): { start: number; len: number } => {
    let start = rec.successorRef.startIndex; let len = rec.successorRef.length;
    if (method === "REAL_TRANSITION_BRIDGE") { const s2 = Math.max(0, start - constraints.bridgeLen); len += start - s2; start = s2; }
    return { start, len };
  };

  const record = (start: number, len: number, contiguous: boolean) => {
    blocks.push({ startIndex: start, length: len });
    successorUse.set(start, (successorUse.get(start) ?? 0) + 1);
    monthUse.set(monthOf(source, start), (monthUse.get(monthOf(source, start)) ?? 0) + len);
    unchangedRunHours = contiguous ? unchangedRunHours + len : len;
    longestUnchangedRunHours = Math.max(longestUnchangedRunHours, unchangedRunHours);
    placed += 1; total += len;
  };

  while (total < args.targetLen) {
    // First block: a seeded random real successor (its transition into it is real; no generated terminal yet).
    if (blocks.length === 0) {
      const pool = library.filter((r) => { const p = effPlacement(r); return passesReuse(p.start, p.len); });
      const rec = pool[rng.nextInt(0, pool.length)]!; const p0 = effPlacement(rec);
      record(p0.start, p0.len, false);
      seams.push({ seamIndex: 0, matchPoolSize: pool.length, compatibleCount: pool.length, effectiveMatchSampleSize: pool.length, selectedRank: -1, matchDistance: null, fallbackLevel: "SEED_START", sourceContiguous: false, unchangedRunHours, selectedSuccessorStart: p0.start });
      bump("SEED_START");
      continue;
    }
    const prev = blocks.at(-1)!;
    const genTerminal = computeTerminalState(source, prev.startIndex, prev.length, args.baseline, args.btc, args.eth, args.lookback);
    const prevSourceEnd = prev.startIndex + prev.length; // a placement starting here would be source-contiguous (unchanged run)
    // Both checks use the EFFECTIVE placement (post-bridge start/len), so the reuse + run-length guards match what is
    // actually recorded — previously the bridge shift made the guard test the wrong start.
    const wouldExceedRun = (start: number, len: number): boolean => start === prevSourceEnd && unchangedRunHours + len > constraints.maxUnchangedRunHours;
    const seamIndex = seams.length;
    const pool = byRegime.get(genTerminal.regimeFamily ?? "?") ?? library;

    const { matches, level } = matchRecords(genTerminal, pool, args, (r) => { const p = effPlacement(r); return !passesReuse(p.start, p.len) || wouldExceedRun(p.start, p.len); });
    if (matches.length === 0) {
      insufficientSeams += 1; bump(INSUFFICIENT);
      seams.push({ seamIndex, matchPoolSize: library.length, compatibleCount: 0, effectiveMatchSampleSize: 0, selectedRank: -1, matchDistance: null, fallbackLevel: INSUFFICIENT, sourceContiguous: false, unchangedRunHours, selectedSuccessorStart: -1 });
      break; // terminate rather than fabricate a join
    }
    // choose among matches
    let chosen: { rec: HistoricalContinuationRecord; rank: number; ess: number };
    if (method === "TOPK_SUCCESSOR") {
      const topK = matches.slice(0, Math.min(constraints.topK, matches.length));
      const weights = topK.map((m) => 1 / (m.dist + 1e-3));
      const idx = rng.sampleIndex(weights);
      chosen = { rec: topK[idx]!.rec, rank: idx, ess: effectiveSampleSize(weights) };
    } else {
      // ONE_STEP / ADJACENT_PAIR / NATURAL_BOUNDARY / BRIDGE: deterministic nearest (rank 0)
      chosen = { rec: matches[0]!.rec, rank: 0, ess: 1 };
    }
    // REAL_TRANSITION_BRIDGE prepends the real run-up (the tail of the matched state window) so the join carries the
    // actual approach into the successor. Real, contiguous, no interpolation. effPlacement applies the shift.
    const { start, len } = effPlacement(chosen.rec);
    const contiguous = start === prevSourceEnd;
    record(start, len, contiguous);
    bump(level);
    seams.push({ seamIndex, matchPoolSize: library.length, compatibleCount: matches.length, effectiveMatchSampleSize: chosen.ess, selectedRank: chosen.rank, matchDistance: matches[chosen.rank]?.dist ?? matches[0]!.dist, fallbackLevel: level, sourceContiguous: contiguous, unchangedRunHours, selectedSuccessorStart: start });
  }

  const status = insufficientSeams > 0 ? "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT" : "OK";
  return { method, blocks, seams, insufficientSeams, status, memoization: computeMemoization(blocks, source, longestUnchangedRunHours, args.btc), fallbackLevelCounts };
}

/** Return-vector fingerprint of a block (rounded log-return signature) for duplicate detection, on the given symbol. */
function blockFingerprint(source: readonly CommonMarketFrame[], b: BlockRef, sym: string): string {
  const parts: string[] = [];
  for (let i = b.startIndex + 1; i < b.startIndex + b.length; i += 1) {
    const a = source[i - 1]?.symbols[sym]?.candle.value?.close; const c = source[i]?.symbols[sym]?.candle.value?.close;
    parts.push(typeof a === "number" && typeof c === "number" && a > 0 ? (Math.log(c / a) * 1e4).toFixed(0) : "x");
  }
  return parts.join(",");
}

export function computeMemoization(blocks: readonly BlockRef[], source: readonly CommonMarketFrame[], longestUnchangedRunHours: number, sym: string): ReplayMemoizationReport {
  const use = new Map<number, number>();
  for (const b of blocks) use.set(b.startIndex, (use.get(b.startIndex) ?? 0) + 1);
  const counts = [...use.values()]; const sum = counts.reduce((a, v) => a + v, 0) || 1; const sumSq = counts.reduce((a, v) => a + v * v, 0);
  const totalPlaced = blocks.length || 1;
  const totalDuration = blocks.reduce((a, b) => a + b.length, 0) || 1;
  // month concentration is DURATION-weighted (variable-length blocks would bias a count-based share).
  const monthDur = new Map<string, number>();
  for (const b of blocks) { const mo = new Date(source[b.startIndex]?.asOfMs ?? 0).toISOString().slice(0, 7); monthDur.set(mo, (monthDur.get(mo) ?? 0) + b.length); }
  // duplicate N-hour sequences: repeated consecutive successor-start runs of length ≥ 3
  const starts = blocks.map((b) => b.startIndex); const seen = new Map<string, number>(); let dupSeq = 0;
  for (let i = 0; i + 3 <= starts.length; i += 1) { const k = starts.slice(i, i + 3).join(","); const c = (seen.get(k) ?? 0) + 1; seen.set(k, c); if (c >= 2) dupSeq += 1; }
  // return-vector fingerprint duplicates (on the given symbol)
  const fp = new Map<string, number>(); let fpDup = 0;
  for (const b of blocks) { const f = blockFingerprint(source, b, sym); const c = (fp.get(f) ?? 0) + 1; fp.set(f, c); if (c >= 2) fpDup += 1; }
  return {
    longestUnchangedRunHours,
    maxSuccessorReuse: counts.length ? Math.max(...counts) : 0,
    uniqueContinuationCoverage: use.size / totalPlaced,
    effectiveUniqueContinuations: sumSq > 0 ? (sum * sum) / sumSq : 0,
    monthConcentrationMax: Math.max(0, ...[...monthDur.values()].map((v) => v / totalDuration)),
    duplicateNHourSequenceRate: starts.length ? dupSeq / starts.length : 0,
    returnVectorFingerprintDuplicates: fpDup,
  };
}

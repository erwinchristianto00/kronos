/**
 * METHOD_B3_CROSS_FITTED_SUCCESSOR (Market Digital Twin, Phase 2D). A ROLLING-ORIGIN cross-fitted observed-successor
 * generator: for an excluded evaluation month, EVERYTHING that shapes generation — the calibration volume baseline, the
 * compatibility normalizer, the successor library, and the regime/transition statistics — is fitted ONLY on earlier
 * ("training") months. No candidate is ever sourced from the evaluation month. The evaluation month is touched ONLY at
 * scoring time (outside this module). This is the fair out-of-period test Phase-2C's in-sample Method B could not give.
 *
 * Selection is the observed-successor contract (match the generated terminal state to historical terminal states, replay
 * the REAL contiguous successor) plus the operator's PERMITTED stability mechanisms — and ONLY those:
 *   - deterministic top-K weighted sampling (weight ∝ 1/(dist+ε));
 *   - reuse penalty (weight ×= reusePenalty^usesSoFar) — softly discourages reusing the same real successor;
 *   - source-period balancing (weight ×= exp(−balanceStrength · monthDurationShare)) — keeps one month from dominating;
 *   - candidate-support floor (a RELAX level must supply ≥ this many within-support neighbours, else relax/insufficient);
 *   - candidate entropy floor (if the top-K sampling distribution is too peaked, flatten to uniform — raises diversity);
 *   - transition-state regularization (shrink the generated terminal MATCHING KEY toward the training mean — reduces
 *     variance from a single extreme state). Candles are NEVER altered; only the match key is regularized.
 * Reuses ONLY pure infrastructure (terminal-state descriptor, the training-fitted normalizer, memoization measurement,
 * assessCompatibility/RELAX levels). Deterministic given the RNG. The reconstruction math (assembleReturnSpaceBootstrapPath)
 * is untouched and applied downstream by the runner.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import type { BlockRef } from "./historical-block-bootstrap.js";
import type { DeterministicRng } from "./deterministic-rng.js";
import { computeTerminalState, type BlockTransitionState, type CalibrationVolumeBaseline } from "./block-transition-state.js";
import { assessCompatibility, RELAX_LEVELS, INSUFFICIENT, NUMERIC_FEATURES, type CompatibilityNormalizer } from "./block-compatibility.js";
import type { HistoricalContinuationRecord } from "./historical-continuation-library.js";
import { computeMemoization, type ObservedSeamDiagnostic, type ReplayMemoizationReport } from "./observed-transition-selection.js";

/** Hyperparameters chosen in Stage A on calibration only (never using an excluded-month result). */
export interface B3Params {
  topK: number; // sample among the K nearest within-support neighbours
  reusePenalty: number; // (0,1]; weight ×= reusePenalty^(timesSuccessorAlreadyUsed). 1 = off
  entropyFloor: number; // [0,1]; if normalized top-K entropy < floor, flatten weights to uniform
  candidateSupportFloor: number; // a RELAX level must yield ≥ this many within-support neighbours to be accepted
  regularization: number; // [0,1); shrink the generated terminal MATCH KEY toward the training mean (numeric features)
  balanceStrength: number; // ≥0; weight ×= exp(−balanceStrength · monthDurationShare). 0 = off
}
export const DEFAULT_B3_PARAMS: B3Params = { topK: 12, reusePenalty: 0.5, entropyFloor: 0.5, candidateSupportFloor: 5, regularization: 0.1, balanceStrength: 1.0 };

export interface B3Constraints { maxUnchangedRunHours: number; maxSuccessorReuse: number; maxMonthFraction: number; minMatches: number; }
export const DEFAULT_B3_CONSTRAINTS: B3Constraints = { maxUnchangedRunHours: 144, maxSuccessorReuse: 4, maxMonthFraction: 0.5, minMatches: 5 };

export interface CrossFitProvenance {
  trainingMonths: string[];
  excludedMonth: string;
  fittedFrom: "TRAINING_ONLY";
  candidateSource: "TRAINING_ONLY";
  normalizerSource: "TRAINING_ONLY";
  transitionStatsSource: "TRAINING_ONLY";
  librarySize: number;
}

export interface B3SelectionResult {
  blocks: BlockRef[];
  seams: ObservedSeamDiagnostic[];
  insufficientSeams: number;
  status: "OK" | "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT";
  memoization: ReplayMemoizationReport;
  provenance: CrossFitProvenance;
  meanEffectiveCandidates: number; // mean ESS of the sampling weights across seams (diversity witness)
  meanEntropy: number; // mean normalized top-K entropy across seams
}

const monthOf = (frames: readonly CommonMarketFrame[], start: number): string => new Date(frames[start]?.asOfMs ?? 0).toISOString().slice(0, 7);
const ess = (w: readonly number[]): number => { const s = w.reduce((a, v) => a + v, 0); const sq = w.reduce((a, v) => a + v * v, 0); return sq > 0 ? (s * s) / sq : 0; };
function normEntropy(w: readonly number[]): number {
  const s = w.reduce((a, v) => a + v, 0); if (s <= 0 || w.length <= 1) return 0;
  let h = 0; for (const v of w) { const p = v / s; if (p > 0) h -= p * Math.log(p); }
  return h / Math.log(w.length);
}

/** Mean of each numeric terminal-state feature across the TRAINING library (for transition-state regularization). */
function trainingTerminalMean(library: readonly HistoricalContinuationRecord[]): Partial<Record<(typeof NUMERIC_FEATURES)[number], number>> {
  const out: Partial<Record<(typeof NUMERIC_FEATURES)[number], number>> = {};
  for (const f of NUMERIC_FEATURES) {
    let sum = 0, n = 0;
    for (const r of library) { const v = r.terminalState[f]; if (typeof v === "number" && Number.isFinite(v)) { sum += v; n += 1; } }
    if (n > 0) out[f] = sum / n;
  }
  return out;
}

/** Shrink the numeric features of a generated terminal state toward the training mean (categorical features untouched). */
function regularizeKey(t: BlockTransitionState, mean: Partial<Record<(typeof NUMERIC_FEATURES)[number], number>>, lambda: number): BlockTransitionState {
  if (lambda <= 0) return t;
  const out: BlockTransitionState = { ...t };
  for (const f of NUMERIC_FEATURES) { const tv = t[f]; const mv = mean[f]; if (typeof tv === "number" && typeof mv === "number") (out[f] as number) = (1 - lambda) * tv + lambda * mv; }
  return out;
}

interface B3Args {
  trainingSource: readonly CommonMarketFrame[]; // the CONTIGUOUS training frames (earlier months only) — the reconstruction domain
  library: readonly HistoricalContinuationRecord[]; // built from trainingSource ONLY
  normalizer: CompatibilityNormalizer; // fitted on training terminal states ONLY
  baseline: CalibrationVolumeBaseline; // fitted on training ONLY
  trainingMonths: string[];
  excludedMonth: string;
  btc: string; eth: string;
  lookback: number;
  blockLen: number;
  targetLen: number;
  rng: DeterministicRng;
  params: B3Params;
  constraints: B3Constraints;
}

/**
 * Match the regularized generated terminal state to the training library at the first RELAX level that yields at least
 * `max(minMatches, candidateSupportFloor)` within-support neighbours (excluding reuse/run-violating candidates).
 */
function matchWithinSupport(terminal: BlockTransitionState, pool: readonly HistoricalContinuationRecord[], normalizer: CompatibilityNormalizer, threshold: number, exclude: (r: HistoricalContinuationRecord) => boolean): { matches: { rec: HistoricalContinuationRecord; dist: number }[]; level: string } {
  for (const level of RELAX_LEVELS) {
    const matches: { rec: HistoricalContinuationRecord; dist: number }[] = [];
    for (const rec of pool) {
      if (exclude(rec)) continue;
      const a = assessCompatibility(rec.continuationId, terminal, rec.terminalState, normalizer, level.features);
      if (a.withinEmpiricalSupport && Number.isFinite(a.totalDistance)) matches.push({ rec, dist: a.totalDistance });
    }
    if (matches.length >= threshold) { matches.sort((x, y) => x.dist - y.dist); return { matches, level: level.name }; }
  }
  return { matches: [], level: INSUFFICIENT };
}

export function selectB3CrossFittedBlocks(args: B3Args): B3SelectionResult {
  const { trainingSource: source, library, normalizer, baseline, btc, eth, lookback, targetLen, rng, params, constraints } = args;
  const trainMean = trainingTerminalMean(library);
  const byRegime = new Map<string, HistoricalContinuationRecord[]>();
  for (const r of library) { const k = r.terminalState.regimeFamily ?? "?"; const g = byRegime.get(k); if (g) g.push(r); else byRegime.set(k, [r]); }

  const blocks: BlockRef[] = []; const seams: ObservedSeamDiagnostic[] = [];
  const successorUse = new Map<number, number>(); const monthUse = new Map<string, number>();
  let insufficientSeams = 0; let placed = 0; let total = 0; let unchangedRun = 0; let longestRun = 0;
  let essSum = 0; let entSum = 0; let essN = 0;
  const acceptThreshold = Math.max(constraints.minMatches, params.candidateSupportFloor);
  const monthDurationCap = Math.max(1, constraints.maxMonthFraction * targetLen);
  const passesReuse = (start: number, len: number): boolean => (successorUse.get(start) ?? 0) < constraints.maxSuccessorReuse && (monthUse.get(monthOf(source, start)) ?? 0) + len <= monthDurationCap;

  const record = (start: number, len: number, contiguous: boolean) => {
    blocks.push({ startIndex: start, length: len });
    successorUse.set(start, (successorUse.get(start) ?? 0) + 1);
    monthUse.set(monthOf(source, start), (monthUse.get(monthOf(source, start)) ?? 0) + len);
    unchangedRun = contiguous ? unchangedRun + len : len; longestRun = Math.max(longestRun, unchangedRun); placed += 1; total += len;
  };

  while (total < targetLen) {
    if (blocks.length === 0) {
      const pool = library.filter((r) => passesReuse(r.successorRef.startIndex, r.successorRef.length));
      const rec = pool[rng.nextInt(0, pool.length)]!;
      record(rec.successorRef.startIndex, rec.successorRef.length, false);
      seams.push({ seamIndex: 0, matchPoolSize: pool.length, compatibleCount: pool.length, effectiveMatchSampleSize: pool.length, selectedRank: -1, matchDistance: null, fallbackLevel: "SEED_START", sourceContiguous: false, unchangedRunHours: unchangedRun, selectedSuccessorStart: rec.successorRef.startIndex });
      continue;
    }
    const prev = blocks.at(-1)!; const prevEnd = prev.startIndex + prev.length;
    const rawTerminal = computeTerminalState(source, prev.startIndex, prev.length, baseline, btc, eth, lookback);
    const genTerminal = regularizeKey(rawTerminal, trainMean, params.regularization);
    const wouldExceedRun = (start: number, len: number): boolean => start === prevEnd && unchangedRun + len > constraints.maxUnchangedRunHours;
    const pool = byRegime.get(genTerminal.regimeFamily ?? "?") ?? library;
    const { matches, level } = matchWithinSupport(genTerminal, pool, normalizer, acceptThreshold, (r) => !passesReuse(r.successorRef.startIndex, r.successorRef.length) || wouldExceedRun(r.successorRef.startIndex, r.successorRef.length));
    const seamIndex = seams.length;
    if (matches.length === 0) {
      insufficientSeams += 1;
      seams.push({ seamIndex, matchPoolSize: library.length, compatibleCount: 0, effectiveMatchSampleSize: 0, selectedRank: -1, matchDistance: null, fallbackLevel: INSUFFICIENT, sourceContiguous: false, unchangedRunHours: unchangedRun, selectedSuccessorStart: -1 });
      break;
    }
    const topK = matches.slice(0, Math.min(params.topK, matches.length));
    // base weight ∝ 1/(dist+ε), then reuse penalty and source-period balancing
    let weights = topK.map((m) => {
      const start = m.rec.successorRef.startIndex;
      const uses = successorUse.get(start) ?? 0;
      const monthShare = (monthUse.get(monthOf(source, start)) ?? 0) / Math.max(1, total);
      return (1 / (m.dist + 1e-3)) * Math.pow(params.reusePenalty, uses) * Math.exp(-params.balanceStrength * monthShare);
    });
    // entropy floor — if the sampling distribution is too peaked, flatten to uniform over the top-K (max diversity)
    if (normEntropy(weights) < params.entropyFloor) weights = topK.map(() => 1);
    essSum += ess(weights); entSum += normEntropy(weights); essN += 1;
    const idx = rng.sampleIndex(weights);
    const chosen = topK[idx]!;
    const start = chosen.rec.successorRef.startIndex; const len = chosen.rec.successorRef.length; const contiguous = start === prevEnd;
    record(start, len, contiguous);
    seams.push({ seamIndex, matchPoolSize: library.length, compatibleCount: matches.length, effectiveMatchSampleSize: ess(weights), selectedRank: idx, matchDistance: chosen.dist, fallbackLevel: level, sourceContiguous: contiguous, unchangedRunHours: unchangedRun, selectedSuccessorStart: start });
  }

  const status = insufficientSeams > 0 ? "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT" : "OK";
  const trainingMonths = [...new Set(library.map((r) => r.sourceMonth))].sort();
  return {
    blocks, seams, insufficientSeams, status,
    memoization: computeMemoization(blocks, source, longestRun, btc),
    provenance: { trainingMonths: args.trainingMonths.length ? args.trainingMonths : trainingMonths, excludedMonth: args.excludedMonth, fittedFrom: "TRAINING_ONLY", candidateSource: "TRAINING_ONLY", normalizerSource: "TRAINING_ONLY", transitionStatsSource: "TRAINING_ONLY", librarySize: library.length },
    meanEffectiveCandidates: essN > 0 ? essSum / essN : 0,
    meanEntropy: essN > 0 ? entSum / essN : 0,
  };
}

/**
 * Pre-registered feasible-target math (Phase-2D §3). The largest target T (multiple of blockLen) that CAN be packed from
 * `availHours` training months under the month-concentration cap `maxMonthFraction` AND the reuse cap, accounting for
 * block granularity. Returns the binding component values so the proof is auditable BEFORE any generation runs.
 */
export interface FeasibleTargetProof {
  excludedMonthHours: number;
  feasibleHoursUnderMonthCap: number;
  feasibleHoursUnderReuseCap: number;
  targetHours: number;
  fillable: boolean;
  bindingConstraint: string;
  reason: string;
  trainingMonthCount: number;
  perMonthAvailableHours: number[];
}
export function proveFeasibleTarget(args: { excludedMonthHours: number; perMonthAvailableHours: number[]; distinctSuccessors: number; maxMonthFraction: number; maxSuccessorReuse: number; blockLen: number }): FeasibleTargetProof {
  const { excludedMonthHours, perMonthAvailableHours: avail, distinctSuccessors, maxMonthFraction: f, maxSuccessorReuse, blockLen } = args;
  const nMonths = avail.length;
  const totalSupply = avail.reduce((a, v) => a + v, 0);
  // The runtime month cap is 0.5·targetLen — PROPORTIONAL to the target — so a month can hold floor(f·T/blockLen)
  // blocks. Packing capacity is a SAWTOOTH in T: capacity(T)=Σ_m min(floor(f·T/blockLen), floor(avail_m/blockLen))·blockLen.
  // A target T is fillable ONLY iff capacity(T) ≥ T (verified at the ACTUAL T, not at a self-consistent fixed point —
  // that distinction is the Phase-2C-robustness LOPO packing lesson applied correctly).
  const capacity = (T: number): number => { const perMonthCapBlocks = Math.floor((f * T) / blockLen); let c = 0; for (const a of avail) c += Math.min(perMonthCapBlocks, Math.floor(a / blockLen)) * blockLen; return c; };
  // feasibleHoursUnderMonthCap: the self-consistent MAX (largest T with capacity(T) ≥ T) — reported for auditability.
  let feasibleHoursUnderMonthCap = 0;
  for (let T = blockLen; T <= totalSupply; T += blockLen) { if (capacity(T) >= T) feasibleHoursUnderMonthCap = T; }
  const feasibleHoursUnderReuseCap = maxSuccessorReuse * distinctSuccessors * blockLen;
  const excludedRounded = Math.floor(excludedMonthHours / blockLen) * blockLen;
  const upper = Math.min(excludedRounded, feasibleHoursUnderReuseCap);
  // targetHours: the LARGEST T (multiple of blockLen, ≤ upper) that ACTUALLY packs, i.e. capacity(T) ≥ T.
  let targetHours = 0;
  for (let T = blockLen; T <= upper; T += blockLen) { if (capacity(T) >= T) targetHours = T; }
  const bindingConstraint = targetHours === 0 ? "NONE" : targetHours >= excludedRounded ? "EXCLUDED_MONTH_HOURS" : targetHours >= feasibleHoursUnderReuseCap ? "SUCCESSOR_REUSE_CAP" : "MONTH_CONCENTRATION_CAP";
  const packSlack = targetHours > 0 ? capacity(targetHours) - targetHours : -1; // 0 = zero-slack tight pack
  const fillable = nMonths >= Math.ceil(1 / f) && targetHours >= blockLen && capacity(targetHours) >= targetHours;
  const reason = nMonths < Math.ceil(1 / f)
    ? `INSUFFICIENT_CROSS_FIT_SUPPORT: ${nMonths} training month(s) cannot satisfy the ${f} month-concentration cap (need ≥${Math.ceil(1 / f)})`
    : fillable ? `FILLABLE (target ${targetHours}h, pack slack ${packSlack}h)` : "INSUFFICIENT_CROSS_FIT_SUPPORT: no positive target packs under the frozen caps";
  return { excludedMonthHours, feasibleHoursUnderMonthCap, feasibleHoursUnderReuseCap, targetHours, fillable, bindingConstraint, reason, trainingMonthCount: nMonths, perMonthAvailableHours: avail };
}

/**
 * Regime-conditioned empirical bootstrap (Market Digital Twin, Phase-1 foundation), priority #3. Conditions block
 * selection on OFFLINE regime/volatility/liquidity/time-of-day/weekday labels. CRITICAL causality rule: the labels
 * used to SELECT blocks may be offline metadata, but they MUST NOT enter decision features (the decision layer only
 * ever sees the contemporaneous ObservedMarketView). If the effective sample size for a conditioning cell is too
 * small, this returns INSUFFICIENT_CALIBRATION_DATA — it NEVER silently falls back to an unrelated global
 * distribution without RECORDING the fallback. Pure + deterministic given the RNG.
 */
import type { BlockRef } from "./historical-block-bootstrap.js";
import { selectStationaryBlocks } from "./historical-block-bootstrap.js";
import type { DeterministicRng } from "./deterministic-rng.js";

export interface ConditioningKey {
  regime?: string;
  volatilityBucket?: string;
  liquidityBucket?: string;
  timeOfDayBucket?: string;
  weekdayWeekend?: "WEEKDAY" | "WEEKEND";
  returnDirection?: "UP" | "DOWN";
}

/** Offline metadata for each source index: its conditioning labels. NEVER exposed to decision functions. */
export interface BlockConditioningIndex {
  labelVersion: string;
  calibrationPeriod: { startMs: number; endMs: number };
  /** For each source frame index, its labels (offline). */
  labels: ConditioningKey[];
}

export type RegimeBootstrapStatus = "OK" | "INSUFFICIENT_CALIBRATION_DATA" | "GLOBAL_FALLBACK_RECORDED";

export interface RegimeConditionedResult {
  status: RegimeBootstrapStatus;
  key: ConditioningKey;
  eligibleIndices: number[];
  blockCount: number;
  effectiveSampleSize: number;
  transitionCounts: Record<string, number>;
  blocks: BlockRef[];
  fallbackReason: string | null;
}

const MIN_EFFECTIVE_SAMPLE = 30;

function matches(a: ConditioningKey, b: ConditioningKey): boolean {
  return (["regime", "volatilityBucket", "liquidityBucket", "timeOfDayBucket", "weekdayWeekend", "returnDirection"] as const)
    .every((f) => b[f] === undefined || a[f] === b[f]);
}

/**
 * Select stationary blocks whose START index matches the conditioning key. If the eligible pool is too small the
 * result is INSUFFICIENT_CALIBRATION_DATA (no blocks). If `allowGlobalFallback` is set AND the cell is too small,
 * it falls back to the global pool but records GLOBAL_FALLBACK_RECORDED + the reason (never silent).
 */
export function selectRegimeConditionedBlocks(args: {
  sourceLen: number;
  index: BlockConditioningIndex;
  key: ConditioningKey;
  meanBlockLen: number;
  targetLen: number;
  rng: DeterministicRng;
  allowGlobalFallback?: boolean;
}): RegimeConditionedResult {
  const eligible: number[] = [];
  for (let i = 0; i < Math.min(args.sourceLen, args.index.labels.length); i += 1) {
    if (matches(args.index.labels[i]!, args.key)) eligible.push(i);
  }
  // Effective sample ≈ eligible count ÷ mean block length (blocks are the independent unit).
  const effectiveSampleSize = Math.floor(eligible.length / Math.max(1, args.meanBlockLen));

  // Transition counts over the eligible ordered labels (regime persistence diagnostics).
  const transitionCounts: Record<string, number> = {};
  for (let i = 1; i < eligible.length; i += 1) {
    const prev = args.index.labels[eligible[i - 1]!]?.regime ?? "?";
    const cur = args.index.labels[eligible[i]!]?.regime ?? "?";
    const k = `${prev}->${cur}`;
    transitionCounts[k] = (transitionCounts[k] ?? 0) + 1;
  }

  if (effectiveSampleSize < MIN_EFFECTIVE_SAMPLE) {
    if (!args.allowGlobalFallback) {
      return { status: "INSUFFICIENT_CALIBRATION_DATA", key: args.key, eligibleIndices: eligible, blockCount: 0, effectiveSampleSize, transitionCounts, blocks: [], fallbackReason: `effectiveSampleSize ${effectiveSampleSize} < ${MIN_EFFECTIVE_SAMPLE}` };
    }
    const blocks = selectStationaryBlocks(args.sourceLen, args.meanBlockLen, args.targetLen, args.rng);
    return { status: "GLOBAL_FALLBACK_RECORDED", key: args.key, eligibleIndices: eligible, blockCount: blocks.length, effectiveSampleSize, transitionCounts, blocks, fallbackReason: `cell too small (ess ${effectiveSampleSize}); GLOBAL fallback used — flagged, NOT silent` };
  }

  // Build blocks whose start lands on an eligible index (deterministic: sample from `eligible` via the RNG).
  const blocks: BlockRef[] = [];
  let total = 0;
  const p = 1 / args.meanBlockLen;
  while (total < args.targetLen) {
    const start = eligible[args.rng.nextInt(0, eligible.length)]!;
    let len = 1;
    while (args.rng.nextFloat() > p && start + len < args.sourceLen) len += 1;
    blocks.push({ startIndex: start, length: len });
    total += len;
  }
  return { status: "OK", key: args.key, eligibleIndices: eligible, blockCount: blocks.length, effectiveSampleSize, transitionCounts, blocks, fallbackReason: null };
}

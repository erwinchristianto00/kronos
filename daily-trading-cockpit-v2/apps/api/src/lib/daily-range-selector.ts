/**
 * Daily Range batch allocation primitives.
 *
 * This module deliberately has no exchange, store, or model dependency.  Its
 * only job is to turn one complete same-candle candidate set into a deterministic
 * selection.  Keeping it pure makes order-invariance testable and prevents an
 * unvalidated score from silently gaining execution authority.
 */
import { createHash } from "node:crypto";

export const DAILY_RANGE_ALLOCATOR_MODES = [
  "PAUSED",
  "LOOP_ORDER_LEGACY",
  /** Research/test comparator only. It has no Mainnet execution authority. */
  "SEEDED_RANDOM_BASELINE",
  "ECONOMIC_QUALITY_BASELINE",
  /** Alpha may be observed, but economic ordering remains the execution authority. */
  "SHADOW_ALPHA_SELECTOR",
  /** Requires a separately validated artifact and positive expected net value. */
  "VALIDATED_ALPHA_SELECTOR",
  /** @deprecated durable-record compatibility only. */
  "SHADOW_SELECTOR",
  /** @deprecated durable-record compatibility only. */
  "VALIDATED_SELECTOR",
] as const;

export type DailyRangeAllocatorMode = typeof DAILY_RANGE_ALLOCATOR_MODES[number];

export type DailyRangeAllocationSkipReason =
  | "NO_AVAILABLE_SLOT"
  | "SKIP_CAP_LOWER_RANK"
  | "SELECTOR_NOT_READY"
  | "NEGATIVE_EXPECTED_VALUE"
  | "LIVE_NEW_ENTRY_PAUSED";

export interface DailyRangeAllocationCandidate {
  signalId: string;
  symbol: string;
  /** Diagnostic only.  It is intentionally read only by LOOP_ORDER_LEGACY. */
  legacySequence: number;
  /** A future promoted artifact may supply this.  Null never becomes an alpha score. */
  selectorScore: number | null;
  /** Positive net USD from a validated alpha artifact only. */
  selectorExpectedNetUsd?: number | null;
  /** V3 non-alpha candidate quality. It must be computed before allocation. */
  economic?: {
    breakEvenWinRate: number;
    costRatio: number;
    plannedRiskUsd: number;
    qualityTieBreakHash: string;
  } | null;
}

export interface DailyRangeAllocationDecision {
  signalId: string;
  symbol: string;
  selectorRank: number | null;
  selectorScore: number | null;
  tieBreakHash: string;
  selected: boolean;
  skipReason: DailyRangeAllocationSkipReason | null;
}

export interface DailyRangeAllocationResult {
  mode: DailyRangeAllocatorMode;
  seed: string;
  availableSlots: number;
  decisions: DailyRangeAllocationDecision[];
}

export function isDailyRangeAllocatorMode(value: unknown): value is DailyRangeAllocatorMode {
  return typeof value === "string" && (DAILY_RANGE_ALLOCATOR_MODES as readonly string[]).includes(value);
}

/** Invalid/missing configuration never upgrades allocation authority. */
export function parseDailyRangeAllocatorMode(
  raw: string | undefined,
  fallback: DailyRangeAllocatorMode,
): DailyRangeAllocatorMode {
  return isDailyRangeAllocatorMode(raw) ? raw : fallback;
}

export function dailyRangeTieBreakHash(input: {
  strategyVersion: string;
  batchTimestampMs: number;
  symbol: string;
}): string {
  return createHash("sha256")
    .update(`${input.strategyVersion}\u0000${input.batchTimestampMs}\u0000${input.symbol.trim().toUpperCase()}`)
    .digest("hex");
}

/**
 * Neutral-baseline ordering is intentionally seeded per environment. This is
 * distinct from the validated-selector equal-score tie break above, whose
 * contract deliberately contains only strategy, timestamp, and symbol.
 */
export function dailyRangeBaselineHash(input: {
  strategyVersion: string;
  batchTimestampMs: number;
  environment: "testnet" | "mainnet";
  symbol: string;
}): string {
  return createHash("sha256")
    .update(`${input.strategyVersion}\u0000${input.batchTimestampMs}\u0000${input.environment}\u0000${input.symbol.trim().toUpperCase()}`)
    .digest("hex");
}

function canonicalCandidates(candidates: readonly DailyRangeAllocationCandidate[]): DailyRangeAllocationCandidate[] {
  const bySignal = new Map<string, DailyRangeAllocationCandidate>();
  for (const candidate of candidates) {
    const signalId = candidate.signalId.trim();
    const symbol = candidate.symbol.trim().toUpperCase();
    if (!signalId || !symbol || bySignal.has(signalId)) continue;
    bySignal.set(signalId, {
      signalId,
      symbol,
      legacySequence: Number.isFinite(candidate.legacySequence) ? candidate.legacySequence : Number.MAX_SAFE_INTEGER,
      selectorScore: typeof candidate.selectorScore === "number" && Number.isFinite(candidate.selectorScore)
        ? candidate.selectorScore
        : null,
      selectorExpectedNetUsd: typeof candidate.selectorExpectedNetUsd === "number" && Number.isFinite(candidate.selectorExpectedNetUsd)
        ? candidate.selectorExpectedNetUsd
        : null,
      economic: candidate.economic
        && Number.isFinite(candidate.economic.breakEvenWinRate)
        && Number.isFinite(candidate.economic.costRatio)
        && Number.isFinite(candidate.economic.plannedRiskUsd)
        && typeof candidate.economic.qualityTieBreakHash === "string"
        && candidate.economic.qualityTieBreakHash.length > 0
        ? {
          breakEvenWinRate: candidate.economic.breakEvenWinRate,
          costRatio: candidate.economic.costRatio,
          plannedRiskUsd: candidate.economic.plannedRiskUsd,
          qualityTieBreakHash: candidate.economic.qualityTieBreakHash,
        }
        : null,
    });
  }
  return [...bySignal.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.signalId.localeCompare(b.signalId));
}

function boundedSlots(value: number, candidateCount: number): number {
  if (value === Number.POSITIVE_INFINITY) return candidateCount;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(candidateCount, Math.floor(value)));
}

/**
 * Returns a complete decision for every eligible candidate.  The input order is
 * normalized before any ranking occurs, so changing array/Map/REST arrival order
 * cannot change a selection in any non-legacy mode.
 */
export function allocateDailyRangeBatch(input: {
  mode: DailyRangeAllocatorMode;
  strategyVersion: string;
  batchTimestampMs: number;
  environment: "testnet" | "mainnet";
  availableSlots: number;
  candidates: readonly DailyRangeAllocationCandidate[];
}): DailyRangeAllocationResult {
  const candidates = canonicalCandidates(input.candidates);
  const seed = `${input.strategyVersion}:${input.batchTimestampMs}:${input.environment}`;
  const withTieBreak = candidates.map((candidate) => {
    const seededBaselineMode = input.mode === "SEEDED_RANDOM_BASELINE" || input.mode === "SHADOW_SELECTOR";
    return {
      candidate,
      tieBreakHash: candidate.economic?.qualityTieBreakHash ?? (seededBaselineMode
        ? dailyRangeBaselineHash({
          strategyVersion: input.strategyVersion,
          batchTimestampMs: input.batchTimestampMs,
          environment: input.environment,
          symbol: candidate.symbol,
        })
        : dailyRangeTieBreakHash({
          strategyVersion: input.strategyVersion,
          batchTimestampMs: input.batchTimestampMs,
          symbol: candidate.symbol,
        })),
    };
  });
  const slots = boundedSlots(input.availableSlots, withTieBreak.length);

  if (input.mode === "PAUSED") {
    return {
      mode: input.mode,
      seed,
      availableSlots: slots,
      decisions: withTieBreak.map(({ candidate, tieBreakHash }) => ({
        signalId: candidate.signalId,
        symbol: candidate.symbol,
        selectorRank: null,
        selectorScore: candidate.selectorScore,
        tieBreakHash,
        selected: false,
        skipReason: "LIVE_NEW_ENTRY_PAUSED",
      })),
    };
  }

  const validatedMode = input.mode === "VALIDATED_SELECTOR" || input.mode === "VALIDATED_ALPHA_SELECTOR";
  const v3ValidatedMode = input.mode === "VALIDATED_ALPHA_SELECTOR";
  if (validatedMode && withTieBreak.some(({ candidate }) => candidate.selectorScore === null || (v3ValidatedMode && (candidate.selectorExpectedNetUsd ?? Number.NEGATIVE_INFINITY) <= 0))) {
    return {
      mode: input.mode,
      seed,
      availableSlots: slots,
      decisions: withTieBreak.map(({ candidate, tieBreakHash }) => ({
        signalId: candidate.signalId,
        symbol: candidate.symbol,
        selectorRank: null,
        selectorScore: candidate.selectorScore,
        tieBreakHash,
        selected: false,
        skipReason: candidate.selectorScore === null ? "SELECTOR_NOT_READY" : "NEGATIVE_EXPECTED_VALUE",
      })),
    };
  }

  const ordered = [...withTieBreak].sort((a, b) => {
    if (input.mode === "LOOP_ORDER_LEGACY") {
      return a.candidate.legacySequence - b.candidate.legacySequence || a.tieBreakHash.localeCompare(b.tieBreakHash);
    }
    if (validatedMode) {
      return (b.candidate.selectorScore ?? Number.NEGATIVE_INFINITY) - (a.candidate.selectorScore ?? Number.NEGATIVE_INFINITY)
        || a.tieBreakHash.localeCompare(b.tieBreakHash);
    }
    if (input.mode === "ECONOMIC_QUALITY_BASELINE" || input.mode === "SHADOW_ALPHA_SELECTOR") {
      // No alpha lives here.  A lower break-even requirement and lower safe-loss
      // friction are preferable; larger *capped* planned risk wins only after
      // those two economic properties tie. The frozen hash is the final tie.
      const ae = a.candidate.economic;
      const be = b.candidate.economic;
      if (ae && be) {
        return ae.breakEvenWinRate - be.breakEvenWinRate
          || ae.costRatio - be.costRatio
          || be.plannedRiskUsd - ae.plannedRiskUsd
          || a.tieBreakHash.localeCompare(b.tieBreakHash);
      }
      if (ae) return -1;
      if (be) return 1;
    }
    // Deprecated shadow and seeded modes deliberately retain the prior neutral
    // comparator solely for historical replay/test data. Neither is permitted
    // to become Mainnet execution authority by the runtime policy.
    return a.tieBreakHash.localeCompare(b.tieBreakHash);
  });

  return {
    mode: input.mode,
    seed,
    availableSlots: slots,
    decisions: ordered.map(({ candidate, tieBreakHash }, index) => {
      const selected = index < slots;
      return {
        signalId: candidate.signalId,
        symbol: candidate.symbol,
        selectorRank: index + 1,
        selectorScore: candidate.selectorScore,
        tieBreakHash,
        selected,
        skipReason: selected ? null : slots === 0 ? "NO_AVAILABLE_SLOT" : "SKIP_CAP_LOWER_RANK",
      };
    }),
  };
}

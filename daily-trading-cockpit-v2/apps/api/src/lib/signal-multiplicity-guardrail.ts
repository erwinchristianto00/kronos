/**
 * SIGNAL MULTIPLICITY GUARDRAIL
 *
 * Detects cohorts where multiple records appear to be the same underlying
 * signal rather than independent observations — e.g. 5 DOGEUSDT LONG records
 * with identical openedAt timestamps that all share the same 15-min bucket
 * and the same price bucket.
 *
 * Produces:
 *   nRaw             — raw sample count
 *   nEffective       — count of distinct independent signals after deduplication
 *   multiplicityRatio — nEffective / nRaw (1.0 when nRaw=0)
 *   signalMultiplicityWarning — true when nRaw>=3 AND multiplicityRatio <= 0.50
 *
 * Grouping key: (symbol, direction, entryVariant, exitVariant,
 *               bucket(openedAt, 15min), bucket(entryPrice, 5bps))
 *
 * Read-only. Does not change routing, scoring, or any execution logic.
 */

import type { StrategyExperienceRecord } from "@dtc/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignalMultiplicitySummary {
  /** Raw sample count — number of records in the cohort. */
  nRaw: number;
  /** Count of distinct independent signals after deduplication. */
  nEffective: number;
  /** nEffective / nRaw; 1.0 when nRaw=0. */
  multiplicityRatio: number;
  /**
   * True when nRaw >= 3 AND nEffective / nRaw <= 0.50.
   * Indicates that the cohort likely contains clustered duplicates
   * rather than independent observations.
   */
  signalMultiplicityWarning: boolean;
}

// ─── Bucket helpers ───────────────────────────────────────────────────────────

const FIFTEEN_MIN_MS = 15 * 60_000;

/** Floors a timestamp (ms) to a 15-minute bucket index. */
export function bucketOpenedAt(epochMs: number): number {
  return Math.floor(epochMs / FIFTEEN_MIN_MS);
}

/**
 * Maps a price to a 5-bps bucket index using the log-price formula.
 * Returns null if price is not a positive finite number.
 */
export function bucketEntryPrice(price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.floor(Math.log(price) / 0.0005);
}

// ─── Effective-N computation ──────────────────────────────────────────────────

let _uniqueNullPriceCounter = 0;

/** Resets the null-price counter — intended for test isolation only. */
export function _resetNullPriceCounter(): void {
  _uniqueNullPriceCounter = 0;
}

/**
 * Computes the signal multiplicity summary for a flat list of records
 * belonging to ONE cohort (same symbol/direction/entry/exit).
 *
 * Each record's deduplication key is:
 *   (symbol, direction, entryVariant, exitVariant, timeBucket, priceBucket)
 *
 * Records with no entry price are each assigned a unique priceBucket so they
 * are never collapsed with each other or with priced records.
 */
export function computeSignalMultiplicity(
  records: StrategyExperienceRecord[],
): SignalMultiplicitySummary {
  const nRaw = records.length;
  if (nRaw === 0) {
    return { nRaw: 0, nEffective: 0, multiplicityRatio: 1.0, signalMultiplicityWarning: false };
  }

  const seenKeys = new Set<string>();
  for (const rec of records) {
    const symbol = rec.context.symbol;
    const direction = rec.context.direction;
    const entry = rec.context.selectedEntryVariant ?? rec.outcome.selectedEntryVariant ?? "UNKNOWN_ENTRY";
    const exit = rec.context.selectedExitVariant ?? rec.outcome.selectedExitVariant ?? "UNKNOWN_EXIT";

    // Time bucket from outcome.openedAt (populated by buildResolvedTradeOutcomeSnapshot)
    const openedAtRaw = rec.outcome.openedAt ?? rec.context.scanTimestamp ?? null;
    const epochMs = openedAtRaw ? new Date(openedAtRaw).getTime() : NaN;
    const timeBucket = Number.isFinite(epochMs) ? bucketOpenedAt(epochMs) : `t_null_${_uniqueNullPriceCounter++}`;

    // Price bucket from context.entryPrice
    const price = rec.context.entryPrice ?? null;
    const priceBucketNum = price !== null ? bucketEntryPrice(price) : null;
    const priceBucket = priceBucketNum !== null ? priceBucketNum : `p_null_${_uniqueNullPriceCounter++}`;

    const key = `${symbol}|${direction}|${entry}|${exit}|${timeBucket}|${priceBucket}`;
    seenKeys.add(key);
  }

  const nEffective = seenKeys.size;
  const multiplicityRatio = nRaw === 0 ? 1.0 : nEffective / nRaw;
  const signalMultiplicityWarning = nRaw >= 3 && multiplicityRatio <= 0.5;

  return { nRaw, nEffective, multiplicityRatio, signalMultiplicityWarning };
}

// ─── Cohort-level helpers ────────────────────────────────────────────────────

/**
 * Returns true if all records in a cohort have calibrationVerdict
 * === "RAW_EDGE_NOT_VALIDATED". An empty cohort returns false.
 */
export function allRecordsRawEdgeNotValidated(records: StrategyExperienceRecord[]): boolean {
  if (records.length === 0) return false;
  return records.every((r) => r.context.calibrationVerdict === "RAW_EDGE_NOT_VALIDATED");
}

/**
 * Returns true if a cohort should be blocked from receiving an EARLY_PROMISING
 * (or equivalent) label due to signal multiplicity or planner verdict issues.
 *
 * Blocked when:
 *   1. signalMultiplicityWarning is true, OR
 *   2. all records have calibrationVerdict === "RAW_EDGE_NOT_VALIDATED"
 */
export function isEarlyPromisingBlocked(
  records: StrategyExperienceRecord[],
  multiplicity: SignalMultiplicitySummary,
): boolean {
  return multiplicity.signalMultiplicityWarning || allRecordsRawEdgeNotValidated(records);
}

// ─── Dashboard format helper ──────────────────────────────────────────────────

/**
 * Formats a multiplicity summary into the Section I display string fragment.
 *
 * Examples:
 *   nRaw=5, nEff=1, warning  → "n=5 (nEff=1, ⚠ MULTIPLICITY)"
 *   nRaw=5, nEff=4, no warn  → "n=5 (nEff=4)"
 *   nRaw=5, nEff=5, no warn  → "n=5"
 */
export function formatMultiplicitySummary(summary: SignalMultiplicitySummary): string {
  const { nRaw, nEffective, signalMultiplicityWarning } = summary;
  if (nEffective === nRaw) {
    return `n=${nRaw}`;
  }
  if (signalMultiplicityWarning) {
    return `n=${nRaw} (nEff=${nEffective}, ⚠ MULTIPLICITY)`;
  }
  return `n=${nRaw} (nEff=${nEffective})`;
}

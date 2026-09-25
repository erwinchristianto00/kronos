/**
 * Four-Brain exact-fill reinforcement (TESTNET, SHADOW-ONLY).
 *
 * This is deliberately separate from four-brain-edge-memory.ts:
 *
 * - Direction outcomes are BTC-proxy market-direction calibration and remain diagnostic.
 * - This store learns only from actual Tier-1 matched TESTNET fills, net of the writer's recorded
 *   R convention, and only when the Four-Brain itself recommended ENTER_NOW.
 * - Evidence is keyed exactly by canonical regime × lane × symbol × side.  There is no backfill,
 *   no nearest-regime fallback, no cross-symbol borrowing, and no Tier-2 simulation blending.
 *
 * The result is an advisory quality adjustment consumed by ExecutiveDecision only.  It cannot alter
 * allocation, leverage, order placement, stop/TP, lane eligibility, or CORTEX beta.
 */
import { resolve } from "node:path";

import {
  getDirectionEntryOutcomeStore,
  type DirectionEntryOutcomeStore,
  type EntryOutcomeRecord,
} from "./direction-entry-outcome-store.js";
import type {
  FourBrainExecutionReinforcement,
  FourBrainReinforcementVerdict,
} from "./four-brain-types.js";

export const FOUR_BRAIN_REINFORCEMENT_MIN_EFFECTIVE_SAMPLES = 8;
export const FOUR_BRAIN_REINFORCEMENT_HURDLE_R = 0.03;
export const FOUR_BRAIN_REINFORCEMENT_MAX_ADJUSTMENT = 0.1;
/** Conservative cluster for overlapping same-symbol attempts. */
export const FOUR_BRAIN_REINFORCEMENT_BLOCK_MS = 4 * 60 * 60_000;

type CanonicalRegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";

export interface FourBrainExecutionReinforcementQuery {
  canonicalRegimeFamily: CanonicalRegimeFamily | null | undefined;
  laneId: string | null | undefined;
  symbolOrBasketId: string | null | undefined;
  side: "LONG" | "SHORT";
}

/** Read-only lifecycle summary for the operator watchdog.  It does not infer a reward: it reports
 * exactly what was persisted in the outcome store and what is structurally usable by ranking. */
export interface FourBrainExecutionReinforcementStatus {
  /** Resolved Entry outcomes written with the direct actual-fill binding provenance. */
  actualFillOutcomeRecords: number;
  /** Of those, rows with complete lineage/economics that can enter the shadow ranking fold. */
  actualFillRankingRecords: number;
  /** All rows currently accepted by the ranking fold (kept separate from the direct cohort). */
  rankingRecords: number;
  bucketCount: number;
  effectiveBucketCount: number;
  lastActualFillDecisionAtMs: number | null;
}

interface Bucket {
  n: number;
  wins: number;
  sumNetR: number;
  blocks: Set<number>;
  matchedCloseKeys: Set<string>;
}

function canonicalRegimeOrNull(value: unknown): CanonicalRegimeFamily | null {
  return value === "BULLISH" || value === "BEARISH" || value === "MIXED" || value === "UNKNOWN"
    ? value
    : null;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function keyOf(query: Required<FourBrainExecutionReinforcementQuery>): string {
  return [query.canonicalRegimeFamily, query.laneId, query.symbolOrBasketId, query.side].join("::");
}

function usableRecord(record: EntryOutcomeRecord): record is EntryOutcomeRecord & {
  canonicalRegimeFamily: CanonicalRegimeFamily;
  laneId: string;
  symbolOrBasketId: string;
  matchedCloseKey: string;
  realizedNetR: number;
} {
  return record.status === "RESOLVED" &&
    record.tier === "TIER1_REALIZED" &&
    record.confidence === "MEASURED" &&
    record.action === "ENTER_NOW" &&
    canonicalRegimeOrNull(record.canonicalRegimeFamily) !== null &&
    nonEmptyStringOrNull(record.laneId) !== null &&
    nonEmptyStringOrNull(record.symbolOrBasketId) !== null &&
    nonEmptyStringOrNull(record.matchedCloseKey) !== null &&
    typeof record.realizedNetR === "number" &&
    Number.isFinite(record.realizedNetR);
}

/** Pure fold used by unit tests and by the read-derived runtime store. */
export function foldEntryOutcomeRecordsForExecutionReinforcement(
  records: readonly EntryOutcomeRecord[],
): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const record of records) {
    if (!usableRecord(record)) continue;
    const canonicalRegimeFamily = canonicalRegimeOrNull(record.canonicalRegimeFamily);
    const laneId = nonEmptyStringOrNull(record.laneId);
    const symbolOrBasketId = nonEmptyStringOrNull(record.symbolOrBasketId);
    const matchedCloseKey = nonEmptyStringOrNull(record.matchedCloseKey);
    if (!canonicalRegimeFamily || !laneId || !symbolOrBasketId || !matchedCloseKey) continue;
    const query: Required<FourBrainExecutionReinforcementQuery> = {
      canonicalRegimeFamily,
      laneId,
      symbolOrBasketId,
      side: record.side,
    };
    const key = keyOf(query);
    const bucket = buckets.get(key) ?? {
      n: 0,
      wins: 0,
      sumNetR: 0,
      blocks: new Set<number>(),
      matchedCloseKeys: new Set<string>(),
    };
    // A matching close must be claimed exactly once.  Keep this defensive dedup in the reader too,
    // so an old/corrupt persisted row cannot turn one real close into multiple learning samples.
    if (bucket.matchedCloseKeys.has(matchedCloseKey)) continue;
    bucket.matchedCloseKeys.add(matchedCloseKey);
    bucket.n += 1;
    bucket.sumNetR += record.realizedNetR;
    if (record.realizedNetR > 0) bucket.wins += 1;
    if (Number.isFinite(record.asOfMs)) {
      bucket.blocks.add(Math.floor(record.asOfMs / FOUR_BRAIN_REINFORCEMENT_BLOCK_MS));
    }
    buckets.set(key, bucket);
  }
  return buckets;
}

function empty(query: FourBrainExecutionReinforcementQuery): FourBrainExecutionReinforcement {
  return {
    source: "TIER1_REALIZED",
    verdict: "INSUFFICIENT",
    scope: "NONE",
    canonicalRegimeFamily: canonicalRegimeOrNull(query.canonicalRegimeFamily),
    laneId: nonEmptyStringOrNull(query.laneId),
    symbolOrBasketId: nonEmptyStringOrNull(query.symbolOrBasketId),
    side: query.side,
    n: 0,
    effectiveN: 0,
    winRate: null,
    avgNetR: null,
    adjustment: 0,
  };
}

/**
 * Exact-fill reinforcement view.  Non-zero adjustments demand enough non-overlapping testnet samples;
 * thin evidence deliberately reports null rates and cannot become a boost or a penalty.
 */
export class FourBrainExecutionReinforcementStore {
  private buckets: Map<string, Bucket> = new Map();

  constructor(private readonly outcomeStore: DirectionEntryOutcomeStore) {
    this.rebuild();
  }

  rebuild(): void {
    this.buckets = foldEntryOutcomeRecordsForExecutionReinforcement(this.outcomeStore.getState().entry.records);
  }

  getStatus(): FourBrainExecutionReinforcementStatus {
    this.rebuild();
    const records = this.outcomeStore.getState().entry.records;
    const actualFillRows = records.filter(
      (record) => record.status === "RESOLVED" && record.realizedRSource === "actual_fill_binding",
    );
    const actualFillRankingRecords = actualFillRows.filter(usableRecord).length;
    const rankingRecords = records.filter(usableRecord).length;
    const lastActualFillDecisionAtMs = actualFillRows.reduce<number | null>((latest, row) => {
      if (!Number.isFinite(row.asOfMs)) return latest;
      return Math.max(latest ?? 0, row.asOfMs) || null;
    }, null);
    return {
      actualFillOutcomeRecords: actualFillRows.length,
      actualFillRankingRecords,
      rankingRecords,
      bucketCount: this.buckets.size,
      effectiveBucketCount: [...this.buckets.values()]
        .filter((bucket) => bucket.blocks.size >= FOUR_BRAIN_REINFORCEMENT_MIN_EFFECTIVE_SAMPLES)
        .length,
      lastActualFillDecisionAtMs,
    };
  }

  lookup(query: FourBrainExecutionReinforcementQuery): FourBrainExecutionReinforcement {
    const canonicalRegimeFamily = canonicalRegimeOrNull(query.canonicalRegimeFamily);
    const laneId = nonEmptyStringOrNull(query.laneId);
    const symbolOrBasketId = nonEmptyStringOrNull(query.symbolOrBasketId);
    if (!canonicalRegimeFamily || !laneId || !symbolOrBasketId) return empty(query);
    const bucket = this.buckets.get(keyOf({ canonicalRegimeFamily, laneId, symbolOrBasketId, side: query.side }));
    if (!bucket || bucket.n === 0) return empty(query);
    const effectiveN = bucket.blocks.size;
    if (effectiveN < FOUR_BRAIN_REINFORCEMENT_MIN_EFFECTIVE_SAMPLES) {
      return { ...empty(query), n: bucket.n, effectiveN };
    }
    const avgNetR = bucket.sumNetR / bucket.n;
    const winRate = bucket.wins / bucket.n;
    let verdict: FourBrainReinforcementVerdict = "NEUTRAL";
    if (avgNetR >= FOUR_BRAIN_REINFORCEMENT_HURDLE_R && winRate >= 0.55) verdict = "POSITIVE";
    else if (avgNetR <= -FOUR_BRAIN_REINFORCEMENT_HURDLE_R && winRate <= 0.45) verdict = "NEGATIVE";

    const sign = verdict === "POSITIVE" ? 1 : verdict === "NEGATIVE" ? -1 : 0;
    // At the first eligible evidence block the adjustment is already bounded to half-size; it only
    // reaches its cap after another min-sample window, and never changes risk or execution directly.
    const sampleWeight = Math.min(1, effectiveN / (FOUR_BRAIN_REINFORCEMENT_MIN_EFFECTIVE_SAMPLES * 2));
    const returnWeight = Math.min(1, Math.abs(avgNetR) / 0.25);
    return {
      source: "TIER1_REALIZED",
      verdict,
      scope: "EXACT_LANE_REGIME_SYMBOL",
      canonicalRegimeFamily,
      laneId,
      symbolOrBasketId,
      side: query.side,
      n: bucket.n,
      effectiveN,
      winRate,
      avgNetR,
      adjustment: sign * FOUR_BRAIN_REINFORCEMENT_MAX_ADJUSTMENT * sampleWeight * returnWeight,
    };
  }
}

const storesByDataDir = new Map<string, FourBrainExecutionReinforcementStore>();

/** Rebuild-on-read so a freshly closed, reconciled Tier-1 result appears without restart. */
export function getFourBrainExecutionReinforcement(dataDir = "data"): FourBrainExecutionReinforcementStore {
  const key = resolve(dataDir);
  let store = storesByDataDir.get(key);
  if (!store) {
    store = new FourBrainExecutionReinforcementStore(getDirectionEntryOutcomeStore(dataDir));
    storesByDataDir.set(key, store);
  } else {
    store.rebuild();
  }
  return store;
}

export function _resetFourBrainExecutionReinforcementForTests(): void {
  storesByDataDir.clear();
}

import type { FoundryArtifactKind } from "./artifact-schema.js";

export const FOUNDRY_SCHEMA_V1 = "v1" as const;

export interface ValidatedFoundryRow {
  readonly symbol?: string;
  readonly timestampMs: number;
  readonly sourceHash: string;
  readonly [key: string]: unknown;
}

const SYMBOL = /^[A-Z0-9]{3,32}$/;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("FOUNDRY_ROW_NOT_OBJECT");
  return value as Record<string, unknown>;
};
const positiveTime = (value: unknown, field: string): number => { if (!finite(value) || !Number.isInteger(value) || value < 0) throw new Error(`FOUNDRY_INVALID_${field}`); return value; };
const text = (value: unknown, field: string): string => { if (typeof value !== "string" || !value) throw new Error(`FOUNDRY_INVALID_${field}`); return value; };
const symbol = (value: unknown): string => { const normalized = text(value, "SYMBOL"); if (normalized !== normalized.toUpperCase() || !SYMBOL.test(normalized)) throw new Error("FOUNDRY_SYMBOL_NOT_NORMALIZED"); return normalized; };
const source = (row: Record<string, unknown>): string => text(row.sourceHash, "SOURCE_HASH");
const number = (value: unknown, field: string, min = -Infinity): number => { if (!finite(value) || value < min) throw new Error(`FOUNDRY_INVALID_${field}`); return value; };
const boolean = (value: unknown, field: string): boolean => { if (typeof value !== "boolean") throw new Error(`FOUNDRY_INVALID_${field}`); return value; };

function timestampFor(kind: FoundryArtifactKind, row: Record<string, unknown>): number {
  if (kind === "COMPLETED_CANDLES") return positiveTime(row.openTimeMs, "OPEN_TIME_MS");
  if (kind === "FUNDING_SETTLEMENTS") return positiveTime(row.canonicalSettlementTimeMs, "CANONICAL_SETTLEMENT_TIME_MS");
  return positiveTime(row.asOfMs ?? row.effectiveTimeMs ?? row.decisionTimeMs, "EFFECTIVE_TIME_MS");
}

function identity(kind: FoundryArtifactKind, row: Record<string, unknown>): string {
  const s = row.symbol === undefined ? "*" : symbol(row.symbol);
  if (kind === "COMPLETED_CANDLES") return `${s}:${positiveTime(row.openTimeMs, "OPEN_TIME_MS")}`;
  if (kind === "FUNDING_SETTLEMENTS") return `${s}:${positiveTime(row.canonicalSettlementTimeMs, "CANONICAL_SETTLEMENT_TIME_MS")}`;
  if (kind === "CANONICAL_EPISODES") return `${s}:${positiveTime(row.decisionTimeMs, "DECISION_TIME_MS")}`;
  return `${s}:${timestampFor(kind, row)}`;
}

function validateByKind(kind: FoundryArtifactKind, row: Record<string, unknown>): ValidatedFoundryRow {
  const sourceHash = source(row);
  if (kind === "COMPLETED_CANDLES") {
    const openTimeMs = positiveTime(row.openTimeMs, "OPEN_TIME_MS"); const closeTimeMs = positiveTime(row.closeTimeMs, "CLOSE_TIME_MS"); const open = number(row.open, "OPEN", Number.MIN_VALUE); const high = number(row.high, "HIGH", Number.MIN_VALUE); const low = number(row.low, "LOW", Number.MIN_VALUE); const close = number(row.close, "CLOSE", Number.MIN_VALUE); const volume = number(row.volume, "VOLUME", 0);
    if (closeTimeMs <= openTimeMs || high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new Error("FOUNDRY_CANDLE_OHLC_INVALID");
    return { symbol: symbol(row.symbol), timestampMs: openTimeMs, openTimeMs, closeTimeMs, open, high, low, close, volume, sourceHash };
  }
  if (kind === "FUNDING_SETTLEMENTS") {
    const canonicalSettlementTimeMs = positiveTime(row.canonicalSettlementTimeMs, "CANONICAL_SETTLEMENT_TIME_MS"); const observedSettlementTimeMs = positiveTime(row.observedSettlementTimeMs, "OBSERVED_SETTLEMENT_TIME_MS"); const alignmentOffsetMs = number(row.alignmentOffsetMs, "ALIGNMENT_OFFSET_MS");
    if (observedSettlementTimeMs - canonicalSettlementTimeMs !== alignmentOffsetMs) throw new Error("FOUNDRY_FUNDING_ALIGNMENT_OFFSET_INVALID");
    return { symbol: symbol(row.symbol), timestampMs: canonicalSettlementTimeMs, canonicalSettlementTimeMs, observedSettlementTimeMs, alignmentOffsetMs, scheduleSourceHash: text(row.scheduleSourceHash, "SCHEDULE_SOURCE_HASH"), fundingIntervalMs: positiveTime(row.fundingIntervalMs, "FUNDING_INTERVAL_MS"), rate: number(row.rate, "RATE"), sourceHash };
  }
  if (kind === "LISTING_DELISTING_TIMELINE") { const status = text(row.status, "STATUS"); if (status !== "LISTED" && status !== "DELISTED") throw new Error("FOUNDRY_LISTING_STATUS_INVALID"); const effectiveTimeMs = positiveTime(row.effectiveTimeMs, "EFFECTIVE_TIME_MS"); const validUntilMs = positiveTime(row.validUntilMs, "VALID_UNTIL_MS"); if (validUntilMs < effectiveTimeMs) throw new Error("FOUNDRY_TIMELINE_EFFECTIVE_BOUNDS_INVALID"); return { symbol: symbol(row.symbol), timestampMs: effectiveTimeMs, effectiveTimeMs, validUntilMs, status, sourceHash }; }
  if (kind === "FUTURES_AVAILABILITY_TIMELINE") { const effectiveTimeMs = positiveTime(row.effectiveTimeMs, "EFFECTIVE_TIME_MS"); const validUntilMs = positiveTime(row.validUntilMs, "VALID_UNTIL_MS"); if (validUntilMs < effectiveTimeMs) throw new Error("FOUNDRY_TIMELINE_EFFECTIVE_BOUNDS_INVALID"); return { symbol: symbol(row.symbol), timestampMs: effectiveTimeMs, effectiveTimeMs, validUntilMs, available: boolean(row.available, "AVAILABLE"), sourceHash }; }
  if (kind === "MINIMUM_HISTORY_ELIGIBILITY") { const asOfMs = positiveTime(row.asOfMs, "AS_OF_MS"); return { symbol: symbol(row.symbol), timestampMs: asOfMs, asOfMs, eligible: boolean(row.eligible, "ELIGIBLE"), sourceHash }; }
  if (kind === "PIT_LIQUIDITY_SPREAD") { const asOfMs = positiveTime(row.asOfMs, "AS_OF_MS"); const validUntilMs = positiveTime(row.validUntilMs, "VALID_UNTIL_MS"); if (validUntilMs < asOfMs) throw new Error("FOUNDRY_LIQUIDITY_EFFECTIVE_BOUNDS_INVALID"); return { symbol: symbol(row.symbol), timestampMs: asOfMs, asOfMs, validUntilMs, volume: number(row.volume, "VOLUME", 0), liquidityNotional: number(row.liquidityNotional, "LIQUIDITY_NOTIONAL", 0), spreadBps: number(row.spreadBps, "SPREAD_BPS", 0), sourceHash }; }
  if (kind === "FEE_ASSUMPTIONS") { const asOfMs = positiveTime(row.asOfMs, "AS_OF_MS"); const scope = row.symbol === "*" ? "*" : symbol(row.symbol); return { symbol: scope, timestampMs: asOfMs, asOfMs, makerFeeBps: number(row.makerFeeBps, "MAKER_FEE_BPS", 0), takerFeeBps: number(row.takerFeeBps, "TAKER_FEE_BPS", 0), sourceHash }; }
  if (kind === "CANONICAL_EPISODES") { const decisionTimeMs = positiveTime(row.decisionTimeMs, "DECISION_TIME_MS"); return { symbol: symbol(row.symbol), timestampMs: decisionTimeMs, decisionTimeMs, episodeId: text(row.episodeId, "EPISODE_ID"), sourceHash }; }
  if (kind === "PORTFOLIO_RISK_SNAPSHOTS") { const asOfMs = positiveTime(row.asOfMs, "AS_OF_MS"); const validUntilMs = positiveTime(row.validUntilMs, "VALID_UNTIL_MS"); const alignedStartMs = positiveTime(row.alignedStartMs, "ALIGNED_START_MS"); const alignedEndMs = positiveTime(row.alignedEndMs, "ALIGNED_END_MS"); const alignedObservationCount = positiveTime(row.alignedObservationCount, "ALIGNED_OBSERVATION_COUNT"); if (validUntilMs < asOfMs || alignedEndMs < alignedStartMs || alignedEndMs >= asOfMs) throw new Error("FOUNDRY_RISK_EFFECTIVE_BOUNDS_INVALID"); if (!Array.isArray(row.alignedSourceHashes) || row.alignedSourceHashes.some((hash) => typeof hash !== "string" || !hash)) throw new Error("FOUNDRY_RISK_ALIGNED_SOURCE_HASHES_INVALID"); return { symbol: symbol(row.symbol), timestampMs: asOfMs, asOfMs, validUntilMs, alignedStartMs, alignedEndMs, alignedObservationCount, alignedTimestampHash: text(row.alignedTimestampHash, "ALIGNED_TIMESTAMP_HASH"), alignedSourceHashes: [...row.alignedSourceHashes] as string[], btcBeta: number(row.btcBeta, "BTC_BETA"), correlationCluster: text(row.correlationCluster, "CORRELATION_CLUSTER"), sourceHash }; }
  if (kind === "KRONOS_DECISION_LEDGER") { const decisionTimeMs = positiveTime(row.decisionTimeMs, "DECISION_TIME_MS"); const side = text(row.side, "SIDE"); if (side !== "LONG" && side !== "SHORT") throw new Error("FOUNDRY_KRONOS_SIDE_INVALID"); return { symbol: symbol(row.symbol), timestampMs: decisionTimeMs, decisionTimeMs, side, regime: text(row.regime, "REGIME"), exitTemplate: text(row.exitTemplate, "EXIT_TEMPLATE"), sizingRule: text(row.sizingRule, "SIZING_RULE"), portfolioRule: text(row.portfolioRule, "PORTFOLIO_RULE"), sourceHash }; }
  throw new Error(`FOUNDRY_ARTIFACT_KIND_UNKNOWN_${kind}`);
}

export function validateFoundryRows(kind: FoundryArtifactKind, schemaVersion: string, rows: readonly unknown[]): ValidatedFoundryRow[] {
  if (schemaVersion !== FOUNDRY_SCHEMA_V1) throw new Error(`FOUNDRY_SCHEMA_VERSION_UNSUPPORTED_${schemaVersion}`);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("FOUNDRY_ROWS_EMPTY_OR_INVALID");
  const output = rows.map((value) => validateByKind(kind, object(value)));
  const seen = new Set<string>(); let prior = -Infinity;
  for (const [index, row] of output.entries()) {
    const raw = object(rows[index]); const key = identity(kind, raw);
    if (seen.has(key)) throw new Error(`FOUNDRY_DUPLICATE_OR_CONFLICTING_ROW_${key}`); seen.add(key);
    if (row.timestampMs < prior) throw new Error("FOUNDRY_TIMESTAMPS_NOT_MONOTONIC"); prior = row.timestampMs;
  }
  if (["LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "FEE_ASSUMPTIONS"].includes(kind)) {
    const lastState = new Map<string, unknown>();
    for (const row of output) {
      const key = row.symbol ?? "*"; const state = kind === "LISTING_DELISTING_TIMELINE" ? row.status : kind === "FUTURES_AVAILABILITY_TIMELINE" ? row.available : kind === "MINIMUM_HISTORY_ELIGIBILITY" ? row.eligible : `${row.makerFeeBps}:${row.takerFeeBps}`;
      if (lastState.has(key) && lastState.get(key) === state) throw new Error(`FOUNDRY_TIMELINE_REDUNDANT_TRANSITION_${key}_${row.timestampMs}`);
      lastState.set(key, state);
    }
  }
  return output;
}

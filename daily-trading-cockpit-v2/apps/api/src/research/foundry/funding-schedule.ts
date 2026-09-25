import type { ValidatedFoundryRow } from "./semantic-validators.js";

export type FundingScheduleKind = "UTC_8H_BOUNDARIES" | "EXPLICIT_HISTORICAL";

/** Source-backed settlement schedule; never inferred from the first observed row. */
export interface FundingScheduleMetadata {
  schemaVersion: "v1";
  symbol: string;
  kind: FundingScheduleKind;
  source: string;
  sourceHash: string;
  alignmentToleranceMs: number;
  settlementTimesMs?: readonly number[];
}

export interface FundingSettlementAlignment {
  symbol: string;
  expectedSettlementTimesMs: number[];
  actualSettlementTimesMs: number[];
  missingSettlementTimesMs: number[];
  excessSettlementTimesMs: number[];
  alignmentOffsetsMs: Record<string, number>;
  scheduleProvenance: Pick<FundingScheduleMetadata, "kind" | "source" | "sourceHash" | "alignmentToleranceMs">;
}

export interface ObservedFundingSettlement {
  symbol: string;
  observedSettlementTimeMs: number;
  fundingIntervalMs: number;
  rate: number;
  sourceHash: string;
}

const EIGHT_HOURS = 8 * 60 * 60 * 1_000;

function assertSchedule(metadata: FundingScheduleMetadata): void {
  if (metadata.schemaVersion !== "v1" || !metadata.symbol || !metadata.source || !metadata.sourceHash || !Number.isInteger(metadata.alignmentToleranceMs) || metadata.alignmentToleranceMs < 0) throw new Error("FOUNDRY_FUNDING_SCHEDULE_METADATA_INVALID");
  if (metadata.kind === "EXPLICIT_HISTORICAL" && (!metadata.settlementTimesMs?.length || metadata.settlementTimesMs.some((time) => !Number.isInteger(time) || time < 0))) throw new Error("FOUNDRY_FUNDING_SCHEDULE_EXPLICIT_INVALID");
}

/** UTC boundaries are exchange schedule metadata, not a cadence anchored at experiment start. */
export function expectedFundingSettlementTimes(metadata: FundingScheduleMetadata, startMs: number, endMs: number): number[] {
  assertSchedule(metadata);
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs >= endMs) throw new Error("FOUNDRY_FUNDING_SCHEDULE_RANGE_INVALID");
  if (metadata.kind === "EXPLICIT_HISTORICAL") return [...new Set(metadata.settlementTimesMs!)].sort((a, b) => a - b).filter((time) => time >= startMs && time < endMs);
  const first = Math.ceil(startMs / EIGHT_HOURS) * EIGHT_HOURS;
  const times: number[] = [];
  for (let time = first; time < endMs; time += EIGHT_HOURS) times.push(time);
  return times;
}

export function alignFundingSettlements(input: { rows: readonly ValidatedFoundryRow[]; metadata: FundingScheduleMetadata; startMs: number; endMs: number }): FundingSettlementAlignment {
  const expected = expectedFundingSettlementTimes(input.metadata, input.startMs, input.endMs);
  const sourceRows = input.rows.filter((row) => row.symbol === input.metadata.symbol).map((row) => row as ValidatedFoundryRow & { canonicalSettlementTimeMs: number; observedSettlementTimeMs: number; alignmentOffsetMs: number; scheduleSourceHash: string });
  for (const row of sourceRows) {
    if (row.scheduleSourceHash !== input.metadata.sourceHash || row.timestampMs !== row.canonicalSettlementTimeMs || row.observedSettlementTimeMs - row.canonicalSettlementTimeMs !== row.alignmentOffsetMs || Math.abs(row.alignmentOffsetMs) > input.metadata.alignmentToleranceMs) throw new Error(`FOUNDRY_FUNDING_CANONICAL_IDENTITY_INVALID_${input.metadata.symbol}_${row.timestampMs}`);
  }
  const actual = sourceRows.map((row) => row.observedSettlementTimeMs).sort((a, b) => a - b);
  const matched = new Set<number>(); const offsets: Record<string, number> = {}; const excess: number[] = [];
  for (const row of sourceRows) {
    const timestamp = row.observedSettlementTimeMs; const candidate = row.canonicalSettlementTimeMs;
    if (!expected.includes(candidate) || matched.has(candidate) || Math.abs(timestamp - candidate) > input.metadata.alignmentToleranceMs) { excess.push(timestamp); continue; }
    matched.add(candidate); offsets[String(candidate)] = row.alignmentOffsetMs;
  }
  return {
    symbol: input.metadata.symbol, expectedSettlementTimesMs: expected, actualSettlementTimesMs: actual,
    missingSettlementTimesMs: expected.filter((time) => !matched.has(time)), excessSettlementTimesMs: excess,
    alignmentOffsetsMs: offsets,
    scheduleProvenance: { kind: input.metadata.kind, source: input.metadata.source, sourceHash: input.metadata.sourceHash, alignmentToleranceMs: input.metadata.alignmentToleranceMs },
  };
}

/** Converts observed exchange timestamps into the sole canonical settlement identity. */
export function canonicalizeFundingSettlements(input: { rows: readonly ObservedFundingSettlement[]; schedules: readonly FundingScheduleMetadata[]; startMs: number; endMs: number }): Array<ObservedFundingSettlement & { canonicalSettlementTimeMs: number; alignmentOffsetMs: number; scheduleSourceHash: string }> {
  const output: Array<ObservedFundingSettlement & { canonicalSettlementTimeMs: number; alignmentOffsetMs: number; scheduleSourceHash: string }> = [];
  const claimed = new Set<string>();
  for (const row of input.rows) {
    const schedule = input.schedules.find((candidate) => candidate.symbol === row.symbol);
    if (!schedule) throw new Error(`FOUNDRY_FUNDING_SCHEDULE_SYMBOL_MISSING_${row.symbol}`);
    const candidates = expectedFundingSettlementTimes(schedule, input.startMs, input.endMs).filter((time) => Math.abs(row.observedSettlementTimeMs - time) <= schedule.alignmentToleranceMs);
    if (candidates.length !== 1) throw new Error(`FOUNDRY_FUNDING_ALIGNMENT_OUT_OF_TOLERANCE_OR_AMBIGUOUS_${row.symbol}_${row.observedSettlementTimeMs}`);
    const canonicalSettlementTimeMs = candidates[0]!; const key = `${row.symbol}:${canonicalSettlementTimeMs}`;
    if (claimed.has(key)) throw new Error(`FOUNDRY_FUNDING_DUPLICATE_CANONICAL_SETTLEMENT_${key}`);
    claimed.add(key); output.push({ ...row, canonicalSettlementTimeMs, alignmentOffsetMs: row.observedSettlementTimeMs - canonicalSettlementTimeMs, scheduleSourceHash: schedule.sourceHash });
  }
  for (const schedule of input.schedules) for (const canonicalSettlementTimeMs of expectedFundingSettlementTimes(schedule, input.startMs, input.endMs)) {
    if (!claimed.has(`${schedule.symbol}:${canonicalSettlementTimeMs}`)) throw new Error(`FOUNDRY_FUNDING_SETTLEMENT_MISSING_${schedule.symbol}_${canonicalSettlementTimeMs}`);
  }
  return output.sort((a, b) => a.canonicalSettlementTimeMs - b.canonicalSettlementTimeMs || a.symbol.localeCompare(b.symbol));
}

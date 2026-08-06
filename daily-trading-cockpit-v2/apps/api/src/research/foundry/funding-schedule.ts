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
  const actual = input.rows.filter((row) => row.symbol === input.metadata.symbol).map((row) => row.timestampMs).sort((a, b) => a - b);
  const matched = new Set<number>(); const offsets: Record<string, number> = {}; const excess: number[] = [];
  for (const timestamp of actual) {
    const candidate = expected.find((time) => !matched.has(time) && Math.abs(timestamp - time) <= input.metadata.alignmentToleranceMs);
    if (candidate === undefined) excess.push(timestamp);
    else { matched.add(candidate); offsets[String(candidate)] = timestamp - candidate; }
  }
  return {
    symbol: input.metadata.symbol, expectedSettlementTimesMs: expected, actualSettlementTimesMs: actual,
    missingSettlementTimesMs: expected.filter((time) => !matched.has(time)), excessSettlementTimesMs: excess,
    alignmentOffsetsMs: offsets,
    scheduleProvenance: { kind: input.metadata.kind, source: input.metadata.source, sourceHash: input.metadata.sourceHash, alignmentToleranceMs: input.metadata.alignmentToleranceMs },
  };
}

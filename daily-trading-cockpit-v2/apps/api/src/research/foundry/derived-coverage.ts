import type { FoundryArtifactKind } from "./artifact-schema.js";
import { FOUNDRY_SCHEMA_V2, type FoundrySchemaVersion, type ValidatedFoundryRow } from "./semantic-validators.js";
import { alignFundingSettlements, type FundingScheduleMetadata } from "./funding-schedule.js";

export interface FoundryExpectedCoverage {
  startMs: number;
  endMs: number;
  symbols: string[];
  cadenceMs?: number;
  maxSnapshotAgeMs?: number;
  /** Required for funding: exchange or historical schedule provenance. */
  fundingSchedules?: readonly FundingScheduleMetadata[];
}

export interface DerivedFoundryCoverage {
  expectedStartMs: number;
  expectedEndMs: number;
  coveredStartMs: number | null;
  coveredEndMs: number | null;
  coveredSymbols: string[];
  cadenceMs: number | null;
  missingIntervals: Array<{ startMs: number; endMs: number; reason: string }>;
  missingSymbols: string[];
  duplicateKeys: string[];
  perSymbolGaps: Record<string, Array<{ startMs: number; endMs: number; reason: string }>>;
  fundingScheduleCoverage?: Record<string, ReturnType<typeof alignFundingSettlements>>;
}

function grouped(rows: readonly ValidatedFoundryRow[]): Map<string, ValidatedFoundryRow[]> {
  const output = new Map<string, ValidatedFoundryRow[]>();
  for (const row of rows) output.set(row.symbol ?? "*", [...(output.get(row.symbol ?? "*") ?? []), row]);
  return output;
}

function inferredCadence(rows: readonly ValidatedFoundryRow[]): number | null {
  const timestamps = [...new Set(rows.map((row) => row.timestampMs))].sort((a, b) => a - b); if (timestamps.length < 2) return null;
  const deltas = timestamps.slice(1).map((time, index) => time - timestamps[index]!); return Math.min(...deltas);
}

/** Coverage is derived only from normalized rows and an explicit expected contract. */
export function deriveFoundryCoverage(kind: FoundryArtifactKind, rows: readonly ValidatedFoundryRow[], expected: FoundryExpectedCoverage, schemaVersion: FoundrySchemaVersion = "v1"): DerivedFoundryCoverage {
  if (expected.startMs >= expected.endMs || expected.symbols.length === 0) throw new Error("FOUNDRY_EXPECTED_COVERAGE_INVALID");
  const coveredSymbols = [...new Set(rows.flatMap((row) => row.symbol && row.symbol !== "*" ? [row.symbol] : []))].sort(); const bySymbol = grouped(rows);
  const cadenceMs = expected.cadenceMs ?? inferredCadence(rows); const missingIntervals: DerivedFoundryCoverage["missingIntervals"] = []; const perSymbolGaps: DerivedFoundryCoverage["perSymbolGaps"] = {};
  const missingSymbols = expected.symbols.filter((symbol) => !coveredSymbols.includes(symbol) && !(kind === "FEE_ASSUMPTIONS" && bySymbol.has("*"))).sort();
  const fundingScheduleCoverage: NonNullable<DerivedFoundryCoverage["fundingScheduleCoverage"]> = {};
  if (kind === "FUNDING_SETTLEMENTS" && !expected.fundingSchedules?.length) throw new Error("FOUNDRY_FUNDING_SCHEDULE_METADATA_MISSING");
  for (const symbol of expected.symbols) {
    const rowsForSymbol = bySymbol.get(symbol) ?? (kind === "FEE_ASSUMPTIONS" ? bySymbol.get("*") : undefined) ?? [];
    const symbolRows = rowsForSymbol.filter((row) => row.timestampMs >= expected.startMs && row.timestampMs < expected.endMs).sort((a, b) => a.timestampMs - b.timestampMs);
    const gaps: Array<{ startMs: number; endMs: number; reason: string }> = [];
    if (["LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "FEE_ASSUMPTIONS"].includes(kind)) {
      const allSymbolRows = rowsForSymbol.sort((a, b) => a.timestampMs - b.timestampMs);
      if (!allSymbolRows.some((row) => row.timestampMs <= expected.startMs)) gaps.push({ startMs: expected.startMs, endMs: expected.startMs, reason: "INITIAL_STATE_MISSING" });
      if (schemaVersion === FOUNDRY_SCHEMA_V2 && ["LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE"].includes(kind)) {
        const timelineRows = allSymbolRows.filter((row) => row.timestampMs <= expected.endMs - 1);
        let coveredUntilMs: number | null = null;
        for (const row of timelineRows) {
          const validUntilMs = row.validUntilMs;
          if (typeof validUntilMs !== "number" || !Number.isSafeInteger(validUntilMs) || validUntilMs < row.timestampMs) {
            gaps.push({ startMs: Math.max(expected.startMs, row.timestampMs), endMs: Math.min(expected.endMs, Math.max(expected.startMs, row.timestampMs + 1)), reason: "STATE_VALIDITY_MISSING_OR_INVALID" });
            continue;
          }
          if (row.timestampMs > expected.startMs && (coveredUntilMs === null || row.timestampMs > coveredUntilMs + 1)) gaps.push({ startMs: Math.max(expected.startMs, (coveredUntilMs ?? expected.startMs - 1) + 1), endMs: row.timestampMs, reason: "STATE_PROVENANCE_GAP" });
          if (coveredUntilMs !== null && row.timestampMs <= coveredUntilMs) gaps.push({ startMs: row.timestampMs, endMs: Math.min(expected.endMs, coveredUntilMs + 1), reason: "STATE_PROVENANCE_OVERLAP" });
          coveredUntilMs = Math.max(coveredUntilMs ?? -1, validUntilMs);
        }
        if (coveredUntilMs === null || coveredUntilMs < expected.endMs - 1) gaps.push({ startMs: Math.max(expected.startMs, (coveredUntilMs ?? expected.startMs - 1) + 1), endMs: expected.endMs, reason: "STATE_PROVENANCE_TRAILING_GAP" });
      }
    } else if (symbolRows.length === 0) gaps.push({ startMs: expected.startMs, endMs: expected.endMs, reason: "NO_ROWS" });
    else if (kind === "FUNDING_SETTLEMENTS") {
      const schedule = expected.fundingSchedules!.find((candidate) => candidate.symbol === symbol);
      if (!schedule) throw new Error(`FOUNDRY_FUNDING_SCHEDULE_SYMBOL_MISSING_${symbol}`);
      const alignment = alignFundingSettlements({ rows, metadata: schedule, startMs: expected.startMs, endMs: expected.endMs }); fundingScheduleCoverage[symbol] = alignment;
      for (const time of alignment.missingSettlementTimesMs) gaps.push({ startMs: time, endMs: time, reason: "FUNDING_SETTLEMENT_GAP" });
      for (const time of alignment.excessSettlementTimesMs) gaps.push({ startMs: time, endMs: time, reason: "FUNDING_SETTLEMENT_EXCESS_OR_ALIGNMENT_ERROR" });
    } else if (cadenceMs && kind === "COMPLETED_CANDLES") {
      const timestamps = new Set(symbolRows.map((row) => row.timestampMs));
      for (let time = expected.startMs; time < expected.endMs; time += cadenceMs) if (!timestamps.has(time)) gaps.push({ startMs: time, endMs: Math.min(time + cadenceMs, expected.endMs), reason: "CANDLE_GAP" });
    } else if (expected.maxSnapshotAgeMs !== undefined) {
      for (let time = expected.startMs; time < expected.endMs; time += Math.max(1, expected.cadenceMs ?? expected.maxSnapshotAgeMs)) {
        const latest = [...symbolRows].reverse().find((row) => row.timestampMs <= time);
        if (!latest || time - latest.timestampMs > expected.maxSnapshotAgeMs) gaps.push({ startMs: time, endMs: Math.min(time + (expected.cadenceMs ?? expected.maxSnapshotAgeMs), expected.endMs), reason: "PIT_SNAPSHOT_STALE_OR_MISSING" });
      }
    } else {
      if (symbolRows[0]!.timestampMs > expected.startMs) gaps.push({ startMs: expected.startMs, endMs: symbolRows[0]!.timestampMs, reason: "LEADING_GAP" });
      if (symbolRows.at(-1)!.timestampMs >= expected.startMs && symbolRows.at(-1)!.timestampMs < expected.endMs - 1) gaps.push({ startMs: symbolRows.at(-1)!.timestampMs, endMs: expected.endMs, reason: "TRAILING_GAP" });
    }
    if (gaps.length) { perSymbolGaps[symbol] = gaps; missingIntervals.push(...gaps.map((gap) => ({ ...gap, reason: `${symbol}:${gap.reason}` }))); }
  }
  return { expectedStartMs: expected.startMs, expectedEndMs: expected.endMs, coveredStartMs: rows.length ? Math.min(...rows.map((row) => row.timestampMs)) : null, coveredEndMs: rows.length ? Math.max(...rows.map((row) => row.timestampMs)) : null, coveredSymbols, cadenceMs, missingIntervals, missingSymbols, duplicateKeys: [], perSymbolGaps, ...(kind === "FUNDING_SETTLEMENTS" ? { fundingScheduleCoverage } : {}) };
}

export function assertExpectedCoverage(coverage: DerivedFoundryCoverage): void {
  if (coverage.missingSymbols.length || coverage.missingIntervals.length || coverage.coveredStartMs === null || coverage.coveredEndMs === null) throw new Error("FOUNDRY_DERIVED_COVERAGE_MISMATCH");
}

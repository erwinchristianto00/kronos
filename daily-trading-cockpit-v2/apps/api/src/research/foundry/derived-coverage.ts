import type { FoundryArtifactKind } from "./artifact-schema.js";
import type { ValidatedFoundryRow } from "./semantic-validators.js";

export interface FoundryExpectedCoverage {
  startMs: number;
  endMs: number;
  symbols: string[];
  cadenceMs?: number;
  maxSnapshotAgeMs?: number;
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
export function deriveFoundryCoverage(kind: FoundryArtifactKind, rows: readonly ValidatedFoundryRow[], expected: FoundryExpectedCoverage): DerivedFoundryCoverage {
  if (expected.startMs >= expected.endMs || expected.symbols.length === 0) throw new Error("FOUNDRY_EXPECTED_COVERAGE_INVALID");
  const coveredSymbols = [...new Set(rows.flatMap((row) => row.symbol && row.symbol !== "*" ? [row.symbol] : []))].sort(); const bySymbol = grouped(rows);
  const cadenceMs = expected.cadenceMs ?? inferredCadence(rows); const missingIntervals: DerivedFoundryCoverage["missingIntervals"] = []; const perSymbolGaps: DerivedFoundryCoverage["perSymbolGaps"] = {};
  const missingSymbols = expected.symbols.filter((symbol) => !coveredSymbols.includes(symbol)).sort();
  for (const symbol of expected.symbols) {
    const symbolRows = (bySymbol.get(symbol) ?? []).filter((row) => row.timestampMs >= expected.startMs && row.timestampMs < expected.endMs).sort((a, b) => a.timestampMs - b.timestampMs);
    const gaps: Array<{ startMs: number; endMs: number; reason: string }> = [];
    if (symbolRows.length === 0) gaps.push({ startMs: expected.startMs, endMs: expected.endMs, reason: "NO_ROWS" });
    else if (cadenceMs && (kind === "COMPLETED_CANDLES" || kind === "FUNDING_SETTLEMENTS")) {
      const timestamps = new Set(symbolRows.map((row) => row.timestampMs));
      for (let time = expected.startMs; time < expected.endMs; time += cadenceMs) if (!timestamps.has(time)) gaps.push({ startMs: time, endMs: Math.min(time + cadenceMs, expected.endMs), reason: kind === "FUNDING_SETTLEMENTS" ? "FUNDING_SETTLEMENT_GAP" : "CANDLE_GAP" });
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
  return { expectedStartMs: expected.startMs, expectedEndMs: expected.endMs, coveredStartMs: rows.length ? Math.min(...rows.map((row) => row.timestampMs)) : null, coveredEndMs: rows.length ? Math.max(...rows.map((row) => row.timestampMs)) : null, coveredSymbols, cadenceMs, missingIntervals, missingSymbols, duplicateKeys: [], perSymbolGaps };
}

export function assertExpectedCoverage(coverage: DerivedFoundryCoverage): void {
  if (coverage.missingSymbols.length || coverage.missingIntervals.length || coverage.coveredStartMs !== coverage.expectedStartMs || coverage.coveredEndMs === null) throw new Error("FOUNDRY_DERIVED_COVERAGE_MISMATCH");
}

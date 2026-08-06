import { buildFoundryArtifact, type FoundryArtifactManifest } from "./artifact-schema.js";
import { tournamentHash } from "../contract/tournament-contract.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";
import { FOUNDRY_SCHEMA_V1 } from "./semantic-validators.js";
import { canonicalizeFundingSettlements } from "./funding-schedule.js";
import type { FoundrySourceProvenance } from "./source-provenance.js";
import { readArchiveBundle } from "./archive-bundle.js";

const csv = (relativePath: string): boolean => relativePath.endsWith(".csv");
function parseCsv(bytes: Buffer, path: string): Array<Record<string, string>> {
  const lines = bytes.toString("utf8").trim().split(/\r?\n/); if (lines.length < 2) return [];
  const header = lines[0]!.split(","); return lines.slice(1).filter(Boolean).map((line) => { const cells = line.split(","); if (cells.length !== header.length) throw new Error(`FOUNDRY_ARCHIVE_CSV_COLUMNS_INVALID_${path}`); return Object.fromEntries(header.map((key, index) => [key, cells[index]! ])); });
}

/** Deterministic importer for immutable local Binance Vision-style CSV exports. */
export function importLocalBinanceCandleArchive(input: { root: string; expectedCoverage: FoundryExpectedCoverage; source: string; sourceProvenance: FoundrySourceProvenance; generatedAtMs: number; generationSha: string }): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  const archiveBundle = readArchiveBundle({ root: input.root, include: csv }); const rows = archiveBundle.files.flatMap((file) => { const sourceHash = file.fileHash; return parseCsv(archiveBundle.contents.get(file.relativePath)!, file.relativePath).map((row) => ({ symbol: file.relativePath.match(/(?:^|\/)([A-Z0-9]+)\/1h\//)?.[1] ?? "", openTimeMs: Number(row.open_time), closeTimeMs: Number(row.close_time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), sourceHash })); }).sort((a, b) => a.openTimeMs - b.openTimeMs || a.symbol.localeCompare(b.symbol));
  const { contents: _contents, ...archiveIdentity } = archiveBundle;
  const built = buildFoundryArtifact({ artifactKind: "COMPLETED_CANDLES", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, archiveBundle: archiveIdentity, units: { price: "USDT", volume: "base_asset" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

export function importLocalBinanceFundingArchive(input: { root: string; expectedCoverage: FoundryExpectedCoverage; source: string; sourceProvenance: FoundrySourceProvenance; generatedAtMs: number; generationSha: string }): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  const archiveBundle = readArchiveBundle({ root: input.root, include: csv }); const observed = archiveBundle.files.flatMap((file) => { const symbol = file.relativePath.match(/fundingRate\/([A-Z0-9]+)\//)?.[1] ?? ""; return parseCsv(archiveBundle.contents.get(file.relativePath)!, file.relativePath).map((row) => ({ symbol, observedSettlementTimeMs: Number(row.calc_time), fundingIntervalMs: Number(row.funding_interval_hours) * 3_600_000, rate: Number(row.last_funding_rate), sourceHash: file.fileHash })); });
  const fundingSchedules = input.expectedCoverage.fundingSchedules ?? input.expectedCoverage.symbols.map((symbol) => ({ schemaVersion: "v1" as const, symbol, kind: "UTC_8H_BOUNDARIES" as const, source: "binance-usdm-8h-settlement-boundaries", sourceHash: tournamentHash({ symbol, kind: "UTC_8H_BOUNDARIES" }), alignmentToleranceMs: 60_000 }));
  const rows = canonicalizeFundingSettlements({ rows: observed, schedules: fundingSchedules, startMs: input.expectedCoverage.startMs, endMs: input.expectedCoverage.endMs });
  const { contents: _contents, ...archiveIdentity } = archiveBundle;
  const built = buildFoundryArtifact({ artifactKind: "FUNDING_SETTLEMENTS", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, archiveBundle: archiveIdentity, units: { rate: "fraction_per_settlement", interval: "ms" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: { ...input.expectedCoverage, fundingSchedules }, rows });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

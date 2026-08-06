import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { tournamentHash } from "../contract/tournament-contract.js";
import { buildFoundryArtifactManifest, type FoundryArtifactManifest } from "./artifact-schema.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";
import { FOUNDRY_SCHEMA_V1 } from "./semantic-validators.js";

function filesRecursively(root: string): string[] {
  return readdirSync(root).flatMap((name) => { const path = join(root, name); return statSync(path).isDirectory() ? filesRecursively(path) : [path]; }).filter((path) => path.endsWith(".csv")).sort();
}
function parseCsv(path: string): Array<Record<string, string>> {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/); if (lines.length < 2) return [];
  const header = lines[0]!.split(","); return lines.slice(1).filter(Boolean).map((line) => { const cells = line.split(","); if (cells.length !== header.length) throw new Error(`FOUNDRY_ARCHIVE_CSV_COLUMNS_INVALID_${path}`); return Object.fromEntries(header.map((key, index) => [key, cells[index]! ])); });
}

/** Deterministic importer for immutable local Binance Vision-style CSV exports. */
export function importLocalBinanceCandleArchive(input: { root: string; expectedCoverage: FoundryExpectedCoverage; source: string; generatedAtMs: number; generationSha: string }): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  const rows = filesRecursively(input.root).flatMap((path) => { const sourceHash = tournamentHash(readFileSync(path, "utf8")); return parseCsv(path).map((row) => ({ symbol: path.match(/\/([A-Z0-9]+)\/1h\//)?.[1] ?? "", openTimeMs: Number(row.open_time), closeTimeMs: Number(row.close_time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), sourceHash })); }).sort((a, b) => a.openTimeMs - b.openTimeMs || a.symbol.localeCompare(b.symbol));
  return { rows, manifest: buildFoundryArtifactManifest({ artifactKind: "COMPLETED_CANDLES", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, units: { price: "USDT", volume: "base_asset" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows }) };
}

export function importLocalBinanceFundingArchive(input: { root: string; expectedCoverage: FoundryExpectedCoverage; source: string; generatedAtMs: number; generationSha: string }): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  const rows = filesRecursively(input.root).flatMap((path) => { const sourceHash = tournamentHash(readFileSync(path, "utf8")); const symbol = path.match(/fundingRate\/([A-Z0-9]+)\//)?.[1] ?? ""; return parseCsv(path).map((row) => ({ symbol, settlementTimeMs: Number(row.calc_time), fundingIntervalMs: Number(row.funding_interval_hours) * 3_600_000, rate: Number(row.last_funding_rate), sourceHash })); }).sort((a, b) => a.settlementTimeMs - b.settlementTimeMs || a.symbol.localeCompare(b.symbol));
  return { rows, manifest: buildFoundryArtifactManifest({ artifactKind: "FUNDING_SETTLEMENTS", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, units: { rate: "fraction_per_settlement", interval: "ms" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows }) };
}

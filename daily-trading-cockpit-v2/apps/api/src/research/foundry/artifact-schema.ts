import { tournamentHash } from "../contract/tournament-contract.js";
import { assertExpectedCoverage, deriveFoundryCoverage, type DerivedFoundryCoverage, type FoundryExpectedCoverage } from "./derived-coverage.js";
import { FOUNDRY_SCHEMA_V1, validateFoundryRows, type ValidatedFoundryRow } from "./semantic-validators.js";
import { assertFoundrySourceProvenance, type FoundrySourceProvenance } from "./source-provenance.js";

export const DATASET_FOUNDRY_VERSION = "kronos-dataset-foundry-v1" as const;
export type FoundryArtifactKind =
  | "COMPLETED_CANDLES" | "FUNDING_SETTLEMENTS" | "LISTING_DELISTING_TIMELINE"
  | "FUTURES_AVAILABILITY_TIMELINE" | "MINIMUM_HISTORY_ELIGIBILITY" | "PIT_LIQUIDITY_SPREAD"
  | "FEE_ASSUMPTIONS" | "PORTFOLIO_RISK_SNAPSHOTS" | "CANONICAL_EPISODES"
  | "KRONOS_DECISION_LEDGER";

export interface FoundryArtifactManifest {
  foundryVersion: typeof DATASET_FOUNDRY_VERSION;
  artifactKind: FoundryArtifactKind;
  schemaVersion: typeof FOUNDRY_SCHEMA_V1;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  units: Record<string, string>;
  generatedAtMs: number;
  generationSha: string;
  expectedCoverage: FoundryExpectedCoverage;
  derivedCoverage: DerivedFoundryCoverage;
  timeRange: { startMs: number; endMs: number };
  rowCount: number;
  rowsHash: string;
  semanticManifestHash: string;
  missingDataReport: string[];
}

export interface BuiltFoundryArtifact { manifest: FoundryArtifactManifest; canonicalRows: ValidatedFoundryRow[]; }

export interface FoundryArtifactBuildInput {
  artifactKind: FoundryArtifactKind;
  schemaVersion: typeof FOUNDRY_SCHEMA_V1;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  units: Record<string, string>;
  generatedAtMs: number;
  generationSha: string;
  expectedCoverage: FoundryExpectedCoverage;
  rows: readonly unknown[];
}

export function buildFoundryArtifact(input: FoundryArtifactBuildInput): BuiltFoundryArtifact {
  if (!input.source || !input.generationSha || !Number.isInteger(input.generatedAtMs) || input.generatedAtMs < 0 || Object.keys(input.units).length === 0) throw new Error("FOUNDRY_ARTIFACT_PROVENANCE_INVALID");
  assertFoundrySourceProvenance(input.sourceProvenance);
  const normalizedRows = validateFoundryRows(input.artifactKind, input.schemaVersion, input.rows).sort((a, b) => (a.timestampMs - b.timestampMs) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));
  if (input.artifactKind === "COMPLETED_CANDLES" && input.expectedCoverage.cadenceMs && normalizedRows.some((row) => { const candle = row as ValidatedFoundryRow & { openTimeMs: number; closeTimeMs: number }; return candle.closeTimeMs !== candle.openTimeMs + input.expectedCoverage.cadenceMs! - 1; })) throw new Error("FOUNDRY_CANDLE_DURATION_INVALID");
  const derivedCoverage = deriveFoundryCoverage(input.artifactKind, normalizedRows, input.expectedCoverage);
  const rowsHash = tournamentHash(normalizedRows);
  const missingDataReport = [
    ...derivedCoverage.missingSymbols.map((symbol) => `SYMBOL:${symbol}`),
    ...derivedCoverage.missingIntervals.map((interval) => `INTERVAL:${interval.startMs}-${interval.endMs}:${interval.reason}`),
  ];
  const identity = { foundryVersion: DATASET_FOUNDRY_VERSION, artifactKind: input.artifactKind, schemaVersion: input.schemaVersion, source: input.source, sourceProvenance: input.sourceProvenance, units: input.units, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, derivedCoverage, timeRange: { startMs: input.expectedCoverage.startMs, endMs: input.expectedCoverage.endMs }, rowCount: normalizedRows.length, rowsHash, missingDataReport };
  return { manifest: { ...identity, semanticManifestHash: tournamentHash(identity) }, canonicalRows: normalizedRows };
}

/** Compatibility accessor. New Foundry creation should persist `buildFoundryArtifact().canonicalRows`. */
export function buildFoundryArtifactManifest(input: FoundryArtifactBuildInput): FoundryArtifactManifest { return buildFoundryArtifact(input).manifest; }

export function assertFoundryArtifactIdentity(manifest: FoundryArtifactManifest, canonicalRows: readonly unknown[]): void {
  const rows = validateFoundryRows(manifest.artifactKind, manifest.schemaVersion, canonicalRows).sort((a, b) => (a.timestampMs - b.timestampMs) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));
  if (JSON.stringify(rows) !== JSON.stringify(canonicalRows) || tournamentHash(rows) !== manifest.rowsHash || rows.length !== manifest.rowCount) throw new Error("FOUNDRY_ARTIFACT_ROWS_HASH_MISMATCH");
  const expectedMissingDataReport = [...manifest.derivedCoverage.missingSymbols.map((symbol) => `SYMBOL:${symbol}`), ...manifest.derivedCoverage.missingIntervals.map((interval) => `INTERVAL:${interval.startMs}-${interval.endMs}:${interval.reason}`)];
  if (JSON.stringify(manifest.missingDataReport) !== JSON.stringify(expectedMissingDataReport)) throw new Error("FOUNDRY_ARTIFACT_MANIFEST_DATA_REPORT_MISMATCH");
  assertFoundrySourceProvenance(manifest.sourceProvenance);
  const identity = { foundryVersion: manifest.foundryVersion, artifactKind: manifest.artifactKind, schemaVersion: manifest.schemaVersion, source: manifest.source, sourceProvenance: manifest.sourceProvenance, units: manifest.units, generatedAtMs: manifest.generatedAtMs, generationSha: manifest.generationSha, expectedCoverage: manifest.expectedCoverage, derivedCoverage: manifest.derivedCoverage, timeRange: manifest.timeRange, rowCount: manifest.rowCount, rowsHash: manifest.rowsHash, missingDataReport: manifest.missingDataReport };
  if (manifest.foundryVersion !== DATASET_FOUNDRY_VERSION || manifest.semanticManifestHash !== tournamentHash(identity)) throw new Error("FOUNDRY_ARTIFACT_SEMANTIC_IDENTITY_MISMATCH");
}

export function assertCompleteFoundryArtifact(manifest: FoundryArtifactManifest): void {
  if (manifest.foundryVersion !== DATASET_FOUNDRY_VERSION || manifest.schemaVersion !== FOUNDRY_SCHEMA_V1 || !manifest.source || !manifest.generationSha || !manifest.rowsHash || !manifest.semanticManifestHash || manifest.rowCount <= 0) throw new Error("FOUNDRY_ARTIFACT_PROVENANCE_INVALID");
  assertFoundrySourceProvenance(manifest.sourceProvenance);
  assertExpectedCoverage(manifest.derivedCoverage);
  if (manifest.missingDataReport.length) throw new Error(`FOUNDRY_ARTIFACT_COVERAGE_INCOMPLETE_${manifest.artifactKind}`);
}

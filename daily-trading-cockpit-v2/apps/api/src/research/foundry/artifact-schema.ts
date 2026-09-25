import { tournamentHash } from "../contract/tournament-contract.js";
import { assertExpectedCoverage, deriveFoundryCoverage, type DerivedFoundryCoverage, type FoundryExpectedCoverage } from "./derived-coverage.js";
import { FOUNDRY_SCHEMA_V1, FOUNDRY_SCHEMA_V2, validateFoundryRows, type FoundrySchemaVersion, type ValidatedFoundryRow } from "./semantic-validators.js";
import { assertArchiveBundleIdentity, type ArchiveBundleIdentity } from "./archive-bundle.js";
import { assertFoundryDerivationIdentity, assertFoundrySourceProvenance, type FoundryDerivationIdentity, type FoundrySourceProvenance } from "./source-provenance.js";

export const DATASET_FOUNDRY_VERSION = "kronos-dataset-foundry-v1" as const;
export type FoundryArtifactKind =
  | "COMPLETED_CANDLES" | "FUNDING_SETTLEMENTS" | "LISTING_DELISTING_TIMELINE"
  | "FUTURES_AVAILABILITY_TIMELINE" | "MINIMUM_HISTORY_ELIGIBILITY" | "PIT_LIQUIDITY_SPREAD"
  | "FEE_ASSUMPTIONS" | "PORTFOLIO_RISK_SNAPSHOTS" | "CANONICAL_EPISODES"
  | "KRONOS_DECISION_LEDGER";

export interface CanonicalEpisodeCoverageEvidence {
  mode: "COMPLETE_SYMBOL_DECISION_MAP";
  canonicalAlgorithm: "PERSISTED_MARKET_CAUSE" | "KRONOS_EPISODE_ACCUMULATOR_V1";
  algorithmVersion: string;
  policyVersion: string;
  blockWidthMs: number;
  decisionKeyCount: number;
  decisionKeysHash: string;
  sourceHashes: string[];
}

export interface FoundryArtifactManifest {
  foundryVersion: typeof DATASET_FOUNDRY_VERSION;
  artifactKind: FoundryArtifactKind;
  schemaVersion: FoundrySchemaVersion;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  archiveBundle?: ArchiveBundleIdentity;
  derivation?: FoundryDerivationIdentity;
  canonicalEpisodeCoverage?: CanonicalEpisodeCoverageEvidence;
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
  schemaVersion: FoundrySchemaVersion;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  archiveBundle?: ArchiveBundleIdentity;
  derivation?: FoundryDerivationIdentity;
  canonicalEpisodeCoverage?: CanonicalEpisodeCoverageEvidence;
  units: Record<string, string>;
  generatedAtMs: number;
  generationSha: string;
  expectedCoverage: FoundryExpectedCoverage;
  rows: readonly unknown[];
}

export function buildFoundryArtifact(input: FoundryArtifactBuildInput): BuiltFoundryArtifact {
  if (!input.source || !input.generationSha || !Number.isInteger(input.generatedAtMs) || input.generatedAtMs < 0 || Object.keys(input.units).length === 0) throw new Error("FOUNDRY_ARTIFACT_PROVENANCE_INVALID");
  assertFoundrySourceProvenance(input.sourceProvenance);
  if (input.archiveBundle) { assertArchiveBundleIdentity(input.archiveBundle); if (input.sourceProvenance.rawFileHash !== input.archiveBundle.archiveBundleHash) throw new Error("FOUNDRY_ARCHIVE_BUNDLE_CALLER_HASH_MISMATCH"); }
  if (input.sourceProvenance.provenanceType === "DERIVED_FROM_FOUNDRY_ARTIFACTS") assertFoundryDerivationIdentity(input.derivation);
  if (input.derivation && input.sourceProvenance.provenanceType !== "DERIVED_FROM_FOUNDRY_ARTIFACTS") throw new Error("FOUNDRY_DERIVATION_PROVENANCE_MISMATCH");
  if (input.canonicalEpisodeCoverage && (input.artifactKind !== "CANONICAL_EPISODES" || input.canonicalEpisodeCoverage.mode !== "COMPLETE_SYMBOL_DECISION_MAP" || !input.canonicalEpisodeCoverage.algorithmVersion || !input.canonicalEpisodeCoverage.policyVersion || !Number.isInteger(input.canonicalEpisodeCoverage.blockWidthMs) || input.canonicalEpisodeCoverage.blockWidthMs <= 0 || !Number.isInteger(input.canonicalEpisodeCoverage.decisionKeyCount) || input.canonicalEpisodeCoverage.decisionKeyCount <= 0 || !input.canonicalEpisodeCoverage.decisionKeysHash || input.canonicalEpisodeCoverage.sourceHashes.length === 0)) throw new Error("FOUNDRY_CANONICAL_EPISODE_COVERAGE_INVALID");
  const normalizedRows = validateFoundryRows(input.artifactKind, input.schemaVersion, input.rows).sort((a, b) => (a.timestampMs - b.timestampMs) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));
  if (input.artifactKind === "COMPLETED_CANDLES" && input.expectedCoverage.cadenceMs && normalizedRows.some((row) => { const candle = row as ValidatedFoundryRow & { openTimeMs: number; closeTimeMs: number }; return candle.closeTimeMs !== candle.openTimeMs + input.expectedCoverage.cadenceMs! - 1; })) throw new Error("FOUNDRY_CANDLE_DURATION_INVALID");
  const derivedCoverage = deriveFoundryCoverage(input.artifactKind, normalizedRows, input.expectedCoverage, input.schemaVersion);
  const rowsHash = tournamentHash(normalizedRows);
  const missingDataReport = [
    ...derivedCoverage.missingSymbols.map((symbol) => `SYMBOL:${symbol}`),
    ...derivedCoverage.missingIntervals.map((interval) => `INTERVAL:${interval.startMs}-${interval.endMs}:${interval.reason}`),
  ];
  const identity = { foundryVersion: DATASET_FOUNDRY_VERSION, artifactKind: input.artifactKind, schemaVersion: input.schemaVersion, source: input.source, sourceProvenance: input.sourceProvenance, ...(input.archiveBundle ? { archiveBundle: input.archiveBundle } : {}), ...(input.derivation ? { derivation: input.derivation } : {}), ...(input.canonicalEpisodeCoverage ? { canonicalEpisodeCoverage: input.canonicalEpisodeCoverage } : {}), units: input.units, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, derivedCoverage, timeRange: { startMs: input.expectedCoverage.startMs, endMs: input.expectedCoverage.endMs }, rowCount: normalizedRows.length, rowsHash, missingDataReport };
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
  if (manifest.archiveBundle) { assertArchiveBundleIdentity(manifest.archiveBundle); if (manifest.sourceProvenance.rawFileHash !== manifest.archiveBundle.archiveBundleHash) throw new Error("FOUNDRY_ARCHIVE_BUNDLE_CALLER_HASH_MISMATCH"); }
  if (manifest.sourceProvenance.provenanceType === "DERIVED_FROM_FOUNDRY_ARTIFACTS") assertFoundryDerivationIdentity(manifest.derivation);
  if (manifest.derivation && manifest.sourceProvenance.provenanceType !== "DERIVED_FROM_FOUNDRY_ARTIFACTS") throw new Error("FOUNDRY_DERIVATION_PROVENANCE_MISMATCH");
  const identity = { foundryVersion: manifest.foundryVersion, artifactKind: manifest.artifactKind, schemaVersion: manifest.schemaVersion, source: manifest.source, sourceProvenance: manifest.sourceProvenance, ...(manifest.archiveBundle ? { archiveBundle: manifest.archiveBundle } : {}), ...(manifest.derivation ? { derivation: manifest.derivation } : {}), ...(manifest.canonicalEpisodeCoverage ? { canonicalEpisodeCoverage: manifest.canonicalEpisodeCoverage } : {}), units: manifest.units, generatedAtMs: manifest.generatedAtMs, generationSha: manifest.generationSha, expectedCoverage: manifest.expectedCoverage, derivedCoverage: manifest.derivedCoverage, timeRange: manifest.timeRange, rowCount: manifest.rowCount, rowsHash: manifest.rowsHash, missingDataReport: manifest.missingDataReport };
  if (manifest.foundryVersion !== DATASET_FOUNDRY_VERSION || manifest.semanticManifestHash !== tournamentHash(identity)) throw new Error("FOUNDRY_ARTIFACT_SEMANTIC_IDENTITY_MISMATCH");
}

export function assertCompleteFoundryArtifact(manifest: FoundryArtifactManifest): void {
  if (manifest.foundryVersion !== DATASET_FOUNDRY_VERSION || (manifest.schemaVersion !== FOUNDRY_SCHEMA_V1 && manifest.schemaVersion !== FOUNDRY_SCHEMA_V2) || !manifest.source || !manifest.generationSha || !manifest.rowsHash || !manifest.semanticManifestHash || manifest.rowCount <= 0) throw new Error("FOUNDRY_ARTIFACT_PROVENANCE_INVALID");
  assertFoundrySourceProvenance(manifest.sourceProvenance);
  if (manifest.sourceProvenance.provenanceType === "DERIVED_FROM_FOUNDRY_ARTIFACTS") assertFoundryDerivationIdentity(manifest.derivation);
  assertExpectedCoverage(manifest.derivedCoverage);
  if (manifest.missingDataReport.length) throw new Error(`FOUNDRY_ARTIFACT_COVERAGE_INCOMPLETE_${manifest.artifactKind}`);
}

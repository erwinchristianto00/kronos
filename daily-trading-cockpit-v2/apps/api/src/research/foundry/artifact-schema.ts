import { tournamentHash } from "../contract/tournament-contract.js";
import { assertExpectedCoverage, deriveFoundryCoverage, type DerivedFoundryCoverage, type FoundryExpectedCoverage } from "./derived-coverage.js";
import { FOUNDRY_SCHEMA_V1, validateFoundryRows } from "./semantic-validators.js";

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

export function buildFoundryArtifactManifest(input: {
  artifactKind: FoundryArtifactKind;
  schemaVersion: typeof FOUNDRY_SCHEMA_V1;
  source: string;
  units: Record<string, string>;
  generatedAtMs: number;
  generationSha: string;
  expectedCoverage: FoundryExpectedCoverage;
  rows: readonly unknown[];
}): FoundryArtifactManifest {
  if (!input.source || !input.generationSha || !Number.isInteger(input.generatedAtMs) || input.generatedAtMs < 0 || Object.keys(input.units).length === 0) throw new Error("FOUNDRY_ARTIFACT_PROVENANCE_INVALID");
  const normalizedRows = validateFoundryRows(input.artifactKind, input.schemaVersion, input.rows).sort((a, b) => (a.timestampMs - b.timestampMs) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));
  const derivedCoverage = deriveFoundryCoverage(input.artifactKind, normalizedRows, input.expectedCoverage);
  const rowsHash = tournamentHash(normalizedRows);
  const missingDataReport = [
    ...derivedCoverage.missingSymbols.map((symbol) => `SYMBOL:${symbol}`),
    ...derivedCoverage.missingIntervals.map((interval) => `INTERVAL:${interval.startMs}-${interval.endMs}:${interval.reason}`),
  ];
  const identity = { foundryVersion: DATASET_FOUNDRY_VERSION, artifactKind: input.artifactKind, schemaVersion: input.schemaVersion, source: input.source, units: input.units, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, derivedCoverage, timeRange: { startMs: input.expectedCoverage.startMs, endMs: input.expectedCoverage.endMs }, rowCount: normalizedRows.length, rowsHash };
  return { ...identity, semanticManifestHash: tournamentHash(identity), missingDataReport };
}

export function assertCompleteFoundryArtifact(manifest: FoundryArtifactManifest): void {
  if (manifest.foundryVersion !== DATASET_FOUNDRY_VERSION || manifest.schemaVersion !== FOUNDRY_SCHEMA_V1 || !manifest.source || !manifest.generationSha || !manifest.rowsHash || !manifest.semanticManifestHash || manifest.rowCount <= 0) throw new Error("FOUNDRY_ARTIFACT_PROVENANCE_INVALID");
  assertExpectedCoverage(manifest.derivedCoverage);
  if (manifest.missingDataReport.length) throw new Error(`FOUNDRY_ARTIFACT_COVERAGE_INCOMPLETE_${manifest.artifactKind}`);
}

import { tournamentHash } from "../contract/tournament-contract.js";

export const DATASET_FOUNDRY_VERSION = "kronos-dataset-foundry-v1" as const;

export type FoundryArtifactKind =
  | "COMPLETED_CANDLES" | "FUNDING_SETTLEMENTS" | "LISTING_DELISTING_TIMELINE"
  | "FUTURES_AVAILABILITY_TIMELINE" | "MINIMUM_HISTORY_ELIGIBILITY" | "PIT_LIQUIDITY_SPREAD"
  | "FEE_ASSUMPTIONS" | "PORTFOLIO_RISK_SNAPSHOTS" | "CANONICAL_EPISODES"
  | "KRONOS_DECISION_LEDGER";

export interface FoundryCoverage {
  expectedStartMs: number;
  expectedEndMs: number;
  coveredStartMs: number | null;
  coveredEndMs: number | null;
  coveredSymbols: string[];
  missingIntervals: Array<{ startMs: number; endMs: number; reason: string }>;
  missingSymbols: string[];
}

export interface FoundryArtifactManifest {
  foundryVersion: typeof DATASET_FOUNDRY_VERSION;
  artifactKind: FoundryArtifactKind;
  schemaVersion: string;
  source: string;
  generatedAtMs: number;
  generationSha: string;
  timeRange: { startMs: number; endMs: number };
  rowCount: number;
  contentHash: string;
  coverage: FoundryCoverage;
  missingDataReport: string[];
}

export function buildFoundryArtifactManifest(input: Omit<FoundryArtifactManifest, "foundryVersion" | "contentHash" | "rowCount"> & { rows: readonly unknown[] }): FoundryArtifactManifest {
  const contentHash = tournamentHash(input.rows);
  return {
    foundryVersion: DATASET_FOUNDRY_VERSION,
    artifactKind: input.artifactKind,
    schemaVersion: input.schemaVersion,
    source: input.source,
    generatedAtMs: input.generatedAtMs,
    generationSha: input.generationSha,
    timeRange: { ...input.timeRange },
    rowCount: input.rows.length,
    contentHash,
    coverage: { ...input.coverage, coveredSymbols: [...input.coverage.coveredSymbols].sort(), missingIntervals: input.coverage.missingIntervals.map((interval) => ({ ...interval })), missingSymbols: [...input.coverage.missingSymbols].sort() },
    missingDataReport: [...input.missingDataReport],
  };
}

export function assertCompleteFoundryArtifact(manifest: FoundryArtifactManifest): void {
  if (manifest.foundryVersion !== DATASET_FOUNDRY_VERSION || !manifest.schemaVersion || !manifest.source || !manifest.generationSha || !manifest.contentHash || manifest.rowCount < 0) throw new Error("FOUNDRY_ARTIFACT_PROVENANCE_INVALID");
  if (manifest.timeRange.startMs >= manifest.timeRange.endMs) throw new Error("FOUNDRY_ARTIFACT_RANGE_INVALID");
  if (manifest.coverage.missingIntervals.length > 0 || manifest.coverage.missingSymbols.length > 0 || manifest.missingDataReport.length > 0) throw new Error(`FOUNDRY_ARTIFACT_COVERAGE_INCOMPLETE_${manifest.artifactKind}`);
}

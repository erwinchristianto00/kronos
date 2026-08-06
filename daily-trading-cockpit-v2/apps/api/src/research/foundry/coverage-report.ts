import type { FoundryArtifactManifest } from "./artifact-schema.js";

export interface FoundryCoverageReport {
  complete: boolean;
  artifactCount: number;
  artifacts: Array<{ kind: string; contentHash: string; coveredSymbols: string[]; missing: string[] }>;
}

/** Machine-readable coverage report; never converts a gap into an assumption. */
export function buildFoundryCoverageReport(manifests: readonly FoundryArtifactManifest[]): FoundryCoverageReport {
  const artifacts = manifests.map((manifest) => ({
    kind: manifest.artifactKind,
    contentHash: manifest.contentHash,
    coveredSymbols: [...manifest.coverage.coveredSymbols].sort(),
    missing: [...manifest.missingDataReport, ...manifest.coverage.missingIntervals.map((interval) => `INTERVAL:${interval.startMs}-${interval.endMs}:${interval.reason}`), ...manifest.coverage.missingSymbols.map((symbol) => `SYMBOL:${symbol}`)],
  })).sort((a, b) => a.kind.localeCompare(b.kind));
  return { complete: artifacts.every((artifact) => artifact.missing.length === 0), artifactCount: artifacts.length, artifacts };
}

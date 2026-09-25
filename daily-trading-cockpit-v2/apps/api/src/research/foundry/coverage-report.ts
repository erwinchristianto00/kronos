import type { FoundryArtifactManifest } from "./artifact-schema.js";

export interface FoundryCoverageReport {
  complete: boolean;
  artifactCount: number;
  artifacts: Array<{ kind: string; semanticManifestHash: string; rowsHash: string; coveredSymbols: string[]; missing: string[] }>;
}

/** Machine-readable coverage report; never converts a gap into an assumption. */
export function buildFoundryCoverageReport(manifests: readonly FoundryArtifactManifest[]): FoundryCoverageReport {
  const artifacts = manifests.map((manifest) => ({
    kind: manifest.artifactKind,
    semanticManifestHash: manifest.semanticManifestHash,
    rowsHash: manifest.rowsHash,
    coveredSymbols: [...manifest.derivedCoverage.coveredSymbols].sort(),
    missing: [...manifest.missingDataReport],
  })).sort((a, b) => a.kind.localeCompare(b.kind));
  return { complete: artifacts.every((artifact) => artifact.missing.length === 0), artifactCount: artifacts.length, artifacts };
}

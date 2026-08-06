import { basename, dirname } from "node:path";

import { buildFoundryArtifact, type FoundryArtifactKind, type FoundryArtifactManifest } from "./artifact-schema.js";
import { FOUNDRY_SCHEMA_V1 } from "./semantic-validators.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";
import type { FoundrySourceProvenance } from "./source-provenance.js";
import { readArchiveBundle } from "./archive-bundle.js";

/**
 * Import only explicit export files. This adapter neither fetches current
 * exchange state nor fills historical gaps; malformed/non-array JSON fails.
 */
export function importFoundryJsonArtifact(input: {
  path: string;
  artifactKind: FoundryArtifactKind;
  schemaVersion: typeof FOUNDRY_SCHEMA_V1;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  units: Record<string, string>;
  generatedAtMs: number;
  generationSha: string;
  expectedCoverage: FoundryExpectedCoverage;
}): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  const name = basename(input.path); const archiveBundle = readArchiveBundle({ root: dirname(input.path), include: (relativePath) => relativePath === name });
  const parsed: unknown = JSON.parse(archiveBundle.contents.get(name)!.toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("FOUNDRY_IMPORT_ROWS_MUST_BE_ARRAY");
  const { path: _path, ...metadata } = input;
  const { contents: _contents, ...archiveIdentity } = archiveBundle;
  const built = buildFoundryArtifact({ ...metadata, archiveBundle: archiveIdentity, rows: parsed });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

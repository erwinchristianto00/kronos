import { readFileSync } from "node:fs";

import { buildFoundryArtifactManifest, type FoundryArtifactKind, type FoundryArtifactManifest } from "./artifact-schema.js";
import { FOUNDRY_SCHEMA_V1 } from "./semantic-validators.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";

/**
 * Import only explicit export files. This adapter neither fetches current
 * exchange state nor fills historical gaps; malformed/non-array JSON fails.
 */
export function importFoundryJsonArtifact(input: {
  path: string;
  artifactKind: FoundryArtifactKind;
  schemaVersion: typeof FOUNDRY_SCHEMA_V1;
  source: string;
  units: Record<string, string>;
  generatedAtMs: number;
  generationSha: string;
  expectedCoverage: FoundryExpectedCoverage;
}): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  const parsed: unknown = JSON.parse(readFileSync(input.path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("FOUNDRY_IMPORT_ROWS_MUST_BE_ARRAY");
  const { path: _path, ...metadata } = input;
  const manifest = buildFoundryArtifactManifest({ ...metadata, rows: parsed });
  return { rows: parsed, manifest };
}

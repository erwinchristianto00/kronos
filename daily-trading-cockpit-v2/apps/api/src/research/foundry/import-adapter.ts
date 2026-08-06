import { readFileSync } from "node:fs";

import { buildFoundryArtifactManifest, type FoundryArtifactKind, type FoundryArtifactManifest, type FoundryCoverage } from "./artifact-schema.js";

/**
 * Import only explicit export files. This adapter neither fetches current
 * exchange state nor fills historical gaps; malformed/non-array JSON fails.
 */
export function importFoundryJsonArtifact(input: {
  path: string;
  artifactKind: FoundryArtifactKind;
  schemaVersion: string;
  source: string;
  generatedAtMs: number;
  generationSha: string;
  timeRange: { startMs: number; endMs: number };
  coverage: FoundryCoverage;
}): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  const parsed: unknown = JSON.parse(readFileSync(input.path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("FOUNDRY_IMPORT_ROWS_MUST_BE_ARRAY");
  const manifest = buildFoundryArtifactManifest({ ...input, rows: parsed, missingDataReport: [
    ...input.coverage.missingIntervals.map((interval) => `INTERVAL:${interval.startMs}-${interval.endMs}:${interval.reason}`),
    ...input.coverage.missingSymbols.map((symbol) => `SYMBOL:${symbol}`),
  ] });
  return { rows: parsed, manifest };
}

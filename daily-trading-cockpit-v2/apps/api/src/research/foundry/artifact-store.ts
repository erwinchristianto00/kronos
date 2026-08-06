import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FoundryArtifactManifest } from "./artifact-schema.js";

function atomicJson(path: string, value: unknown): void { const temp = `${path}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); renameSync(temp, path); }

/** Immutable Foundry persistence keyed by semantic identity; conflicting rewrites are rejected. */
export function persistFoundryArtifact(input: { rootDir: string; manifest: FoundryArtifactManifest; rows: readonly unknown[] }): string {
  const directory = resolve(input.rootDir, input.manifest.semanticManifestHash); mkdirSync(directory, { recursive: true }); const manifestPath = resolve(directory, "manifest.json");
  if (existsSync(manifestPath) && readFileSync(manifestPath, "utf8") !== `${JSON.stringify(input.manifest, null, 2)}\n`) throw new Error("FOUNDRY_ARTIFACT_SEMANTIC_ID_CONFLICT");
  if (!existsSync(manifestPath)) { atomicJson(manifestPath, input.manifest); atomicJson(resolve(directory, "rows.json"), input.rows); }
  return directory;
}

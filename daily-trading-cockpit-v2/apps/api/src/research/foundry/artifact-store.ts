import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertFoundryArtifactIdentity, type FoundryArtifactManifest } from "./artifact-schema.js";

function atomicJson(path: string, value: unknown): void { const temp = `${path}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); renameSync(temp, path); }

/** Immutable Foundry persistence keyed by semantic identity; conflicting rewrites are rejected. */
export function persistFoundryArtifact(input: { rootDir: string; manifest: FoundryArtifactManifest; rows: readonly unknown[] }): string {
  assertFoundryArtifactIdentity(input.manifest, input.rows);
  const directory = resolve(input.rootDir, input.manifest.semanticManifestHash); mkdirSync(directory, { recursive: true }); const manifestPath = resolve(directory, "manifest.json"); const rowsPath = resolve(directory, "rows.json");
  if (existsSync(manifestPath) !== existsSync(rowsPath)) throw new Error("FOUNDRY_ARTIFACT_PARTIAL_WRITE");
  if (existsSync(manifestPath)) {
    if (readFileSync(manifestPath, "utf8") !== `${JSON.stringify(input.manifest, null, 2)}\n`) throw new Error("FOUNDRY_ARTIFACT_SEMANTIC_ID_CONFLICT");
    assertFoundryArtifactIdentity(input.manifest, JSON.parse(readFileSync(rowsPath, "utf8")) as unknown[]);
  } else { atomicJson(rowsPath, input.rows); atomicJson(manifestPath, input.manifest); }
  return directory;
}

/** Load only a complete immutable artifact and verify its rows and semantic identity. */
export function loadFoundryArtifact(input: { rootDir: string; semanticManifestHash: string }): { directory: string; manifest: FoundryArtifactManifest; rows: unknown[] } {
  const directory = resolve(input.rootDir, input.semanticManifestHash); const manifestPath = resolve(directory, "manifest.json"); const rowsPath = resolve(directory, "rows.json");
  if (!existsSync(manifestPath) || !existsSync(rowsPath)) throw new Error("FOUNDRY_ARTIFACT_PARTIAL_WRITE");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FoundryArtifactManifest; const rows = JSON.parse(readFileSync(rowsPath, "utf8")) as unknown[];
  if (manifest.semanticManifestHash !== input.semanticManifestHash) throw new Error("FOUNDRY_ARTIFACT_DIRECTORY_ID_MISMATCH");
  assertFoundryArtifactIdentity(manifest, rows);
  return { directory, manifest, rows };
}

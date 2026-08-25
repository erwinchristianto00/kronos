/**
 * One explicit, idempotent migration into the canonical continuation root.
 *
 * It never modifies the old xsec-sim store or a trading release. Existing target files must have
 * identical hashes; a disagreement aborts rather than silently replacing historical evidence.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-continuation-lifecycle.ts --approve \
 *     --root=/root/kronos-continuation \
 *     --artifact=/path/to/direction-model-v4.json \
 *     --legacy-root=/root/xsec-sim
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DYNAMIC_MOM36_CONTINUATION_ARTIFACT_SHA256 } from "../src/lib/dynamic-mom36-continuation-runtime.js";
import { validateTrajectoryArtifact, type DirectionTrajectoryArtifact } from "../src/lib/direction-model-runtime.js";
import { bootstrapChampion } from "../src/lib/continuation-champion-registry.js";
import {
  CONTINUATION_FEATURE_SCHEMA_VERSION,
  CONTINUATION_LABEL_VERSION,
  continuationLifecyclePaths,
  continuationNowIso,
  ensureContinuationLifecycleDirectories,
  sha256Bytes,
  stableJson,
  writeJsonAtomic,
} from "../src/lib/continuation-lifecycle.js";

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function required(name: string): string {
  const value = option(name);
  if (!value?.trim()) throw new Error(`--${name}=... is required`);
  return resolve(value);
}

type CopiedFile = { relativePath: string; bytes: number; sha256: string; action: "COPIED" | "VERIFIED_EXISTING" };

function copyImmutableTree(source: string, destination: string, destinationRoot: string, copied: CopiedFile[]): void {
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const input = resolve(source, entry.name);
    const output = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      copyImmutableTree(input, output, destinationRoot, copied);
      continue;
    }
    if (!entry.isFile()) continue;
    const sourceBytes = readFileSync(input);
    const sourceSha = sha256Bytes(sourceBytes);
    if (existsSync(output)) {
      const targetSha = sha256Bytes(readFileSync(output));
      if (targetSha !== sourceSha) throw new Error(`immutable migration collision: ${output}`);
      copied.push({ relativePath: relative(destinationRoot, output), bytes: sourceBytes.length, sha256: sourceSha, action: "VERIFIED_EXISTING" });
      continue;
    }
    mkdirSync(dirname(output), { recursive: true, mode: 0o750 });
    copyFileSync(input, output);
    copied.push({ relativePath: relative(destinationRoot, output), bytes: sourceBytes.length, sha256: sourceSha, action: "COPIED" });
  }
}

if (!process.argv.slice(2).includes("--approve")) {
  throw new Error("refusing lifecycle bootstrap without --approve");
}

const root = required("root");
const artifactPath = required("artifact");
const legacyRoot = option("legacy-root");
const paths = ensureContinuationLifecycleDirectories(continuationLifecyclePaths(root));
const artifactBytes = readFileSync(artifactPath);
const artifactSha = sha256Bytes(artifactBytes);
if (artifactSha !== DYNAMIC_MOM36_CONTINUATION_ARTIFACT_SHA256) {
  throw new Error(`bootstrap artifact SHA mismatch: expected ${DYNAMIC_MOM36_CONTINUATION_ARTIFACT_SHA256}, got ${artifactSha}`);
}
const rawArtifact = JSON.parse(artifactBytes.toString("utf8")) as unknown;
validateTrajectoryArtifact(rawArtifact);
const artifact = rawArtifact as DirectionTrajectoryArtifact;

const copied: CopiedFile[] = [];
if (legacyRoot) {
  const legacy = resolve(legacyRoot);
  // V4-compatible materialized views used by the frozen feature engine.
  copyImmutableTree(resolve(legacy, "ohlcv"), resolve(paths.materialized, "ohlcv"), paths.root, copied);
  copyImmutableTree(resolve(legacy, "funding-full"), resolve(paths.materialized, "funding"), paths.root, copied);
  for (const source of ["bybit", "okx", "coinbase", "options"]) {
    copyImmutableTree(resolve(legacy, "raw", source), resolve(paths.materialized, "raw", source), paths.root, copied);
  }
  // The old raw JSONL has a different schema. Preserve it for audit under an explicit legacy
  // namespace; do not mislabel it as the new canonical raw-event envelope.
  copyImmutableTree(resolve(legacy, "raw"), resolve(paths.root, "legacy-raw", "xsec-sim"), paths.root, copied);
}

copied.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
const migration = {
  schemaVersion: 1,
  importedAt: continuationNowIso(),
  legacyRoot: legacyRoot ? resolve(legacyRoot) : null,
  artifactPath,
  artifactSha256: artifactSha,
  files: copied,
};
const migrationHash = sha256Bytes(stableJson(migration));
const migrationDir = resolve(paths.snapshots, "legacy-imports");
mkdirSync(migrationDir, { recursive: true, mode: 0o750 });
writeJsonAtomic(resolve(migrationDir, `bootstrap-${migrationHash}.json`), { ...migration, migrationHash });

const pointer = bootstrapChampion({
  file: artifactPath,
  featureSchemaVersion: CONTINUATION_FEATURE_SCHEMA_VERSION,
  labelVersion: CONTINUATION_LABEL_VERSION,
  // The frozen artifact's final training row is the only defensible bootstrap cutoff. It prevents
  // the scheduler from claiming old rows were newly collected after migration.
  trainingCutoffMs: artifact.trainSpan.toMs,
  labelCutoffMs: artifact.trainSpan.toMs,
  dataManifestHash: migrationHash,
  runId: null,
}, paths);

console.log(JSON.stringify({
  ok: true,
  root: paths.root,
  copiedFiles: copied.length,
  copiedBytes: copied.reduce((sum, file) => sum + file.bytes, 0),
  migrationHash,
  champion: pointer.current,
  previous: pointer.previous,
}, null, 2));

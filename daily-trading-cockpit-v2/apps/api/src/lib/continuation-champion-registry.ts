/**
 * Immutable continuation artifacts plus one atomically-switched champion pointer.
 *
 * The registry is deliberately shared by TESTNET and LIVE.  Only the lifecycle service writes
 * here; trading processes are read-only consumers and will use previous/bootstrapped evidence on
 * a corrupt pointer rather than trying to repair production state while forming a basket.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DirectionTrajectory,
  type DirectionTrajectoryArtifact,
  validateTrajectoryArtifact,
} from "./direction-model-runtime.js";
import {
  CONTINUATION_FEATURE_SCHEMA_VERSION,
  CONTINUATION_HORIZONS,
  CONTINUATION_LABEL_VERSION,
  CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
  CONTINUATION_NORMALIZATION_VERSION,
  CONTINUATION_SOURCE_COVERAGE_VERSION,
  type ContinuationArtifactMetrics,
  type ContinuationArtifactRecord,
  type ContinuationChampionPointer,
  type ContinuationLifecyclePaths,
  championPointerFile,
  continuationLifecyclePaths,
  continuationNowIso,
  ensureContinuationLifecycleDirectories,
  readJsonFile,
  safeRelativeFile,
  sha256Bytes,
  writeJsonAtomic,
} from "./continuation-lifecycle.js";

export type RegistryArtifactRead = {
  source: "REGISTRY_CURRENT" | "REGISTRY_PREVIOUS";
  record: ContinuationArtifactRecord;
  raw: DirectionTrajectoryArtifact;
};

export type RegistryReadResult = {
  pointer: ContinuationChampionPointer | null;
  artifact: RegistryArtifactRead | null;
  reason: string | null;
};

export type ArtifactRegistrationInput = {
  file: string;
  featureSchemaVersion?: string;
  labelVersion?: string;
  trainingCutoffMs?: number | null;
  labelCutoffMs?: number | null;
  dataManifestHash?: string | null;
  runId?: string | null;
  metrics?: ContinuationArtifactMetrics | null;
  nowMs?: number;
};

function expectedHorizonSet(raw: DirectionTrajectoryArtifact): boolean {
  return raw.horizons.length === CONTINUATION_HORIZONS.length &&
    CONTINUATION_HORIZONS.every((horizon) => raw.horizons.includes(horizon));
}

function calibrationVersion(raw: DirectionTrajectoryArtifact): string {
  return `temperature-${raw.calibrationTemperature}`;
}

function featureListHash(raw: DirectionTrajectoryArtifact): string {
  return sha256Bytes(raw.featureNames.join("\n"));
}

function artifactId(raw: DirectionTrajectoryArtifact, sha256: string): string {
  return `${raw.version}:sha256:${sha256}`;
}

function validRecord(record: unknown): record is ContinuationArtifactRecord {
  const value = record as Partial<ContinuationArtifactRecord>;
  return value?.schemaVersion === CONTINUATION_LIFECYCLE_SCHEMA_VERSION &&
    typeof value.artifactId === "string" && value.artifactId.length > 0 &&
    typeof value.version === "string" && value.version.length > 0 &&
    typeof value.artifactSha256 === "string" && /^[a-f0-9]{64}$/.test(value.artifactSha256) &&
    typeof value.relativePath === "string" && value.relativePath.length > 0 &&
    value.modelSchemaVersion === 4 &&
    typeof value.featureSchemaVersion === "string" && value.featureSchemaVersion.length > 0 &&
    typeof value.featureListHash === "string" && /^[a-f0-9]{64}$/.test(value.featureListHash) &&
    typeof value.normalizationVersion === "string" && value.normalizationVersion.length > 0 &&
    typeof value.sourceCoverageVersion === "string" && value.sourceCoverageVersion.length > 0 &&
    typeof value.labelVersion === "string" && value.labelVersion.length > 0 &&
    typeof value.calibrationVersion === "string" && value.calibrationVersion.length > 0 &&
    typeof value.trainedAt === "string" && typeof value.createdAt === "string";
}

export function validateChampionPointer(value: unknown): value is ContinuationChampionPointer {
  const pointer = value as Partial<ContinuationChampionPointer>;
  return pointer?.schemaVersion === CONTINUATION_LIFECYCLE_SCHEMA_VERSION &&
    typeof pointer.updatedAt === "string" && typeof pointer.updateReason === "string" &&
    validRecord(pointer.current) && (pointer.previous === null || validRecord(pointer.previous));
}

function readRecordArtifact(record: ContinuationArtifactRecord, paths: ContinuationLifecyclePaths): {
  raw: DirectionTrajectoryArtifact | null;
  reason: string | null;
} {
  const rel = safeRelativeFile(paths.registry, record.relativePath);
  if (!rel || !rel.startsWith("artifacts/")) return { raw: null, reason: "registry_artifact_path_invalid" };
  const path = resolve(paths.registry, rel);
  try {
    if (!existsSync(path)) return { raw: null, reason: "registry_artifact_missing" };
    const bytes = readFileSync(path);
    const actual = sha256Bytes(bytes);
    if (actual !== record.artifactSha256) return { raw: null, reason: "registry_artifact_sha256_mismatch" };
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    validateTrajectoryArtifact(parsed);
    const raw = parsed as DirectionTrajectoryArtifact;
    if (!expectedHorizonSet(raw)) return { raw: null, reason: "registry_artifact_horizons_incompatible" };
    if (raw.version !== record.version || artifactId(raw, actual) !== record.artifactId) {
      return { raw: null, reason: "registry_artifact_identity_mismatch" };
    }
    if (featureListHash(raw) !== record.featureListHash) return { raw: null, reason: "registry_artifact_feature_hash_mismatch" };
    if (calibrationVersion(raw) !== record.calibrationVersion) return { raw: null, reason: "registry_artifact_calibration_mismatch" };
    // Structural validation alone is not enough: force the TypeScript parser to construct its
    // production object before this record can reach a formation scan.
    DirectionTrajectory.fromJson(raw);
    return { raw, reason: null };
  } catch (error) {
    return { raw: null, reason: `registry_artifact_read_error:${error instanceof Error ? error.message : "unknown"}` };
  }
}

export function readChampionPointer(paths = continuationLifecyclePaths()): ContinuationChampionPointer | null {
  const parsed = readJsonFile<ContinuationChampionPointer>(championPointerFile(paths));
  return validateChampionPointer(parsed) ? parsed : null;
}

/**
 * Current then previous is intentional.  A promoted artifact can become unreadable after the
 * lifecycle service exits; a trading scan must retain the already-approved previous champion and
 * never form an order on a partially written/unknown artifact.
 */
export function readApprovedChampionArtifact(paths = continuationLifecyclePaths()): RegistryReadResult {
  const pointerPath = championPointerFile(paths);
  if (!existsSync(pointerPath)) return { pointer: null, artifact: null, reason: "registry_pointer_absent" };
  const pointer = readChampionPointer(paths);
  if (!pointer) return { pointer: null, artifact: null, reason: "registry_pointer_invalid" };
  const current = readRecordArtifact(pointer.current, paths);
  if (current.raw) {
    return {
      pointer,
      artifact: { source: "REGISTRY_CURRENT", record: pointer.current, raw: current.raw },
      reason: null,
    };
  }
  if (pointer.previous) {
    const previous = readRecordArtifact(pointer.previous, paths);
    if (previous.raw) {
      return {
        pointer,
        artifact: { source: "REGISTRY_PREVIOUS", record: pointer.previous, raw: previous.raw },
        reason: `current_unavailable:${current.reason ?? "unknown"}`,
      };
    }
    return { pointer, artifact: null, reason: `current_unavailable:${current.reason ?? "unknown"};previous_unavailable:${previous.reason ?? "unknown"}` };
  }
  return { pointer, artifact: null, reason: `current_unavailable:${current.reason ?? "unknown"}` };
}

function materializeRecord(input: ArtifactRegistrationInput, paths: ContinuationLifecyclePaths): {
  record: ContinuationArtifactRecord;
  bytes: Buffer;
  raw: DirectionTrajectoryArtifact;
} {
  const bytes = readFileSync(input.file);
  const sha256 = sha256Bytes(bytes);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  validateTrajectoryArtifact(parsed);
  const raw = parsed as DirectionTrajectoryArtifact;
  if (!expectedHorizonSet(raw)) throw new Error("continuation artifact must provide exact H6/H12/H24/H36 horizons");
  DirectionTrajectory.fromJson(raw);
  const nowMs = input.nowMs ?? Date.now();
  const id = artifactId(raw, sha256);
  const relativePath = `artifacts/${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  const record: ContinuationArtifactRecord = {
    schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
    artifactId: id,
    version: raw.version,
    artifactSha256: sha256,
    relativePath,
    modelSchemaVersion: 4,
    featureSchemaVersion: input.featureSchemaVersion ?? CONTINUATION_FEATURE_SCHEMA_VERSION,
    featureListHash: featureListHash(raw),
    normalizationVersion: CONTINUATION_NORMALIZATION_VERSION,
    sourceCoverageVersion: CONTINUATION_SOURCE_COVERAGE_VERSION,
    labelVersion: input.labelVersion ?? CONTINUATION_LABEL_VERSION,
    calibrationVersion: calibrationVersion(raw),
    trainedAt: raw.trainedAt,
    trainingCutoffMs: input.trainingCutoffMs ?? null,
    labelCutoffMs: input.labelCutoffMs ?? null,
    dataManifestHash: input.dataManifestHash ?? null,
    runId: input.runId ?? null,
    createdAt: continuationNowIso(nowMs),
    metrics: input.metrics ?? null,
  };
  return { record, bytes, raw };
}

/** Copy bytes once under their identity. Same identity with different bytes is a hard failure. */
export function registerImmutableArtifact(input: ArtifactRegistrationInput, paths = continuationLifecyclePaths()): ContinuationArtifactRecord {
  ensureContinuationLifecycleDirectories(paths);
  const materialized = materializeRecord(input, paths);
  const relative = safeRelativeFile(paths.registry, materialized.record.relativePath);
  if (!relative) throw new Error("continuation artifact escaped registry root");
  const destination = resolve(paths.registry, relative);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  if (existsSync(destination)) {
    const existing = readFileSync(destination);
    if (sha256Bytes(existing) !== materialized.record.artifactSha256) {
      throw new Error(`immutable continuation artifact collision: ${materialized.record.artifactId}`);
    }
  } else {
    const temp = `${destination}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, materialized.bytes, { mode: 0o640 });
      // Avoid mutable source-file metadata being carried into the registry. File is atomically
      // published only after both artifact parser and hash have passed above.
      renameSync(temp, destination);
    } finally {
      // If write/rename failed, do not leave a candidate that a later run could mistake for an
      // immutable published artifact. The official artifact path is untouched in that case.
      if (existsSync(temp)) {
        try { unlinkSync(temp); } catch { /* best effort only */ }
      }
    }
  }
  // A prior crash can leave a correctly immutable artifact without its presentation metadata.
  // Regenerating this derived record is safe: the artifact bytes/identity are still immutable.
  writeJsonAtomic(`${destination}.metadata.json`, materialized.record);
  return materialized.record;
}

function writePointer(pointer: ContinuationChampionPointer, paths: ContinuationLifecyclePaths): void {
  writeJsonAtomic(championPointerFile(paths), pointer);
}

export function bootstrapChampion(input: ArtifactRegistrationInput, paths = continuationLifecyclePaths()): ContinuationChampionPointer {
  const existing = readChampionPointer(paths);
  if (existing) return existing;
  const record = registerImmutableArtifact(input, paths);
  const pointer: ContinuationChampionPointer = {
    schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
    updatedAt: continuationNowIso(input.nowMs),
    updateReason: "bootstrap_current_v4_champion",
    current: record,
    previous: null,
  };
  writePointer(pointer, paths);
  return pointer;
}

/** Promotion is a pointer change only; artifacts and run history are never overwritten. */
export function promoteChampion(
  input: ArtifactRegistrationInput,
  reason: string,
  paths = continuationLifecyclePaths(),
): ContinuationChampionPointer {
  const candidate = registerImmutableArtifact(input, paths);
  const prior = readChampionPointer(paths);
  if (prior?.current.artifactSha256 === candidate.artifactSha256) return prior;
  const pointer: ContinuationChampionPointer = {
    schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
    updatedAt: continuationNowIso(input.nowMs),
    updateReason: reason,
    current: candidate,
    previous: prior?.current ?? null,
  };
  writePointer(pointer, paths);
  return pointer;
}

export function rollbackChampion(reason: string, paths = continuationLifecyclePaths(), nowMs = Date.now()): ContinuationChampionPointer | null {
  const prior = readChampionPointer(paths);
  if (!prior?.previous) return null;
  // Validate the rollback target before making it current. If it has been corrupted, keep the
  // existing pointer unchanged; runtime can still select the valid side of it read-only.
  const previous = readRecordArtifact(prior.previous, paths);
  if (!previous.raw) throw new Error(`rollback target invalid: ${previous.reason ?? "unknown"}`);
  const pointer: ContinuationChampionPointer = {
    schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
    updatedAt: continuationNowIso(nowMs),
    updateReason: reason,
    current: prior.previous,
    previous: prior.current,
  };
  writePointer(pointer, paths);
  return pointer;
}

/** Read-only dashboard/API view; it never returns a model tree or raw feature payload. */
export function continuationChampionDetail(paths = continuationLifecyclePaths()): {
  registryPresent: boolean;
  pointer: ContinuationChampionPointer | null;
  activeSource: RegistryArtifactRead["source"] | null;
  activeArtifactId: string | null;
  loadReason: string | null;
} {
  const result = readApprovedChampionArtifact(paths);
  return {
    registryPresent: existsSync(championPointerFile(paths)),
    pointer: result.pointer,
    activeSource: result.artifact?.source ?? null,
    activeArtifactId: result.artifact?.record.artifactId ?? null,
    loadReason: result.reason,
  };
}

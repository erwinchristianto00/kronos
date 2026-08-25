/**
 * Canonical persistence contract for the Dynamic MOM36 continuation lifecycle.
 *
 * This module deliberately owns no model policy and sends no orders.  It gives the collector,
 * dataset builder, trainer and runtime one durable vocabulary for raw records, watermarks,
 * training runs and the shared champion registry.  Every mutable JSON document is written via
 * temp + rename; raw events are append-only JSONL and are never silently rewritten.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const CONTINUATION_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const CONTINUATION_FEATURE_SCHEMA_VERSION = "direction-model-features-v4-975c996" as const;
export const CONTINUATION_LABEL_VERSION = "v4-vol-normalized-multi-horizon-path-v1" as const;
/** Tree models consume nullable V4 values through learned missing branches; no scaler is fitted. */
export const CONTINUATION_NORMALIZATION_VERSION = "tree-native-missing-v1" as const;
/** New feeds stay diagnostic until an explicit feature-set strategy revision authorizes them. */
export const CONTINUATION_SOURCE_COVERAGE_VERSION = "v4-frozen-primary-sources-v1" as const;
export const CONTINUATION_HORIZONS = [6, 12, 24, 36] as const;
export const CONTINUATION_REQUIRED_NEW_MATURE_ROWS = 168 as const;
export const CONTINUATION_MIN_RETRAIN_INTERVAL_MS = 7 * 24 * 3_600_000;
export const CONTINUATION_MAX_LOCK_AGE_MS = 12 * 3_600_000;
export const CONTINUATION_RAW_SCHEMA_VERSION = 1 as const;

export type ContinuationLifecyclePaths = {
  root: string;
  raw: string;
  quarantine: string;
  materialized: string;
  snapshots: string;
  runs: string;
  registry: string;
  artifacts: string;
  history: string;
  status: string;
  commands: string;
  locks: string;
};

/**
 * The data root is intentionally outside a release directory.  Testnet and live therefore use
 * the same approved pointer, while an API release rollback cannot erase model history.  Local
 * tests/default development remain self-contained under apps/api/data.
 */
export function continuationLifecycleRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CONTINUATION_LIFECYCLE_ROOT?.trim();
  return configured ? resolve(configured) : resolve(process.cwd(), "data/continuation-lifecycle");
}

export function continuationLifecyclePaths(root = continuationLifecycleRoot()): ContinuationLifecyclePaths {
  const resolved = resolve(root);
  const registry = resolve(resolved, "registry");
  return {
    root: resolved,
    raw: resolve(resolved, "raw"),
    quarantine: resolve(resolved, "quarantine"),
    materialized: resolve(resolved, "materialized"),
    snapshots: resolve(resolved, "snapshots"),
    runs: resolve(resolved, "runs"),
    registry,
    artifacts: resolve(registry, "artifacts"),
    history: resolve(registry, "history"),
    status: resolve(resolved, "status"),
    commands: resolve(resolved, "commands"),
    locks: resolve(resolved, "locks"),
  };
}

export function ensureContinuationLifecycleDirectories(paths = continuationLifecyclePaths()): ContinuationLifecyclePaths {
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });
  return paths;
}

export function continuationNowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Atomic replace: readers see either the complete old object or the complete new object. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, stableJson(value), { encoding: "utf8", mode: 0o640 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) {
      try { unlinkSync(temp); } catch { /* best-effort cleanup only */ }
    }
  }
}

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function safeRelativeFile(root: string, candidate: string): string | null {
  if (!candidate || isAbsolute(candidate)) return null;
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) ? rel : null;
}

export type ContinuationRawEvent = {
  schemaVersion: typeof CONTINUATION_RAW_SCHEMA_VERSION;
  source: string;
  symbol: string | null;
  dataType: string;
  eventTimestampMs: number;
  receivedTimestampMs: number;
  payload: Record<string, unknown>;
  /** Optional source identity lets reconciliation deduplicate without discarding raw history. */
  sourceRecordId?: string | null;
};

export type ContinuationQuarantineRecord = {
  schemaVersion: typeof CONTINUATION_LIFECYCLE_SCHEMA_VERSION;
  quarantinedAt: string;
  reason: string;
  event: unknown;
};

export type ContinuationWatermark = {
  source: string;
  dataType: string;
  symbol: string | null;
  lastEventTimestampMs: number | null;
  lastReceivedTimestampMs: number | null;
  lastValidatedTimestampMs: number | null;
  /** Cumulative observed discontinuities. Kept for audit even after REST repaired them. */
  gapCount: number;
  /** Gaps still not covered by a successful REST reconciliation. */
  unresolvedGapCount: number;
  /** First missing interval that still needs REST repair, if known. */
  earliestUnresolvedGapTimestampMs: number | null;
  duplicateCount: number;
  invalidCount: number;
  freshness: "HEALTHY" | "STALE" | "GAPPED" | "UNKNOWN";
  updatedAt: string;
  lastError: string | null;
};

export type ContinuationCollectorHealth = {
  schemaVersion: typeof CONTINUATION_LIFECYCLE_SCHEMA_VERSION;
  updatedAt: string;
  collectorId: string;
  running: boolean;
  watermarks: Record<string, ContinuationWatermark>;
  sourceSummary: Record<string, {
    required: boolean;
    freshness: "HEALTHY" | "STALE" | "GAPPED" | "UNKNOWN";
    ageMs: number | null;
    eventsToday: number;
    lastError: string | null;
  }>;
};

export type ContinuationRunVerdict = "PENDING" | "SKIPPED" | "FAILED" | "REJECTED" | "PROMOTION_CANDIDATE" | "PROMOTED" | "ROLLED_BACK";

export type ContinuationGateResult = {
  id:
    | "DATA_INTEGRITY"
    | "FEATURE_PARITY"
    | "NO_LEAKAGE"
    | "SUFFICIENT_SAMPLES"
    | "BASE_RATE"
    | "PRIMARY_IMPROVEMENT"
    | "CALIBRATION"
    | "DECISION_LEVEL"
    | "TEMPORAL_STABILITY"
    | "BOOTSTRAP_UNCERTAINTY"
    | "RUNTIME_DRY_LOAD";
  passed: boolean;
  detail: string;
  values?: Record<string, number | string | boolean | null>;
};

export type ContinuationArtifactMetrics = {
  trajectory: {
    logLoss: number | null;
    baseRateLogLoss: number | null;
    balancedAccuracy: number | null;
    brier: number | null;
    expectedReturnCorrelation: number | null;
    calibrationEce: number | null;
  };
  horizons: Record<string, {
    logLoss: number | null;
    baseRateLogLoss: number | null;
    balancedAccuracy: number | null;
    brier: number | null;
    expectedReturnCorrelation: number | null;
  }>;
  decisions: {
    observations: number;
    noEdgePct: number | null;
    tiltPct: number | null;
    confirmationCount: number;
    conflictCount: number;
    confirmationSignedMeanReturn: number | null;
    conflictSignedMeanReturn: number | null;
  };
  temporal: {
    buckets: number;
    nonRegressingBuckets: number;
    worstDeltaLogLoss: number | null;
    medianDeltaLogLoss: number | null;
  };
  bootstrap: {
    deltaLogLossCiLow: number | null;
    deltaLogLossCiHigh: number | null;
  };
};

export type ContinuationArtifactRecord = {
  schemaVersion: typeof CONTINUATION_LIFECYCLE_SCHEMA_VERSION;
  artifactId: string;
  version: string;
  artifactSha256: string;
  relativePath: string;
  modelSchemaVersion: 4;
  featureSchemaVersion: string;
  featureListHash: string;
  normalizationVersion: string;
  sourceCoverageVersion: string;
  labelVersion: string;
  calibrationVersion: string;
  trainedAt: string;
  trainingCutoffMs: number | null;
  labelCutoffMs: number | null;
  dataManifestHash: string | null;
  runId: string | null;
  createdAt: string;
  metrics: ContinuationArtifactMetrics | null;
};

export type ContinuationChampionPointer = {
  schemaVersion: typeof CONTINUATION_LIFECYCLE_SCHEMA_VERSION;
  updatedAt: string;
  updateReason: string;
  current: ContinuationArtifactRecord;
  previous: ContinuationArtifactRecord | null;
};

export type ContinuationLifecycleRun = {
  schemaVersion: typeof CONTINUATION_LIFECYCLE_SCHEMA_VERSION;
  runId: string;
  startedAt: string;
  completedAt: string | null;
  gitHash: string | null;
  mode: "SCHEDULED" | "MANUAL" | "RECOVERY";
  trainingCutoffMs: number | null;
  labelCutoffMs: number | null;
  latestMatureFormationTimestampMs: number | null;
  dataManifestHash: string | null;
  featureSchemaVersion: string;
  featureListHash: string | null;
  labelVersion: string;
  rowCount: number | null;
  newMatureRows: number | null;
  championBefore: string | null;
  challenger: ContinuationArtifactRecord | null;
  gates: ContinuationGateResult[];
  verdict: ContinuationRunVerdict;
  reason: string;
  resourceSnapshot: ContinuationResourceSnapshot | null;
};

export type ContinuationResourceSnapshot = {
  capturedAt: string;
  loadAverage1m: number | null;
  freeMemoryBytes: number | null;
  totalMemoryBytes: number | null;
  diskAvailableBytes: number | null;
  diskTotalBytes: number | null;
  processId: number | null;
  nice: number | null;
  threads: number;
  safe: boolean;
  reason: string | null;
};

export type ContinuationLifecycleStatus = {
  schemaVersion: typeof CONTINUATION_LIFECYCLE_SCHEMA_VERSION;
  updatedAt: string;
  mode: "AUTO_PROMOTION_STRICT_GATE";
  /** Operator kill switch for pointer changes; collection/evaluation still continue. */
  autoPromotionEnabled: boolean;
  trainingPaused: boolean;
  collector: ContinuationCollectorHealth | null;
  currentChampion: ContinuationArtifactRecord | null;
  rollbackTarget: ContinuationArtifactRecord | null;
  latestMatureLabelTimestampMs: number | null;
  latestFeatureRefreshAt: string | null;
  trainingRows: number | null;
  newMatureRows: number | null;
  nextRetrainEligibleAt: string | null;
  trainingRunning: boolean;
  lastRun: Pick<ContinuationLifecycleRun,
    "runId" | "completedAt" | "verdict" | "reason" | "challenger" | "gates"> | null;
  resource: ContinuationResourceSnapshot | null;
  lastError: string | null;
};

/**
 * A compact, durable view of the rolling label queue. Individual labels are derived from the
 * immutable materialized bars at snapshot time, but this state makes the PENDING_LABEL -> MATURE
 * boundary observable without ever fabricating a future outcome into a row.
 */
export type ContinuationLabelMaturationStatus = {
  schemaVersion: typeof CONTINUATION_LIFECYCLE_SCHEMA_VERSION;
  updatedAt: string;
  labelVersion: string;
  horizonHours: number;
  latestCommonCompletedCandleTimestampMs: number | null;
  latestMatureFormationTimestampMs: number | null;
  pendingLabelFromTimestampMs: number | null;
  state: "UNAVAILABLE" | "PENDING_LABEL" | "MATURE";
};

export function defaultLifecycleStatus(nowMs = Date.now()): ContinuationLifecycleStatus {
  return {
    schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
    updatedAt: continuationNowIso(nowMs),
    mode: "AUTO_PROMOTION_STRICT_GATE",
    autoPromotionEnabled: true,
    trainingPaused: false,
    collector: null,
    currentChampion: null,
    rollbackTarget: null,
    latestMatureLabelTimestampMs: null,
    latestFeatureRefreshAt: null,
    trainingRows: null,
    newMatureRows: null,
    nextRetrainEligibleAt: null,
    trainingRunning: false,
    lastRun: null,
    resource: null,
    lastError: null,
  };
}

export function lifecycleStatusFile(paths = continuationLifecyclePaths()): string {
  return resolve(paths.status, "lifecycle-status.json");
}

export function collectorHealthFile(paths = continuationLifecyclePaths()): string {
  return resolve(paths.status, "collector-health.json");
}

export function labelMaturationStatusFile(paths = continuationLifecyclePaths()): string {
  return resolve(paths.status, "label-maturation.json");
}

export function championPointerFile(paths = continuationLifecyclePaths()): string {
  return resolve(paths.registry, "champion-pointer.json");
}

export function writeLifecycleStatus(status: ContinuationLifecycleStatus, paths = continuationLifecyclePaths()): void {
  writeJsonAtomic(lifecycleStatusFile(paths), status);
}

export function readLifecycleStatus(paths = continuationLifecyclePaths()): ContinuationLifecycleStatus | null {
  const status = readJsonFile<ContinuationLifecycleStatus>(lifecycleStatusFile(paths));
  return status?.schemaVersion === CONTINUATION_LIFECYCLE_SCHEMA_VERSION ? status : null;
}

export function writeCollectorHealth(health: ContinuationCollectorHealth, paths = continuationLifecyclePaths()): void {
  writeJsonAtomic(collectorHealthFile(paths), health);
}

export function readCollectorHealth(paths = continuationLifecyclePaths()): ContinuationCollectorHealth | null {
  const health = readJsonFile<ContinuationCollectorHealth>(collectorHealthFile(paths));
  return health?.schemaVersion === CONTINUATION_LIFECYCLE_SCHEMA_VERSION ? health : null;
}

export function writeLabelMaturationStatus(status: ContinuationLabelMaturationStatus, paths = continuationLifecyclePaths()): void {
  writeJsonAtomic(labelMaturationStatusFile(paths), status);
}

export function readLabelMaturationStatus(paths = continuationLifecyclePaths()): ContinuationLabelMaturationStatus | null {
  const status = readJsonFile<ContinuationLabelMaturationStatus>(labelMaturationStatusFile(paths));
  return status?.schemaVersion === CONTINUATION_LIFECYCLE_SCHEMA_VERSION ? status : null;
}

function cleanPathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function rawEventFile(event: Pick<ContinuationRawEvent, "source" | "dataType" | "receivedTimestampMs">, paths = continuationLifecyclePaths()): string {
  const day = new Date(event.receivedTimestampMs).toISOString().slice(0, 10);
  return resolve(paths.raw, cleanPathPart(event.source), cleanPathPart(event.dataType), `${day}.jsonl`);
}

export function quarantineEventFile(nowMs = Date.now(), paths = continuationLifecyclePaths()): string {
  return resolve(paths.quarantine, `${new Date(nowMs).toISOString().slice(0, 10)}.jsonl`);
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 946684800000 && value < 4102444800000;
}

export function validateRawEvent(value: unknown): value is ContinuationRawEvent {
  const event = value as Partial<ContinuationRawEvent>;
  return event?.schemaVersion === CONTINUATION_RAW_SCHEMA_VERSION &&
    typeof event.source === "string" && event.source.length > 0 &&
    (typeof event.symbol === "string" || event.symbol === null) &&
    typeof event.dataType === "string" && event.dataType.length > 0 &&
    finiteTimestamp(event.eventTimestampMs) && finiteTimestamp(event.receivedTimestampMs) &&
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload);
}

/** Invalid rows are isolated, never coerced into a seemingly valid training observation. */
export function appendRawEvent(event: ContinuationRawEvent, paths = continuationLifecyclePaths()): void {
  if (!validateRawEvent(event)) {
    const quarantine: ContinuationQuarantineRecord = {
      schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
      quarantinedAt: continuationNowIso(),
      reason: "invalid_raw_event_contract",
      event,
    };
    const file = quarantineEventFile(Date.now(), paths);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(quarantine)}\n`, "utf8");
    throw new Error("continuation raw event failed contract validation");
  }
  const file = rawEventFile(event, paths);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
}

export type ContinuationLock = { path: string; release: () => void };

/**
 * A single lifecycle authority.  Dead-owner locks are recovered only after checking the recorded
 * PID (when it is local) and a conservative age bound; a live second trainer always fails closed.
 */
export function acquireContinuationLock(
  name: string,
  paths = continuationLifecyclePaths(),
  nowMs = Date.now(),
): ContinuationLock | null {
  ensureContinuationLifecycleDirectories(paths);
  const path = resolve(paths.locks, `${cleanPathPart(name)}.lock`);
  const body = { pid: process.pid, acquiredAtMs: nowMs, acquiredAt: continuationNowIso(nowMs) };
  try {
    const fd = openSync(path, "wx", 0o640);
    try { writeFileSync(fd, JSON.stringify(body)); } finally { closeSync(fd); }
    return { path, release: () => { try { unlinkSync(path); } catch { /* already released */ } } };
  } catch {
    const existing = readJsonFile<{ pid?: unknown; acquiredAtMs?: unknown }>(path);
    const age = typeof existing?.acquiredAtMs === "number" ? nowMs - existing.acquiredAtMs : null;
    const pid = typeof existing?.pid === "number" && Number.isInteger(existing.pid) ? existing.pid : null;
    let alive = false;
    if (pid !== null && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    if (alive || age === null || age < CONTINUATION_MAX_LOCK_AGE_MS) return null;
    const stale = `${path}.stale-${nowMs}-${randomUUID()}`;
    try { renameSync(path, stale); } catch { return null; }
    return acquireContinuationLock(name, paths, nowMs);
  }
}

export function appendRunHistory(run: ContinuationLifecycleRun, paths = continuationLifecyclePaths()): void {
  const file = resolve(paths.history, `${run.runId}.json`);
  if (existsSync(file)) throw new Error(`continuation run history already exists: ${run.runId}`);
  writeJsonAtomic(file, run);
}

export type ContinuationLifecycleCommand =
  | "PAUSE_TRAINING"
  | "RESUME_TRAINING"
  | "INTEGRITY_CHECK"
  | "TRAIN_CHALLENGER"
  | "DISABLE_AUTO_PROMOTION"
  | "ENABLE_AUTO_PROMOTION"
  | "ROLLBACK_CHAMPION";

export type QueuedContinuationLifecycleCommand = {
  schemaVersion: typeof CONTINUATION_LIFECYCLE_SCHEMA_VERSION;
  commandId: string;
  command: ContinuationLifecycleCommand;
  requestedAt: string;
  requestedAtMs: number;
  requestedBy: "LOOPBACK_OPERATOR" | "SERVICE_RECOVERY";
};

/** Commands are queued for the lifecycle owner; an HTTP/API worker never mutates a champion. */
export function queueLifecycleCommand(
  command: ContinuationLifecycleCommand,
  paths = continuationLifecyclePaths(),
  nowMs = Date.now(),
  requestedBy: QueuedContinuationLifecycleCommand["requestedBy"] = "LOOPBACK_OPERATOR",
): QueuedContinuationLifecycleCommand {
  ensureContinuationLifecycleDirectories(paths);
  const commandId = `${new Date(nowMs).toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const queued: QueuedContinuationLifecycleCommand = {
    schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
    commandId,
    command,
    requestedAt: continuationNowIso(nowMs),
    requestedAtMs: nowMs,
    requestedBy,
  };
  writeJsonAtomic(resolve(paths.commands, `${commandId}.json`), queued);
  return queued;
}

export function queuedLifecycleCommands(paths = continuationLifecyclePaths()): QueuedContinuationLifecycleCommand[] {
  try {
    return readdirSync(paths.commands)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .flatMap((name) => {
        const queued = readJsonFile<QueuedContinuationLifecycleCommand>(resolve(paths.commands, name));
        return queued?.schemaVersion === CONTINUATION_LIFECYCLE_SCHEMA_VERSION ? [queued] : [];
      });
  } catch {
    return [];
  }
}

export function acknowledgeLifecycleCommand(commandId: string, paths = continuationLifecyclePaths()): void {
  const file = resolve(paths.commands, `${commandId}.json`);
  if (!existsSync(file)) return;
  const archive = resolve(paths.commands, "processed", `${commandId}.json`);
  mkdirSync(dirname(archive), { recursive: true });
  renameSync(file, archive);
}

export function createRunId(nowMs = Date.now()): string {
  return `cont-${new Date(nowMs).toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
}

export function fileBytes(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}

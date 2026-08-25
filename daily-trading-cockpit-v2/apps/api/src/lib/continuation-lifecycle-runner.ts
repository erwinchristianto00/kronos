/**
 * The single low-priority authority for continuation data snapshots, challenger training and
 * champion promotion.  It deliberately has no exchange client and does not import an executor.
 * A failure here leaves the current pointer and every open basket untouched.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, getPriority, loadavg, totalmem } from "node:os";
import { dirname, relative, resolve } from "node:path";
import {
  DirectionTrajectory,
  type DirectionTrajectoryArtifact,
  validateTrajectoryArtifact,
} from "./direction-model-runtime.js";
import { CROSS_SECTIONAL_UNIVERSE } from "./cross-sectional-edge.js";
import {
  readApprovedChampionArtifact,
  readChampionPointer,
  registerImmutableArtifact,
  promoteChampion,
  rollbackChampion,
} from "./continuation-champion-registry.js";
import {
  compareContinuationArtifacts,
  evaluateContinuationArtifact,
  newestPurgedHoldout,
  readContinuationMatrix,
  type ContinuationArtifactEvaluation,
  type ContinuationMatrixRow,
} from "./continuation-evaluation.js";
import {
  CONTINUATION_FEATURE_SCHEMA_VERSION,
  CONTINUATION_LABEL_VERSION,
  CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
  CONTINUATION_MIN_RETRAIN_INTERVAL_MS,
  CONTINUATION_NORMALIZATION_VERSION,
  CONTINUATION_REQUIRED_NEW_MATURE_ROWS,
  CONTINUATION_SOURCE_COVERAGE_VERSION,
  acquireContinuationLock,
  acknowledgeLifecycleCommand,
  appendRunHistory,
  continuationLifecyclePaths,
  continuationNowIso,
  defaultLifecycleStatus,
  ensureContinuationLifecycleDirectories,
  queuedLifecycleCommands,
  readCollectorHealth,
  readLifecycleStatus,
  sha256Bytes,
  stableJson,
  writeJsonAtomic,
  writeLabelMaturationStatus,
  writeLifecycleStatus,
  type ContinuationArtifactMetrics,
  type ContinuationArtifactRecord,
  type ContinuationCollectorHealth,
  type ContinuationGateResult,
  type ContinuationLifecyclePaths,
  type ContinuationLifecycleRun,
  type ContinuationLifecycleStatus,
  type ContinuationLabelMaturationStatus,
  type ContinuationResourceSnapshot,
} from "./continuation-lifecycle.js";

const HOUR_MS = 3_600_000;
const LABEL_FINALIZATION_BUFFER_MS = 15 * 60_000;
const MIN_TOTAL_MATURE_ROWS = 2_700;
const MIN_HOLDOUT_ROWS = 500;
const MIN_FREE_MEMORY_BYTES = 1_500 * 1024 * 1024;
const MIN_DISK_AVAILABLE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const TRAINING_THREADS = 2;

type SnapshotManifest = {
  schemaVersion: 1;
  createdAt: string;
  runId: string;
  files: Array<{ relativePath: string; bytes: number; sha256: string }>;
  sourceRoot: string;
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

export type ContinuationPromotionInput = {
  dataIntegrity: boolean;
  featureParity: boolean;
  pythonRuntimeParity: boolean;
  noLeakage: boolean;
  sufficientSamples: boolean;
  runtimeDryLoad: boolean;
  trainerFidelity: number | null;
  champion: ContinuationArtifactMetrics;
  challenger: ContinuationArtifactMetrics;
};

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function relativeImprovement(champion: number | null, challenger: number | null): number | null {
  return finite(champion) && champion > 0 && finite(challenger) ? (champion - challenger) / champion : null;
}

function meanNonRegression(champion: number | null, challenger: number | null): boolean {
  // No decision from either artifact is neutral, not a fabricated win.  If only the challenger
  // emits a decision it must be positive; if only the champion emits one, losing it is allowed
  // only when the champion's own decision was not positive.
  if (champion === null && challenger === null) return true;
  if (champion === null) return finite(challenger) && challenger >= 0;
  if (challenger === null) return champion <= 0;
  return challenger >= champion - 0.0005;
}

/** Strict, deterministic policy gates. None of these values change continuation authority. */
export function evaluateContinuationPromotionGates(input: ContinuationPromotionInput): ContinuationGateResult[] {
  const challenger = input.challenger;
  const champion = input.champion;
  const primaryImprovement = relativeImprovement(champion.trajectory.logLoss, challenger.trajectory.logLoss);
  const baseRateImprovement = relativeImprovement(challenger.trajectory.baseRateLogLoss, challenger.trajectory.logLoss);
  const calibrationWorse = finite(challenger.trajectory.calibrationEce) && finite(champion.trajectory.calibrationEce)
    ? challenger.trajectory.calibrationEce - champion.trajectory.calibrationEce
    : null;
  const tilt = challenger.decisions.tiltPct;
  const championTilt = champion.decisions.tiltPct;
  const tiltSafe = (tilt === null || tilt <= 0.50) &&
    (tilt === null || championTilt === null || tilt <= championTilt + 0.05);
  const decisionSafe = tiltSafe &&
    meanNonRegression(champion.decisions.confirmationSignedMeanReturn, challenger.decisions.confirmationSignedMeanReturn) &&
    meanNonRegression(champion.decisions.conflictSignedMeanReturn, challenger.decisions.conflictSignedMeanReturn);
  const temporal = challenger.temporal;
  const temporalRatio = temporal.buckets ? temporal.nonRegressingBuckets / temporal.buckets : null;
  const bootstrapUpper = challenger.bootstrap.deltaLogLossCiHigh;

  return [
    { id: "DATA_INTEGRITY", passed: input.dataIntegrity, detail: input.dataIntegrity ? "required completed-market inputs are fresh and validated" : "required collector/data integrity check failed" },
    {
      id: "FEATURE_PARITY",
      passed: input.featureParity && input.pythonRuntimeParity && input.trainerFidelity !== null && input.trainerFidelity <= 1e-6,
      detail: input.featureParity && input.pythonRuntimeParity && input.trainerFidelity !== null && input.trainerFidelity <= 1e-6
        ? "frozen feature schema/hash, Python export, and Python-to-TypeScript inference parity passed"
        : "feature schema/hash, Python export, or Python-to-TypeScript inference parity failed",
      values: { trainerFidelity: input.trainerFidelity, pythonRuntimeParity: input.pythonRuntimeParity },
    },
    { id: "NO_LEAKAGE", passed: input.noLeakage, detail: input.noLeakage ? "all feature timestamps and mature labels obeyed the frozen cutoff" : "PIT or label-maturity invariant failed" },
    { id: "SUFFICIENT_SAMPLES", passed: input.sufficientSamples, detail: input.sufficientSamples ? "chronological train/validation/holdout sample floors passed" : "insufficient mature chronology or new observations" },
    {
      id: "BASE_RATE",
      passed: baseRateImprovement !== null && baseRateImprovement >= -0.005,
      detail: baseRateImprovement !== null && baseRateImprovement >= -0.005
        ? "candidate is not materially worse than a path base-rate predictor"
        : "candidate is materially worse than base-rate",
      values: { relativeImprovement: baseRateImprovement },
    },
    {
      id: "PRIMARY_IMPROVEMENT",
      passed: primaryImprovement !== null && primaryImprovement >= 0.005,
      detail: primaryImprovement !== null && primaryImprovement >= 0.005
        ? "trajectory logloss improves champion by at least 0.5%"
        : "trajectory logloss did not clear the 0.5% minimum improvement",
      values: { relativeImprovement: primaryImprovement },
    },
    {
      id: "CALIBRATION",
      passed: calibrationWorse === null || calibrationWorse <= 0.01,
      detail: calibrationWorse === null || calibrationWorse <= 0.01
        ? "trajectory calibration did not materially regress"
        : "trajectory calibration regressed by more than 1 percentage point ECE",
      values: { eceDelta: calibrationWorse },
    },
    {
      id: "DECISION_LEVEL",
      passed: decisionSafe,
      detail: decisionSafe
        ? "exact ±1-rung decision mapping did not become materially more aggressive or weaker"
        : "decision coverage/tilt or signed-return behavior regressed",
      values: { challengerTiltPct: tilt, championTiltPct: championTilt },
    },
    {
      id: "TEMPORAL_STABILITY",
      passed: temporal.buckets >= 3 && temporalRatio !== null && temporalRatio >= 0.60 &&
        temporal.worstDeltaLogLoss !== null && temporal.worstDeltaLogLoss <= 0.05,
      detail: temporal.buckets >= 3 && temporalRatio !== null && temporalRatio >= 0.60 &&
        temporal.worstDeltaLogLoss !== null && temporal.worstDeltaLogLoss <= 0.05
        ? "monthly chronological blocks are broadly non-regressing"
        : "monthly stability is insufficient or concentrated in too few periods",
      values: { buckets: temporal.buckets, nonRegressingRatio: temporalRatio, worstDeltaLogLoss: temporal.worstDeltaLogLoss },
    },
    {
      id: "BOOTSTRAP_UNCERTAINTY",
      passed: bootstrapUpper !== null && bootstrapUpper < 0,
      detail: bootstrapUpper !== null && bootstrapUpper < 0
        ? "time-block bootstrap upper confidence bound still shows lower challenger loss"
        : "bootstrap interval does not establish a robust improvement",
      values: { deltaLogLossCiLow: challenger.bootstrap.deltaLogLossCiLow, deltaLogLossCiHigh: bootstrapUpper },
    },
    { id: "RUNTIME_DRY_LOAD", passed: input.runtimeDryLoad, detail: input.runtimeDryLoad ? "TypeScript parser and sampled finite inference passed" : "runtime dry-load failed" },
  ];
}

/** A hard operational gate: only price series are required; optional sources remain explicit missing values. */
export function continuationCollectorIntegrityGate(
  health: ContinuationCollectorHealth | null,
  nowMs = Date.now(),
): ContinuationGateResult {
  const healthAgeMs = health ? nowMs - Date.parse(health.updatedAt) : null;
  const required = health ? Object.values(health.sourceSummary).filter((source) => source.required) : [];
  const healthy = Boolean(health?.running) && healthAgeMs !== null && Number.isFinite(healthAgeMs) && healthAgeMs <= 15 * 60_000 &&
    required.length >= 3 && required.every((source) => source.freshness === "HEALTHY" && source.lastError === null);
  return {
    id: "DATA_INTEGRITY",
    passed: healthy,
    detail: healthy ? "all required Binance completed-kline sources are healthy" : "collector is absent, stale, gapped, or missing a required completed-kline source",
    values: { healthAgeMs, requiredSources: required.length },
  };
}

/** Read-only host guard. The service wrapper supplies nice/ionice; this prevents starting work when the box is already busy. */
export function continuationResourceSnapshot(paths = continuationLifecyclePaths(), nowMs = Date.now()): ContinuationResourceSnapshot {
  const cpuCount = Math.max(1, cpus().length);
  const load = loadavg()[0] ?? null;
  const free = freemem();
  const total = totalmem();
  let diskAvailableBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const result = spawnSync("df", ["-Pk", paths.root], { encoding: "utf8", timeout: 5_000 });
    const line = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
    const parts = line.split(/\s+/);
    if (parts.length >= 4) {
      diskTotalBytes = Number(parts[1]) * 1024;
      diskAvailableBytes = Number(parts[3]) * 1024;
      if (!Number.isFinite(diskTotalBytes)) diskTotalBytes = null;
      if (!Number.isFinite(diskAvailableBytes)) diskAvailableBytes = null;
    }
  } catch { /* unknown disk capacity is unsafe for a new training run */ }
  let nice: number | null = null;
  try { nice = getPriority(process.pid); } catch { /* platform does not expose priority */ }
  const maxLoad = Math.max(2, cpuCount * 0.8);
  const reasons: string[] = [];
  if (!finite(load) || load > maxLoad) reasons.push(`load_1m=${load ?? "unknown"}>${maxLoad.toFixed(2)}`);
  if (free < MIN_FREE_MEMORY_BYTES) reasons.push(`free_memory=${free}<${MIN_FREE_MEMORY_BYTES}`);
  if (diskAvailableBytes === null || diskAvailableBytes < MIN_DISK_AVAILABLE_BYTES) reasons.push("disk_available_below_guard");
  return {
    capturedAt: continuationNowIso(nowMs),
    loadAverage1m: load,
    freeMemoryBytes: free,
    totalMemoryBytes: total,
    diskAvailableBytes,
    diskTotalBytes,
    processId: process.pid,
    nice,
    threads: TRAINING_THREADS,
    safe: reasons.length === 0,
    reason: reasons.length ? reasons.join(";") : null,
  };
}

function currentStatus(paths: ContinuationLifecyclePaths, nowMs: number): ContinuationLifecycleStatus {
  const stored = readLifecycleStatus(paths);
  return {
    ...defaultLifecycleStatus(nowMs),
    ...(stored ?? {}),
    // Pre-lifecycle files cannot silently disable the normal safe default.
    autoPromotionEnabled: stored?.autoPromotionEnabled !== false,
  };
}

function runSkeleton(
  runId: string,
  mode: ContinuationLifecycleRun["mode"],
  nowMs: number,
  championBefore: string | null,
  resource: ContinuationResourceSnapshot | null,
): ContinuationLifecycleRun {
  return {
    schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
    runId,
    startedAt: continuationNowIso(nowMs),
    completedAt: null,
    gitHash: gitHash(),
    mode,
    trainingCutoffMs: null,
    labelCutoffMs: null,
    latestMatureFormationTimestampMs: null,
    dataManifestHash: null,
    featureSchemaVersion: CONTINUATION_FEATURE_SCHEMA_VERSION,
    featureListHash: null,
    labelVersion: CONTINUATION_LABEL_VERSION,
    rowCount: null,
    newMatureRows: null,
    championBefore,
    challenger: null,
    gates: [],
    verdict: "PENDING",
    reason: "pending",
    resourceSnapshot: resource,
  };
}

function finishRun(run: ContinuationLifecycleRun, verdict: ContinuationLifecycleRun["verdict"], reason: string, nowMs: number): ContinuationLifecycleRun {
  return { ...run, verdict, reason, completedAt: continuationNowIso(nowMs) };
}

function gitHash(): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8", timeout: 5_000 });
    const value = result.stdout.trim();
    return /^[a-f0-9]{40}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function latestOpenTime(file: string): number | null {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(rows)) return null;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const timestamp = Array.isArray(rows[index]) ? rows[index]?.[0] : null;
      if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
    }
  } catch { /* collector will repair malformed/missing data; lifecycle fails closed */ }
  return null;
}

function latestCommonCompletedCandleTimestamp(paths: ContinuationLifecyclePaths): number | null {
  const directory = resolve(paths.materialized, "ohlcv");
  if (!existsSync(directory)) return null;
  const latest: number[] = [];
  for (const symbol of CROSS_SECTIONAL_UNIVERSE) {
    const timestamp = latestOpenTime(resolve(directory, `${symbol}.json`));
    if (timestamp === null) return null;
    latest.push(timestamp);
  }
  // The historical V4 matrix requires its whole cross-sectional population. A single missing
  // symbol must therefore block training rather than changing the population unseen.
  if (latest.length !== CROSS_SECTIONAL_UNIVERSE.length) return null;
  return Math.min(...latest);
}

/**
 * Derive the visible rolling PENDING_LABEL -> MATURE frontier from completed common candles.
 * Rows are still materialized only in a frozen training snapshot; this state never creates a
 * forward outcome and is safe to refresh frequently.
 */
export function deriveContinuationLabelMaturation(
  latestCommonCompletedCandleTimestampMs: number | null,
  nowMs: number,
): ContinuationLabelMaturationStatus {
  const latestMatureFormationTimestampMs = latestCommonCompletedCandleTimestampMs === null
    ? null
    : Math.min(
      latestCommonCompletedCandleTimestampMs - 36 * HOUR_MS,
      nowMs - 36 * HOUR_MS - LABEL_FINALIZATION_BUFFER_MS,
    );
  const state = latestMatureFormationTimestampMs === null || latestCommonCompletedCandleTimestampMs === null
    ? "UNAVAILABLE" as const
    : latestMatureFormationTimestampMs < latestCommonCompletedCandleTimestampMs ? "PENDING_LABEL" as const : "MATURE" as const;
  return {
    schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
    updatedAt: continuationNowIso(nowMs),
    labelVersion: CONTINUATION_LABEL_VERSION,
    horizonHours: 36,
    latestCommonCompletedCandleTimestampMs,
    latestMatureFormationTimestampMs,
    pendingLabelFromTimestampMs: latestMatureFormationTimestampMs === null ? null : latestMatureFormationTimestampMs + HOUR_MS,
    state,
  };
}

function labelMaturationStatus(paths: ContinuationLifecyclePaths, nowMs: number): ContinuationLabelMaturationStatus {
  return deriveContinuationLabelMaturation(latestCommonCompletedCandleTimestamp(paths), nowMs);
}

function copyJsonTree(source: string, destination: string, snapshotRoot: string, files: SnapshotManifest["files"]): void {
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const input = resolve(source, entry.name);
    const output = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      copyJsonTree(input, output, snapshotRoot, files);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(input, output);
      const bytes = readFileSync(output);
      files.push({ relativePath: relative(snapshotRoot, output), bytes: bytes.length, sha256: sha256Bytes(bytes) });
    }
  }
}

function createTrainingSnapshot(paths: ContinuationLifecyclePaths, runId: string, nowMs: number): { root: string; manifestHash: string } {
  const temporary = resolve(paths.snapshots, `.${runId}.tmp-${process.pid}`);
  const target = resolve(paths.snapshots, runId);
  if (existsSync(target) || existsSync(temporary)) throw new Error(`training snapshot path already exists for ${runId}`);
  mkdirSync(temporary, { recursive: true, mode: 0o750 });
  const files: SnapshotManifest["files"] = [];
  copyJsonTree(resolve(paths.materialized, "ohlcv"), resolve(temporary, "ohlcv"), temporary, files);
  copyJsonTree(resolve(paths.materialized, "funding"), resolve(temporary, "funding"), temporary, files);
  copyJsonTree(resolve(paths.materialized, "raw", "bybit"), resolve(temporary, "raw", "bybit"), temporary, files);
  copyJsonTree(resolve(paths.materialized, "raw", "okx"), resolve(temporary, "raw", "okx"), temporary, files);
  copyJsonTree(resolve(paths.materialized, "raw", "coinbase"), resolve(temporary, "raw", "coinbase"), temporary, files);
  copyJsonTree(resolve(paths.materialized, "raw", "options"), resolve(temporary, "raw", "options"), temporary, files);
  if (!files.length) throw new Error("no materialized V4 source files available for training snapshot");
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    createdAt: continuationNowIso(nowMs),
    runId,
    files,
    sourceRoot: paths.materialized,
  };
  const manifestHash = sha256Bytes(stableJson(manifest));
  writeJsonAtomic(resolve(temporary, "snapshot.manifest.json"), { ...manifest, manifestHash });
  renameSync(temporary, target);
  return { root: target, manifestHash };
}

function appendBounded(current: string, chunk: string): string {
  const joined = current + chunk;
  return joined.length <= MAX_PROCESS_OUTPUT_BYTES ? joined : joined.slice(-MAX_PROCESS_OUTPUT_BYTES);
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    try {
      const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
      child.on("error", (error) => settle({ code: null, signal: null, stdout, stderr, error: error.message }));
      child.on("close", (code, signal) => settle({ code, signal, stdout, stderr, error: null }));
    } catch (error) {
      settle({ code: null, signal: null, stdout, stderr, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function writeProcessLog(runDirectory: string, name: string, result: ProcessResult): void {
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(resolve(runDirectory, `${name}.log`), `${result.stdout}\n--- STDERR ---\n${result.stderr}\n--- RESULT ---\n${JSON.stringify({ code: result.code, signal: result.signal, error: result.error })}\n`, "utf8");
}

function trainerFidelity(stdout: string): number | null {
  const matched = stdout.match(/export fidelity \(trajectory\)\s*=\s*([0-9.eE+-]+)/);
  const value = matched ? Number(matched[1]) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

type PythonParityPrediction = {
  pathProbabilities?: unknown;
  topPath?: unknown;
  topPathProbability?: unknown;
  persistenceScore?: unknown;
  reversalRisk?: unknown;
  earlyLean?: unknown;
  lateLean?: unknown;
  reversalAxis?: unknown;
  expectedReturn?: unknown;
  q10?: unknown;
  q50?: unknown;
  q90?: unknown;
  expectedVol?: unknown;
  confidence?: unknown;
  horizonAgreement?: unknown;
  horizons?: unknown;
};

function parityNumber(actual: number, expected: unknown): boolean {
  if (typeof expected !== "number" || !Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(actual), Math.abs(expected));
}

/**
 * Validates a deterministic Python reference fixture against the real TypeScript tree runtime.
 * This is deliberately a promotion gate, not a test-only helper: a tree-export/vector-order
 * regression must retain the old champion even if the trainer itself reports a good fit.
 */
export function verifyPythonRuntimeParity(artifactInput: unknown, fixturePath: string): boolean {
  try {
    validateTrajectoryArtifact(artifactInput);
    const artifact = artifactInput as DirectionTrajectoryArtifact;
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      schemaVersion?: unknown;
      artifactVersion?: unknown;
      featureNames?: unknown;
      samples?: unknown;
    };
    if (fixture.schemaVersion !== 1 || fixture.artifactVersion !== artifact.version ||
      !Array.isArray(fixture.featureNames) || !Array.isArray(fixture.samples) || fixture.samples.length < 1 || fixture.samples.length > 24 ||
      fixture.featureNames.join("\n") !== artifact.featureNames.join("\n")) return false;
    const trajectory = DirectionTrajectory.fromJson(artifact);
    for (const sample of fixture.samples) {
      const row = sample as { features?: unknown; prediction?: PythonParityPrediction };
      if (!row.features || typeof row.features !== "object" || !row.prediction) return false;
      const features = row.features as Record<string, unknown>;
      const served: Record<string, number | null> = {};
      for (const name of artifact.featureNames) {
        if (!(name in features)) return false;
        const value = features[name];
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) return false;
        served[name] = value as number | null;
      }
      const actual = trajectory.predict(served);
      const expected = row.prediction;
      const expectedPaths = expected.pathProbabilities as Record<string, unknown> | null;
      if (!expectedPaths || typeof expectedPaths !== "object" || expected.topPath !== actual.topPath) return false;
      for (const pathClass of artifact.pathClasses) {
        if (!parityNumber(actual.pathProbabilities[pathClass] ?? Number.NaN, expectedPaths[pathClass])) return false;
      }
      for (const [actualValue, expectedValue] of [
        [actual.topPathProbability, expected.topPathProbability],
        [actual.persistenceScore, expected.persistenceScore],
        [actual.reversalRisk, expected.reversalRisk],
        [actual.earlyLean, expected.earlyLean],
        [actual.lateLean, expected.lateLean],
        [actual.reversalAxis, expected.reversalAxis],
        [actual.expectedReturn, expected.expectedReturn],
        [actual.q10, expected.q10],
        [actual.q50, expected.q50],
        [actual.q90, expected.q90],
        [actual.expectedVol, expected.expectedVol],
        [actual.confidence, expected.confidence],
        [actual.horizonAgreement, expected.horizonAgreement],
      ] as Array<[number, unknown]>) {
        if (!parityNumber(actualValue, expectedValue)) return false;
      }
      if (!Array.isArray(expected.horizons) || expected.horizons.length !== actual.horizons.length) return false;
      for (let index = 0; index < actual.horizons.length; index += 1) {
        const actualHorizon = actual.horizons[index]!;
        const expectedHorizon = expected.horizons[index] as Record<string, unknown> | undefined;
        if (!expectedHorizon || expectedHorizon.horizon !== actualHorizon.horizon) return false;
        for (const key of ["pStrongDown", "pNeutral", "pStrongUp", "expectedReturn", "q10", "q50", "q90", "expectedVol"] as const) {
          if (!parityNumber(actualHorizon[key], expectedHorizon[key])) return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function dryLoadArtifact(artifactInput: unknown, rows: readonly ContinuationMatrixRow[]): boolean {
  try {
    validateTrajectoryArtifact(artifactInput);
    const artifact = artifactInput as DirectionTrajectoryArtifact;
    const trajectory = DirectionTrajectory.fromJson(artifact);
    const stride = Math.max(1, Math.floor(rows.length / 32));
    for (let index = 0; index < rows.length; index += stride) {
      const prediction = trajectory.predict(rows[index]!.features);
      const probabilities = Object.values(prediction.pathProbabilities);
      if (probabilities.length !== 8 || probabilities.some((value) => !Number.isFinite(value) || value < 0)) return false;
      if (Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 1e-6) return false;
      if (!Number.isFinite(prediction.expectedReturn) || !Number.isFinite(prediction.reversalRisk)) return false;
      for (const horizon of prediction.horizons) {
        const values = [horizon.pStrongDown, horizon.pNeutral, horizon.pStrongUp, horizon.expectedReturn, horizon.expectedVol];
        if (values.some((value) => !Number.isFinite(value))) return false;
        if (Math.abs(horizon.pStrongDown + horizon.pNeutral + horizon.pStrongUp - 1) > 1e-6) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function artifactFeatureHash(artifact: DirectionTrajectoryArtifact): string {
  return sha256Bytes(artifact.featureNames.join("\n"));
}

function matrixPITSafe(rows: readonly ContinuationMatrixRow[], labelCutoffMs: number): boolean {
  return rows.length > 0 && rows.every((row) =>
    row.maxFeatureSourceTimestampMs <= row.formationTimestampMs && row.formationTimestampMs <= labelCutoffMs,
  );
}

function recordStatusRun(status: ContinuationLifecycleStatus, run: ContinuationLifecycleRun, paths: ContinuationLifecyclePaths, nowMs: number): void {
  appendRunHistory(run, paths);
  status.lastRun = {
    runId: run.runId,
    completedAt: run.completedAt,
    verdict: run.verdict,
    reason: run.reason,
    challenger: run.challenger,
    gates: run.gates,
  };
  status.updatedAt = continuationNowIso(nowMs);
  writeLifecycleStatus(status, paths);
}

function standardStatus(
  status: ContinuationLifecycleStatus,
  paths: ContinuationLifecyclePaths,
  nowMs: number,
): { latestMature: number | null; current: ContinuationArtifactRecord | null } {
  const pointer = readChampionPointer(paths);
  status.collector = readCollectorHealth(paths);
  status.currentChampion = pointer?.current ?? null;
  status.rollbackTarget = pointer?.previous ?? null;
  const maturation = labelMaturationStatus(paths, nowMs);
  const latestMature = maturation.latestMatureFormationTimestampMs;
  writeLabelMaturationStatus(maturation, paths);
  status.latestMatureLabelTimestampMs = latestMature;
  const trainedAtMs = status.currentChampion ? Date.parse(status.currentChampion.trainedAt) : Number.NaN;
  status.nextRetrainEligibleAt = Number.isFinite(trainedAtMs)
    ? continuationNowIso(trainedAtMs + CONTINUATION_MIN_RETRAIN_INTERVAL_MS)
    : null;
  return { latestMature, current: status.currentChampion };
}

function runDirectory(paths: ContinuationLifecyclePaths, runId: string): string {
  const directory = resolve(paths.runs, runId);
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  return directory;
}

export type ContinuationLifecycleRunnerOptions = {
  paths?: ContinuationLifecyclePaths;
  nowMs?: () => number;
  apiRoot?: string;
  logger?: (event: string, details: Record<string, unknown>) => void;
};

export class ContinuationLifecycleRunner {
  readonly paths: ContinuationLifecyclePaths;
  private readonly now: () => number;
  private readonly apiRoot: string;
  private readonly logger: (event: string, details: Record<string, unknown>) => void;

  constructor(options: ContinuationLifecycleRunnerOptions = {}) {
    this.paths = ensureContinuationLifecycleDirectories(options.paths ?? continuationLifecyclePaths());
    this.now = options.nowMs ?? (() => Date.now());
    this.apiRoot = options.apiRoot ?? resolve(import.meta.dirname, "../..");
    this.logger = options.logger ?? ((event, details) => console.log(JSON.stringify({ event, ...details })));
  }

  private persist(status: ContinuationLifecycleStatus, nowMs: number): ContinuationLifecycleStatus {
    status.updatedAt = continuationNowIso(nowMs);
    writeLifecycleStatus(status, this.paths);
    return status;
  }

  private makeRun(mode: ContinuationLifecycleRun["mode"], nowMs: number, status: ContinuationLifecycleStatus): ContinuationLifecycleRun {
    const runId = `cont-${new Date(nowMs).toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${Math.random().toString(16).slice(2, 10)}`;
    return runSkeleton(runId, mode, nowMs, status.currentChampion?.artifactId ?? null, status.resource);
  }

  private async integrityCheck(status: ContinuationLifecycleStatus, mode: ContinuationLifecycleRun["mode"], nowMs: number): Promise<void> {
    const run = this.makeRun(mode, nowMs, status);
    const collectorGate = continuationCollectorIntegrityGate(status.collector, nowMs);
    const approved = readApprovedChampionArtifact(this.paths);
    const runtimeGate: ContinuationGateResult = {
      id: "RUNTIME_DRY_LOAD",
      passed: approved.artifact !== null,
      detail: approved.artifact ? "approved pointer artifact parses in TypeScript" : `approved champion unavailable: ${approved.reason ?? "unknown"}`,
    };
    run.gates = [collectorGate, runtimeGate];
    const passed = run.gates.every((gate) => gate.passed);
    recordStatusRun(status, finishRun(run, passed ? "SKIPPED" : "FAILED", passed ? "integrity_check_passed" : "integrity_check_failed", this.now()), this.paths, this.now());
  }

  private automaticRuntimeRecovery(status: ContinuationLifecycleStatus, nowMs: number): void {
    const approved = readApprovedChampionArtifact(this.paths);
    if (approved.artifact?.source !== "REGISTRY_PREVIOUS" || !approved.reason?.startsWith("current_unavailable:")) return;
    const rolled = rollbackChampion(`automatic_runtime_recovery:${approved.reason}`, this.paths, nowMs);
    if (rolled) {
      status.currentChampion = rolled.current;
      status.rollbackTarget = rolled.previous;
      this.logger("CONT_CHAMPION_ROLLBACK", { reason: approved.reason, artifactId: rolled.current.artifactId });
    }
  }

  private async trainIfEligible(status: ContinuationLifecycleStatus, mode: "SCHEDULED" | "MANUAL", nowMs: number): Promise<void> {
    const { latestMature, current } = standardStatus(status, this.paths, nowMs);
    const resource = status.resource ?? continuationResourceSnapshot(this.paths, nowMs);
    status.resource = resource;
    const collectorGate = continuationCollectorIntegrityGate(status.collector, nowMs);
    const approved = readApprovedChampionArtifact(this.paths);
    const run = this.makeRun(mode, nowMs, status);
    run.latestMatureFormationTimestampMs = latestMature;
    run.resourceSnapshot = resource;
    if (!resource.safe) {
      run.gates = [collectorGate];
      recordStatusRun(status, finishRun(run, "SKIPPED", `resource_guard:${resource.reason ?? "unsafe"}`, this.now()), this.paths, this.now());
      this.logger("CONT_TRAINING_SKIPPED_RESOURCE", { reason: resource.reason });
      return;
    }
    if (!collectorGate.passed || latestMature === null || !current || !approved.artifact) {
      run.gates = [collectorGate, {
        id: "RUNTIME_DRY_LOAD",
        passed: approved.artifact !== null,
        detail: approved.artifact ? "current champion readable" : `current champion unavailable: ${approved.reason ?? "unknown"}`,
      }];
      recordStatusRun(status, finishRun(run, "SKIPPED", "training_prerequisite_unavailable", this.now()), this.paths, this.now());
      return;
    }
    const trainedAt = Date.parse(current.trainedAt);
    const priorCutoff = current.labelCutoffMs ?? (Number.isFinite(trainedAt) ? trainedAt : null);
    const upperBoundNewRows = priorCutoff === null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((latestMature - priorCutoff) / HOUR_MS));
    const eligibleAt = Number.isFinite(trainedAt) ? trainedAt + CONTINUATION_MIN_RETRAIN_INTERVAL_MS : 0;
    if (nowMs < eligibleAt || upperBoundNewRows < CONTINUATION_REQUIRED_NEW_MATURE_ROWS) {
      status.newMatureRows = Number.isFinite(upperBoundNewRows) ? upperBoundNewRows : null;
      this.persist(status, nowMs);
      return;
    }

    status.trainingRunning = true;
    status.lastError = null;
    this.persist(status, nowMs);
    this.logger("CONT_TRAINING_STARTED", { runId: run.runId, latestMature, upperBoundNewRows });
    try {
      const labelCutoffMs = Math.min(latestMature, nowMs - 36 * HOUR_MS - LABEL_FINALIZATION_BUFFER_MS);
      run.trainingCutoffMs = labelCutoffMs;
      run.labelCutoffMs = labelCutoffMs;
      const snapshot = createTrainingSnapshot(this.paths, run.runId, nowMs);
      run.dataManifestHash = snapshot.manifestHash;
      const directory = runDirectory(this.paths, run.runId);
      const matrixPath = resolve(directory, "direction-training-matrix.csv");
      const tsx = resolve(this.apiRoot, "node_modules", ".bin", "tsx");
      const builder = resolve(this.apiRoot, "scripts", "build-direction-training-matrix-v3.ts");
      if (!existsSync(tsx) || !existsSync(builder)) throw new Error("lifecycle TypeScript matrix builder is unavailable in release");
      const build = await runProcess(tsx, [builder,
        resolve(snapshot.root, "ohlcv"), resolve(snapshot.root, "funding"), resolve(snapshot.root, "raw"), matrixPath,
        `--cutoff-ms=${labelCutoffMs}`,
      ], this.apiRoot, process.env);
      writeProcessLog(directory, "matrix-build", build);
      if (build.code !== 0 || !existsSync(matrixPath)) throw new Error(`matrix_build_failed:${build.error ?? build.stderr.slice(-500)}`);
      const manifest = JSON.parse(readFileSync(`${matrixPath}.manifest.json`, "utf8")) as {
        rowCount?: unknown; featureNames?: unknown; featureSchemaVersion?: unknown; featureListHash?: unknown;
        normalizationVersion?: unknown; sourceCoverageVersion?: unknown;
        maxFeatureSourceTimestampMs?: unknown; latestFormationTimestampMs?: unknown;
      };
      const rows = readContinuationMatrix(matrixPath);
      run.rowCount = rows.length;
      const matrixFeatureHash = sha256Bytes(Object.keys(rows[0]?.features ?? {}).sort().join("\n"));
      run.latestMatureFormationTimestampMs = rows.at(-1)?.formationTimestampMs ?? null;
      run.newMatureRows = priorCutoff === null ? rows.length : rows.filter((row) => row.formationTimestampMs > priorCutoff).length;
      status.trainingRows = rows.length;
      status.newMatureRows = run.newMatureRows;
      status.latestFeatureRefreshAt = continuationNowIso(this.now());
      const noLeakage = matrixPITSafe(rows, labelCutoffMs) &&
        manifest.maxFeatureSourceTimestampMs === rows.reduce((max, row) => Math.max(max, row.maxFeatureSourceTimestampMs), 0) &&
        typeof manifest.latestFormationTimestampMs === "number" && manifest.latestFormationTimestampMs <= labelCutoffMs;
      const matrixContract = manifest.featureSchemaVersion === CONTINUATION_FEATURE_SCHEMA_VERSION &&
        manifest.featureListHash === matrixFeatureHash &&
        manifest.normalizationVersion === CONTINUATION_NORMALIZATION_VERSION &&
        manifest.sourceCoverageVersion === CONTINUATION_SOURCE_COVERAGE_VERSION;
      const holdout = newestPurgedHoldout(rows);
      const sufficientSamples = rows.length >= MIN_TOTAL_MATURE_ROWS && holdout.length >= MIN_HOLDOUT_ROWS &&
        (run.newMatureRows ?? 0) >= CONTINUATION_REQUIRED_NEW_MATURE_ROWS;
      if (!sufficientSamples) {
        run.gates = [
          collectorGate,
          { id: "NO_LEAKAGE", passed: noLeakage, detail: noLeakage ? "matrix timestamps and label cutoff passed" : "matrix cutoff/PIT failed" },
          { id: "SUFFICIENT_SAMPLES", passed: false, detail: "mature matrix or chronological holdout/new-row floor not met", values: { rows: rows.length, holdoutRows: holdout.length, newRows: run.newMatureRows } },
        ];
        recordStatusRun(status, finishRun(run, "SKIPPED", "training_insufficient_mature_data", this.now()), this.paths, this.now());
        this.logger("CONT_TRAINING_SKIPPED_INSUFFICIENT_DATA", { runId: run.runId, rows: rows.length, holdout: holdout.length, newRows: run.newMatureRows });
        return;
      }

      const candidatePath = resolve(directory, "candidate-direction-model-v4.json");
      const parityPath = resolve(directory, "python-runtime-parity.json");
      const trainer = resolve(this.apiRoot, "scripts", "train-trajectory-v4.py");
      if (!existsSync(trainer)) throw new Error("lifecycle Python trainer is unavailable in release");
      const python = process.env.CONTINUATION_PYTHON_BIN?.trim() || "python3";
      const trainerEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OMP_NUM_THREADS: String(TRAINING_THREADS),
        OPENBLAS_NUM_THREADS: "1",
        MKL_NUM_THREADS: "1",
      };
      const trained = await runProcess(python, [trainer, matrixPath, candidatePath, `--parity-out=${parityPath}`], this.apiRoot, trainerEnv);
      writeProcessLog(directory, "trainer", trained);
      if (trained.code !== 0 || !existsSync(candidatePath)) throw new Error(`trainer_failed:${trained.error ?? trained.stderr.slice(-500)}`);
      const rawCandidate = JSON.parse(readFileSync(candidatePath, "utf8")) as unknown;
      validateTrajectoryArtifact(rawCandidate);
      const candidate = rawCandidate as DirectionTrajectoryArtifact;
      const pythonRuntimeParity = verifyPythonRuntimeParity(candidate, parityPath);
      const featureParity = candidate.schemaVersion === 4 &&
        matrixContract &&
        artifactFeatureHash(candidate) === current.featureListHash &&
        current.featureSchemaVersion === CONTINUATION_FEATURE_SCHEMA_VERSION &&
        candidate.horizons.join(",") === "6,12,24,36";
      run.featureListHash = artifactFeatureHash(candidate);
      const runtimeDryLoad = dryLoadArtifact(candidate, holdout);
      const championEvaluation = evaluateContinuationArtifact(approved.artifact.raw, holdout, {
        artifactId: approved.artifact.record.artifactId,
        artifactSha256: approved.artifact.record.artifactSha256,
      });
      const challengerEvaluation = evaluateContinuationArtifact(candidate, holdout);
      const challengerMetrics = compareContinuationArtifacts(championEvaluation, challengerEvaluation);
      const candidateRecord = registerImmutableArtifact({
        file: candidatePath,
        featureSchemaVersion: CONTINUATION_FEATURE_SCHEMA_VERSION,
        labelVersion: CONTINUATION_LABEL_VERSION,
        trainingCutoffMs: labelCutoffMs,
        labelCutoffMs,
        dataManifestHash: snapshot.manifestHash,
        runId: run.runId,
        metrics: challengerMetrics,
        nowMs: this.now(),
      }, this.paths);
      run.challenger = candidateRecord;
      run.gates = evaluateContinuationPromotionGates({
        dataIntegrity: collectorGate.passed,
        featureParity,
        noLeakage,
        sufficientSamples,
        runtimeDryLoad,
        trainerFidelity: trainerFidelity(trained.stdout),
        pythonRuntimeParity,
        champion: championEvaluation.metrics,
        challenger: challengerMetrics,
      });
      const pass = run.gates.every((gate) => gate.passed);
      if (pass && status.autoPromotionEnabled) {
        const pointer = promoteChampion({
          file: candidatePath,
          featureSchemaVersion: CONTINUATION_FEATURE_SCHEMA_VERSION,
          labelVersion: CONTINUATION_LABEL_VERSION,
          trainingCutoffMs: labelCutoffMs,
          labelCutoffMs,
          dataManifestHash: snapshot.manifestHash,
          runId: run.runId,
          metrics: challengerMetrics,
          nowMs: this.now(),
        }, `strict_gate_promoted:${run.runId}`, this.paths);
        const loaded = readApprovedChampionArtifact(this.paths);
        if (!loaded.artifact || loaded.artifact.source !== "REGISTRY_CURRENT" || loaded.artifact.record.artifactSha256 !== pointer.current.artifactSha256) {
          rollbackChampion(`promotion_dry_load_recovery:${run.runId}`, this.paths, this.now());
          throw new Error("promoted pointer failed post-write runtime validation and was rolled back");
        }
        status.currentChampion = pointer.current;
        status.rollbackTarget = pointer.previous;
        recordStatusRun(status, finishRun(run, "PROMOTED", "strict_all_gates_passed", this.now()), this.paths, this.now());
        this.logger("CONT_CHALLENGER_PROMOTED", { runId: run.runId, artifactId: pointer.current.artifactId });
      } else if (pass) {
        recordStatusRun(status, finishRun(run, "PROMOTION_CANDIDATE", "strict_gates_passed_auto_promotion_disabled", this.now()), this.paths, this.now());
      } else {
        const failed = run.gates.filter((gate) => !gate.passed).map((gate) => gate.id).join(",");
        recordStatusRun(status, finishRun(run, "REJECTED", `strict_gate_rejected:${failed}`, this.now()), this.paths, this.now());
        this.logger("CONT_CHALLENGER_REJECTED", { runId: run.runId, failedGates: failed, artifactId: candidateRecord.artifactId });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.lastError = message.slice(0, 1_000);
      recordStatusRun(status, finishRun(run, "FAILED", `training_failed:${message.slice(0, 500)}`, this.now()), this.paths, this.now());
      this.logger("CONT_TRAINING_FAILED", { runId: run.runId, error: message });
    } finally {
      status.trainingRunning = false;
      this.persist(status, this.now());
    }
  }

  /** One idempotent service tick. The separate script schedules it; API workers never call it. */
  async runOnce(): Promise<ContinuationLifecycleStatus> {
    const nowMs = this.now();
    const lock = acquireContinuationLock("training", this.paths, nowMs);
    if (!lock) {
      const status = currentStatus(this.paths, nowMs);
      status.lastError = "training_lock_held";
      return this.persist(status, nowMs);
    }
    try {
      const status = currentStatus(this.paths, nowMs);
      status.resource = continuationResourceSnapshot(this.paths, nowMs);
      standardStatus(status, this.paths, nowMs);
      this.automaticRuntimeRecovery(status, nowMs);
      let requestIntegrity = false;
      let requestTraining = false;
      for (const command of queuedLifecycleCommands(this.paths)) {
        if (command.command === "PAUSE_TRAINING") status.trainingPaused = true;
        else if (command.command === "RESUME_TRAINING") status.trainingPaused = false;
        else if (command.command === "DISABLE_AUTO_PROMOTION") status.autoPromotionEnabled = false;
        else if (command.command === "ENABLE_AUTO_PROMOTION") status.autoPromotionEnabled = true;
        else if (command.command === "INTEGRITY_CHECK") requestIntegrity = true;
        else if (command.command === "TRAIN_CHALLENGER") requestTraining = true;
        else if (command.command === "ROLLBACK_CHAMPION") {
          const run = this.makeRun("MANUAL", this.now(), status);
          try {
            const pointer = rollbackChampion(`operator_requested:${command.commandId}`, this.paths, this.now());
            if (!pointer) throw new Error("no previous approved champion available");
            status.currentChampion = pointer.current;
            status.rollbackTarget = pointer.previous;
            run.gates = [{ id: "RUNTIME_DRY_LOAD", passed: true, detail: "previous immutable artifact validated before rollback" }];
            recordStatusRun(status, finishRun(run, "ROLLED_BACK", "operator_requested_rollback", this.now()), this.paths, this.now());
            this.logger("CONT_CHAMPION_ROLLBACK", { commandId: command.commandId, artifactId: pointer.current.artifactId });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordStatusRun(status, finishRun(run, "FAILED", `rollback_failed:${message}`, this.now()), this.paths, this.now());
          }
        }
        acknowledgeLifecycleCommand(command.commandId, this.paths);
      }
      this.persist(status, this.now());
      if (requestIntegrity) await this.integrityCheck(status, "MANUAL", this.now());
      if (status.trainingPaused) return this.persist(status, this.now());
      await this.trainIfEligible(status, requestTraining ? "MANUAL" : "SCHEDULED", this.now());
      return this.persist(status, this.now());
    } finally {
      lock.release();
    }
  }
}

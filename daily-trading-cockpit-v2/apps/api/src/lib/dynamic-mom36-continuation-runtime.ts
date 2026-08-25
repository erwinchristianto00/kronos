/**
 * Frozen V4 trajectory adapter for Dynamic MOM36 v3.
 *
 * This is deliberately a read-only bridge.  It pins one verified artifact and delegates feature
 * extraction plus tree traversal to the exact V4 runtime; it never trains, tunes, persists model
 * state, or calls an order client.  Every incompatibility degrades to NO_EDGE upstream.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "@dtc/shared";
import { DirectionModelService } from "./direction-model-service.js";
import type { TrajectoryPrediction } from "./direction-model-runtime.js";
import type { Bar, MultiSourceInput } from "./direction-model-features.js";

export const DYNAMIC_MOM36_CONTINUATION_ARTIFACT_VERSION = "dm-36h-v4-20260824T153338Z" as const;
export const DYNAMIC_MOM36_CONTINUATION_ARTIFACT_SHA256 =
  "4b49fd53aeb271185cd79f652f98ea1b50eb1395771cc6309a7a5964c9563114" as const;
export const DYNAMIC_MOM36_CONTINUATION_ARTIFACT_ID =
  "dm-36h-v4-20260824T153338Z:sha256:4b49fd53aeb271185cd79f652f98ea1b50eb1395771cc6309a7a5964c9563114" as const;
export const DYNAMIC_MOM36_CONTINUATION_ARTIFACT_SCHEMA = 4 as const;
/** Identity of the feature extraction source transplanted from the V4 runtime commit. */
export const DYNAMIC_MOM36_CONTINUATION_FEATURE_VERSION = "direction-model-features-v4-975c996" as const;
/** The V4 artifact has exactly one documented calibration field. */
export const DYNAMIC_MOM36_CONTINUATION_CALIBRATION_VERSION = "temperature-1.1" as const;
export const DYNAMIC_MOM36_CONTINUATION_RUNTIME_FUNCTION =
  "DirectionModelService.evaluate -> DirectionTrajectory.predict" as const;
export const DYNAMIC_MOM36_CONTINUATION_MIN_CANDLES = 200 as const;

export type DynamicMom36ContinuationRuntimeResult = {
  available: boolean;
  artifactId: string;
  artifactSha256: string | null;
  schemaVersion: number | null;
  featureVersion: typeof DYNAMIC_MOM36_CONTINUATION_FEATURE_VERSION;
  calibrationVersion: typeof DYNAMIC_MOM36_CONTINUATION_CALIBRATION_VERSION;
  runtimeFunction: typeof DYNAMIC_MOM36_CONTINUATION_RUNTIME_FUNCTION;
  featureAtMs: number | null;
  fallbackReason: string | null;
  trajectory: TrajectoryPrediction | null;
  /** Small JSON-safe audit envelope; never includes the large model artifact. */
  rawOutput: Record<string, unknown>;
};

type ArtifactRead = {
  raw: unknown | null;
  sha256: string | null;
  reason: string | null;
  schemaVersion: number | null;
};

type MultiSourceRead = Omit<MultiSourceInput, "eth">;
let multiSourceCache: { root: string; atMs: number; value: MultiSourceRead } | null = null;

function configuredArtifactPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DYNAMIC_MOM36_CONTINUATION_ARTIFACT_PATH?.trim();
  // run-api.sh changes into apps/api before executing the server, so this is stable across both
  // production release roots and does not rely on the PM2 launcher cwd.
  return configured ? resolve(configured) : resolve(process.cwd(), "data/direction-model-v4.json");
}

function readPinnedArtifact(env: NodeJS.ProcessEnv = process.env): ArtifactRead {
  const path = configuredArtifactPath(env);
  try {
    if (!existsSync(path)) return { raw: null, sha256: null, reason: "artifact_missing", schemaVersion: null };
    const bytes = readFileSync(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== DYNAMIC_MOM36_CONTINUATION_ARTIFACT_SHA256) {
      return { raw: null, sha256, reason: "artifact_sha256_mismatch", schemaVersion: null };
    }
    const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const schemaVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : null;
    const version = typeof raw.version === "string" ? raw.version : null;
    const temperature = typeof raw.calibrationTemperature === "number" ? raw.calibrationTemperature : null;
    const horizons = Array.isArray(raw.horizons) ? raw.horizons : null;
    if (
      schemaVersion !== DYNAMIC_MOM36_CONTINUATION_ARTIFACT_SCHEMA ||
      version !== DYNAMIC_MOM36_CONTINUATION_ARTIFACT_VERSION ||
      temperature === null || Math.abs(temperature - 1.1) > 1e-9 ||
      !horizons || horizons.length !== 4 || ![6, 12, 24, 36].every((horizon) => horizons.includes(horizon))
    ) {
      return { raw: null, sha256, reason: "artifact_identity_or_schema_mismatch", schemaVersion };
    }
    return { raw, sha256, reason: null, schemaVersion };
  } catch (error) {
    return {
      raw: null,
      sha256: null,
      reason: `artifact_read_error:${error instanceof Error ? error.message : "unknown"}`,
      schemaVersion: null,
    };
  }
}

/**
 * This is the V4 runtime's own bounded raw-store reader, retained here rather than substituting
 * a new feature source.  Missing/corrupt raw inputs degrade the corresponding model features to
 * their documented missing route; they never alter MOM36 admission or cause an order failure.
 */
function readV4MultiSource(env: NodeJS.ProcessEnv = process.env): MultiSourceRead | null {
  const root = env.KRONOS_RAW_DIR ?? "/root/xsec-sim/raw";
  const now = Date.now();
  if (multiSourceCache && multiSourceCache.root === root && now - multiSourceCache.atMs < 3_600_000) {
    return multiSourceCache.value;
  }
  try {
    if (!existsSync(root)) return null;
    const venueBars = new Map<string, Map<string, Map<number, Bar>>>();
    for (const venue of ["bybit", "okx", "coinbase"]) {
      const directory = resolve(root, venue);
      if (!existsSync(directory)) continue;
      const bySymbol = new Map<string, Map<number, Bar>>();
      for (const file of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
        const rows = JSON.parse(readFileSync(resolve(directory, file), "utf8")) as unknown;
        if (!Array.isArray(rows)) continue;
        const bars = new Map<number, Bar>();
        for (const row of rows) {
          if (!Array.isArray(row)) continue;
          const [openTime, close, volume] = row;
          if (
            typeof openTime !== "number" || !Number.isFinite(openTime) ||
            typeof close !== "number" || !Number.isFinite(close) || close <= 0 ||
            typeof volume !== "number" || !Number.isFinite(volume)
          ) continue;
          bars.set(openTime, { openTime, open: close, high: close, low: close, close, volume });
        }
        if (bars.size) bySymbol.set(file.replace(".json", ""), bars);
      }
      if (bySymbol.size) venueBars.set(venue, bySymbol);
    }
    const ivSeries = new Map<string, Array<{ timeMs: number; value: number }>>();
    for (const currency of ["BTC", "ETH"]) {
      const file = resolve(root, "options", `DVOL_${currency}.json`);
      if (!existsSync(file)) continue;
      const rows = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(rows)) continue;
      const series = rows.flatMap((row) => {
        if (!Array.isArray(row)) return [];
        const [timeMs, value] = row;
        return typeof timeMs === "number" && Number.isFinite(timeMs) && typeof value === "number" && Number.isFinite(value)
          ? [{ timeMs, value }]
          : [];
      }).sort((a, b) => a.timeMs - b.timeMs);
      if (series.length) ivSeries.set(currency, series);
    }
    const value = {
      venueBars: venueBars.size ? venueBars : null,
      ivSeries: ivSeries.size ? ivSeries : null,
    };
    multiSourceCache = { root, atMs: now, value };
    return value;
  } catch {
    return null;
  }
}

function jsonSafe(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value: value ?? null };
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number") out[key] = Number.isFinite(item) ? item : String(item);
    else if (item && typeof item === "object" && !Array.isArray(item)) out[key] = jsonSafe(item);
    else if (Array.isArray(item)) out[key] = item.map((entry) =>
      typeof entry === "number" && !Number.isFinite(entry) ? String(entry) : entry,
    );
    else out[key] = item ?? null;
  }
  return out;
}

function validTrajectory(trajectory: TrajectoryPrediction | null): trajectory is TrajectoryPrediction {
  if (!trajectory || trajectory.schemaVersion !== DYNAMIC_MOM36_CONTINUATION_ARTIFACT_SCHEMA) return false;
  if (!Number.isFinite(trajectory.persistenceScore) || !Number.isFinite(trajectory.reversalRisk)) return false;
  if (trajectory.reversalRisk < 0 || trajectory.reversalRisk > 1) return false;
  if (!Array.isArray(trajectory.horizons) || trajectory.horizons.length !== 4) return false;
  const required = [6, 12, 24, 36];
  const seen = new Set<number>();
  for (const row of trajectory.horizons) {
    if (!required.includes(row.horizon) || seen.has(row.horizon)) return false;
    seen.add(row.horizon);
    for (const probability of [row.pStrongUp, row.pNeutral, row.pStrongDown]) {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) return false;
    }
  }
  if (typeof trajectory.topPath !== "string" || !trajectory.topPath) return false;
  const probabilities = trajectory.pathProbabilities;
  if (
    !probabilities ||
    Object.keys(probabilities).length === 0 ||
    !Object.hasOwn(probabilities, trajectory.topPath) ||
    Object.values(probabilities).some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) return false;
  return true;
}

/**
 * Evaluate one already-synchronous formation snapshot.  `nowMs` is supplied by the cycle so V4's
 * stale-bar guard uses the same information cutoff as MOM36 rather than a later wall-clock read.
 */
export function evaluateDynamicMom36Continuation(input: {
  candlesBySymbol: Record<string, readonly Candle[]>;
  btcCandles: readonly Candle[] | null;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
}): DynamicMom36ContinuationRuntimeResult {
  const env = input.env ?? process.env;
  const artifact = readPinnedArtifact(env);
  const base = {
    artifactId: DYNAMIC_MOM36_CONTINUATION_ARTIFACT_VERSION,
    artifactSha256: artifact.sha256,
    schemaVersion: artifact.schemaVersion,
    featureVersion: DYNAMIC_MOM36_CONTINUATION_FEATURE_VERSION,
    calibrationVersion: DYNAMIC_MOM36_CONTINUATION_CALIBRATION_VERSION,
    runtimeFunction: DYNAMIC_MOM36_CONTINUATION_RUNTIME_FUNCTION,
  } as const;
  if (!artifact.raw) {
    return {
      ...base,
      available: false,
      featureAtMs: null,
      fallbackReason: artifact.reason ?? "artifact_unavailable",
      trajectory: null,
      rawOutput: { artifactPath: configuredArtifactPath(env), artifactReason: artifact.reason ?? "artifact_unavailable" },
    };
  }
  // This environment is strategy-private.  The generic Direction Model allocation switch stays
  // untouched and is never consulted by v3; only its frozen V4 feature/runtime implementation is.
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...env,
    DIRECTION_MODEL_ENABLED: "1",
    DIRECTION_MODEL_ALLOCATION_ACTIVE: "0",
  };
  const service = new DirectionModelService({
    loadArtifact: () => artifact.raw,
    nowMs: () => input.nowMs,
    env: runtimeEnv,
    loadMultiSource: () => readV4MultiSource(env),
  });
  const snapshot = service.evaluate(input.candlesBySymbol, input.btcCandles);
  const trajectory = snapshot.trajectory;
  // V4 deliberately labels an unpromoted allocation as shadow-only even though it has already
  // produced a complete trajectory.  Dynamic MOM36 never consumes V4's allocation object, so that
  // one status is valid continuation evidence; every other fallback remains a strict NO_EDGE.
  const shadowOnlyTrajectory = snapshot.fallbackReason === "allocation_inactive_shadow_only";
  if ((snapshot.fallbackReason && !shadowOnlyTrajectory) || !validTrajectory(trajectory)) {
    return {
      ...base,
      available: false,
      featureAtMs: snapshot.featureAtMs,
      fallbackReason: snapshot.fallbackReason ?? "invalid_trajectory_output",
      trajectory: null,
      rawOutput: jsonSafe({
        featureAtMs: snapshot.featureAtMs,
        modelVersion: snapshot.modelVersion,
        schemaVersion: snapshot.schemaVersion,
        fallbackReason: snapshot.fallbackReason ?? "invalid_trajectory_output",
      }),
    };
  }
  return {
    ...base,
    available: true,
    featureAtMs: snapshot.featureAtMs,
    fallbackReason: null,
    trajectory,
    rawOutput: jsonSafe({
      featureAtMs: snapshot.featureAtMs,
      modelVersion: snapshot.modelVersion,
      schemaVersion: snapshot.schemaVersion,
      serviceFallbackReason: snapshot.fallbackReason,
      allocationActive: snapshot.allocationActive,
      trajectory,
    }),
  };
}

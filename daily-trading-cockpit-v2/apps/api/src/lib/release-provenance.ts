/**
 * Durable execution-release provenance.
 *
 * A strategy/policy fingerprint answers "what contract did this trade follow?".
 * This module answers the separate operator question "which deployed release
 * actually opened and settled it?".  The two must never be inferred from one
 * another after the fact.
 */
import { existsSync, readFileSync } from "node:fs";

export const KRONOS_RELEASE_MANIFEST_SCHEMA = "kronos-release-provenance/1" as const;
export const EXECUTION_RELEASE_PROVENANCE_SCHEMA = "kronos-execution-release-provenance/1" as const;

export type KronosReleaseEnvironment = "testnet" | "mainnet";

export interface KronosReleaseManifest {
  schemaVersion: typeof KRONOS_RELEASE_MANIFEST_SCHEMA;
  releaseId: string;
  label: string;
  environment: KronosReleaseEnvironment;
  /** The instant this exact release became the serving process, never its build time. */
  activatedAt: string;
}

/**
 * Immutable event-time stamp stored on a basket/trade.  `source` is part of
 * the contract: legacy records stay honestly unknown rather than being
 * backfilled from the currently-running release.
 */
export interface ExecutionReleaseProvenance {
  schemaVersion: typeof EXECUTION_RELEASE_PROVENANCE_SCHEMA;
  releaseId: string | null;
  label: string;
  activatedAt: string | null;
  capturedAt: string;
  source: "RUNTIME_MANIFEST" | "RUNTIME_UNVERIFIED" | "LEGACY_UNVERIFIED";
}

export interface ExecutionReleaseLifecycle {
  openedWith: ExecutionReleaseProvenance;
  closedWith: ExecutionReleaseProvenance | null;
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || value.length < 20 || value.length > 64) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function validReleaseToken(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 160) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

function runtimeEnvironment(env: NodeJS.ProcessEnv): KronosReleaseEnvironment | null {
  return env.LIVE_BINANCE_ENV === "testnet" || env.LIVE_BINANCE_ENV === "mainnet" ? env.LIVE_BINANCE_ENV : null;
}

function validManifest(value: unknown, env: NodeJS.ProcessEnv): KronosReleaseManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<KronosReleaseManifest>;
  const releaseId = validReleaseToken(candidate.releaseId);
  const label = validReleaseToken(candidate.label);
  const activatedAt = validIso(candidate.activatedAt);
  const environment = candidate.environment;
  const expectedEnvironment = runtimeEnvironment(env);
  if (
    candidate.schemaVersion !== KRONOS_RELEASE_MANIFEST_SCHEMA ||
    releaseId === null ||
    label === null ||
    activatedAt === null ||
    (environment !== "testnet" && environment !== "mainnet") ||
    expectedEnvironment === null ||
    environment !== expectedEnvironment
  ) {
    return null;
  }
  return {
    schemaVersion: KRONOS_RELEASE_MANIFEST_SCHEMA,
    releaseId,
    label,
    environment,
    activatedAt,
  };
}

export function readRuntimeReleaseManifest(env: NodeJS.ProcessEnv = process.env): KronosReleaseManifest | null {
  const file = env.KRONOS_RELEASE_PROVENANCE_FILE?.trim();
  if (!file || !existsSync(file)) return null;
  try {
    return validManifest(JSON.parse(readFileSync(file, "utf8")) as unknown, env);
  } catch {
    return null;
  }
}

/** Capture the release identity in force at one durable lifecycle boundary. */
export function captureRuntimeReleaseProvenance(
  capturedAt: string,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionReleaseProvenance {
  const safeCapturedAt = validIso(capturedAt) ?? new Date().toISOString();
  const manifest = readRuntimeReleaseManifest(env);
  if (manifest) {
    return {
      schemaVersion: EXECUTION_RELEASE_PROVENANCE_SCHEMA,
      releaseId: manifest.releaseId,
      label: manifest.label,
      activatedAt: manifest.activatedAt,
      capturedAt: safeCapturedAt,
      source: "RUNTIME_MANIFEST",
    };
  }
  return {
    schemaVersion: EXECUTION_RELEASE_PROVENANCE_SCHEMA,
    releaseId: null,
    label: "UNVERIFIED_RELEASE",
    activatedAt: null,
    capturedAt: safeCapturedAt,
    source: "RUNTIME_UNVERIFIED",
  };
}

/** The only valid representation for records created before provenance existed. */
export function legacyExecutionReleaseProvenance(capturedAt: string): ExecutionReleaseProvenance {
  return {
    schemaVersion: EXECUTION_RELEASE_PROVENANCE_SCHEMA,
    releaseId: null,
    label: "LEGACY",
    activatedAt: null,
    capturedAt: validIso(capturedAt) ?? new Date().toISOString(),
    source: "LEGACY_UNVERIFIED",
  };
}

function isReleaseProvenance(value: unknown): value is ExecutionReleaseProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ExecutionReleaseProvenance>;
  return (
    candidate.schemaVersion === EXECUTION_RELEASE_PROVENANCE_SCHEMA &&
    typeof candidate.label === "string" &&
    validIso(candidate.capturedAt) !== null &&
    (candidate.activatedAt === null || validIso(candidate.activatedAt) !== null) &&
    (candidate.releaseId === null || validReleaseToken(candidate.releaseId) !== null) &&
    (candidate.source === "RUNTIME_MANIFEST" || candidate.source === "RUNTIME_UNVERIFIED" || candidate.source === "LEGACY_UNVERIFIED")
  );
}

/**
 * Normalizes an optional persisted lifecycle without inventing history.  It is
 * used both at settlement and report projection, so old stored rows always
 * render as LEGACY consistently.
 */
export function normalizeExecutionReleaseLifecycle(
  value: unknown,
  openedAt: string,
): ExecutionReleaseLifecycle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { openedWith: legacyExecutionReleaseProvenance(openedAt), closedWith: null };
  }
  const candidate = value as Partial<ExecutionReleaseLifecycle>;
  return {
    openedWith: isReleaseProvenance(candidate.openedWith)
      ? candidate.openedWith
      : legacyExecutionReleaseProvenance(openedAt),
    closedWith: isReleaseProvenance(candidate.closedWith) ? candidate.closedWith : null,
  };
}

export function captureOpenedExecutionReleaseLifecycle(
  openedAt: string,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionReleaseLifecycle {
  return { openedWith: captureRuntimeReleaseProvenance(openedAt, env), closedWith: null };
}

/**
 * First terminal release wins.  A retry/reconciliation after the fill must not
 * rewrite the release that actually performed the close.
 */
export function stampClosedExecutionReleaseLifecycle(
  value: unknown,
  openedAt: string,
  closedAt: string,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionReleaseLifecycle {
  const normalized = normalizeExecutionReleaseLifecycle(value, openedAt);
  if (normalized.closedWith !== null) return normalized;
  return {
    ...normalized,
    closedWith: captureRuntimeReleaseProvenance(closedAt, env),
  };
}

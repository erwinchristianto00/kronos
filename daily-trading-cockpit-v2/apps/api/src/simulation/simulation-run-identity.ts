/**
 * Deterministic run identity (Market Digital Twin, Phase-1 foundation). `runId` is a pure function of the
 * NORMALIZED configuration, seed, versions, and source/calibration CHECKSUMS — so the same inputs always produce the
 * same runId, and PROCESSING (wall-clock) start time never affects it. Reuses the repo's pure `stableHash`
 * (replay-provenance) so simulation hashing matches the rest of the pipeline (SAFE_REUSE — pure, no side effects).
 */
import { stableHash } from "../lib/replay-provenance.js";
import type { SimulationProvenance } from "./simulation-provenance.js";
import { SIMULATOR_VERSION, SCENARIO_SCHEMA_VERSION, FEATURE_SCHEMA_VERSION } from "./simulation-types.js";

export interface SimulationRunIdentity {
  runId: string;
  seed: number;
  provenance: SimulationProvenance;
  simulatorVersion: string;
  scenarioSchemaVersion: string;
  featureSchemaVersion: string;
  sourceChecksums: string[];
  configurationHash: string;
  startedAtProcessingMs: number;
}

export interface RunIdentityInput {
  seed: number;
  provenance: SimulationProvenance;
  /** Any JSON-serializable run configuration; it is normalized (recursively key-sorted) before hashing. */
  configuration: unknown;
  /** Checksums of the immutable source data + calibration artifacts this run depends on. */
  sourceChecksums: string[];
  /** Wall-clock start (processing time). Recorded but DELIBERATELY excluded from runId. Pass it explicitly — the
   *  simulator never calls Date.now() itself. */
  startedAtProcessingMs: number;
  simulatorVersion?: string;
  scenarioSchemaVersion?: string;
  featureSchemaVersion?: string;
}

/** Recursively sort object keys so logically-identical configs hash identically regardless of key order. */
export function normalizeConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeConfig);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = normalizeConfig((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function buildRunIdentity(input: RunIdentityInput): SimulationRunIdentity {
  const simulatorVersion = input.simulatorVersion ?? SIMULATOR_VERSION;
  const scenarioSchemaVersion = input.scenarioSchemaVersion ?? SCENARIO_SCHEMA_VERSION;
  const featureSchemaVersion = input.featureSchemaVersion ?? FEATURE_SCHEMA_VERSION;
  const configurationHash = stableHash(normalizeConfig(input.configuration));
  const sourceChecksums = input.sourceChecksums.slice().sort(); // order-independent
  // runId excludes startedAtProcessingMs by construction (it is not in this tuple).
  const runId = stableHash([
    "sim-run-v1",
    input.seed,
    input.provenance,
    simulatorVersion,
    scenarioSchemaVersion,
    featureSchemaVersion,
    configurationHash,
    sourceChecksums,
  ]).slice(0, 32);
  return {
    runId,
    seed: input.seed,
    provenance: input.provenance,
    simulatorVersion,
    scenarioSchemaVersion,
    featureSchemaVersion,
    sourceChecksums,
    configurationHash,
    startedAtProcessingMs: input.startedAtProcessingMs,
  };
}

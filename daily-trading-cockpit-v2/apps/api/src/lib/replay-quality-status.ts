/**
 * Historical replay — row quality classification (Phase 8). Every reconstructed observation gets EXACTLY ONE
 * status, decided in strict precedence so the reconciliation adds up and the categories never collapse into a
 * single "trainable" flag. GOLD vs SILVER is PURPOSE-AWARE: a candle-only (Tier A) row is GOLD for Market
 * State / Direction but only SILVER for Entry/Exit (it cannot back an execution claim). Pure.
 */
import type { DataTier } from "./replay-data-tiers.js";

export type ReplayRowStatus =
  | "GOLD"
  | "SILVER_NO_MICROSTRUCTURE"
  | "REPLAY_ONLY"
  | "MISSING_FEATURES"
  | "LABEL_UNSAFE"
  | "TIMESTAMP_UNSAFE"
  | "SCHEMA_MISMATCH"
  | "CONFIG_UNVERSIONED"
  | "DATA_GAP"
  | "EXECUTION_UNCALIBRATED";

export type ReplayPurpose = "MarketState" | "Direction" | "Entry" | "Exit" | "CORTEX";

export interface ReplayQualityInput {
  purpose: ReplayPurpose;
  /** No look-ahead: every source timestamp ≤ decisionAt. False ⇒ the row is causally poisoned. */
  timestampsCausal: boolean;
  /** Feature schema of the owning decision matches the current schema. */
  schemaMatch: boolean;
  /** The config that produced the row is version-pinned (configHash known). */
  configVersioned: boolean;
  /** A critical market-data gap overlaps the row's window. */
  dataGap: boolean;
  /** The outcome label was computed safely (finite netR, valid risk denom). */
  labelSafe: boolean;
  /** All features REQUIRED for this purpose, and supported by the row's tier, are present. */
  requiredFeaturesPresent: boolean;
  dataTier: DataTier;
  /** For Entry/Exit execution claims: is the execution emulator calibrated for this context? */
  executionCalibrated: boolean;
  /** False ⇒ diagnostics-only (assumed denominators, replay-only source) — never a model-fit row. */
  modelFitEligible: boolean;
}

export interface ReplayQualityResult {
  status: ReplayRowStatus;
  reason: string;
}

const NEEDS_MICROSTRUCTURE: ReplayPurpose[] = ["Entry", "Exit"];

export function classifyReplayRow(i: ReplayQualityInput): ReplayQualityResult {
  // Fatal integrity failures first — these can never be any kind of usable row.
  if (!i.timestampsCausal) return { status: "TIMESTAMP_UNSAFE", reason: "a source timestamp is after the decision (look-ahead)" };
  if (!i.schemaMatch) return { status: "SCHEMA_MISMATCH", reason: "owning decision is at a different feature schema" };
  if (!i.configVersioned) return { status: "CONFIG_UNVERSIONED", reason: "config not version-pinned — replay identity unknown" };
  if (i.dataGap) return { status: "DATA_GAP", reason: "critical market-data gap overlaps the row window" };
  if (!i.labelSafe) return { status: "LABEL_UNSAFE", reason: "outcome label rejected (non-finite netR / bad risk denom)" };
  if (!i.requiredFeaturesPresent) return { status: "MISSING_FEATURES", reason: "a tier-supported required feature is absent" };
  // Sound but explicitly diagnostics-only (e.g. assumed risk denominator / replay-only source).
  if (!i.modelFitEligible) return { status: "REPLAY_ONLY", reason: "sound but withheld from model fitting" };
  // Purpose-aware GOLD vs SILVER: Entry/Exit need microstructure + a calibrated emulator to make execution claims.
  if (NEEDS_MICROSTRUCTURE.includes(i.purpose)) {
    if (i.dataTier !== "C_L2") return { status: "SILVER_NO_MICROSTRUCTURE", reason: `Tier ${i.dataTier} cannot back an ${i.purpose} execution claim (no microstructure)` };
    if (!i.executionCalibrated) return { status: "EXECUTION_UNCALIBRATED", reason: "microstructure present but the execution emulator is uncalibrated for this context" };
  }
  return { status: "GOLD", reason: "causal + versioned + safe label + tier-supported features + no gap" };
}

/** Tally statuses into a reconciliation-friendly record. */
export function tallyReplayStatuses(statuses: Iterable<ReplayRowStatus>): Record<ReplayRowStatus, number> {
  const t: Record<ReplayRowStatus, number> = {
    GOLD: 0, SILVER_NO_MICROSTRUCTURE: 0, REPLAY_ONLY: 0, MISSING_FEATURES: 0, LABEL_UNSAFE: 0,
    TIMESTAMP_UNSAFE: 0, SCHEMA_MISMATCH: 0, CONFIG_UNVERSIONED: 0, DATA_GAP: 0, EXECUTION_UNCALIBRATED: 0,
  };
  for (const s of statuses) t[s] += 1;
  return t;
}

/** Which statuses may feed which purpose's MODEL FIT (GOLD always; SILVER only for state/direction). */
export function statusUsableForFit(status: ReplayRowStatus, purpose: ReplayPurpose): boolean {
  if (status === "GOLD") return true;
  if (status === "SILVER_NO_MICROSTRUCTURE") return purpose === "MarketState" || purpose === "Direction" || purpose === "CORTEX";
  return false;
}

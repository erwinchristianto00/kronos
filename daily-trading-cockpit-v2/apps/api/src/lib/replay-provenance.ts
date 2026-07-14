/**
 * Historical replay — provenance + version contract (Phase 1). The core safety primitive of the whole replay
 * pipeline: **reconstructed historical evidence must never be mistaken for, or silently merged with, observed
 * live evidence.** Every run carries a `ReplayProvenance`; every decision/outcome row carries a `RowProvenance`
 * that pins the code/config/schema/data version + the evidence class + the causal timestamps. A merge across
 * evidence classes is only allowed through explicit, provenance-aware logic (`partitionByProvenance` /
 * `assertSingleEvidenceClass`) — never by accident.
 *
 * This module is PURE (hashing only) and OFFLINE: it imports no executor, references no live beta, and cannot
 * change any trading behaviour. It only describes and guards data lineage.
 */
import { createHash } from "node:crypto";

/** Run-level mode — what was executed against what. */
export type ReplayMode =
  | "CURRENT_CODE_HISTORICAL_MARKET" // current engine vs past market data
  | "PINNED_CODE_HISTORICAL_MARKET" // a pinned historical commit/config vs past market data (isolated)
  | "OBSERVED_LIVE_SHADOW" // the real shadow layer's observed decisions (not a replay)
  | "LIVE_EXECUTION"; // real orders — NEVER produced by this pipeline

/** Row-level evidence class — the strict separation the spec mandates. */
export type EvidenceClass =
  | "RECONSTRUCTED_HISTORICAL" // rebuilt by replaying code over historical market data
  | "OBSERVED_LIVE_SHADOW" // recorded from the live shadow layer (report-only, but real-time observed)
  | "SIMULATED_EXECUTION" // fills produced by the execution emulator
  | "ACTUAL_LIVE_EXECUTION"; // real exchange fills (calibration input ONLY, never directional-alpha training)

export interface ReplayProvenance {
  replayRunId: string;
  codeCommitHash: string;
  codeBuildHash: string;
  containerImageDigest: string | null;
  configHash: string;
  featureSchemaVersion: string;
  modelSchemaVersion: string;
  laneRosterVersion: string;
  marketDataSource: string;
  marketDataVersion: string;
  marketDataManifestHash: string;
  replayMode: ReplayMode;
  startedAtMs: number;
  completedAtMs: number | null;
}

/** The provenance stamped on EVERY decision/outcome row so a reconstructed row can never masquerade as live. */
export interface RowProvenance {
  replayRunId: string;
  codeCommitHash: string;
  configHash: string;
  featureSchemaVersion: string;
  marketDataVersion: string;
  evidenceClass: EvidenceClass;
  /** The instant the decision was made / the row is as-of (the causal boundary). */
  asOfMs: number;
  /** The source timestamps that fed the row (oldest/newest) — for the snapshot-skew audit. */
  sourceTimestampsMs: number[];
}

/** Canonical, stable-key JSON hash — the basis for configHash / marketDataManifestHash. */
export function stableHash(obj: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canon((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(obj))).digest("hex");
}

export interface RowProvenanceInput {
  provenance: ReplayProvenance;
  evidenceClass: EvidenceClass;
  asOfMs: number;
  sourceTimestampsMs: number[];
}

/** Stamp a raw row with its provenance. The evidence class is REQUIRED and explicit at every call-site. */
export function stampRow<T extends Record<string, unknown>>(row: T, i: RowProvenanceInput): T & { _provenance: RowProvenance } {
  return {
    ...row,
    _provenance: {
      replayRunId: i.provenance.replayRunId,
      codeCommitHash: i.provenance.codeCommitHash,
      configHash: i.provenance.configHash,
      featureSchemaVersion: i.provenance.featureSchemaVersion,
      marketDataVersion: i.provenance.marketDataVersion,
      evidenceClass: i.evidenceClass,
      asOfMs: i.asOfMs,
      sourceTimestampsMs: i.sourceTimestampsMs,
    },
  };
}

export interface Provenanced {
  _provenance: RowProvenance;
}

/** Partition rows by evidence class — the ONLY safe way to co-process reconstructed + observed data. */
export function partitionByProvenance<T extends Provenanced>(rows: T[]): Record<EvidenceClass, T[]> {
  const out: Record<EvidenceClass, T[]> = {
    RECONSTRUCTED_HISTORICAL: [], OBSERVED_LIVE_SHADOW: [], SIMULATED_EXECUTION: [], ACTUAL_LIVE_EXECUTION: [],
  };
  for (const r of rows) out[r._provenance.evidenceClass].push(r);
  return out;
}

/** Assert a collection is a SINGLE evidence class (also rejects a run-id mix). Throws otherwise — this is the
 *  guard that a caller must pass before treating a set of rows as one homogeneous dataset. */
export function assertSingleEvidenceClass<T extends Provenanced>(rows: T[]): EvidenceClass | null {
  if (rows.length === 0) return null;
  const cls = rows[0]!._provenance.evidenceClass;
  for (const r of rows) {
    if (r._provenance.evidenceClass !== cls) {
      throw new Error(`provenance mix rejected: ${cls} + ${r._provenance.evidenceClass} in one collection — partition first`);
    }
  }
  return cls;
}

/**
 * Learning-source policy (spec Phase 6): keep signal-outcome learning separate from execution calibration.
 * ACTUAL_LIVE_EXECUTION fills may calibrate the execution emulator, but MUST NOT train directional alpha.
 */
export function evidenceAllowedFor(purpose: "DIRECTIONAL_ALPHA" | "EXECUTION_CALIBRATION", cls: EvidenceClass): boolean {
  if (purpose === "EXECUTION_CALIBRATION") {
    return cls === "ACTUAL_LIVE_EXECUTION" || cls === "OBSERVED_LIVE_SHADOW"; // observed/actual fills calibrate execution
  }
  // DIRECTIONAL_ALPHA: reconstructed history + observed shadow signal outcomes; NEVER actual-live fills.
  return cls === "RECONSTRUCTED_HISTORICAL" || cls === "OBSERVED_LIVE_SHADOW";
}

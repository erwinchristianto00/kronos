/** Dependency-free authority boundary shared by CORTEX and Four-Brain. */
export const AUTHORITY_POLICY_VERSION = "authority-contract/1" as const;
/** Deliberately compile-time false; env alone can never make reviewer output a CORTEX feature. */
export const CORTEX_ALLOW_FOUR_BRAIN_FEATURES = false as const;

export type AllocationSource = "UNAVAILABLE" | "STATIC_BASELINE" | "CORTEX_SHADOW" | "CORTEX_PROMOTED";

/** Read-only funding telemetry. It must never become direction, entry, or risk input. */
export interface AllocationContext {
  source: AllocationSource;
  snapshotId: string | null;
  staticWeightPct: number | null;
  evaluatedWeightPct: number | null;
  appliedWeightPct: number | null;
  beta: number;
  capturedAtMs: number | null;
  policyVersion: string | null;
}

export interface MarketContextLineage {
  marketContextSnapshotId: string | null;
  asOfMs: number;
  sourceCutoffMs: number | null;
  decisionPipelinePolicyVersion: string | null;
}

/** Missing lineage is explicit. Consumers must not substitute a newer snapshot. */
export function unavailableMarketContext(asOfMs: number): MarketContextLineage {
  return {
    marketContextSnapshotId: null,
    asOfMs,
    sourceCutoffMs: null,
    decisionPipelinePolicyVersion: null,
  };
}

export function staticAllocationContext(staticWeightPct: number | null): AllocationContext {
  const weight = typeof staticWeightPct === "number" && Number.isFinite(staticWeightPct) ? staticWeightPct : null;
  return {
    source: weight === null ? "UNAVAILABLE" : "STATIC_BASELINE",
    snapshotId: null,
    staticWeightPct: weight,
    evaluatedWeightPct: weight,
    appliedWeightPct: weight,
    beta: 0,
    capturedAtMs: null,
    policyVersion: AUTHORITY_POLICY_VERSION,
  };
}

export function validAllocationContext(value: AllocationContext): boolean {
  if (!Number.isFinite(value.beta) || value.beta < 0) return false;
  if (value.source === "CORTEX_PROMOTED") return value.beta > 0 && value.snapshotId !== null && value.appliedWeightPct !== null;
  if (value.source === "STATIC_BASELINE") {
    return value.beta === 0 && value.snapshotId === null && value.appliedWeightPct === value.staticWeightPct;
  }
  if (value.source === "CORTEX_SHADOW") {
    return value.beta === 0 && value.snapshotId !== null && value.appliedWeightPct === value.staticWeightPct;
  }
  return value.source === "UNAVAILABLE" && value.snapshotId === null && value.beta === 0;
}

export function validMarketContextLineage(value: MarketContextLineage): boolean {
  if (!Number.isFinite(value.asOfMs)) return false;
  if (value.marketContextSnapshotId === null) return value.sourceCutoffMs === null && value.decisionPipelinePolicyVersion === null;
  return typeof value.decisionPipelinePolicyVersion === "string"
    && value.decisionPipelinePolicyVersion.length > 0
    && typeof value.sourceCutoffMs === "number"
    && Number.isFinite(value.sourceCutoffMs)
    && value.sourceCutoffMs <= value.asOfMs;
}

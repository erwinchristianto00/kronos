/**
 * Process-local, report-only counters for the exact CORTEX production chain.
 * They deliberately have no persistence or control-plane consumers: a missing
 * hand-off must never change execution, allocation, or admission behaviour.
 */
export type CortexProductionChainDiagnosticCode =
  | "CORTEX_SNAPSHOT_SCAN_MISSING"
  | "CORTEX_PAPER_LANE_UNMAPPED"
  | "CORTEX_CANONICAL_LANE_MISMATCH"
  | "CORTEX_ALLOCATION_BRIDGE_MISSING"
  | "CORTEX_EXECUTIVE_ATTACHMENT_REJECTED"
  | "CORTEX_SCAN_PUBLICATION_CONFLICT"
  | "CORTEX_STRATEGY_MAPPING_MISMATCH"
  | "CORTEX_CANDIDATE_OWNERSHIP_MISSING"
  | "CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS"
  | "CORTEX_TIER1_RESOLVED"
  | "CORTEX_LEARNER_ELIGIBLE"
  | "CORTEX_CHAIN_ELIGIBLE_CANDIDATE"
  | "GENERIC_FOUR_BRAIN_DIAGNOSTIC_CANDIDATE";

const codes: readonly CortexProductionChainDiagnosticCode[] = [
  "CORTEX_SNAPSHOT_SCAN_MISSING",
  "CORTEX_PAPER_LANE_UNMAPPED",
  "CORTEX_CANONICAL_LANE_MISMATCH",
  "CORTEX_ALLOCATION_BRIDGE_MISSING",
  "CORTEX_EXECUTIVE_ATTACHMENT_REJECTED",
  "CORTEX_SCAN_PUBLICATION_CONFLICT",
  "CORTEX_STRATEGY_MAPPING_MISMATCH",
  "CORTEX_CANDIDATE_OWNERSHIP_MISSING",
  "CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS",
  "CORTEX_TIER1_RESOLVED",
  "CORTEX_LEARNER_ELIGIBLE",
  "CORTEX_CHAIN_ELIGIBLE_CANDIDATE",
  "GENERIC_FOUR_BRAIN_DIAGNOSTIC_CANDIDATE",
] as const;

const counters: Record<CortexProductionChainDiagnosticCode, number> = Object.fromEntries(
  codes.map((code) => [code, 0]),
) as Record<CortexProductionChainDiagnosticCode, number>;

export function recordCortexProductionChainDiagnostic(code: CortexProductionChainDiagnosticCode): void {
  counters[code] += 1;
}

export function cortexProductionChainDiagnostics(): Readonly<Record<CortexProductionChainDiagnosticCode, number>> {
  return { ...counters };
}

export function _resetCortexProductionChainDiagnosticsForTests(): void {
  for (const code of codes) counters[code] = 0;
}

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
  | "GENERIC_FOUR_BRAIN_DIAGNOSTIC_CANDIDATE"
  // Point 2 (late-binding executive review attach) — one code per distinct non-ATTACHED late-binding
  // outcome, so app.ts's onExecutiveDecision never discards attachExecutiveReviewToExactPaperOrder's
  // result silently. Report-only, like every other code in this file.
  | "CORTEX_LATE_BINDING_INTENT_TERMINAL"
  | "CORTEX_LATE_BINDING_LINEAGE_MISSING"
  | "CORTEX_LATE_BINDING_LINEAGE_CONFLICT"
  | "CORTEX_LATE_BINDING_REVIEW_CONFLICT"
  | "CORTEX_LATE_BINDING_INDEX_MISS";

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
  "CORTEX_LATE_BINDING_INTENT_TERMINAL",
  "CORTEX_LATE_BINDING_LINEAGE_MISSING",
  "CORTEX_LATE_BINDING_LINEAGE_CONFLICT",
  "CORTEX_LATE_BINDING_REVIEW_CONFLICT",
  "CORTEX_LATE_BINDING_INDEX_MISS",
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

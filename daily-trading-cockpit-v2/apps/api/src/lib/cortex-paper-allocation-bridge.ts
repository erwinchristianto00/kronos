import type { AllocationContext } from "./authority-contract.js";
import type { PaperOrder } from "./paper-execution-router.js";
import { paperOrderOwnershipKey } from "./paper-order-ownership-index.js";
import { recordCortexProductionChainDiagnostic } from "./cortex-production-chain-diagnostics.js";

/**
 * Candidate-owned bridge between a persisted paper admission and Four-Brain.
 *
 * Looks the candidate up by THE canonical persisted ownership key —
 * (sourceObservationId, selectedLaneId, direction), see paper-order-ownership-index.ts — in a
 * `ownershipIndex` the caller builds once per tick (`buildPaperOrderOwnershipIndex`), instead of
 * scanning the full order book for every candidate. The lookup itself is O(1); the only scan left
 * here is over `owned`, the (at most a handful of dedupe-collision) orders sharing that one
 * ownership key, so the bridge is O(orders + candidates) overall, not O(orders * candidates).
 *
 * Fails closed in both directions the index can miss — zero owners, or more than one
 * CORTEX-linkable owner — recording `CORTEX_ALLOCATION_BRIDGE_MISSING` (the same diagnostic code
 * the pre-index linear-scan version used) either way and leaving `base` untouched, so the caller
 * falls back to the incumbent, non-CORTEX allocation context rather than guessing. Splitting this
 * into separate missing-vs-ambiguous diagnostic codes is point 11's job (a distinct, purely
 * additive change to cortex-production-chain-diagnostics.ts) — not duplicated here to avoid
 * introducing new diagnostic codes outside that change.
 */
export function allocationContextWithExactCortexPaperBridge(input: {
  base: AllocationContext;
  candidate: { signalId: string | null; direction: "LONG" | "SHORT" } | undefined;
  laneId: string;
  ownershipIndex: ReadonlyMap<string, readonly PaperOrder[]>;
}): AllocationContext {
  if (!input.candidate?.signalId) return input.base;
  const key = paperOrderOwnershipKey(input.candidate.signalId, input.laneId, input.candidate.direction);
  const owned = input.ownershipIndex.get(key) ?? [];
  // Point 11: report-only visibility into the ownership-index lookup itself, split from the
  // CORTEX-link-specific `CORTEX_ALLOCATION_BRIDGE_MISSING` recorded below — never read anywhere
  // that influences selection, admission, allocation, or execution.
  if (owned.length === 0) recordCortexProductionChainDiagnostic("CORTEX_CANDIDATE_OWNERSHIP_MISSING");
  else if (owned.length > 1) recordCortexProductionChainDiagnostic("CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS");
  // Exact CORTEX-link fields — distinct from ownership itself. An order can be the exact owner of
  // this candidate (matched above) yet still structurally carry no CORTEX link (e.g. a
  // VARIANT_MATRIX_OBSERVATION-sourced order, which never gets one) — that is a truthful "no
  // link", not an ownership failure, so it is checked here rather than folded into the index.
  const matches = owned.filter((order) => {
    const identity = order.causalIdentity;
    const snapshot = order.cortexDecisionSnapshot;
    return identity?.allocationSnapshotId != null && identity.canonicalCortexLaneId != null && snapshot != null &&
      snapshot.scanBatchId === order.scanBatchId && snapshot.sourceScanBatchId === order.scanBatchId &&
      snapshot.decisionId === identity.cortexDecisionId &&
      snapshot.allocationSnapshotId === identity.allocationSnapshotId &&
      snapshot.laneId === identity.canonicalCortexLaneId &&
      order.canonicalCortexLaneId === identity.canonicalCortexLaneId;
  });
  if (matches.length !== 1) {
    recordCortexProductionChainDiagnostic("CORTEX_ALLOCATION_BRIDGE_MISSING");
    return input.base;
  }
  return { ...input.base, cortexAllocationSnapshotId: matches[0]!.causalIdentity!.allocationSnapshotId };
}

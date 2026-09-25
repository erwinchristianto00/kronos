import type { AllocationContext } from "./authority-contract.js";
import type { PaperOrder } from "./paper-execution-router.js";
import { paperOrderOwnershipKey } from "./paper-order-ownership-index.js";
import { recordCortexProductionChainDiagnostic } from "./cortex-production-chain-diagnostics.js";

/**
 * Discriminated bridge result. `context` is present only on the two statuses that are safe to hand
 * an incumbent, non-CORTEX-tagged AllocationContext to the caller (NO_CANDIDATE — there was never a
 * candidate to look up; NO_CORTEX_LINK — a single exact owner exists but structurally carries no
 * CORTEX link, e.g. a VARIANT_MATRIX_OBSERVATION order) and on BRIDGED (the real CORTEX-linked
 * context). OWNERSHIP_MISSING/OWNERSHIP_AMBIGUOUS carry no `context` at all — the caller must not
 * synthesize one; see allocationContextWithExactCortexPaperBridge's own doc comment for why.
 */
export type CortexPaperBridgeResult =
  | { status: "BRIDGED"; context: AllocationContext }
  | { status: "NO_CANDIDATE"; context: AllocationContext }
  | { status: "NO_CORTEX_LINK"; context: AllocationContext }
  | { status: "OWNERSHIP_MISSING" }
  | { status: "OWNERSHIP_AMBIGUOUS" };

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
 * Fails immediately and distinctly the moment the ownership-index lookup does not resolve to
 * EXACTLY one order: zero owners is OWNERSHIP_MISSING, more than one is OWNERSHIP_AMBIGUOUS — both
 * return BEFORE any CORTEX-link filtering runs, so an ambiguous ownership set can never silently
 * resolve to a confident CORTEX link just because exactly one of several candidate orders happens to
 * pass the link filter. Once ownership itself is unambiguous (exactly one owner), that single order
 * either carries an exact CORTEX link (BRIDGED) or it structurally does not (NO_CORTEX_LINK, a
 * truthful non-failure, not a guess) — `matches`/filtering is never computed over more than one
 * order.
 */
export function allocationContextWithExactCortexPaperBridge(input: {
  base: AllocationContext;
  candidate: { signalId: string | null; direction: "LONG" | "SHORT" } | undefined;
  laneId: string;
  ownershipIndex: ReadonlyMap<string, readonly PaperOrder[]>;
}): CortexPaperBridgeResult {
  if (!input.candidate?.signalId) return { status: "NO_CANDIDATE", context: input.base };
  const key = paperOrderOwnershipKey(input.candidate.signalId, input.laneId, input.candidate.direction);
  const owned = input.ownershipIndex.get(key) ?? [];
  if (owned.length === 0) {
    recordCortexProductionChainDiagnostic("CORTEX_CANDIDATE_OWNERSHIP_MISSING");
    return { status: "OWNERSHIP_MISSING" };
  }
  if (owned.length > 1) {
    recordCortexProductionChainDiagnostic("CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS");
    return { status: "OWNERSHIP_AMBIGUOUS" };
  }
  const order = owned[0]!;
  // Exact CORTEX-link fields — distinct from ownership itself. An order can be the exact owner of
  // this candidate (matched above) yet still structurally carry no CORTEX link (e.g. a
  // VARIANT_MATRIX_OBSERVATION-sourced order, which never gets one) — that is a truthful "no
  // link", not an ownership failure, so it is checked here rather than folded into the index.
  const identity = order.causalIdentity;
  const snapshot = order.cortexDecisionSnapshot;
  const hasExactCortexLink =
    identity?.allocationSnapshotId != null && identity.canonicalCortexLaneId != null && snapshot != null &&
    snapshot.scanBatchId === order.scanBatchId && snapshot.sourceScanBatchId === order.scanBatchId &&
    snapshot.decisionId === identity.cortexDecisionId &&
    snapshot.allocationSnapshotId === identity.allocationSnapshotId &&
    snapshot.laneId === identity.canonicalCortexLaneId &&
    order.canonicalCortexLaneId === identity.canonicalCortexLaneId;
  if (!hasExactCortexLink) {
    recordCortexProductionChainDiagnostic("CORTEX_ALLOCATION_BRIDGE_MISSING");
    return { status: "NO_CORTEX_LINK", context: input.base };
  }
  return { status: "BRIDGED", context: { ...input.base, cortexAllocationSnapshotId: identity!.allocationSnapshotId } };
}

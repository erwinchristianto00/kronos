import type { AllocationContext } from "./authority-contract.js";
import type { PaperOrder } from "./paper-execution-router.js";
import { recordCortexProductionChainDiagnostic } from "./cortex-production-chain-diagnostics.js";

/** Candidate-owned bridge between a persisted paper admission and Four-Brain. */
export function allocationContextWithExactCortexPaperBridge(input: {
  base: AllocationContext;
  candidate: { signalId: string | null; direction: "LONG" | "SHORT" } | undefined;
  laneId: string;
  orders: readonly PaperOrder[];
}): AllocationContext {
  if (!input.candidate?.signalId) return input.base;
  const matches = input.orders.filter((order) => {
    const identity = order.causalIdentity;
    const snapshot = order.cortexDecisionSnapshot;
    return order.sourceObservationId === input.candidate!.signalId &&
      order.selectedLaneId === input.laneId &&
      order.direction === input.candidate!.direction &&
      identity?.allocationSnapshotId != null && identity.canonicalCortexLaneId != null && snapshot != null &&
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

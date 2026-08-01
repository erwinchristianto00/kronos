import { describe, expect, it } from "vitest";
import { staticAllocationContext } from "../src/lib/authority-contract.js";
import { allocationContextWithExactCortexPaperBridge } from "../src/lib/cortex-paper-allocation-bridge.js";
import { _resetCortexProductionChainDiagnosticsForTests, cortexProductionChainDiagnostics } from "../src/lib/cortex-production-chain-diagnostics.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";

function order(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    paperOrderId: "paper-1", sourceObservationId: "candidate-1", selectedLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
    scanBatchId: "batch-1", direction: "LONG", canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    causalIdentity: { cortexDecisionId: "decision-1", allocationSnapshotId: "allocation-1", canonicalCortexLaneId: "CG_WIDE_FAST_LONG" },
    cortexDecisionSnapshot: { decisionId: "decision-1", allocationSnapshotId: "allocation-1", scanBatchId: "batch-1", sourceScanBatchId: "batch-1", laneId: "CG_WIDE_FAST_LONG", direction: "LONG" },
    ...overrides,
  } as unknown as PaperOrder;
}

describe("exact CORTEX paper allocation bridge", () => {
  it("carries an allocation ID only from one exact candidate-owned persisted order", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const result = allocationContextWithExactCortexPaperBridge({
      base: staticAllocationContext(50), candidate: { signalId: "candidate-1", direction: "LONG" },
      laneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", orders: [order()],
    });
    expect(result.cortexAllocationSnapshotId).toBe("allocation-1");
  });

  it("fails closed for wrong candidate, scan, canonical lane, or ambiguous ownership", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const base = staticAllocationContext(50);
    for (const orders of [
      [order({ sourceObservationId: "other" })],
      [order({ cortexDecisionSnapshot: { ...order().cortexDecisionSnapshot!, scanBatchId: "other" } })],
      [order({ canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER" })],
      [order(), order({ paperOrderId: "paper-2" })],
    ]) {
      expect(allocationContextWithExactCortexPaperBridge({
        base, candidate: { signalId: "candidate-1", direction: "LONG" },
        laneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", orders,
      }).cortexAllocationSnapshotId).toBeUndefined();
    }
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(4);
  });
});

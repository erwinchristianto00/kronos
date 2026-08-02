import { describe, expect, it } from "vitest";
import { staticAllocationContext } from "../src/lib/authority-contract.js";
import { allocationContextWithExactCortexPaperBridge } from "../src/lib/cortex-paper-allocation-bridge.js";
import { buildPaperOrderOwnershipIndex } from "../src/lib/paper-order-ownership-index.js";
import { _resetCortexProductionChainDiagnosticsForTests, cortexProductionChainDiagnostics } from "../src/lib/cortex-production-chain-diagnostics.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";

// Realistic Path B (SCAN_CANDIDATE_LANE_ALLOCATOR) shapes, taken straight from
// _buildAllocatorOrder in paper-execution-router.ts — never a fabricated matching pair:
//   sourceObservationId: `alloc:${scanBatchId}:${sourceCandidateId}`  (paper-execution-router.ts:1694)
//   selectedLaneId: o.laneId, a prefixed CG paper-lane id                (paper-execution-router.ts:1717)
const SOURCE_OBSERVATION_ID = "alloc:batch-2026-08-02T00:00:00Z:BTCUSDT-LONG";
const LANE_ID = "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG";

function allocatorOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    paperOrderId: "paper-1",
    paperStatus: "CREATED",
    sourceType: "SCAN_CANDIDATE_LANE_ALLOCATOR",
    sourceObservationId: SOURCE_OBSERVATION_ID,
    selectedLaneId: LANE_ID,
    scanBatchId: "batch-2026-08-02T00:00:00Z",
    direction: "LONG",
    canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    causalIdentity: {
      cortexDecisionId: "decision-1",
      allocationSnapshotId: "allocation-1",
      canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    },
    cortexDecisionSnapshot: {
      decisionId: "decision-1",
      allocationSnapshotId: "allocation-1",
      scanBatchId: "batch-2026-08-02T00:00:00Z",
      sourceScanBatchId: "batch-2026-08-02T00:00:00Z",
      laneId: "CG_WIDE_FAST_LONG",
      direction: "LONG",
    },
    ...overrides,
  } as unknown as PaperOrder;
}

// Realistic Path A (VARIANT_MATRIX_OBSERVATION) shape — structurally can never carry a CORTEX
// link (scanBatchId is always null, causalIdentity.allocationSnapshotId is always null): a real,
// exact-owner order that is truthfully link-less, not a candidate that was never found.
function variantMatrixOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    paperOrderId: "paper-vm-1",
    paperStatus: "CREATED",
    sourceType: "VARIANT_MATRIX_OBSERVATION",
    sourceObservationId: "BTCUSDT-CG_WIDE_FAST_LONG-1785974400000-3-a1b2c3",
    selectedLaneId: LANE_ID,
    scanBatchId: null,
    direction: "LONG",
    canonicalCortexLaneId: null,
    causalIdentity: null,
    cortexDecisionSnapshot: null,
    ...overrides,
  } as unknown as PaperOrder;
}

describe("exact CORTEX paper allocation bridge", () => {
  it("carries an allocation ID from the one exact candidate-owned persisted order, via the ownership index", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const ownershipIndex = buildPaperOrderOwnershipIndex([allocatorOrder()]);
    const result = allocationContextWithExactCortexPaperBridge({
      base: staticAllocationContext(50),
      candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex,
    });
    expect(result.cortexAllocationSnapshotId).toBe("allocation-1");
  });

  it("fails closed when no order owns the candidate's identity (index miss)", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const ownershipIndex = buildPaperOrderOwnershipIndex([allocatorOrder({ sourceObservationId: "alloc:other-batch:ETHUSDT-LONG" })]);
    const result = allocationContextWithExactCortexPaperBridge({
      base: staticAllocationContext(50),
      candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex,
    });
    expect(result.cortexAllocationSnapshotId).toBeUndefined();
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(1);
    // Point 11: the ownership-index-level miss (owned.length === 0) is recorded separately from the
    // CORTEX-link-specific rejection above — both fire here since there is no owner at all.
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_MISSING).toBe(1);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBe(0);
  });

  it("fails closed for a real, exact-owner order that structurally carries no CORTEX link (Path A / VARIANT_MATRIX_OBSERVATION)", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const vmId = "BTCUSDT-CG_WIDE_FAST_LONG-1785974400000-3-a1b2c3";
    const ownershipIndex = buildPaperOrderOwnershipIndex([variantMatrixOrder({ sourceObservationId: vmId })]);
    const result = allocationContextWithExactCortexPaperBridge({
      base: staticAllocationContext(50),
      candidate: { signalId: vmId, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex,
    });
    expect(result.cortexAllocationSnapshotId).toBeUndefined();
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(1);
  });

  it("fails closed for a mismatched scan batch, canonical lane, or ambiguous/duplicate ownership", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const base = staticAllocationContext(50);
    const cases: PaperOrder[][] = [
      [allocatorOrder({ cortexDecisionSnapshot: { ...allocatorOrder().cortexDecisionSnapshot!, scanBatchId: "other-batch" } })],
      [allocatorOrder({ canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER" })],
      // Duplicate admission: two CREATED orders share the exact same ownership key.
      [allocatorOrder(), allocatorOrder({ paperOrderId: "paper-2" })],
    ];
    for (const orders of cases) {
      const ownershipIndex = buildPaperOrderOwnershipIndex(orders);
      expect(allocationContextWithExactCortexPaperBridge({
        base,
        candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
        laneId: LANE_ID,
        ownershipIndex,
      }).cortexAllocationSnapshotId).toBeUndefined();
    }
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(3);
    // Point 11: only the third case (two CREATED orders sharing the exact ownership key) is an
    // ownership-index-level ambiguity (owned.length > 1) — the first two are single-owner index
    // hits that separately fail the CORTEX-link-specific check above.
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBe(1);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_MISSING).toBe(0);
  });

  it("never returns an order that is no longer actionable (terminal paperStatus excluded from the index)", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const ownershipIndex = buildPaperOrderOwnershipIndex([allocatorOrder({ paperStatus: "PAPER_CLOSED_WIN" })]);
    const result = allocationContextWithExactCortexPaperBridge({
      base: staticAllocationContext(50),
      candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex,
    });
    expect(result.cortexAllocationSnapshotId).toBeUndefined();
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(1);
  });

  it("returns base untouched (no candidate.signalId) without consulting the index at all", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const base = staticAllocationContext(50);
    const result = allocationContextWithExactCortexPaperBridge({
      base,
      candidate: { signalId: null, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex: buildPaperOrderOwnershipIndex([allocatorOrder()]),
    });
    expect(result).toBe(base);
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(0);
  });
});

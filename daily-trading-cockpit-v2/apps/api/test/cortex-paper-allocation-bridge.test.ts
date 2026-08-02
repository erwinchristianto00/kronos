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
    expect(result.status).toBe("BRIDGED");
    expect((result as { status: "BRIDGED"; context: { cortexAllocationSnapshotId?: string } }).context.cortexAllocationSnapshotId).toBe("allocation-1");
  });

  it("fails closed with an explicit OWNERSHIP_MISSING when no order owns the candidate's identity (index miss)", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const ownershipIndex = buildPaperOrderOwnershipIndex([allocatorOrder({ sourceObservationId: "alloc:other-batch:ETHUSDT-LONG" })]);
    const result = allocationContextWithExactCortexPaperBridge({
      base: staticAllocationContext(50),
      candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex,
    });
    expect(result.status).toBe("OWNERSHIP_MISSING");
    expect((result as { context?: unknown }).context).toBeUndefined();
    // Zero owners never reaches the CORTEX-link-specific check — it returns immediately.
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(0);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_MISSING).toBe(1);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBe(0);
  });

  it("fails closed as NO_CORTEX_LINK (falling back to base) for a real, exact-owner order that structurally carries no CORTEX link (Path A / VARIANT_MATRIX_OBSERVATION)", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const vmId = "BTCUSDT-CG_WIDE_FAST_LONG-1785974400000-3-a1b2c3";
    const ownershipIndex = buildPaperOrderOwnershipIndex([variantMatrixOrder({ sourceObservationId: vmId })]);
    const base = staticAllocationContext(50);
    const result = allocationContextWithExactCortexPaperBridge({
      base,
      candidate: { signalId: vmId, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex,
    });
    expect(result.status).toBe("NO_CORTEX_LINK");
    expect((result as { context: { cortexAllocationSnapshotId?: string } }).context.cortexAllocationSnapshotId).toBeUndefined();
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(1);
  });

  it("splits mismatched-single-owner (NO_CORTEX_LINK) from ambiguous/duplicate ownership (OWNERSHIP_AMBIGUOUS)", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const base = staticAllocationContext(50);
    // Cases 1-2: a single exact owner exists, but its CORTEX link is structurally broken
    // (scan-batch mismatch / canonical-lane mismatch) — each resolves to NO_CORTEX_LINK and
    // CORTEX_ALLOCATION_BRIDGE_MISSING fires (the link check ran).
    const noLinkCases: PaperOrder[][] = [
      [allocatorOrder({ cortexDecisionSnapshot: { ...allocatorOrder().cortexDecisionSnapshot!, scanBatchId: "other-batch" } })],
      [allocatorOrder({ canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER" })],
    ];
    for (const orders of noLinkCases) {
      const ownershipIndex = buildPaperOrderOwnershipIndex(orders);
      const result = allocationContextWithExactCortexPaperBridge({
        base,
        candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
        laneId: LANE_ID,
        ownershipIndex,
      });
      expect(result.status).toBe("NO_CORTEX_LINK");
    }
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(2);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBe(0);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_MISSING).toBe(0);

    // Case 3: two CREATED orders share the exact same ownership key — ownership-index-level
    // ambiguity. This must return BEFORE the CORTEX-link filter is ever computed, so
    // CORTEX_ALLOCATION_BRIDGE_MISSING must NOT fire for this case (proves the fix: the function
    // used to compute `matches` regardless and could silently resolve to BRIDGED if exactly one of
    // the ambiguous owners happened to pass the link filter).
    const ambiguousIndex = buildPaperOrderOwnershipIndex([allocatorOrder(), allocatorOrder({ paperOrderId: "paper-2" })]);
    const ambiguousResult = allocationContextWithExactCortexPaperBridge({
      base,
      candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex: ambiguousIndex,
    });
    expect(ambiguousResult.status).toBe("OWNERSHIP_AMBIGUOUS");
    expect((ambiguousResult as { context?: unknown }).context).toBeUndefined();
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(2);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBe(1);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_MISSING).toBe(0);
  });

  it("proves ambiguous ownership can never silently resolve to BRIDGED, even when exactly one of the ambiguous owners has a valid CORTEX link", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const base = staticAllocationContext(50);
    // Two CREATED orders share the exact same ownership key; only "paper-1" carries a structurally
    // valid CORTEX link. Under the OLD behavior (compute `matches` regardless of `owned.length`),
    // this would have returned exactly one match and silently BRIDGED. It must now return
    // OWNERSHIP_AMBIGUOUS unconditionally, before the link filter is ever reached.
    const linked = allocatorOrder({ paperOrderId: "paper-1" });
    const unlinked = allocatorOrder({
      paperOrderId: "paper-2",
      canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER", // breaks its own CORTEX link
    });
    const ownershipIndex = buildPaperOrderOwnershipIndex([linked, unlinked]);
    const result = allocationContextWithExactCortexPaperBridge({
      base,
      candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex,
    });
    expect(result.status).toBe("OWNERSHIP_AMBIGUOUS");
    expect((result as { context?: unknown }).context).toBeUndefined();
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBe(1);
    // The link filter never ran, so its diagnostic never fires for this candidate.
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(0);
  });

  it("returns an explicit OWNERSHIP_MISSING for an order that is no longer actionable (terminal paperStatus excluded from the index)", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const ownershipIndex = buildPaperOrderOwnershipIndex([allocatorOrder({ paperStatus: "PAPER_CLOSED_WIN" })]);
    const result = allocationContextWithExactCortexPaperBridge({
      base: staticAllocationContext(50),
      candidate: { signalId: SOURCE_OBSERVATION_ID, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex,
    });
    expect(result.status).toBe("OWNERSHIP_MISSING");
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(0);
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_MISSING).toBe(1);
  });

  it("returns NO_CANDIDATE with base untouched (no candidate.signalId) without consulting the index at all", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const base = staticAllocationContext(50);
    const result = allocationContextWithExactCortexPaperBridge({
      base,
      candidate: { signalId: null, direction: "LONG" },
      laneId: LANE_ID,
      ownershipIndex: buildPaperOrderOwnershipIndex([allocatorOrder()]),
    });
    expect(result.status).toBe("NO_CANDIDATE");
    expect((result as { context: unknown }).context).toBe(base);
    expect(cortexProductionChainDiagnostics().CORTEX_ALLOCATION_BRIDGE_MISSING).toBe(0);
  });
});

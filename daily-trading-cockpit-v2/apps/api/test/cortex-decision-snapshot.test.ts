import { describe, expect, it } from "vitest";
import {
  _resetCortexDecisionSnapshotsForTests,
  cortexDecisionSnapshotsForScan,
  exactCortexDecisionSnapshotForScan,
  publishCortexDecisionSnapshotsForScan,
} from "../src/lib/cortex-decision-snapshot.js";

const snapshot = (overrides = {}) => ({
  decisionId: "decision-1", allocationSnapshotId: "allocation-1", atMs: 1,
  laneId: "CG_WIDE_FAST_LONG", direction: "LONG" as const, featureSchemaVersion: 1,
  featureVector: [1], regimeFamily: "BULLISH", eligible: true, finalPct: 0, evalFinalPct: 0,
  sourceScanBatchId: "batch-1", ...overrides,
});

describe("scan-bound CORTEX snapshots", () => {
  it("publishes only snapshots produced by the same scan batch", () => {
    _resetCortexDecisionSnapshotsForTests();
    publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()]);
    expect(cortexDecisionSnapshotsForScan("batch-1")).toHaveLength(1);
    publishCortexDecisionSnapshotsForScan("batch-2", [snapshot()]);
    expect(cortexDecisionSnapshotsForScan("batch-2")).toHaveLength(0);
  });

  it("rejects prior batches, wrong canonical lanes, and duplicate exact snapshots", () => {
    const published = [{ ...snapshot(), scanBatchId: "batch-1" }];
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-2", canonicalCortexLaneId: "CG_WIDE_FAST_LONG", direction: "LONG", snapshots: published })).toBeNull();
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-1", canonicalCortexLaneId: "CG_WIDE_FAST_LONG", direction: "LONG", snapshots: [{ ...published[0], sourceScanBatchId: "older-batch" }] })).toBeNull();
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-1", canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER", direction: "LONG", snapshots: published })).toBeNull();
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-1", canonicalCortexLaneId: "CG_WIDE_FAST_LONG", direction: "LONG", snapshots: [...published, { ...published[0], decisionId: "decision-2" }] })).toBeNull();
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-1", canonicalCortexLaneId: "CG_WIDE_FAST_LONG", direction: "LONG", snapshots: published })?.decisionId).toBe("decision-1");
  });
});

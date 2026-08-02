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

describe("publishCortexDecisionSnapshotsForScan immutability contract", () => {
  it("returns PUBLISHED on the first valid publish for a scanBatchId, and the content is retrievable", () => {
    _resetCortexDecisionSnapshotsForTests();
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()]);
    expect(result).toBe("PUBLISHED");
    const stored = cortexDecisionSnapshotsForScan("batch-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.decisionId).toBe("decision-1");
    expect(stored[0]!.scanBatchId).toBe("batch-1");
  });

  it("treats a byte-identical replay as IDEMPOTENT, a no-op that leaves the first array retrievable unchanged", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    const replay = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()]);
    expect(replay).toBe("IDEMPOTENT");
    const stored = cortexDecisionSnapshotsForScan("batch-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.decisionId).toBe("decision-1");
  });

  it("is IDEMPOTENT even when the replay's snapshots arrive in a different array order", () => {
    _resetCortexDecisionSnapshotsForTests();
    const a = snapshot({ decisionId: "decision-a", laneId: "CG_WIDE_FAST_LONG" });
    const b = snapshot({ decisionId: "decision-b", laneId: "CG_WIDE_LONG_RUNNER" });
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [a, b])).toBe("PUBLISHED");
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [b, a])).toBe("IDEMPOTENT");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toHaveLength(2);
  });

  it("refuses a republish with a conflicting decisionId as CONFLICT, and downstream reads see nothing for the batch", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    const conflict = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ decisionId: "decision-2" })]);
    expect(conflict).toBe("CONFLICT");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("refuses a republish with a conflicting featureVector as CONFLICT", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    const conflict = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ featureVector: [2] })]);
    expect(conflict).toBe("CONFLICT");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("refuses a republish with a conflicting timestamp (atMs) as CONFLICT", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    const conflict = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ atMs: 2 })]);
    expect(conflict).toBe("CONFLICT");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("refuses a republish with a conflicting allocationSnapshotId as CONFLICT", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    const conflict = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ allocationSnapshotId: "allocation-2" })]);
    expect(conflict).toBe("CONFLICT");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("once conflicted, exactCortexDecisionSnapshotForScan also refuses the batch even if handed the first-write array directly", () => {
    _resetCortexDecisionSnapshotsForTests();
    const first = [snapshot()];
    expect(publishCortexDecisionSnapshotsForScan("batch-1", first)).toBe("PUBLISHED");
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ decisionId: "decision-2" })])).toBe("CONFLICT");
    expect(
      exactCortexDecisionSnapshotForScan({
        scanBatchId: "batch-1",
        canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
        direction: "LONG",
        snapshots: [{ ...first[0]!, scanBatchId: "batch-1" }],
      }),
    ).toBeNull();
  });

  it("returns INVALID for a publish whose snapshots were sourced from another scan batch", () => {
    _resetCortexDecisionSnapshotsForTests();
    // snapshot()'s default sourceScanBatchId is "batch-1" — publishing it under "batch-2" means the
    // content was produced by a different scan cycle than the one it is being published against.
    const result = publishCortexDecisionSnapshotsForScan("batch-2", [snapshot()]);
    expect(result).toBe("INVALID");
    expect(cortexDecisionSnapshotsForScan("batch-2")).toEqual([]);
  });

  it("resets conflict/hash tracking state so a prior conflict does not leak across tests", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ decisionId: "decision-2" })])).toBe("CONFLICT");
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toHaveLength(1);
  });
});

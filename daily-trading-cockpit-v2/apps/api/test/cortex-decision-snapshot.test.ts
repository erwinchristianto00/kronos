import { describe, expect, it } from "vitest";
import { CORTEX_FEATURE_DIM, CORTEX_FEATURE_SCHEMA_VERSION } from "../src/lib/cortex-brain.js";
import {
  _resetCortexDecisionSnapshotsForTests,
  cortexAllocationSnapshotId,
  cortexDecisionId,
  cortexDecisionSnapshotsForScan,
  exactCortexDecisionSnapshotForScan,
  isScanBatchPublished,
  latestCortexDecisionSnapshotForLane,
  publishCortexDecisionSnapshots,
  publishCortexDecisionSnapshotsForScan,
  type CortexDecisionSnapshot,
} from "../src/lib/cortex-decision-snapshot.js";

/** Canonically shaped fixture: decisionId/allocationSnapshotId are DERIVED from atMs/laneId/
 * featureSchemaVersion via the same canonical functions the real producer (runCortexShadowTick,
 * cortex-brain-store.ts) uses — never hand-picked strings — because validSnapshot() now requires
 * exact equality against that derivation. featureVector defaults to a CORTEX_FEATURE_DIM-length
 * array. Overrides are applied AFTER the derivation for atMs/laneId/featureSchemaVersion, but the
 * derived decisionId/allocationSnapshotId are recomputed from the (possibly overridden) atMs/laneId/
 * featureSchemaVersion unless the caller explicitly overrides decisionId/allocationSnapshotId itself
 * (used only by the tests that deliberately construct a malformed snapshot). */
const snapshot = (overrides: Partial<CortexDecisionSnapshot> = {}): CortexDecisionSnapshot => {
  const atMs = overrides.atMs ?? 1;
  const laneId = overrides.laneId ?? "CG_WIDE_FAST_LONG";
  const featureSchemaVersion = overrides.featureSchemaVersion ?? CORTEX_FEATURE_SCHEMA_VERSION;
  const decisionId = overrides.decisionId ?? cortexDecisionId(atMs, laneId, featureSchemaVersion);
  const allocationSnapshotId = overrides.allocationSnapshotId ?? cortexAllocationSnapshotId(decisionId);
  return {
    decisionId,
    allocationSnapshotId,
    atMs,
    laneId,
    direction: "LONG",
    featureSchemaVersion,
    featureVector: Array.from({ length: CORTEX_FEATURE_DIM }, (_, i) => i + 1),
    regimeFamily: "BULLISH",
    eligible: true,
    finalPct: 0,
    evalFinalPct: 0,
    sourceScanBatchId: "batch-1",
    ...overrides,
  };
};

describe("scan-bound CORTEX snapshots", () => {
  it("publishes only snapshots produced by the same scan batch", () => {
    _resetCortexDecisionSnapshotsForTests();
    publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()]);
    expect(cortexDecisionSnapshotsForScan("batch-1")).toHaveLength(1);
    publishCortexDecisionSnapshotsForScan("batch-2", [snapshot({ sourceScanBatchId: "batch-2" })]);
    expect(cortexDecisionSnapshotsForScan("batch-2")).toHaveLength(1);
    expect(cortexDecisionSnapshotsForScan("batch-3")).toHaveLength(0);
  });

  it("rejects prior batches, wrong canonical lanes, and duplicate exact snapshots", () => {
    const published = [{ ...snapshot(), scanBatchId: "batch-1" }];
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-2", canonicalCortexLaneId: "CG_WIDE_FAST_LONG", direction: "LONG", snapshots: published })).toBeNull();
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-1", canonicalCortexLaneId: "CG_WIDE_FAST_LONG", direction: "LONG", snapshots: [{ ...published[0]!, sourceScanBatchId: "older-batch" }] })).toBeNull();
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-1", canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER", direction: "LONG", snapshots: published })).toBeNull();
    const second = { ...snapshot({ laneId: "CG_WIDE_FAST_LONG", atMs: 2 }), scanBatchId: "batch-1" };
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-1", canonicalCortexLaneId: "CG_WIDE_FAST_LONG", direction: "LONG", snapshots: [...published, second] })).toBeNull();
    expect(exactCortexDecisionSnapshotForScan({ scanBatchId: "batch-1", canonicalCortexLaneId: "CG_WIDE_FAST_LONG", direction: "LONG", snapshots: published })?.decisionId).toBe(published[0]!.decisionId);
  });
});

describe("publishCortexDecisionSnapshotsForScan immutability contract", () => {
  it("returns PUBLISHED on the first valid publish for a scanBatchId, and the content is retrievable", () => {
    _resetCortexDecisionSnapshotsForTests();
    const s = snapshot();
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [s]);
    expect(result).toBe("PUBLISHED");
    const stored = cortexDecisionSnapshotsForScan("batch-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.decisionId).toBe(s.decisionId);
    expect(stored[0]!.scanBatchId).toBe("batch-1");
  });

  it("treats a byte-identical replay as IDEMPOTENT, a no-op that leaves the first array retrievable unchanged", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    const replay = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()]);
    expect(replay).toBe("IDEMPOTENT");
    const stored = cortexDecisionSnapshotsForScan("batch-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.decisionId).toBe(snapshot().decisionId);
  });

  it("is IDEMPOTENT even when the replay's snapshots arrive in a different array order", () => {
    _resetCortexDecisionSnapshotsForTests();
    const a = snapshot({ laneId: "CG_WIDE_FAST_LONG" });
    const b = snapshot({ laneId: "CG_WIDE_LONG_RUNNER" });
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [a, b])).toBe("PUBLISHED");
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [b, a])).toBe("IDEMPOTENT");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toHaveLength(2);
  });

  it("refuses a republish with a conflicting featureVector as CONFLICT", () => {
    // The one case that IS and can remain a true content CONFLICT: decisionId/atMs/allocationSnapshotId
    // stay individually valid and self-consistent, only the feature vector content differs.
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    const differentVector = Array.from({ length: CORTEX_FEATURE_DIM }, (_, i) => i + 100);
    const conflict = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ featureVector: differentVector })]);
    expect(conflict).toBe("CONFLICT");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("once conflicted, exactCortexDecisionSnapshotForScan also refuses the batch even if handed the first-write array directly", () => {
    _resetCortexDecisionSnapshotsForTests();
    const first = [snapshot()];
    expect(publishCortexDecisionSnapshotsForScan("batch-1", first)).toBe("PUBLISHED");
    const differentVector = Array.from({ length: CORTEX_FEATURE_DIM }, (_, i) => i + 100);
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ featureVector: differentVector })])).toBe("CONFLICT");
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
    const differentVector = Array.from({ length: CORTEX_FEATURE_DIM }, (_, i) => i + 100);
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ featureVector: differentVector })])).toBe("CONFLICT");
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toHaveLength(1);
  });

  it("returns INVALID when two snapshots in the same publish call share the same (laneId, direction) pair", () => {
    _resetCortexDecisionSnapshotsForTests();
    const a = snapshot({ atMs: 1 });
    const b = snapshot({ atMs: 2 }); // same default laneId "CG_WIDE_FAST_LONG" + direction "LONG", different decisionId
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [a, b])).toBe("INVALID");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]); // nothing written
  });
});

describe("Point 4: validSnapshot() pre-write exhaustive schema validation", () => {
  it("rejects a decisionId that does not match its own atMs/laneId/featureSchemaVersion as INVALID, not CONFLICT", () => {
    // A real producer can never emit a decisionId that disagrees with its own atMs/laneId/schema — it
    // is derived, not chosen. Such a snapshot is malformed, and must be refused BEFORE the first write
    // (INVALID), never accepted then treated as a content conflict on a later republish.
    _resetCortexDecisionSnapshotsForTests();
    const malformed = snapshot({ decisionId: "not-the-derived-id" });
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [malformed]);
    expect(result).toBe("INVALID");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("rejects an atMs override without a matching decisionId update as INVALID", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    // decisionId stays derived from atMs=1, but atMs is overridden to 2 afterward — self-inconsistent.
    const malformed: CortexDecisionSnapshot = { ...snapshot(), atMs: 2 };
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [malformed]);
    expect(result).toBe("INVALID");
    // The prior PUBLISHED content must remain intact and unpoisoned — an INVALID publish attempt never
    // touches an already-published batch's state.
    expect(cortexDecisionSnapshotsForScan("batch-1")).toHaveLength(1);
  });

  it("rejects an allocationSnapshotId that does not match cortexAllocationSnapshotId(decisionId) as INVALID", () => {
    _resetCortexDecisionSnapshotsForTests();
    const malformed = snapshot({ allocationSnapshotId: "allocation-does-not-match" });
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [malformed]);
    expect(result).toBe("INVALID");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("rejects an invalid feature-schema-version as INVALID", () => {
    _resetCortexDecisionSnapshotsForTests();
    const malformed = snapshot({ featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION + 1 });
    // decisionId in the fixture is derived AFTER featureSchemaVersion is picked, so this decisionId is
    // self-consistent with the wrong schema version — the schema-version check itself must catch it.
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [malformed]);
    expect(result).toBe("INVALID");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("rejects a feature vector whose length does not equal CORTEX_FEATURE_DIM as INVALID", () => {
    _resetCortexDecisionSnapshotsForTests();
    const tooShort = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ featureVector: [1, 2, 3] })]);
    expect(tooShort).toBe("INVALID");
    _resetCortexDecisionSnapshotsForTests();
    const tooLong = publishCortexDecisionSnapshotsForScan(
      "batch-1",
      [snapshot({ featureVector: Array.from({ length: CORTEX_FEATURE_DIM + 1 }, (_, i) => i) })],
    );
    expect(tooLong).toBe("INVALID");
  });

  it("rejects a non-finite value inside an otherwise correctly-sized feature vector as INVALID", () => {
    _resetCortexDecisionSnapshotsForTests();
    const withNaN = Array.from({ length: CORTEX_FEATURE_DIM }, (_, i) => i);
    withNaN[3] = Number.NaN;
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ featureVector: withNaN })]);
    expect(result).toBe("INVALID");
  });

  it("rejects direction: null as INVALID — a real value the producer can emit but which can never resolve exactly", () => {
    _resetCortexDecisionSnapshotsForTests();
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ direction: null })]);
    expect(result).toBe("INVALID");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("rejects a direction outside LONG/SHORT/NEUTRAL as INVALID", () => {
    _resetCortexDecisionSnapshotsForTests();
    const malformed = { ...snapshot(), direction: "SIDEWAYS" as unknown as CortexDecisionSnapshot["direction"] };
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [malformed]);
    expect(result).toBe("INVALID");
  });

  it("accepts sourceScanBatchId: null (the legitimate no-scan-yet case) but rejects an empty string", () => {
    _resetCortexDecisionSnapshotsForTests();
    // publishCortexDecisionSnapshots (the plain, non-scan-bound writer) is the path that legitimately
    // sees sourceScanBatchId: null — exercise validSnapshot() via the scan-bound path with a matching
    // scanBatchId of "" is impossible (scanBatchId itself is required truthy), so prove the null case
    // through the plain publisher used by the real producer when no scan cache exists yet.
    publishCortexDecisionSnapshots([snapshot({ sourceScanBatchId: null, laneId: "CG_WIDE_FAST_LONG" })]);
    expect(latestCortexDecisionSnapshotForLane("CG_WIDE_FAST_LONG")?.decisionId).toBe(snapshot().decisionId);

    const withEmptyString = snapshot({ sourceScanBatchId: "", laneId: "CG_WIDE_LONG_RUNNER" });
    publishCortexDecisionSnapshots([withEmptyString]);
    expect(latestCortexDecisionSnapshotForLane("CG_WIDE_LONG_RUNNER")).toBeNull();
  });

  it("rejects a non-finite finalPct/evalFinalPct as INVALID", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ finalPct: Number.NaN })])).toBe("INVALID");
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ evalFinalPct: Number.POSITIVE_INFINITY })])).toBe("INVALID");
  });

  it("accepts a canonically shaped snapshot exactly matching the real producer's output shape", () => {
    _resetCortexDecisionSnapshotsForTests();
    const s = snapshot();
    expect(s.decisionId).toBe(cortexDecisionId(s.atMs, s.laneId, s.featureSchemaVersion));
    expect(s.allocationSnapshotId).toBe(cortexAllocationSnapshotId(s.decisionId));
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [s])).toBe("PUBLISHED");
  });
});

describe("Point 1: isScanBatchPublished guards the periodic-tick re-fire", () => {
  it("is false before any publish and true once a batch has been PUBLISHED, even after a later CONFLICT", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(isScanBatchPublished("batch-1")).toBe(false);
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    expect(isScanBatchPublished("batch-1")).toBe(true);
    const differentVector = Array.from({ length: CORTEX_FEATURE_DIM }, (_, i) => i + 100);
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ featureVector: differentVector })])).toBe("CONFLICT");
    // Still reports true — "published" tracks whether ANY content was ever accepted, not whether the
    // batch is currently servable. This is what lets the periodic-tick guard in app.ts skip its own
    // re-fire attempt entirely rather than re-entering the publish call at all.
    expect(isScanBatchPublished("batch-1")).toBe(true);
  });

  it("stays false for a scanBatchId that was never published, and unrelated batches do not leak into each other", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    expect(isScanBatchPublished("batch-2")).toBe(false);
  });

  it("proves the underlying mechanism (publishCortexDecisionSnapshotsForScan itself) still produces a real CONFLICT for a genuinely different-content republish — the guard changed the CALLER, not the module's own semantics", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    const differentVector = Array.from({ length: CORTEX_FEATURE_DIM }, (_, i) => i + 100);
    const result = publishCortexDecisionSnapshotsForScan("batch-1", [snapshot({ featureVector: differentVector })]);
    expect(result).toBe("CONFLICT");
    expect(cortexDecisionSnapshotsForScan("batch-1")).toEqual([]);
  });

  it("resets isScanBatchPublished state on _resetCortexDecisionSnapshotsForTests", () => {
    _resetCortexDecisionSnapshotsForTests();
    expect(publishCortexDecisionSnapshotsForScan("batch-1", [snapshot()])).toBe("PUBLISHED");
    expect(isScanBatchPublished("batch-1")).toBe(true);
    _resetCortexDecisionSnapshotsForTests();
    expect(isScanBatchPublished("batch-1")).toBe(false);
  });
});

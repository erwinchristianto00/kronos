import { describe, expect, it } from "vitest";
import { buildPaperOrderOwnershipIndex, paperOrderOwnershipKey } from "../src/lib/paper-order-ownership-index.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";

function order(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    paperOrderId: "paper-1",
    paperStatus: "CREATED",
    sourceObservationId: "alloc:batch-1:BTCUSDT-LONG",
    selectedLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
    direction: "LONG",
    ...overrides,
  } as unknown as PaperOrder;
}

describe("paper order ownership index", () => {
  it("indexes an admissible order under its exact (sourceObservationId, selectedLaneId, direction) key", () => {
    const index = buildPaperOrderOwnershipIndex([order()]);
    const key = paperOrderOwnershipKey("alloc:batch-1:BTCUSDT-LONG", "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "LONG");
    expect(index.get(key)?.map((o) => o.paperOrderId)).toEqual(["paper-1"]);
  });

  it("never collapses two different (id, lane) pairs into the same key, even when a naive ':'-join would", () => {
    // Real ids already contain ":" (e.g. alloc:<scanBatchId>:<sourceCandidateId>,
    // CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG), so a ":"-joined key would collide these two
    // distinct (sourceObservationId, selectedLaneId) pairs at the field boundary — both would
    // stringify to "alloc:batch-1:BTC:USDT-LONG:LONG" under a plain ":" join.
    const a = paperOrderOwnershipKey("alloc:batch-1:BTC", "USDT-LONG", "LONG");
    const b = paperOrderOwnershipKey("alloc:batch-1", "BTC:USDT-LONG", "LONG");
    expect(a).not.toBe(b);
  });

  it("excludes terminal/non-actionable orders (only CREATED/PAPER_SUBMITTED are indexed)", () => {
    const index = buildPaperOrderOwnershipIndex([
      order({ paperOrderId: "closed", paperStatus: "PAPER_CLOSED_WIN" }),
      order({ paperOrderId: "rejected", paperStatus: "PAPER_REJECTED" }),
      order({ paperOrderId: "submitted", paperStatus: "PAPER_SUBMITTED" }),
    ]);
    const key = paperOrderOwnershipKey("alloc:batch-1:BTCUSDT-LONG", "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "LONG");
    expect(index.get(key)?.map((o) => o.paperOrderId)).toEqual(["submitted"]);
  });

  it("returns undefined for a key with no admissible owner (fail-closed MISSING, never a guess)", () => {
    const index = buildPaperOrderOwnershipIndex([order()]);
    const key = paperOrderOwnershipKey("alloc:batch-1:ETHUSDT-LONG", "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "LONG");
    expect(index.get(key)).toBeUndefined();
  });

  it("buckets every admissible duplicate under one key (fail-closed AMBIGUOUS, never picks one)", () => {
    const index = buildPaperOrderOwnershipIndex([
      order({ paperOrderId: "paper-1" }),
      order({ paperOrderId: "paper-2" }),
    ]);
    const key = paperOrderOwnershipKey("alloc:batch-1:BTCUSDT-LONG", "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "LONG");
    expect(index.get(key)?.map((o) => o.paperOrderId)).toEqual(["paper-1", "paper-2"]);
  });

  it("keeps LONG and SHORT orders on the same observation/lane separate", () => {
    const index = buildPaperOrderOwnershipIndex([
      order({ paperOrderId: "long-1", direction: "LONG" }),
      order({ paperOrderId: "short-1", direction: "SHORT" }),
    ]);
    const longKey = paperOrderOwnershipKey("alloc:batch-1:BTCUSDT-LONG", "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "LONG");
    const shortKey = paperOrderOwnershipKey("alloc:batch-1:BTCUSDT-LONG", "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "SHORT");
    expect(index.get(longKey)?.map((o) => o.paperOrderId)).toEqual(["long-1"]);
    expect(index.get(shortKey)?.map((o) => o.paperOrderId)).toEqual(["short-1"]);
  });
});

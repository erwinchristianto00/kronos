import { describe, expect, it } from "vitest";
import { buildLiveIntentIndexByPaperOrderId } from "../src/lib/live-intent-index.js";
import type { LiveIntent } from "../src/lib/live-execution-engine.js";

function intent(overrides: Partial<LiveIntent> = {}): LiveIntent {
  const now = new Date(1_000).toISOString();
  return {
    paperOrderId: "paper-1",
    symbol: "BTCUSDT",
    direction: "LONG",
    state: "OPEN",
    qty: 1,
    tp1Qty: 0.5,
    plannedEntryPrice: 100,
    stopLossPrice: 95,
    tp1Price: 110,
    filledEntryPrice: 100,
    entryOrderId: "entry-1",
    stopOrderId: "stop-1",
    tp1OrderId: "tp1-1",
    beStopOrderId: null,
    realizedPnlUsd: null,
    feesUsd: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closeReason: null,
    lastError: null,
    ...overrides,
  };
}

describe("live intent index", () => {
  it("indexes an intent under its exact primary paperOrderId", () => {
    const index = buildLiveIntentIndexByPaperOrderId([intent()]);
    expect(index.get("paper-1")?.paperOrderId).toBe("paper-1");
  });

  it("returns undefined for a paperOrderId with no live intent (fail-closed MISS, never a guess)", () => {
    const index = buildLiveIntentIndexByPaperOrderId([intent()]);
    expect(index.get("paper-does-not-exist")).toBeUndefined();
  });

  it("indexes every distinct intent under its own key, never collapsing two intents into one", () => {
    const index = buildLiveIntentIndexByPaperOrderId([
      intent({ paperOrderId: "paper-1", symbol: "BTCUSDT" }),
      intent({ paperOrderId: "paper-2", symbol: "ETHUSDT" }),
    ]);
    expect(index.get("paper-1")?.symbol).toBe("BTCUSDT");
    expect(index.get("paper-2")?.symbol).toBe("ETHUSDT");
    expect(index.size).toBe(2);
  });

  it("COLLISION POLICY: fails closed (retracts + records) a paperOrderId shared by two intents as PRIMARY of both — never last-write-wins", () => {
    const first = intent({ paperOrderId: "paper-1", state: "OPEN" });
    const second = intent({ paperOrderId: "paper-1", state: "ERROR" });
    const index = buildLiveIntentIndexByPaperOrderId([first, second]);
    expect(index.get("paper-1")).toBeUndefined();
    expect(index.conflictedPaperOrderIds.has("paper-1")).toBe(true);
    expect(index.size).toBe(0);
  });

  it("builds an empty index from an empty intent list", () => {
    const index = buildLiveIntentIndexByPaperOrderId([]);
    expect(index.size).toBe(0);
    expect(index.get("anything")).toBeUndefined();
    expect(index.conflictedPaperOrderIds.size).toBe(0);
  });

  it("also resolves a source-only paperOrderId (a genuine pyramid-add/netted order) to its owning intent — the primary case this index previously missed entirely", () => {
    const intentA = intent({
      paperOrderId: "primary-a",
      sourcePaperOrders: [{ paperOrderId: "source-a", laneId: "LANE", qty: 1 }],
    });
    const index = buildLiveIntentIndexByPaperOrderId([intentA]);
    expect(index.get("primary-a")).toBe(intentA);
    expect(index.get("source-a")).toBe(intentA);
    expect(index.conflictedPaperOrderIds.size).toBe(0);
  });

  it("does not treat an intent's routine self-echo (its own primary order also listed in its own sourcePaperOrders, as openIntent() always produces) as a collision", () => {
    const intentA = intent({
      paperOrderId: "primary-a",
      sourcePaperOrders: [
        { paperOrderId: "primary-a", laneId: "LANE", qty: 1 }, // the primary echoed into its own sources
        { paperOrderId: "source-a", laneId: "LANE", qty: 1 },
      ],
    });
    const index = buildLiveIntentIndexByPaperOrderId([intentA]);
    expect(index.get("primary-a")).toBe(intentA);
    expect(index.get("source-a")).toBe(intentA);
    expect(index.conflictedPaperOrderIds.size).toBe(0);
  });

  it("COLLISION POLICY: fails closed (retracts + records) a paperOrderId that is a SOURCE of two different intents at once — never silently picks one", () => {
    const intentA = intent({ paperOrderId: "primary-a", sourcePaperOrders: [{ paperOrderId: "shared", laneId: "LANE", qty: 1 }] });
    const intentB = intent({ paperOrderId: "primary-b", sourcePaperOrders: [{ paperOrderId: "shared", laneId: "LANE", qty: 1 }] });
    const index = buildLiveIntentIndexByPaperOrderId([intentA, intentB]);
    expect(index.get("shared")).toBeUndefined(); // retracted, never a guess
    expect(index.conflictedPaperOrderIds.has("shared")).toBe(true);
    // Both unrelated ids still resolve normally — the collision is scoped to the colliding id only.
    expect(index.get("primary-a")).toBe(intentA);
    expect(index.get("primary-b")).toBe(intentB);
  });

  it("COLLISION POLICY: fails closed a paperOrderId that is somehow both a PRIMARY of one intent and a SOURCE of a different intent — never silently prefers the primary", () => {
    const intentA = intent({ paperOrderId: "primary-a", sourcePaperOrders: [{ paperOrderId: "shared", laneId: "LANE", qty: 1 }] });
    const intentB = intent({ paperOrderId: "shared" });
    const index = buildLiveIntentIndexByPaperOrderId([intentA, intentB]);
    expect(index.get("shared")).toBeUndefined();
    expect(index.conflictedPaperOrderIds.has("shared")).toBe(true);
    expect(index.get("primary-a")).toBe(intentA);
  });

  it("DUPLICATE SOURCE ROW (blocker 2a): a single intent listing the SAME paperOrderId twice in its own sourcePaperOrders is ambiguous — retracted into conflictedPaperOrderIds even though it is only ONE owning intent by the Set-of-intents dedupe", () => {
    // Same intent object referenced twice inside one array. Two DISTINCT PaperOrder-lineage rows
    // both claim this id — the index has no basis to pick one over the other, even though both rows
    // happen to resolve to the same intent, so this must fail closed exactly like a cross-intent
    // collision, never silently resolve to "the" (first/either) row.
    const intentA = intent({
      paperOrderId: "primary-a",
      sourcePaperOrders: [
        { paperOrderId: "dup", laneId: "LANE", qty: 1 },
        { paperOrderId: "dup", laneId: "LANE", qty: 1 },
      ],
    });
    const index = buildLiveIntentIndexByPaperOrderId([intentA]);
    expect(index.get("dup")).toBeUndefined(); // retracted, never a guess
    expect(index.conflictedPaperOrderIds.has("dup")).toBe(true);
    // The unrelated primary id is unaffected — the collision is scoped to "dup" only.
    expect(index.get("primary-a")).toBe(intentA);
  });

  it("DUPLICATE SOURCE ROW (blocker 2a): three occurrences of the same id in one intent's sourcePaperOrders is still just one conflict entry, not an error", () => {
    const intentA = intent({
      paperOrderId: "primary-a",
      sourcePaperOrders: [
        { paperOrderId: "dup", laneId: "LANE", qty: 1 },
        { paperOrderId: "dup", laneId: "LANE", qty: 1 },
        { paperOrderId: "dup", laneId: "LANE", qty: 1 },
      ],
    });
    const index = buildLiveIntentIndexByPaperOrderId([intentA]);
    expect(index.get("dup")).toBeUndefined();
    expect(index.conflictedPaperOrderIds.has("dup")).toBe(true);
  });

  it("a paperOrderId appearing exactly ONCE in a single intent's sourcePaperOrders is not a duplicate — resolves cleanly (control for blocker 2a: the fix must not flag single occurrences)", () => {
    const intentA = intent({
      paperOrderId: "primary-a",
      sourcePaperOrders: [{ paperOrderId: "not-dup", laneId: "LANE", qty: 1 }],
    });
    const index = buildLiveIntentIndexByPaperOrderId([intentA]);
    expect(index.get("not-dup")).toBe(intentA);
    expect(index.conflictedPaperOrderIds.size).toBe(0);
  });

  it("DUPLICATE SOURCE ROW (blocker 2a) does not false-positive on the routine primary self-echo appearing once alongside a genuinely duplicated OTHER source id", () => {
    const intentA = intent({
      paperOrderId: "primary-a",
      sourcePaperOrders: [
        { paperOrderId: "primary-a", laneId: "LANE", qty: 1 }, // routine self-echo, skipped entirely
        { paperOrderId: "dup", laneId: "LANE", qty: 1 },
        { paperOrderId: "dup", laneId: "LANE", qty: 1 },
      ],
    });
    const index = buildLiveIntentIndexByPaperOrderId([intentA]);
    expect(index.get("primary-a")).toBe(intentA); // self-echo never counted as a duplicate
    expect(index.get("dup")).toBeUndefined();
    expect(index.conflictedPaperOrderIds.has("dup")).toBe(true);
    expect(index.conflictedPaperOrderIds.has("primary-a")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperExecutionRouterStore, type PaperOrder } from "../src/lib/paper-execution-router.js";

/**
 * Track 1a — close-timestamp correctness. Proves the resolver records the MARKET exit timestamp (`closedAtMs`,
 * threaded from walkVariantPath.closedAtMs / the exit candle) distinctly from the PROCESS persist time
 * (`resolvedAtMs`, stamped centrally in store.update), and that the timestamp wiring is additive + idempotent and
 * changes no existing outcome value or exit reason.
 */
function storeWithOpenOrder(): { store: PaperExecutionRouterStore; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "paper-close-ts-"));
  const store = new PaperExecutionRouterStore(dir);
  const id = "ord-1";
  // seed a minimal OPEN order directly into internal state (update() only needs the id to match).
  (store as unknown as { state: { orders: PaperOrder[] } }).state.orders.push({
    paperOrderId: id, paperStatus: "PAPER_SUBMITTED", netR: null, grossR: null, costR: null, closeReason: null,
  } as unknown as PaperOrder);
  return { store, id };
}
const get = (store: PaperExecutionRouterStore, id: string): PaperOrder =>
  (store as unknown as { state: { orders: PaperOrder[] } }).state.orders.find((o) => o.paperOrderId === id)!;

describe("Track 1a — paper close timestamps", () => {
  it("closedAtMs is the caller-supplied MARKET ts; resolvedAtMs is stamped as PROCESS time; closedAtMs ≤ resolvedAtMs", () => {
    const { store, id } = storeWithOpenOrder();
    const marketCloseMs = 1_700_000_000_000; // an exit-candle market timestamp (well in the past)
    store.update(id, { paperStatus: "PAPER_CLOSED_WIN", netR: 0.5, closeReason: "MAKER_EXIT", closedAtMs: marketCloseMs });
    const o = get(store, id);
    expect(o.closedAtMs).toBe(marketCloseMs); // exactly the market ts the caller passed (from the exit candle)
    expect(o.resolvedAtMs).toBeGreaterThanOrEqual(marketCloseMs); // process time ≥ market close
    expect(o.closedAtMs! <= o.resolvedAtMs!).toBe(true);
  });
  it("processing delay does NOT change closedAtMs; a rerun does not re-stamp resolvedAtMs (idempotent)", () => {
    const { store, id } = storeWithOpenOrder();
    const marketCloseMs = 1_700_000_000_000;
    store.update(id, { paperStatus: "PAPER_CLOSED_WIN", netR: 0.5, closeReason: "MAKER_EXIT", closedAtMs: marketCloseMs });
    const firstResolved = get(store, id).resolvedAtMs;
    // a later re-persist (e.g. an unrelated metadata patch) must not move closedAtMs OR resolvedAtMs.
    store.update(id, { netPnlAmount: 12.3 });
    const o = get(store, id);
    expect(o.closedAtMs).toBe(marketCloseMs); // unchanged by later processing
    expect(o.resolvedAtMs).toBe(firstResolved); // stamped once, not overwritten
  });
  it("the timestamp wiring is ADDITIVE — existing outcome value + exit reason are unchanged", () => {
    const { store, id } = storeWithOpenOrder();
    store.update(id, { paperStatus: "PAPER_CLOSED_LOSS", netR: -1.05, grossR: -1, costR: -0.05, closeReason: "MAX_HOLD_MTM", closedAtMs: 1_700_000_000_000 });
    const o = get(store, id);
    expect(o.paperStatus).toBe("PAPER_CLOSED_LOSS");
    expect(o.netR).toBe(-1.05);
    expect(o.grossR).toBe(-1);
    expect(o.closeReason).toBe("MAX_HOLD_MTM"); // exit reason preserved
  });
  it("a non-close update never stamps resolvedAtMs (only terminal CLOSED_* does)", () => {
    const { store, id } = storeWithOpenOrder();
    store.update(id, { paperStatus: "PAPER_SUBMITTED" });
    expect(get(store, id).resolvedAtMs == null).toBe(true);
  });
  it("LEGACY already-closed order + unrelated update ⇒ resolvedAtMs STAYS null (no fabricated resolution time)", () => {
    const dir = mkdtempSync(join(tmpdir(), "paper-close-ts-legacy-"));
    const store = new PaperExecutionRouterStore(dir);
    const id = "legacy-1";
    // a pre-existing CLOSED order from before this feature: terminal status, NO resolvedAtMs field.
    (store as unknown as { state: { orders: PaperOrder[] } }).state.orders.push({
      paperOrderId: id, paperStatus: "PAPER_CLOSED_WIN", netR: 0.3, grossR: 0.35, costR: -0.05, closeReason: "MAKER_EXIT",
    } as unknown as PaperOrder);
    store.update(id, { netPnlAmount: 9.9 }); // an unrelated later touch — must NOT stamp a fake resolution time
    expect(get(store, id).resolvedAtMs == null).toBe(true); // prev was already terminal ⇒ no transition ⇒ no stamp
  });
  it("MISSING market ts ⇒ closedAtMs null (a close with no proven market time is excluded from gold downstream)", () => {
    const { store, id } = storeWithOpenOrder();
    store.update(id, { paperStatus: "PAPER_CLOSED_WIN", netR: 0.2, closeReason: "SOME_EXIT" }); // no closedAtMs passed
    const o = get(store, id);
    expect(o.closedAtMs == null).toBe(true); // not fabricated from process time
    expect(o.resolvedAtMs).toBeGreaterThan(0); // process time still recorded for audit
  });
});

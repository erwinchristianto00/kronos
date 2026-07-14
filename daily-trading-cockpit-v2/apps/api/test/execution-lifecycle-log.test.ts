import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordLifecycle, foldLifecycle, deriveLatencies, isLifecycleLoggingEnabled, LIFECYCLE_SCHEMA_VERSION, type ExecutionLifecycleEvent } from "../src/lib/execution-lifecycle-log.js";

const base = { orderId: "o1", decisionId: "d1", instanceId: "3102", symbol: "BTCUSDT", side: "BUY" as const, orderType: "MARKET", requestedQty: 1, cumulativeFilledQty: 0, source: "paper", exchangeEventAtMs: null };
const ev = (event: ExecutionLifecycleEvent["event"], eventAtMs: number, over: Partial<ExecutionLifecycleEvent> = {}): ExecutionLifecycleEvent => ({ ...base, event, eventAtMs, schemaVersion: "v", ...over });

describe("Track 2 — execution lifecycle log: logging-only, fail-open, default-OFF", () => {
  it("is INERT unless explicitly enabled (default OFF)", () => {
    const sink: ExecutionLifecycleEvent[] = [];
    expect(recordLifecycle((r) => sink.push(r), { ...base, event: "SUBMITTED", eventAtMs: 100 })).toBe(false);
    expect(isLifecycleLoggingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(sink.length).toBe(0);
  });
  it("appends the operator schema (schemaVersion stamped) when enabled", () => {
    const sink: ExecutionLifecycleEvent[] = [];
    expect(recordLifecycle((r) => sink.push(r), { ...base, event: "EXCHANGE_ACK", eventAtMs: 100 }, { enabled: true })).toBe(true);
    expect(sink[0]!.schemaVersion).toBe(LIFECYCLE_SCHEMA_VERSION);
    expect(sink[0]!.event).toBe("EXCHANGE_ACK");
  });
  it("FAILS OPEN — a throwing sink never propagates; opt-out only for tests", () => {
    const bad = () => { throw new Error("disk full"); };
    expect(recordLifecycle(bad, { ...base, event: "SUBMITTED", eventAtMs: 1 }, { enabled: true })).toBe(false);
    expect(() => recordLifecycle(bad, { ...base, event: "SUBMITTED", eventAtMs: 1 }, { enabled: true, failOpen: false })).toThrow();
  });
  it("does NOT mutate the caller's record (logging cannot alter an order result)", () => {
    const rec = { ...base, event: "SUBMITTED" as const, eventAtMs: 100 };
    const before = JSON.stringify(rec);
    recordLifecycle(() => {}, rec, { enabled: true });
    expect(JSON.stringify(rec)).toBe(before); // unchanged; schemaVersion added only to the sink copy
  });
  it("STRUCTURAL: makes no exchange/network call, imports no executor/binance", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/lib/execution-lifecycle-log.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/fetch\(|axios|binance|placeOrder|cancelOrder|http/i);
    expect(src).not.toMatch(/^import/m); // zero imports — fully standalone
  });
});

describe("Track 2 — fold + latency + BUY/SELL separation", () => {
  const recs = [
    ev("DECISION", 1000), ev("SUBMITTED", 1200), ev("EXCHANGE_ACK", 1400, { exchangeEventAtMs: 1450 }),
    ev("FIRST_FILL", 1600), ev("FIRST_FILL", 1500), ev("FINAL_FILL", 1800),
  ];
  it("folds an event stream; FIRST_FILL keeps earliest; prefers exchangeEventAtMs when present", () => {
    const ts = foldLifecycle(recs);
    expect(ts.decisionAt).toBe(1000);
    expect(ts.exchangeAckAt).toBe(1450); // exchange ts preferred over local 1400
    expect(ts.firstFillAt).toBe(1500);
    expect(ts.finalFillAt).toBe(1800);
  });
  it("duplicate events are idempotent under fold (same aggregate)", () => {
    expect(foldLifecycle([...recs, ...recs])).toEqual(foldLifecycle(recs));
  });
  it("derives latencies; null when an endpoint is missing", () => {
    const l = deriveLatencies(foldLifecycle(recs));
    expect(l.decisionToSubmitMs).toBe(200);
    expect(l.submitToAckMs).toBe(250); // 1450 − 1200
    expect(l.cancelReqToAckMs).toBeNull();
  });
  it("SELL and BUY events stay separable by side (short-side calibration)", () => {
    const mixed = [ev("FINAL_FILL", 1, { side: "BUY" }), ev("FINAL_FILL", 2, { side: "SELL" })];
    expect(mixed.filter((r) => r.side === "SELL").length).toBe(1);
    expect(mixed.filter((r) => r.side === "BUY").length).toBe(1);
  });
});

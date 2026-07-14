import { describe, it, expect } from "vitest";
import { candleAvailableAt, closedCandlesAsOf, mergeSortedEvents, buildSnapshotAudit, isCausal, type ReplayEvent } from "../src/lib/replay-clock.js";
import { simulateExecution, totalExecutionCostR, type OrderRequest, type EmulatorConfig } from "../src/lib/replay-execution-emulator.js";

const HOUR = 3_600_000;

describe("replay clock — causality", () => {
  it("a candle is available ONLY after its close (no early high/low leak)", () => {
    expect(candleAvailableAt(0, HOUR, HOUR - 1)).toBe(false); // still forming
    expect(candleAvailableAt(0, HOUR, HOUR)).toBe(true); // just closed
  });
  it("closedCandlesAsOf drops the forming candle + sorts ascending", () => {
    const cs = [{ openTime: 2 * HOUR }, { openTime: 0 }, { openTime: HOUR }];
    const got = closedCandlesAsOf(cs, HOUR, 2 * HOUR); // asOf=2h ⇒ candles [0,1h] closed, [2h] still forming
    expect(got.map((c) => c.openTime)).toEqual([0, HOUR]);
  });
  it("mergeSortedEvents produces a globally time-ordered stream", () => {
    const a: ReplayEvent[] = [{ ts: 1, kind: "c", payload: 0 }, { ts: 5, kind: "c", payload: 0 }];
    const b: ReplayEvent[] = [{ ts: 2, kind: "t", payload: 0 }, { ts: 3, kind: "t", payload: 0 }];
    expect(mergeSortedEvents([a, b]).map((e) => e.ts)).toEqual([1, 2, 3, 5]);
  });
  it("buildSnapshotAudit flags a FUTURE source (leak), a stale source, and a missing one", () => {
    const audit = buildSnapshotAudit(1000, [
      { name: "regime", ts: 900 }, { name: "leak", ts: 1500 }, { name: "old", ts: 100 }, { name: "gone", ts: null },
    ], (n) => (n === "old" ? 500 : 10_000));
    expect(audit.futureSources).toContain("leak");
    expect(audit.staleSources).toContain("old"); // 1000−100 > 500 ttl
    expect(audit.missingSources).toContain("gone");
    expect(audit.snapshotSkewMs).toBe(1500 - 100);
    expect(isCausal(audit)).toBe(false); // leak present
    expect(isCausal(buildSnapshotAudit(1000, [{ name: "ok", ts: 900 }], () => 1e9))).toBe(true);
  });
});

describe("replay execution emulator (never assumes a fill)", () => {
  const cfg: EmulatorConfig = { level: 1, spreadBps: 4, latencyMs: 200, takerFeeBps: 5, makerFeeBps: 1, slippageBps: 2 };
  const mkt = (o: Partial<OrderRequest> = {}): OrderRequest => ({ orderId: "o", decisionId: "d", side: "BUY", type: "MARKET", requestedQty: 1, referencePrice: 100, riskDistancePrice: 2, submittedAtMs: 0, ...o });

  it("Level 0 fills at reference with fees only", () => {
    const e = simulateExecution(mkt(), { ...cfg, level: 0 });
    expect(e.status).toBe("FILLED");
    expect(e.averageFillPrice).toBe(100);
    expect(e.spreadCostR).toBe(0);
    expect(e.feeR).toBeCloseTo((100 * 0.0005) / 2);
  });
  it("Level 1 market BUY pays up (half-spread + slippage); SELL receives less", () => {
    const buy = simulateExecution(mkt(), cfg);
    expect(buy.averageFillPrice!).toBeGreaterThan(100);
    expect(buy.spreadCostR!).toBeCloseTo((100 * 0.0004 / 2) / 2);
    expect(buy.exchangeArrivedAtMs).toBe(200); // latency applied
    const sell = simulateExecution(mkt({ side: "SELL" }), cfg);
    expect(sell.averageFillPrice!).toBeLessThan(100);
  });
  it("a limit order that is never touched does NOT fill", () => {
    expect(simulateExecution(mkt({ type: "LIMIT", limitPrice: 99, limitTouched: false }), cfg).status).toBe("UNFILLED");
    expect(simulateExecution(mkt({ type: "LIMIT", limitPrice: 99, limitTouched: false }), { ...cfg, expireMs: 60_000 }).status).toBe("EXPIRED");
    const filled = simulateExecution(mkt({ type: "LIMIT", limitPrice: 99, limitTouched: true }), cfg);
    expect(filled.status).toBe("FILLED");
    expect(filled.averageFillPrice).toBe(99);
    expect(filled.spreadCostR).toBe(0); // resting maker: no spread cost
  });
  it("a market order can PARTIALLY fill", () => {
    const e = simulateExecution(mkt({ fillableFraction: 0.5 }), cfg);
    expect(e.status).toBe("PARTIAL");
    expect(e.filledQty).toBe(0.5);
  });
  it("a ≤0 risk denominator makes R costs null (never fabricated); bad order REJECTED; L2 routed away", () => {
    const e = simulateExecution(mkt({ riskDistancePrice: 0 }), cfg);
    expect(e.spreadCostR).toBeNull();
    expect(e.feeR).toBeNull();
    expect(simulateExecution(mkt({ requestedQty: 0 }), cfg).status).toBe("REJECTED");
    expect(simulateExecution(mkt(), { ...cfg, level: 2 }).status).toBe("REJECTED");
  });
  it("totalExecutionCostR sums null-safe", () => {
    const e = simulateExecution(mkt(), cfg);
    expect(totalExecutionCostR(e)).toBeGreaterThan(0);
    expect(totalExecutionCostR({ ...e, spreadCostR: null, slippageR: null, feeR: null, fundingR: null })).toBe(0);
  });
});

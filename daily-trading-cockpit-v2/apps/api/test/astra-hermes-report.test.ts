import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAstraReport, AstraLearningStore, type AstraReportSource } from "../src/lib/astra-hermes-report.js";
import type { AstraTrade } from "../src/lib/astra-hermes-lane.js";
import { walletView } from "../src/lib/astra-capital.js";
const now = 1800000000000;
function trade(id: string, gross: number, fee: number, extra: Partial<AstraTrade> = {}): AstraTrade {
  return { id, symbol: "DOGEUSDT", side: "LONG", createdAt: now - 100000,
    state: "CLOSED", entryQty: 2, qty: 0, entryPrice: 10, closedAt: now - 1000, settlementComplete: true,
    entry: { order: { orderId: "entry", updateTime: now - 90000 } }, exits: [{ order: { orderId: "exit" } }],
    fills: [{ orderId: "entry", qty: 2, price: 10, realizedPnl: 0, commission: fee / 2 },
      { orderId: "exit", qty: 2, price: 10 + gross / 2, realizedPnl: gross, commission: fee / 2 }],
    stopId: "stop", stopDone: true, stopExitId: null, stopPrice: 9, targetPrice: 12, maxHoldMs: 3600000,
    decision: { reason: "Recorded hypothesis" }, error: null, ...extra } as AstraTrade;
}
function source(trades: AstraTrade[] = []): AstraReportSource { return { trades, funding: [], fundingThrough: now, lastError: null, decisions: [] }; }
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
describe("Astra read-only economics projection", () => {
  it("does not manufacture a win rate/profit factor or completed trade from an empty ledger", () => {
    expect(buildAstraReport(source(), new Map(), now).summary).toMatchObject({ closedN: 0, openN: 0, estimatedNet: 0, net: 0, floating: 0, winRate: null, profitFactor: null, expectancy: null });
  });
  it("separates settled economics from open/partial costs, no-fill attempts and unrealized", () => {
    const s = source([trade("win", 3, .3, { closedAt: now - 3000 }), trade("loss", -1, .2),
      trade("open", .4, .1, { symbol: "SUSDT", side: "SHORT", state: "OPEN", qty: 2, entryQty: 3, closedAt: null, settlementComplete: false, stopDone: false }),
      trade("no-fill", 0, 0, { state: "NO_FILL", entryQty: 0, fills: [] })]);
    s.funding = [{ tradeId: "win", amount: -.1 }, { tradeId: "loss", amount: .05 }];
    const report = buildAstraReport(s, new Map([["SUSDT", { bid: 10.9, ask: 11, time: now }]]), now);
    expect(report.summary.closedN).toBe(2); expect(report.summary.openN).toBe(1); expect(report.summary.noFillN).toBe(1);
    expect(report.summary.closedNet).toBeCloseTo(1.45); expect(report.summary.net).toBeCloseTo(1.75);
    expect(report.summary.estimatedNet).toBeCloseTo(-.25);
    expect(report.summary.winRate).toBe(.5); expect(report.summary.profitFactor).toBeCloseTo(2.6 / 1.15);
    expect(report.summary.maxClosedDrawdown).toBeCloseTo(1.15);
    expect(report.closed[0].id).toBe("loss"); expect(report.closed.find(t => t.id === "win")?.exitPrice).toBe(11.5);
    expect(report.open[0].protection).toBe("NATIVE_STOP");
  });
  it("marks stale/missing quotes unknown, never zero floating equity", () => {
    const s = source([trade("open", 0, .1, { state: "OPEN", qty: 2, settlementComplete: false })]);
    for (const books of [new Map(), new Map([["DOGEUSDT", { bid: 11, ask: 12, time: now - 120001 }]])]) {
      const r = buildAstraReport(s, books, now); expect(r.summary.floating).toBeNull(); expect(r.summary.estimatedNet).toBeNull();
    }
  });
  it("never attributes shared wallet balance or deposits to Astra results", () => {
    for (const walletBalance of [25, 5000, 10000]) {
      const r = buildAstraReport(source([trade("loss", -2, .1)]), new Map(), now,
        walletView({ walletBalance, availableBalance: walletBalance - 20, fetchedAt: now }, null, now));
      expect(r.summary.net).toBeCloseTo(-2.1); expect(r.summary.estimatedNet).toBeCloseTo(-2.1);
      expect(r.wallet.snapshot?.walletBalance).toBe(walletBalance);
      expect(r.summary).not.toHaveProperty("cashEquity"); expect(r).not.toHaveProperty("initialEquity");
    }
  });
  it("keeps settlement pending and safety exits explicit without changing the source", () => {
    const s = source([trade("pending", 1, .1, { state: "SETTLING", settlementComplete: false }),
      trade("safety", -.01, .03, { safetyExitReason: "NATIVE_PROTECTION_UNAVAILABLE" })]);
    s.fundingThrough = now - 200000;
    const before = JSON.stringify(s); const report = buildAstraReport(s, new Map(), now);
    expect(report.summary).toMatchObject({ closedN: 1, pendingN: 1, settlementPending: true, fundingCurrent: false });
    expect(report.closed[0].exitReason).toBe("NATIVE_PROTECTION_UNAVAILABLE"); expect(JSON.stringify(s)).toBe(before);
  });
  it("does not truncate the lifetime closed ledger at 50 records", () => {
    const r = buildAstraReport(source(Array.from({ length: 65 }, (_, i) => trade(String(i), 1, .1))), new Map(), now);
    expect(r.closed).toHaveLength(65); expect(r.summary.closedNet).toBeCloseTo(58.5);
  });
});
describe("private learning ingestion / public read projection", () => {
  function setup() { const dir = mkdtempSync(join(tmpdir(), "astra-learning-")); dirs.push(dir); const file = join(dir, "learning.json"); return { file, store: new AstraLearningStore(file, () => now) }; }
  const snapshot = () => ({ publishedAt: now, memoryUpdatedAt: now - 100, memoryText: "Hypothesis, not a validated edge.", cycleCount: 2, completedCycles: 1,
    cycles: [{ at: now - 50, completed: true, apiCalls: 3, response: "WAIT", inspectedSymbols: ["币安人生USDT"] }] });
  it("persists only display fields and survives reload", () => {
    const x = setup(); expect(x.store.read().status).toBe("MISSING");
    x.store.accept({ ...snapshot(), auth: "must-not-be-persisted", rawMessages: ["private reasoning"] });
    expect(readFileSync(x.file, "utf8")).not.toContain("must-not"); expect(readFileSync(x.file, "utf8")).not.toContain("rawMessages");
    expect(new AstraLearningStore(x.file, () => now).read()).toMatchObject({ status: "AVAILABLE", snapshot: snapshot() });
    expect(new AstraLearningStore(x.file, () => now + 900001).read().status).toBe("STALE");
  });
  it("rejects invalid/future/stale uploads, preserves prior valid report", () => {
    const x = setup(); x.store.accept(snapshot());
    for (const invalid of [null, { ...snapshot(), publishedAt: now + 120001 }, { ...snapshot(), publishedAt: now - 1 }, { ...snapshot(), cycleCount: -1 }, { ...snapshot(), memoryText: "x".repeat(12001) }])
      expect(() => x.store.accept(invalid)).toThrow();
    expect(x.store.read().snapshot?.memoryText).toBe(snapshot().memoryText);
  });
  it("reports unreadable evidence instead of resetting learned history", () => {
    const x = setup(); writeFileSync(x.file, "broken"); expect(x.store.read()).toEqual({ status: "UNREADABLE", snapshot: null });
  });
});

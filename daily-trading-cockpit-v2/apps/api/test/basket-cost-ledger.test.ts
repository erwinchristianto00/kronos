import { describe, expect, it } from "vitest";
import { reconcileBasketCosts, type CostLeg } from "../src/lib/basket-cost-ledger.js";
import { accountLegSlices } from "../src/lib/basket-fill-accounting.js";
import { estimateNetLiquidation } from "../src/lib/cross-profit-protection-v1.js";
import type { FuturesUserTrade, FuturesIncomeEntry } from "../src/lib/binance-futures-private.js";
function input() {
  const leg: CostLeg = { symbol: "AAA", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "entry", exitOrderId: null, exitPrice: null,
    exitFills: [{ orderId: "exit", qty: .5, price: 110, priceConfirmed: true }] };
  const trades: FuturesUserTrade[] = [
    { symbol: "AAA", orderId: "entry", tradeId: "1", price: 100, qty: 1, commission: .04, commissionAsset: "USDT", time: 1100, realizedPnl: 0 },
    { symbol: "AAA", orderId: "exit", tradeId: "2", price: 110, qty: .5, commission: .022, commissionAsset: "USDT", time: 1500, realizedPnl: 5 },
  ];
  const income: FuturesIncomeEntry[] = [{ symbol: "AAA", incomeType: "FUNDING_FEE", income: -.01, asset: "USDT", time: 1400, tranId: "fund", info: "" }];
  return { legs: [leg], trades: new Map([["AAA", trades]]), income, positions: new Map([["AAA", .5]]), openedAtMs: 1000, cutoffMs: 2000, exclusive: true };
}
describe("basket actual cost coverage", () => {
  it("counts paid entry and partial exit fees once, signed funding, and exact residual", () => {
    const x = input(), costs = reconcileBasketCosts(x);
    expect(costs.complete).toBe(true);
    expect(costs.feesUsd).toBeCloseTo(.062);
    expect(costs.fundingUsd).toBe(-.01);
    const e = estimateNetLiquidation({ legs: x.legs, nowMs: 2000, maxQuoteAgeMs: 15000,
      quotes: new Map([["AAA", { symbol: "AAA", bidPrice: 90, askPrice: 91, bidQty: .5, askQty: 2, observedAtMs: 2000 }]]),
      realizedFeesUsd: costs.feesUsd!, fundingUsd: costs.fundingUsd!, remainingExitCostBps: 4 });
    expect(e.remainingExitCostUsd).toBeCloseTo(.018); // 0.5 residual × bid90 × 4bps
    expect(e.netPnlUsd).toBeCloseTo(-.09);
  });
  it.each(["missing", "duplicate", "external", "asset", "shared", "position", "saturated", "funding-duplicate", "funding-saturated", "entry-price", "exit-price"])("fails closed on %s coverage", mode => {
    const x = input(), rows = x.trades.get("AAA")!;
    if (mode === "missing") rows.pop();
    if (mode === "duplicate") rows.push(rows[0]!);
    if (mode === "external") rows.push({ ...rows[0]!, orderId: "outside", tradeId: "outside" });
    if (mode === "asset") rows[0]!.commissionAsset = "BNB";
    if (mode === "entry-price") rows[0]!.price = 101;
    if (mode === "exit-price") rows[1]!.price = 111;
    if (mode === "shared") x.exclusive = false;
    if (mode === "position") x.positions.set("AAA", 1);
    if (mode === "saturated") x.trades.set("AAA", Array(1000).fill(rows[0]));
    if (mode === "funding-duplicate") x.income.push(x.income[0]!);
    if (mode === "funding-saturated") x.income = Array(1000).fill(x.income[0]);
    const c = reconcileBasketCosts(x);
    expect(c.complete).toBe(false); expect(c.feesUsd).toBeNull(); expect(c.fundingUsd).toBeNull();
  });
  it("never interprets no trade coverage as zero paid fees", () => {
    const x = input(); x.trades.clear();
    expect(reconcileBasketCosts(x).complete).toBe(false);
  });
  it("rejects duplicate/overfilled/unconfirmed slices and preserves original N0", () => {
    const l = input().legs[0]!;
    expect(accountLegSlices(l)?.initialNotionalUsd).toBe(100);
    expect(accountLegSlices({ ...l, exitFills: [...l.exitFills!, ...l.exitFills!] })).toBeNull();
    expect(accountLegSlices({ ...l, qty: .1 })).toBeNull();
    expect(accountLegSlices({ ...l, exitFills: [{ ...l.exitFills![0]!, priceConfirmed: false }] })).toBeNull();
  });
});

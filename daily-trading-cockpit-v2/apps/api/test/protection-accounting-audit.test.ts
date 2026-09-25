// Regression: formerly incorrect mark/net-liq outputs must equal the independent fill-slice oracle.
import { describe, expect, it } from "vitest";
import { markBasketAgainstFullNotional, type ExecutorLeg } from "../src/lib/cross-sectional-executor.js";
import { estimateNetLiquidation, type BookQuote } from "../src/lib/cross-profit-protection-v1.js";

function fixture() {
  const legs = Array.from({ length: 6 }, (_, i) => ({
    symbol: `AUDIT${i}`, side: i < 3 ? "LONG" : "SHORT", qty: 1,
    entryPrice: 100, exitPrice: null, exitFills: [],
  })) as unknown as ExecutorLeg[];
  return { legs, marks: new Map(legs.map(l => [l.symbol, 100])) };
}

describe("AUDIT current accounting versus fill-slice oracle", () => {
  it("whole-leg close preserves realized PnL and original $600 N0", () => {
    const { legs, marks } = fixture();
    legs[0]!.exitPrice = 110;
    marks.set(legs[0]!.symbol, 90);
    const result = markBasketAgainstFullNotional(legs, marks, 0)!;
    expect(result.grossCapitalUsd).toBe(600);
    expect(result.grossPnlUsd).toBe(10);
  });

  it.each([ [110, 90, -10], [90, 110, 10] ])(
    "partial slice filled at %s then marked at %s has current error $%s",
    (fillPrice, mark, error) => {
      const { legs, marks } = fixture();
      Object.assign(legs[0]!, { exitFills: [{ orderId: 1, qty: 0.5, price: fillPrice, priceConfirmed: true }] });
      marks.set(legs[0]!.symbol, mark);
      const actual = markBasketAgainstFullNotional(legs, marks, 0)!;
      const oracle = 0.5 * (fillPrice - 100) + 0.5 * (mark - 100);
      expect(actual.grossCapitalUsd).toBe(600);
      expect(oracle).toBe(0);
      expect(actual.grossPnlUsd - oracle).toBe(0);
      expect((actual.netReturn - oracle / 600) * 100).toBe(0);
    },
  );

  it("current net-liq representation also reprices an already filled half", () => {
    const { legs, marks } = fixture();
    Object.assign(legs[0]!, { exitFills: [{ orderId: 1, qty: 0.5, price: 110, priceConfirmed: true }] });
    marks.set(legs[0]!.symbol, 90);
    const quotes = new Map<string, BookQuote>(legs.map(l => [l.symbol, {
      symbol: l.symbol, bidPrice: marks.get(l.symbol)!, askPrice: marks.get(l.symbol)!,
      bidQty: 100, askQty: 100, observedAtMs: 1000,
    }]));
    const result = estimateNetLiquidation({ legs: legs.map(l => ({
      symbol: l.symbol, side: l.side, qty: l.qty, entryPrice: l.entryPrice, exitPrice: l.exitPrice, exitFills: l.exitFills,
    })), quotes, nowMs: 1000, maxQuoteAgeMs: 15000, realizedFeesUsd: 0, fundingUsd: 0, remainingExitCostBps: 0 });
    expect(result.usable).toBe(true);
    expect(result.realizedPnlUsd).toBe(5);
    expect(result.netPnlUsd).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  computeTakerFlowFeatures,
  computeDepthImbalance,
  computeSpreadBps,
  computeExpectedSlippageBps,
  parseDepthPayload,
  buildMicrostructureSnapshot,
} from "../src/lib/order-flow-microstructure.js";
import type { FuturesAggTradeSnapshot } from "../src/lib/binance.js";

function trade(qty: number, isBuyerMaker: boolean, ts: number): FuturesAggTradeSnapshot {
  return { price: 100, quantity: qty, isBuyerMaker, timestamp: ts };
}

describe("taker flow features", () => {
  it("computes buy ratio and signed volume (isBuyerMaker=true -> SELL taker)", () => {
    const trades = [trade(10, false, 1000), trade(4, true, 1200), trade(6, false, 1400)];
    const f = computeTakerFlowFeatures(trades);
    expect(f.buyVolume).toBeCloseTo(16, 6); // the two isBuyerMaker=false trades
    expect(f.sellVolume).toBeCloseTo(4, 6);
    expect(f.takerBuyRatio).toBeCloseTo(16 / 20, 6);
    expect(f.signedVolume).toBeCloseTo(12, 6);
    expect(f.tradeCount).toBe(3);
    expect(f.tradeIntensityPerSec).toBeCloseTo(3 / 0.4, 3); // 400ms span
  });

  it("returns null buy ratio / intensity with no trades", () => {
    const f = computeTakerFlowFeatures([]);
    expect(f.takerBuyRatio).toBeNull();
    expect(f.tradeIntensityPerSec).toBeNull();
    expect(f.totalVolume).toBe(0);
  });

  it("ignores non-finite / non-positive quantities defensively", () => {
    const bad = { price: 100, quantity: NaN, isBuyerMaker: false, timestamp: 1 } as FuturesAggTradeSnapshot;
    const f = computeTakerFlowFeatures([bad, trade(5, false, 2)]);
    expect(f.buyVolume).toBeCloseTo(5, 6);
  });
});

describe("spread + depth imbalance", () => {
  it("computes spread in bps", () => {
    expect(computeSpreadBps(99.9, 100.1)).toBeCloseTo(20, 1); // 0.2/100*10000
  });

  it("returns null for an invalid/crossed book", () => {
    expect(computeSpreadBps(100.1, 99.9)).toBeNull();
    expect(computeSpreadBps(0, 100)).toBeNull();
  });

  it("computes bid-heavy imbalance within the bps window", () => {
    const depth = parseDepthPayload({
      bids: [["100", "50"], ["99.5", "20"]], // within 1% window of mid ~100
      asks: [["100.1", "10"]],
    });
    const r = computeDepthImbalance(depth, 100, 100.1, 100); // 100bps = 1% window
    expect(r.bidDepthWithinWindow).toBeCloseTo(70, 6);
    expect(r.askDepthWithinWindow).toBeCloseTo(10, 6);
    expect(r.imbalance).toBeCloseTo((70 - 10) / 80, 6);
  });

  it("excludes levels outside the bps window", () => {
    const depth = parseDepthPayload({
      bids: [["100", "50"], ["90", "1000"]], // 90 is far outside a tight window
      asks: [["100.1", "10"]],
    });
    const r = computeDepthImbalance(depth, 100, 100.1, 10); // 10bps = 0.1% window
    expect(r.bidDepthWithinWindow).toBeCloseTo(50, 6); // the 90-priced level excluded
  });

  it("returns null imbalance when both sides are empty within the window", () => {
    const depth = parseDepthPayload({ bids: [], asks: [] });
    const r = computeDepthImbalance(depth, 100, 100.1, 10);
    expect(r.imbalance).toBeNull();
  });
});

describe("expected slippage", () => {
  it("computes 0 slippage when the full size fills at the best level", () => {
    const depth = parseDepthPayload({ bids: [["100", "50"]], asks: [["100.1", "50"]] });
    // BUY $1000 notional at best ask 100.1, level has 50*100.1=5005 available -> fills entirely at best
    expect(computeExpectedSlippageBps(depth, "BUY", 1000)).toBeCloseTo(0, 6);
  });

  it("computes positive slippage when the order must walk through multiple levels", () => {
    const depth = parseDepthPayload({
      bids: [],
      asks: [["100", "1"], ["101", "1"], ["102", "10"]], // thin top-of-book
    });
    // BUY needs $250: $100 at 100, $101 at 101, remaining $49 at 102
    const bps = computeExpectedSlippageBps(depth, "BUY", 250)!;
    expect(bps).toBeGreaterThan(0);
  });

  it("returns null when the book is too thin to fill the requested notional", () => {
    const depth = parseDepthPayload({ bids: [], asks: [["100", "0.01"]] }); // only $1 of depth
    expect(computeExpectedSlippageBps(depth, "BUY", 1000)).toBeNull();
  });

  it("returns null for non-positive notional or empty book", () => {
    const depth = parseDepthPayload({ bids: [], asks: [] });
    expect(computeExpectedSlippageBps(depth, "BUY", 100)).toBeNull();
    const depth2 = parseDepthPayload({ bids: [], asks: [["100", "10"]] });
    expect(computeExpectedSlippageBps(depth2, "BUY", 0)).toBeNull();
  });
});

describe("full microstructure snapshot", () => {
  it("composes taker flow + spread + depth imbalance + slippage into one snapshot", () => {
    const trades = [trade(10, false, 1000), trade(5, true, 1100)];
    const snap = buildMicrostructureSnapshot({
      symbol: "BTCUSDT",
      capturedAtMs: 5000,
      trades,
      depthPayload: { bids: [["100", "50"]], asks: [["100.1", "50"]] },
      bestBid: 100,
      bestAsk: 100.1,
      depthBpsWindow: 100,
      sizeNotionalUsd: 500,
    });
    expect(snap.symbol).toBe("BTCUSDT");
    expect(snap.spreadBps).toBeCloseTo(9.99, 1);
    expect(snap.takerFlow.takerBuyRatio).toBeCloseTo(10 / 15, 6);
    expect(snap.depthImbalance?.imbalance).not.toBeNull();
    expect(snap.expectedSlippageBpsBuy).toBeCloseTo(0, 6);
    expect(snap.expectedSlippageBpsSell).toBeCloseTo(0, 6);
  });

  it("omits spread/depth-imbalance when bid/ask are unavailable, but still computes taker flow", () => {
    const snap = buildMicrostructureSnapshot({
      symbol: "ETHUSDT",
      capturedAtMs: 1,
      trades: [trade(3, false, 1)],
      depthPayload: { bids: [], asks: [] },
      bestBid: null,
      bestAsk: null,
    });
    expect(snap.spreadBps).toBeNull();
    expect(snap.depthImbalance).toBeNull();
    expect(snap.takerFlow.buyVolume).toBeCloseTo(3, 6);
  });
});

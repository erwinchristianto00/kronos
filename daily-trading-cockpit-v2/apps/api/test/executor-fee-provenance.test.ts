/**
 * FEE PROVENANCE — SingleSymbolLaneExecutor (2026-07-26).
 *
 * feeEstimateUsd on a closed position is written by TWO different mechanisms with the same name,
 * same units and no way to tell them apart: a real exchange commission summed from getUserTrades,
 * and a flat `notional × TAKER_FEE_RATE` model used whenever the trades fetch fails. On the live
 * mainnet instance, 7 of 21 closed positions turned out to be the modelled arm — indistinguishable
 * from the measured ones after the fact, and therefore unusable for any cost analysis.
 * `feeSource` records which arm produced the number.
 *
 * FAILS WITHOUT THE FIX: `SingleSymbolPosition.feeSource` does not exist on pre-fix code, so every
 * assertion below reads `undefined`.
 *
 * Deliberately a separate file with its own small harness rather than an addition to
 * single-symbol-lane-executor.test.ts: that file's 1200-line fixture is under concurrent edit for
 * the fee-WINDOW work, and these cases need only an open→close cycle.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import type {
  FuturesAlgoOrder,
  FuturesOrder,
  FuturesPosition,
  FuturesSymbolFilters,
  FuturesUserTrade,
  PlaceAlgoOrderParams,
  PlaceOrderParams,
} from "../src/lib/binance-futures-private.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type SingleSymbolExecClient,
  type SingleSymbolFreshSignal,
} from "../src/lib/single-symbol-lane-executor.js";

const NOW = "2026-07-26T03:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const dirs: string[] = [];
let seq = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `fee-prov-${process.pid}-${++seq}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

function signal(): SingleSymbolFreshSignal {
  return {
    observationId: "sf:BTCUSDT:1",
    symbol: "BTCUSDT",
    entryPrice: 60000,
    stopPrice: 61800, // SHORT: stop 300bps above entry
    openedAtMs: NOW_MS - 5 * 60_000,
  };
}

class FakeClient implements SingleSymbolExecClient {
  /** Throw from getUserTrades — the ONLY way the executor falls back to the flat-rate model. */
  failUserTrades = false;
  /** When set, every reduceOnly (i.e. closing) MARKET order also lands a matching /userTrades row,
   *  so the executor's settlement can find it. The order id is assigned inside placeOrder, so the
   *  fixture cannot pre-register it by hand. */
  exitFill: { realizedPnl: number; commission: number } | null = null;
  fillPriceBySymbol = new Map<string, number>([["BTCUSDT", 60000]]);
  markPriceBySymbol = new Map<string, number>();
  algoTriggeredOrderId = new Map<string, string | null>();
  userTradesByOrderId = new Map<string, FuturesUserTrade>();
  private orderSeq = 100;
  private algoSeq = 900;

  private buildOrder(symbol: string, side: "BUY" | "SELL", quantity: number, reduceOnly: boolean | undefined, orderId: string, avgPrice: number): FuturesOrder {
    return {
      symbol, orderId, clientOrderId: "", status: avgPrice > 0 ? "FILLED" : "NEW", type: "MARKET", side,
      reduceOnly: Boolean(reduceOnly), price: 0, stopPrice: 0, origQty: quantity,
      executedQty: avgPrice > 0 ? quantity : 0, avgPrice, updateTime: 0,
    };
  }

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    return new Map([["BTCUSDT", {
      symbol: "BTCUSDT", stepSize: 0.001, minQty: 0.001, tickSize: 0.01,
      minNotional: 5, pricePrecision: 2, quantityPrecision: 3,
    }]]);
  }
  async setLeverage(): Promise<void> { /* noop */ }
  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    const entries = Array.from(this.markPriceBySymbol.keys()).map((sym) => ({
      symbol: sym, positionAmt: 0, entryPrice: 0, markPrice: this.markPriceBySymbol.get(sym) ?? 0,
      liquidationPrice: 0, unRealizedProfit: 0, leverage: 3, marginType: "ISOLATED" as const,
    }));
    return symbol ? entries.filter((p) => p.symbol === symbol) : entries;
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    const orderId = String(this.orderSeq++);
    const price = this.fillPriceBySymbol.get(params.symbol) ?? 0;
    if (params.reduceOnly && this.exitFill !== null) {
      this.userTradesByOrderId.set(orderId, {
        symbol: params.symbol, orderId, price, qty: params.quantity,
        realizedPnl: this.exitFill.realizedPnl, commission: this.exitFill.commission,
        commissionAsset: "USDT", time: NOW_MS,
      });
    }
    return this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, orderId, price);
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    return this.buildOrder(symbol, "BUY", 0, false, orderId, 0);
  }
  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    const algoId = String(this.algoSeq++);
    this.algoTriggeredOrderId.set(algoId, null);
    return {
      symbol: params.symbol, algoId, clientAlgoId: params.clientAlgoId ?? "", algoStatus: "WORKING",
      orderType: params.type, side: params.side, quantity: params.quantity, triggerPrice: params.triggerPrice, actualOrderId: null,
    };
  }
  async queryAlgoOrder(algoId: string): Promise<FuturesAlgoOrder> {
    const actualOrderId = this.algoTriggeredOrderId.get(algoId) ?? null;
    return {
      symbol: "BTCUSDT", algoId, clientAlgoId: "", algoStatus: actualOrderId !== null ? "EXECUTED" : "WORKING",
      orderType: "STOP_MARKET", side: "BUY", quantity: 0, triggerPrice: 0, actualOrderId,
    };
  }
  async cancelAlgoOrder(): Promise<void> { /* noop */ }
  async getUserTrades(): Promise<FuturesUserTrade[]> {
    if (this.failUserTrades) throw new Error("simulated getUserTrades outage");
    return Array.from(this.userTradesByOrderId.values());
  }

  /** Mark a resting algo stop as triggered, with the real fill it produced. */
  triggerAlgo(algoId: string, actualOrderId: string, realizedPnl: number, commission: number, price: number, qty: number): void {
    this.algoTriggeredOrderId.set(algoId, actualOrderId);
    this.userTradesByOrderId.set(actualOrderId, {
      symbol: "BTCUSDT", orderId: actualOrderId, price, qty, realizedPnl, commission,
      commissionAsset: "USDT", time: NOW_MS,
    });
  }
}

function makeExecutor(client: FakeClient) {
  const store = new SingleSymbolLaneExecutorStore(tmpDir(), "fee-provenance.json");
  const executor = new SingleSymbolLaneExecutor({
    client,
    store,
    laneId: "SHORT_FADE_EXHAUSTION_CROWDED",
    direction: "SHORT",
    getOpenSignals: () => [signal()],
    exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
    isAllowed: () => true,
    laneWeightPct: () => 100,
    legUsd: () => 10_000,
    leverage: () => 3,
    maxOpenPositions: () => 1,
    dailyMaxLossUsd: () => 0,
    nowIso: () => NOW,
    fillConfirmRetryDelayMs: 0,
    existingNotionalForSymbol: () => 0,
    maxNotionalPerSymbolAcrossLanes: () => 0,
    existingClusterOpenSymbols: () => new Set<string>(),
    maxClusterPositionsAcrossLanes: () => 0,
  });
  return { executor, store };
}

describe("SingleSymbolPosition.feeSource — provenance of feeEstimateUsd", () => {
  it("EXCHANGE when the settlement summed real getUserTrades commission rows (stop-out path)", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor(client);
    await executor.tick(); // open
    await executor.tick(); // arm the stop
    const opened = store.getState().positions[0]!;

    client.triggerAlgo(opened.stopAlgoOrderId!, "9001", -1.8, 0.03, 61800, opened.qty);
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.closeReason).toBe("INITIAL_STOP");
    // This path NEVER models: it returns early and retries next tick rather than settling from an
    // estimate, so a CLOSED record here is always exchange-sourced.
    expect(closed.feeSource).toBe("EXCHANGE");
    expect(closed.feeEstimateUsd).toBeGreaterThan(0);
  });

  it("EXCHANGE on a policy-driven close whose exit trades ARE retrievable", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor(client);
    await executor.tick(); // open
    await executor.tick(); // arm the stop
    const opened = store.getState().positions[0]!;

    // Price runs to the 0.5R target ⇒ the exit policy closes with a market order, and the exit
    // fill is visible in getUserTrades.
    expect(opened.status).toBe("OPEN");
    client.markPriceBySymbol.set("BTCUSDT", 59100);
    client.fillPriceBySymbol.set("BTCUSDT", 59100);
    client.exitFill = { realizedPnl: 1.5, commission: 0.029 };
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.feeSource).toBe("EXCHANGE");
    // The recorded fee is a real commission row, not 5bps of notional.
    const flatModel = (opened.entryPrice * opened.qty + 59100 * opened.qty) * 0.0005;
    expect(closed.feeEstimateUsd).not.toBeCloseTo(flatModel, 6);
  });

  it("ESTIMATE_TAKER_FLAT when getUserTrades throws and the close falls back to the flat-rate model", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor(client);
    await executor.tick(); // open
    await executor.tick(); // arm the stop
    const opened = store.getState().positions[0]!;

    client.markPriceBySymbol.set("BTCUSDT", 59100); // hits the 0.5R target ⇒ policy close
    client.fillPriceBySymbol.set("BTCUSDT", 59100);
    client.failUserTrades = true; // the exchange settlement is unavailable this tick
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED"); // still closes — bookkeeping must not block a real close
    // The number is a MODEL: notional × TAKER_FEE_RATE (5bps/side), not a commission Binance
    // charged. Without feeSource it sits in the same field as a measured fee and reads identically.
    expect(closed.feeSource).toBe("ESTIMATE_TAKER_FLAT");
    const notional = opened.entryPrice * opened.qty + 59100 * opened.qty;
    expect(closed.feeEstimateUsd).toBeCloseTo(notional * 0.0005, 9);
  });

  it("ESTIMATE_TAKER_FLAT on a MIXED total — a genuinely measured partial leg plus a modelled final leg", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor(client);
    await executor.tick(); // open
    await executor.tick(); // arm the stop
    const opened = store.getState().positions[0]!;
    const fullQty = opened.qty;

    // The stop triggers but only HALF fills; that leg's real commission is banked from the exchange.
    client.triggerAlgo(opened.stopAlgoOrderId!, "9001", -0.9, 0.03, 61800, fullQty / 2);
    await executor.tick();
    const partial = store.getState().positions[0]!;
    expect(partial.status).toBe("OPEN");
    expect(partial.realizedPartialFeeUsd ?? 0).toBeGreaterThan(0); // a REAL measured component

    // The remainder is then closed on a tick where the trades fetch is unavailable.
    await executor.tick(); // re-arm a fresh stop for the remainder
    client.markPriceBySymbol.set("BTCUSDT", 59100);
    client.fillPriceBySymbol.set("BTCUSDT", 59100);
    client.failUserTrades = true;
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    // A total carrying ANY modelled component must be excluded from cost analysis exactly as a
    // fully-modelled one is — labelling this EXCHANGE because part of it was measured would be the
    // most dangerous of the three outcomes.
    expect(closed.feeSource).toBe("ESTIMATE_TAKER_FLAT");
  });

  it("[2026-07-27] entryLegFoldedIntoPnl is UNDEFINED (never false) on the flat-estimate arm, even when the entry row WAS seen", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor(client);
    await executor.tick(); // open
    await executor.tick(); // arm the stop
    const opened = store.getState().positions[0]!;

    // The ENTRY row IS in the widened window (this is exactly what the fee-window fix made
    // visible), but the EXIT order's row has not been published yet — a documented real race.
    // settled !== null with exitQty === 0 ⇒ closePosition takes the flat-estimate arm.
    client.userTradesByOrderId.set(opened.entryOrderId, {
      symbol: "BTCUSDT", orderId: opened.entryOrderId, price: 60000, qty: opened.qty,
      realizedPnl: 0, commission: 0.03218755, commissionAsset: "USDT", time: NOW_MS,
    });
    client.markPriceBySymbol.set("BTCUSDT", 59100); // hits the 0.5R target ⇒ policy close
    client.fillPriceBySymbol.set("BTCUSDT", 59100);
    client.exitFill = null; // no exit trade row ⇒ exitQty === 0
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.feeSource).toBe("ESTIMATE_TAKER_FLAT");
    // The entry commission WAS measured and is recorded — that part is the whole point.
    expect(closed.entryCommissionUsd).toBeCloseTo(0.03218755, 12);

    // …but this arm's feeEstimateUsd is notional × TAKER_FEE_RATE over BOTH sides, i.e. it already
    // contains a MODELLED entry fee. Writing `false` here (the pre-fix behaviour) advertises the
    // totals as exit-side only and invites the obvious reconstruction
    //   trueFee = feeEstimateUsd + (entryLegFoldedIntoPnl === false ? entryCommissionUsd : 0)
    // which double-counts the entry commission. `undefined` = "not answerable, do not reconstruct".
    expect(closed.entryLegFoldedIntoPnl).toBeUndefined();
    expect(closed.entryLegFoldedIntoPnl).not.toBe(false);

    // Proof that the estimate really does model both sides (so `false` would have been wrong):
    const notional = opened.entryPrice * opened.qty + 59100 * opened.qty;
    expect(closed.feeEstimateUsd).toBeCloseTo(notional * 0.0005, 9);
  });
});

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
  makeMfeGivebackExitPolicy,
  type SingleSymbolExecClient,
  type SingleSymbolFreshSignal,
} from "../src/lib/single-symbol-lane-executor.js";

const NOW = "2026-07-08T03:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

const dirs: string[] = [];
let n = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `ssle-${process.pid}-${++n}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

function signal(over: Partial<SingleSymbolFreshSignal> = {}): SingleSymbolFreshSignal {
  return {
    observationId: "sf:BTCUSDT:1",
    symbol: "BTCUSDT",
    entryPrice: 60000,
    stopPrice: 61800, // SHORT: stop above entry, 300bps
    openedAtMs: NOW_MS - 5 * 60_000,
    ...over,
  };
}

class FakeClient implements SingleSymbolExecClient {
  placed: PlaceOrderParams[] = [];
  algosPlaced: PlaceAlgoOrderParams[] = [];
  algosCancelled: number[] = [];
  failOnSymbol: string | null = null;
  failAlgoOnce = false;
  fillPriceBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  queryOrderAvgPriceBySymbol = new Map<string, number>();
  /** algoId -> actualOrderId (null = still resting/not triggered). */
  algoTriggeredOrderId = new Map<number, number | null>();
  userTradesByOrderId = new Map<number, FuturesUserTrade>();
  private orderSeq = 100;
  private algoSeq = 900;

  private buildOrder(symbol: string, side: "BUY" | "SELL", quantity: number, reduceOnly: boolean | undefined, orderId: number, avgPrice: number): FuturesOrder {
    return {
      symbol, orderId, clientOrderId: "", status: avgPrice > 0 ? "FILLED" : "NEW", type: "MARKET", side,
      reduceOnly: Boolean(reduceOnly), price: 0, stopPrice: 0, origQty: quantity,
      executedQty: avgPrice > 0 ? quantity : 0, avgPrice, updateTime: 0,
    };
  }

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    const f = (stepSize: number, minQty: number): FuturesSymbolFilters =>
      ({ symbol: "X", stepSize, minQty, tickSize: 0.01, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 });
    return new Map([
      ["BTCUSDT", f(0.001, 0.001)],
      ["ETHUSDT", f(0.01, 0.01)],
    ]);
  }
  async setLeverage(): Promise<void> {}
  async getPositions(): Promise<FuturesPosition[]> {
    return Array.from(this.markPriceBySymbol.entries()).map(([symbol, markPrice]) => ({
      symbol, positionAmt: 0, entryPrice: 0, markPrice, liquidationPrice: 0, unRealizedProfit: 0, leverage: 3, marginType: "ISOLATED",
    }));
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    if (this.failOnSymbol === params.symbol) throw new Error(`exchange rejected ${params.symbol}`);
    this.placed.push(params);
    const orderId = this.orderSeq++;
    const avgPrice = this.fillPriceBySymbol.get(params.symbol) ?? 0;
    return this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, orderId, avgPrice);
  }
  async queryOrder(symbol: string, orderId: number): Promise<FuturesOrder> {
    const avgPrice = this.queryOrderAvgPriceBySymbol.get(symbol) ?? 0;
    return this.buildOrder(symbol, "BUY", 0, false, orderId, avgPrice);
  }
  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    if (this.failAlgoOnce) {
      this.failAlgoOnce = false;
      throw new Error("algo order rejected (transient)");
    }
    this.algosPlaced.push(params);
    const algoId = this.algoSeq++;
    this.algoTriggeredOrderId.set(algoId, null); // resting by default
    return {
      symbol: params.symbol, algoId, clientAlgoId: params.clientAlgoId ?? "", algoStatus: "WORKING",
      orderType: params.type, side: params.side, quantity: params.quantity, triggerPrice: params.triggerPrice, actualOrderId: null,
    };
  }
  async queryAlgoOrder(algoId: number): Promise<FuturesAlgoOrder> {
    const actualOrderId = this.algoTriggeredOrderId.get(algoId) ?? null;
    return {
      symbol: "BTCUSDT", algoId, clientAlgoId: "", algoStatus: actualOrderId !== null ? "EXECUTED" : "WORKING",
      orderType: "STOP_MARKET", side: "BUY", quantity: 0, triggerPrice: 0, actualOrderId,
    };
  }
  async cancelAlgoOrder(algoId: number): Promise<void> {
    this.algosCancelled.push(algoId);
  }
  async getUserTrades(_symbol: string): Promise<FuturesUserTrade[]> {
    return Array.from(this.userTradesByOrderId.values());
  }

  /** Test helper: mark a previously-placed algo stop as having triggered a real fill. */
  triggerAlgo(algoId: number, actualOrderId: number, realizedPnl: number, commission: number, price: number): void {
    this.algoTriggeredOrderId.set(algoId, actualOrderId);
    this.userTradesByOrderId.set(actualOrderId, {
      symbol: "BTCUSDT", orderId: actualOrderId, price, qty: 0, realizedPnl, commission, commissionAsset: "USDT", time: NOW_MS,
    });
  }
}

function makeExecutor(opts: {
  client?: FakeClient;
  direction?: "LONG" | "SHORT";
  signals?: SingleSymbolFreshSignal[];
  allowed?: boolean;
  laneWeightPct?: number;
  legUsd?: number;
  maxOpenPositions?: number;
  dailyMaxLossUsd?: number;
  exitPolicy?: ReturnType<typeof makeFixedRewardExitPolicy>;
} = {}) {
  const client = opts.client ?? new FakeClient();
  const storeDir = tmpDir();
  const store = new SingleSymbolLaneExecutorStore(storeDir, "test.json");
  store.getState().lastSeenSignalMs = NOW_MS - 3_600_000;
  const signals = opts.signals ?? [];
  const executor = new SingleSymbolLaneExecutor({
    client,
    store,
    laneId: "SHORT_FADE_EXHAUSTION_CROWDED",
    direction: opts.direction ?? "SHORT",
    getOpenSignals: () => signals,
    exitPolicy: opts.exitPolicy ?? makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
    isAllowed: () => opts.allowed ?? true,
    laneWeightPct: () => opts.laneWeightPct ?? 100,
    legUsd: () => opts.legUsd ?? 25,
    leverage: () => 3,
    maxOpenPositions: () => opts.maxOpenPositions ?? 1,
    dailyMaxLossUsd: () => opts.dailyMaxLossUsd ?? 0,
    nowIso: () => NOW,
    fillConfirmRetryDelayMs: 0,
  });
  return { executor, client, store, storeDir };
}

describe("makeFixedRewardExitPolicy (SHORT_FADE_EXHAUSTION geometry)", () => {
  const policy = makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 });

  it("holds while between the stop and the target", () => {
    const d = policy({ direction: "SHORT", entryPrice: 100, stopPrice: 103, currentPrice: 99, peakFavorableR: 0, msHeld: 0 });
    expect(d.shouldExit).toBe(false);
  });
  it("exits at the stop (favorableR <= -1)", () => {
    const d = policy({ direction: "SHORT", entryPrice: 100, stopPrice: 103, currentPrice: 103, peakFavorableR: 0, msHeld: 0 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("INITIAL_STOP");
  });
  it("exits at the 0.5R target for SHORT", () => {
    // risk = 3, target favorableR=0.5 => price moved 1.5 down from entry = 98.5
    const d = policy({ direction: "SHORT", entryPrice: 100, stopPrice: 103, currentPrice: 98.5, peakFavorableR: 0, msHeld: 0 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("TP_HIT");
  });
  it("exits on max-hold mark-to-market when neither stop nor target hit", () => {
    const d = policy({ direction: "SHORT", entryPrice: 100, stopPrice: 103, currentPrice: 99.5, peakFavorableR: 0, msHeld: 48 * 3_600_000 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("MAX_HOLD_MTM");
  });
  it("tracks peakFavorableR across calls even when not exiting", () => {
    const d = policy({ direction: "SHORT", entryPrice: 100, stopPrice: 103, currentPrice: 99, peakFavorableR: 0.2, msHeld: 0 });
    expect(d.nextPeakFavorableR).toBeCloseTo(1 / 3, 6); // (100-99)/3
  });
});

describe("makeMfeGivebackExitPolicy (INTRADAY_MOMENTUM_BREAKOUT geometry)", () => {
  const policy = makeMfeGivebackExitPolicy({ armR: 0.75, givebackFrac: 0.5, maxHoldMs: 24 * 3_600_000 });

  it("does not exit before arming even on a small pullback", () => {
    // risk=10 (entry 100, stop 90). peak so far 0.3R (price 103), now pulls back to 101 (0.1R) — never armed.
    const d = policy({ direction: "LONG", entryPrice: 100, stopPrice: 90, currentPrice: 101, peakFavorableR: 0.3, msHeld: 0 });
    expect(d.shouldExit).toBe(false);
  });
  it("arms at 0.75R then exits once price gives back half the peak", () => {
    // peak 1.5R (price 115), giveback line = 1.5*0.5=0.75R (price 107.5). Current 107 (0.7R) triggers.
    const d = policy({ direction: "LONG", entryPrice: 100, stopPrice: 90, currentPrice: 107, peakFavorableR: 1.5, msHeld: 0 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("MFE_GIVEBACK");
  });
  it("still exits at the stop even after arming", () => {
    const d = policy({ direction: "LONG", entryPrice: 100, stopPrice: 90, currentPrice: 90, peakFavorableR: 1.5, msHeld: 0 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("INITIAL_STOP");
  });
  it("mark-to-markets at max hold if never armed and never stopped", () => {
    const d = policy({ direction: "LONG", entryPrice: 100, stopPrice: 90, currentPrice: 100.5, peakFavorableR: 0.1, msHeld: 24 * 3_600_000 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("MAX_HOLD_MTM");
  });
});

describe("SingleSymbolLaneExecutor — entry", () => {
  it("opens a position from a fresh signal, sized from legUsd/allocation weight, and places a protective stop next tick", async () => {
    // legUsd effective = 120,000 * 50% = 60,000; entry 60,000 -> qty = 1.0 exactly (stepSize 0.001).
    const { executor, client, store } = makeExecutor({ signals: [signal()], legUsd: 120_000, laneWeightPct: 50 });
    await executor.tick();
    const st = store.getState();
    expect(st.positions.length).toBe(1);
    const pos = st.positions[0]!;
    expect(pos.status).toBe("OPEN");
    expect(pos.symbol).toBe("BTCUSDT");
    expect(pos.direction).toBe("SHORT");
    expect(pos.qty).toBeCloseTo(1, 6);
    expect(client.placed.length).toBe(1);
    expect(pos.stopAlgoOrderId).toBeNull(); // not yet placed on THIS tick

    await executor.tick(); // next tick: ensureStopOrder runs
    expect(client.algosPlaced.length).toBe(1);
    expect(store.getState().positions[0]!.stopAlgoOrderId).not.toBeNull();
  });

  it("skips a too-small notional that rounds to zero qty (below minQty)", async () => {
    const { executor, store } = makeExecutor({ signals: [signal()], legUsd: 1 }); // 1/60000 << minQty 0.001
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("ignores a stale signal older than maxSignalAgeMs default (50 min)", async () => {
    const { executor, store } = makeExecutor({ signals: [signal({ openedAtMs: NOW_MS - 60 * 60_000 })] });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("ignores a signal at/below the watermark (already claimed)", async () => {
    const { executor, store } = makeExecutor({ signals: [signal({ openedAtMs: NOW_MS - 3_600_000 - 1 })] });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("does not open when isAllowed() is false", async () => {
    const { executor, store } = makeExecutor({ signals: [signal()], allowed: false });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("does not open when 0% allocation weight zeroes legUsd", async () => {
    const { executor, store } = makeExecutor({ signals: [signal()], laneWeightPct: 0 });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("respects maxOpenPositions (default 1): a 2nd fresh signal doesn't open a 2nd position while one is already open", async () => {
    const signals: SingleSymbolFreshSignal[] = [signal({ openedAtMs: NOW_MS - 4 * 60_000 })];
    const { executor, store } = makeExecutor({ signals, legUsd: 10_000 });
    await executor.tick();
    expect(store.getState().positions.filter((p) => p.status === "OPEN").length).toBe(1);
    // A newer signal on a different symbol shows up — still capped at 1 open position.
    signals.push(signal({ observationId: "sf:ETHUSDT:2", symbol: "ETHUSDT", openedAtMs: NOW_MS - 1 * 60_000 }));
    await executor.tick();
    expect(store.getState().positions.filter((p) => p.status === "OPEN").length).toBe(1);
    expect(store.getState().positions.length).toBe(1); // no 2nd position record created at all
  });

  it("retries stop placement on a later tick if the first attempt failed (never leaves a position unprotected forever)", async () => {
    const client = new FakeClient();
    client.failAlgoOnce = true;
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // opens position
    await executor.tick(); // ensureStopOrder fails once
    expect(store.getState().positions[0]!.stopAlgoOrderId).toBeNull();
    await executor.tick(); // retries and succeeds
    expect(store.getState().positions[0]!.stopAlgoOrderId).not.toBeNull();
  });
});

describe("SingleSymbolLaneExecutor — exits", () => {
  it("[POLICY-EXIT] closes via reduceOnly market order and cancels the stop first when the exit policy fires", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    const algoId = store.getState().positions[0]!.stopAlgoOrderId!;
    // Price at 0.5R favorable for the SHORT (entry 60000, stop 61800 -> risk 1800, target 59100).
    client.markPriceBySymbol.set("BTCUSDT", 59000);
    await executor.tick();
    const pos = store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED");
    expect(pos.closeReason).toBe("TP_HIT");
    expect(client.algosCancelled).toContain(algoId);
    expect(client.placed.some((p) => p.reduceOnly === true)).toBe(true);
  });

  it("[STOP-TRIGGERED] settles from getUserTrades when the exchange-side stop has actually fired", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    const pos = store.getState().positions[0]!;
    const algoId = pos.stopAlgoOrderId!;
    client.triggerAlgo(algoId, 5555, -1.8, 0.05, 61800); // a real stop-out fill: -1.8 gross, 0.05 fee
    client.markPriceBySymbol.set("BTCUSDT", 61800); // irrelevant once settled via trades
    await executor.tick();
    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.closeReason).toBe("INITIAL_STOP");
    expect(closed.grossPnlUsd).toBeCloseTo(-1.8, 6);
    expect(closed.feeEstimateUsd).toBeCloseTo(0.05, 6);
    expect(closed.netPnlUsd).toBeCloseTo(-1.85, 6);
    expect(closed.exitPriceConfirmed).toBe(true);
  });

  it("[MFE-GIVEBACK] a momentum-style (LONG) position banks a faded winner via the giveback policy", async () => {
    const client = new FakeClient();
    const policy = makeMfeGivebackExitPolicy({ armR: 0.75, givebackFrac: 0.5, maxHoldMs: 24 * 3_600_000 });
    const longSignal = signal({ observationId: "im:ETHUSDT:1", symbol: "ETHUSDT", entryPrice: 2000, stopPrice: 1900 });
    const { executor, store } = makeExecutor({ client, direction: "LONG", signals: [longSignal], legUsd: 10_000, exitPolicy: policy });
    await executor.tick(); // open (risk = 100)
    await executor.tick(); // place stop
    client.markPriceBySymbol.set("ETHUSDT", 2150); // peak 1.5R
    await executor.tick(); // arms, no exit yet (no retrace)
    expect(store.getState().positions[0]!.status).toBe("OPEN");
    client.markPriceBySymbol.set("ETHUSDT", 2075); // retraced to 0.75R <= giveback line 0.75R
    await executor.tick();
    const pos = store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED");
    expect(pos.closeReason).toBe("MFE_GIVEBACK");
  });

  it("[DAILY-LOSS-BREAKER] halts NEW opens after the daily loss limit is breached, but never touches an open position", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000, dailyMaxLossUsd: 1 });
    // Seed a closed loss for today exceeding the limit.
    store.getState().positions.push({
      positionId: "seed", sourceObservationId: "seed", symbol: "BTCUSDT", direction: "SHORT", qty: 0.001,
      entryPrice: 100, entryOrderId: 1, entryPriceConfirmed: true, stopPrice: 103, stopAlgoOrderId: null,
      peakFavorableR: 0, openedAt: NOW, status: "CLOSED", closedAt: NOW, closeReason: "INITIAL_STOP",
      exitPrice: 103, exitOrderId: 2, exitPriceConfirmed: true, grossPnlUsd: -2, feeEstimateUsd: 0.1, netPnlUsd: -2.1,
    });
    await executor.tick();
    expect(store.getState().positions.filter((p) => p.status === "OPEN").length).toBe(0);
    expect(executor.getStatus().openHalted).toMatch(/daily loss breaker/);
  });
});

describe("SingleSymbolLaneExecutorStore — fileName isolation", () => {
  it("two stores with distinct fileName in the same dir do not collide", () => {
    const dir = tmpDir();
    const a = new SingleSymbolLaneExecutorStore(dir, "lane-a.json");
    a.getState().positions.push({
      positionId: "a1", sourceObservationId: "o1", symbol: "BTCUSDT", direction: "SHORT", qty: 1, entryPrice: 1,
      entryOrderId: 1, entryPriceConfirmed: true, stopPrice: 1.03, stopAlgoOrderId: null, peakFavorableR: 0,
      openedAt: NOW, status: "OPEN", closedAt: null, closeReason: null, exitPrice: null, exitOrderId: null,
      exitPriceConfirmed: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
    });
    a.save();
    const b = new SingleSymbolLaneExecutorStore(dir, "lane-b.json");
    expect(b.getState().positions.length).toBe(0);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import {
  BinanceFuturesPrivateError,
  type FuturesAlgoOrder,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
  type PlaceAlgoOrderParams,
  type PlaceOrderParams,
} from "../src/lib/binance-futures-private.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  makeMfeGivebackExitPolicy,
  type SingleSymbolExecClient,
  type SingleSymbolExitPolicy,
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
  algosCancelled: string[] = [];
  failOnSymbol: string | null = null;
  failAlgoOnce = false;
  /** Reject the NEXT reduceOnly placeOrder call with the given Binance error code (e.g. -2022),
   *  then clear itself. Non-reduceOnly retries are NOT rejected. */
  rejectNextReduceOnlyWithCode: number | null = null;
  /** Reject EVERY placeOrder call (reduceOnly or not) with a generic non-2022 error — simulates a
   *  persistent, non-recoverable-via-fallback close failure. */
  failAllPlaceOrders = false;
  fillPriceBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  queryOrderAvgPriceBySymbol = new Map<string, number>();
  /** algoId -> actualOrderId (null = still resting/not triggered). */
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
    const f = (stepSize: number, minQty: number): FuturesSymbolFilters =>
      ({ symbol: "X", stepSize, minQty, tickSize: 0.01, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 });
    return new Map([
      ["BTCUSDT", f(0.001, 0.001)],
      ["ETHUSDT", f(0.01, 0.01)],
      // Low-priced, coarse-stepSize symbol where minQty alone is NOT the binding constraint —
      // qty=1 clears minQty=1 but at entryPrice=0.10 the notional is only $0.10, well under
      // minNotional=5. Dedicated fixture for the minNotional regression test below.
      ["DOGEUSDT", f(1, 1)],
    ]);
  }
  setLeverageCalls: string[] = [];
  async setLeverage(symbol: string): Promise<void> {
    this.setLeverageCalls.push(symbol);
  }
  /** Simulates a position ALREADY open on the exchange for this symbol (e.g. owned by a sibling
   *  executor) — used by the [LEVERAGE-SKIP] test to verify setLeverage isn't called against it. */
  positionAmtBySymbol = new Map<string, number>();
  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    const symbols = new Set([...this.markPriceBySymbol.keys(), ...this.positionAmtBySymbol.keys()]);
    const entries = Array.from(symbols).map((sym) => ({
      symbol: sym, positionAmt: this.positionAmtBySymbol.get(sym) ?? 0, entryPrice: 0,
      markPrice: this.markPriceBySymbol.get(sym) ?? 0, liquidationPrice: 0, unRealizedProfit: 0, leverage: 3, marginType: "ISOLATED" as const,
    }));
    return symbol ? entries.filter((p) => p.symbol === symbol) : entries;
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    if (this.failOnSymbol === params.symbol) throw new Error(`exchange rejected ${params.symbol}`);
    if (this.failAllPlaceOrders) throw new Error("exchange rejected (persistent, non-recoverable)");
    if (params.reduceOnly && this.rejectNextReduceOnlyWithCode !== null) {
      const code = this.rejectNextReduceOnlyWithCode;
      this.rejectNextReduceOnlyWithCode = null;
      throw new BinanceFuturesPrivateError("binance_error", `Binance error HTTP 400 code ${code}: ReduceOnly Order is rejected.`, { httpStatus: 400, binanceCode: code });
    }
    this.placed.push(params);
    const orderId = String(this.orderSeq++);
    const avgPrice = this.fillPriceBySymbol.get(params.symbol) ?? 0;
    return this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, orderId, avgPrice);
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    const avgPrice = this.queryOrderAvgPriceBySymbol.get(symbol) ?? 0;
    return this.buildOrder(symbol, "BUY", 0, false, orderId, avgPrice);
  }
  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    if (this.failAlgoOnce) {
      this.failAlgoOnce = false;
      throw new Error("algo order rejected (transient)");
    }
    this.algosPlaced.push(params);
    const algoId = String(this.algoSeq++);
    this.algoTriggeredOrderId.set(algoId, null); // resting by default
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
  async cancelAlgoOrder(algoId: string): Promise<void> {
    this.algosCancelled.push(algoId);
  }
  async getUserTrades(_symbol: string): Promise<FuturesUserTrade[]> {
    return Array.from(this.userTradesByOrderId.values());
  }

  /** Test helper: mark a previously-placed algo stop as having triggered a real fill. */
  triggerAlgo(algoId: string, actualOrderId: string, realizedPnl: number, commission: number, price: number, qty = 1): void {
    this.algoTriggeredOrderId.set(algoId, actualOrderId);
    this.userTradesByOrderId.set(actualOrderId, {
      symbol: "BTCUSDT", orderId: actualOrderId, price, qty, realizedPnl, commission, commissionAsset: "USDT", time: NOW_MS,
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
  portfolioExitPolicy?: SingleSymbolExitPolicy;
  existingNotionalForSymbol?: (symbol: string) => number;
  maxNotionalPerSymbolAcrossLanes?: number;
  currentPrice?: number | null;
  sharedGetPositions?: () => ReturnType<FakeClient["getPositions"]>;
  tryClaimEntrySymbol?: (symbol: string) => boolean;
  releaseEntrySymbol?: (symbol: string) => void;
  timelineEntryGate?: (signal: SingleSymbolFreshSignal, direction: "LONG" | "SHORT") => Promise<{ allowed: boolean; reason: string | null }>;
} = {}) {
  const client = opts.client ?? new FakeClient();
  const storeDir = tmpDir();
  const store = new SingleSymbolLaneExecutorStore(storeDir, "test.json");
  const signals = opts.signals ?? [];
  const executor = new SingleSymbolLaneExecutor({
    client,
    store,
    laneId: "SHORT_FADE_EXHAUSTION_CROWDED",
    direction: opts.direction ?? "SHORT",
    getOpenSignals: () => signals,
    exitPolicy: opts.exitPolicy ?? makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
    portfolioExitPolicy: opts.portfolioExitPolicy,
    isAllowed: () => opts.allowed ?? true,
    laneWeightPct: () => opts.laneWeightPct ?? 100,
    legUsd: () => opts.legUsd ?? 25,
    leverage: () => 3,
    maxOpenPositions: () => opts.maxOpenPositions ?? 1,
    dailyMaxLossUsd: () => opts.dailyMaxLossUsd ?? 0,
    nowIso: () => NOW,
    fillConfirmRetryDelayMs: 0,
    existingNotionalForSymbol: opts.existingNotionalForSymbol ?? (() => 0),
    maxNotionalPerSymbolAcrossLanes: () => opts.maxNotionalPerSymbolAcrossLanes ?? 0,
    ...(opts.currentPrice !== undefined ? { currentPrice: async () => opts.currentPrice! } : {}),
    ...(opts.sharedGetPositions ? { sharedGetPositions: opts.sharedGetPositions } : {}),
    ...(opts.tryClaimEntrySymbol ? { tryClaimEntrySymbol: opts.tryClaimEntrySymbol } : {}),
    ...(opts.releaseEntrySymbol ? { releaseEntrySymbol: opts.releaseEntrySymbol } : {}),
    ...(opts.timelineEntryGate ? { timelineEntryGate: opts.timelineEntryGate } : {}),
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
  it("[TIMELINE-GATE] keeps a fresh signal retryable while the BTC/ETH/SOL timeline says WAIT", async () => {
    const sig = signal();
    const { executor, client, store } = makeExecutor({
      signals: [sig],
      timelineEntryGate: async () => ({ allowed: false, reason: "BTCUSDT: timeline WAIT" }),
    });
    await executor.tick();
    expect(client.placed).toHaveLength(0);
    expect(store.getState().attemptedObservationIds ?? []).not.toContain(sig.observationId);
    expect(executor.getStatus().lastEntrySkipReason).toContain("timeline WAIT");
  });

  it("opens a position from a fresh signal, sized from legUsd/allocation weight, and places a protective stop immediately (same tick, 2026-07-12 fix)", async () => {
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
    // 2026-07-12 fix: the stop used to be deferred to the NEXT tick, contradicting this module's
    // own header comment and leaving a freshly-opened real position unprotected for a full tick
    // interval. ensureStopOrder now runs eagerly right after the entry fills, same tick.
    expect(client.algosPlaced.length).toBe(1);
    expect(pos.stopAlgoOrderId).not.toBeNull();
  });

  it("[ENTRY-RETRY, 2026-07-12 fix] a transient entry-order failure does NOT permanently blacklist the signal via attemptedObservationIds", async () => {
    const client = new FakeClient();
    client.failOnSymbol = "BTCUSDT";
    const sig = signal();
    const { executor, store } = makeExecutor({ client, signals: [sig], legUsd: 10_000 });
    await executor.tick(); // entry order throws (transient failure)
    expect(store.getState().positions.length).toBe(0);
    expect(store.getState().attemptedObservationIds ?? []).not.toContain(sig.observationId);

    client.failOnSymbol = null; // the transient issue clears
    await executor.tick(); // the SAME signal must still be eligible for retry
    expect(store.getState().positions.length).toBe(1);
    expect(store.getState().positions[0]!.status).toBe("OPEN");
  });

  it("[ONE-WAY-NETTING, 2026-07-16 fix] refuses to open against an existing exchange position owned by another lane", async () => {
    const client = new FakeClient();
    client.positionAmtBySymbol.set("BTCUSDT", 0.02); // a real exchange position already exists
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
    // In Binance one-way mode, an opposite entry would reduce or reverse the sibling's position.
    // Skipping it is safer than merely preserving the sibling's leverage.
    expect(client.setLeverageCalls).toEqual([]);
  });

  it("[ONE-WAY-NETTING RACE] serializes sibling entries when their shared position cache is stale-flat", async () => {
    const client = new FakeClient();
    const claims = new Set<string>();
    const tryClaimEntrySymbol = (symbol: string) => {
      if (claims.has(symbol)) return false;
      claims.add(symbol);
      return true;
    };
    const releaseEntrySymbol = (symbol: string) => { claims.delete(symbol); };
    // Simulates the 30-second shared monitor cache immediately before either executor opens.
    const sharedGetPositions = async () => [];
    const long = makeExecutor({
      client,
      direction: "LONG",
      signals: [signal({ observationId: "race:BTC:long", stopPrice: 58200 })],
      legUsd: 10_000,
      sharedGetPositions,
      tryClaimEntrySymbol,
      releaseEntrySymbol,
    });
    const short = makeExecutor({
      client,
      direction: "SHORT",
      signals: [signal({ observationId: "race:BTC:short" })],
      legUsd: 10_000,
      sharedGetPositions,
      tryClaimEntrySymbol,
      releaseEntrySymbol,
    });

    await Promise.all([long.executor.tick(), short.executor.tick()]);

    expect(client.placed).toHaveLength(1);
    expect(long.store.getState().positions.length + short.store.getState().positions.length).toBe(1);
    expect(claims.size).toBe(0);
  });

  it("[ONE-WAY-NETTING FRESH CHECK] refuses an entry when a position appears after the shared cache was read", async () => {
    const client = new FakeClient();
    client.positionAmtBySymbol.set("BTCUSDT", 0.02);
    const { executor, store } = makeExecutor({
      client,
      signals: [signal()],
      legUsd: 10_000,
      // The monitor cache is stale, but entry admission must use client.getPositions(symbol).
      sharedGetPositions: async () => [],
    });

    await executor.tick();

    expect(store.getState().positions).toHaveLength(0);
    expect(client.placed).toHaveLength(0);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/fresh exchange position/);
  });

  it("skips a too-small notional that rounds to zero qty (below minQty)", async () => {
    const { executor, store } = makeExecutor({ signals: [signal()], legUsd: 1 }); // 1/60000 << minQty 0.001
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("skips an entry that clears minQty but fails MIN_NOTIONAL", async () => {
    // legUsd 0.5 / entryPrice 0.10 -> rawQty 5, floored to stepSize 1 -> qty 1 (clears minQty 1),
    // but notional = 1 * 0.10 = $0.10, under DOGEUSDT's minNotional of 5 in the fixture.
    const dogeSignal = signal({ observationId: "sf:DOGEUSDT:1", symbol: "DOGEUSDT", entryPrice: 0.1, stopPrice: 0.103 });
    const { executor, store } = makeExecutor({ signals: [dogeSignal], legUsd: 0.5 });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("ignores a stale signal older than maxSignalAgeMs default (50 min)", async () => {
    const { executor, store } = makeExecutor({ signals: [signal({ openedAtMs: NOW_MS - 60 * 60_000 })] });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("[DEDUP] does not re-attempt the same observationId across ticks even when capacity is available", async () => {
    // Regression for the 2026-07-09 incident: getOpenSignals() keeps returning the SAME still-OPEN
    // signal every tick until the measurement lane resolves it upstream — the executor's own
    // per-observationId dedup (not a coarse timestamp watermark) must be what stops it from
    // opening a 2nd position on the identical signal.
    const { executor, store } = makeExecutor({ signals: [signal()], legUsd: 10_000, maxOpenPositions: 5 });
    await executor.tick();
    expect(store.getState().positions.length).toBe(1);
    await executor.tick();
    await executor.tick();
    expect(store.getState().positions.length).toBe(1);
  });

  it("[INCIDENT 2026-07-09] one signal that can't be filled (no exchange filters) must not silently block OTHER signals sharing the identical openedAtMs", async () => {
    // The real bug: 3 signals recorded in the same regime-composite cycle share one openedAtMs.
    // The old code advanced a single scalar watermark to that shared timestamp the moment ANY one
    // of them was attempted — including one this executor can't actually fill (no exchange filter
    // for its symbol) — which then excluded every OTHER signal at that same timestamp forever
    // (equal-to-watermark isn't "newer"). Per-observationId dedup fixes this: only the ATTEMPTED
    // signal is excluded, not everything sharing its timestamp.
    const sharedMs = NOW_MS - 2 * 60_000;
    const failing = signal({ observationId: "rc:UNKNOWNUSDT:1", symbol: "UNKNOWNUSDT", openedAtMs: sharedMs });
    const ok1 = signal({ observationId: "rc:BTCUSDT:1", symbol: "BTCUSDT", openedAtMs: sharedMs });
    const ok2 = signal({ observationId: "rc:ETHUSDT:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090, openedAtMs: sharedMs });
    const { executor, store } = makeExecutor({ signals: [failing, ok1, ok2], legUsd: 10_000, maxOpenPositions: 5 });
    await executor.tick();
    const opened = store.getState().positions.map((p) => p.symbol);
    expect(opened).toContain("BTCUSDT");
    expect(opened).toContain("ETHUSDT");
    expect(opened).not.toContain("UNKNOWNUSDT");
    expect(store.getState().positions.length).toBe(2);
  });

  it("distinct positionIds when 2 candidates share the identical openedAtMs (the exact collision the dedup fix also closes)", async () => {
    const sharedMs = NOW_MS - 2 * 60_000;
    const ok1 = signal({ observationId: "rc:BTCUSDT:1", symbol: "BTCUSDT", openedAtMs: sharedMs });
    const ok2 = signal({ observationId: "rc:ETHUSDT:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090, openedAtMs: sharedMs });
    const { executor, store } = makeExecutor({ signals: [ok1, ok2], legUsd: 10_000, maxOpenPositions: 5 });
    await executor.tick();
    const ids = store.getState().positions.map((p) => p.positionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not open when isAllowed() is false", async () => {
    const { executor, store } = makeExecutor({ signals: [signal()], allowed: false });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  describe("[2026-07-09 fix] cross-lane per-symbol notional cap", () => {
    it("with no cap set (default 0), behaves exactly as before — opens regardless of existingNotionalForSymbol", async () => {
      const { executor, store } = makeExecutor({
        signals: [signal()],
        legUsd: 100,
        existingNotionalForSymbol: () => 999_999, // huge — must NOT matter, cap is 0/off
      });
      await executor.tick();
      expect(store.getState().positions.length).toBe(1);
    });

    it("skips a fresh entry that would push combined notional (existing + this entry's legUsd) over the cap", async () => {
      const { executor, store } = makeExecutor({
        signals: [signal()], // BTCUSDT, entryPrice 60000 by default
        legUsd: 100,
        existingNotionalForSymbol: (symbol) => (symbol === "BTCUSDT" ? 200 : 0),
        maxNotionalPerSymbolAcrossLanes: 250, // 200 + 100 = 300 > 250 -> reject
      });
      await executor.tick();
      expect(store.getState().positions.length).toBe(0);
    });

    it("opens when combined notional stays within the cap", async () => {
      const { executor, store } = makeExecutor({
        signals: [signal()],
        legUsd: 100,
        existingNotionalForSymbol: (symbol) => (symbol === "BTCUSDT" ? 100 : 0),
        maxNotionalPerSymbolAcrossLanes: 250, // 100 + 100 = 200 <= 250 -> allowed
      });
      await executor.tick();
      expect(store.getState().positions.length).toBe(1);
    });

    it("[TRANSIENT] a cap-rejected signal is NOT permanently blacklisted — it retries and succeeds once another lane's exposure (simulated) frees up", async () => {
      let otherLaneNotional = 300; // starts over cap
      const signals = [signal()];
      const { executor, store } = makeExecutor({
        signals,
        legUsd: 100,
        existingNotionalForSymbol: () => otherLaneNotional,
        maxNotionalPerSymbolAcrossLanes: 250,
      });
      await executor.tick(); // rejected: 300 + 100 > 250
      expect(store.getState().positions.length).toBe(0);
      otherLaneNotional = 50; // the other lane's position closed, freeing capacity
      await executor.tick(); // SAME signal (same observationId), now 50 + 100 <= 250 -> must succeed
      expect(store.getState().positions.length).toBe(1);
    });

    it("only applies the cap to the fresh entry's OWN symbol, not universe-wide", async () => {
      const signals = [signal({ observationId: "sf:ETHUSDT:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090 })];
      const { executor, store } = makeExecutor({
        signals,
        legUsd: 100,
        existingNotionalForSymbol: (symbol) => (symbol === "BTCUSDT" ? 999_999 : 0), // BTC is maxed out, ETH is not
        maxNotionalPerSymbolAcrossLanes: 250,
      });
      await executor.tick();
      expect(store.getState().positions.length).toBe(1);
      expect(store.getState().positions[0]!.symbol).toBe("ETHUSDT");
    });
  });

  it("does not open when 0% allocation weight zeroes legUsd", async () => {
    const { executor, store } = makeExecutor({ signals: [signal()], laneWeightPct: 0 });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
  });

  it("rejects a short signal after price has already moved more than 0.2R favorably", async () => {
    const { executor, store } = makeExecutor({ signals: [signal()], currentPrice: 59_000 });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/entry chase/);
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
    // 2026-07-12 fix: ensureStopOrder now runs eagerly the SAME tick the position opens, so the
    // first (failing) attempt happens on tick 1, not tick 2.
    await executor.tick(); // opens position + 1st stop attempt fails
    expect(store.getState().positions[0]!.stopAlgoOrderId).toBeNull();
    await executor.tick(); // retries and succeeds
    expect(store.getState().positions[0]!.stopAlgoOrderId).not.toBeNull();
  });
});

describe("SingleSymbolLaneExecutor — exits", () => {
  it("[PORTFOLIO-EXIT] lets the central overlay close while preserving this executor's orderly close path", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({
      client,
      signals: [signal()],
      legUsd: 10_000,
      portfolioExitPolicy: (ctx) => ({
        shouldExit: true,
        reason: "UNIFIED_REGIME_FLIP_BANK",
        nextPeakFavorableR: ctx.peakFavorableR,
      }),
    });
    await executor.tick();
    const algoId = store.getState().positions[0]!.stopAlgoOrderId!;
    client.markPriceBySymbol.set("BTCUSDT", 59900);
    await executor.tick();
    const position = store.getState().positions[0]!;
    expect(position.status).toBe("CLOSED");
    expect(position.closeReason).toBe("UNIFIED_REGIME_FLIP_BANK");
    expect(client.algosCancelled).toContain(algoId);
    expect(client.placed.some((order) => order.reduceOnly === true)).toBe(true);
  });

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
    client.triggerAlgo(algoId, "5555", -1.8, 0.05, 61800, pos.qty); // a real stop-out fill: -1.8 gross, 0.05 fee
    client.markPriceBySymbol.set("BTCUSDT", 61800); // irrelevant once settled via trades
    await executor.tick();
    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.closeReason).toBe("INITIAL_STOP");
    expect(closed.grossPnlUsd).toBeCloseTo(-1.8, 6);
    expect(closed.feeEstimateUsd).toBeCloseTo(0.05, 6);
    expect(closed.netPnlUsd).toBeCloseTo(-1.85, 6);
    expect(closed.exitPriceConfirmed).toBe(true);
    expect(closed.exitPrice).toBeCloseTo(61800, 6); // qty-weighted average of the ACTUAL fill, not just the trigger price
  });

  it("[STOP-TRIGGERED, NOT FABRICATED] does not close (or invent a P&L) while the exit trade hasn't shown up in getUserTrades yet", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    const pos = store.getState().positions[0]!;
    const algoId = pos.stopAlgoOrderId!;
    // Mark the algo as triggered, but do NOT register any matching trade yet (simulates the
    // timing race right after a stop fires, before Binance's trade record is queryable).
    client.algoTriggeredOrderId.set(algoId, "5555");
    await executor.tick();
    const stillOpen = store.getState().positions[0]!;
    expect(stillOpen.status).toBe("OPEN"); // NOT closed — no fabricated 0/0/0 P&L
    expect(stillOpen.grossPnlUsd).toBeNull();
    expect(stillOpen.netPnlUsd).toBeNull();
    expect(stillOpen.exitOrderId).toBe("5555"); // exit marked in-flight so the policy path can't double-close

    // Next tick, the trade record becomes available — settlement completes honestly.
    client.userTradesByOrderId.set("5555", {
      symbol: "BTCUSDT", orderId: "5555", price: 61800, qty: pos.qty, realizedPnl: -1.8, commission: 0.05, commissionAsset: "USDT", time: NOW_MS,
    });
    await executor.tick();
    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.netPnlUsd).toBeCloseTo(-1.85, 6);
  });

  it("[PARTIAL-FILL, 2026-07-12 fix] a stop that only partially fills does NOT mark the position CLOSED, re-arms protection for the remainder, and banks the running total across both legs", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    const opened = store.getState().positions[0]!;
    const fullQty = opened.qty;
    const entryOrderId = opened.entryOrderId;
    const algoId = opened.stopAlgoOrderId!;

    // Entry trade record: zero P&L (opening trades never realize P&L), a small real commission.
    client.userTradesByOrderId.set(entryOrderId, {
      symbol: "BTCUSDT", orderId: entryOrderId, price: 60000, qty: fullQty, realizedPnl: 0, commission: 0.02, commissionAsset: "USDT", time: NOW_MS,
    });
    // The stop triggers but only HALF the requested qty actually fills (a sibling executor's
    // netting clipped the reduce-only qty available on the shared netted account) — the other
    // half never executes as a separate order under Binance's STOP_MARKET semantics.
    const halfQty = fullQty / 2;
    client.triggerAlgo(algoId, "9001", -0.9, 0.03, 61800, halfQty);
    await executor.tick();

    const partial = store.getState().positions[0]!;
    expect(partial.status).toBe("OPEN"); // NOT falsely closed on a partial fill
    expect(partial.qty).toBeCloseTo(fullQty - halfQty, 9); // reduced to the genuinely-remaining qty
    expect(partial.exitOrderId).toBeNull(); // re-armed so the next tick can protect the remainder
    expect(partial.stopAlgoOrderId).toBeNull();
    expect(partial.realizedPartialGrossUsd).toBeCloseTo(-0.9, 6);
    expect(partial.realizedPartialFeeUsd).toBeCloseTo(0.05, 6); // 0.03 (partial exit) + 0.02 (entry, banked once)

    await executor.tick(); // ensureStopOrder re-arms a FRESH algo order for the remaining qty
    const reArmed = store.getState().positions[0]!;
    expect(reArmed.status).toBe("OPEN");
    expect(reArmed.stopAlgoOrderId).not.toBeNull();
    expect(reArmed.stopAlgoOrderId).not.toBe(algoId); // a genuinely NEW algo order, not the spent one

    // The remaining qty's stop now fully fills — final leg closes the position.
    client.triggerAlgo(reArmed.stopAlgoOrderId!, "9002", -0.9, 0.03, 61800, reArmed.qty);
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    // Total across BOTH legs — proves the partial leg's real P&L was never dropped, and the
    // entry commission was banked exactly ONCE despite getUserTrades being re-queried from
    // openedAt on every settle call (it would otherwise double-count on this second leg).
    expect(closed.grossPnlUsd).toBeCloseTo(-1.8, 6);
    expect(closed.feeEstimateUsd).toBeCloseTo(0.08, 6);
    expect(closed.netPnlUsd).toBeCloseTo(-1.88, 6);
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
      entryPrice: 100, entryOrderId: "1", entryPriceConfirmed: true, stopPrice: 103, stopAlgoOrderId: null,
      stopFailureCount: 0, stopUnprotectedSinceIso: null, closeFailureCount: 0, closeFailureSinceIso: null,
      peakFavorableR: 0, openedAt: NOW, status: "CLOSED", closedAt: NOW, closeReason: "INITIAL_STOP",
      exitPrice: 103, exitOrderId: "2", exitPriceConfirmed: true, grossPnlUsd: -2, feeEstimateUsd: 0.1, netPnlUsd: -2.1,
    });
    await executor.tick();
    expect(store.getState().positions.filter((p) => p.status === "OPEN").length).toBe(0);
    expect(executor.getStatus().openHalted).toMatch(/daily loss breaker/);
  });

  it("[REDUCE-ONLY-REJECTED, -2022] retries WITHOUT reduceOnly and still closes correctly", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    const algoId = store.getState().positions[0]!.stopAlgoOrderId!;
    client.rejectNextReduceOnlyWithCode = -2022;
    client.markPriceBySymbol.set("BTCUSDT", 59000); // 0.5R favorable for the SHORT -> TP_HIT
    await executor.tick();
    const pos = store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED");
    expect(pos.closeReason).toBe("TP_HIT");
    expect(client.algosCancelled).toContain(algoId);
    // Two placeOrder calls landed: the rejected reduceOnly attempt never reaches `placed` (it
    // throws before push), so `placed` should show exactly one entry — the successful non
    // -reduceOnly retry.
    // Entry (SELL, opening a SHORT) and exit (BUY, closing it) use opposite sides — filter on the
    // closing side specifically so the entry order doesn't get counted as a 2nd "closing" order.
    const closingOrders = client.placed.filter((p) => p.symbol === "BTCUSDT" && p.side === "BUY");
    expect(closingOrders.length).toBe(1);
    expect(closingOrders[0]!.reduceOnly).toBeUndefined();
  });

  it("[CLOSE-STUCK] a persistent (non-2022) close failure increments closeFailureCount and is surfaced via getStatus().stuckClosePositions, without fabricating a close", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    client.markPriceBySymbol.set("BTCUSDT", 59000); // TP_HIT condition
    client.failAllPlaceOrders = true;
    await executor.tick();
    let pos = store.getState().positions[0]!;
    expect(pos.status).toBe("OPEN"); // close failed — never marked CLOSED
    expect(pos.closeFailureCount).toBe(1);
    expect(pos.closeFailureSinceIso).not.toBeNull();
    expect(executor.getStatus().stuckClosePositions.length).toBe(1);
    expect(executor.getStatus().stuckClosePositions[0]!.closeFailureCount).toBe(1);

    await executor.tick(); // still failing
    pos = store.getState().positions[0]!;
    expect(pos.closeFailureCount).toBe(2);
    expect(pos.closeFailureSinceIso).toBe(store.getState().positions[0]!.closeFailureSinceIso); // timestamp doesn't reset mid-streak

    client.failAllPlaceOrders = false;
    await executor.tick(); // now succeeds
    pos = store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED");
    expect(pos.closeFailureCount).toBe(0);
    expect(pos.closeFailureSinceIso).toBeNull();
    expect(executor.getStatus().stuckClosePositions.length).toBe(0);
  });

  it("[STOP-STUCK] a persistent ensureStopOrder failure increments stopFailureCount across ticks and is surfaced via getStatus().unprotectedPositions", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    // Simulate a PERSISTENT algo-placement failure by overriding placeAlgoOrder for this test —
    // installed BEFORE the open tick since ensureStopOrder now runs eagerly the same tick a
    // position opens (2026-07-12 fix), so the very first attempt happens during that tick.
    const originalPlaceAlgoOrder = client.placeAlgoOrder.bind(client);
    let algoCallCount = 0;
    client.placeAlgoOrder = async (params) => {
      algoCallCount += 1;
      if (algoCallCount <= 2) throw new Error("persistent algo rejection");
      return originalPlaceAlgoOrder(params);
    };
    await executor.tick(); // open + 1st stop attempt fails
    let pos = store.getState().positions[0]!;
    expect(pos.stopAlgoOrderId).toBeNull();
    expect(pos.stopFailureCount).toBe(1);
    expect(executor.getStatus().unprotectedPositions.length).toBe(1);

    await executor.tick(); // 2nd stop attempt fails
    pos = store.getState().positions[0]!;
    expect(pos.stopFailureCount).toBe(2);
    expect(pos.stopUnprotectedSinceIso).not.toBeNull();

    await executor.tick(); // 3rd attempt succeeds
    pos = store.getState().positions[0]!;
    expect(pos.stopAlgoOrderId).not.toBeNull();
    expect(pos.stopFailureCount).toBe(0);
    expect(pos.stopUnprotectedSinceIso).toBeNull();
    expect(executor.getStatus().unprotectedPositions.length).toBe(0);
  });

  it("[HAZARD-1 FIX] a stuck close on one position does not block a sibling position's exit-policy check in the same tick", async () => {
    const client = new FakeClient();
    const btcSignal = signal({ observationId: "sf:BTCUSDT:1", symbol: "BTCUSDT", entryPrice: 60000, stopPrice: 61800 });
    const ethSignal = signal({ observationId: "sf:ETHUSDT:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090 });
    const { executor, store } = makeExecutor({ client, signals: [btcSignal, ethSignal], legUsd: 10_000, maxOpenPositions: 2 });
    await executor.tick(); // opens both
    await executor.tick(); // places both stops
    expect(store.getState().positions.filter((p) => p.status === "OPEN").length).toBe(2);

    // Both at 0.5R favorable for their SHORT direction -> TP_HIT for both.
    client.markPriceBySymbol.set("BTCUSDT", 59000);
    client.markPriceBySymbol.set("ETHUSDT", 2950);
    client.failOnSymbol = "BTCUSDT"; // ONLY BTCUSDT's close fails; ETHUSDT's must still go through
    await executor.tick();

    const btc = store.getState().positions.find((p) => p.symbol === "BTCUSDT")!;
    const eth = store.getState().positions.find((p) => p.symbol === "ETHUSDT")!;
    expect(btc.status).toBe("OPEN"); // stuck, retrying next tick
    expect(btc.closeFailureCount).toBe(1);
    // Before the fix, BTCUSDT's uncaught throw (it's earlier in the array) would have aborted
    // monitorOpenPositions' loop before ETHUSDT was ever evaluated this tick.
    expect(eth.status).toBe("CLOSED");
    expect(eth.closeReason).toBe("TP_HIT");
  });

  it("[HAZARD-2 FIX] a failed close resets stopAlgoOrderId so ensureStopOrder replaces it next tick (self-heals)", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    expect(store.getState().positions[0]!.stopAlgoOrderId).not.toBeNull();

    client.markPriceBySymbol.set("BTCUSDT", 59000); // TP_HIT
    client.failAllPlaceOrders = true; // close fails
    await executor.tick();
    let pos = store.getState().positions[0]!;
    expect(pos.status).toBe("OPEN");
    // Reset by the fix — NOT left pointing at the stop that was already cancelled moments earlier
    // in the same closePosition() call.
    expect(pos.stopAlgoOrderId).toBeNull();
    // stopFailureCount is still 0 here (ensureStopOrder hasn't been retried yet this tick) — this is
    // "about to self-heal," not yet a confirmed-stuck alert.
    expect(executor.getStatus().unprotectedPositions.length).toBe(0);

    client.failAllPlaceOrders = false; // let the close succeed once ensureStopOrder has run
    const algosPlacedBefore = client.algosPlaced.length;
    await executor.tick();
    expect(client.algosPlaced.length).toBe(algosPlacedBefore + 1); // replacement stop was placed
    pos = store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED"); // TP_HIT still holds, close now succeeds
  });

  it("[HAZARD-2 FIX] when the replacement stop ALSO fails, the position is correctly flagged unprotected (previously stopAlgoOrderId never went null, so this alert could never fire)", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick();
    await executor.tick();
    client.markPriceBySymbol.set("BTCUSDT", 59000);
    client.failAllPlaceOrders = true;
    await executor.tick(); // close fails -> stopAlgoOrderId reset to null
    expect(store.getState().positions[0]!.stopAlgoOrderId).toBeNull();

    client.placeAlgoOrder = async () => { throw new Error("algo rejected (persistent)"); };
    await executor.tick(); // ensureStopOrder's replacement attempt ALSO fails
    const pos = store.getState().positions[0]!;
    expect(pos.stopAlgoOrderId).toBeNull();
    expect(pos.stopFailureCount).toBe(1);
    expect(executor.getStatus().unprotectedPositions.length).toBe(1);
    expect(executor.getStatus().unprotectedPositions[0]!.symbol).toBe("BTCUSDT");
  });
});

describe("SingleSymbolLaneExecutor — manualClosePosition (2026-07-10 urgent close-now button)", () => {
  it("closes an OPEN position via reduceOnly market order, cancelling the resting stop first", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    const pos = store.getState().positions[0]!;
    const algoId = pos.stopAlgoOrderId!;
    client.fillPriceBySymbol.set("BTCUSDT", 60500); // small favorable move for the SHORT, well below TP_HIT
    const result = await executor.manualClosePosition(pos.positionId);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(client.algosCancelled).toContain(algoId);
    expect(client.placed.some((p) => p.reduceOnly === true)).toBe(true);
    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.closeReason).toBe("MANUAL_CLOSE");
    expect(result.netPnlUsd).toBe(closed.netPnlUsd);
  });

  it("rejects an unknown positionId", async () => {
    const { executor } = makeExecutor({ signals: [] });
    const result = await executor.manualClosePosition("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no open position/);
    expect(result.netPnlUsd).toBeNull();
  });

  it("rejects a position that is already CLOSED", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick();
    await executor.tick();
    const pos = store.getState().positions[0]!;
    await executor.manualClosePosition(pos.positionId); // closes it
    expect(store.getState().positions[0]!.status).toBe("CLOSED");
    const second = await executor.manualClosePosition(pos.positionId);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/no open position/);
  });

  it("refuses to double-close a position whose exit is already in flight (exitOrderId set)", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick();
    await executor.tick();
    const pos = store.getState().positions[0]!;
    // Simulate the stop having just triggered (exitOrderId set, not yet settled/CLOSED) — see
    // settleIfStopTriggered's "mark in flight immediately" step.
    pos.exitOrderId = "already-triggering";
    const result = await executor.manualClosePosition(pos.positionId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already in flight/);
    expect(client.placed.length).toBe(1); // only the original entry order — no extra close attempt
  });

  it("surfaces a persistent close failure as ok:false without fabricating a close", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick();
    await executor.tick();
    const pos = store.getState().positions[0]!;
    client.failAllPlaceOrders = true;
    const result = await executor.manualClosePosition(pos.positionId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/close failed/);
    expect(result.netPnlUsd).toBeNull();
    expect(store.getState().positions[0]!.status).toBe("OPEN"); // never fabricated CLOSED
  });

  it("[RACE] 2026-07-11 fix: refuses a concurrent close on the SAME position instead of sending a second real closing order", async () => {
    // closePosition()'s `pos.exitOrderId !== null` reentry guard is TOCTOU-vulnerable — exitOrderId
    // isn't set until AFTER the awaited cancelAlgoOrder/placeOrder calls, so two concurrent
    // manualClosePosition() calls (or a manual click racing monitorOpenPositions' own policy-exit)
    // can both pass that check and both place a real closing order.
    class SlowPlaceOrderClient extends FakeClient {
      onFirstReduceOnlyPlace: (() => Promise<unknown>) | null = null;
      async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
        if (params.reduceOnly && this.onFirstReduceOnlyPlace) {
          const fn = this.onFirstReduceOnlyPlace;
          this.onFirstReduceOnlyPlace = null;
          await fn(); // simulates a second manualClosePosition() racing in during this exact await
        }
        return super.placeOrder(params);
      }
    }
    const client = new SlowPlaceOrderClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick();
    await executor.tick();
    const pos = store.getState().positions[0]!;
    client.fillPriceBySymbol.set("BTCUSDT", 60500);

    let secondResult: { ok: boolean; reason: string | null } | null = null;
    client.onFirstReduceOnlyPlace = async () => {
      secondResult = await executor.manualClosePosition(pos.positionId);
    };
    const firstResult = await executor.manualClosePosition(pos.positionId);

    expect(firstResult.ok).toBe(true);
    expect(secondResult).not.toBeNull();
    expect(secondResult!.ok).toBe(false);
    expect(secondResult!.reason).toMatch(/already in flight/);
    // Only ONE real closing order reached the exchange, not two — the bug this closes would have
    // let the second call's own -2022 fallback open a brand-new naked position.
    expect(client.placed.filter((p) => p.reduceOnly === true)).toHaveLength(1);
    expect(store.getState().positions[0]!.status).toBe("CLOSED");
  });
});

describe("SingleSymbolLaneExecutorStore — fileName isolation", () => {
  it("two stores with distinct fileName in the same dir do not collide", () => {
    const dir = tmpDir();
    const a = new SingleSymbolLaneExecutorStore(dir, "lane-a.json");
    a.getState().positions.push({
      positionId: "a1", sourceObservationId: "o1", symbol: "BTCUSDT", direction: "SHORT", qty: 1, entryPrice: 1,
      entryOrderId: "1", entryPriceConfirmed: true, stopPrice: 1.03, stopAlgoOrderId: null,
      stopFailureCount: 0, stopUnprotectedSinceIso: null, closeFailureCount: 0, closeFailureSinceIso: null,
      peakFavorableR: 0, openedAt: NOW, status: "OPEN", closedAt: null, closeReason: null, exitPrice: null, exitOrderId: null,
      exitPriceConfirmed: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
    });
    a.save();
    const b = new SingleSymbolLaneExecutorStore(dir, "lane-b.json");
    expect(b.getState().positions.length).toBe(0);
  });

  it("[LEGACY-NORMALIZE] coerces pre-fix bare-number orderId fields to strings on load", () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    // Simulates a real position persisted before the order-ID precision fix — entryOrderId etc.
    // written as a bare (already-rounded) JS number, not a quoted string.
    const legacyJson = JSON.stringify({
      version: 1,
      positions: [{
        positionId: "legacy1", sourceObservationId: "o1", symbol: "ETHUSDT", direction: "LONG", qty: 1,
        entryPrice: 1750, entryOrderId: 8389766229891298000, entryPriceConfirmed: true, stopPrice: 1700,
        stopAlgoOrderId: 2000001266429768, stopFailureCount: 0, stopUnprotectedSinceIso: null,
        closeFailureCount: 0, closeFailureSinceIso: null, peakFavorableR: 0, openedAt: NOW, status: "OPEN",
        closedAt: null, closeReason: null, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null,
        grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
      }],
      lastSeenSignalMs: 0,
    });
    writeFileSync(resolve(dir, "legacy.json"), legacyJson, "utf-8");
    const store = new SingleSymbolLaneExecutorStore(dir, "legacy.json");
    const pos = store.getState().positions[0]!;
    expect(typeof pos.entryOrderId).toBe("string");
    expect(pos.entryOrderId).toBe("8389766229891298000");
    expect(typeof pos.stopAlgoOrderId).toBe("string");
    expect(pos.stopAlgoOrderId).toBe("2000001266429768");
    expect(pos.exitOrderId).toBeNull(); // legitimately-null fields must stay null, not become ""
  });
});

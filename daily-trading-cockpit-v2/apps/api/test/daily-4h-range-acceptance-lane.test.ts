import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FuturesAlgoOrder,
  FuturesExecutionBookTicker,
  FuturesIncomeEntry,
  FuturesKline,
  FuturesOrder,
  FuturesPosition,
  FuturesSymbolFilters,
  FuturesUserTrade,
  PlaceAlgoOrderParams,
  PlaceOrderParams,
} from "../src/lib/binance-futures-private.js";
import {
  DailyRangeAcceptanceLane,
  DailyRangeLaneStore,
  inDailyRangeEntryWindow,
  roundDailyRangeBracket,
  structuralStopForAcceptance,
  type DailyRangeCandle,
  type DailyRangeDayState,
  type DailyRangeExecClient,
  type DailyRangeLevel,
  type DailyRangeSignal,
  type DailyRangeSymbolState,
} from "../src/lib/daily-4h-range-acceptance-lane.js";
import type { DailyRangeMainnetControls } from "../src/lib/daily-range-mainnet-policy.js";

const DAY = Date.UTC(2026, 7, 26);
const AT_0410 = DAY + 4 * 3_600_000 + 10 * 60_000;
const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "FFFUSDT", "GGGUSDT", "HHHUSDT", "IIIUSDT", "JJJUSDT"];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "daily-range-lane-"));
  dirs.push(dir);
  return dir;
}

function candle(openTime: number, close: number, low = Math.min(close, 99), high = Math.max(close, 101)): DailyRangeCandle {
  return { openTime, closeTime: openTime + 5 * 60_000 - 1, open: 100, high, low, close };
}

function level(symbol = "AAAUSDT"): DailyRangeLevel {
  return {
    dateUtc: "2026-08-26", symbol, fourHourOpenTime: DAY, fourHourCloseTime: DAY + 4 * 3_600_000,
    rangeHigh: 100, rangeLow: 90, rangeWidth: 10, rangeWidthPct: 10 / 90,
    dailyUniverseMembership: true, createdAt: new Date(AT_0410).toISOString(),
  };
}

function filter(symbol: string): FuturesSymbolFilters {
  return { symbol, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 };
}

class FakeDailyClient implements DailyRangeExecClient {
  now = AT_0410;
  readonly placed: PlaceOrderParams[] = [];
  readonly algoPlaced: PlaceAlgoOrderParams[] = [];
  readonly cancelledAlgos: string[] = [];
  readonly cancelledOrders: string[] = [];
  readonly klines = new Map<string, FuturesKline[]>();
  readonly positions = new Map<string, FuturesPosition>();
  readonly orders = new Map<string, FuturesOrder>();
  readonly ordersByClientId = new Map<string, FuturesOrder>();
  readonly algos = new Map<string, FuturesAlgoOrder>();
  readonly fills: FuturesUserTrade[] = [];
  /** Simulates a terminal partial MARKET fill: safe handling must bracket the
   * actual quantity rather than treating the requested quantity as fact. */
  nextEntryPartialFill: { qty: number; status: "CANCELED" | "EXPIRED" } | null = null;
  private orderNo = 1;
  private algoNo = 1;

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    return new Map(symbols.map((symbol) => [symbol, filter(symbol)]));
  }
  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    const rows = [...this.positions.values()];
    return symbol ? rows.filter((row) => row.symbol === symbol) : rows;
  }
  async getOpenOrders(_symbol?: string): Promise<FuturesOrder[]> { return []; }
  async getOpenAlgoOrders(symbol?: string): Promise<FuturesAlgoOrder[]> {
    const rows = [...this.algos.values()];
    return symbol ? rows.filter((row) => row.symbol === symbol) : rows;
  }
  async getBookTicker(_symbol: string): Promise<FuturesExecutionBookTicker> {
    return { bid: 100, ask: 100, bidQty: 100, askQty: 100, time: this.now };
  }
  async getKlines(symbol: string, interval: "1m" | "5m" | "4h", opts: { startTime?: number; endTime?: number } = {}): Promise<FuturesKline[]> {
    return (this.klines.get(`${symbol}|${interval}`) ?? []).filter((row) =>
      (opts.startTime === undefined || row.openTime >= opts.startTime) && (opts.endTime === undefined || row.openTime <= opts.endTime),
    );
  }
  async isHedgeMode(): Promise<boolean> { return false; }
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const current = this.positions.get(symbol);
    if (current) current.leverage = leverage;
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    this.placed.push(params);
    const price = 100;
    const partial = !params.reduceOnly ? this.nextEntryPartialFill : null;
    this.nextEntryPartialFill = null;
    const executedQty = partial ? Math.min(params.quantity, partial.qty) : params.quantity;
    const order: FuturesOrder = {
      symbol: params.symbol, orderId: String(this.orderNo++), clientOrderId: params.newClientOrderId ?? "",
      status: partial?.status ?? "FILLED", type: params.type, side: params.side, reduceOnly: Boolean(params.reduceOnly),
      price: 0, stopPrice: 0, origQty: params.quantity, executedQty, avgPrice: price, updateTime: this.now,
    };
    this.orders.set(order.orderId, order);
    this.ordersByClientId.set(order.clientOrderId, order);
    const existing = this.positions.get(params.symbol) ?? {
      symbol: params.symbol, positionAmt: 0, entryPrice: price, markPrice: price, liquidationPrice: 0,
      unRealizedProfit: 0, leverage: 1, marginType: "CROSSED",
    };
    if (params.reduceOnly) {
      existing.positionAmt = 0;
      this.fills.push({ symbol: params.symbol, orderId: order.orderId, price, qty: executedQty, realizedPnl: 1, commission: -0.01, commissionAsset: "USDT", time: this.now });
    } else {
      existing.positionAmt += params.side === "BUY" ? executedQty : -executedQty;
      existing.entryPrice = price;
      this.fills.push({ symbol: params.symbol, orderId: order.orderId, price, qty: executedQty, realizedPnl: 0, commission: -0.01, commissionAsset: "USDT", time: this.now });
    }
    this.positions.set(params.symbol, existing);
    return order;
  }
  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    this.algoPlaced.push(params);
    const algo: FuturesAlgoOrder = {
      symbol: params.symbol, algoId: `a${this.algoNo++}`, clientAlgoId: params.clientAlgoId ?? "", algoStatus: "WORKING",
      orderType: params.type, side: params.side, quantity: params.quantity, triggerPrice: params.triggerPrice, actualOrderId: null,
    };
    this.algos.set(algo.algoId, algo);
    return algo;
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    const order = this.orders.get(orderId);
    if (!order || order.symbol !== symbol) throw new Error("order not found");
    return order;
  }
  async queryOrderByClientId(symbol: string, clientOrderId: string): Promise<FuturesOrder> {
    const order = this.ordersByClientId.get(clientOrderId);
    if (!order || order.symbol !== symbol) throw new Error("order not found");
    return order;
  }
  async queryAlgoOrder(algoId: string): Promise<FuturesAlgoOrder> {
    const algo = this.algos.get(algoId);
    if (!algo) throw new Error("algo not found");
    return algo;
  }
  async cancelOrder(_symbol: string, orderId: string): Promise<void> { this.cancelledOrders.push(orderId); }
  async cancelAlgoOrder(algoId: string): Promise<void> { this.cancelledAlgos.push(algoId); this.algos.delete(algoId); }
  async getUserTrades(symbol: string): Promise<FuturesUserTrade[]> { return this.fills.filter((fill) => fill.symbol === symbol); }
  async getIncomeHistory(): Promise<FuturesIncomeEntry[]> { return []; }
}

function referenceFourHour(): FuturesKline {
  return { openTime: DAY, closeTime: DAY + 4 * 3_600_000 - 1, open: 96, high: 100, low: 90, close: 95, volume: 1 };
}

function makeLane(client: FakeDailyClient, nowRef: { value: number }, universe = ["AAAUSDT"], claim = { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} }) {
  const dir = dataDir();
  const store = new DailyRangeLaneStore(dir, "state.json", nowRef.value);
  const lane = new DailyRangeAcceptanceLane({
    client,
    store,
    getUniverse: () => ({ symbols: universe, source: "TEST" }),
    getShortBlocklist: () => new Set<string>(),
    entryClaims: claim,
    environment: "testnet",
    nowMs: () => nowRef.value,
    confirmRetryMs: 0,
  });
  return { lane, store, dir };
}

function mainnetControls(overrides: Partial<DailyRangeMainnetControls> = {}): DailyRangeMainnetControls {
  return {
    executionEnabled: true,
    confirmed: true,
    canaryEnabled: true,
    armEnabled: true,
    maxOpenTrades: 1,
    maxGrossNotionalUsd: 25,
    ...overrides,
  };
}

function makeMainnetLane(
  client: FakeDailyClient,
  nowRef: { value: number },
  controls?: DailyRangeMainnetControls,
  entryGate = () => ({ allowed: true, reason: null }),
) {
  const dir = dataDir();
  const store = new DailyRangeLaneStore(dir, "state.json", nowRef.value);
  const lane = new DailyRangeAcceptanceLane({
    client,
    store,
    getUniverse: () => ({ symbols, source: "TEST" }),
    getShortBlocklist: () => new Set<string>(),
    entryClaims: { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
    environment: "mainnet",
    mainnetControls: controls,
    entryGate,
    nowMs: () => nowRef.value,
    confirmRetryMs: 0,
  });
  return { lane, store, dir };
}

function signal(symbol: string, at: number, direction: "LONG" | "SHORT" = "LONG"): DailyRangeSignal {
  const c1 = candle(at - 10 * 60_000, direction === "LONG" ? 100 : 90, direction === "LONG" ? 98 : 89, direction === "LONG" ? 101 : 102);
  const c2 = candle(at - 5 * 60_000, direction === "LONG" ? 101 : 89, direction === "LONG" ? 98 : 88, direction === "LONG" ? 102 : 101);
  return {
    signalId: `signal-${symbol}`, strategyVersion: "daily-4h-range-acceptance-2r-v1", laneId: "DAILY_4H_RANGE_ACCEPTANCE",
    dateUtc: "2026-08-26", symbol, direction, rangeHigh: 100, rangeLow: 90,
    confirmationBar1: c1, confirmationBar2: c2, signalTimestamp: new Date(at - 1_000).toISOString(), signalTimestampMs: at - 1_000,
    entryEligible: false, reason: null, entryAttemptedAt: null, tradeId: null,
  };
}

describe("daily-4h-range-acceptance-2r-v1", () => {
  it("uses UTC 00:00–04:00 futures reference only and does not catch up a disarmed day", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    client.klines.set("AAAUSDT|4h", [
      referenceFourHour(),
      { ...referenceFourHour(), openTime: DAY + 24 * 3_600_000, closeTime: DAY + 28 * 3_600_000 - 1 },
    ]);
    client.klines.set("AAAUSDT|5m", [candle(DAY + 4 * 3_600_000 + 10 * 60_000, 101)]);
    const { lane, store } = makeLane(client, now);
    await lane.tick(); // startup + frozen range only; lane is DISARMED
    expect((lane.getStatus().today as { monitoringSymbols: number }).monitoringSymbols).toBe(1);
    expect(store.getState().signals).toHaveLength(0);
    store.arm(new Date(now.value).toISOString());
    now.value += 5 * 60_000;
    client.now = now.value;
    await lane.tick();
    const day = store.getState().days["2026-08-26"]!;
    expect(day.symbolStates.AAAUSDT?.lastProcessedBarOpenTime).toBe(DAY + 4 * 3_600_000 + 10 * 60_000);
    expect(store.getState().signals).toHaveLength(0); // only the fresh post-arm candle is considered
    expect(inDailyRangeEntryWindow(DAY + 4 * 3_600_000)).toBe(true);
    expect(inDailyRangeEntryWindow(DAY + 24 * 3_600_000)).toBe(false);
    now.value = DAY + 28 * 3_600_000 + 10 * 60_000;
    client.now = now.value;
    await lane.tick();
    expect(store.getState().days["2026-08-27"]?.levels.AAAUSDT?.fourHourOpenTime).toBe(DAY + 24 * 3_600_000);
  });

  it("accepts equality, requires two consecutive closes, and resets each directional lock at the opposing boundary", () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const { lane } = makeLane(client, now);
    const state: DailyRangeSymbolState = { lastProcessedBarOpenTime: null, previousClosedCandle: null, longCount: 0, shortCount: 0, longLocked: false, shortLocked: false };
    const day: DailyRangeDayState = { dateUtc: "2026-08-26", initializedAt: new Date(now.value).toISOString(), universeSymbols: ["AAAUSDT"], universeSource: "TEST", levels: {}, invalidReferenceSymbols: [], symbolStates: { AAAUSDT: state } };
    const apply = (bar: DailyRangeCandle) => {
      const out = (lane as unknown as { applyCandle(day: DailyRangeDayState, level: DailyRangeLevel, state: DailyRangeSymbolState, bar: DailyRangeCandle): DailyRangeSignal | null }).applyCandle(day, level(), state, bar);
      state.previousClosedCandle = bar;
      return out;
    };
    const t = DAY + 4 * 3_600_000;
    expect(apply(candle(t, 100))).toBeNull();
    expect(apply(candle(t + 5 * 60_000, 100))?.direction).toBe("LONG");
    expect(apply(candle(t + 10 * 60_000, 101))).toBeNull();
    expect(apply(candle(t + 15 * 60_000, 90))).toBeNull(); // < HIGH resets the long lock; starts short C1
    expect(apply(candle(t + 20 * 60_000, 89))?.direction).toBe("SHORT");
    expect(apply(candle(t + 25 * 60_000, 100))).toBeNull(); // > LOW resets the short lock; starts long C1
    expect(apply(candle(t + 30 * 60_000, 101))?.direction).toBe("LONG");
    expect(apply(candle(t + 35 * 60_000, 95))).toBeNull(); // inside resets both locks
    expect(apply(candle(t + 40 * 60_000, 100))).toBeNull();
    expect(apply(candle(t + 45 * 60_000, 101))?.direction).toBe("LONG");
  });

  it("rounds structural SL after actual fill and preserves at least 2R reward", () => {
    const c1 = candle(0, 101, 98, 102);
    const c2 = candle(300_000, 102, 99, 103);
    expect(structuralStopForAcceptance({ direction: "LONG", rangeHigh: 100, rangeLow: 90, confirmationBar1: c1, confirmationBar2: c2 })).toBe(98);
    expect(structuralStopForAcceptance({ direction: "SHORT", rangeHigh: 100, rangeLow: 90, confirmationBar1: c1, confirmationBar2: c2 })).toBe(103);
    expect(roundDailyRangeBracket({ direction: "LONG", entry: 100.003, rawStop: 98.007, tickSize: 0.01 })).toMatchObject({ stop: 98, takeProfit: 104.01, riskPrice: 2.003 });
    const shortBracket = roundDailyRangeBracket({ direction: "SHORT", entry: 99.997, rawStop: 102.003, tickSize: 0.01 });
    expect(shortBracket?.stop).toBe(102.01);
    expect(shortBracket?.takeProfit).toBe(95.97);
    expect(shortBracket?.riskPrice).toBeCloseTo(2.013, 10);
  });

  it("skips an externally occupied symbol without submitting an entry", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    client.positions.set("AAAUSDT", { symbol: "AAAUSDT", positionAmt: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 0, unRealizedProfit: 0, leverage: 1, marginType: "CROSSED" });
    const { lane, store } = makeLane(client, now);
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value);
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    expect(client.placed).toHaveLength(0);
    expect(row.reason).toBe("SYMBOL_OCCUPIED_BY_OTHER_STRATEGY");
  });

  it("records a blocked short confirmation but never submits it", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const dir = dataDir();
    const store = new DailyRangeLaneStore(dir, "state.json", now.value);
    const lane = new DailyRangeAcceptanceLane({
      client, store, getUniverse: () => ({ symbols: ["AAAUSDT"], source: "TEST" }),
      getShortBlocklist: () => new Set(["AAAUSDT"]),
      entryClaims: { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
      environment: "testnet", nowMs: () => now.value, confirmRetryMs: 0,
    });
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value, "SHORT");
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    expect(row.reason).toBe("SHORT_BLOCKED");
    expect(client.placed).toHaveLength(0);
  });

  it("opens ten distinct same-minute signals without a hidden lane-global trade cap", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const claims = new Set<string>();
    const { lane, store } = makeLane(client, now, symbols, {
      tryClaimEntrySymbol: (symbol) => !claims.has(symbol) && (claims.add(symbol), true),
      releaseEntrySymbol: (symbol) => { claims.delete(symbol); },
    });
    store.arm(new Date(now.value).toISOString());
    const rows = symbols.map((symbol) => signal(symbol, now.value));
    store.getState().signals.push(...rows);
    await Promise.all(rows.map((row) => (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row)));
    expect(client.placed.filter((order) => !order.reduceOnly)).toHaveLength(10);
    expect(store.getState().trades.filter((trade) => trade.status === "OPEN")).toHaveLength(10);
    expect(client.algoPlaced).toHaveLength(20);
    expect(store.getState().trades.every((trade) => trade.entrySlippageBps === 0)).toBe(true);
  });

  it("reconciles a terminal partial market fill into an exact-quantity protected trade", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    client.nextEntryPartialFill = { qty: 0.125, status: "EXPIRED" };
    const { lane, store } = makeLane(client, now);
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value);
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    const trade = store.getState().trades[0]!;
    expect(trade.status).toBe("ENTRY_RECONCILING");
    await (lane as unknown as { reconcilePendingEntries(): Promise<void> }).reconcilePendingEntries();
    expect(trade.status).toBe("OPEN");
    expect(trade.entryQty).toBe(0.125);
    expect(client.algoPlaced).toHaveLength(2);
    expect(client.algoPlaced.every((order) => order.quantity === 0.125)).toBe(true);
  });

  it("publishes only proven open ownership and clears a stale reconciliation alarm after brackets verify", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const { lane, store } = makeLane(client, now);
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value, "SHORT");
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);

    const trade = store.getState().trades[0]!;
    expect(trade.status).toBe("OPEN");
    trade.lastReconcileError = "account reconciliation unavailable: rate limited (HTTP 418)";
    await (lane as unknown as { reconcileOpenTrades(): Promise<void> }).reconcileOpenTrades();

    expect(trade.lastReconcileError).toBeNull();
    expect(lane.getOpenPositionClaims()).toEqual([expect.objectContaining({
      laneId: "DAILY_4H_RANGE_ACCEPTANCE",
      tradeId: trade.tradeId,
      symbol: "AAAUSDT",
      direction: "SHORT",
      qty: trade.entryQty,
      entryPrice: trade.entryFillPrice,
      status: "OPEN",
      stopPrice: trade.stopPrice,
      takeProfitPrice: trade.takeProfitPrice,
      lastReconcileError: null,
    })]);
    expect(lane.getActiveLeaseSymbols()).toEqual(["AAAUSDT"]);

    // A submitted/reconciling entry is deliberately not attributed until an exact
    // fill and still-open position are both proven. It nevertheless remains a
    // one-way-netting lease, so a forming cross-sectional basket must skip it.
    trade.status = "ENTRY_RECONCILING";
    expect(lane.getOpenPositionClaims()).toEqual([]);
    expect(lane.getActiveLeaseSymbols()).toEqual(["AAAUSDT"]);
    trade.status = "CLOSED";
    expect(lane.getActiveLeaseSymbols()).toEqual([]);
  });

  it("records actual fills, fees, entry/exit slippage, and cancels both owned siblings on a controlled lane close", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const { lane, store } = makeLane(client, now);
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value);
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    const trade = store.getState().trades[0]!;
    const result = await lane.manualCloseTrade(trade.tradeId);
    expect(result.ok).toBe(true);
    expect(trade.status).toBe("CLOSED");
    expect(trade.entrySlippageBps).toBe(0);
    expect(trade.exitSlippageBps).toBe(0);
    expect(trade.feesUsd).toBeCloseTo(0.02, 10);
    expect(client.cancelledAlgos).toHaveLength(2);
    expect((await client.getOpenAlgoOrders("AAAUSDT"))).toHaveLength(0);
    expect((await client.getPositions("AAAUSDT")).some((position) => Math.abs(position.positionAmt) > 0)).toBe(false);
  });

  it("passes an exchange-like canary lifecycle: entry, brackets, sibling cancel, flat, no orphan", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    client.klines.set("AAAUSDT|4h", [referenceFourHour()]);
    const { lane } = makeLane(client, now);
    const evidence = await lane.runCanary();
    expect(evidence.status).toBe("PASSED");
    expect(evidence.positionVerified).toBe(true);
    expect(evidence.bracketVerified).toBe(true);
    expect(evidence.bracketCancelled).toBe(true);
    expect(evidence.closeVerified).toBe(true);
    expect(evidence.orphanPosition).toBe(false);
    expect(evidence.orphanOrders).toBe(0);
    expect(client.cancelledAlgos).toHaveLength(2);
  });

  it("keeps a mainnet lane structurally unable to arm, canary, or submit with no dedicated controls", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const { lane, store } = makeMainnetLane(client, now);
    expect(lane.arm()).toMatchObject({ ok: false, mode: "DISARMED" });
    await expect(lane.runCanary()).rejects.toThrow("mainnet execution is disabled");

    // A stale/hand-edited persisted ARMED state cannot bypass the class-level
    // policy. This models the exact failure mode a deployment guard must stop.
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value);
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    expect(row.reason).toBe("MAINNET_EXECUTION_DISABLED");
    expect(client.placed).toHaveLength(0);
  });

  it("enforces mainnet account gate and atomic open-trade/notional caps before every entry", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const denied = makeMainnetLane(client, now, mainnetControls(), () => ({ allowed: false, reason: "account kill switch" }));
    denied.store.arm(new Date(now.value).toISOString());
    const deniedSignal = signal("AAAUSDT", now.value);
    denied.store.getState().signals.push(deniedSignal);
    await (denied.lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(deniedSignal);
    expect(deniedSignal.reason).toBe("ACCOUNT_ENTRY_BLOCKED");
    expect(client.placed).toHaveLength(0);

    const capped = makeMainnetLane(client, now, mainnetControls());
    capped.store.arm(new Date(now.value).toISOString());
    const first = signal("BBBUSDT", now.value);
    const second = signal("CCCUSDT", now.value);
    capped.store.getState().signals.push(first, second);
    await Promise.all([first, second].map((row) =>
      (capped.lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row),
    ));
    expect(client.placed.filter((order) => !order.reduceOnly)).toHaveLength(1);
    expect(capped.store.getState().trades.filter((trade) => trade.status === "OPEN")).toHaveLength(1);
    expect(["MAX_OPEN_TRADES_REACHED", "MAX_GROSS_NOTIONAL_REACHED"]).toContain(second.reason);
  });

  it("persists watermarks/locks across a restart and does not duplicate a prior C1/C2 run", async () => {
    const dir = dataDir();
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    client.klines.set("AAAUSDT|4h", [referenceFourHour()]);
    const c1 = candle(DAY + 4 * 3_600_000 + 10 * 60_000, 100);
    const c2 = candle(DAY + 4 * 3_600_000 + 15 * 60_000, 101);
    client.klines.set("AAAUSDT|5m", [c1, c2]);
    const claim = { tryClaimEntrySymbol: () => false, releaseEntrySymbol: () => {} };
    const firstStore = new DailyRangeLaneStore(dir, "state.json", now.value);
    const first = new DailyRangeAcceptanceLane({ client, store: firstStore, getUniverse: () => ({ symbols: ["AAAUSDT"], source: "TEST" }), getShortBlocklist: () => new Set(), entryClaims: claim, environment: "testnet", nowMs: () => now.value, confirmRetryMs: 0 });
    await first.tick();
    firstStore.arm(new Date(now.value).toISOString());
    now.value = DAY + 4 * 3_600_000 + 20 * 60_000;
    client.now = now.value;
    const restartedStore = new DailyRangeLaneStore(dir, "state.json", now.value);
    const restarted = new DailyRangeAcceptanceLane({ client, store: restartedStore, getUniverse: () => ({ symbols: ["AAAUSDT"], source: "TEST" }), getShortBlocklist: () => new Set(), entryClaims: claim, environment: "testnet", nowMs: () => now.value, confirmRetryMs: 0 });
    await restarted.tick();
    expect(restartedStore.getState().signals).toHaveLength(1);
    const secondRestart = new DailyRangeAcceptanceLane({ client, store: new DailyRangeLaneStore(dir, "state.json", now.value), getUniverse: () => ({ symbols: ["AAAUSDT"], source: "TEST" }), getShortBlocklist: () => new Set(), entryClaims: claim, environment: "testnet", nowMs: () => now.value, confirmRetryMs: 0 });
    await secondRestart.tick();
    expect(new DailyRangeLaneStore(dir, "state.json", now.value).getState().signals).toHaveLength(1);
  });
});

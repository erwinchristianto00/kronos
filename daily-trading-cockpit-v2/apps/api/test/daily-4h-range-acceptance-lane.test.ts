import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BinanceFuturesPrivateError,
  type FuturesAlgoOrder,
  type FuturesExecutionBookTicker,
  type FuturesIncomeEntry,
  type FuturesKline,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
  type PlaceAlgoOrderParams,
  type PlaceOrderParams,
} from "../src/lib/binance-futures-private.js";
import {
  DailyRangeAcceptanceLane,
  DailyRangeLaneStore,
  inDailyRangeEntryWindow,
  newYorkDailyRangeWindow,
  roundDailyRangeBracket,
  structuralStopForDailyRangeSignal,
  structuralStopForAcceptance,
  type DailyRangeCandle,
  type DailyRangeCanaryEvidence,
  type DailyRangeDayState,
  type DailyRangeExecClient,
  type DailyRangeLevel,
  type DailyRangeSignal,
  type DailyRangeStrategyMode,
  type DailyRangeSymbolState,
} from "../src/lib/daily-4h-range-acceptance-lane.js";
import type { DailyRangePoolEvidence } from "../src/lib/daily-range-auto-pool.js";
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
  return { openTime, closeTime: openTime + 5 * 60_000 - 1, open: 100, high, low, close, volume: 1 };
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
  readonly algoHistory = new Map<string, FuturesAlgoOrder>();
  readonly fills: FuturesUserTrade[] = [];
  readonly fiveMinuteReadSymbols = new Set<string>();
  readonly entryCoverageSnapshots: string[][] = [];
  readonly eventLog: string[] = [];
  beforeEntry: (() => void) | null = null;
  failNextEntry = false;
  bookTimeOffsetMs = 0;
  /** A native exit may settle between Binance's separate position and algo-book reads. */
  nativeExitOnNextOpenAlgoRead: string | null = null;
  /** Simulates a terminal partial MARKET fill: safe handling must bracket the
   * actual quantity rather than treating the requested quantity as fact. */
  nextEntryPartialFill: { qty: number; status: "CANCELED" | "EXPIRED" } | null = null;
  private orderNo = 1;
  private algoNo = 1;

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    return new Map(symbols.map((symbol) => [symbol, filter(symbol)]));
  }
  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    // Real REST responses are snapshots. Returning clones matters for the
    // native-exit race fixture below: an algo read can settle a position after
    // this call has already returned its earlier non-zero observation.
    const rows = [...this.positions.values()].map((row) => ({ ...row }));
    return symbol ? rows.filter((row) => row.symbol === symbol) : rows;
  }
  async getOpenOrders(_symbol?: string): Promise<FuturesOrder[]> { return []; }
  async getOpenAlgoOrders(symbol?: string): Promise<FuturesAlgoOrder[]> {
    const exiting = this.nativeExitOnNextOpenAlgoRead;
    if (exiting && (symbol === undefined || symbol === exiting)) {
      this.nativeExitOnNextOpenAlgoRead = null;
      this.positions.delete(exiting);
      for (const [algoId, algo] of this.algos) {
        if (algo.symbol === exiting) this.algos.delete(algoId);
      }
    }
    const rows = [...this.algos.values()];
    return symbol ? rows.filter((row) => row.symbol === symbol) : rows;
  }
  async getBookTicker(symbol: string): Promise<FuturesExecutionBookTicker> {
    this.eventLog.push(`book:${symbol}`);
    return { bid: 100, ask: 100, bidQty: 100, askQty: 100, time: this.now + this.bookTimeOffsetMs };
  }
  async getKlines(symbol: string, interval: "1m" | "5m" | "4h", opts: { startTime?: number; endTime?: number } = {}): Promise<FuturesKline[]> {
    if (interval === "5m") this.fiveMinuteReadSymbols.add(symbol);
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
    if (!params.reduceOnly) {
      this.eventLog.push(`entry:${params.symbol}`);
      this.entryCoverageSnapshots.push([...this.fiveMinuteReadSymbols].sort());
      this.beforeEntry?.();
      if (this.failNextEntry) {
        this.failNextEntry = false;
        throw new BinanceFuturesPrivateError("binance_error", "synthetic selected-entry rejection");
      }
    }
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
    const algo = this.algos.get(algoId) ?? this.algoHistory.get(algoId);
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

function researchFiveMinuteHistory(c1Open: number, c2Open: number): FuturesKline[] {
  const rows: FuturesKline[] = [];
  for (let offset = 59; offset >= 0; offset--) {
    const openTime = c2Open - offset * 5 * 60_000;
    const close = openTime === c1Open ? 100 : openTime === c2Open ? 101 : 99;
    rows.push(candle(openTime, close));
  }
  return rows;
}

function makeLane(
  client: FakeDailyClient,
  nowRef: { value: number },
  universe = ["AAAUSDT"],
  claim = { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
  strategyMode: DailyRangeStrategyMode = "LEGACY_CONTINUATION",
) {
  const dir = dataDir();
  const store = new DailyRangeLaneStore(dir, "state.json", nowRef.value);
  const lane = new DailyRangeAcceptanceLane({
    client,
    store,
    getUniverse: () => ({ symbols: universe, source: "TEST" }),
    getShortBlocklist: () => new Set<string>(),
    entryClaims: claim,
    environment: "testnet",
    strategyMode,
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
    newEntryMode: "ENABLED",
    allocatorMode: "SEEDED_RANDOM_BASELINE",
    ...overrides,
  };
}

function poolEvidence(universe: readonly string[]): DailyRangePoolEvidence {
  return {
    schemaVersion: 1,
    poolVersion: 2,
    state: "ACTIVE",
    source: "BINANCE_USDM_MAINNET_PUBLIC",
    capturedAt: new Date(AT_0410 - 60_000).toISOString(),
    activeSymbols: [...universe],
    thresholds: {
      minNotionalUsd: 25,
      maxMinQtyNotionalUsd: 25,
      maxStepNotionalUsd: 2.5,
      targetLiquidity24hUsd: 20_000_000,
      liquidityEnter24hUsd: 22_000_000,
      liquidityLeave24hUsd: 18_000_000,
      liquidityHysteresisFraction: 0.1,
      medianSpreadMaxBps: 5,
      hardSpreadMaxBps: 10,
      minListingDays: 60,
      fiveMinuteFreshnessMs: 600_000,
      fourHourFreshnessMs: 28_800_000,
    },
    reconciliation: {
      changed: false,
      adds: [...universe],
      drops: [],
      exchangePerpetualCandidates: universe.length,
      eligibleCount: universe.length,
      rejectionCounts: {},
      crossSectionalExcluded: [],
      strategyOwnedExcluded: [],
    },
    auditBySymbol: Object.fromEntries(universe.map((symbol) => [symbol, {
      symbol,
      eligible: true,
      failures: [],
      quoteVolume24hUsd: 50_000_000,
      minNotionalUsd: 5,
      minQtyNotionalUsd: 1,
      stepNotionalUsd: 0.1,
      listedDays: 365,
      medianSpreadBps: 1.5,
      maxObservedSpreadBps: 2,
      fiveMinuteData: "OK" as const,
      fourHourData: "OK" as const,
    }])),
    missingAuditSymbols: [],
  };
}

function makeMainnetLane(
  client: FakeDailyClient,
  nowRef: { value: number },
  controls?: DailyRangeMainnetControls,
  entryGate = () => ({ allowed: true, reason: null }),
  universe = symbols,
  evidence: DailyRangePoolEvidence | null = null,
  signalEvidence: (() => DailyRangePoolEvidence | null) | undefined = undefined,
) {
  const dir = dataDir();
  const store = new DailyRangeLaneStore(dir, "state.json", nowRef.value);
  const lane = new DailyRangeAcceptanceLane({
    client,
    store,
    getUniverse: () => ({ symbols: universe, source: "TEST", poolEvidence: evidence }),
    getSignalPoolEvidence: signalEvidence,
    getShortBlocklist: () => new Set<string>(),
    entryClaims: { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
    environment: "mainnet",
    mainnetControls: controls,
    allocatorMode: controls?.allocatorMode ?? "PAUSED",
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

async function runNaturalMainnetBatch(input: {
  universe: string[];
  controls?: DailyRangeMainnetControls;
  evidence?: DailyRangePoolEvidence;
  signalEvidence?: () => DailyRangePoolEvidence | null;
  bookTimeOffsetMs?: number;
}): Promise<{ client: FakeDailyClient; lane: DailyRangeAcceptanceLane; store: DailyRangeLaneStore; now: { value: number } }> {
  const now = { value: AT_0410 };
  const client = new FakeDailyClient();
  client.bookTimeOffsetMs = input.bookTimeOffsetMs ?? 0;
  const c1Open = DAY + 4 * 3_600_000 + 10 * 60_000;
  const c2Open = DAY + 4 * 3_600_000 + 15 * 60_000;
  const history = researchFiveMinuteHistory(c1Open, c2Open);
  for (const symbol of input.universe) {
    client.klines.set(`${symbol}|4h`, [referenceFourHour()]);
    client.klines.set(`${symbol}|5m`, history);
  }
  client.klines.set("BTCUSDT|5m", history);
  client.klines.set("ETHUSDT|5m", history);
  const subject = makeMainnetLane(
    client,
    now,
    input.controls ?? mainnetControls(),
    () => ({ allowed: true, reason: null }),
    input.universe,
    input.evidence ?? poolEvidence(input.universe),
    input.signalEvidence,
  );
  await subject.lane.tick();
  subject.store.arm(new Date(now.value).toISOString());
  now.value = DAY + 4 * 3_600_000 + 21 * 60_000;
  client.now = now.value;
  await subject.lane.tick();
  return { client, lane: subject.lane, store: subject.store, now };
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

  it("resets the acceptance state at re-arm and never enters a candle pair completed while disarmed", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    client.klines.set("AAAUSDT|4h", [referenceFourHour()]);
    const c1 = candle(DAY + 4 * 3_600_000 + 10 * 60_000, 100);
    const c2 = candle(DAY + 4 * 3_600_000 + 15 * 60_000, 101);
    client.klines.set("AAAUSDT|5m", [c1, c2]);
    const { lane, store } = makeLane(client, now);
    await lane.tick(); // initializes while disarmed, with 04:05 as the watermark

    // Model a C1 which had been observed before a later operator disarm.
    const day = store.getState().days["2026-08-26"]!;
    day.symbolStates.AAAUSDT = {
      lastProcessedBarOpenTime: c1.openTime,
      previousClosedCandle: c1,
      longCount: 1,
      shortCount: 0,
      longLocked: false,
      shortLocked: false,
    };
    store.disarm(new Date(now.value).toISOString(), "operator review");
    store.getState().canaries.push({
      canaryId: "DRCANARY-passed", at: new Date(now.value).toISOString(), status: "PASSED", symbol: "AAAUSDT", side: "BUY",
      intendedNotionalUsd: 25, leverage: 1, requestedQty: 0.25,
      entryOrderId: "1", entryClientOrderId: "DRCANARY-passed-E", entryFillPrice: 100, entryQty: 0.25,
      stopAlgoOrderId: "2", takeProfitAlgoOrderId: "3", closeOrderId: "4",
      positionVerified: true, bracketVerified: true, bracketCancelled: true, closeVerified: true,
      orphanOrders: 0, orphanPosition: false, failure: null,
    });

    now.value = DAY + 4 * 3_600_000 + 21 * 60_000; // c2 completed while DISARMED
    client.now = now.value;
    expect(lane.arm()).toMatchObject({ ok: true, mode: "ARMED" });
    await lane.tick();

    const rearmed = store.getState().days["2026-08-26"]!.symbolStates.AAAUSDT!;
    expect(rearmed.lastProcessedBarOpenTime).toBe(c2.openTime);
    expect(rearmed.previousClosedCandle).toBeNull();
    expect(rearmed.longCount).toBe(0);
    expect(store.getState().signals).toHaveLength(0);
    expect(client.placed).toHaveLength(0);
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

  it("enforces the same three-trade cap for Testnet baseline allocation", async () => {
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
    expect(client.placed.filter((order) => !order.reduceOnly)).toHaveLength(3);
    expect(store.getState().trades.filter((trade) => trade.status === "OPEN")).toHaveLength(3);
    expect(client.algoPlaced).toHaveLength(6);
    expect(rows.filter((row) => row.reason === "MAX_OPEN_TRADES_REACHED")).toHaveLength(7);
    expect(lane.getStatus()).toMatchObject({ maxDailyPositions: 3, availableSlots: 0, openDailyPositions: 3 });
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
    // Before adoption, the exchange may show any partial between 0 and the
    // requested 0.25. It must be a bounded pending claim, not a false exact
    // managed position that would make account reconciliation disarm.
    expect(lane.managedNetQty().has("AAAUSDT")).toBe(false);
    expect(lane.pendingEntryNetQty().get("AAAUSDT")).toBe(0.25);
    await (lane as unknown as { reconcilePendingEntries(): Promise<void> }).reconcilePendingEntries();
    expect(trade.status).toBe("OPEN");
    expect(trade.entryQty).toBe(0.125);
    expect(lane.managedNetQty().get("AAAUSDT")).toBe(0.125);
    expect(lane.pendingEntryNetQty().has("AAAUSDT")).toBe(false);
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

  it("does not false-disarm when a native exit settles between position and algo snapshots", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const { lane, store } = makeLane(client, now);
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value, "SHORT");
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    const trade = store.getState().trades[0]!;

    // getPositions() first returns a live snapshot, then the next algo-book
    // read simulates a native exit that has already flattened the account.
    client.nativeExitOnNextOpenAlgoRead = "AAAUSDT";
    await (lane as unknown as { reconcileOpenTrades(): Promise<void> }).reconcileOpenTrades();

    expect(store.getState().control.mode).toBe("ARMED");
    expect(trade.status).toBe("EXIT_RECONCILING");
    expect(trade.lastReconcileError).toContain("exchange is flat");
    expect(client.placed.filter((order) => order.reduceOnly)).toHaveLength(0);
  });

  it("still disarms and flattens when a refreshed owned position is genuinely missing a bracket", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const { lane, store } = makeLane(client, now);
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value, "SHORT");
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    const trade = store.getState().trades[0]!;
    client.algos.delete(trade.stopAlgoOrderId!);

    await (lane as unknown as { reconcileOpenTrades(): Promise<void> }).reconcileOpenTrades();

    expect(store.getState().control.mode).toBe("DISARMED");
    expect(client.placed.filter((order) => order.reduceOnly)).toHaveLength(1);
  });

  it("waits for a triggered native exit instead of racing it with a second close", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const { lane, store } = makeLane(client, now);
    store.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value, "SHORT");
    store.getState().signals.push(row);
    await (lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    const trade = store.getState().trades[0]!;
    const takeProfit = client.algos.get(trade.takeProfitAlgoOrderId!)!;
    client.algos.delete(takeProfit.algoId);
    client.algoHistory.set(takeProfit.algoId, { ...takeProfit, algoStatus: "FINISHED", actualOrderId: "native-exit" });

    await (lane as unknown as { reconcileOpenTrades(): Promise<void> }).reconcileOpenTrades();

    expect(store.getState().control.mode).toBe("ARMED");
    expect(trade.status).toBe("EXIT_RECONCILING");
    expect(trade.lastReconcileError).toContain("native exit transition");
    expect(client.placed.filter((order) => order.reduceOnly)).toHaveLength(0);
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
    expect(evidence.requestedQty).toBe(0.25);
    expect(client.cancelledAlgos).toHaveLength(2);
  });

  it("publishes a bounded pending claim while a DRCANARY is in flight", () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const { lane, store } = makeLane(client, now);
    const canary: DailyRangeCanaryEvidence = {
      canaryId: "DRCANARY-test", at: new Date(now.value).toISOString(), status: "RUNNING", symbol: "AAAUSDT", side: "BUY",
      intendedNotionalUsd: 25, leverage: 1, requestedQty: 0.25,
      entryOrderId: null, entryClientOrderId: "DRCANARY-test-E", entryFillPrice: null, entryQty: null,
      stopAlgoOrderId: null, takeProfitAlgoOrderId: null, closeOrderId: null,
      positionVerified: false, bracketVerified: false, bracketCancelled: false, closeVerified: false,
      orphanOrders: null, orphanPosition: null, failure: null,
    };
    store.getState().canaries.push(canary);
    expect(lane.managedNetQty().has("AAAUSDT")).toBe(false);
    expect(lane.pendingEntryNetQty().get("AAAUSDT")).toBe(0.25);
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

  it("persists frozen C1-C6 evidence and complete same-bar candidates before neutral allocation", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const universe = ["AAAUSDT", "BBBUSDT"];
    const evidence = poolEvidence(universe);
    for (const symbol of universe) {
      client.klines.set(`${symbol}|4h`, [referenceFourHour()]);
      client.klines.set(`${symbol}|5m`, [
        candle(DAY + 4 * 3_600_000 + 10 * 60_000, 100),
        candle(DAY + 4 * 3_600_000 + 15 * 60_000, 101),
      ]);
    }
    const subject = makeMainnetLane(client, now, mainnetControls(), () => ({ allowed: true, reason: null }), universe, evidence);
    await subject.lane.tick(); // freezes the range/pool proof while disarmed
    expect(subject.store.getState().days["2026-08-26"]?.poolEvidence?.auditBySymbol.AAAUSDT?.quoteVolume24hUsd).toBe(50_000_000);
    evidence.auditBySymbol.AAAUSDT!.quoteVolume24hUsd = 1; // later rolling mutation must not rewrite history
    expect(subject.store.getState().days["2026-08-26"]?.poolEvidence?.auditBySymbol.AAAUSDT?.quoteVolume24hUsd).toBe(50_000_000);

    subject.store.arm(new Date(now.value).toISOString());
    now.value = DAY + 4 * 3_600_000 + 21 * 60_000;
    client.now = now.value;
    await subject.lane.tick();

    const cohort = subject.store.getState().signalCohorts[0]!;
    expect(cohort.selectorPolicyVersion).toBe("DAILY_RANGE_BATCH_SELECTOR_SHADOW_V1");
    expect(cohort.candidates.map((candidate) => [candidate.symbol, candidate.executionSequence, candidate.cohortSequence]))
      .toEqual([["AAAUSDT", 0, 0], ["BBBUSDT", 1, 1]]);
    expect(cohort.candidates[0]?.breakoutDistanceOfRange).toBeCloseTo(0.1);
    expect(cohort.candidates[0]?.poolAudit?.quoteVolume24hUsd).toBe(50_000_000);
    expect(cohort.allocation).toMatchObject({ batchComplete: true, candidateCount: 2, availableSlots: 1 });
    expect(cohort.candidates.filter((candidate) => candidate.actuallySelected)).toHaveLength(1);
    expect(cohort.candidates.filter((candidate) => candidate.skipReason === "SKIP_CAP_LOWER_RANK")).toHaveLength(1);
    expect(client.placed.filter((order) => !order.reduceOnly)).toHaveLength(1);

    const savedEvidence = subject.lane.history("pool-evidence") as Array<{ evidence: DailyRangePoolEvidence }>;
    expect(savedEvidence[0]?.evidence.auditBySymbol.AAAUSDT?.quoteVolume24hUsd).toBe(50_000_000);
  });

  it("CONFIRMED_LOOP_ORDER_SELECTION_BIAS: the historical per-signal execution path chooses whichever row arrives first", async () => {
    const runLegacy = async (order: string[]): Promise<string | undefined> => {
      const now = { value: AT_0410 };
      const client = new FakeDailyClient();
      const subject = makeMainnetLane(client, now, mainnetControls(), () => ({ allowed: true, reason: null }), ["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
      subject.store.arm(new Date(now.value).toISOString());
      const rows = order.map((symbol) => signal(symbol, now.value));
      subject.store.getState().signals.push(...rows);
      for (const row of rows) {
        await (subject.lane as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
      }
      return client.placed.find((orderRow) => !orderRow.reduceOnly)?.symbol;
    };

    await expect(runLegacy(["AAAUSDT", "BBBUSDT", "CCCUSDT"])).resolves.toBe("AAAUSDT");
    await expect(runLegacy(["CCCUSDT", "BBBUSDT", "AAAUSDT"])).resolves.toBe("CCCUSDT");
    await expect(runLegacy(["BBBUSDT", "AAAUSDT", "CCCUSDT"])).resolves.toBe("BBBUSDT");
  });

  it("makes natural same-candle allocation invariant to universe/input order", async () => {
    const variants = [
      ["AAAUSDT", "BBBUSDT", "CCCUSDT"],
      ["CCCUSDT", "BBBUSDT", "AAAUSDT"],
      ["BBBUSDT", "AAAUSDT", "CCCUSDT"],
    ];
    const selected = [] as string[];
    for (const universe of variants) {
      const subject = await runNaturalMainnetBatch({ universe });
      const batch = subject.store.getState().signalCohorts.find((row) => row.allocation)?.allocation;
      expect(batch?.batchComplete).toBe(true);
      selected.push(batch?.selectedSignalIds[0] ?? "");
    }
    expect(new Set(selected).size).toBe(1);
  });

  it("labels an explicitly enabled Live seeded baseline as having no validated alpha selector", async () => {
    const subject = await runNaturalMainnetBatch({ universe: ["AAAUSDT"] });
    expect(subject.lane.getStatus()).toMatchObject({
      allocatorMode: "SEEDED_RANDOM_BASELINE",
      selectorStatus: "NO_VALIDATED_ALPHA_SELECTOR",
    });
  });

  it("does not submit an order until every symbol in the same 5m batch has completed evaluation", async () => {
    const universe = ["AAAUSDT", "BBBUSDT", "CCCUSDT"];
    const subject = await runNaturalMainnetBatch({ universe });
    expect(subject.client.entryCoverageSnapshots[0]).toEqual([...universe].sort());
    expect(subject.client.placed.filter((order) => !order.reduceOnly)).toHaveLength(1);
  });

  it("reserves at most one slot for five simultaneous signals and never later enters a lower-ranked stale signal", async () => {
    const universe = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"];
    const subject = await runNaturalMainnetBatch({ universe });
    const batch = subject.store.getState().signalCohorts.find((row) => row.allocation)!;
    expect(batch.allocation?.selectedSignalIds).toHaveLength(1);
    expect(subject.store.getState().trades.filter((trade) => !trade.status.startsWith("ENTRY_ABORT_") && trade.status !== "CLOSED")).toHaveLength(1);
    expect(subject.client.placed.filter((order) => !order.reduceOnly)).toHaveLength(1);
    expect(batch.candidates.filter((candidate) => candidate.skipReason === "SKIP_CAP_LOWER_RANK")).toHaveLength(4);

    // Simulate a later native close. The already-ranked losers are terminal
    // batch decisions, not a queue to be filled when a later slot opens.
    const selectedTrade = subject.store.getState().trades[0]!;
    selectedTrade.status = "CLOSED";
    subject.now.value += 5 * 60_000;
    subject.client.now = subject.now.value;
    await subject.lane.tick();
    expect(subject.client.placed.filter((order) => !order.reduceOnly)).toHaveLength(1);
  });

  it("uses a durable allocator lock to reject a second local authority", () => {
    const dir = dataDir();
    const first = new DailyRangeLaneStore(dir, "state.json", AT_0410);
    const second = new DailyRangeLaneStore(dir, "state.json", AT_0410);
    const lock = first.tryAcquireAllocatorLock(AT_0410);
    expect(lock).not.toBeNull();
    expect(second.tryAcquireAllocatorLock(AT_0410)).toBeNull();
    lock?.release();
    const recovered = second.tryAcquireAllocatorLock(AT_0410 + 1);
    expect(recovered).not.toBeNull();
    recovered?.release();
  });

  it("keeps an armed Mainnet lane collecting complete batches while only new entries are paused", async () => {
    const controls = mainnetControls({ newEntryMode: "PAUSED_SELECTION_FIX", allocatorMode: "PAUSED" });
    const subject = await runNaturalMainnetBatch({ universe: ["AAAUSDT", "BBBUSDT"], controls });
    const batch = subject.store.getState().signalCohorts.find((row) => row.allocation)!;
    expect(batch.allocation).toMatchObject({ batchComplete: true, selectedSignalIds: [] });
    expect(batch.candidates.every((candidate) => candidate.skipReason === "LIVE_NEW_ENTRY_PAUSED")).toBe(true);
    expect(subject.client.placed.filter((order) => !order.reduceOnly)).toHaveLength(0);
    expect(subject.lane.getStatus()).toMatchObject({ newEntriesEnabled: false, newEntryReason: "SELECTION_FIX_PENDING_VALIDATION" });
  });

  it("keeps an existing owned position and both native brackets untouched across a paused Mainnet restart", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const dir = dataDir();
    client.klines.set("AAAUSDT|4h", [referenceFourHour()]);
    const firstStore = new DailyRangeLaneStore(dir, "state.json", now.value);
    const testnet = new DailyRangeAcceptanceLane({
      client,
      store: firstStore,
      getUniverse: () => ({ symbols: ["AAAUSDT"], source: "TEST" }),
      getShortBlocklist: () => new Set<string>(),
      entryClaims: { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
      environment: "testnet",
      nowMs: () => now.value,
      confirmRetryMs: 0,
    });
    firstStore.arm(new Date(now.value).toISOString());
    const row = signal("AAAUSDT", now.value, "SHORT");
    firstStore.getState().signals.push(row);
    await (testnet as unknown as { executeFreshSignal(signal: DailyRangeSignal): Promise<void> }).executeFreshSignal(row);
    const before = firstStore.getState().trades[0]!;
    const identity = {
      qty: before.entryQty,
      entry: before.entryFillPrice,
      side: before.direction,
      stop: before.stopAlgoOrderId,
      takeProfit: before.takeProfitAlgoOrderId,
      strategy: before.strategyVersion,
    };
    const orderCount = client.placed.length;
    const restartStore = new DailyRangeLaneStore(dir, "state.json", now.value);
    const pausedMainnet = new DailyRangeAcceptanceLane({
      client,
      store: restartStore,
      getUniverse: () => ({ symbols: ["AAAUSDT"], source: "TEST" }),
      getShortBlocklist: () => new Set<string>(),
      entryClaims: { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
      environment: "mainnet",
      mainnetControls: mainnetControls({ newEntryMode: "PAUSED_SELECTION_FIX", allocatorMode: "PAUSED" }),
      allocatorMode: "PAUSED",
      nowMs: () => now.value,
      confirmRetryMs: 0,
    });
    await pausedMainnet.tick();

    const after = restartStore.getState().trades[0]!;
    expect({
      qty: after.entryQty,
      entry: after.entryFillPrice,
      side: after.direction,
      stop: after.stopAlgoOrderId,
      takeProfit: after.takeProfitAlgoOrderId,
      strategy: after.strategyVersion,
    }).toEqual(identity);
    expect(after.status).toBe("OPEN");
    expect(client.cancelledAlgos).toHaveLength(0);
    expect(client.placed).toHaveLength(orderCount);
    expect(pausedMainnet.getStatus()).toMatchObject({ newEntriesEnabled: false, newEntryReason: "SELECTION_FIX_PENDING_VALIDATION" });
  });

  it("freezes the causal C1-C6 proof and a decision-time BBO before allocation", async () => {
    const evidence = poolEvidence(["AAAUSDT", "BBBUSDT"]);
    evidence.auditBySymbol.AAAUSDT!.quoteVolume24hUsd = 42_000_000;
    const subject = await runNaturalMainnetBatch({
      universe: ["AAAUSDT", "BBBUSDT"],
      evidence,
    });
    const aaa = subject.store.getState().signals.find((row) => row.symbol === "AAAUSDT")!;
    expect(aaa.research?.marketQuality).toMatchObject({
      pitQuality: "FULL_PIT",
      capturePhase: "FORWARD_BEFORE_ALLOCATION",
      bookSnapshotQuality: "AT_DECISION_BEFORE_ALLOCATION",
      quoteVolume24hUsd: 42_000_000,
      c1Pass: true,
      c6Pass: true,
    });
    expect(aaa.research?.features).toMatchObject({
      schemaVersion: 1,
      pitQuality: "FULL_PIT",
      breakout: expect.objectContaining({ c2ExtensionOfRange: expect.any(Number) }),
      relativeVolume: expect.objectContaining({ confirmation2: 1 }),
    });
    expect(aaa.research?.counterfactual).toMatchObject({ status: "PENDING", entryConvention: "C2_CLOSE_PIT_CANONICAL_V1" });
    expect(Math.max(...subject.client.eventLog.map((event, index) => event.startsWith("book:") ? index : -1)))
      .toBeLessThan(subject.client.eventLog.findIndex((event) => event.startsWith("entry:")));
    evidence.auditBySymbol.AAAUSDT!.quoteVolume24hUsd = 1;
    expect(aaa.research?.marketQuality?.quoteVolume24hUsd).toBe(42_000_000);
  });

  it("never upgrades a recovery read or a future exchange timestamp into FULL_PIT", async () => {
    const evidence = poolEvidence(["AAAUSDT"]);
    const recovery = await runNaturalMainnetBatch({ universe: ["AAAUSDT"], evidence });
    const recoverySignal = recovery.store.getState().signals[0]!;
    recoverySignal.research!.marketQuality = null;
    recovery.now.value += 60_000;
    recovery.client.now = recovery.now.value;
    const day = recovery.store.getState().days["2026-08-26"]!;
    await (recovery.lane as unknown as {
      capturePendingResearchSnapshots(day: DailyRangeDayState): Promise<void>;
    }).capturePendingResearchSnapshots(day);
    expect(recoverySignal.research?.marketQuality).toMatchObject({
      pitQuality: "PARTIAL_RECONSTRUCTION",
      capturePhase: "RECOVERY_AFTER_ALLOCATION",
      bookSnapshotQuality: "RECOVERY_AFTER_ALLOCATION",
    });

    const future = await runNaturalMainnetBatch({
      universe: ["AAAUSDT"],
      evidence: poolEvidence(["AAAUSDT"]),
      bookTimeOffsetMs: 60_000,
    });
    expect(future.store.getState().signals[0]?.research?.marketQuality).toMatchObject({
      pitQuality: "UNAVAILABLE",
      capturePhase: "FORWARD_BEFORE_ALLOCATION",
      bookSnapshotQuality: "FUTURE_OF_DECISION",
    });
  });

  it("records every selected reservation before the first order POST and never promotes a lower-ranked failure", async () => {
    const controls = mainnetControls({ maxOpenTrades: 2, maxGrossNotionalUsd: 50 });
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const universe = ["AAAUSDT", "BBBUSDT", "CCCUSDT"];
    const c1Open = DAY + 4 * 3_600_000 + 10 * 60_000;
    const c2Open = DAY + 4 * 3_600_000 + 15 * 60_000;
    const history = researchFiveMinuteHistory(c1Open, c2Open);
    for (const symbol of universe) {
      client.klines.set(`${symbol}|4h`, [referenceFourHour()]);
      client.klines.set(`${symbol}|5m`, history);
    }
    client.klines.set("BTCUSDT|5m", history);
    client.klines.set("ETHUSDT|5m", history);
    const subject = makeMainnetLane(client, now, controls, () => ({ allowed: true, reason: null }), universe, poolEvidence(universe));
    await subject.lane.tick();
    subject.store.arm(new Date(now.value).toISOString());
    now.value = DAY + 4 * 3_600_000 + 21 * 60_000;
    client.now = now.value;
    let pendingReservationsAtFirstPost = 0;
    client.beforeEntry = () => {
      pendingReservationsAtFirstPost = subject.store.getState().trades
        .filter((trade) => trade.status === "ENTRY_SUBMITTING").length;
    };
    client.failNextEntry = true;
    await subject.lane.tick();

    const batch = subject.store.getState().signalCohorts.find((row) => row.allocation)!;
    expect(batch.allocation?.selectedSignalIds).toHaveLength(2);
    expect(pendingReservationsAtFirstPost).toBe(2);
    expect(batch.candidates.filter((candidate) => candidate.skipReason === "SKIP_CAP_LOWER_RANK")).toHaveLength(1);
    const selected = batch.candidates.filter((candidate) => candidate.actuallySelected);
    expect(selected.some((candidate) => candidate.skipReason === "SELECTED_EXECUTION_FAILED")).toBe(true);
    expect(client.placed.filter((order) => !order.reduceOnly)).toHaveLength(1);

    now.value += 5 * 60_000;
    client.now = now.value;
    await subject.lane.tick();
    expect(client.placed.filter((order) => !order.reduceOnly)).toHaveLength(1);
  });

  it("marks foreign same-symbol account state explicitly before neutral selection", async () => {
    const client = new FakeDailyClient();
    client.positions.set("BBBUSDT", {
      symbol: "BBBUSDT", positionAmt: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 0,
      unRealizedProfit: 0, leverage: 1, marginType: "CROSSED",
    });
    const now = { value: AT_0410 };
    const universe = ["AAAUSDT", "BBBUSDT"];
    const c1Open = DAY + 4 * 3_600_000 + 10 * 60_000;
    const c2Open = DAY + 4 * 3_600_000 + 15 * 60_000;
    const history = researchFiveMinuteHistory(c1Open, c2Open);
    for (const symbol of universe) {
      client.klines.set(`${symbol}|4h`, [referenceFourHour()]);
      client.klines.set(`${symbol}|5m`, history);
    }
    client.klines.set("BTCUSDT|5m", history);
    client.klines.set("ETHUSDT|5m", history);
    const subject = makeMainnetLane(
      client,
      now,
      mainnetControls({ maxOpenTrades: 2, maxGrossNotionalUsd: 50 }),
      () => ({ allowed: true, reason: null }),
      universe,
      poolEvidence(universe),
    );
    await subject.lane.tick();
    subject.store.arm(new Date(now.value).toISOString());
    now.value = DAY + 4 * 3_600_000 + 21 * 60_000;
    client.now = now.value;
    await subject.lane.tick();

    const blocked = subject.store.getState().signals.find((row) => row.symbol === "BBBUSDT");
    expect(blocked).toMatchObject({ reason: "STRATEGY_SYMBOL_CONFLICT", actuallySelected: false });
    expect(client.placed.filter((order) => !order.reduceOnly).map((order) => order.symbol)).toEqual(["AAAUSDT"]);
  });

  it("matures counterfactual labels with 1m data and marks same-candle dual barrier hits ambiguous", async () => {
    const subject = await runNaturalMainnetBatch({ universe: ["AAAUSDT"] });
    const signalRow = subject.store.getState().signals[0]!;
    const minuteOpen = signalRow.signalTimestampMs;
    subject.client.klines.set("AAAUSDT|1m", [{
      openTime: minuteOpen,
      closeTime: minuteOpen + 60_000 - 1,
      open: 101,
      high: 106,
      low: 98,
      close: 102,
      volume: 10,
    }]);
    subject.now.value = minuteOpen + 2 * 60_000;
    subject.client.now = subject.now.value;
    await subject.lane.tick();
    expect(signalRow.research?.counterfactual).toMatchObject({
      status: "OUTCOME_AMBIGUOUS",
      ambiguityReason: expect.stringContaining("same candle"),
    });
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

  it("uses the real New York midnight session across DST, not a UTC-anchored 4h candle", () => {
    const summer = newYorkDailyRangeWindow(Date.UTC(2026, 7, 26, 12));
    expect(summer).toMatchObject({
      date: "2026-08-26",
      rangeOpenTime: Date.UTC(2026, 7, 26, 4),
      rangeCloseTime: Date.UTC(2026, 7, 26, 8),
      entryWindowCloseTime: Date.UTC(2026, 7, 27, 4),
    });

    const springForward = newYorkDailyRangeWindow(Date.UTC(2026, 2, 8, 12));
    expect(springForward.rangeOpenTime).toBe(Date.UTC(2026, 2, 8, 5));
    expect(springForward.rangeCloseTime).toBe(Date.UTC(2026, 2, 8, 8)); // 3 real hours: EST -> EDT

    const fallBack = newYorkDailyRangeWindow(Date.UTC(2026, 10, 1, 12));
    expect(fallBack.rangeOpenTime).toBe(Date.UTC(2026, 10, 1, 4));
    expect(fallBack.rangeCloseTime).toBe(Date.UTC(2026, 10, 1, 9)); // 5 real hours: EDT -> EST
  });

  it("routes one outside event to continuation only on further expansion, otherwise fades the inside re-entry at the recorded extreme", () => {
    const window = newYorkDailyRangeWindow(Date.UTC(2026, 7, 26, 12));
    const now = { value: window.rangeCloseTime + 30 * 60_000 };
    const client = new FakeDailyClient();
    client.now = now.value;
    const { lane, store } = makeLane(client, now, ["AAAUSDT"], { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} }, "AUTO_ROUTE_NY_V2");
    const routeLevel: DailyRangeLevel = {
      ...level(),
      dateUtc: window.date,
      fourHourOpenTime: window.rangeOpenTime,
      fourHourCloseTime: window.rangeCloseTime,
    };
    const continuationState: DailyRangeSymbolState = {
      lastProcessedBarOpenTime: null,
      previousClosedCandle: null,
      longCount: 0,
      shortCount: 0,
      longLocked: false,
      shortLocked: false,
    };
    const day: DailyRangeDayState = {
      dateUtc: window.date,
      initializedAt: new Date(now.value).toISOString(),
      universeSymbols: ["AAAUSDT"],
      universeSource: "TEST",
      levels: { AAAUSDT: routeLevel },
      invalidReferenceSymbols: [],
      symbolStates: { AAAUSDT: continuationState },
      strategyVersion: "daily-4h-range-auto-route-ny-2r-v2",
      strategyMode: "AUTO_ROUTE_NY_V2",
      referenceTimezone: "America/New_York",
      referenceRangeOpenTime: window.rangeOpenTime,
      referenceRangeCloseTime: window.rangeCloseTime,
      entryWindowCloseTime: window.entryWindowCloseTime,
    };
    const apply = (state: DailyRangeSymbolState, row: DailyRangeCandle) =>
      (lane as unknown as {
        applyCandle(dayArg: DailyRangeDayState, levelArg: DailyRangeLevel, stateArg: DailyRangeSymbolState, rowArg: DailyRangeCandle): DailyRangeSignal | null;
      }).applyCandle(day, routeLevel, state, row);

    const upFirst = candle(window.rangeCloseTime, 101, 100.5, 102);
    const upExpands = candle(window.rangeCloseTime + 5 * 60_000, 102, 101, 103);
    expect(apply(continuationState, upFirst)).toBeNull();
    const continuation = apply(continuationState, upExpands)!;
    expect(continuation).toMatchObject({
      strategyVersion: "daily-4h-range-auto-route-ny-2r-v2",
      entryPolicy: "CONTINUATION",
      breakoutDirection: "UP",
      direction: "LONG",
      referenceTimezone: "America/New_York",
    });
    expect(apply(continuationState, candle(window.rangeCloseTime + 10 * 60_000, 99, 98, 102))).toBeNull();
    expect(store.getState().signals).toHaveLength(1); // no automatic reversal of a spent continuation event

    const fadeState: DailyRangeSymbolState = {
      lastProcessedBarOpenTime: null,
      previousClosedCandle: null,
      longCount: 0,
      shortCount: 0,
      longLocked: false,
      shortLocked: false,
    };
    const fadeFirst = candle(window.rangeCloseTime + 15 * 60_000, 101, 100.5, 103);
    const reentryInside = candle(window.rangeCloseTime + 20 * 60_000, 99, 98, 104);
    expect(apply(fadeState, fadeFirst)).toBeNull();
    const fade = apply(fadeState, reentryInside)!;
    expect(fade).toMatchObject({
      entryPolicy: "FADE",
      breakoutDirection: "UP",
      direction: "SHORT",
      breakoutExtreme: 104,
    });
    expect(structuralStopForDailyRangeSignal(fade)).toBe(104);
    const fadeFeatures = (lane as unknown as {
      buildFeatureSnapshot(input: {
        signal: DailyRangeSignal;
        candles: DailyRangeCandle[];
        reference: DailyRangeCandle[];
        btcCandles: DailyRangeCandle[];
        ethCandles: DailyRangeCandle[];
        universePositive1hPct: number | null;
        universeNegative1hPct: number | null;
      }): { breakout: { boundary: number; c1ExtensionPrice: number; c2ExtensionPrice: number } };
    }).buildFeatureSnapshot({
      signal: fade,
      candles: [fadeFirst, reentryInside],
      reference: [],
      btcCandles: [],
      ethCandles: [],
      universePositive1hPct: null,
      universeNegative1hPct: null,
    });
    expect(fadeFeatures.breakout).toMatchObject({ boundary: 100, c1ExtensionPrice: 1, c2ExtensionPrice: -1 });
    const pending = (lane as unknown as {
      createPendingTrade(signalArg: DailyRangeSignal, options?: { persist?: boolean }): { strategyVersion: string; entryPolicy?: string; structuralStopRaw: number } | null;
    }).createPendingTrade(fade, { persist: false });
    expect(pending).toMatchObject({
      strategyVersion: "daily-4h-range-auto-route-ny-2r-v2",
      entryPolicy: "FADE",
      structuralStopRaw: 104,
    });
  });

  it("builds the NY range from completed 5m candles and executes a fresh fade with its own bracket lineage", async () => {
    const window = newYorkDailyRangeWindow(Date.UTC(2026, 7, 26, 12));
    const now = { value: window.rangeCloseTime + 60_000 };
    const client = new FakeDailyClient();
    client.now = now.value;
    const reference: FuturesKline[] = [];
    for (let openTime = window.rangeOpenTime; openTime < window.rangeCloseTime; openTime += 5 * 60_000) {
      reference.push(candle(openTime, 95, 90, 100));
    }
    const inside = candle(window.rangeCloseTime, 99, 95, 100);
    const firstOutside = candle(window.rangeCloseTime + 5 * 60_000, 101, 100.5, 103);
    const reentryInside = candle(window.rangeCloseTime + 10 * 60_000, 99, 98, 104);
    client.klines.set("AAAUSDT|5m", [...reference, inside, firstOutside, reentryInside]);
    const { lane, store } = makeLane(
      client,
      now,
      ["AAAUSDT"],
      { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
      "AUTO_ROUTE_NY_V2",
    );

    await lane.tick(); // freezes only a completed NY 00:00-04:00 reference; still disarmed
    const day = store.getState().days[`NY:${window.date}`]!;
    expect(day).toMatchObject({
      strategyVersion: "daily-4h-range-auto-route-ny-2r-v2",
      strategyMode: "AUTO_ROUTE_NY_V2",
      referenceTimezone: "America/New_York",
      referenceRangeOpenTime: window.rangeOpenTime,
      referenceRangeCloseTime: window.rangeCloseTime,
    });
    expect(day.levels.AAAUSDT).toMatchObject({ rangeHigh: 100, rangeLow: 90 });
    expect(store.getState().signals).toHaveLength(0);

    // The re-arm boundary deliberately starts after the completed 08:00 bar;
    // only the two subsequently completed event candles may produce an order.
    store.arm(new Date(now.value).toISOString());
    now.value = window.rangeCloseTime + 16 * 60_000;
    client.now = now.value;
    await lane.tick();

    const emitted = store.getState().signals;
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      strategyVersion: "daily-4h-range-auto-route-ny-2r-v2",
      entryPolicy: "FADE",
      breakoutDirection: "UP",
      direction: "SHORT",
      breakoutExtreme: 104,
      referenceTimezone: "America/New_York",
      referenceRangeOpenTime: window.rangeOpenTime,
      referenceRangeCloseTime: window.rangeCloseTime,
    });
    const trade = store.getState().trades[0]!;
    expect(trade).toMatchObject({
      strategyVersion: "daily-4h-range-auto-route-ny-2r-v2",
      entryPolicy: "FADE",
      direction: "SHORT",
      status: "OPEN",
      structuralStopRaw: 104,
      stopPrice: 104,
      takeProfitPrice: 92,
      referenceTimezone: "America/New_York",
      referenceRangeOpenTime: window.rangeOpenTime,
      referenceRangeCloseTime: window.rangeCloseTime,
    });
    expect(client.placed.filter((row) => !row.reduceOnly)).toMatchObject([{ symbol: "AAAUSDT", side: "SELL", type: "MARKET" }]);
    expect(client.algoPlaced.map((row) => [row.type, row.side, row.triggerPrice]))
      .toEqual(expect.arrayContaining([["STOP_MARKET", "BUY", 104], ["TAKE_PROFIT_MARKET", "BUY", 92]]));
    expect(client.fiveMinuteReadSymbols.has("AAAUSDT")).toBe(true);
    expect(store.getState().signalCohorts[0]?.candidates[0]).toMatchObject({ breakoutDistancePrice: -1, breakoutDistanceOfRange: -0.1 });
  });

  it("never lets a pending V1 signal cross the V2 cutover boundary into an order", async () => {
    const window = newYorkDailyRangeWindow(Date.UTC(2026, 7, 26, 12));
    const now = { value: window.rangeCloseTime + 10 * 60_000 };
    const client = new FakeDailyClient();
    client.now = now.value;
    const { lane, store } = makeLane(
      client,
      now,
      ["AAAUSDT"],
      { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
      "AUTO_ROUTE_NY_V2",
    );
    store.arm(new Date(now.value).toISOString());
    const legacy = signal("AAAUSDT", now.value, "LONG");
    store.getState().signals.push(legacy);

    await (lane as unknown as {
      executeFreshSignal(signalArg: DailyRangeSignal): Promise<void>;
    }).executeFreshSignal(legacy);

    expect(legacy.reason).toBe("RETIRED_STRATEGY_VERSION");
    expect(client.placed).toHaveLength(0);
    expect(store.getState().trades).toHaveLength(0);
  });

  it("reconciles an existing V1 trade unchanged while V2 takes over only new entries", async () => {
    const now = { value: AT_0410 };
    const client = new FakeDailyClient();
    const dir = dataDir();
    const firstStore = new DailyRangeLaneStore(dir, "state.json", now.value);
    const legacy = new DailyRangeAcceptanceLane({
      client,
      store: firstStore,
      getUniverse: () => ({ symbols: ["AAAUSDT"], source: "TEST" }),
      getShortBlocklist: () => new Set<string>(),
      entryClaims: { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
      environment: "testnet",
      nowMs: () => now.value,
      confirmRetryMs: 0,
    });
    firstStore.arm(new Date(now.value).toISOString());
    const oldSignal = signal("AAAUSDT", now.value, "SHORT");
    firstStore.getState().signals.push(oldSignal);
    await (legacy as unknown as {
      executeFreshSignal(signalArg: DailyRangeSignal): Promise<void>;
    }).executeFreshSignal(oldSignal);
    const before = firstStore.getState().trades[0]!;
    const identity = {
      strategyVersion: before.strategyVersion,
      direction: before.direction,
      entryQty: before.entryQty,
      entryFillPrice: before.entryFillPrice,
      stopAlgoOrderId: before.stopAlgoOrderId,
      takeProfitAlgoOrderId: before.takeProfitAlgoOrderId,
      stopPrice: before.stopPrice,
      takeProfitPrice: before.takeProfitPrice,
    };

    const v2Store = new DailyRangeLaneStore(dir, "state.json", now.value);
    const v2 = new DailyRangeAcceptanceLane({
      client,
      store: v2Store,
      getUniverse: () => ({ symbols: ["AAAUSDT"], source: "TEST" }),
      getShortBlocklist: () => new Set<string>(),
      entryClaims: { tryClaimEntrySymbol: () => true, releaseEntrySymbol: () => {} },
      environment: "testnet",
      strategyMode: "AUTO_ROUTE_NY_V2",
      nowMs: () => now.value,
      confirmRetryMs: 0,
    });
    await v2.tick(); // NY range is not complete yet; this is reconciliation only.

    const after = v2Store.getState().trades[0]!;
    expect({
      strategyVersion: after.strategyVersion,
      direction: after.direction,
      entryQty: after.entryQty,
      entryFillPrice: after.entryFillPrice,
      stopAlgoOrderId: after.stopAlgoOrderId,
      takeProfitAlgoOrderId: after.takeProfitAlgoOrderId,
      stopPrice: after.stopPrice,
      takeProfitPrice: after.takeProfitPrice,
    }).toEqual(identity);
    expect(after.status).toBe("OPEN");
    expect(v2.getStatus()).toMatchObject({ strategyVersion: "daily-4h-range-auto-route-ny-2r-v2" });
    expect(client.cancelledAlgos).toHaveLength(0);
  });
});

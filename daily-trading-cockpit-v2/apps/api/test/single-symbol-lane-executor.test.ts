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
  type SingleSymbolPosition,
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
  /** [2026-08-04 exposure-reservation test support] Symbol whose ENTRY (non-reduceOnly) placeOrder
   *  throws an UNAMBIGUOUS BinanceFuturesPrivateError (failureType "binance_error") — distinct from
   *  `failOnSymbol` above, which throws a plain, ambiguous Error (simulating a network/timeout
   *  failure where whether the order reached the exchange is genuinely unknown). Mirrors
   *  cross-sectional-executor.test.ts's FakeExecClient field of the same name. */
  failOnSymbolWithBinanceError: string | null = null;
  failAlgoOnce = false;
  /** Reject the NEXT reduceOnly placeOrder call with the given Binance error code (e.g. -2022),
   *  then clear itself. Non-reduceOnly retries are NOT rejected. */
  rejectNextReduceOnlyWithCode: number | null = null;
  /** Reject EVERY placeOrder call (reduceOnly or not) with a generic non-2022 error — simulates a
   *  persistent, non-recoverable-via-fallback close failure. */
  failAllPlaceOrders = false;
  fillPriceBySymbol = new Map<string, number>();
  /** Optional actual execution quantity for a partial MARKET-fill regression. */
  executedQtyBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  queryOrderAvgPriceBySymbol = new Map<string, number>();
  /** algoId -> actualOrderId (null = still resting/not triggered). */
  algoTriggeredOrderId = new Map<string, string | null>();
  /** algoIds externally CANCELED/EXPIRED on the exchange WITHOUT ever triggering (e.g. a sibling
   *  cancelAllAlgoOrders call for the same symbol) — distinct from "still resting" (null in
   *  algoTriggeredOrderId above). Dedicated fixture for the [STOP-HEALTH] regression test below. */
  algoExternallyTerminalStatus = new Map<string, string>();
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
      // 2026-07-19 real-money audit fix fixture: minQty pinned EXACTLY at the mathematically
      // correct stepSize-floored quantity for legUsd=140.07/entryPrice=20010 (rawQty is exactly 7
      // steps of 0.001 -> qty=0.007) so a floating-point-undershot qty of 0.006 (one step below)
      // fails minQty and is dropped, while the correct 0.007 passes. Dedicated fixture for the
      // stepSize-epsilon regression test below.
      ["XYZUSDT", f(0.001, 0.007)],
      // Non-MAJOR, cluster-mapped symbol (L1 in correlation-clusters.ts's DEFAULT_CLUSTER_MAP,
      // alongside ADAUSDT/SUIUSDT/AVAXUSDT) — fixture for the correlated-cluster cap regression
      // tests below, which need a real (non-BTC/ETH) symbol that can fully open.
      ["SOLUSDT", f(0.01, 0.01)],
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
    if (this.failOnSymbolWithBinanceError === params.symbol && !params.reduceOnly) {
      throw new BinanceFuturesPrivateError("binance_error", `Binance error HTTP 400 code -2019: Margin is insufficient.`, {
        httpStatus: 400,
        binanceCode: -2019,
      });
    }
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
    const order = this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, orderId, avgPrice);
    order.executedQty = this.executedQtyBySymbol.get(params.symbol) ?? params.quantity;
    return order;
  }
  /** 2026-08-18: drives reconcilePendingMakerEntries. Default THROWS -2013 ("order does not
   *  exist"), which is the honest default for an order that was never placed in a test. */
  byClientId = new Map<string, FuturesOrder>();
  async queryOrderByClientId(symbol: string, origClientOrderId: string): Promise<FuturesOrder> {
    const hit = this.byClientId.get(origClientOrderId);
    if (hit) return hit;
    throw new BinanceFuturesPrivateError("binance_error", "Order does not exist.", { httpStatus: 404, binanceCode: -2013 });
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
    const externalStatus = this.algoExternallyTerminalStatus.get(algoId);
    const algoStatus = externalStatus ?? (actualOrderId !== null ? "EXECUTED" : "WORKING");
    return {
      symbol: "BTCUSDT", algoId, clientAlgoId: "", algoStatus,
      orderType: "STOP_MARKET", side: "BUY", quantity: 0, triggerPrice: 0, actualOrderId,
    };
  }
  async cancelAlgoOrder(algoId: string): Promise<void> {
    this.algosCancelled.push(algoId);
  }
  /** By DEFAULT this fake ignores `startTime` and hands back every seeded trade. That is exactly why
   *  the 2026-07-26 fee-window bug survived a 62-test file: the production query anchored its window
   *  at openedAt (stamped AFTER placeOrder, hence always later than Binance's own entry-fill
   *  timestamp) so the entry row was never returned on the real exchange, while here it always was.
   *  Set `honourStartTime` to model the endpoint's real semantics. Left off elsewhere so the 60+
   *  pre-existing cases keep their original fixtures. */
  honourStartTime = false;
  /** The `startTime` of the most recent getUserTrades call — lets a test assert WHICH window was
   *  actually requested, not merely what the sums came out to. */
  lastUserTradesStartTime: number | undefined;
  async getUserTrades(_symbol: string, opts: { startTime?: number; limit?: number } = {}): Promise<FuturesUserTrade[]> {
    this.lastUserTradesStartTime = opts.startTime;
    const all = Array.from(this.userTradesByOrderId.values());
    if (!this.honourStartTime) return all;
    const from = opts.startTime;
    // Binance's startTime is INCLUSIVE and is compared against the exchange-stamped trade time.
    return typeof from === "number" ? all.filter((t) => t.time >= from) : all;
  }

  /** Seed a trade row at an explicit exchange timestamp (triggerAlgo always stamps NOW_MS). */
  seedTrade(orderId: string, over: Partial<FuturesUserTrade> = {}): void {
    this.userTradesByOrderId.set(orderId, {
      symbol: "BTCUSDT", orderId, price: 60000, qty: 1, realizedPnl: 0, commission: 0,
      commissionAsset: "USDT", time: NOW_MS, ...over,
    });
  }

  /** Test helper: mark a previously-placed algo stop as having triggered a real fill. */
  triggerAlgo(algoId: string, actualOrderId: string, realizedPnl: number, commission: number, price: number, qty = 1): void {
    this.algoTriggeredOrderId.set(algoId, actualOrderId);
    this.userTradesByOrderId.set(actualOrderId, {
      symbol: "BTCUSDT", orderId: actualOrderId, price, qty, realizedPnl, commission, commissionAsset: "USDT", time: NOW_MS,
    });
  }

  /** Test helper (2026-07-19 [STOP-HEALTH] fix): simulate the stop being cancelled/expired on the
   *  exchange WITHOUT ever triggering — e.g. an unrelated cancelAllAlgoOrders call for the same
   *  symbol from a sibling close/flip operation. actualOrderId stays null (never triggered); only
   *  algoStatus changes from "WORKING" to a terminal-without-trigger value. */
  cancelAlgoExternally(algoId: string, status: string = "CANCELED"): void {
    this.algoExternallyTerminalStatus.set(algoId, status);
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
  requiredOpenPositions?: number;
  makerEntry?: boolean;
  tryClaimEntryScope?: () => { allowed: boolean; reason?: string | null };
  releaseEntryScope?: () => void;
  dailyMaxLossUsd?: number;
  makerEntry?: boolean;
  makerEntryWaitMs?: number;
  readPublicQuote?: (symbol: string) => { bid: number | null; ask: number | null; mid: number; atMs: number; venue: string } | null;
  exitPolicy?: ReturnType<typeof makeFixedRewardExitPolicy>;
  portfolioExitPolicy?: SingleSymbolExitPolicy;
  existingNotionalForSymbol?: (symbol: string) => number;
  maxNotionalPerSymbolAcrossLanes?: number;
  existingClusterOpenSymbols?: (symbol: string, direction: "LONG" | "SHORT") => ReadonlySet<string>;
  maxClusterPositionsAcrossLanes?: number;
  currentPrice?: number | null;
  sharedGetPositions?: () => ReturnType<FakeClient["getPositions"]>;
  tryClaimEntrySymbol?: (symbol: string) => boolean;
  releaseEntrySymbol?: (symbol: string) => void;
  preventSameSymbolPyramiding?: boolean;
  useOwnLotPnlAttribution?: boolean;
  timelineEntryGate?: (signal: SingleSymbolFreshSignal, direction: "LONG" | "SHORT") => Promise<{ allowed: boolean; reason: string | null }>;
  reserveExposure?: (req: {
    executorId: string;
    symbol: string;
    direction: "LONG" | "SHORT";
    requestedNotionalUsd: number;
    clientOrderId: string;
  }) => { ok: boolean; reservationId: string | null; reason?: string };
  commitExposureReservation?: (reservationId: string, filled: { qty: number; avgPrice: number }) => void;
  releaseExposureReservation?: (reservationId: string, reason: string) => void;
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
    ...(opts.requiredOpenPositions !== undefined ? { requiredOpenPositions: () => opts.requiredOpenPositions! } : {}),
    ...(opts.makerEntry !== undefined ? { makerEntry: () => opts.makerEntry! } : {}),
    ...(opts.tryClaimEntryScope ? { tryClaimEntryScope: opts.tryClaimEntryScope } : {}),
    ...(opts.releaseEntryScope ? { releaseEntryScope: opts.releaseEntryScope } : {}),
    dailyMaxLossUsd: () => opts.dailyMaxLossUsd ?? 0,
    nowIso: () => NOW,
    fillConfirmRetryDelayMs: 0,
    ...(opts.makerEntry !== undefined ? { makerEntry: () => opts.makerEntry! } : {}),
    ...(opts.makerEntryWaitMs !== undefined ? { makerEntryWaitMs: () => opts.makerEntryWaitMs! } : {}),
    ...(opts.readPublicQuote ? { readPublicQuote: opts.readPublicQuote } : {}),
    existingNotionalForSymbol: opts.existingNotionalForSymbol ?? (() => 0),
    maxNotionalPerSymbolAcrossLanes: () => opts.maxNotionalPerSymbolAcrossLanes ?? 0,
    existingClusterOpenSymbols: opts.existingClusterOpenSymbols ?? (() => new Set<string>()),
    maxClusterPositionsAcrossLanes: () => opts.maxClusterPositionsAcrossLanes ?? 0,
    ...(opts.currentPrice !== undefined ? { currentPrice: async () => opts.currentPrice! } : {}),
    ...(opts.sharedGetPositions ? { sharedGetPositions: opts.sharedGetPositions } : {}),
    ...(opts.tryClaimEntrySymbol ? { tryClaimEntrySymbol: opts.tryClaimEntrySymbol } : {}),
    ...(opts.releaseEntrySymbol ? { releaseEntrySymbol: opts.releaseEntrySymbol } : {}),
    ...(opts.preventSameSymbolPyramiding ? { preventSameSymbolPyramiding: true } : {}),
    ...(opts.useOwnLotPnlAttribution ? { useOwnLotPnlAttribution: true } : {}),
    ...(opts.timelineEntryGate ? { timelineEntryGate: opts.timelineEntryGate } : {}),
    ...(opts.reserveExposure ? { reserveExposure: opts.reserveExposure } : {}),
    ...(opts.commitExposureReservation ? { commitExposureReservation: opts.commitExposureReservation } : {}),
    ...(opts.releaseExposureReservation ? { releaseExposureReservation: opts.releaseExposureReservation } : {}),
  });
  return { executor, client, store, storeDir };
}

/** Minimal in-memory stand-in for AccountExposureCoordinator's reserve/commit/release contract —
 *  NOT a reimplementation of its capacity math (that is exhaustively covered by
 *  account-exposure-coordinator.test.ts's own 45 tests). This exists purely to verify the WIRING:
 *  does the executor call reserve() at the right point with the right data, commit from the actual
 *  fill, and release on every failure path (never only the happy path) — exactly the property that
 *  testing the coordinator in isolation cannot exercise. */
function makeFakeReservationLedger() {
  const reservations = new Map<
    string,
    {
      status: "RESERVED" | "COMMITTED" | "RELEASED";
      req: { executorId: string; symbol: string; direction: "LONG" | "SHORT"; requestedNotionalUsd: number; clientOrderId: string };
      committed?: { qty: number; avgPrice: number };
      releaseReason?: string;
    }
  >();
  let seq = 0;
  let forceNextRejectReason: string | null = null;
  return {
    reservations,
    forceNextReserveRejection(reason: string) {
      forceNextRejectReason = reason;
    },
    reserveExposure: (req: {
      executorId: string;
      symbol: string;
      direction: "LONG" | "SHORT";
      requestedNotionalUsd: number;
      clientOrderId: string;
    }) => {
      if (forceNextRejectReason !== null) {
        const reason = forceNextRejectReason;
        forceNextRejectReason = null;
        return { ok: false, reservationId: null, reason };
      }
      const reservationId = `res-${++seq}`;
      reservations.set(reservationId, { status: "RESERVED", req });
      return { ok: true, reservationId };
    },
    commitExposureReservation: (reservationId: string, filled: { qty: number; avgPrice: number }) => {
      const r = reservations.get(reservationId);
      if (!r || r.status !== "RESERVED") return; // idempotent no-op, matches the real coordinator
      r.status = "COMMITTED";
      r.committed = filled;
    },
    releaseExposureReservation: (reservationId: string, reason: string) => {
      const r = reservations.get(reservationId);
      if (!r || r.status !== "RESERVED") return; // idempotent no-op, matches the real coordinator
      r.status = "RELEASED";
      r.releaseReason = reason;
    },
  };
}

describe("SingleSymbolLaneExecutor — account-exposure reservation wiring (2026-08-04)", () => {
  it("reserves before placing the order (with the SAME clientOrderId placeOrder submits) and commits from the actual fill, not requested qty", async () => {
    const ledger = makeFakeReservationLedger();
    const client = new FakeClient();
    client.fillPriceBySymbol.set("BTCUSDT", 59_950); // avgPrice differs from signal.entryPrice
    const { executor, store } = makeExecutor({
      client,
      signals: [signal()],
      legUsd: 120_000,
      laneWeightPct: 50, // effective legUsd 60,000 -> qty 1.0 exactly
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(store.getState().positions).toHaveLength(1);
    expect(ledger.reservations.size).toBe(1);
    const [reservationId, record] = [...ledger.reservations.entries()][0]!;
    expect(record.status).toBe("COMMITTED");
    expect(record.req.executorId).toBe("SHORT_FADE_EXHAUSTION_CROWDED");
    expect(record.req.symbol).toBe("BTCUSDT");
    expect(record.req.direction).toBe("SHORT");
    expect(record.req.requestedNotionalUsd).toBeCloseTo(60_000, 6);
    // The reconciliation join key: reserve()'s clientOrderId must be the EXACT string placeOrder
    // submitted, not merely a similarly-shaped one.
    expect(client.placed[0]!.newClientOrderId).toBe(record.req.clientOrderId);
    // Committed from the REAL fill (order.executedQty/avgPrice), never the requested qty/price.
    expect(record.committed!.qty).toBeCloseTo(1, 6);
    expect(record.committed!.avgPrice).toBe(59_950);
    void reservationId;
  });

  it("a rejected reservation blocks the entry entirely (no order placed) and surfaces the coordinator's reason", async () => {
    const ledger = makeFakeReservationLedger();
    ledger.forceNextReserveRejection("BTCUSDT: correlation-cluster cap (L1, cap 3) reached");
    const client = new FakeClient();
    const sig = signal();
    const { executor, store } = makeExecutor({
      client,
      signals: [sig],
      legUsd: 10_000,
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(client.placed).toHaveLength(0);
    expect(store.getState().positions).toHaveLength(0);
    expect(ledger.reservations.size).toBe(0); // reserve() itself refused to insert anything
    expect(executor.getStatus().lastEntrySkipReason).toContain("correlation-cluster cap");
    // Not permanently blacklisted — a capacity rejection is transient (see maxNotionalPerSymbolAcrossLanes's
    // own doc comment on this exact convention), so the same signal must remain retryable.
    expect(store.getState().attemptedObservationIds ?? []).not.toContain(sig.observationId);
  });

  it("[FRESH_POSITION_EXISTS] releases the reservation when the final pre-placement exchange recheck finds a real position", async () => {
    const ledger = makeFakeReservationLedger();
    const client = new FakeClient();
    client.positionAmtBySymbol.set("BTCUSDT", 0.02); // only visible to the FRESH (uncached) check
    const { executor, store } = makeExecutor({
      client,
      signals: [signal()],
      legUsd: 10_000,
      sharedGetPositions: async () => [], // the cached/stale check sees flat
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(client.placed).toHaveLength(0);
    expect(store.getState().positions).toHaveLength(0);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/fresh exchange position/);
    expect(ledger.reservations.size).toBe(1);
    const record = [...ledger.reservations.values()][0]!;
    expect(record.status).toBe("RELEASED");
    expect(record.releaseReason).toBe("FRESH_POSITION_EXISTS");
  });

  it("[STRUCTURAL REJECTION] a signal that fails exchange minNotional releases its reservation instead of leaking it as RESERVED", async () => {
    // Same fixture as "skips an entry that clears minQty but fails MIN_NOTIONAL" above.
    const ledger = makeFakeReservationLedger();
    const dogeSignal = signal({ observationId: "sf:DOGEUSDT:1", symbol: "DOGEUSDT", entryPrice: 0.1, stopPrice: 0.103 });
    const { executor, store } = makeExecutor({
      signals: [dogeSignal],
      legUsd: 0.5,
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(store.getState().positions).toHaveLength(0);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/below exchange minNotional/i);
    expect(ledger.reservations.size).toBe(1);
    const record = [...ledger.reservations.values()][0]!;
    // This is the exact gap a naive implementation (matching only the wiringPlan's literal prose,
    // which calls out FRESH_POSITION_EXISTS and the catch block but not this structural branch)
    // would leave RESERVED for up to RESERVATION_STALE_MS despite no order ever being attempted.
    expect(record.status).toBe("RELEASED");
    expect(record.releaseReason).toBe("ENTRY_REJECTED:below_min_notional");
  });

  it("[AMBIGUOUS FAILURE] leaves the reservation RESERVED (not released) via the catch path when placeOrder throws a plain, non-Binance error", async () => {
    // [2026-08-04] failOnSymbol throws a plain Error — simulates a network/timeout blip where
    // whether the order actually reached the exchange is genuinely unknown. Releasing capacity here
    // would reopen the oversubscription race the coordinator exists to close, so the reservation
    // must stay RESERVED for the periodic staleness sweep (reconcileStaleReservations) to resolve
    // against Binance directly. Mirrors cross-sectional-executor.test.ts's own
    // "[AMBIGUOUS FAILURE] leaves the failed leg's reservation RESERVED..." test.
    const ledger = makeFakeReservationLedger();
    const client = new FakeClient();
    client.failOnSymbol = "BTCUSDT";
    const sig = signal();
    const { executor, store } = makeExecutor({
      client,
      signals: [sig],
      legUsd: 10_000,
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(store.getState().positions).toHaveLength(0);
    // Same transient-retry contract as the pre-existing [ENTRY-RETRY] test above — retry-eligibility
    // is orthogonal to reservation-release and unaffected by this fix.
    expect(store.getState().attemptedObservationIds ?? []).not.toContain(sig.observationId);
    expect(ledger.reservations.size).toBe(1);
    const record = [...ledger.reservations.values()][0]!;
    expect(record.status).toBe("RESERVED");
    expect(record.releaseReason).toBeUndefined();
  });

  it("[UNAMBIGUOUS FAILURE] releases the reservation via the catch path when placeOrder throws a typed, in-band Binance rejection", async () => {
    // [2026-08-04] failOnSymbolWithBinanceError throws BinanceFuturesPrivateError with
    // failureType "binance_error" — Binance received the request and explicitly answered no, so no
    // order was created. This is the one case where releasing immediately is safe.
    const ledger = makeFakeReservationLedger();
    const client = new FakeClient();
    client.failOnSymbolWithBinanceError = "BTCUSDT";
    const sig = signal();
    const { executor, store } = makeExecutor({
      client,
      signals: [sig],
      legUsd: 10_000,
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(store.getState().positions).toHaveLength(0);
    expect(store.getState().attemptedObservationIds ?? []).not.toContain(sig.observationId);
    expect(ledger.reservations.size).toBe(1);
    const record = [...ledger.reservations.values()][0]!;
    expect(record.status).toBe("RELEASED");
    expect(record.releaseReason).toMatch(/^ENTRY_FAILED:/);
  });

  it("defaults to a no-op coordinator when reserveExposure/commit/release are omitted — existing behavior is byte-for-byte unaffected", async () => {
    // No ledger wired at all. If this executor's ONLY option were `reserveExposure` without a safe
    // default, this test (and every other test in this file that predates 2026-08-04) would throw.
    const { executor, store, client } = makeExecutor({ signals: [signal()], legUsd: 10_000 });
    await executor.tick();
    expect(store.getState().positions).toHaveLength(1);
    expect(client.placed).toHaveLength(1);
  });
});

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

describe("makeMfeGivebackExitPolicy — staticTpR (full TP, 2026-08-17)", () => {
  const g = { entryPrice: 100, stopPrice: 98 };            // stop 2% -> 1R = 2.00
  const atR = (r: number) => g.entryPrice + r * (g.entryPrice - g.stopPrice);
  const tp = makeMfeGivebackExitPolicy({ armR: 0.75, givebackFrac: 0.3, maxHoldMs: 24 * 3_600_000, profitLockR: 0.15, staticTpR: 1.5 });
  const noTp = makeMfeGivebackExitPolicy({ armR: 0.75, givebackFrac: 0.3, maxHoldMs: 24 * 3_600_000, profitLockR: 0.15 });

  it("[TP-R] closes the WHOLE position at the level — there is no remainder", () => {
    const d = tp({ direction: "LONG", ...g, currentPrice: atR(1.5), peakFavorableR: 1.5, msHeld: 0 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("STATIC_TP");
  });

  it("[TP-R] fires BEFORE lock and giveback — it is the highest level of the three", () => {
    // Peak 2R, price back at 1.5R: the giveback line sits at 1.4R and the lock at 0.15R, so without
    // the TP this path books strictly less. Checking the TP first is what makes it worth having.
    const withTp = tp({ direction: "LONG", ...g, currentPrice: atR(1.5), peakFavorableR: 2, msHeld: 0 });
    expect(withTp.reason).toBe("STATIC_TP");
    const without = noTp({ direction: "LONG", ...g, currentPrice: atR(1.5), peakFavorableR: 2, msHeld: 0 });
    expect(without.shouldExit).toBe(false); // 1.5R is above the 1.4R giveback line — still running
  });

  it("[TP-R] does nothing below the level, and unset behaves exactly as before", () => {
    expect(tp({ direction: "LONG", ...g, currentPrice: atR(1.49), peakFavorableR: 1.49, msHeld: 0 }).shouldExit).toBe(false);
    for (const r of [0.5, 1.0, 1.49]) {
      const ctx = { direction: "LONG" as const, ...g, currentPrice: atR(r), peakFavorableR: r, msHeld: 0 };
      expect(tp(ctx)).toEqual(noTp(ctx));
    }
  });

  it("[TP-R] SHORT reaches it by falling, not rising", () => {
    const sg = { entryPrice: 100, stopPrice: 102 };
    const px = (r: number) => sg.entryPrice - r * (sg.stopPrice - sg.entryPrice);
    const t2 = makeMfeGivebackExitPolicy({ armR: 0.75, givebackFrac: 0.3, maxHoldMs: 24 * 3_600_000, staticTpR: 1.5 });
    expect(t2({ direction: "SHORT", ...sg, currentPrice: px(1.5), peakFavorableR: 1.5, msHeld: 0 }).reason).toBe("STATIC_TP");
    expect(t2({ direction: "SHORT", ...sg, currentPrice: px(1.0), peakFavorableR: 1.0, msHeld: 0 }).shouldExit).toBe(false);
  });

  it("[TP-R] the stop still wins over the TP — it is checked first and must stay that way", () => {
    const d = tp({ direction: "LONG", ...g, currentPrice: g.stopPrice, peakFavorableR: 2, msHeld: 0 });
    expect(d.reason).toBe("INITIAL_STOP");
  });
});

describe("makeMfeGivebackExitPolicy — profitLockR (R-denominated, 2026-08-16)", () => {
  // THE DEFECT THIS CLOSES, in the two real shapes it took on testnet:
  //   ETHUSDT stop 0.47% of entry -> profitLockNetReturn 0.005 meant a 1.15R lock
  //   SOLUSDT stop 2.18% of entry -> the SAME config meant a 0.25R lock
  // Same operator intent, reward:risk 4.6x apart, decided by volatility rather than by anyone.
  const tight = { entryPrice: 100, stopPrice: 99.53 };   // 0.47% stop, like the ETH position
  const wide = { entryPrice: 100, stopPrice: 97.82 };    // 2.18% stop, like the SOL position
  const atR = (g: { entryPrice: number; stopPrice: number }, r: number) =>
    g.entryPrice + r * (g.entryPrice - g.stopPrice);

  const priced = makeMfeGivebackExitPolicy({
    armR: 0.75, givebackFrac: 0.3, maxHoldMs: 24 * 3_600_000,
    profitLockNetReturn: 0.005, estimatedCloseCostPct: 0.0004,
  });
  const inR = makeMfeGivebackExitPolicy({
    armR: 0.75, givebackFrac: 0.3, maxHoldMs: 24 * 3_600_000, profitLockR: 0.5,
  });

  it("[LOCK-R] the price-denominated lock fires at a different R on each stop width", () => {
    // Pins the DEFECT itself, so it fails loudly if the old behavior is ever changed silently.
    // IDENTICAL geometry in R on both: peaked at 0.6R, now retraced to 0.24R, giveback unarmed
    // (0.6 < armR 0.75). The only difference is how wide the stop happens to be.
    const ctx = (g: { entryPrice: number; stopPrice: number }) =>
      ({ direction: "LONG" as const, ...g, currentPrice: atR(g, 0.24), peakFavorableR: 0.6, msHeld: 0 });
    // wide stop -> the 0.5% lock lands at ~0.25R, which 0.6R cleared and 0.24R has fallen back through
    const w = priced(ctx(wide));
    expect(w.shouldExit).toBe(true);
    expect(w.reason).toBe("MFE_PROFIT_LOCK");
    // tight stop -> the SAME 0.5% lock lands at ~1.15R, so a 0.6R peak never armed it at all
    expect(priced(ctx(tight)).shouldExit).toBe(false);
    // and profitLockR removes the divergence: same input, same verdict on both widths
    expect(inR(ctx(wide)).reason).toBe(inR(ctx(tight)).reason);
  });

  it("[LOCK-R] profitLockR gives BOTH stop widths the identical 0.5R geometry", () => {
    for (const g of [tight, wide]) {
      // peak reached the lock and price came back through it -> exit, on either width
      const hit = inR({ direction: "LONG", ...g, currentPrice: atR(g, 0.5), peakFavorableR: 0.6, msHeld: 0 });
      expect(hit.shouldExit).toBe(true);
      expect(hit.reason).toBe("MFE_PROFIT_LOCK");
      // peak never reached the lock -> hold, on either width
      expect(inR({ direction: "LONG", ...g, currentPrice: atR(g, 0.3), peakFavorableR: 0.45, msHeld: 0 }).shouldExit).toBe(false);
    }
  });

  it("[LOCK-R] SHORT geometry is identical, not mirrored by accident", () => {
    const g = { entryPrice: 100, stopPrice: 102 };
    const px = (r: number) => g.entryPrice - r * (g.stopPrice - g.entryPrice);
    const hit = inR({ direction: "SHORT", ...g, currentPrice: px(0.5), peakFavorableR: 0.6, msHeld: 0 });
    expect(hit.reason).toBe("MFE_PROFIT_LOCK");
    expect(inR({ direction: "SHORT", ...g, currentPrice: px(0.3), peakFavorableR: 0.45, msHeld: 0 }).shouldExit).toBe(false);
  });

  it("[LOCK-R] lock 0.5 and arm 0.75 TILE — a big peak trails on giveback, never snaps back to the lock", () => {
    // peak 2R, giveback line = 2*0.7 = 1.4R. At 1.5R nothing fires; at 1.4R the giveback does.
    // If the lock shadowed the giveback this runner would have been cut at 0.5R instead of 1.4R.
    expect(inR({ direction: "LONG", ...wide, currentPrice: atR(wide, 1.5), peakFavorableR: 2, msHeld: 0 }).shouldExit).toBe(false);
    const gb = inR({ direction: "LONG", ...wide, currentPrice: atR(wide, 1.4), peakFavorableR: 2, msHeld: 0 });
    expect(gb.shouldExit).toBe(true);
    expect(gb.reason).toBe("MFE_GIVEBACK");
  });

  it("[LOCK-R] stop and max-hold still win, and an unset profitLockR changes nothing", () => {
    expect(inR({ direction: "LONG", ...wide, currentPrice: wide.stopPrice, peakFavorableR: 2, msHeld: 0 }).reason).toBe("INITIAL_STOP");
    expect(inR({ direction: "LONG", ...wide, currentPrice: atR(wide, 0.1), peakFavorableR: 0.1, msHeld: 24 * 3_600_000 }).reason).toBe("MAX_HOLD_MTM");
    // additive guarantee: lanes that never pass profitLockR keep byte-identical behavior
    const legacy = makeMfeGivebackExitPolicy({ armR: 0.75, givebackFrac: 0.3, maxHoldMs: 24 * 3_600_000, profitLockNetReturn: 0.005, estimatedCloseCostPct: 0.0004 });
    const zero = makeMfeGivebackExitPolicy({ armR: 0.75, givebackFrac: 0.3, maxHoldMs: 24 * 3_600_000, profitLockNetReturn: 0.005, estimatedCloseCostPct: 0.0004, profitLockR: 0 });
    for (const r of [0.2, 0.5, 0.9, 1.2]) {
      const ctx = { direction: "LONG" as const, ...wide, currentPrice: atR(wide, r), peakFavorableR: Math.max(r, 0.8), msHeld: 0 };
      expect(zero(ctx)).toEqual(legacy(ctx));
    }
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

  it("locks a +0.50% estimated-net winner only after it has first run above the lock", () => {
    const lockPolicy = makeMfeGivebackExitPolicy({
      armR: 10,
      givebackFrac: 0.5,
      maxHoldMs: 24 * 3_600_000,
      profitLockNetReturn: 0.005,
      estimatedCloseCostPct: 0.002,
    });
    // Risk = 1% of entry.  100.80 = +0.80% gross / +0.60% net: runner stays open.
    const running = lockPolicy({ direction: "LONG", entryPrice: 100, stopPrice: 99, currentPrice: 100.8, peakFavorableR: 0, msHeld: 0 });
    expect(running.shouldExit).toBe(false);
    // It then returns to +0.70% gross / +0.50% net: lock is enforced.
    const locked = lockPolicy({ direction: "LONG", entryPrice: 100, stopPrice: 99, currentPrice: 100.7, peakFavorableR: running.nextPeakFavorableR, msHeld: 60_000 });
    expect(locked.shouldExit).toBe(true);
    expect(locked.reason).toBe("MFE_PROFIT_LOCK");
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
    // 2026-07-19 real-money audit fix: this structural rejection used to leave lastEntrySkipReason
    // null, unlike every other skip branch in this function.
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/below exchange minQty/i);
  });

  it("skips an entry that clears minQty but fails MIN_NOTIONAL", async () => {
    // legUsd 0.5 / entryPrice 0.10 -> rawQty 5, floored to stepSize 1 -> qty 1 (clears minQty 1),
    // but notional = 1 * 0.10 = $0.10, under DOGEUSDT's minNotional of 5 in the fixture.
    const dogeSignal = signal({ observationId: "sf:DOGEUSDT:1", symbol: "DOGEUSDT", entryPrice: 0.1, stopPrice: 0.103 });
    const { executor, store } = makeExecutor({ signals: [dogeSignal], legUsd: 0.5 });
    await executor.tick();
    expect(store.getState().positions.length).toBe(0);
    // 2026-07-19 real-money audit fix: see minQty's identical comment above.
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/below exchange minNotional/i);
  });

  it("[ENTRY-SKIP-REASON, 2026-07-19 fix] sets lastEntrySkipReason (instead of silently leaving it null) for every other structural sizing rejection", async () => {
    // Covers the remaining silent branches from the same audit: missing exchange filters, invalid
    // legUsd, and invalid entryPrice. Each ran its OWN tick/executor so one rejection's message
    // can't be masked by a later signal's success within the same tick.
    const noFilterSignal = signal({ observationId: "sf:UNKNOWNUSDT:1", symbol: "UNKNOWNUSDT" });
    const { executor: filtersExecutor, store: filtersStore } = makeExecutor({ signals: [noFilterSignal], legUsd: 10_000 });
    await filtersExecutor.tick();
    expect(filtersStore.getState().positions.length).toBe(0);
    expect(filtersExecutor.getStatus().lastEntrySkipReason).toMatch(/UNKNOWNUSDT.*exchange filters unavailable/i);

    const { executor: legUsdExecutor, store: legUsdStore } = makeExecutor({ signals: [signal()], legUsd: 0 });
    await legUsdExecutor.tick();
    expect(legUsdStore.getState().positions.length).toBe(0);
    expect(legUsdExecutor.getStatus().lastEntrySkipReason).toMatch(/invalid leg size/i);

    const zeroPriceSignal = signal({ entryPrice: 0 });
    const { executor: priceExecutor, store: priceStore } = makeExecutor({ signals: [zeroPriceSignal], legUsd: 10_000 });
    await priceExecutor.tick();
    expect(priceStore.getState().positions.length).toBe(0);
    expect(priceExecutor.getStatus().lastEntrySkipReason).toMatch(/entry price unavailable/i);
  });

  it("[STEPSIZE-EPSILON, 2026-07-19 fix] a stepSize floor that would floating-point-undershoot by exactly one step opens at the mathematically correct quantity instead of silently dropping the signal", async () => {
    // legUsd=140.07 / entryPrice=20010 -> rawQty is EXACTLY 7 steps of stepSize=0.001
    // mathematically, but JS float representation gives 0.006999999999999999 (a hair under 7.0).
    // The pre-fix `Math.floor(rawQty / stepSize) * stepSize` (no epsilon guard) floored this to 6
    // steps -> qty=0.006, which fails this fixture's minQty=0.007 (pinned exactly there) and drops
    // the signal permanently (structural rejection, never retried) — a real order 14.3% smaller
    // than intended, in this case shrunk all the way to a fundable signal that could never fund.
    // The fix (roundToStep's epsilon-before-floor) must open at the correct qty=0.007.
    const client = new FakeClient();
    const stepSignal = signal({ observationId: "sf:XYZUSDT:1", symbol: "XYZUSDT", entryPrice: 20010, stopPrice: 20612 });
    const { executor, store } = makeExecutor({ client, signals: [stepSignal], legUsd: 140.07 });
    await executor.tick();
    const positions = store.getState().positions;
    expect(positions.length).toBe(1); // would be 0 under the bug (floored qty 0.006 < minQty 0.007)
    expect(positions[0]!.qty).toBeCloseTo(0.007, 8);
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

  it("[EXACT-FORMATION] opens a directional route only when all three distinct selected symbols are available", async () => {
    const signals = [
      signal({ observationId: "dir:BTC:1", symbol: "BTCUSDT", openedAtMs: NOW_MS - 60_000 }),
      signal({ observationId: "dir:ETH:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090, openedAtMs: NOW_MS - 90_000 }),
      signal({ observationId: "dir:SOL:1", symbol: "SOLUSDT", entryPrice: 150, stopPrice: 154.5, openedAtMs: NOW_MS - 120_000 }),
    ];
    let claims = 0;
    let releases = 0;
    const { executor, store, client } = makeExecutor({
      signals,
      legUsd: 10_000,
      maxOpenPositions: 3,
      requiredOpenPositions: 3,
      tryClaimEntryScope: () => {
        claims += 1;
        return { allowed: true, reason: null };
      },
      releaseEntryScope: () => { releases += 1; },
    });

    await executor.tick();

    expect(store.getState().positions.filter((position) => position.status === "OPEN").map((position) => position.symbol).sort())
      .toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(client.placed.filter((order) => order.reduceOnly)).toHaveLength(0);
    expect(claims).toBe(1);
    expect(releases).toBe(1);
  });

  it("[EXACT-FORMATION] refuses a one- or two-symbol fallback before submitting any order", async () => {
    const { executor, store, client } = makeExecutor({
      signals: [
        signal({ observationId: "dir:BTC:1", symbol: "BTCUSDT" }),
        signal({ observationId: "dir:ETH:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090 }),
      ],
      legUsd: 10_000,
      maxOpenPositions: 3,
      requiredOpenPositions: 3,
    });

    await executor.tick();

    expect(store.getState().positions).toHaveLength(0);
    expect(client.placed).toHaveLength(0);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/requires exactly 3 fresh candidates; found 2/i);
  });

  it("[ROUTE-CLAIM] does not submit any directional leg when the market-neutral route is still forming", async () => {
    const { executor, store, client } = makeExecutor({
      signals: [
        signal({ observationId: "dir:BTC:1", symbol: "BTCUSDT" }),
        signal({ observationId: "dir:ETH:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090 }),
        signal({ observationId: "dir:SOL:1", symbol: "SOLUSDT", entryPrice: 150, stopPrice: 154.5 }),
      ],
      legUsd: 10_000,
      maxOpenPositions: 3,
      requiredOpenPositions: 3,
      tryClaimEntryScope: () => ({ allowed: false, reason: "market-neutral cross-sectional entry is already being formed" }),
    });

    await executor.tick();

    expect(store.getState().positions).toHaveLength(0);
    expect(client.placed).toHaveLength(0);
    expect(executor.getStatus().lastEntrySkipReason).toBe("market-neutral cross-sectional entry is already being formed");
  });

  it("[EXACT-FORMATION] immediately flattens every transient leg if a later selected leg fails", async () => {
    const client = new FakeClient();
    client.failOnSymbol = "ETHUSDT";
    const { executor, store } = makeExecutor({
      client,
      signals: [
        signal({ observationId: "dir:BTC:1", symbol: "BTCUSDT", openedAtMs: NOW_MS - 60_000 }),
        signal({ observationId: "dir:ETH:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090, openedAtMs: NOW_MS - 90_000 }),
        signal({ observationId: "dir:SOL:1", symbol: "SOLUSDT", entryPrice: 150, stopPrice: 154.5, openedAtMs: NOW_MS - 120_000 }),
      ],
      legUsd: 10_000,
      maxOpenPositions: 3,
      requiredOpenPositions: 3,
    });

    await executor.tick();

    expect(store.getState().positions.filter((position) => position.status === "OPEN")).toHaveLength(0);
    expect(store.getState().positions.map((position) => position.closeReason)).toEqual([
      "INCOMPLETE_EXACT_FORMATION_ABORT",
      "INCOMPLETE_EXACT_FORMATION_ABORT",
    ]);
    expect(client.placed.filter((order) => order.reduceOnly).map((order) => order.symbol).sort())
      .toEqual(["BTCUSDT", "SOLUSDT"]);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/all transient legs were immediately flattened/i);
  });

  it("[EXACT-FORMATION] immediately flattens all three legs when any initial protective stop fails", async () => {
    const client = new FakeClient();
    client.failAlgoOnce = true;
    const { executor, store } = makeExecutor({
      client,
      signals: [
        signal({ observationId: "dir:BTC:1", symbol: "BTCUSDT", openedAtMs: NOW_MS - 60_000 }),
        signal({ observationId: "dir:ETH:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090, openedAtMs: NOW_MS - 90_000 }),
        signal({ observationId: "dir:SOL:1", symbol: "SOLUSDT", entryPrice: 150, stopPrice: 154.5, openedAtMs: NOW_MS - 120_000 }),
      ],
      legUsd: 10_000,
      maxOpenPositions: 3,
      requiredOpenPositions: 3,
    });

    await executor.tick();

    expect(store.getState().positions.filter((position) => position.status === "OPEN")).toHaveLength(0);
    expect(store.getState().positions.map((position) => position.closeReason)).toEqual([
      "INCOMPLETE_EXACT_FORMATION_ABORT",
      "INCOMPLETE_EXACT_FORMATION_ABORT",
      "INCOMPLETE_EXACT_FORMATION_ABORT",
    ]);
    expect(client.placed.filter((order) => order.reduceOnly).map((order) => order.symbol).sort())
      .toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/only 2\/3 protected leg\(s\)/i);
  });

  it("[EXACT-FORMATION] fails closed if a maker-entry configuration would leave a resting partial basket", async () => {
    const { executor, store, client } = makeExecutor({
      signals: [
        signal({ observationId: "dir:BTC:1", symbol: "BTCUSDT" }),
        signal({ observationId: "dir:ETH:1", symbol: "ETHUSDT", entryPrice: 3000, stopPrice: 3090 }),
        signal({ observationId: "dir:SOL:1", symbol: "SOLUSDT", entryPrice: 150, stopPrice: 154.5 }),
      ],
      legUsd: 10_000,
      maxOpenPositions: 3,
      requiredOpenPositions: 3,
      makerEntry: true,
    });

    await executor.tick();

    expect(store.getState().positions).toHaveLength(0);
    expect(client.placed).toHaveLength(0);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/rejects maker entry/i);
  });

  it("uses the actual market-filled quantity for the stored position and protective stop", async () => {
    const client = new FakeClient();
    client.executedQtyBySymbol.set("BTCUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });

    await executor.tick();

    expect(store.getState().positions[0]!.qty).toBe(0.1);
    expect(client.algosPlaced[0]!.quantity).toBe(0.1);
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
      // 2026-07-19 real-money audit fix: this structural rejection used to leave lastEntrySkipReason
      // null, unlike every other skip branch in this function.
      expect(executor.getStatus().lastEntrySkipReason).toMatch(/BTCUSDT.*cross-lane per-symbol notional cap exceeded/i);
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

  describe("[2026-07-19 real-money audit fix] correlated-cluster cap extended to single-symbol lanes", () => {
    // SOLUSDT/ADAUSDT are both in the L1 cluster (correlation-clusters.ts's DEFAULT_CLUSTER_MAP) —
    // the same class of correlated-alt basket (a SUI/ADA/AVAX-style dump-together cluster) the
    // mirror's own cap was built to stop. existingClusterOpenSymbols simulates what app.ts's real
    // wiring combines: the legacy mirror's own open intents + every OTHER executor instance's open
    // positions — here standing in for "the legacy mirror already has ADAUSDT open in this cluster".
    const solSignal = signal({ observationId: "sol:1", symbol: "SOLUSDT", entryPrice: 150, stopPrice: 154.5 });

    it("with no cap set (default 0), behaves exactly as before — opens regardless of existingClusterOpenSymbols (FAIL-WITHOUT baseline)", async () => {
      const { executor, store } = makeExecutor({
        signals: [solSignal],
        legUsd: 100,
        existingClusterOpenSymbols: () => new Set(["ADAUSDT", "AVAXUSDT", "SUIUSDT"]), // huge — must NOT matter, cap is 0/off
      });
      await executor.tick();
      expect(store.getState().positions.length).toBe(1);
    });

    it("FAIL-WITHOUT/PASS-WITH: blocks a fresh entry into a correlated-cluster symbol once the cluster cap would be exceeded by combining this lane's OWN position with a (simulated) legacy-mirror position", async () => {
      const client = new FakeClient();
      // Step 1: this lane instance already holds SUIUSDT (L1) open, from an earlier tick — its OWN
      // position, tracked in this executor's OWN store (not via existingClusterOpenSymbols).
      const suiSignal = signal({ observationId: "sui:1", symbol: "SUIUSDT", entryPrice: 4, stopPrice: 4.12 });
      // A non-MAJOR L1 filter is needed for SUIUSDT too, so the seeding entry can fully open.
      const clientWithSui = client as FakeClient & { getExchangeFilters: FakeClient["getExchangeFilters"] };
      const originalFilters = clientWithSui.getExchangeFilters.bind(clientWithSui);
      clientWithSui.getExchangeFilters = async () => {
        const m = await originalFilters();
        m.set("SUIUSDT", { symbol: "X", stepSize: 0.1, minQty: 0.1, tickSize: 0.001, minNotional: 5, pricePrecision: 3, quantityPrecision: 1 });
        return m;
      };
      const signals: SingleSymbolFreshSignal[] = [suiSignal];
      const { executor, store } = makeExecutor({
        client,
        signals,
        legUsd: 100,
        maxOpenPositions: 2, // this instance is allowed 2 concurrent positions, so both can attempt
        // Simulated legacy-mirror open intent: ADAUSDT (also L1) already open on the mirror side.
        existingClusterOpenSymbols: () => new Set(["ADAUSDT"]),
        maxClusterPositionsAcrossLanes: 2, // cap of 2 symbols per cluster+direction
      });
      await executor.tick(); // opens SUIUSDT — own book now has 1 L1 symbol (SUIUSDT)
      expect(store.getState().positions.filter((p) => p.status === "OPEN").length).toBe(1);

      // Step 2: a FRESH SOLUSDT (also L1) signal arrives. Cluster count is now ADAUSDT (mirror) +
      // SUIUSDT (this instance's own open position) = 2, already AT the cap of 2 — SOLUSDT must be
      // blocked (fail-without: prior to this fix, existingClusterOpenSymbols/maxClusterPositionsAcrossLanes
      // did not exist and this entry would have opened unconditionally).
      signals.push(solSignal);
      await executor.tick();
      const open = store.getState().positions.filter((p) => p.status === "OPEN");
      expect(open.length).toBe(1); // still just SUIUSDT — SOLUSDT was blocked
      expect(open.some((p) => p.symbol === "SOLUSDT")).toBe(false);
      expect(executor.getStatus().lastEntrySkipReason).toMatch(/SOLUSDT.*correlated-cluster cap \(L1/i);
    });

    it("PASS-WITH: the SAME cluster composition opens normally once the cap has NOT yet been reached", async () => {
      const { executor, store } = makeExecutor({
        signals: [solSignal],
        legUsd: 100,
        // Only ADAUSDT open elsewhere (mirror) — 1 symbol in the L1 cluster, cap is 3 -> room remains.
        existingClusterOpenSymbols: () => new Set(["ADAUSDT"]),
        maxClusterPositionsAcrossLanes: 3,
      });
      await executor.tick();
      const open = store.getState().positions.filter((p) => p.status === "OPEN");
      expect(open.length).toBe(1);
      expect(open[0]!.symbol).toBe("SOLUSDT");
    });

    it("does not block re-adding to a symbol that is ALREADY counted in the cluster's open set (the cap only blocks NEW symbols, matching the mirror's own !openSymbols.has(...) exemption)", async () => {
      const { executor, store } = makeExecutor({
        signals: [solSignal],
        legUsd: 100,
        // SOLUSDT itself already counted (e.g. this exact instance's own earlier open, or another
        // lane's open on the SAME symbol) — cap is fully saturated at 1, but SOLUSDT is already IN
        // the open set, so it must not be treated as a NEW cluster addition.
        existingClusterOpenSymbols: () => new Set(["SOLUSDT"]),
        maxClusterPositionsAcrossLanes: 1,
      });
      await executor.tick();
      expect(store.getState().positions.length).toBe(1);
    });

    it("MAJORS (BTC/ETH) are exempt from the cluster cap, matching live-execution-engine.ts's own exemption", async () => {
      const { executor, store } = makeExecutor({
        signals: [signal()], // BTCUSDT by default
        legUsd: 100,
        existingClusterOpenSymbols: () => new Set(["ADAUSDT", "AVAXUSDT", "SUIUSDT"]), // irrelevant — BTC never checks this
        maxClusterPositionsAcrossLanes: 1,
      });
      await executor.tick();
      expect(store.getState().positions.length).toBe(1);
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

  it("[DIRECTIONAL NO-PYRAMID] refuses a fresh second observation for a symbol this lane already owns", async () => {
    const signals: SingleSymbolFreshSignal[] = [signal({ observationId: "sf:BTCUSDT:first", openedAtMs: NOW_MS - 4 * 60_000 })];
    const { executor, client, store } = makeExecutor({
      signals,
      legUsd: 10_000,
      maxOpenPositions: 3,
      preventSameSymbolPyramiding: true,
    });

    await executor.tick();
    expect(store.getState().positions.filter((p) => p.status === "OPEN")).toHaveLength(1);
    signals.push(signal({ observationId: "sf:BTCUSDT:second", openedAtMs: NOW_MS - 1 * 60_000 }));

    await executor.tick();

    expect(store.getState().positions.filter((p) => p.status === "OPEN")).toHaveLength(1);
    expect(client.placed).toHaveLength(1);
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/same-symbol directional position.*no pyramiding/i);
  });

  it("[MAX-OPEN-DIAGNOSTIC, 2026-07-19 fix] sets lastEntrySkipReason (instead of silently leaving it null) when the maxOpenPositions cap blocks a fresh candidate", async () => {
    const { executor, store } = makeExecutor({
      // maxOpenPositions defaults to 1 in makeExecutor; seed the store directly so the cap is
      // already at its limit BEFORE tick() runs (no need to spend a tick opening it first).
      signals: [signal({ observationId: "sf:ETHUSDT:2", symbol: "ETHUSDT" })],
      legUsd: 10_000,
    });
    store.getState().positions.push({
      positionId: "seed-open", sourceObservationId: "seed-open", symbol: "BTCUSDT", direction: "SHORT", qty: 0.001,
      entryPrice: 60000, entryOrderId: "1", entryPriceConfirmed: true, stopPrice: 61800, stopAlgoOrderId: "900",
      stopFailureCount: 0, stopUnprotectedSinceIso: null, closeFailureCount: 0, closeFailureSinceIso: null,
      peakFavorableR: 0, openedAt: NOW, status: "OPEN", closedAt: null, closeReason: null,
      exitPrice: null, exitOrderId: null, exitPriceConfirmed: false, grossPnlUsd: null, feeEstimateUsd: 0, netPnlUsd: null,
    });

    await executor.tick();

    // Property 2: cap behavior itself is unchanged — the fresh ETHUSDT candidate must NOT open.
    expect(store.getState().positions.filter((p) => p.status === "OPEN").length).toBe(1);
    expect(store.getState().positions.find((p) => p.symbol === "ETHUSDT")).toBeUndefined();

    // Property 1 (the actual fix): before 2026-07-19, this check "break"-ed with NO reason set,
    // leaving lastEntrySkipReason null and giving the operator zero diagnostic for why nothing
    // opened. It must now be a non-null string that names the cap.
    expect(executor.getStatus().lastEntrySkipReason).not.toBeNull();
    expect(executor.getStatus().lastEntrySkipReason).toMatch(/max open positions/i);
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

  // ── 2026-08-04 fail-closed innovation campaign control ────────────────────────────────────
  // The campaign gate (innovation-campaign.ts) is wired ONLY into isAllowed() at app.ts's 13
  // innovation-executor construction sites — never into tick()'s monitorOpenPositions() prefix,
  // and never into the outer construction gate. These two tests are the load-bearing proof that
  // holds: an absent/expired/disabled campaign (isAllowed() false) can only ever block a NEW
  // entry, never the management or closing of a position that is already OPEN.
  describe("[FAIL-CLOSED CAMPAIGN] position management/closing continues even with no active innovation campaign", () => {
    function openShortPosition(over: Partial<SingleSymbolPosition> = {}) {
      return {
        positionId: "seed-nocamp", sourceObservationId: "seed-nocamp", symbol: "BTCUSDT", direction: "SHORT" as const,
        qty: 0.001, entryPrice: 60000, entryOrderId: "1", entryPriceConfirmed: true, stopPrice: 61800,
        stopAlgoOrderId: "900", stopFailureCount: 0, stopUnprotectedSinceIso: null, closeFailureCount: 0,
        closeFailureSinceIso: null, peakFavorableR: 0, openedAt: NOW, status: "OPEN" as const, closedAt: null,
        closeReason: null, exitPrice: null, exitOrderId: null, exitPriceConfirmed: false,
        grossPnlUsd: null, feeEstimateUsd: 0, netPnlUsd: null,
        ...over,
      };
    }

    it("monitorOpenPositions still closes an already-OPEN position via the exit policy when isAllowed() is false the whole time (no active campaign)", async () => {
      const client = new FakeClient();
      const { executor, store } = makeExecutor({ client, allowed: false });
      store.getState().positions.push(openShortPosition());
      // 0.5R favorable for the SHORT (entry 60000, stop 61800 -> risk 1800, target 59100) -> TP_HIT.
      client.markPriceBySymbol.set("BTCUSDT", 59000);

      await executor.tick();

      const pos = store.getState().positions[0]!;
      expect(pos.status).toBe("CLOSED");
      expect(pos.closeReason).toBe("TP_HIT");
      expect(client.placed.some((p) => p.reduceOnly === true)).toBe(true);
      // The campaign gate itself is still doing its job — NEW entries stay blocked throughout.
      expect(executor.getStatus().allowed).toBe(false);
    });

    it("[RESTART] a freshly constructed executor (simulating a process restart) still loads and closes an already-OPEN position from disk even though isAllowed() reflects 'no active campaign' from the very first tick", async () => {
      const storeDir = tmpDir();
      const fileName = "restart-campaign.json";

      // "Process A": a position opens and is persisted; the process then ends.
      const store1 = new SingleSymbolLaneExecutorStore(storeDir, fileName);
      store1.getState().positions.push(openShortPosition());
      store1.save();

      // "Process B" (restart): a BRAND NEW store instance re-reads the SAME directory/file — this
      // is exactly what app.ts's construction gate does on every process start, unconditionally,
      // regardless of campaign state (see innovation-campaign.ts's module doc comment and the
      // outer `if (liveEngine && isInnovationTestnetExecutionEnabled(...))` gate in app.ts, which
      // this design never touches).
      const store2 = new SingleSymbolLaneExecutorStore(storeDir, fileName);
      expect(store2.getState().positions.find((p) => p.positionId === "seed-nocamp")?.status).toBe("OPEN");

      const client2 = new FakeClient();
      client2.markPriceBySymbol.set("BTCUSDT", 59000);
      const executor2 = new SingleSymbolLaneExecutor({
        client: client2,
        store: store2,
        laneId: "FUNDING_CARRY_NEUTRAL_PAIR",
        direction: "SHORT",
        getOpenSignals: () => [],
        exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
        isAllowed: () => false, // no active campaign — the ONLY gate this design ever touches
        legUsd: () => 25,
        leverage: () => 3,
        nowIso: () => NOW,
        fillConfirmRetryDelayMs: 0,
      });

      await executor2.tick();

      const pos = store2.getState().positions.find((p) => p.positionId === "seed-nocamp")!;
      expect(pos.status).toBe("CLOSED"); // position management survives the restart, campaign or no campaign
    });
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

  it("[STOP-HEALTH, 2026-07-19 fix] re-establishes protection when the exchange-side stop is CANCELED/EXPIRED WITHOUT ever triggering, instead of silently trusting the stale stopAlgoOrderId forever", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    const opened = store.getState().positions[0]!;
    const originalAlgoId = opened.stopAlgoOrderId!;
    expect(originalAlgoId).not.toBeNull();

    // Simulate an unrelated part of the system (e.g. a sibling close/flip operation's
    // cancelAllAlgoOrders for this same symbol) cancelling the stop on the exchange WITHOUT it
    // ever triggering — actualOrderId stays null, only algoStatus changes.
    client.cancelAlgoExternally(originalAlgoId, "CANCELED");
    client.markPriceBySymbol.set("BTCUSDT", 60100); // irrelevant to this check — position stays OPEN, not stopped out

    await executor.tick();

    const afterDetection = store.getState().positions[0]!;
    expect(afterDetection.status).toBe("OPEN"); // never falsely closed — the stop never triggered
    // The core fix: a genuinely NEW stop must be placed, not the stale cancelled id trusted forever.
    expect(afterDetection.stopAlgoOrderId).not.toBeNull();
    expect(afterDetection.stopAlgoOrderId).not.toBe(originalAlgoId);
    expect(client.algosPlaced.length).toBe(2); // original + the re-established replacement
    expect(afterDetection.stopFailureCount).toBe(0); // re-establish succeeded — not flagged unprotected

    // The freshly re-established stop is a real, independently trackable resting order — a genuine
    // trigger on IT must still settle the position normally.
    client.triggerAlgo(afterDetection.stopAlgoOrderId!, "7777", -1.8, 0.05, 60100, afterDetection.qty);
    await executor.tick();
    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.closeReason).toBe("INITIAL_STOP");
  });

  it("[STOP-HEALTH, 2026-07-19 fix] surfaces the position as unprotected via getStatus() when re-establishing the stop ALSO fails, rather than staying silent", async () => {
    const client = new FakeClient();
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    const opened = store.getState().positions[0]!;
    const originalAlgoId = opened.stopAlgoOrderId!;

    client.cancelAlgoExternally(originalAlgoId, "EXPIRED");
    client.failAlgoOnce = true; // the re-establish attempt itself fails transiently

    await executor.tick();

    const afterDetection = store.getState().positions[0]!;
    expect(afterDetection.status).toBe("OPEN");
    expect(afterDetection.stopAlgoOrderId).toBeNull(); // re-establish failed — genuinely naked right now
    expect(afterDetection.stopFailureCount).toBeGreaterThan(0);
    // Operator-visible, not silent: the SAME persistent mechanism ensureStopOrder's own failures
    // already use (unlike lastError, which tick() resets to null once the tick completes without
    // throwing — unprotectedPositions is the durable signal an operator/monitor actually polls).
    const unprotected = executor.getStatus().unprotectedPositions;
    expect(unprotected.some((p) => p.positionId === afterDetection.positionId)).toBe(true);
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
    // The entry leg is recorded on its own regardless of whether it was folded into the totals
    // above — 0.02 is the entry commission, and the entry order realized nothing (it OPENED).
    expect(closed.entryCommissionUsd).toBeCloseTo(0.02, 9);
    expect(closed.entryRealizedPnlUsd).toBeCloseTo(0, 9);
    // Folded here because this fixture's entry row is timestamped at openedAt, i.e. it is one of
    // the rows the OLD openedAt-anchored window already returned. See the FEE-WINDOW tests below.
    expect(closed.entryLegFoldedIntoPnl).toBe(true);
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

describe("SingleSymbolLaneExecutor — getUserTrades fee window (2026-07-26 fix)", () => {
  /** Open a position, then place its protective stop. Returns the live position record. */
  async function openWithStop(client: FakeClient) {
    const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 10_000 });
    await executor.tick(); // open
    await executor.tick(); // place stop
    return { executor, store, pos: store.getState().positions[0]! };
  }

  it("[FEE-WINDOW] stamps the query's lower bound BEFORE the entry order is submitted, not from openedAt", async () => {
    const client = new FakeClient();
    const { pos } = await openWithStop(client);
    // openedAt is written into the position literal AFTER placeOrder and AFTER resolveFillPrice;
    // the window stamp is taken immediately BEFORE placeOrder. Under this frozen clock both read
    // NOW_MS, so the only observable difference is the deliberate skew slack.
    expect(Date.parse(pos.openedAt)).toBe(NOW_MS);
    expect(pos.entryTradeWindowFromMs).toBe(NOW_MS - 10_000);
  });

  it("[FEE-WINDOW] captures the ENTRY commission for a fill Binance timestamped BEFORE openedAt — the row the old window always missed", async () => {
    const client = new FakeClient();
    // Model the real endpoint: startTime is honoured and compared against the exchange's own
    // trade timestamp. Without this the fixture cannot express the bug at all.
    client.honourStartTime = true;
    const { executor, store, pos } = await openWithStop(client);
    const fullQty = pos.qty;
    const algoId = pos.stopAlgoOrderId!;

    // The entry matched on Binance 5s before our process got as far as stamping openedAt — the
    // ordinary case, since openedAt is written after the placeOrder round-trip AND after
    // resolveFillPrice. Under the OLD window (startTime = openedAt = NOW_MS) this row is excluded.
    client.seedTrade(pos.entryOrderId, { qty: fullQty, commission: 0.02, time: NOW_MS - 5_000 });
    client.triggerAlgo(algoId, "9001", -0.9, 0.03, 61800, fullQty);
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    // The window that was actually requested — asserted directly, not inferred from the sums.
    expect(client.lastUserTradesStartTime).toBe(NOW_MS - 10_000);
    // THE POINT OF THE FIX: the entry commission is now visible and recorded. Before the fix this
    // is `undefined` — the row never came back from the exchange at all.
    expect(closed.entryCommissionUsd).toBeCloseTo(0.02, 9);
    expect(closed.entryRealizedPnlUsd).toBeCloseTo(0, 9);

    // BEHAVIOUR PRESERVATION, and it is the whole reason this is safe to deploy unattended:
    // making the row VISIBLE must not silently move netPnlUsd, because netPnlUsd feeds the
    // daily-loss entry gate and the account-wide consecutive-loss kill switch. This row was
    // outside the OLD window, so it is recorded but NOT folded, and the totals are bit-identical
    // to what shipped.
    expect(closed.entryLegFoldedIntoPnl).toBe(false);
    expect(closed.feeEstimateUsd).toBeCloseTo(0.03, 9);
    expect(closed.grossPnlUsd).toBeCloseTo(-0.9, 9);
    expect(closed.netPnlUsd).toBeCloseTo(-0.93, 9);
    expect(closed.feeSource).toBe("EXCHANGE");
  });

  it("[FEE-WINDOW] SINGLE_SYMBOL_EXEC_FOLD_ENTRY_FEE=1 folds that same entry commission into the P&L totals (opt-in, execution-affecting)", async () => {
    const prev = process.env.SINGLE_SYMBOL_EXEC_FOLD_ENTRY_FEE;
    process.env.SINGLE_SYMBOL_EXEC_FOLD_ENTRY_FEE = "1";
    try {
      const client = new FakeClient();
      client.honourStartTime = true;
      const { executor, store, pos } = await openWithStop(client);
      const fullQty = pos.qty;
      client.seedTrade(pos.entryOrderId, { qty: fullQty, commission: 0.02, time: NOW_MS - 5_000 });
      client.triggerAlgo(pos.stopAlgoOrderId!, "9001", -0.9, 0.03, 61800, fullQty);
      await executor.tick();

      const closed = store.getState().positions[0]!;
      expect(closed.status).toBe("CLOSED");
      expect(closed.entryLegFoldedIntoPnl).toBe(true);
      // 0.03 exit + 0.02 entry — the true two-sided cost, vs. 0.03 exit-only in the test above.
      expect(closed.feeEstimateUsd).toBeCloseTo(0.05, 9);
      // The shift the operator is signing off on: netPnlUsd is one entry commission MORE negative,
      // which tightens the daily-loss gate and the consecutive-loss kill switch by that much.
      expect(closed.netPnlUsd).toBeCloseTo(-0.95, 9);
      expect(closed.entryCommissionUsd).toBeCloseTo(0.02, 9);
    } finally {
      if (prev === undefined) delete process.env.SINGLE_SYMBOL_EXEC_FOLD_ENTRY_FEE;
      else process.env.SINGLE_SYMBOL_EXEC_FOLD_ENTRY_FEE = prev;
    }
  });

  it("[FEE-WINDOW] a foreign order's trade inside the widened window contributes nothing (matching is by exact orderId)", async () => {
    const client = new FakeClient();
    client.honourStartTime = true;
    const { executor, store, pos } = await openWithStop(client);
    const fullQty = pos.qty;
    client.seedTrade(pos.entryOrderId, { qty: fullQty, commission: 0.02, time: NOW_MS - 5_000 });
    // A sibling executor's fill on the SAME netted symbol, timestamped inside the newly-widened
    // 10s slack — the one hazard widening the window could plausibly introduce. Deliberately huge
    // so any leakage into the sums is unmissable.
    client.seedTrade("77777", { qty: 99, commission: 5, realizedPnl: 999, time: NOW_MS - 3_000 });
    client.triggerAlgo(pos.stopAlgoOrderId!, "9001", -0.9, 0.03, 61800, fullQty);
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.feeEstimateUsd).toBeCloseTo(0.03, 9);
    expect(closed.grossPnlUsd).toBeCloseTo(-0.9, 9);
    expect(closed.entryCommissionUsd).toBeCloseTo(0.02, 9);
    // Also proves the foreign row never polluted the qty-weighted exit price.
    expect(closed.exitPrice).toBeCloseTo(61800, 9);
  });

  it("[FEE-WINDOW] a throwing getUserTrades still closes the position and never fabricates an entry commission", async () => {
    const client = new FakeClient();
    client.honourStartTime = true;
    const { executor, store, pos } = await openWithStop(client);
    client.seedTrade(pos.entryOrderId, { qty: pos.qty, commission: 0.02, time: NOW_MS - 5_000 });
    // Everything the fee-window fix added (the widened window, the fold predicate, the entry-leg
    // read) lives inside sumOwnRealizedTrades' existing try/catch. Blow the fetch up and the close
    // must still complete off the modelled fallback, exactly as before.
    client.getUserTrades = async () => { throw new Error("userTrades 5xx"); };
    client.markPriceBySymbol.set("BTCUSDT", 59_000); // 0.5R in favour -> the fixed-reward TP fires
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.netPnlUsd).not.toBeNull();
    expect(closed.feeSource).toBe("ESTIMATE_TAKER_FLAT");
    // UNKNOWN stays UNKNOWN — never back-filled from the flat model, which would look measured.
    expect(closed.entryCommissionUsd).toBeUndefined();
    expect(closed.entryLegFoldedIntoPnl).toBeUndefined();
  });

  it("[FEE-WINDOW] a position persisted WITHOUT entryTradeWindowFromMs falls back to openedAt and still settles", async () => {
    const client = new FakeClient();
    client.honourStartTime = true;
    const { executor, store, pos } = await openWithStop(client);
    const fullQty = pos.qty;
    // Simulate a record written before this field existed.
    delete (store.getState().positions[0] as { entryTradeWindowFromMs?: number }).entryTradeWindowFromMs;
    store.save();

    client.seedTrade(pos.entryOrderId, { qty: fullQty, commission: 0.02, time: NOW_MS - 5_000 });
    client.triggerAlgo(pos.stopAlgoOrderId!, "9001", -0.9, 0.03, 61800, fullQty);
    await executor.tick();

    const closed = store.getState().positions[0]!;
    expect(closed.status).toBe("CLOSED");
    // Exactly the OLD window — never a fabricated retro-fit onto a record that never measured it.
    expect(client.lastUserTradesStartTime).toBe(NOW_MS);
    // ...and therefore exactly the OLD (mis-recording) outcome: the entry row was filtered out.
    expect(closed.entryCommissionUsd).toBeUndefined();
    expect(closed.feeEstimateUsd).toBeCloseTo(0.03, 9);
  });
});

describe("SingleSymbolLaneExecutor — own-lot P&L attribution", () => {
  it("reports a directional lot from its own fills instead of the account-netted exchange realizedPnl", async () => {
    const client = new FakeClient();
    client.fillPriceBySymbol.set("BTCUSDT", 60_000);
    const { executor, store } = makeExecutor({
      client,
      signals: [signal()],
      legUsd: 60_000, // exactly one BTC in this fixture
      useOwnLotPnlAttribution: true,
    });

    await executor.tick();
    const open = store.getState().positions[0]!;
    client.seedTrade(open.entryOrderId, { price: 60_000, qty: 1, commission: 0.02, realizedPnl: 0 });
    // The exchange's account-netted realizedPnl is deliberately positive because
    // a sibling basket had an older, lower-price short. This directional lot was
    // actually closed higher and therefore lost $100 before its own fees.
    client.fillPriceBySymbol.set("BTCUSDT", 60_100);
    client.seedTrade("101", { price: 60_100, qty: 1, commission: 0.03, realizedPnl: 7 });

    const result = await executor.manualClosePosition(open.positionId);
    const durable = store.getState().positions[0]!;
    const reported = executor.getClosedPositions()[0]!;

    expect(durable.netPnlUsd).toBeCloseTo(6.95, 9); // raw exchange-account settlement, retained for audit
    expect(result.netPnlUsd).toBeCloseTo(-100.05, 9);
    expect(reported.netPnlUsd).toBeCloseTo(-100.05, 9);
    expect(reported.grossPnlUsd).toBeCloseTo(-100, 9);
    expect(reported.feeEstimateUsd).toBeCloseTo(0.05, 9);
    expect(reported.exchangeAccountNetPnlUsd).toBeCloseTo(6.95, 9);
    expect(reported.pnlAttribution).toBe("OWN_LOT");
    expect(reported.pnlAttributionComplete).toBe(true);
    expect(executor.getStatus().totalNetPnlUsd).toBeCloseTo(-100.05, 9);
  });
});

describe("[SS-MAKER-CANCEL-CONFIRM] bounded cancel confirmation never fabricates an open position", () => {
  it("keeps the durable handle and books no position while Binance still reports NEW after cancel", async () => {
    const client = new FakeClient() as FakeClient & {
      cancelOrder: (symbol: string, orderId: string) => Promise<void>;
    };
    client.cancelOrder = async () => {};
    const { executor, store } = makeExecutor({
      client,
      signals: [signal()],
      legUsd: 1_000,
      makerEntry: true,
      makerEntryWaitMs: 1_000,
      currentPrice: 60_000,
      readPublicQuote: () => ({ bid: 59_990, ask: 60_010, mid: 60_000, atMs: Date.now(), venue: "TEST_BOOK" }),
    });

    await executor.tick();

    // The old caller converted executedQty=0 to requested qty and created an OPEN position here.
    // The only honest state is an unresolved order handle, recoverable by client id next tick.
    expect(store.getState().positions).toHaveLength(0);
    expect(store.getState().pendingMakerEntries ?? []).toHaveLength(1);
    expect(client.placed.filter((order) => order.timeInForce === "GTX")).toHaveLength(1);
    expect(client.placed.filter((order) => order.type === "MARKET")).toHaveLength(0);
  });
});

describe("[SS-PENDING] an entry order that filled while the process was down", () => {
    // Before 2026-08-18 the resting order's id lived only in a local variable inside
    // placeEntryMakerFirst. A restart inside the 120s post-only window lost it: the order stayed
    // REAL on the exchange, and a later fill became a live position with no stop and no tracking.
    const pending = (clientOrderId: string) => ({
      clientOrderId, symbol: "BTCUSDT", direction: "SHORT" as const, qty: 0.01,
      // Fresh: a recovered position whose maxHold already elapsed is CORRECTLY closed on the same
      // tick, so a stale timestamp here would measure the max-hold path instead of adoption.
      placedAt: new Date().toISOString(), sourceObservationId: "obs-1",
      stopPrice: 61000, targetPrice: 58000, maxHoldMs: 3_600_000,
    });
    const restart = (dir: string, file: string, client: FakeClient) =>
      new SingleSymbolLaneExecutor({
        client, store: new SingleSymbolLaneExecutorStore(dir, file),
        laneId: "SHORT_FADE_EXHAUSTION_CROWDED", direction: "SHORT",
        getOpenSignals: () => [],
        exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
        isAllowed: () => false,
      });

    it("is ADOPTED as a tracked position and stopped, instead of staying invisible", async () => {
      const dir = tmpDir(), file = "pending-fill.json";
      const s1 = new SingleSymbolLaneExecutorStore(dir, file);
      s1.addPendingMakerEntry(pending("ssle-abc-e"));   // process dies here

      const client = new FakeClient();
      // Mark == entry: no PnL, so the exit policy cannot legitimately close it this same tick and
      // the assertion below measures ADOPTION rather than the exit path.
      client.markPriceBySymbol.set("BTCUSDT", 60500);
      // The exchange must also REPORT the position, otherwise monitorOpenPositions correctly
      // reconciles the freshly adopted row away as a position that is not really there.
      client.positionAmtBySymbol.set("BTCUSDT", -0.01);
      client.byClientId.set("ssle-abc-e", {
        orderId: "777", symbol: "BTCUSDT", side: "SELL", status: "FILLED",
        executedQty: 0.01, avgPrice: 60500, price: 60500, clientOrderId: "ssle-abc-e",
      } as unknown as FuturesOrder);

      const ex = restart(dir, file, client);
      await ex.tick();

      const st = new SingleSymbolLaneExecutorStore(dir, file).getState();
      const pos = st.positions.find((p) => p.entryOrderId === "777");
      expect(pos, "the filled order must become a tracked position").toBeTruthy();
      expect(pos!.status).toBe("OPEN");
      expect(pos!.qty).toBe(0.01);
      expect(pos!.stopPrice).toBe(61000);   // carried from the pending record, not invented
      expect(st.pendingMakerEntries ?? []).toHaveLength(0); // handle consumed
      expect(client.algosPlaced.length, "a recovered position must be STOPPED").toBeGreaterThan(0);
    });

    it("is RECORDED before the order is sent, and SURVIVES an ambiguous failure", async () => {
      // The scenario the whole mechanism exists for. placeOrder times out: we do not know whether
      // the order reached the book. The handle must already be on disk, and must NOT be dropped —
      // only an unambiguous in-band rejection proves no order exists.
      const client = new FakeClient();
      client.markPriceBySymbol.set("BTCUSDT", 60000);
      client.placeOrder = async () => {
        throw new BinanceFuturesPrivateError("timeout", "request timed out after 10000ms");
      };
      const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 1_000 });
      await executor.tick();
      const pending = store.getState().pendingMakerEntries ?? [];
      expect(pending, "an ambiguous placement must leave a searchable handle").toHaveLength(1);
      expect(pending[0]!.symbol).toBe("BTCUSDT");
      expect(pending[0]!.stopPrice).toBe(61800); // carried from the signal, ready to stop a fill
    });

    it("DROPS the handle when Binance explicitly rejects the order in-band", async () => {
      // The mirror case: Binance answered "no", so no order exists and the handle is noise.
      const client = new FakeClient();
      client.markPriceBySymbol.set("BTCUSDT", 60000);
      client.placeOrder = async () => {
        throw new BinanceFuturesPrivateError("binance_error", "Margin is insufficient.", { binanceCode: -2019 });
      };
      const { executor, store } = makeExecutor({ client, signals: [signal()], legUsd: 1_000 });
      await executor.tick();
      expect(store.getState().pendingMakerEntries ?? []).toHaveLength(0);
    });

    it("drops the handle when Binance proves the order never existed (-2013)", async () => {
      const dir = tmpDir(), file = "pending-absent.json";
      new SingleSymbolLaneExecutorStore(dir, file).addPendingMakerEntry(pending("ssle-gone-e"));
      const client = new FakeClient(); // byClientId empty -> throws -2013
      await restart(dir, file, client).tick();
      const st = new SingleSymbolLaneExecutorStore(dir, file).getState();
      expect(st.pendingMakerEntries ?? []).toHaveLength(0);
      expect(st.positions).toHaveLength(0); // nothing invented
    });

    it("KEEPS the handle when the answer is ambiguous — never guesses the order away", async () => {
      const dir = tmpDir(), file = "pending-unknown.json";
      new SingleSymbolLaneExecutorStore(dir, file).addPendingMakerEntry(pending("ssle-wait-e"));
      const client = new FakeClient();
      client.queryOrderByClientId = async () => { throw new Error("network down"); };
      await restart(dir, file, client).tick();
      const st = new SingleSymbolLaneExecutorStore(dir, file).getState();
      expect(st.pendingMakerEntries ?? []).toHaveLength(1); // still pending, retried next tick
      expect(st.positions).toHaveLength(0);
    });

    it("keeps the handle while the order is still RESTING with nothing filled", async () => {
      const dir = tmpDir(), file = "pending-resting.json";
      new SingleSymbolLaneExecutorStore(dir, file).addPendingMakerEntry(pending("ssle-rest-e"));
      const client = new FakeClient();
      client.byClientId.set("ssle-rest-e", {
        orderId: "888", symbol: "BTCUSDT", side: "SELL", status: "NEW",
        executedQty: 0, avgPrice: 0, price: 60500, clientOrderId: "ssle-rest-e",
      } as unknown as FuturesOrder);
      await restart(dir, file, client).tick();
      const st = new SingleSymbolLaneExecutorStore(dir, file).getState();
      expect(st.pendingMakerEntries ?? []).toHaveLength(1);
      expect(st.positions).toHaveLength(0);
    });
  });

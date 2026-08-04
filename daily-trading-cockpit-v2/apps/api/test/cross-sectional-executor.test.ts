import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { BinanceFuturesPrivateError, type FuturesOrder, type FuturesPosition, type FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
import {
  CrossSectionalStore,
  _resetCrossSectionalStoreForTests,
  CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST,
  type CrossSectionalObservation,
} from "../src/lib/cross-sectional-edge.js";
import {
  CrossSectionalExecutor,
  CrossSectionalExecutorStore,
  CROSS_SECTIONAL_TREND_LANE_ID,
  crossSectionalMarketNeutralIsAllowed,
  isCrossSectionalTrendMixedAdmissionIndependent,
  type CrossSectionalExecClient,
  type ExecutorBasket,
} from "../src/lib/cross-sectional-executor.js";
import { CortexRealAttributionStore } from "../src/lib/cortex-real-attribution.js";
// [CONFLICTING SINGLE-SYMBOL EXPOSURE] test support only (see the describe block near the end of
// this file) — a REAL AccountExposureCoordinator + a REAL SingleSymbolLaneExecutor, reusing the
// exact construction idiom already established in account-exposure-coordinator-integration.test.ts,
// to prove the shared coordinator (not the fake ledger this file otherwise uses) actually prevents
// oversubscription between the two executor TYPES on the same symbol.
import { AccountExposureCoordinator, AccountExposureReservationStore } from "../src/lib/account-exposure-coordinator.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type SingleSymbolExecClient,
  type SingleSymbolPosition,
} from "../src/lib/single-symbol-lane-executor.js";

const NOW = "2026-07-02T03:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

const dirs: string[] = [];
let n = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `xsec-exec-${process.pid}-${++n}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  _resetCrossSectionalStoreForTests();
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

function signalObs(openedAtMs: number): CrossSectionalObservation {
  return {
    observationId: `xsec:MOM24:${openedAtMs}`,
    openedAt: new Date(openedAtMs).toISOString(),
    openedAtMs,
    horizonMs: 24 * 3_600_000,
    signal: "MOM24_FILTERED",
    variant: "FILTERED",
    k: 1,
    longLeg: [{ symbol: "SOLUSDT", entryPrice: 100, exitPrice: null }],
    shortLeg: [{ symbol: "DOGEUSDT", entryPrice: 0.1, exitPrice: null }],
    status: "OPEN",
    grossReturn: null,
    costReturn: null,
    netReturn: null,
    longLegReturn: null,
    shortLegReturn: null,
    resolvedAt: null,
  };
}

class FakeExecClient implements CrossSectionalExecClient {
  placed: Array<{ symbol: string; side: string; quantity: number; reduceOnly?: boolean; newClientOrderId?: string }> = [];
  leverageCalls: Array<{ symbol: string; leverage: number }> = [];
  failOnSymbol: string | null = null;
  fillPriceBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  positionAmtBySymbol = new Map<string, number>();
  /** What queryOrder reports for a symbol when polled — simulates the exchange confirming a fill
   *  that the initial placeOrder response returned as avgPrice=0. Unset ⇒ stays unconfirmed (NEW). */
  queryOrderAvgPriceBySymbol = new Map<string, number>();
  queryOrderCallCount = 0;
  private orderSeq = 100;

  /** [BUG 3 test support] When set for a symbol, a FILLED order (avgPrice>0) reports this
   *  executedQty instead of the full requested quantity — simulates a genuine partial MARKET fill
   *  (thin liquidity / volatility spike) on either an entry or an exit leg. */
  partialFillQtyBySymbol = new Map<string, number>();

  private buildOrder(symbol: string, side: string, quantity: number, reduceOnly: boolean | undefined, orderId: string, avgPrice: number): FuturesOrder {
    const partial = this.partialFillQtyBySymbol.get(symbol);
    const executedQty = avgPrice > 0 ? (partial !== undefined ? Math.min(partial, quantity) : quantity) : 0;
    return {
      symbol,
      orderId,
      clientOrderId: "",
      status: avgPrice > 0 ? "FILLED" : "NEW",
      type: "MARKET",
      side: side === "SELL" ? "SELL" : "BUY",
      reduceOnly: Boolean(reduceOnly),
      price: 0,
      stopPrice: 0,
      origQty: quantity,
      executedQty,
      avgPrice,
      updateTime: 0,
    };
  }

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    const f = (stepSize: number, minQty: number): FuturesSymbolFilters =>
      ({ stepSize, minQty, tickSize: 0.0001, minNotional: 5 } as unknown as FuturesSymbolFilters);
    return new Map([
      ["SOLUSDT", f(0.01, 0.01)],
      ["ADAUSDT", f(1, 1)],
      ["DOGEUSDT", f(1, 1)],
      ["RNDRUSDT", f(0.1, 0.1)],
    ]);
  }
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.leverageCalls.push({ symbol, leverage });
  }
  async getPositions(): Promise<FuturesPosition[]> {
    const symbols = new Set([...this.markPriceBySymbol.keys(), ...this.positionAmtBySymbol.keys()]);
    return Array.from(symbols).map((symbol) => ({
      symbol,
      positionAmt: this.positionAmtBySymbol.get(symbol) ?? 0,
      entryPrice: 0,
      markPrice: this.markPriceBySymbol.get(symbol) ?? 0,
      liquidationPrice: 0,
      unRealizedProfit: 0,
      leverage: 3,
      marginType: "ISOLATED",
    }));
  }
  /** Symbols where a reduceOnly order gets Binance's -2022 (netted account position has the
   *  opposite sign, e.g. a sibling basket holds a bigger opposite leg on the same symbol). */
  rejectReduceOnlyOn = new Set<string>();
  /** [BUG 1 test support] When >0, the NEXT that many reduceOnly MARKET orders throw a
   *  transient (non -2022) error instead of filling — simulates a Binance/network blip during a
   *  basket-open-abort's flatten attempt (or an orphaned-leg retry). Decremented on each throw. */
  failNextReduceOnlyOrders = 0;
  /** [2026-08-04 exposure-reservation test support] Symbol whose ENTRY (non-reduceOnly) placeOrder
   *  throws an UNAMBIGUOUS BinanceFuturesPrivateError (failureType "binance_error") — distinct from
   *  `failOnSymbol` above, which throws a plain, ambiguous Error (simulating a network/timeout
   *  failure where whether the order reached the exchange is genuinely unknown). */
  failOnSymbolWithBinanceError: string | null = null;
  async placeOrder(params: { symbol: string; side: string; quantity: number; reduceOnly?: boolean; newClientOrderId?: string }) {
    if (this.failOnSymbolWithBinanceError === params.symbol && !params.reduceOnly) {
      throw new BinanceFuturesPrivateError("binance_error", `Binance error HTTP 400 code -2019: Margin is insufficient.`, {
        httpStatus: 400,
        binanceCode: -2019,
      });
    }
    if (this.failOnSymbol === params.symbol && !params.reduceOnly) throw new Error(`exchange rejected ${params.symbol}`);
    if (params.reduceOnly && this.rejectReduceOnlyOn.has(params.symbol)) {
      throw new Error("Binance error HTTP 400 code -2022: ReduceOnly Order is rejected.");
    }
    if (params.reduceOnly && this.failNextReduceOnlyOrders > 0) {
      this.failNextReduceOnlyOrders -= 1;
      throw new Error("fake transient network error during flatten");
    }
    this.placed.push(params);
    const orderId = String(this.orderSeq++);
    const avgPrice = this.fillPriceBySymbol.get(params.symbol) ?? 0;
    return this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, orderId, avgPrice);
  }
  async queryOrder(symbol: string, orderId: string) {
    this.queryOrderCallCount++;
    const avgPrice = this.queryOrderAvgPriceBySymbol.get(symbol) ?? 0;
    return this.buildOrder(symbol, "BUY", 0, false, orderId, avgPrice);
  }
  /** [FEE-RECORDING, 2026-07-12 fix] real per-order commissions closeBasket now prefers over the
   *  flat TAKER_FEE_RATE estimate. Map value = commission per trade; every placed order for the
   *  symbol gets one trade entry. Empty (default) ⇒ closeBasket falls back to the estimate. */
  commissionPerTradeBySymbol = new Map<string, number>();

  /** [RESTART-RECOVERY test support] Per-clientOrderId scripted response for queryOrderByClientId,
   *  keyed by the exact clientOrderId string — lets a test simulate "this leg's pre-crash order
   *  really did fill", "really never reached the exchange" (via a thrown -2013), or any other
   *  order-status shape. Unconfigured ⇒ queryOrderByClientId throws (simulating "not wired" is done
   *  by simply not calling this at all — see the dedicated unwired-client test below); configuring
   *  an explicit NEW/no-executedQty response is how a test simulates INCONCLUSIVE. */
  queryOrderByClientIdResponses = new Map<string, FuturesOrder | (() => FuturesOrder)>();
  /** When true, EVERY queryOrderByClientId call throws a plain (non-Binance) network-style error,
   *  regardless of queryOrderByClientIdResponses — simulates the reconciliation query ITSELF being
   *  unreachable (a distinct INCONCLUSIVE cause from "asked, got an ambiguous answer"). */
  queryOrderByClientIdNetworkError = false;
  queryOrderByClientIdCallCount = 0;
  async queryOrderByClientId(symbol: string, origClientOrderId: string): Promise<FuturesOrder> {
    this.queryOrderByClientIdCallCount++;
    if (this.queryOrderByClientIdNetworkError) throw new Error("fake network error querying by clientOrderId");
    const scripted = this.queryOrderByClientIdResponses.get(origClientOrderId);
    if (scripted) return typeof scripted === "function" ? scripted() : scripted;
    // Unconfigured ⇒ Binance's real "order does not exist" shape (-2013) — the same NOT_PLACED
    // signal a clientOrderId that genuinely never reached the exchange would produce.
    throw new BinanceFuturesPrivateError("binance_error", "Binance error HTTP 400 code -2013: Order does not exist.", {
      httpStatus: 400,
      binanceCode: -2013,
    });
  }

  async getUserTrades(symbol: string): Promise<Array<{ orderId: string; price: number; qty: number; realizedPnl: number; commission: number; commissionAsset: string; time: number }>> {
    const commission = this.commissionPerTradeBySymbol.get(symbol);
    if (commission === undefined) return [];
    return this.placed
      .map((p, i) => ({ p, orderId: String(100 + i) }))
      .filter(({ p }) => p.symbol === symbol)
      .map(({ p, orderId }) => ({
        orderId,
        price: this.fillPriceBySymbol.get(symbol) ?? 0,
        qty: p.quantity,
        realizedPnl: 0,
        commission,
        commissionAsset: "USDT",
        time: 0,
      }));
  }
}

function makeExecutor(opts: { client?: FakeExecClient; allowed?: boolean; laneWeightPct?: number; rawLaneWeightPct?: number; cortexRealAttribution?: CortexRealAttributionStore; laneId?: string; signalMs?: number; dailyMaxLossUsd?: number; entryHealthAllowed?: boolean; siblingOpenLegs?: () => Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }>; existingNotionalForSymbol?: (symbol: string) => number; maxNotionalPerSymbolAcrossLanes?: number; respectSignalRiskGeometry?: boolean;
  reserveExposure?: (req: { executorId: string; symbol: string; direction: "LONG" | "SHORT"; requestedNotionalUsd: number; clientOrderId: string; basketId?: string }) => { ok: boolean; reservationId: string | null; reason?: string };
  commitExposureReservation?: (reservationId: string, filled: { qty: number; avgPrice: number }) => void;
  releaseExposureReservation?: (reservationId: string, reason: string) => void;
} = {}) {
  const client = opts.client ?? new FakeExecClient();
  const signalStore = new CrossSectionalStore(tmpDir());
  const storeDir = tmpDir();
  const store = new CrossSectionalExecutorStore(storeDir);
  // Executor watermark starts at construction time; backdate it so our test signal is "new".
  store.getState().lastSeenSignalMs = NOW_MS - 3_600_000;
  if (opts.signalMs !== undefined) signalStore.add(signalObs(opts.signalMs));
  const executor = new CrossSectionalExecutor({
    client,
    signalStore,
    store,
    isAllowed: () => opts.allowed ?? true,
    laneWeightPct: () => opts.laneWeightPct ?? 100,
    ...(opts.rawLaneWeightPct !== undefined ? { rawLaneWeightPct: () => opts.rawLaneWeightPct! } : {}),
    ...(opts.cortexRealAttribution !== undefined ? { cortexRealAttribution: opts.cortexRealAttribution } : {}),
    ...(opts.laneId !== undefined ? { laneId: opts.laneId } : {}),
    nowIso: () => NOW,
    fillConfirmRetryDelayMs: 0,
    // Injected (not process.env) — env mutation in tests leaks across vitest worker threads.
    ...(opts.dailyMaxLossUsd !== undefined ? { dailyMaxLossUsd: () => opts.dailyMaxLossUsd! } : {}),
    ...(opts.entryHealthAllowed !== undefined
      ? { entryHealthGate: () => ({ allowed: opts.entryHealthAllowed!, reason: opts.entryHealthAllowed ? null : "rolling edge negative" }) }
      : {}),
    ...(opts.siblingOpenLegs !== undefined ? { siblingOpenLegs: opts.siblingOpenLegs } : {}),
    ...(opts.existingNotionalForSymbol !== undefined ? { existingNotionalForSymbol: opts.existingNotionalForSymbol } : {}),
    ...(opts.maxNotionalPerSymbolAcrossLanes !== undefined
      ? { maxNotionalPerSymbolAcrossLanes: () => opts.maxNotionalPerSymbolAcrossLanes! }
      : {}),
    ...(opts.respectSignalRiskGeometry !== undefined
      ? { respectSignalRiskGeometry: opts.respectSignalRiskGeometry }
      : {}),
    ...(opts.reserveExposure ? { reserveExposure: opts.reserveExposure } : {}),
    ...(opts.commitExposureReservation ? { commitExposureReservation: opts.commitExposureReservation } : {}),
    ...(opts.releaseExposureReservation ? { releaseExposureReservation: opts.releaseExposureReservation } : {}),
  });
  return { executor, client, signalStore, store, storeDir };
}

/** Same minimal reserve/commit/release stand-in as single-symbol-lane-executor.test.ts's own
 *  makeFakeReservationLedger — verifies WIRING, not the coordinator's own capacity math (see
 *  account-exposure-coordinator.test.ts's 45 tests for that). */
function makeFakeReservationLedger() {
  const reservations = new Map<
    string,
    {
      status: "RESERVED" | "COMMITTED" | "RELEASED";
      req: { executorId: string; symbol: string; direction: "LONG" | "SHORT"; requestedNotionalUsd: number; clientOrderId: string; basketId?: string };
      committed?: { qty: number; avgPrice: number };
      releaseReason?: string;
    }
  >();
  let seq = 0;
  let forceRejectOnSymbol: string | null = null;
  return {
    reservations,
    forceReserveRejectionOnSymbol(symbol: string) {
      forceRejectOnSymbol = symbol;
    },
    reserveExposure: (req: { executorId: string; symbol: string; direction: "LONG" | "SHORT"; requestedNotionalUsd: number; clientOrderId: string; basketId?: string }) => {
      if (forceRejectOnSymbol !== null && req.symbol === forceRejectOnSymbol) {
        return { ok: false, reservationId: null, reason: `${req.symbol}: forced test rejection` };
      }
      const reservationId = `res-${++seq}`;
      reservations.set(reservationId, { status: "RESERVED", req });
      return { ok: true, reservationId };
    },
    commitExposureReservation: (reservationId: string, filled: { qty: number; avgPrice: number }) => {
      const r = reservations.get(reservationId);
      if (!r || r.status !== "RESERVED") return;
      r.status = "COMMITTED";
      r.committed = filled;
    },
    releaseExposureReservation: (reservationId: string, reason: string) => {
      const r = reservations.get(reservationId);
      if (!r || r.status !== "RESERVED") return;
      r.status = "RELEASED";
      r.releaseReason = reason;
    },
  };
}

describe("CrossSectionalExecutor — account-exposure reservation wiring (2026-08-04)", () => {
  it("reserves both legs upfront (same basketId, per-leg clientOrderId matching what placeOrder submits) and commits each from its actual fill", async () => {
    const ledger = makeFakeReservationLedger();
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 101); // differs from the signal's refPrice (100)
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({
      client,
      signalMs: NOW_MS - 5 * 60_000,
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("COMPLETE"); // fully filled, healthy — "OPEN" before the richer enum
    expect(ledger.reservations.size).toBe(2);
    const bySymbol = new Map([...ledger.reservations.values()].map((r) => [r.req.symbol, r]));
    const sol = bySymbol.get("SOLUSDT")!;
    const doge = bySymbol.get("DOGEUSDT")!;
    expect(sol.status).toBe("COMMITTED");
    expect(doge.status).toBe("COMMITTED");
    expect(sol.req.direction).toBe("LONG");
    expect(doge.req.direction).toBe("SHORT");
    expect(sol.req.basketId).toBe(basket.basketId);
    expect(doge.req.basketId).toBe(basket.basketId);
    expect(sol.committed!.avgPrice).toBe(101);
    expect(doge.committed!.avgPrice).toBe(0.1);
    // The reconciliation join key: each leg's reservation clientOrderId is the EXACT string
    // submitted to placeOrder for that same leg — not merely a similarly-shaped one.
    const solOrder = client.placed.find((p) => p.symbol === "SOLUSDT")!;
    const dogeOrder = client.placed.find((p) => p.symbol === "DOGEUSDT")!;
    expect(solOrder.newClientOrderId).toBe(sol.req.clientOrderId);
    expect(dogeOrder.newClientOrderId).toBe(doge.req.clientOrderId);
  });

  it("a rejected reservation on the SECOND leg releases the FIRST leg's already-taken reservation and opens no orders at all", async () => {
    const ledger = makeFakeReservationLedger();
    ledger.forceReserveRejectionOnSymbol("DOGEUSDT"); // the SHORT leg, sized second
    const client = new FakeExecClient();
    const { executor, store } = makeExecutor({
      client,
      signalMs: NOW_MS - 5 * 60_000,
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(client.placed).toHaveLength(0); // hedge integrity: neither leg fires
    expect(store.getState().baskets).toHaveLength(0); // never even reached the basket-push step
    expect(ledger.reservations.size).toBe(1); // only SOLUSDT's reservation was ever created
    const sol = [...ledger.reservations.values()][0]!;
    expect(sol.req.symbol).toBe("SOLUSDT");
    expect(sol.status).toBe("RELEASED");
    expect(sol.releaseReason).toBe("SIBLING_LEG_RESERVE_FAILED:DOGEUSDT: forced test rejection");
  });

  it("[AMBIGUOUS FAILURE] leaves the failed leg's reservation RESERVED (not released) when placeOrder throws a plain, non-Binance error", async () => {
    // Same fixture as the [BUG 1] orphaned-leg suite above: SOL (long, sized/reserved first) opens,
    // DOGE (short) throws a plain Error — genuinely ambiguous whether it reached the exchange.
    const ledger = makeFakeReservationLedger();
    const client = new FakeExecClient();
    client.failOnSymbol = "DOGEUSDT";
    const { executor, store } = makeExecutor({
      client,
      signalMs: NOW_MS - 5 * 60_000,
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(store.getState().baskets[0]!.status).toBe("ABORTED");
    expect(ledger.reservations.size).toBe(2);
    const bySymbol = new Map([...ledger.reservations.values()].map((r) => [r.req.symbol, r]));
    // SOL genuinely filled — its reservation is already COMMITTED and must stay that way.
    expect(bySymbol.get("SOLUSDT")!.status).toBe("COMMITTED");
    // DOGE's failure is AMBIGUOUS (a plain Error, not an unambiguous Binance in-band rejection) —
    // releasing it here would recreate the exact race this coordinator exists to close if the order
    // actually reached the exchange. It must stay RESERVED for the periodic staleness sweep.
    expect(bySymbol.get("DOGEUSDT")!.status).toBe("RESERVED");
  });

  it("[UNAMBIGUOUS REJECTION] releases the failed leg's reservation when placeOrder throws a real Binance in-band rejection", async () => {
    const ledger = makeFakeReservationLedger();
    const client = new FakeExecClient();
    client.failOnSymbolWithBinanceError = "DOGEUSDT";
    const { executor, store } = makeExecutor({
      client,
      signalMs: NOW_MS - 5 * 60_000,
      reserveExposure: ledger.reserveExposure,
      commitExposureReservation: ledger.commitExposureReservation,
      releaseExposureReservation: ledger.releaseExposureReservation,
    });

    await executor.tick();

    expect(store.getState().baskets[0]!.status).toBe("ABORTED");
    const bySymbol = new Map([...ledger.reservations.values()].map((r) => [r.req.symbol, r]));
    expect(bySymbol.get("SOLUSDT")!.status).toBe("COMMITTED");
    const doge = bySymbol.get("DOGEUSDT")!;
    expect(doge.status).toBe("RELEASED");
    expect(doge.releaseReason).toMatch(/^ENTRY_FAILED:/);
  });

  it("defaults to a no-op coordinator when reserveExposure/commit/release are omitted — existing behavior is byte-for-byte unaffected", async () => {
    const { executor, store, client } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    expect(store.getState().baskets[0]!.status).toBe("COMPLETE");
    expect(client.placed).toHaveLength(2);
  });
});

describe("cross-sectional executor (basket execution, testnet-first)", () => {
  it("supports an explicit first-boot watermark while preserving the default replay guard", () => {
    const initialWatermark = NOW_MS - 60 * 60_000;
    const store = new CrossSectionalExecutorStore(tmpDir(), "innovation.json", initialWatermark);
    expect(store.getState().lastSeenSignalMs).toBe(initialWatermark);
  });

  it("opens the FULL hedged basket from a fresh FILTERED signal (long buy + short sell, sized per leg USD)", async () => {
    const { executor, client, store } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("COMPLETE"); // fully filled, healthy — "OPEN" before the richer enum
    expect(basket.legs.length).toBe(2);
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    const doge = basket.legs.find((l) => l.symbol === "DOGEUSDT")!;
    expect(sol.side).toBe("LONG");
    expect(doge.side).toBe("SHORT");
    // default 25 USD/leg: SOL 25/100=0.25 (step 0.01), DOGE 25/0.1=250 (step 1)
    expect(sol.qty).toBeCloseTo(0.25, 9);
    expect(doge.qty).toBeCloseTo(250, 9);
    expect(client.placed.map((p) => p.side)).toEqual(["BUY", "SELL"]);
    expect(client.leverageCalls).toEqual([
      { symbol: "SOLUSDT", leverage: 3 },
      { symbol: "DOGEUSDT", leverage: 3 },
    ]);
    // Watermark advanced — a second tick does NOT reopen the same signal.
    await executor.tick();
    expect(store.getState().baskets.length).toBe(1);
    expect(client.leverageCalls).toEqual([
      { symbol: "SOLUSDT", leverage: 3 },
      { symbol: "DOGEUSDT", leverage: 3 },
      { symbol: "SOLUSDT", leverage: 3 },
      { symbol: "DOGEUSDT", leverage: 3 },
    ]);
  });

  it("honors an innovation basket's own stop without changing the default executor geometry", async () => {
    const { executor, client, signalStore, store } = makeExecutor({
      signalMs: NOW_MS - 5 * 60_000,
      respectSignalRiskGeometry: true,
    });
    signalStore.all[0]!.takeProfitReturn = null;
    signalStore.all[0]!.stopLossReturn = 0.001;
    await executor.tick();
    expect(store.getState().baskets[0]!.status).toBe("COMPLETE");

    client.markPriceBySymbol.set("SOLUSDT", 99.8);
    client.markPriceBySymbol.set("DOGEUSDT", 0.1002);
    await executor.tick();

    expect(store.getState().baskets[0]!.status).toBe("CLOSED");
    expect(store.getState().baskets[0]!.closeReason).toBe("SIGNAL_STOP");
  });

  it("skips stale signals (older than the freshness window)", async () => {
    const { executor, store } = makeExecutor({ signalMs: NOW_MS - 60 * 60_000 });
    await executor.tick();
    expect(store.getState().baskets.length).toBe(0);
  });

  it("does nothing when not allowed (mainnet disarmed gate)", async () => {
    const { executor, store } = makeExecutor({ allowed: false, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    expect(store.getState().baskets.length).toBe(0);
  });

  it("rolling entry-health gate blocks a new basket and exposes the reason", async () => {
    const { executor, store } = makeExecutor({ entryHealthAllowed: false, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    expect(store.getState().baskets.length).toBe(0);
    expect(executor.getStatus()).toMatchObject({ allowed: false, openHalted: "rolling edge negative" });
  });

  // ── 2026-08-04 fail-closed innovation campaign control ────────────────────────────────────
  // The campaign gate (innovation-campaign.ts) is wired ONLY into entryHealthGate/isAllowed at
  // app.ts's 3 basket-executor construction sites — never into retryOrphanedLegFlattens/
  // closeBasketsHittingProfitTarget/closeDueBaskets/ensureOpenBasketLeverage, and never into the
  // outer construction gate. These two tests are the load-bearing proof that holds: an
  // absent/expired/disabled campaign (entryHealthGate blocked, same as the "rolling entry-health
  // gate" test above but standing in for a campaign rejection) can only ever block a NEW basket,
  // never the closing of a basket that is already OPEN and due.
  describe("[FAIL-CLOSED CAMPAIGN] position management/closing continues even with no active innovation campaign", () => {
    function directBasket(basketId: string, symbol: string, closesAtMs: number): ExecutorBasket {
      // Deliberately duplicated from the "[BUG 2]" describe block's own local helper below rather
      // than lifted to module scope — keeps this addition's diff isolated to its own test block.
      return {
        basketId,
        sourceObservationId: `manual:${basketId}`,
        signal: "MOM24_FILTERED",
        variant: "FILTERED",
        openedAt: NOW,
        closesAtMs,
        legs: [
          {
            symbol,
            side: "LONG",
            qty: 10,
            entryPrice: 1,
            entryOrderId: `entry-${basketId}`,
            entryPriceConfirmed: true,
            exitPrice: null,
            exitOrderId: null,
            exitPriceConfirmed: null,
          },
        ],
        // Fully-filled, healthy, ready-to-close basket — "OPEN" before the richer status enum;
        // pushed straight into the store's in-memory state (no _load()/migration involved), so it
        // must already be a valid CURRENT-enum value for closeDueBaskets' COMPLETE-only gate to see
        // it at all. See the dedicated legacy-migration test below for the on-disk "OPEN" → COMPLETE
        // upgrade path this helper deliberately does NOT exercise.
        status: "COMPLETE",
        closedAt: null,
        closeReason: null,
        grossPnlUsd: null,
        feeEstimateUsd: null,
        netPnlUsd: null,
      };
    }

    it("closeDueBaskets still closes an already-OPEN basket when entryHealthGate blocks new baskets (no active campaign)", async () => {
      const { executor, store, client } = makeExecutor({ entryHealthAllowed: false });
      client.fillPriceBySymbol.set("RNDRUSDT", 1.05);
      store.getState().baskets.push(directBasket("xb-nocamp", "RNDRUSDT", NOW_MS - 60_000));
      store.save();

      await executor.tick();

      const basket = store.getState().baskets.find((b) => b.basketId === "xb-nocamp")!;
      expect(basket.status).toBe("CLOSED");
      // The campaign gate itself is still doing its job — NEW baskets stay blocked throughout.
      expect(executor.getStatus()).toMatchObject({ allowed: false });
    });

    it("[RESTART] a freshly constructed executor (simulating a process restart) still loads and closes an already-OPEN basket from disk even though isAllowed()/entryHealthGate both reflect 'no active campaign' from the very first tick", async () => {
      const storeDir = tmpDir();
      const fileName = "restart-campaign.json";

      // "Process A": a basket opens (directly seeded here) and is persisted; the process ends.
      const store1 = new CrossSectionalExecutorStore(storeDir, fileName);
      store1.getState().baskets.push(directBasket("xb-restart", "RNDRUSDT", NOW_MS - 60_000));
      store1.save();

      // "Process B" (restart): a BRAND NEW store instance re-reads the SAME directory/file — this
      // is exactly what app.ts's construction gate does on every process start, unconditionally,
      // regardless of campaign state (see innovation-campaign.ts's module doc comment and the
      // outer `if (liveEngine && isInnovationTestnetExecutionEnabled(...))` gate in app.ts, which
      // this design never touches).
      const store2 = new CrossSectionalExecutorStore(storeDir, fileName);
      expect(store2.getState().baskets.find((b) => b.basketId === "xb-restart")?.status).toBe("COMPLETE");

      const client2 = new FakeExecClient();
      client2.fillPriceBySymbol.set("RNDRUSDT", 1.05);
      const signalStore2 = new CrossSectionalStore(tmpDir());
      const executor2 = new CrossSectionalExecutor({
        client: client2,
        signalStore: signalStore2,
        store: store2,
        isAllowed: () => false, // no active campaign — the ONLY gate this design ever touches
        entryHealthGate: () => ({ allowed: false, reason: "no active innovation campaign" }),
        nowIso: () => NOW,
        fillConfirmRetryDelayMs: 0,
      });

      await executor2.tick();

      const basket = store2.getState().baskets.find((b) => b.basketId === "xb-restart")!;
      expect(basket.status).toBe("CLOSED"); // position management survives the restart, campaign or no campaign
    });
  });

  it("scales leg size by the operator lane allocation weight", async () => {
    const { executor, store } = makeExecutor({ laneWeightPct: 40, signalMs: NOW_MS - 5 * 60_000 });
    expect(executor.getStatus()).toMatchObject({
      legUsd: 10,
      baseLegUsd: 25,
      allocationWeightPct: 40,
    });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.legs.find((l) => l.symbol === "SOLUSDT")?.qty).toBeCloseTo(0.1, 9);
    expect(basket.legs.find((l) => l.symbol === "DOGEUSDT")?.qty).toBeCloseTo(100, 9);
  });

  // 2026-07-10 fix: isCrossSectionalAllocationIndependent() was defined 2026-07-07 (doc comment:
  // "cross-sectional is the FOUNDATION strategy and must run at full size regardless of the
  // lane-allocation selector") but never actually consulted — the foundation lane's leg size was
  // silently scaled by the directional-slot allocation weight anyway (live-confirmed: 80% weight
  // -> $20 legUsd instead of the documented $25 full size).
  it("CROSS_SECTIONAL_ALLOCATION_INDEPENDENT=1: the foundation lane ignores its allocation weight and stays full size", async () => {
    process.env.CROSS_SECTIONAL_ALLOCATION_INDEPENDENT = "1";
    try {
      const { executor, store } = makeExecutor({ laneWeightPct: 40, signalMs: NOW_MS - 5 * 60_000 });
      expect(executor.getStatus()).toMatchObject({ legUsd: 25, baseLegUsd: 25, allocationWeightPct: 100 });
      await executor.tick();
      const basket = store.getState().baskets[0]!;
      expect(basket.legs.find((l) => l.symbol === "SOLUSDT")?.qty).toBeCloseTo(0.25, 9);
      expect(basket.legs.find((l) => l.symbol === "DOGEUSDT")?.qty).toBeCloseTo(250, 9);
    } finally {
      delete process.env.CROSS_SECTIONAL_ALLOCATION_INDEPENDENT;
    }
  });

  it("CROSS_SECTIONAL_ALLOCATION_INDEPENDENT=1: a non-foundation instance (CROSS_SECTIONAL_TREND) still scales normally", async () => {
    process.env.CROSS_SECTIONAL_ALLOCATION_INDEPENDENT = "1";
    try {
      const { executor, store } = makeExecutor({ laneWeightPct: 40, laneId: CROSS_SECTIONAL_TREND_LANE_ID, signalMs: NOW_MS - 5 * 60_000 });
      expect(executor.getStatus()).toMatchObject({ legUsd: 10, baseLegUsd: 25, allocationWeightPct: 40 });
      await executor.tick();
      const basket = store.getState().baskets[0]!;
      expect(basket.legs.find((l) => l.symbol === "SOLUSDT")?.qty).toBeCloseTo(0.1, 9);
      expect(basket.legs.find((l) => l.symbol === "DOGEUSDT")?.qty).toBeCloseTo(100, 9);
    } finally {
      delete process.env.CROSS_SECTIONAL_ALLOCATION_INDEPENDENT;
    }
  });

  it("trusts FILTERED signals already emitted by the research feed instead of re-blocking with stale env lists", async () => {
    const { executor, signalStore, store, client } = makeExecutor();
    const signal = signalObs(NOW_MS - 5 * 60_000);
    // The research feed already applied its adaptive filter when it wrote the signal.
    // The executor must not re-check against today's static env allowlist, which can
    // be stale and block every currently-valid short leg.
    signal.shortLeg = [{ symbol: "RNDRUSDT", entryPrice: 10, exitPrice: null }];
    signalStore.add(signal);
    await executor.tick();
    expect(store.getState().baskets.length).toBe(1);
    expect(client.placed.some((order) => order.symbol === "RNDRUSDT" && order.side === "SELL")).toBe(true);
  });

  it("HEDGE INTEGRITY: a failed leg aborts the basket and flattens already-opened legs", async () => {
    const client = new FakeExecClient();
    client.failOnSymbol = "DOGEUSDT"; // long opens, short fails
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("ABORTED");
    expect(basket.closeReason).toMatch(/OPEN_FAILED/);
    // The opened SOL long was flattened with a reduce-only SELL.
    const flatten = client.placed.find((p) => p.symbol === "SOLUSDT" && p.reduceOnly);
    expect(flatten).toBeTruthy();
    expect(flatten!.side).toBe("SELL");
  });

  describe("2026-07-21 CRITICAL fix: basket-open persistence survives a crash mid-loop", () => {
    // Root cause of the confirmed 2026-07-18 testnet incident: a real, exchange-filled leg (WIFUSDT)
    // vanished from ALL bookkeeping — not in baskets, not in orphanedLegs — because the basket only
    // ever reached st.baskets on the loop's SUCCESS or ABORT path. A process crash between one leg's
    // placeOrder confirming filled and either of those two points left a real position with zero
    // record anywhere, and the watermark (already advanced before any leg was placed) meant the
    // signal was never retried either. These tests prove each leg is now durably persisted the
    // MOMENT it fills, independent of whether the loop or its abort handler ever finish.

    it("persists the basket (status OPEN, empty legs) to disk BEFORE the first leg's order is even placed", async () => {
      const client = new FakeExecClient();
      client.fillPriceBySymbol.set("SOLUSDT", 100);
      client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
      const { executor, store, storeDir } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
      let sawEmptyOpenBasketBeforeAnyFill = false;
      const originalSetLeverage = client.setLeverage.bind(client);
      client.setLeverage = async (symbol, leverage) => {
        // setLeverage is called before EVERY leg's placeOrder — checking on the very first call
        // (SOLUSDT) proves the basket was written to disk before any order at all went out.
        if (symbol === "SOLUSDT") {
          const freshStore = new CrossSectionalExecutorStore(storeDir);
          const basket = freshStore.getState().baskets[0];
          // "PLACING", not "OPEN" — status flips from RESERVED to PLACING the instant the FIRST
          // leg's attempt begins (before setLeverage/placeOrder), which is exactly this checkpoint.
          // A stronger, more precise assertion than the old single-status "OPEN" allowed for.
          sawEmptyOpenBasketBeforeAnyFill =
            basket !== undefined && basket.status === "PLACING" && basket.legs.length === 0;
        }
        return originalSetLeverage(symbol, leverage);
      };
      await executor.tick();
      expect(sawEmptyOpenBasketBeforeAnyFill).toBe(true);
    });

    it("persists a filled leg to disk immediately — before the NEXT leg's order is placed, surviving a simulated crash mid-loop", async () => {
      const client = new FakeExecClient();
      client.fillPriceBySymbol.set("SOLUSDT", 100);
      client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
      const { executor, store, storeDir } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
      let sawPersistedAfterFirstLeg = false;
      const originalPlaceOrder = client.placeOrder.bind(client);
      client.placeOrder = async (params) => {
        if (params.symbol === "DOGEUSDT" && !params.reduceOnly) {
          // Re-read from a FRESH store instance pointed at the same directory — simulating exactly
          // what a restarted process would see if it crashed right here, between the SOL leg's fill
          // and the DOGE leg's order going out.
          const freshStore = new CrossSectionalExecutorStore(storeDir);
          const basket = freshStore.getState().baskets[0];
          // "PARTIALLY_FILLED", not "OPEN" — SOL already filled (legs.length===1) flips the basket
          // straight to PARTIALLY_FILLED and it STAYS there through every subsequent leg attempt
          // (the per-attempt granularity for leg 1+ lives on plan[i].status, not a second basket-
          // level PLACING re-entry) — a stronger, more precise assertion than "OPEN" allowed for.
          sawPersistedAfterFirstLeg =
            basket !== undefined &&
            basket.status === "PARTIALLY_FILLED" &&
            basket.legs.length === 1 &&
            basket.legs[0]!.symbol === "SOLUSDT" &&
            basket.legs[0]!.entryOrderId !== null;
        }
        return originalPlaceOrder(params);
      };
      await executor.tick();
      expect(sawPersistedAfterFirstLeg).toBe(true);
      // Sanity: the basket did go on to complete normally — this isn't just testing a fixture quirk.
      expect(store.getState().baskets[0]!.status).toBe("COMPLETE");
      expect(store.getState().baskets[0]!.legs.length).toBe(2);
    });

    it("a fully successful basket-open is recorded exactly once (no duplicate push from the old success-path push+the new upfront push)", async () => {
      const client = new FakeExecClient();
      client.fillPriceBySymbol.set("SOLUSDT", 100);
      client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
      const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
      await executor.tick();
      expect(store.getState().baskets.length).toBe(1);
    });

    it("an ABORTED basket (failed leg) is recorded exactly once (no duplicate push from the old abort-path push+the new upfront push)", async () => {
      const client = new FakeExecClient();
      client.failOnSymbol = "DOGEUSDT";
      const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
      await executor.tick();
      expect(store.getState().baskets.length).toBe(1);
      expect(store.getState().baskets[0]!.status).toBe("ABORTED");
    });
  });

  it("closes the basket at horizon with reduce-only orders and honest net PnL", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100); // entry fills
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    // Move past the horizon and set exit fills: SOL +2% (long wins), DOGE -1% (short wins).
    client.fillPriceBySymbol.set("SOLUSDT", 102);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.099);
    const basket = store.getState().baskets[0]!;
    basket.closesAtMs = NOW_MS - 1; // due now
    await executor.tick();
    expect(basket.status).toBe("CLOSED");
    expect(basket.closeReason).toBe("HORIZON");
    // gross = 0.25*(102-100) + 250*(0.1-0.099) = 0.5 + 0.25 = 0.75
    expect(basket.grossPnlUsd).toBeCloseTo(0.75, 6);
    expect(basket.feeEstimateUsd!).toBeGreaterThan(0);
    expect(basket.netPnlUsd!).toBeLessThan(basket.grossPnlUsd!);
    const closes = client.placed.filter((p) => p.reduceOnly);
    expect(closes.length).toBe(2);
  });

  // [2026-07-22 bug-hunt fix]: CROSS_SECTIONAL_MARKET_NEUTRAL/TREND/MIXED are full
  // CORTEX_LANE_ROSTER members whose real sizing already responds to CORTEX's tilt, but a
  // closed basket was never recorded into cortex-real-attribution.ts's ledger at all — not
  // reported as $0, simply never written. This is the first test that actually exercises the
  // wiring end to end.
  it("[CORTEX-ATTRIBUTION] closeBasket records the CORTEX real-USDT attribution when wired, capturing the open-time tilt", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const cortexRealAttribution = new CortexRealAttributionStore(tmpDir());
    const { executor, store } = makeExecutor({
      client,
      signalMs: NOW_MS - 5 * 60_000,
      laneWeightPct: 50, // applied (CORTEX-tilted): 50%
      rawLaneWeightPct: 20, // operator's untouched table weight: 20%
      cortexRealAttribution,
    });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.cortexAppliedWeightPct).toBe(50);
    expect(basket.cortexRawStaticWeightPct).toBe(20);
    client.fillPriceBySymbol.set("SOLUSDT", 102);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.099);
    basket.closesAtMs = NOW_MS - 1;
    await executor.tick();
    expect(basket.status).toBe("CLOSED");
    const records = cortexRealAttribution.getState().records;
    expect(records.length).toBe(1);
    const rec = records[0]!;
    expect(rec.recordId).toBe(`xsec:${rec.laneId}:${basket.basketId}`);
    expect(rec.appliedWeightPct).toBe(50);
    expect(rec.rawStaticWeightPct).toBe(20);
    expect(rec.realizedPnlUsd).toBeCloseTo(basket.netPnlUsd!, 9);
    // tiltShare = (applied-raw)/applied = (50-20)/50 = 0.6, cortexUsd = realizedPnlUsd * 0.6
    expect(rec.tiltShare).toBeCloseTo(0.6, 9);
    expect(rec.cortexUsd).toBeCloseTo(basket.netPnlUsd! * 0.6, 9);
  });

  it("[CORTEX-ATTRIBUTION] without cortexRealAttribution wired, closeBasket records nothing (byte-identical to pre-fix behavior)", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    client.fillPriceBySymbol.set("SOLUSDT", 102);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.099);
    basket.closesAtMs = NOW_MS - 1;
    await expect(executor.tick()).resolves.not.toThrow();
    expect(basket.status).toBe("CLOSED");
  });

  // [FEE-RECORDING, 2026-07-12 fix]: closeBasket previously ALWAYS recorded the flat
  // notionalTouched × TAKER_FEE_RATE estimate even though the real per-order commissions were
  // one getUserTrades call away — the exchange-truth audit found commissions were 68.7% of the
  // account's all-time loss while every internal fee report undercounted them.
  it("[FEE-RECORDING] closeBasket records REAL commissions from getUserTrades when available, estimate only as fallback", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    // Real commission of $0.05 per trade on both symbols: 2 entry + 2 exit trades = $0.20 total.
    client.commissionPerTradeBySymbol.set("SOLUSDT", 0.05);
    client.commissionPerTradeBySymbol.set("DOGEUSDT", 0.05);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    basket.closesAtMs = NOW_MS - 1;
    await executor.tick();
    expect(basket.status).toBe("CLOSED");
    // Real sum (4 × $0.05 = $0.20), NOT the notional-based estimate.
    expect(basket.feeEstimateUsd).toBeCloseTo(0.2, 9);
    expect(basket.netPnlUsd).toBeCloseTo(basket.grossPnlUsd! - 0.2, 9);
  });

  // [OOM-FIX-2] lastNetReturn used to only ever be stamped by the periodic mark-price check
  // (closeBasketsHittingProfitTarget) — once a basket closes at HORIZON with real exit fills, that
  // stamp could be left stuck at a stale sign from before the close. Confirmed live: a basket
  // settled a real +$0.73 (positive) win but its stored lastNetReturn still showed -0.13% from an
  // earlier mark-price check.
  it("[OOM-FIX-2] lastNetReturn is recomputed from FINAL exit fills at close, correcting a stale pre-close mark-price sign", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;

    // Pre-close mark-price check shows a LOSS (stays OPEN, below threshold either way) — stamps
    // lastNetReturn negative, same as the existing TP-GAP stamping behavior.
    client.markPriceBySymbol.set("SOLUSDT", 99); // SOL long down 1%
    client.markPriceBySymbol.set("DOGEUSDT", 0.1); // DOGE short flat
    await executor.tick();
    expect(basket.status).toBe("COMPLETE");
    expect(basket.lastNetReturn!).toBeLessThan(0); // stale negative stamp, pre-close

    // Now the basket actually closes at horizon with REAL fills showing a WIN (SOL +2%, DOGE -1%,
    // same move as "closes the basket at horizon... honest net PnL" above).
    client.fillPriceBySymbol.set("SOLUSDT", 102);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.099);
    basket.closesAtMs = NOW_MS - 1;
    await executor.tick();

    expect(basket.status).toBe("CLOSED");
    expect(basket.closeReason).toBe("HORIZON");
    expect(basket.netPnlUsd!).toBeGreaterThan(0); // real settled win
    expect(basket.lastNetReturn!).toBeGreaterThan(0); // corrected to match — no longer stuck negative
    expect(basket.lastNetAt).toBe(basket.closedAt); // re-stamped at the moment of settlement
  });

  it("PROFIT BANK: closes early, before horizon, once live net return crosses the threshold", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("COMPLETE");

    // SOL long +4%, DOGE short flat: gross = 0.04/2 + 0/2 = 0.02; net = 0.02 - 0.0012 = 0.0188 >= 0.006 default.
    client.markPriceBySymbol.set("SOLUSDT", 104);
    client.markPriceBySymbol.set("DOGEUSDT", 0.1);
    client.fillPriceBySymbol.set("SOLUSDT", 104); // exit fill price on the actual reduce-only close
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    // Still hours from horizon — only the live-return check should trigger this, not closeDueBaskets.
    expect(basket.closesAtMs).toBeGreaterThan(NOW_MS);
    await executor.tick();

    expect(basket.status).toBe("CLOSED");
    expect(basket.closeReason).toBe("PROFIT_BANK");
    expect(basket.netPnlUsd!).toBeGreaterThan(0);
    const closes = client.placed.filter((p) => p.reduceOnly);
    expect(closes.length).toBe(2);
  });

  it("PROFIT BANK: stays open when live net return is below the threshold", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;

    // SOL long +0.5%, DOGE short flat: gross = 0.005/2 = 0.0025; net = 0.0025 - 0.0012 = 0.0013 < 0.006.
    client.markPriceBySymbol.set("SOLUSDT", 100.5);
    client.markPriceBySymbol.set("DOGEUSDT", 0.1);
    await executor.tick();

    expect(basket.status).toBe("COMPLETE");
  });

  it("PROFIT BANK: never forces a decision on incomplete mark-price data (one leg missing)", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;

    // SOL alone would clear the threshold, but DOGE's mark price is missing entirely.
    client.markPriceBySymbol.set("SOLUSDT", 110);
    await executor.tick();

    expect(basket.status).toBe("COMPLETE");
  });

  it("PROFIT BANK: respects CROSS_SECTIONAL_EXEC_TP_NET_RETURN override", async () => {
    process.env.CROSS_SECTIONAL_EXEC_TP_NET_RETURN = "0.05"; // much higher bar
    try {
      const client = new FakeExecClient();
      client.fillPriceBySymbol.set("SOLUSDT", 100);
      client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
      const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
      await executor.tick();
      const basket = store.getState().baskets[0]!;

      // Same +4%/0% move that cleared the 0.6% default now falls short of the 5% override.
      client.markPriceBySymbol.set("SOLUSDT", 104);
      client.markPriceBySymbol.set("DOGEUSDT", 0.1);
      await executor.tick();

      expect(basket.status).toBe("COMPLETE");
    } finally {
      delete process.env.CROSS_SECTIONAL_EXEC_TP_NET_RETURN;
    }
  });
});

describe("[2026-07-19 real-money audit fix] cross-lane per-symbol notional cap (single-symbol <-> cross-sectional)", () => {
  it("BLOCKS the whole basket this tick when a single-symbol lane already holds notional near the cap on one of the basket's legs' symbols", async () => {
    // Default legUsd=25/leg: SOLUSDT leg = 0.25 * 100 = $25. A single-symbol lane already holding
    // $230 on SOLUSDT would push combined exposure to $255 > $250 cap.
    const { executor, store } = makeExecutor({
      signalMs: NOW_MS - 5 * 60_000,
      existingNotionalForSymbol: (symbol) => (symbol === "SOLUSDT" ? 230 : 0),
      maxNotionalPerSymbolAcrossLanes: 250,
    });
    await executor.tick();
    // Hedge-integrity design constraint (see module doc comment): the basket does not open AT ALL
    // this tick — neither the capped SOLUSDT leg nor its DOGEUSDT hedge partner — rather than
    // silently proceeding with excess same-symbol exposure on SOLUSDT.
    expect(store.getState().baskets.length).toBe(0);
  });

  it("opens the FULL basket, byte-identical to pre-fix behavior, when there is zero competing exposure on either leg's symbol", async () => {
    const { executor, store } = makeExecutor({
      signalMs: NOW_MS - 5 * 60_000,
      existingNotionalForSymbol: () => 0, // no other lane/basket holds anything on either symbol
      maxNotionalPerSymbolAcrossLanes: 250, // cap is live and enforced, just not breached
    });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs.length).toBe(2);
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    const doge = basket.legs.find((l) => l.symbol === "DOGEUSDT")!;
    expect(sol.side).toBe("LONG");
    expect(sol.qty).toBeCloseTo(0.25, 9);
    expect(doge.side).toBe("SHORT");
    expect(doge.qty).toBeCloseTo(250, 9);
  });

  it("with no cap wired at all (default 0, matching every pre-existing test/call site in this file), behaves exactly as before regardless of existingNotionalForSymbol", async () => {
    const { executor, store } = makeExecutor({
      signalMs: NOW_MS - 5 * 60_000,
      existingNotionalForSymbol: () => 999_999, // huge — must NOT matter, cap is 0/off
    });
    await executor.tick();
    expect(store.getState().baskets.length).toBe(1);
  });

  it("[TRANSIENT] a cap-blocked signal's watermark still advances (existing convention for un-sizeable legs) — the NEXT fresh signal is evaluated on its own merits once exposure frees up", async () => {
    let otherLaneNotional = 230; // starts near-capped on SOLUSDT
    const { executor, store, signalStore } = makeExecutor({
      signalMs: NOW_MS - 5 * 60_000,
      existingNotionalForSymbol: (symbol) => (symbol === "SOLUSDT" ? otherLaneNotional : 0),
      maxNotionalPerSymbolAcrossLanes: 250,
    });
    await executor.tick(); // blocked: 230 + 25 > 250
    expect(store.getState().baskets.length).toBe(0);
    otherLaneNotional = 0; // the other lane's SOLUSDT position closed
    signalStore.add(signalObs(NOW_MS - 4 * 60_000)); // a fresh hourly signal, newer than the first
    await executor.tick();
    expect(store.getState().baskets.length).toBe(1); // opens now that the symbol is no longer crowded
  });
});

describe("fill-price confirmation (honest fills, no silent avgPrice=0 masking)", () => {
  it("uses the placeOrder avgPrice directly when it's already non-zero (fast path, no extra queryOrder calls)", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.legs.every((l) => l.entryPriceConfirmed)).toBe(true);
    expect(client.queryOrderCallCount).toBe(0);
  });

  it("confirms via queryOrder retry when placeOrder returns avgPrice=0, and records the REAL confirmed fill (not the reference price)", async () => {
    const client = new FakeExecClient();
    // placeOrder returns avgPrice=0 for both legs (fillPriceBySymbol left unset)...
    // ...but queryOrder confirms the real fill moments later, at a price that DIFFERS from
    // the planned reference price (100 / 0.1) — exactly what was observed on real testnet
    // basket xb-mr2x7s6e, where all 6 legs' placeOrder responses came back avgPrice=0 while
    // queryOrder confirmed real, moved fill prices for every one.
    client.queryOrderAvgPriceBySymbol.set("SOLUSDT", 103.5);
    client.queryOrderAvgPriceBySymbol.set("DOGEUSDT", 0.098);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    const doge = basket.legs.find((l) => l.symbol === "DOGEUSDT")!;
    expect(sol.entryPrice).toBeCloseTo(103.5, 9); // NOT the planned reference price of 100
    expect(sol.entryPriceConfirmed).toBe(true);
    expect(doge.entryPrice).toBeCloseTo(0.098, 9); // NOT the planned reference price of 0.1
    expect(doge.entryPriceConfirmed).toBe(true);
    expect(client.queryOrderCallCount).toBeGreaterThan(0);
  });

  it("marks the fill UNCONFIRMED (never fabricates a fake price) when queryOrder never resolves a real fill after retries", async () => {
    const client = new FakeExecClient();
    // Neither placeOrder nor queryOrder ever return a non-zero avgPrice for SOLUSDT.
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    expect(sol.entryPriceConfirmed).toBe(false); // honestly flagged, not silently trusted
    expect(client.queryOrderCallCount).toBeGreaterThan(0); // it DID try to confirm before giving up
  });

  it("applies the same honest confirmation to exit fills at basket close", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick(); // open with confirmed entry fills
    const basket = store.getState().baskets[0]!;
    basket.closesAtMs = NOW_MS - 1; // due now

    // Exit fills come back unconfirmed from placeOrder, but confirm via queryOrder at a real,
    // moved price — must NOT silently record exitPrice = entryPrice (a fake flat close).
    client.fillPriceBySymbol.delete("SOLUSDT");
    client.fillPriceBySymbol.delete("DOGEUSDT");
    client.queryOrderAvgPriceBySymbol.set("SOLUSDT", 105);
    client.queryOrderAvgPriceBySymbol.set("DOGEUSDT", 0.1);
    await executor.tick();

    expect(basket.status).toBe("CLOSED");
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    expect(sol.exitPrice).toBeCloseTo(105, 9); // real confirmed fill, not entryPrice(100)
    expect(sol.exitPriceConfirmed).toBe(true);
    expect(basket.grossPnlUsd).toBeGreaterThan(0); // reflects the real +5 move, not a fake flat $0
    // 2026-07-19 real-money audit follow-up: avgPrice=0 at the synchronous ACK also means
    // executedQty=0 in the raw order response (both legs closed FULLY, just unconfirmed at ACK
    // time — confirmed moments later via queryOrder above). FAIL-WITHOUT-FIX: before the `> 0`
    // guard on executedQty, this exact scenario spuriously recorded BOTH legs as a 100% shortfall
    // and created bogus orphanedLegs entries for legs that were, in reality, fully and correctly
    // closed — and a retry of that bogus orphan could go on to eat into a SIBLING executor's real
    // position on the same symbol.
    expect(store.getState().orphanedLegs).toHaveLength(0);
  });
});

describe("executor variant targeting", () => {
  it("ignores RAW signals by default (executes only the FILTERED variant)", async () => {
    const client = new FakeExecClient();
    const signalStore = new CrossSectionalStore(resolve(os.tmpdir(), `xsec-exec-${process.pid}-raw`));
    dirs.push(resolve(os.tmpdir(), `xsec-exec-${process.pid}-raw`));
    const store = new CrossSectionalExecutorStore(resolve(os.tmpdir(), `xsec-exec-${process.pid}-raw2`));
    dirs.push(resolve(os.tmpdir(), `xsec-exec-${process.pid}-raw2`));
    store.getState().lastSeenSignalMs = NOW_MS - 3_600_000;
    const raw = signalObs(NOW_MS - 5 * 60_000);
    raw.signal = "MOM24";
    raw.variant = "RAW";
    signalStore.add(raw);
    const executor = new CrossSectionalExecutor({ client, signalStore, store, isAllowed: () => true, nowIso: () => NOW });
    await executor.tick();
    expect(store.getState().baskets.length).toBe(0);
    expect(executor.getStatus().variant).toBe("FILTERED");
  });

  it("opens a signal up to the wider 50-min freshness window (was rejected at 15 min)", async () => {
    const { executor, store } = makeExecutor({ signalMs: NOW_MS - 30 * 60_000 }); // 30 min old
    await executor.tick();
    expect(store.getState().baskets.length).toBe(1); // fresh under the 50-min default
    expect(store.getState().baskets[0]!.status).toBe("COMPLETE");
  });

  it("respects CROSS_SECTIONAL_EXEC_MAX_SIGNAL_AGE_MS override", async () => {
    process.env.CROSS_SECTIONAL_EXEC_MAX_SIGNAL_AGE_MS = String(10 * 60_000);
    try {
      const { executor, store } = makeExecutor({ signalMs: NOW_MS - 30 * 60_000 }); // 30 min > 10 min
      await executor.tick();
      expect(store.getState().baskets.length).toBe(0); // stale under the tighter override
    } finally {
      delete process.env.CROSS_SECTIONAL_EXEC_MAX_SIGNAL_AGE_MS;
    }
  });

  it("opens multiple concurrent baskets when CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS>1 (was locked to 1)", async () => {
    process.env.CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS = "3";
    try {
      const { executor, signalStore, store } = makeExecutor({ signalMs: NOW_MS - 20 * 60_000 });
      await executor.tick();
      expect(store.getState().baskets.filter((b) => b.status === "COMPLETE").length).toBe(1);
      signalStore.add(signalObs(NOW_MS - 3 * 60_000)); // newer than the watermark
      await executor.tick();
      expect(store.getState().baskets.filter((b) => b.status === "COMPLETE").length).toBe(2);
    } finally {
      delete process.env.CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS;
    }
  });

  it("still caps concurrent baskets at MAX_OPEN_BASKETS (default 1)", async () => {
    const { executor, signalStore, store } = makeExecutor({ signalMs: NOW_MS - 20 * 60_000 });
    await executor.tick();
    signalStore.add(signalObs(NOW_MS - 3 * 60_000));
    await executor.tick();
    expect(store.getState().baskets.filter((b) => b.status === "COMPLETE").length).toBe(1);
  });
});

// 2026-07-08 (operator: "wire lane baru ke allocation selection"): CrossSectionalExecutor now
// accepts explicit targetVariant/laneId overrides so app.ts can run SEPARATE executor instances
// for TREND_BETA_VOL/MIXED_MEAN_REVERSION alongside the original FILTERED foundation instance,
// each mirroring its own measured variant instead of all three fighting over the same signal feed.
describe("executor targetVariant/laneId overrides (multi-instance wiring, 2026-07-08)", () => {
  it("with an explicit targetVariant, executes THAT variant's signals and ignores FILTERED", async () => {
    const client = new FakeExecClient();
    const signalStore = new CrossSectionalStore(tmpDir());
    const store = new CrossSectionalExecutorStore(tmpDir());
    store.getState().lastSeenSignalMs = NOW_MS - 3_600_000;
    const filtered = signalObs(NOW_MS - 5 * 60_000);
    filtered.variant = "FILTERED";
    signalStore.add(filtered);
    const trend = signalObs(NOW_MS - 4 * 60_000);
    trend.observationId = "xsec:MOM24:trend";
    trend.variant = "TREND_BETA_VOL";
    signalStore.add(trend);
    const executor = new CrossSectionalExecutor({
      client,
      signalStore,
      store,
      isAllowed: () => true,
      nowIso: () => NOW,
      targetVariant: "TREND_BETA_VOL",
    });
    await executor.tick();
    expect(executor.getStatus().variant).toBe("TREND_BETA_VOL");
    expect(store.getState().baskets.length).toBe(1);
    // The one basket opened must be built from the TREND leg (DOGEUSDT/SOLUSDT are shared fixture
    // legs in both signals here, so the discriminator is that a FILTERED-only executor would have
    // opened on the 5-min-old signal's watermark advance instead — this asserts variant selection,
    // not leg contents).
  });

  it("with an explicit laneId, reports it via getStatus() instead of the shared CROSS_SECTIONAL_MARKET_NEUTRAL default", async () => {
    const { executor: defaultExecutor } = makeExecutor({});
    expect(defaultExecutor.getStatus().laneId).toBe("CROSS_SECTIONAL_MARKET_NEUTRAL");

    const client = new FakeExecClient();
    const signalStore = new CrossSectionalStore(tmpDir());
    const store = new CrossSectionalExecutorStore(tmpDir());
    const executor = new CrossSectionalExecutor({
      client,
      signalStore,
      store,
      isAllowed: () => true,
      nowIso: () => NOW,
      targetVariant: "MIXED_MEAN_REVERSION",
      laneId: "CROSS_SECTIONAL_MIXED",
    });
    expect(executor.getStatus().laneId).toBe("CROSS_SECTIONAL_MIXED");
    expect(executor.getStatus().variant).toBe("MIXED_MEAN_REVERSION");
  });

  it("CrossSectionalExecutorStore with a distinct fileName does not collide with the default store file", () => {
    const makeBasket = (basketId: string): ExecutorBasket => ({
      basketId,
      sourceObservationId: `xsec:MOM24:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [],
      // Zero-leg fixture used purely to test file-path collision — never ticked, so no plan/leg
      // placement logic ever reads this basket at all. RESERVED is the natural "just created,
      // nothing placed yet" state for a legs:[] basket under the richer enum ("OPEN" before it).
      status: "RESERVED",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    const dir = tmpDir();
    const defaultStore = new CrossSectionalExecutorStore(dir);
    defaultStore.getState().baskets.push(makeBasket("default-basket"));
    defaultStore.save();

    const mixedStore = new CrossSectionalExecutorStore(dir, "cross-sectional-executor-mixed.json");
    expect(mixedStore.getState().baskets.length).toBe(0); // fresh state, not the default file's basket
    mixedStore.getState().baskets.push(makeBasket("mixed-basket"));
    mixedStore.save();

    // Re-reading the ORIGINAL default file must still show only its own basket (no cross-write).
    const reread = new CrossSectionalExecutorStore(dir);
    expect(reread.getState().baskets.map((b) => b.basketId)).toEqual(["default-basket"]);
  });
});

// [STATUS-VISIBILITY] 2026-07-07 audit: an executor with zero eligible signals for ~18h was
// completely silent about it — getStatus() reported nothing that would surface a stuck signal
// pipeline or a starved adaptive filter. These fields close that gap.
describe("getStatus signal freshness + adaptive filter visibility", () => {
  it("reports signalAgeMs/signalStale for a fresh matching-variant signal", () => {
    const { executor } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000 }); // 5 min old, FILTERED
    const status = executor.getStatus();
    expect(status.signalAgeMs).toBe(5 * 60_000);
    expect(status.signalMaxAgeMs).toBe(50 * 60_000);
    expect(status.signalStale).toBe(false);
  });

  it("reports signalStale=true when the newest matching signal is older than the freshness window", () => {
    const { executor } = makeExecutor({ signalMs: NOW_MS - 60 * 60_000 }); // 60 min > 50 min default
    const status = executor.getStatus();
    expect(status.signalAgeMs).toBe(60 * 60_000);
    expect(status.signalStale).toBe(true);
  });

  it("reports signalAgeMs=null and signalStale=true when no matching-variant signal exists at all", () => {
    const { executor } = makeExecutor(); // no signal added
    const status = executor.getStatus();
    expect(status.signalAgeMs).toBeNull();
    expect(status.signalStale).toBe(true);
  });

  it("surfaces adaptiveFilters.shortFloorApplied when the signal store's own demotion history would starve the short side", async () => {
    const { executor, signalStore } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000 });
    // Read from the real constant, not a hardcoded snapshot — 2026-07-09 audit widened this list.
    const shortSymbols = [...CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST];
    for (let i = 0; i < 3; i++) {
      signalStore.add({
        observationId: `closed-${i}`,
        openedAt: NOW,
        openedAtMs: NOW_MS - 3_600_000,
        horizonMs: 3_600_000,
        signal: "MOM24",
        variant: "RAW",
        k: shortSymbols.length,
        longLeg: [],
        shortLeg: shortSymbols.map((sym) => ({ symbol: sym, entryPrice: 1, exitPrice: 1.02 })), // rose ⇒ short loses
        status: "CLOSED",
        grossReturn: -0.02, costReturn: 0, netReturn: -0.02, longLegReturn: null, shortLegReturn: -0.02,
        resolvedAt: NOW,
      });
    }
    const status = executor.getStatus();
    expect(status.adaptiveFilters.shortFloorApplied).toBe(true);
    expect(status.adaptiveFilters.demotedShort.sort()).toEqual(shortSymbols.sort());
  });

  it("adaptiveFilters.shortFloorApplied is false when the signal store has no starving demotion history", () => {
    const { executor } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000 });
    expect(executor.getStatus().adaptiveFilters.shortFloorApplied).toBe(false);
    expect(executor.getStatus().adaptiveFilters.longFloorApplied).toBe(false);
  });
});

// [NETTED-CLOSE] 2026-07-07: with overlapping baskets, Binance nets per symbol — a basket long
// SOL while two siblings are short SOL leaves the ACCOUNT net short, so the reduce-only close of
// the long leg gets -2022 and the basket wedges half-closed forever (testnet xb-mr7zdpiz sat
// stuck for hours at +0.63% with the TP unable to complete). closeBasket must drop reduceOnly
// exactly when sibling baskets' un-exited opposite exposure fully covers the leg — and only then.
describe("closeBasket under cross-basket netting", () => {
  function basket(id: string, legs: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; entryPrice: number; exitOrderId?: string | null; exitPrice?: number | null }>, closesAtMs: number) {
    return {
      basketId: id,
      sourceObservationId: `src-${id}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: new Date(NOW_MS - 24 * 3_600_000).toISOString(),
      closesAtMs,
      legs: legs.map((l) => ({
        symbol: l.symbol, side: l.side, qty: l.qty, entryPrice: l.entryPrice,
        entryOrderId: "1", entryPriceConfirmed: true,
        exitPrice: l.exitPrice ?? null, exitOrderId: l.exitOrderId ?? null, exitPriceConfirmed: l.exitOrderId != null ? true : null,
      })),
      // Fully-filled, healthy, ready-to-close basket — "OPEN" before the richer status enum.
      status: "COMPLETE" as const,
      closedAt: null, closeReason: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
    };
  }

  it("[NETTED-CLOSE] drops reduceOnly when sibling baskets fully cover the opposite side", async () => {
    const { executor, client, store } = makeExecutor();
    client.rejectReduceOnlyOn.add("SOLUSDT"); // account is net short — reduce-only SELL would be -2022
    client.fillPriceBySymbol.set("SOLUSDT", 110);
    store.getState().baskets.push(
      basket("a", [{ symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100 }], NOW_MS - 60_000), // due
      basket("b", [{ symbol: "SOLUSDT", side: "SHORT", qty: 2, entryPrice: 100 }], NOW_MS + 3_600_000), // sibling short, stays open
    );
    await executor.tick();
    const a = store.getState().baskets.find((x) => x.basketId === "a")!;
    expect(a.status).toBe("CLOSED");
    const exit = client.placed.find((p) => p.symbol === "SOLUSDT" && p.side === "SELL")!;
    expect(exit.reduceOnly).toBeFalsy(); // the plain-market bookkeeping close
    // (110-100)*1 gross − (100+110)*0.0005 fees
    expect(a.netPnlUsd).toBeCloseTo(10 - 210 * 0.0005, 6);
    expect(store.getState().baskets.find((x) => x.basketId === "b")!.status).toBe("COMPLETE");
  });

  it("[NETTED-CLOSE-GUARD] keeps reduceOnly (and stays OPEN on rejection) when no sibling covers the leg", async () => {
    const { executor, client, store } = makeExecutor();
    client.rejectReduceOnlyOn.add("SOLUSDT");
    client.positionAmtBySymbol.set("SOLUSDT", 1); // exchange still confirms the full same-side leg
    store.getState().baskets.push(
      basket("a", [{ symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100 }], NOW_MS - 60_000),
    );
    await executor.tick();
    const a = store.getState().baskets.find((x) => x.basketId === "a")!;
    expect(a.status).toBe("COMPLETE"); // wedged, surfaced — NOT silently force-closed without the guard
    expect(executor.getStatus().lastError ?? "").toMatch(/ReduceOnly/);
  });

  it("[SIBLING-INSTANCE-CLOSE] 2026-07-11 fix: drops reduceOnly when a SEPARATE executor instance's leg (not one in THIS store) covers the opposite side", async () => {
    // FILTERED/TREND/MIXED are 3 SEPARATE CrossSectionalExecutor instances, each with their OWN
    // store file, on the SAME netted Binance account. Before this fix, siblingOppositeUnexitedQty
    // only ever scanned THIS instance's own store.getState().baskets — a same-symbol opposite-side
    // leg owned by a sibling INSTANCE (not a sibling basket in the same store) was invisible.
    const { executor, client, store } = makeExecutor({
      siblingOpenLegs: () => [{ symbol: "SOLUSDT", side: "SHORT", qty: 2 }], // a TREND/MIXED instance's own leg
    });
    client.rejectReduceOnlyOn.add("SOLUSDT"); // account is net short — reduce-only SELL would be -2022
    client.fillPriceBySymbol.set("SOLUSDT", 110);
    store.getState().baskets.push(
      basket("a", [{ symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100 }], NOW_MS - 60_000), // due
      // Deliberately NO sibling basket in THIS store — the only cover comes from siblingOpenLegs().
    );

    await executor.tick();

    const a = store.getState().baskets.find((x) => x.basketId === "a")!;
    expect(a.status).toBe("CLOSED");
    const exit = client.placed.find((p) => p.symbol === "SOLUSDT" && p.side === "SELL")!;
    expect(exit.reduceOnly).toBeFalsy(); // the plain-market bookkeeping close, justified by the sibling INSTANCE's leg
  });

  it("[STALE-BOOK-RECONCILE] aborts without creating opposite exposure when exchange position is already flat", async () => {
    const { executor, client, store } = makeExecutor();
    client.rejectReduceOnlyOn.add("SOLUSDT");
    client.positionAmtBySymbol.set("SOLUSDT", 0);
    store.getState().baskets.push(
      basket("flat", [{ symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100 }], NOW_MS - 60_000),
    );

    await executor.tick();

    const reconciled = store.getState().baskets.find((x) => x.basketId === "flat")!;
    expect(reconciled.status).toBe("ABORTED");
    expect(reconciled.closeReason).toBe("RECONCILED_POSITION_ALREADY_FLAT:HORIZON");
    expect(reconciled.netPnlUsd).toBeNull(); // no fabricated fill/P&L
    expect(reconciled.legs[0]!.exitOrderId).toBe("POSITION_ALREADY_FLAT");
    expect(client.placed).toHaveLength(0); // critically: no plain SELL that creates a new short
  });

  it("[RETRY-PNL] finalizing after a partial close counts the ALREADY-exited legs' P&L", async () => {
    const { executor, client, store } = makeExecutor();
    client.fillPriceBySymbol.set("ADAUSDT", 0.9);
    store.getState().baskets.push(
      basket("a", [
        // Exited in a previous attempt (stored exit price 108) — must still count in final P&L.
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, exitOrderId: "999", exitPrice: 108 },
        { symbol: "ADAUSDT", side: "SHORT", qty: 10, entryPrice: 1 },
      ], NOW_MS - 60_000),
    );
    await executor.tick();
    const a = store.getState().baskets.find((x) => x.basketId === "a")!;
    expect(a.status).toBe("CLOSED");
    // gross = (108−100)*1 + (1−0.9)*10 = 9; fees = ((100+108)*1 + (1+0.9)*10) * 0.0005 = 0.1135
    expect(a.grossPnlUsd).toBeCloseTo(9, 6);
    expect(a.netPnlUsd).toBeCloseTo(9 - 227 * 0.0005, 6);
  });
});

describe("TP-gap stamping + daily basket loss breaker (safety net, never a profit killer)", () => {
  function openBasket(id: string, legs: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; entryPrice: number }>, closesAtMs: number) {
    return {
      basketId: id,
      sourceObservationId: `src-${id}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: new Date(NOW_MS - 24 * 3_600_000).toISOString(),
      closesAtMs,
      legs: legs.map((l) => ({
        symbol: l.symbol, side: l.side, qty: l.qty, entryPrice: l.entryPrice,
        entryOrderId: "1", entryPriceConfirmed: true,
        exitPrice: null, exitOrderId: null, exitPriceConfirmed: null,
      })),
      // Fully-filled, healthy, ready-to-close basket — "OPEN" before the richer status enum.
      status: "COMPLETE" as const,
      closedAt: null, closeReason: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
    };
  }
  function closedBasket(id: string, closedAt: string, netPnlUsd: number) {
    return {
      basketId: id,
      sourceObservationId: `src-${id}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: new Date(NOW_MS - 24 * 3_600_000).toISOString(),
      closesAtMs: NOW_MS - 3_600_000,
      legs: [],
      status: "CLOSED" as const,
      closedAt, closeReason: "HORIZON", grossPnlUsd: netPnlUsd, feeEstimateUsd: 0, netPnlUsd,
    };
  }

  it("[TP-GAP] stamps lastNetReturn/lastNetAt on every open basket each tick and PERSISTS it (below threshold ⇒ stays OPEN)", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store, storeDir } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick(); // opens the basket
    const basket = store.getState().baskets[0]!;
    expect(basket.lastNetReturn).toBeUndefined(); // nothing stamped yet

    // SOL long +0.5%, DOGE short flat: gross = 0.005/2 = 0.0025; net = 0.0025 − 0.0012 < 0.006 TP.
    client.markPriceBySymbol.set("SOLUSDT", 100.5);
    client.markPriceBySymbol.set("DOGEUSDT", 0.1);
    await executor.tick();

    expect(basket.status).toBe("COMPLETE");
    expect(basket.lastNetReturn).toBeCloseTo(0.0025 - 0.0012, 9);
    expect(basket.lastNetAt).toBe(NOW);
    // The stamp must survive a restart — the dashboard reads it from the persisted store.
    const reloaded = new CrossSectionalExecutorStore(storeDir);
    expect(reloaded.getState().baskets[0]!.lastNetReturn).toBeCloseTo(0.0025 - 0.0012, 9);
  });

  it("[TP-GAP] skips the stamp (never fabricates) when a leg's mark price is missing", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    client.markPriceBySymbol.set("SOLUSDT", 110); // DOGE mark missing entirely
    await executor.tick();
    expect(store.getState().baskets[0]!.lastNetReturn).toBeUndefined();
  });

  it("[BREAKER] halts NEW opens once today's realized basket loss breaches the injected limit", async () => {
    const { executor, client, store } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000, dailyMaxLossUsd: 5 });
    store.getState().baskets.push(closedBasket("loss", NOW, -6));
    await executor.tick();
    expect(store.getState().baskets.filter((b) => b.status === "COMPLETE").length).toBe(0);
    expect(client.placed.length).toBe(0); // not a single entry order reached the exchange
    const status = executor.getStatus();
    expect(status.openHalted).toMatch(/breaker/);
    expect(status.dailyRealizedUsd).toBeCloseTo(-6, 6);
    expect(status.dailyMaxLossUsd).toBe(5);
  });

  it("[BREAKER] open baskets still run their own exits while halted — it only blocks NEW opens", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 90); // due basket exits at a LOSS, so the day stays below the limit
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000, dailyMaxLossUsd: 5 });
    store.getState().baskets.push(
      closedBasket("loss", NOW, -6),
      openBasket("due", [{ symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100 }], NOW_MS - 60_000),
    );
    await executor.tick();
    const due = store.getState().baskets.find((b) => b.basketId === "due")!;
    expect(due.status).toBe("CLOSED"); // horizon exit ran untouched
    expect(due.closeReason).toBe("HORIZON");
    expect(client.placed.filter((p) => !p.reduceOnly).length).toBe(0); // only the exit, no new entries
    expect(executor.getStatus().openHalted).toMatch(/breaker/);
  });

  it("[BREAKER] un-halts BY ITSELF when a later exit recovers the day's realized above the limit", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 110); // due basket banks +9.9, wiping the −6 → breaker clears
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000, dailyMaxLossUsd: 5 });
    store.getState().baskets.push(
      closedBasket("loss", NOW, -6),
      openBasket("due", [{ symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100 }], NOW_MS - 60_000),
    );
    await executor.tick();
    expect(store.getState().baskets.filter((b) => b.status === "COMPLETE").length).toBe(1); // fresh basket opened
    expect(executor.getStatus().openHalted).toBeNull();
  });

  it("[BREAKER] yesterday's losses never halt today (UTC-day scoped) and the halt clears itself", async () => {
    const { executor, store } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000, dailyMaxLossUsd: 5 });
    store.getState().baskets.push(closedBasket("old-loss", "2026-07-01T23:00:00.000Z", -50));
    await executor.tick();
    expect(store.getState().baskets.filter((b) => b.status === "COMPLETE").length).toBe(1); // opened normally
    expect(executor.getStatus().openHalted).toBeNull();
  });

  it("[BREAKER] disabled by default (limit 0): deep losses alone never block opens", async () => {
    const { executor, store } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000, dailyMaxLossUsd: 0 });
    store.getState().baskets.push(closedBasket("loss", NOW, -500));
    await executor.tick();
    expect(store.getState().baskets.filter((b) => b.status === "COMPLETE").length).toBe(1);
    expect(executor.getStatus().openHalted).toBeNull();
  });
});

// ── 2026-07-19 real-money audit fix (BUG 1) ─────────────────────────────────
describe("[BUG 1] orphaned-leg tracking + retry when a basket-open abort's flatten ALSO fails", () => {
  it("tracks the still-open leg, surfaces it in getStatus, and self-heals via automatic retry on the next tick", async () => {
    const client = new FakeExecClient();
    client.failOnSymbol = "DOGEUSDT"; // long (SOL) opens, short (DOGE) fails -> basket aborts
    client.failNextReduceOnlyOrders = 1; // the abort handler's OWN flatten of the SOL long ALSO fails once
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();

    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("ABORTED");
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    // FAIL-WITHOUT-FIX: before the fix, this leg silently fell out of ALL bookkeeping the moment
    // the abort-flatten attempt itself threw — nothing tracked it, nothing retried it, and it
    // stayed a real, open, un-flattened position on the exchange with no recovery path.
    expect(sol.exitOrderId).toBeNull(); // still open on the exchange, never flattened

    expect(store.getState().orphanedLegs).toHaveLength(1);
    expect(store.getState().orphanedLegs[0]).toMatchObject({
      basketId: basket.basketId,
      symbol: "SOLUSDT",
      side: "LONG",
      qty: sol.qty,
      attempts: 1,
    });

    const status = executor.getStatus();
    expect(status.orphanedLegs).toHaveLength(1);
    expect(status.orphanedLegs[0]).toMatchObject({ symbol: "SOLUSDT", side: "LONG" });

    // FIX: the very next tick automatically retries the flatten — no operator action required,
    // and nothing about the ABORTED basket's own state stopped this retry from happening.
    await executor.tick();

    expect(store.getState().orphanedLegs).toHaveLength(0);
    expect(sol.exitOrderId).not.toBeNull(); // real fill recorded on the ORIGINAL basket leg
    expect(sol.exitOrderId).not.toBe("POSITION_ALREADY_FLAT"); // a genuine flatten fill, not a reconciliation
    expect(executor.getStatus().orphanedLegs).toHaveLength(0);
  });

  it("keeps retrying (never gives up, never disappears) across multiple consecutive failed retries", async () => {
    const client = new FakeExecClient();
    client.failOnSymbol = "DOGEUSDT";
    client.failNextReduceOnlyOrders = 1; // initial abort-flatten fails
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    expect(store.getState().orphanedLegs).toHaveLength(1);

    client.failNextReduceOnlyOrders = 1; // the retry ALSO fails once more
    await executor.tick();

    const orphan = store.getState().orphanedLegs[0]!;
    expect(orphan.attempts).toBe(2); // tracked, not silently dropped after the first failed retry
    expect(orphan.lastError).toMatch(/transient network error/);

    // Third time's the charm — no more injected failures.
    await executor.tick();
    expect(store.getState().orphanedLegs).toHaveLength(0);
  });

  it("resolves an orphaned leg without fabricating exposure when a retry's reduceOnly rejects because the exchange position is already flat", async () => {
    const client = new FakeExecClient();
    client.failOnSymbol = "DOGEUSDT";
    client.failNextReduceOnlyOrders = 1; // initial abort-flatten fails (transient)
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    expect(store.getState().orphanedLegs).toHaveLength(1);
    // Exactly one non-reduceOnly SOLUSDT order so far: the original entry BUY.
    const nonReduceOnlySolBefore = client.placed.filter((p) => p.symbol === "SOLUSDT" && !p.reduceOnly).length;
    expect(nonReduceOnlySolBefore).toBe(1);

    // Before the retry runs: the exchange no longer carries the SOL long at all (e.g. resolved by
    // some other path) — a plain reduceOnly SELL retry would now CREATE a brand-new short.
    client.rejectReduceOnlyOn.add("SOLUSDT");
    client.positionAmtBySymbol.set("SOLUSDT", 0);
    await executor.tick();

    expect(store.getState().orphanedLegs).toHaveLength(0); // resolved, not retried forever
    const basket = store.getState().baskets[0]!;
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    expect(sol.exitOrderId).toBe("POSITION_ALREADY_FLAT");
    // Critically: the retry never created NEW (non-reduceOnly) exposure to "close" an
    // already-flat position — the count of non-reduceOnly SOLUSDT orders is unchanged.
    expect(client.placed.filter((p) => p.symbol === "SOLUSDT" && !p.reduceOnly).length).toBe(nonReduceOnlySolBefore);
  });
});

// ── 2026-07-19 real-money audit fix (BUG 2) ─────────────────────────────────
describe("[BUG 2] one wedged basket's close failure does not block other due baskets in the same tick", () => {
  function directBasket(basketId: string, symbol: string, closesAtMs: number): ExecutorBasket {
    return {
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs,
      legs: [
        {
          symbol,
          side: "LONG",
          qty: 10,
          entryPrice: 1,
          entryOrderId: `entry-${basketId}`,
          entryPriceConfirmed: true,
          exitPrice: null,
          exitOrderId: null,
          exitPriceConfirmed: null,
        },
      ],
      // Fully-filled, healthy, ready-to-close basket — "OPEN" before the richer status enum.
      status: "COMPLETE",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    };
  }

  it("closeDueBaskets: a persistently-failing basket stays OPEN, a healthy due basket in the SAME tick still closes", async () => {
    const client = new FakeExecClient();
    const { executor, store } = makeExecutor({ client });
    const st = store.getState();
    // Wedged: ADAUSDT's reduceOnly close is rejected (-2022) AND the exchange still genuinely
    // carries the matching LONG position, so it can never reconcile as already-flat — every
    // attempt falls through to a real failure, exactly a persistent margin/rate-limit condition.
    client.rejectReduceOnlyOn.add("ADAUSDT");
    client.positionAmtBySymbol.set("ADAUSDT", 10);
    st.baskets.push(directBasket("xb-wedged", "ADAUSDT", NOW_MS - 60_000));
    // Healthy: RNDRUSDT closes normally.
    client.fillPriceBySymbol.set("RNDRUSDT", 1.05);
    st.baskets.push(directBasket("xb-healthy", "RNDRUSDT", NOW_MS - 60_000));
    store.save();

    await executor.tick();

    const wedged = store.getState().baskets.find((b) => b.basketId === "xb-wedged")!;
    const healthy = store.getState().baskets.find((b) => b.basketId === "xb-healthy")!;
    // FAIL-WITHOUT-FIX: before the fix, closeDueBaskets had no per-basket try/catch, so the
    // wedged basket's thrown error would propagate out of the for-loop and the healthy basket
    // (iterated AFTER it) would never even be attempted this tick.
    expect(wedged.status).toBe("COMPLETE"); // still due, will retry next tick
    expect(healthy.status).toBe("CLOSED"); // NOT blocked by the wedged basket ahead of it
    expect(executor.lastError).toMatch(/ADAUSDT|close incomplete/);
  });

  it("closeBasketsHittingProfitTarget: same isolation for the profit-bank path", async () => {
    const client = new FakeExecClient();
    const { executor, store } = makeExecutor({ client });
    const st = store.getState();
    client.rejectReduceOnlyOn.add("ADAUSDT");
    client.positionAmtBySymbol.set("ADAUSDT", 10);
    client.markPriceBySymbol.set("ADAUSDT", 2); // deep in profit vs entryPrice=1 -> hits TP threshold
    // [TP-MATH FIX interaction] directBasket() builds a single-LEG (LONG-only) basket —
    // closeBasketsHittingProfitTarget now correctly skips a one-sided basket entirely (see the
    // [TP-MATH FIX] describe block above), so this test needs a genuine two-sided basket to still
    // exercise the profit-bank isolation behavior it's actually testing. A flat (zero-return) SHORT
    // hedge leg on a neutral symbol makes both baskets real hedges without changing the arithmetic
    // this test's threshold comparison already relies on (the hedge leg contributes exactly 0%).
    const addFlatHedgeLeg = (b: ExecutorBasket): ExecutorBasket => {
      b.legs.push({
        symbol: "SOLUSDT", side: "SHORT", qty: 1, entryPrice: 100,
        entryOrderId: `hedge-${b.basketId}`, entryPriceConfirmed: true,
        exitPrice: null, exitOrderId: null, exitPriceConfirmed: null,
      });
      return b;
    };
    client.markPriceBySymbol.set("SOLUSDT", 100); // flat — 0% contribution from the hedge leg
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    st.baskets.push(addFlatHedgeLeg(directBasket("xb-wedged-tp", "ADAUSDT", NOW_MS + 3_600_000))); // not yet due by horizon
    client.fillPriceBySymbol.set("RNDRUSDT", 2.05);
    client.markPriceBySymbol.set("RNDRUSDT", 2);
    st.baskets.push(addFlatHedgeLeg(directBasket("xb-healthy-tp", "RNDRUSDT", NOW_MS + 3_600_000)));
    store.save();

    await executor.tick();

    const wedged = store.getState().baskets.find((b) => b.basketId === "xb-wedged-tp")!;
    const healthy = store.getState().baskets.find((b) => b.basketId === "xb-healthy-tp")!;
    expect(wedged.status).toBe("COMPLETE");
    expect(healthy.status).toBe("CLOSED");
  });
});

// ── 2026-07-19 real-money audit fix (BUG 3) ─────────────────────────────────
describe("[BUG 3] a genuine partial MARKET fill is recorded as what actually executed, not the requested qty", () => {
  it("entry leg: a partial fill records the REAL executedQty, not the requested quantity", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    // Determine the FULL requested qty first (no partial fill), then reproduce a genuine partial
    // fill at 40% of that — whatever the executor's real default legUsd/stepSize sizing works out
    // to, rather than guessing a specific notional.
    const probe = makeExecutor({ signalMs: NOW_MS - 5 * 60_000 });
    await probe.executor.tick();
    const requestedQty = probe.store.getState().baskets[0]!.legs.find((l) => l.symbol === "SOLUSDT")!.qty;

    client.partialFillQtyBySymbol.set("SOLUSDT", requestedQty * 0.4); // 40% partial fill
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();

    const basket = store.getState().baskets[0]!;
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    // FAIL-WITHOUT-FIX: before the fix, `qty: planned.qty` always recorded the full requested
    // size regardless of what the exchange actually confirmed via executedQty.
    expect(sol.qty).toBeCloseTo(requestedQty * 0.4, 6);
    expect(sol.qty).not.toBeCloseTo(requestedQty, 6); // sanity: genuinely different from the un-partial-filled qty
  });

  it("exit leg: a partial close fill books only the executed qty and tracks the residual as an orphaned leg", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick(); // opens the basket

    const opened = store.getState().baskets[0]!;
    // Force the basket into its due-for-HORIZON-close window directly (the signal itself stays
    // fresh — only the basket's own closesAtMs is backdated — matching how other tests in this
    // file simulate "already due" without needing to also make the ENTRY signal look stale).
    opened.closesAtMs = NOW_MS - 60_000;
    store.save();
    const solQtyOpened = opened.legs.find((l) => l.symbol === "SOLUSDT")!.qty;

    // Now the CLOSE order on SOLUSDT only partially fills.
    client.partialFillQtyBySymbol.set("SOLUSDT", solQtyOpened * 0.4);
    await executor.tick(); // HORIZON close is due

    const basket = store.getState().baskets.find((b) => b.basketId === opened.basketId)!;
    const sol = basket.legs.find((l) => l.symbol === "SOLUSDT")!;
    // FAIL-WITHOUT-FIX: before the fix, this leg's exitOrderId/exitPrice were set from the
    // partial fill while qty stayed at the FULL original size — silently understating the real,
    // still-open remainder with no tracking or recovery path at all.
    expect(sol.exitOrderId).not.toBeNull(); // the basket's own lifecycle is not blocked
    expect(sol.qty).toBeCloseTo(solQtyOpened * 0.4, 6); // only the executed portion is booked on this leg

    const orphans = store.getState().orphanedLegs;
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ symbol: "SOLUSDT", side: "LONG" });
    expect(orphans[0]!.qty).toBeCloseTo(solQtyOpened * 0.6, 6); // the un-filled remainder, tracked for retry
  });
});

// REGRESSION (2026-07-20 real-money audit fix, round 2): the first pass at exempting the
// allocation-independent basket from the manual-directional gate only swapped canOpenNewEntries()
// for a manual-directional-blind variant, but every isAllowed() branch still ANDed
// laneSelectionAllowsLane()/allowsCrossSectionalLane() — both of which ALSO route through
// effectiveLaneAllocations()'s manual-directional substitution, so a basket that (by design) is
// never listed in either LONG/SHORT array stayed blocked exactly as before the "fix". Adversarial
// review caught this by reading the actual gate composition; this proves it via the pure function.
describe("[2026-07-20 round 2] crossSectionalMarketNeutralIsAllowed genuinely exempts an allocation-independent basket from the lane selector", () => {
  it("REGRESSION: allocation-independent + armed/killed/drain all clear must open even though the basket is NEVER listed in the manual-directional allocation (the exact bug being fixed)", () => {
    const allowed = crossSectionalMarketNeutralIsAllowed({
      allocationIndependent: true,
      canOpenIgnoringManualDirectional: () => true, // armed, not killed, no drain
      canOpenNewEntries: () => true,
      unifiedOrchestratorEnabled: false,
      allowsCrossSectionalLane: () => false, // irrelevant on this branch
      laneSelectionAllowsLane: () => false, // basket never listed on either manual-directional side — the bug
    });
    expect(allowed).toBe(true);
  });

  it("still respects armed/killed/drain when allocation-independent (the exemption is NOT unconditional)", () => {
    const allowed = crossSectionalMarketNeutralIsAllowed({
      allocationIndependent: true,
      canOpenIgnoringManualDirectional: () => false, // e.g. killed, drained, or disarmed
      canOpenNewEntries: () => true,
      unifiedOrchestratorEnabled: false,
      allowsCrossSectionalLane: () => true,
      laneSelectionAllowsLane: () => true,
    });
    expect(allowed).toBe(false);
  });

  it("falls back to the ORIGINAL fully-coupled behavior when allocation-independent is off (unifiedOrchestrator disabled)", () => {
    const blockedByLaneSelector = crossSectionalMarketNeutralIsAllowed({
      allocationIndependent: false,
      canOpenIgnoringManualDirectional: () => true,
      canOpenNewEntries: () => true,
      unifiedOrchestratorEnabled: false,
      allowsCrossSectionalLane: () => true,
      laneSelectionAllowsLane: () => false, // not listed ⇒ correctly blocked when independence is OFF
    });
    expect(blockedByLaneSelector).toBe(false);

    const allowedWhenListed = crossSectionalMarketNeutralIsAllowed({
      allocationIndependent: false,
      canOpenIgnoringManualDirectional: () => true,
      canOpenNewEntries: () => true,
      unifiedOrchestratorEnabled: false,
      allowsCrossSectionalLane: () => true,
      laneSelectionAllowsLane: () => true,
    });
    expect(allowedWhenListed).toBe(true);
  });

  it("falls back to the ORIGINAL fully-coupled behavior when allocation-independent is off (unifiedOrchestrator enabled)", () => {
    const blockedByOrchestrator = crossSectionalMarketNeutralIsAllowed({
      allocationIndependent: false,
      canOpenIgnoringManualDirectional: () => true,
      canOpenNewEntries: () => true,
      unifiedOrchestratorEnabled: true,
      allowsCrossSectionalLane: () => false,
      laneSelectionAllowsLane: () => true, // irrelevant on this branch
    });
    expect(blockedByOrchestrator).toBe(false);
  });

  it("armed/killed/drain still gates the fallback (non-independent) path via canOpenNewEntries", () => {
    const blockedWhileKilled = crossSectionalMarketNeutralIsAllowed({
      allocationIndependent: false,
      canOpenIgnoringManualDirectional: () => true,
      canOpenNewEntries: () => false, // killed/disarmed/drained
      unifiedOrchestratorEnabled: false,
      allowsCrossSectionalLane: () => true,
      laneSelectionAllowsLane: () => true,
    });
    expect(blockedWhileKilled).toBe(false);
  });
});

describe("[2026-07-22 CORTEX capital-coverage diagnosis] isCrossSectionalTrendMixedAdmissionIndependent", () => {
  it("is OFF by default (unset env)", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(isCrossSectionalTrendMixedAdmissionIndependent(env)).toBe(false);
  });

  it("is ON only for the exact string \"1\"", () => {
    expect(isCrossSectionalTrendMixedAdmissionIndependent({ CROSS_SECTIONAL_TREND_MIXED_ADMISSION_INDEPENDENT: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isCrossSectionalTrendMixedAdmissionIndependent({ CROSS_SECTIONAL_TREND_MIXED_ADMISSION_INDEPENDENT: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isCrossSectionalTrendMixedAdmissionIndependent({ CROSS_SECTIONAL_TREND_MIXED_ADMISSION_INDEPENDENT: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is independent of CROSS_SECTIONAL_ALLOCATION_INDEPENDENT — the two flags gate different lanes and must not leak into each other", () => {
    expect(isCrossSectionalTrendMixedAdmissionIndependent({ CROSS_SECTIONAL_ALLOCATION_INDEPENDENT: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

// ── Phase (d): TP-math lopsided-basket fix ──────────────────────────────────
describe("[TP-MATH FIX] closeBasketsHittingProfitTarget skips lopsided (non-two-sided) baskets entirely", () => {
  it("a basket with only LONG legs is never scored or closed via PROFIT_BANK, even with a huge implied gain", async () => {
    const client = new FakeExecClient();
    client.markPriceBySymbol.set("SOLUSDT", 1000); // 10x entry — would trivially clear any real TP bar
    const { executor, store } = makeExecutor({ client });
    store.getState().baskets.push({
      basketId: "xb-lopsided",
      sourceObservationId: "manual:xb-lopsided",
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 3_600_000, // not yet due by horizon — ONLY PROFIT_BANK could touch this
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null },
      ],
      status: "COMPLETE",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store.save();

    await executor.tick();

    const basket = store.getState().baskets.find((b) => b.basketId === "xb-lopsided")!;
    // FAIL-WITHOUT-FIX: the old code defaulted the missing SHORT side's mean return to 0 and still
    // computed/compared a "hedge" return off the single real LONG leg divided by 2 — with markPrice
    // 10x entryPrice this trivially clears the default 0.6% TP and would PROFIT_BANK-close a basket
    // that was never actually hedged, at a fabricated return.
    expect(basket.status).toBe("COMPLETE"); // never closed
    expect(basket.closeReason).toBeNull();
    expect(basket.lastNetReturn).toBeUndefined(); // never even stamped — skipped entirely, not scored
    expect(client.placed.filter((p) => p.reduceOnly)).toHaveLength(0); // no close order ever fired
  });

  it("a basket with only SHORT legs is likewise skipped (both empty-side directions, not just LONG-only)", async () => {
    const client = new FakeExecClient();
    client.markPriceBySymbol.set("DOGEUSDT", 0.001); // huge implied gain for a SHORT if wrongly scored
    const { executor, store } = makeExecutor({ client });
    store.getState().baskets.push({
      basketId: "xb-lopsided-short",
      sourceObservationId: "manual:xb-lopsided-short",
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 3_600_000,
      legs: [
        { symbol: "DOGEUSDT", side: "SHORT", qty: 100, entryPrice: 0.1, entryOrderId: "1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null },
      ],
      status: "COMPLETE",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store.save();

    await executor.tick();

    const basket = store.getState().baskets.find((b) => b.basketId === "xb-lopsided-short")!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.lastNetReturn).toBeUndefined();
    expect(client.placed.filter((p) => p.reduceOnly)).toHaveLength(0);
  });

  it("a genuinely two-sided COMPLETE basket is unaffected by the fix — still scores and PROFIT_BANKs normally", async () => {
    // Guards against an overzealous fix that skips every basket, not just lopsided ones.
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("COMPLETE");

    client.markPriceBySymbol.set("SOLUSDT", 104);
    client.markPriceBySymbol.set("DOGEUSDT", 0.1);
    client.fillPriceBySymbol.set("SOLUSDT", 104);
    await executor.tick();

    expect(basket.status).toBe("CLOSED");
    expect(basket.closeReason).toBe("PROFIT_BANK");
  });
});

// ── Phase (c): restart-recovery — THE CORE GAP this task closes ────────────
describe("[RESTART-RECOVERY] recoverIncompleteBaskets resumes a basket a crash interrupted mid-open", () => {
  /** Seeds a 2-leg (SOL long / DOGE short) basket directly on disk, PARTIALLY_FILLED with SOL
   *  already real, DOGE's plan entry left exactly as a crash would leave it (status PLACING —
   *  "an attempt may have been in flight when the process died"). Returns the dir/fileName so the
   *  caller can construct a "process B" store+executor pointed at the same file — the file's own
   *  established restart-simulation idiom (see the [FAIL-CLOSED CAMPAIGN] > [RESTART] test above). */
  function seedCrashedBasket(dogeEntryClientOrderId: string): { dir: string; fileName: string; basketId: string } {
    const dir = tmpDir();
    const fileName = "restart-recovery.json";
    const basketId = "xb-crash1";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000, // nowhere near due — only recovery should touch this
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-crash1-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: null, entryClientOrderId: dogeEntryClientOrderId, status: "PLACING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    return { dir, fileName, basketId };
  }

  it("[NOT_PLACED] a DOGE order that never reached the exchange is placed fresh exactly once — no duplicate, no stuck basket", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-crash1-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    // queryOrderByClientIdResponses left EMPTY for "xsec-crash1-e1" ⇒ FakeExecClient's default
    // throws Binance's real -2013 "order does not exist" shape ⇒ classified NOT_PLACED.
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs).toHaveLength(2);
    const doge = basket.legs.find((l) => l.symbol === "DOGEUSDT")!;
    expect(doge.entryPriceConfirmed).toBe(true);
    expect(client2.queryOrderByClientIdCallCount).toBe(1); // reconciled BEFORE placing, not blindly
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT" && !p.reduceOnly)).toHaveLength(1); // placed exactly once
  });

  it("[FILLED — 'timeout+fill'] a DOGE order that DID reach the exchange pre-crash is adopted via reconciliation, never re-placed", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-crash1-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.queryOrderByClientIdResponses.set("xsec-crash1-e1", {
      symbol: "DOGEUSDT",
      orderId: "999",
      clientOrderId: "xsec-crash1-e1",
      status: "FILLED",
      type: "MARKET",
      side: "SELL",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 100,
      executedQty: 100,
      avgPrice: 0.1,
      updateTime: 0,
    });
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs).toHaveLength(2);
    const doge = basket.legs.find((l) => l.symbol === "DOGEUSDT")!;
    // Adopted from the QUERY result — the real pre-crash fill — not a freshly-placed order.
    expect(doge.entryOrderId).toBe("999");
    expect(doge.entryPrice).toBe(0.1);
    expect(doge.qty).toBe(100);
    // FAIL-WITHOUT-FIX: without reconciliation, blindly retrying this leg would place a SECOND real
    // order for a leg that already filled — doubling that leg's real exchange exposure.
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0);
  });

  it("[INCONCLUSIVE] a reconciliation query that fails outright never guesses — basket stays exactly as-is and self-heals once the query succeeds", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-crash1-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.queryOrderByClientIdNetworkError = true;
    client2.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    let basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("PARTIALLY_FILLED"); // untouched — never guessed
    expect(basket.legs).toHaveLength(1);
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0);

    // The query stops failing on a later tick — self-heals with NO operator action.
    client2.queryOrderByClientIdNetworkError = false;
    await executor2.tick();

    basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs).toHaveLength(2);
  });

  it("[GATED] never resumes a stuck basket while disarmed (isAllowed()===false) — left exactly as-is", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-crash1-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => false, // disarmed
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("PARTIALLY_FILLED");
    expect(basket.legs).toHaveLength(1);
    expect(client2.placed).toHaveLength(0);
    expect(client2.queryOrderByClientIdCallCount).toBe(0); // never even attempted the reconciliation query
  });

  it("[ABORT] an unambiguous rejection on resume still flattens the already-real SOL leg and aborts cleanly", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-crash1-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.failOnSymbolWithBinanceError = "DOGEUSDT"; // unambiguous — never reached via reconciliation first
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("ABORTED");
    expect(basket.closeReason).toMatch(/OPEN_FAILED/);
    const flatten = client2.placed.find((p) => p.symbol === "SOLUSDT" && p.reduceOnly);
    expect(flatten).toBeTruthy(); // the real, pre-crash SOL leg was flattened, not left dangling
  });
});

// ── Legacy on-disk data predating this task's richer status enum ───────────
describe("[LEGACY MIGRATION] _load() upgrades pre-existing on-disk records to the new status enum", () => {
  it("migrates a legacy OPEN basket WITH real legs into COMPLETE, backfilling a 1:1 plan", () => {
    const dir = tmpDir();
    const fileName = "legacy-migration.json";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    const legacyBasket = {
      basketId: "xb-legacy-open",
      sourceObservationId: "manual:xb-legacy-open",
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null },
        { symbol: "DOGEUSDT", side: "SHORT", qty: 100, entryPrice: 0.1, entryOrderId: "2", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null },
      ],
      status: "OPEN", // legacy — no `plan` field at all, exactly what real pre-existing data looks like
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    };
    store1.getState().baskets.push(legacyBasket as unknown as ExecutorBasket);
    store1.save();

    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const migrated = store2.getState().baskets.find((b) => b.basketId === "xb-legacy-open")!;
    expect(migrated.status).toBe("COMPLETE");
    expect(migrated.plan).toHaveLength(2);
    expect(migrated.plan![0]).toMatchObject({ symbol: "SOLUSDT", side: "LONG", status: "FILLED" });
    expect(migrated.plan![1]).toMatchObject({ symbol: "DOGEUSDT", side: "SHORT", status: "FILLED" });
    // Immediately usable by the normal close paths again — the whole point of the migration.
    expect(migrated.legs).toHaveLength(2);
  });

  it("migrates a legacy OPEN basket with ZERO legs (the exact CORE GAP shape) into ABORTED, never guessing a plan", () => {
    const dir = tmpDir();
    const fileName = "legacy-migration-zero.json";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    const legacyBasket = {
      basketId: "xb-legacy-zero",
      sourceObservationId: "manual:xb-legacy-zero",
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 3_600_000,
      legs: [],
      status: "OPEN",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    };
    store1.getState().baskets.push(legacyBasket as unknown as ExecutorBasket);
    store1.save();

    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const migrated = store2.getState().baskets.find((b) => b.basketId === "xb-legacy-zero")!;
    // No safe way to guess what was intended with zero legs and no plan — terminal, never touched
    // again by any close/recovery path, never silently dropped either.
    expect(migrated.status).toBe("ABORTED");
    expect(migrated.closeReason).toBe("PRE_MIGRATION_UNKNOWN_PLAN");
    expect(migrated.plan).toEqual([]);
  });
});

// ── 2026-08-04 phase: kill/drain recheck, concurrent-close race guard, critical latch, ─────
// ── and the partial-failure hedge-vs-rollback decision (ground truth items (a)-(d)) ─────────
describe("[CRITICAL LATCH] unresolved orphaned exposure blocks new baskets, never exposure reduction", () => {
  it("blocks a new basket while an orphaned leg is unresolved; a separate due basket still closes in the SAME tick", async () => {
    const client = new FakeExecClient();
    client.rejectReduceOnlyOn.add("ADAUSDT"); // this orphan's own retry keeps failing this tick too
    client.positionAmtBySymbol.set("ADAUSDT", 10); // genuinely still open — never reconciles as flat
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    store.getState().orphanedLegs.push({
      basketId: "xb-preexisting-orphan",
      symbol: "ADAUSDT",
      side: "LONG",
      qty: 10,
      entryPrice: 1,
      entryOrderId: "orph-entry-1",
      since: NOW,
      lastAttemptAt: NOW,
      lastError: "prior flatten failure",
      attempts: 1,
    });
    // A separate, healthy, already-due basket in the SAME store — proves exposure reduction is
    // unaffected by the latch.
    client.fillPriceBySymbol.set("RNDRUSDT", 1.05);
    store.getState().baskets.push({
      basketId: "xb-healthy-due",
      sourceObservationId: "manual:xb-healthy-due",
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS - 60_000,
      legs: [
        {
          symbol: "RNDRUSDT", side: "LONG", qty: 1, entryPrice: 1, entryOrderId: "healthy-1",
          entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null,
        },
      ],
      status: "COMPLETE",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store.save();

    await executor.tick();

    // No NEW basket opened despite a fresh, valid signal being available this same tick.
    expect(store.getState().baskets).toHaveLength(1);
    expect(executor.getStatus().openHalted).toMatch(/critical|orphan/i);
    // Exposure reduction unaffected: the healthy due basket still closed this SAME tick.
    const healthy = store.getState().baskets.find((b) => b.basketId === "xb-healthy-due")!;
    expect(healthy.status).toBe("CLOSED");
    // The orphan's own retry is still failing (by design of this test) — the latch stays armed.
    expect(store.getState().orphanedLegs).toHaveLength(1);
  });

  it("self-heals: once the orphaned leg resolves, the SAME tick opens a new basket normally", async () => {
    const client = new FakeExecClient();
    // Resolves cleanly on the very first retry (no injected failure) — same underlying
    // retryOrphanedLegFlattens path as [BUG 1]'s own "self-heals via automatic retry" test.
    client.fillPriceBySymbol.set("ADAUSDT", 1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    store.getState().orphanedLegs.push({
      basketId: "xb-preexisting-orphan-2",
      symbol: "ADAUSDT",
      side: "LONG",
      qty: 10,
      entryPrice: 1,
      entryOrderId: "orph-entry-2",
      since: NOW,
      lastAttemptAt: NOW,
      lastError: "prior flatten failure",
      attempts: 1,
    });
    store.save();

    await executor.tick();

    // retryOrphanedLegFlattens (tick()'s first phase) resolves the orphan BEFORE maybeOpenBasket
    // (a later phase in the same tick) ever runs — the latch is already clear by then, so the
    // fresh signal opens immediately, same-tick, with zero operator action.
    expect(store.getState().orphanedLegs).toHaveLength(0);
    expect(store.getState().baskets).toHaveLength(1);
    expect(store.getState().baskets[0]!.legs.length).toBeGreaterThan(0);
    expect(executor.getStatus().openHalted).toBeNull();
  });
});

describe("[HEDGE-OR-ROLLBACK] partial-failure decision: keep an already-balanced partial hedge, still roll back a one-sided one", () => {
  /** A 3-leg signal (1 long, 2 short) so a failure on the LAST leg leaves the already-filled subset
   *  genuinely balanced (1 long + 1 short) — plan order is every LONG first, then every SHORT (see
   *  maybeOpenBasket's own sizing loop), so this is the minimal shape where "safe to hedge" can
   *  ever be true after a failure. */
  function threeLegSignal(openedAtMs: number): CrossSectionalObservation {
    return {
      observationId: `xsec:MOM24:${openedAtMs}`,
      openedAt: new Date(openedAtMs).toISOString(),
      openedAtMs,
      horizonMs: 24 * 3_600_000,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      k: 1,
      longLeg: [{ symbol: "SOLUSDT", entryPrice: 100, exitPrice: null }],
      shortLeg: [
        { symbol: "DOGEUSDT", entryPrice: 0.1, exitPrice: null },
        { symbol: "RNDRUSDT", entryPrice: 10, exitPrice: null },
      ],
      status: "OPEN",
      grossReturn: null,
      costReturn: null,
      netReturn: null,
      longLegReturn: null,
      shortLegReturn: null,
      resolvedAt: null,
    };
  }

  it("keeps a reduced basket OPEN as a genuine hedge when the failed leg's already-filled siblings span both sides", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    client.failOnSymbol = "RNDRUSDT"; // the THIRD (last) leg — SOL(long) and DOGE(short) already filled
    const signalStore = new CrossSectionalStore(tmpDir());
    signalStore.add(threeLegSignal(NOW_MS - 5 * 60_000));
    const storeDir = tmpDir();
    const store = new CrossSectionalExecutorStore(storeDir);
    store.getState().lastSeenSignalMs = NOW_MS - 3_600_000;
    const executor = new CrossSectionalExecutor({
      client, signalStore, store, isAllowed: () => true, nowIso: () => NOW, fillConfirmRetryDelayMs: 0,
    });

    await executor.tick();

    const basket = store.getState().baskets[0]!;
    // FAIL-WITHOUT-FIX: before this fix, ANY leg failure unconditionally flattened every
    // already-filled leg, even when — as here — they already formed a genuine, balanced hedge.
    expect(basket.status).toBe("COMPLETE"); // kept as a smaller, still-balanced hedge, not aborted
    expect(basket.closedAt).toBeNull();
    expect(basket.legs).toHaveLength(2);
    expect(basket.legs.map((l) => l.symbol).sort()).toEqual(["DOGEUSDT", "SOLUSDT"]);
    // Neither already-open leg was unwound.
    expect(client.placed.filter((p) => p.reduceOnly)).toHaveLength(0);
    // The failed leg is durably marked, never silently retried or guessed at.
    expect(basket.plan![2]).toMatchObject({ symbol: "RNDRUSDT", status: "FAILED" });
    // A COMPLETE basket is outside recoverIncompleteBaskets' RESERVED/PLACING/PARTIALLY_FILLED
    // filter — a later tick must never try to place the abandoned RNDR leg, even once the
    // injected failure is gone (proves this is a genuine "never revisited" outcome, not merely
    // "still failing the same way").
    client.failOnSymbol = null;
    await executor.tick();
    expect(client.placed.filter((p) => p.symbol === "RNDRUSDT")).toHaveLength(0);
    expect(store.getState().baskets).toHaveLength(1);
    expect(store.getState().baskets[0]!.legs).toHaveLength(2);
    expect(store.getState().baskets[0]!.plan![2]).toMatchObject({ symbol: "RNDRUSDT", status: "FAILED" });
  });

  it("still rolls back (flattens) a partial basket that is genuinely one-sided when the failure hits", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.failOnSymbol = "ADAUSDT"; // the SECOND long leg — only SOL(long) has filled so far, zero shorts
    const signal: CrossSectionalObservation = {
      observationId: `xsec:MOM24:${NOW_MS - 5 * 60_000}`,
      openedAt: new Date(NOW_MS - 5 * 60_000).toISOString(),
      openedAtMs: NOW_MS - 5 * 60_000,
      horizonMs: 24 * 3_600_000,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      k: 1,
      longLeg: [
        { symbol: "SOLUSDT", entryPrice: 100, exitPrice: null },
        { symbol: "ADAUSDT", entryPrice: 1, exitPrice: null },
      ],
      shortLeg: [{ symbol: "DOGEUSDT", entryPrice: 0.1, exitPrice: null }],
      status: "OPEN",
      grossReturn: null,
      costReturn: null,
      netReturn: null,
      longLegReturn: null,
      shortLegReturn: null,
      resolvedAt: null,
    };
    const signalStore = new CrossSectionalStore(tmpDir());
    signalStore.add(signal);
    const storeDir = tmpDir();
    const store = new CrossSectionalExecutorStore(storeDir);
    store.getState().lastSeenSignalMs = NOW_MS - 3_600_000;
    const executor = new CrossSectionalExecutor({
      client, signalStore, store, isAllowed: () => true, nowIso: () => NOW, fillConfirmRetryDelayMs: 0,
    });

    await executor.tick();

    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("ABORTED"); // one-sided (SOL long only, zero shorts) — never a hedge
    expect(basket.closeReason).toMatch(/OPEN_FAILED/);
    const flatten = client.placed.find((p) => p.symbol === "SOLUSDT" && p.reduceOnly);
    expect(flatten).toBeTruthy();
    expect(flatten!.side).toBe("SELL");
    expect(basket.plan![2]).toMatchObject({ symbol: "DOGEUSDT", status: "NEVER_ATTEMPTED" });
  });
});

describe("[KILL/DRAIN MID-OPEN] the placement loop rechecks isAllowed() between every leg, not just once before it started", () => {
  it("a kill/drain signal arriving between legs stops the loop, flattens what already filled, marks the rest NEVER_ATTEMPTED", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const testOpts: { client: FakeExecClient; signalMs: number; allowed?: boolean } = {
      client, signalMs: NOW_MS - 5 * 60_000, allowed: true,
    };
    const { executor, store } = makeExecutor(testOpts);
    const originalPlaceOrder = client.placeOrder.bind(client);
    client.placeOrder = async (params) => {
      const result = await originalPlaceOrder(params);
      // Kill/drain fires the instant SOL's (leg 0) entry confirms — before DOGE (leg 1) is ever
      // attempted. `testOpts` is the EXACT object makeExecutor's `isAllowed` closure reads live.
      if (params.symbol === "SOLUSDT" && !params.reduceOnly) testOpts.allowed = false;
      return result;
    };

    await executor.tick();

    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("ABORTED");
    expect(basket.closeReason).toBe("KILL_OR_DRAIN_MID_OPEN");
    expect(basket.legs).toHaveLength(1); // only SOL — DOGE never attempted
    expect(client.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0);
    expect(basket.plan![1]).toMatchObject({ symbol: "DOGEUSDT", status: "NEVER_ATTEMPTED" });
    const flatten = client.placed.find((p) => p.symbol === "SOLUSDT" && p.reduceOnly);
    expect(flatten).toBeTruthy(); // the real SOL leg was rolled back, not left open
  });
});

describe("[CONCURRENT CLOSE RACE] closeAllBasketsOrderly vs. an in-flight placeRemainingLegs on the SAME basket", () => {
  it("racing the LAST leg's placement defers via pendingKillReason — the finishing loop then closes the basket itself, no leg silently dropped, no double-flatten", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    const originalPlaceOrder = client.placeOrder.bind(client);
    let raced = false;
    let raceResult: { closed: number; failed: number } | null = null;
    client.placeOrder = async (params) => {
      if (params.symbol === "DOGEUSDT" && !params.reduceOnly && !raced) {
        raced = true;
        const basketBeforeRace = store.getState().baskets[0]!;
        const legsBeforeRace = basketBeforeRace.legs.length;
        // closeAllBasketsOrderly runs to completion HERE, interleaved, while the outer tick()'s
        // placeRemainingLegs call is suspended awaiting THIS exact placeOrder call.
        raceResult = await executor.closeAllBasketsOrderly("KILL_SWITCH_TEST");
        // The racing close must NOT have mutated the basket while placeRemainingLegs still owned
        // it — ground truth #8's exact failure mode this guard exists to close.
        expect(basketBeforeRace.legs.length).toBe(legsBeforeRace);
        expect(basketBeforeRace.status).not.toBe("CLOSED");
        expect(basketBeforeRace.pendingKillReason).toBe("KILL_SWITCH_TEST");
      }
      return originalPlaceOrder(params);
    };

    await executor.tick();

    const basket = store.getState().baskets[0]!;
    expect(raced).toBe(true);
    expect(raceResult).toMatchObject({ closed: 0, failed: 1 });
    // DOGE's own entry still succeeded (no failure injected this test) — the loop finished
    // normally, THEN noticed pendingKillReason and closed the basket itself.
    expect(basket.status).toBe("CLOSED");
    expect(basket.closeReason).toBe("KILL_SWITCH_TEST");
    expect(basket.legs).toHaveLength(2);
    expect(basket.legs.every((l) => l.exitOrderId !== null)).toBe(true);
    // No double-flatten: exactly one reduceOnly close order per symbol.
    expect(client.placed.filter((p) => p.symbol === "SOLUSDT" && p.reduceOnly)).toHaveLength(1);
    expect(client.placed.filter((p) => p.symbol === "DOGEUSDT" && p.reduceOnly)).toHaveLength(1);
  });

  it("racing the FIRST leg's placement is picked up by the between-legs recheck — the second leg is never even attempted", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    const originalPlaceOrder = client.placeOrder.bind(client);
    let raced = false;
    client.placeOrder = async (params) => {
      const result = await originalPlaceOrder(params);
      if (params.symbol === "SOLUSDT" && !params.reduceOnly && !raced) {
        raced = true;
        await executor.closeAllBasketsOrderly("KILL_SWITCH_TEST_2");
      }
      return result;
    };

    await executor.tick();

    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("ABORTED");
    expect(basket.closeReason).toBe("KILL_SWITCH_TEST_2");
    expect(basket.legs).toHaveLength(1); // only SOL ever filled — DOGE never attempted
    expect(client.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0);
    const flatten = client.placed.find((p) => p.symbol === "SOLUSDT" && p.reduceOnly);
    expect(flatten).toBeTruthy();
  });

  it("a basket NOT currently claimed closes immediately through the ordinary path — the guard never delays an uncontested close", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    const { executor, store } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    expect(store.getState().baskets[0]!.status).toBe("COMPLETE");

    const result = await executor.closeAllBasketsOrderly("KILL_SWITCH_UNCONTESTED");

    expect(result).toMatchObject({ closed: 1, failed: 0 });
    expect(store.getState().baskets[0]!.status).toBe("CLOSED");
    expect(store.getState().baskets[0]!.pendingKillReason).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// [2026-08-04 supplemental] closing the remaining required-scenario gaps for the durable basket
// lifecycle that the sections above don't yet exercise directly: a genuinely PARTIAL fill adopted
// during restart-recovery (as opposed to [BUG 3]'s already-covered LIVE-placement partial fill),
// reconciliation against an explicit STALE terminal exchange status (as opposed to [NOT_PLACED]'s
// default thrown-"order not found" path), REPEATED reconciliation idempotency, a REAL (not
// directly-seeded) rollback/flatten failure driving the critical latch end-to-end, and genuine
// cross-EXECUTOR-TYPE oversubscription prevention via the real AccountExposureCoordinator.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("[RESTART-RECOVERY: PARTIAL FILL] reconciliation adopts a genuinely partial pre-crash fill, not the originally requested qty", () => {
  /** Same seeding shape as the [RESTART-RECOVERY] block above (deliberately duplicated, not
   *  hoisted to module scope — keeps this addition's diff isolated to its own describe block,
   *  matching this file's own established convention, e.g. [FAIL-CLOSED CAMPAIGN]'s directBasket). */
  function seedCrashedBasket(dogeEntryClientOrderId: string): { dir: string; fileName: string; basketId: string } {
    const dir = tmpDir();
    const fileName = "restart-recovery-partial.json";
    const basketId = "xb-crash-partial";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-crashp-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: null, entryClientOrderId: dogeEntryClientOrderId, status: "PLACING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    return { dir, fileName, basketId };
  }

  it("adopts the REAL partial executedQty (40 of the requested 100) from the pre-crash order, not the originally requested qty, and still completes the basket at the smaller size", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-crashp-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    // The pre-crash DOGE order genuinely reached the exchange and genuinely filled — but only
    // PARTIALLY (thin liquidity / volatility spike, the same real-world condition [BUG 3] models
    // for the LIVE placement path). This is DISTINCT from the "[FILLED — 'timeout+fill']" test
    // above, which scripts a FULL fill — this scripts Binance's own PARTIALLY_FILLED status with a
    // genuinely smaller executedQty.
    client2.queryOrderByClientIdResponses.set("xsec-crashp-e1", {
      symbol: "DOGEUSDT",
      orderId: "999",
      clientOrderId: "xsec-crashp-e1",
      status: "PARTIALLY_FILLED",
      type: "MARKET",
      side: "SELL",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 100,
      executedQty: 40,
      avgPrice: 0.1,
      updateTime: 0,
    });
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    const doge = basket.legs.find((l) => l.symbol === "DOGEUSDT")!;
    // FAIL-WITHOUT-FIX (the same class of bug [BUG 3] fixed for the LIVE placement path): adopting
    // the requested qty (100) instead of the REAL partial fill (40) would silently overstate this
    // leg's real exchange exposure by 2.5x.
    expect(doge.qty).toBe(40);
    expect(doge.qty).not.toBe(100);
    expect(doge.entryOrderId).toBe("999");
    // The basket completes at the smaller, REAL size — every planned leg has now resolved (FILLED)
    // — with no further attempt on the unfilled remainder (matching the LIVE entry-leg [BUG 3]
    // convention: a partial MARKET *entry* fill has no "still open on the exchange" remainder to
    // track as an orphan, unlike a partial *exit* fill).
    expect(basket.status).toBe("COMPLETE");
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0); // adopted, never re-placed
    expect(store2.getState().orphanedLegs).toHaveLength(0);
  });
});

describe("[RESTART-RECOVERY: STALE STATE] reconciliation reads an explicit terminal exchange status, not just a thrown 'order not found'", () => {
  function seedCrashedBasket(dogeEntryClientOrderId: string): { dir: string; fileName: string; basketId: string } {
    const dir = tmpDir();
    const fileName = "restart-recovery-stale.json";
    const basketId = "xb-crash-stale";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-stale-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: null, entryClientOrderId: dogeEntryClientOrderId, status: "PLACING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    return { dir, fileName, basketId };
  }

  it("a genuinely stale local 'PLACING' status reconciles against an explicit exchange CANCELED status (not a thrown -2013) and is placed fresh exactly once", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-stale-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    // The pre-crash order genuinely reached the exchange and was explicitly resolved there —
    // canceled, never filled. DISTINCT from the "[NOT_PLACED]" test above, which relies on the
    // client's DEFAULT (unconfigured) response: a THROWN -2013 "order does not exist". This scripts
    // the query to SUCCEED and return a real, explicit terminal status instead — proving
    // reconcilePlannedLeg's own status-string branch (`status === "CANCELED" || ... "EXPIRED" ||
    // "REJECTED"`), not just its catch-block fallback, correctly reads a genuinely stale local
    // expectation against the exchange's real, current record.
    client2.queryOrderByClientIdResponses.set("xsec-stale-e1", {
      symbol: "DOGEUSDT",
      orderId: "998",
      clientOrderId: "xsec-stale-e1",
      status: "CANCELED",
      type: "MARKET",
      side: "SELL",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 100,
      executedQty: 0,
      avgPrice: 0,
      updateTime: 0,
    });
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs).toHaveLength(2);
    const doge = basket.legs.find((l) => l.symbol === "DOGEUSDT")!;
    // Placed FRESH via the ordinary placement path (the stale, canceled pre-crash order is
    // abandoned, never adopted) — a genuinely NEW order id, distinct from the stale order's "998".
    expect(doge.entryOrderId).not.toBe("998");
    expect(client2.queryOrderByClientIdCallCount).toBe(1); // reconciled via the QUERY, not the throw path
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT" && !p.reduceOnly)).toHaveLength(1); // placed exactly once, no duplicate
  });
});

describe("[RESTART-RECOVERY: REPEATED RECONCILIATION] recovery is idempotent once a basket resolves — no duplicate queries, orders, legs, or state changes", () => {
  function seedCrashedBasket(dogeEntryClientOrderId: string): { dir: string; fileName: string; basketId: string } {
    const dir = tmpDir();
    const fileName = "restart-recovery-repeat.json";
    const basketId = "xb-crash-repeat";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-repeat-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: null, entryClientOrderId: dogeEntryClientOrderId, status: "PLACING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    return { dir, fileName, basketId };
  }

  it("ticking again (and a third time) after the basket resolves to COMPLETE re-queries nothing, places nothing new, and leaves the basket exactly as it was", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-repeat-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.queryOrderByClientIdResponses.set("xsec-repeat-e1", {
      symbol: "DOGEUSDT",
      orderId: "997",
      clientOrderId: "xsec-repeat-e1",
      status: "FILLED",
      type: "MARKET",
      side: "SELL",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 100,
      executedQty: 100,
      avgPrice: 0.1,
      updateTime: 0,
    });
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();
    const afterFirst = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(afterFirst.status).toBe("COMPLETE");
    expect(afterFirst.legs).toHaveLength(2);
    expect(client2.queryOrderByClientIdCallCount).toBe(1);

    // Second and third ticks: the basket no longer matches recoverIncompleteBaskets' own
    // RESERVED/PLACING/PARTIALLY_FILLED filter (it's COMPLETE) — nothing should touch it again.
    await executor2.tick();
    await executor2.tick();

    const afterRepeat = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(afterRepeat.status).toBe("COMPLETE");
    expect(afterRepeat.legs).toHaveLength(2); // no duplicate leg
    expect(client2.queryOrderByClientIdCallCount).toBe(1); // never queried again
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0); // never placed at all (adopted, not placed) — and stays that way
    expect(afterRepeat.plan![1]).toMatchObject({ symbol: "DOGEUSDT", status: "FILLED" }); // not re-mutated
    // A COMPLETE basket falling through recoverIncompleteBaskets' own RESERVED/PLACING/
    // PARTIALLY_FILLED filter is silent (no lastError) — if that filter (or the defensive
    // `startIndex >= plan.length` bounds check inside it) were ever broken, a since-resolved plan
    // index reached out of bounds would throw (caught per-basket, surfaced here), not silently
    // no-op — this is the observable signal a mutation check on that guard would flip.
    expect(executor2.getStatus().lastError).toBeNull();
  });
});

describe("[REAL ROLLBACK FAILURE → CRITICAL LATCH] an actual flatten failure (not a directly-seeded fixture) creates the orphan that engages the latch end-to-end", () => {
  it("a genuine abort-flatten failure blocks the NEXT basket-open attempt, a separate healthy basket keeps closing throughout, and the latch self-heals and opens the next signal in the SAME tick the orphan resolves", async () => {
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.failOnSymbol = "DOGEUSDT"; // long opens, short fails -> basket aborts
    client.failNextReduceOnlyOrders = 1; // the abort handler's OWN flatten of the SOL long ALSO fails
    const { executor, store, signalStore } = makeExecutor({ client, signalMs: NOW_MS - 5 * 60_000 });

    // Tick 1: opens SOL, DOGE fails, the abort-rollback's own flatten of SOL ALSO fails — a REAL
    // orphan, created by the SAME code [BUG 1] exercises, not a directly-seeded fixture.
    await executor.tick();
    expect(store.getState().baskets).toHaveLength(1);
    expect(store.getState().baskets[0]!.status).toBe("ABORTED");
    expect(store.getState().orphanedLegs).toHaveLength(1);
    expect(store.getState().orphanedLegs[0]!.symbol).toBe("SOLUSDT");

    // A fresh, newer signal is available for a later tick (same idiom as the "[TRANSIENT]" test).
    signalStore.add(signalObs(NOW_MS - 4 * 60_000));
    // A separate, already-due, healthy basket — proves exposure reduction is unaffected throughout.
    client.fillPriceBySymbol.set("RNDRUSDT", 1.05);
    store.getState().baskets.push({
      basketId: "xb-healthy-during-latch",
      sourceObservationId: "manual:xb-healthy-during-latch",
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS - 60_000,
      legs: [
        { symbol: "RNDRUSDT", side: "LONG", qty: 1, entryPrice: 1, entryOrderId: "healthy-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null },
      ],
      status: "COMPLETE",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store.save();
    expect(store.getState().baskets).toHaveLength(2);

    // Tick 2: the orphan's own retry ALSO fails this tick (latch stays armed) — the fresh signal
    // must NOT open a new basket despite being available, while the healthy basket still closes.
    client.failNextReduceOnlyOrders = 1;
    await executor.tick();
    expect(store.getState().baskets).toHaveLength(2); // no NEW basket opened despite a fresh signal
    expect(store.getState().baskets.find((b) => b.basketId === "xb-healthy-during-latch")!.status).toBe("CLOSED"); // reduction unaffected
    expect(store.getState().orphanedLegs).toHaveLength(1);
    expect(store.getState().orphanedLegs[0]!.attempts).toBe(2); // tracked, not silently dropped
    expect(executor.getStatus().openHalted).toMatch(/critical|orphan/i);

    // Tick 3: the retry now succeeds (no more injected failures) -> the orphan resolves -> the
    // SAME tick's later maybeOpenBasket phase opens the fresh signal normally, zero operator action.
    client.failOnSymbol = null;
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    await executor.tick();

    expect(store.getState().orphanedLegs).toHaveLength(0);
    expect(store.getState().baskets).toHaveLength(3);
    const newest = store.getState().baskets[2]!;
    expect(newest.status).toBe("COMPLETE");
    expect(newest.sourceObservationId.startsWith("xsec:")).toBe(true); // the fresh REAL signal, not another fixture
    expect(executor.getStatus().openHalted).toBeNull();
  });
});

describe("[CONFLICTING SINGLE-SYMBOL EXPOSURE] the shared AccountExposureCoordinator prevents oversubscription between a REAL SingleSymbolLaneExecutor and a CrossSectionalExecutor basket leg on the same symbol", () => {
  function seedSingleSymbolPosition(symbol: string): SingleSymbolPosition {
    return {
      positionId: "ss-1", sourceObservationId: "ss-1", symbol, direction: "LONG",
      qty: 1, entryPrice: 100, entryOrderId: "1", entryPriceConfirmed: true, stopPrice: 90,
      stopAlgoOrderId: "900", stopFailureCount: 0, stopUnprotectedSinceIso: null, closeFailureCount: 0,
      closeFailureSinceIso: null, peakFavorableR: 0, openedAt: NOW, status: "OPEN", closedAt: null,
      closeReason: null, exitPrice: null, exitOrderId: null, exitPriceConfirmed: false,
      grossPnlUsd: null, feeEstimateUsd: 0, netPnlUsd: null,
    };
  }

  it("a real SingleSymbolLaneExecutor's already-open SOLUSDT position blocks the WHOLE basket (hedge integrity) via the real per-symbol cap, and the SAME coordinator allows it once that position closes", async () => {
    // Never actually invoked — this SingleSymbolLaneExecutor is never ticked in this test; only its
    // getStatus().openPositions (read straight off its own store) feeds the coordinator's snapshot,
    // matching account-exposure-coordinator-integration.test.ts's own established idiom.
    const dummySingleSymbolClient: SingleSymbolExecClient = {
      getExchangeFilters: async () => new Map(),
      placeOrder: async () => { throw new Error("not used in this test"); },
      placeAlgoOrder: async () => { throw new Error("not used in this test"); },
      queryAlgoOrder: async () => { throw new Error("not used in this test"); },
      cancelAlgoOrder: async () => {},
      setLeverage: async () => {},
      getPositions: async () => [],
      queryOrder: async () => { throw new Error("not used in this test"); },
      getUserTrades: async () => [],
    };

    const ssStore = new SingleSymbolLaneExecutorStore(tmpDir(), "lane.json");
    ssStore.getState().positions.push(seedSingleSymbolPosition("SOLUSDT"));
    ssStore.save();
    const ssExec = new SingleSymbolLaneExecutor({
      client: dummySingleSymbolClient,
      store: ssStore,
      laneId: "SS_TEST_LANE",
      direction: "LONG",
      getOpenSignals: () => [],
      exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
      isAllowed: () => true,
      laneWeightPct: () => 100,
      legUsd: () => 100,
      leverage: () => 3,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    // SOLUSDT already holds $100 notional (1 × 100) via the real single-symbol executor. Cap $120 —
    // a fresh $25 XSEC SOL leg (0.25 × 100, the default legUsd=25 sizing) would push combined
    // exposure to $125 > $120. Every OTHER capacity axis is explicitly disabled (0) so only the
    // per-symbol cap is exercised — same "explicit 0 unless opted in" discipline
    // account-exposure-coordinator-integration.test.ts's own makeCoordinator() helper uses.
    const reservationStore = new AccountExposureReservationStore(tmpDir());
    const coordinator = new AccountExposureCoordinator({
      store: reservationStore,
      getSingleSymbolExecutors: () => [ssExec],
      getCrossSectionalExecutors: () => [],
      nowIso: () => NOW,
      maxGrossExposureUsd: () => 0,
      maxLongExposureUsd: () => 0,
      maxShortExposureUsd: () => 0,
      maxNotionalPerSymbolUsd: () => 120,
      maxClusterPositions: () => 0,
      maxConcurrentPositionsAcrossAccount: () => 0,
    });

    const client = new FakeExecClient();
    const { executor, store, signalStore } = makeExecutor({
      client,
      signalMs: NOW_MS - 5 * 60_000,
      reserveExposure: coordinator.reserve.bind(coordinator),
      commitExposureReservation: coordinator.commitReservation.bind(coordinator),
      releaseExposureReservation: coordinator.releaseReservation.bind(coordinator),
    });

    await executor.tick();

    // Hedge integrity: the WHOLE basket is blocked, not just the SOL leg — SOL is sized/reserved
    // FIRST (see maybeOpenBasket's LONG-then-SHORT sizing order), so DOGE's reservation is never
    // even attempted once SOL's is rejected by the REAL coordinator's real capacity math.
    expect(store.getState().baskets).toHaveLength(0);
    expect(client.placed).toHaveLength(0);
    expect(reservationStore.getState().reservations).toHaveLength(0); // rejected before insert — no zombie reservation

    // Free the single-symbol lane's REAL position and retry with a fresh signal — proves the SAME
    // coordinator instance genuinely reads LIVE exposure on every call, not a cached/stale snapshot,
    // and that the block is a real function of shared capacity, not a permanent, unconditional deny.
    ssStore.getState().positions[0]!.status = "CLOSED";
    ssStore.getState().positions[0]!.exitOrderId = "closed-manually";
    ssStore.save();
    signalStore.add(signalObs(NOW_MS - 4 * 60_000));

    await executor.tick();

    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs.map((l) => l.symbol).sort()).toEqual(["DOGEUSDT", "SOLUSDT"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// [2026-08-04 review round 1 fix] recoverIncompleteBaskets' ambiguous-leg reconciliation query
// (reconcilePlannedLeg) is a real, awaited exchange round-trip that runs BEFORE placeRemainingLegs
// ever claims the basket (see claimBasket/releaseBasket) — and its own FILLED-adoption directly
// mutates basket.legs/basket.status. A closeAllBasketsOrderly call landing in that exact window
// could previously claim the (still-unclaimed) basket, fully CLOSE it, and then have the
// reconciliation's adoption silently overwrite that CLOSED status back to COMPLETE/PARTIALLY_FILLED
// while pushing a brand-new leg with exitOrderId===null — real exchange exposure the kill-switch
// pass believed it had just closed, left permanently unflattened. Fixed by claiming the basket in
// recoverIncompleteBaskets BEFORE the reconciliation query (see placeRemainingLegsLocked's own doc
// comment) so the two paths can never interleave on the same basket.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("[RESTART-RECOVERY: CONCURRENT CLOSE RACE] closeAllBasketsOrderly vs. an in-flight recoverIncompleteBaskets reconciliation query on the SAME basket", () => {
  /** Same seeding shape as the [RESTART-RECOVERY] block above (deliberately duplicated, not hoisted
   *  to module scope — matches this file's own established convention). */
  function seedCrashedBasket(dogeEntryClientOrderId: string): { dir: string; fileName: string; basketId: string } {
    const dir = tmpDir();
    const fileName = "restart-recovery-close-race.json";
    const basketId = "xb-crash-race";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-crashrace-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: null, entryClientOrderId: dogeEntryClientOrderId, status: "PLACING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    return { dir, fileName, basketId };
  }

  /** Overrides ONLY queryOrderByClientId to suspend on a caller-controlled Promise instead of
   *  resolving synchronously — lets this test force a REAL await-yield exactly where
   *  recoverIncompleteBaskets' reconciliation query sits (a real Binance HTTP round-trip in
   *  production) and run closeAllBasketsOrderly() DURING that yield, the same interleaving idiom
   *  the [CONCURRENT CLOSE RACE] block above uses on a live placeOrder call, applied here to the
   *  reconciliation query instead. */
  class PausableQueryClient extends FakeExecClient {
    pendingQueryResolvers: Array<() => void> = [];
    override async queryOrderByClientId(symbol: string, origClientOrderId: string): Promise<FuturesOrder> {
      await new Promise<void>((res) => this.pendingQueryResolvers.push(res));
      return super.queryOrderByClientId(symbol, origClientOrderId);
    }
  }

  it("a kill-switch firing WHILE the restart-recovery reconciliation query is in flight defers via pendingKillReason instead of racing the adoption — the basket ends up genuinely CLOSED with BOTH legs flattened, never resurrected as COMPLETE/PARTIALLY_FILLED with a naked unflattened leg", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-crashrace-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new PausableQueryClient();
    client2.fillPriceBySymbol.set("SOLUSDT", 100);
    client2.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    client2.queryOrderByClientIdResponses.set("xsec-crashrace-e1", {
      symbol: "DOGEUSDT",
      orderId: "999",
      clientOrderId: "xsec-crashrace-e1",
      status: "FILLED",
      type: "MARKET",
      side: "SELL",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 100,
      executedQty: 100,
      avgPrice: 0.1,
      updateTime: 0,
    });
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    const tickPromise = executor2.tick();

    // Several no-op awaits (retryOrphanedLegFlattens/closeBasketsHittingProfitTarget/
    // closeDueBaskets/ensureOpenBasketLeverage) run before recoverIncompleteBaskets even starts —
    // poll instead of assuming a fixed number of microtask turns.
    for (let i = 0; i < 50 && client2.pendingQueryResolvers.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 0));
    }
    expect(client2.pendingQueryResolvers.length).toBe(1);

    // The kill-switch trips RIGHT NOW — the reconciliation query is suspended, and (post-fix)
    // recoverIncompleteBaskets already claimed this basket before ever issuing that query.
    const raceResult = await executor2.closeAllBasketsOrderly("KILL_SWITCH_CLOSE_RACE");
    // The claim is held by recovery — this call must NOT have touched the basket directly.
    const basketDuringRace = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(raceResult).toMatchObject({ closed: 0, failed: 1 });
    expect(basketDuringRace.status).not.toBe("CLOSED");
    expect(basketDuringRace.pendingKillReason).toBe("KILL_SWITCH_CLOSE_RACE");
    expect(basketDuringRace.legs.every((l) => l.exitOrderId === null)).toBe(true); // nothing flattened yet

    // Let the reconciliation query resolve (the exchange confirms DOGE genuinely filled pre-crash)
    // and let tick() finish.
    client2.pendingQueryResolvers[0]!();
    await tickPromise;

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    // The DOGE fill was correctly adopted (not dropped, not re-placed as a fresh ENTRY) — the only
    // DOGEUSDT placeOrder call in this whole test is the reduceOnly CLOSE asserted below.
    expect(basket.legs).toHaveLength(2);
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT" && !p.reduceOnly)).toHaveLength(0);
    // ...and the deferred kill-switch was then honored via the SAME safe closeBasket path
    // placeRemainingLegsLocked's own pendingKillReason tail uses — genuinely CLOSED, not silently
    // resurrected as COMPLETE/PARTIALLY_FILLED with a naked, unflattened leg.
    expect(basket.status).toBe("CLOSED");
    expect(basket.closeReason).toBe("KILL_SWITCH_CLOSE_RACE");
    expect(basket.pendingKillReason).toBeUndefined();
    expect(basket.legs.every((l) => l.exitOrderId !== null)).toBe(true);
    expect(client2.placed.filter((p) => p.symbol === "SOLUSDT" && p.reduceOnly)).toHaveLength(1);
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT" && p.reduceOnly)).toHaveLength(1);
  });

  it("an UNCONTESTED close (no in-flight recovery) is never delayed by the new claim — closes immediately, same as before this fix", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-crashrace-e1b");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("SOLUSDT", 100);
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    const result = await executor2.closeAllBasketsOrderly("KILL_SWITCH_UNCONTESTED_RACE_POC");

    expect(result).toMatchObject({ closed: 1, failed: 0 });
    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("CLOSED");
    expect(basket.pendingKillReason).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// [2026-08-04 review round 1 fix] hasUnresolvedOrphanedExposure() (the critical latch) was
// consulted ONLY by maybeOpenBasket — recoverIncompleteBaskets could still place a plan entry that
// had NEVER been attempted by any process (a RESERVED basket that crashed before its first leg, or
// any PENDING/just-classified-NOT_PLACED entry) while a real, unaccounted-for orphaned leg sat
// unresolved elsewhere in the SAME store — structurally identical new-risk real-money order
// placement to what the latch exists to block, just reached through a different call path.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("[RESTART-RECOVERY: CRITICAL LATCH] unresolved orphaned exposure also blocks resuming placement on a never-attempted leg, never bookkeeping/adoption", () => {
  function seedOrphan(store: CrossSectionalExecutorStore, basketId: string): void {
    store.getState().orphanedLegs.push({
      basketId,
      symbol: "ADAUSDT",
      side: "LONG",
      qty: 10,
      entryPrice: 1,
      entryOrderId: "orph-entry-1",
      since: NOW,
      lastAttemptAt: NOW,
      lastError: "prior flatten failure",
      attempts: 1,
    });
    store.save();
  }

  it("does NOT place DOGE's never-attempted leg while an unrelated orphan is unresolved — basket left exactly as-is; self-heals and completes once the orphan resolves", async () => {
    const dir = tmpDir();
    const fileName = "restart-recovery-latch.json";
    const basketId = "xb-crash-latch";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      // DOGE's plan entry is "PENDING" — NOT "PLACING" — i.e. no ambiguous pre-crash attempt to
      // reconcile at all; recoverIncompleteBaskets would otherwise go STRAIGHT to placing it fresh.
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-crashlatch-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: null, entryClientOrderId: "xsec-crashlatch-e1", status: "PENDING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    seedOrphan(store1, "xb-unrelated-orphan-source");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    // Orphan's own retry keeps failing this tick — same idiom as [CRITICAL LATCH] above — so the
    // latch stays armed for the first assertion window.
    client2.rejectReduceOnlyOn.add("ADAUSDT");
    client2.positionAmtBySymbol.set("ADAUSDT", 10);
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    // FAIL-WITHOUT-FIX: DOGE's never-attempted leg would have been placed fresh here, going around
    // the critical latch entirely.
    let basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("PARTIALLY_FILLED");
    expect(basket.legs).toHaveLength(1);
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0);
    expect(store2.getState().orphanedLegs).toHaveLength(1); // latch still armed

    // The orphan resolves (its own retry now succeeds) — self-heals with NO operator action, the
    // SAME tick's earlier phase (retryOrphanedLegFlattens) clearing it before recoverIncompleteBaskets
    // ever runs, exactly like maybeOpenBasket's own self-heal story.
    client2.rejectReduceOnlyOn.delete("ADAUSDT");
    client2.positionAmtBySymbol.delete("ADAUSDT");
    await executor2.tick();

    basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(store2.getState().orphanedLegs).toHaveLength(0);
    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs).toHaveLength(2);
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT" && !p.reduceOnly)).toHaveLength(1);
  });

  it("still ADOPTS an already-real pre-crash fill via reconciliation while the orphan is unresolved — bookkeeping is never blocked by this latch", async () => {
    const dir = tmpDir();
    const fileName = "restart-recovery-latch-adopt.json";
    const basketId = "xb-crash-latch-adopt";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-crashlatchadopt-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: null, entryClientOrderId: "xsec-crashlatchadopt-e1", status: "PLACING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    seedOrphan(store1, "xb-unrelated-orphan-source-2");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.rejectReduceOnlyOn.add("ADAUSDT");
    client2.positionAmtBySymbol.set("ADAUSDT", 10);
    client2.queryOrderByClientIdResponses.set("xsec-crashlatchadopt-e1", {
      symbol: "DOGEUSDT",
      orderId: "999",
      clientOrderId: "xsec-crashlatchadopt-e1",
      status: "FILLED",
      type: "MARKET",
      side: "SELL",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 100,
      executedQty: 100,
      avgPrice: 0.1,
      updateTime: 0,
    });
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    await executor2.tick();

    // The DOGE leg genuinely already filled pre-crash — reconciliation adopts it (pure bookkeeping,
    // no NEW order placed) even though the unrelated orphan is still unresolved; the basket
    // completes at its full, real size instead of being needlessly held back.
    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs).toHaveLength(2);
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0); // adopted, never placed
    expect(store2.getState().orphanedLegs).toHaveLength(1); // orphan itself untouched by this basket
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// [2026-08-04 review round 1 fix] closeAllBasketsOrderly can be the VERY FIRST thing to touch a
// crash-persisted basket after a restart — the cross-sectional tick's own first run is deliberately
// delayed 90-150s after process start (see app.ts's setTimeout(execTick, 90_000) and siblings), but
// nothing delays a kill-switch trip, which is driven by an entirely independent, typically
// much-faster-cadence engine tick. If a basket's current plan entry is still "PLACING" (a
// pre-crash placeOrder attempt whose outcome is genuinely ambiguous — see reconcilePlannedLeg) and
// closeAllBasketsOrderly reaches it BEFORE recoverIncompleteBaskets ever gets a chance to reconcile
// that entry, closeBasket() — which only ever iterates basket.legs, never basket.plan — finalizes
// the basket CLOSED without ever querying the exchange for that ambiguous leg. If it genuinely
// filled pre-crash, that fill is now a REAL, naked, unflattened exchange position with NO
// ExecutorLeg ever created for it, on a basket now permanently CLOSED — outside every future
// recovery pass's purview (recoverIncompleteBaskets only ever looks at RESERVED/PLACING/
// PARTIALLY_FILLED baskets) and outside the orphaned-leg retry mechanism (recordOrphanedLeg is only
// ever called on a leg closeBasket/flattenFilledLegs already KNOWS about in basket.legs).
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("[RESTART-RECOVERY: KILL-SWITCH BEFORE FIRST RECOVERY TICK] closeAllBasketsOrderly reconciles an ambiguous PLACING leg before finalizing, instead of silently dropping a genuine pre-crash fill", () => {
  function seedCrashedBasket(dogeEntryClientOrderId: string): { dir: string; fileName: string; basketId: string } {
    const dir = tmpDir();
    const fileName = "restart-recovery-kill-before-recovery.json";
    const basketId = "xb-crash-kill-first";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-killfirst-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: null, entryClientOrderId: dogeEntryClientOrderId, status: "PLACING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    return { dir, fileName, basketId };
  }

  it("a genuinely-filled pre-crash DOGE order is adopted and flattened, not silently left naked, when the kill-switch is the FIRST thing to touch the basket (recovery never ran)", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-killfirst-e1");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("SOLUSDT", 100);
    client2.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    // The pre-crash DOGE order genuinely reached the exchange and genuinely filled.
    client2.queryOrderByClientIdResponses.set("xsec-killfirst-e1", {
      symbol: "DOGEUSDT",
      orderId: "999",
      clientOrderId: "xsec-killfirst-e1",
      status: "FILLED",
      type: "MARKET",
      side: "SELL",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 100,
      executedQty: 100,
      avgPrice: 0.1,
      updateTime: 0,
    });
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    // The kill-switch fires DIRECTLY — executor2.tick() (and therefore recoverIncompleteBaskets)
    // has NEVER run in this process, mirroring the real 90-150s scheduling gap between process
    // start and the cross-sectional tick's own first run.
    const result = await executor2.closeAllBasketsOrderly("KILL_SWITCH_BEFORE_FIRST_TICK");

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(result).toMatchObject({ closed: 1, failed: 0 });
    expect(basket.status).toBe("CLOSED");
    // FAIL-WITHOUT-FIX: the DOGE leg would never be added to basket.legs at all (closeBasket only
    // ever iterates basket.legs, never basket.plan) — its real, genuinely-filled exchange position
    // would be silently un-flattened and un-tracked forever, on a basket already marked CLOSED.
    expect(basket.legs).toHaveLength(2);
    expect(basket.legs.every((l) => l.exitOrderId !== null)).toBe(true);
    const doge = basket.legs.find((l) => l.symbol === "DOGEUSDT")!;
    expect(doge.entryOrderId).toBe("999"); // adopted from the real pre-crash order, not re-placed
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT" && !p.reduceOnly)).toHaveLength(0); // never re-entered
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT" && p.reduceOnly)).toHaveLength(1); // and flattened
  });

  it("a pre-crash DOGE order that never reached the exchange closes cleanly with only SOL flattened — no phantom leg invented", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-killfirst-e1b");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("SOLUSDT", 100);
    // queryOrderByClientIdResponses left EMPTY ⇒ FakeExecClient's default throws Binance's real
    // -2013 "order does not exist" ⇒ classified NOT_PLACED ⇒ nothing to adopt.
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    const result = await executor2.closeAllBasketsOrderly("KILL_SWITCH_BEFORE_FIRST_TICK_2");

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(result).toMatchObject({ closed: 1, failed: 0 });
    expect(basket.status).toBe("CLOSED");
    expect(basket.legs).toHaveLength(1); // DOGE never existed on the exchange — correctly not invented
    expect(basket.legs[0]!.symbol).toBe("SOLUSDT");
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT")).toHaveLength(0);
  });

  it("an INCONCLUSIVE reconciliation (query itself fails) does not block the close — flattens what's real now, same as before this fix, and never guesses at the ambiguous leg", async () => {
    const { dir, fileName, basketId } = seedCrashedBasket("xsec-killfirst-e1c");
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("SOLUSDT", 100);
    client2.queryOrderByClientIdNetworkError = true;
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
    });

    const result = await executor2.closeAllBasketsOrderly("KILL_SWITCH_BEFORE_FIRST_TICK_3");

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    // Never guessed — DOGE simply isn't adopted (INCONCLUSIVE), the basket still closes with
    // whatever is real right now (SOL), exactly the pre-fix behavior for this specific outcome.
    expect(result).toMatchObject({ closed: 1, failed: 0 });
    expect(basket.status).toBe("CLOSED");
    expect(basket.legs).toHaveLength(1);
  });

  it("a NOT_PLACED reconciliation releases the ambiguous leg's reservation immediately instead of leaving it RESERVED for the coordinator's staleness sweep", async () => {
    const dir = tmpDir();
    const fileName = "restart-recovery-kill-before-recovery-release.json";
    const basketId = "xb-crash-kill-first-release";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: null, entryClientOrderId: "xsec-killfirst-rel-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: "res-doge-1", entryClientOrderId: "xsec-killfirst-rel-e1", status: "PLACING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("SOLUSDT", 100);
    // queryOrderByClientIdResponses left EMPTY ⇒ default -2013 throw ⇒ classified NOT_PLACED.
    const released: Array<{ reservationId: string; reason: string }> = [];
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
      releaseExposureReservation: (reservationId, reason) => released.push({ reservationId, reason }),
    });

    const result = await executor2.closeAllBasketsOrderly("KILL_SWITCH_BEFORE_FIRST_TICK_4");

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(result).toMatchObject({ closed: 1, failed: 0 });
    expect(basket.status).toBe("CLOSED");
    expect(basket.legs).toHaveLength(1); // DOGE never existed on the exchange — correctly not invented
    // FAIL-WITHOUT-FIX: DOGE's reservation would stay "RESERVED" forever from this basket's own
    // perspective — freed only once the coordinator's OWN periodic staleness sweep independently
    // rediscovers and resolves it, needlessly blocking this symbol account-wide until then.
    expect(released).toEqual([{ reservationId: "res-doge-1", reason: "BASKET_CLOSED_BEFORE_RECOVERY:NOT_PLACED" }]);
    expect(basket.plan![1]!.status).toBe("FAILED");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// [2026-08-05 review round 2 fix] reconcileAmbiguousLegBeforeClose only ever resolved the ONE plan
// entry at index basket.legs.length — every OTHER never-attempted entry (anything strictly after
// it, or that same index whenever it was merely "PENDING" rather than "PLACING", i.e. no process
// ever attempted it at all) fell straight through to closeBasket() — which only ever iterates
// basket.legs, never basket.plan — untouched. Confirmed via direct trace: a 3-leg basket killed
// with two never-attempted legs remaining, or a freshly-RESERVED basket (zero legs, an all-PENDING
// plan) killed before recoverIncompleteBaskets ever got a chance to run, closed with every one of
// those un-attempted legs' reservations still "RESERVED" forever from THIS basket's own
// perspective — silently leaking real reserved capacity, recoverable only if/when the coordinator's
// OWN independent staleness sweep eventually rediscovers them.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("[RESTART-RECOVERY: KILL-SWITCH RELEASES THE WHOLE NEVER-ATTEMPTED TAIL] closeAllBasketsOrderly releases every un-attempted plan entry's reservation, not just the one ambiguous entry it reconciles", () => {
  it("a 3-leg basket's un-attempted THIRD leg is released when the basket is killed while the SECOND leg is still the only ambiguous one", async () => {
    const dir = tmpDir();
    const fileName = "restart-recovery-kill-tail-release.json";
    const basketId = "xb-crash-kill-tail";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [
        { symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry-1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0 },
      ],
      status: "PARTIALLY_FILLED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: "res-sol-1", entryClientOrderId: "xsec-killtail-e0", status: "FILLED", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: "res-doge-1", entryClientOrderId: "xsec-killtail-e1", status: "PLACING", failureReason: null },
        // Never attempted by ANY process — the basket crashed (or, here, was killed) before the
        // placement loop ever reached this leg. This is the entry the pre-fix version of
        // reconcileAmbiguousLegBeforeClose silently skipped: it only ever looked at index
        // legs.length (1, DOGE), never anything after it.
        { planIndex: 2, symbol: "ETHUSDT", side: "SHORT", requestedQty: 1, refPrice: 3000, reservationId: "res-eth-1", entryClientOrderId: "xsec-killtail-e2", status: "PENDING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    client2.fillPriceBySymbol.set("SOLUSDT", 100);
    // queryOrderByClientIdResponses left EMPTY for DOGE ⇒ default -2013 throw ⇒ classified NOT_PLACED.
    const released: Array<{ reservationId: string; reason: string }> = [];
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
      releaseExposureReservation: (reservationId, reason) => released.push({ reservationId, reason }),
    });

    const result = await executor2.closeAllBasketsOrderly("KILL_SWITCH_TAIL_RELEASE");

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(result).toMatchObject({ closed: 1, failed: 0 });
    expect(basket.status).toBe("CLOSED");
    expect(basket.legs).toHaveLength(1); // neither DOGE nor ETH ever existed on the exchange
    expect(client2.placed.filter((p) => p.symbol === "DOGEUSDT" || p.symbol === "ETHUSDT")).toHaveLength(0);
    // FAIL-WITHOUT-FIX: only DOGE (res-doge-1) would be released — ETH's reservation (res-eth-1)
    // would stay "RESERVED" forever from this basket's own perspective, on a basket now CLOSED and
    // never revisited by recoverIncompleteBaskets again.
    expect(released.map((r) => r.reservationId).sort()).toEqual(["res-doge-1", "res-eth-1"]);
    expect(basket.plan![1]!.status).toBe("FAILED"); // DOGE — explicitly reconciled, NOT_PLACED
    expect(basket.plan![2]!.status).toBe("NEVER_ATTEMPTED"); // ETH — never even reached
  });

  it("a freshly-RESERVED basket (zero legs, an all-PENDING plan) killed before recovery ever ran releases EVERY reservation, not zero", async () => {
    const dir = tmpDir();
    const fileName = "restart-recovery-kill-reserved-release.json";
    const basketId = "xb-crash-kill-reserved";
    const store1 = new CrossSectionalExecutorStore(dir, fileName);
    store1.getState().baskets.push({
      basketId,
      sourceObservationId: `manual:${basketId}`,
      signal: "MOM24_FILTERED",
      variant: "FILTERED",
      openedAt: NOW,
      closesAtMs: NOW_MS + 24 * 3_600_000,
      legs: [],
      status: "RESERVED",
      plan: [
        { planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100, reservationId: "res-sol-2", entryClientOrderId: "xsec-killres-e0", status: "PENDING", failureReason: null },
        { planIndex: 1, symbol: "DOGEUSDT", side: "SHORT", requestedQty: 100, refPrice: 0.1, reservationId: "res-doge-2", entryClientOrderId: "xsec-killres-e1", status: "PENDING", failureReason: null },
      ],
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    });
    store1.save();
    const store2 = new CrossSectionalExecutorStore(dir, fileName);
    const client2 = new FakeExecClient();
    const released: Array<{ reservationId: string; reason: string }> = [];
    const executor2 = new CrossSectionalExecutor({
      client: client2,
      signalStore: new CrossSectionalStore(tmpDir()),
      store: store2,
      isAllowed: () => true,
      nowIso: () => NOW,
      fillConfirmRetryDelayMs: 0,
      releaseExposureReservation: (reservationId, reason) => released.push({ reservationId, reason }),
    });

    // The kill-switch is the VERY FIRST thing to touch this basket — recoverIncompleteBaskets has
    // never run (executor2.tick() is never called in this test), and no leg's status is "PLACING"
    // at all (nothing was ever ambiguous — nothing was ever attempted), so the pre-fix version's
    // `if (ambiguous.status !== "PLACING") return;` bailed out doing NOTHING for either entry.
    const result = await executor2.closeAllBasketsOrderly("KILL_SWITCH_RESERVED_RELEASE");

    const basket = store2.getState().baskets.find((b) => b.basketId === basketId)!;
    expect(result).toMatchObject({ closed: 1, failed: 0 });
    expect(basket.status).toBe("CLOSED");
    expect(basket.legs).toHaveLength(0);
    expect(client2.placed).toHaveLength(0);
    // FAIL-WITHOUT-FIX: `released` would be empty — BOTH reservations leaked.
    expect(released.map((r) => r.reservationId).sort()).toEqual(["res-doge-2", "res-sol-2"]);
    expect(basket.plan!.every((p) => p.status === "NEVER_ATTEMPTED")).toBe(true);
  });
});

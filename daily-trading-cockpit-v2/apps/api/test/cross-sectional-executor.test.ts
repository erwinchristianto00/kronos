import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import type { FuturesOrder, FuturesPosition, FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
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
  placed: Array<{ symbol: string; side: string; quantity: number; reduceOnly?: boolean }> = [];
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
  async placeOrder(params: { symbol: string; side: string; quantity: number; reduceOnly?: boolean }) {
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

function makeExecutor(opts: { client?: FakeExecClient; allowed?: boolean; laneWeightPct?: number; rawLaneWeightPct?: number; cortexRealAttribution?: CortexRealAttributionStore; laneId?: string; signalMs?: number; dailyMaxLossUsd?: number; entryHealthAllowed?: boolean; siblingOpenLegs?: () => Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }>; existingNotionalForSymbol?: (symbol: string) => number; maxNotionalPerSymbolAcrossLanes?: number; respectSignalRiskGeometry?: boolean } = {}) {
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
  });
  return { executor, client, signalStore, store, storeDir };
}

describe("cross-sectional executor (basket execution, testnet-first)", () => {
  it("opens the FULL hedged basket from a fresh FILTERED signal (long buy + short sell, sized per leg USD)", async () => {
    const { executor, client, store } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000 });
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    expect(basket.status).toBe("OPEN");
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
    expect(store.getState().baskets[0]!.status).toBe("OPEN");

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
          sawEmptyOpenBasketBeforeAnyFill =
            basket !== undefined && basket.status === "OPEN" && basket.legs.length === 0;
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
          sawPersistedAfterFirstLeg =
            basket !== undefined &&
            basket.status === "OPEN" &&
            basket.legs.length === 1 &&
            basket.legs[0]!.symbol === "SOLUSDT" &&
            basket.legs[0]!.entryOrderId !== null;
        }
        return originalPlaceOrder(params);
      };
      await executor.tick();
      expect(sawPersistedAfterFirstLeg).toBe(true);
      // Sanity: the basket did go on to complete normally — this isn't just testing a fixture quirk.
      expect(store.getState().baskets[0]!.status).toBe("OPEN");
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
    expect(basket.status).toBe("OPEN");
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
    expect(basket.status).toBe("OPEN");

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

    expect(basket.status).toBe("OPEN");
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

    expect(basket.status).toBe("OPEN");
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

      expect(basket.status).toBe("OPEN");
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
    expect(basket.status).toBe("OPEN");
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
    expect(store.getState().baskets[0]!.status).toBe("OPEN");
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
      expect(store.getState().baskets.filter((b) => b.status === "OPEN").length).toBe(1);
      signalStore.add(signalObs(NOW_MS - 3 * 60_000)); // newer than the watermark
      await executor.tick();
      expect(store.getState().baskets.filter((b) => b.status === "OPEN").length).toBe(2);
    } finally {
      delete process.env.CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS;
    }
  });

  it("still caps concurrent baskets at MAX_OPEN_BASKETS (default 1)", async () => {
    const { executor, signalStore, store } = makeExecutor({ signalMs: NOW_MS - 20 * 60_000 });
    await executor.tick();
    signalStore.add(signalObs(NOW_MS - 3 * 60_000));
    await executor.tick();
    expect(store.getState().baskets.filter((b) => b.status === "OPEN").length).toBe(1);
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
      status: "OPEN",
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
      status: "OPEN" as const,
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
    expect(store.getState().baskets.find((x) => x.basketId === "b")!.status).toBe("OPEN");
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
    expect(a.status).toBe("OPEN"); // wedged, surfaced — NOT silently force-closed without the guard
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
      status: "OPEN" as const,
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

    expect(basket.status).toBe("OPEN");
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
    expect(store.getState().baskets.filter((b) => b.status === "OPEN").length).toBe(0);
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
    expect(store.getState().baskets.filter((b) => b.status === "OPEN").length).toBe(1); // fresh basket opened
    expect(executor.getStatus().openHalted).toBeNull();
  });

  it("[BREAKER] yesterday's losses never halt today (UTC-day scoped) and the halt clears itself", async () => {
    const { executor, store } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000, dailyMaxLossUsd: 5 });
    store.getState().baskets.push(closedBasket("old-loss", "2026-07-01T23:00:00.000Z", -50));
    await executor.tick();
    expect(store.getState().baskets.filter((b) => b.status === "OPEN").length).toBe(1); // opened normally
    expect(executor.getStatus().openHalted).toBeNull();
  });

  it("[BREAKER] disabled by default (limit 0): deep losses alone never block opens", async () => {
    const { executor, store } = makeExecutor({ signalMs: NOW_MS - 5 * 60_000, dailyMaxLossUsd: 0 });
    store.getState().baskets.push(closedBasket("loss", NOW, -500));
    await executor.tick();
    expect(store.getState().baskets.filter((b) => b.status === "OPEN").length).toBe(1);
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
      status: "OPEN",
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
    expect(wedged.status).toBe("OPEN"); // still due, will retry next tick
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
    st.baskets.push(directBasket("xb-wedged-tp", "ADAUSDT", NOW_MS + 3_600_000)); // not yet due by horizon
    client.fillPriceBySymbol.set("RNDRUSDT", 2.05);
    client.markPriceBySymbol.set("RNDRUSDT", 2);
    st.baskets.push(directBasket("xb-healthy-tp", "RNDRUSDT", NOW_MS + 3_600_000));
    store.save();

    await executor.tick();

    const wedged = store.getState().baskets.find((b) => b.basketId === "xb-wedged-tp")!;
    const healthy = store.getState().baskets.find((b) => b.basketId === "xb-healthy-tp")!;
    expect(wedged.status).toBe("OPEN");
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

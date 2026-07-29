/**
 * PER-FILL PERSISTENCE — the WIRING tests (2026-07-27).
 *
 * execution-fill-recorder.test.ts pins the store's own behaviour. These tests pin the thing that
 * was actually missing: that the two settlement paths which already hold the exchange's per-fill
 * rows in memory now hand them to the recorder instead of dropping them.
 *
 *   - cross-sectional-executor.ts closeBasket()      kept `t.commission` only.
 *   - live-execution-engine.ts    realizedFromTrades() kept `realizedPnl - commission` and
 *                                                     `commission` only — every price discarded,
 *                                                     across 182 closed intents on the live store.
 *
 * Each writer gets two tests: the record lands with the EXACT fill price (fails without the
 * wiring — no record exists at all), and a recorder that THROWS on every call leaves the
 * settlement's own numbers and state bit-identical (the fail-open proof).
 *
 * Deliberately self-contained fakes rather than reuse of the two big executor/engine suites'
 * harnesses: those files are large and concurrently edited, and a wiring test that depends on
 * someone else's fixture is a wiring test that breaks for unrelated reasons.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  CrossSectionalStore,
  _resetCrossSectionalStoreForTests,
  type CrossSectionalObservation,
} from "../src/lib/cross-sectional-edge.js";
import {
  CrossSectionalExecutor,
  CrossSectionalExecutorStore,
  type CrossSectionalExecClient,
} from "../src/lib/cross-sectional-executor.js";
import { ExecutionFillRecorder } from "../src/lib/execution-fill-recorder.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type SingleSymbolExecClient,
  type SingleSymbolFreshSignal,
} from "../src/lib/single-symbol-lane-executor.js";
import {
  LiveExecutionEngine,
  LiveExecutionStore,
  type LiveExecutionConfig,
  type LiveIntent,
  type LivePrivateClient,
  type PaperStoreReader,
} from "../src/lib/live-execution-engine.js";

const NOW = "2026-07-02T03:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-fillwire-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  _resetCrossSectionalStoreForTests();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A recorder whose every write throws — the fail-open probe. Extends the real class so the caller
 *  sees the exact same type and cannot "handle" it specially. */
class ThrowingRecorder extends ExecutionFillRecorder {
  calls = 0;
  override recordFills(): boolean {
    this.calls += 1;
    throw new Error("simulated recorder failure (disk full / corrupt state)");
  }
}

// ── cross-sectional executor ─────────────────────────────────────────────────

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

class FakeXsecClient implements CrossSectionalExecClient {
  placed: Array<{ symbol: string; side: string; quantity: number; reduceOnly?: boolean }> = [];
  fillPriceBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  /** commission per fill, per symbol. Unset ⇒ getUserTrades returns [] for that symbol. */
  commissionBySymbol = new Map<string, number>();
  /** Price reported on the /userTrades row — deliberately DIFFERENT from the order's avgPrice so a
   *  test can prove the persisted price came from the fill row, not from the order response. */
  tradePriceBySymbol = new Map<string, number>();
  /** When > 0, pad every getUserTrades response with this many UNRELATED rows (order ids nothing
   *  matches) so the page reaches Binance's limit and comes back SATURATED. */
  padTradesTo = 0;
  /** When set, force this orderId onto every returned /userTrades row for the given symbol — used
   *  to build the cross-symbol order-id collision the flat role map used to mislabel. */
  forceOrderIdBySymbol = new Map<string, string>();
  /** When set, the NEXT placeOrder for this symbol returns this orderId instead of the sequence. */
  forcePlacedOrderIdBySymbol = new Map<string, string>();
  private orderSeq = 100;

  private buildOrder(symbol: string, side: string, quantity: number, reduceOnly: boolean | undefined, orderId: string, avgPrice: number): FuturesOrder {
    return {
      symbol, orderId, clientOrderId: "", status: avgPrice > 0 ? "FILLED" : "NEW", type: "MARKET",
      side: side === "SELL" ? "SELL" : "BUY", reduceOnly: Boolean(reduceOnly), price: 0, stopPrice: 0,
      origQty: quantity, executedQty: avgPrice > 0 ? quantity : 0, avgPrice, updateTime: 0,
    };
  }
  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    const f = (stepSize: number, minQty: number): FuturesSymbolFilters =>
      ({ stepSize, minQty, tickSize: 0.0001, minNotional: 5 } as unknown as FuturesSymbolFilters);
    return new Map([["SOLUSDT", f(0.01, 0.01)], ["DOGEUSDT", f(1, 1)]]);
  }
  async setLeverage(): Promise<void> {}
  async getPositions(): Promise<FuturesPosition[]> {
    return Array.from(this.markPriceBySymbol.keys()).map((symbol) => ({
      symbol, positionAmt: 0, entryPrice: 0, markPrice: this.markPriceBySymbol.get(symbol) ?? 0,
      liquidationPrice: 0, unRealizedProfit: 0, leverage: 3, marginType: "ISOLATED" as const,
    }));
  }
  async placeOrder(params: { symbol: string; side: string; quantity: number; reduceOnly?: boolean }) {
    this.placed.push(params);
    const orderId = this.forcePlacedOrderIdBySymbol.get(params.symbol) ?? String(this.orderSeq++);
    return this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, orderId, this.fillPriceBySymbol.get(params.symbol) ?? 0);
  }
  async queryOrder(symbol: string, orderId: string) {
    return this.buildOrder(symbol, "BUY", 0, false, orderId, 0);
  }
  async getUserTrades(symbol: string): Promise<FuturesUserTrade[]> {
    const commission = this.commissionBySymbol.get(symbol);
    if (commission === undefined) return [];
    const forced = this.forceOrderIdBySymbol.get(symbol);
    const rows: FuturesUserTrade[] = this.placed
      .map((p, i) => ({ p, orderId: String(100 + i) }))
      .filter(({ p }) => p.symbol === symbol)
      .map(({ p, orderId }, i) => ({
        symbol,
        orderId: forced ?? orderId,
        tradeId: `t-${symbol}-${orderId}`,
        price: this.tradePriceBySymbol.get(symbol) ?? this.fillPriceBySymbol.get(symbol) ?? 0,
        qty: p.quantity,
        realizedPnl: 0,
        commission,
        commissionAsset: "USDT",
        time: NOW_MS + i,
        maker: false,
      }));
    while (this.padTradesTo > 0 && rows.length < this.padTradesTo) {
      rows.push({
        symbol, orderId: `noise-${symbol}-${rows.length}`, tradeId: `tn-${symbol}-${rows.length}`,
        price: 1, qty: 1, realizedPnl: 0, commission: 999, commissionAsset: "USDT",
        time: NOW_MS, maker: false,
      });
    }
    return rows;
  }
}

function makeXsecExecutor(opts: { recorder?: ExecutionFillRecorder } = {}) {
  const client = new FakeXsecClient();
  client.fillPriceBySymbol.set("SOLUSDT", 100);
  client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
  const signalStore = new CrossSectionalStore(tmp());
  const store = new CrossSectionalExecutorStore(tmp());
  store.getState().lastSeenSignalMs = NOW_MS - 3_600_000;
  signalStore.add(signalObs(NOW_MS - 5 * 60_000));
  const executor = new CrossSectionalExecutor({
    client,
    signalStore,
    store,
    isAllowed: () => true,
    laneWeightPct: () => 100,
    laneId: "XSEC_TEST_LANE",
    nowIso: () => NOW,
    fillConfirmRetryDelayMs: 0,
    ...(opts.recorder ? { executionFillRecorder: opts.recorder } : {}),
  });
  return { executor, client, store };
}

describe("cross-sectional executor → per-fill recorder", () => {
  it("persists every matched fill VERBATIM (exact price, qty, commission, exchange time, role)", async () => {
    const recorder = new ExecutionFillRecorder(tmp());
    const { executor, client, store } = makeXsecExecutor({ recorder });
    client.commissionBySymbol.set("SOLUSDT", 0.05);
    client.commissionBySymbol.set("DOGEUSDT", 0.05);
    // The /userTrades row reports a DIFFERENT price from the order's avgPrice — the record must
    // carry the fill's own price, which is the number that did not exist anywhere before.
    client.tradePriceBySymbol.set("SOLUSDT", 100.37);
    client.tradePriceBySymbol.set("DOGEUSDT", 0.10021);

    await executor.tick(); // opens the basket
    const basket = store.getState().baskets[0]!;
    basket.closesAtMs = NOW_MS - 1;
    await executor.tick(); // closes it
    expect(basket.status).toBe("CLOSED");

    // WITHOUT the wiring this record does not exist at all.
    const rec = recorder.getRecord(`xsec:XSEC_TEST_LANE:${basket.basketId}`);
    expect(rec).not.toBeNull();
    expect(rec!.source).toBe("xsec");
    expect(rec!.fetchComplete).toBe(true);
    // 2 legs × (entry + exit) = 4 fills, each with its own price.
    expect(rec!.fills.length).toBe(4);
    expect(rec!.fills.filter((f) => f.role === "ENTRY").length).toBe(2);
    expect(rec!.fills.filter((f) => f.role === "EXIT").length).toBe(2);
    const sol = rec!.fills.filter((f) => f.symbol === "SOLUSDT");
    expect(sol.length).toBe(2);
    for (const f of sol) {
      expect(f.price).toBe(100.37);
      expect(f.commission).toBe(0.05);
      expect(f.commissionAsset).toBe("USDT");
      expect(f.maker).toBe(false);
      expect(typeof f.orderId).toBe("string");
    }
    // Exchange-stamped time, not our clock.
    expect(rec!.fills.every((f) => f.time >= NOW_MS)).toBe(true);
  });

  it("[2026-07-27 SATURATION] a FULL userTrades page records fetchComplete=false — a page that may have cut rows off its edge is not 'complete'", async () => {
    const recorder = new ExecutionFillRecorder(tmp());
    const { executor, client, store } = makeXsecExecutor({ recorder });
    client.commissionBySymbol.set("SOLUSDT", 0.05);
    client.commissionBySymbol.set("DOGEUSDT", 0.05);
    client.padTradesTo = 1000; // exactly Binance's limit ⇒ saturated

    await executor.tick();
    const basket = store.getState().baskets[0]!;
    basket.closesAtMs = NOW_MS - 1;
    await executor.tick();
    expect(basket.status).toBe("CLOSED");

    const rec = recorder.getRecord(`xsec:XSEC_TEST_LANE:${basket.basketId}`);
    expect(rec).not.toBeNull();
    // Before this fix `fetchComplete` was `realFees !== null`, which is TRUE here (no fetch threw),
    // so this record asserted completeness it could not know.
    expect(rec!.fetchComplete).toBe(false);
    // The basket still settles from the exchange exactly as before — recording only.
    expect(basket.feeSource).toBe("EXCHANGE");
  });

  it("[2026-07-27 ROLE SCOPE] two symbols sharing an order id are labelled from their OWN symbol's leg, not a flat map", async () => {
    const recorder = new ExecutionFillRecorder(tmp());
    const { executor, client, store } = makeXsecExecutor({ recorder });
    client.commissionBySymbol.set("SOLUSDT", 0.05);
    client.commissionBySymbol.set("DOGEUSDT", 0.05);

    await executor.tick(); // opens the basket
    const basket = store.getState().baskets[0]!;
    // Build the collision: SOLUSDT's ENTRY order and DOGEUSDT's EXIT order carry the SAME id.
    // Order ids are only unique within a symbol on this account, so this is representable.
    basket.legs.find((l) => l.symbol === "SOLUSDT")!.entryOrderId = "SHARED";
    client.forceOrderIdBySymbol.set("SOLUSDT", "SHARED"); // SOL's /userTrades rows carry it too
    client.forcePlacedOrderIdBySymbol.set("DOGEUSDT", "SHARED"); // DOGE's close order gets it
    basket.closesAtMs = NOW_MS - 1;
    await executor.tick();
    expect(basket.status).toBe("CLOSED");
    expect(basket.legs.find((l) => l.symbol === "DOGEUSDT")!.exitOrderId).toBe("SHARED");

    const rec = recorder.getRecord(`xsec:XSEC_TEST_LANE:${basket.basketId}`);
    expect(rec).not.toBeNull();
    const sol = rec!.fills.filter((f) => f.symbol === "SOLUSDT");
    expect(sol.length).toBeGreaterThan(0);
    // With a FLAT roleByOrderId map, DOGEUSDT's later `set("SHARED", "EXIT")` overwrote
    // SOLUSDT's `set("SHARED", "ENTRY")` and every SOL row here came back labelled EXIT.
    // Symbol-scoped, SOL's own leg is the authority for SOL's own rows.
    expect(sol.every((f) => f.role === "ENTRY")).toBe(true);
  });

  it("records NOTHING when no trade matched — an empty record would read as 'this close had no fills'", async () => {
    const recorder = new ExecutionFillRecorder(tmp());
    const { executor, store } = makeXsecExecutor({ recorder }); // commissionBySymbol left empty ⇒ getUserTrades returns []
    await executor.tick();
    const basket = store.getState().baskets[0]!;
    basket.closesAtMs = NOW_MS - 1;
    await executor.tick();
    expect(basket.status).toBe("CLOSED");
    expect(recorder.listRecords()).toEqual([]);
  });

  it("[FAIL-OPEN] a recorder that THROWS leaves feeEstimateUsd / netPnlUsd / status / feeSource untouched", async () => {
    const good = new ExecutionFillRecorder(tmp());
    const control = makeXsecExecutor({ recorder: good });
    control.client.commissionBySymbol.set("SOLUSDT", 0.05);
    control.client.commissionBySymbol.set("DOGEUSDT", 0.05);
    await control.executor.tick();
    const controlBasket = control.store.getState().baskets[0]!;
    controlBasket.closesAtMs = NOW_MS - 1;
    await control.executor.tick();

    const bad = new ThrowingRecorder(tmp());
    const broken = makeXsecExecutor({ recorder: bad });
    broken.client.commissionBySymbol.set("SOLUSDT", 0.05);
    broken.client.commissionBySymbol.set("DOGEUSDT", 0.05);
    await broken.executor.tick();
    const brokenBasket = broken.store.getState().baskets[0]!;
    brokenBasket.closesAtMs = NOW_MS - 1;
    await expect(broken.executor.tick()).resolves.not.toThrow();

    expect(bad.calls).toBeGreaterThan(0); // it really was invoked, and really did throw
    expect(brokenBasket.status).toBe(controlBasket.status);
    expect(brokenBasket.feeEstimateUsd).toBe(controlBasket.feeEstimateUsd);
    expect(brokenBasket.grossPnlUsd).toBe(controlBasket.grossPnlUsd);
    expect(brokenBasket.netPnlUsd).toBe(controlBasket.netPnlUsd);
    expect(brokenBasket.feeSource).toBe(controlBasket.feeSource);
    expect(brokenBasket.closeReason).toBe(controlBasket.closeReason);
  });
});

// ── live execution engine ────────────────────────────────────────────────────

function makeLiveConfig(): LiveExecutionConfig {
  return {
    enabled: true, env: "testnet", apiKey: "k", apiSecret: "s",
    riskUsdPerTrade: 5, maxConcurrentPositions: 3,
    maxCorrelatedAltLongPositions: 3, maxCorrelatedAltShortPositions: 3,
    maxAggregateIntentRiskUsd: 5, maxClusterPositions: 3,
    dailyMaxLossUsd: 15, maxConsecutiveLosses: 5, consecutiveLossWindowHours: 24,
    scratchEpsilonUsd: 0.1, maxDrawdownUsd: 40, defaultLeverage: 3, maxLeverage: 2,
    maxNotionalPerTrade: 250, maxPaperOrderAgeMs: 24 * 3_600_000,
    mirrorAllPaperOrders: false, testnetStratifiedCollection: false, mirrorProvenSymbolsOnly: false,
    testnetTakeProfitUsd: 0, testnetRegimeExitEnabled: true, testnetRegimeHardCutMs: 0,
    estimatedCloseCostPct: 0.0022, autoArm: false, mainnetConfirmed: false,
    mainnetKeepTestnetPolicy: false, mainnetProfitProtection: false, mainnetTpR: 0,
    mainnetRegimeHardCutMs: 30 * 60_000, profitBankNetTargetUsd: 0, profitBankMode: "FLAT",
    profitBankTargetR: 1, regimeLossHardCutStopFraction: 0.5, forceMfeGiveback: false,
    losingMaxHoldMs: 0, laneSelectionLossResetUsd: 0.25,
    rescue: {
      enabled: false, minAgeMs: 3_600_000, minLossUsd: 1, netFraction: 1, maxNotionalUsd: 250,
      targetUsd: 0, maxSymbols: 2, minAvailableBalanceUsd: 10, maxHoldMs: 24 * 3_600_000,
    },
    rescueExecute: false, maxAggregateManualDirectionalNotionalUsd: 0, configErrors: [],
  } as LiveExecutionConfig;
}

const ENTRY_ORDER_ID = "8389766229891298477";
const CLOSE_ORDER_ID = "8389766229891298999";

class FakeEngineClient {
  placed: Array<{ symbol: string; reduceOnly?: boolean }> = [];
  trades: FuturesUserTrade[] = [];
  async ensureTimeSync(): Promise<void> {}
  getClockSkewMs(): number { return 0; }
  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    return new Map([["ETHUSDT", { symbol: "ETHUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 }]]);
  }
  async getPositions(): Promise<FuturesPosition[]> {
    return [{ symbol: "ETHUSDT", positionAmt: 0.5, entryPrice: 2000, markPrice: 2000, liquidationPrice: 0, unRealizedProfit: 0, leverage: 3, marginType: "ISOLATED" }];
  }
  async cancelAllOrders(): Promise<void> {}
  async cancelAllAlgoOrders(): Promise<void> {}
  async placeOrder(params: { symbol: string; reduceOnly?: boolean }): Promise<FuturesOrder> {
    this.placed.push(params);
    return {
      symbol: "ETHUSDT", orderId: CLOSE_ORDER_ID, clientOrderId: "", status: "FILLED", type: "MARKET",
      side: "SELL", reduceOnly: true, price: 0, stopPrice: 0, origQty: 0.5, executedQty: 0.5,
      avgPrice: 2010, updateTime: 0,
    };
  }
  async getUserTrades(): Promise<FuturesUserTrade[]> { return this.trades; }
}

function openIntent(): LiveIntent {
  return {
    paperOrderId: "paper-1",
    symbol: "ETHUSDT",
    direction: "LONG",
    state: "OPEN",
    qty: 0.5,
    tp1Qty: 0.25,
    plannedEntryPrice: 2000,
    stopLossPrice: 1900,
    tp1Price: 2100,
    filledEntryPrice: 2000,
    entryOrderId: ENTRY_ORDER_ID,
    stopOrderId: null,
    tp1OrderId: null,
    beStopOrderId: null,
    realizedPnlUsd: null,
    feesUsd: null,
    createdAt: "2026-07-02T02:00:00.000Z",
    updatedAt: "2026-07-02T02:00:00.000Z",
    closedAt: null,
    closeReason: null,
    lastError: null,
    sourcePaperOrders: [{ paperOrderId: "paper-1", laneId: "CG_WIDE_FAST_LONG" }] as LiveIntent["sourcePaperOrders"],
  } as LiveIntent;
}

function makeEngine(recorder?: ExecutionFillRecorder) {
  const client = new FakeEngineClient();
  // The two fills settlement matches: the ENTRY row (realizedPnl 0, commission only) and the
  // CLOSE row. Their `price` is what the engine has never persisted anywhere.
  client.trades = [
    { symbol: "ETHUSDT", orderId: ENTRY_ORDER_ID, tradeId: "5001", price: 2000.25, qty: 0.5, realizedPnl: 0, commission: 0.05, commissionAsset: "USDT", time: NOW_MS - 3_600_000, maker: false },
    { symbol: "ETHUSDT", orderId: CLOSE_ORDER_ID, tradeId: "5002", price: 2010.75, qty: 0.5, realizedPnl: 5.25, commission: 0.0503, commissionAsset: "USDT", time: NOW_MS, maker: false },
    // A THIRD row on the same symbol from an unrelated order (a sibling executor's leg on this
    // netted account) — it must contribute nothing to the record.
    { symbol: "ETHUSDT", orderId: "9999999999999999999", tradeId: "5003", price: 2500, qty: 9, realizedPnl: 99, commission: 9, commissionAsset: "USDT", time: NOW_MS, maker: false },
  ];
  const store = new LiveExecutionStore(tmp());
  store.getState().intents.push(openIntent());
  const engine = new LiveExecutionEngine({
    config: makeLiveConfig(),
    client: client as unknown as LivePrivateClient,
    store,
    paperStore: { getState: () => ({ orders: [], halted: false }) } as unknown as PaperStoreReader,
    nowIso: () => NOW,
    fillConfirmRetryDelayMs: 0,
    ...(recorder ? { executionFillRecorder: recorder } : {}),
  });
  return { engine, client, store };
}

describe("live execution engine → per-fill recorder", () => {
  it("persists the settlement's own matched rows, INCLUDING the exit fill price the store has never held", async () => {
    const recorder = new ExecutionFillRecorder(tmp());
    const { engine, store } = makeEngine(recorder);
    const intent = store.getState().intents[0]!;
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);

    // WITHOUT the wiring this record does not exist at all.
    const rec = recorder.getRecord(`intent:${intent.paperOrderId}:${intent.createdAt}`);
    expect(rec).not.toBeNull();
    expect(rec!.source).toBe("engine");
    expect(rec!.laneId).toBe("CG_WIDE_FAST_LONG");
    expect(rec!.symbol).toBe("ETHUSDT");
    expect(rec!.fetchComplete).toBe(true);

    // Exactly the two OWN rows — the foreign orderId on the same symbol is excluded by the
    // existing orderId matching, which is what makes the record safe on a shared netted account.
    expect(rec!.fills.length).toBe(2);
    expect(rec!.fills.some((f) => f.orderId === "9999999999999999999")).toBe(false);

    const entry = rec!.fills.find((f) => f.role === "ENTRY")!;
    const exit = rec!.fills.find((f) => f.role === "EXIT")!;
    expect(entry.orderId).toBe(ENTRY_ORDER_ID);
    expect(entry.price).toBe(2000.25);
    expect(entry.commission).toBe(0.05);
    expect(exit.orderId).toBe(CLOSE_ORDER_ID);
    expect(exit.price).toBe(2010.75);   // <- the number that existed nowhere before
    expect(exit.realizedPnl).toBe(5.25);
    expect(exit.tradeId).toBe("5002");
    expect(exit.maker).toBe(false);
  });

  it("[SETTLEMENT COVERAGE] a saturated response is complete when every required entry/exit order is present", async () => {
    const recorder = new ExecutionFillRecorder(tmp());
    const { engine, client, store } = makeEngine(recorder);
    // Pad the page to Binance's limit with unrelated rows. This is the real hazard: a long-lived
    // intent on a symbol the account (all lanes netted) traded >1000 times since createdAt loses
    // its ENTRY row off the page and leaves an exit-only record.
    while (client.trades.length < 1000) {
      client.trades.push({
        symbol: "ETHUSDT", orderId: `noise-${client.trades.length}`, tradeId: `tn-${client.trades.length}`,
        price: 1, qty: 1, realizedPnl: 0, commission: 0, commissionAsset: "USDT", time: NOW_MS, maker: false,
      });
    }
    const intent = store.getState().intents[0]!;
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);

    const rec = recorder.getRecord(`intent:${intent.paperOrderId}:${intent.createdAt}`);
    expect(rec).not.toBeNull();
    // Saturation alone is not incompleteness: exact required order-id coverage proves this record.
    expect(rec!.fetchComplete).toBe(true);
    // Settlement itself is untouched — the same two own rows, the same P&L.
    expect(rec!.fills.length).toBe(2);
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(store.getState().intents[0]!.feesUsd).toBeCloseTo(0.1003, 10);
  });

  it("[FAIL-OPEN] a recorder that THROWS leaves realizedPnlUsd / feesUsd / state / ledger identical", async () => {
    const control = makeEngine(new ExecutionFillRecorder(tmp()));
    const controlIntent = control.store.getState().intents[0]!;
    const controlRes = await control.engine.manualCloseIntent(controlIntent.paperOrderId);

    const bad = new ThrowingRecorder(tmp());
    const broken = makeEngine(bad);
    const brokenIntent = broken.store.getState().intents[0]!;
    const brokenRes = await broken.engine.manualCloseIntent(brokenIntent.paperOrderId);

    expect(bad.calls).toBeGreaterThan(0); // it really was invoked, and really did throw
    // A throw leaking into realizedFromTrades' enclosing catch would turn this into a retry and
    // then a null P&L — the exact silent-loss failure the 2026-07-11 audit fixed.
    expect(brokenRes).toEqual(controlRes);
    expect(brokenIntent.realizedPnlUsd).toBe(controlIntent.realizedPnlUsd);
    expect(brokenIntent.realizedPnlUsd).not.toBeNull();
    expect(brokenIntent.feesUsd).toBe(controlIntent.feesUsd);
    expect(brokenIntent.state).toBe(controlIntent.state);
    expect(brokenIntent.closeReason).toBe(controlIntent.closeReason);
    expect(brokenIntent.lastError).toBe(controlIntent.lastError);
    expect(broken.store.getState().totalRealizedPnlUsd).toBe(control.store.getState().totalRealizedPnlUsd);
    expect(broken.store.getState().consecutiveLosses).toBe(control.store.getState().consecutiveLosses);
  });

  it("with NO recorder injected the engine is unchanged and nothing is recorded", async () => {
    const { engine, store } = makeEngine(); // no recorder
    const intent = store.getState().intents[0]!;
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);
    expect(intent.realizedPnlUsd).not.toBeNull();
  });
});

// ── single-symbol lane executor ──────────────────────────────────────────────
//
// The recording code inside this executor already existed in the tree; what did NOT exist was any
// construction of a recorder (app.ts never passed one), so the whole path was dead on live. These
// pin the end-to-end behaviour now that app.ts injects one into all six lanes.

const SSLE_ENTRY_ORDER = "1";
const SSLE_STOP_FILL_ORDER = "5555";

class FakeSsleClient implements SingleSymbolExecClient {
  placed: PlaceOrderParams[] = [];
  markPriceBySymbol = new Map<string, number>([["BTCUSDT", 60000]]);
  private algoTriggeredOrderId = new Map<string, string | null>();
  private tradesByOrderId = new Map<string, FuturesUserTrade>();
  private orderSeq = 1;
  private algoSeq = 900;

  private buildOrder(symbol: string, side: "BUY" | "SELL", quantity: number, reduceOnly: boolean | undefined, orderId: string, avgPrice: number): FuturesOrder {
    return {
      symbol, orderId, clientOrderId: "", status: avgPrice > 0 ? "FILLED" : "NEW", type: "MARKET",
      side, reduceOnly: Boolean(reduceOnly), price: 0, stopPrice: 0, origQty: quantity,
      executedQty: avgPrice > 0 ? quantity : 0, avgPrice, updateTime: 0,
    };
  }
  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    return new Map([["BTCUSDT", { stepSize: 0.001, minQty: 0.001, tickSize: 0.1, minNotional: 5 } as unknown as FuturesSymbolFilters]]);
  }
  async setLeverage(): Promise<void> {}
  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    const rows = Array.from(this.markPriceBySymbol.keys()).map((sym) => ({
      symbol: sym, positionAmt: 0, entryPrice: 0, markPrice: this.markPriceBySymbol.get(sym) ?? 0,
      liquidationPrice: 0, unRealizedProfit: 0, leverage: 3, marginType: "ISOLATED" as const,
    }));
    return symbol ? rows.filter((p) => p.symbol === symbol) : rows;
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    this.placed.push(params);
    return this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, String(this.orderSeq++), 60000);
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    return this.buildOrder(symbol, "BUY", 0, false, orderId, 60000);
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
  async cancelAlgoOrder(): Promise<void> {}
  /** When > 0, pad the page with unrelated rows so it reaches Binance's limit (SATURATED). */
  padTradesTo = 0;
  async getUserTrades(): Promise<FuturesUserTrade[]> {
    const rows = Array.from(this.tradesByOrderId.values());
    while (this.padTradesTo > 0 && rows.length < this.padTradesTo) {
      rows.push({
        symbol: "BTCUSDT", orderId: `noise-${rows.length}`, tradeId: `tn-${rows.length}`,
        price: 1, qty: 1, realizedPnl: 0, commission: 0, commissionAsset: "USDT", time: NOW_MS, maker: false,
      });
    }
    return rows;
  }
  seedTrade(orderId: string, over: Partial<FuturesUserTrade>): void {
    this.tradesByOrderId.set(orderId, {
      symbol: "BTCUSDT", orderId, tradeId: `t-${orderId}`, price: 60000, qty: 1, realizedPnl: 0,
      commission: 0, commissionAsset: "USDT", time: NOW_MS, maker: false, ...over,
    });
  }
  /** Mark a resting algo stop as having triggered a real fill. */
  triggerAlgo(algoId: string, actualOrderId: string, over: Partial<FuturesUserTrade>): void {
    this.algoTriggeredOrderId.set(algoId, actualOrderId);
    this.seedTrade(actualOrderId, over);
  }
}

function signal(): SingleSymbolFreshSignal {
  return { observationId: "sf:BTCUSDT:1", symbol: "BTCUSDT", entryPrice: 60000, stopPrice: 61800, openedAtMs: NOW_MS - 5 * 60_000 };
}

function makeSsle(recorder?: ExecutionFillRecorder) {
  const client = new FakeSsleClient();
  const store = new SingleSymbolLaneExecutorStore(tmp(), "test.json");
  const executor = new SingleSymbolLaneExecutor({
    client,
    store,
    laneId: "SSLE_TEST_LANE",
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
    ...(recorder ? { executionFillRecorder: recorder } : {}),
  });
  return { executor, client, store };
}

/** Open a position, arm its stop, then fire the stop so the position settles from getUserTrades. */
async function runSsleStopOut(h: ReturnType<typeof makeSsle>): Promise<void> {
  await h.executor.tick(); // open
  await h.executor.tick(); // place stop
  const pos = h.store.getState().positions[0]!;
  h.client.seedTrade(SSLE_ENTRY_ORDER, { price: 60001.5, qty: pos.qty, commission: 0.03, realizedPnl: 0 });
  h.client.triggerAlgo(pos.stopAlgoOrderId!, SSLE_STOP_FILL_ORDER, { price: 61799.5, qty: pos.qty, commission: 0.031, realizedPnl: -1.8 });
  h.client.markPriceBySymbol.set("BTCUSDT", 61800);
  await h.executor.tick(); // settle
}

describe("single-symbol lane executor → per-fill recorder", () => {
  it("persists both legs' fills with their exact prices once app.ts actually injects a recorder", async () => {
    const recorder = new ExecutionFillRecorder(tmp());
    const h = makeSsle(recorder);
    await runSsleStopOut(h);
    const pos = h.store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED");

    const rec = recorder.getRecord(`ssle:SSLE_TEST_LANE:${pos.positionId}`);
    expect(rec).not.toBeNull();
    expect(rec!.source).toBe("ssle");
    expect(rec!.fetchComplete).toBe(true);
    const entry = rec!.fills.find((f) => f.role === "ENTRY")!;
    const exit = rec!.fills.find((f) => f.role === "EXIT")!;
    expect(entry.price).toBe(60001.5);
    expect(entry.commission).toBe(0.03);
    expect(exit.price).toBe(61799.5);
    expect(exit.commission).toBe(0.031);
    expect(exit.realizedPnl).toBe(-1.8);
    expect(exit.tradeId).toBe(`t-${SSLE_STOP_FILL_ORDER}`);
  });

  it("[2026-07-27 SATURATION] a FULL userTrades page records fetchComplete=false, and settlement is byte-identical", async () => {
    const control = makeSsle(new ExecutionFillRecorder(tmp()));
    await runSsleStopOut(control);
    const controlPos = control.store.getState().positions[0]!;

    const recorder = new ExecutionFillRecorder(tmp());
    const h = makeSsle(recorder);
    h.client.padTradesTo = 1000; // exactly Binance's limit ⇒ saturated
    await runSsleStopOut(h);
    const pos = h.store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED");

    const rec = recorder.getRecord(`ssle:SSLE_TEST_LANE:${pos.positionId}`);
    expect(rec).not.toBeNull();
    // Was hardcoded `true` at both settle finalizations before this fix.
    expect(rec!.fetchComplete).toBe(false);
    // RECORDING-ONLY: the saturation flag must not move a single settled number.
    expect(pos.grossPnlUsd).toBe(controlPos.grossPnlUsd);
    expect(pos.feeEstimateUsd).toBe(controlPos.feeEstimateUsd);
    expect(pos.netPnlUsd).toBe(controlPos.netPnlUsd);
    expect(pos.feeSource).toBe(controlPos.feeSource);
    expect(pos.entryCommissionUsd).toBe(controlPos.entryCommissionUsd);
    expect(pos.entryLegFoldedIntoPnl).toBe(controlPos.entryLegFoldedIntoPnl);
  });

  it("[FAIL-OPEN] a recorder that THROWS leaves the settled P&L, fees and status identical", async () => {
    const control = makeSsle(new ExecutionFillRecorder(tmp()));
    await runSsleStopOut(control);
    const controlPos = control.store.getState().positions[0]!;

    const bad = new ThrowingRecorder(tmp());
    const broken = makeSsle(bad);
    await expect(runSsleStopOut(broken)).resolves.not.toThrow();
    const brokenPos = broken.store.getState().positions[0]!;

    expect(bad.calls).toBeGreaterThan(0);
    expect(brokenPos.status).toBe(controlPos.status);
    expect(brokenPos.closeReason).toBe(controlPos.closeReason);
    expect(brokenPos.grossPnlUsd).toBe(controlPos.grossPnlUsd);
    expect(brokenPos.feeEstimateUsd).toBe(controlPos.feeEstimateUsd);
    expect(brokenPos.netPnlUsd).toBe(controlPos.netPnlUsd);
    expect(brokenPos.exitPrice).toBe(controlPos.exitPrice);
    expect(brokenPos.exitPriceConfirmed).toBe(controlPos.exitPriceConfirmed);
  });
});

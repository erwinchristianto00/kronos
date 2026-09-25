import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import {
  BinanceFuturesPrivateError,
  type FuturesAlgoOrder,
  type FuturesOrder,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
  type PlaceAlgoOrderParams,
  type PlaceOrderParams,
} from "../../src/lib/binance-futures-private.js";
import {
  LiveExecutionEngine,
  LiveExecutionStore,
  type LiveExecutionConfig,
  type LivePrivateClient,
  type PaperStoreReader,
} from "../../src/lib/live-execution-engine.js";
import type { BinanceClient } from "../../src/lib/binance.js";
import { CortexRealAttributionStore } from "../../src/lib/cortex-real-attribution.js";
import type { PaperOrder } from "../../src/lib/paper-execution-router.js";

// Shared test-builder fixtures, cross-imported by several *.test.ts files (live-execution-engine,
// manual-directional-regime-safety-gate, unified-regime-entry-gate, canonical-market-regime-
// adversarial-execution-paths, execution-readiness-context, cortex-four-brain-live-execution-e2e).
//
// 2026-08: this used to live inside live-execution-engine.test.ts, and every other file imported it
// from there. A plain ES import of a *.test.ts file executes ALL of that file's top-level
// describe()/it() registrations too, so each importer was silently re-running live-execution-
// engine.test.ts's entire 260-test suite in its own collection context on top of its own tests.
// Living in a plain module the `*.test.ts` glob doesn't match, importing a builder costs nothing else.

export const dirs: string[] = [];
export function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-live-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

export const FILTERS: FuturesSymbolFilters = {
  symbol: "ETHUSDT",
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
  pricePrecision: 2,
  quantityPrecision: 3,
};

export class FakeLiveClient {
  env = "testnet" as const;
  placed: PlaceOrderParams[] = [];
  leverageCalls: Array<{ symbol: string; leverage: number }> = [];
  canceled: Array<{ symbol: string; orderId: string }> = [];
  cancelAllSymbols: string[] = [];
  positionsBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  unrealizedPnlBySymbol = new Map<string, number>();
  orderStatusById = new Map<string, string>();
  /** What queryOrder reports for a symbol — simulates the exchange confirming a fill that the
   *  initial placeOrder response returned as avgPrice=0. Unset ⇒ stays unconfirmed (NEW). */
  queryOrderAvgPriceBySymbol = new Map<string, number>();
  trades: FuturesUserTrade[] = [];
  hedge = false;
  failNextTicks = 0;
  /** When set, non-reduce MARKET entries fill at this avgPrice (else 2000) — used to simulate gap-through. */
  marketFillPrice: number | null = null;
  /** When set, every placeAlgoOrder throws a Binance rejection with this code (e.g. -2021). */
  algoErrorCode: number | null = null;
  /** When true, the aggregate-add MARKET entry (clientOrderId …-a) throws a timeout — simulates the 6s add timeout. */
  failAddEntry = false;
  /** When set, each reduce-only MARKET flatten books a userTrade with this realizedPnl on its own order id. */
  flattenRealizedPnl: number | null = null;
  /** [BUG 2 test support] When set, the rescue-flip's own non-reduceOnly MARKET order (clientOrderId
   *  prefix "dtc-rescue-") books a userTrade with this realizedPnl on its own order id — lets a test
   *  observe the flip's single REAL P&L without having to predict generated order ids. */
  rescueFlipRealizedPnl: number | null = null;
  /** Simulates Binance /userTrades eventual consistency after a just-placed close. */
  hideTradesForCalls = 0;
  getUserTradesCalls = 0;
  /** [BUG 1 test support] When >0, the NEXT that many reduce-only MARKET orders (flattens) throw a
   *  transient error instead of filling — simulates a Binance/network blip during a kill-switch
   *  flatten. Decremented on each throw. */
  failNextReduceOnlyMarketOrders = 0;
  /** [BUG 3 test support] Per-algoId override for queryAlgoOrder — when set, replaces the default
   *  "still resting, actualOrderId = itself" stub so a test can simulate a stop that triggered (or
   *  was cancelled/expired) WITHOUT fully closing the position. */
  algoOrderOverrides = new Map<string, { algoStatus: string; actualOrderId: string | null }>();
  private nextOrderId = 1000;

  async ensureTimeSync(): Promise<void> {
    if (this.failNextTicks > 0) {
      this.failNextTicks -= 1;
      throw new BinanceFuturesPrivateError("network", "fake outage");
    }
  }
  getClockSkewMs(): number {
    return 0;
  }
  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    return new Map([["ETHUSDT", FILTERS]]);
  }
  async getBalances() {
    return [{ asset: "USDT", balance: 5000, availableBalance: 4500 }];
  }
  async getPositions(symbol?: string) {
    const out = [];
    for (const [sym, amt] of this.positionsBySymbol) {
      if (symbol && sym !== symbol) continue;
      out.push({
        symbol: sym,
        positionAmt: amt,
        entryPrice: 2000,
        markPrice: this.markPriceBySymbol.get(sym) ?? 2000,
        liquidationPrice: 1500,
        unRealizedProfit: this.unrealizedPnlBySymbol.get(sym) ?? 0,
        leverage: 2,
        marginType: "ISOLATED",
      });
    }
    return out;
  }
  async isHedgeMode(): Promise<boolean> {
    return this.hedge;
  }
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.leverageCalls.push({ symbol, leverage });
  }
  async setIsolatedMargin(): Promise<void> {}
  async getOpenOrders() {
    return [];
  }
  async getOpenAlgoOrders() {
    return [];
  }
  async queryAlgoOrder(_algoId: string): Promise<FuturesAlgoOrder> {
    const override = this.algoOrderOverrides.get(_algoId);
    return {
      symbol: "ETHUSDT",
      algoId: _algoId,
      clientAlgoId: "",
      algoStatus: override?.algoStatus ?? "NEW",
      orderType: "STOP_MARKET",
      side: "BUY",
      quantity: 0,
      triggerPrice: 0,
      actualOrderId: override ? override.actualOrderId : _algoId,
    };
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    // status stays decoupled from avgPrice — other call sites (e.g. TP1-fill polling) rely on
    // orderStatusById/the "NEW" default independent of whether a fill price has been confirmed.
    return this.stubOrder({
      orderId,
      status: this.orderStatusById.get(orderId) ?? "NEW",
      avgPrice: this.queryOrderAvgPriceBySymbol.get(symbol) ?? 0,
    });
  }
  async placeOrder(p: PlaceOrderParams): Promise<FuturesOrder> {
    if (this.failAddEntry && p.newClientOrderId?.endsWith("-a")) {
      throw new Error("request timed out after 6000ms");
    }
    if (p.type === "MARKET" && p.reduceOnly && this.failNextReduceOnlyMarketOrders > 0) {
      this.failNextReduceOnlyMarketOrders -= 1;
      throw new Error("fake transient network error during flatten");
    }
    this.placed.push(p);
    const orderId = String(this.nextOrderId++);
    if (p.type === "MARKET" && !p.reduceOnly) {
      this.positionsBySymbol.set(
        p.symbol,
        (this.positionsBySymbol.get(p.symbol) ?? 0) + (p.side === "BUY" ? 1 : -1) * p.quantity,
      );
      if (p.newClientOrderId?.startsWith("dtc-rescue-") && this.rescueFlipRealizedPnl != null) {
        this.trades.push({ symbol: p.symbol, orderId, price: 0, qty: p.quantity, realizedPnl: this.rescueFlipRealizedPnl, commission: 0, commissionAsset: "USDT", time: 1 });
      }
    }
    if (p.type === "MARKET" && p.reduceOnly) {
      this.positionsBySymbol.set(p.symbol, 0);
      if (this.flattenRealizedPnl != null) {
        this.trades.push({ symbol: p.symbol, orderId, price: 0, qty: p.quantity, realizedPnl: this.flattenRealizedPnl, commission: 0, commissionAsset: "USDT", time: 1 });
      }
    }
    const entryFill = this.marketFillPrice ?? 2000;
    return this.stubOrder({ orderId, status: "FILLED", avgPrice: p.type === "MARKET" && !p.reduceOnly ? entryFill : 0 });
  }
  async placeAlgoOrder(p: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    if (this.algoErrorCode != null) {
      throw new BinanceFuturesPrivateError("binance_error", `algo rejected ${this.algoErrorCode}`, { binanceCode: this.algoErrorCode, httpStatus: 400 });
    }
    this.placed.push({
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      quantity: p.quantity,
      stopPrice: p.triggerPrice,
      reduceOnly: p.reduceOnly,
      workingType: p.workingType,
      newClientOrderId: p.clientAlgoId,
    });
    const algoId = String(this.nextOrderId++);
    return {
      symbol: p.symbol,
      algoId,
      clientAlgoId: p.clientAlgoId ?? "",
      algoStatus: "NEW",
      orderType: p.type,
      side: p.side,
      quantity: p.quantity,
      triggerPrice: p.triggerPrice,
      actualOrderId: null,
    };
  }
  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    this.canceled.push({ symbol, orderId });
  }
  async cancelAlgoOrder(orderId: string): Promise<void> {
    this.canceled.push({ symbol: "ETHUSDT", orderId });
  }
  async cancelAllOrders(symbol: string): Promise<void> {
    this.cancelAllSymbols.push(symbol);
  }
  async cancelAllAlgoOrders(symbol: string): Promise<void> {
    this.cancelAllSymbols.push(symbol);
  }
  async getUserTrades(): Promise<FuturesUserTrade[]> {
    this.getUserTradesCalls += 1;
    if (this.getUserTradesCalls <= this.hideTradesForCalls) return [];
    return this.trades;
  }
  private stubOrder(overrides: Partial<FuturesOrder>): FuturesOrder {
    return {
      symbol: "ETHUSDT",
      orderId: "0",
      clientOrderId: "",
      status: "NEW",
      type: "MARKET",
      side: "SELL",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 0,
      executedQty: 0,
      avgPrice: 0,
      updateTime: 0,
      ...overrides,
    };
  }
}

export function paperOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    paperOrderId: `paper-${Math.random().toString(36).slice(2, 10)}`,
    symbol: "ETHUSDT",
    direction: "SHORT",
    entryPrice: 2000,
    stopLoss: 2100, // 5% stop
    takeProfitLevels: [1900],
    createdAt: "2099-01-02T00:00:00.000Z",
    paperStatus: "CREATED",
    paperOrderMode: "HEADLINE",
    diagnosticLabel: null,
    variantExitRule: "scaleout_tp1_trail",
    fillMode: "taker",
    ...overrides,
  } as unknown as PaperOrder;
}

export function makePaperStore(orders: PaperOrder[], halted = false): PaperStoreReader {
  return { all: orders, isAdmissionHalted: () => halted };
}

export function makeConfig(overrides: Partial<LiveExecutionConfig> = {}): LiveExecutionConfig {
  return {
    enabled: true,
    env: "testnet",
    apiKey: "k",
    apiSecret: "s",
    riskUsdPerTrade: 5,
    maxConcurrentPositions: 3,
    maxCorrelatedAltLongPositions: 3,
    maxCorrelatedAltShortPositions: 3,
    maxAggregateIntentRiskUsd: 5,
    maxClusterPositions: 3,
    dailyMaxLossUsd: 15,
    maxConsecutiveLosses: 5,
    consecutiveLossWindowHours: 24,
    scratchEpsilonUsd: 0.1,
    maxDrawdownUsd: 40,
    defaultLeverage: 3,
    maxLeverage: 2,
    maxNotionalPerTrade: 250,
    maxPaperOrderAgeMs: 24 * 60 * 60 * 1000,
    mirrorAllPaperOrders: false,
    testnetStratifiedCollection: false,
    mirrorProvenSymbolsOnly: false,
    testnetTakeProfitUsd: 0,
    testnetRegimeExitEnabled: true,
    testnetRegimeHardCutMs: 0, // hard-cut disabled by default; opted in per-test
    estimatedCloseCostPct: 0.0022,
    autoArm: false,
    mainnetConfirmed: false,
    mainnetKeepTestnetPolicy: false,
    mainnetProfitProtection: false,
    mainnetTpR: 0,
    mainnetRegimeHardCutMs: 30 * 60 * 1000,
    profitBankNetTargetUsd: 0,
    profitBankMode: "FLAT",
    profitBankTargetR: 1,
    regimeLossHardCutStopFraction: 0.5,
    forceMfeGiveback: false,
    losingMaxHoldMs: 0,
    laneSelectionLossResetUsd: 0.25,
    rescue: {
      enabled: false,
      minAgeMs: 60 * 60 * 1000,
      minLossUsd: 1,
      netFraction: 1,
      maxNotionalUsd: 250,
      targetUsd: 0,
      maxSymbols: 2,
      minAvailableBalanceUsd: 10,
      maxHoldMs: 24 * 60 * 60 * 1000,
    },
    rescueExecute: false,
    maxAggregateManualDirectionalNotionalUsd: 0,
    configErrors: [],
    ...overrides,
  };
}

export function makeEngine(opts: {
  client?: FakeLiveClient;
  paper?: PaperStoreReader;
  config?: Partial<LiveExecutionConfig>;
  isPaperOrderLiveEligible?: (order: PaperOrder, nowIso: string) => boolean;
  paperLaneGate?: (order: PaperOrder) => boolean | null;
  paperLaneWeightPct?: (order: PaperOrder) => number | null;
  getControllerSnapshot?: () => { regime: string | null; mode: string | null; confidence?: string | null; capturedAt?: string | null } | null;
  newEntryGate?: () => { allowed: boolean; reason: string | null };
  // 2026-08 manual-directional canonical-regime enforcement fix: optional, mirrors newEntryGate's
  // own plumbing exactly. Omitted (most existing tests) => LiveExecutionEngine's own
  // default-permissive fallback, matching production's default-permissive convention for an
  // options field with exactly one real (always-wired) call site.
  regimeSafetyGate?: () => { allowed: boolean; reason: string | null };
  nowIso?: () => string;
  marketDataClient?: Pick<BinanceClient, "getFuturesFlow">;
  externalManagedNetQty?: () => Map<string, number>;
  getExternalRealizedPnlUsd?: () => { today: number; allTime: number };
  onKillSwitchEngaged?: (reason: string) => Promise<void>;
  laneDirectionForId?: (laneId: string) => "LONG" | "SHORT" | "NEUTRAL" | null;
  cortexRealAttribution?: CortexRealAttributionStore;
  store?: LiveExecutionStore;
} = {}) {
  const client = opts.client ?? new FakeLiveClient();
  const store = opts.store ?? new LiveExecutionStore(tmp());
  const engine = new LiveExecutionEngine({
    config: makeConfig(opts.config),
    client: client as unknown as LivePrivateClient,
    store,
    paperStore: opts.paper ?? makePaperStore([]),
    isPaperOrderLiveEligible: opts.isPaperOrderLiveEligible,
    paperLaneGate: opts.paperLaneGate,
    paperLaneWeightPct: opts.paperLaneWeightPct,
    getControllerSnapshot: opts.getControllerSnapshot,
    newEntryGate: opts.newEntryGate,
    regimeSafetyGate: opts.regimeSafetyGate,
    nowIso: opts.nowIso ?? (() => "2099-01-02T12:00:00.000Z"),
    marketDataClient: opts.marketDataClient,
    fillConfirmRetryDelayMs: 0,
    externalManagedNetQty: opts.externalManagedNetQty,
    getExternalRealizedPnlUsd: opts.getExternalRealizedPnlUsd,
    onKillSwitchEngaged: opts.onKillSwitchEngaged,
    laneDirectionForId: opts.laneDirectionForId,
    cortexRealAttribution: opts.cortexRealAttribution,
  });
  return { engine, client, store };
}

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetLaneRuntimeForTests } from "../src/lib/lane-context-journal-runtime.js";
import {
  BinanceFuturesPrivateError,
  type FuturesAlgoOrder,
  type FuturesOrder,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
  type PlaceAlgoOrderParams,
  type PlaceOrderParams,
} from "../src/lib/binance-futures-private.js";
import {
  LiveExecutionEngine,
  LiveExecutionStore,
  MANUAL_ENTRY_DECISION_MAX_AGE_MS,
  combinedWorstCaseNotionalUsd,
  collectUserTradesSettlementCoverage,
  computeLiveOrderPlan,
  crowdingExitRecommendation,
  interleaveTestnetCollectionCandidates,
  isManualEntryDecisionStale,
  manualDirectionalLaneMismatchReason,
  parseLiveExecutionConfig,
  roundDownToStep,
  roundStopToSafeSide,
  roundUpToStep,
  shouldCapPyramidAdd,
  symbolBookNetAvgR,
  symbolPriorityTier,
  type LiveExecutionConfig,
  type LiveIntent,
  type LivePrivateClient,
  type PaperStoreReader,
  isLiveIntentReportingExcluded,
  sumLiveIntentReportingExclusions,
  reportedDailyLedger,
} from "../src/lib/live-execution-engine.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type SingleSymbolExecClient,
  type SingleSymbolFreshSignal,
} from "../src/lib/single-symbol-lane-executor.js";
import type { BinanceClient, FuturesFlowSnapshot } from "../src/lib/binance.js";
import { CortexRealAttributionStore } from "../src/lib/cortex-real-attribution.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";
import type { PerSymbolLaneBookEdgeReport } from "../src/lib/per-symbol-lane-book-edge.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-live-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const FILTERS: FuturesSymbolFilters = {
  symbol: "ETHUSDT",
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
  pricePrecision: 2,
  quantityPrecision: 3,
};

function settlementTrade(orderId: string, tradeId: string): FuturesUserTrade {
  return { symbol: "ETHUSDT", orderId, tradeId, price: 2_000, qty: 1, realizedPnl: 0, commission: 0.1, commissionAsset: "USDT", time: Number(tradeId) };
}

describe("userTrades settlement coverage", () => {
  it("continues after a saturated first page until required entry and exit fills are found", async () => {
    const first = Array.from({ length: 1_000 }, (_, index) => settlementTrade(`noise-${index}`, String(index + 1)));
    const second = [settlementTrade("entry-1", "1001"), settlementTrade("exit-1", "1002")];
    const cursors: Array<string | undefined> = [];
    const client = {
      async getUserTrades(_symbol: string, opts: { fromId?: string } = {}): Promise<FuturesUserTrade[]> {
        cursors.push(opts.fromId);
        return opts.fromId ? second : first;
      },
    } as Pick<LivePrivateClient, "getUserTrades">;
    const result = await collectUserTradesSettlementCoverage(client, "ETHUSDT", 0, ["entry-1", "exit-1"]);
    expect(result.settlementFetchComplete).toBe(true);
    expect(result.pageSaturated).toBe(true);
    expect(result.missingRequiredOrderIds).toEqual([]);
    expect(cursors).toEqual([undefined, "1001"]);
  });

  it("keeps a missing required entry diagnostic-only and deduplicates a fill repeated across pages", async () => {
    const duplicate = settlementTrade("exit-1", "2000");
    const first = [...Array.from({ length: 999 }, (_, index) => settlementTrade(`noise-${index}`, String(index + 1))), duplicate];
    const second = [duplicate, settlementTrade("exit-1", "2001")];
    const client = {
      async getUserTrades(_symbol: string, opts: { fromId?: string } = {}): Promise<FuturesUserTrade[]> {
        return opts.fromId ? second : first;
      },
    } as Pick<LivePrivateClient, "getUserTrades">;
    const result = await collectUserTradesSettlementCoverage(client, "ETHUSDT", 0, ["entry-missing", "exit-1"]);
    expect(result.settlementFetchComplete).toBe(false);
    expect(result.missingRequiredOrderIds).toEqual(["entry-missing"]);
    expect(result.trades.filter((trade) => trade.tradeId === "2000")).toHaveLength(1);
  });
});

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

// ── config ───────────────────────────────────────────────────────────────────

describe("parseLiveExecutionConfig", () => {
  it("is fully dormant by default", () => {
    const cfg = parseLiveExecutionConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it("enabled without env/keys reports config errors", () => {
    const cfg = parseLiveExecutionConfig({ LIVE_EXECUTION_ENABLED: "1" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.configErrors.join(" ")).toMatch(/LIVE_BINANCE_ENV/);
    expect(cfg.configErrors.join(" ")).toMatch(/API_KEY/);
  });

  it("mainnet requires the explicit confirm phrase", () => {
    const base = { LIVE_EXECUTION_ENABLED: "1", LIVE_BINANCE_ENV: "mainnet", LIVE_BINANCE_API_KEY: "k", LIVE_BINANCE_API_SECRET: "s" };
    expect(parseLiveExecutionConfig(base).configErrors.join(" ")).toMatch(/LIVE_MAINNET_CONFIRM/);
    expect(
      parseLiveExecutionConfig({ ...base, LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY" }).configErrors,
    ).toEqual([]);
  });

  it("auto-arm: testnet needs only the flag; mainnet additionally needs the explicit token", () => {
    const mainnetBase = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "mainnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
      LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
    };
    expect(
      parseLiveExecutionConfig({ LIVE_EXECUTION_ENABLED: "1", LIVE_BINANCE_ENV: "testnet", LIVE_BINANCE_API_KEY: "k", LIVE_BINANCE_API_SECRET: "s", LIVE_AUTO_ARM: "1" }).autoArm,
    ).toBe(true);
    // Bare flag on mainnet stays inert — real money never auto-arms from LIVE_AUTO_ARM alone.
    expect(parseLiveExecutionConfig({ ...mainnetBase, LIVE_AUTO_ARM: "1" }).autoArm).toBe(false);
    // Token alone (no flag) is also inert.
    expect(
      parseLiveExecutionConfig({ ...mainnetBase, LIVE_AUTO_ARM_MAINNET_CONFIRM: "I_UNDERSTAND_AUTO_ARM_REAL_MONEY" }).autoArm,
    ).toBe(false);
    // A wrong token value must not count.
    expect(
      parseLiveExecutionConfig({ ...mainnetBase, LIVE_AUTO_ARM: "1", LIVE_AUTO_ARM_MAINNET_CONFIRM: "yes" }).autoArm,
    ).toBe(false);
    // Flag + exact token = deliberate mainnet auto-arm opt-in (2026-07-07 operator request:
    // restarts always boot disarmed, and live's frequent deploy/OOM restarts silently benched it).
    expect(
      parseLiveExecutionConfig({ ...mainnetBase, LIVE_AUTO_ARM: "1", LIVE_AUTO_ARM_MAINNET_CONFIRM: "I_UNDERSTAND_AUTO_ARM_REAL_MONEY" }).autoArm,
    ).toBe(true);
  });

  it("mainnet can explicitly reuse the testnet live-mirror lane policy", () => {
    const base = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "mainnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
      LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
    };
    expect(parseLiveExecutionConfig(base).mainnetKeepTestnetPolicy).toBe(false);
    expect(
      parseLiveExecutionConfig({
        ...base,
        LIVE_MAINNET_KEEP_TESTNET_POLICY: "1",
      }).mainnetKeepTestnetPolicy,
    ).toBe(true);
  });

  it("mirror-all is testnet-only", () => {
    const base = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
      LIVE_MIRROR_ALL_PAPER: "1",
    };
    expect(parseLiveExecutionConfig({ ...base, LIVE_BINANCE_ENV: "testnet" }).mirrorAllPaperOrders).toBe(true);
    expect(parseLiveExecutionConfig({
      ...base,
      LIVE_BINANCE_ENV: "mainnet",
      LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
    }).mirrorAllPaperOrders).toBe(false);
  });

  it("testnet stratified collection is explicitly testnet-only", () => {
    const base = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
      LIVE_TESTNET_STRATIFIED_COLLECTION: "1",
    };
    expect(parseLiveExecutionConfig({ ...base, LIVE_BINANCE_ENV: "testnet" }).testnetStratifiedCollection).toBe(true);
    expect(parseLiveExecutionConfig({
      ...base,
      LIVE_BINANCE_ENV: "mainnet",
      LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
    }).testnetStratifiedCollection).toBe(false);
  });

  it("interleaves testnet collection by least-observed lane, direction, and entry regime", () => {
    const candidates = [
      { paper: paperOrder({ paperOrderId: "bear-1", selectedLaneId: "LANE_BEAR", direction: "SHORT", regime: "Bearish pressure" }) },
      { paper: paperOrder({ paperOrderId: "bear-2", selectedLaneId: "LANE_BEAR", direction: "SHORT", regime: "Bearish pressure" }) },
      { paper: paperOrder({ paperOrderId: "bull-1", selectedLaneId: "LANE_BULL", direction: "LONG", regime: "Bullish expansion" }) },
      { paper: paperOrder({ paperOrderId: "mixed-1", selectedLaneId: "LANE_MIX", direction: "SHORT", regime: "Mixed rotation" }) },
    ];
    const ordered = interleaveTestnetCollectionCandidates(candidates, new Map([
      ["LANE_BEAR|SHORT|BEARISH", 9],
      ["LANE_BULL|LONG|BULLISH", 1],
      ["LANE_MIX|SHORT|MIXED", 1],
    ]));
    expect(ordered.map((candidate) => candidate.paper.paperOrderId)).toEqual(["bull-1", "mixed-1", "bear-1", "bear-2"]);
  });

  it("testnet USD take-profit is testnet-only and disabled unless configured", () => {
    const base = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
      LIVE_TESTNET_TP_USD: "20",
    };
    expect(parseLiveExecutionConfig({ ...base, LIVE_BINANCE_ENV: "testnet" }).testnetTakeProfitUsd).toBe(20);
    expect(parseLiveExecutionConfig({
      ...base,
      LIVE_BINANCE_ENV: "mainnet",
      LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
    }).testnetTakeProfitUsd).toBe(0);
    expect(parseLiveExecutionConfig({ ...base, LIVE_BINANCE_ENV: "testnet", LIVE_TESTNET_TP_USD: "0" }).testnetTakeProfitUsd).toBe(0);
  });

  it("testnet regime-opposition breakeven exit defaults on and can be disabled", () => {
    const base = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "testnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
    };
    expect(parseLiveExecutionConfig(base).testnetRegimeExitEnabled).toBe(true);
    expect(parseLiveExecutionConfig({ ...base, LIVE_TESTNET_REGIME_EXIT: "0" }).testnetRegimeExitEnabled).toBe(false);
    expect(parseLiveExecutionConfig(base).estimatedCloseCostPct).toBeCloseTo(0.0022, 8);
  });

  it("can disable only testnet's automatic account-level kill switch", () => {
    const testnet = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "testnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
    };
    expect(parseLiveExecutionConfig(testnet).autoKillSwitchEnabled).toBe(true);
    expect(parseLiveExecutionConfig({ ...testnet, LIVE_TESTNET_AUTO_KILL_SWITCH: "0" }).autoKillSwitchEnabled).toBe(false);

    const mainnet = {
      ...testnet,
      LIVE_BINANCE_ENV: "mainnet",
      LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
      LIVE_TESTNET_AUTO_KILL_SWITCH: "0",
    };
    expect(parseLiveExecutionConfig(mainnet).autoKillSwitchEnabled).toBe(true);
  });

  it("defaults correlated-alt caps and stop-distance loss hard-cut, with env overrides", () => {
    const base = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "testnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
    };
    const defaults = parseLiveExecutionConfig(base);
    expect(defaults.maxCorrelatedAltLongPositions).toBe(3);
    expect(defaults.maxCorrelatedAltShortPositions).toBe(3);
    expect(defaults.regimeLossHardCutStopFraction).toBe(0.5);

    const overridden = parseLiveExecutionConfig({
      ...base,
      LIVE_MAX_CORRELATED_ALT_LONGS: "2",
      LIVE_MAX_CORRELATED_ALT_SHORTS: "4",
      LIVE_REGIME_LOSS_HARD_CUT_STOP_FRACTION: "0.35",
    });
    expect(overridden.maxCorrelatedAltLongPositions).toBe(2);
    expect(overridden.maxCorrelatedAltShortPositions).toBe(4);
    expect(overridden.regimeLossHardCutStopFraction).toBe(0.35);
  });

  it("profitBankNetTargetUsd defaults off and parses on either env, explicit 0 stays off", () => {
    const testnetBase = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "testnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
    };
    expect(parseLiveExecutionConfig(testnetBase).profitBankNetTargetUsd).toBe(0);
    expect(
      parseLiveExecutionConfig({ ...testnetBase, LIVE_PROFIT_BANK_NET_TARGET_USD: "1" }).profitBankNetTargetUsd,
    ).toBe(1);
    expect(
      parseLiveExecutionConfig({ ...testnetBase, LIVE_PROFIT_BANK_NET_TARGET_USD: "0" }).profitBankNetTargetUsd,
    ).toBe(0);

    const mainnetBase = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "mainnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
      LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
    };
    expect(
      parseLiveExecutionConfig({ ...mainnetBase, LIVE_PROFIT_BANK_NET_TARGET_USD: "1" }).profitBankNetTargetUsd,
    ).toBe(1);

    // 2026-07-12 Stage 4: profit-bank MODE is opt-in, defaults FLAT, R target defaults 1.
    const dflt = parseLiveExecutionConfig(testnetBase);
    expect(dflt.profitBankMode).toBe("FLAT");
    expect(dflt.profitBankTargetR).toBe(1);
    const rBased = parseLiveExecutionConfig({ ...testnetBase, LIVE_PROFIT_BANK_MODE: "R_BASED", LIVE_PROFIT_BANK_TARGET_R: "2.5" });
    expect(rBased.profitBankMode).toBe("R_BASED");
    expect(rBased.profitBankTargetR).toBe(2.5);
    // Any non-"R_BASED" value stays FLAT (safe default).
    expect(parseLiveExecutionConfig({ ...testnetBase, LIVE_PROFIT_BANK_MODE: "garbage" }).profitBankMode).toBe("FLAT");
  });

  it("mainnet profit-protection is opt-in and mainnet-only; R-based TP parses", () => {
    const mainnet = {
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "mainnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
      LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
    };
    // Off by default — mainnet historically had NO regime exit / profit bank.
    expect(parseLiveExecutionConfig(mainnet).mainnetProfitProtection).toBe(false);
    expect(parseLiveExecutionConfig(mainnet).mainnetTpR).toBe(0);
    // Opt-in.
    const on = parseLiveExecutionConfig({ ...mainnet, LIVE_MAINNET_PROFIT_PROTECTION: "1", LIVE_MAINNET_TP_R: "3" });
    expect(on.mainnetProfitProtection).toBe(true);
    expect(on.mainnetTpR).toBe(3);
    expect(on.mainnetRegimeHardCutMs).toBe(30 * 60 * 1000);
    // The flag does nothing on testnet (mainnet-only).
    expect(parseLiveExecutionConfig({
      LIVE_EXECUTION_ENABLED: "1", LIVE_BINANCE_ENV: "testnet", LIVE_BINANCE_API_KEY: "k", LIVE_BINANCE_API_SECRET: "s",
      LIVE_MAINNET_PROFIT_PROTECTION: "1",
    }).mainnetProfitProtection).toBe(false);
  });

  it("uses a 3x default leverage and caps EXP lanes at LIVE_MAX_LEVERAGE", () => {
    const cfg = parseLiveExecutionConfig({
      LIVE_EXECUTION_ENABLED: "1",
      LIVE_BINANCE_ENV: "testnet",
      LIVE_BINANCE_API_KEY: "k",
      LIVE_BINANCE_API_SECRET: "s",
      LIVE_MAX_LEVERAGE: "10",
      LIVE_DEFAULT_LEVERAGE: "3",
    });
    expect(cfg.maxLeverage).toBe(10);
    expect(cfg.defaultLeverage).toBe(3);
  });
});

// ── sizing ───────────────────────────────────────────────────────────────────

describe("computeLiveOrderPlan", () => {
  it("sizes risk/stopDistance and rounds to exchange filters", () => {
    // risk $5 over a 5% stop → $100 notional → 0.05 ETH at $2000.
    const plan = computeLiveOrderPlan(
      { direction: "SHORT", entryPrice: 2000, stopLoss: 2100, tp1: 1900 },
      { riskUsdPerTrade: 5, maxNotionalPerTrade: 250 },
      FILTERS,
    );
    expect(plan.ok).toBe(true);
    expect(plan.qty).toBeCloseTo(0.05, 9);
    expect(plan.tp1Qty).toBeCloseTo(0.025, 9);
    expect(plan.notionalUsd).toBeCloseTo(100, 6);
    expect(plan.plannedRiskUsd).toBe(5);
    expect(plan.requiredNotionalUsd).toBeCloseTo(100, 6);
    expect(plan.appliedNotionalUsd).toBeCloseTo(100, 6);
    expect(plan.notionalCapUsd).toBe(250);
    expect(plan.stopDistancePct).toBeCloseTo(0.05, 9);
    expect(plan.effectiveRiskUsd).toBeCloseTo(5, 6);
    expect(plan.riskClippedByNotionalCap).toBe(false);
    expect(plan.stopPrice).toBeCloseTo(2100, 9);
    expect(plan.tp1Price).toBeCloseTo(1900, 9);
  });

  it("caps notional, rejects sub-minimum and wrong-side geometry", () => {
    // 0.1% stop → raw notional $5000 → capped at $250.
    const capped = computeLiveOrderPlan(
      { direction: "LONG", entryPrice: 2000, stopLoss: 1998, tp1: 2010 },
      { riskUsdPerTrade: 5, maxNotionalPerTrade: 250 },
      FILTERS,
    );
    expect(capped.ok).toBe(true);
    expect(capped.notionalUsd).toBeLessThanOrEqual(250);
    expect(capped.plannedRiskUsd).toBe(5);
    expect(capped.requiredNotionalUsd).toBeCloseTo(5000, 6);
    expect(capped.appliedNotionalUsd).toBeLessThanOrEqual(250);
    expect(capped.notionalCapUsd).toBe(250);
    expect(capped.stopDistancePct).toBeCloseTo(0.001, 9);
    expect(capped.riskClippedByNotionalCap).toBe(true);

    const tooSmall = computeLiveOrderPlan(
      { direction: "LONG", entryPrice: 2000, stopLoss: 1000, tp1: 3000 },
      { riskUsdPerTrade: 0.001, maxNotionalPerTrade: 250 },
      FILTERS,
    );
    expect(tooSmall.ok).toBe(false);

    const wrongSide = computeLiveOrderPlan(
      { direction: "LONG", entryPrice: 2000, stopLoss: 2100, tp1: 2200 },
      { riskUsdPerTrade: 5, maxNotionalPerTrade: 250 },
      FILTERS,
    );
    expect(wrongSide.ok).toBe(false);
  });

  it("rejects a TP too tight to clear round-trip costs (the malformed mode-2 geometry)", () => {
    // SHORT: entry 2000, stop 2100 (5%), tp1 1997 = 0.15% below entry → can't beat fees.
    const tooTight = computeLiveOrderPlan(
      { direction: "SHORT", entryPrice: 2000, stopLoss: 2100, tp1: 1997 },
      { riskUsdPerTrade: 5, maxNotionalPerTrade: 250 },
      FILTERS,
    );
    expect(tooTight.ok).toBe(false);
    expect(tooTight.reason).toMatch(/tp too close/i);

    // Coherent 0.5R geometry (tp1 1950 = 2.5% below entry) passes the gate.
    const coherent = computeLiveOrderPlan(
      { direction: "SHORT", entryPrice: 2000, stopLoss: 2100, tp1: 1950 },
      { riskUsdPerTrade: 5, maxNotionalPerTrade: 250 },
      FILTERS,
    );
    expect(coherent.ok).toBe(true);
  });

  it("roundDownToStep avoids float artifacts", () => {
    expect(roundDownToStep(0.0500000001, 0.001)).toBeCloseTo(0.05, 12);
    expect(roundDownToStep(2.5000000004, 0.1)).toBeCloseTo(2.5, 12);
  });

  it("roundStopToSafeSide rounds the stop AWAY from the fill (SHORT up, LONG down) — never -2021", () => {
    // The adversarial case: coarse tick + tiny stop distance. A SHORT buy-stop at 50005 must round
    // UP to 50010 (strictly above the 50000 fill), NOT down to 50000 (== fill → -2021).
    expect(roundStopToSafeSide("SHORT", 50005, 10)).toBe(50010);
    // A LONG sell-stop rounds DOWN, staying strictly below the fill.
    expect(roundStopToSafeSide("LONG", 49995, 10)).toBe(49990);
    expect(roundUpToStep(50000.0001, 10)).toBe(50010);
    expect(roundUpToStep(50000, 10)).toBe(50000); // exact multiple is unchanged
  });
});

// ── engine behavior ──────────────────────────────────────────────────────────

describe("LiveExecutionEngine", () => {
  it("disarmed engine never places orders even with fresh headline signals", async () => {
    const { engine, client } = makeEngine({ paper: makePaperStore([paperOrder()]) });
    await engine.tick();
    expect(client.placed.length).toBe(0);
    expect(engine.isArmed()).toBe(false);
  });

  it("new-entry drain blocks fresh opens while the engine remains armed", async () => {
    const { engine, client, store } = makeEngine({ paper: makePaperStore([paperOrder()]) });
    expect((await engine.arm()).ok).toBe(true);
    engine.setNewEntriesPaused(true, "test drain");
    await engine.tick();
    expect(client.placed.length).toBe(0);
    expect(store.getState().intents.length).toBe(0);
    expect(engine.getStatus()).toMatchObject({
      armed: true,
      newEntries: { allowed: false, drainActive: true, pauseReason: "test drain" },
    });
  });

  it("new-entry drain does not stop lifecycle settlement for an already-open position", async () => {
    const order = paperOrder({ variantExitRule: "tp1_full" });
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    engine.setNewEntriesPaused(true, "drain existing exposure");
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set(intent.symbol, 0);
    client.trades = [
      { symbol: intent.symbol, orderId: intent.tp1OrderId!, price: 1900, qty: intent.qty, realizedPnl: 1, commission: 0.01, commissionAsset: "USDT", time: 1 },
    ];
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(engine.isArmed()).toBe(true);
  });

  it("tp1_full lane banks 100% at TP1 — full-qty LIMIT, settles flat with no runner/breakeven replace", async () => {
    const order = paperOrder({ variantExitRule: "tp1_full" });
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);

    // Tick 1: mirror — the TP1 LIMIT is the FULL position (0.05), not half (0.025 for scaleout).
    await engine.tick();
    expect(client.placed.map((p) => p.type)).toEqual(["MARKET", "STOP_MARKET", "LIMIT"]);
    const [, stop, tp1] = client.placed;
    expect(stop!.quantity).toBeCloseTo(0.05, 9); // stop still protects the full position
    expect(tp1!.quantity).toBeCloseTo(0.05, 9); // FULL exit at TP1
    const intent = store.getState().intents[0]!;

    // TP1 fills the whole position → flat → settles directly via the "position flat" path.
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: intent.tp1OrderId!, price: 1900, qty: 0.05, realizedPnl: 5, commission: 0.04, commissionAsset: "USDT", time: 1 },
    ];
    const placedBefore = client.placed.length;
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(client.placed.length).toBe(placedBefore); // NO breakeven STOP_MARKET — there is no runner
  });

  it("mfe_giveback lane tracks favorable R and closes on giveback instead of creating a runner", async () => {
    const order = paperOrder({
      selectedLaneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK",
      variantExitRule: "mfe_giveback",
      takeProfitLevels: [1700], // far 3R target with a 5% stop
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);

    await engine.tick();
    expect(client.placed.map((p) => p.type)).toEqual(["MARKET", "STOP_MARKET", "LIMIT"]);
    const tp = client.placed.at(-1)!;
    expect(tp.quantity).toBeCloseTo(0.05, 9); // full far-TP, no 50% runner split
    expect(tp.price).toBeCloseTo(1700, 9);

    client.markPriceBySymbol.set("ETHUSDT", 1900); // +1R favorable on a short
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(store.getState().intents[0]!.maxFavorableR).toBeCloseTo(1, 6);

    client.markPriceBySymbol.set("ETHUSDT", 1950); // retraces to +0.5R; default giveback threshold
    client.flattenRealizedPnl = 2.2;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("MFE_GIVEBACK_EXIT");
    expect(closed.realizedPnlUsd).toBeCloseTo(2.2, 6);
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
    expect(store.getState().dailyLedger.wins).toBe(1);
  });

  it("full lifecycle: mirror → entry+stop+tp1 → TP1 fill ⇒ breakeven replace → close ⇒ settled", async () => {
    const order = paperOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);

    // Tick 1: mirror — MARKET entry, STOP_MARKET (full, reduce-only), LIMIT tp1 (half).
    await engine.tick();
    expect(client.placed.map((p) => p.type)).toEqual(["MARKET", "STOP_MARKET", "LIMIT"]);
    const [entry, stop, tp1] = client.placed;
    expect(entry!.side).toBe("SELL");
    expect(entry!.quantity).toBeCloseTo(0.05, 9);
    expect(stop!.reduceOnly).toBe(true);
    expect(stop!.stopPrice).toBeCloseTo(2100, 9);
    expect(tp1!.reduceOnly).toBe(true);
    expect(tp1!.quantity).toBeCloseTo(0.025, 9);
    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");

    // No duplicate on the next tick (watermark + dedupe).
    await engine.tick();
    expect(client.placed.length).toBe(3);

    // TP1 fills; remaining runner −0.025.
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set("ETHUSDT", -0.025);
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("TP1_FILLED_BE_SET");
    expect(client.canceled.some((c) => c.orderId === intent.stopOrderId)).toBe(true);
    const be = client.placed.at(-1)!;
    expect(be.type).toBe("STOP_MARKET");
    expect(be.stopPrice).toBeCloseTo(2000, 9); // breakeven at the filled entry
    expect(be.quantity).toBeCloseTo(0.025, 9);

    // Position goes flat; realized PnL settles from userTrades.
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: intent.tp1OrderId!, price: 1900, qty: 0.025, realizedPnl: 2.5, commission: 0.02, commissionAsset: "USDT", time: 1 },
      { symbol: "ETHUSDT", orderId: store.getState().intents[0]!.beStopOrderId!, price: 2000, qty: 0.025, realizedPnl: 0, commission: 0.02, commissionAsset: "USDT", time: 2 },
    ];
    await engine.tick();
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.realizedPnlUsd).toBeCloseTo(2.46, 6);
    expect(store.getState().dailyLedger.wins).toBe(1);
    expect(store.getState().consecutiveLosses).toBe(0);
  });

  it("market-closes the runner when breakeven stop placement would immediately trigger", async () => {
    const order = paperOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    const intent = store.getState().intents[0]!;
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set("ETHUSDT", -0.025);
    client.algoErrorCode = -2021;
    client.flattenRealizedPnl = 0.12;

    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("BREAKEVEN_ALREADY_TOUCHED_MARKET_CLOSE");
    expect(closed.realizedPnlUsd).toBeCloseTo(0.12, 6);
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
    expect(flat.quantity).toBeCloseTo(0.025, 9);
  });

  it("testnet USD TP closes a profitable open position before the original TP", async () => {
    const order = paperOrder();
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { testnetTakeProfitUsd: 20 },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    const intent = store.getState().intents[0]!;
    client.markPriceBySymbol.set("ETHUSDT", 1500); // short from 2000 → own-entry unrealized clears $20
    client.flattenRealizedPnl = 20.12;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("PROFIT_BANK_NET_20.00");
    expect(closed.realizedPnlUsd).toBeCloseTo(20.12, 6);
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
    expect(flat.side).toBe("BUY");
    expect(client.cancelAllSymbols).toContain("ETHUSDT");
    expect(store.getState().dailyLedger.wins).toBe(1);
    expect(store.getState().consecutiveLosses).toBe(0);
    expect(client.orderStatusById.get(intent.tp1OrderId!)).toBeUndefined();
  });

  it("profit-bank net target closes a SHORT position (any lane) once net-of-cost clears the flat $1 target", async () => {
    const order = paperOrder(); // SHORT, no special lane — proves this is no longer LONG/lane-restricted.
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { testnetTakeProfitUsd: 0, profitBankNetTargetUsd: 1 },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    client.markPriceBySymbol.set("ETHUSDT", 1900); // short from 2000: own-entry unrealized ~5 clears the $1 target
    client.flattenRealizedPnl = 1.02;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("PROFIT_BANK_NET_1.00");
    expect(closed.realizedPnlUsd).toBeCloseTo(1.02, 6);
  });

  it("waits for the just-placed close trade instead of booking entry commission as a fake loss", async () => {
    const order = paperOrder();
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore([order]),
      config: { profitBankNetTargetUsd: 1 },
    });
    await engine.arm();
    await engine.tick();

    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.flattenRealizedPnl = 1.25;
    client.hideTradesForCalls = 1;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(client.getUserTradesCalls).toBeGreaterThanOrEqual(2);
    expect(closed.state).toBe("CLOSED");
    expect(closed.realizedPnlUsd).toBeCloseTo(1.25, 6);
    expect(store.getState().dailyLedger.wins).toBe(1);
  });

  it("profit-bank net target stays open when gross unrealized crosses $1 but net-of-cost does not", async () => {
    const order = paperOrder();
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { testnetTakeProfitUsd: 0, profitBankNetTargetUsd: 1 },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const placedBefore = client.placed.length;

    client.markPriceBySymbol.set("ETHUSDT", 1990); // own-entry unrealized ~0.5 — below the $1 net target
    await engine.tick();

    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(client.placed.length).toBe(placedBefore);
  });

  it("profit-bank net target takes priority over the legacy mainnet R-based threshold when both are set", async () => {
    const order = paperOrder({
      direction: "LONG",
      stopLoss: 1900,
      takeProfitLevels: [2300],
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: {
        env: "mainnet",
        mainnetConfirmed: true,
        mainnetProfitProtection: true,
        mainnetTpR: 3, // would require unrealized >= 15 (3 * riskUsdPerTrade=5) — the net target should win instead.
        profitBankNetTargetUsd: 1,
      },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    client.markPriceBySymbol.set("ETHUSDT", 2100); // long from 2000: own-entry unrealized clears the $1 target
    client.flattenRealizedPnl = 1.02;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("PROFIT_BANK_NET_1.00");
  });

  // [PROFIT-BANK-R-BASED, 2026-07-12 Stage 4 fix]: the opt-in R_BASED mode scales the bank to the
  // position's OWN effective risk-at-stop (profitBankTargetR × effectiveRiskUsd), so a wider-stop
  // position runs proportionally further before banking instead of truncating at a flat $1.
  it("R_BASED profit-bank does NOT close at $1 when the position's own R target is higher (default FLAT would have)", async () => {
    // stop 1900 on entry 2000 = 5% stop; $50 cap notional ⇒ effectiveRiskUsd ≈ $2.50. targetR=2 ⇒
    // bank target ≈ $5.00. An own-entry unrealized of ~$2 (mark 2080) clears the FLAT $1 but NOT the
    // $5 R-based target, so R_BASED keeps it open where FLAT would have banked.
    const order = paperOrder({ direction: "LONG", stopLoss: 1900, takeProfitLevels: [2300] } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { profitBankNetTargetUsd: 1, profitBankMode: "R_BASED", profitBankTargetR: 2, maxNotionalPerTrade: 50 },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const placedBefore = client.placed.length;
    const eff = store.getState().intents[0]!.effectiveRiskUsd ?? 0;
    expect(eff).toBeGreaterThan(0);
    expect(eff).toBeLessThan(5); // clipped by the $50 cap, well below the nominal $5 risk

    client.markPriceBySymbol.set("ETHUSDT", 2080); // own-entry unrealized clears $1 flat but not 2×R
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN"); // R_BASED let it run
    expect(client.placed.length).toBe(placedBefore);
  });

  it("R_BASED profit-bank DOES close once the position clears its own R target", async () => {
    const order = paperOrder({ direction: "LONG", stopLoss: 1900, takeProfitLevels: [2300] } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { profitBankNetTargetUsd: 1, profitBankMode: "R_BASED", profitBankTargetR: 2, maxNotionalPerTrade: 50 },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const eff = store.getState().intents[0]!.effectiveRiskUsd ?? 0;
    const qty = store.getState().intents[0]!.qty;
    // Move mark far enough that own-entry unrealized (mark-2000)*qty comfortably clears 2×eff + cost.
    const targetUnrealized = 2 * eff + 5;
    const mark = 2000 + targetUnrealized / qty;
    client.markPriceBySymbol.set("ETHUSDT", mark);
    client.flattenRealizedPnl = 2 * eff;
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(store.getState().intents[0]!.closeReason).toMatch(/^PROFIT_BANK_NET_/);
  });

  it("mainnet CG_WIDE_LONG_RUNNER closes immediately once unrealized clears estimated close cost", async () => {
    const order = paperOrder({
      direction: "LONG",
      stopLoss: 1900,
      takeProfitLevels: [2300],
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER",
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { env: "mainnet", mainnetConfirmed: true },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    const intent = store.getState().intents[0]!;
    // 2026-07-26: the sweep is now conditional on the lane being genuinely DE-ALLOCATED here, so
    // the scenario must state that — and it states it the way it actually happens: the position
    // opened while the lane was funded, THEN the operator dropped it from the table, stranding an
    // orphan whose TP1/SL geometry no longer belongs to any funded lane. That orphan is precisely
    // what this emergency sweep exists for. The companion test below covers the still-funded case.
    expect(engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]).ok).toBe(true);
    client.markPriceBySymbol.set("ETHUSDT", 2010); // long from 2000: own-entry unrealized ~0.5 > ~0.2 close cost
    client.flattenRealizedPnl = 0.03;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST");
    expect(closed.realizedPnlUsd).toBeCloseTo(0.03, 6);
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
    expect(flat.side).toBe("SELL");
    expect(client.cancelAllSymbols).toContain("ETHUSDT");
    // A +$0.03 breakeven-after-cost close is a SCRATCH, not a win — it must not touch the
    // win/loss tally (which feeds the consecutive-loss kill-switch). See the scratch-ledger tests.
    expect(store.getState().dailyLedger.wins).toBe(0);
    expect(store.getState().dailyLedger.scratches).toBe(1);
    expect(intent.tp1OrderId).not.toBeNull();
  });

  // 2026-07-26 fail-without/pass-with for the allocation-aware guard. Before it, membership in
  // LIVE_BREAKEVEN_EXIT_LANE_IDS was the ONLY condition, so a lane the operator had re-funded was
  // still swept at ~breakeven — the exact recurrence of the 2026-07-10 CG_WIDE_FAST_LONG bug,
  // caught on testnet where CG_WIDE_LONG_RUNNER carries a real 10% weight (40 trades, +$1.96
  // realized vs +$76.12 for letting them reach their own geometry). This test fails without the
  // guard: the intent closes as LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST instead of running on.
  it("2026-07-26 fix: a FUNDED CG_WIDE_LONG_RUNNER is NOT swept at breakeven — it keeps its own TP/SL", async () => {
    const order = paperOrder({
      direction: "LONG",
      stopLoss: 1900,
      takeProfitLevels: [2300],
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER",
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { env: "mainnet", mainnetConfirmed: true },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    // The operator KEEPS the lane funded — testnet's real shape (10% weight). This is the only
    // difference from the test above, and it is the whole fix.
    expect(engine.setLaneAllocations([{ laneId: "CG_WIDE_LONG_RUNNER", weightPct: 10 }]).ok).toBe(true);

    client.markPriceBySymbol.set("ETHUSDT", 2010); // same net-positive tick as the test above
    client.flattenRealizedPnl = 0.03;
    await engine.tick();

    const held = store.getState().intents[0]!;
    expect(held.state).not.toBe("CLOSED");
    expect(held.closeReason).toBeNull();
    expect(held.tp1OrderId).not.toBeNull(); // its real 2300 target is still working
    expect(store.getState().dailyLedger.scratches ?? 0).toBe(0);
  });

  it("mainnet CG_WIDE_LONG_RUNNER stays open while still negative after estimated close cost", async () => {
    const order = paperOrder({
      direction: "LONG",
      stopLoss: 1900,
      takeProfitLevels: [2300],
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER",
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { env: "mainnet", mainnetConfirmed: true },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const placedBefore = client.placed.length;

    client.markPriceBySymbol.set("ETHUSDT", 2002); // own-entry unrealized ~0.1 — below the close-cost buffer
    await engine.tick();

    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(client.placed.length).toBe(placedBefore);
  });

  it("2026-07-10 fix: CG_WIDE_FAST_LONG stays OPEN once net-positive after cost — no longer swept by the emergency-exit lane list", async () => {
    // Regression pin for the fix itself: this test used to assert the OPPOSITE (an immediate
    // sweep close, identical to CG_WIDE_LONG_RUNNER's). A research audit found CG_WIDE_FAST_LONG
    // was still on LIVE_BREAKEVEN_EXIT_LANE_IDS ("removed lane" emergency-exit) despite being back
    // in live's active lane allocation (8% weight) — every real winner was being capped near
    // breakeven instead of ever reaching its own tp1_full target. Operator-confirmed fix: removed
    // from the sweep list. CG_WIDE_LONG_RUNNER (genuinely not in live allocation) keeps the old
    // behavior — see the "mainnet CG_WIDE_LONG_RUNNER closes immediately..." test above, unchanged.
    const order = paperOrder({
      direction: "LONG",
      stopLoss: 1900,
      takeProfitLevels: [2300],
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { env: "testnet", testnetTakeProfitUsd: 0 }, // isolate from the testnet USD-TP path
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const placedBefore = client.placed.length;

    client.markPriceBySymbol.set("ETHUSDT", 2010); // long from 2000: own-entry unrealized ~0.5 > ~0.2 close cost
    await engine.tick();

    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(client.placed.length).toBe(placedBefore); // no new close order placed
    expect(client.cancelAllSymbols).not.toContain("ETHUSDT");
  });

  it("2026-07-10 fix: CG_WIDE_FAST_LONG still closes normally at its own real tp1_full target (untouched by the fix)", async () => {
    const order = paperOrder({
      direction: "LONG",
      stopLoss: 1900,
      takeProfitLevels: [2300],
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
      variantExitRule: "tp1_full",
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { env: "testnet", testnetTakeProfitUsd: 0 },
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;

    // TP1 (the real, full-size target) fills.
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: intent.tp1OrderId!, price: 2300, qty: 0.05, realizedPnl: 15, commission: 0.05, commissionAsset: "USDT", time: 1 },
    ];
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).not.toBe("LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST");
    expect(closed.realizedPnlUsd).toBeGreaterThan(0);
  });

  // 2026-07-26 exit-policy change. This scenario (green, counter-regime, no controller flip) used
  // to close instantly as REGIME_OPPOSITION_BREAKEVEN_LONG_ONLY. Measured on testnet's own ledger,
  // that harvest was the costly one, so the position now defers to its own stop/TP for
  // OPPOSITION_BREAKEVEN_DEFER_MS (24h) first. Both halves are asserted: defer, then close.
  function greenOpposingShortEngine(clock: { iso: string }) {
    const order = paperOrder(); // SHORT.
    return makeEngine({
      paper: makePaperStore([order]),
      nowIso: () => clock.iso,
      getControllerSnapshot: () => ({
        regime: "Bullish expansion",
        mode: "LONG_ONLY",
        capturedAt: new Date().toISOString(),
      }),
    });
  }

  it("regime-opposition harvest DEFERS a green counter-regime position instead of banking it at breakeven", async () => {
    const clock = { iso: "2099-01-02T12:00:00.000Z" };
    const { engine, client, store } = greenOpposingShortEngine(clock);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.0); // cost buffer is about 0.21 USDT.
    client.flattenRealizedPnl = 0.78;
    const placedBefore = client.placed.length;
    await engine.tick();

    const held = store.getState().intents[0]!;
    expect(held.state).not.toBe("CLOSED");
    expect(held.closeReason).toBeNull();
    expect(held.oppositionBreakevenDeferredAt).toBe("2099-01-02T12:00:00.000Z");
    expect(client.placed.length).toBe(placedBefore); // no flatten order placed
    expect(store.getState().dailyLedger.wins).toBe(0);

    // Still inside the backstop 23h later — and the anchor must NOT drift forward on re-ticks.
    clock.iso = "2099-01-03T11:00:00.000Z";
    await engine.tick();
    expect(store.getState().intents[0]!.state).not.toBe("CLOSED");
    expect(store.getState().intents[0]!.oppositionBreakevenDeferredAt).toBe("2099-01-02T12:00:00.000Z");
  });

  it("regime-opposition harvest banks the deferred position once the 24h backstop elapses", async () => {
    const clock = { iso: "2099-01-02T12:00:00.000Z" };
    const { engine, client, store } = greenOpposingShortEngine(clock);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.0);
    client.flattenRealizedPnl = 0.78;
    await engine.tick(); // arms the deferral
    expect(store.getState().intents[0]!.state).not.toBe("CLOSED");

    clock.iso = "2099-01-03T12:00:01.000Z"; // 24h + 1s
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_OPPOSITION_BREAKEVEN_DEFERRED_24H_LONG_ONLY");
    expect(closed.realizedPnlUsd).toBeCloseTo(0.78, 6);
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
    expect(flat.side).toBe("BUY");
    expect(store.getState().dailyLedger.wins).toBe(1);
  });

  it("anti-bull hard-cut: a RED short is force-closed once the opposing bull is SUSTAINED past the threshold", async () => {
    let now = "2099-01-02T12:00:00.000Z";
    const order = paperOrder(); // SHORT.
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      nowIso: () => now,
      config: { testnetRegimeHardCutMs: 30 * 60 * 1000, regimeLossHardCutStopFraction: 0 }, // isolate timer hard-cut
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick(); // opens the short; opposition (LONG_ONLY vs SHORT) starts at T0

    client.markPriceBySymbol.set("ETHUSDT", 2100);
    client.unrealizedPnlBySymbol.set("ETHUSDT", -2.0); // RED — would normally ride to its stop
    client.flattenRealizedPnl = -2.0;

    now = "2099-01-02T12:31:00.000Z"; // 31 min later → opposition sustained past 30 min
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_OPPOSITION_HARD_CUT_LONG_ONLY");
    expect(closed.realizedPnlUsd).toBeCloseTo(-2.0, 6);
    expect(store.getState().consecutiveLosses).toBeGreaterThanOrEqual(1); // red cut counts as a loss
  });

  it("anti-bull hard-cut: a RED short is NOT cut while the opposition is still BRIEF (whipsaw guard)", async () => {
    let now = "2099-01-02T12:00:00.000Z";
    const order = paperOrder(); // SHORT.
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      nowIso: () => now,
      config: { testnetRegimeHardCutMs: 30 * 60 * 1000, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    client.markPriceBySymbol.set("ETHUSDT", 2100);
    client.unrealizedPnlBySymbol.set("ETHUSDT", -2.0);
    const placedBefore = client.placed.length;

    now = "2099-01-02T12:10:00.000Z"; // only 10 min — below the 30-min threshold
    await engine.tick();

    expect(store.getState().intents[0]!.state).toBe("OPEN"); // left to its stop, not cut
    expect(client.placed.length).toBe(placedBefore);
  });

  it("opposing-regime loss hard-cut closes immediately once loss exceeds 50% of stop distance", async () => {
    let now = "2099-01-02T12:00:00.000Z";
    const order = paperOrder(); // SHORT, entry 2000, stop 2100.
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      nowIso: () => now,
      config: { testnetRegimeHardCutMs: 2 * 60 * 60 * 1000, regimeLossHardCutStopFraction: 0.5 },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick(); // opens the short; 2h timer is nowhere near elapsed.

    client.markPriceBySymbol.set("ETHUSDT", 2051); // 51% of the 100-point stop distance.
    client.unrealizedPnlBySymbol.set("ETHUSDT", -1.0);
    client.flattenRealizedPnl = -1.0;
    now = "2099-01-02T12:01:00.000Z";
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_OPPOSITION_LOSS_HARD_CUT_LONG_ONLY_50PCT_STOP");
    expect(closed.realizedPnlUsd).toBeCloseTo(-1.0, 6);
  });

  it("opposing-regime loss hard-cut keeps a red position if it has not reached the stop-distance threshold", async () => {
    let now = "2099-01-02T12:00:00.000Z";
    const order = paperOrder(); // SHORT, entry 2000, stop 2100.
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      nowIso: () => now,
      config: { testnetRegimeHardCutMs: 2 * 60 * 60 * 1000, regimeLossHardCutStopFraction: 0.5 },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    client.markPriceBySymbol.set("ETHUSDT", 2049); // 49% of the stop distance.
    client.unrealizedPnlBySymbol.set("ETHUSDT", -1.0);
    const placedBefore = client.placed.length;
    now = "2099-01-02T12:01:00.000Z";
    await engine.tick();

    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(client.placed.length).toBe(placedBefore);
  });

  it("testnet regime-opposition exit keeps opposing exposure open when estimated net is below breakeven", async () => {
    const order = paperOrder(); // SHORT.
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      getControllerSnapshot: () => ({
        regime: "Bullish expansion",
        mode: "LONG_ONLY",
        capturedAt: new Date().toISOString(),
      }),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 0.1); // below conservative close-cost buffer.
    const placedBefore = client.placed.length;
    await engine.tick();

    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(client.placed.length).toBe(placedBefore);
  });

  it("testnet regime-change harvest closes any profitable exposure, not only opposing direction", async () => {
    const order = paperOrder({
      direction: "LONG",
      stopLoss: 1900,
      takeProfitLevels: [2100],
    });
    let controller = {
      regime: "Bullish expansion",
      mode: "LONG_ONLY",
      capturedAt: new Date().toISOString(),
    };
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      getControllerSnapshot: () => controller,
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN");

    controller = {
      regime: "Mixed rotation",
      mode: "VALIDATION_ONLY",
      capturedAt: new Date().toISOString(),
    };
    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.0); // clears the close-cost estimate.
    client.flattenRealizedPnl = 0.78;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_CHANGE_HARVEST_LONG_ONLY_TO_VALIDATION_ONLY");
    expect(closed.realizedPnlUsd).toBeCloseTo(0.78, 6);
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
    expect(flat.side).toBe("SELL");
  });

  it("skips DIAGNOSTIC_ONLY orders, stale watermark orders, and respects the paper breaker halt", async () => {
    const diag = paperOrder({ paperOrderMode: "DIAGNOSTIC_ONLY" } as Partial<PaperOrder>);
    const stale = paperOrder({ createdAt: "2000-01-01T00:00:00.000Z" } as Partial<PaperOrder>);
    const { engine, client } = makeEngine({ paper: makePaperStore([diag, stale]) });
    await engine.arm();
    await engine.tick();
    expect(client.placed.length).toBe(0);

    const halted = makeEngine({ paper: makePaperStore([paperOrder()], true) });
    await halted.engine.arm();
    await halted.engine.tick();
    expect(halted.client.placed.length).toBe(0);
  });

  it("unified lane admission consumes a fresh DIAGNOSTIC_ONLY recipe without bypassing freshness", async () => {
    const fresh = paperOrder({
      paperOrderId: "unified-fresh",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
      direction: "LONG",
      stopLoss: 1900,
      takeProfitLevels: [2100],
      createdAt: "2099-01-02T11:55:00.000Z",
    } as Partial<PaperOrder>);
    const stale = paperOrder({
      paperOrderId: "unified-stale",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
      direction: "LONG",
      symbol: "BTCUSDT",
      entryPrice: 60_000,
      stopLoss: 58_000,
      takeProfitLevels: [61_000],
      createdAt: "2099-01-02T10:00:00.000Z",
    } as Partial<PaperOrder>);
    const client = new FakeLiveClient();
    client.getExchangeFilters = async () => new Map([
      ["ETHUSDT", FILTERS],
      ["BTCUSDT", { ...FILTERS, symbol: "BTCUSDT" }],
    ]);
    const { engine } = makeEngine({
      client,
      paper: makePaperStore([fresh, stale]),
      config: { maxPaperOrderAgeMs: 10 * 60 * 1000 },
      paperLaneGate: (order) => order.selectedLaneId.endsWith("CG_WIDE_FAST_LONG"),
      paperLaneWeightPct: () => 100,
    });
    await engine.arm();
    await engine.tick();
    const entries = client.placed.filter((order) => order.type === "MARKET" && !order.reduceOnly);
    expect(entries, JSON.stringify(engine.getStatus().mirrorFunnel)).toHaveLength(1);
    expect(entries[0]!.symbol).toBe("ETHUSDT");
  });

  it("skips stale HEADLINE paper orders on live mirror re-arm", async () => {
    const stale = paperOrder({
      paperOrderId: "paper-stale",
      createdAt: "2099-01-02T11:00:00.000Z",
    } as Partial<PaperOrder>);
    const { engine, client } = makeEngine({
      paper: makePaperStore([stale]),
      config: { maxPaperOrderAgeMs: 5 * 60 * 1000 },
      nowIso: () => "2099-01-02T12:00:00.000Z",
    });
    await engine.arm();
    await engine.tick();
    expect(client.placed.length).toBe(0);
  });

  it("mirrors only paper orders whose lane is still live-eligible at mirror time", async () => {
    const unstable = paperOrder({
      paperOrderId: "paper-unstable",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM",
    } as Partial<PaperOrder>);
    const stable = paperOrder({
      paperOrderId: "paper-stable",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
      symbol: "BTCUSDT",
    } as Partial<PaperOrder>);
    const client = new FakeLiveClient();
    client.getExchangeFilters = async () =>
      new Map([
        ["ETHUSDT", FILTERS],
        ["BTCUSDT", { ...FILTERS, symbol: "BTCUSDT" }],
      ]);
    const { engine } = makeEngine({
      client,
      paper: makePaperStore([unstable, stable]),
      isPaperOrderLiveEligible: (order) => order.selectedLaneId.endsWith("CG_WIDE_FAST_SHORT"),
    });
    await engine.arm();
    await engine.tick();
    const entries = client.placed.filter((p) => p.type === "MARKET" && !p.reduceOnly);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.symbol).toBe("BTCUSDT");
  });

  it("sets 10x leverage only for EXP 10x lanes and keeps normal lanes at 3x", async () => {
    const expOrder = paperOrder({
      paperOrderId: "paper-exp",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_EXP_SHORT_MFE_GIVEBACK_10X",
      symbol: "ETHUSDT",
      variantExitRule: "mfe_giveback",
      takeProfitLevels: [1700],
    } as Partial<PaperOrder>);
    const normalOrder = paperOrder({
      paperOrderId: "paper-normal",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      symbol: "BTCUSDT",
    } as Partial<PaperOrder>);
    const client = new FakeLiveClient();
    client.getExchangeFilters = async () =>
      new Map([
        ["ETHUSDT", FILTERS],
        ["BTCUSDT", { ...FILTERS, symbol: "BTCUSDT" }],
      ]);
    const { engine } = makeEngine({
      client,
      paper: makePaperStore([expOrder, normalOrder]),
      config: { maxConcurrentPositions: 2, defaultLeverage: 3, maxLeverage: 10 },
    });
    await engine.arm();
    await engine.tick();
    expect(client.leverageCalls).toEqual([
      { symbol: "ETHUSDT", leverage: 10 },
      { symbol: "BTCUSDT", leverage: 3 },
    ]);
  });

  it("respects max concurrent positions and one-symbol-at-a-time", async () => {
    const orders = [
      paperOrder({ paperOrderId: "paper-a" } as Partial<PaperOrder>),
      paperOrder({ paperOrderId: "paper-b" } as Partial<PaperOrder>), // same symbol — must skip
    ];
    const { engine, client } = makeEngine({ paper: makePaperStore(orders), config: { maxConcurrentPositions: 1 } });
    await engine.arm();
    await engine.tick();
    expect(client.placed.filter((p) => p.type === "MARKET" && !p.reduceOnly).length).toBe(1);
  });

  it("caps exposure PER correlation cluster (a different basket gets its own slots; majors exempt)", async () => {
    // SUI/ADA/AVAX are all L1 → share one L1:SHORT cluster cap. DOGE is MEME (own cluster). ETH is a
    // major (exempt). With maxClusterPositions=2: the 3rd L1 short (AVAX) is blocked, but DOGE (a
    // different cluster) and ETH (major) still get in — the whole point of cluster-scoping the cap.
    const symbols = ["SUIUSDT", "ADAUSDT", "AVAXUSDT", "DOGEUSDT", "ETHUSDT"];
    const client = new FakeLiveClient();
    client.getExchangeFilters = async () =>
      new Map(symbols.map((symbol) => [symbol, { ...FILTERS, symbol }]));
    const orders = [
      paperOrder({ paperOrderId: "short-sui", symbol: "SUIUSDT", createdAt: "2099-01-02T00:00:01.000Z" } as Partial<PaperOrder>),
      paperOrder({ paperOrderId: "short-ada", symbol: "ADAUSDT", createdAt: "2099-01-02T00:00:02.000Z" } as Partial<PaperOrder>),
      paperOrder({ paperOrderId: "short-avax", symbol: "AVAXUSDT", createdAt: "2099-01-02T00:00:03.000Z" } as Partial<PaperOrder>),
      paperOrder({ paperOrderId: "short-doge", symbol: "DOGEUSDT", createdAt: "2099-01-02T00:00:04.000Z" } as Partial<PaperOrder>),
      // Majors are exempt from the per-cluster cap.
      paperOrder({ paperOrderId: "short-eth", symbol: "ETHUSDT", createdAt: "2099-01-02T00:00:05.000Z" } as Partial<PaperOrder>),
    ];
    const { engine } = makeEngine({
      client,
      paper: makePaperStore(orders),
      config: {
        maxConcurrentPositions: 10,
        maxCorrelatedAltShortPositions: 10,
        maxClusterPositions: 2,
      },
    });

    await engine.arm();
    await engine.tick();

    const entries = client.placed.filter((order) => order.type === "MARKET" && !order.reduceOnly);
    expect(entries.map((order) => `${order.symbol}:${order.side}`)).toEqual([
      "SUIUSDT:SELL",
      "ADAUSDT:SELL",
      "DOGEUSDT:SELL",
      "ETHUSDT:SELL",
    ]);
    expect(entries.some((order) => order.symbol === "AVAXUSDT")).toBe(false); // 3rd L1 short blocked
  });

  it("enforces the global correlated-alt cap across different clusters while majors remain exempt", async () => {
    const symbols = ["SUIUSDT", "DOGEUSDT", "FETUSDT", "ETHUSDT"];
    const client = new FakeLiveClient();
    client.getExchangeFilters = async () =>
      new Map(symbols.map((symbol) => [symbol, { ...FILTERS, symbol }]));
    const orders = symbols.map((symbol, index) =>
      paperOrder({
        paperOrderId: `global-cap-${symbol}`,
        symbol,
        createdAt: `2099-01-02T00:00:0${index + 1}.000Z`,
      } as Partial<PaperOrder>),
    );
    const { engine } = makeEngine({
      client,
      paper: makePaperStore(orders),
      config: {
        maxConcurrentPositions: 10,
        maxCorrelatedAltShortPositions: 2,
        maxClusterPositions: 10,
      },
    });

    await engine.arm();
    await engine.tick();

    const entries = client.placed.filter((order) => order.type === "MARKET" && !order.reduceOnly);
    expect(entries.map((order) => order.symbol)).toEqual(["SUIUSDT", "DOGEUSDT", "ETHUSDT"]);
    expect(engine.getStatus().mirrorFunnel.find((row) => row.symbol === "FETUSDT")?.reason).toBe("correlated_alt_cap");
  });

  it("blocks pyramid adds that would exceed aggregate intent stop-risk even after favorable progress", async () => {
    const orders = [paperOrder({ paperOrderId: "risk-cap-first" } as Partial<PaperOrder>)];
    const paper = makePaperStore(orders);
    const { engine, client, store } = makeEngine({
      paper,
      config: { maxAggregateIntentRiskUsd: 5 },
    });
    await engine.arm();
    await engine.tick();
    store.getState().intents[0]!.maxFavorableR = 1; // old gate would allow unlimited adds now
    orders.push(paperOrder({
      paperOrderId: "risk-cap-add",
      createdAt: "2099-01-02T00:01:00.000Z",
    } as Partial<PaperOrder>));

    await engine.tick();

    expect(client.placed.filter((order) => order.type === "MARKET" && !order.reduceOnly)).toHaveLength(1);
    expect(store.getState().intents[0]!.sourcePaperOrders).toHaveLength(1);
    expect(engine.getStatus().mirrorFunnel.find((row) => row.id === "risk-cap-add")?.reason).toBe("aggregate_intent_risk_cap");
  });

  it("testnet mirror-all keeps one symbol on one lane geometry instead of netting different lanes", async () => {
    const orders = [
      paperOrder({
        paperOrderId: "paper-lane-a",
        selectedLaneId: "LANE_A",
        paperOrderMode: "DIAGNOSTIC_ONLY",
        createdAt: "2099-01-02T00:00:00.000Z",
      } as Partial<PaperOrder>),
      paperOrder({
        paperOrderId: "paper-lane-b",
        selectedLaneId: "LANE_B",
        paperOrderMode: "DIAGNOSTIC_ONLY",
        createdAt: "2099-01-02T00:01:00.000Z",
      } as Partial<PaperOrder>),
    ];
    const { engine, client, store } = makeEngine({
      paper: makePaperStore(orders),
      config: { mirrorAllPaperOrders: true },
    });
    await engine.arm();
    await engine.tick();

    const entries = client.placed.filter((order) => order.type === "MARKET" && !order.reduceOnly);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.quantity).toBeCloseTo(0.05, 9);
    expect(store.getState().intents[0]!.sourcePaperOrders).toEqual([
      {
        paperOrderId: "paper-lane-a",
        laneId: "LANE_A",
        qty: 0.05,
        regime: null,
        controllerMode: null,
        controllerConfidence: null,
      },
    ]);

    const account = await engine.getAccountSnapshot();
    expect(account.openPositionCount).toBe(1);
    expect(account.accountEquity).toBe(5000);
    expect(account.positions[0]!.targetTpPrice).toBeCloseTo(1900, 9);
    expect(account.positions[0]!.targetTpGapPct).toBeCloseTo(5, 9);
    expect(account.positions[0]!.liquidationPrice).toBe(1500);
    expect(account.lanes.map((lane) => lane.laneId)).toEqual(["LANE_A"]);
  });

  it("testnet mirror-all accepts a diagnostic source outside the operator lane selection", async () => {
    const order = paperOrder({
      paperOrderId: "testnet-collect-all",
      selectedLaneId: "QUARANTINED_DIAGNOSTIC_LANE",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      diagnosticLabel: "TESTNET_COLLECT_ALL_LANES",
    });
    const { engine, client } = makeEngine({
      paper: makePaperStore([order]),
      config: { mirrorAllPaperOrders: true },
      paperLaneGate: () => false,
    });
    await engine.arm();
    await engine.tick();

    expect(client.placed.filter((placed) => placed.type === "MARKET" && !placed.reduceOnly)).toHaveLength(1);
  });

  it("testnet mirror-all bypasses only strategy admission, not the exchange safety path", async () => {
    const order = paperOrder({
      paperOrderId: "testnet-collector-admission",
      selectedLaneId: "ANY_FRESH_DIAGNOSTIC_LANE",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      diagnosticLabel: "TESTNET_COLLECT_ALL_LANES",
    });
    const { engine, client } = makeEngine({
      paper: makePaperStore([order]),
      config: { mirrorAllPaperOrders: true },
      newEntryGate: () => ({ allowed: false, reason: "strategy says wait" }),
    });
    await engine.arm();
    await engine.tick();

    expect(client.placed.filter((placed) => placed.type === "MARKET" && !placed.reduceOnly)).toHaveLength(1);
  });

  it("2026-07-21 fix: an off-table diagnostic lane gets a REAL nonzero mirror size under mirrorAllPaperOrders, not a silent qty=0", async () => {
    // Reproduces the exact production bug: a real, non-null operator allocation table is configured
    // (as it always is on the actual testnet deployment) that simply doesn't list this diagnostic/
    // research variant lane. Before the fix, laneSelectionWeightPctForLane returned 0 for it (the
    // lane-not-listed branch), zeroing the plan's qty; openIntent's combinedPlan then silently no-op'd
    // on the unsizeable plan while the caller still latched "opened" — no real order was EVER placed.
    const order = paperOrder({
      paperOrderId: "off-table-diagnostic",
      selectedLaneId: "CG_EXP_LONG_MFE_GIVEBACK_10X", // NOT in the table set below
      paperOrderMode: "DIAGNOSTIC_ONLY",
      diagnosticLabel: "TESTNET_COLLECT_ALL_LANES",
    });
    const { engine, client } = makeEngine({
      paper: makePaperStore([order]),
      config: { mirrorAllPaperOrders: true },
    });
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]); // the real table — off-table lane deliberately absent
    await engine.arm();
    await engine.tick();

    const entries = client.placed.filter((placed) => placed.type === "MARKET" && !placed.reduceOnly);
    expect(entries).toHaveLength(1); // fixed: a real order is actually placed now
    // Full-size (DIAGNOSTIC_LANE_MIRROR_WEIGHT_PCT=100): the original 10% default silently failed
    // one step later in production — the scaled qty fell under real Binance minQty/minNotional.
    expect(entries[0]!.quantity).toBeCloseTo(0.05, 9);
  });

  it("2026-07-21 fix: a listed lane CORTEX has tilted down to exactly 0% stays at 0% even under mirrorAllPaperOrders", async () => {
    // The fix must not become a blanket bypass of a deliberate zero — only a lane genuinely ABSENT
    // from the table gets the diagnostic default. setLaneAllocations itself rejects a literal 0%
    // entry (operators can't list a lane at exactly 0%), so the one real way a LISTED lane's
    // effective weight lands on exactly 0 is CORTEX's promoted-weight override — exercise that path.
    const order = paperOrder({
      paperOrderId: "cortex-zeroed",
      selectedLaneId: "CG_WIDE_FAST_SHORT",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      diagnosticLabel: "TESTNET_COLLECT_ALL_LANES",
    });
    const { engine, client } = makeEngine({
      paper: makePaperStore([order]),
      config: { mirrorAllPaperOrders: true },
    });
    engine.setLaneAllocations([
      { laneId: "CG_WIDE_FAST_LONG", weightPct: 50 },
      { laneId: "CG_WIDE_FAST_SHORT", weightPct: 50 },
    ]);
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 0 }); // listed lane, tilted to exactly 0 — not an omission
    await engine.arm();
    await engine.tick();

    const entries = client.placed.filter((placed) => placed.type === "MARKET" && !placed.reduceOnly);
    expect(entries).toHaveLength(0); // still blocked — a listed-but-zeroed lane must never be reinterpreted as "off-table"
  });

  it("2026-07-23 fix: an operator-weight-scaled qty that clears minQty but misses minNotional is rejected, not silently opened", async () => {
    // Reproduces a real production bug found investigating CG_LONG_VARIANT_MATRIX:CG_EXP_LONG_MFE_GIVEBACK_10X
    // on testnet: computeLiveOrderPlan validates the qty/notional BEFORE mirrorNewSignals scales it
    // by (operator weight% x directional size-multiplier); combinedPlan then re-rounded that SCALED
    // qty and re-checked it against minQty only, never against minNotional. A low weight% can clear
    // minQty by unit count while the dollar notional falls under the exchange's separate minNotional
    // floor — Binance then rejects the real order with -4164 ("notional must be no smaller than 5").
    // Live evidence: 104/201 (52%) of this lane's real open attempts failed with exactly this error.
    const order = paperOrder({
      paperOrderId: "weight-scaled-under-notional",
      selectedLaneId: "CG_WIDE_FAST_LONG",
      direction: "LONG",
      entryPrice: 1,
      stopLoss: 0.8, // 20% stop distance: unscaled notional = riskUsdPerTrade(5)/0.20 = $25 (clears minNotional=5)
      takeProfitLevels: [1.2],
    });
    const { engine, client } = makeEngine({ paper: makePaperStore([order]) });
    // 1% of the validated $25 plan = $0.25 notional (below minNotional=5) but 0.25 qty units (still
    // above minQty=0.001) — exactly the gap between the two checks.
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 1 }]);
    await engine.arm();
    await engine.tick();

    expect(client.placed.filter((placed) => placed.type === "MARKET" && !placed.reduceOnly)).toHaveLength(0);
  });

  it("normal mirror keeps a strategy admission block", async () => {
    const order = paperOrder({ paperOrderId: "normal-admission-block" });
    const { engine, client } = makeEngine({
      paper: makePaperStore([order]),
      newEntryGate: () => ({ allowed: false, reason: "strategy says wait" }),
    });
    await engine.arm();
    await engine.tick();

    expect(client.placed.filter((placed) => placed.type === "MARKET" && !placed.reduceOnly)).toHaveLength(0);
  });

  it("builds lane performance series by period and regime filter from closed intents", () => {
    const shortPaper = paperOrder({
      paperOrderId: "paper-short",
      selectedLaneId: "LANE_SHORT",
      regime: "Bearish pressure",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "MEDIUM",
    } as Partial<PaperOrder>);
    const longPaper = paperOrder({
      paperOrderId: "paper-long",
      selectedLaneId: "LANE_LONG",
      regime: "Bullish pullback",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "LOW",
    } as Partial<PaperOrder>);
    const { engine, store } = makeEngine({
      paper: makePaperStore([shortPaper, longPaper]),
      nowIso: () => "2099-01-02T12:00:00.000Z",
    });
    store.getState().intents.push(
      {
        paperOrderId: "paper-short",
        symbol: "ETHUSDT",
        direction: "SHORT",
        state: "CLOSED",
        qty: 1,
        tp1Qty: 1,
        plannedEntryPrice: 2000,
        stopLossPrice: 2100,
        tp1Price: 1900,
        filledEntryPrice: 2000,
        entryOrderId: "1",
        stopOrderId: null,
        tp1OrderId: "2",
        beStopOrderId: null,
        realizedPnlUsd: 20,
        feesUsd: 1,
        exitRule: "tp1_full",
        maxFavorableR: null,
        createdAt: "2099-01-02T10:00:00.000Z",
        updatedAt: "2099-01-02T11:30:00.000Z",
        closedAt: "2099-01-02T11:30:00.000Z",
        closeReason: "TEST",
        lastError: null,
        sourcePaperOrders: [{ paperOrderId: "paper-short", laneId: "LANE_SHORT", qty: 1 }],
      },
      {
        paperOrderId: "paper-long",
        symbol: "BTCUSDT",
        direction: "LONG",
        state: "CLOSED",
        qty: 1,
        tp1Qty: 1,
        plannedEntryPrice: 100,
        stopLossPrice: 95,
        tp1Price: 105,
        filledEntryPrice: 100,
        entryOrderId: "3",
        stopOrderId: null,
        tp1OrderId: "4",
        beStopOrderId: null,
        realizedPnlUsd: -5,
        feesUsd: 0.5,
        exitRule: "tp1_full",
        maxFavorableR: null,
        createdAt: "2099-01-02T10:30:00.000Z",
        updatedAt: "2099-01-02T11:45:00.000Z",
        closedAt: "2099-01-02T11:45:00.000Z",
        closeReason: "TEST",
        lastError: null,
        sourcePaperOrders: [{ paperOrderId: "paper-long", laneId: "LANE_LONG", qty: 1 }],
      },
    );

    const shortExtended = engine.getLanePerformanceSeries({
      view: "hourly",
      anchor: "2099-01-02",
      regime: "short_extended",
    });
    expect(shortExtended.view).toBe("hourly");
    expect(shortExtended.anchor).toBe("2099-01-02");
    expect(shortExtended.bucketStarts).toHaveLength(24);
    expect(shortExtended.regimeFilter).toBe("short_extended");
    expect(shortExtended.lanes).toHaveLength(1);
    expect(shortExtended.lanes[0]!.laneId).toBe("LANE_SHORT");
    expect(shortExtended.lanes[0]!.realizedPnlUsd).toBeCloseTo(20, 9);
    expect(shortExtended.lanes[0]!.regimes[0]).toMatchObject({ family: "SHORT", bucket: "SHORT_EXTENDED", count: 1 });

    const longAll = engine.getLanePerformanceSeries({ view: "daily", anchor: "2099-01", regime: "long" });
    expect(longAll.period).toBe("fixed");
    expect(longAll.anchor).toBe("2099-01");
    expect(longAll.bucketStarts).toHaveLength(31);
    expect(longAll.lanes).toHaveLength(1);
    expect(longAll.lanes[0]!.laneId).toBe("LANE_LONG");
    expect(longAll.lanes[0]!.realizedPnlUsd).toBeCloseTo(-5, 9);

    const weekly = engine.getLanePerformanceSeries({ view: "weekly", anchor: "2099-01", regime: "all" });
    expect(weekly.bucketStarts).toHaveLength(5);

    const monthly = engine.getLanePerformanceSeries({ view: "monthly", anchor: "2099", regime: "all" });
    expect(monthly.bucketStarts).toHaveLength(12);

    const yearly = engine.getLanePerformanceSeries({ view: "yearly", anchor: "2099", regime: "all" });
    expect(yearly.periodLabel).toBe("2097-2099");
    expect(yearly.bucketStarts).toHaveLength(3);
  });

  // 2026-07-09 fix: a pyramided intent (many sourcePaperOrders sharing the SAME laneId, i.e.
  // repeated adds into one open position) must count as ONE closed trade for that lane in both
  // closedLanes and getLanePerformanceSeries, not one per add. Root cause of the CG_WIDE_FAST_LONG
  // testnet/live divergence investigation: a position pyramided 26x counted as "26 trades",
  // inflating both reported sample size and win/loss tallies whenever pyramiding correlated with
  // outcome (heavily-pyramided losers massively over-weighted the loss count).
  it("getAccountSnapshot().closedLanes counts a pyramided intent as ONE trade per lane, not one per add", async () => {
    const { engine, store } = makeEngine({ nowIso: () => "2099-01-02T12:00:00.000Z" });
    store.getState().intents.push({
      paperOrderId: "paper-pyramided",
      symbol: "DOGEUSDT",
      direction: "LONG",
      state: "CLOSED",
      qty: 3,
      tp1Qty: 3,
      plannedEntryPrice: 1,
      stopLossPrice: 0.9,
      tp1Price: 1.1,
      filledEntryPrice: 1,
      entryOrderId: "10",
      stopOrderId: null,
      tp1OrderId: "11",
      beStopOrderId: null,
      realizedPnlUsd: -6, // one real loss, split across 3 pyramided adds
      feesUsd: 0.3,
      exitRule: "tp1_full",
      maxFavorableR: null,
      createdAt: "2099-01-02T10:00:00.000Z",
      updatedAt: "2099-01-02T11:30:00.000Z",
      closedAt: "2099-01-02T11:30:00.000Z",
      closeReason: "TEST",
      lastError: null,
      // 3 adds, all into the SAME lane — this is ONE real trade, not 3.
      sourcePaperOrders: [
        { paperOrderId: "paper-pyramided-1", laneId: "CG_WIDE_FAST_LONG", qty: 1 },
        { paperOrderId: "paper-pyramided-2", laneId: "CG_WIDE_FAST_LONG", qty: 1 },
        { paperOrderId: "paper-pyramided-3", laneId: "CG_WIDE_FAST_LONG", qty: 1 },
      ],
    });

    const account = await engine.getAccountSnapshot();
    const lane = account.closedLanes.find((l) => l.laneId === "CG_WIDE_FAST_LONG");
    expect(lane).toBeDefined();
    expect(lane!.closedCount).toBe(1); // NOT 3
    expect(lane!.wins).toBe(0);
    expect(lane!.losses).toBe(1); // NOT 3
    expect(lane!.realizedPnlUsd).toBeCloseTo(-6, 9); // dollar total still correct
    expect(lane!.feesUsd).toBeCloseTo(0.3, 9);
  });

  it("getAccountSnapshot().closedLanes still attributes one count to EACH distinct lane when an intent's sources span multiple lanes", async () => {
    const { engine, store } = makeEngine({ nowIso: () => "2099-01-02T12:00:00.000Z" });
    store.getState().intents.push({
      paperOrderId: "paper-mixed",
      symbol: "ETHUSDT",
      direction: "LONG",
      state: "CLOSED",
      qty: 2,
      tp1Qty: 2,
      plannedEntryPrice: 2000,
      stopLossPrice: 1900,
      tp1Price: 2100,
      filledEntryPrice: 2000,
      entryOrderId: "20",
      stopOrderId: null,
      tp1OrderId: "21",
      beStopOrderId: null,
      realizedPnlUsd: 10,
      feesUsd: 0.4,
      exitRule: "tp1_full",
      maxFavorableR: null,
      createdAt: "2099-01-02T10:00:00.000Z",
      updatedAt: "2099-01-02T11:30:00.000Z",
      closedAt: "2099-01-02T11:30:00.000Z",
      closeReason: "TEST",
      lastError: null,
      sourcePaperOrders: [
        { paperOrderId: "paper-mixed-a", laneId: "LANE_A", qty: 1 },
        { paperOrderId: "paper-mixed-b", laneId: "LANE_B", qty: 1 },
      ],
    });

    const account = await engine.getAccountSnapshot();
    const laneA = account.closedLanes.find((l) => l.laneId === "LANE_A");
    const laneB = account.closedLanes.find((l) => l.laneId === "LANE_B");
    expect(laneA!.closedCount).toBe(1);
    expect(laneB!.closedCount).toBe(1);
    expect(laneA!.realizedPnlUsd).toBeCloseTo(5, 9); // 50% qty share of the $10 win
    expect(laneB!.realizedPnlUsd).toBeCloseTo(5, 9);
  });

  it("getLanePerformanceSeries counts a pyramided intent as ONE trade, using the first add's regime as representative", () => {
    const { engine, store } = makeEngine({ nowIso: () => "2099-01-02T12:00:00.000Z" });
    store.getState().intents.push({
      paperOrderId: "paper-pyramided-series",
      symbol: "WLDUSDT",
      direction: "LONG",
      state: "CLOSED",
      qty: 2,
      tp1Qty: 2,
      plannedEntryPrice: 1,
      stopLossPrice: 0.9,
      tp1Price: 1.1,
      filledEntryPrice: 1,
      entryOrderId: "30",
      stopOrderId: null,
      tp1OrderId: "31",
      beStopOrderId: null,
      realizedPnlUsd: -4,
      feesUsd: 0.2,
      exitRule: "tp1_full",
      maxFavorableR: null,
      createdAt: "2099-01-02T10:00:00.000Z",
      updatedAt: "2099-01-02T11:30:00.000Z",
      closedAt: "2099-01-02T11:30:00.000Z",
      closeReason: "TEST",
      lastError: null,
      // First add's regime (LONG_ONLY) is the entry condition; the second add happened later under
      // a different (stale) regime snapshot — the WHOLE trade should be classified by the first.
      sourcePaperOrders: [
        { paperOrderId: "paper-pyr-series-1", laneId: "LANE_LONG_PYR", qty: 1, regime: "Bullish pullback", controllerMode: "LONG_ONLY", controllerConfidence: "LOW" },
        { paperOrderId: "paper-pyr-series-2", laneId: "LANE_LONG_PYR", qty: 1, regime: "Mixed rotation", controllerMode: "VALIDATION_ONLY", controllerConfidence: "LOW" },
      ],
    });

    const series = engine.getLanePerformanceSeries({ view: "daily", anchor: "2099-01", regime: "long" });
    expect(series.lanes).toHaveLength(1);
    expect(series.lanes[0]!.laneId).toBe("LANE_LONG_PYR");
    expect(series.lanes[0]!.closedCount).toBe(1); // NOT 2
    expect(series.lanes[0]!.wins).toBe(0);
    expect(series.lanes[0]!.losses).toBe(1); // NOT 2
    expect(series.lanes[0]!.realizedPnlUsd).toBeCloseTo(-4, 9);
  });

  it("kill-switch on daily loss: cancels, flattens, disarms, latches", async () => {
    const order = paperOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick(); // open the intent
    expect(store.getState().intents[0]!.state).toBe("OPEN");

    // Breach daily loss (ledger date matches the injected nowIso).
    store.getState().dailyLedger.dateUtc = "2099-01-02";
    store.getState().dailyLedger.realizedPnlUsd = -20;
    await engine.tick();

    expect(engine.isArmed()).toBe(false);
    expect(store.getState().killedAt).not.toBeNull();
    expect(store.getState().killReason).toMatch(/daily max loss/);
    expect(client.cancelAllSymbols).toContain("ETHUSDT");
    const flatten = client.placed.at(-1)!;
    expect(flatten.type).toBe("MARKET");
    expect(flatten.reduceOnly).toBe(true);
    expect(store.getState().intents[0]!.state).toBe("KILLED");

    // Latched: arming refused until an explicit reset.
    expect((await engine.arm()).ok).toBe(false);
    engine.resetKill();
    expect((await engine.arm()).ok).toBe(true);
  });

  it("[COMBINED-PNL] kill-switch trips on combined daily loss even when the engine-native ledger alone is healthy", async () => {
    const { engine, store } = makeEngine({
      getExternalRealizedPnlUsd: () => ({ today: -20, allTime: -20 }),
    });
    await engine.arm();
    await engine.tick(); // rolls the ledger fresh: engine-native realizedPnlUsd = 0 (healthy alone)
    expect(store.getState().dailyLedger.realizedPnlUsd).toBe(0);

    await engine.tick(); // killSwitchTrip: combined = 0 + (-20) <= -15 (dailyMaxLossUsd)
    expect(engine.isArmed()).toBe(false);
    expect(store.getState().killedAt).not.toBeNull();
    expect(store.getState().killReason).toMatch(/daily max loss/);
    expect(store.getState().killReason).toMatch(/other-lanes=-20\.00/);
  });

  it("[COMBINED-PNL] kill-switch does NOT trip when the combined daily loss stays within budget", async () => {
    const { engine, store } = makeEngine({
      getExternalRealizedPnlUsd: () => ({ today: -5, allTime: -5 }),
    });
    await engine.arm();
    await engine.tick();
    store.getState().dailyLedger.realizedPnlUsd = -5; // engine-native alone also within budget
    await engine.tick(); // combined = -5 + -5 = -10, still above the -15 floor

    expect(engine.isArmed()).toBe(true);
    expect(store.getState().killedAt).toBeNull();
  });

  it("[COMBINED-PNL] kill-switch's drawdown check uses the combined (engine + external) peak and total", async () => {
    let externalAllTime = 50;
    const { engine, store } = makeEngine({
      config: { dailyMaxLossUsd: 999 }, // isolate: only the drawdown branch should be able to trip
      getExternalRealizedPnlUsd: () => ({ today: 0, allTime: externalAllTime }),
    });
    await engine.arm();
    await engine.tick(); // establishes combinedRealizedPeakUsd = 0 (engine) + 50 (external)
    expect(store.getState().combinedRealizedPeakUsd).toBe(50);
    expect(engine.isArmed()).toBe(true);

    externalAllTime = 5; // external lanes gave back $45 — drawdown from peak = 50 - 5 = 45 >= 40
    await engine.tick();

    expect(engine.isArmed()).toBe(false);
    expect(store.getState().killReason).toMatch(/max drawdown hit/);
    expect(store.getState().killReason).toMatch(/other-lanes=5\.00/);
  });

  it("[COMBINED-PNL] resetKill rebases combinedRealizedPeakUsd too (else a stale peak instantly re-trips drawdown)", async () => {
    let externalAllTime = 50;
    const { engine, store } = makeEngine({
      config: { dailyMaxLossUsd: 999 },
      getExternalRealizedPnlUsd: () => ({ today: 0, allTime: externalAllTime }),
    });
    await engine.arm();
    await engine.tick(); // peak = 50

    externalAllTime = 5; // drawdown of 45 >= 40 trips
    await engine.tick();
    expect(store.getState().killedAt).not.toBeNull();

    engine.resetKill();
    expect(store.getState().combinedRealizedPeakUsd).toBe(5); // rebased to the current combined total, not left at 50

    expect((await engine.arm()).ok).toBe(true);
    await engine.tick(); // if combinedRealizedPeakUsd had stayed 50, this would immediately re-trip
    expect(engine.isArmed()).toBe(true);
    expect(store.getState().killedAt).toBeNull();
  });

  it("kill-switch flatten books its realized P&L to the intent and the ledger (was silently dropped)", async () => {
    // A kill-switch flatten is almost always a loss (that's what tripped the breaker). Before this
    // fix it left intent.realizedPnlUsd null and never touched dailyLedger — invisible to lane
    // reports, and understating the total resetKill() rebases its drawdown peak from.
    const order = paperOrder();
    const client = new FakeLiveClient();
    client.flattenRealizedPnl = -7.5; // the kill-switch's own reduce-only flatten realizes -$7.50
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick(); // open the intent

    store.getState().dailyLedger.dateUtc = "2099-01-02";
    store.getState().dailyLedger.realizedPnlUsd = -20;
    const totalBefore = store.getState().totalRealizedPnlUsd;
    await engine.tick(); // trips the kill-switch

    const killed = store.getState().intents[0]!;
    expect(killed.state).toBe("KILLED");
    expect(killed.realizedPnlUsd).toBeCloseTo(-7.5, 6); // no longer null
    expect(store.getState().totalRealizedPnlUsd).toBeCloseTo(totalBefore - 7.5, 6);
    expect(store.getState().dailyLedger.losses).toBeGreaterThanOrEqual(1); // counted as adverse, not silently dropped
  });

  it("operator panic-flatten (flattenAllExchangePositions) also books its realized P&L (same fix as the kill-switch)", async () => {
    const order = paperOrder();
    const client = new FakeLiveClient();
    client.flattenRealizedPnl = -3.25;
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick(); // open the intent
    const totalBefore = store.getState().totalRealizedPnlUsd;

    await engine.flattenAllExchangePositions("operator panic button");

    const killed = store.getState().intents[0]!;
    expect(killed.state).toBe("KILLED");
    expect(killed.realizedPnlUsd).toBeCloseTo(-3.25, 6);
    expect(store.getState().totalRealizedPnlUsd).toBeCloseTo(totalBefore - 3.25, 6);
  });

  it("reconciliation: an orphan exchange position auto-disarms (never auto-flattens)", async () => {
    const { engine, client } = makeEngine({});
    await engine.arm();
    client.positionsBySymbol.set("DOGEUSDT", 5); // not opened by the engine
    await engine.tick();
    expect(engine.isArmed()).toBe(false);
    expect(engine.getStatus().reconcileIssues.join(" ")).toMatch(/orphan/);
    // Orphans are surfaced, never flattened — could be the operator's own position.
    expect(client.placed.length).toBe(0);
  });

  // [EXTERNAL-CLAIM] 2026-07-07: the cross-sectional executor opens real positions on the SAME
  // Binance account that are not engine intents. Reconcile flagged every basket leg as an orphan
  // and force-disarmed one tick after a basket opened (confirmed live: armed → basket opened →
  // "orphan exchange position ... not opened by engine" → disarmed), which also defeated auto-arm
  // on every boot. Positions fully explained by the external executor's claims must not disarm.
  it("[EXTERNAL-CLAIM] a position fully explained by an external executor's claim does not disarm", async () => {
    const { engine, client } = makeEngine({
      externalManagedNetQty: () => new Map([["SOLUSDT", 0.3], ["DOGEUSDT", -332]]),
    });
    await engine.arm();
    client.positionsBySymbol.set("SOLUSDT", 0.3); // basket long leg
    client.positionsBySymbol.set("DOGEUSDT", -332); // basket short leg
    await engine.tick();
    expect(engine.isArmed()).toBe(true);
    expect(engine.getStatus().reconcileIssues.join(" ")).not.toMatch(/orphan/);
  });

  it("[EXTERNAL-CLAIM] a position EXCEEDING the external claim still disarms (unexplained remainder)", async () => {
    const { engine, client } = makeEngine({
      externalManagedNetQty: () => new Map([["SOLUSDT", 0.3]]),
    });
    await engine.arm();
    client.positionsBySymbol.set("SOLUSDT", 5.3); // 0.3 claimed + 5.0 foreign
    await engine.tick();
    expect(engine.isArmed()).toBe(false);
    expect(engine.getStatus().reconcileIssues.join(" ")).toMatch(/external executor claims only 0.3/);
  });

  it("[EXTERNAL-CLAIM] with no claim the orphan behavior is unchanged", async () => {
    const { engine, client } = makeEngine({
      externalManagedNetQty: () => new Map(),
    });
    await engine.arm();
    client.positionsBySymbol.set("DOGEUSDT", 5);
    await engine.tick();
    expect(engine.isArmed()).toBe(false);
    expect(engine.getStatus().reconcileIssues.join(" ")).toMatch(/orphan/);
  });

  it("reconcileIssues never grows unbounded when the SAME orphan is rediscovered tick after tick", async () => {
    // Real-world case: an orphan position sits unresolved for days. Every tick rediscovers it and
    // re-pushes the same message — without a cap, this array grows forever (a memory leak) and
    // getStatus()'s slice(-10) becomes a misleading stale mix of old + new pushes instead of the
    // current state. It must stay bounded no matter how many ticks find the same issue.
    const { engine, client } = makeEngine({});
    client.positionsBySymbol.set("DOGEUSDT", 5); // orphan, present on every tick
    for (let i = 0; i < 250; i += 1) await engine.tick();
    // @ts-expect-error -- reaching into the private field to verify it's bounded at the source,
    // not just at the getStatus() display layer.
    expect(engine.reconcileIssues.length).toBeLessThanOrEqual(200);
    expect(engine.getStatus().reconcileIssues.join(" ")).toMatch(/orphan/);
  });

  it("exchange error streak auto-disarms", async () => {
    const { engine, client } = makeEngine({});
    await engine.arm();
    client.failNextTicks = 6;
    for (let i = 0; i < 6; i++) await engine.tick();
    expect(engine.isArmed()).toBe(false);
  });

  // 2026-08-17. The threshold was 3 and the disarm was LATCHED, so ~75s of Binance trouble took
  // testnet down until a human noticed hours later — twice in one day. Recovery is now allowed, but
  // ONLY for this cause; the tests below exist to keep every other cause latched.
  describe("brief exchange trouble no longer latches the account off", () => {
    it("survives a blip: 3 consecutive failures used to disarm, and must not any more", async () => {
      const { engine, client } = makeEngine({});
      await engine.arm();
      client.failNextTicks = 3;
      for (let i = 0; i < 3; i++) await engine.tick();
      expect(engine.isArmed()).toBe(true);
    });

    it("re-arms itself once the exchange has answered cleanly again for a run of ticks", async () => {
      const { engine, client } = makeEngine({});
      await engine.arm();
      client.failNextTicks = 6;
      for (let i = 0; i < 6; i++) await engine.tick();
      expect(engine.isArmed()).toBe(false);
      await engine.tick();
      expect(engine.isArmed()).toBe(false); // one good tick is not recovery
      for (let i = 0; i < 3; i++) await engine.tick();
      expect(engine.isArmed()).toBe(true);
    });

    it("NEVER undoes an operator disarm, however healthy the exchange gets", async () => {
      const { engine } = makeEngine({});
      await engine.arm();
      engine.disarm("manual disarm via /api/live/disarm");
      for (let i = 0; i < 20; i++) await engine.tick();
      expect(engine.isArmed()).toBe(false);
    });

    it("NEVER undoes a reconciliation disarm — an orphan position needs a human, not a clean tick", async () => {
      const { engine } = makeEngine({});
      await engine.arm();
      engine.disarm("reconciliation mismatch: orphan exchange position WLDUSDT amt=55 (not opened by engine)");
      for (let i = 0; i < 20; i++) await engine.tick();
      expect(engine.isArmed()).toBe(false);
    });

    it("reports why it went down, and keeps reporting after the exchange recovers", async () => {
      const { engine, client } = makeEngine({});
      await engine.arm();
      client.failNextTicks = 6;
      for (let i = 0; i < 6; i++) await engine.tick();
      const health = (engine.getStatus() as { health: { lastDisarm: { reason: string } | null } }).health;
      expect(health.lastDisarm?.reason).toMatch(/exchange error streak/);
    });
  });

  it("refuses to arm in hedge mode", async () => {
    const client = new FakeLiveClient();
    client.hedge = true;
    const { engine } = makeEngine({ client });
    const result = await engine.arm();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hedge/);
  });

  // ── churn regression (the INJUSDT −$865 incident) ──────────────────────────

  it("Fault A: protective stop is placed at the repriced fill, not the stale paper stop (no -2021)", async () => {
    // LONG paper: entry 2000, stop 1900 (5%). But the live MARKET fills at 1850 — already BELOW
    // the paper stop. The old code placed the sell-stop at 1900 (above the fill) → Binance -2021.
    const order = paperOrder({ direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100] } as Partial<PaperOrder>);
    const client = new FakeLiveClient();
    client.marketFillPrice = 1850;
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick();

    const stop = client.placed.find((p) => p.type === "STOP_MARKET");
    expect(stop).toBeDefined();
    // Repriced stop = 1850 × (1 − 0.05) = 1757.5 — strictly BELOW the fill (correct side), not 1900.
    expect(stop!.stopPrice!).toBeLessThan(1850);
    expect(stop!.stopPrice!).toBeCloseTo(1757.5, 1);
    expect(store.getState().intents[0]!.state).toBe("OPEN");
  });

  it("confirms the real entry fill via queryOrder when placeOrder returns avgPrice=0, and reprices off the CONFIRMED price (not the stale paper price)", async () => {
    // Same shape as Fault A, but this time the exchange's placeOrder response comes back
    // avgPrice=0 (a real, observed Binance quirk) instead of reporting the fill directly.
    // Silently trusting that as "flat at the paper price" would reintroduce Fault A's exact
    // failure — a stop repriced off a stale reference instead of the real (moved) fill.
    const order = paperOrder({ direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100] } as Partial<PaperOrder>);
    const client = new FakeLiveClient();
    client.marketFillPrice = 0; // placeOrder reports avgPrice=0 for the entry...
    client.queryOrderAvgPriceBySymbol.set("ETHUSDT", 1850); // ...but queryOrder confirms the real fill: 1850
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick();

    const intent = store.getState().intents[0]!;
    expect(intent.filledEntryPrice).toBeCloseTo(1850, 6); // the CONFIRMED fill, not paper's 2000
    expect(intent.entryPriceConfirmed).toBe(true);
    const stop = client.placed.find((p) => p.type === "STOP_MARKET");
    expect(stop!.stopPrice!).toBeCloseTo(1757.5, 1); // repriced off 1850, exactly like Fault A
  });

  it("marks entryPriceConfirmed=false (and falls back to the paper price) when queryOrder never confirms a real fill", async () => {
    const order = paperOrder({ direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100] } as Partial<PaperOrder>);
    const client = new FakeLiveClient();
    client.marketFillPrice = 0; // neither placeOrder nor queryOrder ever return a real avgPrice
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick();

    const intent = store.getState().intents[0]!;
    expect(intent.filledEntryPrice).toBeCloseTo(2000, 6); // honest fallback to the paper reference
    expect(intent.entryPriceConfirmed).toBe(false); // but HONESTLY flagged as unconfirmed
    expect(intent.state).toBe("OPEN"); // still opens — this is a data-honesty flag, not a blocker
  });

  it("Fault B: a paper order whose open keeps failing is quarantined — bounded retries, not infinite churn", async () => {
    const order = paperOrder({
      direction: "LONG",
      entryPrice: 2000,
      stopLoss: 1900,
      takeProfitLevels: [2100],
      paperStatus: "PAPER_SUBMITTED",
    } as Partial<PaperOrder>);
    const client = new FakeLiveClient();
    client.algoErrorCode = -2021; // protective stop always rejected → emergency flatten → ERROR every attempt
    // mirrorAll reproduces the real incident: it BYPASSES the createdAt watermark (the first line of
    // defence), so only the attempt latch can stop the churn.
    const { engine } = makeEngine({ client, paper: makePaperStore([order]), config: { mirrorAllPaperOrders: true } });
    await engine.arm();

    // The original bug re-opened every tick forever; the latch must cap it at MAX_MIRROR_ATTEMPTS.
    for (let i = 0; i < 10; i += 1) await engine.tick();
    const entries = client.placed.filter((p) => p.type === "MARKET" && !p.reduceOnly);
    expect(entries.length).toBeLessThanOrEqual(2);
    expect(engine.getStatus().quarantinedPaperOrders).toBe(1);
  });

  it("Fault C: an emergency flatten books its realized loss into the ledger and loss streak", async () => {
    const order = paperOrder({
      direction: "LONG",
      entryPrice: 2000,
      stopLoss: 1900,
      takeProfitLevels: [2100],
      paperStatus: "PAPER_SUBMITTED",
    } as Partial<PaperOrder>);
    const client = new FakeLiveClient();
    client.algoErrorCode = -2021;
    client.flattenRealizedPnl = -3; // the reduce-only flatten realizes a $3 loss
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick();

    // The old catch block flattened SILENTLY — the breakers never saw it. Now they must.
    expect(store.getState().consecutiveLosses).toBe(1);
    expect(store.getState().dailyLedger.realizedPnlUsd).toBeCloseTo(-3, 6);
    expect(store.getState().dailyLedger.losses).toBe(1);
  });

  it("five churn flattens trip the consecutive-loss kill-switch (defense in depth with the latch)", async () => {
    // Five distinct freefall paper orders, each flattening at a loss, must reach the 5-loss kill.
    const orders = Array.from({ length: 6 }, (_unused, i) =>
      paperOrder({
        paperOrderId: `paper-churn-${i}`,
        symbol: `SYM${i}USDT`,
        direction: "LONG",
        entryPrice: 2000,
        stopLoss: 1900,
        takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED",
      } as Partial<PaperOrder>),
    );
    const client = new FakeLiveClient();
    // Each symbol needs a filter; reuse ETH filters for all by overriding getExchangeFilters.
    client.getExchangeFilters = async () =>
      new Map(orders.map((o) => [o.symbol, { ...FILTERS, symbol: o.symbol }]));
    client.algoErrorCode = -2021;
    client.flattenRealizedPnl = -3;
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore(orders),
      // Raise the daily/drawdown limits so this test isolates the CONSECUTIVE-loss breaker
      // specifically (with defaults the daily-loss breaker would trip first — also correct).
      config: {
        mirrorAllPaperOrders: true,
        maxConcurrentPositions: 10,
        maxCorrelatedAltLongPositions: 10,
        // Isolate the consecutive-loss breaker: don't let the per-cluster cap (SYM* are unknown →
        // one shared OTHER cluster) throttle how many churn positions open this test.
        maxClusterPositions: 10,
        maxConsecutiveLosses: 5,
        dailyMaxLossUsd: 999,
        maxDrawdownUsd: 999,
      },
    });
    await engine.arm();
    await engine.tick(); // opens (and flattens) all six → ≥5 consecutive losses recorded
    await engine.tick(); // next tick: killSwitchTrip sees the streak and engages

    expect(store.getState().killedAt).not.toBeNull();
    expect(store.getState().killReason).toMatch(/consecutive losses/);
    expect(engine.isArmed()).toBe(false);
  });

  it("a failed addToIntent flattens the now-naked position (never left OPEN with a canceled stop) and latches the add", async () => {
    // Tick 1 opens p1 cleanly. Then a second same-symbol same-direction signal arrives and the
    // add's replacement stop is rejected -2021 — the position is naked the instant the old stop
    // is canceled, so it MUST be flattened, not left OPEN.
    const orders: PaperOrder[] = [
      paperOrder({
        paperOrderId: "p1",
        direction: "LONG",
        entryPrice: 2000,
        stopLoss: 1900,
        takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED",
        createdAt: "2099-01-02T00:00:00.000Z",
      } as Partial<PaperOrder>),
    ];
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore(orders),
      config: { mirrorAllPaperOrders: true, maxAggregateIntentRiskUsd: 10 },
    });
    await engine.arm();
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN");
    const placedBefore = client.placed.length;

    orders.push(
      paperOrder({
        paperOrderId: "p2",
        direction: "LONG",
        entryPrice: 2000,
        stopLoss: 1900,
        takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED",
        createdAt: "2099-01-02T01:00:00.000Z",
      } as Partial<PaperOrder>),
    );
    client.algoErrorCode = -2021; // the add's replacement stop is rejected
    client.flattenRealizedPnl = -2;
    await engine.tick();

    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("ERROR"); // NOT left OPEN with a canceled stop
    expect(intent.closeReason).toBe("EMERGENCY_FLATTEN_ADD_FAILED");
    const after = client.placed.slice(placedBefore);
    expect(after.some((p) => p.type === "MARKET" && p.reduceOnly)).toBe(true); // position flattened
    expect(store.getState().consecutiveLosses).toBeGreaterThanOrEqual(1); // loss booked
    expect(store.getState().mirrorAttempts.p2 ?? 0).toBeGreaterThanOrEqual(1); // add path latched
  });

  it("a failed add ENTRY leaves the position OPEN and protected (no naked window, no flatten) — the add-timeout bleed fix", async () => {
    // The add MARKET times out BEFORE any stop is cancelled. The original stop+TP still protect the
    // position, so it must stay OPEN and never be flattened (the old code dumped it at market).
    const orders: PaperOrder[] = [
      paperOrder({
        paperOrderId: "p1", direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED", createdAt: "2099-01-02T00:00:00.000Z",
      } as Partial<PaperOrder>),
    ];
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore(orders),
      config: { mirrorAllPaperOrders: true, maxAggregateIntentRiskUsd: 10 },
    });
    await engine.arm();
    await engine.tick();
    const opened = store.getState().intents[0]!;
    expect(opened.state).toBe("OPEN");
    const stopId = opened.stopOrderId;
    const placedBefore = client.placed.length;

    orders.push(
      paperOrder({
        paperOrderId: "p2", direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED", createdAt: "2099-01-02T01:00:00.000Z",
      } as Partial<PaperOrder>),
    );
    client.failAddEntry = true; // the aggregate-add MARKET times out
    await engine.tick();

    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN"); // NOT flattened, NOT ERROR
    expect(intent.closeReason ?? null).toBeNull(); // no EMERGENCY_FLATTEN_ADD_FAILED
    expect(intent.stopOrderId).toBe(stopId); // original stop untouched
    expect(client.canceled.some((c) => c.orderId === stopId)).toBe(false); // stop never cancelled
    const after = client.placed.slice(placedBefore);
    expect(after.some((p) => p.type === "MARKET" && p.reduceOnly)).toBe(false); // no flatten
    expect(intent.lastError ?? "").toMatch(/still protected/i);
  });

  it("testnet stratified collection never pyramids a new entry-regime into an existing intent", async () => {
    const orders: PaperOrder[] = [
      paperOrder({
        paperOrderId: "bull-source",
        selectedLaneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK",
        direction: "LONG",
        regime: "Bullish expansion",
        entryPrice: 2000,
        stopLoss: 1900,
        takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED",
      } as Partial<PaperOrder>),
    ];
    const { engine, client, store } = makeEngine({
      paper: makePaperStore(orders),
      config: { mirrorAllPaperOrders: true, testnetStratifiedCollection: true, maxAggregateIntentRiskUsd: 10 },
    });
    await engine.arm();
    await engine.tick();
    expect(store.getState().intents[0]!.sourcePaperOrders).toHaveLength(1);

    orders.push(paperOrder({
      paperOrderId: "bear-source",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK",
      direction: "LONG",
      regime: "Bearish pressure",
      entryPrice: 2000,
      stopLoss: 1900,
      takeProfitLevels: [2100],
      paperStatus: "PAPER_SUBMITTED",
    } as Partial<PaperOrder>));
    await engine.tick();

    expect(store.getState().intents[0]!.sourcePaperOrders).toHaveLength(1);
    expect(client.placed.filter((order) => order.type === "MARKET" && !order.reduceOnly)).toHaveLength(1);
  });

  it("confirms the ADD's real fill via queryOrder before averaging into filledEntryPrice, instead of silently trusting a stale reference", async () => {
    const orders: PaperOrder[] = [
      paperOrder({
        paperOrderId: "p1", direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED", createdAt: "2099-01-02T00:00:00.000Z",
      } as Partial<PaperOrder>),
    ];
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore(orders),
      config: { mirrorAllPaperOrders: true, maxAggregateIntentRiskUsd: 10 },
    });
    await engine.arm();
    await engine.tick(); // opens p1 at a confirmed 2000
    expect(store.getState().intents[0]!.entryPriceConfirmed).toBe(true);

    orders.push(
      paperOrder({
        paperOrderId: "p2", direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED", createdAt: "2099-01-02T01:00:00.000Z",
      } as Partial<PaperOrder>),
    );
    // The add's placeOrder response comes back avgPrice=0, but the real fill (confirmed via
    // queryOrder) has since moved well below the paper reference of 2000.
    client.marketFillPrice = 0;
    client.queryOrderAvgPriceBySymbol.set("ETHUSDT", 1700);
    await engine.tick();

    const intent = store.getState().intents[0]!;
    // If the bug were still present, the add would silently use the stale paper price (2000),
    // leaving filledEntryPrice unchanged at 2000. It must instead be pulled down toward the
    // confirmed 1700 fill.
    expect(intent.filledEntryPrice!).toBeLessThan(2000);
    expect(intent.entryPriceConfirmed).toBe(true); // the add's fill WAS confirmed, just at a moved price
    expect(intent.entryOrderIds).toHaveLength(2); // initial entry + pyramid add retained for fee settlement
  });

  it("marks the intent's entryPriceConfirmed false (monotonic-worst) when an ADD's fill can't be confirmed, even though the original entry was", async () => {
    const orders: PaperOrder[] = [
      paperOrder({
        paperOrderId: "p1", direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED", createdAt: "2099-01-02T00:00:00.000Z",
      } as Partial<PaperOrder>),
    ];
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore(orders),
      config: { mirrorAllPaperOrders: true, maxAggregateIntentRiskUsd: 10 },
    });
    await engine.arm();
    await engine.tick(); // opens p1 at a confirmed 2000
    expect(store.getState().intents[0]!.entryPriceConfirmed).toBe(true);

    orders.push(
      paperOrder({
        paperOrderId: "p2", direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED", createdAt: "2099-01-02T01:00:00.000Z",
      } as Partial<PaperOrder>),
    );
    client.marketFillPrice = 0; // the add's fill is never confirmed by placeOrder OR queryOrder
    await engine.tick();

    expect(store.getState().intents[0]!.entryPriceConfirmed).toBe(false);
  });

  it("auto-arm does NOT punch through a latched kill on restart", () => {
    const store = new LiveExecutionStore(tmp());
    store.getState().killedAt = "2099-01-01T00:00:00.000Z";
    store.getState().killReason = "test latch survives restart";
    store.save();
    const engine = new LiveExecutionEngine({
      config: makeConfig({ autoArm: true }),
      client: new FakeLiveClient() as unknown as LivePrivateClient,
      store,
      paperStore: makePaperStore([]),
      nowIso: () => "2099-01-02T12:00:00.000Z",
    });
    // A restart with auto-arm on must stay disarmed while the kill is latched.
    expect(engine.isArmed()).toBe(false);
  });

  it("arm() re-checks the kill latch AFTER the isHedgeMode() await — a kill that lands during that network round-trip must not be punched through", async () => {
    // arm()'s FIRST killedAt check passes (nothing latched yet), then it awaits isHedgeMode() — a
    // real network call. If a kill-switch (from a concurrent tick) latches during that exact
    // window, arm() must not blindly proceed to armed=true afterward: it must see the fresh latch.
    class RaceClient extends FakeLiveClient {
      constructor(private readonly onCheck: () => void) {
        super();
      }
      async isHedgeMode(): Promise<boolean> {
        this.onCheck(); // simulates a concurrent kill-switch latching mid-await
        return super.isHedgeMode();
      }
    }
    const store = new LiveExecutionStore(tmp());
    const client = new RaceClient(() => {
      store.getState().killedAt = "2099-01-02T12:00:00.500Z";
      store.getState().killReason = "concurrent kill mid-arm";
    });
    const engine = new LiveExecutionEngine({
      config: makeConfig({}),
      client: client as unknown as LivePrivateClient,
      store,
      paperStore: makePaperStore([]),
      nowIso: () => "2099-01-02T12:00:00.000Z",
    });

    const result = await engine.arm();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/kill-switch engaged/);
    expect(engine.isArmed()).toBe(false);
  });
});

describe("regime-flip rescue (shadow wiring)", () => {
  const RESCUE_ON = {
    enabled: true,
    minAgeMs: 60 * 60 * 1000,
    minLossUsd: 1,
    netFraction: 1,
    maxNotionalUsd: 1000,
    targetUsd: 0,
    maxSymbols: 2,
    minAvailableBalanceUsd: 10,
    maxHoldMs: 24 * 60 * 60 * 1000,
  };

  function seedStuckLong(store: ReturnType<typeof makeEngine>["store"]) {
    store.getState().intents.push({
      paperOrderId: "p-xrp",
      symbol: "XRPUSDT",
      direction: "LONG",
      state: "MIRRORED", // skipped by manageLifecycle, still seen by harvest + rescue
      qty: 236.2,
      tp1Qty: 0,
      plannedEntryPrice: 1.0572,
      stopLossPrice: 1.0,
      tp1Price: 1.1,
      filledEntryPrice: 1.0572,
      entryOrderId: "1",
      stopOrderId: null,
      tp1OrderId: null,
      beStopOrderId: null,
      realizedPnlUsd: null,
      feesUsd: null,
      createdAt: "2099-01-02T10:00:00.000Z", // 2h before nowIso ⇒ older than minAge
      updatedAt: "2099-01-02T10:00:00.000Z",
      closedAt: null,
      closeReason: null,
      lastError: null,
    });
    store.save();
  }

  it("records a FLIP plan for a stuck counter-regime long, places NO order (shadow)", async () => {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("XRPUSDT", 236.2);
    client.markPriceBySymbol.set("XRPUSDT", 1.04);
    client.unrealizedPnlBySymbol.set("XRPUSDT", -4.18);
    const { engine, store } = makeEngine({
      client,
      config: { rescue: RESCUE_ON, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: () => ({ regime: "Bearish", mode: "SHORT_ONLY", capturedAt: new Date().toISOString() }),
    });
    seedStuckLong(store);

    await engine.tick();

    const plan = store.getState().lastRescuePlan;
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe("shadow");
    expect(plan!.opposingDirection).toBe("LONG");
    expect(plan!.flips).toHaveLength(1);
    expect(plan!.flips[0]!.symbol).toBe("XRPUSDT");
    expect(plan!.flips[0]!.side).toBe("SELL");
    // SHADOW: it must not have placed any XRP order this tick.
    expect(client.placed.some((p) => p.symbol === "XRPUSDT")).toBe(false);
    expect(engine.getStatus().rescue.enabled).toBe(true);
  });

  it("stays dormant (no plan, no orders) when the rescue flag is off", async () => {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("XRPUSDT", 236.2);
    client.markPriceBySymbol.set("XRPUSDT", 1.04);
    client.unrealizedPnlBySymbol.set("XRPUSDT", -4.18);
    const { engine, store } = makeEngine({
      client, // rescue defaults to disabled in makeConfig
      getControllerSnapshot: () => ({ regime: "Bearish", mode: "SHORT_ONLY", capturedAt: new Date().toISOString() }),
    });
    seedStuckLong(store);

    await engine.tick();

    expect(store.getState().lastRescuePlan).toBeNull();
    expect(client.placed.some((p) => p.symbol === "XRPUSDT")).toBe(false);
  });
});

describe("regime-flip rescue (LIVE execution)", () => {
  const RESCUE_LIVE = {
    enabled: true,
    minAgeMs: 60 * 60 * 1000,
    minLossUsd: 1,
    netFraction: 1,
    maxNotionalUsd: 5000, // high enough that the 2× flip isn't capped below the opposing size
    targetUsd: 0,
    maxSymbols: 2,
    minAvailableBalanceUsd: 10,
    maxHoldMs: 24 * 60 * 60 * 1000,
  };
  const SHORT_REGIME = () => ({ regime: "Bearish", mode: "SHORT_ONLY", capturedAt: new Date().toISOString() });

  function pushIntent(store: ReturnType<typeof makeEngine>["store"], over: Record<string, unknown>) {
    store.getState().intents.push({
      paperOrderId: "p-x",
      symbol: "ETHUSDT",
      direction: "LONG",
      state: "OPEN",
      qty: 1.0,
      tp1Qty: 0,
      plannedEntryPrice: 2000,
      stopLossPrice: 1900,
      tp1Price: 2100,
      filledEntryPrice: 2000,
      entryOrderId: "1",
      stopOrderId: null,
      tp1OrderId: null,
      beStopOrderId: null,
      realizedPnlUsd: null,
      feesUsd: null,
      createdAt: "2099-01-02T10:00:00.000Z",
      updatedAt: "2099-01-02T10:00:00.000Z",
      closedAt: null,
      closeReason: null,
      lastError: null,
      ...over,
    } as never);
    store.save();
  }

  it("flips a stuck counter-regime LONG to a net SHORT, closes the old intent, and stays armed (reconcile-safe)", async () => {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", 1.0);
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", -5);
    const { engine, store } = makeEngine({
      client,
      config: { rescue: RESCUE_LIVE, rescueExecute: true, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: SHORT_REGIME,
    });
    expect((await engine.arm()).ok).toBe(true);
    pushIntent(store, { paperOrderId: "p-eth" });

    await engine.tick(); // flip

    const intents = store.getState().intents;
    const old = intents.find((i) => i.paperOrderId === "p-eth")!;
    expect(old.state).toBe("CLOSED");
    expect(old.closeReason).toBe("RESCUE_FLIP");
    const rescue = intents.find((i) => i.rescue === true)!;
    expect(rescue).toBeTruthy();
    expect(rescue.direction).toBe("SHORT");
    expect(rescue.qty).toBeCloseTo(1.0, 6); // SELL 2 on a +1 long ⇒ net short 1
    expect(client.placed.some((p) => p.symbol === "ETHUSDT" && p.side === "SELL" && p.type === "MARKET" && !p.reduceOnly)).toBe(true);

    // The flipped net short matches the rescue intent ⇒ reconcile must not disarm on the next tick.
    await engine.tick();
    expect(engine.isArmed()).toBe(true);
    expect(store.getState().lastRescuePlan!.mode).toBe("live");
  });

  it("prefers the exchange-confirmed entryPrice over an unconfirmed avgPrice=0 flip fill (never silently records a $0 entry)", async () => {
    // `??` does not catch a real 0 — `flip.avgPrice ?? after?.entryPrice` would have kept a
    // genuine avgPrice=0 forever, skipping the fresh getPositions() entryPrice fetched right
    // after the flip. FakeLiveClient.getPositions() always reports entryPrice=2000.
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", 1.0);
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", -5);
    client.marketFillPrice = 0; // the flip's placeOrder response reports avgPrice=0
    const { engine, store } = makeEngine({
      client,
      config: { rescue: RESCUE_LIVE, rescueExecute: true, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: SHORT_REGIME,
    });
    expect((await engine.arm()).ok).toBe(true);
    pushIntent(store, { paperOrderId: "p-eth" });

    await engine.tick(); // flip

    const rescue = store.getState().intents.find((i) => i.rescue === true)!;
    expect(rescue.filledEntryPrice).toBeCloseTo(2000, 6); // exchange-confirmed, NOT 0
    expect(rescue.plannedEntryPrice).toBeCloseTo(2000, 6);
    expect(rescue.entryPriceConfirmed).toBe(true);
  });

  it("flattens a rescued symbol once the combined venture clears target, booking the live leg", async () => {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", -1.0); // already flipped to net short
    client.markPriceBySymbol.set("ETHUSDT", 1850);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 10); // short in profit; combined = -4.72 + (10 - 4.07) = +1.21
    client.flattenRealizedPnl = 10;
    const { engine, store } = makeEngine({
      client,
      config: { rescue: RESCUE_LIVE, rescueExecute: true, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: SHORT_REGIME,
    });
    expect((await engine.arm()).ok).toBe(true);
    pushIntent(store, { paperOrderId: "p-resc", direction: "SHORT", rescue: true, rescuePriorRealizedUsd: -4.72, entryOrderId: "50" });

    await engine.tick();

    const r = store.getState().intents.find((i) => i.rescue === true)!;
    expect(r.state).toBe("CLOSED");
    expect(r.closeReason).toBe("RESCUE_FLATTEN_TARGET");
    expect(r.realizedPnlUsd).toBeCloseTo(10, 6);
    expect(client.placed.some((p) => p.symbol === "ETHUSDT" && p.reduceOnly && p.type === "MARKET")).toBe(true);
  });

  it("does NOT flip when disarmed (flips open exposure), but the plan is still recorded", async () => {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", 1.0);
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", -5);
    const { engine, store } = makeEngine({
      client,
      config: { rescue: RESCUE_LIVE, rescueExecute: true, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: SHORT_REGIME,
    });
    // not armed
    pushIntent(store, { paperOrderId: "p-eth" });

    await engine.tick();

    expect(store.getState().intents.find((i) => i.rescue === true)).toBeUndefined();
    expect(client.placed.some((p) => p.side === "SELL" && !p.reduceOnly)).toBe(false);
    expect(store.getState().lastRescuePlan!.flips.length).toBe(1); // planned, just not executed
  });
});

describe("mainnet profit protection (opt-in regime harvest on real money)", () => {
  // A counter-regime SHORT (opposing a LONG_ONLY controller), green after cost, seeded directly.
  function seedOpposingGreenShort(store: ReturnType<typeof makeEngine>["store"]) {
    store.getState().intents.push({
      paperOrderId: "p-eth",
      symbol: "ETHUSDT",
      direction: "SHORT",
      state: "MIRRORED", // seen by the harvest, skipped by manageLifecycle
      qty: 0.05,
      tp1Qty: 0,
      plannedEntryPrice: 2000,
      stopLossPrice: 2060,
      tp1Price: 1900,
      filledEntryPrice: 2000,
      entryOrderId: "1",
      stopOrderId: null,
      tp1OrderId: null,
      beStopOrderId: null,
      realizedPnlUsd: null,
      feesUsd: null,
      createdAt: "2099-01-02T11:00:00.000Z",
      updatedAt: "2099-01-02T11:00:00.000Z",
      closedAt: null,
      closeReason: null,
      lastError: null,
    } as never);
    store.save();
  }

  function mainnetEngine(profitProtection: boolean, clock = { iso: "2099-01-02T12:00:00.000Z" }) {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", -0.05); // net short
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.0); // green; est close cost ≈ 0.21
    client.flattenRealizedPnl = 0.78;
    const { engine, store } = makeEngine({
      client,
      nowIso: () => clock.iso,
      config: { env: "mainnet", mainnetConfirmed: true, mainnetProfitProtection: profitProtection },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
    });
    return { engine, client, store, clock };
  }

  it("WITHOUT the opt-in, mainnet leaves a counter-regime green position open (the old, exposed behavior)", async () => {
    const { engine, client, store } = mainnetEngine(false);
    seedOpposingGreenShort(store);
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("MIRRORED"); // not harvested
    expect(client.placed.length).toBe(0); // no flatten placed
    expect(engine.getStatus().limits.regimeExitActive).toBe(false);
  });

  it("WITH the opt-in, mainnet defers the counter-regime green position, then banks it after 24h", async () => {
    // 2026-07-26: the opt-in still governs WHETHER mainnet harvests at all (the test above proves
    // it stays fully hands-off when off). What changed is the TIMING once it is on — the green
    // counter-regime position now runs on its own geometry for the 24h backstop first.
    const { engine, client, store, clock } = mainnetEngine(true);
    seedOpposingGreenShort(store);
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("MIRRORED"); // deferred, not banked
    expect(client.placed.length).toBe(0);
    expect(engine.getStatus().limits.regimeExitActive).toBe(true); // the harvest IS active/armed

    clock.iso = "2099-01-03T12:00:01.000Z"; // 24h + 1s
    await engine.tick();
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_OPPOSITION_BREAKEVEN_DEFERRED_24H_LONG_ONLY");
    expect(closed.realizedPnlUsd).toBeCloseTo(0.78, 6);
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
    expect(flat.side).toBe("BUY"); // reduce a short
    expect(engine.getStatus().limits.regimeExitActive).toBe(true);
  });

  // [HARVEST-SHARE] 2026-07-07 REAL-MONEY INCIDENT: the harvest flattened Math.abs(positionAmt) =
  // the WHOLE netted position. On DOGEUSDT the intent (1065 short) shared the symbol with two
  // cross-sectional basket legs (665 short) — the harvest bought 1730, silently stripping the
  // baskets' hedge. It must close only the ENGINE's share.
  it("[HARVEST-SHARE] closes only the engine share when basket legs net the same symbol", async () => {
    const client = new FakeLiveClient();
    // Intent SHORT 0.05 + basket legs SHORT 0.10 on the same symbol ⇒ netted position -0.15.
    client.positionsBySymbol.set("ETHUSDT", -0.15);
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 3.0); // netted unrealized (whole position)
    client.flattenRealizedPnl = 0.78;
    const clock = { iso: "2099-01-02T12:00:00.000Z" };
    const { engine, store } = makeEngine({
      client,
      nowIso: () => clock.iso,
      config: { env: "mainnet", mainnetConfirmed: true, mainnetProfitProtection: true },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
      externalManagedNetQty: () => new Map([["ETHUSDT", -0.1]]), // the baskets' short claim
    });
    seedOpposingGreenShort(store);
    await engine.tick();
    // 2026-07-26: this green counter-regime position now defers 24h before the harvest takes it.
    // The incident this test guards is the SHARE math at the moment of the close, so drive the
    // clock past the backstop and assert exactly what it always asserted.
    clock.iso = "2099-01-03T12:00:01.000Z";
    await engine.tick();
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    const flat = client.placed.at(-1)!;
    expect(flat.side).toBe("BUY");
    expect(flat.quantity).toBeCloseTo(0.05, 9); // engine share ONLY — never the baskets' 0.10
  });

  it("[HARVEST-SHARE] skips harvest entirely when basket legs flipped the net sign (contaminated P&L)", async () => {
    const client = new FakeLiveClient();
    // Intent SHORT 0.05 but baskets LONG 0.2 ⇒ net +0.15 (sign flipped vs the intent).
    client.positionsBySymbol.set("ETHUSDT", 0.15);
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 3.0);
    const { engine, store } = makeEngine({
      client,
      config: { env: "mainnet", mainnetConfirmed: true, mainnetProfitProtection: true },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
      externalManagedNetQty: () => new Map([["ETHUSDT", 0.2]]),
    });
    seedOpposingGreenShort(store);
    await engine.tick();
    // engineAmt = 0.15 - 0.2 = -0.05 (short ✓) but net sign flipped ⇒ netted P&L says nothing
    // about the engine's leg ⇒ leave it to its own stop, place nothing.
    expect(store.getState().intents[0]!.state).toBe("MIRRORED");
    expect(client.placed.length).toBe(0);
  });
});

describe("crowdingExitRecommendation (pure classifier)", () => {
  it("recommends CUT when the regime-aligned crowd is still BUILDING", () => {
    // Stuck LONG opposing a SHORT-driving regime: the aligned side is SHORT.
    expect(crowdingExitRecommendation("SHORT", "BUILDING", "LONG")).toBe("CUT");
  });

  it("recommends HOLD when the regime-aligned crowd is UNWINDING (squeeze/bounce likely)", () => {
    expect(crowdingExitRecommendation("SHORT", "UNWINDING", "LONG")).toBe("HOLD");
  });

  it("recommends HOLD when the regime-aligned crowd is EXHAUSTING", () => {
    expect(crowdingExitRecommendation("SHORT", "EXHAUSTING", "LONG")).toBe("HOLD");
  });

  it("recommends NEUTRAL when the regime-aligned crowd is NEUTRAL", () => {
    expect(crowdingExitRecommendation("SHORT", "NEUTRAL", "LONG")).toBe("NEUTRAL");
  });

  it("recommends NEUTRAL when the crowd is on the WRONG side (not the regime-aligned side)", () => {
    // Stuck LONG (opposing SHORT_ONLY): the crowd being LONG-side crowded says nothing about
    // whether the SHORT-driving trend continues.
    expect(crowdingExitRecommendation("LONG", "BUILDING", "LONG")).toBe("NEUTRAL");
  });

  it("mirrors correctly for a stuck SHORT (opposing a LONG_ONLY regime)", () => {
    // Regime-aligned side for a stuck SHORT is LONG.
    expect(crowdingExitRecommendation("LONG", "BUILDING", "SHORT")).toBe("CUT");
    expect(crowdingExitRecommendation("LONG", "UNWINDING", "SHORT")).toBe("HOLD");
    expect(crowdingExitRecommendation("SHORT", "BUILDING", "SHORT")).toBe("NEUTRAL");
  });
});

describe("crowding-exit shadow measurement (SHADOW only — never alters cut/hold)", () => {
  function fakeFlowClient(flow: Partial<FuturesFlowSnapshot>): Pick<BinanceClient, "getFuturesFlow"> {
    return {
      getFuturesFlow: async () => ({
        fundingRate: null,
        openInterestChangePercent: null,
        takerBuySellRatio: null,
        longShortRatio: null,
        ...flow,
      }),
    };
  }

  it("records a CUT recommendation that AGREES with an actual hard-cut, without changing the cut", async () => {
    // Stuck SHORT (ETHUSDT) opposing LONG_ONLY, sustained past the hard-cut window, RED.
    let now = "2099-01-02T12:00:00.000Z";
    const order = paperOrder(); // SHORT, ETHUSDT
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore([order]),
      nowIso: () => now,
      config: { testnetRegimeHardCutMs: 30 * 60 * 1000, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
      // Regime-aligned side for a stuck SHORT is LONG; LONG-side crowded + OI rising ⇒ BUILDING ⇒ CUT.
      marketDataClient: fakeFlowClient({ fundingRate: 0.0005, openInterestChangePercent: 2 }),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick(); // opens the short; opposition starts at T0

    client.markPriceBySymbol.set("ETHUSDT", 2100);
    client.unrealizedPnlBySymbol.set("ETHUSDT", -2.0); // RED
    client.flattenRealizedPnl = -2.0;

    now = "2099-01-02T12:31:00.000Z"; // past the 30-min hard-cut
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_OPPOSITION_HARD_CUT_LONG_ONLY"); // the ACTUAL decision — unchanged

    const shadow = engine.getStatus().crowdingExitShadow["ETHUSDT"];
    expect(shadow).toBeDefined();
    expect(shadow.recommendation).toBe("CUT");
    expect(shadow.actualAction).toBe("CUT");
    expect(shadow.agree).toBe(true);
  });

  it("records a HOLD recommendation that DISAGREES with an actual hard-cut — still cuts anyway (shadow never overrides)", async () => {
    let now = "2099-01-02T12:00:00.000Z";
    const order = paperOrder(); // SHORT, ETHUSDT
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore([order]),
      nowIso: () => now,
      config: { testnetRegimeHardCutMs: 30 * 60 * 1000, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
      // LONG-side crowded + OI falling ⇒ UNWINDING ⇒ HOLD recommendation — but the hard-cut fires anyway.
      marketDataClient: fakeFlowClient({ fundingRate: 0.0005, openInterestChangePercent: -2 }),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    client.markPriceBySymbol.set("ETHUSDT", 2100);
    client.unrealizedPnlBySymbol.set("ETHUSDT", -2.0);
    client.flattenRealizedPnl = -2.0;

    now = "2099-01-02T12:31:00.000Z";
    await engine.tick();

    // The REAL position is still cut on schedule — the shadow measurement changed nothing.
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_OPPOSITION_HARD_CUT_LONG_ONLY");

    const shadow = engine.getStatus().crowdingExitShadow["ETHUSDT"];
    expect(shadow.recommendation).toBe("HOLD");
    expect(shadow.actualAction).toBe("CUT");
    expect(shadow.agree).toBe(false);
  });

  it("stays completely dormant (no shadow entries, no calls) without a marketDataClient", async () => {
    const order = paperOrder();
    const { engine, store } = makeEngine({
      paper: makePaperStore([order]),
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
      // no marketDataClient
    });
    await engine.arm();
    await engine.tick();
    expect(store.getState().crowdingExitShadow).toEqual({});
  });
});

describe("operator lane selection (POST /api/live/lanes → setAllowedLanes)", () => {
  it("null (default) mirrors any lane; a selected list blocks non-matching lanes", async () => {
    const order = paperOrder({ selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT" } as Partial<PaperOrder>);
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);

    // Restrict to a different lane BEFORE the first tick — the order must be skipped.
    engine.setAllowedLanes(["CG_WIDE_LONG_RUNNER"]);
    await engine.tick();
    expect(store.getState().intents.length).toBe(0);
  });

  it("matches by variant suffix as well as full lane id, and persists in state", async () => {
    const order = paperOrder({ selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT" } as Partial<PaperOrder>);
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);

    const res = engine.setAllowedLanes(["CG_WIDE_FAST_SHORT"]); // suffix form
    expect(res.allowedLaneIds).toEqual(["CG_WIDE_FAST_SHORT"]);
    expect(store.getState().allowedLaneIds).toEqual(["CG_WIDE_FAST_SHORT"]);
    await engine.tick();
    expect(store.getState().intents.length).toBe(1);
    expect(engine.getStatus().laneSelection).toMatchObject({
      allowedLaneIds: ["CG_WIDE_FAST_SHORT"],
      laneAllocations: null,
      mode: "SELECTED",
    });
  });

  it("[] pauses every new mirror; null restores all lanes", async () => {
    const order = paperOrder({ selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT" } as Partial<PaperOrder>);
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);

    engine.setAllowedLanes([]);
    expect(engine.getStatus().laneSelection.mode).toBe("PAUSED_ALL");
    await engine.tick();
    expect(store.getState().intents.length).toBe(0);

    engine.setAllowedLanes(null);
    expect(engine.getStatus().laneSelection.mode).toBe("ALL_LANES");
    await engine.tick();
    expect(store.getState().intents.length).toBe(1);
  });
});

describe("copyExternalIntent (testnet→live copy button)", () => {
  const spec = {
    symbol: "ETHUSDT",
    direction: "SHORT" as const,
    qty: 0.05,
    entryPrice: 2000,
    stopLossPrice: 2100,
    tp1Price: 1900,
    exitRule: "tp1_full" as const,
    sourceLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
    sourcePaperOrderId: "paper-src-1",
    sourceEnv: "testnet",
  };

  it("refuses while DISARMED (the master switch is not bypassed by the button)", async () => {
    const { engine, store } = makeEngine();
    const res = await engine.copyExternalIntent(spec);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/DISARMED/);
    expect(store.getState().intents.length).toBe(0);
  });

  it("opens an exact copy with protective stop + TP and a TESTNET_COPY lane tag", async () => {
    const { engine, client, store } = makeEngine();
    expect((await engine.arm()).ok).toBe(true);
    const res = await engine.copyExternalIntent(spec);
    expect(res.ok).toBe(true);
    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(intent.symbol).toBe("ETHUSDT");
    expect(intent.direction).toBe("SHORT");
    expect(intent.exitRule).toBe("tp1_full");
    expect(intent.sourcePaperOrders?.[0]?.laneId).toBe("TESTNET_COPY:CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT");
    // entry MARKET + protective stop + TP were all placed
    const types = client.placed.map((p) => p.type);
    expect(types).toContain("MARKET");
    expect(intent.stopOrderId).not.toBeNull();
    expect(intent.tp1OrderId).not.toBeNull();
    // full-TP exit rule ⇒ tp1Qty equals qty (banks 100% at TP1)
    expect(intent.tp1Qty).toBeCloseTo(intent.qty, 9);
    expect(intent.plannedRiskUsd).toBeCloseTo(5, 6);
    expect(intent.requiredNotionalUsd).toBeCloseTo(100, 6);
    expect(intent.appliedNotionalUsd).toBeCloseTo(100, 6);
    expect(intent.notionalCapUsd).toBe(250);
    expect(intent.stopDistancePct).toBeCloseTo(0.05, 9);
    expect(engine.getStatus().riskSizing).toEqual(
      expect.objectContaining({
        avgPlannedRiskUsd: 5,
        avgRequiredNotionalUsd: 100,
        avgAppliedNotionalUsd: 100,
        avgNotionalCapUsd: 250,
        avgStopDistancePct: 0.05,
        clippingRatePct: 0,
      }),
    );
  });

  it("refuses a second copy on a symbol that already has an open intent", async () => {
    const { engine } = makeEngine();
    expect((await engine.arm()).ok).toBe(true);
    expect((await engine.copyExternalIntent(spec)).ok).toBe(true);
    const res = await engine.copyExternalIntent(spec);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/already open/);
  });

  it("returns the durable prior intent for the same idempotency key, including after store reload", async () => {
    const dataDir = tmp();
    const client = new FakeLiveClient();
    const first = makeEngine({ client, store: new LiveExecutionStore(dataDir) });
    expect((await first.engine.arm()).ok).toBe(true);
    const request = { ...spec, idempotencyKey: "testnet:paper-src-1" };
    const opened = await first.engine.copyExternalIntent(request);
    expect(opened.ok).toBe(true);
    expect(first.store.getState().intents[0]?.externalCopyIdempotencyKey).toBe(request.idempotencyKey);
    const placedAfterOpen = client.placed.length;

    const reloaded = makeEngine({ client, store: new LiveExecutionStore(dataDir) });
    const replay = await reloaded.engine.copyExternalIntent(request);
    expect(replay.ok).toBe(true);
    expect(replay.reason).toMatch(/idempotent replay/);
    expect(replay.intent?.paperOrderId).toBe(opened.intent?.paperOrderId);
    expect(client.placed).toHaveLength(placedAfterOpen);
  });

  it("refuses invalid geometry (stop on the wrong side for the direction)", async () => {
    const { engine } = makeEngine();
    expect((await engine.arm()).ok).toBe(true);
    const res = await engine.copyExternalIntent({ ...spec, stopLossPrice: 1900, tp1Price: 2100 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/geometry/);
  });

  // 2026-08 adversarial-review follow-up to the manual-directional canonical-regime enforcement
  // fix: this composed its OWN reason string from this.strategyEntryGate() (the NON-manual gate)
  // instead of the new this.newEntryBlockReason() (entryGateDecision()'s own reason, which is
  // manual-mode-aware). The two only ever disagree when canOpenNewEntries() is false for a
  // manual-mode-specific cause (here, the new regimeSafetyGate) while the ordinary strategy gate
  // would itself have said "allowed" for the SAME tick — exactly what this test constructs, by
  // leaving newEntryGate at its default-permissive fallback while regimeSafetyGate blocks.
  it("[diagnostics] a manual-directional entry blocked by the regime-safety gate reports the ACTUAL block reason via copyExternalIntent, not the generic 'new-entry gate is closed' fallback", async () => {
    const { engine } = makeEngine({
      // newEntryGate left unset ⇒ engine's own default-permissive fallback (allowed: true) — the
      // ordinary (non-manual) gate is NOT what is blocking this tick.
      regimeSafetyGate: () => ({ allowed: false, reason: "canonical regime PANIC active" }),
    });
    expect((await engine.arm()).ok).toBe(true);
    engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }],
      short: [],
    });
    engine.setManualSelectorMode(true);
    engine.setManualEntryDecision({
      action: "WAIT_PULLBACK",
      directionalBias: "LONG",
      reason: "test",
      observedAt: "2099-01-02T12:00:00.000Z",
    });
    // Sanity: canOpenNewEntries() really is false, and for the regime-safety cause specifically —
    // not armed/kill/drain (none configured here) and not a stale decision (fresh, matches nowIso()).
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toBe("canonical regime PANIC active");
    const res = await engine.copyExternalIntent(spec);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("canonical regime PANIC active");
  });

  it("getOpenIntentCopySpec returns the relay spec for an OPEN intent only", async () => {
    const order = paperOrder(); // SHORT ETHUSDT 2000/2100/1900
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    const lookup = engine.getOpenIntentCopySpec(intent.paperOrderId);
    expect(lookup.ok).toBe(true);
    expect(lookup.spec?.symbol).toBe("ETHUSDT");
    expect(lookup.spec?.qty).toBeCloseTo(intent.qty, 9);
    expect(lookup.spec?.stopLossPrice).toBe(intent.stopLossPrice);
    expect(engine.getOpenIntentCopySpec("nope").ok).toBe(false);
  });
});

describe("weighted lane allocation (POST /api/live/lane-allocations)", () => {
  it("validates entries and persists; status mode becomes WEIGHTED_ALLOCATION", async () => {
    const { engine, store } = makeEngine();
    expect(engine.setLaneAllocations([{ laneId: "A", weightPct: 0 }]).ok).toBe(false);
    expect(engine.setLaneAllocations([{ laneId: "A", weightPct: 101 }]).ok).toBe(false);
    expect(engine.setLaneAllocations([{ laneId: "A", weightPct: 50 }, { laneId: "A", weightPct: 50 }]).ok).toBe(false);
    const ok = engine.setLaneAllocations([
      { laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 },
      { laneId: "CG_WIDE_FAST_LONG", weightPct: 30 },
    ]);
    expect(ok.ok).toBe(true);
    expect(store.getState().laneAllocations).toEqual([
      { laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 },
      { laneId: "CG_WIDE_FAST_LONG", weightPct: 30 },
    ]);
    expect(engine.getStatus().laneSelection.mode).toBe("WEIGHTED_ALLOCATION");
    expect(engine.setLaneAllocations(null).laneAllocations).toBeNull();
    expect(engine.getStatus().laneSelection.mode).toBe("ALL_LANES");
  });

  it("[2026-07-09] accepts up to MAX_LANE_ALLOCATIONS (10, raised from the old hardcoded 4) and rejects one more", async () => {
    const { engine } = makeEngine();
    const tenLanes = Array.from({ length: 10 }, (_, i) => ({ laneId: `LANE_${i}`, weightPct: 10 }));
    expect(engine.setLaneAllocations(tenLanes).ok).toBe(true);
    const elevenLanes = Array.from({ length: 11 }, (_, i) => ({ laneId: `LANE_${i}`, weightPct: 10 }));
    const rejected = engine.setLaneAllocations(elevenLanes);
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toContain("1-10 lanes");
  });

  it("[2026-07-09] a real 5-lane allocation (existing REGIME_COMPOSITE_CONFIRMATION_LONG + 4 COMPOSITE_ESTIMATOR_BIDI buckets) is accepted", async () => {
    const { engine, store } = makeEngine();
    const result = engine.setLaneAllocations([
      { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 100 },
      { laneId: "COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG", weightPct: 100 },
      { laneId: "COMPOSITE_ESTIMATOR_BIDI_WIDE_SHORT", weightPct: 100 },
      { laneId: "COMPOSITE_ESTIMATOR_BIDI_FAST_LONG", weightPct: 100 },
      { laneId: "COMPOSITE_ESTIMATOR_BIDI_FAST_SHORT", weightPct: 100 },
    ]);
    expect(result.ok).toBe(true);
    expect(store.getState().laneAllocations).toHaveLength(5);
  });

  it("scales the mirrored entry size by the lane's weight (70% ⇒ 0.7× qty)", async () => {
    const order = paperOrder({ selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT" } as Partial<PaperOrder>);
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    // Baseline plan: risk $5 across a 5% stop (2000→2100) ⇒ notional $100 ⇒ qty 0.05.
    // At 70% ⇒ 0.035 (stepSize 0.001).
    expect(intent.qty).toBeCloseTo(0.035, 9);
  });

  it("blocks a lane NOT in the allocation even if the allow-list would permit it", async () => {
    const order = paperOrder({ selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG" } as Partial<PaperOrder>);
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    engine.setAllowedLanes(["CG_WIDE_FAST_LONG"]); // allow-list would permit it…
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 100 }]); // …but allocations take precedence
    await engine.tick();
    expect(store.getState().intents.length).toBe(0);
  });

  it("exposes lane-selection helpers for non-paper lanes such as cross-sectional market-neutral", () => {
    const { engine } = makeEngine();
    expect(engine.laneSelectionAllowsLane("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(true);
    expect(engine.laneSelectionWeightPctForLane("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(100);

    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    expect(engine.laneSelectionAllowsLane("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(false);
    expect(engine.laneSelectionWeightPctForLane("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(0);

    engine.setLaneAllocations([
      { laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 },
      { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 30 },
    ]);
    expect(engine.laneSelectionAllowsLane("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(true);
    expect(engine.laneSelectionWeightPctForLane("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(30);
  });
});

describe("CORTEX Phase-4 promoted-weight override (2026-07-20, operator-approved testnet-only)", () => {
  it("2026-07-20 HIGH safety-review fix: never reinstates a lane the operator explicitly excluded from the weighted table", () => {
    const { engine } = makeEngine();
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]); // CG_WIDE_FAST_LONG deliberately omitted
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(0); // blocked, as expected

    // CORTEX's roster covers CG_WIDE_FAST_LONG and computes a real nonzero tilt for it — but the
    // operator never funded this lane in the live weighted-allocation table at all.
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 5, CG_WIDE_FAST_LONG: 20 });
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(0); // still blocked — CORTEX may only rescale, never reinstate
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(5); // the already-funded lane still tilts normally
  });

  it("overrides the plain allocation table's weight for a listed lane once installed", () => {
    const { engine } = makeEngine();
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(70);

    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 12.5 });
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(12.5);
    expect(engine.getCortexPromotedWeights()).toEqual({ CG_WIDE_FAST_SHORT: 12.5 });
  });

  it("resolves the variant-id suffix the same way the plain table lookup does", () => {
    const { engine } = makeEngine();
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 5 });
    expect(engine.laneSelectionWeightPctForLane("CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT")).toBe(5);
  });

  it("never applies while allocations are OFF (null ⇒ 100 unblocked sentinel) — no semantics mixing", () => {
    const { engine } = makeEngine();
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(100); // no table configured
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 5 });
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(100); // still untouched
  });

  it("never applies during a manual-directional HOLD (no fresh Entry Decision yet ⇒ empty/blocked, 0 stays 0)", () => {
    // effectiveLaneAllocations() returns [] here (an intentional directional hold), which
    // laneSelectionWeightPctForLane short-circuits to 0 BEFORE the CORTEX override is even consulted.
    const { engine } = makeEngine();
    engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 70 }],
      short: [{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 80 }],
    });
    engine.setManualSelectorMode(true); // no setManualEntryDecision ⇒ still holding
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_LONG: 5 });
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(0);
  });

  it("goes inert while manual-directional mode is actively selecting lanes — the operator's explicit choice always wins", () => {
    const { engine } = makeEngine();
    engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 70 }],
      short: [{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 80 }],
    });
    engine.setManualSelectorMode(true);
    engine.setManualEntryDecision({
      action: "WAIT_PULLBACK",
      directionalBias: "LONG",
      reason: "test",
      observedAt: "2099-01-02T12:00:00.000Z",
    });
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(70); // manual table, unmodified

    engine.setCortexPromotedWeights({ CG_WIDE_FAST_LONG: 5 }); // CORTEX says 5%...
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(70); // ...but manual still wins
  });

  it("setCortexPromotedWeights(null) clears the override, reverting to the plain table", () => {
    const { engine } = makeEngine();
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 5 });
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(5);

    engine.setCortexPromotedWeights(null);
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(70);
    expect(engine.getCortexPromotedWeights()).toBeNull();
  });

  it("a lane the promoted map doesn't mention falls through untouched to the plain table", () => {
    const { engine } = makeEngine();
    engine.setLaneAllocations([
      { laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 },
      { laneId: "CG_WIDE_FAST_LONG", weightPct: 30 },
    ]);
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 5 }); // says nothing about CG_WIDE_FAST_LONG
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(5);
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(30); // unaffected
  });

  it("a fresh engine defaults to no override at all (getCortexPromotedWeights null)", () => {
    const { engine } = makeEngine();
    expect(engine.getCortexPromotedWeights()).toBeNull();
  });
});

describe("rawLaneAllocationWeightPctForLane (2026-07-21 CRITICAL fix: breaks a self-referential feedback loop)", () => {
  // Bug reproduction: CORTEX's own "static weight" input used to be wired to
  // laneSelectionWeightPctForLane — the SAME accessor its own promoted output feeds back into. A cycle
  // that installs a promoted weight poisons the very next cycle's "static" read, which (for a
  // direction-split roster lane like CG_MFE_GIVEBACK_LONG/_SHORT) folds into a phantom concentration
  // that trips the per-lane cap, clearing the override — so the cycle after reads the TRUE table again
  // and re-promotes, oscillating forever. Observed live: a real static 12% (24% folded) alternated with
  // a contaminated ~21.5% (43.1% folded) every other 5-minute cycle, never stabilizing.

  it("returns the TRUE operator table value even while a CORTEX override is installed — immune to self-contamination", () => {
    const { engine } = makeEngine();
    engine.setLaneAllocations([{ laneId: "CG_MFE_GIVEBACK", weightPct: 12 }]);
    expect(engine.rawLaneAllocationWeightPctForLane("CG_MFE_GIVEBACK")).toBe(12);

    // Simulate a prior cycle's promotion having installed a tilted weight for this same lane.
    engine.setCortexPromotedWeights({ CG_MFE_GIVEBACK: 21.5 });

    // The REAL order-sizing accessor is correctly rescaled by the override (unchanged behavior)...
    expect(engine.laneSelectionWeightPctForLane("CG_MFE_GIVEBACK")).toBe(21.5);
    // ...but CORTEX's own next-cycle "static" input must NOT see that contaminated number.
    expect(engine.rawLaneAllocationWeightPctForLane("CG_MFE_GIVEBACK")).toBe(12);
  });

  it("matches laneSelectionWeightPctForLane's plain-table semantics when no override is installed", () => {
    const { engine } = makeEngine();
    expect(engine.rawLaneAllocationWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(100); // no table ⇒ unblocked sentinel

    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    expect(engine.rawLaneAllocationWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(70);
    expect(engine.rawLaneAllocationWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(0); // excluded lane
    expect(engine.rawLaneAllocationWeightPctForLane("CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT")).toBe(70); // variantId suffix
  });

  it("empty allocations (intentional manual-directional hold) resolve to 0, same as the real accessor", () => {
    const { engine } = makeEngine();
    engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 70 }],
      short: [{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 80 }],
    });
    engine.setManualSelectorMode(true); // no setManualEntryDecision ⇒ still holding ⇒ effectiveLaneAllocations() === []
    expect(engine.rawLaneAllocationWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(0);
  });

  it("end-to-end: a clean split-lane fold stays clean across repeated cycles instead of oscillating", () => {
    // Reproduces the exact live scenario: CG_MFE_GIVEBACK's two roster halves (LONG/SHORT) both read the
    // SAME real engine lane's static weight. Before the fix, alternating cycles fed 12 then a
    // contaminated ~21.5 into this lookup. After the fix, every cycle sees the true 12 regardless of
    // what CORTEX itself installed last cycle.
    const { engine } = makeEngine();
    engine.setLaneAllocations([{ laneId: "CG_MFE_GIVEBACK", weightPct: 12 }]);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const staticNow = engine.rawLaneAllocationWeightPctForLane("CG_MFE_GIVEBACK");
      expect(staticNow).toBe(12); // never contaminated by the previous cycle's install
      const foldedTotal = staticNow * 2; // both LONG and SHORT roster halves share this one real value
      expect(foldedTotal).toBeLessThan(35); // stays safely under CORTEX_LANE_CAP_PCT every cycle
      // Simulate this cycle's promotion succeeding and installing a (slightly tilted) weight, as the
      // real promotion path would once the invariant checks pass.
      engine.setCortexPromotedWeights({ CG_MFE_GIVEBACK: staticNow + 0.3 });
    }
  });
});

describe("CORTEX real-USDT attribution (2026-07-21: realizedPnlUsd × open-time tiltShare, report-only)", () => {
  // FAIL-WITHOUT-FIX: before this feature, LiveExecutionEngine had no cortexRealAttribution option,
  // LiveIntent had no cortexAppliedWeightPct/cortexRawStaticWeightPct capture, and no sweep existed —
  // these tests cannot even construct against pre-feature code, and with the option removed the
  // attribution store trivially stays empty after a real open→close cycle.

  function tp1FullOrder() {
    return paperOrder({ selectedLaneId: "CG_WIDE_FAST_SHORT", variantExitRule: "tp1_full" });
  }

  /** Drives the standard tp1_full close: TP1 fills the whole position → flat → settleClosedIntent
   *  books net = realizedPnl − commission from the exchange's own trade records. */
  async function closeViaTp1(engine: LiveExecutionEngine, client: FakeLiveClient, intent: LiveIntent, realizedPnl: number, commission: number) {
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set(intent.symbol, 0);
    client.trades = [
      { symbol: intent.symbol, orderId: intent.tp1OrderId!, price: 1900, qty: intent.qty, realizedPnl, commission, commissionAsset: "USDT", time: 1 },
    ];
    await engine.tick();
  }

  it("open under an INSTALLED promoted tilt → close → attribution record with the exact open-time tiltShare", async () => {
    const attribution = new CortexRealAttributionStore(tmp());
    const order = tp1FullOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]), cortexRealAttribution: attribution });
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 74.62 }); // CORTEX upsized 70% → 74.62%
    expect((await engine.arm()).ok).toBe(true);

    await engine.tick(); // mirrors + opens
    const intent = store.getState().intents[0]!;
    // Capture-at-open: BOTH weights frozen on the persisted intent, from the sizing path itself.
    expect(intent.cortexAppliedWeightPct).toBeCloseTo(74.62, 9);
    expect(intent.cortexRawStaticWeightPct).toBe(70);
    expect(attribution.getState().records).toHaveLength(0); // nothing attributed while open

    await closeViaTp1(engine, client, intent, 5, 0.04); // net +4.96
    expect(store.getState().intents[0]!.state).toBe("CLOSED");

    const records = attribution.getState().records;
    expect(records).toHaveLength(1);
    const record = records[0]!;
    const expectedShare = (74.62 - 70) / 74.62;
    expect(record.laneId).toBe("CG_WIDE_FAST_SHORT");
    expect(record.symbol).toBe("ETHUSDT");
    expect(record.realizedPnlUsd).toBeCloseTo(4.96, 6);
    expect(record.tiltShare).toBeCloseTo(expectedShare, 9);
    expect(record.cortexUsd).toBeCloseTo(4.96 * expectedShare, 6);
    // Aggregator: the close lands in "today" (the engine's fixed nowIso day) and all-time.
    const report = attribution.buildReport("2099-01-02T23:00:00.000Z");
    expect(report.today.n).toBe(1);
    expect(report.today.cortexUsd).toBeCloseTo(4.96 * expectedShare, 6);
    expect(report.allTime.n).toBe(1);

    // Idempotent: further ticks re-sweep the same CLOSED intent without double-booking.
    await engine.tick();
    await engine.tick();
    expect(attribution.getState().records).toHaveLength(1);
    expect(attribution.getState().allTime.n).toBe(1);

    // 2026-07-21 review fix: the booked intent carries a DURABLE dedup flag, persisted with the
    // intent — so even total attribution-store loss (corrupt/deleted file, dedup-FIFO eviction)
    // can never re-book it. Simulate by wiping the attribution store's own state entirely.
    expect(store.getState().intents[0]!.cortexAttributed).toBe(true);
    const wiped = attribution.getState();
    wiped.records.length = 0;
    wiped.allTime.n = 0;
    wiped.allTime.cortexUsd = 0;
    wiped.attributedRecordIds.length = 0;
    (attribution as unknown as { attributedIdSet: Set<string> }).attributedIdSet.clear();
    await engine.tick();
    expect(attribution.getState().records).toHaveLength(0); // NOT re-booked — the intent flag held
    expect(attribution.getState().allTime.n).toBe(0);
  });

  it("a DOWNSIZING tilt on a losing close books a POSITIVE cortexUsd (CORTEX saved money) — sign honesty end to end", async () => {
    const attribution = new CortexRealAttributionStore(tmp());
    const order = tp1FullOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]), cortexRealAttribution: attribution });
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 56 }); // CORTEX downsized 70% → 56%
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;

    await closeViaTp1(engine, client, intent, -3, 0.04); // net −3.04: a real loss
    const record = attribution.getState().records[0]!;
    expect(record.tiltShare).toBeCloseTo((56 - 70) / 56, 9); // negative share — a downsizing tilt
    expect(record.cortexUsd).toBeCloseTo(-3.04 * ((56 - 70) / 56), 6);
    expect(record.cortexUsd).toBeGreaterThan(0); // loser shrunk by CORTEX ⇒ CORTEX saved dollars
  });

  it("open with NO tilt → close → an explicit tiltShare-0 / $0 record IS written (documented choice: every " +
    "captured close is booked, so the all-time n is an honest denominator)", async () => {
    const attribution = new CortexRealAttributionStore(tmp());
    const order = tp1FullOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]), cortexRealAttribution: attribution });
    // No allocations table and no promoted weights at all — applied == raw == 100.
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    expect(intent.cortexAppliedWeightPct).toBe(100);
    expect(intent.cortexRawStaticWeightPct).toBe(100);

    await closeViaTp1(engine, client, intent, 5, 0.04);
    const record = attribution.getState().records[0]!;
    expect(record.tiltShare).toBe(0);
    expect(record.cortexUsd).toBe(0);
    expect(record.realizedPnlUsd).toBeCloseTo(4.96, 6);
    expect(attribution.buildReport("2099-01-02T23:00:00.000Z").allTime).toMatchObject({ n: 1, cortexUsd: 0 });
  });

  it("no attribution store wired (every pre-existing caller/test) → engine behaves byte-for-byte as before", async () => {
    const order = tp1FullOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 70 }]);
    engine.setCortexPromotedWeights({ CG_WIDE_FAST_SHORT: 74.62 });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    expect(intent.cortexAppliedWeightPct).toBeCloseTo(74.62, 9); // capture still happens (persisted data)
    await closeViaTp1(engine, client, intent, 5, 0.04);
    expect(store.getState().intents[0]!.state).toBe("CLOSED"); // close path fully unaffected
  });

  it("SingleSymbolLaneExecutor path: capture at open (applied vs rawLaneWeightPct) + attribution at close finalization", async () => {
    const attribution = new CortexRealAttributionStore(tmp());
    const { engine, client } = makeEngine();
    const signals: SingleSymbolFreshSignal[] = [];
    const NOW_ISO = "2026-07-21T12:00:00.000Z";
    const executorStore = new SingleSymbolLaneExecutorStore(tmp(), "test.json");
    const executor = new SingleSymbolLaneExecutor({
      client: client as unknown as SingleSymbolExecClient,
      store: executorStore,
      laneId: "COMPOSITE_ESTIMATOR_WIDE_LONG",
      direction: "LONG",
      getOpenSignals: () => signals,
      exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
      isAllowed: () => true,
      // The exact app.ts wiring shape: applied = tilted selection weight, raw = untouched table.
      laneWeightPct: () => 53.3,
      rawLaneWeightPct: () => 50,
      cortexRealAttribution: attribution,
      legUsd: () => 200,
      leverage: () => 3,
      maxOpenPositions: () => 1,
      nowIso: () => NOW_ISO,
      fillConfirmRetryDelayMs: 0,
      onPositionClosed: (netUsd) => engine.recordExternalConsecutiveLossOutcome(netUsd),
    });

    signals.push({
      observationId: "ce:ETHUSDT:1",
      symbol: "ETHUSDT",
      entryPrice: 2000,
      stopPrice: 1900,
      targetPrice: 2100,
      maxHoldMs: 90_000,
      openedAtMs: new Date(NOW_ISO).getTime() - 5_000,
    });
    await executor.tick();
    const pos = executorStore.getState().positions.find((p) => p.status === "OPEN")!;
    expect(pos.cortexAppliedWeightPct).toBeCloseTo(53.3, 9);
    expect(pos.cortexRawStaticWeightPct).toBe(50);
    expect(pos.targetPrice).toBe(2100);
    expect(pos.maxHoldMs).toBe(90_000);
    // legUsd scaled by the SAME captured applied weight: 200 × 0.533 / 2000 = 0.0533 → step 0.053.
    expect(pos.qty).toBeCloseTo(0.053, 9);
    expect(attribution.getState().records).toHaveLength(0);

    client.flattenRealizedPnl = 10;
    const result = await executor.manualClosePosition(pos.positionId);
    expect(result.ok).toBe(true);
    expect(result.netPnlUsd).toBeCloseTo(10, 6);

    const record = attribution.getState().records[0]!;
    const expectedShare = (53.3 - 50) / 53.3;
    expect(record.laneId).toBe("COMPOSITE_ESTIMATOR_WIDE_LONG");
    expect(record.tiltShare).toBeCloseTo(expectedShare, 9);
    expect(record.cortexUsd).toBeCloseTo(10 * expectedShare, 6);
    expect(record.closedAtIso).toBe(NOW_ISO);
  });
});

// 2026-07-09 real incident (two takes): the operator applied a Bear Trend preset via the
// dashboard's "Apply" button, but later RegimeAutopilot's own tick silently reverted the live
// allocation back to its own observed-regime preset. Take 1 fixed this by having
// setLaneAllocationsAsOperator set manualSelectorMode — but that field's real, still-current job is
// the UNRELATED "raw bypass" toggle (see its own doc comment), and toggling THAT for its own
// legitimate purpose silently released the guard again, reverting a live 80/8/8/4 allocation within
// minutes. Take 2 (this block): a dedicated laneAllocationOperatorLock field that only this path
// and applyRegimeAutopilotAllocation/maybeAutoResetLaneSelection ever touch.
describe("setLaneAllocationsAsOperator (2026-07-09 fix, take 2: dedicated lock, independent of the raw-bypass toggle)", () => {
  it("sets laneAllocationOperatorLock when applying a real allocation", () => {
    const { engine, store } = makeEngine();
    expect(store.getState().laneAllocationOperatorLock).toBe(false);
    const result = engine.setLaneAllocationsAsOperator([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 100 }]);
    expect(result.ok).toBe(true);
    expect(store.getState().laneAllocationOperatorLock).toBe(true);
    expect(engine.isLaneAllocationOperatorLocked()).toBe(true);
  });

  it("does NOT set laneAllocationOperatorLock when the allocation is invalid (nothing to protect)", () => {
    const { engine, store } = makeEngine();
    const result = engine.setLaneAllocationsAsOperator([{ laneId: "A", weightPct: 101 }]);
    expect(result.ok).toBe(false);
    expect(store.getState().laneAllocationOperatorLock).toBe(false);
  });

  it("does NOT touch laneAllocationOperatorLock when clearing (allocations: null)", () => {
    const { engine, store } = makeEngine();
    store.getState().laneAllocationOperatorLock = false;
    engine.setLaneAllocationsAsOperator(null);
    expect(store.getState().laneAllocationOperatorLock).toBe(false);
    store.getState().laneAllocationOperatorLock = true;
    engine.setLaneAllocationsAsOperator(null);
    expect(store.getState().laneAllocationOperatorLock).toBe(true); // unchanged, whichever it was
  });

  it("toggling the UNRELATED raw-bypass mode never touches the lane-allocation lock (the actual regression)", () => {
    const { engine, store } = makeEngine();
    engine.setLaneAllocationsAsOperator([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 100 }]);
    expect(engine.isLaneAllocationOperatorLocked()).toBe(true);
    // Operator flips the "Switch to MANUAL (bypass)" / "Switch to SMART" dashboard button, for its
    // own unrelated reason (book-overlay/direction-gate bypass) — must NOT release the lock.
    engine.setManualSelectorMode(true);
    expect(engine.isLaneAllocationOperatorLocked()).toBe(true);
    engine.setManualSelectorMode(false);
    expect(engine.isLaneAllocationOperatorLocked()).toBe(true);
  });

  it("[THE ACTUAL INCIDENT] once applied via the operator path, RegimeAutopilot's own apply refuses to overwrite it", () => {
    const { engine } = makeEngine();
    engine.setLaneAllocationsAsOperator([
      { laneId: "CG_WIDE_FAST_SHORT", weightPct: 35 },
      { laneId: "CG_MFE_GIVEBACK", weightPct: 15 },
      { laneId: "CROSS_SECTIONAL_TREND", weightPct: 20 },
      { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 30 },
    ]);
    // Simulates RegimeAutopilot's tick observing NO_TRADE and trying to apply its own preset —
    // this must now be REFUSED, preserving the operator's Bear Trend choice.
    const autopilotAttempt = engine.applyRegimeAutopilotAllocation([{ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 }]);
    expect(autopilotAttempt.ok).toBe(false);
    expect(engine.getStatus().laneSelection.laneAllocations).toEqual([
      { laneId: "CG_WIDE_FAST_SHORT", weightPct: 35 },
      { laneId: "CG_MFE_GIVEBACK", weightPct: 15 },
      { laneId: "CROSS_SECTIONAL_TREND", weightPct: 20 },
      { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 30 },
    ]);
  });
});

describe("lane selection auto-reset on losing operator close", () => {
  // Open an intent under a 100% allocation on its lane, then close it at a given net PnL.
  async function openSelectedIntent(pnl: number) {
    const order = paperOrder({ selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT" } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 100 }]);
    engine.setAllowedLanes(["CG_WIDE_FAST_SHORT"]); // allocations take precedence, but both should reset
    await engine.tick();
    const intent = store.getState().intents[0]!;
    expect(intent.operatorLaneSelection).toBe(true);
    // Position disappears from the exchange ⇒ settleClosedIntent books the realized PnL.
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { orderId: intent.entryOrderId!, realizedPnl: pnl, commission: 0 } as never,
    ];
    await engine.tick();
    return { engine, store };
  }

  it("a losing close (beyond the threshold) resets BOTH allocation and allow-list", async () => {
    const { engine, store } = await openSelectedIntent(-2.5);
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(store.getState().laneAllocations).toBeNull();
    expect(store.getState().allowedLaneIds).toBeNull();
    const sel = engine.getStatus().laneSelection;
    expect(sel.mode).toBe("ALL_LANES");
    expect(sel.lastAutoReset?.symbol).toBe("ETHUSDT");
    expect(sel.lastAutoReset?.pnlUsd).toBeCloseTo(-2.5, 6);
  });

  it("a PROFITABLE close leaves the selection persisted (server-side, survives relogin)", async () => {
    const { engine, store } = await openSelectedIntent(1.8);
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(store.getState().laneAllocations).toEqual([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 100 }]);
    expect(engine.getStatus().laneSelection.mode).toBe("WEIGHTED_ALLOCATION");
    expect(engine.getStatus().laneSelection.lastAutoReset).toBeNull();
  });

  it("a tiny scratch loss (fees-only, under the threshold) does NOT reset", async () => {
    const { engine, store } = await openSelectedIntent(-0.02);
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(store.getState().laneAllocations).toEqual([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 100 }]);
    expect(engine.getStatus().laneSelection.lastAutoReset).toBeNull();
  });

  it("a losing close of a NON-selected (bot-routed) position does not reset the selection", async () => {
    const order = paperOrder({ selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT" } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick(); // opened with NO selection active ⇒ not operator-tagged
    const intent = store.getState().intents[0]!;
    expect(intent.operatorLaneSelection).toBeUndefined();
    // Operator selects a lane AFTER the position opened, then the old position loses.
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]);
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [{ orderId: intent.entryOrderId!, realizedPnl: -3, commission: 0 } as never];
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(store.getState().laneAllocations).toEqual([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]);
  });

  it("the watermark prevents an old processed loss from re-triggering after re-selection", async () => {
    const { engine, store } = await openSelectedIntent(-2.5);
    expect(store.getState().laneAllocations).toBeNull(); // reset happened
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 100 }]); // operator re-selects
    await engine.tick(); // the old CLOSED loss is behind the watermark now
    expect(store.getState().laneAllocations).toEqual([{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 100 }]);
  });
});

describe("consecutive-loss ledger — scratch (fee-only) closes must not false-trip the kill-switch", () => {
  // Regression for 2026-07-04: live latched on "max consecutive losses hit (6)" where 3 of the 6
  // "losses" were -$0.017 breakeven-after-cost fee scratches. A near-breakeven auto close is neutral.
  function ledger(engine: LiveExecutionEngine) {
    return (engine as unknown as {
      applyRealizedToLedger: (net: number, c?: "auto" | "adverse") => void;
    }).applyRealizedToLedger.bind(engine);
  }

  it("a sub-epsilon auto close is a scratch: it neither increments nor resets the streak", () => {
    const { engine, store } = makeEngine({ config: { scratchEpsilonUsd: 0.1 } });
    const apply = ledger(engine);
    apply(-2); // real loss → streak 1
    apply(-2); // real loss → streak 2
    expect(store.getState().consecutiveLosses).toBe(2);
    apply(-0.017); // fee scratch → NEUTRAL, streak unchanged (must not reach 3)
    apply(-0.017);
    apply(-0.05);
    expect(store.getState().consecutiveLosses).toBe(2);
    expect(store.getState().dailyLedger.scratches).toBe(3);
    // a real loss after the scratches keeps counting from where the streak was
    apply(-2);
    expect(store.getState().consecutiveLosses).toBe(3);
  });

  it("a tiny positive scratch does NOT reset a real losing streak", () => {
    const { engine, store } = makeEngine({ config: { scratchEpsilonUsd: 0.1 } });
    const apply = ledger(engine);
    apply(-2);
    apply(-2);
    apply(0.02); // fee-only positive scratch → neutral, streak preserved
    expect(store.getState().consecutiveLosses).toBe(2);
    apply(0.5); // a real win DOES reset
    expect(store.getState().consecutiveLosses).toBe(0);
  });

  it("an ADVERSE flatten always counts as a loss regardless of magnitude (churn stays visible)", () => {
    const { engine, store } = makeEngine({ config: { scratchEpsilonUsd: 0.1 } });
    const apply = ledger(engine);
    apply(-0.01, "adverse"); // tiny but adverse → still a loss
    apply(0, "adverse"); // zero but adverse → still a loss
    expect(store.getState().consecutiveLosses).toBe(2);
    expect(store.getState().dailyLedger.scratches ?? 0).toBe(0);
  });

  it("replaying the 2026-07-04 trip streak no longer reaches 6", () => {
    const { engine, store } = makeEngine({ config: { scratchEpsilonUsd: 0.1, maxConsecutiveLosses: 6 } });
    const apply = ledger(engine);
    for (const net of [-0.017, -0.017, -0.017, -0.509, -1.42, -0.067]) apply(net);
    // only -0.509 and -1.42 are real losses; the rest are scratches
    expect(store.getState().consecutiveLosses).toBe(2);
    expect(store.getState().consecutiveLosses).toBeLessThan(6);
  });
});

describe("resetKill — a deliberate reset must give a genuine fresh start (not instantly re-trip)", () => {
  it("clears the latch AND resets the consecutive-loss streak + re-bases the drawdown peak", () => {
    const { engine, store } = makeEngine({ config: { maxConsecutiveLosses: 2, scratchEpsilonUsd: 0.1 } });
    const st = store.getState();
    st.consecutiveLosses = 6;
    st.killedAt = "2026-07-04T08:29:43.431Z";
    st.killReason = "max consecutive losses hit (6)";
    st.realizedPeakUsd = 20;
    st.totalRealizedPnlUsd = -5;
    store.save();

    engine.resetKill();

    const after = store.getState();
    expect(after.killedAt).toBeNull();
    expect(after.killReason).toBeNull();
    expect(after.consecutiveLosses).toBe(0);
    expect(after.realizedPeakUsd).toBe(-5); // drawdown-from-peak re-based to 0

    // The core guarantee: killSwitchTrip() must NOT immediately re-fire after a reset.
    const trip = (engine as unknown as { killSwitchTrip: () => string | null }).killSwitchTrip();
    expect(trip).toBeNull();
  });
});

describe("account-wide consecutive-loss kill-switch fed by a SingleSymbolLaneExecutor (2026-07-19 real-money audit fix)", () => {
  // Regression for the audit finding: consecutiveLosses was ONLY ever incremented by this engine's
  // own applyRealizedToLedger, itself fed exclusively by the legacy CG_*-variant-matrix mirror
  // pipeline (retired, 0% allocation weight today). The 3 lanes holding 100% of today's real money
  // (REGIME_COMPOSITE_CONFIRMATION_LONG, COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG/FAST_LONG) are all
  // SingleSymbolLaneExecutor instances, which never called into that pipeline — so a real losing
  // streak concentrated entirely in one of them could never trip this specific kill-switch
  // condition. Proves recordExternalConsecutiveLossOutcome() + SingleSymbolLaneExecutor's
  // onPositionClosed callback close that gap end to end: real losing closes from an ACTUAL
  // SingleSymbolLaneExecutor instance (not the legacy mirror) increment the SAME counter
  // killSwitchTrip() reads and eventually trip it, and a subsequent win resets it — exactly
  // matching applyRealizedToLedger's own scratch/loss/win semantics.
  //
  // FAIL-WITHOUT-FIX: before this fix, SingleSymbolLaneExecutor had no onPositionClosed option at
  // all and LiveExecutionEngine had no recordExternalConsecutiveLossOutcome method — this test
  // could not even be written against pre-fix code, let alone pass; it errors at construction time
  // ("onPositionClosed" is not an assignable option / recordExternalConsecutiveLossOutcome is not a
  // function). Confirmed by reverting this change locally and re-running the file.

  const SSLE_NOW_ISO = "2026-07-19T12:00:00.000Z";
  const SSLE_NOW_MS = new Date(SSLE_NOW_ISO).getTime();

  function makeSingleSymbolExecutor(
    client: FakeLiveClient,
    engine: LiveExecutionEngine,
    signals: SingleSymbolFreshSignal[],
  ) {
    const executorStore = new SingleSymbolLaneExecutorStore(tmp(), "test.json");
    const executor = new SingleSymbolLaneExecutor({
      client: client as unknown as SingleSymbolExecClient,
      store: executorStore,
      laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG",
      direction: "LONG",
      getOpenSignals: () => signals,
      exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
      isAllowed: () => true,
      laneWeightPct: () => 100,
      legUsd: () => 200,
      leverage: () => 3,
      maxOpenPositions: () => 1,
      nowIso: () => SSLE_NOW_ISO,
      fillConfirmRetryDelayMs: 0,
      // The exact wiring app.ts uses for all 9 single-symbol lane instances.
      onPositionClosed: (netUsd) => engine.recordExternalConsecutiveLossOutcome(netUsd),
    });
    return { executor, executorStore };
  }

  /** Opens ONE fresh position on this executor and closes it via the operator manual-close path,
   *  banking EXACTLY `realizedPnlUsd` (zero fees) as its confirmed net P&L via FakeLiveClient's
   *  flattenRealizedPnl — same controlled-close convention single-symbol-lane-executor.test.ts uses.
   *  `ageMs` keeps each signal fresh (well under the executor's default 50-minute max-signal-age)
   *  while still giving it a distinct openedAtMs, so consecutive calls don't collide. */
  async function openAndClosePosition(
    executor: SingleSymbolLaneExecutor,
    executorStore: SingleSymbolLaneExecutorStore,
    client: FakeLiveClient,
    signals: SingleSymbolFreshSignal[],
    observationId: string,
    ageMs: number,
    realizedPnlUsd: number,
  ): Promise<void> {
    signals.push({ observationId, symbol: "ETHUSDT", entryPrice: 2000, stopPrice: 1900, openedAtMs: SSLE_NOW_MS - ageMs });
    await executor.tick(); // opens the position (FakeLiveClient fills entries at marketFillPrice ?? 2000)
    const pos = executorStore.getState().positions.find((p) => p.status === "OPEN");
    expect(pos).toBeDefined();
    client.flattenRealizedPnl = realizedPnlUsd;
    const result = await executor.manualClosePosition(pos!.positionId);
    expect(result.ok).toBe(true);
    expect(result.netPnlUsd).toBeCloseTo(realizedPnlUsd, 6);
  }

  it("a losing streak from a single-symbol lane increments and TRIPS the SAME counter killSwitchTrip() reads", async () => {
    const { engine, store, client } = makeEngine({ config: { scratchEpsilonUsd: 0.1, maxConsecutiveLosses: 2 } });
    const signals: SingleSymbolFreshSignal[] = [];
    const { executor, executorStore } = makeSingleSymbolExecutor(client, engine, signals);
    const trip = () => (engine as unknown as { killSwitchTrip: () => string | null }).killSwitchTrip();

    await openAndClosePosition(executor, executorStore, client, signals, "rc:ETHUSDT:1", 5_000, -2);
    expect(store.getState().consecutiveLosses).toBe(1);
    expect(trip()).toBeNull(); // only 1 loss so far — must not trip early

    await openAndClosePosition(executor, executorStore, client, signals, "rc:ETHUSDT:2", 4_000, -2);
    expect(store.getState().consecutiveLosses).toBe(2);
    expect(trip()).toBe("max consecutive losses hit (2 within 24h of each other)");
  });

  it("a subsequent win from the SAME single-symbol lane resets the streak back to 0", async () => {
    const { engine, store, client } = makeEngine({ config: { scratchEpsilonUsd: 0.1, maxConsecutiveLosses: 5 } });
    const signals: SingleSymbolFreshSignal[] = [];
    const { executor, executorStore } = makeSingleSymbolExecutor(client, engine, signals);

    await openAndClosePosition(executor, executorStore, client, signals, "rc:ETHUSDT:1", 5_000, -2);
    await openAndClosePosition(executor, executorStore, client, signals, "rc:ETHUSDT:2", 4_000, -2);
    expect(store.getState().consecutiveLosses).toBe(2);

    await openAndClosePosition(executor, executorStore, client, signals, "rc:ETHUSDT:3", 3_000, 1.5);
    expect(store.getState().consecutiveLosses).toBe(0);
  });

  it("a sub-epsilon scratch close from a single-symbol lane is neutral — neither increments nor resets", async () => {
    const { engine, store, client } = makeEngine({ config: { scratchEpsilonUsd: 0.1, maxConsecutiveLosses: 5 } });
    const signals: SingleSymbolFreshSignal[] = [];
    const { executor, executorStore } = makeSingleSymbolExecutor(client, engine, signals);

    await openAndClosePosition(executor, executorStore, client, signals, "rc:ETHUSDT:1", 5_000, -2);
    expect(store.getState().consecutiveLosses).toBe(1);

    await openAndClosePosition(executor, executorStore, client, signals, "rc:ETHUSDT:2", 4_000, -0.017);
    expect(store.getState().consecutiveLosses).toBe(1); // scratch — unchanged, must not reach 2
  });
});

describe("consecutive-loss TIME-WINDOW bound (2026-07-19 real-money audit follow-up)", () => {
  // Regression for the adversarial-review finding on top of 8792bd0 ("wire single-symbol lane
  // closes into the consecutive-loss kill-switch"): once ALL 9 SingleSymbolLaneExecutor instances
  // fed consecutiveLosses (not just the dead legacy pipeline), the counter was fed continuously by
  // real money — but it was UNBOUNDED IN TIME, so a loss 3 days ago and an unrelated loss today
  // (from independently-ticking lanes) could chain into the SAME "streak" and force-flatten every
  // open real-money position for ordinary multi-day trading variance, not a genuine correlated
  // failure. noteConsecutiveLoss() now only chains a new loss onto the existing streak if it lands
  // within config.consecutiveLossWindowHours of the last COUNTED loss; otherwise it starts fresh at 1.
  //
  // FAIL-WITHOUT-FIX: before this change, applyRealizedToLedger/recordExternalConsecutiveLossOutcome
  // did a bare `st.consecutiveLosses += 1` with no time dimension at all — test (a) below asserts
  // consecutiveLosses stays at 1 after 5 widely-spaced losses; pre-fix code has no `lastLossAtMs`
  // field to reset and would have incremented every single time regardless of gap, landing at 5 and
  // tripping the breaker. Confirmed by reverting the noteConsecutiveLoss changes locally and
  // re-running this file: (a) fails (consecutiveLosses reads 5, trip() returns non-null) and (d)
  // fails identically through the production recordExternalConsecutiveLossOutcome() path.

  function ledger(engine: LiveExecutionEngine) {
    return (engine as unknown as {
      applyRealizedToLedger: (net: number, c?: "auto" | "adverse") => void;
    }).applyRealizedToLedger.bind(engine);
  }

  function trip(engine: LiveExecutionEngine) {
    return (engine as unknown as { killSwitchTrip: () => string | null }).killSwitchTrip.bind(engine);
  }

  const START = "2099-01-02T00:00:00.000Z";

  it("(a) CORE FIX: losses spread out with gaps LARGER than the window do NOT chain and do NOT trip", () => {
    let now = START;
    const { engine, store } = makeEngine({
      nowIso: () => now,
      config: { scratchEpsilonUsd: 0.1, maxConsecutiveLosses: 5, consecutiveLossWindowHours: 24 },
    });
    const apply = ledger(engine);
    const tripFn = trip(engine);

    // 5 real losses, each 30h apart — wider than the 24h window every time (mirrors the reported
    // "one 3 days ago, one today, across independently-ticking lanes" false-trip scenario).
    for (let i = 0; i < 5; i++) {
      apply(-2);
      now = new Date(Date.parse(now) + 30 * 3_600_000).toISOString();
    }

    // Every loss landed outside the window of the previous one, so the streak restarts each time —
    // it must NEVER have accumulated past 1, and the account-wide kill-switch must never trip.
    expect(store.getState().consecutiveLosses).toBe(1);
    expect(tripFn()).toBeNull();
  });

  it("(b) NO REGRESSION: losses within the window still chain into a trip exactly as before", () => {
    let now = START;
    const { engine, store } = makeEngine({
      nowIso: () => now,
      config: { scratchEpsilonUsd: 0.1, maxConsecutiveLosses: 5, consecutiveLossWindowHours: 24 },
    });
    const apply = ledger(engine);
    const tripFn = trip(engine);

    // 5 real losses, each only 2h apart — a genuine tight cluster (the correlated-failure
    // signature this breaker exists to catch), well inside the 24h window every time.
    for (let i = 0; i < 5; i++) {
      apply(-2);
      now = new Date(Date.parse(now) + 2 * 3_600_000).toISOString();
    }

    expect(store.getState().consecutiveLosses).toBe(5);
    expect(tripFn()).toBe("max consecutive losses hit (5 within 24h of each other)");
  });

  it("(c) a win still resets BOTH the counter and the last-loss timestamp", () => {
    let now = START;
    const { engine, store } = makeEngine({
      nowIso: () => now,
      config: { scratchEpsilonUsd: 0.1, consecutiveLossWindowHours: 24 },
    });
    const apply = ledger(engine);

    apply(-2);
    apply(-2);
    expect(store.getState().consecutiveLosses).toBe(2);
    expect(store.getState().lastLossAtMs).not.toBeNull();

    apply(1.5); // a real win
    expect(store.getState().consecutiveLosses).toBe(0);
    expect(store.getState().lastLossAtMs).toBeNull();
  });

  it("(d) the production SingleSymbolLaneExecutor path (recordExternalConsecutiveLossOutcome) also respects the window", () => {
    let now = START;
    const { engine, store } = makeEngine({
      nowIso: () => now,
      config: { scratchEpsilonUsd: 0.1, maxConsecutiveLosses: 2, consecutiveLossWindowHours: 24 },
    });
    const tripFn = trip(engine);

    engine.recordExternalConsecutiveLossOutcome(-2); // e.g. RC lane loses, 3 days ago
    now = new Date(Date.parse(now) + 72 * 3_600_000).toISOString(); // 3 days later
    engine.recordExternalConsecutiveLossOutcome(-2); // e.g. CE-FAST_LONG lane loses today

    // Must NOT chain into a 2-loss streak just because both came from real-money lanes — they're
    // 3 days apart, far outside the 24h window.
    expect(store.getState().consecutiveLosses).toBe(1);
    expect(tripFn()).toBeNull();
  });

  it("windowed losses that stay inside each successive gap can still chain past the window's own width", () => {
    // Deliberately verifies this is a ROLLING gap-since-last-loss window, not a fixed calendar
    // bucket: 4 losses each 20h apart span 60h total (> the 24h window width) but every individual
    // gap is inside the window, so the streak must still chain all the way to 4.
    let now = START;
    const { engine, store } = makeEngine({
      nowIso: () => now,
      config: { scratchEpsilonUsd: 0.1, maxConsecutiveLosses: 10, consecutiveLossWindowHours: 24 },
    });
    const apply = ledger(engine);
    for (let i = 0; i < 4; i++) {
      apply(-2);
      now = new Date(Date.parse(now) + 20 * 3_600_000).toISOString();
    }
    expect(store.getState().consecutiveLosses).toBe(4);
  });
});

describe("per-correlation-cluster concentration cap", () => {
  it("counts open non-major positions per cluster × direction, excluding BTC/ETH (majors)", () => {
    const { engine, store } = makeEngine({ config: { maxClusterPositions: 3 } });
    const st = store.getState();
    st.intents = [
      { symbol: "SOLUSDT", direction: "SHORT", state: "OPEN" },
      { symbol: "SUIUSDT", direction: "SHORT", state: "OPEN" },
      { symbol: "SEIUSDT", direction: "SHORT", state: "OPEN" }, // 3 L1 shorts
      { symbol: "DOGEUSDT", direction: "SHORT", state: "OPEN" }, // MEME short — different cluster
      { symbol: "SOLUSDT", direction: "LONG", state: "OPEN" }, // L1 long — different direction
      { symbol: "BTCUSDT", direction: "SHORT", state: "OPEN" }, // major — excluded from cluster cap
      { symbol: "SUIUSDT", direction: "SHORT", state: "PAPER_SUBMITTED" }, // not an OPEN intent state — ignored
    ] as never;
    const counts = (engine as unknown as {
      clusterOpenCounts: (i: unknown[]) => Map<string, Set<string>>;
    }).clusterOpenCounts(st.intents);
    expect(counts.get("L1:SHORT")?.size).toBe(3); // the 3 L1 shorts share one cluster cap
    expect(counts.get("MEME:SHORT")?.size).toBe(1); // meme has its own slots
    expect(counts.get("L1:LONG")?.size).toBe(1); // opposite direction is separate
    expect([...counts.keys()].some((k) => k.startsWith("MAJORS"))).toBe(false); // BTC not counted
  });
});

describe("Phase-2 exit rebuild: forced MFE-giveback + losing-max-hold cut", () => {
  it("forceMfeGiveback banks a faded runner on ANY lane (not just mfe_giveback lanes)", async () => {
    const order = paperOrder(); // scaleout_tp1_trail lane — would NOT giveback without the force flag
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { forceMfeGiveback: true },
    });
    await engine.arm();
    await engine.tick(); // opens the short at 2000, stop 2100 (risk 100)

    client.markPriceBySymbol.set("ETHUSDT", 1900); // +1R favorable → peak arms (≥0.75R)
    await engine.tick();
    expect(store.getState().intents[0]!.maxFavorableR).toBeCloseTo(1, 6);
    expect(store.getState().intents[0]!.state).toBe("OPEN"); // still above the giveback line

    client.markPriceBySymbol.set("ETHUSDT", 1960); // favorable 0.4 ≤ peak×(1−0.5)=0.5 → bank it
    await engine.tick();
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("MFE_GIVEBACK_EXIT");
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
  });

  it("without the force flag a scaleout-lane runner is NOT givebacked (old behavior preserved)", async () => {
    const order = paperOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick();
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    await engine.tick();
    client.markPriceBySymbol.set("ETHUSDT", 1960);
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN");
  });

  it("profit-core keeps its explicit TP1 scaleout+trail geometry even when global forceMfeGiveback is on", async () => {
    const order = paperOrder({ selectedLaneId: "PROFIT_CORE_SHORT_TRAIL" } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { forceMfeGiveback: true },
    });
    await engine.arm();
    await engine.tick();
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    await engine.tick();
    client.markPriceBySymbol.set("ETHUSDT", 1960);
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(store.getState().intents[0]!.closeReason).toBeNull();
  });

  it("cuts a position that has been LOSING longer than losingMaxHoldMs", async () => {
    let now = "2099-01-02T12:00:00.000Z";
    const order = paperOrder();
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([order]),
      config: { losingMaxHoldMs: 4 * 3_600_000 },
      nowIso: () => now,
    });
    await engine.arm();
    await engine.tick(); // opens the short

    client.markPriceBySymbol.set("ETHUSDT", 2050); // favorable −0.5R (losing)
    now = "2099-01-02T17:00:00.000Z"; // 5h later > 4h
    await engine.tick();
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("LOSING_MAX_HOLD_CUT_4H");
  });

  it("never cuts a WINNER on hold time, and never cuts a young loser", async () => {
    let now = "2099-01-02T12:00:00.000Z";
    const winner = paperOrder({ paperOrderId: "paper-winner", symbol: "ETHUSDT" } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([winner]),
      config: { losingMaxHoldMs: 4 * 3_600_000 },
      nowIso: () => now,
    });
    await engine.arm();
    await engine.tick();

    // old but WINNING → untouched
    client.markPriceBySymbol.set("ETHUSDT", 1950); // +0.5R favorable
    now = "2099-01-02T20:00:00.000Z"; // 8h later
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN");

    // turns loser but check the YOUNG-loser guard on a fresh engine
    let now2 = "2099-01-02T12:00:00.000Z";
    const young = paperOrder({ paperOrderId: "paper-young", symbol: "ETHUSDT" } as Partial<PaperOrder>);
    const second = makeEngine({
      paper: makePaperStore([young]),
      config: { losingMaxHoldMs: 4 * 3_600_000 },
      nowIso: () => now2,
    });
    await second.engine.arm();
    await second.engine.tick();
    second.client.markPriceBySymbol.set("ETHUSDT", 2050); // losing
    now2 = "2099-01-02T13:00:00.000Z"; // only 1h < 4h
    await second.engine.tick();
    expect(second.store.getState().intents[0]!.state).toBe("OPEN");
  });
});

// 2026-07-07 REAL-MONEY incidents on live: (a) PROFIT_BANK_NET_1.00 fired off the NETTED position's
// unrealized (basket leg's profit counted for the intent) and its close bought back the basket's
// 337 DOGE hedge; (b) the add-failed emergency flatten bought back the whole netted WLD position,
// eating the basket's 64 hedge. Every lifecycle/panic close must act on the ENGINE SHARE only.
describe("netted-position closes act on the ENGINE SHARE only (never the basket's hedge)", () => {
  const EXT = 0.05; // basket's short leg on the same symbol (external managed claim)

  async function openNettedShort(cfg: Partial<LiveExecutionConfig> = {}) {
    const client = new FakeLiveClient();
    const made = makeEngine({
      client,
      paper: makePaperStore([paperOrder()]),
      config: cfg,
      externalManagedNetQty: () => new Map([["ETHUSDT", -EXT]]),
    });
    await made.engine.arm();
    await made.engine.tick(); // opens the engine's own short
    const intent = made.store.getState().intents[0]!;
    // Basket leg lands on the same symbol → ONE netted exchange position.
    client.positionsBySymbol.set("ETHUSDT", -(intent.qty + EXT));
    return { ...made, client, intent };
  }

  it("[NETTED-PROFIT-BANK] does NOT fire when only the share-scaled unrealized is below target", async () => {
    const { engine, client, store } = await openNettedShort({ profitBankNetTargetUsd: 1 });
    // Own-entry basis: short from 2000, mark 1990 → intent's own unrealized ≈ 0.5 < $1 — must stay
    // OPEN no matter what the NETTED exchange P&L (which includes the basket's leg) says.
    client.markPriceBySymbol.set("ETHUSDT", 1990);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 5); // netted number is big — must be IGNORED
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(client.placed.filter((p) => p.reduceOnly && p.type === "MARKET").length).toBe(0);
  });

  it("[NETTED-PROFIT-BANK] a genuine trigger closes ONLY the engine share, not the basket's qty", async () => {
    const { engine, client, store } = await openNettedShort({ profitBankNetTargetUsd: 1 });
    const q = store.getState().intents[0]!.qty;
    client.markPriceBySymbol.set("ETHUSDT", 1900); // own-entry unrealized = 100×q ≈ $5 ≥ $1
    await engine.tick();
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("PROFIT_BANK_NET_1.00");
    const flat = client.placed.find((p) => p.reduceOnly && p.type === "MARKET")!;
    expect(flat.quantity).toBeCloseTo(q, 9); // NOT q + EXT
  });

  it("[NETTED-EMERGENCY-FLATTEN] a failed open flattens the engine share only", async () => {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", -EXT); // basket leg already open on the symbol
    client.algoErrorCode = -9999; // stop placement fails → EMERGENCY_FLATTEN_NO_STOP path
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore([paperOrder()]),
      externalManagedNetQty: () => new Map([["ETHUSDT", -EXT]]),
    });
    await engine.arm();
    await engine.tick().catch(() => undefined); // RETRY_FATAL rethrow after the flatten is fine
    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("ERROR");
    const flat = client.placed.find((p) => p.reduceOnly && p.type === "MARKET")!;
    expect(flat).toBeTruthy();
    expect(flat.quantity).toBeCloseTo(intent.qty, 9); // the basket's EXT stays on the exchange
  });

  it("[NETTED-KILL] kill-switch flatten never takes the basket's leg with it", async () => {
    const { engine, client, store } = await openNettedShort();
    const q = store.getState().intents[0]!.qty;
    await engine.kill("test breaker");
    const killed = store.getState().intents[0]!;
    expect(killed.state).toBe("KILLED");
    const flat = client.placed.find((p) => p.reduceOnly && p.type === "MARKET" && p.newClientOrderId?.startsWith("dtc-kill"))!;
    expect(flat.quantity).toBeCloseTo(q, 9);
  });

  // [KILL-RESPONSE, 2026-07-12 fix]: the kill-switch TRIGGER became portfolio-wide on 2026-07-11
  // (sums all 11 executors' P&L) but the RESPONSE only flattened the engine's own intents — the
  // other 11 executors kept trading. The onKillSwitchEngaged callback closes them via their OWN
  // orderly close mechanics (never blanket symbol flattens).
  it("[KILL-RESPONSE] engageKillSwitch invokes onKillSwitchEngaged after flattening its own intents", async () => {
    const calls: string[] = [];
    const client = new FakeLiveClient();
    const { engine } = makeEngine({
      client,
      onKillSwitchEngaged: async (reason) => {
        calls.push(reason);
      },
    });
    await engine.arm();
    await engine.kill("portfolio breaker test");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("portfolio breaker test");
    expect(engine.getStatus().killedAt).not.toBeNull();
  });

  it("[KILL-RESPONSE] a throwing onKillSwitchEngaged never breaks the engine's own kill path", async () => {
    const client = new FakeLiveClient();
    const { engine } = makeEngine({
      client,
      onKillSwitchEngaged: async () => {
        throw new Error("executor close blew up");
      },
    });
    await engine.arm();
    await engine.kill("breaker with failing callback");
    const status = engine.getStatus();
    expect(status.killedAt).not.toBeNull(); // kill still latched
    expect(status.reconcileIssues.some((issue: string) => issue.includes("kill-switch executor-close callback failed"))).toBe(true);
  });

  it("[NETTED-FLAT-SETTLE] settles an intent whose engine share is gone even though the basket still holds the symbol", async () => {
    const { engine, client, store } = await openNettedShort();
    // Intent's own exposure was stopped out; only the basket's leg remains in the netted position.
    client.positionsBySymbol.set("ETHUSDT", -EXT);
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
  });

  it("[NETTED-ENTRY-GUARD] never opens an intent whose direction OPPOSES a basket claim on the symbol", async () => {
    // 2026-07-08 real-money incident: a SHORT SUI "entry" on a basket-long symbol just SOLD the
    // baskets' longs; its reduce-only exits -2022-rejected and reconcile disarm-looped.
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore([paperOrder()]), // SHORT ETHUSDT
      externalManagedNetQty: () => new Map([["ETHUSDT", 0.05]]), // baskets are LONG the symbol
    });
    await engine.arm();
    await engine.tick();
    expect(store.getState().intents).toHaveLength(0);
    expect(client.placed.filter((p) => p.type === "MARKET").length).toBe(0);
  });

  it("[NETTED-ENTRY-GUARD] a SAME-direction basket claim does not block the open (netting adds)", async () => {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", -EXT); // basket short already on the exchange
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore([paperOrder()]), // SHORT ETHUSDT
      externalManagedNetQty: () => new Map([["ETHUSDT", -EXT]]),
    });
    await engine.arm();
    await engine.tick();
    expect(store.getState().intents).toHaveLength(1);
    expect(store.getState().intents[0]!.state).toBe("OPEN");
  });

  it("[MISSING-QTY-ALERT] reconcile reports (without disarming) when managed exposure was consumed", async () => {
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore([paperOrder({ variantExitRule: "tp1_full" } as Partial<PaperOrder>)]),
    });
    await engine.arm();
    await engine.tick();
    const q = store.getState().intents[0]!.qty;
    client.positionsBySymbol.set("ETHUSDT", -q * 0.3); // most of the engine's qty vanished
    await engine.tick();
    expect(engine.getStatus().reconcileIssues.join(" ")).toMatch(/MISSING QTY/);
    expect(engine.isArmed()).toBe(true); // report-only — a disarm here could loop on transients
  });
});

describe("manual selector mode toggle", () => {
  it("defaults OFF, toggles on/off, persists in state, and surfaces in status", () => {
    const { engine, store } = makeEngine();
    expect(engine.isManualSelectorMode()).toBe(false);
    expect(engine.getStatus().laneSelection.manualSelectorMode).toBe(false);

    const on = engine.setManualSelectorMode(true);
    expect(on).toEqual({ ok: true, manualSelectorMode: true });
    expect(engine.isManualSelectorMode()).toBe(true);
    expect(store.getState().manualSelectorMode).toBe(true);
    expect(engine.getStatus().laneSelection.manualSelectorMode).toBe(true);

    engine.setManualSelectorMode(false);
    expect(engine.isManualSelectorMode()).toBe(false);
  });

  it("uses only the Entry Decision side's directional allocation and holds safely with no decision", () => {
    const { engine } = makeEngine();
    expect(engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 70 }],
      short: [{ laneId: "CG_WIDE_FAST_SHORT", weightPct: 80 }],
    }).ok).toBe(true);
    engine.setManualSelectorMode(true);

    // Manual mode must fail closed until the scanner produces a fresh directional decision.
    expect(engine.laneSelectionAllowsLane("CG_WIDE_FAST_LONG")).toBe(false);
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(0);

    engine.setManualEntryDecision({
      action: "WAIT_PULLBACK",
      directionalBias: "LONG",
      reason: "test",
      observedAt: "2099-01-02T12:00:00.000Z",
    });
    expect(engine.getStatus().laneSelection.mode).toBe("MANUAL_DIRECTIONAL");
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(70);
    expect(engine.laneSelectionAllowsLane("CG_WIDE_FAST_SHORT")).toBe(false);
    expect(engine.isManualEntryAllowedForPaper({ selectedLaneId: "CG_WIDE_FAST_LONG", direction: "LONG" } as PaperOrder)).toBe(true);
    expect(engine.isManualEntryAllowedForPaper({ selectedLaneId: "CG_WIDE_FAST_SHORT", direction: "SHORT" } as PaperOrder)).toBe(false);

    engine.setManualEntryDecision({
      action: "WAIT_REJECTION",
      directionalBias: "SHORT",
      reason: "test",
      observedAt: "2099-01-02T12:05:00.000Z",
    });
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_SHORT")).toBe(80);
    expect(engine.laneSelectionAllowsLane("CG_WIDE_FAST_LONG")).toBe(false);
  });
});

describe("canOpenNewEntriesIgnoringManualDirectional (2026-07-20 real-money audit fix: the " +
  "market-neutral basket has no single-symbol directional bias and must not be coupled to the " +
  "operator's manual-directional LONG/SHORT gate)", () => {
  it("fails-without: canOpenNewEntries() blocks admission while manual mode holds no fresh " +
    "directional decision — the routine idle state that exposed the bug", async () => {
    const { engine } = makeEngine();
    expect((await engine.arm()).ok).toBe(true);
    engine.setManualSelectorMode(true);
    // Operator never listed the market-neutral lane here — reasonable, since it's marketed as
    // allocation-independent — leaving only an unrelated single-symbol LONG lane.
    expect(engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }],
      short: [],
    }).ok).toBe(true);
    // No setManualEntryDecision() call: the scanner's directional read is NO_TRADE, same as it is
    // whenever single-symbol lanes are routinely idle.
    expect(engine.canOpenNewEntries()).toBe(false);
  });

  it("pass-with: canOpenNewEntriesIgnoringManualDirectional() stays open in that exact state", async () => {
    const { engine } = makeEngine();
    expect((await engine.arm()).ok).toBe(true);
    engine.setManualSelectorMode(true);
    expect(engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }],
      short: [],
    }).ok).toBe(true);
    expect(engine.canOpenNewEntries()).toBe(false); // sanity: the directional gate is indeed blocking
    expect(engine.canOpenNewEntriesIgnoringManualDirectional()).toBe(true); // basket unaffected by it
  });

  it("still requires armed and respects the kill-switch/drain breakers (unchanged from canOpenNewEntries)", async () => {
    const { engine } = makeEngine();
    expect(engine.canOpenNewEntriesIgnoringManualDirectional()).toBe(false); // not armed yet
    expect((await engine.arm()).ok).toBe(true);
    expect(engine.canOpenNewEntriesIgnoringManualDirectional()).toBe(true);
    engine.setNewEntriesPaused(true);
    expect(engine.canOpenNewEntriesIgnoringManualDirectional()).toBe(false); // operator drain
    engine.setNewEntriesPaused(false);
    expect(engine.canOpenNewEntriesIgnoringManualDirectional()).toBe(true);
  });
});

describe("symbolPriorityTier (live-mirror candidate priority — no obstruction, only reordering)", () => {
  const LANE_ID = "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT";
  const OTHER_LANE_ID = "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG";
  const GENERATED_AT = "2099-01-02T11:00:00.000Z";
  const NOW_MS = new Date("2099-01-02T12:00:00.000Z").getTime();

  function makeReport(overrides: Partial<PerSymbolLaneBookEdgeReport> = {}): PerSymbolLaneBookEdgeReport {
    return {
      minClosed: 40,
      minHeadlineClosed: 20,
      posMinAvgR: 0.03,
      negMaxAvgR: -0.03,
      cells: [
        {
          laneId: LANE_ID,
          symbol: "LINKUSDT",
          direction: "SHORT",
          bucket: "ALT",
          closed: 100,
          headlineClosed: 0,
          netAvgR: 0.2,
          pf: 2,
          wr: 0.8,
          totalR: 20,
          headlineNetAvgR: null,
          headlinePf: null,
          executable: true,
          suspiciousFill: false,
          verdict: "BOOK_POSITIVE",
          confirmation: "DIAGNOSTIC_ONLY",
          promotable: false,
          testnetCandidate: true, // qualifies for "testnet" tier curation on LANE_ID
        },
      ],
      bestLanePerSymbol: [
        // SUIUSDT: no cell on LANE_ID itself, but SOME lane has proven edge (fallback tier 1).
        {
          symbol: "SUIUSDT",
          direction: "SHORT",
          bucket: "ALT",
          bestLaneId: OTHER_LANE_ID,
          bestNetAvgR: 0.1,
          bestClosed: 50,
          stage: "TESTNET_CANDIDATE",
          positiveLaneCount: 1,
          measuredLaneCount: 1,
        },
      ],
      summary: {
        measuredCells: 1,
        bookPositiveCells: 1,
        promotableCells: 0,
        testnetCandidateCells: 1,
        byDirection: {
          LONG: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 },
          SHORT: { measured: 1, bookPositive: 1, testnetCandidate: 1, promotable: 0 },
          MIXED: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 },
        },
        symbolsMeasured: 1,
        symbolsTestnetCandidate: 1,
        symbolsPromotable: 0,
      },
      ...overrides,
    };
  }

  it("tier 0: symbol is in the exact lane's curated whitelist at the deployment tier", () => {
    const report = makeReport();
    const tier = symbolPriorityTier("LINKUSDT", "SHORT", LANE_ID, report, GENERATED_AT, "testnet", NOW_MS);
    expect(tier).toBe(0);
  });

  it("tier 1: not in this lane's whitelist, but bestLanePerSymbol has a proven stage for this symbol+direction", () => {
    const report = makeReport();
    // SUIUSDT has no cell for LANE_ID, so tier-0 curation misses it; falls back to tier 1 via bestLanePerSymbol.
    const tier = symbolPriorityTier("SUIUSDT", "SHORT", LANE_ID, report, GENERATED_AT, "testnet", NOW_MS);
    expect(tier).toBe(1);
  });

  it("tier 1 fallback ignores deployment tier (looser bar than tier 0, applies regardless of testnet/live)", () => {
    const report = makeReport();
    const tier = symbolPriorityTier("SUIUSDT", "SHORT", LANE_ID, report, GENERATED_AT, "live", NOW_MS);
    expect(tier).toBe(1);
  });

  it("tier 2: symbol absent from both lookups falls back to no-obstruction (still admitted, just last)", () => {
    const report = makeReport();
    const tier = symbolPriorityTier("DOGEUSDT", "SHORT", LANE_ID, report, GENERATED_AT, "testnet", NOW_MS);
    expect(tier).toBe(2);
  });

  it("tier 2: report missing entirely (no curation data) still resolves, never throws", () => {
    const tier = symbolPriorityTier("LINKUSDT", "SHORT", LANE_ID, null, null, "testnet", NOW_MS);
    expect(tier).toBe(2);
  });

  it("tier 2: report present but stale (past max staleness) falls back for tier-0, tier-1 (bestLanePerSymbol) still applies", () => {
    const report = makeReport();
    const staleGeneratedAt = "2099-01-01T00:00:00.000Z"; // >2h before NOW_MS
    // Tier-0 curation is staleness-gated and fails → LINKUSDT (only has a tier-0 cell) drops to tier 2.
    expect(symbolPriorityTier("LINKUSDT", "SHORT", LANE_ID, report, staleGeneratedAt, "testnet", NOW_MS)).toBe(2);
    // Tier-1 fallback (bestLanePerSymbol) is NOT staleness-gated by getCuratedSymbolsForLane, so SUIUSDT
    // still resolves to tier 1 even with a "stale" reportGeneratedAt for the tier-0 lookup.
    expect(symbolPriorityTier("SUIUSDT", "SHORT", LANE_ID, report, staleGeneratedAt, "testnet", NOW_MS)).toBe(1);
  });

  it("tier 2: deployment tier is null (curation not opted in) never grants tier 0", () => {
    const report = makeReport();
    const tier = symbolPriorityTier("LINKUSDT", "SHORT", LANE_ID, report, GENERATED_AT, null, NOW_MS);
    // No tier-0 possible without a configured tier, but tier-1 fallback still works if bestLanePerSymbol matches.
    expect(tier).toBe(2); // LINKUSDT has no bestLanePerSymbol entry in this fixture
  });

  it("no-obstruction property: every tier is a valid admission priority (0, 1, or 2) — never a rejection sentinel", () => {
    const report = makeReport();
    for (const [symbol, direction] of [
      ["LINKUSDT", "SHORT"] as const,
      ["SUIUSDT", "SHORT"] as const,
      ["RANDOMCOIN", "SHORT"] as const,
      ["RANDOMCOIN", "LONG"] as const,
    ]) {
      const tier = symbolPriorityTier(symbol, direction, LANE_ID, report, GENERATED_AT, "testnet", NOW_MS);
      expect([0, 1, 2]).toContain(tier);
    }
  });

  it("mirrorNewSignals sort: within a tier, createdAt ascending is preserved as the tiebreaker", async () => {
    // Simulate the same sort comparator used in mirrorNewSignals: tier primary, createdAt secondary.
    const report = makeReport();
    const candidates = [
      { symbol: "DOGEUSDT", direction: "SHORT" as const, createdAt: "2099-01-02T10:00:00.000Z" }, // tier 2
      { symbol: "LINKUSDT", direction: "SHORT" as const, createdAt: "2099-01-02T09:00:00.000Z" }, // tier 0, earlier
      { symbol: "SUIUSDT", direction: "SHORT" as const, createdAt: "2099-01-02T08:30:00.000Z" }, // tier 1
      { symbol: "SHIBUSDT", direction: "SHORT" as const, createdAt: "2099-01-02T08:00:00.000Z" }, // tier 2, earliest of tier-2 group
    ];
    const sorted = [...candidates].sort((a, b) => {
      const tierA = symbolPriorityTier(a.symbol, a.direction, LANE_ID, report, GENERATED_AT, "testnet", NOW_MS);
      const tierB = symbolPriorityTier(b.symbol, b.direction, LANE_ID, report, GENERATED_AT, "testnet", NOW_MS);
      if (tierA !== tierB) return tierA - tierB;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    expect(sorted.map((c) => c.symbol)).toEqual(["LINKUSDT", "SUIUSDT", "SHIBUSDT", "DOGEUSDT"]);
  });

  it("mirrorNewSignals: never drops a candidate based on tier — a tier-2 (no-obstruction) symbol still opens when slots allow", async () => {
    // ETHUSDT (the fixture's only symbol with exchange filters) is deliberately NOT in any
    // curated/proven lookup here, so it resolves to tier 2 — but must still be admitted.
    const order = paperOrder({
      symbol: "ETHUSDT",
      selectedLaneId: LANE_ID,
      direction: "SHORT",
      entryPrice: 2000,
      stopLoss: 2100,
    } as Partial<PaperOrder>);
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    // No curation env/cache configured in this test process ⇒ tier is always 2 for everyone, but the
    // candidate must still be admitted (no obstruction) since a slot was available.
    expect(store.getState().intents.length).toBe(1);
    expect(store.getState().intents[0]!.symbol).toBe("ETHUSDT");
  });

  // [PROVEN-ONLY] 2026-07-07 operator: "buka simbol dari whitelist dengan performa terbaik, bukan
  // sembarang buka" — the flag turns the reorder into a hard gate (the ONE deliberate exception
  // to never-rejects). Default off = previous behavior (covered by the test above).
  it("[PROVEN-ONLY] mirrorProvenSymbolsOnly gates OUT an unproven (tier-2) candidate even with free slots", async () => {
    const order = paperOrder({
      symbol: "ETHUSDT",
      selectedLaneId: LANE_ID,
      direction: "SHORT",
      entryPrice: 2000,
      stopLoss: 2100,
    } as Partial<PaperOrder>);
    // Config-injected (not process.env) — env mutation leaks across vitest worker threads.
    const { engine, store } = makeEngine({ paper: makePaperStore([order]), config: { mirrorProvenSymbolsOnly: true } });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    expect(store.getState().intents.length).toBe(0); // unproven symbol stays out — slot stays empty
  });

  it("[BEST-FIRST] within a tier, the higher measured bookNetAvgR symbol ranks first", () => {
    const report = makeReport();
    expect(symbolBookNetAvgR("SUIUSDT", "SHORT", report)).not.toBeNull();
    expect(symbolBookNetAvgR("NOSUCHUSDT", "SHORT", report)).toBeNull();
    // Same-tier comparator behavior: higher netAvgR wins over an older createdAt.
    const candidates = [
      { symbol: "A", perf: 0.05, createdAt: "2099-01-02T08:00:00.000Z" },
      { symbol: "B", perf: 0.2, createdAt: "2099-01-02T10:00:00.000Z" },
    ];
    const sorted = [...candidates].sort((a, b) => {
      if (a.perf !== b.perf) return b.perf - a.perf;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    expect(sorted[0]!.symbol).toBe("B");
  });
});

describe("shouldCapPyramidAdd (2026-07-08, real MAX_HOLD_CUT loss evidence)", () => {
  const adds = (n: number): { paperOrderId: string; laneId: string; qty: number }[] =>
    Array.from({ length: n }, (_, i) => ({ paperOrderId: `add-${i}`, laneId: "L", qty: 1 }));

  it("never caps under the free-add limit, regardless of favorableR", () => {
    expect(shouldCapPyramidAdd({ sourcePaperOrders: adds(2), maxFavorableR: 0 }, 3, 0.15)).toBe(false);
  });

  it("does not cap once past the limit if real favorable progress has been shown", () => {
    // Real cases that were fine: AVAX (2 adds, 0.184R), WLD (3 adds, 0.201R), INJ (3 adds, 0.169R)
    expect(shouldCapPyramidAdd({ sourcePaperOrders: adds(3), maxFavorableR: 0.169 }, 3, 0.15)).toBe(false);
    expect(shouldCapPyramidAdd({ sourcePaperOrders: adds(3), maxFavorableR: 0.201 }, 3, 0.15)).toBe(false);
  });

  it("caps past the limit when there's been no real progress — the XRP incident (7 adds, 0 favorable, $1.84 loss)", () => {
    expect(shouldCapPyramidAdd({ sourcePaperOrders: adds(4), maxFavorableR: 0 }, 3, 0.15)).toBe(true);
    expect(shouldCapPyramidAdd({ sourcePaperOrders: adds(7), maxFavorableR: 0 }, 3, 0.15)).toBe(true);
  });

  it("caps past the limit when progress is real but below the bar — the DOGE incident (15 adds, 0.12R, $4.15 loss)", () => {
    expect(shouldCapPyramidAdd({ sourcePaperOrders: adds(4), maxFavorableR: 0.118 }, 3, 0.15)).toBe(true);
    expect(shouldCapPyramidAdd({ sourcePaperOrders: adds(15), maxFavorableR: 0.118 }, 3, 0.15)).toBe(true);
  });

  it("treats a missing sourcePaperOrders/maxFavorableR as zero (never caps a fresh intent)", () => {
    expect(shouldCapPyramidAdd({ sourcePaperOrders: undefined, maxFavorableR: undefined }, 3, 0.15)).toBe(false);
  });
});

describe("manualCloseIntent (operator Close button — real-money manual control)", () => {
  const openOne = async () => {
    const order = paperOrder({
      symbol: "ETHUSDT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
      direction: "SHORT",
      entryPrice: 2000,
      stopLoss: 2100,
    } as Partial<PaperOrder>);
    const made = makeEngine({ paper: makePaperStore([order]) });
    expect((await made.engine.arm()).ok).toBe(true);
    await made.engine.tick();
    expect(made.store.getState().intents.length).toBe(1);
    return made;
  };

  it("closes the intent reduce-only, books OPERATOR_CLOSE, and never disarms", async () => {
    const { engine, store, client } = await openOne();
    const intent = store.getState().intents[0]!;
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);
    expect(intent.state).toBe("CLOSED");
    expect(intent.closeReason).toBe("OPERATOR_CLOSE");
    expect(engine.isArmed()).toBe(true); // manual close is not a breaker
    expect(store.getState().killedAt).toBeNull();
    const closeOrder = client.placed.find((p) => p.newClientOrderId?.startsWith("dtc-opcl-"));
    expect(closeOrder).toBeTruthy();
    expect(closeOrder!.side).toBe("BUY"); // SHORT intent closes with a BUY
    expect(closeOrder!.reduceOnly).toBe(true);
    expect(closeOrder!.quantity).toBeCloseTo(intent.qty, 9);
  });

  it("closes ONLY the engine share when basket legs net the same symbol (external claim respected)", async () => {
    const { engine, store, client } = await openOne();
    const intent = store.getState().intents[0]!;
    // Simulate cross-sectional baskets long 3× the intent qty on the same symbol: exchange net
    // flips positive even though the engine is SHORT. externalManagedNetQty comes from options —
    // rebuild an engine sharing the same store/client with the claim wired.
    const claim = intent.qty * 3;
    client.positionsBySymbol.set("ETHUSDT", -intent.qty + claim); // netted account position
    const engine2 = new LiveExecutionEngine({
      config: makeConfig({}),
      client: client as unknown as LivePrivateClient,
      store,
      paperStore: makePaperStore([]),
      nowIso: () => "2099-01-02T12:30:00.000Z",
      fillConfirmRetryDelayMs: 0,
      externalManagedNetQty: () => new Map([["ETHUSDT", claim]]),
    });
    const res = await engine2.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);
    const closeOrder = client.placed.filter((p) => p.newClientOrderId?.startsWith("dtc-opcl-")).pop()!;
    expect(closeOrder.quantity).toBeCloseTo(intent.qty, 9); // engine share only, never the basket legs
    // Net position sign flipped by the baskets ⇒ reduceOnly would be rejected ⇒ plain market close.
    expect(closeOrder.reduceOnly).toBeFalsy();
  });

  it("unknown/closed paperOrderId returns ok:false without placing anything", async () => {
    const { engine, client } = makeEngine();
    const before = client.placed.length;
    const res = await engine.manualCloseIntent("paper-nope");
    expect(res.ok).toBe(false);
    expect(client.placed.length).toBe(before);
  });
});

describe("real-money reentrancy + silent-P&L-loss audit fixes (2026-07-11)", () => {
  function openOneVia(client: FakeLiveClient) {
    const order = paperOrder({
      symbol: "ETHUSDT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
      direction: "SHORT",
      entryPrice: 2000,
      stopLoss: 2100,
    } as Partial<PaperOrder>);
    return makeEngine({ client, paper: makePaperStore([order]) });
  }

  it("[RACE-1] manualCloseIntent refuses a concurrent call on the SAME intent instead of double-flattening it", async () => {
    class SlowGetPositionsClient extends FakeLiveClient {
      onFirstGetPositions: (() => Promise<unknown>) | null = null;
      async getPositions(symbol?: string) {
        if (this.onFirstGetPositions) {
          const fn = this.onFirstGetPositions;
          this.onFirstGetPositions = null;
          await fn(); // simulates a second manualCloseIntent() racing in during this exact await
        }
        return super.getPositions(symbol);
      }
    }
    const client = new SlowGetPositionsClient();
    const { engine, store } = openOneVia(client);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;

    let secondResult: { ok: boolean; reason: string | null } | null = null;
    client.onFirstGetPositions = async () => {
      secondResult = await engine.manualCloseIntent(intent.paperOrderId);
    };
    const firstResult = await engine.manualCloseIntent(intent.paperOrderId);

    expect(firstResult.ok).toBe(true);
    expect(secondResult).not.toBeNull();
    expect(secondResult!.ok).toBe(false);
    expect(secondResult!.reason).toMatch(/already being processed/);
    // Only ONE real flatten order reached the exchange, not two — the bug this closes would have
    // let both calls independently flatten + book realized P&L for the same real position.
    expect(client.placed.filter((p) => p.newClientOrderId?.startsWith("dtc-opcl-"))).toHaveLength(1);
  });

  it("[RACE-2] engageKillSwitch (kill()) refuses to double-process while already engaging", async () => {
    const client = new FakeLiveClient();
    const { engine, store } = openOneVia(client);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    expect(store.getState().intents).toHaveLength(1);

    // JS is single-threaded: calling kill() twice back-to-back WITHOUT awaiting either runs the
    // first call synchronously up to its first internal await (killSwitchEngaging is set to true
    // BEFORE that await) — the second call then starts synchronously too, sees the flag already
    // set, and returns immediately. This is exactly the "tick()'s auto-trip + a manual kill()
    // arrive at the same moment" race the fix closes.
    const p1 = engine.kill("first kill");
    const p2 = engine.kill("second concurrent kill");
    await Promise.all([p1, p2]);

    // Only ONE kill-flatten order reached the exchange, not two.
    expect(client.placed.filter((p) => p.newClientOrderId?.startsWith("dtc-kill-"))).toHaveLength(1);
    expect(store.getState().intents[0]!.state).toBe("KILLED");
  });

  it("[SILENT-LOSS-1] a getUserTrades failure during manualCloseIntent leaves P&L UNKNOWN (never a fabricated 0/scratch), but still counts as a loss for the kill-switch streak", async () => {
    class FailingTradesClient extends FakeLiveClient {
      async getUserTrades(): Promise<FuturesUserTrade[]> {
        throw new Error("simulated getUserTrades outage");
      }
    }
    const client = new FailingTradesClient();
    const { engine, store } = openOneVia(client);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    const dailyBefore = { ...store.getState().dailyLedger };
    const totalBefore = store.getState().totalRealizedPnlUsd;
    const consecutiveBefore = store.getState().consecutiveLosses;

    const res = await engine.manualCloseIntent(intent.paperOrderId);

    expect(res.ok).toBe(true);
    expect(res.realizedPnlUsd).toBeNull();
    expect(intent.realizedPnlUsd).toBeNull();
    expect(intent.lastError).toMatch(/UNKNOWN/);
    // Dollar totals untouched — the real number is genuinely unknown, wallet-reconciliation is
    // the safety net for it, not a fabricated $0 here.
    expect(store.getState().dailyLedger.realizedPnlUsd).toBe(dailyBefore.realizedPnlUsd);
    expect(store.getState().totalRealizedPnlUsd).toBe(totalBefore);
    // But the loss-streak IS bumped — an unknown outcome must never read as a neutral scratch.
    expect(store.getState().consecutiveLosses).toBe(consecutiveBefore + 1);
    expect(store.getState().dailyLedger.losses).toBe((dailyBefore.losses ?? 0) + 1);
  });

  it("[SILENT-LOSS-2] a failed stop/breakeven order query during settlement leaves P&L UNKNOWN instead of silently booking the real stop-out as a $0 scratch", async () => {
    class FailingAlgoQueryClient extends FakeLiveClient {
      async queryAlgoOrder(): Promise<FuturesAlgoOrder> {
        throw new Error("simulated queryAlgoOrder outage");
      }
    }
    const client = new FailingAlgoQueryClient();
    const { engine, store } = openOneVia(client);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    expect(intent.stopOrderId).toBeTruthy(); // sanity: a real protective stop was placed on entry
    const dailyBefore = { ...store.getState().dailyLedger };
    const consecutiveBefore = store.getState().consecutiveLosses;

    // Simulate the stop having triggered and flattened the position on the exchange, with the
    // real closing trade booked under the STOP's own fill order id (not the entry order id) —
    // settleClosedIntent can only discover that id via queryAlgoOrder(stopOrderId), which is now
    // failing, so the old code's ourOrderIds set would miss this trade entirely and compute net=0.
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [{ orderId: "stop-fill-order-id", realizedPnl: -12, commission: 0.5 } as never];
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.realizedPnlUsd).toBeNull(); // NOT a fabricated 0 — the real -12 loss is unrecoverable here
    expect(closed.lastError).toMatch(/UNKNOWN/);
    expect(store.getState().dailyLedger.realizedPnlUsd).toBe(dailyBefore.realizedPnlUsd);
    expect(store.getState().consecutiveLosses).toBe(consecutiveBefore + 1);
  });
});

describe("LiveExecutionStore prune on save (2026-07-11 OOM fix — mainnet's real trade-intent ledger)", () => {
  function minimalClosedIntent(id: string, createdAtMs: number): LiveIntent {
    const iso = new Date(createdAtMs).toISOString();
    return {
      paperOrderId: id,
      symbol: "ETHUSDT",
      direction: "SHORT",
      state: "CLOSED",
      qty: 1,
      tp1Qty: 0,
      plannedEntryPrice: 2000,
      stopLossPrice: 2100,
      tp1Price: 1900,
      filledEntryPrice: 2000,
      entryOrderId: "1",
      stopOrderId: null,
      tp1OrderId: null,
      beStopOrderId: null,
      realizedPnlUsd: 1,
      feesUsd: 0,
      createdAt: iso,
      updatedAt: iso,
      closedAt: iso,
      closeReason: "OPERATOR_CLOSE",
      lastError: null,
    };
  }

  it("keeps every non-terminal (OPEN/etc.) intent and drops only the OLDEST terminal ones beyond the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-live-prune-"));
    dirs.push(dir);
    const store = new LiveExecutionStore(dir);
    const MAX = 2000; // default LIVE_MAX_STORED_INTENTS
    const extra = 5;
    for (let i = 0; i < MAX + extra; i++) {
      store.getState().intents.push(minimalClosedIntent(`closed-${i}`, 1_000_000_000_000 + i * 60_000));
    }
    // Deliberately OLDER than every closed intent above, to prove OPEN status alone (not recency)
    // is what protects an intent from the terminal-only prune.
    store.getState().intents.push({
      ...minimalClosedIntent("open-1", 1),
      state: "OPEN",
      realizedPnlUsd: null,
      closedAt: null,
      closeReason: null,
    });

    store.save();

    const state = store.getState();
    expect(state.intents.filter((i) => i.state === "OPEN")).toHaveLength(1);
    expect(state.intents.some((i) => i.paperOrderId === "open-1")).toBe(true);
    const terminal = state.intents.filter((i) => i.state !== "OPEN");
    expect(terminal).toHaveLength(MAX);
    for (let i = 0; i < extra; i++) {
      expect(state.intents.some((i) => i.paperOrderId === `closed-${i}`)).toBe(false);
    }
    expect(state.intents.some((i) => i.paperOrderId === `closed-${extra}`)).toBe(true);
    expect(state.intents.some((i) => i.paperOrderId === `closed-${MAX + extra - 1}`)).toBe(true);

    const reloaded = new LiveExecutionStore(dir);
    expect(reloaded.getState().intents).toHaveLength(1 + MAX);
  });
});

describe("MAE/regime-exit persistence (Tier 2 audit, purely additive — new recorded fields only)", () => {
  it("REGRESSION: maxFavorableR still behaves exactly as before (unchanged peak, same arm/giveback close) — and maxAdverseR stays 0 on a path that never goes adverse", async () => {
    // Identical scenario to the pre-existing "mfe_giveback lane tracks favorable R…" test: entry
    // 2000/short, +1R favorable, then a retrace to +0.5R that triggers the giveback close. Price
    // never crosses to adverse (favorableR is 0.5-1.0 throughout), so maxAdverseR must stay at its
    // floor (0) the whole time — this is the documented "never goes adverse ⇒ stays at 0" case.
    const order = paperOrder({
      selectedLaneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK",
      variantExitRule: "mfe_giveback",
      takeProfitLevels: [1700],
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);

    await engine.tick();
    expect(client.placed.map((p) => p.type)).toEqual(["MARKET", "STOP_MARKET", "LIMIT"]);
    // Freshly-opened this tick: manageMfeGiveback (the shared tick hook) hasn't run against it yet,
    // same as maxFavorableR — both stay at their construction-time null until the next tick.
    expect(store.getState().intents[0]!.maxFavorableR).toBeNull();
    expect(store.getState().intents[0]!.maxAdverseR).toBeNull();

    client.markPriceBySymbol.set("ETHUSDT", 1900); // +1R favorable on a short
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(store.getState().intents[0]!.maxFavorableR).toBeCloseTo(1, 6); // exact pre-existing assertion
    expect(store.getState().intents[0]!.maxAdverseR).toBe(0); // still never adverse

    client.markPriceBySymbol.set("ETHUSDT", 1950); // retraces to +0.5R; default giveback threshold
    client.flattenRealizedPnl = 2.2;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("MFE_GIVEBACK_EXIT"); // exact pre-existing assertion
    expect(closed.realizedPnlUsd).toBeCloseTo(2.2, 6); // exact pre-existing assertion
    expect(closed.maxFavorableR).toBeCloseTo(1, 6); // peak untouched by the new trough tracking
    expect(closed.maxAdverseR).toBe(0); // favorableR was 0.5 at close — never negative
    expect(store.getState().dailyLedger.wins).toBe(1); // exact pre-existing assertion
  });

  it("maxAdverseR tracks the running WORST (most negative) favorableR on a synthetic price path, independent of maxFavorableR's own peak", async () => {
    // Keep favorableR below the 0.75R arm threshold throughout so the giveback close never fires —
    // this isolates the tracking math (peak/trough) from the exit DECISION entirely.
    const order = paperOrder({
      selectedLaneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK",
      variantExitRule: "mfe_giveback",
      takeProfitLevels: [1700],
    } as Partial<PaperOrder>);
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick(); // mirror/open at entry 2000, stop 2100 (short; risk = 100)

    // Tick: price moves ADVERSE first (mark 2050 ⇒ favorableR = (2000-2050)/100 = -0.5).
    client.markPriceBySymbol.set("ETHUSDT", 2050);
    await engine.tick();
    let intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(intent.maxFavorableR).toBe(0); // never favorable yet — peak stays at its floor
    expect(intent.maxAdverseR).toBeCloseTo(-0.5, 6); // worst point recorded

    // Tick: price recovers to favorable but well under the arm threshold (mark 1980 ⇒ +0.2R).
    client.markPriceBySymbol.set("ETHUSDT", 1980);
    await engine.tick();
    intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(intent.maxFavorableR).toBeCloseTo(0.2, 6);
    expect(intent.maxAdverseR).toBeCloseTo(-0.5, 6); // recovery does NOT improve the stored trough

    // Tick: price makes a NEW, deeper adverse excursion (mark 2080 ⇒ -0.8R).
    client.markPriceBySymbol.set("ETHUSDT", 2080);
    await engine.tick();
    intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(intent.maxFavorableR).toBeCloseTo(0.2, 6); // peak unaffected by the new worse trough
    expect(intent.maxAdverseR).toBeCloseTo(-0.8, 6); // trough only updates when this tick is worse
  });

  it("stamps the exit-side regime snapshot with the LIVE controller state at close time (not the frozen entry-time regime), and leaves it absent while an intent has never closed", async () => {
    // Intent A: stays OPEN across multiple ticks — the exit-side fields must never appear.
    const openOrder = paperOrder({
      paperOrderId: "paper-open-forever",
      regime: "Bearish",
      controllerMode: "SHORT_ONLY",
      controllerConfidence: "MEDIUM",
    } as Partial<PaperOrder>);
    const { engine: openEngine, store: openStore } = makeEngine({
      paper: makePaperStore([openOrder]),
      getControllerSnapshot: () => ({
        regime: "Mixed",
        mode: "VALIDATION_ONLY",
        confidence: "LOW",
        capturedAt: "2099-01-02T12:00:00.000Z",
      }),
    });
    expect((await openEngine.arm()).ok).toBe(true);
    await openEngine.tick();
    await openEngine.tick(); // a second tick — still never closed
    const stillOpen = openStore.getState().intents[0]!;
    expect(stillOpen.state).toBe("OPEN");
    expect(stillOpen.exitRegime).toBeUndefined();
    expect(stillOpen.exitControllerMode).toBeUndefined();
    expect(stillOpen.exitControllerConfidence).toBeUndefined();
    // Entry-side snapshot is the frozen ENTRY value — unaffected by the live "Mixed" controller.
    expect(stillOpen.sourcePaperOrders?.[0]?.regime).toBe("Bearish");

    // Intent B: closes via the operator manual-close path. The live controller reads "Mixed" at
    // this moment, deliberately different from the "Bullish" entry-time regime, to prove the exit
    // stamp reads CURRENT state via currentControllerSnapshot(), not the stale entry snapshot.
    const closingOrder = paperOrder({
      paperOrderId: "paper-will-close",
      regime: "Bullish",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "HIGH",
    } as Partial<PaperOrder>);
    const { engine: closeEngine, store: closeStore } = makeEngine({
      paper: makePaperStore([closingOrder]),
      getControllerSnapshot: () => ({
        regime: "Mixed",
        mode: "VALIDATION_ONLY",
        confidence: "LOW",
        capturedAt: "2099-01-02T12:00:00.000Z",
      }),
    });
    expect((await closeEngine.arm()).ok).toBe(true);
    await closeEngine.tick();
    const beforeClose = closeStore.getState().intents[0]!;
    expect(beforeClose.exitRegime).toBeUndefined();

    const res = await closeEngine.manualCloseIntent(beforeClose.paperOrderId);
    expect(res.ok).toBe(true);
    const closed = closeStore.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.exitRegime).toBe("Mixed");
    expect(closed.exitControllerMode).toBe("VALIDATION_ONLY");
    expect(closed.exitControllerConfidence).toBe("LOW");
    // Entry-side snapshot remains the frozen ENTRY regime ("Bullish"), untouched by the exit stamp.
    expect(closed.sourcePaperOrders?.[0]?.regime).toBe("Bullish");
  });

  it("exit-side regime snapshot fields are null (never the stale entry snapshot) when no live controller is wired at close", async () => {
    const order = paperOrder({
      regime: "Bullish",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "HIGH",
    } as Partial<PaperOrder>);
    // No getControllerSnapshot passed ⇒ engine defaults to () => null (see constructor).
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;

    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.exitRegime).toBeNull();
    expect(closed.exitControllerMode).toBeNull();
    expect(closed.exitControllerConfidence).toBeNull();
  });
});

describe("applyRegimeAutopilotAllocation (autopilot ↔ manual-mode sync)", () => {
  // SPEC CHANGE 2026-07-08 (supersedes the 07-07 sync): "autopilot tetep memerintah, tapi kalau
  // execution mode nya manual, gw ambil alih lane allocation" — an autopilot apply while MANUAL
  // is on must be REFUSED, never overwrite the operator's allocation.
  it("[LOCK] refuses the autopilot apply while the lane-allocation lock is ON (operator owns the allocation)", () => {
    const { engine, store } = makeEngine();
    store.getState().laneAllocationOperatorLock = true;
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]); // operator's pick

    const result = engine.applyRegimeAutopilotAllocation([
      { laneId: "CG_WIDE_FAST_SHORT", weightPct: 60 },
      { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 40 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/lock/);
    expect(store.getState().laneAllocations).toEqual([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]); // untouched
    expect(engine.isLaneAllocationOperatorLocked()).toBe(true); // still the operator's
  });

  it("leaves laneAllocationOperatorLock false (already smart) untouched when applied while not locked", () => {
    const { engine, store } = makeEngine();
    expect(engine.isLaneAllocationOperatorLocked()).toBe(false);

    const result = engine.applyRegimeAutopilotAllocation([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]);

    expect(result.ok).toBe(true);
    expect(store.getState().laneAllocations).toEqual([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]);
    expect(engine.isLaneAllocationOperatorLocked()).toBe(false);
  });

  it("does NOT touch laneAllocationOperatorLock when the allocation is rejected (validation failure)", () => {
    const { engine, store } = makeEngine();
    store.getState().laneAllocationOperatorLock = true;

    const result = engine.applyRegimeAutopilotAllocation([{ laneId: "A", weightPct: 0 }]); // invalid weightPct

    expect(result.ok).toBe(false);
    expect(engine.isLaneAllocationOperatorLocked()).toBe(true); // untouched — the apply never went through
    expect(store.getState().laneAllocations).toBeNull();
  });

  it("regime-autopilot end-to-end via RegimeAutopilot.tick(): LOCK holds the allocation, auto reclaims after it's released", async () => {
    const { RegimeAutopilot, REGIME_AUTOPILOT_PRESETS } = await import("../src/lib/regime-autopilot.js");
    const { engine, store } = makeEngine();
    store.getState().laneAllocationOperatorLock = true;
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]); // operator's pick
    let regime: string | null = null;
    let now = 1_000_000_000_000;
    const pilot = new RegimeAutopilot({
      setAllocations: (a) => engine.applyRegimeAutopilotAllocation(a),
      getLatestRegime: () => regime,
      isManualMode: () => engine.isLaneAllocationOperatorLocked(),
      nowMs: () => now,
      stableCycles: 1,
      minHoldMs: 30 * 60_000,
    });
    regime = "NO_TRADE";
    pilot.tick(); // LOCK is on — the autopilot observes but must not touch anything
    expect(engine.isLaneAllocationOperatorLocked()).toBe(true);
    expect(store.getState().laneAllocations).toEqual([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]);

    store.getState().laneAllocationOperatorLock = false; // operator hands control back
    pilot.tick(); // bot reclaims on the next tick
    expect(store.getState().laneAllocations).toEqual(REGIME_AUTOPILOT_PRESETS.NO_TRADE);
  });

  it("regime-autopilot: laneAllocationOperatorLock stays true while autopilot skips (not yet stable — anti-whipsaw guard unchanged)", async () => {
    const { RegimeAutopilot } = await import("../src/lib/regime-autopilot.js");
    const { engine, store } = makeEngine();
    store.getState().laneAllocationOperatorLock = true;
    let regime: string | null = null;
    let now = 1_000_000_000_000;
    const pilot = new RegimeAutopilot({
      setAllocations: (a) => engine.applyRegimeAutopilotAllocation(a),
      getLatestRegime: () => regime,
      nowMs: () => now,
      stableCycles: 3,
      minHoldMs: 30 * 60_000,
    });
    regime = "BEAR_TREND";
    pilot.tick(); // count 1/3 — not yet stable, does NOT call setAllocations
    pilot.tick(); // count 2/3 — still not stable
    expect(engine.isLaneAllocationOperatorLocked()).toBe(true); // untouched, since autopilot never acted
  });

  it("toggling raw-bypass mode (manualSelectorMode) never affects the lane-allocation lock or autopilot's guard", () => {
    const { engine, store } = makeEngine();
    store.getState().laneAllocationOperatorLock = true;
    engine.setLaneAllocations([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]); // operator's pick

    engine.setManualSelectorMode(true); // operator flips the UNRELATED raw-bypass dashboard toggle
    let result = engine.applyRegimeAutopilotAllocation([{ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 }]);
    expect(result.ok).toBe(false); // still locked — must not have been released by the toggle

    engine.setManualSelectorMode(false);
    result = engine.applyRegimeAutopilotAllocation([{ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 }]);
    expect(result.ok).toBe(false); // STILL locked — toggling raw-bypass off must not release it either
    expect(store.getState().laneAllocations).toEqual([{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }]);
  });
});

// ── Stage-2 execution-lifecycle tap: proves the report-only entry taps NEVER disturb execution ──────────────────
describe("openIntent execution-lifecycle tap — report-only, cannot alter the exchange interaction", () => {
  // The writer-lock singleton in lane-context-journal-runtime.ts is process-lifetime/global by design
  // (production wants a failed lock retried later, not re-checked every call). Within this describe
  // block one test deliberately points the journal at a broken (file-not-dir) path to prove a throwing
  // logger never escapes into the execution path — that intentionally trips the lock's failure+cooldown
  // state, which would otherwise silently starve the *next* test's perfectly valid temp dir of its
  // lifecycle write (no ensureDir ever runs against it) for the length of the retry cooldown. Reset
  // between tests so each one's writer-lock outcome reflects only its own directory.
  beforeEach(() => {
    _resetLaneRuntimeForTests();
  });

  // Run one armed entry tick under a given env and return the exact exchange-order sequence + intent state.
  async function runEntry(env: NodeJS.ProcessEnv): Promise<{ placed: Array<{ type: string; side: string; quantity: number; reduceOnly: boolean | undefined }>; count: number; state: string }> {
    const saved = { EXEC_LIFECYCLE_TIMESTAMPS: process.env.EXEC_LIFECYCLE_TIMESTAMPS, FOUR_BRAIN_INSTANCE_ID: process.env.FOUR_BRAIN_INSTANCE_ID, LANE_CONTEXT_JOURNAL_DIR: process.env.LANE_CONTEXT_JOURNAL_DIR, PORT: process.env.PORT };
    delete process.env.PORT; // ensure the 3103 raw-PORT block can't accidentally fire from the test runner env
    for (const [k, v] of Object.entries(env)) process.env[k] = v as string;
    try {
      // SAME paperOrderId across runs so the derived clientOrderIds match ⇒ a fair sequence comparison.
      const order = paperOrder({ paperOrderId: "paper-fixedlifecycle01", variantExitRule: "tp1_full" });
      const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
      expect((await engine.arm()).ok).toBe(true);
      await engine.tick();
      return {
        placed: client.placed.map((p) => ({ type: p.type, side: p.side, quantity: p.quantity, reduceOnly: p.reduceOnly })),
        count: client.placed.length,
        canceled: client.canceled.length,
        leverage: client.leverageCalls.length,
        state: store.getState().intents[0]?.state ?? "NONE",
      };
    } finally {
      for (const k of ["EXEC_LIFECYCLE_TIMESTAMPS", "FOUR_BRAIN_INSTANCE_ID", "LANE_CONTEXT_JOURNAL_DIR", "PORT"] as const) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
    }
  }

  it("logger OFF vs logger THROWING at every point ⇒ identical exchange sequence + intent result, no throw", async () => {
    // Baseline: lifecycle logging fully OFF (the production default).
    const off = await runEntry({});
    expect(off.count).toBeGreaterThan(0);
    expect(off.placed.map((p) => p.type)).toEqual(["MARKET", "STOP_MARKET", "LIMIT"]);
    expect(off.state).toBe("OPEN");

    // Logger ENABLED but pointed at a broken journal dir (a FILE) so EVERY lifecycle write throws internally.
    const brokenBase = join(tmp(), "not-a-dir-file");
    writeFileSync(brokenBase, "x");
    let threw = false;
    let on: Awaited<ReturnType<typeof runEntry>> | null = null;
    try {
      on = await runEntry({ EXEC_LIFECYCLE_TIMESTAMPS: "1", FOUR_BRAIN_INSTANCE_ID: "3102", LANE_CONTEXT_JOURNAL_DIR: brokenBase });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // a throwing logger never escapes into the execution path
    expect(on).not.toBeNull();
    expect(on!.count).toBe(off.count); // exchange CALL COUNT unchanged (runtime spy: placeOrder/placeAlgoOrder)
    expect(on!.placed).toEqual(off.placed); // exchange sequence (type/side/qty/reduceOnly) byte-for-byte unchanged
    expect(on!.canceled).toBe(off.canceled); // no extra cancel calls
    expect(on!.leverage).toBe(off.leverage); // no extra setLeverage calls
    expect(on!.state).toBe(off.state); // intent result unchanged
  });

  it("logger enabled + a WORKING dir writes the entry lifecycle without changing the exchange sequence", async () => {
    const dir = tmp();
    const on = await runEntry({ EXEC_LIFECYCLE_TIMESTAMPS: "1", FOUR_BRAIN_INSTANCE_ID: "3102", LANE_CONTEXT_JOURNAL_DIR: dir });
    expect(on.placed.map((p) => p.type)).toEqual(["MARKET", "STOP_MARKET", "LIMIT"]); // unchanged
    expect(on.state).toBe("OPEN");
    // the entry lifecycle was journaled: DECISION → SUBMITTED → EXCHANGE_ACK → FINAL_FILL
    const events = readFileSync(join(dir, "lane-context", "3102", "lifecycle.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toEqual(["DECISION", "SUBMITTED", "EXCHANGE_ACK", "FINAL_FILL"]);
  });

  it("REGRESSION (review finding): a filled entry whose downstream STOP placement throws is NOT mislabeled REJECTED", async () => {
    const saved = { EXEC_LIFECYCLE_TIMESTAMPS: process.env.EXEC_LIFECYCLE_TIMESTAMPS, FOUR_BRAIN_INSTANCE_ID: process.env.FOUR_BRAIN_INSTANCE_ID, LANE_CONTEXT_JOURNAL_DIR: process.env.LANE_CONTEXT_JOURNAL_DIR, PORT: process.env.PORT };
    delete process.env.PORT;
    const dir = tmp();
    process.env.EXEC_LIFECYCLE_TIMESTAMPS = "1";
    process.env.FOUR_BRAIN_INSTANCE_ID = "3102";
    process.env.LANE_CONTEXT_JOURNAL_DIR = dir;
    try {
      const client = new FakeLiveClient();
      client.algoErrorCode = -2021; // the protective STOP throws "would immediately trigger" AFTER the entry fills
      const order = paperOrder({ paperOrderId: "paper-stopfail0001", variantExitRule: "tp1_full" });
      const { engine, store } = makeEngine({ client: client as unknown as FakeLiveClient, paper: makePaperStore([order]) });
      expect((await engine.arm()).ok).toBe(true);
      await engine.tick();
      // Incumbent behavior UNCHANGED: entry filled but stop failed ⇒ emergency flatten ⇒ intent ERROR.
      expect(store.getState().intents[0]!.state).toBe("ERROR");
      const events = readFileSync(join(dir, "lane-context", "3102", "lifecycle.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { event: string }).event);
      expect(events).toContain("FINAL_FILL"); // the entry order genuinely filled...
      expect(events).not.toContain("REJECTED"); // ...so it must NOT be labeled a rejection (no double-terminal)
      expect(events).toEqual(["DECISION", "SUBMITTED", "EXCHANGE_ACK", "FINAL_FILL"]);
    } finally {
      for (const k of ["EXEC_LIFECYCLE_TIMESTAMPS", "FOUR_BRAIN_INSTANCE_ID", "LANE_CONTEXT_JOURNAL_DIR", "PORT"] as const) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
    }
  });
});

describe("LiveIntent.causalLineage (point 2): immutable lineage snapshot stamped once at intent open", () => {
  const causalIdentity = {
    lineageSchemaVersion: "causal-lineage-1",
    decisionId: "causal-decision-1",
    opportunityId: "opportunity-1",
    outcomeId: null,
    instanceId: "3101",
    laneId: "LANE",
    symbolOrBasketId: "ETHUSDT",
    direction: "SHORT",
    featureSchemaVersion: "causal-paper-opportunity/1",
    decisionRuleVersion: "paper-opportunity-admission/1",
    attributionRuleVersion: "direct-paper-order-link/1",
    cortexDecisionId: "cortex-decision-1",
    allocationSnapshotId: "cortex-allocation-1",
    canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    cortexFeatureSchemaVersion: 1,
    decisionPolicyVersion: "decision-policy/1",
    executionPolicyVersion: "execution-policy/1",
    evidencePolicyVersion: "evidence-policy/1",
    evidenceEra: "era/1",
    policyDeploymentAt: "2099-01-01T00:00:00.000Z",
  };

  it("stamps causalLineage on the primary intent AND its sourcePaperOrders entry, verbatim off the PaperOrder's causalIdentity at open time", async () => {
    const order = paperOrder({ paperOrderId: "paper-lineage01", variantExitRule: "tp1_full", causalIdentity });
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    const expectedLineage = {
      opportunityId: "opportunity-1",
      cortexDecisionId: "cortex-decision-1",
      allocationSnapshotId: "cortex-allocation-1",
      canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
      instanceId: "3101",
      policyDeploymentAt: "2099-01-01T00:00:00.000Z",
      // 6 additional fields (blocker 2), read directly off `order`, not off causalIdentity — the
      // paperOrder() fixture here uses a loose cast (`as unknown as PaperOrder`) and never sets
      // sourceObservationId/scanBatchId/selectedLaneId, so those come through as their real
      // (undefined/undefined/null) values, exactly like production would for an order missing them.
      paperOrderId: "paper-lineage01",
      sourceObservationId: undefined,
      scanBatchId: null,
      paperLaneId: undefined,
      symbol: "ETHUSDT",
      direction: "SHORT",
    };
    // Only the immutable subset is copied — never the whole CausalIdentity, never re-derived.
    expect(intent.causalLineage).toEqual(expectedLineage);
    expect(intent.sourcePaperOrders?.[0]?.causalLineage).toEqual(expectedLineage);
  });

  it("leaves causalLineage undefined when the PaperOrder carried no causalIdentity at open time — never fabricated", async () => {
    const order = paperOrder({ paperOrderId: "paper-lineage02", variantExitRule: "tp1_full" });
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(intent.causalLineage).toBeUndefined();
    expect(intent.sourcePaperOrders?.[0]?.causalLineage).toBeUndefined();
  });

  it("never overwrites causalLineage on a later tick — the snapshot stays exactly what it was stamped at open", async () => {
    const order = paperOrder({ paperOrderId: "paper-lineage03", variantExitRule: "tp1_full", causalIdentity });
    const { engine, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const beforeLineage = store.getState().intents[0]!.causalLineage;
    expect(beforeLineage).toBeDefined();
    // A later tick with no new candidates must not touch the already-open intent's lineage.
    await engine.tick();
    expect(store.getState().intents[0]!.causalLineage).toEqual(beforeLineage);
  });
});

// ── 2026-07-19 real-money audit fix (BUG 1) ─────────────────────────────────

describe("[BUG 1] kill-switch flatten failure tracking + retry", () => {
  it("tracks a per-intent flatten failure distinctly, surfaces it in getStatus, and self-heals via retry on the next tick", async () => {
    const order = paperOrder();
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick(); // opens the intent

    // Trip the kill-switch (daily max loss) while the flatten's reduce-only close throws ONCE —
    // simulates a transient Binance/network error mid-flatten.
    client.failNextReduceOnlyMarketOrders = 1;
    store.getState().dailyLedger.dateUtc = "2099-01-02";
    store.getState().dailyLedger.realizedPnlUsd = -20;
    await engine.tick();

    let st = store.getState();
    expect(st.killedAt).not.toBeNull(); // kill-switch IS engaged
    const intent = st.intents[0]!;
    // FAIL-WITHOUT-FIX: before the fix, this position was silently left OPEN forever — nothing
    // distinguished it from "cleanly flattened" or "never killed" anywhere in getStatus()/the kill
    // route, and nothing ever retried it.
    expect(intent.state).toBe("OPEN"); // never flattened — still exposed on the exchange
    expect(st.killSwitchFlattenFailedIntentIds).toContain(intent.paperOrderId);

    const status = engine.getStatus() as unknown as { killSwitchFlattenFailures: Array<{ paperOrderId: string; symbol: string }> };
    expect(status.killSwitchFlattenFailures.some((f) => f.paperOrderId === intent.paperOrderId && f.symbol === "ETHUSDT")).toBe(true);

    // FIX: killSwitchTrip() never re-fires once latched, but retryFailedKillFlattens() must pick
    // this back up automatically on the very next tick — no operator action required.
    await engine.tick();
    st = store.getState();
    expect(st.intents[0]!.state).toBe("KILLED");
    expect(st.killSwitchFlattenFailedIntentIds).toEqual([]);
    expect((engine.getStatus() as unknown as { killSwitchFlattenFailures: unknown[] }).killSwitchFlattenFailures).toEqual([]);
  });
});

// ── 2026-07-19 real-money audit fix (BUG 2) ─────────────────────────────────

describe("[BUG 2] rescue flip: single real P&L across multiple opposing intents", () => {
  const RESCUE_LIVE = {
    enabled: true,
    minAgeMs: 60 * 60 * 1000,
    minLossUsd: 1,
    netFraction: 1,
    maxNotionalUsd: 5000,
    targetUsd: 0,
    maxSymbols: 2,
    minAvailableBalanceUsd: 10,
    maxHoldMs: 24 * 60 * 60 * 1000,
  };
  const SHORT_REGIME = () => ({ regime: "Bearish", mode: "SHORT_ONLY", capturedAt: new Date().toISOString() });

  function pushIntent(store: ReturnType<typeof makeEngine>["store"], over: Record<string, unknown>) {
    store.getState().intents.push({
      paperOrderId: "p-x",
      symbol: "ETHUSDT",
      direction: "LONG",
      state: "OPEN",
      qty: 1.0,
      tp1Qty: 0,
      plannedEntryPrice: 2000,
      stopLossPrice: 1900,
      tp1Price: 2100,
      filledEntryPrice: 2000,
      entryOrderId: "1",
      stopOrderId: null,
      tp1OrderId: null,
      beStopOrderId: null,
      realizedPnlUsd: null,
      feesUsd: null,
      createdAt: "2099-01-02T10:00:00.000Z",
      updatedAt: "2099-01-02T10:00:00.000Z",
      closedAt: null,
      closeReason: null,
      lastError: null,
      ...over,
    } as never);
    store.save();
  }

  it("books the ONE real P&L exactly once across 2 opposing intents resolved by the SAME flip order (previously double-counted)", async () => {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", 1.0); // netted engine-share LONG exposure
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", -5);
    client.rescueFlipRealizedPnl = -10; // the ONE real flip close realizes exactly -$10
    const { engine, store } = makeEngine({
      client,
      config: { rescue: RESCUE_LIVE, rescueExecute: true, regimeLossHardCutStopFraction: 0 },
      getControllerSnapshot: SHORT_REGIME,
    });
    expect((await engine.arm()).ok).toBe(true);
    // TWO opposing LONG intents on the SAME symbol summing to the netted position above — the flip
    // resolves BOTH of them from a SINGLE real close.
    pushIntent(store, { paperOrderId: "p-eth-a", qty: 0.6 });
    pushIntent(store, { paperOrderId: "p-eth-b", qty: 0.4 });

    const totalBefore = store.getState().totalRealizedPnlUsd;
    await engine.tick(); // flip resolves both opposing intents at once

    const intents = store.getState().intents;
    const a = intents.find((i) => i.paperOrderId === "p-eth-a")!;
    const b = intents.find((i) => i.paperOrderId === "p-eth-b")!;
    expect(a.state).toBe("CLOSED");
    expect(b.state).toBe("CLOSED");
    expect(a.closeReason).toBe("RESCUE_FLIP");
    expect(b.closeReason).toBe("RESCUE_FLIP");

    // FIX: the ONE real -$10 outcome is attributed proportionally by qty share (0.6 / 0.4), summing
    // back to the single real amount — NOT -$10 booked to EACH intent (which would sum to -$20).
    expect((a.realizedPnlUsd ?? 0) + (b.realizedPnlUsd ?? 0)).toBeCloseTo(-10, 6);
    expect(a.realizedPnlUsd).toBeCloseTo(-6, 6);
    expect(b.realizedPnlUsd).toBeCloseTo(-4, 6);

    // FAIL-WITHOUT-FIX: the old code called applyRealizedToLedger(-10) once PER opposing intent,
    // so totalRealizedPnlUsd would have dropped by -20 (double-counted) and consecutiveLosses by 2.
    // FIX: the ledger sees the single real P&L exactly once.
    expect(store.getState().totalRealizedPnlUsd).toBeCloseTo(totalBefore - 10, 6);
    expect(store.getState().consecutiveLosses).toBe(1);
  });
});

// ── 2026-07-19 real-money audit fix (BUG 3) ─────────────────────────────────

describe("[BUG 3] partial protective-stop fill re-establishes protection for the residual", () => {
  it("places a fresh STOP_MARKET for the residual quantity when the resting stop is gone but the position isn't fully flat", async () => {
    const order = paperOrder(); // SHORT ETHUSDT, entry 2000, stop 2100
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick(); // opens the intent + places the initial protective stop

    const intent = store.getState().intents[0]!;
    const originalStopId = intent.stopOrderId!;
    expect(originalStopId).toBeTruthy();
    const fullQty = intent.qty;
    expect(client.positionsBySymbol.get("ETHUSDT")).toBeCloseTo(-fullQty, 6);

    // Simulate: the stop TRIGGERED but only PARTIALLY filled under thin liquidity (a real,
    // documented Binance behavior — STOP_MARKET becomes a taker MARKET order once triggered, and an
    // unfilled remainder does not keep resting). 40% of the qty closed, 60% remains, and the stop's
    // own order is now terminal (EXPIRED) — no longer resting/protecting anything.
    const residualQty = Number((fullQty * 0.6).toFixed(6));
    client.positionsBySymbol.set("ETHUSDT", -residualQty);
    client.algoOrderOverrides.set(originalStopId, { algoStatus: "EXPIRED", actualOrderId: "9001" });
    client.orderStatusById.set("9001", "EXPIRED"); // the triggered market order is done executing — no more fills coming

    await engine.tick(); // manageLifecycle must notice the residual is naked and re-protect it

    // FAIL-WITHOUT-FIX: nothing re-queries the stop's own status once placed, so the intent would
    // stay OPEN pointing at the now-dead stopOrderId with the residual quantity completely naked.
    const freshStop = client.placed.find(
      (p) => p.type === "STOP_MARKET" && p.reduceOnly && Math.abs(p.quantity - residualQty) < 1e-6,
    );
    expect(freshStop).toBeTruthy(); // FIX: a new protective stop was placed for the residual qty
    const updated = store.getState().intents[0]!;
    expect(updated.stopOrderId).not.toBe(originalStopId); // FIX: the intent now points at the fresh stop
    expect(updated.state).toBe("OPEN"); // still open (correctly not settled — it isn't fully flat)
  });

  it("does nothing when the stop is still genuinely resting (no false positives)", async () => {
    const order = paperOrder();
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick(); // opens the intent

    const intent = store.getState().intents[0]!;
    const originalStopId = intent.stopOrderId!;
    const placedBefore = client.placed.length;

    await engine.tick(); // stop is untouched (default fake: algoStatus "NEW", actualOrderId = itself → treated as still resting since its actual order defaults to status "NEW")

    expect(client.placed.length).toBe(placedBefore); // no new stop placed
    expect(store.getState().intents[0]!.stopOrderId).toBe(originalStopId);
  });

  it("[real-money audit follow-up] falls back to an immediate reduceOnly MARKET close on -2021 instead of retrying forever", async () => {
    const order = paperOrder(); // SHORT ETHUSDT, entry 2000, stop 2100
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({ client, paper: makePaperStore([order]) });
    await engine.arm();
    await engine.tick(); // opens the intent + places the initial protective stop (no error yet)

    const intent = store.getState().intents[0]!;
    const originalStopId = intent.stopOrderId!;
    const fullQty = intent.qty;
    const residualQty = Number((fullQty * 0.6).toFixed(6));
    client.positionsBySymbol.set("ETHUSDT", -residualQty);
    client.algoOrderOverrides.set(originalStopId, { algoStatus: "EXPIRED", actualOrderId: "9001" });
    client.orderStatusById.set("9001", "EXPIRED");
    // By construction of this scenario, price has already crossed the original trigger level —
    // a fresh conditional order at that SAME price is exactly what Binance's -2021 ("would
    // immediately trigger") guards against. Simulate that rejection on the re-establish attempt.
    client.algoErrorCode = -2021;
    // A matched non-zero realized row against a KNOWN order id (the entry) is definitive close
    // evidence per realizedFromTrades' own doc comment — same convention other settlement tests
    // in this file use — so settlement doesn't need to guess the dynamically-generated close
    // order id ahead of time.
    client.trades = [{ orderId: intent.entryOrderId!, realizedPnl: -5, commission: 0.1 } as never];

    await engine.tick(); // must not retry the identical doomed order forever — must market-close instead

    // FAIL-WITHOUT-FIX: before the fallback, the catch block only set intent.lastError and
    // returned, retrying an order that would hit -2021 again on every subsequent tick, forever,
    // leaving the residual genuinely naked with no automatic resolution.
    const marketClose = client.placed.find(
      (p) => p.type === "MARKET" && p.reduceOnly && Math.abs(p.quantity - residualQty) < 1e-6,
    );
    expect(marketClose).toBeTruthy(); // FIX: fell back to an immediate market close of the residual
    const updated = store.getState().intents[0]!;
    expect(updated.state).toBe("CLOSED"); // fully resolved, not left open and naked
    expect(updated.realizedPnlUsd).not.toBeNull();
    expect(updated.closeReason).toBe("RESIDUAL_STOP_REESTABLISH_2021_FALLBACK_MARKET_CLOSE");
  });
});

// ── 2026-07-19 real-money audit fix (BUG 4) ─────────────────────────────────

describe("[BUG 4] aggregate worst-case notional across manual directional lanes", () => {
  it("computes and surfaces the combined worst-case notional per side without blocking multi-lane configs when no cap is set (additive)", () => {
    const { engine } = makeEngine({ config: { maxNotionalPerTrade: 250 } });
    const result = engine.setManualDirectionalLaneAllocations({
      long: [
        { laneId: "LANE_A", weightPct: 100 },
        { laneId: "LANE_B", weightPct: 100 },
        { laneId: "LANE_C", weightPct: 100 },
      ],
      short: [],
    });
    // Historical behavior preserved: 3 lanes at 100% each was always allowed and must STILL be
    // allowed when no aggregate cap is configured — additive fix, never silently blocks.
    expect(result.ok).toBe(true);
    // FIX: the real worst-case aggregate is now computed and surfaced — 3 x $250, not "diversified".
    expect(result.combinedWorstCaseNotionalUsd?.long).toBeCloseTo(750, 6);
    expect(result.combinedWorstCaseNotionalUsd?.short).toBeCloseTo(0, 6);
    expect(
      engine.getStatus().laneSelection.manualDirectionalAllocations?.combinedWorstCaseNotionalUsd.long,
    ).toBeCloseTo(750, 6);
  });

  it("a single lane per direction (the common case) is unaffected — bounded by maxNotionalPerTrade exactly as before", () => {
    const { engine } = makeEngine({ config: { maxNotionalPerTrade: 250 } });
    const result = engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "LANE_A", weightPct: 100 }],
      short: [{ laneId: "LANE_B", weightPct: 50 }],
    });
    expect(result.ok).toBe(true);
    expect(result.combinedWorstCaseNotionalUsd?.long).toBeCloseTo(250, 6);
    expect(result.combinedWorstCaseNotionalUsd?.short).toBeCloseTo(125, 6);
  });

  it("rejects a configuration whose aggregate exceeds an EXPLICITLY opted-in cap, and does not persist it", () => {
    const { engine, store } = makeEngine({
      config: { maxNotionalPerTrade: 250, maxAggregateManualDirectionalNotionalUsd: 500 },
    });
    const before = store.getState().manualDirectionalAllocations;
    const result = engine.setManualDirectionalLaneAllocations({
      long: [
        { laneId: "LANE_A", weightPct: 100 },
        { laneId: "LANE_B", weightPct: 100 },
        { laneId: "LANE_C", weightPct: 100 },
      ],
      short: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds the configured aggregate cap/);
    expect(result.combinedWorstCaseNotionalUsd?.long).toBeCloseTo(750, 6);
    // Rejected configuration must NOT be persisted.
    expect(store.getState().manualDirectionalAllocations).toEqual(before);
  });

  it("combinedWorstCaseNotionalUsd (pure) sums weightPct-scaled notional across lanes", () => {
    expect(combinedWorstCaseNotionalUsd([{ weightPct: 100 }, { weightPct: 100 }], 250)).toBeCloseTo(500, 6);
    expect(combinedWorstCaseNotionalUsd([{ weightPct: 50 }], 250)).toBeCloseTo(125, 6);
    expect(combinedWorstCaseNotionalUsd([], 250)).toBe(0);
  });
});

// ── 2026-07-20 real-money audit fix (BUG 1) ─────────────────────────────────

describe("[BUG 1] manual-directional lane allocation direction validation", () => {
  it("fails-without: with no lane-direction lookup wired (the pre-fix default — app.ts had no such " +
    "parameter to pass), a lane whose executor is hardcoded SHORT is silently accepted under long", () => {
    const { engine } = makeEngine(); // no laneDirectionForId ⇒ identical to the pre-fix constructor
    // SHORT_FADE_EXHAUSTION_CROWDED is SF_PAPER_LANE_ID — instantiated with direction:"SHORT" in
    // app.ts, and its getOpenSignals() can only ever emit SHORT paper orders.
    const result = engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "SHORT_FADE_EXHAUSTION_CROWDED", weightPct: 100 }],
      short: [],
    });
    expect(result.ok).toBe(true); // BUG: nothing here ever checked the lane's real direction
  });

  it("pass-with: the same fixed-SHORT lane under long is rejected once the lookup is wired, and the " +
    "rejected configuration is never persisted", () => {
    const laneDirectionForId = (laneId: string): "LONG" | "SHORT" | "NEUTRAL" | null =>
      laneId === "SHORT_FADE_EXHAUSTION_CROWDED" ? "SHORT" : null;
    const { engine, store } = makeEngine({ laneDirectionForId });
    const before = store.getState().manualDirectionalAllocations;
    const result = engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "SHORT_FADE_EXHAUSTION_CROWDED", weightPct: 100 }],
      short: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fixed SHORT-direction lane/);
    expect(store.getState().manualDirectionalAllocations).toEqual(before);
  });

  it("the mirror-image mismatch (a fixed-LONG lane listed under short) is also rejected", () => {
    const laneDirectionForId = (laneId: string): "LONG" | "SHORT" | "NEUTRAL" | null =>
      laneId === "INTRADAY_MOMENTUM_BREAKOUT_LONG" ? "LONG" : null;
    const { engine } = makeEngine({ laneDirectionForId });
    const result = engine.setManualDirectionalLaneAllocations({
      long: [],
      short: [{ laneId: "INTRADAY_MOMENTUM_BREAKOUT_LONG", weightPct: 100 }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fixed LONG-direction lane/);
  });

  it("a lane the lookup has no fixed direction for (unknown id, or a NEUTRAL cross-sectional basket) " +
    "is never blocked here — it is either direction-agnostic or validated by " +
    "isManualEntryAllowedForPaper's own directionalBias check instead", () => {
    const laneDirectionForId = (laneId: string): "LONG" | "SHORT" | "NEUTRAL" | null =>
      laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL" ? "NEUTRAL" : null;
    const { engine } = makeEngine({ laneDirectionForId });
    expect(engine.setManualDirectionalLaneAllocations({
      long: [
        { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 },
        { laneId: "SOME_UNKNOWN_LANE_ID", weightPct: 50 },
      ],
      short: [],
    }).ok).toBe(true);
  });

  it("a lane listed on its own correct side is accepted", () => {
    const laneDirectionForId = (laneId: string): "LONG" | "SHORT" | "NEUTRAL" | null =>
      laneId === "REGIME_COMPOSITE_CONFIRMATION_LONG" ? "LONG" : null;
    const { engine } = makeEngine({ laneDirectionForId });
    expect(engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 100 }],
      short: [],
    }).ok).toBe(true);
  });

  it("manualDirectionalLaneMismatchReason (pure): matches variant-suffixed lane ids via the trailing " +
    "segment, same convention as laneSelectionWeightPctForLane", () => {
    const laneDirectionForId = (laneId: string): "LONG" | "SHORT" | "NEUTRAL" | null =>
      laneId === "SHORT_FADE_EXHAUSTION_CROWDED" ? "SHORT" : null;
    expect(
      manualDirectionalLaneMismatchReason("long", "CG_VARIANT_MATRIX:SHORT_FADE_EXHAUSTION_CROWDED", laneDirectionForId),
    ).toMatch(/fixed SHORT-direction lane/);
    expect(
      manualDirectionalLaneMismatchReason("short", "CG_VARIANT_MATRIX:SHORT_FADE_EXHAUSTION_CROWDED", laneDirectionForId),
    ).toBeNull();
    expect(manualDirectionalLaneMismatchReason("long", "UNKNOWN_LANE", laneDirectionForId)).toBeNull();
  });
});

// ── 2026-07-20 real-money audit fix (BUG 2) ─────────────────────────────────

describe("[BUG 2] manual entry decision staleness gate", () => {
  it("fails-without (sanity — must not false-trip ordinary cycle jitter): a decision refreshed well " +
    "within the normal ~7-minute scan cadence still enables entry", () => {
    const nowIso = "2099-01-02T12:00:00.000Z";
    const { engine } = makeEngine({ nowIso: () => nowIso });
    engine.setManualSelectorMode(true);
    expect(engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }],
      short: [],
    }).ok).toBe(true);
    engine.setManualEntryDecision({
      action: "WAIT_PULLBACK",
      directionalBias: "LONG",
      reason: "test",
      observedAt: "2099-01-02T11:45:00.000Z", // 15 minutes old — inside tolerance
    });
    expect(engine.isManualEntryAllowedForPaper({ selectedLaneId: "CG_WIDE_FAST_LONG", direction: "LONG" } as PaperOrder)).toBe(true);
    expect(engine.getStatus().laneSelection.manualDirectionalAllocations?.entryDecisionStale).toBe(false);
  });

  it("pass-with: a decision older than the threshold — the documented failure mode, a persistently " +
    "failing scan cycle leaving the prior directional bias frozen for hours — now fails CLOSED, " +
    "exactly as if the scanner's action were NO_TRADE", () => {
    const nowIso = "2099-01-02T12:00:00.000Z";
    const { engine } = makeEngine({ nowIso: () => nowIso });
    engine.setManualSelectorMode(true);
    expect(engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }],
      short: [],
    }).ok).toBe(true);
    engine.setManualEntryDecision({
      action: "WAIT_PULLBACK",
      directionalBias: "LONG",
      reason: "test",
      observedAt: "2099-01-02T08:00:00.000Z", // 4 hours old — a genuine multi-hour scan outage
    });
    expect(engine.isManualEntryAllowedForPaper({ selectedLaneId: "CG_WIDE_FAST_LONG", direction: "LONG" } as PaperOrder)).toBe(false);
    expect(engine.laneSelectionWeightPctForLane("CG_WIDE_FAST_LONG")).toBe(0);
    expect(engine.getStatus().laneSelection.manualDirectionalAllocations?.entryDecisionStale).toBe(true);
  });

  it("entryDecisionStale reads false when there is no cached decision at all — 'never observed yet' " +
    "and 'observed, now stale' are different states with different existing dashboard copy", () => {
    const { engine } = makeEngine();
    engine.setManualSelectorMode(true);
    expect(engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: "CG_WIDE_FAST_LONG", weightPct: 100 }],
      short: [],
    }).ok).toBe(true);
    expect(engine.getStatus().laneSelection.manualDirectionalAllocations?.entryDecisionStale).toBe(false);
  });

  it("isManualEntryDecisionStale (pure): strict > boundary, and an unparsable timestamp fails closed", () => {
    const observedAt = "2099-01-02T12:00:00.000Z";
    const observedMs = Date.parse(observedAt);
    expect(isManualEntryDecisionStale(observedAt, observedMs + MANUAL_ENTRY_DECISION_MAX_AGE_MS)).toBe(false);
    expect(isManualEntryDecisionStale(observedAt, observedMs + MANUAL_ENTRY_DECISION_MAX_AGE_MS + 1)).toBe(true);
    expect(isManualEntryDecisionStale("not-a-timestamp", observedMs)).toBe(true);
  });
});

// ── fee provenance (LiveIntent.feeSource) ────────────────────────────────────
//
// FAILS WITHOUT THE FIX: `LiveIntent.feeSource` does not exist on pre-fix code (verified: zero
// occurrences of the identifier at HEAD), so every assertion below reads `undefined`.
//
// WHY IT MATTERS: every close path in this engine collapses to
// `intent.feesUsd = settled?.feesUsd ?? null`, and realizedFromTrades returns `feesUsd: 0` from
// THREE structurally different situations — a genuine zero-fee settlement, a settlement with no
// order ids to look up (the exchange is never queried), and a query that matched none of our rows.
// Across 182 closed intents there was no way to tell a measured commission from a structural zero,
// which is exactly what makes an aggregate fee figure over this store untrustworthy.

describe("LiveIntent.feeSource (fee provenance — report-only)", () => {
  function openShort(client?: FakeLiveClient) {
    const order = paperOrder({
      symbol: "ETHUSDT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
      direction: "SHORT",
      entryPrice: 2000,
      stopLoss: 2100,
      variantExitRule: "tp1_full",
    } as Partial<PaperOrder>);
    return makeEngine({ ...(client ? { client } : {}), paper: makePaperStore([order]) });
  }

  it("EXCHANGE when the settlement summed at least one real /userTrades commission row", async () => {
    const { engine, client, store } = openShort();
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;

    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: intent.tp1OrderId!, price: 1900, qty: intent.qty, realizedPnl: 5, commission: 0.04, commissionAsset: "USDT", time: 1 },
    ];
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.feesUsd).toBeCloseTo(0.04, 9);
    expect(closed.feeSource).toBe("EXCHANGE");
  });

  it("UNKNOWN (undefined) — not EXCHANGE — when the trades fetch fails outright and feesUsd is left null", async () => {
    class FailingTradesClient extends FakeLiveClient {
      async getUserTrades(): Promise<FuturesUserTrade[]> {
        throw new Error("simulated getUserTrades outage");
      }
    }
    const { engine, store } = openShort(new FailingTradesClient());
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;

    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.feesUsd).toBeNull();
    expect(closed.feeSource).toBeUndefined();
  });

  it("a STRUCTURAL zero (feesUsd 0 with no commission row ever seen) is NOT labelled EXCHANGE", async () => {
    // The real-money shape of this: an operator closes an intent whose exchange position is
    // already flat. closeQty is 0, so no flatten order is placed, so requiredOrderIds is empty and
    // the settlement short-circuits to "close is visible" with ZERO matching trade rows —
    // realizedPnlUsd 0 and feesUsd 0. Before feeSource, that $0 fee was indistinguishable in the
    // store from a real commission that happened to be $0, and it silently deflated every fee
    // aggregate computed over closed intents.
    const { engine, client, store } = openShort();
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;

    client.positionsBySymbol.set("ETHUSDT", 0); // already flat on the exchange
    client.trades = []; // and nothing of ours in /userTrades
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.feesUsd).toBe(0); // unchanged behaviour — the number itself is not touched
    expect(closed.feeSource).toBeUndefined(); // but it is now marked as NOT a measurement
    // No flatten order was placed, which is what makes this the structural-zero path.
    expect(client.placed.some((p) => p.newClientOrderId?.startsWith("dtc-opcl-"))).toBe(false);
  });
});

// ── confirmedEntryFills (4th hardening pass — exact confirmed-fill identity) ────────────────
//
// entryPriceConfirmed proves SOME real fill price was established; it does not identify WHICH
// order id actually filled. confirmedEntryFills closes that gap: it is populated only from real
// /userTrades rows whose orderId equals the intent's SINGULAR, never-reassigned entryOrderId —
// never from entryOrderIds (plural, grows with pyramid adds) and never merely because
// entryPriceConfirmed is true.

describe("LiveIntent.confirmedEntryFills (exact confirmed-fill identity)", () => {
  it("captures a single confirmed entry fill from a real /userTrades record matching the entry order id", async () => {
    const order = paperOrder(); // SHORT ETHUSDT, entry 2000, stop 2100
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick(); // opens: MARKET entry + STOP_MARKET + LIMIT tp1
    const intent = store.getState().intents[0]!;
    const entryOrderId = intent.entryOrderId!;

    client.positionsBySymbol.set("ETHUSDT", 0); // already flat on the exchange
    client.trades = [
      { symbol: "ETHUSDT", orderId: entryOrderId, tradeId: "t-entry-1", price: 2000, qty: 0.05, realizedPnl: 0, commission: 0.04, commissionAsset: "USDT", time: 1000, maker: false },
    ];
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.confirmedEntryFills).toHaveLength(1);
    expect(closed.confirmedEntryFills![0]!.orderId).toBe(entryOrderId);
    expect(closed.confirmedEntryFills![0]!.tradeId).toBe("t-entry-1");
    expect(closed.confirmedEntryFills![0]!.price).toBeCloseTo(2000, 9);
    expect(closed.confirmedEntryFills![0]!.qty).toBeCloseTo(0.05, 9);
    expect(closed.confirmedEntryFills![0]!.role).toBe("ENTRY");
  });

  it("aggregates two partial fills on the same entry order id — both appear in confirmedEntryFills, not just one", async () => {
    const order = paperOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    const entryOrderId = intent.entryOrderId!;

    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: entryOrderId, tradeId: "t-entry-1", price: 1999, qty: 0.03, realizedPnl: 0, commission: 0.024, commissionAsset: "USDT", time: 1000 },
      { symbol: "ETHUSDT", orderId: entryOrderId, tradeId: "t-entry-2", price: 2002, qty: 0.02, realizedPnl: 0, commission: 0.016, commissionAsset: "USDT", time: 1005 },
    ];
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);

    const closed = store.getState().intents[0]!;
    expect(closed.confirmedEntryFills).toHaveLength(2);
    expect(new Set(closed.confirmedEntryFills!.map((f) => f.tradeId))).toEqual(new Set(["t-entry-1", "t-entry-2"]));
    expect(closed.confirmedEntryFills!.every((f) => f.orderId === entryOrderId)).toBe(true);
  });

  it("confirmedEntryFills is an empty array, never undefined, when no /userTrades record matches the entry order id", async () => {
    const order = paperOrder();
    const { engine, client, store } = makeEngine({ paper: makePaperStore([order]) });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;

    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = []; // nothing of ours in /userTrades
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);

    const closed = store.getState().intents[0]!;
    expect(closed.confirmedEntryFills).toEqual([]);
  });

  it("never attributes a pyramid-add's fill to the original Entry decision — confirmedEntryFills is scoped to the singular entryOrderId, not the plural entryOrderIds array", async () => {
    const orders: PaperOrder[] = [
      paperOrder({
        paperOrderId: "p1", direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED", createdAt: "2099-01-02T00:00:00.000Z",
      } as Partial<PaperOrder>),
    ];
    const client = new FakeLiveClient();
    const { engine, store } = makeEngine({
      client,
      paper: makePaperStore(orders),
      config: { mirrorAllPaperOrders: true, maxAggregateIntentRiskUsd: 10 },
    });
    await engine.arm();
    await engine.tick(); // opens p1
    const originalEntryOrderId = store.getState().intents[0]!.entryOrderId!;

    orders.push(
      paperOrder({
        paperOrderId: "p2", direction: "LONG", entryPrice: 2000, stopLoss: 1900, takeProfitLevels: [2100],
        paperStatus: "PAPER_SUBMITTED", createdAt: "2099-01-02T01:00:00.000Z",
      } as Partial<PaperOrder>),
    );
    await engine.tick(); // pyramid-adds p2 into the same intent
    const intent = store.getState().intents[0]!;
    expect(intent.entryOrderId).toBe(originalEntryOrderId); // singular anchor never reassigned
    expect(intent.entryOrderIds!.length).toBeGreaterThanOrEqual(2); // plural array grew with the add
    const pyramidAddOrderId = intent.entryOrderIds!.find((id) => id !== originalEntryOrderId)!;
    expect(pyramidAddOrderId).toBeTruthy();

    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: originalEntryOrderId, tradeId: "t-original", price: 2000, qty: 0.05, realizedPnl: 0, commission: 0.04, commissionAsset: "USDT", time: 1000 },
      // The pyramid add's own fill — present in the same settlement window (its order id IS in
      // intentSettlementOrderIds, so it is fetched and would sum into realized P&L/fees), but it
      // must never appear in confirmedEntryFills, which is scoped to the ORIGINAL entry decision.
      { symbol: "ETHUSDT", orderId: pyramidAddOrderId, tradeId: "t-pyramid-add", price: 1998, qty: 0.05, realizedPnl: 0, commission: 0.04, commissionAsset: "USDT", time: 4_000_000 },
    ];
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);

    const closed = store.getState().intents[0]!;
    expect(closed.confirmedEntryFills).toHaveLength(1);
    expect(closed.confirmedEntryFills![0]!.orderId).toBe(originalEntryOrderId);
    expect(closed.confirmedEntryFills!.some((f) => f.orderId === pyramidAddOrderId)).toBe(false);
  });
});

describe("live-execution-engine — operator reporting void (2026-08-15)", () => {
  const voided = (realized: number, fees: number) => ({
    reportingExclusion: { kind: "OPERATOR_VOID" as const, voidedAt: "2026-08-15T04:40:00.000Z",
      reason: "config change forced the exit", excludedRealizedPnlUsd: realized, excludedFeesUsd: fees },
  });

  it("[VOID-FLAG] only an explicit OPERATOR_VOID excludes an intent", () => {
    expect(isLiveIntentReportingExcluded(voided(-4.21, 0.48))).toBe(true);
    expect(isLiveIntentReportingExcluded({})).toBe(false);
    expect(isLiveIntentReportingExcluded({ reportingExclusion: null })).toBe(false);
  });

  it("[VOID-SUM] sums only voided intents, and reports the amount rather than hiding it", () => {
    const out = sumLiveIntentReportingExclusions([
      voided(-4.21, 0.48), {}, voided(-1.0, 0.1), { reportingExclusion: null },
    ]);
    expect(out.count).toBe(2);
    expect(out.realizedPnlUsd).toBeCloseTo(-5.21, 9);
    expect(out.feesUsd).toBeCloseTo(0.58, 9);
  });

  it("[TODAY-STALE] a ledger from another day reports ZERO for today, not yesterday's number", () => {
    // The real defect: dailyLedger only rolls inside rollDailyLedger(), which the kill-switch path
    // calls before every read and the status path never did. So on a day with no closes the card
    // printed YESTERDAY's realized under the label "today" — for as many quiet days as followed.
    const yesterday = { dateUtc: "2026-08-15", realizedPnlUsd: -4.21074343, wins: 0, losses: 1 };
    const out = reportedDailyLedger(yesterday, "2026-08-16");
    expect(out.realizedPnlUsd).toBe(0);
    expect(out.wins).toBe(0);
    expect(out.losses).toBe(0);
    expect(out.dateUtc).toBe("2026-08-16");
    // the stale date is CARRIED, so a reader can tell "no trades today" from "ledger is another day's"
    expect(out.staleLedgerDateUtc).toBe("2026-08-15");
  });

  it("[TODAY-STALE] today's own ledger is returned untouched, including a profit", () => {
    const today = { dateUtc: "2026-08-16", realizedPnlUsd: 12.5, wins: 3, losses: 1, scratches: 2 };
    const out = reportedDailyLedger(today, "2026-08-16");
    expect(out).toBe(today);
    expect(out.staleLedgerDateUtc).toBeUndefined();
  });

  it("[TODAY-STALE] a stale PROFIT is zeroed too — this is not a loss-hiding rule", () => {
    // Mirror of the case above with the sign flipped: a reporter that only zeroed losses would
    // quietly flatter the card, which is the same defect wearing the opposite sign.
    const out = reportedDailyLedger({ dateUtc: "2026-08-14", realizedPnlUsd: 31.4, wins: 5, losses: 0 }, "2026-08-16");
    expect(out.realizedPnlUsd).toBe(0);
    expect(out.wins).toBe(0);
    expect(out.staleLedgerDateUtc).toBe("2026-08-14");
  });

  it("[VOID-OTHER-KIND] an exclusion of some OTHER kind must NOT be treated as an operator void", () => {
    // guards the `kind` check itself: without it, any future exclusion kind (e.g. an accounting
    // marker) would silently start subtracting itself from the reported totals.
    const other: any = { reportingExclusion: { kind: "ACCOUNTING_INCOMPLETE",
      voidedAt: "x", reason: "y", excludedRealizedPnlUsd: -99, excludedFeesUsd: 9 } };
    expect(isLiveIntentReportingExcluded(other)).toBe(false);
    expect(sumLiveIntentReportingExclusions([other])).toEqual({ count: 0, realizedPnlUsd: 0, feesUsd: 0 });
  });

  it("[VOID-EMPTY] nothing voided yields a clean zero, never NaN", () => {
    const out = sumLiveIntentReportingExclusions([{}, { reportingExclusion: null }]);
    expect(out).toEqual({ count: 0, realizedPnlUsd: 0, feesUsd: 0 });
  });

  it("[VOID-GARBAGE] an unusable amount is counted but never poisons the total with NaN", () => {
    const out = sumLiveIntentReportingExclusions([
      { reportingExclusion: { kind: "OPERATOR_VOID" as const, voidedAt: "x", reason: "y",
        excludedRealizedPnlUsd: Number.NaN, excludedFeesUsd: Number.NaN } },
      voided(-2, 0.2),
    ]);
    expect(out.count).toBe(2);
    expect(out.realizedPnlUsd).toBeCloseTo(-2, 9);
    expect(Number.isNaN(out.feesUsd)).toBe(false);
  });
});

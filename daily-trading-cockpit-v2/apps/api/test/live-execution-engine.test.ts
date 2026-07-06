import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  computeLiveOrderPlan,
  crowdingExitRecommendation,
  parseLiveExecutionConfig,
  roundDownToStep,
  roundStopToSafeSide,
  roundUpToStep,
  type LiveExecutionConfig,
  type LivePrivateClient,
  type PaperStoreReader,
} from "../src/lib/live-execution-engine.js";
import type { BinanceClient, FuturesFlowSnapshot } from "../src/lib/binance.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";

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

class FakeLiveClient {
  env = "testnet" as const;
  placed: PlaceOrderParams[] = [];
  leverageCalls: Array<{ symbol: string; leverage: number }> = [];
  canceled: Array<{ symbol: string; orderId: number }> = [];
  cancelAllSymbols: string[] = [];
  positionsBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  unrealizedPnlBySymbol = new Map<string, number>();
  orderStatusById = new Map<number, string>();
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
  async queryAlgoOrder(_algoId: number): Promise<FuturesAlgoOrder> {
    return {
      symbol: "ETHUSDT",
      algoId: _algoId,
      clientAlgoId: "",
      algoStatus: "NEW",
      orderType: "STOP_MARKET",
      side: "BUY",
      quantity: 0,
      triggerPrice: 0,
      actualOrderId: _algoId,
    };
  }
  async queryOrder(_symbol: string, orderId: number): Promise<FuturesOrder> {
    return this.stubOrder({ orderId, status: this.orderStatusById.get(orderId) ?? "NEW" });
  }
  async placeOrder(p: PlaceOrderParams): Promise<FuturesOrder> {
    if (this.failAddEntry && p.newClientOrderId?.endsWith("-a")) {
      throw new Error("request timed out after 6000ms");
    }
    this.placed.push(p);
    const orderId = this.nextOrderId++;
    if (p.type === "MARKET" && !p.reduceOnly) {
      this.positionsBySymbol.set(
        p.symbol,
        (this.positionsBySymbol.get(p.symbol) ?? 0) + (p.side === "BUY" ? 1 : -1) * p.quantity,
      );
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
    const algoId = this.nextOrderId++;
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
  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    this.canceled.push({ symbol, orderId });
  }
  async cancelAlgoOrder(orderId: number): Promise<void> {
    this.canceled.push({ symbol: "ETHUSDT", orderId });
  }
  async cancelAllOrders(symbol: string): Promise<void> {
    this.cancelAllSymbols.push(symbol);
  }
  async cancelAllAlgoOrders(symbol: string): Promise<void> {
    this.cancelAllSymbols.push(symbol);
  }
  async getUserTrades(): Promise<FuturesUserTrade[]> {
    return this.trades;
  }
  private stubOrder(overrides: Partial<FuturesOrder>): FuturesOrder {
    return {
      symbol: "ETHUSDT",
      orderId: 0,
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

function paperOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
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

function makePaperStore(orders: PaperOrder[], halted = false): PaperStoreReader {
  return { all: orders, isAdmissionHalted: () => halted };
}

function makeConfig(overrides: Partial<LiveExecutionConfig> = {}): LiveExecutionConfig {
  return {
    enabled: true,
    env: "testnet",
    apiKey: "k",
    apiSecret: "s",
    riskUsdPerTrade: 5,
    maxConcurrentPositions: 3,
    maxCorrelatedAltLongPositions: 3,
    maxCorrelatedAltShortPositions: 3,
    maxClusterPositions: 3,
    dailyMaxLossUsd: 15,
    maxConsecutiveLosses: 5,
    scratchEpsilonUsd: 0.1,
    maxDrawdownUsd: 40,
    defaultLeverage: 3,
    maxLeverage: 2,
    maxNotionalPerTrade: 250,
    maxPaperOrderAgeMs: 24 * 60 * 60 * 1000,
    mirrorAllPaperOrders: false,
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
    configErrors: [],
    ...overrides,
  };
}

function makeEngine(opts: {
  client?: FakeLiveClient;
  paper?: PaperStoreReader;
  config?: Partial<LiveExecutionConfig>;
  isPaperOrderLiveEligible?: (order: PaperOrder, nowIso: string) => boolean;
  getControllerSnapshot?: () => { regime: string | null; mode: string | null; capturedAt?: string | null } | null;
  nowIso?: () => string;
  marketDataClient?: Pick<BinanceClient, "getFuturesFlow">;
} = {}) {
  const client = opts.client ?? new FakeLiveClient();
  const store = new LiveExecutionStore(tmp());
  const engine = new LiveExecutionEngine({
    config: makeConfig(opts.config),
    client: client as unknown as LivePrivateClient,
    store,
    paperStore: opts.paper ?? makePaperStore([]),
    isPaperOrderLiveEligible: opts.isPaperOrderLiveEligible,
    getControllerSnapshot: opts.getControllerSnapshot,
    nowIso: opts.nowIso ?? (() => "2099-01-02T12:00:00.000Z"),
    marketDataClient: opts.marketDataClient,
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

  it("auto-arm is testnet-only — mainnet never auto-arms", () => {
    expect(
      parseLiveExecutionConfig({ LIVE_EXECUTION_ENABLED: "1", LIVE_BINANCE_ENV: "testnet", LIVE_BINANCE_API_KEY: "k", LIVE_BINANCE_API_SECRET: "s", LIVE_AUTO_ARM: "1" }).autoArm,
    ).toBe(true);
    expect(
      parseLiveExecutionConfig({ LIVE_EXECUTION_ENABLED: "1", LIVE_BINANCE_ENV: "mainnet", LIVE_BINANCE_API_KEY: "k", LIVE_BINANCE_API_SECRET: "s", LIVE_AUTO_ARM: "1", LIVE_MAINNET_CONFIRM: "I_UNDERSTAND_REAL_MONEY" }).autoArm,
    ).toBe(false);
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
    client.unrealizedPnlBySymbol.set("ETHUSDT", 20.5);
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

    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.25); // clears the ~0.22 estimated close-cost buffer
    client.flattenRealizedPnl = 1.02;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("PROFIT_BANK_NET_1.00");
    expect(closed.realizedPnlUsd).toBeCloseTo(1.02, 6);
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

    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.1); // gross > 1, but net after the ~0.22 cost buffer is < 1
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

    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.25);
    client.flattenRealizedPnl = 1.02;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("PROFIT_BANK_NET_1.00");
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
    client.unrealizedPnlBySymbol.set("ETHUSDT", 0.25); // estimated close cost is about 0.22 USDT.
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

    client.unrealizedPnlBySymbol.set("ETHUSDT", 0.20); // below the estimated close-cost buffer.
    await engine.tick();

    expect(store.getState().intents[0]!.state).toBe("OPEN");
    expect(client.placed.length).toBe(placedBefore);
  });

  it("CG_WIDE_FAST_LONG closes once net-positive after cost — covers the 2nd long lane, and on testnet", async () => {
    // Emergency exit must cover BOTH removed long lanes (not just the runner) and run on testnet too.
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

    client.unrealizedPnlBySymbol.set("ETHUSDT", 0.25); // clears the ~0.22 estimated close-cost buffer
    client.flattenRealizedPnl = 0.03;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST");
    expect(closed.realizedPnlUsd).toBeCloseTo(0.03, 6);
  });

  it("testnet regime-opposition exit closes only opposing exposure that clears estimated close cost", async () => {
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
    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.0); // cost buffer is about 0.21 USDT.
    client.flattenRealizedPnl = 0.78;
    await engine.tick();

    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_OPPOSITION_BREAKEVEN_LONG_ONLY");
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

  it("testnet mirror-all keeps one symbol on one lane geometry instead of netting different lanes", async () => {
    const orders = [
      paperOrder({
        paperOrderId: "paper-lane-a",
        selectedLaneId: "LANE_A",
        paperOrderMode: "DIAGNOSTIC_ONLY",
        createdAt: "2000-01-01T00:00:00.000Z",
      } as Partial<PaperOrder>),
      paperOrder({
        paperOrderId: "paper-lane-b",
        selectedLaneId: "LANE_B",
        paperOrderMode: "DIAGNOSTIC_ONLY",
        createdAt: "2000-01-01T00:01:00.000Z",
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
        entryOrderId: 1,
        stopOrderId: null,
        tp1OrderId: 2,
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
        entryOrderId: 3,
        stopOrderId: null,
        tp1OrderId: 4,
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
    expect(yearly.periodLabel).toBe("2095-2099");
    expect(yearly.bucketStarts).toHaveLength(5);
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

  it("exchange error streak auto-disarms", async () => {
    const { engine, client } = makeEngine({});
    await engine.arm();
    client.failNextTicks = 3;
    await engine.tick();
    await engine.tick();
    await engine.tick();
    expect(engine.isArmed()).toBe(false);
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
    const { engine, store } = makeEngine({ client, paper: makePaperStore(orders), config: { mirrorAllPaperOrders: true } });
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
    const { engine, store } = makeEngine({ client, paper: makePaperStore(orders), config: { mirrorAllPaperOrders: true } });
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
      entryOrderId: 1,
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
      entryOrderId: 1,
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
    pushIntent(store, { paperOrderId: "p-resc", direction: "SHORT", rescue: true, rescuePriorRealizedUsd: -4.72, entryOrderId: 50 });

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
      entryOrderId: 1,
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

  function mainnetEngine(profitProtection: boolean) {
    const client = new FakeLiveClient();
    client.positionsBySymbol.set("ETHUSDT", -0.05); // net short
    client.markPriceBySymbol.set("ETHUSDT", 1900);
    client.unrealizedPnlBySymbol.set("ETHUSDT", 1.0); // green; est close cost ≈ 0.21
    client.flattenRealizedPnl = 0.78;
    const { engine, store } = makeEngine({
      client,
      config: { env: "mainnet", mainnetConfirmed: true, mainnetProfitProtection: profitProtection },
      getControllerSnapshot: () => ({ regime: "Bullish expansion", mode: "LONG_ONLY", capturedAt: new Date().toISOString() }),
    });
    return { engine, client, store };
  }

  it("WITHOUT the opt-in, mainnet leaves a counter-regime green position open (the old, exposed behavior)", async () => {
    const { engine, client, store } = mainnetEngine(false);
    seedOpposingGreenShort(store);
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("MIRRORED"); // not harvested
    expect(client.placed.length).toBe(0); // no flatten placed
    expect(engine.getStatus().limits.regimeExitActive).toBe(false);
  });

  it("WITH the opt-in, mainnet banks the counter-regime green position at breakeven (same harvest as testnet)", async () => {
    const { engine, client, store } = mainnetEngine(true);
    seedOpposingGreenShort(store);
    await engine.tick();
    const closed = store.getState().intents[0]!;
    expect(closed.state).toBe("CLOSED");
    expect(closed.closeReason).toBe("REGIME_OPPOSITION_BREAKEVEN_LONG_ONLY");
    expect(closed.realizedPnlUsd).toBeCloseTo(0.78, 6);
    const flat = client.placed.at(-1)!;
    expect(flat.type).toBe("MARKET");
    expect(flat.reduceOnly).toBe(true);
    expect(flat.side).toBe("BUY"); // reduce a short
    expect(engine.getStatus().limits.regimeExitActive).toBe(true);
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
  });

  it("refuses a second copy on a symbol that already has an open intent", async () => {
    const { engine } = makeEngine();
    expect((await engine.arm()).ok).toBe(true);
    expect((await engine.copyExternalIntent(spec)).ok).toBe(true);
    const res = await engine.copyExternalIntent(spec);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/already open/);
  });

  it("refuses invalid geometry (stop on the wrong side for the direction)", async () => {
    const { engine } = makeEngine();
    expect((await engine.arm()).ok).toBe(true);
    const res = await engine.copyExternalIntent({ ...spec, stopLossPrice: 1900, tp1Price: 2100 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/geometry/);
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
});

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
  parseLiveExecutionConfig,
  roundDownToStep,
  roundStopToSafeSide,
  roundUpToStep,
  type LiveExecutionConfig,
  type LivePrivateClient,
  type PaperStoreReader,
} from "../src/lib/live-execution-engine.js";
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
  async setLeverage(): Promise<void> {}
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
    dailyMaxLossUsd: 15,
    maxConsecutiveLosses: 5,
    maxDrawdownUsd: 40,
    maxLeverage: 2,
    maxNotionalPerTrade: 250,
    maxPaperOrderAgeMs: 24 * 60 * 60 * 1000,
    mirrorAllPaperOrders: false,
    testnetTakeProfitUsd: 0,
    autoArm: false,
    mainnetConfirmed: false,
    configErrors: [],
    ...overrides,
  };
}

function makeEngine(opts: {
  client?: FakeLiveClient;
  paper?: PaperStoreReader;
  config?: Partial<LiveExecutionConfig>;
  isPaperOrderLiveEligible?: (order: PaperOrder, nowIso: string) => boolean;
  nowIso?: () => string;
} = {}) {
  const client = opts.client ?? new FakeLiveClient();
  const store = new LiveExecutionStore(tmp());
  const engine = new LiveExecutionEngine({
    config: makeConfig(opts.config),
    client: client as unknown as LivePrivateClient,
    store,
    paperStore: opts.paper ?? makePaperStore([]),
    isPaperOrderLiveEligible: opts.isPaperOrderLiveEligible,
    nowIso: opts.nowIso ?? (() => "2099-01-02T12:00:00.000Z"),
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
    expect(closed.closeReason).toBe("TESTNET_USD_TP_20.00");
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
      { paperOrderId: "paper-lane-a", laneId: "LANE_A", qty: 0.05 },
    ]);

    const account = await engine.getAccountSnapshot();
    expect(account.openPositionCount).toBe(1);
    expect(account.accountEquity).toBe(5000);
    expect(account.positions[0]!.targetTpPrice).toBeCloseTo(1900, 9);
    expect(account.positions[0]!.targetTpGapPct).toBeCloseTo(5, 9);
    expect(account.positions[0]!.liquidationPrice).toBe(1500);
    expect(account.lanes.map((lane) => lane.laneId)).toEqual(["LANE_A"]);
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
      config: { mirrorAllPaperOrders: true, maxConcurrentPositions: 10, maxConsecutiveLosses: 5, dailyMaxLossUsd: 999, maxDrawdownUsd: 999 },
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

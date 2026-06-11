import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BinanceFuturesPrivateError, type FuturesOrder, type FuturesSymbolFilters, type FuturesUserTrade, type PlaceOrderParams } from "../src/lib/binance-futures-private.js";
import {
  LiveExecutionEngine,
  LiveExecutionStore,
  computeLiveOrderPlan,
  parseLiveExecutionConfig,
  roundDownToStep,
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
  orderStatusById = new Map<number, string>();
  trades: FuturesUserTrade[] = [];
  hedge = false;
  failNextTicks = 0;
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
    return [];
  }
  async getPositions(symbol?: string) {
    const out = [];
    for (const [sym, amt] of this.positionsBySymbol) {
      if (symbol && sym !== symbol) continue;
      out.push({ symbol: sym, positionAmt: amt, entryPrice: 0, unRealizedProfit: 0, leverage: 2, marginType: "ISOLATED" });
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
  async queryOrder(_symbol: string, orderId: number): Promise<FuturesOrder> {
    return this.stubOrder({ orderId, status: this.orderStatusById.get(orderId) ?? "NEW" });
  }
  async placeOrder(p: PlaceOrderParams): Promise<FuturesOrder> {
    this.placed.push(p);
    const orderId = this.nextOrderId++;
    if (p.type === "MARKET" && !p.reduceOnly) {
      this.positionsBySymbol.set(p.symbol, (p.side === "BUY" ? 1 : -1) * p.quantity);
    }
    if (p.type === "MARKET" && p.reduceOnly) {
      this.positionsBySymbol.set(p.symbol, 0);
    }
    return this.stubOrder({ orderId, status: "FILLED", avgPrice: p.type === "MARKET" ? 2000 : 0 });
  }
  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    this.canceled.push({ symbol, orderId });
  }
  async cancelAllOrders(symbol: string): Promise<void> {
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
  nowIso?: () => string;
} = {}) {
  const client = opts.client ?? new FakeLiveClient();
  const store = new LiveExecutionStore(tmp());
  const engine = new LiveExecutionEngine({
    config: makeConfig(opts.config),
    client: client as unknown as LivePrivateClient,
    store,
    paperStore: opts.paper ?? makePaperStore([]),
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

  it("roundDownToStep avoids float artifacts", () => {
    expect(roundDownToStep(0.0500000001, 0.001)).toBeCloseTo(0.05, 12);
    expect(roundDownToStep(2.5000000004, 0.1)).toBeCloseTo(2.5, 12);
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
});

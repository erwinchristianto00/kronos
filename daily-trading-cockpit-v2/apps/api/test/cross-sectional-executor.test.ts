import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import type { FuturesOrder, FuturesPosition, FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
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
  /** What queryOrder reports for a symbol when polled — simulates the exchange confirming a fill
   *  that the initial placeOrder response returned as avgPrice=0. Unset ⇒ stays unconfirmed (NEW). */
  queryOrderAvgPriceBySymbol = new Map<string, number>();
  queryOrderCallCount = 0;
  private orderSeq = 100;

  private buildOrder(symbol: string, side: string, quantity: number, reduceOnly: boolean | undefined, orderId: number, avgPrice: number): FuturesOrder {
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
      executedQty: avgPrice > 0 ? quantity : 0,
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
    return Array.from(this.markPriceBySymbol.entries()).map(([symbol, markPrice]) => ({
      symbol,
      positionAmt: 0,
      entryPrice: 0,
      markPrice,
      liquidationPrice: 0,
      unRealizedProfit: 0,
      leverage: 3,
      marginType: "ISOLATED",
    }));
  }
  async placeOrder(params: { symbol: string; side: string; quantity: number; reduceOnly?: boolean }) {
    if (this.failOnSymbol === params.symbol && !params.reduceOnly) throw new Error(`exchange rejected ${params.symbol}`);
    this.placed.push(params);
    const orderId = this.orderSeq++;
    const avgPrice = this.fillPriceBySymbol.get(params.symbol) ?? 0;
    return this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, orderId, avgPrice);
  }
  async queryOrder(symbol: string, orderId: number) {
    this.queryOrderCallCount++;
    const avgPrice = this.queryOrderAvgPriceBySymbol.get(symbol) ?? 0;
    return this.buildOrder(symbol, "BUY", 0, false, orderId, avgPrice);
  }
}

function makeExecutor(opts: { client?: FakeExecClient; allowed?: boolean; laneWeightPct?: number; signalMs?: number } = {}) {
  const client = opts.client ?? new FakeExecClient();
  const signalStore = new CrossSectionalStore(tmpDir());
  const store = new CrossSectionalExecutorStore(tmpDir());
  // Executor watermark starts at construction time; backdate it so our test signal is "new".
  store.getState().lastSeenSignalMs = NOW_MS - 3_600_000;
  if (opts.signalMs !== undefined) signalStore.add(signalObs(opts.signalMs));
  const executor = new CrossSectionalExecutor({
    client,
    signalStore,
    store,
    isAllowed: () => opts.allowed ?? true,
    laneWeightPct: () => opts.laneWeightPct ?? 100,
    nowIso: () => NOW,
    fillConfirmRetryDelayMs: 0,
  });
  return { executor, client, signalStore, store };
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

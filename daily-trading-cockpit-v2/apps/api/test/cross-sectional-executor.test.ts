import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import type { FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
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
  private orderSeq = 100;

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
  async getPositions(): Promise<never[]> {
    return [];
  }
  async placeOrder(params: { symbol: string; side: string; quantity: number; reduceOnly?: boolean }): Promise<{ orderId: number; avgPrice: number }> {
    if (this.failOnSymbol === params.symbol && !params.reduceOnly) throw new Error(`exchange rejected ${params.symbol}`);
    this.placed.push(params);
    return { orderId: this.orderSeq++, avgPrice: this.fillPriceBySymbol.get(params.symbol) ?? 0 };
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
});

/**
 * Dense per-tick R-path recorder (2026-07-22, report-only) — see position-path-recorder.ts.
 *
 * FAIL-WITHOUT-FIX: before this feature, NO store persisted a dense per-tick R path for any trade
 * (exit-brain-shadow.ts's 2026-07-21 inventory), LiveExecutionEngine and SingleSymbolLaneExecutor
 * had no positionPathRecorder option, and every resolved trade honestly classified
 * INSUFFICIENT_PATH_DATA in the Exit Brain shadow scorer. These tests cannot even construct
 * against pre-feature code, and with the option removed the recorder trivially stays empty after
 * a real open→tick→tick→close cycle.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BinanceFuturesPrivateError,
  type FuturesAlgoOrder,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
  type PlaceAlgoOrderParams,
  type PlaceOrderParams,
} from "../src/lib/binance-futures-private.js";
import {
  LiveExecutionEngine,
  LiveExecutionStore,
  type LiveExecutionConfig,
  type LivePrivateClient,
  type PaperStoreReader,
} from "../src/lib/live-execution-engine.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type SingleSymbolExecClient,
  type SingleSymbolFreshSignal,
} from "../src/lib/single-symbol-lane-executor.js";
import {
  CLOSED_RETENTION_MS,
  MAX_CLOSED_PATHS,
  MAX_OPEN_POSITIONS,
  MAX_TICKS_PER_POSITION,
  PositionPathRecorder,
  STALE_OPEN_MS,
  resolvedTradesFromRecordedPaths,
  thinOlderHalf,
  type PositionPathMeta,
} from "../src/lib/position-path-recorder.js";
import { DEFAULT_EXIT_BRAIN_PARAMS, evaluateExitBrainCounterfactual } from "../src/lib/exit-brain-policy.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-pathrec-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const META: PositionPathMeta = { laneId: "LANE_A", symbol: "ETHUSDT", direction: "LONG", source: "engine" };

// ── store unit tests ─────────────────────────────────────────────────────────

describe("PositionPathRecorder store", () => {
  it("appends chronological ticks and getPath returns them", () => {
    const rec = new PositionPathRecorder(tmp());
    expect(rec.recordTick("k1", 1_000, 0, { meta: META })).toBe(true);
    expect(rec.recordTick("k1", 2_000, 0.25)).toBe(true);
    expect(rec.recordTick("k1", 3_000, -0.1)).toBe(true);
    const path = rec.getPath("k1")!;
    expect(path.ticks).toEqual([
      { t: 1_000, r: 0 },
      { t: 2_000, r: 0.25 },
      { t: 3_000, r: -0.1 },
    ]);
    expect(path.meta).toEqual(META);
    expect(path.rawTickCount).toBe(3);
    expect(rec.isTrackingOpen("k1")).toBe(true);
  });

  it("meta is frozen from the first call that supplied it", () => {
    const rec = new PositionPathRecorder(tmp());
    rec.recordTick("k1", 1_000, 0, { meta: META });
    rec.recordTick("k1", 2_000, 0.1, { meta: { ...META, laneId: "SOMETHING_ELSE" } });
    expect(rec.getPath("k1")!.meta!.laneId).toBe("LANE_A");
  });

  it("drops non-finite inputs and out-of-order timestamps without throwing", () => {
    const rec = new PositionPathRecorder(tmp());
    expect(rec.recordTick("", 1_000, 0)).toBe(false);
    expect(rec.recordTick("k1", Number.NaN, 0)).toBe(false);
    expect(rec.recordTick("k1", 1_000, Number.POSITIVE_INFINITY)).toBe(false);
    expect(rec.getPath("k1")).toBeNull(); // nothing fabricated
    rec.recordTick("k1", 5_000, 0.1, { meta: META });
    expect(rec.recordTick("k1", 4_000, 0.2)).toBe(false); // out-of-order — dropped
    expect(rec.getPath("k1")!.ticks).toHaveLength(1);
  });

  it("thinning: 1000 appends stay hard-capped, entry tick survives, chronology holds, recent stays dense", () => {
    const rec = new PositionPathRecorder(tmp());
    const t0 = 1_000_000;
    const step = 25_000;
    for (let i = 0; i < 1_000; i += 1) {
      expect(rec.recordTick("k1", t0 + i * step, i / 1_000, { meta: META, deferSave: true })).toBe(true);
      expect(rec.getPath("k1")!.ticks.length).toBeLessThanOrEqual(MAX_TICKS_PER_POSITION);
    }
    const path = rec.getPath("k1")!;
    // Cap math: overflow at append 601 → 451 kept; thins again at 751 and 901; +99 appends → 550.
    expect(path.ticks.length).toBe(550);
    expect(path.thinned).toBe(3);
    expect(path.rawTickCount).toBe(1_000);
    expect(path.ticks[0]!.t).toBe(t0); // index 0 (the entry observation) always survives
    expect(path.ticks[path.ticks.length - 1]!.t).toBe(t0 + 999 * step); // newest tick intact
    for (let i = 1; i < path.ticks.length; i += 1) {
      expect(path.ticks[i]!.t).toBeGreaterThan(path.ticks[i - 1]!.t);
    }
    // The newest 300 ticks are never decimated (only the older half is): the last 300 must be
    // perfectly contiguous at the raw cadence.
    const recent = path.ticks.slice(-300);
    for (let i = 1; i < recent.length; i += 1) {
      expect(recent[i]!.t - recent[i - 1]!.t).toBe(step);
    }
  });

  it("thinOlderHalf keeps every 2nd older tick (index 0 included) and the whole newer half", () => {
    const ticks = Array.from({ length: 601 }, (_, i) => ({ t: i, r: 0 }));
    const thinned = thinOlderHalf(ticks);
    expect(thinned.length).toBe(451); // 150 of the older 300 + the newer 301
    expect(thinned[0]!.t).toBe(0);
    expect(thinned[1]!.t).toBe(2); // every 2nd of the older half
    expect(thinned[150]!.t).toBe(300); // newer half untouched from here on
    expect(thinned[thinned.length - 1]!.t).toBe(600);
  });

  it("hard-caps concurrently tracked open positions; pruneExpired frees leaked slots", () => {
    const rec = new PositionPathRecorder(tmp());
    for (let i = 0; i < MAX_OPEN_POSITIONS; i += 1) {
      expect(rec.recordTick(`k${i}`, 1_000, 0, { deferSave: true })).toBe(true);
    }
    expect(rec.recordTick("one-too-many", 1_000, 0, { deferSave: true })).toBe(false);
    expect(rec.isTrackingOpen("one-too-many")).toBe(false);
    // A leaked open path (writer crashed, close never observed) is dropped — NOT moved to closed.
    const pruned = rec.pruneExpired(1_000 + STALE_OPEN_MS + 1);
    expect(pruned.droppedOpen).toBe(MAX_OPEN_POSITIONS);
    expect(rec.listClosedPaths()).toHaveLength(0);
    expect(rec.recordTick("one-too-many", 2_000, 0)).toBe(true); // capacity freed
  });

  it("closed handoff buffer is a bounded FIFO (oldest pruned) and markClosed no-ops on unknown keys", () => {
    const rec = new PositionPathRecorder(tmp());
    expect(rec.markClosed("never-tracked", 1_000)).toBe(false);
    for (let i = 0; i < MAX_CLOSED_PATHS + 10; i += 1) {
      rec.recordTick(`k${i}`, 1_000 + i, 0.5, { meta: META, deferSave: true });
      expect(rec.markClosed(`k${i}`, 2_000 + i, { deferSave: true })).toBe(true);
    }
    const closed = rec.listClosedPaths();
    expect(closed).toHaveLength(MAX_CLOSED_PATHS);
    expect(closed.some((p) => p.key === "k0")).toBe(false); // oldest evicted
    expect(closed.some((p) => p.key === `k${MAX_CLOSED_PATHS + 9}`)).toBe(true);
    expect(rec.isTrackingOpen("k5")).toBe(false); // moved out of open either way
  });

  it("markClosed records closedAtMs + writer finalR (falling back to the last tick's r)", () => {
    const rec = new PositionPathRecorder(tmp());
    rec.recordTick("a", 1_000, 0.42, { meta: META });
    rec.markClosed("a", 5_000, { finalR: 0.9 });
    expect(rec.getPath("a")!.closedAtMs).toBe(5_000);
    expect(rec.getPath("a")!.closeR).toBe(0.9);
    rec.recordTick("b", 1_000, 0.42, { meta: META });
    rec.markClosed("b", 5_000); // no finalR — last tick stands in
    expect(rec.getPath("b")!.closeR).toBe(0.42);
  });

  it("pruneExpired drops closed paths beyond the retention window", () => {
    const rec = new PositionPathRecorder(tmp());
    rec.recordTick("old", 1_000, 0);
    rec.markClosed("old", 2_000);
    rec.recordTick("fresh", 1_000, 0);
    rec.markClosed("fresh", 2_000 + CLOSED_RETENTION_MS);
    const pruned = rec.pruneExpired(2_000 + CLOSED_RETENTION_MS + 1);
    expect(pruned.droppedClosed).toBe(1);
    expect(rec.listClosedPaths().map((p) => p.key)).toEqual(["fresh"]);
  });

  it("never throws on a corrupt store file — restarts empty and keeps working (atomic persistence roundtrip)", () => {
    const dir = tmp();
    writeFileSync(join(dir, "position-paths.json"), "{ this is not json", "utf-8");
    const rec = new PositionPathRecorder(dir);
    expect(rec.getState().closed).toHaveLength(0);
    expect(Object.keys(rec.getState().open)).toHaveLength(0);
    expect(rec.recordTick("k1", 1_000, 0.1, { meta: META })).toBe(true);
    rec.markClosed("k1", 2_000, { finalR: 0.1 });
    rec.flush();
    // Reload from disk: the closed path survived, and the JSON on disk is valid again.
    const reloaded = new PositionPathRecorder(dir);
    expect(reloaded.listClosedPaths()).toHaveLength(1);
    expect(reloaded.getPath("k1")!.ticks).toEqual([{ t: 1_000, r: 0.1 }]);
    expect(() => JSON.parse(readFileSync(join(dir, "position-paths.json"), "utf-8"))).not.toThrow();
  });
});

// ── Exit Brain reader adapter ────────────────────────────────────────────────

describe("resolvedTradesFromRecordedPaths (dense Exit Brain reader source)", () => {
  it("converts a closed dense path to ExitBrainResolvedTrade shape, appending the terminal close tick", () => {
    const rec = new PositionPathRecorder(tmp());
    const t0 = Date.parse("2026-07-22T00:00:00.000Z");
    const rs = [0, 0.3, 0.6, 0.9, 0.5, 0.2];
    rs.forEach((r, i) => rec.recordTick("intent:p1:c1", t0 + i * 600_000, r, { meta: META, deferSave: true }));
    rec.markClosed("intent:p1:c1", t0 + 6 * 600_000, { finalR: 0.15 });

    const trades = resolvedTradesFromRecordedPaths(rec.listClosedPaths());
    expect(trades).toHaveLength(1);
    const trade = trades[0]!;
    expect(trade.tradeId).toBe("pp:intent:p1:c1");
    expect(trade.laneId).toBe("LANE_A");
    expect(trade.symbol).toBe("ETHUSDT");
    expect(trade.direction).toBe("LONG");
    expect(trade.actualExitR).toBe(0.15);
    expect(trade.closedAtIso).toBe(new Date(t0 + 6 * 600_000).toISOString());
    expect(trade.ticks).toHaveLength(rs.length + 1); // + appended terminal tick at the close
    expect(trade.ticks[trade.ticks.length - 1]).toEqual({ tsMs: t0 + 6 * 600_000, currentR: 0.15 });

    // End-to-end honesty check: these REAL dense ticks clear minEvaluableTicks and actually get
    // SCORED by the Exit Brain counterfactual — the whole point of the recorder.
    expect(trade.ticks.length).toBeGreaterThanOrEqual(DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks);
    const cf = evaluateExitBrainCounterfactual(trade.ticks, { exitR: trade.actualExitR, exitAtIso: trade.closedAtIso });
    expect(cf.status).toBe("EVALUATED");
  });

  it("skips meta-less paths (never fabricates identity) and still-open paths are not offered at all", () => {
    const rec = new PositionPathRecorder(tmp());
    rec.recordTick("no-meta", 1_000, 0);
    rec.markClosed("no-meta", 2_000);
    rec.recordTick("still-open", 1_000, 0, { meta: META });
    expect(resolvedTradesFromRecordedPaths(rec.listClosedPaths())).toHaveLength(0);
  });
});

// ── engine-level integration (FakeLiveClient harness) ────────────────────────

const FILTERS: FuturesSymbolFilters = {
  symbol: "ETHUSDT",
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
  pricePrecision: 2,
  quantityPrecision: 3,
};

/** Trimmed copy of live-execution-engine.test.ts's FakeLiveClient (only what these tests drive). */
class FakeLiveClient {
  env = "testnet" as const;
  placed: PlaceOrderParams[] = [];
  positionsBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  orderStatusById = new Map<string, string>();
  trades: FuturesUserTrade[] = [];
  private nextOrderId = 1000;

  async ensureTimeSync(): Promise<void> {}
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
        unRealizedProfit: 0,
        leverage: 2,
        marginType: "ISOLATED",
      });
    }
    return out;
  }
  async isHedgeMode(): Promise<boolean> {
    return false;
  }
  async setLeverage(): Promise<void> {}
  async setIsolatedMargin(): Promise<void> {}
  async getOpenOrders() {
    return [];
  }
  async getOpenAlgoOrders() {
    return [];
  }
  async queryAlgoOrder(_algoId: string): Promise<FuturesAlgoOrder> {
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
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    return this.stubOrder({ orderId, status: this.orderStatusById.get(orderId) ?? "NEW", avgPrice: 0 });
  }
  async placeOrder(p: PlaceOrderParams): Promise<FuturesOrder> {
    this.placed.push(p);
    const orderId = String(this.nextOrderId++);
    if (p.type === "MARKET" && !p.reduceOnly) {
      this.positionsBySymbol.set(p.symbol, (this.positionsBySymbol.get(p.symbol) ?? 0) + (p.side === "BUY" ? 1 : -1) * p.quantity);
    }
    if (p.type === "MARKET" && p.reduceOnly) {
      this.positionsBySymbol.set(p.symbol, 0);
    }
    return this.stubOrder({ orderId, status: "FILLED", avgPrice: p.type === "MARKET" && !p.reduceOnly ? 2000 : 0 });
  }
  async placeAlgoOrder(p: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
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
  async cancelOrder(): Promise<void> {}
  async cancelAlgoOrder(): Promise<void> {}
  async cancelAllOrders(): Promise<void> {}
  async cancelAllAlgoOrders(): Promise<void> {}
  async getUserTrades(): Promise<FuturesUserTrade[]> {
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
    variantExitRule: "tp1_full",
    fillMode: "taker",
    selectedLaneId: "CG_WIDE_FAST_SHORT",
    ...overrides,
  } as unknown as PaperOrder;
}

function makePaperStore(orders: PaperOrder[]): PaperStoreReader {
  return { all: orders, isAdmissionHalted: () => false };
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
    testnetRegimeHardCutMs: 0,
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

function makeEngine(opts: { recorder?: PositionPathRecorder; nowIso?: () => string; paper?: PaperStoreReader } = {}) {
  const client = new FakeLiveClient();
  const store = new LiveExecutionStore(tmp());
  const engine = new LiveExecutionEngine({
    config: makeConfig(),
    client: client as unknown as LivePrivateClient,
    store,
    paperStore: opts.paper ?? makePaperStore([]),
    nowIso: opts.nowIso ?? (() => "2099-01-02T12:00:00.000Z"),
    fillConfirmRetryDelayMs: 0,
    positionPathRecorder: opts.recorder,
  });
  return { engine, client, store };
}

describe("LiveExecutionEngine dense R-path hook (per-tick recordTick + close sweep)", () => {
  it("records one mark-R tick per engine tick for an OPEN intent, and the dense path survives the close", async () => {
    const dir = tmp();
    const recorder = new PositionPathRecorder(dir);
    let nowMs = Date.parse("2099-01-02T12:00:00.000Z");
    const { engine, client, store } = makeEngine({
      recorder,
      paper: makePaperStore([paperOrder()]),
      nowIso: () => new Date(nowMs).toISOString(),
    });
    expect((await engine.arm()).ok).toBe(true);

    await engine.tick(); // mirrors + opens (manageLifecycle ran before the intent existed — no tick yet)
    const intent = store.getState().intents[0]!;
    const key = `intent:${intent.paperOrderId}:${intent.createdAt}`;
    expect(recorder.getPath(key)).toBeNull();

    // Three management ticks with a moving mark — each records exactly one (tsMs, currentR) sample.
    const entry = intent.filledEntryPrice ?? intent.plannedEntryPrice;
    const risk = Math.abs(entry - intent.stopLossPrice);
    const marks = [2000, 1980, 1950];
    for (const mark of marks) {
      nowMs += 25_000;
      client.markPriceBySymbol.set("ETHUSDT", mark);
      await engine.tick();
    }
    const path = recorder.getPath(key)!;
    expect(recorder.isTrackingOpen(key)).toBe(true);
    expect(path.ticks).toHaveLength(3);
    expect(path.meta).toEqual({ laneId: "CG_WIDE_FAST_SHORT", symbol: "ETHUSDT", direction: "SHORT", source: "engine" });
    marks.forEach((mark, i) => {
      // SHORT: favorable when mark < entry — the exact formula manageMfeGiveback uses.
      expect(path.ticks[i]!.r).toBeCloseTo((entry - mark) / risk, 4);
    });
    for (let i = 1; i < path.ticks.length; i += 1) {
      expect(path.ticks[i]!.t - path.ticks[i - 1]!.t).toBe(25_000);
    }

    // Close via the standard tp1_full flow: TP1 fills the whole position → flat → settle. The
    // same tick's close sweep hands the path off to the closed buffer.
    nowMs += 25_000;
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: intent.tp1OrderId!, price: 1900, qty: intent.qty, realizedPnl: 5, commission: 0.04, commissionAsset: "USDT", time: 1 },
    ];
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(recorder.isTrackingOpen(key)).toBe(false);
    const closed = recorder.getPath(key)!;
    expect(closed.closedAtMs).toBe(nowMs);
    expect(closed.ticks).toHaveLength(3); // the dense path SURVIVED the close
    // finalR = NET realized R (realizedPnlUsd / effectiveRiskUsd) — the engine writer's convention.
    expect(closed.closeR).toBeCloseTo(4.96 / intent.effectiveRiskUsd!, 3);
    expect(recorder.listClosedPaths().filter((p) => p.key === key)).toHaveLength(1);

    // Idempotent: further ticks re-sweep the same CLOSED intent without duplicating the handoff.
    nowMs += 25_000;
    await engine.tick();
    expect(recorder.listClosedPaths().filter((p) => p.key === key)).toHaveLength(1);

    // Durable: a fresh recorder instance reloads the persisted closed path from disk, and the
    // dense reader adapter offers it as a REAL resolved trade for the Exit Brain.
    const reloaded = new PositionPathRecorder(dir);
    const trades = resolvedTradesFromRecordedPaths(reloaded.listClosedPaths());
    expect(trades).toHaveLength(1);
    expect(trades[0]!.tradeId).toBe(`pp:${key}`);
    expect(trades[0]!.ticks.length).toBeGreaterThanOrEqual(4); // 3 recorded + terminal close tick
  });

  it("no recorder wired (every pre-existing caller/test) → engine behaves byte-for-byte as before", async () => {
    let nowMs = Date.parse("2099-01-02T12:00:00.000Z");
    const { engine, client, store } = makeEngine({
      paper: makePaperStore([paperOrder()]),
      nowIso: () => new Date(nowMs).toISOString(),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    nowMs += 25_000;
    client.markPriceBySymbol.set("ETHUSDT", 1950);
    await engine.tick(); // the recordTick hook is a strict no-op without a recorder
    nowMs += 25_000;
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: intent.tp1OrderId!, price: 1900, qty: intent.qty, realizedPnl: 5, commission: 0.04, commissionAsset: "USDT", time: 1 },
    ];
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("CLOSED"); // open→manage→close fully unaffected
    expect(store.getState().intents[0]!.realizedPnlUsd).toBeCloseTo(4.96, 6);
  });

  it("a recorder whose every method THROWS cannot affect the trading tick (hard safety rule)", async () => {
    const hostile = new PositionPathRecorder(tmp());
    for (const method of ["recordTick", "markClosed", "isTrackingOpen", "pruneExpired", "flush"] as const) {
      (hostile as unknown as Record<string, unknown>)[method] = () => {
        throw new Error("hostile bookkeeping");
      };
    }
    let nowMs = Date.parse("2099-01-02T12:00:00.000Z");
    const { engine, client, store } = makeEngine({
      recorder: hostile,
      paper: makePaperStore([paperOrder()]),
      nowIso: () => new Date(nowMs).toISOString(),
    });
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = store.getState().intents[0]!;
    nowMs += 25_000;
    client.markPriceBySymbol.set("ETHUSDT", 1950);
    await engine.tick();
    expect(engine.getStatus().health.lastTickError).toBeNull(); // the throw never reached the tick
    nowMs += 25_000;
    client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
    client.positionsBySymbol.set("ETHUSDT", 0);
    client.trades = [
      { symbol: "ETHUSDT", orderId: intent.tp1OrderId!, price: 1900, qty: intent.qty, realizedPnl: 5, commission: 0.04, commissionAsset: "USDT", time: 1 },
    ];
    await engine.tick();
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(engine.getStatus().health.lastTickError).toBeNull();
  });
});

// ── single-symbol executor integration ───────────────────────────────────────

/** Minimal SingleSymbolExecClient fake (modeled on single-symbol-lane-executor.test.ts's):
 *  entries fill at a configured price, algo stops REST by default (never spuriously "triggered"). */
class FakeExecClient implements SingleSymbolExecClient {
  placed: PlaceOrderParams[] = [];
  markPriceBySymbol = new Map<string, number>();
  positionAmtBySymbol = new Map<string, number>();
  fillPriceBySymbol = new Map<string, number>();
  private orderSeq = 100;
  private algoSeq = 900;

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    return new Map([["ETHUSDT", { symbol: "ETHUSDT", stepSize: 0.01, minQty: 0.01, tickSize: 0.01, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 }]]);
  }
  async setLeverage(): Promise<void> {}
  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    const symbols = new Set([...this.markPriceBySymbol.keys(), ...this.positionAmtBySymbol.keys()]);
    const entries = Array.from(symbols).map((sym) => ({
      symbol: sym,
      positionAmt: this.positionAmtBySymbol.get(sym) ?? 0,
      entryPrice: 0,
      markPrice: this.markPriceBySymbol.get(sym) ?? 0,
      liquidationPrice: 0,
      unRealizedProfit: 0,
      leverage: 3,
      marginType: "ISOLATED" as const,
    }));
    return symbol ? entries.filter((p) => p.symbol === symbol) : entries;
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    this.placed.push(params);
    const orderId = String(this.orderSeq++);
    if (!params.reduceOnly) this.positionAmtBySymbol.set(params.symbol, (params.side === "BUY" ? 1 : -1) * params.quantity);
    else this.positionAmtBySymbol.set(params.symbol, 0);
    const avgPrice = this.fillPriceBySymbol.get(params.symbol) ?? 0;
    return {
      symbol: params.symbol,
      orderId,
      clientOrderId: "",
      status: avgPrice > 0 ? "FILLED" : "NEW",
      type: "MARKET",
      side: params.side,
      reduceOnly: Boolean(params.reduceOnly),
      price: 0,
      stopPrice: 0,
      origQty: params.quantity,
      executedQty: avgPrice > 0 ? params.quantity : 0,
      avgPrice,
      updateTime: 0,
    };
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    const avgPrice = this.fillPriceBySymbol.get(symbol) ?? 0;
    return {
      symbol,
      orderId,
      clientOrderId: "",
      status: avgPrice > 0 ? "FILLED" : "NEW",
      type: "MARKET",
      side: "BUY",
      reduceOnly: false,
      price: 0,
      stopPrice: 0,
      origQty: 0,
      executedQty: 0,
      avgPrice,
      updateTime: 0,
    };
  }
  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    const algoId = String(this.algoSeq++);
    return {
      symbol: params.symbol,
      algoId,
      clientAlgoId: params.clientAlgoId ?? "",
      algoStatus: "WORKING",
      orderType: params.type,
      side: params.side,
      quantity: params.quantity,
      triggerPrice: params.triggerPrice,
      actualOrderId: null,
    };
  }
  async queryAlgoOrder(algoId: string): Promise<FuturesAlgoOrder> {
    return {
      symbol: "ETHUSDT",
      algoId,
      clientAlgoId: "",
      algoStatus: "WORKING",
      orderType: "STOP_MARKET",
      side: "SELL",
      quantity: 0,
      triggerPrice: 0,
      actualOrderId: null, // still resting — never spuriously triggered
    };
  }
  async cancelAlgoOrder(): Promise<void> {}
  async getUserTrades(): Promise<FuturesUserTrade[]> {
    return [];
  }
}

describe("SingleSymbolLaneExecutor dense R-path hook", () => {
  it("records one mark-R tick per executor tick and marks the path closed at close finalization", async () => {
    const recorder = new PositionPathRecorder(tmp());
    let nowMs = Date.parse("2026-07-22T12:00:00.000Z");
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("ETHUSDT", 2000);
    const signals: SingleSymbolFreshSignal[] = [
      { observationId: "ce:ETHUSDT:1", symbol: "ETHUSDT", entryPrice: 2000, stopPrice: 1900, openedAtMs: nowMs - 5_000 },
    ];
    const store = new SingleSymbolLaneExecutorStore(tmp(), "test.json");
    const executor = new SingleSymbolLaneExecutor({
      client,
      store,
      laneId: "COMPOSITE_ESTIMATOR_WIDE_LONG",
      direction: "LONG",
      getOpenSignals: () => signals,
      exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 5, maxHoldMs: 48 * 3_600_000 }),
      isAllowed: () => true,
      positionPathRecorder: recorder,
      legUsd: () => 200,
      leverage: () => 3,
      maxOpenPositions: () => 1,
      nowIso: () => new Date(nowMs).toISOString(),
      fillConfirmRetryDelayMs: 0,
    });

    await executor.tick(); // opens (monitorOpenPositions ran before the position existed)
    const pos = store.getState().positions.find((p) => p.status === "OPEN")!;
    const key = `ssle:COMPOSITE_ESTIMATOR_WIDE_LONG:${pos.positionId}`;
    expect(recorder.getPath(key)).toBeNull();

    const marks = [2010, 2030, 2050];
    for (const mark of marks) {
      nowMs += 30_000;
      client.markPriceBySymbol.set("ETHUSDT", mark);
      await executor.tick();
    }
    const path = recorder.getPath(key)!;
    expect(path.ticks).toHaveLength(3);
    expect(path.meta).toEqual({ laneId: "COMPOSITE_ESTIMATOR_WIDE_LONG", symbol: "ETHUSDT", direction: "LONG", source: "executor" });
    marks.forEach((mark, i) => {
      expect(path.ticks[i]!.r).toBeCloseTo((mark - 2000) / 100, 4); // LONG favorableR, risk = 100
    });

    nowMs += 30_000;
    const result = await executor.manualClosePosition(pos.positionId);
    expect(result.ok).toBe(true);
    expect(recorder.isTrackingOpen(key)).toBe(false);
    const closed = recorder.getPath(key)!;
    expect(closed.closedAtMs).toBe(nowMs);
    expect(closed.ticks).toHaveLength(3);
    // finalR = RAW mark-R at the recorded exit price (2000 fill ⇒ 0R) — the executor convention.
    expect(closed.closeR).toBeCloseTo(0, 6);
    expect(recorder.listClosedPaths().some((p) => p.key === key)).toBe(true);
  });

  it("no recorder wired → executor behaves byte-for-byte as before (open + close unaffected)", async () => {
    let nowMs = Date.parse("2026-07-22T12:00:00.000Z");
    const client = new FakeExecClient();
    client.fillPriceBySymbol.set("ETHUSDT", 2000);
    const signals: SingleSymbolFreshSignal[] = [
      { observationId: "ce:ETHUSDT:1", symbol: "ETHUSDT", entryPrice: 2000, stopPrice: 1900, openedAtMs: nowMs - 5_000 },
    ];
    const store = new SingleSymbolLaneExecutorStore(tmp(), "test.json");
    const executor = new SingleSymbolLaneExecutor({
      client,
      store,
      laneId: "COMPOSITE_ESTIMATOR_WIDE_LONG",
      direction: "LONG",
      getOpenSignals: () => signals,
      exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 5, maxHoldMs: 48 * 3_600_000 }),
      isAllowed: () => true,
      legUsd: () => 200,
      leverage: () => 3,
      maxOpenPositions: () => 1,
      nowIso: () => new Date(nowMs).toISOString(),
      fillConfirmRetryDelayMs: 0,
    });
    await executor.tick();
    const pos = store.getState().positions.find((p) => p.status === "OPEN")!;
    nowMs += 30_000;
    client.markPriceBySymbol.set("ETHUSDT", 2030);
    await executor.tick();
    const result = await executor.manualClosePosition(pos.positionId);
    expect(result.ok).toBe(true);
    expect(store.getState().positions[0]!.status).toBe("CLOSED");
  });
});

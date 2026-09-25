/**
 * ACCOUNT EXPOSURE COORDINATOR — INTEGRATION / CONCURRENCY / RESTART TESTS (2026-08-04, test stage).
 *
 * Everything in account-exposure-coordinator.test.ts (45 tests) exercises the coordinator's own
 * capacity math in isolation, against FAKE executor stand-ins (getStatus()-shaped objects, not real
 * classes). Everything added to single-symbol-lane-executor.test.ts / cross-sectional-executor.test.ts
 * in the wiring stage proves the WIRING call points/data using a FAKE reservation ledger
 * (makeFakeReservationLedger), not the real coordinator.
 *
 * This file is the missing third leg: the REAL AccountExposureCoordinator, wired into REAL
 * SingleSymbolLaneExecutor / CrossSectionalExecutor instances, driven through real tick() calls,
 * with a controllable ("gated") fake exchange client so two executors' async chains can be forced
 * to genuinely overlap in time — the only way to prove "concurrent executors cannot spend the same
 * capacity" is a real property of the shipped code, not an artifact of a simplified test double.
 *
 * Three sections:
 *   A. Deterministic concurrency — two (or three) real executors racing for the same/adjacent
 *      capacity via a gate that holds one executor's placeOrder() mid-flight while a sibling's own
 *      tick() runs to completion.
 *   B. Restart / reconciliation — a real executor's tick() is abandoned mid-order (the gate is
 *      simply never released, modeling a process crash), then a BRAND NEW coordinator/store pair
 *      re-reads the same on-disk ledger file ("restart") and reconciles it.
 *   C. Other required proofs — manual/external exposure folded into a real executor's real
 *      admission decision; exits/reductions/protective stops proven to never touch reserveExposure.
 *
 * Every coordinator constructed here explicitly sets EVERY capacity axis to 0 (disabled) unless a
 * test opts a specific axis in — same convention account-exposure-coordinator.test.ts's own
 * makeCoordinator() helper uses, so no test can accidentally depend on a production default (or an
 * environment variable) it never asked for.
 */
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import {
  AccountExposureCoordinator,
  AccountExposureReservationStore,
  type AccountExposureCoordinatorOptions,
  type ExposureReserveCampaignCap,
  type ExposureReserveRequest,
  type ExposureReserveResult,
} from "../src/lib/account-exposure-coordinator.js";
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
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type SingleSymbolExecClient,
  type SingleSymbolFreshSignal,
  type SingleSymbolPosition,
} from "../src/lib/single-symbol-lane-executor.js";
import {
  CrossSectionalExecutor,
  CrossSectionalExecutorStore,
  type CrossSectionalExecClient,
  type ExecutorBasket,
} from "../src/lib/cross-sectional-executor.js";
import {
  CrossSectionalStore,
  _resetCrossSectionalStoreForTests,
  type CrossSectionalObservation,
} from "../src/lib/cross-sectional-edge.js";

const NOW = "2026-08-04T03:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

// ─── tmpdir plumbing (same convention as every other executor test file) ────────────────────────
const dirs: string[] = [];
let n = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `aeci-${process.pid}-${++n}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  _resetCrossSectionalStoreForTests();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  dirs.length = 0;
});

// ─── controllable "gate" — lets a test hold a real executor's placeOrder() mid-flight ───────────

function makeGate(): { promise: Promise<void>; resolve: () => void; reachedPromise: Promise<void>; markReached: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  let markReached!: () => void;
  const reachedPromise = new Promise<void>((res) => {
    markReached = res;
  });
  return { promise, resolve, reachedPromise, markReached };
}

// ─── shared fake exchange client — satisfies BOTH executor classes' client interfaces ───────────

/**
 * One client shared by both SingleSymbolLaneExecutor and CrossSectionalExecutor tests in this file.
 * `entryGates` is the concurrency-forcing mechanism: an ENTRY (non-reduceOnly) placeOrder() call for
 * a gated symbol marks that gate "reached" (so a test awaiting `reachedPromise` knows execution has
 * paused exactly there — reservation already taken, order not yet placed/committed/released) and
 * then awaits the gate's own promise before proceeding. reduceOnly (exit/reduction/protective-close)
 * orders are NEVER gated and NEVER consult any fail-flag below — see section C's tests, which prove
 * this structurally (the coordinator is never even consulted on that path).
 */
class RaceClient implements SingleSymbolExecClient, CrossSectionalExecClient {
  placed: PlaceOrderParams[] = [];
  algosPlaced: PlaceAlgoOrderParams[] = [];
  fillPriceBySymbol = new Map<string, number>();
  markPriceBySymbol = new Map<string, number>();
  positionAmtBySymbol = new Map<string, number>();
  partialFillQtyBySymbol = new Map<string, number>();
  algoTriggeredOrderId = new Map<string, string | null>();
  entryGates = new Map<string, ReturnType<typeof makeGate>>();
  /** Plain, ambiguous-shaped Error — models a network blip / unknown-outcome failure. */
  failOnSymbol: string | null = null;
  /** Real BinanceFuturesPrivateError, failureType "binance_error" — an UNAMBIGUOUS in-band rejection. */
  failOnSymbolWithBinanceError: string | null = null;
  /** Real BinanceFuturesPrivateError, failureType "timeout" — an AMBIGUOUS failure by construction
   *  (binance-futures-private.ts's own header: "double-submit is worse than a missed attempt"). */
  failOnSymbolWithTimeout: string | null = null;
  private orderSeq = 100;
  private algoSeq = 900;

  private buildOrder(symbol: string, side: "BUY" | "SELL", quantity: number, reduceOnly: boolean | undefined, orderId: string, avgPrice: number): FuturesOrder {
    const partial = this.partialFillQtyBySymbol.get(symbol);
    const executedQty = avgPrice > 0 ? (partial !== undefined ? Math.min(partial, quantity) : quantity) : 0;
    return {
      symbol, orderId, clientOrderId: "", status: avgPrice > 0 ? "FILLED" : "NEW", type: "MARKET", side,
      reduceOnly: Boolean(reduceOnly), price: 0, stopPrice: 0, origQty: quantity, executedQty, avgPrice, updateTime: 0,
    };
  }

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    const f = (stepSize: number, minQty: number): FuturesSymbolFilters =>
      ({ symbol: "X", stepSize, minQty, tickSize: 0.0001, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 });
    return new Map([
      ["BTCUSDT", f(0.001, 0.001)],
      ["ETHUSDT", f(0.001, 0.001)],
      ["SOLUSDT", f(0.01, 0.01)],
      ["AVAXUSDT", f(0.01, 0.01)],
      ["NEARUSDT", f(0.01, 0.01)],
      ["DOGEUSDT", f(1, 1)],
    ]);
  }
  async setLeverage(): Promise<void> {
    /* no-op */
  }
  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    const symbols = new Set([...this.markPriceBySymbol.keys(), ...this.positionAmtBySymbol.keys()]);
    const entries: FuturesPosition[] = Array.from(symbols).map((sym) => ({
      symbol: sym, positionAmt: this.positionAmtBySymbol.get(sym) ?? 0, entryPrice: 0,
      markPrice: this.markPriceBySymbol.get(sym) ?? 0, liquidationPrice: 0, unRealizedProfit: 0, leverage: 3, marginType: "ISOLATED",
    }));
    return symbol ? entries.filter((p) => p.symbol === symbol) : entries;
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    const gate = !params.reduceOnly ? this.entryGates.get(params.symbol) : undefined;
    if (gate) {
      gate.markReached();
      await gate.promise;
    }
    if (!params.reduceOnly && this.failOnSymbolWithBinanceError === params.symbol) {
      throw new BinanceFuturesPrivateError("binance_error", "Binance error HTTP 400 code -2019: Margin is insufficient.", {
        httpStatus: 400,
        binanceCode: -2019,
      });
    }
    if (!params.reduceOnly && this.failOnSymbolWithTimeout === params.symbol) {
      throw new BinanceFuturesPrivateError("timeout", "Request timed out after 6000ms waiting for Binance", {});
    }
    if (!params.reduceOnly && this.failOnSymbol === params.symbol) throw new Error(`exchange rejected ${params.symbol}`);
    this.placed.push(params);
    const orderId = String(this.orderSeq++);
    const avgPrice = this.fillPriceBySymbol.get(params.symbol) ?? 0;
    return this.buildOrder(params.symbol, params.side, params.quantity, params.reduceOnly, orderId, avgPrice);
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    return this.buildOrder(symbol, "BUY", 0, false, orderId, 0);
  }
  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    this.algosPlaced.push(params);
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
      symbol: "X", algoId, clientAlgoId: "", algoStatus: actualOrderId !== null ? "EXECUTED" : "WORKING",
      orderType: "STOP_MARKET", side: "BUY", quantity: 0, triggerPrice: 0, actualOrderId,
    };
  }
  async cancelAlgoOrder(): Promise<void> {
    /* no-op */
  }
  async getUserTrades(_symbol: string, _opts: { startTime?: number; limit?: number } = {}): Promise<FuturesUserTrade[]> {
    return [];
  }
}

// ─── coordinator helper — every axis defaults to 0 (disabled), matching account-exposure- ───────
// ─── coordinator.test.ts's OWN makeCoordinator convention exactly ───────────────────────────────

function makeCoordinator(opts: {
  dataDir: string;
  store?: AccountExposureReservationStore;
  singleSymbol?: () => ReadonlyArray<SingleSymbolLaneExecutor | null>;
  crossSectional?: () => ReadonlyArray<CrossSectionalExecutor | null>;
  nowIso?: () => string;
  maxGross?: number;
  maxLong?: number;
  maxShort?: number;
  maxPerSymbol?: number;
  maxCluster?: number;
  maxConcurrent?: number;
  staleMs?: number;
  queryOrderByClientId?: AccountExposureCoordinatorOptions["queryOrderByClientId"];
}): AccountExposureCoordinator {
  return new AccountExposureCoordinator({
    store: opts.store ?? new AccountExposureReservationStore(opts.dataDir),
    getSingleSymbolExecutors: opts.singleSymbol ?? (() => []),
    getCrossSectionalExecutors: opts.crossSectional ?? (() => []),
    nowIso: opts.nowIso ?? (() => NOW),
    maxGrossExposureUsd: () => opts.maxGross ?? 0,
    maxLongExposureUsd: () => opts.maxLong ?? 0,
    maxShortExposureUsd: () => opts.maxShort ?? 0,
    maxNotionalPerSymbolUsd: () => opts.maxPerSymbol ?? 0,
    maxClusterPositions: () => opts.maxCluster ?? 0,
    maxConcurrentPositionsAcrossAccount: () => opts.maxConcurrent ?? 0,
    reservationStaleMs: () => opts.staleMs ?? 30_000,
    queryOrderByClientId: opts.queryOrderByClientId,
  });
}

type SharedReservationFns = {
  reserveExposure: (req: ExposureReserveRequest) => ExposureReserveResult;
  commitExposureReservation: (reservationId: string, filled: { qty: number; avgPrice: number }) => void;
  releaseExposureReservation: (reservationId: string, reason: string) => void;
};
function reservationFnsOf(coordinator: AccountExposureCoordinator): SharedReservationFns {
  return {
    reserveExposure: coordinator.reserve.bind(coordinator),
    commitExposureReservation: coordinator.commitReservation.bind(coordinator),
    releaseExposureReservation: coordinator.releaseReservation.bind(coordinator),
  };
}

// ─── SingleSymbolLaneExecutor fixture helper ────────────────────────────────────────────────────

function ssSignal(symbol: string, over: Partial<SingleSymbolFreshSignal> = {}): SingleSymbolFreshSignal {
  return {
    observationId: `sf:${symbol}:1`,
    symbol,
    entryPrice: 100,
    stopPrice: 90, // LONG-oriented default: stop below entry
    openedAtMs: NOW_MS - 5 * 60_000,
    ...over,
  };
}

function makeSSExecutor(opts: {
  client: SingleSymbolExecClient;
  laneId: string;
  symbol: string;
  direction?: "LONG" | "SHORT";
  legUsd?: number;
  laneWeightPct?: number;
  nowIso?: () => string;
} & Partial<SharedReservationFns>): SingleSymbolLaneExecutor {
  const storeDir = tmpDir();
  const store = new SingleSymbolLaneExecutorStore(storeDir, "lane.json");
  const direction = opts.direction ?? "LONG";
  const sig = ssSignal(opts.symbol, { stopPrice: direction === "LONG" ? 90 : 110 });
  return new SingleSymbolLaneExecutor({
    client: opts.client,
    store,
    laneId: opts.laneId,
    direction,
    getOpenSignals: () => [sig],
    exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
    isAllowed: () => true,
    laneWeightPct: () => opts.laneWeightPct ?? 100,
    legUsd: () => opts.legUsd ?? 100,
    leverage: () => 3,
    nowIso: opts.nowIso ?? (() => NOW),
    fillConfirmRetryDelayMs: 0,
    ...(opts.reserveExposure ? { reserveExposure: opts.reserveExposure } : {}),
    ...(opts.commitExposureReservation ? { commitExposureReservation: opts.commitExposureReservation } : {}),
    ...(opts.releaseExposureReservation ? { releaseExposureReservation: opts.releaseExposureReservation } : {}),
  });
}

function seedOpenPosition(over: Partial<SingleSymbolPosition> = {}): SingleSymbolPosition {
  return {
    positionId: "seed-1", sourceObservationId: "seed-1", symbol: "BTCUSDT", direction: "LONG",
    qty: 1, entryPrice: 100, entryOrderId: "1", entryPriceConfirmed: true, stopPrice: 90,
    stopAlgoOrderId: "900", stopFailureCount: 0, stopUnprotectedSinceIso: null, closeFailureCount: 0,
    closeFailureSinceIso: null, peakFavorableR: 0, openedAt: NOW, status: "OPEN", closedAt: null,
    closeReason: null, exitPrice: null, exitOrderId: null, exitPriceConfirmed: false,
    grossPnlUsd: null, feeEstimateUsd: 0, netPnlUsd: null,
    ...over,
  };
}

// ─── CrossSectionalExecutor fixture helper ──────────────────────────────────────────────────────

function xsecSignal(openedAtMs: number, over: Partial<CrossSectionalObservation> = {}): CrossSectionalObservation {
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
    grossReturn: null, costReturn: null, netReturn: null, longLegReturn: null, shortLegReturn: null, resolvedAt: null,
    ...over,
  };
}

function seedOpenBasket(basketId: string, symbol: string, closesAtMs: number): ExecutorBasket {
  return {
    basketId, sourceObservationId: `manual:${basketId}`, signal: "MOM24_FILTERED", variant: "FILTERED",
    openedAt: NOW, closesAtMs,
    legs: [{ symbol, side: "LONG", qty: 10, entryPrice: 1, entryOrderId: `entry-${basketId}`, entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null }],
    // "OPEN" pre-dates cross-sectional-executor.ts's richer status enum (RESERVED/PLACING/
    // PARTIALLY_FILLED/COMPLETE/CLOSED/ABORTED) — this fixture represents a normal, fully-filled,
    // healthy basket (what "OPEN" always meant for a one-leg-seeded fixture like this one), which is
    // "COMPLETE" under the new enum. Real close paths (closeDueBaskets/closeBasketsHittingProfitTarget)
    // now gate strictly on COMPLETE, so this must match or this fixture silently stops being closeable.
    status: "COMPLETE", closedAt: null, closeReason: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// SECTION A — DETERMINISTIC CONCURRENCY (real executors, real coordinator, a controllable gate)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("A. Deterministic concurrency — real executors racing a real AccountExposureCoordinator", () => {
  it("[A1] two DIFFERENT lanes racing the SAME symbol: exactly one reserve() succeeds, per-symbol exposure never doubles", async () => {
    // Every capacity axis (gross/long/short/perSymbol/cluster/concurrent) is left at 0 = DISABLED
    // here on purpose — this isolates gate 1 (single-flight-per-symbol), which is UNCONDITIONAL and
    // fires regardless of any numeric cap. Neither lane shares a tryClaimEntrySymbol Set (each
    // defaults to the no-op `() => true`), so the ONLY thing that can block a same-symbol double
    // entry in this test is the coordinator's own gate — proving it is a real, independent
    // protection, not an artifact of the pre-existing entrySymbolsInFlight mechanism.
    const client = new RaceClient();
    client.fillPriceBySymbol.set("BTCUSDT", 100);
    const gate = makeGate();
    client.entryGates.set("BTCUSDT", gate);

    let lanes: Array<SingleSymbolLaneExecutor | null> = [null, null];
    const coordinator = makeCoordinator({ dataDir: tmpDir(), singleSymbol: () => lanes });
    const shared = reservationFnsOf(coordinator);
    const execA = makeSSExecutor({ client, laneId: "LANE_A", symbol: "BTCUSDT", legUsd: 100, ...shared });
    const execB = makeSSExecutor({ client, laneId: "LANE_B", symbol: "BTCUSDT", legUsd: 100, ...shared });
    lanes = [execA, execB];

    const tickA = execA.tick(); // starts, reserves BTCUSDT, pauses inside placeOrder
    await gate.reachedPromise;
    expect(client.placed).toHaveLength(0); // A hasn't been released to actually place its order yet

    await execB.tick(); // runs to completion WHILE A's reservation is still outstanding (RESERVED)

    expect(client.placed).toHaveLength(0); // B never reached placeOrder at all
    expect(execB.getStatus().lastEntrySkipReason).toMatch(/already in flight/);

    gate.resolve();
    await tickA;

    expect(client.placed).toHaveLength(1);
    expect(client.placed[0]!.symbol).toBe("BTCUSDT");
    expect(execA.getStatus().openPositions).toHaveLength(1);
    expect(execB.getStatus().openPositions).toHaveLength(0);
    // Never $200 (both lanes' $100 legUsd) — exactly one lane's worth.
    expect(coordinator.getSymbolExposureUsd("BTCUSDT")).toBeCloseTo(100, 6);
    // Protective stop still placed normally for the lane that DID get in — the coordinator gates
    // ENTRY orders only, never the algo/stop path (a completely separate client method).
    expect(client.algosPlaced).toHaveLength(1);
  });

  it("[A2] two DIFFERENT symbols in the SAME correlation cluster racing concurrently: the cluster cap is enforced across concurrent callers, not just sequential ones", async () => {
    const client = new RaceClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("AVAXUSDT", 100);
    const gate = makeGate();
    client.entryGates.set("SOLUSDT", gate);

    let lanes: Array<SingleSymbolLaneExecutor | null> = [null, null];
    const coordinator = makeCoordinator({ dataDir: tmpDir(), singleSymbol: () => lanes, maxCluster: 1 });
    const shared = reservationFnsOf(coordinator);
    const execSol = makeSSExecutor({ client, laneId: "LANE_SOL", symbol: "SOLUSDT", legUsd: 100, ...shared });
    const execAvax = makeSSExecutor({ client, laneId: "LANE_AVAX", symbol: "AVAXUSDT", legUsd: 100, ...shared });
    lanes = [execSol, execAvax];

    const tickSol = execSol.tick();
    await gate.reachedPromise; // SOLUSDT is RESERVED (L1 cluster, LONG) — no order placed yet

    await execAvax.tick(); // a DIFFERENT symbol — gate 1 (single-flight) does NOT block this;
    // only the cluster cap can, and this proves it does so WHILE the sibling is merely in-flight.

    expect(client.placed).toHaveLength(0);
    expect(execAvax.getStatus().lastEntrySkipReason).toMatch(/correlation-cluster cap/);

    gate.resolve();
    await tickSol;

    expect(client.placed).toHaveLength(1);
    expect(client.placed[0]!.symbol).toBe("SOLUSDT");
    expect(coordinator.getClusterOpenSymbols("SOLUSDT", "LONG")).toEqual(["SOLUSDT"]);
  });

  it("[A3] three lanes each configured at their own full ('100%') allocation, racing concurrently on different symbols: the account-wide gross+directional cap stops oversubscription regardless of how many lanes think they're entitled to 100%", async () => {
    const client = new RaceClient();
    for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) client.fillPriceBySymbol.set(s, 100);
    const gate = makeGate();
    client.entryGates.set("BTCUSDT", gate);

    let lanes: Array<SingleSymbolLaneExecutor | null> = [null, null, null];
    // maxGross AND maxLong both capped at 150: a single $100 lane fits, a second $100 lane never
    // does (100+100=200>150) — per-symbol/cluster are left disabled so ONLY the account-wide
    // gross/directional axis is under test here (BTC/ETH are MAJORS anyway; SOL is the lone L1
    // symbol, nowhere near a cluster cap even if one were set).
    const coordinator = makeCoordinator({ dataDir: tmpDir(), singleSymbol: () => lanes, maxGross: 150, maxLong: 150 });
    const shared = reservationFnsOf(coordinator);
    const execA = makeSSExecutor({ client, laneId: "LANE_100PCT_A", symbol: "BTCUSDT", legUsd: 100, laneWeightPct: 100, ...shared });
    const execB = makeSSExecutor({ client, laneId: "LANE_100PCT_B", symbol: "ETHUSDT", legUsd: 100, laneWeightPct: 100, ...shared });
    const execC = makeSSExecutor({ client, laneId: "LANE_100PCT_C", symbol: "SOLUSDT", legUsd: 100, laneWeightPct: 100, ...shared });
    lanes = [execA, execB, execC];

    const tickA = execA.tick();
    await gate.reachedPromise; // A holds $100 of gross/LONG capacity, RESERVED, not yet committed

    await execB.tick();
    await execC.tick();

    expect(client.placed).toHaveLength(0); // neither B nor C ever reached placeOrder
    expect(execB.getStatus().lastEntrySkipReason).toMatch(/gross exposure cap|LONG exposure cap/);
    expect(execC.getStatus().lastEntrySkipReason).toMatch(/gross exposure cap|LONG exposure cap/);

    gate.resolve();
    await tickA;

    expect(client.placed).toHaveLength(1); // exactly ONE of the three "100%" lanes ever got in
    expect(coordinator.getStatus().grossUsd).toBeCloseTo(100, 6); // never 200 or 300

    // Retrying B/C AFTER A's reservation has settled into a real COMMITTED position proves the cap
    // holds continuously, not just during the brief RESERVED window.
    await execB.tick();
    await execC.tick();
    expect(client.placed).toHaveLength(1);
  });

  it("[A4] a CrossSectionalExecutor basket leg and a SingleSymbolLaneExecutor entry share the SAME account-wide cluster-capacity pool — a basket leg (even merely in-flight) blocks a correlated single-symbol entry, and continues to block it once committed", async () => {
    const client = new RaceClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    client.fillPriceBySymbol.set("AVAXUSDT", 100);
    const gate = makeGate();
    client.entryGates.set("SOLUSDT", gate); // the basket's LONG leg, sized+placed first

    const xsecSignalStore = new CrossSectionalStore(tmpDir());
    xsecSignalStore.add(xsecSignal(NOW_MS - 5 * 60_000));
    const xsecStore = new CrossSectionalExecutorStore(tmpDir());
    xsecStore.getState().lastSeenSignalMs = NOW_MS - 3_600_000;

    let xsecExecs: Array<CrossSectionalExecutor | null> = [null];
    let ssExecs: Array<SingleSymbolLaneExecutor | null> = [null];
    const coordinator = makeCoordinator({
      dataDir: tmpDir(),
      singleSymbol: () => ssExecs,
      crossSectional: () => xsecExecs,
      maxCluster: 1,
    });
    const shared = reservationFnsOf(coordinator);

    const xsecExec = new CrossSectionalExecutor({
      client, signalStore: xsecSignalStore, store: xsecStore, isAllowed: () => true,
      laneWeightPct: () => 100, legUsd: () => 100, nowIso: () => NOW, fillConfirmRetryDelayMs: 0,
      ...shared,
    });
    xsecExecs = [xsecExec];
    const avaxExec = makeSSExecutor({ client, laneId: "LANE_AVAX", symbol: "AVAXUSDT", legUsd: 100, ...shared });
    ssExecs = [avaxExec];

    const basketTick = xsecExec.tick();
    await gate.reachedPromise;
    // At this instant BOTH legs (SOL long, DOGE short) are already RESERVED — the sizing loop
    // reserves every leg synchronously, with no await between them, before the placement loop (the
    // one currently paused on SOL) ever begins. Only SOL (L1) matters for this cluster check.

    await avaxExec.tick(); // AVAXUSDT is a DIFFERENT symbol in the SAME L1 cluster as SOLUSDT

    expect(client.placed.some((p) => p.symbol === "AVAXUSDT")).toBe(false);
    expect(avaxExec.getStatus().lastEntrySkipReason).toMatch(/correlation-cluster cap/);

    gate.resolve();
    await basketTick;

    // "OPEN" pre-dates the richer status enum (see seedOpenBasket's own comment) — this asserts the
    // SAME outcome as before (a normal, fully successful basket open), just spelled COMPLETE now.
    expect(xsecStore.getState().baskets[0]!.status).toBe("COMPLETE");
    expect(client.placed.some((p) => p.symbol === "SOLUSDT")).toBe(true);
    expect(client.placed.some((p) => p.symbol === "DOGEUSDT")).toBe(true);

    // Continuity proof: now that the basket's SOL leg has moved from a RESERVED reservation (S5) to
    // a real, COMMITTED open basket leg (S2), the SAME cluster slot is still occupied — a fresh tick
    // on the single-symbol executor (its own attempted-dedup never fired, since a capacity rejection
    // is transient, not a permanent blacklist) is STILL rejected, now via S2 instead of S5.
    await avaxExec.tick();
    expect(client.placed.some((p) => p.symbol === "AVAXUSDT")).toBe(false);
    expect(coordinator.getClusterOpenSymbols("SOLUSDT", "LONG")).toEqual(["SOLUSDT"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// SECTION B — RESTART / RECONCILIATION (real executor creates the reservation; a crash is
// simulated by simply never releasing the gate; a brand-new coordinator/store re-reads the file)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Reproduces the EXACT "old bug" shape (ground truth #5): attempted.add(observationId) is
 * persisted BEFORE placeOrder() resolves, so a crash between those two points is, under the OLD
 * code, invisible forever (the signal is never retried AND nothing records whether the order
 * filled). Drives one REAL SingleSymbolLaneExecutor tick() and pauses it — via the gate — exactly
 * inside placeOrder(), then simply never resolves the gate: the tick's own promise is deliberately
 * abandoned (never awaited to completion), modeling the process dying mid-request. Returns
 * everything needed to inspect the stuck state and construct a "restarted" coordinator/store
 * against the same on-disk ledger file.
 */
async function simulateCrashedEntry(opts: { symbol: string; laneId: string }): Promise<{
  coordDir: string;
  posStoreDir: string;
  clientOrderIdUsed: string;
}> {
  const client = new RaceClient();
  client.fillPriceBySymbol.set(opts.symbol, 100);
  const gate = makeGate();
  client.entryGates.set(opts.symbol, gate);

  const posStoreDir = tmpDir();
  const posStore = new SingleSymbolLaneExecutorStore(posStoreDir, "lane.json");
  const coordDir = tmpDir();
  const coordStore = new AccountExposureReservationStore(coordDir);
  let liveExec: SingleSymbolLaneExecutor | null = null;
  const liveCoordinator = makeCoordinator({ dataDir: coordDir, store: coordStore, singleSymbol: () => [liveExec] });
  liveExec = new SingleSymbolLaneExecutor({
    client, store: posStore, laneId: opts.laneId, direction: "LONG",
    getOpenSignals: () => [ssSignal(opts.symbol)],
    exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
    isAllowed: () => true, laneWeightPct: () => 100, legUsd: () => 100, leverage: () => 3,
    nowIso: () => NOW, fillConfirmRetryDelayMs: 0,
    ...reservationFnsOf(liveCoordinator),
  });

  // Deliberately NOT awaited to completion, and the gate is deliberately never resolved anywhere in
  // this helper — see this function's own doc comment. Vitest does not treat a dangling, never-
  // rejecting Promise as a leaked resource (no timer/socket/file handle is held open by it).
  void liveExec.tick();
  await gate.reachedPromise;

  // OLD-bug shape, confirmed still present and UNCHANGED by this workstream (out of scope — see
  // account-exposure-coordinator.ts's own header comment): the observationId is already persisted
  // as attempted, and no position record exists (placeOrder never returned).
  const midCrashPositions = new SingleSymbolLaneExecutorStore(posStoreDir, "lane.json").getState();
  expect(midCrashPositions.attemptedObservationIds).toContain(`sf:${opts.symbol}:1`);
  expect(midCrashPositions.positions).toHaveLength(0);

  // NEW protection: a RESERVED row exists, persisted, for this exact attempt.
  const midCrashLedger = new AccountExposureReservationStore(coordDir).getState();
  expect(midCrashLedger.reservations).toHaveLength(1);
  expect(midCrashLedger.reservations[0]!.status).toBe("RESERVED");
  expect(midCrashLedger.reservations[0]!.symbol).toBe(opts.symbol);

  return { coordDir, posStoreDir, clientOrderIdUsed: midCrashLedger.reservations[0]!.clientOrderId };
}

describe("B. Restart / reconciliation — a real executor's crashed reservation survives and resolves correctly", () => {
  it("[B1 + bug-fix proof] a reservation left RESERVED by a simulated crash reconciles to COMMITTED once a fresh coordinator confirms the order actually filled — the reservation mechanism, unlike the old attempted-watermark alone, no longer silently abandons a possibly-filled order", async () => {
    const symbol = "BTCUSDT";
    const { coordDir, posStoreDir } = await simulateCrashedEntry({ symbol, laneId: "LANE_CRASH_FILLED" });

    // "restart": the old process (and its executor/coordinator instances) is gone. A brand-new
    // coordinator, with NO executors alive to ask, re-reads the SAME on-disk ledger file.
    const laterNow = new Date(NOW_MS + 60_000).toISOString(); // past the default 30s staleness window
    const restarted = makeCoordinator({
      dataDir: coordDir,
      singleSymbol: () => [],
      nowIso: () => laterNow,
      queryOrderByClientId: async (queriedSymbol, _clientOrderId) => ({
        symbol: queriedSymbol, orderId: "999", clientOrderId: "irrelevant-here", status: "FILLED",
        type: "MARKET", side: "BUY", reduceOnly: false, price: 0, stopPrice: 0,
        origQty: 1, executedQty: 1, avgPrice: 100, updateTime: 0,
      }),
    });

    // Before reconciling: still correctly, conservatively occupied — never silently dropped just
    // because the process restarted.
    expect(restarted.reserve({ executorId: "OTHER", symbol, direction: "SHORT", requestedNotionalUsd: 10, clientOrderId: "other-1" }).ok).toBe(false);

    const sweep = await restarted.reconcileOnStartup();
    expect(sweep).toEqual({ checked: 1, committed: 1, released: 0, inconclusive: 0 });
    const reconciled = new AccountExposureReservationStore(coordDir).getState().reservations[0]!;
    expect(reconciled.status).toBe("COMMITTED");
    expect(reconciled.committedQty).toBe(1);
    expect(reconciled.committedNotionalUsd).toBeCloseTo(100, 6);

    // Honest, explicitly-documented residual boundary (NOT overclaimed): the reservation now
    // correctly reflects the real fill, but the EXECUTOR's own position record was never — and
    // cannot be, by this coordinator alone — reconstructed. The position push in maybeOpenPosition()
    // only ever happens AFTER placeOrder() resolves, which never happened in this simulated crash.
    const positionsAfterRestart = new SingleSymbolLaneExecutorStore(posStoreDir, "lane.json").getState();
    expect(positionsAfterRestart.positions).toHaveLength(0);
  });

  it("[B2] a genuinely inconclusive reconciliation (the exchange query itself fails) leaves the reservation RESERVED — capacity stays conservatively occupied, never silently freed", async () => {
    const symbol = "ETHUSDT";
    const { coordDir } = await simulateCrashedEntry({ symbol, laneId: "LANE_CRASH_INCONCLUSIVE" });

    const laterNow = new Date(NOW_MS + 60_000).toISOString();
    const restarted = makeCoordinator({
      dataDir: coordDir,
      singleSymbol: () => [],
      nowIso: () => laterNow,
      queryOrderByClientId: async () => {
        throw new Error("simulated: exchange unreachable during reconciliation");
      },
    });

    const sweep = await restarted.reconcileOnStartup();
    expect(sweep).toEqual({ checked: 1, committed: 0, released: 0, inconclusive: 1 });
    expect(new AccountExposureReservationStore(coordDir).getState().reservations[0]!.status).toBe("RESERVED");

    // Capacity is still correctly held — a subsequent attempt on the SAME symbol is still blocked.
    expect(restarted.reserve({ executorId: "OTHER", symbol, direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "other-2" }).ok).toBe(false);
  });

  it("[B3] commitReservation records the ACTUAL partial fill, not the requested qty/notional, end-to-end through a real executor tick", async () => {
    const symbol = "SOLUSDT";
    const client = new RaceClient();
    client.fillPriceBySymbol.set(symbol, 100);
    client.partialFillQtyBySymbol.set(symbol, 0.4); // exchange only filled 0.4 of the requested 1.0

    let lane: SingleSymbolLaneExecutor | null = null;
    const store = new AccountExposureReservationStore(tmpDir());
    const coordinator = makeCoordinator({ dataDir: tmpDir(), store, singleSymbol: () => [lane] });
    lane = makeSSExecutor({ client, laneId: "LANE_PARTIAL", symbol, legUsd: 100, ...reservationFnsOf(coordinator) });

    await lane.tick();

    const record = store.getState().reservations[0]!;
    expect(record.status).toBe("COMMITTED");
    expect(record.requestedNotionalUsd).toBeCloseTo(100, 6); // permanent audit value, never overwritten
    expect(record.committedQty).toBeCloseTo(0.4, 6); // the REAL fill, not the requested 1.0
    expect(record.committedNotionalUsd).toBeCloseTo(40, 6); // 0.4 * 100, not 100
  });

  it("[B4a] releaseReservation does NOT fire when placeOrder throws a plain (ambiguous-shaped) exception — the reservation stays RESERVED and keeps holding capacity", async () => {
    // [2026-08-04] Was "[B4a] ...frees capacity... the SAME symbol can be reserved again
    // immediately", documenting the pre-fix asymmetry (SingleSymbolLaneExecutor's catch used to
    // release on ANY error unconditionally). Now that single-symbol-lane-executor.ts's catch block
    // mirrors cross-sectional-executor.ts's discrimination (only release on an unambiguous
    // BinanceFuturesPrivateError with failureType "binance_error"), a plain, ambiguous Error must
    // NOT release — whether the order reached the exchange is genuinely unknown, and releasing here
    // would reopen the exact oversubscription race this coordinator exists to close.
    const symbol = "BTCUSDT";
    const client = new RaceClient();
    client.fillPriceBySymbol.set(symbol, 100);
    client.failOnSymbol = symbol;

    let lane: SingleSymbolLaneExecutor | null = null;
    const coordinator = makeCoordinator({ dataDir: tmpDir(), singleSymbol: () => [lane] });
    lane = makeSSExecutor({ client, laneId: "LANE_THROW", symbol, legUsd: 100, ...reservationFnsOf(coordinator) });

    await lane.tick();

    expect(client.placed).toHaveLength(0);
    expect(coordinator.getSymbolExposureUsd(symbol)).toBe(100);
    const record = coordinator.getStatus().recentReservations.find((r) => r.symbol === symbol)!;
    expect(record.status).toBe("RESERVED");
    expect(record.releaseReason).toBeUndefined();
    // Capacity is still held — a same-symbol reservation from another executor must be REJECTED,
    // not silently allowed through. This fires Gate 1's unconditional one-in-flight-reservation-
    // per-symbol guard (account-exposure-coordinator.ts:593), independent of any notional cap.
    const retry = coordinator.reserve({ executorId: "OTHER", symbol, direction: "LONG", requestedNotionalUsd: 50, clientOrderId: "retry-1" });
    expect(retry.ok).toBe(false);
    expect(retry.reason).toMatch(/another reservation is already in flight/);
  });

  it("[B4b] releaseReservation frees capacity when the exchange returns an unambiguous rejection response (a CrossSectionalExecutor leg) — the released leg's symbol can be reserved again immediately, while the sibling leg's genuine fill stays committed", async () => {
    const client = new RaceClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    client.fillPriceBySymbol.set("DOGEUSDT", 0.1);
    client.failOnSymbolWithBinanceError = "DOGEUSDT"; // the SHORT leg, sized+placed second

    const signalStore = new CrossSectionalStore(tmpDir());
    signalStore.add(xsecSignal(NOW_MS - 5 * 60_000));
    const xsecStore = new CrossSectionalExecutorStore(tmpDir());
    xsecStore.getState().lastSeenSignalMs = NOW_MS - 3_600_000;

    let xsecExec: CrossSectionalExecutor | null = null;
    const store = new AccountExposureReservationStore(tmpDir());
    const coordinator = makeCoordinator({ dataDir: tmpDir(), store, crossSectional: () => [xsecExec] });
    xsecExec = new CrossSectionalExecutor({
      client, signalStore, store: xsecStore, isAllowed: () => true, laneWeightPct: () => 100,
      legUsd: () => 100, nowIso: () => NOW, fillConfirmRetryDelayMs: 0, ...reservationFnsOf(coordinator),
    });

    await xsecExec.tick();

    expect(xsecStore.getState().baskets[0]!.status).toBe("ABORTED");
    const records = store.getState().reservations;
    const sol = records.find((r) => r.symbol === "SOLUSDT")!;
    const doge = records.find((r) => r.symbol === "DOGEUSDT")!;
    expect(sol.status).toBe("COMMITTED"); // SOL genuinely filled before DOGE's rejection
    expect(doge.status).toBe("RELEASED");
    expect(doge.releaseReason).toMatch(/^ENTRY_FAILED:/);

    const retry = coordinator.reserve({ executorId: "OTHER", symbol: "DOGEUSDT", direction: "SHORT", requestedNotionalUsd: 10, clientOrderId: "retry-doge" });
    expect(retry.ok).toBe(true);
  });

  it("[B4c] releaseReservation does NOT fire when placeOrder throws a TIMEOUT — SingleSymbolLaneExecutor now matches CrossSectionalExecutor's abort-catch, which only releases on an unambiguous binance_error and leaves a timeout RESERVED for the staleness sweep", async () => {
    // [2026-08-04] Was "...ALSO frees capacity when placeOrder throws a TIMEOUT — documents a real,
    // current asymmetry...", documenting the pre-fix bug. That asymmetry is now closed: a timeout is
    // a BinanceFuturesPrivateError, but failureType "timeout" (not "binance_error") — Binance may or
    // may not have received the request, so the reservation must stay RESERVED, identical to the
    // plain-Error case in [B4a] above.
    const symbol = "ETHUSDT";
    const client = new RaceClient();
    client.fillPriceBySymbol.set(symbol, 100);
    client.failOnSymbolWithTimeout = symbol;

    let lane: SingleSymbolLaneExecutor | null = null;
    const coordinator = makeCoordinator({ dataDir: tmpDir(), singleSymbol: () => [lane] });
    lane = makeSSExecutor({ client, laneId: "LANE_TIMEOUT", symbol, legUsd: 100, ...reservationFnsOf(coordinator) });

    await lane.tick();

    const record = coordinator.getStatus().recentReservations.find((r) => r.symbol === symbol)!;
    expect(record.status).toBe("RESERVED");
    expect(record.releaseReason).toBeUndefined();
    expect(coordinator.getSymbolExposureUsd(symbol)).toBe(100);
    // Fires Gate 1's unconditional one-in-flight-reservation-per-symbol guard
    // (account-exposure-coordinator.ts:593), independent of any notional cap — see [B4a] above.
    const retry = coordinator.reserve({ executorId: "OTHER", symbol, direction: "LONG", requestedNotionalUsd: 50, clientOrderId: "retry-eth" });
    expect(retry.ok).toBe(false);
    expect(retry.reason).toMatch(/another reservation is already in flight/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// SECTION C — OTHER REQUIRED PROOFS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("C. Other required proofs", () => {
  it("[C1] a manual/external position on a correlated symbol constrains a REAL executor's REAL entry attempt via the cluster cap", async () => {
    const client = new RaceClient();
    client.fillPriceBySymbol.set("AVAXUSDT", 100);

    let lane: SingleSymbolLaneExecutor | null = null;
    const coordinator = makeCoordinator({ dataDir: tmpDir(), singleSymbol: () => [lane], maxCluster: 1 });
    // A manual/external position on SOLUSDT (L1 cluster) that NO executor claims — e.g. the
    // operator's own manual trade, opened entirely outside this executor fleet.
    coordinator.updatePositionSnapshot([
      { symbol: "SOLUSDT", positionAmt: 5, entryPrice: 100, markPrice: 100, liquidationPrice: 0, unRealizedProfit: 0, leverage: 3, marginType: "ISOLATED" },
    ]);
    lane = makeSSExecutor({ client, laneId: "LANE_VS_MANUAL", symbol: "AVAXUSDT", legUsd: 100, ...reservationFnsOf(coordinator) });

    await lane.tick();

    expect(client.placed).toHaveLength(0);
    expect(lane.getStatus().lastEntrySkipReason).toMatch(/correlation-cluster cap/);
    expect(coordinator.getClusterOpenSymbols("SOLUSDT", "LONG")).toEqual(["SOLUSDT"]);
  });

  it("[C3a] SingleSymbolLaneExecutor: closing an already-OPEN position via the exit policy NEVER calls reserveExposure, even when the coordinator would reject any new entry outright", async () => {
    const client = new RaceClient();
    client.markPriceBySymbol.set("BTCUSDT", 106); // entry 100 / stop 90 -> r=0.6 >= 0.5 rewardMultiple -> TP_HIT
    let reserveCalls = 0;
    const hostileReserve = (_req: ExposureReserveRequest): ExposureReserveResult => {
      reserveCalls += 1;
      return { ok: false, reservationId: null, reason: "hostile test cap — should never be reached by a close" };
    };
    const storeDir = tmpDir();
    const store = new SingleSymbolLaneExecutorStore(storeDir, "lane.json");
    store.getState().positions.push(seedOpenPosition({ symbol: "BTCUSDT", direction: "LONG", entryPrice: 100, stopPrice: 90 }));
    const exec = new SingleSymbolLaneExecutor({
      client, store, laneId: "LANE_EXIT_ONLY", direction: "LONG", getOpenSignals: () => [],
      exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
      isAllowed: () => true, legUsd: () => 100, leverage: () => 3, nowIso: () => NOW, fillConfirmRetryDelayMs: 0,
      reserveExposure: hostileReserve,
    });

    await exec.tick();

    const pos = store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED");
    expect(pos.closeReason).toBe("TP_HIT");
    expect(client.placed.some((p) => p.reduceOnly === true)).toBe(true);
    expect(reserveCalls).toBe(0); // the close/reduction path never touches reserveExposure at all
  });

  it("[C3b] CrossSectionalExecutor: closing an already-due basket (HORIZON close) NEVER calls reserveExposure, even when the coordinator would reject any new entry outright", async () => {
    const client = new RaceClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    let reserveCalls = 0;
    const hostileReserve = (_req: ExposureReserveRequest): ExposureReserveResult => {
      reserveCalls += 1;
      return { ok: false, reservationId: null, reason: "hostile test cap — should never be reached by a close" };
    };
    const signalStore = new CrossSectionalStore(tmpDir()); // deliberately empty — no fresh signal to open
    const xsecStoreDir = tmpDir();
    const xsecStore = new CrossSectionalExecutorStore(xsecStoreDir);
    xsecStore.getState().baskets.push(seedOpenBasket("xb-due", "SOLUSDT", NOW_MS - 60_000)); // already past closesAtMs
    const exec = new CrossSectionalExecutor({
      client, signalStore, store: xsecStore, isAllowed: () => true, nowIso: () => NOW, fillConfirmRetryDelayMs: 0,
      reserveExposure: hostileReserve,
    });

    await exec.tick();

    const basket = xsecStore.getState().baskets.find((b) => b.basketId === "xb-due")!;
    expect(basket.status).toBe("CLOSED");
    expect(reserveCalls).toBe(0); // the close path never touches reserveExposure at all
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// SECTION D — INNOVATION-CAMPAIGN GATE (campaignCap, 2026-08-05 fix): req #7 — position management
// (exits/reductions/protective stops) for an innovation-lane position must NEVER be gated by the
// campaign check, regardless of campaign state. Extends section C's own proof (reserveExposure is
// never called on a close path) by ALSO wiring a maximally-exhausted campaignCap closure and
// asserting it is never even EVALUATED during a close-only tick — not just that reserve() itself
// isn't reached, but that the campaign-cap computation is skipped too (both executors only read
// their own campaignCapFn() from inside the entry-only method — maybeOpenPosition() /
// maybeOpenBasket() — never from any close/reduction/protective-order path).
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("D. Innovation-campaign gate (campaignCap) — position management is never gated by it", () => {
  it("[D1 / REQ-7] SingleSymbolLaneExecutor: closing an already-OPEN position via the exit policy NEVER calls reserveExposure OR even evaluates campaignCap, even when campaignCap is wired to a maximally-exhausted cap (globalMaxPositions: 0) that would reject ANY new entry outright", async () => {
    const client = new RaceClient();
    client.markPriceBySymbol.set("BTCUSDT", 106); // entry 100 / stop 90 -> r=0.6 >= 0.5 rewardMultiple -> TP_HIT
    let reserveCalls = 0;
    let campaignCapCalls = 0;
    const hostileReserve = (_req: ExposureReserveRequest): ExposureReserveResult => {
      reserveCalls += 1;
      return { ok: false, reservationId: null, reason: "hostile test cap — should never be reached by a close" };
    };
    const hostileCampaignCap = (): ExposureReserveCampaignCap | undefined => {
      campaignCapCalls += 1;
      return { campaignId: "camp-hostile", campaignLaneIds: ["LANE_EXIT_ONLY"], globalMaxPositions: 0, globalNotionalCap: 0 };
    };
    const storeDir = tmpDir();
    const store = new SingleSymbolLaneExecutorStore(storeDir, "lane.json");
    store.getState().positions.push(seedOpenPosition({ symbol: "BTCUSDT", direction: "LONG", entryPrice: 100, stopPrice: 90 }));
    const exec = new SingleSymbolLaneExecutor({
      client, store, laneId: "LANE_EXIT_ONLY", direction: "LONG", getOpenSignals: () => [],
      exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
      isAllowed: () => true, legUsd: () => 100, leverage: () => 3, nowIso: () => NOW, fillConfirmRetryDelayMs: 0,
      reserveExposure: hostileReserve,
      campaignCap: hostileCampaignCap,
    });

    await exec.tick();

    const pos = store.getState().positions[0]!;
    expect(pos.status).toBe("CLOSED");
    expect(pos.closeReason).toBe("TP_HIT");
    expect(client.placed.some((p) => p.reduceOnly === true)).toBe(true);
    expect(reserveCalls).toBe(0); // the close/reduction path never touches reserveExposure at all
    expect(campaignCapCalls).toBe(0); // ...nor does it even EVALUATE the campaign-cap closure
  });

  it("[D2 / REQ-7] CrossSectionalExecutor: closing an already-due basket (HORIZON close) NEVER calls reserveExposure OR even evaluates campaignCap, even when campaignCap is wired to a maximally-exhausted cap", async () => {
    const client = new RaceClient();
    client.fillPriceBySymbol.set("SOLUSDT", 100);
    let reserveCalls = 0;
    let campaignCapCalls = 0;
    const hostileReserve = (_req: ExposureReserveRequest): ExposureReserveResult => {
      reserveCalls += 1;
      return { ok: false, reservationId: null, reason: "hostile test cap — should never be reached by a close" };
    };
    const hostileCampaignCap = (): ExposureReserveCampaignCap | undefined => {
      campaignCapCalls += 1;
      return { campaignId: "camp-hostile", campaignLaneIds: ["XSEC_EXIT_ONLY"], globalMaxPositions: 0, globalNotionalCap: 0 };
    };
    const signalStore = new CrossSectionalStore(tmpDir()); // deliberately empty — no fresh signal to open
    const xsecStoreDir = tmpDir();
    const xsecStore = new CrossSectionalExecutorStore(xsecStoreDir);
    xsecStore.getState().baskets.push(seedOpenBasket("xb-due-2", "SOLUSDT", NOW_MS - 60_000)); // already past closesAtMs
    const exec = new CrossSectionalExecutor({
      client, signalStore, store: xsecStore, isAllowed: () => true, nowIso: () => NOW, fillConfirmRetryDelayMs: 0,
      reserveExposure: hostileReserve,
      campaignCap: hostileCampaignCap,
    });

    await exec.tick();

    const basket = xsecStore.getState().baskets.find((b) => b.basketId === "xb-due-2")!;
    expect(basket.status).toBe("CLOSED");
    expect(reserveCalls).toBe(0); // the close path never touches reserveExposure at all
    expect(campaignCapCalls).toBe(0); // ...nor does it even EVALUATE the campaign-cap closure
  });
});

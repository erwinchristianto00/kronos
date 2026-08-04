import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import {
  AccountExposureCoordinator,
  AccountExposureReservationStore,
  type AccountExposureCoordinatorOptions,
  type ExposureReservation,
  type LegacyMirrorOpenIntent,
  type ReservationStatus,
} from "../src/lib/account-exposure-coordinator.js";
import { BinanceFuturesPrivateError, type FuturesOrder, type FuturesPosition } from "../src/lib/binance-futures-private.js";
import type { CrossSectionalExecutor, ExecutorBasket, OrphanedLeg } from "../src/lib/cross-sectional-executor.js";
import { maxClusterPositionsAcrossLanes, maxNotionalPerSymbolAcrossLanes } from "../src/lib/live-executor-wiring.js";
import type { SingleSymbolLaneExecutor, SingleSymbolPosition } from "../src/lib/single-symbol-lane-executor.js";

const NOW = "2026-07-08T03:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

// ─── tmpdir plumbing (same convention as single-symbol-lane-executor-submit-ref.test.ts /
// cross-sectional-executor.test.ts) — NEVER the repo's real `data/` directory. ───────────────────
const dirs: string[] = [];
let n = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `aec-${process.pid}-${++n}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  dirs.length = 0;
});

// ─── fakes (same pattern as live-executor-wiring.test.ts's fakeSingleSymbolExecutor/fakeXsecExecutor) ───

function fakePosition(
  symbol: string,
  direction: "LONG" | "SHORT",
  qty: number,
  entryPrice: number,
  exitOrderId: string | null = null,
): SingleSymbolPosition {
  return {
    positionId: `p-${symbol}-${direction}`,
    sourceObservationId: "o1",
    symbol,
    direction,
    qty,
    entryPrice,
    entryOrderId: "1",
    entryPriceConfirmed: true,
    stopPrice: 1,
    stopAlgoOrderId: null,
    stopFailureCount: 0,
    stopUnprotectedSinceIso: null,
    closeFailureCount: 0,
    closeFailureSinceIso: null,
    peakFavorableR: 0,
    openedAt: NOW,
    status: "OPEN",
    closedAt: null,
    closeReason: null,
    exitPrice: null,
    exitOrderId,
    exitPriceConfirmed: null,
    grossPnlUsd: null,
    feeEstimateUsd: null,
    netPnlUsd: null,
  };
}
function fakeSingleSymbolExecutor(positions: SingleSymbolPosition[]): SingleSymbolLaneExecutor {
  return { getStatus: () => ({ openPositions: positions }) } as unknown as SingleSymbolLaneExecutor;
}
function fakeLeg(
  symbol: string,
  side: "LONG" | "SHORT",
  qty: number,
  entryPrice: number,
  exitOrderId: string | null = null,
): ExecutorBasket["legs"][number] {
  return { symbol, side, qty, entryPrice, entryOrderId: "1", entryPriceConfirmed: true, exitPrice: null, exitOrderId, exitPriceConfirmed: null };
}
function fakeBasket(legs: ExecutorBasket["legs"]): ExecutorBasket {
  return {
    basketId: "b1",
    sourceObservationId: "o1",
    signal: "MOM24",
    variant: "FILTERED",
    openedAt: NOW,
    closesAtMs: 0,
    legs,
    status: "OPEN",
    closedAt: null,
    closeReason: null,
    grossPnlUsd: null,
    feeEstimateUsd: null,
    netPnlUsd: null,
  };
}
function fakeOrphanedLeg(symbol: string, side: "LONG" | "SHORT", qty: number, entryPrice = 1): OrphanedLeg {
  return { basketId: "b1", symbol, side, qty, entryPrice, entryOrderId: "1", since: NOW, lastAttemptAt: NOW, lastError: "fixture", attempts: 1 };
}
function fakeXsecExecutor(baskets: ExecutorBasket[], orphanedLegs: OrphanedLeg[] = []): CrossSectionalExecutor {
  return { getStatus: () => ({ openBaskets: baskets, orphanedLegs }) } as unknown as CrossSectionalExecutor;
}
function fakeFuturesPosition(symbol: string, positionAmt: number, entryPrice: number, markPrice: number): FuturesPosition {
  return { symbol, positionAmt, entryPrice, markPrice, liquidationPrice: 0, unRealizedProfit: 0, leverage: 5, marginType: "ISOLATED" };
}

function makeCoordinator(opts: {
  dataDir: string;
  store?: AccountExposureReservationStore;
  singleSymbol?: SingleSymbolLaneExecutor[];
  crossSectional?: CrossSectionalExecutor[];
  legacyIntents?: LegacyMirrorOpenIntent[];
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
    getSingleSymbolExecutors: () => opts.singleSymbol ?? [],
    getCrossSectionalExecutors: () => opts.crossSectional ?? [],
    getLegacyMirrorOpenIntents: () => opts.legacyIntents ?? [],
    nowIso: opts.nowIso ?? (() => NOW),
    // Every cap defaults to 0 (disabled) in these tests, deliberately, so each test exercises
    // exactly one axis in isolation instead of tripping over the production nonzero per-symbol/
    // cluster defaults incidentally.
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

// ─── persisted ledger store ──────────────────────────────────────────────────

describe("AccountExposureReservationStore", () => {
  it("round-trips reservations to disk and reloads them in a fresh instance", () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    store.getState().reservations.push({
      reservationId: "r1",
      executorId: "E",
      kind: "SINGLE_SYMBOL",
      symbol: "BTCUSDT",
      direction: "LONG",
      clusterKey: "MAJORS",
      requestedQty: 0,
      requestedNotionalUsd: 100,
      clientOrderId: "c1",
      createdAt: NOW,
      createdAtMs: NOW_MS,
      status: "RESERVED",
    });
    store.save();

    const reloaded = new AccountExposureReservationStore(dir);
    expect(reloaded.getState().reservations).toHaveLength(1);
    expect(reloaded.getState().reservations[0]!.reservationId).toBe("r1");
    expect(reloaded.getState().reservations[0]!.requestedNotionalUsd).toBe(100);
  });

  it("degrades a corrupt file to a fresh empty state instead of throwing", () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "account-exposure-reservations.json"), "{not valid json at all", "utf-8");
    const store = new AccountExposureReservationStore(dir);
    expect(store.getState().reservations).toEqual([]);
  });

  it("a missing file also degrades to a fresh empty state (never throws)", () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir, "never-written.json");
    expect(store.getState()).toEqual({ version: 1, reservations: [] });
  });

  it("prune keeps every RESERVED row unconditionally and caps settled rows to the newest N by createdAt", () => {
    const saved = process.env.ACCOUNT_EXPOSURE_MAX_STORED_RESERVATIONS;
    process.env.ACCOUNT_EXPOSURE_MAX_STORED_RESERVATIONS = "3";
    try {
      const dir = tmpDir();
      const store = new AccountExposureReservationStore(dir);
      const mk = (id: string, status: ReservationStatus, createdAt: string): ExposureReservation => ({
        reservationId: id,
        executorId: "E",
        kind: "SINGLE_SYMBOL",
        symbol: "BTCUSDT",
        direction: "LONG",
        clusterKey: "MAJORS",
        requestedQty: 0,
        requestedNotionalUsd: 1,
        clientOrderId: id,
        createdAt,
        createdAtMs: new Date(createdAt).getTime(),
        status,
      });
      store.getState().reservations.push(
        mk("resv-1", "RESERVED", "2026-01-01T00:00:00.000Z"),
        mk("old-1", "RELEASED", "2026-01-01T00:00:00.000Z"),
        mk("old-2", "RELEASED", "2026-01-02T00:00:00.000Z"),
        mk("old-3", "RELEASED", "2026-01-03T00:00:00.000Z"),
        mk("newest", "RELEASED", "2026-01-04T00:00:00.000Z"),
      );
      store.save();
      const ids = store.getState().reservations.map((r) => r.reservationId);
      expect(ids).toContain("resv-1");
      expect(ids).toContain("newest");
      expect(ids).not.toContain("old-1");
      expect(store.getState().reservations.length).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.ACCOUNT_EXPOSURE_MAX_STORED_RESERVATIONS;
      else process.env.ACCOUNT_EXPOSURE_MAX_STORED_RESERVATIONS = saved;
    }
  });
});

// ─── reserve() input validation ──────────────────────────────────────────────

describe("AccountExposureCoordinator.reserve — input validation", () => {
  it("rejects missing symbol, missing clientOrderId, invalid direction, and invalid notional", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    expect(coord.reserve({ executorId: "E", symbol: "", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "x" }).ok).toBe(false);
    expect(coord.reserve({ executorId: "E", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "" }).ok).toBe(false);
    expect(coord.reserve({ executorId: "E", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: -1, clientOrderId: "x" }).ok).toBe(false);
    expect(
      coord.reserve({ executorId: "E", symbol: "BTCUSDT", direction: "UP" as unknown as "LONG", requestedNotionalUsd: 10, clientOrderId: "x" }).ok,
    ).toBe(false);
  });

  it("accepts a well-formed request with every cap disabled", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const result = coord.reserve({ executorId: "E", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 100, clientOrderId: "x" });
    expect(result.ok).toBe(true);
    expect(typeof result.reservationId).toBe("string");
  });
});

// ─── single-flight-per-symbol ────────────────────────────────────────────────

describe("single-flight-per-symbol (gate 1, unconditional)", () => {
  it("rejects a second reservation for the same symbol while the first is RESERVED, regardless of direction or executor", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const first = coord.reserve({ executorId: "LANE_A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 50, clientOrderId: "c1" });
    expect(first.ok).toBe(true);
    const second = coord.reserve({ executorId: "LANE_B", symbol: "BTCUSDT", direction: "SHORT", requestedNotionalUsd: 50, clientOrderId: "c2" });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already in flight/);
  });

  it("this is what gives CrossSectionalExecutor (no in-flight claim of its own) its first protection: two basketId reservations on the same symbol still collide", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const legA = coord.reserve({ executorId: "XSEC_A", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 25, clientOrderId: "xa", basketId: "basket-1" });
    expect(legA.ok).toBe(true);
    const legB = coord.reserve({ executorId: "XSEC_B", symbol: "SOLUSDT", direction: "SHORT", requestedNotionalUsd: 25, clientOrderId: "xb", basketId: "basket-2" });
    expect(legB.ok).toBe(false);
  });

  it("releasing the first reservation frees the symbol for a new one", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const first = coord.reserve({ executorId: "LANE_A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 50, clientOrderId: "c1" });
    coord.releaseReservation(first.reservationId!, "TEST_RELEASE");
    const second = coord.reserve({ executorId: "LANE_B", symbol: "BTCUSDT", direction: "SHORT", requestedNotionalUsd: 50, clientOrderId: "c2" });
    expect(second.ok).toBe(true);
  });

  it("committing the first reservation also frees the single-flight slot (status is no longer RESERVED)", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const first = coord.reserve({ executorId: "LANE_A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 50, clientOrderId: "c1" });
    coord.commitReservation(first.reservationId!, { qty: 0.001, avgPrice: 60000 });
    const second = coord.reserve({ executorId: "LANE_B", symbol: "BTCUSDT", direction: "SHORT", requestedNotionalUsd: 50, clientOrderId: "c2" });
    expect(second.ok).toBe(true);
  });
});

// ─── commitReservation / releaseReservation lifecycle ────────────────────────

describe("commitReservation / releaseReservation", () => {
  it("commitReservation records the ACTUAL fill, never overwriting requestedNotionalUsd/requestedQty", () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const coord = makeCoordinator({ dataDir: dir, store });
    const r = coord.reserve({ executorId: "E", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 180, clientOrderId: "c1" });
    coord.commitReservation(r.reservationId!, { qty: 0.0029, avgPrice: 60500 });

    const record = store.getState().reservations.find((x) => x.reservationId === r.reservationId)!;
    expect(record.status).toBe("COMMITTED");
    expect(record.committedQty).toBe(0.0029);
    expect(record.committedNotionalUsd).toBeCloseTo(0.0029 * 60500, 8);
    // requested* is the permanent "requested vs actual" audit pair — never overwritten by commit.
    expect(record.requestedNotionalUsd).toBe(180);
    expect(record.requestedQty).toBe(0);
  });

  it("releaseReservation records the reason and status", () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const coord = makeCoordinator({ dataDir: dir, store });
    const r = coord.reserve({ executorId: "E", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 180, clientOrderId: "c1" });
    coord.releaseReservation(r.reservationId!, "ENTRY_FAILED:network blip");

    const record = store.getState().reservations.find((x) => x.reservationId === r.reservationId)!;
    expect(record.status).toBe("RELEASED");
    expect(record.releaseReason).toBe("ENTRY_FAILED:network blip");
  });

  it("both are idempotent no-ops on an unknown id and on an already-resolved id (never throw)", () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const coord = makeCoordinator({ dataDir: dir, store });
    expect(() => coord.commitReservation("does-not-exist", { qty: 1, avgPrice: 1 })).not.toThrow();
    expect(() => coord.releaseReservation("does-not-exist", "x")).not.toThrow();

    const r = coord.reserve({ executorId: "E", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 100, clientOrderId: "c1" });
    coord.commitReservation(r.reservationId!, { qty: 0.001, avgPrice: 60000 });
    // Calling release AFTER commit must not flip an already-COMMITTED row to RELEASED.
    coord.releaseReservation(r.reservationId!, "SHOULD_NOT_APPLY");
    const record = store.getState().reservations.find((x) => x.reservationId === r.reservationId)!;
    expect(record.status).toBe("COMMITTED");
    expect(record.releaseReason).toBeUndefined();
  });
});

// ─── gross exposure cap ──────────────────────────────────────────────────────

describe("gross exposure cap", () => {
  it("allows within cap, rejects the reservation that would push the account total over it, allows exactly-at-cap", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxGross: 100 });
    const resA = coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 60, clientOrderId: "c1" });
    expect(resA.ok).toBe(true);
    const resB = coord.reserve({ executorId: "B", symbol: "ETHUSDT", direction: "LONG", requestedNotionalUsd: 60, clientOrderId: "c2" });
    expect(resB.ok).toBe(false);
    expect(resB.reason).toMatch(/gross exposure cap/);
    const resC = coord.reserve({ executorId: "C", symbol: "ETHUSDT", direction: "LONG", requestedNotionalUsd: 40, clientOrderId: "c3" });
    expect(resC.ok).toBe(true); // 60 + 40 = 100, exactly at cap, not over it
  });
});

// ─── directional LONG/SHORT exposure cap ─────────────────────────────────────

describe("directional LONG/SHORT exposure cap", () => {
  it("caps LONG independently of SHORT", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxLong: 100, maxShort: 100 });
    expect(coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 80, clientOrderId: "c1" }).ok).toBe(true);
    const resB = coord.reserve({ executorId: "B", symbol: "ETHUSDT", direction: "LONG", requestedNotionalUsd: 30, clientOrderId: "c2" });
    expect(resB.ok).toBe(false); // 80 + 30 = 110 > 100 LONG cap
    // SHORT cap is untouched by the LONG exposure above.
    expect(coord.reserve({ executorId: "C", symbol: "ETHUSDT", direction: "SHORT", requestedNotionalUsd: 90, clientOrderId: "c3" }).ok).toBe(true);
  });
});

// ─── per-symbol notional cap — folds S1(executors)+S3(mirror)+S4(manual)+S5(reservations) ────────

describe("per-symbol notional cap", () => {
  it("reuses maxNotionalPerSymbolAcrossLanes()'s existing nonzero default ($250) when not overridden", () => {
    const dir = tmpDir();
    const coord = new AccountExposureCoordinator({
      store: new AccountExposureReservationStore(dir),
      getSingleSymbolExecutors: () => [],
      getCrossSectionalExecutors: () => [],
      nowIso: () => NOW,
    });
    expect(coord.getStatus().caps.maxNotionalPerSymbolUsd).toBe(maxNotionalPerSymbolAcrossLanes());
    expect(coord.getStatus().caps.maxClusterPositions).toBe(maxClusterPositionsAcrossLanes());
  });

  it("an existing S1 open position on the symbol reduces headroom for a new reservation", () => {
    const dir = tmpDir();
    const exec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "LONG", 0.003, 60000)]); // $180
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 250, singleSymbol: [exec] });
    // 180 existing + 60 requested = 240 <= 250 -> ok
    expect(coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 60, clientOrderId: "c1" }).ok).toBe(true);
  });

  it("rejects once existing S1 + requested would exceed the cap", () => {
    const dir = tmpDir();
    const exec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "LONG", 0.003, 60000)]); // $180
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 250, singleSymbol: [exec] });
    // 180 + 80 = 260 > 250 -> reject
    const res = coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 80, clientOrderId: "c1" });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/per-symbol notional cap/);
  });

  it("also folds S2 (CrossSectionalExecutor open basket legs + orphaned legs)", () => {
    const dir = tmpDir();
    const xsec = fakeXsecExecutor(
      [fakeBasket([fakeLeg("BTCUSDT", "LONG", 0.002, 60000)])], // $120
      [fakeOrphanedLeg("BTCUSDT", "LONG", 0.001, 60000)], // $60 orphaned
    );
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 200, crossSectional: [xsec] });
    // 120 + 60 = 180 existing; +30 = 210 > 200 -> reject
    expect(coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 30, clientOrderId: "c1" }).ok).toBe(false);
    // +15 = 195 <= 200 -> ok
    expect(coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 15, clientOrderId: "c2" }).ok).toBe(true);
  });

  it("folds legacy-mirror open intents (S3) — a gap computeNotionalPerSymbol alone does not close", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({
      dataDir: dir,
      maxPerSymbol: 250,
      legacyIntents: [{ symbol: "BTCUSDT", direction: "LONG", appliedNotionalUsd: 200 }],
    });
    const res = coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 60, clientOrderId: "c1" });
    expect(res.ok).toBe(false);
  });

  it("falls back to requiredNotionalUsd when a legacy intent has no appliedNotionalUsd yet", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({
      dataDir: dir,
      maxPerSymbol: 250,
      legacyIntents: [{ symbol: "BTCUSDT", direction: "LONG", requiredNotionalUsd: 200, appliedNotionalUsd: null }],
    });
    expect(coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 60, clientOrderId: "c1" }).ok).toBe(false);
  });

  it("folds a sibling in-flight reservation on the SAME symbol (S5) — verified via getSymbolExposureUsd, since gate 1 makes a same-symbol reserve() collision unreachable for this axis specifically", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 250 });
    expect(coord.getSymbolExposureUsd("BTCUSDT")).toBe(0);
    const r = coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 180, clientOrderId: "c1" });
    expect(r.ok).toBe(true);
    expect(coord.getSymbolExposureUsd("BTCUSDT")).toBe(180);
  });
});

// ─── correlation-cluster exposure cap ─────────────────────────────────────────

describe("correlation-cluster exposure cap", () => {
  it("blocks a 4th distinct symbol in the same cluster+direction once the cap is reached", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxCluster: 3 });
    expect(coord.reserve({ executorId: "A", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1" }).ok).toBe(true);
    expect(coord.reserve({ executorId: "B", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c2" }).ok).toBe(true);
    expect(coord.reserve({ executorId: "C", symbol: "NEARUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c3" }).ok).toBe(true);
    const rejected = coord.reserve({ executorId: "D", symbol: "SUIUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c4" });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toMatch(/correlation-cluster cap/);
    expect(coord.getClusterOpenSymbols("SOLUSDT", "LONG")).toEqual(["AVAXUSDT", "NEARUSDT", "SOLUSDT"]);
  });

  it("MAJORS (BTC/ETH) are exempt from the cluster cap regardless of how many are already open", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxCluster: 1 });
    expect(coord.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1" }).ok).toBe(true);
    expect(coord.reserve({ executorId: "B", symbol: "ETHUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c2" }).ok).toBe(true);
  });

  it("a SHORT reservation in the same cluster does not consume the LONG bucket's cap", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxCluster: 1 });
    expect(coord.reserve({ executorId: "A", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1" }).ok).toBe(true);
    expect(coord.reserve({ executorId: "B", symbol: "AVAXUSDT", direction: "SHORT", requestedNotionalUsd: 10, clientOrderId: "c2" }).ok).toBe(true);
  });

  it("folds S2 cross-sectional legs and S4 manual exposure into the cluster's open-symbol set too", () => {
    const dir = tmpDir();
    const xsec = fakeXsecExecutor([fakeBasket([fakeLeg("SOLUSDT", "LONG", 1, 100)])]);
    const coord = makeCoordinator({ dataDir: dir, maxCluster: 2, crossSectional: [xsec] });
    coord.updatePositionSnapshot([fakeFuturesPosition("AVAXUSDT", 1, 30, 30)]); // pure manual L1 LONG
    // SOL (S2) + AVAX (S4 manual) already fill the cap of 2 -> a third distinct L1 symbol is blocked.
    const rejected = coord.reserve({ executorId: "C", symbol: "NEARUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1" });
    expect(rejected.ok).toBe(false);
  });
});

// ─── account-wide concurrent-position-count cap ──────────────────────────────

describe("account-wide concurrent-position-count cap", () => {
  it("rejects once the account-wide count reaches the cap", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxConcurrent: 2 });
    expect(coord.reserve({ executorId: "A", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1" }).ok).toBe(true);
    expect(coord.reserve({ executorId: "B", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c2" }).ok).toBe(true);
    const rejected = coord.reserve({ executorId: "C", symbol: "NEARUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c3" });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toMatch(/concurrent-position cap/);
  });

  it("counts an existing S1 position + a fresh S5 reservation together against the same cap", () => {
    const dir = tmpDir();
    const exec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "LONG", 0.001, 60000)]);
    const coord = makeCoordinator({ dataDir: dir, maxConcurrent: 2, singleSymbol: [exec] });
    expect(coord.reserve({ executorId: "A", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1" }).ok).toBe(true); // 1(S1)+1(S5)=2
    const rejected = coord.reserve({ executorId: "B", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c2" });
    expect(rejected.ok).toBe(false);
  });
});

// ─── manual/external exposure (S4) ───────────────────────────────────────────

describe("manual/external exposure visibility (S4)", () => {
  it("a pure manual position (unclaimed by any executor) adds its full notional and +1 to concurrent count", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 1_000_000, maxConcurrent: 5 });
    coord.updatePositionSnapshot([fakeFuturesPosition("BTCUSDT", 0.003, 60000, 60000)]);
    expect(coord.getSymbolExposureUsd("BTCUSDT")).toBe(180);
    expect(coord.getStatus().concurrentCount).toBe(1);
    expect(coord.getStatus().grossUsd).toBe(180);
    expect(coord.getStatus().longUsd).toBe(180);
  });

  it("a manual position FULLY explained by an executor's own claim contributes ZERO additional exposure (no double count)", () => {
    const dir = tmpDir();
    const exec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "LONG", 0.003, 60000)]); // executor claims 0.003 LONG
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 1_000_000, maxConcurrent: 5, singleSymbol: [exec] });
    // Real exchange positionAmt EXACTLY matches the executor's own claim -> manual remainder is 0.
    coord.updatePositionSnapshot([fakeFuturesPosition("BTCUSDT", 0.003, 60000, 60000)]);
    expect(coord.getSymbolExposureUsd("BTCUSDT")).toBe(180); // not doubled to 360
    expect(coord.getStatus().concurrentCount).toBe(1); // not 2 — no fresh slot for an already-claimed symbol
  });

  it("a manual position PARTIALLY beyond an executor's own claim adds only the unexplained remainder", () => {
    const dir = tmpDir();
    const exec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "LONG", 0.003, 60000)]); // claims 0.003
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 1_000_000, maxConcurrent: 5, singleSymbol: [exec] });
    // Real exchange shows 0.005 total -> 0.002 is an unexplained (manual) remainder.
    coord.updatePositionSnapshot([fakeFuturesPosition("BTCUSDT", 0.005, 60000, 60000)]);
    expect(coord.getSymbolExposureUsd("BTCUSDT")).toBeCloseTo(0.003 * 60000 + 0.002 * 60000, 6); // 180 + 120 = 300
    expect(coord.getStatus().concurrentCount).toBe(1); // symbol already claimed by S1 — no fresh slot
  });

  it("a manual SHORT remainder contributes to shortUsd, not longUsd", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 1_000_000 });
    coord.updatePositionSnapshot([fakeFuturesPosition("ETHUSDT", -1, 3000, 3000)]);
    expect(coord.getStatus().shortUsd).toBe(3000);
    expect(coord.getStatus().longUsd).toBe(0);
  });

  it("getStatus().positionSnapshotAgeMs reflects how long ago updatePositionSnapshot was last called", () => {
    const dir = tmpDir();
    let now = NOW;
    const coord = makeCoordinator({ dataDir: dir, nowIso: () => now });
    expect(coord.getStatus().positionSnapshotAgeMs).toBeNull();
    coord.updatePositionSnapshot([]);
    now = new Date(NOW_MS + 12_345).toISOString();
    expect(coord.getStatus().positionSnapshotAgeMs).toBe(12_345);
  });
});

// ─── FULL REQUIREMENT: multiple 100% lane allocations cannot oversubscribe the account ───────────

describe("multiple lane allocations marked 100% cannot oversubscribe the account", () => {
  it("three lanes each sized at their own full allocation on the same symbol — only ONE gets capacity, the others are rejected outright, total spend never exceeds one lane's worth", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir, maxPerSymbol: 200 });
    const laneA = coord.reserve({ executorId: "LANE_A_100PCT", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 150, clientOrderId: "a" });
    const laneB = coord.reserve({ executorId: "LANE_B_100PCT", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 150, clientOrderId: "b" });
    const laneC = coord.reserve({ executorId: "LANE_C_100PCT", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 150, clientOrderId: "c" });
    expect(laneA.ok).toBe(true);
    expect(laneB.ok).toBe(false);
    expect(laneC.ok).toBe(false);
    expect(coord.getSymbolExposureUsd("BTCUSDT")).toBe(150); // never 300 or 450
  });
});

// ─── double-counting invariant (risks item #4 — dedicated test + mutation check) ─────────────────

describe("double-counting invariant: a COMMITTED reservation must not be summed on top of the now-materialized position", () => {
  it("per-symbol/gross exposure counts the position exactly ONCE after commit, even though the COMMITTED record still exists in the ledger", () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const coordBeforeFill = makeCoordinator({ dataDir: dir, store, maxPerSymbol: 1_000_000, maxGross: 1_000_000 });
    const r = coordBeforeFill.reserve({ executorId: "A", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 180, clientOrderId: "c1" });
    expect(coordBeforeFill.getSymbolExposureUsd("BTCUSDT")).toBe(180); // while RESERVED
    coordBeforeFill.commitReservation(r.reservationId!, { qty: 0.003, avgPrice: 60000 });

    // Simulate the real stage-2 ordering: right after commitReservation(), the owning executor
    // pushes this exact fill into its OWN position store (single-symbol-lane-executor.ts's
    // st.positions.push()) — so the SAME ledger (still holding the now-COMMITTED reservation row)
    // is now read alongside an executor that ALSO claims this exact position.
    const exec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "LONG", 0.003, 60000)]);
    const coordAfterFill = makeCoordinator({ dataDir: dir, store, maxPerSymbol: 1_000_000, maxGross: 1_000_000, singleSymbol: [exec] });

    expect(coordAfterFill.getSymbolExposureUsd("BTCUSDT")).toBe(180); // NOT 360
    expect(coordAfterFill.getStatus().grossUsd).toBe(180); // NOT 360
  });
});

// ─── restart / staleness reconciliation ──────────────────────────────────────

function fakeOrder(over: Partial<FuturesOrder> = {}): FuturesOrder {
  return {
    symbol: "BTCUSDT",
    orderId: "999",
    clientOrderId: "c",
    status: "NEW",
    type: "MARKET",
    side: "BUY",
    reduceOnly: false,
    price: 0,
    stopPrice: 0,
    origQty: 1,
    executedQty: 0,
    avgPrice: 0,
    updateTime: 0,
    ...over,
  };
}
function pushRawReservation(
  store: AccountExposureReservationStore,
  over: Partial<ExposureReservation> & { clientOrderId: string },
  staleMs = 30_000,
): ExposureReservation {
  const record: ExposureReservation = {
    reservationId: over.reservationId ?? `r-${over.clientOrderId}`,
    executorId: "E",
    kind: "SINGLE_SYMBOL",
    symbol: "BTCUSDT",
    direction: "LONG",
    clusterKey: "MAJORS",
    requestedQty: 0,
    requestedNotionalUsd: 100,
    createdAt: NOW,
    createdAtMs: NOW_MS - staleMs - 5_000,
    status: "RESERVED",
    ...over,
  };
  store.getState().reservations.push(record);
  return record;
}

describe("reconcileStaleReservations / reconcileOnStartup", () => {
  it("FILLED with executedQty>0 -> COMMITTED from the real executedQty/avgPrice", async () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const row = pushRawReservation(store, { clientOrderId: "filled-1" });
    const coord = makeCoordinator({
      dataDir: dir,
      store,
      queryOrderByClientId: async (symbol, clientOrderId) => fakeOrder({ symbol, clientOrderId, status: "FILLED", executedQty: 0.003, avgPrice: 60000 }),
    });
    const result = await coord.reconcileStaleReservations();
    expect(result).toEqual({ checked: 1, committed: 1, released: 0, inconclusive: 0 });
    expect(row.status).toBe("COMMITTED");
    expect(row.committedQty).toBe(0.003);
    expect(row.committedNotionalUsd).toBeCloseTo(180, 6);
  });

  it("PARTIALLY_FILLED with executedQty>0 -> also COMMITTED", async () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const row = pushRawReservation(store, { clientOrderId: "partial-1" });
    const coord = makeCoordinator({
      dataDir: dir,
      store,
      queryOrderByClientId: async () => fakeOrder({ status: "PARTIALLY_FILLED", executedQty: 0.001, avgPrice: 60000 }),
    });
    await coord.reconcileStaleReservations();
    expect(row.status).toBe("COMMITTED");
    expect(row.committedQty).toBe(0.001);
  });

  it("terminal with no fill (CANCELED/EXPIRED/REJECTED) -> RELEASED RECONCILED_NOT_FILLED", async () => {
    for (const status of ["CANCELED", "EXPIRED", "REJECTED"]) {
      const dir = tmpDir();
      const store = new AccountExposureReservationStore(dir);
      const row = pushRawReservation(store, { clientOrderId: `term-${status}` });
      const coord = makeCoordinator({ dataDir: dir, store, queryOrderByClientId: async () => fakeOrder({ status, executedQty: 0 }) });
      const result = await coord.reconcileStaleReservations();
      expect(result).toEqual({ checked: 1, committed: 0, released: 1, inconclusive: 0 });
      expect(row.status).toBe("RELEASED");
      expect(row.releaseReason).toBe("RECONCILED_NOT_FILLED");
    }
  });

  it("a defensive FILLED-with-executedQty===0 is also treated as RECONCILED_NOT_FILLED", async () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const row = pushRawReservation(store, { clientOrderId: "filled-zero" });
    const coord = makeCoordinator({ dataDir: dir, store, queryOrderByClientId: async () => fakeOrder({ status: "FILLED", executedQty: 0 }) });
    await coord.reconcileStaleReservations();
    expect(row.status).toBe("RELEASED");
    expect(row.releaseReason).toBe("RECONCILED_NOT_FILLED");
  });

  it("query fails with binanceCode -2013 (order does not exist) -> RELEASED RECONCILED_NEVER_REACHED_EXCHANGE", async () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const row = pushRawReservation(store, { clientOrderId: "never-1" });
    const coord = makeCoordinator({
      dataDir: dir,
      store,
      queryOrderByClientId: async () => {
        throw new BinanceFuturesPrivateError("binance_error", "order does not exist", { binanceCode: -2013 });
      },
    });
    const result = await coord.reconcileStaleReservations();
    expect(result).toEqual({ checked: 1, committed: 0, released: 1, inconclusive: 0 });
    expect(row.status).toBe("RELEASED");
    expect(row.releaseReason).toBe("RECONCILED_NEVER_REACHED_EXCHANGE");
  });

  it("any other failure (network/timeout/unrecognized status/no client wired) leaves the row RESERVED for the next sweep", async () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const row1 = pushRawReservation(store, { clientOrderId: "network-blip" });
    const coord1 = makeCoordinator({ dataDir: dir, store, queryOrderByClientId: async () => { throw new Error("simulated network failure"); } });
    const result1 = await coord1.reconcileStaleReservations();
    expect(result1).toEqual({ checked: 1, committed: 0, released: 0, inconclusive: 1 });
    expect(row1.status).toBe("RESERVED");

    const dir2 = tmpDir();
    const store2 = new AccountExposureReservationStore(dir2);
    const row2 = pushRawReservation(store2, { clientOrderId: "still-new" });
    const coord2 = makeCoordinator({ dataDir: dir2, store: store2, queryOrderByClientId: async () => fakeOrder({ status: "NEW", executedQty: 0 }) });
    await coord2.reconcileStaleReservations();
    expect(row2.status).toBe("RESERVED");

    const dir3 = tmpDir();
    const store3 = new AccountExposureReservationStore(dir3);
    const row3 = pushRawReservation(store3, { clientOrderId: "no-client" });
    const coord3 = makeCoordinator({ dataDir: dir3, store: store3 }); // no queryOrderByClientId wired at all
    const result3 = await coord3.reconcileStaleReservations();
    expect(result3).toEqual({ checked: 1, committed: 0, released: 0, inconclusive: 1 });
    expect(row3.status).toBe("RESERVED");
  });

  it("a still-RESERVED (inconclusive) row keeps occupying single-flight capacity in a subsequent reserve() call", async () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    pushRawReservation(store, { clientOrderId: "stuck-1", symbol: "BTCUSDT" });
    const coord = makeCoordinator({ dataDir: dir, store, queryOrderByClientId: async () => { throw new Error("still down"); } });
    await coord.reconcileStaleReservations();
    const attempt = coord.reserve({ executorId: "OTHER", symbol: "BTCUSDT", direction: "SHORT", requestedNotionalUsd: 10, clientOrderId: "new-attempt" });
    expect(attempt.ok).toBe(false);
  });

  it("rows younger than the staleness threshold are left untouched and never queried", async () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    let queried = false;
    pushRawReservation(store, { clientOrderId: "fresh-1", createdAtMs: NOW_MS - 1_000 }, 30_000); // well under the 30s threshold
    const coord = makeCoordinator({
      dataDir: dir,
      store,
      staleMs: 30_000,
      queryOrderByClientId: async () => {
        queried = true;
        return fakeOrder({});
      },
    });
    const result = await coord.reconcileStaleReservations();
    expect(result).toEqual({ checked: 0, committed: 0, released: 0, inconclusive: 0 });
    expect(queried).toBe(false);
  });

  it("reconcileOnStartup delegates to the exact same reconciliation logic", async () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const row = pushRawReservation(store, { clientOrderId: "startup-1" });
    const coord = makeCoordinator({ dataDir: dir, store, queryOrderByClientId: async () => fakeOrder({ status: "FILLED", executedQty: 0.002, avgPrice: 60000 }) });
    const result = await coord.reconcileOnStartup();
    expect(result).toEqual({ checked: 1, committed: 1, released: 0, inconclusive: 0 });
    expect(row.status).toBe("COMMITTED");
  });
});

describe("restart safety: pending exposure is never silently lost", () => {
  it("a stale RESERVED row surviving a simulated process restart is still treated as occupied until reconciliation actually resolves it", async () => {
    const dir = tmpDir();
    // Simulate an earlier process reserving capacity and then dying mid-order (never committed or
    // released).
    {
      const deadStore = new AccountExposureReservationStore(dir);
      const deadCoord = makeCoordinator({ dataDir: dir, store: deadStore });
      const r = deadCoord.reserve({ executorId: "DEAD_PROCESS", symbol: "BTCUSDT", direction: "LONG", requestedNotionalUsd: 100, clientOrderId: "dead-1" });
      expect(r.ok).toBe(true);
      deadStore.save();
    }

    // "Restart": a brand-new store instance reloading the SAME on-disk ledger file.
    const revivedStore = new AccountExposureReservationStore(dir);
    expect(revivedStore.getState().reservations).toHaveLength(1);
    expect(revivedStore.getState().reservations[0]!.status).toBe("RESERVED");

    const laterNow = new Date(NOW_MS + 60_000).toISOString(); // well past the default 30s staleness
    const revivedCoord = makeCoordinator({
      dataDir: dir,
      store: revivedStore,
      nowIso: () => laterNow,
      queryOrderByClientId: async () => {
        throw new Error("simulated: exchange unreachable immediately after restart");
      },
    });

    // Before any reconciliation runs, the symbol is correctly still treated as occupied.
    expect(revivedCoord.reserve({ executorId: "NEW", symbol: "BTCUSDT", direction: "SHORT", requestedNotionalUsd: 10, clientOrderId: "new-1" }).ok).toBe(false);

    // reconcileOnStartup runs; the exchange is unreachable -> stays RESERVED, reported inconclusive
    // — exposure is NOT silently dropped just because the process restarted.
    const sweep = await revivedCoord.reconcileOnStartup();
    expect(sweep).toEqual({ checked: 1, committed: 0, released: 0, inconclusive: 1 });
    expect(revivedStore.getState().reservations[0]!.status).toBe("RESERVED");
    expect(revivedCoord.reserve({ executorId: "NEW2", symbol: "BTCUSDT", direction: "SHORT", requestedNotionalUsd: 10, clientOrderId: "new-2" }).ok).toBe(false);
  });
});

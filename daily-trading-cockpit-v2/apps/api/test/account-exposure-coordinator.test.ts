import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import {
  AccountExposureCoordinator,
  AccountExposureReservationStore,
  type AccountExposureCoordinatorOptions,
  type ExposureReservation,
  type ExposureReserveCampaignCap,
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

// =================================================================================================
// INNOVATION-CAMPAIGN CAPS — reserve()'s gate 2 (2026-08-05 fix). Everything above this line proves
// the pre-existing 5 axes; everything below proves the NEW campaign axis folded into the SAME atomic
// synchronous call, fed by req.campaignCap (account-exposure-coordinator.ts's own
// ExposureReserveCampaignCap — populated ONLY by innovation-campaign.ts's campaignCapForLane, see
// innovation-campaign.test.ts's own "campaignCapForLane" describe block for that translation layer).
// Every existing describe block above is completely untouched and still passes unmodified — gate 2
// lives entirely inside `if (req.campaignCap)`, dead code for every request above this line.
// =================================================================================================

// ─── campaign-specific fakes (laneId-bearing — the pre-existing fakes above deliberately omit
// laneId since buildSnapshot()'s own 5 axes never read it; buildCampaignExposure() does) ───────────

function fakeSingleSymbolExecutorLane(laneId: string, positions: SingleSymbolPosition[]): SingleSymbolLaneExecutor {
  return { getStatus: () => ({ laneId, openPositions: positions }) } as unknown as SingleSymbolLaneExecutor;
}
function fakeXsecExecutorLane(laneId: string, baskets: ExecutorBasket[], orphanedLegs: OrphanedLeg[] = []): CrossSectionalExecutor {
  return { getStatus: () => ({ laneId, openBaskets: baskets, orphanedLegs }) } as unknown as CrossSectionalExecutor;
}
/** basketId defaults to "b1" via the shared fakeBasket() helper above — override it explicitly
 *  whenever a test needs to correlate this basket with specific S5 reservation rows sharing the
 *  same basketId (see the S2/S5 handoff test below). */
function fakeBasketWithId(basketId: string, legs: ExecutorBasket["legs"], status: ExecutorBasket["status"] = "COMPLETE"): ExecutorBasket {
  return { ...fakeBasket(legs), basketId, status };
}
function fakeCampaignCap(over: Partial<ExposureReserveCampaignCap> = {}): ExposureReserveCampaignCap {
  return {
    campaignId: "camp-1",
    campaignLaneIds: ["INNOV_A", "INNOV_B"],
    // Deliberately huge, not 0/disabled like the OTHER axes' test defaults above — an ExposureReserveCampaignCap
    // is only ever present at all when campaignCapForLane already found an ACTIVE campaign, so "no cap
    // configured" isn't a real state this object can represent; tests that want to exercise ONE axis
    // in isolation override just that field, matching makeCoordinator()'s own convention above.
    globalMaxPositions: 1_000_000,
    globalNotionalCap: 1_000_000,
    ...over,
  };
}

describe("AccountExposureCoordinator.reserve — innovation-campaign caps (gate 2, default-off)", () => {
  it("[REQ-1 coordinator layer] req.campaignCap absent -> gate 2 is a complete no-op, even when an innovation-lane-shaped pre-existing exposure would blow a HYPOTHETICAL cap of 1 — proves gate 2 cannot leak into any request that doesn't explicitly opt in (mainnet posture unaffected)", () => {
    const dir = tmpDir();
    const exec = fakeSingleSymbolExecutorLane("INNOV_A", [fakePosition("SOLUSDT", "LONG", 1, 100)]);
    const coord = makeCoordinator({ dataDir: dir, singleSymbol: [exec] });
    // No campaignCap on this request at all — matches every mainnet SingleSymbolLaneExecutor /
    // CrossSectionalExecutor construction site in app.ts, which never populates this field.
    const res = coord.reserve({ executorId: "INNOV_A", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1" });
    expect(res.ok).toBe(true);
  });
});

describe("AccountExposureCoordinator.reserve — innovation-campaign caps (gate 2): global position cap", () => {
  it("[REQ-4] denies the reservation that would be the (cap+1)th innovation position; allows when strictly below the cap", () => {
    const dir = tmpDir();
    const execA = fakeSingleSymbolExecutorLane("INNOV_A", [fakePosition("SOLUSDT", "LONG", 1, 100)]); // 1 pre-existing position
    const coord = makeCoordinator({ dataDir: dir, singleSymbol: [execA] });
    const laneIds = ["INNOV_A", "INNOV_B"];
    const atCap = coord.reserve({
      executorId: "INNOV_B", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1",
      campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 }),
    });
    expect(atCap.ok).toBe(false);
    expect(atCap.reason).toMatch(/campaign camp-1 global innovation position cap reached \(1\/1\)/);

    const dir2 = tmpDir();
    const coord2 = makeCoordinator({ dataDir: dir2 }); // zero pre-existing exposure anywhere
    const belowCap = coord2.reserve({
      executorId: "INNOV_B", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1",
      campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 }),
    });
    expect(belowCap.ok).toBe(true);
  });

  it("EXACTLY the next reservation attempt is denied once the cap is reached — not merely 'eventually', proven by immediately retrying on a fresh symbol right after the cap-filling reservation lands", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const laneIds = ["INNOV_A"];
    const cap = fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 });
    const first = coord.reserve({ executorId: "INNOV_A", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1", campaignCap: cap });
    expect(first.ok).toBe(true);
    const second = coord.reserve({ executorId: "INNOV_A", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c2", campaignCap: cap });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/global innovation position cap reached \(1\/1\)/);
  });

  it("a lane OUTSIDE campaignLaneIds contributes NOTHING to the global count (buildCampaignExposure is correctly scoped, not account-wide)", () => {
    const dir = tmpDir();
    const outsider = fakeSingleSymbolExecutorLane("NOT_AN_INNOVATION_LANE", [fakePosition("SOLUSDT", "LONG", 1, 100), fakePosition("BTCUSDT", "LONG", 1, 100)]);
    const coord = makeCoordinator({ dataDir: dir, singleSymbol: [outsider] });
    const res = coord.reserve({
      executorId: "INNOV_A", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "c1",
      campaignCap: fakeCampaignCap({ campaignLaneIds: ["INNOV_A"], globalMaxPositions: 1 }),
    });
    expect(res.ok).toBe(true); // the outsider's 2 positions never counted against this campaign's cap of 1
  });
});

describe("AccountExposureCoordinator.reserve — innovation-campaign caps (gate 2): global notional cap", () => {
  it("[REQ-4] denies once existing+requested EXCEEDS the cap, allows exactly AT the cap (matches this coordinator's own established '+requested > cap' convention, NOT the old campaign module's looser pre-add '>=' form)", () => {
    const dir = tmpDir();
    const execA = fakeSingleSymbolExecutorLane("INNOV_A", [fakePosition("SOLUSDT", "LONG", 1, 60)]); // $60 existing
    const coord = makeCoordinator({ dataDir: dir, singleSymbol: [execA] });
    const laneIds = ["INNOV_A", "INNOV_B"];
    const over = coord.reserve({
      executorId: "INNOV_B", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 41, clientOrderId: "c1", // 60+41=101>100
      campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds, globalNotionalCap: 100 }),
    });
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/campaign camp-1 global innovation notional cap exceeded/);

    const exact = coord.reserve({
      executorId: "INNOV_B", symbol: "NEARUSDT", direction: "LONG", requestedNotionalUsd: 40, clientOrderId: "c2", // 60+40=100, exactly at cap
      campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds, globalNotionalCap: 100 }),
    });
    expect(exact.ok).toBe(true);
  });
});

describe("AccountExposureCoordinator.reserve — innovation-campaign caps (gate 2): per-lane caps", () => {
  it("[REQ-4] per-lane position cap blocks only the REQUESTING lane's own supplied cap value; a sibling lane with equal raw exposure but no cap entry (campaignCapForLane -> laneMaxPositions undefined) is unaffected", () => {
    const dir = tmpDir();
    const execA = fakeSingleSymbolExecutorLane("INNOV_A", [fakePosition("SOLUSDT", "LONG", 1, 10), fakePosition("BTCUSDT", "LONG", 1, 10)]); // 2 on A
    const execB = fakeSingleSymbolExecutorLane("INNOV_B", [fakePosition("NEARUSDT", "LONG", 1, 10), fakePosition("ETHUSDT", "LONG", 1, 10)]); // 2 on B, identical raw count
    const coord = makeCoordinator({ dataDir: dir, singleSymbol: [execA, execB] });
    const laneIds = ["INNOV_A", "INNOV_B"];

    // campaignCapForLane would build THIS shape for lane A (perLaneCaps has an entry for A only).
    const blockedA = coord.reserve({
      executorId: "INNOV_A", symbol: "SUIUSDT", direction: "LONG", requestedNotionalUsd: 5, clientOrderId: "ca",
      campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds, laneMaxPositions: 2 }),
    });
    expect(blockedA.ok).toBe(false);
    expect(blockedA.reason).toMatch(/campaign camp-1 lane INNOV_A position cap reached \(2\/2\)/);

    // campaignCapForLane would build THIS shape for lane B (no perLaneCaps entry -> undefined).
    const allowedB = coord.reserve({
      executorId: "INNOV_B", symbol: "OPUSDT", direction: "LONG", requestedNotionalUsd: 5, clientOrderId: "cb",
      campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds }), // laneMaxPositions left undefined
    });
    expect(allowedB.ok).toBe(true);
  });

  it("per-lane notional cap blocks only the requesting lane; a sibling lane with equal raw notional but no cap entry is unaffected", () => {
    const dir = tmpDir();
    const execA = fakeSingleSymbolExecutorLane("INNOV_A", [fakePosition("SOLUSDT", "LONG", 1, 100)]); // $100 on A
    const execB = fakeSingleSymbolExecutorLane("INNOV_B", [fakePosition("NEARUSDT", "LONG", 1, 100)]); // $100 on B
    const coord = makeCoordinator({ dataDir: dir, singleSymbol: [execA, execB] });
    const laneIds = ["INNOV_A", "INNOV_B"];

    const blockedA = coord.reserve({
      executorId: "INNOV_A", symbol: "SUIUSDT", direction: "LONG", requestedNotionalUsd: 1, clientOrderId: "ca", // 100+1=101>100
      campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds, laneMaxNotionalUsd: 100 }),
    });
    expect(blockedA.ok).toBe(false);
    expect(blockedA.reason).toMatch(/campaign camp-1 lane INNOV_A notional cap exceeded/);

    const allowedB = coord.reserve({
      executorId: "INNOV_B", symbol: "OPUSDT", direction: "LONG", requestedNotionalUsd: 50, clientOrderId: "cb",
      campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds }), // laneMaxNotionalUsd left undefined
    });
    expect(allowedB.ok).toBe(true);
  });
});

// ─── multi-leg CrossSectionalExecutor basket position-count semantics — the subtlest part of this
// axis (design's own §6 risk item): campaign "position" means ONE PER BASKET, never one per leg, and
// a basket mid-open (its full leg plan already RESERVED, but not yet visible via S2's openBaskets, OR
// already pushed to the executor's own store with legs:[] and ALSO still visible via S5) must land on
// exactly one count either way — never zero (silently permissive), never more than one (self-defeating
// a lane's own basket against its own in-flight legs). ───────────────────────────────────────────────

describe("AccountExposureCoordinator.reserve — innovation-campaign caps (gate 2): multi-leg CrossSectionalExecutor basket position-count semantics", () => {
  it("[SELF-EXCLUSION] a fresh N-leg basket's own leg-2 reservation is NOT rejected by leg-1's own just-inserted reservation — globalMaxPositions=1 with ZERO pre-existing exposure still allows a full 2-leg basket to open in one atomic sizing pass", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const cap = fakeCampaignCap({ campaignLaneIds: ["XSEC_INNOV"], globalMaxPositions: 1 });
    const leg1 = coord.reserve({ executorId: "XSEC_INNOV", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "leg1", basketId: "basket-1", campaignCap: cap });
    expect(leg1.ok).toBe(true);
    const leg2 = coord.reserve({ executorId: "XSEC_INNOV", symbol: "DOGEUSDT", direction: "SHORT", requestedNotionalUsd: 10, clientOrderId: "leg2", basketId: "basket-1", campaignCap: cap });
    expect(leg2.ok).toBe(true); // must NOT be rejected by its own sibling leg's reservation
  });

  it("[SELF-EXCLUSION SCOPE] the self-exclusion is scoped to (executorId, basketId) of THIS request only — a DIFFERENT basket's in-flight leg reservation is NOT excluded, and correctly consumes the slot against a third party's fresh-basket attempt", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const cap = fakeCampaignCap({ campaignLaneIds: ["XSEC_INNOV"], globalMaxPositions: 1 });
    const otherBasketLeg = coord.reserve({ executorId: "XSEC_INNOV", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "ob1", basketId: "basket-OTHER", campaignCap: cap });
    expect(otherBasketLeg.ok).toBe(true);
    const freshBasketLeg1 = coord.reserve({ executorId: "XSEC_INNOV", symbol: "DOGEUSDT", direction: "SHORT", requestedNotionalUsd: 10, clientOrderId: "fb1", basketId: "basket-FRESH", campaignCap: cap });
    expect(freshBasketLeg1.ok).toBe(false); // the slot is already consumed by the OTHER basket's own leg
    expect(freshBasketLeg1.reason).toMatch(/global innovation position cap reached \(1\/1\)/);
  });

  it("[S2/S5 HANDOFF, design §6 risk item] a basket already pushed to its own executor store (status RESERVED, legs still []) while its 2 leg reservations are STILL RESERVED in the ledger counts as EXACTLY ONE position — proves seenBasketIds excludes S5 double-counting what S2 already counted, reproducing cross-sectional-executor.ts's real maybeOpenBasket() ordering (basket pushed BEFORE any leg's order is placed)", () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    // The 2 leg reservations maybeOpenBasket()'s own sizing loop already took, synchronously, before
    // the basket record itself was ever pushed to the executor's store.
    pushRawReservation(store, { reservationId: "leg-1", executorId: "XSEC_INNOV", kind: "CROSS_SECTIONAL_LEG", basketId: "basket-1", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 30, clientOrderId: "e0" });
    pushRawReservation(store, { reservationId: "leg-2", executorId: "XSEC_INNOV", kind: "CROSS_SECTIONAL_LEG", basketId: "basket-1", symbol: "DOGEUSDT", direction: "SHORT", requestedNotionalUsd: 20, clientOrderId: "e1" });
    // The basket record itself, already visible via getStatus().openBaskets (isBasketLive() is true
    // for RESERVED) — legs:[] exactly matches real production state at this instant (no leg has
    // placed an order yet), so S2 contributes 0 notional here; the REAL notional comes from S5 above.
    const xsec = fakeXsecExecutorLane("XSEC_INNOV", [fakeBasketWithId("basket-1", [], "RESERVED")]);
    const coord = makeCoordinator({ dataDir: dir, store, crossSectional: [xsec] });

    // A THIRD PARTY's attempt (different executorId+basketId) must be rejected — the cap of 1 is
    // already fully consumed by this ONE basket, never 2 (S2) + 2 more (S5's two legs) = 3, and
    // never 0 (if S2/S5 accidentally cancelled each other out to nothing).
    const thirdParty = coord.reserve({
      executorId: "XSEC_INNOV", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 5, clientOrderId: "c-new", basketId: "basket-DIFFERENT",
      campaignCap: fakeCampaignCap({ campaignLaneIds: ["XSEC_INNOV"], globalMaxPositions: 1 }),
    });
    expect(thirdParty.ok).toBe(false);
    expect(thirdParty.reason).toMatch(/global innovation position cap reached \(1\/1\)/); // exactly 1, never 2 or 3, never 0
  });

  it("once a basket is fully COMMITTED (S1/S2-visible with real legs, ledger rows no longer RESERVED), it still counts as exactly ONE position via S2 alone — S5 correctly stops contributing the instant status leaves RESERVED", () => {
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    const r1 = pushRawReservation(store, { executorId: "XSEC_INNOV", kind: "CROSS_SECTIONAL_LEG", basketId: "basket-1", symbol: "SOLUSDT", requestedNotionalUsd: 30, clientOrderId: "e0", status: "COMMITTED", committedQty: 3, committedNotionalUsd: 30 });
    const r2 = pushRawReservation(store, { executorId: "XSEC_INNOV", kind: "CROSS_SECTIONAL_LEG", basketId: "basket-1", symbol: "DOGEUSDT", requestedNotionalUsd: 20, clientOrderId: "e1", status: "COMMITTED", committedQty: 200, committedNotionalUsd: 20 });
    expect(r1.status).toBe("COMMITTED");
    expect(r2.status).toBe("COMMITTED");
    const xsec = fakeXsecExecutorLane("XSEC_INNOV", [
      fakeBasketWithId("basket-1", [fakeLeg("SOLUSDT", "LONG", 3, 10), fakeLeg("DOGEUSDT", "SHORT", 200, 0.1)], "COMPLETE"),
    ]);
    const coord = makeCoordinator({ dataDir: dir, store, crossSectional: [xsec] });
    const thirdParty = coord.reserve({
      executorId: "XSEC_INNOV", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 5, clientOrderId: "c-new",
      campaignCap: fakeCampaignCap({ campaignLaneIds: ["XSEC_INNOV"], globalMaxPositions: 1 }),
    });
    expect(thirdParty.ok).toBe(false);
    expect(thirdParty.reason).toMatch(/global innovation position cap reached \(1\/1\)/); // still 1, not 3 (2 COMMITTED rows + 1 basket)
  });
});

// =================================================================================================
// [REQ-5] THE CORE RACE TEST — the entire reason this axis exists. "Simultaneous" here means exactly
// what this coordinator's own atomicity argument requires (see account-exposure-coordinator.ts's own
// header comment and reserve()'s own doc comment: reserve() has ZERO internal `await`, so two
// SYNCHRONOUS back-to-back calls with nothing awaited in between is the REAL interleaving two
// executors' own event-loop continuations would produce — not a simplification of it). This is the
// exact same "simultaneity" model this file's own PRE-EXISTING single-flight-per-symbol tests above
// already use (e.g. "rejects a second reservation for the same symbol while the first is RESERVED"),
// now applied to the campaign axis. See the approved design doc's own §5 for the full argument this
// test embodies.
// =================================================================================================

describe("[REQ-5] THE CORE RACE TEST — two back-to-back reserve() calls for the LAST unit of campaign capacity", () => {
  it("exactly ONE of two DIFFERENT executor instances (two different innovation lanes) racing the same global position cap succeeds; the other is rejected with a campaign-cap reason — never both, never neither", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir }); // zero pre-existing exposure anywhere
    const laneIds = ["INNOV_SS_LANE", "INNOV_XSEC_LANE"]; // mirrors the ground truth's own example:
    // "an innovation SingleSymbol lane racing an innovation CrossSectional lane"
    const capA = fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 });
    const capB = fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 });

    const resultA = coord.reserve({ executorId: "INNOV_SS_LANE", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "race-a", campaignCap: capA });
    const resultB = coord.reserve({ executorId: "INNOV_XSEC_LANE", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "race-b", campaignCap: capB });

    const results = [resultA, resultB];
    expect(results.filter((r) => r.ok)).toHaveLength(1); // never both
    const rejected = results.filter((r) => !r.ok);
    expect(rejected).toHaveLength(1); // never neither
    expect(rejected[0]!.reason).toMatch(/campaign camp-1 global innovation position cap reached \(1\/1\)/);
  });

  it("order-independent: swapping which executor calls reserve() first still yields exactly one winner — not a first-mover artifact of the test's own call order", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const laneIds = ["INNOV_SS_LANE", "INNOV_XSEC_LANE"];
    const capB = fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 });
    const capA = fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 });

    const resultB = coord.reserve({ executorId: "INNOV_XSEC_LANE", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "race-b2", campaignCap: capB });
    const resultA = coord.reserve({ executorId: "INNOV_SS_LANE", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "race-a2", campaignCap: capA });

    expect([resultA, resultB].filter((r) => r.ok)).toHaveLength(1);
  });

  it("also holds for the SAME lane's own per-signal loop (ONE SingleSymbolLaneExecutor attempting two entries within the same tick) — the second reserve() call sees the first's own just-inserted row", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const cap = fakeCampaignCap({ campaignLaneIds: ["INNOV_SS_LANE"], globalMaxPositions: 1 });
    const first = coord.reserve({ executorId: "INNOV_SS_LANE", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "sig-1", campaignCap: cap });
    const second = coord.reserve({ executorId: "INNOV_SS_LANE", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 10, clientOrderId: "sig-2", campaignCap: cap });
    expect([first, second].filter((r) => r.ok)).toHaveLength(1);
    expect([first, second].find((r) => !r.ok)!.reason).toMatch(/global innovation position cap reached \(1\/1\)/);
  });

  it("also holds for the GLOBAL NOTIONAL axis: two concurrent reservations that would TOGETHER exceed globalNotionalCap — exactly one succeeds", () => {
    const dir = tmpDir();
    const coord = makeCoordinator({ dataDir: dir });
    const laneIds = ["INNOV_A", "INNOV_B"];
    const cap = fakeCampaignCap({ campaignLaneIds: laneIds, globalNotionalCap: 100 });
    const first = coord.reserve({ executorId: "INNOV_A", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 60, clientOrderId: "n1", campaignCap: cap });
    const second = coord.reserve({ executorId: "INNOV_B", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 60, clientOrderId: "n2", campaignCap: cap }); // 60+60=120>100
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/global innovation notional cap exceeded/);
  });
});

// =================================================================================================
// RESTART — req #6: a RESERVED-but-ambiguous campaign reservation survives a simulated restart (a
// BRAND NEW coordinator/store instance re-reading the SAME on-disk ledger file — same convention as
// the pre-existing "restart safety: pending exposure is never silently lost" block above) and is
// resolved via reconciliation — never silently dropped (stays occupied until resolved), never
// silently double-counted (a resolved-to-COMMITTED row stops contributing to the CAMPAIGN axis the
// same instant it stops contributing to every other axis: the shared `status !== "RESERVED"` guard
// at the top of buildCampaignExposure's own S5 walk).
// =================================================================================================

describe("restart safety: a campaign-relevant reservation is never silently lost or double-counted across a restart", () => {
  it("[REQ-6] a RESERVED campaign reservation survives a simulated restart and still occupies the campaign's global slot; reconciliation that stays inconclusive (exchange unreachable) leaves it RESERVED and STILL occupying that slot — never silently dropped", async () => {
    const dir = tmpDir();
    const laneIds = ["XSEC_INNOV"];
    {
      const deadStore = new AccountExposureReservationStore(dir);
      const deadCoord = makeCoordinator({ dataDir: dir, store: deadStore });
      const r = deadCoord.reserve({
        executorId: "XSEC_INNOV", symbol: "SOLUSDT", direction: "LONG", requestedNotionalUsd: 50, clientOrderId: "dead-1",
        campaignCap: fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 }),
      });
      expect(r.ok).toBe(true);
      deadStore.save();
    }

    // "Restart": a brand-new store instance reloading the SAME on-disk ledger file — no executor,
    // no coordinator, no in-memory state survives from the "dead" process above.
    const revivedStore = new AccountExposureReservationStore(dir);
    expect(revivedStore.getState().reservations).toHaveLength(1);
    expect(revivedStore.getState().reservations[0]!.status).toBe("RESERVED");
    expect(revivedStore.getState().reservations[0]!.campaignId).toBe("camp-1"); // the audit tag survives persistence too

    const laterNow = new Date(NOW_MS + 60_000).toISOString(); // past the default 30s staleness window
    const revivedCoord = makeCoordinator({
      dataDir: dir, store: revivedStore, nowIso: () => laterNow,
      queryOrderByClientId: async () => { throw new Error("simulated: exchange unreachable immediately after restart"); },
    });

    // Before reconciliation runs: the campaign's global slot is STILL correctly treated as occupied.
    const cap = fakeCampaignCap({ campaignLaneIds: laneIds, globalMaxPositions: 1 });
    const stillBlockedBeforeSweep = revivedCoord.reserve({ executorId: "XSEC_INNOV", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 5, clientOrderId: "new-1", campaignCap: cap });
    expect(stillBlockedBeforeSweep.ok).toBe(false);
    expect(stillBlockedBeforeSweep.reason).toMatch(/global innovation position cap reached \(1\/1\)/);

    const sweep = await revivedCoord.reconcileOnStartup();
    expect(sweep).toEqual({ checked: 1, committed: 0, released: 0, inconclusive: 1 });
    expect(revivedStore.getState().reservations[0]!.status).toBe("RESERVED"); // never silently dropped

    const stillBlockedAfterSweep = revivedCoord.reserve({ executorId: "XSEC_INNOV", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 5, clientOrderId: "new-2", campaignCap: cap });
    expect(stillBlockedAfterSweep.ok).toBe(false);
  });

  it("[REQ-6] a campaign reservation that reconciles to a CONFIRMED fill (COMMITTED) is never double-counted against the campaign cap afterward — the shared RESERVED-only filter excludes it the instant it commits, exactly like the pre-existing non-campaign double-counting invariant above", async () => {
    const symbol = "SOLUSDT";
    const dir = tmpDir();
    const store = new AccountExposureReservationStore(dir);
    pushRawReservation(store, { executorId: "XSEC_INNOV", symbol, requestedNotionalUsd: 50, clientOrderId: "dead-2", campaignId: "camp-1" });

    const laterNow = new Date(NOW_MS + 60_000).toISOString();
    const revivedCoord = makeCoordinator({
      dataDir: dir, store, nowIso: () => laterNow,
      queryOrderByClientId: async () => fakeOrder({ symbol, status: "FILLED", executedQty: 0.5, avgPrice: 100 }),
    });

    const sweep = await revivedCoord.reconcileOnStartup();
    expect(sweep).toEqual({ checked: 1, committed: 1, released: 0, inconclusive: 0 });
    expect(store.getState().reservations[0]!.status).toBe("COMMITTED");
    expect(store.getState().reservations[0]!.campaignId).toBe("camp-1"); // audit tag survives commit too

    // A fresh reserve() call re-walks the SAME ledger: the now-COMMITTED row is invisible to S5
    // (status !== RESERVED) — capacity bookkeeping responsibility has correctly passed to the
    // owning executor's own S1/S2 store (out of THIS coordinator's own scope alone, matching the
    // pre-existing restart test [B1] in account-exposure-coordinator-integration.test.ts, which
    // documents this exact residual boundary for the non-campaign axes).
    const afterCommit = revivedCoord.reserve({
      executorId: "XSEC_INNOV", symbol: "AVAXUSDT", direction: "LONG", requestedNotionalUsd: 5, clientOrderId: "new-3",
      campaignCap: fakeCampaignCap({ campaignLaneIds: ["XSEC_INNOV"], globalMaxPositions: 1 }),
    });
    expect(afterCommit.ok).toBe(true); // not double-counted as "2 already used"
  });
});

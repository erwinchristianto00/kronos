import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildMicrostructureCollectorReport,
  collectMicrostructureSnapshot,
  MICROSTRUCTURE_COLLECTOR_LANE,
  MICROSTRUCTURE_RICH_SCHEMA_VERSION,
  MicrostructureSnapshotStore,
  type MicrostructureBinanceLike,
  type MicrostructureSnapshot,
} from "../src/lib/microstructure-feature-collector.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function mkStore(): MicrostructureSnapshotStore {
  const d = mkdtempSync(join(tmpdir(), "ms-coll-"));
  tempDirs.push(d);
  return new MicrostructureSnapshotStore(d);
}

const happyClient: MicrostructureBinanceLike = {
  getBookTickerWithQty: async () => ({ bid: 100, ask: 100.05, bidQty: 7, askQty: 9 }),
  getDepth: async () => ({
    bids: [
      ["100.0", "1"],
      ["99.9", "2"],
    ],
    asks: [
      ["100.05", "3"],
      ["100.1", "1"],
    ],
  }),
  getAggTrades: async () => [
    { price: 100, quantity: 2, isBuyerMaker: false }, // taker buy
    { price: 99.95, quantity: 1, isBuyerMaker: true }, // taker sell
  ],
  getPremiumIndex: async () => ({ fundingRate: 0.0001, nextFundingTime: 1_700_000_000_000 }),
  getOpenInterest: async () => ({ openInterest: 12345 }),
  getForceOrders: async () => [
    { side: "SELL", price: 100, quantity: 5 },
    { side: "BUY", price: 100, quantity: 3 },
  ],
};

const failingClient: MicrostructureBinanceLike = {
  getBookTicker: async () => {
    throw new Error("book ticker offline");
  },
  getDepth: async () => {
    throw new Error("depth offline");
  },
  getAggTrades: async () => {
    throw new Error("agg trades offline");
  },
  getPremiumIndex: async () => {
    throw new Error("premium offline");
  },
  getOpenInterest: async () => {
    throw new Error("oi offline");
  },
  getForceOrders: async () => {
    throw new Error("force orders offline");
  },
};

describe("collectMicrostructureSnapshot", () => {
  it("populates fieldsAvailable when binance returns data", async () => {
    const snap = await collectMicrostructureSnapshot("SOLUSDT", happyClient);
    expect(snap.bestBid).toBe(100);
    expect(snap.bestAsk).toBe(100.05);
    expect(snap.bookTickerBidQty).toBe(7);
    expect(snap.bookTickerAskQty).toBe(9);
    expect(snap.spreadBps).toBeGreaterThan(0);
    expect(snap.bidDepth5Levels).toBe(3);
    expect(snap.askDepth5Levels).toBe(4);
    expect(snap.topBidQty).toBe(1);
    expect(snap.topAskQty).toBe(3);
    expect(snap.bidDepthNotional5).toBeCloseTo(299.8, 6);
    expect(snap.askDepthNotional5).toBeCloseTo(400.25, 6);
    expect(snap.depthImbalance5).toBeCloseTo((299.8 - 400.25) / (299.8 + 400.25), 6);
    expect(snap.takerDelta1m).toBe(1); // 2 buy - 1 sell
    expect(snap.fundingRate).toBe(0.0001);
    expect(snap.openInterest).toBe(12345);
    expect(snap.liquidationLongUsd5m).toBe(500);
    expect(snap.liquidationShortUsd5m).toBe(300);
    expect(snap.fieldsAvailable.length).toBeGreaterThan(0);
    expect(snap.endpointResults?.some((r) => r.endpoint === "depth" && r.status === "SUCCESS")).toBe(true);
    expect(snap.errors).toEqual([]);
  });

  it("populates fieldsMissing/errors when binance fails", async () => {
    const snap = await collectMicrostructureSnapshot("SOLUSDT", failingClient);
    expect(snap.bestBid).toBeNull();
    expect(snap.errors.length).toBeGreaterThan(0);
    expect(snap.fieldsMissing.length).toBeGreaterThan(0);
    expect(snap.endpointResults?.some((r) => r.status === "FAILED")).toBe(true);
  });

  it("can disable heavy endpoints without throwing", async () => {
    const snap = await collectMicrostructureSnapshot("SOLUSDT", happyClient, {
      depthEnabled: false,
      tradesEnabled: false,
      openInterestEnabled: false,
      fundingEnabled: false,
      liquidationsEnabled: false,
    });
    expect(snap.bestBid).toBe(100);
    expect(snap.bidDepth5Levels).toBeNull();
    expect(snap.takerDelta1m).toBeNull();
    expect(snap.openInterest).toBeNull();
    expect(snap.endpointResults?.filter((r) => r.status === "DISABLED").length).toBeGreaterThanOrEqual(4);
  });

  it("store appends one line per snapshot", async () => {
    const store = mkStore();
    const snap1 = await collectMicrostructureSnapshot("AAA", happyClient);
    const snap2 = await collectMicrostructureSnapshot("BBB", happyClient);
    store.append(snap1);
    store.append(snap2);
    const raw = readFileSync(store.path, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).symbol).toBe("AAA");
    expect(JSON.parse(lines[1]!).symbol).toBe("BBB");
  });

  it("report computes field completeness rate correctly", async () => {
    const store = mkStore();
    for (const s of ["AAA", "BBB", "CCC"]) {
      const snap = await collectMicrostructureSnapshot(s, happyClient);
      store.append(snap);
    }
    const report = await buildMicrostructureCollectorReport(store);
    expect(report.snapshotsCollected).toBe(3);
    expect(report.richSchemaSnapshots).toBe(3);
    expect(report.symbolsCovered).toEqual(expect.arrayContaining(["AAA", "BBB", "CCC"]));
    expect(report.allTimeCompleteness.bestBid).toBe(1);
    expect(report.postUpgradeCompleteness.openInterest).toBe(1);
    expect(report.postUpgradeCompleteness.bookTickerBidQty).toBe(1);
    expect(report.depthImbalanceAvailability).toBe(1);
    expect(report.bookTickerQtyAvailability).toBe(1);
    expect(report.endpointDiagnostics.bookTicker?.success).toBe(3);
  });

  it("legacy snapshots do not drag down post-upgrade completeness", async () => {
    const store = mkStore();
    const legacySnapshot: MicrostructureSnapshot = {
      reportOnly: true,
      laneVersion: MICROSTRUCTURE_COLLECTOR_LANE,
      capturedAt: "2026-05-27T00:00:00.000Z",
      symbol: "LEGACY",
      bestBid: 100,
      bestAsk: 100.1,
      spreadBps: 10,
      bookTickerBidQty: null,
      bookTickerAskQty: null,
      bidDepth5Levels: null,
      askDepth5Levels: null,
      takerBuyVolume1m: null,
      takerSellVolume1m: null,
      takerDelta1m: null,
      fundingRate: null,
      fundingTimeMs: null,
      openInterest: null,
      liquidationLongUsd5m: null,
      liquidationShortUsd5m: null,
      fieldsAvailable: ["bestBid", "bestAsk", "spreadBps"],
      fieldsMissing: ["bookTickerBidQty", "bookTickerAskQty"],
      errors: [],
    };
    store.append(legacySnapshot);
    const richSnapshot = await collectMicrostructureSnapshot("RICH", happyClient);
    expect(richSnapshot.collectorVersion).toBe(MICROSTRUCTURE_RICH_SCHEMA_VERSION);
    store.append(richSnapshot);

    const report = await buildMicrostructureCollectorReport(store);

    expect(report.snapshotsCollected).toBe(2);
    expect(report.richSchemaSnapshots).toBe(1);
    expect(report.allTimeCompleteness.bookTickerBidQty).toBe(0.5);
    expect(report.postUpgradeCompleteness.bookTickerBidQty).toBe(1);
    expect(report.postUpgradeCompleteness.bidDepthNotional5).toBe(1);
  });

  it("store path does NOT contain shadow-positions.json", () => {
    const store = mkStore();
    expect(store.path).not.toContain("shadow-positions.json");
    expect(store.path).toContain("microstructure-feature-snapshots.jsonl");
  });

  it("collector never writes data/shadow-positions.json (isolation guard)", async () => {
    const d = mkdtempSync(join(tmpdir(), "ms-iso-"));
    tempDirs.push(d);
    const store = new MicrostructureSnapshotStore(d);
    const snap = await collectMicrostructureSnapshot("AAA", happyClient);
    store.append(snap);
    expect(existsSync(join(d, "shadow-positions.json"))).toBe(false);
    expect(existsSync(join(d, "microstructure-feature-snapshots.jsonl"))).toBe(true);
  });
});

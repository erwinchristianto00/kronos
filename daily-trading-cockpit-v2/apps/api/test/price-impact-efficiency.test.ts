import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

import {
  computeAggressiveNotionalBySide,
  computePriceImpactBucket,
  fetchCurrentPriceImpactReading,
  PriceImpactHistoryStore,
  runPriceImpactEfficiencyCycle,
  runPriceImpactEfficiencyCycleGuarded,
  computeZScore,
  computeOwnHistoryZScores,
  computeClusterRelativeZScores,
  buildPriceImpactEfficiencyReport,
  PIE_BUCKET_MS,
  type PriceImpactReading,
} from "../src/lib/price-impact-efficiency.js";
import type { FuturesAggTradeSnapshot } from "../src/lib/binance.js";
import type { Candle } from "@dtc/shared";

function trade(price: number, qty: number, isBuyerMaker: boolean, ts: number): FuturesAggTradeSnapshot {
  return { price, quantity: qty, isBuyerMaker, timestamp: ts };
}

function candle(openTime: number, open: number, close: number, high?: number, low?: number): Candle {
  return { openTime, open, high: high ?? Math.max(open, close), low: low ?? Math.min(open, close), close, volume: 0 };
}

function reading(overrides: Partial<PriceImpactReading> & { symbol: string; bucketStartMs: number }): PriceImpactReading {
  return {
    bucketEndMs: overrides.bucketStartMs + PIE_BUCKET_MS,
    capturedAt: new Date(overrides.bucketStartMs).toISOString(),
    absolutePriceMove: 0.01,
    buyAggressiveNotionalUsd: 1000,
    sellAggressiveNotionalUsd: 1000,
    buyPriceImpactEfficiency: 0.00001,
    sellPriceImpactEfficiency: 0.00001,
    ...overrides,
  };
}

describe("computeAggressiveNotionalBySide", () => {
  it("sums notional (price*qty) split by isBuyerMaker side with known ratios", () => {
    const trades = [
      trade(100, 10, false, 1000), // buy-initiated: 1000 USD
      trade(101, 5, false, 1100), // buy-initiated: 505 USD
      trade(102, 4, true, 1200), // sell-initiated: 408 USD
    ];
    const r = computeAggressiveNotionalBySide(trades);
    expect(r.buyNotionalUsd).toBeCloseTo(1505, 6);
    expect(r.sellNotionalUsd).toBeCloseTo(408, 6);
  });

  it("ignores non-finite/non-positive price or quantity defensively", () => {
    const bad = { price: NaN, quantity: 5, isBuyerMaker: false, timestamp: 1 } as FuturesAggTradeSnapshot;
    const zeroQty = trade(100, 0, false, 2);
    const r = computeAggressiveNotionalBySide([bad, zeroQty, trade(100, 1, false, 3)]);
    expect(r.buyNotionalUsd).toBeCloseTo(100, 6);
    expect(r.sellNotionalUsd).toBe(0);
  });

  it("returns zero notional on both sides for an empty trade list", () => {
    const r = computeAggressiveNotionalBySide([]);
    expect(r.buyNotionalUsd).toBe(0);
    expect(r.sellNotionalUsd).toBe(0);
  });
});

describe("computePriceImpactBucket", () => {
  it("computes priceImpactEfficiency = absolutePriceMove / aggressiveNotional per side with known ratios", () => {
    const c = candle(0, 100, 103);
    const trades = [trade(100, 10, false, 1000), trade(101, 5, false, 1100), trade(102, 4, true, 1200)];
    const b = computePriceImpactBucket({ symbol: "BTCUSDT", candle: c, trades, capturedAtMs: 5000 });
    // absolutePriceMove = |103-100|/100 = 0.03 (fractional return, not raw price delta)
    expect(b.absolutePriceMove).toBeCloseTo(0.03, 10);
    expect(b.buyAggressiveNotionalUsd).toBeCloseTo(1505, 6);
    expect(b.sellAggressiveNotionalUsd).toBeCloseTo(408, 6);
    expect(b.buyPriceImpactEfficiency).toBeCloseTo(0.03 / 1505, 10);
    expect(b.sellPriceImpactEfficiency).toBeCloseTo(0.03 / 408, 10);
    expect(b.bucketStartMs).toBe(0);
    expect(b.bucketEndMs).toBe(PIE_BUCKET_MS);
    expect(b.symbol).toBe("BTCUSDT");
  });

  it("uses the fractional move (not raw price units) so a $60000 symbol and a $0.05 symbol are comparable", () => {
    const expensive = computePriceImpactBucket({
      symbol: "BTCUSDT",
      candle: candle(0, 60000, 60600), // +1% move, 600 raw price units
      trades: [trade(60000, 1, false, 0)], // 60000 USD buy notional
      capturedAtMs: 0,
    });
    const cheap = computePriceImpactBucket({
      symbol: "MEMEUSDT",
      candle: candle(0, 0.05, 0.0505), // +1% move, 0.0005 raw price units
      trades: [trade(0.05, 1_200_000, false, 0)], // 60000 USD buy notional
      capturedAtMs: 0,
    });
    // Same % move, same $ notional -> same efficiency, regardless of the symbol's price scale.
    expect(expensive.buyPriceImpactEfficiency).toBeCloseTo(cheap.buyPriceImpactEfficiency!, 10);
  });

  it("returns null efficiency (not zero/NaN) for a side with zero aggressive notional", () => {
    const b = computePriceImpactBucket({
      symbol: "ETHUSDT",
      candle: candle(0, 100, 101),
      trades: [trade(100, 1, false, 0)], // buy-only flow
      capturedAtMs: 0,
    });
    expect(b.buyPriceImpactEfficiency).not.toBeNull();
    expect(b.sellAggressiveNotionalUsd).toBe(0);
    expect(b.sellPriceImpactEfficiency).toBeNull();
  });

  it("handles a down candle (close < open) via absolute value", () => {
    const b = computePriceImpactBucket({
      symbol: "ETHUSDT",
      candle: candle(0, 100, 97),
      trades: [],
      capturedAtMs: 0,
    });
    expect(b.absolutePriceMove).toBeCloseTo(0.03, 10);
    expect(b.buyPriceImpactEfficiency).toBeNull();
    expect(b.sellPriceImpactEfficiency).toBeNull();
  });
});

describe("fetchCurrentPriceImpactReading", () => {
  const NOW = 1_000_000_000_000;

  it("uses the latest CLOSED bucket, skipping a still-forming last candle", async () => {
    const closedOpenTime = NOW - PIE_BUCKET_MS; // fully elapsed
    const formingOpenTime = NOW - 1; // window has not elapsed yet
    const client = {
      getCandles: async () => [
        candle(closedOpenTime - PIE_BUCKET_MS, 99, 100),
        candle(closedOpenTime, 100, 103), // the one we expect to be picked
        candle(formingOpenTime, 103, 103.5), // still forming -> must be skipped
      ],
      getFuturesAggTrades: async (_symbol: string, opts?: { startTime?: number; endTime?: number }) => [
        trade(100, 10, false, (opts!.startTime ?? 0) + 10),
      ],
    };
    const r = await fetchCurrentPriceImpactReading(client, "BTCUSDT", NOW);
    expect(r).not.toBeNull();
    expect(r!.bucketStartMs).toBe(closedOpenTime);
    expect(r!.absolutePriceMove).toBeCloseTo(0.03, 10);
  });

  it("defensively re-filters trades to the bucket window even if the client returns extras outside it", async () => {
    const closedOpenTime = NOW - PIE_BUCKET_MS;
    const client = {
      getCandles: async () => [candle(closedOpenTime, 100, 100)],
      getFuturesAggTrades: async () => [
        trade(100, 1, false, closedOpenTime - 1), // before the window -> must be excluded
        trade(100, 5, false, closedOpenTime + 10), // inside the window -> included
        trade(100, 1, false, closedOpenTime + PIE_BUCKET_MS), // at/after the end -> excluded
      ],
    };
    const r = await fetchCurrentPriceImpactReading(client, "BTCUSDT", NOW);
    expect(r!.buyAggressiveNotionalUsd).toBeCloseTo(500, 6); // only the 5-qty trade counted
  });

  it("returns null when no candle's bucket has fully closed yet", async () => {
    const client = {
      getCandles: async () => [candle(NOW - 1, 100, 100)], // still forming
      getFuturesAggTrades: async () => [],
    };
    expect(await fetchCurrentPriceImpactReading(client, "BTCUSDT", NOW)).toBeNull();
  });

  it("returns null on an empty candle list", async () => {
    const client = { getCandles: async () => [], getFuturesAggTrades: async () => [] };
    expect(await fetchCurrentPriceImpactReading(client, "BTCUSDT", NOW)).toBeNull();
  });
});

describe("PriceImpactHistoryStore — persistence + pruning (ShortFadeStore-style)", () => {
  it("persists readings across store instances via atomic tmp+rename write", () => {
    const file = `/tmp/price-impact-efficiency-test-${Date.now()}-${Math.random()}.json`;
    const store = new PriceImpactHistoryStore(file);
    store.record(reading({ symbol: "BTCUSDT", bucketStartMs: 0 }));
    store.record(reading({ symbol: "BTCUSDT", bucketStartMs: PIE_BUCKET_MS }));
    store.save();

    // the on-disk file is compact JSON, not pretty-printed
    const raw = readFileSync(file, "utf-8");
    expect(raw.includes("\n  ")).toBe(false);

    const reloaded = new PriceImpactHistoryStore(file);
    expect(reloaded.historyFor("BTCUSDT")).toHaveLength(2);
    expect(reloaded.historyFor("BTCUSDT")[0]!.bucketStartMs).toBe(0);
  });

  it("prunes the OLDEST readings once a symbol's history exceeds the bound (bounded retention)", () => {
    const file = `/tmp/price-impact-efficiency-test-${Date.now()}-${Math.random()}.json`;
    const store = new PriceImpactHistoryStore(file, 3); // small cap for the test
    for (let i = 0; i < 5; i++) {
      store.record(reading({ symbol: "ETHUSDT", bucketStartMs: i * PIE_BUCKET_MS }));
    }
    const history = store.historyFor("ETHUSDT");
    expect(history).toHaveLength(3);
    // Oldest two (bucket 0 and 1) dropped; the three most recent survive, in ascending order.
    expect(history.map((r) => r.bucketStartMs)).toEqual([2 * PIE_BUCKET_MS, 3 * PIE_BUCKET_MS, 4 * PIE_BUCKET_MS]);
  });

  it("is idempotent per (symbol, bucketStartMs) — recording the same bucket twice is a no-op", () => {
    const file = `/tmp/price-impact-efficiency-test-${Date.now()}-${Math.random()}.json`;
    const store = new PriceImpactHistoryStore(file);
    const first = store.record(reading({ symbol: "BTCUSDT", bucketStartMs: 0 }));
    const second = store.record(reading({ symbol: "BTCUSDT", bucketStartMs: 0 }));
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(store.historyFor("BTCUSDT")).toHaveLength(1);
  });

  it("keeps per-symbol histories independent", () => {
    const file = `/tmp/price-impact-efficiency-test-${Date.now()}-${Math.random()}.json`;
    const store = new PriceImpactHistoryStore(file);
    store.record(reading({ symbol: "BTCUSDT", bucketStartMs: 0 }));
    store.record(reading({ symbol: "ETHUSDT", bucketStartMs: 0 }));
    expect(store.allSymbols().sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(store.historyFor("BTCUSDT")).toHaveLength(1);
    expect(store.historyFor("SOLUSDT")).toHaveLength(0); // never recorded -> empty, not throwing
  });

  it("starts empty (never throws) when the file is corrupt", () => {
    const file = `/tmp/price-impact-efficiency-corrupt-${Date.now()}-${Math.random()}.json`;
    writeFileSync(file, "{not valid json");
    const store = new PriceImpactHistoryStore(file);
    expect(store.allSymbols()).toEqual([]);
  });
});

describe("runPriceImpactEfficiencyCycle / Guarded", () => {
  it("is best-effort per symbol: one symbol's fetch failure never blocks the others", async () => {
    const file = `/tmp/price-impact-efficiency-cycle-${Date.now()}-${Math.random()}.json`;
    const store = new PriceImpactHistoryStore(file);
    const closedOpenTime = 0;
    const now = PIE_BUCKET_MS + 1;
    const client = {
      getCandles: async (symbol: string) => {
        if (symbol === "BADUSDT") throw new Error("binance down");
        return [candle(closedOpenTime, 100, 101)];
      },
      getFuturesAggTrades: async () => [trade(100, 1, false, 10)],
    };
    const result = await runPriceImpactEfficiencyCycle({ store, client, symbols: ["BTCUSDT", "BADUSDT"], nowMs: now });
    expect(result.scanned).toBe(2);
    expect(result.recorded).toBe(1);
    expect(result.failed).toBe(1);
    expect(store.historyFor("BTCUSDT")).toHaveLength(1);
    expect(store.historyFor("BADUSDT")).toHaveLength(0);
  });

  it("guarded wrapper never throws even when the store itself fails to save", async () => {
    const throwingStore = {
      record: () => true,
      save: () => {
        throw new Error("disk full");
      },
    } as unknown as PriceImpactHistoryStore;
    const client = {
      getCandles: async () => [candle(0, 100, 101)],
      getFuturesAggTrades: async () => [trade(100, 1, false, 10)],
    };
    const result = await runPriceImpactEfficiencyCycleGuarded({
      store: throwingStore,
      client,
      symbols: ["BTCUSDT"],
      nowMs: PIE_BUCKET_MS + 1,
    });
    expect(result).toBeNull();
  });
});

describe("computeZScore (fail-open)", () => {
  it("computes a correct z-score against a known distribution", () => {
    const history = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const r = computeZScore(15, history, 8);
    expect(r.n).toBe(10);
    expect(r.mean).toBeCloseTo(5.5, 10);
    expect(r.stdev).toBeCloseTo(3.0276503540974917, 8);
    expect(r.z).toBeCloseTo(3.137746730610128, 6);
  });

  it("[FAIL-OPEN] returns z: null (not a throw, not NaN) below the minimum sample size", () => {
    expect(() => computeZScore(15, [1, 2, 3], 8)).not.toThrow();
    const r = computeZScore(15, [1, 2, 3], 8);
    expect(r.z).toBeNull();
    expect(r.n).toBe(3);
  });

  it("[FAIL-OPEN] returns z: null for a completely empty history", () => {
    const r = computeZScore(15, [], 8);
    expect(r.z).toBeNull();
    expect(r.mean).toBeNull();
    expect(r.stdev).toBeNull();
    expect(r.n).toBe(0);
  });

  it("[FAIL-OPEN] returns z: null (not Infinity/NaN) against a zero-variance baseline", () => {
    const r = computeZScore(10, [5, 5, 5, 5, 5], 3);
    expect(r.z).toBeNull();
    expect(r.stdev).toBe(0);
  });

  it("[FAIL-OPEN] returns z: null when current is null", () => {
    const r = computeZScore(null, [1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
    expect(r.z).toBeNull();
  });

  it("ignores non-finite values in the history when counting samples", () => {
    const r = computeZScore(5, [1, 2, NaN, 4, 5, 6, 7, 8], 6);
    expect(r.n).toBe(7);
  });
});

describe("computeOwnHistoryZScores", () => {
  it("z-scores the LATEST reading (by bucketStartMs) against its own PRIOR readings", () => {
    // 9 prior readings around ~0.00001, then a clear outlier as the most recent.
    const baseline = Array.from({ length: 9 }, (_, i) =>
      reading({ symbol: "BTCUSDT", bucketStartMs: i * PIE_BUCKET_MS, buyPriceImpactEfficiency: 0.00001 + i * 0.0000001 }),
    );
    const outlier = reading({ symbol: "BTCUSDT", bucketStartMs: 9 * PIE_BUCKET_MS, buyPriceImpactEfficiency: 0.001 });
    // shuffle input order to prove it sorts by bucketStartMs internally, not array order
    const shuffled = [outlier, ...baseline].reverse();
    const result = computeOwnHistoryZScores(shuffled, 8);
    expect(result.current!.bucketStartMs).toBe(9 * PIE_BUCKET_MS);
    expect(result.buy.n).toBe(9); // the 9 baseline readings, current excluded from its own baseline
    expect(result.buy.z).not.toBeNull();
    expect(result.buy.z!).toBeGreaterThan(3); // a clear outlier vs a tight baseline
  });

  it("[FAIL-OPEN] returns z: null when there isn't yet enough own history", () => {
    const history = [
      reading({ symbol: "BTCUSDT", bucketStartMs: 0 }),
      reading({ symbol: "BTCUSDT", bucketStartMs: PIE_BUCKET_MS }),
    ];
    const result = computeOwnHistoryZScores(history, 8);
    expect(result.buy.z).toBeNull();
    expect(result.sell.z).toBeNull();
    expect(result.current).not.toBeNull(); // still surfaces the current reading itself
  });

  it("returns a null current + NULL_Z shape (never throws) for an empty history", () => {
    const result = computeOwnHistoryZScores([], 8);
    expect(result.current).toBeNull();
    expect(result.buy.z).toBeNull();
    expect(result.sell.z).toBeNull();
  });
});

describe("computeClusterRelativeZScores (reuses correlation-clusters.ts's clusterOf)", () => {
  it("z-scores against OTHER symbols in the SAME cluster only, excluding self", () => {
    const latest = new Map<string, PriceImpactReading>([
      ["SOLUSDT", reading({ symbol: "SOLUSDT", bucketStartMs: 0, buyPriceImpactEfficiency: 0.01 })], // L1, target
      ["AVAXUSDT", reading({ symbol: "AVAXUSDT", bucketStartMs: 0, buyPriceImpactEfficiency: 0.001 })], // L1 peer
      ["NEARUSDT", reading({ symbol: "NEARUSDT", bucketStartMs: 0, buyPriceImpactEfficiency: 0.0012 })], // L1 peer
      ["SUIUSDT", reading({ symbol: "SUIUSDT", bucketStartMs: 0, buyPriceImpactEfficiency: 0.0009 })], // L1 peer
      ["DOGEUSDT", reading({ symbol: "DOGEUSDT", bucketStartMs: 0, buyPriceImpactEfficiency: 0.5 })], // MEME, must be excluded
    ]);
    const current = latest.get("SOLUSDT")!;
    const r = computeClusterRelativeZScores("SOLUSDT", current, latest, {}, 3);
    expect(r.cluster).toBe("L1");
    expect(r.buy.n).toBe(3); // AVAX, NEAR, SUI only — self and MEME excluded
    expect(r.buy.z).not.toBeNull();
  });

  it("[FAIL-OPEN] returns z: null when there aren't enough OTHER cluster peers yet", () => {
    const latest = new Map<string, PriceImpactReading>([
      ["SOLUSDT", reading({ symbol: "SOLUSDT", bucketStartMs: 0, buyPriceImpactEfficiency: 0.01 })],
      ["AVAXUSDT", reading({ symbol: "AVAXUSDT", bucketStartMs: 0, buyPriceImpactEfficiency: 0.001 })],
    ]);
    const current = latest.get("SOLUSDT")!;
    const r = computeClusterRelativeZScores("SOLUSDT", current, latest, {}, 3);
    expect(r.buy.n).toBe(1); // only AVAX qualifies as a peer
    expect(r.buy.z).toBeNull();
  });

  it("returns null when there is no current reading at all", () => {
    const r = computeClusterRelativeZScores("SOLUSDT", null, new Map(), {}, 1);
    expect(r.buy.z).toBeNull();
    expect(r.sell.z).toBeNull();
  });
});

describe("buildPriceImpactEfficiencyReport (end-to-end shape)", () => {
  it("exposes per-symbol snapshots with cluster + both z-scores, failing open before enough history", () => {
    const file = `/tmp/price-impact-efficiency-report-${Date.now()}-${Math.random()}.json`;
    const store = new PriceImpactHistoryStore(file);
    store.record(reading({ symbol: "SOLUSDT", bucketStartMs: 0 }));
    store.record(reading({ symbol: "AVAXUSDT", bucketStartMs: 0 }));

    const report = buildPriceImpactEfficiencyReport(store, { nowIso: "2026-07-10T00:00:00.000Z" });
    expect(report.reportOnly).toBe(true);
    expect(report.count).toBe(2);
    const sol = report.snapshots.find((s) => s.symbol === "SOLUSDT")!;
    expect(sol.cluster).toBe("L1");
    // Only 1 own-history sample and 1 cluster peer -> both z-scores fail open (null), not thrown.
    expect(sol.ownHistoryZScore.buy).toBeNull();
    expect(sol.clusterRelativeZScore.buy).toBeNull();
  });

  it("returns an empty snapshot array (not a throw) when the store has no history yet", () => {
    const file = `/tmp/price-impact-efficiency-report-empty-${Date.now()}-${Math.random()}.json`;
    const store = new PriceImpactHistoryStore(file);
    const report = buildPriceImpactEfficiencyReport(store);
    expect(report.count).toBe(0);
    expect(report.snapshots).toEqual([]);
  });
});

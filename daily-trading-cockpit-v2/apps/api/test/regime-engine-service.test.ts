import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import type { Candle } from "@dtc/shared";
import type { BinanceClient } from "../src/lib/binance.js";
import {
  RegimeEngineStore,
  _resetRegimeEngineStoreForTests,
  buildRegimeEngineReport,
  runRegimeEngineCycle,
} from "../src/lib/regime-engine-service.js";

const HOUR = 3_600_000;
const NOW = "2026-07-02T02:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

const dirs: string[] = [];
let n = 0;
function tmpStore(): RegimeEngineStore {
  const dir = resolve(os.tmpdir(), `regime-engine-${process.pid}-${++n}`);
  dirs.push(dir);
  const store = new RegimeEngineStore(dir);
  _resetRegimeEngineStoreForTests(store);
  return store;
}
afterEach(() => {
  _resetRegimeEngineStoreForTests(null);
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

// Synthetic series ENDING at NOW so freshness gates pass. Descending → bearish.
function series(closes: number[], stepMs: number, volume = 1000): Candle[] {
  const startTs = NOW_MS - closes.length * stepMs;
  return closes.map((close, i) => ({
    openTime: startTs + i * stepMs,
    open: i === 0 ? close : closes[i - 1]!,
    high: Math.max(close, i === 0 ? close : closes[i - 1]!) * 1.001,
    low: Math.min(close, i === 0 ? close : closes[i - 1]!) * 0.999,
    close,
    volume,
  }));
}

function fakeClient(): BinanceClient {
  const btcH1 = series(Array.from({ length: 60 }, (_, i) => 61_000 - i * 40), HOUR); // → ~58.6k
  const btcH4 = series(Array.from({ length: 40 }, (_, i) => 61_500 - i * 60), 4 * HOUR);
  const btcD1 = series(Array.from({ length: 20 }, (_, i) => 63_000 - i * 200), 24 * HOUR);
  const altH1 = series(Array.from({ length: 48 }, (_, i) => 100 - i * 0.5), HOUR); // alts bleeding
  return {
    async getCandles(symbol: string, interval: string) {
      if (symbol === "BTCUSDT") {
        if (interval === "1h") return btcH1;
        if (interval === "4h") return btcH4;
        if (interval === "1d") return btcD1;
      }
      return altH1;
    },
    async getBookTicker() {
      return { bid: 58_600, ask: 58_601, absolute: 1, percent: 0.0017 };
    },
    async getTicker24h() {
      return { baseVolume24h: 10_000, quoteVolume24h: 900_000_000 };
    },
    async getFuturesFlow() {
      return {
        fundingRate: 0.0001,
        openInterestChangePercent: 0,
        takerBuySellRatio: 1,
        longShortRatio: 1,
      };
    },
  } as unknown as BinanceClient;
}

describe("regime-engine-service (report-only VPS cycle)", () => {
  it("collects breadth + context from Binance data and records a decision snapshot", async () => {
    const store = tmpStore();
    const snapshot = await runRegimeEngineCycle(fakeClient(), NOW);

    // Descending BTC below 60k + collapsing alt breadth ⇒ a bearish regime call.
    expect(["BEARISH_CHOPPY_DEFENSIVE", "BEAR_TREND"]).toContain(snapshot.regime);
    expect(snapshot.btcPrice).toBeLessThan(60_000);
    expect(snapshot.breadth.advancersPct).not.toBeNull();
    expect(snapshot.breadth.advancersPct!).toBeLessThan(0.5); // everything bleeding
    expect(snapshot.spreadBps).toBeGreaterThan(0);
    expect(snapshot.fundingRiskAbnormal).toBe(false); // 1bp funding is calm
    // Report-only: the snapshot is recorded in the bounded store.
    expect(store.snapshots.length).toBe(1);
  });

  it("buildRegimeEngineReport aggregates counts and transitions", async () => {
    tmpStore();
    await runRegimeEngineCycle(fakeClient(), NOW);
    await runRegimeEngineCycle(fakeClient(), "2026-07-02T02:07:00.000Z");
    const report = buildRegimeEngineReport();
    expect(report.snapshotCount).toBe(2);
    expect(report.latest).not.toBeNull();
    expect(Object.values(report.regimeCounts).reduce((a, b) => a + b, 0)).toBe(2);
    expect(report.transitions.length).toBe(0); // same regime both cycles
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ContinuationDataCollector,
  parseBinanceKlineRows,
  parseBinanceWsKline,
} from "../src/lib/continuation-data-collector.js";
import { continuationLifecyclePaths, readCollectorHealth } from "../src/lib/continuation-lifecycle.js";

const dirs: string[] = [];
const NOW = 1_770_000_000_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "continuation-collector-"));
  dirs.push(dir);
  return dir;
}

function fetchFixture(urlText: string): Promise<unknown> {
  const url = new URL(urlText);
  const oneHour = NOW - 2 * 3_600_000;
  if (url.pathname.endsWith("/klines")) {
    return Promise.resolve([[oneHour, "100", "103", "99", "102", "120", oneHour + 3_599_999, "12240", 5, "64", "6528"]]);
  }
  if (url.pathname.endsWith("/fundingRate")) return Promise.resolve([{ fundingTime: oneHour, fundingRate: "0.0001" }]);
  if (url.pathname.endsWith("/premiumIndex")) return Promise.resolve({ time: oneHour, markPrice: "102", indexPrice: "101.8", lastFundingRate: "0.0001", nextFundingTime: NOW + 1 });
  if (url.pathname.endsWith("/openInterestHist")) return Promise.resolve([{ timestamp: oneHour, sumOpenInterest: "1000", sumOpenInterestValue: "102000" }]);
  if (url.pathname.endsWith("/takerlongshortRatio")) return Promise.resolve([{ timestamp: oneHour, buySellRatio: "1.2", buyVol: "60", sellVol: "50" }]);
  if (url.hostname === "api.bybit.com") return Promise.resolve({ result: { list: [[String(oneHour), "100", "103", "99", "102", "120"]] } });
  if (url.hostname === "www.okx.com") return Promise.resolve({ data: [[String(oneHour), "100", "103", "99", "102", "120"]] });
  if (url.hostname === "api.exchange.coinbase.com") return Promise.resolve([[Math.floor(oneHour / 1000), "99", "103", "100", "102", "120"]]);
  if (url.hostname === "www.deribit.com") return Promise.resolve({ result: { data: [[oneHour, 50, 52, 49, 51]] } });
  return Promise.reject(new Error(`unexpected URL ${urlText}`));
}

describe("continuation data collector", () => {
  it("accepts only completed, internally-consistent Binance klines", () => {
    const completed = parseBinanceKlineRows(
      [[NOW - 3_600_000, "100", "103", "99", "102", "120", NOW - 1, "", 5, "64", ""]],
      "BTCUSDT", "1h", NOW, NOW,
    );
    const incomplete = parseBinanceKlineRows(
      [[NOW - 3_600_000, "100", "103", "99", "102", "120", NOW + 1, "", 5, "64", ""]],
      "BTCUSDT", "1h", NOW, NOW,
    );
    const invalid = parseBinanceKlineRows(
      [[NOW - 3_600_000, "100", "99", "101", "102", "120", NOW - 1]], "BTCUSDT", "1h", NOW, NOW,
    );

    expect(completed).toHaveLength(1);
    expect(incomplete).toEqual([]);
    expect(invalid).toEqual([]);
  });

  it("uses REST for bootstrap/gap reconciliation, persists raw envelopes, and materializes V4-compatible views", async () => {
    const dir = root();
    const paths = continuationLifecyclePaths(dir);
    const collector = new ContinuationDataCollector({ paths, symbols: ["BTCUSDT"], nowMs: () => NOW, fetchJson: fetchFixture });
    const first = await collector.reconcileOnce(NOW);
    const second = await collector.reconcileOnce(NOW + 10_000);
    const health = readCollectorHealth(paths);

    expect(first.recorded).toBeGreaterThan(8);
    expect(second.recorded).toBe(0);
    expect(health?.sourceSummary["binance-usdm:kline_1h"]?.required).toBe(true);
    expect(health?.watermarks["binance-usdm:kline_1h:BTCUSDT"]?.duplicateCount).toBeGreaterThan(0);
    expect(existsSync(join(paths.materialized, "ohlcv", "BTCUSDT.json"))).toBe(true);
    expect(existsSync(join(paths.materialized, "funding", "BTCUSDT.json"))).toBe(true);
    expect(existsSync(join(paths.materialized, "raw", "bybit", "BTCUSDT.json"))).toBe(true);
    expect(existsSync(join(paths.materialized, "raw", "options", "DVOL_BTC.json"))).toBe(true);
    const ohlcv = JSON.parse(readFileSync(join(paths.materialized, "ohlcv", "BTCUSDT.json"), "utf8")) as unknown[][];
    expect(ohlcv).toHaveLength(1);
    expect(ohlcv[0]?.[4]).toBe(102);
  });

  it("ingests only final WebSocket candles and updates the same materialized series", () => {
    const dir = root();
    const paths = continuationLifecyclePaths(dir);
    const collector = new ContinuationDataCollector({ paths, symbols: ["BTCUSDT"], nowMs: () => NOW, fetchJson: fetchFixture });
    const message = {
      data: {
        e: "kline", s: "BTCUSDT",
        k: { t: NOW - 3_600_000, T: NOW - 1, i: "1h", o: "100", h: "103", l: "99", c: "102", v: "120", q: "12240", n: 5, V: "64", Q: "6528", x: true },
      },
    };
    expect(parseBinanceWsKline(message, NOW)).not.toBeNull();
    expect(collector.ingestWebsocketMessage(message, NOW)).toBe(true);
    expect(collector.ingestWebsocketMessage({ data: { ...message.data, k: { ...message.data.k, x: false } } }, NOW)).toBe(false);
    const rows = JSON.parse(readFileSync(join(paths.materialized, "ohlcv", "BTCUSDT.json"), "utf8")) as unknown[][];
    expect(rows).toHaveLength(1);
  });

  it("keeps an observed WebSocket gap unhealthy until REST covers the missing candle", async () => {
    const dir = root();
    const paths = continuationLifecyclePaths(dir);
    const collector = new ContinuationDataCollector({ paths, symbols: ["BTCUSDT"], nowMs: () => NOW, fetchJson: fetchFixture });
    const kline = (openTime: number) => ({
      data: {
        e: "kline", s: "BTCUSDT",
        k: { t: openTime, T: openTime + 3_599_999, i: "1h", o: "100", h: "103", l: "99", c: "102", v: "120", q: "12240", n: 5, V: "64", Q: "6528", x: true },
      },
    });
    expect(collector.ingestWebsocketMessage(kline(NOW - 3 * 3_600_000), NOW)).toBe(true);
    expect(collector.ingestWebsocketMessage(kline(NOW - 1 * 3_600_000), NOW)).toBe(true);
    collector.writeHealth(NOW);
    expect(readCollectorHealth(paths)?.watermarks["binance-usdm:kline_1h:BTCUSDT"]?.freshness).toBe("GAPPED");

    await collector.reconcileOnce(NOW);
    const repaired = readCollectorHealth(paths)?.watermarks["binance-usdm:kline_1h:BTCUSDT"];
    expect(repaired?.gapCount).toBe(1);
    expect(repaired?.unresolvedGapCount).toBe(0);
    expect(repaired?.freshness).toBe("HEALTHY");
  });
});

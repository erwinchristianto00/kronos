import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FuturesKline } from "../src/lib/binance-futures-private.js";
import {
  captureCrossSectionalClosedChartSnapshot,
  readCrossSectionalClosedChartSnapshotSvg,
  type CrossSectionalClosedChartSnapshotBasket,
} from "../src/lib/cross-sectional-closed-chart-snapshot.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "xsec-closed-chart-"));
  directories.push(value);
  return value;
}

function kline(openTime: number, close: number): FuturesKline {
  return { openTime, closeTime: openTime + 24 * 60 * 60_000 - 1, open: close - 0.2, high: close + 0.45, low: close - 0.5, close, volume: 100 };
}

describe("Cross-Sectional closed chart snapshot", () => {
  it("archives one immutable 1D panel per confirmed leg and omits an incomplete close-time candle", async () => {
    const day = 24 * 60 * 60_000;
    const base = Date.UTC(2026, 0, 1);
    const entryAt = base + 80 * day + 12 * 60 * 60_000;
    const exitAt = base + 118 * day + 18 * 60 * 60_000;
    const rows = Array.from({ length: 140 }, (_, index) => kline(base + index * day, 100 + index * 0.11));
    rows[118] = kline(base + 118 * day, 777); // opened before exit, but not complete then
    const calls: Array<{ interval: string }> = [];
    const basket: CrossSectionalClosedChartSnapshotBasket = {
      basketId: "xb-snapshot-abc123", openedAt: new Date(entryAt).toISOString(), closedAt: new Date(exitAt).toISOString(), signal: "MOM36_FILTERED", variant: "FILTERED",
      legs: [
        { symbol: "SOLUSDT", side: "LONG", entryPrice: 102.4, exitPrice: 105.1, entryPriceConfirmed: true, exitPriceConfirmed: true, entryFilledAt: new Date(entryAt).toISOString() },
        { symbol: "DOGEUSDT", side: "SHORT", entryPrice: 0.101, exitPrice: 0.098, entryPriceConfirmed: true, exitPriceConfirmed: true, entryFilledAt: new Date(entryAt + 1_000).toISOString() },
      ],
    };
    const archiveDirectory = directory();
    const snapshot = await captureCrossSectionalClosedChartSnapshot({
      directory: archiveDirectory,
      client: { getKlines: async (_symbol, interval) => { calls.push({ interval }); return rows; } },
      basket,
      nowMs: () => exitAt + 1_000,
    });
    expect(snapshot).toMatchObject({ status: "CAPTURED", assetFile: "xb-snapshot-abc123.svg", mimeType: "image/svg+xml", legCount: 2, exitAt: basket.closedAt });
    expect(calls.map((call) => call.interval)).toEqual(["1d", "1d"]);
    expect(existsSync(join(archiveDirectory, snapshot.assetFile!))).toBe(true);
    const svg = readFileSync(join(archiveDirectory, snapshot.assetFile!), "utf8");
    expect(svg).toContain("CROSS-SECTIONAL · CLOSED CHART SNAPSHOT");
    expect(svg).toContain("SOLUSDT · LONG · 1D");
    expect(svg).toContain("DOGEUSDT · SHORT · 1D");
    expect(svg).toContain("EMA20");
    expect(svg).toContain("Structural resistance");
    expect(svg).toContain('r="5" fill="#FFFFFF" stroke="#071016" stroke-width="2"');
    expect(svg).not.toContain(">777<");
    expect(readCrossSectionalClosedChartSnapshotSvg(archiveDirectory, snapshot)).toBe(svg);
  });

  it("serves a legacy execution-point color as white without changing the archived SVG", () => {
    const archiveDirectory = directory();
    const assetFile = "xb-snapshot-legacy.svg";
    const archived = '<svg><circle cx="1" cy="2" r="5" fill="#c4b5fd" stroke="#071016" stroke-width="2"/></svg>';
    writeFileSync(join(archiveDirectory, assetFile), archived, "utf8");
    const rendered = readCrossSectionalClosedChartSnapshotSvg(archiveDirectory, {
      version: "cross-sectional-closed-chart-svg-v1",
      status: "CAPTURED",
      requestedAt: "2026-08-30T00:00:00.000Z",
      capturedAt: "2026-08-30T00:00:00.000Z",
      source: "BINANCE_USDM_COMPLETED_CANDLES",
      entryAt: "2026-08-30T00:00:00.000Z",
      exitAt: "2026-08-30T01:00:00.000Z",
      assetFile,
      mimeType: "image/svg+xml",
      dailyCandleCount: 1,
      legCount: 1,
      reason: null,
    });
    expect(rendered).toContain('r="5" fill="#FFFFFF" stroke="#071016" stroke-width="2"');
    expect(readFileSync(join(archiveDirectory, assetFile), "utf8")).toBe(archived);
  });

  it("does not claim a chart where a leg exit fill is not exchange-confirmed", async () => {
    const at = Date.UTC(2026, 7, 30);
    const basket: CrossSectionalClosedChartSnapshotBasket = {
      basketId: "xb-snapshot-missing", openedAt: new Date(at).toISOString(), closedAt: new Date(at + 1).toISOString(), signal: "MOM36_FILTERED", variant: "FILTERED",
      legs: [{ symbol: "SOLUSDT", side: "LONG", entryPrice: 100, exitPrice: 101, entryPriceConfirmed: true, exitPriceConfirmed: false, entryFilledAt: new Date(at).toISOString() }],
    };
    const snapshot = await captureCrossSectionalClosedChartSnapshot({ directory: directory(), client: { getKlines: async () => [] }, basket });
    expect(snapshot.status).toBe("UNAVAILABLE");
    expect(snapshot.assetFile).toBeNull();
  });
});

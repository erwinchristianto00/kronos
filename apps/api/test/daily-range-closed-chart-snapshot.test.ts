import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FuturesKline } from "../src/lib/binance-futures-private.js";
import {
  captureDailyRangeClosedChartSnapshot,
  readDailyRangeClosedChartSnapshotSvg,
  type DailyRangeClosedChartSnapshotTrade,
} from "../src/lib/daily-range-closed-chart-snapshot.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "daily-range-closed-chart-"));
  directories.push(value);
  return value;
}

function kline(openTime: number, intervalMs: number, close: number): FuturesKline {
  return {
    openTime,
    closeTime: openTime + intervalMs - 1,
    open: close - 0.2,
    high: close + 0.45,
    low: close - 0.5,
    close,
    volume: 100,
  };
}

describe("Daily Range closed chart snapshot", () => {
  it("archives only completed 5m USD-M candles through the confirmed exit and renders one readable execution view", async () => {
    const fiveMinutes = 5 * 60_000;
    const fourHours = 4 * 60 * 60_000;
    const base = Date.UTC(2026, 7, 30, 0, 0, 0);
    const entryAt = base + 70 * fiveMinutes;
    const exitAt = base + 118 * fiveMinutes + 90_000;
    const fiveMinuteRows = Array.from({ length: 140 }, (_, index) => kline(base + index * fiveMinutes, fiveMinutes, 100 + index * 0.04));
    // This candle begins before the exit but does not finish before it. It is
    // deliberately adverse and must not leak into the close-time image.
    fiveMinuteRows.push(kline(base + 118 * fiveMinutes, fiveMinutes, 777));
    const fourHourRows = Array.from({ length: 96 }, (_, index) => kline(base - (95 - index) * fourHours, fourHours, 90 + index * 0.2));
    const calls: Array<{ interval: string; startTime?: number; endTime?: number }> = [];
    const client = {
      getKlines: async (_symbol: string, interval: "5m" | "4h", opts: { startTime?: number; endTime?: number } = {}) => {
        calls.push({ interval, ...opts });
        return interval === "5m" ? fiveMinuteRows : fourHourRows;
      },
    };
    const trade: DailyRangeClosedChartSnapshotTrade = {
      tradeId: "drra3-snapshot-abc123",
      symbol: "AAAUSDT",
      direction: "LONG",
      entryPolicy: "FADE",
      breakoutDirection: "DOWN",
      entrySubmittedAt: new Date(entryAt - 1_000).toISOString(),
      entryFilledAt: new Date(entryAt).toISOString(),
      entryFillPrice: 102.8,
      exitTimestamp: new Date(exitAt).toISOString(),
      exitPrice: 103.2,
      rangeHigh: 102,
      rangeLow: 98,
      stopPrice: 100.4,
      takeProfitPrice: 107.6,
      // A fractional structural target must not leak an unreadable raw
      // floating-point R value into the visual legend.
      rrTarget: 0.406967644180422,
      referenceTimezone: "America/New_York",
      referenceRangeOpenTime: base,
      referenceRangeCloseTime: base + fourHours,
      confirmationBar1: kline(base + 66 * fiveMinutes, fiveMinutes, 97.8),
      // C2 may accept directly at the 4H boundary. The picture must show
      // that honestly as one coincident level rather than stacked lines.
      confirmationBar2: kline(base + 67 * fiveMinutes, fiveMinutes, 98),
    };

    const archiveDirectory = directory();
    const snapshot = await captureDailyRangeClosedChartSnapshot({
      directory: archiveDirectory,
      client,
      trade,
      nowMs: () => exitAt + 1_000,
    });

    expect(snapshot).toMatchObject({
      status: "CAPTURED",
      assetFile: "drra3-snapshot-abc123.svg",
      mimeType: "image/svg+xml",
      entryAt: trade.entryFilledAt,
      exitAt: trade.exitTimestamp,
    });
    expect(snapshot.fiveMinuteCandleCount).toBeLessThan(fiveMinuteRows.length + 2);
    expect(snapshot.fourHourCandleCount).toBe(0);
    expect(calls.map((call) => call.interval)).toEqual(["5m"]);
    expect(existsSync(join(archiveDirectory, snapshot.assetFile!))).toBe(true);
    const svg = readFileSync(join(archiveDirectory, snapshot.assetFile!), "utf8");
    expect(svg).toContain("DAILY RANGE 4H · 5M TRADE SNAPSHOT");
    expect(svg).toContain("5m · actual execution path");
    expect(svg).not.toContain("4H · EMA20/EMA50 + structural support / resistance");
    expect(svg).toContain("C1 breakout");
    expect(svg).toContain("C2 acceptance");
    expect(svg).toContain("Stop");
    expect(svg).toContain("Target");
    expect(svg).not.toContain('text-anchor="end">C1 breakout</text>');
    expect(svg).not.toContain('text-anchor="start">C2 acceptance</text>');
    expect(svg).not.toContain('text-anchor="end">ENTRY LONG</text>');
    expect(svg).not.toContain('text-anchor="start">EXIT</text>');
    expect(svg).not.toContain("Native 2R TP");
    expect(svg).not.toContain("0.406967644180422R");
    expect(svg).toContain("4H breakdown = C2 acceptance");
    expect(svg).toContain("4H ref");
    expect(svg).not.toContain("4H range high");
    expect(svg).not.toContain("4H range low");
    expect(svg).toContain("Entry LONG");
    expect(svg).toContain("Exit");
    expect(svg).not.toContain(">777<");
    expect(readDailyRangeClosedChartSnapshotSvg(archiveDirectory, snapshot)).toBe(svg);
  });

  it("does not create an image or claim a close-time snapshot without ordered confirmed fills", async () => {
    const at = Date.UTC(2026, 7, 30, 0, 0, 0);
    const trade: DailyRangeClosedChartSnapshotTrade = {
      tradeId: "drra3-snapshot-missing",
      symbol: "AAAUSDT",
      direction: "SHORT",
      entrySubmittedAt: new Date(at).toISOString(),
      entryFilledAt: null,
      entryFillPrice: null,
      exitTimestamp: new Date(at + 1).toISOString(),
      exitPrice: 99,
      rangeHigh: 101,
      rangeLow: 98,
      stopPrice: 102,
      takeProfitPrice: 96,
      rrTarget: 2,
      confirmationBar1: kline(at, 5 * 60_000, 101),
      confirmationBar2: kline(at + 5 * 60_000, 5 * 60_000, 100),
    };
    const archiveDirectory = directory();
    const snapshot = await captureDailyRangeClosedChartSnapshot({
      directory: archiveDirectory,
      client: { getKlines: async () => [] },
      trade,
    });
    expect(snapshot.status).toBe("UNAVAILABLE");
    expect(snapshot.assetFile).toBeNull();
    expect(readDailyRangeClosedChartSnapshotSvg(archiveDirectory, snapshot)).toBeNull();
  });
});

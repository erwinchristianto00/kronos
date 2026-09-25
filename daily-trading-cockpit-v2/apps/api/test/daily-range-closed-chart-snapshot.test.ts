import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("archives completed 5m candles through C2, then contiguous completed 1m candles through the confirmed exit", async () => {
    const fiveMinutes = 5 * 60_000;
    const fourHours = 4 * 60 * 60_000;
    const base = Date.UTC(2026, 7, 30, 0, 0, 0);
    const entryAt = base + 70 * fiveMinutes;
    const exitAt = base + 118 * fiveMinutes + 90_000;
    const fiveMinuteRows = Array.from({ length: 140 }, (_, index) => kline(base + index * fiveMinutes, fiveMinutes, 100 + index * 0.04));
    // This candle begins before the exit but does not finish before it. It is
    // deliberately adverse and must not leak into the close-time image.
    fiveMinuteRows.push(kline(base + 118 * fiveMinutes, fiveMinutes, 777));
    const c2CloseAt = base + 68 * fiveMinutes;
    const oneMinuteRows = Array.from({ length: Math.ceil((exitAt - c2CloseAt) / 60_000) }, (_, index) =>
      kline(c2CloseAt + index * 60_000, 60_000, 102 + index * 0.01),
    );
    // This 1m candle was still open at exit and is therefore forbidden from
    // the archive even though the historical endpoint can return it later.
    oneMinuteRows.push(kline(Math.floor(exitAt / 60_000) * 60_000, 60_000, 777));
    const fourHourRows = Array.from({ length: 96 }, (_, index) => kline(base - (95 - index) * fourHours, fourHours, 90 + index * 0.2));
    const calls: Array<{ interval: string; startTime?: number; endTime?: number }> = [];
    const client = {
      getKlines: async (_symbol: string, interval: "1m" | "5m" | "4h", opts: { startTime?: number; endTime?: number } = {}) => {
        calls.push({ interval, ...opts });
        return interval === "5m" ? fiveMinuteRows : interval === "1m" ? oneMinuteRows : fourHourRows;
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
      initialRiskPrice: 2.4,
      fadeRTrail: {
        trailArmedAt: new Date(c2CloseAt + 5 * 60_000 + 15_000).toISOString(),
        armThresholdR: 0.5,
      },
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
    expect(snapshot.oneMinuteCandleCount).toBeGreaterThan(0);
    expect(snapshot.fourHourCandleCount).toBe(0);
    expect(calls.map((call) => call.interval)).toEqual(["5m", "1m"]);
    expect(existsSync(join(archiveDirectory, snapshot.assetFile!))).toBe(true);
    const svg = readFileSync(join(archiveDirectory, snapshot.assetFile!), "utf8");
    expect(svg).toContain("DAILY RANGE 4H · 5M/1M TRADE SNAPSHOT");
    expect(svg).toContain("5m → 1m · actual execution path");
    expect(svg).not.toContain("4H · EMA20/EMA50 + structural support / resistance");
    expect(svg).toContain("C1 breakout");
    expect(svg).toContain("C2 acceptance");
    expect(svg).toContain("Stop");
    expect(svg).toContain("TP trigger");
    expect(svg).toContain("Actual exit fill");
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
    expect(svg).toContain('data-execution-clarity="v7"');
    expect(svg).toContain('data-execution-marker="C1"');
    expect(svg).toContain('data-execution-marker="C2"');
    expect(svg).toContain('data-execution-marker="ENTRY"');
    expect(svg).toContain('data-execution-marker="EXIT"');
    expect(svg).toContain('data-execution-marker="ARM"');
    expect(svg).toContain(">C1</text>");
    expect(svg).toContain(">C2</text>");
    expect(svg).toContain("C1 breakout close");
    expect(svg).toContain("C2 acceptance close");
    expect(svg).toContain("Entry LONG fill");
    expect(svg).toContain("Exit fill");
    expect(svg).toContain("1m candles after C2 close");
    expect(svg).toContain("1m partial to exit · no synthetic candle");
    expect(svg).toContain('r="5" fill="#FFFFFF" stroke="#071016" stroke-width="2"');
    expect(svg).toContain('r="3" fill="#FFFFFF"');
    expect(svg).not.toContain(">777<");
    expect(svg).toContain(`data-execution-marker="C1" data-marker-candle-open="${trade.confirmationBar1.openTime}" data-marker-anchor="low"`);
    expect(svg).toContain(`data-execution-marker="C2" data-marker-candle-open="${trade.confirmationBar2.openTime}" data-marker-anchor="high"`);
    expect(svg).toContain(`data-execution-marker="ARM" data-marker-candle-open="${c2CloseAt + 5 * 60_000}" data-marker-anchor="high"`);
    expect(svg).toContain("MFE arm +0.50R");
    expect(snapshot.version).toBe("daily-range-closed-chart-svg-v7");
    expect(readDailyRangeClosedChartSnapshotSvg(archiveDirectory, snapshot)).toBe(svg);
  });

  it("serves legacy execution dots in white without rewriting the archived SVG", () => {
    const archiveDirectory = directory();
    const assetFile = "drra3-snapshot-legacy.svg";
    const archived = '<svg><circle cx="1" cy="2" r="5" fill="#f8fafc" stroke="#071016" stroke-width="2"/><circle cx="3" cy="4" r="5" fill="#c4b5fd" stroke="#071016" stroke-width="2"/><circle cx="5" cy="6" r="3" fill="#c4b5fd"/></svg>';
    writeFileSync(join(archiveDirectory, assetFile), archived, "utf8");
    const rendered = readDailyRangeClosedChartSnapshotSvg(archiveDirectory, {
      version: "daily-range-closed-chart-svg-v5",
      status: "CAPTURED",
      requestedAt: "2026-08-30T00:00:00.000Z",
      capturedAt: "2026-08-30T00:00:00.000Z",
      source: "BINANCE_USDM_COMPLETED_CANDLES",
      entryAt: "2026-08-30T00:00:00.000Z",
      exitAt: "2026-08-30T01:00:00.000Z",
      assetFile,
      mimeType: "image/svg+xml",
      fiveMinuteCandleCount: 1,
      fourHourCandleCount: 0,
      reason: null,
    });
    expect(rendered).toContain('r="5" fill="#FFFFFF" stroke="#071016" stroke-width="2"');
    expect(rendered).toContain('r="3" fill="#FFFFFF"');
    expect(readFileSync(join(archiveDirectory, assetFile), "utf8")).toBe(archived);
  });

  it("upgrades a legacy chart response with non-overlapping C1/C2 markers and an explicit incomplete-final-bar cue", () => {
    const archiveDirectory = directory();
    const assetFile = "drra3-snapshot-clarity-legacy.svg";
    const base = Date.UTC(2026, 7, 30, 0, 0, 0);
    const fiveMinutes = 5 * 60_000;
    const entryAt = base + 2 * fiveMinutes + 19_000;
    const exitAt = base + 4 * fiveMinutes + 46_000;
    const archived = '<svg><clipPath id="clip-32-74"><rect x="104" y="156" width="1316" height="570"/></clipPath><text>C1 breakout · 30/08 08:10 · 100.000000</text><text>C2 acceptance · 30/08 08:15 · 99.500000</text><text>Entry SHORT · 30/08 08:15 · 99.500000</text><text>Exit · 30/08 08:20 · 98.900000</text><text>Target 98.800000</text><text>Exit 98.900000</text><text>C1 breakout</text><text>C2 continuation</text><text>ENTRY SHORT</text><text>EXIT</text><line x1="190" y1="260" x2="190" y2="320" stroke="#5ce4a6" stroke-width="1.2"/><line x1="230" y1="280" x2="230" y2="340" stroke="#ff777d" stroke-width="1.2"/><polygon points="200,294 195,304 205,304" fill="#6fb3d6" stroke="#071016" stroke-width="1"/><polygon points="240,316 235,306 245,306" fill="#78c8ff" stroke="#071016" stroke-width="1"/><circle cx="242" cy="310" r="5" fill="#f8fafc" stroke="#071016" stroke-width="2"/><circle cx="300" cy="430" r="5" fill="#c4b5fd" stroke="#071016" stroke-width="2"/></svg>';
    writeFileSync(join(archiveDirectory, assetFile), archived, "utf8");
    const trade: DailyRangeClosedChartSnapshotTrade = {
      tradeId: "drra3-snapshot-clarity-legacy",
      symbol: "AAAUSDT",
      direction: "SHORT",
      entryPolicy: "FADE",
      breakoutDirection: "UP",
      entrySubmittedAt: new Date(entryAt - 1_000).toISOString(),
      entryFilledAt: new Date(entryAt).toISOString(),
      entryFillPrice: 99.5,
      exitTimestamp: new Date(exitAt).toISOString(),
      exitPrice: 98.9,
      rangeHigh: 100,
      rangeLow: 95,
      stopPrice: 101,
      takeProfitPrice: 98.8,
      rrTarget: 2,
      confirmationBar1: kline(base + fiveMinutes, fiveMinutes, 100),
      confirmationBar2: kline(base + 2 * fiveMinutes, fiveMinutes, 99.5),
    };
    const rendered = readDailyRangeClosedChartSnapshotSvg(archiveDirectory, {
      version: "daily-range-closed-chart-svg-v5",
      status: "CAPTURED",
      requestedAt: new Date(exitAt).toISOString(),
      capturedAt: new Date(exitAt).toISOString(),
      source: "BINANCE_USDM_COMPLETED_CANDLES",
      entryAt: trade.entryFilledAt,
      exitAt: trade.exitTimestamp,
      assetFile,
      mimeType: "image/svg+xml",
      fiveMinuteCandleCount: 4,
      fourHourCandleCount: 0,
      reason: null,
    }, trade);

    expect(rendered).toContain('data-execution-clarity="legacy-v6"');
    expect(rendered).toContain("C1 breakout close");
    expect(rendered).toContain("C2 acceptance close");
    expect(rendered).toContain("Entry SHORT fill");
    expect(rendered).toContain("Exit fill · 30/08 08:20:46 · 98.9000");
    expect(rendered).toContain("TP trigger 98.800000");
    expect(rendered).toContain("Actual exit fill 98.900000");
    expect(rendered).toContain(">C1</text>");
    expect(rendered).toContain(">C2</text>");
    expect(rendered).toContain('data-execution-marker="C1" data-marker-candle-x="190" data-marker-anchor="high"');
    expect(rendered).toContain('data-execution-marker="C2" data-marker-candle-x="230" data-marker-anchor="low"');
    expect(rendered).toContain("5m partial at exit; no candle");
    expect(rendered).not.toContain("30/08  08:");
    expect(rendered).not.toContain(">C1 breakout</text>");
    expect(rendered).not.toContain(">C2 continuation</text>");
    expect(rendered).not.toContain(">ENTRY SHORT</text>");
    expect(rendered).not.toContain(">EXIT</text>");
    expect(readFileSync(join(archiveDirectory, assetFile), "utf8")).toBe(archived);
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

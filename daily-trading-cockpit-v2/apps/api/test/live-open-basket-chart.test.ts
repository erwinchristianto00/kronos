import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerLiveRoutes } from "../src/routes/live.js";

describe("GET /api/live/open-basket-chart", () => {
  it("returns only the fixed review window from the injected public USD-M source", async () => {
    const marketCandles = vi.fn(async () => [{
      openTime: 1_700_000_000_000,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 12,
    }]);
    const app = Fastify();
    await registerLiveRoutes(app, null, { marketCandles });
    try {
      const response = await app.inject({ method: "GET", url: "/api/live/open-basket-chart?symbol=solusdt&interval=1h" });
      expect(response.statusCode).toBe(200);
      expect(marketCandles).toHaveBeenCalledWith("SOLUSDT", "1h", 168);
      expect(response.json()).toMatchObject({
        ok: true,
        symbol: "SOLUSDT",
        interval: "1h",
        source: "BINANCE_USDM_PUBLIC",
        completedOnly: true,
        candles: [{ openTime: 1_700_000_000_000, close: 101 }],
      });
    } finally {
      await app.close();
    }
  });

  it("serves the bounded 5m review window", async () => {
    const marketCandles = vi.fn(async () => []);
    const app = Fastify();
    await registerLiveRoutes(app, null, { marketCandles });
    try {
      const response = await app.inject({ method: "GET", url: "/api/live/open-basket-chart?symbol=SOLUSDT&interval=5m" });
      expect(response.statusCode).toBe(200);
      expect(marketCandles).toHaveBeenCalledWith("SOLUSDT", "5m", 576);
    } finally {
      await app.close();
    }
  });

  it("returns completed 1d and 5m history plus yesterday's exact UTC 00:00 4h range", async () => {
    const nowMs = Date.UTC(2026, 7, 26, 12, 0, 0);
    const previousUtcDayStartMs = Date.UTC(2026, 7, 25, 0, 0, 0);
    const marketCandles = vi.fn(async (_symbol: string, interval: string) => {
      if (interval === "1d") return [{
        openTime: Date.UTC(2026, 7, 24, 0, 0, 0), open: 90, high: 105, low: 88, close: 101, volume: 100,
      }];
      if (interval === "5m") return [{
        openTime: Date.UTC(2026, 7, 26, 11, 55, 0), open: 101, high: 103, low: 100, close: 102, volume: 12,
      }];
      if (interval === "4h") return [{
        openTime: previousUtcDayStartMs, open: 100, high: 110, low: 95, close: 106, volume: 77,
      }];
      return [];
    });
    const app = Fastify();
    await registerLiveRoutes(app, null, { marketCandles, openBasketChartNowMs: () => nowMs });
    try {
      const response = await app.inject({ method: "GET", url: "/api/live/open-basket-chart?symbol=solusdt" });
      expect(response.statusCode).toBe(200);
      expect(marketCandles).toHaveBeenCalledWith("SOLUSDT", "1d", 120);
      expect(marketCandles).toHaveBeenCalledWith("SOLUSDT", "5m", 576);
      expect(marketCandles).toHaveBeenCalledWith("SOLUSDT", "4h", 18);
      expect(response.json()).toMatchObject({
        ok: true,
        symbol: "SOLUSDT",
        completedOnly: true,
        daily: { interval: "1d", candles: [{ close: 101 }] },
        fiveMinute: { interval: "5m", candles: [{ close: 102 }] },
        previousUtcReference4h: {
          dateUtc: "2026-08-25",
          fourHourOpenTime: previousUtcDayStartMs,
          fourHourCloseTime: previousUtcDayStartMs + 4 * 60 * 60_000,
          rangeHigh: 110,
          rangeLow: 95,
        },
        referenceReason: null,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a truly unsupported timeframe before it reaches the market source", async () => {
    const marketCandles = vi.fn(async () => []);
    const app = Fastify();
    await registerLiveRoutes(app, null, { marketCandles });
    try {
      const response = await app.inject({ method: "GET", url: "/api/live/open-basket-chart?symbol=SOLUSDT&interval=7m" });
      expect(response.statusCode).toBe(400);
      expect(marketCandles).not.toHaveBeenCalled();
      expect(response.json()).toMatchObject({ ok: false, reason: "interval must be one of 5m, 15m, 1h, 4h, 1d" });
    } finally {
      await app.close();
    }
  });
});

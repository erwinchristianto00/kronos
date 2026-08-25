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

  it("rejects an arbitrary timeframe before it reaches the market source", async () => {
    const marketCandles = vi.fn(async () => []);
    const app = Fastify();
    await registerLiveRoutes(app, null, { marketCandles });
    try {
      const response = await app.inject({ method: "GET", url: "/api/live/open-basket-chart?symbol=SOLUSDT&interval=5m" });
      expect(response.statusCode).toBe(400);
      expect(marketCandles).not.toHaveBeenCalled();
      expect(response.json()).toMatchObject({ ok: false, reason: "interval must be one of 15m, 1h, 4h" });
    } finally {
      await app.close();
    }
  });
});

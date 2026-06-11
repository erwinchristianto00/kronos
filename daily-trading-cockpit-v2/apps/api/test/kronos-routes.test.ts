import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

function makeKlines(intervalMs: number) {
  const latestOpenTime = Date.now() - intervalMs;
  const startTime = latestOpenTime - intervalMs * 149;
  return Array.from({ length: 150 }, (_, index) => {
    const close = 100 + index * 0.5;
    return [
      startTime + index * intervalMs,
      String(close - 0.25),
      String(close + 0.5),
      String(close - 0.5),
      String(close),
      String(1_000 + index * 10),
      startTime + (index + 1) * intervalMs,
      "0",
      0,
      "0",
      "0",
      "0",
    ];
  });
}

describe("Kronos routes", () => {
  it("reports degraded Kronos health when predict failures dominate", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      if (url.endsWith("/predict")) {
        return new Response(
          JSON.stringify({
            available: false,
            reason: "prediction failed",
            availabilityReasonCode: "PREDICTION_FAILED",
            debugSymbol: "BTCUSDT",
            debugTimeframe: "1h",
            rawErrorMessage: "shape mismatch",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/v3/klines")) {
        return new Response(JSON.stringify(makeKlines(60 * 60 * 1000)), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", volume: "5000000", quoteVolume: "250000000" }), {
          status: 200,
        });
      }
      if (url.includes("/api/v3/ticker/bookTicker")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", bidPrice: "100.00", askPrice: "100.02" }), {
          status: 200,
        });
      }
      throw new Error(`Unhandled URL: ${url} ${init?.method ?? "GET"}`);
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    await app.inject({ method: "GET", url: "/api/scan" });
    const response = await app.inject({ method: "GET", url: "/api/kronos/health" });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.state).toBe("DEGRADED");
    expect(payload.reachable).toBe(true);
    expect(payload.predictionFailed).toBeGreaterThan(0);

    await app.close();
  });

  it("returns baseline and requested symbol diagnostics from test-symbol", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      if (url.endsWith("/predict")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { symbol?: string };
        if (body.symbol === "FAILUSDT") {
          return new Response(
            JSON.stringify({
              available: false,
              reason: "unsupported symbol",
              availabilityReasonCode: "UNSUPPORTED_SYMBOL",
              debugSymbol: "FAILUSDT",
              debugTimeframe: "1h",
              debugCandleCount: 150,
              rawErrorMessage: "symbol unsupported",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            kronosLongProbability: 66,
            kronosShortProbability: 34,
            kronosConfidence: 62,
            expectedReturn3: 0.8,
            expectedReturn6: 1.4,
            expectedVolatility: 1.1,
            kronosRisk: 21,
            kronosBias: "LONG",
            currentPrice: 100,
            forecastMedianClose: 101.3,
            forecastP25Close: 99.9,
            forecastP75Close: 102.4,
            forecastMaxHigh: 103.2,
            forecastMinLow: 98.8,
            expectedReturn1h: 1.1,
            expectedReturn4h: 2.5,
            probabilityUp: 64,
            probabilityDown: 30,
            kronosConfidenceBucket: "MEDIUM",
            kronosBias1h: "LONG",
            kronosBias4h: "LONG",
            selectedKronosBias: "LONG",
            horizonConflict: false,
            debugSymbol: "BTCUSDT",
            debugTimeframe: "1h",
            debugCandleCount: 150,
            debugFirstTimestamp: 1000,
            debugLastTimestamp: 2000,
            debugLastClose: 100,
            debugRequestShape: "150x5",
            debugCandleSource: "binance.getCandles",
            debugLast3Closes: [173.5, 174, 174.5],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/v3/klines")) {
        return new Response(JSON.stringify(makeKlines(60 * 60 * 1000)), { status: 200 });
      }
      throw new Error(`Unhandled URL: ${url}`);
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/kronos/test-symbol",
      payload: {
        symbol: "FAILUSDT",
        timeframe: "1h",
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.baseline.modelCall.available).toBe(true);
    expect(payload.baseline.inputValidation.candleSource).toBe("binance.getCandles");
    expect(payload.baseline.inputValidation.last3Closes).toHaveLength(3);
    expect(payload.requested.modelCall.available).toBe(false);
    expect(payload.requested.modelCall.failureCode).toBe("UNSUPPORTED_SYMBOL");

    await app.close();
  });

  it("returns INVALID_INPUT before model call when Binance candles end with zero close", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      if (url.endsWith("/predict")) {
        throw new Error(`predict should not be called for invalid input: ${String(init?.body ?? "")}`);
      }
      if (url.includes("/api/v3/klines")) {
        const klines = makeKlines(60 * 60 * 1000);
        klines[klines.length - 1][4] = "0";
        return new Response(JSON.stringify(klines), { status: 200 });
      }
      throw new Error(`Unhandled URL: ${url}`);
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/kronos/test-symbol",
      payload: {
        symbol: "BTCUSDT",
        timeframe: "1h",
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.baseline.inputValidation.valid).toBe(false);
    expect(payload.baseline.inputValidation.lastClose).toBe(0);
    expect(payload.baseline.modelCall.failureCode).toBe("INVALID_INPUT");
    expect(payload.requested.modelCall.failureCode).toBe("INVALID_INPUT");
    expect(fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining("/predict"),
      expect.anything(),
    );

    await app.close();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpKronosClient } from "../src/lib/kronos.js";

describe("HttpKronosClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.KRONOS_HEALTH_WINDOW_MS;
  });

  it("accepts a valid Kronos response and preserves score-bearing fields", async () => {
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          kronosLongProbability: 78,
          kronosShortProbability: 22,
          kronosConfidence: 70,
          expectedReturn3: 1.4,
          expectedReturn6: 2.1,
          expectedVolatility: 1.8,
          kronosRisk: 28,
          kronosBias: "LONG",
          currentPrice: 100,
          forecastMedianClose: 101.2,
          forecastP25Close: 99.8,
          forecastP75Close: 102.4,
          forecastMaxHigh: 104.7,
          forecastMinLow: 97.5,
          expectedReturn15m: 0.4,
          expectedReturn1h: 1.1,
          expectedReturn4h: 2.9,
          probabilityUp: 64,
          probabilityDown: 31,
          kronosConfidenceBucket: "MEDIUM",
        }),
        { status: 200 },
      );
    };

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    const prediction = await client.predict("BTCUSDT", "1h", [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
    ]);

    expect(prediction.available).toBe(true);
    expect(prediction.kronosLongProbability).toBe(78);
    expect(prediction.kronosBias).toBe("LONG");
    expect(prediction.selectedKronosBias).toBe("LONG");
    expect(prediction.kronosConfidence).toBe(70);
    expect(prediction.forecastMedianClose).toBe(101.2);
    expect(prediction.probabilityUp).toBe(64);
    expect(prediction.kronosConfidenceBucket).toBe("MEDIUM");
  });

  it("ignores invalid Kronos responses instead of fabricating a score", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          kronosLongProbability: 80,
          reason: "missing required fields",
        }),
        { status: 200 },
      );

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    const prediction = await client.predict("BTCUSDT", "1h", [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
    ]);

    expect(prediction.available).toBe(false);
    expect(prediction.reason).toBe("prediction failed");
    expect(prediction.availabilityReasonCode).toBe("PREDICTION_FAILED");
  });

  it("classifies busy and unsupported Kronos failures for candidate-level diagnostics", async () => {
    const busyFetch = async () => new Response("busy", { status: 503 });
    const busyClient = new HttpKronosClient("http://localhost:8001", busyFetch as typeof fetch);
    const busyPrediction = await busyClient.predict("BTCUSDT", "1h", [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
    ]);

    expect(busyPrediction.available).toBe(false);
    expect(busyPrediction.availabilityReasonCode).toBe("MODEL_BUSY");
    expect(busyPrediction.reason).toBe("model busy");

    const unsupportedFetch = async () =>
      new Response(JSON.stringify({ reason: "Unsupported Kronos timeframe 2h." }), { status: 200 });
    const unsupportedClient = new HttpKronosClient("http://localhost:8001", unsupportedFetch as typeof fetch);
    const unsupportedPrediction = await unsupportedClient.predict("BTCUSDT", "1h", [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
    ]);

    expect(unsupportedPrediction.available).toBe(false);
    expect(unsupportedPrediction.availabilityReasonCode).toBe("UNSUPPORTED_SYMBOL");
    expect(unsupportedPrediction.reason).toBe("unsupported symbol");
  });

  it("marks Kronos degraded when health is reachable but recent predict success rate is poor", async () => {
    const fetchImpl = async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          available: false,
          reason: "prediction failed",
          availabilityReasonCode: "PREDICTION_FAILED",
          debugSymbol: "BTCUSDT",
          debugTimeframe: "1h",
          debugCandleCount: 150,
          rawErrorMessage: "tensor shape mismatch",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    await client.predict("BTCUSDT", "1h", [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
    ]);

    const availability = await client.availability();
    expect(availability.reachable).toBe(true);
    expect(availability.state).toBe("DEGRADED");
    expect(availability.available).toBe(false);
    expect(availability.predictionFailed).toBe(1);
    expect(availability.successRate).toBe(0);
  });

  it("exposes debug details for test-symbol and degraded sampling flows", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          kronosLongProbability: 61,
          kronosShortProbability: 39,
          kronosConfidence: 58,
          expectedReturn3: 0.9,
          expectedReturn6: 1.6,
          expectedVolatility: 1.2,
          kronosRisk: 24,
          kronosBias: "LONG",
          currentPrice: 100,
          forecastMedianClose: 101,
          forecastP25Close: 99.5,
          forecastP75Close: 102.3,
          forecastMaxHigh: 103.5,
          forecastMinLow: 98.9,
          expectedReturn1h: 1.1,
          expectedReturn4h: 2.4,
          probabilityUp: 63,
          probabilityDown: 31,
          kronosConfidenceBucket: "MEDIUM",
          kronosBias1h: "LONG",
          kronosBias4h: "LONG",
          selectedKronosBias: "LONG",
          horizonConflict: false,
          degradedSampling: true,
          debugSymbol: "BTCUSDT",
          debugTimeframe: "1h",
          debugCandleCount: 150,
          debugFirstTimestamp: 1000,
          debugLastTimestamp: 2000,
          debugLastClose: 100,
          debugRequestShape: "150x5",
          debugCandleSource: "binance.getCandles",
          debugLast3Closes: [99, 99.5, 100],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    const report = await client.testSymbol("BTCUSDT", "1h", [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
    ]);

    expect(report.inputValidation.valid).toBe(true);
    expect(report.inputValidation.candleSource).toBe("binance.getCandles");
    expect(report.inputValidation.last3Closes).toEqual([99, 99.5, 100]);
    expect(report.modelCall.degradedSampling).toBe(true);
    expect(report.forecastShape.bias).toBe("LONG");
    expect(report.forecastShape.bias1h).toBe("LONG");
    expect(report.forecastShape.bias4h).toBe("LONG");
    expect(report.derivedDiagnostics.expectedReturn1h).toBe(1.1);
    expect(report.derivedDiagnostics.horizonConflict).toBe(false);
  });

  it("deduplicates identical in-flight predict requests", async () => {
    let predictCalls = 0;
    const fetchImpl = async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      predictCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(
        JSON.stringify({
          kronosLongProbability: 64,
          kronosShortProbability: 36,
          kronosConfidence: 55,
          expectedVolatility: 1.2,
          kronosRisk: 22,
          kronosBias: "LONG",
          currentPrice: 100,
          forecastMedianClose: 101,
          probabilityUp: 60,
          probabilityDown: 40,
          expectedReturn1h: 1,
          expectedReturn4h: 2,
          kronosConfidenceBucket: "MEDIUM",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    const candles = [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
      { openTime: 2000, open: 100, high: 102, low: 99, close: 101, volume: 1_100 },
    ];

    const [first, second] = await Promise.all([
      client.predict("BTCUSDT", "1h", candles),
      client.predict("BTCUSDT", "1h", candles),
    ]);

    expect(first.available).toBe(true);
    expect(second.available).toBe(true);
    expect(predictCalls).toBe(1);
  });

  it("falls back quickly when Kronos queue wait exceeds the scan budget", async () => {
    let predictCalls = 0;
    const fetchImpl = async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      predictCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return new Response(
        JSON.stringify({
          kronosLongProbability: 64,
          kronosShortProbability: 36,
          kronosConfidence: 55,
          expectedVolatility: 1.2,
          kronosRisk: 22,
          kronosBias: "LONG",
          currentPrice: 100,
          forecastMedianClose: 101,
          probabilityUp: 60,
          probabilityDown: 40,
          expectedReturn1h: 1,
          expectedReturn4h: 2,
          kronosConfidenceBucket: "MEDIUM",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    const candlesA = [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
      { openTime: 2000, open: 100, high: 102, low: 99, close: 101, volume: 1_100 },
    ];
    const candlesB = [
      { openTime: 1000, open: 49, high: 51, low: 48, close: 50, volume: 900 },
      { openTime: 2000, open: 50, high: 52, low: 49, close: 51, volume: 950 },
    ];

    const first = client.predict("BTCUSDT", "1h", candlesA, { requestTimeoutMs: 200, queueTimeoutMs: 200 });
    const second = client.predict("ETHUSDT", "1h", candlesB, {
      requestTimeoutMs: 200,
      queueTimeoutMs: 10,
      preferStaleOnTimeout: true,
    });
    const [, queuedOut] = await Promise.all([first, second]);

    expect(queuedOut.available).toBe(false);
    expect(queuedOut.availabilityReasonCode).toBe("TIMEOUT");
    expect(queuedOut.reason).toContain("timeout");
    expect(predictCalls).toBe(1);
  });

  it("drops stale failed attempts from Kronos health window", async () => {
    vi.useFakeTimers();
    process.env.KRONOS_HEALTH_WINDOW_MS = "60000";

    let mode: "fail" | "success" = "fail";
    const fetchImpl = async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      if (mode === "fail") {
        return new Response(
          JSON.stringify({
            available: false,
            reason: "prediction failed",
            availabilityReasonCode: "PREDICTION_FAILED",
            rawErrorMessage: "shape mismatch",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          kronosLongProbability: 64,
          kronosShortProbability: 36,
          kronosConfidence: 55,
          expectedVolatility: 1.2,
          kronosRisk: 22,
          kronosBias: "LONG",
          currentPrice: 100,
          forecastMedianClose: 101,
          probabilityUp: 60,
          probabilityDown: 40,
          expectedReturn1h: 1,
          expectedReturn4h: 2,
          kronosConfidenceBucket: "MEDIUM",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    const candles = [{ openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 }];

    await client.predict("BTCUSDT", "1h", candles);
    let availability = await client.availability();
    expect(availability.state).toBe("DEGRADED");

    vi.advanceTimersByTime(61_000);
    mode = "success";
    await client.predict("BTCUSDT", "1h", candles);
    availability = await client.availability();
    expect(availability.state).toBe("FORECAST_HEALTHY");
    expect(availability.succeeded).toBe(1);
    expect(availability.failed).toBe(0);
  });

  it("rejects lastClose zero before Kronos model call", async () => {
    const fetchImpl = async () => {
      throw new Error("model should not be called for invalid candles");
    };

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    const report = await client.testSymbol("BTCUSDT", "1h", [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 0, volume: 1_000 },
    ]);

    expect(report.inputValidation.valid).toBe(false);
    expect(report.inputValidation.lastClose).toBe(0);
    expect(report.modelCall.failureCode).toBe("INVALID_INPUT");
  });

  it("preserves forecast horizon consistency diagnostics from Kronos", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          kronosLongProbability: 70,
          kronosShortProbability: 30,
          kronosConfidence: 66,
          expectedVolatility: 1.4,
          kronosRisk: 20,
          currentPrice: 100,
          forecastMedianClose: 103,
          forecastP25Close: 99,
          forecastP75Close: 105,
          forecastMaxHigh: 108,
          forecastMinLow: 97,
          expectedReturn1h: 3,
          expectedReturn4h: -1.5,
          probabilityUp: 75,
          probabilityDown: 25,
          kronosConfidenceBucket: "MEDIUM",
          kronosBias: "LONG",
          kronosBias1h: "LONG",
          kronosBias4h: "SHORT",
          selectedKronosBias: "LONG",
          horizonConflict: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = new HttpKronosClient("http://localhost:8001", fetchImpl as typeof fetch);
    const prediction = await client.predict("BTCUSDT", "1h", [
      { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
    ]);

    expect(prediction.available).toBe(true);
    expect(prediction.forecastMedianClose).toBeGreaterThan(prediction.currentPrice ?? 0);
    expect(prediction.probabilityUp).toBeGreaterThan(prediction.probabilityDown ?? 0);
    expect(prediction.expectedReturn1h).toBeGreaterThan(0);
    expect(prediction.selectedKronosBias).toBe("LONG");
    expect(prediction.horizonConflict).toBe(true);
  });
});

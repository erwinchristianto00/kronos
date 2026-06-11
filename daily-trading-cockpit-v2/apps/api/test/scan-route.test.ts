import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { buildApp } from "../src/app.js";
import { _resetParallelShadowExperimentStoreForTests } from "../src/lib/parallel-shadow-experiments.js";
import { _resetScanProviderCircuitsForTests } from "../src/lib/scan-service.js";

function makeKlines(step: number, intervalMs: number) {
  const latestOpenTime = Date.now() - intervalMs;
  const startTime = latestOpenTime - intervalMs * 149;
  return Array.from({ length: 150 }, (_, index) => {
    const close = 100 + index * step;
    return [
      startTime + index * intervalMs,
      String(close - 0.4),
      String(close + 0.8),
      String(close - 0.8),
      String(close),
      String(1_000 + index * 5),
      startTime + (index + 1) * intervalMs,
      "0",
      0,
      "0",
      "0",
      "0",
    ];
  });
}

describe("GET /api/scan", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    _resetScanProviderCircuitsForTests();
    _resetParallelShadowExperimentStoreForTests();
    const matrixPath = resolve(process.cwd(), "data", "parallel-shadow-experiments.json");
    if (existsSync(matrixPath)) rmSync(matrixPath, { force: true });
    const timingPath = resolve(process.cwd(), "data", "scan-timing-diagnostics.json");
    if (existsSync(timingPath)) rmSync(timingPath, { force: true });
  });

  it("returns ranked live candidates without fake Kronos data", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: false }), { status: 200 });
      }
      if (url.includes("/api/v3/klines")) {
        const interval = new URL(url).searchParams.get("interval");
        const intervalMs = interval === "1h" ? 60 * 60 * 1000 : interval === "15m" ? 15 * 60 * 1000 : 5 * 60 * 1000;
        return new Response(JSON.stringify(makeKlines(1.1, intervalMs)), { status: 200 });
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
      throw new Error(`Unhandled URL: ${url}`);
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/scan",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();

    const candidate = payload.top10[0] ?? payload.diagnostics.hiddenSkips[0];

    expect(payload.coverage.scannedSymbols).toBeGreaterThan(0);
    expect(candidate).toBeTruthy();
    expect(candidate.symbol).toBe("BTCUSDT");
    expect(candidate.kronosBias).toBe("UNAVAILABLE");
    expect(candidate.kronosScore).toBe(0);
    expect(candidate.selectedExecutionPlan).toEqual(
      expect.objectContaining({
        selectedEntryVariant: expect.any(String),
        selectedExitVariant: expect.any(String),
        selectionSource: expect.any(String),
      }),
    );
    expect(payload.diagnostics.trackingQueued).toBe(false);
    expect(payload.diagnostics.shadowQueued).toBe(false);
    expect(payload.diagnostics.outcomeCheckQueued).toBe(false);
    expect(payload.diagnostics.kronos.available).toBe(false);
    expect(payload.diagnostics.scanTiming).toEqual(
      expect.objectContaining({
        version: "scan-timing-diagnostics-v1",
        totalScanMs: expect.any(Number),
        symbolFetchMs: expect.any(Object),
        slowestSymbols: expect.any(Array),
      }),
    );
    expect(payload.diagnostics.scanTiming.slowestSymbols.length).toBeLessThanOrEqual(5);
    const matrixPath = resolve(process.cwd(), "data", "parallel-shadow-experiments.json");
    expect(existsSync(matrixPath)).toBe(true);
    const matrixState = JSON.parse(readFileSync(matrixPath, "utf-8"));
    expect(matrixState.latestAdmissionDiagnostics).toEqual(
      expect.objectContaining({
        matrixAdmissionInvoked: true,
        candidatesSeen: expect.any(Number),
      }),
    );
    expect(matrixState.latestAdmissionDiagnostics.fieldMissingCounts.currentPrice).toBeUndefined();
    const timingPath = resolve(process.cwd(), "data", "scan-timing-diagnostics.json");
    expect(existsSync(timingPath)).toBe(true);
    const timingState = JSON.parse(readFileSync(timingPath, "utf-8"));
    expect(timingState).toEqual(
      expect.objectContaining({
        version: "scan-timing-diagnostics-v1",
        totalScanMs: expect.any(Number),
      }),
    );

    await app.close();
  });

  it("coalesces concurrent scan requests into one in-flight scan cycle", async () => {
    let klineFetches = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: false }), { status: 200 });
      }
      if (url.includes("/api/v3/klines")) {
        klineFetches += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const interval = new URL(url).searchParams.get("interval");
        const intervalMs = interval === "1h" ? 60 * 60 * 1000 : interval === "15m" ? 15 * 60 * 1000 : 5 * 60 * 1000;
        return new Response(JSON.stringify(makeKlines(1.1, intervalMs)), { status: 200 });
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
      throw new Error(`Unhandled URL: ${url}`);
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const [left, right] = await Promise.all([
      app.inject({ method: "GET", url: "/api/scan" }),
      app.inject({ method: "GET", url: "/api/scan" }),
    ]);

    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    const leftPayload = left.json();
    const rightPayload = right.json();
    expect(leftPayload.generatedAt).toBe(rightPayload.generatedAt);
    expect(klineFetches).toBeLessThanOrEqual(60);

    await app.close();
  });

  it("reports per-symbol scan failure reasons in diagnostics", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: false }), { status: 200 });
      }
      if (url.includes("/api/v3/klines")) {
        const parsed = new URL(url);
        const symbol = parsed.searchParams.get("symbol");
        if (symbol === "ETHUSDT") {
          return new Response("missing market", { status: 404 });
        }
        const interval = parsed.searchParams.get("interval");
        const intervalMs = interval === "1h" ? 60 * 60 * 1000 : interval === "15m" ? 15 * 60 * 1000 : 5 * 60 * 1000;
        return new Response(JSON.stringify(makeKlines(1.1, intervalMs)), { status: 200 });
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
      throw new Error(`Unhandled URL: ${url}`);
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/scan",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();

    expect(payload.diagnostics.symbolFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "ETHUSDT",
          stage: "candles_5m",
          failureType: "unsupported",
        }),
      ]),
    );
    expect(payload.diagnostics.skippedSymbols).toContain("ETHUSDT");

    await app.close();
  });

  it("continues partial scans when a symbol candle fetch exceeds its timeout", async () => {
    process.env.SCAN_CANDLE_FETCH_TIMEOUT_MS = "20";
    process.env.SCAN_TOTAL_SYMBOL_FETCH_TIMEOUT_MS = "500";
    process.env.SCAN_SYMBOL_FAILURE_RATE_THRESHOLD = "0.5";
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: false }), { status: 200 });
      }
      if (url.includes("/api/v3/klines")) {
        const parsed = new URL(url);
        const symbol = parsed.searchParams.get("symbol");
        if (symbol === "ETHUSDT") {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const interval = parsed.searchParams.get("interval");
        const intervalMs = interval === "1h" ? 60 * 60 * 1000 : interval === "15m" ? 15 * 60 * 1000 : 5 * 60 * 1000;
        return new Response(JSON.stringify(makeKlines(1.1, intervalMs)), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", volume: "5000000", quoteVolume: "250000000" }), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/bookTicker")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", bidPrice: "100.00", askPrice: "100.02" }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const response = await app.inject({ method: "GET", url: "/api/scan" });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.coverage.scannedSymbols).toBeGreaterThan(0);
    expect(payload.diagnostics.symbolFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "ETHUSDT",
          stage: "candleFetch",
          failureType: "timeout",
        }),
      ]),
    );
    expect(payload.diagnostics.scanTiming.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "ETHUSDT",
          status: "FAILED",
          failureReason: expect.stringContaining("timeout"),
          totalSymbolFetchMs: expect.any(Number),
        }),
      ]),
    );

    await app.close();
  });

  it("degrades slow Kronos queue waits into unavailable forecasts without failing symbols", async () => {
    process.env.SCAN_TOTAL_SYMBOL_FETCH_TIMEOUT_MS = "1000";
    process.env.SCAN_SYMBOL_FAILURE_RATE_THRESHOLD = "0.5";
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: true }), { status: 200 });
      }
      if (url.endsWith("/predict")) {
        await new Promise((resolve) => setTimeout(resolve, 120));
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
      }
      if (url.includes("/api/v3/klines")) {
        const interval = new URL(url).searchParams.get("interval");
        const intervalMs = interval === "1h" ? 60 * 60 * 1000 : interval === "15m" ? 15 * 60 * 1000 : 5 * 60 * 1000;
        return new Response(JSON.stringify(makeKlines(1.1, intervalMs)), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", volume: "5000000", quoteVolume: "250000000" }), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/bookTicker")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", bidPrice: "100.00", askPrice: "100.02" }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const response = await app.inject({ method: "GET", url: "/api/scan" });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.coverage.scannedSymbols).toBeGreaterThan(0);
    expect(payload.diagnostics.kronos.timeout).toBeGreaterThan(0);
    expect(payload.diagnostics.symbolFailures).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "kronosForecast",
        }),
      ]),
    );

    await app.close();
  });

  it("marks external signal providers degraded after repeated timeout and keeps candidates explicit", async () => {
    process.env.SOCIAL_SENTIMENT_PROVIDER = "custom";
    process.env.SOCIAL_SENTIMENT_URL = "http://sentiment.local/signal";
    process.env.SCAN_EXTERNAL_SIGNAL_FETCH_TIMEOUT_MS = "10";
    process.env.SCAN_TOTAL_SYMBOL_FETCH_TIMEOUT_MS = "1000";
    process.env.SCAN_PROVIDER_TIMEOUT_STREAK_THRESHOLD = "1";
    process.env.SCAN_PROVIDER_CIRCUIT_SKIP_SCANS = "2";
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: false }), { status: 200 });
      }
      if (url.startsWith("http://sentiment.local")) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify({ signal: "BULLISH", score: 80, confidence: 80 }), { status: 200 });
      }
      if (url.includes("/api/v3/klines")) {
        const interval = new URL(url).searchParams.get("interval");
        const intervalMs = interval === "1h" ? 60 * 60 * 1000 : interval === "15m" ? 15 * 60 * 1000 : 5 * 60 * 1000;
        return new Response(JSON.stringify(makeKlines(1.1, intervalMs)), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", volume: "5000000", quoteVolume: "250000000" }), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/bookTicker")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", bidPrice: "100.00", askPrice: "100.02" }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const response = await app.inject({ method: "GET", url: "/api/scan" });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.diagnostics.scanTiming.degradedProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "sentiment",
          remainingScanSkips: expect.any(Number),
        }),
      ]),
    );
    const candidate = payload.top10[0] ?? payload.diagnostics.hiddenSkips[0];
    expect(candidate.sentiment.available).toBe(false);
    expect(candidate.sentiment.reason).toMatch(/timeout|degraded/i);

    await app.close();
  });

  it("reuses short-TTL candle cache on rapid repeated scans", async () => {
    process.env.SCAN_CANDLE_CACHE_TTL_MS = "30000";
    let klineFetches = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: false }), { status: 200 });
      }
      if (url.includes("/api/v3/klines")) {
        klineFetches += 1;
        const interval = new URL(url).searchParams.get("interval");
        const intervalMs = interval === "1h" ? 60 * 60 * 1000 : interval === "15m" ? 15 * 60 * 1000 : 5 * 60 * 1000;
        return new Response(JSON.stringify(makeKlines(1.1, intervalMs)), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/24hr")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", volume: "5000000", quoteVolume: "250000000" }), { status: 200 });
      }
      if (url.includes("/api/v3/ticker/bookTicker")) {
        return new Response(JSON.stringify({ symbol: "BTCUSDT", bidPrice: "100.00", askPrice: "100.02" }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    const first = await app.inject({ method: "GET", url: "/api/scan" });
    const second = await app.inject({ method: "GET", url: "/api/scan" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(klineFetches).toBeLessThanOrEqual(60);
    expect(second.json().coverage.cacheFreshSymbols).toBeGreaterThan(0);

    await app.close();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildCandidate, type Candidate, type Candle } from "@dtc/shared";

import { buildApp } from "../src/app.js";
import { DecisionLedger, _resetDecisionLedgerForTests } from "../src/lib/decision-ledger.js";
import { _resetParallelShadowExperimentStoreForTests } from "../src/lib/parallel-shadow-experiments.js";
import { ScanService, _resetScanProviderCircuitsForTests } from "../src/lib/scan-service.js";

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

// Mirrors shadow-engine.test.ts's makeCandles fixture: builds a well-formed, non-degenerate candle
// series so buildCandidate() produces a candidate that clears the SKIP thresholds (liquidity,
// spread, risk-reward), independent of this file's HTTP-level klines mocks.
function makeCandles({
  start = 95,
  step = 0.2,
  volumeBase = 1000,
  count = 160,
  timeStepMs = 5 * 60 * 1000,
  startTime = Date.UTC(2026, 4, 6, 0, 0, 0),
}: {
  start?: number;
  step?: number;
  volumeBase?: number;
  count?: number;
  timeStepMs?: number;
  startTime?: number;
} = {}): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * step;
    return {
      openTime: startTime + index * timeStepMs,
      open: close - step * 0.25,
      high: close + Math.abs(step) * 0.5 + 1,
      low: close - Math.abs(step) * 0.5 - 1,
      close,
      volume: volumeBase + index * 10,
    };
  });
}

describe("GET /api/scan", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    _resetScanProviderCircuitsForTests();
    _resetParallelShadowExperimentStoreForTests();
    _resetDecisionLedgerForTests();
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

  it("isolates decision-ledger recording per candidate so one failure doesn't suppress the rest (fail-without/pass-with)", async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), "dtc-scan-ledger-"));
    process.env.DECISION_LEDGER_FILE = join(ledgerDir, "decision-log.jsonl");

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, modelConnected: false }), { status: 200 });
      }
      throw new Error(`Unhandled URL: ${url}`);
    });

    const app = await buildApp({
      fetchImpl: fetchImpl as typeof fetch,
      kronosBaseUrl: "http://localhost:8001",
    });

    // Bypass the scoring pipeline entirely (unrelated to this bug) by stubbing scan() to return
    // several already-built, non-SKIP candidates directly, so top10 has more than one entry.
    const candidateCount = 4;
    const fakeCandidate = (symbol: string): Candidate =>
      buildCandidate({
        symbol,
        candles5m: makeCandles(),
        candles15m: makeCandles({ timeStepMs: 15 * 60 * 1000 }),
        candles1h: makeCandles({ timeStepMs: 60 * 60 * 1000 }),
        spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
        volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
        kronos: {
          available: true,
          kronosLongProbability: 80,
          kronosShortProbability: 20,
          kronosBias: "LONG",
          kronosConfidence: 76,
          kronosConfidenceBucket: "STRONG",
          expectedReturn1h: 1.2,
          expectedReturn4h: 2.1,
          probabilityUp: 70,
          probabilityDown: 30,
          forecastMaxHigh: 105,
          forecastMinLow: 97,
          kronosRisk: 30,
        },
        whale: { available: true, signal: "BULLISH", score: 75, reason: "aligned" },
        sentiment: { available: false, signal: "UNAVAILABLE", score: 0, source: "none" },
      });
    const fakeCandidates = Array.from({ length: candidateCount }, (_, i) => ({
      ...fakeCandidate(`FAKE${i}USDT`),
      rank: i + 1,
      direction: "LONG" as const,
      finalDirection: "LONG" as const,
      status: "READY" as const,
      finalStatus: "READY" as const,
      entryZone: [99.5, 100.2] as [number, number],
      stopLoss: 98.0,
      takeProfits: { tp1: 103.0, tp2: 105, tp3: 107 },
      riskReward: 1.8,
      dangerScore: 30,
    }));
    const scanSpy = vi.spyOn(ScanService.prototype, "scan").mockResolvedValue({
      generatedAt: new Date().toISOString(),
      coverage: { totalSymbols: candidateCount, scannedSymbols: candidateCount, returnedSymbols: candidateCount, skippedSymbols: 0, percent: 100 },
      marketRegime: "Mixed rotation",
      top10: fakeCandidates,
      diagnostics: {
        universe: fakeCandidates.map((c) => c.symbol),
        skippedSymbols: [],
        symbolFailures: [],
        hiddenSkips: [],
        kronos: { available: true, message: "ok" },
        whale: { available: true, message: "ok" },
        sentiment: { available: false, message: "off" },
      },
    });

    // Fail exactly the FIRST candidate's ledger write (e.g. disk full for that one call) and let
    // the rest call through to the real method.
    const recordSpy = vi.spyOn(DecisionLedger.prototype, "recordRouteAssigned").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.inject({ method: "GET", url: "/api/scan" });

    expect(response.statusCode).toBe(200);
    expect(scanSpy).toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledTimes(candidateCount);
    expect(errorSpy).toHaveBeenCalled();
    // Isolation: the (candidateCount - 1) candidates AFTER the failing one must still be recorded,
    // not skipped as a side effect of the first candidate's write throwing.
    const ledgerFile = process.env.DECISION_LEDGER_FILE!;
    const lines = readFileSync(ledgerFile, "utf-8").trim().split("\n");
    const routeAssignedCount = lines.map((l) => JSON.parse(l)).filter((e) => e.event === "ROUTE_ASSIGNED").length;
    expect(routeAssignedCount).toBe(candidateCount - 1);

    await app.close();
    rmSync(ledgerDir, { recursive: true, force: true });
  });
});

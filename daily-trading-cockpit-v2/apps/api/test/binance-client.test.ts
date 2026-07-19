import { afterEach, describe, expect, it, vi } from "vitest";

import { BinanceClient, BinanceRequestError, computeBasis } from "../src/lib/binance.js";

function makeKlinePayload() {
  return Array.from({ length: 3 }, (_, index) => [
    1_700_000_000_000 + index * 300_000,
    "100.0",
    "101.0",
    "99.0",
    String(100 + index),
    "1000.0",
    0,
    "0",
    0,
    "0",
    "0",
    "0",
  ]);
}

describe("BinanceClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BINANCE_CACHE_MAX_ENTRIES;
    delete process.env.SCAN_CANDLE_CACHE_TTL_MS;
  });

  it("serves rapid repeated klines from the short read-through cache", async () => {
    const successPayload = makeKlinePayload();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify(successPayload), { status: 200 });
    });

    const client = new BinanceClient(fetchImpl as typeof fetch);

    const live = await client.getCandles("BTCUSDT", "5m", 3);
    const cached = await client.getCandles("BTCUSDT", "5m", 3);
    const summary = client.getSymbolFetchSummary("BTCUSDT");

    expect(live).toHaveLength(3);
    expect(cached).toHaveLength(3);
    expect(calls).toBe(1);
    expect(summary.mode).toBe("CACHE_FRESH");
    expect(summary.stageTimings.candles_5m?.cacheHitCount).toBe(1);
  });

  it("emits typed failures when no cache exists", async () => {
    const fetchImpl = vi.fn(async () => new Response("missing", { status: 404 }));
    const client = new BinanceClient(fetchImpl as typeof fetch);

    await expect(client.getCandles("BADUSDT", "5m", 3)).rejects.toMatchObject<Partial<BinanceRequestError>>({
      failureType: "unsupported",
      stage: "candles_5m",
    });
  });

  it("falls back to api-gcp for spot klines when the primary host times out", async () => {
    const successPayload = makeKlinePayload();
    const requestedHosts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedHosts.push(url.host);
      if (url.host === "api.binance.com") {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return new Response(JSON.stringify(successPayload), { status: 200 });
    });

    const client = new BinanceClient(fetchImpl as typeof fetch);
    const candles = await client.getCandles("BTCUSDT", "5m", 3);

    expect(candles).toHaveLength(3);
    expect(requestedHosts).toEqual(["api.binance.com", "api-gcp.binance.com"]);
  });

  it("keeps fallback failures explicit when all spot hosts fail", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const client = new BinanceClient(fetchImpl as typeof fetch);

    await expect(client.getCandles("BTCUSDT", "5m", 3)).rejects.toMatchObject<Partial<BinanceRequestError>>({
      failureType: "timeout",
      stage: "candles_5m",
    });
  });

  describe("kline cache eviction (OOM regression)", () => {
    // Root cause: getCacheIdentityParams() folds a time-bucketed cacheLatestOpenTime into
    // the klines cache key so each candle-close bucket rollover mints a brand-new cache
    // entry. Nothing ever evicted the *previous* bucket's entry — getFreshCache() only
    // checked TTL on read, and setCache() only ever added keys — so the map grew without
    // bound for hours until the process OOM'd. This suite proves the added prune-on-save
    // sweep actually removes stale time-bucketed entries as buckets roll forward, without
    // ever evicting an entry that is still within its TTL.

    it("does not let the cache grow unboundedly as the 1m kline bucket rolls forward for hours (fails without the fix)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      const successPayload = makeKlinePayload();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify(successPayload), { status: 200 });
      });
      const client = new BinanceClient(fetchImpl as typeof fetch);

      const BUCKET_ROLLOVERS = 200; // ~3.3 hours of 1m candles ticking every minute
      for (let i = 0; i < BUCKET_ROLLOVERS; i += 1) {
        await client.getCandles("BTCUSDT", "1m", 3);
        // Advance past the 1m bucket boundary (mints a new cacheLatestOpenTime key) and
        // past the default 30s kline TTL / prune-throttle interval, so every iteration
        // both busts the previous cache entry and gives the prune sweep a chance to run.
        await vi.advanceTimersByTimeAsync(60_000);
      }

      // Every iteration was a genuine cache miss (new bucket each time) and hit Binance live.
      expect(calls).toBe(BUCKET_ROLLOVERS);

      // Without eviction this map would hold one permanent dead entry per rollover
      // (200 entries here; unboundedly many over a real multi-hour run). With the
      // TTL-based prune sweep, only the most recent bucket's entry should remain live.
      const finalCacheSize = client._getCacheSizeForTests();
      expect(finalCacheSize).toBeLessThan(BUCKET_ROLLOVERS);
      expect(finalCacheSize).toBeLessThanOrEqual(2);
    });

    it("still serves a fresh-within-TTL kline cache entry unchanged, and only refetches once the TTL truly elapses", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      const successPayload = makeKlinePayload();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify(successPayload), { status: 200 });
      });
      const client = new BinanceClient(fetchImpl as typeof fetch);

      await client.getCandles("BTCUSDT", "1m", 3);
      expect(calls).toBe(1);

      // Still within the 30s default TTL and within the same 1m bucket: must remain a hit.
      await vi.advanceTimersByTimeAsync(25_000);
      const cached = await client.getCandles("BTCUSDT", "1m", 3);
      expect(cached).toHaveLength(3);
      expect(calls).toBe(1);
      expect(client.getSymbolFetchSummary("BTCUSDT").mode).toBe("CACHE_FRESH");

      // 35s after the original write (still the same 1m bucket, so same cache key) is past
      // the 30s TTL: the read path must naturally refetch, exactly as before this change.
      await vi.advanceTimersByTimeAsync(10_000);
      await client.getCandles("BTCUSDT", "1m", 3);
      expect(calls).toBe(2);
    });

    it("enforces BINANCE_CACHE_MAX_ENTRIES as a hard cap, evicting oldest entries first", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      // Long TTL so this test isolates hard-cap eviction from TTL-based eviction.
      process.env.SCAN_CANDLE_CACHE_TTL_MS = "300000";
      process.env.BINANCE_CACHE_MAX_ENTRIES = "3";

      const successPayload = makeKlinePayload();
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(successPayload), { status: 200 }));
      const client = new BinanceClient(fetchImpl as typeof fetch);

      // Write 5 distinct symbols in quick succession (well inside the 30s prune-throttle
      // window, so the sweep only actually runs once, on the very first write).
      for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT", "XRPUSDT"]) {
        await client.getCandles(symbol, "1m", 3);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(client._getCacheSizeForTests()).toBe(5);

      // Clear the prune throttle, then write one more entry. TTL alone would not evict
      // anything here (everything is well under the 300s TTL) — only the hard cap should.
      await vi.advanceTimersByTimeAsync(31_000);
      await client.getCandles("DOGEUSDT", "1m", 3);

      expect(client._getCacheSizeForTests()).toBeLessThanOrEqual(3);
    });
  });

  it("maps futures book ticker quantities for microstructure collection", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.host).toBe("fapi.binance.com");
      expect(url.pathname).toBe("/fapi/v1/ticker/bookTicker");
      return new Response(
        JSON.stringify({
          symbol: "SOLUSDT",
          bidPrice: "100.1",
          bidQty: "12.5",
          askPrice: "100.2",
          askQty: "9.25",
          time: 1_700_000_000_000,
        }),
        { status: 200 },
      );
    });
    const client = new BinanceClient(fetchImpl as typeof fetch);

    const ticker = await client.getBookTickerWithQty("SOLUSDT");

    expect(ticker).toMatchObject({
      bid: 100.1,
      ask: 100.2,
      bidQty: 12.5,
      askQty: 9.25,
      time: 1_700_000_000_000,
    });
  });

  it("maps futures depth, open interest, premium index, and agg trades", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/fapi/v1/depth") {
        return new Response(JSON.stringify({ bids: [["100", "2"]], asks: [["101", "3"]] }), { status: 200 });
      }
      if (url.pathname === "/fapi/v1/openInterest") {
        return new Response(JSON.stringify({ symbol: "SOLUSDT", openInterest: "12345.5", time: 1 }), { status: 200 });
      }
      if (url.pathname === "/fapi/v1/premiumIndex") {
        return new Response(JSON.stringify({
          markPrice: "100.5",
          indexPrice: "100.4",
          lastFundingRate: "0.0001",
          nextFundingTime: 1_700_000_000_000,
        }), { status: 200 });
      }
      if (url.pathname === "/fapi/v1/aggTrades") {
        return new Response(JSON.stringify([
          { p: "100", q: "2", T: 1_700_000_000_000, m: false },
          { p: "99", q: "1", T: 1_700_000_001_000, m: true },
        ]), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    const client = new BinanceClient(fetchImpl as typeof fetch);

    await expect(client.getDepth("SOLUSDT", 5)).resolves.toEqual({
      bids: [["100", "2"]],
      asks: [["101", "3"]],
    });
    await expect(client.getOpenInterest("SOLUSDT")).resolves.toEqual({ openInterest: 12345.5 });
    await expect(client.getPremiumIndex("SOLUSDT")).resolves.toEqual({
      fundingRate: 0.0001,
      nextFundingTime: 1_700_000_000_000,
    });
    await expect(client.getAggTrades("SOLUSDT", { startTime: 1, endTime: 2, limit: 2 })).resolves.toEqual([
      { price: 100, quantity: 2, isBuyerMaker: false, timestamp: 1_700_000_000_000 },
      { price: 99, quantity: 1, isBuyerMaker: true, timestamp: 1_700_000_001_000 },
    ]);
  });

  describe("computeBasis", () => {
    it("returns a negative basis when mark price trades below index price", () => {
      expect(computeBasis(99.5, 100)).toEqual({ basis: -0.5, basisPct: -0.5 });
    });

    it("returns a positive basis when mark price trades above index price", () => {
      expect(computeBasis(100.5, 100)).toEqual({ basis: 0.5, basisPct: 0.5 });
    });

    it("returns a zero basis when mark price equals index price", () => {
      expect(computeBasis(100, 100)).toEqual({ basis: 0, basisPct: 0 });
    });

    it("returns nulls when either input is missing", () => {
      expect(computeBasis(null, 100)).toEqual({ basis: null, basisPct: null });
      expect(computeBasis(100, null)).toEqual({ basis: null, basisPct: null });
    });
  });

  it("attaches basis/basisPct to the futures premium index snapshot", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/fapi/v1/premiumIndex");
      return new Response(
        JSON.stringify({
          markPrice: "100.5",
          indexPrice: "100.0",
          lastFundingRate: "0.0001",
          nextFundingTime: 1_700_000_000_000,
        }),
        { status: 200 },
      );
    });
    const client = new BinanceClient(fetchImpl as typeof fetch);

    await expect(client.getFuturesPremiumIndex("SOLUSDT")).resolves.toEqual({
      markPrice: 100.5,
      indexPrice: 100,
      fundingRate: 0.0001,
      nextFundingTime: 1_700_000_000_000,
      basis: 0.5,
      basisPct: 0.5,
    });
  });

  it("parses top-trader long/short ratios from the dedicated top-trader endpoints", async () => {
    const requestedPaths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      expect(url.host).toBe("fapi.binance.com");
      expect(url.searchParams.get("symbol")).toBe("SOLUSDT");
      expect(url.searchParams.get("period")).toBe("5m");
      expect(url.searchParams.get("limit")).toBe("2");
      if (url.pathname === "/futures/data/topLongShortPositionRatio") {
        return new Response(
          JSON.stringify([
            { symbol: "SOLUSDT", longShortRatio: "1.7500", longAccount: "0.6364", shortAccount: "0.3636", timestamp: 1_700_000_000_000 },
            { symbol: "SOLUSDT", longShortRatio: "1.9047", longAccount: "0.6559", shortAccount: "0.3441", timestamp: 1_700_000_300_000 },
          ]),
          { status: 200 },
        );
      }
      if (url.pathname === "/futures/data/topLongShortAccountRatio") {
        return new Response(
          JSON.stringify([
            { symbol: "SOLUSDT", longShortRatio: "1.2000", longAccount: "0.5455", shortAccount: "0.4545", timestamp: 1_700_000_000_000 },
            { symbol: "SOLUSDT", longShortRatio: "1.4342", longAccount: "0.5891", shortAccount: "0.4109", timestamp: 1_700_000_300_000 },
          ]),
          { status: 200 },
        );
      }
      return new Response("missing", { status: 404 });
    });
    const client = new BinanceClient(fetchImpl as typeof fetch);

    await expect(client.getFuturesTopTraderRatio("SOLUSDT")).resolves.toEqual({
      topTraderPositionRatio: 1.9047,
      topTraderAccountRatio: 1.4342,
    });
    expect(requestedPaths.sort()).toEqual([
      "/futures/data/topLongShortAccountRatio",
      "/futures/data/topLongShortPositionRatio",
    ]);
  });
});

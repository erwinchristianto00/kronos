import { describe, expect, it, vi } from "vitest";

import { BinanceClient, BinanceRequestError } from "../src/lib/binance.js";

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
});

import { describe, expect, it } from "vitest";

import {
  FuturesMarketReferenceCache,
  verifiedFuturesMarketReferencePrice,
  type FuturesMarketReference,
} from "../src/lib/futures-market-reference-cache.js";

describe("futures market reference cache", () => {
  it("keeps 1000PEPE's exact USD-M symbol and uses premium-index mark as canonical sizing price", async () => {
    const requested: string[] = [];
    const cache = new FuturesMarketReferenceCache({
      getMarkPrice: async (symbol) => {
        requested.push(symbol);
        return 0.0032;
      },
      getBookTicker: async () => ({ bid: 0.00319, ask: 0.00321 }),
    });

    const reference = await cache.refresh("1000pepeusdt");

    expect(requested).toEqual(["1000PEPEUSDT"]);
    expect(reference).toMatchObject({
      symbol: "1000PEPEUSDT",
      price: 0.0032,
      source: "USD_M_MARK_PRICE",
    });
  });

  it("uses only the exact USD-M book midpoint when a mark cache miss cannot fetch premiumIndex", async () => {
    let bookCalls = 0;
    const cache = new FuturesMarketReferenceCache({
      getMarkPrice: async () => { throw new Error("premium index transient failure"); },
      getBookTicker: async (symbol) => {
        bookCalls += 1;
        expect(symbol).toBe("1000PEPEUSDT");
        return { bid: 0.00319, ask: 0.00321 };
      },
    });

    const reference = await cache.refresh("1000PEPEUSDT");

    expect(bookCalls).toBe(1);
    expect(reference).toMatchObject({
      symbol: "1000PEPEUSDT",
      price: 0.0032,
      source: "USD_M_BOOK_TICKER",
    });
  });

  it("never serves an expired futures reference after both live sources fail", async () => {
    let now = 1_000;
    let markAvailable = true;
    const cache = new FuturesMarketReferenceCache({
      getMarkPrice: async () => {
        if (!markAvailable) throw new Error("mark unavailable");
        return 100;
      },
      getBookTicker: async () => { throw new Error("book unavailable"); },
    }, { nowMs: () => now, maxAgeMs: 10 });

    expect(await cache.refresh("SOLUSDT")).toMatchObject({ price: 100, source: "USD_M_MARK_PRICE" });
    now += 11;
    markAvailable = false;

    expect(await cache.refresh("SOLUSDT")).toBeNull();
    expect(cache.read("SOLUSDT")).toBeNull();
  });

  it("coalesces simultaneous refreshes for one symbol instead of racing duplicate endpoint calls", async () => {
    let markCalls = 0;
    let resolveMark: (price: number | null) => void = () => {};
    const mark = new Promise<number | null>((resolve) => { resolveMark = resolve; });
    const cache = new FuturesMarketReferenceCache({
      getMarkPrice: async () => {
        markCalls += 1;
        return mark;
      },
      getBookTicker: async () => ({ bid: 1, ask: 1 }),
    });

    const first = cache.refresh("SOLUSDT");
    const second = cache.refresh("SOLUSDT");
    resolveMark(100);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ price: 100, source: "USD_M_MARK_PRICE" }),
      expect.objectContaining({ price: 100, source: "USD_M_MARK_PRICE" }),
    ]);
    expect(markCalls).toBe(1);
  });

  it("rejects a spot-scale or alias cache value before it can become multiplier sizing", () => {
    const spotLike = {
      symbol: "1000PEPEUSDT",
      price: 0.0000032,
      atMs: Date.now(),
      source: "BINANCE_SPOT_BOOK_TICKER",
    } as unknown as FuturesMarketReference;
    const wrongSymbol = {
      symbol: "PEPEUSDT",
      price: 0.0032,
      atMs: Date.now(),
      source: "USD_M_MARK_PRICE",
    } as FuturesMarketReference;

    expect(verifiedFuturesMarketReferencePrice("1000PEPEUSDT", spotLike)).toBeNull();
    expect(verifiedFuturesMarketReferencePrice("1000PEPEUSDT", wrongSymbol)).toBeNull();
  });
});

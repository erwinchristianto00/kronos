import { describe, expect, it, vi } from "vitest";
import { AstraResearchContext, candleFeatures, spreadBps } from "../src/lib/astra-research-context.js";

function setup() {
  let now = 1800000000000;
  const book = { bid: 99.9, ask: 100.1, bidQty: 3, askQty: 4, time: now };
  const client = {
    getAstraTicker24h: vi.fn(async () => [
      { symbol: "AUSDT", priceChangePercent: 12, quoteVolume: 1000000, highPrice: 110, lowPrice: 90, lastPrice: 100, closeTime: now },
      { symbol: "BUSDT", priceChangePercent: -10, quoteVolume: 2000000, highPrice: 110, lowPrice: 90, lastPrice: 100, closeTime: now },
    ]),
    getAstraPremiumIndexes: vi.fn(async () => [{ symbol: "AUSDT", markPrice: 100, indexPrice: 100, lastFundingRate: 0.0001, nextFundingTime: now + 600000, time: now }]),
    getAstraCommissionRate: vi.fn(async (symbol: string) => ({ symbol, makerCommissionRate: 0.0002, takerCommissionRate: 0.0005 })),
  };
  return { now: () => now, advance: (n: number) => now += n, book, client, research: new AstraResearchContext(client, () => now) };
}

describe("Astra descriptive screening and explicit execution economics", () => {
  it("computes both taker legs and spread separately from funding/slippage", async () => {
    const x = setup(); const e = await x.research.economics("AUSDT", x.book);
    expect(e.roundTripTakerFeeBps).toBe(10); expect(e.spreadBps).toBe(20);
    expect(e.feeAndSpreadBps).toBe(30);
    expect(e.funding.nextSettlementCostBpsIfRateUnchanged).toEqual({ LONG: 1, SHORT: -1 });
    expect(e.commission.source).toBe("TESTNET_ACCOUNT_SYMBOL_COMMISSION_RATE");
    expect(e.calculation).toContain("NOT all-in");
  });
  it("supports zero commission and negative funding without inventing positive fees", async () => {
    const x = setup(); x.client.getAstraCommissionRate.mockResolvedValue({ symbol: "AUSDT", makerCommissionRate: 0, takerCommissionRate: 0 });
    x.client.getAstraPremiumIndexes.mockResolvedValue([{ symbol: "AUSDT", markPrice: 100, indexPrice: 100, lastFundingRate: -0.0002, nextFundingTime: x.now()+1000, time: x.now() }]);
    const e = await x.research.economics("AUSDT", x.book);
    expect(e.roundTripTakerFeeBps).toBe(0); expect(e.funding.nextSettlementCostBpsIfRateUnchanged).toEqual({ LONG: -2, SHORT: 2 });
  });
  it("failed reads stay unavailable, do not pretend zero or expose upstream errors, and back off", async () => {
    const x = setup(); x.client.getAstraCommissionRate.mockRejectedValue(new Error("secret upstream URL must not be exported"));
    x.client.getAstraPremiumIndexes.mockRejectedValue(new Error("network error"));
    const e = await x.research.economics("AUSDT", x.book);
    expect(e.commission.status).toBe("UNAVAILABLE"); expect(e.roundTripTakerFeeBps).toBeNull();
    expect(e.funding.status).toBe("UNAVAILABLE"); expect(JSON.stringify(e)).not.toContain("secret");
    await x.research.economics("AUSDT", x.book);
    expect(x.client.getAstraCommissionRate).toHaveBeenCalledTimes(1);
    x.advance(60001); await x.research.economics("AUSDT", x.book);
    expect(x.client.getAstraCommissionRate).toHaveBeenCalledTimes(2);
  });
  it("deduplicates concurrent reads and caches fee per symbol, not across symbols", async () => {
    const x = setup(); await Promise.all([x.research.economics("AUSDT", x.book), x.research.economics("AUSDT", x.book)]);
    expect(x.client.getAstraCommissionRate).toHaveBeenCalledTimes(1); expect(x.client.getAstraPremiumIndexes).toHaveBeenCalledTimes(1);
    await x.research.economics("BUSDT", x.book);
    expect(x.client.getAstraCommissionRate).toHaveBeenCalledTimes(2); expect(x.client.getAstraPremiumIndexes).toHaveBeenCalledTimes(1);
    x.advance(900001); await x.research.economics("AUSDT", x.book);
    expect(x.client.getAstraCommissionRate).toHaveBeenCalledTimes(3);
  });
  it("stale premium is unavailable even if freshly fetched", async () => {
    const x = setup(); x.client.getAstraPremiumIndexes.mockResolvedValue([{ symbol: "AUSDT", markPrice: 100, indexPrice: 100, lastFundingRate: 0.01, nextFundingTime: x.now()+1000, time: x.now()-120001 }]);
    expect((await x.research.economics("AUSDT", x.book)).funding.status).toBe("UNAVAILABLE");
  });
  it("stale quotes preserve fee evidence but never present all-in-looking spread costs", async () => {
    const x = setup(); x.book.time = x.now()-45000;
    const e = await x.research.economics("AUSDT", x.book);
    expect(e.bookFresh).toBe(false); expect(e.spreadBps).toBeNull(); expect(e.feeAndSpreadBps).toBeNull();
    expect(e.roundTripTakerFeeBps).toBe(10);
  });
  it("expires settlement estimates exactly at the funding boundary even within cache TTL", async () => {
    const x = setup();
    x.client.getAstraPremiumIndexes.mockResolvedValue([{ symbol: "AUSDT", markPrice: 100, indexPrice: 100, lastFundingRate: 0.001, nextFundingTime: x.now()+1000, time: x.now() }]);
    expect((await x.research.economics("AUSDT", x.book)).funding.status).toBe("INDICATIVE");
    x.advance(1000); const e = await x.research.economics("AUSDT", x.book);
    expect(e.funding.status).toBe("UNAVAILABLE"); expect(e.funding.nextFundingTime).toBeNull();
    expect(e.funding.nextSettlementCostBpsIfRateUnchanged).toBeNull();
  });
  it("screening retains the full universe; lists are descriptive and exclude foreign or unaffordable hints", async () => {
    const x = setup(); const symbols = ["AUSDT", "BUSDT", "CUSDT"];
    const books = new Map(symbols.map(s => [s, x.book])); const minimums = new Map(symbols.map(s => [s, { minNotional: 5 }]));
    const r = await x.research.overview(symbols, books, [], 25, minimums);
    expect(r.rows).toHaveLength(3); expect(r.rows[2].change24hPct).toBeNull();
    expect(r.screening.strongest24h[0]).toBe("AUSDT"); expect(r.screening.weakest24h[0]).toBe("BUSDT");
    expect(r.screening.highestQuoteVolume24h[0]).toBe("BUSDT");
    minimums.set("BUSDT", { minNotional: 50 });
    const blocked = await x.research.overview(symbols, books, ["AUSDT"], 25, minimums);
    expect(blocked.rows).toHaveLength(3); expect(blocked.screening.screenableCount).toBe(0);
    expect(x.client.getAstraTicker24h).toHaveBeenCalledTimes(1);
  });
  it("stale ticker statistics are null and missing prices do not become free execution", async () => {
    const x = setup(); x.client.getAstraTicker24h.mockResolvedValue([{ symbol: "AUSDT", priceChangePercent: 20, quoteVolume: 1000, highPrice: 200, lowPrice: 100, lastPrice: 150, closeTime: x.now()-300001 }]);
    const r = await x.research.overview(["AUSDT"], new Map(), [], 25, new Map([["AUSDT", { minNotional: 5 }]]));
    expect(r.rows[0].change24hPct).toBeNull(); expect(r.screening.screenableCount).toBe(0);
    expect(spreadBps(null)).toBeNull(); expect(spreadBps({ ...x.book, bid: 101 })).toBeNull();
  });
  it("closed features exclude future candles and refuse gap-based return estimates", () => {
    const now = 1800000000000;
    const rows = Array.from({ length: 21 }, (_, i) => ({ openTime: now-(20-i)*300000, closeTime: now-(20-i)*300000+299999,
      open: 100+i, high: 101+i, low: 99+i, close: 100+i, volume: 5 }));
    const f = candleFeatures(rows, now);
    expect(f.closedBars).toBe(20); expect(f.change15mPct).toBeCloseTo((119/116-1)*100, 3);
    expect(f.meanTrueRange14Bps).not.toBeNull(); expect(f.change4hPct).toBeNull();
    expect(candleFeatures(rows.filter((_, i) => i !== 17), now).change15mPct).toBeNull();
  });
});

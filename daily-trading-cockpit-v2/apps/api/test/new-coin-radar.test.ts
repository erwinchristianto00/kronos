import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import {
  NewCoinRadarStore,
  discoverNewListings,
  resolveCoingeckoIds,
  fetchFundamentals,
  runNewCoinRadarCycle,
  scoreRadarCoin,
  _resetNewCoinRadarStoreForTests,
} from "../src/lib/new-coin-radar.js";

const NOW = Date.parse("2026-07-08T00:00:00.000Z");
const DAY = 86_400_000;

const dirs: string[] = [];
let n = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `radar-${process.pid}-${++n}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  _resetNewCoinRadarStoreForTests();
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    for (const [key, value] of Object.entries(routes)) {
      if (url.includes(key)) return value;
    }
    throw new Error(`no fake route for ${url}`);
  };
  return { fn, calls };
}

const exchangeInfo = {
  symbols: [
    { symbol: "NEWAUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", baseAsset: "NEWA", onboardDate: NOW - 10 * DAY },
    { symbol: "1000NEWBUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", baseAsset: "1000NEWB", onboardDate: NOW - 40 * DAY },
    { symbol: "OLDUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", baseAsset: "OLD", onboardDate: NOW - 400 * DAY }, // too old
    { symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", baseAsset: "BTC", onboardDate: NOW - 5 * DAY }, // excluded (universe)
    { symbol: "DEADUSDT", status: "SETTLING", contractType: "PERPETUAL", quoteAsset: "USDT", baseAsset: "DEAD", onboardDate: NOW - 5 * DAY }, // not trading
  ],
};

describe("new-coin radar", () => {
  it("discovers only fresh TRADING perps, excludes the stale universe, strips the 1000 prefix", async () => {
    const { fn } = fakeFetch({ "exchangeInfo": exchangeInfo });
    const found = await discoverNewListings({ fetchJson: fn, nowMs: NOW, excludeSymbols: new Set(["BTCUSDT"]) });
    expect(found.map((f) => f.symbol)).toEqual(["NEWAUSDT", "1000NEWBUSDT"]); // newest first, OLD/BTC/DEAD out
    expect(found[1]!.baseAsset).toBe("NEWB");
    expect(found[0]!.ageDays).toBeCloseTo(10, 1);
  });

  it("resolves ambiguous CoinGecko tickers to the HIGHEST market cap coin (copycat protection)", async () => {
    const { fn } = fakeFetch({
      "/coins/list": [
        { id: "newa-real", symbol: "newa", name: "Newa Protocol" },
        { id: "newa-scam", symbol: "newa", name: "Newa Inu" },
      ],
      "/coins/markets": [
        { id: "newa-scam", symbol: "newa", market_cap: 5_000 },
        { id: "newa-real", symbol: "newa", market_cap: 900_000_000 },
      ],
    });
    const ids = await resolveCoingeckoIds(["NEWA"], fn);
    expect(ids.get("newa")).toBe("newa-real");
  });

  it("builds an honest fundamentals profile (nulls where data is missing, html stripped)", async () => {
    const { fn } = fakeFetch({
      "/coins/newa-real": {
        id: "newa-real",
        name: "Newa Protocol",
        description: { en: "<p>A modular <b>data availability</b> layer for rollups.</p>" },
        categories: ["Layer 1", "Data Availability"],
        market_cap_rank: 80,
        genesis_date: null,
        links: { homepage: ["https://newa.xyz"], repos_url: { github: ["https://github.com/newa/newa"] } },
        market_data: {
          market_cap: { usd: 900_000_000 },
          fully_diluted_valuation: { usd: 3_000_000_000 },
          circulating_supply: 300_000_000,
          total_supply: 1_000_000_000,
        },
        developer_data: { stars: 1200, commit_count_4_weeks: 42 },
      },
    });
    const f = (await fetchFundamentals("newa-real", fn))!;
    expect(f.description).toBe("A modular data availability layer for rollups.");
    expect(f.circulatingRatio).toBeCloseTo(0.3, 6);
    expect(f.genesisDate).toBeNull();
    expect(f.commits4w).toBe(42);
  });

  it("score is NULL (never fabricated) without fundamentals, and flags explain why", () => {
    const noData = scoreRadarCoin({ ageDays: 5, volume24hUsd: 50_000_000, fundamentals: null });
    expect(noData.score).toBeNull();
    expect(noData.flags).toContain("NO_FUNDAMENTAL_DATA");
    expect(noData.flags).toContain("VERY_NEW");
  });

  it("full cycle: discovers, enriches, persists — and self-throttles inside the 12h window", async () => {
    const { fn, calls } = fakeFetch({
      "exchangeInfo": exchangeInfo,
      "ticker/24hr": [
        { symbol: "NEWAUSDT", quoteVolume: "150000000", lastPrice: "2.5" },
        { symbol: "1000NEWBUSDT", quoteVolume: "9000000", lastPrice: "0.01" },
      ],
      "/coins/list": [{ id: "newa-real", symbol: "newa", name: "Newa Protocol" }],
      "/coins/newa-real": {
        id: "newa-real", name: "Newa Protocol",
        description: { en: "A modular data availability layer that lets rollups post data cheaply." },
        categories: ["Data Availability"], market_cap_rank: 80,
        links: { homepage: ["https://newa.xyz"], repos_url: { github: ["https://github.com/newa/newa"] } },
        market_data: { market_cap: { usd: 9e8 }, fully_diluted_valuation: { usd: 3e9 }, circulating_supply: 3e8, total_supply: 1e9 },
        developer_data: { stars: 1200, commit_count_4_weeks: 42 },
      },
    });
    const store = new NewCoinRadarStore(tmpDir());
    const res = await runNewCoinRadarCycle({ store, nowMs: NOW, excludeSymbols: new Set(["BTCUSDT"]), fetchJson: fn, paceMs: 0 });
    expect(res.discovered).toBe(2);
    expect(res.enriched).toBe(1); // only NEWA resolves; NEWB has no CoinGecko entry
    const newa = store.getState().coins.find((c) => c.symbol === "NEWAUSDT")!;
    expect(newa.fundamentals?.name).toBe("Newa Protocol");
    expect(newa.score).toBeGreaterThan(50);
    const newb = store.getState().coins.find((c) => c.symbol === "1000NEWBUSDT")!;
    expect(newb.fundamentals).toBeNull();
    expect(newb.flags).toContain("NO_FUNDAMENTAL_DATA");
    expect(newb.flags).toContain("LOW_LIQUIDITY");

    // Second run inside the refresh window must be a no-op (no extra network calls).
    const callsBefore = calls.length;
    const res2 = await runNewCoinRadarCycle({ store, nowMs: NOW + 3_600_000, excludeSymbols: new Set(), fetchJson: fn, paceMs: 0 });
    expect(res2).toEqual({ discovered: 0, enriched: 0 });
    expect(calls.length).toBe(callsBefore);
  });
});

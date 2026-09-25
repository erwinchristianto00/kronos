import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCanonicalMarketRegimeUniverse,
  resolveCanonicalMarketRegimeUniverseThresholds,
  CanonicalMarketRegimeUniverseStore,
  getCanonicalMarketRegimeUniverseStore,
  _resetCanonicalMarketRegimeUniverseForTests,
  DEFAULT_CANONICAL_UNIVERSE_MIN_QUOTE_VOLUME_24H_USD,
  DEFAULT_CANONICAL_UNIVERSE_MAX_SPREAD_BPS,
  DEFAULT_CANONICAL_UNIVERSE_MIN_HISTORY_DAYS,
  DEFAULT_CANONICAL_UNIVERSE_MIN_OPEN_INTEREST_USD,
  CANONICAL_MARKET_REGIME_UNIVERSE_SCHEMA_VERSION,
  CANONICAL_MARKET_REGIME_UNIVERSE_THRESHOLDS_VERSION,
  type CanonicalMarketRegimeUniverseFetchCtx,
  type CanonicalMarketRegimeUniverseSnapshot,
} from "../src/lib/canonical-market-regime-universe.js";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NO_ENV = {} as NodeJS.ProcessEnv;

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "canonical-universe-"));
}

interface SymbolSpec {
  symbol: string;
  status?: string;
  contractType?: string;
  quoteAsset?: string;
  onboardDateDaysAgo?: number;
  quoteVolume24hUsd?: number;
  lastPrice?: number;
}

function buildFetchJson(specs: SymbolSpec[]) {
  const exchangeInfo = {
    symbols: specs.map((s) => ({
      symbol: s.symbol,
      status: s.status ?? "TRADING",
      contractType: s.contractType ?? "PERPETUAL",
      quoteAsset: s.quoteAsset ?? "USDT",
      onboardDate: NOW - (s.onboardDateDaysAgo ?? 365) * DAY_MS,
    })),
  };
  const tickers = specs
    .filter((s) => s.quoteVolume24hUsd !== undefined)
    .map((s) => ({ symbol: s.symbol, quoteVolume: String(s.quoteVolume24hUsd), lastPrice: String(s.lastPrice ?? 100) }));
  return async (url: string): Promise<unknown> => {
    if (url.includes("exchangeInfo")) return exchangeInfo;
    if (url.includes("ticker/24hr")) return tickers;
    throw new Error(`unexpected url ${url}`);
  };
}

interface BookSpec {
  bid: number;
  ask: number;
  oi: number;
}

function buildCtx(rows: Record<string, BookSpec>, calls: string[] = []): CanonicalMarketRegimeUniverseFetchCtx {
  return {
    getFuturesBookTicker: async (symbol) => {
      calls.push(`book:${symbol}`);
      const row = rows[symbol];
      if (!row) throw new Error(`no book ticker fixture for ${symbol}`);
      return { bid: row.bid, ask: row.ask };
    },
    getFuturesOpenInterest: async (symbol) => {
      calls.push(`oi:${symbol}`);
      const row = rows[symbol];
      if (!row) throw new Error(`no OI fixture for ${symbol}`);
      return { openInterest: row.oi };
    },
  };
}

// bid/ask/oi tuned against lastPrice=100 (buildFetchJson's default) so spreadBps/openInterestUsd land
// cleanly on either side of the default thresholds (25bps / $2,000,000).
const GOOD_BOOK: BookSpec = { bid: 100, ask: 100.05, oi: 50_000 }; // ~5bps spread, $5,000,000 OI
const WIDE_SPREAD_BOOK: BookSpec = { bid: 100, ask: 101, oi: 50_000 }; // ~99.5bps spread — fails
const LOW_OI_BOOK: BookSpec = { bid: 100, ask: 100.05, oi: 1_000 }; // $100,000 OI — fails

describe("canonical-market-regime-universe", () => {
  beforeEach(() => {
    _resetCanonicalMarketRegimeUniverseForTests();
  });

  it("[BASE FILTER] keeps only TRADING PERPETUAL USDT symbols", async () => {
    const specs: SymbolSpec[] = [
      { symbol: "GOODUSDT", quoteVolume24hUsd: 5_000_000 },
      { symbol: "SETTLINGUSDT", status: "SETTLING", quoteVolume24hUsd: 5_000_000 },
      { symbol: "DELIVERYUSDT", contractType: "DELIVERY", quoteVolume24hUsd: 5_000_000 },
      { symbol: "GOODBUSD", quoteAsset: "BUSD", quoteVolume24hUsd: 5_000_000 },
    ];
    const ctx = buildCtx({ GOODUSDT: GOOD_BOOK, SETTLINGUSDT: GOOD_BOOK, DELIVERYUSDT: GOOD_BOOK, GOODBUSD: GOOD_BOOK });
    const result = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson(specs),
      env: NO_ENV,
      dataDir: freshDataDir(),
    });
    expect(result.symbols).toEqual(["GOODUSDT"]);
    expect(result.source).toBe("FRESH");
    expect(result.schemaVersion).toBe(CANONICAL_MARKET_REGIME_UNIVERSE_SCHEMA_VERSION);
  });

  it("[CHEAP FILTERS] excludes low-volume and too-new listings before any per-symbol call is made", async () => {
    const specs: SymbolSpec[] = [
      { symbol: "OKUSDT", quoteVolume24hUsd: 5_000_000, onboardDateDaysAgo: 365 },
      { symbol: "LOWVOLUSDT", quoteVolume24hUsd: 500_000, onboardDateDaysAgo: 365 }, // fails volume floor
      { symbol: "TOONEWUSDT", quoteVolume24hUsd: 5_000_000, onboardDateDaysAgo: 5 }, // fails history floor
    ];
    const calls: string[] = [];
    // Deliberately NO ctx fixture for the two excluded symbols — if the cheap filter ever let them
    // through to the per-symbol stage, buildCtx would throw "no book ticker fixture for ...".
    const ctx = buildCtx({ OKUSDT: GOOD_BOOK }, calls);
    const result = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson(specs),
      env: NO_ENV,
      dataDir: freshDataDir(),
    });
    expect(result.symbols).toEqual(["OKUSDT"]);
    expect(calls.some((c) => c.includes("LOWVOLUSDT"))).toBe(false);
    expect(calls.some((c) => c.includes("TOONEWUSDT"))).toBe(false);
  });

  it("[EXPENSIVE FILTERS] excludes wide-spread and low-OI symbols using real per-symbol data", async () => {
    const specs: SymbolSpec[] = [
      { symbol: "OKUSDT", quoteVolume24hUsd: 5_000_000 },
      { symbol: "WIDEUSDT", quoteVolume24hUsd: 5_000_000 },
      { symbol: "LOWOIUSDT", quoteVolume24hUsd: 5_000_000 },
    ];
    const ctx = buildCtx({ OKUSDT: GOOD_BOOK, WIDEUSDT: WIDE_SPREAD_BOOK, LOWOIUSDT: LOW_OI_BOOK });
    const result = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson(specs),
      env: NO_ENV,
      dataDir: freshDataDir(),
    });
    expect(result.symbols).toEqual(["OKUSDT"]);
    expect(result.perSymbolMeta.OKUSDT?.dataQuality).toBe("OK");
  });

  it("[FAIL-CLOSED] a per-symbol fetch failure marks MISSING and excludes the symbol — never fabricates a passing 0", async () => {
    const specs: SymbolSpec[] = [
      { symbol: "OKUSDT", quoteVolume24hUsd: 5_000_000 },
      { symbol: "BROKENUSDT", quoteVolume24hUsd: 5_000_000 },
    ];
    const ctx: CanonicalMarketRegimeUniverseFetchCtx = {
      getFuturesBookTicker: async (symbol) => {
        if (symbol === "BROKENUSDT") throw new Error("simulated network failure");
        return { bid: GOOD_BOOK.bid, ask: GOOD_BOOK.ask };
      },
      getFuturesOpenInterest: async () => ({ openInterest: GOOD_BOOK.oi }),
    };
    const result = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson(specs),
      env: NO_ENV,
      dataDir: freshDataDir(),
    });
    expect(result.symbols).toEqual(["OKUSDT"]);
    expect(result.perSymbolMeta.BROKENUSDT).toBeUndefined();
  });

  it("[CAP + TIE-BREAK] ranks by 24h quote volume descending, capped at maxUniverseSize, ties broken alphabetically", async () => {
    const specs: SymbolSpec[] = [
      { symbol: "BBBUSDT", quoteVolume24hUsd: 10_000_000 },
      { symbol: "AAAUSDT", quoteVolume24hUsd: 10_000_000 }, // tie with BBB — alphabetical wins
      { symbol: "ZZZUSDT", quoteVolume24hUsd: 20_000_000 }, // highest volume
    ];
    const ctx = buildCtx({ BBBUSDT: GOOD_BOOK, AAAUSDT: GOOD_BOOK, ZZZUSDT: GOOD_BOOK });
    const result = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson(specs),
      env: { CANONICAL_UNIVERSE_MAX_SIZE: "2" } as NodeJS.ProcessEnv,
      dataDir: freshDataDir(),
    });
    expect(result.symbols).toEqual(["ZZZUSDT", "AAAUSDT"]);
  });

  it("[TTL] serves the cached snapshot within 6h without re-fetching", async () => {
    const dataDir = freshDataDir();
    const ctx = buildCtx({ OKUSDT: GOOD_BOOK });
    const first = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson([{ symbol: "OKUSDT", quoteVolume24hUsd: 5_000_000 }]),
      env: NO_ENV,
      dataDir,
    });
    const throwingFetchJson = async (): Promise<unknown> => {
      throw new Error("must not be called within the TTL window");
    };
    const second = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW + HOUR_MS, // 1h later, well within the 6h TTL
      ctx,
      fetchJson: throwingFetchJson,
      env: NO_ENV,
      dataDir,
    });
    expect(second).toEqual(first);
  });

  it("[TTL] refreshes after the 6h TTL elapses", async () => {
    const dataDir = freshDataDir();
    const ctx = buildCtx({ OLDUSDT: GOOD_BOOK, NEWUSDT: GOOD_BOOK });
    const first = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson([{ symbol: "OLDUSDT", quoteVolume24hUsd: 5_000_000 }]),
      env: NO_ENV,
      dataDir,
    });
    expect(first.symbols).toEqual(["OLDUSDT"]);
    const second = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW + 7 * HOUR_MS,
      ctx,
      fetchJson: buildFetchJson([{ symbol: "NEWUSDT", quoteVolume24hUsd: 5_000_000 }]),
      env: NO_ENV,
      dataDir,
    });
    expect(second.symbols).toEqual(["NEWUSDT"]);
    expect(second.source).toBe("FRESH");
  });

  it("[STALE FALLBACK] a fetch failure re-serves the last FRESH resolution relabeled STALE_FALLBACK", async () => {
    const dataDir = freshDataDir();
    const ctx = buildCtx({ OKUSDT: GOOD_BOOK });
    const first = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson([{ symbol: "OKUSDT", quoteVolume24hUsd: 5_000_000 }]),
      env: NO_ENV,
      dataDir,
    });
    expect(first.source).toBe("FRESH");
    const failingFetchJson = async (): Promise<unknown> => {
      throw new Error("simulated Binance outage");
    };
    const second = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW + 7 * HOUR_MS, // past TTL, forces a real refresh attempt
      ctx,
      fetchJson: failingFetchJson,
      env: NO_ENV,
      dataDir,
    });
    expect(second.source).toBe("STALE_FALLBACK");
    expect(second.symbols).toEqual(first.symbols);
    expect(second.resolvedAtMs).toBe(first.resolvedAtMs); // the DATA's age is preserved, not bumped to "now"
  });

  it("[STALE FALLBACK] zero survivors is treated as a failure, not a valid empty universe", async () => {
    const dataDir = freshDataDir();
    const ctx = buildCtx({ OKUSDT: GOOD_BOOK });
    const first = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson([{ symbol: "OKUSDT", quoteVolume24hUsd: 5_000_000 }]),
      env: NO_ENV,
      dataDir,
    });
    expect(first.symbols).toEqual(["OKUSDT"]);
    // Next cycle: the only candidate now fails the base filter (delisted) -> zero survivors.
    const second = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW + 7 * HOUR_MS,
      ctx,
      fetchJson: buildFetchJson([{ symbol: "OKUSDT", quoteVolume24hUsd: 5_000_000, status: "BREAK" }]),
      env: NO_ENV,
      dataDir,
    });
    expect(second.source).toBe("STALE_FALLBACK");
    expect(second.symbols).toEqual(["OKUSDT"]); // still serving the last known-good universe
  });

  it("[NO CACHE] throws when there is no prior resolution AND the fresh attempt fails", async () => {
    const dataDir = freshDataDir();
    const ctx = buildCtx({});
    const failingFetchJson = async (): Promise<unknown> => {
      throw new Error("simulated Binance outage");
    };
    await expect(
      resolveCanonicalMarketRegimeUniverse({ nowMs: NOW, ctx, fetchJson: failingFetchJson, env: NO_ENV, dataDir }),
    ).rejects.toThrow("simulated Binance outage");
  });

  it("[NO CACHE] throws when zero symbols pass every filter and there is no prior cache", async () => {
    const dataDir = freshDataDir();
    const ctx = buildCtx({});
    await expect(
      resolveCanonicalMarketRegimeUniverse({
        nowMs: NOW,
        ctx,
        fetchJson: buildFetchJson([{ symbol: "TOONEWUSDT", quoteVolume24hUsd: 5_000_000, onboardDateDaysAgo: 1 }]),
        env: NO_ENV,
        dataDir,
      }),
    ).rejects.toThrow(/ZERO symbols/);
  });

  it("[RESTART] seeds the in-memory cache from the on-disk store on a fresh process, avoiding an immediate re-fetch", async () => {
    const dataDir = freshDataDir();
    const ctx = buildCtx({ OKUSDT: GOOD_BOOK });
    const first = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW,
      ctx,
      fetchJson: buildFetchJson([{ symbol: "OKUSDT", quoteVolume24hUsd: 5_000_000 }]),
      env: NO_ENV,
      dataDir,
    });
    expect(first.symbols).toEqual(["OKUSDT"]);
    // Simulate a process restart: module-level singletons reset, but the disk file survives.
    _resetCanonicalMarketRegimeUniverseForTests();
    const throwingFetchJson = async (): Promise<unknown> => {
      throw new Error("must not be called — the persisted snapshot is still within TTL");
    };
    const afterRestart = await resolveCanonicalMarketRegimeUniverse({
      nowMs: NOW + HOUR_MS,
      ctx,
      fetchJson: throwingFetchJson,
      env: NO_ENV,
      dataDir,
    });
    expect(afterRestart.symbols).toEqual(["OKUSDT"]);
    expect(afterRestart.source).toBe("FRESH");
  });

  it("[STORE] persists atomically and reloads across a fresh store instance", () => {
    const dataDir = freshDataDir();
    const store = new CanonicalMarketRegimeUniverseStore(dataDir);
    expect(store.get()).toBeNull();
    const snapshot: CanonicalMarketRegimeUniverseSnapshot = {
      schemaVersion: CANONICAL_MARKET_REGIME_UNIVERSE_SCHEMA_VERSION,
      thresholdsVersion: CANONICAL_MARKET_REGIME_UNIVERSE_THRESHOLDS_VERSION,
      resolvedAtMs: NOW,
      source: "FRESH",
      symbols: ["OKUSDT"],
      perSymbolMeta: {
        OKUSDT: { quoteVolume24hUsd: 5_000_000, spreadBps: 5, openInterestUsd: 5_000_000, listedDaysAgo: 365, dataQuality: "OK" },
      },
    };
    store.save(snapshot);
    const reloaded = new CanonicalMarketRegimeUniverseStore(dataDir);
    expect(reloaded.get()).toEqual(snapshot);
  });

  it("[STORE] discards a corrupted persisted file and starts cold instead of throwing", () => {
    const dataDir = freshDataDir();
    const filePath = join(dataDir, "canonical-market-regime-universe.json");
    writeFileSync(filePath, "{ not valid json");
    const reloaded = new CanonicalMarketRegimeUniverseStore(dataDir);
    expect(reloaded.get()).toBeNull();
    expect(existsSync(filePath)).toBe(true); // the corrupt file itself is left alone, not deleted
  });

  it("[ENV] applies threshold overrides with safe fallback for invalid values", () => {
    const overridden = resolveCanonicalMarketRegimeUniverseThresholds({
      CANONICAL_UNIVERSE_MIN_QUOTE_VOLUME_24H_USD: "9000000",
      CANONICAL_UNIVERSE_MAX_SPREAD_BPS: "-5", // invalid (not > 0) -> falls back to the default
    } as NodeJS.ProcessEnv);
    expect(overridden.minQuoteVolume24hUsd).toBe(9_000_000);
    expect(overridden.maxSpreadBps).toBe(DEFAULT_CANONICAL_UNIVERSE_MAX_SPREAD_BPS);
    expect(overridden.thresholdsVersion).toBe(CANONICAL_MARKET_REGIME_UNIVERSE_THRESHOLDS_VERSION);

    const defaults = resolveCanonicalMarketRegimeUniverseThresholds(NO_ENV);
    expect(defaults.minQuoteVolume24hUsd).toBe(DEFAULT_CANONICAL_UNIVERSE_MIN_QUOTE_VOLUME_24H_USD);
    expect(defaults.minHistoryDays).toBe(DEFAULT_CANONICAL_UNIVERSE_MIN_HISTORY_DAYS);
    expect(defaults.minOpenInterestUsd).toBe(DEFAULT_CANONICAL_UNIVERSE_MIN_OPEN_INTEREST_USD);
  });

  it("[SINGLETON] getCanonicalMarketRegimeUniverseStore returns the same instance until reset", () => {
    const dataDir = freshDataDir();
    const a = getCanonicalMarketRegimeUniverseStore(dataDir);
    const b = getCanonicalMarketRegimeUniverseStore(dataDir);
    expect(a).toBe(b);
    _resetCanonicalMarketRegimeUniverseForTests();
    const c = getCanonicalMarketRegimeUniverseStore(dataDir);
    expect(c).not.toBe(a);
  });
});

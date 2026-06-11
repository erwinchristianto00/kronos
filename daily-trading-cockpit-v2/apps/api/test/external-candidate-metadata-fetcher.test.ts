import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _clearExternalCandidateMetadataCacheForTest,
  fetchExternalCandidateMetadataSnapshotWithDiagnostics,
  MIN_PERSISTABLE_JOINED_COUNT,
} from "../src/lib/external-candidate-metadata-fetcher.js";

const CURRENT_UNIVERSE = ["BTCUSDT", "ETHUSDT"];

function buildHealthyPayloads(symbolCount = 120): Record<string, unknown> {
  const symbols = Array.from({ length: symbolCount }, (_, i) => ({
    symbol: `SYM${i}USDT`,
    quoteAsset: "USDT",
    baseAsset: `SYM${i}`,
    status: "TRADING",
    isSpotTradingAllowed: true,
    permissions: [],
  }));
  const tickers = symbols.map((s) => ({
    symbol: s.symbol,
    lastPrice: "150",
    priceChangePercent: "4.1",
    quoteVolume: "250000000",
  }));
  const books = symbols.map((s) => ({
    symbol: s.symbol,
    bidPrice: "149.95",
    askPrice: "150.05",
  }));
  return {
    "/api/v3/exchangeInfo": { symbols },
    "/api/v3/ticker/24hr": tickers,
    "/api/v3/ticker/bookTicker": books,
  };
}

beforeEach(() => {
  // Default every test to an isolated, nonexistent disk path so cold-start
  // hydration is a no-op unless a test explicitly opts in.
  const dir = mkdtempSync(join(tmpdir(), "ext-meta-default-"));
  process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = join(dir, "snapshot.json");
  _clearExternalCandidateMetadataCacheForTest();
});

afterEach(() => {
  _clearExternalCandidateMetadataCacheForTest();
  delete process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
});

function makeFetch(payloads: Record<string, unknown>, failingPath?: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = new URL(url).pathname;
    if (failingPath && path === failingPath) {
      throw new Error(`forced failure for ${path}`);
    }
    const payload = payloads[path];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("external candidate metadata fetcher", () => {
  it("accepts exchangeInfo rows with empty permissions arrays and joins metadata", async () => {
    const result = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      fetchImpl: makeFetch({
        "/api/v3/exchangeInfo": {
          symbols: [
            { symbol: "BTCUSDT", quoteAsset: "USDT", baseAsset: "BTC", status: "TRADING", isSpotTradingAllowed: true, permissions: [] },
            { symbol: "SOLUSDT", quoteAsset: "USDT", baseAsset: "SOL", status: "TRADING", isSpotTradingAllowed: true, permissions: [] },
          ],
        },
        "/api/v3/ticker/24hr": [
          { symbol: "BTCUSDT", lastPrice: "100000", priceChangePercent: "1.2", quoteVolume: "1000000000" },
          { symbol: "SOLUSDT", lastPrice: "150", priceChangePercent: "4.1", quoteVolume: "250000000" },
        ],
        "/api/v3/ticker/bookTicker": [
          { symbol: "BTCUSDT", bidPrice: "99999", askPrice: "100001" },
          { symbol: "SOLUSDT", bidPrice: "149.95", askPrice: "150.05" },
        ],
      }),
      now: 1,
    });

    expect(result.diagnostics.sourceStatus).toBe("HEALTHY");
    expect(result.diagnostics.exchangeInfo.rawCount).toBe(2);
    expect(result.diagnostics.join.joinedMetadataCount).toBe(2);
    expect(result.metadata.some((row) => row.symbol === "SOLUSDT")).toBe(true);
  });

  it("marks source as FAILED when all live fetches fail and no cache exists", async () => {
    const result = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      fetchImpl: makeFetch({}, "/api/v3/exchangeInfo"),
      now: 1,
    });

    expect(result.metadata).toEqual([]);
    expect(result.diagnostics.sourceStatus).toBe("FAILED");
    expect(result.diagnostics.join.finalMetadataCount).toBe(0);
    expect(result.diagnostics.exchangeInfo.errorMessage).toContain("forced failure");
  });

  it("preserves per-source diagnostics when only one live metadata source fails", async () => {
    const result = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      fetchImpl: makeFetch({
        "/api/v3/exchangeInfo": {
          symbols: [{ symbol: "SOLUSDT", quoteAsset: "USDT", baseAsset: "SOL", status: "TRADING", isSpotTradingAllowed: true, permissions: [] }],
        },
        "/api/v3/ticker/24hr": [{ symbol: "SOLUSDT", lastPrice: "150", priceChangePercent: "4.1", quoteVolume: "250000000" }],
        "/api/v3/ticker/bookTicker": [{ symbol: "SOLUSDT", bidPrice: "149.95", askPrice: "150.05" }],
      }, "/api/v3/ticker/24hr"),
      now: 1,
    });

    expect(result.diagnostics.sourceStatus).toBe("FAILED");
    expect(result.diagnostics.exchangeInfo).toMatchObject({ ok: true, rawCount: 1 });
    expect(result.diagnostics.ticker24h.ok).toBe(false);
    expect(result.diagnostics.ticker24h.errorMessage).toContain("forced failure");
    expect(result.diagnostics.bookTicker).toMatchObject({ ok: true, rawCount: 1 });
  });

  it("fails over from unreachable primary host to reachable alternate host", async () => {
    const seenHosts: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seenHosts.push(url.host);
      if (url.host === "api.binance.com") {
        const abortError = new Error("This operation was aborted");
        abortError.name = "AbortError";
        throw abortError;
      }
      const payload = {
        "/api/v3/exchangeInfo": {
          symbols: [{ symbol: "SOLUSDT", quoteAsset: "USDT", baseAsset: "SOL", status: "TRADING", isSpotTradingAllowed: true, permissions: [] }],
        },
        "/api/v3/ticker/24hr": [{ symbol: "SOLUSDT", lastPrice: "150", priceChangePercent: "4.1", quoteVolume: "250000000" }],
        "/api/v3/ticker/bookTicker": [{ symbol: "SOLUSDT", bidPrice: "149.95", askPrice: "150.05" }],
      }[url.pathname];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      fetchImpl,
      now: 1,
    });

    expect(result.diagnostics.sourceStatus).toBe("HEALTHY");
    expect(result.diagnostics.exchangeInfo).toMatchObject({
      ok: true,
      rawCount: 1,
      baseUrl: "https://api-gcp.binance.com",
      attemptCount: 1,
    });
    expect(result.diagnostics.notes.some((note) => note.includes("api.binance.com/api/v3/exchangeInfo"))).toBe(true);
    expect(seenHosts).toContain("api.binance.com");
    expect(seenHosts).toContain("api-gcp.binance.com");
  });

  it("returns DEGRADED with cache hit when a later refresh fails", async () => {
    await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      fetchImpl: makeFetch({
        "/api/v3/exchangeInfo": {
          symbols: [{ symbol: "SOLUSDT", quoteAsset: "USDT", baseAsset: "SOL", status: "TRADING", isSpotTradingAllowed: true, permissions: [] }],
        },
        "/api/v3/ticker/24hr": [{ symbol: "SOLUSDT", lastPrice: "150", priceChangePercent: "4.1", quoteVolume: "250000000" }],
        "/api/v3/ticker/bookTicker": [{ symbol: "SOLUSDT", bidPrice: "149.95", askPrice: "150.05" }],
      }),
      now: 1,
    });

    const degraded = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      fetchImpl: makeFetch({
        "/api/v3/exchangeInfo": {
          symbols: [{ symbol: "SOLUSDT", quoteAsset: "USDT", baseAsset: "SOL", status: "TRADING", isSpotTradingAllowed: true, permissions: [] }],
        },
        "/api/v3/ticker/24hr": [{ symbol: "SOLUSDT", lastPrice: "150", priceChangePercent: "4.1", quoteVolume: "250000000" }],
        "/api/v3/ticker/bookTicker": [{ symbol: "SOLUSDT", bidPrice: "149.95", askPrice: "150.05" }],
      }, "/api/v3/exchangeInfo"),
      now: 1 + 6 * 60 * 1000,
    });

    expect(degraded.diagnostics.sourceStatus).toBe("DEGRADED_USING_CACHE");
    expect(degraded.diagnostics.cacheStatus).toBe("STALE_FALLBACK");
    expect(degraded.diagnostics.servedFromCache).toBe(true);
    expect(degraded.metadata.length).toBe(1);
    expect(degraded.metadata[0]).toMatchObject({
      symbol: "SOLUSDT",
      latestPrice: 150,
      quoteVolume24h: 250000000,
      spreadBps: expect.any(Number),
    });
    expect(degraded.diagnostics.exchangeInfo.ok).toBe(false);
    expect(degraded.diagnostics.ticker24h.ok).toBe(true);
    expect(degraded.diagnostics.bookTicker.ok).toBe(true);
    expect(degraded.diagnostics.notes[0]).toContain("stale");
  });

  it("successful fetch writes durable snapshot to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-meta-snap-"));
    const diskPath = join(dir, "snapshot.json");
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = diskPath;
    _clearExternalCandidateMetadataCacheForTest();

    try {
      await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
        currentUniverseSymbols: CURRENT_UNIVERSE,
        fetchImpl: makeFetch(buildHealthyPayloads(120)),
        now: 1,
      });

      // Allow the fire-and-forget persistSnapshotToDisk() to complete. Poll briefly
      // because writeFile + rename involve real I/O microtasks.
      const { existsSync } = await import("node:fs");
      for (let i = 0; i < 50 && !existsSync(diskPath); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const raw = readFileSync(diskPath, "utf8");
      const parsed = JSON.parse(raw) as { cachedAt: number; value: unknown[] };
      expect(typeof parsed.cachedAt).toBe("number");
      expect(Array.isArray(parsed.value)).toBe(true);
      expect(parsed.value.length).toBe(120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cold-start with persisted disk snapshot serves STALE_FALLBACK when fresh fetch fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-meta-snap-"));
    const diskPath = join(dir, "snapshot.json");
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = diskPath;

    const pastEntry = {
      cachedAt: 0,
      value: Array.from({ length: 120 }, (_, i) => ({
        symbol: i === 0 ? "SOLUSDT" : `SYM${i}USDT`,
        baseAsset: i === 0 ? "SOL" : `SYM${i}`,
        quoteAsset: "USDT",
        instrumentType: "SPOT",
        status: "TRADING",
        latestPrice: 150,
        quoteVolume24h: 250000000,
        priceChangePct24h: 4.1,
        spreadBps: 6.6,
        fundingRate: null,
        openInterest: null,
        alreadyInCurrentUniverse: false,
      })),
    };
    writeFileSync(diskPath, JSON.stringify(pastEntry), "utf8");

    _clearExternalCandidateMetadataCacheForTest();

    try {
      const result = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
        currentUniverseSymbols: CURRENT_UNIVERSE,
        fetchImpl: makeFetch({}, "/api/v3/exchangeInfo"),
        now: 10 * 60 * 1000,
      });

      expect(result.diagnostics.sourceStatus).toBe("DEGRADED_USING_CACHE");
      expect(result.diagnostics.cacheStatus).toBe("STALE_FALLBACK");
      expect(result.diagnostics.servedFromCache).toBe(true);
      expect(result.metadata.length).toBeGreaterThan(0);
      expect(result.metadata[0].symbol).toBe("SOLUSDT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupt disk snapshot is ignored gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-meta-snap-"));
    const diskPath = join(dir, "snapshot.json");
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = diskPath;
    writeFileSync(diskPath, "not json{", "utf8");

    _clearExternalCandidateMetadataCacheForTest();

    try {
      const result = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
        currentUniverseSymbols: CURRENT_UNIVERSE,
        fetchImpl: makeFetch({}, "/api/v3/exchangeInfo"),
        now: 1,
      });

      expect(result.diagnostics.sourceStatus).toBe("FAILED");
      expect(result.diagnostics.cacheStatus).toBe("MISS");
      expect(result.metadata).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to persist a fixture-sized (<100 row) snapshot to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-meta-snap-"));
    const diskPath = join(dir, "snapshot.json");
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = diskPath;
    _clearExternalCandidateMetadataCacheForTest();

    try {
      await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
        currentUniverseSymbols: CURRENT_UNIVERSE,
        fetchImpl: makeFetch({
          "/api/v3/exchangeInfo": {
            symbols: [
              { symbol: "GOODUSDT", quoteAsset: "USDT", baseAsset: "GOOD", status: "TRADING", isSpotTradingAllowed: true, permissions: [] },
            ],
          },
          "/api/v3/ticker/24hr": [{ symbol: "GOODUSDT", lastPrice: "150", priceChangePercent: "4.1", quoteVolume: "250000000" }],
          "/api/v3/ticker/bookTicker": [{ symbol: "GOODUSDT", bidPrice: "149.95", askPrice: "150.05" }],
        }),
        now: 1,
      });

      // Wait for the fire-and-forget persistSnapshotToDisk() to settle.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { existsSync } = await import("node:fs");
      expect(existsSync(diskPath)).toBe(false);
      expect(MIN_PERSISTABLE_JOINED_COUNT).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a previously-poisoned fixture-sized snapshot during hydration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-meta-snap-"));
    const diskPath = join(dir, "snapshot.json");
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = diskPath;

    const poisoned = {
      cachedAt: Date.now(),
      value: [
        {
          symbol: "GOODUSDT",
          baseAsset: "GOOD",
          quoteAsset: "USDT",
          instrumentType: "SPOT",
          status: "TRADING",
          latestPrice: 150,
          quoteVolume24h: 250000000,
          priceChangePct24h: 4.1,
          spreadBps: 6.6,
          fundingRate: null,
          openInterest: null,
          alreadyInCurrentUniverse: false,
        },
      ],
    };
    writeFileSync(diskPath, JSON.stringify(poisoned), "utf8");

    _clearExternalCandidateMetadataCacheForTest();

    try {
      const result = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
        currentUniverseSymbols: CURRENT_UNIVERSE,
        fetchImpl: makeFetch({}, "/api/v3/exchangeInfo"),
        now: Date.now(),
      });

      expect(result.diagnostics.sourceStatus).toBe("FAILED");
      expect(result.diagnostics.cacheStatus).toBe("MISS");
      expect(result.metadata).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a healthy persisted snapshot with a fixture-sized one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-meta-snap-"));
    const diskPath = join(dir, "snapshot.json");
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = diskPath;
    _clearExternalCandidateMetadataCacheForTest();

    try {
      // First: persist a healthy 120-row snapshot.
      await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
        currentUniverseSymbols: CURRENT_UNIVERSE,
        fetchImpl: makeFetch(buildHealthyPayloads(120)),
        now: 1,
      });

      const { existsSync } = await import("node:fs");
      for (let i = 0; i < 50 && !existsSync(diskPath); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const firstRaw = readFileSync(diskPath, "utf8");
      const firstParsed = JSON.parse(firstRaw) as { value: unknown[] };
      expect(firstParsed.value.length).toBe(120);

      // Reset the in-process cache so the next fetch runs the full pipeline.
      _clearExternalCandidateMetadataCacheForTest();

      // Second: attempt a fetch returning a single fixture row. Persist must refuse.
      await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
        currentUniverseSymbols: CURRENT_UNIVERSE,
        fetchImpl: makeFetch({
          "/api/v3/exchangeInfo": {
            symbols: [
              { symbol: "GOODUSDT", quoteAsset: "USDT", baseAsset: "GOOD", status: "TRADING", isSpotTradingAllowed: true, permissions: [] },
            ],
          },
          "/api/v3/ticker/24hr": [{ symbol: "GOODUSDT", lastPrice: "150", priceChangePercent: "4.1", quoteVolume: "250000000" }],
          "/api/v3/ticker/bookTicker": [{ symbol: "GOODUSDT", bidPrice: "149.95", askPrice: "150.05" }],
        }),
        now: 2,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const secondRaw = readFileSync(diskPath, "utf8");
      const secondParsed = JSON.parse(secondRaw) as { value: unknown[] };
      expect(secondParsed.value.length).toBe(120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

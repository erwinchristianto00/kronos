import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { BINANCE_SPOT_BASE_URLS, type BinanceClient } from "./binance.js";
import type { ExternalDiscoveryCandidateMetadata } from "./external-candidate-discovery-intelligence.js";

/**
 * Read-only metadata fetcher for Phase 2E.2 — External Candidate Discovery Intelligence.
 *
 * Pulls a broad snapshot of tradable symbols from Binance spot exchange-info and 24h ticker
 * endpoints. Used only for advisory discovery; does NOT participate in live scanner ranking,
 * routing, or execution. Results are cached in-process with a short TTL to avoid hammering
 * the exchange.
 *
 * The engine that consumes these results (`external-candidate-discovery-intelligence.ts`)
 * is a pure function, so tests can bypass this fetcher entirely by supplying mock metadata.
 */

interface BinanceExchangeInfoResponse {
  symbols: Array<{
    symbol: string;
    status?: string;
    baseAsset?: string;
    quoteAsset?: string;
    isSpotTradingAllowed?: boolean;
    permissions?: string[];
  }>;
}

interface BinanceTicker24hr {
  symbol: string;
  lastPrice?: string;
  priceChangePercent?: string;
  quoteVolume?: string;
}

interface BinanceBookTicker {
  symbol: string;
  bidPrice?: string;
  askPrice?: string;
}

interface SnapshotCacheEntry {
  cachedAt: number;
  value: ExternalDiscoveryCandidateMetadata[];
}

export type ExternalCandidateMetadataSourceStatus = "HEALTHY" | "DEGRADED_USING_CACHE" | "FAILED" | "NOT_ATTEMPTED";
export type ExternalCandidateMetadataCacheStatus = "HIT" | "MISS" | "STALE_FALLBACK" | "BYPASSED";

export interface ExternalCandidateMetadataFetchDiagnostics {
  sourceStatus: ExternalCandidateMetadataSourceStatus;
  generatedAt: string;
  cacheStatus: ExternalCandidateMetadataCacheStatus;
  servedFromCache: boolean;
  exchangeInfo: {
    ok: boolean;
    rawCount: number;
    baseUrl?: string;
    attemptCount?: number;
    elapsedMs?: number;
    errorMessage?: string;
  };
  ticker24h: {
    ok: boolean;
    rawCount: number;
    baseUrl?: string;
    attemptCount?: number;
    elapsedMs?: number;
    errorMessage?: string;
  };
  bookTicker: {
    ok: boolean;
    rawCount: number;
    baseUrl?: string;
    attemptCount?: number;
    elapsedMs?: number;
    errorMessage?: string;
  };
  join: {
    joinedMetadataCount: number;
    missingTickerCount: number;
    missingBookTickerCount: number;
    finalMetadataCount: number;
  };
  notes: string[];
}

export interface ExternalCandidateMetadataSnapshotResult {
  metadata: ExternalDiscoveryCandidateMetadata[];
  diagnostics: ExternalCandidateMetadataFetchDiagnostics;
}

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;
const FETCH_RETRY_DELAYS_MS = [150, 300] as const;
const SNAPSHOT_CACHE_KEY = "binance_spot_external_candidate_snapshot";

// Smallest plausible universe size for a real Binance USDT-spot snapshot.
// Real fetches return ~400–700 symbols. Anything below this is a test fixture
// or a malformed/degraded fetch and must not be promoted to disk or hydrated.
export const MIN_PERSISTABLE_JOINED_COUNT = 100;
function resolveSnapshotDiskPath(): string {
  return (
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH ??
    join(process.cwd(), "data", "external-candidate-metadata-snapshot.json")
  );
}

const snapshotCache = new Map<string, SnapshotCacheEntry>();

let hydrationPromise: Promise<void> | null = null;

async function hydrateSnapshotCacheFromDiskOnce(): Promise<void> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const raw = await readFile(resolveSnapshotDiskPath(), "utf8");
      const parsed = JSON.parse(raw) as SnapshotCacheEntry;
      if (
        parsed &&
        Array.isArray(parsed.value) &&
        typeof parsed.cachedAt === "number" &&
        parsed.value.length >= MIN_PERSISTABLE_JOINED_COUNT
      ) {
        // Only hydrate if memory cache is empty for this key — never overwrite
        // a fresher in-process snapshot with a stale disk entry.
        if (!snapshotCache.has(SNAPSHOT_CACHE_KEY)) {
          snapshotCache.set(SNAPSHOT_CACHE_KEY, parsed);
        }
      }
    } catch {
      // best-effort cold-start hydrate — missing/corrupt file is fine
    }
  })();
  return hydrationPromise;
}

async function persistSnapshotToDisk(entry: SnapshotCacheEntry): Promise<void> {
  if (!Array.isArray(entry.value) || entry.value.length < MIN_PERSISTABLE_JOINED_COUNT) {
    return;
  }
  try {
    const target = resolveSnapshotDiskPath();
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(entry));
    await rename(tmp, target);
  } catch {
    // disk write failure must never break the live fetch path
  }
}

function parseFiniteNumber(s: string | undefined): number | null {
  if (s === undefined || s === null || s === "") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function computeSpreadBps(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return ((ask - bid) / mid) * 10_000;
}

async function rawFetchJson<T>(
  fetchImpl: typeof fetch,
  path: string,
): Promise<{
  payload: T;
  baseUrl: string;
  attemptCount: number;
  elapsedMs: number;
  priorFailures: string[];
}> {
  const startedAt = Date.now();
  const priorFailures: string[] = [];
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    for (const baseUrl of BINANCE_SPOT_BASE_URLS) {
      const url = `${baseUrl}${path}`;
      const attemptStartedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return {
          payload: (await res.json()) as T,
          baseUrl,
          attemptCount: attempt + 1,
          elapsedMs: Date.now() - startedAt,
          priorFailures,
        };
      } catch (error) {
        lastError = error;
        const elapsedMs = Date.now() - attemptStartedAt;
        const detail =
          error instanceof Error && error.name === "AbortError"
            ? `timeout after ${FETCH_TIMEOUT_MS}ms before response`
            : error instanceof Error && "cause" in error && (error as Error & { cause?: { code?: string } }).cause?.code
              ? `${(error as Error & { cause?: { code?: string } }).cause?.code}`
              : error instanceof Error
                ? error.message
                : "unknown fetch failure";
        priorFailures.push(`${baseUrl}${path}: ${detail} (${elapsedMs}ms)`);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (attempt < FETCH_RETRY_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAYS_MS[attempt]));
    }
  }
  const failureSummary = priorFailures.join(" | ");
  throw lastError instanceof Error
    ? new Error(`${lastError.message}; attempts exhausted: ${failureSummary}`)
    : new Error(`Unknown metadata fetch failure; attempts exhausted: ${failureSummary}`);
}

/**
 * Fetch a broad external candidate snapshot from Binance spot.
 *
 * Returns metadata for every USDT-quoted spot symbol with TRADING status,
 * including 24h volume, latest price, price change pct, and bid/ask spread.
 * Funding rate and open interest are not populated by this snapshot — they
 * would require per-symbol futures API calls and are reserved for a future
 * expansion (see IMPROVE_EXTERNAL_FEATURE_CAPTURE patch hypothesis).
 */
export async function fetchExternalCandidateMetadataSnapshot(opts: {
  binanceClient?: BinanceClient;
  currentUniverseSymbols: string[];
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ExternalDiscoveryCandidateMetadata[]> {
  const result = await fetchExternalCandidateMetadataSnapshotWithDiagnostics(opts);
  return result.metadata;
}

export async function fetchExternalCandidateMetadataSnapshotWithDiagnostics(opts: {
  binanceClient?: BinanceClient;
  currentUniverseSymbols: string[];
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ExternalCandidateMetadataSnapshotResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  await hydrateSnapshotCacheFromDiskOnce();
  const cached = snapshotCache.get(SNAPSHOT_CACHE_KEY);
  const baseDiagnostics: ExternalCandidateMetadataFetchDiagnostics = {
    sourceStatus: "NOT_ATTEMPTED",
    generatedAt: new Date(now).toISOString(),
    cacheStatus: "MISS",
    servedFromCache: false,
    exchangeInfo: { ok: false, rawCount: 0 },
    ticker24h: { ok: false, rawCount: 0 },
    bookTicker: { ok: false, rawCount: 0 },
    join: {
      joinedMetadataCount: 0,
      missingTickerCount: 0,
      missingBookTickerCount: 0,
      finalMetadataCount: 0,
    },
    notes: [],
  };
  if (cached && now - cached.cachedAt <= SNAPSHOT_TTL_MS) {
    return {
      metadata: markCurrentUniverseMembers(cached.value, opts.currentUniverseSymbols),
      diagnostics: {
        ...baseDiagnostics,
        sourceStatus: "HEALTHY",
        cacheStatus: "HIT",
        servedFromCache: true,
        join: {
          joinedMetadataCount: cached.value.length,
          missingTickerCount: 0,
          missingBookTickerCount: 0,
          finalMetadataCount: cached.value.length,
        },
        notes: ["Fresh in-process metadata cache hit."],
      },
    };
  }

  const [exchangeInfoResult, tickerResult, bookTickerResult] = await Promise.allSettled([
    rawFetchJson<BinanceExchangeInfoResponse>(fetchImpl, "/api/v3/exchangeInfo"),
    rawFetchJson<BinanceTicker24hr[]>(fetchImpl, "/api/v3/ticker/24hr"),
    rawFetchJson<BinanceBookTicker[]>(fetchImpl, "/api/v3/ticker/bookTicker"),
  ]);
  const failedMessages = [exchangeInfoResult, tickerResult, bookTickerResult]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : "Unknown metadata fetch failure");
  if (failedMessages.length > 0) {
    const staleHit = Boolean(cached);
    const staleValue = cached?.value ?? [];
    return {
      metadata: staleHit ? markCurrentUniverseMembers(staleValue, opts.currentUniverseSymbols) : [],
      diagnostics: {
        ...baseDiagnostics,
        sourceStatus: staleHit ? "DEGRADED_USING_CACHE" : "FAILED",
        cacheStatus: staleHit ? "STALE_FALLBACK" : "MISS",
        servedFromCache: staleHit,
        exchangeInfo: exchangeInfoResult.status === "fulfilled"
          ? {
              ok: true,
              rawCount: exchangeInfoResult.value.payload.symbols?.length ?? 0,
              baseUrl: exchangeInfoResult.value.baseUrl,
              attemptCount: exchangeInfoResult.value.attemptCount,
              elapsedMs: exchangeInfoResult.value.elapsedMs,
            }
          : { ok: false, rawCount: 0, errorMessage: exchangeInfoResult.reason instanceof Error ? exchangeInfoResult.reason.message : "Unknown exchangeInfo failure" },
        ticker24h: tickerResult.status === "fulfilled"
          ? {
              ok: true,
              rawCount: tickerResult.value.payload.length,
              baseUrl: tickerResult.value.baseUrl,
              attemptCount: tickerResult.value.attemptCount,
              elapsedMs: tickerResult.value.elapsedMs,
            }
          : { ok: false, rawCount: 0, errorMessage: tickerResult.reason instanceof Error ? tickerResult.reason.message : "Unknown ticker24h failure" },
        bookTicker: bookTickerResult.status === "fulfilled"
          ? {
              ok: true,
              rawCount: bookTickerResult.value.payload.length,
              baseUrl: bookTickerResult.value.baseUrl,
              attemptCount: bookTickerResult.value.attemptCount,
              elapsedMs: bookTickerResult.value.elapsedMs,
            }
          : { ok: false, rawCount: 0, errorMessage: bookTickerResult.reason instanceof Error ? bookTickerResult.reason.message : "Unknown bookTicker failure" },
        join: {
          joinedMetadataCount: staleHit ? staleValue.length : 0,
          missingTickerCount: 0,
          missingBookTickerCount: 0,
          finalMetadataCount: staleHit ? staleValue.length : 0,
        },
        notes: staleHit
          ? [`Live metadata fetch failed; returning stale in-process cache. Failed source(s): ${failedMessages.join(" | ")}`]
          : [`Live metadata fetch failed; no cache fallback available. Failed source(s): ${failedMessages.join(" | ")}`],
      },
    };
  }
  if (
    exchangeInfoResult.status !== "fulfilled" ||
    tickerResult.status !== "fulfilled" ||
    bookTickerResult.status !== "fulfilled"
  ) {
    throw new Error("Metadata fetch settled without failures but did not produce fulfilled results.");
  }
  const exchangeInfo = exchangeInfoResult.value.payload;
  const tickers = tickerResult.value.payload;
  const bookTickers = bookTickerResult.value.payload;

  const tickerMap = new Map<string, BinanceTicker24hr>();
  for (const t of tickers) {
    if (t?.symbol) tickerMap.set(t.symbol, t);
  }
  const bookTickerMap = new Map<string, BinanceBookTicker>();
  for (const b of bookTickers) {
    if (b?.symbol) bookTickerMap.set(b.symbol, b);
  }

  const currentUniverseSet = new Set(opts.currentUniverseSymbols);
  const snapshot: ExternalDiscoveryCandidateMetadata[] = [];
  let missingTickerCount = 0;
  let missingBookTickerCount = 0;

  for (const sym of exchangeInfo.symbols ?? []) {
    if (sym.quoteAsset !== "USDT") continue;
    // Permissions on Binance spot can be a flat array or grouped. We accept anything that includes SPOT.
    const allowsSpot = sym.isSpotTradingAllowed !== false
      && (sym.permissions === undefined || sym.permissions.length === 0 || sym.permissions.includes("SPOT"));
    if (!allowsSpot) continue;

    const ticker = tickerMap.get(sym.symbol);
    const book = bookTickerMap.get(sym.symbol);
    if (!ticker) missingTickerCount += 1;
    if (!book) missingBookTickerCount += 1;
    const bid = parseFiniteNumber(book?.bidPrice);
    const ask = parseFiniteNumber(book?.askPrice);
    snapshot.push({
      symbol: sym.symbol,
      baseAsset: sym.baseAsset ?? null,
      quoteAsset: sym.quoteAsset ?? null,
      instrumentType: "SPOT",
      status: sym.status ?? null,
      latestPrice: parseFiniteNumber(ticker?.lastPrice),
      quoteVolume24h: parseFiniteNumber(ticker?.quoteVolume),
      priceChangePct24h: parseFiniteNumber(ticker?.priceChangePercent),
      spreadBps: computeSpreadBps(bid, ask),
      fundingRate: null,
      openInterest: null,
      alreadyInCurrentUniverse: currentUniverseSet.has(sym.symbol),
    });
  }

  snapshotCache.set(SNAPSHOT_CACHE_KEY, { cachedAt: now, value: snapshot });
  void persistSnapshotToDisk({ cachedAt: now, value: snapshot });
  return {
    metadata: snapshot,
    diagnostics: {
      ...baseDiagnostics,
      sourceStatus: "HEALTHY",
      cacheStatus: "MISS",
      servedFromCache: false,
      exchangeInfo: {
        ok: true,
        rawCount: exchangeInfo.symbols?.length ?? 0,
        baseUrl: exchangeInfoResult.value.baseUrl,
        attemptCount: exchangeInfoResult.value.attemptCount,
        elapsedMs: exchangeInfoResult.value.elapsedMs,
      },
      ticker24h: {
        ok: true,
        rawCount: tickers.length,
        baseUrl: tickerResult.value.baseUrl,
        attemptCount: tickerResult.value.attemptCount,
        elapsedMs: tickerResult.value.elapsedMs,
      },
      bookTicker: {
        ok: true,
        rawCount: bookTickers.length,
        baseUrl: bookTickerResult.value.baseUrl,
        attemptCount: bookTickerResult.value.attemptCount,
        elapsedMs: bookTickerResult.value.elapsedMs,
      },
      join: {
        joinedMetadataCount: snapshot.length,
        missingTickerCount,
        missingBookTickerCount,
        finalMetadataCount: snapshot.length,
      },
      notes: [
        ...exchangeInfoResult.value.priorFailures.map((failure) => `exchangeInfo failover: ${failure}`),
        ...tickerResult.value.priorFailures.map((failure) => `ticker24h failover: ${failure}`),
        ...bookTickerResult.value.priorFailures.map((failure) => `bookTicker failover: ${failure}`),
      ],
    },
  };
}

function markCurrentUniverseMembers(
  snapshot: ExternalDiscoveryCandidateMetadata[],
  currentUniverseSymbols: string[],
): ExternalDiscoveryCandidateMetadata[] {
  const set = new Set(currentUniverseSymbols);
  return snapshot.map((m) => ({ ...m, alreadyInCurrentUniverse: set.has(m.symbol) }));
}

// Test-only — clear the in-process snapshot cache between scenarios.
export function _clearExternalCandidateMetadataCacheForTest(): void {
  snapshotCache.clear();
  hydrationPromise = null;
}

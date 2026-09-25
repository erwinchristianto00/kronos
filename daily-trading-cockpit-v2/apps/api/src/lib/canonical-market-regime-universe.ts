/**
 * CANONICAL MARKET REGIME — dynamic universe (2026-08, requirement #2 of the canonical-market-regime
 * rollout that replaces the fixed-20 candidate LONG/SHORT vote — scan-service.ts's deriveMarketRegime
 * — as the production regime source. See canonical-market-regime-engine.ts (a later file in this
 * rollout) for the snapshot/state-machine that CONSUMES this universe, and
 * canonical-market-regime-execution-policy.ts for the one shared execution gate every executor calls.
 *
 * Builds and persists a VERSIONED, FILTERED, DYNAMIC Binance USDT-perpetual universe: the set of
 * symbols the canonical regime engine is allowed to read raw completed-candle/volume/spread/OI data
 * from when it computes directionFast/directionSlow/breadth/cohesion/dispersion/riskStress. This
 * universe is DELIBERATELY WIDER than any single lane's own tradability bar
 * (external-candidate-discovery-intelligence.ts's TRADABILITY_THRESHOLDS: 10M min 24h volume / 10bps
 * max spread) — a regime-BREADTH signal wants more independent symbols contributing equal-weight
 * evidence, not just the handful a single lane would actually execute through.
 *
 * FILTERS (base + 4 numeric bars, each independently justified for a REGIME-BREADTH universe):
 *   - base (non-negotiable): status==="TRADING" && contractType==="PERPETUAL" && quoteAsset==="USDT"
 *     (Binance futures exchangeInfo) — only symbols the exchange itself currently lists as live USDT
 *     perps can produce a real completed-candle series; anything else is a data-quality dead end
 *     before any threshold below is even relevant.
 *   - minQuoteVolume24hUsd = 3,000,000 (vs the lane bar's 10,000,000) — wide enough to keep breadth
 *     meaningful (more independent symbols, not just the most-liquid handful a lane would trade),
 *     while still excluding the near-zero-volume/manipulation-prone microcap tail.
 *   - maxSpreadBps = 25 (vs the lane bar's 10) — a DATA-QUALITY proxy here ("is this book real/liquid
 *     enough that its OHLCV is trustworthy"), never an execution-cost bound (this universe never
 *     executes through the spread), so it can tolerate 2.5x the lane's execution-grade ceiling.
 *   - minHistoryDays = 30 — excludes brand-new/pre-discovery listings whose first days are
 *     structurally abnormal (listing-pump volatility, no real price-discovery yet).
 *   - minOpenInterestUsd = 2,000,000 — OI is a slower-moving, structurally smaller number than 24h
 *     turnover; requiring it merely be non-trivial (one order of magnitude below the liquidity floor)
 *     screens out a freshly-listed perp with no real standing positioning yet.
 *   - size cap = 60 (3x the old fixed-20 UNIVERSE in scan-service.ts), ranked by 24h quote volume
 *     descending, ties broken alphabetically for determinism — a MEMBER-COUNT cap only, bounding
 *     downstream compute/API-call volume per cycle.
 *
 * STAGING (load-bearing, not incidental): two BULK Binance calls — exchangeInfo, and the no-symbol-
 * param "/fapi/v1/ticker/24hr" (exactly the convention new-coin-radar.ts already uses for this same
 * endpoint: `fetchJson(\`${BINANCE_FAPI}/fapi/v1/ticker/24hr\`)`) — resolve the base filter plus the
 * two CHEAPEST numeric bars (volume, history) BEFORE any PER-SYMBOL call is made. Only the
 * post-prefilter candidate set incurs the two per-symbol calls (book ticker for spread, open
 * interest) — skipping this staging would turn every 6h refresh into ~150-300 avoidable per-symbol
 * Binance calls stacked on top of the scan cycle + regime-engine-service cycle + cross-sectional
 * cycle already hitting the same rate limits.
 *
 * exchangeInfo has NO method on the shared public BinanceClient (lib/binance.ts) today; every
 * existing consumer (new-coin-radar.ts, moonshot-lottery-cycle.ts,
 * external-candidate-metadata-fetcher.ts) does its own raw fetch rather than extending that shared,
 * heavily-used client — this module follows the SAME convention (a raw injectable `fetchJson` for the
 * two bulk calls) rather than modifying BinanceClient. The two PER-SYMBOL calls (spread, OI) instead
 * go through an injected `ctx` shaped EXACTLY like BinanceClient's own `getFuturesBookTicker`/
 * `getFuturesOpenInterest` methods (structural typing: a real BinanceClient instance satisfies this
 * interface with zero adapter code, and keeps its own caching/retry/timeout handling), so this module
 * gets that behavior for free without importing or coupling to the concrete class, and stays trivially
 * fakeable in tests — mirrors MoonshotExtractionCtx's own established shape in
 * moonshot-lottery-cycle.ts.
 *
 * DATA QUALITY IS FAIL-CLOSED, NEVER FABRICATED (mirrors replay-tier-a-core.ts's "missing inputs are
 * {value:null}, never fabricated" discipline): a candidate whose per-symbol spread/OI fetch fails, or
 * returns a non-finite value, is marked dataQuality "MISSING" and EXCLUDED from the published universe
 * — never defaulted to a value (e.g. spread=0, OI=0) that could silently satisfy a threshold it never
 * actually cleared. Only symbols that cleared every filter with real, finite data ever appear in the
 * final `symbols` / `perSymbolMeta`.
 *
 * BOUNDED STALE FALLBACK (mirrors resolveMoonshotMemeUniverse's exact discipline in
 * moonshot-lottery-cycle.ts): a 6h cache (in-memory, seeded from / persisted to disk so it survives a
 * process restart too — see below). On a failed refresh (network error, malformed response, or a
 * fresh resolution that lands on ZERO symbols passing every filter — treated the same as a fetch
 * failure, matching resolveMoonshotMemeUniverse's own "resolved to ZERO trading symbols — refusing to
 * scan" precedent) the LAST successful ("FRESH") resolution is re-served, explicitly RELABELED
 * `source: "STALE_FALLBACK"` — never silently reused under the "FRESH" label. Only when there is truly
 * no prior resolution at all AND the fresh attempt also fails does this throw.
 *
 * Persisted file: data/canonical-market-regime-universe.json, atomic tmp-write+rename (this store
 * gates real capital, unlike regime-engine-service.ts's plain writeFileSync, which is fine only
 * because that store is purely diagnostic). The disk backing means the stale-fallback survives a
 * process restart, not just an in-memory variable's lifetime — a universe gating real money must not
 * go cold just because the process happened to restart during a transient Binance outage.
 *
 * OUT OF SCOPE HERE (deliberately, per the approved design): the 48h staleness CEILING that forces
 * LOW_COVERAGE+MIXED belongs to the canonical engine (a later file in this rollout), not this module —
 * this module always answers "what's my best current guess" (fresh-or-stale-fallback) and exposes
 * `resolvedAtMs` honestly; deciding when that guess is too old to trust is the engine's job.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ─── constants ─────────────────────────────────────────────────────────────────

/** Bumps only on a JSON-shape change to the persisted snapshot. */
export const CANONICAL_MARKET_REGIME_UNIVERSE_SCHEMA_VERSION = 1;
/** Bumps independently, only when one of the 5 filter numbers below changes as a shipped DEFAULT — an
 *  env override does NOT bump this (it is a runtime tuning knob, not a new calibrated generation of
 *  defaults). Mirrors cortex-brain-store.ts's version/featureSchemaVersion split applied to this
 *  module's own two independently-changing things (file shape vs. filter calibration). */
export const CANONICAL_MARKET_REGIME_UNIVERSE_THRESHOLDS_VERSION = 1;

export const DEFAULT_CANONICAL_UNIVERSE_MIN_QUOTE_VOLUME_24H_USD = 3_000_000;
export const DEFAULT_CANONICAL_UNIVERSE_MAX_SPREAD_BPS = 25;
export const DEFAULT_CANONICAL_UNIVERSE_MIN_HISTORY_DAYS = 30;
export const DEFAULT_CANONICAL_UNIVERSE_MIN_OPEN_INTEREST_USD = 2_000_000;
export const DEFAULT_CANONICAL_UNIVERSE_MAX_SIZE = 60;

/** Hardcoded, NOT env-tunable — mirrors resolveMoonshotMemeUniverse's own hardcoded 12h cache exactly
 *  (this universe tracks listing/liquidity shifts more responsively than moonshot's meme list since it
 *  gates real execution eligibility, not a report-only scanner — half moonshot's window). */
export const CANONICAL_MARKET_REGIME_UNIVERSE_CACHE_TTL_MS = 6 * 3_600_000;

/** Purely a diagnostic floor (logged, never gates) — below this a FRESH resolution is still published
 *  (it is not zero) but a warning is logged so a degraded cycle is never silent. The engine's own
 *  coverage check (a later file) owns the actual eligibility decision. */
const MIN_SANITY_WARN_SIZE = 10;

const BINANCE_FUTURES_BASE_URL = "https://fapi.binance.com";
const FUTURES_EXCHANGE_INFO_URL = `${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`;
const FUTURES_TICKER_24H_URL = `${BINANCE_FUTURES_BASE_URL}/fapi/v1/ticker/24hr`;

// ─── types ─────────────────────────────────────────────────────────────────────

export type CanonicalUniverseDataQuality = "OK" | "MISSING";

export interface CanonicalMarketRegimeUniverseSymbolMeta {
  quoteVolume24hUsd: number | null;
  spreadBps: number | null;
  openInterestUsd: number | null;
  listedDaysAgo: number | null;
  dataQuality: CanonicalUniverseDataQuality;
}

export interface CanonicalMarketRegimeUniverseSnapshot {
  schemaVersion: 1;
  thresholdsVersion: number;
  resolvedAtMs: number;
  source: "FRESH" | "STALE_FALLBACK";
  symbols: string[];
  perSymbolMeta: Record<string, CanonicalMarketRegimeUniverseSymbolMeta>;
}

export interface CanonicalMarketRegimeUniverseThresholds {
  thresholdsVersion: number;
  minQuoteVolume24hUsd: number;
  maxSpreadBps: number;
  minHistoryDays: number;
  minOpenInterestUsd: number;
  maxUniverseSize: number;
}

/**
 * Structurally satisfied by a real BinanceClient instance (lib/binance.ts) with zero adapter code —
 * its getFuturesBookTicker/getFuturesOpenInterest already return a superset of these fields
 * (FuturesBookTickerSnapshot adds bidQty/askQty/time; the open-interest shape is an exact match).
 * Kept as a standalone interface — no import of the concrete class — for decoupling + testability,
 * mirroring MoonshotExtractionCtx's established shape in moonshot-lottery-cycle.ts.
 */
export interface CanonicalMarketRegimeUniverseFetchCtx {
  getFuturesBookTicker: (symbol: string) => Promise<{ bid: number | null; ask: number | null }>;
  getFuturesOpenInterest: (symbol: string) => Promise<{ openInterest: number | null }>;
}

type FetchJson = (url: string) => Promise<unknown>;

interface BinanceExchangeInfoSymbol {
  symbol: string;
  status: string;
  contractType?: string;
  quoteAsset?: string;
  onboardDate?: number;
}
interface BinanceExchangeInfoResponse {
  symbols?: BinanceExchangeInfoSymbol[];
}
interface BinanceFuturesTicker24h {
  symbol: string;
  quoteVolume?: string;
  lastPrice?: string;
}

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Numeric filter bars, individually env-overridable (matching this repo's MOONSHOT_ and RC/CE
 * leg-size convention of tunable numeric knobs) with safe fallback to the exact designed defaults.
 * `thresholdsVersion` itself is NEVER env-driven — see the constant's own doc above.
 */
export function resolveCanonicalMarketRegimeUniverseThresholds(
  env: NodeJS.ProcessEnv = process.env,
): CanonicalMarketRegimeUniverseThresholds {
  return {
    thresholdsVersion: CANONICAL_MARKET_REGIME_UNIVERSE_THRESHOLDS_VERSION,
    minQuoteVolume24hUsd: envNumber(
      env,
      "CANONICAL_UNIVERSE_MIN_QUOTE_VOLUME_24H_USD",
      DEFAULT_CANONICAL_UNIVERSE_MIN_QUOTE_VOLUME_24H_USD,
    ),
    maxSpreadBps: envNumber(env, "CANONICAL_UNIVERSE_MAX_SPREAD_BPS", DEFAULT_CANONICAL_UNIVERSE_MAX_SPREAD_BPS),
    minHistoryDays: envNumber(env, "CANONICAL_UNIVERSE_MIN_HISTORY_DAYS", DEFAULT_CANONICAL_UNIVERSE_MIN_HISTORY_DAYS),
    minOpenInterestUsd: envNumber(
      env,
      "CANONICAL_UNIVERSE_MIN_OPEN_INTEREST_USD",
      DEFAULT_CANONICAL_UNIVERSE_MIN_OPEN_INTEREST_USD,
    ),
    maxUniverseSize: Math.round(envNumber(env, "CANONICAL_UNIVERSE_MAX_SIZE", DEFAULT_CANONICAL_UNIVERSE_MAX_SIZE)),
  };
}

// ─── fresh resolution (pure-ish: two bulk fetches, then per-symbol fetches on survivors only) ──────

interface CandidateCore {
  symbol: string;
  quoteVolume24hUsd: number | null;
  lastPrice: number | null;
  listedDaysAgo: number | null;
}

function buildBaseFilteredCandidates(
  info: BinanceExchangeInfoResponse,
  tickers: BinanceFuturesTicker24h[],
  nowMs: number,
): CandidateCore[] {
  const tickerBySymbol = new Map<string, { quoteVolume24hUsd: number | null; lastPrice: number | null }>();
  for (const t of tickers) {
    if (!t || typeof t.symbol !== "string" || t.symbol.length === 0) continue;
    const qv = Number(t.quoteVolume);
    const lp = Number(t.lastPrice);
    tickerBySymbol.set(t.symbol, {
      quoteVolume24hUsd: Number.isFinite(qv) ? qv : null,
      lastPrice: Number.isFinite(lp) && lp > 0 ? lp : null,
    });
  }
  const out: CandidateCore[] = [];
  for (const s of info.symbols ?? []) {
    if (!s || s.status !== "TRADING" || s.contractType !== "PERPETUAL" || s.quoteAsset !== "USDT") continue;
    const listedDaysAgo =
      typeof s.onboardDate === "number" && Number.isFinite(s.onboardDate)
        ? (nowMs - s.onboardDate) / 86_400_000
        : null;
    const t = tickerBySymbol.get(s.symbol);
    out.push({
      symbol: s.symbol,
      quoteVolume24hUsd: t?.quoteVolume24hUsd ?? null,
      lastPrice: t?.lastPrice ?? null,
      listedDaysAgo,
    });
  }
  return out;
}

function passesCheapFilters(c: CandidateCore, thresholds: CanonicalMarketRegimeUniverseThresholds): boolean {
  return (
    c.quoteVolume24hUsd !== null &&
    c.quoteVolume24hUsd >= thresholds.minQuoteVolume24hUsd &&
    c.listedDaysAgo !== null &&
    c.listedDaysAgo >= thresholds.minHistoryDays
  );
}

interface ExpensiveMeta {
  spreadBps: number | null;
  openInterestUsd: number | null;
  dataQuality: CanonicalUniverseDataQuality;
}

/**
 * Never throws — any failure or non-finite value degrades to a MISSING data-quality verdict, which
 * the caller then excludes (fail-closed: missing data is never fabricated into a value that could
 * silently satisfy a >= / <= threshold it never actually cleared).
 */
async function fetchExpensiveMeta(
  candidate: CandidateCore,
  ctx: CanonicalMarketRegimeUniverseFetchCtx,
): Promise<ExpensiveMeta> {
  try {
    const [book, oi] = await Promise.all([
      ctx.getFuturesBookTicker(candidate.symbol),
      ctx.getFuturesOpenInterest(candidate.symbol),
    ]);
    const bid = book?.bid;
    const ask = book?.ask;
    const oiContracts = oi?.openInterest;
    if (
      typeof bid !== "number" ||
      !Number.isFinite(bid) ||
      bid <= 0 ||
      typeof ask !== "number" ||
      !Number.isFinite(ask) ||
      ask <= 0 ||
      typeof oiContracts !== "number" ||
      !Number.isFinite(oiContracts) ||
      oiContracts < 0 ||
      candidate.lastPrice === null
    ) {
      return { spreadBps: null, openInterestUsd: null, dataQuality: "MISSING" };
    }
    const mid = (bid + ask) / 2;
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : null;
    const openInterestUsd = oiContracts * candidate.lastPrice;
    if (spreadBps === null || !Number.isFinite(spreadBps) || !Number.isFinite(openInterestUsd)) {
      return { spreadBps: null, openInterestUsd: null, dataQuality: "MISSING" };
    }
    return { spreadBps, openInterestUsd, dataQuality: "OK" };
  } catch {
    return { spreadBps: null, openInterestUsd: null, dataQuality: "MISSING" };
  }
}

async function resolveFreshUniverseSnapshot(
  nowMs: number,
  fetchJson: FetchJson,
  ctx: CanonicalMarketRegimeUniverseFetchCtx,
  thresholds: CanonicalMarketRegimeUniverseThresholds,
): Promise<CanonicalMarketRegimeUniverseSnapshot> {
  const [infoRaw, tickersRaw] = await Promise.all([
    fetchJson(FUTURES_EXCHANGE_INFO_URL),
    fetchJson(FUTURES_TICKER_24H_URL),
  ]);
  const info = (infoRaw ?? {}) as BinanceExchangeInfoResponse;
  const tickers = Array.isArray(tickersRaw) ? (tickersRaw as BinanceFuturesTicker24h[]) : [];

  const baseFiltered = buildBaseFilteredCandidates(info, tickers, nowMs);
  const cheapPass = baseFiltered.filter((c) => passesCheapFilters(c, thresholds));

  const withExpensive = await Promise.all(
    cheapPass.map(async (candidate) => ({ candidate, meta: await fetchExpensiveMeta(candidate, ctx) })),
  );

  const survivors = withExpensive.filter(
    ({ meta }) =>
      meta.dataQuality === "OK" &&
      meta.spreadBps !== null &&
      meta.spreadBps <= thresholds.maxSpreadBps &&
      meta.openInterestUsd !== null &&
      meta.openInterestUsd >= thresholds.minOpenInterestUsd,
  );

  survivors.sort((a, b) => {
    const va = a.candidate.quoteVolume24hUsd ?? 0;
    const vb = b.candidate.quoteVolume24hUsd ?? 0;
    if (vb !== va) return vb - va;
    return a.candidate.symbol.localeCompare(b.candidate.symbol); // deterministic tie-break
  });

  const capped = survivors.slice(0, thresholds.maxUniverseSize);
  if (capped.length === 0) {
    // Mirrors resolveMoonshotMemeUniverse's own "resolved to ZERO trading symbols — refusing to
    // scan" precedent: a structurally-empty result is treated as a FAILURE (triggers the caller's
    // stale-fallback path below), never silently published as if it were a normal FRESH result.
    throw new Error(
      "canonical market regime universe resolved to ZERO symbols passing all filters — refusing to publish an empty universe",
    );
  }
  if (capped.length < MIN_SANITY_WARN_SIZE) {
    console.warn(
      `[canonical-market-regime-universe] only ${capped.length} symbol(s) passed every filter this cycle (cap ${thresholds.maxUniverseSize}) — market data may be degraded`,
    );
  }
  console.info(
    `[canonical-market-regime-universe] resolved ${capped.length} symbol(s): ${info.symbols?.length ?? 0} exchange symbols -> ${baseFiltered.length} base-filtered -> ${cheapPass.length} cheap-pass -> ${survivors.length} threshold-pass -> capped at ${thresholds.maxUniverseSize}`,
  );

  const perSymbolMeta: Record<string, CanonicalMarketRegimeUniverseSymbolMeta> = {};
  for (const { candidate, meta } of capped) {
    perSymbolMeta[candidate.symbol] = {
      quoteVolume24hUsd: candidate.quoteVolume24hUsd,
      spreadBps: meta.spreadBps,
      openInterestUsd: meta.openInterestUsd,
      listedDaysAgo: candidate.listedDaysAgo,
      dataQuality: "OK",
    };
  }

  return {
    schemaVersion: CANONICAL_MARKET_REGIME_UNIVERSE_SCHEMA_VERSION,
    thresholdsVersion: thresholds.thresholdsVersion,
    resolvedAtMs: nowMs,
    source: "FRESH",
    symbols: capped.map(({ candidate }) => candidate.symbol),
    perSymbolMeta,
  };
}

// ─── persisted store (atomic tmp+rename — this gates real capital, unlike regime-engine-service.ts's
//     plain writeFileSync, which is fine only because that store is purely diagnostic) ─────────────

function isValidPersistedSnapshot(value: unknown): value is CanonicalMarketRegimeUniverseSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== CANONICAL_MARKET_REGIME_UNIVERSE_SCHEMA_VERSION) return false;
  if (typeof v.thresholdsVersion !== "number" || !Number.isFinite(v.thresholdsVersion)) return false;
  if (typeof v.resolvedAtMs !== "number" || !Number.isFinite(v.resolvedAtMs)) return false;
  if (v.source !== "FRESH" && v.source !== "STALE_FALLBACK") return false;
  if (!Array.isArray(v.symbols) || !v.symbols.every((s) => typeof s === "string")) return false;
  if (!v.perSymbolMeta || typeof v.perSymbolMeta !== "object" || Array.isArray(v.perSymbolMeta)) return false;
  return true;
}

export class CanonicalMarketRegimeUniverseStore {
  private readonly file: string;
  private snapshot: CanonicalMarketRegimeUniverseSnapshot | null;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "canonical-market-regime-universe.json");
    this.snapshot = this.load();
  }

  private load(): CanonicalMarketRegimeUniverseSnapshot | null {
    for (const p of [this.file, `${this.file}.bak`]) {
      try {
        if (!existsSync(p)) continue;
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
        if (isValidPersistedSnapshot(parsed)) return parsed;
      } catch {
        /* corrupted -> try the backup, then fall through to cold start */
      }
    }
    return null;
  }

  get(): CanonicalMarketRegimeUniverseSnapshot | null {
    return this.snapshot;
  }

  save(snapshot: CanonicalMarketRegimeUniverseSnapshot): void {
    this.snapshot = snapshot;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
      if (existsSync(this.file)) {
        try {
          copyFileSync(this.file, `${this.file}.bak`);
        } catch {
          /* best-effort backup */
        }
      }
      renameSync(tmp, this.file);
    } catch {
      /* on-disk persistence is best-effort; the in-memory snapshot above is still updated so the
       *  current process keeps serving it even if the write itself failed (e.g. read-only disk). */
    }
  }
}

let storeSingleton: CanonicalMarketRegimeUniverseStore | null = null;
export function getCanonicalMarketRegimeUniverseStore(dataDir = "data"): CanonicalMarketRegimeUniverseStore {
  if (!storeSingleton) storeSingleton = new CanonicalMarketRegimeUniverseStore(dataDir);
  return storeSingleton;
}

let _memoryCache: CanonicalMarketRegimeUniverseSnapshot | null = null;

export function _resetCanonicalMarketRegimeUniverseForTests(): void {
  storeSingleton = null;
  _memoryCache = null;
}

// ─── public resolver: 6h cache (survives restart via the store above) -> fresh fetch -> stale fallback

export interface ResolveCanonicalMarketRegimeUniverseOpts {
  nowMs: number;
  /** Structurally satisfied by a real BinanceClient instance — see
   *  CanonicalMarketRegimeUniverseFetchCtx's own doc for why no adapter is needed. Required (no
   *  default), matching MoonshotExtractionCtx's own convention: this module never silently
   *  constructs a live network client of its own. */
  ctx: CanonicalMarketRegimeUniverseFetchCtx;
  fetchJson?: FetchJson;
  env?: NodeJS.ProcessEnv;
  /** Where the backing store lives; defaults to "data" like every other store in this repo. Only
   *  honored on the FIRST call in a process (the store is a singleton) — tests that need isolation
   *  should call _resetCanonicalMarketRegimeUniverseForTests() first, exactly like every other
   *  store-singleton test in this codebase (MoonshotStore, CortexBrainStore, NewCoinRadarStore, ...). */
  dataDir?: string;
}

/**
 * Resolves the current canonical-market-regime universe: serves the 6h in-memory/on-disk cache when
 * fresh enough, otherwise attempts a real refresh, and on failure falls back to the last successful
 * ("FRESH") resolution explicitly relabeled STALE_FALLBACK. Throws only when there is truly no prior
 * resolution (cold start, e.g. a brand-new deployment) AND the fresh attempt also fails.
 */
export async function resolveCanonicalMarketRegimeUniverse(
  opts: ResolveCanonicalMarketRegimeUniverseOpts,
): Promise<CanonicalMarketRegimeUniverseSnapshot> {
  const store = getCanonicalMarketRegimeUniverseStore(opts.dataDir ?? "data");
  if (!_memoryCache) _memoryCache = store.get(); // cold start: seed from disk before ever hitting the network
  if (_memoryCache && opts.nowMs - _memoryCache.resolvedAtMs < CANONICAL_MARKET_REGIME_UNIVERSE_CACHE_TTL_MS) {
    return _memoryCache;
  }

  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const thresholds = resolveCanonicalMarketRegimeUniverseThresholds(opts.env ?? process.env);

  try {
    const fresh = await resolveFreshUniverseSnapshot(opts.nowMs, fetchJson, opts.ctx, thresholds);
    _memoryCache = fresh;
    store.save(fresh);
    return fresh;
  } catch (error) {
    if (_memoryCache) {
      // stale-but-validated beats nothing — re-served, but NEVER silently under the "FRESH" label.
      const fallback: CanonicalMarketRegimeUniverseSnapshot = { ..._memoryCache, source: "STALE_FALLBACK" };
      _memoryCache = fallback;
      store.save(fallback);
      return fallback;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Price-impact efficiency (report-only, Tier 2 audit item #6).
 *
 * Metric: priceImpactEfficiency = absolutePriceMove / aggressiveNotional, computed SEPARATELY for
 * buy-side and sell-side taker flow. Interpretation: how much (fractional) price move a dollar of
 * aggressive volume bought on that side — a lower number means the book absorbed size without
 * moving price (deep/healthy liquidity on that side), a higher number means the same size moved
 * price further (thin/fragile liquidity on that side). This is the same shape as the standard
 * Amihud illiquidity ratio (|return| / dollar volume), just split by taker side instead of pooled.
 *
 * WINDOWING (exact choice, so this is reproducible): fixed, non-overlapping 5-MINUTE buckets
 * (PIE_INTERVAL/PIE_BUCKET_MS), one reading per symbol per bucket:
 *   - absolutePriceMove: |close - open| / open of the matching CLOSED 5m candle from
 *     BinanceClient.getCandles(symbol, "5m", ...) (real candle price data). Expressed as a
 *     FRACTIONAL return (dimensionless), not a raw price-unit delta — required so the metric is
 *     comparable across symbols at wildly different price scales (BTC vs a sub-cent meme coin),
 *     which matters because this module z-scores the reading BOTH against the symbol's own
 *     history and cross-sectionally against other symbols in its correlation cluster (item 4).
 *   - aggressiveNotional: sum(price * qty) of BinanceClient.getFuturesAggTrades() trades whose
 *     timestamp falls inside [bucketStartMs, bucketEndMs), split into buy-initiated vs
 *     sell-initiated using the exact isBuyerMaker convention already established by
 *     order-flow-microstructure.ts's computeTakerFlowFeatures (isBuyerMaker=true -> the taker was
 *     the SELLER -> sell-side notional; isBuyerMaker=false -> taker was the BUYER -> buy-side
 *     notional). This module does not import that function directly (it needs USD notional sums,
 *     not base-asset volume), but the semantics are identical and documented once here to avoid
 *     re-deriving them incorrectly.
 *   - Only CLOSED buckets are read: Binance's kline endpoint (no endTime given) can return the
 *     currently-forming bar as its last element; fetchCurrentPriceImpactReading only accepts a
 *     candle whose whole window has already elapsed (candle.openTime + PIE_BUCKET_MS <= now), so a
 *     reading is a stable, non-repainting fact about a finished bucket, not a moving target.
 *
 * Persistence: a rolling per-symbol history (PriceImpactHistoryStore), following this codebase's
 * established JSON store convention (see short-fade-edge.ts's ShortFadeStore) — atomic tmp+rename
 * writes, compact JSON, bounded retention (oldest readings pruned once a symbol's history exceeds
 * PIE_MAX_READINGS_PER_SYMBOL) so the file cannot grow unbounded.
 *
 * Z-scores (report-only enrichment, NOT wired into any gate/sizing/entry/exit in this task):
 *   - own-history z-score: the latest reading vs that SAME symbol's own prior readings (mean/stdev
 *     over the persisted window, excluding the current reading itself from the baseline).
 *   - cluster-relative z-score: the latest reading vs the LATEST reading of every OTHER symbol
 *     presently tracked in the same correlation-clusters.ts cluster (clusterOf) — a cross-sectional
 *     read, reusing the existing coarse taxonomy, no new correlation analysis.
 * Both fail OPEN (return z: null, never throw or return NaN/Infinity) whenever the sample size is
 * below the documented minimum, or the baseline has zero variance — this is the machinery that
 * would eventually replace decision-scoring.ts's hardcoded `fundingZScore: null`; wiring that in is
 * separate follow-up work (out of scope here, per instructions).
 *
 * Report exposure: GET /api/shadow/price-impact-efficiency-report (routes/shadow.ts), following the
 * same response-shape philosophy as the existing GET /api/shadow/crowding-report — an array of
 * per-symbol snapshots, live-fetched-then-persisted on each call (same "fetch fresh over the
 * scanner universe, return the array" pattern crowding-report already uses).
 *
 * Pure measurement / enrichment only: nothing here gates a live order or sizes a position.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candle } from "@dtc/shared";
import type { BinanceClient, FuturesAggTradeSnapshot } from "./binance.js";
import { clusterOf } from "./correlation-clusters.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ── windowing / tunables ─────────────────────────────────────────────────────
export const PIE_INTERVAL = process.env.PRICE_IMPACT_EFFICIENCY_INTERVAL || "5m";
export const PIE_BUCKET_MS = envNum("PRICE_IMPACT_EFFICIENCY_BUCKET_MS", 5 * 60_000);
/** How many candles to fetch to find the latest CLOSED bucket (>=2 so a forming last bar still
 *  leaves a usable closed one behind it). */
export const PIE_CANDLES_FETCH_LIMIT = envNum("PRICE_IMPACT_EFFICIENCY_CANDLES_LIMIT", 3);
export const PIE_AGGTRADES_LIMIT = envNum("PRICE_IMPACT_EFFICIENCY_AGGTRADES_LIMIT", 1000);
/** Bounded retention per symbol — at 5m buckets this is ~41.6 hours of history; enough to build a
 *  meaningful mean/stdev baseline without the store file growing unbounded. */
export const PIE_MAX_READINGS_PER_SYMBOL = envNum("PRICE_IMPACT_EFFICIENCY_MAX_HISTORY", 500);
/** Minimum PRIOR readings (excluding the current one) required before trusting an own-history
 *  z-score; below this, fail open (null) rather than compute a noisy statistic off 1-2 points. */
export const PIE_MIN_OWN_HISTORY_SAMPLES = envNum("PRICE_IMPACT_EFFICIENCY_MIN_OWN_SAMPLES", 8);
/** Minimum OTHER symbols in the same cluster with a fresh reading required before trusting a
 *  cross-sectional cluster z-score. */
export const PIE_MIN_CLUSTER_PEER_SAMPLES = envNum("PRICE_IMPACT_EFFICIENCY_MIN_CLUSTER_SAMPLES", 3);

// ── pure feature computation ─────────────────────────────────────────────────

export interface AggressiveNotionalBySide {
  buyNotionalUsd: number;
  sellNotionalUsd: number;
}

/**
 * Sum aggressive (taker) notional in USD, split by side, over an already time-windowed trade list
 * (same "caller does the windowing" convention as computeTakerFlowFeatures). Same isBuyerMaker
 * convention as order-flow-microstructure.ts: isBuyerMaker=true -> taker was the SELLER -> sell
 * side; isBuyerMaker=false -> taker was the BUYER -> buy side.
 */
export function computeAggressiveNotionalBySide(
  trades: readonly FuturesAggTradeSnapshot[],
): AggressiveNotionalBySide {
  let buyNotionalUsd = 0;
  let sellNotionalUsd = 0;
  for (const t of trades) {
    if (!finite(t.price) || !finite(t.quantity) || !(t.price > 0) || !(t.quantity > 0)) continue;
    const notional = t.price * t.quantity;
    if (t.isBuyerMaker) sellNotionalUsd += notional;
    else buyNotionalUsd += notional;
  }
  return { buyNotionalUsd, sellNotionalUsd };
}

export interface PriceImpactReading {
  symbol: string;
  /** = the covering candle's openTime. */
  bucketStartMs: number;
  bucketEndMs: number;
  capturedAt: string;
  /** |close - open| / open of the bucket's candle — a fractional return, not a raw price delta. */
  absolutePriceMove: number;
  buyAggressiveNotionalUsd: number;
  sellAggressiveNotionalUsd: number;
  /** absolutePriceMove / buyAggressiveNotionalUsd. null when there was no buy-side taker volume. */
  buyPriceImpactEfficiency: number | null;
  /** absolutePriceMove / sellAggressiveNotionalUsd. null when there was no sell-side taker volume. */
  sellPriceImpactEfficiency: number | null;
}

/**
 * Compose one bucket reading from an already-fetched CLOSED candle + already-time-windowed trades
 * (pure — mirrors buildMicrostructureSnapshot's "caller does the REST calls" discipline).
 */
export function computePriceImpactBucket(opts: {
  symbol: string;
  /** The CLOSED candle covering this bucket; candle.openTime is used as bucketStartMs. */
  candle: Candle;
  /** Trades already filtered to [bucketStartMs, bucketEndMs). */
  trades: readonly FuturesAggTradeSnapshot[];
  capturedAtMs: number;
  bucketMs?: number;
}): PriceImpactReading {
  const bucketMs = opts.bucketMs ?? PIE_BUCKET_MS;
  const bucketStartMs = opts.candle.openTime;
  const bucketEndMs = bucketStartMs + bucketMs;
  const { open, close } = opts.candle;
  const absolutePriceMove = finite(open) && finite(close) && open > 0 ? Math.abs(close - open) / open : 0;
  const { buyNotionalUsd, sellNotionalUsd } = computeAggressiveNotionalBySide(opts.trades);
  return {
    symbol: opts.symbol,
    bucketStartMs,
    bucketEndMs,
    capturedAt: new Date(opts.capturedAtMs).toISOString(),
    absolutePriceMove,
    buyAggressiveNotionalUsd: buyNotionalUsd,
    sellAggressiveNotionalUsd: sellNotionalUsd,
    buyPriceImpactEfficiency: buyNotionalUsd > 0 ? absolutePriceMove / buyNotionalUsd : null,
    sellPriceImpactEfficiency: sellNotionalUsd > 0 ? absolutePriceMove / sellNotionalUsd : null,
  };
}

/**
 * Fetch + compute the latest CLOSED bucket reading for a symbol from the real Binance client
 * (getCandles for price, getFuturesAggTrades for aggressive notional — the same aggTrades source
 * computeTakerFlowFeatures already uses). Returns null if no bucket has fully closed yet within
 * the fetched candle window (never throws itself; the caller — runPriceImpactEfficiencyCycle —
 * decides how to handle a thrown Binance error per symbol).
 */
export async function fetchCurrentPriceImpactReading(
  client: Pick<BinanceClient, "getCandles" | "getFuturesAggTrades">,
  symbol: string,
  nowMs: number,
): Promise<PriceImpactReading | null> {
  const candles = await client.getCandles(symbol, PIE_INTERVAL, PIE_CANDLES_FETCH_LIMIT);
  if (!Array.isArray(candles) || candles.length === 0) return null;
  // The last entry of a kline query with no endTime can be the currently-forming bar — only bars
  // whose full window has elapsed are safe to treat as a stable, non-repainting reading.
  const closed = candles
    .filter((c) => finite(c.openTime) && c.openTime + PIE_BUCKET_MS <= nowMs)
    .sort((a, b) => a.openTime - b.openTime);
  const candle = closed[closed.length - 1];
  if (!candle) return null;

  const bucketStartMs = candle.openTime;
  const bucketEndMs = bucketStartMs + PIE_BUCKET_MS;
  const trades = await client.getFuturesAggTrades(symbol, {
    startTime: bucketStartMs,
    endTime: bucketEndMs,
    limit: PIE_AGGTRADES_LIMIT,
  });
  // Defensive re-filter: never assume the upstream response respected the requested window exactly.
  const windowed = (trades ?? []).filter((t) => finite(t.timestamp) && t.timestamp >= bucketStartMs && t.timestamp < bucketEndMs);
  return computePriceImpactBucket({ symbol, candle, trades: windowed, capturedAtMs: nowMs });
}

// ── store (rolling per-symbol history) ───────────────────────────────────────

interface PieState {
  version: number;
  readingsBySymbol: Record<string, PriceImpactReading[]>;
}

const EMPTY_STATE: PieState = { version: 1, readingsBySymbol: {} };

/** Atomic tmp+rename write, compact JSON, bounded per-symbol retention — same persistence
 *  convention as short-fade-edge.ts's ShortFadeStore. */
export class PriceImpactHistoryStore {
  private state: PieState = { ...EMPTY_STATE, readingsBySymbol: {} };

  constructor(
    private readonly file: string,
    private readonly maxPerSymbol: number = PIE_MAX_READINGS_PER_SYMBOL,
  ) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<PieState>;
        if (parsed.readingsBySymbol && typeof parsed.readingsBySymbol === "object") {
          this.state.readingsBySymbol = parsed.readingsBySymbol as Record<string, PriceImpactReading[]>;
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }

  get path(): string {
    return this.file;
  }

  /** All symbols currently tracked (insertion order not guaranteed). */
  allSymbols(): string[] {
    return Object.keys(this.state.readingsBySymbol);
  }

  /** Ascending by bucketStartMs. Empty array if the symbol has never been recorded. */
  historyFor(symbol: string): readonly PriceImpactReading[] {
    return this.state.readingsBySymbol[symbol] ?? [];
  }

  /**
   * Record a new bucket reading. Idempotent per (symbol, bucketStartMs) — recording the same
   * bucket twice (e.g. two report requests inside the same 5m window) is a no-op and returns
   * false. Prunes the OLDEST readings once the symbol's history exceeds maxPerSymbol so the store
   * cannot grow unbounded.
   */
  record(reading: PriceImpactReading): boolean {
    const list = this.state.readingsBySymbol[reading.symbol] ?? [];
    if (list.some((r) => r.bucketStartMs === reading.bucketStartMs)) return false;
    list.push(reading);
    list.sort((a, b) => a.bucketStartMs - b.bucketStartMs);
    while (list.length > this.maxPerSymbol) list.shift();
    this.state.readingsBySymbol[reading.symbol] = list;
    return true;
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file);
  }
}

let singleton: PriceImpactHistoryStore | null = null;
export function getPriceImpactEfficiencyStore(dataDir = "data"): PriceImpactHistoryStore {
  if (!singleton) singleton = new PriceImpactHistoryStore(resolve(dataDir, "price-impact-efficiency.json"));
  return singleton;
}

export function _resetPriceImpactEfficiencyStoreForTests(): void {
  singleton = null;
}

// ── cycle (fetch + persist across a universe) ────────────────────────────────

export interface PieCycleResult {
  scanned: number;
  recorded: number;
  /** No new reading (no closed bucket yet, or this bucket was already recorded). */
  skipped: number;
  /** The Binance fetch/compute threw for this symbol; previous history for it is left untouched. */
  failed: number;
}

/**
 * Best-effort PER SYMBOL: one symbol's fetch failure never blocks the others (same discipline as
 * refreshSymbolVolatilityCache in directional-symbol-sizing.ts). Persists via store.save() once at
 * the end.
 */
export async function runPriceImpactEfficiencyCycle(opts: {
  store: PriceImpactHistoryStore;
  client: Pick<BinanceClient, "getCandles" | "getFuturesAggTrades">;
  symbols: readonly string[];
  nowMs: number;
}): Promise<PieCycleResult> {
  const result: PieCycleResult = { scanned: 0, recorded: 0, skipped: 0, failed: 0 };
  for (const symbol of opts.symbols) {
    result.scanned += 1;
    try {
      const reading = await fetchCurrentPriceImpactReading(opts.client, symbol, opts.nowMs);
      if (!reading) {
        result.skipped += 1;
        continue;
      }
      const added = opts.store.record(reading);
      if (added) result.recorded += 1;
      else result.skipped += 1;
    } catch {
      result.failed += 1;
    }
  }
  opts.store.save();
  return result;
}

/** Never throws — a failure anywhere (including store.save()) returns null instead of propagating
 *  into the caller (the report route). */
export async function runPriceImpactEfficiencyCycleGuarded(
  opts: Parameters<typeof runPriceImpactEfficiencyCycle>[0],
): Promise<PieCycleResult | null> {
  try {
    return await runPriceImpactEfficiencyCycle(opts);
  } catch {
    return null;
  }
}

// ── z-scores ──────────────────────────────────────────────────────────────────

export interface ZScoreResult {
  z: number | null;
  mean: number | null;
  stdev: number | null;
  n: number;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Sample standard deviation (n-1), matching walk-forward-validation.ts's stdDev convention. */
function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

const NULL_Z: ZScoreResult = { z: null, mean: null, stdev: null, n: 0 };

/**
 * Fail-open z-score: returns z: null (never throws, never NaN/Infinity) whenever `current` is
 * missing, the baseline has fewer than `minSamples` finite points, or the baseline has zero
 * variance (a degenerate "z-score" against a constant baseline is not meaningful).
 */
export function computeZScore(current: number | null, history: readonly number[], minSamples: number): ZScoreResult {
  const finiteHistory = history.filter(finite);
  const n = finiteHistory.length;
  const m = mean(finiteHistory);
  const sd = stdDev(finiteHistory);
  if (current === null || !finite(current) || n < minSamples || sd === null || sd === 0) {
    return { z: null, mean: m, stdev: sd, n };
  }
  return { z: (current - m!) / sd, mean: m, stdev: sd, n };
}

export interface OwnHistoryZScores {
  current: PriceImpactReading | null;
  buy: ZScoreResult;
  sell: ZScoreResult;
}

/**
 * Z-score the LATEST reading in `history` against that SAME symbol's own PRIOR readings (the
 * current reading is excluded from its own baseline). This is the machinery that would eventually
 * back decision-scoring.ts's `fundingZScore` field (currently hardcoded null everywhere it's used).
 */
export function computeOwnHistoryZScores(
  history: readonly PriceImpactReading[],
  minSamples: number = PIE_MIN_OWN_HISTORY_SAMPLES,
): OwnHistoryZScores {
  if (history.length === 0) return { current: null, buy: NULL_Z, sell: NULL_Z };
  const sorted = [...history].sort((a, b) => a.bucketStartMs - b.bucketStartMs);
  const current = sorted[sorted.length - 1]!;
  const prior = sorted.slice(0, -1);
  const buyHistory = prior.map((r) => r.buyPriceImpactEfficiency).filter(finite);
  const sellHistory = prior.map((r) => r.sellPriceImpactEfficiency).filter(finite);
  return {
    current,
    buy: computeZScore(current.buyPriceImpactEfficiency, buyHistory, minSamples),
    sell: computeZScore(current.sellPriceImpactEfficiency, sellHistory, minSamples),
  };
}

export interface ClusterRelativeZScores {
  cluster: string;
  buy: ZScoreResult;
  sell: ZScoreResult;
}

/**
 * Z-score `currentReading` against the LATEST reading of every OTHER symbol (self excluded, same
 * "peer" convention as directional-symbol-sizing.ts's peerAtrPcts) presently tracked in the same
 * correlation-clusters.ts cluster. Purely reuses clusterOf's existing coarse taxonomy — no new
 * correlation analysis.
 */
export function computeClusterRelativeZScores(
  symbol: string,
  currentReading: PriceImpactReading | null,
  latestBySymbol: ReadonlyMap<string, PriceImpactReading>,
  env: NodeJS.ProcessEnv = process.env,
  minSamples: number = PIE_MIN_CLUSTER_PEER_SAMPLES,
): ClusterRelativeZScores {
  const cluster = clusterOf(symbol, env);
  const buyPeers: number[] = [];
  const sellPeers: number[] = [];
  for (const [peerSymbol, reading] of latestBySymbol) {
    if (peerSymbol === symbol) continue;
    if (clusterOf(peerSymbol, env) !== cluster) continue;
    if (finite(reading.buyPriceImpactEfficiency)) buyPeers.push(reading.buyPriceImpactEfficiency);
    if (finite(reading.sellPriceImpactEfficiency)) sellPeers.push(reading.sellPriceImpactEfficiency);
  }
  return {
    cluster,
    buy: computeZScore(currentReading?.buyPriceImpactEfficiency ?? null, buyPeers, minSamples),
    sell: computeZScore(currentReading?.sellPriceImpactEfficiency ?? null, sellPeers, minSamples),
  };
}

// ── report ────────────────────────────────────────────────────────────────────

export interface PriceImpactEfficiencySnapshot {
  symbol: string;
  cluster: string;
  capturedAt: string;
  bucketStartMs: number;
  bucketEndMs: number;
  absolutePriceMove: number;
  buyAggressiveNotionalUsd: number;
  sellAggressiveNotionalUsd: number;
  buyPriceImpactEfficiency: number | null;
  sellPriceImpactEfficiency: number | null;
  ownHistoryZScore: { buy: number | null; sell: number | null; sampleSize: number };
  clusterRelativeZScore: { buy: number | null; sell: number | null; peerCount: number };
}

export interface PriceImpactEfficiencyReport {
  reportOnly: true;
  generatedAt: string;
  count: number;
  snapshots: PriceImpactEfficiencySnapshot[];
}

/** Builds the current snapshot + both z-scores for every symbol presently tracked in the store. */
export function buildPriceImpactEfficiencyReport(
  store: PriceImpactHistoryStore,
  opts: { nowIso?: string; env?: NodeJS.ProcessEnv } = {},
): PriceImpactEfficiencyReport {
  const symbols = store.allSymbols();
  const latestBySymbol = new Map<string, PriceImpactReading>();
  for (const symbol of symbols) {
    const history = store.historyFor(symbol);
    const last = history[history.length - 1];
    if (last) latestBySymbol.set(symbol, last);
  }

  const snapshots: PriceImpactEfficiencySnapshot[] = [];
  for (const symbol of symbols) {
    const history = store.historyFor(symbol);
    if (history.length === 0) continue;
    const own = computeOwnHistoryZScores(history);
    if (!own.current) continue;
    const clusterZ = computeClusterRelativeZScores(symbol, own.current, latestBySymbol, opts.env);
    snapshots.push({
      symbol,
      cluster: clusterZ.cluster,
      capturedAt: own.current.capturedAt,
      bucketStartMs: own.current.bucketStartMs,
      bucketEndMs: own.current.bucketEndMs,
      absolutePriceMove: own.current.absolutePriceMove,
      buyAggressiveNotionalUsd: own.current.buyAggressiveNotionalUsd,
      sellAggressiveNotionalUsd: own.current.sellAggressiveNotionalUsd,
      buyPriceImpactEfficiency: own.current.buyPriceImpactEfficiency,
      sellPriceImpactEfficiency: own.current.sellPriceImpactEfficiency,
      ownHistoryZScore: { buy: own.buy.z, sell: own.sell.z, sampleSize: Math.max(own.buy.n, own.sell.n) },
      clusterRelativeZScore: { buy: clusterZ.buy.z, sell: clusterZ.sell.z, peerCount: Math.max(clusterZ.buy.n, clusterZ.sell.n) },
    });
  }
  snapshots.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    reportOnly: true,
    generatedAt: opts.nowIso ?? new Date().toISOString(),
    count: snapshots.length,
    snapshots,
  };
}

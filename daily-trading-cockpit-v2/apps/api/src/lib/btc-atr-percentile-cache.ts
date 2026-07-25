/**
 * Real, causal, 0-100-scale BTC ATR-percentile producer for the four-brain shadow layer's Market
 * State classifier (see market-state-brain.ts's `volatility` input / VOL_BANDS thresholds, and
 * four-brain-live-gather-bindings.ts's `btcAtrPercentile: number | null` contract, which divides
 * this value by 100 itself — this module must return a genuine 0-100 percentile RANK, not a 0-1
 * ATR/price fraction).
 *
 * Replaces the permanent `btcAtrPercentile: null` stub in app.ts's buildFourBrainDeps that kept
 * Market State family stuck at UNKNOWN (market-state-brain.ts: `t === null || vol === null`).
 *
 * Reuses the exact battle-tested ATR + percentile math already in candle-indicators.ts
 * (computeATR + computeATRPercentile) via the same recipe already proven in
 * replay-tier-a-core.ts (atr14 → atr/close ratio → 168-bar [7d @ 1h] rolling percentile) — no ATR
 * math is reinvented here.
 *
 * Two pieces:
 *  1. `computeBtcAtrPercentile` — a pure function (Candle[] in, 0-100 percentile out), so it is
 *     unit-testable without any network/cache involvement, and its causality is directly provable
 *     (see its own doc comment).
 *  2. `BtcAtrPercentileCacheStore` — a small in-memory cache holding the latest {percentile, atMs},
 *     refreshed on an interval from app.ts (buildFourBrainDeps is a SYNCHRONOUS function and cannot
 *     await a candle fetch inline — see four-brain-shadow-tick.ts's sync gather), read
 *     synchronously at gather time.
 *
 * Design note — in-memory only, unlike SymbolVolatilityCacheStore's disk-backed cache
 * (directional-symbol-sizing.ts): this is a single scalar derived from one symbol's public
 * candles, recomputed from scratch every refresh cycle at near-zero cost. Nothing here is
 * expensive enough to need surviving a process restart, and the app.ts wiring fires an immediate
 * near-boot warm-up call, so the value repopulates within seconds rather than sitting null for a
 * full refresh interval. Losing it across a restart costs at most a few four-brain ticks with
 * MISSING volatility — fail-open, the exact same behavior market-state-brain.ts already has today
 * for every tick so far.
 */

import type { Candle } from "@dtc/shared";
import { computeATR, computeATRPercentile } from "./candle-indicators.js";

/** 7d @ 1h bars — identical to replay-tier-a-core.ts's GAP_LOOKBACK_BARS, the same ATR-percentile
 *  recipe, kept in sync deliberately so this live producer and the offline Tier-A reconstruction
 *  agree on what "the current volatility regime" means. */
export const BTC_ATR_PERCENTILE_WINDOW_BARS = 168;
const ATR_PERIOD = 14;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Pure: BTC's CURRENT (last-index) ATR-percentile (0-100), from a causal rolling window over the
 * given 1h candles. Returns null if there are not enough candles for a full window (ATR warmup +
 * the 168-bar percentile window) or the latest reading is non-finite — never fabricates a number.
 *
 * Causal by construction: computeATR and computeATRPercentile are both strictly trailing (the
 * value at index i is derived only from candles/values at indices <= i), so the returned value —
 * always read off the LAST candle — never depends on any candle after it. The regression test
 * proves this directly: truncating the input to a shorter prefix must reproduce the same result
 * for that prefix's own last index.
 */
export function computeBtcAtrPercentile(candles: Candle[]): number | null {
  if (candles.length < ATR_PERIOD + BTC_ATR_PERCENTILE_WINDOW_BARS) return null;
  const closes = candles.map((c) => c.close);
  const atr = computeATR(candles, ATR_PERIOD);
  const atrPct = atr.map((a, i) => (finite(a) && closes[i]! > 0 ? a / closes[i]! : null));
  const pctile = computeATRPercentile(atrPct, BTC_ATR_PERCENTILE_WINDOW_BARS);
  const last = pctile[pctile.length - 1];
  return finite(last) ? last : null;
}

export interface BtcAtrPercentileCacheState {
  percentile: number | null;
  atMs: number | null;
  lastError: string | null;
}

const EMPTY_STATE: BtcAtrPercentileCacheState = { percentile: null, atMs: null, lastError: null };

/** In-memory-only cache — see module doc-comment design note for why no disk persistence. */
export class BtcAtrPercentileCacheStore {
  private state: BtcAtrPercentileCacheState = { ...EMPTY_STATE };

  get(): BtcAtrPercentileCacheState {
    return this.state;
  }

  set(percentile: number, atMs: number): void {
    this.state = { percentile, atMs, lastError: null };
  }

  /** Fail-open: keeps the last GOOD percentile/atMs (if any) — only records the error string for
   *  observability. A persistently-failing refresh must not fabricate a number, but a single
   *  transient hiccup must not blank out a value that was genuinely fresh moments ago either. */
  setError(message: string): void {
    this.state = { ...this.state, lastError: message };
  }
}

let singleton: BtcAtrPercentileCacheStore | null = null;
export function getBtcAtrPercentileCacheStore(): BtcAtrPercentileCacheStore {
  if (!singleton) singleton = new BtcAtrPercentileCacheStore();
  return singleton;
}

export function _resetBtcAtrPercentileCacheStoreForTests(): void {
  singleton = null;
}

export type BtcCandleFetcher = (symbol: string, interval: string, limit: number) => Promise<Candle[]>;

export const BTC_ATR_PERCENTILE_SYMBOL = "BTCUSDT";
export const BTC_ATR_PERCENTILE_INTERVAL = "1h";
// ATR warmup (14) + 168-bar percentile window + margin — mirrors the 200-candle convention already
// used for this exact symbol/interval at regime-engine-service.ts:140.
export const BTC_ATR_PERCENTILE_CANDLES_NEEDED = 200;
// Bucket width for BTC_ATR_PERCENTILE_INTERVAL ("1h") — used to exclude the still-forming current
// bar (see refreshBtcAtrPercentileCache doc comment below).
const BTC_ATR_PERCENTILE_INTERVAL_MS = 60 * 60_000;

/**
 * Refreshes the BTC ATR-percentile cache. Never throws — a fetch/compute failure leaves the
 * store's previous value untouched (fail-open, the same convention as
 * refreshSymbolVolatilityCache in directional-symbol-sizing.ts) and only records the error string
 * for observability.
 *
 * Excludes the still-forming current-hour candle before computing: a klines query with no endTime
 * can return an in-progress bar as its last element (the same Binance-API behavior
 * fetchCurrentPriceImpactReading in price-impact-efficiency.ts already guards against), and
 * computeBtcAtrPercentile always reads its result off the LAST candle in the array. Without this
 * filter, the cached percentile would repaint/jitter throughout the open hour and get journaled as
 * if it were a stable, settled reading.
 */
export async function refreshBtcAtrPercentileCache(
  store: BtcAtrPercentileCacheStore,
  fetchCandles: BtcCandleFetcher,
  opts: { now?: () => number } = {},
): Promise<{ ok: boolean; percentile: number | null }> {
  const now = opts.now ?? (() => Date.now());
  try {
    const candles = await fetchCandles(BTC_ATR_PERCENTILE_SYMBOL, BTC_ATR_PERCENTILE_INTERVAL, BTC_ATR_PERCENTILE_CANDLES_NEEDED);
    if (!Array.isArray(candles) || candles.length === 0) {
      store.setError("empty candle series");
      return { ok: false, percentile: store.get().percentile };
    }
    const nowMs = now();
    const closed = candles
      .filter((c) => finite(c.openTime) && c.openTime + BTC_ATR_PERCENTILE_INTERVAL_MS <= nowMs)
      .sort((a, b) => a.openTime - b.openTime);
    if (closed.length === 0) {
      store.setError("no fully-closed candle available yet");
      return { ok: false, percentile: store.get().percentile };
    }
    const percentile = computeBtcAtrPercentile(closed);
    if (percentile === null) {
      store.setError("insufficient candles for a full ATR-percentile window");
      return { ok: false, percentile: store.get().percentile };
    }
    store.set(percentile, nowMs);
    return { ok: true, percentile };
  } catch (err) {
    store.setError(err instanceof Error ? err.message : String(err));
    return { ok: false, percentile: store.get().percentile };
  }
}

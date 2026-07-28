/**
 * KRONOS BTC ANCHOR (2026-07-28) — a market-anchor reading that does not have to qualify first.
 *
 * `kronosAgree` read MISSING on 100% of Direction decisions on both instances, and the data was
 * never absent. `kronosAgreeFromScan` looks for BTCUSDT inside the scan's `top10`, and `top10` is an
 * OPPORTUNITY RANKING — ordered by how tradeable a symbol looks right now, so it fills with movers.
 * Measured that day it held SEI, SUI, WLD, NEAR, BNB and SOL, every one carrying a usable Kronos
 * bias, and no BTC. BTC is the calmest large-cap in the universe; it almost never earns a slot.
 *
 * BTC is used as the market ANCHOR here. An anchor must not have to be an opportunity first. So it
 * gets its own producer, on the pattern btc-atr-percentile-cache.ts already established for the same
 * symbol: refreshed on its own low-frequency interval, read synchronously by the gather, never
 * fabricated — null until the first refresh lands, and null again after a persistent failure.
 *
 * WHY NOT PER-TICK. kronos.ts serialises inference through one global concurrency slot, chosen
 * deliberately after the model server was measured. A per-tick consumer would contend with the
 * scanner for that slot every five minutes, which is exactly why the original reader took the value
 * from the scan instead of calling predict(). This runs on a 15-minute interval, so it costs one
 * inference per interval, and the scan reading still wins whenever BTC does appear there — free,
 * already in memory, and freshest.
 *
 * The cached `atMs` is the PRODUCER's clock, not the reader's, so classifySource can age it honestly
 * rather than the reading looking permanently fresh.
 */
import type { Candle, KronosPrediction } from "@dtc/shared";

import { kronosAgreeFromPrediction, type KronosAgreeReading } from "./kronos-agree-reading.js";

export const KRONOS_BTC_ANCHOR_SYMBOL = "BTCUSDT";
/** Matches the timeframe the scanner already asks Kronos for, so the anchor and the scan reading are
 *  the same question asked of the same model — not two different opinions that could disagree. */
export const KRONOS_BTC_ANCHOR_INTERVAL = "1h";
/** The 200-candle convention already used for this symbol/interval (regime-engine-service.ts:140,
 *  btc-atr-percentile-cache.ts). Kronos needs enough context; 200 is what every other caller sends. */
export const KRONOS_BTC_ANCHOR_CANDLES = 200;

export interface KronosBtcAnchorState {
  /** −1..1, or null when Kronos had no usable opinion (or nothing has been fetched yet). NEVER 0. */
  agree: number | null;
  /** When the prediction was produced. null exactly when `agree` is null. */
  atMs: number | null;
  /** Diagnostics — why the last refresh produced nothing. null after a refresh that yielded a value. */
  lastSkipReason: string | null;
}

const EMPTY: KronosBtcAnchorState = { agree: null, atMs: null, lastSkipReason: null };

export class KronosBtcAnchorCache {
  private state: KronosBtcAnchorState = { ...EMPTY };

  get(): KronosBtcAnchorState {
    return { ...this.state };
  }

  set(reading: KronosAgreeReading, skipReason: string | null): void {
    this.state = { agree: reading.agree, atMs: reading.atMs, lastSkipReason: reading.agree === null ? skipReason : null };
  }

  /** A failed refresh must NOT wipe a previously good reading — it ages out through atMs instead.
   *  Blanking it would turn a transient fetch error into a permanent MISSING for the whole interval. */
  noteFailure(reason: string): void {
    this.state = { ...this.state, lastSkipReason: reason };
  }
}

let singleton: KronosBtcAnchorCache | null = null;
export function getKronosBtcAnchorCache(): KronosBtcAnchorCache {
  if (!singleton) singleton = new KronosBtcAnchorCache();
  return singleton;
}
export function _resetKronosBtcAnchorCacheForTests(): void {
  singleton = null;
}

export type AnchorCandleFetcher = (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
export type AnchorPredictor = (symbol: string, timeframe: string, candles: Candle[]) => Promise<KronosPrediction>;

/**
 * One refresh. Never throws — a producer that can break the interval that calls it is a producer that
 * takes the instance down with it.
 */
export async function refreshKronosBtcAnchor(
  cache: KronosBtcAnchorCache,
  fetchCandles: AnchorCandleFetcher,
  predict: AnchorPredictor,
  nowMs: number,
): Promise<void> {
  let candles: Candle[];
  try {
    candles = await fetchCandles(KRONOS_BTC_ANCHOR_SYMBOL, KRONOS_BTC_ANCHOR_INTERVAL, KRONOS_BTC_ANCHOR_CANDLES);
  } catch (err) {
    cache.noteFailure(`candle fetch failed: ${(err as Error).message}`);
    return;
  }
  if (!Array.isArray(candles) || candles.length === 0) {
    cache.noteFailure("candle fetch returned nothing");
    return;
  }
  let prediction: KronosPrediction;
  try {
    prediction = await predict(KRONOS_BTC_ANCHOR_SYMBOL, KRONOS_BTC_ANCHOR_INTERVAL, candles);
  } catch (err) {
    cache.noteFailure(`predict failed: ${(err as Error).message}`);
    return;
  }
  // The producer's own clock — this reading is as old as the inference, not as old as the read.
  cache.set(kronosAgreeFromPrediction(prediction, nowMs), prediction.reason ?? "kronos returned no usable bias");
}

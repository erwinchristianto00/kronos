/** Lightweight BTC anchor cache for a serialized forecast challenger. */
import type { Candle } from "@dtc/shared";

import {
  challengerAgree,
  type ForecastChallengerPrediction,
} from "./forecast-challenger.js";

export interface ForecastChallengerAnchorState {
  agree: number | null;
  atMs: number | null;
  /** Last successful model response, even when it returned a neutral opinion. */
  lastSuccessAtMs: number | null;
  /** Last failed/invalid refresh. A failure always withdraws the current opinion. */
  lastFailureAtMs: number | null;
  /** Sidecar timestamp for the currently usable prediction. */
  predictionGeneratedAtMs: number | null;
  /** Why the cache deliberately has no current opinion. */
  stalenessReason: string | null;
  lastSkipReason: string | null;
}

const EMPTY: ForecastChallengerAnchorState = {
  agree: null,
  atMs: null,
  lastSuccessAtMs: null,
  lastFailureAtMs: null,
  predictionGeneratedAtMs: null,
  stalenessReason: null,
  lastSkipReason: null,
};

export class ForecastChallengerBtcAnchorCache {
  private state: ForecastChallengerAnchorState = { ...EMPTY };

  get(): ForecastChallengerAnchorState {
    return { ...this.state };
  }

  set(prediction: ForecastChallengerPrediction): void {
    const agree = challengerAgree(prediction);
    const nowMs = Date.now();
    this.state = {
      agree,
      atMs: agree === null ? null : prediction.generatedAtMs,
      lastSuccessAtMs: nowMs,
      lastFailureAtMs: null,
      predictionGeneratedAtMs: prediction.generatedAtMs,
      stalenessReason: agree === null ? prediction.reason ?? "model returned no directional opinion" : null,
      lastSkipReason: agree === null ? prediction.reason ?? "model returned no directional opinion" : null,
    };
  }

  noteFailure(reason: string): void {
    // Direction Brain must never reuse a previous forecast after a failed or
    // invalid refresh. A stale model is absence of evidence, not a weak vote.
    this.state = {
      ...this.state,
      agree: null,
      atMs: null,
      predictionGeneratedAtMs: null,
      lastFailureAtMs: Date.now(),
      stalenessReason: reason,
      lastSkipReason: reason,
    };
  }
}

export async function refreshForecastChallengerBtcAnchor(
  cache: ForecastChallengerBtcAnchorCache,
  fetchCandles: (symbol: string, interval: string, limit: number) => Promise<Candle[]>,
  predict: (symbol: string, timeframe: string, candles: Candle[]) => Promise<ForecastChallengerPrediction>,
): Promise<void> {
  try {
    const candles = await fetchCandles("BTCUSDT", "1h", 200);
    if (!Array.isArray(candles) || candles.length < 32) {
      cache.noteFailure("BTC anchor candle fetch returned insufficient history");
      return;
    }
    cache.set(await predict("BTCUSDT", "1h", candles));
  } catch (error) {
    cache.noteFailure(error instanceof Error ? error.message : "BTC anchor refresh failed");
  }
}

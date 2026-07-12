/** Small shared candle indicators (EMA, ROC, SMA, ATR) used across measurement lanes. */

import type { Candle } from "@dtc/shared";

export function computeEMA(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const mult = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += closes[i]!;
  sma /= period;
  out[period - 1] = sma;
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i]! * mult + (out[i - 1] as number) * (1 - mult);
  }
  return out;
}

export function computeROC(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const prev = closes[i - period]!;
    out[i] = prev !== 0 ? ((closes[i]! - prev) / prev) * 100 : null;
  }
  return out;
}

export function computeSMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder's smoothed RSI (the standard convention: first average is a simple mean over `period`
 *  changes, every value after is Wilder-smoothed). Returns null until index >= period. */
export function computeRSI(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta > 0) avgGain += delta;
    else avgLoss += -delta;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function computeATR(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    const pc = candles[i - 1]!.close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i]!;
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

/**
 * Standard Bollinger Band width, as a full rolling series (index-aligned with `closes`, same
 * convention as computeSMA/computeEMA/computeATR): width = (upperBand − lowerBand) / middleBand,
 * where middleBand = SMA(period) and upper/lower = middleBand ± stdDevMultiple × POPULATION
 * standard deviation (divide by `period`, not `period − 1`) — the identical formula and defaults
 * (period 20, multiple 2) as packages/shared/src/indicators.ts's own single-snapshot
 * `bollingerBands()`, just returned as a rolling array instead of one latest-value snapshot, to
 * match this file's own convention of index-aligned series.
 *
 * A dimensionless, price-normalized ratio: LOW = a tight/coiled range (a "squeeze" — the classic
 * volatility-compression signal), HIGH = a wide, already-expanded range. Returns null until index
 * >= period − 1, same "not enough history yet" convention as the rest of this file. Additive only —
 * does not alter any existing exported function.
 */
export function computeBollingerBandWidth(closes: number[], period = 20, stdDevMultiple = 2): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (!(period > 0) || closes.length < period) return out;
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    if (!(middle > 0)) continue; // non-positive price -> width undefined, leave null
    const variance = slice.reduce((a, b) => a + (b - middle) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    const upper = middle + stdDevMultiple * stdDev;
    const lower = middle - stdDevMultiple * stdDev;
    out[i] = (upper - lower) / middle;
  }
  return out;
}

/**
 * Rolling percentile rank (0-100) of the value at each index against its OWN trailing `window` of
 * history (inclusive of the current value itself — a value equal to the trailing max scores 100; a
 * value equal to the trailing min scores ~(1/window)×100, never 0). Generic over any indicator
 * series: this codebase's primary use is ranking the CURRENT ATR reading against its own recent
 * history to detect a volatility-compression regime (see compression-expansion-edge.ts's
 * ATR-percentile compression gate), but the algorithm itself has no ATR-specific knowledge, so the
 * exact same function is reused there to rank Bollinger-band-width too, rather than duplicating the
 * percentile math for a second series.
 *
 * Requires a FULL window of non-null, finite values ending at `i` (no gaps) before it produces a
 * result — returns null for every earlier index, and for any index whose trailing window contains
 * a null/non-finite reading, same "not enough/incomplete history yet" convention as
 * computeSMA/computeATR.
 *
 * Window choice: this file makes no assumption about window size — callers pick one long enough to
 * characterize "this symbol's own current volatility regime" without stretching back into a
 * completely different one. compression-expansion-edge.ts defaults to 100 bars (~4.2 days on 1h
 * candles): enough samples for a stable percentile estimate while staying regime-local.
 */
export function computeATRPercentile(values: (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (!(window > 0)) return out;
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    if (slice.some((v) => typeof v !== "number" || !Number.isFinite(v))) continue;
    const nums = slice as number[];
    const current = nums[nums.length - 1]!;
    const countLE = nums.filter((v) => v <= current).length;
    out[i] = (countLE / window) * 100;
  }
  return out;
}

/**
 * Shared OHLC indicator helpers for offline/report-only analysis modules. Pure functions only —
 * no I/O, no store, never touches live execution.
 *
 * `computeATR` mirrors the exact Wilder's-smoothing algorithm already proven out in
 * h6-trend-edge.ts's ATR-chandelier trend lane (that module keeps its own copy so this
 * extraction never risks changing its behavior). It is generalized to a minimal
 * `{ high, low, close }` bar shape — structurally compatible with `@dtc/shared`'s `Candle` type
 * (which has extra open/openTime/volume fields) AND with candle data reconstructed from raw
 * Binance kline tuples, so any caller can reuse it without adapting to a specific candle shape.
 */
export interface AtrBar {
  high: number;
  low: number;
  close: number;
}

/**
 * Wilder's ATR (Average True Range). Returns an array the same length as `bars`; entries are
 * `null` until index `period` (the first `period` true-range samples are needed to seed the
 * average — TR itself is undefined at index 0 since it needs a prior close).
 *
 * out[period]   = simple average of TR[1..period]
 * out[i > period] = Wilder-smoothed: atr = (atr*(period-1) + TR[i]) / period
 */
export function computeATR(bars: readonly AtrBar[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (!(period > 0) || bars.length <= period) return out;
  const tr: number[] = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    const pc = bars[i - 1]!.close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i]!;
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

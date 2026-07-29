import type {
  AtrPlan,
  BollingerBands,
  Candle,
  FibonacciLevels,
  TimeframeIndicatorSnapshot,
  TrendLabel,
  Direction,
} from "./types.js";

const EPSILON = 1e-9;

function pricePrecision(value: number): number {
  const absolute = Math.abs(value);
  if (absolute !== 0 && absolute < 0.0001) return 10;
  if (absolute !== 0 && absolute < 0.01) return 8;
  if (absolute !== 0 && absolute < 1) return 6;
  if (absolute !== 0 && absolute < 100) return 4;
  return 2;
}

export function roundPrice(value: number, reference = value): number {
  return round(value, pricePrecision(reference));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sma(values: number[], period: number): number {
  const slice = values.slice(-Math.min(period, values.length));
  return average(slice);
}

export function ema(values: number[], period: number): number {
  const actualPeriod = Math.min(period, values.length);
  if (actualPeriod === 0) {
    return 0;
  }
  const multiplier = 2 / (actualPeriod + 1);
  let current = average(values.slice(0, actualPeriod));
  for (const value of values.slice(actualPeriod)) {
    current = (value - current) * multiplier + current;
  }
  return current;
}

export function standardDeviation(values: number[]): number {
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

export function rsi(values: number[], period = 14): number {
  if (values.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) {
    return 100;
  }

  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

export function macd(values: number[]): { macd: number; signal: number; histogram: number } {
  const macdLineSeries = values.map((_, index) => {
    const slice = values.slice(0, index + 1);
    return ema(slice, 12) - ema(slice, 26);
  });
  const macdValue = macdLineSeries.at(-1) ?? 0;
  const signalValue = ema(macdLineSeries, 9);
  return {
    macd: round(macdValue, 4),
    signal: round(signalValue, 4),
    histogram: round(macdValue - signalValue, 4),
  };
}

export function bollingerBands(values: number[], period = 20): BollingerBands {
  const slice = values.slice(-Math.min(period, values.length));
  const middle = average(slice);
  const deviation = standardDeviation(slice);
  return {
    upper: round(middle + deviation * 2, 4),
    middle: round(middle, 4),
    lower: round(middle - deviation * 2, 4),
  };
}

export function trueRanges(candles: Candle[]): number[] {
  return candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

export function atr(candles: Candle[], period = 14): number {
  const ranges = trueRanges(candles);
  return average(ranges.slice(-Math.min(period, ranges.length)));
}

export function vwap(candles: Candle[]): number {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const candle of candles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
  }
  return cumulativeVolume === 0 ? candles.at(-1)?.close ?? 0 : cumulativePriceVolume / cumulativeVolume;
}

function latestComparableVolume(values: number[]): { current: number | null; baseline: number | null } {
  if (values.length < 2) {
    return { current: null, baseline: null };
  }

  // `values` is already the completed-candle series. Using -2 here used to
  // skip the newest completed volume for no reason and mixed the accounting
  // rule with the old active-candle workaround.
  const current = values.at(-1) ?? null;
  const baselineWindow = values.slice(-21, -1);
  const baseline = baselineWindow.length > 0 ? average(baselineWindow) : null;

  return { current, baseline };
}

function detectTrend(close: number, ema20Value: number, ema50Value: number, ema200Value: number | null): TrendLabel {
  if (ema200Value === null) return "SIDEWAYS";
  if (close > ema20Value && ema20Value >= ema50Value && ema50Value >= ema200Value) {
    return "BULLISH";
  }
  if (close < ema20Value && ema20Value <= ema50Value && ema50Value <= ema200Value) {
    return "BEARISH";
  }
  return "SIDEWAYS";
}

const INTERVAL_MS: Readonly<Record<string, number>> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

/** The fixed duration of a supported Binance kline interval, or null for a calendar interval. */
export function candleIntervalMs(interval: string): number | null {
  return INTERVAL_MS[interval] ?? null;
}

function timeframeMs(timeframe: "5m" | "15m" | "1h"): number {
  return candleIntervalMs(timeframe)!;
}

/**
 * Binance kline responses can include the currently-forming bar.  Scanner
 * features are strictly close-to-close: a bar participates only after its
 * interval has elapsed.  This helper is exported so callers that calculate
 * non-indicator features (for example Fibonacci) use exactly the same rule.
 */
export function completedCandles(
  candles: Candle[],
  timeframe: string,
  now = Date.now(),
): Candle[] {
  const closeAfterMs = candleIntervalMs(timeframe);
  // Calendar-month klines have no fixed duration. Refuse them rather than
  // accidentally treating a still-forming month as a completed observation.
  if (closeAfterMs === null) return [];
  return candles.filter((candle) => candle.openTime + closeAfterMs <= now);
}

export function calculateTimeframeIndicators(
  candles: Candle[],
  timeframe: "5m" | "15m" | "1h",
  now = Date.now(),
): TimeframeIndicatorSnapshot {
  const completed = completedCandles(candles, timeframe, now);
  // MACD requires 26 completed observations. Twenty-nine completed candles
  // preserve the legacy 30-raw-candle minimum when the final raw candle is
  // actively forming; EMA200 remains separately fail-closed at 250 completed.
  if (completed.length < 29) {
    throw new Error(`At least 29 completed candles are required for ${timeframe} indicators.`);
  }

  const closes = completed.map((candle) => candle.close);
  const volumes = completed.map((candle) => candle.volume);
  const last = completed.at(-1)!;
  const ema20Value = ema(closes, 20);
  const ema50Value = ema(closes, 50);
  // A 200-period baseline needs burn-in.  Returning a shortened EMA here is
  // mathematically a different indicator and previously made 150-bar scans
  // look valid.
  const ema200Value = completed.length >= 250 ? ema(closes, 200) : null;
  const sma20Value = sma(closes, 20);
  // Every historical feature must share the same completed-candle cutoff.
  // Using raw `candles` here leaked an active bar into ATR/VWAP/range/volume
  // while EMA used the completed series above.
  const atrValue = atr(completed, 14);
  const vwapValue = vwap(completed);
  const recent = completed.slice(-20);
  const previousRecent = completed.slice(-21, -1);
  const latestBody = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const wickTotal = Math.max(upperWick + lowerWick, EPSILON);
  const volumeBaseline = sma(volumes, 20);
  const comparableVolume = latestComparableVolume(volumes);
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const recentLow = Math.min(...recent.map((candle) => candle.low));
  const previousHigh = previousRecent.length ? Math.max(...previousRecent.map((candle) => candle.high)) : recentHigh;
  const previousLow = previousRecent.length ? Math.min(...previousRecent.map((candle) => candle.low)) : recentLow;
  const freshnessGrace = timeframeMs(timeframe) * 3;

  const bodyWickRatio = wickTotal <= EPSILON ? 10 : latestBody / wickTotal;
  const volumeRatio =
    comparableVolume.current !== null && comparableVolume.baseline !== null && comparableVolume.baseline > 0
      ? comparableVolume.current / comparableVolume.baseline
      : null;

  return {
    timeframe,
    latestClose: roundPrice(last.close),
    ema20: roundPrice(ema20Value, last.close),
    ema50: roundPrice(ema50Value, last.close),
    ema200: ema200Value === null ? null : roundPrice(ema200Value, last.close),
    ema200Available: ema200Value !== null,
    sma20: roundPrice(sma20Value, last.close),
    rsi14: round(rsi(closes, 14), 4),
    macd: macd(closes),
    bollingerBands20: bollingerBands(closes, 20),
    atr14: roundPrice(atrValue, last.close),
    atrPercent: round((atrValue / Math.max(last.close, EPSILON)) * 100, 4),
    vwap: roundPrice(vwapValue, last.close),
    volumeRatio: volumeRatio === null ? null : round(volumeRatio, 4),
    bodyWickRatio: round(Math.min(bodyWickRatio, 10), 4),
    support: roundPrice(recentLow, last.close),
    resistance: roundPrice(recentHigh, last.close),
    recentSwingHigh: roundPrice(recentHigh, last.close),
    recentSwingLow: roundPrice(recentLow, last.close),
    distanceFromEma20: round(((last.close - ema20Value) / Math.max(ema20Value, EPSILON)) * 100, 4),
    distanceFromVwap: round(((last.close - vwapValue) / Math.max(vwapValue, EPSILON)) * 100, 4),
    breakoutHigh: last.close > previousHigh,
    breakoutLow: last.close < previousLow,
    trend: detectTrend(last.close, ema20Value, ema50Value, ema200Value),
    isFresh: now - (last.openTime + timeframeMs(timeframe)) < freshnessGrace,
    lastOpenTime: last.openTime,
    sourceCandleOpenTime: last.openTime,
    sourceCandleCloseTime: last.openTime + timeframeMs(timeframe),
    completedCandleCount: completed.length,
  };
}

export function calculateFibonacciLevels(candles: Candle[]): FibonacciLevels {
  const lookback = candles.slice(-60);
  const recentHigh = Math.max(...lookback.map((candle) => candle.high));
  const recentLow = Math.min(...lookback.map((candle) => candle.low));
  const range = recentHigh - recentLow || EPSILON;

  return {
    recentHigh: roundPrice(recentHigh),
    recentLow: roundPrice(recentLow),
    retracement236: roundPrice(recentHigh - range * 0.236, recentHigh),
    retracement382: roundPrice(recentHigh - range * 0.382, recentHigh),
    retracement500: roundPrice(recentHigh - range * 0.5, recentHigh),
    retracement618: roundPrice(recentHigh - range * 0.618, recentHigh),
    retracement786: roundPrice(recentHigh - range * 0.786, recentHigh),
    extension1272: roundPrice(recentHigh + range * 0.272, recentHigh),
    extension1618: roundPrice(recentHigh + range * 0.618, recentHigh),
  };
}

export function buildAtrPlan(
  price: number,
  atrValue: number,
  atrPercent: number,
  direction: Direction,
  fib: FibonacciLevels,
): AtrPlan {
  if (direction === "NEUTRAL") {
    return {
      atr14: roundPrice(atrValue, price),
      atrPercent: round(atrPercent, 4),
      entryZoneLow: null,
      entryZoneHigh: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      riskReward: null,
    };
  }

  const longEntryLow = Math.min(fib.retracement500, price);
  const longEntryHigh = Math.min(fib.retracement382, price);
  const shortEntryLow = Math.max(fib.retracement382, price);
  const shortEntryHigh = Math.max(fib.retracement236, price);

  const entryLow = direction === "LONG" ? longEntryLow : shortEntryLow;
  const entryHigh = direction === "LONG" ? longEntryHigh : shortEntryHigh;
  const entryMid = (entryLow + entryHigh) / 2;
  const stopLoss = direction === "LONG" ? entryLow - atrValue * 1.15 : entryHigh + atrValue * 1.15;
  const tp1 = direction === "LONG" ? price + atrValue * 1.2 : price - atrValue * 1.2;
  const tp2 = direction === "LONG" ? fib.extension1272 : price - atrValue * 2;
  const tp3 = direction === "LONG" ? fib.extension1618 : price - atrValue * 3;
  const reward = direction === "LONG" ? tp2 - entryMid : entryMid - tp2;
  const risk = direction === "LONG" ? entryMid - stopLoss : stopLoss - entryMid;

  const invalidLong = direction === "LONG" && !(entryLow <= entryHigh && stopLoss < entryLow && tp1 > entryMid && tp2 > entryMid && tp3 > entryMid);
  const invalidShort = direction === "SHORT" && !(entryLow <= entryHigh && stopLoss > entryHigh && tp1 < entryMid && tp2 < entryMid && tp3 < entryMid);

  if (invalidLong || invalidShort || !Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) {
    return {
      atr14: roundPrice(atrValue, price),
      atrPercent: round(atrPercent, 4),
      entryZoneLow: null,
      entryZoneHigh: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      riskReward: null,
    };
  }

  const roundedEntryLow = roundPrice(entryLow, price);
  const roundedEntryHigh = roundPrice(entryHigh, price);
  const roundedEntryMid = (roundedEntryLow + roundedEntryHigh) / 2;
  const roundedStopLoss = roundPrice(stopLoss, price);
  const roundedTp1 = roundPrice(tp1, price);
  const roundedTp2 = roundPrice(tp2, price);
  const roundedTp3 = roundPrice(tp3, price);

  // Rounding each field independently (needed so a plan is internally consistent at the
  // symbol's own price precision) can collapse a razor-thin raw gap that passed the
  // pre-round check above — e.g. stopLoss and entryHigh landing on the same tick for a
  // near-zero-ATR symbol. Re-check the identical invariant post-round so a collision falls
  // back to "no plan" (safe) instead of shipping a zero/inverted-risk geometry.
  const roundedInvalidLong =
    direction === "LONG" &&
    !(roundedEntryLow <= roundedEntryHigh && roundedStopLoss < roundedEntryLow && roundedTp1 > roundedEntryMid && roundedTp2 > roundedEntryMid && roundedTp3 > roundedEntryMid);
  const roundedInvalidShort =
    direction === "SHORT" &&
    !(roundedEntryLow <= roundedEntryHigh && roundedStopLoss > roundedEntryHigh && roundedTp1 < roundedEntryMid && roundedTp2 < roundedEntryMid && roundedTp3 < roundedEntryMid);

  if (roundedInvalidLong || roundedInvalidShort) {
    return {
      atr14: roundPrice(atrValue, price),
      atrPercent: round(atrPercent, 4),
      entryZoneLow: null,
      entryZoneHigh: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      riskReward: null,
    };
  }

  return {
    atr14: roundPrice(atrValue, price),
    atrPercent: round(atrPercent, 4),
    entryZoneLow: roundedEntryLow,
    entryZoneHigh: roundedEntryHigh,
    stopLoss: roundedStopLoss,
    takeProfit1: roundedTp1,
    takeProfit2: roundedTp2,
    takeProfit3: roundedTp3,
    riskReward: risk > 0 ? round(reward / risk, 4) : null,
  };
}

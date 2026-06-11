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

  const current = values.at(-2) ?? null;
  const baselineWindow = values.slice(-22, -2);
  const baseline = baselineWindow.length > 0 ? average(baselineWindow) : null;

  return { current, baseline };
}

function detectTrend(close: number, ema20Value: number, ema50Value: number, ema200Value: number): TrendLabel {
  if (close > ema20Value && ema20Value >= ema50Value && ema50Value >= ema200Value) {
    return "BULLISH";
  }
  if (close < ema20Value && ema20Value <= ema50Value && ema50Value <= ema200Value) {
    return "BEARISH";
  }
  return "SIDEWAYS";
}

function timeframeMs(timeframe: "5m" | "15m" | "1h"): number {
  if (timeframe === "5m") return 5 * 60 * 1000;
  if (timeframe === "15m") return 15 * 60 * 1000;
  return 60 * 60 * 1000;
}

export function calculateTimeframeIndicators(
  candles: Candle[],
  timeframe: "5m" | "15m" | "1h",
  now = Date.now(),
): TimeframeIndicatorSnapshot {
  if (candles.length < 30) {
    throw new Error(`At least 30 candles are required for ${timeframe} indicators.`);
  }

  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const last = candles.at(-1)!;
  const ema20Value = ema(closes, 20);
  const ema50Value = ema(closes, 50);
  const ema200Value = ema(closes, 200);
  const sma20Value = sma(closes, 20);
  const atrValue = atr(candles, 14);
  const vwapValue = vwap(candles);
  const recent = candles.slice(-20);
  const previousRecent = candles.slice(-21, -1);
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
    ema200: roundPrice(ema200Value, last.close),
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
    isFresh: now - last.openTime <= freshnessGrace,
    lastOpenTime: last.openTime,
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

  return {
    atr14: roundPrice(atrValue, price),
    atrPercent: round(atrPercent, 4),
    entryZoneLow: roundPrice(entryLow, price),
    entryZoneHigh: roundPrice(entryHigh, price),
    stopLoss: roundPrice(stopLoss, price),
    takeProfit1: roundPrice(tp1, price),
    takeProfit2: roundPrice(tp2, price),
    takeProfit3: roundPrice(tp3, price),
    riskReward: risk > 0 ? round(reward / risk, 4) : null,
  };
}

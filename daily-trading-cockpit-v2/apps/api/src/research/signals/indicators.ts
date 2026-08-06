import type { TournamentCandle } from "../tournament-types.js";

export function sma(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function ema(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  for (const next of values.slice(period)) value = alpha * next + (1 - alpha) * value;
  return value;
}

export function rsi(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period + 1) return null;
  const changes = values.slice(-(period + 1)).slice(1).map((value, index) => value - values[values.length - period - 1 + index]!);
  const gains = changes.filter((value) => value > 0).reduce((sum, value) => sum + value, 0) / period;
  const losses = -changes.filter((value) => value < 0).reduce((sum, value) => sum + value, 0) / period;
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

export function atr(candles: readonly TournamentCandle[], period: number): number | null {
  if (candles.length < period + 1 || period <= 0) return null;
  const sample = candles.slice(-(period + 1));
  const trs: number[] = [];
  for (let index = 1; index < sample.length; index += 1) {
    const current = sample[index]!;
    const previous = sample[index - 1]!;
    trs.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  return trs.reduce((sum, value) => sum + value, 0) / trs.length;
}

export function highestHigh(candles: readonly TournamentCandle[], period: number): number | null {
  if (candles.length < period || period <= 0) return null;
  return Math.max(...candles.slice(-period).map((candle) => candle.high));
}

export function lowestLow(candles: readonly TournamentCandle[], period: number): number | null {
  if (candles.length < period || period <= 0) return null;
  return Math.min(...candles.slice(-period).map((candle) => candle.low));
}

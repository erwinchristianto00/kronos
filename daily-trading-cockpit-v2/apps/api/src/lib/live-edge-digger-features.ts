/**
 * LIVE EDGE DIGGER — decision-time feature computation.
 *
 * Deliberately PURE: it takes already-fetched completed candles plus point-in-time snapshots and
 * returns features. All network IO lives in the engine, so every number here is reproducible from a
 * fixture and testable without a live exchange.
 *
 * Cross-sectional features (ranks, breadth, cohesion, dispersion, percentiles) are computed WITHIN
 * one cycle's universe, from that cycle's own completed bars. That is what makes them decision-time
 * safe: a rank is a statement about the market as it stood at `asOfMs`, not a statement that needed
 * the future to settle.
 */
import type { Candle } from "@dtc/shared";

import { computeOlsBeta, computeSimpleReturns } from "./residual-momentum-edge.js";
import {
  assertCandlesClosedAsOf,
  type MarketFeatures,
  type RegimeFamily,
  type SymbolFeatures,
} from "./live-edge-digger-types.js";

/** Point-in-time, non-candle inputs for one symbol, read at the decision instant. */
export interface SymbolSnapshotInputs {
  readonly quoteVolume24hUsd: number | null;
  readonly spreadBps: number | null;
  readonly topDepthUsd: number | null;
  readonly fundingBps: number | null;
  readonly basisBps: number | null;
  readonly openInterestUsd: number | null;
}

export interface SymbolCycleInput {
  readonly symbol: string;
  /** COMPLETED 1h candles, ascending. The engine asserts closure before calling. */
  readonly hourly: readonly Candle[];
  /** COMPLETED 15m candles, ascending — used only for the shock proxy. */
  readonly fifteenMin: readonly Candle[];
  readonly snapshot: SymbolSnapshotInputs;
}

const HOUR_MS = 3_600_000;
const FIFTEEN_MIN_MS = 900_000;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function ret(candles: readonly Candle[], bars: number): number | null {
  if (candles.length < bars + 1) return null;
  const now = candles[candles.length - 1]!.close;
  const then = candles[candles.length - 1 - bars]!.close;
  if (!finite(now) || !finite(then) || then <= 0) return null;
  return now / then - 1;
}

/** Simple ATR over completed bars, as a fraction of the last close. */
function atrPct(candles: readonly Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    if (!finite(tr)) return null;
    sum += tr;
  }
  const last = candles[candles.length - 1]!.close;
  if (!finite(last) || last <= 0) return null;
  return sum / period / last;
}

/**
 * Range compression: the most recent 24-bar high-low range relative to the widest 24-bar range seen
 * in the trailing window. Low value = coiled. Computed only from completed bars.
 */
function rangeCompression(candles: readonly Candle[], window = 24, lookback = 96): number | null {
  if (candles.length < window + 1) return null;
  const spanOf = (endExclusive: number): number | null => {
    const slice = candles.slice(Math.max(0, endExclusive - window), endExclusive);
    if (slice.length < window) return null;
    const hi = Math.max(...slice.map((c) => c.high));
    const lo = Math.min(...slice.map((c) => c.low));
    const mid = (hi + lo) / 2;
    if (!finite(hi) || !finite(lo) || mid <= 0) return null;
    return (hi - lo) / mid;
  };
  const current = spanOf(candles.length);
  if (current === null) return null;
  const spans: number[] = [];
  const start = Math.max(window, candles.length - lookback);
  for (let end = start; end <= candles.length; end++) {
    const s = spanOf(end);
    if (s !== null) spans.push(s);
  }
  if (spans.length < 4) return null;
  const widest = Math.max(...spans);
  if (!(widest > 0)) return null;
  return current / widest;
}

/**
 * Rolling OLS beta of symbol hourly returns on BTC hourly returns, over completed bars.
 *
 * Delegates to the CANONICAL `computeOlsBeta`/`computeSimpleReturns` from residual-momentum-edge.ts
 * rather than carrying a second implementation — the same single-implementation discipline the
 * episode counter follows. Two beta definitions in one book eventually disagree, and the place they
 * would disagree is "how market-neutral is this position really".
 */
function betaTo(symbolCandles: readonly Candle[], btcCandles: readonly Candle[], bars = 72): number | null {
  const sym = computeSimpleReturns(symbolCandles.map((c) => c.close));
  const btc = computeSimpleReturns(btcCandles.map((c) => c.close));
  const n = Math.min(sym.length, btc.length, bars);
  if (n < 24) return null; // too few paired observations for a stable slope
  return computeOlsBeta(sym.slice(-n), btc.slice(-n));
}

function percentileRank(value: number, population: readonly number[]): number | null {
  if (population.length < 2) return null;
  const below = population.filter((v) => v < value).length;
  return below / (population.length - 1);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const varr = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(varr);
}

export interface BuildMarketFeaturesInput {
  readonly asOfMs: number;
  readonly regime: string | null;
  readonly regimeFamily: RegimeFamily;
  readonly benchmarkSymbol: string;
  readonly symbols: readonly SymbolCycleInput[];
}

/**
 * Builds the full decision-time snapshot for one cycle.
 *
 * Asserts candle closure for EVERY symbol before reading a single price — the assertion is the
 * point, not a formality: it is the difference between "we believe this is decision-time safe" and
 * "a forming bar cannot physically reach a rule".
 */
export function buildMarketFeatures(input: BuildMarketFeaturesInput): MarketFeatures {
  const { asOfMs, benchmarkSymbol } = input;
  for (const s of input.symbols) {
    assertCandlesClosedAsOf(s.hourly, HOUR_MS, asOfMs, `hourly candles for ${s.symbol}`);
    assertCandlesClosedAsOf(s.fifteenMin, FIFTEEN_MIN_MS, asOfMs, `15m candles for ${s.symbol}`);
  }

  const benchmark = input.symbols.find((s) => s.symbol === benchmarkSymbol);
  const btcHourly = benchmark?.hourly ?? [];
  const btcRet24h = ret(btcHourly, 24);

  // ---- pass 1: per-symbol primitives that need no cross-sectional context.
  interface Primitive {
    input: SymbolCycleInput;
    close: number;
    ret1h: number | null;
    ret4h: number | null;
    ret24h: number | null;
    beta: number | null;
    residual: number | null;
    atr: number | null;
    compression: number | null;
    shock: number | null;
    lastOpen: number;
    lastClose: number;
  }
  const primitives: Primitive[] = [];
  for (const s of input.symbols) {
    const last = s.hourly[s.hourly.length - 1];
    if (!last || !finite(last.close)) continue;
    const r24 = ret(s.hourly, 24);
    const beta = s.symbol === benchmarkSymbol ? 1 : betaTo(s.hourly, btcHourly);
    // Residual = own 24h return minus the beta-explained market component. This is the
    // idiosyncratic move, and it is the only part a market-neutral rule can legitimately claim.
    const residual = r24 !== null && beta !== null && btcRet24h !== null ? r24 - beta * btcRet24h : null;
    const atr = atrPct(s.hourly);
    const shock15 = ret(s.fifteenMin, 1);
    primitives.push({
      input: s,
      close: last.close,
      ret1h: ret(s.hourly, 1),
      ret4h: ret(s.hourly, 4),
      ret24h: r24,
      beta,
      residual,
      atr,
      compression: rangeCompression(s.hourly),
      // 15m move expressed in hourly-ATR units: a crude but honest cascade proxy.
      shock: shock15 !== null && atr !== null && atr > 0 ? shock15 / atr : null,
      lastOpen: last.openTime,
      lastClose: last.openTime + HOUR_MS,
    });
  }

  // ---- pass 2: cross-sectional context, computed over THIS cycle's universe only.
  const residuals = primitives.map((p) => p.residual).filter(finite);
  const momenta = primitives.map((p) => p.ret24h).filter(finite);
  const atrs = primitives.map((p) => p.atr).filter(finite);
  const compressions = primitives.map((p) => p.compression).filter(finite);
  const medianRet24h = median(momenta);

  const symbols: SymbolFeatures[] = primitives.map((p) => ({
    symbol: p.input.symbol,
    asOfMs,
    lastClosedCandleOpenMs: p.lastOpen,
    lastClosedCandleCloseMs: p.lastClose,
    close: p.close,
    ret1h: p.ret1h,
    ret4h: p.ret4h,
    ret24h: p.ret24h,
    betaBtc: p.beta,
    residualRet24h: p.residual,
    residualRank: p.residual !== null ? percentileRank(p.residual, residuals) : null,
    momentumRank: p.ret24h !== null ? percentileRank(p.ret24h, momenta) : null,
    relativeStrength: p.ret24h !== null && medianRet24h !== null ? p.ret24h - medianRet24h : null,
    atrPct: p.atr,
    atrPercentile: p.atr !== null ? percentileRank(p.atr, atrs) : null,
    rangeCompressionPercentile: p.compression !== null ? percentileRank(p.compression, compressions) : null,
    quoteVolume24hUsd: p.input.snapshot.quoteVolume24hUsd,
    spreadBps: p.input.snapshot.spreadBps,
    topDepthUsd: p.input.snapshot.topDepthUsd,
    fundingBps: p.input.snapshot.fundingBps,
    basisBps: p.input.snapshot.basisBps,
    openInterestUsd: p.input.snapshot.openInterestUsd,
    shockAtrUnits: p.shock,
  }));

  const up = momenta.filter((r) => r > 0).length;
  const sameDirectionAsBtc = btcRet24h === null
    ? null
    : momenta.filter((r) => (r >= 0) === (btcRet24h >= 0)).length / Math.max(1, momenta.length);

  return {
    asOfMs,
    regime: input.regime,
    regimeFamily: input.regimeFamily,
    universeSize: symbols.length,
    breadth: momenta.length > 0 ? up / momenta.length : null,
    cohesion: sameDirectionAsBtc,
    dispersion: stdev(momenta),
    medianAbsRet24h: median(momenta.map((r) => Math.abs(r))),
    symbols,
  };
}

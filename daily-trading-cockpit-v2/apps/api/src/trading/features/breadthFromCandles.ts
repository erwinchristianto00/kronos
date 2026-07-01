import type { Candle } from "@dtc/shared";
import { ema, vwap } from "@dtc/shared";
import type { BreadthUniverseKind } from "../types.js";
import { DEFAULT_FEATURE_CONFIG, type FeatureAdapterInput } from "./contextFromCandles.js";

const HOUR_MS = 60 * 60_000;
const EMA_PERIOD = 20;
const LOOKBACK_BARS = 24;

export interface BreadthSymbolCandles {
  symbol: string;
  h1: Candle[];
}

export interface BreadthFromCandlesInput {
  asOf: number;
  btc: Candle[];
  universe: BreadthSymbolCandles[];
  universeKind: BreadthUniverseKind;
  universeDescription?: string;
  minSymbols?: number;
}

export interface BreadthMetrics {
  symbolCount: number;
  requiredSymbolCount: number;
  percentAboveEma20: number;
  percentAboveVwap: number;
  percentPositive24hReturn: number;
  percentOutperformingBtc24h: number;
  medianReturn24h: number;
  medianDistanceFromEma20: number;
  downsideParticipationDuringBtcSelloff: number | null;
  breadthTrendImprovement: number;
  btcReturn24h: number;
}

export interface BreadthFromCandlesOutput {
  breadth?: NonNullable<FeatureAdapterInput["breadth"]>;
  flags?: Pick<
    NonNullable<FeatureAdapterInput["overrides"]>,
    "marketBreadthWeak" | "marketBreadthPositive" | "marketBreadthCollapses" | "altBreadthImproves" | "altBreadthPositive"
  >;
  metrics?: BreadthMetrics;
  unavailableReason?: string;
}

interface SymbolBreadthSnapshot {
  symbol: string;
  close: number;
  return24h: number;
  distanceFromEma20: number;
  aboveEma20: boolean;
  aboveVwap: boolean;
  positive24hReturn: boolean;
}

function closeTime(candle: Candle): number {
  return candle.openTime + HOUR_MS;
}

function closedBy(candles: Candle[], asOf: number): Candle[] {
  return [...candles].filter((candle) => closeTime(candle) <= asOf).sort((a, b) => a.openTime - b.openTime);
}

function median(values: number[]): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1]! + finite[mid]!) / 2 : finite[mid]!;
}

function pct(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

function snapshot(symbol: string, candles: Candle[], asOf: number): SymbolBreadthSnapshot | null {
  const closed = closedBy(candles, asOf);
  if (closed.length < LOOKBACK_BARS + EMA_PERIOD) return null;
  const latest = closed.at(-1)!;
  const prior = closed.at(-1 - LOOKBACK_BARS);
  if (!prior || prior.close <= 0) return null;
  const window = closed.slice(-LOOKBACK_BARS);
  const closes = closed.map((candle) => candle.close);
  const ema20 = ema(closes, EMA_PERIOD);
  const rollVwap = vwap(window);
  if (!(ema20 > 0) || !(rollVwap > 0)) return null;
  const return24h = latest.close / prior.close - 1;
  const distanceFromEma20 = latest.close / ema20 - 1;
  return {
    symbol,
    close: latest.close,
    return24h,
    distanceFromEma20,
    aboveEma20: latest.close > ema20,
    aboveVwap: latest.close > rollVwap,
    positive24hReturn: return24h > 0,
  };
}

function buildMetrics(
  snapshots: SymbolBreadthSnapshot[],
  btcReturn24h: number,
  previousPositivePct: number,
  minSymbols: number,
): BreadthMetrics {
  const symbolCount = snapshots.length;
  const percentAboveEma20 = pct(snapshots.filter((s) => s.aboveEma20).length, symbolCount);
  const percentAboveVwap = pct(snapshots.filter((s) => s.aboveVwap).length, symbolCount);
  const percentPositive24hReturn = pct(snapshots.filter((s) => s.positive24hReturn).length, symbolCount);
  const percentOutperformingBtc24h = pct(snapshots.filter((s) => s.return24h > btcReturn24h).length, symbolCount);
  return {
    symbolCount,
    requiredSymbolCount: minSymbols,
    percentAboveEma20,
    percentAboveVwap,
    percentPositive24hReturn,
    percentOutperformingBtc24h,
    medianReturn24h: median(snapshots.map((s) => s.return24h)),
    medianDistanceFromEma20: median(snapshots.map((s) => s.distanceFromEma20)),
    downsideParticipationDuringBtcSelloff:
      btcReturn24h < 0 ? pct(snapshots.filter((s) => s.return24h < 0).length, symbolCount) : null,
    breadthTrendImprovement: percentPositive24hReturn - previousPositivePct,
    btcReturn24h,
  };
}

export function breadthFromCandles(input: BreadthFromCandlesInput): BreadthFromCandlesOutput {
  const minSymbols = input.minSymbols ?? 8;
  const btcNow = snapshot("BTCUSDT", input.btc, input.asOf);
  if (!btcNow) {
    return { unavailableReason: "BTC_LOOKBACK_INSUFFICIENT" };
  }

  const snapshots = input.universe
    .filter((item) => item.symbol.toUpperCase() !== "BTCUSDT")
    .map((item) => snapshot(item.symbol, item.h1, input.asOf))
    .filter((item): item is SymbolBreadthSnapshot => item !== null);
  if (snapshots.length < minSymbols) {
    return { unavailableReason: `UNIVERSE_LOOKBACK_INSUFFICIENT:${snapshots.length}/${minSymbols}` };
  }

  const previousSnapshots = input.universe
    .filter((item) => item.symbol.toUpperCase() !== "BTCUSDT")
    .map((item) => snapshot(item.symbol, item.h1, input.asOf - LOOKBACK_BARS * HOUR_MS))
    .filter((item): item is SymbolBreadthSnapshot => item !== null);
  const previousPositivePct = pct(previousSnapshots.filter((s) => s.positive24hReturn).length, previousSnapshots.length);
  const metrics = buildMetrics(snapshots, btcNow.return24h, previousPositivePct, minSymbols);
  const advancersPct =
    (metrics.percentAboveEma20 + metrics.percentAboveVwap + metrics.percentPositive24hReturn) / 3;
  const altAdvancersPct =
    (metrics.percentOutperformingBtc24h + Math.max(0, Math.min(1, 0.5 + metrics.breadthTrendImprovement))) / 2;

  const flags = {
    marketBreadthWeak: advancersPct < DEFAULT_FEATURE_CONFIG.breadthWeakPct,
    marketBreadthPositive: advancersPct >= DEFAULT_FEATURE_CONFIG.breadthPositivePct,
    marketBreadthCollapses: advancersPct < 0.2,
    altBreadthImproves: altAdvancersPct >= DEFAULT_FEATURE_CONFIG.breadthWeakPct,
    altBreadthPositive: altAdvancersPct >= DEFAULT_FEATURE_CONFIG.breadthPositivePct,
  };

  return {
    breadth: {
      advancersPct,
      altAdvancersPct,
      universeKind: input.universeKind,
      universeSnapshotMs: input.asOf,
      universeDescription: input.universeDescription,
    },
    flags,
    metrics,
  };
}

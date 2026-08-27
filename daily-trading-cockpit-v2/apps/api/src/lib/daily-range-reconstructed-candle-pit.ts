/**
 * RECONSTRUCTED_CANDLE_PIT helpers for Daily Range research.
 *
 * This module deliberately reconstructs market-path research only. It cannot
 * reconstruct historical BBO, rolling C1-C6 membership, ownership conflicts,
 * or exchange fills, and therefore must never be labelled FULL_PIT or used as
 * production allocation authority.
 */
import {
  advanceDailyRangeAutoRoute,
  blankDailyRangeAutoRouteState,
  type DailyRangeAutoRouteCandle,
  type DailyRangeAutoRouteDecision,
} from "./daily-range-auto-route.js";

export const DAILY_RANGE_RECONSTRUCTED_CANDLE_PIT_DATASET_CLASS = "RECONSTRUCTED_CANDLE_PIT" as const;
export type DailyRangeReconstructedOutcome = "TP" | "SL" | "OUTCOME_AMBIGUOUS" | "UNRESOLVED";

export interface DailyRangeReconstructedCandidate {
  datasetClass: typeof DAILY_RANGE_RECONSTRUCTED_CANDLE_PIT_DATASET_CLASS;
  researchEligibilityQuality: "CANDLE_ELIGIBLE_CURRENT_UNIVERSE" | "UNKNOWN_HISTORICAL_C1_C6";
  dateUtc: string;
  symbol: string;
  decision: DailyRangeAutoRouteDecision;
  rangeHigh: number;
  rangeLow: number;
  /** The decision is known only after the completed C2/re-entry candle closes. */
  decisionTimestampMs: number;
  structuralStop: number;
  takeProfit: number;
  features: Record<string, number | null>;
}

export interface DailyRangeReconstructedResolvedCandidate extends DailyRangeReconstructedCandidate {
  outcome: DailyRangeReconstructedOutcome;
  outcomeTimestampMs: number | null;
  mfeR: number | null;
  maeR: number | null;
  holdingDurationMs: number | null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function contiguous(rows: readonly DailyRangeAutoRouteCandle[], intervalMs: number): boolean {
  return rows.length > 0 && rows.every((row, index) => index === 0 || row.openTime === (rows[index - 1]?.openTime ?? row.openTime) + intervalMs);
}

/** Strictly exclude an incomplete or future candle at the decision boundary. */
export function completedCandlesAtOrBefore<T extends Pick<DailyRangeAutoRouteCandle, "closeTime">>(
  candles: readonly T[],
  decisionTimestampMs: number,
): T[] {
  if (!Number.isFinite(decisionTimestampMs)) throw new Error("decisionTimestampMs must be finite");
  return candles.filter((candle) => {
    if (!finite(candle.closeTime)) throw new Error("candle closeTime must be finite");
    return candle.closeTime < decisionTimestampMs;
  });
}

function bodyFraction(candle: DailyRangeAutoRouteCandle): number | null {
  const range = candle.high - candle.low;
  return range > 0 ? Math.abs(candle.close - candle.open) / range : null;
}

function upperWickFraction(candle: DailyRangeAutoRouteCandle): number | null {
  const range = candle.high - candle.low;
  return range > 0 ? (candle.high - Math.max(candle.open, candle.close)) / range : null;
}

function lowerWickFraction(candle: DailyRangeAutoRouteCandle): number | null {
  const range = candle.high - candle.low;
  return range > 0 ? (Math.min(candle.open, candle.close) - candle.low) / range : null;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] ?? null : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function atr14(candles: readonly DailyRangeAutoRouteCandle[]): number | null {
  const rows = candles.slice(-15);
  if (rows.length !== 15 || !contiguous(rows, 5 * 60_000)) return null;
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!;
    const previous = rows[index - 1]!;
    ranges.push(Math.max(row.high - row.low, Math.abs(row.high - previous.close), Math.abs(row.low - previous.close)));
  }
  return mean(ranges);
}

function returnOverCompletedBars(candles: readonly DailyRangeAutoRouteCandle[], bars: number): number | null {
  const rows = candles.slice(-(bars + 1));
  if (rows.length !== bars + 1 || !contiguous(rows, 5 * 60_000)) return null;
  const first = rows[0];
  const last = rows.at(-1);
  return first && last && first.close > 0 ? last.close / first.close - 1 : null;
}

function relativeVolume(candles: readonly DailyRangeAutoRouteCandle[], current: DailyRangeAutoRouteCandle, lookback = 24): number | null {
  const prior = candles.filter((row) => row.closeTime < current.openTime).slice(-lookback).map((row) => row.volume).filter((value) => value >= 0);
  const baseline = median(prior);
  return baseline && baseline > 0 ? current.volume / baseline : null;
}

function sideAligned(value: number | null, direction: "LONG" | "SHORT"): number | null {
  return value === null ? null : direction === "LONG" ? value : -value;
}

/**
 * Small preregistered route-specific feature family, derived from completed
 * 5m candles only. BTC/ETH/breadth are injected by the runner from the same
 * decision-time panel and remain null when the panel is incomplete.
 */
export function buildReconstructedDailyRangeFeatures(input: {
  candidate: Pick<DailyRangeReconstructedCandidate, "decision" | "rangeHigh" | "rangeLow" | "decisionTimestampMs">;
  symbolCandles: readonly DailyRangeAutoRouteCandle[];
  btcCandles?: readonly DailyRangeAutoRouteCandle[];
  ethCandles?: readonly DailyRangeAutoRouteCandle[];
  universeReturns1h?: readonly number[];
}): Record<string, number | null> {
  const candles = completedCandlesAtOrBefore(input.symbolCandles, input.candidate.decisionTimestampMs);
  const btc = completedCandlesAtOrBefore(input.btcCandles ?? [], input.candidate.decisionTimestampMs);
  const eth = completedCandlesAtOrBefore(input.ethCandles ?? [], input.candidate.decisionTimestampMs);
  const decision = input.candidate.decision;
  const rangeWidth = input.candidate.rangeHigh - input.candidate.rangeLow;
  const c1 = decision.confirmationBar1;
  const c2 = decision.confirmationBar2;
  const boundary = decision.breakoutDirection === "UP" ? input.candidate.rangeHigh : input.candidate.rangeLow;
  const c1Extension = decision.breakoutDirection === "UP" ? c1.close - boundary : boundary - c1.close;
  const c2Extension = decision.breakoutDirection === "UP" ? c2.close - boundary : boundary - c2.close;
  const maxExcursion = decision.breakoutDirection === "UP"
    ? decision.breakoutExtreme - boundary
    : boundary - decision.breakoutExtreme;
  const reentryDepth = decision.entryPolicy === "FADE" ? Math.max(0, -c2Extension) : null;
  const atr = atr14(candles);
  const return1h = returnOverCompletedBars(candles, 12);
  const return4h = returnOverCompletedBars(candles, 48);
  const btc1h = returnOverCompletedBars(btc, 12);
  const btc4h = returnOverCompletedBars(btc, 48);
  const eth1h = returnOverCompletedBars(eth, 12);
  const eth4h = returnOverCompletedBars(eth, 48);
  const breadth = input.universeReturns1h?.filter(Number.isFinite) ?? [];
  const positiveBreadth = breadth.length ? breadth.filter((value) => value > 0).length / breadth.length : null;
  const negativeBreadth = breadth.length ? breadth.filter((value) => value < 0).length / breadth.length : null;
  const direction = decision.direction;
  return {
    c1ExtensionOfRange: rangeWidth > 0 ? c1Extension / rangeWidth : null,
    c2ExtensionOfRange: rangeWidth > 0 ? c2Extension / rangeWidth : null,
    expansionDeltaOfRange: rangeWidth > 0 ? (c2Extension - c1Extension) / rangeWidth : null,
    maxExcursionOfRange: rangeWidth > 0 ? maxExcursion / rangeWidth : null,
    reentryDepthOfRange: reentryDepth !== null && rangeWidth > 0 ? reentryDepth / rangeWidth : null,
    c1ExtensionOfAtr: atr && atr > 0 ? c1Extension / atr : null,
    c2ExtensionOfAtr: atr && atr > 0 ? c2Extension / atr : null,
    maxExcursionOfAtr: atr && atr > 0 ? maxExcursion / atr : null,
    reentryDepthOfAtr: reentryDepth !== null && atr && atr > 0 ? reentryDepth / atr : null,
    c1BodyFraction: bodyFraction(c1),
    c2BodyFraction: bodyFraction(c2),
    c1UpperWickFraction: upperWickFraction(c1),
    c1LowerWickFraction: lowerWickFraction(c1),
    c2UpperWickFraction: upperWickFraction(c2),
    c2LowerWickFraction: lowerWickFraction(c2),
    c1Rvol24: relativeVolume(candles, c1),
    c2Rvol24: relativeVolume(candles, c2),
    combinedRvol24: (() => {
      const baseline = median(candles.filter((row) => row.closeTime < c1.openTime).slice(-24).map((row) => row.volume));
      return baseline && baseline > 0 ? (c1.volume + c2.volume) / (2 * baseline) : null;
    })(),
    rangeWidthOfPrice: input.candidate.rangeLow > 0 ? rangeWidth / input.candidate.rangeLow : null,
    rangeWidthOfAtr: atr && atr > 0 ? rangeWidth / atr : null,
    sideAlignedReturn1h: sideAligned(return1h, direction),
    sideAlignedReturn4h: sideAligned(return4h, direction),
    btcSideAlignedReturn1h: sideAligned(btc1h, direction),
    btcSideAlignedReturn4h: sideAligned(btc4h, direction),
    ethSideAlignedReturn1h: sideAligned(eth1h, direction),
    ethSideAlignedReturn4h: sideAligned(eth4h, direction),
    universePositive1hPct: positiveBreadth,
    universeNegative1hPct: negativeBreadth,
  };
}

/** Replay the exact pure route state machine for one symbol/reference session. */
export function replayReconstructedDailyRangeAutoRoute(input: {
  dateUtc: string;
  symbol: string;
  rangeHigh: number;
  rangeLow: number;
  candles: readonly DailyRangeAutoRouteCandle[];
  featurePanel?: {
    symbolCandles?: readonly DailyRangeAutoRouteCandle[];
    btcCandles?: readonly DailyRangeAutoRouteCandle[];
    ethCandles?: readonly DailyRangeAutoRouteCandle[];
    universeReturns1hAtDecision?: (decisionTimestampMs: number) => readonly number[];
  };
}): DailyRangeReconstructedCandidate[] {
  const ordered = [...input.candles].sort((a, b) => a.openTime - b.openTime);
  if (!contiguous(ordered, 5 * 60_000)) return [];
  let state = blankDailyRangeAutoRouteState();
  const results: DailyRangeReconstructedCandidate[] = [];
  for (const candle of ordered) {
    const transition = advanceDailyRangeAutoRoute({
      dateUtc: input.dateUtc,
      symbol: input.symbol,
      rangeHigh: input.rangeHigh,
      rangeLow: input.rangeLow,
      state,
      candle,
    });
    state = transition.state;
    const decision = transition.decision;
    if (!decision) continue;
    const decisionTimestampMs = decision.confirmationBar2.closeTime + 1;
    const structuralStop = decision.entryPolicy === "FADE"
      ? decision.breakoutExtreme
      : decision.direction === "LONG"
        ? Math.min(input.rangeHigh, decision.confirmationBar1.low, decision.confirmationBar2.low)
        : Math.max(input.rangeLow, decision.confirmationBar1.high, decision.confirmationBar2.high);
    const entry = decision.confirmationBar2.close;
    const risk = decision.direction === "LONG" ? entry - structuralStop : structuralStop - entry;
    if (!(risk > 0) || !(entry > 0)) continue;
    const takeProfit = decision.direction === "LONG" ? entry + 2 * risk : entry - 2 * risk;
    const candidate: DailyRangeReconstructedCandidate = {
      datasetClass: DAILY_RANGE_RECONSTRUCTED_CANDLE_PIT_DATASET_CLASS,
      researchEligibilityQuality: "CANDLE_ELIGIBLE_CURRENT_UNIVERSE",
      dateUtc: input.dateUtc,
      symbol: input.symbol,
      decision,
      rangeHigh: input.rangeHigh,
      rangeLow: input.rangeLow,
      decisionTimestampMs,
      structuralStop,
      takeProfit,
      features: {},
    };
    candidate.features = buildReconstructedDailyRangeFeatures({
      candidate,
      symbolCandles: input.featurePanel?.symbolCandles ?? ordered,
      btcCandles: input.featurePanel?.btcCandles,
      ethCandles: input.featurePanel?.ethCandles,
      universeReturns1h: input.featurePanel?.universeReturns1hAtDecision?.(decisionTimestampMs),
    });
    results.push(candidate);
  }
  return results;
}

/**
 * Resolve 2R/structural-stop paths with 1m OHLC. A candle touching both is
 * deliberately ambiguous: we never assume the favorable barrier won first.
 */
export function resolveReconstructedDailyRangeOutcome(
  candidate: DailyRangeReconstructedCandidate,
  minuteCandles: readonly DailyRangeAutoRouteCandle[],
): DailyRangeReconstructedResolvedCandidate {
  const entry = candidate.decision.confirmationBar2.close;
  const risk = Math.abs(entry - candidate.structuralStop);
  let mfeR = Number.NEGATIVE_INFINITY;
  let maeR = Number.POSITIVE_INFINITY;
  const ordered = [...minuteCandles]
    .filter((candle) => candle.openTime >= candidate.decisionTimestampMs)
    .sort((a, b) => a.openTime - b.openTime);
  for (const candle of ordered) {
    const favorable = candidate.decision.direction === "LONG" ? candle.high - entry : entry - candle.low;
    const adverse = candidate.decision.direction === "LONG" ? candle.low - entry : entry - candle.high;
    if (risk > 0) {
      mfeR = Math.max(mfeR, favorable / risk);
      maeR = Math.min(maeR, adverse / risk);
    }
    const tpHit = candidate.decision.direction === "LONG" ? candle.high >= candidate.takeProfit : candle.low <= candidate.takeProfit;
    const slHit = candidate.decision.direction === "LONG" ? candle.low <= candidate.structuralStop : candle.high >= candidate.structuralStop;
    if (!tpHit && !slHit) continue;
    const base = {
      ...candidate,
      outcomeTimestampMs: candle.closeTime + 1,
      mfeR: Number.isFinite(mfeR) ? mfeR : null,
      maeR: Number.isFinite(maeR) ? maeR : null,
      holdingDurationMs: Math.max(0, candle.closeTime + 1 - candidate.decisionTimestampMs),
    };
    if (tpHit && slHit) return { ...base, outcome: "OUTCOME_AMBIGUOUS" };
    return { ...base, outcome: tpHit ? "TP" : "SL" };
  }
  return {
    ...candidate,
    outcome: "UNRESOLVED",
    outcomeTimestampMs: null,
    mfeR: Number.isFinite(mfeR) ? mfeR : null,
    maeR: Number.isFinite(maeR) ? maeR : null,
    holdingDurationMs: null,
  };
}

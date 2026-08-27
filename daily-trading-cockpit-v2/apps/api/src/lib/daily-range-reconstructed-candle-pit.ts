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
import {
  DAILY_RANGE_ROUTE_EXIT_POLICY_ID,
  dailyRangeRouteExitPolicyForSignal,
  evaluateDailyRangeThesisInvalidation,
  type DailyRangeRouteExitPolicySnapshot,
  type DailyRangeThesisInvalidationReason,
} from "./daily-range-route-exit.js";

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
  exitPolicyId: typeof DAILY_RANGE_ROUTE_EXIT_POLICY_ID;
  tpMultipleR: 1 | 2;
  thesisInvalidationType: DailyRangeRouteExitPolicySnapshot["thesisInvalidationType"];
  originalBreakoutDirection: DailyRangeRouteExitPolicySnapshot["originalBreakoutDirection"];
  originalBreakoutBoundary: number;
  features: Record<string, number | null>;
}

export interface DailyRangeReconstructedResolvedCandidate extends DailyRangeReconstructedCandidate {
  outcome: DailyRangeReconstructedOutcome;
  outcomeTimestampMs: number | null;
  mfeR: number | null;
  maeR: number | null;
  holdingDurationMs: number | null;
}

/** Research-only terminal labels for an explicit V1-vs-legacy replay. */
export type DailyRangeRouteExitReplayOutcome =
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | DailyRangeThesisInvalidationReason
  | "OUTCOME_AMBIGUOUS"
  | "UNRESOLVED"
  | "UNAVAILABLE";

export interface DailyRangeRouteExitReplayLeg {
  exitPolicyId: "daily-route-exit-v1" | "legacy-global-2r-bracket";
  tpMultipleR: 1 | 2;
  outcome: DailyRangeRouteExitReplayOutcome;
  exitTimestampMs: number | null;
  /** Completed-5m close only for a logic-exit proxy; bracket exits use their barrier price. */
  exitPrice: number | null;
  grossR: number | null;
  ambiguityReason: string | null;
}

export interface DailyRangeRouteExitReplayDiagnostic {
  datasetClass: typeof DAILY_RANGE_RECONSTRUCTED_CANDLE_PIT_DATASET_CLASS;
  symbol: string;
  route: DailyRangeRouteExitPolicySnapshot["route"];
  newPolicy: DailyRangeRouteExitReplayLeg;
  legacyGlobal2R: DailyRangeRouteExitReplayLeg;
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
    const routeExitPolicy = dailyRangeRouteExitPolicyForSignal({
      route: decision.entryPolicy,
      originalBreakoutDirection: decision.breakoutDirection,
      rangeHigh: input.rangeHigh,
      rangeLow: input.rangeLow,
      effectiveAt: new Date(decisionTimestampMs).toISOString(),
    });
    if (!routeExitPolicy) continue;
    const takeProfit = decision.direction === "LONG"
      ? entry + routeExitPolicy.tpMultipleR * risk
      : entry - routeExitPolicy.tpMultipleR * risk;
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
      exitPolicyId: routeExitPolicy.exitPolicyId,
      tpMultipleR: routeExitPolicy.tpMultipleR,
      thesisInvalidationType: routeExitPolicy.thesisInvalidationType,
      originalBreakoutDirection: routeExitPolicy.originalBreakoutDirection,
      originalBreakoutBoundary: routeExitPolicy.originalBreakoutBoundary,
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
 * Resolve the frozen route-specific target/structural-stop paths with 1m OHLC. A candle touching both is
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

const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;

function replayBracketHit(input: {
  direction: "LONG" | "SHORT";
  candle: DailyRangeAutoRouteCandle;
  takeProfit: number;
  structuralStop: number;
}): "TAKE_PROFIT" | "STOP_LOSS" | "OUTCOME_AMBIGUOUS" | null {
  const tpHit = input.direction === "LONG"
    ? input.candle.high >= input.takeProfit
    : input.candle.low <= input.takeProfit;
  const slHit = input.direction === "LONG"
    ? input.candle.low <= input.structuralStop
    : input.candle.high >= input.structuralStop;
  if (!tpHit && !slHit) return null;
  return tpHit && slHit ? "OUTCOME_AMBIGUOUS" : tpHit ? "TAKE_PROFIT" : "STOP_LOSS";
}

function replayLeg(input: {
  policyId: "daily-route-exit-v1" | "legacy-global-2r-bracket";
  tpMultipleR: 1 | 2;
  direction: "LONG" | "SHORT";
  entry: number;
  structuralStop: number;
  takeProfit: number;
  minuteCandles: readonly DailyRangeAutoRouteCandle[];
  logicCandles?: readonly DailyRangeAutoRouteCandle[];
  routeExitPolicy?: DailyRangeRouteExitPolicySnapshot;
}): DailyRangeRouteExitReplayLeg {
  const risk = Math.abs(input.entry - input.structuralStop);
  const unresolved = (outcome: "UNRESOLVED" | "UNAVAILABLE", ambiguityReason: string | null = null): DailyRangeRouteExitReplayLeg => ({
    exitPolicyId: input.policyId,
    tpMultipleR: input.tpMultipleR,
    outcome,
    exitTimestampMs: null,
    exitPrice: null,
    grossR: null,
    ambiguityReason,
  });
  if (!(risk > 0) || !finite(input.entry) || !finite(input.takeProfit) || !finite(input.structuralStop)) return unresolved("UNAVAILABLE", "invalid frozen bracket");
  const minutes = [...input.minuteCandles]
    .filter((candle) => candle.openTime >= 0 && candle.closeTime === candle.openTime + ONE_MINUTE_MS - 1)
    .sort((left, right) => left.openTime - right.openTime);
  if (minutes.length === 0) return unresolved("UNRESOLVED");
  if (!contiguous(minutes, ONE_MINUTE_MS)) return unresolved("UNAVAILABLE", "gapped 1m native-bracket path");
  if (input.logicCandles && !input.routeExitPolicy) return unresolved("UNAVAILABLE", "missing route policy for completed 5m logical-exit path");
  if (input.logicCandles && !contiguous([...input.logicCandles].sort((left, right) => left.openTime - right.openTime), FIVE_MINUTES_MS)) {
    return unresolved("UNAVAILABLE", "gapped completed 5m logical-exit path");
  }
  const expectedMinutesByFive = new Map<number, DailyRangeAutoRouteCandle[]>();
  for (const minute of minutes) {
    const fiveOpen = Math.floor(minute.openTime / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const rows = expectedMinutesByFive.get(fiveOpen) ?? [];
    rows.push(minute);
    expectedMinutesByFive.set(fiveOpen, rows);
  }
  const logicRows = input.logicCandles ? [...input.logicCandles].sort((left, right) => left.openTime - right.openTime) : [];
  const logicByOpenTime = new Map(logicRows.map((candle) => [candle.openTime, candle]));
  const finish = (outcome: "TAKE_PROFIT" | "STOP_LOSS" | "OUTCOME_AMBIGUOUS" | DailyRangeThesisInvalidationReason, exitTimestampMs: number, exitPrice: number | null, ambiguityReason: string | null = null): DailyRangeRouteExitReplayLeg => ({
    exitPolicyId: input.policyId,
    tpMultipleR: input.tpMultipleR,
    outcome,
    exitTimestampMs,
    exitPrice,
    grossR: exitPrice === null ? null : (input.direction === "LONG" ? exitPrice - input.entry : input.entry - exitPrice) / risk,
    ambiguityReason,
  });

  // The legacy policy is a 1m native-bracket path only. It must not depend on
  // whether the final minute happens to complete a 5m logical-exit candle.
  if (!input.logicCandles) {
    for (const minute of minutes) {
      const hit = replayBracketHit({ direction: input.direction, candle: minute, takeProfit: input.takeProfit, structuralStop: input.structuralStop });
      if (!hit) continue;
      if (hit === "OUTCOME_AMBIGUOUS") return finish(hit, minute.closeTime + 1, null, "1m OHLC touched TP and structural SL in the same candle");
      return finish(hit, minute.closeTime + 1, hit === "TAKE_PROFIT" ? input.takeProfit : input.structuralStop);
    }
    return unresolved("UNRESOLVED");
  }

  // New V1 evaluates every native barrier opportunity first. A thesis exit is
  // considered only after a full, post-entry, canonical 5m candle completes.
  // A trailing partial group can still hit native protection, but cannot emit a
  // logical exit because it has not closed yet.
  const groups = [...expectedMinutesByFive.entries()]
    .sort(([left], [right]) => left - right)
    .map(([openTime, rows]) => ({ openTime, rows: rows.sort((left, right) => left.openTime - right.openTime) }));

  for (const five of groups) {
    for (const minute of five.rows) {
      const hit = replayBracketHit({ direction: input.direction, candle: minute, takeProfit: input.takeProfit, structuralStop: input.structuralStop });
      if (!hit) continue;
      if (hit === "OUTCOME_AMBIGUOUS") return finish(hit, minute.closeTime + 1, null, "1m OHLC touched TP and structural SL in the same candle");
      return finish(hit, minute.closeTime + 1, hit === "TAKE_PROFIT" ? input.takeProfit : input.structuralStop);
    }
    const hasFullCanonicalFiveMinutePath = five.rows.length === 5
      && five.rows.every((row, index) => row.openTime === five.openTime + index * ONE_MINUTE_MS);
    if (!hasFullCanonicalFiveMinutePath) continue;
    const logicCandle = logicByOpenTime.get(five.openTime);
    if (!logicCandle) return unresolved("UNAVAILABLE", `missing canonical completed 5m logical candle ${five.openTime}`);
    const decision = evaluateDailyRangeThesisInvalidation({ policy: input.routeExitPolicy!, candle: logicCandle });
    if (decision) return finish(decision.reason, logicCandle.closeTime + 1, logicCandle.close);
  }
  return unresolved("UNRESOLVED");
}

/**
 * Diagnostic-only causal replay of one frozen candidate. It evaluates the
 * deployed V1 route hypothesis and the former global-2R bracket separately;
 * it neither trains a selector nor searches alternative targets.
 */
export function replayRouteSpecificExitDiagnostic(input: {
  candidate: DailyRangeReconstructedCandidate;
  completedFiveMinuteCandles: readonly DailyRangeAutoRouteCandle[];
  completedOneMinuteCandles: readonly DailyRangeAutoRouteCandle[];
  /** The original frozen legacy 2R bracket, if the source episode retained it. */
  legacyTakeProfit?: number | null;
}): DailyRangeRouteExitReplayDiagnostic {
  const { candidate } = input;
  const entry = candidate.decision.confirmationBar2.close;
  const risk = Math.abs(entry - candidate.structuralStop);
  const legacyTarget = finite(input.legacyTakeProfit)
    ? input.legacyTakeProfit
    : candidate.decision.direction === "LONG" ? entry + 2 * risk : entry - 2 * risk;
  const policy: DailyRangeRouteExitPolicySnapshot = {
    exitPolicyId: candidate.exitPolicyId,
    route: candidate.decision.entryPolicy,
    tpMultipleR: candidate.tpMultipleR,
    thesisInvalidationType: candidate.thesisInvalidationType,
    effectiveAt: new Date(candidate.decisionTimestampMs).toISOString(),
    originalBreakoutDirection: candidate.originalBreakoutDirection,
    originalBreakoutBoundary: candidate.originalBreakoutBoundary,
    referenceRangeHigh: candidate.rangeHigh,
    referenceRangeLow: candidate.rangeLow,
  };
  const afterDecision5m = input.completedFiveMinuteCandles
    .filter((candle) => candle.openTime >= candidate.decisionTimestampMs && candle.closeTime < Number.MAX_SAFE_INTEGER)
    .sort((left, right) => left.openTime - right.openTime);
  const afterDecision1m = input.completedOneMinuteCandles
    .filter((candle) => candle.openTime >= candidate.decisionTimestampMs && candle.closeTime < Number.MAX_SAFE_INTEGER)
    .sort((left, right) => left.openTime - right.openTime);
  return {
    datasetClass: candidate.datasetClass,
    symbol: candidate.symbol,
    route: policy.route,
    newPolicy: replayLeg({
      policyId: "daily-route-exit-v1",
      tpMultipleR: policy.tpMultipleR,
      direction: candidate.decision.direction,
      entry,
      structuralStop: candidate.structuralStop,
      takeProfit: candidate.takeProfit,
      minuteCandles: afterDecision1m,
      logicCandles: afterDecision5m,
      routeExitPolicy: policy,
    }),
    legacyGlobal2R: replayLeg({
      policyId: "legacy-global-2r-bracket",
      tpMultipleR: 2,
      direction: candidate.decision.direction,
      entry,
      structuralStop: candidate.structuralStop,
      takeProfit: legacyTarget,
      minuteCandles: afterDecision1m,
    }),
  };
}

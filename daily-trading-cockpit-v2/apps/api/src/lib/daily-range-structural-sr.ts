/**
 * Daily 4H Range Structural S/R V1.
 *
 * This resolver is deliberately small, deterministic, and PIT-safe.  It does
 * not decide a route, change a stop, allocate capital, or submit an order.  It
 * only selects the next known profit-side level after the router and the
 * structural invalidation stop have already been fixed.
 */

export const DAILY_RANGE_STRUCTURAL_SR_POLICY_ID = "daily-structural-sr-v1" as const;
export const DAILY_RANGE_NEXT_SR_TARGET_POLICY_ID = "daily-next-sr-target-v1" as const;
/** FADE always completes the reclaim toward the opposite frozen 4H range boundary. */
export const DAILY_RANGE_FADE_OPPOSITE_RANGE_TARGET_POLICY_ID = "daily-fade-opposite-range-target-v1" as const;

const EPSILON = 1e-12;
const ONE_HOUR_MS = 60 * 60_000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;
const PIVOT_RADIUS = 2;

export type DailyRangeStructuralDirection = "LONG" | "SHORT";
export type DailyRangeStructuralRoute = "CONTINUATION" | "FADE" | "LEGACY_CONTINUATION";
export type DailyRangeStructuralLevelType =
  | "RANGE_HIGH"
  | "RANGE_LOW"
  | "SWING_HIGH"
  | "SWING_LOW"
  | "MAJOR_HIGH"
  | "MAJOR_LOW";
export type DailyRangeStructuralTargetSource =
  | "RANGE_OPPOSITE_BOUNDARY"
  | "CONFIRMED_1H_SWING_HIGH"
  | "CONFIRMED_1H_SWING_LOW"
  | "CONFIRMED_4H_MAJOR_HIGH"
  | "CONFIRMED_4H_MAJOR_LOW";
export type DailyRangeStructuralStopSource =
  | "FAILED_BREAKOUT_EXTREME"
  | "FAILED_BREAKOUT_SWEEP_BUFFER"
  | "FLIPPED_RANGE_RETEST";

export interface DailyRangeStructuralCandle {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
  close: number;
}

export interface DailyRangeStructuralTarget {
  target: number;
  targetSource: DailyRangeStructuralTargetSource;
  targetLevelType: DailyRangeStructuralLevelType;
  targetSourceTimeframe: "RANGE" | "1h" | "4h";
  /** The exact time at which the level was knowable, never the decision time. */
  confirmedAt: string;
  sourceOpenTime: number | null;
}

export type DailyRangeStructuralTargetResolution =
  | { ok: true; target: DailyRangeStructuralTarget; candidatesConsidered: number }
  | {
    ok: false;
    reason: "STRUCTURAL_TARGET_INVALID" | "STRUCTURAL_TARGET_UNAVAILABLE";
    candidatesConsidered: number;
  };

interface CandidateLevel extends DailyRangeStructuralTarget {
  role: "SUPPORT" | "RESISTANCE";
  sourcePriority: number;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The FADE target is intentionally not a nearest pivot. Once price has
 * re-entered the frozen 4H range, its native objective is the other side of
 * that same range. This remains pure/PIT-safe because the range was already
 * known before the 5m decision candle closed.
 */
export function dailyRangeFadeOppositeRangeTarget(input: {
  direction: DailyRangeStructuralDirection;
  rangeHigh: number;
  rangeLow: number;
  referenceRangeCloseTime: number | null | undefined;
  decisionAtMs: number;
}): DailyRangeStructuralTarget | null {
  if ((input.direction !== "LONG" && input.direction !== "SHORT")
    || !finitePositive(input.rangeHigh)
    || !finitePositive(input.rangeLow)
    || input.rangeHigh < input.rangeLow
    || !Number.isFinite(input.decisionAtMs)
    || input.decisionAtMs <= 0) return null;
  const confirmedAtMs = Number.isFinite(input.referenceRangeCloseTime)
    ? Math.min(input.decisionAtMs, Number(input.referenceRangeCloseTime))
    : input.decisionAtMs;
  const long = input.direction === "LONG";
  return {
    target: long ? input.rangeHigh : input.rangeLow,
    targetSource: "RANGE_OPPOSITE_BOUNDARY",
    targetLevelType: long ? "RANGE_HIGH" : "RANGE_LOW",
    targetSourceTimeframe: "RANGE",
    confirmedAt: new Date(confirmedAtMs).toISOString(),
    sourceOpenTime: null,
  };
}

function canonicalClosedCandles(
  candles: readonly DailyRangeStructuralCandle[],
  timeframeMs: number,
  decisionAtMs: number,
): DailyRangeStructuralCandle[] {
  const byOpen = new Map<number, DailyRangeStructuralCandle>();
  for (const candle of candles) {
    if (!Number.isFinite(candle.openTime)
      || !Number.isFinite(candle.closeTime)
      || !finitePositive(candle.high)
      || !finitePositive(candle.low)
      || !finitePositive(candle.close)
      || candle.high < candle.low
      || candle.closeTime !== candle.openTime + timeframeMs - 1
      || candle.closeTime >= decisionAtMs) continue;
    byOpen.set(candle.openTime, candle);
  }
  return [...byOpen.values()].sort((left, right) => left.openTime - right.openTime);
}

function hasContiguousWindow(candles: readonly DailyRangeStructuralCandle[], index: number, timeframeMs: number): boolean {
  for (let offset = -PIVOT_RADIUS; offset < PIVOT_RADIUS; offset++) {
    const left = candles[index + offset];
    const right = candles[index + offset + 1];
    if (!left || !right || right.openTime !== left.openTime + timeframeMs) return false;
  }
  return true;
}

function pivotLevels(input: {
  candles: readonly DailyRangeStructuralCandle[];
  timeframeMs: number;
  decisionAtMs: number;
  sourceTimeframe: "1h" | "4h";
}): CandidateLevel[] {
  const candles = canonicalClosedCandles(input.candles, input.timeframeMs, input.decisionAtMs);
  const levels: CandidateLevel[] = [];
  for (let index = PIVOT_RADIUS; index + PIVOT_RADIUS < candles.length; index++) {
    if (!hasContiguousWindow(candles, index, input.timeframeMs)) continue;
    const center = candles[index]!;
    const confirmation = candles[index + PIVOT_RADIUS]!;
    const confirmedAtMs = confirmation.closeTime + 1;
    if (confirmedAtMs > input.decisionAtMs) continue;
    const neighbours = candles.slice(index - PIVOT_RADIUS, index + PIVOT_RADIUS + 1);
    const isHigh = neighbours.every((candle, neighbourIndex) => neighbourIndex === PIVOT_RADIUS || center.high > candle.high + EPSILON);
    const isLow = neighbours.every((candle, neighbourIndex) => neighbourIndex === PIVOT_RADIUS || center.low < candle.low - EPSILON);
    if (isHigh) {
      levels.push({
        target: center.high,
        targetSource: input.sourceTimeframe === "1h" ? "CONFIRMED_1H_SWING_HIGH" : "CONFIRMED_4H_MAJOR_HIGH",
        targetLevelType: input.sourceTimeframe === "1h" ? "SWING_HIGH" : "MAJOR_HIGH",
        targetSourceTimeframe: input.sourceTimeframe,
        confirmedAt: new Date(confirmedAtMs).toISOString(),
        sourceOpenTime: center.openTime,
        role: "RESISTANCE",
        sourcePriority: input.sourceTimeframe === "1h" ? 1 : 2,
      });
    }
    if (isLow) {
      levels.push({
        target: center.low,
        targetSource: input.sourceTimeframe === "1h" ? "CONFIRMED_1H_SWING_LOW" : "CONFIRMED_4H_MAJOR_LOW",
        targetLevelType: input.sourceTimeframe === "1h" ? "SWING_LOW" : "MAJOR_LOW",
        targetSourceTimeframe: input.sourceTimeframe,
        confirmedAt: new Date(confirmedAtMs).toISOString(),
        sourceOpenTime: center.openTime,
        role: "SUPPORT",
        sourcePriority: input.sourceTimeframe === "1h" ? 1 : 2,
      });
    }
  }
  return levels;
}

function uniqueLevels(levels: readonly CandidateLevel[]): CandidateLevel[] {
  const byKey = new Map<string, CandidateLevel>();
  for (const level of levels) {
    if (!finitePositive(level.target)) continue;
    const key = `${level.role}:${level.target.toPrecision(14)}`;
    const prior = byKey.get(key);
    if (!prior
      || level.sourcePriority < prior.sourcePriority
      || (level.sourcePriority === prior.sourcePriority && level.confirmedAt < prior.confirmedAt)
      || (level.sourcePriority === prior.sourcePriority && level.confirmedAt === prior.confirmedAt
        && (level.sourceOpenTime ?? Number.MAX_SAFE_INTEGER) < (prior.sourceOpenTime ?? Number.MAX_SAFE_INTEGER))) {
      byKey.set(key, level);
    }
  }
  return [...byKey.values()];
}

/**
 * Select the closest pre-existing support/resistance in the profit direction.
 * A target cannot be moved to a synthetic 2R, percentage, or ATR distance.
 */
export function resolveDailyRangeStructuralTarget(input: {
  direction: DailyRangeStructuralDirection;
  route: DailyRangeStructuralRoute;
  expectedEntry: number;
  rangeHigh: number;
  rangeLow: number;
  referenceRangeCloseTime: number | null | undefined;
  decisionAtMs: number;
  oneHourCandles: readonly DailyRangeStructuralCandle[];
  fourHourCandles: readonly DailyRangeStructuralCandle[];
}): DailyRangeStructuralTargetResolution {
  if (!finitePositive(input.expectedEntry)
    || !finitePositive(input.rangeHigh)
    || !finitePositive(input.rangeLow)
    || input.rangeHigh < input.rangeLow
    || !Number.isFinite(input.decisionAtMs)
    || input.decisionAtMs <= 0) {
    return { ok: false, reason: "STRUCTURAL_TARGET_UNAVAILABLE", candidatesConsidered: 0 };
  }
  if (input.route === "FADE") {
    const target = dailyRangeFadeOppositeRangeTarget(input);
    if (!target) return { ok: false, reason: "STRUCTURAL_TARGET_UNAVAILABLE", candidatesConsidered: 0 };
    const onProfitSide = input.direction === "LONG"
      ? target.target > input.expectedEntry + EPSILON
      : target.target < input.expectedEntry - EPSILON;
    return onProfitSide
      ? { ok: true, target, candidatesConsidered: 1 }
      : { ok: false, reason: "STRUCTURAL_TARGET_INVALID", candidatesConsidered: 1 };
  }
  const rangeConfirmedAtMs = Number.isFinite(input.referenceRangeCloseTime)
    ? Math.min(input.decisionAtMs, Number(input.referenceRangeCloseTime))
    : input.decisionAtMs;
  const levels: CandidateLevel[] = [
    {
      target: input.rangeHigh,
      targetSource: "RANGE_OPPOSITE_BOUNDARY",
      targetLevelType: "RANGE_HIGH",
      targetSourceTimeframe: "RANGE",
      confirmedAt: new Date(rangeConfirmedAtMs).toISOString(),
      sourceOpenTime: null,
      role: "RESISTANCE",
      sourcePriority: 0,
    },
    {
      target: input.rangeLow,
      targetSource: "RANGE_OPPOSITE_BOUNDARY",
      targetLevelType: "RANGE_LOW",
      targetSourceTimeframe: "RANGE",
      confirmedAt: new Date(rangeConfirmedAtMs).toISOString(),
      sourceOpenTime: null,
      role: "SUPPORT",
      sourcePriority: 0,
    },
    ...pivotLevels({
      candles: input.oneHourCandles,
      timeframeMs: ONE_HOUR_MS,
      decisionAtMs: input.decisionAtMs,
      sourceTimeframe: "1h",
    }),
    ...pivotLevels({
      candles: input.fourHourCandles,
      timeframeMs: FOUR_HOURS_MS,
      decisionAtMs: input.decisionAtMs,
      sourceTimeframe: "4h",
    }),
  ];
  const candidates = uniqueLevels(levels);
  const role = input.direction === "LONG" ? "RESISTANCE" : "SUPPORT";
  const sideCandidates = candidates.filter((level) => level.role === role);
  const valid = sideCandidates.filter((level) => input.direction === "LONG"
    ? level.target > input.expectedEntry + EPSILON
    : level.target < input.expectedEntry - EPSILON,
  );
  if (valid.length === 0) {
    return {
      ok: false,
      reason: sideCandidates.length > 0 ? "STRUCTURAL_TARGET_INVALID" : "STRUCTURAL_TARGET_UNAVAILABLE",
      candidatesConsidered: candidates.length,
    };
  }
  valid.sort((left, right) => {
    const leftDistance = Math.abs(left.target - input.expectedEntry);
    const rightDistance = Math.abs(right.target - input.expectedEntry);
    return leftDistance - rightDistance
      || left.sourcePriority - right.sourcePriority
      || left.confirmedAt.localeCompare(right.confirmedAt)
      || (left.sourceOpenTime ?? Number.MAX_SAFE_INTEGER) - (right.sourceOpenTime ?? Number.MAX_SAFE_INTEGER)
      || left.targetLevelType.localeCompare(right.targetLevelType);
  });
  const target = valid[0]!;
  return {
    ok: true,
    target: {
      target: target.target,
      targetSource: target.targetSource,
      targetLevelType: target.targetLevelType,
      targetSourceTimeframe: target.targetSourceTimeframe,
      confirmedAt: target.confirmedAt,
      sourceOpenTime: target.sourceOpenTime,
    },
    candidatesConsidered: candidates.length,
  };
}

export function dailyRangeStructuralStopSource(
  route: DailyRangeStructuralRoute,
  fadeUsesSweepBuffer = false,
): DailyRangeStructuralStopSource {
  if (route !== "FADE") return "FLIPPED_RANGE_RETEST";
  return fadeUsesSweepBuffer ? "FAILED_BREAKOUT_SWEEP_BUFFER" : "FAILED_BREAKOUT_EXTREME";
}

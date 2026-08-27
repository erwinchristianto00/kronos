/**
 * Daily Range V1 route-specific exit policy.
 *
 * This module is deliberately pure. It owns no exchange state and has no
 * allocation authority; the lane persists the returned snapshot before entry
 * and evaluates its completed-candle invalidation through the canonical safe
 * flatten path.
 */
import {
  dailyRangeAutoRouteRangePosition,
  type DailyRangeAutoRouteDirection,
  type DailyRangeAutoRouteRangePosition,
} from "./daily-range-auto-route.js";

export const DAILY_RANGE_ROUTE_EXIT_POLICY_ID = "daily-route-exit-v1" as const;

export type DailyRangeRouteExitRoute = "CONTINUATION" | "FADE";
export type DailyRangeThesisInvalidationType = "RANGE_REENTRY" | "ORIGINAL_BREAKOUT_REACCEPTANCE";
export type DailyRangeThesisInvalidationReason =
  | "CONTINUATION_RANGE_REENTRY_EXIT"
  | "FADE_BREAKOUT_REACCEPTANCE_EXIT";

/** Frozen on a new AUTO_ROUTE_NY_V2 signal and copied verbatim to its trade. */
export interface DailyRangeRouteExitPolicySnapshot {
  exitPolicyId: typeof DAILY_RANGE_ROUTE_EXIT_POLICY_ID;
  route: DailyRangeRouteExitRoute;
  tpMultipleR: 1 | 2;
  thesisInvalidationType: DailyRangeThesisInvalidationType;
  effectiveAt: string;
  originalBreakoutDirection: DailyRangeAutoRouteDirection;
  originalBreakoutBoundary: number;
  referenceRangeHigh: number;
  referenceRangeLow: number;
}

export interface DailyRangeThesisInvalidationDecision {
  reason: DailyRangeThesisInvalidationReason;
  candleOpenTime: number;
  candleCloseTime: number;
  candleClose: number;
  referenceBoundary: number;
  /** Signed toward the original breakout direction: positive is outside. */
  distanceFromBoundary: number;
  rangePosition: DailyRangeAutoRouteRangePosition;
}

export function dailyRangeTpMultipleForRoute(route: string | null | undefined): 1 | 2 {
  return route === "CONTINUATION" ? 1 : 2;
}

export function dailyRangeRouteExitPolicyForSignal(input: {
  route: string | null | undefined;
  originalBreakoutDirection: DailyRangeAutoRouteDirection | null | undefined;
  rangeHigh: number;
  rangeLow: number;
  effectiveAt: string;
}): DailyRangeRouteExitPolicySnapshot | null {
  if ((input.route !== "CONTINUATION" && input.route !== "FADE")
    || (input.originalBreakoutDirection !== "UP" && input.originalBreakoutDirection !== "DOWN")
    || !Number.isFinite(input.rangeHigh)
    || !Number.isFinite(input.rangeLow)
    || input.rangeHigh < input.rangeLow
    || !input.effectiveAt) return null;
  const route = input.route;
  const originalBreakoutDirection = input.originalBreakoutDirection;
  return {
    exitPolicyId: DAILY_RANGE_ROUTE_EXIT_POLICY_ID,
    route,
    tpMultipleR: dailyRangeTpMultipleForRoute(route),
    thesisInvalidationType: route === "CONTINUATION" ? "RANGE_REENTRY" : "ORIGINAL_BREAKOUT_REACCEPTANCE",
    effectiveAt: input.effectiveAt,
    originalBreakoutDirection,
    originalBreakoutBoundary: originalBreakoutDirection === "UP" ? input.rangeHigh : input.rangeLow,
    referenceRangeHigh: input.rangeHigh,
    referenceRangeLow: input.rangeLow,
  };
}

export function isDailyRangeRouteExitV1(
  policy: DailyRangeRouteExitPolicySnapshot | null | undefined,
): policy is DailyRangeRouteExitPolicySnapshot {
  return policy?.exitPolicyId === DAILY_RANGE_ROUTE_EXIT_POLICY_ID;
}

/**
 * Evaluate only a completed five-minute close. Callers must never invoke this
 * from a tick, wick, mark, or incomplete candle.
 */
export function evaluateDailyRangeThesisInvalidation(input: {
  policy: DailyRangeRouteExitPolicySnapshot;
  candle: { openTime: number; closeTime: number; close: number };
}): DailyRangeThesisInvalidationDecision | null {
  const { policy, candle } = input;
  if (!Number.isFinite(candle.openTime) || !Number.isFinite(candle.closeTime) || !Number.isFinite(candle.close)) return null;
  const rangePosition = dailyRangeAutoRouteRangePosition(
    candle.close,
    policy.referenceRangeHigh,
    policy.referenceRangeLow,
  );
  const distanceFromBoundary = policy.originalBreakoutDirection === "UP"
    ? candle.close - policy.originalBreakoutBoundary
    : policy.originalBreakoutBoundary - candle.close;
  const invalidated = policy.route === "CONTINUATION"
    ? rangePosition === "INSIDE"
    : policy.originalBreakoutDirection === "UP"
      ? rangePosition === "ABOVE"
      : rangePosition === "BELOW";
  if (!invalidated) return null;
  return {
    reason: policy.route === "CONTINUATION"
      ? "CONTINUATION_RANGE_REENTRY_EXIT"
      : "FADE_BREAKOUT_REACCEPTANCE_EXIT",
    candleOpenTime: candle.openTime,
    candleCloseTime: candle.closeTime,
    candleClose: candle.close,
    referenceBoundary: policy.originalBreakoutBoundary,
    distanceFromBoundary,
    rangePosition,
  };
}

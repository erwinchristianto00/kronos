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
import { DAILY_RANGE_FADE_OPPOSITE_RANGE_TARGET_POLICY_ID } from "./daily-range-structural-sr.js";

export const DAILY_RANGE_ROUTE_EXIT_POLICY_ID = "daily-route-exit-v1" as const;
/** Fade trades are bracket-only: structural native SL plus native 2R TP. */
export const DAILY_RANGE_FADE_BRACKET_ONLY_EXIT_POLICY_ID = "daily-route-exit-v3-fade-bracket-only" as const;
/** Structural S/R V1: no fixed-R target; only continuation owns a thesis invalidation. */
export const DAILY_RANGE_STRUCTURAL_SR_ROUTE_EXIT_POLICY_ID = "daily-route-exit-structural-sr-v1" as const;
/** Structural S/R fade successor: native structural stop/target only, never a breakout re-acceptance flatten. */
export const DAILY_RANGE_STRUCTURAL_SR_FADE_NO_REACCEPTANCE_EXIT_POLICY_ID = "daily-route-exit-structural-sr-v2-fade-no-reacceptance" as const;
/** New FADE contract: breakout-extreme stop, native fixed 2R TP, R-based MFE trail. */
export const DAILY_RANGE_FADE_EXTREME_2R_R30_EXIT_POLICY_ID = "daily-route-exit-v4-fade-extreme-2r-r30" as const;
/** New FADE contract: breakout-extreme stop, opposite frozen 4H boundary TP, R-based MFE trail. */
export const DAILY_RANGE_FADE_EXTREME_OPPOSITE_RANGE_EXIT_POLICY_ID = "daily-route-exit-v5-fade-extreme-opposite-range" as const;
/**
 * Testnet-only V5 FADE cohort. Native stop/target and R30 trail stay exactly
 * the V5 contract; the added logical exit is only a completed 1m close back
 * outside the frozen range in the original breakout direction.
 */
export const DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_SOFT_EXIT_POLICY_ID = "daily-route-exit-v5-fade-genuine-breakout-filter-soft-v1" as const;

export type DailyRangeRouteExitRoute = "CONTINUATION" | "FADE";
/** Only the explicit V4 Testnet cohort may select the fixed-target mode. */
export type DailyRangeFadeTargetMode = "OPPOSITE_RANGE" | "FIXED_2R_R30";
/** `ORIGINAL_BREAKOUT_REACCEPTANCE` is retained solely for frozen V1 history. */
export type DailyRangeThesisInvalidationType =
  | "RANGE_REENTRY"
  | "ORIGINAL_BREAKOUT_REACCEPTANCE"
  | "FADE_SOFT_BREAKOUT_CLOSE_1M"
  | "NONE";
export type DailyRangeThesisInvalidationReason =
  | "CONTINUATION_RANGE_REENTRY_EXIT"
  | "FADE_BREAKOUT_REACCEPTANCE_EXIT"
  | "FADE_SOFT_INVALIDATION";

/** Frozen on a new AUTO_ROUTE_NY_V2 signal and copied verbatim to its trade. */
export interface DailyRangeRouteExitPolicySnapshot {
  exitPolicyId:
    | typeof DAILY_RANGE_ROUTE_EXIT_POLICY_ID
    | typeof DAILY_RANGE_FADE_BRACKET_ONLY_EXIT_POLICY_ID
    | typeof DAILY_RANGE_STRUCTURAL_SR_ROUTE_EXIT_POLICY_ID
    | typeof DAILY_RANGE_STRUCTURAL_SR_FADE_NO_REACCEPTANCE_EXIT_POLICY_ID
    | typeof DAILY_RANGE_FADE_EXTREME_2R_R30_EXIT_POLICY_ID
    | typeof DAILY_RANGE_FADE_EXTREME_OPPOSITE_RANGE_EXIT_POLICY_ID
    | typeof DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_SOFT_EXIT_POLICY_ID;
  route: DailyRangeRouteExitRoute;
  /** 0 means this policy uses its separately persisted structural S/R target. */
  tpMultipleR: number;
  targetPolicyId?: "daily-next-sr-target-v1" | typeof DAILY_RANGE_FADE_OPPOSITE_RANGE_TARGET_POLICY_ID | null;
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
  structuralSrEnabled?: boolean;
  /** Only fresh FADE signals opt into the breakout-extreme/R-trail contract. */
  fadeExtreme2RR30Enabled?: boolean;
  /** Defaults to the deployed opposite-range V5 target. */
  fadeTargetMode?: DailyRangeFadeTargetMode;
  /** Explicit Testnet V5 cohort only; it cannot alter a fixed-2R policy. */
  fadeSoftInvalidationEnabled?: boolean;
}): DailyRangeRouteExitPolicySnapshot | null {
  if ((input.route !== "CONTINUATION" && input.route !== "FADE")
    || (input.originalBreakoutDirection !== "UP" && input.originalBreakoutDirection !== "DOWN")
    || !Number.isFinite(input.rangeHigh)
    || !Number.isFinite(input.rangeLow)
    || input.rangeHigh < input.rangeLow
    || !input.effectiveAt) return null;
  const route = input.route;
  const originalBreakoutDirection = input.originalBreakoutDirection;
  if (input.structuralSrEnabled && route === "FADE" && input.fadeExtreme2RR30Enabled) {
    if (input.fadeTargetMode === "FIXED_2R_R30") {
      return {
        exitPolicyId: DAILY_RANGE_FADE_EXTREME_2R_R30_EXIT_POLICY_ID,
        route,
        tpMultipleR: 2,
        targetPolicyId: null,
        thesisInvalidationType: "NONE",
        effectiveAt: input.effectiveAt,
        originalBreakoutDirection,
        originalBreakoutBoundary: originalBreakoutDirection === "UP" ? input.rangeHigh : input.rangeLow,
        referenceRangeHigh: input.rangeHigh,
        referenceRangeLow: input.rangeLow,
      };
    }
    const softInvalidation = input.fadeSoftInvalidationEnabled === true;
    return {
      exitPolicyId: softInvalidation
        ? DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_SOFT_EXIT_POLICY_ID
        : DAILY_RANGE_FADE_EXTREME_OPPOSITE_RANGE_EXIT_POLICY_ID,
      route,
      tpMultipleR: 0,
      targetPolicyId: DAILY_RANGE_FADE_OPPOSITE_RANGE_TARGET_POLICY_ID,
      thesisInvalidationType: softInvalidation ? "FADE_SOFT_BREAKOUT_CLOSE_1M" : "NONE",
      effectiveAt: input.effectiveAt,
      originalBreakoutDirection,
      originalBreakoutBoundary: originalBreakoutDirection === "UP" ? input.rangeHigh : input.rangeLow,
      referenceRangeHigh: input.rangeHigh,
      referenceRangeLow: input.rangeLow,
    };
  }
  if (input.structuralSrEnabled) {
    return {
      exitPolicyId: route === "FADE"
        ? DAILY_RANGE_STRUCTURAL_SR_FADE_NO_REACCEPTANCE_EXIT_POLICY_ID
        : DAILY_RANGE_STRUCTURAL_SR_ROUTE_EXIT_POLICY_ID,
      route,
      tpMultipleR: 0,
      targetPolicyId: "daily-next-sr-target-v1",
      thesisInvalidationType: route === "CONTINUATION" ? "RANGE_REENTRY" : "NONE",
      effectiveAt: input.effectiveAt,
      originalBreakoutDirection,
      originalBreakoutBoundary: originalBreakoutDirection === "UP" ? input.rangeHigh : input.rangeLow,
      referenceRangeHigh: input.rangeHigh,
      referenceRangeLow: input.rangeLow,
    };
  }
  return {
    exitPolicyId: route === "FADE"
      ? DAILY_RANGE_FADE_BRACKET_ONLY_EXIT_POLICY_ID
      : DAILY_RANGE_ROUTE_EXIT_POLICY_ID,
    route,
    tpMultipleR: dailyRangeTpMultipleForRoute(route),
    thesisInvalidationType: route === "CONTINUATION" ? "RANGE_REENTRY" : "NONE",
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

export function isDailyRangeFadeExtreme2RR30ExitPolicy(
  policy: DailyRangeRouteExitPolicySnapshot | null | undefined,
): policy is DailyRangeRouteExitPolicySnapshot {
  return policy?.exitPolicyId === DAILY_RANGE_FADE_EXTREME_2R_R30_EXIT_POLICY_ID;
}

export function isDailyRangeFadeExtremeOppositeRangeExitPolicy(
  policy: DailyRangeRouteExitPolicySnapshot | null | undefined,
): policy is DailyRangeRouteExitPolicySnapshot {
  return policy?.exitPolicyId === DAILY_RANGE_FADE_EXTREME_OPPOSITE_RANGE_EXIT_POLICY_ID
    || policy?.exitPolicyId === DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_SOFT_EXIT_POLICY_ID;
}

export function isDailyRangeFadeGenuineBreakoutFilterSoftInvalidationExitPolicy(
  policy: DailyRangeRouteExitPolicySnapshot | null | undefined,
): policy is DailyRangeRouteExitPolicySnapshot {
  return policy?.exitPolicyId === DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_SOFT_EXIT_POLICY_ID
    && policy.thesisInvalidationType === "FADE_SOFT_BREAKOUT_CLOSE_1M";
}

/** V4 rows remain frozen; both V4 and V5 retain the existing R-trail behavior. */
export function isDailyRangeFadeRTrailExitPolicy(
  policy: DailyRangeRouteExitPolicySnapshot | null | undefined,
): policy is DailyRangeRouteExitPolicySnapshot {
  return isDailyRangeFadeExtreme2RR30ExitPolicy(policy)
    || isDailyRangeFadeExtremeOppositeRangeExitPolicy(policy);
}

/** Every policy is frozen onto its trade; only some opt into a candle exit. */
export function isDailyRangeRouteExitPolicy(
  policy: DailyRangeRouteExitPolicySnapshot | null | undefined,
): policy is DailyRangeRouteExitPolicySnapshot {
  return policy?.exitPolicyId === DAILY_RANGE_ROUTE_EXIT_POLICY_ID
    || policy?.exitPolicyId === DAILY_RANGE_FADE_BRACKET_ONLY_EXIT_POLICY_ID
    || policy?.exitPolicyId === DAILY_RANGE_STRUCTURAL_SR_ROUTE_EXIT_POLICY_ID
    || policy?.exitPolicyId === DAILY_RANGE_STRUCTURAL_SR_FADE_NO_REACCEPTANCE_EXIT_POLICY_ID
    || policy?.exitPolicyId === DAILY_RANGE_FADE_EXTREME_2R_R30_EXIT_POLICY_ID
    || policy?.exitPolicyId === DAILY_RANGE_FADE_EXTREME_OPPOSITE_RANGE_EXIT_POLICY_ID
    || policy?.exitPolicyId === DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_SOFT_EXIT_POLICY_ID;
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
  // The historical FADE_BREAKOUT_REACCEPTANCE_EXIT is intentionally retired.
  // Old rows remain readable, but even a persisted pre-cutover policy can no
  // longer submit a logical flatten. Fade retains only its native stop/target.
  if (policy.thesisInvalidationType !== "RANGE_REENTRY") return null;
  const rangePosition = dailyRangeAutoRouteRangePosition(
    candle.close,
    policy.referenceRangeHigh,
    policy.referenceRangeLow,
  );
  const distanceFromBoundary = policy.originalBreakoutDirection === "UP"
    ? candle.close - policy.originalBreakoutBoundary
    : policy.originalBreakoutBoundary - candle.close;
  const invalidated = rangePosition === "INSIDE";
  if (!invalidated) return null;
  return {
    reason: "CONTINUATION_RANGE_REENTRY_EXIT",
    candleOpenTime: candle.openTime,
    candleCloseTime: candle.closeTime,
    candleClose: candle.close,
    referenceBoundary: policy.originalBreakoutBoundary,
    distanceFromBoundary,
    rangePosition,
  };
}

/**
 * The Testnet-only FADE soft invalidation is deliberately close-only. A wick,
 * tick, mark, book price, or incomplete 1m candle can never flatten a trade.
 */
export function evaluateDailyRangeFadeSoftInvalidation(input: {
  policy: DailyRangeRouteExitPolicySnapshot;
  candle: { openTime: number; closeTime: number; close: number };
}): DailyRangeThesisInvalidationDecision | null {
  const { policy, candle } = input;
  if (!isDailyRangeFadeGenuineBreakoutFilterSoftInvalidationExitPolicy(policy)
    || !Number.isFinite(candle.openTime)
    || !Number.isFinite(candle.closeTime)
    || !Number.isFinite(candle.close)) return null;
  const distanceFromBoundary = policy.originalBreakoutDirection === "UP"
    ? candle.close - policy.originalBreakoutBoundary
    : policy.originalBreakoutBoundary - candle.close;
  if (!(distanceFromBoundary > 0)) return null;
  return {
    reason: "FADE_SOFT_INVALIDATION",
    candleOpenTime: candle.openTime,
    candleCloseTime: candle.closeTime,
    candleClose: candle.close,
    referenceBoundary: policy.originalBreakoutBoundary,
    distanceFromBoundary,
    rangePosition: policy.originalBreakoutDirection === "UP" ? "ABOVE" : "BELOW",
  };
}

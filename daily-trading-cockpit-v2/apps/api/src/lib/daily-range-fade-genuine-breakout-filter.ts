import { createHash } from "node:crypto";

/**
 * Testnet-only V5 FADE experiment.  This module is deliberately pure: it
 * classifies a frozen signal but owns neither an exchange client nor order
 * authority.  The Daily Range lane persists the snapshot and remains solely
 * responsible for reduce-only execution.
 */
export const DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_POLICY_ID = "daily-fade-genuine-breakout-filter-v1" as const;
export const DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_VARIANT = "FILTER_PLUS_SOFT_INVALIDATION" as const;
/** A sweep this large relative to the frozen NY 4H range is not faded. */
export const DAILY_RANGE_FADE_GENUINE_BREAKOUT_MAX_EXTENSION_OF_RANGE = 0.15;
const THRESHOLD_EPSILON = 1e-12;

export interface DailyRangeFadeGenuineBreakoutFilterSnapshot {
  policyId: typeof DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_POLICY_ID;
  variant: typeof DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_VARIANT;
  activationAt: string;
  activationAtMs: number;
  sweepExtensionOfRangeRejectAtOrAbove: number;
  softInvalidationEnabled: true;
  nativeStopPolicy: "SWEEP_EXTREME_PLUS_15PCT_EXTENSION_BUFFER_OR_100BPS_FILL_FLOOR";
  nativeTargetPolicy: "OPPOSITE_4H_RANGE_BOUNDARY";
  trailPolicy: "daily-fade-r30-floor25-v2";
  fingerprint: string;
}

export interface DailyRangeFadeGenuineBreakoutFilterDecision {
  policyId: typeof DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_POLICY_ID;
  fingerprint: string;
  activationAt: string;
  status: "ACCEPTED" | "REJECTED_GENUINE_BREAKOUT_EXTENSION" | "REJECTED_PRE_ACTIVATION" | "REJECTED_INVALID_INPUT";
  rangeWidth: number | null;
  sweepExtensionPrice: number | null;
  sweepExtensionOfRange: number | null;
  threshold: number;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createDailyRangeFadeGenuineBreakoutFilterSnapshot(input: {
  activationAt: string;
}): DailyRangeFadeGenuineBreakoutFilterSnapshot {
  const activationAtMs = Date.parse(input.activationAt);
  if (!Number.isFinite(activationAtMs)) throw new Error("Daily Range FADE breakout-filter activation timestamp is invalid");
  const activationAt = new Date(activationAtMs).toISOString();
  const canonical = JSON.stringify({
    policyId: DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_POLICY_ID,
    variant: DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_VARIANT,
    activationAt,
    sweepExtensionOfRangeRejectAtOrAbove: DAILY_RANGE_FADE_GENUINE_BREAKOUT_MAX_EXTENSION_OF_RANGE,
    softInvalidationEnabled: true,
    nativeStopPolicy: "SWEEP_EXTREME_PLUS_15PCT_EXTENSION_BUFFER_OR_100BPS_FILL_FLOOR",
    nativeTargetPolicy: "OPPOSITE_4H_RANGE_BOUNDARY",
    trailPolicy: "daily-fade-r30-floor25-v2",
  });
  return {
    policyId: DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_POLICY_ID,
    variant: DAILY_RANGE_FADE_GENUINE_BREAKOUT_FILTER_VARIANT,
    activationAt,
    activationAtMs,
    sweepExtensionOfRangeRejectAtOrAbove: DAILY_RANGE_FADE_GENUINE_BREAKOUT_MAX_EXTENSION_OF_RANGE,
    softInvalidationEnabled: true,
    nativeStopPolicy: "SWEEP_EXTREME_PLUS_15PCT_EXTENSION_BUFFER_OR_100BPS_FILL_FLOOR",
    nativeTargetPolicy: "OPPOSITE_4H_RANGE_BOUNDARY",
    trailPolicy: "daily-fade-r30-floor25-v2",
    fingerprint: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
  };
}

/**
 * Uses only facts frozen no later than the completed re-acceptance bar.  A
 * positive extension is measured toward the original breakout, never toward
 * the FADE trade direction.
 */
export function evaluateDailyRangeFadeGenuineBreakoutFilter(input: {
  policy: DailyRangeFadeGenuineBreakoutFilterSnapshot;
  signalTimestampMs: number;
  breakoutDirection: "UP" | "DOWN" | null | undefined;
  breakoutExtreme: number | null | undefined;
  rangeHigh: number;
  rangeLow: number;
}): DailyRangeFadeGenuineBreakoutFilterDecision {
  const base = {
    policyId: input.policy.policyId,
    fingerprint: input.policy.fingerprint,
    activationAt: input.policy.activationAt,
    threshold: input.policy.sweepExtensionOfRangeRejectAtOrAbove,
  } as const;
  if (!Number.isFinite(input.signalTimestampMs) || input.signalTimestampMs < input.policy.activationAtMs) {
    return { ...base, status: "REJECTED_PRE_ACTIVATION", rangeWidth: null, sweepExtensionPrice: null, sweepExtensionOfRange: null };
  }
  if (!finitePositive(input.rangeHigh)
    || !finitePositive(input.rangeLow)
    || input.rangeHigh <= input.rangeLow
    || !finitePositive(input.breakoutExtreme)
    || (input.breakoutDirection !== "UP" && input.breakoutDirection !== "DOWN")) {
    return { ...base, status: "REJECTED_INVALID_INPUT", rangeWidth: null, sweepExtensionPrice: null, sweepExtensionOfRange: null };
  }
  const rangeWidth = input.rangeHigh - input.rangeLow;
  const sweepExtensionPrice = input.breakoutDirection === "UP"
    ? input.breakoutExtreme - input.rangeHigh
    : input.rangeLow - input.breakoutExtreme;
  if (!(sweepExtensionPrice > 0)) {
    return { ...base, status: "REJECTED_INVALID_INPUT", rangeWidth, sweepExtensionPrice, sweepExtensionOfRange: null };
  }
  const sweepExtensionOfRange = sweepExtensionPrice / rangeWidth;
  return {
    ...base,
    status: sweepExtensionOfRange + THRESHOLD_EPSILON >= input.policy.sweepExtensionOfRangeRejectAtOrAbove
      ? "REJECTED_GENUINE_BREAKOUT_EXTENSION"
      : "ACCEPTED",
    rangeWidth,
    sweepExtensionPrice,
    sweepExtensionOfRange,
  };
}

export function dailyRangeFadeGenuineBreakoutFilterAllows(
  decision: DailyRangeFadeGenuineBreakoutFilterDecision,
): boolean {
  return decision.status === "ACCEPTED";
}

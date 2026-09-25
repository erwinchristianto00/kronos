import { createHash } from "node:crypto";

/**
 * Testnet-only forward experiment for the Daily Range FADE route.
 *
 * This module has no exchange client and no order authority.  It freezes the
 * chosen experiment's entry/exit semantics onto a signal/trade; the lane owns
 * all reconciliation and reduce-only execution.
 */
export const DAILY_RANGE_FADE_VNEXT_POLICY_ID = "daily-fade-vnext-testnet-v1" as const;

export const DAILY_RANGE_FADE_VNEXT_VARIANTS = [
  "BASELINE",
  "STRICTER_ENTRY",
  "LATER_TRAIL",
  "SOFT_INVALIDATION",
  "HYBRID",
] as const;

export type DailyRangeFadeVNextVariant = typeof DAILY_RANGE_FADE_VNEXT_VARIANTS[number];

export interface DailyRangeFadeVNextParameters {
  variant: DailyRangeFadeVNextVariant;
  strictEntryConfirmation: boolean;
  softInvalidation: boolean;
  trailArmR: 0.5 | 0.75;
  trailGivebackFraction: 0.3 | 0.4;
  trailMinimumGivebackR: 0.25;
}

export interface DailyRangeFadeVNextSnapshot extends DailyRangeFadeVNextParameters {
  policyId: typeof DAILY_RANGE_FADE_VNEXT_POLICY_ID;
  activationAt: string;
  fingerprint: string;
}

export interface DailyRangeFadeVNextCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DailyRangeFadeStrictEntryDecision {
  accepted: boolean;
  reason: "CONFIRMED" | "CANDLE_NOT_INSIDE_RANGE" | "NEW_SWEEP_EXTREME" | "INVALID_INPUT";
}

export interface DailyRangeFadeSoftInvalidationDecision {
  referenceBoundary: number;
  candleOpenTime: number;
  candleCloseTime: number;
  candleClose: number;
  /** Positive means the close is back outside in the original breakout direction. */
  distanceOutsideRange: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositive(value: unknown): value is number {
  return finite(value) && value > 0;
}

export function dailyRangeFadeVNextParameters(
  variant: DailyRangeFadeVNextVariant,
): DailyRangeFadeVNextParameters {
  switch (variant) {
    case "BASELINE":
      return {
        variant,
        strictEntryConfirmation: false,
        softInvalidation: false,
        trailArmR: 0.5,
        trailGivebackFraction: 0.3,
        trailMinimumGivebackR: 0.25,
      };
    case "STRICTER_ENTRY":
      return {
        variant,
        strictEntryConfirmation: true,
        softInvalidation: false,
        trailArmR: 0.5,
        trailGivebackFraction: 0.3,
        trailMinimumGivebackR: 0.25,
      };
    case "LATER_TRAIL":
      return {
        variant,
        strictEntryConfirmation: false,
        softInvalidation: false,
        trailArmR: 0.75,
        trailGivebackFraction: 0.4,
        trailMinimumGivebackR: 0.25,
      };
    case "SOFT_INVALIDATION":
      return {
        variant,
        strictEntryConfirmation: false,
        softInvalidation: true,
        trailArmR: 0.5,
        trailGivebackFraction: 0.3,
        trailMinimumGivebackR: 0.25,
      };
    case "HYBRID":
      return {
        variant,
        strictEntryConfirmation: true,
        softInvalidation: true,
        trailArmR: 0.75,
        trailGivebackFraction: 0.4,
        trailMinimumGivebackR: 0.25,
      };
  }
}

export function createDailyRangeFadeVNextSnapshot(input: {
  variant: DailyRangeFadeVNextVariant;
  activationAt: string;
}): DailyRangeFadeVNextSnapshot {
  const parameters = dailyRangeFadeVNextParameters(input.variant);
  const activationAt = new Date(input.activationAt).toISOString();
  const canonical = JSON.stringify({ policyId: DAILY_RANGE_FADE_VNEXT_POLICY_ID, activationAt, ...parameters });
  return {
    policyId: DAILY_RANGE_FADE_VNEXT_POLICY_ID,
    activationAt,
    ...parameters,
    fingerprint: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
  };
}

/** A strict confirmation must finish definitely inside, not merely touch a boundary. */
export function isDailyRangeFadeCandleInsideRange(
  candle: Pick<DailyRangeFadeVNextCandle, "close">,
  rangeLow: number,
  rangeHigh: number,
): boolean {
  return finite(candle.close)
    && finitePositive(rangeLow)
    && finitePositive(rangeHigh)
    && rangeHigh > rangeLow
    && candle.close > rangeLow
    && candle.close < rangeHigh;
}

/**
 * The post-reacceptance 1m confirmation never waits for another candle.  A
 * failed next candle is a rejected setup, rather than a delayed re-entry that
 * would silently change the experiment.
 */
export function evaluateDailyRangeFadeStrictEntry(input: {
  breakoutDirection: "UP" | "DOWN";
  sweepExtreme: number;
  rangeLow: number;
  rangeHigh: number;
  candle: DailyRangeFadeVNextCandle;
}): DailyRangeFadeStrictEntryDecision {
  const { breakoutDirection, sweepExtreme, rangeLow, rangeHigh, candle } = input;
  if (!finitePositive(sweepExtreme)
    || !finitePositive(rangeLow)
    || !finitePositive(rangeHigh)
    || rangeHigh <= rangeLow
    || ![candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close].every(finite)) {
    return { accepted: false, reason: "INVALID_INPUT" };
  }
  if (!isDailyRangeFadeCandleInsideRange(candle, rangeLow, rangeHigh)) {
    return { accepted: false, reason: "CANDLE_NOT_INSIDE_RANGE" };
  }
  const newSweepExtreme = breakoutDirection === "UP"
    ? candle.high > sweepExtreme + 1e-12
    : candle.low < sweepExtreme - 1e-12;
  return newSweepExtreme
    ? { accepted: false, reason: "NEW_SWEEP_EXTREME" }
    : { accepted: true, reason: "CONFIRMED" };
}

/**
 * Soft invalidation is deliberately a completed-candle condition.  A wick is
 * never enough to close a FADE; native STOP_MARKET remains the catastrophe
 * protection for intrabar excursions.
 */
export function evaluateDailyRangeFadeSoftInvalidation(input: {
  breakoutDirection: "UP" | "DOWN";
  rangeLow: number;
  rangeHigh: number;
  candle: DailyRangeFadeVNextCandle;
}): DailyRangeFadeSoftInvalidationDecision | null {
  const { breakoutDirection, rangeLow, rangeHigh, candle } = input;
  if (!finitePositive(rangeLow)
    || !finitePositive(rangeHigh)
    || rangeHigh <= rangeLow
    || ![candle.openTime, candle.closeTime, candle.close].every(finite)) return null;
  const boundary = breakoutDirection === "UP" ? rangeHigh : rangeLow;
  const distanceOutsideRange = breakoutDirection === "UP"
    ? candle.close - boundary
    : boundary - candle.close;
  if (!(distanceOutsideRange > 0)) return null;
  return {
    referenceBoundary: boundary,
    candleOpenTime: candle.openTime,
    candleCloseTime: candle.closeTime,
    candleClose: candle.close,
    distanceOutsideRange,
  };
}

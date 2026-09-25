import { describe, expect, it } from "vitest";

import {
  DAILY_RANGE_FADE_GENUINE_BREAKOUT_MAX_EXTENSION_OF_RANGE,
  createDailyRangeFadeGenuineBreakoutFilterSnapshot,
  dailyRangeFadeGenuineBreakoutFilterAllows,
  evaluateDailyRangeFadeGenuineBreakoutFilter,
} from "../src/lib/daily-range-fade-genuine-breakout-filter.js";

const activationAt = "2026-09-03T00:00:00.000Z";

describe("Daily Range genuine-breakout FADE filter", () => {
  it("freezes the selected one-condition policy and fingerprint", () => {
    const first = createDailyRangeFadeGenuineBreakoutFilterSnapshot({ activationAt });
    const second = createDailyRangeFadeGenuineBreakoutFilterSnapshot({ activationAt });
    expect(first).toMatchObject({
      variant: "FILTER_PLUS_SOFT_INVALIDATION",
      sweepExtensionOfRangeRejectAtOrAbove: DAILY_RANGE_FADE_GENUINE_BREAKOUT_MAX_EXTENSION_OF_RANGE,
      softInvalidationEnabled: true,
      nativeTargetPolicy: "OPPOSITE_4H_RANGE_BOUNDARY",
      trailPolicy: "daily-fade-r30-floor25-v2",
    });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("accepts a shallow UP sweep and rejects exactly at the 15% extension boundary", () => {
    const policy = createDailyRangeFadeGenuineBreakoutFilterSnapshot({ activationAt });
    const accepted = evaluateDailyRangeFadeGenuineBreakoutFilter({
      policy,
      signalTimestampMs: Date.parse(activationAt),
      breakoutDirection: "UP",
      breakoutExtreme: 101.49,
      rangeHigh: 100,
      rangeLow: 90,
    });
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.sweepExtensionOfRange).toBeCloseTo(0.149, 12);
    expect(dailyRangeFadeGenuineBreakoutFilterAllows(accepted)).toBe(true);

    const rejected = evaluateDailyRangeFadeGenuineBreakoutFilter({
      policy,
      signalTimestampMs: Date.parse(activationAt),
      breakoutDirection: "UP",
      breakoutExtreme: 101.5,
      rangeHigh: 100,
      rangeLow: 90,
    });
    expect(rejected).toMatchObject({ status: "REJECTED_GENUINE_BREAKOUT_EXTENSION", sweepExtensionOfRange: 0.15 });
    expect(dailyRangeFadeGenuineBreakoutFilterAllows(rejected)).toBe(false);
  });

  it("uses the original breakout direction for DOWN sweeps", () => {
    const policy = createDailyRangeFadeGenuineBreakoutFilterSnapshot({ activationAt });
    const decision = evaluateDailyRangeFadeGenuineBreakoutFilter({
      policy,
      signalTimestampMs: Date.parse(activationAt) + 1,
      breakoutDirection: "DOWN",
      breakoutExtreme: 88.4,
      rangeHigh: 100,
      rangeLow: 90,
    });
    expect(decision.status).toBe("REJECTED_GENUINE_BREAKOUT_EXTENSION");
    expect(decision.sweepExtensionPrice).toBeCloseTo(1.6, 12);
    expect(decision.sweepExtensionOfRange).toBeCloseTo(0.16, 12);
  });

  it("fails closed for pre-activation and malformed frozen entry facts", () => {
    const policy = createDailyRangeFadeGenuineBreakoutFilterSnapshot({ activationAt });
    expect(evaluateDailyRangeFadeGenuineBreakoutFilter({
      policy,
      signalTimestampMs: Date.parse(activationAt) - 1,
      breakoutDirection: "UP",
      breakoutExtreme: 101,
      rangeHigh: 100,
      rangeLow: 90,
    }).status).toBe("REJECTED_PRE_ACTIVATION");
    expect(evaluateDailyRangeFadeGenuineBreakoutFilter({
      policy,
      signalTimestampMs: Date.parse(activationAt) + 1,
      breakoutDirection: "UP",
      breakoutExtreme: 99,
      rangeHigh: 100,
      rangeLow: 90,
    }).status).toBe("REJECTED_INVALID_INPUT");
  });
});

import { describe, expect, it } from "vitest";

import {
  DAILY_RANGE_ROUTE_EXIT_POLICY_ID,
  dailyRangeRouteExitPolicyForSignal,
  dailyRangeTpMultipleForRoute,
  evaluateDailyRangeThesisInvalidation,
} from "../src/lib/daily-range-route-exit.js";

const FIVE_MINUTES = 5 * 60_000;

function policy(input: Parameters<typeof dailyRangeRouteExitPolicyForSignal>[0]) {
  const result = dailyRangeRouteExitPolicyForSignal(input);
  if (!result) throw new Error("fixture policy must be valid");
  return result;
}

function completedCandle(openTime: number, close: number) {
  return { openTime, closeTime: openTime + FIVE_MINUTES - 1, close };
}

describe("daily-route-exit-v1", () => {
  it("freezes the intended payoff and original boundary per route", () => {
    const continuation = policy({ route: "CONTINUATION", originalBreakoutDirection: "UP", rangeHigh: 100, rangeLow: 90, effectiveAt: "2026-08-27T00:00:00.000Z" });
    const fade = policy({ route: "FADE", originalBreakoutDirection: "DOWN", rangeHigh: 100, rangeLow: 90, effectiveAt: "2026-08-27T00:00:00.000Z" });
    expect(continuation).toMatchObject({
      exitPolicyId: DAILY_RANGE_ROUTE_EXIT_POLICY_ID,
      tpMultipleR: 1,
      thesisInvalidationType: "RANGE_REENTRY",
      originalBreakoutBoundary: 100,
    });
    expect(fade).toMatchObject({
      tpMultipleR: 2,
      thesisInvalidationType: "ORIGINAL_BREAKOUT_REACCEPTANCE",
      originalBreakoutBoundary: 90,
    });
    expect(dailyRangeTpMultipleForRoute("CONTINUATION")).toBe(1);
    expect(dailyRangeTpMultipleForRoute("FADE")).toBe(2);
  });

  it("uses the router's equality-is-inside semantics for both continuation directions", () => {
    const long = policy({ route: "CONTINUATION", originalBreakoutDirection: "UP", rangeHigh: 100, rangeLow: 90, effectiveAt: "2026-08-27T00:00:00.000Z" });
    const short = policy({ route: "CONTINUATION", originalBreakoutDirection: "DOWN", rangeHigh: 100, rangeLow: 90, effectiveAt: "2026-08-27T00:00:00.000Z" });
    expect(evaluateDailyRangeThesisInvalidation({ policy: long, candle: completedCandle(0, 100) }))
      .toMatchObject({ reason: "CONTINUATION_RANGE_REENTRY_EXIT", rangePosition: "INSIDE" });
    expect(evaluateDailyRangeThesisInvalidation({ policy: short, candle: completedCandle(FIVE_MINUTES, 90) }))
      .toMatchObject({ reason: "CONTINUATION_RANGE_REENTRY_EXIT", rangePosition: "INSIDE" });
    expect(evaluateDailyRangeThesisInvalidation({ policy: long, candle: completedCandle(2 * FIVE_MINUTES, 100.0001) })).toBeNull();
    expect(evaluateDailyRangeThesisInvalidation({ policy: short, candle: completedCandle(3 * FIVE_MINUTES, 89.9999) })).toBeNull();
  });

  it("only invalidates a fade when the original breakout direction is re-accepted", () => {
    const shortFade = policy({ route: "FADE", originalBreakoutDirection: "UP", rangeHigh: 100, rangeLow: 90, effectiveAt: "2026-08-27T00:00:00.000Z" });
    const longFade = policy({ route: "FADE", originalBreakoutDirection: "DOWN", rangeHigh: 100, rangeLow: 90, effectiveAt: "2026-08-27T00:00:00.000Z" });
    expect(evaluateDailyRangeThesisInvalidation({ policy: shortFade, candle: completedCandle(0, 99.9) })).toBeNull();
    expect(evaluateDailyRangeThesisInvalidation({ policy: shortFade, candle: completedCandle(FIVE_MINUTES, 100.01) }))
      .toMatchObject({ reason: "FADE_BREAKOUT_REACCEPTANCE_EXIT", referenceBoundary: 100, rangePosition: "ABOVE" });
    expect(evaluateDailyRangeThesisInvalidation({ policy: longFade, candle: completedCandle(2 * FIVE_MINUTES, 90.1) })).toBeNull();
    expect(evaluateDailyRangeThesisInvalidation({ policy: longFade, candle: completedCandle(3 * FIVE_MINUTES, 89.99) }))
      .toMatchObject({ reason: "FADE_BREAKOUT_REACCEPTANCE_EXIT", referenceBoundary: 90, rangePosition: "BELOW" });
  });
});

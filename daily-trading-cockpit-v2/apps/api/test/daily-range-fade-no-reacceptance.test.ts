import { describe, expect, it } from "vitest";

import {
  DAILY_RANGE_STRUCTURAL_SR_FADE_NO_REACCEPTANCE_EXIT_POLICY_ID,
  DAILY_RANGE_STRUCTURAL_SR_ROUTE_EXIT_POLICY_ID,
  dailyRangeRouteExitPolicyForSignal,
  evaluateDailyRangeThesisInvalidation,
} from "../src/lib/daily-range-route-exit.js";

const FIVE_MINUTES = 5 * 60_000;

function policy(input: Parameters<typeof dailyRangeRouteExitPolicyForSignal>[0]) {
  const result = dailyRangeRouteExitPolicyForSignal(input);
  if (!result) throw new Error("fixture policy must be valid");
  return result;
}

describe("retired FADE breakout re-acceptance exit", () => {
  it("keeps structural-SR FADE on its frozen native stop and target only", () => {
    const fade = policy({
      route: "FADE",
      originalBreakoutDirection: "UP",
      rangeHigh: 100,
      rangeLow: 90,
      effectiveAt: "2026-08-30T00:00:00.000Z",
      structuralSrEnabled: true,
    });
    expect(fade).toMatchObject({
      exitPolicyId: DAILY_RANGE_STRUCTURAL_SR_FADE_NO_REACCEPTANCE_EXIT_POLICY_ID,
      targetPolicyId: "daily-next-sr-target-v1",
      thesisInvalidationType: "NONE",
    });
    expect(evaluateDailyRangeThesisInvalidation({
      policy: fade,
      candle: { openTime: 0, closeTime: FIVE_MINUTES - 1, close: 100.01 },
    })).toBeNull();
  });

  it("cannot revive a persisted legacy FADE re-acceptance snapshot", () => {
    const fade = policy({
      route: "FADE",
      originalBreakoutDirection: "DOWN",
      rangeHigh: 100,
      rangeLow: 90,
      effectiveAt: "2026-08-30T00:00:00.000Z",
      structuralSrEnabled: true,
    });
    const legacy = {
      ...fade,
      exitPolicyId: DAILY_RANGE_STRUCTURAL_SR_ROUTE_EXIT_POLICY_ID,
      thesisInvalidationType: "ORIGINAL_BREAKOUT_REACCEPTANCE" as const,
    };
    expect(evaluateDailyRangeThesisInvalidation({
      policy: legacy,
      candle: { openTime: FIVE_MINUTES, closeTime: 2 * FIVE_MINUTES - 1, close: 89.99 },
    })).toBeNull();
  });

  it("retains the continuation range-reentry protection", () => {
    const continuation = policy({
      route: "CONTINUATION",
      originalBreakoutDirection: "UP",
      rangeHigh: 100,
      rangeLow: 90,
      effectiveAt: "2026-08-30T00:00:00.000Z",
      structuralSrEnabled: true,
    });
    expect(evaluateDailyRangeThesisInvalidation({
      policy: continuation,
      candle: { openTime: 2 * FIVE_MINUTES, closeTime: 3 * FIVE_MINUTES - 1, close: 100 },
    })).toMatchObject({ reason: "CONTINUATION_RANGE_REENTRY_EXIT" });
  });
});

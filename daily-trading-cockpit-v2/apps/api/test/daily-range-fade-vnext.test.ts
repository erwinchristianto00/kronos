import { describe, expect, it } from "vitest";
import {
  createDailyRangeFadeVNextSnapshot,
  evaluateDailyRangeFadeSoftInvalidation,
  evaluateDailyRangeFadeStrictEntry,
} from "../src/lib/daily-range-fade-vnext.js";

const candle = (overrides: Partial<{
  openTime: number; closeTime: number; open: number; high: number; low: number; close: number;
}> = {}) => ({
  openTime: 1_000,
  closeTime: 60_999,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  ...overrides,
});

describe("Daily Range FADE VNext pure policy", () => {
  it("freezes the hybrid's stricter entry, soft invalidation, and later trail in one fingerprint", () => {
    const first = createDailyRangeFadeVNextSnapshot({ variant: "HYBRID", activationAt: "2026-09-03T00:00:00.000Z" });
    const second = createDailyRangeFadeVNextSnapshot({ variant: "HYBRID", activationAt: "2026-09-03T00:00:00.000Z" });
    expect(first).toMatchObject({
      variant: "HYBRID",
      strictEntryConfirmation: true,
      softInvalidation: true,
      trailArmR: 0.75,
      trailGivebackFraction: 0.4,
      trailMinimumGivebackR: 0.25,
    });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("accepts exactly one next 1m candle only when it remains inside and makes no new sweep", () => {
    expect(evaluateDailyRangeFadeStrictEntry({
      breakoutDirection: "UP", sweepExtreme: 103, rangeLow: 98, rangeHigh: 102, candle: candle({ high: 102.9, low: 99, close: 101 }),
    })).toEqual({ accepted: true, reason: "CONFIRMED" });
    expect(evaluateDailyRangeFadeStrictEntry({
      breakoutDirection: "UP", sweepExtreme: 103, rangeLow: 98, rangeHigh: 102, candle: candle({ high: 103.1, low: 99, close: 101 }),
    })).toEqual({ accepted: false, reason: "NEW_SWEEP_EXTREME" });
    expect(evaluateDailyRangeFadeStrictEntry({
      breakoutDirection: "DOWN", sweepExtreme: 97, rangeLow: 98, rangeHigh: 102, candle: candle({ high: 101, low: 98.5, close: 102 }),
    })).toEqual({ accepted: false, reason: "CANDLE_NOT_INSIDE_RANGE" });
  });

  it("only soft-invalidates a completed close outside toward the original breakout", () => {
    const up = evaluateDailyRangeFadeSoftInvalidation({
      breakoutDirection: "UP", rangeLow: 98, rangeHigh: 102, candle: candle({ close: 102.01 }),
    });
    expect(up?.referenceBoundary).toBe(102);
    expect(up?.distanceOutsideRange).toBeCloseTo(0.01, 10);
    expect(evaluateDailyRangeFadeSoftInvalidation({
      breakoutDirection: "UP", rangeLow: 98, rangeHigh: 102, candle: candle({ high: 103, close: 101 }),
    })).toBeNull();
    const down = evaluateDailyRangeFadeSoftInvalidation({
      breakoutDirection: "DOWN", rangeLow: 98, rangeHigh: 102, candle: candle({ close: 97.99 }),
    });
    expect(down?.referenceBoundary).toBe(98);
    expect(down?.distanceOutsideRange).toBeCloseTo(0.01, 10);
  });
});

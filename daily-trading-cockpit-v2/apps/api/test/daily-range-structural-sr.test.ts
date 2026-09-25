import { describe, expect, it } from "vitest";

import {
  dailyRangeStructuralStopSource,
  resolveDailyRangeStructuralTarget,
  type DailyRangeStructuralCandle,
} from "../src/lib/daily-range-structural-sr.js";

const HOUR = 60 * 60_000;
const FOUR_HOURS = 4 * HOUR;
const START = Date.UTC(2026, 7, 27, 0, 0, 0);

function candle(input: {
  timeframeMs: number;
  index: number;
  high: number;
  low: number;
  close?: number;
}): DailyRangeStructuralCandle {
  const openTime = START + input.index * input.timeframeMs;
  return {
    openTime,
    closeTime: openTime + input.timeframeMs - 1,
    high: input.high,
    low: input.low,
    close: input.close ?? (input.high + input.low) / 2,
  };
}

function resolve(overrides: Partial<Parameters<typeof resolveDailyRangeStructuralTarget>[0]> = {}) {
  const oneHourCandles = [
    candle({ timeframeMs: HOUR, index: 0, high: 101, low: 95 }),
    candle({ timeframeMs: HOUR, index: 1, high: 103, low: 96 }),
    candle({ timeframeMs: HOUR, index: 2, high: 108, low: 97 }),
    candle({ timeframeMs: HOUR, index: 3, high: 104, low: 96 }),
    candle({ timeframeMs: HOUR, index: 4, high: 102, low: 94 }),
    candle({ timeframeMs: HOUR, index: 5, high: 105, low: 95 }),
    candle({ timeframeMs: HOUR, index: 6, high: 104, low: 93 }),
  ];
  return resolveDailyRangeStructuralTarget({
    direction: "LONG",
    route: "CONTINUATION",
    expectedEntry: 100,
    rangeHigh: 120,
    rangeLow: 80,
    referenceRangeCloseTime: START - 1,
    decisionAtMs: START + 7 * HOUR,
    oneHourCandles,
    fourHourCandles: [],
    ...overrides,
  });
}

describe("Daily Range Structural S/R V1", () => {
  it("uses the nearest PIT-confirmed 1H resistance rather than a fixed-R distance", () => {
    const result = resolve();
    expect(result).toMatchObject({
      ok: true,
      target: {
        target: 108,
        targetSource: "CONFIRMED_1H_SWING_HIGH",
        targetLevelType: "SWING_HIGH",
        targetSourceTimeframe: "1h",
      },
    });
  });

  it("does not use a pivot before its right-side confirmation candles have completed", () => {
    const rows = [
      candle({ timeframeMs: HOUR, index: 0, high: 101, low: 95 }),
      candle({ timeframeMs: HOUR, index: 1, high: 103, low: 96 }),
      candle({ timeframeMs: HOUR, index: 2, high: 108, low: 97 }),
      candle({ timeframeMs: HOUR, index: 3, high: 104, low: 96 }),
      // This would confirm the index-2 pivot, but it has not closed at the decision.
      candle({ timeframeMs: HOUR, index: 4, high: 102, low: 94 }),
    ];
    const beforeConfirmation = resolve({
      oneHourCandles: rows,
      decisionAtMs: START + 4 * HOUR,
    });
    expect(beforeConfirmation).toMatchObject({
      ok: true,
      target: { target: 120, targetSource: "RANGE_OPPOSITE_BOUNDARY" },
    });

    const afterConfirmation = resolve({
      oneHourCandles: rows,
      decisionAtMs: START + 5 * HOUR,
    });
    expect(afterConfirmation).toMatchObject({
      ok: true,
      target: { target: 108, targetSource: "CONFIRMED_1H_SWING_HIGH" },
    });
  });

  it("rejects future candles and never lets them manufacture a nearer target", () => {
    const futureMajorHigh = candle({ timeframeMs: FOUR_HOURS, index: 2, high: 101, low: 90 });
    const result = resolve({
      oneHourCandles: [],
      fourHourCandles: [futureMajorHigh],
      decisionAtMs: START + FOUR_HOURS,
    });
    expect(result).toMatchObject({
      ok: true,
      target: { target: 120, targetSource: "RANGE_OPPOSITE_BOUNDARY" },
    });
  });

  it("uses the opposite range boundary as the natural deep-reclaim fade target", () => {
    const result = resolve({
      route: "FADE",
      expectedEntry: 95,
      rangeHigh: 110,
      rangeLow: 90,
      oneHourCandles: [],
      fourHourCandles: [],
    });
    expect(result).toMatchObject({
      ok: true,
      target: {
        target: 110,
        targetSource: "RANGE_OPPOSITE_BOUNDARY",
        targetLevelType: "RANGE_HIGH",
      },
    });
  });

  it("pins a fade to the opposite range boundary even when a nearer confirmed pivot exists", () => {
    const oneHourCandles = [
      candle({ timeframeMs: HOUR, index: 0, high: 104, low: 97 }),
      candle({ timeframeMs: HOUR, index: 1, high: 103, low: 96 }),
      candle({ timeframeMs: HOUR, index: 2, high: 102, low: 95 }),
      candle({ timeframeMs: HOUR, index: 3, high: 103, low: 96 }),
      candle({ timeframeMs: HOUR, index: 4, high: 104, low: 97 }),
    ];
    const result = resolve({
      direction: "SHORT",
      route: "FADE",
      expectedEntry: 105,
      rangeHigh: 110,
      rangeLow: 90,
      decisionAtMs: START + 5 * HOUR,
      oneHourCandles,
      fourHourCandles: [],
    });
    expect(result).toMatchObject({
      ok: true,
      target: {
        target: 90,
        targetSource: "RANGE_OPPOSITE_BOUNDARY",
        targetLevelType: "RANGE_LOW",
        targetSourceTimeframe: "RANGE",
      },
    });
  });

  it("marks a continuation target invalid when no known resistance exists above the executable entry", () => {
    const result = resolve({
      expectedEntry: 100,
      rangeHigh: 100,
      rangeLow: 90,
      oneHourCandles: [],
      fourHourCandles: [],
    });
    expect(result).toEqual({ ok: false, reason: "STRUCTURAL_TARGET_INVALID", candidatesConsidered: 2 });
  });

  it("keeps exact stop semantics separate by route", () => {
    expect(dailyRangeStructuralStopSource("FADE")).toBe("FAILED_BREAKOUT_EXTREME");
    expect(dailyRangeStructuralStopSource("FADE", true)).toBe("FAILED_BREAKOUT_SWEEP_BUFFER");
    expect(dailyRangeStructuralStopSource("CONTINUATION")).toBe("FLIPPED_RANGE_RETEST");
  });
});

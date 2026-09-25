import { describe, expect, it } from "vitest";

import {
  advanceDailyRangeAutoRoute,
  blankDailyRangeAutoRouteState,
} from "../src/lib/daily-range-auto-route.js";

const FIVE_MIN_MS = 5 * 60_000;
const START = Date.UTC(2026, 7, 29, 8);

function candle(openTime: number, close: number, low: number, high: number) {
  return { openTime, closeTime: openTime + FIVE_MIN_MS - 1, open: 100, high, low, close, volume: 1 };
}

function transition(input: Omit<Parameters<typeof advanceDailyRangeAutoRoute>[0], "dateUtc" | "symbol" | "rangeHigh" | "rangeLow">) {
  return advanceDailyRangeAutoRoute({
    dateUtc: "2026-08-29",
    symbol: "MEMEUSDT",
    rangeHigh: 100,
    rangeLow: 90,
    ...input,
  });
}

describe("Daily Range AUTO_ROUTE entry modes", () => {
  it("keeps the historical V2 follow-through route when no V3 mode is supplied", () => {
    const first = transition({ state: blankDailyRangeAutoRouteState(), candle: candle(START, 101, 100, 102) });
    expect(first.decision).toBeNull();
    const second = transition({ state: first.state, candle: candle(START + FIVE_MIN_MS, 102, 101, 103) });
    expect(second.decision).toMatchObject({
      entryPolicy: "CONTINUATION",
      direction: "LONG",
      entryTiming: "FOLLOW_THROUGH_CLOSE",
    });
  });

  it("Live fade-only waits for the first completed re-entry, never an extra C3/C4 continuation", () => {
    const first = transition({
      entryMode: "FADE_FIRST_REENTRY_ONLY",
      state: blankDailyRangeAutoRouteState(),
      candle: candle(START, 101, 100, 102),
    });
    const second = transition({
      entryMode: "FADE_FIRST_REENTRY_ONLY",
      state: first.state,
      candle: candle(START + FIVE_MIN_MS, 102, 101, 103),
    });
    expect(second.decision).toBeNull();
    const reentry = transition({
      entryMode: "FADE_FIRST_REENTRY_ONLY",
      state: second.state,
      candle: candle(START + 2 * FIVE_MIN_MS, 99, 98, 103.5),
    });
    expect(reentry.decision).toMatchObject({
      entryPolicy: "FADE",
      direction: "SHORT",
      breakoutExtreme: 103.5,
      entryTiming: "FIRST_REENTRY_CLOSE",
    });
  });

  it("Testnet continuation enters from the first completed outside close, never a wick or incomplete bar", () => {
    const first = transition({
      entryMode: "CONTINUATION_FIRST_OUTSIDE_CLOSE",
      state: blankDailyRangeAutoRouteState(),
      candle: candle(START, 101, 100, 102),
    });
    expect(first.state.phase).toBe("CONTINUATION_LOCKED");
    expect(first.decision).toMatchObject({
      entryPolicy: "CONTINUATION",
      direction: "LONG",
      entryTiming: "FIRST_OUTSIDE_CLOSE",
      confirmationBar1: { openTime: START },
      confirmationBar2: { openTime: START },
    });
  });
});

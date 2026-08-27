import { describe, expect, it } from "vitest";

import {
  completedCandlesAtOrBefore,
  replayReconstructedDailyRangeAutoRoute,
  resolveReconstructedDailyRangeOutcome,
  type DailyRangeReconstructedCandidate,
} from "../src/lib/daily-range-reconstructed-candle-pit.js";

const FIVE = 5 * 60_000;
const MINUTE = 60_000;

function candle(openTime: number, close: number, low = Math.min(close, 99), high = Math.max(close, 101)) {
  return { openTime, closeTime: openTime + FIVE - 1, open: 100, high, low, close, volume: 10 };
}

describe("Daily Range RECONSTRUCTED_CANDLE_PIT", () => {
  it("rejects future/incomplete candles from decision-time feature input", () => {
    const decision = Date.UTC(2026, 7, 26, 8, 10);
    const rows = [
      { ...candle(decision - FIVE, 101), closeTime: decision - 1 },
      // This candle is still open at the decision and must not be visible.
      { ...candle(decision, 102), closeTime: decision + FIVE - 1 },
    ];
    expect(completedCandlesAtOrBefore(rows, decision)).toHaveLength(1);
  });

  it("replays the runtime pure route exactly: expanding breakout continues and inside re-entry fades", () => {
    const start = Date.UTC(2026, 7, 26, 8);
    const continuation = replayReconstructedDailyRangeAutoRoute({
      dateUtc: "2026-08-26", symbol: "AAAUSDT", rangeHigh: 100, rangeLow: 90,
      candles: [candle(start, 101, 100.5, 102), candle(start + FIVE, 102, 101, 103)],
    });
    expect(continuation).toHaveLength(1);
    expect(continuation[0]?.decision).toMatchObject({ entryPolicy: "CONTINUATION", breakoutDirection: "UP", direction: "LONG" });
    expect(continuation[0]?.structuralStop).toBe(100);
    expect(continuation[0]?.takeProfit).toBe(106);

    const fade = replayReconstructedDailyRangeAutoRoute({
      dateUtc: "2026-08-26", symbol: "AAAUSDT", rangeHigh: 100, rangeLow: 90,
      candles: [candle(start, 101, 100.5, 103), candle(start + FIVE, 99, 98, 104)],
    });
    expect(fade).toHaveLength(1);
    expect(fade[0]?.decision).toMatchObject({ entryPolicy: "FADE", breakoutDirection: "UP", direction: "SHORT", breakoutExtreme: 104 });
    expect(fade[0]?.structuralStop).toBe(104);
    expect(fade[0]?.takeProfit).toBe(89);
  });

  it("labels a same-minute two-barrier touch ambiguous rather than assuming TP first", () => {
    const decision = Date.UTC(2026, 7, 26, 8, 10);
    const candidate: DailyRangeReconstructedCandidate = {
      datasetClass: "RECONSTRUCTED_CANDLE_PIT",
      researchEligibilityQuality: "CANDLE_ELIGIBLE_CURRENT_UNIVERSE",
      dateUtc: "2026-08-26",
      symbol: "AAAUSDT",
      decision: {
        entryPolicy: "CONTINUATION", breakoutDirection: "UP", direction: "LONG", breakoutId: "test", breakoutExtreme: 102,
        confirmationBar1: candle(decision - 2 * FIVE, 101), confirmationBar2: candle(decision - FIVE, 101),
      },
      rangeHigh: 100,
      rangeLow: 90,
      decisionTimestampMs: decision,
      structuralStop: 99,
      takeProfit: 105,
      features: {},
    };
    const both = [{ openTime: decision, closeTime: decision + MINUTE - 1, open: 101, high: 105, low: 99, close: 101, volume: 1 }];
    expect(resolveReconstructedDailyRangeOutcome(candidate, both).outcome).toBe("OUTCOME_AMBIGUOUS");
  });
});

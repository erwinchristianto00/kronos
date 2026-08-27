import { describe, expect, it } from "vitest";

import {
  completedCandlesAtOrBefore,
  replayRouteSpecificExitDiagnostic,
  replayReconstructedDailyRangeAutoRoute,
  resolveReconstructedDailyRangeOutcome,
  type DailyRangeReconstructedCandidate,
} from "../src/lib/daily-range-reconstructed-candle-pit.js";

const FIVE = 5 * 60_000;
const MINUTE = 60_000;

function candle(openTime: number, close: number, low = Math.min(close, 99), high = Math.max(close, 101)) {
  return { openTime, closeTime: openTime + FIVE - 1, open: 100, high, low, close, volume: 10 };
}

function minute(openTime: number, close: number, low = Math.min(close, 99), high = Math.max(close, 101)) {
  return { openTime, closeTime: openTime + MINUTE - 1, open: 100, high, low, close, volume: 1 };
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
    expect(continuation[0]).toMatchObject({ exitPolicyId: "daily-route-exit-v1", tpMultipleR: 1, thesisInvalidationType: "RANGE_REENTRY" });
    expect(continuation[0]?.takeProfit).toBe(104);

    const fade = replayReconstructedDailyRangeAutoRoute({
      dateUtc: "2026-08-26", symbol: "AAAUSDT", rangeHigh: 100, rangeLow: 90,
      candles: [candle(start, 101, 100.5, 103), candle(start + FIVE, 99, 98, 104)],
    });
    expect(fade).toHaveLength(1);
    expect(fade[0]?.decision).toMatchObject({ entryPolicy: "FADE", breakoutDirection: "UP", direction: "SHORT", breakoutExtreme: 104 });
    expect(fade[0]?.structuralStop).toBe(104);
    expect(fade[0]).toMatchObject({ exitPolicyId: "daily-route-exit-v1", tpMultipleR: 2, thesisInvalidationType: "ORIGINAL_BREAKOUT_REACCEPTANCE" });
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
      exitPolicyId: "daily-route-exit-v1",
      tpMultipleR: 1,
      thesisInvalidationType: "RANGE_REENTRY",
      originalBreakoutDirection: "UP",
      originalBreakoutBoundary: 100,
      features: {},
    };
    const both = [{ openTime: decision, closeTime: decision + MINUTE - 1, open: 101, high: 105, low: 99, close: 101, volume: 1 }];
    expect(resolveReconstructedDailyRangeOutcome(candidate, both).outcome).toBe("OUTCOME_AMBIGUOUS");
  });

  it("replays the fixed V1 continuation invalidation separately from the old global 2R path", () => {
    const decision = Date.UTC(2026, 7, 26, 8, 10);
    const candidate: DailyRangeReconstructedCandidate = {
      datasetClass: "RECONSTRUCTED_CANDLE_PIT",
      researchEligibilityQuality: "CANDLE_ELIGIBLE_CURRENT_UNIVERSE",
      dateUtc: "2026-08-26",
      symbol: "AAAUSDT",
      decision: {
        entryPolicy: "CONTINUATION", breakoutDirection: "UP", direction: "LONG", breakoutId: "test", breakoutExtreme: 102,
        confirmationBar1: candle(decision - 2 * FIVE, 100.5, 99, 101), confirmationBar2: candle(decision - FIVE, 101, 100, 102),
      },
      rangeHigh: 100,
      rangeLow: 90,
      decisionTimestampMs: decision,
      structuralStop: 99,
      takeProfit: 103,
      exitPolicyId: "daily-route-exit-v1",
      tpMultipleR: 1,
      thesisInvalidationType: "RANGE_REENTRY",
      originalBreakoutDirection: "UP",
      originalBreakoutBoundary: 100,
      features: {},
    };
    const firstFive = candle(decision, 99.8, 99.8, 101.5);
    const secondFive = candle(decision + FIVE, 102, 100.5, 105);
    const minutes = [
      minute(decision, 101, 100.5, 101.5), minute(decision + MINUTE, 100.8, 100.4, 101.2), minute(decision + 2 * MINUTE, 100.4, 100.1, 100.9), minute(decision + 3 * MINUTE, 100.1, 100, 100.5), minute(decision + 4 * MINUTE, 99.8, 99.8, 100.2),
      minute(decision + FIVE, 100.5, 100.2, 101), minute(decision + FIVE + MINUTE, 101, 100.8, 101.5), minute(decision + FIVE + 2 * MINUTE, 101.5, 101.2, 102), minute(decision + FIVE + 3 * MINUTE, 102, 101.8, 102.5), minute(decision + FIVE + 4 * MINUTE, 102.5, 102.2, 105),
    ];
    const replay = replayRouteSpecificExitDiagnostic({ candidate, completedFiveMinuteCandles: [firstFive, secondFive], completedOneMinuteCandles: minutes });
    expect(replay.newPolicy).toMatchObject({ outcome: "CONTINUATION_RANGE_REENTRY_EXIT", exitPrice: 99.8 });
    expect(replay.legacyGlobal2R).toMatchObject({ outcome: "TAKE_PROFIT", exitPrice: 105 });
  });

  it("does not mark the legacy 2R comparator unavailable just because its terminal 1m candle is in a partial 5m group", () => {
    const decision = Date.UTC(2026, 7, 26, 8, 10);
    const candidate: DailyRangeReconstructedCandidate = {
      datasetClass: "RECONSTRUCTED_CANDLE_PIT",
      researchEligibilityQuality: "CANDLE_ELIGIBLE_CURRENT_UNIVERSE",
      dateUtc: "2026-08-26",
      symbol: "AAAUSDT",
      decision: {
        entryPolicy: "CONTINUATION", breakoutDirection: "UP", direction: "LONG", breakoutId: "test", breakoutExtreme: 102,
        confirmationBar1: candle(decision - 2 * FIVE, 100.5, 99, 101), confirmationBar2: candle(decision - FIVE, 101, 100, 102),
      },
      rangeHigh: 100,
      rangeLow: 90,
      decisionTimestampMs: decision,
      structuralStop: 99,
      takeProfit: 103,
      exitPolicyId: "daily-route-exit-v1",
      tpMultipleR: 1,
      thesisInvalidationType: "RANGE_REENTRY",
      originalBreakoutDirection: "UP",
      originalBreakoutBoundary: 100,
      features: {},
    };
    const minutes = [
      minute(decision, 101, 100.5, 101.5),
      minute(decision + MINUTE, 102, 101.5, 102.5),
      minute(decision + 2 * MINUTE, 104, 103.5, 105),
    ];
    const replay = replayRouteSpecificExitDiagnostic({ candidate, completedFiveMinuteCandles: [], completedOneMinuteCandles: minutes });
    expect(replay.legacyGlobal2R).toMatchObject({ outcome: "TAKE_PROFIT", exitPrice: 105 });
  });
});

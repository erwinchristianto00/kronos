import { describe, it, expect } from "vitest";
import {
  evaluateMarketStandDown,
  standDownThresholdPct,
  STAND_DOWN_LOOKBACK_BARS,
} from "../src/lib/market-drawdown-standdown.js";

/** A series whose last close is `pct` away from the close STAND_DOWN_LOOKBACK_BARS ago. */
const series = (pct: number, bars = STAND_DOWN_LOOKBACK_BARS + 1): number[] => {
  const out = Array.from({ length: bars }, () => 100);
  out[out.length - 1] = 100 * (1 + pct / 100);
  return out;
};
const universe = (pct: number, n = 20): Record<string, number[]> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`S${i}USDT`, series(pct)]));

describe("standDownThresholdPct", () => {
  it("is DISABLED unless an explicitly negative percent is set", () => {
    expect(standDownThresholdPct({} as NodeJS.ProcessEnv)).toBe(0);
    expect(standDownThresholdPct({ CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "" } as NodeJS.ProcessEnv)).toBe(0);
    expect(standDownThresholdPct({ CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "typo" } as NodeJS.ProcessEnv)).toBe(0);
    expect(standDownThresholdPct({ CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0" } as NodeJS.ProcessEnv)).toBe(0);
    // A POSITIVE value is meaningless for a drawdown gate and must not arm it.
    expect(standDownThresholdPct({ CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "10" } as NodeJS.ProcessEnv)).toBe(0);
  });

  it("reads a percent, not a fraction — -0.10 would otherwise arm a far stricter gate than intended", () => {
    expect(standDownThresholdPct({ CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "-10" } as NodeJS.ProcessEnv)).toBe(-10);
    expect(standDownThresholdPct({ CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "-0.10" } as NodeJS.ProcessEnv)).toBe(-0.1);
  });
});

describe("evaluateMarketStandDown", () => {
  it("stands down when the universe is at or below the threshold", () => {
    expect(evaluateMarketStandDown(universe(-12), -10).standDown).toBe(true);
    expect(evaluateMarketStandDown(universe(-10), -10).standDown).toBe(true); // boundary is inclusive
  });

  it("does NOT stand down just above the threshold, nor in a calm or rising market", () => {
    expect(evaluateMarketStandDown(universe(-9.9), -10).standDown).toBe(false);
    expect(evaluateMarketStandDown(universe(0), -10).standDown).toBe(false);
    expect(evaluateMarketStandDown(universe(+30), -10).standDown).toBe(false);
  });

  it("is inert when disabled, however deep the drawdown", () => {
    const v = evaluateMarketStandDown(universe(-50), 0);
    expect(v.standDown).toBe(false);
    expect(v.marketReturn).toBeNull();
  });

  it("FAILS OPEN when too few symbols carry enough history — a data problem must not halt the lane", () => {
    // Exactly the starvation recorded on 2026-08-12: a lookback longer than what was fetched.
    const shallow = Object.fromEntries(Object.entries(universe(-30)).map(([s, c]) => [s, c.slice(-50)]));
    const v = evaluateMarketStandDown(shallow, -10);
    expect(v.standDown).toBe(false);
    expect(v.measuredSymbols).toBe(0);
    expect(v.reason).toMatch(/FAILS OPEN/);
  });

  it("still fails open at 9 measurable symbols, and engages at 10", () => {
    const deep = universe(-30, 9);
    expect(evaluateMarketStandDown(deep, -10).standDown).toBe(false);
    expect(evaluateMarketStandDown(universe(-30, 10), -10).standDown).toBe(true);
  });

  it("ignores symbols with short history instead of letting them distort the mean", () => {
    const mixed = { ...universe(-30, 12), SHORTUSDT: [100, 50] };
    const v = evaluateMarketStandDown(mixed, -10);
    expect(v.measuredSymbols).toBe(12); // the 2-bar symbol is skipped, not counted as -50%
    expect(v.marketReturn!).toBeCloseTo(-0.3, 6);
  });

  it("averages across symbols rather than tripping on one crashed name", () => {
    const mostlyFlat = { ...universe(0, 19), CRASHUSDT: series(-90) };
    expect(evaluateMarketStandDown(mostlyFlat, -10).standDown).toBe(false);
  });
});

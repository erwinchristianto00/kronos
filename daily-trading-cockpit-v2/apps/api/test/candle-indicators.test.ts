import { describe, it, expect } from "vitest";
import { computeATR, type AtrBar } from "../src/lib/candle-indicators.js";

function bar(close: number, high?: number, low?: number): AtrBar {
  return { high: high ?? close + 1, low: low ?? close - 1, close };
}

describe("candle-indicators computeATR", () => {
  it("is null before `period` is reached, and positive after", () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(100 + i));
    const atr = computeATR(bars, 14);
    expect(atr[13]).toBeNull();
    expect(atr[14]).not.toBeNull();
    expect(atr[14]).toBeGreaterThan(0);
    expect(atr[20]).toBeGreaterThan(0);
  });

  it("returns an all-null array when there are not enough bars", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(100 + i));
    const atr = computeATR(bars, 14);
    expect(atr.length).toBe(10);
    expect(atr.every((v) => v === null)).toBe(true);
  });

  it("computes the exact Wilder seed value for a known constant-range series", () => {
    // Every bar has high=101, low=99, close=100 -> TR is exactly 2 for every bar after the first
    // (h-l=2, |h-pc|=1, |l-pc|=1 -> max=2). The period-14 seed is the simple average of TR[1..14] = 2.
    const bars = Array.from({ length: 20 }, () => ({ high: 101, low: 99, close: 100 }));
    const atr = computeATR(bars, 14);
    expect(atr[14]).toBeCloseTo(2, 6);
    // Wilder-smoothed subsequent values stay at 2 on a perfectly constant-range series.
    expect(atr[19]).toBeCloseTo(2, 6);
  });

  it("guards degenerate inputs (period <= 0) without throwing", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(100 + i));
    expect(() => computeATR(bars, 0)).not.toThrow();
    expect(computeATR(bars, 0).every((v) => v === null)).toBe(true);
    expect(() => computeATR(bars, -5)).not.toThrow();
  });
});

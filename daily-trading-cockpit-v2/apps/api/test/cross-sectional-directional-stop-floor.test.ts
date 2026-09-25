import { describe, it, expect } from "vitest";
import { effectiveDirectionalStop } from "../src/lib/cross-sectional-directional-regime.js";

describe("effectiveDirectionalStop", () => {
  it("[STOP-FLOOR] off by default — the scanner stop passes through untouched", () => {
    // Byte-identical to the pre-2026-08-16 path. Every deployment that does not set the env keeps
    // exactly the stop it had.
    expect(effectiveDirectionalStop("SHORT", 75.3, 76.0872, 0)).toBe(76.0872);
    expect(effectiveDirectionalStop("LONG", 75.3, 74.5, 0)).toBe(74.5);
  });

  it("[STOP-FLOOR] widens a stop that is TIGHTER than the floor", () => {
    // The real SOL position: entry 75.30, scanner stop 76.0872 = 1.05%. At a 2% floor it moves to
    // 76.806, which takes the fee from 7.6% of risk to 4.0%.
    expect(effectiveDirectionalStop("SHORT", 75.3, 76.0872, 2)).toBeCloseTo(76.806, 6);
    expect(effectiveDirectionalStop("LONG", 75.3, 74.5128, 2)).toBeCloseTo(73.794, 6);
  });

  it("[STOP-FLOOR] leaves a stop that is ALREADY wider alone", () => {
    // A floor, not a multiplier: stops that already clear it must not be inflated, because that
    // would add risk where the fee was never the problem.
    expect(effectiveDirectionalStop("SHORT", 100, 103, 2)).toBe(103);
    expect(effectiveDirectionalStop("LONG", 100, 97, 2)).toBe(97);
  });

  it("[STOP-FLOOR] only ever moves the stop FURTHER from entry, so validStop cannot break", () => {
    // validStop() requires stop > entry for SHORT and stop < entry for LONG. Widening preserves the
    // side by construction; this pins that so a future edit cannot flip a stop across entry.
    for (const pct of [0, 0.5, 2, 5, 50]) {
      expect(effectiveDirectionalStop("SHORT", 100, 100.4, pct)).toBeGreaterThan(100);
      expect(effectiveDirectionalStop("LONG", 100, 99.6, pct)).toBeLessThan(100);
    }
  });

  it("[STOP-FLOOR] unusable inputs return the scanner stop rather than inventing one", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveDirectionalStop("SHORT", bad, 76.0872, 2)).toBe(76.0872);
      expect(effectiveDirectionalStop("SHORT", 75.3, 76.0872, bad)).toBe(76.0872);
    }
    expect(effectiveDirectionalStop("SHORT", 75.3, Number.NaN, 2)).toBeNaN();
  });

  it("[STOP-FLOOR] the fee's share of risk is what actually moves", () => {
    // The whole reason this exists: 8 bps round trip against a stop distance.
    const feeShare = (entry: number, stop: number) => 0.0008 / (Math.abs(entry - stop) / entry);
    const before = feeShare(75.3, effectiveDirectionalStop("SHORT", 75.3, 76.0872, 0));
    const after = feeShare(75.3, effectiveDirectionalStop("SHORT", 75.3, 76.0872, 2));
    expect(before).toBeCloseTo(0.0765, 3);
    expect(after).toBeCloseTo(0.04, 3);
    expect(after).toBeLessThan(before / 1.8);
  });
});

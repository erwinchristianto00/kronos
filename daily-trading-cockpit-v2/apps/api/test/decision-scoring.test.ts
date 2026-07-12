import { describe, it, expect } from "vitest";
import {
  scoreRegimeQuality,
  scoreSetupQuality,
  scoreOrderFlowQuality,
  scoreLiquidityQuality,
  scoreDerivativesQuality,
  computeDecisionScore,
} from "../src/lib/decision-scoring.js";

describe("regime quality dimension (0-30)", () => {
  it("scores highest for trend-matching mode + HIGH confidence", () => {
    const s = scoreRegimeQuality({ controllerMode: "LONG_ONLY", confidence: "HIGH", direction: "LONG" });
    expect(s).toBe(30);
  });

  it("scores 0 when the regime OPPOSES the trade direction", () => {
    expect(scoreRegimeQuality({ controllerMode: "SHORT_ONLY", confidence: "HIGH", direction: "LONG" })).toBe(0);
  });

  it("scores 0 for a no-conviction chop regime", () => {
    expect(scoreRegimeQuality({ controllerMode: "NO_TRADE_CHOP", confidence: "MEDIUM", direction: "LONG" })).toBe(0);
  });

  it("scores lower (but non-zero) for a non-directional-conviction mode that still allows the direction", () => {
    const s = scoreRegimeQuality({ controllerMode: "BOTH_ALLOWED", confidence: "MEDIUM", direction: "LONG" });
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(scoreRegimeQuality({ controllerMode: "LONG_ONLY", confidence: "MEDIUM", direction: "LONG" }));
  });
});

describe("setup/momentum quality dimension (0-25)", () => {
  it("rewards volume surge and momentum together (no extension penalty when not chasing)", () => {
    const strong = scoreSetupQuality({ volumeRatio: 3, rocPercent: 5, atrExtension: 0 });
    expect(strong).toBeCloseTo(25, 1);
  });

  it("scores near 0 for average volume + flat momentum", () => {
    const weak = scoreSetupQuality({ volumeRatio: 1, rocPercent: 0, atrExtension: 0 });
    expect(weak).toBeCloseTo(0, 1);
  });

  it("collapses the score for a vertical over-extension (anti-chase)", () => {
    const chased = scoreSetupQuality({ volumeRatio: 3, rocPercent: 5, atrExtension: 3, maxHealthyAtrExtension: 3 });
    expect(chased).toBeCloseTo(0, 1); // extension at the max -> full penalty
  });

  // [NAN-GUARD, 2026-07-12 fix]: a NaN input (e.g. a 0/0 upstream) used to propagate silently
  // through clamp()'s Math.max/min into the returned score, corrupting totalScore instead of
  // scoring this dimension 0 like every other missing/bad-data case in this file.
  it("scores 0 (never NaN) when any input is non-finite", () => {
    expect(scoreSetupQuality({ volumeRatio: NaN, rocPercent: 5, atrExtension: 0 })).toBe(0);
    expect(scoreSetupQuality({ volumeRatio: 3, rocPercent: NaN, atrExtension: 0 })).toBe(0);
    expect(scoreSetupQuality({ volumeRatio: 3, rocPercent: 5, atrExtension: NaN })).toBe(0);
  });
});

describe("order-flow quality dimension (0-20)", () => {
  it("rewards buy pressure for a LONG", () => {
    expect(scoreOrderFlowQuality({ takerBuyRatio: 1.0, direction: "LONG" })).toBe(20);
    expect(scoreOrderFlowQuality({ takerBuyRatio: 0.5, direction: "LONG" })).toBe(0);
  });

  it("rewards sell pressure for a SHORT (inverted)", () => {
    expect(scoreOrderFlowQuality({ takerBuyRatio: 0.0, direction: "SHORT" })).toBe(20);
    expect(scoreOrderFlowQuality({ takerBuyRatio: 1.0, direction: "SHORT" })).toBe(0);
  });

  it("earns ZERO credit for missing data (never assumed favorable)", () => {
    expect(scoreOrderFlowQuality({ takerBuyRatio: null, direction: "LONG" })).toBe(0);
  });
});

describe("liquidity quality dimension (0-15)", () => {
  it("scores near max for near-zero cost", () => {
    const s = scoreLiquidityQuality({ spreadBps: 1, expectedSlippageBps: 1, maxSpreadBps: 20, maxSlippageBps: 20 });
    expect(s).toBeGreaterThan(13);
  });

  it("scores 0 at or beyond the operator's own max thresholds", () => {
    const s = scoreLiquidityQuality({ spreadBps: 25, expectedSlippageBps: 25, maxSpreadBps: 20, maxSlippageBps: 20 });
    expect(s).toBe(0);
  });

  it("scores 0 when data is missing (thin book / no quote)", () => {
    expect(scoreLiquidityQuality({ spreadBps: null, expectedSlippageBps: 5, maxSpreadBps: 20, maxSlippageBps: 20 })).toBe(0);
  });

  // [NAN-GUARD, 2026-07-12 fix]: `=== null` doesn't catch NaN — a spread/slippage computed as 0/0
  // upstream used to slip through and propagate NaN into the returned score instead of scoring 0
  // the way an explicit null (missing data) already did.
  it("scores 0 (never NaN) when spread/slippage is non-finite rather than null", () => {
    expect(scoreLiquidityQuality({ spreadBps: NaN, expectedSlippageBps: 5, maxSpreadBps: 20, maxSlippageBps: 20 })).toBe(0);
    expect(scoreLiquidityQuality({ spreadBps: 5, expectedSlippageBps: NaN, maxSpreadBps: 20, maxSlippageBps: 20 })).toBe(0);
  });
});

describe("derivatives context dimension (0-10)", () => {
  it("penalizes funding crowded in favor of the trade direction", () => {
    const crowded = scoreDerivativesQuality({ fundingZScore: 2, openInterestChangePercent: 0.5, direction: "LONG" });
    const neutral = scoreDerivativesQuality({ fundingZScore: 0, openInterestChangePercent: 0.5, direction: "LONG" });
    expect(crowded).toBeLessThan(neutral);
  });

  it("rewards rising open interest (fresh positioning) over falling OI", () => {
    const rising = scoreDerivativesQuality({ fundingZScore: 0, openInterestChangePercent: 1, direction: "LONG" });
    const falling = scoreDerivativesQuality({ fundingZScore: 0, openInterestChangePercent: -1, direction: "LONG" });
    expect(rising).toBeGreaterThan(falling);
  });

  it("never goes negative or above the dimension max even with all-missing data", () => {
    const s = scoreDerivativesQuality({ fundingZScore: null, openInterestChangePercent: null, direction: "LONG" });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(10);
  });
});

describe("composite decision score", () => {
  it("sums all five dimensions into a 0-100 total and verdicts ENTER above the threshold", () => {
    const r = computeDecisionScore({
      regime: { controllerMode: "LONG_ONLY", confidence: "HIGH", direction: "LONG" },
      setup: { volumeRatio: 3, rocPercent: 5, atrExtension: 0.5 },
      orderFlow: { takerBuyRatio: 0.9, direction: "LONG" },
      liquidity: { spreadBps: 2, expectedSlippageBps: 2, maxSpreadBps: 20, maxSlippageBps: 20 },
      derivatives: { fundingZScore: 0, openInterestChangePercent: 1, direction: "LONG" },
    });
    expect(r.totalScore).toBeGreaterThanOrEqual(75);
    expect(r.verdict).toBe("ENTER");
    expect(r.regimeScore + r.setupScore + r.orderFlowScore + r.liquidityScore + r.derivativesScore).toBeCloseTo(r.totalScore, 6);
  });

  it("verdicts NO_TRADE when the regime opposes the direction even if other dimensions are strong", () => {
    const r = computeDecisionScore({
      regime: { controllerMode: "SHORT_ONLY", confidence: "HIGH", direction: "LONG" },
      setup: { volumeRatio: 3, rocPercent: 5, atrExtension: 0.5 },
      orderFlow: { takerBuyRatio: 0.9, direction: "LONG" },
      liquidity: { spreadBps: 2, expectedSlippageBps: 2, maxSpreadBps: 20, maxSlippageBps: 20 },
      derivatives: { fundingZScore: 0, openInterestChangePercent: 1, direction: "LONG" },
    });
    expect(r.regimeScore).toBe(0);
    expect(r.totalScore).toBeLessThan(75);
  });

  it("verdicts WATCH in the middle band (not strong enough to enter, not weak enough to fully discard)", () => {
    const r = computeDecisionScore({
      regime: { controllerMode: "BOTH_ALLOWED", confidence: "HIGH", direction: "LONG" },
      setup: { volumeRatio: 2, rocPercent: 3, atrExtension: 0.5 },
      orderFlow: { takerBuyRatio: 0.75, direction: "LONG" },
      liquidity: { spreadBps: 3, expectedSlippageBps: 3, maxSpreadBps: 20, maxSlippageBps: 20 },
      derivatives: { fundingZScore: 0, openInterestChangePercent: 0.5, direction: "LONG" },
    });
    expect(r.totalScore).toBeGreaterThanOrEqual(50);
    expect(r.totalScore).toBeLessThan(75);
    expect(r.verdict).toBe("WATCH");
  });

  it("a single weak dimension does not automatically zero out the total (graded, not a hard gate)", () => {
    const r = computeDecisionScore({
      regime: { controllerMode: "LONG_ONLY", confidence: "HIGH", direction: "LONG" },
      setup: { volumeRatio: 3, rocPercent: 5, atrExtension: 0.5 },
      orderFlow: { takerBuyRatio: null, direction: "LONG" }, // missing order-flow data -> 0 on this dimension only
      liquidity: { spreadBps: 2, expectedSlippageBps: 2, maxSpreadBps: 20, maxSlippageBps: 20 },
      derivatives: { fundingZScore: 0, openInterestChangePercent: 1, direction: "LONG" },
    });
    expect(r.orderFlowScore).toBe(0);
    expect(r.totalScore).toBeGreaterThan(0); // the other 4 dimensions still contribute
  });
});

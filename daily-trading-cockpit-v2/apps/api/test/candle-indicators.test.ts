import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  computeEMA,
  computeROC,
  computeSMA,
  computeRSI,
  computeATR,
  computeBollingerBandWidth,
  computeATRPercentile,
} from "../src/lib/candle-indicators.js";

// ── regression fixtures: freeze the PRE-EXISTING functions' exact behavior ──────────────────────
// This file's build task added computeBollingerBandWidth/computeATRPercentile as PURELY ADDITIVE
// functions and must not have altered computeEMA/computeROC/computeSMA/computeRSI/computeATR in any
// way. These fixtures were captured against the untouched implementations (see the module's own
// unmodified source above the new functions) and pin every value byte-for-byte (via toBe, not
// toBeCloseTo) so any future edit to these functions — even a rounding tweak — fails this suite.

const closes = [100, 101, 99, 102, 105, 104, 106, 108, 107, 110, 112, 111, 109, 113, 115, 114, 116, 118, 117, 120];

let baseTime = 1_700_000_000_000;
function candle(close: number, high?: number, low?: number): Candle {
  const openTime = baseTime;
  baseTime += 3_600_000;
  return { openTime, open: close, high: high ?? close + 0.5, low: low ?? close - 0.5, close, volume: 1000 };
}
const candles: Candle[] = closes.map((c) => candle(c));

describe("candle-indicators — regression: pre-existing functions unchanged", () => {
  it("computeEMA(closes, 5) is byte-for-byte unchanged", () => {
    const out = computeEMA(closes, 5);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    expect(out[4]).toBe(101.4);
    expect(out[5]).toBeCloseTo(102.26666666666668, 12);
    expect(out[6]).toBeCloseTo(103.51111111111112, 12);
    expect(out[19]).toBeCloseTo(117.19810918002328, 10);
  });

  it("computeROC(closes, 5) is byte-for-byte unchanged", () => {
    const out = computeROC(closes, 5);
    expect(out.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(out[5]).toBeCloseTo(4, 12);
    expect(out[10]).toBeCloseTo(7.6923076923076925, 10);
    expect(out[19]).toBeCloseTo(4.3478260869565215, 10);
  });

  it("computeSMA(closes, 5) is byte-for-byte unchanged", () => {
    const out = computeSMA(closes, 5);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    expect(out[4]).toBe(101.4);
    expect(out[9]).toBe(107);
    expect(out[19]).toBe(117);
  });

  it("computeRSI(closes, 14) is byte-for-byte unchanged", () => {
    const out = computeRSI(closes, 14);
    expect(out.slice(0, 14)).toEqual(new Array(14).fill(null));
    expect(out[14]).toBeCloseTo(75.86206896551724, 10);
    expect(out[15]).toBeCloseTo(73.1457800511509, 10);
    expect(out[19]).toBeCloseTo(76.78459123201009, 10);
  });

  it("computeATR(candles, 14) is byte-for-byte unchanged", () => {
    const out = computeATR(candles, 14);
    expect(out.slice(0, 14)).toEqual(new Array(14).fill(null));
    expect(out[14]).toBeCloseTo(2.5714285714285716, 10);
    expect(out[15]).toBeCloseTo(2.4948979591836737, 10);
    expect(out[19]).toBeCloseTo(2.501308845591548, 10);
  });

  it("all 5 pre-existing functions still return arrays index-aligned to the input length", () => {
    expect(computeEMA(closes, 5)).toHaveLength(closes.length);
    expect(computeROC(closes, 5)).toHaveLength(closes.length);
    expect(computeSMA(closes, 5)).toHaveLength(closes.length);
    expect(computeRSI(closes, 14)).toHaveLength(closes.length);
    expect(computeATR(candles, 14)).toHaveLength(candles.length);
  });
});

describe("computeBollingerBandWidth — hand-computed correctness", () => {
  it("returns null before a full period window exists", () => {
    const out = computeBollingerBandWidth([10, 12, 14], 3, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
  });

  it("matches a hand-computed width at the first full window (period=3, mult=2)", () => {
    // closes [10,12,14]: mean=12, popVariance=((−2)²+0²+2²)/3=8/3, stdDev=√(8/3)≈1.6329931619
    // upper=12+2×1.6329931619=15.2659863238, lower=12−2×1.6329931619=8.7340136762
    // width=(upper−lower)/12 = 6.5319726475/12 ≈ 0.5443310539
    const out = computeBollingerBandWidth([10, 12, 14], 3, 2);
    expect(out[2]).toBeCloseTo(0.5443310539, 9);
  });

  it("matches a hand-computed width at the second full window (period=3, mult=2)", () => {
    // window [12,14,16]: mean=14, popVariance=8/3 (same spread), stdDev≈1.6329931619
    // width = 2×2×1.6329931619 / 14 = 6.5319726475/14 ≈ 0.4665694748
    const out = computeBollingerBandWidth([10, 12, 14, 16], 3, 2);
    expect(out[2]).toBeCloseTo(0.5443310539, 9);
    expect(out[3]).toBeCloseTo(0.4665694748, 9);
  });

  it("is exactly 0 for a perfectly flat window (no dispersion)", () => {
    const out = computeBollingerBandWidth([50, 50, 50, 50], 3, 2);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(0);
  });

  it("returns an all-null array when there are fewer closes than the period", () => {
    expect(computeBollingerBandWidth([1, 2], 3, 2)).toEqual([null, null]);
  });

  it("rejects a non-positive period", () => {
    expect(computeBollingerBandWidth([1, 2, 3], 0, 2)).toEqual([null, null, null]);
  });
});

describe("computeATRPercentile — hand-computed correctness (generic rolling percentile)", () => {
  it("returns null before a full window exists", () => {
    const out = computeATRPercentile([5, 3, 4, 1, 2], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
  });

  it("matches hand-computed percentiles over a non-monotonic series (window=3)", () => {
    // values=[5,3,4,1,2], window=3
    // i=2: window=[5,3,4], current=4 -> countLE(<=4)=2 ({3,4}) -> 2/3*100 = 66.666...
    // i=3: window=[3,4,1], current=1 -> countLE(<=1)=1 ({1})    -> 1/3*100 = 33.333...
    // i=4: window=[4,1,2], current=2 -> countLE(<=2)=2 ({1,2})  -> 2/3*100 = 66.666...
    const out = computeATRPercentile([5, 3, 4, 1, 2], 3);
    expect(out[2]).toBeCloseTo(66.66666666666667, 10);
    expect(out[3]).toBeCloseTo(33.33333333333333, 10);
    expect(out[4]).toBeCloseTo(66.66666666666667, 10);
  });

  it("scores the trailing MAXIMUM at 100 and the trailing MINIMUM above 0", () => {
    // strictly ascending series: current value is always the trailing-window max.
    const out = computeATRPercentile([1, 2, 3, 4, 5], 3);
    expect(out[2]).toBe(100);
    expect(out[3]).toBe(100);
    expect(out[4]).toBe(100);
  });

  it("propagates null: any null in the trailing window makes that index null", () => {
    const out = computeATRPercentile([1, null, 3, 4, 5], 3);
    expect(out[2]).toBeNull(); // window [1, null, 3]
    expect(out[3]).toBeNull(); // window [null, 3, 4]
    expect(out[4]).toBeCloseTo(100, 10); // window [3, 4, 5], no null
  });

  it("rejects a non-positive window", () => {
    expect(computeATRPercentile([1, 2, 3], 0)).toEqual([null, null, null]);
  });

  it("is generic: reused directly on a Bollinger-band-width series (same algorithm, different input)", () => {
    const bbw = computeBollingerBandWidth([10, 12, 14, 16, 10, 12], 3, 2);
    // bbw itself is null for indices 0-1 (period=3 not yet reached), so a window of 3 first
    // produces a non-null percentile once 3 CONSECUTIVE non-null bbw readings exist, i.e. index 4.
    const pctl = computeATRPercentile(bbw, 3);
    expect(pctl).toHaveLength(bbw.length);
    expect(pctl[0]).toBeNull();
    expect(pctl[1]).toBeNull();
    expect(pctl[2]).toBeNull(); // trailing window [bbw[0],bbw[1],bbw[2]] still contains nulls
    expect(pctl[3]).toBeNull(); // trailing window [bbw[1],bbw[2],bbw[3]] still contains a null
    expect(pctl[4]).not.toBeNull();
    expect(pctl[4]!).toBeGreaterThanOrEqual(0);
    expect(pctl[4]!).toBeLessThanOrEqual(100);
  });
});

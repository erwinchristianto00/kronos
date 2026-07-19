import { describe, it, expect } from "vitest";

import { buildRegimeAxisTimeline, computeRegimeAxisScore } from "../src/lib/regime-axis-timeline.js";
import type { RegimeEngineSnapshot } from "../src/lib/regime-engine-service.js";
import { isCrossSectionalAllocationIndependent } from "../src/lib/cross-sectional-executor.js";

const T0 = Date.parse("2099-01-02T00:00:00.000Z");

function snap(hoursFromT0: number, breadth: Partial<RegimeEngineSnapshot["breadth"]>, regime = "BEAR_TREND"): RegimeEngineSnapshot {
  return {
    at: new Date(T0 + hoursFromT0 * 3_600_000).toISOString(),
    btcPrice: 60000,
    regime,
    action: "NO_TRADE",
    lane: null,
    rejectedBy: null,
    noTradeReason: null,
    contradictions: [],
    spreadBps: 1,
    fundingRate: 0,
    fundingRiskAbnormal: false,
    breadth: {
      advancersPct: null,
      altAdvancersPct: null,
      percentAboveEma20: null,
      btcReturn24h: null,
      unavailableReason: null,
      ...breadth,
    },
  };
}

describe("regime-axis score (signed breadth composite, 0 = neutral)", () => {
  it("maps fully-bullish breadth to +1 and fully-bearish to -1", () => {
    expect(computeRegimeAxisScore({ advancersPct: 1, altAdvancersPct: null, percentAboveEma20: 1, btcReturn24h: 0.03, unavailableReason: null })).toBeCloseTo(1, 9);
    expect(computeRegimeAxisScore({ advancersPct: 0, altAdvancersPct: null, percentAboveEma20: 0, btcReturn24h: -0.03, unavailableReason: null })).toBeCloseTo(-1, 9);
  });

  it("balanced breadth sits at the neutral line", () => {
    expect(computeRegimeAxisScore({ advancersPct: 0.5, altAdvancersPct: null, percentAboveEma20: 0.5, btcReturn24h: 0, unavailableReason: null })).toBeCloseTo(0, 9);
  });

  it("uses only the available inputs, returns null when none are usable", () => {
    // Only BTC return present: +1.5% of the ±3% full scale = +0.5.
    expect(computeRegimeAxisScore({ advancersPct: null, altAdvancersPct: null, percentAboveEma20: null, btcReturn24h: 0.015, unavailableReason: null })).toBeCloseTo(0.5, 9);
    expect(computeRegimeAxisScore({ advancersPct: null, altAdvancersPct: null, percentAboveEma20: null, btcReturn24h: null, unavailableReason: "no data" })).toBeNull();
  });

  it("clamps an outsized BTC move instead of letting it dominate", () => {
    expect(computeRegimeAxisScore({ advancersPct: null, altAdvancersPct: null, percentAboveEma20: null, btcReturn24h: 0.5, unavailableReason: null })).toBeCloseTo(1, 9);
  });
});

describe("regime-axis timeline (slope + honest ETA-to-neutral)", () => {
  it("computes an ETA when the score is drifting TOWARD neutral", () => {
    // Bearish (-0.6) rising linearly toward 0 at +0.1/hour → ETA ≈ |current|/slope.
    const snaps = Array.from({ length: 7 }, (_, i) => {
      const score = -0.6 + 0.1 * i; // -0.6 … 0.0 over 6 hours
      // advancersPct*2-1 = score ⇒ advancersPct = (score+1)/2 (single-input composite)
      return snap(i, { advancersPct: (score + 1) / 2 });
    }).slice(0, 6); // stop before actually reaching 0 (current = -0.1)
    const tl = buildRegimeAxisTimeline(snaps);
    expect(tl.current!.score).toBeCloseTo(-0.1, 6);
    expect(tl.slopePerHour).toBeCloseTo(0.1, 6);
    expect(tl.etaToNeutralHours).toBeCloseTo(1, 4);
  });

  it("reports NO ETA when moving AWAY from neutral (deepening regime)", () => {
    const snaps = Array.from({ length: 6 }, (_, i) => snap(i, { advancersPct: ((-0.2 - 0.1 * i) + 1) / 2 }));
    const tl = buildRegimeAxisTimeline(snaps);
    expect(tl.slopePerHour).toBeLessThan(0);
    expect(tl.current!.score).toBeLessThan(0);
    expect(tl.etaToNeutralHours).toBeNull(); // same sign slope+score → drifting deeper, no crossing
  });

  it("reports NO ETA on a flat slope (too little signal to extrapolate)", () => {
    const snaps = Array.from({ length: 6 }, (_, i) => snap(i, { advancersPct: (0.4 + 1) / 2 }));
    const tl = buildRegimeAxisTimeline(snaps);
    expect(tl.etaToNeutralHours).toBeNull();
  });

  it("skips unusable-breadth snapshots and downsamples while keeping the newest point", () => {
    const snaps: RegimeEngineSnapshot[] = [];
    for (let i = 0; i < 500; i += 1) snaps.push(snap(i / 10, { advancersPct: 0.3 }));
    snaps.push(snap(60, { advancersPct: null, percentAboveEma20: null, btcReturn24h: null })); // unusable — dropped
    snaps.push(snap(61, { advancersPct: 0.9 }, "TREND_RECOVERY")); // the newest real point
    const tl = buildRegimeAxisTimeline(snaps, { maxPoints: 100 });
    expect(tl.points.length).toBeLessThanOrEqual(100);
    expect(tl.current!.regime).toBe("TREND_RECOVERY");
    expect(tl.points[tl.points.length - 1]!.at).toBe(tl.current!.at);
  });

  it("empty history yields a null current and no crash", () => {
    const tl = buildRegimeAxisTimeline([]);
    expect(tl.points).toEqual([]);
    expect(tl.current).toBeNull();
    expect(tl.etaToNeutralHours).toBeNull();
  });
});

describe("cross-sectional allocation independence flag", () => {
  it("is opt-in via CROSS_SECTIONAL_ALLOCATION_INDEPENDENT=1 only", () => {
    expect(isCrossSectionalAllocationIndependent({})).toBe(false);
    expect(isCrossSectionalAllocationIndependent({ CROSS_SECTIONAL_ALLOCATION_INDEPENDENT: "0" })).toBe(false);
    expect(isCrossSectionalAllocationIndependent({ CROSS_SECTIONAL_ALLOCATION_INDEPENDENT: "1" })).toBe(true);
  });
});

// 2026-07-08 operator: "prediksi arah + di titik mana masih FAST_SHORT, di titik mana ganti
// FAST_LONG" — projection is a labeled extrapolation; the lane switch is the ±0.12 NEUTRAL
// boundary cross, never the bottom of the bear zone (book data: counter-regime longs lose).
describe("regime-axis projection + lane-switch guidance", () => {
  // Single-input composite: advancersPct*2-1 = score ⇒ advancersPct = (score+1)/2.
  const mk = (scores: number[]) => scores.map((v, i) => snap(i, { advancersPct: (v + 1) / 2 }));

  it("bear + recovering: HOLD FAST_SHORT, switch only at −0.12 cross, with eta + projection", () => {
    // scores climbing −0.6 → −0.3 over 6h ⇒ slope ≈ +0.05/h, still deep bear.
    const t = buildRegimeAxisTimeline(mk([-0.6, -0.55, -0.5, -0.45, -0.4, -0.35, -0.3]));
    expect(t.guidance!.holdLane).toBe("CG_WIDE_FAST_SHORT");
    expect(t.guidance!.direction).toBe("MENUJU_NETRAL");
    expect(t.guidance!.switchAtScore).toBe(-0.12);
    expect(t.guidance!.etaToSwitchHours).toBeGreaterThan(0); // (−0.12 − −0.3)/0.05 ≈ 3.6h
    expect(t.projection.length).toBe(3); // explicit 1h / 3h / 6h forecast horizons
    expect(t.forecast.horizons.map((h) => h.hours)).toEqual([1, 3, 6]);
    expect(t.projection[0]!.score).toBeGreaterThan(-0.3); // forecast still recognizes recovery
    expect(t.forecast.confidence).toBe("LOW"); // only seven rows: do not manufacture certainty
    for (const h of t.forecast.horizons) {
      expect(h.lowerScore).toBeLessThanOrEqual(h.expectedScore);
      expect(h.upperScore).toBeGreaterThanOrEqual(h.expectedScore);
      expect(h.bullProbability + h.neutralProbability + h.bearProbability).toBeCloseTo(1, 8);
      expect(Math.max(h.bullProbability, h.neutralProbability, h.bearProbability)).toBeLessThan(1);
    }
  });

  it("bear + moving AWAY from neutral: FAST_SHORT with NO switch eta", () => {
    const t = buildRegimeAxisTimeline(mk([-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7]));
    expect(t.guidance!.holdLane).toBe("CG_WIDE_FAST_SHORT");
    expect(t.guidance!.direction).toBe("MENJAUH_NETRAL");
    expect(t.guidance!.etaToSwitchHours).toBeNull();
  });

  it("neutral zone: cross-sectional home, directional only after a ±0.12 cross", () => {
    const t = buildRegimeAxisTimeline(mk([-0.05, -0.03, 0, 0.02, 0.04, 0.05, 0.06]));
    expect(t.guidance!.holdLane).toBe("CROSS_SECTIONAL_MARKET_NEUTRAL");
    expect(t.guidance!.switchToLane).toBe("CG_WIDE_FAST_LONG");
    expect(t.guidance!.switchAtScore).toBe(0.12);
  });

  it("uses completed historical successors as analogs without hiding the sample count", () => {
    const scores = Array.from({ length: 120 }, (_, i) => {
      const cycle = i % 24;
      return Math.sin((cycle / 24) * Math.PI * 2) * 0.65;
    });
    const t = buildRegimeAxisTimeline(mk(scores));
    expect(t.forecast.available).toBe(true);
    expect(t.forecast.horizons).toHaveLength(3);
    expect(Math.max(...t.forecast.horizons.map((h) => h.analogCount))).toBeGreaterThanOrEqual(8);
    expect(t.forecast.horizons.find((h) => h.hours === 6)!.analogCount).toBeLessThan(t.forecast.horizons.find((h) => h.hours === 1)!.analogCount);
    expect(t.forecast.slopeAgreement).toBeGreaterThanOrEqual(0);
    expect(t.forecast.slopeAgreement).toBeLessThanOrEqual(1);
    expect(t.smoothedPoints).toHaveLength(t.points.length);
  });
});

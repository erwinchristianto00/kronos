import { describe, it, expect } from "vitest";
import {
  xsecReturnToR,
  laneNetAvgRGuarded,
  lanePfGuarded,
  crowdingAlignForLane,
  convictionForLane,
  portfolioDrawdownFraction,
  killBudgetUtilization,
  buildLaneObservationFromRaw,
  CORTEX_XSEC_STOP_RETURN,
  CORTEX_CROWD_ALIGNED,
  CORTEX_LANE_STALE_MAX_AGE_MS,
  type CortexLaneRaw,
  type CrowdSide,
} from "../src/lib/cortex-brain-gather.js";

describe("cortex-gather — #1 XSEC %→R", () => {
  it("converts basket fractional return by the source-of-truth stop distance (not ÷0.2)", () => {
    expect(CORTEX_XSEC_STOP_RETURN).toBeCloseTo(0.003, 6); // 30 bps
    const r = xsecReturnToR(0.00592, CORTEX_XSEC_STOP_RETURN, 77); // 0.592% avg
    expect(r.value).toBeCloseTo(0.00592 / 0.003, 6); // ≈1.97R
    expect(r.status).toBe("FRESH");
    expect(r.numerator).toBeCloseTo(0.00592, 6);
    expect(r.denominator).toBeCloseTo(0.003, 6);
  });
  it("null when n=0, non-finite return, or stop≤0", () => {
    expect(xsecReturnToR(0.005, 0.003, 0).value).toBeNull();
    expect(xsecReturnToR(null, 0.003, 10).value).toBeNull();
    expect(xsecReturnToR(0.005, 0, 10).value).toBeNull();
    expect(xsecReturnToR(0.005, 0, 10).status).toBe("MISSING");
  });
});

describe("cortex-gather — CG n=0 → null (not 0); PF unavailable → null (not 1)", () => {
  it("laneNetAvgRGuarded maps n=0 to null", () => {
    expect(laneNetAvgRGuarded(0, 0)).toEqual({ value: null, status: "MISSING" }); // fabricated flat → absent
    expect(laneNetAvgRGuarded(0.15, 40)).toEqual({ value: 0.15, status: "FRESH" });
  });
  it("lanePfGuarded returns null (not 1) when absent", () => {
    expect(lanePfGuarded(null, false)).toEqual({ value: null, status: "MISSING" });
    expect(lanePfGuarded(1.3, true)).toEqual({ value: 1.3, status: "FRESH" });
  });
  it("the all-wins 999 sentinel is treated as PF-unavailable (null), not a real high PF that saturates the feature", () => {
    expect(lanePfGuarded(999, true)).toEqual({ value: null, status: "MISSING" }); // no-losses = no denominator
    expect(lanePfGuarded(998.9, true)).toEqual({ value: 998.9, status: "FRESH" }); // a genuine (absurd) PF still passes
  });
});

// [2026-07-22 bug-hunt fix] STALE was declared in CortexFeatureStatus but no function ever computed
// it — a frozen upstream lane report looked FRESH forever, matching this codebase's real 18-day
// frozen-resolver incident. These prove the guard now actually returns STALE, and only when a real
// timestamp says so (never guessed from absence).
describe("cortex-gather — STALE detection (2026-07-22 bug-hunt fix)", () => {
  const NOW = 1_800_000_000_000;
  it("laneNetAvgRGuarded: FRESH when the cycle ran recently", () => {
    const staleness = { lastCycleAt: new Date(NOW - 60_000).toISOString(), nowMs: NOW };
    expect(laneNetAvgRGuarded(0.2, 50, staleness)).toEqual({ value: 0.2, status: "FRESH" });
  });
  it("laneNetAvgRGuarded: STALE when the last cycle is older than CORTEX_LANE_STALE_MAX_AGE_MS", () => {
    const staleness = { lastCycleAt: new Date(NOW - CORTEX_LANE_STALE_MAX_AGE_MS - 1).toISOString(), nowMs: NOW };
    expect(laneNetAvgRGuarded(0.2, 50, staleness)).toEqual({ value: 0.2, status: "STALE" });
  });
  it("lanePfGuarded: STALE when the last cycle is older than CORTEX_LANE_STALE_MAX_AGE_MS", () => {
    const staleness = { lastCycleAt: new Date(NOW - CORTEX_LANE_STALE_MAX_AGE_MS - 1).toISOString(), nowMs: NOW };
    expect(lanePfGuarded(1.3, true, staleness)).toEqual({ value: 1.3, status: "STALE" });
  });
  it("no lastCycleAt at all (store doesn't track one, e.g. IM/XSEC) never fabricates STALE or FRESH-by-default — stays FRESH exactly like before this fix", () => {
    expect(laneNetAvgRGuarded(0.2, 50, { lastCycleAt: null, nowMs: NOW })).toEqual({ value: 0.2, status: "FRESH" });
    expect(laneNetAvgRGuarded(0.2, 50, { lastCycleAt: undefined, nowMs: NOW })).toEqual({ value: 0.2, status: "FRESH" });
    expect(laneNetAvgRGuarded(0.2, 50)).toEqual({ value: 0.2, status: "FRESH" }); // omitted entirely
  });
  it("a MISSING lane (n=0) never becomes STALE — MISSING wins regardless of staleness", () => {
    const staleness = { lastCycleAt: new Date(NOW - CORTEX_LANE_STALE_MAX_AGE_MS - 1).toISOString(), nowMs: NOW };
    expect(laneNetAvgRGuarded(0, 0, staleness)).toEqual({ value: null, status: "MISSING" });
  });
});

describe("cortex-gather — #2 crowdingAlign (direction-relative, contrarian-leaning)", () => {
  it("aligned-with-crowd = −0.5, opposing = +0.25, balanced = 0", () => {
    expect(crowdingAlignForLane(["LONG"], "LONG").value).toBeCloseTo(-0.5, 6); // aligned
    expect(crowdingAlignForLane(["LONG"], "SHORT").value).toBeCloseTo(0.25, 6); // opposing
    expect(crowdingAlignForLane(["NEUTRAL"], "LONG").value).toBeCloseTo(0, 6); // balanced
  });
  it("means over the lane's symbols", () => {
    // LONG lane, crowds [long, long, short] → (−0.5 −0.5 +0.25)/3 = −0.25
    expect(crowdingAlignForLane(["LONG", "LONG", "SHORT"], "LONG").value).toBeCloseTo(-0.25, 6);
  });
  it("NEUTRAL lane → null; empty → null (MISSING)", () => {
    expect(crowdingAlignForLane(["LONG"], "NEUTRAL")).toEqual({ value: null, status: "MISSING" });
    expect(crowdingAlignForLane([], "LONG")).toEqual({ value: null, status: "MISSING" });
  });
});

describe("cortex-gather — #3 conviction (directional match, else 0.5)", () => {
  it("matching direction = actual; opposite = 1−conviction; NEUTRAL/BOTH = 0.5", () => {
    expect(convictionForLane("LONG", 0.85, "LONG")).toBeCloseTo(0.85, 6);
    expect(convictionForLane("LONG", 0.85, "SHORT")).toBeCloseTo(0.15, 6);
    expect(convictionForLane("SHORT", 0.85, "SHORT")).toBeCloseTo(0.85, 6);
    expect(convictionForLane("SHORT", 0.85, "LONG")).toBeCloseTo(0.15, 6);
    expect(convictionForLane("LONG", 0.85, "NEUTRAL")).toBe(0.5);
    expect(convictionForLane("BOTH", 0.85, "LONG")).toBe(0.5);
    expect(convictionForLane("UNKNOWN", 0.85, "SHORT")).toBe(0.5);
  });
  it("null conviction defaults to 0.5 for a matching directional lane", () => {
    expect(convictionForLane("LONG", null, "LONG")).toBe(0.5);
  });
});

describe("cortex-gather — two distinct drawdown signals (operator decision 1)", () => {
  it("portfolioDrawdownFraction = (peak − current)/peak, a peak-equity fraction (context feature)", () => {
    expect(portfolioDrawdownFraction(100, 88)).toBeCloseTo(0.12, 6);
    expect(portfolioDrawdownFraction(100, 100)).toBe(0); // at peak = 0
    expect(portfolioDrawdownFraction(100, 120)).toBe(0); // above peak clamps to 0
    expect(portfolioDrawdownFraction(null, 88)).toBe(0);
    expect(portfolioDrawdownFraction(0, 0)).toBe(0);
  });
  it("killBudgetUtilization = drawdownUsd / killBudget, NOT clamped at 1 (≥1 signals the kill rail band)", () => {
    expect(killBudgetUtilization(4.8, 40)).toBeCloseTo(0.12, 6);
    expect(killBudgetUtilization(40, 40)).toBe(1);
    expect(killBudgetUtilization(48, 40)).toBeCloseTo(1.2, 6); // past the budget — engine kill rail owns it
    expect(killBudgetUtilization(null, 40)).toBe(0);
    expect(killBudgetUtilization(5, 0)).toBe(0);
  });
});

describe("cortex-gather — buildLaneObservationFromRaw (full contract + status audit)", () => {
  function raw(over: Partial<CortexLaneRaw> = {}): CortexLaneRaw {
    return {
      laneId: "CG_WIDE_FAST_SHORT",
      direction: "SHORT",
      edgeMemAvgNetR: 0.12,
      edgeMemN: 71,
      vetoed: false,
      reportNetAvgR: 0.5,
      reportPf: 1.4,
      reportN: 71,
      hasReport: true,
      isXsec: false,
      xsecNetAvgReturn: null,
      xsecStopDistance: CORTEX_XSEC_STOP_RETURN,
      crowdSides: ["SHORT", "SHORT"] as CrowdSide[],
      kronosAgree: null,
      controllerBias: "SHORT",
      controllerConviction: 0.86,
      staticWeightPct: 0,
      nowMs: 1_800_000_000_000,
      ...over,
    };
  }

  it("[2026-07-22 bug-hunt fix, END-TO-END] surfaces STALE for a lane whose report store's cycleMeta.lastCycleAt is 18 days old (the real documented frozen-resolver incident)", () => {
    const NOW = 1_800_000_000_000;
    const eighteenDaysMs = 18 * 86_400_000;
    const { debug } = buildLaneObservationFromRaw(
      raw({ lastCycleAt: new Date(NOW - eighteenDaysMs).toISOString(), nowMs: NOW }),
    );
    expect(debug.laneNetAvgR).toBe("STALE");
    expect(debug.lanePf).toBe("STALE");
  });

  it("directional lane: full edge + conviction match + aligned-crowd negative + kronos null", () => {
    const { obs, debug } = buildLaneObservationFromRaw(raw());
    expect(obs.edgeMemAvgNetR).toBe(0.12);
    expect(obs.laneNetAvgR).toBe(0.5);
    expect(obs.laneNetAvgN).toBe(71); // sample count behind laneNetAvgR carried for the magnitude shrink
    expect(obs.convictionScore).toBeCloseTo(0.86, 6); // SHORT lane, SHORT bias → actual
    expect(obs.crowdingAlign).toBeCloseTo(-0.5, 6); // crowded-short + short lane = aligned
    expect(obs.kronosAgree).toBeNull();
    expect(debug.kronosAgree).toBe("MISSING");
  });

  it("XSEC neutral basket: edge from %→R only, no edge-memory/crowding/conviction, PF null", () => {
    const { obs, debug } = buildLaneObservationFromRaw(
      raw({ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", direction: "NEUTRAL", isXsec: true, xsecNetAvgReturn: 0.00592, reportPf: null, hasReport: true, edgeMemAvgNetR: null, edgeMemN: 0 }),
    );
    expect(obs.laneNetAvgR).toBeCloseTo(0.00592 / 0.003, 6);
    expect(obs.laneNetAvgN).toBe(71); // XSEC basket resolved-count carried through
    expect(obs.edgeMemAvgNetR).toBeNull();
    expect(obs.crowdingAlign).toBeNull();
    expect(obs.convictionScore).toBe(0.5);
    expect(obs.lanePf).toBeNull(); // NOT 1
    expect(obs.vetoed).toBe(false);
    expect(debug.lanePf).toBe("MISSING");
    expect(debug.xsecRawDenominator).toBeCloseTo(0.003, 6);
  });

  it("CG lane with n=0 → laneNetAvgR null (and laneNetAvgN 0), status MISSING (not a fabricated 0)", () => {
    const { obs, debug } = buildLaneObservationFromRaw(raw({ reportNetAvgR: 0, reportN: 0 }));
    expect(obs.laneNetAvgR).toBeNull();
    expect(obs.laneNetAvgN).toBe(0); // no samples ⇒ magnitude shrink degrades toward 0
    expect(debug.laneNetAvgR).toBe("MISSING");
  });
});

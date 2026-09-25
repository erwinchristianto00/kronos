import { describe, expect, it } from "vitest";

import {
  advanceDailyRangeFadeRTrail,
  bindDailyRangeFadeRTrail,
  createDailyRangeFadeRTrailState,
} from "../src/lib/daily-range-fade-r-trail.js";

const AT = Date.UTC(2026, 8, 1, 12, 0, 0);

function bound() {
  return bindDailyRangeFadeRTrail(createDailyRangeFadeRTrailState(new Date(AT).toISOString()), {
    entryPrice: 100,
    initialRiskPrice: 10,
    breakEvenFeeAndSlippageR: 0.1,
  });
}

function long(state: ReturnType<typeof bound>, price: number, offset = 0) {
  return advanceDailyRangeFadeRTrail({ state, direction: "LONG", price, eventTimeMs: AT + offset, receivedAtMs: AT + offset });
}

function short(state: ReturnType<typeof bound>, price: number, offset = 0) {
  return advanceDailyRangeFadeRTrail({ state, direction: "SHORT", price, eventTimeMs: AT + offset, receivedAtMs: AT + offset });
}

describe("Daily Range FADE R-trail V2", () => {
  it("arms at +0.50R, gives a minimum 0.25R of room, then exits only on a later causal floor breach", () => {
    let state = bound();
    state = long(state, 104.99).state;
    expect(state.trailArmed).toBe(false);

    state = long(state, 105, 1).state;
    expect(state.trailArmed).toBe(true);
    expect(state.checkpoint50At).not.toBeNull();
    expect(state.allowedGivebackR).toBeCloseTo(0.25);
    expect(state.mfeExitFloorR).toBeCloseTo(0.25);

    const breach = long(state, 102.5, 2);
    expect(breach.shouldExit).toBe(true);
    expect(breach.exitReason).toBe("FADE_R30_GIVEBACK_EXIT");
  });

  it("uses 30% after +1R, honours the fee/slippage BE floor, and never lowers protection", () => {
    let state = bound();
    state = long(state, 107.5).state; // +0.75R, minimum 0.25R -> floor +0.50R
    expect(state.checkpoint75At).not.toBeNull();
    expect(state.mfeExitFloorR).toBeCloseTo(0.5);

    state = long(state, 110, 1).state; // +1R, 30% -> floor +0.70R
    expect(state.checkpoint100At).not.toBeNull();
    expect(state.allowedGivebackR).toBeCloseTo(0.3);
    expect(state.mfeExitFloorR).toBeCloseTo(0.7);

    const retrace = long(state, 108, 2); // +0.8R, still above the frozen +0.7R floor
    expect(retrace.shouldExit).toBe(false);
    expect(retrace.state.mfeExitFloorR).toBeCloseTo(0.7);
    expect(long(retrace.state, 107, 3).shouldExit).toBe(true);
  });

  it("mirrors the same R math for short FADE trades and freezes actual-fill inputs once", () => {
    let state = bound();
    state = bindDailyRangeFadeRTrail(state, {
      entryPrice: 101,
      initialRiskPrice: 9,
      breakEvenFeeAndSlippageR: 0.01,
    });
    expect(state.entryPrice).toBe(100);
    expect(state.initialRiskPrice).toBe(10);
    expect(state.breakEvenFeeAndSlippageR).toBe(0.1);

    state = short(state, 92.5).state; // +0.75R
    expect(state.mfeExitFloorR).toBeCloseTo(0.5);
    expect(state.mfeExitFloorPrice).toBeCloseTo(95);
    expect(short(state, 95, 1).shouldExit).toBe(true);
  });
});

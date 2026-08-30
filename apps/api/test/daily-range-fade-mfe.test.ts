import { describe, expect, it } from "vitest";

import {
  advanceDailyRangeFadeMfe,
  bindDailyRangeFadeMfeTarget,
  createDailyRangeFadeMfeState,
  markDailyRangeFadeMfeDegraded,
} from "../src/lib/daily-range-fade-mfe.js";

const AT = Date.UTC(2026, 7, 30, 12, 0, 0);

function advanceLong(state: ReturnType<typeof createDailyRangeFadeMfeState>, price: number, offset = 0) {
  return advanceDailyRangeFadeMfe({ state, direction: "LONG", price, eventTimeMs: AT + offset, receivedAtMs: AT + offset });
}

function advanceShort(state: ReturnType<typeof createDailyRangeFadeMfeState>, price: number, offset = 0) {
  return advanceDailyRangeFadeMfe({ state, direction: "SHORT", price, eventTimeMs: AT + offset, receivedAtMs: AT + offset });
}

describe("Daily Range Fade MFE 50/75 V1", () => {
  it("does not arm below 50%, then permanently arms Stage 1 and ratchets only upward", () => {
    let state = bindDailyRangeFadeMfeTarget(createDailyRangeFadeMfeState(new Date(AT).toISOString()), {
      entryPrice: 100,
      structuralTakeProfit: 110,
    });
    state = advanceLong(state, 104.99).state;
    expect(state.stage1Armed).toBe(false);
    expect(state.mfeExitFloorProgress).toBeNull();

    state = advanceLong(state, 105, 1).state;
    expect(state.stage1Armed).toBe(true);
    expect(state.mfeExitFloorProgress).toBeCloseTo(0.25);

    state = advanceLong(state, 106, 2).state;
    expect(state.mfeExitFloorProgress).toBeCloseTo(0.3);
    state = advanceLong(state, 107, 3).state;
    expect(state.mfeExitFloorProgress).toBeCloseTo(0.35);
    const retrace = advanceLong(state, 106, 4);
    expect(retrace.state.stage1Armed).toBe(true);
    expect(retrace.state.mfeExitFloorProgress).toBeCloseTo(0.35);
    expect(retrace.shouldExit).toBe(false);
  });

  it("arms Stage 2 at 75%, retains two-thirds of later peak, and exits a long at the floor", () => {
    let state = bindDailyRangeFadeMfeTarget(createDailyRangeFadeMfeState(new Date(AT).toISOString()), {
      entryPrice: 100,
      structuralTakeProfit: 110,
    });
    state = advanceLong(state, 107.5).state;
    expect(state.stage1Armed).toBe(true);
    expect(state.stage2Armed).toBe(true);
    expect(state.mfeExitFloorProgress).toBeCloseTo(0.5);
    expect(state.mfeExitFloorPrice).toBeCloseTo(105);

    state = advanceLong(state, 109, 1).state;
    expect(state.peakMfeProgress).toBeCloseTo(0.9);
    expect(state.mfeExitFloorProgress).toBeCloseTo(0.6);
    expect(state.mfeExitFloorPrice).toBeCloseTo(106);
    const exit = advanceLong(state, 106, 2);
    expect(exit.shouldExit).toBe(true);
    expect(exit.exitReason).toBe("FADE_MFE_STAGE2_GIVEBACK_EXIT");
  });

  it("mirrors the exact Stage 1/2 arithmetic for a short", () => {
    let state = bindDailyRangeFadeMfeTarget(createDailyRangeFadeMfeState(new Date(AT).toISOString()), {
      entryPrice: 100,
      structuralTakeProfit: 90,
    });
    state = advanceShort(state, 95).state;
    expect(state.stage1Armed).toBe(true);
    expect(state.mfeExitFloorPrice).toBeCloseTo(97.5);
    state = advanceShort(state, 92.5, 1).state;
    expect(state.stage2Armed).toBe(true);
    expect(state.mfeExitFloorProgress).toBeCloseTo(0.5);
    expect(state.mfeExitFloorPrice).toBeCloseTo(95);
    state = advanceShort(state, 91, 2).state;
    expect(state.mfeExitFloorProgress).toBeCloseTo(0.6);
    expect(state.mfeExitFloorPrice).toBeCloseTo(94);
    const exit = advanceShort(state, 94, 3);
    expect(exit.shouldExit).toBe(true);
    expect(exit.exitReason).toBe("FADE_MFE_STAGE2_GIVEBACK_EXIT");
  });

  it("never rewrites the frozen actual fill/target and degrades without resetting its ratchet", () => {
    let state = bindDailyRangeFadeMfeTarget(createDailyRangeFadeMfeState(new Date(AT).toISOString()), {
      entryPrice: 100,
      structuralTakeProfit: 110,
    });
    state = bindDailyRangeFadeMfeTarget(state, { entryPrice: 101, structuralTakeProfit: 111 });
    expect(state.entryPrice).toBe(100);
    expect(state.structuralTakeProfit).toBe(110);
    state = advanceLong(state, 107).state;
    state = markDailyRangeFadeMfeDegraded(state, "contract stream interrupted", AT + 1);
    expect(state.health).toBe("DEGRADED");
    expect(state.stage1Armed).toBe(true);
    expect(state.mfeExitFloorProgress).toBeCloseTo(0.35);
  });
});

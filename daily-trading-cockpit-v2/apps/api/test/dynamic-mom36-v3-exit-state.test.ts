import { describe, expect, it } from "vitest";
import {
  advanceDynamicMom36V3ExitState,
  type DynamicMom36V3ExitState,
} from "../src/lib/cross-sectional-executor.js";

const T0 = "2026-08-25T12:00:00.000Z";

function state(): DynamicMom36V3ExitState {
  return {
    version: "DYNAMIC_MOM36_V3_EXIT",
    hardCutLossThreshold: -0.02,
    mfeArmThreshold: 0.03,
    mfeGivebackFraction: 0.30,
    mfeTrailingFraction: 0.70,
    mfeTrailArmed: false,
    peakMfeReturn: null,
    mfeTrailingFloor: null,
    lastObservedReturn: null,
    lastObservedAt: null,
    mfeFloorWasBreached: false,
    exitTrigger: null,
    realizedNetReturn: null,
    forwardCounterfactual: {
      sourceObservationId: "source-1",
      horizonAtMs: Date.parse(T0) + 36 * 3_600_000,
      status: "PENDING_CANONICAL_36H",
    },
  };
}

function step(exit: DynamicMom36V3ExitState, currentReturn: number, n: number): ReturnType<typeof advanceDynamicMom36V3ExitState> {
  return advanceDynamicMom36V3ExitState(exit, currentReturn, new Date(Date.parse(T0) + n * 60_000).toISOString());
}

describe("Dynamic MOM36 v3 exit machine", () => {
  it("holds above -2%, triggers exactly at -2%, and records the actual first observed gap", () => {
    const normal = state();
    expect(step(normal, -0.0199, 1)).toBeNull();
    expect(normal.exitTrigger).toBeNull();
    expect(step(normal, -0.02, 2)).toBe("HARD_CUT_LOSS_2");
    expect(normal.exitTrigger).toMatchObject({ reason: "HARD_CUT_LOSS_2", observedReturn: -0.02 });

    const gap = state();
    expect(step(gap, -0.015, 1)).toBeNull();
    expect(step(gap, -0.028, 2)).toBe("HARD_CUT_LOSS_2");
    expect(gap.exitTrigger).toMatchObject({ reason: "HARD_CUT_LOSS_2", observedReturn: -0.028 });
  });

  it("restores the same hard-stop state after a restart without a grace period", () => {
    const beforeRestart = state();
    expect(step(beforeRestart, -0.011, 1)).toBeNull();
    const restored = JSON.parse(JSON.stringify(beforeRestart)) as DynamicMom36V3ExitState;
    expect(step(restored, -0.023, 2)).toBe("HARD_CUT_LOSS_2");
    expect(restored.exitTrigger).toMatchObject({ observedReturn: -0.023, reason: "HARD_CUT_LOSS_2" });
  });

  it("does not arm before +3%, arms exactly at +3%, and never lowers the floor", () => {
    const exit = state();
    for (const [index, currentReturn] of [0, 0.01, 0.02, 0.0299, 0.02].entries()) {
      expect(step(exit, currentReturn, index)).toBeNull();
    }
    expect(exit.mfeTrailArmed).toBe(false);
    expect(step(exit, 0.03, 6)).toBeNull();
    expect(exit.mfeTrailArmed).toBe(true);
    expect(exit.peakMfeReturn).toBe(0.03);
    expect(exit.mfeTrailingFloor).toBeCloseTo(0.021, 12);

    expect(step(exit, 0.05, 7)).toBeNull();
    expect(exit.mfeTrailingFloor).toBeCloseTo(0.035, 12);
    expect(step(exit, 0.08, 8)).toBeNull();
    expect(exit.mfeTrailingFloor).toBeCloseTo(0.056, 12);
    expect(step(exit, 0.10, 9)).toBeNull();
    expect(exit.mfeTrailingFloor).toBeCloseTo(0.07, 12);
    expect(step(exit, 0.08, 10)).toBeNull();
    expect(exit.mfeTrailingFloor).toBeCloseTo(0.07, 12);
    expect(step(exit, 0.07, 11)).toBe("MFE_GIVEBACK_30");
    expect(exit.exitTrigger).toMatchObject({ reason: "MFE_GIVEBACK_30", observedReturn: 0.07 });
    expect(exit.exitTrigger?.mfeTrailingFloor).toBeCloseTo(0.07, 12);
  });

  it("uses MFE before the hard stop normally, but labels a gap across both boundaries as hard cut", () => {
    const normalMfe = state();
    expect(step(normalMfe, 0.03, 1)).toBeNull();
    expect(step(normalMfe, 0.05, 2)).toBeNull();
    expect(step(normalMfe, 0.035, 3)).toBe("MFE_GIVEBACK_30");

    const collision = state();
    expect(step(collision, 0.05, 1)).toBeNull();
    expect(collision.mfeTrailingFloor).toBeCloseTo(0.035, 12);
    expect(step(collision, -0.025, 2)).toBe("HARD_CUT_LOSS_2");
    expect(collision.exitTrigger).toMatchObject({
      reason: "HARD_CUT_LOSS_2",
      observedReturn: -0.025,
      mfeFloorWasBreached: true,
    });
    expect(collision.mfeFloorWasBreached).toBe(true);
  });

  it("uses one state machine for 6L0S and 0L6S basket returns", () => {
    for (const label of ["6L0S", "0L6S"]) {
      const exit = state();
      expect(step(exit, -0.0201, 1), label).toBe("HARD_CUT_LOSS_2");
      expect(exit.exitTrigger?.observedReturn).toBe(-0.0201);
    }
  });
});

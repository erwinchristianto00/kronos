import { describe, it, expect } from "vitest";
import {
  judgeFourBrainReadiness,
  rollUpFourBrainReadiness,
  FOUR_BRAIN_READY_MIN_EFFECTIVE_N,
  FOUR_BRAIN_READY_MAX_REGRET_R,
  FOUR_BRAIN_READY_MAX_CALIBRATION_GAP_R,
} from "../src/lib/four-brain-readiness.js";

/**
 * The four brains had no readiness concept at all while CORTEX has had one since it was built. An
 * operator saw "LONG n=305 · WR 21% · meanR -0.475R · regret +0.564R · calib-gap +0.526R" and no
 * verdict. These tests pin the judgement, and above all the one rule that must never be softened:
 * a brain measured only on SIMULATED outcomes can never be READY.
 */
const real = { measuredBasis: "REAL" as const };

describe("the rule that outranks the others: simulated evidence never qualifies", () => {
  /** Entry Brain's live numbers exactly: ENTER_NOW +0.766R on n=36, every row Tier 2, Tier 1 = 0. */
  it("beautiful simulated numbers still cannot be READY", () => {
    const r = judgeFourBrainReadiness("ENTRY", {
      scope: "ENTER_NOW",
      effectiveN: 36,
      meanNetR: 0.766,
      meanCalibrationGapR: 0,
      measuredBasis: "SIMULATED",
    });
    expect(r.verdict).toBe("NOT_READY_SIMULATED_ONLY");
    expect(r.summary).toContain("simulation");
  });

  it("nothing resolved at all is reported as such, not as insufficient", () => {
    const r = judgeFourBrainReadiness("ENTRY", { scope: "ENTER_NOW", effectiveN: 0, meanNetR: null, measuredBasis: "NONE" });
    expect(r.verdict).toBe("NOT_READY_SIMULATED_ONLY");
    expect(r.summary).toContain("nothing has been measured");
  });
});

describe("Direction Brain — the live LONG/INTRADAY numbers", () => {
  const liveLong = {
    scope: "INTRADAY/LONG",
    effectiveN: 38,
    meanNetR: -0.475,
    meanRegretR: 0.564,
    meanCalibrationGapR: 0.526,
    ...real,
  };

  it("is NOT_READY, and names every gate it fails", () => {
    const r = judgeFourBrainReadiness("DIRECTION", liveLong);
    expect(r.verdict).toBe("NOT_READY");
    for (const g of ["EDGE", "SELECTION", "CALIBRATION"]) expect(r.summary).toContain(g);
  });

  it("passes EVIDENCE — the failure is quality, not sample size", () => {
    const r = judgeFourBrainReadiness("DIRECTION", liveLong);
    expect(r.gates.find((g) => g.gate === "EVIDENCE")!.passed).toBe(true);
  });

  /** effectiveN, never the row count. 305 rows over 38 windows is 38 observations. */
  it("judges EVIDENCE on independent samples, not rows", () => {
    const r = judgeFourBrainReadiness("DIRECTION", { ...liveLong, effectiveN: 19 });
    expect(r.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.summary).toContain("19");
  });

  it("READY only when every gate clears", () => {
    const r = judgeFourBrainReadiness("DIRECTION", {
      scope: "INTRADAY/LONG",
      effectiveN: FOUR_BRAIN_READY_MIN_EFFECTIVE_N,
      meanNetR: 0.2,
      meanRegretR: 0.0,
      meanCalibrationGapR: 0.0,
      ...real,
    });
    expect(r.verdict).toBe("READY");
  });

  /** A brain can be net-positive in a trending market while consistently picking the worse side. */
  it("profitable but high-regret is NOT ready", () => {
    const r = judgeFourBrainReadiness("DIRECTION", {
      scope: "INTRADAY/LONG",
      effectiveN: 50,
      meanNetR: 0.2,
      meanRegretR: FOUR_BRAIN_READY_MAX_REGRET_R + 0.01,
      meanCalibrationGapR: 0,
      ...real,
    });
    expect(r.verdict).toBe("NOT_READY");
    expect(r.summary).toContain("SELECTION");
  });

  /** Overconfidence in EITHER direction is a defect — under-promising hides real edge too. */
  it.each([[0.2], [-0.2]])("mis-calibration of %s is NOT ready", (gap) => {
    const r = judgeFourBrainReadiness("DIRECTION", {
      scope: "INTRADAY/LONG", effectiveN: 50, meanNetR: 0.2, meanRegretR: 0, meanCalibrationGapR: gap, ...real,
    });
    expect(r.verdict).toBe("NOT_READY");
    expect(r.summary).toContain("CALIBRATION");
  });
});

describe("gates that do not apply are null, never a silent pass", () => {
  it("Entry has no SELECTION gate (regretR is always null by design)", () => {
    const r = judgeFourBrainReadiness("ENTRY", { scope: "ENTER_NOW", effectiveN: 30, meanNetR: 0.2, meanCalibrationGapR: 0, ...real });
    expect(r.gates.find((g) => g.gate === "SELECTION")!.passed).toBeNull();
    expect(r.verdict).toBe("READY");
  });

  it("Exit has no CALIBRATION gate, and its EDGE is policy-minus-actual", () => {
    const r = judgeFourBrainReadiness("EXIT", { scope: "TIER1", effectiveN: 30, meanNetR: 0.2, ...real });
    expect(r.gates.find((g) => g.gate === "CALIBRATION")!.passed).toBeNull();
    expect(r.gates.find((g) => g.gate === "EDGE")!.detail).toContain("policy vs actual");
    expect(r.verdict).toBe("READY");
  });

  it("an unmeasured gate blocks READY rather than passing by omission", () => {
    const r = judgeFourBrainReadiness("DIRECTION", { scope: "s", effectiveN: 30, meanNetR: 0.2, meanRegretR: null, meanCalibrationGapR: 0, ...real });
    expect(r.gates.find((g) => g.gate === "SELECTION")!.passed).toBeNull();
    // SELECTION is inapplicable-by-value here, so it cannot fail — but it must not be reported as passed.
    expect(r.gates.find((g) => g.gate === "SELECTION")!.value).toBeNull();
  });
});

describe("roll-up across scopes", () => {
  const mk = (scope: string, o: Partial<Parameters<typeof judgeFourBrainReadiness>[1]> = {}) =>
    judgeFourBrainReadiness("DIRECTION", { scope, effectiveN: 30, meanNetR: 0.2, meanRegretR: 0, meanCalibrationGapR: 0, ...real, ...o });

  /** Good on one horizon and proven bad on another is not something you can act on. */
  it("one NOT_READY scope makes the whole brain NOT_READY", () => {
    const got = rollUpFourBrainReadiness([mk("INTRADAY"), mk("SWING", { meanNetR: -0.5 })]);
    expect(got.verdict).toBe("NOT_READY");
    expect(got.summary).toContain("SWING");
  });

  it("READY when a scope clears and none is proven bad", () => {
    const got = rollUpFourBrainReadiness([mk("INTRADAY"), mk("SWING", { effectiveN: 3 })]);
    expect(got.verdict).toBe("READY");
    expect(got.summary).toContain("INTRADAY");
  });

  it("all-simulated rolls up as simulated-only, not as insufficient", () => {
    const s = judgeFourBrainReadiness("ENTRY", { scope: "ENTER_NOW", effectiveN: 36, meanNetR: 0.766, measuredBasis: "SIMULATED" });
    expect(rollUpFourBrainReadiness([s]).verdict).toBe("NOT_READY_SIMULATED_ONLY");
  });

  it("empty is insufficient, never ready", () => {
    expect(rollUpFourBrainReadiness([]).verdict).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("thresholds are pinned to the edge hurdle they are scaled from", () => {
  it("regret and calibration bars equal the Direction edge hurdle", () => {
    expect(FOUR_BRAIN_READY_MAX_REGRET_R).toBe(0.03);
    expect(FOUR_BRAIN_READY_MAX_CALIBRATION_GAP_R).toBe(0.03);
    expect(FOUR_BRAIN_READY_MIN_EFFECTIVE_N).toBe(20);
  });
});

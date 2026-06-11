import { describe, expect, it } from "vitest";

import {
  computeCalibratedExpectedR,
  emptyCalibrationEvidence,
  type CalibrationEvidence,
  type CalibratedExpectancyInput,
} from "../src/calibrated-expectancy.js";

function baseInput(overrides: Partial<CalibratedExpectancyInput> = {}): CalibratedExpectancyInput {
  return {
    rawExpectedGrossR: 0.7,
    rawExpectedNetR: 0.6,
    selectedEntryVariant: "fib_500_entry",
    selectedExitVariant: "tp1_full_exit",
    symbol: "BTCUSDT",
    direction: "LONG",
    routeMode: "DATA_COLLECTION",
    selectionSource: "heuristic_fallback",
    evidence: emptyCalibrationEvidence(),
    ...overrides,
  };
}

describe("computeCalibratedExpectedR — sample size gating", () => {
  it("returns INSUFFICIENT_SAMPLE with no adjustment when no evidence exists", () => {
    const r = computeCalibratedExpectedR(baseInput());
    expect(r.calibrationSourceUsed).toBe("none");
    expect(r.calibrationVerdict).toBe("INSUFFICIENT_SAMPLE");
    expect(r.calibrationPenaltyR).toBe(0);
    expect(r.calibratedExpectedNetR).toBe(0.6);
    expect(r.calibrationConfidence).toBe("LOW");
  });

  it("does not hard-downgrade when combo sample < 5 (LOW confidence, INSUFFICIENT_SAMPLE)", () => {
    const evidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 4,
          avgExpectedNetR: 0.6,
          avgRealizedNetR: -0.8,
          expectationError: 1.4, // big overestimation
        },
      },
    };
    const r = computeCalibratedExpectedR(baseInput({ evidence }));
    expect(r.calibrationConfidence).toBe("LOW");
    expect(r.calibrationVerdict).toBe("INSUFFICIENT_SAMPLE");
    expect(r.calibrationPenaltyR).toBe(0);
    expect(r.calibratedExpectedNetR).toBe(0.6);
  });

  it("applies combo-level calibration when sample ≥ 5", () => {
    const evidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 9,
          avgExpectedNetR: 0.6,
          avgRealizedNetR: -0.5,
          expectationError: 1.1,
        },
      },
    };
    const r = computeCalibratedExpectedR(baseInput({ evidence }));
    expect(r.calibrationSourceUsed).toBe("combo");
    expect(r.calibrationSampleSize).toBe(9);
    expect(r.calibrationConfidence).toBe("MEDIUM");
    expect(r.calibrationPenaltyR).toBeLessThan(0); // downward adjustment
    expect((r.calibratedExpectedNetR ?? 0)).toBeLessThan(r.rawExpectedNetR ?? 0);
  });
});

describe("computeCalibratedExpectedR — verdict semantics", () => {
  it("raw positive but realized negative → RAW_EDGE_NOT_VALIDATED", () => {
    const evidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 9,
          avgExpectedNetR: 0.5,
          avgRealizedNetR: -0.6,
          expectationError: 1.1,
        },
      },
    };
    const r = computeCalibratedExpectedR(baseInput({ rawExpectedNetR: 0.6, evidence }));
    expect(r.calibrationVerdict).toBe("RAW_EDGE_NOT_VALIDATED");
    expect((r.calibratedExpectedNetR ?? 1)).toBeLessThanOrEqual(0);
  });

  it("HEURISTIC_OVERCONFIDENT diagnosis amplifies the downward penalty", () => {
    const flatEvidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 9,
          avgExpectedNetR: 0.4,
          avgRealizedNetR: -0.2,
          expectationError: 0.6,
        },
      },
    };
    const flaggedEvidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 9,
          avgExpectedNetR: 0.4,
          avgRealizedNetR: -0.2,
          expectationError: 0.6,
          diagnosis: ["HEURISTIC_OVERCONFIDENT"],
        },
      },
    };
    const flat = computeCalibratedExpectedR(baseInput({ evidence: flatEvidence }));
    const flagged = computeCalibratedExpectedR(baseInput({ evidence: flaggedEvidence }));
    expect(flagged.calibrationPenaltyR).toBeLessThan(flat.calibrationPenaltyR);
  });

  it("no positive boost unless sample ≥ 30 AND realized net R is positive", () => {
    // 10 samples, realized > expected (underestimation): should NOT boost.
    const underEvidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 10,
          avgExpectedNetR: 0.1,
          avgRealizedNetR: 0.4,
          expectationError: -0.3, // realized higher than expected
        },
      },
    };
    const underRes = computeCalibratedExpectedR(baseInput({ rawExpectedNetR: 0.2, evidence: underEvidence }));
    expect(underRes.calibrationPenaltyR).toBe(0); // boost blocked
    expect(underRes.calibratedExpectedNetR).toBe(0.2);

    // 35 samples + realized positive: boost allowed (but capped).
    const validEvidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 35,
          avgExpectedNetR: 0.1,
          avgRealizedNetR: 0.4,
          expectationError: -0.3,
        },
      },
    };
    const validRes = computeCalibratedExpectedR(baseInput({ rawExpectedNetR: 0.2, evidence: validEvidence }));
    expect(validRes.calibrationPenaltyR).toBeGreaterThan(0);
    expect(validRes.calibrationPenaltyR).toBeLessThanOrEqual(0.5); // capped
    expect(validRes.calibrationConfidence).toBe("HIGH");
  });
});

describe("computeCalibratedExpectedR — adjustment caps", () => {
  it("downward adjustment is capped at -2.5R", () => {
    const evidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 50,
          avgExpectedNetR: 5,
          avgRealizedNetR: -5,
          expectationError: 10, // would push -10R without cap
          diagnosis: ["HEURISTIC_OVERCONFIDENT"],
        },
      },
    };
    const r = computeCalibratedExpectedR(baseInput({ rawExpectedNetR: 3, evidence }));
    expect(r.calibrationPenaltyR).toBe(-2.5);
    expect(r.calibratedExpectedNetR).toBe(0.5); // 3 - 2.5
  });

  it("upward adjustment is capped at +0.5R", () => {
    const evidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 60,
          avgExpectedNetR: 0,
          avgRealizedNetR: 2,
          expectationError: -2, // would push +2R without cap
        },
      },
    };
    const r = computeCalibratedExpectedR(baseInput({ rawExpectedNetR: 0.1, evidence }));
    expect(r.calibrationPenaltyR).toBe(0.5);
    expect(r.calibratedExpectedNetR).toBe(0.6);
  });
});

describe("computeCalibratedExpectedR — source resolution", () => {
  it("falls back to symbol+combo when combo has too few samples", () => {
    const evidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      combos: {
        fib_500_entry__tp1_full_exit: {
          count: 3, // below MIN_USABLE_SAMPLE
          avgExpectedNetR: 0.6,
          avgRealizedNetR: -0.5,
          expectationError: 1.1,
        },
      },
      symbolCombos: {
        "BTCUSDT__fib_500_entry__tp1_full_exit": {
          count: 8,
          avgExpectedNetR: 0.6,
          avgRealizedNetR: -0.6,
          expectationError: 1.2,
        },
      },
    };
    const r = computeCalibratedExpectedR(baseInput({ evidence }));
    expect(r.calibrationSourceUsed).toBe("symbol+combo");
    expect(r.calibrationSampleSize).toBe(8);
  });

  it("falls back to routeMode when nothing else has enough sample", () => {
    const evidence: CalibrationEvidence = {
      ...emptyCalibrationEvidence(),
      routeModes: {
        DATA_COLLECTION: {
          count: 25,
          avgExpectedNetR: 0.5,
          avgRealizedNetR: -1.0,
          expectationError: 1.5,
        },
      },
    };
    const r = computeCalibratedExpectedR(baseInput({ evidence }));
    expect(r.calibrationSourceUsed).toBe("routeMode");
    expect(r.calibrationSampleSize).toBe(25);
  });
});

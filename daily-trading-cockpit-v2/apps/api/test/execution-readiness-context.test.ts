import { describe, expect, it } from "vitest";

import { hasExactContextReadinessProof } from "../src/app.js";
import type { ContextLaneStatusLookup } from "../src/lib/current-guard-variant-matrix.js";

function proof(overrides: Partial<ContextLaneStatusLookup> = {}): ContextLaneStatusLookup {
  return {
    laneId: "CG_WIDE_FAST_SHORT",
    context: "SHORT_BEARISH",
    applicable: true,
    direct: true,
    status: "COLLECTING",
    statusReason: "test",
    blockers: [],
    cautions: [],
    evidence: {
      context: "SHORT_BEARISH",
      freshValid: 1,
      netAvgR: null,
      grossAvgR: null,
      pf: null,
      wr: null,
      payoffRatio: null,
      plus10bpsNetAvgR: null,
      plus10bpsStillPositive: false,
      approxMaxDrawdownR: null,
      topSymbolPnlShare: null,
      calendarDays: null,
      distinctRegimes: 0,
      oosThirds: null,
      allThreeOosPositive: false,
      status: "COLLECTING",
      statusReason: "test",
      blockers: [],
      cautions: [],
    },
    ...overrides,
  };
}

describe("execution readiness exact-context boundary", () => {
  it("permits maturity evaluation only for direct, applicable, evidence-backed contexts", () => {
    // COLLECTING remains eligible for a later, explicit maturity override; it is not itself ready.
    expect(hasExactContextReadinessProof(proof())).toBe(true);
    expect(hasExactContextReadinessProof(proof({ context: null, applicable: false, direct: false, evidence: null }))).toBe(false);
    expect(hasExactContextReadinessProof(proof({ status: "NOT_APPLICABLE", applicable: false, evidence: null }))).toBe(false);
    expect(hasExactContextReadinessProof(proof({ direct: false, evidence: null }))).toBe(false);
    expect(hasExactContextReadinessProof(proof({ evidence: null }))).toBe(false);
  });
});

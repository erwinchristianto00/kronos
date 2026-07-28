import { describe, it, expect } from "vitest";
import { buildFourBrainGatherInput, type FourBrainBindingDeps } from "../src/lib/four-brain-live-gather-bindings.js";
import { HORIZON_MS } from "../src/lib/direction-brain-resolver.js";

/**
 * SCALP/LONG and SCALP/SHORT sat at "0 independent samples" for this layer's entire life, and the
 * readiness panel enumerated them as gaps. The cause was one line: the gather's default horizon list
 * was ["INTRADAY","SWING"] and nothing ever passed an override. A horizon nobody asks for reads
 * exactly like one that is failing.
 *
 * It is also the fastest evidence available here — effectiveN counts DISTINCT horizon blocks, so a
 * 1h horizon clears the ≥20 readiness bar roughly 4x sooner than INTRADAY and 24x sooner than SWING.
 */
const MIN = 60_000;
const NOW = 1_800_000_000_000;

function deps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
  return {
    instanceId: "test",
    nowMs: NOW,
    axisScore: 0.4, axisAtMs: NOW - 2 * MIN, axisSlopePerHour: 0.01,
    btcAtrPercentile: null, atrAtMs: null,
    advancersPct: 0.55, breadthAtMs: NOW - 2 * MIN,
    sentiment: null, sentimentAtMs: null,
    safetyEvents: [],
    regimeRaw: "Bullish expansion",
    edgeMemory: {
      lookup: () => ({ avgNetR: 0.1, n: 40 }),
      verdict: () => ({ decision: "ALLOW_PROVEN" }),
      hasPositiveLane: () => true,
    },
    controllerBias: "LONG", convictionScore: 0.6, allowsLong: true, allowsShort: false,
    bestLaneReportForDirection: () => null,
    crowdAlignLong: null, crowdAtMs: null, kronosAgree: null, kronosAtMs: null,
    openSignals: [],
    maxSignalAgeMs: 50 * MIN,
    crowdingStateForSymbol: () => null,
    openPositions: [],
    markPriceForSymbol: () => ({ price: null, atMs: null }),
    cortexDecisionId: "c", cortexFinalPctForLane: () => 40, laneEligibleIncumbent: () => true,
    killLatched: false, killReason: null,
    ...o,
  } as FourBrainBindingDeps;
}

describe("SCALP is measured by default", () => {
  /** FAILS WITHOUT THE FIX — the default was ["INTRADAY","SWING"]. */
  it("the gather builds a Direction input for all three horizons", () => {
    const got = buildFourBrainGatherInput(deps());
    expect(got.directions.map((d) => d.horizon).sort()).toEqual(["INTRADAY", "SCALP", "SWING"]);
  });

  it("an explicit override still wins — this is a default, not a hardcode", () => {
    const got = buildFourBrainGatherInput(deps({ horizons: ["SWING"] }));
    expect(got.directions.map((d) => d.horizon)).toEqual(["SWING"]);
  });

  /** The resolver must be able to score what the gather now emits, or the rows would pile up
   *  pending forever — which is the same empty column in a different disguise. */
  it("the resolver knows SCALP, and it is the shortest horizon", () => {
    expect(HORIZON_MS.SCALP).toBe(60 * MIN);
    expect(HORIZON_MS.SCALP).toBeLessThan(HORIZON_MS.INTRADAY);
    expect(HORIZON_MS.INTRADAY).toBeLessThan(HORIZON_MS.SWING);
  });

  /** Why it is worth adding at all: readiness needs ≥20 DISTINCT horizon blocks, so the shortest
   *  horizon is the only one that can produce a verdict in days rather than weeks. */
  it("reaches the readiness bar 4x sooner than INTRADAY and 24x sooner than SWING", () => {
    const hoursTo20 = (ms: number) => (20 * ms) / 3_600_000;
    expect(hoursTo20(HORIZON_MS.SCALP)).toBe(20);
    expect(hoursTo20(HORIZON_MS.INTRADAY) / hoursTo20(HORIZON_MS.SCALP)).toBe(4);
    expect(hoursTo20(HORIZON_MS.SWING) / hoursTo20(HORIZON_MS.SCALP)).toBe(24);
  });
});

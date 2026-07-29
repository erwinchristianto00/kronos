/**
 * Regression tests for the real bestLaneReportForDirection producer that replaced app.ts's permanent
 * `bestLaneReportForDirection: () => null` stub in buildFourBrainDeps — item 2 of the 3 permanent-null
 * four-brain data gaps (see btc-atr-percentile-cache.test.ts for item 1's identical shape of test).
 *
 * Three things are verified, matching this repo's fail-without/pass-with discipline:
 *  (a) selectBestLaneReportForDirection — pure selection-logic correctness: correct lane picked by the
 *      documented rule, resolvedCount===0 lanes excluded even when their fabricated netAvgR would
 *      otherwise "win", direction filtering, a throwing per-lane accessor never aborting the scan, and
 *      null returned when no lane qualifies (empty roster, wrong direction, all resolvedCount===0).
 *  (b) buildLiveBestLaneReportForDirection — the impure binding wires FOUR_BRAIN_LANE_SUPPORT + a real
 *      per-lane accessor into the exact (direction) => LaneReportLike | null closure shape.
 *  (c) A populated per-lane report flows all the way through four-brain-live-gather-bindings.ts's
 *      `buildFourBrainGatherInput` as a genuine non-null longLaneEdge/shortLaneEdge reading (the exact
 *      consumer contract that was permanently null before this fix), AND the OLD stub is proven to
 *      reproduce the exact bug this fix closes (both readings permanently MISSING).
 */
import { describe, it, expect } from "vitest";
import {
  selectBestLaneReportForDirection,
  buildLiveBestLaneReportForDirection,
  type LaneRosterEntryLike,
} from "../src/lib/four-brain-best-lane-report.js";
import { buildFourBrainGatherInput, type FourBrainBindingDeps, type LaneReportLike } from "../src/lib/four-brain-live-gather-bindings.js";

const NOW = 1_800_000_000_000;

const ROSTER: LaneRosterEntryLike[] = [
  { laneId: "LONG_A", direction: "LONG" },
  { laneId: "LONG_B", direction: "LONG" },
  { laneId: "LONG_C_ZERO", direction: "LONG" },
  { laneId: "SHORT_A", direction: "SHORT" },
  { laneId: "NEUTRAL_A", direction: "NEUTRAL" },
];

describe("selectBestLaneReportForDirection — pure selection logic", () => {
  it("picks the lane with the HIGHEST netAvgR among resolvedCount>0 lanes for the requested direction", () => {
    const reports: Record<string, LaneReportLike | null> = {
      LONG_A: { netAvgR: 0.05, resolvedCount: 40 },
      LONG_B: { netAvgR: 0.12, resolvedCount: 30 }, // highest netAvgR ⇒ should win
      LONG_C_ZERO: { netAvgR: 999, resolvedCount: 0 }, // fabricated-looking but n=0 ⇒ must be excluded
      SHORT_A: { netAvgR: 0.5, resolvedCount: 50 }, // wrong direction ⇒ must be ignored
    };
    const result = selectBestLaneReportForDirection("LONG", ROSTER, (id) => reports[id] ?? null);
    expect(result).toEqual({ netAvgR: 0.12, resolvedCount: 30 });
  });

  it("excludes resolvedCount===0 lanes even when their netAvgR would otherwise win (never fabricate)", () => {
    const reports: Record<string, LaneReportLike | null> = {
      LONG_A: { netAvgR: 0.01, resolvedCount: 5 },
      LONG_B: { netAvgR: 50, resolvedCount: 0 }, // would trivially "win" on magnitude alone
      LONG_C_ZERO: { netAvgR: 100, resolvedCount: 0 },
    };
    const result = selectBestLaneReportForDirection("LONG", ROSTER, (id) => reports[id] ?? null);
    expect(result).toEqual({ netAvgR: 0.01, resolvedCount: 5 });
  });

  it("returns null when EVERY lane for the direction has resolvedCount===0", () => {
    const reports: Record<string, LaneReportLike | null> = {
      LONG_A: { netAvgR: 0.2, resolvedCount: 0 },
      LONG_B: { netAvgR: 0.3, resolvedCount: 0 },
      LONG_C_ZERO: { netAvgR: 0.1, resolvedCount: 0 },
    };
    expect(selectBestLaneReportForDirection("LONG", ROSTER, (id) => reports[id] ?? null)).toBeNull();
  });

  it("returns null when the roster has no lane at all for the requested direction", () => {
    const rosterNoShort: LaneRosterEntryLike[] = [{ laneId: "LONG_A", direction: "LONG" }];
    expect(selectBestLaneReportForDirection("SHORT", rosterNoShort, () => ({ netAvgR: 1, resolvedCount: 100 }))).toBeNull();
  });

  it("returns null on an empty roster", () => {
    expect(selectBestLaneReportForDirection("LONG", [], () => ({ netAvgR: 1, resolvedCount: 100 }))).toBeNull();
  });

  it("treats a null per-lane report (not sourced) as absent, not as a zero candidate", () => {
    const reports: Record<string, LaneReportLike | null> = {
      LONG_A: null,
      LONG_B: { netAvgR: 0.07, resolvedCount: 10 },
      LONG_C_ZERO: null,
    };
    const result = selectBestLaneReportForDirection("LONG", ROSTER, (id) => reports[id] ?? null);
    expect(result).toEqual({ netAvgR: 0.07, resolvedCount: 10 });
  });

  it("a single lane's report accessor throwing never aborts the scan for the remaining lanes", () => {
    const result = selectBestLaneReportForDirection("LONG", ROSTER, (id) => {
      if (id === "LONG_A") throw new Error("store unavailable");
      if (id === "LONG_B") return { netAvgR: 0.09, resolvedCount: 20 };
      return null;
    });
    expect(result).toEqual({ netAvgR: 0.09, resolvedCount: 20 });
  });

  it("a non-finite netAvgR with resolvedCount>0 is never selected as best (defensive — should not arise from real report builders)", () => {
    const reports: Record<string, LaneReportLike | null> = {
      LONG_A: { netAvgR: Number.NaN, resolvedCount: 10 },
      LONG_B: { netAvgR: 0.02, resolvedCount: 8 },
    };
    const result = selectBestLaneReportForDirection("LONG", ROSTER, (id) => reports[id] ?? null);
    expect(result).toEqual({ netAvgR: 0.02, resolvedCount: 8 });
  });

  it("ties keep the FIRST roster-order lane encountered (deterministic tie-break)", () => {
    const reports: Record<string, LaneReportLike | null> = {
      LONG_A: { netAvgR: 0.1, resolvedCount: 10 },
      LONG_B: { netAvgR: 0.1, resolvedCount: 999 }, // identical netAvgR, later in roster order
    };
    const result = selectBestLaneReportForDirection("LONG", ROSTER, (id) => reports[id] ?? null);
    expect(result).toEqual({ netAvgR: 0.1, resolvedCount: 10 }); // LONG_A, not LONG_B
  });
});

describe("buildLiveBestLaneReportForDirection — impure binding shape", () => {
  it("returns a (direction) => LaneReportLike|null closure that never throws for either direction, even against real (empty) stores", () => {
    const accessor = buildLiveBestLaneReportForDirection("data", () => []);
    expect(() => accessor("LONG")).not.toThrow();
    expect(() => accessor("SHORT")).not.toThrow();
  });
});

describe("bestLaneReportForDirection stub vs real value → four-brain gather input (end-to-end consumer contract)", () => {
  const edge = {
    lookup: (_r: string | null, _d: "LONG" | "SHORT") => ({ avgNetR: 0, n: 0 }),
    verdict: () => ({ decision: "ALLOW_PROVEN" }),
    hasPositiveLane: () => true,
  };

  function baseDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
    return {
      instanceId: "3101",
      nowMs: NOW,
      axisScore: null, axisAtMs: null, axisSlopePerHour: null,
      btcAtrPercentile: null, atrAtMs: null,
      advancersPct: null, breadthAtMs: null,
      sentiment: null, sentimentAtMs: null,
      safetyEvents: [],
      regimeRaw: null, edgeMemory: edge,
      controllerBias: "UNKNOWN", convictionScore: null, allowsLong: true, allowsShort: true,
      bestLaneReportForDirection: () => null,
      crowdAlignLong: null, crowdAtMs: null, kronosAgree: null, kronosAtMs: null,
      openSignals: [], maxSignalAgeMs: 50 * 60_000, crowdingStateForSymbol: () => null,
      openPositions: [], markPriceForSymbol: () => ({ price: null, atMs: null }),
      cortexDecisionId: null, cortexFinalPctForLane: () => null, laneEligibleIncumbent: () => true,
      killLatched: false, killReason: null,
      ...o,
    } as FourBrainBindingDeps;
  }

  it("bestLaneReportForDirection: () => null (the OLD permanent stub) ⇒ both longLaneEdge/shortLaneEdge MISSING — reproduces the exact bug this fix closes", () => {
    const input = buildFourBrainGatherInput(baseDeps());
    const dir = input.directions[0]!;
    expect(dir.longLaneEdge.normalized).toBeNull();
    expect(dir.longLaneEdge.missingReason).toBeTruthy();
    expect(dir.shortLaneEdge.normalized).toBeNull();
    expect(dir.shortLaneEdge.missingReason).toBeTruthy();
  });

  it("a qualified post-fix conservative report flows through as one long-lane evidence reading", () => {
    const roster: LaneRosterEntryLike[] = [
      { laneId: "LONG_A", direction: "LONG" },
      { laneId: "SHORT_A", direction: "SHORT" },
    ];
    const reports: Record<string, LaneReportLike | null> = {
      LONG_A: { netAvgR: 0.08, conservativeNetR: 0.06, postFixExactLineage: true, costValid: true, fresh: true, resolvedCount: 60 },
      SHORT_A: { netAvgR: 0.02, resolvedCount: 0 }, // n=0 ⇒ SHORT stays MISSING
    };
    const accessor = (direction: "LONG" | "SHORT") =>
      selectBestLaneReportForDirection(direction, roster, (id) => reports[id] ?? null);

    const deps = baseDeps({ bestLaneReportForDirection: accessor });
    const input = buildFourBrainGatherInput(deps);
    const dir = input.directions[0]!;

    expect(dir.longLaneEdge.raw).toBe(0.06);
    expect(dir.longLaneEdge.normalized).toBe(0.06);
    expect(dir.longLaneEdge.missingReason).toBeNull();
    expect(dir.longLaneEdge.sourceId).toBe("lane-report-long");

    // SHORT lane resolvedCount===0 ⇒ still MISSING, never fabricated despite a non-null report object.
    expect(dir.shortLaneEdge.normalized).toBeNull();
    expect(dir.shortLaneEdge.missingReason).toBeTruthy();
  });
});

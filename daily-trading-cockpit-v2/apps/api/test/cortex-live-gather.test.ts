import { describe, it, expect } from "vitest";
import {
  buildCortexLaneRaw,
  deriveDirectionVeto,
  mapControllerBias,
  gatherCortexContext,
  normalizeCortexStaticWeightPctForLane,
  CORTEX_LANE_ROSTER,
  type CortexGatherDeps,
  type CortexRosterEntry,
} from "../src/lib/cortex-live-gather.js";
import { CORTEX_XSEC_STOP_RETURN } from "../src/lib/cortex-brain-gather.js";
import { decideCortex, checkCortexInvariants, emptyCortexState } from "../src/lib/cortex-brain.js";

// A fully-controllable fake deps: every external read is a knob, so the semantic mapping is isolated.
function fakeDeps(over: Partial<CortexGatherDeps> = {}): CortexGatherDeps {
  return {
    staticWeightPctForLane: () => 20,
    laneReport: () => ({ netAvgR: 0.1, pf: 1.3, resolvedCount: 50 }),
    xsecReport: () => ({ netAvgReturn: 0.00592, resolvedCount: 77 }),
    crowdSidesForLane: () => [],
    kronosAgreeForLane: () => null,
    edgeMemory: {
      lookup: () => ({ avgNetR: 0.12, n: 80 }),
      verdict: () => ({ decision: "ALLOW_PROVEN" }),
      hasPositiveLane: () => true,
    },
    controller: {
      directionalBias: "SHORT",
      convictionScore: 0.86,
      allowsLong: true,
      allowsShort: true,
      controllerMode: "BOTH_ALLOWED",
      edgeGated: false,
    },
    regimeRaw: "BEARISH_EXPANSION",
    axisScore: -0.5,
    axisSlopePerHour: -0.02,
    killLatched: false,
    equityPeak: 100,
    currentEquity: 88,
    currentDrawdownUsd: 4.8,
    killBudgetUsd: 40,
    ...over,
  };
}
const entry = (over: Partial<CortexRosterEntry> = {}): CortexRosterEntry => ({ laneId: "COMPOSITE_ESTIMATOR_BIDI_FAST_SHORT", direction: "SHORT", isXsec: false, ...over });

describe("cortex-live-gather — directional lane raw mapping", () => {
  it("passes the lane's own report R + PF, gated by resolvedCount>0", () => {
    const raw = buildCortexLaneRaw(entry(), fakeDeps());
    expect(raw.reportNetAvgR).toBe(0.1);
    expect(raw.reportPf).toBe(1.3);
    expect(raw.reportN).toBe(50);
    expect(raw.hasReport).toBe(true);
    expect(raw.isXsec).toBe(false);
  });
  it("resolvedCount=0 report → hasReport false (so PF is NOT fabricated to 1 downstream)", () => {
    const raw = buildCortexLaneRaw(entry(), fakeDeps({ laneReport: () => ({ netAvgR: null, pf: null, resolvedCount: 0 }) }));
    expect(raw.hasReport).toBe(false);
    expect(raw.reportN).toBe(0);
  });
  it("null laneReport (CG lane / not sourced) → own-report absent, but edge-memory still populated", () => {
    const raw = buildCortexLaneRaw(entry({ laneId: "CG_WIDE_FAST_LONG", direction: "LONG" }), fakeDeps({ laneReport: () => null }));
    expect(raw.reportNetAvgR).toBeNull();
    expect(raw.reportPf).toBeNull();
    expect(raw.hasReport).toBe(false);
    expect(raw.edgeMemAvgNetR).toBe(0.12); // magnitude still comes from edge-memory
    expect(raw.edgeMemN).toBe(80);
  });
});

describe("cortex-live-gather — edge-memory n=0 → null (never a fabricated 0)", () => {
  it("emptyStat {avgNetR:0,n:0} maps to edgeMemAvgNetR null, edgeMemN 0", () => {
    const raw = buildCortexLaneRaw(entry(), fakeDeps({ edgeMemory: { lookup: () => ({ avgNetR: 0, n: 0 }), verdict: () => ({ decision: "ALLOW_INSUFFICIENT" }), hasPositiveLane: () => false } }));
    expect(raw.edgeMemAvgNetR).toBeNull();
    expect(raw.edgeMemN).toBe(0);
  });
  it("n>0 passes the real avgNetR through", () => {
    const raw = buildCortexLaneRaw(entry(), fakeDeps({ edgeMemory: { lookup: () => ({ avgNetR: -0.03, n: 40 }), verdict: () => ({ decision: "ALLOW_PROVEN" }), hasPositiveLane: () => true } }));
    expect(raw.edgeMemAvgNetR).toBe(-0.03);
    expect(raw.edgeMemN).toBe(40);
  });
});

describe("cortex-live-gather — XSEC neutral basket → %→R via source-of-truth stop", () => {
  it("populates xsecNetAvgReturn (FRACTION) + the 0.003 stop, nulls edge-memory", () => {
    const raw = buildCortexLaneRaw(entry({ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", direction: "NEUTRAL", isXsec: true }), fakeDeps());
    expect(raw.isXsec).toBe(true);
    expect(raw.xsecNetAvgReturn).toBe(0.00592);
    expect(raw.xsecStopDistance).toBeCloseTo(CORTEX_XSEC_STOP_RETURN, 9);
    expect(raw.reportN).toBe(77); // from xsecReport.resolvedCount
    expect(raw.edgeMemAvgNetR).toBeNull(); // NEUTRAL — no directional slice
    expect(raw.edgeMemN).toBe(0);
    expect(raw.vetoed).toBe(false); // NEUTRAL never edge-vetoed
  });
});

describe("cortex-live-gather — vetoed derivation MIRRORS the live edgeVeto (edge-memory ONLY, per-direction)", () => {
  // The live mainnet funded-executor gate (app.ts edgeVeto) reads ONLY edge-memory per direction and
  // FAILS OPEN on a blank regime. It does NOT consult the controller posture — that is a testnet-only
  // layer. These tests pin that exact predicate so β=0 == the true post-federated-veto incumbent.
  const em = (decision: string, hasPositive: boolean) => ({
    lookup: () => ({ avgNetR: decision === "VETO_NEGATIVE" ? -0.1 : 0.1, n: 60 }),
    verdict: () => ({ decision }),
    hasPositiveLane: () => hasPositive,
  });
  it("edge-memory VETO_NEGATIVE with no proven-positive lane → vetoed", () => {
    expect(deriveDirectionVeto({ direction: "LONG", edgeMemory: em("VETO_NEGATIVE", false), regimeRaw: "BULLISH_EXPANSION" })).toBe(true);
  });
  it("VETO_NEGATIVE but a proven-positive lane rescues → NOT vetoed", () => {
    expect(deriveDirectionVeto({ direction: "LONG", edgeMemory: em("VETO_NEGATIVE", true), regimeRaw: "BULLISH_EXPANSION" })).toBe(false);
  });
  it("ALLOW_INSUFFICIENT (thin sample) → NOT vetoed (live trades it)", () => {
    expect(deriveDirectionVeto({ direction: "SHORT", edgeMemory: em("ALLOW_INSUFFICIENT", false), regimeRaw: "MIXED_ROTATION" })).toBe(false);
  });
  it("does NOT over-veto on controller posture: a proven-allowed direction is NOT vetoed even under a NO_TRADE / posture-disallowed / edgeGated controller", () => {
    // (These would ALL have false-vetoed under the old controllerBlock — the 3 confirmed review bugs.)
    // NO_TRADE_CHOP regime but SHORT edge is proven → live trades it → NOT vetoed.
    expect(deriveDirectionVeto({ direction: "SHORT", edgeMemory: em("ALLOW_PROVEN", true), regimeRaw: "CHOP_RANGE" })).toBe(false);
    // WAIT_RETEST_AFTER_DUMP (allowsLong=false) but LONG edge insufficient → live opens → NOT vetoed.
    expect(deriveDirectionVeto({ direction: "LONG", edgeMemory: em("ALLOW_INSUFFICIENT", false), regimeRaw: "PANIC_DUMP" })).toBe(false);
  });
  it("blank / null regime → FAIL-OPEN (not vetoed), exactly like edgeVeto", () => {
    expect(deriveDirectionVeto({ direction: "LONG", edgeMemory: em("VETO_NEGATIVE", false), regimeRaw: null })).toBe(false);
    expect(deriveDirectionVeto({ direction: "SHORT", edgeMemory: em("VETO_NEGATIVE", false), regimeRaw: "   " })).toBe(false);
  });
  it("NEUTRAL basket lane is never edge-vetoed", () => {
    expect(deriveDirectionVeto({ direction: "NEUTRAL", edgeMemory: em("VETO_NEGATIVE", false), regimeRaw: "BULLISH_EXPANSION" })).toBe(false);
  });
});

describe("cortex-live-gather — conviction + bias mapping", () => {
  it("controllerConviction = the directional convictionScore (NOT the floored confidence tier)", () => {
    const raw = buildCortexLaneRaw(entry(), fakeDeps());
    expect(raw.controllerConviction).toBe(0.86);
  });
  it("bias enum maps NEUTRAL→NONE, LONG/SHORT pass through, others→MIXED/UNKNOWN", () => {
    expect(mapControllerBias("LONG")).toBe("LONG");
    expect(mapControllerBias("SHORT")).toBe("SHORT");
    expect(mapControllerBias("NEUTRAL")).toBe("NONE");
    expect(mapControllerBias("MIXED")).toBe("MIXED");
    expect(mapControllerBias("UNKNOWN")).toBe("UNKNOWN");
  });
});

describe("cortex-live-gather — gatherCortexContext end-to-end", () => {
  it("journals every roster lane while retaining zero weights for non-funded lanes", () => {
    // Only fund two lanes. The remaining lanes must stay observable for causal outcome attribution.
    const funded = new Set(["CG_WIDE_FAST_LONG", "CROSS_SECTIONAL_MARKET_NEUTRAL"]);
    const deps = fakeDeps({ staticWeightPctForLane: (id) => (funded.has(id) ? 25 : 0) });
    const ctx = gatherCortexContext(deps);
    expect(ctx.lanes.map((l) => l.laneId).sort()).toEqual(CORTEX_LANE_ROSTER.map((l) => l.laneId).sort());
    expect(ctx.lanes.find((l) => l.laneId === "CG_WIDE_FAST_LONG")?.staticWeightPct).toBe(25);
    expect(ctx.lanes.find((l) => l.laneId === "REGIME_COMPOSITE_CONFIRMATION_SHORT")?.staticWeightPct).toBe(0);
    const d = decideCortex(ctx, emptyCortexState(), { beta: 0 });
    expect(checkCortexInvariants(d).ok).toBe(true);
  });
  it("splits the two drawdown signals: portfolioDrawdownPct (peak-frac) vs killBudgetUtilization (budget-frac)", () => {
    const deps = fakeDeps({ staticWeightPctForLane: (id) => (id === "CG_WIDE_FAST_LONG" ? 20 : 0), equityPeak: 100, currentEquity: 88, currentDrawdownUsd: 4.8, killBudgetUsd: 40 });
    const ctx = gatherCortexContext(deps);
    expect(ctx.portfolioDrawdownPct).toBeCloseTo(0.12, 6); // (100−88)/100
    expect(ctx.killBudgetUtilization).toBeCloseTo(0.12, 6); // 4.8/40
    // null drawdown inputs ⇒ both fractions 0 (no deleverage) — the honest Phase-1 default
    const ctx0 = gatherCortexContext(fakeDeps({ staticWeightPctForLane: (id) => (id === "CG_WIDE_FAST_LONG" ? 20 : 0), equityPeak: null, currentEquity: null, currentDrawdownUsd: null, killBudgetUsd: 40 }));
    expect(ctx0.portfolioDrawdownPct).toBe(0);
    expect(ctx0.killBudgetUtilization).toBe(0);
  });
  it("normalizes ALL_LANES eligibility sentinels without changing an explicit partial allocation", () => {
    const allLaneWeight = normalizeCortexStaticWeightPctForLane(() => 100);
    // 16 roster entries but only 15 DISTINCT real allocation ids: CG_MFE_GIVEBACK_LONG/_SHORT share one
    // real sleeve, so the shared slot is counted once for scaling but read back on 2 roster entries —
    // the roster-level total lands just over 100 (still nowhere near the old bug's impossible 1500%).
    const distinctRealLanes = CORTEX_LANE_ROSTER.length - 1;
    const allLaneTotal = CORTEX_LANE_ROSTER.reduce((sum, lane) => sum + allLaneWeight(lane.laneId), 0);
    expect(allLaneTotal).toBeCloseTo((CORTEX_LANE_ROSTER.length / distinctRealLanes) * 100, 9);
    expect(allLaneWeight("CG_WIDE_FAST_LONG")).toBeCloseTo(100 / distinctRealLanes, 9);
    expect(allLaneWeight("CG_MFE_GIVEBACK_LONG")).toBeCloseTo(100 / distinctRealLanes, 9);
    expect(allLaneWeight("CG_MFE_GIVEBACK_SHORT")).toBeCloseTo(100 / distinctRealLanes, 9);

    const partial = normalizeCortexStaticWeightPctForLane((laneId) => (laneId === "CG_WIDE_FAST_LONG" ? 25 : 0));
    expect(partial("CG_WIDE_FAST_LONG")).toBe(25);
  });
});

describe("cortex-live-gather — CG_MFE_GIVEBACK static-weight lane-id mapping", () => {
  // The real LiveExecutionEngine allocation table only ever uses the id "CG_MFE_GIVEBACK" (confirmed
  // against regime-autopilot.ts's presets) — never the roster's synthetic "_LONG"/"_SHORT" split. Before
  // the fix, staticWeightPctForLane("CG_MFE_GIVEBACK_LONG"/"_SHORT") always read 0 under any explicit
  // allocation, silently falsifying CORTEX's shadow decision journal for this lane pair.
  it("buildCortexLaneRaw maps both synthetic roster ids to the real 'CG_MFE_GIVEBACK' id for the static-weight lookup only", () => {
    const deps = fakeDeps({ staticWeightPctForLane: (id) => (id === "CG_MFE_GIVEBACK" ? 15 : 0) });
    const longRaw = buildCortexLaneRaw({ laneId: "CG_MFE_GIVEBACK_LONG", direction: "LONG", isXsec: false }, deps);
    const shortRaw = buildCortexLaneRaw({ laneId: "CG_MFE_GIVEBACK_SHORT", direction: "SHORT", isXsec: false }, deps);
    expect(longRaw.staticWeightPct).toBe(15);
    expect(shortRaw.staticWeightPct).toBe(15);
    // The synthetic id itself stays untouched everywhere else (journaling/attribution/direction split).
    expect(longRaw.laneId).toBe("CG_MFE_GIVEBACK_LONG");
    expect(shortRaw.laneId).toBe("CG_MFE_GIVEBACK_SHORT");
  });

  it("normalizeCortexStaticWeightPctForLane resolves the same real-id mapping for both synthetic ids", () => {
    const raw = (id: string) => (id === "CG_WIDE_FAST_LONG" ? 30 : id === "CG_MFE_GIVEBACK" ? 15 : 0);
    const normalized = normalizeCortexStaticWeightPctForLane(raw);
    expect(normalized("CG_WIDE_FAST_LONG")).toBe(30);
    expect(normalized("CG_MFE_GIVEBACK_LONG")).toBe(15);
    expect(normalized("CG_MFE_GIVEBACK_SHORT")).toBe(15);
  });

  it("does not double-count CG_MFE_GIVEBACK's shared real allocation toward the over-100 clip", () => {
    // A real table that already sums to exactly 100 across DISTINCT real ids: 50 + 50. If the shared
    // CG_MFE_GIVEBACK slot were counted once PER synthetic roster entry, the total would read 150 and
    // every lane (including CG_WIDE_FAST_LONG) would get wrongly scaled down to 33.3.
    const raw = (id: string) => (id === "CG_WIDE_FAST_LONG" ? 50 : id === "CG_MFE_GIVEBACK" ? 50 : 0);
    const normalized = normalizeCortexStaticWeightPctForLane(raw);
    expect(normalized("CG_WIDE_FAST_LONG")).toBe(50);
    expect(normalized("CG_MFE_GIVEBACK_LONG")).toBe(50);
    expect(normalized("CG_MFE_GIVEBACK_SHORT")).toBe(50);
  });

  it("gatherCortexContext end-to-end: CG_MFE_GIVEBACK's real 15% allocation reaches BOTH direction-siloed lane observations", () => {
    const deps = fakeDeps({ staticWeightPctForLane: (id) => (id === "CG_MFE_GIVEBACK" ? 15 : 0) });
    const ctx = gatherCortexContext(deps);
    expect(ctx.lanes.find((l) => l.laneId === "CG_MFE_GIVEBACK_LONG")?.staticWeightPct).toBe(15);
    expect(ctx.lanes.find((l) => l.laneId === "CG_MFE_GIVEBACK_SHORT")?.staticWeightPct).toBe(15);
  });
});

describe("cortex-live-gather — roster integrity", () => {
  it("roster has 16 lanes; CG MFE is represented separately per direction and 3 XSEC are NEUTRAL", () => {
    expect(CORTEX_LANE_ROSTER.length).toBe(16);
    const xsec = CORTEX_LANE_ROSTER.filter((r) => r.isXsec);
    expect(xsec.length).toBe(3);
    expect(xsec.every((r) => r.direction === "NEUTRAL")).toBe(true);
    expect(CORTEX_LANE_ROSTER.filter((r) => !r.isXsec).every((r) => r.direction === "LONG" || r.direction === "SHORT")).toBe(true);
    expect(CORTEX_LANE_ROSTER).toContainEqual({ laneId: "CG_MFE_GIVEBACK_LONG", direction: "LONG", isXsec: false });
    expect(CORTEX_LANE_ROSTER).toContainEqual({ laneId: "CG_MFE_GIVEBACK_SHORT", direction: "SHORT", isXsec: false });
  });
});

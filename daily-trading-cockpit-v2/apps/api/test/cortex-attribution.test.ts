import { describe, it, expect } from "vitest";
import {
  attributeOutcomes,
  cortexBlindCapitalPct,
  cortexRegimeFamilyCoverage,
  CORTEX_ATTR_DEFAULT_TTL_MS,
  type CortexAttrRosterEntry,
  type CortexDecisionRow,
  type CortexLaneOutcome,
} from "../src/lib/cortex-attribution.js";
import {
  directionalObsToOutcome,
  xsecObsToOutcome,
  buildCortexAttrRoster,
  cortexLaneTtlMs,
  CORTEX_ATTR_TTL_XSEC_MS,
} from "../src/lib/cortex-outcome-source.js";
import {
  CORTEX_LIVE_BETA,
  evaluationBeta,
  cortexBeta,
  CORTEX_BETA_MAX,
  CORTEX_BETA_RAMP_N,
  decideCortex,
  emptyCortexState,
  assembleCortexContext,
  type CortexContext,
  type CortexLaneObservation,
} from "../src/lib/cortex-brain.js";

const MIN = 60_000;

function decision(atMs: number, opts: { schema?: number; family?: string; lanes: Record<string, { x?: number[]; eligible?: boolean; direction?: "LONG" | "SHORT" | "NEUTRAL" }> }): CortexDecisionRow {
  const lanes = new Map<string, { x: number[]; eligible: boolean; direction: "LONG" | "SHORT" | "NEUTRAL" | null }>();
  for (const [laneId, l] of Object.entries(opts.lanes)) {
    lanes.set(laneId, { x: l.x ?? [1, atMs / 1e9, 0, 0, 0, 0, 0, 0, 0, 0.5], eligible: l.eligible ?? true, direction: l.direction ?? "LONG" });
  }
  return { atMs, featureSchemaVersion: opts.schema ?? 1, regimeFamily: opts.family ?? "BULL", lanes };
}

function outcome(laneId: string, openedAtMs: number, resolvedAtMs: number, netR: number, obsId: string, direction: "LONG" | "SHORT" | "NEUTRAL" = "LONG"): CortexLaneOutcome {
  return { laneId, archetype: "BREADTH", direction, observationId: obsId, openedAtMs, resolvedAtMs, netR };
}

const ROSTER: CortexAttrRosterEntry[] = [{ laneId: "L1", archetype: "BREADTH", staticWeightPct: 40, hasOutcomeSource: true }];
const OPTS = { currentSchemaVersion: 1, roster: ROSTER, ttlMsForLane: () => 50 * MIN };

describe("cortex-attribution — the anti-leakage property (operator's core concern)", () => {
  it("attributes ONE trade to exactly ONE owning decision (the latest before open), NOT all prior ticks", () => {
    // 10 decisions every 5 min from t=0..45; one trade opens at t=48min.
    const decisions = Array.from({ length: 10 }, (_, i) => decision(i * 5 * MIN, { lanes: { L1: { x: [1, i, 0, 0, 0, 0, 0, 0, 0, 0.5] } } }));
    const o = outcome("L1", 48 * MIN, 120 * MIN, 0.2, "obs-1");
    const r = attributeOutcomes(decisions, [o], OPTS);
    expect(r.examples).toHaveLength(1); // NOT 10
    // The owning decision is the LATEST before open (t=45min → the i=9 slice).
    expect(r.examples[0]!.x[1]).toBe(9);
    expect(r.examples[0]!.y).toBe(1); // netR 0.2 > hurdle 0.03
    const l1 = r.perLane.find((l) => l.laneId === "L1")!;
    expect(l1.attributed).toBe(1);
    expect(l1.outcomesSeen).toBe(1);
  });

  it("drops (and COUNTS) a trade with no decision inside the TTL window — never a stale match", () => {
    const decisions = Array.from({ length: 10 }, (_, i) => decision(i * 5 * MIN, { lanes: { L1: {} } }));
    // Trade opens at t=200min; latest decision is t=45min → 155min gap > 50min TTL.
    const o = outcome("L1", 200 * MIN, 260 * MIN, 0.2, "obs-late");
    const r = attributeOutcomes(decisions, [o], OPTS);
    expect(r.examples).toHaveLength(0);
    expect(r.perLane.find((l) => l.laneId === "L1")!.unattributedNoDecision).toBe(1);
  });

  it("never keys on resolvedAt: a trade opened BEFORE every decision is unattributed", () => {
    // Trade opened at t=-10min (before all decisions) but resolves at t=60min (after them). resolvedAt-based
    // matching would wrongly grab a decision; open-time matching correctly finds none.
    const decisions = Array.from({ length: 5 }, (_, i) => decision(i * 5 * MIN, { lanes: { L1: {} } }));
    const o = outcome("L1", -10 * MIN, 60 * MIN, 0.2, "obs-pre");
    const r = attributeOutcomes(decisions, [o], OPTS);
    expect(r.examples).toHaveLength(0);
    expect(r.perLane.find((l) => l.laneId === "L1")!.unattributedNoDecision).toBe(1);
  });

  it("claims one outcome only once (dedupe by laneId+observationId)", () => {
    const decisions = [decision(0, { lanes: { L1: {} } })];
    const o = outcome("L1", 3 * MIN, 60 * MIN, 0.2, "dup");
    const r = attributeOutcomes(decisions, [o, { ...o }], OPTS);
    expect(r.examples).toHaveLength(1);
    expect(r.perLane.find((l) => l.laneId === "L1")!.duplicateDropped).toBe(1);
  });

  it("a decision that didn't include the lane cannot own its trade", () => {
    const decisions = [decision(0, { lanes: { OTHER: {} } })];
    const o = outcome("L1", 3 * MIN, 60 * MIN, 0.2, "obs-x");
    const r = attributeOutcomes(decisions, [o], OPTS);
    expect(r.examples).toHaveLength(0);
    expect(r.perLane.find((l) => l.laneId === "L1")!.unattributedNoDecision).toBe(1);
  });

  it("counts a schema-mismatched match separately and does NOT train across schemas", () => {
    const decisions = [decision(0, { schema: 0, lanes: { L1: {} } })]; // stale schema
    const o = outcome("L1", 3 * MIN, 60 * MIN, 0.2, "obs-s");
    const r = attributeOutcomes(decisions, [o], OPTS); // current schema = 1
    expect(r.examples).toHaveLength(0);
    const l1 = r.perLane.find((l) => l.laneId === "L1")!;
    expect(l1.schemaMismatch).toBe(1);
    expect(l1.status).toBe("SCHEMA_MISMATCH");
  });

  it("a stale-schema slice does NOT shadow an older current-schema owner (schema tested INSIDE the walk)", () => {
    // Later slice t=20 is stale schema; earlier slice t=10 is current schema. Both in window, direction OK.
    // The trade must attribute to the current-schema t=10 owner, NOT drop as a schema mismatch.
    const decisions = [
      decision(10 * MIN, { schema: 1, lanes: { L1: { x: [1, 111, 0, 0, 0, 0, 0, 0, 0, 0.5] } } }),
      decision(20 * MIN, { schema: 0, lanes: { L1: {} } }),
    ];
    const o = outcome("L1", 25 * MIN, 80 * MIN, 0.2, "obs-shadow");
    const r = attributeOutcomes(decisions, [o], OPTS);
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]!.x[1]).toBe(111); // the current-schema t=10 owner, not the stale t=20 one
  });

  it("mis-routes NOTHING: a direction-mismatch with only a stale-schema wrong-direction slice drops as no-owner, not schema", () => {
    // Only in-window slice is stale schema AND wrong direction. Should be an honest no-owner drop.
    const decisions = [decision(0, { schema: 0, lanes: { L1: { direction: "SHORT" } } })];
    const o = outcome("L1", 3 * MIN, 60 * MIN, 0.2, "obs-dm", "LONG");
    const r = attributeOutcomes(decisions, [o], OPTS);
    const l1 = r.perLane.find((l) => l.laneId === "L1")!;
    expect(l1.schemaMismatch).toBe(0); // direction filtered it out first — not a schema blocker
    expect(l1.unattributedNoDecision).toBe(1);
  });

  it("requireEligible=true excludes a vetoed decision; default (false) keeps the training set unbiased", () => {
    const decisions = [decision(0, { lanes: { L1: { eligible: false } } })];
    const o = outcome("L1", 3 * MIN, 60 * MIN, 0.2, "obs-v");
    expect(attributeOutcomes(decisions, [o], OPTS).examples).toHaveLength(1); // default: matched (unbiased)
    expect(attributeOutcomes(decisions, [o], { ...OPTS, requireEligible: true }).examples).toHaveLength(0);
  });
});

describe("cortex-attribution — per-lane status + coverage", () => {
  it("NO_OUTCOME_SOURCE when the lane's close source isn't wired", () => {
    const roster: CortexAttrRosterEntry[] = [{ laneId: "L1", archetype: "BREADTH", staticWeightPct: 30, hasOutcomeSource: false }];
    const r = attributeOutcomes([], [], { currentSchemaVersion: 1, roster });
    expect(r.perLane.find((l) => l.laneId === "L1")!.status).toBe("NO_OUTCOME_SOURCE");
  });

  it("INSUFFICIENT_DATA below the min, LEARNING_ACTIVE at/above it", () => {
    const decisions = Array.from({ length: 40 }, (_, i) => decision(i * MIN, { lanes: { L1: {} } }));
    const few = Array.from({ length: 5 }, (_, i) => outcome("L1", (i + 0.5) * MIN, (i + 30) * MIN, 0.2, `f${i}`));
    expect(attributeOutcomes(decisions, few, { ...OPTS, minExamplesForActive: 20 }).perLane[0]!.status).toBe("INSUFFICIENT_DATA");
    const many = Array.from({ length: 25 }, (_, i) => outcome("L1", (i + 0.5) * MIN, (i + 30) * MIN, 0.2, `m${i}`));
    expect(attributeOutcomes(decisions, many, { ...OPTS, minExamplesForActive: 20 }).perLane[0]!.status).toBe("LEARNING_ACTIVE");
  });

  it("regime-family coverage counts distinct families among attributed outcomes", () => {
    const decisions = [
      decision(0, { family: "BULL", lanes: { L1: {} } }),
      decision(10 * MIN, { family: "BEAR", lanes: { L1: { direction: "LONG" } } }),
    ];
    const outs = [outcome("L1", 3 * MIN, 60 * MIN, 0.2, "a"), outcome("L1", 12 * MIN, 70 * MIN, -0.5, "b")];
    const r = attributeOutcomes(decisions, outs, OPTS);
    expect(cortexRegimeFamilyCoverage(r.regimeCoverageThisRun)).toBe(2);
    expect(r.regimeCoverageThisRun).toEqual({ BULL: 1, BEAR: 1 });
  });

  it("cortexBlindCapitalPct sums static weight of lanes not LEARNING_ACTIVE", () => {
    const perLane = [
      { laneId: "A", archetype: "BREADTH" as const, status: "LEARNING_ACTIVE" as const, outcomesSeen: 0, attributed: 0, unattributedNoDecision: 0, schemaMismatch: 0, duplicateDropped: 0, staticWeightPct: 50 },
      { laneId: "B", archetype: "NEUTRAL" as const, status: "NO_OUTCOME_SOURCE" as const, outcomesSeen: 0, attributed: 0, unattributedNoDecision: 0, schemaMismatch: 0, duplicateDropped: 0, staticWeightPct: 35 },
      { laneId: "C", archetype: "TACTICAL" as const, status: "INSUFFICIENT_DATA" as const, outcomesSeen: 0, attributed: 0, unattributedNoDecision: 0, schemaMismatch: 0, duplicateDropped: 0, staticWeightPct: 15 },
    ];
    expect(cortexBlindCapitalPct(perLane)).toBe(50); // 35 + 15
  });
});

describe("cortex-outcome-source — netR normalization", () => {
  it("directional obs passes netR through in R", () => {
    const r = directionalObsToOutcome("REGIME_COMPOSITE_CONFIRMATION_LONG", {
      observationId: "rc:1",
      openedAtMs: 1000,
      resolvedAt: new Date(5000).toISOString(),
      status: "CLOSED_WIN",
      netR: 0.42,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome.netR).toBe(0.42);
  });

  it("XSEC obs converts fraction→R using the FROZEN riskDistanceAtOpen, not any live config", () => {
    const laneId = "CROSS_SECTIONAL_MARKET_NEUTRAL";
    const r = xsecObsToOutcome(laneId, {
      observationId: "xsec:1",
      openedAtMs: 1000,
      resolvedAt: new Date(9000).toISOString(),
      status: "CLOSED_WIN",
      netReturn: 0.006,
      riskDistanceAtOpen: 0.003, // frozen at open
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome.netR).toBeCloseTo(2.0, 10); // 0.006 / 0.003
      expect(r.outcome.direction).toBe("NEUTRAL");
    }
    // A DIFFERENT frozen denominator yields a DIFFERENT netR → proves it reads the field, not a constant.
    const r2 = xsecObsToOutcome(laneId, { observationId: "xsec:2", openedAtMs: 1000, resolvedAt: new Date(9000).toISOString(), status: "CLOSED_WIN", netReturn: 0.006, riskDistanceAtOpen: 0.006 });
    if (r2.ok) expect(r2.outcome.netR).toBeCloseTo(1.0, 10);
  });

  it("XSEC falls back to stopLossReturn, then SKIPS (NO_RISK_AT_OPEN) — never a raw-fraction fallback", () => {
    const laneId = "CROSS_SECTIONAL_MARKET_NEUTRAL";
    const fb = xsecObsToOutcome(laneId, { observationId: "x", openedAtMs: 1, resolvedAt: new Date(9).toISOString(), status: "EXPIRED", netReturn: 0.006, stopLossReturn: 0.003 });
    expect(fb.ok).toBe(true);
    if (fb.ok) expect(fb.outcome.netR).toBeCloseTo(2.0, 10);
    const none = xsecObsToOutcome(laneId, { observationId: "y", openedAtMs: 1, resolvedAt: new Date(9).toISOString(), status: "CLOSED_WIN", netReturn: 0.006 });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.skip).toBe("NO_RISK_AT_OPEN");
  });

  it("skips OPEN + null-outcome records with the right reason", () => {
    const open = directionalObsToOutcome("REGIME_COMPOSITE_CONFIRMATION_LONG", { observationId: "o", openedAtMs: 1, resolvedAt: null, status: "OPEN", netR: null });
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.skip).toBe("NOT_RESOLVED");
    const nullNet = directionalObsToOutcome("REGIME_COMPOSITE_CONFIRMATION_LONG", { observationId: "o2", openedAtMs: 1, resolvedAt: new Date(9).toISOString(), status: "EXPIRED", netR: null });
    expect(nullNet.ok).toBe(false);
    if (!nullNet.ok) expect(nullNet.skip).toBe("NO_OUTCOME_VALUE");
  });

  it("TTL is longer for XSEC baskets than directional lanes", () => {
    expect(cortexLaneTtlMs("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(CORTEX_ATTR_TTL_XSEC_MS);
    expect(cortexLaneTtlMs("REGIME_COMPOSITE_CONFIRMATION_LONG")).toBe(50 * MIN);
  });

  it("buildCortexAttrRoster reflects wired sources + static weights from injected accessors", () => {
    const roster = buildCortexAttrRoster(
      (id) => (id === "REGIME_COMPOSITE_CONFIRMATION_LONG" ? 40 : 0),
      (id) => id !== "CG_WIDE_FAST_LONG",
    );
    const rc = roster.find((r) => r.laneId === "REGIME_COMPOSITE_CONFIRMATION_LONG")!;
    expect(rc.staticWeightPct).toBe(40);
    expect(rc.hasOutcomeSource).toBe(true);
    expect(roster.find((r) => r.laneId === "CG_WIDE_FAST_LONG")!.hasOutcomeSource).toBe(false);
  });
});

describe("cortex beta split — liveBeta wall (operator hard rule)", () => {
  it("CORTEX_LIVE_BETA is a hard 0 (never a function of sample count)", () => {
    expect(CORTEX_LIVE_BETA).toBe(0);
  });

  it("evaluationBeta ramps with cumulativeResolved exactly like the schedule", () => {
    expect(evaluationBeta(0)).toBe(0);
    expect(evaluationBeta(CORTEX_BETA_RAMP_N)).toBeCloseTo(CORTEX_BETA_MAX, 10);
    expect(evaluationBeta(CORTEX_BETA_RAMP_N / 2)).toBeCloseTo(CORTEX_BETA_MAX / 2, 10);
    expect(evaluationBeta(10 * CORTEX_BETA_RAMP_N)).toBeCloseTo(CORTEX_BETA_MAX, 10); // capped
    expect(evaluationBeta(500)).toBe(cortexBeta(500));
  });

  it("a decision at CORTEX_LIVE_BETA equals the post-veto incumbent (β=0 ⇒ zero tilt), even after learning", () => {
    // State that HAS learned (nonzero coefficients + high cumulativeResolved that would ramp evaluationBeta).
    const state = emptyCortexState();
    state.cumulativeResolved = 10_000; // evaluationBeta would be at the cap here
    state.archetypes.BREADTH.w = [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0];
    const obs: CortexLaneObservation[] = [
      { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", direction: "LONG", edgeMemAvgNetR: 0.1, edgeMemN: 100, laneNetAvgR: 0.1, laneNetAvgN: 100, lanePf: 1.5, crowdingAlign: 0.2, kronosAgree: 0.3, convictionScore: 0.7, vetoed: false, staticWeightPct: 100 },
    ];
    const ctx: CortexContext = assembleCortexContext(
      { regimeFamily: "BULL", axisScore: 0.5, axisSlopePerHour: 0.1, allowLong: true, allowShort: false, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false },
      obs,
    );
    const live = decideCortex(ctx, state, { beta: CORTEX_LIVE_BETA });
    expect(live.beta).toBe(0);
    expect(live.expectedTiltDeltaR).toBe(0); // no tilt at β=0
    // The evaluation decision at the ramped β DOES tilt (proves the two channels differ).
    const evalDec = decideCortex(ctx, state, { beta: evaluationBeta(state.cumulativeResolved) });
    expect(evalDec.beta).toBeGreaterThan(0);
  });
});

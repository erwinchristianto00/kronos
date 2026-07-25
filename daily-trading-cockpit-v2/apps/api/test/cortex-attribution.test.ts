import { describe, it, expect } from "vitest";
import {
  attributeOutcomes,
  cortexBlindCapitalPct,
  cortexRegimeFamilyCoverage,
  cortexShadowDecisionAlpha,
  CORTEX_ATTR_DEFAULT_TTL_MS,
  type CortexAttrRosterEntry,
  type CortexAttributedExample,
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

function decision(atMs: number, opts: { schema?: number; family?: string; lanes: Record<string, { x?: number[]; eligible?: boolean; direction?: "LONG" | "SHORT" | "NEUTRAL"; finalPct?: number; evalFinalPct?: number }> }): CortexDecisionRow {
  const lanes = new Map<string, { x: number[]; eligible: boolean; direction: "LONG" | "SHORT" | "NEUTRAL" | null; finalPct: number; evalFinalPct: number }>();
  for (const [laneId, l] of Object.entries(opts.lanes)) {
    lanes.set(laneId, {
      x: l.x ?? [1, atMs / 1e9, 0, 0, 0, 0, 0, 0, 0, 0.5],
      eligible: l.eligible ?? true,
      direction: l.direction ?? "LONG",
      finalPct: l.finalPct ?? 0,
      evalFinalPct: l.evalFinalPct ?? l.finalPct ?? 0,
    });
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
    const l1 = r.perLane.find((l) => l.laneId === "L1")!;
    expect(l1.unattributedNoDecision).toBe(1);
    // [2026-07-22 diagnostic split] the journal DOES reach back to t=0, well before this trade's t=200min
    // open — so this is a genuine per-lane coverage gap, not a journal-retention scar.
    expect(l1.unattributedNoDecisionGenuineGap).toBe(1);
    expect(l1.unattributedNoDecisionJournalGap).toBe(0);
  });

  it("never keys on resolvedAt: a trade opened BEFORE every decision is unattributed", () => {
    // Trade opened at t=-10min (before all decisions) but resolves at t=60min (after them). resolvedAt-based
    // matching would wrongly grab a decision; open-time matching correctly finds none.
    const decisions = Array.from({ length: 5 }, (_, i) => decision(i * 5 * MIN, { lanes: { L1: {} } }));
    const o = outcome("L1", -10 * MIN, 60 * MIN, 0.2, "obs-pre");
    const r = attributeOutcomes(decisions, [o], OPTS);
    expect(r.examples).toHaveLength(0);
    const l1 = r.perLane.find((l) => l.laneId === "L1")!;
    expect(l1.unattributedNoDecision).toBe(1);
    // [2026-07-22 diagnostic split] this trade's t=-10min open predates the journal's own earliest
    // retained decision (t=0) — structurally unattributable no matter what, a journal-retention scar.
    expect(l1.unattributedNoDecisionJournalGap).toBe(1);
    expect(l1.unattributedNoDecisionGenuineGap).toBe(0);
  });

  it("[REGRESSION 2026-07-22] unattributedNoDecisionJournalGap + unattributedNoDecisionGenuineGap always sum to unattributedNoDecision, across a mix of both kinds", () => {
    // Journal covers t=0..20min. One outcome opens BEFORE that (t=-5min, journal scar); one opens well
    // AFTER it but outside the TTL window for this lane (t=200min, genuine gap); one attributes cleanly.
    const decisions = [
      decision(0, { lanes: { L1: { x: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0.5] } } }),
      decision(20 * MIN, { lanes: { L1: { x: [1, 20, 0, 0, 0, 0, 0, 0, 0, 0.5] } } }),
    ];
    const outcomes = [
      outcome("L1", -5 * MIN, 30 * MIN, 0.2, "obs-scar"), // journal gap
      outcome("L1", 200 * MIN, 260 * MIN, 0.2, "obs-genuine"), // genuine gap (155min+ past TTL)
      outcome("L1", 22 * MIN, 40 * MIN, 0.2, "obs-clean"), // attributes to the t=20min decision
    ];
    const r = attributeOutcomes(decisions, outcomes, OPTS);
    const l1 = r.perLane.find((l) => l.laneId === "L1")!;
    expect(l1.attributed).toBe(1);
    expect(l1.unattributedNoDecision).toBe(2);
    expect(l1.unattributedNoDecisionJournalGap).toBe(1);
    expect(l1.unattributedNoDecisionGenuineGap).toBe(1);
    expect(l1.unattributedNoDecisionJournalGap + l1.unattributedNoDecisionGenuineGap).toBe(l1.unattributedNoDecision);
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

  it("a stale-flag leak from a NEWER schema-mismatch must not paint an OLDER, differently-caused rejection as SCHEMA_MISMATCH", () => {
    // Two in-window slices for the same lane. Walk order is newest→oldest:
    //  - newer slice (t=20min): stale schema (direction OK) — a genuine schema-mismatch candidate.
    //  - older slice (t=10min): current schema BUT wrong direction — a genuine, UNRELATED rejection.
    // Neither slice can own the trade, but the true reason is a MIX of causes, not "schema alone" — so the
    // outcome must be an honest no-owner drop (unattributedNoDecision), never SCHEMA_MISMATCH leaking over
    // from the newer candidate's rejection reason.
    const decisions = [
      decision(10 * MIN, { schema: 1, lanes: { L1: { direction: "SHORT" } } }), // current schema, wrong direction
      decision(20 * MIN, { schema: 0, lanes: { L1: { direction: "LONG" } } }), // stale schema, right direction
    ];
    const o = outcome("L1", 25 * MIN, 100 * MIN, 0.2, "obs-mixed-cause", "LONG");
    const r = attributeOutcomes(decisions, [o], OPTS);
    expect(r.examples).toHaveLength(0);
    const l1 = r.perLane.find((l) => l.laneId === "L1")!;
    expect(l1.schemaMismatch).toBe(0); // NOT schema-only — a direction-mismatched candidate was also in play
    expect(l1.unattributedNoDecision).toBe(1);
    expect(l1.status).toBe("INSUFFICIENT_DATA"); // never SCHEMA_MISMATCH for a mixed-cause drop
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

  it("[REGRESSION 2026-07-22] a non-finite netR/openedAtMs/resolvedAtMs is counted into outcomesSeen + invalidData, never silently vanishing before any counter increments", () => {
    const decisions = [decision(0, { lanes: { L1: {} } })];
    const bad = outcome("L1", 3 * MIN, 60 * MIN, Number.NaN, "corrupt-1");
    const r = attributeOutcomes(decisions, [bad], OPTS);
    const st = r.perLane.find((l) => l.laneId === "L1")!;
    expect(st.outcomesSeen).toBe(1); // previously 0 — the drop happened BEFORE c.seen+=1
    expect(st.invalidData).toBe(1);
    expect(st.attributed).toBe(0);
    expect(st.unattributedNoDecision).toBe(0); // this class of drop must not double up into noDecision either
  });

  it("[REGRESSION 2026-07-22] a duplicate outcome (same laneId+observationId) that fails to attribute on its FIRST occurrence is recognized as a duplicate on its SECOND, instead of independently inflating unattributedNoDecision every time", () => {
    // No decisions at all ⇒ every occurrence genuinely fails to find an owner (a real, reachable
    // "genuine gap" case), NOT a TTL-window exclusion — so any repeat is unambiguously a duplicate,
    // not a second real trade.
    const dup1 = outcome("L1", 3 * MIN, 60 * MIN, 0.2, "same-obs-id");
    const dup2 = outcome("L1", 3 * MIN, 60 * MIN, 0.2, "same-obs-id");
    const r = attributeOutcomes([], [dup1, dup2], OPTS);
    const st = r.perLane.find((l) => l.laneId === "L1")!;
    expect(st.outcomesSeen).toBe(2);
    expect(st.duplicateDropped).toBe(1); // previously 0 — the 2nd copy was never recognized as a dup
    expect(st.unattributedNoDecision).toBe(1); // previously 2 — inflated by the un-recognized duplicate
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

describe("cortexShadowDecisionAlpha (#219 — realized tilt-delta-R, 2026-07-20)", () => {
  const ex = (over: Partial<CortexAttributedExample> = {}): CortexAttributedExample => ({
    x: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    y: 1,
    tMs: 0,
    schemaVersion: 1,
    laneId: "L1",
    archetype: "BREADTH",
    regimeFamily: "BULL",
    observationId: "o1",
    netR: 0,
    resolvedAtMs: 0,
    eligibleAtDecision: true,
    finalPctAtDecision: 0,
    evalFinalPctAtDecision: 0,
    ...over,
  });

  it("zero examples ⇒ n=0, cumulativeTiltDeltaR=0, meanTiltDeltaR=null (never a fabricated 0-edge)", () => {
    const r = cortexShadowDecisionAlpha([]);
    expect(r).toEqual({ n: 0, cumulativeTiltDeltaR: 0, meanTiltDeltaR: null, perLane: [] });
  });

  it("an overweighted winner adds POSITIVE tilt-delta-R (the tilt correctly leaned into it)", () => {
    // eval overweights this lane by 20pp vs the incumbent's 10%, and it resolved +2R.
    const r = cortexShadowDecisionAlpha([ex({ finalPctAtDecision: 10, evalFinalPctAtDecision: 30, netR: 2 })]);
    expect(r.n).toBe(1);
    expect(r.cumulativeTiltDeltaR).toBeCloseTo(0.2 * 2, 9); // (30-10)/100 * 2
    expect(r.meanTiltDeltaR).toBeCloseTo(0.4, 9);
  });

  it("an underweighted winner adds NEGATIVE tilt-delta-R (the tilt missed upside by pulling away)", () => {
    const r = cortexShadowDecisionAlpha([ex({ finalPctAtDecision: 30, evalFinalPctAtDecision: 10, netR: 2 })]);
    expect(r.cumulativeTiltDeltaR).toBeCloseTo(-0.2 * 2, 9);
  });

  it("an overweighted LOSER adds negative tilt-delta-R (leaning into a loser is genuinely bad)", () => {
    const r = cortexShadowDecisionAlpha([ex({ finalPctAtDecision: 10, evalFinalPctAtDecision: 30, netR: -1.5 })]);
    expect(r.cumulativeTiltDeltaR).toBeCloseTo(0.2 * -1.5, 9);
  });

  it("no tilt (finalPct===evalFinalPct, e.g. β never ramped) contributes exactly 0 regardless of netR", () => {
    const r = cortexShadowDecisionAlpha([ex({ finalPctAtDecision: 15, evalFinalPctAtDecision: 15, netR: 5 })]);
    expect(r.cumulativeTiltDeltaR).toBe(0);
  });

  it("aggregates across lanes correctly: total = sum of per-lane, both directions net out honestly", () => {
    const examples = [
      ex({ laneId: "L1", finalPctAtDecision: 10, evalFinalPctAtDecision: 25, netR: 1, observationId: "a" }),
      ex({ laneId: "L1", finalPctAtDecision: 10, evalFinalPctAtDecision: 25, netR: -0.5, observationId: "b" }),
      ex({ laneId: "L2", finalPctAtDecision: 20, evalFinalPctAtDecision: 5, netR: 3, observationId: "c" }),
    ];
    const r = cortexShadowDecisionAlpha(examples);
    expect(r.n).toBe(3);
    const l1Expected = 0.15 * 1 + 0.15 * -0.5;
    const l2Expected = -0.15 * 3;
    expect(r.cumulativeTiltDeltaR).toBeCloseTo(l1Expected + l2Expected, 9);
    const byLane = Object.fromEntries(r.perLane.map((l) => [l.laneId, l]));
    expect(byLane.L1!.n).toBe(2);
    expect(byLane.L1!.cumulativeTiltDeltaR).toBeCloseTo(l1Expected, 9);
    expect(byLane.L2!.n).toBe(1);
    expect(byLane.L2!.cumulativeTiltDeltaR).toBeCloseTo(l2Expected, 9);
  });

  it("skips a non-finite weight or netR defensively rather than poisoning the sum with NaN", () => {
    const r = cortexShadowDecisionAlpha([
      ex({ finalPctAtDecision: NaN, evalFinalPctAtDecision: 20, netR: 1 }),
      ex({ finalPctAtDecision: 10, evalFinalPctAtDecision: 20, netR: 1, observationId: "ok" }),
    ]);
    expect(r.n).toBe(1); // the NaN row is dropped, not counted
    expect(Number.isFinite(r.cumulativeTiltDeltaR)).toBe(true);
    expect(r.cumulativeTiltDeltaR).toBeCloseTo(0.1, 9);
  });

  it("end-to-end wiring: finalPct/evalFinalPct survive readCortexDecisionRows-shaped input through attributeOutcomes into the alpha computation", () => {
    // A single decision at t=0 with a 25pp tilt (10% static -> 35% eval), then a trade opens+resolves
    // inside its TTL window, winning +2R. The realized tilt-delta-R must reflect that exact 25pp tilt.
    const decisions = [decision(0, { lanes: { L1: { finalPct: 10, evalFinalPct: 35 } } })];
    const outcomes = [outcome("L1", 5 * MIN, 10 * MIN, 2, "trade-1")];
    const attributed = attributeOutcomes(decisions, outcomes, OPTS);
    expect(attributed.examples).toHaveLength(1);
    expect(attributed.examples[0]!.finalPctAtDecision).toBe(10);
    expect(attributed.examples[0]!.evalFinalPctAtDecision).toBe(35);
    const alpha = cortexShadowDecisionAlpha(attributed.examples);
    expect(alpha.n).toBe(1);
    expect(alpha.cumulativeTiltDeltaR).toBeCloseTo(0.25 * 2, 9);
  });
});

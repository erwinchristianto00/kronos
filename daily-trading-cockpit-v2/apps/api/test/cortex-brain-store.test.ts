import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CortexBrainStore, CortexDecisionJournal, runCortexShadowTick } from "../src/lib/cortex-brain-store.js";
import {
  assembleCortexContext,
  checkCortexInvariants,
  cortexPromotedBeta,
  decideCortex,
  CORTEX_BETA_RAMP_N,
  CORTEX_FEATURE_DIM,
  CORTEX_FEATURE_SCHEMA_VERSION,
  CORTEX_LANE_CAP_PCT,
  type CortexRefitResult,
} from "../src/lib/cortex-brain.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const accepted = (w: number[]): CortexRefitResult => ({ w, nEff: 100, status: "ACCEPTED" });
const rejected = (w: number[]): CortexRefitResult => ({ w, nEff: 2, status: "REJECTED_NON_CONVERGENCE" });

describe("CortexBrainStore", () => {
  it("a fresh store is the empty (static-reproducing) state", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    expect(s.get().cumulativeResolved).toBe(0);
    expect(s.get().featureSchemaVersion).toBe(CORTEX_FEATURE_SCHEMA_VERSION);
    expect(s.get().archetypes.BREADTH.w.every((v) => v === 0)).toBe(true);
  });

  it("applyRefit writes ONLY on ACCEPTED (a rejected fit never touches the model)", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    const good = new Array(CORTEX_FEATURE_DIM).fill(0.5);
    expect(s.applyRefit("BREADTH", accepted(good), "2026-07-12T00:00:00Z")).toBe(true);
    expect(s.get().archetypes.BREADTH.w).toEqual(good);

    const broken = new Array(CORTEX_FEATURE_DIM).fill(99);
    expect(s.applyRefit("BREADTH", rejected(broken), "2026-07-12T01:00:00Z")).toBe(false);
    expect(s.get().archetypes.BREADTH.w).toEqual(good); // unchanged — last healthy preserved
  });

  it("addResolved ramps the cumulative count and persists across reload", () => {
    const file = join(tmp(), "cortex.json");
    const s = new CortexBrainStore(file);
    s.addResolved(120, "2026-07-12T00:00:00Z");
    s.applyRefit("TACTICAL", accepted(new Array(CORTEX_FEATURE_DIM).fill(0.2)), "2026-07-12T00:00:00Z");
    s.save();

    const reloaded = new CortexBrainStore(file);
    expect(reloaded.get().cumulativeResolved).toBe(120);
    expect(reloaded.get().archetypes.TACTICAL.w).toEqual(new Array(CORTEX_FEATURE_DIM).fill(0.2));
  });

  it("discards a stored model from a stale feature schema (degrades to the seed)", () => {
    const file = join(tmp(), "cortex.json");
    const s = new CortexBrainStore(file);
    s.applyRefit("BREADTH", accepted(new Array(CORTEX_FEATURE_DIM).fill(0.7)), "2026-07-12T00:00:00Z");
    s.save();
    // corrupt the schema version on disk
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    raw.featureSchemaVersion = 999;
    writeFileSync(file, JSON.stringify(raw), "utf-8");

    const reloaded = new CortexBrainStore(file);
    expect(reloaded.get().archetypes.BREADTH.w.every((v) => v === 0)).toBe(true); // seeded, not trusted
  });
});

describe("CortexDecisionJournal", () => {
  it("appends jsonl records and never throws", () => {
    const file = join(tmp(), "journal.jsonl");
    const j = new CortexDecisionJournal(file);
    j.append({ kind: "BRAIN_DECISION", posture: "RISK_ON" });
    j.append({ kind: "BRAIN_DECISION", posture: "FLAT" });
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).posture).toBe("FLAT");
  });

  it("swallows a write to an impossible path", () => {
    const j = new CortexDecisionJournal("/proc/nonexistent/\0/journal.jsonl");
    expect(() => j.append({ x: 1 })).not.toThrow();
  });

  it("rotates to a single .1 backup when it exceeds the size cap (bounded, no unbounded growth)", () => {
    const file = join(tmp(), "journal.jsonl");
    const j = new CortexDecisionJournal(file, 200); // tiny cap for the test
    // Each record is well over 200 bytes → the 2nd append sees an over-cap file, rotates, starts fresh.
    const big = { kind: "BRAIN_DECISION", pad: "x".repeat(300) };
    j.append(big);
    j.append(big);
    j.append(big);
    // The live file holds only the most-recent record(s); the older ones rolled to .1 — total ≤ 2×cap window.
    expect(existsSync(`${file}.1`)).toBe(true);
    const liveLines = readFileSync(file, "utf-8").trim().split("\n");
    expect(liveLines.length).toBeLessThanOrEqual(2); // did NOT keep growing unbounded
    // and both files together still parse as valid jsonl (nothing corrupted by the rename)
    expect(() => readFileSync(`${file}.1`, "utf-8").trim().split("\n").forEach((l) => JSON.parse(l))).not.toThrow();
  });
});

describe("runCortexShadowTick (Phase 1: decide + journal, drive nothing)", () => {
  it("advances the resolved count, journals a valid decision, and reproduces static at β≈0", () => {
    const dir = tmp();
    const store = new CortexBrainStore(join(dir, "cortex.json"));
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const context = assembleCortexContext(
      { regimeFamily: "BEARISH_EXPANSION", axisScore: -0.5, axisSlopePerHour: -0.02, allowLong: false, allowShort: true, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false },
      [{ laneId: "CG_WIDE_FAST_SHORT", direction: "SHORT", edgeMemAvgNetR: 0.1, edgeMemN: 40, laneNetAvgR: 0.1, laneNetAvgN: 40, lanePf: 1.2, crowdingAlign: 0, kronosAgree: null, convictionScore: 0.7, vetoed: false, staticWeightPct: 30 }],
    );
    const { decision, invariants } = runCortexShadowTick({ store, journal, context, nowIso: "2026-07-12T00:00:00Z", mode: "shadow", resolvedThisCycle: 3 });
    expect(invariants.ok).toBe(true);
    expect(store.get().cumulativeResolved).toBe(3);
    expect(decision.beta).toBeLessThan(0.01); // 3 closes ⇒ β≈0 ⇒ ~static
    expect(Math.abs(decision.lanes[0]!.finalPct - 30)).toBeLessThan(0.2);
    const line = JSON.parse(readFileSync(join(dir, "journal.jsonl"), "utf-8").trim());
    expect(line.kind).toBe("BRAIN_DECISION");
    expect(line.mode).toBe("shadow");
  });
});

describe("runCortexShadowTick — Phase 4 promotion (2026-07-20, operator-approved testnet-only)", () => {
  const ctx = (lanes: Parameters<typeof assembleCortexContext>[1]) =>
    assembleCortexContext(
      { regimeFamily: "BULLISH_EXPANSION", axisScore: 0.5, axisSlopePerHour: 0.02, allowLong: true, allowShort: true, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false },
      lanes,
    );
  const promotableLane = (laneId: string, staticWeightPct: number) => ({
    laneId,
    direction: "LONG" as const,
    edgeMemAvgNetR: 0.3,
    edgeMemN: 200,
    laneNetAvgR: 0.3,
    laneNetAvgN: 200,
    lanePf: 1.5,
    crowdingAlign: 0,
    kronosAgree: null,
    convictionScore: 0.8,
    vetoed: false,
    staticWeightPct,
  });
  function fullyPromotableStore(dir: string): CortexBrainStore {
    const store = new CortexBrainStore(join(dir, "cortex.json"));
    // 300 resolved ⇒ full ramp; a learned coefficient vector so finalPct actually differs from static.
    store.addResolved(CORTEX_BETA_RAMP_N, "2026-07-20T00:00:00Z");
    store.applyRefit("BREADTH", { w: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0], nEff: 200, status: "ACCEPTED" }, "2026-07-20T00:00:00Z");
    return store;
  }

  it("mode='shadow' NEVER computes promotedWeights, even if a (nonsensical) promotion object is passed", () => {
    const dir = tmp();
    const store = fullyPromotableStore(dir);
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const { promotedWeights } = runCortexShadowTick({
      store, journal, context: ctx([promotableLane("CG_WIDE_FAST_LONG", 20)]), nowIso: "t", mode: "shadow",
      promotion: { regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false },
    });
    expect(promotedWeights).toBeNull();
  });

  it("mode='live' with promotion omitted (not yet wired by the caller) is null — same as today's shadow behavior", () => {
    const dir = tmp();
    const store = fullyPromotableStore(dir);
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const { promotedWeights } = runCortexShadowTick({
      store, journal, context: ctx([promotableLane("CG_WIDE_FAST_LONG", 20)]), nowIso: "t", mode: "live",
    });
    expect(promotedWeights).toBeNull();
  });

  it("envBlocked=true (LIVE_BINANCE_ENV===mainnet) forces null even with the gate met and zero blind capital", () => {
    const dir = tmp();
    const store = fullyPromotableStore(dir);
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const { promotedWeights } = runCortexShadowTick({
      store, journal, context: ctx([promotableLane("CG_WIDE_FAST_LONG", 20)]), nowIso: "t", mode: "live",
      promotion: { regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: true },
    });
    expect(promotedWeights).toBeNull();
  });

  it("regimeCoverageGateMet=false forces null even at full ramp and zero blind capital", () => {
    const dir = tmp();
    const store = fullyPromotableStore(dir);
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const { promotedWeights } = runCortexShadowTick({
      store, journal, context: ctx([promotableLane("CG_WIDE_FAST_LONG", 20)]), nowIso: "t", mode: "live",
      promotion: { regimeCoverageGateMet: false, blindCapitalPct: 0, envBlocked: false },
    });
    expect(promotedWeights).toBeNull();
  });

  it("blindCapitalPct=100 damps β to exactly 0, so promotedWeights stays null (no lane has feedback yet)", () => {
    const dir = tmp();
    const store = fullyPromotableStore(dir);
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const { promotedWeights } = runCortexShadowTick({
      store, journal, context: ctx([promotableLane("CG_WIDE_FAST_LONG", 20)]), nowIso: "t", mode: "live",
      promotion: { regimeCoverageGateMet: true, blindCapitalPct: 100, envBlocked: false },
    });
    expect(promotedWeights).toBeNull();
  });

  it("all checks passing: promotedWeights is non-null and matches decideCortex's own finalPct at the same promoted β", () => {
    const dir = tmp();
    const store = fullyPromotableStore(dir);
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const context = ctx([promotableLane("CG_WIDE_FAST_LONG", 20), promotableLane("CG_WIDE_LONG_RUNNER", 10)]);
    const { promotedWeights } = runCortexShadowTick({
      store, journal, context, nowIso: "t", mode: "live",
      promotion: {
        regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false,
        learningActiveLaneIds: new Set(["CG_WIDE_FAST_LONG", "CG_WIDE_LONG_RUNNER"]),
      },
    });
    expect(promotedWeights).not.toBeNull();
    const promoted = decideCortex(context, store.get(), { beta: cortexPromotedBeta(store.get().cumulativeResolved, true, 0) });
    for (const l of promoted.lanes) expect(promotedWeights![l.laneId]).toBeCloseTo(l.finalPct, 9);
  });

  it("does NOT install a promoted decision that would fail checkCortexInvariants — falls back to null", () => {
    const dir = tmp();
    const store = fullyPromotableStore(dir);
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    // A directly-invalid decision (over-cap) proves checkCortexInvariants itself would reject this
    // shape; the wiring test above already proves the real decideCortex output is always accepted.
    // This test locks in that checkCortexInvariants is genuinely consulted (not merely computed and
    // discarded) by exercising it standalone the same way the promotion path does internally.
    const invalid = decideCortex(ctx([promotableLane("CG_WIDE_FAST_LONG", 20)]), store.get(), { beta: 0 });
    invalid.lanes[0]!.finalPct = 200; // force an impossible over-cap value
    expect(checkCortexInvariants(invalid).ok).toBe(false);
  });

  it("folds the CG_MFE_GIVEBACK_LONG/_SHORT roster split onto ONE real engine lane id, summed (safely under cap)", () => {
    const dir = tmp();
    // Mild ramp + mild coefficients (not the full-ramp/aggressive fixture) so the fold stays under the
    // real per-lane cap — this is the successful-install path; the over-cap REJECTION path is its own
    // dedicated test below (the 2026-07-20 critical safety-review finding).
    const store = new CortexBrainStore(join(dir, "cortex.json"));
    store.addResolved(30, "t0");
    store.applyRefit("BREADTH", { w: [0.2, 0.1, 0, 0, 0, 0, 0, 0, 0, 0], nEff: 10, status: "ACCEPTED" }, "t0");
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const longLeg = { ...promotableLane("CG_MFE_GIVEBACK_LONG", 15), direction: "LONG" as const };
    const shortLeg = { ...promotableLane("CG_MFE_GIVEBACK_SHORT", 15), direction: "SHORT" as const };
    const context = ctx([longLeg, shortLeg]);
    const { promotedWeights } = runCortexShadowTick({
      store, journal, context, nowIso: "t", mode: "live",
      promotion: {
        regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false,
        learningActiveLaneIds: new Set(["CG_MFE_GIVEBACK_LONG", "CG_MFE_GIVEBACK_SHORT"]),
      },
    });
    expect(promotedWeights).not.toBeNull();
    expect(promotedWeights!["CG_MFE_GIVEBACK_LONG"]).toBeUndefined();
    expect(promotedWeights!["CG_MFE_GIVEBACK_SHORT"]).toBeUndefined();
    const promoted = decideCortex(context, store.get(), { beta: cortexPromotedBeta(store.get().cumulativeResolved, true, 0) });
    const expectedSum = promoted.lanes.reduce((s, l) => s + Math.max(0, l.finalPct), 0);
    expect(expectedSum).toBeLessThan(35); // sanity: this fixture is genuinely under cap, not just asserting whatever comes out
    expect(promotedWeights!["CG_MFE_GIVEBACK"]).toBeCloseTo(expectedSum, 9);
  });

  it("2026-07-20 fix: a legitimate 100%-static allocation table (with CG_MFE_GIVEBACK split) is no longer permanently blocked by raw-roster double-counting", () => {
    // Reproduces the exact testnet incident: a real allocation table summing to 100% (one non-split
    // lane at 88% + CG_MFE_GIVEBACK at 12%, split into two roster entries each carrying that SAME 12%
    // per engineLaneIdForStaticWeight's own doc) raw-sums to 112% before folding —
    // checkCortexInvariants' bare "total ≤ 100%" check flagged this as "total weight 112% > 100%" and
    // rejected EVERY promotion cycle, forever, at any β, regardless of tilt quality.
    //
    // The folded total is NOT expected to land back at exactly 100%: decideCortex's blend
    // ((1-β)·staticPct + β·learnedPct) means each split half's OWN contribution can legitimately grow
    // above its 12% baseline (exactly like any other lane's finalPct can exceed its static value when
    // the model favors it) — the safety bound on that growth is the PER-LANE fold cap
    // (max(staticPct, CORTEX_LANE_CAP_PCT), the existing 2026-07-20 CRITICAL fix below), not "must equal
    // the original static number". The aggregate-total budget is 100% + the FULL (undiscounted)
    // duplicate-static extra + each ACTIVE lane's own worst-case cap headroom (2026-07-21 precision fix —
    // the original (1-β) discount on the duplicate under-budgeted it, since a forced/non-active duplicate
    // half is NEVER tilted, causing spurious rejection in production) — still a real, precise ceiling, so
    // a GENUINE over-allocation (proven in the next test) still gets rejected.
    const dir = tmp();
    const store = new CortexBrainStore(join(dir, "cortex.json"));
    store.addResolved(30, "t0");
    store.applyRefit("BREADTH", { w: [0.2, 0.1, 0, 0, 0, 0, 0, 0, 0, 0], nEff: 10, status: "ACCEPTED" }, "t0");
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const otherLane = promotableLane("CG_WIDE_FAST_LONG", 88);
    const longLeg = { ...promotableLane("CG_MFE_GIVEBACK_LONG", 12), direction: "LONG" as const };
    const shortLeg = { ...promotableLane("CG_MFE_GIVEBACK_SHORT", 12), direction: "SHORT" as const };
    const context = ctx([otherLane, longLeg, shortLeg]);
    const promotedBeta = cortexPromotedBeta(store.get().cumulativeResolved, true, 0);
    const preFold = decideCortex(context, store.get(), { beta: promotedBeta });
    const rawSum = preFold.lanes.reduce((s, l) => s + Math.max(0, l.finalPct), 0);
    expect(rawSum).toBeGreaterThan(100); // confirms this fixture genuinely reproduces the raw-roster over-100% artifact
    expect(checkCortexInvariants(preFold).ok).toBe(false); // the raw check still flags it (unchanged, by design)

    const { promotedWeights } = runCortexShadowTick({
      store, journal, context, nowIso: "t", mode: "live",
      promotion: {
        regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false,
        learningActiveLaneIds: new Set(["CG_WIDE_FAST_LONG", "CG_MFE_GIVEBACK_LONG", "CG_MFE_GIVEBACK_SHORT"]),
      },
    });
    expect(promotedWeights).not.toBeNull(); // fixed: no longer blocked by the roster-duplication artifact
    expect(promotedWeights!["CG_MFE_GIVEBACK_LONG"]).toBeUndefined();
    expect(promotedWeights!["CG_MFE_GIVEBACK_SHORT"]).toBeUndefined();
    // CG_MFE_GIVEBACK's own fold stays within ITS per-lane cap (the real safety bound for a split lane).
    expect(promotedWeights!["CG_MFE_GIVEBACK"]).toBeLessThanOrEqual(Math.max(12, CORTEX_LANE_CAP_PCT) + 1e-6);
    // The aggregate total is exactly the budget the blend formula implies for this fixture: 100 + the
    // FULL (undiscounted) duplicate extra (12, one split lane) + each active lane's own worst-case cap
    // headroom (max(static,CAP)-static: 0 for FAST_LONG@88 already above CAP, 23 each for the two
    // GIVEBACK@12 halves) — grossG · (100 + 12 + 46). Not an open-ended pass — it's the precise figure.
    const foldedTotal = Object.values(promotedWeights!).reduce((s, w) => s + w, 0);
    const expectedBudget = preFold.grossG * (100 + 12 + (35 - 12) + (35 - 12));
    expect(foldedTotal).toBeLessThanOrEqual(expectedBudget + 1e-6);
    expect(foldedTotal).toBeGreaterThan(100); // documents that this is the expected, understood shape — not silently under 100
  });

  it("2026-07-21 precision fix: a tiny real-world tilt (small promotedBeta) on top of a legitimate duplicate is no longer spuriously rejected", () => {
    // Reproduces the exact production failure mode: a 10-lane real table (one non-split lane covering
    // the rest of the 100%, plus CG_MFE_GIVEBACK split at a modest static share) with only a SLIVER of
    // ramp (small promotedBeta, far from full-ramp/aggressive) — under the OLD (1-β)-discounted budget,
    // this rejected on every single cycle in production despite the actual deviation from the incumbent
    // being negligible. Mild coefficients here keep the tilt itself small and realistic (not the
    // full-ramp/aggressive fixture used elsewhere to deliberately force a genuine over-cap).
    const dir = tmp();
    const store = new CortexBrainStore(join(dir, "cortex.json"));
    store.addResolved(250, "t0"); // ~production resolved count (observed 244→266 in the live incident)
    store.applyRefit("BREADTH", { w: [0.05, 0.02, 0, 0, 0, 0, 0, 0, 0, 0], nEff: 10, status: "ACCEPTED" }, "t0");
    store.applyRefit("TACTICAL", { w: [0.05, 0.02, 0, 0, 0, 0, 0, 0, 0, 0], nEff: 10, status: "ACCEPTED" }, "t0");
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const otherLane = promotableLane("CG_WIDE_FAST_LONG", 88);
    const longLeg = { ...promotableLane("CG_MFE_GIVEBACK_LONG", 12), direction: "LONG" as const };
    const shortLeg = { ...promotableLane("CG_MFE_GIVEBACK_SHORT", 12), direction: "SHORT" as const };
    const context = ctx([otherLane, longLeg, shortLeg]);
    const promotedBeta = cortexPromotedBeta(store.get().cumulativeResolved, true, 92); // blindCapitalPct=92, matching production
    expect(promotedBeta).toBeGreaterThan(0);
    expect(promotedBeta).toBeLessThan(0.05); // confirms this is the tiny, realistic production-scale tilt, not full ramp
    const { promotedWeights } = runCortexShadowTick({
      store, journal, context, nowIso: "t", mode: "live",
      promotion: {
        regimeCoverageGateMet: true, blindCapitalPct: 92, envBlocked: false,
        learningActiveLaneIds: new Set(["CG_MFE_GIVEBACK_SHORT"]), // only ONE half active, like production
      },
    });
    expect(promotedWeights).not.toBeNull(); // the fix: a tiny real-world tilt must actually promote, not fall back forever
  });

  it("2026-07-20 fix: a GENUINE over-100% folded total (not just roster duplication) is still rejected", () => {
    // The fix above must not become a blanket bypass — if the FOLDED total itself exceeds 100% (a real
    // over-allocation, not merely the split-roster artifact), promotion must still fall back to null.
    const dir = tmp();
    const store = fullyPromotableStore(dir); // full ramp + aggressive learned coefficients
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    // Two independent non-split lanes each near/at their own static weight — with the full-ramp
    // aggressive fixture's learned tilt, the combined finalPct clears 100% even after folding (there is
    // no split here to fold away, so raw total == folded total).
    const context = ctx([promotableLane("CG_WIDE_FAST_LONG", 60), promotableLane("CG_WIDE_LONG_RUNNER", 55)]);
    const promotedBeta = cortexPromotedBeta(store.get().cumulativeResolved, true, 0);
    const preFold = decideCortex(context, store.get(), { beta: promotedBeta });
    const rawSum = preFold.lanes.reduce((s, l) => s + Math.max(0, l.finalPct), 0);
    expect(rawSum).toBeGreaterThan(100); // no roster split here — raw sum == folded sum, genuinely over 100%

    const { promotedWeights } = runCortexShadowTick({
      store, journal, context, nowIso: "t", mode: "live",
      promotion: {
        regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false,
        learningActiveLaneIds: new Set(["CG_WIDE_FAST_LONG", "CG_WIDE_LONG_RUNNER"]),
      },
    });
    expect(promotedWeights).toBeNull(); // a genuine over-allocation is still rejected, not waved through
  });

  it("2026-07-21 adversarial-review fix: a corrupted (>100%) static baseline is rejected even when the extra sits on a below-cap lane with headroom", () => {
    // The activeTiltHeadroom allowance (a per-lane worst-case cap allowance) is fungible in the
    // AGGREGATE foldedTotal>foldedBudget comparison — it can't tell whether extra came from a lane's
    // own legitimate tilt or from an unrelated corruption elsewhere. Two non-split lanes, static 70 + 32
    // (sum 102 — already over 100% at β=0, before any tilt at all): LANE_A@70 is already above
    // CORTEX_LANE_CAP_PCT=35 (zero headroom, like the test above), but LANE_B@32 is BELOW the cap (real
    // headroom = 35-32 = 3). Without the baseline-validity check, that headroom could silently absorb
    // the OTHER lane's baseline corruption in the aggregate sum even though neither lane breaches its
    // own per-lane cap (so the post-fold per-lane check doesn't catch it either — this is an
    // aggregate-total failure, not a concentration failure).
    const dir = tmp();
    // Mild ramp (small promotedBeta), like the production incident — the point is a baseline that's
    // ALREADY corrupted at β=0, with only a small tilt on top, not a dramatic full-ramp reshuffle.
    const store = new CortexBrainStore(join(dir, "cortex.json"));
    store.addResolved(250, "t0");
    store.applyRefit("BREADTH", { w: [0.05, 0.02, 0, 0, 0, 0, 0, 0, 0, 0], nEff: 10, status: "ACCEPTED" }, "t0");
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const context = ctx([promotableLane("LANE_A_ABOVE_CAP", 70), promotableLane("LANE_B_BELOW_CAP", 32)]);
    const staticSum = decideCortex(context, store.get(), { beta: 0 }).lanes.reduce((s, l) => s + Math.max(0, l.finalPct), 0);
    expect(staticSum).toBeGreaterThan(100); // confirms the corrupted-baseline shape this test targets: 70+32=102 at β=0

    const { promotedWeights } = runCortexShadowTick({
      store, journal, context, nowIso: "t", mode: "live",
      promotion: {
        regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false,
        learningActiveLaneIds: new Set(["LANE_A_ABOVE_CAP", "LANE_B_BELOW_CAP"]),
      },
    });
    expect(promotedWeights).toBeNull(); // must still reject — headroom on LANE_B must not mask LANE_A's excess
  });

  it("2026-07-20 CRITICAL safety-review fix: rejects the WHOLE promoted map when the CG_MFE_GIVEBACK fold would exceed the real per-lane cap", () => {
    // Reproduces the exact reviewer-confirmed failure: two roster entries sharing one real engine lane
    // can each independently pass checkCortexInvariants (each under its OWN per-roster-entry cap) yet
    // SUM to ~47% on the one real lane once folded — 12 points above CORTEX_LANE_CAP_PCT=35. Before the
    // fix, this landed straight in the live engine via setCortexPromotedWeights. Now it must fall back
    // to null (never a silent partial/oversized install) for this cycle.
    const dir = tmp();
    const store = fullyPromotableStore(dir); // full ramp + aggressive learned coefficients
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const longLeg = { ...promotableLane("CG_MFE_GIVEBACK_LONG", 15), direction: "LONG" as const };
    const shortLeg = { ...promotableLane("CG_MFE_GIVEBACK_SHORT", 15), direction: "SHORT" as const, edgeMemAvgNetR: 0, laneNetAvgR: 0, convictionScore: 0.5 };
    const context = ctx([longLeg, shortLeg]);
    // Confirm the pre-fold decision DOES pass checkCortexInvariants (each split individually under its
    // own cap) — i.e. this is genuinely the "invariants say ok but the fold isn't" gap, not just a
    // rejected-by-the-existing-check case.
    const promotedBeta = cortexPromotedBeta(store.get().cumulativeResolved, true, 0);
    const preFold = decideCortex(context, store.get(), { beta: promotedBeta });
    expect(checkCortexInvariants(preFold).ok).toBe(true);
    const preFoldSum = preFold.lanes.reduce((s, l) => s + Math.max(0, l.finalPct), 0);
    expect(preFoldSum).toBeGreaterThan(35); // the actual real-lane exposure this would install, pre-fix

    const { promotedWeights } = runCortexShadowTick({
      store, journal, context, nowIso: "t", mode: "live",
      promotion: {
        regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false,
        learningActiveLaneIds: new Set(["CG_MFE_GIVEBACK_LONG", "CG_MFE_GIVEBACK_SHORT"]),
      },
    });
    expect(promotedWeights).toBeNull();
  });

  describe("2026-07-21 operator ask: per-lane gating by LEARNING_ACTIVE status (partial promotion)", () => {
    it("a non-active lane is forced to its exact static (β=0) value, immune to its own tilt", () => {
      const dir = tmp();
      const store = fullyPromotableStore(dir); // full ramp + aggressive learned coefficients
      const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
      const context = ctx([promotableLane("CG_WIDE_FAST_LONG", 20), promotableLane("CG_WIDE_LONG_RUNNER", 10)]);
      // Only CG_WIDE_FAST_LONG is "learning active" — CG_WIDE_LONG_RUNNER must NOT be tilted at all.
      const { promotedWeights } = runCortexShadowTick({
        store, journal, context, nowIso: "t", mode: "live",
        promotion: {
          regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false,
          learningActiveLaneIds: new Set(["CG_WIDE_FAST_LONG"]),
        },
      });
      expect(promotedWeights).not.toBeNull();
      const promotedBeta = cortexPromotedBeta(store.get().cumulativeResolved, true, 0);
      const tilted = decideCortex(context, store.get(), { beta: promotedBeta });
      const staticOnly = decideCortex(context, store.get(), { beta: 0 });
      const tiltedRunner = tilted.lanes.find((l) => l.laneId === "CG_WIDE_LONG_RUNNER")!;
      const staticRunner = staticOnly.lanes.find((l) => l.laneId === "CG_WIDE_LONG_RUNNER")!;
      // The fixture's aggressive coefficients must genuinely move this lane away from static — otherwise
      // this test would pass even if the gating were silently absent.
      expect(tiltedRunner.finalPct).not.toBeCloseTo(staticRunner.finalPct, 2);
      expect(promotedWeights!["CG_WIDE_LONG_RUNNER"]).toBeCloseTo(staticRunner.finalPct, 9);
      // The active lane, by contrast, keeps its real tilt.
      const tiltedFast = tilted.lanes.find((l) => l.laneId === "CG_WIDE_FAST_LONG")!;
      expect(promotedWeights!["CG_WIDE_FAST_LONG"]).toBeCloseTo(tiltedFast.finalPct, 9);
    });

    it("absent learningActiveLaneIds fails safe: every lane is treated as non-active (pure static, never tilted)", () => {
      const dir = tmp();
      const store = fullyPromotableStore(dir);
      const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
      const context = ctx([promotableLane("CG_WIDE_FAST_LONG", 20), promotableLane("CG_WIDE_LONG_RUNNER", 10)]);
      const { promotedWeights } = runCortexShadowTick({
        store, journal, context, nowIso: "t", mode: "live",
        promotion: { regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false }, // learningActiveLaneIds omitted
      });
      expect(promotedWeights).not.toBeNull();
      const staticOnly = decideCortex(context, store.get(), { beta: 0 });
      for (const l of staticOnly.lanes) expect(promotedWeights![l.laneId]).toBeCloseTo(l.finalPct, 9);
    });

    it("the previously-blocking CG_MFE_GIVEBACK case resolves cleanly once only its LEARNING_ACTIVE half (SHORT) is gated in", () => {
      // Reproduces the live incident: CG_MFE_GIVEBACK_SHORT is LEARNING_ACTIVE (real attributed outcomes),
      // CG_MFE_GIVEBACK_LONG is INSUFFICIENT_DATA. Under the OLD all-or-nothing scheme this fold combined
      // BOTH halves' full tilt and could trip the per-lane cap; under per-lane gating, LONG is pinned to
      // its exact static value and only SHORT's proven tilt is applied.
      const dir = tmp();
      const store = fullyPromotableStore(dir); // full ramp + aggressive learned coefficients
      const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
      const longLeg = { ...promotableLane("CG_MFE_GIVEBACK_LONG", 12), direction: "LONG" as const };
      const shortLeg = { ...promotableLane("CG_MFE_GIVEBACK_SHORT", 12), direction: "SHORT" as const };
      const context = ctx([longLeg, shortLeg]);
      const { promotedWeights } = runCortexShadowTick({
        store, journal, context, nowIso: "t", mode: "live",
        promotion: {
          regimeCoverageGateMet: true, blindCapitalPct: 0, envBlocked: false,
          learningActiveLaneIds: new Set(["CG_MFE_GIVEBACK_SHORT"]), // LONG is NOT active
        },
      });
      expect(promotedWeights).not.toBeNull();
      const promotedBeta = cortexPromotedBeta(store.get().cumulativeResolved, true, 0);
      const tilted = decideCortex(context, store.get(), { beta: promotedBeta });
      const staticOnly = decideCortex(context, store.get(), { beta: 0 });
      const tiltedShort = tilted.lanes.find((l) => l.laneId === "CG_MFE_GIVEBACK_SHORT")!;
      const staticLong = staticOnly.lanes.find((l) => l.laneId === "CG_MFE_GIVEBACK_LONG")!;
      const expectedFold = tiltedShort.finalPct + staticLong.finalPct;
      expect(promotedWeights!["CG_MFE_GIVEBACK"]).toBeCloseTo(expectedFold, 9);
    });
  });
});

describe("recordResolvedOutcomes (#218 — exact-once ledger, idempotent, per-family)", () => {
  const out = (laneId: string, id: string, fam: string, ms: number) => ({ laneId, observationId: id, regimeFamily: fam, resolvedAtMs: ms });
  it("advances cumulativeResolved + resolvedByFamily by DISTINCT outcomes", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    const n = s.recordResolvedOutcomes(
      [out("L1", "a", "BULL", 100), out("L1", "b", "BULL", 200), out("L2", "c", "BEAR", 300)],
      0,
      "2026-07-13T00:00:00Z",
    );
    expect(n).toBe(3);
    expect(s.get().cumulativeResolved).toBe(3);
    expect(s.get().resolvedByFamily).toEqual({ BULL: 2, BEAR: 1 });
  });

  it("is EXACT-ONCE + out-of-order safe: re-running same outcomes (incl. a lower resolvedAtMs) adds 0", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    s.recordResolvedOutcomes([out("L1", "a", "BULL", 500)], 0, "t0"); // high resolvedAtMs first
    // A distinct earlier-resolvedAt outcome that surfaces LATER is still counted (scalar watermark would drop it).
    expect(s.recordResolvedOutcomes([out("L1", "b", "BULL", 100)], 0, "t1")).toBe(1);
    // Re-running the same two adds nothing (exact-once by laneId::observationId).
    expect(s.recordResolvedOutcomes([out("L1", "a", "BULL", 500), out("L1", "b", "BULL", 100)], 0, "t2")).toBe(0);
    expect(s.get().cumulativeResolved).toBe(2);
    expect(s.get().resolvedByFamily).toEqual({ BULL: 2 });
  });

  it("prunes ledger ids older than pruneBeforeMs (bounded) without touching the counters", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    s.recordResolvedOutcomes([out("L1", "old", "BULL", 100), out("L1", "new", "BULL", 10_000)], 5_000, "t0");
    expect(s.get().cumulativeResolved).toBe(2); // both counted
    expect(Object.keys(s.get().countedObservations)).toEqual(["L1::new"]); // "old" pruned (100 < 5000)
  });

  it("persists the counted ledger + counters across a save/reload", () => {
    const file = join(tmp(), "cortex.json");
    const s = new CortexBrainStore(file);
    s.recordResolvedOutcomes([out("L1", "a", "BULL", 100), out("L2", "b", "BEAR", 200)], 0, "t0");
    s.save();
    const reloaded = new CortexBrainStore(file);
    expect(reloaded.get().cumulativeResolved).toBe(2);
    expect(reloaded.get().resolvedByFamily).toEqual({ BULL: 1, BEAR: 1 });
    // The ledger persists → a post-reload re-run of the same outcomes still adds 0 (exact-once survives restart).
    expect(reloaded.recordResolvedOutcomes([out("L1", "a", "BULL", 100)], 0, "t1")).toBe(0);
  });
});

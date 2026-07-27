import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bucketResolvedByUtcDay,
  computeCortexReadiness,
  countResolvedInWindow,
  CortexReadinessHistoryStore,
  CORTEX_READINESS_BLIND_CAPITAL_FLOOR_PCT,
  CORTEX_READINESS_HISTORY_MAX_DAYS,
  CORTEX_READINESS_WEIGHTS,
  type CortexReadinessInputs,
  type CortexReadinessRefitInput,
  type CortexReadinessSnapshot,
} from "../src/lib/cortex-readiness.js";
import {
  buildCortexReadinessEndpointResponse,
  buildLocalCortexReadiness,
  fetchPeerCortexReadiness,
  normalizeCortexReadinessPeerUrl,
  parseCortexBrainJsonForReadiness,
} from "../src/lib/cortex-readiness-bindings.js";
import {
  _resetLatestCortexRefitReportForTests,
  _resetLatestCortexShadowDecisionAlphaForTests,
} from "../src/lib/cortex-refit-runner-bindings.js";
import { _resetCortexCollectionStatusAccumulatorsForTests } from "../src/lib/cortex-collection-status.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-07-21T12:00:00Z");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-readiness-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRefit(overrides: Partial<CortexReadinessRefitInput> = {}): CortexReadinessRefitInput {
  return {
    at: new Date(NOW).toISOString(),
    examplesTotal: 126,
    journalBadLines: 0,
    blindCapitalPct: 92,
    regimeCoverageGateMet: true,
    regimeFamiliesWithOutcomes: 2,
    learningActiveLanes: 4,
    evaluationBeta: 0.15,
    archetypes: [
      { archetype: "BREADTH", status: "ACCEPTED", examples: 90 },
      { archetype: "NEUTRAL", status: "NO_EXAMPLES", examples: 0 },
      { archetype: "TACTICAL", status: "ACCEPTED", examples: 36 },
    ],
    perLane: [
      { laneId: "A", status: "LEARNING_ACTIVE", staticWeightPct: 5 },
      { laneId: "B", status: "INSUFFICIENT_DATA", staticWeightPct: 40 },
      { laneId: "C", status: "NO_OUTCOME_SOURCE", staticWeightPct: 10 },
    ],
    reinforcement: [
      { laneId: "A", positive: 30, noReward: 40 },
      { laneId: "B", positive: 20, noReward: 36 },
    ],
    ...overrides,
  };
}

function makeInputs(overrides: Partial<CortexReadinessInputs> = {}): CortexReadinessInputs {
  return {
    brain: {
      cumulativeResolved: 150,
      resolvedByFamily: { BREADTH: 100, NEUTRAL: 50 },
      ledgerResolvedAtMs: [],
      updatedAt: new Date(NOW).toISOString(),
    },
    refit: makeRefit(),
    collection: null,
    decisionAlpha: null,
    history: [],
    rosterSize: 16,
    nowMs: NOW,
    ...overrides,
  };
}

describe("computeCortexReadiness — component math (the documented formula, no black box)", () => {
  it("weights sum to exactly 1", () => {
    const sum = Object.values(CORTEX_READINESS_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("computes each component % from the actual promotion-gate inputs", () => {
    const r = computeCortexReadiness(makeInputs());
    const byKey = Object.fromEntries(r.components.map((c) => [c.key, c.pct]));
    expect(byKey.betaRamp).toBeCloseTo(50, 2); // 150/300
    expect(byKey.capitalCoverage).toBeCloseTo(((100 - 92) / (100 - CORTEX_READINESS_BLIND_CAPITAL_FLOOR_PCT)) * 100, 1); // 8.89
    expect(byKey.laneCoverage).toBeCloseTo(25, 2); // 4/16
    expect(byKey.regimeCoverage).toBeCloseTo(100, 2); // 2/2 families
    // headline = weighted sum of the (unrounded) components
    expect(r.readinessPct).toBeCloseTo(0.4 * 50 + 0.25 * (800 / 90) + 0.2 * 25 + 0.15 * 100, 1);
    expect(r.ready).toBe(false);
  });

  it("capital coverage reaches 100% at the DOCUMENTED floor, not only at 0% blind", () => {
    const atFloor = computeCortexReadiness(makeInputs({ refit: makeRefit({ blindCapitalPct: CORTEX_READINESS_BLIND_CAPITAL_FLOOR_PCT }) }));
    expect(atFloor.components.find((c) => c.key === "capitalCoverage")!.pct).toBe(100);
    const fullyBlind = computeCortexReadiness(makeInputs({ refit: makeRefit({ blindCapitalPct: 100 }) }));
    expect(fullyBlind.components.find((c) => c.key === "capitalCoverage")!.pct).toBe(0);
  });

  it("regime coverage mirrors the gate: families with >0 resolved in the PERSISTED store, over the gate minimum", () => {
    const oneFamily = computeCortexReadiness(
      makeInputs({
        brain: { cumulativeResolved: 150, resolvedByFamily: { BREADTH: 150, NEUTRAL: 0 }, ledgerResolvedAtMs: [], updatedAt: null },
        // even if a stale refit report claims 3 families, the persisted brain state wins
        refit: makeRefit({ regimeFamiliesWithOutcomes: 3 }),
      }),
    );
    expect(oneFamily.components.find((c) => c.key === "regimeCoverage")!.pct).toBe(50);
    expect(oneFamily.components.find((c) => c.key === "regimeCoverage")!.detail).toContain("NOT MET");
  });

  it("all-null inputs: readiness 0, no rate basis, no ETA, STUCK — and never throws", () => {
    const r = computeCortexReadiness(makeInputs({ brain: null, refit: null, collection: null, decisionAlpha: null }));
    expect(r.readinessPct).toBe(0);
    expect(r.ready).toBe(false);
    expect(r.rate.pctPerDay).toBeNull();
    expect(r.rate.basis).toBeNull();
    expect(r.eta.etaDays).toBeNull();
    expect(r.eta.reason).toContain("belum");
    expect(r.status.state).toBe("STUCK");
    expect(r.inputsPresent).toEqual({ brain: false, refit: false, collection: false, decisionAlpha: false, historyDays: 0 });
    expect(r.promotionEvidence.ready).toBe(false);
  });

  it("keeps evidence readiness separate and blocks concentrated alpha despite ample samples", () => {
    const r = computeCortexReadiness(makeInputs({
      brain: {
        cumulativeResolved: 350,
        resolvedByFamily: { BREADTH: 200, NEUTRAL: 150 },
        ledgerResolvedAtMs: [],
        updatedAt: null,
      },
      refit: makeRefit({
        archetypes: [
          { archetype: "BREADTH", status: "ACCEPTED", examples: 200 },
          { archetype: "NEUTRAL", status: "ACCEPTED", examples: 100 },
          { archetype: "TACTICAL", status: "ACCEPTED", examples: 50 },
        ],
      }),
      decisionAlpha: {
        n: 300,
        cumulativeTiltDeltaR: 3,
        meanTiltDeltaR: 0.01,
        perLane: [
          { laneId: "DOMINANT", n: 250, cumulativeTiltDeltaR: 2.7 },
          { laneId: "OTHER", n: 50, cumulativeTiltDeltaR: 0.3 },
        ],
        clusteredCi95: {
          clusterBy: "UTC_DAY",
          clusters: 8,
          lowerMeanTiltDeltaR: 0.002,
          upperMeanTiltDeltaR: 0.018,
        },
      },
    }));
    expect(r.promotionEvidence.ready).toBe(false);
    expect(r.promotionEvidence.largestPositiveLaneSharePct).toBe(90);
    expect(r.promotionEvidence.blockers.some((b) => b.includes("one lane"))).toBe(true);
  });

  it("READY exactly when all four gate conditions saturate (full ramp + families + blind ≤ floor + all lanes active)", () => {
    const ready = computeCortexReadiness(
      makeInputs({
        brain: { cumulativeResolved: 300, resolvedByFamily: { BREADTH: 200, NEUTRAL: 100 }, ledgerResolvedAtMs: [], updatedAt: null },
        refit: makeRefit({ blindCapitalPct: 10, learningActiveLanes: 16 }),
      }),
    );
    expect(ready.ready).toBe(true);
    expect(ready.readinessPct).toBe(100);
    expect(ready.eta.etaDays).toBe(0);
    // promotedBeta at these inputs: cortexBeta(300)=0.3 × (1 − 10/100) = 0.27
    expect(ready.beta.promotedBeta).toBeCloseTo(0.27, 3);

    // one lane short of full roster coverage ⇒ NOT ready even with everything else saturated
    const oneShort = computeCortexReadiness(
      makeInputs({
        brain: { cumulativeResolved: 300, resolvedByFamily: { BREADTH: 200, NEUTRAL: 100 }, ledgerResolvedAtMs: [], updatedAt: null },
        refit: makeRefit({ blindCapitalPct: 10, learningActiveLanes: 15 }),
      }),
    );
    expect(oneShort.ready).toBe(false);
  });

  it("[REGRESSION 2026-07-22] readinessPct and ready never contradict each other at the capital-coverage rounding boundary", () => {
    // blindCapitalPct is fractionally ABOVE the floor (10.002 vs floor 10) — capitalCoveragePct's raw
    // value is 99.9978%, which round2() displays as "100.00" even though the true float hasn't
    // reached the floor. Before the fix, `ready` compared the UNROUNDED blindCapitalPct <= FLOOR
    // (false) while readinessPct/component.pct both rounded to display 100.00 — a visible
    // contradiction (dashboard shows "100.00% ready" next to a NOT-READY badge).
    const r = computeCortexReadiness(
      makeInputs({
        brain: { cumulativeResolved: 300, resolvedByFamily: { BREADTH: 200, NEUTRAL: 100 }, ledgerResolvedAtMs: [], updatedAt: null },
        refit: makeRefit({ blindCapitalPct: CORTEX_READINESS_BLIND_CAPITAL_FLOOR_PCT + 0.002, learningActiveLanes: 16 }),
      }),
    );
    expect(r.components.find((c) => c.key === "capitalCoverage")!.pct).toBe(100);
    expect(r.readinessPct).toBe(100);
    expect(r.ready).toBe(true); // must agree with the displayed 100.00%, not the unrounded float
  });

  it("[REGRESSION 2026-07-22] the AGGREGATE readinessPct/ETA never shows '100% / arrived' while `ready` is false and the capitalCoverage component itself is displayed below 100%", () => {
    // Different failure mode than the test above: here every OTHER component individually rounds to
    // a clean 100 (betaRamp, laneCoverage, regimeCoverage), but capitalCoverage itself stays a genuine
    // 99.99 (blindCapitalPct 10.009, just 0.009 above the floor) — `ready` correctly reads false. The
    // bug was that the WEIGHTED SUM of these 4 components (0.4*100+0.25*99.99+0.2*100+0.15*100 =
    // 99.9975) rounds UP to a clean 100.00 on its own, independent of any single component's rounding —
    // producing a headline "100.00%" + ETA "arrived now" directly contradicting the not-ready capital-
    // coverage bar and the NOT-READY badge shown right next to it.
    const r = computeCortexReadiness(
      makeInputs({
        brain: { cumulativeResolved: 300, resolvedByFamily: { BREADTH: 200, NEUTRAL: 100 }, ledgerResolvedAtMs: [], updatedAt: null },
        refit: makeRefit({ blindCapitalPct: 10.009, learningActiveLanes: 16 }),
      }),
    );
    expect(r.components.find((c) => c.key === "capitalCoverage")!.pct).toBe(99.99);
    expect(r.ready).toBe(false);
    expect(r.readinessPct).toBeLessThan(100); // previously 100 — the headline lied
    expect(r.eta.etaDays).not.toBe(0); // previously fired the "arrived now" branch
  });
});

describe("computeCortexReadiness — rate + ETA (honest basis hierarchy)", () => {
  it("with no history, uses the ledger β-ramp-only basis and labels it an underestimate", () => {
    const ledger: number[] = [];
    for (let i = 0; i < 14; i += 1) ledger.push(NOW - (i * 12 + 1) * 3_600_000); // 14 resolved spread over last 7d
    const r = computeCortexReadiness(makeInputs({ brain: { cumulativeResolved: 150, resolvedByFamily: { A: 150 }, ledgerResolvedAtMs: ledger, updatedAt: null } }));
    expect(r.rate.basis).toBe("ledger-beta-only");
    // 14/7 = 2 resolved/day → betaRamp moves 2/300 × 100 %/day × weight 0.40 = 0.267
    expect(r.rate.pctPerDay).toBeCloseTo(0.27, 2);
    expect(r.rate.basisNote).toContain("UNDERESTIMATE");
  });

  it("[REGRESSION 2026-07-22] ledger basis reports null (honest 'unmeasured', not a literal 0) once the β-ramp is already saturated with no daily history yet", () => {
    // Previously hard-floored to the literal number 0 here, which the dashboard renders identically
    // to "measured, genuinely flat progress" (only null renders as the honest "—" placeholder) — this
    // basis has no way to measure the other 3 readiness components once β-ramp itself has no headroom
    // left, so it must report null (unmeasured), not a fabricated zero.
    const ledger = [NOW - 3_600_000, NOW - 2 * 3_600_000];
    const r = computeCortexReadiness(
      makeInputs({ brain: { cumulativeResolved: 300, resolvedByFamily: { A: 300 }, ledgerResolvedAtMs: ledger, updatedAt: null } }),
    );
    expect(r.rate.basis).toBe("ledger-beta-only");
    expect(r.rate.pctPerDay).toBeNull();
    expect(r.eta.etaDays).toBeNull();
    expect(r.eta.reason).not.toBeNull();
    expect(r.eta.reason).toContain("belum ada data rate sama sekali");
  });

  it("prefers the history basis once a snapshot ≥1 day old exists, and derives the ETA from it", () => {
    const snap: CortexReadinessSnapshot = {
      dateUtc: "2026-07-19",
      atIso: new Date(NOW - 2 * DAY_MS).toISOString(),
      readinessPct: 30,
      components: {},
      cumulativeResolved: 100,
      blindCapitalPct: 95,
      learningActiveLanes: 2,
      refitAccepted: 1,
      refitRejected: 0,
    };
    const r = computeCortexReadiness(makeInputs({ history: [snap], brain: { cumulativeResolved: 150, resolvedByFamily: { BREADTH: 100, NEUTRAL: 50 }, ledgerResolvedAtMs: [NOW - 3_600_000], updatedAt: null } }));
    expect(r.rate.basis).toBe("history");
    const expectedRate = (r.readinessPct - 30) / 2;
    expect(r.rate.pctPerDay).toBeCloseTo(expectedRate, 2);
    expect(r.eta.etaDays).toBeCloseTo(Math.round(((100 - r.readinessPct) / expectedRate) * 100) / 100, 1);
    expect(r.eta.etaIso).not.toBeNull();
    expect(Date.parse(r.eta.etaIso!)).toBeCloseTo(NOW + r.eta.etaDays! * DAY_MS, -4);
  });

  it("a same-day snapshot is NOT a rate basis (span ≈ 0 would be noise)", () => {
    const snap: CortexReadinessSnapshot = {
      dateUtc: new Date(NOW).toISOString().slice(0, 10),
      atIso: new Date(NOW - 3 * 3_600_000).toISOString(),
      readinessPct: 30,
      components: {},
      cumulativeResolved: 100,
      blindCapitalPct: null,
      learningActiveLanes: null,
      refitAccepted: null,
      refitRejected: null,
    };
    const r = computeCortexReadiness(makeInputs({ history: [snap] })); // empty ledger ⇒ no fallback either
    expect(r.rate.basis).toBeNull();
  });

  it("a NEGATIVE history rate (readiness regressed) yields no ETA, with the reason spelled out", () => {
    const snap: CortexReadinessSnapshot = {
      dateUtc: "2026-07-19",
      atIso: new Date(NOW - 2 * DAY_MS).toISOString(),
      readinessPct: 90,
      components: {},
      cumulativeResolved: 250,
      blindCapitalPct: 20,
      learningActiveLanes: 12,
      refitAccepted: 2,
      refitRejected: 0,
    };
    const r = computeCortexReadiness(makeInputs({ history: [snap] }));
    expect(r.rate.basis).toBe("history");
    expect(r.rate.pctPerDay!).toBeLessThan(0);
    expect(r.eta.etaDays).toBeNull();
    expect(r.eta.reason).toContain("negatif");
  });
});

describe("computeCortexReadiness — status classification (pre-registered thresholds)", () => {
  const prior14 = (): number[] => {
    // 14 outcomes inside (now−8d, now−1d] ⇒ prior average 2/day
    const out: number[] = [];
    for (let i = 0; i < 14; i += 1) out.push(NOW - DAY_MS - (i * 11 + 1) * 3_600_000);
    return out;
  };
  const withLedger = (ledger: number[]) =>
    computeCortexReadiness(makeInputs({ brain: { cumulativeResolved: 150, resolvedByFamily: { A: 150 }, ledgerResolvedAtMs: ledger, updatedAt: null } }));

  it("STUCK: zero resolved in the last 24h", () => {
    const r = withLedger(prior14());
    expect(r.status.state).toBe("STUCK");
    expect(r.status.last24hResolved).toBe(0);
    expect(r.status.prior7dAvgPerDay).toBeCloseTo(2, 2);
  });

  it("STEADY_PROGRESS: last-24h ≥ 60% of the prior-7d per-24h average", () => {
    const r = withLedger([...prior14(), NOW - 3_600_000, NOW - 5 * 3_600_000]); // 2 in last 24h vs avg 2
    expect(r.status.state).toBe("STEADY_PROGRESS");
    expect(r.status.ratioPct).toBeCloseTo(100, 1);
  });

  it("SLOWED_DOWN: last-24h below 60% of the prior average", () => {
    const r = withLedger([...prior14(), NOW - 3_600_000]); // 1 in last 24h vs avg 2 ⇒ 50%
    expect(r.status.state).toBe("SLOWED_DOWN");
    expect(r.status.ratioPct).toBeCloseTo(50, 1);
  });

  it("any progress against a zero prior baseline counts as STEADY_PROGRESS", () => {
    const r = withLedger([NOW - 3_600_000]);
    expect(r.status.state).toBe("STEADY_PROGRESS");
    expect(r.status.ratioPct).toBeNull();
  });
});

describe("bucketResolvedByUtcDay / countResolvedInWindow — UTC boundary exactness", () => {
  it("buckets by UTC calendar day with exact midnight boundaries; future + out-of-window ignored", () => {
    const now = Date.parse("2026-07-21T10:00:00Z");
    const buckets = bucketResolvedByUtcDay(
      [
        Date.parse("2026-07-21T00:00:00.000Z"), // first ms of today
        Date.parse("2026-07-20T23:59:59.999Z"), // last ms of yesterday
        Date.parse("2026-07-15T00:00:00.000Z"), // oldest day still in the 7-day window
        Date.parse("2026-07-14T23:59:59.999Z"), // just outside
        now + 3_600_000, // future — ignored
        Number.NaN, // corrupt — ignored
      ],
      now,
      7,
    );
    expect(buckets).toHaveLength(7);
    expect(buckets[0]).toEqual({ dateUtc: "2026-07-15", resolved: 1 });
    expect(buckets[5]).toEqual({ dateUtc: "2026-07-20", resolved: 1 });
    expect(buckets[6]).toEqual({ dateUtc: "2026-07-21", resolved: 1 });
    expect(buckets.reduce((s, b) => s + b.resolved, 0)).toBe(3);
  });

  it("window counting is (start, end]: the exact window-start instant is excluded, `now` included", () => {
    const now = NOW;
    expect(countResolvedInWindow([now - DAY_MS], now, DAY_MS)).toBe(0); // exactly 24h old — excluded
    expect(countResolvedInWindow([now - DAY_MS + 1], now, DAY_MS)).toBe(1);
    expect(countResolvedInWindow([now], now, DAY_MS)).toBe(1);
  });
});

describe("computeCortexReadiness — quality + reinforcement summaries", () => {
  it("surfaces the examples-vs-resolved gap, per-archetype statuses, family balance and lane tallies", () => {
    const r = computeCortexReadiness(makeInputs());
    expect(r.quality.cumulativeResolved).toBe(150);
    expect(r.quality.examplesTotal).toBe(126);
    expect(r.quality.examplesGap).toBe(24);
    expect(r.quality.archetypes.find((a) => a.archetype === "NEUTRAL")!.status).toBe("NO_EXAMPLES");
    expect(r.quality.familyBalance[0]).toEqual({ family: "BREADTH", resolved: 100, sharePct: 66.67 });
    expect(r.quality.largestFamilySharePct).toBeCloseTo(66.67, 1);
    expect(r.quality.lanes).toEqual({ total: 3, learningActive: 1, insufficientData: 1, noOutcomeSource: 1, schemaMismatch: 0 });
  });

  it("aggregates the y=1 / y=0 training-label split and the refit acceptance tallies", () => {
    const r = computeCortexReadiness(makeInputs());
    expect(r.reinforcement.positive).toBe(50);
    expect(r.reinforcement.noReward).toBe(76);
    expect(r.reinforcement.positiveSharePct).toBeCloseTo((50 / 126) * 100, 1);
    expect(r.reinforcement.refitAccepted).toBe(2);
    expect(r.reinforcement.refitRejected).toBe(0);
    expect(r.reinforcement.refitNoExamples).toBe(1);
  });
});

describe("CortexReadinessHistoryStore — bounded + atomic + never throws", () => {
  const snap = (dateUtc: string, readinessPct: number): CortexReadinessSnapshot => ({
    dateUtc,
    atIso: `${dateUtc}T12:00:00.000Z`,
    readinessPct,
    components: { betaRamp: readinessPct },
    cumulativeResolved: Math.round(readinessPct * 3),
    blindCapitalPct: null,
    learningActiveLanes: null,
    refitAccepted: null,
    refitRejected: null,
  });

  it("record() upserts by UTC day — same-day calls converge to the latest value, one entry per day", () => {
    const file = join(tmp(), "hist.json");
    const store = new CortexReadinessHistoryStore(file);
    store.record(snap("2026-07-20", 10));
    store.record(snap("2026-07-20", 12));
    store.record(snap("2026-07-21", 13));
    expect(store.all()).toHaveLength(2);
    expect(store.all().find((s) => s.dateUtc === "2026-07-20")!.readinessPct).toBe(12);
    // persisted + reloadable + valid JSON on disk (atomic write, no .tmp leftover)
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const reloaded = new CortexReadinessHistoryStore(file);
    expect(reloaded.all()).toHaveLength(2);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toHaveLength(2);
  });

  it("keeps at most the newest 120 days", () => {
    const file = join(tmp(), "hist.json");
    const store = new CortexReadinessHistoryStore(file);
    for (let i = 0; i < 130; i += 1) {
      const d = new Date(Date.parse("2026-01-01T00:00:00Z") + i * DAY_MS).toISOString().slice(0, 10);
      store.record(snap(d, i));
    }
    const all = store.all();
    expect(all).toHaveLength(CORTEX_READINESS_HISTORY_MAX_DAYS);
    expect(all[0]!.dateUtc).toBe("2026-01-11"); // the 10 oldest dropped
    expect(all.at(-1)!.dateUtc).toBe("2026-05-10");
  });

  it("a corrupt file loads as empty history, never throws", () => {
    const file = join(tmp(), "hist.json");
    writeFileSync(file, "{not json!!", "utf-8");
    const store = new CortexReadinessHistoryStore(file);
    expect(store.all()).toEqual([]);
    store.record(snap("2026-07-21", 5)); // and recovers by overwriting
    expect(new CortexReadinessHistoryStore(file).all()).toHaveLength(1);
  });

  it("record() never throws even when the path is unwritable", () => {
    const dir = tmp();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file, not a directory", "utf-8");
    const store = new CortexReadinessHistoryStore(join(blocker, "sub", "hist.json"));
    expect(() => store.record(snap("2026-07-21", 5))).not.toThrow();
  });

  it("skips the disk write when today's stored snapshot is effectively unchanged (60s-poll friendly)", () => {
    const file = join(tmp(), "hist.json");
    const store = new CortexReadinessHistoryStore(file);
    store.record(snap("2026-07-21", 10));
    rmSync(file); // marker: any further write would recreate it
    store.record(snap("2026-07-21", 10)); // identical → no write
    expect(existsSync(file)).toBe(false);
    store.record(snap("2026-07-21", 11)); // changed → written again
    expect(existsSync(file)).toBe(true);
  });

  it("[REGRESSION 2026-07-22] a same-day refitAccepted/refitRejected flip is NOT dropped by the 'unchanged' dedup check", () => {
    const file = join(tmp(), "hist.json");
    const store = new CortexReadinessHistoryStore(file);
    const base = snap("2026-07-21", 42);
    store.record({ ...base, refitAccepted: 1, refitRejected: 1 });
    // Every OTHER field is byte-identical — only an archetype refit-status flip happened intraday.
    store.record({ ...base, refitAccepted: 2, refitRejected: 1 });
    const stored = new CortexReadinessHistoryStore(file).all().find((s) => s.dateUtc === "2026-07-21")!;
    expect(stored.refitAccepted).toBe(2); // not silently stuck at the first cycle's value
  });
});

describe("cortex-readiness bindings — brain-json parse, local build, peer fetch (gated + never throws)", () => {
  it("parseCortexBrainJsonForReadiness extracts counters + the ledger's resolvedAtMs values, rejects junk", () => {
    const parsed = parseCortexBrainJsonForReadiness({
      cumulativeResolved: 270,
      resolvedByFamily: { BREADTH: 200, NEUTRAL: 70, BAD: "x" },
      countedObservations: { "laneA::1": 111, "laneB::2": 222, corrupt: "nope" },
      updatedAt: "2026-07-21T00:00:00Z",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.cumulativeResolved).toBe(270);
    expect(parsed!.resolvedByFamily).toEqual({ BREADTH: 200, NEUTRAL: 70 });
    expect(parsed!.ledgerResolvedAtMs.sort()).toEqual([111, 222]);
    expect(parseCortexBrainJsonForReadiness(null)).toBeNull();
    expect(parseCortexBrainJsonForReadiness([1, 2])).toBeNull();
  });

  it("buildLocalCortexReadiness reads the brain json, computes, and records today's history snapshot", () => {
    _resetLatestCortexRefitReportForTests();
    _resetLatestCortexShadowDecisionAlphaForTests();
    _resetCortexCollectionStatusAccumulatorsForTests();
    const dataDir = tmp();
    writeFileSync(
      join(dataDir, "cortex-brain.json"),
      JSON.stringify({ cumulativeResolved: 270, resolvedByFamily: { BREADTH: 200, NEUTRAL: 70 }, countedObservations: { "a::1": NOW - 3_600_000 } }),
      "utf-8",
    );
    const historyStore = new CortexReadinessHistoryStore(join(dataDir, "cortex-readiness-history.json"));
    const { report } = buildLocalCortexReadiness({
      dataDir,
      env: { CAUSAL_EXPERIENCE_COLLECTION_DIR: dataDir, FOUR_BRAIN_INSTANCE_ID: "3101" },
      nowMs: NOW,
      historyStore,
    });
    expect(report.quality.cumulativeResolved).toBe(270);
    expect(report.inputsPresent.brain).toBe(true);
    expect(report.inputsPresent.refit).toBe(false); // no refit has run in this process
    expect(report.components.find((c) => c.key === "betaRamp")!.pct).toBeCloseTo(90, 1);
    const snaps = historyStore.all();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.dateUtc).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(snaps[0]!.readinessPct).toBe(report.readinessPct);
  });

  it("normalizeCortexReadinessPeerUrl accepts a bare origin or a full endpoint URL", () => {
    expect(normalizeCortexReadinessPeerUrl("http://localhost:3102")).toBe("http://localhost:3102/api/shadow/cortex-readiness");
    expect(normalizeCortexReadinessPeerUrl("http://localhost:3102/")).toBe("http://localhost:3102/api/shadow/cortex-readiness");
    expect(normalizeCortexReadinessPeerUrl("http://localhost:3102/api/shadow/cortex-readiness")).toBe(
      "http://localhost:3102/api/shadow/cortex-readiness",
    );
  });

  it("fetchPeerCortexReadiness: ok / malformed / HTTP error / thrown fetch — all return, never throw", async () => {
    const fakeReport = { readinessPct: 55.5, components: [] };
    const okFetch = (async () => ({ ok: true, json: async () => ({ local: fakeReport }) })) as unknown as typeof fetch;
    const ok = await fetchPeerCortexReadiness("http://peer", { fetchImpl: okFetch });
    expect(ok.report?.readinessPct).toBe(55.5);
    expect(ok.error).toBeNull();

    const malformedFetch = (async () => ({ ok: true, json: async () => ({ hello: "world" }) })) as unknown as typeof fetch;
    const malformed = await fetchPeerCortexReadiness("http://peer", { fetchImpl: malformedFetch });
    expect(malformed.report).toBeNull();
    expect(malformed.error).toBe("malformed peer response");

    const badStatusFetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const badStatus = await fetchPeerCortexReadiness("http://peer", { fetchImpl: badStatusFetch });
    expect(badStatus.report).toBeNull();
    expect(badStatus.error).toBe("HTTP 503");

    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const thrown = await fetchPeerCortexReadiness("http://peer", { fetchImpl: throwingFetch });
    expect(thrown.report).toBeNull();
    expect(thrown.error).toContain("ECONNREFUSED");
  });

  it("endpoint response: peer fetch is GATED behind CORTEX_READINESS_PEER_URL (unset ⇒ never fetches)", async () => {
    _resetLatestCortexRefitReportForTests();
    _resetLatestCortexShadowDecisionAlphaForTests();
    _resetCortexCollectionStatusAccumulatorsForTests();
    const dataDir = tmp();
    let fetchCalls = 0;
    const spyFetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const res = await buildCortexReadinessEndpointResponse({
      dataDir,
      env: { CAUSAL_EXPERIENCE_COLLECTION_DIR: dataDir },
      nowMs: NOW,
      historyStore: new CortexReadinessHistoryStore(join(dataDir, "h.json")),
      fetchImpl: spyFetch,
    });
    expect(fetchCalls).toBe(0);
    expect(res.peer).toBeNull();
    expect(res.peerError).toBeNull();
    expect(res.local.readinessPct).toBe(0);
    expect(res.reportOnly).toBe(true);
  });

  it("endpoint response: with the peer URL set, returns the peer's LOCAL readiness under the configured label", async () => {
    _resetLatestCortexRefitReportForTests();
    _resetLatestCortexShadowDecisionAlphaForTests();
    _resetCortexCollectionStatusAccumulatorsForTests();
    const dataDir = tmp();
    const peerReport = { readinessPct: 61.2, components: [] };
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("http://localhost:3102/api/shadow/cortex-readiness");
      return { ok: true, json: async () => ({ local: peerReport }) };
    }) as unknown as typeof fetch;
    const res = await buildCortexReadinessEndpointResponse({
      dataDir,
      env: { CAUSAL_EXPERIENCE_COLLECTION_DIR: dataDir, CORTEX_READINESS_PEER_URL: "http://localhost:3102" },
      nowMs: NOW,
      historyStore: new CortexReadinessHistoryStore(join(dataDir, "h.json")),
      fetchImpl: fakeFetch,
    });
    expect(res.peer).not.toBeNull();
    expect(res.peer!.label).toBe("testnet (3102)");
    expect(res.peer!.report.readinessPct).toBe(61.2);
    expect(res.peerError).toBeNull();
  });
});

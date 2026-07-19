import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CortexBrainStore } from "../src/lib/cortex-brain-store.js";
import { runCortexRefit, CORTEX_GATE_MIN_REGIME_FAMILIES } from "../src/lib/cortex-refit-runner.js";
import { collectCortexOutcomes, readCortexDecisionRows } from "../src/lib/cortex-refit-runner-bindings.js";
import { CORTEX_LIVE_BETA } from "../src/lib/cortex-brain.js";
import {
  CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID,
  CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
} from "../src/lib/cortex-live-gather.js";
import type { CortexAttrRosterEntry, CortexDecisionRow, CortexLaneOutcome } from "../src/lib/cortex-attribution.js";
import { writeFileSync, mkdirSync } from "node:fs";

const MIN = 60_000;
const RC = "REGIME_COMPOSITE_CONFIRMATION_LONG";
const ROSTER: CortexAttrRosterEntry[] = [{ laneId: RC, archetype: "BREADTH", staticWeightPct: 40, hasOutcomeSource: true }];

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-refit-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function decision(atMs: number, family: string): CortexDecisionRow {
  return {
    atMs,
    featureSchemaVersion: 1,
    regimeFamily: family,
    lanes: new Map([[RC, { x: [1, 0.5, 0, 0.1, 0.5, 0.1, 0.2, 0, 0, 0.6], eligible: true, direction: "LONG" as const }]]),
  };
}
function outcome(openedAtMs: number, resolvedAtMs: number, netR: number, id: string): CortexLaneOutcome {
  return { laneId: RC, archetype: "BREADTH", direction: "LONG", observationId: id, openedAtMs, resolvedAtMs, netR };
}

describe("runCortexRefit — end-to-end + monotonic counters + liveBeta wall", () => {
  it("attributes outcomes, advances counters, and populates the promotion-gate coverage", () => {
    const store = new CortexBrainStore(join(tmp(), "cortex.json"));
    // 40 decisions across 2 families; 30 outcomes each opening a few min after a decision.
    const decisions: CortexDecisionRow[] = [];
    for (let i = 0; i < 40; i += 1) decisions.push(decision(i * 5 * MIN, i < 20 ? "BULL" : "BEAR"));
    const outcomes: CortexLaneOutcome[] = [];
    for (let i = 0; i < 30; i += 1) outcomes.push(outcome(i * 5 * MIN + 2 * MIN, (i + 50) * MIN, i % 2 === 0 ? 0.3 : -0.4, `o${i}`));

    const report = runCortexRefit(store, { decisions, outcomes, roster: ROSTER, nowMs: 100 * MIN, nowIso: "2026-07-13T00:00:00Z", minExamplesForActive: 10 });

    expect(report.examplesTotal).toBe(30);
    expect(report.examplesNew).toBe(30);
    expect(report.reinforcementByLane).toEqual([{ laneId: RC, positive: 15, noReward: 15 }]);
    expect(store.get().cumulativeResolved).toBe(30);
    expect(report.coverage.regimeFamiliesWithOutcomes).toBe(2);
    expect(report.coverage.regimeCoverageGateMet).toBe(true);
    expect(CORTEX_GATE_MIN_REGIME_FAMILIES).toBe(2);
    // liveBeta wall: the coverage always reports liveBeta 0, never a function of the sample count.
    expect(report.coverage.liveBeta).toBe(CORTEX_LIVE_BETA);
    expect(report.coverage.liveBeta).toBe(0);
    // RC has 30 attributed ≥ min 10 → LEARNING_ACTIVE; blind capital excludes it.
    expect(report.perLane.find((l) => l.laneId === RC)!.status).toBe("LEARNING_ACTIVE");
    expect(report.coverage.blindCapitalPct).toBe(0);
    // The BREADTH archetype saw examples; others had none.
    expect(report.archetypes.find((a) => a.archetype === "BREADTH")!.examples).toBe(30);
    expect(report.archetypes.find((a) => a.archetype === "NEUTRAL")!.status).toBe("NO_EXAMPLES");
  });

  it("is idempotent across nightly runs — a same-data re-run advances nothing (exact-once ledger)", () => {
    const store = new CortexBrainStore(join(tmp(), "cortex.json"));
    const decisions = [decision(0, "BULL"), decision(10 * MIN, "BEAR")];
    const outcomes = [outcome(2 * MIN, 60 * MIN, 0.3, "a"), outcome(12 * MIN, 70 * MIN, -0.4, "b")];
    const first = runCortexRefit(store, { decisions, outcomes, roster: ROSTER, nowMs: 100 * MIN, nowIso: "t0" });
    expect(first.examplesNew).toBe(2);
    expect(store.get().cumulativeResolved).toBe(2);
    const second = runCortexRefit(store, { decisions, outcomes, roster: ROSTER, nowMs: 200 * MIN, nowIso: "t1" });
    expect(second.examplesNew).toBe(0); // both already in the counted ledger
    expect(store.get().cumulativeResolved).toBe(2); // unchanged
    expect(store.get().resolvedByFamily).toEqual({ BULL: 1, BEAR: 1 });
  });

  it("out-of-order safe: a late-surfacing outcome with an EARLIER resolvedAt is still counted", () => {
    const store = new CortexBrainStore(join(tmp(), "cortex.json"));
    const decisions = [decision(0, "BULL"), decision(10 * MIN, "BULL")];
    // Run 1: only the fast lane close (resolvedAt = 500min, a high value).
    runCortexRefit(store, { decisions, outcomes: [outcome(2 * MIN, 500 * MIN, 0.3, "fast")], roster: ROSTER, nowMs: 600 * MIN, nowIso: "t0" });
    expect(store.get().cumulativeResolved).toBe(1);
    // Run 2: a slow lane close that RESOLVED EARLIER (resolvedAt = 70min < 500min). A scalar watermark would drop it.
    const r2 = runCortexRefit(store, { decisions, outcomes: [outcome(2 * MIN, 500 * MIN, 0.3, "fast"), outcome(12 * MIN, 70 * MIN, -0.4, "slow")], roster: ROSTER, nowMs: 700 * MIN, nowIso: "t1" });
    expect(r2.examplesNew).toBe(1); // the "slow" outcome, despite its earlier resolvedAt
    expect(store.get().cumulativeResolved).toBe(2);
  });

  it("dry-run (apply:false) computes the report but mutates NOTHING", () => {
    const store = new CortexBrainStore(join(tmp(), "cortex.json"));
    const decisions = [decision(0, "BULL")];
    const outcomes = [outcome(2 * MIN, 60 * MIN, 0.3, "a")];
    const report = runCortexRefit(store, { decisions, outcomes, roster: ROSTER, nowMs: 100 * MIN, nowIso: "t0", apply: false });
    expect(report.applied).toBe(false);
    expect(report.examplesNew).toBe(1); // dry-run still reports what WOULD be counted
    expect(store.get().cumulativeResolved).toBe(0); // untouched
    expect(Object.keys(store.get().countedObservations)).toHaveLength(0);
  });
});

describe("readCortexDecisionRows — line-resilient journal reader", () => {
  it("parses valid rows, skips+counts corrupt lines, reads both .jsonl and .jsonl.1, dedupes by `at`", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "journal.jsonl");
    const rowA = { kind: "BRAIN_DECISION", at: "2026-07-13T00:00:00.000Z", featureSchemaVersion: 1, regimeFamily: "BULL", lanes: [{ laneId: RC, x: [1, 2, 3], eligible: true, direction: "LONG" }] };
    const rowB = { kind: "BRAIN_DECISION", at: "2026-07-13T00:05:00.000Z", featureSchemaVersion: 1, regimeFamily: "BEAR", lanes: [{ laneId: RC, x: [4, 5, 6], eligible: false, direction: "LONG" }] };
    // .jsonl.1 (rotated/older) has rowA + a truncated line; .jsonl (newer) repeats rowA (dup) + rowB.
    writeFileSync(`${file}.1`, JSON.stringify(rowA) + "\n" + '{"kind":"BRAIN_DECISION","at":"trunc' + "\n");
    writeFileSync(file, JSON.stringify(rowA) + "\n" + JSON.stringify(rowB) + "\n");
    const { rows, badLines } = readCortexDecisionRows([`${file}.1`, file]);
    expect(rows).toHaveLength(2); // rowA deduped, rowB once
    expect(badLines).toBe(1); // the truncated line
    expect(rows.map((r) => r.regimeFamily)).toEqual(["BULL", "BEAR"]); // sorted by atMs
    expect(rows[1]!.lanes.get(RC)!.eligible).toBe(false);
  });
});

describe("collectCortexOutcomes — normalization + skip tally", () => {
  it("normalizes directional + xsec, tallies skips by reason, respects the lookback", () => {
    const now = 1_000_000_000;
    const { outcomes, skipsByLane } = collectCortexOutcomes({
      directional: [
        {
          laneId: RC,
          obs: [
            { observationId: "r1", openedAtMs: now - 1000, resolvedAt: new Date(now).toISOString(), status: "CLOSED_WIN", netR: 0.3 },
            { observationId: "r2", openedAtMs: now, resolvedAt: null, status: "OPEN", netR: null }, // skip NOT_RESOLVED
          ],
        },
      ],
      xsec: [
        {
          laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL",
          obs: [
            { observationId: "x1", openedAtMs: now, resolvedAt: new Date(now).toISOString(), status: "CLOSED_WIN", netReturn: 0.006, riskDistanceAtOpen: 0.003 },
            { observationId: "x2", openedAtMs: now, resolvedAt: new Date(now).toISOString(), status: "CLOSED_WIN", netReturn: 0.006 }, // skip NO_RISK_AT_OPEN
          ],
        },
      ],
      sinceMs: 0,
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.observationId === "x1")!.netR).toBeCloseTo(2.0, 10);
    expect(skipsByLane[RC]?.NOT_RESOLVED).toBe(1);
    expect(skipsByLane["CROSS_SECTIONAL_MARKET_NEUTRAL"]?.NO_RISK_AT_OPEN).toBe(1);
  });

  it("keeps direction-agnostic CG MFE outcomes on separate LONG and SHORT causal axes", () => {
    const now = 1_000_000_000;
    const { outcomes } = collectCortexOutcomes({
      directional: [
        {
          laneId: CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID,
          obs: [{ observationId: "mfe-long", openedAtMs: now, resolvedAt: new Date(now + 1).toISOString(), status: "CLOSED_WIN", netR: 0.5 }],
        },
        {
          laneId: CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
          obs: [{ observationId: "mfe-short", openedAtMs: now, resolvedAt: new Date(now + 1).toISOString(), status: "CLOSED_LOSS", netR: -0.5 }],
        },
      ],
      xsec: [],
      sinceMs: 0,
    });
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ laneId: CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID, direction: "LONG" }),
      expect.objectContaining({ laneId: CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID, direction: "SHORT" }),
    ]));
  });
});

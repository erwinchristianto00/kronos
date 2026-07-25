import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cortexWiredOutcomeSourceLaneIds,
  gatherCortexRefitInputs,
  startOfUtcDayMs,
  CORTEX_LANE_ROSTER,
} from "../src/lib/cortex-refit-runner-bindings.js";
import { buildCortexAttrRoster } from "../src/lib/cortex-outcome-source.js";
import { _resetCrossSectionalStoreForTests } from "../src/lib/cross-sectional-edge.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-refit-bindings-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  _resetCrossSectionalStoreForTests();
});

describe("cortexWiredOutcomeSourceLaneIds — the NO_OUTCOME_SOURCE safety net", () => {
  it("reports a lane covered by the directional array as wired", () => {
    const wired = cortexWiredOutcomeSourceLaneIds([{ laneId: "A" }, { laneId: "B" }], []);
    expect(wired.has("A")).toBe(true);
    expect(wired.has("B")).toBe(true);
  });

  it("reports a lane covered by the xsec array as wired", () => {
    const wired = cortexWiredOutcomeSourceLaneIds([], [{ laneId: "X" }]);
    expect(wired.has("X")).toBe(true);
  });

  it("reports a lane NOT present in either array as unwired — the exact bug this guards against", () => {
    // Simulates a FUTURE CORTEX_LANE_ROSTER lane added without a matching push into the directional/xsec
    // reader arrays: it must be excluded from the wired set, never optimistically assumed present.
    const wired = cortexWiredOutcomeSourceLaneIds([{ laneId: "A" }], [{ laneId: "X" }]);
    expect(wired.has("SOME_NEW_LANE_NOBODY_WIRED_YET")).toBe(false);
  });

  it("feeding the derived predicate into buildCortexAttrRoster correctly marks an unwired lane as hasOutcomeSource=false", () => {
    const wired = cortexWiredOutcomeSourceLaneIds([{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG" }], []);
    const roster = buildCortexAttrRoster(
      () => 10,
      (laneId) => wired.has(laneId),
    );
    expect(roster.find((r) => r.laneId === "REGIME_COMPOSITE_CONFIRMATION_LONG")!.hasOutcomeSource).toBe(true);
    // Any other real roster lane not in the fabricated `wired` set must NOT be reported as having a source —
    // proving the check is a real membership test, not the old hardcoded `() => true`.
    const other = roster.find((r) => r.laneId !== "REGIME_COMPOSITE_CONFIRMATION_LONG");
    expect(other).toBeDefined();
    expect(other!.hasOutcomeSource).toBe(false);
  });
});

describe("startOfUtcDayMs — the boundary the #219 'today' decision-alpha slice is built on", () => {
  it("mid-day timestamp floors to that day's UTC midnight", () => {
    expect(startOfUtcDayMs(Date.parse("2026-07-21T15:43:07.512Z"))).toBe(Date.parse("2026-07-21T00:00:00.000Z"));
  });

  it("exactly at midnight is its own boundary (not the previous day)", () => {
    const midnight = Date.parse("2026-07-21T00:00:00.000Z");
    expect(startOfUtcDayMs(midnight)).toBe(midnight);
  });

  it("one millisecond before midnight belongs to the PREVIOUS day", () => {
    expect(startOfUtcDayMs(Date.parse("2026-07-21T00:00:00.000Z") - 1)).toBe(Date.parse("2026-07-20T00:00:00.000Z"));
  });

  it("is stable across a full day: every ms in [start, start+86400000) maps to the same boundary", () => {
    const start = startOfUtcDayMs(Date.parse("2026-07-21T09:00:00.000Z"));
    expect(startOfUtcDayMs(start)).toBe(start);
    expect(startOfUtcDayMs(start + 86_400_000 - 1)).toBe(start);
    expect(startOfUtcDayMs(start + 86_400_000)).toBe(start + 86_400_000); // rolls into the NEXT day
  });
});

describe("gatherCortexRefitInputs — end-to-end roster wiring sanity", () => {
  it("every current CORTEX_LANE_ROSTER lane reports hasOutcomeSource=true (all 15 have a real reader wired)", () => {
    const dataDir = tmp();
    const input = gatherCortexRefitInputs({
      dataDir,
      journalFile: join(dataDir, "cortex-decisions.jsonl"), // nonexistent — journal reads must tolerate this
      nowMs: Date.parse("2026-07-19T00:00:00Z"),
      nowIso: "2026-07-19T00:00:00Z",
      staticWeightPctForLane: () => 0,
    });
    expect(input.roster).toHaveLength(CORTEX_LANE_ROSTER.length);
    for (const entry of input.roster) {
      expect(entry.hasOutcomeSource).toBe(true);
    }
  });

  it("[REGRESSION 2026-07-22] a real CLOSED cross-sectional observation on disk is actually read into outcomes — the store constructor path bug made this always empty", () => {
    const dataDir = tmp();
    const nowMs = Date.parse("2026-07-22T00:00:00Z");
    // Written at the exact real on-disk shape CrossSectionalStore persists (cross-sectional-edge.ts's
    // CrossSectionalState), directly to `${dataDir}/cross-sectional-edge.json` — the real file path,
    // not a hand-built fixture passed straight into the function under test.
    writeFileSync(
      join(dataDir, "cross-sectional-edge.json"),
      JSON.stringify({
        version: 1,
        lastCycleAt: "2026-07-21T23:00:00.000Z",
        observations: [
          {
            observationId: "xsec:MOM24_FILTERED:1",
            openedAt: "2026-07-20T00:00:00.000Z",
            openedAtMs: Date.parse("2026-07-20T00:00:00.000Z"),
            horizonMs: 24 * 3_600_000,
            signal: "MOM24_FILTERED",
            variant: "FILTERED", // maps to CROSS_SECTIONAL_MARKET_NEUTRAL, see XSEC_STORE_VARIANTS
            k: 1,
            longLeg: [{ symbol: "SOLUSDT", entryPrice: 100, exitPrice: 101 }],
            shortLeg: [{ symbol: "DOGEUSDT", entryPrice: 0.1, exitPrice: 0.099 }],
            status: "CLOSED",
            grossReturn: 0.02,
            costReturn: -0.003,
            netReturn: 0.017,
            longLegReturn: 0.01,
            shortLegReturn: 0.007,
            resolvedAt: "2026-07-21T00:00:00.000Z",
            riskDistanceAtOpen: 0.01,
          },
        ],
      }),
    );

    const input = gatherCortexRefitInputs({
      dataDir,
      journalFile: join(dataDir, "cortex-decisions.jsonl"),
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
      staticWeightPctForLane: () => 0,
    });

    const xsecOutcome = input.outcomes.find((o) => o.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL");
    expect(xsecOutcome).toBeDefined();
    expect(xsecOutcome!.observationId).toBe("xsec:MOM24_FILTERED:1");
    expect(xsecOutcome!.netR).toBeCloseTo(0.017 / 0.01, 10);
  });
});

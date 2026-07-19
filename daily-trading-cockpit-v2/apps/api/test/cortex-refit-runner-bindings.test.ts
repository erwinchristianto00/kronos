import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cortexWiredOutcomeSourceLaneIds,
  gatherCortexRefitInputs,
  CORTEX_LANE_ROSTER,
} from "../src/lib/cortex-refit-runner-bindings.js";
import { buildCortexAttrRoster } from "../src/lib/cortex-outcome-source.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-refit-bindings-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
});

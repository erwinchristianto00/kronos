import { describe, expect, it } from "vitest";
import { CORTEX_LANE_ROSTER, cortexRetiredLaneIds, cortexEffectiveRosterSize } from "../src/lib/cortex-live-gather.js";

describe("cortex retired-lane denominator (2026-07-27)", () => {
  it("defaults to EMPTY — byte-identical to pre-change behaviour", () => {
    expect(cortexRetiredLaneIds({}).size).toBe(0);
    expect(cortexEffectiveRosterSize({})).toBe(CORTEX_LANE_ROSTER.length);
  });

  /** FAILS WITHOUT THE FIX: before this existed rosterSize was always CORTEX_LANE_ROSTER.length,
   *  so laneCoverage capped at 14/16 and the weighted headline at 97.5% forever. */
  it("shrinks the denominator by exactly the retired lanes", () => {
    const two = [CORTEX_LANE_ROSTER[0]!.laneId, CORTEX_LANE_ROSTER[1]!.laneId].join(",");
    const env = { CORTEX_RETIRED_LANE_IDS: two } as NodeJS.ProcessEnv;
    expect(cortexRetiredLaneIds(env).size).toBe(2);
    expect(cortexEffectiveRosterSize(env)).toBe(CORTEX_LANE_ROSTER.length - 2);
  });

  it("ignores ids that are not on the roster rather than shrinking on a typo", () => {
    const env = { CORTEX_RETIRED_LANE_IDS: "NOT_A_LANE,also-not-a-lane" } as NodeJS.ProcessEnv;
    expect(cortexRetiredLaneIds(env).size).toBe(0);
    expect(cortexEffectiveRosterSize(env)).toBe(CORTEX_LANE_ROSTER.length);
  });

  it("never divides by zero even if every lane is retired", () => {
    const all = CORTEX_LANE_ROSTER.map((e) => e.laneId).join(",");
    expect(cortexEffectiveRosterSize({ CORTEX_RETIRED_LANE_IDS: all } as NodeJS.ProcessEnv)).toBe(1);
  });

  it("tolerates whitespace and empty entries", () => {
    const env = { CORTEX_RETIRED_LANE_IDS: ` , ${CORTEX_LANE_ROSTER[0]!.laneId} , ,` } as NodeJS.ProcessEnv;
    expect(cortexEffectiveRosterSize(env)).toBe(CORTEX_LANE_ROSTER.length - 1);
  });
});

import { describe, it, expect } from "vitest";
import {
  classifyIncumbentLanes,
  fourBrainLaneSupport,
  FOUR_BRAIN_SUPPORTED_LANES,
  PROFIT_CORE_SHORT_TRAIL_LANE_ID,
} from "../src/lib/four-brain-lane-support.js";
import { CORTEX_LANE_ROSTER } from "../src/lib/cortex-live-gather.js";

describe("Four-Brain lane support — no incumbent active lane is silently excluded (operator ask A)", () => {
  it("every incumbent active lane classifies as SUPPORTED or UNSUPPORTED_WITH_REASON — exactly once each", () => {
    const active = [
      ...CORTEX_LANE_ROSTER.map((e, i) => ({ laneId: e.laneId, weightPct: i === 0 ? 20 : 5 })),
      { laneId: PROFIT_CORE_SHORT_TRAIL_LANE_ID, weightPct: 10 },
      { laneId: "TOTALLY_MADE_UP_LANE", weightPct: 7 }, // unknown → must be surfaced, never dropped
    ];
    const report = classifyIncumbentLanes(active);

    // exactly once each (no lane dropped, none duplicated)
    expect(report.lanes).toHaveLength(active.length);
    const ids = report.lanes.map((l) => l.laneId);
    expect(new Set(ids).size).toBe(active.length);
    for (const a of active) expect(ids).toContain(a.laneId);

    // every lane has a definite status
    for (const l of report.lanes) {
      expect(["SUPPORTED", "UNSUPPORTED_WITH_REASON"]).toContain(l.status);
      if (l.status === "UNSUPPORTED_WITH_REASON") expect(l.reason && l.reason.length > 0).toBe(true);
    }

    // the made-up lane is the only unsupported one, and it carries a reason
    const madeUp = report.lanes.find((l) => l.laneId === "TOTALLY_MADE_UP_LANE")!;
    expect(madeUp.status).toBe("UNSUPPORTED_WITH_REASON");
    expect(madeUp.reason).toMatch(/registry|unknown/i);
    expect(report.unsupportedCount).toBe(1);
    expect(report.supportedCount).toBe(active.length - 1);
  });

  it("PROFIT_CORE_SHORT_TRAIL resolves to SUPPORTED (a real SHORT lane, not silently excluded)", () => {
    expect(FOUR_BRAIN_SUPPORTED_LANES.has(PROFIT_CORE_SHORT_TRAIL_LANE_ID)).toBe(true);
    const s = fourBrainLaneSupport(PROFIT_CORE_SHORT_TRAIL_LANE_ID)!;
    expect(s.direction).toBe("SHORT");
    expect(s.exitPositionsWired).toBe(true);
    const report = classifyIncumbentLanes([{ laneId: PROFIT_CORE_SHORT_TRAIL_LANE_ID, weightPct: 100 }]);
    expect(report.lanes[0]!.status).toBe("SUPPORTED");
    expect(report.capitalCoveragePct).toBe(100);
  });

  it("reports CAPITAL COVERAGE percentage, not only lane count", () => {
    // 80% of capital in a supported lane, 20% in an unknown lane → coverage = 80%.
    const report = classifyIncumbentLanes([
      { laneId: CORTEX_LANE_ROSTER[0]!.laneId, weightPct: 80 },
      { laneId: "UNKNOWN_LANE", weightPct: 20 },
    ]);
    expect(report.capitalCoveragePct).toBeCloseTo(80);
    expect(report.activeLaneCount).toBe(2);
  });

  it("all roster lanes are supported ⇒ 100% capital coverage when only roster lanes are active", () => {
    const report = classifyIncumbentLanes(CORTEX_LANE_ROSTER.map((e) => ({ laneId: e.laneId, weightPct: 5 })));
    expect(report.unsupportedCount).toBe(0);
    expect(report.capitalCoveragePct).toBe(100);
  });

  it("a duplicate incumbent lane id is classified exactly once (idempotent)", () => {
    const report = classifyIncumbentLanes([
      { laneId: CORTEX_LANE_ROSTER[0]!.laneId, weightPct: 30 },
      { laneId: CORTEX_LANE_ROSTER[0]!.laneId, weightPct: 30 }, // dup
    ]);
    expect(report.lanes).toHaveLength(1);
    expect(report.activeLaneCount).toBe(1);
  });

  it("zero active lanes ⇒ coverage defined as 100% (nothing uncovered), not NaN", () => {
    const report = classifyIncumbentLanes([]);
    expect(report.capitalCoveragePct).toBe(100);
    expect(report.activeLaneCount).toBe(0);
  });
});

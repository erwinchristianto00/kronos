import { describe, expect, it } from "vitest";

import { buildStrategyResearchRoadmapReport } from "../src/lib/strategy-research-roadmap.js";

describe("strategy-research-roadmap", () => {
  const report = buildStrategyResearchRoadmapReport("2026-05-27T00:00:00.000Z");

  it("renders with currentBranchVerdict=NOT_LIVE_READY", () => {
    expect(report.reportOnly).toBe(true);
    expect(report.currentBranchVerdict.verdict).toBe("NOT_LIVE_READY");
    expect(report.currentBranchVerdict.summary).toContain("intraday TP1 scalping");
    expect(report.currentBranchVerdict.keyEvidence.length).toBeGreaterThanOrEqual(4);
  });

  it("killedWorkstreams contains TP2/TP3 runner kills and Best-Exit Lane", () => {
    const names = report.killedWorkstreams.map((w) => w.name);
    expect(names).toContain("TP2/TP3 Runner Exit Extensions");
    expect(names).toContain("Best-Exit Lane V1");
    for (const w of report.killedWorkstreams) {
      expect(w.status).toBe("KILLED");
    }
  });

  it("nextStrategyFamilies has 3 entries in priority order", () => {
    expect(report.nextStrategyFamilies).toHaveLength(3);
    expect(report.nextStrategyFamilies[0]!.priority).toBe(1);
    expect(report.nextStrategyFamilies[1]!.priority).toBe(2);
    expect(report.nextStrategyFamilies[2]!.priority).toBe(3);
    expect(report.nextStrategyFamilies[0]!.name).toContain("Portfolio Trend");
    expect(report.nextStrategyFamilies[1]!.name).toContain("Microstructure");
    expect(report.nextStrategyFamilies[2]!.name).toContain("Arbitrage");
  });

  it("thirtyDayPlan and ninetyDayPlan are non-empty", () => {
    expect(report.thirtyDayPlan.length).toBeGreaterThan(0);
    expect(report.ninetyDayPlan.length).toBeGreaterThan(0);
    expect(report.thirtyDayPlan[0]!.day).toBe(1);
    expect(report.ninetyDayPlan.at(-1)!.day).toBe(90);
  });

  it("microPilotBlockers contains all 5 expected items", () => {
    expect(report.microPilotBlockers).toHaveLength(5);
    expect(report.microPilotBlockers.some((b) => b.includes("≥200 fresh-valid"))).toBe(true);
    expect(report.microPilotBlockers.some((b) => b.includes("kill switch"))).toBe(true);
    expect(report.microPilotBlockers.some((b) => b.includes("28bps"))).toBe(true);
  });

  it("keepTestingWorkstreams[0] is the Base Route Stop175 Current-Guard Tape", () => {
    expect(report.keepTestingWorkstreams[0]?.laneId).toBe("BASE_ROUTE_STOP175_CURRENT_GUARD");
    expect(report.keepTestingWorkstreams[0]?.name).toContain("Base Route Stop175");
    expect(report.keepTestingWorkstreams[0]?.status).toBe("KEEP_TESTING");
  });

  it("roadmap rendering contains BASE_ROUTE_STOP175_CURRENT_GUARD lane id", () => {
    const ids = report.keepTestingWorkstreams.map((w) => w.laneId);
    expect(ids).toContain("BASE_ROUTE_STOP175_CURRENT_GUARD");
  });

  it("readinessGates has 8 entries and the right statuses", () => {
    expect(report.readinessGates).toHaveLength(8);
    const evidence = report.readinessGates.find((g) => g.name.includes("≥200 fresh-valid"));
    expect(evidence?.status).toBe("FAIL");
    const killSwitch = report.readinessGates.find((g) => g.name.includes("Kill switch"));
    expect(killSwitch?.status).toBe("FAIL");
  });
});

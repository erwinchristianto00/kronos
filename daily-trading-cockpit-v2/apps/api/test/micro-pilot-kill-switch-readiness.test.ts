import { describe, it, expect } from "vitest";

import { buildKillSwitchReadinessReport } from "../src/lib/micro-pilot-kill-switch-readiness.js";

describe("AE kill switch readiness", () => {
  it("reports implemented=false and ready=false", () => {
    const r = buildKillSwitchReadinessReport();
    expect(r.implemented).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.reportOnly).toBe(true);
  });

  it("all controls are unimplemented", () => {
    const r = buildKillSwitchReadinessReport();
    expect(r.controls.length).toBeGreaterThanOrEqual(10);
    expect(r.controls.every((c) => c.implemented === false)).toBe(true);
  });

  it("missingControls lists every unimplemented control", () => {
    const r = buildKillSwitchReadinessReport();
    expect(r.missingControls.length).toBe(r.controls.length);
    expect(r.missingControls).toContain("daily_max_loss_limit");
    expect(r.missingControls).toContain("auto_disable_on_reconciliation_mismatch");
  });

  it("each control has a recommended threshold and risk", () => {
    const r = buildKillSwitchReadinessReport();
    for (const c of r.controls) {
      expect(c.recommendedThreshold.length).toBeGreaterThan(0);
      expect(c.riskIfMissing.length).toBeGreaterThan(0);
    }
  });
});

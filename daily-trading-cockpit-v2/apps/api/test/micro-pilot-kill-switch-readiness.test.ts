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

  // ── v1 live readiness (gate 3 of infraReady) ──
  const active = { engineEnabled: true, dailyMaxLossUsd: 15, maxDrawdownUsd: 40, maxConsecutiveLosses: 5 };
  const impl = (r: ReturnType<typeof buildKillSwitchReadinessReport>, name: string) =>
    r.controls.find((c) => c.name === name)?.implemented;

  it("[LIVE] ready=true when engine enabled + critical limits set to REAL values", () => {
    const r = buildKillSwitchReadinessReport(undefined, active);
    expect(r.ready).toBe(true);
    expect(impl(r, "daily_max_loss_limit")).toBe(true);
    expect(impl(r, "max_drawdown_stop")).toBe(true);
    expect(impl(r, "manual_emergency_stop")).toBe(true);
    expect(impl(r, "auto_disable_on_reconciliation_mismatch")).toBe(true);
    // execution-quality stops stay advisory (not in the engine)
    expect(impl(r, "spread_spike_stop")).toBe(false);
  });

  it("[LIVE] ready=false when limits are parked at the OFF sentinel (999999)", () => {
    const r = buildKillSwitchReadinessReport(undefined, { ...active, dailyMaxLossUsd: 999999, maxDrawdownUsd: 999999 });
    expect(r.ready).toBe(false);
    expect(r.readyReasons.some((x) => x.includes("daily-max-loss") || x.includes("LIVE_DAILY_MAX_LOSS"))).toBe(true);
    expect(impl(r, "daily_max_loss_limit")).toBe(false);
  });

  it("[LIVE] ready=false when the live engine is not enabled", () => {
    expect(buildKillSwitchReadinessReport(undefined, { ...active, engineEnabled: false }).ready).toBe(false);
  });

  it("[LIVE] no live inputs → ready=false (report-only spec mode)", () => {
    expect(buildKillSwitchReadinessReport().ready).toBe(false);
  });
});

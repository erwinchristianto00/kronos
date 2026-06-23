import { describe, it, expect } from "vitest";

import { buildOrderReconciliationReadinessReport } from "../src/lib/order-reconciliation-readiness.js";

describe("AF order reconciliation readiness", () => {
  it("reports implemented=false and ready=false", () => {
    const r = buildOrderReconciliationReadinessReport();
    expect(r.implemented).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.reportOnly).toBe(true);
  });

  it("lifecycle stages are all untracked", () => {
    const r = buildOrderReconciliationReadinessReport();
    expect(r.lifecycleStages.length).toBeGreaterThan(0);
    expect(r.lifecycleStages.every((s) => s.tracked === false)).toBe(true);
  });

  it("required ledger fields are non-empty and aggregated", () => {
    const r = buildOrderReconciliationReadinessReport();
    expect(r.requiredLedgerFields.length).toBeGreaterThan(0);
    expect(r.requiredLedgerFields).toContain("clientOrderId");
    expect(r.requiredLedgerFields).toContain("exchangeOrderId");
  });

  it("required exchange checks and risks are listed", () => {
    const r = buildOrderReconciliationReadinessReport();
    expect(r.requiredExchangeChecks.length).toBeGreaterThan(0);
    expect(r.risksIfMissing.length).toBeGreaterThan(0);
  });

  // ── v1 live readiness (gate 2 of infraReady) ──
  const ok = { engineEnabled: true, lastTickAgeMs: 30_000, reconcileIssueCount: 0, lastTickError: null, openIntentCount: 0 };

  it("[LIVE] ready=true when engine reconcile loop ran recently with 0 drift/errors", () => {
    const r = buildOrderReconciliationReadinessReport(undefined, ok);
    expect(r.ready).toBe(true);
    expect(r.implemented).toBe(true);
    expect(r.lifecycleStages.every((s) => s.tracked === true)).toBe(true);
  });

  it("[LIVE] ready=false when engine not enabled", () => {
    expect(buildOrderReconciliationReadinessReport(undefined, { ...ok, engineEnabled: false }).ready).toBe(false);
  });

  it("[LIVE] ready=false when reconcile is stale", () => {
    const r = buildOrderReconciliationReadinessReport(undefined, { ...ok, lastTickAgeMs: 30 * 60_000 });
    expect(r.ready).toBe(false);
    expect(r.readyReasons.some((x) => x.toLowerCase().includes("reconcile"))).toBe(true);
  });

  it("[LIVE] ready=false when there are unresolved reconcile issues", () => {
    const r = buildOrderReconciliationReadinessReport(undefined, { ...ok, reconcileIssueCount: 2 });
    expect(r.ready).toBe(false);
    expect(r.readyReasons.some((x) => x.includes("reconcile issue"))).toBe(true);
  });

  it("[LIVE] ready=false on a tick error", () => {
    expect(buildOrderReconciliationReadinessReport(undefined, { ...ok, lastTickError: "boom" }).ready).toBe(false);
  });

  it("[LIVE] no live inputs → ready=false (report-only spec mode)", () => {
    expect(buildOrderReconciliationReadinessReport().ready).toBe(false);
  });
});

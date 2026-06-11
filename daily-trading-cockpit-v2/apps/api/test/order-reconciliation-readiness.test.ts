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
});

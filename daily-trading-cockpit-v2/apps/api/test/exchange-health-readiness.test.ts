import { describe, it, expect } from "vitest";

import { buildExchangeHealthReadinessReport } from "../src/lib/exchange-health-readiness.js";

describe("exchange health readiness (report-only spec)", () => {
  it("ready=false with no live inputs (report-only spec mode)", () => {
    const r = buildExchangeHealthReadinessReport();
    expect(r.ready).toBe(false);
    expect(r.reportOnly).toBe(true);
    expect(r.readyReasons).toContain("no live inputs (report-only spec mode)");
  });

  it("bookticker/depth/funding/openinterest/spread checks are NOT_AVAILABLE (not implemented)", () => {
    const r = buildExchangeHealthReadinessReport();
    for (const name of ["bookticker_freshness", "depth_freshness", "funding_freshness", "openinterest_freshness", "abnormal_spread_detection"]) {
      const check = r.checks.find((c) => c.name === name);
      expect(check?.available).toBe(false);
      expect(check?.source).toBe("NOT_AVAILABLE");
    }
  });

  it("implemented=false (FUTURE/NOT_AVAILABLE checks never available)", () => {
    const r = buildExchangeHealthReadinessReport();
    expect(r.implemented).toBe(false);
    expect(r.missingChecks.length).toBeGreaterThan(0);
  });

  // ── v1 live readiness (gate 1 of infraReady) ──
  const fresh = { reachable: true, marketDataAgeMs: 60_000, clockSkewMs: 200 };

  it("[LIVE] ready=false even when reachable + fresh + clock ok (book/depth feeds are not implemented)", () => {
    const r = buildExchangeHealthReadinessReport(undefined, fresh);
    expect(r.ready).toBe(false);
    expect(r.readyReasons.some((x) => x.includes("feed"))).toBe(true);
  });

  it("[LIVE] ready=false when market data is stale", () => {
    const r = buildExchangeHealthReadinessReport(undefined, { ...fresh, marketDataAgeMs: 60 * 60_000 });
    expect(r.ready).toBe(false);
    expect(r.readyReasons.some((x) => x.includes("market data"))).toBe(true);
  });

  it("[LIVE] ready=false when not reachable", () => {
    const r = buildExchangeHealthReadinessReport(undefined, { ...fresh, reachable: false });
    expect(r.ready).toBe(false);
    expect(r.readyReasons.some((x) => x.includes("reachable"))).toBe(true);
  });

  it("[LIVE] clock skew blocks only when MEASURED and over tolerance; null is advisory (but feeds still block ready)", () => {
    const bad = buildExchangeHealthReadinessReport(undefined, { ...fresh, clockSkewMs: 5000 });
    expect(bad.ready).toBe(false);
    expect(bad.readyReasons.some((x) => x.includes("clock skew"))).toBe(true);
    const unmeasured = buildExchangeHealthReadinessReport(undefined, { ...fresh, clockSkewMs: null });
    // clock is advisory-clean, but book/depth feeds are still NOT_AVAILABLE, so overall ready stays false.
    expect(unmeasured.ready).toBe(false);
    expect(unmeasured.readyReasons.some((x) => x.includes("clock"))).toBe(false);
  });

  it("[LIVE] exchange_reachable / market_data_freshness / clock_sync checks appear only when live inputs are supplied", () => {
    const withLive = buildExchangeHealthReadinessReport(undefined, fresh);
    expect(withLive.checks.some((c) => c.name === "exchange_reachable")).toBe(true);
    const withoutLive = buildExchangeHealthReadinessReport();
    expect(withoutLive.checks.some((c) => c.name === "exchange_reachable")).toBe(false);
  });
});

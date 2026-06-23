import { describe, it, expect } from "vitest";

import { buildExchangeHealthReadinessReport } from "../src/lib/exchange-health-readiness.js";
import type { MicrostructureCollectorReport } from "../src/lib/microstructure-feature-collector.js";

function makeMicrostructure(over: Partial<MicrostructureCollectorReport> = {}): MicrostructureCollectorReport {
  return {
    bookTickerQtyAvailability: 1.0,
    depthAvailability: 1.0,
    fundingRateAvailability: 1.0,
    openInterestAvailability: 1.0,
    latestSpreadDistribution: { p50: 1.1, p90: 4.3, p99: 9.4 },
    ...over,
  } as unknown as MicrostructureCollectorReport;
}

describe("AG exchange health readiness", () => {
  it("ready=false even when microstructure provides data (needs monitoring loop)", () => {
    const r = buildExchangeHealthReadinessReport(makeMicrostructure());
    expect(r.ready).toBe(false);
    expect(r.reportOnly).toBe(true);
  });

  it("bookticker_freshness available=true when microstructure completeness > 0", () => {
    const r = buildExchangeHealthReadinessReport(makeMicrostructure({ bookTickerQtyAvailability: 1.0 }));
    const check = r.checks.find((c) => c.name === "bookticker_freshness");
    expect(check?.available).toBe(true);
    expect(check?.source).toBe("AC_MICROSTRUCTURE");
  });

  it("availableCount reflects microstructure availability", () => {
    const full = buildExchangeHealthReadinessReport(makeMicrostructure());
    const none = buildExchangeHealthReadinessReport(undefined);
    expect(full.availableCount).toBeGreaterThan(none.availableCount);
  });

  it("implemented=false when any check missing (FUTURE checks never available)", () => {
    const r = buildExchangeHealthReadinessReport(makeMicrostructure());
    expect(r.implemented).toBe(false);
    expect(r.missingChecks.length).toBeGreaterThan(0);
  });

  // ── v1 live readiness (gate 1 of infraReady) ──
  const fresh = { reachable: true, marketDataAgeMs: 60_000, clockSkewMs: 200 };

  it("[LIVE] ready=true when reachable + fresh data + feeds present + clock ok", () => {
    const r = buildExchangeHealthReadinessReport(makeMicrostructure(), undefined, fresh);
    expect(r.ready).toBe(true);
    expect(r.readyReasons).toEqual([]);
  });

  it("[LIVE] ready=false when market data is stale", () => {
    const r = buildExchangeHealthReadinessReport(makeMicrostructure(), undefined, { ...fresh, marketDataAgeMs: 60 * 60_000 });
    expect(r.ready).toBe(false);
    expect(r.readyReasons.some((x) => x.includes("market data"))).toBe(true);
  });

  it("[LIVE] ready=false when not reachable", () => {
    const r = buildExchangeHealthReadinessReport(makeMicrostructure(), undefined, { ...fresh, reachable: false });
    expect(r.ready).toBe(false);
  });

  it("[LIVE] ready=false when microstructure book/depth feeds are absent", () => {
    const r = buildExchangeHealthReadinessReport(makeMicrostructure({ bookTickerQtyAvailability: 0 }), undefined, fresh);
    expect(r.ready).toBe(false);
    expect(r.readyReasons.some((x) => x.includes("feeds"))).toBe(true);
  });

  it("[LIVE] clock skew blocks only when MEASURED and over tolerance; null is advisory", () => {
    const bad = buildExchangeHealthReadinessReport(makeMicrostructure(), undefined, { ...fresh, clockSkewMs: 5000 });
    expect(bad.ready).toBe(false);
    const unmeasured = buildExchangeHealthReadinessReport(makeMicrostructure(), undefined, { ...fresh, clockSkewMs: null });
    expect(unmeasured.ready).toBe(true); // null skew doesn't block
  });

  it("[LIVE] no live inputs → still ready=false (report-only spec mode)", () => {
    expect(buildExchangeHealthReadinessReport(makeMicrostructure()).ready).toBe(false);
  });
});

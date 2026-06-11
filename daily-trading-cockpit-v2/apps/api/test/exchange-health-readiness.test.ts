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
});

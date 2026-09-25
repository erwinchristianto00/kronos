import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import * as canonical from "../src/lib/canonical-market-regime-engine.js";
import { buildMarketRegimeDisplay } from "../src/lib/market-regime-display.js";
import { registerLiveRoutes } from "../src/routes/live.js";
import type { LiveExecutionEngine } from "../src/lib/live-execution-engine.js";

const now = Date.parse("2026-09-05T08:00:00Z");
function validSnapshot() {
  const snapshot = canonical.degradedLowCoverageSnapshot(now - 60_000, "fixture");
  snapshot.status = "VALID";
  snapshot.coverage = { status: "VALID", coveragePct: 1, validSymbolCount: 60, requiredSymbolCount: 60, reasons: [] };
  snapshot.overlays.lowCoverage = false;
  snapshot.projection = "BEARISH";
  snapshot.confidence = 0.8;
  return snapshot;
}
afterEach(() => vi.restoreAllMocks());
describe("market regime display", () => {
  it("exposes the canonical snapshot, its coverage and observation timestamp", () => {
    expect(buildMarketRegimeDisplay(validSnapshot(), now)).toMatchObject({
      projection: "BEARISH", freshness: "FRESH", confidence: 0.8,
      capturedAt: "2026-09-05T07:59:00.000Z", validSymbolCount: 60, requiredSymbolCount: 60,
    });
  });
  it("withholds stale projection and confidence", () => {
    expect(buildMarketRegimeDisplay(validSnapshot(), now + 20 * 60_000)).toMatchObject({
      freshness: "STALE", projection: null, confidence: null,
    });
  });
  it.each(["cold", "coverage", "future", "invalid time"])("does not label %s data Mixed/Fresh", (kind) => {
    const snapshot = validSnapshot();
    if (kind === "cold") Object.assign(snapshot, canonical.degradedLowCoverageSnapshot(now, "cold start"));
    if (kind === "coverage") snapshot.coverage.status = "INVALID";
    if (kind === "future") snapshot.atMs = now + 1;
    if (kind === "invalid time") snapshot.atMs = NaN;
    expect(buildMarketRegimeDisplay(snapshot, now)).toMatchObject({ freshness: "UNAVAILABLE", projection: null, confidence: null });
  });
  it("adds canonical display to the real status route without replacing the trading controller", async () => {
    const snapshot = validSnapshot();
    snapshot.atMs = Date.now() - 1000;
    const getter = vi.spyOn(canonical, "getCanonicalMarketRegimeSnapshot").mockReturnValue(snapshot);
    const controller = { regime: "No usable market regime because all symbols were skipped.", mode: "UNKNOWN", bias: "UNKNOWN", confidence: "LOW" };
    const engine = { getStatus: () => ({ enabled: true, armed: true, controller }) } as unknown as LiveExecutionEngine;
    const app = Fastify();
    try {
      await registerLiveRoutes(app, engine);
      const response = await app.inject({ method: "GET", url: "/api/live/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json().controller).toEqual(controller);
      expect(response.json().marketRegimeDisplay).toMatchObject({ projection: "BEARISH", freshness: "FRESH", validSymbolCount: 60 });
      expect(getter).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});

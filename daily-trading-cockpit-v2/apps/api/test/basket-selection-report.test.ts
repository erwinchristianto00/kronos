import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLiveRoutes } from "../src/routes/live.js";
import type { CrossSectionalExecutor, ExecutorBasket } from "../src/lib/cross-sectional-executor.js";

afterEach(() => vi.unstubAllEnvs());
it("carries each basket's persisted selection through open, closed and legacy audit report rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "basket-selection-report-"));
  vi.stubEnv("CROSS_SECTIONAL_UNREALIZED_EXTREMA_FILE", join(dir, "extrema.json"));
  vi.stubEnv("CROSS_SECTIONAL_REPORT_START_AT", "2026-09-01T00:00:00Z");
  const preference = (selectionMode: string) => ({ policyId: "cross-preference-formation-v1", selectionMode,
    reason: selectionMode === "PREFERRED" ? "PREFERRED_RECENT_STRENGTH_ALIGNED" : "BASELINE_ALREADY_BEST" });
  const make = (basketId: string, selectionMode: string | null, status: string, openedAt = "2026-09-05T00:00:00Z") => ({
    basketId, sourceObservationId: basketId, variant: "DYNAMIC_MOM36_SHOCK", signal: "DYNAMIC_MOM36_SHOCK_36H",
    status, openedAt, closedAt: status === "CLOSED" ? "2026-09-05T01:00:00Z" : null,
    closesAtMs: Date.parse(openedAt) + 36 * 3600_000, closeReason: null,
    dynamicMom36: selectionMode ? { recentStrengthPreference: preference(selectionMode) } : null,
    dynamicMom36NetLadderExit: selectionMode === "BASELINE" ? { version: "DYNAMIC_MOM36_NET_LADDER_VOL5M_EXIT_V1", policyId: "frozen-usd", armNetPnlUsd: 1.5, trailArmed: false, trailingFloorNetUsd: null, entryCapitalUsd: 150 } : null,
    crossProfitProtection: selectionMode === "PREFERRED" ? { version: "CROSS_PROFIT_PROTECTION_V1", policyId: "frozen-fraction", armFraction: .005, keepFraction: .7, armed: true, floorFraction: .004, entryNotionalUsd: 150 } : null,
    protectionObservation: { lastEvaluatedAt: "2026-09-05T00:01:01.095Z", intervalMs: 1095, source: "WATCHER" },
    legs: [], grossPnlUsd: 0, feeEstimateUsd: 0, netPnlUsd: 0,
  });
  const source = [make("open-alt", "PREFERRED", "COMPLETE"), make("open-base", "BASELINE", "COMPLETE"),
    make("open-legacy", null, "COMPLETE"), make("closed-base", "BASELINE", "CLOSED"),
    make("closed-alt", "PREFERRED", "CLOSED"), make("closed-legacy", null, "CLOSED"),
    make("audit-alt", "PREFERRED", "CLOSED", "2026-08-30T00:00:00Z")];
  writeFileSync(join(dir, "baskets.json"), JSON.stringify(source));
  const baskets = JSON.parse(readFileSync(join(dir, "baskets.json"), "utf8")) as ExecutorBasket[];
  const executor = {
    getStatus: () => ({ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", openBaskets: baskets.filter(b => b.status === "COMPLETE"),
      closedCount: 4, accountingCounts: { cleanN: 4, quarantinedN: 0, rejectedN: 0 } }),
    getExposureSnapshot: () => ({ openBaskets: baskets.filter(b => b.status === "COMPLETE"), orphanedLegs: [] }),
    getClosedBaskets: () => baskets.filter(b => b.status === "CLOSED"),
    getClosedBasketsForAudit: () => baskets.filter(b => b.status === "CLOSED"),
  } as unknown as CrossSectionalExecutor;
  const app = Fastify();
  try {
    await registerLiveRoutes(app, null, { crossSectionalExecutor: () => executor });
    const response = await app.inject({ method: "GET", url: "/api/live/cross-sectional-closed-baskets" });
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json();
    const rows = [...report.openBaskets, ...report.lanes[0].baskets, ...report.auditHistory.lanes[0].baskets];
    expect(rows).toHaveLength(source.length);
    for (const stored of source) {
      expect(rows.find(row => row.basketId === stored.basketId).recentStrengthPreference)
        .toEqual(stored.dynamicMom36?.recentStrengthPreference ?? null);
      const p = rows.find(row => row.basketId === stored.basketId).protectionSummary;
      const mode = stored.dynamicMom36?.recentStrengthPreference?.selectionMode;
      expect(p.effectiveArmUsd).toBe(mode === "PREFERRED" ? .75 : mode === "BASELINE" ? 1.5 : null);
      expect(p.trailArmed).toBe(mode === "PREFERRED" ? true : mode === "BASELINE" ? false : null);
      expect(p.floorUsd).toBe(mode === "PREFERRED" ? .6 : null);
      expect(p.lastEvaluationIntervalMs).toBe(1095);
    }
    const audit = await app.inject({ method: "GET", url: "/api/live/cross-sectional-protection-audit" });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().baskets).toHaveLength(source.length);
    expect(audit.json().baskets.find(row => row.basketId === "open-base").protectionSummary.effectiveArmUsd).toBe(1.5);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Tests for controller-aligned-edge-isolation.ts
 * Report-only module — zero I/O, pure function.
 */

import { describe, expect, it } from "vitest";

import {
  buildControllerAlignedEdgeIsolationReport,
  type SubCohortEconomics,
} from "../src/lib/controller-aligned-edge-isolation.js";
import type { ControllerAlignedShadowPosition } from "../src/lib/regime-controller-aligned-shadow.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeObs(overrides: Partial<ControllerAlignedShadowPosition> = {}): ControllerAlignedShadowPosition {
  return {
    id: `obs-${Math.random()}`,
    symbol: "BTCUSDT",
    direction: "LONG",
    routeMode: "RESEARCH_ONLY",
    entryVariant: "base_current_entry",
    exitVariant: "tp1_full_exit",
    entryPrice: 50000,
    stopLoss: 49000,
    takeProfitLevels: [52000],
    stopDistanceBps: 200,
    controllerMode: "LONG_ONLY",
    controllerAlignment: "ALIGNED",
    openedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    closedAt: new Date().toISOString(),
    marketRegimeAtOpen: "Bullish expansion",
    status: "CLOSED_WIN",
    netR: 0.83,
    grossR: 1.0,
    costR: 0.14,
    durationMinutes: 60,
    resolutionSource: "TP1_HIT",
    laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1",
    reportOnly: true,
    policyVersion: "base-route-anchor-consistent-v2",
    ...overrides,
  };
}

function makeLoss(overrides: Partial<ControllerAlignedShadowPosition> = {}): ControllerAlignedShadowPosition {
  return makeObs({
    status: "CLOSED_LOSS",
    grossR: -1.0,
    netR: -1.14,
    resolutionSource: "SL_HIT",
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildControllerAlignedEdgeIsolationReport", () => {

  it("1. bySymbol groups correctly — BTCUSDT losses, SOLUSDT wins", () => {
    const obs = [
      makeLoss({ symbol: "BTCUSDT" }),
      makeLoss({ symbol: "BTCUSDT" }),
      makeLoss({ symbol: "BTCUSDT" }),
      makeObs({ symbol: "SOLUSDT", grossR: 1.5, costR: 0.14, netR: 1.36 }),
      makeObs({ symbol: "SOLUSDT", grossR: 1.5, costR: 0.14, netR: 1.36 }),
    ];

    const report = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");

    expect(report.reportOnly).toBe(true);
    expect(report.inputN).toBe(5);

    const btc = report.bySymbol.find((c) => c.label === "BTCUSDT");
    const sol = report.bySymbol.find((c) => c.label === "SOLUSDT");

    expect(btc).toBeDefined();
    expect(btc!.netAvgR).toBeLessThan(0);
    expect(btc!.wins).toBe(0);
    expect(btc!.losses).toBe(3);

    expect(sol).toBeDefined();
    expect(sol!.netAvgR).toBeGreaterThan(0);
    expect(sol!.wins).toBe(2);
    expect(sol!.losses).toBe(0);
  });

  it("2. byCostBucket groups correctly — 4 distinct buckets", () => {
    const obs = [
      makeObs({ costR: 0.05, grossR: 1.0 }),       // ≤0.10
      makeObs({ costR: 0.12, grossR: 1.0 }),       // 0.10-0.15
      makeObs({ costR: 0.18, grossR: 1.0 }),       // 0.15-0.20
      makeObs({ costR: 0.25, grossR: 1.0 }),       // >0.20
    ];

    const report = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");

    const labels = report.byCostBucket.map((c) => c.label);
    expect(labels).toContain("≤0.10");
    expect(labels).toContain("0.10-0.15");
    expect(labels).toContain("0.15-0.20");
    expect(labels).toContain(">0.20");
    expect(report.byCostBucket.filter((c) => c.label !== "unknown")).toHaveLength(4);
  });

  it("3. byStopBucket groups correctly — 5 distinct buckets", () => {
    const obs = [
      makeObs({ stopDistanceBps: 85 }),    // 80-100
      makeObs({ stopDistanceBps: 110 }),   // 100-125
      makeObs({ stopDistanceBps: 135 }),   // 125-150
      makeObs({ stopDistanceBps: 160 }),   // 150-175
      makeObs({ stopDistanceBps: 180 }),   // 175+
    ];

    const report = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");

    const labels = report.byStopBucket.map((c) => c.label);
    expect(labels).toContain("80-100");
    expect(labels).toContain("100-125");
    expect(labels).toContain("125-150");
    expect(labels).toContain("150-175");
    expect(labels).toContain("175+");
    expect(report.byStopBucket.filter((c) => c.label !== "unknown")).toHaveLength(5);
  });

  it("4. bestSubCohorts requires n>=5", () => {
    // Build 4 SOLUSDT wins — should NOT appear in bestSubCohorts
    const obs4 = Array.from({ length: 4 }, () =>
      makeObs({ symbol: "SOLUSDT", grossR: 2.0, costR: 0.14, netR: 1.86 }),
    );

    const report4 = buildControllerAlignedEdgeIsolationReport(obs4, "INSUFFICIENT_DATA");
    const solBest4 = report4.bestSubCohorts.find((c) => c.label === "SOLUSDT");
    expect(solBest4).toBeUndefined(); // n=4 < 5, not in best

    // Add 5th obs — should NOW appear in bestSubCohorts
    const obs5 = [
      ...obs4,
      makeObs({ symbol: "SOLUSDT", grossR: 2.0, costR: 0.14, netR: 1.86 }),
    ];

    const report5 = buildControllerAlignedEdgeIsolationReport(obs5, "INSUFFICIENT_DATA");
    const solBest5 = report5.bestSubCohorts.find((c) => c.label === "SOLUSDT");
    expect(solBest5).toBeDefined();
    expect(solBest5!.n).toBe(5);
  });

  it("5. worstSubCohorts requires n>=3", () => {
    // 2 BTCUSDT losses — should NOT appear in worstSubCohorts
    const obs2 = [
      makeLoss({ symbol: "BTCUSDT" }),
      makeLoss({ symbol: "BTCUSDT" }),
    ];

    const report2 = buildControllerAlignedEdgeIsolationReport(obs2, "INSUFFICIENT_DATA");
    const btcWorst2 = report2.worstSubCohorts.find((c) => c.label === "BTCUSDT");
    expect(btcWorst2).toBeUndefined(); // n=2 < 3

    // Add 3rd obs
    const obs3 = [...obs2, makeLoss({ symbol: "BTCUSDT" })];
    const report3 = buildControllerAlignedEdgeIsolationReport(obs3, "INSUFFICIENT_DATA");
    const btcWorst3 = report3.worstSubCohorts.find((c) => c.label === "BTCUSDT");
    expect(btcWorst3).toBeDefined();
    expect(btcWorst3!.n).toBe(3);
  });

  it("6. EXCLUDE_SYMBOL prune suggestion for toxic BTCUSDT (3 losses)", () => {
    const obs = [
      makeLoss({ symbol: "BTCUSDT", grossR: -1.0, costR: 0.14 }),
      makeLoss({ symbol: "BTCUSDT", grossR: -1.0, costR: 0.14 }),
      makeLoss({ symbol: "BTCUSDT", grossR: -1.0, costR: 0.14 }),
    ];

    const report = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");

    const suggestion = report.pruneSuggestions.find(
      (s) => s.type === "EXCLUDE_SYMBOL" && s.label === "BTCUSDT",
    );
    expect(suggestion).toBeDefined();
    expect(suggestion!.affectedN).toBe(3);
    expect(suggestion!.cohortNetAvgR).toBeLessThan(-0.10);
  });

  it("7. exitExtensionConclusion stored correctly", () => {
    const obs = [makeObs()];
    const report = buildControllerAlignedEdgeIsolationReport(obs, "NO_POSITIVE_EXACT_EXIT");
    expect(report.exitExtensionConclusion).toBe("NO_POSITIVE_EXACT_EXIT");

    const report2 = buildControllerAlignedEdgeIsolationReport(obs, "POSITIVE_EXACT_EXIT");
    expect(report2.exitExtensionConclusion).toBe("POSITIVE_EXACT_EXIT");

    const report3 = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");
    expect(report3.exitExtensionConclusion).toBe("INSUFFICIENT_DATA");
  });

  it("8. skips FAILED_INVALID_GEOMETRY observations", () => {
    const validObs = makeObs({ status: "CLOSED_WIN", grossR: 1.0, costR: 0.14 });
    const invalidObs = makeObs({
      status: "FAILED_INVALID_GEOMETRY" as ControllerAlignedShadowPosition["status"],
      grossR: null,
      costR: null,
    });

    const report = buildControllerAlignedEdgeIsolationReport(
      [validObs, invalidObs],
      "INSUFFICIENT_DATA",
    );

    // Only the valid obs should be counted
    expect(report.inputN).toBe(1);
  });

  it("9. skips non-resolved statuses (PENDING / OPEN)", () => {
    const openObs = makeObs({
      status: "OPEN",
      grossR: null,
      closedAt: null,
    });
    const pendingObs = makeObs({
      status: "OPEN" as ControllerAlignedShadowPosition["status"],
      grossR: null,
      closedAt: null,
    });
    const resolvedObs = makeObs({ status: "CLOSED_WIN", grossR: 1.0 });

    const report = buildControllerAlignedEdgeIsolationReport(
      [openObs, pendingObs, resolvedObs],
      "INSUFFICIENT_DATA",
    );

    expect(report.inputN).toBe(1);
  });

  it("10. PF is Infinity when no losses in cohort", () => {
    const allWinObs = Array.from({ length: 3 }, () =>
      makeObs({ symbol: "SOLUSDT", grossR: 1.5, costR: 0.14, status: "CLOSED_WIN" }),
    );

    const report = buildControllerAlignedEdgeIsolationReport(allWinObs, "INSUFFICIENT_DATA");

    const sol = report.bySymbol.find((c) => c.label === "SOLUSDT");
    expect(sol).toBeDefined();
    expect(sol!.losses).toBe(0);
    // pf should be Infinity when no losses
    expect(sol!.pf).toBe(Infinity);
  });

  it("11. safe on empty input — inputN=0 and empty arrays", () => {
    const report = buildControllerAlignedEdgeIsolationReport([], "INSUFFICIENT_DATA");

    expect(report.reportOnly).toBe(true);
    expect(report.inputN).toBe(0);
    expect(report.bySymbol).toHaveLength(0);
    expect(report.byStopBucket).toHaveLength(0);
    expect(report.byCostBucket).toHaveLength(0);
    expect(report.bestSubCohorts).toHaveLength(0);
    expect(report.worstSubCohorts).toHaveLength(0);
    expect(report.pruneSuggestions).toHaveLength(0);
  });

  it("12. byRegimeFamily classifies correctly", () => {
    const obs = [
      makeObs({ marketRegimeAtOpen: "Bearish expansion", grossR: -1.0, status: "CLOSED_LOSS" }),
      makeObs({ marketRegimeAtOpen: "Bullish expansion", grossR: 1.0, status: "CLOSED_WIN" }),
      makeObs({ marketRegimeAtOpen: null, grossR: 1.0, status: "CLOSED_WIN" }),
    ];

    const report = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");

    const families = report.byRegimeFamily.map((c) => c.label);
    expect(families).toContain("bearish");
    expect(families).toContain("bullish");
    expect(families).toContain("unknown");

    const bearish = report.byRegimeFamily.find((c) => c.label === "bearish");
    const bullish = report.byRegimeFamily.find((c) => c.label === "bullish");
    expect(bearish).toBeDefined();
    expect(bullish).toBeDefined();
    // Bearish obs was a loss — netAvgR should be negative
    expect(bearish!.netAvgR).toBeLessThan(0);
    // Bullish obs was a win — netAvgR should be positive
    expect(bullish!.netAvgR).toBeGreaterThan(0);
  });

  it("computedAt is present and truthy", () => {
    const report = buildControllerAlignedEdgeIsolationReport([], "INSUFFICIENT_DATA");
    expect(report.computedAt).toBeTruthy();
    // Should be a valid ISO timestamp
    expect(() => new Date(report.computedAt)).not.toThrow();
  });

  it("byControllerMode groups by controllerMode field", () => {
    const obs = [
      makeObs({ controllerMode: "LONG_ONLY", grossR: 1.0, status: "CLOSED_WIN" }),
      makeObs({ controllerMode: "LONG_ONLY", grossR: 1.0, status: "CLOSED_WIN" }),
      makeObs({ controllerMode: "SHORT_ONLY", grossR: -1.0, status: "CLOSED_LOSS" }),
    ];

    const report = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");

    const longOnly = report.byControllerMode.find((c) => c.label === "LONG_ONLY");
    const shortOnly = report.byControllerMode.find((c) => c.label === "SHORT_ONLY");

    expect(longOnly).toBeDefined();
    expect(longOnly!.n).toBe(2);
    expect(longOnly!.netAvgR).toBeGreaterThan(0);

    expect(shortOnly).toBeDefined();
    expect(shortOnly!.n).toBe(1);
    expect(shortOnly!.netAvgR).toBeLessThan(0);
  });

  it("COST_R_CAP prune suggestion fires for >0.20 bucket with n>=3 and netAvgR<0", () => {
    const obs = [
      makeLoss({ costR: 0.25, grossR: -1.0 }),
      makeLoss({ costR: 0.30, grossR: -1.0 }),
      makeLoss({ costR: 0.28, grossR: -1.0 }),
    ];

    const report = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");

    const costSuggestion = report.pruneSuggestions.find((s) => s.type === "COST_R_CAP");
    expect(costSuggestion).toBeDefined();
    expect(costSuggestion!.affectedN).toBe(3);
  });

  it("STOP_BUCKET_FILTER prune suggestion fires for 80-100 bucket with n>=3 and netAvgR<0", () => {
    const obs = [
      makeLoss({ stopDistanceBps: 85, grossR: -1.0, costR: 0.33 }),
      makeLoss({ stopDistanceBps: 90, grossR: -1.0, costR: 0.31 }),
      makeLoss({ stopDistanceBps: 95, grossR: -1.0, costR: 0.29 }),
    ];

    const report = buildControllerAlignedEdgeIsolationReport(obs, "INSUFFICIENT_DATA");

    const stopSuggestion = report.pruneSuggestions.find((s) => s.type === "STOP_BUCKET_FILTER");
    expect(stopSuggestion).toBeDefined();
    expect(stopSuggestion!.affectedN).toBe(3);
  });
});

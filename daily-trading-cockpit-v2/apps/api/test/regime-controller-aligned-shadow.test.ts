/**
 * Tests for the Regime Controller Aligned Shadow Collection Lane.
 * All tests verify REPORT-ONLY behavior — no live shadow tape is touched.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";
import {
  RegimeControllerAlignedShadowStore,
  admitToControllerAlignedShadow,
  buildRegimeControllerAlignedShadowReport,
  computeControllerAlignedGuardThreshold,
  REGIME_CONTROLLER_ALIGNED_SHADOW_LANE_LABEL,
  type ControllerAlignedCandidate,
} from "../src/lib/regime-controller-aligned-shadow.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cas-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeStore(): RegimeControllerAlignedShadowStore {
  return new RegimeControllerAlignedShadowStore(tempDir);
}

function makeCandidate(overrides: Partial<ControllerAlignedCandidate> = {}): ControllerAlignedCandidate {
  return {
    symbol: "BTCUSDT",
    direction: "LONG",
    routeMode: "RESEARCH_ONLY",
    currentPrice: 50000,
    entryPrice: 50000,
    stopLoss: 49000,
    takeProfitLevels: [52000],
    selectedExecutionPlan: {
      selectedEntryVariant: "base_current_entry",
      selectedExitVariant: "tp1_full_exit",
      stopDistanceBps: 300,
      routeMode: "RESEARCH_ONLY",
    },
    sourceConflict: false,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("admitToControllerAlignedShadow", () => {
  it("LONG_ONLY controller admits a LONG candidate", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
    });
    expect(controllerReport.controllerMode).toBe("LONG_ONLY");

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "LONG" })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(1);
    expect(result.skipped).toBe(0);

    const state = store.readState();
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0].direction).toBe("LONG");
    expect(state.observations[0].controllerMode).toBe("LONG_ONLY");
    expect(state.observations[0].laneLabel).toBe(REGIME_CONTROLLER_ALIGNED_SHADOW_LANE_LABEL);
    expect(state.observations[0].reportOnly).toBe(true);
  });

  it("LONG_ONLY controller rejects a SHORT candidate", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
    });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "SHORT" })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skipReasons["DIRECTION_MISMATCH_LONG_ONLY"]).toBe(1);

    const state = store.readState();
    expect(state.observations).toHaveLength(0);
  });

  it("SHORT_ONLY controller admits a SHORT candidate", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BEARISH_EXPANSION",
    });
    expect(controllerReport.controllerMode).toBe("SHORT_ONLY");

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "SHORT" })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(1);
    expect(result.skipped).toBe(0);

    const state = store.readState();
    expect(state.observations[0].direction).toBe("SHORT");
    expect(state.observations[0].controllerMode).toBe("SHORT_ONLY");
  });

  it("rejects candidate with stopDistanceBps below variant-adjusted guard (no atrPercent → fallback 175, stopBps=100 < 175)", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
    });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ selectedExecutionPlan: { stopDistanceBps: 100 }, atrPercent: null })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipReasons["STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD"]).toBe(1);
  });

  it("rejects candidate with sourceConflict=true", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
    });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ sourceConflict: true })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipReasons["SOURCE_CONFLICT"]).toBe(1);
  });

  it("duplicate suppression: same symbol+direction+route within window is rejected", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
    });

    // First admission
    const result1 = admitToControllerAlignedShadow(
      [makeCandidate({ symbol: "BTCUSDT", direction: "LONG" })],
      store,
      { controllerReport, duplicateWindowMs: 4 * 60 * 60 * 1000 },
    );
    expect(result1.admitted).toBe(1);

    // Second identical admission — should be suppressed
    const result2 = admitToControllerAlignedShadow(
      [makeCandidate({ symbol: "BTCUSDT", direction: "LONG" })],
      store,
      { controllerReport, duplicateWindowMs: 4 * 60 * 60 * 1000 },
    );
    expect(result2.admitted).toBe(0);
    expect(result2.skipReasons["DUPLICATE_WITHIN_WINDOW"]).toBe(1);
  });

  it("admitted position has laneLabel=REGIME_CONTROLLER_ALIGNED_SHADOW_V1 and reportOnly=true", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
    });

    admitToControllerAlignedShadow(
      [makeCandidate()],
      store,
      { controllerReport },
    );

    const state = store.readState();
    expect(state.observations[0].laneLabel).toBe("REGIME_CONTROLLER_ALIGNED_SHADOW_V1");
    expect(state.observations[0].reportOnly).toBe(true);
    expect(state.observations[0].policyVersion).toBe("base-route-anchor-consistent-v2");
  });

  it("normal shadow-positions.json is NOT written by admitToControllerAlignedShadow", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
    });

    admitToControllerAlignedShadow(
      [makeCandidate()],
      store,
      { controllerReport },
    );

    // The normal shadow tape should NOT exist in our temp dir
    const shadowTapePath = resolve(tempDir, "shadow-positions.json");
    expect(existsSync(shadowTapePath)).toBe(false);

    // But the controller-aligned file should exist
    const alignedPath = resolve(tempDir, "regime-controller-aligned-shadow.json");
    expect(existsSync(alignedPath)).toBe(true);
  });

  it("rejects all candidates when controller mode is BOTH_ALLOWED (not directional)", () => {
    const store = makeStore();
    // Mixed/rotation regime → VALIDATION_ONLY (still allowed actually)
    // For BOTH_ALLOWED we need a regime that maps to it — actually current mapping never produces BOTH_ALLOWED
    // Use VALIDATION_ONLY which still has allowsLong+allowsShort but is allowed per spec
    // Test NO_TRADE_CHOP instead which blocks everyone
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "CHOP_CONSOLIDATION",
    });
    expect(controllerReport.controllerMode).toBe("NO_TRADE_CHOP");

    const result = admitToControllerAlignedShadow(
      [makeCandidate(), makeCandidate({ direction: "SHORT" })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.skipReasons["CONTROLLER_MODE_NOT_DIRECTIONAL"]).toBe(2);
  });

  it("rejects candidate with no entryPrice and no currentPrice → MISSING_REAL_ENTRY_GEOMETRY (no placeholder NO_FILL)", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
    });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ currentPrice: null, entryPrice: null })],
      store,
      { controllerReport },
    );

    // New behavior: missing entry price → skip with MISSING_REAL_ENTRY_GEOMETRY (no placeholder admission)
    expect(result.admitted).toBe(0);
    expect(result.skipReasons["MISSING_REAL_ENTRY_GEOMETRY"]).toBe(1);
    const state = store.readState();
    expect(state.observations).toHaveLength(0);
  });
});

describe("buildRegimeControllerAlignedShadowReport", () => {
  it("returns TOO_EARLY verdict when resolved < 20", () => {
    const report = buildRegimeControllerAlignedShadowReport({ observations: [] });
    expect(report.verdict).toBe("TOO_EARLY");
    expect(report.reportOnly).toBe(true);
    expect(report.laneLabel).toBe("REGIME_CONTROLLER_ALIGNED_SHADOW_V1");
  });

  it("returns EVIDENCE_AVAILABLE verdict when resolved >= 20", () => {
    const obs = Array.from({ length: 20 }, (_, i) => ({
      id: `obs-${i}`,
      symbol: "BTCUSDT",
      direction: "LONG" as const,
      routeMode: null,
      entryVariant: null,
      exitVariant: null,
      entryPrice: 100,
      stopLoss: 0,
      takeProfitLevels: [],
      stopDistanceBps: 300,
      controllerMode: "LONG_ONLY",
      controllerAlignment: "ALIGNED" as const,
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: null,
      status: "CLOSED_WIN" as const,
      netR: 0.5,
      grossR: 0.7,
      costR: 0.14,
      durationMinutes: 30,
      resolutionSource: "TP1_HIT" as const,
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1" as const,
      reportOnly: true as const,
      policyVersion: "base-route-anchor-consistent-v2",
    }));

    const report = buildRegimeControllerAlignedShadowReport({ observations: obs });
    expect(report.verdict).toBe("EVIDENCE_AVAILABLE");
    expect(report.resolvedObservations).toBe(20);
  });
});

// ─── Phase 2Z.1 variant-adjusted guard admission tests ───────────────────────

describe("admitToControllerAlignedShadow — variant-adjusted guard (Phase 2Z.1)", () => {
  // Test 7: stopBps=120, atrPercent=0.69 → atrBps=69, threshold=80 → admitted (120 >= 80)
  it("stopDistanceBps=120, atrPercent=0.69 (atrBps=69, threshold=80) → admitted", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    const guard = computeControllerAlignedGuardThreshold(0.69);
    expect(guard.variantAdjustedGuardThresholdBps).toBe(80);

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "LONG", atrPercent: 0.69, selectedExecutionPlan: { stopDistanceBps: 120, routeMode: "RESEARCH_ONLY" } })],
      store,
      { controllerReport },
    );
    expect(result.admitted).toBe(1);
    expect(result.skipped).toBe(0);
  });

  // Test 8: BTC-like: stopBps=11, atrPercent=0.09 → atrBps=9, threshold=80 → rejected (11 < 80)
  it("stopDistanceBps=11, atrPercent=0.09 (BTC-like, atrBps=9, threshold=80) → rejected", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "LONG", atrPercent: 0.09, selectedExecutionPlan: { stopDistanceBps: 11, routeMode: "RESEARCH_ONLY" } })],
      store,
      { controllerReport },
    );
    expect(result.admitted).toBe(0);
    expect(result.skipReasons["STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD"]).toBe(1);
  });

  // Test 9: stopBps=79, atrPercent=0.69 → threshold=80 → rejected (79 < 80)
  it("stopDistanceBps=79, atrPercent=0.69 (threshold=80) → rejected (79 < 80)", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "LONG", atrPercent: 0.69, selectedExecutionPlan: { stopDistanceBps: 79, routeMode: "RESEARCH_ONLY" } })],
      store,
      { controllerReport },
    );
    expect(result.admitted).toBe(0);
    expect(result.skipReasons["STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD"]).toBe(1);
  });

  // Test 10: stopBps=80, atrPercent=0.69 → threshold=80 → admitted (exactly at threshold)
  it("stopDistanceBps=80, atrPercent=0.69 (threshold=80) → admitted (exactly at threshold)", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "LONG", atrPercent: 0.69, selectedExecutionPlan: { stopDistanceBps: 80, routeMode: "RESEARCH_ONLY" } })],
      store,
      { controllerReport },
    );
    expect(result.admitted).toBe(1);
  });

  // Test 11: stopBps=120, atrPercent=1.8 → atrBps=180, threshold=180 → rejected (120 < 180)
  it("stopDistanceBps=120, atrPercent=1.8 (atrBps=180, threshold=180) → rejected (120 < 180)", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "LONG", atrPercent: 1.8, selectedExecutionPlan: { stopDistanceBps: 120, routeMode: "RESEARCH_ONLY" } })],
      store,
      { controllerReport },
    );
    expect(result.admitted).toBe(0);
    expect(result.skipReasons["STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD"]).toBe(1);
  });

  // Test 12: sourceConflict still rejects
  it("sourceConflict=true still rejects regardless of atrPercent", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "LONG", atrPercent: 0.69, sourceConflict: true, selectedExecutionPlan: { stopDistanceBps: 300, routeMode: "RESEARCH_ONLY" } })],
      store,
      { controllerReport },
    );
    expect(result.admitted).toBe(0);
    expect(result.skipReasons["SOURCE_CONFLICT"]).toBe(1);
  });

  // Test 13: duplicate suppression unchanged
  it("duplicate suppression still works with atrPercent present", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    const candidate = makeCandidate({ direction: "LONG", atrPercent: 0.69, selectedExecutionPlan: { stopDistanceBps: 120, routeMode: "RESEARCH_ONLY" } });

    const r1 = admitToControllerAlignedShadow([candidate], store, { controllerReport, duplicateWindowMs: 4 * 60 * 60 * 1000 });
    expect(r1.admitted).toBe(1);

    const r2 = admitToControllerAlignedShadow([candidate], store, { controllerReport, duplicateWindowMs: 4 * 60 * 60 * 1000 });
    expect(r2.admitted).toBe(0);
    expect(r2.skipReasons["DUPLICATE_WITHIN_WINDOW"]).toBe(1);
  });
});

// ─── Geometry validation admission tests ─────────────────────────────────────

describe("admitToControllerAlignedShadow — real geometry validation", () => {
  it("valid geometry (entryPrice, stopLoss, tp1 all > 0) → admitted and stored correctly", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "BULLISH_EXPANSION" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({
        direction: "LONG",
        currentPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfitLevels: [52000],
      })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(1);
    expect(result.skipped).toBe(0);
    const obs = store.readState().observations[0]!;
    expect(obs.entryPrice).toBe(50000);
    expect(obs.stopLoss).toBe(49000);
    expect(obs.takeProfitLevels).toEqual([52000]);
    expect(obs.status).toBe("OPEN");
  });

  it("stopLoss = 0 → rejected with MISSING_STOP_LOSS", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "BULLISH_EXPANSION" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({
        direction: "LONG",
        currentPrice: 50000,
        entryPrice: 50000,
        stopLoss: 0,
        takeProfitLevels: [52000],
      })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipReasons["MISSING_STOP_LOSS"]).toBe(1);
    expect(store.readState().observations).toHaveLength(0);
  });

  it("stopLoss = null → rejected with MISSING_STOP_LOSS", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "BULLISH_EXPANSION" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({
        direction: "LONG",
        currentPrice: 50000,
        entryPrice: 50000,
        stopLoss: null,
        takeProfitLevels: [52000],
      })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipReasons["MISSING_STOP_LOSS"]).toBe(1);
  });

  it("empty takeProfitLevels → rejected with MISSING_TAKE_PROFIT_LEVELS", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "BULLISH_EXPANSION" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({
        direction: "LONG",
        currentPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfitLevels: [],
      })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipReasons["MISSING_TAKE_PROFIT_LEVELS"]).toBe(1);
  });

  it("entryPrice = 0 (and no currentPrice/priceMap) → rejected with MISSING_REAL_ENTRY_GEOMETRY", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "BULLISH_EXPANSION" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({
        direction: "LONG",
        currentPrice: null,
        entryPrice: 0,
        stopLoss: 49000,
        takeProfitLevels: [52000],
      })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipReasons["MISSING_REAL_ENTRY_GEOMETRY"]).toBe(1);
  });

  it("tp1 > 0 and stopLoss > 0 and entryPrice > 0 → admitted, geometry stored in observation", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "BULLISH_EXPANSION" });

    admitToControllerAlignedShadow(
      [makeCandidate({
        direction: "LONG",
        currentPrice: 48000,
        entryPrice: 48500,
        stopLoss: 47000,
        takeProfitLevels: [50000, 52000],
      })],
      store,
      { controllerReport },
    );

    const obs = store.readState().observations[0]!;
    expect(obs.entryPrice).toBe(48500);
    expect(obs.stopLoss).toBe(47000);
    expect(obs.takeProfitLevels[0]).toBe(50000);
    expect(obs.takeProfitLevels[1]).toBe(52000);
    expect(obs.status).toBe("OPEN");
  });
});

// ─── Payoff anatomy tests ────────────────────────────────────────────────────

describe("buildRegimeControllerAlignedShadowReport — payoff anatomy", () => {
  function makeResolvedObs(
    status: "CLOSED_WIN" | "CLOSED_LOSS",
    opts: {
      grossR: number;
      netR: number;
      costR: number;
      stopDistanceBps?: number;
      symbol?: string;
      controllerMode?: string;
    },
  ) {
    return {
      id: `obs-${Math.random()}`,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: "SHORT" as const,
      routeMode: null,
      entryVariant: null,
      exitVariant: null,
      entryPrice: 100,
      stopLoss: 101,
      takeProfitLevels: [98],
      stopDistanceBps: opts.stopDistanceBps ?? 200,
      controllerMode: opts.controllerMode ?? "SHORT_ONLY",
      controllerAlignment: "ALIGNED" as const,
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: null,
      status,
      netR: opts.netR,
      grossR: opts.grossR,
      costR: opts.costR,
      durationMinutes: 30,
      resolutionSource: (status === "CLOSED_WIN" ? "TP1_HIT" : "SL_HIT") as "TP1_HIT" | "SL_HIT",
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1" as const,
      reportOnly: true as const,
      policyVersion: "base-route-anchor-consistent-v2",
    };
  }

  it("payoffAnatomy is undefined when no resolved observations", () => {
    const report = buildRegimeControllerAlignedShadowReport({ observations: [] });
    expect(report.payoffAnatomy).toBeUndefined();
  });

  it("payoffAnatomy: high TP1 hit rate but negative netAvgR explained by high costR", () => {
    // 5 CLOSED_WIN: grossR=0.1, costR=0.5 → netR=-0.4 (cost dominates gross)
    // WR (net positive) = 0% because netR is negative; but TP1 hit rate = 100%
    const observations = Array.from({ length: 5 }, () =>
      makeResolvedObs("CLOSED_WIN", { grossR: 0.1, netR: -0.4, costR: 0.5 }),
    );
    const report = buildRegimeControllerAlignedShadowReport({ observations });
    // netAvgR is negative because costR > grossR
    expect(report.overallNetAvgR).toBeCloseTo(-0.4, 4);
    expect(report.payoffAnatomy).toBeDefined();
    const pa = report.payoffAnatomy!;
    expect(pa.avgWinGrossR).toBeCloseTo(0.1, 4);
    expect(pa.avgLossGrossR).toBeNull(); // no losses
    expect(pa.avgCostR).toBeCloseTo(0.5, 4);
    expect(pa.grossToNetDrag).toBeCloseTo(0.5, 4); // avgGrossR(0.1) - avgNetR(-0.4) = 0.5
    // TP1 hit rate = wins / (wins + losses) = 5 / 5 = 100%
    expect(pa.tp1HitRate).toBeCloseTo(1.0, 5);
    expect(pa.slHitRate).toBeCloseTo(0.0, 5);
  });

  it("payoffAnatomy: payoffRatio = avgWinGrossR / |avgLossGrossR|", () => {
    const observations = [
      makeResolvedObs("CLOSED_WIN", { grossR: 0.5, netR: 0.36, costR: 0.14 }),
      makeResolvedObs("CLOSED_WIN", { grossR: 0.5, netR: 0.36, costR: 0.14 }),
      makeResolvedObs("CLOSED_LOSS", { grossR: -1.0, netR: -1.14, costR: 0.14 }),
      makeResolvedObs("CLOSED_LOSS", { grossR: -1.0, netR: -1.14, costR: 0.14 }),
    ];
    const report = buildRegimeControllerAlignedShadowReport({ observations });
    const pa = report.payoffAnatomy!;
    expect(pa.avgWinGrossR).toBeCloseTo(0.5, 4);
    expect(pa.avgLossGrossR).toBeCloseTo(-1.0, 4);
    // payoffRatio = 0.5 / 1.0 = 0.5
    expect(pa.payoffRatio).toBeCloseTo(0.5, 4);
  });

  it("payoffAnatomy: avgCostR = average of costR across all resolved observations", () => {
    const observations = [
      makeResolvedObs("CLOSED_WIN", { grossR: 0.5, netR: 0.36, costR: 0.14 }),
      makeResolvedObs("CLOSED_LOSS", { grossR: -1.0, netR: -1.28, costR: 0.28 }),
    ];
    const report = buildRegimeControllerAlignedShadowReport({ observations });
    const pa = report.payoffAnatomy!;
    // avgCostR = (0.14 + 0.28) / 2 = 0.21
    expect(pa.avgCostR).toBeCloseTo(0.21, 4);
  });

  it("topSymbols: sorted by netAvgR ascending (worst first)", () => {
    const observations = [
      makeResolvedObs("CLOSED_LOSS", { grossR: -1.0, netR: -1.14, costR: 0.14, symbol: "BTCUSDT" }),
      makeResolvedObs("CLOSED_WIN", { grossR: 0.5, netR: 0.36, costR: 0.14, symbol: "ETHUSDT" }),
      makeResolvedObs("CLOSED_WIN", { grossR: 0.8, netR: 0.66, costR: 0.14, symbol: "ETHUSDT" }),
    ];
    const report = buildRegimeControllerAlignedShadowReport({ observations });
    expect(report.topSymbols).toBeDefined();
    expect(report.topSymbols!.length).toBe(2);
    // BTCUSDT has netAvgR=-1.14, ETHUSDT has netAvgR≈+0.51 → BTC is worst (first)
    expect(report.topSymbols![0]!.symbol).toBe("BTCUSDT");
    expect(report.topSymbols![1]!.symbol).toBe("ETHUSDT");
  });
});

// ─── Additional admission tests ───────────────────────────────────────────────

describe("admitToControllerAlignedShadow additional coverage", () => {
  it("LONG_ONLY + LONG candidate with 'Bullish expansion' regime → admitted", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    expect(controllerReport.controllerMode).toBe("LONG_ONLY");

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "LONG" })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(1);
    expect(result.skipped).toBe(0);
    const state = store.readState();
    expect(state.observations[0].marketRegimeAtOpen).toBe("Bullish expansion");
    expect(state.observations[0].controllerMode).toBe("LONG_ONLY");
  });

  it("LONG_ONLY + SHORT candidate with 'Bullish expansion' regime → rejected DIRECTION_MISMATCH", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    expect(controllerReport.controllerMode).toBe("LONG_ONLY");

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ direction: "SHORT" })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipReasons["DIRECTION_MISMATCH_LONG_ONLY"]).toBe(1);
  });

  it("candidate with stopDistanceBps=174, no atrPercent → fallback guard=175 → rejected STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({ selectedExecutionPlan: { stopDistanceBps: 174 }, atrPercent: null })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(0);
    expect(result.skipReasons["STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD"]).toBe(1);
  });

  it("candidate with stopDistanceBps=175, no atrPercent → fallback guard=175 → admitted (exactly at threshold)", () => {
    const store = makeStore();
    const controllerReport = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });

    const result = admitToControllerAlignedShadow(
      [makeCandidate({
        direction: "LONG",
        atrPercent: null,
        selectedExecutionPlan: {
          selectedEntryVariant: "base_current_entry",
          selectedExitVariant: "tp1_full_exit",
          stopDistanceBps: 175,
          routeMode: "RESEARCH_ONLY",
        },
      })],
      store,
      { controllerReport },
    );

    expect(result.admitted).toBe(1);
  });
});

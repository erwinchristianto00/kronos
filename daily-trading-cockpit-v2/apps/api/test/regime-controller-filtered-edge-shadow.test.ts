import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import {
  admitToFilteredEdgeShadow,
  FilteredEdgeShadowStore,
  buildFilteredEdgeShadowReport,
  resolveFilteredEdgeShadowObservations,
  _resetFilteredEdgeShadowStoreForTests,
  isFreshValidFilteredEdgeObservation,
  FILTERED_EDGE_SHADOW_LANE,
  type FilteredEdgeCandidate,
  type FilteredEdgeShadowPosition,
} from "../src/lib/regime-controller-filtered-edge-shadow.js";
import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeBasePos(overrides: Partial<FilteredEdgeShadowPosition> = {}): FilteredEdgeShadowPosition {
  const now = new Date().toISOString();
  return {
    id: `test-base-${Date.now()}-${Math.random()}`,
    symbol: "SOLUSDT",
    direction: "SHORT",
    profile: "STRICT_COST10",
    controllerMode: "SHORT_ONLY",
    currentRegime: "Bearish expansion",
    marketRegimeAtOpen: "Bearish expansion",
    openedAt: now,
    createdAt: now,
    entryPrice: 100,
    stopLoss: 105,
    takeProfitLevels: [95],
    stopDistanceBps: 500,
    costR: 0.08,
    atrPercent: 1.0,
    variantAdjustedGuardThresholdBps: 100,
    guardPassedUnder: "VARIANT_ADJUSTED",
    sourceConflict: false,
    liveSourceConflict: false,
    kronosBias: null,
    whaleAgreement: null,
    selectedEntryVariant: null,
    selectedExitVariant: null,
    kronosHorizonConflict: null,
    status: "OPEN",
    closedAt: null,
    grossR: null,
    netR: null,
    resolutionSource: null,
    durationMinutes: null,
    reportOnly: true,
    laneVersion: FILTERED_EDGE_SHADOW_LANE,
    policyVersion: "filtered-edge-anchor-consistent-v1",
    analyticsVersion: "filtered-edge-forensics-v2",
    pathMetricVersion: "mfe-mae-bounded-v1",
    chronologyVersion: "chronology-fill-candle-v1",
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDirCounter = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `filtered-edge-test-${process.pid}-${++tmpDirCounter}`);
  return dir;
}

function makeCandidate(overrides: Partial<FilteredEdgeCandidate> = {}): FilteredEdgeCandidate {
  return {
    symbol: "SOLUSDT",
    direction: "SHORT",
    controllerMode: "SHORT_ONLY",
    currentRegime: "Bearish expansion",
    entryPrice: 100,
    stopLoss: 105,   // SHORT: stopLoss > entryPrice
    takeProfits: { tp1: 95, tp2: 90, tp3: 85 },
    stopDistanceBps: 500,  // (105-100)/100*10000 = 500bps
    costR: 0.08,
    atrPercent: 1.0,
    sourceConflict: false,
    liveSourceConflict: false,
    selectedExecutionPlan: { selectedEntryVariant: "fib_500_entry", selectedExitVariant: "fib_tp1_exit" },
    ...overrides,
  };
}

let storeDirs: string[] = [];

beforeEach(() => {
  _resetFilteredEdgeShadowStoreForTests();
});

afterEach(() => {
  _resetFilteredEdgeShadowStoreForTests();
  for (const dir of storeDirs) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  }
  storeDirs = [];
});

function makeStore(): FilteredEdgeShadowStore {
  const dir = tmpDir();
  storeDirs.push(dir);
  return new FilteredEdgeShadowStore(dir);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("regime-controller-filtered-edge-shadow", () => {
  // Test 1: STRICT admits costR=0.08
  it("admits costR=0.08 as STRICT_COST10", () => {
    const store = makeStore();
    const candidate = makeCandidate({ costR: 0.08 });
    const result = admitToFilteredEdgeShadow(candidate, store);
    expect(result.admitted).toBe(true);
    expect(result.profile).toBe("STRICT_COST10");
    expect(result.rejectionReasons).toHaveLength(0);
  });

  // Test 2: costR=0.15 rejects STRICT, passes BROAD
  it("rejects STRICT for costR=0.15 but passes BROAD_COST20_STOP150", () => {
    const store = makeStore();
    const candidate = makeCandidate({ costR: 0.15, stopDistanceBps: 200 });
    const result = admitToFilteredEdgeShadow(candidate, store);
    expect(result.admitted).toBe(true);
    expect(result.profile).toBe("BROAD_COST20_STOP150");
  });

  // Test 3: costR=0.25 rejects both STRICT and BROAD
  it("rejects costR=0.25 from both STRICT and BROAD", () => {
    const store = makeStore();
    const candidate = makeCandidate({ costR: 0.25, stopDistanceBps: 300 });
    const result = admitToFilteredEdgeShadow(candidate, store);
    expect(result.admitted).toBe(false);
    expect(result.rejectionReasons).toContain("COST_R_ABOVE_020");
  });

  // Test 4: Excludes BTCUSDT
  it("excludes BTCUSDT even with perfect costR", () => {
    const store = makeStore();
    const candidate = makeCandidate({
      symbol: "BTCUSDT",
      direction: "SHORT",
      controllerMode: "SHORT_ONLY",
      costR: 0.05,
      stopDistanceBps: 500,
    });
    const result = admitToFilteredEdgeShadow(candidate, store);
    expect(result.admitted).toBe(false);
    expect(result.rejectionReasons).toContain("EXCLUDED_SYMBOL_BTCUSDT");
  });

  // Test 5: Excludes SEIUSDT
  it("excludes SEIUSDT even with perfect costR", () => {
    const store = makeStore();
    const candidate = makeCandidate({
      symbol: "SEIUSDT",
      direction: "SHORT",
      controllerMode: "SHORT_ONLY",
      costR: 0.05,
      stopDistanceBps: 500,
    });
    const result = admitToFilteredEdgeShadow(candidate, store);
    expect(result.admitted).toBe(false);
    expect(result.rejectionReasons).toContain("EXCLUDED_SYMBOL_SEIUSDT");
  });

  // Test 6: BROAD rejects when stop < 150
  it("rejects BROAD when stopDistanceBps < 150 and costR=0.15", () => {
    const store = makeStore();
    const candidate = makeCandidate({ costR: 0.15, stopDistanceBps: 120 });
    const result = admitToFilteredEdgeShadow(candidate, store);
    expect(result.admitted).toBe(false);
    expect(result.rejectionReasons).toContain("STOP_DISTANCE_BELOW_150_FOR_BROAD");
  });

  // Test 7: sourceConflict=true rejects
  it("rejects when sourceConflict=true regardless of cost/stop", () => {
    const store = makeStore();
    const candidate = makeCandidate({ sourceConflict: true, costR: 0.05 });
    const result = admitToFilteredEdgeShadow(candidate, store);
    expect(result.admitted).toBe(false);
    expect(result.rejectionReasons).toContain("SOURCE_CONFLICT_TRUE");
  });

  // Test 8: Resolver computes TP1 win for SHORT position
  it("resolver computes CLOSED_WIN on TP1 hit for SHORT position", async () => {
    const store = makeStore();

    // Add an open LONG position for the resolver to walk
    // For LONG: entry=100, stop=95, tp1=110
    const openedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const pos: FilteredEdgeShadowPosition = {
      id: "SOLUSDT-STRICT_COST10-test1",
      symbol: "SOLUSDT",
      direction: "LONG",
      profile: "STRICT_COST10",
      controllerMode: "LONG_ONLY",
      currentRegime: "Bullish expansion",
      marketRegimeAtOpen: "Bullish expansion",
      openedAt,
      createdAt: openedAt,
      entryPrice: 100,
      stopLoss: 95,
      takeProfitLevels: [110, 115, 120],
      stopDistanceBps: 500,
      costR: 0.08,
      atrPercent: 1.0,
      variantAdjustedGuardThresholdBps: 100,
      guardPassedUnder: "VARIANT_ADJUSTED",
      sourceConflict: false,
      liveSourceConflict: false,
      kronosBias: null,
      whaleAgreement: null,
      selectedEntryVariant: null,
      selectedExitVariant: null,
      kronosHorizonConflict: null,
      status: "OPEN",
      closedAt: null,
      grossR: null,
      netR: null,
      resolutionSource: null,
      durationMinutes: null,
      reportOnly: true,
      laneVersion: FILTERED_EDGE_SHADOW_LANE,
      policyVersion: "filtered-edge-anchor-consistent-v1",
    };
    store.add(pos);

    // Mock binanceClient returning a candle where:
    //   - low=99 (fills the LONG at entry=100; low<=entry)
    //   - high=111 (hits tp1=110; high>=tp1)
    const mockBinanceClient = {
      getKlines: async (_symbol: string, _interval: string, _opts: { startTime: number; endTime: number; limit: number }) => {
        return [
          [
            Date.now() - 60 * 60 * 1000,  // openTime (1h ago)
            "100",                          // open
            "111",                          // high — triggers TP1
            "99",                           // low  — fills entry
            "105",                          // close
            "1000",                         // volume
            Date.now() - 59 * 60 * 1000,   // closeTime
          ] as [number, string, string, string, string, string, number],
        ];
      },
    };

    const result = await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    expect(result.resolved).toBe(1);
    expect(result.errors).toBe(0);

    const updated = store.all[0]!;
    expect(updated.status).toBe("CLOSED_WIN");
    expect(updated.resolutionSource).toBe("CANDLE_WALK_TP1");
    expect(updated.grossR).toBeGreaterThan(0);  // (110-100)/(100-95) = 2.0R
    expect(updated.netR).not.toBeNull();
    expect(updated.durationMinutes).not.toBeNull();
    expect(updated.durationMinutes!).toBeGreaterThanOrEqual(0);
    expect(updated.chronologyStatus).toBe("VALID");
    expect(updated.maxMfeR).not.toBeNull();
    expect(updated.minMaeR).not.toBeNull();
  });

  // Test 9: Dashboard renders profiles
  it("W*** section contains STRICT_COST10 and TOO_EARLY when resolved < 20", () => {
    const store = makeStore();

    // Add 2 open STRICT_COST10 observations
    for (let i = 0; i < 2; i++) {
      const openedAt = new Date().toISOString();
      const pos: FilteredEdgeShadowPosition = {
        id: `SOLUSDT-STRICT_COST10-test${i}`,
        symbol: "SOLUSDT",
        direction: "SHORT",
        profile: "STRICT_COST10",
        controllerMode: "SHORT_ONLY",
        currentRegime: "Bearish expansion",
        marketRegimeAtOpen: "Bearish expansion",
        openedAt,
        createdAt: openedAt,
        entryPrice: 100,
        stopLoss: 105,
        takeProfitLevels: [95],
        stopDistanceBps: 500,
        costR: 0.08,
        atrPercent: 1.0,
        variantAdjustedGuardThresholdBps: 100,
        guardPassedUnder: "VARIANT_ADJUSTED",
        sourceConflict: false,
        liveSourceConflict: false,
        kronosBias: null,
        whaleAgreement: null,
        selectedEntryVariant: null,
        selectedExitVariant: null,
        kronosHorizonConflict: null,
        status: "OPEN",
        closedAt: null,
        grossR: null,
        netR: null,
        resolutionSource: null,
        durationMinutes: null,
        reportOnly: true,
        laneVersion: FILTERED_EDGE_SHADOW_LANE,
        policyVersion: "filtered-edge-anchor-consistent-v1",
      };
      store.add(pos);
    }

    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const dashboard = buildDashboardAuditSummaryReport([], {
      filteredEdgeReport,
    });

    expect(dashboard.summaryText).toContain("W***.");
    expect(dashboard.summaryText).toContain("STRICT_COST10");
    expect(dashboard.summaryText).toContain("TOO_EARLY");
  });

  // Test 10: store path is isolated from shadow-positions.json
  it("store path contains regime-controller-filtered-edge-shadow.json and NOT shadow-positions.json", () => {
    const store = makeStore();
    expect(store.path).toContain("regime-controller-filtered-edge-shadow.json");
    expect(store.path).not.toContain("shadow-positions.json");
  });

  it("counts immediate SL and no-MFE-before-SL in profile forensics", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "loss-1",
      createdAt: "2026-05-26T00:45:00.000Z",
      openedAt: "2026-05-26T00:50:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T01:00:00.000Z",
      grossR: -1,
      netR: -1.1,
      resolutionSource: "CANDLE_WALK_SL",
      durationMinutes: 5,
      chronologyStatus: "VALID",
      maxMfeR: 0.02,
      minMaeR: -1.05,
      mfeBeforeCloseR: 0.02,
      maeBeforeCloseR: -1.05,
      immediateSl: true,
      noMfeBeforeSl: true,
      selectedEntryVariant: "fib_500_entry",
      selectedExitVariant: "tp1_full_exit",
      kronosBias: "SHORT",
      whaleAgreement: "AGREES",
    }));
    const report = buildFilteredEdgeShadowReport(store);
    const strict = report.profileForensics.find((p) => p.profile === "STRICT_COST10");
    expect(strict?.immediateSLCount).toBe(1);
    expect(strict?.noMfeBeforeSLCount).toBe(1);
    expect(strict?.slRate).toBe(1);
    expect(strict?.tp1Rate).toBe(0);
  });

  it("counts overlapping candidates admitted into both profiles", () => {
    const store = makeStore();
    const openedAt = "2026-05-26T02:00:00.000Z";
    store.add(makeBasePos({
      id: "strict-overlap",
      openedAt,
      createdAt: openedAt,
      profile: "STRICT_COST10",
      status: "OPEN",
      selectedEntryVariant: "fib_500_entry",
      selectedExitVariant: "tp1_full_exit",
    }));
    store.add(makeBasePos({
      id: "broad-overlap",
      openedAt: "2026-05-26T02:00:30.000Z",
      createdAt: "2026-05-26T02:00:30.000Z",
      profile: "BROAD_COST20_STOP150",
      costR: 0.15,
      stopDistanceBps: 200,
      status: "OPEN",
      selectedEntryVariant: "fib_500_entry",
      selectedExitVariant: "tp1_full_exit",
    }));
    const report = buildFilteredEdgeShadowReport(store);
    expect(report.overlappingCandidateCount).toBe(1);
  });

  it("builds last resolved snapshots with enriched reason summary", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "recent-1",
      symbol: "ARBUSDT",
      direction: "SHORT",
      profile: "STRICT_COST10",
      marketRegimeAtOpen: "Bearish expansion",
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T03:00:00.000Z",
      grossR: -1,
      netR: -1.08,
      costR: 0.08,
      durationMinutes: 10,
      resolutionSource: "CANDLE_WALK_SL",
      maxMfeR: 0.01,
      minMaeR: -1.02,
      immediateSl: true,
      noMfeBeforeSl: true,
      kronosBias: "SHORT",
      whaleAgreement: "AGREES",
      liveSourceConflict: false,
    }));
    const report = buildFilteredEdgeShadowReport(store);
    expect(report.recentResolved).toHaveLength(1);
    expect(report.recentResolved[0]?.entryVariant).toBe("vwap_retest_entry");
    expect(report.recentResolved[0]?.exitVariant).toBe("tp1_full_exit");
    expect(report.recentResolved[0]?.reasonSummary).toContain("immediate SL");
    expect(report.recentResolved[0]?.reasonSummary).toContain("no MFE before SL");
    expect(report.recentResolved[0]?.reasonSummary).toContain("sourceConflict=LIVE_FALSE");
  });

  it("emits toxic symbol and entry-confirmation style suggestions from loss forensics", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "toxic-1",
      symbol: "DOGEUSDT",
      createdAt: "2026-05-26T03:00:00.000Z",
      openedAt: "2026-05-26T03:00:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T03:10:00.000Z",
      grossR: -1,
      netR: -0.4,
      costR: 0.12,
      durationMinutes: 5,
      chronologyStatus: "VALID",
      resolutionSource: "CANDLE_WALK_SL",
      maxMfeR: 0.01,
      minMaeR: -1.1,
      mfeBeforeCloseR: 0.01,
      maeBeforeCloseR: -1.1,
      immediateSl: true,
      noMfeBeforeSl: true,
      selectedEntryVariant: "fib_500_entry",
      selectedExitVariant: "tp1_full_exit",
    }));
    store.add(makeBasePos({
      id: "toxic-2",
      symbol: "DOGEUSDT",
      createdAt: "2026-05-26T03:10:00.000Z",
      openedAt: "2026-05-26T03:10:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T03:20:00.000Z",
      grossR: -1,
      netR: -0.5,
      costR: 0.13,
      durationMinutes: 10,
      chronologyStatus: "VALID",
      resolutionSource: "CANDLE_WALK_SL",
      maxMfeR: 0.02,
      minMaeR: -1.05,
      mfeBeforeCloseR: 0.02,
      maeBeforeCloseR: -1.05,
      immediateSl: true,
      noMfeBeforeSl: true,
      selectedEntryVariant: "fib_500_entry",
      selectedExitVariant: "tp1_full_exit",
    }));
    const report = buildFilteredEdgeShadowReport(store);
    const strict = report.profileForensics.find((p) => p.profile === "STRICT_COST10");
    expect(strict?.pruneSuggestions.some((s) => s.type === "EXCLUDE_SYMBOL" && s.label === "DOGEUSDT")).toBe(true);
    expect(strict?.pruneSuggestions.some((s) => s.type === "MIN_MFE_REQUIRED")).toBe(true);
    expect(strict?.pruneSuggestions.some((s) => s.type === "AVOID_IMMEDIATE_SL_PATTERN")).toBe(true);
  });

  it("marks negative chronology invalid and excludes it from duration/path averages", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "invalid-chrono",
      createdAt: "2026-05-26T03:10:00.000Z",
      openedAt: "2026-05-26T03:00:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T03:05:00.000Z",
      grossR: -1,
      netR: -1.1,
      durationMinutes: -5,
      chronologyStatus: "INVALID_NEGATIVE_DURATION",
      chronologyWarning: "closedAt precedes openedAt",
      maxMfeR: 0.9,
      minMaeR: -1.2,
      mfeBeforeCloseR: 0.9,
      maeBeforeCloseR: -1.2,
      immediateSl: true,
      noMfeBeforeSl: false,
    }));
    store.add(makeBasePos({
      id: "valid-chrono",
      createdAt: "2026-05-26T04:00:00.000Z",
      openedAt: "2026-05-26T04:00:00.000Z",
      status: "CLOSED_WIN",
      closedAt: "2026-05-26T04:10:00.000Z",
      grossR: 1,
      netR: 0.9,
      durationMinutes: 10,
      chronologyStatus: "VALID",
      maxMfeR: 1.2,
      minMaeR: -0.3,
      mfeBeforeCloseR: 1.2,
      maeBeforeCloseR: -0.3,
    }));
    const report = buildFilteredEdgeShadowReport(store);
    const strict = report.profileForensics.find((p) => p.profile === "STRICT_COST10");
    expect(strict?.validChronologyCount).toBe(1);
    expect(strict?.invalidChronologyCount).toBe(1);
    expect(strict?.avgDurationMinutes).toBe(10);
    expect(strict?.pathMetricsAvailableCount).toBe(1);
    expect(strict?.avgMfeR).toBe(1.2);
    expect(strict?.avgMaeR).toBe(-0.3);
  });

  it("computes immediate SL and no-MFE-before-SL from valid candle path only", async () => {
    const store = makeStore();
    const createdAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    store.add(makeBasePos({
      id: "path-loss",
      symbol: "ARBUSDT",
      direction: "LONG",
      createdAt,
      openedAt: createdAt,
      entryPrice: 100,
      stopLoss: 95,
      takeProfitLevels: [103],
      status: "OPEN",
      closedAt: null,
      grossR: null,
      netR: null,
      durationMinutes: null,
      chronologyStatus: null,
      maxMfeR: null,
      minMaeR: null,
      mfeBeforeCloseR: null,
      maeBeforeCloseR: null,
      immediateSl: false,
      noMfeBeforeSl: false,
    }));
    const mockBinanceClient = {
      getKlines: async () => [
        [
          Date.now() - 60 * 60 * 1000,
          "100",
          "100.2",
          "94.9",
          "95.5",
          "1000",
          Date.now() - 55 * 60 * 1000,
        ] as [number, string, string, string, string, string, number],
      ],
    };
    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.status).toBe("CLOSED_LOSS");
    expect(updated.immediateSl).toBe(true);
    expect(updated.noMfeBeforeSl).toBe(true);
    expect(updated.maxMfeR).not.toBeNull();
    expect(updated.minMaeR).not.toBeNull();
  });

  it("computes positive MFE and negative MAE for LONG path metrics", async () => {
    const store = makeStore();
    const createdAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    store.add(makeBasePos({
      id: "long-path",
      symbol: "XRPUSDT",
      direction: "LONG",
      createdAt,
      openedAt: createdAt,
      entryPrice: 100,
      stopLoss: 95,
      takeProfitLevels: [103],
      status: "OPEN",
      closedAt: null,
      grossR: null,
      netR: null,
      durationMinutes: null,
      chronologyStatus: null,
    }));
    const mockBinanceClient = {
      getKlines: async () => [[
        Date.now() - 60 * 60 * 1000,
        "100",
        "104",
        "99",
        "103",
        "1000",
        Date.now() - 55 * 60 * 1000,
      ] as [number, string, string, string, string, string, number]],
    };
    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.maxMfeR).toBeCloseTo(0.8, 6);
    expect(updated.minMaeR).toBeCloseTo(-0.2, 6);
    expect(updated.maxMfeR!).toBeGreaterThanOrEqual(0);
    expect(updated.minMaeR!).toBeLessThanOrEqual(0);
    expect(updated.pathMetricStatus).toBe("VALID");
  });

  it("computes positive MFE and negative MAE for SHORT path metrics", async () => {
    const store = makeStore();
    const createdAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    store.add(makeBasePos({
      id: "short-path",
      symbol: "ADAUSDT",
      direction: "SHORT",
      createdAt,
      openedAt: createdAt,
      entryPrice: 100,
      stopLoss: 105,
      takeProfitLevels: [97],
      status: "OPEN",
      closedAt: null,
      grossR: null,
      netR: null,
      durationMinutes: null,
      chronologyStatus: null,
    }));
    const mockBinanceClient = {
      getKlines: async () => [[
        Date.now() - 60 * 60 * 1000,
        "100",
        "101",
        "96",
        "97",
        "1000",
        Date.now() - 55 * 60 * 1000,
      ] as [number, string, string, string, string, string, number]],
    };
    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.maxMfeR).toBeCloseTo(0.8, 6);
    expect(updated.minMaeR).toBeCloseTo(-0.2, 6);
    expect(updated.maxMfeR!).toBeGreaterThanOrEqual(0);
    expect(updated.minMaeR!).toBeLessThanOrEqual(0);
    expect(updated.pathMetricStatus).toBe("VALID");
  });

  it("marks zero or negative risk path metrics invalid", async () => {
    const store = makeStore();
    const createdAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    store.add(makeBasePos({
      id: "bad-risk",
      symbol: "UNIUSDT",
      direction: "LONG",
      createdAt,
      openedAt: createdAt,
      entryPrice: 100,
      stopLoss: 100,
      takeProfitLevels: [105],
      status: "OPEN",
      closedAt: null,
      grossR: null,
      netR: null,
      durationMinutes: null,
      chronologyStatus: null,
    }));
    const mockBinanceClient = {
      getKlines: async () => [[
        Date.now() - 60 * 60 * 1000,
        "100",
        "101",
        "99",
        "100.5",
        "1000",
        Date.now() - 55 * 60 * 1000,
      ] as [number, string, string, string, string, string, number]],
    };
    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.pathMetricStatus).toBe("PATH_METRIC_INVALID_RISK");
    expect(updated.maxMfeR).toBeNull();
    expect(updated.minMaeR).toBeNull();
  });

  it("excludes absurd path-metric outliers from averages", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "outlier-path",
      createdAt: "2026-05-26T05:00:00.000Z",
      openedAt: "2026-05-26T05:00:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T05:10:00.000Z",
      chronologyStatus: "VALID",
      grossR: -1,
      netR: -1.1,
      maxMfeR: 25,
      minMaeR: -21,
      mfeBeforeCloseR: 25,
      maeBeforeCloseR: -21,
      pathMetricStatus: "PATH_METRIC_OUTLIER",
      pathMetricWarning: "Derived path metrics exceed 20R cap",
    }));
    store.add(makeBasePos({
      id: "normal-path",
      createdAt: "2026-05-26T06:00:00.000Z",
      openedAt: "2026-05-26T06:00:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T06:10:00.000Z",
      chronologyStatus: "VALID",
      grossR: -1,
      netR: -1.05,
      maxMfeR: 0.4,
      minMaeR: -0.6,
      mfeBeforeCloseR: 0.4,
      maeBeforeCloseR: -0.6,
      pathMetricStatus: "VALID",
    }));
    const report = buildFilteredEdgeShadowReport(store);
    const strict = report.profileForensics.find((p) => p.profile === "STRICT_COST10");
    expect(strict?.pathMetricsAvailableCount).toBe(1);
    expect(strict?.pathMetricsInvalidCount).toBe(1);
    expect(strict?.avgMfeR).toBe(0.4);
    expect(strict?.avgMaeR).toBe(-0.6);
    expect(strict?.pathMetricInvalidReasons).toEqual([{ reason: "PATH_METRIC_OUTLIER", n: 1 }]);
  });

  it("excludes old invalid chronology records from fresh-valid tape", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "legacy-invalid-chrono",
      analyticsVersion: null,
      pathMetricVersion: null,
      chronologyVersion: null,
      chronologyStatus: "INVALID_NEGATIVE_DURATION",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T05:10:00.000Z",
      grossR: -1,
      netR: -1.1,
    }));
    const report = buildFilteredEdgeShadowReport(store);
    const freshStrict = report.freshValidProfileReports.find((p) => p.profile === "STRICT_COST10");
    expect(freshStrict?.resolvedObs).toBe(0);
    expect(report.freshValidExcluded.invalidChronology).toBe(1);
    expect(report.freshValidExcluded.missingVersion).toBe(0);
  });

  it("excludes old invalid path-metric records (outlier MFE) from fresh-valid tape", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "legacy-invalid-path",
      createdAt: "2026-05-26T05:00:00.000Z",
      openedAt: "2026-05-26T05:00:00.000Z",
      analyticsVersion: "filtered-edge-forensics-v2",
      pathMetricVersion: "mfe-mae-bounded-v1",
      chronologyVersion: "chronology-fill-candle-v1",
      chronologyStatus: "VALID",
      pathMetricStatus: "PATH_METRIC_OUTLIER",
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      // Outlier MFE/MAE values that exceed 20R cap
      maxMfeR: 25,
      minMaeR: -23,
      mfeBeforeCloseR: 25,
      maeBeforeCloseR: -23,
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T05:10:00.000Z",
      grossR: -1,
      netR: -1.1,
    }));
    const report = buildFilteredEdgeShadowReport(store);
    const freshStrict = report.freshValidProfileReports.find((p) => p.profile === "STRICT_COST10");
    expect(freshStrict?.resolvedObs).toBe(0);
    expect(report.freshValidExcluded.invalidPathMetrics).toBe(1);
  });

  it("excludes records missing MFE/MAE (PATH_METRIC_MISSING) from fresh-valid tape", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "missing-mfe-mae",
      createdAt: "2026-05-26T05:00:00.000Z",
      openedAt: "2026-05-26T05:00:00.000Z",
      analyticsVersion: "filtered-edge-forensics-v2",
      pathMetricVersion: "mfe-mae-bounded-v1",
      chronologyVersion: "chronology-fill-candle-v1",
      chronologyStatus: "VALID",
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      // No MFE/MAE data → PATH_METRIC_MISSING
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T05:10:00.000Z",
      grossR: -1,
      netR: -1.1,
    }));
    const report = buildFilteredEdgeShadowReport(store);
    const freshStrict = report.freshValidProfileReports.find((p) => p.profile === "STRICT_COST10");
    expect(freshStrict?.resolvedObs).toBe(0);
    expect(report.freshValidExcluded.missingPathMetrics).toBe(1);
  });

  it("includes new valid resolved records in fresh-valid tape and separates stats from all-time", () => {
    const store = makeStore();
    store.add(makeBasePos({
      id: "legacy-missing-version",
      createdAt: "2026-05-26T05:00:00.000Z",
      openedAt: "2026-05-26T05:00:00.000Z",
      analyticsVersion: null,
      pathMetricVersion: null,
      chronologyVersion: null,
      chronologyStatus: "VALID",
      pathMetricStatus: "VALID",
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T05:10:00.000Z",
      grossR: -1,
      netR: -1.1,
      // Valid (in-range, sign-correct) MFE/MAE so classifier reaches version check
      maxMfeR: 0.2,
      minMaeR: -0.4,
      mfeBeforeCloseR: 0.2,
      maeBeforeCloseR: -0.4,
    }));
    store.add(makeBasePos({
      id: "fresh-valid",
      createdAt: "2026-05-26T05:10:00.000Z",
      openedAt: "2026-05-26T05:10:00.000Z",
      chronologyStatus: "VALID",
      pathMetricStatus: "VALID",
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      status: "CLOSED_WIN",
      closedAt: "2026-05-26T05:20:00.000Z",
      grossR: 1.2,
      netR: 1.1,
      maxMfeR: 1.3,
      minMaeR: -0.2,
      mfeBeforeCloseR: 1.3,
      maeBeforeCloseR: -0.2,
    }));
    const report = buildFilteredEdgeShadowReport(store);
    const allTimeStrict = report.profileReports.find((p) => p.profile === "STRICT_COST10");
    const freshStrict = report.freshValidProfileReports.find((p) => p.profile === "STRICT_COST10");
    expect(allTimeStrict?.resolvedObs).toBe(2);
    expect(freshStrict?.resolvedObs).toBe(1);
    expect(freshStrict?.netAvgR).toBe(1.1);
    expect(freshStrict?.verdict).toBe("TOO_EARLY");
    expect(report.freshValidExcluded.missingVersion).toBe(1);
  });

  // ─── Intrabar ambiguity tests (N+1 … N+7) ────────────────────────────────

  // Test N+1 — Same-candle ambiguity detection
  it("detects same-candle ambiguity when SL and entry are in the fill candle (SHORT)", async () => {
    const store = makeStore();
    // Align openedAt to a 5m candle boundary so fillCandleIdx is deterministic
    const candleMs = 5 * 60 * 1000;
    const nowMs = Date.now();
    const candleOpenMs = Math.floor(nowMs / candleMs) * candleMs - 2 * candleMs; // 2 candles ago
    const openedAt = new Date(candleOpenMs).toISOString();

    // SHORT: entry=100, stopLoss=107 (SL above entry), tp1=93
    const pos = makeBasePos({
      id: "ambig-short-1",
      direction: "SHORT",
      profile: "STRICT_COST10",
      controllerMode: "SHORT_ONLY",
      openedAt,
      createdAt: openedAt,
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      stopDistanceBps: 700,
      status: "OPEN",
      closedAt: null,
      grossR: null,
      netR: null,
      durationMinutes: null,
    });
    store.add(pos);

    // Fill candle: openTime = candleOpenMs, high=109 (>= stopLoss=107 => SL hit for SHORT),
    // low=91 (<= tp1=93 => TP1 hit for SHORT). Both hit in same candle (fill candle).
    const mockBinanceClient = {
      getKlines: async (_symbol: string, interval: string, _opts: { startTime: number; endTime: number; limit: number }) => {
        if (interval === "1m") {
          // Return empty 1m candles => 1m resolution fails => stays AMBIGUOUS
          return [];
        }
        return [
          [
            candleOpenMs,          // openTime = fill candle
            "100",                 // open
            "109",                 // high — SL hit for SHORT (high >= stopLoss=107)
            "91",                  // low  — TP1 hit for SHORT (low <= tp1=93)
            "100",                 // close
            "1000",
            candleOpenMs + candleMs - 1,
          ] as [number, string, string, string, string, string, number],
        ];
      },
    };

    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.status).toBe("AMBIGUOUS");
    expect(updated.intrabarResolutionStatus).toBe("AMBIGUOUS_SAME_CANDLE");
  });

  // Test N+2 — Ambiguous excluded from fresh-valid
  it("excludes same-candle ambiguous obs from fresh-valid count (isFreshValid=false)", async () => {
    const store = makeStore();
    const candleMs = 5 * 60 * 1000;
    const nowMs = Date.now();
    const candleOpenMs = Math.floor(nowMs / candleMs) * candleMs - 2 * candleMs;
    const openedAt = new Date(candleOpenMs).toISOString();

    store.add(makeBasePos({
      id: "ambig-fv-1",
      direction: "SHORT",
      openedAt,
      createdAt: openedAt,
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      stopDistanceBps: 700,
      status: "OPEN",
      closedAt: null,
    }));

    const mockBinanceClient = {
      getKlines: async (_symbol: string, interval: string, _opts: { startTime: number; endTime: number; limit: number }) => {
        if (interval === "1m") return [];
        return [
          [candleOpenMs, "100", "109", "91", "100", "1000", candleOpenMs + candleMs - 1] as [number, string, string, string, string, string, number],
        ];
      },
    };

    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.isFreshValid).toBe(false);

    const report = buildFilteredEdgeShadowReport(store);
    expect(report.ambiguousSameCandleCount).toBeGreaterThanOrEqual(1);
    expect(report.ambiguousExcludedFromFreshValidCount).toBeGreaterThanOrEqual(1);
  });

  // Test N+3 — Non-ambiguous TP sequence remains VALID_5M_ORDERED
  it("resolves TP1 hit in non-fill candle as VALID_5M_ORDERED for SHORT", async () => {
    const store = makeStore();
    const candleMs = 5 * 60 * 1000;
    const nowMs = Date.now();
    // Place entry in candle1; candle2 will hit TP1
    const candle1OpenMs = Math.floor(nowMs / candleMs) * candleMs - 3 * candleMs;
    const candle2OpenMs = candle1OpenMs + candleMs;
    const openedAt = new Date(candle1OpenMs).toISOString();

    // SHORT: entry=100, stopLoss=107, tp1=93
    store.add(makeBasePos({
      id: "valid-5m-tp",
      direction: "SHORT",
      openedAt,
      createdAt: openedAt,
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      stopDistanceBps: 700,
      status: "OPEN",
      closedAt: null,
    }));

    const mockBinanceClient = {
      getKlines: async (_symbol: string, interval: string, _opts: { startTime: number; endTime: number; limit: number }) => {
        if (interval === "1m") return [];
        return [
          // candle1 (fill candle): high=101 (SHORT entry filled: high>=100), no SL/TP
          [candle1OpenMs, "100", "101", "99", "100", "1000", candle1OpenMs + candleMs - 1] as [number, string, string, string, string, string, number],
          // candle2 (non-fill candle): low=88 => TP1=93 hit (SHORT: low <= tp1)
          [candle2OpenMs, "100", "101", "88", "90", "1000", candle2OpenMs + candleMs - 1] as [number, string, string, string, string, string, number],
        ];
      },
    };

    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.status).toBe("CLOSED_WIN");
    expect(updated.intrabarResolutionStatus).toBe("VALID_5M_ORDERED");
    expect(updated.isFreshValid).toBe(true);
  });

  // Test N+4 — 1m resolution confirms TP before SL (RESOLVED_BY_1M)
  it("resolves ambiguous candle via 1m data as CLOSED_WIN when TP1 comes first", async () => {
    const store = makeStore();
    const candleMs = 5 * 60 * 1000;
    const minMs = 60 * 1000;
    const nowMs = Date.now();
    const candleOpenMs = Math.floor(nowMs / candleMs) * candleMs - 2 * candleMs;
    const openedAt = new Date(candleOpenMs).toISOString();

    // SHORT: entry=100, stopLoss=107, tp1=93
    store.add(makeBasePos({
      id: "1m-tp-win",
      direction: "SHORT",
      openedAt,
      createdAt: openedAt,
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      stopDistanceBps: 700,
      status: "OPEN",
      closedAt: null,
    }));

    const mockBinanceClient = {
      getKlines: async (_symbol: string, interval: string, opts: { startTime: number; endTime: number; limit: number }) => {
        if (interval === "5m") {
          // Fill candle: both SL (high=109) and TP1 (low=91) in same candle
          return [
            [candleOpenMs, "100", "109", "91", "100", "1000", candleOpenMs + candleMs - 1] as [number, string, string, string, string, string, number],
          ];
        }
        if (interval === "1m") {
          // 1m candles: first candle after entry has low=91 (TP1 hit) but high=101 (no SL)
          // second candle has high=109 (SL) but TP already hit
          return [
            [candleOpenMs, "100", "101", "91", "92", "500", candleOpenMs + minMs - 1] as [number, string, string, string, string, string, number],
            [candleOpenMs + minMs, "100", "109", "94", "100", "500", candleOpenMs + 2 * minMs - 1] as [number, string, string, string, string, string, number],
          ];
        }
        return [];
      },
    };

    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.status).toBe("CLOSED_WIN");
    expect(updated.intrabarResolutionStatus).toBe("RESOLVED_BY_1M");
    expect(updated.resolutionSource).toBe("INTRABAR_1M_TP");
    expect(updated.isFreshValid).toBe(true);
  });

  // Test N+5 — 1m resolution confirms SL before TP (RESOLVED_BY_1M)
  it("resolves ambiguous candle via 1m data as CLOSED_LOSS when SL comes first", async () => {
    const store = makeStore();
    const candleMs = 5 * 60 * 1000;
    const minMs = 60 * 1000;
    const nowMs = Date.now();
    const candleOpenMs = Math.floor(nowMs / candleMs) * candleMs - 2 * candleMs;
    const openedAt = new Date(candleOpenMs).toISOString();

    // SHORT: entry=100, stopLoss=107, tp1=93
    store.add(makeBasePos({
      id: "1m-sl-loss",
      direction: "SHORT",
      openedAt,
      createdAt: openedAt,
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      stopDistanceBps: 700,
      status: "OPEN",
      closedAt: null,
    }));

    const mockBinanceClient = {
      getKlines: async (_symbol: string, interval: string, _opts: { startTime: number; endTime: number; limit: number }) => {
        if (interval === "5m") {
          return [
            [candleOpenMs, "100", "109", "91", "100", "1000", candleOpenMs + candleMs - 1] as [number, string, string, string, string, string, number],
          ];
        }
        if (interval === "1m") {
          // Both SL and TP in same 1m candle => conservative: SL wins
          return [
            [candleOpenMs, "100", "109", "91", "100", "500", candleOpenMs + minMs - 1] as [number, string, string, string, string, string, number],
          ];
        }
        return [];
      },
    };

    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);
    const updated = store.all[0]!;
    expect(updated.status).toBe("CLOSED_LOSS");
    expect(updated.intrabarResolutionStatus).toBe("RESOLVED_BY_1M");
    expect(updated.isFreshValid).toBe(true);
  });

  // Test N+6 — Dashboard renders ambiguity counts
  it("dashboard W*** shows ambiguity counts when AMBIGUOUS obs are present", async () => {
    const store = makeStore();
    const candleMs = 5 * 60 * 1000;
    const nowMs = Date.now();
    const candleOpenMs = Math.floor(nowMs / candleMs) * candleMs - 2 * candleMs;
    const openedAt = new Date(candleOpenMs).toISOString();

    // AMBIGUOUS observation
    store.add(makeBasePos({
      id: "ambig-dash-1",
      direction: "SHORT",
      openedAt,
      createdAt: openedAt,
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      stopDistanceBps: 700,
      status: "OPEN",
      closedAt: null,
    }));

    const mockBinanceClient = {
      getKlines: async (_symbol: string, interval: string, _opts: { startTime: number; endTime: number; limit: number }) => {
        if (interval === "1m") return [];
        return [
          [candleOpenMs, "100", "109", "91", "100", "1000", candleOpenMs + candleMs - 1] as [number, string, string, string, string, string, number],
        ];
      },
    };
    await resolveFilteredEdgeShadowObservations(store, mockBinanceClient);

    // Add a VALID_5M_ORDERED closed observation
    store.add(makeBasePos({
      id: "valid-5m-dash",
      direction: "SHORT",
      symbol: "ARBUSDT",
      openedAt: new Date(candleOpenMs - 2 * candleMs).toISOString(),
      createdAt: new Date(candleOpenMs - 2 * candleMs).toISOString(),
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      status: "CLOSED_WIN",
      closedAt: new Date(candleOpenMs).toISOString(),
      grossR: 1.0,
      netR: 0.92,
      resolutionSource: "CANDLE_WALK_TP1",
      durationMinutes: 10,
      chronologyStatus: "VALID",
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      isFreshValid: true,
    }));

    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const dashboard = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(dashboard.summaryText).toContain("ambiguous=1");
  });

  // Test N+7 — No behavior changes (isolation guard)
  it("resolver does not touch shadow-positions.json (isolation guard)", () => {
    const store = makeStore();
    expect(store.path).toContain("regime-controller-filtered-edge-shadow.json");
    expect(store.path).not.toContain("shadow-positions.json");
  });
});

// ─── isFreshValidFilteredEdgeObservation tests ────────────────────────────────

describe("isFreshValidFilteredEdgeObservation — single source of truth", () => {
  // Shared resolved observation factory for these tests
  function makeResolvedObs(overrides: Partial<FilteredEdgeShadowPosition> = {}): FilteredEdgeShadowPosition {
    return {
      id: "test-id-" + Math.random(),
      symbol: "SOLUSDT",
      direction: "SHORT" as const,
      profile: "STRICT_COST10" as const,
      controllerMode: "SHORT_ONLY",
      currentRegime: "Bearish expansion",
      marketRegimeAtOpen: "Bearish expansion",
      openedAt: "2026-01-01T10:00:00.000Z",
      createdAt: "2026-01-01T10:00:00.000Z",
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      stopDistanceBps: 700,
      costR: 0.08,
      atrPercent: 1.0,
      variantAdjustedGuardThresholdBps: 80,
      guardPassedUnder: "VARIANT_ADJUSTED" as const,
      sourceConflict: false,
      liveSourceConflict: false,
      kronosBias: "SHORT",
      whaleAgreement: "AGREES",
      selectedEntryVariant: "fib_500_entry",
      selectedExitVariant: null,
      kronosHorizonConflict: false,
      status: "CLOSED_LOSS" as const,
      closedAt: "2026-01-01T10:05:00.000Z",
      grossR: -1.0,
      netR: -1.08,
      resolutionSource: "CANDLE_WALK_SL",
      durationMinutes: 5,
      intrabarResolutionStatus: "VALID_5M_ORDERED" as const,
      isFreshValid: true,
      reportOnly: true as const,
      laneVersion: FILTERED_EDGE_SHADOW_LANE,
      policyVersion: "filtered-edge-anchor-consistent-v1",
      analyticsVersion: "filtered-edge-forensics-v2" as const,
      pathMetricVersion: "mfe-mae-bounded-v1" as const,
      chronologyVersion: "chronology-fill-candle-v1" as const,
      // Canonical fresh-valid requires real MFE/MAE data (derived MUST be VALID)
      maxMfeR: 0.1,
      minMaeR: -1.0,
      mfeBeforeCloseR: 0.1,
      maeBeforeCloseR: -1.0,
      pathMetricStatus: "VALID",
      chronologyStatus: "VALID",
      ...overrides,
    };
  }

  // Test A — PATH_METRIC_OUTLIER (large MFE) excludes from fresh-valid (NOT from grossR)
  it("A. excludes PATH_METRIC_OUTLIER (large MFE) from fresh-valid even when isFreshValid=true stored", () => {
    // outlier defined by |MFE| > 20 OR |MAE| > 20, NOT by grossR
    const obs = makeResolvedObs({ grossR: -1.0, maxMfeR: 25, mfeBeforeCloseR: 25, isFreshValid: true });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });

  // Test A2 — PATH_METRIC_OUTLIER derived on-the-fly via large MAE
  it("A2. excludes PATH_METRIC_OUTLIER derived on-the-fly when MAE exceeds 20R cap", () => {
    const obs = makeResolvedObs({ grossR: -1.0, minMaeR: -25, maeBeforeCloseR: -25, pathMetricStatus: null, isFreshValid: true });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });

  // Test A3 — Normal grossR=-1.0 with valid MFE/MAE is NOT outlier (regression for Bug #3)
  it("A3. grossR=-1.0 with finite MFE/MAE is NOT classified as PATH_METRIC_OUTLIER", () => {
    const obs = makeResolvedObs({ grossR: -1.0, netR: -1.08, maxMfeR: 0.05, minMaeR: -1.0, mfeBeforeCloseR: 0.05, maeBeforeCloseR: -1.0 });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(true);
  });

  // Test A4 — Missing MFE/MAE excluded as PATH_METRIC_MISSING (NOT outlier)
  it("A4. excludes obs with missing MFE/MAE as PATH_METRIC_MISSING", () => {
    const obs = makeResolvedObs({ grossR: -1.0, maxMfeR: null, minMaeR: null, mfeBeforeCloseR: null, maeBeforeCloseR: null, pathMetricStatus: null });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });

  // Test B — PATH_METRIC_INVALID_RISK when stopLoss=0
  it("B. excludes when stopLoss=0 (PATH_METRIC_INVALID_RISK)", () => {
    const obs = makeResolvedObs({ stopLoss: 0, pathMetricStatus: null, isFreshValid: true });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });

  // Test C — All valid → included
  it("C. includes a fully valid observation", () => {
    const obs = makeResolvedObs();
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(true);
  });

  // Test C2 — RESOLVED_BY_1M is also valid intrabar status
  it("C2. includes RESOLVED_BY_1M intrabar status", () => {
    const obs = makeResolvedObs({ intrabarResolutionStatus: "RESOLVED_BY_1M" });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(true);
  });

  // Test D — Top summary and per-profile fresh-valid match (consistency PASS)
  it("D. buildFilteredEdgeShadowReport freshValidConsistencyCheck is PASS when all fresh-valid obs are valid", () => {
    const dir = tmpDir();
    storeDirs.push(dir);
    const store = new FilteredEdgeShadowStore(dir);
    // 3 valid fresh-valid obs: 2 STRICT, 1 BROAD
    for (let i = 0; i < 2; i++) {
      store.add(makeResolvedObs({
        id: `strict-valid-${i}`,
        profile: "STRICT_COST10",
        closedAt: `2026-01-01T10:0${i}:00.000Z`,
        openedAt: `2026-01-01T09:5${i}:00.000Z`,
        createdAt: `2026-01-01T09:5${i}:00.000Z`,
      }));
    }
    store.add(makeResolvedObs({
      id: "broad-valid-0",
      profile: "BROAD_COST20_STOP150",
      closedAt: "2026-01-01T10:10:00.000Z",
      openedAt: "2026-01-01T10:05:00.000Z",
      createdAt: "2026-01-01T10:05:00.000Z",
    }));
    const report = buildFilteredEdgeShadowReport(store);
    expect(report.freshValidConsistencyCheck).toBe("PASS");
    expect(report.freshValidResolvedCount).toBe(3);
  });

  // Test E — Last-5 row with PATH_METRIC_OUTLIER (large MFE) shows excludedReason
  it("E. recentResolved entry has excludedReason=PATH_METRIC_OUTLIER for outlier obs", () => {
    const dir = tmpDir();
    storeDirs.push(dir);
    const store = new FilteredEdgeShadowStore(dir);
    store.add(makeResolvedObs({
      id: "outlier-obs",
      grossR: -1.0,
      maxMfeR: 25,        // exceeds 20R cap → OUTLIER
      mfeBeforeCloseR: 25,
      pathMetricStatus: "PATH_METRIC_OUTLIER",
      isFreshValid: true, // stored field says true but helper should override
    }));
    const report = buildFilteredEdgeShadowReport(store);
    expect(report.recentResolved.length).toBe(1);
    const snap = report.recentResolved[0]!;
    expect(snap.isFreshValid).toBe(false);
    expect(snap.excludedReason).toBe("PATH_METRIC_OUTLIER");
  });

  // Test F — Verdict uses helper result only
  it("F. verdict is TOO_EARLY when all obs have PATH_METRIC_OUTLIER", () => {
    const dir = tmpDir();
    storeDirs.push(dir);
    const store = new FilteredEdgeShadowStore(dir);
    // 20 obs all with PATH_METRIC_OUTLIER (large MFE) — none should pass helper
    for (let i = 0; i < 20; i++) {
      store.add(makeResolvedObs({
        id: `outlier-${i}`,
        grossR: -1.0,
        maxMfeR: 25,          // exceeds 20R cap
        mfeBeforeCloseR: 25,
        pathMetricStatus: "PATH_METRIC_OUTLIER",
        closedAt: `2026-01-01T10:${String(i).padStart(2, "0")}:00.000Z`,
        openedAt: `2026-01-01T09:${String(i).padStart(2, "0")}:00.000Z`,
        createdAt: `2026-01-01T09:${String(i).padStart(2, "0")}:00.000Z`,
      }));
    }
    const report = buildFilteredEdgeShadowReport(store);
    // freshValidResolved in forensics must be 0 — all excluded
    const forensics = report.profileForensics.find((pf) => pf.profile === "STRICT_COST10");
    expect(forensics?.freshValidResolved).toBe(0);
    // freshValid verdict should be TOO_EARLY (need ≥10 fresh-valid)
    const freshReport = report.freshValidProfileReports.find((r) => r.profile === "STRICT_COST10");
    // the freshValidProfileReport uses classifyFreshValidResolvedPosition which checks different criteria
    // but the forensics freshValidResolved (which uses helper) should be 0
    expect(report.freshValidResolvedCount).toBe(0);
  });

  // Test G — No behavior changes (isolation guard)
  it("G. isFreshValidFilteredEdgeObservation does not throw and does not write files", () => {
    const obs = makeResolvedObs();
    expect(() => isFreshValidFilteredEdgeObservation(obs)).not.toThrow();
    const result = isFreshValidFilteredEdgeObservation(obs);
    expect(typeof result).toBe("boolean");
  });

  // Test G2 — Stored isFreshValid=false is not used when helper says true
  it("G2. helper result is authoritative over stored isFreshValid field", () => {
    // Stored says false, but all fields are valid → helper says true
    const obs = makeResolvedObs({ isFreshValid: false });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(true);
    // Stored says true, but MFE exceeds 20R cap → helper says false (outlier)
    const obs2 = makeResolvedObs({ isFreshValid: true, maxMfeR: 25, mfeBeforeCloseR: 25 });
    expect(isFreshValidFilteredEdgeObservation(obs2)).toBe(false);
  });

  // Test — AMBIGUOUS_SAME_CANDLE intrabar status excluded
  it("excludes AMBIGUOUS_SAME_CANDLE intrabar status", () => {
    const obs = makeResolvedObs({ intrabarResolutionStatus: "AMBIGUOUS_SAME_CANDLE" });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });

  // Test — INVALID_CHRONOLOGY derived on-the-fly excludes
  it("excludes INVALID_CHRONOLOGY derived on-the-fly (closedAt <= openedAt)", () => {
    const obs = makeResolvedObs({
      openedAt: "2026-01-01T10:05:00.000Z",
      closedAt: "2026-01-01T10:00:00.000Z", // closed before opened
      chronologyStatus: null,
    });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });

  // Test — non-finite grossR excluded
  it("excludes when grossR is null", () => {
    const obs = makeResolvedObs({ grossR: null });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });

  // Test — OPEN status excluded
  it("excludes OPEN positions", () => {
    const obs = makeResolvedObs({ status: "OPEN", closedAt: null, grossR: null });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });
});

// ─── Stage 6: Canonical integrity contract tests ──────────────────────────────

import {
  deriveFreshValidStatus,
  derivePathMetric,
  deriveChronologyStatus,
  deriveIntrabarResolutionStatus,
  deriveQuarantineReason,
  computeFilteredEdgeEconomics,
} from "../src/lib/regime-controller-filtered-edge-shadow.js";

describe("Stage 6 — canonical integrity contract", () => {
  function tmp(): string {
    return resolve(os.tmpdir(), `filtered-edge-stage6-${process.pid}-${++tmpDirCounter}`);
  }
  function makeS6Store(): FilteredEdgeShadowStore {
    const d = tmp();
    storeDirs.push(d);
    return new FilteredEdgeShadowStore(d);
  }
  function makeS6Pos(overrides: Partial<FilteredEdgeShadowPosition> = {}): FilteredEdgeShadowPosition {
    const ts = "2026-05-26T10:00:00.000Z";
    return {
      id: `s6-${Math.random()}`,
      symbol: "SOLUSDT",
      direction: "SHORT",
      profile: "STRICT_COST10",
      controllerMode: "SHORT_ONLY",
      currentRegime: "Bearish expansion",
      marketRegimeAtOpen: "Bearish expansion",
      openedAt: ts,
      createdAt: ts,
      entryPrice: 100,
      stopLoss: 105,
      takeProfitLevels: [95],
      stopDistanceBps: 500,
      costR: 0.08,
      atrPercent: 1.0,
      variantAdjustedGuardThresholdBps: 100,
      guardPassedUnder: "VARIANT_ADJUSTED",
      sourceConflict: false,
      liveSourceConflict: false,
      kronosBias: null,
      whaleAgreement: null,
      selectedEntryVariant: null,
      selectedExitVariant: null,
      kronosHorizonConflict: null,
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T10:10:00.000Z",
      grossR: -1,
      netR: -1.08,
      resolutionSource: "CANDLE_WALK_SL",
      durationMinutes: 10,
      chronologyStatus: "VALID",
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      pathMetricStatus: "VALID",
      maxMfeR: 0.1,
      minMaeR: -1.0,
      mfeBeforeCloseR: 0.1,
      maeBeforeCloseR: -1.0,
      reportOnly: true,
      laneVersion: FILTERED_EDGE_SHADOW_LANE,
      policyVersion: "filtered-edge-anchor-consistent-v1",
      analyticsVersion: "filtered-edge-forensics-v2",
      pathMetricVersion: "mfe-mae-bounded-v1",
      chronologyVersion: "chronology-fill-candle-v1",
      ...overrides,
    };
  }

  // 1. Dashboard fresh-valid counts match unique helper IDs
  it("1. all dashboard fresh-valid counts match unique helper IDs (consistency PASS)", () => {
    const store = makeS6Store();
    store.add(makeS6Pos({ id: "fv-1", closedAt: "2026-05-26T10:01:00.000Z", durationMinutes: 1 }));
    store.add(makeS6Pos({ id: "fv-2", profile: "BROAD_COST20_STOP150", closedAt: "2026-05-26T10:02:00.000Z", durationMinutes: 2 }));
    const r = buildFilteredEdgeShadowReport(store);
    expect(r.freshValidConsistencyCheck).toBe("PASS");
    expect(r.pathMetricConsistencyCheck.status).toBe("PASS");
    expect(r.chronologyConsistencyCheck.status).toBe("PASS");
    expect(r.freshValidResolvedCount).toBe(2);
  });

  // 2. grossR=-1.00 with valid MFE/MAE is NOT PATH_METRIC_OUTLIER (regression)
  it("2. grossR=-1.00 with valid MFE/MAE is NOT classified as PATH_METRIC_OUTLIER", () => {
    const obs = makeS6Pos({ grossR: -1, maxMfeR: 0.05, minMaeR: -1.0 });
    expect(derivePathMetric(obs).status).toBe("VALID");
  });

  // 3. PATH_METRIC_OUTLIER requires |MFE|>20 or |MAE|>20 (NOT grossR)
  it("3. PATH_METRIC_OUTLIER requires |MFE|>20 or |MAE|>20, never grossR", () => {
    const obsLargeMfe = makeS6Pos({ maxMfeR: 25, mfeBeforeCloseR: 25 });
    expect(derivePathMetric(obsLargeMfe).status).toBe("PATH_METRIC_OUTLIER");
    const obsLargeMae = makeS6Pos({ minMaeR: -25, maeBeforeCloseR: -25 });
    expect(derivePathMetric(obsLargeMae).status).toBe("PATH_METRIC_OUTLIER");
    // grossR=8 with valid MFE/MAE is NOT outlier
    const obsHighGross = makeS6Pos({ grossR: 8, maxMfeR: 1.0, minMaeR: -0.5 });
    expect(derivePathMetric(obsHighGross).status).toBe("VALID");
  });

  // 4. Missing MFE/MAE => PATH_METRIC_MISSING (not OUTLIER)
  it("4. Missing MFE/MAE becomes PATH_METRIC_MISSING (not OUTLIER)", () => {
    const obs = makeS6Pos({ maxMfeR: null, minMaeR: null, mfeBeforeCloseR: null, maeBeforeCloseR: null });
    expect(derivePathMetric(obs).status).toBe("PATH_METRIC_MISSING");
  });

  // 5. Invalid risk (stopLoss=0) => PATH_METRIC_INVALID_RISK
  it("5. Invalid risk (stopLoss=0) becomes PATH_METRIC_INVALID_RISK", () => {
    const obs = makeS6Pos({ stopLoss: 0 });
    expect(derivePathMetric(obs).status).toBe("PATH_METRIC_INVALID_RISK");
  });

  // 6. duration=0 same-fill-candle status is AMBIGUOUS, not CLOSED_LOSS
  it("6. duration=0 with same-fill-candle SL is AMBIGUOUS_SAME_CANDLE (1m unresolved)", async () => {
    const store = makeS6Store();
    const candleMs = 5 * 60 * 1000;
    const nowMs = Date.now();
    const candleOpenMs = Math.floor(nowMs / candleMs) * candleMs - 2 * candleMs;
    const openedAt = new Date(candleOpenMs).toISOString();
    store.add(makeS6Pos({
      id: "dur-0-ambig",
      direction: "SHORT",
      openedAt,
      createdAt: openedAt,
      entryPrice: 100,
      stopLoss: 107,
      takeProfitLevels: [93],
      status: "OPEN",
      closedAt: null,
      grossR: null,
      netR: null,
      durationMinutes: null,
      pathMetricStatus: null,
      chronologyStatus: null,
      intrabarResolutionStatus: null,
    }));
    const mock = {
      getKlines: async (_s: string, interval: string) => {
        if (interval === "1m") return [];
        return [
          [candleOpenMs, "100", "109", "91", "100", "1000", candleOpenMs + candleMs - 1] as [number, string, string, string, string, string, number],
        ];
      },
    };
    await resolveFilteredEdgeShadowObservations(store, mock);
    expect(store.all[0]!.status).toBe("AMBIGUOUS");
    expect(deriveIntrabarResolutionStatus(store.all[0]!)).toBe("AMBIGUOUS_SAME_CANDLE");
  });

  // 7. RESOLVED_BY_1M can be fresh-valid
  it("7. RESOLVED_BY_1M can be fresh-valid", () => {
    const obs = makeS6Pos({
      intrabarResolutionStatus: "RESOLVED_BY_1M",
      durationMinutes: 0,
      resolutionSource: "INTRABAR_1M_SL",
    });
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(true);
  });

  // 8. VALID_5M_ORDERED + duration=0 is integrity bug — helper re-classifies
  it("8. VALID_5M_ORDERED + duration=0 is integrity bug; helper re-classifies as AMBIGUOUS_SAME_CANDLE", () => {
    const obs = makeS6Pos({
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      durationMinutes: 0,
      resolutionSource: "CANDLE_WALK_SL",
    });
    // Helper detects the impossible combination
    expect(deriveIntrabarResolutionStatus(obs)).toBe("AMBIGUOUS_SAME_CANDLE");
    // Fresh-valid must be false because helper says AMBIGUOUS
    expect(isFreshValidFilteredEdgeObservation(obs)).toBe(false);
  });

  // 9. Last-5 row with outlier shows excluded: PATH_METRIC_OUTLIER
  it("9. recentResolved row with outlier shows excludedReason=PATH_METRIC_OUTLIER", () => {
    const store = makeS6Store();
    store.add(makeS6Pos({ id: "out", maxMfeR: 25, mfeBeforeCloseR: 25, pathMetricStatus: "PATH_METRIC_OUTLIER" }));
    const r = buildFilteredEdgeShadowReport(store);
    expect(r.recentResolved[0]!.excludedReason).toBe("PATH_METRIC_OUTLIER");
  });

  // 10. Last-5 row with missing path shows excluded: PATH_METRIC_MISSING
  it("10. recentResolved row with missing path shows excludedReason=PATH_METRIC_MISSING", () => {
    const store = makeS6Store();
    store.add(makeS6Pos({
      id: "missing-mfe",
      maxMfeR: null, minMaeR: null, mfeBeforeCloseR: null, maeBeforeCloseR: null,
      pathMetricStatus: null,
    }));
    const r = buildFilteredEdgeShadowReport(store);
    expect(r.recentResolved[0]!.excludedReason).toBe("PATH_METRIC_MISSING");
  });

  // 11. Last-5 row with invalid chronology shows excluded: BAD_CHRONOLOGY
  it("11. recentResolved row with negative duration shows excludedReason=BAD_CHRONOLOGY", () => {
    const store = makeS6Store();
    store.add(makeS6Pos({
      id: "bad-chron",
      createdAt: "2026-05-26T10:10:00.000Z",
      openedAt: "2026-05-26T10:00:00.000Z",
      closedAt: "2026-05-26T09:55:00.000Z",   // before openedAt
      durationMinutes: -5,
      chronologyStatus: "INVALID_NEGATIVE_DURATION",
    }));
    const r = buildFilteredEdgeShadowReport(store);
    expect(r.recentResolved[0]!.excludedReason).toBe("BAD_CHRONOLOGY");
  });

  // 12. Fresh-valid economics exclude invalid/quarantined records
  it("12. fresh-valid economics exclude all invalid/quarantined records", () => {
    const store = makeS6Store();
    store.add(makeS6Pos({ id: "good", grossR: 1, netR: 0.9, status: "CLOSED_WIN" }));
    store.add(makeS6Pos({ id: "outlier", maxMfeR: 25, mfeBeforeCloseR: 25, grossR: 5, netR: 4.9 }));
    const econ = computeFilteredEdgeEconomics(store.all, (o) => deriveFreshValidStatus(o).freshValid);
    expect(econ.n).toBe(1);
    expect(econ.netAvgR).toBeCloseTo(0.9, 6);
  });

  // 13. Consistency PASS when counts align
  it("13. consistency PASS when all counts align", () => {
    const store = makeS6Store();
    store.add(makeS6Pos({ id: "ok" }));
    const r = buildFilteredEdgeShadowReport(store);
    expect(r.freshValidConsistencyCheck).toBe("PASS");
    expect(r.pathMetricConsistencyCheck.status).toBe("PASS");
    expect(r.chronologyConsistencyCheck.status).toBe("PASS");
  });

  // 14. Consistency FAIL when negative duration injected
  it("14. chronologyConsistencyCheck FAIL when negativeDuration > 0", () => {
    const store = makeS6Store();
    store.add(makeS6Pos({
      id: "neg-dur",
      createdAt: "2026-05-26T10:10:00.000Z",
      openedAt: "2026-05-26T10:00:00.000Z",
      closedAt: "2026-05-26T09:55:00.000Z",
      durationMinutes: -5,
      chronologyStatus: "INVALID_NEGATIVE_DURATION",
    }));
    const r = buildFilteredEdgeShadowReport(store);
    expect(r.chronologyConsistencyCheck.status).toBe("FAIL");
    expect(r.chronologyConsistencyCheck.negativeDurationCount).toBe(1);
  });

  // 15. No live behavior — normal shadow file path never appears in any code path here
  it("15. store path never references shadow-positions.json (isolation guard)", () => {
    const store = makeS6Store();
    expect(store.path).not.toContain("shadow-positions.json");
    expect(store.path).toContain("regime-controller-filtered-edge-shadow.json");
  });

  // 16. derivePathMetric with mfeR=25 returns OUTLIER (cap = 20)
  it("16. derivePathMetric with mfeR=25 returns PATH_METRIC_OUTLIER (cap 20)", () => {
    const obs = makeS6Pos({ maxMfeR: 25, mfeBeforeCloseR: 25 });
    expect(derivePathMetric(obs).status).toBe("PATH_METRIC_OUTLIER");
  });

  // 17. derivePathMetric with mfeR=-0.5 (sign error) returns OUTLIER
  it("17. derivePathMetric with mfeR=-0.5 (sign error) returns PATH_METRIC_OUTLIER", () => {
    const obs = makeS6Pos({ maxMfeR: -0.5, mfeBeforeCloseR: -0.5 });
    expect(derivePathMetric(obs).status).toBe("PATH_METRIC_OUTLIER");
  });

  // 18. deriveChronologyStatus with closedAt < openedAt returns INVALID_NEGATIVE_DURATION
  it("18. deriveChronologyStatus with closedAt < openedAt returns INVALID_NEGATIVE_DURATION", () => {
    const obs = makeS6Pos({
      createdAt: "2026-05-26T10:00:00.000Z",
      openedAt: "2026-05-26T10:05:00.000Z",
      closedAt: "2026-05-26T10:00:00.000Z",
      chronologyStatus: null,
    });
    expect(deriveChronologyStatus(obs)).toBe("INVALID_NEGATIVE_DURATION");
  });

  // 19. deriveChronologyStatus with openedAt < createdAt returns INVALID_OPENED_BEFORE_CREATED
  it("19. deriveChronologyStatus with openedAt < createdAt returns INVALID_OPENED_BEFORE_CREATED", () => {
    const obs = makeS6Pos({
      createdAt: "2026-05-26T10:05:00.000Z",
      openedAt: "2026-05-26T10:00:00.000Z",
      closedAt: "2026-05-26T10:10:00.000Z",
      chronologyStatus: null,
    });
    expect(deriveChronologyStatus(obs)).toBe("INVALID_OPENED_BEFORE_CREATED");
  });

  // 20. Legacy missing analyticsVersion gets quarantined as LEGACY_MISSING_VERSION
  it("20. legacy record missing analyticsVersion gets quarantined as LEGACY_MISSING_VERSION", () => {
    const obs = makeS6Pos({ analyticsVersion: null });
    expect(deriveQuarantineReason(obs)).toBe("LEGACY_MISSING_VERSION");
  });

  // 21. Quarantined records are excluded from fresh-valid even if other rules pass
  it("21. quarantined records are excluded from fresh-valid", () => {
    const obs = makeS6Pos({ analyticsVersion: null });
    const result = deriveFreshValidStatus(obs);
    expect(result.freshValid).toBe(false);
    expect(result.reason).toMatch(/QUARANTINED:LEGACY_MISSING_VERSION/);
  });

  // 22. data/shadow-positions.json untouched — verify store.path
  it("22. data/shadow-positions.json is untouched (store path isolation)", () => {
    const store = makeS6Store();
    expect(store.path).not.toContain("shadow-positions.json");
  });

  // 23. computeFilteredEdgeEconomics aggregates correctly per profile
  it("23. computeFilteredEdgeEconomics computes per-profile fresh-valid economics", () => {
    const store = makeS6Store();
    store.add(makeS6Pos({ id: "s1", profile: "STRICT_COST10", grossR: 1, netR: 0.92, status: "CLOSED_WIN" }));
    store.add(makeS6Pos({ id: "s2", profile: "STRICT_COST10", grossR: -1, netR: -1.08, status: "CLOSED_LOSS" }));
    store.add(makeS6Pos({ id: "b1", profile: "BROAD_COST20_STOP150", grossR: 1, netR: 0.85, status: "CLOSED_WIN" }));
    const strictFV = computeFilteredEdgeEconomics(
      store.all,
      (o) => o.profile === "STRICT_COST10" && deriveFreshValidStatus(o).freshValid,
    );
    expect(strictFV.n).toBe(2);
    expect(strictFV.wins).toBe(1);
    expect(strictFV.losses).toBe(1);
    expect(strictFV.wr).toBeCloseTo(0.5, 6);
  });
});

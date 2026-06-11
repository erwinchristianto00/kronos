import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";
import {
  PARALLEL_SHADOW_EXPERIMENTS,
  PARALLEL_SHADOW_EXPERIMENT_LANE,
  PARALLEL_SHADOW_EXPERIMENT_POLICY_VERSION,
  _resetParallelShadowExperimentStoreForTests,
  admitToParallelShadowExperiments,
  buildParallelShadowExperimentObservation,
  buildParallelShadowExperimentReport,
  collectParallelShadowExperimentMissingFields,
  resolveParallelShadowExperimentObservations,
  ParallelShadowExperimentStore,
  type ParallelShadowExperimentCandidate,
  type ParallelShadowExperimentObservation,
} from "../src/lib/parallel-shadow-experiments.js";

let tmpCounter = 0;
const dirs: string[] = [];

function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `parallel-shadow-experiments-${process.pid}-${++tmpCounter}`);
  dirs.push(dir);
  return dir;
}

function makeStore(): ParallelShadowExperimentStore {
  return new ParallelShadowExperimentStore(tmpDir());
}

function makeCandidate(overrides: Partial<ParallelShadowExperimentCandidate> = {}): ParallelShadowExperimentCandidate {
  return {
    symbol: "INJUSDT",
    direction: "SHORT",
    controllerMode: "SHORT_ONLY",
    currentRegime: "Bearish pressure",
    marketRegimeAtOpen: "Bearish pressure",
    regimeFamily: "bearish",
    entryPrice: 100,
    stopLoss: 105,
    takeProfits: { tp1: 95 },
    stopDistanceBps: 500,
    costR: 0.08,
    atrPercent: 1,
    sourceConflict: false,
    liveSourceConflict: false,
    kronosBias: "SHORT",
    kronosAgrees: true,
    whaleAgreement: "AGREES",
    trendAligned: true,
    selectedEntryVariant: "fib_500_entry",
    selectedExitVariant: "tp1_full_exit",
    kronosHorizonConflict: false,
    selectedExecutionPlan: { selectedEntryVariant: "fib_500_entry", selectedExitVariant: "tp1_full_exit" },
    ...overrides,
  };
}

function makeResolved(
  experimentId: ParallelShadowExperimentObservation["experimentId"],
  overrides: Partial<ParallelShadowExperimentObservation> = {},
): ParallelShadowExperimentObservation {
  const createdAt = overrides.createdAt ?? "2026-05-20T00:00:00.000Z";
  return {
    ...buildParallelShadowExperimentObservation(makeCandidate(), experimentId, createdAt),
    status: "CLOSED_WIN",
    closedAt: overrides.closedAt ?? "2026-05-20T00:30:00.000Z",
    grossR: 0.5,
    netR: 0.42,
    resolutionSource: "CANDLE_WALK_TP1",
    durationMinutes: 30,
    chronologyStatus: "VALID",
    maxMfeR: 0.55,
    minMaeR: -0.1,
    mfeBeforeCloseR: 0.55,
    maeBeforeCloseR: -0.1,
    pathMetricStatus: "VALID",
    intrabarResolutionStatus: "VALID_5M_ORDERED",
    isFreshValid: true,
    ...overrides,
  };
}

beforeEach(() => {
  _resetParallelShadowExperimentStoreForTests();
});

afterEach(() => {
  _resetParallelShadowExperimentStoreForTests();
  for (const dir of dirs.splice(0)) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
});

describe("parallel-shadow-experiments", () => {
  it("registry has exactly 20 experiments", () => {
    expect(PARALLEL_SHADOW_EXPERIMENTS).toHaveLength(20);
    expect(new Set(PARALLEL_SHADOW_EXPERIMENTS.map((exp) => exp.id)).size).toBe(20);
  });

  it("candidate can enter multiple experiments", () => {
    const result = admitToParallelShadowExperiments(makeCandidate(), makeStore());
    expect(result.admittedExperimentIds).toContain("BASE_BROAD_COST20_STOP150");
    expect(result.admittedExperimentIds).toContain("BASE_COST10_ONLY");
    expect(result.admittedExperimentIds).toContain("INJ_ONLY_COST20_STOP150");
    expect(result.admittedExperimentIds.length).toBeGreaterThan(3);
  });

  it("records admission diagnostics even when no observations are created", () => {
    const store = makeStore();
    store.recordAdmissionDiagnostics({
      disabled: false,
      matrixAdmissionInvoked: true,
      lastAdmissionAt: "2026-05-27T10:00:00.000Z",
      lastScanBatchId: "scan-1",
      candidatesSeen: 1,
      candidatesEvaluated: 1,
      observationsCreated: 0,
      duplicateSuppressed: 0,
      rejectedTotal: 20,
      rejectedByReason: [{ reason: "MISSING_COST_R", count: 20 }],
      fieldMissingCounts: { costR: 1 },
      env: {
        PARALLEL_SHADOW_EXPERIMENTS_DISABLED: null,
        EXPERIMENT_MATRIX_DISABLED: null,
      },
    });
    const report = buildParallelShadowExperimentReport(store);
    expect(report.latestAdmissionDiagnostics?.matrixAdmissionInvoked).toBe(true);
    expect(report.latestAdmissionDiagnostics?.candidatesSeen).toBe(1);
    expect(report.latestAdmissionDiagnostics?.observationsCreated).toBe(0);
  });

  it("candidate field diagnostics count missing costR", () => {
    const missing = collectParallelShadowExperimentMissingFields(makeCandidate({ costR: null }));
    expect(missing).toContain("costR");
    expect(missing).not.toContain("stopDistanceBps");
  });

  it("duplicate suppression is per experiment", () => {
    const store = makeStore();
    store.add(buildParallelShadowExperimentObservation(makeCandidate(), "BASE_COST10_ONLY"));
    const result = admitToParallelShadowExperiments(makeCandidate(), store);
    expect(result.admittedExperimentIds).not.toContain("BASE_COST10_ONLY");
    expect(result.admittedExperimentIds).toContain("BASE_BROAD_COST20_STOP150");
  });

  it("symbol include and exclude filters work", () => {
    const included = admitToParallelShadowExperiments(makeCandidate({ symbol: "INJUSDT" }), makeStore());
    expect(included.admittedExperimentIds).toContain("INJ_ONLY_COST10");

    const excluded = admitToParallelShadowExperiments(makeCandidate({ symbol: "LINKUSDT" }), makeStore());
    expect(excluded.admittedExperimentIds).not.toContain("EXCLUDE_BTC_LINK_AVAX_COST20_STOP150");
  });

  it("costR filter works", () => {
    const result = admitToParallelShadowExperiments(makeCandidate({ costR: 0.18 }), makeStore());
    expect(result.admittedExperimentIds).toContain("BASE_BROAD_COST20_STOP150");
    expect(result.admittedExperimentIds).not.toContain("BASE_COST10_ONLY");
  });

  it("trendAligned filter works", () => {
    const result = admitToParallelShadowExperiments(makeCandidate({ trendAligned: false }), makeStore());
    expect(result.admittedExperimentIds).not.toContain("TREND_ALIGNED_COST20_STOP150");
    expect(result.admittedExperimentIds).not.toContain("SOURCE_FALSE_TREND_ALIGNED_COST20");
  });

  it("kronos and whale filters work", () => {
    const result = admitToParallelShadowExperiments(
      makeCandidate({ kronosAgrees: false, whaleAgreement: "DISAGREES" }),
      makeStore(),
    );
    expect(result.admittedExperimentIds).not.toContain("KRONOS_AGREES_COST20_STOP150");
    expect(result.admittedExperimentIds).not.toContain("WHALE_AGREES_COST20_STOP150");
    expect(result.admittedExperimentIds).not.toContain("KRONOS_AND_WHALE_AGREE_COST20");
  });

  it("resolver computes a fresh-valid TP1 result", async () => {
    const store = makeStore();
    const baseMs = Date.now() - 10 * 60 * 1000;
    const obs = buildParallelShadowExperimentObservation(
      makeCandidate(),
      "BASE_COST10_ONLY",
      new Date(baseMs + 60 * 1000).toISOString(),
    );
    store.add(obs);
    const result = await resolveParallelShadowExperimentObservations(store, {
      getKlines: async (_symbol, interval) => {
        if (interval === "1m") return [];
        return [
          [baseMs, "0", "101", "99", "100", "0", baseMs + 5 * 60 * 1000],
          [baseMs + 5 * 60 * 1000, "0", "101", "94", "95", "0", baseMs + 10 * 60 * 1000],
        ];
      },
    });
    expect(result.resolved).toBe(1);
    const updated = store.all[0]!;
    expect(updated.status).toBe("CLOSED_WIN");
    expect(updated.pathMetricStatus).toBe("VALID");
    expect(updated.chronologyStatus).toBe("VALID");
    expect(buildParallelShadowExperimentReport(store).rows.find((row) => row.experimentId === "BASE_COST10_ONLY")?.freshValid).toBe(1);
  });

  it("anti-overfit status gates promotion and kill states", () => {
    const store = makeStore();
    for (let i = 0; i < 30; i += 1) {
      store.add(makeResolved("BASE_BROAD_COST20_STOP150", {
        id: `base-${i}`,
        symbol: i % 2 === 0 ? "SOLUSDT" : "INJUSDT",
        createdAt: new Date(Date.UTC(2026, 4, 20 + (i % 4))).toISOString(),
        closedAt: new Date(Date.UTC(2026, 4, 20 + (i % 4), 1)).toISOString(),
        netR: 0.01,
      }));
      store.add(makeResolved("TREND_ALIGNED_COST20_STOP150", {
        id: `promo-${i}`,
        symbol: i % 2 === 0 ? "SOLUSDT" : "INJUSDT",
        createdAt: new Date(Date.UTC(2026, 4, 20 + (i % 4))).toISOString(),
        closedAt: new Date(Date.UTC(2026, 4, 20 + (i % 4), 1)).toISOString(),
        netR: i % 3 === 0 ? -0.1 : 0.22,
      }));
      store.add(makeResolved("WHALE_AGREES_COST20_STOP150", {
        id: `kill-${i}`,
        symbol: i % 2 === 0 ? "SOLUSDT" : "INJUSDT",
        createdAt: new Date(Date.UTC(2026, 4, 20 + (i % 4))).toISOString(),
        closedAt: new Date(Date.UTC(2026, 4, 20 + (i % 4), 1)).toISOString(),
        status: "CLOSED_LOSS",
        grossR: -1,
        netR: -1.08,
      }));
    }
    const report = buildParallelShadowExperimentReport(store);
    expect(report.rows.find((row) => row.experimentId === "TREND_ALIGNED_COST20_STOP150")?.status).toBe("PROMOTION_CANDIDATE");
    expect(report.rows.find((row) => row.experimentId === "WHALE_AGREES_COST20_STOP150")?.status).toBe("KILL");
  });

  it("dashboard renders matrix section", () => {
    const store = makeStore();
    store.add(makeResolved("BASE_BROAD_COST20_STOP150"));
    store.recordAdmissionDiagnostics({
      disabled: false,
      matrixAdmissionInvoked: true,
      lastAdmissionAt: "2026-05-27T10:00:00.000Z",
      lastScanBatchId: "scan-1",
      candidatesSeen: 1,
      candidatesEvaluated: 1,
      observationsCreated: 1,
      duplicateSuppressed: 0,
      rejectedTotal: 5,
      rejectedByReason: [{ reason: "SYMBOL_NOT_INCLUDED", count: 5 }],
      fieldMissingCounts: {},
      env: {
        PARALLEL_SHADOW_EXPERIMENTS_DISABLED: null,
        EXPERIMENT_MATRIX_DISABLED: null,
      },
    });
    const matrix = buildParallelShadowExperimentReport(store);
    const report = buildDashboardAuditSummaryReport([], { parallelShadowExperimentReport: matrix });
    expect(report.summaryText).toContain("W****. PARALLEL SHADOW EXPERIMENT MATRIX");
    expect(report.summaryText).toContain("Admission diagnostics");
    expect(report.summaryText).toContain("candidatesSeen=1");
    expect(report.summaryText).toContain("BASE_BROAD_COST20_STOP150");
    expect(report.summaryText).toContain("data/parallel-shadow-experiments.json only");
  });

  it("observations are report-only and isolated from normal shadow storage", () => {
    const store = makeStore();
    const obs = buildParallelShadowExperimentObservation(makeCandidate(), "BASE_COST10_ONLY");
    store.add(obs);
    expect(store.path).toContain("parallel-shadow-experiments.json");
    expect(store.path).not.toContain("shadow-positions.json");
    expect(store.all[0]?.reportOnly).toBe(true);
    expect(store.all[0]?.laneVersion).toBe(PARALLEL_SHADOW_EXPERIMENT_LANE);
    expect(store.all[0]?.policyVersion).toBe(PARALLEL_SHADOW_EXPERIMENT_POLICY_VERSION);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CurrentGuardVariantMatrixReport, CurrentGuardVariantMatrixRow } from "../src/lib/current-guard-variant-matrix.js";
import type { PostCutoverReport } from "../src/lib/frozen-current-guard-post-cutover.js";
import {
  buildOosValidationSnapshot,
  createOosValidationSnapshotLoggerController,
  JsonlOosValidationSnapshotStore,
} from "../src/lib/oos-validation-snapshot-logger.js";

function makePostCutoverReport(overrides: Partial<PostCutoverReport> = {}): PostCutoverReport {
  return {
    reportOnly: true,
    laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD_POST_CUTOVER_V1",
    computedAt: "2026-06-05T00:00:00.000Z",
    boundary: {
      laneVersion: "BASE_ROUTE_STOP175_CURRENT_GUARD_POST_CUTOVER_V1",
      cutoverTimestamp: "2026-06-01T00:00:00.000Z",
      reason: "test",
      frozenAt: "2026-06-01T00:00:00.000Z",
      derivedFrom: {
        pathologyVerdict: "OLD_BATCH",
        freshValidAtLock: 90,
        seg1NAtLock: 30,
        seg1LastClosedAt: "2026-06-01T00:00:00.000Z",
      },
    },
    cutoverActive: true,
    total: 30,
    open: 2,
    resolved: 28,
    freshValid: 25,
    netAvgR: 0.08,
    pf: 1.4,
    wr: 0.56,
    daysCovered: 5,
    costSensitivity: [],
    realisticCostModel: null,
    rolling: [],
    oosSegments: [
      { label: "post_segment_1", n: 8, netAvgR: 0.04, grossAvgR: 0.06, pf: 1.2, wr: 0.5 },
      { label: "post_segment_2", n: 8, netAvgR: 0.08, grossAvgR: 0.1, pf: 1.4, wr: 0.55 },
      { label: "post_segment_3", n: 9, netAvgR: 0.12, grossAvgR: 0.14, pf: 1.6, wr: 0.6 },
    ],
    allThreeSegmentsPositive: true,
    bySymbol: [],
    byEntryVariant: [],
    byRegime: [],
    topSymbolPnlShare: 0.2,
    approxMaxDrawdownR: 1.5,
    maxAdverseStreak: 3,
    resolvedPerDay: 5.6,
    freshValidPerDay: 5,
    etaToN100Days: 15,
    etaToN100Date: "2026-06-20",
    etaToN200Days: 35,
    etaToN200Date: "2026-07-10",
    plus10bpsStillPositive: true,
    status: "COLLECTING",
    statusReason: "collecting",
    blockers: ["sample"],
    cautions: ["report-only"],
    ...overrides,
  } as PostCutoverReport;
}

function makeVariantRow(overrides: Partial<CurrentGuardVariantMatrixRow> = {}): CurrentGuardVariantMatrixRow {
  return {
    variantId: "CG_WIDE_STOP_TP_WIDE",
    label: "Wide stop",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    total: 70,
    open: 5,
    resolved: 65,
    freshValid: 60,
    rejected: 0,
    noFill: 0,
    expired: 0,
    dataFailure: 0,
    netAvgR: 0.2,
    grossAvgR: 0.25,
    pf: 1.8,
    wr: 0.6,
    avgWinR: 0.8,
    avgLossR: -0.5,
    payoffRatio: 1.6,
    breakEvenWR: 0.3846,
    actualWR: 0.6,
    avgCostR: 0.05,
    costDragR: 0.05,
    noFillRate: 0,
    expiredRate: 0,
    avgHoldingMinutes: 45,
    approxMaxDrawdownR: 2,
    maxAdverseStreak: 2,
    topSymbolPnlShare: 0.3,
    plus10bpsNetAvgR: 0.15,
    plus10bpsStillPositive: true,
    calendarDays: 6,
    distinctRegimes: 2,
    byRegime: [],
    byEntryVariant: [],
    oosThirds: [
      { label: "oos_1", n: 20, netAvgR: 0.1 },
      { label: "oos_2", n: 20, netAvgR: 0.2 },
      { label: "oos_3", n: 20, netAvgR: 0.3 },
    ],
    allThreeOosPositive: true,
    rolling: [],
    status: "WATCHABLE",
    statusReason: "watchable",
    blockers: [],
    cautions: ["report-only"],
    ...overrides,
  } as CurrentGuardVariantMatrixRow;
}

function makeVariantMatrixReport(rows = [makeVariantRow()]): CurrentGuardVariantMatrixReport {
  return {
    reportOnly: true,
    laneVersion: "CURRENT_GUARD_VARIANT_MATRIX_V1",
    policyVersion: "current-guard-variant-matrix-v1",
    computedAt: "2026-06-05T00:00:00.000Z",
    cutoverTimestamp: "2026-06-01T00:00:00.000Z",
    sourcePopulationNote: "test",
    totalObservations: rows.reduce((sum, row) => sum + row.total, 0),
    variantCount: rows.length,
    baselineVariantId: "CG_BASELINE_CURRENT",
    rows,
    bestVariantId: rows[0]?.variantId ?? null,
    bestVariantNetAvgR: rows[0]?.netAvgR ?? null,
    bestBeatsBaseline: true,
    resolverDiagnostics: {
      lastRunAt: "2026-06-05T00:10:00.000Z",
      resolvedThisRun: 2,
      expiredThisRun: 0,
      dataFailuresThisRun: 0,
      staleOpenCount: 0,
      oldestOpenAgeHours: null,
      nextAction: null,
    },
    liveBlocked: true,
    microPilotAllowed: false,
    notes: [],
  } as CurrentGuardVariantMatrixReport;
}

describe("OOS validation snapshot logger", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.useRealTimers();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("builds report-only lane snapshots with per-lane curve metrics", () => {
    const snapshot = buildOosValidationSnapshot({
      capturedAt: "2026-06-05T00:15:00.000Z",
      triggerSource: "SCHEDULED",
      era: "POST_CALIBRATION",
      postCutoverReport: makePostCutoverReport(),
      variantMatrixReport: makeVariantMatrixReport(),
    });

    expect(snapshot.reportOnly).toBe(true);
    expect(snapshot.liveBlocked).toBe(true);
    expect(snapshot.microPilotAllowed).toBe(false);
    expect(snapshot.postCutoverBoundaryCutoverAt).toBe("2026-06-01T00:00:00.000Z");
    expect(snapshot.variantMatrixResolverLastRunAt).toBe("2026-06-05T00:10:00.000Z");
    expect(snapshot.lanes).toHaveLength(2);

    const postCutover = snapshot.lanes.find((lane) => lane.source === "POST_CUTOVER");
    expect(postCutover?.etaToN50Days).toBe(5);
    expect(postCutover?.oosSegments?.map((s) => s.netAvgR)).toEqual([0.04, 0.08, 0.12]);

    const variant = snapshot.lanes.find((lane) => lane.source === "VARIANT_MATRIX");
    expect(variant?.laneId).toBe("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    expect(variant?.etaToN100Days).toBe(4);
    expect(variant?.etaToN200Days).toBe(14);
    expect(snapshot.economicLead?.laneId).toBe("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    expect(snapshot.economicLead?.selectionBasis).toBe("HIGHEST_WATCHABLE_NET");
  });

  it("appends JSONL snapshots and reads the tail without throwing", () => {
    tempDir = mkdtempSync(join(tmpdir(), "oos-validation-snapshots-"));
    const store = new JsonlOosValidationSnapshotStore(tempDir);
    const first = buildOosValidationSnapshot({
      capturedAt: "2026-06-05T00:00:00.000Z",
      triggerSource: "SCHEDULED",
      postCutoverReport: makePostCutoverReport({ freshValid: 10 }),
      variantMatrixReport: makeVariantMatrixReport(),
    });
    const second = buildOosValidationSnapshot({
      capturedAt: "2026-06-05T00:15:00.000Z",
      triggerSource: "SCHEDULED",
      postCutoverReport: makePostCutoverReport({ freshValid: 11 }),
      variantMatrixReport: makeVariantMatrixReport(),
    });

    expect(store.append(first)).toBe(true);
    expect(store.append(second)).toBe(true);
    expect(store.readTail(1).map((s) => s.capturedAt)).toEqual(["2026-06-05T00:15:00.000Z"]);
    expect(store.readTail(10)).toHaveLength(2);
  });

  it("schedules read-only snapshots at startup and interval", async () => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(join(tmpdir(), "oos-validation-scheduler-"));
    const store = new JsonlOosValidationSnapshotStore(tempDir);
    const captureSnapshot = vi.fn((triggerSource, capturedAt) =>
      buildOosValidationSnapshot({
        capturedAt,
        triggerSource,
        postCutoverReport: makePostCutoverReport(),
        variantMatrixReport: makeVariantMatrixReport(),
      }),
    );
    const controller = createOosValidationSnapshotLoggerController({
      enabled: true,
      intervalMinutes: 1,
      startupDelayMs: 100,
      store,
      captureSnapshot,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(captureSnapshot).toHaveBeenCalledTimes(1);
    expect(store.readTail(10)).toHaveLength(1);
    expect(controller.getStatus().lastSnapshotStatus).toBe("SUCCESS");
    expect(controller.getStatus().lastSnapshotResultSummary?.variantMatrixRows).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
    expect(store.readTail(10)).toHaveLength(2);
    controller.stop();
  });
});

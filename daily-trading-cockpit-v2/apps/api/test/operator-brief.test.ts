import { describe, it, expect } from "vitest";
import os from "node:os";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import {
  buildOperatorBrief,
  OPERATOR_BRIEF_MAX_LINES,
  OPERATOR_BRIEF_TOP_VARIANTS,
  type OperatorBriefInputs,
} from "../src/lib/operator-brief.js";
import type { ScanTimingDiagnostics } from "../src/lib/scan-timing-diagnostics.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import { buildPostCutoverReport } from "../src/lib/frozen-current-guard-post-cutover.js";
import {
  buildCurrentGuardVariantMatrixReport,
  CurrentGuardVariantMatrixStore,
  mirrorVariantMatrixSignals,
  resolveVariantMatrixObservations,
  type VariantMatrixSignal,
  type KlineTuple,
} from "../src/lib/current-guard-variant-matrix.js";

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "operator-brief-test-"));
}

// 5m candle helper: [openTimeMs, "0", high, low, close, "0", closeTimeMs]
function candle(openMs: number, high: number, low: number, close: number): KlineTuple {
  return [openMs, "0", String(high), String(low), String(close), "0", openMs + 300_000];
}

const SIGNAL_OPEN_MS = new Date("2026-05-20T00:00:00.000Z").getTime();

/** Mock Binance client that always produces a TP WIN at the signal candle. */
function winningBinance() {
  return {
    getKlines: async (_symbol: string, interval: string, _opts: { startTime: number; endTime: number; limit: number }): Promise<KlineTuple[]> => {
      if (interval === "1m") return [];
      return [
        candle(SIGNAL_OPEN_MS - 300_000, 100.2, 99.9, 100),
        candle(SIGNAL_OPEN_MS, 104.5, 100.1, 104), // TP hit, no SL
        candle(SIGNAL_OPEN_MS + 300_000, 105, 103, 104.5),
      ];
    },
  };
}

function makeStaleSignal(overrides: Partial<VariantMatrixSignal> = {}): VariantMatrixSignal {
  // Default openedAt = 4 days ago so the obs is stale (>72 h) but not yet expired (<7 d).
  const staleMs = Date.now() - 4 * 24 * 60 * 60 * 1000;
  return {
    sourceSignalId: "stale-sig-1",
    symbol: "ETHUSDT",
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 98,
    tp1: 104,
    tp2: null,
    tp3: null,
    stopDistanceBps: 200,
    regime: "BULLISH_EXPANSION",
    entryVariant: "base_current_entry",
    openedAt: new Date(staleMs).toISOString(),
    closedAt: null,
    ...overrides,
  };
}

/** Real empty gate report — all infra gates FAIL, liveBlocked=true. */
function emptyGate() {
  return buildLiveTradingGateReport({});
}

/** Real empty post-cutover report — no boundary, zero obs. */
function emptyPc() {
  return buildPostCutoverReport(undefined, null, null);
}

/** Real empty variant matrix report. */
function emptyVm() {
  return buildCurrentGuardVariantMatrixReport(new CurrentGuardVariantMatrixStore(tmpDir()));
}

function makeInputs(overrides: Partial<OperatorBriefInputs> = {}): OperatorBriefInputs {
  return {
    generatedAt: "2026-05-30T20:00:00.000Z",
    era: "POST_CALIBRATION",
    scanStatus: null,
    regimeReport: null,
    postCutoverReport: emptyPc(),
    variantMatrixReport: emptyVm(),
    gateReport: emptyGate(),
    ...overrides,
  };
}

function makeScanTimingDiagnostics(): ScanTimingDiagnostics {
  return {
    version: "scan-timing-diagnostics-v1",
    scanBatchId: "2026-06-04T10:00:00.000Z",
    status: "COMPLETED",
    startedAt: "2026-06-04T10:00:00.000Z",
    finishedAt: "2026-06-04T10:00:15.000Z",
    updatedAt: "2026-06-04T10:00:15.000Z",
    totalScanMs: 15_000,
    activeStage: null,
    activeSymbols: [],
    stages: [
      {
        name: "coreMarketScan",
        invoked: true,
        status: "COMPLETED",
        startedAt: "2026-06-04T10:00:00.000Z",
        finishedAt: "2026-06-04T10:00:14.000Z",
        durationMs: 14_000,
      },
    ],
    totals: {
      symbolFetchMs: 20_000,
      candleFetchMs: 12_000,
      kronosForecastMs: 6_000,
      externalOverlayMs: 0,
      externalSignalFetchMs: 500,
      binanceRetryMs: 150,
      providerWaitMs: 12_500,
      totalSymbolFetchMs: 20_000,
      candidateScoringMs: 250,
      regimeControllerMs: 120,
      allocatorAdmissionMs: null,
    },
    symbolFetchMs: { BTCUSDT: 2000 },
    symbols: [],
    slowestSymbols: [],
    stageSummary: {
      p95Stage: { name: "coreMarketScan", durationMs: 14_000 },
      slowestStage: { name: "coreMarketScan", durationMs: 14_000 },
    },
    markers: [],
    analysisPerformance: {
      cacheHit: true,
      inputSignatureMs: 1,
      readAllRawMs: 0,
      computePerformanceMs: 0,
      totalMs: 2,
      candidateNormalizationMs: null,
      indicatorAggregationMs: null,
      replayVariantAnalysisMs: 0,
      calibrationMs: null,
      routeReasonEvaluationMs: null,
      rankingMs: null,
      filterGateMs: null,
      loggingSerializationMs: null,
      diagnosticsBuildMs: null,
    },
    asyncQueueDispatch: {
      queueBuildMs: 1,
      queueWaitMs: 3,
      workerActiveMs: 12,
      concurrencyUsed: 3,
      taskCount: 3,
      perTaskWaitMs: { p50: 2, p90: 3, max: 3 },
      perTaskRunMs: { p50: 8, p90: 12, max: 12 },
      slowestQueueTasks: [],
      retryDelayMs: 0,
      artificialSleepMs: 0,
      rateLimitWaitMs: 0,
      tasks: [],
    },
    backgroundQueue: {
      trackerPersist: "completed",
      shadowEngine: "running",
      outcomeChecker: "completed",
      lastCompletedAt: "2026-06-04T10:00:17.000Z",
      lastError: null,
      maxLagSec: 17,
    },
    admissionTrace: {
      scanFinishedAt: "2026-06-04T10:00:15.000Z",
      candidatesCachedAt: "2026-06-04T10:00:15.010Z",
      allocatorStartedAt: "2026-06-04T10:00:16.000Z",
      allocatorFinishedAt: "2026-06-04T10:00:16.020Z",
      paperAdmissionStartedAt: "2026-06-04T10:00:16.030Z",
      paperAdmissionFinishedAt: "2026-06-04T10:00:16.040Z",
      createdHeadline: 1,
      createdDiagnostic: 0,
    },
  };
}

describe("operator-brief", () => {
  // 1. Under OPERATOR_BRIEF_MAX_LINES lines with normal data.
  it("[1] renders under OPERATOR_BRIEF_MAX_LINES lines", () => {
    const brief = buildOperatorBrief(makeInputs());
    const lines = brief.split("\n").length;
    expect(lines).toBeLessThanOrEqual(OPERATOR_BRIEF_MAX_LINES);
  });

  // 2. Includes F****** post-cutover summary section.
  it("[2] includes F****** post-cutover section with status", () => {
    const brief = buildOperatorBrief(makeInputs());
    expect(brief).toContain("F****** POST-CUTOVER");
    expect(brief).toContain("freshValid=");
    expect(brief).toContain("ETA  n=50:");
    expect(brief).toContain("n=100:");
  });

  // 3. Includes exactly the top 3 variant IDs, not all 6.
  it("[3] shows top 3 variant IDs (wide-stop, baseline, maker-limit)", () => {
    const brief = buildOperatorBrief(makeInputs());
    for (const id of OPERATOR_BRIEF_TOP_VARIANTS) {
      expect(brief).toContain(id);
    }
    // Excluded variants must NOT appear as section headers.
    const excluded = ["CG_TRAIL_AFTER_TP1", "CG_SCALEOUT_TP1_TRAIL", "CG_NO_FIB500_ENTRYSET"];
    for (const id of excluded) {
      // They should not appear as standalone rows (lines starting with spaces+id+colon).
      const lines = brief.split("\n");
      const rowLines = lines.filter((l) => l.trim().startsWith(id + ":"));
      expect(rowLines).toHaveLength(0);
    }
  });

  // 4. Excludes W** and W*** long section headers.
  it("[4] excludes W** and W*** controller / filtered-edge long sections", () => {
    const brief = buildOperatorBrief(makeInputs());
    // These section headers only appear in the full dashboard, not the operator brief.
    expect(brief).not.toContain("W**. REGIME CONTROLLER");
    expect(brief).not.toContain("W***. FILTERED-EDGE");
    expect(brief).not.toContain("CONTROLLER ALIGNED SHADOW");
    expect(brief).not.toContain("PARALLEL SHADOW EXPERIMENT");
    // Also no external rotation sections.
    expect(brief).not.toContain("EXTERNAL ROTATION");
  });

  // 5. liveBlocked remains TRUE regardless of evidence.
  it("[5] liveBlocked is always TRUE and microPilotAllowed always FALSE", () => {
    const gate = emptyGate();
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);

    const brief = buildOperatorBrief(makeInputs({ gateReport: gate }));
    expect(brief).toContain("liveBlocked=TRUE");
    expect(brief).toContain("microPilotAllowed=FALSE");
    // Double-check the gate itself never changed.
    expect(gate.liveBlocked).toBe(true);
  });

  // 6. Pure function — no stores, positions, or files are modified.
  it("[6] buildOperatorBrief is a pure text formatter (no behavior changes)", () => {
    const vmStore = new CurrentGuardVariantMatrixStore(tmpDir());
    const before = vmStore.all.length;

    const vm = buildCurrentGuardVariantMatrixReport(vmStore);
    const gate = buildLiveTradingGateReport({ currentGuardVariantMatrixReport: vm });

    buildOperatorBrief(makeInputs({ variantMatrixReport: vm, gateReport: gate }));

    // Store was not written by buildOperatorBrief.
    expect(vmStore.all.length).toBe(before);
    // Gate is still blocked.
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);
  });

  // ── Phase 3: resolver diagnostics rendering ────────────────────────────────

  // [7] Operator brief renders the resolver diagnostics line in section 4.
  it("[7] brief renders resolver diagnostics line (resolver:, staleOpen=, oldestOpen=)", () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    // Mirror a stale signal so the diagnostics show staleOpenCount > 0.
    mirrorVariantMatrixSignals([makeStaleSignal()], vmStore, new Date().toISOString());
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });

    const brief = buildOperatorBrief(makeInputs({ variantMatrixReport: vm }));

    // Resolver diagnostics line must be present.
    expect(brief).toContain("resolver:");
    expect(brief).toContain("staleOpen=");
    expect(brief).toContain("oldestOpen=");
    // Section 4 must still be within the max-line budget.
    const lines = brief.split("\n").length;
    expect(lines).toBeLessThanOrEqual(OPERATOR_BRIEF_MAX_LINES);
  });

  // [8] liveBlocked=true and microPilotAllowed=false are invariant throughout the report chain.
  it("[8] liveBlocked=true and microPilotAllowed=false survive the full report chain", () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    mirrorVariantMatrixSignals([makeStaleSignal()], vmStore, new Date().toISOString());
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
    const gate = buildLiveTradingGateReport({ currentGuardVariantMatrixReport: vm });

    // Hard invariants at the report level.
    expect(vm.liveBlocked).toBe(true);
    expect(vm.microPilotAllowed).toBe(false);
    // Hard invariants at the gate level.
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);

    const brief = buildOperatorBrief(makeInputs({ variantMatrixReport: vm, gateReport: gate }));
    // Hard invariants must also be visible in the human-readable output.
    expect(brief).toContain("liveBlocked=TRUE");
    expect(brief).toContain("microPilotAllowed=FALSE");
  });

  // [9] data/shadow-positions.json is never created by buildCurrentGuardVariantMatrixReport
  //     or buildOperatorBrief — only the isolated current-guard-variant-matrix.json is written.
  it("[9] shadow-positions.json is never created; only current-guard-variant-matrix.json is written", () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    mirrorVariantMatrixSignals([makeStaleSignal()], vmStore, new Date().toISOString());
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
    buildOperatorBrief(makeInputs({ variantMatrixReport: vm }));

    // The variant matrix file is created (store already wrote it on mirror).
    expect(existsSync(vmStore.path)).toBe(true);
    expect(vmStore.path.endsWith("current-guard-variant-matrix.json")).toBe(true);
    // shadow-positions.json must not exist in the same dir.
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
  });

  // [10] F****** REJECT → section 7 does NOT show "Wait F****** n≥50"
  it("[10] F****** REJECT suppresses 'Wait F****** n≥50' and shows REJECT in brief", () => {
    const baseReport = emptyPc();
    // Override status to REJECT; all other fields stay at their zero/default values.
    const rejectPc = { ...baseReport, status: "REJECT" as const };
    const brief = buildOperatorBrief(makeInputs({ postCutoverReport: rejectPc }));
    expect(brief).not.toContain("Wait until F****** freshValid");
    expect(brief).toContain("REJECT");
  });

  // [11] Router-selected section is always present in section 2
  it("[11] section 2 always contains ROUTER SELECTED: header", () => {
    const brief = buildOperatorBrief(makeInputs());
    expect(brief).toContain("ROUTER SELECTED:");
  });

  // [12] CG_WIDE_STOP n≥50 → "Wait until CG_WIDE_STOP_TP_WIDE freshValid ≥ 50" disappears
  it("[12] CG_WIDE_STOP freshValid ≥ 50 removes the n<50 waiting bullet", async () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);

    // Entries must be FRESH at creation: isFreshValid = (now − openedAt) ≤ FRESH_ENTRY_MAX_MINUTES (10).
    // Pack all 60 within the last ~5 min so every obs is fresh-valid (well within the 7-day expiry too).
    const recentBase = Date.now() - 5 * 60_000;

    // Mirror 60 unique-symbol signals so every variant gets freshValid ≥ 50.
    const signals: VariantMatrixSignal[] = Array.from({ length: 60 }, (_, i) => ({
      sourceSignalId: `sig-${i}`,
      symbol: `SYM${String(i).padStart(3, "0")}USDT`,
      direction: "LONG" as const,
      entryPrice: 100,
      stopLoss: 98,
      tp1: 104,
      tp2: null,
      tp3: null,
      stopDistanceBps: 200,
      regime: "BULLISH_EXPANSION",
      entryVariant: "base_current_entry",
      openedAt: new Date(recentBase + i * 5_000).toISOString(),
      closedAt: null,
    }));

    // winningBinance needs to return candles aligned to each signal's openedAt.
    // We use a variant that wins unconditionally regardless of openedAtMs.
    const flexWinningBinance = {
      getKlines: async (_symbol: string, interval: string, opts: { startTime: number; endTime: number; limit: number }): Promise<KlineTuple[]> => {
        if (interval === "1m") return [];
        // Return candles starting one candle before opts.startTime+5m (the signal candle window).
        const signalOpenMs = opts.startTime + 300_000; // approximate signal candle
        return [
          candle(signalOpenMs - 300_000, 100.2, 99.9, 100),
          candle(signalOpenMs, 104.5, 100.1, 104), // TP hit, no SL
          candle(signalOpenMs + 300_000, 105, 103, 104.5),
        ];
      },
    };

    mirrorVariantMatrixSignals(signals, vmStore, new Date().toISOString());
    await resolveVariantMatrixObservations(vmStore, flexWinningBinance);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });

    const wideRow = vm.rows.find((r) => r.variantId === "CG_WIDE_STOP_TP_WIDE");
    expect(wideRow).toBeDefined();
    expect(wideRow!.freshValid).toBeGreaterThanOrEqual(50);

    const brief = buildOperatorBrief(makeInputs({ variantMatrixReport: vm }));
    // The n<50 waiting bullet must NOT appear.
    expect(brief).not.toContain("Wait until CG_WIDE_STOP_TP_WIDE freshValid ≥ 50");
  });

  // [13] Lines still under OPERATOR_BRIEF_MAX_LINES with dynamic bullets present
  it("[13] brief stays under OPERATOR_BRIEF_MAX_LINES lines with default inputs", () => {
    const brief = buildOperatorBrief(makeInputs());
    const lines = brief.split("\n").length;
    expect(lines).toBeLessThanOrEqual(OPERATOR_BRIEF_MAX_LINES);
  });

  it("[13b] rejected CG_WIDE is rendered as quarantine, never as wait-for-OOS", async () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    // Fresh entries (≤ FRESH_ENTRY_MAX_MINUTES) so freshValid ≥ 50 and a REJECT renders as QUARANTINE
    // rather than the n<50 wait-for-OOS bullet.
    const recentBase = Date.now() - 5 * 60_000;
    const signals = Array.from({ length: 60 }, (_, i) =>
      makeStaleSignal({
        sourceSignalId: `reject-sig-${i}`,
        symbol: `RJ${String(i).padStart(3, "0")}USDT`,
        direction: "SHORT",
        entryPrice: 100,
        stopLoss: 103,
        tp1: 96,
        openedAt: new Date(recentBase + i * 5_000).toISOString(),
      }),
    );
    mirrorVariantMatrixSignals(signals, vmStore, new Date().toISOString());
    await resolveVariantMatrixObservations(vmStore, {
      getKlines: async (_symbol, interval, opts) => {
        if (interval === "1m") return [];
        const signalOpenMs = opts.startTime + 300_000;
        return [
          candle(signalOpenMs - 300_000, 100.2, 99.9, 100),
          candle(signalOpenMs, 104, 99.5, 103.5),
          candle(signalOpenMs + 300_000, 104.5, 103, 104),
        ];
      },
    });
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
    const wide = vm.rows.find((row) => row.variantId === "CG_WIDE_STOP_TP_WIDE")!;
    expect(wide.status).toBe("REJECT");

    const brief = buildOperatorBrief(makeInputs({ variantMatrixReport: vm }));
    expect(brief).toContain("CG_WIDE_STOP_TP_WIDE: QUARANTINE new paper admission");
    expect(brief).toContain("quarantine CG_WIDE_STOP_TP_WIDE");
    expect(brief).not.toContain("CG_WIDE_STOP_TP_WIDE: wait OOS confirmation");
  });

  it("[14] renders compact scan timing line in section 1", () => {
    const brief = buildOperatorBrief(makeInputs({ scanTimingDiagnostics: makeScanTimingDiagnostics() }));

    expect(brief).toContain("scanTiming: total=15.0s");
    expect(brief).toContain("asyncQueue=12ms");
    expect(brief).toContain("backgroundQueue=trackerPersist:completed,shadowEngine:running,outcomeChecker:completed,maxLag=17.0s");
    expect(brief).toContain("analysis=2ms(top=cacheHit)");
    expect(brief).toContain("p95Stage=coreMarketScan:14.0s");
    expect(brief).toContain("slowestStage=coreMarketScan:14.0s");
  });
});

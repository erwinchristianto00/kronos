import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  ScanTimingCollector,
  buildTimingMarkers,
  formatAdmissionTimingBriefLine,
  formatScanTimingBriefLine,
  readLatestScanTimingDiagnostics,
  recordAdmissionTimingTrace,
  type ScanTimingStage,
  type ScanSymbolTiming,
} from "../src/lib/scan-timing-diagnostics.js";

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "scan-timing-diagnostics-test-"));
}

describe("scan timing diagnostics", () => {
  it("records slowestSymbols top 5 and compact scanTiming line", () => {
    const collector = new ScanTimingCollector({
      dataDir: tmpDir(),
      persistProgress: false,
      slowThresholdMs: 50,
      hangThresholdMs: 100,
    });
    for (let i = 0; i < 6; i += 1) {
      const symbol = `SYM${i}USDT`;
      collector.markSymbolStage(symbol, "candleFetch");
      collector.recordSymbolTiming({
        symbol,
        status: "COMPLETED",
        totalMs: 10 + i,
        candleFetchMs: 5 + i,
        kronosForecastMs: 2,
        externalSignalFetchMs: 1,
        candidateScoringMs: 1,
      });
    }

    const diagnostics = collector.finish();

    expect(diagnostics.totalScanMs).toEqual(expect.any(Number));
    expect(diagnostics.symbolFetchMs.SYM5USDT).toBe(15);
    expect(diagnostics.slowestSymbols.map((symbol) => symbol.symbol)).toEqual([
      "SYM5USDT",
      "SYM4USDT",
      "SYM3USDT",
      "SYM2USDT",
      "SYM1USDT",
    ]);
    expect(formatScanTimingBriefLine(diagnostics)).toContain("scanTiming: total=");
    expect(formatScanTimingBriefLine(diagnostics)).toContain("core=");
    expect(formatScanTimingBriefLine(diagnostics)).toContain("slowestProvider=");
    expect(formatScanTimingBriefLine(diagnostics)).toContain("timeoutSymbols=none");
    expect(formatScanTimingBriefLine(diagnostics)).toContain("degradedProviders=none");
    expect(formatScanTimingBriefLine(diagnostics)).toContain("p95Stage=");
    expect(formatScanTimingBriefLine(diagnostics)).toContain("slowestStage=");
  });

  it("summarizes background queue task status and lag in the compact line", () => {
    const collector = new ScanTimingCollector({ dataDir: tmpDir(), persistProgress: false });
    collector.setAsyncQueueDispatchDiagnostics({
      queueBuildMs: 1,
      queueWaitMs: 20,
      workerActiveMs: 40,
      concurrencyUsed: 3,
      taskCount: 3,
      perTaskWaitMs: { p50: 10, p90: 20, max: 20 },
      perTaskRunMs: { p50: 30, p90: 40, max: 40 },
      slowestQueueTasks: [],
      retryDelayMs: 0,
      artificialSleepMs: 0,
      rateLimitWaitMs: 0,
      tasks: [
        {
          name: "tracker.persistScan",
          status: "COMPLETED",
          queuedAt: "2026-06-04T10:00:00.000Z",
          startedAt: "2026-06-04T10:00:00.010Z",
          finishedAt: "2026-06-04T10:00:01.000Z",
          waitMs: 10,
          runMs: 990,
        },
        {
          name: "shadowEngine.processScan",
          status: "RUNNING",
          queuedAt: "2026-06-04T10:00:00.000Z",
          startedAt: "2026-06-04T10:00:01.010Z",
          finishedAt: null,
          waitMs: 1010,
          runMs: null,
        },
        {
          name: "outcomeChecker.checkPending",
          status: "FAILED",
          queuedAt: "2026-06-04T10:00:00.000Z",
          startedAt: "2026-06-04T10:00:02.000Z",
          finishedAt: "2026-06-04T10:00:03.000Z",
          waitMs: 2000,
          runMs: 1000,
          errorMessage: "boom",
        },
      ],
    });

    const diagnostics = collector.finish();

    expect(diagnostics.backgroundQueue).toMatchObject({
      trackerPersist: "completed",
      shadowEngine: "running",
      outcomeChecker: "failed",
      lastCompletedAt: "2026-06-04T10:00:03.000Z",
      lastError: "boom",
    });
    expect(diagnostics.backgroundQueue?.maxLagSec).toEqual(expect.any(Number));
    expect(formatScanTimingBriefLine(diagnostics)).toContain("backgroundQueue=trackerPersist:completed,shadowEngine:running,outcomeChecker:failed");
  });

  it("marks slow and hang stages without changing behavior", () => {
    const stages: ScanTimingStage[] = [
      {
        name: "coreMarketScan",
        invoked: true,
        status: "COMPLETED",
        startedAt: "2026-06-04T10:00:00.000Z",
        finishedAt: "2026-06-04T10:00:00.120Z",
        durationMs: 120,
      },
    ];
    const symbols: ScanSymbolTiming[] = [
      {
        symbol: "BTCUSDT",
        status: "COMPLETED",
        startedAt: "2026-06-04T10:00:00.000Z",
        finishedAt: "2026-06-04T10:00:00.080Z",
        totalMs: 80,
        symbolFetchMs: 80,
        candleFetchMs: 60,
        kronosForecastMs: 10,
        externalSignalFetchMs: 5,
        binanceRetryMs: 0,
        providerWaitMs: 65,
        totalSymbolFetchMs: 80,
        candidateScoringMs: 1,
        activeStage: null,
      },
    ];

    const markers = buildTimingMarkers(stages, symbols, 50, 100);

    expect(markers[0]).toMatchObject({ scope: "stage", name: "coreMarketScan", severity: "HANG" });
    expect(markers.some((marker) => marker.scope === "symbol" && marker.name === "BTCUSDT" && marker.severity === "SLOW")).toBe(true);
  });

  it("persists admission timing trace on latest scan diagnostics", () => {
    const dir = tmpDir();
    const collector = new ScanTimingCollector({ dataDir: dir, persistProgress: false });
    collector.finish();

    recordAdmissionTimingTrace(
      {
        scanFinishedAt: "2026-06-04T10:00:00.000Z",
        candidatesCachedAt: "2026-06-04T10:00:01.000Z",
        allocatorStartedAt: "2026-06-04T10:00:02.000Z",
        allocatorFinishedAt: "2026-06-04T10:00:02.025Z",
        paperAdmissionStartedAt: "2026-06-04T10:00:03.000Z",
        paperAdmissionFinishedAt: "2026-06-04T10:00:03.010Z",
        createdHeadline: 1,
        createdDiagnostic: 2,
      },
      dir,
    );

    const persisted = readLatestScanTimingDiagnostics(dir);
    expect(persisted?.admissionTrace).toMatchObject({ createdHeadline: 1, createdDiagnostic: 2 });
    expect(formatAdmissionTimingBriefLine(persisted?.admissionTrace)).toContain("createdHeadline=1");
  });
});

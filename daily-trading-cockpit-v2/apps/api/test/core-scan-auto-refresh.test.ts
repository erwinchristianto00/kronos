import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCoreScanAutoRefreshController,
  type CoreScanAutoRefreshRunSummary,
} from "../src/lib/core-scan-auto-refresh.js";

function makeSummary(overrides: Partial<CoreScanAutoRefreshRunSummary> = {}): CoreScanAutoRefreshRunSummary {
  return {
    scannedSymbols: 20,
    returnedSymbols: 10,
    marketRegime: "Mixed rotation",
    ...overrides,
  };
}

describe("core scan auto refresh controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once shortly after startup then every configured interval", async () => {
    vi.useFakeTimers();
    const runScanCycle = vi.fn(async () => makeSummary());
    const controller = createCoreScanAutoRefreshController({
      enabled: true,
      intervalMinutes: 7,
      startupDelayMs: 2000,
      runScanCycle,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(runScanCycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(runScanCycle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(runScanCycle).toHaveBeenCalledTimes(3);
  });

  it("does not run when enabled=false", async () => {
    vi.useFakeTimers();
    const runScanCycle = vi.fn(async () => makeSummary());
    const controller = createCoreScanAutoRefreshController({
      enabled: false,
      intervalMinutes: 7,
      startupDelayMs: 100,
      runScanCycle,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runScanCycle).toHaveBeenCalledTimes(0);
    expect(controller.getStatus().lastAutoRefreshStatus).toBe("NEVER_RUN");
  });

  it("calling start() multiple times does not double-schedule", async () => {
    vi.useFakeTimers();
    const runScanCycle = vi.fn(async () => makeSummary());
    const controller = createCoreScanAutoRefreshController({
      enabled: true,
      intervalMinutes: 7,
      startupDelayMs: 1000,
      runScanCycle,
    });
    controller.start();
    controller.start();
    controller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runScanCycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(runScanCycle).toHaveBeenCalledTimes(2);
  });

  it("skips tick and increments skippedWhileRunningCount when previous run is still active", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const runScanCycle = vi.fn(() => new Promise<CoreScanAutoRefreshRunSummary>((resolve) => {
      release = () => resolve(makeSummary());
    }));
    const controller = createCoreScanAutoRefreshController({
      enabled: true,
      intervalMinutes: 7,
      startupDelayMs: 1000,
      runScanCycle,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runScanCycle).toHaveBeenCalledTimes(1);
    expect(controller.getStatus().isRunning).toBe(true);
    // Fire interval while first run is still active
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(runScanCycle).toHaveBeenCalledTimes(1);
    expect(controller.getStatus().skippedWhileRunningCount).toBe(1);
    expect(controller.getStatus().lastAutoRefreshStatus).toBe("SKIPPED_ALREADY_RUNNING");
    // Complete the first run
    release();
    await Promise.resolve();
    expect(controller.getStatus().isRunning).toBe(false);
  });

  it("records SUCCESS status and result summary on successful run", async () => {
    vi.useFakeTimers();
    const summary = makeSummary({ scannedSymbols: 18, returnedSymbols: 8, marketRegime: "Bullish expansion" });
    const runScanCycle = vi.fn(async () => summary);
    const controller = createCoreScanAutoRefreshController({
      enabled: true,
      intervalMinutes: 7,
      startupDelayMs: 500,
      runScanCycle,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(500);
    const status = controller.getStatus();
    expect(status.lastAutoRefreshStatus).toBe("SUCCESS");
    expect(status.lastAutoRefreshResultSummary).toEqual(summary);
    expect(status.lastAutoRefreshError).toBeNull();
    expect(status.lastAutoRefreshFinishedAt).not.toBeNull();
    expect(status.isRunning).toBe(false);
  });

  it("records FAILED status and stores error message on thrown error", async () => {
    vi.useFakeTimers();
    const runScanCycle = vi.fn(async () => {
      throw new Error("Binance timeout");
    });
    const controller = createCoreScanAutoRefreshController({
      enabled: true,
      intervalMinutes: 7,
      startupDelayMs: 500,
      runScanCycle,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(500);
    const status = controller.getStatus();
    expect(status.lastAutoRefreshStatus).toBe("FAILED");
    expect(status.lastAutoRefreshError).toBe("Binance timeout");
    expect(status.isRunning).toBe(false);
  });

  it("stop() cancels the startup timeout so the first run never fires", async () => {
    vi.useFakeTimers();
    const runScanCycle = vi.fn(async () => makeSummary());
    const controller = createCoreScanAutoRefreshController({
      enabled: true,
      intervalMinutes: 7,
      startupDelayMs: 2000,
      runScanCycle,
    });
    controller.start();
    controller.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runScanCycle).toHaveBeenCalledTimes(0);
  });

  it("getStatus() returns a snapshot copy — mutating it does not affect internal state", async () => {
    vi.useFakeTimers();
    const runScanCycle = vi.fn(async () => makeSummary());
    const controller = createCoreScanAutoRefreshController({
      enabled: true,
      intervalMinutes: 7,
      startupDelayMs: 500,
      runScanCycle,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(500);
    const snap1 = controller.getStatus();
    // Mutate the snapshot
    (snap1 as Record<string, unknown>).skippedWhileRunningCount = 999;
    const snap2 = controller.getStatus();
    expect(snap2.skippedWhileRunningCount).toBe(0);
    // Mutate nested summary
    if (snap1.lastAutoRefreshResultSummary) {
      snap1.lastAutoRefreshResultSummary.scannedSymbols = 0;
    }
    const snap3 = controller.getStatus();
    expect(snap3.lastAutoRefreshResultSummary?.scannedSymbols).toBe(20);
  });
});

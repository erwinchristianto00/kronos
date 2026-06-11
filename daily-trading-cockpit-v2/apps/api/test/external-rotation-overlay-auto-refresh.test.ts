import { afterEach, describe, expect, it, vi } from "vitest";

import { createExternalRotationOverlayAutoRefreshController } from "../src/lib/external-rotation-overlay-auto-refresh.js";
import type { ExternalRotationOverlayRefreshResult } from "../src/lib/external-rotation-overlay.js";

function makeRefreshResult(overrides: Partial<ExternalRotationOverlayRefreshResult["diagnostics"]> = {}): ExternalRotationOverlayRefreshResult {
  return {
    generatedAt: "2026-05-15T00:00:00.000Z",
    evidenceEra: "POST_CALIBRATION",
    observations: [],
    diagnostics: {
      generatedAt: "2026-05-15T00:00:00.000Z",
      triggerSource: "AUTO",
      selectionBatchId: "batch",
      observationsConsidered: 8,
      observationsCreated: 6,
      observationsSuppressedAsDuplicate: 2,
      observationsSkippedForInsufficientState: 0,
      rejectedForEconomicDistortionCount: 0,
      observationsResolvedThisRefresh: 5,
      observationsFailedResolution: 0,
      strategyFitSelected: 5,
      metadataBaselineSelected: 5,
      lowFitControlSelected: 0,
      notes: [],
      ...overrides,
    },
  };
}

describe("external rotation overlay auto refresh controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts once, runs shortly after startup, then every configured interval", async () => {
    vi.useFakeTimers();
    const runRefresh = vi.fn(async () => makeRefreshResult());
    const controller = createExternalRotationOverlayAutoRefreshController({
      enabled: true,
      intervalMinutes: 30,
      runRefresh,
    });
    controller.start();
    controller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(runRefresh).toHaveBeenCalledTimes(2);
  });

  it("records skipped ticks when another auto refresh is still running", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const runRefresh = vi.fn(() => new Promise<ExternalRotationOverlayRefreshResult>((resolve) => {
      release = () => resolve(makeRefreshResult());
    }));
    const controller = createExternalRotationOverlayAutoRefreshController({
      enabled: true,
      intervalMinutes: 30,
      runRefresh,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getStatus().isRunning).toBe(true);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(controller.getStatus().lastAutoRefreshStatus).toBe("SKIPPED_ALREADY_RUNNING");
    expect(controller.getStatus().skippedWhileRunningCount).toBe(1);
    release();
    await Promise.resolve();
  });

  it("captures failure state and keeps future runs possible", async () => {
    vi.useFakeTimers();
    let fail = true;
    const runRefresh = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      return makeRefreshResult();
    });
    const controller = createExternalRotationOverlayAutoRefreshController({
      enabled: true,
      intervalMinutes: 30,
      runRefresh,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getStatus().lastAutoRefreshStatus).toBe("FAILED");
    expect(controller.getStatus().lastAutoRefreshError).toContain("boom");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(controller.getStatus().lastAutoRefreshStatus).toBe("SUCCESS");
    expect(controller.getStatus().lastAutoRefreshResultSummary?.created).toBe(6);
  });

  it("shares the same lock with manual refresh and returns already running deterministically", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const runRefresh = vi.fn(() => new Promise<ExternalRotationOverlayRefreshResult>((resolve) => {
      release = () => resolve(makeRefreshResult());
    }));
    const controller = createExternalRotationOverlayAutoRefreshController({
      enabled: true,
      intervalMinutes: 30,
      runRefresh,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(1000);
    const manual = await controller.runManual(async () => "manual");
    expect(manual.status).toBe("ALREADY_RUNNING");
    release();
    await Promise.resolve();
    const manualAfter = await controller.runManual(async () => "manual");
    expect(manualAfter.status).toBe("SUCCESS");
  });
});

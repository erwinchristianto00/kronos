import type { ExternalDiscoveryEvidenceEra } from "./external-candidate-discovery-intelligence.js";
import type { ExternalRotationOverlayRefreshResult } from "./external-rotation-overlay.js";

export type ExternalRotationOverlayAutoRefreshRunStatus =
  | "NEVER_RUN"
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED_ALREADY_RUNNING";

export interface ExternalRotationOverlayAutoRefreshStatus {
  enabled: boolean;
  intervalMinutes: number;
  firstRunPolicy: "IMMEDIATE_AFTER_STARTUP";
  isRunning: boolean;
  skippedWhileRunningCount: number;
  lastAutoRefreshStartedAt: string | null;
  lastAutoRefreshFinishedAt: string | null;
  lastAutoRefreshStatus: ExternalRotationOverlayAutoRefreshRunStatus;
  lastAutoRefreshError: string | null;
  lastAutoRefreshResultSummary: {
    considered: number;
    created: number;
    duplicateSuppressed: number;
    skippedInsufficient: number;
    resolvedThisRefresh: number;
    failedResolution: number;
  } | null;
}

export interface ExternalRotationOverlayAutoRefreshController {
  start(): void;
  stop(): void;
  getStatus(): ExternalRotationOverlayAutoRefreshStatus;
  runManual<T>(task: () => Promise<T>): Promise<{ status: "SUCCESS"; value: T } | { status: "ALREADY_RUNNING" }>;
}

export function createExternalRotationOverlayAutoRefreshController(opts: {
  enabled: boolean;
  intervalMinutes: number;
  startupDelayMs?: number;
  evidenceEra?: ExternalDiscoveryEvidenceEra;
  runRefresh: (evidenceEra: ExternalDiscoveryEvidenceEra, triggerSource: "AUTO" | "MANUAL") => Promise<ExternalRotationOverlayRefreshResult>;
}): ExternalRotationOverlayAutoRefreshController {
  const intervalMinutes = Number.isFinite(opts.intervalMinutes) && opts.intervalMinutes > 0 ? Math.max(1, Math.round(opts.intervalMinutes)) : 30;
  const startupDelayMs = opts.startupDelayMs ?? 1000;
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  let started = false;
  let intervalHandle: NodeJS.Timeout | null = null;
  let startupHandle: NodeJS.Timeout | null = null;
  let isRunning = false;

  const status: ExternalRotationOverlayAutoRefreshStatus = {
    enabled: opts.enabled,
    intervalMinutes,
    firstRunPolicy: "IMMEDIATE_AFTER_STARTUP",
    isRunning: false,
    skippedWhileRunningCount: 0,
    lastAutoRefreshStartedAt: null,
    lastAutoRefreshFinishedAt: null,
    lastAutoRefreshStatus: "NEVER_RUN",
    lastAutoRefreshError: null,
    lastAutoRefreshResultSummary: null,
  };

  async function runAutoTick(): Promise<void> {
    if (isRunning) {
      status.skippedWhileRunningCount += 1;
      status.lastAutoRefreshStatus = "SKIPPED_ALREADY_RUNNING";
      status.lastAutoRefreshFinishedAt = new Date().toISOString();
      return;
    }
    isRunning = true;
    status.isRunning = true;
    status.lastAutoRefreshStartedAt = new Date().toISOString();
    status.lastAutoRefreshError = null;
    try {
      const refresh = await opts.runRefresh(evidenceEra, "AUTO");
      status.lastAutoRefreshStatus = "SUCCESS";
      status.lastAutoRefreshFinishedAt = new Date().toISOString();
      status.lastAutoRefreshResultSummary = {
        considered: refresh.diagnostics.observationsConsidered,
        created: refresh.diagnostics.observationsCreated,
        duplicateSuppressed: refresh.diagnostics.observationsSuppressedAsDuplicate,
        skippedInsufficient: refresh.diagnostics.observationsSkippedForInsufficientState,
        resolvedThisRefresh: refresh.diagnostics.observationsResolvedThisRefresh,
        failedResolution: refresh.diagnostics.observationsFailedResolution,
      };
    } catch (error) {
      status.lastAutoRefreshStatus = "FAILED";
      status.lastAutoRefreshFinishedAt = new Date().toISOString();
      status.lastAutoRefreshError = error instanceof Error ? error.message : "Unknown error";
    } finally {
      isRunning = false;
      status.isRunning = false;
    }
  }

  return {
    start() {
      if (started || !opts.enabled) return;
      started = true;
      startupHandle = setTimeout(() => {
        void runAutoTick();
      }, startupDelayMs);
      intervalHandle = setInterval(() => {
        void runAutoTick();
      }, intervalMinutes * 60_000);
    },
    stop() {
      if (startupHandle) {
        clearTimeout(startupHandle);
        startupHandle = null;
      }
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      started = false;
    },
    getStatus() {
      return { ...status, lastAutoRefreshResultSummary: status.lastAutoRefreshResultSummary ? { ...status.lastAutoRefreshResultSummary } : null };
    },
    async runManual<T>(task: () => Promise<T>) {
      if (isRunning) {
        return { status: "ALREADY_RUNNING" } as const;
      }
      isRunning = true;
      status.isRunning = true;
      try {
        const value = await task();
        return { status: "SUCCESS", value } as const;
      } finally {
        isRunning = false;
        status.isRunning = false;
      }
    },
  };
}

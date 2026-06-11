export type CoreScanAutoRefreshRunStatus =
  | "NEVER_RUN"
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED_ALREADY_RUNNING";

export interface CoreScanAutoRefreshRunSummary {
  scannedSymbols: number;
  returnedSymbols: number;
  marketRegime: string;
}

export interface CoreScanAutoRefreshStatus {
  enabled: boolean;
  intervalMinutes: number;
  firstRunPolicy: "IMMEDIATE_AFTER_STARTUP";
  isRunning: boolean;
  skippedWhileRunningCount: number;
  lastAutoRefreshStartedAt: string | null;
  lastAutoRefreshFinishedAt: string | null;
  lastAutoRefreshStatus: CoreScanAutoRefreshRunStatus;
  lastAutoRefreshError: string | null;
  lastAutoRefreshResultSummary: CoreScanAutoRefreshRunSummary | null;
}

export interface CoreScanAutoRefreshController {
  start(): void;
  stop(): void;
  getStatus(): CoreScanAutoRefreshStatus;
}

export function createCoreScanAutoRefreshController(opts: {
  enabled: boolean;
  intervalMinutes: number;
  startupDelayMs?: number;
  runScanCycle: () => Promise<CoreScanAutoRefreshRunSummary>;
}): CoreScanAutoRefreshController {
  const intervalMinutes =
    Number.isFinite(opts.intervalMinutes) && opts.intervalMinutes > 0
      ? Math.max(1, Math.round(opts.intervalMinutes))
      : 7;
  const startupDelayMs = opts.startupDelayMs ?? 2000;
  let started = false;
  let intervalHandle: NodeJS.Timeout | null = null;
  let startupHandle: NodeJS.Timeout | null = null;
  let isRunning = false;

  const status: CoreScanAutoRefreshStatus = {
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
      const summary = await opts.runScanCycle();
      status.lastAutoRefreshStatus = "SUCCESS";
      status.lastAutoRefreshFinishedAt = new Date().toISOString();
      status.lastAutoRefreshResultSummary = summary;
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
      return {
        ...status,
        lastAutoRefreshResultSummary: status.lastAutoRefreshResultSummary
          ? { ...status.lastAutoRefreshResultSummary }
          : null,
      };
    },
  };
}

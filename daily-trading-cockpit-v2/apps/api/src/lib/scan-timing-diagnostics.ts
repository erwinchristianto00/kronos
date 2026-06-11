import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ScanTimingStatus = "RUNNING" | "COMPLETED" | "FAILED";
export type ScanTimingStageStatus = ScanTimingStatus | "NOT_INVOKED";
export type ScanTimingMarkerSeverity = "SLOW" | "HANG";

export interface ScanTimingMarker {
  scope: "stage" | "symbol";
  name: string;
  stage?: string;
  severity: ScanTimingMarkerSeverity;
  elapsedMs: number;
  thresholdMs: number;
  status: ScanTimingStageStatus;
}

export interface ScanTimingStage {
  name: string;
  invoked: boolean;
  status: ScanTimingStageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  runningElapsedMs?: number;
}

export interface ScanSymbolTiming {
  symbol: string;
  status: ScanTimingStatus;
  startedAt: string;
  finishedAt: string | null;
  totalMs: number | null;
  symbolFetchMs: number | null;
  candleFetchMs: number | null;
  kronosForecastMs: number | null;
  externalSignalFetchMs: number | null;
  binanceRetryMs: number | null;
  providerWaitMs: number | null;
  totalSymbolFetchMs: number | null;
  candidateScoringMs: number | null;
  activeStage: string | null;
  failureStage?: string | null;
  failureReason?: string | null;
}

export interface ScanStageSummary {
  p95Stage: { name: string; durationMs: number } | null;
  slowestStage: { name: string; durationMs: number } | null;
}

export interface AdmissionTimingTrace {
  scanFinishedAt: string | null;
  candidatesCachedAt: string | null;
  allocatorStartedAt: string | null;
  allocatorFinishedAt: string | null;
  paperAdmissionStartedAt: string | null;
  paperAdmissionFinishedAt: string | null;
  createdHeadline: number;
  createdDiagnostic: number;
}

export interface AnalysisPerformanceTimingDiagnostics {
  cacheHit: boolean;
  inputSignatureMs: number;
  readAllRawMs: number;
  computePerformanceMs: number;
  totalMs: number;
  candidateNormalizationMs: number | null;
  indicatorAggregationMs: number | null;
  replayVariantAnalysisMs: number | null;
  calibrationMs: number | null;
  routeReasonEvaluationMs: number | null;
  rankingMs: number | null;
  filterGateMs: number | null;
  loggingSerializationMs: number | null;
  diagnosticsBuildMs: number | null;
}

export interface QueueTaskTimingDiagnostics {
  name: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  waitMs: number | null;
  runMs: number | null;
  errorMessage?: string | null;
}

export interface AsyncQueueDispatchTimingDiagnostics {
  queueBuildMs: number;
  queueWaitMs: number | null;
  workerActiveMs: number | null;
  concurrencyUsed: number;
  taskCount: number;
  perTaskWaitMs: { p50: number | null; p90: number | null; max: number | null };
  perTaskRunMs: { p50: number | null; p90: number | null; max: number | null };
  slowestQueueTasks: QueueTaskTimingDiagnostics[];
  retryDelayMs: number;
  artificialSleepMs: number;
  rateLimitWaitMs: number;
  tasks: QueueTaskTimingDiagnostics[];
}

export type BackgroundQueueTaskStatus = "not_queued" | "queued" | "running" | "completed" | "failed";

export interface BackgroundQueueStatusDiagnostics {
  trackerPersist: BackgroundQueueTaskStatus;
  shadowEngine: BackgroundQueueTaskStatus;
  outcomeChecker: BackgroundQueueTaskStatus;
  lastCompletedAt: string | null;
  lastError: string | null;
  maxLagSec: number | null;
}

export interface DegradedProviderDiagnostics {
  provider: string;
  reason: string;
  timeoutMs: number | null;
  remainingScanSkips: number;
  triggeredAt: string;
}

export interface ScanTimingDiagnostics {
  version: "scan-timing-diagnostics-v1";
  scanBatchId: string;
  status: ScanTimingStatus;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  totalScanMs: number | null;
  activeStage: string | null;
  activeSymbols: Array<{ symbol: string; stage: string; runningElapsedMs: number }>;
  stages: ScanTimingStage[];
  totals: {
    symbolFetchMs: number | null;
    candleFetchMs: number | null;
    kronosForecastMs: number | null;
    externalOverlayMs: number | null;
    externalSignalFetchMs: number | null;
    binanceRetryMs: number | null;
    providerWaitMs: number | null;
    totalSymbolFetchMs: number | null;
    candidateScoringMs: number | null;
    regimeControllerMs: number | null;
    allocatorAdmissionMs: number | null;
  };
  symbolFetchMs: Record<string, number | null>;
  symbols: ScanSymbolTiming[];
  slowestSymbols: ScanSymbolTiming[];
  stageSummary: ScanStageSummary;
  markers: ScanTimingMarker[];
  analysisPerformance?: AnalysisPerformanceTimingDiagnostics;
  asyncQueueDispatch?: AsyncQueueDispatchTimingDiagnostics;
  backgroundQueue?: BackgroundQueueStatusDiagnostics;
  degradedProviders?: DegradedProviderDiagnostics[];
  admissionTrace?: AdmissionTimingTrace;
  failureReason?: string | null;
}

export interface ScanSymbolTimingSample {
  symbol: string;
  status: ScanTimingStatus;
  totalMs: number | null;
  candleFetchMs: number | null;
  kronosForecastMs: number | null;
  externalSignalFetchMs: number | null;
  binanceRetryMs?: number | null;
  providerWaitMs?: number | null;
  totalSymbolFetchMs?: number | null;
  candidateScoringMs: number | null;
  failureStage?: string | null;
  failureReason?: string | null;
}

export interface ScanTimingObserver {
  startStage(name: string): void;
  finishStage(name: string, status?: ScanTimingStatus): void;
  recordNotInvokedStage(name: string): void;
  markSymbolStage(symbol: string, stage: string): void;
  recordSymbolTiming(sample: ScanSymbolTimingSample): void;
  recordDegradedProvider?(provider: DegradedProviderDiagnostics): void;
}

interface MutableStage {
  name: string;
  invoked: boolean;
  status: ScanTimingStageStatus;
  startedAt: string | null;
  startedMs: number | null;
  finishedAt: string | null;
  durationMs: number | null;
}

interface MutableSymbol {
  symbol: string;
  status: ScanTimingStatus;
  startedAt: string;
  startedMs: number;
  finishedAt: string | null;
  totalMs: number | null;
  candleFetchMs: number | null;
  kronosForecastMs: number | null;
  externalSignalFetchMs: number | null;
  binanceRetryMs: number | null;
  providerWaitMs: number | null;
  totalSymbolFetchMs: number | null;
  candidateScoringMs: number | null;
  activeStage: string | null;
  activeStageStartedMs: number | null;
  failureStage?: string | null;
  failureReason?: string | null;
}

const FILE_NAME = "scan-timing-diagnostics.json";
const DEFAULT_SLOW_STAGE_MS = 10_000;
const DEFAULT_HANG_STAGE_MS = 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function nowMs(): number {
  return Date.now();
}

function positiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timingFilePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function durationBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const ms = end - start;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function sum(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return roundMs(finite.reduce((acc, value) => acc + value, 0));
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[index] ?? null;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatShortIso(value: string | null): string {
  return value ? `${value.slice(11, 19)}Z` : "n/a";
}

function taskStatusOf(
  asyncQueue: AsyncQueueDispatchTimingDiagnostics | undefined,
  name: string,
): BackgroundQueueTaskStatus {
  const task = asyncQueue?.tasks.find((item) => item.name === name);
  if (!task) return "not_queued";
  if (task.status === "QUEUED") return "queued";
  if (task.status === "RUNNING") return "running";
  if (task.status === "COMPLETED") return "completed";
  return "failed";
}

function maxTaskLagSec(tasks: QueueTaskTimingDiagnostics[], now: string): number | null {
  let maxLagMs: number | null = null;
  const nowMsValue = new Date(now).getTime();
  for (const task of tasks) {
    const queuedMs = new Date(task.queuedAt).getTime();
    const endMs = task.finishedAt ? new Date(task.finishedAt).getTime() : nowMsValue;
    if (!Number.isFinite(queuedMs) || !Number.isFinite(endMs) || endMs < queuedMs) continue;
    const lagMs = endMs - queuedMs;
    maxLagMs = maxLagMs === null ? lagMs : Math.max(maxLagMs, lagMs);
  }
  return maxLagMs === null ? null : roundMs(maxLagMs / 1000);
}

function buildBackgroundQueueStatus(
  asyncQueue: AsyncQueueDispatchTimingDiagnostics | undefined,
  updatedAt: string,
): BackgroundQueueStatusDiagnostics | undefined {
  if (!asyncQueue) return undefined;
  const completedAt = asyncQueue.tasks
    .map((task) => task.finishedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const lastError = asyncQueue.tasks
    .filter((task) => task.status === "FAILED" && task.errorMessage)
    .map((task) => task.errorMessage!)
    .at(-1) ?? null;
  return {
    trackerPersist: taskStatusOf(asyncQueue, "tracker.persistScan"),
    shadowEngine: taskStatusOf(asyncQueue, "shadowEngine.processScan"),
    outcomeChecker: taskStatusOf(asyncQueue, "outcomeChecker.checkPending"),
    lastCompletedAt: completedAt,
    lastError,
    maxLagSec: maxTaskLagSec(asyncQueue.tasks, updatedAt),
  };
}

export function persistLatestScanTimingDiagnostics(diagnostics: ScanTimingDiagnostics, dataDir = "data"): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(timingFilePath(dataDir), JSON.stringify(diagnostics, null, 2));
}

export function readLatestScanTimingDiagnostics(dataDir = "data"): ScanTimingDiagnostics | null {
  const file = timingFilePath(dataDir);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf-8").trim();
  if (!raw) return null;
  return JSON.parse(raw) as ScanTimingDiagnostics;
}

let latestScanTimingDiagnostics: ScanTimingDiagnostics | null = null;

export function getLatestScanTimingDiagnostics(): ScanTimingDiagnostics | null {
  if (latestScanTimingDiagnostics) return latestScanTimingDiagnostics;
  try {
    latestScanTimingDiagnostics = readLatestScanTimingDiagnostics();
  } catch {
    latestScanTimingDiagnostics = null;
  }
  return latestScanTimingDiagnostics;
}

export function _resetLatestScanTimingDiagnosticsForTests(): void {
  latestScanTimingDiagnostics = null;
}

export function recordAdmissionTimingTrace(trace: AdmissionTimingTrace, dataDir = "data"): void {
  let diagnostics =
    dataDir === "data"
      ? getLatestScanTimingDiagnostics()
      : (() => {
          try {
            return readLatestScanTimingDiagnostics(dataDir);
          } catch {
            return null;
          }
        })();
  if (!diagnostics) {
    const ts = nowIso();
    diagnostics = {
      version: "scan-timing-diagnostics-v1",
      scanBatchId: trace.scanFinishedAt ?? "no-scan",
      status: "COMPLETED",
      startedAt: trace.scanFinishedAt ?? ts,
      finishedAt: trace.scanFinishedAt ?? ts,
      updatedAt: ts,
      totalScanMs: null,
      activeStage: null,
      activeSymbols: [],
      stages: [],
      totals: {
        symbolFetchMs: null,
        candleFetchMs: null,
        kronosForecastMs: null,
        externalOverlayMs: null,
        externalSignalFetchMs: null,
        binanceRetryMs: null,
        providerWaitMs: null,
        totalSymbolFetchMs: null,
        candidateScoringMs: null,
        regimeControllerMs: null,
        allocatorAdmissionMs: null,
      },
      symbolFetchMs: {},
      symbols: [],
      slowestSymbols: [],
      stageSummary: { p95Stage: null, slowestStage: null },
      markers: [],
    };
  }
  diagnostics = {
    ...diagnostics,
    updatedAt: nowIso(),
    admissionTrace: trace,
  };
  latestScanTimingDiagnostics = diagnostics;
  persistLatestScanTimingDiagnostics(diagnostics, dataDir);
}

export class ScanTimingCollector implements ScanTimingObserver {
  private readonly startedAt = nowIso();
  private readonly startedMs = nowMs();
  private readonly stages = new Map<string, MutableStage>();
  private readonly symbols = new Map<string, MutableSymbol>();
  private readonly slowThresholdMs: number;
  private readonly hangThresholdMs: number;
  private activeStage: string | null = null;
  private status: ScanTimingStatus = "RUNNING";
  private finishedAt: string | null = null;
  private scanBatchId: string;
  private failureReason: string | null = null;
  private admissionTrace: AdmissionTimingTrace | undefined;
  private analysisPerformance: AnalysisPerformanceTimingDiagnostics | undefined;
  private asyncQueueDispatch: AsyncQueueDispatchTimingDiagnostics | undefined;
  private degradedProviders = new Map<string, DegradedProviderDiagnostics>();
  private pendingPersist: ReturnType<typeof setImmediate> | null = null;
  private pendingDiagnostics: ScanTimingDiagnostics | null = null;

  constructor(
    opts: {
      scanBatchId?: string;
      dataDir?: string;
      persistProgress?: boolean;
      slowThresholdMs?: number;
      hangThresholdMs?: number;
    } = {},
  ) {
    this.scanBatchId = opts.scanBatchId ?? this.startedAt;
    this.dataDir = opts.dataDir ?? "data";
    this.persistProgress = opts.persistProgress ?? true;
    this.slowThresholdMs = opts.slowThresholdMs ?? positiveEnvInt(process.env.SCAN_TIMING_SLOW_STAGE_MS, DEFAULT_SLOW_STAGE_MS);
    this.hangThresholdMs = opts.hangThresholdMs ?? positiveEnvInt(process.env.SCAN_TIMING_HANG_STAGE_MS, DEFAULT_HANG_STAGE_MS);
    this.persistSnapshot();
  }

  private readonly dataDir: string;
  private readonly persistProgress: boolean;

  setScanBatchId(scanBatchId: string): void {
    this.scanBatchId = scanBatchId;
    this.persistSnapshot();
  }

  setAdmissionTrace(trace: AdmissionTimingTrace): void {
    this.admissionTrace = trace;
    this.persistSnapshot();
  }

  setAnalysisPerformanceDiagnostics(diagnostics: AnalysisPerformanceTimingDiagnostics): void {
    this.analysisPerformance = diagnostics;
    this.persistSnapshot();
  }

  setAsyncQueueDispatchDiagnostics(diagnostics: AsyncQueueDispatchTimingDiagnostics): void {
    this.asyncQueueDispatch = diagnostics;
    this.persistSnapshot();
  }

  recordDegradedProvider(provider: DegradedProviderDiagnostics): void {
    this.degradedProviders.set(provider.provider, provider);
    this.persistSnapshot();
  }

  startStage(name: string): void {
    const ts = nowIso();
    this.stages.set(name, {
      name,
      invoked: true,
      status: "RUNNING",
      startedAt: ts,
      startedMs: nowMs(),
      finishedAt: null,
      durationMs: null,
    });
    this.activeStage = name;
    this.scheduleProgressCheck("stage", name, undefined, this.slowThresholdMs);
    this.scheduleProgressCheck("stage", name, undefined, this.hangThresholdMs);
    this.persistSnapshot();
  }

  finishStage(name: string, status: ScanTimingStatus = "COMPLETED"): void {
    const stage = this.stages.get(name);
    if (!stage) return;
    const endedMs = nowMs();
    stage.status = status;
    stage.finishedAt = nowIso();
    stage.durationMs = stage.startedMs === null ? null : roundMs(endedMs - stage.startedMs);
    if (this.activeStage === name) this.activeStage = null;
    this.persistSnapshot();
  }

  recordNotInvokedStage(name: string): void {
    this.stages.set(name, {
      name,
      invoked: false,
      status: "NOT_INVOKED",
      startedAt: null,
      startedMs: null,
      finishedAt: null,
      durationMs: 0,
    });
    this.persistSnapshot();
  }

  async measureStage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.startStage(name);
    try {
      const result = await fn();
      this.finishStage(name);
      return result;
    } catch (error) {
      this.finishStage(name, "FAILED");
      throw error;
    }
  }

  measureSyncStage<T>(name: string, fn: () => T): T {
    this.startStage(name);
    try {
      const result = fn();
      this.finishStage(name);
      return result;
    } catch (error) {
      this.finishStage(name, "FAILED");
      throw error;
    }
  }

  markSymbolStage(symbol: string, stage: string): void {
    const ts = nowIso();
    const existing = this.symbols.get(symbol);
    const mutable: MutableSymbol =
      existing ??
      {
        symbol,
        status: "RUNNING",
        startedAt: ts,
        startedMs: nowMs(),
        finishedAt: null,
        totalMs: null,
        candleFetchMs: null,
        kronosForecastMs: null,
        externalSignalFetchMs: null,
        binanceRetryMs: null,
        providerWaitMs: null,
        totalSymbolFetchMs: null,
        candidateScoringMs: null,
        activeStage: null,
        activeStageStartedMs: null,
      };
    mutable.status = "RUNNING";
    mutable.activeStage = stage;
    mutable.activeStageStartedMs = nowMs();
    this.symbols.set(symbol, mutable);
    this.scheduleProgressCheck("symbol", symbol, stage, this.slowThresholdMs);
    this.scheduleProgressCheck("symbol", symbol, stage, this.hangThresholdMs);
    this.persistSnapshot();
  }

  recordSymbolTiming(sample: ScanSymbolTimingSample): void {
    const existing = this.symbols.get(sample.symbol);
    const startedAt = existing?.startedAt ?? nowIso();
    const startedMs = existing?.startedMs ?? nowMs();
    this.symbols.set(sample.symbol, {
      symbol: sample.symbol,
      status: sample.status,
      startedAt,
      startedMs,
      finishedAt: nowIso(),
      totalMs: sample.totalMs,
      candleFetchMs: sample.candleFetchMs,
      kronosForecastMs: sample.kronosForecastMs,
      externalSignalFetchMs: sample.externalSignalFetchMs,
      binanceRetryMs: sample.binanceRetryMs ?? null,
      providerWaitMs: sample.providerWaitMs ?? null,
      totalSymbolFetchMs: sample.totalSymbolFetchMs ?? sample.totalMs,
      candidateScoringMs: sample.candidateScoringMs,
      activeStage: null,
      activeStageStartedMs: null,
      failureStage: sample.failureStage ?? null,
      failureReason: sample.failureReason ?? null,
    });
    this.persistSnapshot();
  }

  finish(status: ScanTimingStatus = "COMPLETED", failureReason?: string): ScanTimingDiagnostics {
    this.status = status;
    this.finishedAt = nowIso();
    this.failureReason = failureReason ?? null;
    this.cancelPendingPersist();
    const diagnostics = this.snapshot();
    latestScanTimingDiagnostics = diagnostics;
    persistLatestScanTimingDiagnostics(diagnostics, this.dataDir);
    return diagnostics;
  }

  snapshot(): ScanTimingDiagnostics {
    const ts = nowIso();
    const activeSymbols = [...this.symbols.values()]
      .filter((symbol) => symbol.status === "RUNNING" && symbol.activeStage && symbol.activeStageStartedMs !== null)
      .map((symbol) => ({
        symbol: symbol.symbol,
        stage: symbol.activeStage!,
        runningElapsedMs: roundMs(nowMs() - symbol.activeStageStartedMs!),
      }))
      .sort((a, b) => b.runningElapsedMs - a.runningElapsedMs);

    const stages = [...this.stages.values()].map((stage): ScanTimingStage => {
      const runningElapsedMs =
        stage.status === "RUNNING" && stage.startedMs !== null ? roundMs(nowMs() - stage.startedMs) : undefined;
      return {
        name: stage.name,
        invoked: stage.invoked,
        status: stage.status,
        startedAt: stage.startedAt,
        finishedAt: stage.finishedAt,
        durationMs: stage.durationMs,
        ...(runningElapsedMs !== undefined ? { runningElapsedMs } : {}),
      };
    });
    const symbols = [...this.symbols.values()].map((symbol): ScanSymbolTiming => ({
      symbol: symbol.symbol,
      status: symbol.status,
      startedAt: symbol.startedAt,
      finishedAt: symbol.finishedAt,
      totalMs: symbol.totalMs,
      symbolFetchMs: symbol.totalMs,
      candleFetchMs: symbol.candleFetchMs,
      kronosForecastMs: symbol.kronosForecastMs,
      externalSignalFetchMs: symbol.externalSignalFetchMs,
      binanceRetryMs: symbol.binanceRetryMs,
      providerWaitMs: symbol.providerWaitMs,
      totalSymbolFetchMs: symbol.totalSymbolFetchMs ?? symbol.totalMs,
      candidateScoringMs: symbol.candidateScoringMs,
      activeStage: symbol.activeStage,
      failureStage: symbol.failureStage ?? null,
      failureReason: symbol.failureReason ?? null,
    }));
    const slowestSymbols = [...symbols]
      .filter((symbol) => typeof symbol.symbolFetchMs === "number")
      .sort((a, b) => (b.symbolFetchMs ?? 0) - (a.symbolFetchMs ?? 0))
      .slice(0, 5);
    const symbolFetchMs = Object.fromEntries(symbols.map((symbol) => [symbol.symbol, symbol.symbolFetchMs]));
    const stageSummary = buildStageSummary(stages, symbols);
    const totalScanMs =
      this.finishedAt !== null
        ? durationBetween(this.startedAt, this.finishedAt)
        : this.status === "RUNNING"
          ? roundMs(nowMs() - this.startedMs)
          : null;
    const markers = buildTimingMarkers(stages, symbols, this.slowThresholdMs, this.hangThresholdMs);
    if (typeof totalScanMs === "number" && totalScanMs >= 60_000) {
      markers.push({
        scope: "stage",
        name: totalScanMs >= 150_000 ? "totalScan:near-timeout" : "totalScan",
        severity: "HANG",
        elapsedMs: totalScanMs,
        thresholdMs: totalScanMs >= 150_000 ? 150_000 : 60_000,
        status: this.status,
      });
      markers.sort((a, b) => b.elapsedMs - a.elapsedMs);
    }
    const externalOverlayStage = stages.find((stage) => stage.name === "externalOverlay");
    const regimeControllerStage = stages.find((stage) => stage.name === "regimeController");
    const allocatorAdmissionStage = stages.find((stage) => stage.name === "allocatorAdmission");
    const backgroundQueue = buildBackgroundQueueStatus(this.asyncQueueDispatch, ts);

    return {
      version: "scan-timing-diagnostics-v1",
      scanBatchId: this.scanBatchId,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      updatedAt: ts,
      totalScanMs,
      activeStage: this.activeStage,
      activeSymbols,
      stages,
      totals: {
        symbolFetchMs: sum(symbols.map((symbol) => symbol.symbolFetchMs)),
        candleFetchMs: sum(symbols.map((symbol) => symbol.candleFetchMs)),
        kronosForecastMs: sum(symbols.map((symbol) => symbol.kronosForecastMs)),
        externalOverlayMs: externalOverlayStage?.durationMs ?? null,
        externalSignalFetchMs: sum(symbols.map((symbol) => symbol.externalSignalFetchMs)),
        binanceRetryMs: sum(symbols.map((symbol) => symbol.binanceRetryMs)),
        providerWaitMs: sum(symbols.map((symbol) => symbol.providerWaitMs)),
        totalSymbolFetchMs: sum(symbols.map((symbol) => symbol.totalSymbolFetchMs)),
        candidateScoringMs: sum(symbols.map((symbol) => symbol.candidateScoringMs)),
        regimeControllerMs: regimeControllerStage?.durationMs ?? null,
        allocatorAdmissionMs: allocatorAdmissionStage?.durationMs ?? null,
      },
      symbolFetchMs,
      symbols,
      slowestSymbols,
      stageSummary,
      markers,
      ...(this.analysisPerformance ? { analysisPerformance: this.analysisPerformance } : {}),
      ...(this.asyncQueueDispatch ? { asyncQueueDispatch: this.asyncQueueDispatch } : {}),
      ...(backgroundQueue ? { backgroundQueue } : {}),
      ...(this.degradedProviders.size > 0 ? { degradedProviders: [...this.degradedProviders.values()] } : {}),
      ...(this.admissionTrace ? { admissionTrace: this.admissionTrace } : {}),
      ...(this.failureReason ? { failureReason: this.failureReason } : {}),
    };
  }

  private persistSnapshot(): void {
    if (!this.persistProgress) return;
    try {
      const diagnostics = this.snapshot();
      latestScanTimingDiagnostics = diagnostics;
      this.pendingDiagnostics = diagnostics;
      if (this.pendingPersist) return;
      this.pendingPersist = setImmediate(() => {
        const pending = this.pendingDiagnostics;
        this.pendingDiagnostics = null;
        this.pendingPersist = null;
        if (!pending) return;
        try {
          persistLatestScanTimingDiagnostics(pending, this.dataDir);
        } catch {
          // Timing persistence is diagnostics-only and must never affect scan behavior.
        }
      });
      this.pendingPersist.unref?.();
    } catch {
      // Timing persistence is diagnostics-only and must never affect scan behavior.
    }
  }

  private cancelPendingPersist(): void {
    if (this.pendingPersist) {
      clearImmediate(this.pendingPersist);
      this.pendingPersist = null;
    }
    this.pendingDiagnostics = null;
  }

  private scheduleProgressCheck(scope: "stage" | "symbol", name: string, stage: string | undefined, delayMs: number): void {
    const timer = setTimeout(() => {
      try {
        if (scope === "stage") {
          const current = this.stages.get(name);
          if (current?.status === "RUNNING") this.persistSnapshot();
          return;
        }
        const symbol = this.symbols.get(name);
        if (symbol?.status === "RUNNING" && symbol.activeStage === stage) this.persistSnapshot();
      } catch {
        // Report-only timer.
      }
    }, delayMs);
    timer.unref?.();
  }
}

export function buildStageSummary(stages: ScanTimingStage[], symbols: ScanSymbolTiming[]): ScanStageSummary {
  const samples: Array<{ name: string; durationMs: number }> = [];
  for (const stage of stages) {
    if (typeof stage.durationMs === "number" && stage.invoked) {
      samples.push({ name: stage.name, durationMs: stage.durationMs });
    }
    if (typeof stage.runningElapsedMs === "number") {
      samples.push({ name: `${stage.name}:running`, durationMs: stage.runningElapsedMs });
    }
  }
  for (const symbol of symbols) {
    const parts: Array<[string, number | null]> = [
      [`symbol:${symbol.symbol}`, symbol.symbolFetchMs],
      [`symbol:${symbol.symbol}:candleFetch`, symbol.candleFetchMs],
      [`symbol:${symbol.symbol}:kronosForecast`, symbol.kronosForecastMs],
      [`symbol:${symbol.symbol}:externalSignalFetch`, symbol.externalSignalFetchMs],
      [`symbol:${symbol.symbol}:candidateScoring`, symbol.candidateScoringMs],
    ];
    for (const [name, durationMs] of parts) {
      if (typeof durationMs === "number" && Number.isFinite(durationMs)) samples.push({ name, durationMs });
    }
  }
  if (samples.length === 0) return { p95Stage: null, slowestStage: null };
  const sortedDurations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const p95Duration = percentile(sortedDurations, 95);
  const p95Stage =
    p95Duration === null
      ? null
      : [...samples].sort((a, b) => Math.abs(a.durationMs - p95Duration) - Math.abs(b.durationMs - p95Duration))[0] ?? null;
  const slowestStage = [...samples].sort((a, b) => b.durationMs - a.durationMs)[0] ?? null;
  return { p95Stage, slowestStage };
}

export function buildTimingMarkers(
  stages: ScanTimingStage[],
  symbols: ScanSymbolTiming[],
  slowThresholdMs = DEFAULT_SLOW_STAGE_MS,
  hangThresholdMs = DEFAULT_HANG_STAGE_MS,
): ScanTimingMarker[] {
  const markers: ScanTimingMarker[] = [];
  const add = (marker: Omit<ScanTimingMarker, "severity" | "thresholdMs"> & { elapsedMs: number }) => {
    if (marker.elapsedMs >= hangThresholdMs) {
      markers.push({ ...marker, severity: "HANG", thresholdMs: hangThresholdMs });
    } else if (marker.elapsedMs >= slowThresholdMs) {
      markers.push({ ...marker, severity: "SLOW", thresholdMs: slowThresholdMs });
    }
  };
  for (const stage of stages) {
    const elapsedMs = stage.durationMs ?? stage.runningElapsedMs;
    if (typeof elapsedMs === "number") {
      const stageSlowThreshold =
        stage.name === "analysisPerformance" ? 8_000 :
        stage.name === "asyncQueueDispatch" ? 10_000 :
        slowThresholdMs;
      const stageHangThreshold =
        stage.name === "analysisPerformance" ? 60_000 :
        stage.name === "asyncQueueDispatch" ? 60_000 :
        hangThresholdMs;
      if (elapsedMs >= stageHangThreshold) {
        markers.push({ scope: "stage", name: stage.name, elapsedMs, status: stage.status, severity: "HANG", thresholdMs: stageHangThreshold });
      } else if (elapsedMs >= stageSlowThreshold) {
        markers.push({ scope: "stage", name: stage.name, elapsedMs, status: stage.status, severity: "SLOW", thresholdMs: stageSlowThreshold });
      }
    }
  }
  for (const symbol of symbols) {
    const elapsedMs =
      symbol.status === "RUNNING"
        ? symbol.finishedAt === null
          ? durationBetween(symbol.startedAt, nowIso())
          : symbol.symbolFetchMs
        : symbol.symbolFetchMs;
    if (typeof elapsedMs === "number") {
      add({
        scope: "symbol",
        name: symbol.symbol,
        stage: symbol.activeStage ?? symbol.failureStage ?? undefined,
        elapsedMs,
        status: symbol.status,
      });
    }
  }
  return markers.sort((a, b) => b.elapsedMs - a.elapsedMs);
}

export function formatScanTimingBriefLine(diagnostics: ScanTimingDiagnostics | null | undefined): string {
  if (!diagnostics) return "scanTiming: unavailable";
  const p95 = diagnostics.stageSummary.p95Stage;
  const slowest = diagnostics.stageSummary.slowestStage;
  const marker = diagnostics.markers[0];
  const asyncQueue = diagnostics.asyncQueueDispatch;
  const backgroundQueue = diagnostics.backgroundQueue;
  const analysis = diagnostics.analysisPerformance;
  const slowestSymbol = diagnostics.slowestSymbols[0];
  const coreStage = diagnostics.stages.find((stage) => stage.name === "coreMarketScan");
  const providerSamples = [
    { name: "candleFetch", durationMs: diagnostics.totals.candleFetchMs },
    { name: "externalSignalFetch", durationMs: diagnostics.totals.externalSignalFetchMs },
    { name: "kronosForecast", durationMs: diagnostics.totals.kronosForecastMs },
    { name: "providerWait", durationMs: diagnostics.totals.providerWaitMs },
    { name: "binanceRetry", durationMs: diagnostics.totals.binanceRetryMs },
  ]
    .filter((sample): sample is { name: string; durationMs: number } => typeof sample.durationMs === "number" && Number.isFinite(sample.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs);
  const slowestProvider = providerSamples[0] ?? null;
  const timeoutSymbols = diagnostics.symbols
    .filter((symbol) => `${symbol.failureStage ?? ""} ${symbol.failureReason ?? ""}`.toLowerCase().includes("timeout"))
    .map((symbol) => symbol.symbol);
  const degradedProviders = diagnostics.degradedProviders?.map((provider) => provider.provider) ?? [];
  const timeoutStage =
    diagnostics.markers.find((item) => item.severity === "HANG") ??
    diagnostics.markers.find((item) => item.severity === "SLOW");
  return (
    `scanTiming: total=${formatMs(diagnostics.totalScanMs)}` +
    ` core=${formatMs(coreStage?.durationMs)}` +
    ` slowestProvider=${slowestProvider ? `${slowestProvider.name}:${formatMs(slowestProvider.durationMs)}` : "n/a"}` +
    ` timeoutSymbols=${timeoutSymbols.length > 0 ? timeoutSymbols.join(",") : "none"}` +
    ` degradedProviders=${degradedProviders.length > 0 ? degradedProviders.join(",") : "none"}` +
    (asyncQueue
      ? ` asyncQueue=${formatMs(asyncQueue.workerActiveMs ?? asyncQueue.queueBuildMs)}(queueWait=${formatMs(asyncQueue.queueWaitMs)} run=${formatMs(asyncQueue.workerActiveMs)})`
      : "") +
    (backgroundQueue
      ? ` backgroundQueue=trackerPersist:${backgroundQueue.trackerPersist},shadowEngine:${backgroundQueue.shadowEngine},outcomeChecker:${backgroundQueue.outcomeChecker},maxLag=${formatMs(backgroundQueue.maxLagSec === null ? null : backgroundQueue.maxLagSec * 1000)}`
      : "") +
    (analysis
      ? ` analysis=${formatMs(analysis.totalMs)}(top=${analysis.cacheHit ? "cacheHit" : "computePerformance"})`
      : "") +
    ` slowestStage=${slowest ? `${slowest.name}:${formatMs(slowest.durationMs)}` : "n/a"}` +
    (slowestSymbol ? ` slowestSymbol=${slowestSymbol.symbol}(${formatMs(slowestSymbol.symbolFetchMs)})` : "") +
    (timeoutStage ? ` timeoutStage=${timeoutStage.name}` : "") +
    ` p95Stage=${p95 ? `${p95.name}:${formatMs(p95.durationMs)}` : "n/a"}` +
    ` markers=${marker ? `${marker.severity}:${marker.name}:${formatMs(marker.elapsedMs)}` : "none"}`
  );
}

export function formatAdmissionTimingBriefLine(trace: AdmissionTimingTrace | null | undefined): string | null {
  if (!trace) return null;
  const allocatorMs = durationBetween(trace.allocatorStartedAt, trace.allocatorFinishedAt);
  const paperAdmissionMs = durationBetween(trace.paperAdmissionStartedAt, trace.paperAdmissionFinishedAt);
  return (
    `admissionTrace: scanFinished=${formatShortIso(trace.scanFinishedAt)}` +
    ` cached=${formatShortIso(trace.candidatesCachedAt)}` +
    ` allocator=${formatMs(allocatorMs)}` +
    ` paperAdmission=${formatMs(paperAdmissionMs)}` +
    ` createdHeadline=${trace.createdHeadline}` +
    ` createdDiagnostic=${trace.createdDiagnostic}`
  );
}

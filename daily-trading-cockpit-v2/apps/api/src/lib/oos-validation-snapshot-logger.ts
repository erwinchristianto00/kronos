/**
 * OOS VALIDATION SNAPSHOT LOGGER (REPORT-ONLY)
 *
 * Append-only JSONL snapshots of the forward-validation curve so the operator
 * can inspect how post-cutover and variant-matrix lanes evolve over time.
 *
 * STRICTLY REPORT-ONLY:
 *  - No strategy, route selection, paper admission, or live behavior changes.
 *  - No exchange calls and no resolver/mirror side effects.
 *  - Appends observations only; never mutates source validation stores.
 *  - liveBlocked remains true and microPilotAllowed remains false.
 *  - Storage failures never throw into callers.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CurrentGuardVariantMatrixReport, CurrentGuardVariantMatrixRow } from "./current-guard-variant-matrix.js";
import type { PostCutoverReport } from "./frozen-current-guard-post-cutover.js";
import { rotateJsonlIfNeeded } from "./jsonl-rotation.js";

export type OosValidationSnapshotTriggerSource =
  | "SCHEDULED"
  | "DASHBOARD_AUDIT";

export interface OosValidationSegmentSnapshot {
  label: string;
  n: number;
  netAvgR: number | null;
}

export type OosValidationLaneSnapshotSource = "POST_CUTOVER" | "VARIANT_MATRIX";

export interface OosValidationLaneSnapshot {
  laneId: string;
  source: OosValidationLaneSnapshotSource;
  variantId: string | null;
  label: string | null;
  status: string;
  statusReason: string | null;

  total: number;
  open: number;
  resolved: number;
  freshValid: number;

  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  payoffRatio: number | null;

  oosSegments: OosValidationSegmentSnapshot[] | null;
  allOosSegmentsPositive: boolean | null;
  plus10bpsStillPositive: boolean | null;

  approxMaxDrawdownR: number | null;
  topSymbolPnlShare: number | null;

  velocityFreshValidPerDay: number | null;
  etaToN50Days: number | null;
  etaToN100Days: number | null;
  etaToN200Days: number | null;

  blockers: string[];
  cautions: string[];
}

export interface OosValidationEconomicLeadSnapshot {
  laneId: string;
  source: OosValidationLaneSnapshotSource;
  freshValid: number;
  netAvgR: number | null;
  status: string;
  selectionBasis: "HIGHEST_WATCHABLE_NET" | "HIGHEST_SAMPLE";
}

export interface OosValidationSnapshot {
  capturedAt: string;
  triggerSource: OosValidationSnapshotTriggerSource;
  era: string;
  reportOnly: true;
  liveBlocked: true;
  microPilotAllowed: false;

  postCutoverComputedAt: string | null;
  postCutoverBoundaryCutoverAt: string | null;
  postCutoverCutoverActive: boolean | null;
  variantMatrixComputedAt: string | null;
  variantMatrixBestVariantId: string | null;
  variantMatrixBestBeatsBaseline: boolean | null;
  variantMatrixResolverLastRunAt: string | null;

  lanes: OosValidationLaneSnapshot[];
  economicLead: OosValidationEconomicLeadSnapshot | null;
  notes: string[];
}

export interface OosValidationSnapshotSummary {
  laneCount: number;
  postCutoverFreshValid: number | null;
  variantMatrixRows: number;
  economicLeadLaneId: string | null;
  economicLeadFreshValid: number | null;
  economicLeadNetAvgR: number | null;
}

export type OosValidationSnapshotLoggerRunStatus =
  | "NEVER_RUN"
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED_ALREADY_RUNNING";

export interface OosValidationSnapshotLoggerStatus {
  enabled: boolean;
  intervalMinutes: number;
  firstRunPolicy: "IMMEDIATE_AFTER_STARTUP";
  isRunning: boolean;
  skippedWhileRunningCount: number;
  lastSnapshotStartedAt: string | null;
  lastSnapshotFinishedAt: string | null;
  lastSnapshotStatus: OosValidationSnapshotLoggerRunStatus;
  lastSnapshotError: string | null;
  lastSnapshotResultSummary: OosValidationSnapshotSummary | null;
}

export interface OosValidationSnapshotStore {
  readonly path: string;
  append(snapshot: OosValidationSnapshot): boolean;
  readTail(limit?: number): OosValidationSnapshot[];
}

export interface OosValidationSnapshotLoggerController {
  start(): void;
  stop(): void;
  runOnce(triggerSource?: OosValidationSnapshotTriggerSource): Promise<OosValidationSnapshotLoggerRunStatus>;
  getStatus(): OosValidationSnapshotLoggerStatus;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function etaDays(target: number, current: number, perDay: number | null | undefined): number | null {
  if (current >= target) return 0;
  if (perDay === null || perDay === undefined || !Number.isFinite(perDay) || perDay <= 0) return null;
  return (target - current) / perDay;
}

function segmentsOf(
  segments: Array<{ label: string; n: number; netAvgR: number | null }> | readonly { label: string; n: number; netAvgR: number | null }[] | null | undefined,
): OosValidationSegmentSnapshot[] | null {
  if (!segments) return null;
  return segments.map((segment) => ({
    label: segment.label,
    n: segment.n,
    netAvgR: finiteNumber(segment.netAvgR),
  }));
}

function postCutoverLane(report: PostCutoverReport): OosValidationLaneSnapshot {
  return {
    laneId: report.laneId,
    source: "POST_CUTOVER",
    variantId: null,
    label: "F****** post-cutover",
    status: report.status,
    statusReason: report.statusReason,
    total: report.total,
    open: report.open,
    resolved: report.resolved,
    freshValid: report.freshValid,
    netAvgR: finiteNumber(report.netAvgR),
    pf: finiteNumber(report.pf),
    wr: finiteNumber(report.wr),
    payoffRatio: null,
    oosSegments: segmentsOf(report.oosSegments),
    allOosSegmentsPositive: report.allThreeSegmentsPositive,
    plus10bpsStillPositive: report.plus10bpsStillPositive,
    approxMaxDrawdownR: finiteNumber(report.approxMaxDrawdownR),
    topSymbolPnlShare: finiteNumber(report.topSymbolPnlShare),
    velocityFreshValidPerDay: finiteNumber(report.freshValidPerDay),
    etaToN50Days: etaDays(50, report.freshValid, report.freshValidPerDay),
    etaToN100Days: finiteNumber(report.etaToN100Days),
    etaToN200Days: finiteNumber(report.etaToN200Days),
    blockers: report.blockers.slice(0, 8),
    cautions: report.cautions.slice(0, 6),
  };
}

function variantMatrixLane(row: CurrentGuardVariantMatrixRow): OosValidationLaneSnapshot {
  const velocity = row.calendarDays && row.calendarDays > 0
    ? row.freshValid / row.calendarDays
    : null;
  return {
    laneId: `CG_VARIANT_MATRIX:${row.variantId}`,
    source: "VARIANT_MATRIX",
    variantId: row.variantId,
    label: row.label,
    status: row.status,
    statusReason: row.statusReason,
    total: row.total,
    open: row.open,
    resolved: row.resolved,
    freshValid: row.freshValid,
    netAvgR: finiteNumber(row.netAvgR),
    pf: finiteNumber(row.pf),
    wr: finiteNumber(row.wr),
    payoffRatio: finiteNumber(row.payoffRatio),
    oosSegments: segmentsOf(row.oosThirds),
    allOosSegmentsPositive: row.allThreeOosPositive,
    plus10bpsStillPositive: row.plus10bpsStillPositive,
    approxMaxDrawdownR: finiteNumber(row.approxMaxDrawdownR),
    topSymbolPnlShare: finiteNumber(row.topSymbolPnlShare),
    velocityFreshValidPerDay: finiteNumber(velocity),
    etaToN50Days: etaDays(50, row.freshValid, velocity),
    etaToN100Days: etaDays(100, row.freshValid, velocity),
    etaToN200Days: etaDays(200, row.freshValid, velocity),
    blockers: row.blockers.slice(0, 8),
    cautions: row.cautions.slice(0, 6),
  };
}

function chooseEconomicLead(lanes: OosValidationLaneSnapshot[]): OosValidationEconomicLeadSnapshot | null {
  const watchable = lanes
    .filter((lane) => lane.freshValid >= 50 && lane.netAvgR !== null)
    .sort((a, b) => (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity));
  const selected =
    watchable[0] ??
    [...lanes].sort((a, b) => b.freshValid - a.freshValid)[0] ??
    null;
  if (!selected) return null;
  return {
    laneId: selected.laneId,
    source: selected.source,
    freshValid: selected.freshValid,
    netAvgR: selected.netAvgR,
    status: selected.status,
    selectionBasis: watchable.length > 0 ? "HIGHEST_WATCHABLE_NET" : "HIGHEST_SAMPLE",
  };
}

export function summarizeOosValidationSnapshot(snapshot: OosValidationSnapshot): OosValidationSnapshotSummary {
  const postCutover = snapshot.lanes.find((lane) => lane.source === "POST_CUTOVER") ?? null;
  return {
    laneCount: snapshot.lanes.length,
    postCutoverFreshValid: postCutover?.freshValid ?? null,
    variantMatrixRows: snapshot.lanes.filter((lane) => lane.source === "VARIANT_MATRIX").length,
    economicLeadLaneId: snapshot.economicLead?.laneId ?? null,
    economicLeadFreshValid: snapshot.economicLead?.freshValid ?? null,
    economicLeadNetAvgR: snapshot.economicLead?.netAvgR ?? null,
  };
}

export function buildOosValidationSnapshot(opts: {
  capturedAt?: string;
  triggerSource: OosValidationSnapshotTriggerSource;
  era?: string;
  postCutoverReport?: PostCutoverReport | null;
  variantMatrixReport?: CurrentGuardVariantMatrixReport | null;
}): OosValidationSnapshot {
  const lanes: OosValidationLaneSnapshot[] = [];
  if (opts.postCutoverReport) {
    lanes.push(postCutoverLane(opts.postCutoverReport));
  }
  if (opts.variantMatrixReport) {
    for (const row of opts.variantMatrixReport.rows) {
      lanes.push(variantMatrixLane(row));
    }
  }

  return {
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
    triggerSource: opts.triggerSource,
    era: opts.era ?? "POST_CALIBRATION",
    reportOnly: true,
    liveBlocked: true,
    microPilotAllowed: false,
    postCutoverComputedAt: opts.postCutoverReport?.computedAt ?? null,
    postCutoverBoundaryCutoverAt: opts.postCutoverReport?.boundary?.cutoverTimestamp ?? null,
    postCutoverCutoverActive: opts.postCutoverReport?.cutoverActive ?? null,
    variantMatrixComputedAt: opts.variantMatrixReport?.computedAt ?? null,
    variantMatrixBestVariantId: opts.variantMatrixReport?.bestVariantId ?? null,
    variantMatrixBestBeatsBaseline: opts.variantMatrixReport?.bestBeatsBaseline ?? null,
    variantMatrixResolverLastRunAt: opts.variantMatrixReport?.resolverDiagnostics.lastRunAt ?? null,
    lanes,
    economicLead: chooseEconomicLead(lanes),
    notes: [
      "Report-only OOS validation curve snapshot.",
      "No strategy, paper admission, or live behavior is changed by this logger.",
      "liveBlocked=true and microPilotAllowed=false are preserved.",
    ],
  };
}

export class JsonlOosValidationSnapshotStore implements OosValidationSnapshotStore {
  private readonly file: string;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "oos-validation-snapshots.jsonl");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort; append failures are also swallowed
    }
  }

  get path(): string {
    return this.file;
  }

  append(snapshot: OosValidationSnapshot): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(snapshot) + "\n", "utf-8");
      this.maybeRotate();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 2026-07-11: this file had no cap at all — confirmed live at 39.5MB/1,723 lines and growing
   * ~2.3MB/day, fed by both the 15-min SCHEDULED controller AND an unconditional append on every
   * dashboard render (routes/shadow.ts's DASHBOARD_AUDIT trigger) — the same unbounded-growth class
   * already root-caused and fixed today in paper-execution-router.ts. Reuses the same
   * rotateJsonlIfNeeded helper tracker.ts already applies to scan-history*.jsonl, with a much
   * smaller threshold than that file's 100MB default since readTail() below loads this file in FULL
   * on every read (unlike scan-history, which is read via a bounded backward-chunk reader) — keeping
   * the file itself small keeps that full read cheap. Never throws; rotation failure must never
   * block persistence.
   */
  private maybeRotate(): void {
    if (process.env.OOS_VALIDATION_SNAPSHOT_ROTATION_DISABLED === "1") return;
    try {
      const thresholdBytes = Number(process.env.OOS_VALIDATION_SNAPSHOT_ROTATION_THRESHOLD_BYTES) || 5 * 1024 * 1024;
      const tailLines = Number(process.env.OOS_VALIDATION_SNAPSHOT_ROTATION_TAIL_LINES) || 2_000;
      const result = rotateJsonlIfNeeded(this.file, { thresholdBytes, tailLines });
      if (result.rotated) {
        console.warn(
          `[oos-validation-snapshot-logger] rotated ${this.file}: archived ${result.fromSize ?? "?"} bytes → ${result.archivePath ?? "?"}; kept ${result.linesKept ?? 0} lines`,
        );
      }
    } catch {
      // rotation failure must never block persistence
    }
  }

  readTail(limit = 20): OosValidationSnapshot[] {
    try {
      if (!existsSync(this.file)) return [];
      const lines = readFileSync(this.file, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-Math.max(0, limit));
      const out: OosValidationSnapshot[] = [];
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as OosValidationSnapshot);
        } catch {
          // Skip malformed lines; log readers must be tolerant.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

let singleton: JsonlOosValidationSnapshotStore | null = null;

export function getOosValidationSnapshotStore(dataDir = "data"): JsonlOosValidationSnapshotStore {
  if (!singleton) singleton = new JsonlOosValidationSnapshotStore(dataDir);
  return singleton;
}

export function _resetOosValidationSnapshotStoreForTests(): void {
  singleton = null;
}

export function createOosValidationSnapshotLoggerController(opts: {
  enabled: boolean;
  intervalMinutes: number;
  startupDelayMs?: number;
  store: OosValidationSnapshotStore;
  captureSnapshot: (
    triggerSource: OosValidationSnapshotTriggerSource,
    capturedAt: string,
  ) => OosValidationSnapshot | null | undefined | Promise<OosValidationSnapshot | null | undefined>;
}): OosValidationSnapshotLoggerController {
  const intervalMinutes =
    Number.isFinite(opts.intervalMinutes) && opts.intervalMinutes > 0
      ? Math.max(1, Math.round(opts.intervalMinutes))
      : 15;
  const startupDelayMs = opts.startupDelayMs ?? 3000;
  let started = false;
  let intervalHandle: NodeJS.Timeout | null = null;
  let startupHandle: NodeJS.Timeout | null = null;
  let isRunning = false;

  const status: OosValidationSnapshotLoggerStatus = {
    enabled: opts.enabled,
    intervalMinutes,
    firstRunPolicy: "IMMEDIATE_AFTER_STARTUP",
    isRunning: false,
    skippedWhileRunningCount: 0,
    lastSnapshotStartedAt: null,
    lastSnapshotFinishedAt: null,
    lastSnapshotStatus: "NEVER_RUN",
    lastSnapshotError: null,
    lastSnapshotResultSummary: null,
  };

  async function runTick(triggerSource: OosValidationSnapshotTriggerSource): Promise<OosValidationSnapshotLoggerRunStatus> {
    if (isRunning) {
      status.skippedWhileRunningCount += 1;
      status.lastSnapshotStatus = "SKIPPED_ALREADY_RUNNING";
      status.lastSnapshotFinishedAt = new Date().toISOString();
      return "SKIPPED_ALREADY_RUNNING";
    }

    isRunning = true;
    status.isRunning = true;
    status.lastSnapshotStartedAt = new Date().toISOString();
    status.lastSnapshotError = null;
    try {
      const snapshot = await opts.captureSnapshot(triggerSource, status.lastSnapshotStartedAt);
      if (snapshot) {
        opts.store.append(snapshot);
        status.lastSnapshotResultSummary = summarizeOosValidationSnapshot(snapshot);
      } else {
        status.lastSnapshotResultSummary = null;
      }
      status.lastSnapshotStatus = "SUCCESS";
      return "SUCCESS";
    } catch (error) {
      status.lastSnapshotStatus = "FAILED";
      status.lastSnapshotError = error instanceof Error ? error.message : "Unknown error";
      return "FAILED";
    } finally {
      status.lastSnapshotFinishedAt = new Date().toISOString();
      isRunning = false;
      status.isRunning = false;
    }
  }

  return {
    start() {
      if (started || !opts.enabled) return;
      started = true;
      startupHandle = setTimeout(() => {
        void runTick("SCHEDULED");
      }, startupDelayMs);
      intervalHandle = setInterval(() => {
        void runTick("SCHEDULED");
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
    runOnce(triggerSource = "SCHEDULED") {
      return runTick(triggerSource);
    },
    getStatus() {
      return {
        ...status,
        lastSnapshotResultSummary: status.lastSnapshotResultSummary
          ? { ...status.lastSnapshotResultSummary }
          : null,
      };
    },
  };
}

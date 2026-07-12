/**
 * Regime Direction Controller Snapshot Store — REPORT-ONLY persistence.
 *
 * Appends one JSON-line per dashboard-audit-summary render to
 * data/regime-direction-controller-snapshots.jsonl so controller decisions
 * can be compared against subsequent scan outcomes in dry-run analysis.
 *
 * STRICTLY REPORT-ONLY:
 *  - Writing a snapshot has zero influence on live behavior, route selection,
 *    shadow admission, Kronos/Whale/Fingerprint logic, or any readiness gate.
 *  - All writes are wrapped in try/catch and must never throw into the caller.
 *  - The store is append-only: no record is ever mutated or deleted.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildRegimeDirectionControllerReport,
  type RegimeDirectionControllerReport,
  type RegimeDirectionAlignment,
} from "./regime-direction-controller.js";
import { rotateJsonlIfNeeded } from "./jsonl-rotation.js";

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

export type RegimeDirectionControllerSnapshotSource =
  | "DASHBOARD_AUDIT"  // full report — all inputs available
  | "SCAN_CYCLE";      // lightweight — only currentRegime available

export interface RegimeDirectionControllerSnapshot {
  /** ISO-8601 UTC timestamp of when this snapshot was captured. */
  capturedAt: string;
  /** Which execution path produced this snapshot. */
  source: RegimeDirectionControllerSnapshotSource;
  /** Always true — enforces report-only contract at the data layer. */
  reportOnly: true;

  // ---- core controller output ----
  currentRegime: string | null;
  controllerMode: string;
  directionalBias: string;
  confidence: string;
  allowsLong: boolean;
  allowsShort: boolean;
  allowsNewEntries: boolean;
  requiresRetest: boolean;
  reasonCodes: string[];

  // ---- primary lane alignment (null when source === "SCAN_CYCLE") ----
  primaryLaneAlignment: RegimeDirectionAlignment | null;
  primaryLaneLabel: string | null;
  primaryLaneDirection: "LONG" | "SHORT" | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class RegimeDirectionControllerSnapshotStore {
  private readonly file: string;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "regime-direction-controller-snapshots.jsonl");
    mkdirSync(dirname(this.file), { recursive: true });
  }

  get path(): string {
    return this.file;
  }

  /**
   * Append one snapshot line.  Never throws — all errors are silently swallowed
   * so a write failure can never break the scan or dashboard response.
   */
  append(snapshot: RegimeDirectionControllerSnapshot): void {
    try {
      appendFileSync(this.file, JSON.stringify(snapshot) + "\n", "utf-8");
      this.maybeRotate();
    } catch {
      // report-only store; write failures must not surface to callers
    }
  }

  /**
   * 2026-07-11: this file had no cap at all — confirmed live at 1.4MB/3,541 lines and growing
   * ~83KB/day (appended every scan cycle AND every dashboard render), the same unbounded-growth
   * class already root-caused and fixed today in paper-execution-router.ts. Slower-growing than its
   * siblings but readLatest() still loads the whole file on every call, and this store sits on the
   * hot startup-fallback path (app.ts, routes/shadow.ts). Reuses the same rotateJsonlIfNeeded helper
   * tracker.ts already applies to scan-history*.jsonl. Never throws.
   */
  private maybeRotate(): void {
    if (process.env.REGIME_DIRECTION_SNAPSHOT_ROTATION_DISABLED === "1") return;
    try {
      const thresholdBytes = Number(process.env.REGIME_DIRECTION_SNAPSHOT_ROTATION_THRESHOLD_BYTES) || 5 * 1024 * 1024;
      const tailLines = Number(process.env.REGIME_DIRECTION_SNAPSHOT_ROTATION_TAIL_LINES) || 5_000;
      const result = rotateJsonlIfNeeded(this.file, { thresholdBytes, tailLines });
      if (result.rotated) {
        console.warn(
          `[regime-direction-controller-snapshot] rotated ${this.file}: archived ${result.fromSize ?? "?"} bytes → ${result.archivePath ?? "?"}; kept ${result.linesKept ?? 0} lines`,
        );
      }
    } catch {
      // rotation failure must never block persistence
    }
  }

  /**
   * Best-effort read of the latest valid snapshot. Used only as a startup-safe
   * telemetry fallback before the in-memory scan cache has been repopulated.
   */
  readLatest(): RegimeDirectionControllerSnapshot | null {
    try {
      const lines = readFileSync(this.file, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]) as Partial<RegimeDirectionControllerSnapshot>;
          if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.capturedAt === "string" &&
            typeof parsed.controllerMode === "string" &&
            typeof parsed.directionalBias === "string" &&
            typeof parsed.confidence === "string" &&
            Array.isArray(parsed.reasonCodes)
          ) {
            return parsed as RegimeDirectionControllerSnapshot;
          }
        } catch {
          // Ignore corrupt trailing lines and keep walking backward.
        }
      }
    } catch {
      // Missing/unreadable snapshot file is expected on fresh installs.
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Singleton (lazy, mirrors getDecisionLedger pattern)
// ---------------------------------------------------------------------------

let singleton: RegimeDirectionControllerSnapshotStore | null = null;

export function getRegimeDirectionControllerSnapshotStore(
  dataDir = "data",
): RegimeDirectionControllerSnapshotStore {
  if (!singleton) {
    singleton = new RegimeDirectionControllerSnapshotStore(dataDir);
  }
  return singleton;
}

export function _resetRegimeDirectionControllerSnapshotStoreForTests(): void {
  singleton = null;
}

// ---------------------------------------------------------------------------
// Snapshot builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a full snapshot from a complete RegimeDirectionControllerReport.
 * Use this from the dashboard-audit-summary handler (all inputs available).
 */
export function buildSnapshotFromReport(
  report: RegimeDirectionControllerReport,
  capturedAt?: string,
): RegimeDirectionControllerSnapshot {
  const lane = report.currentValidationPrimaryLane;
  return {
    capturedAt: capturedAt ?? new Date().toISOString(),
    source: "DASHBOARD_AUDIT",
    reportOnly: true,
    currentRegime: report.currentRegime,
    controllerMode: report.controllerMode,
    directionalBias: report.directionalBias,
    confidence: report.confidence,
    allowsLong: report.allowsLong,
    allowsShort: report.allowsShort,
    allowsNewEntries: report.allowsNewEntries,
    requiresRetest: report.requiresRetest,
    reasonCodes: report.reasonCodes,
    primaryLaneAlignment: lane?.alignment ?? null,
    primaryLaneLabel: lane?.label ?? null,
    primaryLaneDirection: lane?.direction ?? null,
  };
}

/**
 * Build a lightweight scan-cycle snapshot from just the market regime string.
 * Computes the controller report with the regime as the sole input (other
 * inputs are unavailable at scan-cycle time).
 * Use this from the scan auto-refresh path for coarse temporal coverage.
 */
export function buildScanCycleSnapshot(
  currentRegime: string | null | undefined,
  capturedAt?: string,
): RegimeDirectionControllerSnapshot {
  const report = buildRegimeDirectionControllerReport({ currentRegime: currentRegime ?? null });
  return {
    capturedAt: capturedAt ?? new Date().toISOString(),
    source: "SCAN_CYCLE",
    reportOnly: true,
    currentRegime: report.currentRegime,
    controllerMode: report.controllerMode,
    directionalBias: report.directionalBias,
    confidence: report.confidence,
    allowsLong: report.allowsLong,
    allowsShort: report.allowsShort,
    allowsNewEntries: report.allowsNewEntries,
    requiresRetest: report.requiresRetest,
    reasonCodes: report.reasonCodes,
    // Primary lane not available at scan-cycle time
    primaryLaneAlignment: null,
    primaryLaneLabel: null,
    primaryLaneDirection: null,
  };
}

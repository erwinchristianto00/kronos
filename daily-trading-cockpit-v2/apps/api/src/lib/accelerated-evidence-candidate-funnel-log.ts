/**
 * CANDIDATE-LEVEL FUNNEL LOGGER (REPORT-ONLY)
 *
 * Append-only JSONL log that records every scan-cycle candidate and the exact
 * admission decision for the controller-aligned shadow lane. One entry per
 * candidate per scan cycle.
 *
 * Storage: data/accelerated-evidence-candidate-funnel.jsonl
 *
 * STRICTLY REPORT-ONLY:
 *  - No live behavior, route selection, readiness, or scoring changes
 *  - No Kronos/Whale/Fingerprint/adaptive/readiness changes
 *  - Does NOT touch data/shadow-positions.json
 *  - Never throws — all errors swallowed
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface CandidateFunnelEntry {
  timestamp: string;
  scanCycleId: string;        // ISO timestamp of the scan cycle start
  source: "SCAN_CYCLE";
  symbol: string;
  direction: "LONG" | "SHORT";
  currentRegime: string | null;
  /**
   * The raw marketRegime string from result.marketRegime at scan-cycle time.
   * Identical to currentRegime; present for diagnostic clarity.
   */
  rawCurrentRegime: string | null;
  /**
   * Normalised regime family extracted from rawCurrentRegime.
   * e.g. "BULLISH_EXPANSION", "BEARISH_EXPANSION", "MIXED", "UNKNOWN", null.
   */
  normalizedRegimeFamily: string | null;
  controllerMode: string;
  /** reasonCodes from the RegimeDirectionControllerReport used for admission. */
  controllerReasonCodes: string[];
  /** Always "SCAN_CYCLE" for entries written by the scan route. */
  controllerSource: "SCAN_CYCLE";
  controllerAllowsDirection: boolean;
  selectedEntryVariant: string | null;
  selectedExitVariant: string | null;
  routeMode: string | null;
  hasSelectedExecutionPlan: boolean;
  stopDistanceBps: number | null;
  stop175Pass: boolean | null;  // null if no plan
  sourceConflict: boolean | null;
  liveSourceConflict: boolean | null;
  kronosBias: string | null;
  whaleAgreement: string | null;
  normalShadowEligible: boolean;
  controllerAlignedEligible: boolean;
  controllerAlignedOpened: boolean;
  rejectionReasons: string[];
  // ── Phase 2Z.1: variant-adjusted guard diagnostics (optional, backward-compatible) ──
  /** ATR in basis points: atrPercent * 100 (e.g. atrPercent=0.69 → atrBps=69). */
  atrBps?: number | null;
  /** Effective guard threshold from computeControllerAlignedGuardThreshold: max(80, atrBps). */
  variantAdjustedGuardThresholdBps?: number | null;
  /** How the stop-distance guard resolved for this candidate. */
  guardPassedUnder?: "LEGACY_175" | "VARIANT_ADJUSTED" | "FAILED_VARIANT_ADJUSTED" | "UNKNOWN";
  /** Alias for stop175Pass — stopDistanceBps >= 175 (legacy fixed guard). */
  legacyStop175Pass?: boolean | null;
  /** stopDistanceBps >= variantAdjustedGuardThresholdBps. */
  variantAdjustedStopPass?: boolean | null;
}

// ─── Regime family normaliser ─────────────────────────────────────────────────

/**
 * Derive a normalised regime family label from a raw marketRegime string.
 * Mirrors the logic used in regime-direction-controller.ts so the funnel log
 * carries the same categorisation for post-hoc analysis.
 */
export function normalizeFunnelRegimeFamily(regime: string | null | undefined): string | null {
  if (!regime || typeof regime !== "string") return null;
  const r = regime.trim().toLowerCase();
  if (r.length === 0) return null;
  if (r.includes("panic") && (r.includes("dump") || r.includes("down"))) return "PANIC_DUMP";
  if (r.includes("panic") && (r.includes("pump") || r.includes("squeeze") || r.includes("up"))) return "PANIC_PUMP";
  if (r.includes("chop") || r.includes("range") || r.includes("consolidation")) return "CHOP";
  if (r.includes("mixed") || r.includes("rotation")) return "MIXED";
  if (r.includes("bullish")) return "BULLISH_EXPANSION";
  if (r.includes("bearish")) return "BEARISH_EXPANSION";
  return "UNKNOWN";
}

// ─── Rejection reason codes ────────────────────────────────────────────────────

export const REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER = "DIRECTION_BLOCKED_BY_CONTROLLER" as const;
export const REJECTION_MISSING_EXECUTION_PLAN = "MISSING_EXECUTION_PLAN" as const;
export const REJECTION_STOP_DISTANCE_BELOW_175 = "STOP_DISTANCE_BELOW_175" as const;
export const REJECTION_SOURCE_CONFLICT_TRUE = "SOURCE_CONFLICT_TRUE" as const;
export const REJECTION_LIVE_SOURCE_CONFLICT_TRUE = "LIVE_SOURCE_CONFLICT_TRUE" as const;
export const REJECTION_KRONOS_DISAGREES = "KRONOS_DISAGREES" as const;
export const REJECTION_DUPLICATE_SUPPRESSED = "DUPLICATE_SUPPRESSED" as const;
export const REJECTION_CONTROLLER_MODE_NOT_DIRECTIONAL = "CONTROLLER_MODE_NOT_DIRECTIONAL" as const;
export const REJECTION_MISSING_REAL_ENTRY_GEOMETRY = "MISSING_REAL_ENTRY_GEOMETRY" as const;
export const REJECTION_MISSING_STOP_LOSS = "MISSING_STOP_LOSS" as const;
export const REJECTION_MISSING_TAKE_PROFIT_LEVELS = "MISSING_TAKE_PROFIT_LEVELS" as const;

// ─── Class ────────────────────────────────────────────────────────────────────

export class CandidateFunnelLog {
  private readonly file: string;

  constructor(file = "data/accelerated-evidence-candidate-funnel.jsonl") {
    this.file = resolve(file);
  }

  get path(): string {
    return this.file;
  }

  append(entry: CandidateFunnelEntry): void {
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // append failures must never throw — this log is report-only
    }
  }

  /**
   * Read entries within the given time window (milliseconds back from `now`).
   * Returns [] on any error or if the file doesn't exist.
   */
  readRecentEntries(windowMs: number, now: Date = new Date()): CandidateFunnelEntry[] {
    try {
      if (!existsSync(this.file)) {
        return [];
      }
      const raw = readFileSync(this.file, "utf-8");
      const cutoff = new Date(now.getTime() - windowMs);
      const results: CandidateFunnelEntry[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as CandidateFunnelEntry;
          if (typeof entry.timestamp === "string") {
            const ts = new Date(entry.timestamp);
            if (ts >= cutoff) {
              results.push(entry);
            }
          }
        } catch {
          // skip malformed lines
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────

let _instance: CandidateFunnelLog | null = null;

export function getCandidateFunnelLog(file?: string): CandidateFunnelLog {
  const resolvedFile = file ?? "data/accelerated-evidence-candidate-funnel.jsonl";
  if (!_instance || _instance.path !== resolve(resolvedFile)) {
    _instance = new CandidateFunnelLog(resolvedFile);
  }
  return _instance;
}

export function _resetCandidateFunnelLogForTests(): void {
  _instance = null;
}

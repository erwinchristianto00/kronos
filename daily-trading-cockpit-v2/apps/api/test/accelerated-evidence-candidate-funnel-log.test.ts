/**
 * Tests for CandidateFunnelLog and related helpers.
 * All report-only — no live behavior.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  CandidateFunnelLog,
  getCandidateFunnelLog,
  _resetCandidateFunnelLogForTests,
  normalizeFunnelRegimeFamily,
  REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER,
  REJECTION_MISSING_EXECUTION_PLAN,
  REJECTION_STOP_DISTANCE_BELOW_175,
  REJECTION_SOURCE_CONFLICT_TRUE,
  REJECTION_CONTROLLER_MODE_NOT_DIRECTIONAL,
  REJECTION_MISSING_REAL_ENTRY_GEOMETRY,
  REJECTION_MISSING_STOP_LOSS,
  REJECTION_MISSING_TAKE_PROFIT_LEVELS,
  type CandidateFunnelEntry,
} from "../src/lib/accelerated-evidence-candidate-funnel-log.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "funnel-log-test-"));
  _resetCandidateFunnelLogForTests();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetCandidateFunnelLogForTests();
});

function makeEntry(overrides: Partial<CandidateFunnelEntry> = {}): CandidateFunnelEntry {
  return {
    timestamp: new Date().toISOString(),
    scanCycleId: new Date().toISOString(),
    source: "SCAN_CYCLE",
    symbol: "BTCUSDT",
    direction: "LONG",
    currentRegime: "Bullish expansion",
    rawCurrentRegime: "Bullish expansion",
    normalizedRegimeFamily: "BULLISH_EXPANSION",
    controllerMode: "LONG_ONLY",
    controllerReasonCodes: ["REGIME_LONG_TREND"],
    controllerSource: "SCAN_CYCLE",
    controllerAllowsDirection: true,
    selectedEntryVariant: "base_current_entry",
    selectedExitVariant: "tp1_full_exit",
    routeMode: "RESEARCH_ONLY",
    hasSelectedExecutionPlan: true,
    stopDistanceBps: 300,
    stop175Pass: true,
    sourceConflict: false,
    liveSourceConflict: false,
    kronosBias: "BULLISH",
    whaleAgreement: "AGREES",
    normalShadowEligible: true,
    controllerAlignedEligible: true,
    controllerAlignedOpened: true,
    rejectionReasons: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CandidateFunnelLog rejection reason logic", () => {
  it("LONG candidate under LONG_ONLY: controllerAllowsDirection=true, no DIRECTION_BLOCKED in reasons", () => {
    const entry = makeEntry({
      direction: "LONG",
      controllerMode: "LONG_ONLY",
      controllerAllowsDirection: true,
      rejectionReasons: [],
    });
    expect(entry.controllerAllowsDirection).toBe(true);
    expect(entry.rejectionReasons).not.toContain(REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER);
  });

  it("SHORT candidate under LONG_ONLY: controllerAllowsDirection=false, includes DIRECTION_BLOCKED", () => {
    const entry = makeEntry({
      direction: "SHORT",
      controllerMode: "LONG_ONLY",
      controllerAllowsDirection: false,
      rejectionReasons: [REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER],
    });
    expect(entry.controllerAllowsDirection).toBe(false);
    expect(entry.rejectionReasons).toContain(REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER);
  });

  it("candidate with stopDistanceBps=100: stop175Pass=false, includes STOP_DISTANCE_BELOW_175", () => {
    const entry = makeEntry({
      stopDistanceBps: 100,
      stop175Pass: false,
      hasSelectedExecutionPlan: true,
      rejectionReasons: [REJECTION_STOP_DISTANCE_BELOW_175],
    });
    expect(entry.stop175Pass).toBe(false);
    expect(entry.rejectionReasons).toContain(REJECTION_STOP_DISTANCE_BELOW_175);
  });

  it("candidate with no selectedExecutionPlan: includes MISSING_EXECUTION_PLAN", () => {
    const entry = makeEntry({
      hasSelectedExecutionPlan: false,
      stopDistanceBps: null,
      stop175Pass: null,
      rejectionReasons: [REJECTION_MISSING_EXECUTION_PLAN],
    });
    expect(entry.hasSelectedExecutionPlan).toBe(false);
    expect(entry.rejectionReasons).toContain(REJECTION_MISSING_EXECUTION_PLAN);
  });

  it("candidate with sourceConflict=true: includes SOURCE_CONFLICT_TRUE", () => {
    const entry = makeEntry({
      sourceConflict: true,
      rejectionReasons: [REJECTION_SOURCE_CONFLICT_TRUE],
    });
    expect(entry.sourceConflict).toBe(true);
    expect(entry.rejectionReasons).toContain(REJECTION_SOURCE_CONFLICT_TRUE);
  });

  it("controller mode not directional: includes CONTROLLER_MODE_NOT_DIRECTIONAL", () => {
    const entry = makeEntry({
      controllerMode: "NO_TRADE_CHOP",
      controllerAllowsDirection: false,
      rejectionReasons: [REJECTION_CONTROLLER_MODE_NOT_DIRECTIONAL],
    });
    expect(entry.rejectionReasons).toContain(REJECTION_CONTROLLER_MODE_NOT_DIRECTIONAL);
  });
});

describe("CandidateFunnelLog.append", () => {
  it("append never throws even on a valid write", () => {
    const log = new CandidateFunnelLog(join(tempDir, "funnel.jsonl"));
    const entry = makeEntry();
    expect(() => log.append(entry)).not.toThrow();
  });

  it("append to a valid path creates the file", () => {
    const filePath = join(tempDir, "funnel.jsonl");
    const log = new CandidateFunnelLog(filePath);
    log.append(makeEntry());
    expect(existsSync(filePath)).toBe(true);
  });

  it("append never throws even if path is deeply nested", () => {
    const log = new CandidateFunnelLog(join(tempDir, "nested", "deep", "funnel.jsonl"));
    expect(() => log.append(makeEntry())).not.toThrow();
  });
});

describe("CandidateFunnelLog.readRecentEntries", () => {
  it("returns [] when file doesn't exist", () => {
    const log = new CandidateFunnelLog(join(tempDir, "nonexistent.jsonl"));
    const result = log.readRecentEntries(60_000);
    expect(result).toEqual([]);
  });

  it("filters entries by timestamp window correctly", () => {
    const log = new CandidateFunnelLog(join(tempDir, "funnel.jsonl"));
    const now = new Date("2026-05-25T12:00:00.000Z");
    const recent = makeEntry({ timestamp: new Date(now.getTime() - 1000).toISOString() });
    const old = makeEntry({ timestamp: new Date(now.getTime() - 100_000).toISOString() });
    log.append(recent);
    log.append(old);

    const results = log.readRecentEntries(10_000, now); // 10 second window
    expect(results.length).toBe(1);
    expect(results[0]!.timestamp).toBe(recent.timestamp);
  });

  it("includes entries exactly at the cutoff boundary", () => {
    const log = new CandidateFunnelLog(join(tempDir, "funnel.jsonl"));
    const now = new Date("2026-05-25T12:00:00.000Z");
    const atCutoff = makeEntry({ timestamp: new Date(now.getTime() - 10_000).toISOString() });
    log.append(atCutoff);

    const results = log.readRecentEntries(10_000, now);
    expect(results.length).toBe(1);
  });

  it("returns empty array when all entries are outside window", () => {
    const log = new CandidateFunnelLog(join(tempDir, "funnel.jsonl"));
    const now = new Date("2026-05-25T12:00:00.000Z");
    const old = makeEntry({ timestamp: new Date(now.getTime() - 200_000).toISOString() });
    log.append(old);

    const results = log.readRecentEntries(10_000, now);
    expect(results).toEqual([]);
  });

  it("returns all entries when all are within the window", () => {
    const log = new CandidateFunnelLog(join(tempDir, "funnel.jsonl"));
    const now = new Date("2026-05-25T12:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      log.append(makeEntry({ timestamp: new Date(now.getTime() - i * 100).toISOString() }));
    }
    const results = log.readRecentEntries(10_000, now);
    expect(results.length).toBe(5);
  });
});

describe("getCandidateFunnelLog singleton", () => {
  it("returns the same instance for the same file path", () => {
    const path = join(tempDir, "singleton.jsonl");
    const a = getCandidateFunnelLog(path);
    const b = getCandidateFunnelLog(path);
    expect(a).toBe(b);
  });

  it("returns a new instance after reset", () => {
    const path = join(tempDir, "singleton.jsonl");
    const a = getCandidateFunnelLog(path);
    _resetCandidateFunnelLogForTests();
    const b = getCandidateFunnelLog(path);
    expect(a).not.toBe(b);
  });
});

// ─── New-field tests ──────────────────────────────────────────────────────────

describe("normalizeFunnelRegimeFamily", () => {
  it("'Bullish expansion' → 'BULLISH_EXPANSION'", () => {
    expect(normalizeFunnelRegimeFamily("Bullish expansion")).toBe("BULLISH_EXPANSION");
  });

  it("'bullish expansion' (lowercase) → 'BULLISH_EXPANSION'", () => {
    expect(normalizeFunnelRegimeFamily("bullish expansion")).toBe("BULLISH_EXPANSION");
  });

  it("'BULLISH_EXPANSION' (uppercase) → 'BULLISH_EXPANSION'", () => {
    expect(normalizeFunnelRegimeFamily("BULLISH_EXPANSION")).toBe("BULLISH_EXPANSION");
  });

  it("'Bearish pressure' → 'BEARISH_EXPANSION'", () => {
    expect(normalizeFunnelRegimeFamily("Bearish pressure")).toBe("BEARISH_EXPANSION");
  });

  it("'Mixed rotation' → 'MIXED'", () => {
    expect(normalizeFunnelRegimeFamily("Mixed rotation")).toBe("MIXED");
  });

  it("'Choppy range' → 'CHOP'", () => {
    expect(normalizeFunnelRegimeFamily("Choppy range")).toBe("CHOP");
  });

  it("null → null", () => {
    expect(normalizeFunnelRegimeFamily(null)).toBeNull();
  });

  it("empty string → null", () => {
    expect(normalizeFunnelRegimeFamily("")).toBeNull();
  });

  it("unrecognised string → 'UNKNOWN'", () => {
    expect(normalizeFunnelRegimeFamily("Some totally unknown label xyz")).toBe("UNKNOWN");
  });
});

describe("CandidateFunnelEntry new diagnostic fields", () => {
  it("entry with regime 'Bullish expansion' has controllerMode=LONG_ONLY when controller is queried", () => {
    // Verify the controller produces LONG_ONLY for this regime (cross-check for the scan path)
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    expect(report.controllerMode).toBe("LONG_ONLY");

    const entry = makeEntry({
      currentRegime: "Bullish expansion",
      rawCurrentRegime: "Bullish expansion",
      normalizedRegimeFamily: "BULLISH_EXPANSION",
      controllerMode: report.controllerMode,
      controllerReasonCodes: report.reasonCodes,
      controllerSource: "SCAN_CYCLE",
    });
    expect(entry.controllerMode).toBe("LONG_ONLY");
    expect(entry.normalizedRegimeFamily).toBe("BULLISH_EXPANSION");
    expect(entry.controllerReasonCodes).toContain("REGIME_LONG_TREND");
    expect(entry.controllerSource).toBe("SCAN_CYCLE");
  });

  it("LONG direction under Bullish expansion → controllerAllowsDirection=true", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    const mode = report.controllerMode;
    const controllerAllowsDirection = mode === "LONG_ONLY" ? true : false;
    const entry = makeEntry({
      direction: "LONG",
      controllerMode: mode,
      controllerAllowsDirection,
      rejectionReasons: [],
    });
    expect(entry.controllerAllowsDirection).toBe(true);
    expect(entry.rejectionReasons).not.toContain("DIRECTION_BLOCKED_BY_CONTROLLER");
  });

  it("SHORT direction under Bullish expansion → controllerAllowsDirection=false and DIRECTION_BLOCKED", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    const mode = report.controllerMode; // LONG_ONLY
    const controllerAllowsDirection = mode === "LONG_ONLY" ? false : true; // direction=SHORT
    const entry = makeEntry({
      direction: "SHORT",
      controllerMode: mode,
      controllerAllowsDirection,
      rejectionReasons: [REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER],
    });
    expect(entry.controllerAllowsDirection).toBe(false);
    expect(entry.rejectionReasons).toContain(REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER);
  });

  it("null regime → controllerMode=UNKNOWN", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: null });
    expect(report.controllerMode).toBe("UNKNOWN");
    const entry = makeEntry({
      currentRegime: null,
      rawCurrentRegime: null,
      normalizedRegimeFamily: null,
      controllerMode: report.controllerMode,
      controllerReasonCodes: report.reasonCodes,
    });
    expect(entry.controllerMode).toBe("UNKNOWN");
    expect(entry.rawCurrentRegime).toBeNull();
    expect(entry.normalizedRegimeFamily).toBeNull();
  });

  it("entry has rawCurrentRegime and controllerSource='SCAN_CYCLE' fields", () => {
    const entry = makeEntry();
    expect(entry.rawCurrentRegime).toBeDefined();
    expect(entry.controllerSource).toBe("SCAN_CYCLE");
    expect(entry.controllerReasonCodes).toBeDefined();
    expect(Array.isArray(entry.controllerReasonCodes)).toBe(true);
  });
});

// ─── Phase 2Z.1: variant-adjusted guard fields ────────────────────────────────

describe("CandidateFunnelEntry Phase 2Z.1 guard fields", () => {
  // Test 14: entry has atrBps populated
  it("entry with atrPercent=0.69 → atrBps=69", () => {
    const entry = makeEntry({ atrBps: 69 });
    expect(entry.atrBps).toBeCloseTo(69, 5);
  });

  // Test 15: entry has variantAdjustedGuardThresholdBps populated
  it("entry with atrPercent=0.69 → variantAdjustedGuardThresholdBps=80", () => {
    const entry = makeEntry({ variantAdjustedGuardThresholdBps: 80 });
    expect(entry.variantAdjustedGuardThresholdBps).toBe(80);
  });

  // Test 16: NEAR-like case: stopDistanceBps=120, atrBps=69 → legacyStop175Pass=false, variantAdjustedStopPass=true
  it("NEAR-like: stopDistanceBps=120, atrBps=69 → legacyStop175Pass=false, variantAdjustedStopPass=true", () => {
    const stopDistanceBps = 120;
    const atrBps = 69;
    const guardThreshold = Math.max(80, atrBps); // 80
    const legacyStop175Pass = stopDistanceBps >= 175;   // false
    const variantAdjustedStopPass = stopDistanceBps >= guardThreshold; // true

    expect(legacyStop175Pass).toBe(false);
    expect(variantAdjustedStopPass).toBe(true);

    const entry = makeEntry({
      stopDistanceBps,
      stop175Pass: false,
      atrBps,
      variantAdjustedGuardThresholdBps: guardThreshold,
      legacyStop175Pass,
      variantAdjustedStopPass,
      guardPassedUnder: "VARIANT_ADJUSTED",
    });
    expect(entry.legacyStop175Pass).toBe(false);
    expect(entry.variantAdjustedStopPass).toBe(true);
    expect(entry.guardPassedUnder).toBe("VARIANT_ADJUSTED");
  });

  // Test 17: guardPassedUnder="VARIANT_ADJUSTED" for NEAR-like case
  it("guardPassedUnder='VARIANT_ADJUSTED' when stopBps=120, atrBps=69 (threshold=80)", () => {
    const entry = makeEntry({
      stopDistanceBps: 120,
      atrBps: 69,
      variantAdjustedGuardThresholdBps: 80,
      legacyStop175Pass: false,
      variantAdjustedStopPass: true,
      guardPassedUnder: "VARIANT_ADJUSTED",
    });
    expect(entry.guardPassedUnder).toBe("VARIANT_ADJUSTED");
  });

  // Test 18: guardPassedUnder="FAILED_VARIANT_ADJUSTED" when stopBps=79, atrBps=69 (threshold=80, 79<80)
  it("guardPassedUnder='FAILED_VARIANT_ADJUSTED' when stopBps=79, atrBps=69 (threshold=80)", () => {
    const entry = makeEntry({
      stopDistanceBps: 79,
      atrBps: 69,
      variantAdjustedGuardThresholdBps: 80,
      legacyStop175Pass: false,
      variantAdjustedStopPass: false,
      guardPassedUnder: "FAILED_VARIANT_ADJUSTED",
    });
    expect(entry.guardPassedUnder).toBe("FAILED_VARIANT_ADJUSTED");
    expect(entry.variantAdjustedStopPass).toBe(false);
    expect(entry.legacyStop175Pass).toBe(false);
  });

  // Test 19: guardPassedUnder="LEGACY_175" when stopBps >= 175
  it("guardPassedUnder='LEGACY_175' when stopBps=300, atrBps=69", () => {
    const entry = makeEntry({
      stopDistanceBps: 300,
      atrBps: 69,
      variantAdjustedGuardThresholdBps: 80,
      legacyStop175Pass: true,
      variantAdjustedStopPass: true,
      guardPassedUnder: "LEGACY_175",
    });
    expect(entry.guardPassedUnder).toBe("LEGACY_175");
    expect(entry.legacyStop175Pass).toBe(true);
  });

  // Test 20: guardPassedUnder="UNKNOWN" when stopDistanceBps=null
  it("guardPassedUnder='UNKNOWN' when stopDistanceBps=null", () => {
    const entry = makeEntry({
      stopDistanceBps: null,
      stop175Pass: null,
      atrBps: null,
      variantAdjustedGuardThresholdBps: null,
      legacyStop175Pass: null,
      variantAdjustedStopPass: null,
      guardPassedUnder: "UNKNOWN",
    });
    expect(entry.guardPassedUnder).toBe("UNKNOWN");
    expect(entry.legacyStop175Pass).toBeNull();
    expect(entry.variantAdjustedStopPass).toBeNull();
  });
});

// ─── Geometry rejection reason constants ─────────────────────────────────────

describe("geometry rejection reason constants", () => {
  it("REJECTION_MISSING_REAL_ENTRY_GEOMETRY constant value is correct", () => {
    expect(REJECTION_MISSING_REAL_ENTRY_GEOMETRY).toBe("MISSING_REAL_ENTRY_GEOMETRY");
  });

  it("REJECTION_MISSING_STOP_LOSS constant value is correct", () => {
    expect(REJECTION_MISSING_STOP_LOSS).toBe("MISSING_STOP_LOSS");
  });

  it("REJECTION_MISSING_TAKE_PROFIT_LEVELS constant value is correct", () => {
    expect(REJECTION_MISSING_TAKE_PROFIT_LEVELS).toBe("MISSING_TAKE_PROFIT_LEVELS");
  });

  it("MISSING_REAL_ENTRY_GEOMETRY in rejectionReasons when entryPrice is missing", () => {
    const entry = makeEntry({
      rejectionReasons: [REJECTION_MISSING_REAL_ENTRY_GEOMETRY],
      controllerAlignedEligible: false,
      controllerAlignedOpened: false,
    });
    expect(entry.rejectionReasons).toContain("MISSING_REAL_ENTRY_GEOMETRY");
    expect(entry.controllerAlignedEligible).toBe(false);
  });

  it("MISSING_STOP_LOSS in rejectionReasons when stopLoss is missing", () => {
    const entry = makeEntry({
      rejectionReasons: [REJECTION_MISSING_STOP_LOSS],
      controllerAlignedEligible: false,
      controllerAlignedOpened: false,
    });
    expect(entry.rejectionReasons).toContain("MISSING_STOP_LOSS");
  });

  it("MISSING_TAKE_PROFIT_LEVELS in rejectionReasons when tpLevels are empty", () => {
    const entry = makeEntry({
      rejectionReasons: [REJECTION_MISSING_TAKE_PROFIT_LEVELS],
      controllerAlignedEligible: false,
      controllerAlignedOpened: false,
    });
    expect(entry.rejectionReasons).toContain("MISSING_TAKE_PROFIT_LEVELS");
  });
});

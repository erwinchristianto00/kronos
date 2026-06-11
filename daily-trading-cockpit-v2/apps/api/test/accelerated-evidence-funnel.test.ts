/**
 * Tests for the Accelerated Evidence Funnel Diagnostics (report-only).
 */

import { describe, it, expect } from "vitest";

import type { ShadowPosition } from "@dtc/shared";

import {
  buildAcceleratedEvidenceFunnelReport,
  buildAcceleratedEvidenceFunnelReportFromLog,
} from "../src/lib/accelerated-evidence-funnel.js";
import { RISK_HYGIENE_GUARD_V1 } from "../src/lib/shadow-engine.js";
import type { ControllerAlignedShadowPosition } from "../src/lib/regime-controller-aligned-shadow.js";
import type { CandidateFunnelEntry } from "../src/lib/accelerated-evidence-candidate-funnel-log.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePosition(overrides: {
  stopDistanceBps?: number | null;
  riskHygieneGuardVersion?: string | null;
  direction?: "LONG" | "SHORT";
  variantState?: "OPEN" | "CLOSED" | "PARTIAL";
  closeReason?: string;
  scannedAt?: string;
}): ShadowPosition {
  const variantState = overrides.variantState ?? "CLOSED";
  const closeReason = overrides.closeReason ?? "TP1_FULL";

  return {
    id: `test-${Math.random()}`,
    ideaKey: "test-idea",
    symbol: "BTCUSDT",
    direction: overrides.direction ?? "LONG",
    signalFamily: "BREAKOUT",
    scannedAt: overrides.scannedAt ?? "2026-01-01T00:00:00.000Z",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    lastEvaluatedAt: "2026-01-01T00:00:00.000Z",
    scanCount: 1,
    latestStatus: "TRADE_NOW",
    latestScore: 80,
    latestReason: [],
    entryZone: [100, 102],
    entryPrice: 101,
    stopLoss: 95,
    tp1: 110,
    tp2: null,
    tp3: null,
    riskReward: 1.5,
    dangerScore: 20,
    selectedEntryVariant: "base_current_entry",
    selectedExitVariant: "tp1_full_exit",
    variantSelection: {
      selectedEntryVariant: "base_current_entry",
      selectedExitVariant: "tp1_full_exit",
      expectedGrossR: null,
      expectedNetR: null,
      netEdgeAfterCost: null,
      profitFactor: null,
      fillRate: null,
      noFillRate: null,
      costR: null,
      spreadR: null,
      feeSlippageR: null,
      stopDistanceBps: overrides.stopDistanceBps ?? null,
      variantSampleSize: 0,
      variantConfidenceTier: "early",
      routeMode: "RESEARCH_ONLY",
      selectionSource: "heuristic_fallback",
      costAssumption: "default",
      selectionReason: "test",
      entryDriftPct: null,
      entryDriftAtr: null,
      entryQualityExplanation: [],
      exitPlanExplanation: [],
      chaseRisk: "LOW",
    },
    primaryVariant: "tp1_full_exit",
    tradePlan: {
      directionGap: 0.5,
      directionQuality: "CLEAR",
      biasSummary: "bullish",
      entryPlaybook: "PULLBACK_RECLAIM",
      entryAction: "ENTER_ON_TRIGGER",
      exactEntryTrigger: "test",
      noChaseWarning: null,
      invalidation: [],
      stopLoss: 95,
      takeProfit1: 110,
      takeProfit2: null,
      takeProfit3: null,
      exitMode: "TP1_FAST",
      earlyExitCondition: "none",
      runnerAllowed: false,
      horizonConflict: false,
      shortHorizonOnly: false,
      stagedEntrySplit: "1:0",
      stagedExitSplit: "1:0",
      why: [],
    },
    variants: [
      {
        variant: "tp1_full_exit",
        state: variantState,
        openedAt: "2026-01-01T00:00:00.000Z",
        lastUpdatedAt: "2026-01-02T00:00:00.000Z",
        closedAt: variantState === "CLOSED" ? "2026-01-02T00:00:00.000Z" : null,
        remainingSizePct: variantState === "OPEN" ? 1 : 0,
        realizedGrossR: 0.5,
        realizedNetR: 0.3,
        unrealizedR: 0,
        currentPrice: 110,
        stopPrice: 95,
        tp1Hit: true,
        tp2Hit: false,
        tp3Hit: false,
        slMovedToBreakeven: false,
        closeReason: closeReason as "TP1_FULL",
        profitableAfterCosts: true,
      },
    ],
    stopDistanceBps: overrides.stopDistanceBps ?? null,
    riskHygieneGuardVersion: overrides.riskHygieneGuardVersion ?? null,
    policyVersion: "base-route-anchor-consistent-v2",
  } as unknown as ShadowPosition;
}

function makeAlignedObs(status: ControllerAlignedShadowPosition["status"]): ControllerAlignedShadowPosition {
  return {
    id: `aligned-${Math.random()}`,
    symbol: "BTCUSDT",
    direction: "LONG",
    routeMode: "RESEARCH_ONLY",
    entryVariant: null,
    exitVariant: null,
    entryPrice: 101,
    stopLoss: 0,
    takeProfitLevels: [],
    stopDistanceBps: 300,
    controllerMode: "LONG_ONLY",
    controllerAlignment: "ALIGNED",
    openedAt: new Date().toISOString(),
    closedAt: null,
    marketRegimeAtOpen: null,
    status,
    netR: null,
    grossR: null,
    laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1",
    reportOnly: true,
    policyVersion: "base-route-anchor-consistent-v2",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildAcceleratedEvidenceFunnelReport", () => {
  it("stop<175 positions (no guard stamp) do not count as stop175Eligible", () => {
    const positions = [
      makePosition({ stopDistanceBps: 100, riskHygieneGuardVersion: null }),
      makePosition({ stopDistanceBps: 50, riskHygieneGuardVersion: null }),
    ];
    const report = buildAcceleratedEvidenceFunnelReport(positions, [], {});
    expect(report.stop175Eligible).toBe(0);
    expect(report.normalShadowOpened).toBe(0);
  });

  it("stop>=175 positions with guard version stamp count as stop175Eligible", () => {
    const positions = [
      makePosition({ stopDistanceBps: 200, riskHygieneGuardVersion: RISK_HYGIENE_GUARD_V1 }),
      makePosition({ stopDistanceBps: 300, riskHygieneGuardVersion: RISK_HYGIENE_GUARD_V1 }),
    ];
    const report = buildAcceleratedEvidenceFunnelReport(positions, [], {});
    expect(report.stop175Eligible).toBe(2);
    expect(report.normalShadowOpened).toBe(2);
  });

  it("topRejectionReason is a non-null string when controllerMode is supplied", () => {
    const report = buildAcceleratedEvidenceFunnelReport(
      [makePosition({ direction: "SHORT" })],
      [],
      { controllerMode: "LONG_ONLY" },
    );
    expect(typeof report.topRejectionReason).toBe("string");
    expect(report.topRejectionReason).not.toBeNull();
    expect(report.topRejectionReason).toContain("LONG_ONLY");
  });

  it("controllerAlignedEligible counts non-NO_FILL aligned observations", () => {
    const aligned = [
      makeAlignedObs("OPEN"),
      makeAlignedObs("NO_FILL"),
      makeAlignedObs("OPEN"),
    ];
    const report = buildAcceleratedEvidenceFunnelReport([], aligned, {});
    expect(report.controllerAlignedEligible).toBe(2); // excludes NO_FILL
    expect(report.controllerAlignedOpened).toBe(3);   // total count
  });

  it("reportOnly is true", () => {
    const report = buildAcceleratedEvidenceFunnelReport([], [], {});
    expect(report.reportOnly).toBe(true);
  });

  it("stop175RejectedEstimate is null (cannot derive from positions)", () => {
    const report = buildAcceleratedEvidenceFunnelReport(
      [makePosition({ stopDistanceBps: 100 })],
      [],
      {},
    );
    expect(report.stop175RejectedEstimate).toBeNull();
  });

  it("byDirection counts positions correctly by direction", () => {
    const positions = [
      makePosition({ direction: "LONG" }),
      makePosition({ direction: "LONG" }),
      makePosition({ direction: "SHORT" }),
    ];
    const report = buildAcceleratedEvidenceFunnelReport(positions, [], {});
    const longRow = report.byDirection.find((r) => r.direction === "LONG");
    const shortRow = report.byDirection.find((r) => r.direction === "SHORT");
    expect(longRow?.n).toBe(2);
    expect(shortRow?.n).toBe(1);
  });

  it("open/closed position counts are correct", () => {
    const openPos = makePosition({ variantState: "OPEN", closeReason: "OPEN" });
    const closedPos = makePosition({ variantState: "CLOSED", closeReason: "TP1_FULL" });

    const report = buildAcceleratedEvidenceFunnelReport([openPos, closedPos], [], {});
    expect(report.totalPositions).toBe(2);
    expect(report.openPositions).toBe(1);
    expect(report.closedPositions).toBe(1);
  });
});

// ─── Log-based funnel report tests ────────────────────────────────────────────

function makeLogEntry(overrides: Partial<CandidateFunnelEntry> = {}): CandidateFunnelEntry {
  return {
    timestamp: new Date().toISOString(),
    scanCycleId: new Date().toISOString(),
    source: "SCAN_CYCLE",
    symbol: "BTCUSDT",
    direction: "LONG",
    currentRegime: "BULLISH_EXPANSION",
    controllerMode: "LONG_ONLY",
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

describe("buildAcceleratedEvidenceFunnelReportFromLog", () => {
  it("counts rawCandidatesLogged correctly", () => {
    const entries = [makeLogEntry(), makeLogEntry(), makeLogEntry()];
    const report = buildAcceleratedEvidenceFunnelReportFromLog(entries, [], {});
    expect(report.rawCandidatesLogged).toBe(3);
  });

  it("counts longCandidates and shortCandidates correctly", () => {
    const entries = [
      makeLogEntry({ direction: "LONG" }),
      makeLogEntry({ direction: "LONG" }),
      makeLogEntry({ direction: "SHORT" }),
    ];
    const report = buildAcceleratedEvidenceFunnelReportFromLog(entries, [], {});
    expect(report.longCandidates).toBe(2);
    expect(report.shortCandidates).toBe(1);
  });

  it("counts controllerAllowedCandidates and controllerBlockedCandidates correctly", () => {
    const entries = [
      makeLogEntry({ controllerAllowsDirection: true }),
      makeLogEntry({ controllerAllowsDirection: true }),
      makeLogEntry({ controllerAllowsDirection: false }),
    ];
    const report = buildAcceleratedEvidenceFunnelReportFromLog(entries, [], {});
    expect(report.controllerAllowedCandidates).toBe(2);
    expect(report.controllerBlockedCandidates).toBe(1);
  });

  it("counts stop175RejectedFromLog exactly", () => {
    const entries = [
      makeLogEntry({ rejectionReasons: ["STOP_DISTANCE_BELOW_175"] }),
      makeLogEntry({ rejectionReasons: ["STOP_DISTANCE_BELOW_175"] }),
      makeLogEntry({ rejectionReasons: [] }),
    ];
    const report = buildAcceleratedEvidenceFunnelReportFromLog(entries, [], {});
    expect(report.stop175RejectedFromLog).toBe(2);
  });

  it("counts sourceConflictRejected correctly", () => {
    const entries = [
      makeLogEntry({ rejectionReasons: ["SOURCE_CONFLICT_TRUE"] }),
      makeLogEntry({ rejectionReasons: ["LIVE_SOURCE_CONFLICT_TRUE"] }),
      makeLogEntry({ rejectionReasons: [] }),
    ];
    const report = buildAcceleratedEvidenceFunnelReportFromLog(entries, [], {});
    expect(report.sourceConflictRejected).toBe(2);
  });

  it("topRejectionReasons ordered by count descending", () => {
    const entries = [
      makeLogEntry({ rejectionReasons: ["STOP_DISTANCE_BELOW_175"] }),
      makeLogEntry({ rejectionReasons: ["STOP_DISTANCE_BELOW_175"] }),
      makeLogEntry({ rejectionReasons: ["STOP_DISTANCE_BELOW_175"] }),
      makeLogEntry({ rejectionReasons: ["DIRECTION_BLOCKED_BY_CONTROLLER"] }),
      makeLogEntry({ rejectionReasons: ["DIRECTION_BLOCKED_BY_CONTROLLER"] }),
    ];
    const report = buildAcceleratedEvidenceFunnelReportFromLog(entries, [], {});
    const reasons = report.topRejectionReasons ?? [];
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]!.reason).toBe("STOP_DISTANCE_BELOW_175");
    expect(reasons[0]!.count).toBe(3);
    expect(reasons[1]!.reason).toBe("DIRECTION_BLOCKED_BY_CONTROLLER");
    expect(reasons[1]!.count).toBe(2);
  });

  it("returns reportOnly=true", () => {
    const report = buildAcceleratedEvidenceFunnelReportFromLog([], [], {});
    expect(report.reportOnly).toBe(true);
  });

  it("empty entries returns zeros in log-specific fields", () => {
    const report = buildAcceleratedEvidenceFunnelReportFromLog([], [], {});
    expect(report.rawCandidatesLogged).toBe(0);
    expect(report.longCandidates).toBe(0);
    expect(report.shortCandidates).toBe(0);
    expect(report.controllerAllowedCandidates).toBe(0);
    expect(report.controllerBlockedCandidates).toBe(0);
    expect(report.stop175RejectedFromLog).toBe(0);
  });

  it("byControllerMode groups entries by controllerMode with correct counts", () => {
    const entries = [
      makeLogEntry({ controllerMode: "SHORT_ONLY", direction: "SHORT", controllerAllowsDirection: true, variantAdjustedStopPass: true }),
      makeLogEntry({ controllerMode: "SHORT_ONLY", direction: "LONG", controllerAllowsDirection: false, variantAdjustedStopPass: false }),
      makeLogEntry({ controllerMode: "LONG_ONLY", direction: "LONG", controllerAllowsDirection: true, variantAdjustedStopPass: true }),
    ];
    const report = buildAcceleratedEvidenceFunnelReportFromLog(entries, [], {});
    expect(report.byControllerMode).toBeDefined();
    const shortRow = report.byControllerMode!.find((r) => r.controllerMode === "SHORT_ONLY");
    const longRow = report.byControllerMode!.find((r) => r.controllerMode === "LONG_ONLY");
    expect(shortRow).toBeDefined();
    expect(longRow).toBeDefined();
    expect(shortRow!.rawCandidates).toBe(2);
    expect(shortRow!.allowedCandidates).toBe(1);
    expect(shortRow!.blockedCandidates).toBe(1);
    expect(shortRow!.variantAdjustedPass).toBe(1);
    expect(longRow!.rawCandidates).toBe(1);
    expect(longRow!.allowedCandidates).toBe(1);
  });

  it("latestScanCycleMode = controllerMode of last entry", () => {
    const entries = [
      makeLogEntry({ controllerMode: "LONG_ONLY" }),
      makeLogEntry({ controllerMode: "SHORT_ONLY" }),
    ];
    const report = buildAcceleratedEvidenceFunnelReportFromLog(entries, [], {});
    expect(report.latestScanCycleMode).toBe("SHORT_ONLY");
  });

  it("latestScanCycleMode is null for empty entries", () => {
    const report = buildAcceleratedEvidenceFunnelReportFromLog([], [], {});
    expect(report.latestScanCycleMode).toBeNull();
  });
});

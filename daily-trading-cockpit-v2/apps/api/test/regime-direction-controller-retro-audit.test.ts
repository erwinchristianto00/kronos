/**
 * Tests for the Regime Direction Controller Retrospective Dry-Run Audit.
 * All tests are report-only — no live behavior is tested or affected.
 */

import { describe, it, expect } from "vitest";

import type { ShadowPosition } from "@dtc/shared";

import { buildRegimeDirectionControllerRetroAudit } from "../src/lib/regime-direction-controller-retrospective-audit.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClosedPosition(overrides: {
  direction: "LONG" | "SHORT";
  marketRegimeAtOpen?: string | null;
  marketRegime?: string | null;
  realizedNetR?: number;
}): ShadowPosition {
  return {
    id: `test-${Math.random()}`,
    ideaKey: "test-idea",
    symbol: "BTCUSDT",
    direction: overrides.direction,
    signalFamily: "BREAKOUT",
    scannedAt: "2026-01-01T00:00:00.000Z",
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
    tp2: 120,
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
      stopDistanceBps: 300,
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
      takeProfit2: 120,
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
        state: "CLOSED",
        openedAt: "2026-01-01T00:00:00.000Z",
        lastUpdatedAt: "2026-01-02T00:00:00.000Z",
        closedAt: "2026-01-02T00:00:00.000Z",
        remainingSizePct: 0,
        realizedGrossR: (overrides.realizedNetR ?? 0) + 0.1,
        realizedNetR: overrides.realizedNetR ?? 0,
        unrealizedR: 0,
        currentPrice: 110,
        stopPrice: 95,
        tp1Hit: (overrides.realizedNetR ?? 0) > 0,
        tp2Hit: false,
        tp3Hit: false,
        slMovedToBreakeven: false,
        closeReason: (overrides.realizedNetR ?? 0) > 0 ? "TP1_FULL" : "SL",
        profitableAfterCosts: (overrides.realizedNetR ?? 0) > 0,
      },
    ],
    marketRegimeAtOpen: overrides.marketRegimeAtOpen !== undefined
      ? overrides.marketRegimeAtOpen
      : null,
    marketRegime: overrides.marketRegime ?? null,
    policyVersion: "base-route-anchor-consistent-v2",
    riskHygieneGuardMinStopDistanceBps: 175,
    riskHygieneGuardVersion: "base-route-risk-hygiene-stop175-v1",
  } as unknown as ShadowPosition;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildRegimeDirectionControllerRetroAudit", () => {
  it("bullish expansion regime → LONG_ONLY, SHORT position is blocked", () => {
    const positions = [
      makeClosedPosition({
        direction: "SHORT",
        marketRegimeAtOpen: "BULLISH_EXPANSION",
        realizedNetR: 0.5,
      }),
    ];
    const report = buildRegimeDirectionControllerRetroAudit(positions);

    expect(report.reportOnly).toBe(true);
    expect(report.totalClosed).toBe(1);

    const byDecision = report.byDecision;
    const blocked = byDecision.find((d) => d.decision === "BLOCKED");
    const allowed = byDecision.find((d) => d.decision === "ALLOWED");
    expect(blocked?.n).toBe(1);
    expect(allowed?.n).toBe(0);

    const byMode = report.byMode;
    const longOnlyRow = byMode.find((r) => r.controllerMode === "LONG_ONLY");
    expect(longOnlyRow).toBeTruthy();
    expect(longOnlyRow?.blockedN).toBe(1);
    expect(longOnlyRow?.allowedN).toBe(0);
  });

  it("bearish expansion regime → SHORT_ONLY, LONG position is blocked", () => {
    const positions = [
      makeClosedPosition({
        direction: "LONG",
        marketRegimeAtOpen: "BEARISH_EXPANSION",
        realizedNetR: -0.8,
      }),
    ];
    const report = buildRegimeDirectionControllerRetroAudit(positions);

    const blocked = report.byDecision.find((d) => d.decision === "BLOCKED");
    expect(blocked?.n).toBe(1);

    const shortOnlyRow = report.byMode.find((r) => r.controllerMode === "SHORT_ONLY");
    expect(shortOnlyRow).toBeTruthy();
    expect(shortOnlyRow?.blockedN).toBe(1);
    expect(shortOnlyRow?.allowedN).toBe(0);
  });

  it("LONG_ONLY + LONG direction → ALLOWED", () => {
    const positions = [
      makeClosedPosition({
        direction: "LONG",
        marketRegimeAtOpen: "BULLISH_EXPANSION",
        realizedNetR: 0.3,
      }),
    ];
    const report = buildRegimeDirectionControllerRetroAudit(positions);

    const allowed = report.byDecision.find((d) => d.decision === "ALLOWED");
    expect(allowed?.n).toBe(1);

    const longOnlyRow = report.byMode.find((r) => r.controllerMode === "LONG_ONLY");
    expect(longOnlyRow?.allowedN).toBe(1);
    expect(longOnlyRow?.blockedN).toBe(0);
  });

  it("null regime → UNKNOWN classification", () => {
    const positions = [
      makeClosedPosition({
        direction: "LONG",
        marketRegimeAtOpen: null,
        realizedNetR: 0.1,
      }),
    ];
    const report = buildRegimeDirectionControllerRetroAudit(positions);

    expect(report.noRegime).toBe(1);
    expect(report.withRegime).toBe(0);

    const unknown = report.byDecision.find((d) => d.decision === "UNKNOWN");
    expect(unknown?.n).toBe(1);

    const unknownMode = report.byMode.find((r) => r.controllerMode === "UNKNOWN");
    expect(unknownMode).toBeTruthy();
  });

  it("byDecision aggregate: allowed/blocked/unknown counts are correct", () => {
    const positions = [
      makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: 0.5 }),   // allowed
      makeClosedPosition({ direction: "SHORT", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: -1.0 }), // blocked
      makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: null, realizedNetR: 0.2 }),                  // unknown
    ];
    const report = buildRegimeDirectionControllerRetroAudit(positions);

    expect(report.totalClosed).toBe(3);
    expect(report.byDecision.find((d) => d.decision === "ALLOWED")?.n).toBe(1);
    expect(report.byDecision.find((d) => d.decision === "BLOCKED")?.n).toBe(1);
    expect(report.byDecision.find((d) => d.decision === "UNKNOWN")?.n).toBe(1);
  });

  it("PF calculation returns null when no negative R entries", () => {
    // All positive R — no negative bucket → PF should be null
    const positions = [
      makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: 1.0 }),
      makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: 0.5 }),
    ];
    const report = buildRegimeDirectionControllerRetroAudit(positions);

    const allowedRow = report.byDecision.find((d) => d.decision === "ALLOWED");
    // All positions are allowed (LONG in LONG_ONLY) — PF null because no negatives
    expect(allowedRow?.n).toBe(2);
    expect(allowedRow?.PF).toBeNull();
  });

  it("WR calculation returns correct win rate", () => {
    const positions = [
      makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: 1.0 }),  // win
      makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: -0.5 }), // loss
      makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: 0.2 }),  // win
      makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: -0.3 }), // loss
    ];
    const report = buildRegimeDirectionControllerRetroAudit(positions);

    const allowedRow = report.byDecision.find((d) => d.decision === "ALLOWED");
    expect(allowedRow?.n).toBe(4);
    // 2 wins out of 4 = 0.5
    expect(allowedRow?.WR).toBeCloseTo(0.5);
  });

  it("returns reportOnly true and the retrospective label", () => {
    const report = buildRegimeDirectionControllerRetroAudit([]);
    expect(report.reportOnly).toBe(true);
    expect(report.label).toBe("RETROSPECTIVE — not prospective validation");
  });

  it("open positions (not CLOSED state) are excluded from the count", () => {
    // Create a position with only OPEN variants
    const openPos = makeClosedPosition({ direction: "LONG", marketRegimeAtOpen: "BULLISH_EXPANSION", realizedNetR: 1.0 });
    // Override variants to be OPEN
    (openPos.variants as unknown as Array<Record<string, unknown>>)[0].state = "OPEN";
    (openPos.variants as unknown as Array<Record<string, unknown>>)[0].closeReason = "OPEN";

    const report = buildRegimeDirectionControllerRetroAudit([openPos]);
    expect(report.totalClosed).toBe(0);
    expect(report.byDecision.every((d) => d.n === 0)).toBe(true);
  });
});

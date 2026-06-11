import { describe, expect, it } from "vitest";

import type { ShadowExecutionEvent, ShadowPosition } from "@dtc/shared";

import { buildBaseRouteRiskHygieneMonitor } from "../src/lib/base-route-risk-hygiene-monitor.js";
import { BASE_ROUTE_POLICY_VERSION_V2, RISK_HYGIENE_GUARD_V1, STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK } from "../src/lib/shadow-engine.js";

function makePosition({
  scannedAt,
  policyVersion = BASE_ROUTE_POLICY_VERSION_V2,
  riskHygieneGuardMinStopDistanceBps = 175,
  riskHygieneGuardVersion = RISK_HYGIENE_GUARD_V1,
  stopDistanceBps = 150,
  costR = 0.2,
  variantState = "CLOSED",
  closeReason = "TP1_FULL",
  gross = 0.4,
  net = 0.2,
}: {
  scannedAt: string;
  policyVersion?: string | null;
  riskHygieneGuardMinStopDistanceBps?: number | null;
  riskHygieneGuardVersion?: string | null;
  stopDistanceBps?: number | null;
  costR?: number | null;
  variantState?: "OPEN" | "CLOSED";
  closeReason?: string | null;
  gross?: number;
  net?: number;
}): ShadowPosition {
  return {
    id: `pos-${scannedAt}`,
    ideaKey: `idea-${scannedAt}`,
    marketIdeaKey: `market-${scannedAt}`,
    symbol: "BTCUSDT",
    direction: "LONG",
    signalFamily: "TREND_CONTINUATION",
    scannedAt,
    firstSeenAt: scannedAt,
    lastSeenAt: scannedAt,
    lastEvaluatedAt: scannedAt,
    scanCount: 1,
    latestStatus: "READY",
    latestScore: 80,
    latestReason: [],
    entryZone: [100, 100],
    entryState: "FILLED",
    entryPrice: 100,
    spreadPercent: 0.02,
    stopDistanceBps,
    costR,
    stopLoss: 98.5,
    tp1: 101,
    tp2: null,
    tp3: null,
    riskReward: 1.8,
    dangerScore: 20,
    selectedEntryVariant: "base_current_entry",
    selectedExitVariant: "tp1_full_exit",
    variantSelection: {
      selectedEntryVariant: "base_current_entry",
      selectedExitVariant: "tp1_full_exit",
      expectedGrossR: 0.5,
      expectedNetR: 0.3,
      calibratedExpectedNetR: 0.3,
      calibrationVerdict: "CALIBRATED_POSITIVE",
      evidenceEra: "POST_CALIBRATION",
      netEdgeAfterCost: 0.3,
      profitFactor: 1.2,
      fillRate: null,
      noFillRate: null,
      costR,
      spreadR: 0.05,
      feeSlippageR: 0.15,
      stopDistanceBps,
      variantSampleSize: 10,
      variantConfidenceTier: "provisional",
      routeMode: "DATA_COLLECTION",
      selectionSource: "replay",
      costAssumption: "test",
      selectionReason: "test",
      entryDriftPct: 0,
      entryDriftAtr: 0,
      entryQualityExplanation: [],
      exitPlanExplanation: [],
      chaseRisk: "LOW",
    },
    primaryVariant: "tp1_full_exit",
    tradePlan: {
      entryPrice: 100,
      stopLoss: 98.5,
      takeProfit1: 101,
      takeProfit2: null,
      takeProfit3: null,
      riskReward: 1.8,
      cancelTrade: false,
      cancelTradeReason: null,
    },
    variants: [{
      variant: "tp1_full_exit",
      state: variantState,
      openedAt: scannedAt,
      lastUpdatedAt: scannedAt,
      closedAt: variantState === "CLOSED" ? scannedAt : null,
      stopPrice: 98.5,
      currentPrice: 100,
      remainingSizePct: variantState === "CLOSED" ? 0 : 1,
      realizedGrossR: gross,
      realizedNetR: net,
      unrealizedR: 0,
      tp1Hit: closeReason === "TP1_FULL",
      tp2Hit: false,
      tp3Hit: false,
      closeReason: closeReason as never,
      profitableAfterCosts: net > 0,
    }],
    marketRegime: "BEARISH_EXPANSION",
    policyVersion,
    riskHygieneGuardMinStopDistanceBps,
    riskHygieneGuardVersion,
  } as ShadowPosition;
}

function makeSkip(createdAt: string): ShadowExecutionEvent {
  return {
    id: `skip-${createdAt}`,
    positionId: "pending-entry",
    ideaKey: `idea-${createdAt}`,
    symbol: "BTCUSDT",
    direction: "LONG",
    variant: "idea",
    type: "ENTRY_SKIPPED",
    message: `${STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK}: base_current_entry selected but stop distance 84bps is below 100bps for normal active/base shadow admission. Plan: base_current_entry + tp1_full_exit.`,
    createdAt,
    price: 100,
    rValue: null,
  };
}

describe("base route risk hygiene monitor", () => {
  it("reports current-guard tape separately from legacy tape; verdict is COLLECTING_CURRENT_GUARD_TAPE when < 20 closes", () => {
    const report = buildBaseRouteRiskHygieneMonitor(
      [
        // Legacy position (no policyVersion, no guard stamp) — goes into legacyOrMixed, NOT current-guard
        makePosition({ scannedAt: "2026-05-20T12:00:00.000Z", policyVersion: null, riskHygieneGuardMinStopDistanceBps: null, riskHygieneGuardVersion: null, stopDistanceBps: 60, costR: 0.9, gross: 0.1, net: -0.8 }),
        // Current-guard positions (v2 + stop175 stamp)
        makePosition({ scannedAt: "2026-05-21T14:00:00.000Z", variantState: "OPEN" }),
        makePosition({ scannedAt: "2026-05-21T14:05:00.000Z", stopDistanceBps: 200, costR: 0.2, gross: 0.4, net: 0.2 }),
      ],
      [
        makeSkip("2026-05-21T13:33:54.662Z"),
        makeSkip("2026-05-21T13:40:00.000Z"),
      ],
      { era: "POST_CALIBRATION" },
      new Date("2026-05-21T20:00:00.000Z"),
    );

    expect(report.guardActivatedAtRetainedLog).toBe("2026-05-21T13:33:54.662Z");
    expect(report.skippedUltraTightCandidates.total).toBe(2);
    expect(report.skippedUltraTightCandidates.recent24h).toBe(2);
    // Current-guard tape: 2 positions (both stamped with stop175-v1)
    expect(report.postGuardTape.closedN).toBe(1);
    expect(report.postGuardTape.openN).toBe(1);
    expect(report.postGuardTape.below175ClosedN).toBe(0); // 200bps >= 175 → no residue
    expect(report.postGuardTape.anchorConsistentPositionCount).toBe(2);
    expect(report.postGuardTape.mixedOrLegacyPositionCount).toBe(0);
    // Legacy tape: 1 position (policyVersion: null)
    expect(report.legacyOrMixedTape.closedN).toBe(1);
    // Verdict: < 20 current-guard closes → collecting
    expect(report.verdict).toBe("COLLECTING_CURRENT_GUARD_TAPE");
  });

  it("promotes verdict to RISK_HYGIENE_IMPROVING when >= 20 current-guard closes, netAvgR >= 0, and no below-175 residue", () => {
    const currentGuardPositions = Array.from({ length: 20 }, (_, index) =>
      makePosition({
        scannedAt: `2026-05-21T14:${String(index).padStart(2, "0")}:00.000Z`,
        stopDistanceBps: 200,
        costR: 0.12,
        gross: 0.32,
        net: 0.2,
      }),
    );
    const report = buildBaseRouteRiskHygieneMonitor(
      [
        makePosition({ scannedAt: "2026-05-20T12:00:00.000Z", policyVersion: null, riskHygieneGuardMinStopDistanceBps: null, riskHygieneGuardVersion: null, stopDistanceBps: 70, costR: 0.95, gross: 0.05, net: -0.9 }),
        ...currentGuardPositions,
      ],
      [makeSkip("2026-05-21T13:33:54.662Z")],
      { era: "POST_CALIBRATION" },
      new Date("2026-05-21T20:00:00.000Z"),
    );

    expect(report.postGuardTape.closedN).toBe(20);
    expect(report.postGuardTape.below175ClosedN).toBe(0);
    expect(report.postGuardTape.netAvgR).not.toBeNull();
    expect((report.postGuardTape.netAvgR ?? 0)).toBeGreaterThanOrEqual(0);
    expect(report.verdict).toBe("RISK_HYGIENE_IMPROVING");
  });

  it("returns CURRENT_GUARD_OUTCOME_NEGATIVE when >= 20 current-guard closes and netAvgR < 0", () => {
    // Scenario: current-guard tape has 21 closes but all are losers (netAvgR < 0).
    const currentGuardPositions = Array.from({ length: 21 }, (_, index) =>
      makePosition({
        scannedAt: `2026-05-21T14:${String(index).padStart(2, "0")}:00.000Z`,
        stopDistanceBps: 200,
        costR: 0.12,
        gross: -0.9,
        net: -1.0,
      }),
    );
    const report = buildBaseRouteRiskHygieneMonitor(
      [
        makePosition({ scannedAt: "2026-05-20T12:00:00.000Z", policyVersion: null, riskHygieneGuardMinStopDistanceBps: null, riskHygieneGuardVersion: null, stopDistanceBps: 60, costR: 0.95, gross: 0.05, net: -1.5 }),
        ...currentGuardPositions,
      ],
      [makeSkip("2026-05-21T13:33:54.662Z")],
      { era: "POST_CALIBRATION" },
      new Date("2026-05-21T20:00:00.000Z"),
    );

    expect(report.postGuardTape.closedN).toBe(21);
    expect(report.postGuardTape.netAvgR).not.toBeNull();
    expect((report.postGuardTape.netAvgR ?? 0)).toBeLessThan(0);
    expect(report.verdict).not.toBe("RISK_HYGIENE_IMPROVING");
    expect(report.verdict).toBe("CURRENT_GUARD_OUTCOME_NEGATIVE");
  });

  it("Fix 3: previous hygiene tape (v2 positions without stop175-v1 stamp) does NOT contaminate current-guard residue", () => {
    // Previous hygiene positions: V2 policy but no guard stamp → go into previousHygieneTape
    const prevHygienePositions = Array.from({ length: 10 }, (_, index) =>
      makePosition({
        scannedAt: `2026-05-10T14:${String(index).padStart(2, "0")}:00.000Z`,
        stopDistanceBps: 120, // < 175 — this would contaminate current-guard if not separated
        riskHygieneGuardVersion: null,         // no stop175-v1 stamp
        riskHygieneGuardMinStopDistanceBps: null,
        gross: 0.1,
        net: -0.2,
      }),
    );
    // Current-guard positions: v2 + stop175-v1 stamp, clean (>175 bps)
    const currentGuardPositions = Array.from({ length: 5 }, (_, index) =>
      makePosition({
        scannedAt: `2026-05-21T14:${String(index).padStart(2, "0")}:00.000Z`,
        stopDistanceBps: 200, // > 175 — clean
        gross: 0.3,
        net: 0.15,
      }),
    );
    const report = buildBaseRouteRiskHygieneMonitor(
      [...prevHygienePositions, ...currentGuardPositions],
      [makeSkip("2026-05-21T13:33:54.662Z")],
      { era: "POST_CALIBRATION" },
      new Date("2026-05-21T20:00:00.000Z"),
    );
    // Current-guard tape should only see the 5 current-guard positions
    expect(report.postGuardTape.closedN).toBe(5);
    expect(report.postGuardTape.below175ClosedN).toBe(0); // no contamination from previous tape
    // Previous hygiene tape sees the 10 old positions
    expect(report.previousHygieneTape.closedN).toBe(10);
    expect(report.previousHygieneTape.below175ClosedN).toBe(10); // all below 175
    // Verdict based only on current-guard (< 20 closes)
    expect(report.verdict).toBe("COLLECTING_CURRENT_GUARD_TAPE");
  });

  it("Fix 3: current-guard closed=0 → verdict COLLECTING_CURRENT_GUARD_TAPE", () => {
    const report = buildBaseRouteRiskHygieneMonitor(
      [makePosition({ scannedAt: "2026-05-21T14:00:00.000Z", variantState: "OPEN" })],
      [makeSkip("2026-05-21T13:33:54.662Z")],
      { era: "POST_CALIBRATION" },
      new Date("2026-05-21T20:00:00.000Z"),
    );
    expect(report.postGuardTape.closedN).toBe(0);
    expect(report.verdict).toBe("COLLECTING_CURRENT_GUARD_TAPE");
  });

  describe("currentGuardLaneSummary (report-only)", () => {
    it("emits currentGuardLaneSummary with all required fields and status=COLLECTING when closed<50", () => {
      const positions = Array.from({ length: 10 }, (_, i) =>
        makePosition({
          scannedAt: `2026-05-21T14:${String(i).padStart(2, "0")}:00.000Z`,
          stopDistanceBps: 200,
          costR: 0.12,
          gross: 0.3,
          net: 0.1,
        }),
      );
      const report = buildBaseRouteRiskHygieneMonitor(
        positions,
        [makeSkip("2026-05-21T13:33:54.662Z")],
        { era: "POST_CALIBRATION" },
        new Date("2026-05-21T20:00:00.000Z"),
      );
      const lane = report.currentGuardLaneSummary!;
      expect(lane).toBeDefined();
      expect(lane.reportOnly).toBe(true);
      expect(lane.laneId).toBe("BASE_ROUTE_STOP175_CURRENT_GUARD");
      expect(lane.source).toBe("F*. Base Route Risk Hygiene Monitor");
      expect(lane.closed).toBe(10);
      expect(lane.wins).toBe(10);
      expect(lane.losses).toBe(0);
      expect(lane.netAvgR).toBeCloseTo(0.1, 5);
      expect(lane.byRegime.length).toBeGreaterThan(0);
      expect(lane.symbolConcentration.length).toBeGreaterThan(0);
      expect(lane.byRoute.length).toBeGreaterThan(0);
      expect(lane.status).toBe("COLLECTING");
      expect(lane.cautions.some((c) => c.includes("not live approval"))).toBe(true);
    });

    it("status=WATCHABLE when closed>=50, netAvgR>0, avgCostR<=0.15", () => {
      const positions = Array.from({ length: 62 }, (_, i) =>
        makePosition({
          scannedAt: `2026-05-21T14:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
          stopDistanceBps: 200,
          costR: 0.12,
          gross: 0.20,
          net: 0.085,
        }),
      );
      const report = buildBaseRouteRiskHygieneMonitor(
        positions,
        [makeSkip("2026-05-21T13:33:54.662Z")],
        { era: "POST_CALIBRATION" },
        new Date("2026-05-21T20:00:00.000Z"),
      );
      const lane = report.currentGuardLaneSummary!;
      expect(lane.closed).toBe(62);
      expect(lane.status).toBe("WATCHABLE");
      expect(lane.cautions.some((c) => c.includes("Insufficient sample for promotion"))).toBe(true);
    });

    it("status=PROMOTION_CANDIDATE when closed>=200, netAvgR>0.05, pf>1.20, recency stable, max symbol<=40%", () => {
      // Mix of wins and losses across two symbols to satisfy PF>1.20 + concentration<=40%
      const positions: ReturnType<typeof makePosition>[] = [];
      const winNet = 0.30;
      const lossNet = -0.10;
      const winGross = 0.40;
      const lossGross = -0.10;
      for (let i = 0; i < 200; i++) {
        const isWin = i % 5 !== 0; // 80% wins
        const pos = makePosition({
          scannedAt: `2026-05-${String(1 + Math.floor(i / 60)).padStart(2, "0")}T14:${String(i % 60).padStart(2, "0")}:00.000Z`,
          stopDistanceBps: 200,
          costR: 0.10,
          gross: isWin ? winGross : lossGross,
          net: isWin ? winNet : lossNet,
        });
        // Spread across two symbols so no symbol exceeds ~50% then trim further:
        // use three symbols to keep concentration well under 40%.
        const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
        pos.symbol = symbols[i % symbols.length] as string;
        positions.push(pos);
      }
      const report = buildBaseRouteRiskHygieneMonitor(
        positions,
        [makeSkip("2026-05-01T13:33:54.662Z")],
        { era: "POST_CALIBRATION" },
        new Date("2026-05-21T20:00:00.000Z"),
      );
      const lane = report.currentGuardLaneSummary!;
      expect(lane.closed).toBe(200);
      expect((lane.netAvgR ?? 0)).toBeGreaterThan(0.05);
      expect((lane.pf ?? 0)).toBeGreaterThan(1.20);
      expect(lane.recencySplit.stable).toBe(true);
      expect((lane.symbolConcentration[0]?.share ?? 0)).toBeLessThanOrEqual(0.40);
      expect(lane.status).toBe("PROMOTION_CANDIDATE");
    });

    it("status=REJECT when netAvgR<=0", () => {
      const positions = Array.from({ length: 60 }, (_, i) =>
        makePosition({
          scannedAt: `2026-05-21T14:${String(i % 60).padStart(2, "0")}:00.000Z`,
          stopDistanceBps: 200,
          costR: 0.12,
          gross: -0.2,
          net: -0.1,
        }),
      );
      const report = buildBaseRouteRiskHygieneMonitor(
        positions,
        [makeSkip("2026-05-21T13:33:54.662Z")],
        { era: "POST_CALIBRATION" },
        new Date("2026-05-21T20:00:00.000Z"),
      );
      const lane = report.currentGuardLaneSummary!;
      expect(lane.status).toBe("REJECT");
      expect(lane.statusReason).toContain("netAvgR");
    });

    it("PF computed from sum of wins divided by abs(sum of losses)", () => {
      const positions = [
        makePosition({ scannedAt: "2026-05-21T14:00:00.000Z", gross: 1.0, net: 0.8, stopDistanceBps: 200 }),
        makePosition({ scannedAt: "2026-05-21T14:01:00.000Z", gross: 1.0, net: 0.8, stopDistanceBps: 200 }),
        makePosition({ scannedAt: "2026-05-21T14:02:00.000Z", gross: -1.0, net: -1.2, stopDistanceBps: 200 }),
      ];
      const report = buildBaseRouteRiskHygieneMonitor(
        positions,
        [makeSkip("2026-05-21T13:33:54.662Z")],
        { era: "POST_CALIBRATION" },
        new Date("2026-05-21T20:00:00.000Z"),
      );
      const lane = report.currentGuardLaneSummary!;
      // wins=2 each grossR=1.0 → sum=2; losses=1 grossR=-1.0 → abs sum=1; PF=2.0
      expect(lane.pf).toBeCloseTo(2.0, 5);
    });

    it("recency split divides closed positions in half by openedAt", () => {
      const positions = Array.from({ length: 10 }, (_, i) =>
        makePosition({
          scannedAt: `2026-05-21T14:${String(i).padStart(2, "0")}:00.000Z`,
          stopDistanceBps: 200,
          gross: i < 5 ? -0.5 : 0.5,
          net: i < 5 ? -0.3 : 0.3,
        }),
      );
      const report = buildBaseRouteRiskHygieneMonitor(
        positions,
        [makeSkip("2026-05-21T13:33:54.662Z")],
        { era: "POST_CALIBRATION" },
        new Date("2026-05-21T20:00:00.000Z"),
      );
      const lane = report.currentGuardLaneSummary!;
      expect(lane.recencySplit.earlyHalf?.n).toBe(5);
      expect(lane.recencySplit.lateHalf?.n).toBe(5);
      expect((lane.recencySplit.earlyHalf?.netAvgR ?? 0)).toBeLessThan(0);
      expect((lane.recencySplit.lateHalf?.netAvgR ?? 0)).toBeGreaterThan(0);
      expect(lane.recencySplit.stable).toBe(false);
    });

    it("cautions include symbol concentration when one symbol exceeds 40% PnL", () => {
      const positions: ReturnType<typeof makePosition>[] = [];
      for (let i = 0; i < 10; i++) {
        const pos = makePosition({
          scannedAt: `2026-05-21T14:${String(i).padStart(2, "0")}:00.000Z`,
          stopDistanceBps: 200,
          gross: 0.5,
          net: 0.3,
        });
        // 9/10 positions are BTC → very high concentration
        pos.symbol = i < 9 ? "BTCUSDT" : "ETHUSDT";
        positions.push(pos);
      }
      const report = buildBaseRouteRiskHygieneMonitor(
        positions,
        [makeSkip("2026-05-21T13:33:54.662Z")],
        { era: "POST_CALIBRATION" },
        new Date("2026-05-21T20:00:00.000Z"),
      );
      const lane = report.currentGuardLaneSummary!;
      expect(lane.cautions.some((c) => c.includes("Symbol concentration risk"))).toBe(true);
    });
  });
});

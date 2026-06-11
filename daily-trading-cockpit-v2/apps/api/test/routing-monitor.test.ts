import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildRoutingMonitorReport } from "../src/lib/routing-monitor.js";

function makeVariantSelection(
  entry: ExecutionEntryVariant,
  exit: ShadowPositionVariant,
  routeMode: VariantSelectionSnapshot["routeMode"],
): VariantSelectionSnapshot {
  return {
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    expectedGrossR: 0,
    expectedNetR: 0,
    netEdgeAfterCost: null,
    profitFactor: null,
    fillRate: null,
    noFillRate: null,
    costR: null,
    spreadR: null,
    feeSlippageR: null,
    stopDistanceBps: null,
    variantSampleSize: 0,
    variantConfidenceTier: "provisional",
    routeMode,
    selectionSource: "heuristic_fallback",
    costAssumption: "",
    selectionReason: "",
    entryDriftPct: null,
    entryDriftAtr: null,
    entryQualityExplanation: [],
    exitPlanExplanation: [],
    chaseRisk: "LOW",
  };
}

function makePosition(opts: {
  id: string;
  symbol?: string;
  firstSeenAt: string;
  routeMode: VariantSelectionSnapshot["routeMode"];
  entry: ExecutionEntryVariant;
  exit: ShadowPositionVariant;
  closedNetR?: number[];
  tp1Hit?: boolean[];
  closeReasons?: ("TP1_FULL" | "SL" | "BREAKEVEN" | "TRAIL_STOP")[];
  /** Pass true to simulate a pre-routing position with no variantSelection */
  legacyNoSelection?: boolean;
}): ShadowPosition {
  const variants = (opts.closedNetR ?? []).map((netR, i) => ({
    variant: opts.exit,
    state: "CLOSED" as const,
    openedAt: opts.firstSeenAt,
    lastUpdatedAt: opts.firstSeenAt,
    closedAt: opts.firstSeenAt,
    remainingSizePct: 0,
    realizedGrossR: netR,
    realizedNetR: netR,
    tp1Hit: opts.tp1Hit?.[i] ?? false,
    tp2Hit: false,
    tp3Hit: false,
    slHit: (opts.closeReasons?.[i] ?? (netR < 0 ? "SL" : "TP1_FULL")) === "SL",
    closeReason: opts.closeReasons?.[i] ?? (netR < 0 ? "SL" : "TP1_FULL"),
  }));
  return {
    id: opts.id,
    ideaKey: opts.id,
    symbol: opts.symbol ?? "BTCUSDT",
    direction: "LONG",
    signalFamily: "BREAKOUT",
    scannedAt: opts.firstSeenAt,
    firstSeenAt: opts.firstSeenAt,
    lastSeenAt: opts.firstSeenAt,
    lastEvaluatedAt: opts.firstSeenAt,
    scanCount: 1,
    latestStatus: "READY",
    latestScore: 60,
    latestReason: [],
    entryZone: [99, 101],
    entryPrice: 100,
    stopLoss: 97,
    tp1: 103,
    tp2: 105,
    tp3: 108,
    riskReward: 2,
    dangerScore: 30,
    selectedEntryVariant: opts.entry,
    selectedExitVariant: opts.exit,
    variantSelection: opts.legacyNoSelection ? undefined : makeVariantSelection(opts.entry, opts.exit, opts.routeMode),
    primaryVariant: opts.exit,
    tradePlan: {
      entryZone: [99, 101],
      stopLoss: 97,
      tp1: 103,
      tp2: 105,
      tp3: 108,
      riskReward: 2,
      runnerAllowed: false,
      reason: "",
      explanation: "",
      contextExplanation: [],
      trailing: { active: false, mode: "NONE", anchor: null, distancePct: null, distanceR: null, explanation: [] },
      partialPlan: { tp1Action: "FULL_EXIT", tp1ExitPct: 100, breakevenAfterTp1: true, runnerPct: 0, runnerInvalidations: [] },
      timing: { entryAction: "ENTER_ON_TRIGGER", entryAnchor: "MID_ZONE", waitForCloseConfirmation: false, cancelIfInvalidated: true, reentryRule: "NO_REENTRY", driftWarning: null },
      playbook: { entryPlaybook: "PULLBACK_RECLAIM", exitMode: "TP1_FAST", confidence: 0.6 },
      biasSummary: "",
      contextSummary: "",
    },
    variants,
  };
}

describe("buildRoutingMonitorReport", () => {
  const TODAY = "2026-05-11T12:00:00.000Z";
  const todayDate = "2026-05-11";

  it("produces routeMode distribution and new-ideas-today counts", () => {
    const positions = [
      makePosition({ id: "1", firstSeenAt: TODAY, routeMode: "PROFIT_CANDIDATE", entry: "fib_500_entry", exit: "tp1_full_exit" }),
      makePosition({ id: "2", firstSeenAt: TODAY, routeMode: "DATA_COLLECTION", entry: "fib_500_entry", exit: "tp1_full_exit" }),
      makePosition({ id: "3", firstSeenAt: "2026-05-10T01:00:00.000Z", routeMode: "RESEARCH_ONLY", entry: "no_chase_atr_entry", exit: "kronos_runner_exit" }),
      makePosition({ id: "4", firstSeenAt: "2026-05-10T01:00:00.000Z", routeMode: "RESEARCH_ONLY", entry: "no_chase_atr_entry", exit: "kronos_runner_exit" }),
    ];
    const report = buildRoutingMonitorReport(positions, new Date(TODAY));
    expect(report.date).toBe(todayDate);
    expect(report.routeModeDistribution.PROFIT_CANDIDATE).toBe(1);
    expect(report.routeModeDistribution.DATA_COLLECTION).toBe(1);
    expect(report.routeModeDistribution.RESEARCH_ONLY).toBe(2);
    expect(report.newIdeasToday).toBe(2);
    expect(report.newIdeasTodayByRoute.PROFIT_CANDIDATE).toBe(1);
    expect(report.newIdeasTodayByRoute.RESEARCH_ONLY).toBe(0);
  });

  it("counts no_chase_atr and kronos_runner selections", () => {
    const positions = [
      makePosition({ id: "1", firstSeenAt: TODAY, routeMode: "RESEARCH_ONLY", entry: "no_chase_atr_entry", exit: "kronos_runner_exit" }),
      makePosition({ id: "2", firstSeenAt: TODAY, routeMode: "RESEARCH_ONLY", entry: "no_chase_atr_entry", exit: "tp1_full_exit" }),
      makePosition({ id: "3", firstSeenAt: TODAY, routeMode: "DATA_COLLECTION", entry: "fib_500_entry", exit: "tp1_full_exit" }),
    ];
    const r = buildRoutingMonitorReport(positions, new Date(TODAY));
    expect(r.noChaseAtrSelectedCount).toBe(2);
    expect(r.kronosRunnerSelectedCount).toBe(1);
    expect(r.tp1FullSelectedCount).toBe(2);
    expect(r.fib500SelectedCount).toBe(1);
  });

  it("computes DATA_COLLECTION + PROFIT_CANDIDATE scope metrics from closed variants", () => {
    const positions = [
      // 2 PROFIT_CANDIDATE closes: +1.0R (TP1 hit), -0.5R (SL)
      makePosition({ id: "pc", firstSeenAt: TODAY, routeMode: "PROFIT_CANDIDATE", entry: "fib_500_entry", exit: "tp1_full_exit", closedNetR: [1.0, -0.5], tp1Hit: [true, false], closeReasons: ["TP1_FULL", "SL"] }),
      // 1 DATA_COLLECTION close: +0.3R TP1 hit
      makePosition({ id: "dc", firstSeenAt: TODAY, routeMode: "DATA_COLLECTION", entry: "fib_500_entry", exit: "tp1_full_exit", closedNetR: [0.3], tp1Hit: [true], closeReasons: ["TP1_FULL"] }),
    ];
    const r = buildRoutingMonitorReport(positions, new Date(TODAY));
    expect(r.profitCandidate.closedCount).toBe(2);
    expect(r.profitCandidate.netAvgR).toBeCloseTo(0.25, 4);
    expect(r.profitCandidate.profitFactor).toBeCloseTo(2.0, 4);
    expect(r.dataCollection.closedCount).toBe(1);
    expect(r.dataCollection.netAvgR).toBeCloseTo(0.3, 4);
  });

  it("returns fib_500+tp1_full watcher with correct fields", () => {
    const positions = [
      makePosition({ id: "1", firstSeenAt: TODAY, routeMode: "DATA_COLLECTION", entry: "fib_500_entry", exit: "tp1_full_exit", closedNetR: [0.5], tp1Hit: [true] }),
      makePosition({ id: "2", firstSeenAt: TODAY, routeMode: "DATA_COLLECTION", entry: "fib_500_entry", exit: "tp1_full_exit", closedNetR: [-0.2] }),
      makePosition({ id: "3", firstSeenAt: TODAY, routeMode: "DATA_COLLECTION", entry: "fib_382_entry", exit: "tp1_full_exit", closedNetR: [1.0] }),
    ];
    const r = buildRoutingMonitorReport(positions, new Date(TODAY));
    expect(r.fib500TpFull.ideas).toBe(2);
    expect(r.fib500TpFull.resolved).toBe(2);
    expect(r.fib500TpFull.targetResolved).toBe(20);
    expect(r.fib500TpFull.netAvgR).toBeCloseTo(0.15, 4);
    expect(r.fib500TpFull.status).toBe("collecting");
  });

  it("fib500TpFull watcher reports 'promising' when ≥10 resolved with positive net and PF>1", () => {
    // 10 closes: 7 wins at +0.5, 3 losses at -0.3 → net avg = (3.5 - 0.9) / 10 = +0.26
    const closes = [
      ...Array(7).fill(0.5),
      ...Array(3).fill(-0.3),
    ];
    const tp1Hits = closes.map((r) => r > 0);
    const positions = [
      makePosition({
        id: "cohort",
        firstSeenAt: TODAY,
        routeMode: "DATA_COLLECTION",
        entry: "fib_500_entry",
        exit: "tp1_full_exit",
        closedNetR: closes,
        tp1Hit: tp1Hits,
      }),
    ];
    const r = buildRoutingMonitorReport(positions, new Date(TODAY));
    expect(r.fib500TpFull.resolved).toBe(10);
    expect(r.fib500TpFull.netAvgR).toBeGreaterThan(0);
    expect(r.fib500TpFull.profitFactor).toBeGreaterThan(1);
    expect(r.fib500TpFull.status).toBe("promising");
  });

  it("fib500TpFull watcher reports 'promotable' when ≥20 resolved, netAvgR>0.2, PF>1.5", () => {
    // 20 closes: 14 wins at +0.6, 6 losses at -0.2 → net = (8.4 - 1.2) / 20 = +0.36, PF = 8.4/1.2 = 7.0
    const closes = [
      ...Array(14).fill(0.6),
      ...Array(6).fill(-0.2),
    ];
    const tp1Hits = closes.map((r) => r > 0);
    const positions = [
      makePosition({
        id: "cohort",
        firstSeenAt: TODAY,
        routeMode: "DATA_COLLECTION",
        entry: "fib_500_entry",
        exit: "tp1_full_exit",
        closedNetR: closes,
        tp1Hit: tp1Hits,
      }),
    ];
    const r = buildRoutingMonitorReport(positions, new Date(TODAY));
    expect(r.fib500TpFull.resolved).toBe(20);
    expect(r.fib500TpFull.netAvgR).toBeGreaterThan(0.2);
    expect(r.fib500TpFull.profitFactor).toBeGreaterThan(1.5);
    expect(r.fib500TpFull.status).toBe("promotable");
  });

  it("identifies top profit leaks (worst combos with ≥3 closed)", () => {
    const positions = [
      // Bad combo: 3 closes, all losses
      makePosition({ id: "bad1", firstSeenAt: TODAY, routeMode: "RESEARCH_ONLY", entry: "no_chase_atr_entry", exit: "kronos_runner_exit", closedNetR: [-1.0, -0.8, -1.5], closeReasons: ["SL", "SL", "SL"] }),
      // Good combo: 3 closes, mostly wins
      makePosition({ id: "good1", firstSeenAt: TODAY, routeMode: "DATA_COLLECTION", entry: "fib_500_entry", exit: "tp1_full_exit", closedNetR: [0.5, 0.4, 0.3], closeReasons: ["TP1_FULL", "TP1_FULL", "TP1_FULL"] }),
      // Borderline / only 1 close — should NOT appear in leaks
      makePosition({ id: "small", firstSeenAt: TODAY, routeMode: "DATA_COLLECTION", entry: "vwap_retest_entry", exit: "tp1_full_exit", closedNetR: [-2.0] }),
    ];
    const r = buildRoutingMonitorReport(positions, new Date(TODAY));
    expect(r.topProfitLeaks.length).toBe(1);
    expect(r.topProfitLeaks[0].entryVariant).toBe("no_chase_atr_entry");
    expect(r.topImprovingRoutes.length).toBe(1);
    expect(r.topImprovingRoutes[0].entryVariant).toBe("fib_500_entry");
  });

  it("handles empty position list gracefully", () => {
    const r = buildRoutingMonitorReport([], new Date(TODAY));
    expect(r.routeModeDistribution.PROFIT_CANDIDATE).toBe(0);
    expect(r.profitCandidate.netAvgR).toBeNull();
    expect(r.dataCollection.netAvgR).toBeNull();
    expect(r.topProfitLeaks).toEqual([]);
    expect(r.topImprovingRoutes).toEqual([]);
    expect(r.legacyLeaks).toEqual([]);
    expect(r.fib500TpFull.status).toBe("collecting");
    expect(r.fib500TpFull.netAvgR).toBeNull();
  });

  it("labels unknown+unknown positions as LEGACY_UNKNOWN_ROUTE and excludes them from topProfitLeaks", () => {
    const positions = [
      // Legacy position with no variantSelection (pre-routing) — should become unknown+unknown
      makePosition({
        id: "legacy1", firstSeenAt: "2026-04-01T00:00:00.000Z",
        routeMode: "RESEARCH_ONLY", entry: "no_chase_atr_entry", exit: "kronos_runner_exit",
        legacyNoSelection: true,
        closedNetR: [-1.0, -1.5, -2.0],
      }),
      // Normal leak — should appear in topProfitLeaks
      makePosition({
        id: "norm1", firstSeenAt: TODAY,
        routeMode: "RESEARCH_ONLY", entry: "no_chase_atr_entry", exit: "kronos_runner_exit",
        closedNetR: [-0.5, -0.6, -0.7],
      }),
    ];
    const r = buildRoutingMonitorReport(positions, new Date(TODAY));

    // Legacy positions end up as "unknown + unknown" in the combo map
    expect(r.legacyLeaks.length).toBe(1);
    expect(r.legacyLeaks[0].isLegacyUnknown).toBe(true);

    // topProfitLeaks only contains the non-legacy combo
    expect(r.topProfitLeaks.length).toBe(1);
    expect(r.topProfitLeaks[0].entryVariant).toBe("no_chase_atr_entry");
    expect(r.topProfitLeaks.every((row) => !row.isLegacyUnknown)).toBe(true);
  });

  it("does not include unknown+unknown in topImprovingRoutes", () => {
    const positions = [
      // Legacy position that happens to be profitable — should NOT appear in improving routes
      makePosition({
        id: "leg2", firstSeenAt: "2026-04-01T00:00:00.000Z",
        routeMode: "RESEARCH_ONLY", entry: "no_chase_atr_entry", exit: "tp1_full_exit",
        legacyNoSelection: true,
        closedNetR: [1.0, 0.8, 0.9],
      }),
    ];
    const r = buildRoutingMonitorReport(positions, new Date(TODAY));
    expect(r.topImprovingRoutes.length).toBe(0);
    expect(r.legacyLeaks.length).toBe(1); // still shows in legacy
  });
});

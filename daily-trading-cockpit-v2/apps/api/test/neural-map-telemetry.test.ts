import { describe, expect, it } from "vitest";
import { buildNeuralMapTelemetry } from "../src/lib/neural-map-telemetry.js";

function baseInput(): Parameters<typeof buildNeuralMapTelemetry>[0] {
  return {
    generatedAt: "2026-06-06T12:00:00.000Z",
    controller: {
      currentRegime: "Mixed rotation",
      controllerMode: "VALIDATION_ONLY",
      directionalBias: "MIXED",
      confidence: "LOW",
      allowsLong: true,
      allowsShort: true,
      allowsNewEntries: false,
      requiresRetest: false,
      reasonCodes: ["REGIME_MIXED_NO_CONVICTION"],
      warnings: [],
      currentValidationPrimaryLane: null,
      reportOnly: true,
    },
    scanStatus: {
      enabled: true,
      intervalMinutes: 7,
      firstRunPolicy: "IMMEDIATE_AFTER_STARTUP",
      isRunning: false,
      skippedWhileRunningCount: 0,
      lastAutoRefreshStartedAt: "2026-06-06T11:59:40.000Z",
      lastAutoRefreshFinishedAt: "2026-06-06T11:59:55.000Z",
      lastAutoRefreshStatus: "SUCCESS",
      lastAutoRefreshError: null,
      lastAutoRefreshResultSummary: { scannedSymbols: 20, returnedSymbols: 5, marketRegime: "Mixed rotation" },
    },
    scanTiming: null,
    paper: {
      total: 3, open: 1, closed: 2, win: 1, loss: 1, noFill: 0, expired: 0, dataFailure: 0,
      headlineTotal: 2, headlineClosed: 2, headlineWin: 1, headlineLoss: 1,
      diagnosticOnlyTotal: 1, diagnosticOnlyClosed: 0,
      headlineNetAvgR: 0.2, headlinePF: 1.5, headlineWR: 0.5,
      headlineAvgWinR: 1, headlineAvgLossR: -0.6, headlinePayoffRatio: 1.67,
      paperEquity: 2000, startingEquity: 2000, realizedPaperPnl: 100,
      diagnosticRealizedPaperPnl: 25, totalRealizedPaperPnl: 125,
      monthHeadlinePaperPnl: 100, monthDiagnosticPaperPnl: 25, monthTotalPaperPnl: 125,
      taipeiDailyClosed: 1, taipeiDailyWins: 1, taipeiDailyLosses: 0,
      taipeiDailyHeadlinePnl: 20, taipeiDailyDiagnosticPnl: 5, taipeiDailyTotalPnl: 25,
      dailyPaperPnl: 20,
      rolling5: { n: 2, netAvgR: 0.2, pf: 1.5, wr: 0.5 },
      rolling10: { n: 2, netAvgR: 0.2, pf: 1.5, wr: 0.5 },
      rolling20: { n: 2, netAvgR: 0.2, pf: 1.5, wr: 0.5 },
      activeLane: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      laneConfidence: "MEDIUM", paperLaneConfidence: "MEDIUM",
      activeLaneClosed: 2, activeLaneNetAvgR: 0.2, activeLanePF: 1.5, activeLaneWR: 0.5,
      rotationAction: "KEEP_CURRENT_LANE", selectedNextLaneId: null,
      operationalSafetyStatus: "OK", paperStartAt: "2026-06-01T00:00:00.000Z",
      latestOrders: [], noOrderReason: null, reportOnly: true, paperOnly: true,
    },
    orders: [],
    variantMatrix: {
      reportOnly: true, laneVersion: "CURRENT_GUARD_VARIANT_MATRIX_V1",
      policyVersion: "current-guard-variant-matrix-v1", computedAt: "2026-06-06T12:00:00.000Z",
      cutoverTimestamp: null, sourcePopulationNote: "", totalObservations: 0, variantCount: 1,
      baselineVariantId: "CG_BASELINE_CURRENT",
      rows: [{
        variantId: "CG_WIDE_STOP_TP_WIDE", label: "Wide", exitRule: "tp1_full", fillMode: "taker", costModel: "taker",
        total: 20, open: 0, resolved: 20, freshValid: 20, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
        netAvgR: 0.8, grossAvgR: 0.9, pf: 3, wr: 0.7, avgWinR: 1, avgLossR: -0.5,
        payoffRatio: 2, breakEvenWR: 1 / 3, actualWR: 0.7, avgCostR: 0.1, costDragR: 0.1,
        noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 1,
        maxAdverseStreak: 1, topSymbolPnlShare: 0.2, plus10bpsNetAvgR: 0.7, plus10bpsStillPositive: true,
        calendarDays: 7, distinctRegimes: 2, byRegime: [], byEntryVariant: [], oosThirds: null,
        allThreeOosPositive: true, rolling: [], status: "STABLE_CANDIDATE", statusReason: "stable",
        blockers: [], cautions: [],
      }],
      bestVariantId: "CG_WIDE_STOP_TP_WIDE", bestVariantNetAvgR: 0.8, bestBeatsBaseline: true,
      resolverDiagnostics: { lastRunAt: null, resolvedThisRun: null, expiredThisRun: null, dataFailuresThisRun: null, staleOpenCount: 0, oldestOpenAgeHours: null, nextAction: null },
      liveBlocked: true, microPilotAllowed: false, notes: [],
    },
    mixed: {
      reportOnly: true, diagnosticOnly: true, activeGateChange: false, version: 1,
      regimeIsMixed: true, mixedTradingMode: "REDUCE_WIDE",
      activeMixedLane: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      activeMixedLanes: ["CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE"], activeMixedLaneReason: "qualified",
      backlog: { openOrderCount: 1, staleWideHoldCount: 0, criticalCount: 0, staleRatio: 0, oldestOpenHoldHours: 1 },
      staleRecommendation: "NORMAL_ADMISSION", stalePassHealth: "DIRECTIONALLY_BENIGN",
      admissionResult: "ALLOW_REDUCED", occupancyMode: "REDUCED_RISK",
      occupancy: { laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", budget: { maxWideOpen: 26, maxWideStale: 16, maxPerSymbolOpen: 2, maxPerDirectionOpen: 24, maxPassStaleShare: 0.8 }, wideOpenCount: 1, wideStaleCount: 0, perSymbolOpenCount: 0, perDirectionOpenCount: 1, passOpenCount: 1, passStaleCount: 0, passStaleShare: 0, exceeded: [], elevated: [] },
      activeMixedBudgetProfile: "SYMBOL_SAFE_RELAXED", budgetSource: "SIMULATION_RECOMMENDED",
      budgetActivationScope: "PAPER_ONLY", mixedBudgetVersion: 1, trailLaneAvailable: true,
      passCount: 2, rejectCount: 0, insufficientCount: 0, allowCount: 0, allowReducedCount: 2,
      waitForCapacityCount: 0, states: [],
      stalePassSummary: { freshPassN: 95, freshPassNetAvgR: 0.9, freshPassPF: 41, freshPassWR: 0.98, stalePassN: 14, stalePassNetAvgR: 0.97, stalePassPF: Infinity, stalePassWR: 1, conversionRatio: 1.08, verdict: "INSUFFICIENT", reason: "" },
    },
    mixedValidation: {
      reportOnly: true, diagnosticOnly: true, activeGateChange: false, liveBlocked: true, microPilotAllowed: false,
      generatedAt: "2026-06-06T12:00:00.000Z", activeMixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
      budgetSource: "SIMULATION_RECOMMENDED", budgetActivationScope: "PAPER_ONLY", mixedBudgetVersion: 1,
      newDecisionsCount: 2, newAllowCount: 0, newAllowReducedCount: 2, newWaitCapacityCount: 0,
      newRejectCount: 0, closedUnderProfileCount: 0, profileNetAvgR: null, profilePF: null, profileWR: null,
      profileAvgHoldHours: null, verdict: "NEED_MORE_OOS",
      guardrail: { status: "COLLECTING_OOS", reasons: ["OOS_TOO_SMALL"], recommendedAction: "KEEP_COLLECTING", closedUnderProfileCount: 0, netAvgR: null, pf: null, wr: null, waitCapacityCount: 0, allowPlusReduced: 2, waitCapacitySpike: false, oosThreshold: 30 },
    },
    staleAudit: {
      reportOnly: true, diagnosticOnly: true, openOrderCount: 1, staleWideHoldCount: 0, criticalCount: 0,
      staleRatio: 0, oldestOpenHoldHours: 1, bySymbol: {}, byDirection: {}, byToxicFlag: {}, byGateDecision: {}, byLane: {},
      recommendation: "NORMAL_ADMISSION", stalePassHealth: "DIRECTIONALLY_BENIGN", admissionResult: "ALLOW",
      occupancyMode: "NORMAL",
      occupancy: { laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", budget: { maxWideOpen: 26, maxWideStale: 16, maxPerSymbolOpen: 2, maxPerDirectionOpen: 24, maxPassStaleShare: 0.8 }, wideOpenCount: 1, wideStaleCount: 0, perSymbolOpenCount: 0, perDirectionOpenCount: 0, passOpenCount: 1, passStaleCount: 0, passStaleShare: 0, exceeded: [], elevated: [] },
      stalePassSummary: { freshPassN: 0, freshPassNetAvgR: null, freshPassPF: null, freshPassWR: null, stalePassN: 0, stalePassNetAvgR: null, stalePassPF: null, stalePassWR: null, conversionRatio: null, verdict: "INSUFFICIENT", reason: "" },
      rows: [],
    },
  } as Parameters<typeof buildNeuralMapTelemetry>[0];
}

describe("neural map telemetry", () => {
  it("keeps safety locks visible and marks the active healthy lane", () => {
    const result = buildNeuralMapTelemetry(baseInput());
    expect(result.safety).toEqual({ liveBlocked: true, microPilotAllowed: false, paperOnly: true });
    expect(result.lanes[0]).toMatchObject({
      active: true,
      health: "COLLECTING",
      evidenceHealth: "HEALTHY",
      totalPnlPct: 0,
      headlinePnlPct: 0,
      startingEquity: 2000,
    });
    expect(result.lanes[0]?.label).toBe("CG_WIDE SHORT");
    expect(result.nodes.find((node) => node.id === "live-lock")?.metric).toBe("LIVE BLOCKED");
    expect(result.nodes.find((node) => node.id === "live-lock")).toMatchObject({
      diagnosisCategory: "BLOCKING_CONDITION",
    });
  });

  it("colors a lane by realized profit while preserving evidence health separately", () => {
    const input = baseInput();
    input.orders = [{
      id: "paper-1",
      observationId: "obs-1",
      sourceObservationKey: "BTCUSDT|SHORT|2026-06-06T11:00:00.000Z",
      sourceType: "ALLOCATOR_LANE",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      symbol: "BTCUSDT",
      direction: "SHORT",
      regime: "Bearish pressure",
      entryPrice: 100,
      stopLoss: 103,
      takeProfitLevels: [97],
      paperStatus: "PAPER_CLOSED_WIN",
      plannedStopDistanceBps: 300,
      openedAt: "2026-06-06T11:00:00.000Z",
      updatedAt: "2026-06-06T12:00:00.000Z",
      paperOrderMode: "HEADLINE",
      paperRiskLabel: "NORMAL",
      netPnlAmount: 1697,
      grossR: 1,
      costR: -0.07,
      netR: 0.93,
      closeReason: "TP_HIT",
      reportOnly: true,
      paperOnly: true,
    } as never];
    const result = buildNeuralMapTelemetry(input);
    expect(result.lanes[0]).toMatchObject({
      health: "HEALTHY",
      evidenceHealth: "HEALTHY",
      totalPnl: 1697,
      headlinePnl: 1697,
    });
    expect(result.lanes[0]?.totalPnlPct).toBeCloseTo(84.85, 2);
    expect(result.lanes[0]?.headlinePnlPct).toBeCloseTo(84.85, 2);
  });

  it("tags the stats source and flags diagnostic-only PnL so datasets can never be conflated", () => {
    const input = baseInput();
    input.orders = [{
      id: "paper-diag-1",
      observationId: "obs-d1",
      sourceObservationKey: "BTCUSDT|SHORT|2026-06-06T11:00:00.000Z",
      sourceType: "ALLOCATOR_LANE",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      symbol: "BTCUSDT",
      direction: "SHORT",
      regime: "Bearish pressure",
      entryPrice: 100,
      stopLoss: 103,
      takeProfitLevels: [97],
      paperStatus: "PAPER_CLOSED_WIN",
      plannedStopDistanceBps: 300,
      openedAt: "2026-06-06T11:00:00.000Z",
      updatedAt: "2026-06-06T12:00:00.000Z",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      paperRiskLabel: "NORMAL",
      netPnlAmount: 500,
      grossR: 1,
      costR: -0.07,
      netR: 0.93,
      closeReason: "TP_HIT",
      reportOnly: true,
      paperOnly: true,
    } as never];
    const result = buildNeuralMapTelemetry(input);
    const lane = result.lanes.find((l) => l.id === "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    // Stats block comes from the VM-sim row → must be tagged; PnL is diagnostic-only → flagged.
    expect(lane).toMatchObject({ statsSource: "VM_SIM", pnlIsDiagnosticOnly: true });
    expect(lane?.reason).toContain("[stats: VM-sim]");
    expect(lane?.reason).toContain("diagnostic-only");
  });

  it("colors performance from HEADLINE PnL when headline evidence exists (diagnostic profit cannot mask a headline loss)", () => {
    const input = baseInput();
    const order = (id: string, mode: "HEADLINE" | "DIAGNOSTIC_ONLY", status: string, pnl: number) => ({
      id,
      observationId: `obs-${id}`,
      sourceObservationKey: `BTCUSDT|SHORT|2026-06-06T11:00:00.000Z|${id}`,
      sourceType: "ALLOCATOR_LANE",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      symbol: "BTCUSDT",
      direction: "SHORT",
      regime: "Bearish pressure",
      entryPrice: 100,
      stopLoss: 103,
      takeProfitLevels: [97],
      paperStatus: status,
      plannedStopDistanceBps: 300,
      openedAt: "2026-06-06T11:00:00.000Z",
      updatedAt: "2026-06-06T12:00:00.000Z",
      paperOrderMode: mode,
      paperRiskLabel: "NORMAL",
      netPnlAmount: pnl,
      grossR: pnl > 0 ? 1 : -1,
      costR: -0.07,
      netR: pnl > 0 ? 0.93 : -1.07,
      closeReason: pnl > 0 ? "TP_HIT" : "SL_HIT",
      reportOnly: true,
      paperOnly: true,
    });
    input.orders = [
      order("h-loss", "HEADLINE", "PAPER_CLOSED_LOSS", -100),
      order("d-win", "DIAGNOSTIC_ONLY", "PAPER_CLOSED_WIN", 500),
    ] as never[];
    const result = buildNeuralMapTelemetry(input);
    const lane = result.lanes.find((l) => l.id === "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    // totalPnl is +400, but the headline reality is a -100 loss → the color must be CRITICAL.
    expect(lane?.totalPnl).toBe(400);
    expect(lane?.headlinePnl).toBe(-100);
    expect(lane?.health).toBe("CRITICAL");
    expect(lane?.pnlIsDiagnosticOnly).toBe(false);
  });

  it("surfaces scan failures and guardrail rollback as critical alerts", () => {
    const input = baseInput();
    input.scanStatus!.lastAutoRefreshStatus = "FAILED";
    input.scanStatus!.lastAutoRefreshError = "provider timeout";
    input.mixedValidation.guardrail.status = "ROLLBACK_RECOMMENDED";
    input.mixedValidation.guardrail.recommendedAction = "ROLLBACK_TO_CONSERVATIVE";
    const result = buildNeuralMapTelemetry(input);
    expect(result.alerts.some((alert) => alert.source === "Core Market Scan" && alert.severity === "CRITICAL")).toBe(true);
    expect(result.alerts.some((alert) => alert.source === "Mixed Budget Guardrail" && alert.severity === "CRITICAL")).toBe(true);
  });

  it("does not render hypothetical mixed occupancy as an active warning outside Mixed", () => {
    const input = baseInput();
    input.controller.currentRegime = "Bullish expansion";
    input.controller.controllerMode = "LONG_ONLY";
    input.mixed.regimeIsMixed = false;
    input.mixed.mixedTradingMode = "OFF";
    input.mixed.admissionResult = "WAIT_FOR_CAPACITY";
    const result = buildNeuralMapTelemetry(input);
    expect(result.mixed.admission).toBe("INACTIVE");
    expect(result.nodes.find((node) => node.id === "occupancy")).toMatchObject({
      health: "IDLE",
      active: false,
      metric: "INACTIVE",
    });
  });

  it("shows candidate-level capacity waits even when aggregate admission allows", () => {
    const input = baseInput();
    input.mixed.admissionResult = "ALLOW";
    input.mixed.waitForCapacityCount = 1;
    input.mixed.states = [{
      symbol: "XRPUSDT",
      regimeLabel: "Mixed rotation",
      pressureLabel: "Bullish",
      direction: "LONG",
      toxicSymbolFlag: false,
      capTier: null,
      volatilityBucket: "MID",
      liquidityBucket: "UNKNOWN",
      rotationBucket: "UNKNOWN",
      atrPercent: 0.8,
      volatilityScore: 0.5,
      liquidityScore: 0.9,
      forwardGateId: "mixed-forward-gate-v1",
      forwardGateDecision: "REJECT",
      forwardGateReasons: [],
      mixedRouteDecision: "ROUTE_LONG_CG_WIDE",
      mixedRouteReasons: [],
      admissionResult: "WAIT_FOR_CAPACITY",
      occupancyMode: "WAIT_FOR_CAPACITY",
      stalePassHealth: "UNKNOWN",
      occupancy: {
        laneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
        budget: { maxWideOpen: 26, maxWideStale: 16, maxPerSymbolOpen: 2, maxPerDirectionOpen: 24, maxPassStaleShare: 0.8 },
        wideOpenCount: 6, wideStaleCount: 0, perSymbolOpenCount: 2, perDirectionOpenCount: 6,
        passOpenCount: 6, passStaleCount: 0, passStaleShare: 0,
        exceeded: ["MAX_PER_SYMBOL_OPEN"], elevated: ["ELEVATED_PER_SYMBOL_OPEN"],
      },
      risk: { base: 1, mRegime: 0.5, mEdge: 1, mVol: 1, mLiquidity: 1, mBacklog: 0, mCorr: 1, riskMultiplier: 0 },
    }];
    const result = buildNeuralMapTelemetry(input);
    const occupancy = result.nodes.find((node) => node.id === "occupancy");
    expect(occupancy).toMatchObject({
      health: "WARNING",
      metric: "ALLOW / 1 WAIT",
      diagnosisCategory: "CAPACITY_PRESSURE",
    });
    expect(occupancy?.detail.join(" ")).toContain("XRPUSDT:MAX_PER_SYMBOL_OPEN");
  });

  it("classifies scan hangs as latency and degraded providers as degraded input", () => {
    const input = baseInput();
    input.scanTiming = {
      status: "SUCCESS",
      startedAt: "2026-06-06T11:59:40.000Z",
      finishedAt: "2026-06-06T12:00:00.000Z",
      totalScanMs: 20_000,
      activeStage: null,
      totals: {
        totalScanMs: 20_000,
        candleFetchMs: 12_000,
        externalSignalFetchMs: 3_500,
        kronosForecastMs: 800,
        candidateScoringMs: 200,
        regimeControllerMs: 100,
        allocatorAdmissionMs: null,
      },
      stageSummary: {
        slowestStage: { name: "coreMarketScan", durationMs: 20_000, severity: "HANG" },
        p95Stage: { name: "coreMarketScan", durationMs: 20_000, severity: "HANG" },
      },
      markers: [{ name: "coreMarketScan", elapsedMs: 20_000, severity: "HANG", thresholdMs: 10_000 }],
      degradedProviders: [{ provider: "kronos", reason: "timeout", skipCyclesRemaining: 2 }],
      symbols: [{ symbol: "BTCUSDT", status: "FAILED", totalSymbolFetchMs: 12_000, failureStage: "candleFetch", failureReason: "timeout" }] as never,
      backgroundQueue: {
        trackerPersist: "completed",
        shadowEngine: "completed",
        outcomeChecker: "completed",
        lastCompletedAt: null,
        lastError: null,
        maxLagSec: 0,
      },
      scanBatchId: "batch-1",
      failureReason: null,
    } as never;
    const result = buildNeuralMapTelemetry(input);
    expect(result.nodes.find((node) => node.id === "scan")).toMatchObject({
      diagnosisCategory: "LATENCY",
    });
    expect(result.nodes.find((node) => node.id === "kronos")).toMatchObject({
      diagnosisCategory: "DEGRADED_INPUT",
    });
  });

  it("prefers the current batch lane when diagnostic paper flow is active", () => {
    const input = baseInput();
    input.controller.currentRegime = "Bullish expansion";
    input.controller.controllerMode = "LONG_ONLY";
    input.paper.activeLane = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
    input.paper.currentBatchActiveLane = "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
    input.paper.currentBatchOrderMode = "DIAGNOSTIC_ONLY";
    input.paper.currentBatchCreatedCount = 9;
    input.orders = [{
      id: "paper-long-1",
      observationId: "obs-long-1",
      sourceObservationKey: "BTCUSDT|LONG|2026-06-06T11:00:00.000Z",
      sourceType: "ALLOCATOR_LANE",
      selectedLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      symbol: "BTCUSDT",
      direction: "LONG",
      regime: "Bullish expansion",
      entryPrice: 100,
      stopLoss: 97,
      takeProfitLevels: [103],
      paperStatus: "CREATED",
      plannedStopDistanceBps: 300,
      openedAt: "2026-06-06T11:00:00.000Z",
      updatedAt: "2026-06-06T12:00:00.000Z",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      paperRiskLabel: "EXPERIMENTAL",
      reportOnly: true,
      paperOnly: true,
    } as never];
    const result = buildNeuralMapTelemetry(input);
    expect(result.nodes.find((node) => node.id === "lane-router")?.detail.join(" ")).toContain("CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    expect(result.nodes.find((node) => node.id === "paper")?.detail.join(" ")).toContain("DIAGNOSTIC_ONLY CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    expect(result.lanes.find((lane) => lane.id === "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE")?.active).toBe(true);
  });

  it("classifies a diagnostic-only loss as DIAGNOSTIC (neutral) — no critical/warning alert", () => {
    const input = baseInput();
    input.orders = [{
      id: "trail-loss",
      observationId: "obs-trail-loss",
      sourceObservationKey: "BTCUSDT|SHORT|2026-06-06T11:00:00.000Z",
      sourceType: "ALLOCATOR_LANE",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1",
      symbol: "BTCUSDT",
      direction: "SHORT",
      regime: "Bearish pressure",
      entryPrice: 100,
      stopLoss: 103,
      takeProfitLevels: [97],
      paperStatus: "PAPER_CLOSED_LOSS",
      plannedStopDistanceBps: 300,
      openedAt: "2026-06-06T11:00:00.000Z",
      updatedAt: "2026-06-06T12:00:00.000Z",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      paperRiskLabel: "EXPERIMENTAL",
      netPnlAmount: -200,
      grossR: -1,
      costR: -0.07,
      netR: -1.07,
      closeReason: "SL_HIT",
      reportOnly: true,
      paperOnly: true,
    } as never];
    input.variantMatrix.rows.push({
      ...input.variantMatrix.rows[0]!,
      variantId: "CG_TRAIL_AFTER_TP1",
      status: "WATCHABLE",
      statusReason: "watchable",
      netAvgR: 0.1,
      pf: 2.3,
    });
    const result = buildNeuralMapTelemetry(input);
    // A diagnostic-only loss is NEUTRAL: the lane is classified DIAGNOSTIC (own color in the
    // map) and raises NO alert — it is reject-sampler measurement, not a real failure/warning.
    expect(result.alerts.some((alert) => alert.source === "CG_TRAIL SHORT")).toBe(false);
    const trailLane = result.lanes.find((lane) => lane.label === "CG_TRAIL SHORT");
    expect(trailLane?.health).toBe("DIAGNOSTIC");
    expect(trailLane?.pnlIsDiagnosticOnly).toBe(true);
  });
});

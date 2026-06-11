import { describe, expect, it } from "vitest";

import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import type { FilteredEdgeShadowReport } from "../src/lib/regime-controller-filtered-edge-shadow.js";
import type { RegimeControllerAlignedShadowReport } from "../src/lib/regime-controller-aligned-shadow.js";
import type { BaseRouteCurrentGuardLaneSummary } from "../src/lib/base-route-risk-hygiene-monitor.js";
import type { FrozenCurrentGuardReport } from "../src/lib/base-route-current-guard-frozen.js";
import type { FrozenCurrentGuardCostModelReport } from "../src/lib/frozen-current-guard-cost-model.js";

function makeCostModel(
  override: Partial<FrozenCurrentGuardCostModelReport> = {},
): FrozenCurrentGuardCostModelReport {
  return {
    reportOnly: true,
    computedAt: "2026-05-28T00:00:00.000Z",
    inputsAvailable: { spread: true, funding: true, depth: true },
    assumedAvgStopBps: 200,
    scenarios: [
      {
        scenario: "spread_p90",
        description: "Realistic taker + 2x observed p90 spread",
        roundTripBps: 18.6,
        netAvgR: 0.09,
        pf: 2.8,
        wr: 0.78,
        pass: true,
        stillPositive: true,
      },
    ],
    worstPassingScenario: "spread_p90",
    firstFailingScenario: null,
    modelPopulated: true,
    summary: "populated",
    ...override,
  };
}

function makeFrozenReport(
  override: Partial<FrozenCurrentGuardReport> = {},
): FrozenCurrentGuardReport {
  return {
    reportOnly: true,
    laneVersion: "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1",
    computedAt: "2026-05-28T00:00:00.000Z",
    criteriaFrozenAt: "2026-05-28T00:00:00.000Z",
    total: 0,
    open: 0,
    resolved: 0,
    freshValid: 0,
    netAvgR: null,
    pf: null,
    wr: null,
    daysCovered: 0,
    oosSegments: null,
    allThreeSegmentsPositive: false,
    costSensitivity: [],
    topSymbolPnlShare: 0,
    status: "COLLECTING",
    statusReason: "resolved=0",
    ...override,
  };
}

function makeControllerAligned(
  override: Partial<RegimeControllerAlignedShadowReport> = {},
): RegimeControllerAlignedShadowReport {
  return {
    resolvedObservations: 46,
    overallNetAvgR: -0.11,
    overallPF: 0.40,
    overallWR: 0.45,
    ...override,
  } as RegimeControllerAlignedShadowReport;
}

function makeBaseRouteLane(
  override: Partial<BaseRouteCurrentGuardLaneSummary> = {},
): BaseRouteCurrentGuardLaneSummary {
  return {
    reportOnly: true,
    laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD",
    source: "F*. Base Route Risk Hygiene Monitor",
    closed: 62,
    open: 3,
    wins: 30,
    losses: 32,
    grossAvgR: 0.2022,
    netAvgR: 0.085,
    avgCostR: 0.1211,
    pf: 1.30,
    wr: 0.48,
    avgWinGrossR: 0.5,
    avgLossGrossR: -0.3,
    byRegime: [],
    symbolConcentration: [{ symbol: "BTCUSDT", n: 20, netAvgR: 0.1, share: 0.30 }],
    byRoute: [],
    recencySplit: { earlyHalf: null, lateHalf: null, stable: null },
    status: "WATCHABLE",
    statusReason: "closed=62, netAvgR=0.0850",
    cautions: [
      "This is not live approval. It is a candidate requiring deeper stability checks.",
      "Insufficient sample for promotion (closed=62, need ≥200)",
    ],
    ...override,
  };
}

function buildFilteredEdgeReport(
  override: Partial<FilteredEdgeShadowReport> = {},
): FilteredEdgeShadowReport {
  return {
    reportOnly: true,
    laneVersion: "REGIME_CONTROLLER_ALIGNED_FILTERED_EDGE_SHADOW_V1",
    computedAt: "2026-05-27T00:00:00.000Z",
    profileReports: [],
    freshValidProfileReports: [
      {
        profile: "STRICT_COST10",
        resolvedObs: 1,
        wr: null,
        netAvgR: -0.245,
        grossAvgR: null,
        avgCostR: null,
        pf: null,
        verdict: "TOO_EARLY",
      },
    ],
    freshValidExcluded: {
      invalidChronology: 0,
      invalidPathMetrics: 0,
      missingPathMetrics: 0,
      ambiguousIntrabar: 0,
      invalidGeometry: 0,
      missingVersion: 0,
      quarantined: 0,
    },
    topRejectionReasons: [],
    recentResolved: [],
    profileForensics: [],
    overlappingCandidateCount: 0,
    ambiguousSameCandleCount: 0,
    resolvedBy1mCount: 0,
    ambiguousExcludedFromFreshValidCount: 0,
    freshValidResolvedCount: 1,
    freshValidConsistencyCheck: "PASS",
    pathMetricConsistencyCheck: {
      status: "PASS",
      freshValidWithNonValidPath: 0,
      outlierWithoutLargeMfeMae: 0,
      missingRenderedAsOutlier: 0,
    },
    chronologyConsistencyCheck: {
      status: "PASS",
      freshValidWithInvalidChronology: 0,
      negativeDurationCount: 0,
      durationZeroWithValid5mOrdered: 0,
    },
    ...override,
  };
}

describe("buildLiveTradingGateReport", () => {
  it("liveBlocked=true with current inputs (empty/low evidence)", () => {
    const r = buildLiveTradingGateReport({
      filteredEdgeReport: buildFilteredEdgeReport(),
    });
    expect(r.liveBlocked).toBe(true);
    expect(r.microPilotAllowed).toBe(false);
    expect(r.summary).toContain("BLOCKED");
  });

  it("blockers list contains 9 entries", () => {
    const r = buildLiveTradingGateReport({});
    expect(r.blockers).toHaveLength(9);
  });

  it("EVIDENCE_VOLUME gate PASSes with 200+ freshValid", () => {
    const r = buildLiveTradingGateReport({
      filteredEdgeReport: buildFilteredEdgeReport({
        freshValidProfileReports: [
          {
            profile: "STRICT_COST10",
            resolvedObs: 250,
            wr: 0.55,
            netAvgR: 0.05,
            grossAvgR: 0.1,
            avgCostR: 0.05,
            pf: 1.5,
            verdict: "POSITIVE_EDGE",
          },
        ],
      }),
    });
    const ev = r.blockers.find((b) => b.gate === "EVIDENCE_VOLUME");
    expect(ev?.status).toBe("PASS");
    const pf = r.blockers.find((b) => b.gate === "PF_THRESHOLD");
    expect(pf?.status).toBe("PASS");
  });

  it("microPilotAllowed=false unless ALL gates pass", () => {
    const r = buildLiveTradingGateReport({
      filteredEdgeReport: buildFilteredEdgeReport({
        freshValidProfileReports: [
          {
            profile: "STRICT_COST10",
            resolvedObs: 250,
            wr: 0.55,
            netAvgR: 0.05,
            grossAvgR: 0.1,
            avgCostR: 0.05,
            pf: 1.5,
            verdict: "POSITIVE_EDGE",
          },
        ],
      }),
    });
    // Kill switch / order recon / exchange health / funding still FAIL → micro-pilot blocked
    expect(r.microPilotAllowed).toBe(false);
    expect(r.liveBlocked).toBe(true);
  });

  describe("base route current-guard lane in candidate ranking", () => {
    it("positive-net base route beats negative-net controller-aligned regardless of sample size", () => {
      const r = buildLiveTradingGateReport({
        controllerAlignedReport: makeControllerAligned({
          resolvedObservations: 46,
          overallNetAvgR: -0.11,
          overallPF: 0.40,
        }),
        baseRouteCurrentGuardLane: makeBaseRouteLane({ netAvgR: 0.085, closed: 62 }),
      });
      expect(r.nearestCandidateLane?.lane).toBe("BASE_ROUTE_STOP175_CURRENT_GUARD");
      expect(r.nearestCandidateLane?.netAvgR).toBeCloseTo(0.085, 5);
    });

    it("EVIDENCE_VOLUME gate uses max closed count including base route lane", () => {
      const r = buildLiveTradingGateReport({
        filteredEdgeReport: buildFilteredEdgeReport(),
        baseRouteCurrentGuardLane: makeBaseRouteLane({ closed: 62 }),
      });
      const ev = r.blockers.find((b) => b.gate === "EVIDENCE_VOLUME");
      expect(ev?.current).toContain("62");
    });

    it("liveBlocked stays true even with positive base-route lane (infra gates still FAIL)", () => {
      const r = buildLiveTradingGateReport({
        baseRouteCurrentGuardLane: makeBaseRouteLane({
          netAvgR: 0.085,
          closed: 62,
          pf: 1.30,
        }),
      });
      expect(r.liveBlocked).toBe(true);
      expect(r.microPilotAllowed).toBe(false);
    });

    it("nearestCandidateLane includes cautions array from the base route lane", () => {
      const r = buildLiveTradingGateReport({
        baseRouteCurrentGuardLane: makeBaseRouteLane(),
      });
      expect(r.nearestCandidateLane?.cautions).toBeDefined();
      expect((r.nearestCandidateLane?.cautions ?? []).some((c) => c.includes("not live approval"))).toBe(true);
    });
  });

  it("nearestCandidateLane identifies highest-freshValid lane", () => {
    const r = buildLiveTradingGateReport({
      filteredEdgeReport: buildFilteredEdgeReport({
        freshValidProfileReports: [
          {
            profile: "STRICT_COST10",
            resolvedObs: 5,
            wr: null,
            netAvgR: -0.1,
            grossAvgR: null,
            avgCostR: null,
            pf: null,
            verdict: "TOO_EARLY",
          },
          {
            profile: "BROAD_COST20_STOP150",
            resolvedObs: 12,
            wr: 0.5,
            netAvgR: -0.05,
            grossAvgR: null,
            avgCostR: null,
            pf: 0.9,
            verdict: "TOO_EARLY",
          },
        ],
      }),
    });
    expect(r.nearestCandidateLane?.freshValidResolved).toBe(12);
    expect(r.nearestCandidateLane?.lane).toContain("BROAD");
  });

  it("test 19: with frozen tape resolved≥20 positive, nearest candidate uses frozen (labeled prospective)", () => {
    const r = buildLiveTradingGateReport({
      baseRouteCurrentGuardLane: makeBaseRouteLane({ closed: 67, netAvgR: 0.12, pf: 3.26 }),
      frozenCurrentGuardReport: makeFrozenReport({
        total: 25,
        resolved: 25,
        freshValid: 25,
        netAvgR: 0.06,
        pf: 1.3,
        wr: 0.55,
        daysCovered: 5,
        topSymbolPnlShare: 0.3,
        status: "WATCHABLE",
        statusReason: "resolved=25",
      }),
    });
    expect(r.nearestCandidateLane?.lane).toBe("BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1");
    expect(r.nearestCandidateLane?.provenance).toBe("prospective");
    expect(r.liveBlocked).toBe(true);
  });

  it("test 20: with frozen tape resolved<20, falls back to historical (labeled in-sample)", () => {
    const r = buildLiveTradingGateReport({
      baseRouteCurrentGuardLane: makeBaseRouteLane({ closed: 67, netAvgR: 0.12, pf: 3.26 }),
      frozenCurrentGuardReport: makeFrozenReport({
        total: 8,
        resolved: 8,
        freshValid: 8,
        netAvgR: 0.05,
        pf: 1.2,
        wr: 0.5,
        daysCovered: 2,
        topSymbolPnlShare: 0.3,
        status: "COLLECTING",
        statusReason: "resolved=8 (<50)",
      }),
    });
    expect(r.nearestCandidateLane?.lane).toBe("BASE_ROUTE_STOP175_CURRENT_GUARD");
    expect(r.nearestCandidateLane?.provenance).toBe("historical-in-sample");
    expect(r.liveBlocked).toBe(true);
  });

  it("test 11 (cost model): FUNDING_SLIPPAGE_MODELED PASSes when cost model is populated", () => {
    const r = buildLiveTradingGateReport({
      frozenCostModelReport: makeCostModel({ modelPopulated: true, worstPassingScenario: "spread_p90" }),
    });
    const fsm = r.blockers.find((b) => b.gate === "FUNDING_SLIPPAGE_MODELED");
    expect(fsm?.status).toBe("PASS");
    expect(fsm?.detail).toContain("AC microstructure");
    expect(fsm?.detail).toContain("spread_p90");
  });

  it("test 12 (cost model): FUNDING_SLIPPAGE_MODELED FAILs when not populated or absent", () => {
    const rAbsent = buildLiveTradingGateReport({});
    expect(rAbsent.blockers.find((b) => b.gate === "FUNDING_SLIPPAGE_MODELED")?.status).toBe("FAIL");

    const rUnpopulated = buildLiveTradingGateReport({
      frozenCostModelReport: makeCostModel({ modelPopulated: false }),
    });
    expect(
      rUnpopulated.blockers.find((b) => b.gate === "FUNDING_SLIPPAGE_MODELED")?.status,
    ).toBe("FAIL");
  });

  it("test 13 (cost model): liveBlocked STAYS true even when FUNDING_SLIPPAGE_MODELED passes", () => {
    const r = buildLiveTradingGateReport({
      frozenCostModelReport: makeCostModel({ modelPopulated: true }),
      // even with a strong frozen tape that satisfies evidence/PF gates
      frozenCurrentGuardReport: makeFrozenReport({
        total: 500,
        resolved: 500,
        freshValid: 500,
        netAvgR: 0.5,
        pf: 5.0,
        wr: 0.9,
        daysCovered: 60,
        allThreeSegmentsPositive: true,
        topSymbolPnlShare: 0.1,
        status: "PROMOTION_CANDIDATE",
        statusReason: "resolved=500",
      }),
    });
    expect(r.blockers.find((b) => b.gate === "FUNDING_SLIPPAGE_MODELED")?.status).toBe("PASS");
    // infra gates still FAIL → liveBlocked must remain true
    expect(r.liveBlocked).toBe(true);
    expect(r.blockers.find((b) => b.gate === "KILL_SWITCH_EXISTS")?.status).toBe("FAIL");
    expect(r.blockers.find((b) => b.gate === "ORDER_RECONCILIATION_EXISTS")?.status).toBe("FAIL");
    expect(r.blockers.find((b) => b.gate === "EXCHANGE_HEALTH_CHECKS_EXIST")?.status).toBe("FAIL");
  });

  it("test 14 (cost model): microPilotAllowed stays false when cost model passes but infra FAILs", () => {
    const r = buildLiveTradingGateReport({
      frozenCostModelReport: makeCostModel({ modelPopulated: true }),
    });
    expect(r.microPilotAllowed).toBe(false);
  });

  it("test 21: liveBlocked STAYS true regardless of frozen tape strength", () => {
    const r = buildLiveTradingGateReport({
      frozenCurrentGuardReport: makeFrozenReport({
        total: 500,
        resolved: 500,
        freshValid: 500,
        netAvgR: 0.5,
        pf: 5.0,
        wr: 0.9,
        daysCovered: 60,
        allThreeSegmentsPositive: true,
        topSymbolPnlShare: 0.1,
        status: "PROMOTION_CANDIDATE",
        statusReason: "resolved=500",
      }),
    });
    expect(r.liveBlocked).toBe(true);
    expect(r.microPilotAllowed).toBe(false);
  });
});

describe("buildLiveTradingGateReport — AE/AF/AG infra readiness integration", () => {
  it("KILL_SWITCH_EXISTS FAILs when killSwitchReadiness.ready=false", () => {
    const r = buildLiveTradingGateReport({
      killSwitchReadiness: {
        reportOnly: true,
        module: "MICRO_PILOT_KILL_SWITCH_READINESS",
        computedAt: "2026-05-28T00:00:00.000Z",
        implemented: false,
        ready: false,
        controls: [],
        missingControls: ["daily_max_loss_limit"],
        summary: "not implemented",
      },
    });
    const gate = r.blockers.find((b) => b.gate === "KILL_SWITCH_EXISTS");
    expect(gate?.status).toBe("FAIL");
    expect(r.killSwitchReady).toBe(false);
  });

  it("EXCHANGE_HEALTH_CHECKS_EXIST FAILs when not ready", () => {
    const r = buildLiveTradingGateReport({
      exchangeHealthReadiness: {
        reportOnly: true,
        module: "EXCHANGE_HEALTH_READINESS",
        computedAt: "2026-05-28T00:00:00.000Z",
        implemented: false,
        ready: false,
        checks: [],
        availableCount: 4,
        missingChecks: ["rest_latency"],
        summary: "partial",
      },
    });
    const gate = r.blockers.find((b) => b.gate === "EXCHANGE_HEALTH_CHECKS_EXIST");
    expect(gate?.status).toBe("FAIL");
    expect(r.exchangeHealthReady).toBe(false);
  });

  it("liveBlocked STAYS true with all readiness modules ready=false", () => {
    const r = buildLiveTradingGateReport({
      killSwitchReadiness: {
        reportOnly: true,
        module: "MICRO_PILOT_KILL_SWITCH_READINESS",
        computedAt: "x",
        implemented: false,
        ready: false,
        controls: [],
        missingControls: [],
        summary: "x",
      },
      orderReconciliationReadiness: {
        reportOnly: true,
        module: "ORDER_RECONCILIATION_READINESS",
        computedAt: "x",
        implemented: false,
        ready: false,
        lifecycleStages: [],
        requiredLedgerFields: [],
        requiredExchangeChecks: [],
        risksIfMissing: [],
        summary: "x",
      },
      exchangeHealthReadiness: {
        reportOnly: true,
        module: "EXCHANGE_HEALTH_READINESS",
        computedAt: "x",
        implemented: false,
        ready: false,
        checks: [],
        availableCount: 0,
        missingChecks: [],
        summary: "x",
      },
    });
    expect(r.liveBlocked).toBe(true);
    expect(r.orderReconciliationReady).toBe(false);
  });

  it("microPilotAllowed stays false even with PROMOTION_CANDIDATE frozen tracker when infra not ready", () => {
    const r = buildLiveTradingGateReport({
      frozenPromotionTracker: {
        reportOnly: true,
        laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1",
        computedAt: "x",
        freshValid: 220,
        resolvedPerDay: 10,
        freshValidPerDay: 10,
        etaToN100Days: 0,
        etaToN100Date: null,
        etaToN200Days: 0,
        etaToN200Date: null,
        rolling: [],
        oosSegmentsAllPositive: true,
        weakestSegment: null,
        positiveSegmentCount: 3,
        approxMaxDrawdownR: 1,
        maxAdverseStreak: 2,
        plus10bpsStillPositive: true,
        topSymbolPnlShare: 0.2,
        status: "PROMOTION_CANDIDATE",
        statusReason: "x",
        promotionBlockers: [],
        killWarning: null,
        cautions: [],
      },
    });
    expect(r.frozenCandidateStatus).toBe("PROMOTION_CANDIDATE");
    expect(r.microPilotAllowed).toBe(false);
    expect(r.liveBlocked).toBe(true);
  });
});

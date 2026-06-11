import { describe, expect, it } from "vitest";

import {
  buildShadowLaneScoreboard,
  type ShadowLaneScoreboardInputs,
} from "../src/lib/shadow-lane-scoreboard.js";
import type { FilteredEdgeShadowReport } from "../src/lib/regime-controller-filtered-edge-shadow.js";
import type { PortfolioTrendShadowReport } from "../src/lib/portfolio-trend-shadow.js";
import type { BaseRouteCurrentGuardLaneSummary } from "../src/lib/base-route-risk-hygiene-monitor.js";

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
    netAvgR: 0.0850,
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
        resolvedObs: 22,
        wr: 0.55,
        netAvgR: 0.12,
        grossAvgR: 0.2,
        avgCostR: 0.08,
        pf: 1.25,
        verdict: "WATCHABLE_EDGE",
      },
      {
        profile: "BROAD_COST20_STOP150",
        resolvedObs: 13,
        wr: 0.5,
        netAvgR: -0.05,
        grossAvgR: 0.1,
        avgCostR: 0.15,
        pf: 0.85,
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
    freshValidResolvedCount: 22,
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

function buildPortfolioTrendReport(
  override: Partial<PortfolioTrendShadowReport> = {},
): PortfolioTrendShadowReport {
  return {
    reportOnly: true,
    laneVersion: "PORTFOLIO_TREND_SHADOW_V1",
    computedAt: "2026-05-27T00:00:00.000Z",
    totalObs: 0,
    openObs: 0,
    resolvedObs: 0,
    freshValidResolved: 0,
    freshValidNetAvgR: null,
    freshValidPF: null,
    freshValidWR: null,
    avgHoldingHours: null,
    admissionVelocityPerDay: null,
    resolvedVelocityPerDay: null,
    freshValidVelocityPerDay: null,
    turnoverPerDay: null,
    symbolConcentration: [],
    byRegime: [],
    costSensitivity: { atDefault: null, at10bpsRoundtrip: null, at50bpsRoundtrip: null },
    status: "COLLECTING",
    statusReason: "freshValid<20",
    ...override,
  };
}

describe("shadow-lane-scoreboard", () => {
  it("aggregates multiple lane reports", () => {
    const inputs: ShadowLaneScoreboardInputs = {
      filteredEdgeReport: buildFilteredEdgeReport(),
      portfolioTrendReport: buildPortfolioTrendReport({
        freshValidResolved: 10,
        freshValidNetAvgR: 0.02,
        freshValidPF: 1.05,
        freshValidWR: 0.5,
        admissionVelocityPerDay: 5,
        resolvedVelocityPerDay: 0,
        freshValidVelocityPerDay: 0,
      }),
    };
    const sb = buildShadowLaneScoreboard(inputs);
    expect(sb.allEntries.length).toBe(3);
    const laneIds = sb.allEntries.map((e) => e.laneId);
    expect(laneIds).toContain("FILTERED_EDGE:STRICT_COST10");
    expect(laneIds).toContain("PORTFOLIO_TREND_SHADOW_V1");
  });

  it("top-5 sorting works correctly by netAvgR", () => {
    const sb = buildShadowLaneScoreboard({
      filteredEdgeReport: buildFilteredEdgeReport(),
    });
    expect(sb.top5ByFreshValidNet[0]!.laneId).toBe("FILTERED_EDGE:STRICT_COST10");
    expect(sb.top5ByFreshValidNet[1]!.laneId).toBe("FILTERED_EDGE:BROAD_COST20_STOP150");
  });

  it("status: COLLECTING for n<20, WATCHABLE for n>=20+positive, KILLED list present", () => {
    const sb = buildShadowLaneScoreboard({
      portfolioTrendReport: buildPortfolioTrendReport({
        freshValidResolved: 10,
        freshValidNetAvgR: 0.1,
        freshValidPF: 1.5,
      }),
    });
    expect(sb.allEntries[0]!.status).toBe("COLLECTING");

    const sb2 = buildShadowLaneScoreboard({
      portfolioTrendReport: buildPortfolioTrendReport({
        freshValidResolved: 25,
        freshValidNetAvgR: 0.1,
        freshValidPF: 1.5,
      }),
    });
    expect(sb2.allEntries[0]!.status).toBe("WATCHABLE");

    expect(sb.killedLanes.length).toBeGreaterThan(0);
    expect(sb.killedLanes.every((k) => k.status === "KILLED")).toBe(true);
  });

  it("ETA computation null when velocity is 0 or null", () => {
    const sb = buildShadowLaneScoreboard({
      filteredEdgeReport: buildFilteredEdgeReport(),
    });
    for (const entry of sb.allEntries) {
      if (entry.freshValidVelocityPerDay === null && entry.freshValidResolved < 20) {
        expect(entry.etaToN20Days).toBeNull();
      }
    }
  });

  it("nearN20 captures lanes with 15..19 freshValid", () => {
    const sb = buildShadowLaneScoreboard({
      portfolioTrendReport: buildPortfolioTrendReport({
        freshValidResolved: 18,
        freshValidNetAvgR: 0.05,
        freshValidPF: 1.05,
      }),
    });
    expect(sb.nearN20.length).toBe(1);
    expect(sb.nearN20[0]!.freshValidResolved).toBe(18);
  });

  describe("base route current-guard candidate lane", () => {
    it("appears in top5ByFreshValidNet when positive", () => {
      const sb = buildShadowLaneScoreboard({
        baseRouteCurrentGuardLane: makeBaseRouteLane({ netAvgR: 0.085 }),
      });
      const laneIds = sb.top5ByFreshValidNet.map((e) => e.laneId);
      expect(laneIds).toContain("BASE_ROUTE_STOP175_CURRENT_GUARD");
    });

    it("appears in top5ByPF when positive PF", () => {
      const sb = buildShadowLaneScoreboard({
        baseRouteCurrentGuardLane: makeBaseRouteLane({ pf: 1.30 }),
      });
      const laneIds = sb.top5ByPF.map((e) => e.laneId);
      expect(laneIds).toContain("BASE_ROUTE_STOP175_CURRENT_GUARD");
    });

    it("appears in killedLanes when status=REJECT", () => {
      const sb = buildShadowLaneScoreboard({
        baseRouteCurrentGuardLane: makeBaseRouteLane({
          status: "REJECT",
          statusReason: "netAvgR=-0.05 (≤0)",
          netAvgR: -0.05,
        }),
      });
      const killed = sb.killedLanes.find((k) => k.laneId === "BASE_ROUTE_STOP175_CURRENT_GUARD");
      expect(killed).toBeDefined();
      expect(killed?.status).toBe("KILLED");
      expect(killed?.killedReason).toContain("netAvgR");
    });

    it("appears in promotionCandidates when status=PROMOTION_CANDIDATE", () => {
      const sb = buildShadowLaneScoreboard({
        baseRouteCurrentGuardLane: makeBaseRouteLane({
          status: "PROMOTION_CANDIDATE",
          closed: 220,
          netAvgR: 0.10,
          pf: 1.40,
        }),
      });
      const ids = sb.promotionCandidates.map((e) => e.laneId);
      expect(ids).toContain("BASE_ROUTE_STOP175_CURRENT_GUARD");
    });

    it("populates candidateLanesFromBaseRoute slot", () => {
      const sb = buildShadowLaneScoreboard({
        baseRouteCurrentGuardLane: makeBaseRouteLane(),
      });
      expect(sb.candidateLanesFromBaseRoute.length).toBe(1);
      expect(sb.candidateLanesFromBaseRoute[0]!.laneId).toBe("BASE_ROUTE_STOP175_CURRENT_GUARD");
      expect(sb.candidateLanesFromBaseRoute[0]!.cautions?.length).toBeGreaterThan(0);
    });
  });

  it("tracks admission, resolved, and fresh-valid velocities separately", () => {
    const sb = buildShadowLaneScoreboard({
      portfolioTrendReport: buildPortfolioTrendReport({
        totalObs: 5,
        openObs: 5,
        resolvedObs: 0,
        freshValidResolved: 0,
        admissionVelocityPerDay: 5,
        resolvedVelocityPerDay: 0,
        freshValidVelocityPerDay: 0,
      }),
    });
    expect(sb.fastestCollecting[0]?.laneId).toBe("PORTFOLIO_TREND_SHADOW_V1");
    expect(sb.fastestCollecting[0]?.admissionVelocityPerDay).toBe(5);
    expect(sb.fastestCollecting[0]?.resolvedVelocityPerDay).toBe(0);
    expect(sb.fastestCollecting[0]?.freshValidVelocityPerDay).toBe(0);
  });

  it("test 18: shows both historical current-guard and frozen prospective entries separately", () => {
    const sb = buildShadowLaneScoreboard({
      baseRouteCurrentGuardLane: makeBaseRouteLane({ closed: 67, netAvgR: 0.12, pf: 3.26 }),
      frozenCurrentGuardReport: {
        reportOnly: true,
        laneVersion: "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1",
        computedAt: "2026-05-28T00:00:00.000Z",
        criteriaFrozenAt: "2026-05-28T00:00:00.000Z",
        total: 12,
        open: 0,
        resolved: 12,
        freshValid: 12,
        netAvgR: 0.08,
        pf: 1.4,
        wr: 0.6,
        daysCovered: 3,
        oosSegments: null,
        allThreeSegmentsPositive: false,
        costSensitivity: [],
        topSymbolPnlShare: 0.3,
        status: "COLLECTING",
        statusReason: "resolved=12 (<50)",
      },
    });
    const laneIds = sb.candidateLanesFromBaseRoute.map((e) => e.laneId);
    expect(laneIds).toContain("BASE_ROUTE_STOP175_CURRENT_GUARD");
    expect(laneIds).toContain("BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1");
    expect(sb.candidateLanesFromBaseRoute.length).toBe(2);
    const frozen = sb.candidateLanesFromBaseRoute.find(
      (e) => e.laneId === "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1",
    )!;
    expect(frozen.freshValidResolved).toBe(12);
    expect(frozen.profileLabel).toContain("prospective");
  });
});

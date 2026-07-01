import { describe, expect, it } from "vitest";
import type { Candle } from "@dtc/shared";
import { buildHistoricalValidationReport } from "../src/trading/index.js";

const HOUR = 60 * 60_000;

function candles(count: number, start: number, stepMs: number, startPrice: number, drift: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = startPrice + i * drift;
    const close = open + drift * 0.5;
    return {
      openTime: start + i * stepMs,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: 1000 + i,
    };
  });
}

describe("buildHistoricalValidationReport", () => {
  it("runs the baseline validation pipeline and reports coverage/provenance/decisions/performance/rejection", () => {
    const start = Date.UTC(2026, 0, 1);
    const h1 = candles(80, start, HOUR, 61_000, -40);
    const report = buildHistoricalValidationReport({
      symbol: "BTCUSDT",
      candles: {
        m15: candles(80 * 4, start, 15 * 60_000, 61_000, -10),
        h1,
        h4: candles(40, start, 4 * HOUR, 61_000, -160),
        d1: candles(12, start, 24 * HOUR, 61_000, -500),
      },
      startMs: h1[0]!.openTime + HOUR,
      endMs: h1.at(-1)!.openTime + HOUR,
      breadth: {
        advancersPct: 0.3,
        altAdvancersPct: 0.35,
        universeKind: "CURRENT_LIQUID_UNIVERSE",
      },
      microstructure: {
        spreadBps: 2,
        slippageBps: 2,
        assumeFundingBaseline: true,
      },
    });

    expect(report.validationOnly).toBe(true);
    expect(report.dataCoverage.symbol).toBe("BTCUSDT");
    expect(report.dataCoverage.timeframeCoverage.map((c) => c.timeframe)).toEqual(["15m", "1h", "4h", "1d"]);
    expect(report.dataCoverage.candleCount).toBeGreaterThan(0);
    expect(report.featureProvenance.fundingSource).toBe("ASSUMED_BASELINE");
    expect(report.featureProvenance.liquiditySource).toBe("HEURISTIC_SPREAD_VOLUME");
    expect(report.featureProvenance.breadthSource).toBe("SUPPLIED");
    expect(report.featureProvenance.breadthSurvivorshipBiasNote).toMatch(/current liquid scan universe/i);
    expect(report.featureProvenance.featureSourcesSummary.fundingRiskAbnormal?.ASSUMED_BASELINE).toBeGreaterThan(0);
    expect(report.breadthDiagnostics.universeKind).toBe("CURRENT_LIQUID_UNIVERSE");
    expect(report.decisionDistribution.totalDecisions).toBeGreaterThan(0);
    expect(report.decisionDistribution.enterSignalCount).toBeGreaterThanOrEqual(report.decisionDistribution.closedTradeCount);
    expect(report.decisionDistribution.actionableEnterSignalCount).toBeGreaterThanOrEqual(report.decisionDistribution.closedTradeCount);
    expect(report.decisionDistribution.statefulGovernanceSuppressedSignalCount).toBeGreaterThanOrEqual(0);
    expect(report.decisionDistribution.skippedBecauseCooldown).toBeGreaterThanOrEqual(0);
    expect(report.decisionDistribution.skippedBecausePositionOpen).toBeGreaterThanOrEqual(0);
    expect(report.decisionDistribution.positionManagementDecisionCount).toBeGreaterThanOrEqual(0);
    expect(report.decisionDistribution.coverageDays).toBeGreaterThan(0);
    expect(report.decisionDistribution.tradesPerDay).toBeGreaterThanOrEqual(0);
    expect(report.decisionDistribution.bearishChoppyTradesPerDay).toBeGreaterThanOrEqual(0);
    expect(report.decisionDistribution.noTradeRatio).toBeGreaterThanOrEqual(0);
    expect(report.noTradeDiagnostics.noTradeRatio).toBe(report.decisionDistribution.noTradeRatio);
    expect(report.noTradeDiagnostics.rejectedByCounts).toBeDefined();
    expect(report.noTradeDiagnostics.missingFundingRiskAbnormalCount).toBe(0);
    expect(report.tradingPerformance.optimistic.feeImpact).toBeGreaterThanOrEqual(0);
    expect(report.tradingPerformance.base.spreadImpact).toBeGreaterThanOrEqual(0);
    expect(report.tradingPerformance.pessimistic.fundingAssumptionNote).toMatch(/assumed baseline/i);
    expect(report.pnlMathAudit.grossPnlFormula.short).toMatch(/entryPrice - exitPrice/);
    expect(report.pnlMathAudit.costModelReducesNetPnl).toBe(true);
    expect(report.pnlMathAudit.breakevenExitCounts).toEqual(expect.objectContaining({
      rawBreakevenStopCount: expect.any(Number),
      netBreakevenStopCount: expect.any(Number),
      grossBreakevenStopCount: expect.any(Number),
    }));
    expect(Array.isArray(report.tradeLedger)).toBe(true);
    for (const trade of report.tradeLedger) {
      expect(trade.symbol).toBe("BTCUSDT");
      expect(trade.featureSourcesUsedByEntryDecision).toBeDefined();
      expect(typeof trade.atrAtEntry).toBe("number");
      expect(["RAW_BREAKEVEN", "NET_BREAKEVEN", null]).toContain(trade.breakevenMode);
    }
    expect(report.laneOpportunityDiagnostics.SHORT_RALLY_FADE).toBeDefined();
    expect(report.laneOpportunityDiagnostics.BREAKDOWN_RETEST_SHORT?.blockingConditionCounts).toBeDefined();
    expect(report.regimeNoTradeDiagnostics.detectorBranchFailureCounts).toBeDefined();
    expect(report.regimeNoTradeDiagnostics.dayCountByRegime).toBeDefined();
    expect(report.regimeDenominatorDiagnostics.NO_TRADE?.decisionCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.tradeForensics)).toBe(true);
    for (const forensic of report.tradeForensics) {
      expect(forensic.previous3Candles.length).toBeLessThanOrEqual(3);
      expect(forensic.next3Candles.length).toBeLessThanOrEqual(3);
      expect(forensic.netPnlAfterCosts.afterFunding).toEqual(expect.any(Number));
    }
    expect(report.strategyRejection.byScenario.pessimistic.reasons).toBeDefined();
    expect(typeof report.strategyRejection.pessimisticProfitFactorAbove1_2).toBe("boolean");
    expect(typeof report.walkForward.singlePeriodDependence).toBe("boolean");
  });
});

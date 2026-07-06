import { describe, expect, it } from "vitest";

import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";
import type { PortfolioTrendShadowReport } from "../src/lib/portfolio-trend-shadow.js";
import type {
  BaseRouteCurrentGuardLaneSummary,
  BaseRouteRiskHygieneMonitor,
} from "../src/lib/base-route-risk-hygiene-monitor.js";
import { STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK } from "../src/lib/shadow-engine.js";
import { buildBaseRouteCurrentGuardStabilityReport } from "../src/lib/base-route-current-guard-stability-audit.js";
import type { FrozenCurrentGuardReport } from "../src/lib/base-route-current-guard-frozen.js";
import type { FrozenCurrentGuardCostModelReport } from "../src/lib/frozen-current-guard-cost-model.js";

function makeFrozenReport(
  override: Partial<FrozenCurrentGuardReport> = {},
): FrozenCurrentGuardReport {
  return {
    reportOnly: true,
    laneVersion: "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1",
    computedAt: "2026-05-28T00:00:00.000Z",
    criteriaFrozenAt: "2026-05-28T12:00:00.000Z",
    total: 50,
    open: 0,
    resolved: 50,
    freshValid: 50,
    netAvgR: 0.1089,
    pf: 3.1,
    wr: 0.8,
    daysCovered: 4,
    oosSegments: [
      { label: "segment_1", n: 16, netAvgR: -0.3185, grossAvgR: -0.1, pf: 0.6, wr: 0.4 },
      { label: "segment_2", n: 16, netAvgR: 0.1194, grossAvgR: 0.2, pf: 1.5, wr: 0.7 },
      { label: "segment_3", n: 18, netAvgR: 0.4795, grossAvgR: 0.6, pf: 4.0, wr: 0.9 },
    ],
    allThreeSegmentsPositive: false,
    costSensitivity: [
      { scenario: "default", roundTripBps: 0, netAvgR: 0.1089, pf: 3.1, stillPositive: true },
      { scenario: "plus_5bps_slippage", roundTripBps: 5, netAvgR: 0.084, pf: 2.8, stillPositive: true },
      { scenario: "plus_10bps_slippage", roundTripBps: 10, netAvgR: 0.059, pf: 2.5, stillPositive: true },
    ],
    topSymbolPnlShare: 0.3,
    velocity: {
      resolvedPerDay: 12.5,
      freshValidPerDay: 12.5,
      etaToN100Days: 4,
      etaToN200Days: 12,
      etaToN100Date: "2026-06-01",
      etaToN200Date: "2026-06-09",
    },
    oosWatch: {
      segment1: { label: "segment_1", n: 16, netAvgR: -0.3185, grossAvgR: -0.1, pf: 0.6, wr: 0.4 },
      segment2: { label: "segment_2", n: 16, netAvgR: 0.1194, grossAvgR: 0.2, pf: 1.5, wr: 0.7 },
      segment3: { label: "segment_3", n: 18, netAvgR: 0.4795, grossAvgR: 0.6, pf: 4.0, wr: 0.9 },
      weakestSegment: { label: "segment_1", netAvgR: -0.3185 },
      positiveSegmentCount: 2,
      allSegmentsPositive: false,
      requiredFuturePositiveSegments: 1,
      stabilityStatus: "STABILITY_BLOCKED",
      note: "segment_1 weakest (net=-0.32); STABILITY_BLOCKED until all 3 OOS segments positive.",
    },
    status: "WATCHABLE",
    statusReason: "resolved=50≥50, netAvgR=0.1089>0",
    ...override,
  };
}

function makeCostModel(
  override: Partial<FrozenCurrentGuardCostModelReport> = {},
): FrozenCurrentGuardCostModelReport {
  return {
    reportOnly: true,
    computedAt: "2026-05-28T00:00:00.000Z",
    inputsAvailable: { spread: true, funding: true, depth: true },
    assumedAvgStopBps: 200,
    scenarios: [
      { scenario: "conservative_flat", description: "flat 40bps", roundTripBps: 40, netAvgR: 0.06, pf: 2.0, wr: 0.75, pass: true, stillPositive: true },
      { scenario: "current_28bps", description: "flat 28bps", roundTripBps: 28, netAvgR: 0.08, pf: 2.4, wr: 0.78, pass: true, stillPositive: true },
      { scenario: "realistic_taker", description: "10bps", roundTripBps: 10, netAvgR: 0.12, pf: 3.0, wr: 0.8, pass: true, stillPositive: true },
      { scenario: "spread_p50", description: "12.2bps", roundTripBps: 12.2, netAvgR: 0.11, pf: 2.9, wr: 0.8, pass: true, stillPositive: true },
      { scenario: "spread_p90", description: "18.6bps", roundTripBps: 18.6, netAvgR: 0.1, pf: 2.8, wr: 0.79, pass: true, stillPositive: true },
      { scenario: "spread_p99", description: "28.8bps", roundTripBps: 28.8, netAvgR: 0.07, pf: 2.3, wr: 0.77, pass: true, stillPositive: true },
      { scenario: "plus_5bps_slippage", description: "p90+5", roundTripBps: 23.6, netAvgR: 0.09, pf: 2.6, wr: 0.78, pass: true, stillPositive: true },
      { scenario: "plus_10bps_slippage", description: "p90+10", roundTripBps: 28.6, netAvgR: 0.07, pf: 2.3, wr: 0.77, pass: true, stillPositive: true },
      { scenario: "funding_adverse", description: "p90+funding", roundTripBps: 19.6, netAvgR: 0.1, pf: 2.7, wr: 0.79, pass: true, stillPositive: true },
    ],
    worstPassingScenario: "conservative_flat",
    firstFailingScenario: null,
    modelPopulated: true,
    summary: "populated",
    ...override,
  };
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

function makeBaseRouteMonitor(
  laneOverride: Partial<BaseRouteCurrentGuardLaneSummary> = {},
): BaseRouteRiskHygieneMonitor {
  return {
    guardReasonCode: STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK,
    guardThresholdBps: 175,
    guardActivatedAtRetainedLog: "2026-05-21T13:33:54.662Z",
    skippedUltraTightCandidates: { total: 5, recent24h: 1 },
    postGuardTape: {
      closedN: 62,
      openN: 3,
      avgCostR: 0.1211,
      grossAvgR: 0.2022,
      netAvgR: 0.0850,
      grossToNetDrag: 0.1172,
      ultraTightClosedN: 0,
      below175ClosedN: 0,
      below100ClosedN: 0,
      anchorConsistentPositionCount: 65,
      mixedOrLegacyPositionCount: 0,
    },
    previousHygieneTape: {
      closedN: 0,
      avgCostR: null,
      netAvgR: null,
      below175ClosedN: 0,
      note: "n/a",
    },
    legacyOrMixedTape: {
      closedN: 0,
      avgCostR: null,
      grossToNetDrag: null,
      note: "n/a",
    },
    verdict: "RISK_HYGIENE_IMPROVING",
    currentGuardLaneSummary: makeBaseRouteLane(laneOverride),
  };
}

function makePortfolioTrendReport(): PortfolioTrendShadowReport {
  return {
    reportOnly: true,
    laneVersion: "PORTFOLIO_TREND_SHADOW_V1",
    computedAt: "2026-05-27T00:00:00.000Z",
    totalObs: 3,
    openObs: 1,
    resolvedObs: 2,
    freshValidResolved: 2,
    freshValidNetAvgR: 0.04,
    freshValidPF: 1.1,
    freshValidWR: 0.5,
    avgHoldingHours: 30,
    admissionVelocityPerDay: 3,
    resolvedVelocityPerDay: 2,
    freshValidVelocityPerDay: 2,
    turnoverPerDay: 0.5,
    symbolConcentration: [{ symbol: "SOLUSDT", n: 3, share: 1.0 }],
    byRegime: [{ regime: "Bullish expansion", n: 2, netAvgR: 0.04 }],
    costSensitivity: { atDefault: 0.04, at10bpsRoundtrip: 0.03, at50bpsRoundtrip: -0.02 },
    status: "COLLECTING",
    statusReason: "freshValid<20",
  };
}

describe("dashboard new sections AA / AB / AD / W*****", () => {
  it("renders section AA with NOT_LIVE_READY verdict", () => {
    const r = buildDashboardAuditSummaryReport([]);
    expect(r.summaryText).toContain("AA. STRATEGIC PROFIT ROADMAP");
    expect(r.summaryText).toContain("Current branch verdict: NOT_LIVE_READY");
    expect(r.summaryText).toContain("Killed workstreams:");
    expect(r.summaryText).toContain("TP2/TP3 Runner Exit Extensions");
  });

  it("renders section AB with portfolio trend status when provided", () => {
    const r = buildDashboardAuditSummaryReport([], {
      portfolioTrendReport: makePortfolioTrendReport(),
    });
    expect(r.summaryText).toContain("AB. PORTFOLIO TREND SHADOW V1");
    expect(r.summaryText).toContain("Lane: PORTFOLIO_TREND_SHADOW_V1");
    expect(r.summaryText).toContain("Status: COLLECTING");
    expect(r.summaryText).toContain("Symbol concentration:");
  });

  it("renders section AB with [unavailable] when no portfolio trend report", () => {
    const r = buildDashboardAuditSummaryReport([]);
    expect(r.summaryText).toContain("AB. PORTFOLIO TREND SHADOW V1");
    expect(r.summaryText).toContain("[unavailable]");
  });

  it("renders section AD with liveBlocked=true and 9 blockers", () => {
    const r = buildDashboardAuditSummaryReport([]);
    expect(r.summaryText).toContain("AD. LIVE TRADING GATE V1");
    expect(r.summaryText).toContain("liveBlocked: true");
    expect(r.summaryText).toContain("microPilotAllowed: false");
    // 9 blocker lines starting with "[FAIL]" or "[NOT_MEASURABLE]" or "[PASS]"
    const matches = r.summaryText.match(/\[(FAIL|NOT_MEASURABLE|PASS)\] [A-Z_]+:/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(9);
  });

  it("renders W***** SHADOW LANE SCOREBOARD with top-5 lists", () => {
    const r = buildDashboardAuditSummaryReport([], {
      portfolioTrendReport: makePortfolioTrendReport(),
    });
    expect(r.summaryText).toContain("W*****. SHADOW LANE SCOREBOARD");
    expect(r.summaryText).toContain("Top 5 by freshValid netAvgR:");
    expect(r.summaryText).toContain("Top 5 by PF:");
    expect(r.summaryText).toContain("admission=3.00/day | resolved=2.00/day | freshValid=2.00/day");
    expect(r.summaryText).toContain("Killed lanes:");
  });

  describe("base route current-guard lane wiring", () => {
    it("W***** scoreboard renders 'Candidate lanes from base route' section with the base route lane", () => {
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
      });
      expect(r.summaryText).toContain("Candidate lanes from base route:");
      expect(r.summaryText).toContain("BASE_ROUTE_STOP175_CURRENT_GUARD");
      expect(r.summaryText).toContain("Caution:");
      expect(r.summaryText).toContain("not live approval");
    });

    it("AD live gate shows base route as nearest candidate when its net > controller-aligned net", () => {
      // Note: dashboard auto-derives controllerAlignedReport internally; the
      // base-route lane has positive net so it must beat any neg/null lane.
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
      });
      expect(r.summaryText).toContain("AD. LIVE TRADING GATE V1");
      expect(r.summaryText).toContain("Nearest candidate lane:");
      expect(r.summaryText).toContain("BASE_ROUTE_STOP175_CURRENT_GUARD");
      expect(r.summaryText).toContain("Cautions:");
      // liveBlocked stays true regardless
      expect(r.summaryText).toContain("liveBlocked: true");
    });

    it("test 22: F** stability section renders verdict", () => {
      const monitor = makeBaseRouteMonitor();
      monitor.stabilityReport = buildBaseRouteCurrentGuardStabilityReport(
        Array.from({ length: 20 }, (_, i) => ({
          symbol: ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT"][i % 4]!,
          direction: "LONG" as const,
          grossR: i % 5 === 0 ? -0.3 : 0.4,
          netR: i % 5 === 0 ? -0.45 : 0.2,
          costR: 0.2,
          regime: "BULLISH_EXPANSION",
          entryVariant: "base_current_entry",
          exitVariant: "tp1_full_exit",
          policyVersion: "base-route-anchor-consistent-v2",
          openedAt: new Date(Date.now() + i * 3600000).toISOString(),
          closedAt: new Date(Date.now() + i * 3600000 + 1800000).toISOString(),
        })),
        3,
      );
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: monitor,
      });
      expect(r.summaryText).toContain("F**. BASE ROUTE CURRENT-GUARD STABILITY AUDIT (REPORT-ONLY)");
      expect(r.summaryText).toContain("VERDICT:");
      expect(r.summaryText).toContain("OOS segments (time-ordered thirds):");
      expect(r.summaryText).toContain("Cost sensitivity:");
    });

    it("test 23: F*** frozen section renders status + criteria frozen timestamp", () => {
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
        frozenCurrentGuardReport: makeFrozenReport({
          total: 12,
          resolved: 12,
          freshValid: 12,
          netAvgR: 0.08,
          pf: 1.4,
          wr: 0.6,
          daysCovered: 3,
          oosSegments: null,
          status: "COLLECTING",
          statusReason: "resolved=12 (<50)",
        }),
      });
      expect(r.summaryText).toContain("F***. BASE ROUTE CURRENT-GUARD FROZEN PROSPECTIVE TAPE (REPORT-ONLY)");
      expect(r.summaryText).toContain("Status: COLLECTING");
      expect(r.summaryText).toContain("Criteria frozen at: 2026-05-28T12:00:00.000Z");
      expect(r.summaryText).toContain("prospective forward-test; criteria frozen; report-only");
    });

    it("test 15: F*** renders the realistic cost model table from the cost model report", () => {
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
        frozenCurrentGuardReport: makeFrozenReport(),
        frozenCostModelReport: makeCostModel(),
      });
      expect(r.summaryText).toContain("Realistic cost model (from AC microstructure):");
      expect(r.summaryText).toContain("conservative_flat (40.0bps):");
      expect(r.summaryText).toContain("spread_p50 (12.2bps):");
      expect(r.summaryText).toContain("spread_p90 (18.6bps):");
      expect(r.summaryText).toContain("spread_p99 (28.8bps):");
      expect(r.summaryText).toContain("funding_adverse (19.6bps):");
      expect(r.summaryText).toContain("Worst passing scenario: conservative_flat | First failing: none");
      expect(r.summaryText).toContain("Model populated: YES");
    });

    it("test 16: F*** renders ETA to n=100 / n=200", () => {
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
        frozenCurrentGuardReport: makeFrozenReport(),
      });
      expect(r.summaryText).toContain("Velocity / ETA:");
      expect(r.summaryText).toContain("ETA to n=100: 4.0 days (~2026-06-01)");
      expect(r.summaryText).toContain("ETA to n=200: 12.0 days (~2026-06-09)");
    });

    it("test 17: F*** renders OOS stability block with STABILITY_BLOCKED", () => {
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
        frozenCurrentGuardReport: makeFrozenReport(),
      });
      expect(r.summaryText).toContain("OOS stability watch:");
      expect(r.summaryText).toContain("Segment 1: n=16 net=-0.3185");
      expect(r.summaryText).toContain("Positive segments: 2/3 | Weakest: segment_1");
      expect(r.summaryText).toContain("Stability: STABILITY_BLOCKED (need all 3 positive; 1 more required)");
    });

    it("test 18: AD renders FUNDING_SLIPPAGE_MODELED PASS tied to cost model, liveBlocked still true", () => {
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
        frozenCurrentGuardReport: makeFrozenReport(),
        frozenCostModelReport: makeCostModel({ modelPopulated: true, worstPassingScenario: "spread_p90" }),
      });
      expect(r.summaryText).toContain("[PASS] FUNDING_SLIPPAGE_MODELED:");
      expect(r.summaryText).toContain("realistic cost model populated from AC microstructure");
      // detail line under the blocker
      expect(r.summaryText).toContain("worst passing scenario: spread_p90");
      // liveBlocked must remain true
      expect(r.summaryText).toContain("liveBlocked: true");
    });

    it("test 19 (isolation): cost model source does not write any files", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const text = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/frozen-current-guard-cost-model.ts"),
        "utf8",
      );
      expect(text.includes("shadow-positions.json")).toBe(false);
      expect(/writeFile(Sync)?\s*\(/.test(text)).toBe(false);
      expect(/appendFile(Sync)?\s*\(/.test(text)).toBe(false);
      // pure module — no node:fs import at all
      expect(text.includes("node:fs")).toBe(false);
    });

    it("test 24 (isolation): new stability + frozen source modules do not write shadow-positions.json", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      // Stability audit is a pure module — no fs imports at all.
      const stabilityText = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/base-route-current-guard-stability-audit.ts"),
        "utf8",
      );
      expect(stabilityText.includes("shadow-positions.json")).toBe(false);
      expect(/writeFile(Sync)?\s*\(/.test(stabilityText)).toBe(false);
      // Frozen store DOES write — but only to its own isolated file, never shadow-positions.json.
      const frozenText = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/base-route-current-guard-frozen.ts"),
        "utf8",
      );
      expect(frozenText.includes("shadow-positions.json")).toBe(false);
      expect(frozenText.includes("base-route-current-guard-frozen.json")).toBe(true);
    });

    it("AA roadmap lists Base Route Stop175 Current-Guard Tape in keep-testing", () => {
      const r = buildDashboardAuditSummaryReport([]);
      expect(r.summaryText).toContain("AA. STRATEGIC PROFIT ROADMAP");
      expect(r.summaryText).toContain("Base Route Stop175 Current-Guard Tape");
    });

    it("F**** renders promotion tracker status from frozen report", () => {
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
        frozenCurrentGuardReport: makeFrozenReport(),
      });
      expect(r.summaryText).toContain("F****. FROZEN CURRENT-GUARD PROMOTION TRACKER");
      expect(r.summaryText).toContain("Status: STABILITY_BLOCKED");
      expect(r.summaryText).toContain("Rolling windows:");
      expect(r.summaryText).toContain("Promotion blockers:");
    });

    it("AE / AF / AG readiness sections render with ready=false", () => {
      const r = buildDashboardAuditSummaryReport([], {});
      expect(r.summaryText).toContain("AE. KILL SWITCH READINESS");
      expect(r.summaryText).toContain("AF. ORDER RECONCILIATION READINESS");
      expect(r.summaryText).toContain("AG. EXCHANGE HEALTH READINESS");
      expect(r.summaryText).toContain("ready=false");
    });

    it("AD references AE/AF/AG infrastructure readiness flags", () => {
      const r = buildDashboardAuditSummaryReport([], {});
      expect(r.summaryText).toContain("Infrastructure readiness:");
      expect(r.summaryText).toContain("killSwitchReady: false (see AE)");
      expect(r.summaryText).toContain("orderReconciliationReady: false (see AF)");
      expect(r.summaryText).toContain("exchangeHealthReady: false (see AG)");
      expect(r.summaryText).toContain("liveBlocked: true");
    });

    it("isolation: source modules do not reference data/shadow-positions writes", async () => {
      // Static isolation guard: new code (base route lane summary + scoreboard +
      // live gate + roadmap + dashboard wiring) must not touch
      // data/shadow-positions.json. We assert that none of the changed source
      // files contain a shadow-positions write path. Runtime fs spies are
      // unreliable here because Node's built-in fs descriptors are non-
      // configurable under vitest's module evaluation.
      const fs = await import("node:fs");
      const path = await import("node:path");
      // Resolve from project root: test cwd is apps/api.
      const filesToCheck = [
        "src/lib/base-route-risk-hygiene-monitor.ts",
        "src/lib/shadow-lane-scoreboard.ts",
        "src/lib/live-trading-gate.ts",
        "src/lib/strategy-research-roadmap.ts",
      ];
      for (const rel of filesToCheck) {
        const text = fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
        expect(text.includes("shadow-positions.json")).toBe(false);
        expect(/writeFile(Sync)?\s*\(/.test(text)).toBe(false);
        expect(/appendFile(Sync)?\s*\(/.test(text)).toBe(false);
      }
      // And confirm the dashboard build itself returns a valid pure result.
      const r = buildDashboardAuditSummaryReport([], {
        baseRouteRiskHygieneMonitor: makeBaseRouteMonitor(),
        portfolioTrendReport: makePortfolioTrendReport(),
      });
      expect(typeof r.summaryText).toBe("string");
      expect(r.summaryText.length).toBeGreaterThan(0);
    });
  });
});

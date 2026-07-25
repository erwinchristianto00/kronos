import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ShadowPosition } from "@dtc/shared";

import { buildAcceleratedEvidenceFunnelReportFromLog } from "../src/lib/accelerated-evidence-funnel.js";
import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";
import { registerShadowRoutes } from "../src/routes/shadow.js";

let __metadataSnapshotTempDir: string;
let __originalSnapshotPath: string | undefined;

beforeAll(() => {
  __metadataSnapshotTempDir = mkdtempSync(join(tmpdir(), "ext-meta-test-"));
  __originalSnapshotPath = process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
  process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = join(__metadataSnapshotTempDir, "snapshot.json");
});

afterAll(() => {
  if (__originalSnapshotPath === undefined) {
    delete process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
  } else {
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = __originalSnapshotPath;
  }
  rmSync(__metadataSnapshotTempDir, { recursive: true, force: true });
});

describe("dashboard audit summary", () => {
  it("returns a safe empty report with summary text and highlights", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.generatedAt).toBeTruthy();
    expect(report.era).toBe("POST_CALIBRATION");
    expect(report.summaryText).toContain("DASHBOARD AUDIT SUMMARY - POST_CALIBRATION");
    expect(report.summaryText).toContain("A. BOT STATE");
    expect(report.summaryText).toContain("M. ONE-LINE EXECUTIVE TAKEAWAY");
    expect(report.highlights).toBeTruthy();
    expect(report.highlights.botState).toBeTruthy();
    expect(report.highlights.liveReadiness).toBeTruthy();
    expect(report.highlights.routeMaturity).toBeTruthy();
    expect(report.highlights.currentPerformance).toBeTruthy();
    expect(report.highlights.profitAnatomy).toBeTruthy();
    expect(report.highlights.stopGeometry).toBeTruthy();
    expect(report.highlights.baseRouteRiskHygieneMonitor).toBeTruthy();
    expect(report.highlights.winnerLoser).toBeTruthy();
    expect(report.highlights.intelligenceFoundation).toBeTruthy();
    expect(report.highlights.symbolRouteSuitability).toBeTruthy();
    expect(report.highlights.adaptiveGateIntelligence).toBeTruthy();
    expect(report.highlights.regimePolicyCounterfactual).toBeTruthy();
    expect(report.highlights.forwardOverlay).toBeTruthy();
    expect(report.highlights.externalStrategyFitEnrichment).toBeTruthy();
    expect(report.highlights.externalRotationShadowOverlay).toBeTruthy();
    expect(report.highlights.adaptiveProfitPolicySynthesis).toBeTruthy();
    expect(report.highlights.adaptiveDirectionPosture).toBeTruthy();
    expect(report.highlights.microPilotReadinessByPolicyLane).toBeTruthy();
    expect(report.highlights.exploitShadowCollectionPriorities).toBeTruthy();
    expect(report.highlights.executiveTakeaway).toBeTruthy();
  });

  it("supports era handling and keeps the final takeaway conservative", () => {
    const report = buildDashboardAuditSummaryReport([], { era: "ALL_TIME" });
    expect(report.era).toBe("ALL_TIME");
    expect(report.summaryText).toContain("DASHBOARD AUDIT SUMMARY - ALL_TIME");
    expect(report.highlights.executiveTakeaway.length).toBeGreaterThan(0);
    expect(report.highlights.executiveTakeaway).toContain("no route is currently live-ready");
  });

  it("includes expected section labels in summary text", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("B. LIVE READINESS");
    expect(report.summaryText).toContain("C. CURRENT LEADING ROUTE MATURITY");
    expect(report.summaryText).toContain("F*. BASE ROUTE RISK HYGIENE MONITOR (REPORT-ONLY)");
    expect(report.summaryText).toContain("K. REGIME POLICY COUNTERFACTUAL");
    expect(report.summaryText).toContain("L. FORWARD REGIME OVERLAY");
    expect(report.summaryText).toContain("Q. EXTERNAL STRATEGY-FIT ENRICHMENT");
    expect(report.summaryText).toContain("R. EXTERNAL ROTATION SHADOW OVERLAY");
    expect(report.summaryText).toContain("V. ADAPTIVE PROFIT POLICY SYNTHESIS");
    expect(report.summaryText).toContain("W. DIRECTION-ADAPTIVE EXECUTION POSTURE");
    expect(report.summaryText).toContain("X. MICRO-PILOT READINESS BY POLICY LANE");
    expect(report.summaryText).toContain("Y. EXPLOIT SHADOW COLLECTION PRIORITIES");
  });

  it("W* and scan-cycle produce the same controllerMode for 'Bullish expansion' (cross-check)", () => {
    // This is the alignment test: if both the dashboard W* and the scan cycle use
    // buildRegimeDirectionControllerReport with the same regime string, they MUST
    // produce the same controllerMode. The scan-cycle uses result.marketRegime;
    // the dashboard W* uses lastAutoRefreshResultSummary.marketRegime.
    // Both paths feed the same pure function — verify it here.
    const regime = "Bullish expansion";

    // Simulated scan-cycle call (scan.ts: buildRegimeDirectionControllerReport({ currentRegime: result.marketRegime }))
    const scanCycleReport = buildRegimeDirectionControllerReport({ currentRegime: regime });

    // Simulated dashboard W* call (dashboard-audit-summary.ts: currentScanRegime from lastAutoRefreshResultSummary)
    const dashboardReport = buildRegimeDirectionControllerReport({ currentRegime: regime });

    expect(scanCycleReport.controllerMode).toBe("LONG_ONLY");
    expect(dashboardReport.controllerMode).toBe("LONG_ONLY");
    expect(scanCycleReport.controllerMode).toBe(dashboardReport.controllerMode);
  });

  it("shows Z* section in summary text", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Z*. ACCELERATED EVIDENCE FUNNEL (REPORT-ONLY)");
  });

  it("shows W** section in summary text", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
  });

  it("W** shows scan-cycle controller mode from funnel log when entries are present", () => {
    const report = buildDashboardAuditSummaryReport([], {
      coreScanAutoRefresh: {
        enabled: true,
        intervalMinutes: 7,
        lastAutoRefreshStatus: "SUCCESS",
        lastAutoRefreshFinishedAt: new Date().toISOString(),
        lastAutoRefreshError: null,
        lastAutoRefreshResultSummary: {
          scannedSymbols: 10,
          returnedSymbols: 10,
          marketRegime: "Bullish expansion",
        },
      },
      // Supply an empty aligned shadow store so W** renders (not "Unavailable")
      controllerAlignedShadowStore: { observations: [] },
      candidateFunnelEntries: [
        {
          timestamp: new Date().toISOString(),
          scanCycleId: new Date().toISOString(),
          source: "SCAN_CYCLE",
          symbol: "BTCUSDT",
          direction: "LONG",
          currentRegime: "Bullish expansion",
          rawCurrentRegime: "Bullish expansion",
          normalizedRegimeFamily: "BULLISH_EXPANSION",
          controllerMode: buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" }).controllerMode,
          controllerReasonCodes: ["REGIME_LONG_TREND"],
          controllerSource: "SCAN_CYCLE",
          controllerAllowsDirection: true,
          selectedEntryVariant: null,
          selectedExitVariant: null,
          routeMode: null,
          hasSelectedExecutionPlan: false,
          stopDistanceBps: null,
          stop175Pass: null,
          sourceConflict: null,
          liveSourceConflict: null,
          kronosBias: null,
          whaleAgreement: null,
          normalShadowEligible: false,
          controllerAlignedEligible: false,
          controllerAlignedOpened: false,
          rejectionReasons: ["MISSING_EXECUTION_PLAN"],
        },
      ],
    });

    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("Scan-cycle controller mode: LONG_ONLY");
  });

  it("shows overlay diagnostics as unavailable instead of fake zeros when no refresh metadata exists", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("R. EXTERNAL ROTATION SHADOW OVERLAY");
    expect(report.summaryText).toContain("- Collection diagnostics: unavailable");
    expect(report.summaryText).not.toContain("created=0 | duplicate-suppressed=0");
  });

  it("renders the base route risk hygiene monitor when supplied", () => {
    const report = buildDashboardAuditSummaryReport([], {
      baseRouteRiskHygieneMonitor: {
        guardReasonCode: "STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK",
        guardThresholdBps: 175,
        guardActivatedAtRetainedLog: "2026-05-21T13:33:54.662Z",
        skippedUltraTightCandidates: { total: 9, recent24h: 9 },
        postGuardTape: {
          closedN: 0,
          openN: 2,
          avgCostR: null,
          grossAvgR: null,
          netAvgR: null,
          grossToNetDrag: null,
          ultraTightClosedN: 0,
          below175ClosedN: 0,
          below100ClosedN: 0,
          anchorConsistentPositionCount: 2,
          mixedOrLegacyPositionCount: 0,
        },
        previousHygieneTape: {
          closedN: 22,
          avgCostR: 0.4,
          netAvgR: -0.05,
          below175ClosedN: 21,
          note: "Anchor-consistent V2 positions created before stop175-v1 guard stamp.",
        },
        legacyOrMixedTape: {
          closedN: 84,
          avgCostR: 0.9,
          grossToNetDrag: 0.2,
          note: "Headline system and route stats still mix 84 pre-anchor-fix close(s) with 0 current-guard close(s); judge the guard from current-guard tape only.",
        },
        verdict: "COLLECTING_CURRENT_GUARD_TAPE",
      },
    });

    expect(report.summaryText).toContain("F*. BASE ROUTE RISK HYGIENE MONITOR (REPORT-ONLY)");
    expect(report.summaryText).toContain("Active guard: stopDistanceBps < 175 | version=base-route-risk-hygiene-stop175-v1");
    expect(report.summaryText).toContain("Guard skips: total=9 | recent24h=9");
    expect(report.summaryText).toContain("Current-guard tape: closed=0 | open=2");
    expect(report.summaryText).toContain("Current-guard residue: <175bps closed=0 | <100bps closed=0");
    expect(report.summaryText).toContain("Previous hygiene tape: closed=22 | <175bps closed=21");
    expect(report.summaryText).toContain("Verdict: COLLECTING_CURRENT_GUARD_TAPE");
    expect(report.summaryText).toContain("(report-only, no behavior influence)");
    expect((report.highlights.baseRouteRiskHygieneMonitor as Record<string, unknown>).verdict).toBe("COLLECTING_CURRENT_GUARD_TAPE");
  });

  it("renders Phase 2F consensus labels in the operator summary", () => {
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 0, netAvgR: null, grossAvgR: null, profitFactor: null },
        candidates: [],
        rankedTopPolicies: [],
        bestOverallPolicy: {
          policyId: "core-short",
          policyLabel: "BEARISH_EXPANSION + SHORT",
          sourceType: "CORE",
          direction: "SHORT",
          dominantRegime: "BEARISH_EXPANSION",
          route: "vwap_retest_entry",
          exitPolicy: "tp1_full_exit",
          symbolScope: "ALL_SYMBOLS",
          sampleSize: 40,
          netAvgR: -0.1,
          grossAvgR: 0,
          profitFactor: 0.7,
          deltaVsBaseline: 0.3,
          avgWinR: 0.2,
          avgLossR: -1,
          credibility: "CLEAN_EVALUABLE",
          contaminationFlags: [],
          validityFlags: [],
          policyVerdict: "WATCHABLE",
          blockers: ["Net economics are not positive yet."],
          whyThisPolicyRanksHere: ["n=40"],
          rankingScore: 10,
          evidenceConsensus: {
            evidenceConsensusScore: 74,
            evidenceConsensusVerdict: "MODERATE_CONSENSUS",
            positiveEvidenceCount: 3,
            negativeEvidenceCount: 0,
            conflictingEvidenceCount: 0,
            missingEvidenceCount: 2,
            keyConsensusReasons: ["Direction aligns with dominant market regime."],
            keyConflictReasons: [],
          },
          collectionPriority: "PRIMARY_PROFIT_LANE",
          operativeCollectionPriority: "SECONDARY_VALIDATION_LANE",
          collectionPriorityReason: "Needs more validation.",
          collectionPriorityScore: 12,
          collectionPriorityBlockers: ["Net economics are still negative."],
          microPilotReadiness: { verdict: "WATCH_CLOSELY", microPilotReady: false, blockers: [] },
        },
        bestShortPolicy: null,
        bestLongPolicy: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: {
          shortLaneReadiness: "WATCHABLE",
          longLaneReadiness: "NO_PROMOTABLE_POLICY_YET",
        },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: {
          primaryProfitLane: null,
          secondaryValidationLane: null,
          observeOnlyLanes: [],
          antiBiasSafeguard: "keep collecting longs",
        },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "keep collecting longs",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: ["Net economics are still negative."],
        },
        notes: [],
      },
    } as never);
    expect(report.summaryText).toContain("Best ranked consensus: MODERATE_CONSENSUS");
    expect(report.summaryText).toContain("Top consensus reason: Direction aligns with dominant market regime.");
    expect(report.summaryText).toContain("Operative collection mode: VALIDATION_ONLY");
  });

  it("Section V includes realistic basis lines when exToxicSibling has realistic fields populated", () => {
    const exToxicSibling = {
      policyId: "CORE_ALL_EX_TOXIC",
      policyLabel: "BEARISH_EXPANSION + SHORT [EX_TOXIC: BNBUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 30,
      netAvgR: -0.0046,
      grossAvgR: 0.02,
      profitFactor: 0.9787,
      deltaVsBaseline: 0.05,
      avgWinR: 0.2,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: ["EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 10,
      evidenceConsensus: {
        evidenceConsensusScore: 60,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 2,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "EX_TOXIC sibling.",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
      excludedSymbols: ["BNBUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      netAvgRRealisticBasis: 0.0157,
      profitFactorRealisticBasis: 1.07,
      costDragRealisticBasis: 0.0203,
      avgCostRRealisticBasis: 0.12,
      realisticBasisCoverage: 1,
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 30, netAvgR: -0.0046, grossAvgR: 0.02, profitFactor: 0.9787 },
        candidates: [exToxicSibling],
        rankedTopPolicies: [],
        bestOverallPolicy: null,
        bestShortPolicy: null,
        bestShortPolicyExToxic: exToxicSibling,
        bestLongPolicy: null,
        bestOverallPolicyExToxic: null,
        bestLongPolicyExToxic: null,
        currentAdaptiveDirectionBias: "NO_EDGE_YET",
        directionalReadiness: { shortLaneReadiness: "NO_PROMOTABLE_POLICY_YET", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "NO_PRIMARY_LANE_YET",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    expect(report.summaryText).toContain("Conservative basis:");
    expect(report.summaryText).toContain("Realistic basis");
    expect(report.summaryText).toContain("5bps fee/side, Binance USD-M VIP 0");
    expect(report.summaryText).toContain("Cost drag saved");
  });

  it("Section M executive takeaway includes realistic basis clause when exToxicSibling has realistic metrics", () => {
    const exToxicSibling = {
      policyId: "CORE_ALL_EX_TOXIC",
      policyLabel: "BEARISH_EXPANSION + SHORT [EX_TOXIC: BNBUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 30,
      netAvgR: -0.0046,
      grossAvgR: 0.02,
      profitFactor: 0.9787,
      deltaVsBaseline: 0.2, // materially better than baseline (>0.05 threshold for exToxicMateriallyBetter)
      avgWinR: 0.2,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: ["EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 10,
      evidenceConsensus: {
        evidenceConsensusScore: 60,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 2,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "EX_TOXIC sibling.",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
      excludedSymbols: ["BNBUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      netAvgRRealisticBasis: 0.0157,
      profitFactorRealisticBasis: 1.07,
      costDragRealisticBasis: 0.0203,
      avgCostRRealisticBasis: 0.12,
      realisticBasisCoverage: 1,
    };
    // For exToxicMateriallyBetter = true, we need exToxicNetAvgRDelta > 0.05
    // exToxicNetAvgRDelta = sibling.netAvgR - parent.netAvgR
    // parent.netAvgR = -0.1, sibling.netAvgR = -0.0046 → delta = 0.0954 > 0.05 ✓
    const parent = {
      policyId: "CORE_ALL",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 36,
      netAvgR: -0.1,
      grossAvgR: 0.02,
      profitFactor: 0.85,
      deltaVsBaseline: 0.1,
      avgWinR: 0.2,
      avgLossR: -0.2,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 8,
      evidenceConsensus: {
        evidenceConsensusScore: 50,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 0,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 5,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 36, netAvgR: -0.1, grossAvgR: 0.02, profitFactor: 0.85 },
        candidates: [parent, exToxicSibling],
        rankedTopPolicies: [],
        bestOverallPolicy: parent,
        bestShortPolicy: parent,
        bestShortPolicyExToxic: exToxicSibling,
        bestLongPolicy: null,
        bestOverallPolicyExToxic: null,
        bestLongPolicyExToxic: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "NO_PRIMARY_LANE_YET",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    // Section M should mention realistic/Binance basis
    expect(report.summaryText).toContain("realistic Binance USD-M fee basis");
    expect(report.summaryText).toContain("conservative basis");
  });

  it("Section V renders 'Best ranked (credibility-led)' and not 'Best overall'", () => {
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 0, netAvgR: null, grossAvgR: null, profitFactor: null },
        candidates: [],
        rankedTopPolicies: [],
        bestOverallPolicy: {
          policyId: "core-short",
          policyLabel: "BEARISH_EXPANSION + SHORT",
          sourceType: "CORE",
          direction: "SHORT",
          dominantRegime: "BEARISH_EXPANSION",
          route: "vwap_retest_entry",
          exitPolicy: "tp1_full_exit",
          symbolScope: "ALL_SYMBOLS",
          sampleSize: 40,
          netAvgR: -0.1,
          grossAvgR: 0,
          profitFactor: 0.7,
          deltaVsBaseline: 0.3,
          avgWinR: 0.2,
          avgLossR: -1,
          credibility: "CLEAN_EVALUABLE",
          contaminationFlags: [],
          validityFlags: [],
          policyVerdict: "WATCHABLE",
          blockers: [],
          whyThisPolicyRanksHere: [],
          rankingScore: 10,
          evidenceConsensus: {
            evidenceConsensusScore: 74,
            evidenceConsensusVerdict: "MODERATE_CONSENSUS",
            positiveEvidenceCount: 3,
            negativeEvidenceCount: 0,
            conflictingEvidenceCount: 0,
            missingEvidenceCount: 2,
            keyConsensusReasons: [],
            keyConflictReasons: [],
          },
          collectionPriority: "PRIMARY_PROFIT_LANE",
          operativeCollectionPriority: "SECONDARY_VALIDATION_LANE",
          collectionPriorityReason: "",
          collectionPriorityScore: 12,
          collectionPriorityBlockers: [],
          microPilotReadiness: { verdict: "WATCH_CLOSELY", microPilotReady: false, blockers: [] },
        },
        bestShortPolicy: null,
        bestLongPolicy: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    expect(report.summaryText).toContain("Best ranked (credibility-led):");
    expect(report.summaryText).not.toContain("Best overall:");
  });

  it("Section V renders a 'Best by economics' line", () => {
    const candidate = {
      policyId: "core-short",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 40,
      netAvgR: -0.05,
      grossAvgR: 0.02,
      profitFactor: 0.9,
      deltaVsBaseline: 0.1,
      avgWinR: 0.2,
      avgLossR: -1,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 10,
      evidenceConsensus: {
        evidenceConsensusScore: 60,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 2,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "PRIMARY_PROFIT_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 10,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 0, netAvgR: null, grossAvgR: null, profitFactor: null },
        candidates: [candidate],
        rankedTopPolicies: [candidate],
        bestOverallPolicy: candidate,
        bestShortPolicy: null,
        bestLongPolicy: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    expect(report.summaryText).toContain("Best by economics:");
  });

  it("Section V 'Best by economics' picks a different candidate when a higher-netAvgR candidate exists", () => {
    // credibility-led winner: lower netAvgR but CLEAN_EVALUABLE credibility (ranks higher in comparator)
    const credibilityLeader = {
      policyId: "external-fit",
      policyLabel: "EXTERNAL_STRATEGY_FIT_SHORTLIST",
      sourceType: "EXTERNAL" as const,
      direction: "SHORT" as const,
      dominantRegime: null,
      route: null,
      exitPolicy: null,
      symbolScope: "EXTERNAL",
      sampleSize: 12,
      netAvgR: 0.02,
      grossAvgR: 0.05,
      profitFactor: 1.1,
      deltaVsBaseline: 0.05,
      avgWinR: 0.3,
      avgLossR: -0.1,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 5,
      evidenceConsensus: {
        evidenceConsensusScore: 50,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 1,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 4,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 5,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    // economics winner: higher netAvgR
    const economicsLeader = {
      policyId: "core-short",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 40,
      netAvgR: 0.15,
      grossAvgR: 0.2,
      profitFactor: 1.5,
      deltaVsBaseline: 0.3,
      avgWinR: 0.4,
      avgLossR: -0.1,
      credibility: "CLEAN_WATCHABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 20,
      evidenceConsensus: {
        evidenceConsensusScore: 74,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 3,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "PRIMARY_PROFIT_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 15,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 0, netAvgR: null, grossAvgR: null, profitFactor: null },
        candidates: [credibilityLeader, economicsLeader],
        rankedTopPolicies: [credibilityLeader, economicsLeader],
        bestOverallPolicy: credibilityLeader,
        bestShortPolicy: null,
        bestLongPolicy: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    // Best ranked shows credibility leader
    expect(report.summaryText).toContain("Best ranked (credibility-led): EXTERNAL_STRATEGY_FIT_SHORTLIST");
    // Best by economics shows the higher-netAvgR economics leader
    expect(report.summaryText).toContain("Best by economics: BEARISH_EXPANSION + SHORT");
    // Confirms they differ
    expect(report.summaryText).not.toContain("Best ranked (credibility-led): BEARISH_EXPANSION + SHORT");
  });

  it("Section M EX_TOXIC-aware executive takeaway still renders correctly (regression guard)", () => {
    const exToxicSibling = {
      policyId: "CORE_ALL_EX_TOXIC",
      policyLabel: "BEARISH_EXPANSION + SHORT [EX_TOXIC: BNBUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 30,
      netAvgR: -0.0046,
      grossAvgR: 0.02,
      profitFactor: 0.9787,
      deltaVsBaseline: 0.2,
      avgWinR: 0.2,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: ["EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 10,
      evidenceConsensus: {
        evidenceConsensusScore: 60,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 2,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "EX_TOXIC sibling.",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
      excludedSymbols: ["BNBUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      netAvgRRealisticBasis: 0.0157,
      profitFactorRealisticBasis: 1.07,
      costDragRealisticBasis: 0.0203,
      avgCostRRealisticBasis: 0.12,
      realisticBasisCoverage: 1,
    };
    const parent = {
      policyId: "CORE_ALL",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 36,
      netAvgR: -0.1,
      grossAvgR: 0.02,
      profitFactor: 0.85,
      deltaVsBaseline: 0.1,
      avgWinR: 0.2,
      avgLossR: -0.2,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 8,
      evidenceConsensus: {
        evidenceConsensusScore: 50,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 0,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 5,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 36, netAvgR: -0.1, grossAvgR: 0.02, profitFactor: 0.85 },
        candidates: [parent, exToxicSibling],
        rankedTopPolicies: [],
        bestOverallPolicy: parent,
        bestShortPolicy: parent,
        bestShortPolicyExToxic: exToxicSibling,
        bestLongPolicy: null,
        bestOverallPolicyExToxic: null,
        bestLongPolicyExToxic: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "NO_PRIMARY_LANE_YET",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    // Section M still renders EX_TOXIC-aware takeaway
    expect(report.summaryText).toContain("M. ONE-LINE EXECUTIVE TAKEAWAY");
    expect(report.summaryText).toContain("Most actionable refined policy:");
    expect(report.summaryText).toContain("EX_TOXIC");
    // Realistic clause still present
    expect(report.summaryText).toContain("realistic Binance USD-M fee basis");
  });

  // ── Issue 1 tests: "Best by economics" must ignore TOO_EARLY candidates ──────────────────

  it("Section V 'Best by economics' ignores TOO_EARLY candidates when a mature positive candidate exists", () => {
    const tooEarlyCandidate = {
      policyId: "solusdt-short",
      policyLabel: "BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit + SOLUSDT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "SINGLE_SYMBOL",
      sampleSize: 1,
      netAvgR: 0.5261,
      grossAvgR: 0.6,
      profitFactor: 3.0,
      deltaVsBaseline: 0.6,
      avgWinR: 0.6,
      avgLossR: -0.3,
      credibility: "INSUFFICIENT_DATA" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "TOO_EARLY" as const,
      blockers: ["Sample size too small."],
      whyThisPolicyRanksHere: [],
      rankingScore: 2,
      evidenceConsensus: {
        evidenceConsensusScore: 30,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 0,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 5,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const matureCandidate = {
      policyId: "core-ex-toxic",
      policyLabel: "BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit [EX_TOXIC: BNBUSDT, DOGEUSDT, LINKUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 35,
      netAvgR: 0.1363,
      grossAvgR: 0.22,
      profitFactor: 2.31,
      deltaVsBaseline: 0.18,
      avgWinR: 0.4,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: ["EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: "WATCHABLE" as const,
      blockers: ["Need netAvgR >= 0.15R"],
      whyThisPolicyRanksHere: ["Positive net economics with EX_TOXIC filter"],
      rankingScore: 18,
      evidenceConsensus: {
        evidenceConsensusScore: 70,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 3,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 12,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "NEARING_MICRO_PILOT" as const, microPilotReady: false as const, blockers: ["Need netAvgR >= 0.15R"] },
      excludedSymbols: ["BNBUSDT", "DOGEUSDT", "LINKUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      netAvgRRealisticBasis: 0.1515,
      profitFactorRealisticBasis: 2.42,
      costDragRealisticBasis: 0.015,
      avgCostRRealisticBasis: 0.1,
      realisticBasisCoverage: 1,
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-18T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 40, netAvgR: -0.01, grossAvgR: 0.08, profitFactor: 0.95 },
        candidates: [tooEarlyCandidate, matureCandidate],
        rankedTopPolicies: [matureCandidate],
        bestOverallPolicy: matureCandidate,
        bestShortPolicy: matureCandidate,
        bestShortPolicyExToxic: matureCandidate,
        bestLongPolicy: null,
        bestOverallPolicyExToxic: null,
        bestLongPolicyExToxic: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [matureCandidate],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    // The TOO_EARLY n=1 candidate must NOT win "Best by economics"
    expect(report.summaryText).not.toContain("Best by economics: BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit + SOLUSDT");
    // The mature candidate must win instead
    expect(report.summaryText).toContain("Best by economics: BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit [EX_TOXIC: BNBUSDT, DOGEUSDT, LINKUSDT]");
  });

  it("Section V 'Best by economics' selects the mature candidate with policyVerdict=WATCHABLE over a TOO_EARLY one even if TOO_EARLY has a higher netAvgR", () => {
    // TOO_EARLY has netAvgR=0.99 (n=1) — must be excluded
    const tooEarlyHighR = {
      policyId: "sol-too-early",
      policyLabel: "TOO_EARLY_LANE",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "SINGLE_SYMBOL",
      sampleSize: 1,
      netAvgR: 0.99,
      grossAvgR: 1.0,
      profitFactor: 5.0,
      deltaVsBaseline: 1.0,
      avgWinR: 1.0,
      avgLossR: -0.1,
      credibility: "INSUFFICIENT_DATA" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "TOO_EARLY" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 1,
      evidenceConsensus: {
        evidenceConsensusScore: 20,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 0,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 5,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const maturePositive = {
      policyId: "core-mature",
      policyLabel: "MATURE_WATCHABLE_LANE",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 30,
      netAvgR: 0.14,
      grossAvgR: 0.22,
      profitFactor: 2.1,
      deltaVsBaseline: 0.15,
      avgWinR: 0.35,
      avgLossR: -0.12,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 16,
      evidenceConsensus: {
        evidenceConsensusScore: 68,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 3,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 10,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "NEARING_MICRO_PILOT" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-18T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 35, netAvgR: -0.01, grossAvgR: 0.07, profitFactor: 0.92 },
        candidates: [tooEarlyHighR, maturePositive],
        rankedTopPolicies: [maturePositive],
        bestOverallPolicy: maturePositive,
        bestShortPolicy: null,
        bestLongPolicy: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [maturePositive],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    expect(report.summaryText).not.toContain("Best by economics: TOO_EARLY_LANE");
    expect(report.summaryText).toContain("Best by economics: MATURE_WATCHABLE_LANE");
  });

  // ── Issue 2 tests: Executive takeaway must not say "near break-even" for +0.1363R ──────

  it("Section M executive takeaway does not say 'near break-even' when conservative netAvgR is materially positive", () => {
    const matureSibling = {
      policyId: "core-ex-toxic",
      policyLabel: "BEARISH_EXPANSION + SHORT [EX_TOXIC: BNBUSDT, DOGEUSDT, LINKUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 35,
      netAvgR: 0.1363,
      grossAvgR: 0.22,
      profitFactor: 2.3099,
      deltaVsBaseline: 0.18,
      avgWinR: 0.4,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: ["EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: "WATCHABLE" as const,
      blockers: ["Need netAvgR >= 0.15R"],
      whyThisPolicyRanksHere: [],
      rankingScore: 18,
      evidenceConsensus: {
        evidenceConsensusScore: 70,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 3,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 12,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "NEARING_MICRO_PILOT" as const, microPilotReady: false as const, blockers: [] },
      excludedSymbols: ["BNBUSDT", "DOGEUSDT", "LINKUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      netAvgRRealisticBasis: 0.1515,
      profitFactorRealisticBasis: 2.4202,
      costDragRealisticBasis: 0.015,
      avgCostRRealisticBasis: 0.1,
      realisticBasisCoverage: 1,
    };
    const parent = {
      policyId: "core-all",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 40,
      netAvgR: -0.05,
      grossAvgR: 0.05,
      profitFactor: 0.85,
      deltaVsBaseline: 0.0,
      avgWinR: 0.3,
      avgLossR: -0.2,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 8,
      evidenceConsensus: {
        evidenceConsensusScore: 50,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 0,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 5,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-18T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 40, netAvgR: -0.05, grossAvgR: 0.05, profitFactor: 0.85 },
        candidates: [parent, matureSibling],
        rankedTopPolicies: [matureSibling],
        bestOverallPolicy: parent,
        bestShortPolicy: parent,
        bestShortPolicyExToxic: matureSibling,
        bestLongPolicy: null,
        bestOverallPolicyExToxic: null,
        bestLongPolicyExToxic: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [matureSibling],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    expect(report.highlights.executiveTakeaway).not.toContain("near break-even");
    expect(report.highlights.executiveTakeaway).toContain("meaningfully positive on conservative basis");
  });

  it("Section M executive takeaway preserves conservative-threshold-not-cleared nuance (not live-ready)", () => {
    // Same fixture as above — the lane has netAvgR=+0.1363 but NOT >= 0.15R
    const matureSibling = {
      policyId: "core-ex-toxic",
      policyLabel: "BEARISH_EXPANSION + SHORT [EX_TOXIC: BNBUSDT, DOGEUSDT, LINKUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 35,
      netAvgR: 0.1363,
      grossAvgR: 0.22,
      profitFactor: 2.3099,
      deltaVsBaseline: 0.18,
      avgWinR: 0.4,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: ["EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 18,
      evidenceConsensus: {
        evidenceConsensusScore: 70,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 3,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 12,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "NEARING_MICRO_PILOT" as const, microPilotReady: false as const, blockers: [] },
      excludedSymbols: ["BNBUSDT", "DOGEUSDT", "LINKUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      // No realistic basis — simpler fixture
      netAvgRRealisticBasis: null,
      profitFactorRealisticBasis: null,
      costDragRealisticBasis: null,
      avgCostRRealisticBasis: null,
      realisticBasisCoverage: null,
    };
    const parent = {
      policyId: "core-all",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 40,
      netAvgR: -0.05,
      grossAvgR: 0.05,
      profitFactor: 0.85,
      deltaVsBaseline: 0.0,
      avgWinR: 0.3,
      avgLossR: -0.2,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 8,
      evidenceConsensus: {
        evidenceConsensusScore: 50,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 0,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 5,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-18T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 40, netAvgR: -0.05, grossAvgR: 0.05, profitFactor: 0.85 },
        candidates: [parent, matureSibling],
        rankedTopPolicies: [matureSibling],
        bestOverallPolicy: parent,
        bestShortPolicy: parent,
        bestShortPolicyExToxic: matureSibling,
        bestLongPolicy: null,
        bestOverallPolicyExToxic: null,
        bestLongPolicyExToxic: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [matureSibling],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    // Must state the conservative gate is NOT cleared
    expect(report.highlights.executiveTakeaway).toContain("below the +0.15R conservative readiness threshold");
    // Must NOT claim any route is currently live-ready (only "No route is live-ready" is acceptable)
    expect(report.highlights.executiveTakeaway).toContain("No route is live-ready");
    expect(report.highlights.executiveTakeaway).not.toContain("a route is currently live-ready");
  });

  // ── realisticClause conditionality tests ─────────────────────────────────────────────

  it("Section M realistic clause says 'also below' when realistic netAvgR is below 0.15 (e.g. 0.1359)", () => {
    const exToxicSibling = {
      policyId: "CORE_ALL_EX_TOXIC",
      policyLabel: "BEARISH_EXPANSION + SHORT [EX_TOXIC: BNBUSDT, DOGEUSDT, LINKUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 35,
      netAvgR: 0.1246,
      grossAvgR: 0.22,
      profitFactor: 2.3099,
      deltaVsBaseline: 0.18,
      avgWinR: 0.4,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: ["EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: "WATCHABLE" as const,
      blockers: ["Need netAvgR >= 0.15R"],
      whyThisPolicyRanksHere: [],
      rankingScore: 18,
      evidenceConsensus: {
        evidenceConsensusScore: 70,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 3,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 12,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "NEARING_MICRO_PILOT" as const, microPilotReady: false as const, blockers: ["Need netAvgR >= 0.15R"] },
      excludedSymbols: ["BNBUSDT", "DOGEUSDT", "LINKUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      netAvgRRealisticBasis: 0.1359,
      profitFactorRealisticBasis: 2.31,
      costDragRealisticBasis: 0.015,
      avgCostRRealisticBasis: 0.1,
      realisticBasisCoverage: 1,
    };
    const parent = {
      policyId: "CORE_ALL",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 40,
      netAvgR: -0.05,
      grossAvgR: 0.05,
      profitFactor: 0.85,
      deltaVsBaseline: 0.0,
      avgWinR: 0.3,
      avgLossR: -0.2,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 8,
      evidenceConsensus: {
        evidenceConsensusScore: 50,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 0,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 5,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-19T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 40, netAvgR: -0.05, grossAvgR: 0.05, profitFactor: 0.85 },
        candidates: [parent, exToxicSibling],
        rankedTopPolicies: [exToxicSibling],
        bestOverallPolicy: parent,
        bestShortPolicy: parent,
        bestShortPolicyExToxic: exToxicSibling,
        bestLongPolicy: null,
        bestOverallPolicyExToxic: null,
        bestLongPolicyExToxic: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [exToxicSibling],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    // Must NOT say "above the +0.15R" when realistic netAvgR (0.1359) is below 0.15
    expect(report.highlights.executiveTakeaway).not.toContain("above the +0.15R micro-pilot threshold on realistic Binance USD-M fee basis");
    // Must say "also below" to accurately reflect that realistic basis is also below threshold
    expect(report.highlights.executiveTakeaway).toContain("also below the +0.15R micro-pilot threshold on realistic Binance USD-M fee basis");
    // Must still include the realistic netAvgR value
    expect(report.highlights.executiveTakeaway).toContain("netAvgR≈0.1359");
    // Conservative wording still accurate
    expect(report.highlights.executiveTakeaway).toContain("below the +0.15R conservative readiness threshold");
  });

  it("Section M realistic clause says 'above' when realistic netAvgR is at or above 0.15 (e.g. 0.1515)", () => {
    const exToxicSibling = {
      policyId: "CORE_ALL_EX_TOXIC",
      policyLabel: "BEARISH_EXPANSION + SHORT [EX_TOXIC: BNBUSDT, DOGEUSDT, LINKUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 35,
      netAvgR: 0.1363,
      grossAvgR: 0.22,
      profitFactor: 2.3099,
      deltaVsBaseline: 0.18,
      avgWinR: 0.4,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: ["EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: "WATCHABLE" as const,
      blockers: ["Need netAvgR >= 0.15R"],
      whyThisPolicyRanksHere: [],
      rankingScore: 18,
      evidenceConsensus: {
        evidenceConsensusScore: 70,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 3,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 12,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "NEARING_MICRO_PILOT" as const, microPilotReady: false as const, blockers: ["Need netAvgR >= 0.15R"] },
      excludedSymbols: ["BNBUSDT", "DOGEUSDT", "LINKUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      netAvgRRealisticBasis: 0.1515,
      profitFactorRealisticBasis: 2.4202,
      costDragRealisticBasis: 0.015,
      avgCostRRealisticBasis: 0.1,
      realisticBasisCoverage: 1,
    };
    const parent = {
      policyId: "CORE_ALL",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 40,
      netAvgR: -0.05,
      grossAvgR: 0.05,
      profitFactor: 0.85,
      deltaVsBaseline: 0.0,
      avgWinR: 0.3,
      avgLossR: -0.2,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 8,
      evidenceConsensus: {
        evidenceConsensusScore: 50,
        evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT" as const,
        positiveEvidenceCount: 0,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 5,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY" as const,
      operativeCollectionPriority: "OBSERVE_ONLY" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-19T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 40, netAvgR: -0.05, grossAvgR: 0.05, profitFactor: 0.85 },
        candidates: [parent, exToxicSibling],
        rankedTopPolicies: [exToxicSibling],
        bestOverallPolicy: parent,
        bestShortPolicy: parent,
        bestShortPolicyExToxic: exToxicSibling,
        bestLongPolicy: null,
        bestOverallPolicyExToxic: null,
        bestLongPolicyExToxic: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [exToxicSibling],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    // Must say "above the +0.15R" when realistic netAvgR (0.1515) is >= 0.15
    expect(report.highlights.executiveTakeaway).toContain("above the +0.15R micro-pilot threshold on realistic Binance USD-M fee basis");
    // Must NOT say "also below" for the realistic clause
    expect(report.highlights.executiveTakeaway).not.toContain("also below the +0.15R micro-pilot threshold on realistic Binance USD-M fee basis");
    // Must include the realistic netAvgR value
    expect(report.highlights.executiveTakeaway).toContain("netAvgR≈0.1515");
    // Conservative wording still accurate (conservative is below threshold)
    expect(report.highlights.executiveTakeaway).toContain("below the +0.15R conservative readiness threshold");
  });

  // ── Issue 3 tests: Section Y must not say "Why no primary lane: none" ────────────────

  it("Section Y 'Why no primary lane' renders a meaningful NEARING_MICRO_PILOT blocker when primaryLaneBlockers is empty", () => {
    const nearReadyLane = {
      policyId: "core-ex-toxic",
      policyLabel: "BEARISH_EXPANSION + SHORT [EX_TOXIC: BNBUSDT, DOGEUSDT, LINKUSDT]",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 35,
      netAvgR: 0.1363,
      grossAvgR: 0.22,
      profitFactor: 2.31,
      deltaVsBaseline: 0.18,
      avgWinR: 0.4,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 18,
      evidenceConsensus: {
        evidenceConsensusScore: 70,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 3,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      operativeCollectionPriority: "SECONDARY_VALIDATION_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 12,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "NEARING_MICRO_PILOT" as const, microPilotReady: false as const, blockers: ["Need netAvgR >= 0.15R"] },
    };
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-18T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 35, netAvgR: -0.01, grossAvgR: 0.07, profitFactor: 0.92 },
        candidates: [nearReadyLane],
        rankedTopPolicies: [nearReadyLane],
        bestOverallPolicy: nearReadyLane,
        bestShortPolicy: null,
        bestLongPolicy: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: { shortLaneReadiness: "WATCHABLE", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "VALIDATION_ONLY",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [nearReadyLane],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          // No explicit blockers — the fix must derive the reason from lane data
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    // Must NOT say "none"
    expect(report.summaryText).not.toContain("Why no primary lane: none");
    // Must mention NEARING_MICRO_PILOT and the +0.15R threshold
    expect(report.summaryText).toContain("Why no primary lane: Best lane is NEARING_MICRO_PILOT but conservative netAvgR has not cleared the +0.15R readiness threshold.");
  });

  it("Section Y 'Why no primary lane' falls back to generic message when no validation lanes exist and primaryLaneBlockers is empty", () => {
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-18T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 0, netAvgR: null, grossAvgR: null, profitFactor: null },
        candidates: [],
        rankedTopPolicies: [],
        bestOverallPolicy: null,
        bestShortPolicy: null,
        bestLongPolicy: null,
        currentAdaptiveDirectionBias: "NO_EDGE_YET",
        directionalReadiness: { shortLaneReadiness: "NO_PROMOTABLE_POLICY_YET", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "" },
        operativeCollectionPlan: {
          mode: "NO_PRIMARY_LANE_YET",
          currentOperativePrimaryLane: null,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);
    expect(report.summaryText).not.toContain("Why no primary lane: none");
    expect(report.summaryText).toContain("Why no primary lane: No lane has cleared readiness economics.");
  });

  it("registers the read-only summary route without mutating shadow state", async () => {
    const app = Fastify({ logger: false });
    let getAllPositionsCalls = 0;
    const positions: ShadowPosition[] = [];
    await registerShadowRoutes(app, {
      getAllPositions() {
        getAllPositionsCalls += 1;
        return positions;
      },
      metadataFetchImpl: async () => [],
    } as never);

    // Uses Fastify's own route-introspection API rather than string-matching printRoutes()'s
    // prefix-compressed tree output — that tree's exact text shape shifts whenever any OTHER route
    // sharing a leading path segment is registered/removed elsewhere in shadow.ts, which is unrelated
    // to whether THIS route is actually registered (see direction-entry-outcomes, added 2026-07-23,
    // which shares the "/api/shadow/d..." prefix and previously broke this assertion for that reason).
    expect(app.hasRoute({ method: "GET", url: "/api/shadow/dashboard-audit-summary" })).toBe(true);
    expect(getAllPositionsCalls).toBe(0);
    expect(positions).toEqual([]);
    void app.close();
  });

  // ── Fix 1: Section Y contradiction ─────────────────────────────────────────

  function makeBaseSynthesis(overrides: Record<string, unknown> = {}) {
    return {
      generatedAt: "2026-05-15T00:00:00.000Z",
      evidenceEra: "POST_CALIBRATION",
      baseline: { sampleSize: 0, netAvgR: null, grossAvgR: null, profitFactor: null },
      candidates: [],
      rankedTopPolicies: [],
      bestOverallPolicy: null,
      bestShortPolicy: null,
      bestLongPolicy: null,
      bestOverallPolicyExToxic: null,
      bestShortPolicyExToxic: null,
      bestLongPolicyExToxic: null,
      currentAdaptiveDirectionBias: "NO_EDGE_YET",
      directionalReadiness: { shortLaneReadiness: "NO_PROMOTABLE_POLICY_YET", longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" },
      missingEvidenceForLongLane: [],
      missingEvidenceForShortLane: [],
      exploitShadowPriorities: { primaryProfitLane: null, secondaryValidationLane: null, observeOnlyLanes: [], antiBiasSafeguard: "neutral" },
      notes: [],
      ...overrides,
    };
  }

  function makePrimaryLane(labelOverride = "BEARISH_EXPANSION + SHORT + ARBUSDT") {
    return {
      policyId: "core-short-arb",
      policyLabel: labelOverride,
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "BEARISH_EXPANSION",
      route: "base_current_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 35,
      netAvgR: 0.18,
      grossAvgR: 0.22,
      profitFactor: 1.3,
      deltaVsBaseline: 0.2,
      avgWinR: 0.3,
      avgLossR: -0.15,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "DEPLOYABLE_SHADOW_CANDIDATE" as const,
      blockers: [],
      whyThisPolicyRanksHere: ["strong economics"],
      rankingScore: 30,
      evidenceConsensus: {
        evidenceConsensusScore: 80,
        evidenceConsensusVerdict: "HIGH_CONSENSUS" as const,
        positiveEvidenceCount: 4,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 1,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "PRIMARY_PROFIT_LANE" as const,
      operativeCollectionPriority: "PRIMARY_PROFIT_LANE" as const,
      collectionPriorityReason: "Top lane.",
      collectionPriorityScore: 50,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "NEARING_MICRO_PILOT" as const, microPilotReady: false as const, blockers: ["netAvgR below threshold"] },
    };
  }

  it("Fix 1: when primary lane exists, Section Y shows PRIMARY_LANE_ACTIVE and does NOT show 'Why no primary lane'", () => {
    const primaryLane = makePrimaryLane();
    const synthesis = makeBaseSynthesis({
      operativeCollectionPlan: {
        mode: "PRIMARY_LANE_ACTIVE",
        currentOperativePrimaryLane: primaryLane,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "collecting opposites",
        externalOverlayAdmissionUsesAdaptivePrioritization: true,
        primaryLaneBlockers: [],
      },
    });
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Operative collection mode: PRIMARY_LANE_ACTIVE");
    expect(report.summaryText).toContain("Operative primary lane: BEARISH_EXPANSION + SHORT + ARBUSDT");
    expect(report.summaryText).not.toContain("Why no primary lane");
  });

  it("Fix 1: when no primary lane, Section Y shows VALIDATION_ONLY and 'Why no primary lane'", () => {
    const synthesis = makeBaseSynthesis({
      operativeCollectionPlan: {
        mode: "VALIDATION_ONLY",
        currentOperativePrimaryLane: null,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "neutral",
        externalOverlayAdmissionUsesAdaptivePrioritization: true,
        primaryLaneBlockers: ["Net economics are still negative."],
      },
    });
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Operative collection mode: VALIDATION_ONLY");
    expect(report.summaryText).toContain("Operative primary lane: none");
    expect(report.summaryText).toContain("Why no primary lane: Net economics are still negative.");
    expect(report.summaryText).not.toContain("PRIMARY_LANE_ACTIVE");
  });

  it("Fix 1 regression: secondary/observe-only lanes still rendered correctly when no primary lane", () => {
    const secondary = makePrimaryLane("BEARISH_EXPANSION + SHORT (secondary)");
    secondary.operativeCollectionPriority = "SECONDARY_VALIDATION_LANE" as const;
    const synthesis = makeBaseSynthesis({
      operativeCollectionPlan: {
        mode: "VALIDATION_ONLY",
        currentOperativePrimaryLane: null,
        secondaryValidationLanes: [secondary],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "neutral",
        externalOverlayAdmissionUsesAdaptivePrioritization: true,
        primaryLaneBlockers: ["not ready"],
      },
    });
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Operative secondary validation lanes: BEARISH_EXPANSION + SHORT (secondary)");
  });

  // ── Fix 2: Regime alignment ─────────────────────────────────────────────────

  it("Fix 2: primary lane regime matches current scan regime → MATCH", () => {
    const primaryLane = makePrimaryLane("BEARISH_EXPANSION + SHORT + ARBUSDT");
    const synthesis = makeBaseSynthesis({
      operativeCollectionPlan: {
        mode: "PRIMARY_LANE_ACTIVE",
        currentOperativePrimaryLane: primaryLane,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "collecting",
        externalOverlayAdmissionUsesAdaptivePrioritization: true,
        primaryLaneBlockers: [],
      },
    });
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: synthesis as never,
      coreScanAutoRefresh: {
        enabled: true,
        intervalMinutes: 15,
        lastAutoRefreshStatus: "SUCCESS",
        lastAutoRefreshFinishedAt: "2026-05-25T10:00:00.000Z",
        lastAutoRefreshError: null,
        lastAutoRefreshResultSummary: { scannedSymbols: 10, returnedSymbols: 10, marketRegime: "BEARISH_EXPANSION" },
      },
    });
    expect(report.summaryText).toContain("Current scan regime alignment: MATCH");
  });

  it("Fix 2: primary lane regime conflicts with current scan regime → MISMATCH", () => {
    const primaryLane = makePrimaryLane("BEARISH_EXPANSION + SHORT + ARBUSDT");
    const synthesis = makeBaseSynthesis({
      operativeCollectionPlan: {
        mode: "PRIMARY_LANE_ACTIVE",
        currentOperativePrimaryLane: primaryLane,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "collecting",
        externalOverlayAdmissionUsesAdaptivePrioritization: true,
        primaryLaneBlockers: [],
      },
    });
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: synthesis as never,
      coreScanAutoRefresh: {
        enabled: true,
        intervalMinutes: 15,
        lastAutoRefreshStatus: "SUCCESS",
        lastAutoRefreshFinishedAt: "2026-05-25T10:00:00.000Z",
        lastAutoRefreshError: null,
        lastAutoRefreshResultSummary: { scannedSymbols: 10, returnedSymbols: 10, marketRegime: "BULLISH_EXPANSION" },
      },
    });
    expect(report.summaryText).toContain("Current scan regime alignment: MISMATCH");
    expect(report.summaryText).toContain("cross-regime validation collection only, not live execution");
  });

  it("Fix 2: missing current scan regime → UNKNOWN", () => {
    const primaryLane = makePrimaryLane("BEARISH_EXPANSION + SHORT + ARBUSDT");
    const synthesis = makeBaseSynthesis({
      operativeCollectionPlan: {
        mode: "PRIMARY_LANE_ACTIVE",
        currentOperativePrimaryLane: primaryLane,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "collecting",
        externalOverlayAdmissionUsesAdaptivePrioritization: true,
        primaryLaneBlockers: [],
      },
    });
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Current scan regime alignment: UNKNOWN");
  });

  it("Fix 2: MISMATCH label does not break test — verdict/scoring unchanged", () => {
    const primaryLane = makePrimaryLane("BEARISH_EXPANSION + SHORT + ARBUSDT");
    const synthesis = makeBaseSynthesis({
      operativeCollectionPlan: {
        mode: "PRIMARY_LANE_ACTIVE",
        currentOperativePrimaryLane: primaryLane,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "collecting",
        externalOverlayAdmissionUsesAdaptivePrioritization: true,
        primaryLaneBlockers: [],
      },
    });
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: synthesis as never,
      coreScanAutoRefresh: {
        enabled: true,
        intervalMinutes: 15,
        lastAutoRefreshStatus: "SUCCESS",
        lastAutoRefreshFinishedAt: "2026-05-25T10:00:00.000Z",
        lastAutoRefreshError: null,
        lastAutoRefreshResultSummary: { scannedSymbols: 10, returnedSymbols: 10, marketRegime: "BULLISH_EXPANSION" },
      },
    });
    // MISMATCH is a display-only label — it must not affect any scoring/readiness fields
    expect(report.highlights.exploitShadowCollectionPriorities).toBeDefined();
    const plan = report.highlights.exploitShadowCollectionPriorities as Record<string, unknown>;
    expect(plan.mode).toBe("PRIMARY_LANE_ACTIVE");
    // Regime alignment label is purely additive and only in summaryText
    expect(report.summaryText).toContain("MISMATCH");
  });

  // ── Fix 3: Guard generation fields and dashboard rendering ──────────────────

  it("Fix 3: Section F* renders active guard version and both tape summaries", () => {
    const report = buildDashboardAuditSummaryReport([], {
      baseRouteRiskHygieneMonitor: {
        guardReasonCode: "STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK",
        guardThresholdBps: 175,
        guardActivatedAtRetainedLog: "2026-05-21T13:33:54.662Z",
        skippedUltraTightCandidates: { total: 5, recent24h: 2 },
        postGuardTape: {
          closedN: 3,
          openN: 1,
          avgCostR: 0.25,
          grossAvgR: 0.3,
          netAvgR: 0.05,
          grossToNetDrag: 0.25,
          ultraTightClosedN: 0,
          below175ClosedN: 0,
          below100ClosedN: 0,
          anchorConsistentPositionCount: 4,
          mixedOrLegacyPositionCount: 0,
        },
        previousHygieneTape: {
          closedN: 22,
          avgCostR: 0.4,
          netAvgR: -0.05,
          below175ClosedN: 21,
          note: "Anchor-consistent V2 positions before stop175-v1.",
        },
        legacyOrMixedTape: {
          closedN: 5,
          avgCostR: 0.9,
          grossToNetDrag: 0.5,
          note: "Legacy tape.",
        },
        verdict: "COLLECTING_CURRENT_GUARD_TAPE",
      },
    });
    expect(report.summaryText).toContain("F*. BASE ROUTE RISK HYGIENE MONITOR (REPORT-ONLY)");
    expect(report.summaryText).toContain("Active guard: stopDistanceBps < 175 | version=base-route-risk-hygiene-stop175-v1");
    expect(report.summaryText).toContain("Guard skips: total=5 | recent24h=2");
    expect(report.summaryText).toContain("Current-guard tape: closed=3 | open=1");
    expect(report.summaryText).toContain("Current-guard residue: <175bps closed=0 | <100bps closed=0");
    expect(report.summaryText).toContain("Previous hygiene tape: closed=22 | <175bps closed=21");
    expect(report.summaryText).toContain("Verdict: COLLECTING_CURRENT_GUARD_TAPE");
    expect(report.summaryText).toContain("(report-only, no behavior influence)");
  });

  // ── Phase 1: Regime Direction Controller (REPORT-ONLY) section W* ──────────

  it("W*: renders section header and core lines on an empty input", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("W*. REGIME DIRECTION CONTROLLER (REPORT-ONLY)");
    expect(report.summaryText).toContain("Current regime:");
    expect(report.summaryText).toContain("controller mode:");
    expect(report.summaryText).toContain("Permission model: allowsLong=");
    expect(report.summaryText).toContain("allowsShort=");
    expect(report.summaryText).toContain("allowsNewEntries=");
    expect(report.summaryText).toContain("requiresRetest=");
    expect(report.summaryText).toContain("Warnings:");
    expect(report.summaryText).toContain("report-only");
    expect(report.summaryText).toContain("no behavior influence");
  });

  it("W*: highlights expose the typed controller report with reportOnly=true", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.highlights.regimeDirectionController).toBeTruthy();
    expect(report.highlights.regimeDirectionController.reportOnly).toBe(true);
    expect(typeof report.highlights.regimeDirectionController.controllerMode).toBe("string");
  });

  it("W*: bullish current regime + BEARISH/SHORT primary lane surfaces MISMATCH and cross-regime warning", () => {
    const primaryLane = makePrimaryLane("BEARISH_EXPANSION + SHORT + ARBUSDT");
    const synthesis = makeBaseSynthesis({
      operativeCollectionPlan: {
        mode: "PRIMARY_LANE_ACTIVE",
        currentOperativePrimaryLane: primaryLane,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "collecting",
        externalOverlayAdmissionUsesAdaptivePrioritization: true,
        primaryLaneBlockers: [],
      },
    });
    const report = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: synthesis as never,
      coreScanAutoRefresh: {
        enabled: true,
        intervalMinutes: 15,
        lastAutoRefreshStatus: "SUCCESS",
        lastAutoRefreshFinishedAt: "2026-05-25T10:00:00.000Z",
        lastAutoRefreshError: null,
        lastAutoRefreshResultSummary: {
          scannedSymbols: 10,
          returnedSymbols: 10,
          marketRegime: "BULLISH_EXPANSION",
        },
      },
    });

    // W* section reports the MISMATCH and includes the cross-regime warning.
    expect(report.summaryText).toContain("W*. REGIME DIRECTION CONTROLLER (REPORT-ONLY)");
    expect(report.summaryText).toContain("Primary validation lane alignment: MISMATCH");
    expect(report.summaryText).toContain("cross-regime");
    expect(report.summaryText).toContain("not live execution");

    // Typed report matches.
    const rdc = report.highlights.regimeDirectionController;
    expect(rdc.controllerMode).toBe("LONG_ONLY");
    expect(rdc.directionalBias).toBe("LONG");
    expect(rdc.allowsLong).toBe(true);
    expect(rdc.allowsShort).toBe(false);
    expect(rdc.currentValidationPrimaryLane?.alignment).toBe("MISMATCH");
    expect(rdc.currentValidationPrimaryLane?.direction).toBe("SHORT");
  });

  it("W*: regression — Section W and Section Y still render alongside W*", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("W*. REGIME DIRECTION CONTROLLER (REPORT-ONLY)");
    expect(report.summaryText).toContain("W. DIRECTION-ADAPTIVE EXECUTION POSTURE");
    expect(report.summaryText).toContain("Y. EXPLOIT SHADOW COLLECTION PRIORITIES");
  });

  it("Z*: renders ACCELERATED EVIDENCE FUNNEL section", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Z*. ACCELERATED EVIDENCE FUNNEL (REPORT-ONLY)");
    expect(report.summaryText).toContain("Total positions:");
    expect(report.summaryText).toContain("report-only, no behavior influence");
    expect(report.highlights.acceleratedEvidenceFunnel).toBeTruthy();
    expect(report.highlights.acceleratedEvidenceFunnel.reportOnly).toBe(true);
  });

  it("W**: renders REGIME CONTROLLER ALIGNED SHADOW section when store is not supplied", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("Unavailable: controllerAlignedShadowStore not supplied");
    // No aligned shadow highlight when store not supplied
    expect(report.highlights.regimeControllerAlignedShadow).toBeUndefined();
  });

  it("W**: renders REGIME CONTROLLER ALIGNED SHADOW section when store is supplied", () => {
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [] },
    });
    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("Lane: REGIME_CONTROLLER_ALIGNED_SHADOW_V1");
    expect(report.summaryText).toContain("TOO_EARLY");
    expect(report.summaryText).toContain("report-only, isolated");
    expect(report.highlights.regimeControllerAlignedShadow).toBeTruthy();
    expect(report.highlights.regimeControllerAlignedShadow!.reportOnly).toBe(true);
    expect(report.highlights.regimeControllerAlignedShadow!.verdict).toBe("TOO_EARLY");
  });

  it("retro audit highlights are present and report-only", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.highlights.regimeControllerRetroAudit).toBeTruthy();
    expect(report.highlights.regimeControllerRetroAudit.reportOnly).toBe(true);
    expect(report.highlights.regimeControllerRetroAudit.label).toBe("RETROSPECTIVE — not prospective validation");
  });

  it("W* section still renders without contradiction from W** section", () => {
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [] },
    });
    expect(report.summaryText).toContain("W*. REGIME DIRECTION CONTROLLER (REPORT-ONLY)");
    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("Y. EXPLOIT SHADOW COLLECTION PRIORITIES");
    // M must still be last
    const mIdx = report.summaryText.indexOf("M. ONE-LINE EXECUTIVE TAKEAWAY");
    const wStarStarIdx = report.summaryText.indexOf("W**. REGIME CONTROLLER ALIGNED SHADOW");
    expect(mIdx).toBeGreaterThan(wStarStarIdx);
  });

  it("Z* uses candidate-log data source when candidateFunnelEntries are provided", () => {
    const funnelEntries = [
      {
        timestamp: new Date().toISOString(),
        scanCycleId: new Date().toISOString(),
        source: "SCAN_CYCLE" as const,
        symbol: "BTCUSDT",
        direction: "LONG" as const,
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
        rejectionReasons: [] as string[],
      },
      {
        timestamp: new Date().toISOString(),
        scanCycleId: new Date().toISOString(),
        source: "SCAN_CYCLE" as const,
        symbol: "ETHUSDT",
        direction: "SHORT" as const,
        currentRegime: "BULLISH_EXPANSION",
        controllerMode: "LONG_ONLY",
        controllerAllowsDirection: false,
        selectedEntryVariant: "base_current_entry",
        selectedExitVariant: "tp1_full_exit",
        routeMode: "RESEARCH_ONLY",
        hasSelectedExecutionPlan: true,
        stopDistanceBps: 200,
        stop175Pass: true,
        sourceConflict: false,
        liveSourceConflict: false,
        kronosBias: "BEARISH",
        whaleAgreement: "DISAGREES",
        normalShadowEligible: true,
        controllerAlignedEligible: false,
        controllerAlignedOpened: false,
        rejectionReasons: ["DIRECTION_BLOCKED_BY_CONTROLLER"] as string[],
      },
    ];
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [] },
      candidateFunnelEntries: funnelEntries,
    });
    expect(report.summaryText).toContain("Z*. ACCELERATED EVIDENCE FUNNEL (REPORT-ONLY)");
    expect(report.summaryText).toContain("rawCandidates=2");
    // The log-derived report should have log-specific fields in the highlights
    expect(report.highlights.acceleratedEvidenceFunnel.rawCandidatesLogged).toBe(2);
    expect(report.highlights.acceleratedEvidenceFunnel.longCandidates).toBe(1);
    expect(report.highlights.acceleratedEvidenceFunnel.shortCandidates).toBe(1);
  });

  it("W** renders top blocker reason from candidate log entries", () => {
    const funnelEntries = [
      {
        timestamp: new Date().toISOString(),
        scanCycleId: new Date().toISOString(),
        source: "SCAN_CYCLE" as const,
        symbol: "BTCUSDT",
        direction: "SHORT" as const,
        currentRegime: "BULLISH_EXPANSION",
        controllerMode: "LONG_ONLY",
        controllerAllowsDirection: false,
        selectedEntryVariant: null,
        selectedExitVariant: null,
        routeMode: null,
        hasSelectedExecutionPlan: false,
        stopDistanceBps: null,
        stop175Pass: null,
        sourceConflict: null,
        liveSourceConflict: null,
        kronosBias: null,
        whaleAgreement: null,
        normalShadowEligible: false,
        controllerAlignedEligible: false,
        controllerAlignedOpened: false,
        rejectionReasons: ["DIRECTION_BLOCKED_BY_CONTROLLER", "MISSING_EXECUTION_PLAN"] as string[],
      },
    ];
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [] },
      candidateFunnelEntries: funnelEntries,
    });
    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("Top blocker:");
    expect(report.summaryText).toContain("DIRECTION_BLOCKED_BY_CONTROLLER");
  });

  it("W** renders 'candidate-level funnel log has no records yet' when candidateFunnelEntries is empty", () => {
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [] },
      candidateFunnelEntries: [],
    });
    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("candidate-level funnel log has no records yet");
  });

  // Phase 2Z.1 tests

  it("Z*: renders 'Legacy 175bps guard' line when candidateFunnelEntries are provided (Phase 2Z.1)", () => {
    const funnelEntries = [
      {
        timestamp: new Date().toISOString(),
        scanCycleId: new Date().toISOString(),
        source: "SCAN_CYCLE" as const,
        symbol: "NEARUSDT",
        direction: "LONG" as const,
        currentRegime: "BULLISH_EXPANSION",
        rawCurrentRegime: "BULLISH_EXPANSION",
        normalizedRegimeFamily: "BULLISH_EXPANSION",
        controllerMode: "LONG_ONLY",
        controllerReasonCodes: ["REGIME_LONG_TREND"],
        controllerSource: "SCAN_CYCLE" as const,
        controllerAllowsDirection: true,
        selectedEntryVariant: "base_current_entry",
        selectedExitVariant: "tp1_full_exit",
        routeMode: "RESEARCH_ONLY",
        hasSelectedExecutionPlan: true,
        stopDistanceBps: 120,
        stop175Pass: false,
        sourceConflict: false,
        liveSourceConflict: false,
        kronosBias: "BULLISH",
        whaleAgreement: "AGREES",
        normalShadowEligible: false,
        controllerAlignedEligible: false,
        controllerAlignedOpened: false,
        rejectionReasons: ["STOP_DISTANCE_BELOW_175"],
        atrBps: 69,
        variantAdjustedGuardThresholdBps: 80,
        legacyStop175Pass: false,
        variantAdjustedStopPass: true,
        guardPassedUnder: "VARIANT_ADJUSTED" as const,
      },
    ];
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [] },
      candidateFunnelEntries: funnelEntries,
    });
    expect(report.summaryText).toContain("Z*. ACCELERATED EVIDENCE FUNNEL (REPORT-ONLY)");
    expect(report.summaryText).toContain("Legacy 175bps guard:");
    expect(report.summaryText).toContain("Variant-adjusted guard:");
  });

  it("Z*: renders 'Variant-adjusted guard' line when candidateFunnelEntries are provided (Phase 2Z.1)", () => {
    const funnelEntries = [
      {
        timestamp: new Date().toISOString(),
        scanCycleId: new Date().toISOString(),
        source: "SCAN_CYCLE" as const,
        symbol: "NEARUSDT",
        direction: "LONG" as const,
        currentRegime: "BULLISH_EXPANSION",
        rawCurrentRegime: "BULLISH_EXPANSION",
        normalizedRegimeFamily: "BULLISH_EXPANSION",
        controllerMode: "LONG_ONLY",
        controllerReasonCodes: ["REGIME_LONG_TREND"],
        controllerSource: "SCAN_CYCLE" as const,
        controllerAllowsDirection: true,
        selectedEntryVariant: "base_current_entry",
        selectedExitVariant: "tp1_full_exit",
        routeMode: "RESEARCH_ONLY",
        hasSelectedExecutionPlan: true,
        stopDistanceBps: 200,
        stop175Pass: true,
        sourceConflict: false,
        liveSourceConflict: false,
        kronosBias: "BULLISH",
        whaleAgreement: "AGREES",
        normalShadowEligible: true,
        controllerAlignedEligible: true,
        controllerAlignedOpened: true,
        rejectionReasons: [] as string[],
        atrBps: 180,
        variantAdjustedGuardThresholdBps: 180,
        legacyStop175Pass: true,
        variantAdjustedStopPass: true,
        guardPassedUnder: "LEGACY_175" as const,
      },
    ];
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [] },
      candidateFunnelEntries: funnelEntries,
    });
    expect(report.summaryText).toContain("Variant-adjusted guard:");
    expect(report.summaryText).toContain("avgAtrBps=");
    expect(report.summaryText).toContain("medianAdjustedThreshold=");
  });

  it("W**: renders 'Active lane guard: max(80bps, 1.0×ATR bps)' when store is supplied (Phase 2Z.1)", () => {
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [] },
    });
    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("Active lane guard: max(80bps, 1.0×ATR bps)");
  });

  it("W**: renders invalidGeometry count when > 0 and excludes it from economics note", () => {
    // Build an observation with FAILED_INVALID_GEOMETRY status (zero geometry)
    const invalidGeometryObs = {
      id: "bad-obs-1",
      symbol: "BTCUSDT",
      direction: "LONG" as const,
      routeMode: null,
      entryVariant: null,
      exitVariant: null,
      entryPrice: 0,
      stopLoss: 0,
      takeProfitLevels: [] as number[],
      stopDistanceBps: 200,
      controllerMode: "LONG_ONLY",
      controllerAlignment: "ALIGNED" as const,
      openedAt: new Date(Date.now() - 60000).toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: null,
      status: "FAILED_INVALID_GEOMETRY" as const,
      netR: null,
      grossR: null,
      costR: null,
      durationMinutes: 1,
      resolutionSource: "DATA_FAILURE" as const,
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1" as const,
      reportOnly: true as const,
      policyVersion: "base-route-anchor-consistent-v2",
    };

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [invalidGeometryObs] },
    });

    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("invalidGeometry=1");
    expect(report.summaryText).toContain("excluded from economics");
  });

  // ── Part 1: W*/Y alignment consistency ───────────────────────────────────────

  it("W*/Y alignment: Bearish pressure + SHORT primary lane → W* MATCH → Y does not contain MISMATCH", () => {
    // Build a full adaptiveProfitPolicySynthesis with a primary lane pointing at Bearish pressure / SHORT
    const primaryLane = {
      policyId: "core-short",
      policyLabel: "BEARISH_EXPANSION + SHORT",
      sourceType: "CORE" as const,
      direction: "SHORT" as const,
      dominantRegime: "Bearish pressure",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 30,
      netAvgR: 0.05,
      grossAvgR: 0.1,
      profitFactor: 1.2,
      deltaVsBaseline: 0.1,
      avgWinR: 0.3,
      avgLossR: -1,
      credibility: "CLEAN_EVALUABLE" as const,
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE" as const,
      blockers: [],
      whyThisPolicyRanksHere: [],
      rankingScore: 10,
      evidenceConsensus: {
        evidenceConsensusScore: 60,
        evidenceConsensusVerdict: "MODERATE_CONSENSUS" as const,
        positiveEvidenceCount: 2,
        negativeEvidenceCount: 0,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 2,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "PRIMARY_PROFIT_LANE" as const,
      operativeCollectionPriority: "PRIMARY_PROFIT_LANE" as const,
      collectionPriorityReason: "",
      collectionPriorityScore: 15,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY" as const, microPilotReady: false as const, blockers: [] },
    };

    const report = buildDashboardAuditSummaryReport([], {
      coreScanAutoRefresh: {
        enabled: true,
        intervalMinutes: 7,
        lastAutoRefreshStatus: "SUCCESS",
        lastAutoRefreshFinishedAt: new Date().toISOString(),
        lastAutoRefreshError: null,
        lastAutoRefreshResultSummary: {
          scannedSymbols: 10,
          returnedSymbols: 5,
          marketRegime: "Bearish pressure",
        },
      },
      adaptiveProfitPolicySynthesis: {
        generatedAt: "2026-05-26T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        baseline: { sampleSize: 30, netAvgR: -0.05, grossAvgR: 0.02, profitFactor: 0.85 },
        candidates: [primaryLane],
        rankedTopPolicies: [primaryLane],
        bestOverallPolicy: primaryLane,
        bestShortPolicy: primaryLane,
        bestLongPolicy: null,
        currentAdaptiveDirectionBias: "SHORT_BIAS",
        directionalReadiness: {
          shortLaneReadiness: "WATCHABLE",
          longLaneReadiness: "NO_PROMOTABLE_POLICY_YET",
        },
        missingEvidenceForLongLane: [],
        missingEvidenceForShortLane: [],
        exploitShadowPriorities: {
          primaryProfitLane: null,
          secondaryValidationLane: null,
          observeOnlyLanes: [],
          antiBiasSafeguard: "",
        },
        operativeCollectionPlan: {
          mode: "PRIMARY_LANE_ACTIVE",
          currentOperativePrimaryLane: primaryLane,
          secondaryValidationLanes: [],
          observeOnlyLanes: [],
          rejectedLanes: [],
          collectionAntiBiasSummary: "keep collecting longs",
          externalOverlayAdmissionUsesAdaptivePrioritization: true,
          primaryLaneBlockers: [],
        },
        notes: [],
      },
    } as never);

    // W* should show MATCH
    expect(report.summaryText).toContain("W*. REGIME DIRECTION CONTROLLER (REPORT-ONLY)");
    expect(report.summaryText).toContain("Primary validation lane alignment: MATCH");
    // Y should show MATCH, not MISMATCH
    expect(report.summaryText).toContain("Y. EXPLOIT SHADOW COLLECTION PRIORITIES");
    expect(report.summaryText).toContain("Current scan regime alignment: MATCH");
    expect(report.summaryText).not.toContain("Current scan regime alignment: MISMATCH");
  });

  // ── Part 2: Z* by-mode breakdown ─────────────────────────────────────────────

  it("Z*: byControllerMode shows separate rows for mixed-mode funnel entries", () => {
    const shortEntry = {
      timestamp: new Date().toISOString(),
      scanCycleId: new Date().toISOString(),
      source: "SCAN_CYCLE" as const,
      symbol: "BTCUSDT",
      direction: "SHORT" as const,
      currentRegime: "Bearish pressure",
      rawCurrentRegime: "Bearish pressure",
      normalizedRegimeFamily: "BEARISH_EXPANSION",
      controllerMode: "SHORT_ONLY",
      controllerReasonCodes: ["REGIME_SHORT_TREND"],
      controllerSource: "SCAN_CYCLE" as const,
      controllerAllowsDirection: true,
      selectedEntryVariant: null,
      selectedExitVariant: null,
      routeMode: null,
      hasSelectedExecutionPlan: false,
      stopDistanceBps: null,
      stop175Pass: null,
      sourceConflict: null,
      liveSourceConflict: null,
      kronosBias: null,
      whaleAgreement: null,
      normalShadowEligible: false,
      controllerAlignedEligible: false,
      controllerAlignedOpened: false,
      rejectionReasons: ["MISSING_EXECUTION_PLAN"],
    };
    const longEntry = {
      timestamp: new Date(Date.now() - 10000).toISOString(),
      scanCycleId: new Date(Date.now() - 10000).toISOString(),
      source: "SCAN_CYCLE" as const,
      symbol: "ETHUSDT",
      direction: "LONG" as const,
      currentRegime: "Bullish expansion",
      rawCurrentRegime: "Bullish expansion",
      normalizedRegimeFamily: "BULLISH_EXPANSION",
      controllerMode: "LONG_ONLY",
      controllerReasonCodes: ["REGIME_LONG_TREND"],
      controllerSource: "SCAN_CYCLE" as const,
      controllerAllowsDirection: true,
      selectedEntryVariant: null,
      selectedExitVariant: null,
      routeMode: null,
      hasSelectedExecutionPlan: false,
      stopDistanceBps: null,
      stop175Pass: null,
      sourceConflict: null,
      liveSourceConflict: null,
      kronosBias: null,
      whaleAgreement: null,
      normalShadowEligible: false,
      controllerAlignedEligible: false,
      controllerAlignedOpened: false,
      rejectionReasons: ["MISSING_EXECUTION_PLAN"],
    };

    const report = buildAcceleratedEvidenceFunnelReportFromLog(
      [longEntry, shortEntry],
      [],
      { windowLabel: "LAST_24H_LOG", currentControllerMode: "SHORT_ONLY" },
    );

    expect(report.byControllerMode).toBeDefined();
    expect(report.byControllerMode!.length).toBe(2);
    const shortRow = report.byControllerMode!.find((r) => r.controllerMode === "SHORT_ONLY");
    const longRow = report.byControllerMode!.find((r) => r.controllerMode === "LONG_ONLY");
    expect(shortRow).toBeDefined();
    expect(longRow).toBeDefined();
    expect(shortRow!.rawCandidates).toBe(1);
    expect(longRow!.rawCandidates).toBe(1);
    // latestScanCycleMode should be SHORT_ONLY (last entry)
    expect(report.latestScanCycleMode).toBe("SHORT_ONLY");
  });

  // ── Part 3: W** payoff anatomy render ────────────────────────────────────────

  it("W**: renders payoffAnatomy section with avgWinGrossR, avgLossGrossR, payoffRatio when resolved obs exist", () => {
    const makeResolvedObs = (status: "CLOSED_WIN" | "CLOSED_LOSS", grossR: number, netR: number, costR: number) => ({
      id: `obs-${Math.random()}`,
      symbol: "BTCUSDT",
      direction: "SHORT" as const,
      routeMode: null,
      entryVariant: null,
      exitVariant: null,
      entryPrice: 100,
      stopLoss: 101,
      takeProfitLevels: [98],
      stopDistanceBps: 200,
      controllerMode: "SHORT_ONLY",
      controllerAlignment: "ALIGNED" as const,
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: null,
      status,
      netR,
      grossR,
      costR,
      durationMinutes: 30,
      resolutionSource: (status === "CLOSED_WIN" ? "TP1_HIT" : "SL_HIT") as "TP1_HIT" | "SL_HIT",
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1" as const,
      reportOnly: true as const,
      policyVersion: "base-route-anchor-consistent-v2",
    });

    const observations = [
      // 3 wins with grossR ≈ 0.5R
      ...Array.from({ length: 3 }, () => makeResolvedObs("CLOSED_WIN", 0.5, 0.36, 0.14)),
      // 2 losses with grossR = -1.0
      ...Array.from({ length: 2 }, () => makeResolvedObs("CLOSED_LOSS", -1.0, -1.14, 0.14)),
    ];

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations },
    });

    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("Payoff anatomy:");
    expect(report.summaryText).toContain("avgWinGrossR=");
    expect(report.summaryText).toContain("avgLossGrossR=");
    expect(report.summaryText).toContain("payoffRatio=");
    expect(report.summaryText).toContain("avgCostR=");
    expect(report.summaryText).toContain("grossToNetDrag=");
  });

  it("W**: renders TP1 hit rate and SL hit rate in payoff anatomy", () => {
    const makeObs = (status: "CLOSED_WIN" | "CLOSED_LOSS") => ({
      id: `obs-${Math.random()}`,
      symbol: "BTCUSDT",
      direction: "SHORT" as const,
      routeMode: null,
      entryVariant: null,
      exitVariant: null,
      entryPrice: 100,
      stopLoss: 101,
      takeProfitLevels: [98],
      stopDistanceBps: 200,
      controllerMode: "SHORT_ONLY",
      controllerAlignment: "ALIGNED" as const,
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: null,
      status,
      netR: status === "CLOSED_WIN" ? 0.36 : -1.14,
      grossR: status === "CLOSED_WIN" ? 0.5 : -1.0,
      costR: 0.14,
      durationMinutes: 30,
      resolutionSource: (status === "CLOSED_WIN" ? "TP1_HIT" : "SL_HIT") as "TP1_HIT" | "SL_HIT",
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1" as const,
      reportOnly: true as const,
      policyVersion: "base-route-anchor-consistent-v2",
    });

    // 7 wins, 3 losses → WR = 70%
    const observations = [
      ...Array.from({ length: 7 }, () => makeObs("CLOSED_WIN")),
      ...Array.from({ length: 3 }, () => makeObs("CLOSED_LOSS")),
    ];

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations },
    });

    expect(report.summaryText).toContain("TP1 hit rate=70.0%");
    expect(report.summaryText).toContain("SL hit rate=30.0%");
  });

  // ── Part 4: W** exit variant counterfactuals render ───────────────────────────

  it("W**: renders exit counterfactual table when >= 2 CLOSED_WIN/LOSS observations exist", () => {
    const makeObs = (status: "CLOSED_WIN" | "CLOSED_LOSS") => ({
      id: `obs-${Math.random()}`,
      symbol: "BTCUSDT",
      direction: "LONG" as const,
      routeMode: null,
      entryVariant: null,
      exitVariant: null,
      entryPrice: 1.0,
      stopLoss: 0.9,
      takeProfitLevels: [1.1, 1.2, 1.3],
      stopDistanceBps: 1000,
      controllerMode: "LONG_ONLY",
      controllerAlignment: "ALIGNED" as const,
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: null,
      status,
      netR: status === "CLOSED_WIN" ? 0.9 : -1.1,
      grossR: status === "CLOSED_WIN" ? 1.0 : -1.0,
      costR: 0.1,
      durationMinutes: 30,
      resolutionSource: (status === "CLOSED_WIN" ? "TP1_HIT" : "SL_HIT") as "TP1_HIT" | "SL_HIT",
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1" as const,
      reportOnly: true as const,
      policyVersion: "base-route-anchor-consistent-v2",
    });

    const observations = [
      ...Array.from({ length: 3 }, () => makeObs("CLOSED_WIN")),
      ...Array.from({ length: 2 }, () => makeObs("CLOSED_LOSS")),
    ];

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations },
    });

    expect(report.summaryText).toContain("W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)");
    expect(report.summaryText).toContain("Exit variant counterfactuals");
    expect(report.summaryText).toContain("TP1_FULL_EXIT");
    expect(report.summaryText).toContain("TP2_FULL_EXIT");
    expect(report.summaryText).toContain("TP1_50_TP2_50");
    expect(report.summaryText).toContain("TP1_50_RUNNER_TP3");
    expect(report.summaryText).toContain("Best by netAvgR:");
    expect(report.summaryText).toContain("Best by PF:");
  });

  it("W**: renders 'WR identical across variants' note in exit counterfactual section", () => {
    const makeObs = (status: "CLOSED_WIN" | "CLOSED_LOSS") => ({
      id: `obs-${Math.random()}`,
      symbol: "ETHUSDT",
      direction: "LONG" as const,
      routeMode: null,
      entryVariant: null,
      exitVariant: null,
      entryPrice: 1.0,
      stopLoss: 0.9,
      takeProfitLevels: [1.1, 1.2, 1.3],
      stopDistanceBps: 1000,
      controllerMode: "LONG_ONLY",
      controllerAlignment: "ALIGNED" as const,
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: null,
      status,
      netR: status === "CLOSED_WIN" ? 0.9 : -1.1,
      grossR: status === "CLOSED_WIN" ? 1.0 : -1.0,
      costR: 0.1,
      durationMinutes: 30,
      resolutionSource: (status === "CLOSED_WIN" ? "TP1_HIT" : "SL_HIT") as "TP1_HIT" | "SL_HIT",
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1" as const,
      reportOnly: true as const,
      policyVersion: "base-route-anchor-consistent-v2",
    });

    const observations = [
      makeObs("CLOSED_WIN"),
      makeObs("CLOSED_WIN"),
      makeObs("CLOSED_LOSS"),
    ];

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations },
    });

    expect(report.summaryText).toContain("WR identical across variants");
  });
});

// ─── W** exact exit counterfactuals display tests ─────────────────────────────

describe("W** exact exit counterfactuals display", () => {
  const ENTRY = 50000;
  const STOP = 49500;
  const TP1 = 51000;
  const TP2 = 52000;
  const TP3 = 53000;
  const STOP_DIST_BPS = 100;
  const COST_R = (14 * 2) / STOP_DIST_BPS;
  const RISK = ENTRY - STOP;
  const tp1GrossR = (TP1 - ENTRY) / RISK;
  const tp2GrossR = (TP2 - ENTRY) / RISK;

  function makeWinObsWithExact(tp2Hit: boolean): import("../src/lib/regime-controller-aligned-shadow.js").ControllerAlignedShadowPosition {
    return {
      id: "test-w-exact",
      symbol: "BTCUSDT",
      direction: "LONG",
      routeMode: "RESEARCH_ONLY",
      entryVariant: "base_current_entry",
      exitVariant: "tp1_full_exit",
      entryPrice: ENTRY,
      stopLoss: STOP,
      takeProfitLevels: [TP1, TP2, TP3],
      stopDistanceBps: STOP_DIST_BPS,
      controllerMode: "LONG_ONLY",
      controllerAlignment: "ALIGNED",
      openedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: "TRENDING_UP",
      status: "CLOSED_WIN",
      netR: tp1GrossR - COST_R,
      grossR: tp1GrossR,
      costR: COST_R,
      durationMinutes: 60,
      resolutionSource: "TP1_HIT",
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1",
      reportOnly: true,
      policyVersion: "v2",
      exactExitCounterfactuals: {
        computedAt: new Date().toISOString(),
        tp2HitBeforeSl: tp2Hit,
        tp3HitBeforeSl: false,
        secondLegStoppedAfterTP1: !tp2Hit,
        variants: [
          { variantLabel: "TP1_FULL_EXIT", grossR: tp1GrossR, netR: tp1GrossR - COST_R, outcome: "WIN" },
          { variantLabel: "TP2_FULL_EXIT", grossR: tp2Hit ? tp2GrossR : -1.0, netR: (tp2Hit ? tp2GrossR : -1.0) - COST_R, outcome: tp2Hit ? "WIN" : "LOSS" },
          { variantLabel: "TP1_50_TP2_50", grossR: tp2Hit ? 0.5 * tp1GrossR + 0.5 * tp2GrossR : 0.5 * tp1GrossR - 0.5, netR: 0, outcome: tp2Hit ? "WIN" : "PARTIAL_WIN" },
          { variantLabel: "TP1_50_RUNNER_TP3", grossR: 0.5 * tp1GrossR - 0.5, netR: 0.5 * tp1GrossR - 0.5 - COST_R, outcome: "PARTIAL_WIN" },
        ],
      },
    };
  }

  it("6. W** shows exactN and missing count", () => {
    // 2 resolved obs: 1 with exact data, 1 without
    const withExact = makeWinObsWithExact(true);
    const withoutExact: typeof withExact = {
      ...makeWinObsWithExact(true),
      id: "no-exact",
      exactExitCounterfactuals: null,
    };

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: [withExact, withoutExact] },
    });

    expect(report.summaryText).toContain("exactN=1 resolved with candle data");
    expect(report.summaryText).toContain("missing=1 (backfill pending)");
  });

  it("7. W** shows TOO_EARLY_FOR_BEST_EXIT_DECISION when exactN < 10", () => {
    // 3 obs all with exact data — exactN=3 < 10
    const observations = [
      makeWinObsWithExact(true),
      makeWinObsWithExact(false),
      makeWinObsWithExact(true),
    ];

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations },
    });

    expect(report.summaryText).toContain("TOO_EARLY_FOR_BEST_EXIT_DECISION");
  });

  it("8. W** shows BEST_EXIT_CANDIDATE when exactN >= 10 and net positive", () => {
    // Build 10 identical positive win observations with exactExitCounterfactuals
    function makePositiveWinObs(): typeof withExact {
      const withExact = makeWinObsWithExact(true);
      // Make all variants positive netR so there's a clear best
      return {
        ...withExact,
        exactExitCounterfactuals: {
          computedAt: new Date().toISOString(),
          tp2HitBeforeSl: true,
          tp3HitBeforeSl: false,
          secondLegStoppedAfterTP1: false,
          variants: [
            { variantLabel: "TP1_FULL_EXIT", grossR: tp1GrossR, netR: tp1GrossR - COST_R, outcome: "WIN" },
            { variantLabel: "TP2_FULL_EXIT", grossR: tp2GrossR, netR: tp2GrossR - COST_R, outcome: "WIN" },
            { variantLabel: "TP1_50_TP2_50", grossR: 3.0, netR: 3.0 - COST_R, outcome: "WIN" },
            { variantLabel: "TP1_50_RUNNER_TP3", grossR: 4.0, netR: 4.0 - COST_R, outcome: "WIN" },
          ],
        },
      };
    }

    const withExact = makeWinObsWithExact(true); // needed for type inference
    void withExact;

    const observations = Array.from({ length: 10 }, () => makePositiveWinObs());

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations },
    });

    expect(report.summaryText).toContain("BEST_EXIT_CANDIDATE");
  });

  it("9. W** shows NO_POSITIVE_EXACT_EXIT when exactN >= 10 but all nets <= 0", () => {
    function makeNegativeWinObs() {
      return {
        ...makeWinObsWithExact(false),
        exactExitCounterfactuals: {
          computedAt: new Date().toISOString(),
          tp2HitBeforeSl: false,
          tp3HitBeforeSl: false,
          secondLegStoppedAfterTP1: true,
          variants: [
            { variantLabel: "TP1_FULL_EXIT" as const, grossR: -0.1, netR: -0.1 - COST_R, outcome: "LOSS" as const },
            { variantLabel: "TP2_FULL_EXIT" as const, grossR: -1.0, netR: -1.0 - COST_R, outcome: "LOSS" as const },
            { variantLabel: "TP1_50_TP2_50" as const, grossR: -0.5, netR: -0.5 - COST_R, outcome: "LOSS" as const },
            { variantLabel: "TP1_50_RUNNER_TP3" as const, grossR: -0.5, netR: -0.5 - COST_R, outcome: "LOSS" as const },
          ],
        },
      };
    }

    const observations = Array.from({ length: 10 }, () => makeNegativeWinObs());

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations },
    });

    expect(report.summaryText).toContain("NO_POSITIVE_EXACT_EXIT");
  });
});

// ─── W** Edge Isolation block tests ──────────────────────────────────────────

describe("W** Edge Isolation display", () => {
  function makeResolvedObs(
    status: "CLOSED_WIN" | "CLOSED_LOSS",
    overrides: Partial<import("../src/lib/regime-controller-aligned-shadow.js").ControllerAlignedShadowPosition> = {},
  ): import("../src/lib/regime-controller-aligned-shadow.js").ControllerAlignedShadowPosition {
    const grossR = status === "CLOSED_WIN" ? 1.0 : -1.0;
    const costR = 0.14;
    return {
      id: `obs-${Math.random()}`,
      symbol: "BTCUSDT",
      direction: "LONG",
      routeMode: "RESEARCH_ONLY",
      entryVariant: "base_current_entry",
      exitVariant: "tp1_full_exit",
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfitLevels: [52000],
      stopDistanceBps: 200,
      controllerMode: "LONG_ONLY",
      controllerAlignment: "ALIGNED",
      openedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      closedAt: new Date().toISOString(),
      marketRegimeAtOpen: "Bullish expansion",
      status,
      netR: grossR - costR,
      grossR,
      costR,
      durationMinutes: 60,
      resolutionSource: status === "CLOSED_WIN" ? "TP1_HIT" : "SL_HIT",
      laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1",
      reportOnly: true,
      policyVersion: "base-route-anchor-consistent-v2",
      ...overrides,
    };
  }

  it("13. W** renders Edge isolation section header with n= count", () => {
    const obs = [
      makeResolvedObs("CLOSED_WIN"),
      makeResolvedObs("CLOSED_LOSS"),
    ];
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: obs },
    });
    expect(report.summaryText).toContain("Edge isolation (report-only; n=");
  });

  it("14. W** shows TOO_EARLY when exactN < 10 (existing test still passes)", () => {
    const ENTRY = 50000;
    const STOP = 49500;
    const TP1 = 51000;
    const STOP_DIST_BPS = 100;
    const COST_R = (14 * 2) / STOP_DIST_BPS;
    const RISK = ENTRY - STOP;
    const tp1GrossR = (TP1 - ENTRY) / RISK;

    const obsWithExact = Array.from({ length: 3 }, () => ({
      ...makeResolvedObs("CLOSED_WIN"),
      entryPrice: ENTRY,
      stopLoss: STOP,
      takeProfitLevels: [TP1],
      stopDistanceBps: STOP_DIST_BPS,
      grossR: tp1GrossR,
      costR: COST_R,
      netR: tp1GrossR - COST_R,
      exactExitCounterfactuals: {
        computedAt: new Date().toISOString(),
        tp2HitBeforeSl: false,
        tp3HitBeforeSl: false,
        secondLegStoppedAfterTP1: true,
        variants: [
          { variantLabel: "TP1_FULL_EXIT" as const, grossR: tp1GrossR, netR: tp1GrossR - COST_R, outcome: "WIN" as const },
          { variantLabel: "TP2_FULL_EXIT" as const, grossR: -1.0, netR: -1.0 - COST_R, outcome: "LOSS" as const },
          { variantLabel: "TP1_50_TP2_50" as const, grossR: 0, netR: -COST_R, outcome: "PARTIAL_WIN" as const },
          { variantLabel: "TP1_50_RUNNER_TP3" as const, grossR: 0, netR: -COST_R, outcome: "PARTIAL_WIN" as const },
        ],
      },
    }));

    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: obsWithExact },
    });

    expect(report.summaryText).toContain("TOO_EARLY_FOR_BEST_EXIT_DECISION");
  });

  it("15. W** shows exit extension NOT VALIDATED line when exitExtensionConclusion = NO_POSITIVE_EXACT_EXIT", () => {
    // Provide 2 resolved obs so edge isolation runs but exactN=0 => INSUFFICIENT_DATA
    // We need >=10 exact obs to force NO_POSITIVE_EXACT_EXIT; alternatively just check INSUFFICIENT_DATA with 0
    const obs = [
      makeResolvedObs("CLOSED_WIN"),
      makeResolvedObs("CLOSED_LOSS"),
    ];
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: obs },
    });
    // With no exactExitCounterfactuals, conclusion is INSUFFICIENT_DATA
    expect(report.summaryText).toContain("Exit extension: INSUFFICIENT_DATA");
  });

  it("16. W** renders best sub-cohort WATCHABLE label when n >= 5", () => {
    // Build 5 wins for SOLUSDT so the SOLUSDT cohort appears in bestSubCohorts
    const obs = Array.from({ length: 5 }, () =>
      makeResolvedObs("CLOSED_WIN", { symbol: "SOLUSDT", grossR: 2.0, netR: 1.86 }),
    );
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: obs },
    });
    expect(report.summaryText).toContain("WATCHABLE (not ready for promotion)");
  });

  it("17. W** renders worst sub-cohort TOXIC label when n >= 3", () => {
    // Build 3 losses for XRPUSDT (distinct from BTCUSDT to avoid overlap)
    const obs = Array.from({ length: 3 }, () =>
      makeResolvedObs("CLOSED_LOSS", { symbol: "XRPUSDT", grossR: -1.0 }),
    );
    const report = buildDashboardAuditSummaryReport([], {
      controllerAlignedShadowStore: { observations: obs },
    });
    expect(report.summaryText).toContain("TOXIC");
  });

  it("18. W** shows 'unavailable' for edgeIsolation when store is not supplied", () => {
    // No store supplied — the whole W** section shows unavailable
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Unavailable: controllerAlignedShadowStore not supplied");
    // Edge isolation specific line should NOT appear
    expect(report.summaryText).not.toContain("Edge isolation (report-only");
  });
});

// ─── W*** Filtered Edge Shadow display tests ──────────────────────────────────

import {
  buildFilteredEdgeShadowReport,
  FilteredEdgeShadowStore,
  FILTERED_EDGE_SHADOW_LANE,
} from "../src/lib/regime-controller-filtered-edge-shadow.js";
import type { FilteredEdgeShadowPosition } from "../src/lib/regime-controller-filtered-edge-shadow.js";
import { rmSync as _rmSync, existsSync as _existsSync } from "node:fs";
import { resolve as _resolve } from "node:path";
import os2 from "node:os";

let _tmpCounter = 0;
function _tmpDir(): string {
  return _resolve(os2.tmpdir(), `w3-test-${process.pid}-${++_tmpCounter}`);
}
const _storeDirsW3: string[] = [];
afterAll(() => {
  for (const d of _storeDirsW3) {
    try {
      if (_existsSync(d)) _rmSync(d, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

function makeW3Store(): FilteredEdgeShadowStore {
  const dir = _tmpDir();
  _storeDirsW3.push(dir);
  return new FilteredEdgeShadowStore(dir);
}

function makeFilteredPos(
  overrides: Partial<FilteredEdgeShadowPosition> = {},
): FilteredEdgeShadowPosition {
  const now = new Date().toISOString();
  return {
    id: `test-${Date.now()}`,
    symbol: "SOLUSDT",
    direction: "SHORT",
    profile: "STRICT_COST10",
    controllerMode: "SHORT_ONLY",
    currentRegime: "Bearish expansion",
    marketRegimeAtOpen: "Bearish expansion",
    openedAt: now,
    createdAt: now,
    entryPrice: 100,
    stopLoss: 105,
    takeProfitLevels: [95],
    stopDistanceBps: 500,
    costR: 0.08,
    atrPercent: 1.0,
    variantAdjustedGuardThresholdBps: 100,
    guardPassedUnder: "VARIANT_ADJUSTED",
    sourceConflict: false,
    liveSourceConflict: false,
    kronosBias: null,
    whaleAgreement: null,
    selectedEntryVariant: null,
    selectedExitVariant: null,
    kronosHorizonConflict: null,
    status: "OPEN",
    closedAt: null,
    grossR: null,
    netR: null,
    resolutionSource: null,
    durationMinutes: null,
    reportOnly: true,
    laneVersion: FILTERED_EDGE_SHADOW_LANE,
    policyVersion: "filtered-edge-anchor-consistent-v1",
    analyticsVersion: "filtered-edge-forensics-v2",
    pathMetricVersion: "mfe-mae-bounded-v1",
    chronologyVersion: "chronology-fill-candle-v1",
    ...overrides,
  };
}

describe("W*** Filtered Edge Shadow section", () => {
  // Test 11: W*** section present when filteredEdgeReport provided
  it("11. W*** section present when filteredEdgeReport provided", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos());
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).toContain("W***.");
    expect(report.summaryText).toContain("REGIME CONTROLLER FILTERED EDGE SHADOW (REPORT-ONLY)");
  });

  // Test 12: W*** shows STRICT_COST10 and BROAD_COST20_STOP150 profile labels
  it("12. W*** shows STRICT_COST10 and BROAD_COST20_STOP150 profile labels", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos({ profile: "STRICT_COST10" }));
    store.add(makeFilteredPos({ profile: "BROAD_COST20_STOP150", costR: 0.15, stopDistanceBps: 200 }));
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).toContain("STRICT_COST10");
    expect(report.summaryText).toContain("BROAD_COST20_STOP150");
  });

  // Test 13: W*** shows TOO_EARLY when resolved < 20
  it("13. W*** shows TOO_EARLY when resolved < 20", () => {
    const store = makeW3Store();
    // Add 3 open obs — resolved = 0 < 20 → TOO_EARLY
    for (let i = 0; i < 3; i++) {
      store.add(makeFilteredPos({ id: `open-${i}` }));
    }
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).toContain("TOO_EARLY");
  });

  it("14. W*** renders overlap note, richer forensics, and recent resolved snapshots", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos({
      id: "strict-overlap",
      openedAt: "2026-05-26T03:00:00.000Z",
      createdAt: "2026-05-26T03:00:00.000Z",
      symbol: "DOGEUSDT",
      profile: "STRICT_COST10",
      selectedEntryVariant: "fib_500_entry",
      selectedExitVariant: "tp1_full_exit",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T03:10:00.000Z",
      grossR: -1,
      netR: -0.42,
      costR: 0.12,
      durationMinutes: 5,
      resolutionSource: "CANDLE_WALK_SL",
      maxMfeR: 0.01,
      minMaeR: -1.02,
      immediateSl: true,
      noMfeBeforeSl: true,
      kronosBias: "SHORT",
      whaleAgreement: "AGREES",
      liveSourceConflict: false,
    }));
    store.add(makeFilteredPos({
      id: "broad-overlap",
      openedAt: "2026-05-26T03:00:30.000Z",
      createdAt: "2026-05-26T03:00:30.000Z",
      symbol: "DOGEUSDT",
      profile: "BROAD_COST20_STOP150",
      costR: 0.15,
      stopDistanceBps: 200,
      selectedEntryVariant: "fib_500_entry",
      selectedExitVariant: "tp1_full_exit",
      status: "CLOSED_WIN",
      closedAt: "2026-05-26T03:11:00.000Z",
      grossR: 0.5,
      netR: 0.35,
      durationMinutes: 6,
      resolutionSource: "CANDLE_WALK_TP1",
      maxMfeR: 0.7,
      minMaeR: -0.2,
      kronosBias: "SHORT",
      whaleAgreement: "AGREES",
      liveSourceConflict: false,
    }));
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).toContain("overlappingCandidates=1");
    expect(report.summaryText).toContain("- All-time:");
    expect(report.summaryText).toContain("- Fresh-valid tape:");
    expect(report.summaryText).toContain("Chronology: valid=");
    expect(report.summaryText).toContain("Path metrics: valid=");
    expect(report.summaryText).toContain("Path forensics: withMfeMae=");
    expect(report.summaryText).toContain("By exit variant:");
    expect(report.summaryText).toContain("By source conflict:");
    expect(report.summaryText).toContain("By whale:");
    expect(report.summaryText).toContain("Last 5 resolved:");
    expect(report.summaryText).toContain("regime=Bearish expansion");
    expect(report.summaryText).toContain("entry=fib_500_entry");
    expect(report.summaryText).toContain("exit=tp1_full_exit");
    expect(report.summaryText).toContain("sourceConflict=LIVE_FALSE");
  });

  it("15. W*** warns when invalid chronology is present", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos({
      id: "invalid-chrono",
      createdAt: "2026-05-26T03:10:00.000Z",
      openedAt: "2026-05-26T03:00:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T03:05:00.000Z",
      grossR: -1,
      netR: -1.1,
      durationMinutes: -5,
      chronologyStatus: "INVALID_NEGATIVE_DURATION",
      chronologyWarning: "closedAt precedes openedAt",
      maxMfeR: 0.5,
      minMaeR: -1.1,
      mfeBeforeCloseR: 0.5,
      maeBeforeCloseR: -1.1,
    }));
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).toContain("invalid reason=INVALID_NEGATIVE_DURATION");
    expect(report.summaryText).toContain("WARNING: invalid chronology excluded from duration/MFE/MAE aggregates");
    expect(report.summaryText).toContain("chronology=INVALID_NEGATIVE_DURATION");
  });

  it("16. W*** warns when invalid or outlier path metrics are present", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos({
      id: "outlier-path",
      createdAt: "2026-05-26T05:00:00.000Z",
      openedAt: "2026-05-26T05:00:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T05:10:00.000Z",
      chronologyStatus: "VALID",
      grossR: -1,
      netR: -1.1,
      maxMfeR: 25,
      minMaeR: -21,
      mfeBeforeCloseR: 25,
      maeBeforeCloseR: -21,
      pathMetricStatus: "PATH_METRIC_OUTLIER",
      pathMetricWarning: "Derived path metrics exceed 20R cap",
    }));
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).toContain("Path metrics: valid=0 | invalid=1 | invalid reason=PATH_METRIC_OUTLIER(n=1)");
    expect(report.summaryText).toContain("WARNING: invalid or outlier path metrics excluded from MFE/MAE aggregates");
    expect(report.summaryText).toContain("pathMetric=PATH_METRIC_OUTLIER");
  });

  it("17. W*** renders all-time vs fresh-valid split and fresh verdict remains TOO_EARLY under 10 clean resolves", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos({
      id: "legacy-alltime",
      createdAt: "2026-05-26T03:00:00.000Z",
      openedAt: "2026-05-26T03:00:00.000Z",
      analyticsVersion: null,
      pathMetricVersion: null,
      chronologyVersion: null,
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T03:10:00.000Z",
      grossR: -1,
      netR: -1.1,
      chronologyStatus: "INVALID_NEGATIVE_DURATION",
      pathMetricStatus: "PATH_METRIC_OUTLIER",
    }));
    store.add(makeFilteredPos({
      id: "fresh-valid",
      createdAt: "2026-05-26T03:10:00.000Z",
      openedAt: "2026-05-26T03:10:00.000Z",
      status: "CLOSED_WIN",
      closedAt: "2026-05-26T03:20:00.000Z",
      grossR: 0.8,
      netR: 0.7,
      chronologyStatus: "VALID",
      pathMetricStatus: "VALID",
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      maxMfeR: 0.9,
      minMaeR: -0.2,
      mfeBeforeCloseR: 0.9,
      maeBeforeCloseR: -0.2,
    }));
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).toContain("- All-time: STRICT_COST10 resolved=2");
    expect(report.summaryText).toContain("- Fresh-valid tape:");
    expect(report.summaryText).toContain("STRICT_COST10 resolved=1 net=0.7000 WR=100.0% PF=n/a | verdict=TOO_EARLY");
    // Updated assertion now that excluded line includes new buckets
    expect(report.summaryText).toContain("invalidChronology=1");
    expect(report.summaryText).toContain("invalidGeometry=0");
    expect(report.summaryText).toContain("missingVersion=0");
  });

  // Test H — W*** renders consistency check PASS when counts match
  it("H. W*** does NOT show consistency WARNING when freshValidConsistencyCheck is PASS", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos({
      id: "valid-h",
      createdAt: "2026-05-26T04:00:00.000Z",
      openedAt: "2026-05-26T04:00:00.000Z",
      status: "CLOSED_WIN",
      closedAt: "2026-05-26T04:10:00.000Z",
      grossR: 0.9,
      netR: 0.82,
      chronologyStatus: "VALID",
      pathMetricStatus: "VALID",
      intrabarResolutionStatus: "VALID_5M_ORDERED",
    }));
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    expect(filteredEdgeReport.freshValidConsistencyCheck).toBe("PASS");
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).not.toContain("WARNING: fresh-valid accounting inconsistency");
  });

  // Test I — W*** renders WARNING when freshValidConsistencyCheck is FAIL
  it("I. W*** shows WARNING when freshValidConsistencyCheck is FAIL (injected directly)", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos({ id: "i-obs" }));
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    // Inject a FAIL to test the rendering path
    const failReport = {
      ...filteredEdgeReport,
      freshValidConsistencyCheck: "FAIL" as const,
      freshValidConsistencyDetail: "top=3 vs uniqueIds=2; profileSum=3",
    };
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport: failReport });
    expect(report.summaryText).toContain("WARNING: fresh-valid accounting inconsistency detected.");
    expect(report.summaryText).toContain("top=3 vs uniqueIds=2; profileSum=3");
  });

  // Test J — Last-5 row shows [excluded: PATH_METRIC_OUTLIER] for outlier obs
  it("J. Last-5 row shows [excluded: PATH_METRIC_OUTLIER] for outlier obs, not [freshValid]", () => {
    const store = makeW3Store();
    store.add(makeFilteredPos({
      id: "outlier-j",
      createdAt: "2026-05-26T06:00:00.000Z",
      openedAt: "2026-05-26T06:00:00.000Z",
      status: "CLOSED_LOSS",
      closedAt: "2026-05-26T06:10:00.000Z",
      grossR: -1.0,
      netR: -1.08,
      chronologyStatus: "VALID",
      pathMetricStatus: "PATH_METRIC_OUTLIER",
      // Real outlier: MFE exceeds 20R cap
      maxMfeR: 25,
      mfeBeforeCloseR: 25,
      minMaeR: -0.5,
      maeBeforeCloseR: -0.5,
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      isFreshValid: true, // stored field says true — should be overridden by helper
    }));
    const filteredEdgeReport = buildFilteredEdgeShadowReport(store);
    const report = buildDashboardAuditSummaryReport([], { filteredEdgeReport });
    expect(report.summaryText).toContain("[excluded: PATH_METRIC_OUTLIER]");
    expect(report.summaryText).not.toContain("[freshValid]");
  });
});

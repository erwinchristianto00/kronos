import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedState = vi.hoisted(() => ({
  strategyExperienceRecords: [] as unknown[],
  foundationReport: {} as Record<string, unknown>,
}));

const liveReadinessState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const routeMaturityState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const regimeDriftState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const profitAnatomyState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const stopGeometryState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const winnerLoserState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const symbolRouteState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const adaptiveGateState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const counterfactualState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

const overlayState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
}));

vi.mock("@dtc/shared", () => ({
  buildStrategyExperienceRecords: () => sharedState.strategyExperienceRecords,
  buildStrategyIntelligenceFoundationReport: () => sharedState.foundationReport,
  classifyEvidenceEra: () => "POST_CALIBRATION",
}));

vi.mock("../src/lib/live-readiness.js", () => ({
  buildLiveReadinessReport: () => liveReadinessState.report,
}));

vi.mock("../src/lib/route-maturity.js", () => ({
  buildRouteMaturityReport: () => routeMaturityState.report,
}));

vi.mock("../src/lib/regime-drift.js", () => ({
  buildRegimeDriftReport: () => regimeDriftState.report,
}));

vi.mock("../src/lib/profit-anatomy.js", () => ({
  buildProfitAnatomyReport: () => profitAnatomyState.report,
}));

vi.mock("../src/lib/stop-geometry-audit.js", () => ({
  buildStopGeometryAuditReport: () => stopGeometryState.report,
}));

vi.mock("../src/lib/winner-loser-audit.js", () => ({
  buildWinnerLoserAuditReport: () => winnerLoserState.report,
}));

vi.mock("../src/lib/symbol-route-suitability.js", () => ({
  buildSymbolRouteSuitabilityReport: () => symbolRouteState.report,
}));

vi.mock("../src/lib/adaptive-gate-intelligence.js", () => ({
  buildAdaptiveGateIntelligenceReport: () => adaptiveGateState.report,
}));

vi.mock("../src/lib/regime-policy-counterfactual.js", () => ({
  buildRegimePolicyCounterfactualReport: () => counterfactualState.report,
}));

vi.mock("../src/lib/adaptive-gate-overlay-performance.js", () => ({
  buildAdaptiveRegimeGateOverlayPerformanceReport: () => overlayState.report,
}));

import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";

describe("dashboard audit summary formatting", () => {
  beforeEach(() => {
    sharedState.strategyExperienceRecords = [];
    sharedState.foundationReport = {
      metadata: {
        contextSnapshotCount: 253,
        resolvedExperienceRecordCount: 199,
      },
      missingFieldAudit: {
        completeness: {
          trend5m: 0.6,
          trend15m: 0.65,
          trend1h: 0.7,
          marketRegime: 1,
          maxFavorableExcursionR: 0.12,
          maxAdverseExcursionR: 0.12,
          selectedKronosBias: 0.08,
          whaleAgreement: 0.04,
          sentimentBucket: 0,
          fearGreedValue: 0,
          fearGreedBucket: 0,
        },
      },
      dataReadiness: {
        readyForSymbolRouteEngine: false,
        readyForAdaptiveGateController: false,
        readyForTechnicalStopTpEngine: false,
        readyForUniverseRotation: false,
        symbolRouteEngine: { reasonsBlocking: ["pairs with >=15 closes = 0"] },
        adaptiveGateController: { reasonsBlocking: ["forward resolved external-context coverage still sparse"] },
        technicalStopTpEngine: { reasonsBlocking: ["MAE/MFE coverage below readiness threshold"] },
        universeRotation: { reasonsBlocking: ["no sufficiently mature symbol-route cohorts yet"] },
      },
    };

    liveReadinessState.report = {
      score: 30,
      liveReady: false,
      lockedEvaluationRoute: { label: "fib_500_entry + tp1_full_exit" },
      leadingMaturityCohort: { label: "vwap_retest_entry + tp1_full_exit" },
      routeAlignmentStatus: "MISMATCH",
      failedGates: ["CLOSED_SAMPLE_SUFFICIENT", "NET_AVG_R_POSITIVE"],
    };

    routeMaturityState.report = {
      leadingCohort: { entryVariant: "vwap_retest_entry", exitVariant: "tp1_full_exit" },
      cohorts: [{
        entryVariant: "vwap_retest_entry",
        exitVariant: "tp1_full_exit",
        closedCount: 82,
        netAvgR: -0.4918,
        grossAvgR: -0.1442,
        profitFactor: 0.2602,
        profitableTp1Rate: 0.7451,
        slRate: 0.378,
        maturityStatus: "WEAK",
      }],
    };

    regimeDriftState.report = { overallStatus: "STABLE" };

    profitAnatomyState.report = {
      summary: {
        mainDiagnosis: "Primary leaks: cost drag and oversized losses.",
        avgWinR: 0.37,
        avgLossR: -1.23,
        expectancyGap: 0.34,
      },
      anatomyFlags: [{ message: "Cost drag is compounding." }],
    };

    stopGeometryState.report = {
      summary: { mainDiagnosis: "STOP_AND_RR_COMBINED_LEAK" },
      stopBuckets: [
        { bucket: "ULTRA_TIGHT", closedCount: 12, netAvgR: -1.8689, slRate: 0.8421 },
        { bucket: "MODERATE", closedCount: 8, netAvgR: -0.1, slRate: 0.4 },
      ],
      counterfactuals: [
        { label: "Exclude tight stops (< 175 bps)", interpretation: "STRONGLY_IMPROVES", deltaNetAvgRVsBaseline: 0.5923 },
      ],
    };

    winnerLoserState.report = {
      summary: { mainDiagnosis: "FEATURE_SEPARATION_EMERGING" },
      topWinnerSignals: [
        { feature: "horizonConflict=false", observedPattern: "Winners: 97% vs losers: 61%" },
        { feature: "entryPlaybook", observedPattern: "Winners: \"RETRACE_REJECTION\" 87% vs losers: \"RETRACE_REJECTION\" 43%" },
      ],
      topLoserSignals: [
        { feature: "direction", observedPattern: "Losers: \"LONG\" 57% vs winners: \"LONG\" 13%" },
        { feature: "highChaseRisk=false", observedPattern: "Losers: 18% vs winners: 0%" },
      ],
    };

    symbolRouteState.report = {
      metadata: {
        resolvedExperienceRecordCount: 76,
        pairsWithAtLeast5Closes: 7,
        pairsWithAtLeast15Closes: 0,
        pairsWithAtLeast30Closes: 0,
        pairsWithAtLeast5ClosesEffective: 6,
        pairsWithAtLeast15ClosesEffective: 0,
        pairsWithAtLeast30ClosesEffective: 0,
      },
      topPromisingCohorts: [{
        symbol: "BTCUSDT",
        direction: "SHORT",
        routeCombo: "vwap_retest_entry + tp1_full_exit",
        localVerdict: "EARLY_PROMISING",
        netAvgR: 0.1436,
        nRaw: 8,
        nEffective: 8,
        multiplicityRatio: 1.0,
        signalMultiplicityWarning: false,
        earlyPromisingBlocked: false,
      }],
      topToxicCohorts: [{
        symbol: "BNBUSDT",
        direction: "LONG",
        routeCombo: "vwap_retest_entry + tp1_full_exit",
        localVerdict: "EARLY_TOXIC",
        netAvgR: -1.3066,
        nRaw: 6,
        nEffective: 6,
        multiplicityRatio: 1.0,
        signalMultiplicityWarning: false,
        earlyPromisingBlocked: false,
      }],
      highestRawReturnMultiplicityFlaggedCohort: null,
      routeHeterogeneity: [{
        routeCombo: "vwap_retest_entry + tp1_full_exit",
        verdict: "SYMBOL_SENSITIVE",
      }],
      candidateAssessments: [],
    };

    adaptiveGateState.report = {
      baseline: { netAvgR: -0.5251 },
      topSupportiveConditions: [{
        conditionLabel: "BEARISH_EXPANSION",
        localGateSignal: "SUPPORTIVE_WATCHABLE",
        performanceDeltaVsBaseline: { netAvgR: 0.3499 },
      }],
      topHarmfulConditions: [{
        conditionLabel: "BULLISH_EXPANSION",
        localGateSignal: "HARMFUL_WATCHABLE",
        performanceDeltaVsBaseline: { netAvgR: -0.3902 },
      }],
      interactionAssessments: [{
        interactionLabel: "MARKET_REGIME_BULLISH + SHORT",
        verdict: "EARLY_SUPPORTIVE",
        deltaVsBaseline: { netAvgR: 0.4876 },
      }],
      readiness: { readyForGateInfluence: false },
      contextCoverageSummary: {
        marketRegimeCoverage: 1,
        selectedKronosBiasCoverage: 0,
        kronosAlignmentCoverage: 0,
        whaleAgreementCoverage: 0,
        sentimentCoverage: 0,
        fearGreedCoverage: 0,
        horizonConflictCoverage: 0,
        sourceConflictCoverage: 0,
      },
      coverageProvenance: {
        resolvedRecordsWithStrategyContext: 0,
        recordsCreatedBeforePhase2A5: 76,
        recordsCreatedAfterPhase2A5: 0,
        openPositionsWithStrategyContext: 5,
      },
    };

    counterfactualState.report = {
      baseline: {
        closedCount: 76,
        netAvgR: -0.5251,
        grossAvgR: -0.1896,
        profitFactor: 0.2,
        tp1ProfitableRate: 0.3816,
        slRate: 0.3684,
      },
      bestImprovingScenario: {
        label: "Keep only bearish expansion and short",
        includedCount: 36,
        netAvgR: -0.0949,
        deltaNetAvgRVsBaseline: 0.4302,
        profitFactor: 0.6842,
        interpretation: "STRONGLY_IMPROVES",
      },
    };

    overlayState.report = {
      recordsWithPersistedOverlay: 0,
      overlayForwardCoveragePct: 0,
      policyPerformance: [
        { totalResolvedWithPolicy: 0, earlyVerdict: "NO_FORWARD_EVIDENCE_YET" },
      ],
    };
  });

  it("preserves winner-loser labels, clarifies stop wording, and expands Phase 2 maturity context", () => {
    const positions = [{
      variantSelection: { routeMode: "DATA_COLLECTION" },
      strategyContextSnapshot: { adaptiveRegimeGateOverlayAssessments: [{ policyId: "EXCLUDE_BULLISH_EXPANSION_V1" }] },
      variants: [{ state: "OPEN", closeReason: null }],
    }] as never[];

    const report = buildDashboardAuditSummaryReport(positions);
    expect(report.summaryText).toContain("horizonConflict=false: Winners: 97% vs losers: 61%");
    expect(report.summaryText).toContain("direction: Losers: \"LONG\" 57% vs winners: \"LONG\" 13%");
    expect(report.summaryText).toContain("highChaseRisk=false: Losers: 18% vs winners: 0%");
    expect(report.summaryText).not.toContain("highChaseRisk: Losers: 82% vs winners: 100%");
    expect(report.summaryText).not.toContain("Ultra-tight stop issue visible");
    expect(report.summaryText).toContain("Ultra-tight stop bucket remains historically toxic: true");
    expect(report.summaryText).toContain("Snapshot provenance: resolved with strategyContext=0 | inferred legacy resolved=76 | open newer snapshot positions=5");
    expect(report.summaryText).toContain("Field completeness: trend=");
    expect(report.summaryText).toContain("Major blockers: Symbol-Route=pairs with >=15 closes = 0");
    expect(report.summaryText).toContain("Open overlay-tagged positions already collecting prospectively: 1");
  });

  it("adds the interaction-vs-policy clarification when the strongest interaction and best scenario differ", () => {
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Note: strongest interaction is a slice-level observation; best counterfactual is a scenario-level policy simulation. They do not have to match.");
    const highlights = report.highlights as Record<string, any>;
    expect(highlights.adaptiveGateIntelligence.interactionVsPolicyNote).toContain("slice-level observation");
    expect(highlights.regimePolicyCounterfactual.interactionVsPolicyNote).toContain("scenario-level policy simulation");
  });

  it("keeps structured highlights labeled and avoids misleading stop semantics", () => {
    const report = buildDashboardAuditSummaryReport([]);
    const highlights = report.highlights as Record<string, any>;
    expect(highlights.winnerLoser.topWinnerSignals[0].label).toBe("horizonConflict=false");
    expect(highlights.winnerLoser.topLoserSignals[1].label).toBe("highChaseRisk=false");
    expect(highlights.stopGeometry.ultraTightBucketHistoricallyToxic).toBe(true);
    expect(highlights.stopGeometry.ultraTightStopVisible).toBeUndefined();
    expect(highlights.intelligenceFoundation.dataCompleteness.marketRegimeCoverage).toBe(1);
    expect(highlights.intelligenceFoundation.blockers.technicalStopTp).toBe("MAE/MFE coverage below readiness threshold");
  });

  it("includes external discovery source diagnostics instead of opaque zero-state wording", () => {
    const report = buildDashboardAuditSummaryReport([], {
      currentUniverseSymbols: ["BTCUSDT", "ETHUSDT"],
      externalCandidateMetadata: [],
      externalCandidateMetadataDiagnostics: {
        sourceStatus: "FAILED",
        generatedAt: "2026-05-15T00:00:00.000Z",
        cacheStatus: "MISS",
        exchangeInfo: { ok: false, rawCount: 0, errorMessage: "forced failure for /api/v3/exchangeInfo" },
        ticker24h: { ok: false, rawCount: 0, errorMessage: "forced failure for /api/v3/ticker/24hr" },
        bookTicker: { ok: false, rawCount: 0, errorMessage: "forced failure for /api/v3/ticker/bookTicker" },
        join: { joinedMetadataCount: 0, missingTickerCount: 0, missingBookTickerCount: 0, finalMetadataCount: 0 },
        notes: ["Live metadata fetch failed; no cache fallback available."],
      },
    });
    expect(report.summaryText).toContain("Metadata source=FAILED");
    expect(report.summaryText).toContain("exchangeInfo=failed");
    expect(report.summaryText).not.toContain("No external candidate metadata available");
    const highlights = report.highlights as Record<string, any>;
    expect(highlights.externalCandidateDiscoveryIntelligence.metadataDiagnostics.sourceStatus).toBe("FAILED");
  });

  it("adds external strategy-fit enrichment section and highlights when supplied", () => {
    const report = buildDashboardAuditSummaryReport([], {
      externalStrategyFitEnrichment: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        discoverySourceSummary: {
          discoveryShortlistCount: 10,
          discoveryTradableCount: 29,
          discoveryConfidence: "LOW",
          topMetadataCandidate: "SPKUSDT",
        },
        enrichedCandidateCount: 10,
        failedCandidateCount: 0,
        enrichmentReadiness: {
          advisoryEngineReady: true,
          readyForRotationShadowOverlay: false,
          readyForUniverseInfluence: false,
          confidence: "LOW",
          reasons: ["promising route fingerprints remain low-confidence"],
        },
        globalMarketContext: { inferredExternalShortlistRegime: "BEARISH_EXPANSION", longCount: 2, shortCount: 6, neutralCount: 2 },
        diagnostics: {
          candidatesRequested: 10,
          candidatesEvaluated: 10,
          technicalFetchSuccessCount: 10,
          technicalFetchFailureCount: 0,
          cacheStatus: "USES_BINANCE_CLIENT_CACHE",
          failureReasonCounts: {},
          failedCandidatesSample: [],
          notes: [],
        },
        candidates: [],
        topStrategyFitCandidates: [{
          symbol: "XYZUSDT",
          discoveryScore: 80,
          metadataDiscoveryTier: "EXPLORATORY_SHORTLIST",
          technicalDataStatus: "HEALTHY",
          strategyFitScore: 82,
          strategyFitTier: "STRATEGY_FIT_HIGH",
          strategyFitConfidence: "MEDIUM",
          bestObservedExternalRouteHypothesis: {
            selectedEntryVariant: "vwap_retest_entry",
            selectedExitVariant: "tp1_full_exit",
            routeMode: "DATA_COLLECTION",
            routeCompatibilityLabel: "DETACHED_STRATEGY_FIT_HYPOTHESIS",
            expectedNetR: null,
            stopDistanceBps: 220,
            riskReward: 1.8,
          },
          directionalContext: "SHORT_FAVORED",
          regimeCompatibility: "ALIGNED",
          routeCompatibility: "HIGH",
          setupQuality: "HIGH",
          stopGeometryCredibilityHint: "HEALTHY",
          reasons: ["strong fit"],
          cautionLabels: [],
          reusedScannerEvidenceSummary: {
            reusedSharedBuildCandidate: true,
            reusedSharedVariantSelection: true,
            opportunityScore: 75,
            confidence: 70,
            dangerScore: 30,
            trendStack: "BEARISH/BEARISH/BEARISH",
            scannerStatus: "WAIT",
          },
        }],
        lowFitCandidates: [],
        metadataShortlistDivergesFromStrategyFit: true,
        patchHypotheses: [],
        answerCards: [],
        notes: [],
      },
    });
    expect(report.summaryText).toContain("Q. EXTERNAL STRATEGY-FIT ENRICHMENT");
    expect(report.summaryText).toContain("Top strategy-fit candidate: XYZUSDT (fitScore=82, STRATEGY_FIT_HIGH)");
    const highlights = report.highlights as Record<string, any>;
    expect(highlights.externalStrategyFitEnrichment.topStrategyFitCandidate.symbol).toBe("XYZUSDT");
  });

  it("keeps external degradation diagnostics source-specific and surfaces enrichment failure reasons", () => {
    const report = buildDashboardAuditSummaryReport([], {
      currentUniverseSymbols: ["BTCUSDT", "ETHUSDT"],
      externalCandidateMetadata: [],
      externalCandidateMetadataDiagnostics: {
        sourceStatus: "DEGRADED_USING_CACHE",
        generatedAt: "2026-05-15T00:00:00.000Z",
        cacheStatus: "STALE_FALLBACK",
        servedFromCache: true,
        exchangeInfo: { ok: true, rawCount: 621 },
        ticker24h: { ok: false, rawCount: 0, errorMessage: "timeout" },
        bookTicker: { ok: true, rawCount: 621 },
        join: { joinedMetadataCount: 621, missingTickerCount: 0, missingBookTickerCount: 0, finalMetadataCount: 621 },
        notes: ["Live metadata fetch failed; returning stale in-process cache."],
      },
      externalStrategyFitEnrichment: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        discoverySourceSummary: {
          discoveryShortlistCount: 10,
          discoveryTradableCount: 28,
          discoveryConfidence: "LOW",
          topMetadataCandidate: "ZECUSDT",
        },
        enrichedCandidateCount: 0,
        failedCandidateCount: 10,
        enrichmentReadiness: {
          advisoryEngineReady: false,
          readyForRotationShadowOverlay: false,
          readyForUniverseInfluence: false,
          confidence: "LOW",
          reasons: ["No external discovery shortlist candidates were technically enriched."],
        },
        globalMarketContext: { inferredExternalShortlistRegime: "UNKNOWN", longCount: 0, shortCount: 0, neutralCount: 0 },
        diagnostics: {
          candidatesRequested: 10,
          candidatesEvaluated: 0,
          technicalFetchSuccessCount: 0,
          technicalFetchFailureCount: 10,
          cacheStatus: "USES_BINANCE_CLIENT_CACHE",
          failureReasonCounts: { "candles_5m timeout": 10 },
          failedCandidatesSample: [{ symbol: "ZECUSDT", errorMessage: "candles_5m timeout" }],
          notes: [],
        },
        candidates: [],
        topStrategyFitCandidates: [],
        lowFitCandidates: [],
        metadataShortlistDivergesFromStrategyFit: false,
        patchHypotheses: [],
        answerCards: [],
        notes: [],
      },
    });

    expect(report.summaryText).toContain("Metadata source=DEGRADED_USING_CACHE");
    expect(report.summaryText).toContain("exchangeInfo=ok(621)");
    expect(report.summaryText).toContain("ticker24h=failed(timeout)");
    expect(report.summaryText).toContain("bookTicker=ok(621)");
    expect(report.summaryText).toContain("Top enrichment failure: candles_5m timeout");
  });

  it("shows the live metadata host when discovery is healthy", () => {
    const report = buildDashboardAuditSummaryReport([], {
      currentUniverseSymbols: ["BTCUSDT", "ETHUSDT"],
      externalCandidateMetadata: [],
      externalCandidateMetadataDiagnostics: {
        sourceStatus: "HEALTHY",
        generatedAt: "2026-05-15T00:00:00.000Z",
        cacheStatus: "MISS",
        servedFromCache: false,
        exchangeInfo: { ok: true, rawCount: 3584, baseUrl: "https://api-gcp.binance.com", attemptCount: 1, elapsedMs: 7000 },
        ticker24h: { ok: true, rawCount: 3587, baseUrl: "https://api-gcp.binance.com", attemptCount: 1, elapsedMs: 6200 },
        bookTicker: { ok: true, rawCount: 3587, baseUrl: "https://api-gcp.binance.com", attemptCount: 1, elapsedMs: 6100 },
        join: { joinedMetadataCount: 621, missingTickerCount: 0, missingBookTickerCount: 0, finalMetadataCount: 621 },
        notes: [],
      },
    });

    expect(report.summaryText).toContain("Metadata source=HEALTHY | cache=MISS | host=api-gcp.binance.com");
  });

  it("renders interpretable-only overlay economics headlines while keeping distorted counts visible", () => {
    const report = buildDashboardAuditSummaryReport([], {
      externalRotationOverlay: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        totalObservations: 5,
        openObservations: 0,
        resolvedObservations: 5,
        noFillObservations: 0,
        expiredObservations: 0,
        failedObservations: 0,
        validityCounts: { rawObservationCount: 5, validObservationCount: 5, legacyInvalidExcludedCount: 0 },
        duplicateSuppressionStats: {
          diagnosticsAvailable: true,
          lastRefreshAt: "2026-05-15T00:00:00.000Z",
          triggerSource: "MANUAL",
          observationsConsidered: 5,
          observationsCreated: 4,
          observationsSuppressedAsDuplicate: 0,
          observationsSkippedForInsufficientState: 0,
          rejectedForEconomicDistortionCount: 1,
        },
        autoRefresh: {
          enabled: false,
          intervalMinutes: 30,
          firstRunPolicy: "IMMEDIATE_AFTER_STARTUP",
          isRunning: false,
          skippedWhileRunningCount: 0,
          lastAutoRefreshStartedAt: null,
          lastAutoRefreshFinishedAt: null,
          lastAutoRefreshStatus: "NEVER_RUN",
          lastAutoRefreshError: null,
          lastAutoRefreshResultSummary: null,
        },
        groupPerformance: [{
          group: "STRATEGY_FIT_SHORTLIST",
          observationCount: 5,
          resolvedCount: 5,
          headlineResolvedCount: 2,
          distortedExcludedFromHeadline: 3,
          borderlineExcludedFromHeadline: 0,
          noFillCount: 0,
          expiredCount: 0,
          failedCount: 0,
          netAvgR: -0.0363,
          grossAvgR: 0.0314,
          profitFactor: 0.95,
          winRate: 0.5,
          tp1ProfitableRate: 0.5,
          slRate: 0.5,
          noFillRate: 0,
          averageDurationMinutes: 25,
          earlyVerdict: "TOO_EARLY",
          comparisonVsMetadataBaseline: { deltaNetAvgR: 0.1, deltaProfitFactor: 0.1, deltaNoFillRate: 0 },
        }, {
          group: "METADATA_DISCOVERY_BASELINE",
          observationCount: 2,
          resolvedCount: 2,
          headlineResolvedCount: 2,
          distortedExcludedFromHeadline: 0,
          borderlineExcludedFromHeadline: 0,
          noFillCount: 0,
          expiredCount: 0,
          failedCount: 0,
          netAvgR: -0.2,
          grossAvgR: -0.1,
          profitFactor: 0.6,
          winRate: 0.5,
          tp1ProfitableRate: 0.5,
          slRate: 0.5,
          noFillRate: 0,
          averageDurationMinutes: 25,
          earlyVerdict: "TOO_EARLY",
          comparisonVsMetadataBaseline: { deltaNetAvgR: 0, deltaProfitFactor: 0, deltaNoFillRate: 0 },
        }, {
          group: "LOW_FIT_CONTROL",
          observationCount: 0,
          resolvedCount: 0,
          headlineResolvedCount: 0,
          distortedExcludedFromHeadline: 0,
          borderlineExcludedFromHeadline: 0,
          noFillCount: 0,
          expiredCount: 0,
          failedCount: 0,
          netAvgR: null,
          grossAvgR: null,
          profitFactor: null,
          winRate: null,
          tp1ProfitableRate: null,
          slRate: null,
          noFillRate: null,
          averageDurationMinutes: null,
          earlyVerdict: "NO_FORWARD_EVIDENCE_YET",
          comparisonVsMetadataBaseline: { deltaNetAvgR: null, deltaProfitFactor: null, deltaNoFillRate: null },
        }],
        overlapDiagnostics: { multiGroupObservationCount: 0, strategyFitAndMetadataOverlapCount: 0, uniqueSymbolsObserved: 5 },
        currentBestObservedGroup: null,
        readiness: {
          advisoryEngineReady: true,
          readyForUniverseInfluence: false,
          readyForRotationDiscussion: false,
          reasons: ["No resolved external overlay observations yet."],
        },
        patchHypotheses: [],
        answerCards: [],
        economicsInterpretability: {
          netRotationComparisonStatus: "NET_INTERPRETABLE",
          grossDirectionalComparisonStatus: "GROSS_LARGELY_UNCONTAMINATED",
          interpretableCount: 2,
          distortedCount: 3,
          borderlineCount: 0,
          totalClassified: 5,
          warningMessage: null,
        },
      } as never,
      externalRotationOverlayEconomics: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        totalObservations: 5,
        resolvedObservations: 5,
        headlineInterpretiveSampleSize: 2,
        forensicDistortedSampleSize: 3,
        forensicBorderlineSampleSize: 0,
        validityCounts: { rawObservationCount: 5, validObservationCount: 5, legacyInvalidExcludedCount: 0 },
        costComponentsAvailable: false,
        costDecompositionNote: "note",
        groups: [{
          group: "STRATEGY_FIT_SHORTLIST",
          observationCount: 5,
          resolvedCount: 2,
          headlineInterpretiveSampleSize: 2,
          forensicResolvedSampleSize: 5,
          distortedExcludedFromHeadline: 3,
          borderlineExcludedFromHeadline: 0,
          grossAvgR: 0.0314,
          netAvgR: -0.0363,
          avgCostDragR: 0.0677,
          avgCostR: 0.0677,
          avgStopDistanceBps: 220,
          medianStopDistanceBps: 220,
          avgRiskReward: 1.8,
          pctUltraTightStopLt100Bps: 0.6,
          pctTightStopLt175Bps: 0.6,
          pctNetLossMoreThan2R: 0,
          pctNetLossMoreThan4R: 0,
          pctGrossNearFlatButNetDeeplyNegative: 0,
          avgObservationDurationMinutes: 25,
          costDecompositionNote: "note",
          economicsVerdict: "INSUFFICIENT_EVIDENCE",
          reasons: [],
        }, {
          group: "METADATA_DISCOVERY_BASELINE",
          observationCount: 2,
          resolvedCount: 2,
          headlineInterpretiveSampleSize: 2,
          forensicResolvedSampleSize: 2,
          distortedExcludedFromHeadline: 0,
          borderlineExcludedFromHeadline: 0,
          grossAvgR: -0.1,
          netAvgR: -0.2,
          avgCostDragR: 0.1,
          avgCostR: 0.1,
          avgStopDistanceBps: 220,
          medianStopDistanceBps: 220,
          avgRiskReward: 1.8,
          pctUltraTightStopLt100Bps: 0,
          pctTightStopLt175Bps: 0,
          pctNetLossMoreThan2R: 0,
          pctNetLossMoreThan4R: 0,
          pctGrossNearFlatButNetDeeplyNegative: 0,
          avgObservationDurationMinutes: 25,
          costDecompositionNote: "note",
          economicsVerdict: "MIXED_EARLY",
          reasons: [],
        }, {
          group: "LOW_FIT_CONTROL",
          observationCount: 0,
          resolvedCount: 0,
          headlineInterpretiveSampleSize: 0,
          forensicResolvedSampleSize: 0,
          distortedExcludedFromHeadline: 0,
          borderlineExcludedFromHeadline: 0,
          grossAvgR: null,
          netAvgR: null,
          avgCostDragR: null,
          avgCostR: null,
          avgStopDistanceBps: null,
          medianStopDistanceBps: null,
          avgRiskReward: null,
          pctUltraTightStopLt100Bps: null,
          pctTightStopLt175Bps: null,
          pctNetLossMoreThan2R: null,
          pctNetLossMoreThan4R: null,
          pctGrossNearFlatButNetDeeplyNegative: null,
          avgObservationDurationMinutes: null,
          costDecompositionNote: "note",
          economicsVerdict: "INSUFFICIENT_EVIDENCE",
          reasons: [],
        }],
        geometryFindings: ["STRATEGY_FIT_SHORTLIST: avg planned stop = 220.0 bps | median = 220.0 bps."],
        economicsDiagnosis: {
          primaryDiagnosis: "TOO_EARLY",
          explanation: "too early",
          strongestEvidence: [],
          cautionNotes: ["sample is still tiny"],
        },
        hypotheses: [],
        readiness: {
          advisoryEngineReady: true,
          readyForResolverBehaviorDiscussion: false,
          readyForUniverseRotationInterpretation: false,
          reasons: ["sample is still tiny"],
        },
        credibilityGroups: [{
          group: "STRATEGY_FIT_SHORTLIST",
          credibilityVerdict: "MIXED",
          interpretableCount: 2,
          distortedCount: 3,
          borderlineCount: 0,
          insufficientDataCount: 0,
          pctDistorted: 0.6,
          pctInterpretable: 0.4,
          avgStopDistanceBpsAmongDistorted: 5,
          dominantDistortionFlag: "ULTRA_TIGHT_STOP",
        }, {
          group: "METADATA_DISCOVERY_BASELINE",
          credibilityVerdict: "ALL_INTERPRETABLE",
          interpretableCount: 2,
          distortedCount: 0,
          borderlineCount: 0,
          insufficientDataCount: 0,
          pctDistorted: 0,
          pctInterpretable: 1,
          avgStopDistanceBpsAmongDistorted: null,
          dominantDistortionFlag: null,
        }, {
          group: "LOW_FIT_CONTROL",
          credibilityVerdict: "INSUFFICIENT_DATA",
          interpretableCount: 0,
          distortedCount: 0,
          borderlineCount: 0,
          insufficientDataCount: 0,
          pctDistorted: null,
          pctInterpretable: null,
          avgStopDistanceBpsAmongDistorted: null,
          dominantDistortionFlag: null,
        }],
        externalOverlayInterpretability: {
          netRotationComparisonStatus: "NET_INTERPRETABLE",
          grossDirectionalComparisonStatus: "GROSS_LARGELY_UNCONTAMINATED",
          interpretableCount: 2,
          distortedCount: 3,
          borderlineCount: 0,
          insufficientDataCount: 0,
          totalClassified: 5,
          warningMessage: null,
        },
      } as never,
    });

    expect(report.summaryText).toContain("Headline economics basis: interpretable valid post-fix tape only | headline n=2 | distorted excluded=3");
    expect(report.summaryText).toContain("Strategy-fit: gross=0.0314R | net=-0.0363R | implied drag=0.0677R (headline n=2, distorted excluded=3)");
    expect(report.summaryText).toContain("Distorted observations remain tracked for audit; headline economics excludes distorted and borderline resolved tape by default.");
    expect(report.summaryText).toContain("rejected-distortion=1");
    const highlights = report.highlights as Record<string, any>;
    expect(highlights.externalRotationOverlayEconomics.headlineInterpretiveSampleSize).toBe(2);
    expect(highlights.externalRotationOverlayEconomics.strategyFitGroup.distortedExcludedFromHeadline).toBe(3);
    expect(highlights.externalRotationShadowOverlay.refreshRejectedEconomicDistortion).toBe(1);
  });

  it("aligns section U wording around primary mismatch root cause and secondary geometry amplification", () => {
    const report = buildDashboardAuditSummaryReport([], {
      tpSlGeometryRootCauseAudit: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        evidenceEra: "POST_CALIBRATION",
        totalObservations: 15,
        resolvedObservations: 13,
        postFixV2ObservationCount: 7,
        rootCauseVerdict: "EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH",
        rootCauseExplanation: "legacy v1 mismatch",
        secondaryGeometryFinding: "ULTRA_TIGHT_STOP_GEOMETRY_AMPLIFIED_THE_DAMAGE",
        activeBotHasSameMismatchBug: false,
        legacyV1Only: true,
        costModelSanity: "COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH",
        costModelNotes: ["No double-subtraction detected."],
        externalVsActiveComparison: "SHARED_BUT_EXTERNAL_AMPLIFIED",
        externalVsActiveNotes: ["active bot does not share the mismatch bug"],
        rrInflationDriver: "STOP_TOO_TIGHT_DENOMINATOR_INFLATION",
        rrInflationNotes: [],
        perObservationMismatches: [],
        routeVariantBreakdown: [],
        pctObservationsWithMismatch: 0.385,
        avgInflationRatio: 3.4,
        strongestOffendingVariant: "fib_500_entry",
        patchDirections: [],
        readiness: {
          advisoryEngineReady: true,
          readyForResolverBehaviorChange: false,
          readyForCostModelChange: false,
          reasons: ["audit only"],
        },
      },
    });
    expect(report.summaryText).toContain("U. TP/SL GEOMETRY ROOT-CAUSE AUDIT");
    expect(report.summaryText).toContain("Primary root cause: EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH");
    expect(report.summaryText).toContain("Secondary amplifier: ultra-tight stop geometry magnified the unit mismatch");
    expect(report.summaryText).toContain("anchor/fill mismatch bug was external-overlay-specific (activeBotHasSameMismatchBug=false)");
    expect(report.summaryText).toContain("Cost model sanity: arithmetic correct, but V1 entry basis was inconsistent");
    expect(report.summaryText).toContain("38.5% of resolved observations show actual fill stop >= 2x stored stopDistanceBps");
    const highlights = report.highlights as Record<string, any>;
    expect(highlights.tpSlGeometryRootCauseAudit.primaryRootCause).toBe("EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH");
    expect(highlights.tpSlGeometryRootCauseAudit.secondaryAmplifier).toBe("ULTRA_TIGHT_STOP_GEOMETRY_AMPLIFIED_THE_DAMAGE");
    expect(highlights.tpSlGeometryRootCauseAudit.activeBotHasSameMismatchBug).toBe(false);
    expect(highlights.tpSlGeometryRootCauseAudit.legacyV1Only).toBe(true);
  });

  // --- EX_TOXIC sibling reporting tests ---

  function makeExToxicSiblingFixture() {
    // Minimal AdaptiveProfitPolicySynthesisReport with a SHORT parent and EX_TOXIC sibling
    const parentShort = {
      policyId: "BEARISH_EXPANSION__SHORT__vwap_retest_entry__tp1_full_exit__ALL_SYMBOLS",
      policyLabel: "BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit",
      direction: "SHORT",
      marketRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 40,
      netAvgR: -0.1327,
      grossAvgR: -0.0121,
      profitFactor: 0.5916,
      deltaVsBaseline: null,
      avgWinR: 0.3,
      avgLossR: -0.5,
      credibility: "CLEAN_WATCHABLE",
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE",
      blockers: ["Net economics are not positive yet."],
      whyThisPolicyRanksHere: ["Best SHORT by sampleSize"],
      rankingScore: 30,
      evidenceConsensus: {
        evidenceConsensusScore: 40,
        evidenceConsensusVerdict: "CONFLICTED",
        positiveEvidenceCount: 2,
        negativeEvidenceCount: 3,
        conflictingEvidenceCount: 1,
        missingEvidenceCount: 0,
        keyConsensusReasons: [],
        keyConflictReasons: ["bearish bias absent in context coverage"],
      },
      collectionPriority: "EXPLOIT_PRIMARY",
      operativeCollectionPriority: "EXPLOIT_PRIMARY",
      collectionPriorityReason: "best short",
      collectionPriorityScore: 30,
      collectionPriorityBlockers: [],
      microPilotReadiness: {
        verdict: "WATCHABLE",
        microPilotReady: false as const,
        blockers: ["Net economics are not positive yet."],
      },
    };

    const exToxicShort = {
      ...parentShort,
      policyId: "BEARISH_EXPANSION__SHORT__vwap_retest_entry__tp1_full_exit__ALL_SYMBOLS_EX_TOXIC",
      policyLabel: "BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit [EX_TOXIC: BNBUSDT]",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 36,
      netAvgR: -0.0046,
      grossAvgR: 0.0977,
      profitFactor: 0.9787,
      evidenceConsensus: {
        ...parentShort.evidenceConsensus,
        evidenceConsensusVerdict: "MIXED",
      },
      microPilotReadiness: {
        verdict: "WATCHABLE",
        microPilotReady: false as const,
        blockers: ["Net economics are not positive yet."],
      },
      excludedSymbols: ["BNBUSDT"],
      tier2ToxicWatchlistSymbols: ["DOGEUSDT", "LINKUSDT"],
      toxicSymbolExclusionReason: "tier-1 toxic via lane-toxic-symbol-evaluator",
    };

    return {
      generatedAt: "2026-05-16T00:00:00.000Z",
      evidenceEra: "POST_CALIBRATION" as const,
      baseline: { sampleSize: 76, netAvgR: -0.5251, grossAvgR: -0.1896, profitFactor: 0.2 },
      candidates: [parentShort as never, exToxicShort as never],
      rankedTopPolicies: [parentShort as never],
      bestOverallPolicy: parentShort as never,
      bestShortPolicy: parentShort as never,
      bestLongPolicy: null,
      bestOverallPolicyExToxic: exToxicShort as never,
      bestShortPolicyExToxic: exToxicShort as never,
      bestLongPolicyExToxic: null,
      currentAdaptiveDirectionBias: "SHORT_ONLY" as const,
      directionalReadiness: { shortLaneReadiness: "WATCHABLE" as const, longLaneReadiness: "INSUFFICIENT_EVIDENCE" as const },
      missingEvidenceForLongLane: ["no long closes yet"],
      missingEvidenceForShortLane: [],
      exploitShadowPriorities: {
        primaryProfitLane: null,
        secondaryValidationLane: null,
        observeOnlyLanes: [],
        antiBiasSafeguard: "none",
      },
      operativeCollectionPlan: {
        mode: "EXPLOIT_SHADOW_PRIMARY" as const,
        currentOperativePrimaryLane: null,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "none",
        externalOverlayAdmissionUsesAdaptivePrioritization: true as const,
        primaryLaneBlockers: ["net economics not positive"],
      },
      notes: [],
    };
  }

  it("section V renders EX_TOXIC refined sibling when present", () => {
    const synthesis = makeExToxicSiblingFixture();
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Best refined sibling [EX_TOXIC]:");
    expect(report.summaryText).toContain("BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit [EX_TOXIC: BNBUSDT]");
    expect(report.summaryText).toContain("excludedSymbols=[BNBUSDT]");
    expect(report.summaryText).toContain("EX_TOXIC consensus: MIXED");
    expect(report.summaryText).toContain("netAvgR delta vs parent=+");
    expect(report.summaryText).toContain("PF delta vs parent=+");
  });

  it("section V preserves original ALL_SYMBOLS parent line when EX_TOXIC sibling is present", () => {
    const synthesis = makeExToxicSiblingFixture();
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Best SHORT: BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit | WATCHABLE | consensus=CONFLICTED");
  });

  it("section X renders micro-pilot for EX_TOXIC sibling when present", () => {
    const synthesis = makeExToxicSiblingFixture();
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("X. MICRO-PILOT READINESS BY POLICY LANE");
    expect(report.summaryText).toContain("[EX_TOXIC lane]: WATCHABLE | ready=false");
    expect(report.summaryText).toContain("BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit [EX_TOXIC: BNBUSDT] [EX_TOXIC lane]:");
  });

  it("section M references refined EX_TOXIC lane when sibling materially improves parent (netAvgR delta > 0.05R)", () => {
    const synthesis = makeExToxicSiblingFixture();
    // parent netAvgR=-0.1327, sibling netAvgR=-0.0046, delta=+0.1281 > 0.05
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("M. ONE-LINE EXECUTIVE TAKEAWAY");
    expect(report.summaryText).toContain("Most actionable refined policy:");
    // policyLabel already contains [EX_TOXIC: BNBUSDT] from the synthesis report
    expect(report.summaryText).toContain("EX_TOXIC: BNBUSDT");
    expect(report.summaryText).toContain("materially stronger than unfiltered parent");
    expect(report.summaryText).toContain("consensus=MIXED");
  });

  it("falls back to prior behavior in V, X, M when EX_TOXIC sibling is absent", () => {
    const synthesis = makeExToxicSiblingFixture();
    const noExToxic = {
      ...synthesis,
      bestShortPolicyExToxic: null,
      bestOverallPolicyExToxic: null,
    };
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: noExToxic as never });
    // Section V — no EX_TOXIC refined sibling line
    expect(report.summaryText).not.toContain("Best refined sibling [EX_TOXIC]:");
    expect(report.summaryText).not.toContain("EX_TOXIC consensus:");
    // Section X — no EX_TOXIC lane micro-pilot line
    expect(report.summaryText).not.toContain("[EX_TOXIC lane]:");
    // Section M — falls back to old summarizeTakeaway wording (not EX_TOXIC)
    expect(report.summaryText).not.toContain("Most actionable refined policy:");
    expect(report.summaryText).not.toContain("materially stronger than unfiltered parent");
    // Parent lines still present
    expect(report.summaryText).toContain("Best SHORT:");
    expect(report.summaryText).toContain("X. MICRO-PILOT READINESS BY POLICY LANE");
    expect(report.summaryText).toContain("M. ONE-LINE EXECUTIVE TAKEAWAY");
  });

  it("no operative field appears changed by EX_TOXIC reporting patch", () => {
    const synthesis = makeExToxicSiblingFixture();
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    const highlights = report.highlights as Record<string, any>;
    // Admission suppression / routing / live readiness are not touched
    expect(highlights.liveReadiness.liveReady).toBe(false);
    // adaptiveProfitPolicySynthesis highlights still expose the original (unchanged) parent
    const appsHighlight = highlights.adaptiveProfitPolicySynthesis as Record<string, any>;
    expect(appsHighlight.bestShortPolicy.symbolScope).toBe("ALL_SYMBOLS");
    expect(appsHighlight.bestShortPolicyExToxic.symbolScope).toBe("ALL_SYMBOLS_EX_TOXIC");
    // readyForUniverseInfluence / readyForRotationShadowOverlay are not present on this section
    expect(appsHighlight.readyForUniverseInfluence).toBeUndefined();
    // microPilotReadiness in highlights is for ranked top policies (unchanged parent)
    const microHighlight = highlights.microPilotReadinessByPolicyLane as Record<string, any>;
    expect(microHighlight.lanes).toHaveLength(1);
    expect(microHighlight.lanes[0].policyId).not.toContain("EX_TOXIC");
  });

  // ── Test 9–12: Promotion-aware section markers ───────────────────────────

  function makePromotedSiblingFixture() {
    // Build a synthesis where bestShortPolicy is already promoted (EX_TOXIC scope)
    // and bestShortPolicyParent holds the original ALL_SYMBOLS parent.
    const parentShort = {
      policyId: "CORE_ALL_BEARISH_EXPANSION_SHORT_VWAP_TP1",
      policyLabel: "BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit",
      direction: "SHORT",
      dominantRegime: "BEARISH_EXPANSION",
      route: "vwap_retest_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "ALL_SYMBOLS",
      sampleSize: 40,
      netAvgR: -0.1327,
      grossAvgR: -0.0121,
      profitFactor: 0.5916,
      deltaVsBaseline: null,
      avgWinR: 0.3,
      avgLossR: -0.5,
      credibility: "CLEAN_EVALUABLE",
      contaminationFlags: [],
      validityFlags: [],
      policyVerdict: "WATCHABLE",
      blockers: ["Net economics are not positive yet."],
      whyThisPolicyRanksHere: [
        "n=40, netAvgR=-0.1327, delta=n/a.",
        "Credibility=CLEAN_EVALUABLE; regime-direction=BEARISH_EXPANSION/SHORT.",
        "Consensus=CONFLICTED (score=40).",
      ],
      rankingScore: 22,
      evidenceConsensus: {
        evidenceConsensusScore: 40,
        evidenceConsensusVerdict: "CONFLICTED",
        positiveEvidenceCount: 1,
        negativeEvidenceCount: 3,
        conflictingEvidenceCount: 1,
        missingEvidenceCount: 0,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY",
      operativeCollectionPriority: "OBSERVE_ONLY",
      collectionPriorityReason: "",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [],
      microPilotReadiness: { verdict: "WATCH_CLOSELY", microPilotReady: false as const, blockers: [] },
    };

    const promotedSibling = {
      ...parentShort,
      policyId: "CORE_ALL_BEARISH_EXPANSION_SHORT_VWAP_TP1_EX_TOXIC",
      policyLabel: "BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit [EX_TOXIC: BNBUSDT]",
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: 36,
      netAvgR: -0.0046,
      grossAvgR: 0.0977,
      profitFactor: 0.9787,
      whyThisPolicyRanksHere: [
        "EX_TOXIC sibling promoted. n=36, netAvgR=-0.0046.",
        "Credibility=CLEAN_EVALUABLE; regime-direction=BEARISH_EXPANSION/SHORT.",
        "Consensus=MIXED (score=55). [promoted EX_TOXIC representative]",
      ],
      rankingScore: 30,
      evidenceConsensus: {
        evidenceConsensusScore: 55,
        evidenceConsensusVerdict: "MIXED",
        positiveEvidenceCount: 2,
        negativeEvidenceCount: 2,
        conflictingEvidenceCount: 1,
        missingEvidenceCount: 0,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      excludedSymbols: ["BNBUSDT"],
      tier2ToxicWatchlistSymbols: [],
      toxicSymbolExclusionReason: "tier-1 toxic",
    };

    const promotionResult = {
      refinedPromotionEligible: true,
      refinedPromotionReason: "EX_TOXIC sibling passes all 7 promotion checks",
      refinedPromotionChecks: {
        samePolicyFamily: true,
        sampleRetained: true,
        netAvgRUplift: true,
        profitFactorUplift: true,
        verdictNotWorse: true,
        consensusNotWorse: true,
        contaminationReduced: true,
      },
      preferredPolicyVariant: "EX_TOXIC" as const,
    };

    return {
      generatedAt: "2026-05-16T00:00:00.000Z",
      evidenceEra: "POST_CALIBRATION" as const,
      baseline: { sampleSize: 76, netAvgR: -0.5251, grossAvgR: -0.1896, profitFactor: 0.2 },
      candidates: [promotedSibling as never, parentShort as never],
      rankedTopPolicies: [promotedSibling as never, parentShort as never],
      // After promotion: bestShortPolicy = promoted sibling, bestShortPolicyParent = original
      bestOverallPolicy: promotedSibling as never,
      bestShortPolicy: promotedSibling as never,
      bestShortPolicyParent: parentShort as never,
      bestLongPolicy: null,
      bestOverallPolicyExToxic: promotedSibling as never,
      bestShortPolicyExToxic: promotedSibling as never,
      bestLongPolicyExToxic: null,
      shortPolicyPromotionResult: promotionResult,
      overallPolicyPromotionResult: promotionResult,
      currentAdaptiveDirectionBias: "SHORT_BIAS" as const,
      directionalReadiness: {
        shortLaneReadiness: "WATCHABLE" as const,
        longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" as const,
      },
      missingEvidenceForLongLane: ["no long evidence yet"],
      missingEvidenceForShortLane: [],
      exploitShadowPriorities: {
        primaryProfitLane: null,
        secondaryValidationLane: null,
        observeOnlyLanes: [],
        antiBiasSafeguard: "none",
      },
      operativeCollectionPlan: {
        mode: "VALIDATION_ONLY" as const,
        currentOperativePrimaryLane: null,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "none",
        externalOverlayAdmissionUsesAdaptivePrioritization: true as const,
        primaryLaneBlockers: ["net economics not positive"],
      },
      notes: [],
    };
  }

  // Test 9: Section W uses promoted sibling metrics when promotion is active
  it("test 9: section W shows promoted note and uses promoted candidate whyThisPolicyRanksHere when promotion is active", () => {
    const synthesis = makePromotedSiblingFixture();
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    // The "Why" line in Section W should reference the promoted sibling's metric text
    expect(report.summaryText).toContain("W. DIRECTION-ADAPTIVE EXECUTION POSTURE");
    expect(report.summaryText).toContain("[promoted EX_TOXIC representative]");
    // Consensus posture should say SHORT [promoted]
    expect(report.summaryText).toContain("SHORT [promoted]=MIXED");
  });

  // Test 10: Section V shows [Preferred representative: EX_TOXIC sibling] when promoted
  it("test 10: section V shows [Preferred representative: EX_TOXIC sibling] marker when promotion is active", () => {
    const synthesis = makePromotedSiblingFixture();
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("V. ADAPTIVE PROFIT POLICY SYNTHESIS");
    expect(report.summaryText).toContain("[Preferred representative: EX_TOXIC sibling]");
  });

  // Test 11: Section X shows [Selected refined best short policy] for sibling when promoted
  it("test 11: section X shows [Selected refined best short policy] for EX_TOXIC lane when promoted", () => {
    const synthesis = makePromotedSiblingFixture();
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("X. MICRO-PILOT READINESS BY POLICY LANE");
    expect(report.summaryText).toContain("[Selected refined best short policy]");
  });

  // Test 12: Section M confirms formal selection when promoted
  it("test 12: section M confirms formally selected best short policy when promotion is active", () => {
    const synthesis = makePromotedSiblingFixture();
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("M. ONE-LINE EXECUTIVE TAKEAWAY");
    // The takeaway should mention formal selection
    expect(report.summaryText).toContain("Formally selected as best short policy (refined promotion confirmed).");
    // Should still reference the EX_TOXIC label
    expect(report.summaryText).toContain("EX_TOXIC: BNBUSDT");
  });

  // ── Section I — Top promising cohort credibility semantics ───────────────────

  it("Section I renders 'none with credible effective evidence yet' when topPromisingCohorts is empty", () => {
    symbolRouteState.report = {
      ...symbolRouteState.report,
      topPromisingCohorts: [],
      highestRawReturnMultiplicityFlaggedCohort: null,
    };
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Top promising cohort: none with credible effective evidence yet");
    expect(report.summaryText).not.toContain("Top promising cohort: none\n");
  });

  it("Section I shows a credible cohort under 'Top promising cohort' when topPromisingCohorts is non-empty", () => {
    // The default fixture has BTCUSDT SHORT as the top promising cohort (no blocker)
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Top promising cohort: BTCUSDT SHORT vwap_retest_entry + tp1_full_exit");
    expect(report.summaryText).not.toContain("none with credible effective evidence yet");
  });

  it("Section I renders 'Highest raw-return cohort (credibility warning: multiplicity)' when flagged cohort exists", () => {
    symbolRouteState.report = {
      ...symbolRouteState.report,
      topPromisingCohorts: [],
      highestRawReturnMultiplicityFlaggedCohort: {
        symbol: "DOGEUSDT",
        direction: "LONG",
        routeCombo: "fib_500_entry + tp1_full_exit",
        localVerdict: "MIXED",
        netAvgR: 0.35,
        nRaw: 5,
        nEffective: 1,
        multiplicityRatio: 0.2,
        signalMultiplicityWarning: true,
        earlyPromisingBlocked: true,
      },
    };
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Top promising cohort: none with credible effective evidence yet");
    expect(report.summaryText).toContain("Highest raw-return cohort (credibility warning: multiplicity):");
    expect(report.summaryText).toContain("DOGEUSDT LONG fib_500_entry + tp1_full_exit");
    expect(report.summaryText).toContain("⚠ MULTIPLICITY");
    // Ensure DOGEUSDT does NOT appear under "Top promising cohort"
    expect(report.summaryText).not.toMatch(/Top promising cohort:.*DOGEUSDT/);
  });

  it("Section I does NOT show 'Highest raw-return' line when highestRawReturnMultiplicityFlaggedCohort is null", () => {
    // Default fixture has highestRawReturnMultiplicityFlaggedCohort: null
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).not.toContain("Highest raw-return cohort (credibility warning: multiplicity)");
  });

  it("Section I renders dual raw/effective-n counts for pairs >=5/>=15/>=30", () => {
    const report = buildDashboardAuditSummaryReport([]);
    // Check that both raw and effective counts appear for each threshold
    expect(report.summaryText).toContain("pairs raw>=5=7 eff>=6");
    expect(report.summaryText).toContain("pairs raw>=15=0 eff>=0");
    expect(report.summaryText).toContain("pairs raw>=30=0 eff>=0");
  });

  it("Section I multiplicity warning summary line remains intact", () => {
    symbolRouteState.report = {
      ...symbolRouteState.report,
      candidateAssessments: [
        { signalMultiplicityWarning: true },
        { signalMultiplicityWarning: false },
        { signalMultiplicityWarning: true },
      ],
    };
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Signal multiplicity warnings: 2 cohort(s) flagged");
  });

  it("highlights.symbolRouteSuitability exposes effective-n counts and flagged cohort", () => {
    symbolRouteState.report = {
      ...symbolRouteState.report,
      highestRawReturnMultiplicityFlaggedCohort: {
        symbol: "DOGEUSDT",
        direction: "LONG",
        routeCombo: "fib_500_entry + tp1_full_exit",
        localVerdict: "MIXED",
        netAvgR: 0.35,
        nRaw: 5,
        nEffective: 1,
        multiplicityRatio: 0.2,
        signalMultiplicityWarning: true,
        earlyPromisingBlocked: true,
      },
    };
    const report = buildDashboardAuditSummaryReport([]);
    const h = report.highlights as Record<string, any>;
    expect(h.symbolRouteSuitability.pairsWithAtLeast5ClosesEffective).toBe(6);
    expect(h.symbolRouteSuitability.pairsWithAtLeast15ClosesEffective).toBe(0);
    expect(h.symbolRouteSuitability.pairsWithAtLeast30ClosesEffective).toBe(0);
    expect(h.symbolRouteSuitability.highestRawReturnFlaggedCohort).not.toBeNull();
    expect(h.symbolRouteSuitability.highestRawReturnFlaggedCohort.credibilityWarning).toBe("multiplicity");
  });

  // ── Section V credibility filter: multiplicity and RAW_EDGE_NOT_VALIDATED ──

  function makeMinimalSynthesis(candidates: object[]) {
    return {
      generatedAt: "2026-05-20T00:00:00.000Z",
      evidenceEra: "POST_CALIBRATION" as const,
      baseline: { sampleSize: 20, netAvgR: -0.1, grossAvgR: 0.05, profitFactor: 0.8 },
      candidates: candidates as never[],
      rankedTopPolicies: candidates as never[],
      bestOverallPolicy: null,
      bestShortPolicy: null,
      bestLongPolicy: null,
      bestShortPolicyParent: null,
      bestLongPolicyParent: null,
      bestOverallPolicyParent: null,
      bestOverallPolicyExToxic: null,
      bestShortPolicyExToxic: null,
      bestLongPolicyExToxic: null,
      currentAdaptiveDirectionBias: "NO_EDGE_YET" as const,
      directionalReadiness: {
        shortLaneReadiness: "NO_PROMOTABLE_POLICY_YET" as const,
        longLaneReadiness: "NO_PROMOTABLE_POLICY_YET" as const,
      },
      missingEvidenceForLongLane: [],
      missingEvidenceForShortLane: [],
      exploitShadowPriorities: {
        primaryProfitLane: null,
        secondaryValidationLane: null,
        observeOnlyLanes: [],
        antiBiasSafeguard: "none",
      },
      operativeCollectionPlan: {
        mode: "NO_PRIMARY_LANE_YET" as const,
        currentOperativePrimaryLane: null,
        secondaryValidationLanes: [],
        observeOnlyLanes: [],
        rejectedLanes: [],
        collectionAntiBiasSummary: "none",
        externalOverlayAdmissionUsesAdaptivePrioritization: true as const,
        primaryLaneBlockers: [],
      },
      notes: [],
    };
  }

  function makeCandidate(overrides: Record<string, unknown>) {
    const base = {
      policyId: "CORE_TEST",
      policyLabel: "TEST + SHORT + fib_500_entry + tp1_full_exit + FETUSDT",
      sourceType: "CORE",
      direction: "SHORT",
      dominantRegime: null,
      route: "fib_500_entry",
      exitPolicy: "tp1_full_exit",
      symbolScope: "FETUSDT",
      sampleSize: 14,
      netAvgR: -0.005,
      grossAvgR: 0.05,
      profitFactor: 0.95,
      deltaVsBaseline: null,
      avgWinR: 0.3,
      avgLossR: -0.4,
      credibility: "CLEAN_WATCHABLE",
      contaminationFlags: [] as string[],
      validityFlags: [] as string[],
      policyVerdict: "WATCHABLE",
      blockers: [] as string[],
      whyThisPolicyRanksHere: [],
      rankingScore: 10,
      evidenceConsensus: {
        evidenceConsensusScore: 30,
        evidenceConsensusVerdict: "NEUTRAL",
        positiveEvidenceCount: 1,
        negativeEvidenceCount: 1,
        conflictingEvidenceCount: 0,
        missingEvidenceCount: 0,
        keyConsensusReasons: [],
        keyConflictReasons: [],
      },
      collectionPriority: "OBSERVE_ONLY",
      operativeCollectionPriority: "OBSERVE_ONLY",
      collectionPriorityReason: "observe",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [] as string[],
      microPilotReadiness: {
        verdict: "NOT_READY",
        microPilotReady: false as const,
        blockers: [],
      },
    };
    return { ...base, ...overrides };
  }

  it("Section V — FET-like MULTIPLICITY false-positive candidate is excluded from 'Best by economics'", () => {
    // Simulate FETUSDT SHORT: signalMultiplicityWarning=true → earlyPromisingBlocked=true in symbolRoute
    // The candidate has WATCHABLE verdict and positive(ish) netAvgR but should NOT appear as best by economics.
    const fetCandidate = makeCandidate({
      symbolScope: "FETUSDT",
      direction: "SHORT",
      netAvgR: 0.05, // Would win economics ranking if not filtered
    });
    symbolRouteState.report = {
      ...symbolRouteState.report,
      candidateAssessments: [{
        symbol: "FETUSDT",
        direction: "SHORT",
        signalMultiplicityWarning: true,
        earlyPromisingBlocked: true,
      }],
    };
    const synthesis = makeMinimalSynthesis([fetCandidate]);
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    // FETUSDT SHORT is earlyPromisingBlocked → excluded from "Best by economics"
    expect(report.summaryText).toContain("Best by economics: none with credible effective evidence yet");
    // The "Best by economics" line must NOT reference FETUSDT
    expect(report.summaryText).not.toMatch(/Best by economics:.*FETUSDT/);
  });

  it("Section V — all-RAW_EDGE_NOT_VALIDATED candidate is excluded from 'Best by economics'", () => {
    // Simulate a candidate whose entire cohort is RAW_EDGE_NOT_VALIDATED → earlyPromisingBlocked=true
    const rawCandidate = makeCandidate({
      symbolScope: "XYZUSDT",
      direction: "LONG",
      netAvgR: 0.2,
    });
    symbolRouteState.report = {
      ...symbolRouteState.report,
      candidateAssessments: [{
        symbol: "XYZUSDT",
        direction: "LONG",
        signalMultiplicityWarning: false,
        earlyPromisingBlocked: true, // all RAW_EDGE_NOT_VALIDATED
      }],
    };
    const synthesis = makeMinimalSynthesis([rawCandidate]);
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Best by economics: none with credible effective evidence yet");
    expect(report.summaryText).not.toMatch(/Best by economics:.*XYZUSDT/);
  });

  it("Section V — credible candidate (no blocker) can still appear as 'Best by economics'", () => {
    const goodCandidate = makeCandidate({
      policyLabel: "TREND + SHORT + fib_500_entry + tp1_full_exit + BTCUSDT",
      symbolScope: "BTCUSDT",
      direction: "SHORT",
      netAvgR: 0.18,
    });
    symbolRouteState.report = {
      ...symbolRouteState.report,
      candidateAssessments: [{
        symbol: "BTCUSDT",
        direction: "SHORT",
        signalMultiplicityWarning: false,
        earlyPromisingBlocked: false,
      }],
    };
    const synthesis = makeMinimalSynthesis([goodCandidate]);
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Best by economics:");
    expect(report.summaryText).not.toContain("none with credible effective evidence yet");
    expect(report.summaryText).toContain("BTCUSDT");
  });

  it("Section V — no credible candidate among multiple blocked → fallback renders 'none with credible effective evidence yet'", () => {
    const blocked1 = makeCandidate({ symbolScope: "FETUSDT", direction: "SHORT", netAvgR: 0.15 });
    const blocked2 = makeCandidate({ symbolScope: "DOGEUSDT", direction: "LONG", netAvgR: 0.10 });
    symbolRouteState.report = {
      ...symbolRouteState.report,
      candidateAssessments: [
        { symbol: "FETUSDT", direction: "SHORT", signalMultiplicityWarning: true, earlyPromisingBlocked: true },
        { symbol: "DOGEUSDT", direction: "LONG", signalMultiplicityWarning: false, earlyPromisingBlocked: true },
      ],
    };
    const synthesis = makeMinimalSynthesis([blocked1, blocked2]);
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    expect(report.summaryText).toContain("Best by economics: none with credible effective evidence yet");
  });

  it("Section V — credibility filter does not affect 'Best ranked (credibility-led)' or 'Best SHORT/LONG' lines", () => {
    // Patch only touches the 'Best by economics' line; other Section V lines are unchanged
    const blocked = makeCandidate({ symbolScope: "FETUSDT", direction: "SHORT", netAvgR: 0.05 });
    symbolRouteState.report = {
      ...symbolRouteState.report,
      candidateAssessments: [
        { symbol: "FETUSDT", direction: "SHORT", signalMultiplicityWarning: true, earlyPromisingBlocked: true },
      ],
    };
    const synthesis = makeMinimalSynthesis([blocked]);
    const report = buildDashboardAuditSummaryReport([], { adaptiveProfitPolicySynthesis: synthesis as never });
    // "Best by economics" is filtered
    expect(report.summaryText).toContain("Best by economics: none with credible effective evidence yet");
    // The overall Section V header remains
    expect(report.summaryText).toContain("V. ADAPTIVE PROFIT POLICY SYNTHESIS");
    // "Best ranked" and "Best SHORT/LONG" lines are still present (not filtered by this patch)
    expect(report.summaryText).toContain("- Best ranked (credibility-led):");
    expect(report.summaryText).toContain("- Best SHORT:");
    expect(report.summaryText).toContain("- Best LONG:");
  });

  it("Section V — existing no-synthesis fallback 'Best by economics: unavailable' still works", () => {
    // When adaptiveProfitPolicySynthesis is NOT supplied, the line says "unavailable"
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("Best by economics: unavailable");
  });
});

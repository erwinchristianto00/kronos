import type { FastifyInstance } from "fastify";
import { buildStrategyExperienceRecords, buildStrategyIntelligenceFoundationReport } from "@dtc/shared";

import type { ShadowExecutionEngine } from "../lib/shadow-engine.js";
import { buildExpansionReport } from "../lib/expansion-report.js";
import { buildRoutingMonitorReport } from "../lib/routing-monitor.js";
import { buildLiveReadinessReport } from "../lib/live-readiness.js";
import { buildRouteMaturityReport, type RouteMaturityEraFilter } from "../lib/route-maturity.js";
import { buildExpectationCalibrationReport } from "../lib/expectation-calibration.js";
import { buildCohortPerformanceReport } from "../lib/cohort-performance.js";
import { buildRegimeDriftReport } from "../lib/regime-drift.js";
import { buildProfitAnatomyReport } from "../lib/profit-anatomy.js";
import { buildCostAttributionReport } from "../lib/cost-attribution.js";
import { buildSymbolRouteAuditReport } from "../lib/symbol-route-audit.js";
import { buildEntryPrecisionAuditReport } from "../lib/entry-precision-audit.js";
import { buildWinnerLoserAuditReport } from "../lib/winner-loser-audit.js";
import { buildStopGeometryAuditReport } from "../lib/stop-geometry-audit.js";
import { buildSymbolRouteSuitabilityReport, type SuitabilityEvidenceEra } from "../lib/symbol-route-suitability.js";
import { buildAdaptiveGateIntelligenceReport, type AdaptiveGateEvidenceEra } from "../lib/adaptive-gate-intelligence.js";
import { buildRegimePolicyCounterfactualReport, type CounterfactualEvidenceEra } from "../lib/regime-policy-counterfactual.js";
import { buildAdaptiveRegimeGateOverlayPerformanceReport, type AdaptiveOverlayPerformanceEra } from "../lib/adaptive-gate-overlay-performance.js";
import { buildBaseRouteRiskHygieneMonitor } from "../lib/base-route-risk-hygiene-monitor.js";
import {
  buildFrozenCurrentGuardReport,
  getFrozenCurrentGuardStore,
  toFrozenObservations,
  type FrozenCurrentGuardReport,
} from "../lib/base-route-current-guard-frozen.js";
import {
  buildFrozenCurrentGuardCostModelReport,
  type FrozenCurrentGuardCostModelReport,
} from "../lib/frozen-current-guard-cost-model.js";
import { buildFrozenSegmentPathologyAudit } from "../lib/frozen-segment-pathology-audit.js";
import {
  buildPostCutoverReport,
  getPostCutoverStore,
  type PostCutoverReport,
} from "../lib/frozen-current-guard-post-cutover.js";
import { buildDashboardAuditSummaryReport, type DashboardAuditSummaryEra } from "../lib/dashboard-audit-summary.js";
import { buildRegimeDirectionControllerReport } from "../lib/regime-direction-controller.js";
import { getRegimeEdgeMemory } from "../lib/regime-edge-memory.js";
import { buildLiveTradingGateReport } from "../lib/live-trading-gate.js";
import {
  buildExchangeHealthReadinessReport,
  EXCHANGE_HEALTH_MAX_DATA_AGE_MS,
  type ExchangeHealthReadinessReport,
} from "../lib/exchange-health-readiness.js";
import {
  buildOrderReconciliationReadinessReport,
  type OrderReconciliationReadinessReport,
} from "../lib/order-reconciliation-readiness.js";
import {
  buildKillSwitchReadinessReport,
  type KillSwitchReadinessReport,
} from "../lib/micro-pilot-kill-switch-readiness.js";
import { buildOperatorBrief } from "../lib/operator-brief.js";
import { buildAdaptiveLaneRouterReport } from "../lib/adaptive-lane-router.js";
import {
  getPaperExecutionRouterStore,
  runPaperAdmissionAndResolution,
  admitPaperOpportunities,
  evaluatePaperLaneRotation,
  buildPaperPerformanceReport,
  buildPaperPerformanceBreakdown,
  buildPaperProvenanceAudit,
  simulateLoserFingerprintGate,
  derivePaperLaneConfidence,
  buildPaperLatencyDiagnostics,
  buildTimeboxedExitDiagnostic,
  buildTimeboxedExitDiagnosticBriefLines,
  buildFastTpTightDiagnostic,
  buildFastTpTightDiagnosticBriefLines,
  buildFastTpVariants,
  buildFastTpTrailSweepVariants,
  buildFastTpTrailGridVariants,
  rankFastTpReports,
  buildFastTpRankingBriefLines,
  buildEntryCohortDiagnostic,
  buildEntryCohortDiagnosticBriefLines,
  buildToxicSymbolGateDiagnostic,
  buildToxicSymbolGateDiagnosticBriefLines,
  buildSignalDecayDiagnostic,
  buildSignalDecayDiagnosticBriefLines,
  buildRegimeDirectionDiagnostic,
  buildRegimeDirectionDiagnosticBriefLines,
  buildForwardGateValidation,
  buildForwardGateValidationBriefLines,
  FORWARD_GATE_ID,
  type FastTpVariant,
  type FastTpVariantReport,
  PAPER_EXECUTION_MODEL_IDEAL,
  PAPER_EXECUTION_MODEL_REALISTIC,
  type PaperExecutionModel,
  type PaperPerformanceReport,
  type PaperProvenanceAudit,
  type ShadowLoserFingerprintGateReport,
  type PaperKlineTuple,
  type PaperLatencyDiagnostics,
} from "../lib/paper-execution-router.js";
import {
  buildMixedRegimeReport,
  buildOpenOrderStaleAudit,
  buildOpenOrderStaleAuditBriefLines,
  buildMixedLaneComparison,
  buildMixedLaneComparisonBriefLines,
  buildStalePassCohortDiagnostic,
  renderStalePassCohortDiagnostic,
  buildMixedAdmissionDecisionLedger,
  renderMixedAdmissionDecisionLedger,
  buildMixedCapacityOpportunityReplay,
  renderMixedCapacityOpportunityReplay,
  buildMixedCapacityBudgetSimulation,
  renderMixedCapacityBudgetSimulation,
  buildMixedBudgetForwardValidation,
  renderMixedBudgetForwardValidation,
  MIXED_LONG_WIDE_LANE,
  type MixedBudgetForwardValidationReport,
  type MixedRegimeReport,
} from "../lib/mixed-regime-router.js";
import {
  buildPaperOpportunityAllocatorReport,
  computeAutoQuarantinedVariantLanes,
  MANUAL_QUARANTINED_PAPER_LANE_IDS,
  type PaperOpportunityAllocatorReport,
  type AllocatorLaneState,
} from "../lib/paper-opportunity-allocator.js";
import { getLatestScanCandidates } from "../lib/latest-scan-candidates-cache.js";
import {
  getLatestScanTimingDiagnostics,
  recordAdmissionTimingTrace,
  type AdmissionTimingTrace,
} from "../lib/scan-timing-diagnostics.js";
import type {
  NotificationService,
  NotificationSnapshot,
} from "../lib/notification-service.js";

import { buildTechnicalStopTpCredibilityReport, type TechnicalStopTpEvidenceEra } from "../lib/technical-stop-tp-credibility.js";
import { buildUniverseRotationIntelligenceReport, type UniverseRotationEvidenceEra } from "../lib/universe-rotation-intelligence.js";
import {
  buildExternalCandidateDiscoveryIntelligenceReport,
  type ExternalDiscoveryEvidenceEra,
} from "../lib/external-candidate-discovery-intelligence.js";
import { fetchExternalCandidateMetadataSnapshotWithDiagnostics } from "../lib/external-candidate-metadata-fetcher.js";
import {
  buildExternalStrategyFitEnrichmentReport,
  fetchExternalStrategyFitTechnicalEvaluations,
  type ExternalStrategyFitEnrichmentReport,
} from "../lib/external-strategy-fit-enrichment.js";
import {
  JsonExternalRotationOverlayStore,
  refreshExternalRotationOverlayObservations,
  type ExternalRotationOverlayRefreshResult,
} from "../lib/external-rotation-overlay.js";
import {
  createExternalRotationOverlayAutoRefreshController,
  type ExternalRotationOverlayAutoRefreshStatus,
} from "../lib/external-rotation-overlay-auto-refresh.js";
import {
  buildExternalRotationOverlayPerformanceReport,
  type ExternalRotationOverlayPerformanceReport,
} from "../lib/external-rotation-overlay-performance.js";
import {
  buildExternalRotationOverlayEconomicsReport,
  type ExternalRotationOverlayEconomicsReport,
} from "../lib/external-rotation-overlay-economics.js";
import { buildTpSlGeometryRootCauseAuditReport } from "../lib/tp-sl-geometry-root-cause-audit.js";
import { buildAdaptiveProfitPolicySynthesisReport, type AdaptiveProfitPolicyEvidenceEra } from "../lib/adaptive-profit-policy.js";
import {
  JsonKronosCounterfactualStore,
  buildKronosCounterfactualReport,
  resolveKronosCounterfactualObservations,
  type KronosCounterfactualStore,
} from "../lib/kronos-counterfactual-lane.js";
import type { BinanceClient } from "../lib/binance.js";
import { UNIVERSE as CURRENT_SCANNER_UNIVERSE } from "../lib/scan-service.js";
import type { CoreScanAutoRefreshController } from "../lib/core-scan-auto-refresh.js";
import {
  getRegimeDirectionControllerSnapshotStore,
  buildSnapshotFromReport,
} from "../lib/regime-direction-controller-snapshot.js";
import { buildNeuralMapTelemetry, buildPaperUnrealizedSnapshot } from "../lib/neural-map-telemetry.js";
import { buildPerSymbolLaneBookEdge, type PsleOrder } from "../lib/per-symbol-lane-book-edge.js";
import { getLaneSymbolCurationCacheStore } from "../lib/lane-symbol-curation-cache.js";
import {
  runIntradayMomentumCycleGuarded,
  buildIntradayMomentumReport,
  getIntradayMomentumStore,
  IM_INTERVAL,
} from "../lib/intraday-momentum-edge.js";
import {
  runShortFadeCycleGuarded,
  buildShortFadeReport,
  getShortFadeStore,
  SF_INTERVAL,
} from "../lib/short-fade-edge.js";
import {
  runPanicWashoutCycleGuarded,
  buildPanicWashoutReport,
  getPanicWashoutStore,
  PWR_INTERVAL,
} from "../lib/panic-washout-reclaim-edge.js";
import {
  runRegimeCompositeCycleGuarded,
  buildRegimeCompositeReport,
  getRegimeCompositeStore,
  RC_INTERVAL,
  RC_UNIVERSE,
} from "../lib/regime-composite-edge.js";
import {
  runCompositeEstimatorCycleGuarded,
  buildCompositeEstimatorReport,
  getCompositeEstimatorStore,
  CE_INTERVAL,
  CE_UNIVERSE,
} from "../lib/composite-estimator-edge.js";
import {
  runResidualMomentumCycleGuarded,
  buildResidualMomentumReport,
  getResidualMomentumStore,
  RM_INTERVAL,
} from "../lib/residual-momentum-edge.js";
import {
  runLiquidationRecoilXsCycleGuarded,
  buildLiquidationRecoilXsReport,
  getLiquidationRecoilXsStore,
  LRX_INTERVAL,
} from "../lib/liquidation-recoil-cross-sectional.js";
import {
  runCompressionExpansionCycleGuarded,
  buildCompressionExpansionReport,
  getCompressionExpansionStore,
  CE_INTERVAL as CEE_INTERVAL,
  CE_UNIVERSE as CEE_UNIVERSE,
} from "../lib/compression-expansion-edge.js";
import type { KronosClient } from "../lib/kronos.js";
import { buildLaneVariantPboReport } from "../lib/walk-forward-validation.js";
import { buildMicrostructureSnapshot } from "../lib/order-flow-microstructure.js";
import { computeDecisionScore } from "../lib/decision-scoring.js";
import {
  assessPaperTp,
  readPaperTradingControls,
  roundTripCostPct,
  writePaperTradingControls,
} from "../lib/paper-trading-controls.js";
import {
  buildOosValidationSnapshot,
  createOosValidationSnapshotLoggerController,
  getOosValidationSnapshotStore,
  type OosValidationSnapshotTriggerSource,
} from "../lib/oos-validation-snapshot-logger.js";

import {
  RegimeControllerAlignedShadowStore,
  refreshExactExitCounterfactualsForResolvedObservations,
  resolveControllerAlignedShadowObservations,
} from "../lib/regime-controller-aligned-shadow.js";
import {
  getFilteredEdgeShadowStore,
  resolveFilteredEdgeShadowObservations,
  buildFilteredEdgeShadowReport,
  type FilteredEdgeShadowReport,
} from "../lib/regime-controller-filtered-edge-shadow.js";
import {
  getParallelShadowExperimentStore,
  resolveParallelShadowExperimentObservations,
  buildParallelShadowExperimentReport,
  type ParallelShadowExperimentReport,
} from "../lib/parallel-shadow-experiments.js";
import {
  getCurrentGuardVariantMatrixStore,
  selectVariantMatrixSignals,
  mirrorVariantMatrixSignals,
  resolveVariantMatrixObservations,
  buildCurrentGuardVariantMatrixReport,
  type CurrentGuardVariantMatrixReport,
  type KlineTuple as VariantMatrixKlineTuple,
} from "../lib/current-guard-variant-matrix.js";
import {
  getCrossSectionalStore,
  runCrossSectionalCycleGuarded,
  buildCrossSectionalReport,
  getCrossSectionalFilteredConfig,
  getCrossSectionalAdaptiveConfig,
  isCrossSectionalEdgeDisabled,
  CROSS_SECTIONAL_INTERVAL,
  CROSS_SECTIONAL_MOMENTUM_BARS,
  CROSS_SECTIONAL_UNIVERSE,
  buildCrossSectionalRegimeContext,
  deriveAdaptiveSymbolFilters,
  CROSS_SECTIONAL_TREND_SIGNAL,
  CROSS_SECTIONAL_MIXED_SIGNAL,
} from "../lib/cross-sectional-edge.js";
import { spotSymbolForCandles, buildWinnersCounterfactualReport } from "../lib/cross-sectional-winners-counterfactual.js";
import { buildRegimeAxisTimeline } from "../lib/regime-axis-timeline.js";
import { buildTpSweepReport } from "../lib/cross-sectional-tp-sweep.js";
import { CrossSectionalExecutorStore } from "../lib/cross-sectional-executor.js";
import { buildNarrativeTiltReport } from "../lib/narrative-tags.js";
import {
  isNewCoinRadarEnabled,
  getNewCoinRadarStore,
  runNewCoinRadarCycleGuarded,
  buildNewCoinRadarReport,
} from "../lib/new-coin-radar.js";
import { isMoonshotLotteryEnabled } from "../lib/moonshot-lottery-lane.js";
import {
  getMoonshotStore,
  runMoonshotCycleGuarded,
  buildMoonshotReport,
  resolveMoonshotMemeUniverse,
  MOONSHOT_DEFAULT_MAX_LEVERAGE,
} from "../lib/moonshot-lottery-cycle.js";
import { readFileSync } from "node:fs";
import { analyzeHardCutCounterfactuals, extractHardCutIntents } from "../lib/hard-cut-counterfactual.js";
import { getCandidateFunnelLog } from "../lib/accelerated-evidence-candidate-funnel-log.js";
import {
  buildPortfolioTrendShadowReport,
  getPortfolioTrendShadowStore,
  resolvePortfolioTrendPositions,
  type PortfolioTrendShadowReport,
} from "../lib/portfolio-trend-shadow.js";
import { buildRegimeEngineReport, getRegimeEngineStore, isRegimeEngineEnabled } from "../lib/regime-engine-service.js";
import { buildFreshVariantMatrixReport } from "../lib/fresh-variant-matrix-feed.js";
import { buildCrowdingReport } from "../lib/derivatives-crowding.js";
import { buildRegimeGatedLaneReport, type RgObservation } from "../lib/regime-gated-lane-performance.js";
import {
  getPriceImpactEfficiencyStore,
  runPriceImpactEfficiencyCycleGuarded,
  buildPriceImpactEfficiencyReport,
} from "../lib/price-impact-efficiency.js";

const mixedLaneIdForDirection = (direction: string | null | undefined): string =>
  direction === "LONG"
    ? MIXED_LONG_WIDE_LANE
    : "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "FALSE", "no", "NO"].includes(value);
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function registerShadowRoutes(
  app: FastifyInstance,
  shadowEngine: ShadowExecutionEngine | null,
  opts: {
    binanceClient?: BinanceClient;
    metadataFetchImpl?: typeof fetch;
    externalOverlayDataDir?: string;
    coreScanAutoRefreshController?: CoreScanAutoRefreshController;
    kronosCounterfactualStore?: KronosCounterfactualStore;
    notificationService?: NotificationService;
    /** 2026-07-09: COMPOSITE_ESTIMATOR_BIDI's per-symbol Kronos forecast input. Optional — absent
     *  just means that cycle's Kronos signal is always unavailable (composite falls back to
     *  axis level+velocity only, same as if every symbol's forecast individually failed). */
    kronosClient?: KronosClient;
    /** Lazy getter for the live-execution engine (created after this registration). Used READ-ONLY
     *  (sync getStatus, no I/O) to compute the order-reconciliation readiness gate. */
    liveEngineGetter?: () => { getStatus: () => unknown } | null;
  } = {},
): Promise<void> {
  const overlayStore = new JsonExternalRotationOverlayStore(opts.externalOverlayDataDir ?? "data");
  if (opts.notificationService) {
    opts.notificationService.setSnapshotProvider(() => {
      const scanStatus = opts.coreScanAutoRefreshController?.getStatus() ?? null;
      const currentRegime = scanStatus?.lastAutoRefreshResultSummary?.marketRegime ?? null;
      const notificationRegime = buildRegimeDirectionControllerReport({
        currentRegime,
        adaptiveDirectionBias: null,
        primaryValidationLane: null,
      });
      const notificationPaperReport = buildPaperPerformanceReport(getPaperExecutionRouterStore());
      const notificationValidation = buildMixedBudgetForwardValidation(
        getPaperExecutionRouterStore().getState().orders,
      );
      const latestOrder = notificationPaperReport.latestOrders[0] ?? null;
      return {
        regime: notificationRegime.currentRegime ?? null,
        mode: notificationRegime.controllerMode ?? null,
        bias: notificationRegime.directionalBias ?? null,
        confidence: notificationRegime.confidence ?? null,
        paperPnl: notificationPaperReport.realizedPaperPnl,
        diagnosticPnl: notificationPaperReport.diagnosticRealizedPaperPnl,
        totalPaperPnl: notificationPaperReport.totalRealizedPaperPnl,
        startingBalance: notificationPaperReport.startingEquity,
        headlineBalance:
          notificationPaperReport.startingEquity +
          notificationPaperReport.realizedPaperPnl,
        totalBalance:
          notificationPaperReport.startingEquity +
          notificationPaperReport.totalRealizedPaperPnl,
        monthTotalPaperPnl: notificationPaperReport.monthTotalPaperPnl,
        todayClosed: notificationPaperReport.taipeiDailyClosed,
        todayWins: notificationPaperReport.taipeiDailyWins,
        todayLosses: notificationPaperReport.taipeiDailyLosses,
        todayHeadlinePnl: notificationPaperReport.taipeiDailyHeadlinePnl,
        todayDiagnosticPnl: notificationPaperReport.taipeiDailyDiagnosticPnl,
        todayTotalPnl: notificationPaperReport.taipeiDailyTotalPnl,
        dailyPnl: notificationPaperReport.dailyPaperPnl,
        headlineNet: notificationPaperReport.headlineNetAvgR,
        headlinePF: notificationPaperReport.headlinePF,
        headlineWR: notificationPaperReport.headlineWR,
        guardrailStatus: notificationValidation.guardrail.status,
        recommendedAction: notificationValidation.guardrail.recommendedAction,
        guardrailReasons: notificationValidation.guardrail.reasons,
        activeMixedBudgetProfile: notificationValidation.activeMixedBudgetProfile,
        closedUnderProfileCount: notificationValidation.closedUnderProfileCount,
        forwardVerdict: notificationValidation.verdict,
        totalOrders: notificationPaperReport.total,
        openOrders: notificationPaperReport.open,
        closedOrders: notificationPaperReport.closed,
        wins: notificationPaperReport.win,
        losses: notificationPaperReport.loss,
        latestOrder: latestOrder
          ? {
              symbol: latestOrder.symbol,
              direction: latestOrder.direction,
              lane: latestOrder.selectedLaneId,
              admission: latestOrder.admissionResult ?? null,
              profile: latestOrder.mixedBudgetProfile ?? null,
              occupancyMode: latestOrder.occupancyMode ?? null,
              riskMultiplier: latestOrder.riskMultiplierAfterOccupancy ?? null,
            }
          : null,
      };
    });
  }
  // Kronos counterfactual lane store — same dataDir as overlay store by default.
  // Isolated file (kronos-counterfactual-observations.json); shared with scan.ts emit path.
  const kronosCounterfactualStore: KronosCounterfactualStore =
    opts.kronosCounterfactualStore ?? new JsonKronosCounterfactualStore(opts.externalOverlayDataDir ?? "data");
  // Report-only controller-aligned shadow store — reads data from
  // data/regime-controller-aligned-shadow.json (written by scan.ts).
  const controllerAlignedShadowStore = new RegimeControllerAlignedShadowStore(
    opts.externalOverlayDataDir ?? "data",
  );
  const autoRefreshEnabled = parseBooleanEnv(
    process.env.EXTERNAL_ROTATION_OVERLAY_AUTO_REFRESH_ENABLED,
    !Boolean(process.env.VITEST),
  ) && Boolean(shadowEngine) && Boolean(opts.binanceClient);
  const autoRefreshIntervalMinutes = parsePositiveIntEnv(
    process.env.EXTERNAL_ROTATION_OVERLAY_AUTO_REFRESH_MINUTES,
    30,
  );
  async function buildExternalStrategyFitForEra(evidenceEra: ExternalDiscoveryEvidenceEra): Promise<ExternalStrategyFitEnrichmentReport> {
    if (!shadowEngine || !opts.binanceClient) {
      throw new Error("External strategy-fit enrichment requires shadow engine and Binance client.");
    }
    const records = buildStrategyExperienceRecords(shadowEngine.getAllPositions());
    const rotationReport = buildUniverseRotationIntelligenceReport(records, { evidenceEra });
    const currentUniverseSymbols = [...CURRENT_SCANNER_UNIVERSE];
    const externalMetadataResult = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols,
      fetchImpl: opts.metadataFetchImpl,
    });
    const discoveryReport = buildExternalCandidateDiscoveryIntelligenceReport({
      records,
      currentUniverseSymbols,
      externalCandidateMetadata: externalMetadataResult.metadata,
      metadataDiagnostics: externalMetadataResult.diagnostics,
      promisingFingerprints: rotationReport.promisingFingerprints,
      toxicFingerprints: rotationReport.toxicFingerprints,
      evidenceEra,
    });
    const technicalEvaluations = await fetchExternalStrategyFitTechnicalEvaluations({
      discoveryReport,
      binanceClient: opts.binanceClient,
      maxCandidates: 10,
    });
    return buildExternalStrategyFitEnrichmentReport({
      discoveryReport,
      technicalEvaluations,
      maxCandidates: 10,
    });
  }
  async function runOverlayRefresh(
    evidenceEra: ExternalDiscoveryEvidenceEra,
    triggerSource: "AUTO" | "MANUAL",
  ): Promise<ExternalRotationOverlayRefreshResult> {
    if (!shadowEngine || !opts.binanceClient) {
      throw new Error("External rotation overlay refresh requires shadow engine and Binance client.");
    }
    const enrichmentReport = await buildExternalStrategyFitForEra(evidenceEra);
    const allRecords = buildStrategyExperienceRecords(shadowEngine.getAllPositions());
    const overlayState = overlayStore.readState();
    const externalRotationOverlay = buildExternalRotationOverlayPerformanceReport(overlayState.observations, {
      evidenceEra,
      lastRefreshDiagnostics: overlayState.latestRefreshDiagnostics ?? null,
      autoRefreshStatus: overlayAutoRefreshController.getStatus(),
    });
    const externalRotationOverlayEconomics = buildExternalRotationOverlayEconomicsReport(
      overlayState.observations,
      { evidenceEra },
    );
    const adaptiveProfitPolicySynthesis = buildAdaptiveProfitPolicySynthesisReport(
      allRecords,
      {
        evidenceEra,
        externalRotationOverlay,
        externalRotationOverlayEconomics,
      },
    );
    const refreshResult = await refreshExternalRotationOverlayObservations({
      store: overlayStore,
      enrichmentReport,
      binanceClient: opts.binanceClient,
      adaptiveProfitPolicySynthesis,
      triggerSource,
    });
    // Piggyback Kronos counterfactual resolution on the same cadence and
    // binance client. Failures are isolated and must never break the
    // overlay refresh path or live trading.
    try {
      if (opts.binanceClient) {
        await resolveKronosCounterfactualObservations({
          store: kronosCounterfactualStore,
          binanceClient: opts.binanceClient,
          triggerSource,
        });
      }
    } catch {
      // counterfactual resolution must never break overlay refresh
    }
    // Report-only: resolve controller-aligned shadow observations.
    // Isolated from live behavior. Fire-and-forget — never await, never block.
    try {
      if (opts.binanceClient) {
        const _bc = opts.binanceClient;
        resolveControllerAlignedShadowObservations(controllerAlignedShadowStore, {
          getCandles: async (symbol, _intervalMinutes, since) => {
            const sinceMs = new Date(since).getTime();
            const nowMs = Date.now();
            const limit = Math.min(Math.max(Math.ceil((nowMs - sinceMs) / 300000) + 2, 12), 500);
            const candles = await _bc.getCandles(symbol, "5m", limit, {
              startTime: sinceMs,
              endTime: nowMs,
            });
            return candles
              .filter((c) => c.openTime > sinceMs && c.openTime <= nowMs)
              .map((c) => ({
                openTime: c.openTime,
                high: c.high,
                low: c.low,
                close: c.close,
              }));
          },
          noFillWindowMs: 4 * 60 * 60 * 1000,
          expiryWindowMs: 72 * 60 * 60 * 1000,
        }).catch(() => {}); // fire-and-forget: never block overlay refresh
        // Backfill exact exit counterfactuals for already-resolved observations.
        // Fire-and-forget, report-only — never blocks the response path.
        refreshExactExitCounterfactualsForResolvedObservations(
          controllerAlignedShadowStore,
          _bc,
          { batchSize: 20 },
        ).catch(() => {}); // fire-and-forget, report-only
      }
    } catch {
      // controller-aligned shadow resolution must never break overlay refresh
    }
    return refreshResult;
  }
  const overlayAutoRefreshController = createExternalRotationOverlayAutoRefreshController({
    enabled: autoRefreshEnabled,
    intervalMinutes: autoRefreshIntervalMinutes,
    evidenceEra: "POST_CALIBRATION",
    runRefresh: runOverlayRefresh,
  });
  const oosSnapshotStore = getOosValidationSnapshotStore(opts.externalOverlayDataDir ?? "data");
  const oosSnapshotEnabledEnv =
    process.env.OOS_VALIDATION_SNAPSHOT_LOGGER_ENABLED ??
    process.env.OOS_VALIDATION_SNAPSHOT_ENABLED;
  const oosSnapshotLoggerEnabled = parseBooleanEnv(
    oosSnapshotEnabledEnv,
    !Boolean(process.env.VITEST) && Boolean(shadowEngine),
  );
  const oosSnapshotIntervalMinutes = parsePositiveIntEnv(
    process.env.OOS_VALIDATION_SNAPSHOT_LOGGER_MINUTES ??
      process.env.OOS_VALIDATION_SNAPSHOT_INTERVAL_MINUTES,
    15,
  );
  function captureOosValidationSnapshot(
    triggerSource: OosValidationSnapshotTriggerSource,
    capturedAt: string,
  ) {
    let postCutoverReport: PostCutoverReport | undefined;
    try {
      if (!process.env.FROZEN_CURRENT_GUARD_DISABLED) {
        const frozenReport = buildFrozenCurrentGuardReport(getFrozenCurrentGuardStore());
        const boundary = getPostCutoverStore().getBoundary();
        postCutoverReport = buildPostCutoverReport(frozenReport, boundary, null, { capturedAt });
      }
    } catch {
      // scheduled snapshot must never affect route behavior
    }

    let variantMatrixReport: CurrentGuardVariantMatrixReport | undefined;
    try {
      if (process.env.CURRENT_GUARD_VARIANT_MATRIX_DISABLED !== "1") {
        variantMatrixReport = buildCurrentGuardVariantMatrixReport(getCurrentGuardVariantMatrixStore(), {
          capturedAt,
          cutoverTimestamp: postCutoverReport?.boundary?.cutoverTimestamp ?? null,
        });
      }
    } catch {
      // scheduled snapshot must never affect route behavior
    }

    return buildOosValidationSnapshot({
      capturedAt,
      triggerSource,
      era: "POST_CALIBRATION",
      postCutoverReport,
      variantMatrixReport,
    });
  }
  const oosValidationSnapshotLoggerController = createOosValidationSnapshotLoggerController({
    enabled: oosSnapshotLoggerEnabled,
    intervalMinutes: oosSnapshotIntervalMinutes,
    store: oosSnapshotStore,
    captureSnapshot: captureOosValidationSnapshot,
  });
  app.addHook("onReady", async () => {
    overlayAutoRefreshController.start();
    oosValidationSnapshotLoggerController.start();
  });
  app.addHook("onClose", async () => {
    overlayAutoRefreshController.stop();
    oosValidationSnapshotLoggerController.stop();
  });

  app.get("/api/shadow", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return shadowEngine.getSnapshot();
  });

  app.get("/api/shadow/oos-validation-snapshot-status", async () => ({
    reportOnly: true,
    liveBlocked: true,
    microPilotAllowed: false,
    logger: oosValidationSnapshotLoggerController.getStatus(),
    path: oosSnapshotStore.path,
    latest: oosSnapshotStore.readTail(5),
  }));

  app.get("/api/shadow/expansion", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildExpansionReport(shadowEngine.getAllPositions(), null);
  });

  // Report-only Kronos counterfactual evidence. No live behavior, scoring, or
  // ranking is affected by this endpoint.
  app.get("/api/shadow/kronos-counterfactual", async (_request, _reply) => {
    const state = kronosCounterfactualStore.readState();
    return {
      report: buildKronosCounterfactualReport(state.observations),
      latestRefreshDiagnostics: state.latestRefreshDiagnostics ?? null,
    };
  });

  // Winners-only counterfactual (report-only): tests the operator's "open only the good legs"
  // hypothesis against closed-basket history — oracle ceiling + realistic late-entry checkpoints
  // + leg persistence stats. Fetches real 1h candles (a few calls per distinct symbol), so the
  // result is cached for 10 min; ?force=1 recomputes, ?variant=X selects the lane variant.
  let winnersCfCache: { key: string; builtAtMs: number; report: unknown } | null = null;
  app.get("/api/shadow/cross-sectional-winners-counterfactual", async (request, reply) => {
    if (!opts.binanceClient) {
      reply.code(503);
      return { ok: false, reason: "market-data client unavailable on this instance" };
    }
    const q = (request.query ?? {}) as { variant?: string; force?: string };
    const variant = q.variant ?? "FILTERED";
    const nowMs = Date.now();
    if (q.force !== "1" && winnersCfCache && winnersCfCache.key === variant && nowMs - winnersCfCache.builtAtMs < 10 * 60_000) {
      return { ok: true, cached: true, ...(winnersCfCache.report as object) };
    }
    const client = opts.binanceClient;
    const fetchCandles = async (symbol: string, startMs: number, endMs: number) => {
      // 1h candles, 1000/call ≈ 41 days — loop only if the basket history spans longer than that.
      const out = [] as Awaited<ReturnType<typeof client.getCandles>>;
      let cursor = startMs;
      while (cursor < endMs) {
        const batch = await client.getCandles(symbol, "1h", 1000, { startTime: cursor, endTime: endMs });
        if (batch.length === 0) break;
        out.push(...batch);
        const last = batch[batch.length - 1]!.openTime;
        if (last <= cursor) break; // no forward progress — bail rather than loop forever
        cursor = last + 3_600_000;
      }
      return out;
    };
    const report = await buildWinnersCounterfactualReport(getCrossSectionalStore(), fetchCandles, { variant });
    winnersCfCache = { key: variant, builtAtMs: nowMs, report };
    return { ok: true, cached: false, ...report };
  });

  // TP-threshold sweep (report-only): per-basket path replay comparing profit-bank thresholds —
  // answers "keep 0.6% or bank smaller/more often?" via EV per slot-day. Same candle-fetch cost
  // profile as the winners counterfactual, so same 10-min cache.
  let tpSweepCache: { key: string; builtAtMs: number; report: unknown } | null = null;
  app.get("/api/shadow/cross-sectional-tp-sweep", async (request, reply) => {
    if (!opts.binanceClient) {
      reply.code(503);
      return { ok: false, reason: "market-data client unavailable on this instance" };
    }
    const q = (request.query ?? {}) as { variant?: string; force?: string };
    const variant = q.variant ?? "FILTERED";
    const nowMs = Date.now();
    if (q.force !== "1" && tpSweepCache && tpSweepCache.key === variant && nowMs - tpSweepCache.builtAtMs < 10 * 60_000) {
      return { ok: true, cached: true, ...(tpSweepCache.report as object) };
    }
    const client = opts.binanceClient;
    const fetchCandles = async (symbol: string, startMs: number, endMs: number) => {
      const out = [] as Awaited<ReturnType<typeof client.getCandles>>;
      let cursor = startMs;
      while (cursor < endMs) {
        const batch = await client.getCandles(symbol, "1h", 1000, { startTime: cursor, endTime: endMs });
        if (batch.length === 0) break;
        out.push(...batch);
        const last = batch[batch.length - 1]!.openTime;
        if (last <= cursor) break;
        cursor = last + 3_600_000;
      }
      return out;
    };
    const report = await buildTpSweepReport(getCrossSectionalStore(), fetchCandles, { variant });
    tpSweepCache = { key: variant, builtAtMs: nowMs, report };
    return { ok: true, cached: false, ...report };
  });

  // Narrative tilt/edge (report-only): tags every basket leg with its sector narrative
  // (AI/MEME/L1/DeFi/…) and measures (a) whether the "market-neutral" book is secretly a
  // sector spread and (b) whether any narrative's legs carry edge. Measure-first — nothing
  // gates on this. Executed baskets come from the executor's persisted store snapshot
  // (read-only re-read per request; the file is tiny), measured obs from the signal store.
  app.get("/api/shadow/narrative-tilt-report", async (request) => {
    const q = (request.query ?? {}) as { variant?: string };
    const executorStore = new CrossSectionalExecutorStore(opts.externalOverlayDataDir ?? "data");
    return {
      ok: true,
      ...buildNarrativeTiltReport({
        measuredObservations: getCrossSectionalStore().all,
        executedBaskets: executorStore.getState().baskets,
        variant: q.variant ?? "FILTERED",
        nowIso: new Date().toISOString(),
      }),
    };
  });

  // Cross-sectional market-neutral measurement lane — report + open/closed baskets (report-only).
  app.get("/api/shadow/cross-sectional-report", async () => {
    const store = getCrossSectionalStore();
    const slim = (o: {
      openedAt: string;
      resolvedAt: string | null;
      netReturn: number | null;
      grossReturn: number | null;
      signal: string;
      variant?: string;
      strategyFamily?: string;
      scoreGap?: number | null;
      regimeClassAtOpen?: string | null;
      regimeContext?: { currentRegime: string | null; controllerMode: string | null; directionalBias: string | null; confidence: string | null } | null;
      exitReason?: string | null;
      longCapitalWeight?: number | null;
      shortCapitalWeight?: number | null;
      weightingModel?: string | null;
      longLeg: { symbol: string; weight?: number | null }[];
      shortLeg: { symbol: string; weight?: number | null }[];
    }) => ({
      openedAt: o.openedAt,
      resolvedAt: o.resolvedAt,
      signal: o.signal,
      variant: o.variant ?? "RAW",
      strategyFamily: o.strategyFamily ?? null,
      scoreGap: o.scoreGap ?? null,
      regimeClass: o.regimeClassAtOpen ?? o.regimeContext?.controllerMode ?? null,
      regime: o.regimeContext?.currentRegime ?? null,
      controllerMode: o.regimeContext?.controllerMode ?? null,
      directionalBias: o.regimeContext?.directionalBias ?? null,
      exitReason: o.exitReason ?? null,
      longCapitalWeight: o.longCapitalWeight ?? null,
      shortCapitalWeight: o.shortCapitalWeight ?? null,
      weightingModel: o.weightingModel ?? null,
      netReturnPct: o.netReturn != null ? o.netReturn * 100 : null,
      grossReturnPct: o.grossReturn != null ? o.grossReturn * 100 : null,
      long: o.longLeg.map((l) => l.symbol),
      short: o.shortLeg.map((l) => l.symbol),
      longWeights: o.longLeg.map((l) => ({ symbol: l.symbol, weight: l.weight ?? null })),
      shortWeights: o.shortLeg.map((l) => ({ symbol: l.symbol, weight: l.weight ?? null })),
    });
    const filteredSignal = getCrossSectionalFilteredConfig().signal;
    const raw = store.all.filter((o) => o.signal !== filteredSignal && o.signal !== CROSS_SECTIONAL_TREND_SIGNAL && o.signal !== CROSS_SECTIONAL_MIXED_SIGNAL);
    const filtered = store.all.filter((o) => o.signal === getCrossSectionalFilteredConfig().signal);
    const trend = store.all.filter((o) => o.signal === CROSS_SECTIONAL_TREND_SIGNAL);
    const mixed = store.all.filter((o) => o.signal === CROSS_SECTIONAL_MIXED_SIGNAL);
    return {
      report: buildCrossSectionalReport(store),
      filteredReport: buildCrossSectionalReport(store, Date.now(), { variant: "FILTERED" }),
      trendReport: buildCrossSectionalReport(store, Date.now(), { variant: "TREND_BETA_VOL" }),
      mixedReport: buildCrossSectionalReport(store, Date.now(), { variant: "MIXED_MEAN_REVERSION" }),
      // filteredConfig shows the EFFECTIVE (auto-updated) lists — what new FILTERED
      // baskets actually use — so /research always displays the live white/blacklists.
      filteredConfig: (() => {
        const adaptive = deriveAdaptiveSymbolFilters(store);
        return {
          ...getCrossSectionalFilteredConfig(),
          longAllowlist: adaptive.longAllowlist,
          shortAllowlist: adaptive.shortAllowlist,
          shortBlocklist: adaptive.shortBlocklist,
        };
      })(),
      adaptiveConfig: getCrossSectionalAdaptiveConfig(),
      // Auto-updating symbol filters ACTUALLY used to mint new FILTERED baskets
      // (env lists = prior, measured per-leg returns promote/demote each cycle) + provenance.
      adaptiveSymbolFilters: deriveAdaptiveSymbolFilters(store),
      openBaskets: raw.filter((o) => o.status === "OPEN").map(slim),
      filteredOpenBaskets: filtered.filter((o) => o.status === "OPEN").map(slim),
      trendOpenBaskets: trend.filter((o) => o.status === "OPEN").map(slim),
      mixedOpenBaskets: mixed.filter((o) => o.status === "OPEN").map(slim),
      recentClosed: raw.filter((o) => o.status === "CLOSED").slice(-15).map(slim),
      filteredRecentClosed: filtered.filter((o) => o.status === "CLOSED").slice(-15).map(slim),
      trendRecentClosed: trend.filter((o) => o.status === "CLOSED").slice(-15).map(slim),
      mixedRecentClosed: mixed.filter((o) => o.status === "CLOSED").slice(-15).map(slim),
    };
  });

  // Hard-cut counterfactual: for each anti-bull hard-cut that already fired, replay the forward price
  // and compare cutting vs riding to the stop — measures whether the 30-min threshold actually helps.
  // Reads the testnet live engine's intents off the shared VPS filesystem (report-only, no engine touch).
  app.get("/api/shadow/hard-cut-counterfactual", async () => {
    const path = process.env.HARD_CUT_CF_INTENTS_PATH
      ?? "/root/kronos-testnet/daily-trading-cockpit-v2/apps/api/data/live-execution.json";
    let state: { intents?: unknown[] } | null = null;
    try {
      state = JSON.parse(readFileSync(path, "utf-8")) as { intents?: unknown[] };
    } catch {
      state = null;
    }
    const intents = extractHardCutIntents(state);
    if (!opts.binanceClient) {
      return { available: false, reason: "market client unavailable", hardCutsFound: intents.length };
    }
    const bc = opts.binanceClient;
    return analyzeHardCutCounterfactuals(
      intents,
      async (symbol, startMs, endMs) => bc.getCandles(symbol, "15m", 200, { startTime: startMs, endTime: endMs }),
      { windowMs: 12 * 60 * 60_000, nowMs: Date.now() },
    );
  });

  // Fresh VM-feed report — the honest fresh-entry measurement view. Registered on
  // every instance; only the "/" diagnostic instance (FRESH_VM_FEED_ENABLED=1) has
  // meaningful fresh intake, elsewhere it just reports whatever the store holds.
  app.get("/api/shadow/fresh-variant-matrix-report", async () => {
    return buildFreshVariantMatrixReport(getCurrentGuardVariantMatrixStore());
  });

  // Derivatives crowding — live funding/OI/taker snapshot per universe symbol. Each snapshot now
  // also carries flowConfirmed (2026-07-10, Tier-1 audit item 1): whether the already-fetched
  // takerBuySellRatio agrees with the crowdingState direction — see classifyCrowdingStateWithFlow's
  // doc comment in derivatives-crowding.ts for the exact rule. Report-only; not read by any gate.
  app.get("/api/shadow/crowding-report", async (_request, reply) => {
    if (!opts.binanceClient) {
      reply.code(503);
      return { error: "NO_MARKET_CLIENT", message: "binance market-data client unavailable" };
    }
    return buildCrowdingReport(opts.binanceClient, [...CURRENT_SCANNER_UNIVERSE].slice(0, 15), new Date().toISOString());
  });

  // Price-impact efficiency (Tier 2 audit item #6, report-only): absolutePriceMove / aggressiveNotional
  // per 5m bucket, buy/sell split, with own-history + cluster-relative z-scores (see
  // price-impact-efficiency.ts's header for the exact windowing). Live-fetches + persists a fresh
  // reading per universe symbol on each call (same universe-slicing convention as crowding-report),
  // then returns the accumulated store's per-symbol snapshots. This is the underlying z-score
  // machinery for the documented gap where decision-scoring.ts's fundingZScore is hardcoded null —
  // wiring it in there is separate follow-up work, not done by this route.
  app.get("/api/shadow/price-impact-efficiency-report", async (_request, reply) => {
    if (!opts.binanceClient) {
      reply.code(503);
      return { error: "NO_MARKET_CLIENT", message: "binance market-data client unavailable" };
    }
    const pieStore = getPriceImpactEfficiencyStore();
    await runPriceImpactEfficiencyCycleGuarded({
      store: pieStore,
      client: opts.binanceClient,
      symbols: [...CURRENT_SCANNER_UNIVERSE].slice(0, 15),
      nowMs: Date.now(),
    });
    return buildPriceImpactEfficiencyReport(pieStore);
  });

  // Regime switching engine — REPORT-ONLY history of what the hypothesis framework
  // (breadth + contextFromCandles + buildTradingDecision) decides each cycle on
  // real Binance data. Cycle runs from scan.ts when REGIME_ENGINE_ENABLED=1.
  app.get("/api/shadow/regime-engine-report", async () => ({
    enabled: isRegimeEngineEnabled(),
    ...buildRegimeEngineReport(),
  }));

  // MOONSHOT_LOTTERY_LANE measurement report — daily budget state + recent signals/rejections
  // (report-only; nothing trades on this, live execution would be a separate operator-gated build).
  app.get("/api/shadow/moonshot-report", async () => buildMoonshotReport(getMoonshotStore(), Date.now()));

  // New-coin radar (report-only): recently-listed Binance perps + fundamental profile per coin
  // (deskripsi/teknologi/manfaat, mcap vs FDV, circulating ratio, dev activity). Nothing trades
  // from this — universe promotion stays a manual operator decision.
  app.get("/api/shadow/new-coin-radar", async () => buildNewCoinRadarReport(getNewCoinRadarStore(), Date.now()));

  // Regime-axis timeline: a continuous signed score (breadth composite, 0 = neutral zone) over
  // the regime engine's snapshot history, so the dashboard can show WHERE the regime sits and
  // how fast it is drifting toward/away from neutral (see regime-axis-timeline.ts's honesty
  // contract — the ETA is an extrapolation, not a forecast).
  app.get("/api/shadow/regime-axis-timeline", async () => ({
    enabled: isRegimeEngineEnabled(),
    generatedAt: new Date().toISOString(),
    ...buildRegimeAxisTimeline(getRegimeEngineStore().snapshots),
  }));

  app.get("/api/shadow/regime-gated-lanes", async () => {
    const observations: RgObservation[] = [];
    for (const o of getCurrentGuardVariantMatrixStore().all) {
      if (o.direction !== "LONG" && o.direction !== "SHORT") continue;
      observations.push({
        variantId: String(o.variantId),
        direction: o.direction,
        regime: o.regime,
        posture: o.posture,
        regimeDirection: o.regimeDirection,
        entryVariant: o.entryVariant,
        crowdingState: o.crowdingState,
        netR: o.netR,
      });
    }
    return buildRegimeGatedLaneReport(observations);
  });

  app.get("/api/shadow/routing-monitor", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildRoutingMonitorReport(shadowEngine.getAllPositions());
  });

  app.get("/api/shadow/expectation-calibration", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildExpectationCalibrationReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/route-maturity", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: RouteMaturityEraFilter[] = ["ALL_TIME", "POST_ROUTING", "POST_CALIBRATION"];
    const raw = request.query?.era;
    // UI default = POST_CALIBRATION (per spec); endpoint applies it explicitly
    // so the function-level default stays backward-compatible for other callers.
    const eraFilter: RouteMaturityEraFilter = (allowed as string[]).includes(raw ?? "")
      ? (raw as RouteMaturityEraFilter)
      : "POST_CALIBRATION";
    return buildRouteMaturityReport({ positions: shadowEngine.getAllPositions(), eraFilter });
  });

  app.get("/api/shadow/cohort-performance", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildCohortPerformanceReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get("/api/shadow/regime-drift", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildRegimeDriftReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get("/api/shadow/cost-attribution", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildCostAttributionReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get("/api/shadow/profit-anatomy", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildProfitAnatomyReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get("/api/shadow/entry-precision-audit", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildEntryPrecisionAuditReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get("/api/shadow/symbol-route-audit", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildSymbolRouteAuditReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get("/api/shadow/stop-geometry-audit", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildStopGeometryAuditReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get("/api/shadow/winner-loser-audit", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildWinnerLoserAuditReport({ positions: shadowEngine.getAllPositions() });
  });

  app.get("/api/shadow/strategy-intelligence-foundation", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    return buildStrategyIntelligenceFoundationReport(shadowEngine.getAllPositions());
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/symbol-route-suitability", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: SuitabilityEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: SuitabilityEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as SuitabilityEvidenceEra)
      : "POST_CALIBRATION";
    const records = buildStrategyExperienceRecords(shadowEngine.getAllPositions());
    return buildSymbolRouteSuitabilityReport(records, { evidenceEra });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/adaptive-gate-intelligence", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: AdaptiveGateEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: AdaptiveGateEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as AdaptiveGateEvidenceEra)
      : "POST_CALIBRATION";
    const positions = shadowEngine.getAllPositions();
    const records = buildStrategyExperienceRecords(positions);
    return buildAdaptiveGateIntelligenceReport(records, { evidenceEra, positions });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/regime-policy-counterfactual", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: CounterfactualEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: CounterfactualEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as CounterfactualEvidenceEra)
      : "POST_CALIBRATION";
    const records = buildStrategyExperienceRecords(shadowEngine.getAllPositions());
    return buildRegimePolicyCounterfactualReport(records, { evidenceEra });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/adaptive-gate-overlay-performance", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: AdaptiveOverlayPerformanceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: AdaptiveOverlayPerformanceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as AdaptiveOverlayPerformanceEra)
      : "POST_CALIBRATION";
    const records = buildStrategyExperienceRecords(shadowEngine.getAllPositions());
    return buildAdaptiveRegimeGateOverlayPerformanceReport(records, { evidenceEra });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/dashboard-audit-summary", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: DashboardAuditSummaryEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const era: DashboardAuditSummaryEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as DashboardAuditSummaryEra)
      : "POST_CALIBRATION";
    const allPositions = shadowEngine.getAllPositions();
    const allRecords = buildStrategyExperienceRecords(allPositions);
    const currentUniverseSymbols = [...CURRENT_SCANNER_UNIVERSE];
    const externalMetadataResult = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols,
      fetchImpl: opts.metadataFetchImpl,
    });
    let externalStrategyFitEnrichment: ExternalStrategyFitEnrichmentReport | undefined;
    let externalRotationOverlay: ExternalRotationOverlayPerformanceReport | undefined;
    let externalRotationOverlayEconomics: ExternalRotationOverlayEconomicsReport | undefined;
    let tpSlGeometryRootCauseAudit: ReturnType<typeof buildTpSlGeometryRootCauseAuditReport> | undefined;
    let adaptiveProfitPolicySynthesis: ReturnType<typeof buildAdaptiveProfitPolicySynthesisReport> | undefined;
    if (opts.binanceClient) {
      externalStrategyFitEnrichment = await buildExternalStrategyFitForEra(era);
      const overlayState = overlayStore.readState();
      externalRotationOverlay = buildExternalRotationOverlayPerformanceReport(overlayState.observations, {
        evidenceEra: era,
        lastRefreshDiagnostics: overlayState.latestRefreshDiagnostics ?? null,
        autoRefreshStatus: overlayAutoRefreshController.getStatus(),
      });
      externalRotationOverlayEconomics = buildExternalRotationOverlayEconomicsReport(
        overlayState.observations,
        { evidenceEra: era },
      );
      tpSlGeometryRootCauseAudit = buildTpSlGeometryRootCauseAuditReport(
        overlayState.observations,
        { evidenceEra: era },
      );
    }
    adaptiveProfitPolicySynthesis = buildAdaptiveProfitPolicySynthesisReport(
      allRecords,
      {
        evidenceEra: era,
        externalRotationOverlay,
        externalRotationOverlayEconomics,
      },
    );
    const baseRouteRiskHygieneMonitor = buildBaseRouteRiskHygieneMonitor(
      allPositions,
      typeof shadowEngine.getExecutionLog === "function" ? shadowEngine.getExecutionLog() : [],
      { era },
    );
    // Report-only: mirror qualifying current-guard observations into the isolated
    // frozen prospective tape (F***). Fire-and-forget; never throws; only MIRRORS
    // already-qualifying observations. Does NOT touch shadow-positions.json or
    // change base route admission. Criteria frozen + immutable at first mirror.
    let frozenCurrentGuardReport: FrozenCurrentGuardReport | undefined;
    let frozenObservationsForCostModel: import("../lib/base-route-current-guard-frozen.js").FrozenCurrentGuardObservation[] = [];
    try {
      if (!process.env.FROZEN_CURRENT_GUARD_DISABLED) {
        const frozenStore = getFrozenCurrentGuardStore();
        const qualifying = toFrozenObservations(
          baseRouteRiskHygieneMonitor.currentGuardClosedPositions ?? [],
        );
        frozenStore.mirror(qualifying);
        frozenCurrentGuardReport = buildFrozenCurrentGuardReport(frozenStore);
        frozenObservationsForCostModel = frozenStore.all ?? [];
      }
    } catch {
      // frozen prospective tape must never break the dashboard
    }
    // Report-only: resolve and build filtered edge shadow report.
    // Fire-and-forget resolver — never blocks the response path.
    // Isolated from live behavior. Never throws.
    let filteredEdgeReport: FilteredEdgeShadowReport | undefined;
    try {
      const filteredStore = getFilteredEdgeShadowStore();
      if (opts.binanceClient) {
        const _fbc = opts.binanceClient;
        resolveFilteredEdgeShadowObservations(filteredStore, {
          getKlines: async (symbol: string, interval: string, opts: { startTime: number; endTime: number; limit: number }) => {
            const candles = await _fbc.getCandles(symbol, interval, opts.limit, {
              startTime: opts.startTime,
              endTime: opts.endTime,
            });
            return candles.map((c) => [
              c.openTime,
              "0",
              String(c.high),
              String(c.low),
              String(c.close),
              "0",
              c.openTime + 300000,
            ] as [number, string, string, string, string, string, number]);
          },
        }).catch(() => {}); // fire-and-forget
      }
      filteredEdgeReport = buildFilteredEdgeShadowReport(filteredStore);
    } catch {
      // filtered edge shadow must never break the dashboard
    }

    // Report-only: portfolio trend shadow. Resolver is fire-and-forget.
    let portfolioTrendReport: PortfolioTrendShadowReport | undefined;
    try {
      const ptStore = getPortfolioTrendShadowStore();
      resolvePortfolioTrendPositions(ptStore, opts.binanceClient).catch(() => {});
      portfolioTrendReport = buildPortfolioTrendShadowReport(ptStore);
    } catch {
      // portfolio trend shadow must never break the dashboard
    }

    // Report-only: realistic cost model for the frozen tape — needs a spread/funding source, which is
    // not currently collected, so this stays undefined (same effective behavior as before). Pure
    // analytics; never throws. When populated, flips FUNDING_SLIPPAGE_MODELED gate to PASS
    // (liveBlocked still true; infra gates still FAIL).
    const frozenCostModelReport: FrozenCurrentGuardCostModelReport | undefined = undefined;

    // Report-only: F****** post-cutover clean forward-validation tape. The
    // F***** pathology audit classifies OOS Segment 1 as OLD_BATCH; this tape
    // reads PAST a once-locked cutover (end of Segment 1) so the current/new
    // method can be forward-validated without the old-batch drag. Stores ONLY
    // boundary metadata; never deletes/hides Segment 1; never touches
    // shadow-positions.json. Advisory only — liveBlocked stays true.
    let postCutoverReport: PostCutoverReport | undefined;
    try {
      if (frozenCurrentGuardReport && !process.env.FROZEN_CURRENT_GUARD_DISABLED) {
        const pathology = buildFrozenSegmentPathologyAudit(
          frozenCurrentGuardReport.resolvedObservations,
        );
        const pcStore = getPostCutoverStore();
        const boundary = pcStore.ensureBoundary(frozenCurrentGuardReport, pathology);
        // No spread/funding source is currently collected, so this stays null (same effective
        // behavior as before). Infra-readiness gates default to false (not implemented), so the
        // post-cutover tape can never reach PROMOTION_CANDIDATE here.
        postCutoverReport = buildPostCutoverReport(
          frozenCurrentGuardReport,
          boundary,
          null,
        );
      }
    } catch {
      // post-cutover tape must never break the dashboard
    }

    let parallelShadowExperimentReport: ParallelShadowExperimentReport | undefined;
    try {
      const parallelStore = getParallelShadowExperimentStore();
      if (opts.binanceClient) {
        const _pbc = opts.binanceClient;
        resolveParallelShadowExperimentObservations(parallelStore, {
          getKlines: async (symbol: string, interval: string, opts: { startTime: number; endTime: number; limit: number }) => {
            const candles = await _pbc.getCandles(symbol, interval, opts.limit, {
              startTime: opts.startTime,
              endTime: opts.endTime,
            });
            return candles.map((c) => [
              c.openTime,
              "0",
              String(c.high),
              String(c.low),
              String(c.close),
              "0",
              c.openTime + 300000,
            ] as [number, string, string, string, string, string, number]);
          },
        }).catch(() => {});
      }
      parallelShadowExperimentReport = buildParallelShadowExperimentReport(parallelStore);
    } catch {
      // parallel shadow experiment matrix must never break the dashboard
    }

    // Report-only: current-guard variant matrix (forward A/B geometry harness).
    // Sources the qualifying current-guard population (stop175 + anchor-consistent
    // V2), re-walks the 5m candle path under each variant geometry, and reports
    // per-variant edge anatomy. Resolver is fire-and-forget. Isolated store under
    // data/current-guard-variant-matrix.json. NEVER touches shadow-positions.json.
    // liveBlocked stays true and microPilotAllowed stays false — always.
    let currentGuardVariantMatrixReport: CurrentGuardVariantMatrixReport | undefined;
    try {
      if (process.env.CURRENT_GUARD_VARIANT_MATRIX_DISABLED !== "1") {
        const cgvmStore = getCurrentGuardVariantMatrixStore();
        // Use the locked post-cutover boundary (if any) to scope the population.
        const cgvmCutover = (() => {
          try {
            return getPostCutoverStore().getBoundary()?.cutoverTimestamp ?? null;
          } catch {
            return null;
          }
        })();
        const cgvmNowIso = new Date().toISOString();
        const cgvmSignals = selectVariantMatrixSignals(allPositions, cgvmCutover ?? undefined);
        // The lagged shadow-position feed is DISABLED where the fresh feed owns the store
        // ("/" instance, FRESH_VM_FEED_ENABLED=1) — lagged entries are born unusable live.
        if (process.env.FRESH_VM_FEED_ENABLED !== "1") {
          mirrorVariantMatrixSignals(cgvmSignals, cgvmStore, cgvmNowIso);
        }
        if (opts.binanceClient) {
          const _vbc = opts.binanceClient;
          resolveVariantMatrixObservations(cgvmStore, {
            getKlines: async (symbol: string, interval: string, klineOpts: { startTime: number; endTime: number; limit: number }) => {
              const candles = await _vbc.getCandles(symbol, interval, klineOpts.limit, {
                startTime: klineOpts.startTime,
                endTime: klineOpts.endTime,
              });
              return candles.map((c) => [
                c.openTime,
                "0",
                String(c.high),
                String(c.low),
                String(c.close),
                "0",
                c.openTime + 300000,
              ] as VariantMatrixKlineTuple);
            },
          }).catch(() => {}); // fire-and-forget
        }
        currentGuardVariantMatrixReport = buildCurrentGuardVariantMatrixReport(cgvmStore, {
          capturedAt: cgvmNowIso,
          cutoverTimestamp: cgvmCutover,
          // Infra-readiness gates default to false (not implemented), so no
          // variant can ever reach PROMOTION_CANDIDATE here.
        });
      }
    } catch {
      // current-guard variant matrix must never break the dashboard
    }

    const kronosCounterfactual = (() => {
      try {
        const cfState = kronosCounterfactualStore.readState();
        return buildKronosCounterfactualReport(cfState.observations);
      } catch {
        return undefined;
      }
    })();
    const controllerAlignedShadowState = (() => {
      try {
        return controllerAlignedShadowStore.readState();
      } catch {
        return null;
      }
    })();
    // Read candidate funnel log entries for last 24h. Never throws.
    const candidateFunnelEntries = (() => {
      try {
        if (process.env.CANDIDATE_FUNNEL_LOG_DISABLED === "1") return null;
        const funnelLog = getCandidateFunnelLog();
        return funnelLog.readRecentEntries(24 * 60 * 60 * 1000);
      } catch {
        return null;
      }
    })();
    const dashboardSummary = buildDashboardAuditSummaryReport(allPositions, {
      era,
      externalCandidateMetadata: externalMetadataResult.metadata,
      externalCandidateMetadataDiagnostics: externalMetadataResult.diagnostics,
      externalStrategyFitEnrichment,
      externalRotationOverlay,
      externalRotationOverlayEconomics,
      tpSlGeometryRootCauseAudit,
      adaptiveProfitPolicySynthesis,
      baseRouteRiskHygieneMonitor,
      currentUniverseSymbols,
      coreScanAutoRefresh: opts.coreScanAutoRefreshController?.getStatus(),
      kronosCounterfactual,
      controllerAlignedShadowStore: controllerAlignedShadowState,
      candidateFunnelEntries,
      filteredEdgeReport,
      parallelShadowExperimentReport,
      currentGuardVariantMatrixReport,
      portfolioTrendReport,
      frozenCurrentGuardReport,
      frozenCostModelReport,
      postCutoverReport,
    });
    // --- Report-only persistence: regime direction controller snapshot ---
    // Appends one JSONL line to data/regime-direction-controller-snapshots.jsonl.
    // Wrapped in try/catch — never throws into the caller.
    // No influence on the returned dashboard summary or any live behavior.
    try {
      const snapshotStore = getRegimeDirectionControllerSnapshotStore();
      const snapshot = buildSnapshotFromReport(dashboardSummary.highlights.regimeDirectionController);
      snapshotStore.append(snapshot);
    } catch {
      // persistence failures must never break the dashboard response
    }
    // --- Report-only persistence: OOS validation curve snapshot ---
    // Append one JSONL line per dashboard render using already-built reports.
    // This never changes strategy, paper admission, or live behavior.
    try {
      const snapshot = buildOosValidationSnapshot({
        capturedAt: dashboardSummary.generatedAt,
        triggerSource: "DASHBOARD_AUDIT",
        era,
        postCutoverReport,
        variantMatrixReport: currentGuardVariantMatrixReport,
      });
      oosSnapshotStore.append(snapshot);
    } catch {
      // persistence failures must never break the dashboard response
    }
    return dashboardSummary;
  });

  // Own closed HEADLINE orders, in the minimal PsleOrder shape — exists so the per-symbol-lane-edge
  // report (below) can pool REAL headline-close proof from testnet/live's own books, not just the
  // diagnostic instance's. Headline-only (excludes this instance's own diagnostic sleeve) and
  // closed-only, so the payload is small and callers never receive more than they need.
  app.get("/api/shadow/headline-closed-orders", async () => {
    const orders = getPaperExecutionRouterStore().getState().orders;
    const headlineClosed: PsleOrder[] = orders
      .filter(
        (o) =>
          (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
          o.paperOrderMode !== "DIAGNOSTIC_ONLY" &&
          o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
          typeof o.selectedLaneId === "string" &&
          typeof o.symbol === "string",
      )
      .map((o) => ({
        symbol: o.symbol,
        selectedLaneId: o.selectedLaneId as string,
        direction: o.direction ?? null,
        paperStatus: o.paperStatus,
        netR: o.netR,
        paperOrderMode: o.paperOrderMode ?? null,
        diagnosticLabel: o.diagnosticLabel ?? null,
      }));
    return { generatedAt: new Date().toISOString(), orders: headlineClosed };
  });

  // Per-symbol × lane BOOK edge (report-only). Which symbols carry real, realized-book-proven edge —
  // even inside a benched lane — and via which lane. The disciplined basis for opening MORE symbols
  // than the 3-per-batch cap WITHOUT trading the panel's optimistic sim mirages. Measures only.
  //
  // 2026-07-08: pools in testnet+live's OWN headline-closed orders (via headline-closed-orders above)
  // alongside this instance's full book. Without this, headlineClosed for real-money lanes was stuck
  // at 0 forever on the diagnostic instance (it never runs HEADLINE mode for those lanes), which meant
  // "promotable" (the live curation tier) could never be reached no matter how much time passed — see
  // PSLE_PEER_SOURCE_URLS. Best-effort: a peer fetch failure just means that peer's real trades are
  // missing from this cycle's count, never a thrown error or a stale/frozen report.
  app.get("/api/shadow/per-symbol-lane-edge", async () => {
    const generatedAt = new Date().toISOString();
    const localOrders = getPaperExecutionRouterStore().getState().orders;
    const peerUrls = (process.env.PSLE_PEER_SOURCE_URLS ?? "http://localhost:3102,http://localhost:3103")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const peerTimeoutMs = 5_000;
    const peerOrders = (
      await Promise.all(
        peerUrls.map(async (base) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), peerTimeoutMs);
          try {
            const res = await fetch(`${base}/api/shadow/headline-closed-orders`, { signal: controller.signal });
            if (!res.ok) return [];
            const body = (await res.json()) as { orders?: PsleOrder[] };
            return Array.isArray(body.orders) ? body.orders : [];
          } catch {
            return []; // peer unreachable this cycle — its real trades are just absent, not fatal
          } finally {
            clearTimeout(timer);
          }
        }),
      )
    ).flat();
    const orders = [...localOrders, ...peerOrders];
    const envInt = (v: string | undefined, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
    };
    const envNum = (v: string | undefined, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const report = buildPerSymbolLaneBookEdge(orders, {
      minClosed: envInt(process.env.PSLE_MIN_CLOSED, 40),
      minHeadlineClosed: envInt(process.env.PSLE_MIN_HEADLINE_CLOSED, 20),
      posMinAvgR: envNum(process.env.PSLE_POS_MIN_AVG_R, 0.03),
      negMaxAvgR: envNum(process.env.PSLE_NEG_MAX_AVG_R, -0.03),
      displayFloor: envInt(process.env.PSLE_DISPLAY_FLOOR, 10),
      suspiciousPf: envNum(process.env.PSLE_SUSPICIOUS_PF, 10),
      suspiciousWr: envNum(process.env.PSLE_SUSPICIOUS_WR, 0.98),
    });
    return { generatedAt, peerOrdersMerged: peerOrders.length, ...report };
  });

  // Intraday momentum hunter (Sleeve 2) report — report-only measurement, nothing trades on it.
  app.get("/api/shadow/intraday-momentum-report", async () => {
    return { generatedAt: new Date().toISOString(), ...buildIntradayMomentumReport(getIntradayMomentumStore().all) };
  });

  // SHORT confirmed-exhaustion + crowded-funding fade report — report-only measurement, nothing
  // trades on it. See short-fade-edge.ts for the entry-signal rationale.
  app.get("/api/shadow/short-fade-report", async () => {
    const sfStore = getShortFadeStore();
    return { generatedAt: new Date().toISOString(), ...buildShortFadeReport(sfStore.all, sfStore.cycleMeta) };
  });

  // LONG-side capitulation/washout/reclaim fade report — report-only measurement. See
  // panic-washout-reclaim-edge.ts for the entry-signal rationale. Live-wired
  // (PANIC_WASHOUT_EXEC_ENABLED) on operator's explicit request BEFORE any measurement accrued —
  // this report is where that evidence starts showing up from trade #1 onward.
  app.get("/api/shadow/panic-washout-report", async () => {
    const pwrStore = getPanicWashoutStore();
    return { generatedAt: new Date().toISOString(), ...buildPanicWashoutReport(pwrStore.all, pwrStore.cycleMeta) };
  });

  // Regime-composite confirmation report (2026-07-09) — gates on axis score + per-symbol crowding
  // state instead of cross-sectional dispersion or per-symbol rotation history. See
  // regime-composite-edge.ts for the gap this closes. Live-wired (REGIME_COMPOSITE_EXEC_ENABLED)
  // on operator's explicit request BEFORE any measurement accrued — this report is where that
  // evidence starts showing up from trade #1 onward.
  app.get("/api/shadow/regime-composite-report", async () => {
    const rcStore = getRegimeCompositeStore();
    return { generatedAt: new Date().toISOString(), ...buildRegimeCompositeReport(rcStore.all, rcStore.cycleMeta) };
  });

  // Bidirectional composite estimator report (2026-07-09) — combines axis level + velocity +
  // per-symbol Kronos forecast into one signed composite; direction follows its sign, steepness
  // picks WIDE vs FAST geometry. See composite-estimator-edge.ts for the full design rationale.
  // Live-wired on operator's explicit request BEFORE any measurement accrued.
  app.get("/api/shadow/composite-estimator-report", async () => {
    const ceStore = getCompositeEstimatorStore();
    return { generatedAt: new Date().toISOString(), ...buildCompositeEstimatorReport(ceStore.all, ceStore.cycleMeta) };
  });

  // Residual cross-sectional momentum + leader-laggard catch-up report (2026-07-10, Tier-3 audit
  // item A). Report-only; not wired to any executor. See residual-momentum-edge.ts.
  app.get("/api/shadow/residual-momentum-report", async () => {
    const rmStore = getResidualMomentumStore();
    return { generatedAt: new Date().toISOString(), ...buildResidualMomentumReport(rmStore.all, rmStore.cycleMeta) };
  });

  // Liquidation-recoil cross-sectional ranking report (2026-07-10, Tier-3 audit item C). Report-only;
  // not wired to any executor. See liquidation-recoil-cross-sectional.ts.
  app.get("/api/shadow/liquidation-recoil-xs-report", async () => {
    const lrxStore = getLiquidationRecoilXsStore();
    return { generatedAt: new Date().toISOString(), ...buildLiquidationRecoilXsReport(lrxStore.all, lrxStore.cycleMeta) };
  });

  // Compression-to-expansion ignition entry detector report (2026-07-10, Tier-3 audit item B).
  // Report-only; not wired to any executor. See compression-expansion-edge.ts.
  app.get("/api/shadow/compression-expansion-report", async () => {
    const ceeStore = getCompressionExpansionStore();
    return { generatedAt: new Date().toISOString(), ...buildCompressionExpansionReport(ceeStore.all, ceeStore.cycleMeta) };
  });

  // Probability of Backtest Overfitting (CSCV) across the CG variant-matrix lanes — the honest audit
  // of "is this lane's edge real, or does it just look best in this sample" (e.g. CG_WIDE_LONG_RUNNER).
  // Report-only; never gates execution. Query: minObsPerVariant (default 30), bucketDays (default 7).
  app.get<{ Querystring: { minObsPerVariant?: string; bucketDays?: string } }>("/api/shadow/pbo-report", async (request) => {
    const minObsPerVariant = Number(request.query.minObsPerVariant) || 30;
    const bucketMs = (Number(request.query.bucketDays) || 7) * 24 * 3_600_000;
    const observations = getCurrentGuardVariantMatrixStore()
      .all.filter((o) => o.resolvedAt !== null)
      .map((o) => ({ variantId: o.variantId, atMs: new Date(o.resolvedAt as string).getTime(), netR: o.netR }))
      .filter((o) => Number.isFinite(o.atMs));
    return { generatedAt: new Date().toISOString(), ...buildLaneVariantPboReport(observations, { minObsPerVariant, bucketMs }) };
  });

  // Single-flight + short TTL cache: the dashboard auto-refreshes this endpoint every 5s, but the
  // underlying data (variant-matrix report over 129k+ obs, paper performance, live Binance mark
  // prices) only actually changes on the ~7min paper-cycle tick. Profiling (2026-07-06) found this
  // one call took 5-10s end to end, so uncached 5s polling meant requests were permanently queued
  // up behind each other. A short TTL collapses that queue to one real computation per window;
  // concurrent callers inside the window share the same in-flight promise instead of re-triggering
  // the expensive work (and the live Binance mark-price fetch) redundantly.
  // Slightly above the dashboard's 5s auto-refresh interval so a single steady-polling tab
  // reliably hits cache on most polls even with some jitter in how long the computation takes.
  const NEURAL_MAP_CACHE_TTL_MS = 6_000;
  let neuralMapCache: { builtAtMs: number; result: ReturnType<typeof buildNeuralMapTelemetry> } | null = null;
  let neuralMapInFlight: Promise<ReturnType<typeof buildNeuralMapTelemetry>> | null = null;

  async function computeNeuralMapTelemetry(): Promise<ReturnType<typeof buildNeuralMapTelemetry>> {
    const generatedAt = new Date().toISOString();
    const cached = getLatestScanCandidates();
    const scanStatus = opts.coreScanAutoRefreshController?.getStatus() ?? null;
    const regime =
      cached?.marketRegime ??
      scanStatus?.lastAutoRefreshResultSummary?.marketRegime ??
      null;
    const controller = buildRegimeDirectionControllerReport({
      currentRegime: regime,
      adaptiveDirectionBias: null,
      primaryValidationLane: null,
    });
    const paperStore = getPaperExecutionRouterStore();
    const orders = paperStore.getState().orders;
    const paper = buildPaperPerformanceReport(paperStore);
    const paperUnrealized = await buildPaperUnrealizedSnapshot(orders, opts.binanceClient, generatedAt);
    const variantMatrix = buildCurrentGuardVariantMatrixReport(
      getCurrentGuardVariantMatrixStore(),
      { capturedAt: generatedAt },
    );
    const mixed = buildMixedRegimeReport({
      regime,
      candidates: (cached?.candidates ?? []).map((candidate) => ({
        symbol: candidate.symbol,
        direction: candidate.direction,
        regime,
        laneId: mixedLaneIdForDirection(candidate.direction),
        volatilityScore: candidate.volatilityScore,
        liquidityScore: candidate.liquidityScore,
      })),
      orders,
      nowMs: Date.now(),
      trailLaneAvailable: variantMatrix.rows.some(
        (row) => row.variantId === "CG_TRAIL_AFTER_TP1" && row.status !== "REJECT",
      ),
    });
    const mixedValidation = buildMixedBudgetForwardValidation(orders, generatedAt);
    const staleAudit = buildOpenOrderStaleAudit(orders, Date.now());
    return buildNeuralMapTelemetry({
      generatedAt,
      controller,
      scanStatus,
      scanTiming: getLatestScanTimingDiagnostics(),
      paper,
      paperUnrealized,
      orders,
      variantMatrix,
      mixed,
      mixedValidation,
      staleAudit,
      quarantinedLaneIds: [
        ...MANUAL_QUARANTINED_PAPER_LANE_IDS,
        ...(process.env.PAPER_CHALLENGER_QUARANTINED !== "0"
          ? ["CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1"]
          : []),
        // Variant lanes auto-quarantined for confirmed net-negative paper economics render violet too.
        ...(process.env.PAPER_VARIANT_AUTO_QUARANTINE !== "0"
          ? computeAutoQuarantinedVariantLanes(orders)
          : []),
      ],
    });
  }

  app.get("/api/shadow/neural-map", async () => {
    const nowMs = Date.now();
    if (neuralMapCache && nowMs - neuralMapCache.builtAtMs < NEURAL_MAP_CACHE_TTL_MS) {
      return neuralMapCache.result;
    }
    if (neuralMapInFlight) return neuralMapInFlight;
    neuralMapInFlight = computeNeuralMapTelemetry()
      .then((result) => {
        neuralMapCache = { builtAtMs: Date.now(), result };
        return result;
      })
      .finally(() => {
        neuralMapInFlight = null;
      });
    return neuralMapInFlight;
  });

  app.get("/api/shadow/paper-controls", async () => {
    const controls = readPaperTradingControls();
    const activeTpPct = controls.cgWideTpPct ?? 3;
    return {
      controls,
      cgWideTp: {
        activeTpPct,
        defaultTpPct: 3,
        assessment: assessPaperTp(activeTpPct),
        roundTripCostPct: roundTripCostPct(),
      },
    };
  });

  app.post<{ Body: { cgWideTpPct?: number | null } }>("/api/shadow/paper-controls/cg-wide-tp", async (request, reply) => {
    const raw = request.body?.cgWideTpPct;
    const next = raw === null || raw === undefined ? null : Number(raw);
    if (next !== null && (!Number.isFinite(next) || next < 0.05 || next > 10)) {
      reply.code(400);
      return { ok: false, reason: "cgWideTpPct must be null or a number between 0.05 and 10" };
    }
    const controls = writePaperTradingControls({ cgWideTpPct: next });
    const activeTpPct = controls.cgWideTpPct ?? 3;
    return {
      ok: true,
      controls,
      cgWideTp: {
        activeTpPct,
        defaultTpPct: 3,
        assessment: assessPaperTp(activeTpPct),
        roundTripCostPct: roundTripCostPct(),
      },
    };
  });

  app.post<{ Body: { confirm?: string; lane?: string; mode?: "ALL" | "PROFITABLE_DIAGNOSTIC" } }>("/api/shadow/paper-controls/realize-open", async (request, reply) => {
    const mode = request.body?.mode ?? (request.body?.confirm === "CAPTURE_DIAG_PROFIT" ? "PROFITABLE_DIAGNOSTIC" : "ALL");
    const expectedConfirm = mode === "PROFITABLE_DIAGNOSTIC" ? "CAPTURE_DIAG_PROFIT" : "REALIZE_PAPER_OPEN";
    if (request.body?.confirm !== expectedConfirm) {
      reply.code(400);
      return { ok: false, reason: `manual paper close requires confirm=${expectedConfirm}` };
    }
    if (!opts.binanceClient) {
      reply.code(503);
      return { ok: false, reason: "BINANCE_UNAVAILABLE" };
    }
    const laneFilter = request.body?.lane;
    const openStatuses = new Set(["CREATED", "PAPER_SUBMITTED"]);
    const isDiagnosticOrder = (order: { paperOrderMode?: string; diagnosticLabel?: string | null }) =>
      order.paperOrderMode === "DIAGNOSTIC_ONLY" || order.diagnosticLabel === "BACKFILL_DIAGNOSTIC";
    const paperStore = getPaperExecutionRouterStore();
    const orders = paperStore.getState().orders.filter((order) =>
      openStatuses.has(order.paperStatus) &&
      (mode !== "PROFITABLE_DIAGNOSTIC" || isDiagnosticOrder(order)) &&
      (!laneFilter || order.selectedLaneId === laneFilter),
    );
    const symbols = Array.from(new Set(orders.map((order) => order.symbol))).sort();
    const latest = new Map<string, number>();
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const candles = await opts.binanceClient!.getCandles(symbol, "5m", 1);
        const close = candles.at(-1)?.close;
        if (typeof close === "number" && Number.isFinite(close) && close > 0) latest.set(symbol, close);
      } catch {
        // Symbol-level mark failure is counted below.
      }
    }));

    let closed = 0;
    let skipped = 0;
    let skippedNonProfit = 0;
    let realizedPnl = 0;
    let realizedR = 0;
    for (const order of orders) {
      const mark = latest.get(order.symbol);
      const entry = order.entryPrice;
      const risk = order.direction === "LONG" ? entry - order.stopLoss : order.stopLoss - entry;
      if (!(typeof mark === "number" && Number.isFinite(mark) && entry > 0 && risk > 0)) {
        skipped += 1;
        continue;
      }
      const grossR = order.direction === "SHORT" ? (entry - mark) / risk : (mark - entry) / risk;
      const costR = order.plannedStopDistanceBps > 0 ? -(22 / order.plannedStopDistanceBps) : 0;
      const netR = grossR + costR;
      const netPnlAmount = netR * order.plannedRiskAmount;
      if (mode === "PROFITABLE_DIAGNOSTIC" && netPnlAmount <= 0) {
        skippedNonProfit += 1;
        continue;
      }
      paperStore.update(order.paperOrderId, {
        paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
        grossR,
        costR,
        netR,
        netPnlAmount,
        closeReason: mode === "PROFITABLE_DIAGNOSTIC"
          ? "PAPER_MANUAL_DIAGNOSTIC_TP_CAPTURE_BINANCE_MARK"
          : "PAPER_MANUAL_REALIZE_ALL",
        updatedAt: new Date().toISOString(),
      });
      closed += 1;
      realizedPnl += netPnlAmount;
      realizedR += netR;
    }

    return { ok: true, mode, closed, skipped, skippedNonProfit, realizedPnl, realizedR, lane: laneFilter ?? "ALL" };
  });

  // ── Compact operator brief (report-only read, no writes, no behavior changes) ──
  app.get<{ Querystring: { era?: string; resolve?: string; paper?: string; headless?: string } }>("/api/shadow/operator-brief", async (request, reply) => {
    if (!shadowEngine) {
      void reply.code(503).type("text/plain");
      return "OPERATOR BRIEF UNAVAILABLE — shadow engine not enabled\n";
    }
    try {
      const rawEra = request.query?.era;
      const era: DashboardAuditSummaryEra = rawEra === "ALL_TIME" ? "ALL_TIME" : "POST_CALIBRATION";
      const generatedAt = new Date().toISOString();
      const scanStatus = opts.coreScanAutoRefreshController?.getStatus() ?? null;
      // Regime must be the regime OF THE CANDIDATES THIS PATH ADMITS — the allocator below evaluates
      // getLatestScanCandidates() (the cached scan), so gate on that scan's marketRegime FIRST (same
      // resolution the neural-map controller uses), falling back to the auto-refresh summary. Using
      // scanStatus-only diverged from the admitted candidates AND could be null (→ controllerMode
      // UNKNOWN → regimeOk=false → the WHOLE paper admission freezes for that cycle).
      const currentRegime =
        getLatestScanCandidates()?.marketRegime ??
        scanStatus?.lastAutoRefreshResultSummary?.marketRegime ??
        null;
      // Honest-edge gate: the controllerMode this produces flows into the
      // adaptive lane router → paper allocator → admission, so a direction with
      // proven-negative honest edge is hard-vetoed before any order is created.
      const edgeMemory = getRegimeEdgeMemory();
      const regimeReport = buildRegimeDirectionControllerReport({
        currentRegime,
        adaptiveDirectionBias: null,
        primaryValidationLane: null,
        edgeGate: edgeMemory,
      });
      // ── ?resolve=1: bounded resolver run before building brief ─────────────
      // When resolve=1 is supplied and a Binance client is available, the
      // variant-matrix resolver is awaited up to 8 s so fresh diagnostics
      // (expired count, stale-open count, lastRunAt) are reflected in the
      // brief that follows. Report-only: never affects live behavior,
      // positions, shadow-positions.json, or any strategy criteria.
      // A timeout or internal error is silently swallowed; brief always renders.
      if (request.query?.resolve === "1" && opts.binanceClient) {
        const _rbc = opts.binanceClient;
        try {
          const cgvmStoreForResolve = getCurrentGuardVariantMatrixStore();
          // Mirror freshly-closed shadow positions into the variant-matrix tape
          // BEFORE resolving. This is the headless driver for OOS growth: the
          // resolver below only resolves what is already in the store, and the
          // mirror step previously ran ONLY inside the heavy dashboard-audit-summary
          // endpoint — which the 24/7 ticker never calls. Without this, freshly
          // closed shadow positions are never recorded, the store stays empty, and
          // freshValid/OOS never advances headless (lanes never mature → no
          // headline). Report-only; deduped by the store; never throws.
          if (
            process.env.CURRENT_GUARD_VARIANT_MATRIX_DISABLED !== "1" &&
            shadowEngine &&
            // Lagged shadow-position mirroring is OFF where the fresh feed owns the store.
            process.env.FRESH_VM_FEED_ENABLED !== "1"
          ) {
            try {
              const cutoverTs = getPostCutoverStore().getBoundary()?.cutoverTimestamp ?? null;
              const cgvmSignals = selectVariantMatrixSignals(
                shadowEngine.getAllPositions(),
                cutoverTs ?? undefined,
              );
              mirrorVariantMatrixSignals(cgvmSignals, cgvmStoreForResolve, new Date().toISOString());
            } catch {
              /* mirror must never break the brief */
            }
          }
          const variantResolverMaxObservations = (() => {
            const n = Number(process.env.VARIANT_MATRIX_RESOLVER_MAX_OBSERVATIONS_PER_RUN);
            return Number.isFinite(n) && n > 0 ? Math.max(40, Math.floor(n)) : 100;
          })();
          const variantResolverMaxRuntimeMs = (() => {
            const n = Number(process.env.VARIANT_MATRIX_RESOLVER_MAX_RUNTIME_MS);
            return Number.isFinite(n) && n > 0 ? Math.max(8_000, Math.floor(n)) : 20_000;
          })();
          const variantResolverWaitMs =
            request.query?.headless === "1"
              ? Math.min(
                  variantResolverMaxRuntimeMs + 2_000,
                  Math.max(8_000, Number(process.env.PAPER_AUTO_CYCLE_TIMEOUT_MS ?? 120_000) - 5_000),
                )
              : 8_000;
          const resolverPromise = resolveVariantMatrixObservations(cgvmStoreForResolve, {
            getKlines: async (symbol: string, interval: string, klineOpts: { startTime: number; endTime: number; limit: number }) => {
              const candles = await _rbc.getCandles(symbol, interval, klineOpts.limit, {
                startTime: klineOpts.startTime,
                endTime: klineOpts.endTime,
              });
              return candles.map((c) => [
                c.openTime,
                "0",
                String(c.high),
                String(c.low),
                String(c.close),
                "0",
                c.openTime + 300000,
              ] as VariantMatrixKlineTuple);
            },
          }, {
            // Budget is now spent on REAL fetch-walks only (the expiry backlog is drained for free
            // in the resolver's Phase 1 bulk sweep), so we can afford a deeper per-run budget to
            // clear the ~2k young-obs backlog in hours. The resolver self-bounds + persists each
            // resolution incrementally, so even if the 8s brief race abandons it, progress is saved.
            // SANITY FLOOR (2026-06-22): a too-small env override (it was set to 25/6 on the VPS,
            // which silently froze resolution for days) is clamped UP so resolution can never stall.
            // Env can still tune HIGHER; it just can't cripple the resolver below a workable minimum.
            maxObservations: variantResolverMaxObservations,
            maxRuntimeMs: variantResolverMaxRuntimeMs,
            yieldEvery: 1,
          });
          await Promise.race([resolverPromise, new Promise<void>((res) => { setTimeout(res, variantResolverWaitMs); })]);
        } catch { /* resolve=1 failure must never break the brief */ }

        // ── Fade-long edge: independent oversold (RSI<30) dip-buy measurement lane ──
        // The bot's scanner only produces CHASE longs (no dips), which have no edge on alts.
        // This lane records the symmetric long-fade (BUY oversold) on the universe and resolves
        // it by candle-walk, accruing OOS like the variant-matrix lanes. Report-only; does NOT
        // pass through the allocator, paper book, live engine, or any strategy gate.
        // FIRE-AND-FORGET: the lane is surfaced by the SEPARATE neural-map endpoint, not this
        // brief, so we must NOT block the (already heavy) brief on ~20 sequential candle fetches.
        // Overlap-guarded so the 7-min ticker can't stack two cycles on the singleton store.
        // Intraday momentum hunter (Sleeve 2): 1h breakout + volume surge + momentum → MFE-giveback
        // exit. Hunts the coin that pumps TODAY regardless of the chop macro tape. Report-only,
        // fire-and-forget, env-gated. NOT regime-gated — it finds per-symbol momentum, not macro trend.
        if (process.env.INTRADAY_MOMENTUM_DISABLED !== "1") {
          const _imc = opts.binanceClient;
          void runIntradayMomentumCycleGuarded({
            store: getIntradayMomentumStore(),
            universe: [...CURRENT_SCANNER_UNIVERSE],
            now: Date.now(),
            fetchCandles: async (symbol: string) => _imc.getCandles(symbol, IM_INTERVAL, 120),
            // Report-only enrichment (order-flow + composite decision score), read ONLY for a symbol
            // that just fired a signal. Never affects whether the signal is recorded — pure logging so
            // a later pass can check whether the score correlates with realized edge before it is ever
            // wired into admission. Wrapped by the cycle itself; a failure here never blocks recording.
            enrichSignal: async (symbol, signal) => {
              const [trades, depthPayload, bookTicker] = await Promise.all([
                _imc.getFuturesAggTrades(symbol, { limit: 200 }),
                _imc.getFuturesDepth(symbol, 20),
                _imc.getFuturesBookTicker(symbol),
              ]);
              const micro = buildMicrostructureSnapshot({
                symbol,
                capturedAtMs: Date.now(),
                trades,
                depthPayload,
                bestBid: bookTicker.bid,
                bestAsk: bookTicker.ask,
                depthBpsWindow: 10,
                sizeNotionalUsd: 50, // matches the live risk-per-trade notional scale
              });
              const decisionScore = computeDecisionScore({
                regime: { controllerMode: regimeReport.controllerMode, confidence: regimeReport.confidence, direction: "LONG" },
                setup: { volumeRatio: signal.volumeRatio, rocPercent: signal.rocAtEntry, atrExtension: signal.atrExtension },
                orderFlow: { takerBuyRatio: micro.takerFlow.takerBuyRatio, direction: "LONG" },
                liquidity: { spreadBps: micro.spreadBps, expectedSlippageBps: micro.expectedSlippageBpsBuy, maxSpreadBps: 20, maxSlippageBps: 30 },
                derivatives: { fundingZScore: null, openInterestChangePercent: null, direction: "LONG" },
              });
              return { takerBuyRatio: micro.takerFlow.takerBuyRatio, spreadBps: micro.spreadBps, decisionScore: decisionScore.totalScore };
            },
          }).catch(() => undefined);
        }
        // SHORT confirmed-exhaustion + crowded-funding fade (2026-07-06, internet-research-informed):
        // varies the ENTRY signal (RSI exhaustion cross-back-down + crowded-long funding/OI gate) on
        // a majors/liquid-only universe, keeping the ALREADY-proven CG_WIDE_FAST_SHORT exit geometry.
        // Report-only, fire-and-forget, env-gated, own store/cycle/resolver — does NOT pass through
        // the allocator, paper book, live engine, or any strategy gate. See short-fade-edge.ts.
        if (process.env.SHORT_FADE_DISABLED !== "1") {
          const _sfc = opts.binanceClient;
          void runShortFadeCycleGuarded({
            store: getShortFadeStore(),
            now: Date.now(),
            fetchCandles: async (symbol: string) => _sfc.getCandles(symbol, SF_INTERVAL, 120),
            crowdingClient: _sfc,
          }).catch(() => undefined);
        }
        // LONG-side capitulation/washout/reclaim fade (2026-07-09, operator idea): the symmetric
        // counterpart to SHORT_FADE_EXHAUSTION above — see panic-washout-reclaim-edge.ts. Report-only
        // measurement cycle here; live-wiring is a separate exec-enable flag in app.ts.
        if (process.env.PANIC_WASHOUT_DISABLED !== "1") {
          const _pwc = opts.binanceClient;
          void runPanicWashoutCycleGuarded({
            store: getPanicWashoutStore(),
            now: Date.now(),
            fetchCandles: async (symbol: string) => _pwc.getCandles(symbol, PWR_INTERVAL, 120),
            crowdingClient: _pwc,
          }).catch(() => undefined);
        }
        // Regime-composite confirmation (2026-07-09): gates LONG entries on axis score (breadth
        // composite) + per-symbol crowdingState instead of cross-sectional dispersion or per-symbol
        // rotation history — see regime-composite-edge.ts for the gap this closes. Report-only
        // measurement here too (same discipline as every other lane); live-wiring is a SEPARATE
        // exec-enable flag in app.ts.
        if (process.env.REGIME_COMPOSITE_DISABLED !== "1") {
          const _rcc = opts.binanceClient;
          const rcAxisScore = buildRegimeAxisTimeline(getRegimeEngineStore().snapshots).current?.score ?? null;
          void runRegimeCompositeCycleGuarded({
            store: getRegimeCompositeStore(),
            universe: RC_UNIVERSE,
            now: Date.now(),
            axisScore: rcAxisScore,
            fetchCandles: async (symbol: string) => _rcc.getCandles(symbol, RC_INTERVAL, 120),
            crowdingClient: _rcc,
          }).catch(() => undefined);
        }
        // Bidirectional composite estimator (2026-07-09): axis level + velocity + per-symbol Kronos
        // forecast combine into one signed composite; direction follows its sign, steepness picks
        // WIDE vs FAST geometry. See composite-estimator-edge.ts for the full design. Report-only
        // measurement here (same discipline as every other lane); live-wiring is a SEPARATE
        // exec-enable flag per bucket in app.ts.
        if (process.env.COMPOSITE_ESTIMATOR_DISABLED !== "1") {
          const _cec = opts.binanceClient;
          const ceTimeline = buildRegimeAxisTimeline(getRegimeEngineStore().snapshots);
          const ceAxisLevel = ceTimeline.current?.score ?? null;
          const ceAxisVelocity = ceTimeline.slopePerHour;
          const ceKronosClient = opts.kronosClient;
          void runCompositeEstimatorCycleGuarded({
            store: getCompositeEstimatorStore(),
            universe: CE_UNIVERSE,
            now: Date.now(),
            axisLevel: ceAxisLevel,
            axisVelocitySlopePerHour: ceAxisVelocity,
            fetchCandles: async (symbol: string) => _cec.getCandles(symbol, CE_INTERVAL, 120),
            fetchKronos: async (symbol: string, candles) => {
              if (!ceKronosClient) return null;
              try {
                return await ceKronosClient.predict(symbol, "1h", candles, {
                  requestTimeoutMs: 20_000,
                  queueTimeoutMs: 15_000,
                  preferStaleOnTimeout: true,
                });
              } catch {
                return null;
              }
            },
          }).catch(() => undefined);
        }
        // Residual cross-sectional momentum + leader-laggard catch-up (2026-07-10, Tier-3 audit
        // item A): beta-neutralized residual return ranking + cluster catch-up detection — see
        // residual-momentum-edge.ts. Report-only measurement, same discipline as every other lane;
        // never wired to any executor or lane allocation.
        if (process.env.RESIDUAL_MOMENTUM_DISABLED !== "1") {
          const _rmc = opts.binanceClient;
          void runResidualMomentumCycleGuarded({
            store: getResidualMomentumStore(),
            now: Date.now(),
            fetchCandles: async (symbol: string) => _rmc.getCandles(symbol, RM_INTERVAL, 200),
          }).catch(() => undefined);
        }
        // Liquidation-recoil cross-sectional ranking (2026-07-10, Tier-3 audit item C): the
        // cross-symbol extension of panic-washout-reclaim-edge.ts — detects a broad liquidation
        // event across the wider universe and ranks members by reclaim strength. See
        // liquidation-recoil-cross-sectional.ts. Report-only measurement; never wired to any
        // executor or lane allocation.
        if (process.env.LIQUIDATION_RECOIL_XS_DISABLED !== "1") {
          const _lrc = opts.binanceClient;
          void runLiquidationRecoilXsCycleGuarded({
            store: getLiquidationRecoilXsStore(),
            now: Date.now(),
            fetchCandles: async (symbol: string) => _lrc.getCandles(symbol, LRX_INTERVAL, 200),
            crowdingClient: _lrc,
          }).catch(() => undefined);
        }
        // Compression-to-expansion ignition entry detector (2026-07-10, Tier-3 audit item B): the
        // missing entry side of the CG long-volatility-expansion thesis — ATR/Bollinger-width
        // compression followed by an order-flow-confirmed breakout. See compression-expansion-edge.ts.
        // Report-only measurement; never wired to any executor or lane allocation.
        if (process.env.COMPRESSION_EXPANSION_DISABLED !== "1") {
          const _cee = opts.binanceClient;
          void runCompressionExpansionCycleGuarded({
            store: getCompressionExpansionStore(),
            universe: CEE_UNIVERSE,
            now: Date.now(),
            fetchCandles: async (symbol: string) => _cee.getCandles(symbol, CEE_INTERVAL, 200),
            client: _cee,
          }).catch(() => undefined);
        }
        // NEW-COIN RADAR (report-only): discovery cycle is self-throttled to 12h via the store's
        // fetchedAt, so riding the 7-min scan hook costs nothing between refreshes. Public
        // endpoints only (Binance fapi + CoinGecko) — no keys, no orders.
        if (isNewCoinRadarEnabled()) {
          void runNewCoinRadarCycleGuarded({
            store: getNewCoinRadarStore(),
            nowMs: Date.now(),
            excludeSymbols: new Set(CURRENT_SCANNER_UNIVERSE),
          }).catch(() => undefined);
        }
        // MOONSHOT_LOTTERY_LANE (measurement/report-only, ported from testnet-live branch): cheap
        // prefilter → deep-extract top movers → score + LOG signals/rejections. Places NO orders
        // anywhere; live execution (if ever) will be a separate, operator-triggered build. Demo
        // uses a default symbol max-leverage/minNotional — real execution MUST re-check brackets.
        if (isMoonshotLotteryEnabled() && opts.binanceClient) {
          const _mbc = opts.binanceClient;
          // Meme-focused universe (2026-07-08): resolved against live exchangeInfo, cached 12h.
          void resolveMoonshotMemeUniverse({ nowMs: Date.now() }).then((memeUniverse) =>
            runMoonshotCycleGuarded({
            universe: memeUniverse,
            now: Date.now(),
            store: getMoonshotStore(),
            ctx: {
              getCandles1m: async (sym, limit) => (await _mbc.getCandles(sym, "1m", limit)).map((c) => ({ close: c.close, volume: c.volume })),
              getFlow: async (sym) => _mbc.getFuturesFlow(sym),
              getDepth: async (sym) => {
                const d = await _mbc.getDepth(sym, 50);
                return {
                  bids: d.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
                  asks: d.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
                };
              },
              getMarkPrice: async (sym) => (await _mbc.getFuturesPremiumIndex(sym)).markPrice,
              minNotionalUsd: () => 5, // Binance futures common minNotional; execution re-checks per-symbol
              maxLeverage: () => MOONSHOT_DEFAULT_MAX_LEVERAGE,
            },
          })).catch((err) => {
            // Universe unresolvable with no cache: warn only — do NOT record a fake zero-cycle
            // (that would read as "market calm"); a growing "last cycle Xh ago" is the honest signal.
            console.warn(`[moonshot] meme universe resolve failed: ${(err as Error).message}`);
          });
        }
        // Cross-sectional market-neutral measurement lane: rank the universe by N-bar momentum, go
        // (hypothetically) long-top-k / short-bottom-k at equal notional, measure the forward basket
        // return. Beta cancels → the P&L is dispersion, which can be positive in BOTH bull and bear.
        // Report-only, fire-and-forget, env-gated. NOT regime-gated — it's market-neutral by design.
        if (!isCrossSectionalEdgeDisabled()) {
          const _xsc = opts.binanceClient;
          const latestRegimeSnapshot = getRegimeDirectionControllerSnapshotStore().readLatest();
          const crossSectionalRegimeContext = latestRegimeSnapshot
            ? buildCrossSectionalRegimeContext({
                currentRegime: latestRegimeSnapshot.currentRegime,
                controllerMode: latestRegimeSnapshot.controllerMode,
                directionalBias: latestRegimeSnapshot.directionalBias,
                confidence: latestRegimeSnapshot.confidence,
                capturedAt: latestRegimeSnapshot.capturedAt,
              })
            : null;
          // Regime-axis score for the FILTERED basket's leg-count skew (regimeSkewedK) — same
          // score/boundary already proven out by the directional lane-switch guidance. A missing/
          // unparseable score just falls back to unskewed 3/3 (regimeSkewedK's own null handling).
          const axisScore = buildRegimeAxisTimeline(getRegimeEngineStore().snapshots).current?.score ?? null;
          void runCrossSectionalCycleGuarded({
            store: getCrossSectionalStore(),
            universe: [...CROSS_SECTIONAL_UNIVERSE],
            now: Date.now(),
            regimeContext: crossSectionalRegimeContext,
            axisScore,
            // spotSymbolForCandles: 1000x-multiplier futures contracts (1000PEPEUSDT, …) have no
            // spot pair under that name — fetch the bare spot symbol instead. Returns are price
            // RATIOS, so the 1000x scaling cancels; the rest of the pipeline (scoring, allowlist
            // matching, executor order symbol) keeps using the real futures name throughout.
            fetchCandles: async (symbol: string) =>
              _xsc.getCandles(spotSymbolForCandles(symbol), CROSS_SECTIONAL_INTERVAL, CROSS_SECTIONAL_MOMENTUM_BARS + 5),
          }).catch(() => undefined);
        }
      }
      let postCutoverReport: PostCutoverReport | undefined;
      try {
        if (!process.env.FROZEN_CURRENT_GUARD_DISABLED) {
          const frozenStore = getFrozenCurrentGuardStore();
          const frozenReport = buildFrozenCurrentGuardReport(frozenStore);
          const boundary = getPostCutoverStore().getBoundary();
          postCutoverReport = buildPostCutoverReport(frozenReport, boundary, null);
        }
      } catch { /* post-cutover unavailable */ }
      let variantMatrixReport: CurrentGuardVariantMatrixReport | undefined;
      try {
        if (process.env.CURRENT_GUARD_VARIANT_MATRIX_DISABLED !== "1") {
          variantMatrixReport = buildCurrentGuardVariantMatrixReport(getCurrentGuardVariantMatrixStore());
        }
      } catch { /* variant matrix unavailable */ }
      // ── infraReady gate 1/3: exchange-health readiness (v1, report-only) ──────────────────────
      // Computed from data already in hand (scan freshness). ANDed with killSwitch +
      // orderReconciliation (both still false), so infraReady STAYS false → admission behavior is
      // unchanged. Guarded: any failure → undefined → exchangeHealthReady false (= now).
      let exchangeHealthReadiness: ExchangeHealthReadinessReport | undefined;
      try {
        const _ehScan = getLatestScanCandidates();
        const _ehScanMs = _ehScan?.scanFinishedAt ? new Date(_ehScan.scanFinishedAt).getTime() : null;
        exchangeHealthReadiness = buildExchangeHealthReadinessReport(generatedAt, {
          reachable: _ehScanMs != null && Date.now() - _ehScanMs <= EXCHANGE_HEALTH_MAX_DATA_AGE_MS,
          marketDataAgeMs: _ehScanMs != null ? Date.now() - _ehScanMs : null,
          clockSkewMs: null, // advisory; wired when the signed client surfaces lastMeasuredSkewMs
        });
      } catch { /* exchange-health readiness must never break the brief */ }
      // ── infraReady gate 2/3: order-reconciliation readiness (v1, report-only) ─────────────────
      // READS the live engine's in-memory getStatus() (sync, no I/O) — the engine already reconciles
      // open intents vs the exchange each tick. ready only when the reconcile loop ran recently with
      // 0 drift/errors. ANDed with killSwitch (still false) → infraReady STAYS false → non-breaking.
      // ── infraReady gates 2/3 + 3/3: order-reconciliation + kill-switch readiness (v1, report-only) ─
      // Both READ the live engine's in-memory getStatus() (sync, no I/O — reading does NOT arm,
      // activate, or flatten anything). ANDed with exchangeHealth in infraReady, which is itself
      // ANDed with !liveBlocked → infraReady STAYS false → non-breaking.
      let orderReconciliationReadiness: OrderReconciliationReadinessReport | undefined;
      let killSwitchReadiness: KillSwitchReadinessReport | undefined;
      try {
        const _liveStatus = opts.liveEngineGetter?.()?.getStatus() as
          | {
              enabled?: boolean;
              health?: { lastTickAt?: string | number | null; lastTickError?: string | null };
              reconcileIssues?: unknown[];
              openIntents?: unknown[];
              limits?: { dailyMaxLossUsd?: number; maxDrawdownUsd?: number; maxConsecutiveLosses?: number };
            }
          | null
          | undefined;
        if (_liveStatus) {
          const _lt = _liveStatus.health?.lastTickAt;
          const _ltMs = typeof _lt === "number" ? _lt : typeof _lt === "string" ? new Date(_lt).getTime() : null;
          orderReconciliationReadiness = buildOrderReconciliationReadinessReport(generatedAt, {
            engineEnabled: _liveStatus.enabled === true,
            lastTickAgeMs: _ltMs != null && Number.isFinite(_ltMs) ? Date.now() - _ltMs : null,
            reconcileIssueCount: Array.isArray(_liveStatus.reconcileIssues) ? _liveStatus.reconcileIssues.length : 0,
            lastTickError: _liveStatus.health?.lastTickError ?? null,
            openIntentCount: Array.isArray(_liveStatus.openIntents) ? _liveStatus.openIntents.length : 0,
          });
          killSwitchReadiness = buildKillSwitchReadinessReport(generatedAt, {
            engineEnabled: _liveStatus.enabled === true,
            dailyMaxLossUsd: _liveStatus.limits?.dailyMaxLossUsd ?? null,
            maxDrawdownUsd: _liveStatus.limits?.maxDrawdownUsd ?? null,
            maxConsecutiveLosses: _liveStatus.limits?.maxConsecutiveLosses ?? null,
          });
        }
      } catch { /* live-readiness gates must never break the brief */ }
      const gateReport = buildLiveTradingGateReport({
        postCutoverReport,
        currentGuardVariantMatrixReport: variantMatrixReport,
        exchangeHealthReadiness,
        orderReconciliationReadiness,
        killSwitchReadiness,
      });
      // ── ?paper=1: bounded paper admission + resolver run ─────────────────
      // When paper=1 is supplied and a Binance client is available, run the
      // paper execution router (admission + candle-walk resolver) up to 8 s.
      // Report-only: never affects live behavior, positions, or criteria.
      // A timeout or internal error is silently swallowed; brief always renders.
      let paperReport: PaperPerformanceReport | null = null;
      let allocatorReport: PaperOpportunityAllocatorReport | null = null;
      let provenanceAudit: PaperProvenanceAudit | null = null;
      let shadowGateReport: ShadowLoserFingerprintGateReport | null = null;
      let diagnosticShadowGateReport: ShadowLoserFingerprintGateReport | null = null;
      let latencyDiagnostics: PaperLatencyDiagnostics | null = null;
      let mixedRegimeReport: MixedRegimeReport | null = null;
      let mixedBudgetForwardValidation: MixedBudgetForwardValidationReport | null = null;
      let admissionTrace: AdmissionTimingTrace | null = null;
      if (request.query?.paper === "1" && opts.binanceClient && variantMatrixReport) {
        const _pbc = opts.binanceClient;
        try {
          const paperStore = getPaperExecutionRouterStore();
          const _paperRouter = buildAdaptiveLaneRouterReport({
            generatedAt,
            regimeReport,
            postCutoverReport,
            variantMatrixReport,
            gateReport,
            paperOrders: paperStore.all,
          });
          const paperNow = new Date().toISOString();
          const paperValidationAllowed = process.env.PAPER_VALIDATION_ALLOWED === "1";
          const paperAllocatorOnlyAdmission = process.env.PAPER_ALLOCATOR_ONLY_ADMISSION === "1";

          // ── Paper opportunity allocator (fresh scan candidates × paper lanes) ──
          // Evaluate the most recent cached /api/scan candidates directly so paper
          // execution is no longer source-starved by the variant-matrix tape. Build
          // the report unconditionally (so the brief always shows diagnostics), then
          // admit any eligible opportunities as paper orders BEFORE the resolver runs
          // (resolvePaperOrders walks store.all, so allocator orders resolve too).
          try {
            const cached = getLatestScanCandidates();
            type _MixedCandShape = {
              symbol?: string;
              direction?: string;
              finalDirection?: string | null;
              volatilityScore?: number | null;
              liquidityScore?: number | null;
              indicators?: { fiveMinute?: { atrPercent?: number | null } };
            };
            const _mixedCandidates = (cached?.candidates ?? []) as unknown as _MixedCandShape[];
            mixedRegimeReport = buildMixedRegimeReport({
              regime: cached?.marketRegime ?? regimeReport?.currentRegime ?? null,
              candidates: _mixedCandidates.map((c) => ({
                symbol: c.symbol ?? null,
                direction: c.finalDirection ?? c.direction ?? null,
                regime: cached?.marketRegime ?? null,
                laneId: mixedLaneIdForDirection(c.finalDirection ?? c.direction ?? null),
                atrPercent: c.indicators?.fiveMinute?.atrPercent ?? null,
                volatilityScore: c.volatilityScore ?? null,
                liquidityScore: c.liquidityScore ?? null,
              })),
              orders: paperStore.getState().orders,
              nowMs: Date.now(),
              trailLaneAvailable: true,
            });
            admissionTrace = {
              scanFinishedAt: cached?.scanFinishedAt ?? null,
              candidatesCachedAt: cached?.candidatesCachedAt ?? null,
              allocatorStartedAt: new Date().toISOString(),
              allocatorFinishedAt: null,
              paperAdmissionStartedAt: null,
              paperAdmissionFinishedAt: null,
              createdHeadline: 0,
              createdDiagnostic: 0,
            };

            // ── adaptive lane state (Parts 2/5): compute the active paper lane's
            //    HEADLINE performance + rotation BEFORE admission, so a degraded
            //    lane is quarantined this cycle (not after more losses accrue).
            //    Pure reads of the paper store; never mutates live state.
            const _closedHeadline = paperStore.all.filter(
              (o) =>
                (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
                o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
                o.paperOrderMode !== "DIAGNOSTIC_ONLY",
            );
            const _rotation = evaluatePaperLaneRotation({
              activeLaneId: paperStore.getState().activeLaneId ?? "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
              routerReport: _paperRouter,
              vmReport: variantMatrixReport,
              closedOrders: _closedHeadline,
              controllerMode: _paperRouter.controllerMode,
              regimeFamily: _paperRouter.regimeFamily,
              paperValidationAllowed,
            });
            const _perf = buildPaperPerformanceReport(paperStore, {
              activeLaneId: paperStore.getState().activeLaneId,
              laneConfidence: _rotation.currentLaneConfidence,
              rotationResult: _rotation,
            });
            const _breakdown = buildPaperPerformanceBreakdown(paperStore);
            // Symbols with positive HEADLINE paper cohort evidence (≥3 closed, net>0)
            // override the SYMBOL_NET_NEGATIVE candidate gate for those symbols only.
            const _symbolsWithPositiveCohort = _breakdown.bySymbol
              .filter((r) => r.closed >= 3 && r.netSumR > 0)
              .map((r) => r.key);
            // Advisory only: stamps provenance.symbolHistoricalNet; never gates admission.
            const _symbolHistoricalNetMap: Record<string, number | null> = {};
            for (const r of _breakdown.bySymbol) _symbolHistoricalNetMap[r.key] = r.netSumR;
            const _laneState: AllocatorLaneState = {
              activeLaneId: _perf.activeLane ?? "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
              laneConfidence: _rotation.currentLaneConfidence,
              closedCount: _perf.activeLaneClosed,
              netAvgR: _perf.activeLaneNetAvgR,
              pf: _perf.activeLanePF,
              wr: _perf.activeLaneWR,
              betterLaneAvailable:
                _rotation.action === "ROTATE_TO_BETTER_LANE" && _rotation.selectedNextLaneId != null,
              selectedNextLaneId: _rotation.selectedNextLaneId,
              worstSymbols: _breakdown.worstSymbols.map((w) => ({
                symbol: w.key,
                closed: w.closed,
                netSumR: w.netSumR,
                wr: w.wr,
              })),
              topLossContributors: _breakdown.topLossContributors.map((c) => ({
                symbol: c.symbol,
                direction: c.direction,
                netR: c.netR,
                closeReason: c.closeReason,
              })),
            };

            allocatorReport = buildPaperOpportunityAllocatorReport({
              candidates: cached?.candidates ?? [],
              scanBatchId: cached?.scanBatchId ?? "no-scan",
              scanFinishedAt: cached?.scanFinishedAt ?? paperNow,
              marketRegime: cached?.marketRegime ?? null,
              vmReport: variantMatrixReport,
              routerReport: _paperRouter,
              // Lane-level honest-edge veto: rejects proven-negative lanes (wide-stop
              // SHORT) while letting positive lanes (tight/fast-TP SHORT) in the same
              // direction admit — captures the edge the coarse direction gate missed.
              laneEdgeGate: edgeMemory,
              now: paperNow,
              // On the first paper run, anchor at the current source scan rather
              // than a later brief timestamp so the fresh scan is not mislabeled
              // as pre-paper backfill. Existing paperStartAt is never reset.
              paperStartAt: paperStore.ensurePaperStartAt(cached?.scanFinishedAt ?? paperNow),
              paperValidationAllowed,
              laneState: _laneState,
              paperDiagnosticContinue: process.env.PAPER_DIAGNOSTIC_CONTINUE === "1",
              paperRejectDiagnosticContinue: process.env.PAPER_REJECT_DIAGNOSTIC_CONTINUE === "1",
              paperRejectDiagnosticMaxPerScan: (() => {
                const n = Number(process.env.PAPER_REJECT_DIAGNOSTIC_MAX_PER_SCAN);
                return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
              })(),
              paperChallengerDiagnosticEnabled:
                process.env.PAPER_CHALLENGER_DIAGNOSTIC_ENABLED !== "0",
              paperChallengerDiagnosticMaxPerScan: (() => {
                const n = Number(process.env.PAPER_CHALLENGER_DIAGNOSTIC_MAX_PER_SCAN);
                return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
              })(),
              // Quarantine the CG_TRAIL_AFTER_TP1 challenger: trail_after_tp1 is
              // falsified net-negative on this universe (no edge over tp1_full), so
              // stop admitting new trail paper orders. Set PAPER_CHALLENGER_QUARANTINED=0
              // to resume data collection.
              paperChallengerQuarantined:
                process.env.PAPER_CHALLENGER_QUARANTINED !== "0",
              // Full variant-matrix paper collection: admit DIAGNOSTIC_ONLY sleeves for
              // baseline/scaleout/no-fib500/maker in both directions (resolver honestly resolves
              // every exit/fill rule). Set PAPER_VARIANT_MATRIX_DIAGNOSTIC=0 to disable.
              paperVariantMatrixDiagnosticEnabled:
                process.env.PAPER_VARIANT_MATRIX_DIAGNOSTIC !== "0",
              // Auto-halt admission into variant lanes that are confidently net-negative in paper.
              paperVariantAutoQuarantineEnabled:
                process.env.PAPER_VARIANT_AUTO_QUARANTINE !== "0",
              // CG_WIDE priority: bypass the VM-sim economics veto for CG_WIDE and keep it at
              // ~90% of admitted opportunities (diagnostics trimmed to the remainder). The
              // paper-based lane-rotation backstop still guards CG_WIDE. Tunable via env.
              paperCgWidePriority: process.env.PAPER_CG_WIDE_PRIORITY !== "0",
              paperCgWideTargetShare: (() => {
                const n = Number(process.env.PAPER_CG_WIDE_TARGET_SHARE);
                return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.9;
              })(),
              // EXP 10x MFE LONG priority: main `/` paper collection should prefer this
              // long diagnostic lane while bullish LONG_ONLY is active. Paper-only; testnet
              // live mirror still has its own stable-candidate selector.
              paperExpLongMfePriority: process.env.PAPER_EXP_LONG_MFE_PRIORITY !== "0",
              paperExpLongMfeMaxPerScan: (() => {
                const n = Number(process.env.PAPER_EXP_LONG_MFE_MAX_PER_SCAN);
                return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
              })(),
              paperExpLongMfeTargetShare: (() => {
                const n = Number(process.env.PAPER_EXP_LONG_MFE_TARGET_SHARE);
                return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
              })(),
              symbolsWithPositiveCohort: _symbolsWithPositiveCohort,
              symbolHistoricalNetMap: _symbolHistoricalNetMap,
              currentPaperOrders: paperStore.getState().orders,
              mixedRegimeReport,
              // Per-lane symbol auto-curation: unset (default) on the diagnostic instance itself —
              // it must keep exploring the full symbol universe on every lane. testnet/live opt in
              // via .env and consume the cached report fetched from the diagnostic instance.
              laneSymbolCurationTier: (process.env.LANE_SYMBOL_CURATION_TIER as "testnet" | "live" | undefined) ?? null,
              laneSymbolCurationReport: getLaneSymbolCurationCacheStore().get().report,
              laneSymbolCurationReportGeneratedAt: getLaneSymbolCurationCacheStore().get().fetchedAt,
            });
            admissionTrace.allocatorFinishedAt = new Date().toISOString();
            if (allocatorReport.selectedOpportunities.length > 0) {
              admissionTrace.paperAdmissionStartedAt = new Date().toISOString();
              const admitResult = admitPaperOpportunities({
                store: paperStore,
                opportunities: allocatorReport.selectedOpportunities,
                routerReport: _paperRouter,
                gateReport,
                now: paperNow,
              });
              admissionTrace.paperAdmissionFinishedAt = new Date().toISOString();
              allocatorReport.paperOrdersCreated = admitResult.admitted;
              allocatorReport.createdHeadline = admitResult.admittedHeadline;
              allocatorReport.createdDiagnostic = admitResult.admittedDiagnostic;
              allocatorReport.duplicateSuppressed += admitResult.duplicateSuppressed;
              admissionTrace.createdHeadline = admitResult.admittedHeadline;
              admissionTrace.createdDiagnostic = admitResult.admittedDiagnostic;
            }

            // Report-only provenance audit + loser-fingerprint gate simulation are
            // intentionally NOT computed here. They (and the activeLane* metrics
            // rendered in Section 10) are recomputed AFTER the resolver from the
            // single final post-resolve store snapshot so the brief never mixes a
            // pre-resolve (closed=N) audit with a post-resolve (closed=N+1) report.
          } catch (error) {
            // Containment is correct (an allocator bug must never break the whole brief), but this
            // is the ADMISSION path — not a report endpoint — so a silent catch here means the bot
            // can stop admitting new positions for an arbitrary number of cycles with zero signal
            // anywhere (no log line, no field on the response). Surface it without changing the
            // containment behavior itself.
            console.error(
              `[shadow] paper allocator/admission failed this cycle (admission skipped, prior report retained): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          finally {
            if (admissionTrace) {
              if (!admissionTrace.allocatorFinishedAt) admissionTrace.allocatorFinishedAt = new Date().toISOString();
              try {
                recordAdmissionTimingTrace(admissionTrace);
              } catch {
                // admission trace persistence is report-only
              }
            }
          }

          // Execution realism: the paper-shadow run simulates live fills WITH slippage
          // (entry=telat-masuk, stop=telat-jual) so paper PnL previews live execution.
          // ON by default; PAPER_EXECUTION_REALISM=0 reverts to idealized fills, and the
          // per-leg bps are tunable. Slippage assumes resting SL/TP orders at the venue.
          const _slipEnv = (v: string | undefined, d: number): number => {
            const n = Number(v);
            return Number.isFinite(n) && n >= 0 ? n : d;
          };
          const _paperExecModel: PaperExecutionModel =
            process.env.PAPER_EXECUTION_REALISM === "0"
              ? PAPER_EXECUTION_MODEL_IDEAL
              : {
                  entrySlippageBps: _slipEnv(
                    process.env.PAPER_ENTRY_SLIPPAGE_BPS,
                    PAPER_EXECUTION_MODEL_REALISTIC.entrySlippageBps,
                  ),
                  stopSlippageBps: _slipEnv(
                    process.env.PAPER_STOP_SLIPPAGE_BPS,
                    PAPER_EXECUTION_MODEL_REALISTIC.stopSlippageBps,
                  ),
                  tpSlippageBps: _slipEnv(
                    process.env.PAPER_TP_SLIPPAGE_BPS,
                    PAPER_EXECUTION_MODEL_REALISTIC.tpSlippageBps,
                  ),
                };

          const allocatorSelectedLaneId = allocatorReport?.selectedOpportunities[0]?.laneId ?? null;
          const resolverMaxRuntimeMs = (() => {
            const n = Number(process.env.PAPER_RESOLVER_MAX_RUNTIME_MS);
            return Number.isFinite(n) && n > 0 ? Math.max(8_000, Math.floor(n)) : 12_000;
          })();
          const paperRunPromise = runPaperAdmissionAndResolution({
            store: paperStore,
            vmStore: getCurrentGuardVariantMatrixStore(),
            routerReport: _paperRouter,
            vmReport: variantMatrixReport,
            gateReport,
            binanceClient: {
              getKlines: async (symbol, _interval, klineOpts) => {
                const candles = await _pbc.getCandles(symbol, _interval, klineOpts.limit, {
                  startTime: klineOpts.startTime,
                  endTime: klineOpts.endTime,
                });
                return candles.map((c) => [
                  c.openTime,
                  "0",
                  String(c.high),
                  String(c.low),
                  String(c.close),
                  "0",
                  c.openTime + 300_000,
                ] as PaperKlineTuple);
              },
            },
            now: paperNow,
            paperValidationAllowed,
            allocatorActiveLaneId:
              paperAllocatorOnlyAdmission || _paperRouter.regimeFamily === "MIXED"
                ? allocatorSelectedLaneId
                : null,
            allocatorOnlyAdmission: paperAllocatorOnlyAdmission,
            executionModel: _paperExecModel,
            // 8/run was far too tight for a live book of ~200+ open orders (it left the book
            // barely resolving and piling toward the 7-day expiry). Budget is now spent only on
            // real fetch-walks (expiry sweep is free), so a deeper bound drains the book; the
            // runtime cap keeps it from monopolizing the event loop.
            // SANITY FLOOR (2026-06-22): clamp a too-small env override UP (the VPS had this at 6,
            // which froze the paper book at ~4 closed / 570 open for days). Tunable higher, never lower.
            resolverMaxOrders: (() => {
              const n = Number(process.env.PAPER_RESOLVER_MAX_ORDERS_PER_RUN);
              return Number.isFinite(n) && n > 0 ? Math.max(40, Math.floor(n)) : 80;
            })(),
            resolverMaxRuntimeMs,
          });
          // The outer race is a backstop for the resolver failing to respect its own
          // resolverMaxRuntimeMs budget (e.g. hanging inside a single candle fetch that doesn't
          // hit the loop's time-check) — it must never be TIGHTER than that budget itself. It
          // previously hardcoded 8_000ms while the budget defaulted to 12_000ms, so under default
          // config this race ALWAYS discarded the resolver's work before it could finish normally,
          // silently re-narrowing the very floor the 2026-06-22 SANITY FLOOR comment above raised.
          // .catch() prevents an unhandled rejection if the abandoned promise fails after we've
          // already moved on with the stale paperReport.
          const result = await Promise.race([
            paperRunPromise.catch(() => null),
            new Promise<null>((res) => { setTimeout(() => res(null), resolverMaxRuntimeMs + 4_000); }),
          ]);
          if (result !== null) paperReport = result;

          // Feed the honest-edge gate: rebuild the live aggregate from the
          // post-resolve store so newly-closed orders update each (regime ×
          // direction) slice. Idempotent; the frozen seed prior is untouched.
          try {
            edgeMemory.updateFromClosedOrders(paperStore.getState().orders);
            edgeMemory.save();
          } catch { /* edge-memory update is report-only; never break the brief */ }

          // ── Single post-resolve snapshot reconciliation (Section 10 consistency) ──
          // The resolver mutates the paper store (orders close), so the allocator
          // report's activeLane* metrics and the provenance audit / shadow gate must
          // be recomputed from the SAME final store snapshot as paperReport. Without
          // this, top-level closed=N+1 disagrees with activeLanePerf/provenanceAudit
          // closed=N. Pure reads; never authorize live trading or write positions.
          try {
            const _final = buildPaperPerformanceReport(paperStore, {
              activeLaneId: paperStore.getState().activeLaneId,
              laneConfidence:
                allocatorReport?.laneConfidence ??
                paperStore.getState().laneConfidence ??
                "MEDIUM",
              executionModel: _paperExecModel,
            });
            if (allocatorReport) {
              _final.paperLaneConfidence =
                allocatorReport.paperLaneConfidence ?? _final.paperLaneConfidence;
              _final.rotationAction =
                allocatorReport.rotationAction === "CONTINUE_DIAGNOSTIC_ONLY"
                  ? "CONTINUE_PAPER_WITH_LOW_CONFIDENCE"
                  : allocatorReport.rotationAction;
              _final.noOrderReason =
                allocatorReport.blocker !== "none"
                  ? allocatorReport.blocker
                  : _final.noOrderReason;
              allocatorReport.activeLaneClosed = _final.activeLaneClosed;
              allocatorReport.activeLaneNetAvgR = _final.activeLaneNetAvgR;
              allocatorReport.activeLanePF = _final.activeLanePF;
              allocatorReport.activeLaneWR = _final.activeLaneWR;
              if (allocatorReport.paperLaneConfidence !== "DEGRADED") {
                allocatorReport.paperLaneConfidence = derivePaperLaneConfidence(
                  _final.activeLaneClosed,
                  _final.activeLaneNetAvgR,
                  _final.activeLanePF,
                  _final.activeLaneWR,
                  allocatorReport.laneConfidence ?? _final.laneConfidence,
                );
              }
              _final.currentBatchActiveLane = allocatorReport.selectedOpportunities[0]?.laneId ?? null;
              _final.currentBatchOrderMode =
                allocatorReport.createdHeadline > 0
                  ? "HEADLINE"
                  : allocatorReport.createdDiagnostic > 0
                    ? "DIAGNOSTIC_ONLY"
                    : null;
              _final.currentBatchCreatedCount =
                (allocatorReport.createdHeadline ?? 0) + (allocatorReport.createdDiagnostic ?? 0);
            }
            // Always render the final post-resolve snapshot. Allocator posture is
            // copied above so a slow resolver cannot fall back to stale persisted
            // HIGH/KEEP_CURRENT_LANE state while the active economics are rejected.
            paperReport = _final;
            provenanceAudit = buildPaperProvenanceAudit(paperStore);
            shadowGateReport = simulateLoserFingerprintGate(paperStore, { scope: "HEADLINE_ONLY" });
            // Diagnostic Provenance V1: forensic DIAGNOSTIC_ONLY-scope gate. Report-only —
            // surfaced as REPORT_ONLY_PROMISING at most; never promotes an active gate.
            diagnosticShadowGateReport = simulateLoserFingerprintGate(paperStore, { scope: "DIAGNOSTIC_ONLY" });
            // ── E2E LATENCY CORRIDOR (measurement-only — rules DISABLED) ──────────
            // Report-only: measures scan/candidate/price/admission/resolver latency so
            // the operator can see the end-to-end time. The rules corridor is PREPARED
            // but NOT enforced (staleSkipped=0, latencyBlocker advisory). rulesEnabled
            // defaults false; the PAPER_LATENCY_RULES_ENABLED env hook only un-prefixes
            // the advisory label — no admission is ever skipped here.
            try {
              const _latCache = getLatestScanCandidates();
              // Freshest candidate price-data candle OPEN (5m lastOpenTime). Anti-lookahead:
              // candidate data age is anchored on the source candle, never the request time.
              // The open (not close) is used because the latest 5m candle is still forming —
              // its close lies in the future, which would yield a negative/invalid age.
              let _freshestObservationMs: number | null = null;
              for (const cand of _latCache?.candidates ?? []) {
                const openMs = cand.indicators?.fiveMinute?.lastOpenTime;
                if (typeof openMs === "number" && Number.isFinite(openMs)) {
                  if (_freshestObservationMs === null || openMs > _freshestObservationMs) {
                    _freshestObservationMs = openMs;
                  }
                }
              }
              latencyDiagnostics = buildPaperLatencyDiagnostics({
                now: paperNow,
                // Anti-n/a: the in-memory scan cache is only populated by the /api/scan
                // route, so it can be empty after a restart or a scheduler-only scan even
                // though the header shows a finished time. Fall back to the SAME source the
                // header uses (scanStatus.lastAutoRefreshFinishedAt) so scanAgeSec is real.
                scanFinishedAt:
                  _latCache?.scanFinishedAt ?? scanStatus?.lastAutoRefreshFinishedAt ?? null,
                freshestCandidatePriceObservationMs: _freshestObservationMs,
                latestOrders: _final.latestOrders,
                // Block B backlog reads ALL orders (builder filters to open ones).
                openOrders: paperStore.getState().orders,
                // Empirical hold-time of CLOSED orders → lane's "normal" hold (p50/p90)
                // that the report-only hold buckets are judged against.
                closedHoldSamplesSec: paperStore
                  .getState()
                  .orders.filter(
                    (o) =>
                      o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS",
                  )
                  .map((o) => (new Date(o.updatedAt).getTime() - new Date(o.openedAt).getTime()) / 1000)
                  .filter((v) => Number.isFinite(v) && v >= 0),
                // Block A admission metrics only render for admissions created THIS cycle.
                createdThisCycle:
                  (allocatorReport?.createdHeadline ?? 0) + (allocatorReport?.createdDiagnostic ?? 0),
                // Corridor prepared, NOT switched on. Env only flips the advisory label.
                rulesEnabled: process.env.PAPER_LATENCY_RULES_ENABLED === "1",
              });
            } catch { /* latency computation must never break the brief */ }

            // ── MIXED REGIME ROUTER (diagnostic routing evidence; never admits) ──
            try {
              const _mc = getLatestScanCandidates();
              const _paperOrders = getPaperExecutionRouterStore().getState().orders;
              type _CandShape = {
                symbol?: string;
                direction?: string;
                finalDirection?: string | null;
                volatilityScore?: number | null;
                liquidityScore?: number | null;
                indicators?: { fiveMinute?: { atrPercent?: number | null } };
              };
              const _cands = (_mc?.candidates ?? []) as unknown as _CandShape[];
              if (mixedRegimeReport === null) {
                mixedRegimeReport = buildMixedRegimeReport({
                  regime: _mc?.marketRegime ?? regimeReport?.currentRegime ?? null,
                  candidates: _cands.map((c) => ({
                    symbol: c.symbol ?? null,
                    direction: c.finalDirection ?? c.direction ?? null,
                    regime: _mc?.marketRegime ?? null,
                    laneId: mixedLaneIdForDirection(c.finalDirection ?? c.direction ?? null),
                    atrPercent: c.indicators?.fiveMinute?.atrPercent ?? null,
                    volatilityScore: c.volatilityScore ?? null,
                    liquidityScore: c.liquidityScore ?? null,
                  })),
                  orders: _paperOrders,
                  nowMs: Date.now(),
                  trailLaneAvailable: true, // CG_TRAIL_AFTER_TP1 is a defined variant
                });
              }
              mixedBudgetForwardValidation = buildMixedBudgetForwardValidation(_paperOrders);
            } catch { /* mixed router must never break the brief */ }
          } catch { /* reconciliation failure must never break the brief */ }
        } catch { /* paper=1 failure must never break the brief */ }
      }
      if (request.query?.headless === "1") {
        void reply.type("application/json");
        return {
          ok: true,
          generatedAt,
          mode: "headless-paper-cycle",
          variantMatrixResolver: variantMatrixReport?.resolverDiagnostics ?? null,
          paper: paperReport
            ? {
                total: paperReport.total,
                open: paperReport.open,
                closed: paperReport.closed,
                win: paperReport.win,
                loss: paperReport.loss,
                totalRealizedPaperPnl: paperReport.totalRealizedPaperPnl,
                diagnosticRealizedPaperPnl: paperReport.diagnosticRealizedPaperPnl,
                activeLane: paperReport.activeLane,
              }
            : null,
          allocator: allocatorReport
            ? {
                selected: allocatorReport.selectedOpportunities.length,
                createdHeadline: allocatorReport.createdHeadline,
                createdDiagnostic: allocatorReport.createdDiagnostic,
                blocker: allocatorReport.blocker,
              }
            : null,
          admissionTrace,
        };
      }

      const brief = buildOperatorBrief({
        generatedAt,
        era,
        scanStatus,
        regimeReport,
        postCutoverReport,
        variantMatrixReport,
        gateReport,
        paperReport,
        paperOrders: getPaperExecutionRouterStore().all,
        allocatorReport,
        provenanceAudit,
        shadowGateReport,
        diagnosticShadowGateReport,
        latencyDiagnostics,
        mixedRegimeReport,
        mixedBudgetForwardValidation,
        scanTimingDiagnostics: getLatestScanTimingDiagnostics(),
      });
      // Notification-only post-brief hook. Reuses the same controller/paper/
      // forward-validation state and runs asynchronously so Telegram latency or
      // failure can never delay or break the operator brief.
      if (opts.notificationService) {
        try {
          const notificationPaperReport =
            paperReport ?? buildPaperPerformanceReport(getPaperExecutionRouterStore());
          const notificationValidation =
            mixedBudgetForwardValidation ??
            buildMixedBudgetForwardValidation(getPaperExecutionRouterStore().getState().orders);
          const latestOrder = notificationPaperReport.latestOrders[0] ?? null;
          const snapshot: NotificationSnapshot = {
            regime: regimeReport?.currentRegime ?? null,
            mode: regimeReport?.controllerMode ?? null,
            bias: regimeReport?.directionalBias ?? null,
            confidence: regimeReport?.confidence ?? null,
            paperPnl: notificationPaperReport.realizedPaperPnl,
            diagnosticPnl: notificationPaperReport.diagnosticRealizedPaperPnl,
            totalPaperPnl: notificationPaperReport.totalRealizedPaperPnl,
            startingBalance: notificationPaperReport.startingEquity,
            headlineBalance:
              notificationPaperReport.startingEquity +
              notificationPaperReport.realizedPaperPnl,
            totalBalance:
              notificationPaperReport.startingEquity +
              notificationPaperReport.totalRealizedPaperPnl,
            monthTotalPaperPnl: notificationPaperReport.monthTotalPaperPnl,
            todayClosed: notificationPaperReport.taipeiDailyClosed,
            todayWins: notificationPaperReport.taipeiDailyWins,
            todayLosses: notificationPaperReport.taipeiDailyLosses,
            todayHeadlinePnl: notificationPaperReport.taipeiDailyHeadlinePnl,
            todayDiagnosticPnl: notificationPaperReport.taipeiDailyDiagnosticPnl,
            todayTotalPnl: notificationPaperReport.taipeiDailyTotalPnl,
            dailyPnl: notificationPaperReport.dailyPaperPnl,
            headlineNet: notificationPaperReport.headlineNetAvgR,
            headlinePF: notificationPaperReport.headlinePF,
            headlineWR: notificationPaperReport.headlineWR,
            guardrailStatus: notificationValidation.guardrail.status,
            recommendedAction: notificationValidation.guardrail.recommendedAction,
            guardrailReasons: notificationValidation.guardrail.reasons,
            activeMixedBudgetProfile: notificationValidation.activeMixedBudgetProfile,
            closedUnderProfileCount: notificationValidation.closedUnderProfileCount,
            forwardVerdict: notificationValidation.verdict,
            totalOrders: notificationPaperReport.total,
            openOrders: notificationPaperReport.open,
            closedOrders: notificationPaperReport.closed,
            wins: notificationPaperReport.win,
            losses: notificationPaperReport.loss,
            latestOrder: latestOrder
              ? {
                  symbol: latestOrder.symbol,
                  direction: latestOrder.direction,
                  lane: latestOrder.selectedLaneId,
                  admission: latestOrder.admissionResult ?? null,
                  profile: latestOrder.mixedBudgetProfile ?? null,
                  occupancyMode: latestOrder.occupancyMode ?? null,
                  riskMultiplier: latestOrder.riskMultiplierAfterOccupancy ?? null,
                }
              : null,
          };
          void opts.notificationService.evaluate(snapshot).catch(() => {
            // Notification failures stay isolated from scan and brief responses.
          });
        } catch {
          // Notification evaluation is best-effort and must never affect output.
        }
      }
      void reply.type("text/plain");
      return brief;
    } catch {
      void reply.code(500).type("text/plain");
      return "OPERATOR BRIEF UNAVAILABLE — internal error\n";
    }
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/profit-policy-synthesis", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: AdaptiveProfitPolicyEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: AdaptiveProfitPolicyEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as AdaptiveProfitPolicyEvidenceEra)
      : "POST_CALIBRATION";
    const state = overlayStore.readState();
    const externalRotationOverlay = buildExternalRotationOverlayPerformanceReport(state.observations, {
      evidenceEra,
      lastRefreshDiagnostics: state.latestRefreshDiagnostics ?? null,
      autoRefreshStatus: overlayAutoRefreshController.getStatus(),
    });
    const externalRotationOverlayEconomics = buildExternalRotationOverlayEconomicsReport(state.observations, { evidenceEra });
    return buildAdaptiveProfitPolicySynthesisReport(
      buildStrategyExperienceRecords(shadowEngine.getAllPositions()),
      {
        evidenceEra,
        externalRotationOverlay,
        externalRotationOverlayEconomics,
      },
    );
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/technical-stop-tp-credibility", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: TechnicalStopTpEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: TechnicalStopTpEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as TechnicalStopTpEvidenceEra)
      : "POST_CALIBRATION";
    const records = buildStrategyExperienceRecords(shadowEngine.getAllPositions());
    return buildTechnicalStopTpCredibilityReport(records, { evidenceEra });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/universe-rotation-intelligence", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: UniverseRotationEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: UniverseRotationEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as UniverseRotationEvidenceEra)
      : "POST_CALIBRATION";
    const records = buildStrategyExperienceRecords(shadowEngine.getAllPositions());
    return buildUniverseRotationIntelligenceReport(records, { evidenceEra });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/external-candidate-discovery-intelligence", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    const allowed: ExternalDiscoveryEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: ExternalDiscoveryEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as ExternalDiscoveryEvidenceEra)
      : "POST_CALIBRATION";
    const records = buildStrategyExperienceRecords(shadowEngine.getAllPositions());
    const rotationReport = buildUniverseRotationIntelligenceReport(records, { evidenceEra });
    const currentUniverseSymbols = [...CURRENT_SCANNER_UNIVERSE];
    const externalMetadataResult = await fetchExternalCandidateMetadataSnapshotWithDiagnostics({
      currentUniverseSymbols,
      fetchImpl: opts.metadataFetchImpl,
    });
    return buildExternalCandidateDiscoveryIntelligenceReport({
      records,
      currentUniverseSymbols,
      externalCandidateMetadata: externalMetadataResult.metadata,
      metadataDiagnostics: externalMetadataResult.diagnostics,
      promisingFingerprints: rotationReport.promisingFingerprints,
      toxicFingerprints: rotationReport.toxicFingerprints,
      evidenceEra,
    });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/external-strategy-fit-enrichment", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    if (!opts.binanceClient) {
      reply.code(503);
      return { error: "ENRICHMENT_UNAVAILABLE", message: "Binance client is not available for external strategy-fit enrichment." };
    }
    const allowed: ExternalDiscoveryEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: ExternalDiscoveryEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as ExternalDiscoveryEvidenceEra)
      : "POST_CALIBRATION";
    return buildExternalStrategyFitForEra(evidenceEra);
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/external-rotation-overlay-performance", async (request, reply) => {
    const allowed: ExternalDiscoveryEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: ExternalDiscoveryEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as ExternalDiscoveryEvidenceEra)
      : "POST_CALIBRATION";
    const state = overlayStore.readState();
    return buildExternalRotationOverlayPerformanceReport(state.observations, {
      evidenceEra,
      lastRefreshDiagnostics: state.latestRefreshDiagnostics ?? null,
      autoRefreshStatus: overlayAutoRefreshController.getStatus(),
    });
  });

  app.get("/api/shadow/external-rotation-overlay/auto-refresh-status", async () => {
    return overlayAutoRefreshController.getStatus();
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/external-rotation-overlay-economics", async (request) => {
    const allowed: ExternalDiscoveryEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: ExternalDiscoveryEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as ExternalDiscoveryEvidenceEra)
      : "POST_CALIBRATION";
    const state = overlayStore.readState();
    return buildExternalRotationOverlayEconomicsReport(state.observations, { evidenceEra });
  });

  app.get<{ Querystring: { era?: string } }>("/api/shadow/tp-sl-geometry-root-cause-audit", async (request) => {
    const allowed: ExternalDiscoveryEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: ExternalDiscoveryEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as ExternalDiscoveryEvidenceEra)
      : "POST_CALIBRATION";
    const state = overlayStore.readState();
    return buildTpSlGeometryRootCauseAuditReport(state.observations, { evidenceEra });
  });

  app.post<{ Querystring: { era?: string } }>("/api/shadow/external-rotation-overlay/refresh", async (request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    if (!opts.binanceClient) {
      reply.code(503);
      return { error: "OVERLAY_UNAVAILABLE", message: "Binance client is not available for external rotation overlay refresh." };
    }
    const allowed: ExternalDiscoveryEvidenceEra[] = ["POST_CALIBRATION", "ALL_TIME"];
    const raw = request.query?.era;
    const evidenceEra: ExternalDiscoveryEvidenceEra = (allowed as string[]).includes(raw ?? "")
      ? (raw as ExternalDiscoveryEvidenceEra)
      : "POST_CALIBRATION";
    const manual = await overlayAutoRefreshController.runManual(() => runOverlayRefresh(evidenceEra, "MANUAL"));
    if (manual.status === "ALREADY_RUNNING") {
      reply.code(409);
      return {
        error: "OVERLAY_REFRESH_ALREADY_RUNNING",
        message: "External rotation overlay refresh is already running.",
        autoRefresh: overlayAutoRefreshController.getStatus(),
      };
    }
    const refresh: ExternalRotationOverlayRefreshResult = manual.value;
    return {
      ...refresh,
      performance: buildExternalRotationOverlayPerformanceReport(refresh.observations, {
        evidenceEra,
        lastRefreshDiagnostics: refresh.diagnostics,
        autoRefreshStatus: overlayAutoRefreshController.getStatus(),
      }),
    };
  });

  // ── TIMEBOXED-EXIT COUNTERFACTUAL DIAGNOSTIC (DIAGNOSTIC-ONLY) ──────────────
  // Re-prices the EXISTING CG_WIDE orders under a 4h/8h exit cap to answer:
  // "can this signal be made faster without destroying expectancy?" Pure read +
  // counterfactual — never admits, mutates the store, force-closes, or goes live.
  // ?boxes=4,8 (hours)  ?limit=N (most-recent source orders)  ?format=text
  app.get<{ Querystring: { boxes?: string; limit?: string; format?: string } }>(
    "/api/shadow/timebox-exit-diagnostic",
    async (request, reply) => {
      if (!opts.binanceClient) {
        reply.code(503);
        return { error: "BINANCE_UNAVAILABLE", message: "Candle source is not configured." };
      }
      const _tbc = opts.binanceClient;
      const klineClient = {
        getKlines: async (
          symbol: string,
          interval: string,
          klineOpts: { startTime: number; endTime: number; limit: number },
        ): Promise<PaperKlineTuple[]> => {
          const candles = await _tbc.getCandles(symbol, interval, klineOpts.limit, {
            startTime: klineOpts.startTime,
            endTime: klineOpts.endTime,
          });
          return candles.map(
            (c) =>
              [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + 300_000] as PaperKlineTuple,
          );
        },
      };

      const boxes = (request.query?.boxes ?? "4,8")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 4);
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 80;

      const SOURCE_LANE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
      const orders = getPaperExecutionRouterStore()
        .getState()
        .orders.filter((o) => o.selectedLaneId === SOURCE_LANE)
        .slice(-limit);

      // Same fill realism as the live paper-shadow run (env-gated).
      const model =
        process.env.PAPER_EXECUTION_REALISM === "0"
          ? PAPER_EXECUTION_MODEL_IDEAL
          : PAPER_EXECUTION_MODEL_REALISTIC;

      const reports = [];
      for (const h of boxes.length > 0 ? boxes : [4, 8]) {
        try {
          reports.push(
            await buildTimeboxedExitDiagnostic(orders, klineClient, {
              laneId: `CG_TIMEBOXED_EXIT_${h}H_DIAGNOSTIC`,
              timeboxHours: h,
              executionModel: model,
            }),
          );
        } catch {
          /* a single box failure must not break the others */
        }
      }

      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return buildTimeboxedExitDiagnosticBriefLines(reports).join("\n");
      }
      return {
        sourceLane: SOURCE_LANE,
        ordersConsidered: orders.length,
        executionRealism: model === PAPER_EXECUTION_MODEL_IDEAL ? "IDEAL" : "REALISTIC",
        reports,
        rendered: buildTimeboxedExitDiagnosticBriefLines(reports),
      };
    },
  );

  // ── FAST/TIGHT-TP COUNTERFACTUAL DIAGNOSTIC (DIAGNOSTIC-ONLY) ───────────────
  // Re-prices the EXISTING CG_WIDE orders under tighter TP variants (price target,
  // not clock) to answer: "can we bank earlier without destroying expectancy?"
  // Pure read + counterfactual — never admits, mutates the store, force-closes,
  // touches headline, or goes live.
  // ?variants=0.25,0.5,0.75  ?partials=1  ?limit=N  ?format=text
  app.get<{ Querystring: { variants?: string; partials?: string; limit?: string; format?: string } }>(
    "/api/shadow/fast-tp-diagnostic",
    async (request, reply) => {
      if (!opts.binanceClient) {
        reply.code(503);
        return { error: "BINANCE_UNAVAILABLE", message: "Candle source is not configured." };
      }
      const _ftc = opts.binanceClient;
      const klineClient = {
        getKlines: async (
          symbol: string,
          interval: string,
          klineOpts: { startTime: number; endTime: number; limit: number },
        ): Promise<PaperKlineTuple[]> => {
          const candles = await _ftc.getCandles(symbol, interval, klineOpts.limit, {
            startTime: klineOpts.startTime,
            endTime: klineOpts.endTime,
          });
          return candles.map(
            (c) =>
              [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + 300_000] as PaperKlineTuple,
          );
        },
      };

      const variantsParam = (request.query?.variants ?? "").trim().toLowerCase();
      let variants: FastTpVariant[];
      if (variantsParam === "trail-sweep") {
        variants = buildFastTpTrailSweepVariants(); // 0.75R / 50% partial, trail 0.25..1.25R
      } else if (variantsParam === "trail-grid") {
        variants = buildFastTpTrailGridVariants(); // firstTP × partial × trail (27)
      } else {
        const levels = (request.query?.variants ?? "0.25,0.5,0.75")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
          .slice(0, 6);
        const includePartials = request.query?.partials !== "0"; // default ON
        variants = buildFastTpVariants(levels.length > 0 ? levels : [0.25, 0.5, 0.75], includePartials);
      }
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 80;

      const SOURCE_LANE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
      const orders = getPaperExecutionRouterStore()
        .getState()
        .orders.filter((o) => o.selectedLaneId === SOURCE_LANE)
        .slice(-limit);

      const model =
        process.env.PAPER_EXECUTION_REALISM === "0"
          ? PAPER_EXECUTION_MODEL_IDEAL
          : PAPER_EXECUTION_MODEL_REALISTIC;

      let reports: FastTpVariantReport[];
      try {
        reports = await buildFastTpTightDiagnostic(orders, klineClient, variants, { executionModel: model });
      } catch {
        reports = [];
      }
      const ranking = rankFastTpReports(reports);

      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return [
          ...buildFastTpTightDiagnosticBriefLines(reports),
          ...buildFastTpRankingBriefLines(reports, ranking),
        ].join("\n");
      }
      return {
        sourceLane: SOURCE_LANE,
        ordersConsidered: orders.length,
        executionRealism: model === PAPER_EXECUTION_MODEL_IDEAL ? "IDEAL" : "REALISTIC",
        reports,
        ranking,
        rendered: [
          ...buildFastTpTightDiagnosticBriefLines(reports),
          ...buildFastTpRankingBriefLines(reports, ranking),
        ],
      };
    },
  );

  // ── ENTRY-QUALITY / COHORT DIAGNOSTIC (DIAGNOSTIC-ONLY) ─────────────────────
  // Pure store read: slices CG_WIDE closed-order economics by entry attributes to
  // find which entries are toxic / late / regime-specific. Never mutates the store,
  // never gates admission, never touches headline or live.
  // ?dims=symbol,regime,...  ?minN=3  ?toxic=-0.5  ?limit=N  ?format=text
  app.get<{ Querystring: { dims?: string; minN?: string; toxic?: string; limit?: string; format?: string } }>(
    "/api/shadow/entry-cohort-diagnostic",
    async (request, reply) => {
      const SOURCE_LANE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 500;
      const orders = getPaperExecutionRouterStore()
        .getState()
        .orders.filter((o) => o.selectedLaneId === SOURCE_LANE)
        .slice(-limit);

      const dims = request.query?.dims
        ? request.query.dims.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const minRaw = Number(request.query?.minN);
      const toxRaw = Number(request.query?.toxic);
      const report = buildEntryCohortDiagnostic(orders, {
        dimensions: dims,
        minSampleForToxic: Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : undefined,
        toxicNetThreshold: Number.isFinite(toxRaw) ? toxRaw : undefined,
      });

      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return buildEntryCohortDiagnosticBriefLines(report).join("\n");
      }
      return {
        sourceLane: SOURCE_LANE,
        ordersConsidered: orders.length,
        report,
        rendered: buildEntryCohortDiagnosticBriefLines(report),
      };
    },
  );

  // ── TOXIC-SYMBOL GATE SIMULATION V1 (DIAGNOSTIC-ONLY) ───────────────────────
  // Report-only "what if we'd filtered these entries" sim over the CG_WIDE closed
  // book. Never admits, mutates the store, activates a gate, touches headline, or
  // goes live. IN-SAMPLE — see overfitRisk/recommendation on each gate.
  // ?minN=5  ?toxic=-0.5  ?limit=N  ?format=text
  app.get<{ Querystring: { minN?: string; toxic?: string; limit?: string; format?: string } }>(
    "/api/shadow/toxic-symbol-gate-diagnostic",
    async (request, reply) => {
      const SOURCE_LANE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 500;
      const orders = getPaperExecutionRouterStore()
        .getState()
        .orders.filter((o) => o.selectedLaneId === SOURCE_LANE)
        .slice(-limit);

      const minRaw = Number(request.query?.minN);
      const toxRaw = Number(request.query?.toxic);
      const report = buildToxicSymbolGateDiagnostic(orders, {
        netNegMinSample: Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : undefined,
        netNegThreshold: Number.isFinite(toxRaw) ? toxRaw : undefined,
      });

      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return buildToxicSymbolGateDiagnosticBriefLines(report).join("\n");
      }
      return {
        sourceLane: SOURCE_LANE,
        ordersConsidered: orders.length,
        report,
        rendered: buildToxicSymbolGateDiagnosticBriefLines(report),
      };
    },
  );

  // ── SIGNAL-DECAY DIAGNOSTIC V1 (DIAGNOSTIC-ONLY) ────────────────────────────
  // Counterfactual entry-time replay over the EXISTING CG_WIDE orders: does the edge
  // survive admission delay/acceleration? Same geometry & exit, only the entry shifts.
  // Never admits, mutates the store, touches headline, or goes live.
  // ?offsets=-10,-5,-3,-1,0,1,3,5,10  ?limit=N  ?format=text
  app.get<{ Querystring: { offsets?: string; limit?: string; format?: string } }>(
    "/api/shadow/signal-decay-diagnostic",
    async (request, reply) => {
      if (!opts.binanceClient) {
        reply.code(503);
        return { error: "BINANCE_UNAVAILABLE", message: "Candle source is not configured." };
      }
      const _sdc = opts.binanceClient;
      const klineClient = {
        getKlines: async (
          symbol: string,
          interval: string,
          klineOpts: { startTime: number; endTime: number; limit: number },
        ): Promise<PaperKlineTuple[]> => {
          const candles = await _sdc.getCandles(symbol, interval, klineOpts.limit, {
            startTime: klineOpts.startTime,
            endTime: klineOpts.endTime,
          });
          return candles.map(
            (c) =>
              [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + 60_000] as PaperKlineTuple,
          );
        },
      };

      const offsets = (request.query?.offsets ?? "-10,-5,-3,-1,0,1,3,5,10")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
        .slice(0, 15);
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 200;

      const SOURCE_LANE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
      const orders = getPaperExecutionRouterStore()
        .getState()
        .orders.filter((o) => o.selectedLaneId === SOURCE_LANE)
        .slice(-limit);

      const model =
        process.env.PAPER_EXECUTION_REALISM === "0"
          ? PAPER_EXECUTION_MODEL_IDEAL
          : PAPER_EXECUTION_MODEL_REALISTIC;

      let report;
      try {
        report = await buildSignalDecayDiagnostic(orders, klineClient, {
          offsetsMinutes: offsets.length > 0 ? offsets : undefined,
          executionModel: model,
        });
      } catch (err) {
        reply.code(500);
        return { error: "DECAY_DIAGNOSTIC_FAILED", message: err instanceof Error ? err.message : "unknown" };
      }

      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return buildSignalDecayDiagnosticBriefLines(report).join("\n");
      }
      return {
        sourceLane: SOURCE_LANE,
        ordersConsidered: orders.length,
        executionRealism: model === PAPER_EXECUTION_MODEL_IDEAL ? "IDEAL" : "REALISTIC",
        report,
        rendered: buildSignalDecayDiagnosticBriefLines(report),
      };
    },
  );

  // ── REGIME × DIRECTION DIAGNOSTIC V1 (DIAGNOSTIC-ONLY) ──────────────────────
  // Pure store read: where does CG_WIDE work (regime/mode/bias/direction/capTier/
  // symbol)? Report-only — never admits, mutates the store, gates, or goes live.
  // ?limit=N  ?format=text
  app.get<{ Querystring: { limit?: string; format?: string } }>(
    "/api/shadow/regime-direction-diagnostic",
    async (request, reply) => {
      const SOURCE_LANE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 500;
      const orders = getPaperExecutionRouterStore()
        .getState()
        .orders.filter((o) => o.selectedLaneId === SOURCE_LANE)
        .slice(-limit);

      const report = buildRegimeDirectionDiagnostic(orders);

      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return buildRegimeDirectionDiagnosticBriefLines(report).join("\n");
      }
      return {
        sourceLane: SOURCE_LANE,
        ordersConsidered: orders.length,
        report,
        rendered: buildRegimeDirectionDiagnosticBriefLines(report),
      };
    },
  );

  // ── FORWARD-PAPER GATE VALIDATION HARNESS V1 (SHADOW LABEL — NOT an active gate) ─
  // Validates the proposed entry gate against the labeled book (OOS) + a read-only
  // in-sample reconstruction over legacy orders. Never blocks, mutates the store via
  // this read, changes headline, or goes live. activeGateChange is ALWAYS NO.
  // ?gate=NON_TOXIC_BEARISH_SHORT_V1  ?limit=N  ?format=text
  app.get<{ Querystring: { gate?: string; limit?: string; format?: string } }>(
    "/api/shadow/forward-gate-validation",
    async (request, reply) => {
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 1000;
      const orders = getPaperExecutionRouterStore().getState().orders.slice(-limit);
      const gateId = request.query?.gate || FORWARD_GATE_ID;
      const report = buildForwardGateValidation(orders, { gateId });

      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return buildForwardGateValidationBriefLines(report).join("\n");
      }
      return {
        ordersConsidered: orders.length,
        report,
        rendered: buildForwardGateValidationBriefLines(report),
      };
    },
  );

  // ── OPEN-ORDER STALE AUDIT (DIAGNOSTIC — report-only) ───────────────────────
  // Per-open-order hold/stale detail + backlog summary + admission recommendation.
  // Safe when fields are missing (currentR/MFE/MAE/regimeNow → UNKNOWN). No writes.
  // ?limit=N  ?format=text
  app.get<{ Querystring: { limit?: string; format?: string } }>(
    "/api/shadow/open-order-stale-audit",
    async (request, reply) => {
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 1000;
      const orders = getPaperExecutionRouterStore().getState().orders.slice(-limit);
      const audit = buildOpenOrderStaleAudit(orders, Date.now());
      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return buildOpenOrderStaleAuditBriefLines(audit).join("\n");
      }
      return { audit, rendered: buildOpenOrderStaleAuditBriefLines(audit) };
    },
  );

  // ── STALE-PASS COHORT DIAGNOSTIC (DIAGNOSTIC — closed CG_WIDE only) ──────────
  // Benign swing occupancy vs tail deterioration of STALE (>=30h) PASS-gated trades.
  // Read-only. ?limit=N  ?format=text
  app.get<{ Querystring: { limit?: string; format?: string } }>(
    "/api/shadow/stale-pass-cohort",
    async (request, reply) => {
      const limRaw = Number(request.query?.limit);
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : 1000;
      const orders = getPaperExecutionRouterStore().getState().orders.slice(-limit);
      const d = buildStalePassCohortDiagnostic(orders);
      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return renderStalePassCohortDiagnostic(d).join("\n");
      }
      return { diagnostic: d, rendered: renderStalePassCohortDiagnostic(d) };
    },
  );

  // ── MIXED LANE COMPARISON: CG_WIDE vs CG_TRAIL_AFTER_TP1 (DIAGNOSTIC) ────────
  app.get<{ Querystring: { format?: string } }>(
    "/api/shadow/mixed-admission-ledger",
    async (request, reply) => {
      type CandShape = {
        symbol?: string;
        direction?: string;
        finalDirection?: string | null;
        volatilityScore?: number | null;
        liquidityScore?: number | null;
        indicators?: { fiveMinute?: { atrPercent?: number | null } };
      };
      const cached = getLatestScanCandidates();
      const candidates = (cached?.candidates ?? []) as unknown as CandShape[];
      const orders = getPaperExecutionRouterStore().getState().orders;
      const mixed = buildMixedRegimeReport({
        regime: cached?.marketRegime ?? null,
        candidates: candidates.map((c) => ({
          symbol: c.symbol ?? null,
          direction: c.finalDirection ?? c.direction ?? null,
          regime: cached?.marketRegime ?? null,
          laneId: mixedLaneIdForDirection(c.finalDirection ?? c.direction ?? null),
          atrPercent: c.indicators?.fiveMinute?.atrPercent ?? null,
          volatilityScore: c.volatilityScore ?? null,
          liquidityScore: c.liquidityScore ?? null,
        })),
        orders,
        nowMs: Date.now(),
        trailLaneAvailable: true,
      });
      const ledger = buildMixedAdmissionDecisionLedger(mixed);
      const capacityReplay = buildMixedCapacityOpportunityReplay({ ledger, orders });
      const capacityBudgetSimulation = buildMixedCapacityBudgetSimulation({
        regime: cached?.marketRegime ?? null,
        candidates: candidates.map((c) => ({
          symbol: c.symbol ?? null,
          direction: c.finalDirection ?? c.direction ?? null,
          regime: cached?.marketRegime ?? null,
          laneId: mixedLaneIdForDirection(c.finalDirection ?? c.direction ?? null),
          atrPercent: c.indicators?.fiveMinute?.atrPercent ?? null,
          volatilityScore: c.volatilityScore ?? null,
          liquidityScore: c.liquidityScore ?? null,
        })),
        orders,
        nowMs: Date.now(),
        trailLaneAvailable: true,
      });
      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return renderMixedAdmissionDecisionLedger(ledger, capacityReplay, capacityBudgetSimulation).join("\n");
      }
      return {
        ledger,
        capacityReplay,
        capacityBudgetSimulation,
        rendered: renderMixedAdmissionDecisionLedger(ledger, capacityReplay, capacityBudgetSimulation),
      };
    },
  );

  app.get<{ Querystring: { format?: string } }>(
    "/api/shadow/mixed-capacity-opportunity-replay",
    async (request, reply) => {
      type CandShape = {
        symbol?: string;
        direction?: string;
        finalDirection?: string | null;
        volatilityScore?: number | null;
        liquidityScore?: number | null;
        indicators?: { fiveMinute?: { atrPercent?: number | null } };
      };
      const cached = getLatestScanCandidates();
      const candidates = (cached?.candidates ?? []) as unknown as CandShape[];
      const orders = getPaperExecutionRouterStore().getState().orders;
      const mixed = buildMixedRegimeReport({
        regime: cached?.marketRegime ?? null,
        candidates: candidates.map((c) => ({
          symbol: c.symbol ?? null,
          direction: c.finalDirection ?? c.direction ?? null,
          regime: cached?.marketRegime ?? null,
          laneId: mixedLaneIdForDirection(c.finalDirection ?? c.direction ?? null),
          atrPercent: c.indicators?.fiveMinute?.atrPercent ?? null,
          volatilityScore: c.volatilityScore ?? null,
          liquidityScore: c.liquidityScore ?? null,
        })),
        orders,
        nowMs: Date.now(),
        trailLaneAvailable: true,
      });
      const ledger = buildMixedAdmissionDecisionLedger(mixed);
      const replay = buildMixedCapacityOpportunityReplay({ ledger, orders });
      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return renderMixedCapacityOpportunityReplay(replay).join("\n");
      }
      return { replay, rendered: renderMixedCapacityOpportunityReplay(replay) };
    },
  );

  app.get<{ Querystring: { format?: string } }>(
    "/api/shadow/mixed-capacity-budget-simulation",
    async (request, reply) => {
      type CandShape = {
        symbol?: string;
        direction?: string;
        finalDirection?: string | null;
        volatilityScore?: number | null;
        liquidityScore?: number | null;
        indicators?: { fiveMinute?: { atrPercent?: number | null } };
      };
      const cached = getLatestScanCandidates();
      const candidates = (cached?.candidates ?? []) as unknown as CandShape[];
      const orders = getPaperExecutionRouterStore().getState().orders;
      const simulation = buildMixedCapacityBudgetSimulation({
        regime: cached?.marketRegime ?? null,
        candidates: candidates.map((c) => ({
          symbol: c.symbol ?? null,
          direction: c.finalDirection ?? c.direction ?? null,
          regime: cached?.marketRegime ?? null,
          laneId: mixedLaneIdForDirection(c.finalDirection ?? c.direction ?? null),
          atrPercent: c.indicators?.fiveMinute?.atrPercent ?? null,
          volatilityScore: c.volatilityScore ?? null,
          liquidityScore: c.liquidityScore ?? null,
        })),
        orders,
        nowMs: Date.now(),
        trailLaneAvailable: true,
      });
      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return renderMixedCapacityBudgetSimulation(simulation).join("\n");
      }
      return { simulation, rendered: renderMixedCapacityBudgetSimulation(simulation) };
    },
  );

  app.get<{ Querystring: { format?: string } }>(
    "/api/shadow/mixed-budget-forward-validation",
    async (request, reply) => {
      const orders = getPaperExecutionRouterStore().getState().orders;
      const validation = buildMixedBudgetForwardValidation(orders);
      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return renderMixedBudgetForwardValidation(validation).join("\n");
      }
      return { validation, rendered: renderMixedBudgetForwardValidation(validation) };
    },
  );

  // ?scope=MIXED_ONLY|ALL  ?format=text
  app.get<{ Querystring: { scope?: string; format?: string } }>(
    "/api/shadow/mixed-lane-comparison",
    async (request, reply) => {
      const scope = request.query?.scope === "MIXED_ONLY" ? "MIXED_ONLY" : "ALL";
      const orders = getPaperExecutionRouterStore().getState().orders;
      const cmp = buildMixedLaneComparison(orders, { scope });
      if (request.query?.format === "text") {
        reply.type("text/plain; charset=utf-8");
        return buildMixedLaneComparisonBriefLines(cmp).join("\n");
      }
      return { comparison: cmp, rendered: buildMixedLaneComparisonBriefLines(cmp) };
    },
  );

  app.get("/api/shadow/live-readiness", async (_request, reply) => {
    if (!shadowEngine) {
      reply.code(503);
      return { error: "SHADOW_DISABLED", message: "Shadow execution is not enabled in this environment." };
    }
    // Kronos health and coverage may be wired in later; default to healthy/full
    // until those signals are surfaced. Warnings are advisory only.
    return buildLiveReadinessReport({ positions: shadowEngine.getAllPositions() });
  });
}

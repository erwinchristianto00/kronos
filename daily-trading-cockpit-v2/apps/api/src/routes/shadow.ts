import type { FastifyInstance } from "fastify";
import { buildStrategyExperienceRecords, buildStrategyIntelligenceFoundationReport } from "@dtc/shared";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
import {
  buildNeuralMapTelemetry,
  buildPaperUnrealizedSnapshot,
  type NeuralMapTelemetry,
} from "../lib/neural-map-telemetry.js";
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
import { getFadeLongStore, runFadeLongCycleGuarded, buildFadeLongReport } from "../lib/fade-long-edge.js";
import { getCandidateFunnelLog } from "../lib/accelerated-evidence-candidate-funnel-log.js";
import {
  buildPortfolioTrendShadowReport,
  getPortfolioTrendShadowStore,
  resolvePortfolioTrendPositions,
  type PortfolioTrendShadowReport,
} from "../lib/portfolio-trend-shadow.js";
import {
  buildMicrostructureCollectorReport,
  getMicrostructureSnapshotStore,
  type MicrostructureCollectorReport,
} from "../lib/microstructure-feature-collector.js";

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

function withTimeoutFallback<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

let neuralMapResponseCache: NeuralMapTelemetry | null = null;
let neuralMapResponseCacheAt = 0;
let neuralMapResponseInFlight: Promise<NeuralMapTelemetry> | null = null;
const NEURAL_MAP_LAST_GOOD_FILE = "data/neural-map-last-good.json";

function readLastGoodNeuralMap(): NeuralMapTelemetry | null {
  try {
    if (!existsSync(NEURAL_MAP_LAST_GOOD_FILE)) return null;
    return JSON.parse(readFileSync(NEURAL_MAP_LAST_GOOD_FILE, "utf-8")) as NeuralMapTelemetry;
  } catch {
    return null;
  }
}

function writeLastGoodNeuralMap(snapshot: NeuralMapTelemetry): void {
  try {
    mkdirSync(dirname(NEURAL_MAP_LAST_GOOD_FILE), { recursive: true });
    writeFileSync(NEURAL_MAP_LAST_GOOD_FILE, JSON.stringify(snapshot), "utf-8");
  } catch {
    // Dashboard fallback persistence must never affect API responses.
  }
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

    // Data collector: Microstructure feature snapshots — report only.
    let microstructureReport: MicrostructureCollectorReport | undefined;
    try {
      const msStore = getMicrostructureSnapshotStore();
      microstructureReport = await buildMicrostructureCollectorReport(msStore);
    } catch {
      // microstructure report must never break the dashboard
    }

    // Report-only: realistic cost model for the frozen tape (F***), derived from
    // the AC microstructure spread distribution + funding availability. Pure
    // analytics; never throws. When populated, flips FUNDING_SLIPPAGE_MODELED
    // gate to PASS (liveBlocked still true; infra gates still FAIL).
    let frozenCostModelReport: FrozenCurrentGuardCostModelReport | undefined;
    try {
      if (microstructureReport) {
        const spread = microstructureReport.latestSpreadDistribution;
        frozenCostModelReport = buildFrozenCurrentGuardCostModelReport(
          frozenObservationsForCostModel,
          {
            spreadP50Bps: spread.p50,
            spreadP90Bps: spread.p90,
            spreadP99Bps: spread.p99,
            // No avg funding rate value is exposed by the collector report; the
            // model falls back to a placeholder penalty when null.
            avgFundingRate: null,
            depthAvailable: (microstructureReport.depthAvailability ?? 0) > 0,
            fundingAvailable: (microstructureReport.fundingRateAvailability ?? 0) > 0,
            spreadAvailable: spread.p90 !== null,
          },
        );
      }
    } catch {
      // cost model must never break the dashboard
    }

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
        const spread = microstructureReport?.latestSpreadDistribution;
        const spreadFunding = spread
          ? {
              spreadP50Bps: spread.p50,
              spreadP90Bps: spread.p90,
              spreadP99Bps: spread.p99,
              avgFundingRate: null,
              depthAvailable: (microstructureReport!.depthAvailability ?? 0) > 0,
              fundingAvailable: (microstructureReport!.fundingRateAvailability ?? 0) > 0,
              spreadAvailable: spread.p90 !== null,
            }
          : null;
        // Infra-readiness gates default to false (not implemented), so the
        // post-cutover tape can never reach PROMOTION_CANDIDATE here.
        postCutoverReport = buildPostCutoverReport(
          frozenCurrentGuardReport,
          boundary,
          spreadFunding,
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
        mirrorVariantMatrixSignals(cgvmSignals, cgvmStore, cgvmNowIso);
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
      microstructureReport,
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

  app.get("/api/shadow/neural-map", async () => {
    const now = Date.now();
    if (neuralMapResponseCache && now - neuralMapResponseCacheAt < Number(process.env.NEURAL_MAP_CACHE_MS || 60_000)) {
      return neuralMapResponseCache;
    }
    const lastGood = readLastGoodNeuralMap();
    if (lastGood) {
      neuralMapResponseCache = lastGood;
      neuralMapResponseCacheAt = now;
      return lastGood;
    }
    if (neuralMapResponseInFlight) {
      if (neuralMapResponseCache) return neuralMapResponseCache;
      return neuralMapResponseInFlight;
    }

    neuralMapResponseInFlight = (async () => {
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
    const paperUnrealized = await withTimeoutFallback(
      buildPaperUnrealizedSnapshot(orders, opts.binanceClient, generatedAt),
      Number(process.env.NEURAL_MAP_UNREALIZED_TIMEOUT_MS || 4_000),
      null,
    );
    const variantMatrix = buildCurrentGuardVariantMatrixReport(
      getCurrentGuardVariantMatrixStore(),
      { capturedAt: generatedAt },
    );
    const fadeLong =
      process.env.FADE_LONG_EDGE_DISABLED === "1"
        ? null
        : buildFadeLongReport(getFadeLongStore().all);
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
    const response = buildNeuralMapTelemetry({
      generatedAt,
      controller,
      scanStatus,
      scanTiming: getLatestScanTimingDiagnostics(),
      paper,
      paperUnrealized,
      orders,
      variantMatrix,
      fadeLong,
      mixed,
      mixedValidation,
      staleAudit,
      quarantinedLaneIds: [
        ...(process.env.PAPER_CHALLENGER_QUARANTINED !== "0"
          ? ["CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1"]
          : []),
        // Variant lanes auto-quarantined for confirmed net-negative paper economics render violet too.
        ...(process.env.PAPER_VARIANT_AUTO_QUARANTINE !== "0"
          ? computeAutoQuarantinedVariantLanes(orders)
          : []),
      ],
    });
    neuralMapResponseCache = response;
    neuralMapResponseCacheAt = Date.now();
    writeLastGoodNeuralMap(response);
    return response;
    })();
    try {
      return await neuralMapResponseInFlight;
    } finally {
      neuralMapResponseInFlight = null;
    }
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
  app.get<{ Querystring: { era?: string; resolve?: string; paper?: string } }>("/api/shadow/operator-brief", async (request, reply) => {
    if (!shadowEngine) {
      void reply.code(503).type("text/plain");
      return "OPERATOR BRIEF UNAVAILABLE — shadow engine not enabled\n";
    }
    try {
      const rawEra = request.query?.era;
      const era: DashboardAuditSummaryEra = rawEra === "ALL_TIME" ? "ALL_TIME" : "POST_CALIBRATION";
      const generatedAt = new Date().toISOString();
      const scanStatus = opts.coreScanAutoRefreshController?.getStatus() ?? null;
      const currentRegime = scanStatus?.lastAutoRefreshResultSummary?.marketRegime ?? null;
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
          if (process.env.CURRENT_GUARD_VARIANT_MATRIX_DISABLED !== "1" && shadowEngine) {
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
          });
          await Promise.race([resolverPromise, new Promise<void>((res) => { setTimeout(res, 8_000); })]);
        } catch { /* resolve=1 failure must never break the brief */ }

        // ── Fade-long edge: independent oversold (RSI<30) dip-buy measurement lane ──
        // The bot's scanner only produces CHASE longs (no dips), which have no edge on alts.
        // This lane records the symmetric long-fade (BUY oversold) on the universe and resolves
        // it by candle-walk, accruing OOS like the variant-matrix lanes. Report-only; does NOT
        // pass through the allocator, paper book, live engine, or any strategy gate.
        // FIRE-AND-FORGET: the lane is surfaced by the SEPARATE neural-map endpoint, not this
        // brief, so we must NOT block the (already heavy) brief on ~20 sequential candle fetches.
        // Overlap-guarded so the 7-min ticker can't stack two cycles on the singleton store.
        if (process.env.FADE_LONG_EDGE_DISABLED !== "1") {
          const _flc = opts.binanceClient;
          const fadeInterval = process.env.FADE_LONG_INTERVAL || "15m";
          void runFadeLongCycleGuarded({
            store: getFadeLongStore(),
            universe: [...CURRENT_SCANNER_UNIVERSE],
            now: Date.now(),
            regimeAtEntry: currentRegime,
            fetchCandles: async (symbol: string) => _flc.getCandles(symbol, fadeInterval, 120),
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
      const gateReport = buildLiveTradingGateReport({
        postCutoverReport,
        currentGuardVariantMatrixReport: variantMatrixReport,
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
              symbolsWithPositiveCohort: _symbolsWithPositiveCohort,
              symbolHistoricalNetMap: _symbolHistoricalNetMap,
              currentPaperOrders: paperStore.getState().orders,
              mixedRegimeReport,
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
          } catch { /* allocator failure must never break the brief */ }
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
              _paperRouter.regimeFamily === "MIXED"
                ? allocatorReport?.selectedOpportunities[0]?.laneId ?? null
                : null,
            executionModel: _paperExecModel,
          });
          const result = await Promise.race([
            paperRunPromise,
            new Promise<null>((res) => { setTimeout(() => res(null), 8_000); }),
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

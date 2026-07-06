import {
  buildStrategyExperienceRecords,
  buildStrategyIntelligenceFoundationReport,
  classifyEvidenceEra,
  type ShadowPosition,
} from "@dtc/shared";

import { buildAdaptiveGateIntelligenceReport } from "./adaptive-gate-intelligence.js";
import { buildAdaptiveRegimeGateOverlayPerformanceReport } from "./adaptive-gate-overlay-performance.js";
import type { BaseRouteRiskHygieneMonitor } from "./base-route-risk-hygiene-monitor.js";
import type { ForensicsRow, FrozenCurrentGuardReport } from "./base-route-current-guard-frozen.js";
import type { FrozenCurrentGuardCostModelReport } from "./frozen-current-guard-cost-model.js";
import { buildTechnicalStopTpCredibilityReport } from "./technical-stop-tp-credibility.js";
import { buildUniverseRotationIntelligenceReport } from "./universe-rotation-intelligence.js";
import {
  buildExternalCandidateDiscoveryIntelligenceReport,
  type ExternalDiscoveryCandidateMetadata,
} from "./external-candidate-discovery-intelligence.js";
import type { ExternalCandidateMetadataFetchDiagnostics } from "./external-candidate-metadata-fetcher.js";
import type { ExternalStrategyFitEnrichmentReport } from "./external-strategy-fit-enrichment.js";
import type { ExternalRotationOverlayPerformanceReport } from "./external-rotation-overlay-performance.js";
import type { ExternalRotationOverlayEconomicsReport } from "./external-rotation-overlay-economics.js";
import type { TpSlGeometryRootCauseAuditReport } from "./tp-sl-geometry-root-cause-audit.js";
import type { AdaptiveProfitPolicySynthesisReport } from "./adaptive-profit-policy.js";
import type { CoreScanAutoRefreshStatus } from "./core-scan-auto-refresh.js";
import {
  MILESTONE_CALENDAR_DAYS_TARGET,
  MILESTONE_RESOLVED_N_TARGET,
  type KronosCounterfactualReport,
} from "./kronos-counterfactual-lane.js";
import { buildLiveReadinessReport } from "./live-readiness.js";
import { buildProfitAnatomyReport } from "./profit-anatomy.js";
import { buildRegimeDriftReport } from "./regime-drift.js";
import { buildRegimeDirectionControllerReport, type RegimeDirectionControllerReport } from "./regime-direction-controller.js";
import { buildRegimeDirectionControllerRetroAudit, type RetroAuditReport } from "./regime-direction-controller-retrospective-audit.js";
import { buildAdaptiveLaneRouterReport, type AdaptiveLaneRouterReport } from "./adaptive-lane-router.js";
import {
  buildAcceleratedEvidenceFunnelReport,
  buildAcceleratedEvidenceFunnelReportFromLog,
  type AcceleratedEvidenceFunnelReport,
} from "./accelerated-evidence-funnel.js";
import type { CandidateFunnelEntry } from "./accelerated-evidence-candidate-funnel-log.js";
import {
  buildRegimeControllerAlignedShadowReport,
  evaluateBestExitLanePromotion,
  type ControllerAlignedShadowPosition,
  type RegimeControllerAlignedShadowReport,
} from "./regime-controller-aligned-shadow.js";
import type { FilteredEdgeShadowReport } from "./regime-controller-filtered-edge-shadow.js";
import type { ParallelShadowExperimentReport } from "./parallel-shadow-experiments.js";
import type {
  CurrentGuardVariantMatrixReport,
  CurrentGuardVariantMatrixRow,
} from "./current-guard-variant-matrix.js";
import type { PortfolioTrendShadowReport } from "./portfolio-trend-shadow.js";
import {
  buildLiveTradingGateReport,
  type LiveTradingGateReport,
} from "./live-trading-gate.js";
import {
  buildFrozenPromotionTrackerReport,
  type FrozenPromotionTrackerReport,
} from "./frozen-current-guard-promotion-tracker.js";
import {
  buildKillSwitchReadinessReport,
  type KillSwitchReadinessReport,
} from "./micro-pilot-kill-switch-readiness.js";
import {
  buildOrderReconciliationReadinessReport,
  type OrderReconciliationReadinessReport,
} from "./order-reconciliation-readiness.js";
import {
  buildExchangeHealthReadinessReport,
  type ExchangeHealthReadinessReport,
} from "./exchange-health-readiness.js";
import {
  buildShadowLaneScoreboard,
  type ShadowLaneScoreboard,
  type ShadowLaneScoreboardEntry,
} from "./shadow-lane-scoreboard.js";
import {
  buildStrategyResearchRoadmapReport,
  type StrategyResearchRoadmapReport,
} from "./strategy-research-roadmap.js";
import {
  buildFrozenSegmentPathologyAudit,
  type FrozenSegmentPathologyAudit,
} from "./frozen-segment-pathology-audit.js";
import type { PostCutoverReport } from "./frozen-current-guard-post-cutover.js";
import { buildRegimePolicyCounterfactualReport } from "./regime-policy-counterfactual.js";
import { buildRouteMaturityReport } from "./route-maturity.js";
import { buildStopGeometryAuditReport } from "./stop-geometry-audit.js";
import { buildSymbolRouteSuitabilityReport } from "./symbol-route-suitability.js";
import { formatMultiplicitySummary } from "./signal-multiplicity-guardrail.js";
import { buildWinnerLoserAuditReport } from "./winner-loser-audit.js";

export type DashboardAuditSummaryEra = "POST_CALIBRATION" | "ALL_TIME";

export interface DashboardAuditSummaryReport {
  generatedAt: string;
  era: DashboardAuditSummaryEra;
  summaryText: string;
  highlights: {
    botState: Record<string, unknown>;
    liveReadiness: Record<string, unknown>;
    routeMaturity: Record<string, unknown>;
    currentPerformance: Record<string, unknown>;
    profitAnatomy: Record<string, unknown>;
    stopGeometry: Record<string, unknown>;
    baseRouteRiskHygieneMonitor: Record<string, unknown>;
    winnerLoser: Record<string, unknown>;
    intelligenceFoundation: Record<string, unknown>;
    symbolRouteSuitability: Record<string, unknown>;
    adaptiveGateIntelligence: Record<string, unknown>;
    regimePolicyCounterfactual: Record<string, unknown>;
    forwardOverlay: Record<string, unknown>;
    technicalStopTpCredibility: Record<string, unknown>;
    universeRotationIntelligence: Record<string, unknown>;
    externalCandidateDiscoveryIntelligence: Record<string, unknown>;
    externalStrategyFitEnrichment: Record<string, unknown>;
    externalRotationShadowOverlay: Record<string, unknown>;
    externalRotationOverlayEconomics: Record<string, unknown>;
    externalRotationOverlayEconomicsCredibility: Record<string, unknown>;
    tpSlGeometryRootCauseAudit: Record<string, unknown>;
    adaptiveProfitPolicySynthesis: Record<string, unknown>;
    adaptiveDirectionPosture: Record<string, unknown>;
    microPilotReadinessByPolicyLane: Record<string, unknown>;
    exploitShadowCollectionPriorities: Record<string, unknown>;
    regimeDirectionController: RegimeDirectionControllerReport;
    regimeControllerRetroAudit: RetroAuditReport;
    acceleratedEvidenceFunnel: AcceleratedEvidenceFunnelReport;
    regimeControllerAlignedShadow?: RegimeControllerAlignedShadowReport;
    parallelShadowExperimentMatrix: Record<string, unknown>;
    executiveTakeaway: string;
  };
}

interface SummarySignalLine {
  label: string;
  pattern: string;
}

function fmtNum(value: number | null | undefined, digits = 4): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function fmtPct(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "n/a";
}

function fmtCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function routeLabel(entry: string | null | undefined, exit: string | null | undefined): string {
  return `${entry ?? "UNKNOWN_ENTRY"} + ${exit ?? "UNKNOWN_EXIT"}`;
}

/**
 * Phase 3.1 toxicity-evidence instrumentation: compute per-variant coverage of
 * MFE/MAE excursion, R-geometry snapshot, and forward-path summary across
 * resolved variants. Data-only — does not influence scoring or routing.
 */
function summarizeVariantInstrumentationCoverage(positions: ShadowPosition[]): {
  excursion: { populated: number; total: number; pct: number };
  rGeometry: { populated: number; total: number; pct: number };
  forwardPath: { populated: number; total: number; pct: number };
} {
  let excursionPop = 0;
  let rGeoPop = 0;
  let pathPop = 0;
  let total = 0;
  for (const position of positions) {
    for (const variant of position.variants) {
      if (variant.state !== "CLOSED") continue;
      // NO_FILL variants are intentionally excluded — no entry, no excursion to record.
      if (variant.closeReason === "NO_FILL") continue;
      total += 1;
      if (
        typeof variant.mfeR === "number" && Number.isFinite(variant.mfeR) &&
        typeof variant.maeR === "number" && Number.isFinite(variant.maeR)
      ) {
        excursionPop += 1;
      }
      if (
        typeof variant.entryPriceUsed === "number" && Number.isFinite(variant.entryPriceUsed) &&
        typeof variant.initialRiskAbs === "number" && Number.isFinite(variant.initialRiskAbs)
      ) {
        rGeoPop += 1;
      }
      if (
        typeof variant.pathCandleCount === "number" && variant.pathCandleCount > 0 &&
        typeof variant.resolutionPrice === "number" && Number.isFinite(variant.resolutionPrice)
      ) {
        pathPop += 1;
      }
    }
  }
  const safePct = (n: number, d: number) => (d > 0 ? n / d : 0);
  return {
    excursion: { populated: excursionPop, total, pct: safePct(excursionPop, total) },
    rGeometry: { populated: rGeoPop, total, pct: safePct(rGeoPop, total) },
    forwardPath: { populated: pathPop, total, pct: safePct(pathPop, total) },
  };
}

function averageCoverage(...values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function fallbackString(value: string | null | undefined, fallback = "unlabeled feature - inspect source audit"): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function summarizeSignal(signal: { feature?: string | null; observedPattern?: string | null } | null | undefined): SummarySignalLine {
  return {
    label: fallbackString(signal?.feature),
    pattern: fallbackString(signal?.observedPattern, "inspect source audit"),
  };
}

function summarizeSignals(signals: Array<{ feature?: string | null; observedPattern?: string | null } | null | undefined>, limit = 2): SummarySignalLine[] {
  return signals.slice(0, limit).map((signal) => summarizeSignal(signal));
}

function summarizeMetadataDiagnosticsLine(diag: ExternalCandidateMetadataFetchDiagnostics): string[] {
  const { sourceStatus } = diag;
  const describeStage = (stage: ExternalCandidateMetadataFetchDiagnostics["exchangeInfo"]) =>
    stage.ok ? `ok(${stage.rawCount})` : `failed${stage.errorMessage ? `(${stage.errorMessage})` : ""}`;
  if (sourceStatus === "HEALTHY") {
    const healthyHost = diag.exchangeInfo.baseUrl
      ? new URL(diag.exchangeInfo.baseUrl).host
      : null;
    return [
      `- Metadata source=HEALTHY | cache=${diag.cacheStatus}${healthyHost ? ` | host=${healthyHost}` : ""} | exchangeInfo=${diag.exchangeInfo.rawCount} | ticker24h=${diag.ticker24h.rawCount} | bookTicker=${diag.bookTicker.rawCount} | joined=${diag.join.joinedMetadataCount}`,
    ];
  }
  if (sourceStatus === "DEGRADED_USING_CACHE") {
    return [
      `- Metadata source=DEGRADED_USING_CACHE | cache=STALE_FALLBACK | latest fetch: exchangeInfo=${describeStage(diag.exchangeInfo)} | ticker24h=${describeStage(diag.ticker24h)} | bookTicker=${describeStage(diag.bookTicker)} | cached joined=${diag.join.joinedMetadataCount}`,
      `- Discovery is operating from cached metadata; fresh Binance fetch is currently degraded.`,
    ];
  }
  if (sourceStatus === "FAILED") {
    return [
      `- Metadata source=FAILED | cache=MISS | exchangeInfo=${describeStage(diag.exchangeInfo)} | ticker24h=${describeStage(diag.ticker24h)} | bookTicker=${describeStage(diag.bookTicker)} | joined=0`,
      `- External discovery cannot operate: no usable metadata snapshot available.`,
    ];
  }
  return [
    `- Metadata source=${sourceStatus} | cache=${diag.cacheStatus} | joined=${diag.join.joinedMetadataCount}`,
  ];
}

function summarizeOverlayRefreshDiagnostics(stats: ExternalRotationOverlayPerformanceReport["duplicateSuppressionStats"]): string {
  if (!stats.diagnosticsAvailable) {
    return "- Collection diagnostics: unavailable";
  }
  const rejectedDistortionSuffix =
    stats.rejectedForEconomicDistortionCount !== null
      ? ` | rejected-distortion=${fmtCount(stats.rejectedForEconomicDistortionCount)}`
      : "";
  return `- Last collection refresh=${stats.triggerSource ?? "UNKNOWN"} at ${stats.lastRefreshAt ?? "none"} | considered=${fmtCount(stats.observationsConsidered)} | created=${fmtCount(stats.observationsCreated)} | duplicate-suppressed=${fmtCount(stats.observationsSuppressedAsDuplicate)} | skipped-insufficient=${fmtCount(stats.observationsSkippedForInsufficientState)}${rejectedDistortionSuffix}`;
}

function summarizeCoreScanAutoRefresh(status: CoreScanAutoRefreshStatus | undefined): string {
  if (!status) return "- Core scan auto-refresh: unavailable";
  if (!status.enabled) return "- Core scan auto-refresh: DISABLED";
  const result = status.lastAutoRefreshResultSummary;
  return `- Core scan auto-refresh: ENABLED every ${status.intervalMinutes} min | last=${status.lastAutoRefreshStatus}${status.lastAutoRefreshFinishedAt ? ` at ${status.lastAutoRefreshFinishedAt}` : ""}${result ? ` | scanned=${result.scannedSymbols} returned=${result.returnedSymbols} | regime=${result.marketRegime}` : ""}${status.lastAutoRefreshError ? ` | error=${status.lastAutoRefreshError}` : ""}`;
}

function summarizeOverlayAutoRefresh(autoRefresh: ExternalRotationOverlayPerformanceReport["autoRefresh"]): string {
  if (!autoRefresh.enabled) {
    return "- Auto-refresh: DISABLED";
  }
  const result = autoRefresh.lastAutoRefreshResultSummary;
  return `- Auto-refresh: ENABLED every ${autoRefresh.intervalMinutes} min | first run=${autoRefresh.firstRunPolicy} | last=${autoRefresh.lastAutoRefreshStatus}${autoRefresh.lastAutoRefreshFinishedAt ? ` at ${autoRefresh.lastAutoRefreshFinishedAt}` : ""}${result ? ` | created=${result.created} | resolved=${result.resolvedThisRefresh}` : ""}${autoRefresh.lastAutoRefreshError ? ` | error=${autoRefresh.lastAutoRefreshError}` : ""}`;
}

function summarizeOverlayStatusAccounting(report: ExternalRotationOverlayPerformanceReport): string {
  const represented =
    report.openObservations +
    report.resolvedObservations +
    report.noFillObservations +
    report.expiredObservations +
    report.failedObservations;
  const valid = report.validityCounts.validObservationCount;
  return represented === valid
    ? `- Status accounting check: ${represented} / ${valid} valid observations represented`
    : `- Status accounting mismatch detected: represented=${represented} vs valid=${valid}`;
}

function firstBlockingReason(reasons: string[] | undefined): string | null {
  const found = reasons?.find((reason) => typeof reason === "string" && reason.trim().length > 0);
  return found ?? null;
}

function summarizeTakeaway(input: {
  liveReady: boolean;
  liveLeader: string | null;
  bestScenario: string | null;
  bestScenarioDelta: number | null;
  topGateInteraction: string | null;
  overlayCoverage: number;
  gateStabilityQualifier?: string | null;
}): string {
  const liveClause = input.liveReady
    ? "a route is currently live-ready"
    : "no route is currently live-ready";
  const scenarioClause = input.bestScenario
    ? `${input.bestScenario}${input.bestScenarioDelta !== null ? ` (${input.bestScenarioDelta >= 0 ? "+" : ""}${input.bestScenarioDelta.toFixed(4)}R vs baseline)` : ""}`
    : "no regime counterfactual has a clear improving lead";
  const gateClause = input.topGateInteraction
    ? `the strongest adaptive-gate interaction remains ${input.topGateInteraction}${input.gateStabilityQualifier ? ` ${input.gateStabilityQualifier}` : ""}`
    : "adaptive-gate interaction evidence is still thin";
  const overlayClause = input.overlayCoverage > 0
    ? `forward overlay coverage is ${fmtPct(input.overlayCoverage)}`
    : "forward overlay validation has not accumulated resolved evidence yet";
  const leaderClause = input.liveLeader ? `Current maturity leader: ${input.liveLeader}. ` : "";
  return `Current bot status: ${liveClause}; ${leaderClause}The most actionable regime signal remains ${scenarioClause}, ${gateClause}, and ${overlayClause}.`;
}

function safe<T>(builder: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: builder() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export function buildDashboardAuditSummaryReport(
  positions: ShadowPosition[],
  opts: {
    era?: DashboardAuditSummaryEra;
    externalCandidateMetadata?: ExternalDiscoveryCandidateMetadata[];
    externalCandidateMetadataDiagnostics?: ExternalCandidateMetadataFetchDiagnostics;
    externalStrategyFitEnrichment?: ExternalStrategyFitEnrichmentReport;
    externalRotationOverlay?: ExternalRotationOverlayPerformanceReport;
    externalRotationOverlayEconomics?: ExternalRotationOverlayEconomicsReport;
    tpSlGeometryRootCauseAudit?: TpSlGeometryRootCauseAuditReport;
    adaptiveProfitPolicySynthesis?: AdaptiveProfitPolicySynthesisReport;
    baseRouteRiskHygieneMonitor?: BaseRouteRiskHygieneMonitor;
    currentUniverseSymbols?: string[];
    coreScanAutoRefresh?: CoreScanAutoRefreshStatus;
    /**
     * Report-only Kronos counterfactual evidence. Has no effect on scoring,
     * ranking, readiness, or any other behavior — surfaced under section J*
     * solely for audit visibility.
     */
    kronosCounterfactual?: KronosCounterfactualReport;
    /**
     * Report-only controller-aligned shadow lane state. Optional; if not
     * supplied, the aligned shadow report section will show "unavailable".
     */
    controllerAlignedShadowStore?: { observations: ControllerAlignedShadowPosition[] } | null;
    /**
     * Report-only candidate-level funnel log entries for the last 24h.
     * When populated, Z* uses exact log-based counts instead of position-tape
     * estimates. Falls back to position-tape when this is empty or not supplied.
     */
    candidateFunnelEntries?: CandidateFunnelEntry[] | null;
    /**
     * Report-only filtered edge shadow report. Optional; if not supplied, the
     * W*** section will show "[unavailable]".
     */
    filteredEdgeReport?: FilteredEdgeShadowReport;
    /**
     * Report-only 20-lane parallel shadow experiment matrix. Optional; if not
     * supplied, W**** shows "[unavailable]".
     */
    parallelShadowExperimentReport?: ParallelShadowExperimentReport;
    /**
     * Report-only current-guard variant matrix (forward A/B geometry harness).
     * Optional; if not supplied, the variant-matrix section shows "[unavailable]".
     * Feeds the W***** scoreboard and the AD live gate as advisory lanes only;
     * liveBlocked stays true and microPilotAllowed stays false regardless.
     */
    currentGuardVariantMatrixReport?: CurrentGuardVariantMatrixReport;
    /**
     * Report-only Portfolio Trend Shadow V1 report. Optional. Renders section AB.
     */
    portfolioTrendReport?: PortfolioTrendShadowReport;
    /**
     * Report-only frozen prospective tape report (F***). Optional. Renders
     * section F*** and feeds the scoreboard + live gate prospective lane.
     */
    frozenCurrentGuardReport?: FrozenCurrentGuardReport;
    /**
     * Report-only realistic cost model for the frozen tape (F***). Optional.
     * Renders the realistic cost table in F*** and, when populated, flips the
     * FUNDING_SLIPPAGE_MODELED gate to PASS (liveBlocked still true).
     */
    frozenCostModelReport?: FrozenCurrentGuardCostModelReport;
    /**
     * Report-only F****** post-cutover clean forward-validation tape. Optional.
     * Renders section F****** and feeds the live gate's nearest-candidate
     * selection (preferred over the full frozen tape once n≥50). Advisory only;
     * liveBlocked stays true regardless.
     */
    postCutoverReport?: PostCutoverReport;
  } = {},
  now: Date = new Date(),
): DashboardAuditSummaryReport {
  const era = opts.era ?? "POST_CALIBRATION";
  const generatedAt = now.toISOString();
  const records = buildStrategyExperienceRecords(positions);
  const eraPositions = era === "ALL_TIME"
    ? positions
    : positions.filter((position) => classifyEvidenceEra(position) === "POST_CALIBRATION");
  const eraRecords = era === "ALL_TIME"
    ? records
    : records.filter((record) => (record.context.evidenceEra ?? record.outcome.evidenceEra) === "POST_CALIBRATION");

  // Phase 3.1: per-variant instrumentation coverage (computed on era-scoped positions).
  const variantInstrumentationCoverage = summarizeVariantInstrumentationCoverage(eraPositions);

  const routeModeCounts = {
    PROFIT_CANDIDATE: eraPositions.filter((p) => p.variantSelection?.routeMode === "PROFIT_CANDIDATE").length,
    DATA_COLLECTION: eraPositions.filter((p) => p.variantSelection?.routeMode === "DATA_COLLECTION").length,
    RESEARCH_ONLY: eraPositions.filter((p) => p.variantSelection?.routeMode === "RESEARCH_ONLY").length,
  };

  const liveReadiness = safe(() => buildLiveReadinessReport({ positions }, now));
  const routeMaturity = safe(() => buildRouteMaturityReport({
    positions,
    eraFilter: era === "ALL_TIME" ? "ALL_TIME" : "POST_CALIBRATION",
  }, now));
  const regimeDrift = safe(() => buildRegimeDriftReport({ positions }, now));
  const profitAnatomy = safe(() => buildProfitAnatomyReport({
    positions,
    eraFilter: era === "ALL_TIME" ? "ALL" : "POST_CALIBRATION",
  }, now));
  const stopGeometry = safe(() => buildStopGeometryAuditReport({
    positions,
    eraFilter: era === "ALL_TIME" ? "ALL" : "POST_CALIBRATION",
  }, now));
  const winnerLoser = safe(() => buildWinnerLoserAuditReport({
    positions,
    eraFilter: era === "ALL_TIME" ? "ALL" : "POST_CALIBRATION",
  }, now));
  const foundation = safe(() => buildStrategyIntelligenceFoundationReport(positions, generatedAt));
  const symbolRoute = safe(() => buildSymbolRouteSuitabilityReport(records, { evidenceEra: era }, now));
  const adaptiveGate = safe(() => buildAdaptiveGateIntelligenceReport(records, { evidenceEra: era, positions }, now));
  const counterfactual = safe(() => buildRegimePolicyCounterfactualReport(records, { evidenceEra: era }, now));
  const forwardOverlay = safe(() => buildAdaptiveRegimeGateOverlayPerformanceReport(records, { evidenceEra: era }, now));
  const stopTpCredibility = safe(() => buildTechnicalStopTpCredibilityReport(records, { evidenceEra: era }, now));
  const universeRotation = safe(() => buildUniverseRotationIntelligenceReport(records, { evidenceEra: era }, now));
  const externalCandidateDiscovery = safe(() => buildExternalCandidateDiscoveryIntelligenceReport({
    records,
    currentUniverseSymbols: opts.currentUniverseSymbols ?? [],
    externalCandidateMetadata: opts.externalCandidateMetadata ?? [],
    metadataDiagnostics: opts.externalCandidateMetadataDiagnostics,
    promisingFingerprints: universeRotation.ok ? universeRotation.value.promisingFingerprints : [],
    toxicFingerprints: universeRotation.ok ? universeRotation.value.toxicFingerprints : [],
    evidenceEra: era,
  }, now));
  const externalStrategyFitEnrichment = opts.externalStrategyFitEnrichment
    ? { ok: true as const, value: opts.externalStrategyFitEnrichment }
    : { ok: false as const, error: "External strategy-fit enrichment was not supplied to the summary builder." };
  const externalRotationOverlay = opts.externalRotationOverlay
    ? { ok: true as const, value: opts.externalRotationOverlay }
    : { ok: false as const, error: "External rotation shadow overlay report was not supplied to the summary builder." };
  const externalRotationOverlayEconomics = opts.externalRotationOverlayEconomics
    ? { ok: true as const, value: opts.externalRotationOverlayEconomics }
    : { ok: false as const, error: "External rotation overlay economics report was not supplied to the summary builder." };
  const tpSlGeometryRootCauseAudit = opts.tpSlGeometryRootCauseAudit
    ? { ok: true as const, value: opts.tpSlGeometryRootCauseAudit }
    : { ok: false as const, error: "TP/SL geometry root-cause audit report was not supplied to the summary builder." };
  const adaptiveProfitPolicySynthesis = opts.adaptiveProfitPolicySynthesis
    ? { ok: true as const, value: opts.adaptiveProfitPolicySynthesis }
    : { ok: false as const, error: "Adaptive profit policy synthesis report was not supplied to the summary builder." };

  const leader = routeMaturity.ok && routeMaturity.value.leadingCohort
    ? routeMaturity.value.cohorts.find((cohort) =>
      cohort.entryVariant === routeMaturity.value.leadingCohort?.entryVariant &&
      cohort.exitVariant === routeMaturity.value.leadingCohort?.exitVariant)
    : null;
  const topLeakFlag = profitAnatomy.ok ? profitAnatomy.value.anatomyFlags[0]?.message ?? null : null;
  const toxicStopBucket = stopGeometry.ok
    ? [...stopGeometry.value.stopBuckets]
      .filter((row) => row.closedCount > 0)
      .sort((a, b) => (a.netAvgR ?? Infinity) - (b.netAvgR ?? Infinity))[0] ?? null
    : null;
  const bestStopCounterfactual = stopGeometry.ok
    ? [...stopGeometry.value.counterfactuals]
      .filter((scenario) => scenario.interpretation === "STRONGLY_IMPROVES" || scenario.interpretation === "MODESTLY_IMPROVES")
      .sort((a, b) => (b.deltaNetAvgRVsBaseline ?? -Infinity) - (a.deltaNetAvgRVsBaseline ?? -Infinity))[0] ?? null
    : null;
  // topPromisingCohorts is already filtered to exclude credibility-blocked cohorts
  // (signalMultiplicityWarning=true OR all RAW_EDGE_NOT_VALIDATED) by the suitability engine.
  const topPromisingSuitability = symbolRoute.ok ? symbolRoute.value.topPromisingCohorts[0] ?? null : null;
  const topToxicSuitability = symbolRoute.ok ? symbolRoute.value.topToxicCohorts[0] ?? null : null;
  const highestRawReturnFlaggedCohort = symbolRoute.ok
    ? symbolRoute.value.highestRawReturnMultiplicityFlaggedCohort ?? null
    : null;
  const symbolSensitive = symbolRoute.ok
    ? symbolRoute.value.routeHeterogeneity.some((item) => item.verdict === "SYMBOL_SENSITIVE")
    : false;
  const topSupportiveGate = adaptiveGate.ok ? adaptiveGate.value.topSupportiveConditions[0] ?? null : null;
  const topHarmfulGate = adaptiveGate.ok ? adaptiveGate.value.topHarmfulConditions[0] ?? null : null;
  const strongestInteraction = adaptiveGate.ok
    ? [...adaptiveGate.value.interactionAssessments]
      .sort((a, b) => (b.deltaVsBaseline.netAvgR ?? -Infinity) - (a.deltaVsBaseline.netAvgR ?? -Infinity))[0] ?? null
    : null;
  // Stability qualifier for Section M: append if strongest interaction's stability is not PROMISING_STABILIZING
  const gateStabilityQualifier = (() => {
    if (!strongestInteraction || !adaptiveGate.ok) return null;
    const stability = adaptiveGate.value.conditionalAlphaStability;
    if (!stability) return null;
    const matchingEntry = stability.entries.find(
      (e) => strongestInteraction.interactionLabel.includes("WHALE_AGREES"),
    );
    if (!matchingEntry) return null;
    if (matchingEntry.status !== "PROMISING_STABILIZING") {
      return "(evidence still recency/symbol concentrated)";
    }
    return null;
  })();
  const topWinnerSignals = winnerLoser.ok ? summarizeSignals(winnerLoser.value.topWinnerSignals) : [];
  const topLoserSignals = winnerLoser.ok ? summarizeSignals(winnerLoser.value.topLoserSignals) : [];
  const contextCompleteness = foundation.ok ? {
    trendContextCoverage: averageCoverage(
      foundation.value.missingFieldAudit.completeness.trend5m,
      foundation.value.missingFieldAudit.completeness.trend15m,
      foundation.value.missingFieldAudit.completeness.trend1h,
    ),
    marketRegimeCoverage: foundation.value.missingFieldAudit.completeness.marketRegime ?? null,
    maeMfeCoverage: averageCoverage(
      foundation.value.missingFieldAudit.completeness.maxFavorableExcursionR,
      foundation.value.missingFieldAudit.completeness.maxAdverseExcursionR,
    ),
    selectedKronosBiasCoverage: foundation.value.missingFieldAudit.completeness.selectedKronosBias ?? null,
    whaleAgreementCoverage: foundation.value.missingFieldAudit.completeness.whaleAgreement ?? null,
    sentimentFearGreedCoverage: averageCoverage(
      foundation.value.missingFieldAudit.completeness.sentimentBucket,
      foundation.value.missingFieldAudit.completeness.fearGreedValue,
      foundation.value.missingFieldAudit.completeness.fearGreedBucket,
    ),
  } : null;
  const snapshotProvenance = adaptiveGate.ok ? adaptiveGate.value.coverageProvenance : null;
  const symbolSensitiveRoute = symbolRoute.ok
    ? symbolRoute.value.routeHeterogeneity.find((item) => item.verdict === "SYMBOL_SENSITIVE")?.routeCombo ?? null
    : null;
  const interactionVsPolicyNote = strongestInteraction && counterfactual.ok && counterfactual.value.bestImprovingScenario
    && strongestInteraction.interactionLabel.trim() !== counterfactual.value.bestImprovingScenario.label.trim()
    ? "Note: strongest interaction is a slice-level observation; best counterfactual is a scenario-level policy simulation. They do not have to match."
    : null;
  const openOverlayTaggedPositions = positions.filter((position) =>
    (position.strategyContextSnapshot?.adaptiveRegimeGateOverlayAssessments?.length ?? 0) > 0 &&
    position.variants.every((variant) => variant.state !== "CLOSED" || variant.closeReason === "NO_FILL"),
  ).length;
  const overlayVerdict = forwardOverlay.ok
    ? forwardOverlay.value.policyPerformance
      .map((policy) => policy.earlyVerdict)
      .find((verdict) => verdict !== "NO_FORWARD_EVIDENCE_YET") ?? "NO_FORWARD_EVIDENCE_YET"
    : "UNAVAILABLE";

  // Resolve the best EX_TOXIC sibling for reporting (short-specific preferred, fall back to overall)
  const exToxicSibling = adaptiveProfitPolicySynthesis.ok
    ? (adaptiveProfitPolicySynthesis.value.bestShortPolicyExToxic ?? adaptiveProfitPolicySynthesis.value.bestOverallPolicyExToxic ?? null)
    : null;
  // When promotion is active, the canonical parent is preserved in bestShortPolicyParent
  const parentForExToxic = adaptiveProfitPolicySynthesis.ok
    ? (adaptiveProfitPolicySynthesis.value.bestShortPolicyParent
        ?? adaptiveProfitPolicySynthesis.value.bestShortPolicy
        ?? adaptiveProfitPolicySynthesis.value.bestOverallPolicyParent
        ?? adaptiveProfitPolicySynthesis.value.bestOverallPolicy
        ?? null)
    : null;
  // Promotion state flags for section markers
  const shortPromotionActive =
    adaptiveProfitPolicySynthesis.ok &&
    (adaptiveProfitPolicySynthesis.value.shortPolicyPromotionResult?.refinedPromotionEligible ?? false);
  const overallPromotionActive =
    adaptiveProfitPolicySynthesis.ok &&
    (adaptiveProfitPolicySynthesis.value.overallPolicyPromotionResult?.refinedPromotionEligible ?? false);
  // The "active" promotion for Section W: use the promoted sibling's metrics when promotion is live
  const promotedShortSibling = shortPromotionActive
    ? (adaptiveProfitPolicySynthesis.ok ? adaptiveProfitPolicySynthesis.value.bestShortPolicy : null)
    : null;
  const exToxicNetAvgRDelta =
    exToxicSibling?.netAvgR !== null && exToxicSibling?.netAvgR !== undefined &&
    parentForExToxic?.netAvgR !== null && parentForExToxic?.netAvgR !== undefined
      ? exToxicSibling.netAvgR - parentForExToxic.netAvgR
      : null;
  const exToxicPfDelta =
    exToxicSibling?.profitFactor !== null && exToxicSibling?.profitFactor !== undefined &&
    parentForExToxic?.profitFactor !== null && parentForExToxic?.profitFactor !== undefined
      ? exToxicSibling.profitFactor - parentForExToxic.profitFactor
      : null;

  // Build EX_TOXIC-aware executive takeaway when a materially better sibling exists
  const exToxicMateriallyBetter = exToxicSibling !== null && exToxicNetAvgRDelta !== null && exToxicNetAvgRDelta > 0.05;
  const executiveTakeaway: string = (() => {
    if (exToxicMateriallyBetter && exToxicSibling !== null) {
      // policyLabel already embeds [EX_TOXIC: <symbols>] — use it directly without duplicating
      const overlayClause = (forwardOverlay.ok ? forwardOverlay.value.overlayForwardCoveragePct : 0) > 0
        ? `forward overlay coverage is ${fmtPct(forwardOverlay.ok ? forwardOverlay.value.overlayForwardCoveragePct : 0)}`
        : "external strategy-fit overlay remains early but mildly positive";
      // When formally promoted, confirm it as the selected best short policy
      const selectionClause = (shortPromotionActive || overallPromotionActive)
        ? " Formally selected as best short policy (refined promotion confirmed)."
        : "";
      const parentComparisonClause = " materially stronger than unfiltered parent.";
      const realisticClause = exToxicSibling.netAvgRRealisticBasis != null
        ? exToxicSibling.netAvgRRealisticBasis >= 0.15
          ? ` and above the +0.15R micro-pilot threshold on realistic Binance USD-M fee basis (netAvgR≈${fmtNum(exToxicSibling.netAvgRRealisticBasis)})`
          : ` but also below the +0.15R micro-pilot threshold on realistic Binance USD-M fee basis (netAvgR≈${fmtNum(exToxicSibling.netAvgRRealisticBasis)})`
        : "";
      return `No route is live-ready. Most actionable refined policy: ${exToxicSibling.policyLabel}, meaningfully positive on conservative basis (netAvgR=${fmtNum(exToxicSibling.netAvgR)}, PF=${fmtNum(exToxicSibling.profitFactor, 4)}) but below the +0.15R conservative readiness threshold${realisticClause}, consensus=${exToxicSibling.evidenceConsensus.evidenceConsensusVerdict} —${parentComparisonClause}${selectionClause} ${overlayClause}.`;
    }
    return summarizeTakeaway({
      liveReady: liveReadiness.ok ? liveReadiness.value.liveReady : false,
      liveLeader: leader ? routeLabel(leader.entryVariant, leader.exitVariant) : null,
      bestScenario: counterfactual.ok ? counterfactual.value.bestImprovingScenario?.label ?? null : null,
      bestScenarioDelta: counterfactual.ok ? counterfactual.value.bestImprovingScenario?.deltaNetAvgRVsBaseline ?? null : null,
      topGateInteraction: strongestInteraction?.interactionLabel ?? null,
      overlayCoverage: forwardOverlay.ok ? forwardOverlay.value.overlayForwardCoveragePct : 0,
      gateStabilityQualifier,
    });
  })();

  // ---- Regime Direction Controller Retrospective Audit (REPORT-ONLY) ----
  // Replays the controller against all closed positions to measure whether
  // controller-allowed trades historically outperformed controller-blocked.
  // Zero behavior influence — surfaced under section W** for audit visibility.
  const regimeControllerRetroAudit: RetroAuditReport =
    buildRegimeDirectionControllerRetroAudit(positions);

  // ---- Regime Direction Controller (Phase 1, REPORT-ONLY) ----------------
  // Names a directional posture from the current scan regime alone. The
  // controller has zero behavior influence — it is surfaced under section W*
  // for audit visibility and dry-run comparison against historical outcomes.
  const regimeDirectionControllerReport: RegimeDirectionControllerReport = (() => {
    const currentScanRegime =
      opts.coreScanAutoRefresh?.lastAutoRefreshResultSummary?.marketRegime ?? null;
    const adaptiveDirectionBias = adaptiveProfitPolicySynthesis.ok
      ? adaptiveProfitPolicySynthesis.value.currentAdaptiveDirectionBias
      : null;
    const primaryLaneCandidate = adaptiveProfitPolicySynthesis.ok
      ? adaptiveProfitPolicySynthesis.value.operativeCollectionPlan.currentOperativePrimaryLane
      : null;
    const primaryValidationLane = primaryLaneCandidate
      ? {
          label: primaryLaneCandidate.policyLabel,
          dominantRegime: primaryLaneCandidate.dominantRegime ?? null,
          direction:
            primaryLaneCandidate.direction === "LONG" || primaryLaneCandidate.direction === "SHORT"
              ? primaryLaneCandidate.direction
              : null,
          microPilotReady: primaryLaneCandidate.microPilotReadiness?.microPilotReady ?? false,
        }
      : null;
    return buildRegimeDirectionControllerReport({
      currentRegime: currentScanRegime,
      adaptiveDirectionBias,
      primaryValidationLane,
    });
  })();

  // ---- Controller-Aligned Shadow Report (REPORT-ONLY) --------------------
  const regimeControllerAlignedShadowReport: RegimeControllerAlignedShadowReport | null =
    opts.controllerAlignedShadowStore
      ? buildRegimeControllerAlignedShadowReport(opts.controllerAlignedShadowStore)
      : null;

  // ---- Strategic Profit Roadmap (REPORT-ONLY) -------------------------
  const strategyResearchRoadmapReport: StrategyResearchRoadmapReport =
    buildStrategyResearchRoadmapReport(generatedAt);

  // Pull base-route current-guard lane summary from F* monitor (report-only)
  const baseRouteCurrentGuardLane = (() => {
    try {
      return opts.baseRouteRiskHygieneMonitor?.currentGuardLaneSummary;
    } catch {
      return undefined;
    }
  })();

  // ---- Shadow Lane Scoreboard (REPORT-ONLY) ---------------------------
  const shadowLaneScoreboard: ShadowLaneScoreboard = buildShadowLaneScoreboard(
    {
      filteredEdgeReport: opts.filteredEdgeReport,
      portfolioTrendReport: opts.portfolioTrendReport,
      controllerAlignedReport: regimeControllerAlignedShadowReport ?? undefined,
      baseRouteCurrentGuardLane,
      frozenCurrentGuardReport: opts.frozenCurrentGuardReport,
      currentGuardVariantMatrixReport: opts.currentGuardVariantMatrixReport,
    },
    generatedAt,
  );

  // ---- F**** Frozen Current-Guard Promotion Tracker (REPORT-ONLY) -----
  // Pure forward-looking promotion-readiness tracker. Advisory only; no live
  // behavior is gated on its status. Built from the F*** frozen report + the
  // F*** realistic cost model.
  const frozenPromotionTrackerResult = opts.frozenCurrentGuardReport
    ? safe(() =>
        buildFrozenPromotionTrackerReport(
          opts.frozenCurrentGuardReport!,
          opts.frozenCostModelReport,
          generatedAt,
        ),
      )
    : null;
  const frozenPromotionTrackerReport: FrozenPromotionTrackerReport | undefined =
    frozenPromotionTrackerResult && frozenPromotionTrackerResult.ok
      ? frozenPromotionTrackerResult.value
      : undefined;

  // ---- F***** Frozen Segment Pathology Audit (REPORT-ONLY) ---------------
  // Pure counterfactual: answers "is seg-1 drag an old-batch transient or a
  // recurring systematic risk?" Reads only from resolvedObservations (already
  // computed). Zero I/O, zero behavior influence.
  const _pathologyResult =
    opts.frozenCurrentGuardReport?.resolvedObservations?.length
      ? safe(() =>
          buildFrozenSegmentPathologyAudit(
            opts.frozenCurrentGuardReport!.resolvedObservations,
            generatedAt,
          ),
        )
      : null;
  const frozenSegmentPathologyAudit: FrozenSegmentPathologyAudit | undefined =
    _pathologyResult?.ok ? _pathologyResult.value : undefined;

  // ---- AE/AF/AG Infrastructure Readiness Reports (REPORT-ONLY SPECS) ---
  // These are forward-looking spec reports describing FUTURE requirements.
  // Nothing is implemented; all report ready=false. Pure; never throw.
  const killSwitchReadiness: KillSwitchReadinessReport =
    buildKillSwitchReadinessReport(generatedAt);
  const orderReconciliationReadiness: OrderReconciliationReadinessReport =
    buildOrderReconciliationReadinessReport(generatedAt);
  const exchangeHealthReadiness: ExchangeHealthReadinessReport =
    buildExchangeHealthReadinessReport(generatedAt);

  // ---- Live Trading Gate (HARD BLOCK, REPORT-ONLY) --------------------
  const liveTradingGateReport: LiveTradingGateReport = buildLiveTradingGateReport(
    {
      filteredEdgeReport: opts.filteredEdgeReport,
      portfolioTrendReport: opts.portfolioTrendReport,
      controllerAlignedReport: regimeControllerAlignedShadowReport ?? undefined,
      baseRouteCurrentGuardLane,
      frozenCurrentGuardReport: opts.frozenCurrentGuardReport,
      frozenCostModelReport: opts.frozenCostModelReport,
      killSwitchReadiness,
      orderReconciliationReadiness,
      exchangeHealthReadiness,
      frozenPromotionTracker: frozenPromotionTrackerReport,
      postCutoverReport: opts.postCutoverReport,
      currentGuardVariantMatrixReport: opts.currentGuardVariantMatrixReport,
    },
    generatedAt,
  );

  // ---- AH Adaptive Lane Router V1 (REPORT-ONLY) -----------------------
  // Pure synthesis over regime + post-cutover + variant-matrix + gate. Never
  // feeds back into the gate blocker math; liveBlocked/microPilotAllowed are
  // hard invariants on its own report.
  const adaptiveLaneRouterReport: AdaptiveLaneRouterReport = buildAdaptiveLaneRouterReport({
    generatedAt,
    regimeReport: regimeDirectionControllerReport,
    postCutoverReport: opts.postCutoverReport,
    variantMatrixReport: opts.currentGuardVariantMatrixReport,
    gateReport: liveTradingGateReport,
    scoreboardReport: shadowLaneScoreboard,
  });

  // ---- Accelerated Evidence Funnel (REPORT-ONLY) -------------------------
  const candidateFunnelEntries = opts.candidateFunnelEntries ?? null;
  const acceleratedEvidenceFunnelReport: AcceleratedEvidenceFunnelReport =
    candidateFunnelEntries && candidateFunnelEntries.length > 0
      ? buildAcceleratedEvidenceFunnelReportFromLog(
          candidateFunnelEntries,
          opts.controllerAlignedShadowStore?.observations ?? [],
          {
            windowLabel: "LAST_24H_LOG",
            currentControllerMode: regimeDirectionControllerReport.controllerMode,
          },
        )
      : buildAcceleratedEvidenceFunnelReport(
          positions,
          opts.controllerAlignedShadowStore?.observations ?? [],
          {
            controllerMode: regimeDirectionControllerReport.controllerMode,
            era,
          },
        );

  const highlights = {
    botState: {
      totalIdeas: positions.length,
      eraIdeaCount: eraPositions.length,
      routeModeCounts,
      evidenceEra: era,
      resolvedExperienceRecords: eraRecords.length,
    },
    liveReadiness: liveReadiness.ok ? {
      score: liveReadiness.value.score,
      liveReady: liveReadiness.value.liveReady,
      lockedEvaluationRoute: liveReadiness.value.lockedEvaluationRoute.label,
      maturityLeader: liveReadiness.value.leadingMaturityCohort?.label ?? null,
      routeAlignmentStatus: liveReadiness.value.routeAlignmentStatus,
      failedGateCount: liveReadiness.value.failedGates.length,
      topFailingGates: liveReadiness.value.failedGates.slice(0, 3),
    } : { unavailable: true, error: liveReadiness.error },
    routeMaturity: routeMaturity.ok ? {
      leader: leader ? routeLabel(leader.entryVariant, leader.exitVariant) : null,
      closedCount: leader?.closedCount ?? 0,
      netAvgR: leader?.netAvgR ?? null,
      grossAvgR: leader?.grossAvgR ?? null,
      profitFactor: leader?.profitFactor ?? null,
      tp1ProfitableRate: leader?.profitableTp1Rate ?? null,
      slRate: leader?.slRate ?? null,
      maturityStatus: leader?.maturityStatus ?? "NO_LEADER",
    } : { unavailable: true, error: routeMaturity.error },
    currentPerformance: counterfactual.ok ? {
      closedCount: counterfactual.value.baseline.closedCount,
      netAvgR: counterfactual.value.baseline.netAvgR,
      grossAvgR: counterfactual.value.baseline.grossAvgR,
      profitFactor: counterfactual.value.baseline.profitFactor,
      tp1ProfitableRate: counterfactual.value.baseline.tp1ProfitableRate,
      slRate: counterfactual.value.baseline.slRate,
      status: regimeDrift.ok ? regimeDrift.value.overallStatus : "UNAVAILABLE",
    } : { unavailable: true, error: counterfactual.error },
    profitAnatomy: profitAnatomy.ok ? {
      mainDiagnosis: profitAnatomy.value.summary.mainDiagnosis,
      avgWinR: profitAnatomy.value.summary.avgWinR,
      avgLossR: profitAnatomy.value.summary.avgLossR,
      expectancyGap: profitAnatomy.value.summary.expectancyGap,
      topLeakOrFlag: topLeakFlag,
    } : { unavailable: true, error: profitAnatomy.error },
    stopGeometry: stopGeometry.ok ? {
      mainDiagnosis: stopGeometry.value.summary.mainDiagnosis,
      strongestToxicBucket: toxicStopBucket ? {
        bucket: toxicStopBucket.bucket,
        netAvgR: toxicStopBucket.netAvgR,
        slRate: toxicStopBucket.slRate,
      } : null,
      bestCounterfactual: bestStopCounterfactual ? {
        scenario: bestStopCounterfactual.label,
        deltaNetAvgRVsBaseline: bestStopCounterfactual.deltaNetAvgRVsBaseline,
        interpretation: bestStopCounterfactual.interpretation,
      } : null,
      ultraTightBucketHistoricallyToxic: stopGeometry.value.stopBuckets.some((bucket) =>
        bucket.bucket === "ULTRA_TIGHT" && bucket.closedCount > 0 && (bucket.netAvgR ?? 0) < 0),
    } : { unavailable: true, error: stopGeometry.error },
    baseRouteRiskHygieneMonitor: opts.baseRouteRiskHygieneMonitor ? {
      guardReasonCode: opts.baseRouteRiskHygieneMonitor.guardReasonCode,
      guardThresholdBps: opts.baseRouteRiskHygieneMonitor.guardThresholdBps,
      guardActivatedAtRetainedLog: opts.baseRouteRiskHygieneMonitor.guardActivatedAtRetainedLog,
      skippedUltraTightCandidates: opts.baseRouteRiskHygieneMonitor.skippedUltraTightCandidates,
      postGuardTape: opts.baseRouteRiskHygieneMonitor.postGuardTape,
      previousHygieneTape: opts.baseRouteRiskHygieneMonitor.previousHygieneTape,
      legacyOrMixedTape: opts.baseRouteRiskHygieneMonitor.legacyOrMixedTape,
      verdict: opts.baseRouteRiskHygieneMonitor.verdict,
      currentGuardLaneSummary: opts.baseRouteRiskHygieneMonitor.currentGuardLaneSummary,
      reportOnly: true,
    } : { unavailable: true },
    winnerLoser: winnerLoser.ok ? {
      diagnosis: winnerLoser.value.summary.mainDiagnosis,
      topWinnerSignals,
      topLoserSignals,
    } : { unavailable: true, error: winnerLoser.error },
    intelligenceFoundation: foundation.ok ? {
      strategyContexts: foundation.value.metadata.contextSnapshotCount,
      resolvedExperienceRecords: foundation.value.metadata.resolvedExperienceRecordCount,
      symbolRouteReady: foundation.value.dataReadiness.readyForSymbolRouteEngine,
      adaptiveGateReady: foundation.value.dataReadiness.readyForAdaptiveGateController,
      technicalStopTpReady: foundation.value.dataReadiness.readyForTechnicalStopTpEngine,
      universeRotationReady: foundation.value.dataReadiness.readyForUniverseRotation,
      snapshotProvenance: snapshotProvenance ? {
        resolvedRecordsWithStrategyContext: snapshotProvenance.resolvedRecordsWithStrategyContext,
        recordsCreatedBeforePhase2A5: snapshotProvenance.recordsCreatedBeforePhase2A5,
        recordsCreatedAfterPhase2A5: snapshotProvenance.recordsCreatedAfterPhase2A5,
        openPositionsWithStrategyContext: snapshotProvenance.openPositionsWithStrategyContext,
      } : null,
      dataCompleteness: contextCompleteness,
      blockers: {
        symbolRoute: firstBlockingReason(foundation.value.dataReadiness.symbolRouteEngine.reasonsBlocking),
        adaptiveGate: firstBlockingReason(foundation.value.dataReadiness.adaptiveGateController.reasonsBlocking),
        technicalStopTp: firstBlockingReason(foundation.value.dataReadiness.technicalStopTpEngine.reasonsBlocking),
        universeRotation: firstBlockingReason(foundation.value.dataReadiness.universeRotation.reasonsBlocking),
      },
    } : { unavailable: true, error: foundation.error },
    symbolRouteSuitability: symbolRoute.ok ? {
      recordsAnalyzed: symbolRoute.value.metadata.resolvedExperienceRecordCount,
      pairsWithAtLeast5Closes: symbolRoute.value.metadata.pairsWithAtLeast5Closes,
      pairsWithAtLeast15Closes: symbolRoute.value.metadata.pairsWithAtLeast15Closes,
      pairsWithAtLeast30Closes: symbolRoute.value.metadata.pairsWithAtLeast30Closes,
      pairsWithAtLeast5ClosesEffective: symbolRoute.value.metadata.pairsWithAtLeast5ClosesEffective,
      pairsWithAtLeast15ClosesEffective: symbolRoute.value.metadata.pairsWithAtLeast15ClosesEffective,
      pairsWithAtLeast30ClosesEffective: symbolRoute.value.metadata.pairsWithAtLeast30ClosesEffective,
      topPromisingCohort: topPromisingSuitability ? {
        label: `${topPromisingSuitability.symbol} ${topPromisingSuitability.direction} ${topPromisingSuitability.routeCombo}`,
        verdict: topPromisingSuitability.localVerdict,
        netAvgR: topPromisingSuitability.netAvgR,
        credibilityBlocked: false,
      } : null,
      topToxicCohort: topToxicSuitability ? {
        label: `${topToxicSuitability.symbol} ${topToxicSuitability.direction} ${topToxicSuitability.routeCombo}`,
        verdict: topToxicSuitability.localVerdict,
        netAvgR: topToxicSuitability.netAvgR,
      } : null,
      highestRawReturnFlaggedCohort: highestRawReturnFlaggedCohort ? {
        label: `${highestRawReturnFlaggedCohort.symbol} ${highestRawReturnFlaggedCohort.direction} ${highestRawReturnFlaggedCohort.routeCombo}`,
        verdict: highestRawReturnFlaggedCohort.localVerdict,
        netAvgR: highestRawReturnFlaggedCohort.netAvgR,
        credibilityWarning: "multiplicity",
      } : null,
      symbolSensitive,
      symbolSensitiveRoute,
    } : { unavailable: true, error: symbolRoute.error },
    adaptiveGateIntelligence: adaptiveGate.ok ? {
      baselineNetAvgR: adaptiveGate.value.baseline.netAvgR,
      topSupportiveCondition: topSupportiveGate ? {
        label: topSupportiveGate.conditionLabel,
        deltaNetAvgR: topSupportiveGate.performanceDeltaVsBaseline.netAvgR,
        signal: topSupportiveGate.localGateSignal,
      } : null,
      topHarmfulCondition: topHarmfulGate ? {
        label: topHarmfulGate.conditionLabel,
        deltaNetAvgR: topHarmfulGate.performanceDeltaVsBaseline.netAvgR,
        signal: topHarmfulGate.localGateSignal,
      } : null,
      strongestInteraction: strongestInteraction ? {
        label: strongestInteraction.interactionLabel,
        deltaNetAvgR: strongestInteraction.deltaVsBaseline.netAvgR,
        verdict: strongestInteraction.verdict,
      } : null,
      readyForGateInfluence: adaptiveGate.value.readiness.readyForGateInfluence,
      contextCoverage: adaptiveGate.value.contextCoverageSummary,
      interactionVsPolicyNote,
    } : { unavailable: true, error: adaptiveGate.error },
    regimePolicyCounterfactual: counterfactual.ok ? {
      bestScenario: counterfactual.value.bestImprovingScenario ? {
        label: counterfactual.value.bestImprovingScenario.label,
        includedCount: counterfactual.value.bestImprovingScenario.includedCount,
        netAvgR: counterfactual.value.bestImprovingScenario.netAvgR,
        deltaNetAvgRVsBaseline: counterfactual.value.bestImprovingScenario.deltaNetAvgRVsBaseline,
        profitFactor: counterfactual.value.bestImprovingScenario.profitFactor,
        interpretation: counterfactual.value.bestImprovingScenario.interpretation,
      } : null,
      interactionVsPolicyNote,
    } : { unavailable: true, error: counterfactual.error },
    forwardOverlay: forwardOverlay.ok ? {
      recordsWithPersistedOverlay: forwardOverlay.value.recordsWithPersistedOverlay,
      coveragePct: forwardOverlay.value.overlayForwardCoveragePct,
      hasResolvedForwardEvidence: forwardOverlay.value.policyPerformance.some((policy) => policy.totalResolvedWithPolicy > 0),
      verdict: overlayVerdict,
      openOverlayTaggedPositions: openOverlayTaggedPositions > 0 ? openOverlayTaggedPositions : undefined,
    } : { unavailable: true, error: forwardOverlay.error },
    technicalStopTpCredibility: stopTpCredibility.ok ? {
      recordsWithRealizedPath: stopTpCredibility.value.recordsWithRealizedPath,
      realizedPathCoveragePct: stopTpCredibility.value.realizedPathCoveragePct,
      stopSurvivalVerdict: stopTpCredibility.value.stopSurvivalProfile.verdict,
      favorableExcursionVerdict: stopTpCredibility.value.favorableExcursionProfile.verdict,
      captureEfficiencyVerdict: stopTpCredibility.value.captureEfficiencyProfile.verdict,
      avgWinnerMaeR: stopTpCredibility.value.stopSurvivalProfile.avgWinnerMaeR,
      avgLoserMfeR: stopTpCredibility.value.favorableExcursionProfile.avgLoserMfeR,
      avgWinnerMfeR: stopTpCredibility.value.captureEfficiencyProfile.avgWinnerMfeR,
      avgWinnerGrossRealizedR: stopTpCredibility.value.captureEfficiencyProfile.avgWinnerGrossRealizedR,
      advisoryEngineReady: stopTpCredibility.value.readiness.advisoryEngineReady,
      readyForBehaviorInfluence: false,
      mainBlocker: stopTpCredibility.value.readiness.reasons[0] ?? null,
    } : { unavailable: true, error: stopTpCredibility.error },
    universeRotationIntelligence: universeRotation.ok ? {
      symbolCount: universeRotation.value.metadata.symbolCount,
      symbolsWithAtLeast5Closes: universeRotation.value.metadata.symbolsWithAtLeast5Closes,
      symbolsWithAtLeast15Closes: universeRotation.value.metadata.symbolsWithAtLeast15Closes,
      symbolsWithAtLeast30Closes: universeRotation.value.metadata.symbolsWithAtLeast30Closes,
      overallNetAvgR: universeRotation.value.universeContributionSummary.overallNetAvgR,
      positiveContributorCount: universeRotation.value.universeContributionSummary.positiveContributorCount,
      negativeContributorCount: universeRotation.value.universeContributionSummary.negativeContributorCount,
      topContributor: universeRotation.value.universeContributionSummary.topContributor?.symbol ?? null,
      worstContributor: universeRotation.value.universeContributionSummary.worstContributor?.symbol ?? null,
      coreObservationCandidateCount: universeRotation.value.coreObservationCandidates.length,
      rotationPressureCandidateCount: universeRotation.value.rotationPressureCandidates.length,
      advisoryEngineReady: universeRotation.value.readiness.advisoryEngineReady,
      readyForUniverseInfluence: false,
      readyForExternalCandidateSearch: false,
      mainBlocker: universeRotation.value.readiness.reasons[0] ?? null,
    } : { unavailable: true, error: universeRotation.error },
    externalCandidateDiscoveryIntelligence: externalCandidateDiscovery.ok ? {
      metadataDiagnostics: externalCandidateDiscovery.value.metadataDiagnostics,
      externalSymbolsConsidered: externalCandidateDiscovery.value.externalUniverseSymbolsConsidered,
      externalSymbolsTradable: externalCandidateDiscovery.value.externalUniverseSymbolsTradable,
      externalSymbolsRejected: externalCandidateDiscovery.value.externalUniverseSymbolsRejected,
      shortlistedCount: externalCandidateDiscovery.value.shortlistedCandidates.length,
      topExploratoryCandidate: externalCandidateDiscovery.value.shortlistedCandidates[0]
        ? {
            symbol: externalCandidateDiscovery.value.shortlistedCandidates[0].symbol,
            netDiscoveryScore: externalCandidateDiscovery.value.shortlistedCandidates[0].netDiscoveryScore,
            tier: externalCandidateDiscovery.value.shortlistedCandidates[0].discoveryTier,
          }
        : null,
      promisingFingerprintConfidence: externalCandidateDiscovery.value.discoveryFingerprintBasis.promisingFingerprintConfidence,
      toxicFingerprintConfidence: externalCandidateDiscovery.value.discoveryFingerprintBasis.toxicFingerprintConfidence,
      readinessConfidence: externalCandidateDiscovery.value.discoveryReadiness.confidence,
      advisoryEngineReady: externalCandidateDiscovery.value.discoveryReadiness.advisoryEngineReady,
      readyForUniverseExpansionInfluence: false,
      readyForRotationShadowOverlay: false,
      mainBlocker: externalCandidateDiscovery.value.discoveryReadiness.reasons[0] ?? null,
    } : { unavailable: true, error: externalCandidateDiscovery.error },
    externalStrategyFitEnrichment: externalStrategyFitEnrichment.ok ? {
      discoveryShortlistCount: externalStrategyFitEnrichment.value.discoverySourceSummary.discoveryShortlistCount,
      enrichedCandidateCount: externalStrategyFitEnrichment.value.enrichedCandidateCount,
      failedCandidateCount: externalStrategyFitEnrichment.value.failedCandidateCount,
      topStrategyFitCandidate: externalStrategyFitEnrichment.value.topStrategyFitCandidates[0]
        ? {
            symbol: externalStrategyFitEnrichment.value.topStrategyFitCandidates[0].symbol,
            strategyFitScore: externalStrategyFitEnrichment.value.topStrategyFitCandidates[0].strategyFitScore,
            tier: externalStrategyFitEnrichment.value.topStrategyFitCandidates[0].strategyFitTier,
          }
        : null,
      lowFitCount: externalStrategyFitEnrichment.value.lowFitCandidates.length,
      metadataShortlistDivergesFromStrategyFit: externalStrategyFitEnrichment.value.metadataShortlistDivergesFromStrategyFit,
      readinessConfidence: externalStrategyFitEnrichment.value.enrichmentReadiness.confidence,
      advisoryEngineReady: externalStrategyFitEnrichment.value.enrichmentReadiness.advisoryEngineReady,
      readyForRotationShadowOverlay: false,
      readyForUniverseInfluence: false,
      mainBlocker: externalStrategyFitEnrichment.value.enrichmentReadiness.reasons[0] ?? null,
      diagnostics: externalStrategyFitEnrichment.value.diagnostics,
    } : { unavailable: true, error: externalStrategyFitEnrichment.error },
    externalRotationOverlayEconomics: externalRotationOverlayEconomics.ok ? {
      resolvedObservations: externalRotationOverlayEconomics.value.resolvedObservations,
      headlineInterpretiveSampleSize: externalRotationOverlayEconomics.value.headlineInterpretiveSampleSize,
      forensicDistortedSampleSize: externalRotationOverlayEconomics.value.forensicDistortedSampleSize,
      forensicBorderlineSampleSize: externalRotationOverlayEconomics.value.forensicBorderlineSampleSize,
      primaryDiagnosis: externalRotationOverlayEconomics.value.economicsDiagnosis.primaryDiagnosis,
      costComponentsAvailable: false,
      strategyFitGroup: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")
        ? {
            grossAvgR: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.grossAvgR,
            netAvgR: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.netAvgR,
            avgCostDragR: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.avgCostDragR,
            resolvedCount: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.resolvedCount,
            headlineInterpretiveSampleSize: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.headlineInterpretiveSampleSize,
            forensicResolvedSampleSize: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.forensicResolvedSampleSize,
            distortedExcludedFromHeadline: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.distortedExcludedFromHeadline,
            borderlineExcludedFromHeadline: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.borderlineExcludedFromHeadline,
            economicsVerdict: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST")!.economicsVerdict,
          }
        : null,
      metadataBaselineGroup: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")
        ? {
            grossAvgR: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.grossAvgR,
            netAvgR: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.netAvgR,
            avgCostDragR: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.avgCostDragR,
            resolvedCount: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.resolvedCount,
            headlineInterpretiveSampleSize: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.headlineInterpretiveSampleSize,
            forensicResolvedSampleSize: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.forensicResolvedSampleSize,
            distortedExcludedFromHeadline: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.distortedExcludedFromHeadline,
            borderlineExcludedFromHeadline: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.borderlineExcludedFromHeadline,
            economicsVerdict: externalRotationOverlayEconomics.value.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE")!.economicsVerdict,
          }
        : null,
      geometryFindingsCount: externalRotationOverlayEconomics.value.geometryFindings.length,
      readyForResolverBehaviorDiscussion: false,
      readyForUniverseRotationInterpretation: false,
      mainBlocker: externalRotationOverlayEconomics.value.readiness.reasons[0] ?? null,
    } : { unavailable: true, error: externalRotationOverlayEconomics.error },
    externalRotationOverlayEconomicsCredibility: externalRotationOverlayEconomics.ok ? (() => {
      const interp = externalRotationOverlayEconomics.value.externalOverlayInterpretability;
      const sfCred = externalRotationOverlayEconomics.value.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST");
      return {
        netRotationComparisonStatus: interp.netRotationComparisonStatus,
        grossDirectionalComparisonStatus: interp.grossDirectionalComparisonStatus,
        interpretableCount: interp.interpretableCount,
        distortedCount: interp.distortedCount,
        borderlineCount: interp.borderlineCount,
        totalClassified: interp.totalClassified,
        warningMessage: interp.warningMessage,
        strategyFitCredibility: sfCred
          ? {
              credibilityVerdict: sfCred.credibilityVerdict,
              pctDistorted: sfCred.pctDistorted,
              distortedCount: sfCred.distortedCount,
              interpretableCount: sfCred.interpretableCount,
              dominantDistortionFlag: sfCred.dominantDistortionFlag,
            }
          : null,
      };
    })() : { unavailable: true, error: externalRotationOverlayEconomics.error },
    tpSlGeometryRootCauseAudit: tpSlGeometryRootCauseAudit.ok ? {
      primaryRootCause: tpSlGeometryRootCauseAudit.value.rootCauseVerdict,
      rootCauseVerdict: tpSlGeometryRootCauseAudit.value.rootCauseVerdict,
      secondaryAmplifier: tpSlGeometryRootCauseAudit.value.secondaryGeometryFinding,
      costModelSanity: tpSlGeometryRootCauseAudit.value.costModelSanity,
      externalVsActiveComparison: tpSlGeometryRootCauseAudit.value.externalVsActiveComparison,
      activeBotHasSameMismatchBug: tpSlGeometryRootCauseAudit.value.activeBotHasSameMismatchBug,
      legacyV1Only: tpSlGeometryRootCauseAudit.value.legacyV1Only,
      rrInflationDriver: tpSlGeometryRootCauseAudit.value.rrInflationDriver,
      pctObservationsWithMismatch: tpSlGeometryRootCauseAudit.value.pctObservationsWithMismatch,
      avgInflationRatio: tpSlGeometryRootCauseAudit.value.avgInflationRatio,
      strongestOffendingVariant: tpSlGeometryRootCauseAudit.value.strongestOffendingVariant,
      resolvedObservations: tpSlGeometryRootCauseAudit.value.resolvedObservations,
      readyForResolverBehaviorChange: false,
      readyForCostModelChange: false,
    } : { unavailable: true, error: tpSlGeometryRootCauseAudit.error },
    adaptiveProfitPolicySynthesis: adaptiveProfitPolicySynthesis.ok ? (() => {
      const synthesis = adaptiveProfitPolicySynthesis.value;
      // Build per-lane cross-intelligence operative suppression block
      const suppressionLanes: Array<{
        policyId: string;
        crossIntelligenceOperativeSuppression: "ACTIVE" | "INACTIVE";
        tier1LaneToxicSymbolsSuppressed: string[];
        tier2LaneToxicWatchlist: string[];
        scopeNote: string;
      }> = [];

      // Collect EX_TOXIC sibling candidates to build the suppression summary
      for (const candidate of synthesis.candidates) {
        if (
          candidate.symbolScope === "ALL_SYMBOLS_EX_TOXIC" &&
          candidate.excludedSymbols &&
          candidate.excludedSymbols.length > 0
        ) {
          suppressionLanes.push({
            policyId: candidate.policyId,
            crossIntelligenceOperativeSuppression: "ACTIVE",
            tier1LaneToxicSymbolsSuppressed: candidate.excludedSymbols,
            tier2LaneToxicWatchlist: candidate.tier2ToxicWatchlistSymbols ?? [],
            scopeNote: "Lane-specific only; no global universe deletion.",
          });
        }
      }

      return {
        bestOverallPolicy: synthesis.bestOverallPolicy,
        bestShortPolicy: synthesis.bestShortPolicy,
        bestLongPolicy: synthesis.bestLongPolicy,
        bestOverallPolicyExToxic: synthesis.bestOverallPolicyExToxic,
        bestShortPolicyExToxic: synthesis.bestShortPolicyExToxic,
        bestLongPolicyExToxic: synthesis.bestLongPolicyExToxic,
        rankedTopPolicies: synthesis.rankedTopPolicies,
        crossIntelligenceOperativeSuppressionLanes: suppressionLanes.length > 0
          ? suppressionLanes
          : [{ crossIntelligenceOperativeSuppression: "INACTIVE" as const, tier1LaneToxicSymbolsSuppressed: [], tier2LaneToxicWatchlist: [], scopeNote: "Lane-specific only; no global universe deletion.", policyId: "NONE" }],
      };
    })() : { unavailable: true, error: adaptiveProfitPolicySynthesis.error },
    adaptiveDirectionPosture: adaptiveProfitPolicySynthesis.ok ? {
      currentAdaptiveDirectionBias: adaptiveProfitPolicySynthesis.value.currentAdaptiveDirectionBias,
      directionalReadiness: adaptiveProfitPolicySynthesis.value.directionalReadiness,
      missingEvidenceForLongLane: adaptiveProfitPolicySynthesis.value.missingEvidenceForLongLane,
      missingEvidenceForShortLane: adaptiveProfitPolicySynthesis.value.missingEvidenceForShortLane,
      structurallyShortOnly: false,
    } : { unavailable: true, error: adaptiveProfitPolicySynthesis.error },
    microPilotReadinessByPolicyLane: adaptiveProfitPolicySynthesis.ok ? {
      lanes: adaptiveProfitPolicySynthesis.value.rankedTopPolicies.map((policy) => ({
        policyId: policy.policyId,
        verdict: policy.microPilotReadiness.verdict,
        microPilotReady: policy.microPilotReadiness.microPilotReady,
        blockers: policy.microPilotReadiness.blockers,
      })),
    } : { unavailable: true, error: adaptiveProfitPolicySynthesis.error },
    exploitShadowCollectionPriorities: adaptiveProfitPolicySynthesis.ok ? adaptiveProfitPolicySynthesis.value.operativeCollectionPlan
      : { unavailable: true, error: adaptiveProfitPolicySynthesis.error },
    regimeDirectionController: regimeDirectionControllerReport,
    regimeControllerRetroAudit,
    acceleratedEvidenceFunnel: acceleratedEvidenceFunnelReport,
    regimeControllerAlignedShadow: regimeControllerAlignedShadowReport ?? undefined,
    parallelShadowExperimentMatrix: opts.parallelShadowExperimentReport ? {
      laneVersion: opts.parallelShadowExperimentReport.laneVersion,
      experimentCount: opts.parallelShadowExperimentReport.experimentCount,
      promotionCandidates: opts.parallelShadowExperimentReport.rows.filter((row) => row.status === "PROMOTION_CANDIDATE").length,
      watchable: opts.parallelShadowExperimentReport.rows.filter((row) => row.status === "WATCHABLE").length,
      kill: opts.parallelShadowExperimentReport.rows.filter((row) => row.status === "KILL").length,
      baselineExperimentId: opts.parallelShadowExperimentReport.baselineExperimentId,
      reportOnly: true,
    } : { unavailable: true },
    externalRotationShadowOverlay: externalRotationOverlay.ok ? {
      totalObservations: externalRotationOverlay.value.totalObservations,
      rawObservationCount: externalRotationOverlay.value.validityCounts.rawObservationCount,
      validObservationCount: externalRotationOverlay.value.validityCounts.validObservationCount,
      legacyInvalidExcludedCount: externalRotationOverlay.value.validityCounts.legacyInvalidExcludedCount,
      validOpenCount: externalRotationOverlay.value.openObservations,
      validResolvedCount: externalRotationOverlay.value.resolvedObservations,
      validNoFillCount: externalRotationOverlay.value.noFillObservations,
      validExpiredCount: externalRotationOverlay.value.expiredObservations,
      validFailedCount: externalRotationOverlay.value.failedObservations,
      validStatusAccountingTotal:
        externalRotationOverlay.value.openObservations +
        externalRotationOverlay.value.resolvedObservations +
        externalRotationOverlay.value.noFillObservations +
        externalRotationOverlay.value.expiredObservations +
        externalRotationOverlay.value.failedObservations,
      validStatusAccountingMatches:
        externalRotationOverlay.value.validityCounts.validObservationCount === (
          externalRotationOverlay.value.openObservations +
          externalRotationOverlay.value.resolvedObservations +
          externalRotationOverlay.value.noFillObservations +
          externalRotationOverlay.value.expiredObservations +
          externalRotationOverlay.value.failedObservations
        ),
      openObservations: externalRotationOverlay.value.openObservations,
      resolvedObservations: externalRotationOverlay.value.resolvedObservations,
      noFillObservations: externalRotationOverlay.value.noFillObservations,
      expiredObservations: externalRotationOverlay.value.expiredObservations,
      failedObservations: externalRotationOverlay.value.failedObservations,
      strategyFitGroupResolved: externalRotationOverlay.value.groupPerformance.find((group) => group.group === "STRATEGY_FIT_SHORTLIST")?.resolvedCount ?? 0,
      strategyFitGroupHeadlineResolved: externalRotationOverlay.value.groupPerformance.find((group) => group.group === "STRATEGY_FIT_SHORTLIST")?.headlineResolvedCount ?? 0,
      metadataBaselineGroupResolved: externalRotationOverlay.value.groupPerformance.find((group) => group.group === "METADATA_DISCOVERY_BASELINE")?.resolvedCount ?? 0,
      metadataBaselineGroupHeadlineResolved: externalRotationOverlay.value.groupPerformance.find((group) => group.group === "METADATA_DISCOVERY_BASELINE")?.headlineResolvedCount ?? 0,
      currentBestObservedGroup: externalRotationOverlay.value.currentBestObservedGroup?.group ?? null,
      verdict: externalRotationOverlay.value.currentBestObservedGroup?.earlyVerdict ?? "NO_FORWARD_EVIDENCE_YET",
      readyForUniverseInfluence: false,
      readyForRotationDiscussion: false,
      mainBlocker: externalRotationOverlay.value.readiness.reasons[0] ?? null,
      diagnosticsAvailable: externalRotationOverlay.value.duplicateSuppressionStats.diagnosticsAvailable,
      lastRefreshAt: externalRotationOverlay.value.duplicateSuppressionStats.lastRefreshAt,
      refreshConsidered: externalRotationOverlay.value.duplicateSuppressionStats.observationsConsidered,
      refreshCreated: externalRotationOverlay.value.duplicateSuppressionStats.observationsCreated,
      refreshDuplicateSuppressed: externalRotationOverlay.value.duplicateSuppressionStats.observationsSuppressedAsDuplicate,
      refreshSkippedInsufficientState: externalRotationOverlay.value.duplicateSuppressionStats.observationsSkippedForInsufficientState,
      refreshRejectedEconomicDistortion: externalRotationOverlay.value.duplicateSuppressionStats.rejectedForEconomicDistortionCount,
      duplicateSuppressionStats: externalRotationOverlay.value.duplicateSuppressionStats,
      autoRefresh: externalRotationOverlay.value.autoRefresh,
    } : { unavailable: true, error: externalRotationOverlay.error },
    executiveTakeaway,
  };

  const lines = [
    `DASHBOARD AUDIT SUMMARY - ${era}`,
    `Generated: ${generatedAt}`,
    "",
    "A. BOT STATE",
    `- Tracked ideas: ${positions.length} total | ${eraPositions.length} in era scope`,
    `- Route modes: PROFIT_CANDIDATE=${routeModeCounts.PROFIT_CANDIDATE}, DATA_COLLECTION=${routeModeCounts.DATA_COLLECTION}, RESEARCH_ONLY=${routeModeCounts.RESEARCH_ONLY}`,
    `- Evidence era: ${era}`,
    `- Resolved current-era records: ${eraRecords.length}`,
    summarizeCoreScanAutoRefresh(opts.coreScanAutoRefresh),
    "",
    "B. LIVE READINESS",
    liveReadiness.ok
      ? `- Score: ${liveReadiness.value.score}/100 | liveReady=${liveReadiness.value.liveReady}`
      : `- Unavailable: ${liveReadiness.error}`,
    liveReadiness.ok
      ? `- Locked route: ${liveReadiness.value.lockedEvaluationRoute.label} | maturity leader: ${liveReadiness.value.leadingMaturityCohort?.label ?? "none"} | alignment: ${liveReadiness.value.routeAlignmentStatus}`
      : "- Locked route: unavailable",
    liveReadiness.ok
      ? `- Failing gates: ${liveReadiness.value.failedGates.length} ${liveReadiness.value.failedGates.length > 0 ? `(${liveReadiness.value.failedGates.slice(0, 3).join(", ")})` : ""}`
      : "- Failing gates: unavailable",
    "",
    "C. CURRENT LEADING ROUTE MATURITY",
    routeMaturity.ok
      ? `- Leader: ${leader ? routeLabel(leader.entryVariant, leader.exitVariant) : "none"} | closed=${fmtCount(leader?.closedCount)} | netAvgR=${fmtNum(leader?.netAvgR)} | grossAvgR=${fmtNum(leader?.grossAvgR)}`
      : `- Unavailable: ${routeMaturity.error}`,
    routeMaturity.ok
      ? `- PF=${fmtNum(leader?.profitFactor, 2)} | TP1 profitable=${fmtPct(leader?.profitableTp1Rate)} | SL=${fmtPct(leader?.slRate)} | status=${leader?.maturityStatus ?? "n/a"}`
      : "- Metrics: unavailable",
    "",
    "D. CURRENT SYSTEM PERFORMANCE",
    counterfactual.ok
      ? `- Closed=${counterfactual.value.baseline.closedCount} | netAvgR=${fmtNum(counterfactual.value.baseline.netAvgR)} | PF=${fmtNum(counterfactual.value.baseline.profitFactor, 2)}`
      : `- Unavailable: ${counterfactual.error}`,
    counterfactual.ok
      ? `- TP1 profitable=${fmtPct(counterfactual.value.baseline.tp1ProfitableRate)} | SL=${fmtPct(counterfactual.value.baseline.slRate)} | status=${regimeDrift.ok ? regimeDrift.value.overallStatus : "n/a"}`
      : "- Status: unavailable",
    "",
    "E. PROFIT ANATOMY",
    profitAnatomy.ok
      ? `- Main diagnosis: ${profitAnatomy.value.summary.mainDiagnosis}`
      : `- Unavailable: ${profitAnatomy.error}`,
    profitAnatomy.ok
      ? `- Avg win R=${fmtNum(profitAnatomy.value.summary.avgWinR)} | avg loss R=${fmtNum(profitAnatomy.value.summary.avgLossR)} | expectancy gap=${fmtNum(profitAnatomy.value.summary.expectancyGap)}`
      : "- Metrics: unavailable",
    profitAnatomy.ok
      ? `- Strongest flag: ${topLeakFlag ?? "none"}`
      : "- Strongest flag: unavailable",
    "",
    "F. STOP GEOMETRY / RR",
    stopGeometry.ok
      ? `- Main diagnosis: ${stopGeometry.value.summary.mainDiagnosis}`
      : `- Unavailable: ${stopGeometry.error}`,
    stopGeometry.ok
      ? `- Strongest toxic bucket: ${toxicStopBucket ? `${toxicStopBucket.bucket} (netAvgR=${fmtNum(toxicStopBucket.netAvgR)}, SL=${fmtPct(toxicStopBucket.slRate)})` : "none"}`
      : "- Strongest toxic bucket: unavailable",
    stopGeometry.ok
      ? `- Best counterfactual: ${bestStopCounterfactual ? `${bestStopCounterfactual.label} (${bestStopCounterfactual.interpretation}, delta ${fmtNum(bestStopCounterfactual.deltaNetAvgRVsBaseline)})` : "none"}`
      : "- Counterfactual: unavailable",
    stopGeometry.ok
      ? `- Ultra-tight stop bucket remains historically toxic: ${stopGeometry.value.stopBuckets.some((bucket) => bucket.bucket === "ULTRA_TIGHT" && bucket.closedCount > 0 && (bucket.netAvgR ?? 0) < 0)}`
      : "- Ultra-tight stop toxicity: unavailable",
    "",
    "F*. BASE ROUTE RISK HYGIENE MONITOR (REPORT-ONLY)",
    opts.baseRouteRiskHygieneMonitor
      ? `- Active guard: stopDistanceBps < ${opts.baseRouteRiskHygieneMonitor.guardThresholdBps} | version=base-route-risk-hygiene-stop175-v1`
      : "- Unavailable: risk hygiene monitor not supplied",
    opts.baseRouteRiskHygieneMonitor
      ? `- Guard skips: total=${opts.baseRouteRiskHygieneMonitor.skippedUltraTightCandidates.total} | recent24h=${opts.baseRouteRiskHygieneMonitor.skippedUltraTightCandidates.recent24h}`
      : "- Guard skips: unavailable",
    opts.baseRouteRiskHygieneMonitor
      ? `- Current-guard tape: closed=${opts.baseRouteRiskHygieneMonitor.postGuardTape.closedN} | open=${opts.baseRouteRiskHygieneMonitor.postGuardTape.openN} | avgCostR=${fmtNum(opts.baseRouteRiskHygieneMonitor.postGuardTape.avgCostR)} | grossAvgR=${fmtNum(opts.baseRouteRiskHygieneMonitor.postGuardTape.grossAvgR)} | netAvgR=${fmtNum(opts.baseRouteRiskHygieneMonitor.postGuardTape.netAvgR)}`
      : "- Current-guard tape: unavailable",
    opts.baseRouteRiskHygieneMonitor
      ? `- Current-guard residue: <175bps closed=${opts.baseRouteRiskHygieneMonitor.postGuardTape.below175ClosedN} | <100bps closed=${opts.baseRouteRiskHygieneMonitor.postGuardTape.below100ClosedN}`
      : "- Current-guard residue: unavailable",
    opts.baseRouteRiskHygieneMonitor
      ? `- Previous hygiene tape: closed=${opts.baseRouteRiskHygieneMonitor.previousHygieneTape.closedN} | <175bps closed=${opts.baseRouteRiskHygieneMonitor.previousHygieneTape.below175ClosedN} | netAvgR=${fmtNum(opts.baseRouteRiskHygieneMonitor.previousHygieneTape.netAvgR)}`
      : "- Previous hygiene tape: unavailable",
    opts.baseRouteRiskHygieneMonitor
      ? `- Verdict: ${opts.baseRouteRiskHygieneMonitor.verdict}`
      : "- Verdict: unavailable",
    opts.baseRouteRiskHygieneMonitor
      ? "- (report-only, no behavior influence)"
      : null,
    "",
    "F**. BASE ROUTE CURRENT-GUARD STABILITY AUDIT (REPORT-ONLY)",
    ...(() => {
      const sr = opts.baseRouteRiskHygieneMonitor?.stabilityReport;
      if (!sr) return ["  Unavailable: stability report not supplied"];
      const out: string[] = [];
      const fmtSeg = (s: { n: number; netAvgR: number | null; pf?: number | null } | null): string =>
        s ? `n=${s.n} net=${fmtNum(s.netAvgR)}${s.pf !== undefined ? ` PF=${s.pf === null ? "n/a" : s.pf.toFixed(2)}` : ""}` : "n/a";
      out.push(`  Lane: ${sr.laneId}`);
      out.push(
        `  closed=${sr.closed} | open=${sr.open} | netAvgR=${fmtNum(sr.netAvgR)} | PF=${sr.pf === null ? "n/a" : sr.pf.toFixed(2)} | WR=${sr.wr === null ? "n/a" : (sr.wr * 100).toFixed(1) + "%"} | grossAvgR=${fmtNum(sr.grossAvgR)} | avgCostR=${fmtNum(sr.avgCostR)}`,
      );
      out.push("  Temporal stability:");
      out.push(`    Early half: ${fmtSeg(sr.earlyHalf)}`);
      out.push(`    Late half:  ${fmtSeg(sr.lateHalf)}`);
      out.push(`    Last 10:    ${fmtSeg(sr.last10)}`);
      out.push(`    Last 20:    ${fmtSeg(sr.last20)}`);
      out.push(`    Last 30:    ${fmtSeg(sr.last30)}`);
      out.push("  OOS segments (time-ordered thirds):");
      if (sr.oosSegments) {
        sr.oosSegments.forEach((s, i) => out.push(`    Segment ${i + 1}: ${fmtSeg(s)}`));
        out.push(`    All three positive: ${sr.allThreeSegmentsPositive ? "YES" : "NO"}`);
      } else {
        out.push("    (insufficient sample for 3 segments)");
      }
      out.push(
        `  By regime: ${sr.byRegime.length === 0 ? "none" : sr.byRegime.map((r) => `${r.key} n=${r.n} net=${fmtNum(r.netAvgR)}`).join(" | ")}`,
      );
      out.push(
        `  By symbol (top 5): ${sr.bySymbol.length === 0 ? "none" : sr.bySymbol.slice(0, 5).map((r) => `${r.key} n=${r.n} net=${fmtNum(r.netAvgR)} share=${(r.pnlShare * 100).toFixed(1)}%`).join(" | ")}`,
      );
      out.push(
        `  Top symbol PnL share: ${(sr.topSymbolPnlShare * 100).toFixed(1)}%${sr.topSymbolPnlShare > 0.4 ? "  [WARNING: >40%]" : ""}`,
      );
      out.push(
        `  By direction: ${sr.byDirection.length === 0 ? "none" : sr.byDirection.map((r) => `${r.key} n=${r.n} net=${fmtNum(r.netAvgR)}`).join(" | ")}`,
      );
      out.push(
        `  By entry variant: ${sr.byEntryVariant.length === 0 ? "none" : sr.byEntryVariant.map((r) => `${r.key} n=${r.n} net=${fmtNum(r.netAvgR)}`).join(" | ")}`,
      );
      out.push(
        `  By policy version: ${sr.byPolicyVersion.length === 0 ? "none" : sr.byPolicyVersion.map((r) => `${r.key} n=${r.n} net=${fmtNum(r.netAvgR)}`).join(" | ")}`,
      );
      out.push(
        `  Max adverse streak: ${sr.maxAdverseStreak ?? "n/a"} | Approx max drawdown: ${fmtNum(sr.approxMaxDrawdownR)} R`,
      );
      out.push("  Cost sensitivity:");
      for (const row of sr.costSensitivity) {
        out.push(
          `    ${row.scenario}: net=${fmtNum(row.netAvgR)} PF=${row.pf === null ? "n/a" : row.pf.toFixed(2)} [${row.stillPositive ? "positive" : "negative"}]`,
        );
      }
      out.push(`  VERDICT: ${sr.verdict}`);
      out.push(`  Reasons: ${sr.verdictReasons.length === 0 ? "none" : sr.verdictReasons.join("; ")}`);
      out.push(`  Cautions: ${sr.cautions.length === 0 ? "none" : sr.cautions.join("; ")}`);
      out.push("  (report-only, no behavior influence)");
      return out;
    })(),
    "",
    "F***. BASE ROUTE CURRENT-GUARD FROZEN PROSPECTIVE TAPE (REPORT-ONLY)",
    ...(() => {
      const fr = opts.frozenCurrentGuardReport;
      if (!fr) return ["  Unavailable: frozen prospective tape report not supplied"];
      const out: string[] = [];
      out.push(`  Lane: ${fr.laneVersion}`);
      out.push(`  Criteria frozen at: ${fr.criteriaFrozenAt ?? "n/a"}`);
      out.push(
        `  total=${fr.total} | open=${fr.open} | resolved=${fr.resolved} | freshValid=${fr.freshValid}`,
      );
      out.push(
        `  netAvgR=${fmtNum(fr.netAvgR)} | PF=${fr.pf === null ? "n/a" : fr.pf.toFixed(2)} | WR=${fr.wr === null ? "n/a" : (fr.wr * 100).toFixed(1) + "%"} | daysCovered=${fr.daysCovered}`,
      );
      if (fr.oosSegments) {
        out.push(
          `  OOS segments: seg1 net=${fmtNum(fr.oosSegments[0].netAvgR)} | seg2 net=${fmtNum(fr.oosSegments[1].netAvgR)} | seg3 net=${fmtNum(fr.oosSegments[2].netAvgR)} | allPositive=${fr.allThreeSegmentsPositive ? "YES" : "NO"}`,
        );
      } else {
        out.push("  OOS segments: (insufficient sample for 3 segments)");
      }
      const csDefault = fr.costSensitivity.find((r) => r.scenario === "default");
      const cs5 = fr.costSensitivity.find((r) => r.scenario === "plus_5bps_slippage");
      const cs10 = fr.costSensitivity.find((r) => r.scenario === "plus_10bps_slippage");
      out.push(
        `  Cost sensitivity: default net=${fmtNum(csDefault?.netAvgR ?? null)} | +5bps net=${fmtNum(cs5?.netAvgR ?? null)} | +10bps net=${fmtNum(cs10?.netAvgR ?? null)}`,
      );

      // ── Realistic cost model (from AC microstructure) ──────────────────────
      const cm = opts.frozenCostModelReport;
      if (cm) {
        out.push("  Realistic cost model (from AC microstructure):");
        const fmtPf = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
        const fmtWrPct = (v: number | null) =>
          v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
        for (const s of cm.scenarios) {
          out.push(
            `    ${s.scenario} (${s.roundTripBps.toFixed(1)}bps): net=${fmtNum(s.netAvgR)} PF=${fmtPf(s.pf)} WR=${fmtWrPct(s.wr)} [${s.pass ? "pass" : "FAIL"}]`,
          );
        }
        out.push(
          `    Worst passing scenario: ${cm.worstPassingScenario ?? "none"} | First failing: ${cm.firstFailingScenario ?? "none"}`,
        );
        out.push(`    Model populated: ${cm.modelPopulated ? "YES" : "NO"}`);
      } else {
        out.push("  Realistic cost model: (not supplied — flat assumption only)");
      }

      // ── Velocity / ETA ─────────────────────────────────────────────────────
      const v = fr.velocity;
      const fmtDays = (d: number | null) =>
        d === null ? "n/a" : `${d.toFixed(1)} days`;
      out.push("  Velocity / ETA:");
      out.push(
        `    resolved/day=${fmtNum(v.resolvedPerDay)} | freshValid/day=${fmtNum(v.freshValidPerDay)}`,
      );
      out.push(
        `    ETA to n=100: ${fmtDays(v.etaToN100Days)}${v.etaToN100Date ? ` (~${v.etaToN100Date})` : ""}`,
      );
      out.push(
        `    ETA to n=200: ${fmtDays(v.etaToN200Days)}${v.etaToN200Date ? ` (~${v.etaToN200Date})` : ""}`,
      );

      // ── OOS stability watch ────────────────────────────────────────────────
      const w = fr.oosWatch;
      out.push("  OOS stability watch:");
      const fmtSegLine = (label: string, s: typeof w.segment1) => {
        if (!s) return `    ${label}: (insufficient sample)`;
        const pf = s.pf === null ? "n/a" : s.pf.toFixed(2);
        return `    ${label}: n=${s.n} net=${fmtNum(s.netAvgR)} PF=${pf}`;
      };
      out.push(fmtSegLine("Segment 1", w.segment1));
      out.push(fmtSegLine("Segment 2", w.segment2));
      out.push(fmtSegLine("Segment 3", w.segment3));
      out.push(
        `    Positive segments: ${w.positiveSegmentCount}/3 | Weakest: ${w.weakestSegment?.label ?? "n/a"}`,
      );
      out.push(
        `    Stability: ${w.stabilityStatus}${w.stabilityStatus === "STABILITY_BLOCKED" ? ` (need all 3 positive; ${w.requiredFuturePositiveSegments} more required)` : ""}`,
      );

      // ── OOS Segment Forensics ──────────────────────────────────────────────
      const forensics = fr.oosSegmentForensics;
      if (forensics) {
        out.push("  OOS Segment Forensics:");
        for (const seg of forensics) {
          const netStr =
            seg.netAvgR !== null
              ? `${seg.netAvgR >= 0 ? "+" : ""}${seg.netAvgR.toFixed(4)}`
              : "n/a";
          const costStr =
            seg.avgCostR !== null ? `${seg.avgCostR.toFixed(4)}` : "n/a";
          out.push(
            `    [${seg.segmentLabel}] n=${seg.n} netAvgR=${netStr} avgCostR=${costStr}`,
          );

          // helper to render a breakdown table
          const renderRows = (header: string, rows: ForensicsRow[]) => {
            out.push(`      ${header}:`);
            if (rows.length === 0) {
              out.push("        (no data)");
              return;
            }
            for (const r of rows) {
              const net =
                r.netAvgR !== null
                  ? `${r.netAvgR >= 0 ? "+" : ""}${r.netAvgR.toFixed(4)}`
                  : "n/a";
              const pf = r.pf !== null ? r.pf.toFixed(2) : "n/a";
              const wr = r.wr !== null ? `${(r.wr * 100).toFixed(0)}%` : "n/a";
              const share =
                r.pnlSharePct !== null
                  ? ` [${(r.pnlSharePct * 100).toFixed(1)}% PnL share]`
                  : "";
              out.push(
                `        ${r.key}: n=${r.n} net=${net} PF=${pf} WR=${wr}${share}`,
              );
            }
          };

          renderRows("By Symbol", seg.bySymbol);
          renderRows("By Entry Variant", seg.byEntryVariant);
          renderRows("By Regime", seg.byRegime);
          renderRows("By Stop Bucket", seg.byStopBucket);

          // losing trades list
          if (seg.losingTrades.length > 0) {
            out.push(
              `      Losing trades (${seg.losingTrades.length}${seg.losingTrades.length === 30 ? ", capped at 30" : ""}):`,
            );
            for (const t of seg.losingTrades) {
              const entry = t.entryVariant ?? "?";
              const regime = t.regime ?? "?";
              const stop =
                t.stopDistanceBps !== null ? `stop=${t.stopDistanceBps}bps` : "";
              const parts = [
                `${t.symbol}`,
                `net=${t.netR >= 0 ? "+" : ""}${t.netR.toFixed(4)}`,
                `gross=${t.grossR >= 0 ? "+" : ""}${t.grossR.toFixed(4)}`,
                `entry=${entry}`,
                `regime=${regime}`,
                stop,
                `opened=${t.openedAt.slice(0, 10)}`,
              ].filter(Boolean);
              out.push(`        - ${parts.join(" | ")}`);
            }
          } else {
            out.push("      Losing trades: (none in this segment)");
          }

          // top loss contributors (only if different from full list)
          if (seg.topLossContributors.length > 0 && seg.losingTrades.length > 5) {
            out.push(
              `      Top loss contributors (worst ${seg.topLossContributors.length}):`,
            );
            for (const t of seg.topLossContributors) {
              out.push(
                `        - ${t.symbol} net=${t.netR.toFixed(4)} entry=${t.entryVariant ?? "?"} regime=${t.regime ?? "?"}`,
              );
            }
          }
        }
      }

      out.push(`  Status: ${fr.status}`);
      out.push(`  Reason: ${fr.statusReason}`);
      out.push("  Note: prospective forward-test; criteria frozen; report-only");
      return out;
    })(),
    "",
    "F****. FROZEN CURRENT-GUARD PROMOTION TRACKER (REPORT-ONLY)",
    ...(() => {
      const r = frozenPromotionTrackerReport;
      if (!r) return ["  [unavailable]"];
      const out: string[] = [];
      const fmtR = (v: number | null) =>
        typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(4)}` : "n/a";
      const fmtPF = (v: number | null) =>
        typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "n/a";
      const fmtPct2 = (v: number | null) =>
        typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "n/a";
      const fmtDays = (v: number | null) =>
        typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)} days` : "n/a";
      out.push(`  Lane: ${r.laneId}`);
      out.push(`  Status: ${r.status} (${r.statusReason})`);
      out.push(`  freshValid=${r.freshValid}`);
      out.push(
        `  Velocity: resolved/day=${typeof r.resolvedPerDay === "number" ? r.resolvedPerDay.toFixed(2) : "n/a"} | freshValid/day=${typeof r.freshValidPerDay === "number" ? r.freshValidPerDay.toFixed(2) : "n/a"}`,
      );
      out.push(
        `  ETA to n=100: ${fmtDays(r.etaToN100Days)}${r.etaToN100Date ? ` (~${r.etaToN100Date})` : ""}`,
      );
      out.push(
        `  ETA to n=200: ${fmtDays(r.etaToN200Days)}${r.etaToN200Date ? ` (~${r.etaToN200Date})` : ""}`,
      );
      out.push("  Rolling windows:");
      if (r.rolling.length === 0) out.push("    (none)");
      else
        for (const w of r.rolling)
          out.push(
            `    ${w.window}: n=${w.n} net=${fmtR(w.netAvgR)} PF=${fmtPF(w.pf)} WR=${fmtPct2(w.wr)}`,
          );
      out.push(
        `  OOS segments all positive: ${r.oosSegmentsAllPositive ? "YES" : "NO"} (${r.positiveSegmentCount}/3)${r.weakestSegment ? ` | weakest: ${r.weakestSegment.label} (${fmtR(r.weakestSegment.netAvgR)})` : ""}`,
      );
      out.push(
        `  Drawdown: ${fmtR(r.approxMaxDrawdownR)}R | Max adverse streak: ${r.maxAdverseStreak ?? "n/a"}`,
      );
      out.push(
        `  +10bps still positive: ${r.plus10bpsStillPositive ? "YES" : "NO"} | top symbol PnL share: ${fmtPct2(r.topSymbolPnlShare)}`,
      );
      out.push("  Promotion blockers:");
      if (r.promotionBlockers.length === 0) out.push("    (none)");
      else for (const b of r.promotionBlockers) out.push(`    - ${b}`);
      if (r.killWarning) out.push(`  ⚠ KILL WARNING: ${r.killWarning}`);
      out.push("  report-only, advisory; no behavior influence");
      return out;
    })(),
    "",
    "F*****. FROZEN CURRENT-GUARD SEGMENT PATHOLOGY AUDIT (REPORT-ONLY)",
    ...(() => {
      const pa = frozenSegmentPathologyAudit;
      if (!pa) return ["  [unavailable — frozen tape not supplied or <3 observations]"];
      const out: string[] = [];

      const fmtN = (n: number | null | undefined) =>
        n === null || n === undefined ? "n/a" : String(n);
      const fmtR2 = (v: number | null | undefined) => {
        if (v === null || v === undefined || !Number.isFinite(v as number)) return "n/a";
        return `${(v as number) >= 0 ? "+" : ""}${(v as number).toFixed(4)}`;
      };
      const fmtPf = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number) ? "n/a" : (v as number).toFixed(2);
      const fmtWr = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number)
          ? "n/a"
          : `${((v as number) * 100).toFixed(0)}%`;

      out.push(
        `  Verdict: ${pa.verdict} — ${pa.verdictReason}`,
      );
      out.push(
        `  Total observations fed: ${pa.totalN} | Seg-1 n=${pa.seg1N} ` +
        `net=${fmtR2(pa.seg1Stats.netAvgR)} PF=${fmtPf(pa.seg1Stats.pf)} WR=${fmtWr(pa.seg1Stats.wr)}`,
      );

      // Analysis 1: without top-4
      const a1 = pa.withoutTop4;
      out.push("");
      out.push(`  [1] ${a1.label}`);
      out.push(`      ${a1.description}`);
      out.push(
        `      Excluded ${a1.excludedCount ?? 0} trades → remaining n=${a1.stats.n} ` +
        `net=${fmtR2(a1.stats.netAvgR)} PF=${fmtPf(a1.stats.pf)} WR=${fmtWr(a1.stats.wr)}`,
      );
      out.push(`      → ${a1.note}`);
      if (a1.excludedTrades && a1.excludedTrades.length > 0) {
        out.push(`      Excluded trades (top-4 losses):`);
        for (const t of a1.excludedTrades) {
          out.push(
            `        - ${t.symbol} net=${fmtR2(t.netR)} entry=${t.entryVariant ?? "?"} regime=${t.regime ?? "?"} opened=${t.openedAt.slice(0, 10)}`,
          );
        }
      }

      // Analysis 2: excl bad actors
      const a2 = pa.excludingBadActors;
      out.push("");
      out.push(`  [2] ${a2.label}`);
      out.push(`      ${a2.description}`);
      out.push(
        `      Excluded ${a2.excludedCount ?? 0} trades (SEI/LINK/OP) → remaining n=${a2.stats.n} ` +
        `net=${fmtR2(a2.stats.netAvgR)} PF=${fmtPf(a2.stats.pf)} WR=${fmtWr(a2.stats.wr)}`,
      );
      out.push(`      → ${a2.note}`);
      if (a2.excludedTrades && a2.excludedTrades.length > 0) {
        out.push(`      Bad-actor trades:`);
        for (const t of a2.excludedTrades) {
          out.push(
            `        - ${t.symbol} net=${fmtR2(t.netR)} entry=${t.entryVariant ?? "?"} regime=${t.regime ?? "?"} opened=${t.openedAt.slice(0, 10)}`,
          );
        }
      }

      // Analysis 3: date batches
      out.push("");
      out.push("  [3] Segment 1 by date batch");
      if (pa.seg1ByDateBatch.length === 0) {
        out.push("      (no data)");
      } else {
        for (const b of pa.seg1ByDateBatch) {
          const range = b.dateRange
            ? `${b.dateRange.from} → ${b.dateRange.to}`
            : "n/a";
          out.push(
            `      ${b.batchLabel} [${range}]: n=${fmtN(b.n)} net=${fmtR2(b.netAvgR)} WR=${fmtWr(b.wr)}`,
          );
        }
        const negBatches = pa.seg1ByDateBatch.filter(
          (b) => b.netAvgR !== null && b.netAvgR < 0,
        );
        if (pa.seg1ByDateBatch.length >= 2 && negBatches.length === 1 && negBatches[0]!.n >= 2) {
          out.push(
            `      → Losses concentrated in 1 batch (${negBatches[0]!.batchLabel}, n=${negBatches[0]!.n}) — temporal concentration signal`,
          );
        } else if (negBatches.length === pa.seg1ByDateBatch.length) {
          out.push("      → All batches negative — persistent drag across the segment");
        } else {
          out.push(
            `      → ${negBatches.length}/${pa.seg1ByDateBatch.length} batches negative`,
          );
        }
      }

      // Analysis 4: fib_500 comparison
      const a4 = pa.fib500Comparison;
      out.push("");
      out.push("  [4] fib_500 entry: Seg-1 vs Post-seg-1");
      out.push(
        `      Seg-1 fib_500: n=${a4.seg1.n} net=${fmtR2(a4.seg1.netAvgR)} PF=${fmtPf(a4.seg1.pf)} WR=${fmtWr(a4.seg1.wr)}`,
      );
      out.push(
        `      Post-seg-1 fib_500: n=${a4.postSeg1.n} net=${fmtR2(a4.postSeg1.netAvgR)} PF=${fmtPf(a4.postSeg1.pf)} WR=${fmtWr(a4.postSeg1.wr)}`,
      );
      out.push(`      Signal: ${a4.signal} — ${a4.signalNote}`);

      // Analysis 5: post-seg-1
      const a5 = pa.postSeg1Tape;
      out.push("");
      out.push(`  [5] ${a5.label}`);
      out.push(
        `      n=${a5.stats.n} net=${fmtR2(a5.stats.netAvgR)} PF=${fmtPf(a5.stats.pf)} WR=${fmtWr(a5.stats.wr)}`,
      );
      out.push(`      → ${a5.note}`);

      // Analysis 6: entry mix transition
      const a6 = pa.entryMixTransition;
      out.push("");
      out.push("  [6] Entry-mix transition");
      const fmtMix = (rows: typeof a6.seg1Mix) =>
        rows
          .slice(0, 5)
          .map((r) => `${r.entryVariant}=${r.sharePct.toFixed(0)}%`)
          .join(" | ") || "(none)";
      out.push(
        `      Seg-1 entry mix: ${fmtMix(a6.seg1Mix)}`,
      );
      out.push(
        `      Post-seg-1 mix: ${fmtMix(a6.postSeg1Mix)}`,
      );
      if (a6.fib500ShareSeg1 !== null) {
        out.push(
          `      fib_500 share: seg-1=${(a6.fib500ShareSeg1 * 100).toFixed(0)}% → post-seg-1=${a6.fib500SharePostSeg1 !== null ? (a6.fib500SharePostSeg1 * 100).toFixed(0) + "%" : "n/a"} (mix drifted: ${a6.mixDrifted ? "YES >15pp" : "no"})`,
        );
      }
      out.push(
        `      fib_500 cohort (full tape): n=${a6.fib500CohortStats.n} net=${fmtR2(a6.fib500CohortStats.netAvgR)} PF=${fmtPf(a6.fib500CohortStats.pf)} WR=${fmtWr(a6.fib500CohortStats.wr)}`,
      );
      out.push(
        `      Other entries (full tape):  n=${a6.diversifiedCohortStats.n} net=${fmtR2(a6.diversifiedCohortStats.netAvgR)} PF=${fmtPf(a6.diversifiedCohortStats.pf)} WR=${fmtWr(a6.diversifiedCohortStats.wr)}`,
      );
      out.push(`      → ${a6.note}`);

      out.push("");
      out.push(`  Note: report-only diagnostic; no behavior influence`);
      return out;
    })(),
    "",
    "F******. FROZEN CURRENT-GUARD POST-CUTOVER TAPE (REPORT-ONLY)",
    ...(() => {
      const r = opts.postCutoverReport;
      if (!r) return ["  [unavailable — frozen tape not supplied or pathology audit not run]"];
      const out: string[] = [];

      const fmtR2 = (v: number | null | undefined) => {
        if (v === null || v === undefined || !Number.isFinite(v as number)) return "n/a";
        return `${(v as number) >= 0 ? "+" : ""}${(v as number).toFixed(4)}`;
      };
      const fmtPf = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number) ? "n/a" : (v as number).toFixed(2);
      const fmtWr = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number)
          ? "n/a"
          : `${((v as number) * 100).toFixed(0)}%`;
      const fmtPctShare = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number)
          ? "n/a"
          : `${((v as number) * 100).toFixed(1)}%`;
      const fmtDays = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number) ? "n/a" : (v as number).toFixed(1);

      out.push(`  Lane: ${r.laneId}`);
      if (r.boundary) {
        out.push(
          `  Cutover (immutable): ${r.boundary.cutoverTimestamp} — "${r.boundary.reason}" ` +
          `[verdict=${r.boundary.derivedFrom.pathologyVerdict}, seg1N=${r.boundary.derivedFrom.seg1NAtLock} of ${r.boundary.derivedFrom.freshValidAtLock} at lock]`,
        );
      } else {
        out.push(`  Cutover: NOT LOCKED (awaiting OLD_BATCH verdict + sufficient frozen sample)`);
      }
      out.push(`  Status: ${r.status} — ${r.statusReason}`);
      out.push(
        `  Sample (post-cutover only): total=${r.total} open=${r.open} resolved=${r.resolved} freshValid=${r.freshValid}`,
      );
      out.push(
        `  net=${fmtR2(r.netAvgR)} PF=${fmtPf(r.pf)} WR=${fmtWr(r.wr)} | daysCovered=${r.daysCovered}`,
      );

      // OOS thirds within the post-cutover tape
      if (r.oosSegments) {
        out.push("  Post-cutover OOS thirds:");
        for (const s of r.oosSegments) {
          out.push(
            `    ${s.label}: n=${s.n} net=${fmtR2(s.netAvgR)} PF=${fmtPf(s.pf)} WR=${fmtWr(s.wr)}`,
          );
        }
        out.push(`    All three positive: ${r.allThreeSegmentsPositive ? "YES" : "NO"}`);
      } else {
        out.push("  Post-cutover OOS thirds: (insufficient sample, need n≥3)");
      }

      // rolling windows
      out.push("  Rolling windows:");
      for (const w of r.rolling) {
        out.push(
          `    ${w.window}: n=${w.n} net=${fmtR2(w.netAvgR)} PF=${fmtPf(w.pf)} WR=${fmtWr(w.wr)}`,
        );
      }

      // cost stress
      out.push(`  +10bps still positive: ${r.plus10bpsStillPositive ? "YES" : "NO"}`);
      if (r.realisticCostModel) {
        const cm = r.realisticCostModel;
        out.push(
          `  Realistic cost model (AC microstructure): populated=${cm.modelPopulated ? "YES" : "NO"} | ` +
          `worst passing=${cm.worstPassingScenario ?? "none"} | first failing=${cm.firstFailingScenario ?? "none"}`,
        );
      }
      out.push("  Cost sensitivity:");
      for (const cs of r.costSensitivity) {
        out.push(
          `    ${cs.scenario} (+${cs.roundTripBps}bps): net=${fmtR2(cs.netAvgR)} PF=${fmtPf(cs.pf)} ${cs.stillPositive ? "✓" : "✗"}`,
        );
      }

      // concentration / drawdown
      out.push(
        `  Top symbol PnL share: ${fmtPctShare(r.topSymbolPnlShare)} | ` +
        `approx max drawdown: ${r.approxMaxDrawdownR === null ? "n/a" : r.approxMaxDrawdownR.toFixed(2) + "R"} | ` +
        `max adverse streak: ${r.maxAdverseStreak ?? "n/a"}`,
      );

      // breakdowns (worst-first, top 5 each)
      const renderRows = (label: string, rows: typeof r.bySymbol) => {
        out.push(`  ${label} (worst-first, top 5):`);
        if (rows.length === 0) {
          out.push("    (none)");
          return;
        }
        for (const row of rows.slice(0, 5)) {
          out.push(
            `    ${row.key}: n=${row.n} net=${fmtR2(row.netAvgR)} PF=${fmtPf(row.pf)} WR=${fmtWr(row.wr)} pnlShare=${fmtPctShare(row.pnlSharePct)}`,
          );
        }
      };
      renderRows("By symbol", r.bySymbol);
      renderRows("By entry variant", r.byEntryVariant);
      renderRows("By regime", r.byRegime);

      // velocity / ETA
      out.push(
        `  Velocity: resolved/day=${fmtDays(r.resolvedPerDay)} freshValid/day=${fmtDays(r.freshValidPerDay)} | ` +
        `ETA n=100: ${fmtDays(r.etaToN100Days)}d (${r.etaToN100Date ?? "n/a"}) | ` +
        `ETA n=200: ${fmtDays(r.etaToN200Days)}d (${r.etaToN200Date ?? "n/a"})`,
      );

      // blockers
      out.push("  Promotion blockers:");
      if (r.blockers.length === 0) out.push("    (none)");
      else for (const b of r.blockers) out.push(`    - ${b}`);

      out.push("  Note: report-only forward-validation tape; Segment 1 NOT deleted; liveBlocked stays true");
      return out;
    })(),
    "",
    "F*******. CURRENT-GUARD VARIANT MATRIX (REPORT-ONLY)",
    ...(() => {
      const vm = opts.currentGuardVariantMatrixReport;
      if (!vm) return ["  [unavailable — variant matrix not supplied]"];
      const out: string[] = [];

      const fmtR4 = (v: number | null | undefined) => {
        if (v === null || v === undefined || !Number.isFinite(v as number)) return "n/a";
        return `${(v as number) >= 0 ? "+" : ""}${(v as number).toFixed(4)}`;
      };
      const fmtPf = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number) ? "n/a" : (v as number).toFixed(2);
      const fmtWr = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number)
          ? "n/a"
          : `${((v as number) * 100).toFixed(1)}%`;
      const fmtShare = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v as number)
          ? "n/a"
          : `${((v as number) * 100).toFixed(1)}%`;
      const fmtNum = (v: number | null | undefined, dp = 1) =>
        v === null || v === undefined || !Number.isFinite(v as number) ? "n/a" : (v as number).toFixed(dp);

      out.push(`  Lane: ${vm.laneVersion} | policy=${vm.policyVersion} | variants=${vm.variantCount}`);
      out.push(`  Population: ${vm.sourcePopulationNote}`);
      out.push(
        `  Cutover scope: ${vm.cutoverTimestamp ?? "NOT LOCKED (full qualifying population)"} | totalObservations=${vm.totalObservations} | baseline=${vm.baselineVariantId}`,
      );
      out.push(
        `  Best watchable candidate: ${vm.bestVariantId ?? "none"}` +
          (vm.bestVariantId
            ? ` (net=${fmtR4(vm.bestVariantNetAvgR)}, beatsBaseline=${vm.bestBeatsBaseline ? "YES" : "NO"})`
            : ""),
      );
      out.push(
        `  liveBlocked=${vm.liveBlocked ? "TRUE" : "false"} | microPilotAllowed=${vm.microPilotAllowed ? "true" : "FALSE"} (always blocked here)`,
      );

      const renderBreakdown = (label: string, rows: CurrentGuardVariantMatrixRow["byRegime"]) => {
        if (rows.length === 0) {
          out.push(`      ${label}: (none)`);
          return;
        }
        out.push(
          `      ${label}: ` +
            rows
              .slice(0, 5)
              .map((b) => `${b.key}(n=${b.n}, net=${fmtR4(b.netAvgR)})`)
              .join(", "),
        );
      };

      for (const row of vm.rows) {
        const baselineMark = row.variantId === vm.baselineVariantId ? " [baseline]" : "";
        out.push(
          `  ${row.variantId}${baselineMark} — ${row.label} (exit=${row.exitRule}, fill=${row.fillMode}, cost=${row.costModel})`,
        );
        out.push(
          `      sample: total=${row.total} open=${row.open} resolved=${row.resolved} freshValid=${row.freshValid} ` +
            `rejected=${row.rejected} noFill=${row.noFill} expired=${row.expired} dataFail=${row.dataFailure}`,
        );
        out.push(
          `      edge: net=${fmtR4(row.netAvgR)} gross=${fmtR4(row.grossAvgR)} PF=${fmtPf(row.pf)} WR=${fmtWr(row.wr)}`,
        );
        out.push(
          `      payoff anatomy: avgWin=${fmtR4(row.avgWinR)} avgLoss=${fmtR4(row.avgLossR)} payoff=${fmtNum(row.payoffRatio, 2)} ` +
            `breakEvenWR=${fmtWr(row.breakEvenWR)} actualWR=${fmtWr(row.actualWR)}`,
        );
        out.push(
          `      cost: avgCostR=${fmtR4(row.avgCostR)} drag=${fmtR4(row.costDragR)} | noFillRate=${fmtShare(row.noFillRate)} expiredRate=${fmtShare(row.expiredRate)}`,
        );
        out.push(
          `      stress(+10bps): net=${fmtR4(row.plus10bpsNetAvgR)} stillPositive=${row.plus10bpsStillPositive ? "YES" : "NO"}`,
        );
        out.push(
          `      holding=${fmtNum(row.avgHoldingMinutes, 0)}min | maxDrawdown=${row.approxMaxDrawdownR === null ? "n/a" : row.approxMaxDrawdownR.toFixed(2) + "R"} ` +
            `| maxAdverseStreak=${row.maxAdverseStreak ?? "n/a"} | topSymbolPnlShare=${fmtShare(row.topSymbolPnlShare)}`,
        );
        out.push(
          `      coverage: calendarDays=${fmtNum(row.calendarDays, 1)} distinctRegimes=${row.distinctRegimes}`,
        );
        renderBreakdown("byRegime", row.byRegime);
        renderBreakdown("byEntryVariant", row.byEntryVariant);
        if (row.oosThirds) {
          out.push(
            `      OOS thirds: ` +
              row.oosThirds.map((s) => `${s.label}(n=${s.n}, net=${fmtR4(s.netAvgR)})`).join(", ") +
              ` | allPositive=${row.allThreeOosPositive ? "YES" : "NO"}`,
          );
        } else {
          out.push("      OOS thirds: (insufficient sample)");
        }
        out.push(
          `      rolling: ` +
            row.rolling
              .map((w) => `${w.window}(n=${w.n}, net=${fmtR4(w.netAvgR)}, PF=${fmtPf(w.pf)})`)
              .join(", "),
        );
        out.push(`      status: ${row.status} — ${row.statusReason}`);
        if (row.blockers.length > 0) out.push(`      blockers: ${row.blockers.join("; ")}`);
        if (row.cautions.length > 0) out.push(`      cautions: ${row.cautions.join("; ")}`);
      }

      for (const note of vm.notes) out.push(`  Note: ${note}`);
      out.push("  report-only, isolated; data/current-guard-variant-matrix.json only; data/shadow-positions.json untouched");
      return out;
    })(),
    "",
    "G. WINNER VS LOSER DISCRIMINANT",
    winnerLoser.ok
      ? `- Diagnosis: ${winnerLoser.value.summary.mainDiagnosis}`
      : `- Unavailable: ${winnerLoser.error}`,
    winnerLoser.ok
      ? `- Top winner signals: ${topWinnerSignals.length > 0 ? topWinnerSignals.map((signal) => `${signal.label}: ${signal.pattern}`).join(" | ") : "none"}`
      : "- Winner signals: unavailable",
    winnerLoser.ok
      ? `- Top loser signals: ${topLoserSignals.length > 0 ? topLoserSignals.map((signal) => `${signal.label}: ${signal.pattern}`).join(" | ") : "none"}`
      : "- Loser signals: unavailable",
    "",
    "H. PHASE 2 INTELLIGENCE FOUNDATION",
    foundation.ok
      ? `- Strategy contexts=${foundation.value.metadata.contextSnapshotCount} | resolved experience=${foundation.value.metadata.resolvedExperienceRecordCount}`
      : `- Unavailable: ${foundation.error}`,
    foundation.ok && snapshotProvenance
      ? `- Snapshot provenance: resolved with strategyContext=${snapshotProvenance.resolvedRecordsWithStrategyContext} | inferred legacy resolved=${snapshotProvenance.recordsCreatedBeforePhase2A5} | open newer snapshot positions=${snapshotProvenance.openPositionsWithStrategyContext}`
      : "- Snapshot provenance: unavailable",
    foundation.ok && contextCompleteness
      ? `- Field completeness: trend=${fmtPct(contextCompleteness.trendContextCoverage)} | marketRegime=${fmtPct(contextCompleteness.marketRegimeCoverage)} | MAE/MFE=${fmtPct(contextCompleteness.maeMfeCoverage)} | Kronos=${fmtPct(contextCompleteness.selectedKronosBiasCoverage)} | Whale=${fmtPct(contextCompleteness.whaleAgreementCoverage)} | sentiment/fearGreed=${fmtPct(contextCompleteness.sentimentFearGreedCoverage)}`
      : "- Field completeness: unavailable",
    foundation.ok
      ? `- Ready states: Symbol-Route=${foundation.value.dataReadiness.readyForSymbolRouteEngine}, AdaptiveGate=${foundation.value.dataReadiness.readyForAdaptiveGateController}, TechnicalStopTP=${foundation.value.dataReadiness.readyForTechnicalStopTpEngine}, UniverseRotation=${foundation.value.dataReadiness.readyForUniverseRotation}`
      : "- Ready states: unavailable",
    foundation.ok
      ? `- Major blockers: Symbol-Route=${firstBlockingReason(foundation.value.dataReadiness.symbolRouteEngine.reasonsBlocking) ?? "none"} | AdaptiveGate=${firstBlockingReason(foundation.value.dataReadiness.adaptiveGateController.reasonsBlocking) ?? "none"} | TechnicalStopTP=${firstBlockingReason(foundation.value.dataReadiness.technicalStopTpEngine.reasonsBlocking) ?? "none"} | UniverseRotation=${firstBlockingReason(foundation.value.dataReadiness.universeRotation.reasonsBlocking) ?? "none"}`
      : "- Major blockers: unavailable",
    "",
    "I. SYMBOL-ROUTE SUITABILITY",
    symbolRoute.ok
      ? `- Records analyzed=${symbolRoute.value.metadata.resolvedExperienceRecordCount} | pairs raw>=5=${symbolRoute.value.metadata.pairsWithAtLeast5Closes} eff>=${symbolRoute.value.metadata.pairsWithAtLeast5ClosesEffective} | pairs raw>=15=${symbolRoute.value.metadata.pairsWithAtLeast15Closes} eff>=${symbolRoute.value.metadata.pairsWithAtLeast15ClosesEffective} | pairs raw>=30=${symbolRoute.value.metadata.pairsWithAtLeast30Closes} eff>=${symbolRoute.value.metadata.pairsWithAtLeast30ClosesEffective}`
      : `- Unavailable: ${symbolRoute.error}`,
    symbolRoute.ok
      ? `- Top promising cohort: ${topPromisingSuitability ? (() => {
          const nRaw = topPromisingSuitability.nRaw ?? topPromisingSuitability.closedCount ?? 0;
          const nEffective = topPromisingSuitability.nEffective ?? nRaw;
          const multiplicityRatio = nRaw === 0 ? 1.0 : nEffective / nRaw;
          const signalMultiplicityWarning = topPromisingSuitability.signalMultiplicityWarning ?? false;
          return `${topPromisingSuitability.symbol} ${topPromisingSuitability.direction} ${topPromisingSuitability.routeCombo} (${topPromisingSuitability.localVerdict}, netAvgR=${fmtNum(topPromisingSuitability.netAvgR)}, ${formatMultiplicitySummary({ nRaw, nEffective, multiplicityRatio, signalMultiplicityWarning })})`;
        })() : "none with credible effective evidence yet"}`
      : "- Top promising cohort: unavailable",
    symbolRoute.ok && highestRawReturnFlaggedCohort
      ? `- Highest raw-return cohort (credibility warning: multiplicity): ${highestRawReturnFlaggedCohort.symbol} ${highestRawReturnFlaggedCohort.direction} ${highestRawReturnFlaggedCohort.routeCombo} (${highestRawReturnFlaggedCohort.localVerdict}, netAvgR=${fmtNum(highestRawReturnFlaggedCohort.netAvgR)}, ${formatMultiplicitySummary({ nRaw: highestRawReturnFlaggedCohort.nRaw, nEffective: highestRawReturnFlaggedCohort.nEffective, multiplicityRatio: highestRawReturnFlaggedCohort.multiplicityRatio, signalMultiplicityWarning: highestRawReturnFlaggedCohort.signalMultiplicityWarning })})`
      : null,
    symbolRoute.ok
      ? `- Top toxic cohort: ${topToxicSuitability ? (() => {
          const nRaw = topToxicSuitability.nRaw ?? topToxicSuitability.closedCount ?? 0;
          const nEffective = topToxicSuitability.nEffective ?? nRaw;
          const multiplicityRatio = nRaw === 0 ? 1.0 : nEffective / nRaw;
          const signalMultiplicityWarning = topToxicSuitability.signalMultiplicityWarning ?? false;
          return `${topToxicSuitability.symbol} ${topToxicSuitability.direction} ${topToxicSuitability.routeCombo} (${topToxicSuitability.localVerdict}, netAvgR=${fmtNum(topToxicSuitability.netAvgR)}, ${formatMultiplicitySummary({ nRaw, nEffective, multiplicityRatio, signalMultiplicityWarning })})`;
        })() : "none"}`
      : "- Top toxic cohort: unavailable",
    symbolRoute.ok
      ? (() => {
          const warnCount = (symbolRoute.value.candidateAssessments ?? []).filter((c) => c.signalMultiplicityWarning).length;
          return `- Signal multiplicity warnings: ${warnCount} cohort(s) flagged`;
        })()
      : "- Signal multiplicity warnings: unavailable",
    symbolRoute.ok
      ? `- SYMBOL_SENSITIVE route present: ${symbolSensitive}${symbolSensitiveRoute ? ` (${symbolSensitiveRoute})` : ""}`
      : "- SYMBOL_SENSITIVE route: unavailable",
    "",
    "J. ADAPTIVE GATE INTELLIGENCE",
    adaptiveGate.ok
      ? `- Baseline netAvgR=${fmtNum(adaptiveGate.value.baseline.netAvgR)}`
      : `- Unavailable: ${adaptiveGate.error}`,
    adaptiveGate.ok
      ? `- Top supportive condition: ${topSupportiveGate ? `${topSupportiveGate.conditionLabel} (${topSupportiveGate.localGateSignal}, delta ${fmtNum(topSupportiveGate.performanceDeltaVsBaseline.netAvgR)})` : "none"}`
      : "- Top supportive condition: unavailable",
    adaptiveGate.ok
      ? `- Top harmful condition: ${topHarmfulGate ? `${topHarmfulGate.conditionLabel} (${topHarmfulGate.localGateSignal}, delta ${fmtNum(topHarmfulGate.performanceDeltaVsBaseline.netAvgR)})` : "none"}`
      : "- Top harmful condition: unavailable",
    adaptiveGate.ok
      ? `- Strongest interaction: ${strongestInteraction ? `${strongestInteraction.interactionLabel} (${strongestInteraction.verdict}, delta ${fmtNum(strongestInteraction.deltaVsBaseline.netAvgR)})` : "none"}`
      : "- Strongest interaction: unavailable",
    adaptiveGate.ok
      ? `- Context coverage: marketRegime=${fmtPct(adaptiveGate.value.contextCoverageSummary.marketRegimeCoverage)} | Kronos=${fmtPct(adaptiveGate.value.contextCoverageSummary.kronosAlignmentCoverage)} | Whale=${fmtPct(adaptiveGate.value.contextCoverageSummary.whaleAgreementCoverage)} | horizonConflict=${fmtPct(adaptiveGate.value.contextCoverageSummary.horizonConflictCoverage)} | sentiment/fearGreed=${fmtPct(averageCoverage(adaptiveGate.value.contextCoverageSummary.sentimentCoverage, adaptiveGate.value.contextCoverageSummary.fearGreedCoverage))}`
      : "- Context coverage: unavailable",
    adaptiveGate.ok
      ? `- Ready for gate influence: ${adaptiveGate.value.readiness.readyForGateInfluence}`
      : "- Ready for gate influence: unavailable",
    ...(adaptiveGate.ok && adaptiveGate.value.conditionalAlphaStability
      ? [
          "- Conditional alpha stability:",
          ...adaptiveGate.value.conditionalAlphaStability.entries.map((entry) =>
            `  - ${entry.filterLabel}: ${entry.status} | n=${entry.n} | net=${entry.netAvgR >= 0 ? "+" : ""}${entry.netAvgR.toFixed(4)}R | Δ=${entry.deltaNetAvgR >= 0 ? "+" : ""}${entry.deltaNetAvgR.toFixed(4)}R | early=${entry.earlyHalfNetAvgR >= 0 ? "+" : ""}${entry.earlyHalfNetAvgR.toFixed(3)}R late=${entry.lateHalfNetAvgR >= 0 ? "+" : ""}${entry.lateHalfNetAvgR.toFixed(3)}R | top2-sym signed=${Math.round(entry.top2SignedNetSumShare * 100)}%${entry.top2PositiveNetSumShare !== null ? ` pos=${Math.round(entry.top2PositiveNetSumShare * 100)}%` : ""}`
          ),
        ]
      : []),
    ...(adaptiveGate.ok && adaptiveGate.value.topContributorFingerprint
      ? (() => {
          const tcfp = adaptiveGate.value.topContributorFingerprint!;
          const p = tcfp.profile;
          const lines: string[] = [];
          lines.push("- TopContributorFingerprintV0 (advisory, no behavior influence):");
          lines.push(`  - profile: ${p.status}`);
          lines.push(`  - sample: n=${p.sampleSize} | top-records=${p.topContributorRecordCount} | negative-records=${p.negativeRecordCount}`);
          if (p.status === "READY") {
            const sMax = p.matchThresholds.stopDistanceBpsMax;
            const eMax = p.matchThresholds.entryDriftPctOfZoneMax;
            const aMin = p.matchThresholds.supportingEntryDriftAtrMin;
            const sMin = p.vetoThresholds.stopDistanceBpsMin;
            const eMin = p.vetoThresholds.entryDriftPctOfZoneMin;
            const fmtNumStr = (n: number | null, digits: number, sign: boolean = false): string => {
              if (n === null) return "n/a";
              const s = n.toFixed(digits);
              if (sign && n >= 0 && !s.startsWith("-")) return `+${s}`;
              return s;
            };
            lines.push(`  - match thresholds: stopBpsMax=${fmtNumStr(sMax, 0)} | entryDriftPctMax=${fmtNumStr(eMax, 2)} | supportEntryDriftAtrMin=${fmtNumStr(aMin, 1)}`);
            lines.push(`  - veto thresholds: stopBpsMin=${fmtNumStr(sMin, 0)} | entryDriftPctMin=${fmtNumStr(eMin, 2, true)}`);
            lines.push(`  - cohort eval: match=${tcfp.evaluations.matchCount} veto=${tcfp.evaluations.vetoCount} neither=${tcfp.evaluations.neitherCount} of ${tcfp.evaluations.evaluatedCohortSize}`);
            const fmtBucket = (label: string, b: typeof tcfp.buckets.match): string => {
              const net = b.netAvgR !== null ? `${b.netAvgR >= 0 ? "+" : ""}${b.netAvgR.toFixed(4)}R` : "n/a";
              const pf = b.profitFactor !== null ? b.profitFactor.toFixed(2) : "n/a";
              return `${label} n=${b.n} net=${net} PF=${pf}`;
            };
            lines.push(`  - economics: ${fmtBucket("match", tcfp.buckets.match)} | ${fmtBucket("neither", tcfp.buckets.neither)} | ${fmtBucket("veto", tcfp.buckets.veto)}`);
            if (tcfp.bothMatchAndVetoEconomics !== null && tcfp.vetoOnlyEconomics !== null) {
              lines.push(`  - overlap economics: ${fmtBucket("both(absorbed→veto)", tcfp.bothMatchAndVetoEconomics)} | ${fmtBucket("veto-only", tcfp.vetoOnlyEconomics)}`);
            }
            if (tcfp.thresholdOverlap?.anyCrossed) {
              const ov = tcfp.thresholdOverlap;
              const stopStr = ov.stopCrossed ? `stop[VetoMin≤MatchMax]` : "";
              const driftStr = ov.driftCrossed ? `drift[VetoMin≤MatchMax]` : "";
              const dimStr = [stopStr, driftStr].filter(Boolean).join(" ");
              const bothN = tcfp.bothMatchAndVetoCount ?? 0;
              lines.push(`  - threshold overlap: ${dimStr} | BOTH n=${bothN} absorbed by veto-wins precedence | NEITHER may collapse to zero`);
            }
            const rb = tcfp.robustness;
            const blockersStr = rb.blockers.length > 0 ? ` | blockers: ${rb.blockers.join(", ")}` : "";
            lines.push(`  - robustness: ${rb.status}${blockersStr}`);
          } else {
            lines.push("  - thresholds: unavailable");
          }
          return lines;
        })()
      : []),
    "",
    "J*. KRONOS COUNTERFACTUAL EVIDENCE (REPORT-ONLY)",
    ...(opts.kronosCounterfactual
      ? (() => {
          const cf = opts.kronosCounterfactual!;
          const lines: string[] = [];
          lines.push(
            `- observations: total=${cf.observationsTotal} | open=${cf.observationsOpen} | resolved=${cf.observationsResolved} | no-fill=${cf.observationsNoFill} | expired=${cf.observationsExpired} | failed=${cf.observationsFailed}`,
          );
          for (const lane of cf.lanes) {
            const laneLabel = lane.lane === "KRONOS_DISAGREEMENT_COUNTERFACTUAL" ? "disagreement lane" : "live-source-conflict lane";
            const netStr = lane.resolvedNetAvgR !== null
              ? `${lane.resolvedNetAvgR >= 0 ? "+" : ""}${lane.resolvedNetAvgR.toFixed(4)}R`
              : "n/a";
            const pfStr = lane.resolvedProfitFactor !== null ? lane.resolvedProfitFactor.toFixed(2) : "n/a";
            const wrStr = lane.resolvedWinRate !== null ? `${Math.round(lane.resolvedWinRate * 100)}%` : "n/a";
            lines.push(
              `- ${laneLabel}: total=${lane.total} | open=${lane.open} | resolved=${lane.resolved} | netAvgR=${netStr} | PF=${pfStr} | WR=${wrStr}`,
            );
          }
          lines.push("- validation milestones:");
          for (const lane of cf.lanes) {
            const m = lane.milestones;
            const mlaneLabel = m.lane === "KRONOS_DISAGREEMENT_COUNTERFACTUAL" ? "disagreement" : "live-source-conflict";
            const exNetStr = m.exTop2SymbolNetAvgR !== null
              ? `${m.exTop2SymbolNetAvgR >= 0 ? "+" : ""}${m.exTop2SymbolNetAvgR.toFixed(4)}r`
              : "n/a";
            const exPfStr = m.exTop2SymbolProfitFactor !== null ? m.exTop2SymbolProfitFactor.toFixed(2) : "n/a";
            lines.push(
              `  - ${mlaneLabel}: n=${m.resolvedN}/${MILESTONE_RESOLVED_N_TARGET} | days=${m.distinctCalendarDays}/${MILESTONE_CALENDAR_DAYS_TARGET} | ex-top2 net=${exNetStr} PF=${exPfStr} | both-dir-negative=${m.bothDirectionsNegative} | cost-control=${m.costModelControlReady} | status=${m.overallStatus}`,
            );
          }
          lines.push(`- verdict: ${cf.verdict}`);
          lines.push("- report-only, no behavior influence");
          return lines;
        })()
      : ["- Kronos counterfactual report not supplied (no observations yet or store unavailable)", "- report-only, no behavior influence"]),
    "",
    "K. REGIME POLICY COUNTERFACTUAL",
    counterfactual.ok
      ? `- Best scenario: ${counterfactual.value.bestImprovingScenario ? `${counterfactual.value.bestImprovingScenario.label} | N=${counterfactual.value.bestImprovingScenario.includedCount} | netAvgR=${fmtNum(counterfactual.value.bestImprovingScenario.netAvgR)} | delta=${fmtNum(counterfactual.value.bestImprovingScenario.deltaNetAvgRVsBaseline)} | PF=${fmtNum(counterfactual.value.bestImprovingScenario.profitFactor, 2)} | ${counterfactual.value.bestImprovingScenario.interpretation}` : "none"}`
      : `- Unavailable: ${counterfactual.error}`,
    interactionVsPolicyNote ? `- ${interactionVsPolicyNote}` : null,
    "",
    "L. FORWARD REGIME OVERLAY",
    forwardOverlay.ok
      ? `- recordsWithPersistedOverlay=${forwardOverlay.value.recordsWithPersistedOverlay} | coverage=${fmtPct(forwardOverlay.value.overlayForwardCoveragePct)}`
      : `- Unavailable: ${forwardOverlay.error}`,
    forwardOverlay.ok
      ? `- Any resolved forward evidence: ${forwardOverlay.value.policyPerformance.some((policy) => policy.totalResolvedWithPolicy > 0)} | current verdict=${overlayVerdict}`
      : "- Forward evidence: unavailable",
    openOverlayTaggedPositions > 0 ? `- Open overlay-tagged positions already collecting prospectively: ${openOverlayTaggedPositions}` : null,
    "",
    "N. TECHNICAL STOP/TP CREDIBILITY",
    stopTpCredibility.ok
      ? `- Path coverage: ${fmtPct(stopTpCredibility.value.realizedPathCoveragePct)} of resolved experience records (${stopTpCredibility.value.recordsWithRealizedPath} with path)`
      : `- Unavailable: ${stopTpCredibility.error}`,
    // Phase 3.1 toxicity-evidence instrumentation coverage (data only).
    `- Variant excursion coverage: ${variantInstrumentationCoverage.excursion.populated}/${variantInstrumentationCoverage.excursion.total} (${fmtPct(variantInstrumentationCoverage.excursion.pct)})`,
    `- Variant R-geometry coverage: ${variantInstrumentationCoverage.rGeometry.populated}/${variantInstrumentationCoverage.rGeometry.total} (${fmtPct(variantInstrumentationCoverage.rGeometry.pct)})`,
    `- Forward-path summary coverage: ${variantInstrumentationCoverage.forwardPath.populated}/${variantInstrumentationCoverage.forwardPath.total} (${fmtPct(variantInstrumentationCoverage.forwardPath.pct)})`,
    stopTpCredibility.ok
      ? `- Stop survival: ${stopTpCredibility.value.stopSurvivalProfile.verdict}${stopTpCredibility.value.stopSurvivalProfile.avgWinnerMaeR !== null ? `, avg winner MAE=${fmtNum(stopTpCredibility.value.stopSurvivalProfile.avgWinnerMaeR)}R` : ""}`
      : "- Stop survival: unavailable",
    stopTpCredibility.ok
      ? `- Loser favorable excursion: ${stopTpCredibility.value.favorableExcursionProfile.verdict}${stopTpCredibility.value.favorableExcursionProfile.avgLoserMfeR !== null ? `, avg loser MFE=${fmtNum(stopTpCredibility.value.favorableExcursionProfile.avgLoserMfeR)}R` : ""}`
      : "- Loser favorable excursion: unavailable",
    stopTpCredibility.ok
      ? `- TP capture: ${stopTpCredibility.value.captureEfficiencyProfile.verdict}${stopTpCredibility.value.captureEfficiencyProfile.avgWinnerMfeR !== null ? `, avg winner MFE=${fmtNum(stopTpCredibility.value.captureEfficiencyProfile.avgWinnerMfeR)}R` : ""}${stopTpCredibility.value.captureEfficiencyProfile.avgWinnerGrossRealizedR !== null ? ` vs realized gross=${fmtNum(stopTpCredibility.value.captureEfficiencyProfile.avgWinnerGrossRealizedR)}R` : ""}`
      : "- TP capture: unavailable",
    stopTpCredibility.ok
      ? `- Behavior influence ready: false; blocker: ${stopTpCredibility.value.readiness.reasons[0] ?? "path coverage still too sparse"}`
      : "- Behavior influence ready: false",
    "",
    "O. UNIVERSE ROTATION INTELLIGENCE",
    universeRotation.ok
      ? `- Symbols tracked=${universeRotation.value.metadata.symbolCount} | with>=5 closes=${universeRotation.value.metadata.symbolsWithAtLeast5Closes} | with>=15=${universeRotation.value.metadata.symbolsWithAtLeast15Closes} | with>=30=${universeRotation.value.metadata.symbolsWithAtLeast30Closes}`
      : `- Unavailable: ${universeRotation.error}`,
    universeRotation.ok
      ? `- Universe netAvgR=${fmtNum(universeRotation.value.universeContributionSummary.overallNetAvgR)} | positive contributors=${universeRotation.value.universeContributionSummary.positiveContributorCount} | negative=${universeRotation.value.universeContributionSummary.negativeContributorCount}`
      : "- Universe performance: unavailable",
    universeRotation.ok
      ? `- Top contributor: ${universeRotation.value.universeContributionSummary.topContributor ? (() => {
          const tc = universeRotation.value.universeContributionSummary.topContributor!;
          const multiplicityFlagged = symbolRoute.ok && symbolRoute.value.candidateAssessments.some(
            (a) => a.symbol === tc.symbol && a.signalMultiplicityWarning,
          );
          return `${tc.symbol}${multiplicityFlagged ? " (⚠ MULTIPLICITY)" : ""} (netAvgR=${fmtNum(tc.netAvgR)}, n=${tc.closedCount})`;
        })() : "none"}`
      : "- Top contributor: unavailable",
    universeRotation.ok
      ? `- Worst contributor: ${universeRotation.value.universeContributionSummary.worstContributor ? `${universeRotation.value.universeContributionSummary.worstContributor.symbol} (netAvgR=${fmtNum(universeRotation.value.universeContributionSummary.worstContributor.netAvgR)}, n=${universeRotation.value.universeContributionSummary.worstContributor.closedCount})` : "none"}`
      : "- Worst contributor: unavailable",
    universeRotation.ok
      ? `- Core observation candidates=${universeRotation.value.coreObservationCandidates.length}${universeRotation.value.coreObservationCandidates.length > 0 ? ` (${universeRotation.value.coreObservationCandidates.map((s) => s.symbol).join(", ")})` : ""} | rotation pressure candidates=${universeRotation.value.rotationPressureCandidates.length}${universeRotation.value.rotationPressureCandidates.length > 0 ? ` (${universeRotation.value.rotationPressureCandidates.map((s) => s.symbol).join(", ")})` : ""}`
      : "- Candidates: unavailable",
    universeRotation.ok
      ? `- Universe influence ready: false; external discovery ready: false; blocker: ${universeRotation.value.readiness.reasons[0] ?? "insufficient symbol coverage"}`
      : "- Universe influence ready: false",
    "",
    "P. EXTERNAL CANDIDATE DISCOVERY INTELLIGENCE",
    ...(externalCandidateDiscovery.ok
      ? summarizeMetadataDiagnosticsLine(externalCandidateDiscovery.value.metadataDiagnostics)
      : [`- Unavailable: ${externalCandidateDiscovery.error}`]),
    externalCandidateDiscovery.ok
      ? `- External symbols considered=${externalCandidateDiscovery.value.externalUniverseSymbolsConsidered} | tradable=${externalCandidateDiscovery.value.externalUniverseSymbolsTradable} | rejected=${externalCandidateDiscovery.value.externalUniverseSymbolsRejected} | shortlist=${externalCandidateDiscovery.value.shortlistedCandidates.length}`
      : "- External symbols considered: unavailable",
    externalCandidateDiscovery.ok
      ? `- Top exploratory candidate: ${externalCandidateDiscovery.value.shortlistedCandidates[0] ? `${externalCandidateDiscovery.value.shortlistedCandidates[0].symbol} (score=${externalCandidateDiscovery.value.shortlistedCandidates[0].netDiscoveryScore}, ${externalCandidateDiscovery.value.shortlistedCandidates[0].discoveryTier})` : "none"}`
      : "- Top exploratory candidate: unavailable",
    externalCandidateDiscovery.ok
      ? `- Fingerprint confidence: promising=${externalCandidateDiscovery.value.discoveryFingerprintBasis.promisingFingerprintConfidence} | toxic=${externalCandidateDiscovery.value.discoveryFingerprintBasis.toxicFingerprintConfidence}; similarity remains exploratory`
      : "- Fingerprint confidence: unavailable",
    externalCandidateDiscovery.ok
      ? `- External discovery ready=${externalCandidateDiscovery.value.discoveryReadiness.advisoryEngineReady} (confidence=${externalCandidateDiscovery.value.discoveryReadiness.confidence}) | universe expansion influence ready=false | rotation shadow overlay ready=false`
      : "- External discovery ready=false",
    externalCandidateDiscovery.ok
      ? `- Main blocker: ${externalCandidateDiscovery.value.discoveryReadiness.reasons[0] ?? "promising universe fingerprint is not mature enough for behavior influence"}`
      : "- Main blocker: unavailable",
    "",
    "Q. EXTERNAL STRATEGY-FIT ENRICHMENT",
    externalStrategyFitEnrichment.ok
      ? `- Discovery shortlist=${externalStrategyFitEnrichment.value.discoverySourceSummary.discoveryShortlistCount} | technically enriched=${externalStrategyFitEnrichment.value.enrichedCandidateCount} | failed=${externalStrategyFitEnrichment.value.failedCandidateCount}`
      : `- Unavailable: ${externalStrategyFitEnrichment.error}`,
    externalStrategyFitEnrichment.ok
      ? `- Top strategy-fit candidate: ${externalStrategyFitEnrichment.value.topStrategyFitCandidates[0] ? `${externalStrategyFitEnrichment.value.topStrategyFitCandidates[0].symbol} (fitScore=${externalStrategyFitEnrichment.value.topStrategyFitCandidates[0].strategyFitScore}, ${externalStrategyFitEnrichment.value.topStrategyFitCandidates[0].strategyFitTier})` : "none"}`
      : "- Top strategy-fit candidate: unavailable",
    externalStrategyFitEnrichment.ok
      ? `- Metadata shortlist != strategy-fit shortlist: ${externalStrategyFitEnrichment.value.metadataShortlistDivergesFromStrategyFit} | low-fit examples=${externalStrategyFitEnrichment.value.lowFitCandidates.length}`
      : "- Metadata/strategy divergence: unavailable",
    externalStrategyFitEnrichment.ok
      ? `- Rotation shadow overlay ready=false; universe influence ready=false; confidence=${externalStrategyFitEnrichment.value.enrichmentReadiness.confidence}`
      : "- Rotation shadow overlay ready=false; universe influence ready=false",
    externalStrategyFitEnrichment.ok && externalStrategyFitEnrichment.value.failedCandidateCount > 0
      ? `- Top enrichment failure: ${Object.entries(externalStrategyFitEnrichment.value.diagnostics.failureReasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown technical enrichment failure"}`
      : null,
    externalStrategyFitEnrichment.ok
      ? `- Main blocker: ${externalStrategyFitEnrichment.value.enrichmentReadiness.reasons[0] ?? "enrichment is not forward-validated"}`
      : "- Main blocker: unavailable",
    "",
    "R. EXTERNAL ROTATION SHADOW OVERLAY",
    externalRotationOverlay.ok
      ? `- Raw observations=${externalRotationOverlay.value.validityCounts.rawObservationCount} | valid post-fix=${externalRotationOverlay.value.validityCounts.validObservationCount} | legacy invalid excluded=${externalRotationOverlay.value.validityCounts.legacyInvalidExcludedCount}`
      : `- Unavailable: ${externalRotationOverlay.error}`,
    externalRotationOverlay.ok
      ? `- Operative observations (valid only): open=${externalRotationOverlay.value.openObservations} | resolved=${externalRotationOverlay.value.resolvedObservations} | no-fill=${externalRotationOverlay.value.noFillObservations} | expired=${externalRotationOverlay.value.expiredObservations} | failed=${externalRotationOverlay.value.failedObservations}`
      : "- Operative observations: unavailable",
    externalRotationOverlay.ok
      ? summarizeOverlayStatusAccounting(externalRotationOverlay.value)
      : "- Status accounting: unavailable",
    externalRotationOverlay.ok && externalRotationOverlay.value.validityCounts.legacyInvalidExcludedCount > 0 && externalRotationOverlay.value.validityCounts.validObservationCount === 0
      ? "- Prior overlay sample was invalidated due to entry-anchor / fill-price unit mismatch (V1 contamination); fresh anchor-consistent tape (V2) is being collected"
      : null,
    externalRotationOverlay.ok
      ? `- Strategy-fit group=${externalRotationOverlay.value.groupPerformance.find((group) => group.group === "STRATEGY_FIT_SHORTLIST")?.observationCount ?? 0} obs | metadata baseline=${externalRotationOverlay.value.groupPerformance.find((group) => group.group === "METADATA_DISCOVERY_BASELINE")?.observationCount ?? 0} obs`
      : "- Group counts: unavailable",
    externalRotationOverlay.ok
      ? `- Forward overlay verdict: ${externalRotationOverlay.value.currentBestObservedGroup?.earlyVerdict ?? "NO_FORWARD_EVIDENCE_YET"}${externalRotationOverlay.value.currentBestObservedGroup ? ` (${externalRotationOverlay.value.currentBestObservedGroup.group})` : ""}`
      : "- Forward overlay verdict: unavailable",
    externalRotationOverlay.ok
      ? summarizeOverlayAutoRefresh(externalRotationOverlay.value.autoRefresh)
      : "- Auto-refresh: unavailable",
    externalRotationOverlay.ok
      ? summarizeOverlayRefreshDiagnostics(externalRotationOverlay.value.duplicateSuppressionStats)
      : "- Collection diagnostics: unavailable",
    externalRotationOverlay.ok
      ? `- Universe influence ready=false; rotation discussion ready=false`
      : "- Universe influence ready=false; rotation discussion ready=false",
    externalRotationOverlay.ok
      ? `- Main blocker: ${externalRotationOverlay.value.readiness.reasons[0] ?? "no resolved external overlay observations yet"}`
      : "- Main blocker: unavailable",
    externalRotationOverlayEconomics.ok &&
      externalRotationOverlayEconomics.value.externalOverlayInterpretability.netRotationComparisonStatus === "NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION"
      ? "- [ECONOMICS WARNING: net R above is cost-distorted; do not read as candidate quality signal — see section T]"
      : null,
    "",
    "S. EXTERNAL ROTATION OVERLAY ECONOMICS",
    ...(externalRotationOverlayEconomics.ok ? (() => {
      const eco = externalRotationOverlayEconomics.value;
      const sf = eco.groups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST");
      const mb = eco.groups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE");
      const lines: string[] = [
        `- Raw observations=${eco.validityCounts.rawObservationCount} | valid post-fix=${eco.validityCounts.validObservationCount} | legacy invalid excluded=${eco.validityCounts.legacyInvalidExcludedCount}`,
        `- Resolved overlay observations analyzed=${eco.resolvedObservations} (FILLED only, valid post-fix tape)`,
        `- Headline economics basis: interpretable valid post-fix tape only | headline n=${eco.headlineInterpretiveSampleSize} | distorted excluded=${eco.forensicDistortedSampleSize} | borderline excluded=${eco.forensicBorderlineSampleSize}`,
      ];
      if (eco.validityCounts.legacyInvalidExcludedCount > 0 && eco.resolvedObservations === 0) {
        lines.push("- Legacy V1 economics are excluded from operative diagnosis (unit-mismatch contamination); awaiting fresh V2 evidence");
      }
      if (sf && sf.resolvedCount > 0 && sf.grossAvgR !== null && sf.netAvgR !== null) {
        lines.push(
          `- Strategy-fit: gross=${sf.grossAvgR.toFixed(4)}R | net=${sf.netAvgR.toFixed(4)}R | implied drag=${sf.avgCostDragR !== null ? sf.avgCostDragR.toFixed(4) : "n/a"}R (headline n=${sf.headlineInterpretiveSampleSize}, distorted excluded=${sf.distortedExcludedFromHeadline}) | verdict=${sf.economicsVerdict}`,
        );
      } else {
        lines.push(`- Strategy-fit: ${sf?.headlineInterpretiveSampleSize ?? 0} interpretable FILLED resolved (forensic resolved=${sf?.forensicResolvedSampleSize ?? 0}) — ${sf?.economicsVerdict ?? "INSUFFICIENT_EVIDENCE"}`);
      }
      if (mb && mb.resolvedCount > 0 && mb.grossAvgR !== null && mb.netAvgR !== null) {
        lines.push(
          `- Metadata baseline: gross=${mb.grossAvgR.toFixed(4)}R | net=${mb.netAvgR.toFixed(4)}R | implied drag=${mb.avgCostDragR !== null ? mb.avgCostDragR.toFixed(4) : "n/a"}R (headline n=${mb.headlineInterpretiveSampleSize}, distorted excluded=${mb.distortedExcludedFromHeadline}) | verdict=${mb.economicsVerdict}`,
        );
      } else {
        lines.push(`- Metadata baseline: ${mb?.headlineInterpretiveSampleSize ?? 0} interpretable FILLED resolved (forensic resolved=${mb?.forensicResolvedSampleSize ?? 0}) — ${mb?.economicsVerdict ?? "INSUFFICIENT_EVIDENCE"}`);
      }
      lines.push(`- Primary diagnosis: ${eco.economicsDiagnosis.primaryDiagnosis}`);
      lines.push(`- Cost decomposition available=false; using aggregate gross-to-net drag`);
      if (eco.geometryFindings.length > 0 && eco.geometryFindings[0] && !eco.geometryFindings[0].startsWith("No clear geometry")) {
        lines.push(`- Geometry: ${eco.geometryFindings[0]}`);
      }
      lines.push(
        `- Main caution: distorted observations remain visible for forensic audit but no longer contaminate headline economics; ${eco.economicsDiagnosis.cautionNotes[0] ?? "sample is still tiny, patterns may shift"}`,
      );
      lines.push(
        `- Resolver behavior discussion ready=false; universe rotation interpretation ready=false`,
      );
      return lines;
    })() : [`- Unavailable: ${externalRotationOverlayEconomics.error}`]),
    "",
    "T. EXTERNAL ROTATION OVERLAY ECONOMICS CREDIBILITY",
    ...(externalRotationOverlayEconomics.ok ? (() => {
      const eco = externalRotationOverlayEconomics.value;
      const interp = eco.externalOverlayInterpretability;
      const sfCred = eco.credibilityGroups.find((g) => g.group === "STRATEGY_FIT_SHORTLIST");
      const mbCred = eco.credibilityGroups.find((g) => g.group === "METADATA_DISCOVERY_BASELINE");
      const resolvedClassified = interp.interpretableCount + interp.distortedCount + interp.borderlineCount;
      const tLines: string[] = [
        `- Credibility: interpretable=${interp.interpretableCount} | distorted=${interp.distortedCount} | borderline=${interp.borderlineCount} | insufficient=${interp.insufficientDataCount} (of ${interp.totalClassified} total classified, valid post-fix tape only)`,
        `- Distorted observations remain tracked for audit; headline economics excludes distorted and borderline resolved tape by default.`,
        `- Net rotation comparison status: ${interp.netRotationComparisonStatus}`,
        `- Gross directional comparison status: ${interp.grossDirectionalComparisonStatus}`,
      ];
      if (eco.validityCounts.legacyInvalidExcludedCount > 0 && resolvedClassified === 0) {
        tLines.push("- Legacy V1 credibility values are excluded; awaiting fresh anchor-consistent V2 evidence");
      }
      if (interp.warningMessage) {
        tLines.push(`- WARNING: ${interp.warningMessage}`);
      }
      if (sfCred) {
        tLines.push(
          `- Strategy-fit credibility: ${sfCred.credibilityVerdict} | distorted=${sfCred.distortedCount} | interpretable=${sfCred.interpretableCount} | borderline=${sfCred.borderlineCount}${sfCred.dominantDistortionFlag ? ` | dominant flag=${sfCred.dominantDistortionFlag}` : ""}`,
        );
      }
      if (mbCred) {
        tLines.push(
          `- Metadata baseline credibility: ${mbCred.credibilityVerdict} | distorted=${mbCred.distortedCount} | interpretable=${mbCred.interpretableCount} | borderline=${mbCred.borderlineCount}`,
        );
      }
      tLines.push(`- ${resolvedClassified} resolved observations classified; behavior influence ready=false`);
      return tLines;
    })() : [`- Unavailable: ${externalRotationOverlayEconomics.error}`]),
    "",
    "U. TP/SL GEOMETRY ROOT-CAUSE AUDIT",
    ...(tpSlGeometryRootCauseAudit.ok ? (() => {
      const audit = tpSlGeometryRootCauseAudit.value;
      const uLines: string[] = [
        `- Audits legacy V1 contaminated observations: ${audit.totalObservations} (post-fix V2 observations excluded from audit scope: ${audit.postFixV2ObservationCount})`,
        `- Primary root cause: ${audit.rootCauseVerdict}`,
        `- Secondary amplifier: ${audit.secondaryGeometryFinding === "ULTRA_TIGHT_STOP_GEOMETRY_AMPLIFIED_THE_DAMAGE" ? "ultra-tight stop geometry magnified the unit mismatch" : audit.secondaryGeometryFinding === "NO_SEPARATE_GEOMETRY_AMPLIFIER_CONFIRMED" ? "no separate geometry amplifier confirmed" : "insufficient evidence"}`,
        `- External vs active: shared stop tightness weakness may exist, but the anchor/fill mismatch bug was external-overlay-specific (activeBotHasSameMismatchBug=${audit.activeBotHasSameMismatchBug})`,
        `- Cost model sanity: ${audit.costModelSanity === "COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH" ? "arithmetic correct, but V1 entry basis was inconsistent" : audit.costModelSanity}`,
        `- RR inflation driver: ${audit.rrInflationDriver}`,
      ];
      if (audit.pctObservationsWithMismatch !== null) {
        uLines.push(
          `- ${(audit.pctObservationsWithMismatch * 100).toFixed(1)}% of resolved observations show actual fill stop >= 2x stored stopDistanceBps (entry-anchor / fill-price mismatch)`,
        );
      }
      if (audit.avgInflationRatio !== null) {
        uLines.push(`- Avg fill/anchor risk inflation ratio: ${audit.avgInflationRatio.toFixed(2)}x`);
      }
      if (audit.strongestOffendingVariant) {
        uLines.push(`- Strongest offending entry variant: ${audit.strongestOffendingVariant}`);
      }
      uLines.push(`- Behavior patch readiness=false (resolver/cost model changes require explicit authorization)`);
      return uLines;
    })() : [`- Unavailable: ${tpSlGeometryRootCauseAudit.error}`]),
    "",
    "V. ADAPTIVE PROFIT POLICY SYNTHESIS",
    adaptiveProfitPolicySynthesis.ok
      ? `- Best ranked (credibility-led): ${adaptiveProfitPolicySynthesis.value.bestOverallPolicy ? `${adaptiveProfitPolicySynthesis.value.bestOverallPolicy.policyLabel} | ${adaptiveProfitPolicySynthesis.value.bestOverallPolicy.policyVerdict} | n=${adaptiveProfitPolicySynthesis.value.bestOverallPolicy.sampleSize} | netAvgR=${fmtNum(adaptiveProfitPolicySynthesis.value.bestOverallPolicy.netAvgR)}` : "none"}`
      : `- Unavailable: ${adaptiveProfitPolicySynthesis.error}`,
    adaptiveProfitPolicySynthesis.ok
      ? (() => {
          // Best by economics: pick the maturity-qualified (non-REJECT, non-TOO_EARLY) candidate
          // with highest netAvgRRealisticBasis ?? netAvgR. TOO_EARLY candidates are excluded because
          // their verdict already signals insufficient data — they are not actionable for operator reporting.
          //
          // Credibility guard: reuse earlyPromisingBlocked from symbol-route suitability
          // (signalMultiplicityWarning=true OR all records RAW_EDGE_NOT_VALIDATED).
          // Per-symbol candidates whose symbol+direction cohort is earlyPromisingBlocked are excluded
          // so that multiplicity false-positives cannot surface as "Best by economics".
          const blockedSymbolDirectionKeys = new Set<string>(
            symbolRoute.ok
              ? symbolRoute.value.candidateAssessments
                  .filter((a) => a.earlyPromisingBlocked)
                  .map((a) => `${a.symbol}|${a.direction}`)
              : [],
          );
          const allCandidates = adaptiveProfitPolicySynthesis.value.candidates.length > 0
            ? adaptiveProfitPolicySynthesis.value.candidates
            : adaptiveProfitPolicySynthesis.value.rankedTopPolicies;
          const isCandidateCredible = (c: typeof allCandidates[0]): boolean => {
            if (c.symbolScope === "ALL_SYMBOLS" || c.symbolScope === "ALL_SYMBOLS_EX_TOXIC" || c.symbolScope === "EXTERNAL_STRATEGY_FIT_SHORTLIST") {
              // Cross-symbol and external candidates: not filtered by symbol-level guardrail
              return true;
            }
            // Per-symbol candidate: exclude if ANY route cohort for this symbol+direction is earlyPromisingBlocked
            return !blockedSymbolDirectionKeys.has(`${c.symbolScope}|${c.direction}`);
          };
          const econBest = allCandidates
            .filter((c) => c.policyVerdict !== "REJECT" && c.policyVerdict !== "TOO_EARLY" && isCandidateCredible(c))
            .reduce<typeof allCandidates[0] | null>((best, c) => {
              const score = c.netAvgRRealisticBasis ?? c.netAvgR ?? -Infinity;
              const bestScore = best ? (best.netAvgRRealisticBasis ?? best.netAvgR ?? -Infinity) : -Infinity;
              return score > bestScore ? c : best;
            }, null)
            ?? (() => {
              // Fallback: bestShortPolicy only if it passes the credibility guard
              const sp = adaptiveProfitPolicySynthesis.value.bestShortPolicy;
              return sp && isCandidateCredible(sp) ? sp : null;
            })();
          if (!econBest) return "- Best by economics: none with credible effective evidence yet";
          const realisticStr = econBest.netAvgRRealisticBasis != null
            ? ` | realistic=${fmtNum(econBest.netAvgRRealisticBasis)}`
            : "";
          return `- Best by economics: ${econBest.policyLabel} | ${econBest.policyVerdict} | n=${econBest.sampleSize} | netAvgR=${fmtNum(econBest.netAvgR)}${realisticStr}`;
        })()
      : "- Best by economics: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? `- Best ranked consensus: ${adaptiveProfitPolicySynthesis.value.bestOverallPolicy?.evidenceConsensus.evidenceConsensusVerdict ?? "n/a"}${adaptiveProfitPolicySynthesis.value.bestOverallPolicy ? ` | score=${adaptiveProfitPolicySynthesis.value.bestOverallPolicy.evidenceConsensus.evidenceConsensusScore}` : ""}`
      : "- Best ranked consensus: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? `- Best SHORT: ${adaptiveProfitPolicySynthesis.value.bestShortPolicy ? `${adaptiveProfitPolicySynthesis.value.bestShortPolicy.policyLabel} | ${adaptiveProfitPolicySynthesis.value.bestShortPolicy.policyVerdict} | consensus=${adaptiveProfitPolicySynthesis.value.bestShortPolicy.evidenceConsensus.evidenceConsensusVerdict}` : "none"}`
      : "- Best SHORT: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? `- Best LONG: ${adaptiveProfitPolicySynthesis.value.bestLongPolicy ? `${adaptiveProfitPolicySynthesis.value.bestLongPolicy.policyLabel} | ${adaptiveProfitPolicySynthesis.value.bestLongPolicy.policyVerdict} | consensus=${adaptiveProfitPolicySynthesis.value.bestLongPolicy.evidenceConsensus.evidenceConsensusVerdict}` : "none"}`
      : "- Best LONG: unavailable",
    // EX_TOXIC refined sibling sub-block — reporting only, no operative behavior change
    ...(exToxicSibling !== null ? (() => {
      const excludedStr = (exToxicSibling.excludedSymbols ?? []).length > 0
        ? `[${(exToxicSibling.excludedSymbols ?? []).join(", ")}]`
        : "none";
      const netDeltaStr = exToxicNetAvgRDelta !== null
        ? `${exToxicNetAvgRDelta >= 0 ? "+" : ""}${exToxicNetAvgRDelta.toFixed(4)}R`
        : "n/a";
      const pfDeltaStr = exToxicPfDelta !== null
        ? `${exToxicPfDelta >= 0 ? "+" : ""}${exToxicPfDelta.toFixed(4)}`
        : "n/a";
      const promotionMarker = (shortPromotionActive || overallPromotionActive) ? " [Preferred representative: EX_TOXIC sibling]" : "";
      return [
        `- Best refined sibling [EX_TOXIC]${promotionMarker}: ${exToxicSibling.policyLabel} | ${exToxicSibling.policyVerdict} | n=${exToxicSibling.sampleSize} | netAvgR=${fmtNum(exToxicSibling.netAvgR)} | PF=${fmtNum(exToxicSibling.profitFactor, 4)}`,
        `- EX_TOXIC consensus: ${exToxicSibling.evidenceConsensus.evidenceConsensusVerdict} | excludedSymbols=${excludedStr} | netAvgR delta vs parent=${netDeltaStr} | PF delta vs parent=${pfDeltaStr}`,
        `  Conservative basis: netAvgR=${fmtNum(exToxicSibling.netAvgR)}, PF=${fmtNum(exToxicSibling.profitFactor)} (8bps fee/side)`,
        `  Realistic basis   : netAvgR=${fmtNum(exToxicSibling.netAvgRRealisticBasis)}, PF=${fmtNum(exToxicSibling.profitFactorRealisticBasis)} (5bps fee/side, Binance USD-M VIP 0)`,
        `  Cost drag saved   : ${fmtNum(exToxicSibling.costDragRealisticBasis)} R/trade vs conservative basis`,
      ];
    })() : []),
    adaptiveProfitPolicySynthesis.ok
      ? `- Ranked top 3: ${adaptiveProfitPolicySynthesis.value.rankedTopPolicies.map((policy) => `${policy.policyLabel} [${policy.policyVerdict}]`).join(" | ") || "none"}`
      : "- Ranked top 3: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? `- Main blocker (best ranked): ${adaptiveProfitPolicySynthesis.value.bestOverallPolicy?.blockers[0] ?? "no policy blocker"}`
      : "- Main blocker (best ranked): unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? `- Top consensus reason: ${adaptiveProfitPolicySynthesis.value.bestOverallPolicy?.evidenceConsensus.keyConsensusReasons[0] ?? "insufficient context"}`
      : "- Top consensus reason: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? `- Top conflict reason: ${adaptiveProfitPolicySynthesis.value.bestOverallPolicy?.evidenceConsensus.keyConflictReasons[0] ?? "none"}`
      : "- Top conflict reason: unavailable",
    "",
    "W*. REGIME DIRECTION CONTROLLER (REPORT-ONLY)",
    ...(() => {
      const rdc = regimeDirectionControllerReport;
      const wLines: string[] = [];
      wLines.push(
        `- Current regime: ${rdc.currentRegime ?? "unknown"} | controller mode: ${rdc.controllerMode} | bias=${rdc.directionalBias} | confidence=${rdc.confidence}`,
      );
      wLines.push(
        `- Permission model: allowsLong=${rdc.allowsLong} | allowsShort=${rdc.allowsShort} | allowsNewEntries=${rdc.allowsNewEntries} | requiresRetest=${rdc.requiresRetest}`,
      );
      if (rdc.currentValidationPrimaryLane) {
        wLines.push(
          `- Primary validation lane alignment: ${rdc.currentValidationPrimaryLane.alignment} — ${rdc.currentValidationPrimaryLane.note}`,
        );
      }
      wLines.push(`- Reasons: ${rdc.reasonCodes.join(", ") || "none"}`);
      wLines.push(`- Warnings: ${rdc.warnings.join(" | ")}`);
      return wLines;
    })(),
    "",
    "W. DIRECTION-ADAPTIVE EXECUTION POSTURE",
    adaptiveProfitPolicySynthesis.ok
      ? `- Current adaptive direction bias: ${adaptiveProfitPolicySynthesis.value.currentAdaptiveDirectionBias}`
      : `- Unavailable: ${adaptiveProfitPolicySynthesis.error}`,
    adaptiveProfitPolicySynthesis.ok
      ? `- Lane readiness: SHORT=${adaptiveProfitPolicySynthesis.value.directionalReadiness.shortLaneReadiness} | LONG=${adaptiveProfitPolicySynthesis.value.directionalReadiness.longLaneReadiness}`
      : "- Lane readiness: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? (() => {
          // When SHORT promotion is active, use the promoted sibling's metrics for the
          // posture "Why" line; otherwise fall through to bestOverallPolicy as before.
          const representativePolicy = promotedShortSibling ?? adaptiveProfitPolicySynthesis.value.bestOverallPolicy;
          const promotionNote = shortPromotionActive ? " [promoted EX_TOXIC representative]" : "";
          return `- Why${promotionNote}: ${representativePolicy?.whyThisPolicyRanksHere[0] ?? "no ranked lane yet"}`;
        })()
      : "- Why: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? (() => {
          // Consensus posture uses effective bestShortPolicy (already promoted if eligible)
          const shortConsensus = adaptiveProfitPolicySynthesis.value.bestShortPolicy?.evidenceConsensus.evidenceConsensusVerdict ?? "n/a";
          const longConsensus = adaptiveProfitPolicySynthesis.value.bestLongPolicy?.evidenceConsensus.evidenceConsensusVerdict ?? "n/a";
          const shortNote = shortPromotionActive ? " [promoted]" : "";
          return `- Consensus posture: SHORT${shortNote}=${shortConsensus} | LONG=${longConsensus}`;
        })()
      : "- Consensus posture: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? `- LONG promotion gap: ${adaptiveProfitPolicySynthesis.value.missingEvidenceForLongLane[0] ?? "none"}`
      : "- LONG promotion gap: unavailable",
    adaptiveProfitPolicySynthesis.ok
      ? "- Structural posture: system is not short-only; LONG lanes remain evaluable when evidence improves."
      : "- Structural posture: unavailable",
    "",
    "X. MICRO-PILOT READINESS BY POLICY LANE",
    ...(adaptiveProfitPolicySynthesis.ok
      ? adaptiveProfitPolicySynthesis.value.rankedTopPolicies.map((policy) =>
        `- ${policy.policyLabel}: ${policy.microPilotReadiness.verdict} | ready=${policy.microPilotReadiness.microPilotReady} | blocker=${policy.microPilotReadiness.blockers[0] ?? "none"}`)
      : [`- Unavailable: ${adaptiveProfitPolicySynthesis.error}`]),
    // EX_TOXIC lane micro-pilot — parallel sibling block, reporting only
    ...(exToxicSibling !== null ? (() => {
      const selectedMarker = (shortPromotionActive || overallPromotionActive) ? " [Selected refined best short policy]" : "";
      return [
        `- ${exToxicSibling.policyLabel} [EX_TOXIC lane]${selectedMarker}: ${exToxicSibling.microPilotReadiness.verdict} | ready=${exToxicSibling.microPilotReadiness.microPilotReady} | blocker=${exToxicSibling.microPilotReadiness.blockers[0] ?? "none"}`,
      ];
    })() : []),
    "",
    "Y. EXPLOIT SHADOW COLLECTION PRIORITIES",
    ...(adaptiveProfitPolicySynthesis.ok
      ? (() => {
          const plan = adaptiveProfitPolicySynthesis.value.operativeCollectionPlan;
          const primaryLane = plan.currentOperativePrimaryLane;
          // Current scan regime comes from the most recent auto-refresh result, if available.
          const currentScanRegime: string | null = opts.coreScanAutoRefresh?.lastAutoRefreshResultSummary?.marketRegime ?? null;
          const yLines: Array<string | null> = [];
          yLines.push(`- Operative collection mode: ${plan.mode}`);
          if (primaryLane) {
            // Primary lane exists — show it, do NOT render "Why no primary lane"
            yLines.push(`- Operative primary lane: ${primaryLane.policyLabel}`);
            const mpReady = primaryLane.microPilotReadiness?.microPilotReady ?? false;
            if (!mpReady) {
              const blocker = primaryLane.microPilotReadiness?.blockers[0] ?? "micro-pilot threshold not cleared";
              yLines.push(`- Primary lane status: validation-collection, not micro-pilot-ready; reason: ${blocker}`);
            }
            // Regime alignment check: use the alignment already computed by the
            // regime-direction-controller report (W*). This ensures Y always agrees
            // with W* — both derive alignment from the same pure function call.
            const laneDirection = primaryLane.direction ?? null;
            const regimeAlignmentLine = (() => {
              const alignment = highlights.regimeDirectionController.currentValidationPrimaryLane?.alignment ?? "UNKNOWN";
              if (alignment === "MATCH") return "- Current scan regime alignment: MATCH";
              if (alignment === "MISMATCH") return "- Current scan regime alignment: MISMATCH — primary lane is cross-regime validation collection only, not live execution";
              return "- Current scan regime alignment: UNKNOWN";
            })();
            yLines.push(regimeAlignmentLine);
            void laneDirection; // direction available if needed later
          } else {
            // No primary lane — show "none" and explain why
            yLines.push("- Operative primary lane: none");
            const explicitBlocker = plan.primaryLaneBlockers[0];
            if (explicitBlocker) {
              yLines.push(`- Why no primary lane: ${explicitBlocker}`);
            } else {
              const bestValidationLane = plan.secondaryValidationLanes[0] ?? plan.observeOnlyLanes[0] ?? null;
              if (bestValidationLane) {
                const mpStatus = bestValidationLane.microPilotReadiness?.verdict ?? null;
                const nearReadyStatuses = ["NEARING_MICRO_PILOT", "ALMOST_READY", "MICRO_PILOT_CANDIDATE"];
                if (mpStatus && nearReadyStatuses.includes(mpStatus)) {
                  yLines.push(`- Why no primary lane: Best lane is ${mpStatus} but conservative netAvgR has not cleared the +0.15R readiness threshold.`);
                } else if (mpStatus) {
                  yLines.push(`- Why no primary lane: Best validation lane (${bestValidationLane.policyLabel}) is ${mpStatus}; not yet ready for primary.`);
                } else {
                  yLines.push("- Why no primary lane: No lane has cleared readiness economics.");
                }
              } else {
                yLines.push("- Why no primary lane: No lane has cleared readiness economics.");
              }
            }
          }
          yLines.push(`- Operative secondary validation lanes: ${plan.secondaryValidationLanes.map((policy) => policy.policyLabel).join(" | ") || "none"}`);
          yLines.push(`- Observe-only lanes: ${plan.observeOnlyLanes.slice(0, 3).map((policy) => policy.policyLabel).join(" | ") || "none"}`);
          yLines.push(`- Anti-bias safeguard: ${plan.collectionAntiBiasSummary}`);
          yLines.push(`- External overlay admission now uses adaptive prioritization: ${plan.externalOverlayAdmissionUsesAdaptivePrioritization}`);
          return yLines;
        })()
      : [
          `- Unavailable: ${adaptiveProfitPolicySynthesis.error}`,
          "- Operative primary lane: unavailable",
          "- Why no primary lane: unavailable",
          "- Operative secondary validation lanes: unavailable",
          "- Observe-only lanes: unavailable",
          "- Anti-bias safeguard: unavailable",
          "- External overlay admission now uses adaptive prioritization: unavailable",
        ]),
    "",
    "Z*. ACCELERATED EVIDENCE FUNNEL (REPORT-ONLY)",
    ...(() => {
      const funnel = acceleratedEvidenceFunnelReport;
      const zLines: string[] = [];
      const hasLogData = typeof funnel.rawCandidatesLogged === "number";
      zLines.push(`- Window: ${funnel.era} | rawCandidates=${hasLogData ? funnel.rawCandidatesLogged : funnel.totalPositions}`);
      if (hasLogData) {
        // Log-based data path — exact candidate-level counts
        // Show the scan-cycle regime from the funnel log itself (the actual regime used during admission)
        const scanCycleRegimeFromLog = (() => {
          const entries = opts.candidateFunnelEntries;
          if (!entries || entries.length === 0) return null;
          // Use the most-recent entry's rawCurrentRegime (or currentRegime for older entries)
          for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (!e) continue;
            // rawCurrentRegime is a newer field; fall back to currentRegime for legacy entries
            const raw = e.rawCurrentRegime ?? e.currentRegime ?? null;
            if (raw !== undefined) return raw;
          }
          return null;
        })();
        const latestMode = funnel.latestScanCycleMode ?? funnel.currentControllerMode ?? "unknown";
        const regimeDisplay = scanCycleRegimeFromLog ? `${scanCycleRegimeFromLog} → controllerMode=${latestMode}` : `controllerMode=${latestMode}`;
        zLines.push(`- Scan-cycle regime: ${regimeDisplay}`);
        zLines.push(`- LONG=${funnel.longCandidates ?? 0} | SHORT=${funnel.shortCandidates ?? 0}`);
        zLines.push(`- Controller allowed=${funnel.controllerAllowedCandidates ?? 0} | blocked=${funnel.controllerBlockedCandidates ?? 0} | mode-not-directional=${(() => {
          const entries = opts.candidateFunnelEntries ?? [];
          return entries.filter((e) => e.rejectionReasons.includes("CONTROLLER_MODE_NOT_DIRECTIONAL")).length;
        })()}`);
        // By-controller-mode breakdown (new: shows all modes seen in the 24h window)
        if (funnel.byControllerMode && funnel.byControllerMode.length > 0) {
          zLines.push(`- By controller mode (last 24h):`);
          for (const row of funnel.byControllerMode) {
            zLines.push(`  ${row.controllerMode}: n=${row.rawCandidates} | allowed=${row.allowedCandidates} | varAdjPass=${row.variantAdjustedPass} | eligible=${row.controllerAlignedEligible} | opened=${row.controllerAlignedOpened}`);
          }
        }
        zLines.push(`- Legacy 175bps guard: pass=${funnel.legacy175PassFromLog ?? funnel.stop175Eligible} | rejected=${funnel.legacy175RejectedFromLog ?? funnel.stop175RejectedFromLog ?? 0}`);
        zLines.push(`- Variant-adjusted guard: pass=${funnel.variantAdjustedPassFromLog ?? "n/a"} | rejected=${funnel.variantAdjustedRejectedFromLog ?? "n/a"}`);
        const avgAtr = typeof funnel.avgAtrBpsFromLog === "number" ? funnel.avgAtrBpsFromLog.toFixed(1) : "n/a";
        const medianThreshold = typeof funnel.medianAdjustedThresholdFromLog === "number" ? funnel.medianAdjustedThresholdFromLog.toFixed(1) : "n/a";
        zLines.push(`- avgAtrBps=${avgAtr} | medianAdjustedThreshold=${medianThreshold}`);
        zLines.push(`- controllerAlignedEligible=${funnel.controllerAlignedEligible} | controllerAlignedOpened=${funnel.controllerAlignedOpened}`);
        if (funnel.topRejectionReasons && funnel.topRejectionReasons.length > 0) {
          const top = funnel.topRejectionReasons[0]!;
          zLines.push(`- Top rejection: ${top.reason}(${top.count})`);
        } else {
          zLines.push(`- Top rejection: ${funnel.topRejectionReason ?? "none"}`);
        }
        if (funnel.sourceConflictRejected) {
          zLines.push(`- Source-conflict rejected: ${funnel.sourceConflictRejected}`);
        }
      } else {
        // Position-tape fallback
        zLines.push(`- Scan-cycle regime: controllerMode=${funnel.currentControllerMode ?? "unknown"} (no funnel log entries; derived from position tape)`);
        zLines.push(`- Total positions: ${funnel.totalPositions} | open: ${funnel.openPositions} | closed: ${funnel.closedPositions} | recent24h: ${funnel.recentOpened24h}`);
        zLines.push(`- stop>=175 pass=${funnel.stop175Eligible} | stop<175 rejected=${funnel.stop175RejectedEstimate ?? "n/a (see note)"}`);
        zLines.push(`- normalShadowEligible=${funnel.normalShadowOpened}`);
        zLines.push(`- controllerAlignedEligible=${funnel.controllerAlignedEligible} | controllerAlignedOpened=${funnel.controllerAlignedOpened}`);
        zLines.push(`- Top rejection: ${funnel.topRejectionReason ?? "none"}`);
        for (const row of funnel.byDirection) {
          zLines.push(`  - Direction ${row.direction}: n=${row.n} | open=${row.openN} | closed=${row.closedN}`);
        }
      }
      zLines.push(`- Data note: ${funnel.dataSourceNote.slice(0, 120)}…`);
      zLines.push("- report-only, no behavior influence");
      return zLines;
    })(),
    "",
    "W**. REGIME CONTROLLER ALIGNED SHADOW (REPORT-ONLY)",
    ...(() => {
      const shadow = regimeControllerAlignedShadowReport;
      const funnel = acceleratedEvidenceFunnelReport;
      if (!shadow) {
        return ["- Unavailable: controllerAlignedShadowStore not supplied to dashboard builder"];
      }
      const wLines: string[] = [];
      wLines.push(`- Lane: ${shadow.laneLabel} | totalObs=${shadow.totalObservations} | open=${shadow.openObservations} | resolved=${shadow.resolvedObservations} | noFill=${shadow.noFillObservations} | expired=${shadow.expiredObservations}`);
      if (shadow.invalidGeometryCount > 0) {
        wLines.push(`- invalidGeometry=${shadow.invalidGeometryCount} (excluded from economics; placeholder geometry from earlier collection)`);
      }

      // Show scan-cycle controller mode from the funnel log (last scan batch) for alignment confirmation
      const hasLogData = typeof funnel.rawCandidatesLogged === "number";
      const scanCycleModeFromLog = hasLogData ? (funnel.currentControllerMode ?? "unknown") : null;
      const dashboardMode = regimeDirectionControllerReport.controllerMode;
      if (scanCycleModeFromLog !== null) {
        const alignNote = scanCycleModeFromLog === dashboardMode ? "ALIGNED with dashboard W*" : `DIFFERS from dashboard W* (dashboard=${dashboardMode})`;
        wLines.push(`- Scan-cycle controller mode: ${scanCycleModeFromLog} (from last scan batch) — ${alignNote}`);
      } else {
        wLines.push(`- Scan-cycle controller mode: ${dashboardMode} (from dashboard W*; no funnel log entries yet)`);
      }

      wLines.push(`- Active lane guard: max(80bps, 1.0×ATR bps) [was: fixed 175bps]`);

      // Funnel summary line
      if (hasLogData) {
        const legacy175Pass = funnel.legacy175PassFromLog ?? funnel.stop175Eligible;
        const variantAdjPass = funnel.variantAdjustedPassFromLog ?? "n/a";
        wLines.push(
          `- Last-24h: allowed=${funnel.controllerAllowedCandidates ?? 0} | legacy175Pass=${legacy175Pass} | variantAdjustedPass=${variantAdjPass} | eligible=${funnel.controllerAlignedEligible} | opened=${funnel.controllerAlignedOpened}`,
        );
      } else {
        wLines.push(
          `- Last-24h: candidate-level funnel log has no records yet; counts derived from position tape only`,
        );
      }

      // Top blocker
      const topBlocker = (() => {
        if (hasLogData && funnel.topRejectionReasons && funnel.topRejectionReasons.length > 0) {
          return funnel.topRejectionReasons[0]!.reason;
        }
        return funnel.topRejectionReason ?? "NONE";
      })();
      wLines.push(`- Top blocker: ${topBlocker}`);

      wLines.push(`- By mode:`);
      for (const row of shadow.byMode) {
        const netR = typeof row.netAvgR === "number" ? row.netAvgR.toFixed(4) : "n/a";
        const pf = typeof row.PF === "number" ? row.PF.toFixed(2) : "n/a";
        const wr = typeof row.WR === "number" ? `${(row.WR * 100).toFixed(1)}%` : "n/a";
        wLines.push(`  ${row.controllerMode}: n=${row.n} | netAvgR=${netR} | PF=${pf} | WR=${wr}`);
        // Per-mode payoff anatomy (if available)
        if (shadow.payoffAnatomy) {
          const modeAnatomy = shadow.payoffAnatomy.byMode.find((m) => m.controllerMode === row.controllerMode);
          if (modeAnatomy) {
            const winR = typeof modeAnatomy.avgWinGrossR === "number" ? `+${modeAnatomy.avgWinGrossR.toFixed(4)}` : "n/a";
            const lossR = typeof modeAnatomy.avgLossGrossR === "number" ? modeAnatomy.avgLossGrossR.toFixed(4) : "n/a";
            const pr = typeof modeAnatomy.payoffRatio === "number" ? modeAnatomy.payoffRatio.toFixed(2) : "n/a";
            const costR = typeof modeAnatomy.avgCostR === "number" ? modeAnatomy.avgCostR.toFixed(4) : "n/a";
            wLines.push(`    avgWinR=${winR} | avgLossR=${lossR} | payoffRatio=${pr} | avgCostR=${costR}`);
          }
        }
      }

      {
        const oNetR = typeof shadow.overallNetAvgR === "number" ? shadow.overallNetAvgR.toFixed(4) : "n/a";
        const oPF = typeof shadow.overallPF === "number" ? shadow.overallPF.toFixed(2) : "n/a";
        const oWR = typeof shadow.overallWR === "number" ? `${(shadow.overallWR * 100).toFixed(1)}%` : "n/a";
        wLines.push(`- Overall: resolved=${shadow.resolvedObservations} | netAvgR=${oNetR} | PF=${oPF} | WR=${oWR}`);
      }

      // Payoff anatomy section
      if (shadow.payoffAnatomy) {
        const pa = shadow.payoffAnatomy;
        wLines.push(`- Payoff anatomy:`);
        const winR = typeof pa.avgWinGrossR === "number" ? `+${pa.avgWinGrossR.toFixed(4)}` : "n/a";
        const lossR = typeof pa.avgLossGrossR === "number" ? pa.avgLossGrossR.toFixed(4) : "n/a";
        const pr = typeof pa.payoffRatio === "number" ? pa.payoffRatio.toFixed(2) : "n/a";
        wLines.push(`  avgWinGrossR=${winR} | avgLossGrossR=${lossR} | payoffRatio=${pr}`);
        const costR = typeof pa.avgCostR === "number" ? pa.avgCostR.toFixed(4) : "n/a";
        const drag = typeof pa.grossToNetDrag === "number" ? pa.grossToNetDrag.toFixed(4) : "n/a";
        wLines.push(`  avgCostR=${costR} | grossToNetDrag=${drag}`);
        const tp1Rate = typeof pa.tp1HitRate === "number" ? `${(pa.tp1HitRate * 100).toFixed(1)}%` : "n/a";
        const slRate = typeof pa.slHitRate === "number" ? `${(pa.slHitRate * 100).toFixed(1)}%` : "n/a";
        wLines.push(`  TP1 hit rate=${tp1Rate} | SL hit rate=${slRate}`);
      }

      // Exit variant counterfactuals (statistical approximation)
      if (
        shadow.exitVariantCounterfactuals &&
        shadow.exitVariantCounterfactuals.variants.length > 0 &&
        shadow.exitVariantCounterfactuals.variants[0]!.resolvedN >= 2
      ) {
        const evc = shadow.exitVariantCounterfactuals;
        wLines.push(`- Exit variant counterfactuals (statistical approx — SL outcomes identical across variants):`);
        for (const v of evc.variants) {
          const net = typeof v.avgNetR === "number" ? v.avgNetR.toFixed(4) : "n/a";
          const pf = typeof v.PF === "number" ? v.PF.toFixed(2) : "n/a";
          const wr = typeof v.WR === "number" ? `${(v.WR * 100).toFixed(1)}%` : "n/a";
          const winR = typeof v.avgWinGrossR === "number" ? `+${v.avgWinGrossR.toFixed(4)}` : "n/a";
          const label = v.variantLabel.padEnd(22);
          wLines.push(`  stat ${label}n=${v.resolvedN} net=${net} PF=${pf} WR=${wr} avgWin=${winR}`);
        }
        const bestNet = evc.bestByNetAvgR ?? "n/a";
        const bestPF = evc.bestByPF ?? "n/a";
        wLines.push(`  Best by netAvgR: ${bestNet} | Best by PF: ${bestPF}`);
        wLines.push(`  Note: WR identical across variants (entry/stop unchanged)`);
      }

      // Exact path exit counterfactuals
      {
        // Count resolved observations with valid geometry but missing exactExitCounterfactuals
        const winsAndLossesForExact = shadow
          ? (() => {
              // We derive missing count from the store observations directly via the report fields
              // resolved = CLOSED_WIN + CLOSED_LOSS (economics-eligible)
              // missing = resolved observations that have valid geometry AND exactExitCounterfactuals === null
              // We use shadow report fields where available; for missing we rely on resolvedObservations - exactN
              const exactN = shadow.exactExitCounterfactuals?.exactN ?? 0;
              const missingCount = Math.max(0, shadow.resolvedObservations - exactN);
              return { exactN, missingCount };
            })()
          : null;

        const exactN = winsAndLossesForExact?.exactN ?? 0;
        const missingCount = winsAndLossesForExact?.missingCount ?? 0;

        wLines.push(`- Exact path exit counterfactuals:`);
        wLines.push(`  exactN=${exactN} resolved with candle data | missing=${missingCount} (backfill pending)`);

        if (shadow.exactExitCounterfactuals) {
          const exc = shadow.exactExitCounterfactuals;
          if (exc.exactN < 10) {
            wLines.push(`  → TOO_EARLY_FOR_BEST_EXIT_DECISION (need ≥10, have exactN=${exc.exactN})`);
          } else {
            for (const v of exc.variants) {
              const net = typeof v.avgNetR === "number" ? v.avgNetR.toFixed(4) : "n/a";
              const pf = typeof v.PF === "number" ? v.PF.toFixed(2) : "n/a";
              const label = v.variantLabel.padEnd(22);
              wLines.push(`  exact ${label}net=${net} PF=${pf}`);
            }
            // Promotion gate
            const promotion = evaluateBestExitLanePromotion(shadow);
            if (promotion.eligible && promotion.bestExitLabel) {
              const netStr = typeof promotion.bestNetAvgR === "number" ? promotion.bestNetAvgR.toFixed(4) : "n/a";
              const bestVariant = exc.variants.find((v) => v.variantLabel === promotion.bestExitLabel);
              const pfStr = typeof bestVariant?.PF === "number" ? bestVariant.PF.toFixed(2) : "n/a";
              wLines.push(`  → BEST_EXIT_CANDIDATE: ${promotion.bestExitLabel} (net=${netStr}, PF=${pfStr})`);
            } else if (!promotion.eligible && exc.exactN >= 10) {
              wLines.push(`  → NO_POSITIVE_EXACT_EXIT`);
            }
          }
          const tp2Rate = typeof exc.tp2HitRate === "number" ? `${(exc.tp2HitRate * 100).toFixed(1)}%` : "n/a";
          const tp3Rate = typeof exc.tp3HitRate === "number" ? `${(exc.tp3HitRate * 100).toFixed(1)}%` : "n/a";
          const slRate = typeof exc.secondLegStopRate === "number" ? `${(exc.secondLegStopRate * 100).toFixed(1)}%` : "n/a";
          wLines.push(`  TP2 hit rate (post-TP1): ${tp2Rate} | TP3 hit rate: ${tp3Rate} | Second-leg stop rate: ${slRate}`);
          const bestNet = exc.bestByNetAvgR ?? "n/a";
          const bestPF = exc.bestByPF ?? "n/a";
          wLines.push(`  Best exact exit by netAvgR: ${bestNet} | by PF: ${bestPF}`);
        }
      }

      // Edge isolation report (report-only)
      {
        const ei = shadow.edgeIsolation;
        if (!ei) {
          wLines.push("  Edge isolation: unavailable (computation error or insufficient data)");
        } else {
          wLines.push(`  Edge isolation (report-only; n=${ei.inputN} resolved valid obs):`);

          // By controller mode
          if (ei.byControllerMode.length > 0) {
            wLines.push("    By controller mode:");
            for (const c of ei.byControllerMode) {
              const pf = Number.isFinite(c.pf) ? c.pf.toFixed(2) : "Inf";
              wLines.push(`      ${c.label}: n=${c.n} net=${c.netAvgR.toFixed(4)} PF=${pf} WR=${(c.wr * 100).toFixed(1)}%`);
            }
          }

          // By symbol (top 5 by n)
          const topSymbolCohorts = [...ei.bySymbol].sort((a, b) => b.n - a.n).slice(0, 5);
          if (topSymbolCohorts.length > 0) {
            wLines.push("    By symbol (top 5 by n):");
            for (const c of topSymbolCohorts) {
              const pf = Number.isFinite(c.pf) ? c.pf.toFixed(2) : "Inf";
              wLines.push(`      ${c.label}: n=${c.n} net=${c.netAvgR.toFixed(4)} PF=${pf} WR=${(c.wr * 100).toFixed(1)}%`);
            }
          }

          // By stop bucket
          if (ei.byStopBucket.filter((c) => c.label !== "unknown").length > 0) {
            wLines.push("    By stop bucket:");
            for (const c of ei.byStopBucket.filter((c) => c.label !== "unknown")) {
              const pf = Number.isFinite(c.pf) ? c.pf.toFixed(2) : "Inf";
              wLines.push(`      ${c.label}: n=${c.n} net=${c.netAvgR.toFixed(4)} PF=${pf}`);
            }
          }

          // By cost bucket
          if (ei.byCostBucket.filter((c) => c.label !== "unknown").length > 0) {
            wLines.push("    By cost bucket:");
            for (const c of ei.byCostBucket.filter((c) => c.label !== "unknown")) {
              const pf = Number.isFinite(c.pf) ? c.pf.toFixed(2) : "Inf";
              wLines.push(`      ${c.label}: n=${c.n} net=${c.netAvgR.toFixed(4)} PF=${pf}`);
            }
          }

          // By signal (one combined line per dimension)
          {
            const signalLines: string[] = [];
            // sourceConflict
            const scFalse = ei.bySourceConflict.find((c) => c.label === "sourceConflict=false");
            const scTrue = ei.bySourceConflict.find((c) => c.label === "sourceConflict=true");
            if (scFalse || scTrue) {
              const parts: string[] = [];
              if (scFalse) parts.push(`sourceConflict=false: n=${scFalse.n} net=${scFalse.netAvgR.toFixed(4)}`);
              if (scTrue) parts.push(`sourceConflict=true: n=${scTrue.n} net=${scTrue.netAvgR.toFixed(4)}`);
              signalLines.push(parts.join(" | "));
            }
            // Kronos bias
            const kbEntries = ei.byKronosBias.filter((c) => c.label !== "UNKNOWN");
            if (kbEntries.length > 0) {
              const parts = kbEntries.map((c) => `kronosBias ${c.label}: n=${c.n} net=${c.netAvgR.toFixed(4)}`);
              signalLines.push(parts.join(" | "));
            }
            // Whale agreement
            const waAgrees = ei.byWhaleAgreement.find((c) => c.label === "AGREES");
            const waDisagrees = ei.byWhaleAgreement.find((c) => c.label === "DISAGREES");
            if (waAgrees || waDisagrees) {
              const parts: string[] = [];
              if (waAgrees) parts.push(`whale AGREES: n=${waAgrees.n} net=${waAgrees.netAvgR.toFixed(4)}`);
              if (waDisagrees) parts.push(`DISAGREES: n=${waDisagrees.n} net=${waDisagrees.netAvgR.toFixed(4)}`);
              signalLines.push(parts.join(" | "));
            }
            if (signalLines.length > 0) {
              wLines.push("    By signal:");
              for (const l of signalLines) {
                wLines.push(`      ${l}`);
              }
            }
          }

          // By regime family
          const rfEntries = ei.byRegimeFamily.filter((c) => c.n > 0);
          if (rfEntries.length > 0) {
            const parts = rfEntries.map((c) => `${c.label}: n=${c.n} net=${c.netAvgR.toFixed(4)}`);
            wLines.push(`    By regime family: ${parts.join(" | ")}`);
          }

          // Best sub-cohort
          if (ei.bestSubCohorts.length > 0) {
            const best = ei.bestSubCohorts[0]!;
            const pf = Number.isFinite(best.pf) ? best.pf.toFixed(2) : "Inf";
            wLines.push(`    Best sub-cohort (n>=${5}): ${best.label} net=${best.netAvgR.toFixed(4)} PF=${pf} WR=${(best.wr * 100).toFixed(1)}% → WATCHABLE (not ready for promotion)`);
          }

          // Worst sub-cohort
          if (ei.worstSubCohorts.length > 0) {
            const worst = ei.worstSubCohorts[0]!;
            const pf = Number.isFinite(worst.pf) ? worst.pf.toFixed(2) : "0.00";
            wLines.push(`    Worst sub-cohort (n>=${3}): ${worst.label} net=${worst.netAvgR.toFixed(4)} PF=${pf} WR=${(worst.wr * 100).toFixed(1)}% → TOXIC`);
          }

          // Prune suggestions
          if (ei.pruneSuggestions.length > 0) {
            wLines.push("    Candidate filters to test next:");
            for (const ps of ei.pruneSuggestions) {
              wLines.push(`      ${ps.type} ${ps.label} (n=${ps.affectedN}, net=${ps.cohortNetAvgR.toFixed(4)})`);
            }
          }

          // Exit extension conclusion
          if (ei.exitExtensionConclusion === "POSITIVE_EXACT_EXIT") {
            wLines.push(`    Exit extension: VALIDATED (POSITIVE_EXACT_EXIT) → consider sub-cohort filtering`);
          } else if (ei.exitExtensionConclusion === "NO_POSITIVE_EXACT_EXIT") {
            wLines.push(`    Exit extension: NOT VALIDATED (NO_POSITIVE_EXACT_EXIT) → focus on sub-cohort filtering`);
          } else {
            wLines.push(`    Exit extension: INSUFFICIENT_DATA (need exactN≥10)`);
          }
        }
      }

      // Top symbols (worst first)
      if (shadow.topSymbols && shadow.topSymbols.length > 0) {
        wLines.push(`- Top symbols (worst first):`);
        for (const sym of shadow.topSymbols.slice(0, 5)) {
          const netR = typeof sym.netAvgR === "number" ? sym.netAvgR.toFixed(4) : "n/a";
          const wr = typeof sym.WR === "number" ? `${(sym.WR * 100).toFixed(1)}%` : "n/a";
          wLines.push(`  ${sym.symbol}: n=${sym.n} | resolved=${sym.resolvedN} | netAvgR=${netR} | WR=${wr}`);
        }
      }

      const verdictLabel =
        shadow.verdict === "EVIDENCE_AVAILABLE"
          ? "EVIDENCE_AVAILABLE (≥20 resolved)"
          : "TOO_EARLY (<20 resolved)";
      wLines.push(`- Verdict: ${verdictLabel}`);
      wLines.push("- report-only, isolated; data/shadow-positions.json untouched");
      return wLines;
    })(),
    "",
    "W***. REGIME CONTROLLER FILTERED EDGE SHADOW (REPORT-ONLY)",
    ...(() => {
      const fer = opts.filteredEdgeReport;
      if (!fer) {
        return ["  [unavailable]"];
      }
      const wLines: string[] = [];
      wLines.push(`- Lane: ${fer.laneVersion}`);

      // Integrity checks block (always rendered) — surfaces accounting failures
      wLines.push("- Integrity checks:");
      wLines.push(
        `    freshValidConsistencyCheck: ${fer.freshValidConsistencyCheck}${fer.freshValidConsistencyCheck === "FAIL" && fer.freshValidConsistencyDetail ? ` — ${fer.freshValidConsistencyDetail}` : ""}`,
      );
      if (fer.pathMetricConsistencyCheck) {
        wLines.push(
          `    pathMetricConsistencyCheck:  ${fer.pathMetricConsistencyCheck.status}${fer.pathMetricConsistencyCheck.status === "FAIL" && fer.pathMetricConsistencyCheck.detail ? ` — ${fer.pathMetricConsistencyCheck.detail}` : ""}`,
        );
      }
      if (fer.chronologyConsistencyCheck) {
        wLines.push(
          `    chronologyConsistencyCheck:  ${fer.chronologyConsistencyCheck.status}${fer.chronologyConsistencyCheck.status === "FAIL" && fer.chronologyConsistencyCheck.detail ? ` — ${fer.chronologyConsistencyCheck.detail}` : ""}`,
        );
      }

      // Intrabar ambiguity summary
      const ambiguous = fer.ambiguousSameCandleCount ?? 0;
      const resolvedBy1m = fer.resolvedBy1mCount ?? 0;
      const excluded = fer.ambiguousExcludedFromFreshValidCount ?? 0;
      const freshValid = fer.freshValidResolvedCount ?? 0;
      wLines.push(`- Intrabar ambiguity: ambiguous=${ambiguous} | resolvedBy1m=${resolvedBy1m} | excluded=${excluded} | freshValid=${freshValid}`);
      if (ambiguous > 0) {
        wLines.push(`  Note: ${ambiguous} same-candle ambiguous outcome(s) excluded from fresh-valid tape.`);
        wLines.push("  Fresh-valid tape requires VALID_5M_ORDERED or RESOLVED_BY_1M.");
      }
      // Consistency check warning (kept for backwards-compat with existing dashboard test)
      if (fer.freshValidConsistencyCheck === "FAIL") {
        wLines.push(`  WARNING: fresh-valid accounting inconsistency detected. ${fer.freshValidConsistencyDetail ?? ""}`);
      }

      // Overlap warning
      if (fer.overlappingCandidateCount > 0) {
        wLines.push(
          `  Note: overlappingCandidates=${fer.overlappingCandidateCount} (same entry admitted to multiple profiles; counts separately)`,
        );
      }

      const hasForensics = fer.profileForensics && fer.profileForensics.length > 0;
      const freshStrict = fer.freshValidProfileReports?.find((r) => r.profile === "STRICT_COST10");
      const freshBroad = fer.freshValidProfileReports?.find((r) => r.profile === "BROAD_COST20_STOP150");
      const fmtFreshWr = (value: number | null | undefined) =>
        value !== null && value !== undefined ? `${(value * 100).toFixed(1)}%` : "n/a";
      const fmtFreshR = (value: number | null | undefined) =>
        value !== null && value !== undefined ? value.toFixed(4) : "n/a";

      if (fer.profileReports.length > 0) {
        const allTimeSummary = fer.profileReports
          .map((report) => `${report.profile} resolved=${report.resolvedObs} net=${report.netAvgR !== null ? report.netAvgR.toFixed(4) : "n/a"} WR=${report.wr !== null ? `${(report.wr * 100).toFixed(1)}%` : "n/a"}`)
          .join(" | ");
        wLines.push(`- All-time: ${allTimeSummary}`);
      }
      wLines.push("- Fresh-valid tape:");
      if (freshStrict) {
        wLines.push(`  ${freshStrict.profile} resolved=${freshStrict.resolvedObs} net=${fmtFreshR(freshStrict.netAvgR)} WR=${fmtFreshWr(freshStrict.wr)} PF=${fmtFreshR(freshStrict.pf)} | verdict=${freshStrict.verdict}`);
      }
      if (freshBroad) {
        wLines.push(`  ${freshBroad.profile} resolved=${freshBroad.resolvedObs} net=${fmtFreshR(freshBroad.netAvgR)} WR=${fmtFreshWr(freshBroad.wr)} PF=${fmtFreshR(freshBroad.pf)} | verdict=${freshBroad.verdict}`);
      }
      if (fer.freshValidExcluded) {
        const fve = fer.freshValidExcluded;
        wLines.push(
          `- Legacy/invalid excluded from fresh verdict: invalidChronology=${fve.invalidChronology} | invalidPathMetrics=${fve.invalidPathMetrics} | missingPathMetrics=${fve.missingPathMetrics ?? 0} | ambiguousIntrabar=${fve.ambiguousIntrabar ?? 0} | invalidGeometry=${fve.invalidGeometry} | missingVersion=${fve.missingVersion} | quarantined=${fve.quarantined ?? 0}`,
        );
      }

      if (hasForensics) {
        // Full forensics output
        for (const pf of fer.profileForensics) {
          const wrStr = pf.wr !== null ? `${(pf.wr * 100).toFixed(1)}%` : "n/a";
          const netStr = pf.netAvgR !== null ? pf.netAvgR.toFixed(4) : "n/a";
          const pfStr = pf.pf !== null ? pf.pf.toFixed(2) : "n/a";
          const costStr = pf.avgCostR !== null ? pf.avgCostR.toFixed(4) : "n/a";
          const stopStr = pf.avgStopDistanceBps !== null ? pf.avgStopDistanceBps.toFixed(0) : "n/a";
          const durStr = pf.avgDurationMinutes !== null ? pf.avgDurationMinutes.toFixed(0) : "n/a";
          const mfeStr = pf.avgMfeR !== null ? pf.avgMfeR.toFixed(4) : "n/a";
          const maeStr = pf.avgMaeR !== null ? pf.avgMaeR.toFixed(4) : "n/a";
          const tp1Str = pf.tp1Rate !== null ? `${(pf.tp1Rate * 100).toFixed(1)}%` : "n/a";
          const slStr = pf.slRate !== null ? `${(pf.slRate * 100).toFixed(1)}%` : "n/a";
          const invalidReasonStr =
            pf.invalidChronologyReasons.length > 0
              ? pf.invalidChronologyReasons.map((r) => `${r.reason}(n=${r.n})`).join(", ")
              : "none";
          const invalidPathReasonStr =
            pf.pathMetricInvalidReasons.length > 0
              ? pf.pathMetricInvalidReasons.map((r) => `${r.reason}(n=${r.n})`).join(", ")
              : "none";

          wLines.push(`  Profile ${pf.profile}:`);
          wLines.push(`    totalObs=${pf.totalObs} | open=${pf.openObs} | resolved=${pf.resolvedObs} | noFill=${pf.noFillObs} | expired=${pf.expiredObs}`);
          wLines.push(`    WR=${wrStr} | netAvgR=${netStr} | PF=${pfStr} | avgCostR=${costStr} | avgStop=${stopStr}bps`);
          wLines.push(`    avgDuration=${durStr}min | avgMFE=${mfeStr} | avgMAE=${maeStr} | TP1=${tp1Str} | SL=${slStr}`);
          wLines.push(`    Chronology: valid=${pf.validChronologyCount} | invalid=${pf.invalidChronologyCount} | invalid reason=${invalidReasonStr}`);
          wLines.push(`    Path metrics: valid=${pf.pathMetricsAvailableCount} | invalid=${pf.pathMetricsInvalidCount} | invalid reason=${invalidPathReasonStr}`);
          wLines.push(`    Path forensics: withMfeMae=${pf.pathMetricsAvailableCount} | avgMFE=${mfeStr} | avgMAE=${maeStr}`);
          if (pf.invalidChronologyCount > 0) {
            wLines.push("    WARNING: invalid chronology excluded from duration/MFE/MAE aggregates");
          }
          if (pf.pathMetricsInvalidCount > 0) {
            wLines.push("    WARNING: invalid or outlier path metrics excluded from MFE/MAE aggregates");
          }

          const totalLosses = pf.resolvedObs - (pf.wr !== null ? Math.round(pf.wr * pf.resolvedObs) : 0);
          if (pf.resolvedObs > 0) {
            wLines.push(`    Immediate SL: ${pf.immediateSLCount}/${totalLosses} losses | No-MFE SL: ${pf.noMfeBeforeSLCount}/${totalLosses} losses`);
          }

          if (pf.topLosingSymbols.length > 0) {
            const losingStr = pf.topLosingSymbols
              .map((s) => `${s.symbol}(n=${s.n},net=${s.netAvgR.toFixed(4)})`)
              .join(", ");
            wLines.push(`    Top losing: ${losingStr}`);
          }
          if (pf.topWinningSymbols.length > 0) {
            const winningStr = pf.topWinningSymbols
              .map((s) => `${s.symbol}(n=${s.n},net=${s.netAvgR.toFixed(4)})`)
              .join(", ");
            wLines.push(`    Top winning: ${winningStr}`);
          }

          if (pf.byEntryVariant.length > 0) {
            const varStr = pf.byEntryVariant
              .map((v) => `${v.variant}(n=${v.n},net=${v.netAvgR !== null ? v.netAvgR.toFixed(4) : "n/a"},WR=${v.wr !== null ? `${(v.wr * 100).toFixed(0)}%` : "n/a"})`)
              .join(", ");
            wLines.push(`    By entry variant: ${varStr}`);
          }
          if (pf.byExitVariant.length > 0) {
            const exitStr = pf.byExitVariant
              .map((v) => `${v.variant}(n=${v.n},net=${v.netAvgR !== null ? v.netAvgR.toFixed(4) : "n/a"},WR=${v.wr !== null ? `${(v.wr * 100).toFixed(0)}%` : "n/a"})`)
              .join(", ");
            wLines.push(`    By exit variant: ${exitStr}`);
          }
          if (pf.byRegimeAtEntry.length > 0) {
            const regStr = pf.byRegimeAtEntry
              .map((r) => `${r.regime}(n=${r.n},net=${r.netAvgR !== null ? r.netAvgR.toFixed(4) : "n/a"})`)
              .join(", ");
            wLines.push(`    By regime: ${regStr}`);
          }
          if (pf.bySourceConflict.length > 0) {
            const sourceStr = pf.bySourceConflict
              .map((s) => `${s.label}(n=${s.n},net=${s.netAvgR !== null ? s.netAvgR.toFixed(4) : "n/a"})`)
              .join(" | ");
            wLines.push(`    By source conflict: ${sourceStr}`);
          }
          if (pf.byKronosBias.length > 0) {
            const kronStr = pf.byKronosBias
              .map((b) => `${b.bias}(n=${b.n},net=${b.netAvgR !== null ? b.netAvgR.toFixed(4) : "n/a"})`)
              .join(" | ");
            wLines.push(`    By Kronos: ${kronStr}`);
          }
          if (pf.byWhaleAgreement.length > 0) {
            const whaleStr = pf.byWhaleAgreement
              .map((w) => `${w.agreement}(n=${w.n},net=${w.netAvgR !== null ? w.netAvgR.toFixed(4) : "n/a"})`)
              .join(" | ");
            wLines.push(`    By whale: ${whaleStr}`);
          }

          if (pf.pruneSuggestions.length > 0) {
            const suggStr = pf.pruneSuggestions
              .map((s) => `${s.type} ${s.label} (n=${s.affectedN},${s.reason})`)
              .join(", ");
            wLines.push(`    Candidate filters: ${suggStr}`);
          }

          // verdict
          const profileReport = fer.profileReports.find((r) => r.profile === pf.profile);
          // Fresh-valid (intrabar-validated) economics
          if (typeof pf.freshValidResolved === "number") {
            const fvWrStr = pf.freshValidWr !== null && pf.freshValidWr !== undefined ? `${(pf.freshValidWr * 100).toFixed(1)}%` : "n/a";
            const fvNetStr = pf.freshValidNetAvgR !== null && pf.freshValidNetAvgR !== undefined ? pf.freshValidNetAvgR.toFixed(4) : "n/a";
            const fvPfStr = pf.freshValidPf !== null && pf.freshValidPf !== undefined ? pf.freshValidPf.toFixed(2) : "n/a";
            wLines.push(`    Fresh-valid: resolved=${pf.freshValidResolved} | WR=${fvWrStr} | netAvgR=${fvNetStr} | PF=${fvPfStr}`);
          }

          const verdictLabel = profileReport
            ? profileReport.verdict === "TOO_EARLY"
              ? "TOO_EARLY (need ≥20 resolved)"
              : profileReport.verdict
            : "TOO_EARLY (need ≥20 resolved)";
          wLines.push(`    Verdict: ${verdictLabel}`);
        }
      } else {
        // Fallback to simpler existing format
        const hasAnyObs = fer.profileReports.some((pr) => pr.totalObs > 0);
        if (!hasAnyObs) {
          wLines.push(
            "  No observations yet — admission filters active, waiting for scan candidates.",
          );
        } else {
          for (const pr of fer.profileReports) {
            const wrStr = pr.wr !== null ? `${(pr.wr * 100).toFixed(1)}%` : "n/a";
            const netStr = pr.netAvgR !== null ? pr.netAvgR.toFixed(4) : "n/a";
            const pfStr = pr.pf !== null ? pr.pf.toFixed(2) : "n/a";
            wLines.push(`  Profile ${pr.profile}:`);
            wLines.push(
              `    totalObs=${pr.totalObs} | open=${pr.openObs} | resolved=${pr.resolvedObs} | WR=${wrStr} | netAvgR=${netStr} | PF=${pfStr}`,
            );
            const verdictLabel =
              pr.verdict === "TOO_EARLY"
                ? "TOO_EARLY (need ≥20 resolved)"
                : pr.verdict;
            wLines.push(`    Verdict: ${verdictLabel}`);
          }
        }
      }

      // recentResolved block
      if (fer.recentResolved && fer.recentResolved.length > 0) {
        wLines.push("  Last 5 resolved:");
        fer.recentResolved.forEach((r, i) => {
          const grossStr = r.grossR !== null ? r.grossR.toFixed(2) : "n/a";
          const netStr = r.netR !== null ? r.netR.toFixed(2) : "n/a";
          const durStr = r.durationMinutes !== null ? `${r.durationMinutes}min` : "n/a";
          const mfeStr = r.maxMfeR !== null ? r.maxMfeR.toFixed(2) : "n/a";
          const maeStr = r.minMaeR !== null ? r.minMaeR.toFixed(2) : "n/a";
          const stopStr = r.stopDistanceBps !== null ? `${r.stopDistanceBps.toFixed(0)}bps` : "n/a";
          const costStr = r.costR !== null ? r.costR.toFixed(2) : "n/a";
          const regimeStr = r.regimeAtEntry ?? "UNKNOWN";
          const entryVariantStr = r.entryVariant ?? "UNKNOWN";
          const exitVariantStr = r.exitVariant ?? "UNKNOWN";
          const flags = [
            r.immediateSl ? "[immediateSL]" : null,
            r.noMfeBeforeSl ? "[noMFE]" : null,
            r.intrabarResolutionStatus ? `[${r.intrabarResolutionStatus}]` : null,
            r.isFreshValid === true ? "[freshValid]" : (r.isFreshValid === false || r.excludedReason) ? `[excluded: ${r.excludedReason ?? "unknown"}]` : null,
          ].filter(Boolean).join(" ");
          wLines.push(
            `    ${i + 1}. ${r.symbol} ${r.direction} [${r.profile}] regime=${regimeStr} entry=${entryVariantStr} exit=${exitVariantStr} stop=${stopStr} costR=${costStr} grossR=${grossStr} netR=${netStr} close=${r.closeReason ?? "n/a"} dur=${durStr} chronology=${r.chronologyStatus} pathMetric=${r.pathMetricStatus} MFE=${mfeStr} MAE=${maeStr}${flags ? ` ${flags}` : ""} | ${r.reasonSummary}`,
          );
        });
      }

      wLines.push("- report-only, isolated; data/shadow-positions.json untouched");
      return wLines;
    })(),
    "",
    "W****. PARALLEL SHADOW EXPERIMENT MATRIX (REPORT-ONLY)",
    ...(() => {
      const matrix = opts.parallelShadowExperimentReport;
      if (!matrix) return ["  [unavailable]"];
      const mLines: string[] = [];
      mLines.push(`- Lane: ${matrix.laneVersion} | experiments=${matrix.experimentCount}`);
      mLines.push("- Fresh-valid economics only; anti-overfit gates require n>=30, netAvgR>+0.05R, PF>1.20, >=3 calendar days, topSymbolShare<=60%, and baseline outperformance.");
      const diag = matrix.latestAdmissionDiagnostics;
      if (diag) {
        const topRejects = diag.rejectedByReason.length > 0
          ? diag.rejectedByReason.slice(0, 5).map((r) => `${r.reason}(${r.count})`).join(", ")
          : "none";
        const missingFields = Object.entries(diag.fieldMissingCounts)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([field, count]) => `${field}(${count})`)
          .join(", ");
        mLines.push(
          `- Admission diagnostics: disabled=${diag.disabled} | invoked=${diag.matrixAdmissionInvoked} | lastAdmissionAt=${diag.lastAdmissionAt ?? "n/a"} | batch=${diag.lastScanBatchId ?? "n/a"}`,
        );
        mLines.push(
          `  candidatesSeen=${diag.candidatesSeen} | candidatesEvaluated=${diag.candidatesEvaluated} | created=${diag.observationsCreated} | duplicateSuppressed=${diag.duplicateSuppressed} | rejected=${diag.rejectedTotal}`,
        );
        mLines.push(`  topRejects=${topRejects}`);
        mLines.push(`  fieldMissing=${missingFields || "none"}`);
      } else {
        mLines.push("- Admission diagnostics: disabled=unknown | invoked=false | lastAdmissionAt=n/a");
        mLines.push("  candidatesSeen=0 | candidatesEvaluated=0 | created=0 | duplicateSuppressed=0 | rejected=0");
      }
      for (const row of matrix.rows) {
        const net = row.netAvgR !== null ? row.netAvgR.toFixed(4) : "n/a";
        const pf = row.pf !== null ? row.pf.toFixed(2) : "n/a";
        const wr = row.wr !== null ? `${(row.wr * 100).toFixed(1)}%` : "n/a";
        const cost = row.avgCostR !== null ? row.avgCostR.toFixed(4) : "n/a";
        const days = row.calendarDays !== null ? row.calendarDays.toFixed(1) : "n/a";
        const topShare = row.topSymbolShare !== null ? `${(row.topSymbolShare * 100).toFixed(1)}%` : "n/a";
        const blockerText = row.blockers.length > 0 ? row.blockers.slice(0, 3).join("; ") : "none";
        mLines.push(
          `  ${row.experimentId}: total=${row.total} | open=${row.open} | resolved=${row.resolved} | freshValid=${row.freshValid} | netAvgR=${net} | PF=${pf} | WR=${wr} | avgCostR=${cost} | days=${days} | topSymbolShare=${topShare} | status=${row.status} | blockers=${blockerText}`,
        );
      }
      mLines.push("- report-only, isolated; data/parallel-shadow-experiments.json only");
      return mLines;
    })(),
    "",
    "W*****. SHADOW LANE SCOREBOARD (REPORT-ONLY)",
    ...(() => {
      const sb = shadowLaneScoreboard;
      const lines2: string[] = [];
      lines2.push(`  All entries: ${sb.allEntries.length} lanes tracked`);
      const fmtEntry = (e: ShadowLaneScoreboardEntry): string => {
        const sample = Number.isFinite(e.freshValidResolved) ? String(e.freshValidResolved) : "n/a";
        const net = e.freshValidNetAvgR !== null ? e.freshValidNetAvgR.toFixed(4) : "n/a";
        const pf = e.freshValidPF !== null && Number.isFinite(e.freshValidPF) ? e.freshValidPF.toFixed(2) : "n/a";
        return `${e.laneId} n=${sample} net=${net} PF=${pf}`;
      };
      lines2.push("  Top 5 by freshValid netAvgR:");
      if (sb.top5ByFreshValidNet.length === 0) lines2.push("    (none)");
      else sb.top5ByFreshValidNet.forEach((e, i) => lines2.push(`    ${i + 1}. ${fmtEntry(e)}`));
      lines2.push("  Top 5 by PF:");
      if (sb.top5ByPF.length === 0) lines2.push("    (none)");
      else sb.top5ByPF.forEach((e, i) => lines2.push(`    ${i + 1}. ${fmtEntry(e)}`));
      lines2.push("  Fastest collecting (last 7d):");
      if (sb.fastestCollecting.length === 0) lines2.push("    (none)");
      else sb.fastestCollecting.forEach((e, i) => lines2.push(
        `    ${i + 1}. ${e.laneId} admission=${e.admissionVelocityPerDay !== null ? e.admissionVelocityPerDay.toFixed(2) : "n/a"}/day | resolved=${e.resolvedVelocityPerDay !== null ? e.resolvedVelocityPerDay.toFixed(2) : "n/a"}/day | freshValid=${e.freshValidVelocityPerDay !== null ? e.freshValidVelocityPerDay.toFixed(2) : "n/a"}/day`,
      ));
      lines2.push("  Near n=20 (need <5 more to reach evidence threshold):");
      if (sb.nearN20.length === 0) lines2.push("    (none)");
      else sb.nearN20.forEach((e, i) => lines2.push(`    ${i + 1}. ${fmtEntry(e)}`));
      lines2.push("  Near n=30:");
      if (sb.nearN30.length === 0) lines2.push("    (none)");
      else sb.nearN30.forEach((e, i) => lines2.push(`    ${i + 1}. ${fmtEntry(e)}`));
      lines2.push("  Candidate lanes from base route:");
      if (sb.candidateLanesFromBaseRoute.length === 0) {
        lines2.push("    (none)");
      } else {
        for (const e of sb.candidateLanesFromBaseRoute) {
          const sample = Number.isFinite(e.freshValidResolved) ? String(e.freshValidResolved) : "n/a";
          const net = e.freshValidNetAvgR !== null ? e.freshValidNetAvgR.toFixed(4) : "n/a";
          const pf = e.freshValidPF !== null && Number.isFinite(e.freshValidPF) ? e.freshValidPF.toFixed(2) : "n/a";
          const wr = e.freshValidWR !== null && Number.isFinite(e.freshValidWR) ? `${(e.freshValidWR * 100).toFixed(1)}%` : "n/a";
          lines2.push(
            `    - ${e.laneId}: closed=${sample} net=${net} PF=${pf} WR=${wr} status=${e.status}`,
          );
          if (e.cautions && e.cautions.length > 0) {
            for (const c of e.cautions) {
              lines2.push(`      Caution: ${c}`);
            }
          }
        }
      }
      lines2.push("  Killed lanes:");
      sb.killedLanes.forEach((e) => lines2.push(`    - ${e.laneId} — KILLED: ${e.killedReason ?? "no reason"}`));
      lines2.push(
        `  Promotion candidates: ${sb.promotionCandidates.length === 0 ? "NONE (no lane meets PF>1.20 + n≥100 threshold)" : sb.promotionCandidates.map((e) => e.laneId).join(", ")}`,
      );
      lines2.push("  report-only, advisory; no behavior influence");
      return lines2;
    })(),
    "",
    "Z**. REGIME CONTROLLER RETROSPECTIVE AUDIT (REPORT-ONLY)",
    ...(() => {
      const retro = regimeControllerRetroAudit;
      const zLines: string[] = [];
      zLines.push(
        `- Closed positions audited: ${retro.totalClosed} | withRegime: ${retro.withRegime} | noRegime: ${retro.noRegime}`,
      );
      const fmtR = (v: number | null) => (typeof v === "number" ? v.toFixed(4) : "n/a");
      const fmtPF = (v: number | null) => (typeof v === "number" ? v.toFixed(2) : "n/a");
      const allowed = retro.byDecision.find((r) => r.decision === "ALLOWED");
      const blocked = retro.byDecision.find((r) => r.decision === "BLOCKED");
      const unknown = retro.byDecision.find((r) => r.decision === "UNKNOWN");
      zLines.push(
        `- Allowed: n=${allowed?.n ?? 0} netAvgR=${fmtR(allowed?.netAvgR ?? null)} PF=${fmtPF(allowed?.PF ?? null)}`,
      );
      zLines.push(
        `- Blocked: n=${blocked?.n ?? 0} netAvgR=${fmtR(blocked?.netAvgR ?? null)} PF=${fmtPF(blocked?.PF ?? null)}`,
      );
      zLines.push(`- Unknown: n=${unknown?.n ?? 0}`);
      zLines.push("- WARNING: retrospective only — not prospective validation");
      zLines.push("- (report-only, no behavior influence)");
      return zLines;
    })(),
    "",
    "AA. STRATEGIC PROFIT ROADMAP (REPORT-ONLY)",
    ...(() => {
      const r = strategyResearchRoadmapReport;
      const out: string[] = [];
      out.push(`  Current branch verdict: ${r.currentBranchVerdict.verdict}`);
      out.push(`  Summary: ${r.currentBranchVerdict.summary}`);
      out.push("  Key evidence:");
      for (const e of r.currentBranchVerdict.keyEvidence) out.push(`    - ${e}`);
      out.push("  Killed workstreams:");
      for (const k of r.killedWorkstreams) out.push(`    - ${k.name}: ${k.reason}`);
      out.push("  Keep testing:");
      for (const k of r.keepTestingWorkstreams) out.push(`    - ${k.name} (${k.reason})`);
      out.push("  Next strategy families (priority order):");
      for (const f of r.nextStrategyFamilies) {
        out.push(`    ${f.priority}. ${f.name} (${f.expectedTimeToEvidence})`);
      }
      out.push(`  Micro-pilot blockers (${r.microPilotBlockers.length}):`);
      for (const b of r.microPilotBlockers) out.push(`    - ${b}`);
      out.push("  30-day plan:");
      for (const m of r.thirtyDayPlan) {
        out.push(`    day ${m.day}: ${m.action} [${m.owner}]${m.blockedBy ? ` (blockedBy: ${m.blockedBy})` : ""}`);
      }
      out.push("  90-day plan:");
      for (const m of r.ninetyDayPlan) {
        out.push(`    day ${m.day}: ${m.action} [${m.owner}]${m.blockedBy ? ` (blockedBy: ${m.blockedBy})` : ""}`);
      }
      out.push("  report-only, advisory; no behavior influence");
      return out;
    })(),
    "",
    "AB. PORTFOLIO TREND SHADOW V1 (REPORT-ONLY)",
    ...(() => {
      const r = opts.portfolioTrendReport;
      if (!r) return ["  [unavailable]"];
      const out: string[] = [];
      out.push(`  Lane: ${r.laneVersion}`);
      out.push(`  Status: ${r.status} (${r.statusReason})`);
      out.push(
        `  totalObs=${r.totalObs} | open=${r.openObs} | resolved=${r.resolvedObs} | freshValid=${r.freshValidResolved}`,
      );
      const fmtR = (v: number | null) =>
        typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "n/a";
      const fmtPct2 = (v: number | null) =>
        typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "n/a";
      const fmtPF = (v: number | null) =>
        typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "n/a";
      out.push(
        `  netAvgR=${fmtR(r.freshValidNetAvgR)} | PF=${fmtPF(r.freshValidPF)} | WR=${fmtPct2(r.freshValidWR)}`,
      );
      out.push(
        `  Avg holding: ${typeof r.avgHoldingHours === "number" ? r.avgHoldingHours.toFixed(1) : "n/a"} hours | Turnover: ${typeof r.turnoverPerDay === "number" ? r.turnoverPerDay.toFixed(2) : "n/a"} / day`,
      );
      out.push("  Symbol concentration:");
      if (r.symbolConcentration.length === 0) out.push("    (none)");
      else {
        for (const s of r.symbolConcentration.slice(0, 5)) {
          out.push(`    ${s.symbol}: n=${s.n} (${(s.share * 100).toFixed(1)}%)`);
        }
      }
      out.push("  Regime breakdown:");
      if (r.byRegime.length === 0) out.push("    (none)");
      else for (const b of r.byRegime) out.push(`    ${b.regime}: n=${b.n} net=${fmtR(b.netAvgR)}`);
      out.push("  Cost sensitivity:");
      out.push(`    At default cost:     net=${fmtR(r.costSensitivity.atDefault)}`);
      out.push(`    At 10bps round-trip: net=${fmtR(r.costSensitivity.at10bpsRoundtrip)}`);
      out.push(`    At 50bps round-trip: net=${fmtR(r.costSensitivity.at50bpsRoundtrip)}`);
      out.push("  report-only, isolated; data/shadow-positions.json untouched");
      return out;
    })(),
    "",
    "AE. KILL SWITCH READINESS (REPORT-ONLY SPEC)",
    ...(() => {
      const r = killSwitchReadiness;
      const out: string[] = [];
      out.push(`  Module: ${r.module}`);
      out.push(`  implemented=${r.implemented} | ready=${r.ready}`);
      out.push(`  Summary: ${r.summary}`);
      out.push("  Controls (all unimplemented):");
      for (const c of r.controls) {
        out.push(`    - ${c.name}: ${c.recommendedThreshold}`);
      }
      out.push(`  Missing controls: ${r.missingControls.length}/${r.controls.length}`);
      out.push("  no behavior influence");
      return out;
    })(),
    "",
    "AF. ORDER RECONCILIATION READINESS (REPORT-ONLY SPEC)",
    ...(() => {
      const r = orderReconciliationReadiness;
      const out: string[] = [];
      out.push(`  Module: ${r.module}`);
      out.push(`  implemented=${r.implemented} | ready=${r.ready}`);
      out.push(`  Summary: ${r.summary}`);
      out.push(
        `  Lifecycle stages tracked: ${r.lifecycleStages.filter((s) => s.tracked).length}/${r.lifecycleStages.length}`,
      );
      out.push(`  Required ledger fields: ${r.requiredLedgerFields.join(", ")}`);
      out.push(`  Required exchange checks: ${r.requiredExchangeChecks.join(", ")}`);
      out.push("  Risks if missing:");
      for (const risk of r.risksIfMissing) out.push(`    - ${risk}`);
      out.push("  no behavior influence");
      return out;
    })(),
    "",
    "AG. EXCHANGE HEALTH READINESS (REPORT-ONLY SPEC)",
    ...(() => {
      const r = exchangeHealthReadiness;
      const out: string[] = [];
      out.push(`  Module: ${r.module}`);
      out.push(`  implemented=${r.implemented} | ready=${r.ready}`);
      out.push(`  Summary: ${r.summary}`);
      out.push(`  Available checks: ${r.availableCount}/${r.checks.length}`);
      out.push("  Checks:");
      for (const c of r.checks) {
        out.push(
          `    [${c.available ? "✓" : " "}] ${c.name} (${c.source})${c.currentValue ? ` — ${c.currentValue}` : ""}`,
        );
      }
      if (r.missingChecks.length > 0) {
        out.push(`  Missing checks: ${r.missingChecks.join(", ")}`);
      }
      out.push("  no behavior influence");
      return out;
    })(),
    "",
    "AD. LIVE TRADING GATE V1 (HARD BLOCK)",
    ...(() => {
      const r = liveTradingGateReport;
      const out: string[] = [];
      out.push(`  Lane: ${r.lane}`);
      out.push(`  liveBlocked: ${r.liveBlocked}`);
      out.push(`  microPilotAllowed: ${r.microPilotAllowed}`);
      out.push(`  Frozen candidate status (F****): ${r.frozenCandidateStatus ?? "n/a"}`);
      out.push("  Infrastructure readiness:");
      out.push(`    killSwitchReady: ${r.killSwitchReady} (see AE)`);
      out.push(`    orderReconciliationReady: ${r.orderReconciliationReady} (see AF)`);
      out.push(`    exchangeHealthReady: ${r.exchangeHealthReady} (see AG)`);
      out.push(`  Summary: ${r.summary}`);
      out.push("  Blockers:");
      for (const b of r.blockers) {
        out.push(`    [${b.status}] ${b.gate}: required ${b.required}; current ${b.current}`);
        if (b.detail) {
          out.push(`      ${b.detail}`);
        }
      }
      out.push(
        "  liveBlocked stays true while KILL_SWITCH / ORDER_RECONCILIATION / EXCHANGE_HEALTH gates FAIL",
      );
      if (r.nearestCandidateLane) {
        const n = r.nearestCandidateLane;
        const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(4));
        out.push("  Nearest candidate lane:");
        out.push(
          `    ${n.lane}: freshValid=${n.freshValidResolved}, netAvgR=${fmt(n.netAvgR)}, PF=${fmt(n.pf)}`,
        );
        out.push(`    Closest to passing: ${n.closestToPassing}`);
        if (n.cautions && n.cautions.length > 0) {
          out.push("    Cautions:");
          for (const c of n.cautions) {
            out.push(`      - ${c}`);
          }
        }
      }
      if (r.bestVariantMatrixCandidate) {
        const v = r.bestVariantMatrixCandidate;
        const fmt = (val: number | null) => (val === null ? "n/a" : val.toFixed(4));
        out.push("  Best variant-matrix candidate (advisory only — see F*******):");
        out.push(
          `    ${v.variantId} (${v.label}): freshValid=${v.freshValid}, netAvgR=${fmt(v.netAvgR)}, PF=${fmt(v.pf)}, status=${v.status}, beatsBaseline=${v.beatsBaseline ? "YES" : "NO"}`,
        );
        out.push(
          "    Forward A/B geometry experiment — never folded into the route promotion ladder; liveBlocked stays true",
        );
      }
      // Adaptive Lane Router advisory (AH) — read-only, never overrides gates.
      out.push("  Adaptive Lane Router (AH, advisory only):");
      out.push(
        `    selected lane: ${adaptiveLaneRouterReport.selectedCurrentLane ?? "none"} (maturity=${adaptiveLaneRouterReport.selectedCurrentLaneMaturity})`,
      );
      out.push(`    router permission: ${adaptiveLaneRouterReport.currentPermission}`);
      out.push(
        "    Router cannot override infra gates — liveBlocked stays true, microPilotAllowed stays false",
      );
      out.push(
        "  Micro-pilot still blocked until all infra modules (AE/AF/AG) are ready AND F*** promotion gates pass",
      );
      return out;
    })(),
    "",
    "AH. ADAPTIVE LANE ROUTER V1 (REPORT-ONLY)",
    ...(() => {
      const r = adaptiveLaneRouterReport;
      const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(4));
      const out: string[] = [];
      out.push(`  regime: ${r.currentRegime ?? "unknown"} (${r.regimeFamily}) | mode: ${r.controllerMode}`);
      out.push(`  currentPermission: ${r.currentPermission}`);
      out.push(`  liveBlocked: ${r.liveBlocked} | microPilotAllowed: ${r.microPilotAllowed}`);
      out.push(
        `  selected lane: ${r.selectedCurrentLane ?? "none"} (maturity=${r.selectedCurrentLaneMaturity})`,
      );
      out.push(`  why: ${r.selectedCurrentLaneReason}`);
      out.push("  Ranked candidates:");
      if (r.rankedCandidates.length === 0) out.push("    (none)");
      for (const c of r.rankedCandidates.slice(0, 5)) {
        out.push(
          `    ${c.laneId}: maturity=${c.maturity}, score=${c.score.toFixed(2)}, n=${c.freshValid}, netAvgR=${fmt(c.netAvgR)}, PF=${fmt(c.pf)}`,
        );
      }
      out.push("  Rejected / deprioritized:");
      if (r.rejectedOrDeprioritizedLanes.length === 0) out.push("    (none)");
      for (const c of r.rejectedOrDeprioritizedLanes.slice(0, 5)) {
        out.push(
          `    ${c.laneId}: maturity=${c.maturity}${c.rejectReasons.length ? ` — ${c.rejectReasons.join("; ")}` : ""}`,
        );
      }
      out.push("  Per-regime policy:");
      for (const fam of ["BEARISH", "BULLISH", "MIXED", "CHOP", "UNKNOWN"] as const) {
        const p = r.perRegimePolicy[fam];
        out.push(`    ${fam}: lane=${p.recommendedLaneId ?? "—"}, permission=${p.permission} — ${p.note}`);
      }
      out.push("  Blockers:");
      for (const b of r.blockers) out.push(`    - ${b}`);
      out.push("  Next required evidence:");
      for (const e of r.nextRequiredEvidence) out.push(`    - ${e}`);
      if (r.warnings.length > 0) {
        out.push("  Warnings:");
        for (const w of r.warnings) out.push(`    - ${w}`);
      }
      out.push("  no behavior influence — advisory only");
      return out;
    })(),
    "",
    "M. ONE-LINE EXECUTIVE TAKEAWAY",
    `- ${executiveTakeaway}`,
  ].filter((line): line is string => typeof line === "string");

  return {
    generatedAt,
    era,
    summaryText: lines.join("\n"),
    highlights,
  };
}

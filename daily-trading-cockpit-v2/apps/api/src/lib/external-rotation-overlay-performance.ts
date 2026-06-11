import type { ExternalDiscoveryEvidenceEra } from "./external-candidate-discovery-intelligence.js";
import {
  classifyExternalRotationOverlayValidity,
  type ExternalRotationOverlayGroup,
  type ExternalRotationOverlayObservation,
  type ExternalRotationOverlayRefreshDiagnostics,
} from "./external-rotation-overlay.js";
import type { ExternalRotationOverlayAutoRefreshStatus } from "./external-rotation-overlay-auto-refresh.js";
import {
  buildGlobalInterpretability,
  classifyExternalOverlayEconomicsCredibility,
  type NetRotationComparisonStatus,
  type GrossDirectionalComparisonStatus,
} from "./external-rotation-overlay-economics.js";

export interface ExternalOverlayEconomicsInterpretabilityCompact {
  netRotationComparisonStatus: NetRotationComparisonStatus;
  grossDirectionalComparisonStatus: GrossDirectionalComparisonStatus;
  interpretableCount: number;
  distortedCount: number;
  borderlineCount: number;
  totalClassified: number;
  warningMessage: string | null;
}

export type ExternalRotationOverlayEarlyVerdict =
  | "NO_FORWARD_EVIDENCE_YET"
  | "TOO_EARLY"
  | "EARLY_SUPPORTIVE"
  | "EARLY_HARMFUL"
  | "WATCHABLE_SUPPORTIVE"
  | "WATCHABLE_HARMFUL"
  | "MIXED";

export interface ExternalRotationOverlayMetricBlock {
  observationCount: number;
  resolvedCount: number;
  headlineResolvedCount: number;
  distortedExcludedFromHeadline: number;
  borderlineExcludedFromHeadline: number;
  noFillCount: number;
  expiredCount: number;
  failedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  noFillRate: number | null;
  averageDurationMinutes: number | null;
  earlyVerdict: ExternalRotationOverlayEarlyVerdict;
}

export interface ExternalRotationOverlayGroupPerformance extends ExternalRotationOverlayMetricBlock {
  group: ExternalRotationOverlayGroup;
  comparisonVsMetadataBaseline: {
    deltaNetAvgR: number | null;
    deltaProfitFactor: number | null;
    deltaNoFillRate: number | null;
  };
}

export interface ExternalRotationOverlayValidityCounts {
  rawObservationCount: number;
  validObservationCount: number;
  legacyInvalidExcludedCount: number;
}

export interface ExternalRotationOverlayPerformanceReport {
  generatedAt: string;
  evidenceEra: ExternalDiscoveryEvidenceEra;
  /** Operative count — equals validObservationCount. Legacy v1 observations are excluded. */
  totalObservations: number;
  openObservations: number;
  resolvedObservations: number;
  noFillObservations: number;
  expiredObservations: number;
  failedObservations: number;
  /** Raw / valid / excluded split (transparency on policy-version filtering). */
  validityCounts: ExternalRotationOverlayValidityCounts;
  duplicateSuppressionStats: {
    diagnosticsAvailable: boolean;
    lastRefreshAt: string | null;
    triggerSource: "AUTO" | "MANUAL" | null;
    observationsConsidered: number | null;
    observationsCreated: number | null;
    observationsSuppressedAsDuplicate: number | null;
    observationsSkippedForInsufficientState: number | null;
    rejectedForEconomicDistortionCount: number | null;
  };
  autoRefresh: ExternalRotationOverlayAutoRefreshStatus;
  groupPerformance: ExternalRotationOverlayGroupPerformance[];
  overlapDiagnostics: {
    multiGroupObservationCount: number;
    strategyFitAndMetadataOverlapCount: number;
    uniqueSymbolsObserved: number;
  };
  currentBestObservedGroup: ExternalRotationOverlayGroupPerformance | null;
  readiness: {
    advisoryEngineReady: boolean;
    readyForUniverseInfluence: false;
    readyForRotationDiscussion: false;
    reasons: string[];
  };
  patchHypotheses: Array<{
    title: string;
    evidenceSummary: string;
    confidence: "LOW" | "MEDIUM" | "HIGH";
    patchStatus: "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";
    doesNotImplementNow: true;
  }>;
  answerCards: Array<{ question: string; answer: string }>;
  economicsInterpretability: ExternalOverlayEconomicsInterpretabilityCompact;
}

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function profitFactor(values: number[]): number | null {
  const wins = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (wins <= 0 && losses <= 0) return null;
  if (losses <= 0) return wins > 0 ? null : 0;
  return roundMetric(wins / losses, 4);
}

function average(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return roundMetric(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function verdict(metrics: Omit<ExternalRotationOverlayMetricBlock, "earlyVerdict">, baseline: ExternalRotationOverlayMetricBlock | null): ExternalRotationOverlayEarlyVerdict {
  if (metrics.headlineResolvedCount === 0) return "NO_FORWARD_EVIDENCE_YET";
  if (metrics.headlineResolvedCount < 10) return "TOO_EARLY";
  if (!baseline || baseline.headlineResolvedCount === 0 || metrics.netAvgR === null || baseline.netAvgR === null) return "MIXED";
  const delta = metrics.netAvgR - baseline.netAvgR;
  if (metrics.headlineResolvedCount >= 30 && delta >= 0.2) return "WATCHABLE_SUPPORTIVE";
  if (metrics.headlineResolvedCount >= 30 && delta <= -0.2) return "WATCHABLE_HARMFUL";
  if (delta >= 0.15) return "EARLY_SUPPORTIVE";
  if (delta <= -0.15) return "EARLY_HARMFUL";
  return "MIXED";
}

function metricsFor(observations: ExternalRotationOverlayObservation[], baseline: ExternalRotationOverlayMetricBlock | null = null): ExternalRotationOverlayMetricBlock {
  const resolved = observations.filter((item) => item.outcome?.fillStatus === "FILLED" && item.outcome.realizedNetR !== null);
  const classifiedResolved = resolved.map((item) => ({
    item,
    credibility: classifyExternalOverlayEconomicsCredibility(item),
  }));
  const headlineResolved = classifiedResolved
    .filter((entry) => entry.credibility.credibilityStatus === "ECONOMICALLY_INTERPRETABLE")
    .map((entry) => entry.item);
  const netValues = headlineResolved.map((item) => item.outcome!.realizedNetR!);
  const grossValues = headlineResolved.map((item) => item.outcome!.realizedGrossR).filter((value): value is number => typeof value === "number");
  const distortedExcludedFromHeadline = classifiedResolved.filter((entry) => entry.credibility.credibilityStatus === "ECONOMICALLY_DISTORTED").length;
  const borderlineExcludedFromHeadline = classifiedResolved.filter((entry) => entry.credibility.credibilityStatus === "BORDERLINE").length;
  const noFill = observations.filter((item) => item.observationStatus === "NO_FILL" || item.outcome?.fillStatus === "NO_FILL").length;
  const expired = observations.filter((item) => item.observationStatus === "EXPIRED").length;
  const failed = observations.filter((item) => item.observationStatus === "FAILED").length;
  const block = {
    observationCount: observations.length,
    resolvedCount: resolved.length,
    headlineResolvedCount: headlineResolved.length,
    distortedExcludedFromHeadline,
    borderlineExcludedFromHeadline,
    noFillCount: noFill,
    expiredCount: expired,
    failedCount: failed,
    netAvgR: average(netValues),
    grossAvgR: average(grossValues),
    profitFactor: profitFactor(netValues),
    winRate: headlineResolved.length ? roundMetric(headlineResolved.filter((item) => item.outcome?.winnerLabel === "WIN").length / headlineResolved.length) : null,
    tp1ProfitableRate: headlineResolved.length ? roundMetric(headlineResolved.filter((item) => item.outcome?.tp1Hit && (item.outcome.realizedNetR ?? 0) > 0).length / headlineResolved.length) : null,
    slRate: headlineResolved.length ? roundMetric(headlineResolved.filter((item) => item.outcome?.slHit).length / headlineResolved.length) : null,
    noFillRate: observations.length ? roundMetric(noFill / observations.length) : null,
    averageDurationMinutes: average(headlineResolved.map((item) => item.outcome?.durationMinutes)),
  };
  return {
    ...block,
    earlyVerdict: verdict(block, baseline),
  };
}

function operativeStatusCounts(observations: ExternalRotationOverlayObservation[]) {
  let open = 0;
  let resolved = 0;
  let noFill = 0;
  let expired = 0;
  let failed = 0;

  for (const item of observations) {
    switch (item.observationStatus) {
      case "FAILED":
        failed += 1;
        break;
      case "EXPIRED":
        expired += 1;
        break;
      case "RESOLVED":
        resolved += 1;
        break;
      case "NO_FILL":
        noFill += 1;
        break;
      case "OPEN":
      default:
        open += 1;
        break;
    }
  }

  return {
    openObservations: open,
    resolvedObservations: resolved,
    noFillObservations: noFill,
    expiredObservations: expired,
    failedObservations: failed,
  };
}

export function buildExternalRotationOverlayPerformanceReport(
  observations: ExternalRotationOverlayObservation[],
  opts: {
    evidenceEra?: ExternalDiscoveryEvidenceEra;
    lastRefreshDiagnostics?: ExternalRotationOverlayRefreshDiagnostics | null;
    autoRefreshStatus?: ExternalRotationOverlayAutoRefreshStatus | null;
  } = {},
  now: Date = new Date(),
): ExternalRotationOverlayPerformanceReport {
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const rawEraObservations = evidenceEra === "ALL_TIME"
    ? observations
    : observations.filter((item) => item.evidenceEra === "POST_CALIBRATION");
  // Filter out V1 (entry-anchor / fill-price unit mismatch) observations. They
  // are preserved in the store for audit trail but excluded from operative
  // metrics because their costR / gross R were in inconsistent risk denominators.
  const eraObservations = rawEraObservations.filter(
    (item) => classifyExternalRotationOverlayValidity(item) === "VALID",
  );
  const legacyInvalidExcludedCount = rawEraObservations.length - eraObservations.length;
  const validityCounts: ExternalRotationOverlayValidityCounts = {
    rawObservationCount: rawEraObservations.length,
    validObservationCount: eraObservations.length,
    legacyInvalidExcludedCount,
  };
  const metadataObservations = eraObservations.filter((item) => item.overlayGroups.includes("METADATA_DISCOVERY_BASELINE"));
  const metadataBaseline = metricsFor(metadataObservations, null);
  const groups: ExternalRotationOverlayGroup[] = ["STRATEGY_FIT_SHORTLIST", "METADATA_DISCOVERY_BASELINE", "LOW_FIT_CONTROL"];
  const groupPerformance = groups.map((group): ExternalRotationOverlayGroupPerformance => {
    const metrics = metricsFor(eraObservations.filter((item) => item.overlayGroups.includes(group)), metadataBaseline);
    return {
      group,
      ...metrics,
      comparisonVsMetadataBaseline: {
        deltaNetAvgR: metrics.netAvgR !== null && metadataBaseline.netAvgR !== null ? roundMetric(metrics.netAvgR - metadataBaseline.netAvgR) : null,
        deltaProfitFactor: metrics.profitFactor !== null && metadataBaseline.profitFactor !== null ? roundMetric(metrics.profitFactor - metadataBaseline.profitFactor) : null,
        deltaNoFillRate: metrics.noFillRate !== null && metadataBaseline.noFillRate !== null ? roundMetric(metrics.noFillRate - metadataBaseline.noFillRate) : null,
      },
    };
  });
  const currentBestObservedGroup = [...groupPerformance]
    .filter((group) => group.headlineResolvedCount > 0 && group.netAvgR !== null)
    .sort((a, b) => (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity))[0] ?? null;
  const operativeCounts = operativeStatusCounts(eraObservations);
  const resolved = eraObservations.filter((item) => item.outcome?.fillStatus === "FILLED").length;
  const inferredLastRefreshAt = eraObservations
    .map((item) => item.createdAt)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
  const diagnosticsAvailable = Boolean(opts.lastRefreshDiagnostics);
  const reasons = [
    "External rotation overlay is prospective research evidence only.",
    "readyForUniverseInfluence is always false in Phase 2E.3.",
    "readyForRotationDiscussion requires at least 30 resolved overlay observations in a group, multiple unique symbols, and material outperformance vs comparator.",
  ];
  if (legacyInvalidExcludedCount > 0) {
    reasons.unshift(
      `Excluded ${legacyInvalidExcludedCount} legacy V1 observations contaminated by the entry-anchor / fill-price unit mismatch; valid post-fix tape is being collected.`,
    );
  }
  if (resolved === 0) reasons.unshift("No resolved external overlay observations yet.");
  else if (resolved < 30) reasons.unshift("Resolved external overlay sample is still too small for rotation discussion.");
  const strategyFit = groupPerformance.find((group) => group.group === "STRATEGY_FIT_SHORTLIST")!;
  const metadata = groupPerformance.find((group) => group.group === "METADATA_DISCOVERY_BASELINE")!;
  const patchHypotheses = [
    {
      title: strategyFit.headlineResolvedCount === 0 ? "Collect forward overlay evidence before judging strategy-fit enrichment" : "Continue comparing strategy-fit shortlist vs metadata baseline",
      evidenceSummary: strategyFit.headlineResolvedCount === 0
        ? "No strategy-fit overlay observations have resolved yet."
        : `Strategy-fit interpretable resolved=${strategyFit.headlineResolvedCount}, netAvgR=${strategyFit.netAvgR}; metadata baseline interpretable resolved=${metadata.headlineResolvedCount}, netAvgR=${metadata.netAvgR}.`,
      confidence: "LOW" as const,
      patchStatus: "WATCH" as const,
      doesNotImplementNow: true as const,
    },
  ];

  const globalInterp = buildGlobalInterpretability(eraObservations);
  const economicsInterpretability: ExternalOverlayEconomicsInterpretabilityCompact = {
    netRotationComparisonStatus: globalInterp.netRotationComparisonStatus,
    grossDirectionalComparisonStatus: globalInterp.grossDirectionalComparisonStatus,
    interpretableCount: globalInterp.interpretableCount,
    distortedCount: globalInterp.distortedCount,
    borderlineCount: globalInterp.borderlineCount,
    totalClassified: globalInterp.totalClassified,
    warningMessage: globalInterp.warningMessage,
  };

  return {
    generatedAt: now.toISOString(),
    evidenceEra,
    totalObservations: eraObservations.length,
    ...operativeCounts,
    validityCounts,
    duplicateSuppressionStats: {
      diagnosticsAvailable,
      lastRefreshAt: opts.lastRefreshDiagnostics?.generatedAt ?? inferredLastRefreshAt,
      triggerSource: opts.lastRefreshDiagnostics?.triggerSource ?? null,
      observationsConsidered: opts.lastRefreshDiagnostics?.observationsConsidered ?? null,
      observationsCreated: opts.lastRefreshDiagnostics?.observationsCreated ?? null,
      observationsSuppressedAsDuplicate: opts.lastRefreshDiagnostics?.observationsSuppressedAsDuplicate ?? null,
      observationsSkippedForInsufficientState: opts.lastRefreshDiagnostics?.observationsSkippedForInsufficientState ?? null,
      rejectedForEconomicDistortionCount: opts.lastRefreshDiagnostics?.rejectedForEconomicDistortionCount ?? null,
    },
    autoRefresh: opts.autoRefreshStatus ?? {
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
    groupPerformance,
    overlapDiagnostics: {
      multiGroupObservationCount: eraObservations.filter((item) => item.overlayGroups.length > 1).length,
      strategyFitAndMetadataOverlapCount: eraObservations.filter((item) =>
        item.overlayGroups.includes("STRATEGY_FIT_SHORTLIST") && item.overlayGroups.includes("METADATA_DISCOVERY_BASELINE")).length,
      uniqueSymbolsObserved: new Set(eraObservations.map((item) => item.symbol)).size,
    },
    currentBestObservedGroup,
    readiness: {
      advisoryEngineReady: eraObservations.length > 0,
      readyForUniverseInfluence: false,
      readyForRotationDiscussion: false,
      reasons,
    },
    patchHypotheses,
    economicsInterpretability,
    answerCards: [
      {
        question: "Can overlay evidence add symbols to the active universe now?",
        answer: "No. Phase 2E.3 only collects isolated prospective research observations.",
      },
      {
        question: "What is this overlay comparing?",
        answer: "It compares strategy-fit enriched external observations against metadata-only discovery baseline observations, with low-fit control observations when available.",
      },
    ],
  };
}

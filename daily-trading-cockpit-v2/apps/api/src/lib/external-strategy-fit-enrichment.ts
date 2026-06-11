import {
  buildCandidate,
  buildVariantSelection,
  round,
  type Candidate,
  type Direction,
  type SentimentSignal,
  type VariantSelectionSnapshot,
  type WhaleSignal,
} from "@dtc/shared";

import type { BinanceClient } from "./binance.js";
import type {
  ExternalCandidateDiscoveryAssessment,
  ExternalCandidateDiscoveryIntelligenceReport,
  ExternalDiscoveryEvidenceEra,
} from "./external-candidate-discovery-intelligence.js";

export type ExternalStrategyFitTechnicalDataStatus = "HEALTHY" | "PARTIAL" | "FAILED" | "INSUFFICIENT_DATA";
export type ExternalStrategyFitTier = "STRATEGY_FIT_HIGH" | "STRATEGY_FIT_MEDIUM" | "STRATEGY_FIT_LOW" | "NOT_EVALUABLE";
export type ExternalStrategyFitConfidence = "LOW" | "MEDIUM" | "HIGH";
export type ExternalStrategyFitDirectionalContext = "LONG_FAVORED" | "SHORT_FAVORED" | "NEUTRAL" | "UNKNOWN";
export type ExternalStrategyFitCompatibility = "ALIGNED" | "CONTRADICTORY" | "UNKNOWN";
export type ExternalStrategyFitQuality = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type ExternalStrategyFitGeometryHint = "HEALTHY" | "FRAGILE" | "UNKNOWN";
export type ExternalStrategyFitPatchAction =
  | "PREPARE_ROTATION_SHADOW_OVERLAY"
  | "IMPROVE_EXTERNAL_ROUTE_FEATURE_CAPTURE"
  | "WAIT_FOR_MATURE_PROMISING_FINGERPRINT"
  | "AUDIT_DISCOVERY_SCORE_VS_STRATEGY_FIT_DIVERGENCE"
  | "NO_ACTION_YET";
export type ExternalStrategyFitPatchStatus = "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";

export interface ExternalStrategyFitTechnicalEvaluation {
  symbol: string;
  technicalDataStatus: ExternalStrategyFitTechnicalDataStatus;
  candidate: Candidate | null;
  detachedExecutionPlan: VariantSelectionSnapshot | null;
  errorMessage?: string;
}

export interface ExternalStrategyFitEnrichmentDiagnostics {
  candidatesRequested: number;
  candidatesEvaluated: number;
  technicalFetchSuccessCount: number;
  technicalFetchFailureCount: number;
  cacheStatus: "USES_BINANCE_CLIENT_CACHE" | "NOT_APPLICABLE";
  failureReasonCounts: Record<string, number>;
  failedCandidatesSample: Array<{
    symbol: string;
    errorMessage: string;
  }>;
  notes: string[];
}

export interface ExternalStrategyFitCandidateAssessment {
  symbol: string;
  discoveryScore: number;
  metadataDiscoveryTier: string;
  technicalDataStatus: ExternalStrategyFitTechnicalDataStatus;
  strategyFitScore: number;
  strategyFitTier: ExternalStrategyFitTier;
  strategyFitConfidence: ExternalStrategyFitConfidence;
  bestObservedExternalRouteHypothesis: {
    selectedEntryVariant: string | null;
    selectedExitVariant: string | null;
    routeMode: string | null;
    routeCompatibilityLabel: "DETACHED_STRATEGY_FIT_HYPOTHESIS" | null;
    expectedNetR: number | null;
    stopDistanceBps: number | null;
    riskReward: number | null;
    plannedEntryPrice?: number | null;
    selectedEntryAnchorPrice?: number | null;
    entryZone?: [number, number] | null;
    stopPrice?: number | null;
    tp1Price?: number | null;
    tp2Price?: number | null;
    tp3Price?: number | null;
    costR?: number | null;
  };
  directionalContext: ExternalStrategyFitDirectionalContext;
  regimeCompatibility: ExternalStrategyFitCompatibility;
  routeCompatibility: ExternalStrategyFitQuality;
  setupQuality: ExternalStrategyFitQuality;
  stopGeometryCredibilityHint: ExternalStrategyFitGeometryHint;
  reasons: string[];
  cautionLabels: string[];
  reusedScannerEvidenceSummary: {
    reusedSharedBuildCandidate: boolean;
    reusedSharedVariantSelection: boolean;
    opportunityScore: number | null;
    confidence: number | null;
    dangerScore: number | null;
    trendStack: string | null;
    scannerStatus: string | null;
  };
}

export interface ExternalStrategyFitPatchHypothesis {
  title: string;
  evidenceSummary: string;
  likelyFutureAction: ExternalStrategyFitPatchAction;
  confidence: ExternalStrategyFitConfidence;
  patchStatus: ExternalStrategyFitPatchStatus;
  doesNotImplementNow: true;
}

export interface ExternalStrategyFitEnrichmentReport {
  generatedAt: string;
  evidenceEra: ExternalDiscoveryEvidenceEra;
  discoverySourceSummary: {
    discoveryShortlistCount: number;
    discoveryTradableCount: number;
    discoveryConfidence: string;
    topMetadataCandidate: string | null;
  };
  enrichedCandidateCount: number;
  failedCandidateCount: number;
  enrichmentReadiness: {
    advisoryEngineReady: boolean;
    readyForRotationShadowOverlay: false;
    readyForUniverseInfluence: false;
    confidence: ExternalStrategyFitConfidence;
    reasons: string[];
  };
  globalMarketContext: {
    inferredExternalShortlistRegime: "BULLISH_EXPANSION" | "BEARISH_EXPANSION" | "MIXED_ROTATION" | "UNKNOWN";
    longCount: number;
    shortCount: number;
    neutralCount: number;
  };
  diagnostics: ExternalStrategyFitEnrichmentDiagnostics;
  candidates: ExternalStrategyFitCandidateAssessment[];
  topStrategyFitCandidates: ExternalStrategyFitCandidateAssessment[];
  lowFitCandidates: ExternalStrategyFitCandidateAssessment[];
  metadataShortlistDivergesFromStrategyFit: boolean;
  patchHypotheses: ExternalStrategyFitPatchHypothesis[];
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

export interface ExternalStrategyFitEnrichmentInput {
  discoveryReport: ExternalCandidateDiscoveryIntelligenceReport;
  technicalEvaluations?: ExternalStrategyFitTechnicalEvaluation[];
  maxCandidates?: number;
}

function unavailableWhaleSignal(): WhaleSignal {
  return { available: false, signal: "UNAVAILABLE", score: 0, reason: "Whale source is not queried for Phase 2E.2.5 detached external enrichment." };
}

function unavailableSentimentSignal(): SentimentSignal {
  return {
    available: false,
    signal: "UNAVAILABLE",
    score: 0,
    confidence: 0,
    source: "none",
    reason: "Sentiment source is not queried for Phase 2E.2.5 detached external enrichment.",
  };
}

function unavailableKronosPrediction() {
  return {
    available: false,
    reason: "Kronos is not queried for Phase 2E.2.5 detached external enrichment.",
    availabilityReasonCode: "UNAVAILABLE" as const,
  };
}

function calculateVolumeRatio5m(candles5m: Awaited<ReturnType<BinanceClient["getCandles"]>>): number | null {
  if (candles5m.length < 22) return null;
  const completed = candles5m.at(-2);
  const baselineWindow = candles5m.slice(-22, -2);
  if (!completed || baselineWindow.length === 0) return null;
  const baseline = baselineWindow.reduce((sum, candle) => sum + candle.volume, 0) / baselineWindow.length;
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  return round(completed.volume / baseline, 4);
}

export async function fetchExternalStrategyFitTechnicalEvaluations(opts: {
  discoveryReport: ExternalCandidateDiscoveryIntelligenceReport;
  binanceClient: BinanceClient;
  maxCandidates?: number;
  now?: number;
}): Promise<ExternalStrategyFitTechnicalEvaluation[]> {
  const maxCandidates = opts.maxCandidates ?? 10;
  const now = opts.now ?? Date.now();
  const shortlist = opts.discoveryReport.shortlistedCandidates.slice(0, maxCandidates);
  const out: ExternalStrategyFitTechnicalEvaluation[] = [];

  for (const candidate of shortlist) {
    try {
      const [candles5m, candles15m, candles1h, ticker24h, bookTicker] = await Promise.all([
        opts.binanceClient.getCandles(candidate.symbol, "5m", 150),
        opts.binanceClient.getCandles(candidate.symbol, "15m", 150),
        opts.binanceClient.getCandles(candidate.symbol, "1h", 150),
        opts.binanceClient.getTicker24h(candidate.symbol),
        opts.binanceClient.getBookTicker(candidate.symbol),
      ]);
      const built = buildCandidate({
        symbol: candidate.symbol,
        candles5m,
        candles15m,
        candles1h,
        spread: bookTicker,
        volume: { ...ticker24h, volumeRatio5m: calculateVolumeRatio5m(candles5m) },
        kronos: unavailableKronosPrediction(),
        whale: unavailableWhaleSignal(),
        sentiment: unavailableSentimentSignal(),
        now,
      });
      out.push({
        symbol: candidate.symbol,
        technicalDataStatus: built.finalDirection === "NEUTRAL" ? "PARTIAL" : "HEALTHY",
        candidate: built,
        detachedExecutionPlan: buildVariantSelection(built, null),
      });
    } catch (error) {
      out.push({
        symbol: candidate.symbol,
        technicalDataStatus: "FAILED",
        candidate: null,
        detachedExecutionPlan: null,
        errorMessage: error instanceof Error ? error.message : "External strategy-fit technical fetch failed.",
      });
    }
  }

  return out;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function qualityFromScore(score: number): ExternalStrategyFitQuality {
  if (score >= 70) return "HIGH";
  if (score >= 45) return "MEDIUM";
  return "LOW";
}

function directionContext(direction: Direction | null | undefined): ExternalStrategyFitDirectionalContext {
  if (direction === "LONG") return "LONG_FAVORED";
  if (direction === "SHORT") return "SHORT_FAVORED";
  if (direction === "NEUTRAL") return "NEUTRAL";
  return "UNKNOWN";
}

function inferRegime(evaluations: ExternalStrategyFitTechnicalEvaluation[]) {
  let longCount = 0;
  let shortCount = 0;
  let neutralCount = 0;
  for (const item of evaluations) {
    if (item.candidate?.finalDirection === "LONG") longCount += 1;
    else if (item.candidate?.finalDirection === "SHORT") shortCount += 1;
    else neutralCount += 1;
  }
  const inferredExternalShortlistRegime =
    shortCount >= longCount + 2 ? "BEARISH_EXPANSION"
      : longCount >= shortCount + 2 ? "BULLISH_EXPANSION"
      : longCount + shortCount > 0 ? "MIXED_ROTATION"
      : "UNKNOWN";
  return { inferredExternalShortlistRegime, longCount, shortCount, neutralCount } as const;
}

function regimeCompatibility(direction: Direction | null | undefined, regime: ReturnType<typeof inferRegime>["inferredExternalShortlistRegime"]): ExternalStrategyFitCompatibility {
  if (direction !== "LONG" && direction !== "SHORT") return "UNKNOWN";
  if (regime === "BEARISH_EXPANSION") return direction === "SHORT" ? "ALIGNED" : "CONTRADICTORY";
  if (regime === "BULLISH_EXPANSION") return direction === "LONG" ? "ALIGNED" : "CONTRADICTORY";
  return "UNKNOWN";
}

function geometryHint(plan: VariantSelectionSnapshot | null, candidate: Candidate | null): ExternalStrategyFitGeometryHint {
  const stop = plan?.stopDistanceBps ?? null;
  const rr = candidate?.riskReward ?? null;
  if (stop === null || rr === null) return "UNKNOWN";
  if (stop < 100 || rr < 1.2 || (plan?.costR ?? 0) >= 0.45) return "FRAGILE";
  return "HEALTHY";
}

function tier(score: number, status: ExternalStrategyFitTechnicalDataStatus): ExternalStrategyFitTier {
  if (status === "FAILED" || status === "INSUFFICIENT_DATA") return "NOT_EVALUABLE";
  if (score >= 75) return "STRATEGY_FIT_HIGH";
  if (score >= 55) return "STRATEGY_FIT_MEDIUM";
  return "STRATEGY_FIT_LOW";
}

/**
 * Resolves the planning-time entry anchor price for a selected entry variant.
 * Mirrors the anchor mapping inside shared/execution-plan.ts buildVariantSelection
 * (the source of truth for costDiagnostics input). Used by external-rotation-overlay
 * so that resolverState.entryPrice matches the basis under which costR /
 * stopDistanceBps were computed — eliminates the entry-anchor / fill-price
 * unit mismatch.
 */
function resolveVariantAnchorPrice(candidate: Candidate, variant: string | null): number | null {
  if (variant === null) return null;
  const five = candidate.indicators.fiveMinute;
  switch (variant) {
    case "base_current_entry":
      return five.latestClose ?? candidate.currentPrice ?? null;
    case "fib_382_entry":
      return candidate.fibonacci.retracement382 ?? null;
    case "fib_500_entry":
      return candidate.fibonacci.retracement500 ?? null;
    case "fib_618_entry":
      return candidate.fibonacci.retracement618 ?? null;
    case "vwap_retest_entry":
      return five.vwap ?? null;
    case "ema20_pullback_entry":
      return five.ema20 ?? null;
    case "no_chase_atr_entry": {
      const zone = candidate.entryZone;
      if (Array.isArray(zone) && Number.isFinite(zone[0]) && Number.isFinite(zone[1])) {
        return (zone[0] + zone[1]) / 2;
      }
      return five.latestClose ?? candidate.currentPrice ?? null;
    }
    default:
      return null;
  }
}

function assessCandidate(
  discovery: ExternalCandidateDiscoveryAssessment,
  evaluation: ExternalStrategyFitTechnicalEvaluation | null,
  regime: ReturnType<typeof inferRegime>["inferredExternalShortlistRegime"],
): ExternalStrategyFitCandidateAssessment {
  const candidate = evaluation?.candidate ?? null;
  const plan = evaluation?.detachedExecutionPlan ?? null;
  const technicalDataStatus = evaluation?.technicalDataStatus ?? "FAILED";
  const reasons: string[] = [];
  const cautionLabels = [
    "Advisory only - not approved for active universe inclusion.",
    "Detached strategy-fit hypothesis - not actual scanner output and not eligible for execution.",
    "Current snapshot only - not prospective performance proof.",
  ];

  if (!candidate || !plan) {
    return {
      symbol: discovery.symbol,
      discoveryScore: discovery.netDiscoveryScore,
      metadataDiscoveryTier: discovery.discoveryTier,
      technicalDataStatus,
      strategyFitScore: 0,
      strategyFitTier: "NOT_EVALUABLE",
      strategyFitConfidence: "LOW",
      bestObservedExternalRouteHypothesis: {
        selectedEntryVariant: null,
        selectedExitVariant: null,
        routeMode: null,
        routeCompatibilityLabel: null,
        expectedNetR: null,
        stopDistanceBps: null,
        riskReward: null,
        plannedEntryPrice: null,
        selectedEntryAnchorPrice: null,
        entryZone: null,
        stopPrice: null,
        tp1Price: null,
        tp2Price: null,
        tp3Price: null,
        costR: null,
      },
      directionalContext: "UNKNOWN",
      regimeCompatibility: "UNKNOWN",
      routeCompatibility: "UNKNOWN",
      setupQuality: "UNKNOWN",
      stopGeometryCredibilityHint: "UNKNOWN",
      reasons: [`Technical enrichment failed: ${evaluation?.errorMessage ?? "no technical evaluation available"}`],
      cautionLabels,
      reusedScannerEvidenceSummary: {
        reusedSharedBuildCandidate: false,
        reusedSharedVariantSelection: false,
        opportunityScore: null,
        confidence: null,
        dangerScore: null,
        trendStack: null,
        scannerStatus: null,
      },
    };
  }

  const routeComponent = clampScore((candidate.opportunityScore * 0.45) + (candidate.trendScore * 0.35) + (candidate.confidence * 0.2));
  const directionRegimeComponent = regimeCompatibility(candidate.finalDirection, regime) === "ALIGNED"
    ? 85
    : regimeCompatibility(candidate.finalDirection, regime) === "CONTRADICTORY"
      ? 25
      : candidate.finalDirection === "NEUTRAL" ? 20 : 55;
  const geoHint = geometryHint(plan, candidate);
  const geometryComponent = geoHint === "HEALTHY" ? 80 : geoHint === "FRAGILE" ? 25 : 45;
  const metadataComponent = discovery.netDiscoveryScore;

  let score = routeComponent * 0.35 + directionRegimeComponent * 0.25 + geometryComponent * 0.20 + metadataComponent * 0.20;
  if (candidate.finalDirection === "NEUTRAL") {
    score -= 25;
    reasons.push("Directional edge is neutral, so metadata quality cannot dominate strategy fit.");
  }
  if (geoHint === "FRAGILE") {
    score -= 15;
    reasons.push("Hypothetical plan has fragile stop/RR/cost geometry.");
  }
  if (candidate.status === "SKIP") {
    score -= 10;
    reasons.push("Detached scanner-style candidate status is SKIP.");
  }
  const finalScore = clampScore(score);

  const setupQuality = qualityFromScore(routeComponent);
  const routeCompatibility = qualityFromScore(routeComponent);
  const regCompat = regimeCompatibility(candidate.finalDirection, regime);
  reasons.push(`Scanner-style opportunity=${candidate.opportunityScore}, confidence=${candidate.confidence}, danger=${candidate.dangerScore}.`);
  reasons.push(`Detached route hypothesis: ${plan.selectedEntryVariant} + ${plan.selectedExitVariant} (${plan.routeMode}).`);
  if (regCompat === "ALIGNED") reasons.push(`Direction ${candidate.finalDirection} aligns with inferred external shortlist regime ${regime}.`);
  if (regCompat === "CONTRADICTORY") reasons.push(`Direction ${candidate.finalDirection} contradicts inferred external shortlist regime ${regime}.`);
  if (geoHint === "HEALTHY") reasons.push("Stop/RR geometry is acceptable in detached evaluation.");

  return {
    symbol: discovery.symbol,
    discoveryScore: discovery.netDiscoveryScore,
    metadataDiscoveryTier: discovery.discoveryTier,
    technicalDataStatus,
    strategyFitScore: finalScore,
    strategyFitTier: tier(finalScore, technicalDataStatus),
    strategyFitConfidence: technicalDataStatus === "HEALTHY" && finalScore >= 55 ? "MEDIUM" : "LOW",
    bestObservedExternalRouteHypothesis: (() => {
      const anchor = resolveVariantAnchorPrice(candidate, plan.selectedEntryVariant);
      const fallbackEntry = candidate.currentPrice ?? candidate.chart?.at(-1)?.value ?? null;
      return {
        selectedEntryVariant: plan.selectedEntryVariant,
        selectedExitVariant: plan.selectedExitVariant,
        routeMode: plan.routeMode,
        routeCompatibilityLabel: "DETACHED_STRATEGY_FIT_HYPOTHESIS" as const,
        expectedNetR: plan.expectedNetR,
        stopDistanceBps: plan.stopDistanceBps,
        riskReward: candidate.riskReward,
        // plannedEntryPrice now matches the anchor used by costDiagnostics so the
        // overlay resolver's gross R, stopDistanceBps, and costR all share the
        // same risk denominator. If anchor cannot be resolved (unknown variant),
        // fall back to currentPrice — the overlay will tag such observations as
        // legacy-style and exclude them from operative metrics.
        plannedEntryPrice: anchor ?? fallbackEntry,
        selectedEntryAnchorPrice: anchor,
        entryZone: candidate.entryZone,
        stopPrice: candidate.stopLoss,
        tp1Price: candidate.takeProfits?.tp1 ?? null,
        tp2Price: candidate.takeProfits?.tp2 ?? null,
        tp3Price: candidate.takeProfits?.tp3 ?? null,
        costR: plan.costR,
      };
    })(),
    directionalContext: directionContext(candidate.finalDirection),
    regimeCompatibility: regCompat,
    routeCompatibility,
    setupQuality,
    stopGeometryCredibilityHint: geoHint,
    reasons,
    cautionLabels,
    reusedScannerEvidenceSummary: {
      reusedSharedBuildCandidate: true,
      reusedSharedVariantSelection: true,
      opportunityScore: candidate.opportunityScore,
      confidence: candidate.confidence,
      dangerScore: candidate.dangerScore,
      trendStack: `${candidate.indicators.fiveMinute.trend}/${candidate.indicators.fifteenMinute.trend}/${candidate.indicators.oneHour.trend}`,
      scannerStatus: candidate.status,
    },
  };
}

function buildReadiness(
  discovery: ExternalCandidateDiscoveryIntelligenceReport,
  candidates: ExternalStrategyFitCandidateAssessment[],
  diagnostics: ExternalStrategyFitEnrichmentDiagnostics,
) {
  const reasons: string[] = [];
  const advisoryEngineReady = diagnostics.candidatesEvaluated > 0;
  if (!advisoryEngineReady) reasons.push("No external discovery shortlist candidates were technically enriched.");
  if (diagnostics.technicalFetchFailureCount > 0) reasons.push(`${diagnostics.technicalFetchFailureCount} candidate(s) failed technical enrichment.`);
  if (discovery.discoveryFingerprintBasis.promisingFingerprintConfidence === "LOW") {
    reasons.push("Promising route/universe fingerprints remain LOW confidence.");
  }
  reasons.push("Strategy-fit enrichment is cross-sectional only; no prospective rotation-shadow validation exists yet.");
  reasons.push("readyForUniverseInfluence is always false in Phase 2E.2.5.");
  reasons.push("readyForRotationShadowOverlay is false; Phase 2E.3 must validate candidates prospectively.");
  const confidence: ExternalStrategyFitConfidence = candidates.some((c) => c.strategyFitTier === "STRATEGY_FIT_HIGH") && discovery.discoveryFingerprintBasis.promisingFingerprintConfidence !== "LOW"
    ? "MEDIUM"
    : "LOW";
  return {
    advisoryEngineReady,
    readyForRotationShadowOverlay: false as const,
    readyForUniverseInfluence: false as const,
    confidence,
    reasons,
  };
}

function buildPatchHypotheses(
  discovery: ExternalCandidateDiscoveryIntelligenceReport,
  top: ExternalStrategyFitCandidateAssessment[],
  low: ExternalStrategyFitCandidateAssessment[],
): ExternalStrategyFitPatchHypothesis[] {
  const hypotheses: ExternalStrategyFitPatchHypothesis[] = [];
  if (discovery.discoveryFingerprintBasis.promisingFingerprintConfidence === "LOW") {
    hypotheses.push({
      title: "Wait for mature promising fingerprints before universe influence",
      evidenceSummary: "External strategy-fit enrichment can rank current setups, but Phase 2E.1 promising fingerprints are still LOW confidence.",
      likelyFutureAction: "WAIT_FOR_MATURE_PROMISING_FINGERPRINT",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }
  if (top.length > 0) {
    hypotheses.push({
      title: "Use strategy-fit shortlist as the safer Phase 2E.3 observation set",
      evidenceSummary: `${top.length} candidate(s) passed both metadata discovery and detached scanner-style strategy-fit checks. Rotation overlay is still not implemented.`,
      likelyFutureAction: "PREPARE_ROTATION_SHADOW_OVERLAY",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }
  if (low.length > 0) {
    hypotheses.push({
      title: "Audit metadata-score vs strategy-fit divergence",
      evidenceSummary: `${low.length} metadata-shortlisted candidate(s) currently look weak by strategy-fit enrichment. Metadata-only discovery should remain a prefilter, not a rotation decision.`,
      likelyFutureAction: "AUDIT_DISCOVERY_SCORE_VS_STRATEGY_FIT_DIVERGENCE",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }
  if (hypotheses.length === 0) {
    hypotheses.push({
      title: "No external strategy-fit action recommended",
      evidenceSummary: "No enriched candidate currently provides enough evidence for a next-step action.",
      likelyFutureAction: "NO_ACTION_YET",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }
  return hypotheses;
}

export function buildExternalStrategyFitEnrichmentReport(
  input: ExternalStrategyFitEnrichmentInput,
  now: Date = new Date(),
): ExternalStrategyFitEnrichmentReport {
  const maxCandidates = input.maxCandidates ?? 10;
  const discoveryShortlist = input.discoveryReport.shortlistedCandidates.slice(0, maxCandidates);
  const evaluations = input.technicalEvaluations ?? [];
  const evaluationBySymbol = new Map(evaluations.map((item) => [item.symbol, item]));
  const globalMarketContext = inferRegime(evaluations);

  const candidates = discoveryShortlist.map((item) =>
    assessCandidate(item, evaluationBySymbol.get(item.symbol) ?? null, globalMarketContext.inferredExternalShortlistRegime),
  );
  const enrichedCandidateCount = candidates.filter((item) => item.technicalDataStatus === "HEALTHY" || item.technicalDataStatus === "PARTIAL").length;
  const failedCandidateCount = candidates.length - enrichedCandidateCount;
  const topStrategyFitCandidates = candidates
    .filter((item) => item.strategyFitTier !== "NOT_EVALUABLE")
    .sort((a, b) => b.strategyFitScore - a.strategyFitScore)
    .slice(0, 5);
  const lowFitCandidates = candidates
    .filter((item) => item.strategyFitTier === "STRATEGY_FIT_LOW" || item.strategyFitTier === "NOT_EVALUABLE")
    .sort((a, b) => a.strategyFitScore - b.strategyFitScore)
    .slice(0, 5);
  const diagnostics: ExternalStrategyFitEnrichmentDiagnostics = {
    candidatesRequested: discoveryShortlist.length,
    candidatesEvaluated: enrichedCandidateCount,
    technicalFetchSuccessCount: enrichedCandidateCount,
    technicalFetchFailureCount: failedCandidateCount,
    cacheStatus: "USES_BINANCE_CLIENT_CACHE",
    failureReasonCounts: evaluations.reduce<Record<string, number>>((acc, item) => {
      if (item.technicalDataStatus !== "FAILED") return acc;
      const reason = item.errorMessage ?? "unknown technical enrichment failure";
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {}),
    failedCandidatesSample: evaluations
      .filter((item) => item.technicalDataStatus === "FAILED")
      .slice(0, 5)
      .map((item) => ({
        symbol: item.symbol,
        errorMessage: item.errorMessage ?? "unknown technical enrichment failure",
      })),
    notes: ["Technical enrichment evaluates only the Phase 2E.2 shortlist and relies on BinanceClient endpoint caching."],
  };
  const enrichmentReadiness = buildReadiness(input.discoveryReport, candidates, diagnostics);
  const metadataShortlistDivergesFromStrategyFit =
    discoveryShortlist[0]?.symbol !== undefined &&
    topStrategyFitCandidates[0]?.symbol !== undefined &&
    discoveryShortlist[0]?.symbol !== topStrategyFitCandidates[0]?.symbol;

  return {
    generatedAt: now.toISOString(),
    evidenceEra: input.discoveryReport.evidenceEra,
    discoverySourceSummary: {
      discoveryShortlistCount: input.discoveryReport.shortlistedCandidates.length,
      discoveryTradableCount: input.discoveryReport.externalUniverseSymbolsTradable,
      discoveryConfidence: input.discoveryReport.discoveryReadiness.confidence,
      topMetadataCandidate: input.discoveryReport.shortlistedCandidates[0]?.symbol ?? null,
    },
    enrichedCandidateCount,
    failedCandidateCount,
    enrichmentReadiness,
    globalMarketContext,
    diagnostics,
    candidates,
    topStrategyFitCandidates,
    lowFitCandidates,
    metadataShortlistDivergesFromStrategyFit,
    patchHypotheses: buildPatchHypotheses(input.discoveryReport, topStrategyFitCandidates, lowFitCandidates),
    answerCards: [
      {
        question: "Does metadata discovery equal strategy fit?",
        answer: metadataShortlistDivergesFromStrategyFit
          ? "No. The top metadata candidate differs from the top detached strategy-fit candidate."
          : "Not necessarily. Current top metadata and strategy-fit candidates match, but this remains a snapshot only.",
      },
      {
        question: "Can these candidates enter the active universe?",
        answer: "No. Phase 2E.2.5 is advisory only and cannot modify the scanner universe or open shadow positions.",
      },
    ],
    notes: [
      "External Strategy-Fit Enrichment is read-only and advisory-only.",
      "It reuses shared scanner candidate construction and variant-selection helpers in detached mode.",
      "Detached route hypotheses are not actual scanner output, are not persisted, and cannot trigger execution.",
      "Phase 2E.3 (not implemented) would prospectively validate enriched candidates with a rotation shadow overlay.",
    ],
  };
}

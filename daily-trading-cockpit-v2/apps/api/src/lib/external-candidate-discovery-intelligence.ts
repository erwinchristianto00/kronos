import type { StrategyExperienceRecord } from "@dtc/shared";
import type {
  RotationFingerprint,
  FingerprintConfidence,
} from "./universe-rotation-intelligence.js";
import type { ExternalCandidateMetadataFetchDiagnostics } from "./external-candidate-metadata-fetcher.js";

/**
 * EXTERNAL CANDIDATE DISCOVERY INTELLIGENCE (Phase 2E.2)
 *
 * Read-only advisory engine that explores tradable symbols OUTSIDE the current
 * active universe and produces a shortlist of "worth observing later" candidates
 * by comparing their tradability metadata against the promising and toxic
 * fingerprints produced by Phase 2E.1 (Universe Rotation Intelligence).
 *
 * Does NOT change:
 *   - the active symbol universe used by the live scanner
 *   - scanner ranking / Top-10 selection
 *   - opportunity / confidence / danger scoring
 *   - routeMode decisions, variant selection, ProfitRoutingAgent behavior
 *   - shadow fill, close, cost, or calibration logic
 *   - live readiness, symbol quarantine, trade caps
 *   - stop / TP geometry, adaptive gates, regime overlay
 *
 * Honest limitation:
 *   External candidates do not yet have bot-specific shadow outcome history.
 *   Similarity can only be evaluated on observable market metadata (volume,
 *   spread, volatility, etc.) — not on route-level setup features. Until the
 *   Phase 2E.1 fingerprints reach MEDIUM/HIGH confidence (≥30 closes per
 *   symbol-direction), discovery scoring is exploratory only.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExternalDiscoveryEvidenceEra = "POST_CALIBRATION" | "ALL_TIME";

export type ExternalCandidateTradabilityVerdict =
  | "TRADABLE"
  | "LOW_LIQUIDITY"
  | "EXCESSIVE_SPREAD"
  | "NOT_SUPPORTED_INSTRUMENT"
  | "STATUS_NOT_TRADING"
  | "DATA_INCOMPLETE"
  | "CURRENT_UNIVERSE_MEMBER";

export type ExternalDiscoveryTier =
  | "EXPLORATORY_SHORTLIST"
  | "WATCHLIST_ONLY"
  | "LOW_PRIORITY"
  | "REJECTED";

export type ExternalDiscoveryReadinessConfidence = "LOW" | "MEDIUM" | "HIGH";

export type ExternalDiscoveryPatchAction =
  | "PREPARE_ROTATION_SHADOW_OVERLAY"
  | "IMPROVE_EXTERNAL_FEATURE_CAPTURE"
  | "WAIT_FOR_MATURE_WINNER_FINGERPRINT"
  | "NO_ACTION_YET";

export type ExternalDiscoveryPatchStatus = "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";

export interface ExternalDiscoveryCandidateMetadata {
  symbol: string;
  baseAsset: string | null;
  quoteAsset: string | null;
  instrumentType: string | null; // "SPOT" | "PERPETUAL" | etc., advisory
  status: string | null; // "TRADING" | "BREAK" | etc.
  latestPrice: number | null;
  quoteVolume24h: number | null;
  priceChangePct24h: number | null;
  spreadBps: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  alreadyInCurrentUniverse: boolean;
}

export interface ExternalCandidateDiscoveryAssessment {
  symbol: string;
  alreadyInCurrentUniverse: boolean;
  tradabilityVerdict: ExternalCandidateTradabilityVerdict;
  discoveryScore: number;
  promisingSimilarityScore: number;
  toxicSimilarityPenalty: number;
  netDiscoveryScore: number;
  discoveryTier: ExternalDiscoveryTier;
  reasons: string[];
  matchedPromisingFingerprintFeatures: string[];
  matchedToxicFingerprintFeatures: string[];
  marketMetadataSummary: {
    quoteVolume24h: number | null;
    spreadBps: number | null;
    priceChangePct24h: number | null;
    fundingRate: number | null;
    openInterest: number | null;
  };
  cautionLabels: string[];
}

export interface ExternalDiscoveryReadiness {
  advisoryEngineReady: boolean;
  readyForUniverseExpansionInfluence: false;
  readyForRotationShadowOverlay: false;
  confidence: ExternalDiscoveryReadinessConfidence;
  reasons: string[];
}

export interface ExternalDiscoveryFingerprintBasis {
  promisingFingerprintConfidence: FingerprintConfidence | "NONE";
  toxicFingerprintConfidence: FingerprintConfidence | "NONE";
  promisingFingerprintCount: number;
  toxicFingerprintCount: number;
  promisingFingerprintSummary: string;
  toxicFingerprintSummary: string;
  maturityWarning: string;
}

export interface ExternalDiscoveryPatchHypothesis {
  title: string;
  evidenceSummary: string;
  likelyFutureAction: ExternalDiscoveryPatchAction;
  confidence: ExternalDiscoveryReadinessConfidence;
  patchStatus: ExternalDiscoveryPatchStatus;
  doesNotImplementNow: true;
}

export interface ExternalCandidateDiscoveryIntelligenceReport {
  generatedAt: string;
  evidenceEra: ExternalDiscoveryEvidenceEra;
  currentUniverseSymbolCount: number;
  externalUniverseSymbolsConsidered: number;
  externalUniverseSymbolsTradable: number;
  externalUniverseSymbolsRejected: number;
  metadataDiagnostics: ExternalCandidateMetadataFetchDiagnostics;
  discoveryReadiness: ExternalDiscoveryReadiness;
  sourceMetadata: {
    source: string;
    instrumentTypeFilter: string;
    quoteAssetFilter: string;
    minQuoteVolume24hUsd: number;
    maxSpreadBps: number;
  };
  tradabilityBreakdown: Record<ExternalCandidateTradabilityVerdict, number>;
  discoveryFingerprintBasis: ExternalDiscoveryFingerprintBasis;
  shortlistedCandidates: ExternalCandidateDiscoveryAssessment[];
  rejectedCandidatesSample: ExternalCandidateDiscoveryAssessment[];
  categoryBuckets: {
    highLiquidityExploratory: string[];
    highVolatilityTradable: string[];
    stableLiquidityCandidates: string[];
    dataIncompleteCandidates: string[];
  };
  patchHypotheses: ExternalDiscoveryPatchHypothesis[];
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

export interface ExternalCandidateDiscoveryIntelligenceInput {
  records?: StrategyExperienceRecord[];
  currentUniverseSymbols: string[];
  externalCandidateMetadata: ExternalDiscoveryCandidateMetadata[];
  metadataDiagnostics?: ExternalCandidateMetadataFetchDiagnostics;
  promisingFingerprints: RotationFingerprint[];
  toxicFingerprints: RotationFingerprint[];
  evidenceEra?: ExternalDiscoveryEvidenceEra;
  source?: string;
}

// ─── Tradability thresholds (advisory; not used by live trading) ──────────────

const TRADABILITY_THRESHOLDS = {
  minQuoteVolume24hUsd: 10_000_000, // 10M USDT 24h notional volume
  maxSpreadBps: 10, // 0.10% spread cap
  quoteAssetFilter: "USDT",
  acceptedInstrumentTypes: new Set(["SPOT", "PERPETUAL"]),
} as const;

const SHORTLIST_LIMIT = 10;
const REJECTED_SAMPLE_LIMIT = 8;
const CATEGORY_BUCKET_LIMIT = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function classifyTradability(
  meta: ExternalDiscoveryCandidateMetadata,
): ExternalCandidateTradabilityVerdict {
  if (meta.alreadyInCurrentUniverse) return "CURRENT_UNIVERSE_MEMBER";
  if (meta.quoteAsset !== TRADABILITY_THRESHOLDS.quoteAssetFilter) {
    return "NOT_SUPPORTED_INSTRUMENT";
  }
  if (meta.instrumentType !== null && !TRADABILITY_THRESHOLDS.acceptedInstrumentTypes.has(meta.instrumentType)) {
    return "NOT_SUPPORTED_INSTRUMENT";
  }
  if (meta.status !== null && meta.status !== "TRADING") {
    return "STATUS_NOT_TRADING";
  }
  if (meta.quoteVolume24h === null || meta.latestPrice === null) {
    return "DATA_INCOMPLETE";
  }
  if (meta.quoteVolume24h < TRADABILITY_THRESHOLDS.minQuoteVolume24hUsd) {
    return "LOW_LIQUIDITY";
  }
  if (meta.spreadBps !== null && meta.spreadBps > TRADABILITY_THRESHOLDS.maxSpreadBps) {
    return "EXCESSIVE_SPREAD";
  }
  return "TRADABLE";
}

function computePromisingSimilarityScore(
  meta: ExternalDiscoveryCandidateMetadata,
  promisingFingerprints: RotationFingerprint[],
): { score: number; matchedFeatures: string[] } {
  const matched: string[] = [];
  let score = 50; // neutral baseline

  if (promisingFingerprints.length === 0) {
    return { score, matchedFeatures: [] };
  }

  // Liquidity sweet spot: $50M-$500M 24h notional
  if (meta.quoteVolume24h !== null) {
    if (meta.quoteVolume24h >= 50_000_000 && meta.quoteVolume24h <= 500_000_000) {
      score += 20;
      matched.push("healthy liquidity tier ($50M-$500M 24h)");
    } else if (meta.quoteVolume24h > 500_000_000) {
      score += 10;
      matched.push("mega liquidity tier (>$500M 24h)");
    }
  }

  // Tight spread bonus
  if (meta.spreadBps !== null && meta.spreadBps <= 5) {
    score += 10;
    matched.push("tight spread (<=5 bps)");
  }

  // Reasonable volatility (not too quiet, not too extreme)
  if (meta.priceChangePct24h !== null) {
    const absChg = Math.abs(meta.priceChangePct24h);
    if (absChg >= 1 && absChg <= 15) {
      score += 10;
      matched.push("moderate 24h volatility (1%-15%)");
    }
  }

  // Normal funding (where available)
  if (meta.fundingRate !== null && Math.abs(meta.fundingRate) <= 0.05) {
    score += 10;
    matched.push("normal funding rate (<=0.05%)");
  }

  return { score: clamp(score, 0, 100), matchedFeatures: matched };
}

function computeToxicSimilarityPenalty(
  meta: ExternalDiscoveryCandidateMetadata,
  toxicFingerprints: RotationFingerprint[],
): { penalty: number; matchedFeatures: string[] } {
  const matched: string[] = [];
  let penalty = 0;

  // Extreme volatility resembles past toxic noise
  if (meta.priceChangePct24h !== null && Math.abs(meta.priceChangePct24h) > 30) {
    penalty += 25;
    matched.push("extreme 24h volatility (>30%)");
  }

  // Wide spread is consistently associated with poor outcomes
  if (meta.spreadBps !== null && meta.spreadBps > 15) {
    penalty += 25;
    matched.push("wide spread (>15 bps)");
  }

  // Marginal liquidity above tradability floor but still risky
  if (meta.quoteVolume24h !== null
    && meta.quoteVolume24h >= TRADABILITY_THRESHOLDS.minQuoteVolume24hUsd
    && meta.quoteVolume24h < 20_000_000) {
    penalty += 20;
    matched.push("marginal liquidity ($10M-$20M 24h)");
  }

  // Extreme funding rate
  if (meta.fundingRate !== null && Math.abs(meta.fundingRate) > 0.15) {
    penalty += 20;
    matched.push("extreme funding rate (>0.15%)");
  }

  // Missing key metadata
  if (meta.latestPrice === null || meta.quoteVolume24h === null) {
    penalty += 10;
    matched.push("incomplete metadata");
  }

  // If toxic fingerprint references this exact symbol pattern, escalate
  if (toxicFingerprints.some((fp) => fp.exampleSymbol === meta.symbol)) {
    penalty += 25;
    matched.push("symbol appears in current toxic fingerprint set");
  }

  return { penalty: clamp(penalty, 0, 100), matchedFeatures: matched };
}

function classifyTier(netScore: number, tradability: ExternalCandidateTradabilityVerdict): ExternalDiscoveryTier {
  if (tradability !== "TRADABLE") return "REJECTED";
  if (netScore >= 70) return "EXPLORATORY_SHORTLIST";
  if (netScore >= 50) return "WATCHLIST_ONLY";
  if (netScore >= 30) return "LOW_PRIORITY";
  return "REJECTED";
}

function buildAssessment(
  meta: ExternalDiscoveryCandidateMetadata,
  promisingFingerprints: RotationFingerprint[],
  toxicFingerprints: RotationFingerprint[],
): ExternalCandidateDiscoveryAssessment {
  const tradabilityVerdict = classifyTradability(meta);
  const { score: promisingSimilarityScore, matchedFeatures: matchedPromisingFingerprintFeatures } =
    computePromisingSimilarityScore(meta, promisingFingerprints);
  const { penalty: toxicSimilarityPenalty, matchedFeatures: matchedToxicFingerprintFeatures } =
    computeToxicSimilarityPenalty(meta, toxicFingerprints);

  const netDiscoveryScore = clamp(
    Math.round(promisingSimilarityScore - toxicSimilarityPenalty * 0.5),
    0,
    100,
  );
  const discoveryTier = classifyTier(netDiscoveryScore, tradabilityVerdict);

  const reasons: string[] = [];
  reasons.push(`Tradability verdict: ${tradabilityVerdict}.`);
  if (meta.quoteVolume24h !== null) {
    reasons.push(`24h quote volume: ${meta.quoteVolume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDT.`);
  }
  if (meta.spreadBps !== null) {
    reasons.push(`Spread: ${meta.spreadBps.toFixed(2)} bps.`);
  }
  if (meta.priceChangePct24h !== null) {
    reasons.push(`24h price change: ${meta.priceChangePct24h.toFixed(2)}%.`);
  }
  reasons.push(`Promising similarity score: ${promisingSimilarityScore}/100.`);
  reasons.push(`Toxic similarity penalty: ${toxicSimilarityPenalty}/100.`);
  reasons.push(`Net discovery score: ${netDiscoveryScore}/100 → ${discoveryTier}.`);

  const cautionLabels: string[] = [
    "Advisory only — not approved for live universe inclusion.",
    "Similarity score uses market metadata only — does not validate route-level fit.",
  ];
  if (promisingFingerprints.length === 0) {
    cautionLabels.push("No promising fingerprints in current evidence — similarity is structural baseline only.");
  }
  if (promisingFingerprints.every((fp) => fp.confidence === "LOW")) {
    cautionLabels.push("Underlying promising fingerprints are LOW confidence — discovery score is exploratory.");
  }

  return {
    symbol: meta.symbol,
    alreadyInCurrentUniverse: meta.alreadyInCurrentUniverse,
    tradabilityVerdict,
    discoveryScore: promisingSimilarityScore,
    promisingSimilarityScore,
    toxicSimilarityPenalty,
    netDiscoveryScore,
    discoveryTier,
    reasons,
    matchedPromisingFingerprintFeatures,
    matchedToxicFingerprintFeatures,
    marketMetadataSummary: {
      quoteVolume24h: meta.quoteVolume24h,
      spreadBps: meta.spreadBps,
      priceChangePct24h: meta.priceChangePct24h,
      fundingRate: meta.fundingRate,
      openInterest: meta.openInterest,
    },
    cautionLabels,
  };
}

function buildFingerprintBasis(
  promisingFingerprints: RotationFingerprint[],
  toxicFingerprints: RotationFingerprint[],
): ExternalDiscoveryFingerprintBasis {
  const highestPromising: FingerprintConfidence | "NONE" =
    promisingFingerprints.length === 0
      ? "NONE"
      : promisingFingerprints.some((fp) => fp.confidence === "HIGH")
        ? "HIGH"
        : promisingFingerprints.some((fp) => fp.confidence === "MEDIUM")
          ? "MEDIUM"
          : "LOW";

  const highestToxic: FingerprintConfidence | "NONE" =
    toxicFingerprints.length === 0
      ? "NONE"
      : toxicFingerprints.some((fp) => fp.confidence === "HIGH")
        ? "HIGH"
        : toxicFingerprints.some((fp) => fp.confidence === "MEDIUM")
          ? "MEDIUM"
          : "LOW";

  const promisingSummary = promisingFingerprints.length === 0
    ? "No promising fingerprints available in current evidence."
    : promisingFingerprints
        .slice(0, 3)
        .map((fp) => `${fp.exampleSymbol} ${fp.exampleDirection ?? ""} (${fp.confidence}, n=${fp.sampleCount})`)
        .join("; ");

  const toxicSummary = toxicFingerprints.length === 0
    ? "No toxic fingerprints available in current evidence."
    : toxicFingerprints
        .slice(0, 3)
        .map((fp) => `${fp.exampleSymbol} ${fp.exampleDirection ?? ""} (${fp.confidence}, n=${fp.sampleCount})`)
        .join("; ");

  const maturityWarning =
    "Current external similarity scoring is exploratory because the underlying promising/toxic fingerprints are still LOW confidence. " +
    "External candidates cannot be evaluated on route-level setup features without bot-specific shadow history. " +
    "Discovery scores in this report should be treated as observation hints, not profitability claims.";

  return {
    promisingFingerprintConfidence: highestPromising,
    toxicFingerprintConfidence: highestToxic,
    promisingFingerprintCount: promisingFingerprints.length,
    toxicFingerprintCount: toxicFingerprints.length,
    promisingFingerprintSummary: promisingSummary,
    toxicFingerprintSummary: toxicSummary,
    maturityWarning,
  };
}

function buildReadiness(
  promisingFingerprints: RotationFingerprint[],
  toxicFingerprints: RotationFingerprint[],
  externalConsidered: number,
  externalTradable: number,
  metadataDiagnostics: ExternalCandidateMetadataFetchDiagnostics,
): ExternalDiscoveryReadiness {
  const reasons: string[] = [];

  const advisoryReady = metadataDiagnostics.sourceStatus === "HEALTHY" || metadataDiagnostics.sourceStatus === "DEGRADED_USING_CACHE";
  const specificFailure =
    metadataDiagnostics.exchangeInfo.errorMessage ??
    metadataDiagnostics.ticker24h.errorMessage ??
    metadataDiagnostics.bookTicker.errorMessage;
  if (metadataDiagnostics.sourceStatus === "FAILED") {
    reasons.push(specificFailure
      ? `External candidate metadata fetch failed - ${specificFailure}`
      : "External candidate metadata fetch failed - discovery cannot operate yet.");
  } else if (metadataDiagnostics.sourceStatus === "DEGRADED_USING_CACHE") {
    reasons.push("Discovery is operating from cached metadata; fresh Binance fetch is currently degraded.");
  } else if (externalConsidered === 0) {
    reasons.push("Metadata loaded successfully but no external symbols survived the metadata assembly or exclusion path.");
  }

  if (promisingFingerprints.length === 0) {
    reasons.push("No promising fingerprints from Phase 2E.1 — similarity scoring lacks a positive reference.");
  } else if (promisingFingerprints.every((fp) => fp.confidence === "LOW")) {
    reasons.push("All promising fingerprints are LOW confidence — discovery scoring remains exploratory.");
  }

  if (toxicFingerprints.length === 0) {
    reasons.push("No toxic fingerprints from Phase 2E.1 — toxic similarity penalty defaults to structural floors only.");
  }

  if (externalTradable === 0 && externalConsidered > 0) {
    reasons.push("No external candidates passed tradability screen — adjust thresholds or wait for broader liquidity.");
  }

  reasons.push("readyForUniverseExpansionInfluence is always false — Phase 2E.2 cannot modify the active universe.");
  reasons.push("readyForRotationShadowOverlay is always false in Phase 2E.2 — overlay logic is reserved for Phase 2E.3.");

  let confidence: ExternalDiscoveryReadinessConfidence = "LOW";
  const anyMedium = promisingFingerprints.some((fp) => fp.confidence === "MEDIUM" || fp.confidence === "HIGH");
  if (anyMedium && externalTradable > 0) {
    confidence = "MEDIUM";
  }
  // HIGH confidence is unreachable in Phase 2E.2; reserved for future phases.

  return {
    advisoryEngineReady: advisoryReady,
    readyForUniverseExpansionInfluence: false,
    readyForRotationShadowOverlay: false,
    confidence,
    reasons,
  };
}

function buildPatchHypotheses(
  promisingFingerprints: RotationFingerprint[],
  toxicFingerprints: RotationFingerprint[],
  shortlistCount: number,
  externalTradable: number,
): ExternalDiscoveryPatchHypothesis[] {
  const hypotheses: ExternalDiscoveryPatchHypothesis[] = [];

  // 1. If fingerprints are still LOW confidence, the dominant action is to wait
  const promisingMature = promisingFingerprints.some((fp) => fp.confidence === "MEDIUM" || fp.confidence === "HIGH");
  if (!promisingMature) {
    hypotheses.push({
      title: "Wait for at least one promising fingerprint to reach MEDIUM confidence",
      evidenceSummary:
        `Current promising fingerprints (${promisingFingerprints.length}) are all LOW confidence. ` +
        `Until at least one symbol-direction cohort reaches EVALUABLE (30+ closes), external discovery scoring ` +
        `cannot be calibrated against a confirmed winner pattern. No external candidate inclusion is justified.`,
      likelyFutureAction: "WAIT_FOR_MATURE_WINNER_FINGERPRINT",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  // 2. If we have a shortlist, propose preparing a rotation shadow overlay (still doesNotImplementNow)
  if (shortlistCount > 0) {
    hypotheses.push({
      title: "Prepare design notes for a Phase 2E.3 rotation shadow overlay",
      evidenceSummary:
        `Phase 2E.2 produced ${shortlistCount} exploratory shortlist candidate(s). ` +
        `A future rotation shadow overlay (Phase 2E.3) could prospectively observe these external candidates ` +
        `in parallel with the active universe to validate whether discovery scoring identifies useful future additions. ` +
        `Overlay implementation is not started.`,
      likelyFutureAction: "PREPARE_ROTATION_SHADOW_OVERLAY",
      confidence: "LOW",
      patchStatus: promisingMature ? "AUDIT_DEEPER" : "WATCH",
      doesNotImplementNow: true,
    });
  }

  // 3. If toxic fingerprints exist but external metadata is shallow, suggest improving feature capture
  if (toxicFingerprints.length > 0 && externalTradable > 0) {
    hypotheses.push({
      title: "Improve external candidate feature capture for route-level similarity",
      evidenceSummary:
        `Current external metadata covers volume, spread, volatility, and funding only. ` +
        `Route-level fingerprint features (entry trigger geometry, regime context, ATR profile, etc.) cannot be ` +
        `computed for external symbols with the existing data pipeline. Expanding the external metadata snapshot ` +
        `would tighten Phase 2E.2's similarity scoring against the toxic-pattern penalty.`,
      likelyFutureAction: "IMPROVE_EXTERNAL_FEATURE_CAPTURE",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  // Fallback
  if (hypotheses.length === 0) {
    hypotheses.push({
      title: "No external discovery action recommended at current evidence maturity",
      evidenceSummary:
        `External candidate metadata=${externalTradable} tradable / ${shortlistCount} shortlisted. ` +
        `Promising fingerprints=${promisingFingerprints.length}, toxic=${toxicFingerprints.length}. ` +
        `Continue accumulating shadow evidence until Phase 2E.1 fingerprints reach MEDIUM confidence.`,
      likelyFutureAction: "NO_ACTION_YET",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  return hypotheses;
}

function buildAnswerCards(
  shortlist: ExternalCandidateDiscoveryAssessment[],
  rejectedSample: ExternalCandidateDiscoveryAssessment[],
  fingerprintBasis: ExternalDiscoveryFingerprintBasis,
  readiness: ExternalDiscoveryReadiness,
  externalConsidered: number,
  externalTradable: number,
): Array<{ question: string; answer: string }> {
  const top = shortlist[0];
  return [
    {
      question: "Which external symbols look most worth observing later?",
      answer: shortlist.length === 0
        ? `No external candidates qualified for the exploratory shortlist out of ${externalConsidered} considered ` +
          `(${externalTradable} tradable). Either thresholds rejected all candidates or fingerprint similarity is too weak. ` +
          `This is expected when promising fingerprint confidence is LOW.`
        : `Top exploratory candidate: ${top!.symbol} (net score ${top!.netDiscoveryScore}/100, tier ${top!.discoveryTier}). ` +
          `Full shortlist: ${shortlist.map((c) => `${c.symbol} (${c.netDiscoveryScore})`).join(", ")}. ` +
          `These are observation hints only — none are approved for inclusion in the live scanner universe.`,
    },
    {
      question: "Why were external candidates rejected?",
      answer: rejectedSample.length === 0
        ? `No rejection sample available — either all external symbols qualified or no metadata was loaded.`
        : `Sample of rejected external candidates: ` +
          rejectedSample
            .slice(0, 4)
            .map((c) => `${c.symbol} (${c.tradabilityVerdict})`)
            .join("; ") +
          `. Common reasons: insufficient 24h volume, status not TRADING, spread above advisory cap, or already in the active universe.`,
    },
    {
      question: "How confident is the underlying fingerprint basis?",
      answer:
        `Promising fingerprint confidence: ${fingerprintBasis.promisingFingerprintConfidence} (${fingerprintBasis.promisingFingerprintCount} fingerprint(s)). ` +
        `Toxic fingerprint confidence: ${fingerprintBasis.toxicFingerprintConfidence} (${fingerprintBasis.toxicFingerprintCount} fingerprint(s)). ` +
        `${fingerprintBasis.maturityWarning}`,
    },
    {
      question: "Is any external candidate eligible for automatic universe inclusion?",
      answer:
        `No. readyForUniverseExpansionInfluence is always false in Phase 2E.2. ` +
        `readyForRotationShadowOverlay is also false — overlay logic is reserved for Phase 2E.3. ` +
        `Current readiness confidence: ${readiness.confidence}. Shortlisted candidates are exploratory observation hints only.`,
    },
    {
      question: "What would Phase 2E.3 investigate that Phase 2E.2 does not?",
      answer:
        `Phase 2E.3 (not yet built) would add: ` +
        `(1) a rotation shadow overlay that prospectively observes shortlisted external symbols in parallel with the active universe, ` +
        `(2) per-candidate prospective performance tracking to validate whether discovery scoring actually identifies useful future additions, ` +
        `(3) comparison cohorts between shortlisted vs rejected/neutral candidates to measure discovery skill. ` +
        `None of this is implemented. Phase 2E.4 would be the earliest point where controlled universe influence could be considered, ` +
        `and only after explicit operator approval based on mature Phase 2E.3 evidence.`,
    },
  ];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildExternalCandidateDiscoveryIntelligenceReport(
  input: ExternalCandidateDiscoveryIntelligenceInput,
  now: Date = new Date(),
): ExternalCandidateDiscoveryIntelligenceReport {
  const evidenceEra = input.evidenceEra ?? "POST_CALIBRATION";
  const generatedAt = now.toISOString();
  const source = input.source ?? "binance_spot_exchange_info_24hr_ticker";
  const metadataDiagnostics = input.metadataDiagnostics ?? {
    sourceStatus: "NOT_ATTEMPTED",
    generatedAt,
    cacheStatus: "BYPASSED",
    servedFromCache: false,
    exchangeInfo: { ok: false, rawCount: 0 },
    ticker24h: { ok: false, rawCount: 0 },
    bookTicker: { ok: false, rawCount: 0 },
    join: {
      joinedMetadataCount: input.externalCandidateMetadata.length,
      missingTickerCount: 0,
      missingBookTickerCount: 0,
      finalMetadataCount: input.externalCandidateMetadata.length,
    },
    notes: ["Metadata diagnostics were not supplied by the caller."],
  } satisfies ExternalCandidateMetadataFetchDiagnostics;

  const currentUniverseSet = new Set(input.currentUniverseSymbols);

  // Mark metadata items that are in the current universe (defensive even if caller pre-marked them)
  const externalCandidates = input.externalCandidateMetadata.map((meta) => ({
    ...meta,
    alreadyInCurrentUniverse: meta.alreadyInCurrentUniverse || currentUniverseSet.has(meta.symbol),
  }));

  const assessments = externalCandidates.map((meta) =>
    buildAssessment(meta, input.promisingFingerprints, input.toxicFingerprints),
  );

  // Tradability breakdown
  const tradabilityBreakdown: Record<ExternalCandidateTradabilityVerdict, number> = {
    TRADABLE: 0,
    LOW_LIQUIDITY: 0,
    EXCESSIVE_SPREAD: 0,
    NOT_SUPPORTED_INSTRUMENT: 0,
    STATUS_NOT_TRADING: 0,
    DATA_INCOMPLETE: 0,
    CURRENT_UNIVERSE_MEMBER: 0,
  };
  for (const a of assessments) {
    tradabilityBreakdown[a.tradabilityVerdict] += 1;
  }

  const tradable = assessments.filter((a) => a.tradabilityVerdict === "TRADABLE");
  const externalTradable = tradable.filter((a) => !a.alreadyInCurrentUniverse).length;
  const externalRejected = assessments.length - tradable.length;

  // Shortlist: only tradable, non-current-universe, sorted by netDiscoveryScore desc
  const shortlistedCandidates = tradable
    .filter((a) => !a.alreadyInCurrentUniverse && a.discoveryTier !== "REJECTED" && a.discoveryTier !== "LOW_PRIORITY")
    .sort((a, b) => b.netDiscoveryScore - a.netDiscoveryScore)
    .slice(0, SHORTLIST_LIMIT);

  // Rejected sample: tradability-rejected + tradable-but-score-rejected (LOW_PRIORITY/REJECTED tier),
  // excluding current-universe members. Provides operator transparency on why candidates didn't make
  // the shortlist.
  const rejectedAssessments = assessments.filter((a) => {
    if (a.tradabilityVerdict === "CURRENT_UNIVERSE_MEMBER") return false;
    if (a.tradabilityVerdict !== "TRADABLE") return true;
    return a.discoveryTier === "REJECTED" || a.discoveryTier === "LOW_PRIORITY";
  });
  const rejectedCandidatesSample: ExternalCandidateDiscoveryAssessment[] = [];
  const seenVerdicts = new Set<ExternalCandidateTradabilityVerdict>();
  for (const a of rejectedAssessments) {
    if (!seenVerdicts.has(a.tradabilityVerdict) || rejectedCandidatesSample.length < REJECTED_SAMPLE_LIMIT) {
      rejectedCandidatesSample.push(a);
      seenVerdicts.add(a.tradabilityVerdict);
      if (rejectedCandidatesSample.length >= REJECTED_SAMPLE_LIMIT) break;
    }
  }

  // Category buckets
  const highLiquidityExploratory = tradable
    .filter((a) =>
      !a.alreadyInCurrentUniverse &&
      a.marketMetadataSummary.quoteVolume24h !== null &&
      a.marketMetadataSummary.quoteVolume24h > 500_000_000,
    )
    .slice(0, CATEGORY_BUCKET_LIMIT)
    .map((a) => a.symbol);

  const highVolatilityTradable = tradable
    .filter((a) =>
      !a.alreadyInCurrentUniverse &&
      a.marketMetadataSummary.priceChangePct24h !== null &&
      Math.abs(a.marketMetadataSummary.priceChangePct24h) > 15 &&
      Math.abs(a.marketMetadataSummary.priceChangePct24h) <= 30,
    )
    .slice(0, CATEGORY_BUCKET_LIMIT)
    .map((a) => a.symbol);

  const stableLiquidityCandidates = tradable
    .filter((a) =>
      !a.alreadyInCurrentUniverse &&
      a.marketMetadataSummary.quoteVolume24h !== null &&
      a.marketMetadataSummary.quoteVolume24h >= 50_000_000 &&
      a.marketMetadataSummary.quoteVolume24h <= 500_000_000 &&
      a.marketMetadataSummary.priceChangePct24h !== null &&
      Math.abs(a.marketMetadataSummary.priceChangePct24h) <= 15,
    )
    .slice(0, CATEGORY_BUCKET_LIMIT)
    .map((a) => a.symbol);

  const dataIncompleteCandidates = assessments
    .filter((a) => a.tradabilityVerdict === "DATA_INCOMPLETE")
    .slice(0, CATEGORY_BUCKET_LIMIT)
    .map((a) => a.symbol);

  const discoveryFingerprintBasis = buildFingerprintBasis(input.promisingFingerprints, input.toxicFingerprints);
  const discoveryReadiness = buildReadiness(
    input.promisingFingerprints,
    input.toxicFingerprints,
    externalCandidates.length,
    externalTradable,
    metadataDiagnostics,
  );
  const patchHypotheses = buildPatchHypotheses(
    input.promisingFingerprints,
    input.toxicFingerprints,
    shortlistedCandidates.length,
    externalTradable,
  );
  const answerCards = buildAnswerCards(
    shortlistedCandidates,
    rejectedCandidatesSample,
    discoveryFingerprintBasis,
    discoveryReadiness,
    externalCandidates.length,
    externalTradable,
  );

  return {
    generatedAt,
    evidenceEra,
    currentUniverseSymbolCount: input.currentUniverseSymbols.length,
    externalUniverseSymbolsConsidered: externalCandidates.length,
    externalUniverseSymbolsTradable: externalTradable,
    externalUniverseSymbolsRejected: externalRejected,
    metadataDiagnostics,
    discoveryReadiness,
    sourceMetadata: {
      source,
      instrumentTypeFilter: "SPOT or PERPETUAL",
      quoteAssetFilter: TRADABILITY_THRESHOLDS.quoteAssetFilter,
      minQuoteVolume24hUsd: TRADABILITY_THRESHOLDS.minQuoteVolume24hUsd,
      maxSpreadBps: TRADABILITY_THRESHOLDS.maxSpreadBps,
    },
    tradabilityBreakdown,
    discoveryFingerprintBasis,
    shortlistedCandidates,
    rejectedCandidatesSample,
    categoryBuckets: {
      highLiquidityExploratory,
      highVolatilityTradable,
      stableLiquidityCandidates,
      dataIncompleteCandidates,
    },
    patchHypotheses,
    answerCards,
    notes: [
      "External Candidate Discovery Intelligence is read-only. It does NOT change the active symbol universe, scanner ranking, routing, execution, gates, or any live trading behavior.",
      "External candidates are filtered for tradability: USDT quote, instrument status TRADING, 24h notional volume >= $10M, spread <= 10 bps.",
      "Discovery similarity scoring is METADATA-ONLY (volume, spread, volatility, funding). Route-level setup features are not computed for external symbols.",
      "Underlying promising/toxic fingerprints come from Phase 2E.1 — Universe Rotation Intelligence. Confidence remains LOW until per-symbol-direction cohorts reach EVALUABLE (30+ closes).",
      "Shortlisted candidates are exploratory observation hints. They are NOT approved for inclusion in the live scanner universe.",
      "All patch hypotheses carry doesNotImplementNow=true. No hypothesis can authorize behavior change.",
      "readyForUniverseExpansionInfluence is always false in Phase 2E.2.",
      "readyForRotationShadowOverlay is always false in Phase 2E.2 — reserved for Phase 2E.3.",
      "Phase 2E.3 (not yet built) would add a rotation shadow overlay to prospectively observe external candidates in parallel with the active universe.",
      "Phase 2E.4 (not yet built) would be the earliest point where controlled universe influence could be considered, only after explicit operator approval.",
    ],
  };
}

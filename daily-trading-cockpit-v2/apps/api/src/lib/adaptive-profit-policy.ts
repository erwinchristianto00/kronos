import type { StrategyExperienceRecord } from "@dtc/shared";

import type { ExternalRotationOverlayEconomicsReport } from "./external-rotation-overlay-economics.js";
import {
  REALISTIC_ROUND_TRIP_FEE_SLIP_BPS,
} from "./shadow-engine.js";
import type { ExternalRotationOverlayPerformanceReport } from "./external-rotation-overlay-performance.js";
import type {
  ExternalStrategyFitCandidateAssessment,
  ExternalStrategyFitEnrichmentReport,
} from "./external-strategy-fit-enrichment.js";
import {
  buildEvidenceConsensusAssessment,
  type EvidenceConsensusAssessment,
} from "./evidence-consensus.js";
import { evaluateLaneToxicSymbols } from "./lane-toxic-symbol-evaluator.js";
import {
  evaluateRefinedPromotion,
  type RefinedPromotionResult,
} from "./refined-policy-promotion.js";
import { buildSymbolRouteSuitabilityReport } from "./symbol-route-suitability.js";
import { buildTechnicalStopTpCredibilityReport } from "./technical-stop-tp-credibility.js";
import { buildUniverseRotationIntelligenceReport } from "./universe-rotation-intelligence.js";

export type AdaptiveProfitPolicyEvidenceEra = "POST_CALIBRATION" | "ALL_TIME";
export type AdaptiveProfitPolicySourceType = "CORE" | "EXTERNAL_OVERLAY";
export type AdaptiveProfitPolicyDirection = "LONG" | "SHORT" | "MIXED";
export type AdaptiveProfitPolicyVerdict =
  | "DEPLOYABLE_SHADOW_CANDIDATE"
  | "WATCHABLE"
  | "TOO_EARLY"
  | "REJECT";
export type AdaptiveProfitPolicyCredibility =
  | "CLEAN_EVALUABLE"
  | "CLEAN_WATCHABLE"
  | "CLEAN_EARLY"
  | "TOO_EARLY"
  | "DISTORTED"
  | "INSUFFICIENT_DATA";
export type AdaptiveProfitCollectionPriority =
  | "PRIMARY_PROFIT_LANE"
  | "SECONDARY_VALIDATION_LANE"
  | "OBSERVE_ONLY"
  | "REJECTED_FOR_CURRENT_POLICY";
export type OperativeCollectionMode =
  | "PRIMARY_LANE_ACTIVE"
  | "VALIDATION_ONLY"
  | "NO_PRIMARY_LANE_YET";
export type OperativeCollectionPriority =
  | "PRIMARY_PROFIT_LANE"
  | "SECONDARY_VALIDATION_LANE"
  | "OBSERVE_ONLY"
  | "REJECTED_FOR_CURRENT_POLICY";
export type OperativeAntiBiasRole =
  | "DOMINANT_DIRECTION"
  | "OPPOSITE_DIRECTION_VALIDATION"
  | "NEUTRAL_CONTROL"
  | "NOT_APPLICABLE";
export type AdaptiveDirectionBias =
  | "SHORT_BIAS"
  | "LONG_BIAS"
  | "SPLIT_BY_REGIME"
  | "NO_EDGE_YET";
export type DirectionLaneReadiness =
  | "PROMOTABLE"
  | "WATCHABLE"
  | "NO_PROMOTABLE_POLICY_YET";
export type MicroPilotReadinessVerdict =
  | "NOT_READY"
  | "WATCH_CLOSELY"
  | "NEARING_MICRO_PILOT"
  | "MICRO_PILOT_CANDIDATE";

export const MICRO_PILOT_THRESHOLDS = {
  minimumResolvedSample: 30,
  minimumNetAvgR: 0.15,
  minimumProfitFactor: 1.2,
  maximumDistortedRatio: 0.1,
  minimumRecentForwardEvidence: 10,
} as const;

export interface AdaptiveProfitPolicyCandidate {
  policyId: string;
  policyLabel: string;
  sourceType: AdaptiveProfitPolicySourceType;
  direction: AdaptiveProfitPolicyDirection;
  dominantRegime: string | null;
  route: string | null;
  exitPolicy: string | null;
  symbolScope: string;
  sampleSize: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  deltaVsBaseline: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  credibility: AdaptiveProfitPolicyCredibility;
  contaminationFlags: string[];
  validityFlags: string[];
  policyVerdict: AdaptiveProfitPolicyVerdict;
  blockers: string[];
  whyThisPolicyRanksHere: string[];
  rankingScore: number;
  evidenceConsensus: EvidenceConsensusAssessment;
  collectionPriority: AdaptiveProfitCollectionPriority;
  operativeCollectionPriority: OperativeCollectionPriority;
  collectionPriorityReason: string;
  collectionPriorityScore: number;
  collectionPriorityBlockers: string[];
  microPilotReadiness: {
    verdict: MicroPilotReadinessVerdict;
    microPilotReady: false;
    blockers: string[];
  };
  // EX_TOXIC sibling fields — only populated on sibling candidates
  excludedSymbols?: string[];
  tier2ToxicWatchlistSymbols?: string[];
  toxicSymbolExclusionReason?: string;
  // Realistic-venue cost basis — Binance USD-M Futures VIP 0 taker (5 bps/side fee)
  // Conservative basis (8 bps/side) remains canonical for all promotion/readiness decisions
  netAvgRRealisticBasis?: number | null;
  profitFactorRealisticBasis?: number | null;
  /** positive = realistic better than conservative (conservative overstates cost) */
  costDragRealisticBasis?: number | null;
  avgCostRRealisticBasis?: number | null;
  realisticBasisCoverage?: number;
}

export interface AdaptiveProfitPolicySynthesisReport {
  generatedAt: string;
  evidenceEra: AdaptiveProfitPolicyEvidenceEra;
  baseline: {
    sampleSize: number;
    netAvgR: number | null;
    grossAvgR: number | null;
    profitFactor: number | null;
  };
  candidates: AdaptiveProfitPolicyCandidate[];
  rankedTopPolicies: AdaptiveProfitPolicyCandidate[];
  bestOverallPolicy: AdaptiveProfitPolicyCandidate | null;
  bestShortPolicy: AdaptiveProfitPolicyCandidate | null;
  bestLongPolicy: AdaptiveProfitPolicyCandidate | null;
  /** Preserved original parent when bestShortPolicy was promoted to an EX_TOXIC sibling */
  bestShortPolicyParent?: AdaptiveProfitPolicyCandidate | null;
  /** Preserved original parent when bestLongPolicy was promoted to an EX_TOXIC sibling */
  bestLongPolicyParent?: AdaptiveProfitPolicyCandidate | null;
  /** Preserved original parent when bestOverallPolicy was promoted to an EX_TOXIC sibling */
  bestOverallPolicyParent?: AdaptiveProfitPolicyCandidate | null;
  bestOverallPolicyExToxic: AdaptiveProfitPolicyCandidate | null;
  bestShortPolicyExToxic: AdaptiveProfitPolicyCandidate | null;
  bestLongPolicyExToxic: AdaptiveProfitPolicyCandidate | null;
  /** Promotion evaluation result for the SHORT direction pair */
  shortPolicyPromotionResult?: RefinedPromotionResult;
  /** Promotion evaluation result for the LONG direction pair */
  longPolicyPromotionResult?: RefinedPromotionResult;
  /** Promotion evaluation result for the overall best policy pair */
  overallPolicyPromotionResult?: RefinedPromotionResult;
  currentAdaptiveDirectionBias: AdaptiveDirectionBias;
  directionalReadiness: {
    shortLaneReadiness: DirectionLaneReadiness;
    longLaneReadiness: DirectionLaneReadiness;
  };
  missingEvidenceForLongLane: string[];
  missingEvidenceForShortLane: string[];
  exploitShadowPriorities: {
    primaryProfitLane: AdaptiveProfitPolicyCandidate | null;
    secondaryValidationLane: AdaptiveProfitPolicyCandidate | null;
    observeOnlyLanes: AdaptiveProfitPolicyCandidate[];
    antiBiasSafeguard: string;
  };
  operativeCollectionPlan: {
    mode: OperativeCollectionMode;
    currentOperativePrimaryLane: AdaptiveProfitPolicyCandidate | null;
    secondaryValidationLanes: AdaptiveProfitPolicyCandidate[];
    observeOnlyLanes: AdaptiveProfitPolicyCandidate[];
    rejectedLanes: AdaptiveProfitPolicyCandidate[];
    collectionAntiBiasSummary: string;
    externalOverlayAdmissionUsesAdaptivePrioritization: true;
    primaryLaneBlockers: string[];
  };
  notes: string[];
}

export interface AdaptiveProfitPolicySynthesisInput {
  evidenceEra?: AdaptiveProfitPolicyEvidenceEra;
  externalRotationOverlay?: ExternalRotationOverlayPerformanceReport | null;
  externalRotationOverlayEconomics?: ExternalRotationOverlayEconomicsReport | null;
}

export interface OperativeExternalOverlayCandidateAssessment {
  operativeCollectionPriority: OperativeCollectionPriority;
  matchedPolicyId: string | null;
  matchedPolicyLabel: string | null;
  collectionPriorityReason: string;
  collectionPriorityScore: number;
  collectionPriorityBlockers: string[];
  antiBiasRole: OperativeAntiBiasRole;
}

interface Metrics {
  sampleSize: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
}

function emptyConsensus(): EvidenceConsensusAssessment {
  return {
    evidenceConsensusScore: 50,
    evidenceConsensusVerdict: "INSUFFICIENT_CONTEXT",
    positiveEvidenceCount: 0,
    negativeEvidenceCount: 0,
    conflictingEvidenceCount: 0,
    missingEvidenceCount: 0,
    keyConsensusReasons: [],
    keyConflictReasons: [],
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// Conservative round-trip fee+slip = (8+6)*2 = 28 bps, matching shadow-engine.ts FEE_BPS_PER_SIDE + SLIPPAGE_BPS_PER_SIDE
const CONSERVATIVE_ROUND_TRIP_FEE_SLIP_BPS = (8 + 6) * 2;

function realisticNetRFromRecord(record: StrategyExperienceRecord): number | null {
  const grossR = record.outcome.realizedGrossR;
  const feeSlipR = record.outcome.feeSlippageR;
  const spreadR = record.outcome.spreadR;
  if (
    typeof grossR !== "number" || !Number.isFinite(grossR) ||
    typeof feeSlipR !== "number" || !Number.isFinite(feeSlipR)
  ) return null;
  const realisticFeeSlipR = feeSlipR * (REALISTIC_ROUND_TRIP_FEE_SLIP_BPS / CONSERVATIVE_ROUND_TRIP_FEE_SLIP_BPS);
  const realisticCostR = realisticFeeSlipR + (typeof spreadR === "number" && Number.isFinite(spreadR) ? spreadR : 0);
  return grossR - realisticCostR;
}

export interface RealisticBasisMetrics {
  netAvgRRealisticBasis: number | null;
  profitFactorRealisticBasis: number | null;
  /** positive = realistic better than conservative (conservative overstates cost) */
  costDragRealisticBasis: number | null;
  avgCostRRealisticBasis: number | null;
  /** fraction of records with enough fields for realistic recompute */
  realisticBasisCoverage: number;
}

export function computeRealisticBasisMetrics(
  records: StrategyExperienceRecord[],
  conservativeNetAvgR: number | null,
): RealisticBasisMetrics {
  const realisticNetValues: number[] = [];
  let covered = 0;
  for (const record of records) {
    const rn = realisticNetRFromRecord(record);
    if (rn !== null) {
      realisticNetValues.push(rn);
      covered++;
    }
  }
  const coverage = records.length > 0 ? covered / records.length : 0;
  const netAvgRRealisticBasis = average(realisticNetValues);
  const pf = profitFactor(realisticNetValues);
  const costDragRealisticBasis =
    conservativeNetAvgR !== null && netAvgRRealisticBasis !== null
      ? round4(netAvgRRealisticBasis - conservativeNetAvgR)
      : null;
  const avgCostRValues: number[] = [];
  for (const record of records) {
    const grossR = record.outcome.realizedGrossR;
    const feeSlipR = record.outcome.feeSlippageR;
    const spreadR = record.outcome.spreadR;
    if (typeof grossR === "number" && Number.isFinite(grossR) && typeof feeSlipR === "number" && Number.isFinite(feeSlipR)) {
      const realisticFeeSlipR = feeSlipR * (REALISTIC_ROUND_TRIP_FEE_SLIP_BPS / CONSERVATIVE_ROUND_TRIP_FEE_SLIP_BPS);
      const realisticCostR = realisticFeeSlipR + (typeof spreadR === "number" && Number.isFinite(spreadR) ? spreadR : 0);
      avgCostRValues.push(realisticCostR);
    }
  }
  return {
    netAvgRRealisticBasis,
    profitFactorRealisticBasis: pf,
    costDragRealisticBasis,
    avgCostRRealisticBasis: average(avgCostRValues),
    realisticBasisCoverage: round4(coverage),
  };
}

function average(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return round4(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function profitFactor(values: number[]): number | null {
  const wins = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (losses <= 0) return wins > 0 ? null : 0;
  return round4(wins / losses);
}

function metricsOf(records: StrategyExperienceRecord[]): Metrics {
  const netValues = records.map((record) => record.outcome.realizedNetR).filter((value): value is number => typeof value === "number");
  const winners = netValues.filter((value) => value > 0);
  const losers = netValues.filter((value) => value < 0);
  return {
    sampleSize: records.length,
    netAvgR: average(netValues),
    grossAvgR: average(records.map((record) => record.outcome.realizedGrossR)),
    profitFactor: profitFactor(netValues),
    avgWinR: average(winners),
    avgLossR: average(losers),
  };
}

function filterByEra(records: StrategyExperienceRecord[], era: AdaptiveProfitPolicyEvidenceEra): StrategyExperienceRecord[] {
  if (era === "ALL_TIME") return records;
  return records.filter((record) => (record.context.evidenceEra ?? record.outcome.evidenceEra) === "POST_CALIBRATION");
}

function normalizedRegime(record: StrategyExperienceRecord): string | null {
  const value = record.context.marketRegime;
  if (!value) return null;
  const upper = String(value).toUpperCase();
  if (upper.includes("BULL")) return "BULLISH_EXPANSION";
  if (upper.includes("BEAR")) return "BEARISH_EXPANSION";
  if (upper.includes("SIDE") || upper.includes("RANGE") || upper.includes("CHOP")) return "SIDEWAYS";
  if (upper.includes("MIX")) return "MIXED";
  return upper;
}

function routeOf(record: StrategyExperienceRecord): string {
  return record.context.selectedEntryVariant ?? record.outcome.selectedEntryVariant ?? "UNKNOWN_ENTRY";
}

function exitOf(record: StrategyExperienceRecord): string {
  return record.context.selectedExitVariant ?? record.outcome.selectedExitVariant ?? "UNKNOWN_EXIT";
}

function safeId(value: string): string {
  return value.replace(/[^A-Z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function credibilityForCore(sampleSize: number): AdaptiveProfitPolicyCredibility {
  if (sampleSize >= 30) return "CLEAN_EVALUABLE";
  if (sampleSize >= 15) return "CLEAN_WATCHABLE";
  if (sampleSize >= 5) return "CLEAN_EARLY";
  return "TOO_EARLY";
}

function verdictFor(input: {
  sampleSize: number;
  netAvgR: number | null;
  profitFactor: number | null;
  credibility: AdaptiveProfitPolicyCredibility;
  deltaVsBaseline: number | null;
}): AdaptiveProfitPolicyVerdict {
  const profitFactorSufficient =
    (input.profitFactor ?? Number.NEGATIVE_INFINITY) >= MICRO_PILOT_THRESHOLDS.minimumProfitFactor ||
    (input.profitFactor === null && (input.netAvgR ?? Number.NEGATIVE_INFINITY) > 0);
  if (input.credibility === "DISTORTED" || input.credibility === "INSUFFICIENT_DATA") return "REJECT";
  if (input.sampleSize < 10) return "TOO_EARLY";
  if (
    input.sampleSize >= 30 &&
    (input.netAvgR ?? Number.NEGATIVE_INFINITY) >= MICRO_PILOT_THRESHOLDS.minimumNetAvgR &&
    profitFactorSufficient
  ) return "DEPLOYABLE_SHADOW_CANDIDATE";
  if (
    input.sampleSize >= 15 &&
    (input.deltaVsBaseline ?? Number.NEGATIVE_INFINITY) >= 0.15 &&
    (input.netAvgR ?? Number.NEGATIVE_INFINITY) >= -0.15
  ) return "WATCHABLE";
  if ((input.netAvgR ?? 0) < -0.25 && input.sampleSize >= 10) return "REJECT";
  return input.sampleSize >= 10 ? "WATCHABLE" : "TOO_EARLY";
}

function rankingScore(input: {
  sampleSize: number;
  netAvgR: number | null;
  profitFactor: number | null;
  deltaVsBaseline: number | null;
  credibility: AdaptiveProfitPolicyCredibility;
  direction: AdaptiveProfitPolicyDirection;
  dominantRegime: string | null;
}): number {
  const sampleScore = Math.min(35, input.sampleSize);
  const netScore = Math.max(-30, Math.min(30, (input.netAvgR ?? -1) * 40));
  const deltaScore = Math.max(-20, Math.min(20, (input.deltaVsBaseline ?? 0) * 35));
  const pfScore = input.profitFactor === null ? 0 : Math.max(-10, Math.min(15, (input.profitFactor - 1) * 15));
  const credibilityScore =
    input.credibility === "CLEAN_EVALUABLE" ? 20 :
    input.credibility === "CLEAN_WATCHABLE" ? 14 :
    input.credibility === "CLEAN_EARLY" ? 8 :
    input.credibility === "TOO_EARLY" ? 1 : -25;
  const alignedRegimeScore =
    (input.direction === "SHORT" && input.dominantRegime === "BEARISH_EXPANSION") ||
    (input.direction === "LONG" && input.dominantRegime === "BULLISH_EXPANSION")
      ? 5
      : 0;
  return round4(sampleScore + netScore + deltaScore + pfScore + credibilityScore + alignedRegimeScore);
}

function microPilotReadinessFor(candidate: Omit<AdaptiveProfitPolicyCandidate, "microPilotReadiness" | "collectionPriority">, distortedRatio: number | null): AdaptiveProfitPolicyCandidate["microPilotReadiness"] {
  const blockers: string[] = [];
  if (candidate.sampleSize < MICRO_PILOT_THRESHOLDS.minimumResolvedSample) {
    blockers.push(`Need at least ${MICRO_PILOT_THRESHOLDS.minimumResolvedSample} resolved samples.`);
  }
  if ((candidate.netAvgR ?? Number.NEGATIVE_INFINITY) < MICRO_PILOT_THRESHOLDS.minimumNetAvgR) {
    blockers.push(`Need netAvgR >= ${MICRO_PILOT_THRESHOLDS.minimumNetAvgR.toFixed(2)}R.`);
  }
  // 2026-07-12 fix: a null profitFactor means zero LOSING trades (division by zero, not a bad
  // sign) — treating it as -Infinity always failed this check, contradicting verdictFor's own
  // explicit null-PF exception in this same file. Same logic here: null PF is sufficient when
  // netAvgR is positive (the only real signal available in that case).
  const profitFactorSufficient =
    (candidate.profitFactor ?? Number.NEGATIVE_INFINITY) >= MICRO_PILOT_THRESHOLDS.minimumProfitFactor ||
    (candidate.profitFactor === null && (candidate.netAvgR ?? Number.NEGATIVE_INFINITY) > 0);
  if (!profitFactorSufficient) {
    blockers.push(`Need PF >= ${MICRO_PILOT_THRESHOLDS.minimumProfitFactor.toFixed(2)}.`);
  }
  if (candidate.credibility !== "CLEAN_EVALUABLE") {
    blockers.push("Need clean evaluable evidence quality.");
  }
  if ((distortedRatio ?? 0) > MICRO_PILOT_THRESHOLDS.maximumDistortedRatio) {
    blockers.push("Distorted sample ratio is above the allowed threshold.");
  }
  if (candidate.evidenceConsensus.evidenceConsensusVerdict === "CONFLICTED") {
    blockers.push("Evidence consensus is conflicted.");
  }
  // Same null-PF exception as profitFactorSufficient above.
  const profitFactorNearingSufficient =
    (candidate.profitFactor ?? Number.NEGATIVE_INFINITY) >= 1 ||
    (candidate.profitFactor === null && (candidate.netAvgR ?? Number.NEGATIVE_INFINITY) > 0);
  const verdict: MicroPilotReadinessVerdict =
    blockers.length === 0
      ? "MICRO_PILOT_CANDIDATE"
      : candidate.sampleSize >= 20 &&
          (candidate.netAvgR ?? Number.NEGATIVE_INFINITY) >= 0 &&
          profitFactorNearingSufficient
        ? "NEARING_MICRO_PILOT"
        : candidate.sampleSize >= 10
          ? "WATCH_CLOSELY"
          : "NOT_READY";
  return { verdict, microPilotReady: false, blockers };
}

function operativePriorityBlockers(candidate: AdaptiveProfitPolicyCandidate): string[] {
  const blockers: string[] = [];
  if (candidate.contaminationFlags.length > 0 && !candidate.validityFlags.includes("VALID_POST_FIX_V2_ONLY")) {
    blockers.push("Evidence is contaminated or invalid.");
  }
  if (candidate.policyVerdict === "REJECT") blockers.push("Policy engine rejects this lane.");
  if (candidate.sampleSize < 10) blockers.push("Resolved sample is below 10.");
  if ((candidate.netAvgR ?? Number.NEGATIVE_INFINITY) < 0) blockers.push("Net economics are still negative.");
  if (candidate.evidenceConsensus.evidenceConsensusVerdict === "CONFLICTED") blockers.push("Evidence consensus is conflicted.");
  return blockers;
}

function canBeOperativePrimary(candidate: AdaptiveProfitPolicyCandidate): boolean {
  if (candidate.policyVerdict === "REJECT" || candidate.policyVerdict === "TOO_EARLY") return false;
  if (candidate.sampleSize < 15) return false;
  if ((candidate.netAvgR ?? Number.NEGATIVE_INFINITY) < 0) return false;
  if (!["HIGH_CONSENSUS", "MODERATE_CONSENSUS"].includes(candidate.evidenceConsensus.evidenceConsensusVerdict)) return false;
  if (candidate.contaminationFlags.length > 0 && !candidate.validityFlags.includes("VALID_POST_FIX_V2_ONLY")) return false;
  return true;
}

function operativeScore(candidate: AdaptiveProfitPolicyCandidate): number {
  const verdictBonus =
    candidate.policyVerdict === "DEPLOYABLE_SHADOW_CANDIDATE" ? 20 :
    candidate.policyVerdict === "WATCHABLE" ? 10 :
    candidate.policyVerdict === "TOO_EARLY" ? 0 : -20;
  const consensusBonus =
    candidate.evidenceConsensus.evidenceConsensusVerdict === "HIGH_CONSENSUS" ? 8 :
    candidate.evidenceConsensus.evidenceConsensusVerdict === "MODERATE_CONSENSUS" ? 4 :
    candidate.evidenceConsensus.evidenceConsensusVerdict === "CONFLICTED" ? -8 : 0;
  return round4(candidate.rankingScore + verdictBonus + consensusBonus);
}

function assignOperativeCollectionPlan(candidates: AdaptiveProfitPolicyCandidate[]): AdaptiveProfitPolicySynthesisReport["operativeCollectionPlan"] {
  const ranked = [...candidates].sort(compareCandidates);
  for (const candidate of ranked) {
    candidate.collectionPriorityScore = operativeScore(candidate);
    candidate.collectionPriorityBlockers = operativePriorityBlockers(candidate);
    candidate.operativeCollectionPriority = candidate.policyVerdict === "REJECT"
      ? "REJECTED_FOR_CURRENT_POLICY"
      : "OBSERVE_ONLY";
    candidate.collectionPriorityReason = candidate.policyVerdict === "REJECT"
      ? "Rejected by the current policy engine."
      : "Retained for observation until operative evidence is stronger.";
  }

  const primary = ranked.find((candidate) => canBeOperativePrimary(candidate)) ?? null;
  if (primary) {
    primary.operativeCollectionPriority = "PRIMARY_PROFIT_LANE";
    primary.collectionPriorityReason = "Top clean lane with non-negative economics and at least moderate consensus.";
  }

  const secondaryCandidates = ranked.filter((candidate) =>
    candidate.policyId !== primary?.policyId &&
    candidate.policyVerdict !== "REJECT" &&
    (
      candidate.policyVerdict === "WATCHABLE" ||
      candidate.sourceType === "EXTERNAL_OVERLAY" ||
      candidate.evidenceConsensus.evidenceConsensusVerdict === "CONFLICTED" ||
      candidate.deltaVsBaseline !== null && candidate.deltaVsBaseline >= 0.15
    ),
  );
  const secondaryValidationLanes = secondaryCandidates.slice(0, 2);
  for (const candidate of secondaryValidationLanes) {
    candidate.operativeCollectionPriority = "SECONDARY_VALIDATION_LANE";
    candidate.collectionPriorityReason =
      candidate.evidenceConsensus.evidenceConsensusVerdict === "CONFLICTED"
        ? "Economically interesting but conflicted; prioritize validation rather than primary exploitation."
        : "Promising but not yet clean enough for operative primary collection.";
  }

  const rejectedLanes = ranked.filter((candidate) => candidate.operativeCollectionPriority === "REJECTED_FOR_CURRENT_POLICY");
  const observeOnlyLanes = ranked.filter((candidate) => candidate.operativeCollectionPriority === "OBSERVE_ONLY");
  const mode: OperativeCollectionMode = primary
    ? "PRIMARY_LANE_ACTIVE"
    : secondaryValidationLanes.length > 0
      ? "VALIDATION_ONLY"
      : "NO_PRIMARY_LANE_YET";
  const bestCandidate = ranked.find((candidate) => candidate.policyVerdict !== "REJECT") ?? null;
  return {
    mode,
    currentOperativePrimaryLane: primary,
    secondaryValidationLanes,
    observeOnlyLanes,
    rejectedLanes,
    collectionAntiBiasSummary: "Bounded overlay admission retains at least one eligible opposite-direction validation candidate when available, so LONG evidence is not starved under a SHORT_BIAS posture.",
    externalOverlayAdmissionUsesAdaptivePrioritization: true,
    primaryLaneBlockers: primary ? [] : bestCandidate?.collectionPriorityBlockers ?? ["No candidate lane is strong enough for operative primary collection yet."],
  };
}

function externalCandidateDirection(candidate: ExternalStrategyFitCandidateAssessment): AdaptiveProfitPolicyDirection {
  if (candidate.directionalContext === "LONG_FAVORED") return "LONG";
  if (candidate.directionalContext === "SHORT_FAVORED") return "SHORT";
  return "MIXED";
}

function antiBiasRoleFor(direction: AdaptiveProfitPolicyDirection, posture: AdaptiveDirectionBias): OperativeAntiBiasRole {
  if (direction === "MIXED") return "NEUTRAL_CONTROL";
  if (posture === "SHORT_BIAS") return direction === "SHORT" ? "DOMINANT_DIRECTION" : "OPPOSITE_DIRECTION_VALIDATION";
  if (posture === "LONG_BIAS") return direction === "LONG" ? "DOMINANT_DIRECTION" : "OPPOSITE_DIRECTION_VALIDATION";
  if (posture === "SPLIT_BY_REGIME") return "NEUTRAL_CONTROL";
  return "NOT_APPLICABLE";
}

export function assessExternalOverlayCandidateOperativePriority(
  candidate: ExternalStrategyFitCandidateAssessment,
  enrichment: ExternalStrategyFitEnrichmentReport,
  synthesis: AdaptiveProfitPolicySynthesisReport | null | undefined,
): OperativeExternalOverlayCandidateAssessment {
  const direction = externalCandidateDirection(candidate);
  if (!synthesis) {
    return {
      operativeCollectionPriority: "OBSERVE_ONLY",
      matchedPolicyId: null,
      matchedPolicyLabel: null,
      collectionPriorityReason: "No adaptive profit policy synthesis was supplied.",
      collectionPriorityScore: candidate.strategyFitScore,
      collectionPriorityBlockers: ["Operative synthesis unavailable."],
      antiBiasRole: "NOT_APPLICABLE",
    };
  }
  const route = candidate.bestObservedExternalRouteHypothesis.selectedEntryVariant;
  const exit = candidate.bestObservedExternalRouteHypothesis.selectedExitVariant;
  const regime = enrichment.globalMarketContext.inferredExternalShortlistRegime;
  const matchedCorePolicy = synthesis.candidates.find((policy) =>
    policy.sourceType === "CORE" &&
    policy.symbolScope === "ALL_SYMBOLS" &&
    policy.direction === direction &&
    policy.dominantRegime === regime &&
    policy.route === route &&
    policy.exitPolicy === exit,
  );
  const matchedExternalPolicy = synthesis.candidates.find((policy) => policy.policyId === "EXTERNAL_STRATEGY_FIT_SHORTLIST");
  const matched = matchedCorePolicy ?? (
    candidate.strategyFitTier !== "STRATEGY_FIT_LOW" && candidate.strategyFitTier !== "NOT_EVALUABLE"
      ? matchedExternalPolicy ?? null
      : null
  );
  if (!matched) {
    return {
      operativeCollectionPriority: "OBSERVE_ONLY",
      matchedPolicyId: null,
      matchedPolicyLabel: null,
      collectionPriorityReason: "No operative Phase 2F lane matched this detached external candidate.",
      collectionPriorityScore: candidate.strategyFitScore,
      collectionPriorityBlockers: ["No matching operative lane."],
      antiBiasRole: antiBiasRoleFor(direction, synthesis.currentAdaptiveDirectionBias),
    };
  }
  return {
    operativeCollectionPriority: matched.operativeCollectionPriority,
    matchedPolicyId: matched.policyId,
    matchedPolicyLabel: matched.policyLabel,
    collectionPriorityReason: matched.collectionPriorityReason,
    collectionPriorityScore: matched.collectionPriorityScore,
    collectionPriorityBlockers: matched.collectionPriorityBlockers,
    antiBiasRole: antiBiasRoleFor(direction, synthesis.currentAdaptiveDirectionBias),
  };
}

function corePolicyCandidates(records: StrategyExperienceRecord[], baseline: Metrics): AdaptiveProfitPolicyCandidate[] {
  const byGroup = new Map<string, StrategyExperienceRecord[]>();
  for (const record of records) {
    const regime = normalizedRegime(record) ?? "UNKNOWN_REGIME";
    const direction = record.context.direction;
    const route = routeOf(record);
    const exit = exitOf(record);
    const keys = [
      `ALL|${regime}|${direction}|${route}|${exit}`,
      `${record.context.symbol}|${regime}|${direction}|${route}|${exit}`,
    ];
    for (const key of keys) {
      const list = byGroup.get(key) ?? [];
      list.push(record);
      byGroup.set(key, list);
    }
  }
  const out: AdaptiveProfitPolicyCandidate[] = [];
  for (const [key, group] of byGroup) {
    const [scope, regime, direction, route, exit] = key.split("|") as [string, string, "LONG" | "SHORT", string, string];
    const metrics = metricsOf(group);
    const deltaVsBaseline = metrics.netAvgR !== null && baseline.netAvgR !== null ? round4(metrics.netAvgR - baseline.netAvgR) : null;
    const credibility = credibilityForCore(metrics.sampleSize);
    const baseCandidate = {
      policyId: `CORE_${safeId(scope)}_${safeId(regime)}_${direction}_${safeId(route)}_${safeId(exit)}`,
      policyLabel: `${regime} + ${direction} + ${route} + ${exit}${scope === "ALL" ? "" : ` + ${scope}`}`,
      sourceType: "CORE" as const,
      direction,
      dominantRegime: regime === "UNKNOWN_REGIME" ? null : regime,
      route,
      exitPolicy: exit,
      symbolScope: scope === "ALL" ? "ALL_SYMBOLS" : scope,
      sampleSize: metrics.sampleSize,
      netAvgR: metrics.netAvgR,
      grossAvgR: metrics.grossAvgR,
      profitFactor: metrics.profitFactor,
      deltaVsBaseline,
      avgWinR: metrics.avgWinR,
      avgLossR: metrics.avgLossR,
      credibility,
      contaminationFlags: [] as string[],
      validityFlags: ["POST_CALIBRATION_FILTERED_CORE_RECORDS"],
      policyVerdict: verdictFor({
        sampleSize: metrics.sampleSize,
        netAvgR: metrics.netAvgR,
        profitFactor: metrics.profitFactor,
        credibility,
        deltaVsBaseline,
      }),
      blockers: [] as string[],
      whyThisPolicyRanksHere: [] as string[],
      rankingScore: 0,
      evidenceConsensus: emptyConsensus(),
      operativeCollectionPriority: "OBSERVE_ONLY" as OperativeCollectionPriority,
      collectionPriorityReason: "Not yet evaluated for operative collection.",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [] as string[],
    };
    if (metrics.sampleSize < 10) baseCandidate.blockers.push("Sample is below 10 closes.");
    if ((metrics.netAvgR ?? Number.NEGATIVE_INFINITY) < 0) baseCandidate.blockers.push("Net economics are not positive yet.");
    if ((metrics.profitFactor ?? Number.NEGATIVE_INFINITY) < 1) baseCandidate.blockers.push("Profit factor is below 1.0.");
    baseCandidate.rankingScore = rankingScore(baseCandidate);
    baseCandidate.whyThisPolicyRanksHere = [
      `n=${metrics.sampleSize}, netAvgR=${metrics.netAvgR?.toFixed(4) ?? "n/a"}, delta=${deltaVsBaseline?.toFixed(4) ?? "n/a"}.`,
      `Credibility=${credibility}; regime-direction=${baseCandidate.dominantRegime ?? "UNKNOWN"}/${direction}.`,
    ];
    const microPilotReadiness = microPilotReadinessFor(baseCandidate, 0);
    const realisticMetrics = computeRealisticBasisMetrics(group, metrics.netAvgR);
    out.push({
      ...baseCandidate,
      collectionPriority: "OBSERVE_ONLY",
      microPilotReadiness,
      netAvgRRealisticBasis: realisticMetrics.netAvgRRealisticBasis,
      profitFactorRealisticBasis: realisticMetrics.profitFactorRealisticBasis,
      costDragRealisticBasis: realisticMetrics.costDragRealisticBasis,
      avgCostRRealisticBasis: realisticMetrics.avgCostRRealisticBasis,
      realisticBasisCoverage: realisticMetrics.realisticBasisCoverage,
    });
  }
  return out;
}

function externalCandidate(
  overlay: ExternalRotationOverlayPerformanceReport | null | undefined,
  economics: ExternalRotationOverlayEconomicsReport | null | undefined,
  baseline: Metrics,
): AdaptiveProfitPolicyCandidate | null {
  if (!overlay) return null;
  const performance = overlay.groupPerformance.find((group) => group.group === "STRATEGY_FIT_SHORTLIST");
  if (!performance) return null;
  const economicsGroup = economics?.groups.find((group) => group.group === "STRATEGY_FIT_SHORTLIST");
  const credibilityGroup = economics?.credibilityGroups.find((group) => group.group === "STRATEGY_FIT_SHORTLIST");
  const distortedRatio = credibilityGroup?.pctDistorted ?? null;
  const headlineSampleSize = performance.headlineResolvedCount;
  const credibility: AdaptiveProfitPolicyCredibility =
    !economicsGroup || headlineSampleSize === 0
      ? "INSUFFICIENT_DATA"
      : credibilityGroup?.credibilityVerdict === "ALL_INTERPRETABLE"
        ? headlineSampleSize >= 30 ? "CLEAN_EVALUABLE" : headlineSampleSize >= 10 ? "CLEAN_WATCHABLE" : "CLEAN_EARLY"
        : credibilityGroup?.credibilityVerdict === "MIXED"
          ? "DISTORTED"
          : "INSUFFICIENT_DATA";
  const deltaVsBaseline =
    performance.netAvgR !== null && baseline.netAvgR !== null
      ? round4(performance.netAvgR - baseline.netAvgR)
      : null;
  const baseCandidate = {
    policyId: "EXTERNAL_STRATEGY_FIT_SHORTLIST",
    policyLabel: "External strategy-fit shortlist lane",
    sourceType: "EXTERNAL_OVERLAY" as const,
    direction: "MIXED" as const,
    dominantRegime: null,
    route: null,
    exitPolicy: null,
    symbolScope: "EXTERNAL_STRATEGY_FIT_SHORTLIST",
    sampleSize: headlineSampleSize,
    netAvgR: performance.netAvgR,
    grossAvgR: performance.grossAvgR,
    profitFactor: performance.profitFactor,
    deltaVsBaseline,
    avgWinR: null,
    avgLossR: null,
    credibility,
    contaminationFlags: overlay.validityCounts.legacyInvalidExcludedCount > 0
      ? ["LEGACY_V1_EXCLUDED_FROM_SOURCE_TAPE"]
      : [],
    validityFlags: ["VALID_POST_FIX_V2_ONLY", `INTERPRETABILITY_${economics?.externalOverlayInterpretability.netRotationComparisonStatus ?? "UNKNOWN"}`],
    policyVerdict: verdictFor({
      sampleSize: headlineSampleSize,
      netAvgR: performance.netAvgR,
      profitFactor: performance.profitFactor,
      credibility,
      deltaVsBaseline,
    }),
    blockers: [] as string[],
    whyThisPolicyRanksHere: [] as string[],
    rankingScore: 0,
    evidenceConsensus: emptyConsensus(),
    operativeCollectionPriority: "OBSERVE_ONLY" as OperativeCollectionPriority,
    collectionPriorityReason: "Not yet evaluated for operative collection.",
    collectionPriorityScore: 0,
    collectionPriorityBlockers: [] as string[],
  };
  if (headlineSampleSize < 10) baseCandidate.blockers.push("Forward overlay interpretable sample is below 10 resolved observations.");
  if (credibility !== "CLEAN_EVALUABLE" && credibility !== "CLEAN_WATCHABLE" && credibility !== "CLEAN_EARLY") {
    baseCandidate.blockers.push("Overlay economics are not clean enough for policy promotion.");
  }
  baseCandidate.rankingScore = rankingScore(baseCandidate);
  baseCandidate.whyThisPolicyRanksHere = [
    `V2-valid interpretable resolved=${headlineSampleSize}, netAvgR=${performance.netAvgR?.toFixed(4) ?? "n/a"}.`,
    `External tape stays distinct from core evidence; credibility=${credibility}.`,
  ];
  return {
    ...baseCandidate,
    collectionPriority: "OBSERVE_ONLY",
    microPilotReadiness: microPilotReadinessFor(baseCandidate, distortedRatio),
  };
}

function compareCandidates(left: AdaptiveProfitPolicyCandidate, right: AdaptiveProfitPolicyCandidate): number {
  const verdictRank = (candidate: AdaptiveProfitPolicyCandidate): number => {
    switch (candidate.policyVerdict) {
      case "DEPLOYABLE_SHADOW_CANDIDATE": return 4;
      case "WATCHABLE": return 3;
      case "TOO_EARLY": return 2;
      case "REJECT": return 1;
    }
  };
  const verdictDelta = verdictRank(right) - verdictRank(left);
  if (verdictDelta !== 0) return verdictDelta;
  const credibilityRank = (candidate: AdaptiveProfitPolicyCandidate): number => {
    switch (candidate.credibility) {
      case "CLEAN_EVALUABLE": return 5;
      case "CLEAN_WATCHABLE": return 4;
      case "CLEAN_EARLY": return 3;
      case "TOO_EARLY": return 2;
      case "INSUFFICIENT_DATA": return 1;
      case "DISTORTED": return 0;
    }
  };
  const credibilityDelta = credibilityRank(right) - credibilityRank(left);
  if (credibilityDelta !== 0) return credibilityDelta;
  return right.rankingScore - left.rankingScore;
}

function consensusAdjustment(candidate: AdaptiveProfitPolicyCandidate): number {
  switch (candidate.evidenceConsensus.evidenceConsensusVerdict) {
    case "HIGH_CONSENSUS": return 6;
    case "MODERATE_CONSENSUS": return 3;
    case "MIXED": return 0;
    case "CONFLICTED": return -8;
    case "INSUFFICIENT_CONTEXT": return 0;
  }
}

function recordsForCandidate(
  records: StrategyExperienceRecord[],
  candidate: AdaptiveProfitPolicyCandidate,
): StrategyExperienceRecord[] {
  if (candidate.sourceType !== "CORE") return [];
  return records.filter((record) => {
    if (candidate.symbolScope !== "ALL_SYMBOLS" && record.context.symbol !== candidate.symbolScope) return false;
    if (record.context.direction !== candidate.direction) return false;
    if (normalizedRegime(record) !== candidate.dominantRegime) return false;
    if (routeOf(record) !== candidate.route) return false;
    return exitOf(record) === candidate.exitPolicy;
  });
}

function laneReadiness(candidate: AdaptiveProfitPolicyCandidate | null): DirectionLaneReadiness {
  if (!candidate) return "NO_PROMOTABLE_POLICY_YET";
  if (candidate.policyVerdict === "DEPLOYABLE_SHADOW_CANDIDATE") return "PROMOTABLE";
  if (candidate.policyVerdict === "WATCHABLE") return "WATCHABLE";
  return "NO_PROMOTABLE_POLICY_YET";
}

function missingEvidence(direction: "LONG" | "SHORT", candidate: AdaptiveProfitPolicyCandidate | null): string[] {
  if (!candidate) return [`No ${direction} lane has enough evidence to rank yet.`];
  const out = [...candidate.blockers];
  if (candidate.policyVerdict !== "DEPLOYABLE_SHADOW_CANDIDATE") {
    out.unshift(`No promotable ${direction} policy yet.`);
  }
  return out;
}

function assignPriorities(candidates: AdaptiveProfitPolicyCandidate[], bestOverall: AdaptiveProfitPolicyCandidate | null, bestLong: AdaptiveProfitPolicyCandidate | null): {
  primaryProfitLane: AdaptiveProfitPolicyCandidate | null;
  secondaryValidationLane: AdaptiveProfitPolicyCandidate | null;
  observeOnlyLanes: AdaptiveProfitPolicyCandidate[];
} {
  const ranked = [...candidates].sort(compareCandidates);
  const primary = bestOverall && bestOverall.policyVerdict !== "REJECT" ? bestOverall : null;
  const secondary = ranked.find((candidate) =>
    candidate.policyId !== primary?.policyId &&
    candidate.policyVerdict !== "REJECT" &&
    candidate.sourceType !== primary?.sourceType &&
    candidate.evidenceConsensus.evidenceConsensusVerdict !== "CONFLICTED",
  ) ?? ranked.find((candidate) =>
    candidate.policyId !== primary?.policyId &&
    candidate.policyVerdict !== "REJECT" &&
    candidate.evidenceConsensus.evidenceConsensusVerdict !== "CONFLICTED",
  ) ?? null;
  for (const candidate of candidates) {
    if (candidate.policyVerdict === "REJECT") candidate.collectionPriority = "REJECTED_FOR_CURRENT_POLICY";
    else if (candidate.evidenceConsensus.evidenceConsensusVerdict === "CONFLICTED") candidate.collectionPriority = "OBSERVE_ONLY";
    else if (candidate.policyId === primary?.policyId) candidate.collectionPriority = "PRIMARY_PROFIT_LANE";
    else if (candidate.policyId === secondary?.policyId) candidate.collectionPriority = "SECONDARY_VALIDATION_LANE";
    else candidate.collectionPriority = "OBSERVE_ONLY";
  }
  const observeOnly = candidates.filter((candidate) => candidate.collectionPriority === "OBSERVE_ONLY");
  if (bestLong && !observeOnly.some((candidate) => candidate.policyId === bestLong.policyId) && bestLong.policyId !== primary?.policyId && bestLong.policyId !== secondary?.policyId) {
    bestLong.collectionPriority = "OBSERVE_ONLY";
  }
  return { primaryProfitLane: primary, secondaryValidationLane: secondary, observeOnlyLanes: candidates.filter((candidate) => candidate.collectionPriority === "OBSERVE_ONLY") };
}

export function buildAdaptiveProfitPolicySynthesisReport(
  records: StrategyExperienceRecord[],
  input: AdaptiveProfitPolicySynthesisInput = {},
  now: Date = new Date(),
): AdaptiveProfitPolicySynthesisReport {
  const evidenceEra = input.evidenceEra ?? "POST_CALIBRATION";
  const filtered = filterByEra(records, evidenceEra);
  const baseline = metricsOf(filtered);
  const symbolRouteSuitability = buildSymbolRouteSuitabilityReport(filtered, { evidenceEra });
  const universeRotation = buildUniverseRotationIntelligenceReport(filtered, { evidenceEra });
  const technicalStopTpCredibility = buildTechnicalStopTpCredibilityReport(filtered, { evidenceEra });
  const candidates = corePolicyCandidates(filtered, baseline);
  const external = externalCandidate(input.externalRotationOverlay, input.externalRotationOverlayEconomics, baseline);
  if (external) candidates.push(external);
  for (const candidate of candidates) {
    candidate.evidenceConsensus = buildEvidenceConsensusAssessment({
      candidate,
      candidateRecords: recordsForCandidate(filtered, candidate),
      symbolRouteSuitability,
      universeRotation,
      technicalStopTpCredibility,
    });
    candidate.rankingScore = round4(candidate.rankingScore + consensusAdjustment(candidate));
    candidate.whyThisPolicyRanksHere.push(
      `Consensus=${candidate.evidenceConsensus.evidenceConsensusVerdict} (score=${candidate.evidenceConsensus.evidenceConsensusScore}).`,
    );
    if (candidate.evidenceConsensus.evidenceConsensusVerdict === "CONFLICTED") {
      candidate.blockers.push("Evidence consensus is conflicted.");
    }
    const distortedRatio = candidate.sourceType === "EXTERNAL_OVERLAY"
      ? input.externalRotationOverlayEconomics?.credibilityGroups.find((group) => group.group === "STRATEGY_FIT_SHORTLIST")?.pctDistorted ?? null
      : null;
    candidate.microPilotReadiness = microPilotReadinessFor(candidate, distortedRatio);
  }
  candidates.sort(compareCandidates);

  const bestOverallPolicy = candidates.find((candidate) => candidate.policyVerdict !== "REJECT") ?? null;
  const bestShortPolicy =
    candidates.find((candidate) => candidate.direction === "SHORT" && candidate.policyVerdict !== "REJECT") ??
    candidates.find((candidate) => candidate.direction === "SHORT") ??
    null;
  const bestLongPolicy =
    candidates.find((candidate) => candidate.direction === "LONG" && candidate.policyVerdict !== "REJECT") ??
    candidates.find((candidate) => candidate.direction === "LONG") ??
    null;

  // ── EX_TOXIC sibling generation ──────────────────────────────────────────────
  // For each unique (ALL_SYMBOLS, CORE) "best" lane candidate, evaluate toxic symbols
  // and emit a sibling with excludedSymbols = tier-1 toxic list (if any exist).
  const universeRotationPressureSymbols = new Set(
    universeRotation.rotationPressureCandidates.map((c) => c.symbol),
  );
  const symbolSensitiveLaneSignal = symbolRouteSuitability.routeHeterogeneity.some(
    (h) => h.verdict === "SYMBOL_SENSITIVE",
  );

  function buildExToxicSibling(
    original: AdaptiveProfitPolicyCandidate,
  ): AdaptiveProfitPolicyCandidate | null {
    if (
      original.sourceType !== "CORE" ||
      original.symbolScope !== "ALL_SYMBOLS" ||
      original.dominantRegime === null ||
      original.route === null ||
      original.exitPolicy === null
    ) return null;

    const toxicEval = evaluateLaneToxicSymbols(
      filtered,
      {
        regime: original.dominantRegime,
        direction: original.direction as "LONG" | "SHORT",
        entryVariant: original.route,
        exitVariant: original.exitPolicy,
      },
      {
        universeRotationPressureSymbols,
        symbolSensitiveLaneSignal,
      },
    );

    if (toxicEval.tier1ToxicSymbols.length === 0) return null;

    const excludedSet = new Set(toxicEval.tier1ToxicSymbols);
    const filteredLaneRecords = filtered.filter((record) => {
      if (record.context.direction !== original.direction) return false;
      const regime = normalizedRegime(record);
      if (regime !== original.dominantRegime) return false;
      if (routeOf(record) !== original.route) return false;
      if (exitOf(record) !== original.exitPolicy) return false;
      return !excludedSet.has(record.context.symbol);
    });

    const siblingMetrics = metricsOf(filteredLaneRecords);
    const siblingDeltaVsBaseline =
      siblingMetrics.netAvgR !== null && baseline.netAvgR !== null
        ? round4(siblingMetrics.netAvgR - baseline.netAvgR)
        : null;
    const siblingCredibility = credibilityForCore(siblingMetrics.sampleSize);
    const siblingPolicyId = `${original.policyId}_EX_TOXIC`;

    const siblingBase = {
      policyId: siblingPolicyId,
      policyLabel: `${original.policyLabel} [EX_TOXIC: ${toxicEval.tier1ToxicSymbols.join(",")}]`,
      sourceType: "CORE" as const,
      direction: original.direction,
      dominantRegime: original.dominantRegime,
      route: original.route,
      exitPolicy: original.exitPolicy,
      symbolScope: "ALL_SYMBOLS_EX_TOXIC",
      sampleSize: siblingMetrics.sampleSize,
      netAvgR: siblingMetrics.netAvgR,
      grossAvgR: siblingMetrics.grossAvgR,
      profitFactor: siblingMetrics.profitFactor,
      deltaVsBaseline: siblingDeltaVsBaseline,
      avgWinR: siblingMetrics.avgWinR,
      avgLossR: siblingMetrics.avgLossR,
      credibility: siblingCredibility,
      contaminationFlags: [] as string[],
      validityFlags: ["POST_CALIBRATION_FILTERED_CORE_RECORDS", "EX_TOXIC_SYMBOL_FILTERED"],
      policyVerdict: verdictFor({
        sampleSize: siblingMetrics.sampleSize,
        netAvgR: siblingMetrics.netAvgR,
        profitFactor: siblingMetrics.profitFactor,
        credibility: siblingCredibility,
        deltaVsBaseline: siblingDeltaVsBaseline,
      }),
      blockers: [] as string[],
      whyThisPolicyRanksHere: [
        `EX_TOXIC sibling of ${original.policyId}.`,
        `Excluded tier-1 toxic symbols: ${toxicEval.tier1ToxicSymbols.join(", ")}.`,
        `n=${siblingMetrics.sampleSize}, netAvgR=${siblingMetrics.netAvgR?.toFixed(4) ?? "n/a"}, delta=${siblingDeltaVsBaseline?.toFixed(4) ?? "n/a"}.`,
      ],
      rankingScore: 0,
      evidenceConsensus: emptyConsensus(),
      operativeCollectionPriority: "OBSERVE_ONLY" as OperativeCollectionPriority,
      collectionPriorityReason: "EX_TOXIC sibling — retained for observation.",
      collectionPriorityScore: 0,
      collectionPriorityBlockers: [] as string[],
      // EX_TOXIC fields
      excludedSymbols: toxicEval.tier1ToxicSymbols,
      tier2ToxicWatchlistSymbols: toxicEval.tier2ToxicWatchlistSymbols,
      toxicSymbolExclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
    };

    if (siblingMetrics.sampleSize < 10) siblingBase.blockers.push("Sample is below 10 closes.");
    if ((siblingMetrics.netAvgR ?? Number.NEGATIVE_INFINITY) < 0) siblingBase.blockers.push("Net economics are not positive yet.");
    if ((siblingMetrics.profitFactor ?? Number.NEGATIVE_INFINITY) < 1) siblingBase.blockers.push("Profit factor is below 1.0.");
    siblingBase.rankingScore = rankingScore(siblingBase);

    // Re-run consensus on the filtered records
    const siblingConsensus = buildEvidenceConsensusAssessment({
      candidate: siblingBase as AdaptiveProfitPolicyCandidate,
      candidateRecords: filteredLaneRecords,
      symbolRouteSuitability,
      universeRotation,
      technicalStopTpCredibility,
    });
    siblingBase.evidenceConsensus = siblingConsensus;
    siblingBase.rankingScore = round4(siblingBase.rankingScore + consensusAdjustment({ ...siblingBase, evidenceConsensus: siblingConsensus } as AdaptiveProfitPolicyCandidate));
    siblingBase.whyThisPolicyRanksHere.push(
      `Consensus=${siblingConsensus.evidenceConsensusVerdict} (score=${siblingConsensus.evidenceConsensusScore}).`,
    );

    const distortedRatioForSibling = null; // CORE candidates always null distorted ratio
    const siblingMicroPilot = microPilotReadinessFor(siblingBase as AdaptiveProfitPolicyCandidate, distortedRatioForSibling);
    const siblingRealisticMetrics = computeRealisticBasisMetrics(filteredLaneRecords, siblingMetrics.netAvgR);

    return {
      ...siblingBase,
      collectionPriority: "OBSERVE_ONLY",
      microPilotReadiness: siblingMicroPilot,
      netAvgRRealisticBasis: siblingRealisticMetrics.netAvgRRealisticBasis,
      profitFactorRealisticBasis: siblingRealisticMetrics.profitFactorRealisticBasis,
      costDragRealisticBasis: siblingRealisticMetrics.costDragRealisticBasis,
      avgCostRRealisticBasis: siblingRealisticMetrics.avgCostRRealisticBasis,
      realisticBasisCoverage: siblingRealisticMetrics.realisticBasisCoverage,
    } as AdaptiveProfitPolicyCandidate;
  }

  // Generate EX_TOXIC siblings for all CORE ALL_SYMBOLS candidates
  const exToxicSiblingMap = new Map<string, AdaptiveProfitPolicyCandidate>();
  // Process best* candidates first (they may be per-symbol, in which case buildExToxicSibling returns null)
  for (const c of [bestOverallPolicy, bestShortPolicy, bestLongPolicy]) {
    if (c && !exToxicSiblingMap.has(c.policyId)) {
      const sibling = buildExToxicSibling(c);
      if (sibling) {
        exToxicSiblingMap.set(c.policyId, sibling);
      }
    }
  }
  // Also process ALL CORE ALL_SYMBOLS candidates regardless of rank
  for (const c of candidates) {
    if (c.sourceType === "CORE" && c.symbolScope === "ALL_SYMBOLS" && !exToxicSiblingMap.has(c.policyId)) {
      const sibling = buildExToxicSibling(c);
      if (sibling) {
        exToxicSiblingMap.set(c.policyId, sibling);
      }
    }
  }

  for (const sibling of exToxicSiblingMap.values()) {
    candidates.push(sibling);
  }

  // Helper: find the best EX_TOXIC sibling for a given direction from the sibling map.
  // When best* policy is per-symbol (not ALL_SYMBOLS), find the EX_TOXIC sibling for the
  // best ALL_SYMBOLS candidate of the same direction instead.
  function bestExToxicForPolicy(
    bestPolicy: AdaptiveProfitPolicyCandidate | null,
    direction: AdaptiveProfitPolicyDirection,
  ): AdaptiveProfitPolicyCandidate | null {
    if (!bestPolicy) return null;
    // Direct match: best policy itself has a sibling
    const direct = exToxicSiblingMap.get(bestPolicy.policyId);
    if (direct) return direct;
    // Fallback: find the best ALL_SYMBOLS sibling for the same direction
    for (const [, sibling] of exToxicSiblingMap) {
      if (sibling.direction === direction) return sibling;
    }
    return null;
  }

  const bestOverallPolicyExToxic = bestExToxicForPolicy(bestOverallPolicy, bestOverallPolicy?.direction ?? "SHORT");
  const bestShortPolicyExToxic = bestExToxicForPolicy(bestShortPolicy, "SHORT");
  const bestLongPolicyExToxic = bestExToxicForPolicy(bestLongPolicy, "LONG");

  // ── Refined promotion evaluation ─────────────────────────────────────────
  // Evaluate each direction pair. If promotion qualifies, swap best* to the
  // sibling and preserve the original parent. rankedTopPolicies is adjusted so
  // a promoted sibling always ranks above its parent for the same family.
  const shortPolicyPromotionResult =
    bestShortPolicy && bestShortPolicyExToxic
      ? evaluateRefinedPromotion(bestShortPolicy, bestShortPolicyExToxic)
      : undefined;
  const longPolicyPromotionResult =
    bestLongPolicy && bestLongPolicyExToxic
      ? evaluateRefinedPromotion(bestLongPolicy, bestLongPolicyExToxic)
      : undefined;
  const overallPolicyPromotionResult =
    bestOverallPolicy && bestOverallPolicyExToxic
      ? evaluateRefinedPromotion(bestOverallPolicy, bestOverallPolicyExToxic)
      : undefined;

  // Apply SHORT promotion
  let effectiveBestShortPolicy = bestShortPolicy;
  let bestShortPolicyParent: AdaptiveProfitPolicyCandidate | null | undefined = undefined;
  if (shortPolicyPromotionResult?.refinedPromotionEligible && bestShortPolicyExToxic) {
    bestShortPolicyParent = bestShortPolicy;
    effectiveBestShortPolicy = bestShortPolicyExToxic;
  }

  // Apply LONG promotion
  let effectiveBestLongPolicy = bestLongPolicy;
  let bestLongPolicyParent: AdaptiveProfitPolicyCandidate | null | undefined = undefined;
  if (longPolicyPromotionResult?.refinedPromotionEligible && bestLongPolicyExToxic) {
    bestLongPolicyParent = bestLongPolicy;
    effectiveBestLongPolicy = bestLongPolicyExToxic;
  }

  // Apply OVERALL promotion
  let effectiveBestOverallPolicy = bestOverallPolicy;
  let bestOverallPolicyParent: AdaptiveProfitPolicyCandidate | null | undefined = undefined;
  if (overallPolicyPromotionResult?.refinedPromotionEligible && bestOverallPolicyExToxic) {
    bestOverallPolicyParent = bestOverallPolicy;
    effectiveBestOverallPolicy = bestOverallPolicyExToxic;
  }

  // Build rankedTopPolicies: start from the sorted candidates list (which includes
  // EX_TOXIC siblings), then ensure any promoted sibling outranks its ALL_SYMBOLS
  // parent within the top slice. Strategy: sort the top candidates with a custom
  // comparator that places promoted siblings ahead of their parents.
  const promotedSiblingIds = new Set<string>();
  const displacedParentIds = new Set<string>();
  for (const [promotion, parent, sibling] of [
    [shortPolicyPromotionResult, bestShortPolicyParent, bestShortPolicyExToxic],
    [longPolicyPromotionResult, bestLongPolicyParent, bestLongPolicyExToxic],
    [overallPolicyPromotionResult, bestOverallPolicyParent, bestOverallPolicyExToxic],
  ] as Array<[RefinedPromotionResult | undefined, AdaptiveProfitPolicyCandidate | null | undefined, AdaptiveProfitPolicyCandidate | null]>) {
    if (promotion?.refinedPromotionEligible && sibling && parent) {
      promotedSiblingIds.add(sibling.policyId);
      displacedParentIds.add(parent.policyId);
    }
  }

  // Re-sort candidates for top-policies slice: promoted siblings sort before their
  // displaced parents; all other ordering is preserved via compareCandidates.
  const promotionAwareSortedCandidates = [...candidates].sort((a, b) => {
    const aPromoted = promotedSiblingIds.has(a.policyId);
    const bPromoted = promotedSiblingIds.has(b.policyId);
    const aDisplaced = displacedParentIds.has(a.policyId);
    const bDisplaced = displacedParentIds.has(b.policyId);
    if (aPromoted && !bPromoted) return -1;
    if (!aPromoted && bPromoted) return 1;
    if (aDisplaced && !bDisplaced) return 1;
    if (!aDisplaced && bDisplaced) return -1;
    return compareCandidates(a, b);
  });
  const rankedTopPolicies = promotionAwareSortedCandidates.slice(0, 3);

  const shortReadiness = laneReadiness(effectiveBestShortPolicy);
  const longReadiness = laneReadiness(effectiveBestLongPolicy);
  const currentAdaptiveDirectionBias: AdaptiveDirectionBias =
    shortReadiness === "PROMOTABLE" && longReadiness === "PROMOTABLE"
      ? "SPLIT_BY_REGIME"
      : shortReadiness === "PROMOTABLE"
        ? "SHORT_BIAS"
        : longReadiness === "PROMOTABLE"
          ? "LONG_BIAS"
          : effectiveBestShortPolicy && effectiveBestLongPolicy &&
              effectiveBestShortPolicy.policyVerdict === "WATCHABLE" &&
              effectiveBestLongPolicy.policyVerdict === "WATCHABLE" &&
              effectiveBestShortPolicy.dominantRegime !== effectiveBestLongPolicy.dominantRegime
            ? Math.abs(effectiveBestShortPolicy.rankingScore - effectiveBestLongPolicy.rankingScore) <= 10
              ? "SPLIT_BY_REGIME"
              : effectiveBestShortPolicy.rankingScore > effectiveBestLongPolicy.rankingScore
                ? "SHORT_BIAS"
                : "LONG_BIAS"
            : effectiveBestShortPolicy && effectiveBestShortPolicy.policyVerdict === "WATCHABLE" &&
                (!effectiveBestLongPolicy || effectiveBestLongPolicy.policyVerdict !== "WATCHABLE")
              ? "SHORT_BIAS"
              : effectiveBestLongPolicy && effectiveBestLongPolicy.policyVerdict === "WATCHABLE" &&
                  (!effectiveBestShortPolicy || effectiveBestShortPolicy.policyVerdict !== "WATCHABLE")
                ? "LONG_BIAS"
                : "NO_EDGE_YET";
  const priorities = assignPriorities(candidates, effectiveBestOverallPolicy, effectiveBestLongPolicy);
  const operativeCollectionPlan = assignOperativeCollectionPlan(candidates);
  return {
    generatedAt: now.toISOString(),
    evidenceEra,
    baseline: {
      sampleSize: baseline.sampleSize,
      netAvgR: baseline.netAvgR,
      grossAvgR: baseline.grossAvgR,
      profitFactor: baseline.profitFactor,
    },
    candidates,
    rankedTopPolicies,
    bestOverallPolicy: effectiveBestOverallPolicy,
    bestShortPolicy: effectiveBestShortPolicy,
    bestLongPolicy: effectiveBestLongPolicy,
    ...(bestShortPolicyParent !== undefined ? { bestShortPolicyParent } : {}),
    ...(bestLongPolicyParent !== undefined ? { bestLongPolicyParent } : {}),
    ...(bestOverallPolicyParent !== undefined ? { bestOverallPolicyParent } : {}),
    bestOverallPolicyExToxic,
    bestShortPolicyExToxic,
    bestLongPolicyExToxic,
    ...(shortPolicyPromotionResult !== undefined ? { shortPolicyPromotionResult } : {}),
    ...(longPolicyPromotionResult !== undefined ? { longPolicyPromotionResult } : {}),
    ...(overallPolicyPromotionResult !== undefined ? { overallPolicyPromotionResult } : {}),
    currentAdaptiveDirectionBias,
    directionalReadiness: {
      shortLaneReadiness: shortReadiness,
      longLaneReadiness: longReadiness,
    },
    missingEvidenceForLongLane: missingEvidence("LONG", effectiveBestLongPolicy),
    missingEvidenceForShortLane: missingEvidence("SHORT", effectiveBestShortPolicy),
    exploitShadowPriorities: {
      ...priorities,
      antiBiasSafeguard: "Long-side evidence must remain observable even when the current primary lane is short; Phase 2F labels priorities but does not starve contrarian collection.",
    },
    operativeCollectionPlan,
    notes: [
      "Phase 2F is shadow-only and advisory. It does not enable live trading or alter active route selection.",
      "CORE and EXTERNAL_OVERLAY evidence remain separate; legacy contaminated external V1 tape is excluded upstream by V2 validity filtering.",
      "Direction posture is evidence-led, not hardcoded. LONG can become dominant when LONG evidence outranks SHORT evidence.",
    ],
  };
}

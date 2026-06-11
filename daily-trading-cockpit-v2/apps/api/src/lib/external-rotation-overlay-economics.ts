import type { ExternalDiscoveryEvidenceEra } from "./external-candidate-discovery-intelligence.js";
import {
  classifyExternalRotationOverlayValidity,
  type ExternalRotationOverlayGroup,
  type ExternalRotationOverlayObservation,
} from "./external-rotation-overlay.js";

/**
 * EXTERNAL ROTATION OVERLAY ECONOMICS AUDIT (Phase 2E.3 diagnostics extension)
 *
 * Read-only advisory audit that separates two distinct failure modes visible in
 * overlay performance data:
 *   A. Directional/gross weakness — external candidates move against the trade on a
 *      price-level basis, irrespective of costs.
 *   B. Cost-to-risk geometry collapse — stopDistanceBps is so tight that even a
 *      normal round-trip fee/slippage translates to many R, destroying net outcome
 *      even when gross R is near flat.
 *
 * Does NOT change:
 *   - overlay selection, overlay resolver, overlay outcome semantics
 *   - active scanner universe, routing, adaptive gates, live readiness
 *   - any live trading behavior
 *
 * Cost decomposition limitation:
 *   costR on each observation is a single aggregate (fee + slippage combined).
 *   No per-component breakdown exists. All cost analysis uses gross-to-net drag.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type EconomicsGroupVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "COST_TO_RISK_GEOMETRY_BROKEN"
  | "GROSS_EDGE_ABSENT"
  | "BOTH_GROSS_AND_COST_LEAK"
  | "MIXED_EARLY";

export type EconomicsPrimaryDiagnosis =
  | "COST_DOMINATED_EXTERNAL_OVERLAY"
  | "DIRECTIONALLY_WEAK_EXTERNAL_OVERLAY"
  | "COST_AND_DIRECTION_BOTH_BAD"
  | "TOO_EARLY";

export type EconomicsHypothesisAction =
  | "AUDIT_EXTERNAL_STOP_GEOMETRY"
  | "AUDIT_COST_MODEL_IN_R_SPACE"
  | "AUDIT_RESOLVER_PLAN_ASSUMPTIONS"
  | "WAIT_FOR_MORE_OVERLAY_DATA"
  | "AUDIT_EXTERNAL_OVERLAY_ECONOMICS_CREDIBILITY"
  | "WAIT_FOR_INTERPRETABLE_SAMPLES"
  | "AUDIT_FUTURE_RESOLVER_GEOMETRY_GUARD"
  | "NO_ACTION_YET";

export interface ExternalRotationOverlayEconomicsGroupAssessment {
  group: ExternalRotationOverlayGroup;
  observationCount: number;
  resolvedCount: number;
  headlineInterpretiveSampleSize: number;
  forensicResolvedSampleSize: number;
  distortedExcludedFromHeadline: number;
  borderlineExcludedFromHeadline: number;
  grossAvgR: number | null;
  netAvgR: number | null;
  avgCostDragR: number | null;
  avgCostR: number | null;
  avgStopDistanceBps: number | null;
  medianStopDistanceBps: number | null;
  avgRiskReward: number | null;
  pctUltraTightStopLt100Bps: number | null;
  pctTightStopLt175Bps: number | null;
  pctNetLossMoreThan2R: number | null;
  pctNetLossMoreThan4R: number | null;
  pctGrossNearFlatButNetDeeplyNegative: number | null;
  avgObservationDurationMinutes: number | null;
  costDecompositionNote: string;
  economicsVerdict: EconomicsGroupVerdict;
  reasons: string[];
}

export interface ExternalRotationOverlayEconomicsGlobalDiagnosis {
  primaryDiagnosis: EconomicsPrimaryDiagnosis;
  explanation: string;
  strongestEvidence: string[];
  cautionNotes: string[];
}

export interface ExternalRotationOverlayEconomicsHypothesis {
  title: string;
  evidenceSummary: string;
  likelyFutureAction: EconomicsHypothesisAction;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  patchStatus: "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";
  doesNotImplementNow: true;
}

export interface ExternalRotationOverlayEconomicsReadiness {
  advisoryEngineReady: boolean;
  readyForResolverBehaviorDiscussion: false;
  readyForUniverseRotationInterpretation: false;
  reasons: string[];
}

// ─── Credibility layer types ──────────────────────────────────────────────────

export type EconomicsCredibilityStatus =
  | "ECONOMICALLY_INTERPRETABLE"
  | "ECONOMICALLY_DISTORTED"
  | "BORDERLINE"
  | "INSUFFICIENT_DATA";

export type StopGeometryBucket =
  | "ULTRA_TIGHT_LT100_BPS"
  | "TIGHT_LT175_BPS"
  | "NORMAL_GTE175_BPS"
  | "UNKNOWN";

export type NetEconomicsInterpretation =
  | "NET_READABLE"
  | "NET_DISTORTED_BY_COST"
  | "NET_BORDERLINE"
  | "NOT_APPLICABLE";

export type DirectionalInterpretation =
  | "GROSS_READABLE"
  | "GROSS_BORDERLINE"
  | "NOT_APPLICABLE";

export type CredibilityGroupVerdict =
  | "ALL_INTERPRETABLE"
  | "MAJORITY_DISTORTED"
  | "MAJORITY_BORDERLINE"
  | "MIXED"
  | "INSUFFICIENT_DATA";

export type NetRotationComparisonStatus =
  | "NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION"
  | "BORDERLINE_INTERPRET_WITH_CAUTION"
  | "NET_INTERPRETABLE"
  | "TOO_EARLY";

export type GrossDirectionalComparisonStatus =
  | "GROSS_ONLY_MAY_BE_READ_WITH_CAUTION"
  | "GROSS_LARGELY_UNCONTAMINATED"
  | "TOO_EARLY";

export interface ExternalOverlayEconomicsCredibility {
  credibilityStatus: EconomicsCredibilityStatus;
  stopGeometryBucket: StopGeometryBucket;
  netEconomicsInterpretation: NetEconomicsInterpretation;
  directionalInterpretation: DirectionalInterpretation;
  distortionFlags: string[];
}

export interface EconomicsCredibilityGroupSummary {
  group: ExternalRotationOverlayGroup;
  credibilityVerdict: CredibilityGroupVerdict;
  interpretableCount: number;
  distortedCount: number;
  borderlineCount: number;
  insufficientDataCount: number;
  pctDistorted: number | null;
  pctInterpretable: number | null;
  avgStopDistanceBpsAmongDistorted: number | null;
  dominantDistortionFlag: string | null;
}

export interface ExternalOverlayInterpretability {
  netRotationComparisonStatus: NetRotationComparisonStatus;
  grossDirectionalComparisonStatus: GrossDirectionalComparisonStatus;
  interpretableCount: number;
  distortedCount: number;
  borderlineCount: number;
  insufficientDataCount: number;
  totalClassified: number;
  warningMessage: string | null;
}

export interface ExternalRotationOverlayEconomicsValidityCounts {
  rawObservationCount: number;
  validObservationCount: number;
  legacyInvalidExcludedCount: number;
}

export interface ExternalRotationOverlayEconomicsReport {
  generatedAt: string;
  evidenceEra: ExternalDiscoveryEvidenceEra;
  /** Operative count — equals validObservationCount. Legacy V1 observations are excluded. */
  totalObservations: number;
  resolvedObservations: number;
  headlineInterpretiveSampleSize: number;
  forensicDistortedSampleSize: number;
  forensicBorderlineSampleSize: number;
  validityCounts: ExternalRotationOverlayEconomicsValidityCounts;
  costComponentsAvailable: false;
  costDecompositionNote: string;
  groups: ExternalRotationOverlayEconomicsGroupAssessment[];
  geometryFindings: string[];
  economicsDiagnosis: ExternalRotationOverlayEconomicsGlobalDiagnosis;
  hypotheses: ExternalRotationOverlayEconomicsHypothesis[];
  readiness: ExternalRotationOverlayEconomicsReadiness;
  credibilityGroups: EconomicsCredibilityGroupSummary[];
  externalOverlayInterpretability: ExternalOverlayInterpretability;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COST_DECOMP_NOTE =
  "Exact cost component decomposition unavailable; audit uses aggregate gross-to-net drag.";

// Thresholds for economics verdict classification
const COST_DRAG_DOMINATED_THRESHOLD = 2.0; // cost drag >= 2R while gross is near flat
const GROSS_NEAR_FLAT_THRESHOLD = -0.5;    // grossAvgR >= this = "near flat"
const SECONDARY_COST_THRESHOLD = 1.0;      // cost drag >= 1R is material even if gross also bad
const ULTRA_TIGHT_STOP_BPS = 100;
const TIGHT_STOP_BPS = 175;
const MIN_RESOLVED_FOR_GLOBAL_DIAGNOSIS = 5;
const MIN_RESOLVED_FOR_GROUP_VERDICT = 3;

// Thresholds for per-observation credibility classification
const CREDIBILITY_GROSS_FLAT_THRESHOLD = 0.25;  // |grossR| <= this = "near flat" for credibility
const CREDIBILITY_NET_DEEP_THRESHOLD = -2.0;    // netR <= this = "deeply negative" for credibility

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return roundMetric(finite.reduce((sum, v) => sum + v, 0) / finite.length);
}

function medianOf(values: Array<number | null | undefined>): number | null {
  const finite = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return roundMetric(
    finite.length % 2 === 0
      ? (finite[mid - 1]! + finite[mid]!) / 2
      : finite[mid]!,
  );
}

function pctOf(count: number, total: number): number | null {
  if (total === 0) return null;
  return roundMetric(count / total);
}

// ─── Credibility Classifier ───────────────────────────────────────────────────

export function classifyExternalOverlayEconomicsCredibility(
  obs: ExternalRotationOverlayObservation,
): ExternalOverlayEconomicsCredibility {
  const isResolved =
    obs.outcome?.fillStatus === "FILLED" &&
    obs.outcome.realizedNetR !== null &&
    obs.outcome.realizedGrossR !== null;

  if (!isResolved) {
    return {
      credibilityStatus: "INSUFFICIENT_DATA",
      stopGeometryBucket: "UNKNOWN",
      netEconomicsInterpretation: "NOT_APPLICABLE",
      directionalInterpretation: "NOT_APPLICABLE",
      distortionFlags: [],
    };
  }

  const grossR = obs.outcome!.realizedGrossR!;
  const netR = obs.outcome!.realizedNetR!;
  const costDrag = grossR - netR;
  const stopBps = obs.detachedCandidateSnapshot.stopDistanceBps;

  let stopGeometryBucket: StopGeometryBucket;
  if (stopBps === null) {
    stopGeometryBucket = "UNKNOWN";
  } else if (stopBps < ULTRA_TIGHT_STOP_BPS) {
    stopGeometryBucket = "ULTRA_TIGHT_LT100_BPS";
  } else if (stopBps < TIGHT_STOP_BPS) {
    stopGeometryBucket = "TIGHT_LT175_BPS";
  } else {
    stopGeometryBucket = "NORMAL_GTE175_BPS";
  }

  const distortionFlags: string[] = [];

  if (stopBps !== null && stopBps < ULTRA_TIGHT_STOP_BPS) {
    distortionFlags.push(`stop=${stopBps}bps < ${ULTRA_TIGHT_STOP_BPS}bps ultra-tight`);
  }
  if (costDrag >= COST_DRAG_DOMINATED_THRESHOLD) {
    distortionFlags.push(`cost drag=${costDrag.toFixed(4)}R >= ${COST_DRAG_DOMINATED_THRESHOLD}R`);
  }
  if (Math.abs(grossR) <= CREDIBILITY_GROSS_FLAT_THRESHOLD && netR <= CREDIBILITY_NET_DEEP_THRESHOLD) {
    distortionFlags.push(`gross near flat (|${grossR.toFixed(4)}| <= ${CREDIBILITY_GROSS_FLAT_THRESHOLD}) but net deeply negative (${netR.toFixed(4)} <= ${CREDIBILITY_NET_DEEP_THRESHOLD})`);
  }

  if (distortionFlags.length > 0) {
    return {
      credibilityStatus: "ECONOMICALLY_DISTORTED",
      stopGeometryBucket,
      netEconomicsInterpretation: "NET_DISTORTED_BY_COST",
      directionalInterpretation: stopGeometryBucket !== "ULTRA_TIGHT_LT100_BPS" ? "GROSS_READABLE" : "GROSS_BORDERLINE",
      distortionFlags,
    };
  }

  const isTightStop = stopBps !== null && stopBps >= ULTRA_TIGHT_STOP_BPS && stopBps < TIGHT_STOP_BPS;
  const isModerateCostDrag = costDrag >= SECONDARY_COST_THRESHOLD && costDrag < COST_DRAG_DOMINATED_THRESHOLD;

  if (isTightStop || isModerateCostDrag) {
    return {
      credibilityStatus: "BORDERLINE",
      stopGeometryBucket,
      netEconomicsInterpretation: "NET_BORDERLINE",
      directionalInterpretation: "GROSS_BORDERLINE",
      distortionFlags: [],
    };
  }

  return {
    credibilityStatus: "ECONOMICALLY_INTERPRETABLE",
    stopGeometryBucket,
    netEconomicsInterpretation: "NET_READABLE",
    directionalInterpretation: "GROSS_READABLE",
    distortionFlags: [],
  };
}

// ─── Credibility Group Summary ────────────────────────────────────────────────

function buildCredibilityGroupSummary(
  group: ExternalRotationOverlayGroup,
  groupObs: ExternalRotationOverlayObservation[],
): EconomicsCredibilityGroupSummary {
  const classified = groupObs.map((obs) => ({
    obs,
    credibility: classifyExternalOverlayEconomicsCredibility(obs),
  }));

  const interpretableCount = classified.filter((c) => c.credibility.credibilityStatus === "ECONOMICALLY_INTERPRETABLE").length;
  const distortedCount = classified.filter((c) => c.credibility.credibilityStatus === "ECONOMICALLY_DISTORTED").length;
  const borderlineCount = classified.filter((c) => c.credibility.credibilityStatus === "BORDERLINE").length;
  const insufficientDataCount = classified.filter((c) => c.credibility.credibilityStatus === "INSUFFICIENT_DATA").length;
  const resolvedCount = interpretableCount + distortedCount + borderlineCount;

  const pctDistorted = resolvedCount > 0 ? roundMetric(distortedCount / resolvedCount) : null;
  const pctInterpretable = resolvedCount > 0 ? roundMetric(interpretableCount / resolvedCount) : null;

  let credibilityVerdict: CredibilityGroupVerdict;
  if (resolvedCount < MIN_RESOLVED_FOR_GROUP_VERDICT) {
    credibilityVerdict = "INSUFFICIENT_DATA";
  } else if (pctDistorted !== null && pctDistorted >= 0.7) {
    credibilityVerdict = "MAJORITY_DISTORTED";
  } else if (pctInterpretable !== null && pctInterpretable >= 0.7) {
    credibilityVerdict = "ALL_INTERPRETABLE";
  } else if (resolvedCount > 0 && borderlineCount / resolvedCount >= 0.5) {
    credibilityVerdict = "MAJORITY_BORDERLINE";
  } else {
    credibilityVerdict = "MIXED";
  }

  const distortedItems = classified.filter((c) => c.credibility.credibilityStatus === "ECONOMICALLY_DISTORTED");
  const stopsAmongDistorted = distortedItems
    .map((c) => c.obs.detachedCandidateSnapshot.stopDistanceBps)
    .filter((s): s is number => s !== null && Number.isFinite(s));
  const avgStopDistanceBpsAmongDistorted =
    stopsAmongDistorted.length > 0
      ? roundMetric(stopsAmongDistorted.reduce((sum, v) => sum + v, 0) / stopsAmongDistorted.length, 1)
      : null;

  let ultraTightCount = 0;
  let highCostDragCount = 0;
  let grossFlatNetDeepCount = 0;
  for (const { credibility } of distortedItems) {
    for (const flag of credibility.distortionFlags) {
      if (flag.includes("ultra-tight")) ultraTightCount++;
      else if (flag.includes("cost drag")) highCostDragCount++;
      else if (flag.includes("gross near flat")) grossFlatNetDeepCount++;
    }
  }
  const maxFlagCount = Math.max(ultraTightCount, highCostDragCount, grossFlatNetDeepCount);
  let dominantDistortionFlag: string | null = null;
  if (maxFlagCount > 0) {
    if (ultraTightCount === maxFlagCount) dominantDistortionFlag = "ULTRA_TIGHT_STOP";
    else if (highCostDragCount === maxFlagCount) dominantDistortionFlag = "HIGH_COST_DRAG";
    else dominantDistortionFlag = "GROSS_FLAT_NET_DEEP";
  }

  return {
    group,
    credibilityVerdict,
    interpretableCount,
    distortedCount,
    borderlineCount,
    insufficientDataCount,
    pctDistorted,
    pctInterpretable,
    avgStopDistanceBpsAmongDistorted,
    dominantDistortionFlag,
  };
}

// ─── Global Interpretability ──────────────────────────────────────────────────

export function buildGlobalInterpretability(
  observations: ExternalRotationOverlayObservation[],
): ExternalOverlayInterpretability {
  const classified = observations.map(classifyExternalOverlayEconomicsCredibility);
  const interpretableCount = classified.filter((c) => c.credibilityStatus === "ECONOMICALLY_INTERPRETABLE").length;
  const distortedCount = classified.filter((c) => c.credibilityStatus === "ECONOMICALLY_DISTORTED").length;
  const borderlineCount = classified.filter((c) => c.credibilityStatus === "BORDERLINE").length;
  const insufficientDataCount = classified.filter((c) => c.credibilityStatus === "INSUFFICIENT_DATA").length;
  const totalClassified = classified.length;
  const resolvedClassified = interpretableCount + distortedCount + borderlineCount;

  let netRotationComparisonStatus: NetRotationComparisonStatus;
  let grossDirectionalComparisonStatus: GrossDirectionalComparisonStatus;

  if (resolvedClassified < MIN_RESOLVED_FOR_GLOBAL_DIAGNOSIS) {
    netRotationComparisonStatus = "TOO_EARLY";
    grossDirectionalComparisonStatus = "TOO_EARLY";
  } else {
    const pctDistorted = distortedCount / resolvedClassified;
    const pctDistortedOrBorderline = (distortedCount + borderlineCount) / resolvedClassified;

    if (pctDistorted >= 0.5) {
      netRotationComparisonStatus = "NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION";
      grossDirectionalComparisonStatus = "GROSS_ONLY_MAY_BE_READ_WITH_CAUTION";
    } else if (pctDistortedOrBorderline >= 0.5) {
      netRotationComparisonStatus = "BORDERLINE_INTERPRET_WITH_CAUTION";
      grossDirectionalComparisonStatus = "GROSS_ONLY_MAY_BE_READ_WITH_CAUTION";
    } else {
      netRotationComparisonStatus = "NET_INTERPRETABLE";
      grossDirectionalComparisonStatus = "GROSS_LARGELY_UNCONTAMINATED";
    }
  }

  let warningMessage: string | null = null;
  if (netRotationComparisonStatus === "NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION") {
    warningMessage = `Net R in overlay groups is cost-distorted (${distortedCount}/${resolvedClassified} resolved observations ECONOMICALLY_DISTORTED). Do not read net R as a candidate-quality signal. Use gross R with caution only.`;
  } else if (netRotationComparisonStatus === "BORDERLINE_INTERPRET_WITH_CAUTION") {
    warningMessage = `${distortedCount + borderlineCount}/${resolvedClassified} resolved observations are distorted or borderline. Net R comparisons should be treated with caution.`;
  }

  return {
    netRotationComparisonStatus,
    grossDirectionalComparisonStatus,
    interpretableCount,
    distortedCount,
    borderlineCount,
    insufficientDataCount,
    totalClassified,
    warningMessage,
  };
}

// ─── Group Assessment ─────────────────────────────────────────────────────────

function buildGroupAssessment(
  group: ExternalRotationOverlayGroup,
  groupObs: ExternalRotationOverlayObservation[],
): ExternalRotationOverlayEconomicsGroupAssessment {
  const resolved = groupObs.filter(
    (obs) => obs.outcome?.fillStatus === "FILLED" && obs.outcome.realizedNetR !== null,
  );
  const classifiedResolved = resolved.map((obs) => ({
    obs,
    credibility: classifyExternalOverlayEconomicsCredibility(obs),
  }));
  const headlineResolved = classifiedResolved
    .filter((entry) => entry.credibility.credibilityStatus === "ECONOMICALLY_INTERPRETABLE")
    .map((entry) => entry.obs);
  const resolvedCount = headlineResolved.length;
  const forensicResolvedSampleSize = resolved.length;
  const distortedExcludedFromHeadline = classifiedResolved.filter((entry) => entry.credibility.credibilityStatus === "ECONOMICALLY_DISTORTED").length;
  const borderlineExcludedFromHeadline = classifiedResolved.filter((entry) => entry.credibility.credibilityStatus === "BORDERLINE").length;

  const grossAvgR = average(headlineResolved.map((obs) => obs.outcome!.realizedGrossR));
  const netAvgR = average(headlineResolved.map((obs) => obs.outcome!.realizedNetR));

  // Derive cost drag from averages (equals avg(costR) by linearity of expectation)
  const avgCostDragR =
    grossAvgR !== null && netAvgR !== null
      ? roundMetric(grossAvgR - netAvgR)
      : null;

  // avg(costR) from snapshots — independent cross-check (should match avgCostDragR)
  const avgCostR = average(headlineResolved.map((obs) => obs.detachedCandidateSnapshot.costR));

  // Stop geometry
  const avgStopDistanceBps = average(
    resolved.map((obs) => obs.detachedCandidateSnapshot.stopDistanceBps),
  );
  const medianStopDistanceBps = medianOf(
    resolved.map((obs) => obs.detachedCandidateSnapshot.stopDistanceBps),
  );
  const avgRiskReward = average(
    headlineResolved.map((obs) => obs.detachedCandidateSnapshot.riskReward),
  );

  // Stop tightness percentages (among resolved only — need outcome to correlate)
  const pctUltraTightStopLt100Bps = forensicResolvedSampleSize > 0
    ? pctOf(
        resolved.filter((obs) => {
          const s = obs.detachedCandidateSnapshot.stopDistanceBps;
          return s !== null && s < ULTRA_TIGHT_STOP_BPS;
        }).length,
        forensicResolvedSampleSize,
      )
    : null;

  const pctTightStopLt175Bps = forensicResolvedSampleSize > 0
    ? pctOf(
        resolved.filter((obs) => {
          const s = obs.detachedCandidateSnapshot.stopDistanceBps;
          return s !== null && s < TIGHT_STOP_BPS;
        }).length,
        forensicResolvedSampleSize,
      )
    : null;

  // Net loss severity
  const pctNetLossMoreThan2R = forensicResolvedSampleSize > 0
    ? pctOf(
        resolved.filter((obs) => (obs.outcome!.realizedNetR ?? 0) <= -2.0).length,
        forensicResolvedSampleSize,
      )
    : null;

  const pctNetLossMoreThan4R = forensicResolvedSampleSize > 0
    ? pctOf(
        resolved.filter((obs) => (obs.outcome!.realizedNetR ?? 0) <= -4.0).length,
        forensicResolvedSampleSize,
      )
    : null;

  // Cost-dominated signature: gross near flat but net deeply negative
  const pctGrossNearFlatButNetDeeplyNegative = forensicResolvedSampleSize > 0
    ? pctOf(
        resolved.filter((obs) => {
          const gross = obs.outcome!.realizedGrossR ?? 0;
          const net = obs.outcome!.realizedNetR ?? 0;
          return Math.abs(gross) <= 0.25 && net <= -2.0;
        }).length,
        forensicResolvedSampleSize,
      )
    : null;

  const avgObservationDurationMinutes = average(headlineResolved.map((obs) => obs.outcome!.durationMinutes));

  // Economics verdict
  const reasons: string[] = [];
  let economicsVerdict: EconomicsGroupVerdict;

  if (resolvedCount < MIN_RESOLVED_FOR_GROUP_VERDICT) {
    economicsVerdict = "INSUFFICIENT_EVIDENCE";
    reasons.push(
      `Only ${resolvedCount} ECONOMICALLY_INTERPRETABLE FILLED resolved observation(s) — too few for reliable headline economics assessment (need ≥${MIN_RESOLVED_FOR_GROUP_VERDICT}).`,
    );
  } else if (
    grossAvgR !== null &&
    grossAvgR >= GROSS_NEAR_FLAT_THRESHOLD &&
    avgCostDragR !== null &&
    avgCostDragR >= COST_DRAG_DOMINATED_THRESHOLD
  ) {
    economicsVerdict = "COST_TO_RISK_GEOMETRY_BROKEN";
    reasons.push(
      `Gross avg R ${grossAvgR.toFixed(4)} is near flat (≥ ${GROSS_NEAR_FLAT_THRESHOLD}) while avg cost drag is ${avgCostDragR.toFixed(4)}R — cost-to-risk geometry dominates losses.`,
    );
    if (avgStopDistanceBps !== null) {
      reasons.push(
        `Avg planned stop = ${avgStopDistanceBps.toFixed(1)} bps; at ultra-tight geometry, a normal round-trip fee/slippage of 10–50 bps equates to many R per trade.`,
      );
    }
  } else if (
    grossAvgR !== null &&
    grossAvgR < GROSS_NEAR_FLAT_THRESHOLD &&
    avgCostDragR !== null &&
    avgCostDragR >= SECONDARY_COST_THRESHOLD
  ) {
    economicsVerdict = "BOTH_GROSS_AND_COST_LEAK";
    reasons.push(
      `Both gross avg R (${grossAvgR.toFixed(4)}) and cost drag (${avgCostDragR.toFixed(4)}R) are materially negative — compounded weakness.`,
    );
  } else if (grossAvgR !== null && grossAvgR < GROSS_NEAR_FLAT_THRESHOLD) {
    economicsVerdict = "GROSS_EDGE_ABSENT";
    reasons.push(
      `Gross avg R (${grossAvgR.toFixed(4)}) shows clear directional weakness; cost drag (${avgCostDragR?.toFixed(4) ?? "n/a"}R) is secondary.`,
    );
  } else {
    economicsVerdict = "MIXED_EARLY";
    reasons.push(
      `Mixed or unclear economics pattern at current sample size (n=${resolvedCount}).`,
    );
  }
  if (distortedExcludedFromHeadline > 0 || borderlineExcludedFromHeadline > 0) {
    reasons.push(
      `Headline economics exclude ${distortedExcludedFromHeadline} distorted and ${borderlineExcludedFromHeadline} borderline resolved observation(s); they remain visible for forensic audit.`,
    );
  }

  return {
    group,
    observationCount: groupObs.length,
    resolvedCount,
    headlineInterpretiveSampleSize: resolvedCount,
    forensicResolvedSampleSize,
    distortedExcludedFromHeadline,
    borderlineExcludedFromHeadline,
    grossAvgR,
    netAvgR,
    avgCostDragR,
    avgCostR,
    avgStopDistanceBps,
    medianStopDistanceBps,
    avgRiskReward,
    pctUltraTightStopLt100Bps,
    pctTightStopLt175Bps,
    pctNetLossMoreThan2R,
    pctNetLossMoreThan4R,
    pctGrossNearFlatButNetDeeplyNegative,
    avgObservationDurationMinutes,
    costDecompositionNote: COST_DECOMP_NOTE,
    economicsVerdict,
    reasons,
  };
}

// ─── Global Diagnosis ─────────────────────────────────────────────────────────

function buildGlobalDiagnosis(
  groups: ExternalRotationOverlayEconomicsGroupAssessment[],
  totalResolved: number,
): ExternalRotationOverlayEconomicsGlobalDiagnosis {
  const evidenced = groups.filter(
    (g) => g.economicsVerdict !== "INSUFFICIENT_EVIDENCE",
  );

  if (totalResolved < MIN_RESOLVED_FOR_GLOBAL_DIAGNOSIS || evidenced.length === 0) {
    return {
      primaryDiagnosis: "TOO_EARLY",
      explanation: `Only ${totalResolved} FILLED resolved observations across all groups — cannot reliably classify the economics failure mode yet. Collect more resolved overlay data.`,
      strongestEvidence: [`Total FILLED resolved: ${totalResolved}`],
      cautionNotes: [
        "Wait for at least 10+ resolved FILLED observations before drawing economics conclusions.",
        COST_DECOMP_NOTE,
      ],
    };
  }

  const costDominated = evidenced.filter(
    (g) => g.economicsVerdict === "COST_TO_RISK_GEOMETRY_BROKEN",
  );
  const grossAbsent = evidenced.filter(
    (g) => g.economicsVerdict === "GROSS_EDGE_ABSENT",
  );
  const bothBad = evidenced.filter(
    (g) => g.economicsVerdict === "BOTH_GROSS_AND_COST_LEAK",
  );

  // Build strongest evidence bullets
  const strongestEvidence: string[] = [];
  for (const g of groups) {
    if (g.resolvedCount > 0 && g.grossAvgR !== null && g.netAvgR !== null && g.avgCostDragR !== null) {
      strongestEvidence.push(
        `${g.group}: gross=${g.grossAvgR.toFixed(4)}R | net=${g.netAvgR.toFixed(4)}R | implied cost drag=${g.avgCostDragR.toFixed(4)}R (n=${g.resolvedCount})`,
      );
    }
  }

  const cautionNotes = [
    "Sample remains small — economics failure mode may shift as more observations resolve.",
    COST_DECOMP_NOTE,
  ];

  let primaryDiagnosis: EconomicsPrimaryDiagnosis;
  let explanation: string;

  if (costDominated.length >= 1 && grossAbsent.length === 0 && bothBad.length === 0) {
    primaryDiagnosis = "COST_DOMINATED_EXTERNAL_OVERLAY";
    explanation =
      "Gross R across evidenced groups is near flat while net R is deeply negative — cost-to-risk geometry (not directional failure) dominates overlay losses. " +
      "Ultra-tight stop geometry amplifies fee/slippage cost into many R per trade. " +
      "This does NOT necessarily mean external candidates are directionally bad — it may mean the detached overlay geometry is economically untradeable at current stop widths.";
  } else if (bothBad.length >= 1 && costDominated.length === 0 && grossAbsent.length === 0) {
    primaryDiagnosis = "COST_AND_DIRECTION_BOTH_BAD";
    explanation =
      "Both gross directional performance and cost drag are materially negative across evidenced groups. Overlay shows compounded economic weakness — directional failure and cost geometry failure are both present.";
  } else if (grossAbsent.length >= 1 && costDominated.length === 0 && bothBad.length === 0) {
    primaryDiagnosis = "DIRECTIONALLY_WEAK_EXTERNAL_OVERLAY";
    explanation =
      "Gross R is clearly negative across evidenced groups — overlay candidates show directional weakness independent of cost effects. Cost drag is present but secondary to the directional failure.";
  } else if (costDominated.length >= 1 || bothBad.length >= 1) {
    // Mixed but cost is at least partly responsible
    primaryDiagnosis = "COST_DOMINATED_EXTERNAL_OVERLAY";
    explanation =
      "Cost-to-risk geometry breakdown is present in at least one evidenced group. Mixed pattern across groups; cost effects appear to be a primary contributor to deeply negative net R.";
  } else {
    primaryDiagnosis = "TOO_EARLY";
    explanation =
      "Economics pattern is not yet consistently classifiable across groups — mixed or early-stage signals only.";
    cautionNotes.push("Revisit after more groups reach ≥5 resolved FILLED observations.");
  }

  return { primaryDiagnosis, explanation, strongestEvidence, cautionNotes };
}

// ─── Geometry Findings ────────────────────────────────────────────────────────

function buildGeometryFindings(
  groups: ExternalRotationOverlayEconomicsGroupAssessment[],
): string[] {
  const findings: string[] = [];

  for (const g of groups) {
    if (g.resolvedCount < MIN_RESOLVED_FOR_GROUP_VERDICT) continue;

    if (g.pctUltraTightStopLt100Bps !== null && g.pctUltraTightStopLt100Bps >= 0.5) {
      const count = Math.round(g.pctUltraTightStopLt100Bps * g.resolvedCount);
      findings.push(
        `${g.group}: ${count}/${g.resolvedCount} resolved observations used stops <${ULTRA_TIGHT_STOP_BPS} bps — ultra-tight geometry amplifies cost in R terms.`,
      );
    }

    if (
      g.pctGrossNearFlatButNetDeeplyNegative !== null &&
      g.pctGrossNearFlatButNetDeeplyNegative >= 0.25
    ) {
      const count = Math.round(g.pctGrossNearFlatButNetDeeplyNegative * g.resolvedCount);
      findings.push(
        `${g.group}: ${count}/${g.resolvedCount} resolved observations had gross R near flat (|gross|≤0.25) but net R ≤ -2.0 — consistent with cost-to-risk geometry dominance.`,
      );
    }

    if (g.pctNetLossMoreThan4R !== null && g.pctNetLossMoreThan4R >= 0.5) {
      const count = Math.round(g.pctNetLossMoreThan4R * g.resolvedCount);
      findings.push(
        `${g.group}: ${count}/${g.resolvedCount} resolved observations had net R ≤ -4.0 — extremely deep losses relative to expected 1R risk unit.`,
      );
    }

    if (g.avgStopDistanceBps !== null) {
      findings.push(
        `${g.group}: avg planned stop = ${g.avgStopDistanceBps.toFixed(1)} bps${
          g.medianStopDistanceBps !== null ? ` | median = ${g.medianStopDistanceBps.toFixed(1)} bps` : ""
        }.`,
      );
    }
  }

  if (findings.length === 0) {
    findings.push(
      "No clear geometry pattern yet — insufficient resolved observations or stop distance data unavailable.",
    );
  }

  return findings;
}

// ─── Hypotheses ───────────────────────────────────────────────────────────────

function buildHypotheses(
  diagnosis: ExternalRotationOverlayEconomicsGlobalDiagnosis,
  totalResolved: number,
  interpretability: ExternalOverlayInterpretability,
): ExternalRotationOverlayEconomicsHypothesis[] {
  const hypotheses: ExternalRotationOverlayEconomicsHypothesis[] = [];
  const { primaryDiagnosis } = diagnosis;

  if (totalResolved < MIN_RESOLVED_FOR_GLOBAL_DIAGNOSIS) {
    hypotheses.push({
      title: "Collect more resolved overlay observations before economics audit",
      evidenceSummary: `Only ${totalResolved} FILLED resolved observations — economics patterns are not yet stable enough to classify.`,
      likelyFutureAction: "WAIT_FOR_MORE_OVERLAY_DATA",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
    return hypotheses;
  }

  if (
    primaryDiagnosis === "COST_DOMINATED_EXTERNAL_OVERLAY" ||
    primaryDiagnosis === "COST_AND_DIRECTION_BOTH_BAD"
  ) {
    hypotheses.push({
      title: "Audit external overlay stop geometry — ultra-tight stops may make overlay economically untradeable",
      evidenceSummary:
        "Gross R is near flat while net R is deeply negative across groups. Implied cost drag is high relative to the expected 1R risk unit. " +
        "Planned stop distances may be too tight for external detached observation geometry to absorb round-trip fees and slippage. " +
        "Consider whether widening the stop floor for external observations would produce more interpretable economics — as an advisory study only.",
      likelyFutureAction: "AUDIT_EXTERNAL_STOP_GEOMETRY",
      confidence: "MEDIUM",
      patchStatus: "AUDIT_DEEPER",
      doesNotImplementNow: true,
    });

    hypotheses.push({
      title: "Audit cost model in R space — verify costR computation for external overlay geometry",
      evidenceSummary:
        "costR is applied as a flat per-observation deduction at snapshot creation. " +
        "If stopDistanceBps is very small, a fixed fee/slippage amount translates to many R. " +
        "Verify whether the costR model accurately reflects real execution cost at current external stop geometry, " +
        "or whether the detached overlay should use a wider notional stop for economics comparability.",
      likelyFutureAction: "AUDIT_COST_MODEL_IN_R_SPACE",
      confidence: "LOW",
      patchStatus: "AUDIT_DEEPER",
      doesNotImplementNow: true,
    });
  }

  if (
    primaryDiagnosis === "DIRECTIONALLY_WEAK_EXTERNAL_OVERLAY" ||
    primaryDiagnosis === "COST_AND_DIRECTION_BOTH_BAD"
  ) {
    hypotheses.push({
      title: "Audit resolver plan assumptions — check if entry/exit geometry produces realistic gross R in detached mode",
      evidenceSummary:
        "Gross R is materially negative, suggesting directional weakness independent of cost. " +
        "Resolver assumptions (candle-based entry, TP1/TP2 proximity to stop, planned entry zone vs actual market moves) " +
        "may generate systematic gross drag in detached external mode. " +
        "This is an advisory study question, not an authorization to change resolver behavior.",
      likelyFutureAction: "AUDIT_RESOLVER_PLAN_ASSUMPTIONS",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  // Credibility-layer hypotheses
  const { netRotationComparisonStatus, distortedCount, interpretableCount } = interpretability;
  const resolvedClassified = distortedCount + interpretableCount + interpretability.borderlineCount;

  if (netRotationComparisonStatus === "NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION") {
    hypotheses.push({
      title: "Audit external overlay economics credibility — net R is cost-distorted; use gross R only",
      evidenceSummary: `${distortedCount} of ${resolvedClassified} resolved observations are ECONOMICALLY_DISTORTED. Net R comparison is not interpretable as candidate-quality signal at current stop geometry. Gross R may be readable as a directional signal with caution.`,
      likelyFutureAction: "AUDIT_EXTERNAL_OVERLAY_ECONOMICS_CREDIBILITY",
      confidence: "HIGH",
      patchStatus: "AUDIT_DEEPER",
      doesNotImplementNow: true,
    });
  }

  if (interpretableCount < MIN_RESOLVED_FOR_GROUP_VERDICT && resolvedClassified >= MIN_RESOLVED_FOR_GLOBAL_DIAGNOSIS) {
    hypotheses.push({
      title: "Wait for interpretable samples — current observations are economically distorted",
      evidenceSummary: `Only ${interpretableCount} ECONOMICALLY_INTERPRETABLE resolved observations available. Cannot draw meaningful performance comparisons until more interpretable (normal stop geometry, low cost drag) observations accumulate.`,
      likelyFutureAction: "WAIT_FOR_INTERPRETABLE_SAMPLES",
      confidence: "MEDIUM",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  if (
    netRotationComparisonStatus === "NOT_INTERPRETABLE_DUE_TO_COST_DISTORTION" &&
    (primaryDiagnosis === "COST_DOMINATED_EXTERNAL_OVERLAY" || primaryDiagnosis === "COST_AND_DIRECTION_BOTH_BAD")
  ) {
    hypotheses.push({
      title: "Audit future resolver geometry guard — consider stop-floor constraint for external overlay",
      evidenceSummary:
        "If external overlay is to produce interpretable economics data in the future, a stop-floor constraint (e.g., minimum 175 bps stop for external detached observations) should be considered in the resolver plan. " +
        "This is an advisory study note only — no resolver changes authorized.",
      likelyFutureAction: "AUDIT_FUTURE_RESOLVER_GEOMETRY_GUARD",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  if (hypotheses.length === 0) {
    hypotheses.push({
      title: "No economics action recommended at current evidence maturity",
      evidenceSummary: `Economics pattern is not yet consistently classifiable (total resolved: ${totalResolved}). Continue accumulating resolved overlay observations.`,
      likelyFutureAction: "NO_ACTION_YET",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  return hypotheses;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildExternalRotationOverlayEconomicsReport(
  observations: ExternalRotationOverlayObservation[],
  opts: {
    evidenceEra?: ExternalDiscoveryEvidenceEra;
  } = {},
  now: Date = new Date(),
): ExternalRotationOverlayEconomicsReport {
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const rawEraObservations =
    evidenceEra === "ALL_TIME"
      ? observations
      : observations.filter((obs) => obs.evidenceEra === "POST_CALIBRATION");
  // Exclude legacy V1 observations contaminated by the entry-anchor / fill-price
  // unit mismatch. Their costR was in anchor-risk R-units while gross R was in
  // currentPrice-risk R-units — net R is not meaningful.
  const eraObservations = rawEraObservations.filter(
    (obs) => classifyExternalRotationOverlayValidity(obs) === "VALID",
  );
  const legacyInvalidExcludedCount = rawEraObservations.length - eraObservations.length;
  const validityCounts: ExternalRotationOverlayEconomicsValidityCounts = {
    rawObservationCount: rawEraObservations.length,
    validObservationCount: eraObservations.length,
    legacyInvalidExcludedCount,
  };

  const resolvedObservations = eraObservations.filter(
    (obs) => obs.outcome?.fillStatus === "FILLED" && obs.outcome.realizedNetR !== null,
  ).length;

  const allGroups: ExternalRotationOverlayGroup[] = [
    "STRATEGY_FIT_SHORTLIST",
    "METADATA_DISCOVERY_BASELINE",
    "LOW_FIT_CONTROL",
  ];

  const groups = allGroups.map((group) =>
    buildGroupAssessment(
      group,
      eraObservations.filter((obs) => obs.overlayGroups.includes(group)),
    ),
  );

  const credibilityGroups = allGroups.map((group) =>
    buildCredibilityGroupSummary(
      group,
      eraObservations.filter((obs) => obs.overlayGroups.includes(group)),
    ),
  );

  const externalOverlayInterpretability = buildGlobalInterpretability(eraObservations);
  const headlineInterpretiveSampleSize = externalOverlayInterpretability.interpretableCount;
  const forensicDistortedSampleSize = externalOverlayInterpretability.distortedCount;
  const forensicBorderlineSampleSize = externalOverlayInterpretability.borderlineCount;

  const geometryFindings = buildGeometryFindings(groups);
  const economicsDiagnosis = buildGlobalDiagnosis(groups, headlineInterpretiveSampleSize);
  const hypotheses = buildHypotheses(economicsDiagnosis, resolvedObservations, externalOverlayInterpretability);

  const readinessReasons: string[] = [
    "External rotation overlay economics is read-only advisory diagnostics only.",
    "readyForResolverBehaviorDiscussion is always false — economics audit does not authorize resolver changes.",
    "readyForUniverseRotationInterpretation is always false — overlay economics does not determine universe rotation decisions.",
  ];
  if (legacyInvalidExcludedCount > 0) {
    readinessReasons.unshift(
      `Excluded ${legacyInvalidExcludedCount} legacy V1 observations (entry-anchor / fill-price unit mismatch) from economics interpretation; valid post-fix tape is being collected.`,
    );
  }
  if (resolvedObservations < 10) {
    readinessReasons.unshift(
      `Resolved sample too small (${resolvedObservations} FILLED) for stable economics classification — patterns may shift.`,
    );
  }

  return {
    generatedAt: now.toISOString(),
    evidenceEra,
    totalObservations: eraObservations.length,
    resolvedObservations,
    headlineInterpretiveSampleSize,
    forensicDistortedSampleSize,
    forensicBorderlineSampleSize,
    validityCounts,
    costComponentsAvailable: false,
    costDecompositionNote: COST_DECOMP_NOTE,
    groups,
    geometryFindings,
    economicsDiagnosis,
    hypotheses,
    readiness: {
      advisoryEngineReady: eraObservations.length > 0,
      readyForResolverBehaviorDiscussion: false,
      readyForUniverseRotationInterpretation: false,
      reasons: readinessReasons,
    },
    credibilityGroups,
    externalOverlayInterpretability,
  };
}

import type {
  AdaptiveRegimeGateOverlayAdvisoryDecision,
  AdaptiveRegimeGateOverlayAssessment,
  AdaptiveRegimeGateOverlayPolicyId,
  StrategyExperienceRecord,
} from "@dtc/shared";
import { ADAPTIVE_REGIME_GATE_OVERLAY_POLICY_VERSION } from "@dtc/shared";

export type AdaptiveOverlayPerformanceEra = "POST_CALIBRATION" | "ALL_TIME";
export type AdaptiveOverlayEarlyVerdict =
  | "NO_FORWARD_EVIDENCE_YET"
  | "TOO_EARLY"
  | "EARLY_SUPPORTIVE"
  | "EARLY_HARMFUL"
  | "WATCHABLE_SUPPORTIVE"
  | "WATCHABLE_HARMFUL"
  | "MIXED";

export interface AdaptiveOverlayMetricSummary {
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
}

export interface AdaptiveOverlayDeltaSummary {
  netAvgRDelta: number | null;
  profitFactorDelta: number | null;
  slRateDelta: number | null;
}

export interface AdaptiveRegimeGateOverlayPolicyPerformance {
  policyId: AdaptiveRegimeGateOverlayPolicyId;
  policyVersion: string;
  policyLabel: string;
  totalResolvedWithPolicy: number;
  includedCount: number;
  excludedCount: number;
  insufficientContextCount: number;
  includedMetrics: AdaptiveOverlayMetricSummary;
  excludedMetrics: AdaptiveOverlayMetricSummary;
  deltaIncludedVsAllOverlayRecords: AdaptiveOverlayDeltaSummary;
  deltaIncludedVsExcluded: AdaptiveOverlayDeltaSummary;
  earlyVerdict: AdaptiveOverlayEarlyVerdict;
  reasons: string[];
}

export interface AdaptiveRegimeGateOverlayPerformanceReport {
  generatedAt: string;
  evidenceEra: AdaptiveOverlayPerformanceEra;
  totalResolvedExperienceRecords: number;
  recordsWithPersistedOverlay: number;
  recordsWithoutPersistedOverlay: number;
  overlayForwardCoveragePct: number;
  policyPerformance: AdaptiveRegimeGateOverlayPolicyPerformance[];
  overallReadiness: {
    collectingForwardEvidence: true;
    readyForBehaviorInfluence: false;
    reasons: string[];
  };
}

export interface AdaptiveOverlayPerformanceInput {
  evidenceEra?: AdaptiveOverlayPerformanceEra;
}

const OVERLAY_POLICY_DEFINITIONS: Record<AdaptiveRegimeGateOverlayPolicyId, { label: string; version: typeof ADAPTIVE_REGIME_GATE_OVERLAY_POLICY_VERSION }> = {
  EXCLUDE_BULLISH_EXPANSION_V1: {
    label: "Exclude bullish expansion",
    version: ADAPTIVE_REGIME_GATE_OVERLAY_POLICY_VERSION,
  },
  KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1: {
    label: "Keep only bearish expansion and short",
    version: ADAPTIVE_REGIME_GATE_OVERLAY_POLICY_VERSION,
  },
  EXCLUDE_BULLISH_EXPANSION_LONG_V1: {
    label: "Exclude bullish expansion long",
    version: ADAPTIVE_REGIME_GATE_OVERLAY_POLICY_VERSION,
  },
};

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function avgFinite(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return round4(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function profitFactorOf(records: StrategyExperienceRecord[]): number | null {
  const wins = records.map((record) => record.outcome.realizedNetR).filter((value): value is number => typeof value === "number" && value > 0);
  const losses = records.map((record) => record.outcome.realizedNetR).filter((value): value is number => typeof value === "number" && value < 0);
  const winSum = wins.reduce((sum, value) => sum + value, 0);
  const lossAbs = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  if (lossAbs === 0) return null;
  return round4(winSum / lossAbs);
}

function winRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  return round4(records.filter((record) => (record.outcome.realizedNetR ?? 0) > 0).length / records.length);
}

function tp1ProfitableRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  return round4(records.filter((record) => record.outcome.tp1Hit === true && (record.outcome.realizedNetR ?? 0) > 0).length / records.length);
}

function slRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  return round4(records.filter((record) => record.outcome.slHit === true).length / records.length);
}

function filterByEra(records: StrategyExperienceRecord[], era: AdaptiveOverlayPerformanceEra): StrategyExperienceRecord[] {
  if (era === "ALL_TIME") return records;
  return records.filter((record) => (record.context.evidenceEra ?? record.outcome.evidenceEra) === "POST_CALIBRATION");
}

function metricsOf(records: StrategyExperienceRecord[]): AdaptiveOverlayMetricSummary {
  const winners = records.filter((record) => (record.outcome.realizedNetR ?? 0) > 0);
  const losers = records.filter((record) => (record.outcome.realizedNetR ?? 0) < 0);
  return {
    netAvgR: avgFinite(records.map((record) => record.outcome.realizedNetR)),
    grossAvgR: avgFinite(records.map((record) => record.outcome.realizedGrossR)),
    profitFactor: profitFactorOf(records),
    winRate: winRateOf(records),
    tp1ProfitableRate: tp1ProfitableRateOf(records),
    slRate: slRateOf(records),
    avgWinR: avgFinite(winners.map((record) => record.outcome.realizedNetR)),
    avgLossR: avgFinite(losers.map((record) => record.outcome.realizedNetR)),
  };
}

function deltaOf(left: AdaptiveOverlayMetricSummary, right: AdaptiveOverlayMetricSummary): AdaptiveOverlayDeltaSummary {
  return {
    netAvgRDelta: left.netAvgR !== null && right.netAvgR !== null ? round4(left.netAvgR - right.netAvgR) : null,
    profitFactorDelta: left.profitFactor !== null && right.profitFactor !== null ? round4(left.profitFactor - right.profitFactor) : null,
    slRateDelta: left.slRate !== null && right.slRate !== null ? round4(left.slRate - right.slRate) : null,
  };
}

function verdictOf(
  totalResolvedWithPolicy: number,
  includedCount: number,
  excludedCount: number,
  deltaIncludedVsExcluded: AdaptiveOverlayDeltaSummary,
): AdaptiveOverlayEarlyVerdict {
  if (totalResolvedWithPolicy < 10 || includedCount === 0 || excludedCount === 0) return totalResolvedWithPolicy === 0 ? "NO_FORWARD_EVIDENCE_YET" : "TOO_EARLY";
  const netDelta = deltaIncludedVsExcluded.netAvgRDelta ?? 0;
  const pfDelta = deltaIncludedVsExcluded.profitFactorDelta ?? 0;
  const slDelta = deltaIncludedVsExcluded.slRateDelta ?? 0;
  const supportive = netDelta >= 0.15 && pfDelta >= 0 && slDelta <= 0;
  const harmful = netDelta <= -0.15 && (pfDelta <= 0 || slDelta >= 0);
  if (totalResolvedWithPolicy >= 30) {
    if (supportive) return "WATCHABLE_SUPPORTIVE";
    if (harmful) return "WATCHABLE_HARMFUL";
    return "MIXED";
  }
  if (supportive) return "EARLY_SUPPORTIVE";
  if (harmful) return "EARLY_HARMFUL";
  return "MIXED";
}

function policyPerformanceOf(
  policyId: AdaptiveRegimeGateOverlayPolicyId,
  overlayRecords: StrategyExperienceRecord[],
  allOverlayMetrics: AdaptiveOverlayMetricSummary,
): AdaptiveRegimeGateOverlayPolicyPerformance {
  const withPolicy = overlayRecords
    .map((record) => ({
      record,
      assessment: (record.context.adaptiveRegimeGateOverlayAssessments ?? []).find((item) => item.policyId === policyId) ?? null,
    }))
    .filter((row): row is { record: StrategyExperienceRecord; assessment: AdaptiveRegimeGateOverlayAssessment } => row.assessment !== null);

  const included = withPolicy
    .filter((row) => row.assessment.advisoryDecision === "WOULD_INCLUDE")
    .map((row) => row.record);
  const excluded = withPolicy
    .filter((row) => row.assessment.advisoryDecision === "WOULD_EXCLUDE")
    .map((row) => row.record);
  const insufficientContextCount = withPolicy.filter((row) =>
    row.assessment.advisoryDecision === "INSUFFICIENT_CONTEXT" || row.assessment.advisoryDecision === "NOT_APPLICABLE",
  ).length;

  const includedMetrics = metricsOf(included);
  const excludedMetrics = metricsOf(excluded);
  const deltaIncludedVsAllOverlayRecords = deltaOf(includedMetrics, allOverlayMetrics);
  const deltaIncludedVsExcluded = deltaOf(includedMetrics, excludedMetrics);
  const template = withPolicy[0]?.assessment;
  const definition = OVERLAY_POLICY_DEFINITIONS[policyId];
  const totalResolvedWithPolicy = withPolicy.length;
  const earlyVerdict = verdictOf(totalResolvedWithPolicy, included.length, excluded.length, deltaIncludedVsExcluded);
  const reasons: string[] = [
    `Resolved records with persisted overlay for this policy: ${totalResolvedWithPolicy}.`,
    `Included=${included.length}, excluded=${excluded.length}, insufficientContext=${insufficientContextCount}.`,
  ];
  if (deltaIncludedVsExcluded.netAvgRDelta !== null) {
    reasons.push(`Included vs excluded delta netAvgR: ${deltaIncludedVsExcluded.netAvgRDelta.toFixed(4)}R.`);
  }
  if (totalResolvedWithPolicy < 10) {
    reasons.push("Forward overlay sample is still too small for a stable verdict.");
  }

  return {
    policyId,
    policyVersion: template?.policyVersion ?? definition.version,
    policyLabel: template?.policyLabel ?? definition.label,
    totalResolvedWithPolicy,
    includedCount: included.length,
    excludedCount: excluded.length,
    insufficientContextCount,
    includedMetrics,
    excludedMetrics,
    deltaIncludedVsAllOverlayRecords,
    deltaIncludedVsExcluded,
    earlyVerdict,
    reasons,
  };
}

export function buildAdaptiveRegimeGateOverlayPerformanceReport(
  records: StrategyExperienceRecord[],
  opts: AdaptiveOverlayPerformanceInput = {},
  now: Date = new Date(),
): AdaptiveRegimeGateOverlayPerformanceReport {
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const filtered = filterByEra(records, evidenceEra);
  const overlayRecords = filtered.filter((record) => (record.context.adaptiveRegimeGateOverlayAssessments?.length ?? 0) > 0);
  const allOverlayMetrics = metricsOf(overlayRecords);
  const policyIds: AdaptiveRegimeGateOverlayPolicyId[] = [
    "EXCLUDE_BULLISH_EXPANSION_V1",
    "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1",
    "EXCLUDE_BULLISH_EXPANSION_LONG_V1",
  ];

  return {
    generatedAt: now.toISOString(),
    evidenceEra,
    totalResolvedExperienceRecords: filtered.length,
    recordsWithPersistedOverlay: overlayRecords.length,
    recordsWithoutPersistedOverlay: filtered.length - overlayRecords.length,
    overlayForwardCoveragePct: filtered.length === 0 ? 0 : round4(overlayRecords.length / filtered.length),
    policyPerformance: policyIds.map((policyId) => policyPerformanceOf(policyId, overlayRecords, allOverlayMetrics)),
    overallReadiness: {
      collectingForwardEvidence: true,
      readyForBehaviorInfluence: false,
      reasons: [
        "Adaptive regime gate overlay is advisory-only and does not influence routing or execution.",
        overlayRecords.length < 10
          ? "No policy has enough resolved overlay-tagged records yet for a stable forward verdict."
          : "Forward overlay evidence is still accumulating and must mature before any behavior discussion.",
      ],
    },
  };
}

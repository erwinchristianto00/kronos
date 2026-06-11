import {
  buildStrategyExperienceRecords,
  type ShadowPosition,
  type StrategyExperienceRecord,
} from "@dtc/shared";

import {
  computeConditionalAlphaStability,
  type ConditionalAlphaStabilityReport,
} from "./conditional-alpha-stability.js";
import {
  buildTopContributorFingerprintReport,
  type TopContributorFingerprintReport,
} from "./top-contributor-fingerprint-v0.js";

/**
 * ADAPTIVE GATE CONTROLLER INTELLIGENCE (Phase 2C.1)
 *
 * Read-only advisory engine that analyzes each gate-relevant context dimension
 * (market regime, Kronos alignment, whale alignment, horizon conflict,
 * directional alignment, sentiment, etc.) against the baseline of resolved
 * StrategyExperienceRecord history. For each dimension's buckets it estimates
 * whether trading under that condition appears supportive or harmful versus the
 * baseline, and additionally analyses a small disciplined set of two- and
 * three-factor interactions.
 *
 * Output is intended for human review only.
 *
 * Does NOT change:
 *   - scanner ranking / Top-10 selection
 *   - opportunity / confidence / danger / edge scoring
 *   - routeMode decisions, variant selection, or promotion logic
 *   - shadow fill, close, cost, or calibration logic
 *   - live readiness, symbol quarantine, trade caps
 *   - stop / TP geometry or universe rotation
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type AdaptiveGateEvidenceEra = "POST_CALIBRATION" | "ALL_TIME";

export type AdaptiveSampleTier = "EMPTY" | "TOO_EARLY" | "EARLY" | "WATCHABLE" | "EVALUABLE";

export type AdaptiveConfidenceTier = "LOW" | "MEDIUM" | "HIGH";

export type AdaptiveGateDimension =
  | "MARKET_REGIME"
  | "KRONOS_ALIGNMENT"
  | "WHALE_ALIGNMENT"
  | "HORIZON_CONFLICT"
  | "SOURCE_CONFLICT"
  | "DIRECTIONAL_ALIGNMENT"
  | "SENTIMENT_BUCKET"
  | "FEAR_GREED_BUCKET";

export type LocalGateSignal =
  | "INSUFFICIENT_EVIDENCE"
  | "SUPPORTIVE_EARLY"
  | "SUPPORTIVE_WATCHABLE"
  | "HARMFUL_EARLY"
  | "HARMFUL_WATCHABLE"
  | "MIXED";

export type DimensionVerdict =
  | "INSUFFICIENT_COVERAGE"
  | "EARLY_SIGNAL"
  | "WATCHABLE"
  | "MIXED";

export type InteractionVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "EARLY_SUPPORTIVE"
  | "EARLY_HARMFUL"
  | "WATCHABLE_SUPPORTIVE"
  | "WATCHABLE_HARMFUL"
  | "MIXED";

export type PatchStatus = "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";
export type AdaptiveCoverageGapReason =
  | "EXPECTED_ZERO_COVERAGE_DUE_TO_NO_RESOLVED_FORWARD_RECORDS"
  | "TRUE_MAPPING_GAP"
  | "SOURCE_NOT_AVAILABLE_AT_SCAN_TIME"
  | "MIXED";

export interface AdaptiveGateBaseline {
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
}

export interface GateDeltaVsBaseline {
  netAvgR: number | null;
  profitFactor: number | null;
  slRate: number | null;
}

export interface GateConditionAssessment {
  dimension: AdaptiveGateDimension;
  bucket: string;
  conditionLabel: string;
  closedCount: number;
  sampleTier: AdaptiveSampleTier;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
  performanceDeltaVsBaseline: GateDeltaVsBaseline;
  localGateSignal: LocalGateSignal;
  confidenceTier: AdaptiveConfidenceTier;
  sampleWeight: number;
  reasons: string[];
}

export interface GateDimensionSummary {
  dimension: AdaptiveGateDimension;
  coveragePct: number;
  distinctBucketsObserved: number;
  meaningfulBucketsCount: number;
  dimensionVerdict: DimensionVerdict;
  buckets: GateConditionAssessment[];
  notes: string[];
}

export interface GateInteractionAssessment {
  interactionLabel: string;
  closedCount: number;
  sampleTier: AdaptiveSampleTier;
  netAvgR: number | null;
  profitFactor: number | null;
  slRate: number | null;
  deltaVsBaseline: GateDeltaVsBaseline;
  verdict: InteractionVerdict;
  reasons: string[];
}

export interface AdaptiveGatePatchHypothesis {
  title: string;
  sourceDimensionOrInteraction: string;
  suggestedFutureAction: string;
  evidenceSummary: string;
  confidence: AdaptiveConfidenceTier;
  patchStatus: PatchStatus;
  doesNotImplementNow: true;
}

export interface AdaptiveGateReadiness {
  advisoryEngineReady: boolean;
  readyForGateInfluence: boolean;
  reasons: string[];
}

export interface AdaptiveGateCoverageFieldProvenance {
  field: string;
  availableInCandidate: boolean;
  capturedInStrategyContext: boolean;
  persistedInShadowPosition: boolean;
  availableInExperienceRecord: boolean;
  consumedByAdaptiveGateEngine: boolean;
  selectedContextCoveragePct: number;
  resolvedSnapshotCoveragePct: number;
  resolvedExperienceCoveragePct: number;
  currentResolvedCoveragePostCalibration: number;
  mostLikelyGapReason: AdaptiveCoverageGapReason;
  notes: string[];
}

export interface AdaptiveGateCoverageProvenanceReport {
  totalResolvedRecords: number;
  resolvedRecordsWithStrategyContext: number;
  recordsCreatedBeforePhase2A5: number;
  recordsCreatedAfterPhase2A5: number;
  totalPositionsWithStrategyContext: number;
  openPositionsWithStrategyContext: number;
  perField: AdaptiveGateCoverageFieldProvenance[];
  notes: string[];
}

export interface AdaptiveGateIntelligenceReport {
  generatedAt: string;
  evidenceEra: AdaptiveGateEvidenceEra;
  totalResolvedExperienceRecords: number;
  usableRecordsForGateAnalysis: number;
  metadata: {
    resolvedExperienceRecordCount: number;
    usableRecordCount: number;
  };
  baseline: AdaptiveGateBaseline;
  contextCoverage: Array<{
    dimension: AdaptiveGateDimension;
    populatedCount: number;
    coveragePct: number;
  }>;
  contextCoverageSummary: {
    marketRegimeCoverage: number;
    selectedKronosBiasCoverage: number;
    kronosAlignmentCoverage: number;
    whaleAgreementCoverage: number;
    sentimentCoverage: number;
    fearGreedCoverage: number;
    horizonConflictCoverage: number;
    sourceConflictCoverage: number;
  };
  dimensionSummaries: GateDimensionSummary[];
  topSupportiveConditions: GateConditionAssessment[];
  topHarmfulConditions: GateConditionAssessment[];
  interactions: GateInteractionAssessment[];
  interactionAssessments: GateInteractionAssessment[];
  coverageProvenance: AdaptiveGateCoverageProvenanceReport;
  patchHypotheses: AdaptiveGatePatchHypothesis[];
  readiness: AdaptiveGateReadiness;
  conditionalAlphaStability?: ConditionalAlphaStabilityReport;
  topContributorFingerprint?: TopContributorFingerprintReport;
  notes: string[];
}

export interface AdaptiveGateIntelligenceInput {
  evidenceEra?: AdaptiveGateEvidenceEra;
  positions?: ShadowPosition[] | null;
  records?: StrategyExperienceRecord[] | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function avgFinite(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return r4(finite.reduce((sum, v) => sum + v, 0) / finite.length);
}

/**
 * Sample tier boundaries: 0=EMPTY, 1-4=TOO_EARLY, 5-14=EARLY, 15-29=WATCHABLE, 30+=EVALUABLE.
 * Identical to Phase 2B.1 so verdict ladders line up across advisory engines.
 */
function classifySampleTier(count: number): AdaptiveSampleTier {
  if (count <= 0) return "EMPTY";
  if (count < 5) return "TOO_EARLY";
  if (count < 15) return "EARLY";
  if (count < 30) return "WATCHABLE";
  return "EVALUABLE";
}

function sampleWeightOf(tier: AdaptiveSampleTier): number {
  switch (tier) {
    case "EMPTY": return 0;
    case "TOO_EARLY": return 0.2;
    case "EARLY": return 0.4;
    case "WATCHABLE": return 0.7;
    case "EVALUABLE": return 1.0;
  }
}

function confidenceTierOf(tier: AdaptiveSampleTier): AdaptiveConfidenceTier {
  if (tier === "EMPTY" || tier === "TOO_EARLY") return "LOW";
  if (tier === "EVALUABLE") return "HIGH";
  return "MEDIUM";
}

function profitFactorOf(records: StrategyExperienceRecord[]): number | null {
  const netRs = records
    .map((r) => r.outcome.realizedNetR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const winSum = netRs.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const lossAbs = Math.abs(netRs.filter((v) => v < 0).reduce((sum, v) => sum + v, 0));
  if (lossAbs === 0) return null;
  return r4(winSum / lossAbs);
}

function slRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  const slCount = records.filter(
    (r) =>
      r.outcome.slHit === true ||
      r.outcome.closeReason === "SL" ||
      r.outcome.closeReason === "BREAKEVEN",
  ).length;
  return r4(slCount / records.length);
}

function tp1ProfitableRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  const c = records.filter((r) => r.outcome.tp1Hit === true && (r.outcome.realizedNetR ?? 0) > 0).length;
  return r4(c / records.length);
}

function winRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  const w = records.filter((r) => (r.outcome.realizedNetR ?? 0) > 0).length;
  return r4(w / records.length);
}

function baselineOf(records: StrategyExperienceRecord[]): AdaptiveGateBaseline {
  if (records.length === 0) {
    return {
      closedCount: 0,
      netAvgR: null,
      grossAvgR: null,
      profitFactor: null,
      winRate: null,
      tp1ProfitableRate: null,
      slRate: null,
    };
  }
  return {
    closedCount: records.length,
    netAvgR: avgFinite(records.map((r) => r.outcome.realizedNetR)),
    grossAvgR: avgFinite(records.map((r) => r.outcome.realizedGrossR)),
    profitFactor: profitFactorOf(records),
    winRate: winRateOf(records),
    tp1ProfitableRate: tp1ProfitableRateOf(records),
    slRate: slRateOf(records),
  };
}

function deltaVsBaseline(
  c: { netAvgR: number | null; profitFactor: number | null; slRate: number | null },
  b: AdaptiveGateBaseline,
): GateDeltaVsBaseline {
  return {
    netAvgR: c.netAvgR !== null && b.netAvgR !== null ? r4(c.netAvgR - b.netAvgR) : null,
    profitFactor: c.profitFactor !== null && b.profitFactor !== null ? r4(c.profitFactor - b.profitFactor) : null,
    slRate: c.slRate !== null && b.slRate !== null ? r4(c.slRate - b.slRate) : null,
  };
}

// ─── Bucket derivation per dimension ──────────────────────────────────────────

/**
 * Each derive*() returns the bucket label for a record, or null if the underlying
 * field is missing. The null records do not contribute to that dimension's stats
 * but are still counted in the coverage denominator.
 */

function deriveMarketRegime(rec: StrategyExperienceRecord): string | null {
  const v = rec.context.marketRegime;
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).toUpperCase();
  if (s.includes("BULL")) return "BULLISH_EXPANSION";
  if (s.includes("BEAR")) return "BEARISH_EXPANSION";
  if (s.includes("SIDE") || s.includes("RANGE") || s.includes("CHOP")) return "SIDEWAYS";
  if (s.includes("MIX")) return "MIXED";
  return s;
}

function deriveKronosAlignment(rec: StrategyExperienceRecord): string | null {
  const bias = rec.context.selectedKronosBias ?? rec.context.kronosBias1h;
  if (bias === null || bias === undefined) return null;
  if (bias === "UNAVAILABLE") return "KRONOS_UNAVAILABLE";
  return bias === rec.context.direction ? "KRONOS_ALIGNED" : "KRONOS_DISAGREES";
}

function deriveWhaleAlignment(rec: StrategyExperienceRecord): string | null {
  const agreement = rec.context.whaleAgreement;
  if (agreement === null || agreement === undefined) return null;
  if (agreement === "AGREES") return "WHALE_AGREES";
  if (agreement === "DISAGREES") return "WHALE_DISAGREES";
  return "WHALE_UNAVAILABLE";
}

function deriveHorizonConflict(rec: StrategyExperienceRecord): string | null {
  const v = rec.context.horizonConflict;
  if (v === null || v === undefined) return null;
  return v ? "HORIZON_CONFLICT_TRUE" : "HORIZON_CONFLICT_FALSE";
}

function deriveSourceConflict(rec: StrategyExperienceRecord): string | null {
  // No dedicated source-conflict field exists on the snapshot; infer from
  // (kronos vs direction) AND (whale vs direction) when both are available.
  const bias = rec.context.selectedKronosBias ?? rec.context.kronosBias1h;
  const whale = rec.context.whaleAgreement;
  if (bias === null || bias === undefined) return null;
  if (whale === null || whale === undefined) return null;
  if (bias === "UNAVAILABLE" || whale === "UNAVAILABLE") return null;
  const kronosOk = bias === rec.context.direction;
  const whaleOk = whale === "AGREES";
  if (kronosOk === whaleOk) return "SOURCE_CONFLICT_FALSE";
  return "SOURCE_CONFLICT_TRUE";
}

function deriveDirectionalAlignment(rec: StrategyExperienceRecord): string | null {
  const v = rec.context.directionalAlignmentLabel;
  if (v === null || v === undefined) return null;
  if (v === "ALIGNED") return "TREND_ALIGNED";
  if (v === "MIXED") return "MIXED";
  if (v === "CONFLICTED") return "CONFLICTING";
  return null;
}

function deriveSentimentBucket(rec: StrategyExperienceRecord): string | null {
  const v = rec.context.sentimentBucket;
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).toUpperCase();
  if (s.includes("EUPH")) return "EUPHORIC";
  if (s.includes("GREED")) return "GREEDY";
  if (s.includes("FEAR")) return "FEARFUL";
  if (s.includes("PANIC")) return "PANIC";
  if (s.includes("NEUT")) return "NEUTRAL";
  return s;
}

function deriveFearGreedBucket(rec: StrategyExperienceRecord): string | null {
  const explicit = rec.context.fearGreedBucket;
  if (explicit && explicit !== "") {
    const s = String(explicit).toUpperCase();
    if (s.includes("EUPH")) return "EUPHORIC";
    if (s.includes("GREED")) return "GREEDY";
    if (s.includes("FEAR")) return "FEARFUL";
    if (s.includes("PANIC")) return "PANIC";
    if (s.includes("NEUT")) return "NEUTRAL";
    return s;
  }
  const num = rec.context.fearGreed ?? rec.context.fearGreedValue;
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  if (num >= 90) return "EUPHORIC";
  if (num >= 60) return "GREEDY";
  if (num >= 40) return "NEUTRAL";
  if (num >= 20) return "FEARFUL";
  return "PANIC";
}

const DIMENSION_DERIVERS: Array<{ dimension: AdaptiveGateDimension; derive: (r: StrategyExperienceRecord) => string | null }> = [
  { dimension: "MARKET_REGIME", derive: deriveMarketRegime },
  { dimension: "KRONOS_ALIGNMENT", derive: deriveKronosAlignment },
  { dimension: "WHALE_ALIGNMENT", derive: deriveWhaleAlignment },
  { dimension: "HORIZON_CONFLICT", derive: deriveHorizonConflict },
  { dimension: "SOURCE_CONFLICT", derive: deriveSourceConflict },
  { dimension: "DIRECTIONAL_ALIGNMENT", derive: deriveDirectionalAlignment },
  { dimension: "SENTIMENT_BUCKET", derive: deriveSentimentBucket },
  { dimension: "FEAR_GREED_BUCKET", derive: deriveFearGreedBucket },
];

// ─── Local gate signal classifier ─────────────────────────────────────────────

/**
 * Conservative meaningful-delta thresholds:
 *   - ±0.15R net average (large enough to matter against typical bot R-noise).
 *   - ±0.15 profit factor (modest PF lift/drag at small sample is unstable).
 *   - ±0.07 (7 pp) slippage/SL rate (a 7-point shift in stop-out % is material).
 * EARLY-tier requires only one positive condition to fire SUPPORTIVE/HARMFUL_EARLY.
 * WATCHABLE/EVALUABLE require netAvgR AND PF deltas to both move in the same
 * direction (stricter, because the sample affords a stronger statement).
 */
const NET_DELTA_THRESHOLD = 0.15;
const PF_DELTA_THRESHOLD = 0.15;
const SL_DELTA_THRESHOLD = 0.07;

function classifyLocalGateSignal(
  tier: AdaptiveSampleTier,
  delta: GateDeltaVsBaseline,
): LocalGateSignal {
  if (tier === "EMPTY" || tier === "TOO_EARLY") return "INSUFFICIENT_EVIDENCE";

  const dNet = delta.netAvgR;
  const dPF = delta.profitFactor;
  const dSL = delta.slRate;

  const netUp = dNet !== null && dNet >= NET_DELTA_THRESHOLD;
  const netDown = dNet !== null && dNet <= -NET_DELTA_THRESHOLD;
  const pfUp = dPF !== null && dPF >= PF_DELTA_THRESHOLD;
  const pfDown = dPF !== null && dPF <= -PF_DELTA_THRESHOLD;
  const slUp = dSL !== null && dSL >= SL_DELTA_THRESHOLD;
  const slDown = dSL !== null && dSL <= -SL_DELTA_THRESHOLD;

  if (tier === "EARLY") {
    const supportive = (netUp || pfUp) && !slUp && !netDown && !pfDown;
    const harmful = netDown || pfDown || slUp;
    if (supportive && !harmful) return "SUPPORTIVE_EARLY";
    if (harmful && !supportive) return "HARMFUL_EARLY";
    if (supportive && harmful) return "MIXED";
    return "MIXED";
  }

  // WATCHABLE / EVALUABLE: stricter, requiring concordant netR and PF movement.
  const supportive = netUp && pfUp && !slUp;
  const harmful = (netDown && pfDown) || (slUp && (netDown || pfDown));
  if (supportive && !harmful) return "SUPPORTIVE_WATCHABLE";
  if (harmful && !supportive) return "HARMFUL_WATCHABLE";
  if (supportive && harmful) return "MIXED";
  // Single-axis signal at WATCHABLE+ is too weak; return MIXED rather than promote.
  if (netUp || pfUp || netDown || pfDown || slUp || slDown) return "MIXED";
  return "MIXED";
}

function reasonsForCondition(
  c: GateConditionAssessment,
  baseline: AdaptiveGateBaseline,
): string[] {
  const out: string[] = [];
  out.push(`Bucket ${c.bucket} on dimension ${c.dimension}: ${c.closedCount} closes (${c.sampleTier}).`);
  if (c.netAvgR !== null && baseline.netAvgR !== null) {
    out.push(`Net avg R ${c.netAvgR.toFixed(4)} vs baseline ${baseline.netAvgR.toFixed(4)} (delta ${(c.performanceDeltaVsBaseline.netAvgR ?? 0).toFixed(4)}).`);
  }
  if (c.profitFactor !== null && baseline.profitFactor !== null) {
    out.push(`Profit factor ${c.profitFactor.toFixed(2)} vs baseline ${baseline.profitFactor.toFixed(2)} (delta ${(c.performanceDeltaVsBaseline.profitFactor ?? 0).toFixed(2)}).`);
  }
  if (c.slRate !== null && baseline.slRate !== null) {
    out.push(`SL rate ${(c.slRate * 100).toFixed(0)}% vs baseline ${(baseline.slRate * 100).toFixed(0)}% (delta ${((c.performanceDeltaVsBaseline.slRate ?? 0) * 100).toFixed(1)}pp).`);
  }
  if (c.sampleTier === "TOO_EARLY" || c.sampleTier === "EARLY") {
    out.push("Sample below 15 closes; signal is directional, not confirmation-grade.");
  } else if (c.sampleTier === "EVALUABLE") {
    out.push("Sample is 30+ closes; verdict is confirmation-grade.");
  }
  return out;
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function filterByEra(records: StrategyExperienceRecord[], era: AdaptiveGateEvidenceEra): StrategyExperienceRecord[] {
  if (era === "ALL_TIME") return records;
  return records.filter(
    (r) => (r.context.evidenceEra ?? r.outcome.evidenceEra) === "POST_CALIBRATION",
  );
}

function positionHasClosedVariant(position: ShadowPosition): boolean {
  return position.variants.some((variant) => variant.state === "CLOSED");
}

function filterPositionsByEra(positions: ShadowPosition[], era: AdaptiveGateEvidenceEra): ShadowPosition[] {
  const closed = positions.filter(positionHasClosedVariant);
  if (era === "ALL_TIME") return closed;
  return closed.filter((position) => {
    const evidenceEra = position.strategyContextSnapshot?.evidenceEra ?? position.variantSelection?.evidenceEra ?? null;
    return evidenceEra === "POST_CALIBRATION";
  });
}

function positionMatchesEra(position: ShadowPosition, era: AdaptiveGateEvidenceEra): boolean {
  if (era === "ALL_TIME") return true;
  const evidenceEra = position.strategyContextSnapshot?.evidenceEra ?? position.variantSelection?.evidenceEra ?? null;
  return evidenceEra === "POST_CALIBRATION";
}

interface CoverageFieldDefinition {
  field: string;
  availableInCandidate: boolean;
  capturedInStrategyContext: boolean;
  persistedInShadowPosition: boolean;
  availableInExperienceRecord: boolean;
  consumedByAdaptiveGateEngine: boolean;
  snapshotHasValue: (position: ShadowPosition) => boolean;
  recordHasValue: (record: StrategyExperienceRecord) => boolean;
}

const COVERAGE_FIELD_DEFS: CoverageFieldDefinition[] = [
  {
    field: "selectedKronosBias",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: true,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.selectedKronosBias !== null && position.strategyContextSnapshot?.selectedKronosBias !== undefined,
    recordHasValue: (record) => record.context.selectedKronosBias !== null && record.context.selectedKronosBias !== undefined,
  },
  {
    field: "kronosBias1h",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: true,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.kronosBias1h !== null && position.strategyContextSnapshot?.kronosBias1h !== undefined,
    recordHasValue: (record) => record.context.kronosBias1h !== null && record.context.kronosBias1h !== undefined,
  },
  {
    field: "kronosBias4h",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: false,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.kronosBias4h !== null && position.strategyContextSnapshot?.kronosBias4h !== undefined,
    recordHasValue: (record) => record.context.kronosBias4h !== null && record.context.kronosBias4h !== undefined,
  },
  {
    field: "horizonConflict",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: true,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.horizonConflict !== null && position.strategyContextSnapshot?.horizonConflict !== undefined,
    recordHasValue: (record) => record.context.horizonConflict !== null && record.context.horizonConflict !== undefined,
  },
  {
    field: "whaleAgreement",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: true,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.whaleAgreement !== null && position.strategyContextSnapshot?.whaleAgreement !== undefined,
    recordHasValue: (record) => record.context.whaleAgreement !== null && record.context.whaleAgreement !== undefined,
  },
  {
    field: "whaleBias",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: false,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.whaleBias !== null && position.strategyContextSnapshot?.whaleBias !== undefined,
    recordHasValue: (record) => record.context.whaleBias !== null && record.context.whaleBias !== undefined,
  },
  {
    field: "whaleDirection",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: false,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.whaleDirection !== null && position.strategyContextSnapshot?.whaleDirection !== undefined,
    recordHasValue: (record) => record.context.whaleDirection !== null && record.context.whaleDirection !== undefined,
  },
  {
    field: "sentimentSummary",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: false,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.sentimentSummary !== null && position.strategyContextSnapshot?.sentimentSummary !== undefined,
    recordHasValue: (record) => record.context.sentimentSummary !== null && record.context.sentimentSummary !== undefined,
  },
  {
    field: "sentimentBucket",
    availableInCandidate: true,
    capturedInStrategyContext: true,
    persistedInShadowPosition: true,
    availableInExperienceRecord: true,
    consumedByAdaptiveGateEngine: true,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.sentimentBucket !== null && position.strategyContextSnapshot?.sentimentBucket !== undefined,
    recordHasValue: (record) => record.context.sentimentBucket !== null && record.context.sentimentBucket !== undefined,
  },
  {
    field: "fearGreedValue",
    availableInCandidate: false,
    capturedInStrategyContext: false,
    persistedInShadowPosition: false,
    availableInExperienceRecord: false,
    consumedByAdaptiveGateEngine: true,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.fearGreedValue !== null && position.strategyContextSnapshot?.fearGreedValue !== undefined,
    recordHasValue: (record) => record.context.fearGreedValue !== null && record.context.fearGreedValue !== undefined,
  },
  {
    field: "fearGreedBucket",
    availableInCandidate: false,
    capturedInStrategyContext: false,
    persistedInShadowPosition: false,
    availableInExperienceRecord: false,
    consumedByAdaptiveGateEngine: true,
    snapshotHasValue: (position) => position.strategyContextSnapshot?.fearGreedBucket !== null && position.strategyContextSnapshot?.fearGreedBucket !== undefined,
    recordHasValue: (record) => record.context.fearGreedBucket !== null && record.context.fearGreedBucket !== undefined,
  },
];

function pct(count: number, total: number): number {
  if (total <= 0) return 0;
  return r4(count / total);
}

function coverageReasonForField(
  def: CoverageFieldDefinition,
  selectedContextCoveragePct: number,
  resolvedSnapshotCoveragePct: number,
  resolvedExperienceCoveragePct: number,
  resolvedRecordsWithStrategyContext: number,
): AdaptiveCoverageGapReason {
  if (!def.availableInCandidate) return "SOURCE_NOT_AVAILABLE_AT_SCAN_TIME";
  if (!def.capturedInStrategyContext || !def.persistedInShadowPosition || !def.availableInExperienceRecord) {
    return "TRUE_MAPPING_GAP";
  }
  if (resolvedSnapshotCoveragePct > 0 && resolvedExperienceCoveragePct === 0) {
    return "TRUE_MAPPING_GAP";
  }
  if (selectedContextCoveragePct > 0 && resolvedExperienceCoveragePct === 0 && resolvedRecordsWithStrategyContext === 0) {
    return "EXPECTED_ZERO_COVERAGE_DUE_TO_NO_RESOLVED_FORWARD_RECORDS";
  }
  if (selectedContextCoveragePct > 0 && resolvedExperienceCoveragePct === 0) {
    return "MIXED";
  }
  return "MIXED";
}

export function buildAdaptiveGateCoverageProvenanceReport(
  positions: ShadowPosition[],
  opts: AdaptiveGateIntelligenceInput = {},
): AdaptiveGateCoverageProvenanceReport {
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const resolvedPositions = filterPositionsByEra(positions, evidenceEra);
  const resolvedRecords = filterByEra(opts.records ?? buildStrategyExperienceRecords(positions), evidenceEra);
  const allSnapshotPositions = positions.filter((position) =>
    positionMatchesEra(position, evidenceEra) &&
    position.strategyContextSnapshot !== null &&
    position.strategyContextSnapshot !== undefined,
  );
  const openSnapshotPositions = allSnapshotPositions.filter((position) => !positionHasClosedVariant(position));
  const resolvedSnapshotPositions = resolvedPositions.filter((position) => position.strategyContextSnapshot !== null && position.strategyContextSnapshot !== undefined);

  const perField = COVERAGE_FIELD_DEFS.map((def): AdaptiveGateCoverageFieldProvenance => {
    const selectedContextCoveragePct = pct(
      allSnapshotPositions.filter((position) => def.snapshotHasValue(position)).length,
      allSnapshotPositions.length,
    );
    const resolvedSnapshotCoveragePct = pct(
      resolvedSnapshotPositions.filter((position) => def.snapshotHasValue(position)).length,
      resolvedSnapshotPositions.length,
    );
    const resolvedExperienceCoveragePct = pct(
      resolvedRecords.filter((record) => def.recordHasValue(record)).length,
      resolvedRecords.length,
    );
    const mostLikelyGapReason = coverageReasonForField(
      def,
      selectedContextCoveragePct,
      resolvedSnapshotCoveragePct,
      resolvedExperienceCoveragePct,
      resolvedSnapshotPositions.length,
    );

    const notes: string[] = [];
    if (allSnapshotPositions.length === 0) {
      notes.push("No positions with persisted strategy context snapshots exist yet.");
    } else {
      notes.push(`${Math.round(selectedContextCoveragePct * 100)}% of persisted strategy snapshots currently carry this field.`);
    }
    if (resolvedSnapshotPositions.length === 0) {
      notes.push("No resolved positions currently carry persisted strategy context snapshots.");
    } else {
      notes.push(`${Math.round(resolvedSnapshotCoveragePct * 100)}% of resolved snapshot-backed positions carry this field.`);
    }
    if (!def.availableInCandidate) {
      notes.push("The current Candidate and SentimentSignal pipeline does not expose this field as structured scan-time data.");
    } else if (mostLikelyGapReason === "EXPECTED_ZERO_COVERAGE_DUE_TO_NO_RESOLVED_FORWARD_RECORDS") {
      notes.push("Forward positions now capture this field, but none of those snapshot-backed positions have resolved yet.");
    } else if (mostLikelyGapReason === "TRUE_MAPPING_GAP") {
      notes.push("The field is present upstream but disappears before it reaches the resolved experience layer.");
    }

    return {
      field: def.field,
      availableInCandidate: def.availableInCandidate,
      capturedInStrategyContext: def.capturedInStrategyContext,
      persistedInShadowPosition: def.persistedInShadowPosition,
      availableInExperienceRecord: def.availableInExperienceRecord,
      consumedByAdaptiveGateEngine: def.consumedByAdaptiveGateEngine,
      selectedContextCoveragePct,
      resolvedSnapshotCoveragePct,
      resolvedExperienceCoveragePct,
      currentResolvedCoveragePostCalibration: resolvedExperienceCoveragePct,
      mostLikelyGapReason,
      notes,
    };
  });

  return {
    totalResolvedRecords: resolvedPositions.length,
    resolvedRecordsWithStrategyContext: resolvedSnapshotPositions.length,
    recordsCreatedBeforePhase2A5: resolvedPositions.length - resolvedSnapshotPositions.length,
    recordsCreatedAfterPhase2A5: resolvedSnapshotPositions.length,
    totalPositionsWithStrategyContext: allSnapshotPositions.length,
    openPositionsWithStrategyContext: openSnapshotPositions.length,
    perField,
    notes: [
      "Records created after Phase 2A.5 are inferred by the presence of a persisted strategyContextSnapshot.",
      "Resolved experience coverage measures the fields that the adaptive gate engine can actually consume today.",
    ],
  };
}

// ─── Per-bucket assessment ────────────────────────────────────────────────────

function buildBucketAssessment(
  dimension: AdaptiveGateDimension,
  bucket: string,
  records: StrategyExperienceRecord[],
  baseline: AdaptiveGateBaseline,
): GateConditionAssessment {
  const closedCount = records.length;
  const netAvgR = avgFinite(records.map((r) => r.outcome.realizedNetR));
  const grossAvgR = avgFinite(records.map((r) => r.outcome.realizedGrossR));
  const profitFactor = profitFactorOf(records);
  const winRate = winRateOf(records);
  const tp1ProfitableRate = tp1ProfitableRateOf(records);
  const slRate = slRateOf(records);
  const winners = records.filter((r) => (r.outcome.realizedNetR ?? 0) > 0);
  const losers = records.filter((r) => (r.outcome.realizedNetR ?? 0) < 0);
  const avgWinR = avgFinite(winners.map((r) => r.outcome.realizedNetR));
  const avgLossR = avgFinite(losers.map((r) => r.outcome.realizedNetR));
  const avgMfeR = avgFinite(records.map((r) => r.outcome.maxFavorableExcursionR ?? r.outcome.mfeR));
  const avgMaeR = avgFinite(records.map((r) => r.outcome.maxAdverseExcursionR ?? r.outcome.maeR));

  const sampleTier = classifySampleTier(closedCount);
  const sampleWeight = sampleWeightOf(sampleTier);
  const performanceDeltaVsBaseline = deltaVsBaseline({ netAvgR, profitFactor, slRate }, baseline);
  const localGateSignal = classifyLocalGateSignal(sampleTier, performanceDeltaVsBaseline);
  const confidenceTier = confidenceTierOf(sampleTier);

  const assessment: GateConditionAssessment = {
    dimension,
    bucket,
    conditionLabel: bucket,
    closedCount,
    sampleTier,
    netAvgR,
    grossAvgR,
    profitFactor,
    winRate,
    tp1ProfitableRate,
    slRate,
    avgWinR,
    avgLossR,
    avgMfeR,
    avgMaeR,
    performanceDeltaVsBaseline,
    localGateSignal,
    confidenceTier,
    sampleWeight,
    reasons: [],
  };
  assessment.reasons = reasonsForCondition(assessment, baseline);
  return assessment;
}

// ─── Dimension summary ────────────────────────────────────────────────────────

function dimensionVerdictOf(
  coveragePct: number,
  buckets: GateConditionAssessment[],
): DimensionVerdict {
  const meaningful = buckets.filter((b) => b.closedCount >= 5);
  if (coveragePct < 0.25 || meaningful.length < 2) return "INSUFFICIENT_COVERAGE";
  const hasWatchable = meaningful.some(
    (b) => b.sampleTier === "WATCHABLE" || b.sampleTier === "EVALUABLE",
  );
  const hasEarlySignal = meaningful.some(
    (b) =>
      b.localGateSignal === "SUPPORTIVE_EARLY" ||
      b.localGateSignal === "SUPPORTIVE_WATCHABLE" ||
      b.localGateSignal === "HARMFUL_EARLY" ||
      b.localGateSignal === "HARMFUL_WATCHABLE",
  );
  if (hasWatchable && hasEarlySignal) return "WATCHABLE";
  if (hasEarlySignal) return "EARLY_SIGNAL";
  return "MIXED";
}

// ─── Interactions ─────────────────────────────────────────────────────────────

interface InteractionDef {
  label: string;
  requires: AdaptiveGateDimension[];
  predicate: (rec: StrategyExperienceRecord) => boolean;
}

function buildInteractionDefinitions(coverage: Map<AdaptiveGateDimension, number>): InteractionDef[] {
  const hasKronos = (coverage.get("KRONOS_ALIGNMENT") ?? 0) > 0;
  const hasWhale = (coverage.get("WHALE_ALIGNMENT") ?? 0) > 0;
  const hasHorizon = (coverage.get("HORIZON_CONFLICT") ?? 0) > 0;
  const hasRegime = (coverage.get("MARKET_REGIME") ?? 0) > 0;
  const hasSource = (coverage.get("SOURCE_CONFLICT") ?? 0) > 0;
  const hasAlignment = (coverage.get("DIRECTIONAL_ALIGNMENT") ?? 0) > 0;

  const defs: InteractionDef[] = [];

  if (hasKronos && hasWhale) {
    defs.push({
      label: "KRONOS_ALIGNED + WHALE_AGREES",
      requires: ["KRONOS_ALIGNMENT", "WHALE_ALIGNMENT"],
      predicate: (r) =>
        deriveKronosAlignment(r) === "KRONOS_ALIGNED" && deriveWhaleAlignment(r) === "WHALE_AGREES",
    });
  }
  if (hasKronos && hasHorizon) {
    defs.push({
      label: "KRONOS_ALIGNED + NO_HORIZON_CONFLICT",
      requires: ["KRONOS_ALIGNMENT", "HORIZON_CONFLICT"],
      predicate: (r) =>
        deriveKronosAlignment(r) === "KRONOS_ALIGNED" && deriveHorizonConflict(r) === "HORIZON_CONFLICT_FALSE",
    });
  }
  if (hasWhale && hasHorizon) {
    defs.push({
      label: "WHALE_AGREES + NO_HORIZON_CONFLICT",
      requires: ["WHALE_ALIGNMENT", "HORIZON_CONFLICT"],
      predicate: (r) =>
        deriveWhaleAlignment(r) === "WHALE_AGREES" && deriveHorizonConflict(r) === "HORIZON_CONFLICT_FALSE",
    });
  }
  if (hasKronos && hasWhale && hasHorizon) {
    defs.push({
      label: "KRONOS_ALIGNED + WHALE_AGREES + NO_HORIZON_CONFLICT",
      requires: ["KRONOS_ALIGNMENT", "WHALE_ALIGNMENT", "HORIZON_CONFLICT"],
      predicate: (r) =>
        deriveKronosAlignment(r) === "KRONOS_ALIGNED" &&
        deriveWhaleAlignment(r) === "WHALE_AGREES" &&
        deriveHorizonConflict(r) === "HORIZON_CONFLICT_FALSE",
    });
  }
  if (hasRegime) {
    defs.push({
      label: "MARKET_REGIME_BULLISH + LONG",
      requires: ["MARKET_REGIME"],
      predicate: (r) => deriveMarketRegime(r) === "BULLISH_EXPANSION" && r.context.direction === "LONG",
    });
    defs.push({
      label: "MARKET_REGIME_BEARISH + SHORT",
      requires: ["MARKET_REGIME"],
      predicate: (r) => deriveMarketRegime(r) === "BEARISH_EXPANSION" && r.context.direction === "SHORT",
    });
    defs.push({
      label: "MARKET_REGIME_BULLISH + SHORT (counter-trend)",
      requires: ["MARKET_REGIME"],
      predicate: (r) => deriveMarketRegime(r) === "BULLISH_EXPANSION" && r.context.direction === "SHORT",
    });
    defs.push({
      label: "MARKET_REGIME_BEARISH + LONG (counter-trend)",
      requires: ["MARKET_REGIME"],
      predicate: (r) => deriveMarketRegime(r) === "BEARISH_EXPANSION" && r.context.direction === "LONG",
    });
  }
  if (hasSource && hasAlignment) {
    defs.push({
      label: "SOURCE_CONFLICT_FALSE + TREND_ALIGNED",
      requires: ["SOURCE_CONFLICT", "DIRECTIONAL_ALIGNMENT"],
      predicate: (r) =>
        deriveSourceConflict(r) === "SOURCE_CONFLICT_FALSE" && deriveDirectionalAlignment(r) === "TREND_ALIGNED",
    });
  }

  return defs;
}

function interactionVerdictOf(
  tier: AdaptiveSampleTier,
  signal: LocalGateSignal,
): InteractionVerdict {
  if (signal === "INSUFFICIENT_EVIDENCE" || tier === "EMPTY" || tier === "TOO_EARLY") {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (signal === "SUPPORTIVE_EARLY") return "EARLY_SUPPORTIVE";
  if (signal === "HARMFUL_EARLY") return "EARLY_HARMFUL";
  if (signal === "SUPPORTIVE_WATCHABLE") return "WATCHABLE_SUPPORTIVE";
  if (signal === "HARMFUL_WATCHABLE") return "WATCHABLE_HARMFUL";
  return "MIXED";
}

function buildInteractionAssessment(
  def: InteractionDef,
  records: StrategyExperienceRecord[],
  baseline: AdaptiveGateBaseline,
): GateInteractionAssessment {
  const matched = records.filter(def.predicate);
  const closedCount = matched.length;
  const netAvgR = avgFinite(matched.map((r) => r.outcome.realizedNetR));
  const profitFactor = profitFactorOf(matched);
  const slRate = slRateOf(matched);
  const tier = classifySampleTier(closedCount);
  const delta = deltaVsBaseline({ netAvgR, profitFactor, slRate }, baseline);
  const signal = classifyLocalGateSignal(tier, delta);
  const verdict = interactionVerdictOf(tier, signal);

  const reasons: string[] = [];
  reasons.push(`Interaction ${def.label}: ${closedCount} closes (${tier}).`);
  if (netAvgR !== null && baseline.netAvgR !== null) {
    reasons.push(`Net avg R ${netAvgR.toFixed(4)} vs baseline ${baseline.netAvgR.toFixed(4)} (delta ${(delta.netAvgR ?? 0).toFixed(4)}).`);
  }
  if (closedCount < 5) reasons.push("Below 5 closes; interaction signal is insufficient.");

  return {
    interactionLabel: def.label,
    closedCount,
    sampleTier: tier,
    netAvgR,
    profitFactor,
    slRate,
    deltaVsBaseline: delta,
    verdict,
    reasons,
  };
}

// ─── Patch hypotheses ─────────────────────────────────────────────────────────

function patchStatusFor(confidence: AdaptiveConfidenceTier, tier: AdaptiveSampleTier, internallyConsistent: boolean): PatchStatus {
  if (confidence === "HIGH" && tier === "EVALUABLE" && internallyConsistent) return "READY_FOR_PATCH_DISCUSSION";
  if (confidence === "MEDIUM" && internallyConsistent) return "AUDIT_DEEPER";
  return "WATCH";
}

function buildPatchHypothesesFromBuckets(
  buckets: GateConditionAssessment[],
  source: string,
): AdaptiveGatePatchHypothesis[] {
  const out: AdaptiveGatePatchHypothesis[] = [];
  // Harmful conditions suggest future gating-out / tightening.
  const harmful = buckets.filter(
    (b) => b.localGateSignal === "HARMFUL_EARLY" || b.localGateSignal === "HARMFUL_WATCHABLE",
  );
  for (const b of harmful) {
    const action = `Future Phase 2C.2 could tighten promotion when ${b.dimension}=${b.bucket} (consider down-weighting or gating-out trades under this condition).`;
    const ev = `n=${b.closedCount}, netAvgR=${(b.netAvgR ?? 0).toFixed(4)} (delta ${(b.performanceDeltaVsBaseline.netAvgR ?? 0).toFixed(4)}), PF=${(b.profitFactor ?? 0).toFixed(2)}, SL=${((b.slRate ?? 0) * 100).toFixed(0)}%.`;
    const internallyConsistent =
      (b.performanceDeltaVsBaseline.netAvgR ?? 0) < 0 &&
      ((b.performanceDeltaVsBaseline.profitFactor ?? 0) < 0 || (b.performanceDeltaVsBaseline.slRate ?? 0) > 0);
    out.push({
      title: `Tighten promotion when ${b.dimension}=${b.bucket}`,
      sourceDimensionOrInteraction: source,
      suggestedFutureAction: action,
      evidenceSummary: ev,
      confidence: b.confidenceTier,
      patchStatus: patchStatusFor(b.confidenceTier, b.sampleTier, internallyConsistent),
      doesNotImplementNow: true,
    });
  }
  // Supportive conditions suggest a future soft-bias.
  const supportive = buckets.filter(
    (b) => b.localGateSignal === "SUPPORTIVE_EARLY" || b.localGateSignal === "SUPPORTIVE_WATCHABLE",
  );
  for (const b of supportive) {
    const action = `Future Phase 2C.2 could soft-bias toward trades where ${b.dimension}=${b.bucket}, only after corroboration with regime drift and symbol-route suitability.`;
    const ev = `n=${b.closedCount}, netAvgR=${(b.netAvgR ?? 0).toFixed(4)} (delta +${(b.performanceDeltaVsBaseline.netAvgR ?? 0).toFixed(4)}), PF=${(b.profitFactor ?? 0).toFixed(2)}, SL=${((b.slRate ?? 0) * 100).toFixed(0)}%.`;
    const internallyConsistent =
      (b.performanceDeltaVsBaseline.netAvgR ?? 0) > 0 &&
      ((b.performanceDeltaVsBaseline.profitFactor ?? 0) > 0 || (b.performanceDeltaVsBaseline.slRate ?? 0) < 0);
    out.push({
      title: `Soft-bias toward ${b.dimension}=${b.bucket}`,
      sourceDimensionOrInteraction: source,
      suggestedFutureAction: action,
      evidenceSummary: ev,
      confidence: b.confidenceTier,
      patchStatus: patchStatusFor(b.confidenceTier, b.sampleTier, internallyConsistent),
      doesNotImplementNow: true,
    });
  }
  return out;
}

function buildPatchHypothesesFromInteractions(
  interactions: GateInteractionAssessment[],
): AdaptiveGatePatchHypothesis[] {
  const out: AdaptiveGatePatchHypothesis[] = [];
  for (const i of interactions) {
    if (i.verdict === "INSUFFICIENT_EVIDENCE" || i.verdict === "MIXED") continue;
    const harmful = i.verdict === "EARLY_HARMFUL" || i.verdict === "WATCHABLE_HARMFUL";
    const title = harmful
      ? `Gate-out interaction ${i.interactionLabel}`
      : `Soft-bias toward interaction ${i.interactionLabel}`;
    const action = harmful
      ? `Future Phase 2C.2 could gate-out or down-weight trades matching ${i.interactionLabel}.`
      : `Future Phase 2C.2 could soft-bias toward trades matching ${i.interactionLabel} after corroboration.`;
    const ev = `n=${i.closedCount}, netAvgR=${(i.netAvgR ?? 0).toFixed(4)} (delta ${(i.deltaVsBaseline.netAvgR ?? 0).toFixed(4)}), PF=${(i.profitFactor ?? 0).toFixed(2)}.`;
    const confidence = confidenceTierOf(i.sampleTier);
    const internallyConsistent =
      (harmful && (i.deltaVsBaseline.netAvgR ?? 0) < 0) ||
      (!harmful && (i.deltaVsBaseline.netAvgR ?? 0) > 0);
    out.push({
      title,
      sourceDimensionOrInteraction: i.interactionLabel,
      suggestedFutureAction: action,
      evidenceSummary: ev,
      confidence,
      patchStatus: patchStatusFor(confidence, i.sampleTier, internallyConsistent),
      doesNotImplementNow: true,
    });
  }
  return out;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildAdaptiveGateIntelligenceReport(
  records: StrategyExperienceRecord[],
  opts: AdaptiveGateIntelligenceInput = {},
  now: Date = new Date(),
): AdaptiveGateIntelligenceReport {
  const generatedAt = now.toISOString();
  const evidenceEra: AdaptiveGateEvidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const filtered = filterByEra(records, evidenceEra);
  const total = filtered.length;
  const coverageProvenance = buildAdaptiveGateCoverageProvenanceReport(opts.positions ?? [], { evidenceEra, records: filtered });

  const baseline = baselineOf(filtered);

  // Context coverage
  const coverageByDim = new Map<AdaptiveGateDimension, number>();
  const contextCoverage: Array<{ dimension: AdaptiveGateDimension; populatedCount: number; coveragePct: number }> = [];
  for (const def of DIMENSION_DERIVERS) {
    const populated = total === 0 ? 0 : filtered.filter((r) => def.derive(r) !== null).length;
    coverageByDim.set(def.dimension, populated);
    contextCoverage.push({
      dimension: def.dimension,
      populatedCount: populated,
      coveragePct: total === 0 ? 0 : r4(populated / total),
    });
  }

  const coveragePctFor = (dimension: AdaptiveGateDimension): number =>
    contextCoverage.find((c) => c.dimension === dimension)?.coveragePct ?? 0;

  // Dimension summaries
  const dimensionSummaries: GateDimensionSummary[] = [];
  for (const def of DIMENSION_DERIVERS) {
    const populated = coverageByDim.get(def.dimension) ?? 0;
    const coveragePct = total === 0 ? 0 : populated / total;
    const groups = new Map<string, StrategyExperienceRecord[]>();
    for (const rec of filtered) {
      const bucket = def.derive(rec);
      if (bucket === null) continue;
      const list = groups.get(bucket) ?? [];
      list.push(rec);
      groups.set(bucket, list);
    }
    const bucketAssessments: GateConditionAssessment[] = [];
    for (const [bucket, list] of groups) {
      bucketAssessments.push(buildBucketAssessment(def.dimension, bucket, list, baseline));
    }
    bucketAssessments.sort((a, b) => b.closedCount - a.closedCount);

    const meaningfulBucketsCount = bucketAssessments.filter((b) => b.closedCount >= 5).length;
    const verdict = dimensionVerdictOf(coveragePct, bucketAssessments);
    const notes: string[] = [];
    if (coveragePct < 0.1) {
      notes.push(`Coverage is below 10% (${(coveragePct * 100).toFixed(0)}%); dimension surfaced as INSUFFICIENT_COVERAGE.`);
    } else if (coveragePct < 0.25) {
      notes.push(`Coverage is below 25% (${(coveragePct * 100).toFixed(0)}%); dimension surfaced as INSUFFICIENT_COVERAGE.`);
    }
    if (bucketAssessments.length === 0) notes.push("No populated buckets for this dimension yet.");

    dimensionSummaries.push({
      dimension: def.dimension,
      coveragePct: r4(coveragePct),
      distinctBucketsObserved: bucketAssessments.length,
      meaningfulBucketsCount,
      dimensionVerdict: verdict,
      buckets: bucketAssessments,
      notes,
    });
  }

  // Top supportive / top harmful across all dimensions
  const allBuckets: GateConditionAssessment[] = dimensionSummaries.flatMap((d) => d.buckets);
  const scoreFor = (b: GateConditionAssessment): number =>
    ((b.performanceDeltaVsBaseline.netAvgR ?? 0)) * b.sampleWeight;

  const candidateSupportive = allBuckets.filter(
    (b) =>
      b.localGateSignal === "SUPPORTIVE_EARLY" ||
      b.localGateSignal === "SUPPORTIVE_WATCHABLE",
  );
  const candidateHarmful = allBuckets.filter(
    (b) =>
      b.localGateSignal === "HARMFUL_EARLY" ||
      b.localGateSignal === "HARMFUL_WATCHABLE",
  );

  const topSupportiveConditions = [...candidateSupportive]
    .sort((a, b) => scoreFor(b) - scoreFor(a))
    .slice(0, 5);
  const topHarmfulConditions = [...candidateHarmful]
    .sort((a, b) => scoreFor(a) - scoreFor(b))
    .slice(0, 5);

  // Interactions
  const interactionDefs = buildInteractionDefinitions(coverageByDim);
  const interactions = interactionDefs.map((def) => buildInteractionAssessment(def, filtered, baseline));
  interactions.sort((a, b) => b.closedCount - a.closedCount);

  // Patch hypotheses: generate up to 8 total, ordered by sample size (proxy for confidence).
  const hypothesesFromDims = dimensionSummaries.flatMap((d) =>
    buildPatchHypothesesFromBuckets(d.buckets, d.dimension),
  );
  const hypothesesFromInter = buildPatchHypothesesFromInteractions(interactions);
  const allHypotheses = [...hypothesesFromDims, ...hypothesesFromInter];
  // Order: READY_FOR_PATCH_DISCUSSION > AUDIT_DEEPER > WATCH, then by confidence
  const statusRank = (s: PatchStatus): number =>
    s === "READY_FOR_PATCH_DISCUSSION" ? 0 : s === "AUDIT_DEEPER" ? 1 : 2;
  const confRank = (c: AdaptiveConfidenceTier): number =>
    c === "HIGH" ? 0 : c === "MEDIUM" ? 1 : 2;
  allHypotheses.sort((a, b) => {
    const sd = statusRank(a.patchStatus) - statusRank(b.patchStatus);
    if (sd !== 0) return sd;
    return confRank(a.confidence) - confRank(b.confidence);
  });
  const patchHypotheses = allHypotheses.slice(0, 8);

  // Readiness: ALWAYS readyForGateInfluence = false in Phase 2C.1.
  const readinessReasons: string[] = [
    "Phase 2C.1 is advisory-only; this engine does not influence ranking, routing, promotion, execution, stops, TPs, live readiness, caps, or universe.",
  ];
  const anyEvaluable = allBuckets.some((b) => b.sampleTier === "EVALUABLE");
  const anyWatchable = allBuckets.some((b) => b.sampleTier === "WATCHABLE" || b.sampleTier === "EVALUABLE");
  if (!anyWatchable) {
    readinessReasons.push("No gate-dimension bucket has reached WATCHABLE (15+) sample tier yet.");
  }
  if (!anyEvaluable) {
    readinessReasons.push("No gate-dimension bucket has reached EVALUABLE (30+) sample tier yet.");
  }
  const anyEvaluableInter = interactions.some((i) => i.sampleTier === "EVALUABLE");
  if (!anyEvaluableInter) {
    readinessReasons.push("No interaction has reached EVALUABLE (30+) sample tier yet.");
  }
  readinessReasons.push(
    "Phase 2C.2 promotion requires >=30 closes per condition, stability across recent slices, non-contradiction with symbol-route suitability, and multi-factor confirmation.",
  );

  const readiness: AdaptiveGateReadiness = {
    advisoryEngineReady: true,
    readyForGateInfluence: false,
    reasons: readinessReasons,
  };

  // Reporting-only: conditional alpha stability monitor (Phase 2C.1 extension)
  const conditionalAlphaStability = computeConditionalAlphaStability(filtered);

  // Reporting-only: top-contributor fingerprint V0 advisory profile
  const topContributorFingerprint = buildTopContributorFingerprintReport(filtered);

  return {
    generatedAt,
    evidenceEra,
    totalResolvedExperienceRecords: total,
    usableRecordsForGateAnalysis: total,
    metadata: {
      resolvedExperienceRecordCount: total,
      usableRecordCount: total,
    },
    baseline: {
      ...baseline,
      netAvgR: baseline.netAvgR !== null ? r4(baseline.netAvgR) : null,
      grossAvgR: baseline.grossAvgR !== null ? r4(baseline.grossAvgR) : null,
      profitFactor: baseline.profitFactor !== null ? r2(baseline.profitFactor) : null,
      winRate: baseline.winRate,
      tp1ProfitableRate: baseline.tp1ProfitableRate,
      slRate: baseline.slRate,
    },
    contextCoverage,
    contextCoverageSummary: {
      marketRegimeCoverage: coveragePctFor("MARKET_REGIME"),
      selectedKronosBiasCoverage: coveragePctFor("KRONOS_ALIGNMENT"),
      kronosAlignmentCoverage: coveragePctFor("KRONOS_ALIGNMENT"),
      whaleAgreementCoverage: coveragePctFor("WHALE_ALIGNMENT"),
      sentimentCoverage: coveragePctFor("SENTIMENT_BUCKET"),
      fearGreedCoverage: coveragePctFor("FEAR_GREED_BUCKET"),
      horizonConflictCoverage: coveragePctFor("HORIZON_CONFLICT"),
      sourceConflictCoverage: coveragePctFor("SOURCE_CONFLICT"),
    },
    dimensionSummaries,
    topSupportiveConditions,
    topHarmfulConditions,
    interactions,
    interactionAssessments: interactions,
    coverageProvenance,
    patchHypotheses,
    readiness,
    conditionalAlphaStability,
    topContributorFingerprint,
    notes: [
      "Adaptive Gate Controller Intelligence is read-only and advisory. It does not change ranking, routing, promotion, execution, stops, TPs, live readiness, trade caps, or universe rotation.",
      "Sample tiers: EMPTY=0, TOO_EARLY=1-4, EARLY=5-14, WATCHABLE=15-29, EVALUABLE=30+ closes.",
      "Meaningful-delta thresholds vs baseline: netAvgR +/-0.15R, profitFactor +/-0.15, slRate +/-0.07 (7pp).",
      "Dimensions with <25% coverage or <2 meaningful buckets are surfaced as INSUFFICIENT_COVERAGE so partial-data dimensions cannot push conclusions.",
      "Every patch hypothesis declares doesNotImplementNow=true. Promotion to behavior change is gated to Phase 2C.2 and requires multi-factor corroboration.",
    ],
  };
}

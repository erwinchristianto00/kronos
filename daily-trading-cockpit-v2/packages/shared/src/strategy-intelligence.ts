import type {
  Candidate,
  Direction,
  ExecutionEntryVariant,
  FinalStatus,
  FibonacciLevels,
  ProfitRouteMode,
  ProfitRouteReasonCode,
  ShadowCloseReason,
  ShadowPosition,
  ShadowPositionVariant,
  SignalFamily,
  TradePlanSnapshot,
  TrendLabel,
  VariantSelectionSnapshot,
} from "./types.js";

export const STRATEGY_CONTEXT_SCHEMA_VERSION = 1;
export const STRATEGY_OUTCOME_SCHEMA_VERSION = 1;

export type WinnerLabel = "WIN" | "LOSS" | "BREAKEVEN";

/**
 * Phase 2 Influence Level — describes how deeply an intelligence signal affects
 * trading behavior.
 *
 * - REPORT_ONLY: signal is computed and surfaced in reports only.
 * - SOFT_INFLUENCE: signal adjusts advisory scoring but does not block execution.
 * - OPERATIVE_SHADOW_INFLUENCE: signal blocks shadow observation admission
 *   (lane-specific suppression); does not affect live trading.
 * - HARD_BEHAVIOR_INFLUENCE: signal gates live execution directly.
 */
export type Phase2InfluenceLevel =
  | "REPORT_ONLY"
  | "SOFT_INFLUENCE"
  | "OPERATIVE_SHADOW_INFLUENCE"
  | "HARD_BEHAVIOR_INFLUENCE";
export type StrategyEvidenceSampleTier = "EMPTY" | "EARLY" | "SMALL" | "WATCHABLE" | "USABLE";
export type StrategyEvidenceVerdict =
  | "PROMISING_EARLY"
  | "WATCHABLE"
  | "TOXIC_EARLY"
  | "MIXED"
  | "INSUFFICIENT_SAMPLE";
export type StrategyEvidenceGroupKind =
  | "SYMBOL_DIRECTION_ROUTE"
  | "SYMBOL_DIRECTION_ROUTE_REGIME"
  | "ROUTE_REGIME"
  | "SYMBOL_DIRECTION"
  | "SYMBOL";

export const ADAPTIVE_REGIME_GATE_OVERLAY_POLICY_VERSION = "regime-shadow-overlay-v1" as const;

export type AdaptiveRegimeGateOverlayPolicyId =
  | "EXCLUDE_BULLISH_EXPANSION_V1"
  | "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1"
  | "EXCLUDE_BULLISH_EXPANSION_LONG_V1";

export type AdaptiveRegimeGateOverlayAdvisoryDecision =
  | "WOULD_INCLUDE"
  | "WOULD_EXCLUDE"
  | "NOT_APPLICABLE"
  | "INSUFFICIENT_CONTEXT";

export type AdaptiveRegimeGateOverlaySupportLabel =
  | "REGIME_SUPPORTED"
  | "REGIME_RISKY"
  | "REGIME_NEUTRAL"
  | "UNKNOWN";

export interface AdaptiveRegimeGateOverlayAssessment {
  policyId: AdaptiveRegimeGateOverlayPolicyId;
  policyVersion: typeof ADAPTIVE_REGIME_GATE_OVERLAY_POLICY_VERSION;
  policyLabel: string;
  advisoryDecision: AdaptiveRegimeGateOverlayAdvisoryDecision;
  supportLabel: AdaptiveRegimeGateOverlaySupportLabel;
  reasonCodes: string[];
  explanation: string;
  evaluatedAt: string | null;
  marketRegimeAtSelection: string | null;
  directionAtSelection: Exclude<Direction, "NEUTRAL"> | null;
}

export interface StrategyContextSnapshot {
  schemaVersion: typeof STRATEGY_CONTEXT_SCHEMA_VERSION;
  symbol: string;
  direction: Exclude<Direction, "NEUTRAL">;
  scanTimestamp: string | null;
  evidenceEra?: VariantSelectionSnapshot["evidenceEra"] | null;
  decisionPolicyVersion?: string | null;

  selectedEntryVariant?: ExecutionEntryVariant | null;
  selectedExitVariant?: ShadowPositionVariant | null;
  routeMode?: ProfitRouteMode | null;
  primaryProfitEligible?: boolean | null;
  routeReasonCodes?: ProfitRouteReasonCode[];
  selectionSource?: VariantSelectionSnapshot["selectionSource"] | null;
  routeScore?: number | null;
  variantConfidenceTier?: VariantSelectionSnapshot["variantConfidenceTier"] | null;

  rawExpectedGrossR?: number | null;
  rawExpectedNetR?: number | null;
  calibratedExpectedNetR?: number | null;
  calibrationVerdict?: VariantSelectionSnapshot["calibrationVerdict"] | null;
  calibrationConfidence?: VariantSelectionSnapshot["calibrationConfidence"] | null;
  calibrationSourceUsed?: VariantSelectionSnapshot["calibrationSourceUsed"] | null;
  calibrationDiagnosisCodes?: string[];

  status?: FinalStatus | null;
  opportunityScore?: number | null;
  confidenceScore?: number | null;
  dangerScore?: number | null;
  edgeScore?: number | null;
  directionGap?: number | null;

  entryPrice?: number | null;
  plannedEntry?: number | null;
  plannedEntryPrice?: number | null;
  entryZoneLow?: number | null;
  entryZoneHigh?: number | null;
  stopPrice?: number | null;
  tp1Price?: number | null;
  tp2Price?: number | null;
  stopDistanceBps?: number | null;
  riskReward?: number | null;
  costR?: number | null;
  spreadR?: number | null;
  feeSlippageR?: number | null;
  entryDriftPctOfZone?: number | null;
  entryDriftAtr?: number | null;
  chaseRisk?: VariantSelectionSnapshot["chaseRisk"] | null;

  trend5m?: TrendLabel | null;
  trend15m?: TrendLabel | null;
  trend1h?: TrendLabel | null;
  trendStackLabel?: string | null;
  directionalAlignmentLabel?: "ALIGNED" | "MIXED" | "CONFLICTED" | "UNKNOWN" | null;
  entryPlaybook?: string | null;
  setupType?: string | null;
  structureNarrative?: string | null;
  routeFamilyLabel?: string | null;
  support5m?: number | null;
  resistance5m?: number | null;
  vwap5m?: number | null;
  ema20_5m?: number | null;
  recentSwingHigh5m?: number | null;
  recentSwingLow5m?: number | null;
  fibonacci?: FibonacciLevels | null;

  kronosBias1h?: Direction | "UNAVAILABLE" | null;
  kronosBias4h?: Direction | "UNAVAILABLE" | null;
  selectedKronosBias?: Direction | "UNAVAILABLE" | null;
  horizonConflict?: boolean | null;
  /**
   * Exact live scanner source-conflict flag (packages/shared/src/scan.ts::hasSourceConflict).
   * Semantics: Kronos LONG + Whale BEARISH OR Kronos SHORT + Whale BULLISH.
   * Distinct from the analytics proxy in evidence-consensus.ts::deriveSourceConflict.
   * null when candidate was not available at snapshot time (position sourced from legacy data).
   */
  liveSourceConflict?: boolean | null;
  kronosConfidenceBucket?: "STRONG" | "MEDIUM" | "WEAK" | null;
  expectedReturn1h?: number | null;
  expectedReturn4h?: number | null;
  whaleDirection?: string | null;
  whaleBias?: string | null;
  whaleAgreement?: "AGREES" | "DISAGREES" | "UNAVAILABLE" | null;
  whaleAvailability?: boolean | null;
  sentimentBucket?: string | null;
  sentimentSummary?: string | null;
  fearGreed?: number | null;
  fearGreedValue?: number | null;
  fearGreedBucket?: string | null;
  marketRegime?: string | null;
  regimeConfidence?: number | null;
  btcContext?: string | null;
  btcTrendState?: string | null;
  marketBreadthLongShortBalance?: number | null;
  spreadPercent?: number | null;
  volumeRatio5m?: number | null;
  volatilityAtrPercent5m?: number | null;
  adaptiveRegimeGateOverlayAssessments?: AdaptiveRegimeGateOverlayAssessment[];

  /** Post-fill facts are optional and must not be treated as selection-time inputs. */
  postFill?: {
    actualEntryPrice?: number | null;
    entryFilledAt?: string | null;
    entryDriftPctOfZone?: number | null;
    entryDriftAtr?: number | null;
  };
}

export interface ResolvedTradeOutcomeSnapshot {
  schemaVersion: typeof STRATEGY_OUTCOME_SCHEMA_VERSION;
  positionId: string;
  symbol: string;
  direction: Exclude<Direction, "NEUTRAL">;
  selectedEntryVariant?: ExecutionEntryVariant | null;
  selectedExitVariant?: ShadowPositionVariant | null;
  evidenceEra?: VariantSelectionSnapshot["evidenceEra"] | null;
  decisionPolicyVersion?: string | null;
  openedAt?: string | null;
  closedAt?: string | null;
  holdingDurationMinutes?: number | null;
  fillStatus?: "FILLED" | "NO_FILL" | "PENDING_ENTRY" | "UNKNOWN";
  closeReason?: ShadowCloseReason | null;
  realizedGrossR?: number | null;
  realizedNetR?: number | null;
  winnerLabel: WinnerLabel;
  tp1Hit?: boolean | null;
  tp2Hit?: boolean | null;
  slHit?: boolean | null;
  mfeR?: number | null;
  maeR?: number | null;
  maxFavorableExcursionR?: number | null;
  maxAdverseExcursionR?: number | null;
  maxFavorablePrice?: number | null;
  maxAdversePrice?: number | null;
  maxFavorableAt?: string | null;
  maxAdverseAt?: string | null;
  realizedPathAvailable?: boolean;
  actualEntryPrice?: number | null;
  actualExitPrice?: number | null;
  actualStopDistanceBps?: number | null;
  costR?: number | null;
  spreadR?: number | null;
  feeSlippageR?: number | null;
}

export interface StrategyExperienceRecord {
  context: StrategyContextSnapshot;
  outcome: ResolvedTradeOutcomeSnapshot;
}

export interface StrategyEvidenceRow {
  groupKind: StrategyEvidenceGroupKind;
  key: string;
  symbol?: string;
  direction?: Exclude<Direction, "NEUTRAL">;
  selectedEntryVariant?: ExecutionEntryVariant | null;
  selectedExitVariant?: ShadowPositionVariant | null;
  routeCombo?: string;
  marketRegime?: string | null;
  closedCount: number;
  winRate: number | null;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  slRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  avgStopDistanceBps: number | null;
  avgRiskReward: number | null;
  avgCalibratedExpectedNetR: number | null;
  calibrationError: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
  maeToMfeRatio: number | null;
  horizonConflictRate: number | null;
  whaleAgreementRate: number | null;
  dominantCloseReason: ShadowCloseReason | null;
  sampleTier: StrategyEvidenceSampleTier;
  verdict: StrategyEvidenceVerdict;
}

export interface StrategyEvidenceTable {
  bySymbolDirectionRoute: StrategyEvidenceRow[];
  bySymbolDirectionRouteRegime: StrategyEvidenceRow[];
  byRouteRegime: StrategyEvidenceRow[];
  bySymbolDirection: StrategyEvidenceRow[];
  bySymbol: StrategyEvidenceRow[];
  allRows: StrategyEvidenceRow[];
}

export type FieldAvailability = "FULL" | "PARTIAL" | "MISSING";

export interface StrategyMissingFieldAudit {
  fields: Record<string, FieldAvailability>;
  completeness: Record<string, number>;
  fullyAvailable: string[];
  partiallyAvailable: string[];
  missing: string[];
}

export interface StrategyEngineReadinessDetail {
  ready: boolean;
  reasonsBlocking: string[];
  partialReadinessNotes: string[];
}

export interface StrategyIntelligenceFoundationReport {
  metadata: {
    generatedAt: string;
    evidenceEraScopeUsed: string[];
    contextSnapshotCount: number;
    resolvedExperienceRecordCount: number;
  };
  missingFieldAudit: StrategyMissingFieldAudit;
  strategyEvidenceTable: {
    topPromisingSymbolRoutePairs: StrategyEvidenceRow[];
    topToxicSymbolRoutePairs: StrategyEvidenceRow[];
    topRegimeSensitivePairs: StrategyEvidenceRow[];
    topRouteCombosOverall: StrategyEvidenceRow[];
  };
  dataReadiness: {
    readyForSymbolRouteEngine: boolean;
    readyForAdaptiveGateController: boolean;
    readyForTechnicalStopTpEngine: boolean;
    readyForUniverseRotation: boolean;
    reasons: string[];
    symbolRouteEngine: StrategyEngineReadinessDetail;
    adaptiveGateController: StrategyEngineReadinessDetail;
    technicalStopTpEngine: StrategyEngineReadinessDetail;
    universeRotation: StrategyEngineReadinessDetail;
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function avg(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return round4(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function routeCombo(entry?: string | null, exit?: string | null): string {
  return `${entry ?? "UNKNOWN_ENTRY"} + ${exit ?? "UNKNOWN_EXIT"}`;
}

function whaleAgreement(direction: Exclude<Direction, "NEUTRAL">, signal: string | null | undefined): StrategyContextSnapshot["whaleAgreement"] {
  if (!signal || signal === "UNAVAILABLE" || signal === "NEUTRAL") return "UNAVAILABLE";
  if ((direction === "LONG" && signal === "BULLISH") || (direction === "SHORT" && signal === "BEARISH")) return "AGREES";
  return "DISAGREES";
}

function directionGapFrom(candidate: Candidate): number | null {
  return finiteOrNull(Math.abs(candidate.longScore - candidate.shortScore));
}

function trendStackLabel(trends: Array<TrendLabel | null | undefined>): string | null {
  const labels = trends.filter((trend): trend is TrendLabel => Boolean(trend));
  if (labels.length === 0) return null;
  if (labels.every((label) => label === labels[0])) return labels[0];
  return labels.join("/");
}

function directionalAlignmentLabel(direction: Exclude<Direction, "NEUTRAL">, trends: Array<TrendLabel | null | undefined>): StrategyContextSnapshot["directionalAlignmentLabel"] {
  const labels = trends.filter((trend): trend is TrendLabel => Boolean(trend));
  if (labels.length === 0) return "UNKNOWN";
  const alignedTrend = direction === "LONG" ? "BULLISH" : "BEARISH";
  const oppositeTrend = direction === "LONG" ? "BEARISH" : "BULLISH";
  const aligned = labels.filter((label) => label === alignedTrend).length;
  const opposed = labels.filter((label) => label === oppositeTrend).length;
  if (aligned === labels.length) return "ALIGNED";
  if (opposed > aligned) return "CONFLICTED";
  return "MIXED";
}

export function normalizeStrategyMarketRegimeLabel(marketRegime: string | null | undefined): string | null {
  if (!marketRegime) return null;
  const upper = String(marketRegime).toUpperCase();
  if (upper.includes("BULL")) return "BULLISH_EXPANSION";
  if (upper.includes("BEAR")) return "BEARISH_EXPANSION";
  if (upper.includes("SIDE") || upper.includes("RANGE") || upper.includes("CHOP")) return "SIDEWAYS";
  if (upper.includes("MIX") || upper.includes("ROTATION")) return "MIXED";
  return upper;
}

function regimeSupportLabel(
  normalizedRegime: string | null,
  direction: Exclude<Direction, "NEUTRAL"> | null,
): AdaptiveRegimeGateOverlaySupportLabel {
  if (!normalizedRegime || !direction) return "UNKNOWN";
  if (normalizedRegime === "BEARISH_EXPANSION" && direction === "SHORT") return "REGIME_SUPPORTED";
  if (normalizedRegime === "BULLISH_EXPANSION" && direction === "LONG") return "REGIME_RISKY";
  if (normalizedRegime === "BULLISH_EXPANSION") return "REGIME_RISKY";
  return "REGIME_NEUTRAL";
}

export function buildAdaptiveRegimeGateOverlayAssessments(input: {
  marketRegime?: string | null;
  direction?: Exclude<Direction, "NEUTRAL"> | null;
  evaluatedAt?: string | null;
}): AdaptiveRegimeGateOverlayAssessment[] {
  const normalizedRegime = normalizeStrategyMarketRegimeLabel(input.marketRegime);
  const direction = input.direction ?? null;
  const evaluatedAt = input.evaluatedAt ?? null;
  const common = {
    policyVersion: ADAPTIVE_REGIME_GATE_OVERLAY_POLICY_VERSION,
    evaluatedAt,
    marketRegimeAtSelection: normalizedRegime,
    directionAtSelection: direction,
  };

  if (!normalizedRegime) {
    return [
      {
        policyId: "EXCLUDE_BULLISH_EXPANSION_V1",
        policyLabel: "Exclude bullish expansion",
        advisoryDecision: "INSUFFICIENT_CONTEXT",
        supportLabel: "UNKNOWN",
        reasonCodes: ["MISSING_MARKET_REGIME"],
        explanation: "Overlay could not evaluate because market regime was unavailable at selection time.",
        ...common,
      },
      {
        policyId: "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1",
        policyLabel: "Keep only bearish expansion and short",
        advisoryDecision: "INSUFFICIENT_CONTEXT",
        supportLabel: "UNKNOWN",
        reasonCodes: ["MISSING_MARKET_REGIME"],
        explanation: "Overlay could not evaluate because market regime was unavailable at selection time.",
        ...common,
      },
      {
        policyId: "EXCLUDE_BULLISH_EXPANSION_LONG_V1",
        policyLabel: "Exclude bullish expansion long",
        advisoryDecision: "INSUFFICIENT_CONTEXT",
        supportLabel: "UNKNOWN",
        reasonCodes: ["MISSING_MARKET_REGIME"],
        explanation: "Overlay could not evaluate because market regime was unavailable at selection time.",
        ...common,
      },
    ];
  }

  return [
    {
      policyId: "EXCLUDE_BULLISH_EXPANSION_V1",
      policyLabel: "Exclude bullish expansion",
      advisoryDecision: normalizedRegime === "BULLISH_EXPANSION" ? "WOULD_EXCLUDE" : "WOULD_INCLUDE",
      supportLabel: normalizedRegime === "BULLISH_EXPANSION"
        ? "REGIME_RISKY"
        : normalizedRegime === "BEARISH_EXPANSION"
          ? "REGIME_SUPPORTED"
          : "REGIME_NEUTRAL",
      reasonCodes: normalizedRegime === "BULLISH_EXPANSION"
        ? ["BULLISH_EXPANSION_HISTORICALLY_RISKY"]
        : normalizedRegime === "BEARISH_EXPANSION"
          ? ["NON_BULLISH_REGIME_ALLOWED", "BEARISH_EXPANSION_CONTEXT"]
          : ["NON_BULLISH_REGIME_ALLOWED"],
      explanation: normalizedRegime === "BULLISH_EXPANSION"
        ? "Historical regime analysis flagged bullish expansion as a risky context, so this advisory policy would exclude the trade."
        : "This advisory policy only excludes bullish expansion, so the trade would remain included.",
      ...common,
    },
    {
      policyId: "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1",
      policyLabel: "Keep only bearish expansion and short",
      advisoryDecision: !direction
        ? "INSUFFICIENT_CONTEXT"
        : normalizedRegime === "BEARISH_EXPANSION" && direction === "SHORT"
          ? "WOULD_INCLUDE"
          : "WOULD_EXCLUDE",
      supportLabel: !direction
        ? "UNKNOWN"
        : normalizedRegime === "BEARISH_EXPANSION" && direction === "SHORT"
          ? "REGIME_SUPPORTED"
          : regimeSupportLabel(normalizedRegime, direction),
      reasonCodes: !direction
        ? ["MISSING_DIRECTION"]
        : normalizedRegime === "BEARISH_EXPANSION" && direction === "SHORT"
          ? ["BEARISH_EXPANSION_SHORT_ALLOWED"]
          : normalizedRegime === "BULLISH_EXPANSION"
            ? ["POLICY_REQUIRES_BEARISH_SHORT", "BULLISH_EXPANSION_OUT_OF_POLICY"]
            : ["POLICY_REQUIRES_BEARISH_SHORT"],
      explanation: !direction
        ? "Overlay could not evaluate because direction was unavailable at selection time."
        : normalizedRegime === "BEARISH_EXPANSION" && direction === "SHORT"
          ? "This is the strongest historical regime slice, so the advisory policy would include the trade."
          : "This advisory policy forward-tests only bearish expansion plus short setups, so the trade would be excluded.",
      ...common,
    },
    {
      policyId: "EXCLUDE_BULLISH_EXPANSION_LONG_V1",
      policyLabel: "Exclude bullish expansion long",
      advisoryDecision: !direction
        ? "INSUFFICIENT_CONTEXT"
        : normalizedRegime === "BULLISH_EXPANSION" && direction === "LONG"
          ? "WOULD_EXCLUDE"
          : "WOULD_INCLUDE",
      supportLabel: !direction
        ? "UNKNOWN"
        : normalizedRegime === "BULLISH_EXPANSION" && direction === "LONG"
          ? "REGIME_RISKY"
          : normalizedRegime === "BEARISH_EXPANSION" && direction === "SHORT"
            ? "REGIME_SUPPORTED"
            : "REGIME_NEUTRAL",
      reasonCodes: !direction
        ? ["MISSING_DIRECTION"]
        : normalizedRegime === "BULLISH_EXPANSION" && direction === "LONG"
          ? ["BULLISH_EXPANSION_LONG_HISTORICALLY_RISKY"]
          : ["SOFT_BULLISH_LONG_EXCLUSION_NOT_TRIGGERED"],
      explanation: !direction
        ? "Overlay could not evaluate because direction was unavailable at selection time."
        : normalizedRegime === "BULLISH_EXPANSION" && direction === "LONG"
          ? "This softer advisory policy only excludes bullish expansion longs, so the trade would be excluded."
          : "This softer advisory policy would keep the trade included.",
      ...common,
    },
  ];
}

export function buildStrategyContextSnapshot(input: {
  candidate?: Candidate | null;
  selectedExecutionPlan?: VariantSelectionSnapshot | null;
  position?: ShadowPosition | null;
  tradePlan?: TradePlanSnapshot | null;
  signalFamily?: SignalFamily | null;
  scanTimestamp?: string | null;
  marketRegime?: string | null;
}): StrategyContextSnapshot | null {
  const candidate = input.candidate ?? null;
  const position = input.position ?? null;
  const plan = input.selectedExecutionPlan ?? candidate?.selectedExecutionPlan ?? position?.variantSelection ?? null;
  const symbol = candidate?.symbol ?? position?.symbol ?? null;
  const direction = (candidate?.finalDirection ?? position?.direction ?? candidate?.direction ?? null) as Exclude<Direction, "NEUTRAL"> | null;
  if (!symbol || !direction) return null;

  const five = candidate?.indicators?.fiveMinute;
  const fifteen = candidate?.indicators?.fifteenMinute;
  const oneHour = candidate?.indicators?.oneHour;
  const tradePlan = input.tradePlan ?? position?.tradePlan;
  const entryZone = candidate?.entryZone ?? position?.entryZone ?? null;
  const marketRegime = input.marketRegime ?? position?.marketRegime ?? null;
  const adaptiveRegimeGateOverlayAssessments = candidate || input.selectedExecutionPlan || input.scanTimestamp
    ? buildAdaptiveRegimeGateOverlayAssessments({
        marketRegime,
        direction,
        evaluatedAt: input.scanTimestamp ?? position?.scannedAt ?? null,
      })
    : undefined;

  return {
    schemaVersion: STRATEGY_CONTEXT_SCHEMA_VERSION,
    symbol,
    direction,
    scanTimestamp: input.scanTimestamp ?? position?.scannedAt ?? null,
    evidenceEra: plan?.evidenceEra ?? null,
    decisionPolicyVersion: plan?.decisionPolicyVersion ?? null,
    selectedEntryVariant: plan?.selectedEntryVariant ?? position?.selectedEntryVariant ?? null,
    selectedExitVariant: plan?.selectedExitVariant ?? position?.selectedExitVariant ?? null,
    routeMode: plan?.routeMode ?? null,
    primaryProfitEligible: plan?.primaryProfitEligible ?? null,
    routeReasonCodes: [...(plan?.routeReasonCodes ?? [])],
    selectionSource: plan?.selectionSource ?? null,
    routeScore: finiteOrNull(plan?.routeScore),
    variantConfidenceTier: plan?.variantConfidenceTier ?? null,
    rawExpectedGrossR: finiteOrNull(plan?.expectedGrossR),
    rawExpectedNetR: finiteOrNull(plan?.rawExpectedNetR ?? plan?.expectedNetR),
    calibratedExpectedNetR: finiteOrNull(plan?.calibratedExpectedNetR),
    calibrationVerdict: plan?.calibrationVerdict ?? null,
    calibrationConfidence: plan?.calibrationConfidence ?? null,
    calibrationSourceUsed: plan?.calibrationSourceUsed ?? null,
    calibrationDiagnosisCodes: [...(plan?.calibrationDiagnosisCodes ?? [])],
    status: candidate?.finalStatus ?? position?.latestStatus ?? null,
    opportunityScore: finiteOrNull(candidate?.opportunityScore ?? position?.latestScore),
    confidenceScore: finiteOrNull(candidate?.confidence),
    dangerScore: finiteOrNull(candidate?.dangerScore ?? position?.dangerScore),
    edgeScore: null,
    directionGap: candidate ? directionGapFrom(candidate) : null,
    entryPrice: finiteOrNull(position?.entryPrice ?? five?.latestClose),
    plannedEntry: finiteOrNull(position?.entryPrice ?? five?.latestClose),
    plannedEntryPrice: finiteOrNull(position?.entryPrice ?? five?.latestClose),
    entryZoneLow: finiteOrNull(entryZone?.[0]),
    entryZoneHigh: finiteOrNull(entryZone?.[1]),
    stopPrice: finiteOrNull(position?.stopLoss ?? candidate?.stopLoss ?? tradePlan?.stopLoss),
    tp1Price: finiteOrNull(position?.tp1 ?? candidate?.takeProfits?.tp1 ?? tradePlan?.takeProfit1),
    tp2Price: finiteOrNull(position?.tp2 ?? candidate?.takeProfits?.tp2 ?? tradePlan?.takeProfit2),
    stopDistanceBps: finiteOrNull(position?.stopDistanceBps ?? plan?.stopDistanceBps),
    riskReward: finiteOrNull(position?.riskReward ?? candidate?.riskReward),
    costR: finiteOrNull(position?.costR ?? plan?.costR),
    spreadR: finiteOrNull(position?.spreadR ?? plan?.spreadR),
    feeSlippageR: finiteOrNull(position?.feeSlippageR ?? plan?.feeSlippageR),
    entryDriftPctOfZone: finiteOrNull(plan?.entryDriftPct),
    entryDriftAtr: finiteOrNull(plan?.entryDriftAtr),
    chaseRisk: plan?.chaseRisk ?? null,
    trend5m: five?.trend ?? null,
    trend15m: fifteen?.trend ?? null,
    trend1h: oneHour?.trend ?? null,
    trendStackLabel: trendStackLabel([five?.trend, fifteen?.trend, oneHour?.trend]),
    directionalAlignmentLabel: directionalAlignmentLabel(direction, [five?.trend, fifteen?.trend, oneHour?.trend]),
    entryPlaybook: tradePlan?.entryPlaybook ?? null,
    setupType: input.signalFamily ?? position?.signalFamily ?? null,
    structureNarrative: candidate?.reason?.join(" | ") ?? position?.latestReason?.join(" | ") ?? null,
    routeFamilyLabel: plan ? routeCombo(plan.selectedEntryVariant, plan.selectedExitVariant) : null,
    support5m: finiteOrNull(five?.support),
    resistance5m: finiteOrNull(five?.resistance),
    vwap5m: finiteOrNull(five?.vwap),
    ema20_5m: finiteOrNull(five?.ema20),
    recentSwingHigh5m: finiteOrNull(five?.recentSwingHigh),
    recentSwingLow5m: finiteOrNull(five?.recentSwingLow),
    fibonacci: candidate?.fibonacci ?? null,
    kronosBias1h: candidate?.kronosBias1h ?? null,
    kronosBias4h: candidate?.kronosBias4h ?? null,
    selectedKronosBias: candidate?.selectedKronosBias ?? candidate?.kronosBias ?? null,
    horizonConflict: candidate?.horizonConflict ?? null,
    liveSourceConflict: candidate?.sourceConflict ?? null,
    kronosConfidenceBucket: candidate?.kronosConfidenceBucket ?? null,
    expectedReturn1h: finiteOrNull(candidate?.expectedReturn1h),
    expectedReturn4h: finiteOrNull(candidate?.expectedReturn4h),
    whaleDirection: candidate?.whale?.signal ?? null,
    whaleBias: candidate?.whale?.signal ?? null,
    whaleAgreement: candidate ? whaleAgreement(direction, candidate.whale.signal) : null,
    whaleAvailability: candidate?.whale?.available ?? null,
    sentimentBucket: candidate?.sentiment?.signal ?? null,
    sentimentSummary: candidate?.sentiment?.reason ?? candidate?.sentiment?.source ?? null,
    fearGreed: null,
    fearGreedValue: null,
    fearGreedBucket: null,
    marketRegime,
    regimeConfidence: null,
    btcContext: null,
    btcTrendState: null,
    marketBreadthLongShortBalance: null,
    spreadPercent: finiteOrNull(position?.spreadPercent ?? candidate?.spread?.percent),
    volumeRatio5m: finiteOrNull(candidate?.volume?.volumeRatio5m ?? five?.volumeRatio),
    volatilityAtrPercent5m: finiteOrNull(five?.atrPercent),
    adaptiveRegimeGateOverlayAssessments,
    postFill: position
      ? {
          actualEntryPrice: finiteOrNull(position.entryPrice),
          entryFilledAt: position.entryFilledAt ?? null,
          entryDriftPctOfZone: finiteOrNull(plan?.entryDriftPct),
          entryDriftAtr: finiteOrNull(plan?.entryDriftAtr),
        }
      : undefined,
  };
}

function primaryClosedVariant(position: ShadowPosition) {
  return position.variants.find((variant) => variant.variant === position.selectedExitVariant && variant.state === "CLOSED")
    ?? position.variants.find((variant) => variant.state === "CLOSED")
    ?? null;
}

function winnerLabel(netR: number | null): WinnerLabel {
  if (netR === null || Math.abs(netR) < 0.0001) return "BREAKEVEN";
  return netR > 0 ? "WIN" : "LOSS";
}

function holdingMinutes(openedAt: string | null | undefined, closedAt: string | null | undefined): number | null {
  if (!openedAt || !closedAt) return null;
  const delta = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  return Number.isFinite(delta) && delta >= 0 ? round4(delta / 60_000) : null;
}

export function buildResolvedTradeOutcomeSnapshot(position: ShadowPosition): ResolvedTradeOutcomeSnapshot | null {
  const variant = primaryClosedVariant(position);
  if (!variant) return null;
  const netR = finiteOrNull(variant.realizedNetR);
  const grossR = finiteOrNull(variant.realizedGrossR);
  const openedAt = position.entryFilledAt ?? variant.openedAt ?? position.scannedAt ?? null;
  const closedAt = variant.closedAt ?? null;
  return {
    schemaVersion: STRATEGY_OUTCOME_SCHEMA_VERSION,
    positionId: position.id,
    symbol: position.symbol,
    direction: position.direction,
    selectedEntryVariant: position.selectedEntryVariant ?? position.variantSelection?.selectedEntryVariant ?? null,
    selectedExitVariant: variant.variant ?? position.selectedExitVariant ?? position.variantSelection?.selectedExitVariant ?? null,
    evidenceEra: position.variantSelection?.evidenceEra ?? null,
    decisionPolicyVersion: position.variantSelection?.decisionPolicyVersion ?? null,
    openedAt,
    closedAt,
    holdingDurationMinutes: holdingMinutes(openedAt, closedAt),
    fillStatus: variant.closeReason === "NO_FILL" ? "NO_FILL" : (position.entryState ?? "FILLED"),
    closeReason: variant.closeReason ?? null,
    realizedGrossR: grossR,
    realizedNetR: netR,
    winnerLabel: winnerLabel(netR),
    tp1Hit: variant.tp1Hit ?? null,
    tp2Hit: variant.tp2Hit ?? null,
    slHit: variant.closeReason === "SL" || variant.closeReason === "BREAKEVEN",
    // Phase 3.1: prefer per-variant excursion when available; fall back to
    // legacy position-level fields for backward compatibility on older records.
    mfeR: finiteOrNull(variant.mfeR ?? position.maxFavorableExcursionR),
    maeR: finiteOrNull(variant.maeR ?? position.maxAdverseExcursionR),
    maxFavorableExcursionR: finiteOrNull(variant.mfeR ?? position.maxFavorableExcursionR),
    maxAdverseExcursionR: finiteOrNull(variant.maeR ?? position.maxAdverseExcursionR),
    maxFavorablePrice: finiteOrNull(variant.maxFavorablePrice ?? position.maxFavorablePrice),
    maxAdversePrice: finiteOrNull(variant.maxAdversePrice ?? position.maxAdversePrice),
    maxFavorableAt: variant.maxFavorableAt ?? position.maxFavorableAt ?? null,
    maxAdverseAt: variant.maxAdverseAt ?? position.maxAdverseAt ?? null,
    realizedPathAvailable: (variant.mfeR !== null && variant.mfeR !== undefined && variant.maeR !== null && variant.maeR !== undefined)
      || (position.maxFavorableExcursionR !== null &&
        position.maxFavorableExcursionR !== undefined &&
        position.maxAdverseExcursionR !== null &&
        position.maxAdverseExcursionR !== undefined),
    actualEntryPrice: finiteOrNull(position.entryPrice),
    actualExitPrice: finiteOrNull(variant.currentPrice),
    actualStopDistanceBps: finiteOrNull(position.stopDistanceBps),
    costR: finiteOrNull(position.costR ?? position.variantSelection?.costR),
    spreadR: finiteOrNull(position.spreadR ?? position.variantSelection?.spreadR),
    feeSlippageR: finiteOrNull(position.feeSlippageR ?? position.variantSelection?.feeSlippageR),
  };
}

export function buildStrategyExperienceRecords(positions: ShadowPosition[]): StrategyExperienceRecord[] {
  const records: StrategyExperienceRecord[] = [];
  for (const position of positions) {
    const outcome = buildResolvedTradeOutcomeSnapshot(position);
    if (!outcome) continue;
    const context = position.strategyContextSnapshot ?? buildStrategyContextSnapshot({ position });
    if (!context) continue;
    records.push({ context: { ...context }, outcome: { ...outcome } });
  }
  return records;
}

function sampleTier(count: number): StrategyEvidenceSampleTier {
  if (count <= 0) return "EMPTY";
  if (count < 5) return "EARLY";
  if (count < 15) return "SMALL";
  if (count < 30) return "WATCHABLE";
  return "USABLE";
}

function verdict(count: number, netAvgR: number | null, winRate: number | null, profitFactor: number | null): StrategyEvidenceVerdict {
  if (count < 3 || netAvgR === null) return "INSUFFICIENT_SAMPLE";
  if (netAvgR <= -0.15 && (profitFactor ?? 0) < 0.75) return "TOXIC_EARLY";
  if (netAvgR >= 0.15 && (profitFactor ?? 0) >= 1.15) return count >= 15 ? "WATCHABLE" : "PROMISING_EARLY";
  if (winRate !== null && winRate >= 0.55 && netAvgR >= 0) return "WATCHABLE";
  return "MIXED";
}

function profitFactor(records: StrategyExperienceRecord[]): number | null {
  const wins = records.map((r) => r.outcome.realizedNetR).filter((r): r is number => typeof r === "number" && r > 0);
  const losses = records.map((r) => r.outcome.realizedNetR).filter((r): r is number => typeof r === "number" && r < 0);
  const winSum = wins.reduce((sum, value) => sum + value, 0);
  const lossAbs = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  if (lossAbs === 0) return winSum > 0 ? null : null;
  return round4(winSum / lossAbs);
}

function dominantCloseReason(records: StrategyExperienceRecord[]): ShadowCloseReason | null {
  const counts = new Map<ShadowCloseReason, number>();
  for (const record of records) {
    const reason = record.outcome.closeReason;
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function buildRow(kind: StrategyEvidenceGroupKind, key: string, records: StrategyExperienceRecord[], attrs: Partial<StrategyEvidenceRow>): StrategyEvidenceRow {
  const closedCount = records.length;
  const wins = records.filter((record) => (record.outcome.realizedNetR ?? 0) > 0);
  const losses = records.filter((record) => (record.outcome.realizedNetR ?? 0) < 0);
  const netAvgR = avg(records.map((record) => record.outcome.realizedNetR));
  const grossAvgR = avg(records.map((record) => record.outcome.realizedGrossR));
  const winRate = closedCount > 0 ? round4(wins.length / closedCount) : null;
  const pf = profitFactor(records);
  const avgMfeR = avg(records.map((record) => record.outcome.maxFavorableExcursionR ?? record.outcome.mfeR));
  const avgMaeR = avg(records.map((record) => record.outcome.maxAdverseExcursionR ?? record.outcome.maeR));
  const horizonKnown = records.filter((record) => record.context.horizonConflict !== null && record.context.horizonConflict !== undefined);
  const whaleKnown = records.filter((record) => record.context.whaleAgreement !== null && record.context.whaleAgreement !== undefined && record.context.whaleAgreement !== "UNAVAILABLE");
  return {
    groupKind: kind,
    key,
    closedCount,
    winRate,
    netAvgR,
    grossAvgR,
    profitFactor: pf,
    avgWinR: avg(wins.map((record) => record.outcome.realizedNetR)),
    avgLossR: avg(losses.map((record) => record.outcome.realizedNetR)),
    slRate: closedCount > 0 ? round4(records.filter((record) => record.outcome.slHit).length / closedCount) : null,
    tp1Rate: closedCount > 0 ? round4(records.filter((record) => record.outcome.tp1Hit).length / closedCount) : null,
    profitableTp1Rate: closedCount > 0 ? round4(records.filter((record) => record.outcome.tp1Hit && (record.outcome.realizedNetR ?? 0) > 0).length / closedCount) : null,
    avgStopDistanceBps: avg(records.map((record) => record.context.stopDistanceBps ?? record.outcome.actualStopDistanceBps)),
    avgRiskReward: avg(records.map((record) => record.context.riskReward)),
    avgCalibratedExpectedNetR: avg(records.map((record) => record.context.calibratedExpectedNetR)),
    calibrationError: null,
    avgMfeR,
    avgMaeR,
    maeToMfeRatio: avgMfeR !== null && avgMfeR > 0 && avgMaeR !== null ? round4(avgMaeR / avgMfeR) : null,
    horizonConflictRate: horizonKnown.length > 0 ? round4(horizonKnown.filter((record) => record.context.horizonConflict).length / horizonKnown.length) : null,
    whaleAgreementRate: whaleKnown.length > 0 ? round4(whaleKnown.filter((record) => record.context.whaleAgreement === "AGREES").length / whaleKnown.length) : null,
    dominantCloseReason: dominantCloseReason(records),
    sampleTier: sampleTier(closedCount),
    verdict: verdict(closedCount, netAvgR, winRate, pf),
    ...attrs,
  };
}

function groupedRows(kind: StrategyEvidenceGroupKind, records: StrategyExperienceRecord[], keyOf: (record: StrategyExperienceRecord) => { key: string; attrs: Partial<StrategyEvidenceRow> }): StrategyEvidenceRow[] {
  const groups = new Map<string, { attrs: Partial<StrategyEvidenceRow>; records: StrategyExperienceRecord[] }>();
  for (const record of records) {
    const { key, attrs } = keyOf(record);
    const group = groups.get(key);
    if (group) {
      group.records.push(record);
    } else {
      groups.set(key, { attrs, records: [record] });
    }
  }
  return [...groups.entries()].map(([key, group]) => buildRow(kind, key, group.records, group.attrs));
}

export function buildStrategyEvidenceTable(records: StrategyExperienceRecord[]): StrategyEvidenceTable {
  const bySymbolDirectionRoute = groupedRows("SYMBOL_DIRECTION_ROUTE", records, (record) => {
    const entry = record.context.selectedEntryVariant ?? record.outcome.selectedEntryVariant ?? null;
    const exit = record.context.selectedExitVariant ?? record.outcome.selectedExitVariant ?? null;
    return {
      key: [record.context.symbol, record.context.direction, entry ?? "UNKNOWN_ENTRY", exit ?? "UNKNOWN_EXIT"].join("|"),
      attrs: { symbol: record.context.symbol, direction: record.context.direction, selectedEntryVariant: entry, selectedExitVariant: exit, routeCombo: routeCombo(entry, exit) },
    };
  });
  const bySymbolDirectionRouteRegime = groupedRows("SYMBOL_DIRECTION_ROUTE_REGIME", records, (record) => {
    const entry = record.context.selectedEntryVariant ?? record.outcome.selectedEntryVariant ?? null;
    const exit = record.context.selectedExitVariant ?? record.outcome.selectedExitVariant ?? null;
    const regime = record.context.marketRegime ?? "UNKNOWN_REGIME";
    return {
      key: [record.context.symbol, record.context.direction, entry ?? "UNKNOWN_ENTRY", exit ?? "UNKNOWN_EXIT", regime].join("|"),
      attrs: { symbol: record.context.symbol, direction: record.context.direction, selectedEntryVariant: entry, selectedExitVariant: exit, routeCombo: routeCombo(entry, exit), marketRegime: regime },
    };
  });
  const byRouteRegime = groupedRows("ROUTE_REGIME", records, (record) => {
    const entry = record.context.selectedEntryVariant ?? record.outcome.selectedEntryVariant ?? null;
    const exit = record.context.selectedExitVariant ?? record.outcome.selectedExitVariant ?? null;
    const regime = record.context.marketRegime ?? "UNKNOWN_REGIME";
    return {
      key: [entry ?? "UNKNOWN_ENTRY", exit ?? "UNKNOWN_EXIT", regime].join("|"),
      attrs: { selectedEntryVariant: entry, selectedExitVariant: exit, routeCombo: routeCombo(entry, exit), marketRegime: regime },
    };
  });
  const bySymbolDirection = groupedRows("SYMBOL_DIRECTION", records, (record) => ({
    key: [record.context.symbol, record.context.direction].join("|"),
    attrs: { symbol: record.context.symbol, direction: record.context.direction },
  }));
  const bySymbol = groupedRows("SYMBOL", records, (record) => ({
    key: record.context.symbol,
    attrs: { symbol: record.context.symbol },
  }));
  return {
    bySymbolDirectionRoute,
    bySymbolDirectionRouteRegime,
    byRouteRegime,
    bySymbolDirection,
    bySymbol,
    allRows: [...bySymbolDirectionRoute, ...bySymbolDirectionRouteRegime, ...byRouteRegime, ...bySymbolDirection, ...bySymbol],
  };
}

function availability(contexts: StrategyContextSnapshot[], field: keyof StrategyContextSnapshot): FieldAvailability {
  if (contexts.length === 0) return "MISSING";
  const available = contexts.filter((context) => context[field] !== null && context[field] !== undefined).length;
  if (available === contexts.length) return "FULL";
  if (available > 0) return "PARTIAL";
  return "MISSING";
}

function buildMissingFieldAudit(contexts: StrategyContextSnapshot[], outcomes: ResolvedTradeOutcomeSnapshot[]): StrategyMissingFieldAudit {
  const fields: Record<string, FieldAvailability> = {};
  const completeness: Record<string, number> = {};
  const setContextField = (field: keyof StrategyContextSnapshot) => {
    fields[field] = availability(contexts, field);
    completeness[field] = contexts.length === 0
      ? 0
      : round4(contexts.filter((context) => context[field] !== null && context[field] !== undefined).length / contexts.length);
  };
  const setOutcomeField = (field: keyof ResolvedTradeOutcomeSnapshot) => {
    const available = outcomes.filter((outcome) => outcome[field] !== null && outcome[field] !== undefined).length;
    fields[field] = outcomes.length > 0 && available === outcomes.length ? "FULL" : available > 0 ? "PARTIAL" : "MISSING";
    completeness[field] = outcomes.length === 0 ? 0 : round4(available / outcomes.length);
  };
  for (const field of [
    "marketRegime",
    "selectedEntryVariant",
    "selectedExitVariant",
    "routeMode",
    "calibratedExpectedNetR",
    "stopDistanceBps",
    "riskReward",
    "trend5m",
    "trend15m",
    "trend1h",
    "entryPlaybook",
    "fibonacci",
    "kronosBias1h",
    "kronosBias4h",
    "whaleAgreement",
    "sentimentBucket",
    "volumeRatio5m",
    "volatilityAtrPercent5m",
    "selectedKronosBias",
    "fearGreedValue",
    "fearGreedBucket",
    "plannedEntryPrice",
    "entryZoneLow",
    "entryZoneHigh",
  ] as Array<keyof StrategyContextSnapshot>) {
    setContextField(field);
  }
  setOutcomeField("realizedNetR");
  setOutcomeField("mfeR");
  setOutcomeField("maeR");
  setOutcomeField("maxFavorableExcursionR");
  setOutcomeField("maxAdverseExcursionR");
  setOutcomeField("closeReason");
  setContextField("fearGreed");
  const entries = Object.entries(fields);
  return {
    fields,
    completeness,
    fullyAvailable: entries.filter(([, value]) => value === "FULL").map(([field]) => field),
    partiallyAvailable: entries.filter(([, value]) => value === "PARTIAL").map(([field]) => field),
    missing: entries.filter(([, value]) => value === "MISSING").map(([field]) => field),
  };
}

function sortByPromise(rows: StrategyEvidenceRow[]): StrategyEvidenceRow[] {
  return [...rows]
    .filter((row) => row.closedCount > 0)
    .sort((a, b) => (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity) || b.closedCount - a.closedCount);
}

function sortByToxic(rows: StrategyEvidenceRow[]): StrategyEvidenceRow[] {
  return [...rows]
    .filter((row) => row.closedCount > 0)
    .sort((a, b) => (a.netAvgR ?? Infinity) - (b.netAvgR ?? Infinity) || b.closedCount - a.closedCount);
}

function regimeSensitiveRows(rows: StrategyEvidenceRow[]): StrategyEvidenceRow[] {
  return [...rows]
    .filter((row) => row.marketRegime && row.closedCount >= 3)
    .sort((a, b) => Math.abs(b.netAvgR ?? 0) - Math.abs(a.netAvgR ?? 0));
}

export function buildStrategyIntelligenceFoundationReport(positions: ShadowPosition[], generatedAt = new Date().toISOString()): StrategyIntelligenceFoundationReport {
  const contexts = positions
    .map((position) => position.strategyContextSnapshot ?? buildStrategyContextSnapshot({ position }))
    .filter((context): context is StrategyContextSnapshot => context !== null);
  const records = buildStrategyExperienceRecords(positions);
  const outcomes = records.map((record) => record.outcome);
  const evidenceTable = buildStrategyEvidenceTable(records);
  const missingFieldAudit = buildMissingFieldAudit(contexts, outcomes);
  const eraScope = [...new Set(contexts.map((context) => context.evidenceEra ?? "UNKNOWN"))];
  const coverage = (field: string) => missingFieldAudit.completeness[field] ?? 0;
  const watchableRouteCohorts = evidenceTable.bySymbolDirectionRoute.filter((row) => row.closedCount >= 15).length;
  const symbolRouteBlocking: string[] = [];
  const symbolRouteNotes: string[] = [];
  if (records.length < 30) symbolRouteBlocking.push("Need at least 30 resolved strategy experience records.");
  if (watchableRouteCohorts < 3) symbolRouteBlocking.push("Need at least 3 symbol-direction-route cohorts with 15+ closed samples.");
  if (coverage("trend5m") < 0.5 || coverage("trend15m") < 0.5 || coverage("trend1h") < 0.5) symbolRouteBlocking.push("Trend stack coverage is below 50%.");
  if (coverage("marketRegime") <= 0) symbolRouteBlocking.push("Market regime is not captured.");
  if (coverage("calibratedExpectedNetR") > 0 && coverage("calibratedExpectedNetR") < 0.8) symbolRouteNotes.push("Calibration coverage is partial; use shrinkage before route scoring.");
  if (coverage("marketRegime") > 0 && coverage("marketRegime") < 0.8) symbolRouteNotes.push("Market regime exists but is incomplete for regime-sensitive route learning.");

  const gateBlocking: string[] = [];
  const gateNotes: string[] = [];
  if (coverage("marketRegime") < 0.8) gateBlocking.push("Market regime coverage must be at least 80% for adaptive gates.");
  if (coverage("selectedKronosBias") < 0.5 || coverage("whaleAgreement") < 0.5) gateBlocking.push("Source alignment coverage is below 50%.");
  if (coverage("trend5m") < 0.8 || coverage("trend15m") < 0.8 || coverage("trend1h") < 0.8) gateBlocking.push("Trend context coverage must be at least 80%.");
  if (coverage("sentimentBucket") < 0.5) gateNotes.push("Sentiment coverage is partial or absent; gate strictness should remain static.");
  if (coverage("fearGreedValue") === 0) gateNotes.push("Fear/greed and macro shock context are not captured yet.");

  const stopTpBlocking: string[] = [];
  const stopTpNotes: string[] = [];
  if (records.length < 50) stopTpBlocking.push("Need at least 50 resolved records for stop/TP credibility analysis.");
  if (coverage("maxFavorableExcursionR") < 0.8 || coverage("maxAdverseExcursionR") < 0.8) stopTpBlocking.push("MAE/MFE R coverage must be at least 80%.");
  if (coverage("stopDistanceBps") < 0.8 || coverage("riskReward") < 0.8) stopTpBlocking.push("Stop distance and risk/reward coverage must be at least 80%.");
  if (coverage("closeReason") < 0.95) stopTpBlocking.push("Close reason coverage must be near-complete.");
  if (coverage("maxFavorableExcursionR") > 0 && coverage("maxFavorableExcursionR") < 0.8) stopTpNotes.push("MAE/MFE capture has started; wait for newly closed positions to accumulate.");

  const universeBlocking: string[] = [];
  const universeNotes: string[] = [];
  if (records.length < 100) universeBlocking.push("Need at least 100 resolved records for universe rotation.");
  if (evidenceTable.bySymbol.filter((row) => row.closedCount >= 10).length < 8) universeBlocking.push("Need at least 8 symbols with 10+ closed records.");
  if (coverage("marketRegime") < 0.5) universeBlocking.push("Market context coverage is below 50%.");
  if (coverage("volumeRatio5m") <= 0 || coverage("volatilityAtrPercent5m") <= 0 || coverage("trend5m") <= 0) universeBlocking.push("Similarity fingerprint fields are missing.");
  if (coverage("volumeRatio5m") > 0 && coverage("volumeRatio5m") < 0.8) universeNotes.push("Volume fingerprint coverage is partial.");

  const symbolRouteEngine: StrategyEngineReadinessDetail = { ready: symbolRouteBlocking.length === 0, reasonsBlocking: symbolRouteBlocking, partialReadinessNotes: symbolRouteNotes };
  const adaptiveGateController: StrategyEngineReadinessDetail = { ready: gateBlocking.length === 0, reasonsBlocking: gateBlocking, partialReadinessNotes: gateNotes };
  const technicalStopTpEngine: StrategyEngineReadinessDetail = { ready: stopTpBlocking.length === 0, reasonsBlocking: stopTpBlocking, partialReadinessNotes: stopTpNotes };
  const universeRotation: StrategyEngineReadinessDetail = { ready: universeBlocking.length === 0, reasonsBlocking: universeBlocking, partialReadinessNotes: universeNotes };

  const reasons = [
    ...symbolRouteBlocking,
    ...gateBlocking,
    ...stopTpBlocking,
    ...universeBlocking,
    ...gateNotes,
  ];

  const readyForSymbolRouteEngine = symbolRouteEngine.ready;
  const readyForAdaptiveGateController = adaptiveGateController.ready;
  const readyForTechnicalStopTpEngine = technicalStopTpEngine.ready;
  const readyForUniverseRotation =
    universeRotation.ready;

  return {
    metadata: {
      generatedAt,
      evidenceEraScopeUsed: eraScope,
      contextSnapshotCount: contexts.length,
      resolvedExperienceRecordCount: records.length,
    },
    missingFieldAudit,
    strategyEvidenceTable: {
      topPromisingSymbolRoutePairs: sortByPromise(evidenceTable.bySymbolDirectionRoute).slice(0, 8),
      topToxicSymbolRoutePairs: sortByToxic(evidenceTable.bySymbolDirectionRoute).slice(0, 8),
      topRegimeSensitivePairs: regimeSensitiveRows(evidenceTable.bySymbolDirectionRouteRegime).slice(0, 8),
      topRouteCombosOverall: sortByPromise(evidenceTable.byRouteRegime).slice(0, 8),
    },
    dataReadiness: {
      readyForSymbolRouteEngine,
      readyForAdaptiveGateController,
      readyForTechnicalStopTpEngine,
      readyForUniverseRotation,
      reasons,
      symbolRouteEngine,
      adaptiveGateController,
      technicalStopTpEngine,
      universeRotation,
    },
  };
}

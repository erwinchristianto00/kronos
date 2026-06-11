import { startTransition, useEffect, useRef, useState } from 'react';
import NeuralMindmap from './NeuralMindmap';
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { buildEdgeScore, buildTradePlan, buildVariantCombinationTable, buildVariantSelection, type Candidate, type CapabilitySnapshot, type EdgeScoreSnapshot, type PerformanceStats, type SampleTier, type ScanResult, type ScannerDiagnostics, type ShadowStateSnapshot, type ShadowVariantStats, type StatusStats, type AgreementStats, type SymbolStats, type TradePlanSnapshot, type VariantSelectionSnapshot } from '@dtc/shared';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
const API_SCAN_URL = '/api/scan';
const API_HEALTH_URL = '/api/health';

function scoreTone(score: number, inverse = false) {
  if (inverse) {
    if (score <= 35) return 'badge badge-green';
    if (score <= 60) return 'badge badge-amber';
    return 'badge badge-red';
  }
  if (score >= 75) return 'badge badge-green';
  if (score >= 60) return 'badge badge-amber';
  return 'badge badge-slate';
}

function statusTone(status: Candidate['status']) {
  if (status === 'TRADE_NOW') return 'badge badge-green';
  if (status === 'READY') return 'badge badge-cyan';
  if (status === 'WAIT') return 'badge badge-amber';
  if (status === 'WATCH') return 'badge badge-slate';
  return 'badge badge-red';
}

function formatNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'Unknown';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'Unknown';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value > 1000 ? 0 : 4,
  }).format(value);
}

function socialProviderLabel(scan: ScanResult) {
  return scan.diagnostics.sentiment.provider ? `Social ${scan.diagnostics.sentiment.provider}` : 'Social';
}

function hasSourceConflict(candidate: Candidate) {
  return candidate.sourceConflict;
}

function ChartPanel({ candidate }: { candidate: Candidate }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    const chart = createChart(chartRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#d6e0f7',
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)', style: LineStyle.Dotted },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)', style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Magnet },
      rightPriceScale: { borderColor: 'rgba(148, 163, 184, 0.15)' },
      timeScale: { borderColor: 'rgba(148, 163, 184, 0.15)' },
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: candidate.direction === 'SHORT' ? '#f97316' : '#22c55e',
      topColor: candidate.direction === 'SHORT' ? 'rgba(249, 115, 22, 0.28)' : 'rgba(34, 197, 94, 0.28)',
      bottomColor: 'rgba(15, 23, 42, 0.04)',
      lineWidth: 3,
    });

    series.setData(
      candidate.chart.map((point) => ({
        time: point.time as UTCTimestamp,
        value: point.value,
      })),
    );

    chart.timeScale().fitContent();
    chartApiRef.current = chart;

    return () => {
      chart.remove();
      chartApiRef.current = null;
    };
  }, [candidate]);

  return (
    <section className="panel chart-panel">
      <div className="section-header">
        <div>
          <p className="eyebrow">Lightweight Charts</p>
          <h3>{candidate.symbol} intraday map</h3>
        </div>
        <span className="mini-status">{candidate.chart.length} live 5m points</span>
      </div>
      <div className="chart-host" ref={chartRef} aria-label={`${candidate.symbol} price chart`} />
    </section>
  );
}

function pct(rate: number) {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatPctMetric(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'Unknown';
  return `${value.toFixed(2)}%`;
}

function formatRMetric(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'Unknown';
  return `${value.toFixed(2)}R`;
}

function formatKronosHorizon(value: number | null | undefined, unavailableMessage?: string) {
  if (value === null || value === undefined || Number.isNaN(value)) return unavailableMessage ?? 'Unknown';
  return `${value.toFixed(2)}%`;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleString();
}

function kronosServiceLabel(kronos: CapabilitySnapshot) {
  if (kronos.state === 'FORECAST_HEALTHY') return 'Kronos active';
  if (kronos.state === 'DEGRADED') return 'Kronos degraded';
  if (kronos.state === 'REACHABLE') return 'Kronos reachable';
  return 'Kronos offline';
}

function kronosStatusLabel(candidate: Candidate, kronos: CapabilitySnapshot) {
  if (candidate.kronosBias !== 'UNAVAILABLE') {
    return `Kronos ${candidate.kronosBias} ${formatNumber(candidate.kronosConfidence)}`;
  }
  if (kronos.state === 'FORECAST_HEALTHY') {
    return `Kronos service active, symbol forecast unavailable: ${candidate.kronosReason ?? 'unavailable'}`;
  }
  if (kronos.state === 'DEGRADED' || kronos.state === 'REACHABLE') {
    return `Kronos service reachable, symbol forecast unavailable: ${candidate.kronosReason ?? 'unavailable'}`;
  }
  return `Kronos offline: ${candidate.kronosReason ?? 'unavailable'}`;
}

function shortHorizonOnly(candidate: Candidate) {
  if (candidate.kronosBias === 'UNAVAILABLE') return false;
  if (candidate.finalDirection === 'LONG') {
    return (candidate.expectedReturn1h ?? 0) > 0 && (candidate.expectedReturn4h ?? 0) < 0;
  }
  return (candidate.expectedReturn1h ?? 0) < 0 && (candidate.expectedReturn4h ?? 0) > 0;
}

function sampleTierLabel(tier: SampleTier) {
  if (tier === 'USABLE') return 'usable';
  if (tier === 'PROVISIONAL') return 'provisional';
  return 'early signal';
}

function insightToneClass(tone: 'green' | 'amber' | 'slate') {
  if (tone === 'green') return 'badge badge-green';
  if (tone === 'amber') return 'badge badge-amber';
  return 'badge badge-slate';
}

function formatAvgRReason(stats: StatusStats | AgreementStats | SymbolStats) {
  if (stats.avgGrossRResult !== null || stats.avgNetRResult !== null) {
    return `Gross ${formatRMetric(stats.avgGrossRResult)} | Net ${formatRMetric(stats.avgNetRResult)}`;
  }
  const parts: string[] = [];
  if (stats.avgRUnknownReasons.missingEntry > 0) parts.push(`missing entry ${stats.avgRUnknownReasons.missingEntry}`);
  if (stats.avgRUnknownReasons.missingStopLoss > 0) parts.push(`missing SL ${stats.avgRUnknownReasons.missingStopLoss}`);
  if (stats.avgRUnknownReasons.missingExit > 0) parts.push(`missing exit ${stats.avgRUnknownReasons.missingExit}`);
  if (stats.avgRUnknownReasons.invalidRisk > 0) parts.push(`invalid risk ${stats.avgRUnknownReasons.invalidRisk}`);
  if (stats.avgRUnknownReasons.openOutcome > 0) parts.push(`open outcome ${stats.avgRUnknownReasons.openOutcome}`);
  if (stats.avgRUnknownReasons.noCandlePath > 0) parts.push(`no candle path ${stats.avgRUnknownReasons.noCandlePath}`);
  return parts.length > 0 ? `Unknown (${parts.join(', ')})` : 'Unknown';
}

function entryMidpoint(candidate: Candidate) {
  if (!candidate.entryZone) return null;
  return (candidate.entryZone[0] + candidate.entryZone[1]) / 2;
}

function entryDriftPct(candidate: Candidate) {
  const midpoint = entryMidpoint(candidate);
  const latestPrice = candidate.indicators.fiveMinute.latestClose;
  if (midpoint === null || !Number.isFinite(midpoint) || midpoint <= 0 || !Number.isFinite(latestPrice)) {
    return null;
  }
  return ((latestPrice - midpoint) / midpoint) * 100;
}

function entryDriftLabel(candidate: Candidate) {
  const drift = entryDriftPct(candidate);
  if (drift === null) return 'Unknown';
  const side = drift > 0 ? 'above' : drift < 0 ? 'below' : 'at';
  return `${Math.abs(drift).toFixed(2)}% ${side} entry mid`;
}

async function fetchPerformance(): Promise<PerformanceStats> {
  const response = await fetch('/api/performance');
  if (!response.ok) {
    throw new Error(`Performance request failed with ${response.status}.`);
  }
  return (await response.json()) as PerformanceStats;
}

async function fetchShadow(): Promise<ShadowStateSnapshot> {
  const response = await fetch('/api/shadow');
  if (!response.ok) {
    throw new Error(`Shadow request failed with ${response.status}.`);
  }
  return (await response.json()) as ShadowStateSnapshot;
}

// Live readiness types mirror apps/api/src/lib/live-readiness.ts
type LiveGateStatus = 'PASS' | 'FAIL';
type LiveReadinessGateCode =
  | 'CLOSED_SAMPLE_SUFFICIENT' | 'NET_AVG_R_POSITIVE' | 'PROFIT_FACTOR_OK'
  | 'TP1_PROFITABLE_RATE_OK' | 'SL_RATE_OK' | 'MAX_LOSING_STREAK_OK'
  | 'RECENT_DAYS_POSITIVE' | 'WORST_DAY_OK' | 'DATA_COVERAGE_OK' | 'KRONOS_HEALTHY';
type LiveReadinessWarningCode =
  | 'DAILY_NET_R_BELOW_NEG_2' | 'THREE_CONSECUTIVE_LOSSES' | 'KRONOS_DEGRADED'
  | 'BINANCE_COVERAGE_LOW' | 'SPREAD_ABNORMAL' | 'ROUTE_EXPECTANCY_NEGATIVE';

type RouteAlignmentStatus = 'MATCH' | 'MISMATCH' | 'NO_LEADING_COHORT';

interface LeadingMaturityCohort {
  entryVariant: string;
  exitVariant: string;
  label: string;
  eraFilter: 'POST_CALIBRATION';
  closedCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  maturityStatus: MaturityStatus;
}

interface LiveReadinessReport {
  generatedAt: string;
  routeUnderEvaluation: { entryVariant: string; exitVariant: string };
  closedSampleCount: number;
  targetClosedSampleCount: number;
  recentClosesPerDay: number | null;
  estimatedDaysToTarget: number | null;
  score: number;
  liveReady: boolean;
  passedGates: LiveReadinessGateCode[];
  failedGates: LiveReadinessGateCode[];
  gates: Array<{ code: LiveReadinessGateCode; status: LiveGateStatus; threshold: string; actual: string }>;
  warningEvents: LiveReadinessWarningCode[];
  metrics: {
    netAvgR: number | null;
    profitFactor: number | null;
    tp1ProfitableRate: number | null;
    slRate: number | null;
    maxLosingStreak: number;
    recentPositiveDays: number;
    recentTotalDays: number;
    worstDayNetR: number | null;
    dataCoverage: number;
    kronosHealthy: boolean;
    todayNetR: number;
    lastThreeAllLosses: boolean;
  };
  lockedEvaluationRoute: { entryVariant: string; exitVariant: string; label: string };
  leadingMaturityCohort: LeadingMaturityCohort | null;
  routeAlignmentStatus: RouteAlignmentStatus;
  routeAlignmentMessage: string;
  notes: string[];
}

// Shadow Route Maturity types mirror apps/api/src/lib/route-maturity.ts
type MaturityStatus = 'COLLECTING' | 'PROMISING' | 'PROMOTABLE' | 'DEGRADING' | 'WEAK';
type MaturitySampleTier = 'early' | 'provisional' | 'usable';

interface CohortMaturity {
  entryVariant: string;
  exitVariant: string;
  totalIdeas: number;
  openCount: number;
  closedCount: number;
  noFillCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  sampleTier: MaturitySampleTier;
  routeModeDistribution: { DATA_COLLECTION: number; PROFIT_CANDIDATE: number };
  recentClosedCount: number;
  recentNetAvgR: number | null;
  estimatedDaysTo30Closed: number | null;
  estimatedDaysTo100Closed: number | null;
  maturityStatus: MaturityStatus;
  isPriorityCohort: boolean;
  isCurrentlySelected: boolean;
}

interface RouteMaturityReport {
  generatedAt: string;
  scope: { includes: string[]; excludes: string[] };
  eraFilter?: 'ALL_TIME' | 'POST_ROUTING' | 'POST_CALIBRATION';
  cohorts: CohortMaturity[];
  leadingCohort: { entryVariant: string; exitVariant: string } | null;
  notes: string[];
}

// Expectation Calibration types mirror apps/api/src/lib/expectation-calibration.ts

type RouteMaturityEraFilter = 'ALL_TIME' | 'POST_ROUTING' | 'POST_CALIBRATION';

async function fetchRouteMaturity(era?: RouteMaturityEraFilter): Promise<RouteMaturityReport | null> {
  try {
    const url = era ? `/api/shadow/route-maturity?era=${era}` : '/api/shadow/route-maturity';
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as RouteMaturityReport;
  } catch {
    return null;
  }
}

// Cohort performance + regime drift + post-calibration summary types

// ── Profit Anatomy types ─────────────────────────────────────────────────────

// ── Cost Attribution types ───────────────────────────────────────────────────

// ─── Symbol × Route Audit types ───────────────────────────────────────────────

type SymbolRouteVerdict = 'PROMISING' | 'BREAKEVEN_CANDIDATE' | 'SYMBOL_ROUTE_DRAG' | 'INSUFFICIENT_SAMPLE' | 'TOXIC';

// ─── Entry Precision Audit types ──────────────────────────────────────────────

// ─── Winner vs Loser Audit types ──────────────────────────────────────────────

// ─── Stop Geometry & RR Credibility Audit types ───────────────────────────────

// ─── Symbol-Route Suitability types (Phase 2B.1, advisory) ────────────────────

// ─── Adaptive Gate Controller Intelligence types (Phase 2C.1, advisory) ───────

type AdaptiveGateSampleTier = 'EMPTY' | 'TOO_EARLY' | 'EARLY' | 'WATCHABLE' | 'EVALUABLE';
type AdaptiveGateConfidenceTier = 'LOW' | 'MEDIUM' | 'HIGH';
type AdaptiveGateDimension =
  | 'MARKET_REGIME' | 'KRONOS_ALIGNMENT' | 'WHALE_ALIGNMENT' | 'HORIZON_CONFLICT'
  | 'SOURCE_CONFLICT' | 'DIRECTIONAL_ALIGNMENT' | 'SENTIMENT_BUCKET' | 'FEAR_GREED_BUCKET';
type AdaptiveLocalGateSignal =
  | 'INSUFFICIENT_EVIDENCE' | 'SUPPORTIVE_EARLY' | 'SUPPORTIVE_WATCHABLE'
  | 'HARMFUL_EARLY' | 'HARMFUL_WATCHABLE' | 'MIXED';
type AdaptiveDimensionVerdict = 'INSUFFICIENT_COVERAGE' | 'EARLY_SIGNAL' | 'WATCHABLE' | 'MIXED';
type AdaptiveInteractionVerdict =
  | 'INSUFFICIENT_EVIDENCE' | 'EARLY_SUPPORTIVE' | 'EARLY_HARMFUL'
  | 'WATCHABLE_SUPPORTIVE' | 'WATCHABLE_HARMFUL' | 'MIXED';
type AdaptivePatchStatus = 'WATCH' | 'AUDIT_DEEPER' | 'READY_FOR_PATCH_DISCUSSION';
type AdaptiveCoverageGapReason =
  | 'EXPECTED_ZERO_COVERAGE_DUE_TO_NO_RESOLVED_FORWARD_RECORDS'
  | 'TRUE_MAPPING_GAP'
  | 'SOURCE_NOT_AVAILABLE_AT_SCAN_TIME'
  | 'MIXED';

interface AdaptiveGateBaseline {
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
}
interface AdaptiveGateDelta { netAvgR: number | null; profitFactor: number | null; slRate: number | null; }
interface AdaptiveGateConditionAssessment {
  dimension: AdaptiveGateDimension;
  bucket: string;
  conditionLabel: string;
  closedCount: number;
  sampleTier: AdaptiveGateSampleTier;
  netAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  performanceDeltaVsBaseline: AdaptiveGateDelta;
  localGateSignal: AdaptiveLocalGateSignal;
  confidenceTier: AdaptiveGateConfidenceTier;
  sampleWeight: number;
  reasons: string[];
}
interface AdaptiveGateDimensionSummary {
  dimension: AdaptiveGateDimension;
  coveragePct: number;
  distinctBucketsObserved: number;
  meaningfulBucketsCount: number;
  dimensionVerdict: AdaptiveDimensionVerdict;
  buckets: AdaptiveGateConditionAssessment[];
  notes: string[];
}
interface AdaptiveGateInteractionAssessment {
  interactionLabel: string;
  closedCount: number;
  sampleTier: AdaptiveGateSampleTier;
  netAvgR: number | null;
  profitFactor: number | null;
  slRate: number | null;
  deltaVsBaseline: AdaptiveGateDelta;
  verdict: AdaptiveInteractionVerdict;
  reasons: string[];
}
interface AdaptiveGatePatchHypothesis {
  title: string;
  sourceDimensionOrInteraction: string;
  suggestedFutureAction: string;
  evidenceSummary: string;
  confidence: AdaptiveGateConfidenceTier;
  patchStatus: AdaptivePatchStatus;
  doesNotImplementNow: true;
}
interface AdaptiveGateCoverageFieldProvenance {
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
interface AdaptiveGateCoverageProvenanceReport {
  totalResolvedRecords: number;
  resolvedRecordsWithStrategyContext: number;
  recordsCreatedBeforePhase2A5: number;
  recordsCreatedAfterPhase2A5: number;
  totalPositionsWithStrategyContext: number;
  openPositionsWithStrategyContext: number;
  perField: AdaptiveGateCoverageFieldProvenance[];
  notes: string[];
}
interface AdaptiveGateIntelligenceReport {
  generatedAt: string;
  evidenceEra: 'POST_CALIBRATION' | 'ALL_TIME';
  totalResolvedExperienceRecords: number;
  usableRecordsForGateAnalysis: number;
  metadata: { resolvedExperienceRecordCount: number; usableRecordCount: number };
  baseline: AdaptiveGateBaseline;
  contextCoverage: Array<{ dimension: AdaptiveGateDimension; populatedCount: number; coveragePct: number }>;
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
  dimensionSummaries: AdaptiveGateDimensionSummary[];
  topSupportiveConditions: AdaptiveGateConditionAssessment[];
  topHarmfulConditions: AdaptiveGateConditionAssessment[];
  interactions: AdaptiveGateInteractionAssessment[];
  interactionAssessments: AdaptiveGateInteractionAssessment[];
  coverageProvenance: AdaptiveGateCoverageProvenanceReport;
  patchHypotheses: AdaptiveGatePatchHypothesis[];
  readiness: { advisoryEngineReady: boolean; readyForGateInfluence: boolean; reasons: string[] };
  notes: string[];
}

async function fetchAdaptiveGateIntelligence(): Promise<AdaptiveGateIntelligenceReport | null> {
  try {
    const r = await fetch('/api/shadow/adaptive-gate-intelligence');
    if (!r.ok) return null;
    return (await r.json()) as AdaptiveGateIntelligenceReport;
  } catch {
    return null;
  }
}

type OverlayEarlyVerdict =
  | 'NO_FORWARD_EVIDENCE_YET'
  | 'TOO_EARLY'
  | 'EARLY_SUPPORTIVE'
  | 'EARLY_HARMFUL'
  | 'WATCHABLE_SUPPORTIVE'
  | 'WATCHABLE_HARMFUL'
  | 'MIXED';

interface OverlayMetricSummary {
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
}
interface OverlayDeltaSummary {
  netAvgRDelta: number | null;
  profitFactorDelta: number | null;
  slRateDelta: number | null;
}
interface AdaptiveRegimeGateOverlayPolicyPerformance {
  policyId: 'EXCLUDE_BULLISH_EXPANSION_V1' | 'KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1' | 'EXCLUDE_BULLISH_EXPANSION_LONG_V1';
  policyVersion: string;
  policyLabel: string;
  totalResolvedWithPolicy: number;
  includedCount: number;
  excludedCount: number;
  insufficientContextCount: number;
  includedMetrics: OverlayMetricSummary;
  excludedMetrics: OverlayMetricSummary;
  deltaIncludedVsAllOverlayRecords: OverlayDeltaSummary;
  deltaIncludedVsExcluded: OverlayDeltaSummary;
  earlyVerdict: OverlayEarlyVerdict;
  reasons: string[];
}
interface AdaptiveRegimeGateOverlayPerformanceReport {
  generatedAt: string;
  evidenceEra: 'POST_CALIBRATION' | 'ALL_TIME';
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

async function fetchDashboardAuditSummaryText(): Promise<string | null> {
  try {
    const r = await fetch('/api/shadow/dashboard-audit-summary?era=POST_CALIBRATION');
    if (!r.ok) return null;
    const payload = (await r.json()) as { summaryText?: string };
    return typeof payload.summaryText === 'string' ? payload.summaryText : null;
  } catch {
    return null;
  }
}

async function fetchAdaptiveGateOverlayPerformance(): Promise<AdaptiveRegimeGateOverlayPerformanceReport | null> {
  try {
    const r = await fetch('/api/shadow/adaptive-gate-overlay-performance');
    if (!r.ok) return null;
    return (await r.json()) as AdaptiveRegimeGateOverlayPerformanceReport;
  } catch {
    return null;
  }
}

// ─── Technical Stop/TP Credibility Intelligence (Phase 2D.1, advisory) ────────

// ─── Universe Rotation Intelligence types ──────────────────────────────────────

type RotationSampleTier = 'EMPTY' | 'TOO_EARLY' | 'EARLY' | 'WATCHABLE' | 'EVALUABLE';
type RotationPressureLevel = 'LOW' | 'MODERATE' | 'HIGH';
type SymbolRotationVerdict =
  | 'INSUFFICIENT_EVIDENCE' | 'EARLY_PROMISING' | 'WATCHABLE_PROMISING'
  | 'MIXED' | 'EARLY_DRAG' | 'WATCHABLE_DRAG' | 'TOXIC_PRESSURE';
type FingerprintConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
type RotationPatchAction =
  | 'AUDIT_TOXIC_SYMBOL_DEEPER' | 'WATCH_PROMISING_SYMBOL_ACCUMULATE'
  | 'AUDIT_DIRECTION_SPECIFIC_DRAG' | 'NO_ACTION_YET';
type RotationPatchStatus = 'WATCH' | 'AUDIT_DEEPER';

interface SymbolRotationAssessment {
  symbol: string; closedCount: number;
  netAvgR: number | null; grossAvgR: number | null; profitFactor: number | null;
  winRate: number | null; slRate: number | null; tp1ProfitableRate: number | null;
  avgWinR: number | null; avgLossR: number | null;
  sampleTier: RotationSampleTier; rotationPressureScore: number;
  rotationPressureLevel: RotationPressureLevel; verdict: SymbolRotationVerdict;
  directions: Array<'LONG' | 'SHORT'>; reasons: string[];
}

interface SymbolDirectionRotationAssessment {
  symbol: string; direction: 'LONG' | 'SHORT'; closedCount: number;
  netAvgR: number | null; profitFactor: number | null;
  winRate: number | null; slRate: number | null;
  sampleTier: RotationSampleTier; verdict: SymbolRotationVerdict;
  rotationPressureScore: number;
}

interface UniverseContributionSummary {
  totalSymbols: number; totalClosedCount: number;
  overallNetAvgR: number | null; overallProfitFactor: number | null;
  positiveContributorCount: number; negativeContributorCount: number;
  topContributor: { symbol: string; netAvgR: number; closedCount: number } | null;
  worstContributor: { symbol: string; netAvgR: number; closedCount: number } | null;
  symbolsAboveAvg: number; symbolsBelowAvg: number;
}

interface RotationFingerprint {
  type: 'PROMISING' | 'TOXIC'; pattern: string;
  exampleSymbol: string; exampleDirection: 'LONG' | 'SHORT' | null;
  exampleNetAvgR: number | null; sampleCount: number;
  confidence: FingerprintConfidence; interpretation: string;
}

interface RotationPatchHypothesis {
  title: string; evidenceSummary: string;
  likelyFutureAction: RotationPatchAction; confidence: FingerprintConfidence;
  patchStatus: RotationPatchStatus; doesNotImplementNow: true;
}

interface UniverseRotationIntelligenceReport {
  generatedAt: string; evidenceEra: string;
  metadata: {
    resolvedExperienceRecordCount: number; symbolCount: number;
    symbolsWithAtLeast5Closes: number; symbolsWithAtLeast15Closes: number;
    symbolsWithAtLeast30Closes: number;
  };
  symbolAssessments: SymbolRotationAssessment[];
  symbolDirectionAssessments: SymbolDirectionRotationAssessment[];
  universeContributionSummary: UniverseContributionSummary;
  coreObservationCandidates: SymbolRotationAssessment[];
  rotationPressureCandidates: SymbolRotationAssessment[];
  promisingFingerprints: RotationFingerprint[];
  toxicFingerprints: RotationFingerprint[];
  patchHypotheses: RotationPatchHypothesis[];
  readiness: {
    advisoryEngineReady: boolean;
    readyForUniverseInfluence: false;
    readyForExternalCandidateSearch: false;
    reasons: string[];
  };
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

async function fetchUniverseRotationIntelligence(): Promise<UniverseRotationIntelligenceReport | null> {
  try {
    const r = await fetch('/api/shadow/universe-rotation-intelligence');
    if (!r.ok) return null;
    return (await r.json()) as UniverseRotationIntelligenceReport;
  } catch {
    return null;
  }
}

function rotationVerdictBadge(v: SymbolRotationVerdict) {
  if (v === 'WATCHABLE_PROMISING' || v === 'EARLY_PROMISING') return 'badge badge-green';
  if (v === 'TOXIC_PRESSURE') return 'badge badge-red';
  if (v === 'WATCHABLE_DRAG' || v === 'EARLY_DRAG') return 'badge badge-amber';
  if (v === 'MIXED') return 'badge badge-slate';
  return 'badge badge-slate';
}

function pressureLevelBadge(level: RotationPressureLevel) {
  if (level === 'HIGH') return 'badge badge-red';
  if (level === 'MODERATE') return 'badge badge-amber';
  return 'badge badge-green';
}

function UniverseRotationIntelligencePanel({ report }: { report: UniverseRotationIntelligenceReport }) {
  const s = report.universeContributionSummary;
  return (
    <section className="panel">
      <h2>O. Universe Rotation Intelligence <span className="badge badge-slate">Phase 2E.1 · Advisory Only</span></h2>

      {/* Header */}
      <div className="metric-row"><span>Era</span><strong>{report.evidenceEra}</strong></div>
      <div className="metric-row"><span>Records analyzed</span><strong>{report.metadata.resolvedExperienceRecordCount}</strong></div>
      <div className="metric-row"><span>Symbols tracked</span><strong>{report.metadata.symbolCount}</strong></div>
      <div className="metric-row"><span>Symbols ≥5 closes</span><strong>{report.metadata.symbolsWithAtLeast5Closes}</strong></div>
      <div className="metric-row"><span>Symbols ≥15 closes</span><strong>{report.metadata.symbolsWithAtLeast15Closes}</strong></div>
      <div className="metric-row"><span>Symbols ≥30 closes</span><strong>{report.metadata.symbolsWithAtLeast30Closes}</strong></div>

      {/* Universe contribution summary */}
      <h3>Universe Contribution Summary</h3>
      <div className="metric-row"><span>Overall netAvgR</span><strong>{s.overallNetAvgR?.toFixed(4) ?? 'n/a'}</strong></div>
      <div className="metric-row"><span>Overall profit factor</span><strong>{s.overallProfitFactor?.toFixed(2) ?? 'n/a'}</strong></div>
      <div className="metric-row"><span>Positive contributors (≥5 closes)</span><strong className="badge badge-green">{s.positiveContributorCount}</strong></div>
      <div className="metric-row"><span>Negative contributors (≥5 closes)</span><strong className="badge badge-red">{s.negativeContributorCount}</strong></div>
      {s.topContributor && (
        <div className="metric-row"><span>Top contributor</span><strong>{s.topContributor.symbol} (netAvgR={s.topContributor.netAvgR.toFixed(4)}, n={s.topContributor.closedCount})</strong></div>
      )}
      {s.worstContributor && (
        <div className="metric-row"><span>Worst contributor</span><strong>{s.worstContributor.symbol} (netAvgR={s.worstContributor.netAvgR.toFixed(4)}, n={s.worstContributor.closedCount})</strong></div>
      )}

      {/* Core observation candidates */}
      {report.coreObservationCandidates.length > 0 && (
        <>
          <h3>Core Observation Candidates</h3>
          <table style={{ width: '100%', fontSize: '0.85em' }}>
            <thead><tr><th>Symbol</th><th>Verdict</th><th>netAvgR</th><th>n</th><th>Tier</th><th>Pressure</th></tr></thead>
            <tbody>
              {report.coreObservationCandidates.map((sym) => (
                <tr key={sym.symbol}>
                  <td>{sym.symbol}</td>
                  <td><span className={rotationVerdictBadge(sym.verdict)}>{sym.verdict}</span></td>
                  <td>{sym.netAvgR?.toFixed(4) ?? 'n/a'}</td>
                  <td>{sym.closedCount}</td>
                  <td>{sym.sampleTier}</td>
                  <td><span className={pressureLevelBadge(sym.rotationPressureLevel)}>{sym.rotationPressureLevel} ({sym.rotationPressureScore})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Rotation pressure candidates */}
      {report.rotationPressureCandidates.length > 0 && (
        <>
          <h3>Rotation Pressure Candidates</h3>
          <table style={{ width: '100%', fontSize: '0.85em' }}>
            <thead><tr><th>Symbol</th><th>Verdict</th><th>netAvgR</th><th>n</th><th>Tier</th><th>Pressure</th></tr></thead>
            <tbody>
              {report.rotationPressureCandidates.map((sym) => (
                <tr key={sym.symbol}>
                  <td>{sym.symbol}</td>
                  <td><span className={rotationVerdictBadge(sym.verdict)}>{sym.verdict}</span></td>
                  <td>{sym.netAvgR?.toFixed(4) ?? 'n/a'}</td>
                  <td>{sym.closedCount}</td>
                  <td>{sym.sampleTier}</td>
                  <td><span className={pressureLevelBadge(sym.rotationPressureLevel)}>{sym.rotationPressureLevel} ({sym.rotationPressureScore})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* All symbol assessments */}
      {report.symbolAssessments.length > 0 && (
        <>
          <h3>All Symbol Assessments</h3>
          <table style={{ width: '100%', fontSize: '0.82em' }}>
            <thead><tr><th>Symbol</th><th>Verdict</th><th>netAvgR</th><th>PF</th><th>WR</th><th>SL%</th><th>n</th><th>Tier</th><th>Pressure</th><th>Dirs</th></tr></thead>
            <tbody>
              {report.symbolAssessments.map((sym) => (
                <tr key={sym.symbol}>
                  <td>{sym.symbol}</td>
                  <td><span className={rotationVerdictBadge(sym.verdict)}>{sym.verdict}</span></td>
                  <td>{sym.netAvgR?.toFixed(4) ?? 'n/a'}</td>
                  <td>{sym.profitFactor?.toFixed(2) ?? 'n/a'}</td>
                  <td>{sym.winRate != null ? `${(sym.winRate * 100).toFixed(0)}%` : 'n/a'}</td>
                  <td>{sym.slRate != null ? `${(sym.slRate * 100).toFixed(0)}%` : 'n/a'}</td>
                  <td>{sym.closedCount}</td>
                  <td>{sym.sampleTier}</td>
                  <td><span className={pressureLevelBadge(sym.rotationPressureLevel)}>{sym.rotationPressureLevel} ({sym.rotationPressureScore})</span></td>
                  <td>{sym.directions.join('/')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Symbol-direction assessments */}
      {report.symbolDirectionAssessments.length > 0 && (
        <>
          <h3>Symbol-Direction Assessments</h3>
          <table style={{ width: '100%', fontSize: '0.82em' }}>
            <thead><tr><th>Symbol</th><th>Dir</th><th>Verdict</th><th>netAvgR</th><th>PF</th><th>WR</th><th>n</th><th>Tier</th><th>Pressure</th></tr></thead>
            <tbody>
              {report.symbolDirectionAssessments.map((sd, i) => (
                <tr key={`${sd.symbol}-${sd.direction}-${i}`}>
                  <td>{sd.symbol}</td>
                  <td>{sd.direction}</td>
                  <td><span className={rotationVerdictBadge(sd.verdict)}>{sd.verdict}</span></td>
                  <td>{sd.netAvgR?.toFixed(4) ?? 'n/a'}</td>
                  <td>{sd.profitFactor?.toFixed(2) ?? 'n/a'}</td>
                  <td>{sd.winRate != null ? `${(sd.winRate * 100).toFixed(0)}%` : 'n/a'}</td>
                  <td>{sd.closedCount}</td>
                  <td>{sd.sampleTier}</td>
                  <td>{sd.rotationPressureScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Promising fingerprints */}
      {report.promisingFingerprints.length > 0 && (
        <>
          <h3>Promising Fingerprints</h3>
          {report.promisingFingerprints.map((fp, i) => (
            <div key={i} style={{ marginBottom: '0.75em', padding: '0.5em', background: 'rgba(34,197,94,0.07)', borderRadius: 4 }}>
              <strong>{fp.pattern}</strong>
              <div style={{ fontSize: '0.85em', marginTop: 4 }}>
                <span className="badge badge-green">{fp.type}</span>{' '}
                <span className={`badge badge-${fp.confidence === 'HIGH' ? 'green' : fp.confidence === 'MEDIUM' ? 'amber' : 'slate'}`}>{fp.confidence}</span>{' '}
                n={fp.sampleCount}
              </div>
              <p style={{ fontSize: '0.82em', margin: '4px 0 0' }}>{fp.interpretation}</p>
            </div>
          ))}
        </>
      )}

      {/* Toxic fingerprints */}
      {report.toxicFingerprints.length > 0 && (
        <>
          <h3>Toxic Fingerprints</h3>
          {report.toxicFingerprints.map((fp, i) => (
            <div key={i} style={{ marginBottom: '0.75em', padding: '0.5em', background: 'rgba(239,68,68,0.07)', borderRadius: 4 }}>
              <strong>{fp.pattern}</strong>
              <div style={{ fontSize: '0.85em', marginTop: 4 }}>
                <span className="badge badge-red">{fp.type}</span>{' '}
                <span className={`badge badge-${fp.confidence === 'HIGH' ? 'green' : fp.confidence === 'MEDIUM' ? 'amber' : 'slate'}`}>{fp.confidence}</span>{' '}
                n={fp.sampleCount}
              </div>
              <p style={{ fontSize: '0.82em', margin: '4px 0 0' }}>{fp.interpretation}</p>
            </div>
          ))}
        </>
      )}

      {/* Patch hypotheses */}
      <h3>Patch Hypotheses</h3>
      {report.patchHypotheses.map((h, i) => (
        <div key={i} style={{ marginBottom: '0.75em', padding: '0.5em', background: 'rgba(100,116,139,0.07)', borderRadius: 4 }}>
          <strong>{h.title}</strong>
          <div style={{ fontSize: '0.85em', marginTop: 4 }}>
            <span className={`badge badge-${h.patchStatus === 'AUDIT_DEEPER' ? 'amber' : 'slate'}`}>{h.patchStatus}</span>{' '}
            <span className="badge badge-slate">{h.likelyFutureAction}</span>{' '}
            <span className="badge badge-slate">doesNotImplementNow</span>
          </div>
          <p style={{ fontSize: '0.82em', margin: '4px 0 0' }}>{h.evidenceSummary}</p>
        </div>
      ))}

      {/* Answer cards */}
      <h3>Advisory Answer Cards</h3>
      {report.answerCards.map((card, i) => (
        <div key={i} style={{ marginBottom: '0.75em' }}>
          <strong style={{ fontSize: '0.9em' }}>Q: {card.question}</strong>
          <p style={{ fontSize: '0.85em', margin: '4px 0 0', color: 'var(--text-secondary, #94a3b8)' }}>{card.answer}</p>
        </div>
      ))}

      {/* Readiness */}
      <h3>Readiness</h3>
      <div className="metric-row"><span>Advisory engine ready</span><strong className={report.readiness.advisoryEngineReady ? 'badge badge-green' : 'badge badge-slate'}>{String(report.readiness.advisoryEngineReady)}</strong></div>
      <div className="metric-row"><span>Ready for universe influence</span><strong className="badge badge-slate">false (always)</strong></div>
      <div className="metric-row"><span>Ready for external candidate search</span><strong className="badge badge-slate">false (always)</strong></div>
      {report.readiness.reasons.map((r, i) => (
        <div key={i} style={{ fontSize: '0.82em', color: 'var(--text-secondary, #94a3b8)', marginBottom: 2 }}>• {r}</div>
      ))}
    </section>
  );
}

// ─── External Candidate Discovery Intelligence types ──────────────────────────

type ExternalDiscoveryTier = 'EXPLORATORY_SHORTLIST' | 'WATCHLIST_ONLY' | 'LOW_PRIORITY' | 'REJECTED';
type ExternalCandidateTradabilityVerdict =
  | 'TRADABLE' | 'LOW_LIQUIDITY' | 'EXCESSIVE_SPREAD' | 'NOT_SUPPORTED_INSTRUMENT'
  | 'STATUS_NOT_TRADING' | 'DATA_INCOMPLETE' | 'CURRENT_UNIVERSE_MEMBER';
type ExternalDiscoveryReadinessConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
type ExternalDiscoveryPatchAction =
  | 'PREPARE_ROTATION_SHADOW_OVERLAY' | 'IMPROVE_EXTERNAL_FEATURE_CAPTURE'
  | 'WAIT_FOR_MATURE_WINNER_FINGERPRINT' | 'NO_ACTION_YET';
type ExternalDiscoveryPatchStatus = 'WATCH' | 'AUDIT_DEEPER' | 'READY_FOR_PATCH_DISCUSSION';

interface ExternalCandidateAssessment {
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

interface ExternalDiscoveryReport {
  generatedAt: string;
  evidenceEra: string;
  currentUniverseSymbolCount: number;
  externalUniverseSymbolsConsidered: number;
  externalUniverseSymbolsTradable: number;
  externalUniverseSymbolsRejected: number;
  discoveryReadiness: {
    advisoryEngineReady: boolean;
    readyForUniverseExpansionInfluence: false;
    readyForRotationShadowOverlay: false;
    confidence: ExternalDiscoveryReadinessConfidence;
    reasons: string[];
  };
  sourceMetadata: {
    source: string;
    instrumentTypeFilter: string;
    quoteAssetFilter: string;
    minQuoteVolume24hUsd: number;
    maxSpreadBps: number;
  };
  tradabilityBreakdown: Record<ExternalCandidateTradabilityVerdict, number>;
  discoveryFingerprintBasis: {
    promisingFingerprintConfidence: string;
    toxicFingerprintConfidence: string;
    promisingFingerprintCount: number;
    toxicFingerprintCount: number;
    promisingFingerprintSummary: string;
    toxicFingerprintSummary: string;
    maturityWarning: string;
  };
  shortlistedCandidates: ExternalCandidateAssessment[];
  rejectedCandidatesSample: ExternalCandidateAssessment[];
  categoryBuckets: {
    highLiquidityExploratory: string[];
    highVolatilityTradable: string[];
    stableLiquidityCandidates: string[];
    dataIncompleteCandidates: string[];
  };
  patchHypotheses: Array<{
    title: string;
    evidenceSummary: string;
    likelyFutureAction: ExternalDiscoveryPatchAction;
    confidence: ExternalDiscoveryReadinessConfidence;
    patchStatus: ExternalDiscoveryPatchStatus;
    doesNotImplementNow: true;
  }>;
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

async function fetchExternalCandidateDiscovery(): Promise<ExternalDiscoveryReport | null> {
  try {
    const r = await fetch('/api/shadow/external-candidate-discovery-intelligence');
    if (!r.ok) return null;
    return (await r.json()) as ExternalDiscoveryReport;
  } catch {
    return null;
  }
}

type ExternalStrategyFitTier = 'STRATEGY_FIT_HIGH' | 'STRATEGY_FIT_MEDIUM' | 'STRATEGY_FIT_LOW' | 'NOT_EVALUABLE';
type ExternalStrategyFitConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

interface ExternalStrategyFitCandidateAssessment {
  symbol: string;
  discoveryScore: number;
  metadataDiscoveryTier: string;
  technicalDataStatus: 'HEALTHY' | 'PARTIAL' | 'FAILED' | 'INSUFFICIENT_DATA';
  strategyFitScore: number;
  strategyFitTier: ExternalStrategyFitTier;
  strategyFitConfidence: ExternalStrategyFitConfidence;
  directionalContext: string;
  regimeCompatibility: string;
  routeCompatibility: string;
  setupQuality: string;
  stopGeometryCredibilityHint: string;
  reasons: string[];
  bestObservedExternalRouteHypothesis: {
    selectedEntryVariant: string | null;
    selectedExitVariant: string | null;
    routeMode: string | null;
    expectedNetR: number | null;
    stopDistanceBps: number | null;
    riskReward: number | null;
  };
}

interface ExternalStrategyFitEnrichmentReport {
  generatedAt: string;
  evidenceEra: string;
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
  diagnostics: {
    candidatesRequested: number;
    candidatesEvaluated: number;
    technicalFetchSuccessCount: number;
    technicalFetchFailureCount: number;
    cacheStatus: string;
    notes: string[];
  };
  topStrategyFitCandidates: ExternalStrategyFitCandidateAssessment[];
  lowFitCandidates: ExternalStrategyFitCandidateAssessment[];
  metadataShortlistDivergesFromStrategyFit: boolean;
  patchHypotheses: Array<{
    title: string;
    evidenceSummary: string;
    likelyFutureAction: string;
    confidence: ExternalStrategyFitConfidence;
    patchStatus: string;
    doesNotImplementNow: true;
  }>;
}

async function fetchExternalStrategyFitEnrichment(): Promise<ExternalStrategyFitEnrichmentReport | null> {
  try {
    const r = await fetch('/api/shadow/external-strategy-fit-enrichment');
    if (!r.ok) return null;
    return (await r.json()) as ExternalStrategyFitEnrichmentReport;
  } catch {
    return null;
  }
}

type ExternalRotationOverlayGroup = 'STRATEGY_FIT_SHORTLIST' | 'METADATA_DISCOVERY_BASELINE' | 'LOW_FIT_CONTROL';
type ExternalRotationOverlayVerdict =
  | 'NO_FORWARD_EVIDENCE_YET'
  | 'TOO_EARLY'
  | 'EARLY_SUPPORTIVE'
  | 'EARLY_HARMFUL'
  | 'WATCHABLE_SUPPORTIVE'
  | 'WATCHABLE_HARMFUL'
  | 'MIXED';

interface ExternalRotationOverlayGroupPerformance {
  group: ExternalRotationOverlayGroup;
  observationCount: number;
  resolvedCount: number;
  noFillRate: number | null;
  netAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  earlyVerdict: ExternalRotationOverlayVerdict;
  comparisonVsMetadataBaseline: {
    deltaNetAvgR: number | null;
  };
}

interface ExternalRotationOverlayPerformanceReport {
  generatedAt: string;
  evidenceEra: string;
  totalObservations: number;
  openObservations: number;
  resolvedObservations: number;
  noFillObservations: number;
  expiredObservations: number;
  failedObservations: number;
  duplicateSuppressionStats: {
    lastRefreshAt: string | null;
    observationsConsidered: number;
    observationsCreated: number;
    observationsSuppressedAsDuplicate: number;
    observationsSkippedForInsufficientState: number;
  };
  groupPerformance: ExternalRotationOverlayGroupPerformance[];
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
    confidence: string;
    patchStatus: string;
    doesNotImplementNow: true;
  }>;
}

async function fetchExternalRotationOverlayPerformance(): Promise<ExternalRotationOverlayPerformanceReport | null> {
  try {
    const r = await fetch('/api/shadow/external-rotation-overlay-performance');
    if (!r.ok) return null;
    return (await r.json()) as ExternalRotationOverlayPerformanceReport;
  } catch {
    return null;
  }
}

function discoveryTierBadge(tier: ExternalDiscoveryTier) {
  if (tier === 'EXPLORATORY_SHORTLIST') return 'badge badge-green';
  if (tier === 'WATCHLIST_ONLY') return 'badge badge-amber';
  if (tier === 'LOW_PRIORITY') return 'badge badge-slate';
  return 'badge badge-red';
}

function tradabilityVerdictBadge(v: ExternalCandidateTradabilityVerdict) {
  if (v === 'TRADABLE') return 'badge badge-green';
  if (v === 'CURRENT_UNIVERSE_MEMBER') return 'badge badge-slate';
  return 'badge badge-red';
}

function fingerprintConfidenceBadge(c: string) {
  if (c === 'HIGH') return 'badge badge-green';
  if (c === 'MEDIUM') return 'badge badge-amber';
  if (c === 'LOW') return 'badge badge-slate';
  return 'badge badge-slate';
}

function ExternalCandidateDiscoveryPanel({ report }: { report: ExternalDiscoveryReport }) {
  const top = report.shortlistedCandidates[0];
  return (
    <section className="panel">
      <h2>P. External Candidate Discovery Intelligence <span className="badge badge-slate">Phase 2E.2 · Advisory Only</span></h2>

      <p style={{ fontSize: '0.85em', color: 'var(--text-secondary, #94a3b8)' }}>
        Advisory only. This panel explores which external tradable symbols may be worth observing later based on current universe evidence,
        tradability, and low-confidence fingerprint similarity. It does not modify the active symbol universe.
      </p>

      <div className="metric-row"><span>Era</span><strong>{report.evidenceEra}</strong></div>
      <div className="metric-row"><span>Current universe size</span><strong>{report.currentUniverseSymbolCount}</strong></div>
      <div className="metric-row"><span>External symbols considered</span><strong>{report.externalUniverseSymbolsConsidered}</strong></div>
      <div className="metric-row"><span>Tradable candidates</span><strong className="badge badge-green">{report.externalUniverseSymbolsTradable}</strong></div>
      <div className="metric-row"><span>Rejected candidates</span><strong className="badge badge-red">{report.externalUniverseSymbolsRejected}</strong></div>
      <div className="metric-row"><span>Shortlist size</span><strong>{report.shortlistedCandidates.length}</strong></div>
      <div className="metric-row"><span>Discovery readiness confidence</span><strong className={fingerprintConfidenceBadge(report.discoveryReadiness.confidence)}>{report.discoveryReadiness.confidence}</strong></div>
      <div className="metric-row"><span>Ready for universe expansion influence</span><strong className="badge badge-slate">false (always)</strong></div>
      <div className="metric-row"><span>Ready for rotation shadow overlay</span><strong className="badge badge-slate">false (always — reserved for Phase 2E.3)</strong></div>

      <h3>Discovery Basis</h3>
      <div className="metric-row"><span>Promising fingerprint confidence</span><strong className={fingerprintConfidenceBadge(report.discoveryFingerprintBasis.promisingFingerprintConfidence)}>{report.discoveryFingerprintBasis.promisingFingerprintConfidence} ({report.discoveryFingerprintBasis.promisingFingerprintCount})</strong></div>
      <div className="metric-row"><span>Toxic fingerprint confidence</span><strong className={fingerprintConfidenceBadge(report.discoveryFingerprintBasis.toxicFingerprintConfidence)}>{report.discoveryFingerprintBasis.toxicFingerprintConfidence} ({report.discoveryFingerprintBasis.toxicFingerprintCount})</strong></div>
      <div style={{ fontSize: '0.82em', color: 'var(--text-warn, #f59e0b)', marginTop: 6 }}>
        {report.discoveryFingerprintBasis.maturityWarning}
      </div>

      {report.shortlistedCandidates.length > 0 && (
        <>
          <h3>Top Exploratory Shortlist</h3>
          <table style={{ width: '100%', fontSize: '0.82em' }}>
            <thead><tr><th>Symbol</th><th>Tier</th><th>Net Score</th><th>Promising</th><th>Toxic Penalty</th><th>Volume 24h</th><th>Spread</th><th>%Δ 24h</th></tr></thead>
            <tbody>
              {report.shortlistedCandidates.map((c) => (
                <tr key={c.symbol}>
                  <td>{c.symbol}</td>
                  <td><span className={discoveryTierBadge(c.discoveryTier)}>{c.discoveryTier}</span></td>
                  <td>{c.netDiscoveryScore}</td>
                  <td>{c.promisingSimilarityScore}</td>
                  <td>{c.toxicSimilarityPenalty}</td>
                  <td>{c.marketMetadataSummary.quoteVolume24h != null ? `${(c.marketMetadataSummary.quoteVolume24h / 1_000_000).toFixed(1)}M` : 'n/a'}</td>
                  <td>{c.marketMetadataSummary.spreadBps != null ? `${c.marketMetadataSummary.spreadBps.toFixed(2)} bps` : 'n/a'}</td>
                  <td>{c.marketMetadataSummary.priceChangePct24h != null ? `${c.marketMetadataSummary.priceChangePct24h.toFixed(2)}%` : 'n/a'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {top && (
            <div style={{ marginTop: 6, fontSize: '0.82em' }}>
              <strong>Top exploratory candidate:</strong> {top.symbol} — score {top.netDiscoveryScore}/100 ({top.discoveryTier}).
              {top.matchedPromisingFingerprintFeatures.length > 0 && (
                <div>Matched promising features: {top.matchedPromisingFingerprintFeatures.join('; ')}.</div>
              )}
              {top.matchedToxicFingerprintFeatures.length > 0 && (
                <div>Matched toxic features: {top.matchedToxicFingerprintFeatures.join('; ')}.</div>
              )}
            </div>
          )}
        </>
      )}

      {report.rejectedCandidatesSample.length > 0 && (
        <>
          <h3>Rejected Candidates (sample)</h3>
          <table style={{ width: '100%', fontSize: '0.82em' }}>
            <thead><tr><th>Symbol</th><th>Verdict</th><th>Net Score</th><th>Volume 24h</th><th>Spread</th></tr></thead>
            <tbody>
              {report.rejectedCandidatesSample.map((c, i) => (
                <tr key={`${c.symbol}-${i}`}>
                  <td>{c.symbol}</td>
                  <td><span className={tradabilityVerdictBadge(c.tradabilityVerdict)}>{c.tradabilityVerdict}</span></td>
                  <td>{c.netDiscoveryScore}</td>
                  <td>{c.marketMetadataSummary.quoteVolume24h != null ? `${(c.marketMetadataSummary.quoteVolume24h / 1_000_000).toFixed(1)}M` : 'n/a'}</td>
                  <td>{c.marketMetadataSummary.spreadBps != null ? `${c.marketMetadataSummary.spreadBps.toFixed(2)} bps` : 'n/a'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {(report.categoryBuckets.highLiquidityExploratory.length > 0
        || report.categoryBuckets.highVolatilityTradable.length > 0
        || report.categoryBuckets.stableLiquidityCandidates.length > 0
        || report.categoryBuckets.dataIncompleteCandidates.length > 0) && (
        <>
          <h3>Category Buckets</h3>
          {report.categoryBuckets.highLiquidityExploratory.length > 0 && (
            <div className="metric-row"><span>High liquidity exploratory</span><strong>{report.categoryBuckets.highLiquidityExploratory.join(', ')}</strong></div>
          )}
          {report.categoryBuckets.highVolatilityTradable.length > 0 && (
            <div className="metric-row"><span>High volatility tradable</span><strong>{report.categoryBuckets.highVolatilityTradable.join(', ')}</strong></div>
          )}
          {report.categoryBuckets.stableLiquidityCandidates.length > 0 && (
            <div className="metric-row"><span>Stable liquidity candidates</span><strong>{report.categoryBuckets.stableLiquidityCandidates.join(', ')}</strong></div>
          )}
          {report.categoryBuckets.dataIncompleteCandidates.length > 0 && (
            <div className="metric-row"><span>Data incomplete</span><strong>{report.categoryBuckets.dataIncompleteCandidates.join(', ')}</strong></div>
          )}
        </>
      )}

      <h3>Patch Hypotheses</h3>
      {report.patchHypotheses.map((h, i) => (
        <div key={i} style={{ marginBottom: '0.75em', padding: '0.5em', background: 'rgba(100,116,139,0.07)', borderRadius: 4 }}>
          <strong>{h.title}</strong>
          <div style={{ fontSize: '0.85em', marginTop: 4 }}>
            <span className={`badge badge-${h.patchStatus === 'AUDIT_DEEPER' ? 'amber' : 'slate'}`}>{h.patchStatus}</span>{' '}
            <span className="badge badge-slate">{h.likelyFutureAction}</span>{' '}
            <span className="badge badge-slate">doesNotImplementNow</span>
          </div>
          <p style={{ fontSize: '0.82em', margin: '4px 0 0' }}>{h.evidenceSummary}</p>
        </div>
      ))}

      <h3>Advisory Answer Cards</h3>
      {report.answerCards.map((card, i) => (
        <div key={i} style={{ marginBottom: '0.75em' }}>
          <strong style={{ fontSize: '0.9em' }}>Q: {card.question}</strong>
          <p style={{ fontSize: '0.85em', margin: '4px 0 0', color: 'var(--text-secondary, #94a3b8)' }}>{card.answer}</p>
        </div>
      ))}

      <div style={{ marginTop: '1em', padding: '0.5em', background: 'rgba(239,68,68,0.07)', borderRadius: 4, fontSize: '0.85em' }}>
        <strong>⚠ Warning:</strong> Shortlisted symbols are not approved for automatic inclusion. They are external observation candidates only.
      </div>
    </section>
  );
}

function strategyFitBadge(tier: ExternalStrategyFitTier) {
  if (tier === 'STRATEGY_FIT_HIGH') return 'badge badge-green';
  if (tier === 'STRATEGY_FIT_MEDIUM') return 'badge badge-amber';
  if (tier === 'STRATEGY_FIT_LOW') return 'badge badge-slate';
  return 'badge badge-red';
}

function ExternalStrategyFitEnrichmentPanel({ report }: { report: ExternalStrategyFitEnrichmentReport }) {
  const top = report.topStrategyFitCandidates[0];
  return (
    <section className="panel">
      <h2>Q. External Strategy-Fit Enrichment Intelligence <span className="badge badge-slate">Phase 2E.2.5 - Advisory Only</span></h2>
      <p style={{ fontSize: '0.85em', color: 'var(--text-secondary, #94a3b8)' }}>
        Advisory only. This panel checks whether external discovery shortlist symbols also resemble the bot's current technical strategy context,
        route compatibility, and market-regime expectations. It does not modify the active symbol universe.
      </p>

      <div className="metric-row"><span>Discovery shortlist</span><strong>{report.discoverySourceSummary.discoveryShortlistCount}</strong></div>
      <div className="metric-row"><span>Enriched candidates</span><strong className="badge badge-green">{report.enrichedCandidateCount}</strong></div>
      <div className="metric-row"><span>Failed candidates</span><strong className={report.failedCandidateCount > 0 ? 'badge badge-red' : 'badge badge-slate'}>{report.failedCandidateCount}</strong></div>
      <div className="metric-row"><span>Readiness confidence</span><strong className={fingerprintConfidenceBadge(report.enrichmentReadiness.confidence)}>{report.enrichmentReadiness.confidence}</strong></div>
      <div className="metric-row"><span>Ready for rotation shadow overlay</span><strong className="badge badge-slate">false</strong></div>
      <div className="metric-row"><span>Ready for universe influence</span><strong className="badge badge-slate">false</strong></div>
      <div className="metric-row"><span>Metadata shortlist differs from strategy-fit</span><strong>{String(report.metadataShortlistDivergesFromStrategyFit)}</strong></div>

      {top && (
        <>
          <h3>Top Strategy-Fit Candidates</h3>
          <table style={{ width: '100%', fontSize: '0.82em' }}>
            <thead><tr><th>Symbol</th><th>Fit</th><th>Tier</th><th>Direction</th><th>Route</th><th>Geometry</th><th>Reason</th></tr></thead>
            <tbody>
              {report.topStrategyFitCandidates.slice(0, 5).map((c) => (
                <tr key={c.symbol}>
                  <td>{c.symbol}</td>
                  <td>{c.strategyFitScore}</td>
                  <td><span className={strategyFitBadge(c.strategyFitTier)}>{c.strategyFitTier}</span></td>
                  <td>{c.directionalContext}</td>
                  <td>{c.bestObservedExternalRouteHypothesis.selectedEntryVariant ?? 'n/a'} + {c.bestObservedExternalRouteHypothesis.selectedExitVariant ?? 'n/a'}</td>
                  <td>{c.stopGeometryCredibilityHint}</td>
                  <td>{c.reasons[0] ?? 'No reason available'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {report.lowFitCandidates.length > 0 && (
        <>
          <h3>Low Fit / Not Evaluable Examples</h3>
          {report.lowFitCandidates.slice(0, 4).map((c) => (
            <div key={c.symbol} style={{ fontSize: '0.82em', marginBottom: 4 }}>
              <strong>{c.symbol}</strong>: {c.strategyFitTier} ({c.strategyFitScore}) - {c.reasons[0] ?? c.technicalDataStatus}
            </div>
          ))}
        </>
      )}

      <h3>Diagnostics</h3>
      <div className="metric-row"><span>Candidates requested / evaluated</span><strong>{report.diagnostics.candidatesRequested} / {report.diagnostics.candidatesEvaluated}</strong></div>
      <div className="metric-row"><span>Technical fetch failures</span><strong>{report.diagnostics.technicalFetchFailureCount}</strong></div>
      <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #94a3b8)' }}>
        Strategy-fit enrichment is a current snapshot, not prospective performance proof.
      </div>

      <h3>Patch Hypotheses</h3>
      {report.patchHypotheses.slice(0, 3).map((h, i) => (
        <div key={i} style={{ marginBottom: '0.75em', padding: '0.5em', background: 'rgba(100,116,139,0.07)', borderRadius: 4 }}>
          <strong>{h.title}</strong>
          <div style={{ fontSize: '0.85em', marginTop: 4 }}>
            <span className="badge badge-slate">{h.patchStatus}</span>{' '}
            <span className="badge badge-slate">doesNotImplementNow</span>
          </div>
          <p style={{ fontSize: '0.82em', margin: '4px 0 0' }}>{h.evidenceSummary}</p>
        </div>
      ))}
    </section>
  );
}

function overlayVerdictBadge(v: ExternalRotationOverlayVerdict) {
  if (v === 'WATCHABLE_SUPPORTIVE' || v === 'EARLY_SUPPORTIVE') return 'badge badge-green';
  if (v === 'WATCHABLE_HARMFUL' || v === 'EARLY_HARMFUL') return 'badge badge-red';
  if (v === 'TOO_EARLY') return 'badge badge-amber';
  return 'badge badge-slate';
}

function ExternalRotationOverlayPanel({ report }: { report: ExternalRotationOverlayPerformanceReport }) {
  const best = report.currentBestObservedGroup;
  return (
    <section className="panel">
      <h2>R. External Rotation Shadow Overlay <span className="badge badge-slate">Phase 2E.3 - Research Only</span></h2>
      <p style={{ fontSize: '0.85em', color: 'var(--text-secondary, #94a3b8)' }}>
        Research-only prospective validation. This panel tracks enriched external candidates forward over time and compares strategy-fit shortlist
        performance against metadata-only discovery baselines. It does not alter the active symbol universe.
      </p>

      <div className="metric-row"><span>Total observations</span><strong>{report.totalObservations}</strong></div>
      <div className="metric-row"><span>Open / resolved / no-fill</span><strong>{report.openObservations} / {report.resolvedObservations} / {report.noFillObservations}</strong></div>
      <div className="metric-row"><span>Overlay data collection status</span><strong className={report.totalObservations > 0 ? 'badge badge-green' : 'badge badge-slate'}>{report.totalObservations > 0 ? 'COLLECTING' : 'NOT_STARTED'}</strong></div>
      <div className="metric-row"><span>Ready for universe influence</span><strong className="badge badge-slate">false</strong></div>

      <h3>Collection Diagnostics</h3>
      <div className="metric-row"><span>Last refresh</span><strong>{report.duplicateSuppressionStats.lastRefreshAt ?? 'none'}</strong></div>
      <div className="metric-row"><span>Considered / created / duplicate-suppressed</span><strong>{report.duplicateSuppressionStats.observationsConsidered} / {report.duplicateSuppressionStats.observationsCreated} / {report.duplicateSuppressionStats.observationsSuppressedAsDuplicate}</strong></div>

      <h3>Group Comparison</h3>
      <table style={{ width: '100%', fontSize: '0.82em' }}>
        <thead><tr><th>Group</th><th>Obs</th><th>Resolved</th><th>Net Avg R</th><th>PF</th><th>Win</th><th>No-fill</th><th>Verdict</th></tr></thead>
        <tbody>
          {report.groupPerformance.map((g) => (
            <tr key={g.group}>
              <td>{g.group}</td>
              <td>{g.observationCount}</td>
              <td>{g.resolvedCount}</td>
              <td>{g.netAvgR?.toFixed(4) ?? 'n/a'}</td>
              <td>{g.profitFactor?.toFixed(2) ?? 'n/a'}</td>
              <td>{g.winRate != null ? `${(g.winRate * 100).toFixed(0)}%` : 'n/a'}</td>
              <td>{g.noFillRate != null ? `${(g.noFillRate * 100).toFixed(0)}%` : 'n/a'}</td>
              <td><span className={overlayVerdictBadge(g.earlyVerdict)}>{g.earlyVerdict}</span></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Best Observed Group</h3>
      <div style={{ fontSize: '0.85em', color: 'var(--text-secondary, #94a3b8)' }}>
        {best ? `${best.group}: netAvgR=${best.netAvgR?.toFixed(4) ?? 'n/a'}, resolved=${best.resolvedCount}, verdict=${best.earlyVerdict}` : 'No resolved forward overlay evidence yet.'}
      </div>

      <h3>Readiness Blockers</h3>
      {report.readiness.reasons.slice(0, 3).map((r, i) => (
        <div key={i} style={{ fontSize: '0.82em', color: 'var(--text-secondary, #94a3b8)', marginBottom: 2 }}>{r}</div>
      ))}

      <h3>Patch Hypotheses</h3>
      {report.patchHypotheses.slice(0, 3).map((h, i) => (
        <div key={i} style={{ marginBottom: '0.75em', padding: '0.5em', background: 'rgba(100,116,139,0.07)', borderRadius: 4 }}>
          <strong>{h.title}</strong>
          <div style={{ fontSize: '0.85em', marginTop: 4 }}>
            <span className="badge badge-slate">{h.patchStatus}</span>{' '}
            <span className="badge badge-slate">doesNotImplementNow</span>
          </div>
          <p style={{ fontSize: '0.82em', margin: '4px 0 0' }}>{h.evidenceSummary}</p>
        </div>
      ))}

      <div style={{ marginTop: '1em', padding: '0.5em', background: 'rgba(239,68,68,0.07)', borderRadius: 4, fontSize: '0.85em' }}>
        <strong>Warning:</strong> Overlay performance is prospective research evidence only. It does not justify adding external symbols
        to the active universe until resolved sample is mature.
      </div>
    </section>
  );
}

function maturityBadgeClass(status: MaturityStatus): string {
  switch (status) {
    case 'PROMOTABLE': return 'badge badge-green';
    case 'PROMISING': return 'badge badge-cyan';
    case 'DEGRADING': return 'badge badge-amber';
    case 'WEAK': return 'badge badge-red';
    case 'COLLECTING':
    default: return 'badge badge-slate';
  }
}

function RouteMaturityPanel({
  maturity,
  eraFilter,
  onEraChange,
}: {
  maturity: RouteMaturityReport;
  eraFilter: RouteMaturityEraFilter;
  onEraChange: (era: RouteMaturityEraFilter) => void;
}) {
  const fmtR = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
  const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const fmtPF = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2));
  const fmtDays = (v: number | null) =>
    v === null ? 'no pace' : v === 0 ? 'reached' : `${v}d`;
  const isLeading = (c: CohortMaturity) =>
    !!maturity.leadingCohort &&
    maturity.leadingCohort.entryVariant === c.entryVariant &&
    maturity.leadingCohort.exitVariant === c.exitVariant;

  // Show priority + currently-selected + any cohort with closed > 0, plus the leading one.
  const visibleCohorts = maturity.cohorts.filter(
    (c) => c.isPriorityCohort || c.isCurrentlySelected || c.closedCount > 0,
  );

  return (
    <section className="panel table-panel">
      <div className="section-header">
        <div>
          <p className="eyebrow">Route evidence accumulation</p>
          <h2>Shadow Route Maturity</h2>
        </div>
        <span className="mini-status">
          {maturity.leadingCohort
            ? `Leading: ${maturity.leadingCohort.entryVariant} + ${maturity.leadingCohort.exitVariant}`
            : 'No leading cohort yet'}
        </span>
      </div>
      <div className="input-row" style={{ marginBottom: '0.75rem', gap: 6 }}>
        <span style={{ fontSize: 11, opacity: 0.7, marginRight: 4 }}>Era filter:</span>
        {(['POST_CALIBRATION', 'POST_ROUTING', 'ALL_TIME'] as RouteMaturityEraFilter[]).map((era) => (
          <button
            key={era}
            type="button"
            className={eraFilter === era ? 'badge badge-green' : 'badge badge-slate'}
            style={{ cursor: 'pointer', border: 'none', font: 'inherit' }}
            onClick={() => onEraChange(era)}
          >
            {era === 'POST_CALIBRATION' ? 'Post-calibration' : era === 'POST_ROUTING' ? 'Post-routing' : 'All-time'}
          </button>
        ))}
        <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 8 }}>
          Showing: <strong>{eraFilter}</strong>
        </span>
      </div>
      <p className="candidate-copy" style={{ marginBottom: '0.5rem' }}>
        <strong>Route Maturity</strong> = shadow evidence accumulation before promotion.{' '}
        <strong>Live Auto Readiness</strong> = final full-auto eligibility after promotion.
      </p>
      <p className="candidate-copy" style={{ marginBottom: '1rem', opacity: 0.75 }}>
        Scope: DATA_COLLECTION + PROFIT_CANDIDATE on each cohort. RESEARCH_ONLY excluded. The leading
        cohort is highlighted, but no cohort here is live-ready until it also passes Live Auto Readiness gates.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(148,163,184,0.2)' }}>
              <th style={{ padding: '6px 8px' }}>Route</th>
              <th style={{ padding: '6px 8px' }}>Status</th>
              <th style={{ padding: '6px 8px' }}>Closed / 30 / 100</th>
              <th style={{ padding: '6px 8px' }}>Net Avg R</th>
              <th style={{ padding: '6px 8px' }}>PF</th>
              <th style={{ padding: '6px 8px' }}>TP1 prof.</th>
              <th style={{ padding: '6px 8px' }}>SL rate</th>
              <th style={{ padding: '6px 8px' }}>Recent (7d)</th>
              <th style={{ padding: '6px 8px' }}>Route modes</th>
              <th style={{ padding: '6px 8px' }}>ETA 30 / 100</th>
            </tr>
          </thead>
          <tbody>
            {visibleCohorts.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: '10px 8px', opacity: 0.7 }}>No cohorts collected yet.</td>
              </tr>
            ) : visibleCohorts.map((c) => {
              const leading = isLeading(c);
              return (
                <tr
                  key={`${c.entryVariant}__${c.exitVariant}`}
                  style={{
                    borderBottom: '1px solid rgba(148,163,184,0.08)',
                    background: leading ? 'rgba(74,222,128,0.06)' : undefined,
                  }}
                >
                  <td style={{ padding: '6px 8px' }}>
                    <div><strong>{c.entryVariant}</strong></div>
                    <div style={{ opacity: 0.75 }}>+ {c.exitVariant}</div>
                    {leading && (
                      <span className="badge badge-green" style={{ marginTop: 4, fontSize: 10 }}>
                        Leading cohort
                      </span>
                    )}
                    {c.isPriorityCohort && !leading && (
                      <span className="badge badge-slate" style={{ marginTop: 4, fontSize: 10 }}>Priority</span>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <span className={maturityBadgeClass(c.maturityStatus)}>{c.maturityStatus}</span>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {c.closedCount} / 30 / 100
                  </td>
                  <td style={{ padding: '6px 8px', color: (c.netAvgR ?? 0) > 0 ? '#86efac' : (c.netAvgR ?? 0) < 0 ? '#fca5a5' : undefined }}>
                    {fmtR(c.netAvgR)}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{fmtPF(c.profitFactor)}</td>
                  <td style={{ padding: '6px 8px' }}>{fmtPct(c.profitableTp1Rate)}</td>
                  <td style={{ padding: '6px 8px' }}>{fmtPct(c.slRate)}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {c.recentClosedCount} closes
                    <div style={{ opacity: 0.75 }}>{fmtR(c.recentNetAvgR)} R</div>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    DC {c.routeModeDistribution.DATA_COLLECTION} / PC {c.routeModeDistribution.PROFIT_CANDIDATE}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {fmtDays(c.estimatedDaysTo30Closed)} / {fmtDays(c.estimatedDaysTo100Closed)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="candidate-copy" style={{ marginTop: '0.75rem', opacity: 0.65, fontSize: 12 }}>
        Status legend: COLLECTING (&lt;15 closed) · PROMISING (≥15, net&gt;0, PF&gt;1) · PROMOTABLE (≥30, net&gt;0.10, PF&gt;1.2, TP1 prof.&gt;50%, SL&lt;40%) · DEGRADING (all-time net&gt;0 but recent net&lt;0) · WEAK (otherwise).
      </p>
    </section>
  );
}

async function fetchLiveReadiness(): Promise<LiveReadinessReport | null> {
  try {
    const response = await fetch('/api/shadow/live-readiness');
    if (!response.ok) return null;
    return (await response.json()) as LiveReadinessReport;
  } catch {
    return null;
  }
}

const GATE_LABELS: Record<LiveReadinessGateCode, string> = {
  CLOSED_SAMPLE_SUFFICIENT: 'Closed sample ≥ 100',
  NET_AVG_R_POSITIVE: 'Net avg R > 0.15',
  PROFIT_FACTOR_OK: 'Profit factor > 1.3',
  TP1_PROFITABLE_RATE_OK: 'TP1 profitable rate > 55%',
  SL_RATE_OK: 'SL rate < 35%',
  MAX_LOSING_STREAK_OK: 'Max losing streak ≤ 4',
  RECENT_DAYS_POSITIVE: '≥ 7/10 recent days positive',
  WORST_DAY_OK: 'Worst day > -2R',
  DATA_COVERAGE_OK: 'Data coverage ≥ 95%',
  KRONOS_HEALTHY: 'Kronos healthy',
};

const WARNING_LABELS: Record<LiveReadinessWarningCode, string> = {
  DAILY_NET_R_BELOW_NEG_2: 'Today daily net R ≤ -2R',
  THREE_CONSECUTIVE_LOSSES: 'Last 3 closes are losses',
  KRONOS_DEGRADED: 'Kronos degraded / offline',
  BINANCE_COVERAGE_LOW: 'Binance coverage < 95%',
  SPREAD_ABNORMAL: 'Spread abnormal',
  ROUTE_EXPECTANCY_NEGATIVE: 'Route expectancy negative',
};

function RouteAlignmentBadge({ status }: { status: RouteAlignmentStatus }) {
  if (status === 'MATCH') return <span className="badge badge-green">MATCH</span>;
  if (status === 'MISMATCH') return <span className="badge badge-amber">MISMATCH</span>;
  return <span className="badge badge-slate">NO LEADING COHORT</span>;
}

function LiveReadinessPanel({ readiness }: { readiness: LiveReadinessReport }) {
  const scoreColor =
    readiness.score >= 90 ? '#4ade80' : readiness.score >= 60 ? '#fbbf24' : '#f87171';
  const fmtR = (v: number | null) => (v === null ? 'n/a' : v.toFixed(4));
  const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
  const isMismatch = readiness.routeAlignmentStatus === 'MISMATCH';
  return (
    <section className="panel table-panel">
      <div className="section-header">
        <div>
          <p className="eyebrow">Future live promotion (advisory)</p>
          <h2>Live Auto Readiness</h2>
        </div>
        <span className="mini-status">
          <span className={readiness.liveReady ? 'badge badge-green' : 'badge badge-amber'}>
            {readiness.liveReady ? 'READY' : 'NOT READY'}
          </span>
        </span>
      </div>
      <p className="candidate-copy" style={{ marginBottom: '0.5rem' }}>
        <strong>Live Auto Readiness</strong> evaluates a single fixed route — it does <em>not</em> automatically
        follow whichever route currently leads Shadow Route Maturity. Advisory only; shadow execution
        continues regardless of this score.
      </p>
      <p className="candidate-copy" style={{ marginBottom: '0.5rem' }}>
        <strong>Locked evaluation route:</strong>{' '}
        <strong>{readiness.lockedEvaluationRoute.label}</strong>{' '}
        on <strong>PROFIT_CANDIDATE primary trades only</strong>. If this cohort has zero closes yet,
        the gates will all read 0/n/a — that is expected, not a bug.
      </p>
      <p className="candidate-copy" style={{ marginBottom: '0.75rem', opacity: 0.75 }}>
        All other routes (DATA_COLLECTION and non-locked PROFIT_CANDIDATE) are tracked in the{' '}
        <strong>Shadow Route Maturity</strong> panel above, not here.
      </p>

      {/* ── Route Alignment ───────────────────────────────────────────────── */}
      <div
        style={{
          marginBottom: '1rem',
          padding: '0.65rem 0.9rem',
          borderRadius: 6,
          background: isMismatch ? 'rgba(251,191,36,0.08)' : 'rgba(148,163,184,0.06)',
          border: isMismatch ? '1px solid rgba(251,191,36,0.35)' : '1px solid rgba(148,163,184,0.15)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.35rem' }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', opacity: 0.7, textTransform: 'uppercase' }}>
            Route alignment
          </span>
          <RouteAlignmentBadge status={readiness.routeAlignmentStatus} />
        </div>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.85, lineHeight: 1.5 }}>
          {readiness.routeAlignmentMessage}
        </p>
        {readiness.leadingMaturityCohort && (
          <div style={{ marginTop: '0.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: 12 }}>
            <span style={{ opacity: 0.7 }}>Maturity leader:</span>
            <strong>{readiness.leadingMaturityCohort.label}</strong>
            <span style={{ opacity: 0.6 }}>·</span>
            <span>{readiness.leadingMaturityCohort.closedCount} closed</span>
            <span style={{ opacity: 0.6 }}>·</span>
            <span>net {fmtR(readiness.leadingMaturityCohort.netAvgR)}R</span>
            <span style={{ opacity: 0.6 }}>·</span>
            <span>PF {readiness.leadingMaturityCohort.profitFactor === null ? 'n/a' : readiness.leadingMaturityCohort.profitFactor.toFixed(2)}</span>
            <span style={{ opacity: 0.6 }}>·</span>
            <span className={
              readiness.leadingMaturityCohort.maturityStatus === 'PROMOTABLE' ? 'badge badge-green' :
              readiness.leadingMaturityCohort.maturityStatus === 'PROMISING' ? 'badge badge-cyan' :
              readiness.leadingMaturityCohort.maturityStatus === 'DEGRADING' ? 'badge badge-red' :
              readiness.leadingMaturityCohort.maturityStatus === 'WEAK' ? 'badge badge-amber' :
              'badge badge-slate'
            }>{readiness.leadingMaturityCohort.maturityStatus}</span>
          </div>
        )}
      </div>
      <div className="detail-sections">
        <section className="detail-card">
          <h3>Score</h3>
          <div className="metric-list">
            <div className="metric-row">
              <span>Readiness score</span>
              <strong style={{ color: scoreColor, fontSize: 18 }}>{readiness.score}/100</strong>
            </div>
            <div className="metric-row">
              <span>Live ready</span>
              <strong>
                <span className={readiness.liveReady ? 'badge badge-green' : 'badge badge-slate'}>
                  {readiness.liveReady ? 'TRUE' : 'FALSE'}
                </span>
              </strong>
            </div>
            <div className="metric-row">
              <span>Closed sample</span>
              <strong>{readiness.closedSampleCount} / {readiness.targetClosedSampleCount}</strong>
            </div>
            <div className="metric-row">
              <span>Recent pace</span>
              <strong>
                {readiness.recentClosesPerDay === null
                  ? 'no recent closes'
                  : `${readiness.recentClosesPerDay.toFixed(2)} closes / day`}
              </strong>
            </div>
            <div className="metric-row">
              <span>Estimated days to target</span>
              <strong>
                {readiness.estimatedDaysToTarget === null
                  ? readiness.closedSampleCount >= readiness.targetClosedSampleCount
                    ? 'target reached'
                    : 'no recent pace'
                  : `${readiness.estimatedDaysToTarget} days`}
              </strong>
            </div>
            <div className="metric-row"><span>Net avg R</span><strong>{fmtR(readiness.metrics.netAvgR)}</strong></div>
            <div className="metric-row"><span>Profit factor</span><strong>{readiness.metrics.profitFactor === null ? 'n/a' : readiness.metrics.profitFactor.toFixed(4)}</strong></div>
            <div className="metric-row"><span>TP1 profitable rate</span><strong>{fmtPct(readiness.metrics.tp1ProfitableRate)}</strong></div>
            <div className="metric-row"><span>SL rate</span><strong>{fmtPct(readiness.metrics.slRate)}</strong></div>
            <div className="metric-row"><span>Max losing streak</span><strong>{readiness.metrics.maxLosingStreak}</strong></div>
            <div className="metric-row"><span>Recent days positive</span><strong>{readiness.metrics.recentPositiveDays}/{readiness.metrics.recentTotalDays}</strong></div>
            <div className="metric-row"><span>Worst day net R</span><strong>{readiness.metrics.worstDayNetR === null ? 'n/a' : `${readiness.metrics.worstDayNetR.toFixed(2)}R`}</strong></div>
          </div>
        </section>

        <section className="detail-card">
          <h3>Passed gates ({readiness.passedGates.length}/10)</h3>
          <div className="pill-column">
            {readiness.passedGates.length === 0 ? (
              <span className="info-pill">No gates passed yet.</span>
            ) : readiness.passedGates.map((code) => (
              <span key={code} className="info-pill">
                ✓ {GATE_LABELS[code]}
              </span>
            ))}
          </div>
        </section>

        <section className="detail-card">
          <h3>Failed gates ({readiness.failedGates.length}/10)</h3>
          <div className="pill-column">
            {readiness.failedGates.length === 0 ? (
              <span className="info-pill">All gates pass.</span>
            ) : readiness.gates
              .filter((g) => g.status === 'FAIL')
              .map((g) => (
                <span key={g.code} className="info-pill info-pill-warn">
                  ✗ {GATE_LABELS[g.code]} — {g.actual}
                </span>
              ))}
          </div>
        </section>

        <section className="detail-card">
          <h3>Warning events</h3>
          <div className="pill-column">
            {readiness.warningEvents.length === 0 ? (
              <span className="info-pill">No active warnings.</span>
            ) : readiness.warningEvents.map((code) => (
              <span key={code} className="info-pill info-pill-warn">
                ⚠ {WARNING_LABELS[code]}
              </span>
            ))}
          </div>
          <p className="candidate-copy" style={{ marginTop: '0.6rem', opacity: 0.75 }}>
            Warning events are informational. They do NOT stop shadow collection, cap open positions,
            or block new shadow trades.
          </p>
        </section>
      </div>
    </section>
  );
}

type ActionPlanGroup = 'Paper trade review' | 'Wait for trigger' | 'Avoid / watch only';

interface ActionPlanItem {
  candidate: Candidate;
  group: ActionPlanGroup;
  actionLabel: string;
  caution: string;
  note?: string;
  paperOnly: boolean;
  edge: EdgeScoreSnapshot | null;
  tradePlan: TradePlanSnapshot;
  execution: VariantSelectionSnapshot;
}

function formatVariantLabel(key: string | null | undefined, variants: ShadowVariantStats[] | undefined) {
  if (!key || !variants) return 'Unknown';
  return variants.find((variant) => variant.key === key)?.label ?? key;
}

function formatExecutionEntryVariantLabel(key: VariantSelectionSnapshot['selectedEntryVariant']) {
  switch (key) {
    case 'base_current_entry': return 'Base current entry';
    case 'fib_382_entry': return 'Fib 0.382 entry';
    case 'fib_500_entry': return 'Fib 0.500 entry';
    case 'fib_618_entry': return 'Fib 0.618 entry';
    case 'vwap_retest_entry': return 'VWAP retest entry';
    case 'ema20_pullback_entry': return 'EMA20 pullback entry';
    case 'no_chase_atr_entry': return 'No-chase ATR entry';
  }
}

function formatExecutionExitVariantLabel(key: VariantSelectionSnapshot['selectedExitVariant']) {
  switch (key) {
    case 'tp1_full_exit': return 'TP1 full exit';
    case 'tp1_50_tp2_runner': return 'TP1 50% + TP2 runner';
    case 'tp1_70_runner30': return 'TP1 70% + runner 30%';
    case 'trail_after_tp1': return 'Trail after TP1';
    case 'kronos_runner_exit': return 'Kronos runner exit';
    case 'kronos_flip_exit': return 'Kronos flip exit';
    case 'whale_conflict_exit': return 'Whale conflict exit';
    case 'vwap_loss_exit': return 'VWAP / EMA loss exit';
  }
}

function formatSelectionSource(source: VariantSelectionSnapshot['selectionSource']) {
  return source === 'replay' ? 'replay-backed' : 'heuristic fallback';
}

function routeModeLabel(mode: VariantSelectionSnapshot['routeMode'] | undefined | null): string {
  switch (mode) {
    case 'PROFIT_CANDIDATE':
      return 'Primary profit route';
    case 'DATA_COLLECTION':
      return 'Collecting evidence';
    case 'RESEARCH_ONLY':
      return 'Research only / negative route';
    default:
      return 'Route unknown';
  }
}

function routeModeBadgeClass(mode: VariantSelectionSnapshot['routeMode'] | undefined | null): string {
  switch (mode) {
    case 'PROFIT_CANDIDATE':
      return 'badge badge-green';
    case 'DATA_COLLECTION':
      return 'badge badge-slate';
    case 'RESEARCH_ONLY':
      return 'badge badge-amber';
    default:
      return 'badge badge-slate';
  }
}

function RoutePanel({ diagnostics }: { diagnostics: ScannerDiagnostics }) {
  const simColor =
    diagnostics.profitCandidateSimilarityScore >= 70
      ? '#4ade80'
      : diagnostics.profitCandidateSimilarityScore >= 45
        ? '#94a3b8'
        : '#fbbf24';
  const riskColor =
    diagnostics.researchRiskScore >= 60 ? '#f87171' : diagnostics.researchRiskScore >= 30 ? '#fbbf24' : '#4ade80';
  return (
    <div style={{ margin: '8px 0', padding: '10px 12px', background: 'rgba(99,102,241,0.08)', borderRadius: 8, border: '1px solid rgba(99,102,241,0.18)' }}>
      <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: 1, color: '#a5b4fc', marginBottom: 6 }}>WHY ROUTED THIS WAY</div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12 }}>Profit similarity: <strong style={{ color: simColor }}>{diagnostics.profitCandidateSimilarityScore}/100</strong></span>
        <span style={{ fontSize: 12 }}>Risk score: <strong style={{ color: riskColor }}>{diagnostics.researchRiskScore}/100</strong></span>
      </div>
      {diagnostics.topPositiveEvidence.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: '#86efac', fontWeight: 600, marginBottom: 2 }}>Positive evidence</div>
          {diagnostics.topPositiveEvidence.map((e, i) => (
            <div key={i} style={{ fontSize: 11, color: '#dcfce7', paddingLeft: 8 }}>+ {e}</div>
          ))}
        </div>
      )}
      {diagnostics.topNegativeEvidence.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: '#fca5a5', fontWeight: 600, marginBottom: 2 }}>Negative evidence</div>
          {diagnostics.topNegativeEvidence.map((e, i) => (
            <div key={i} style={{ fontSize: 11, color: '#fee2e2', paddingLeft: 8 }}>− {e}</div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 4, borderTop: '1px solid rgba(148,163,184,0.12)', paddingTop: 6 }}>
        <span style={{ color: '#7dd3fc', fontWeight: 600 }}>Path to profit: </span>
        {diagnostics.closestPathToProfitCandidate}
      </div>
    </div>
  );
}

function getBestAvgRStatus(perf: PerformanceStats): Candidate['status'] | null {
  const ordered: Candidate['status'][] = ['TRADE_NOW', 'READY', 'WAIT', 'WATCH'];
  return ordered
    .filter((status) => perf.byStatus[status] && perf.byStatus[status].avgNetRResult !== null)
    .sort((a, b) => (perf.byStatus[b].avgNetRResult ?? Number.NEGATIVE_INFINITY) - (perf.byStatus[a].avgNetRResult ?? Number.NEGATIVE_INFINITY))[0] ?? null;
}

function getWorstStatus(perf: PerformanceStats): Candidate['status'] | null {
  const ordered: Candidate['status'][] = ['TRADE_NOW', 'READY', 'WAIT', 'WATCH'];
  return ordered
    .filter((status) => perf.byStatus[status] && perf.byStatus[status].resolved > 0)
    .sort((a, b) => {
      const avgDiff = (perf.byStatus[a].avgNetRResult ?? Number.POSITIVE_INFINITY) - (perf.byStatus[b].avgNetRResult ?? Number.POSITIVE_INFINITY);
      if (avgDiff !== 0) return avgDiff;
      return perf.byStatus[a].tp1Rate - perf.byStatus[b].tp1Rate;
    })[0] ?? null;
}

function candidateExecution(candidate: Candidate, perf: PerformanceStats | null): VariantSelectionSnapshot {
  return candidate.selectedExecutionPlan ?? buildVariantSelection(candidate, perf);
}

function deriveActionPlan(candidates: Candidate[], perf: PerformanceStats | null, marketRegime: string): ActionPlanItem[] {
  const rankedCandidates = perf
    ? [...candidates]
        .map((candidate) => ({
          candidate,
          edge: buildEdgeScore(candidate, perf, marketRegime),
          execution: candidateExecution(candidate, perf),
        }))
        .sort((left, right) => {
          const leftNet = left.execution.expectedNetR ?? Number.NEGATIVE_INFINITY;
          const rightNet = right.execution.expectedNetR ?? Number.NEGATIVE_INFINITY;
          if (rightNet !== leftNet) return rightNet - leftNet;
          const leftQuality = (left.execution.entryDriftAtr !== null ? Math.max(0, 3 - left.execution.entryDriftAtr) : 0) + (left.edge.score / 100);
          const rightQuality = (right.execution.entryDriftAtr !== null ? Math.max(0, 3 - right.execution.entryDriftAtr) : 0) + (right.edge.score / 100);
          if (rightQuality !== leftQuality) return rightQuality - leftQuality;
          return right.edge.score - left.edge.score;
        })
        .slice(0, 3)
    : candidates.slice(0, 3).map((candidate) => ({ candidate, edge: null, execution: candidateExecution(candidate, null) }));
  if (!perf) {
    return rankedCandidates.map(({ candidate, edge, execution }) => ({
      candidate,
      group: candidate.status === 'WATCH' ? 'Avoid / watch only' : candidate.status === 'WAIT' ? 'Wait for trigger' : 'Paper trade review',
      actionLabel: candidate.status === 'WAIT' ? 'wait for trigger' : candidate.status === 'WATCH' ? 'watch only' : 'review only',
      caution: 'Performance analytics are still loading.',
      note: undefined,
      paperOnly: true,
      edge,
      tradePlan: buildTradePlan(candidate),
      execution,
    }));
  }

  const bestAvgRStatus = getBestAvgRStatus(perf);
  const worstStatus = getWorstStatus(perf);
  const longStats = perf.byDirection.LONG;
  const shortStats = perf.byDirection.SHORT;
  const longStats4h = perf.windows["4h"].byDirection.LONG;
  const shortStats4h = perf.windows["4h"].byDirection.SHORT;
  const symbolStatsLookup = new Map(
    [...perf.bySymbol, ...perf.earlySampleSymbols].map((entry) => [entry.symbol, entry] as const),
  );

  return rankedCandidates.map(({ candidate, edge, execution }) => {
    const tradePlan = buildTradePlan(candidate);
    const statusStats = perf.byStatus[candidate.status];
    const directionStats = candidate.finalDirection === 'SHORT' ? shortStats : longStats;
    const symbolStats = symbolStatsLookup.get(candidate.symbol);
    const earlyOrWeak = statusStats.sampleTier === 'EARLY_SIGNAL' || (statusStats.avgNetRResult ?? 0) <= 0 || worstStatus === candidate.status;
    const waitPriority = candidate.status === 'WAIT' && bestAvgRStatus === 'WAIT';
    const shortDirectionWeak = candidate.finalDirection === 'SHORT' && (shortStats.avgNetRResult ?? 0) < 0;
    const longDirectionSupportive = candidate.finalDirection === 'LONG' && (longStats.avgNetRResult ?? 0) > 0;
    const symbolPositive = !!symbolStats && symbolStats.resolved >= 10 && (symbolStats.avgNetRResult ?? 0) > 0;
    const symbolNegative = !!symbolStats && symbolStats.resolved >= 10 && (symbolStats.avgNetRResult ?? 0) < 0;
    const statusNetPositive = (statusStats.avgNetRResult ?? 0) > 0;
    const directionNetPositive = (directionStats.avgNetRResult ?? 0) > 0;
    const whaleAgrees =
      (candidate.finalDirection === 'LONG' && candidate.whale.signal === 'BULLISH') ||
      (candidate.finalDirection === 'SHORT' && candidate.whale.signal === 'BEARISH');
    const whaleDisagrees =
      (candidate.finalDirection === 'LONG' && candidate.whale.signal === 'BEARISH') ||
      (candidate.finalDirection === 'SHORT' && candidate.whale.signal === 'BULLISH');
    const strongWhaleAgreement = whaleAgrees && candidate.whale.score >= 65;
    const strongKronosAgreement =
      (candidate.selectedKronosBias ?? candidate.kronosBias) !== 'UNAVAILABLE' &&
      candidate.kronosConfidenceBucket === 'STRONG' &&
      (candidate.selectedKronosBias ?? candidate.kronosBias) === candidate.finalDirection &&
      !candidate.horizonConflict;
    const mediumKronosConflict =
      candidate.kronosBias !== 'UNAVAILABLE' &&
      candidate.kronosConfidenceBucket === 'MEDIUM' &&
      ((candidate.selectedKronosBias ?? candidate.kronosBias) !== candidate.finalDirection || candidate.sourceConflict || candidate.directionConflict || !!candidate.horizonConflict);
    const kronosShortHorizonOnly = shortHorizonOnly(candidate);
    const lowVolumeConfirmation =
      candidate.volume.volumeRatio5m !== null && candidate.volume.volumeRatio5m < 1;
    const hasSoftConfirmationWeakness =
      candidate.reason.some((reason) => reason.toLowerCase().includes('volume')) ||
      candidate.blockers.some((blocker) => blocker.toLowerCase().includes('volume')) ||
      candidate.blockers.some((blocker) => blocker.toLowerCase().includes('confirmation')) ||
      candidate.blockers.some((blocker) => blocker.toLowerCase().includes('trend conflict'));
    const tradeNowNeedsSoftening = candidate.status === 'TRADE_NOW' && (earlyOrWeak || hasSoftConfirmationWeakness);
    const shortCanEscapeDowngrade = strongWhaleAgreement && symbolPositive && candidate.dangerScore <= 35 && (candidate.riskReward ?? 0) >= 1.5;
    const netPreferredCandidate =
      !!symbolStats &&
      symbolStats.resolved >= 10 &&
      (symbolStats.avgNetRResult ?? 0) > 0 &&
      directionNetPositive &&
      statusNetPositive &&
      candidate.dangerScore <= 40 &&
      (candidate.riskReward ?? 0) >= 1.5 &&
      (execution.expectedNetR ?? Number.NEGATIVE_INFINITY) > 0;

    let note: string | undefined;
    if (symbolNegative) {
      note = 'symbol underperforming in shadow data';
    } else if (symbolPositive) {
      note = 'symbol showing early positive edge';
    }
    if (whaleAgrees) {
      note = note ? `${note} | whale confirms direction` : 'whale confirms direction';
    } else if (whaleDisagrees) {
      note = note ? `${note} | whale disagrees with direction` : 'whale disagrees with direction';
    }
    if (strongKronosAgreement) {
      const kronosNote = lowVolumeConfirmation
        ? 'forecast agrees, wait for volume confirmation'
        : 'Kronos STRONG agrees with direction';
      note = note ? `${note} | ${kronosNote}` : kronosNote;
    }
    if (kronosShortHorizonOnly) {
      const kronosNote = 'short-horizon bias only; TP1 fast, no runner';
      note = note ? `${note} | ${kronosNote}` : kronosNote;
    }
    if (mediumKronosConflict) {
      const kronosCaution = 'Kronos MEDIUM conflicts with whale or technical structure';
      note = note ? `${note} | ${kronosCaution}` : kronosCaution;
    }
    const continuationStats = candidate.finalDirection === 'SHORT' ? shortStats4h : longStats4h;
    if ((continuationStats.avgRResult ?? 0) > 0) {
      const continuationNote = '4h continuation context remains supportive';
      note = note ? `${note} | ${continuationNote}` : continuationNote;
    }
    if (!netPreferredCandidate) {
      const netNote = 'net edge not validated yet after fees and slippage';
      note = note ? `${note} | ${netNote}` : netNote;
    }
    if (execution.variantSampleSize > 0) {
      const variantNote = `${execution.selectedEntryVariant} + ${execution.selectedExitVariant} selected (${execution.variantConfidenceTier}, ${execution.variantSampleSize} resolved)`;
      note = note ? `${note} | ${variantNote}` : variantNote;
    }

    if (candidate.status === 'WATCH' || candidate.dangerScore >= 60) {
      return {
        candidate,
        group: 'Avoid / watch only',
        actionLabel: 'watch only',
        caution: symbolNegative ? 'symbol underperforming in shadow data' : (candidate.blockers[0] ?? 'No entry yet. Let the setup mature before considering a paper plan.'),
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    if ((execution.netEdgeAfterCost ?? execution.expectedNetR ?? 0) < 0) {
      return {
        candidate,
        group: 'Avoid / watch only',
        actionLabel: 'research-only / negative net expectancy',
        caution: `Selected execution is negative after costs (${formatRMetric(execution.netEdgeAfterCost ?? execution.expectedNetR)}). Keep collecting shadow data, but do not treat this as a profit candidate.`,
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    if (shortDirectionWeak && !shortCanEscapeDowngrade) {
      return {
        candidate,
        group: 'Avoid / watch only',
        actionLabel: 'watch only',
        caution: whaleDisagrees
          ? 'SHORT bucket Net Avg R is negative and whale disagrees, so this stays watch only.'
          : 'SHORT bucket Net Avg R is negative, so this stays watch only until evidence improves.',
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    if (symbolNegative && candidate.status !== 'WAIT') {
      return {
        candidate,
        group: 'Avoid / watch only',
        actionLabel: 'watch only',
        caution: 'symbol underperforming in shadow data',
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    if (waitPriority) {
      return {
        candidate,
        group: 'Wait for trigger',
        actionLabel: 'wait for trigger / no immediate entry',
        caution: `WAIT has a good TP1 rate, but Net Avg R is still ${statusStats.avgNetRResult === null ? 'unknown' : statusStats.avgNetRResult.toFixed(2)}. No immediate entry.`,
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    if (candidate.status === 'WAIT') {
      return {
        candidate,
        group: 'Wait for trigger',
        actionLabel: 'wait for trigger / no immediate entry',
        caution: candidate.blockers[0] ?? 'Wait for pullback, retest, or cleaner trigger before acting on paper.',
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    if (candidate.status === 'READY' && (statusStats.resolved < 30 || !statusNetPositive || earlyOrWeak)) {
      return {
        candidate,
        group: 'Paper trade review',
        actionLabel: 'review only',
        caution: `READY stays paper review only until it has at least 30 resolved signals and positive Net Avg R.${symbolNegative ? ' Symbol underperforming in shadow data.' : ''}`,
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    if (tradeNowNeedsSoftening) {
      return {
        candidate,
        group: 'Paper trade review',
        actionLabel: 'review only - confirmation weak',
        caution: hasSoftConfirmationWeakness
          ? 'Review only - confirmation weak. Volume or trigger quality still needs confirmation.'
          : 'Not enough sample for live trading.',
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    if (candidate.status === 'TRADE_NOW' && (statusStats.resolved < 30 || !statusNetPositive)) {
      return {
        candidate,
        group: 'Paper trade review',
        actionLabel: 'paper review only',
        caution: 'TRADE_NOW remains paper review only until TRADE_NOW has at least 30 resolved signals and positive Net Avg R.',
        note,
        paperOnly: true,
        edge,
        tradePlan,
        execution,
      };
    }

    return {
      candidate,
      group: 'Paper trade review',
      actionLabel: longDirectionSupportive && netPreferredCandidate ? 'paper trade review' : (candidate.status === 'TRADE_NOW' ? 'paper trade review' : 'review setup'),
      caution: candidate.horizonConflict
        ? 'Kronos 1h and 4h horizons disagree, so keep this as review only with no runner guidance.'
        : kronosShortHorizonOnly
          ? 'Short-horizon bias only; TP1 fast, no runner.'
        : whaleDisagrees
        ? 'Whale disagrees with the final direction, so keep this as review only.'
        : mediumKronosConflict
          ? 'Kronos MEDIUM conflicts with whale or technical structure, so keep this as review only.'
          : candidate.sourceConflict
            ? 'Source conflict is active, so paper review only.'
            : strongKronosAgreement && lowVolumeConfirmation
              ? 'Forecast agrees, wait for volume confirmation.'
              : (candidate.blockers[0] ?? (directionNetPositive ? 'Direction bucket is currently net positive in shadow data.' : 'Use as a paper-trade review candidate only.')),
      note,
      paperOnly: candidate.status === 'TRADE_NOW' ? true : true,
      edge,
      tradePlan,
      execution,
    };
  });
}

// ─── Symbol × Route Audit panel ───────────────────────────────────────────────

function verdictBadge(v: SymbolRouteVerdict) {
  if (v === 'TOXIC') return 'badge badge-red';
  if (v === 'SYMBOL_ROUTE_DRAG') return 'badge badge-amber';
  if (v === 'PROMISING') return 'badge badge-green';
  if (v === 'BREAKEVEN_CANDIDATE') return 'badge badge-cyan';
  return 'badge badge-slate';
}

// ─── Entry Precision Audit Panel ──────────────────────────────────────────────

function AdaptiveGateIntelligencePanel({ report }: { report: AdaptiveGateIntelligenceReport }) {
  const fmtR = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(2)}R`);
  const fmtR4 = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(3)}R`);
  const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
  const fmtPF = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2));
  const fmtPctCoverage = (v: number) => `${(v * 100).toFixed(0)}%`;
  const signalBadge = (s: AdaptiveLocalGateSignal) => {
    if (s === 'SUPPORTIVE_WATCHABLE' || s === 'SUPPORTIVE_EARLY') return 'badge badge-green';
    if (s === 'HARMFUL_WATCHABLE' || s === 'HARMFUL_EARLY') return 'badge badge-red';
    return 'badge badge-slate';
  };
  const verdictBadge = (v: AdaptiveInteractionVerdict) => {
    if (v === 'EARLY_SUPPORTIVE' || v === 'WATCHABLE_SUPPORTIVE') return 'badge badge-green';
    if (v === 'EARLY_HARMFUL' || v === 'WATCHABLE_HARMFUL') return 'badge badge-red';
    return 'badge badge-slate';
  };
  const patchStatusBadge = (s: AdaptivePatchStatus) => {
    if (s === 'READY_FOR_PATCH_DISCUSSION') return 'badge badge-green';
    if (s === 'AUDIT_DEEPER') return 'badge badge-amber';
    return 'badge badge-slate';
  };

  const topSupportive = report.topSupportiveConditions.slice(0, 5);
  const topHarmful = report.topHarmfulConditions.slice(0, 5);
  const topInteractions = report.interactions.slice(0, 5);
  const topHypotheses = report.patchHypotheses.slice(0, 5);
  const provenanceFields = ['selectedKronosBias', 'whaleAgreement', 'horizonConflict', 'sentimentBucket', 'fearGreedValue'];
  const provenanceRows = report.coverageProvenance.perField.filter((row) => provenanceFields.includes(row.field));

  return (
    <section className="panel table-panel performance-panel">
      <div className="section-header">
        <div>
          <p className="eyebrow">Phase 2C.1 advisory engine</p>
          <h2>Adaptive Gate Controller Intelligence</h2>
        </div>
        <span className="mini-status">
          {report.metadata.resolvedExperienceRecordCount} records | baseline {fmtR(report.baseline.netAvgR)} | PF {fmtPF(report.baseline.profitFactor)} | SL {fmtPct(report.baseline.slRate)}
        </span>
      </div>
      <p className="candidate-copy" style={{ marginBottom: '0.75rem' }}>
        Advisory only. Per gate-relevant context dimension and a few disciplined interactions, this panel surfaces
        which conditions currently look supportive or harmful against the baseline. It does not influence ranking,
        routing, promotion, execution, stops, TPs, live readiness, caps, or universe rotation.
      </p>
      <div className="detail-sections">
        <section className="detail-card performance-section-half">
          <h3>Baseline & readiness</h3>
          <div className="metric-list">
            <div className="metric-row"><span>Resolved records</span><strong>{report.metadata.resolvedExperienceRecordCount}</strong></div>
            <div className="metric-row"><span>Baseline net avg R</span><strong>{fmtR(report.baseline.netAvgR)}</strong></div>
            <div className="metric-row"><span>Baseline PF</span><strong>{fmtPF(report.baseline.profitFactor)}</strong></div>
            <div className="metric-row"><span>Baseline SL rate</span><strong>{fmtPct(report.baseline.slRate)}</strong></div>
            <div className="metric-row"><span>Advisory engine</span><strong className="badge badge-green">Active</strong></div>
            <div className="metric-row"><span>Gate influence</span><strong className="badge badge-slate">Advisory only</strong></div>
          </div>
        </section>
        <section className="detail-card performance-section-half">
          <h3>Context coverage</h3>
          <div className="metric-list">
            {report.contextCoverage.map((c) => (
              <div className="metric-row" key={c.dimension}>
                <span>{c.dimension.replace(/_/g, ' ').toLowerCase()}</span>
                <strong>{fmtPctCoverage(c.coveragePct)}</strong>
                <span>{c.populatedCount} populated</span>
              </div>
            ))}
          </div>
        </section>
        <section className="detail-card performance-section-wide">
          <h3>Coverage provenance</h3>
          <div className="metric-list">
            <div className="metric-row">
              <span>Resolved records with strategy context</span>
              <strong>{report.coverageProvenance.resolvedRecordsWithStrategyContext}/{report.coverageProvenance.totalResolvedRecords}</strong>
              <span>{report.coverageProvenance.openPositionsWithStrategyContext} open newer snapshots waiting to resolve</span>
            </div>
            {provenanceRows.map((row) => (
              <div className="metric-row metric-row-wrap" key={`prov-${row.field}`}>
                <span>{row.field}</span>
                <strong>{fmtPctCoverage(row.resolvedExperienceCoveragePct)}</strong>
                <span>{row.mostLikelyGapReason.replace(/_/g, ' ').toLowerCase()}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="detail-card performance-section-wide">
          <h3>Top supportive conditions</h3>
          {topSupportive.length === 0 ? (
            <div className="metric-list"><div className="metric-row"><span>No supportive condition has cleared the classifier yet.</span></div></div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Dimension</th><th>Condition</th><th>n</th>
                  <th>Net Avg R</th><th>Delta net</th><th>PF</th><th>SL%</th><th>Signal</th>
                </tr>
              </thead>
              <tbody>
                {topSupportive.map((c) => (
                  <tr key={`s-${c.dimension}-${c.bucket}`}>
                    <td>{c.dimension.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>{c.bucket.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>{c.closedCount}</td>
                    <td>{fmtR(c.netAvgR)}</td>
                    <td>{fmtR4(c.performanceDeltaVsBaseline.netAvgR)}</td>
                    <td>{fmtPF(c.profitFactor)}</td>
                    <td>{fmtPct(c.slRate)}</td>
                    <td><span className={signalBadge(c.localGateSignal)}>{c.localGateSignal.replace(/_/g, ' ').toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="detail-card performance-section-wide">
          <h3>Top harmful conditions</h3>
          {topHarmful.length === 0 ? (
            <div className="metric-list"><div className="metric-row"><span>No harmful condition has cleared the classifier yet.</span></div></div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Dimension</th><th>Condition</th><th>n</th>
                  <th>Net Avg R</th><th>Delta net</th><th>PF</th><th>SL%</th><th>Signal</th>
                </tr>
              </thead>
              <tbody>
                {topHarmful.map((c) => (
                  <tr key={`h-${c.dimension}-${c.bucket}`}>
                    <td>{c.dimension.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>{c.bucket.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>{c.closedCount}</td>
                    <td>{fmtR(c.netAvgR)}</td>
                    <td>{fmtR4(c.performanceDeltaVsBaseline.netAvgR)}</td>
                    <td>{fmtPF(c.profitFactor)}</td>
                    <td>{fmtPct(c.slRate)}</td>
                    <td><span className={signalBadge(c.localGateSignal)}>{c.localGateSignal.replace(/_/g, ' ').toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="detail-card performance-section-wide">
          <h3>Interaction findings</h3>
          {topInteractions.length === 0 ? (
            <div className="metric-list"><div className="metric-row"><span>No interactions evaluable (component dimensions need coverage first).</span></div></div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Interaction</th><th>n</th><th>Tier</th>
                  <th>Net Avg R</th><th>Delta net</th><th>PF</th><th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {topInteractions.map((i) => (
                  <tr key={`i-${i.interactionLabel}`}>
                    <td>{i.interactionLabel}</td>
                    <td>{i.closedCount}</td>
                    <td>{i.sampleTier.toLowerCase()}</td>
                    <td>{fmtR(i.netAvgR)}</td>
                    <td>{fmtR4(i.deltaVsBaseline.netAvgR)}</td>
                    <td>{fmtPF(i.profitFactor)}</td>
                    <td><span className={verdictBadge(i.verdict)}>{i.verdict.replace(/_/g, ' ').toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="detail-card performance-section-wide">
          <h3>Patch hypotheses (NOT IMPLEMENTED)</h3>
          {topHypotheses.length === 0 ? (
            <div className="metric-list"><div className="metric-row"><span>No patch hypotheses generated yet.</span></div></div>
          ) : (
            <div className="metric-list">
              {topHypotheses.map((h, idx) => (
                <div className="metric-row metric-row-wrap" key={`ph-${idx}`}>
                  <span>{h.title}</span>
                  <strong className={patchStatusBadge(h.patchStatus)}>{h.patchStatus.replace(/_/g, ' ').toLowerCase()}</strong>
                  <span>conf: {h.confidence.toLowerCase()}</span>
                  <span>{h.evidenceSummary}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function AdaptiveRegimeGateOverlayPanel({ report }: { report: AdaptiveRegimeGateOverlayPerformanceReport }) {
  const fmtR = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(2)}R`);
  const fmtR4 = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(3)}R`);
  const fmtPF = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2));
  const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
  const fmtCoverage = (v: number) => `${(v * 100).toFixed(0)}%`;
  const verdictBadge = (value: OverlayEarlyVerdict) => {
    if (value === 'EARLY_SUPPORTIVE' || value === 'WATCHABLE_SUPPORTIVE') return 'badge badge-green';
    if (value === 'EARLY_HARMFUL' || value === 'WATCHABLE_HARMFUL') return 'badge badge-red';
    if (value === 'TOO_EARLY' || value === 'NO_FORWARD_EVIDENCE_YET') return 'badge badge-amber';
    return 'badge badge-slate';
  };

  const bestPolicy = [...report.policyPerformance]
    .filter((policy) => policy.includedCount > 0)
    .sort((left, right) => (right.deltaIncludedVsExcluded.netAvgRDelta ?? Number.NEGATIVE_INFINITY) - (left.deltaIncludedVsExcluded.netAvgRDelta ?? Number.NEGATIVE_INFINITY))[0] ?? null;

  return (
    <section className="panel table-panel performance-panel">
      <div className="section-header">
        <div>
          <p className="eyebrow">Phase 2C.2 advisory overlay</p>
          <h2>Adaptive Regime Gate Shadow Overlay</h2>
        </div>
        <span className="mini-status">
          {report.recordsWithPersistedOverlay} overlay-tagged resolved | coverage {fmtCoverage(report.overlayForwardCoveragePct)} | behavior influence false
        </span>
      </div>
      <p className="candidate-copy" style={{ marginBottom: '0.75rem' }}>
        Advisory only. This panel tracks regime-aware gate policies on new candidates without changing routing or execution.
        It measures whether the simulated gate logic actually improves forward shadow outcomes.
      </p>
      <div className="detail-sections">
        <section className="detail-card performance-section-half">
          <h3>Forward coverage</h3>
          <div className="metric-list">
            <div className="metric-row"><span>Overlay forward coverage</span><strong>{fmtCoverage(report.overlayForwardCoveragePct)}</strong></div>
            <div className="metric-row"><span>Records with overlay</span><strong>{report.recordsWithPersistedOverlay}</strong></div>
            <div className="metric-row"><span>Records without overlay</span><strong>{report.recordsWithoutPersistedOverlay}</strong></div>
            <div className="metric-row"><span>Collecting forward evidence</span><strong className="badge badge-green">true</strong></div>
            <div className="metric-row"><span>Ready for behavior influence</span><strong className="badge badge-slate">false</strong></div>
          </div>
        </section>
        <section className="detail-card performance-section-half">
          <h3>Best observed policy</h3>
          <div className="metric-list">
            {bestPolicy ? (
              <>
                <div className="metric-row"><span>{bestPolicy.policyLabel}</span><strong>{fmtR(bestPolicy.includedMetrics.netAvgR)}</strong></div>
                <div className="metric-row"><span>Included vs excluded delta</span><strong>{fmtR4(bestPolicy.deltaIncludedVsExcluded.netAvgRDelta)}</strong></div>
                <div className="metric-row"><span>Resolved with policy</span><strong>{bestPolicy.totalResolvedWithPolicy}</strong></div>
                <div className="metric-row"><span>Verdict</span><strong className={verdictBadge(bestPolicy.earlyVerdict)}>{bestPolicy.earlyVerdict.replace(/_/g, ' ').toLowerCase()}</strong></div>
              </>
            ) : (
              <div className="metric-row"><span>No forward overlay policy has enough resolved evidence yet.</span></div>
            )}
          </div>
        </section>
        <section className="detail-card performance-section-wide">
          <h3>Policy comparison</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Policy</th><th>Resolved N</th><th>Included</th><th>Excluded</th><th>Included Net</th><th>Excluded Net</th><th>Delta</th><th>PF</th><th>SL%</th><th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {report.policyPerformance.map((policy) => (
                <tr key={policy.policyId}>
                  <td>{policy.policyLabel}</td>
                  <td>{policy.totalResolvedWithPolicy}</td>
                  <td>{policy.includedCount}</td>
                  <td>{policy.excludedCount}</td>
                  <td>{fmtR(policy.includedMetrics.netAvgR)}</td>
                  <td>{fmtR(policy.excludedMetrics.netAvgR)}</td>
                  <td>{fmtR4(policy.deltaIncludedVsExcluded.netAvgRDelta)}</td>
                  <td>{fmtPF(policy.includedMetrics.profitFactor)}</td>
                  <td>{fmtPct(policy.includedMetrics.slRate)}</td>
                  <td><span className={verdictBadge(policy.earlyVerdict)}>{policy.earlyVerdict.replace(/_/g, ' ').toLowerCase()}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="detail-card performance-section-wide">
          <h3>Explanation</h3>
          <p className="candidate-copy">
            Historical counterfactuals suggested these regime gates may help. This panel tests whether that benefit reproduces prospectively on newly tagged candidates.
          </p>
        </section>
      </div>
    </section>
  );
}

async function fetchOperatorBrief(): Promise<string | null> {
  try {
    const response = await fetch('/api/shadow/operator-brief?era=POST_CALIBRATION&resolve=1&paper=1');
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

function OperatorBriefPanel({ brief }: { brief: string }) {
  return (
    <section className="panel table-panel performance-panel">
      <div className="section-header">
        <div>
          <p className="eyebrow">Operator brief — paper execution router</p>
          <h2>Live decision &amp; diagnostic sampler</h2>
        </div>
        <span className="mini-status">POST_CALIBRATION · resolve · paper</span>
      </div>
      <p className="candidate-copy" style={{ marginBottom: '0.5rem' }}>
        Read-only snapshot of the current routing decision, the variant-matrix economic lead, and the paper
        execution router (Section 10) — including the rejected-candidate diagnostic sampler. Live trading and
        micro-pilot stay blocked; nothing here places real orders.
      </p>
      <pre className="operator-brief-pre">{brief}</pre>
    </section>
  );
}

function PerformancePage() {
  const [perf, setPerf] = useState<PerformanceStats | null>(null);
  const [shadow, setShadow] = useState<ShadowStateSnapshot | null>(null);
  const [adaptiveGate, setAdaptiveGate] = useState<AdaptiveGateIntelligenceReport | null>(null);
  const [adaptiveGateOverlay, setAdaptiveGateOverlay] = useState<AdaptiveRegimeGateOverlayPerformanceReport | null>(null);
  const [universeRotation, setUniverseRotation] = useState<UniverseRotationIntelligenceReport | null>(null);
  const [externalDiscovery, setExternalDiscovery] = useState<ExternalDiscoveryReport | null>(null);
  const [externalStrategyFit, setExternalStrategyFit] = useState<ExternalStrategyFitEnrichmentReport | null>(null);
  const [externalRotationOverlay, setExternalRotationOverlay] = useState<ExternalRotationOverlayPerformanceReport | null>(null);
  const [operatorBrief, setOperatorBrief] = useState<string | null>(null);
  const [copyAuditSummaryState, setCopyAuditSummaryState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchPerformance(),
      fetchShadow().catch(() => null),
      fetchAdaptiveGateIntelligence().catch(() => null),
      fetchAdaptiveGateOverlayPerformance().catch(() => null),
      fetchUniverseRotationIntelligence().catch(() => null),
      fetchExternalCandidateDiscovery().catch(() => null),
      fetchExternalStrategyFitEnrichment().catch(() => null),
      fetchExternalRotationOverlayPerformance().catch(() => null),
      fetchOperatorBrief().catch(() => null),
    ])
      .then(([data, shadowData, gateData, overlayData, rotationData, discoveryData, strategyFitData, externalOverlayData, briefData]) => {
        setPerf(data);
        setShadow(shadowData);
        setAdaptiveGate(gateData);
        setAdaptiveGateOverlay(overlayData);
        setUniverseRotation(rotationData ?? null);
        setExternalDiscovery(discoveryData ?? null);
        setExternalStrategyFit(strategyFitData ?? null);
        setExternalRotationOverlay(externalOverlayData ?? null);
        setOperatorBrief(briefData ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load performance data.'));
  }, []);

  async function copyDashboardAuditSummary() {
    setCopyAuditSummaryState('copying');
    try {
      const summaryText = await fetchDashboardAuditSummaryText();
      if (!summaryText || !navigator.clipboard) {
        setCopyAuditSummaryState('failed');
        return;
      }
      await navigator.clipboard.writeText(summaryText);
      setCopyAuditSummaryState('copied');
      window.setTimeout(() => setCopyAuditSummaryState('idle'), 2500);
    } catch {
      setCopyAuditSummaryState('failed');
      window.setTimeout(() => setCopyAuditSummaryState('idle'), 2500);
    }
  }

  if (error) {
    return (
      <main className="dashboard-grid performance-grid">
        <section className="panel empty-panel performance-panel"><h2>Performance unavailable</h2><p>{error}</p></section>
      </main>
    );
  }
  if (!perf) {
    return (
      <main className="dashboard-grid performance-grid">
        <section className="panel empty-panel"><p>Loading performance data…</p></section>
      </main>
    );
  }
  if (perf.totalSignals === 0) {
    return (
      <main className="dashboard-grid performance-grid">
        <section className="panel empty-panel performance-panel">
          <h2>No tracked signals yet</h2>
          <p>Run the scanner a few times and check back after 4+ hours for outcome data.</p>
        </section>
      </main>
    );
  }

  const bestNetVariants = [...perf.windows["1h"].shadowVariants]
    .filter((variant) => variant.resolved > 0 && variant.avgNetRResult !== null)
    .sort((left, right) => (right.avgNetRResult ?? Number.NEGATIVE_INFINITY) - (left.avgNetRResult ?? Number.NEGATIVE_INFINITY))
    .slice(0, 5);
  const bestProfitableTp1Variants = [...perf.windows["1h"].shadowVariants]
    .filter((variant) => variant.resolved > 0)
    .sort((left, right) => right.profitableTp1Rate - left.profitableTp1Rate)
    .slice(0, 5);
  const worstVariants = [...perf.windows["1h"].shadowVariants]
    .filter((variant) => variant.resolved > 0 && variant.avgNetRResult !== null)
    .sort((left, right) => (left.avgNetRResult ?? Number.POSITIVE_INFINITY) - (right.avgNetRResult ?? Number.POSITIVE_INFINITY))
    .slice(0, 5);
  const bestVariantCombinations = buildVariantCombinationTable(perf).slice(0, 8);
  const bestProfitEngines = buildVariantCombinationTable(perf)
    .filter((combo) => combo.resolved > 0 && combo.netAvgR !== null)
    .sort((left, right) => (right.netAvgR ?? Number.NEGATIVE_INFINITY) - (left.netAvgR ?? Number.NEGATIVE_INFINITY))
    .slice(0, 6);
  const bestEngineTitle = bestProfitEngines.length > 0 && bestProfitEngines.every((combo) => (combo.netAvgR ?? 0) <= 0)
    ? 'Least bad research engine'
    : 'Best profit engine';
  const worstProfitLeaks = buildVariantCombinationTable(perf)
    .filter((combo) => combo.resolved > 0 && combo.netAvgR !== null)
    .sort((left, right) => (left.netAvgR ?? Number.POSITIVE_INFINITY) - (right.netAvgR ?? Number.POSITIVE_INFINITY))
    .slice(0, 6);
  const worstSymbolDrag = [...perf.bySymbol, ...perf.earlySampleSymbols]
    .filter((symbol) => symbol.avgNetRResult !== null)
    .sort((left, right) => (left.avgNetRResult ?? Number.POSITIVE_INFINITY) - (right.avgNetRResult ?? Number.POSITIVE_INFINITY))[0] ?? null;
  const bestSymbolEdge = [...perf.bySymbol, ...perf.earlySampleSymbols]
    .filter((symbol) => symbol.avgNetRResult !== null)
    .sort((left, right) => (right.avgNetRResult ?? Number.NEGATIVE_INFINITY) - (left.avgNetRResult ?? Number.NEGATIVE_INFINITY))[0] ?? null;

  return (
    <main className="dashboard-grid performance-grid">
      <section className="panel table-panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">Operator shortcut</p>
            <h2>Dashboard Audit Summary</h2>
          </div>
          <span className="mini-status">
            {copyAuditSummaryState === 'copied'
              ? 'Copied'
              : copyAuditSummaryState === 'failed'
                ? 'Copy failed'
                : 'POST_CALIBRATION'}
          </span>
        </div>
        <p className="candidate-copy" style={{ marginBottom: '0.75rem' }}>
          Copy a compact read-only summary of live readiness, route maturity, current performance,
          and Phase 2 intelligence so you can paste it straight into ChatGPT.
        </p>
        <div className="input-row" style={{ gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className={copyAuditSummaryState === 'copied' ? 'badge badge-green' : 'badge badge-slate'}
            style={{ cursor: 'pointer', border: 'none', font: 'inherit' }}
            onClick={() => void copyDashboardAuditSummary()}
            disabled={copyAuditSummaryState === 'copying'}
          >
            {copyAuditSummaryState === 'copying' ? 'Copying…' : 'Copy Dashboard Audit Summary'}
          </button>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            Source: <code>/api/shadow/dashboard-audit-summary?era=POST_CALIBRATION</code>
          </span>
        </div>
      </section>
      {operatorBrief && <OperatorBriefPanel brief={operatorBrief} />}
      {adaptiveGate && <AdaptiveGateIntelligencePanel report={adaptiveGate} />}
      {adaptiveGateOverlay && <AdaptiveRegimeGateOverlayPanel report={adaptiveGateOverlay} />}
      {universeRotation && <UniverseRotationIntelligencePanel report={universeRotation} />}
      {externalDiscovery && <ExternalCandidateDiscoveryPanel report={externalDiscovery} />}
      {externalStrategyFit && <ExternalStrategyFitEnrichmentPanel report={externalStrategyFit} />}
      {externalRotationOverlay && <ExternalRotationOverlayPanel report={externalRotationOverlay} />}
      <section className="panel table-panel performance-panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">Performance — 1h outcome window</p>
            <h2>{perf.uniqueTrackedSignals} unique tracked signals</h2>
          </div>
          <span className="mini-status">
            {perf.rawScans} raw scans | {perf.uniqueTrackedSignals} unique | {perf.activeOpenSignals} active open | {perf.resolvedOutcomes} resolved
          </span>
        </div>

        {perf.lowSample && (
          <div className="metric-row" style={{ marginTop: '1rem', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
            <span className="badge badge-amber">low sample</span>
            <span>Only {perf.resolvedOutcomes} resolved outcomes so far. Treat hit rates as early signals, not stable edges.</span>
          </div>
        )}

        <div className="performance-summary-grid">
          <div className="metric-row">
            <span>A. Health / execution realism</span>
            <strong>Fee {perf.executionCost.feeBpsPerSide}bps | Slippage {perf.executionCost.slippageBpsPerSide}bps</strong>
            <span>Round trip {perf.executionCost.roundTripCostBps}bps</span>
          </div>
          <div className="metric-row">
            <span>Lifecycle</span>
            <strong>{perf.activeOpenSignals} active open</strong>
            <span>{perf.expiredSignals} expired | {perf.invalidRiskSignals} invalid risk</span>
          </div>
          <div className="metric-row">
            <span>Dedupe audit</span>
            <strong>{perf.dedupeAudit.rawScans} raw | {perf.dedupeAudit.uniqueSignals} unique</strong>
            <span>{perf.suppressedDuplicateScans} suppressed in {perf.dedupeAudit.duplicateSuppressionWindowMinutes}m</span>
          </div>
          <div className="metric-row">
            <span>Outcome checks</span>
            <strong>Next 1h {formatTimestamp(perf.lifecycle.next1hCheckDueAt)}</strong>
            <span>Last run {formatTimestamp(perf.lifecycle.lastOutcomeCheckerRunAt)}</span>
          </div>
        </div>
        <p className="candidate-copy" style={{ marginTop: '0.75rem' }}>{perf.dedupeAudit.note}</p>
        <div className="metric-row" style={{ marginTop: '0.75rem', border: '1px solid rgba(148, 163, 184, 0.18)' }}>
          <span>Migration audit</span>
          <span>{perf.migrationAudit.currentCanonicalSample} canonical | {perf.migrationAudit.archivedPreDedupeSample} archived | {perf.migrationAudit.migratedResolvedOutcomes} migrated resolved | {perf.migrationAudit.skippedLegacyRecords} skipped</span>
        </div>
        <p className="candidate-copy" style={{ marginTop: '0.75rem' }}>{perf.migrationAudit.note}</p>
        {perf.migrationAudit.skippedLegacyReasons.length > 0 && (
          <div className="input-row" style={{ marginTop: '0.5rem' }}>
            {perf.migrationAudit.skippedLegacyReasons.map((reason) => (
              <span key={reason} className="badge badge-amber">{reason}</span>
            ))}
          </div>
        )}

        <div className="detail-sections" style={{ marginTop: '1rem' }}>
          {shadow && (
            <section className="detail-card performance-section-wide">
              <h3>Profitability first</h3>
              <div className="performance-summary-grid">
                <div className="metric-row"><span>Today primary shadow net R</span><strong>{formatRMetric(shadow.summary.primaryProfitCandidate.dailyClosedNetR)}</strong><span>PF {shadow.summary.primaryProfitCandidate.dailyProfitFactor === null ? 'Unknown' : formatNumber(shadow.summary.primaryProfitCandidate.dailyProfitFactor)}</span></div>
                <div className="metric-row"><span>All-time primary shadow</span><strong>{formatRMetric(shadow.summary.primaryProfitCandidate.netAvgR)}</strong><span>{shadow.summary.primaryProfitCandidate.closed} closed | PF {shadow.summary.primaryProfitCandidate.profitFactor === null ? 'Unknown' : formatNumber(shadow.summary.primaryProfitCandidate.profitFactor)}</span></div>
                <div className="metric-row"><span>Research shadow execution</span><strong>{formatRMetric(shadow.summary.researchExecution.netAvgR)}</strong><span>{shadow.summary.researchExecution.closed} closed | PF {shadow.summary.researchExecution.profitFactor === null ? 'Unknown' : formatNumber(shadow.summary.researchExecution.profitFactor)}</span></div>
                <div className="metric-row"><span>Scanner READY outcome net R</span><strong>{formatRMetric(perf.byStatus.READY.avgNetRResult)}</strong><span>tracker 1h valid resolved samples</span></div>
                <div className="metric-row"><span>All shadow actual execution</span><strong>{formatRMetric(shadow.summary.netAvgR)}</strong><span>{shadow.summary.closedPositions} closed | PF {shadow.summary.profitFactor === null ? 'Unknown' : formatNumber(shadow.summary.profitFactor)}</span></div>
                <div className="metric-row"><span>Data-collection shadow</span><strong>{formatRMetric(shadow.summary.dataCollectionExecution.netAvgR)}</strong><span>{shadow.summary.dataCollectionExecution.closed} closed</span></div>
                <div className="metric-row"><span>Worst symbol drag</span><strong>{worstSymbolDrag?.symbol ?? 'Unknown'}</strong><span>{formatRMetric(worstSymbolDrag?.avgNetRResult)} net Avg R</span></div>
                <div className="metric-row"><span>Best symbol edge</span><strong>{bestSymbolEdge?.symbol ?? 'Unknown'}</strong><span>{formatRMetric(bestSymbolEdge?.avgNetRResult)} net Avg R</span></div>
              </div>
              <p className="candidate-copy" style={{ marginTop: '0.75rem' }}>{shadow.summary.profitabilityExplanation}</p>
            </section>
          )}
          {shadow && (
            <section className="detail-card performance-section">
              <h3>B. Shadow executed trades</h3>
              <div className="metric-list">
                <div className="metric-row">
                  <span>Scanner tracker vs all shadow actual execution</span>
                  <strong>{perf.uniqueTrackedSignals} tracked ideas | {shadow.summary.rawExecutedTrades} shadow trades</strong>
                  <span>{shadow.summary.uniqueIdeas} unique ideas | {shadow.summary.openPositions} open | {shadow.summary.closedPositions} closed</span>
                </div>
                <div className="metric-row">
                  <span>All-time all shadow execution quality</span>
                  <strong>Win {pct(shadow.summary.winRate)}</strong>
                  <span>Profit factor {shadow.summary.profitFactor === null ? 'Unknown' : formatNumber(shadow.summary.profitFactor)} | Gross {formatRMetric(shadow.summary.grossAvgR)} | Net {formatRMetric(shadow.summary.netAvgR)}</span>
                </div>
                <div className="metric-row">
                  <span>TP1 / SL</span>
                  <strong>{pct(shadow.summary.tp1Rate)} TP1</strong>
                  <span>{pct(shadow.summary.slRate)} SL | best variant {shadow.summary.bestVariant ?? 'Unknown'}</span>
                </div>
                <div className="metric-row">
                  <span>Average win / loss</span>
                  <strong>{formatRMetric(shadow.summary.avgWinR)} / {formatRMetric(shadow.summary.avgLossR)}</strong>
                  <span>Expectancy {formatRMetric(shadow.summary.expectancyPerTrade)}</span>
                </div>
                <div className="metric-row">
                  <span>Duplicate control</span>
                  <strong>{shadow.summary.suppressedDuplicates} suppressed</strong>
                  <span>{shadow.summary.duplicateSuppressionWindowMinutes}m window | {shadow.summary.activeOpenIdeaCount} active open ideas</span>
                </div>
              </div>
            </section>
          )}

          <section className="detail-card performance-section-wide">
            <h3>{bestEngineTitle}</h3>
            {bestEngineTitle !== 'Best profit engine' && (
              <p className="candidate-copy" style={{ marginTop: '-0.25rem' }}>All resolved replay engines are net negative; this table is sorted by valid-resolved net R and shows the least bad research paths.</p>
            )}
            <div className="table-wrap">
              <table>
                <thead><tr><th>Entry</th><th>Exit</th><th>Net R</th><th>PF</th><th>Valid resolved / filled</th><th>No-fill</th><th>Runner success</th></tr></thead>
                <tbody>
                  {bestProfitEngines.map((combo) => (
                    <tr key={`${combo.entryVariant}-${combo.exitVariant}`}>
                      <td>{combo.entryVariant}</td>
                      <td>{combo.exitVariant}</td>
                      <td>{formatRMetric(combo.netAvgR)}</td>
                      <td>{combo.profitFactor === null ? 'Unknown' : formatNumber(combo.profitFactor)}</td>
                      <td>{combo.resolved}/{combo.filled}</td>
                      <td>{combo.noFill}</td>
                      <td>{pct(combo.runnerSuccessRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="detail-card performance-section-wide">
            <h3>Worst profit leaks</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Entry</th><th>Exit</th><th>Net R</th><th>Avg loss</th><th>SL</th><th>No-fill</th><th>Giveback clue</th></tr></thead>
                <tbody>
                  {worstProfitLeaks.map((combo) => (
                    <tr key={`${combo.entryVariant}-${combo.exitVariant}`}>
                      <td>{combo.entryVariant}</td>
                      <td>{combo.exitVariant}</td>
                      <td>{formatRMetric(combo.netAvgR)}</td>
                      <td>{formatRMetric(combo.avgLossR)}</td>
                      <td>{combo.sl}</td>
                      <td>{combo.noFill}</td>
                      <td>{combo.tp1 > 0 && combo.runnerSuccessRate < 0.4 ? 'runner giveback risk' : 'cost / stopout drag'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="detail-card performance-section">
            <h3>C. Decision summary</h3>
            <div className="metric-list">
              {perf.insights.map((insight) => (
                <div key={insight.label} className="metric-row">
                  <span>{insight.label}</span>
                  <strong><span className={insightToneClass(insight.tone)}>{insight.value}</span></strong>
                  <span>{insight.detail}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="detail-card performance-section">
            <h3>Trade readiness recommendation</h3>
            <div className="metric-list">
              {perf.tradeReadiness.map((item) => (
                <div key={item.status} className="metric-row">
                  <span>{item.status}</span>
                  <strong><span className={statusTone(item.status)}>{sampleTierLabel(item.sampleTier)}</span></strong>
                  <span>{item.recommendation}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="detail-card performance-section-wide">
            <h3>D. Outcome quality by status</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Status</th><th>Signals</th><th>With outcome</th><th>Resolved</th><th>Valid/Invalid risk</th><th>TP1</th><th>TP1 profitable</th><th>TP2</th><th>SL</th><th>Open</th><th>Hit rate</th><th>Avg MFE</th><th>Avg MAE</th><th>Gross Avg R</th><th>Net Avg R</th></tr>
                </thead>
                <tbody>
                  {Object.entries(perf.byStatus).map(([status, s]) => (
                    <tr key={status}>
                      <td><span className={statusTone(status as Candidate['status'])}>{status}</span></td>
                      <td>{s.total}</td>
                      <td>{s.withOutcome}</td>
                      <td>{s.resolved}</td>
                      <td>{s.validRisk}/{s.invalidRisk}</td>
                      <td>{s.tp1Hit}</td>
                      <td>{s.profitableTp1Hit}</td>
                      <td>{s.tp2Hit}</td>
                      <td>{s.slHit}</td>
                      <td>{s.open}</td>
                      <td><span className={scoreTone(s.hitRate * 100)}>{pct(s.hitRate)}</span></td>
                      <td>{formatPctMetric(s.avgMaxFavorableExcursionPct)}</td>
                      <td>{formatPctMetric(s.avgMaxAdverseExcursionPct)}</td>
                      <td>{formatRMetric(s.avgGrossRResult)}</td>
                      <td>{formatAvgRReason(s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="detail-card performance-section-half">
            <h3>E. Long vs Short</h3>
            <div className="metric-list">
              {Object.entries(perf.byDirection).map(([dir, s]) => (
                <div key={dir} className="metric-row">
                  <span>{dir}</span>
                  <strong>{s.total} signals</strong>
                  <span>{s.resolved} resolved | {s.withOutcome - s.resolved} open | risk {s.validRisk}/{s.invalidRisk} | TP1 {s.tp1Hit} | profitable {s.profitableTp1Hit} | TP2 {s.tp2Hit} | SL {s.slHit}</span>
                  <span>Hit {pct(s.hitRate)} | MFE {formatPctMetric(s.avgMaxFavorableExcursionPct)} | MAE {formatPctMetric(s.avgMaxAdverseExcursionPct)} | Gross {formatRMetric(s.avgGrossRResult)} | Net {formatRMetric(s.avgNetRResult)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="detail-card performance-section-half">
            <h3>F. Kronos confidence split</h3>
            <div className="metric-list">
              {([
                ['STRONG agree', perf.kronosConfidenceSplit.STRONG.agrees],
                ['STRONG disagree', perf.kronosConfidenceSplit.STRONG.disagrees],
                ['MEDIUM agree', perf.kronosConfidenceSplit.MEDIUM.agrees],
                ['MEDIUM disagree', perf.kronosConfidenceSplit.MEDIUM.disagrees],
                ['WEAK ignored', perf.kronosConfidenceSplit.WEAK.ignored],
              ] as const).map(([label, s]) => (
                <div key={label} className="metric-row">
                  <span>{label}</span>
                  <strong>{s.total} signals</strong>
                  <span>{s.resolved} resolved | risk {s.validRisk}/{s.invalidRisk} | TP1 {s.tp1Hit} | profitable {s.profitableTp1Hit} | TP2 {s.tp2Hit} | SL {s.slHit}</span>
                  <span>Hit {pct(s.hitRate)} | MFE {formatPctMetric(s.avgMaxFavorableExcursionPct)} | MAE {formatPctMetric(s.avgMaxAdverseExcursionPct)} | Gross {formatRMetric(s.avgGrossRResult)} | Net {formatRMetric(s.avgNetRResult)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="detail-card performance-section-half">
            <h3>G. Whale agreement</h3>
            <div className="metric-list">
              {(['agrees', 'disagrees', 'unavailable'] as const).map((k) => {
                const s = perf.whaleAgreement[k];
                return (
                  <div key={k} className="metric-row">
                    <span>{k}</span>
                    <strong>{s.total} signals</strong>
                    <span>{s.resolved} resolved | risk {s.validRisk}/{s.invalidRisk} | TP1 {s.tp1Hit} | TP2 {s.tp2Hit} | SL {s.slHit}</span>
                    <span>Hit {pct(s.hitRate)} | MFE {formatPctMetric(s.avgMaxFavorableExcursionPct)} | MAE {formatPctMetric(s.avgMaxAdverseExcursionPct)} | {formatAvgRReason(s)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="detail-card performance-section-half">
            <h3>H. Status transition review</h3>
            <div className="metric-list">
              <div className="metric-row">
                <span>WAIT worked</span>
                <strong>{perf.statusTransitions.waitWorked}</strong>
                <span>WAIT signals that later reached TP in the 1h review window.</span>
              </div>
              <div className="metric-row">
                <span>READY failed</span>
                <strong>{perf.statusTransitions.readyFailed}</strong>
                <span>READY signals that later hit stop loss in the 1h review window and deserve review.</span>
              </div>
            </div>
          </section>

          <section className="detail-card performance-section">
            <h3>I. Best edge variants</h3>
            <div className="metric-list">
              <div className="metric-row metric-row-wrap">
                <span>Top Net Avg R</span>
                <strong>{bestNetVariants.map((variant) => `${variant.label} (${formatRMetric(variant.avgNetRResult)})`).join(' | ') || 'No resolved variants yet.'}</strong>
              </div>
              <div className="metric-row metric-row-wrap">
                <span>Top TP1 profitable rate</span>
                <strong>{bestProfitableTp1Variants.map((variant) => `${variant.label} (${pct(variant.profitableTp1Rate)})`).join(' | ') || 'No resolved variants yet.'}</strong>
              </div>
              <div className="metric-row metric-row-wrap">
                <span>Worst variants</span>
                <strong>{worstVariants.map((variant) => `${variant.label} (${formatRMetric(variant.avgNetRResult)})`).join(' | ') || 'No resolved variants yet.'}</strong>
              </div>
            </div>
          </section>

          <section className="detail-card performance-section-wide">
            <h3>Best variant combinations</h3>
            <p className="candidate-copy" style={{ marginBottom: '0.75rem' }}>
              Replay-backed 1h candle-path combinations drive this table. If sample stays early, execution selection falls back to the heuristic planner.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Entry</th><th>Exit</th><th>Attempted</th><th>Filled</th><th>No fill</th><th>Resolved</th><th>TP1</th><th>TP2</th><th>SL</th><th>Win rate</th><th>Gross Avg R</th><th>Net Avg R</th><th>Profit factor</th><th>Sample tier</th><th>Ambiguous</th></tr>
                </thead>
                <tbody>
                  {bestVariantCombinations.map((combo) => (
                    <tr key={`${combo.entryVariant}-${combo.exitVariant}`}>
                      <td title={combo.entryVariant}>{combo.entryVariant}</td>
                      <td title={combo.exitVariant}>{combo.exitVariant}</td>
                      <td>{combo.attempted}</td>
                      <td>{combo.filled}</td>
                      <td>{combo.noFill}</td>
                      <td>{combo.resolved}</td>
                      <td>{combo.profitableTp1}/{combo.tp1}</td>
                      <td>{combo.tp2}</td>
                      <td>{combo.sl}</td>
                      <td>{pct(combo.winRate)}</td>
                      <td>{formatRMetric(combo.grossAvgR)}</td>
                      <td>{formatRMetric(combo.netAvgR)}</td>
                      <td>{combo.profitFactor === null ? 'Unknown' : formatNumber(combo.profitFactor)}</td>
                      <td>{combo.sampleTier}</td>
                      <td>{combo.ambiguousSameCandleCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="detail-sections" style={{ marginTop: '1rem' }}>
          <section className="detail-card performance-section-half">
            <h3>Performance — 4h outcome window</h3>
            <div className="metric-list">
              <div className="metric-row">
                <span>4h summary</span>
                <strong>{perf.windows["4h"].resolvedOutcomes} resolved</strong>
                <span>{perf.windows["4h"].withOutcome} with outcome | {perf.windows["4h"].openOutcomes} open</span>
              </div>
              <div className="metric-row">
                <span>Best Avg R</span>
                <strong>{perf.windows["4h"].insights[1]?.value ?? 'Unknown'}</strong>
                <span>{perf.windows["4h"].insights[1]?.detail ?? 'No 4h Avg R insight yet.'}</span>
              </div>
              <div className="metric-row">
                <span>Long vs Short</span>
                <strong>{perf.windows["4h"].insights[3]?.value ?? 'Inconclusive'}</strong>
                <span>{perf.windows["4h"].insights[3]?.detail ?? 'No 4h direction insight yet.'}</span>
              </div>
            </div>
          </section>

          <section className="detail-card performance-section-half">
            <h3>4h Kronos confidence split</h3>
            <div className="metric-list">
              {([
                ['STRONG agree', perf.windows["4h"].kronosConfidenceSplit.STRONG.agrees],
                ['STRONG disagree', perf.windows["4h"].kronosConfidenceSplit.STRONG.disagrees],
                ['MEDIUM agree', perf.windows["4h"].kronosConfidenceSplit.MEDIUM.agrees],
                ['MEDIUM disagree', perf.windows["4h"].kronosConfidenceSplit.MEDIUM.disagrees],
                ['WEAK ignored', perf.windows["4h"].kronosConfidenceSplit.WEAK.ignored],
              ] as const).map(([label, s]) => (
                <div key={label} className="metric-row">
                  <span>{label}</span>
                  <strong>{s.resolved} resolved</strong>
                  <span>TP1 {pct(s.tp1Rate)} | profitable TP1 {pct(s.profitableTp1Rate)} | TP2 {pct(s.tp2Rate)} | SL {pct(s.slRate)}</span>
                  <span>MFE {formatPctMetric(s.avgMaxFavorableExcursionPct)} | MAE {formatPctMetric(s.avgMaxAdverseExcursionPct)} | Gross {formatRMetric(s.avgGrossRResult)} | Net {formatRMetric(s.avgNetRResult)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {perf.bySymbol.length > 0 && (
          <div className="performance-section-wide" style={{ marginTop: '1.5rem' }}>
            <h3 style={{ padding: '0 0 0.5rem' }}>J. Best / worst symbols (resolved sample 5+)</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Symbol</th><th>Signals</th><th>With outcome</th><th>Resolved</th><th>Valid/Invalid risk</th><th>TP1</th><th>TP1 profitable</th><th>TP2</th><th>SL</th><th>Hit rate</th><th>Gross Avg R</th><th>Net Avg R</th></tr>
                </thead>
                <tbody>
                  {perf.bySymbol.map((s) => (
                    <tr key={s.symbol}>
                      <td>{s.symbol}</td>
                      <td>{s.total}</td>
                      <td>{s.withOutcome}</td>
                      <td>{s.resolved}</td>
                      <td>{s.validRisk}/{s.invalidRisk}</td>
                      <td>{s.tp1Hit}</td>
                      <td>{s.profitableTp1Hit}</td>
                      <td>{s.tp2Hit}</td>
                      <td>{s.slHit}</td>
                      <td><span className={scoreTone(s.hitRate * 100)}>{pct(s.hitRate)}</span></td>
                      <td>{formatRMetric(s.avgGrossRResult)}</td>
                      <td>{formatAvgRReason(s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {perf.earlySampleSymbols.length > 0 && (
          <div className="performance-section-wide" style={{ marginTop: '1.5rem' }}>
            <h3 style={{ padding: '0 0 0.5rem' }}>K. Early sample</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Symbol</th><th>Signals</th><th>With outcome</th><th>Resolved</th><th>Valid/Invalid risk</th><th>TP1</th><th>TP1 profitable</th><th>TP2</th><th>SL</th><th>Hit rate</th><th>Gross Avg R</th><th>Net Avg R</th></tr>
                </thead>
                <tbody>
                  {perf.earlySampleSymbols.map((s) => (
                    <tr key={s.symbol}>
                      <td>{s.symbol}</td>
                      <td>{s.total}</td>
                      <td>{s.withOutcome}</td>
                      <td>{s.resolved}</td>
                      <td>{s.validRisk}/{s.invalidRisk}</td>
                      <td>{s.tp1Hit}</td>
                      <td>{s.profitableTp1Hit}</td>
                      <td>{s.tp2Hit}</td>
                      <td>{s.slHit}</td>
                      <td><span className={scoreTone(s.hitRate * 100)} style={{ opacity: 0.55 }}>{pct(s.hitRate)} low sample</span></td>
                      <td>{formatRMetric(s.avgGrossRResult)}</td>
                      <td>{formatAvgRReason(s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="eyebrow" style={{ marginTop: '1rem' }}>Generated {new Date(perf.generatedAt).toLocaleTimeString()}</p>
      </section>
    </main>
  );
}

async function fetchScan(): Promise<ScanResult> {
  let response: Response;

  try {
    response = await fetch(API_SCAN_URL);
  } catch {
    throw new Error(`API offline. Expected ${API_SCAN_URL} via Vite proxy and ${API_HEALTH_URL} on the API server.`);
  }

  if (!response.ok) {
    let details = "";
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload.message) {
        details = ` ${payload.message}`;
      }
    } catch {
      // Ignore JSON parse failures and fall back to the status-only message.
    }

    throw new Error(
      `Scan request to ${API_SCAN_URL} failed with ${response.status}. Check that the API server is running and ${API_HEALTH_URL} responds.${details}`,
    );
  }
  return (await response.json()) as ScanResult;
}

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [performance, setPerformance] = useState<PerformanceStats | null>(null);
  const [shadow, setShadow] = useState<ShadowStateSnapshot | null>(null);
  const [liveReadiness, setLiveReadiness] = useState<LiveReadinessReport | null>(null);
  const [routeMaturity, setRouteMaturity] = useState<RouteMaturityReport | null>(null);
  const [routeMaturityEra, setRouteMaturityEra] = useState<RouteMaturityEraFilter>('POST_CALIBRATION');
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [page, setPage] = useState<'neural' | 'scanner' | 'performance'>('neural');

  useEffect(() => {
    if (page === 'scanner' && !scan) {
      void refreshScan();
    }
  }, [page, scan]);

  async function refreshScan() {
    setLoadState((current) => (current === 'ready' ? 'ready' : 'loading'));
    setErrorMessage(null);

    try {
      const [next, nextPerformance, nextShadow, nextReadiness, nextMaturity] = await Promise.all([
        fetchScan(),
        fetchPerformance().catch(() => null),
        fetchShadow().catch(() => null),
        fetchLiveReadiness(),
        fetchRouteMaturity(routeMaturityEra),
      ]);
      startTransition(() => {
        setScan(next);
        setPerformance(nextPerformance);
        setShadow(nextShadow);
        setLiveReadiness(nextReadiness);
        setRouteMaturity(nextMaturity);
        setLoadState('ready');
        setSelectedSymbol((current) => {
          const availableCandidates = [...next.top10, ...next.diagnostics.hiddenSkips];
          if (current && availableCandidates.some((candidate) => candidate.symbol === current)) {
            return current;
          }
          return next.top10[0]?.symbol ?? next.diagnostics.hiddenSkips[0]?.symbol ?? null;
        });
      });
    } catch (error) {
      setLoadState('error');
      setErrorMessage(error instanceof Error ? error.message : 'Scan request failed.');
    }
  }

  const selectedCandidate =
    scan?.top10.find((candidate) => candidate.symbol === selectedSymbol) ??
    scan?.diagnostics.hiddenSkips.find((candidate) => candidate.symbol === selectedSymbol) ??
    scan?.top10[0] ??
    scan?.diagnostics.hiddenSkips[0] ??
    null;
  const actionPlan = scan ? deriveActionPlan(scan.top10, performance, scan.marketRegime) : [];
  const selectedEdge = scan && selectedCandidate ? buildEdgeScore(selectedCandidate, performance, scan.marketRegime) : null;
  const selectedTradePlan = selectedCandidate ? buildTradePlan(selectedCandidate) : null;
  const selectedExecution = selectedCandidate ? candidateExecution(selectedCandidate, performance) : null;
  const actionPlanGroups: ActionPlanGroup[] = ['Paper trade review', 'Wait for trigger', 'Avoid / watch only'];

  if (page === 'neural') {
    return (
      <NeuralMindmap
        onOpenScanner={() => setPage('scanner')}
        onOpenPerformance={() => setPage('performance')}
      />
    );
  }

  return (
    <div className="app-shell">
      <div className="backdrop backdrop-a" />
      <div className="backdrop backdrop-b" />
      <header className="hero panel">
        <div>
          <p className="eyebrow">Daily Trading Cockpit v2</p>
          <h1>Kronos-powered paper scanner for daily crypto setups</h1>
          <p className="hero-copy">
            Fresh Binance market data, rule-based ranking, optional Kronos enrichment, and explicit unavailable states
            for whale or sentiment inputs.
          </p>
        </div>
        <div className="hero-actions">
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button className="refresh-button" style={{ opacity: 0.5 }} onClick={() => setPage('neural')}>Neural Map</button>
            <button className="refresh-button" style={{ opacity: page === 'scanner' ? 1 : 0.5 }} onClick={() => setPage('scanner')}>Scanner</button>
            <button className="refresh-button" style={{ opacity: page === 'performance' ? 1 : 0.5 }} onClick={() => setPage('performance')}>Performance</button>
          </div>
          <button className="refresh-button" onClick={() => void refreshScan()}>
            {loadState === 'loading' ? 'Refreshing…' : 'Refresh scan'}
          </button>
          <div className="status-stack">
            <span className="badge badge-amber">Paper only</span>
            <span className="badge badge-slate">No live trading</span>
            <span className="timestamp">
              {scan ? `Generated ${new Date(scan.generatedAt).toLocaleTimeString()}` : 'Waiting for scan data'}
            </span>
          </div>
        </div>
      </header>

      {scan && (
        <section className="topline-grid">
          <article className="panel topline-card">
            <p className="eyebrow">Market Regime</p>
            <h2>{scan.marketRegime}</h2>
          </article>
          <article className="panel topline-card">
            <p className="eyebrow">Coverage</p>
            <h2>{scan.coverage.percent}%</h2>
            <p>
              {scan.coverage.scannedSymbols}/{scan.coverage.totalSymbols} symbols scanned
            </p>
            <p>
              Live {scan.coverage.liveSymbols ?? 0} | Cache-fresh {scan.coverage.cacheFreshSymbols ?? 0}
            </p>
          </article>
          <article className="panel topline-card">
            <p className="eyebrow">Source Status</p>
            <div className="source-status-list">
              <span className={sourceTone(true)}>Binance active</span>
              <span className={kronosSourceTone(scan.diagnostics.kronos)}>{kronosServiceLabel(scan.diagnostics.kronos)}</span>
              <span className={sourceTone(scan.diagnostics.whale.available)}>Whale {scan.diagnostics.whale.available ? 'active' : 'offline'}</span>
              <span className={sourceTone(scan.diagnostics.sentiment.available)}>{socialProviderLabel(scan)} {scan.diagnostics.sentiment.available ? 'active' : 'offline'}</span>
            </div>
            <p>
              {scan.diagnostics.kronos.message}
              {scan.diagnostics.kronos.attempted !== undefined && scan.diagnostics.kronos.attempted > 0
                ? ` | ${scan.diagnostics.kronos.succeeded}/${scan.diagnostics.kronos.attempted} forecasts succeeded`
                : ''}
            </p>
            {(scan.diagnostics.kronos.state === 'DEGRADED' || scan.diagnostics.kronos.state === 'REACHABLE') && (
              <p style={{ marginTop: '0.4rem', opacity: 0.7 }}>
                Kronos {scan.diagnostics.kronos.state === 'REACHABLE' ? 'warming' : 'degraded'}, using Binance/Whale/Social only for action.
              </p>
            )}
            {(scan.diagnostics.trackingQueued || scan.diagnostics.shadowQueued || scan.diagnostics.outcomeCheckQueued) && (
              <p style={{ marginTop: '0.4rem', opacity: 0.7 }}>
                Tracking queued{scan.diagnostics.trackerLastUpdatedAt ? ` | last tracker update ${formatTimestamp(scan.diagnostics.trackerLastUpdatedAt)}` : ''}.
              </p>
            )}
          </article>
        </section>
      )}

      {loadState === 'error' && !scan && (
        <section className="panel empty-panel">
          <h2>Scanner unavailable</h2>
          <p>{errorMessage ?? 'The scan request failed before any data could be rendered.'}</p>
        </section>
      )}

      {page === 'performance' && <PerformancePage />}

      {page === 'scanner' && scan && (
        <main className="dashboard-grid">
          <section className="panel table-panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">Today&apos;s Action Plan</p>
                <h2>What to do today</h2>
              </div>
              <span className="mini-status">Top 3 only</span>
            </div>
            <p className="candidate-copy" style={{ marginBottom: '1rem' }}>Not enough sample for live trading.</p>
            <div className="detail-sections">
              {actionPlanGroups.map((group) => {
                const items = actionPlan.filter((item) => item.group === group);
                return (
                  <section key={group} className="detail-card">
                    <h3>{group}</h3>
                    <div className="metric-list">
                      {items.length === 0 ? (
                        <div className="metric-row">
                          <span>No top-3 candidate in this bucket today.</span>
                        </div>
                      ) : items.map(({ candidate, actionLabel, caution, note, paperOnly, edge, tradePlan, execution }) => (
                        <article key={candidate.symbol} className="action-plan-card">
                          <div className="action-plan-header">
                            <div>
                              <h4>{candidate.symbol}</h4>
                              <div className="input-row" style={{ marginTop: '0.4rem' }}>
                                <span className={candidate.direction === 'SHORT' ? 'badge badge-amber' : 'badge badge-green'}>{candidate.direction}</span>
                                <span className={statusTone(candidate.status)}>{candidate.status}</span>
                                {paperOnly && <span className="badge badge-amber">paper only</span>}
                                <span className={routeModeBadgeClass(execution.routeMode)} title={execution.routeExplanation ?? ''}>{routeModeLabel(execution.routeMode)}</span>
                              </div>
                            </div>
                            <span className={scoreTone(candidate.confidence)}>{actionLabel}</span>
                          </div>
                          <div className="action-plan-body">
                            <p><strong>Edge score</strong> {edge ? formatNumber(edge.score) : 'Unknown'}</p>
                            <p><strong>Selected execution exit</strong> {formatExecutionEntryVariantLabel(execution.selectedEntryVariant)} + {formatExecutionExitVariantLabel(execution.selectedExitVariant)}</p>
                            <p><strong>Heuristic expected Gross / Net R</strong> {formatRMetric(execution.expectedGrossR)} / {formatRMetric(execution.expectedNetR)}</p>
                            <p><strong>Variant sample</strong> {execution.variantSampleSize} | {execution.variantConfidenceTier}</p>
                            <p><strong>Entry zone</strong> {candidate.entryZone ? `${formatNumber(candidate.entryZone[0], 6)} - ${formatNumber(candidate.entryZone[1], 6)}` : 'Unknown'}</p>
                            <p><strong>Entry drift</strong> {entryDriftLabel(candidate)}</p>
                            <p><strong>Entry precision</strong> {execution.entryQualityExplanation.join(' | ')}</p>
                            <p><strong>SL</strong> {formatNumber(candidate.stopLoss, 6)}</p>
                            <p><strong>TP1</strong> {formatNumber(candidate.takeProfits.tp1, 6)}</p>
                            <p><strong>RR</strong> {formatNumber(candidate.riskReward)}</p>
                            <p><strong>Bias</strong> {tradePlan.biasSummary}</p>
                            <p><strong>Entry playbook</strong> {tradePlan.entryPlaybook}</p>
                            <p><strong>Entry action</strong> {tradePlan.entryAction}</p>
                            <p><strong>Trigger</strong> {tradePlan.exactEntryTrigger}</p>
                            {tradePlan.noChaseWarning && <p><strong>No-chase</strong> {tradePlan.noChaseWarning}</p>}
                            <p><strong>Contextual exit caution</strong> {tradePlan.exitMode}</p>
                            <p><strong>Exit precision</strong> {execution.exitPlanExplanation.join(' | ')}</p>
                            <p><strong>Runner</strong> {tradePlan.runnerAllowed ? 'Yes' : 'No'}</p>
                            <p><strong>Staged plan</strong> {tradePlan.stagedEntrySplit} | {tradePlan.stagedExitSplit}</p>
                            <p><strong>Reason</strong> {candidate.reason[0] ?? 'No primary reason available.'}</p>
                            {note && <p><strong>Note</strong> {note}</p>}
                            {edge?.netEdgeWarning && <p><strong>Net edge</strong> {edge.netEdgeWarning}</p>}
                            <p><strong>Caution</strong> {caution}</p>
                            {paperOnly && (
                              <p className="action-plan-safety">Not enough sample for live trading.</p>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </section>

          {routeMaturity && (
            <RouteMaturityPanel
              maturity={routeMaturity}
              eraFilter={routeMaturityEra}
              onEraChange={(era) => {
                setRouteMaturityEra(era);
                void fetchRouteMaturity(era).then(setRouteMaturity);
              }}
            />
          )}
          {liveReadiness && <LiveReadinessPanel readiness={liveReadiness} />}

          {shadow && (
            <section className="panel table-panel">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Shadow Execution</p>
                  <h2>Shadow Positions</h2>
                </div>
                <span className="mini-status">
                  {shadow.summary.openPositions} open variants | {shadow.summary.activeOpenIdeaCount} active ideas
                </span>
              </div>
              <div className="detail-sections">
                <section className="detail-card">
                  <h3>Open positions</h3>
                  <div className="metric-list">
                    {shadow.openPositions.length === 0 ? (
                      <div className="metric-row">
                        <span>No shadow positions are open yet.</span>
                      </div>
                    ) : shadow.openPositions.map((position) => {
                      const primary = position.variants.find((variant) => variant.variant === position.primaryVariant) ?? position.variants[0];
                      const isPendingEntry = position.entryState === 'PENDING_ENTRY';
                      return (
                        <article key={position.id} className="action-plan-card">
                          <div className="action-plan-header">
                            <div>
                              <h4>{position.symbol}</h4>
                              <div className="input-row" style={{ marginTop: '0.4rem' }}>
                                <span className={position.direction === 'SHORT' ? 'badge badge-amber' : 'badge badge-green'}>{position.direction}</span>
                                <span className={statusTone(position.latestStatus)}>{position.latestStatus}</span>
                                <span className="badge badge-slate">{isPendingEntry ? 'PENDING ENTRY' : position.primaryVariant}</span>
                                <span
                                  className={routeModeBadgeClass(position.variantSelection?.routeMode)}
                                  title={position.variantSelection?.routeExplanation ?? ''}
                                >
                                  {routeModeLabel(position.variantSelection?.routeMode)}
                                </span>
                              </div>
                            </div>
                            <span className={scoreTone((primary?.unrealizedR ?? 0) * 25)}>{formatRMetric(primary?.unrealizedR ?? null)}</span>
                          </div>
                          <div className="action-plan-body">
                            <p><strong>Entry</strong> {formatNumber(position.entryPrice, 6)}</p>
                            <p><strong>Current</strong> {formatNumber(primary?.currentPrice ?? null, 6)}</p>
                            <p><strong>Entry zone</strong> {position.entryZone ? `${formatNumber(position.entryZone[0], 6)} - ${formatNumber(position.entryZone[1], 6)}` : 'Unknown'}</p>
                            <p><strong>SL</strong> {formatNumber(position.stopLoss, 6)}</p>
                            <p><strong>TP1 / TP2 / TP3</strong> {`${formatNumber(position.tp1, 6)} / ${formatNumber(position.tp2, 6)} / ${formatNumber(position.tp3, 6)}`}</p>
                            <p><strong>Status</strong> {isPendingEntry ? 'PENDING_ENTRY' : primary?.state ?? 'Unknown'} | remaining {formatNumber((primary?.remainingSizePct ?? 0) * 100)}%</p>
                            <p><strong>Fill reason</strong> {position.entryFillReason ?? 'Waiting for selected entry plan.'}</p>
                            <p><strong>Exit plan</strong> {position.tradePlan.exitMode}</p>
                            <p><strong>Reason</strong> {position.latestReason[0] ?? 'Shadow position active.'}</p>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>

                <section className="detail-card">
                  <h3>Shadow execution log</h3>
                  <div className="metric-list">
                    {shadow.recentLog.length === 0 ? (
                      <div className="metric-row">
                        <span>No shadow execution events yet.</span>
                      </div>
                    ) : shadow.recentLog.slice(0, 20).map((event) => (
                      <div key={event.id} className="metric-row">
                        <span>{event.symbol} {event.variant}</span>
                        <strong><span className="badge badge-slate">{event.type}</span></strong>
                        <span>{event.message}</span>
                        <span>{new Date(event.createdAt).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </section>
          )}

          <section className="panel table-panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">Top 10</p>
                <h2>Opportunity table</h2>
              </div>
              <span className="mini-status">{scan.top10.length} ranked candidates</span>
            </div>
            {scan.top10.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Symbol</th>
                      <th>Status</th>
                      <th>Direction</th>
                      <th>Opportunity</th>
                      <th>Danger</th>
                      <th>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scan.top10.map((candidate) => (
                      <tr
                        key={candidate.symbol}
                        className={candidate.symbol === selectedCandidate?.symbol ? 'is-selected' : undefined}
                        onClick={() => setSelectedSymbol(candidate.symbol)}
                      >
                        <td>{candidate.rank}</td>
                        <td>{candidate.symbol}</td>
                        <td>
                          <span className={statusTone(candidate.status)}>{candidate.status}</span>
                        </td>
                        <td>{candidate.direction}</td>
                        <td>{candidate.opportunityScore}</td>
                        <td>{candidate.dangerScore}</td>
                        <td>{candidate.confidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <h3>No main-list opportunities</h3>
                <p>All scanned symbols were filtered into diagnostics. The best filtered candidate is still shown below so the page stays usable.</p>
              </div>
            )}
          </section>

          <section className="panel cards-panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">Candidates</p>
                <h2>Visible setups</h2>
              </div>
              <span className="mini-status">READY, WAIT, WATCH, TRADE_NOW</span>
            </div>
            <div className="cards-grid">
              {scan.top10.map((candidate) => (
                <button
                  key={candidate.symbol}
                  className={`candidate-card ${candidate.symbol === selectedCandidate?.symbol ? 'candidate-card-active' : ''}`}
                  onClick={() => setSelectedSymbol(candidate.symbol)}
                >
                  <div className="candidate-topline">
                    <div>
                      <h3>{candidate.symbol}</h3>
                      <p>{candidate.direction}</p>
                    </div>
                    <span className="score-pill">{candidate.opportunityScore}</span>
                  </div>
                  <div className="candidate-meta">
                    <span className={statusTone(candidate.status)}>{candidate.status}</span>
                    <span className={scoreTone(candidate.confidence)}>{candidate.confidence} conf</span>
                    {candidate.selectedExecutionPlan && (
                      <span className={routeModeBadgeClass(candidate.selectedExecutionPlan.routeMode)}>{routeModeLabel(candidate.selectedExecutionPlan.routeMode)}</span>
                    )}
                  </div>
                  <div className="score-strip">
                    <span>Long {candidate.longScore}</span>
                    <span>Short {candidate.shortScore}</span>
                    <span>Danger {candidate.dangerScore}</span>
                  </div>
                  <div className="input-row">
                    {activeInputs(candidate).map((label) => (
                      <span key={label} className="badge badge-slate">{label}</span>
                    ))}
                  </div>
                  <div className="score-strip">
                    <span>
                      {kronosStatusLabel(candidate, scan.diagnostics.kronos)}
                    </span>
                    <span>
                      Whale {candidate.whale.available ? `${candidate.whale.signal} ${candidate.whale.score}` : 'offline'}
                    </span>
                  </div>
                  {hasSourceConflict(candidate) && (
                    <div className="input-row">
                      <span className="badge badge-amber">SOURCE_CONFLICT</span>
                    </div>
                  )}
                  <p className="candidate-copy">{candidate.reason[0] ?? 'No directional reason available.'}</p>
                </button>
              ))}
            </div>
            {scan.top10.length === 0 && selectedCandidate && (
              <div className="empty-state compact-empty">
                <h3>{selectedCandidate.symbol} is the best filtered candidate</h3>
                <p>It stayed out of the main list because its status is {selectedCandidate.status}. Inspect its blockers below.</p>
              </div>
            )}
          </section>

          {selectedCandidate && (
            <>
              <section className="panel detail-panel">
                <div className="section-header">
                  <div>
                    <p className="eyebrow">Detail</p>
                    <h2>{selectedCandidate.symbol}</h2>
                  </div>
                  <span className={statusTone(selectedCandidate.status)}>{selectedCandidate.status}</span>
                </div>

                <div className="score-grid">
                  <article className="score-card">
                    <span>Long</span>
                    <strong>{selectedCandidate.longScore}</strong>
                  </article>
                  <article className="score-card">
                    <span>Short</span>
                    <strong>{selectedCandidate.shortScore}</strong>
                  </article>
                  <article className="score-card">
                    <span>Opportunity</span>
                    <strong>{selectedCandidate.opportunityScore}</strong>
                  </article>
                  <article className="score-card">
                    <span>Danger</span>
                    <strong>{selectedCandidate.dangerScore}</strong>
                  </article>
                  <article className="score-card">
                    <span>Confidence</span>
                    <strong>{selectedCandidate.confidence}</strong>
                  </article>
                </div>

                <div className="detail-summary">
                  <div>
                    <span className="stat-label">Entry zone</span>
                    <strong>
                      {selectedCandidate.entryZone
                        ? `${formatMoney(selectedCandidate.entryZone[0])} - ${formatMoney(selectedCandidate.entryZone[1])}`
                        : 'Unavailable'}
                    </strong>
                  </div>
                  <div>
                    <span className="stat-label">Stop</span>
                    <strong>{formatMoney(selectedCandidate.stopLoss)}</strong>
                  </div>
                  <div>
                    <span className="stat-label">Risk / Reward</span>
                    <strong>{formatNumber(selectedCandidate.riskReward)}</strong>
                  </div>
                  <div>
                    <span className="stat-label">Entry drift</span>
                    <strong>{entryDriftLabel(selectedCandidate)}</strong>
                  </div>
                  <div>
                    <span className="stat-label">Spread</span>
                    <strong>{selectedCandidate.spread.percent === null ? 'Unknown' : `${formatNumber(selectedCandidate.spread.percent, 4)}%`}</strong>
                  </div>
                </div>

                <div className="detail-sections">
                  <section className="detail-card">
                    <h3>Indicator summary</h3>
                    <div className="metric-list">
                      {[
                        selectedCandidate.indicators.fiveMinute,
                        selectedCandidate.indicators.fifteenMinute,
                        selectedCandidate.indicators.oneHour,
                      ].map((snapshot) => (
                        <div key={snapshot.timeframe} className="metric-row metric-row-wrap">
                          <span>{snapshot.timeframe}</span>
                          <strong>
                            {snapshot.trend} | RSI {formatNumber(snapshot.rsi14)} | ATR {formatNumber(snapshot.atrPercent)}%
                          </strong>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="detail-card">
                    <h3>Fibonacci</h3>
                    <div className="metric-list">
                      <div className="metric-row"><span>0.236</span><strong>{formatMoney(selectedCandidate.fibonacci.retracement236)}</strong></div>
                      <div className="metric-row"><span>0.382</span><strong>{formatMoney(selectedCandidate.fibonacci.retracement382)}</strong></div>
                      <div className="metric-row"><span>0.5</span><strong>{formatMoney(selectedCandidate.fibonacci.retracement500)}</strong></div>
                      <div className="metric-row"><span>0.618</span><strong>{formatMoney(selectedCandidate.fibonacci.retracement618)}</strong></div>
                      <div className="metric-row"><span>0.786</span><strong>{formatMoney(selectedCandidate.fibonacci.retracement786)}</strong></div>
                      <div className="metric-row"><span>1.272</span><strong>{formatMoney(selectedCandidate.fibonacci.extension1272)}</strong></div>
                      <div className="metric-row"><span>1.618</span><strong>{formatMoney(selectedCandidate.fibonacci.extension1618)}</strong></div>
                    </div>
                  </section>

                  <section className="detail-card">
                    <h3>ATR, SL, TP</h3>
                    <div className="metric-list">
                      <div className="metric-row"><span>ATR 14</span><strong>{formatMoney(selectedCandidate.atr.atr14)}</strong></div>
                      <div className="metric-row"><span>ATR %</span><strong>{formatNumber(selectedCandidate.atr.atrPercent)}%</strong></div>
                      <div className="metric-row"><span>TP1</span><strong>{formatMoney(selectedCandidate.takeProfits.tp1)}</strong></div>
                      <div className="metric-row"><span>TP2</span><strong>{formatMoney(selectedCandidate.takeProfits.tp2)}</strong></div>
                      <div className="metric-row"><span>TP3</span><strong>{formatMoney(selectedCandidate.takeProfits.tp3)}</strong></div>
                    </div>
                  </section>

                  <section className="detail-card">
                    <h3>Optional sources</h3>
                    <div className="metric-list">
                      {selectedCandidate.kronosBias !== 'UNAVAILABLE' && (
                        <div className="metric-row">
                          <span>Kronos</span>
                          <strong>{selectedCandidate.kronosBias} | {formatNumber(selectedCandidate.kronosConfidence)}</strong>
                        </div>
                      )}
                      {selectedCandidate.kronosBias === 'UNAVAILABLE' && (
                        <div className="metric-row metric-row-wrap">
                          <span>Kronos</span>
                          <strong>
                            {scan.diagnostics.kronos.state === 'FORECAST_HEALTHY'
                              ? 'service active, symbol unavailable'
                              : scan.diagnostics.kronos.state === 'DEGRADED' || scan.diagnostics.kronos.state === 'REACHABLE'
                                ? 'service reachable, symbol unavailable'
                                : 'offline'}
                          </strong>
                          <span>
                            {scan.diagnostics.kronos.state === 'FORECAST_HEALTHY'
                              ? `Kronos service active, symbol forecast unavailable: ${selectedCandidate.kronosReason ?? 'unavailable'}`
                              : scan.diagnostics.kronos.state === 'DEGRADED' || scan.diagnostics.kronos.state === 'REACHABLE'
                                ? `Kronos service reachable, symbol forecast unavailable: ${selectedCandidate.kronosReason ?? 'unavailable'}`
                                : `Kronos offline: ${selectedCandidate.kronosReason ?? scan.diagnostics.kronos.message}`}
                          </span>
                        </div>
                      )}
                      {selectedCandidate.whale.available && (
                        <div className="metric-row metric-row-wrap">
                          <span>Whale</span>
                          <strong>{selectedCandidate.whale.signal} | {selectedCandidate.whale.score}</strong>
                          <span>{selectedCandidate.whale.reason}</span>
                        </div>
                      )}
                      {selectedCandidate.sentiment.available && (
                        <div className="metric-row metric-row-wrap">
                          <span>Social</span>
                          <strong>
                            {selectedCandidate.sentiment.signal} | {selectedCandidate.sentiment.score} | {formatNumber(selectedCandidate.sentiment.confidence)} conf
                          </strong>
                          <span>{selectedCandidate.sentiment.scope ?? 'Unknown'} | {selectedCandidate.sentiment.source ?? 'unknown'}</span>
                          <span>{selectedCandidate.sentiment.reason}</span>
                        </div>
                      )}
                      {selectedCandidate.sourceConflict && (
                        <div className="metric-row metric-row-wrap">
                          <span>Conflict</span>
                          <strong>SOURCE_CONFLICT</strong>
                          <span>Kronos and whale direction disagree, so status is downgraded one level.</span>
                        </div>
                      )}
                      {selectedCandidate.kronosBias === 'UNAVAILABLE' && !selectedCandidate.whale.available && !selectedCandidate.sentiment.available && (
                        <div className="metric-row">
                          <span>Active sources</span>
                          <strong>Binance only</strong>
                        </div>
                      )}
                    </div>
                  </section>

                  {selectedCandidate.kronosBias !== 'UNAVAILABLE' && (
                    <section className="detail-card">
                      <h3>Kronos diagnostic</h3>
                      <div className="metric-list">
                        <div className="metric-row"><span>Confidence bucket</span><strong>{selectedCandidate.kronosConfidenceBucket ?? 'Unknown'}</strong></div>
                        <div className="metric-row"><span>Selected bias</span><strong>{selectedCandidate.selectedKronosBias ?? selectedCandidate.kronosBias}</strong></div>
                        <div className="metric-row"><span>Bias 1h / 4h</span><strong>{`${selectedCandidate.kronosBias1h ?? 'Unknown'} / ${selectedCandidate.kronosBias4h ?? 'Unknown'}`}</strong></div>
                        <div className="metric-row"><span>Horizon conflict</span><strong>{selectedCandidate.horizonConflict ? 'Yes' : 'No'}</strong></div>
                        <div className="metric-row"><span>Current price</span><strong>{formatMoney(selectedCandidate.currentPrice)}</strong></div>
                        <div className="metric-row"><span>Forecast median close</span><strong>{formatMoney(selectedCandidate.forecastMedianClose)}</strong></div>
                        <div className="metric-row"><span>Forecast p25 / p75</span><strong>{`${formatMoney(selectedCandidate.forecastP25Close)} / ${formatMoney(selectedCandidate.forecastP75Close)}`}</strong></div>
                        <div className="metric-row"><span>Forecast max high</span><strong>{formatMoney(selectedCandidate.forecastMaxHigh)}</strong></div>
                        <div className="metric-row"><span>Forecast min low</span><strong>{formatMoney(selectedCandidate.forecastMinLow)}</strong></div>
                        <div className="metric-row"><span>Probability up / down</span><strong>{`${formatNumber(selectedCandidate.probabilityUp)}% / ${formatNumber(selectedCandidate.probabilityDown)}%`}</strong></div>
                        <div className="metric-row"><span>Expected return 1h</span><strong>{formatKronosHorizon(selectedCandidate.expectedReturn1h)}</strong></div>
                        <div className="metric-row"><span>Expected return 4h</span><strong>{formatKronosHorizon(selectedCandidate.expectedReturn4h)}</strong></div>
                        <div className="metric-row"><span>Expected return 15m</span><strong>{formatKronosHorizon(selectedCandidate.expectedReturn15m, 'not available for 1h Kronos input')}</strong></div>
                        <div className="metric-row"><span>Kronos risk</span><strong>{formatNumber(selectedCandidate.kronosRisk)}</strong></div>
                        {shortHorizonOnly(selectedCandidate) && (
                          <div className="metric-row metric-row-wrap"><span>Guidance</span><strong>short-horizon bias only; TP1 fast, no runner</strong></div>
                        )}
                      </div>
                    </section>
                  )}

                  {selectedEdge && (
                    <section className="detail-card">
                      <h3>Edge Plan</h3>
                      <div className="metric-list">
                        <div className="metric-row"><span>Edge score</span><strong>{formatNumber(selectedEdge.score)}</strong></div>
                        <div className="metric-row"><span>Entry quality</span><strong>{selectedEdge.entryQualityLabel}</strong></div>
                        <div className="metric-row"><span>Historical net expectancy</span><strong>{formatNumber(selectedEdge.historicalNetExpectancy)}</strong></div>
                        <div className="metric-row"><span>Kronos support</span><strong>{formatNumber(selectedEdge.kronosForecastSupport)}</strong></div>
                        <div className="metric-row"><span>Whale support</span><strong>{formatNumber(selectedEdge.whaleFlowSupport)}</strong></div>
                        <div className="metric-row"><span>Historical best entry candidate (analytics only)</span><strong>{formatVariantLabel(selectedEdge.bestShadowEntryVariant, performance?.windows["1h"].shadowVariants)}</strong></div>
                        <div className="metric-row"><span>Historical best exit candidate (analytics only)</span><strong>{formatVariantLabel(selectedEdge.bestShadowExitVariant, performance?.windows["1h"].shadowVariants)}</strong></div>
                        <div className="metric-row metric-row-wrap"><span>Kronos exit guidance</span><strong>{selectedEdge.kronosExitGuidance}</strong></div>
                        <div className="metric-row"><span>Horizon conflict</span><strong>{selectedEdge.horizonConflict ? 'Yes' : 'No'}</strong></div>
                        <div className="metric-row"><span>Short-horizon only</span><strong>{selectedEdge.shortHorizonOnly ? 'Yes' : 'No'}</strong></div>
                        <div className="metric-row metric-row-wrap"><span>Whale confirmation / caution</span><strong>{selectedEdge.whaleGuidance}</strong></div>
                        {selectedEdge.netEdgeWarning && (
                          <div className="metric-row metric-row-wrap"><span>Net edge warning</span><strong>{selectedEdge.netEdgeWarning}</strong></div>
                        )}
                        {selectedEdge.notes.length > 0 && (
                          <div className="metric-row metric-row-wrap"><span>Notes</span><strong>{selectedEdge.notes.join(" | ")}</strong></div>
                        )}
                        {selectedEdge.cautions.length > 0 && (
                          <div className="metric-row metric-row-wrap"><span>Cautions</span><strong>{selectedEdge.cautions.join(" | ")}</strong></div>
                        )}
                      </div>
                    </section>
                  )}

                  {selectedExecution && (
                    <section className="detail-card">
                      <h3>Execution Plan</h3>
                      <div className="metric-list">
                        <div className="metric-row"><span>Selected execution entry</span><strong>{formatExecutionEntryVariantLabel(selectedExecution.selectedEntryVariant)}</strong></div>
                        <div className="metric-row"><span>Selected execution exit</span><strong>{formatExecutionExitVariantLabel(selectedExecution.selectedExitVariant)}</strong></div>
                        <div className="metric-row"><span>Selection source</span><strong>{formatSelectionSource(selectedExecution.selectionSource)}</strong></div>
                        <div className="metric-row"><span>Route mode</span><strong><span className={routeModeBadgeClass(selectedExecution.routeMode)}>{routeModeLabel(selectedExecution.routeMode)}</span></strong></div>
                        {selectedExecution.routeScore !== undefined && (
                          <div className="metric-row"><span>Route score</span><strong>{formatNumber(selectedExecution.routeScore)}</strong></div>
                        )}
                        {selectedExecution.primaryProfitEligible !== undefined && (
                          <div className="metric-row"><span>Primary profit eligible</span><strong>{selectedExecution.primaryProfitEligible ? 'Yes' : 'No'}</strong></div>
                        )}
                        {selectedExecution.routeReasonCodes && selectedExecution.routeReasonCodes.length > 0 && (
                          <div className="metric-row metric-row-wrap"><span>Route reason codes</span><strong>{selectedExecution.routeReasonCodes.join(' | ')}</strong></div>
                        )}
                        {selectedExecution.routeExplanation && (
                          <div className="metric-row metric-row-wrap"><span>Route explanation</span><strong>{selectedExecution.routeExplanation}</strong></div>
                        )}
                        {selectedExecution.researchReason && (
                          <div className="metric-row metric-row-wrap"><span>Research reason</span><strong>{selectedExecution.researchReason}</strong></div>
                        )}
                        {selectedExecution.dataCollectionReason && (
                          <div className="metric-row metric-row-wrap"><span>Data-collection reason</span><strong>{selectedExecution.dataCollectionReason}</strong></div>
                        )}
                        {selectedExecution.diagnostics && (
                          <RoutePanel diagnostics={selectedExecution.diagnostics} />
                        )}
                        <div className="metric-row"><span>Heuristic expected Gross / Net R</span><strong>{`${formatRMetric(selectedExecution.expectedGrossR)} / ${formatRMetric(selectedExecution.expectedNetR)}`}</strong></div>
                        {selectedExecution.calibratedExpectedNetR !== undefined && (
                          <>
                            <div className="metric-row">
                              <span>Calibration-adjusted Net R</span>
                              <strong style={{ color: (selectedExecution.calibratedExpectedNetR ?? 0) > 0 ? '#86efac' : (selectedExecution.calibratedExpectedNetR ?? 0) < 0 ? '#fca5a5' : undefined }}>
                                {formatRMetric(selectedExecution.calibratedExpectedNetR)}
                                {selectedExecution.calibrationPenaltyR !== undefined && selectedExecution.calibrationPenaltyR !== 0 && (
                                  <span style={{ opacity: 0.7, marginLeft: 8 }}>
                                    ({selectedExecution.calibrationPenaltyR > 0 ? '+' : ''}{selectedExecution.calibrationPenaltyR.toFixed(3)}R adj.)
                                  </span>
                                )}
                              </strong>
                            </div>
                            <div className="metric-row">
                              <span>Calibration source / sample / confidence</span>
                              <strong>
                                {selectedExecution.calibrationSourceUsed ?? 'none'} | n={selectedExecution.calibrationSampleSize ?? 0} | {selectedExecution.calibrationConfidence ?? 'LOW'}
                              </strong>
                            </div>
                            <div className="metric-row">
                              <span>Calibration verdict</span>
                              <strong>
                                <span className={
                                  selectedExecution.calibrationVerdict === 'CALIBRATED_POSITIVE' ? 'badge badge-green' :
                                  selectedExecution.calibrationVerdict === 'RAW_EDGE_NOT_VALIDATED' ? 'badge badge-red' :
                                  selectedExecution.calibrationVerdict === 'CALIBRATED_NEGATIVE' ? 'badge badge-amber' :
                                  'badge badge-slate'
                                }>{selectedExecution.calibrationVerdict ?? 'INSUFFICIENT_SAMPLE'}</span>
                              </strong>
                            </div>
                            {selectedExecution.calibrationDiagnosisCodes && selectedExecution.calibrationDiagnosisCodes.length > 0 && (
                              <div className="metric-row metric-row-wrap">
                                <span>Calibration diagnosis</span>
                                <strong>{selectedExecution.calibrationDiagnosisCodes.join(' | ')}</strong>
                              </div>
                            )}
                            {selectedExecution.calibrationExplanation && (
                              <div className="metric-row metric-row-wrap">
                                <span>Calibration explanation</span>
                                <strong>{selectedExecution.calibrationExplanation}</strong>
                              </div>
                            )}
                            {selectedExecution.calibrationVerdict === 'RAW_EDGE_NOT_VALIDATED' && (
                              <div className="metric-row metric-row-wrap">
                                <span>Calibration warning</span>
                                <strong style={{ color: '#fca5a5' }}>
                                  Raw heuristic edge has historically overestimated realized R for this route.
                                  Treat as evidence collection, not profit route.
                                </strong>
                              </div>
                            )}
                          </>
                        )}
                        {(() => {
                          // Heuristic edge is positive but route hasn't been promoted: explain why this is not actionable.
                          const heuristicPositive =
                            selectedExecution.expectedNetR !== null && selectedExecution.expectedNetR > 0;
                          const notPrimary = selectedExecution.routeMode !== 'PROFIT_CANDIDATE';
                          if (heuristicPositive && notPrimary) {
                            return (
                              <div className="metric-row metric-row-wrap">
                                <span>Why heuristic edge isn't actionable yet</span>
                                <strong>Positive heuristic edge, but not yet validated by route/symbol evidence. Status stays {routeModeLabel(selectedExecution.routeMode)}.</strong>
                              </div>
                            );
                          }
                          return null;
                        })()}
                        {selectedExecution.selectionSource === 'replay' && (
                          <div className="metric-row metric-row-wrap">
                            <span>Validated combo evidence</span>
                            <strong>
                              {`net ${formatRMetric(selectedExecution.expectedNetR)} | PF ${selectedExecution.profitFactor === null ? 'n/a' : formatNumber(selectedExecution.profitFactor)} | sample ${selectedExecution.variantSampleSize} | tier ${selectedExecution.variantConfidenceTier}`}
                            </strong>
                          </div>
                        )}
                        {(() => {
                          // Symbol historical evidence pulled from perf.bySymbol for the selected candidate.
                          const symbolStat =
                            performance?.bySymbol.find((s) => s.symbol === selectedCandidate.symbol) ??
                            performance?.earlySampleSymbols.find((s) => s.symbol === selectedCandidate.symbol) ??
                            null;
                          if (!symbolStat) return null;
                          return (
                            <div className="metric-row metric-row-wrap">
                              <span>Symbol historical evidence</span>
                              <strong>
                                {`net ${formatRMetric(symbolStat.avgNetRResult)} | resolved ${symbolStat.resolved}`}
                              </strong>
                            </div>
                          );
                        })()}
                        <div className="metric-row"><span>Net edge after cost</span><strong>{formatRMetric(selectedExecution.netEdgeAfterCost)}</strong></div>
                        <div className="metric-row"><span>Cost R</span><strong>{formatRMetric(selectedExecution.costR)}</strong></div>
                        <div className="metric-row"><span>Spread / fee-slip R</span><strong>{`${formatRMetric(selectedExecution.spreadR)} / ${formatRMetric(selectedExecution.feeSlippageR)}`}</strong></div>
                        <div className="metric-row"><span>Stop distance</span><strong>{selectedExecution.stopDistanceBps === null ? 'Unknown' : `${selectedExecution.stopDistanceBps.toFixed(2)}bps`}</strong></div>
                        <div className="metric-row"><span>Profit factor</span><strong>{selectedExecution.profitFactor === null ? 'Unknown' : formatNumber(selectedExecution.profitFactor)}</strong></div>
                        <div className="metric-row"><span>Fill / no-fill rate</span><strong>{`${selectedExecution.fillRate === null ? 'Unknown' : `${selectedExecution.fillRate.toFixed(2)}%`} / ${selectedExecution.noFillRate === null ? 'Unknown' : `${selectedExecution.noFillRate.toFixed(2)}%`}`}</strong></div>
                        <div className="metric-row"><span>Variant sample</span><strong>{`${selectedExecution.variantSampleSize} filled | ${selectedExecution.variantConfidenceTier}`}</strong></div>
                        <div className="metric-row"><span>Cost assumption</span><strong>{selectedExecution.costAssumption}</strong></div>
                        <div className="metric-row"><span>Entry drift %</span><strong>{selectedExecution.entryDriftPct === null ? 'Unknown' : `${selectedExecution.entryDriftPct.toFixed(2)}%`}</strong></div>
                        <div className="metric-row"><span>Entry drift ATR</span><strong>{selectedExecution.entryDriftAtr === null ? 'Unknown' : selectedExecution.entryDriftAtr.toFixed(2)}</strong></div>
                        <div className="metric-row"><span>Chase risk</span><strong>{selectedExecution.chaseRisk}</strong></div>
                        <div className="metric-row metric-row-wrap"><span>Why selected</span><strong>{selectedExecution.selectionReason}</strong></div>
                        <div className="metric-row metric-row-wrap"><span>Entry quality</span><strong>{selectedExecution.entryQualityExplanation.join(' | ')}</strong></div>
                        <div className="metric-row metric-row-wrap"><span>Exit precision</span><strong>{selectedExecution.exitPlanExplanation.join(' | ')}</strong></div>
                        {selectedExecution.variantConfidenceTier === 'early' && (
                          <div className="metric-row metric-row-wrap"><span>Early sample warning</span><strong>Replay sample is still early, so this selection stays advisory and may fall back to heuristic guidance.</strong></div>
                        )}
                      </div>
                    </section>
                  )}

                  {selectedTradePlan && (
                    <section className="detail-card">
                      <h3>Trade Plan</h3>
                      <div className="metric-list">
                        <div className="metric-row"><span>Bias / direction quality</span><strong>{selectedTradePlan.biasSummary}</strong></div>
                        <div className="metric-row"><span>Direction gap</span><strong>{formatNumber(selectedTradePlan.directionGap)}</strong></div>
                        <div className="metric-row"><span>Entry playbook</span><strong>{selectedTradePlan.entryPlaybook}</strong></div>
                        <div className="metric-row"><span>Entry action</span><strong>{selectedTradePlan.entryAction}</strong></div>
                        <div className="metric-row metric-row-wrap"><span>Exact trigger</span><strong>{selectedTradePlan.exactEntryTrigger}</strong></div>
                        {selectedTradePlan.noChaseWarning && (
                          <div className="metric-row metric-row-wrap"><span>No-chase</span><strong>{selectedTradePlan.noChaseWarning}</strong></div>
                        )}
                        <div className="metric-row metric-row-wrap"><span>Invalidation</span><strong>{selectedTradePlan.invalidation.join(' | ')}</strong></div>
                        <div className="metric-row"><span>SL</span><strong>{formatMoney(selectedTradePlan.stopLoss)}</strong></div>
                        <div className="metric-row"><span>TP1 / TP2 / TP3</span><strong>{`${formatMoney(selectedTradePlan.takeProfit1)} / ${formatMoney(selectedTradePlan.takeProfit2)} / ${formatMoney(selectedTradePlan.takeProfit3)}`}</strong></div>
                        <div className="metric-row"><span>Contextual exit caution (guidance, not selected exit)</span><strong>{selectedTradePlan.exitMode}</strong></div>
                        <div className="metric-row metric-row-wrap"><span>Early exit</span><strong>{selectedTradePlan.earlyExitCondition}</strong></div>
                        <div className="metric-row"><span>Staged entry</span><strong>{selectedTradePlan.stagedEntrySplit}</strong></div>
                        <div className="metric-row"><span>Staged exit</span><strong>{selectedTradePlan.stagedExitSplit}</strong></div>
                        <div className="metric-row"><span>Runner allowed</span><strong>{selectedTradePlan.runnerAllowed ? 'Yes' : 'No'}</strong></div>
                        <div className="metric-row"><span>Horizon conflict</span><strong>{selectedTradePlan.horizonConflict ? 'Yes' : 'No'}</strong></div>
                        <div className="metric-row"><span>Short-horizon only</span><strong>{selectedTradePlan.shortHorizonOnly ? 'Yes' : 'No'}</strong></div>
                        <div className="metric-row metric-row-wrap"><span>Why</span><strong>{selectedTradePlan.why.join(' | ')}</strong></div>
                      </div>
                    </section>
                  )}
                </div>

                <div className="detail-sections">
                  <section className="detail-card">
                    <h3>Reason</h3>
                    <div className="pill-column">
                      {selectedCandidate.reason.map((item) => (
                        <span key={item} className="info-pill">
                          {item}
                        </span>
                      ))}
                    </div>
                  </section>

                  <section className="detail-card">
                    <h3>Blockers</h3>
                    <div className="pill-column">
                      {selectedCandidate.blockers.length > 0 ? (
                        selectedCandidate.blockers.map((item) => (
                          <span key={item} className="info-pill info-pill-warn">
                            {item}
                          </span>
                        ))
                      ) : (
                        <span className="info-pill">No major blockers detected.</span>
                      )}
                    </div>
                  </section>
                </div>
              </section>

              <ChartPanel candidate={selectedCandidate} />
            </>
          )}

          <section className="panel diagnostics-panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">Diagnostics</p>
                <h2>Filtered and unavailable inputs</h2>
              </div>
              <span className="mini-status">{scan.diagnostics.hiddenSkips.length} hidden skips</span>
            </div>
            <div className="diagnostic-grid">
              <article className="diagnostic-card">
                <span className="badge badge-slate">Whale source</span>
                <p>{scan.diagnostics.whale.message}</p>
              </article>
              <article className="diagnostic-card">
                <span className="badge badge-slate">Sentiment source</span>
                <p>{scan.diagnostics.sentiment.message}</p>
              </article>
              <article className="diagnostic-card">
                <span className="badge badge-amber">Skip list</span>
                <p>
                  {scan.diagnostics.hiddenSkips.length > 0
                    ? scan.diagnostics.hiddenSkips.map((candidate) => candidate.symbol).join(', ')
                    : 'No hidden skip candidates on this refresh.'}
                </p>
              </article>
              <article className="diagnostic-card">
                <span className="badge badge-slate">Scan failures</span>
                <p>
                  {scan.diagnostics.symbolFailures.length > 0
                    ? scan.diagnostics.symbolFailures.map((failure) => `${failure.symbol} [${failure.failureType}/${failure.stage}]: ${failure.reason}`).join(' | ')
                    : 'All 20 symbols completed the fetch stage on this refresh.'}
                </p>
              </article>
            </div>
            {scan.diagnostics.hiddenSkips.length > 0 && (
              <div className="hidden-skip-list">
                {scan.diagnostics.hiddenSkips.slice(0, 5).map((candidate) => (
                  <article key={candidate.symbol} className="diagnostic-card">
                    <div className="metric-row">
                      <strong>{candidate.symbol}</strong>
                      <span className={statusTone(candidate.status)}>{candidate.status}</span>
                    </div>
                    <p>{candidate.blockers[0] ?? 'Filtered out by scanner safety rules.'}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
function sourceTone(active: boolean) {
  return active ? 'badge badge-green' : 'badge badge-slate';
}

function kronosSourceTone(kronos: CapabilitySnapshot) {
  if (kronos.state === 'FORECAST_HEALTHY') return 'badge badge-green';
  if (kronos.state === 'DEGRADED' || kronos.state === 'REACHABLE') return 'badge badge-amber';
  return 'badge badge-slate';
}

function activeInputs(candidate: Candidate) {
  const inputs = ['Binance'];
  if (candidate.kronosBias !== 'UNAVAILABLE') inputs.push('Kronos');
  if (candidate.whale.available) inputs.push('Whale');
  if (candidate.sentiment.available) inputs.push('Social');
  return inputs;
}

import UniverseReadinessPanel from './UniverseReadinessPanel';
import { momentumReadiness, type MomentumReadinessInput } from './universeReadiness';
import { useEffect, useState, type ReactNode } from 'react';
import OpenBasketReviewChart, { type OpenBasketReviewLeg } from './OpenBasketReviewChart';
import {
  isSettledDailyRangeTrade,
  summarizeDailyRangeHeadline,
  type DailyRangeHeadlineSummary,
  type DailyRangeHeadlineTrade,
} from './dailyRangeHeadline';

export type { DailyRangeHeadlineSummary } from './dailyRangeHeadline';

const C = {
  sub: '#0f1c23',
  border: '#20313a',
  text: '#dbe7ec',
  dim: '#7d97a3',
  good: '#46d39a',
  bad: '#ff6b6b',
  accent: '#f0b54b',
  measure: '#6fb3d6',
};

// The operator dashboard is for active trades and their execution path.  Keep the research,
// allocator, and promotion telemetry available to the API/research workflow, but do not show it
// on either exchange dashboard.
const SHOW_DAILY_RANGE_RESEARCH_TELEMETRY = false;

const REFRESH_MS = 15_000;
const HISTORY_LIMIT = 100;
const CLOSED_REPORT_PAGE_SIZE = 10;
const REVIEWABLE_STATUSES = new Set(['PROTECTING', 'OPEN', 'EXIT_RECONCILING']);

type ExecutionReleaseStamp = {
  releaseId: string | null;
  label: string;
  activatedAt: string | null;
  capturedAt: string;
  source: 'RUNTIME_MANIFEST' | 'RUNTIME_UNVERIFIED' | 'LEGACY_UNVERIFIED';
};
type ExecutionReleaseLifecycle = {
  openedWith: ExecutionReleaseStamp;
  closedWith: ExecutionReleaseStamp | null;
};

type DailyRangeTrade = DailyRangeHeadlineTrade & {
  tradeId: string;
  dateUtc: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entrySubmittedAt: string;
  entryFilledAt: string | null;
  releaseProvenance?: ExecutionReleaseLifecycle | null;
  entryFillPrice: number | null;
  entryQty: number | null;
  entryNotionalUsd: number | null;
  rangeHigh: number;
  rangeLow: number;
  entryPolicy?: 'LEGACY_CONTINUATION' | 'CONTINUATION' | 'FADE' | 'MOMENTUM';
  momentum?: {dual?:{family:string;entryKind?:string;stopPct?:number;exitKind?:string;maxHoldHours?:number;targetR?:number|null}};
  momentumExit?: {peakNetPct:number|null;floorNetPct:number|null;lastNetPct:number|null;policyId:string};
  routeExitPolicy?: {
    exitPolicyId: string;
    route: 'CONTINUATION' | 'FADE';
    tpMultipleR: number;
    targetPolicyId?: string | null;
    thesisInvalidationType: 'RANGE_REENTRY' | 'ORIGINAL_BREAKOUT_REACCEPTANCE' | 'NONE';
    effectiveAt: string;
    originalBreakoutDirection: 'UP' | 'DOWN';
    originalBreakoutBoundary: number;
    referenceRangeHigh: number;
    referenceRangeLow: number;
  } | null;
  referenceTimezone?: 'UTC' | 'America/New_York';
  stopPrice: number | null;
  takeProfitPrice: number | null;
  lastMarkPrice: number | null;
  rrTarget: number;
  exitReason: string | null;
  exitPrice: number | null;
  grossPnlUsd: number | null;
  feesUsd: number | null;
  entryFeesUsd?: number | null;
  exitFeesUsd?: number | null;
  feeEvidence?: 'EXACT_FILL_COMMISSION' | 'LEGACY_COMBINED_FEE_ALLOCATION' | null;
  fundingUsd: number | null;
  realizedR: number | null;
  mfeR: number | null;
  maeR: number | null;
  mfePrice?: number | null;
  mfeEventTime?: string | null;
  maePrice?: number | null;
  maeEventTime?: string | null;
  pathSource?: 'CONTRACT_AGG_TRADE' | 'EXIT_FILL' | 'RECOVERED_1M' | 'RECONCILE_MARK' | null;
  pathQuality?: 'EXACT_STREAM' | 'RECOVERED_FINE_DATA' | 'APPROX_1M' | 'INCOMPLETE' | null;
  pathFrozenAt?: string | null;
  fadeMfe?: {
    mfePolicyId?: string;
    health?: 'HEALTHY' | 'DEGRADED';
    stage1Armed?: boolean;
    stage2Armed?: boolean;
    peakMfeProgress?: number | null;
    peakMfePrice?: number | null;
    mfeExitFloorProgress?: number | null;
    mfeExitFloorPrice?: number | null;
    degradedReason?: string | null;
  } | null;
  /** Frozen on new breakout-FADE trades; legacy 50/75 MFE rows remain separate. */
  fadeRTrail?: {
    mfePolicyId?: string;
    health?: 'HEALTHY' | 'DEGRADED';
    currentR?: number | null;
    peakMfeR?: number | null;
    trailArmed?: boolean;
    trailArmedAt?: string | null;
    armThresholdR?: number | null;
    allowedGivebackR?: number | null;
    mfeExitFloorR?: number | null;
    mfeExitFloorPrice?: number | null;
    degradedReason?: string | null;
  } | null;
  holdingDurationMs: number | null;
  lastReconcileError: string | null;
  closedChartSnapshot?: {
    version: string;
    status: 'CAPTURED' | 'PENDING' | 'UNAVAILABLE';
    requestedAt: string;
    capturedAt: string | null;
    source: 'BINANCE_USDM_COMPLETED_CANDLES';
    entryAt: string | null;
    exitAt: string | null;
    assetFile: string | null;
    mimeType: 'image/svg+xml' | null;
    fiveMinuteCandleCount: number;
    fourHourCandleCount: number;
    reason: string | null;
  } | null;
  economics?: {
    structurePolicyId?: string;
    targetPolicyId?: string;
    riskPolicyId?: string;
    frictionModelId: string;
    frictionModelSource: 'EMPIRICAL_LEDGER' | 'CONSERVATIVE_FALLBACK';
    stopRiskBps: number;
    stopPct?: number;
    rewardPct?: number;
    grossStructuralRR?: number;
    stopSource?: string;
    targetMode?: 'STRUCTURAL_SR' | 'FIXED_R';
    structuralTarget?: number;
    targetSource?: string;
    targetLevelType?: string;
    targetSourceTimeframe?: string;
    targetConfirmedAt?: string;
    effectiveLossRate?: number;
    expectedLossUsd?: number;
    expectedNetRewardUsd?: number;
    netRewardRisk?: number;
    plannedRiskUsd: number;
    costRatio: number;
    breakEvenWinRate: number;
    geometry?: DailyRangeTradeGeometry | null;
  } | null;
  geometry?: DailyRangeTradeGeometry | null;
  geometryMigration?: {
    status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'BLOCKED' | 'FROZEN';
    reason: string | null;
    action: 'KEPT' | 'FLATTEN_PENDING' | 'FLATTENED' | 'BLOCKED';
    geometry: DailyRangeTradeGeometry;
  } | null;
  actualStopRiskBps?: number | null;
  actualCostRatio?: number | null;
  actualEffectiveLossUsd?: number | null;
  postFillEconomicsStatus?: 'PASS' | 'POST_FILL_ECONOMICS_FAIL' | 'POST_FILL_RISK_FAIL' | null;
  postFillGeometryStatus?: 'PASS' | string | null;
};

type DailyRangeTradeGeometry = {
  geometryPolicyId: string;
  tpMultipleR?: number;
  maxStopPct: number;
  maxTargetPct: number;
  maxTargetAtrMultiple: number;
  stopDistancePct: number | null;
  tpDistancePct: number | null;
  atr4h: number | null;
  atr4hPct: number | null;
  atrSourceLastClosedAt: string | null;
  atrFeatureTimestamp: string | null;
  targetAtrMultiple: number | null;
  admissionAuthority?: 'LEGACY_ENFORCED' | 'DIAGNOSTIC_ONLY';
  legacyDiagnosticReason?: string | null;
  geometryPass: boolean;
  geometryRejectReason: string | null;
};

type DailyRangePerformance = {
  closedTrades?: number;
  settledTrades?: number;
  normalClosedTrades?: number;
  postFillSafetyUnwindTrades?: number;
  postFillSafetyUnwindNetPnlUsd?: number | null;
  postFillSafetyUnwindRealizedR?: number | null;
  wins?: number;
  losses?: number;
  winRate?: number | null;
  grossPnlUsd?: number | null;
  netPnlUsd?: number | null;
  totalRealizedR?: number | null;
};

type DailyRangeStatus = MomentumReadinessInput & {
  enabled: boolean;
  reason?: string;
  environment?: 'testnet' | 'mainnet';
  strategyVersion?: string;
  strategyMode?: string;
  experiment?: {
    id?: string;
    scope?: string;
    router?: string;
    nativeTarget?: string;
    trail?: string;
    continuationAuthority?: string;
    profileMode?: string;
    universe?: {expiresAt:string;groups:Record<string,Array<{symbol:string;entryKind:string;stopPct:number;exitKind:string;maxHoldHours:number;entryAuthority:string}>>};
  } | null;
  control?: { mode?: string };
  mainnetControls?: { entryBlockReason?: string | null; continuationExecutionEnabled?: boolean } | null;
  allocatorMode?: string;
  effectiveAllocatorMode?: string;
  selectorStatus?: string;
  selectorId?: string | null;
  selectorArtifact?: {
    activeSelectorId?: string | null;
    activeStatus?: string;
    fallback?: string;
    reason?: string | null;
    promotionGates?: {
      historical?: { status?: string };
      forwardFullPit?: { status?: string; matureOversubscribedBatches?: number; requiredMatureOversubscribedBatches?: number };
      testnetParity?: { status?: string };
      operatorApproval?: { status?: string };
      executionAuthority?: boolean;
    } | null;
  } | null;
  alphaSelector?: {
    executionAuthority?: boolean;
    status?: string;
    promotion?: string;
    artifactStatus?: string;
    artifactFallback?: string;
    forwardGate?: { matureFullPITOversubscribedBatches?: number; requiredMatureFullPITOversubscribedBatches?: number; status?: string };
  } | null;
  economics?: {
    policyId?: string;
    allocatorPolicyId?: string;
    riskPolicyId?: string;
    maxNotionalUsd?: number;
    maxPlannedRiskUsd?: number;
    /** Old hard threshold, retained only as a historical diagnostic. */
    legacyMaxCostRatioDiagnostic?: number;
    costRatioAuthority?: string;
    bboMaxAgeMs?: number;
    frictionModel?: {
      id?: string;
      source?: string;
      sampleCount?: number;
      exactFeeSampleCount?: number;
      legacyFeeSampleCount?: number;
      cutoffAt?: string;
      entryAdverseP50Bps?: number;
      entryAdverseP95Bps?: number;
      stopGapP50Bps?: number;
      stopGapP95Bps?: number;
      entryFeeP50Bps?: number;
      entryFeeP95Bps?: number;
      exitFeeP50Bps?: number;
      exitFeeP95Bps?: number;
      lossAdverseP50Bps?: number;
      lossAdverseP95Bps?: number;
      environment?: string;
      definitionVersion?: string;
      safeLossFormula?: string;
      sourceTradeCount?: number;
      sourceFillCount?: number;
      sourceFillCountKnownTradeCount?: number;
    } | null;
    candidateSummary?: {
      evaluated?: number;
      economicsRejected?: number;
      averageStopRiskBps?: number | null;
      averageCostRatio?: number | null;
      plannedRiskUsd?: { count?: number; minimum?: number | null; average?: number | null; maximum?: number | null };
      actualInitialRiskUsd?: { count?: number; average?: number | null; maximum?: number | null };
    } | null;
  } | null;
  geometry?: {
    policyId?: string;
    admissionAuthority?: string;
    legacyDiagnostics?: {
      maxStructuralStopPct?: number;
      maxTargetDistancePct?: number;
      maxTargetAtr4hMultiple?: number;
    };
    atrDefinition?: string;
    candidateSummary?: {
      evaluated?: number;
      passed?: number;
      rejected?: number;
      legacyDiagnosticCounts?: Record<string, number>;
    } | null;
    legacyDiagnosticCounts?: Record<string, number>;
  } | null;
  lastBatchCandidateCount?: number;
  lastBatchSelectedCount?: number;
  lastCompletedBatch?: {
    economicRejects?: number;
    minFeatureAgeMs?: number | null;
    maxFeatureAgeMs?: number | null;
    featureAgeSpreadMs?: number | null;
    candidates?: Array<{
      symbol: string;
      selected?: boolean;
      routeExecutionEnabled?: boolean;
      executionEligible?: boolean;
      skipReason?: string | null;
      geometry?: DailyRangeTradeGeometry | null;
      economics?: DailyRangeTrade['economics'];
      routeExitPolicy?: DailyRangeTrade['routeExitPolicy'];
    }>;
  } | null;
  mfeMae?: { triggerWorkingType?: string; collection?: string; fallback?: string; openPathQuality?: Record<string, number> } | null;
  dataHealth?: {
    candidateSignalsCollected?: number;
    fullPITSignals?: number;
    matureFullPITSignals?: number;
    matureFullPITOversubscribedBatches?: number;
    oversubscribedBatches?: number;
  } | null;
  openTrades?: DailyRangeTrade[];
  performance?: DailyRangePerformance;
};

type DailyRangeHistory = {
  ok: boolean;
  reason?: string;
  rows?: DailyRangeTrade[];
};

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function formatPrice(value: number | null | undefined): string {
  if (!finite(value)) return '—';
  const digits = value < 0.0001 ? 10 : value < 0.01 ? 8 : value < 1 ? 6 : value < 100 ? 4 : 2;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function formatMoney(value: number | null | undefined): string {
  if (!finite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)} USDT`;
}

function formatUnsignedMoney(value: number | null | undefined): string {
  if (!finite(value)) return '—';
  return `${value.toFixed(2)} USDT`;
}

function formatR(value: number | null | undefined): string {
  if (!finite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
}

function formatPercent(value: number | null | undefined): string {
  if (!finite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatBps(value: number | null | undefined): string {
  return finite(value) ? `${value.toFixed(1)} bps` : '—';
}

function fadeProtectionSummary(trade: DailyRangeTrade): { text: string; title: string } | null {
  if (trade.entryPolicy !== 'FADE') return null;
  const nativeTarget = trade.routeExitPolicy?.exitPolicyId === 'daily-route-exit-v5-fade-extreme-opposite-range'
    ? 'opposite 4H range boundary'
    : '2R';
  const rTrail = trade.fadeRTrail;
  if (rTrail?.mfePolicyId) {
    const peak = formatR(rTrail.peakMfeR);
    const floor = formatR(rTrail.mfeExitFloorR);
    const room = formatR(rTrail.allowedGivebackR);
    if (!rTrail.trailArmed) {
      return {
        text: rTrail.health === 'DEGRADED'
          ? 'Fade R trail · NON-AKTIF · path gap'
          : `Fade R trail · belum arm · peak ${peak}`,
        title: rTrail.health === 'DEGRADED'
          ? `R-trail monitoring disabled: ${rTrail.degradedReason ?? 'continuous contract-price path unavailable'}; native breakout-extreme SL and ${nativeTarget} TP remain active.`
          : `Native breakout-extreme SL and ${nativeTarget} TP are active. The 30% R trail starts only at +0.50R.`,
      };
    }
    return {
      text: `Fade R trail · peak ${peak} · floor ${floor} · GB ${room}`,
      title: rTrail.health === 'DEGRADED'
        ? `R-trail monitoring disabled: ${rTrail.degradedReason ?? 'continuous contract-price path unavailable'}; native breakout-extreme SL and ${nativeTarget} TP remain active.`
        : `Trailing floor = max(break-even including fee/slippage, peak R − max(30% of peak R, 0.25R)). Native breakout-extreme SL and ${nativeTarget} TP remain active.`,
    };
  }
  const mfe = trade.fadeMfe;
  if (!mfe?.mfePolicyId) {
    return {
      text: 'Fade MFE: legacy / OFF',
      title: 'Trade lama tidak diretrofit; native structural TP/SL tetap berlaku.',
    };
  }
  const stage = mfe.stage2Armed ? '75' : mfe.stage1Armed ? '50' : 'OFF';
  const peak = finite(mfe.peakMfeProgress) ? `${(mfe.peakMfeProgress * 100).toFixed(0)}%` : '—';
  const floor = finite(mfe.mfeExitFloorProgress) ? `${(mfe.mfeExitFloorProgress * 100).toFixed(0)}%` : '—';
  return {
    text: `Fade MFE ${stage} · peak ${peak} · floor ${floor} @ ${formatPrice(mfe.mfeExitFloorPrice)}`,
    title: mfe.health === 'DEGRADED'
      ? `MFE monitoring disabled: ${mfe.degradedReason ?? 'continuous contract-price path unavailable'}; native TP/SL remains active.`
      : 'Fade-only protection from the causal contract-price stream. Native structural TP/SL remains active.',
  };
}

function pathQualityLabel(value: DailyRangeTrade['pathQuality']): string {
  if (value === 'EXACT_STREAM') return 'exact contract stream';
  if (value === 'APPROX_1M') return 'approx. 1m recovery';
  if (value === 'RECOVERED_FINE_DATA') return 'fine-data recovery';
  if (value === 'INCOMPLETE') return 'path incomplete';
  return 'legacy / belum diukur';
}

function formatTaipei(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei',
  }).format(new Date(value));
}

function releaseStampLabel(stamp: ExecutionReleaseStamp | null | undefined): string {
  if (!stamp || stamp.source === 'LEGACY_UNVERIFIED') return 'LEGACY · release tidak terekam';
  if (stamp.source === 'RUNTIME_MANIFEST' && stamp.activatedAt) {
    return stamp.label + ' (' + formatTaipei(stamp.activatedAt) + ')';
  }
  return 'UNVERIFIED · manifest release tidak tersedia';
}

function formatDuration(value: number | null | undefined): string {
  if (!finite(value) || value < 0) return '—';
  const minutes = Math.max(0, Math.round(value / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Transport cooldown is shown once by the exchange-health banner, never as a trade defect. */
function reconcileErrorForDisplay(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^(?:account reconciliation unavailable|bracket transition recheck unavailable):\s*.*(?:rate limited|HTTP\s*(?:418|429)|transport cooldown)/i.test(value)
    ? null
    : value;
}

function reviewableTrade(trade: DailyRangeTrade): boolean {
  return REVIEWABLE_STATUSES.has(trade.status)
    && finite(trade.entryFillPrice)
    && trade.entryFillPrice > 0
    && finite(trade.entryQty)
    && trade.entryQty > 0;
}

function grossMarkPnl(trade: DailyRangeTrade): number | null {
  if (!finite(trade.entryFillPrice) || !finite(trade.entryQty) || !finite(trade.lastMarkPrice)) return null;
  const direction = trade.direction === 'LONG' ? 1 : -1;
  return (trade.lastMarkPrice - trade.entryFillPrice) * trade.entryQty * direction;
}

function currentR(trade: DailyRangeTrade): number | null {
  if (!finite(trade.entryFillPrice) || !finite(trade.lastMarkPrice) || !finite(trade.stopPrice)) return null;
  const risk = Math.abs(trade.entryFillPrice - trade.stopPrice);
  if (risk <= 0) return null;
  return ((trade.lastMarkPrice - trade.entryFillPrice) / risk) * (trade.direction === 'LONG' ? 1 : -1);
}

function targetGapPct(trade: DailyRangeTrade): number | null {
  if (!finite(trade.takeProfitPrice) || !finite(trade.lastMarkPrice) || trade.lastMarkPrice <= 0) return null;
  return ((trade.takeProfitPrice - trade.lastMarkPrice) / trade.lastMarkPrice) * (trade.direction === 'LONG' ? 1 : -1) * 100;
}

function geometryForTrade(trade: DailyRangeTrade): DailyRangeTradeGeometry | null {
  return trade.geometry ?? trade.economics?.geometry ?? trade.geometryMigration?.geometry ?? null;
}

function geometryPct(value: number | null | undefined): string {
  return finite(value) ? formatPercent(value * 100) : '—';
}

function geometrySummary(trade: DailyRangeTrade): string {
  const geometry = geometryForTrade(trade);
  if (!geometry) return 'legacy / belum dievaluasi';
  const status = trade.geometryMigration?.status
    ?? (geometry.geometryPass ? 'PASS' : `FAIL ${geometry.geometryRejectReason ?? ''}`.trim());
  const atr = finite(geometry.targetAtrMultiple) ? `${geometry.targetAtrMultiple.toFixed(2)}× ATR` : 'ATR —';
  const targetPolicyId = trade.economics?.targetPolicyId ?? trade.routeExitPolicy?.targetPolicyId;
  const oppositeRange = targetPolicyId === 'daily-fade-opposite-range-target-v1';
  const structural = targetPolicyId === 'daily-next-sr-target-v1' || oppositeRange;
  const rr = trade.economics?.grossStructuralRR ?? geometry.tpMultipleR ?? trade.rrTarget;
  const target = oppositeRange
    ? `TP opposite 4H range ${finite(rr) ? `${rr.toFixed(2)}R ` : ''}${geometryPct(geometry.tpDistancePct)}`
    : structural
    ? `TP next S/R ${finite(rr) ? `${rr.toFixed(2)}R ` : ''}${geometryPct(geometry.tpDistancePct)}`
    : `TP ${finite(rr) ? `${rr.toFixed(2)}R ` : ''}${geometryPct(geometry.tpDistancePct)}`;
  const diagnostic = geometry.legacyDiagnosticReason ? ` · diag ${geometry.legacyDiagnosticReason}` : '';
  return `SL ${geometryPct(geometry.stopDistancePct)} · ${target} · ${atr} · ${status}${diagnostic}`;
}

function tradeNotional(trade: DailyRangeTrade): number | null {
  if (finite(trade.entryNotionalUsd)) return Math.abs(trade.entryNotionalUsd);
  if (!finite(trade.entryFillPrice) || !finite(trade.entryQty)) return null;
  return Math.abs(trade.entryFillPrice * trade.entryQty);
}

function toneForSide(side: DailyRangeTrade['direction']): string {
  return side === 'LONG' ? C.good : C.bad;
}

function toneForValue(value: number | null | undefined): string {
  return !finite(value) ? C.dim : value >= 0 ? C.good : C.bad;
}

function DailyRangeInfoCard({
  label,
  value,
  detail,
  title,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  title?: string;
}) {
  return <article className="daily-range-info-card" title={title}>
    <span className="daily-range-info-card-label">{label}</span>
    <strong>{value}</strong>
    {detail ? <p>{detail}</p> : null}
  </article>;
}

function closeReason(reason: string | null): string {
  if (reason === 'TAKE_PROFIT') return 'TAKE PROFIT';
  if (reason === 'STOP_LOSS') return 'STOP LOSS';
  if (reason === 'FADE_MFE_STAGE1_GIVEBACK_EXIT') return 'FADE MFE 50 GIVEBACK';
  if (reason === 'FADE_MFE_STAGE2_GIVEBACK_EXIT') return 'FADE MFE 75 GIVEBACK';
  if (reason === 'FADE_R30_GIVEBACK_EXIT') return 'FADE R30 GIVEBACK';
  return reason?.replaceAll('_', ' ') ?? '—';
}

function isPostFillSafetyUnwind(trade: DailyRangeTrade): boolean {
  return trade.status.startsWith('ENTRY_ABORT_') && isSettledDailyRangeTrade(trade);
}

function entryPolicyLabel(policy: DailyRangeTrade['entryPolicy']): string {
  if (policy === 'MOMENTUM') return 'MOMENTUM';
  if (policy === 'FADE') return 'BREAKOUT FADE';
  if (policy === 'CONTINUATION') return 'CONTINUATION';
  return 'LEGACY CONTINUATION';
}

function entryPolicyDescription(policy: DailyRangeTrade['entryPolicy']): string {
  if (policy === 'MOMENTUM') return 'Momentum 4/7 hari dengan konfirmasi BTC dan profil entry per koin.';
  if (policy === 'FADE') return 'Breakout gagal: harga kembali masuk ke dalam range 4H.';
  if (policy === 'CONTINUATION') return 'Breakout bertahan: close 5m berikutnya makin jauh di luar range 4H.';
  return 'Aturan continuation sebelum router otomatis diterapkan.';
}

function entryPolicyClass(policy: DailyRangeTrade['entryPolicy']): string {
  return policy === 'FADE' ? 'is-fade' : policy === 'CONTINUATION' ? 'is-continuation' : 'is-legacy';
}

function logicExitLabel(trade: DailyRangeTrade): string {
  if(trade.momentum?.dual)return `${trade.momentum.dual.exitKind} / ${trade.momentum.dual.maxHoldHours}h`; 
  if (trade.routeExitPolicy?.exitPolicyId === 'daily-route-exit-v5-fade-extreme-opposite-range') return 'opposite 4H range + 30% R trail';
  if (trade.routeExitPolicy?.exitPolicyId === 'daily-route-exit-v4-fade-extreme-2r-r30') return 'native 2R + 30% R trail';
  if (trade.routeExitPolicy?.thesisInvalidationType === 'RANGE_REENTRY') return '5m range re-entry';
  if (trade.routeExitPolicy?.thesisInvalidationType === 'ORIGINAL_BREAKOUT_REACCEPTANCE') return '5m original breakout re-acceptance';
  return '—';
}

function stopPolicyLabel(trade: DailyRangeTrade): string {
  if(trade.momentum?.dual)return `hard SL ${trade.momentum.dual.stopPct}%`; 
  return trade.routeExitPolicy?.exitPolicyId === 'daily-route-exit-v4-fade-extreme-2r-r30'
    || trade.routeExitPolicy?.exitPolicyId === 'daily-route-exit-v5-fade-extreme-opposite-range'
    ? 'hard SL breakout extreme'
    : 'hard SL structural';
}

function routeExitPolicyLabel(trade: DailyRangeTrade): string {
  if(trade.momentum?.dual){const p=trade.momentum.dual;return `${p.exitKind} · max ${p.maxHoldHours}h · arm net 2% / giveback 50%`;}
  if(trade.entryPolicy==='MOMENTUM')return 'Historical Momentum policy';
  if (!trade.routeExitPolicy) return 'legacy global 2R';
  if (trade.routeExitPolicy.targetPolicyId === 'daily-fade-opposite-range-target-v1') {
    return `${trade.routeExitPolicy.exitPolicyId} · TP opposite 4H range`;
  }
  if (trade.routeExitPolicy.targetPolicyId === 'daily-next-sr-target-v1') {
    return `${trade.routeExitPolicy.exitPolicyId} · TP next S/R`;
  }
  return `${trade.routeExitPolicy.exitPolicyId} · TP ${trade.routeExitPolicy.tpMultipleR}R`;
}

function structuralTargetLabel(trade: DailyRangeTrade): string {
  const economics = trade.economics;
  if (economics?.targetMode === 'FIXED_R' || economics?.targetSource === 'FIXED_2R') return 'fixed 2R';
  if (economics?.targetPolicyId === 'daily-fade-opposite-range-target-v1') return 'opposite 4H range boundary';
  if (!economics?.targetPolicyId) return 'legacy target';
  const level = economics.targetLevelType?.replaceAll('_', ' ') ?? 'S/R';
  const timeframe = economics.targetSourceTimeframe ? ` ${economics.targetSourceTimeframe}` : '';
  return `${level}${timeframe}`;
}

function latestFirst(left: DailyRangeTrade, right: DailyRangeTrade): number {
  return Date.parse(right.exitTimestamp ?? '') - Date.parse(left.exitTimestamp ?? '');
}

function ClosedDailyRangeReport({
  performance,
  trades,
  error,
  environment,
  apiPrefix,
}: {
  performance: DailyRangePerformance | undefined;
  trades: DailyRangeTrade[];
  error: string | null;
  environment: DailyRangeStatus['environment'];
  apiPrefix: string;
}) {
  const settledTrades = trades.filter(isSettledDailyRangeTrade).sort(latestFirst);
  const [pageIndex, setPageIndex] = useState(0);
  const pageCount = Math.max(1, Math.ceil(settledTrades.length / CLOSED_REPORT_PAGE_SIZE));
  const visiblePageIndex = Math.min(pageIndex, pageCount - 1);
  const pageStart = visiblePageIndex * CLOSED_REPORT_PAGE_SIZE;
  const visibleTrades = settledTrades.slice(pageStart, pageStart + CLOSED_REPORT_PAGE_SIZE);
  const pageEnd = Math.min(pageStart + visibleTrades.length, settledTrades.length);
  const settledCount = performance?.settledTrades ?? performance?.closedTrades ?? settledTrades.length;
  const normalClosedCount = performance?.normalClosedTrades ?? settledTrades.filter((trade) => trade.status === 'CLOSED').length;
  const safetyUnwindCount = performance?.postFillSafetyUnwindTrades ?? settledTrades.filter(isPostFillSafetyUnwind).length;
  const netRealized = performance?.netPnlUsd ?? null;
  const totalRealizedR = performance?.totalRealizedR ?? null;
  const winRate = performance?.winRate ?? null;
  const [selectedSnapshotTradeId, setSelectedSnapshotTradeId] = useState<string | null>(null);
  const selectedSnapshotTrade = settledTrades.find((trade) => trade.tradeId === selectedSnapshotTradeId) ?? null;
  const selectedSnapshot = selectedSnapshotTrade?.closedChartSnapshot ?? null;
  const selectedSnapshotUrl = selectedSnapshotTrade && selectedSnapshot?.status === 'CAPTURED'
    ? apiPrefix + '/live/daily-range-lane/closed-chart-snapshot?tradeId=' + encodeURIComponent(selectedSnapshotTrade.tradeId)
    : null;

  return <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="daily-range-closed-report">
    <header>
      <div>
        <span>Daily Range settled-fill report</span>
        <strong style={{ color: toneForValue(netRealized) }}>
          {settledCount} settled fills · net realized {formatMoney(netRealized)} · {formatR(totalRealizedR)}
        </strong>
      </div>
      <span className="tone-measure">{environment === 'mainnet' ? 'LIVE · actual closed fills' : 'Testnet only · actual closed fills'}</span>
    </header>
    <div className="daily-range-report-note">
      Net realized = gross realized − fee yang tercatat + funding yang tercatat. Tidak ada slippage estimasi yang disisipkan ke hasil closed.
      {finite(winRate) ? <> Win rate {formatPercent(winRate * 100)} · {performance?.wins ?? 0}W / {performance?.losses ?? 0}L.</> : null}
      {' '}Termasuk {normalClosedCount} normal close{normalClosedCount === 1 ? '' : 's'}{safetyUnwindCount > 0 ? <> + {safetyUnwindCount} post-fill safety unwind{ safetyUnwindCount === 1 ? '' : 's'}</> : null}; safety unwind adalah biaya proteksi aktual, bukan exit strategi normal.
      {' '}Snapshot chart mulai direkam otomatis setelah feature ini aktif; trade lama tidak direkonstruksi lalu diklaim sebagai gambar saat close.
    </div>
    {error ? <div className="daily-range-message tone-warning">Riwayat Daily Range belum bisa dimuat: {error}</div> : null}
    {!error && settledTrades.length === 0 ? <div className="daily-range-message">Belum ada Daily Range trade dengan fill entry/exit final untuk dilaporkan.</div> : null}
    {settledTrades.length > 0 ? <>
      <div className="testnet-table-wrap">
      <table className="daily-range-table daily-range-closed-table">
        <thead><tr>
          <th>Symbol</th><th>Side</th><th>Setup</th><th>Opened (Taipei)</th><th>Entry</th><th>Exit</th><th>Hold</th><th>Reason</th><th>Gross</th><th>Fees</th><th>Funding</th><th>Net realized</th><th>R realized</th><th>MFE / MAE</th><th>Economics</th><th>Release provenance</th><th>Closed (Taipei)</th><th>Final chart</th>
        </tr></thead>
        <tbody>{visibleTrades.map((trade) => {
          const safetyUnwind = isPostFillSafetyUnwind(trade);
          return <tr key={trade.tradeId}>
          <td><strong>{trade.symbol}</strong></td>
          <td style={{ color: toneForSide(trade.direction), fontWeight: 700 }}>{trade.direction}</td>
          <td>
            <span className={`daily-range-state ${entryPolicyClass(trade.entryPolicy)}`} title={entryPolicyDescription(trade.entryPolicy)}>{entryPolicyLabel(trade.entryPolicy)}</span>
            <small>{routeExitPolicyLabel(trade)}<br />logic: {logicExitLabel(trade)}</small>
          </td>
          <td>{formatTaipei(trade.entryFilledAt ?? trade.entrySubmittedAt)}</td>
          <td>{formatPrice(trade.entryFillPrice)}</td>
          <td>{formatPrice(trade.exitPrice)}</td>
          <td>{formatDuration(trade.holdingDurationMs)}</td>
          <td><span className={`daily-range-state ${!safetyUnwind && (trade.exitReason === 'TAKE_PROFIT' || trade.exitReason?.startsWith('FADE_MFE_') || trade.exitReason === 'FADE_R30_GIVEBACK_EXIT') ? 'is-tp' : 'is-stop'}`}>{safetyUnwind ? `SAFETY UNWIND · ${closeReason(trade.exitReason)}` : closeReason(trade.exitReason)}</span></td>
          <td style={{ color: toneForValue(trade.grossPnlUsd) }}>{formatMoney(trade.grossPnlUsd)}</td>
          <td style={{ color: C.bad }} title={trade.feeEvidence === 'EXACT_FILL_COMMISSION' ? 'Komisi entry dan exit dari fill exchange.' : 'Record lama hanya menyimpan total fee; split entry/exit tidak diklaim exact.'}>
            {finite(trade.feesUsd) ? `-${trade.feesUsd.toFixed(4)} USDT` : '—'}
            {finite(trade.entryFeesUsd) || finite(trade.exitFeesUsd) ? <small>in {formatUnsignedMoney(trade.entryFeesUsd)} / out {formatUnsignedMoney(trade.exitFeesUsd)}</small> : null}
          </td>
          <td style={{ color: toneForValue(trade.fundingUsd) }}>{formatMoney(trade.fundingUsd)}</td>
          <td style={{ color: toneForValue(trade.netPnlUsd), fontWeight: 700 }}>{formatMoney(trade.netPnlUsd)}</td>
          <td style={{ color: toneForValue(trade.realizedR) }}>{formatR(trade.realizedR)}</td>
          <td title={`MFE ${formatPrice(trade.mfePrice)} · MAE ${formatPrice(trade.maePrice)} · ${pathQualityLabel(trade.pathQuality)}`}>
            <span style={{ color: toneForValue(trade.mfeR) }}>{formatR(trade.mfeR)}</span> / <span style={{ color: toneForValue(trade.maeR) }}>{formatR(trade.maeR)}</span>
            <small>{pathQualityLabel(trade.pathQuality)}</small>
          </td>
          <td>{trade.economics ? <small title={`model ${trade.economics.frictionModelId}`}>
            SL {trade.economics.stopSource?.replaceAll('_', ' ') ?? formatBps(trade.actualStopRiskBps ?? trade.economics.stopRiskBps)} · TP {structuralTargetLabel(trade)} · net RR {finite(trade.economics.netRewardRisk) ? `${trade.economics.netRewardRisk.toFixed(2)}R` : '—'}
          </small> : <span className="tone-measure">legacy</span>}</td>
          <td><small title="Versi release yang membuat entry intent dan yang menyelesaikan close. Waktu dalam tanda kurung adalah waktu cutover/deploy di Taipei, bukan waktu fill.">
            open: {releaseStampLabel(trade.releaseProvenance?.openedWith)}<br />
            close: {releaseStampLabel(trade.releaseProvenance?.closedWith)}
          </small></td>
          <td>{formatTaipei(trade.exitTimestamp)}</td>
          <td>{trade.closedChartSnapshot?.status === 'CAPTURED'
            ? <button
                type="button"
                className="daily-range-symbol-button"
                aria-pressed={selectedSnapshotTradeId === trade.tradeId}
                onClick={() => setSelectedSnapshotTradeId((current) => current === trade.tradeId ? null : trade.tradeId)}
                title="Buka gambar chart yang dibekukan saat close"
              >snapshot</button>
            : trade.closedChartSnapshot?.status === 'PENDING'
              ? <small className="tone-measure" title={trade.closedChartSnapshot.reason ?? 'Menunggu arsip candle selesai.'}>menyimpan…</small>
              : trade.closedChartSnapshot?.status === 'UNAVAILABLE'
                ? <small className="tone-warning" title={trade.closedChartSnapshot.reason ?? 'Arsip candle tidak tersedia.'}>tidak tersedia</small>
                : <small className="tone-measure">pra-snapshot</small>}</td>
        </tr>;
        })}</tbody>
      </table>
      </div>
      <div style={{ padding: '0 12px 12px' }}>
        <div className="closed-report-pagination" aria-label="Closed Daily Range report pagination">
          <span>Menampilkan {pageStart + 1}–{pageEnd} dari {settledTrades.length} settled trade terbaru</span>
          <div className="closed-report-pagination-controls">
            <button type="button" disabled={visiblePageIndex === 0} onClick={() => { setSelectedSnapshotTradeId(null); setPageIndex(visiblePageIndex - 1); }}>Previous page</button>
            <span>Page {visiblePageIndex + 1} / {pageCount}</span>
            <button type="button" disabled={visiblePageIndex + 1 >= pageCount} onClick={() => { setSelectedSnapshotTradeId(null); setPageIndex(visiblePageIndex + 1); }}>Next page</button>
          </div>
        </div>
      </div>
    </> : null}
    {selectedSnapshotTrade && selectedSnapshot && selectedSnapshotUrl ? <section
      id="daily-range-closed-chart-snapshot"
      style={{ marginTop: 14, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', background: C.sub }}
    >
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <div><strong style={{ color: C.text }}>{selectedSnapshotTrade.symbol} · final chart at close</strong><small style={{ display: 'block', color: C.dim, marginTop: 3 }}>Entry sampai fill exit · completed USD-M candle only · disimpan {formatTaipei(selectedSnapshot.capturedAt)}</small></div>
        <button type="button" className="daily-range-symbol-button" onClick={() => setSelectedSnapshotTradeId(null)}>tutup</button>
      </div>
      <img
        src={selectedSnapshotUrl}
        alt={selectedSnapshotTrade.symbol + ' Daily Range 4H immutable chart snapshot from entry to close'}
        style={{ display: 'block', width: '100%', height: 'auto', background: '#071016' }}
      />
    </section> : null}
  </section>;
}

export default function DailyRangeReportCard({
  apiPrefix,
  onHeadlineSummary,
}: {
  apiPrefix: string;
  onHeadlineSummary?: (summary: DailyRangeHeadlineSummary | null) => void;
}) {
  const [data, setData] = useState<DailyRangeStatus | null>(null);
  const [history, setHistory] = useState<DailyRangeTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [closeBusyTradeId, setCloseBusyTradeId] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => () => onHeadlineSummary?.(null), [onHeadlineSummary]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const statusRequest = fetch(`${apiPrefix}/live/daily-range-lane/status`, { cache: 'no-store' })
        .then(async (response) => ({ response, body: await response.json() as DailyRangeStatus }));
      const historyRequest = fetch(`${apiPrefix}/live/daily-range-lane/history?kind=trades&limit=${HISTORY_LIMIT}`, { cache: 'no-store' })
        .then(async (response) => ({ response, body: await response.json() as DailyRangeHistory }));
      const [statusResult, historyResult] = await Promise.allSettled([statusRequest, historyRequest]);

      if (statusResult.status !== 'fulfilled' || !statusResult.value.response.ok || statusResult.value.body.enabled !== true) {
        const reason = statusResult.status === 'fulfilled'
          ? statusResult.value.body.reason ?? `daily range request failed (${statusResult.value.response.status})`
          : statusResult.reason instanceof Error ? statusResult.reason.message : 'Daily Range data unavailable';
        if (!cancelled) setError(reason);
        return;
      }

      if (!cancelled) {
        setData(statusResult.value.body);
        setError(null);
      }

      if (historyResult.status === 'fulfilled' && historyResult.value.response.ok && historyResult.value.body.ok === true && Array.isArray(historyResult.value.body.rows)) {
        if (!cancelled) {
          setHistory(historyResult.value.body.rows);
          setHistoryError(null);
        }
      } else if (!cancelled) {
        const reason = historyResult.status === 'fulfilled'
          ? historyResult.value.body.reason ?? `history request failed (${historyResult.value.response.status})`
          : historyResult.reason instanceof Error ? historyResult.reason.message : 'Daily Range history unavailable';
        setHistoryError(reason);
      }
    };
    void load().catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Daily Range data unavailable');
    });
    const timer = window.setInterval(() => void load().catch(() => undefined), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiPrefix, reloadKey]);

  useEffect(() => {
    if (!onHeadlineSummary) return;
    const expectedSettled = data?.performance?.settledTrades ?? data?.performance?.closedTrades;
    const returnedSettled = history.filter(isSettledDailyRangeTrade).length;
    const historyComplete = expectedSettled == null || returnedSettled >= expectedSettled;
    if (data?.enabled !== true || error != null || historyError != null || !historyComplete) {
      onHeadlineSummary(null);
      return;
    }
    onHeadlineSummary(summarizeDailyRangeHeadline(history));
  }, [data?.enabled, data?.performance?.closedTrades, data?.performance?.settledTrades, error, history, historyError, onHeadlineSummary]);

  const openTrades = (data?.openTrades ?? []).filter(reviewableTrade);
  const isLive = apiPrefix.startsWith('/live');
  const tradeKeys = openTrades.map((trade) => trade.tradeId).join('|');
  const selectedTrade = openTrades.find((trade) => trade.tradeId === selectedTradeId) ?? openTrades[0] ?? null;
  useEffect(() => {
    if (selectedTradeId !== selectedTrade?.tradeId) setSelectedTradeId(selectedTrade?.tradeId ?? null);
  }, [selectedTradeId, selectedTrade?.tradeId, tradeKeys]);

  async function closeTradeNow(trade: DailyRangeTrade) {
    if (!isLive || closeBusyTradeId !== null) return;
    const accepted = window.confirm(
      `Close ${trade.symbol} Daily Range trade now?\n\nOnly this owned Daily Range trade will be market-closed. Its native stop/TP stay active until the exchange position is proven flat, then only this trade's owned sibling orders are cancelled. Other trades, baskets, and lanes are not touched.`,
    );
    if (!accepted) return;
    setCloseBusyTradeId(trade.tradeId);
    setCloseResult(null);
    try {
      const response = await fetch(`${apiPrefix}/live/daily-range-lane/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'CLOSE_DAILY_RANGE_MAINNET_TRADE', tradeId: trade.tradeId }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; reason?: string; netPnlUsd?: number | null } | null;
      if (!response.ok || body?.ok !== true) {
        setCloseResult({
          ok: false,
          message: `${trade.symbol}: close belum complete — ${body?.reason ?? `HTTP ${response.status}`}. Bracket pelindung tetap dibiarkan aktif sampai exchange flatness terbukti.`,
        });
        return;
      }
      const realized = typeof body.netPnlUsd === 'number' && Number.isFinite(body.netPnlUsd)
        ? ` Net realized ${formatMoney(body.netPnlUsd)}.`
        : '';
      setCloseResult({
        ok: true,
        message: `${trade.symbol}: manual close complete.${realized} Exchange flatness sudah dikonfirmasi dan hanya bracket milik trade ini yang dibersihkan.`,
      });
    } catch (closeError) {
      setCloseResult({
        ok: false,
        message: `${trade.symbol}: close request gagal — ${closeError instanceof Error ? closeError.message : 'network error'}. Status tetap direkonsiliasi; jangan anggap posisi sudah flat sampai dashboard mengonfirmasi.`,
      });
    } finally {
      setCloseBusyTradeId(null);
      setReloadKey((key) => key + 1);
    }
  }

  const reviewLeg: OpenBasketReviewLeg | null = selectedTrade ? {
    key: `daily-range:${selectedTrade.tradeId}`,
    basketId: selectedTrade.tradeId,
    signal: selectedTrade.momentum?.dual?.entryKind ?? (selectedTrade.entryPolicy === 'FADE'
      ? 'failed breakout: outside close → inside re-entry'
      : selectedTrade.entryPolicy === 'CONTINUATION'
        ? 'expanding outside closes: continuation'
        : 'two completed 5m closes beyond 00:00–04:00 UTC range'),
    variant: data?.strategyVersion ?? 'daily-4h-range-acceptance-2r-v1',
    symbol: selectedTrade.symbol,
    side: selectedTrade.direction,
    openedAt: selectedTrade.entryFilledAt ?? selectedTrade.entrySubmittedAt,
    // A submitted time is useful for the card, but not evidence of the fill candle.  The chart
    // will deliberately omit its marker until the exchange-confirmed fill time exists.
    entryAt: selectedTrade.entryFilledAt ?? null,
    armAt: selectedTrade.fadeRTrail?.trailArmedAt ?? null,
    armLabel: selectedTrade.fadeRTrail?.trailArmedAt
      ? `MFE ARM +${(selectedTrade.fadeRTrail.armThresholdR ?? 0.5).toFixed(2)}R`
      : null,
    entryPrice: selectedTrade.entryFillPrice!,
    markPrice: selectedTrade.lastMarkPrice,
    grossUnrealizedUsd: grossMarkPnl(selectedTrade),
    chartEndpoint: `${apiPrefix}/live/daily-range-lane/chart?tradeId=${encodeURIComponent(selectedTrade.tradeId)}`,
    reviewKind: 'daily-range',
    stopPrice: selectedTrade.stopPrice,
    takeProfitPrice: selectedTrade.takeProfitPrice,
    entryPolicy: selectedTrade.entryPolicy,
    tpMultipleR: selectedTrade.rrTarget,
    exitPolicyId: selectedTrade.routeExitPolicy?.exitPolicyId ?? null,
    thesisInvalidationType: selectedTrade.routeExitPolicy?.thesisInvalidationType ?? null,
  } : null;

  const notional = openTrades.reduce((sum, trade) => sum + (tradeNotional(trade) ?? 0), 0);
  const markPnls = openTrades.map(grossMarkPnl);
  const markPnl = markPnls.every(finite) ? markPnls.reduce((sum, pnl) => sum + (pnl ?? 0), 0) : null;
  const runtimeLabel = data?.environment === 'mainnet'
    ? data.mainnetControls?.entryBlockReason
      ? 'LIVE · OBSERVE ONLY'
      : data.mainnetControls?.continuationExecutionEnabled === false
        ? `LIVE · Fade execution / Continuation shadow · ${data.control?.mode ?? 'memuat mode…'}`
        : `LIVE · ${data.control?.mode ?? 'memuat mode…'}`
    : data?.experiment
      ? `Testnet experiment · ${data.experiment.id ?? 'fixed 2R FADE'} · ${data?.control?.mode ?? 'memuat mode…'}`
      : `Testnet only · ${data?.control?.mode ?? 'memuat mode…'}`;
  const usesAutoRouter = data?.strategyMode === 'AUTO_ROUTE_NY_V2' || data?.strategyMode === 'AUTO_ROUTE_NY_V3'
    || data?.strategyMode === 'AUTO_ROUTE_NY_V4_FIXED_2R_FADE'
    || data?.strategyVersion === 'daily-4h-range-auto-route-ny-2r-v2'
    || data?.strategyVersion === 'daily-4h-range-auto-route-ny-meme-v3'
    || data?.strategyVersion === 'daily-4h-range-auto-route-ny-failed-breakout-fixed-2r-v4';
  const fixed2RFadeExperiment = data?.experiment?.nativeTarget === 'FIXED_2R';
  const friction = data?.economics?.frictionModel ?? null;
  const candidateSummary = data?.economics?.candidateSummary ?? null;
  const geometryPolicy = data?.geometry ?? null;
  const geometryCandidateSummary = geometryPolicy?.candidateSummary ?? null;
  const legacyGeometryDiagnostics = geometryPolicy?.legacyDiagnosticCounts
    ?? geometryCandidateSummary?.legacyDiagnosticCounts
    ?? {};
  const latestGeometryCandidates = (data?.lastCompletedBatch?.candidates ?? []).filter((candidate) => candidate.geometry != null);
  const legacyMaxCostRatio = data?.economics?.legacyMaxCostRatioDiagnostic ?? null;
  const bboMaxAgeMs = data?.economics?.bboMaxAgeMs ?? null;
  const alphaGates = data?.selectorArtifact?.promotionGates ?? null;
  const safeLossFrictionBps = friction
    && finite(friction.entryFeeP95Bps)
    && finite(friction.exitFeeP95Bps)
    && finite(friction.lossAdverseP95Bps)
    ? friction.entryFeeP95Bps + friction.exitFeeP95Bps + 1.25 * friction.lossAdverseP95Bps
    : null;

  return <>
    <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="daily-range-open-report">
      <header>
        <div>
          <span>{data?.strategyMode === 'MOMENTUM_4H_V1' ? 'Momentum4H' : 'Daily Range 4H'} · open trade review</span>
          <strong style={{ color: toneForValue(markPnl) }}>
            Notional {formatUnsignedMoney(notional)} · gross mark {formatMoney(markPnl)}
          </strong>
        </div>
        <span className="tone-measure">{runtimeLabel}</span>
      </header>
      {data && <UniverseReadinessPanel value={momentumReadiness(data)} />}
      <div className="daily-range-report-note">
        {data?.experiment?.universe ? <>Momentum dan breakout fade memakai profil entry, SL, dan exit per koin pada tabel di bawah. Proteksi tambahan arm estimasi net 2% dan giveback 50%. Profil dibekukan saat entry.</> : data?.strategyMode === 'MOMENTUM_4H_V1' ? <>Momentum 4 hari dan 7 hari dikonfirmasi BTC. Stop awal 2 × ATR. Jadwal exit, TP, dan trailing mengikuti policy aktif yang ditampilkan pada setiap posisi. Detail setiap posisi mengikuti kebijakan yang dibekukan saat entry.</> : <>Range <strong>{usesAutoRouter ? '00:00–04:00 New York' : '00:00–04:00 UTC'}</strong> → breakout bertahan = Continuation; kembali masuk range = Breakout Fade. FADE memakai SL extreme breakout dan TP {fixed2RFadeExperiment ? 'native fixed 2R' : 'batas 4H lawan'}; Continuation memakai S/R terkonfirmasi saat keputusan. Logic exit memakai close 5m selesai.
        Klik simbol trade untuk membuka candle; level range selalu memakai data trade yang dibekukan saat entry.</>}
      </div>
      {data?.experiment?.universe ? <details className="daily-range-message tone-measure"><summary>Profil 4H per koin · Momentum {data.experiment.universe.groups.MOMENTUM?.length ?? 0} · Fade {data.experiment.universe.groups.FADE?.length ?? 0}</summary><p>Arm estimasi net 2% · giveback 50% · profil berlaku sampai {data.experiment.universe.expiresAt}. Izin entry tetap memerlukan kontrak Testnet, data segar, dan batas risiko.</p>{Object.entries(data.experiment.universe.groups).map(([family,profiles])=><div key={family}><strong>{family}</strong><table><thead><tr><th>Koin</th><th>Entry</th><th>SL</th><th>Exit</th><th>Batas</th><th>Status</th></tr></thead><tbody>{profiles.map(p=><tr key={p.symbol}><td>{p.symbol}</td><td>{p.entryKind}</td><td>{p.stopPct}%</td><td>{p.exitKind}</td><td>{p.maxHoldHours}h</td><td>{p.entryAuthority==='USER_APPROVED_PILOT'?'Pilot pengguna':'Lolos seleksi historis'}</td></tr>)}</tbody></table></div>)}</details> : null}
      {data?.experiment && !data.experiment.universe ? <div className="daily-range-message tone-measure">
        <strong>TESTNET EXPERIMENT · {data.experiment.id ?? '—'}</strong>{data.strategyMode === 'MOMENTUM_4H_V1' ? <> · keputusan harian, candle 4H · posisi lama tetap mengikuti kebijakan saat entry.</> : <> · router {data.experiment.router === 'EXISTING_FIRST_REENTRY_FADE' ? 'existing first-reentry failed breakout' : data.experiment.router ?? '—'} · target {data.experiment.nativeTarget ?? '—'} · trail {data.experiment.trail ?? '—'} · Continuation {data.experiment.continuationAuthority ?? '—'}. Existing trades remain on their frozen policy.</>}
      </div> : null}
      {geometryPolicy ? <div className="daily-range-message" title={geometryPolicy.atrDefinition ?? 'ATR14 dari candle 4H yang sudah selesai pada waktu keputusan.'}>
        <strong>Structural S/R V1</strong> · legacy band stop/target/ATR adalah diagnostik saja, bukan hard gate. Risk size memakai stop + friction loss-path; target tidak pernah diganti fixed-R.
        {geometryCandidateSummary ? <> · kandidat {geometryCandidateSummary.passed ?? 0} structurally valid / {geometryCandidateSummary.rejected ?? 0} invalid</> : null}
        {Object.entries(legacyGeometryDiagnostics).some(([, count]) => count > 0) ? <small>legacy diagnostic: {Object.entries(legacyGeometryDiagnostics).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count}`).join(' · ')}</small> : null}
      </div> : null}
      {latestGeometryCandidates.length > 0 ? <div className="daily-range-geometry-candidates">
        <span>Latest candidate geometry</span>
        <div className="daily-range-geometry-grid">
          {latestGeometryCandidates.map((candidate) => {
            const geometry = candidate.geometry!;
            const verdict = candidate.executionEligible === false
              ? candidate.skipReason ?? 'SHADOW / NOT EXECUTABLE'
              : geometry.geometryPass ? 'VALID' : `INVALID · ${geometry.geometryRejectReason ?? candidate.skipReason ?? '—'}`;
            const economics = candidate.economics;
            const rr = economics?.grossStructuralRR ?? geometry.tpMultipleR;
            const target = economics?.targetLevelType?.replaceAll('_', ' ') ?? 'S/R —';
            return <div key={candidate.symbol} className={geometry.geometryPass ? 'is-pass' : 'is-fail'}>
              <strong>{candidate.symbol}</strong>
              <small>{candidate.routeExitPolicy?.route ?? 'legacy'} · TP {target} {finite(rr) ? `${rr.toFixed(2)}R` : '—'} · SL {geometryPct(geometry.stopDistancePct)} · {verdict}</small>
            </div>;
          })}
        </div>
      </div> : null}
      {usesAutoRouter && SHOW_DAILY_RANGE_RESEARCH_TELEMETRY ? <>
        <div className="daily-range-ops-summary">
          <section className="daily-range-ops-section" title="V3 mengurutkan hanya kandidat yang sudah lolos stop economics. Router dan arah tidak berubah; FADE memakai breakout extreme ke batas 4H lawan, Continuation memakai target struktur.">
            <div className="daily-range-ops-heading">Routing &amp; approval</div>
            <div className="daily-range-ops-grid daily-range-ops-grid--four">
              <DailyRangeInfoCard
                label="Allocator"
                value={data?.allocatorMode ?? '—'}
                detail={<>Effective: {data?.effectiveAllocatorMode ?? '—'}<br />Alpha: {data?.alphaSelector?.status ?? data?.selectorStatus ?? '—'} · authority OFF</>}
              />
              <DailyRangeInfoCard
                label="Friction model"
                value={friction ? `${friction.source}/${friction.environment ?? '—'}` : 'Unavailable'}
                detail={friction
                  ? <>N trade {friction.sourceTradeCount ?? friction.sampleCount ?? 0} · fill {friction.sourceFillCount ?? '—'}<br />{friction.id ?? '—'}</>
                  : 'Entry baru fail-closed sampai model tersedia.'}
              />
              <DailyRangeInfoCard
                label="Artifact alpha"
                value={data?.selectorArtifact?.activeSelectorId ?? 'Belum ada'}
                detail={<>Status: {data?.selectorArtifact?.activeStatus ?? 'MISSING'}<br />Fallback: {data?.selectorArtifact?.fallback ?? 'ECONOMIC_QUALITY_BASELINE'}</>}
              />
              <DailyRangeInfoCard
                label="Promotion gate"
                value={`Historical: ${alphaGates?.historical?.status ?? '—'}`}
                detail={alphaGates
                  ? <>Forward: {alphaGates.forwardFullPit?.matureOversubscribedBatches ?? 0}/{alphaGates.forwardFullPit?.requiredMatureOversubscribedBatches ?? 20} ({alphaGates.forwardFullPit?.status ?? 'PENDING'})<br />Testnet: {alphaGates.testnetParity?.status ?? 'PENDING'} · approval: {alphaGates.operatorApproval?.status ?? 'NOT_APPROVED'} · authority: {alphaGates.executionAuthority ? 'ON' : 'OFF'}</>
                  : 'Gate belum tersedia.'}
              />
            </div>
          </section>
          <section className="daily-range-ops-section" title="Angka ini adalah observasi biaya/risk Structural S/R V1, bukan sinyal arah atau optimasi threshold.">
            <div className="daily-range-ops-heading">Risk &amp; cost guardrails</div>
            <div className="daily-range-ops-grid daily-range-ops-grid--three">
              <DailyRangeInfoCard
                label="Capital cap"
                value={`${formatUnsignedMoney(data?.economics?.maxNotionalUsd)} notional`}
                detail={<>Planned loss cap: {formatUnsignedMoney(data?.economics?.maxPlannedRiskUsd)}<br />Legacy cost diagnostic {finite(legacyMaxCostRatio) ? formatPercent(legacyMaxCostRatio * 100) : '—'} · BBO ≤ {bboMaxAgeMs == null ? '—' : `${Math.round(bboMaxAgeMs / 1000)}s`}</>}
              />
              <DailyRangeInfoCard
                label="Loss protection"
                value={finite(safeLossFrictionBps) ? `Safe loss ${formatBps(safeLossFrictionBps)}` : 'Unavailable'}
                detail={finite(safeLossFrictionBps)
                  ? 'Loss budget = structural stop + friction loss-path; tidak ada minimum stop % hard gate.'
                  : 'Entry baru fail-closed sampai friction lengkap.'}
              />
              <DailyRangeInfoCard
                label="Modeled cost"
                value={friction ? `Fee p50 ${formatBps(friction.entryFeeP50Bps)} + ${formatBps(friction.exitFeeP50Bps)}` : '—'}
                detail={friction ? `Loss-path p95: ${formatBps(friction.lossAdverseP95Bps)} · sudah termasuk adverse entry/exit/gap per-loss.` : '—'}
              />
            </div>
          </section>
          <section className="daily-range-ops-section" title="Ringkasan ini hanya menghitung kandidat V3 yang sudah memiliki snapshot ekonomi; legacy trade tetap diberi label legacy.">
            <div className="daily-range-ops-heading">Evidence &amp; data health</div>
            <div className="daily-range-ops-grid daily-range-ops-grid--four">
              <DailyRangeInfoCard
                label="Last batch"
                value={`${data?.lastBatchCandidateCount ?? 0} candidate · ${data?.lastBatchSelectedCount ?? 0} selected`}
                detail={`Economic rejects: ${data?.lastCompletedBatch?.economicRejects ?? candidateSummary?.economicsRejected ?? 0}`}
              />
              <DailyRangeInfoCard
                label="V3 economics snapshot"
                value={`${candidateSummary?.evaluated ?? 0} evaluated`}
                detail={<>Avg stop: {formatBps(candidateSummary?.averageStopRiskBps)}<br />Avg cost: {finite(candidateSummary?.averageCostRatio) ? formatPercent(candidateSummary.averageCostRatio * 100) : '—'}</>}
              />
              <DailyRangeInfoCard
                label="Forward Full PIT"
                value={`${data?.dataHealth?.fullPITSignals ?? 0} full · ${data?.dataHealth?.matureFullPITSignals ?? 0} mature`}
                detail={<>Mature batches: {data?.alphaSelector?.forwardGate?.matureFullPITOversubscribedBatches ?? data?.dataHealth?.matureFullPITOversubscribedBatches ?? 0}/{data?.alphaSelector?.forwardGate?.requiredMatureFullPITOversubscribedBatches ?? 20} ({data?.alphaSelector?.forwardGate?.status ?? 'COLLECTING'})<br />Feature age: {data?.lastCompletedBatch?.minFeatureAgeMs == null ? '—' : `${Math.round(data.lastCompletedBatch.minFeatureAgeMs)}–${Math.round(data.lastCompletedBatch.maxFeatureAgeMs ?? data.lastCompletedBatch.minFeatureAgeMs)}ms`}</>}
              />
              <DailyRangeInfoCard
                label="Native price path"
                value={data?.mfeMae?.triggerWorkingType ?? '—'}
                detail={<>Collection: {data?.mfeMae?.collection ?? '—'}<br />Open: {Object.entries(data?.mfeMae?.openPathQuality ?? {}).map(([key, count]) => `${key}: ${count}`).join(' · ') || '—'}</>}
              />
            </div>
          </section>
        </div>
      </> : null}
      {error ? <div className="daily-range-message tone-warning">Daily Range status unavailable: {error}</div> : null}
      {closeResult ? <div className={`daily-range-message ${closeResult.ok ? 'tone-good' : 'tone-warning'}`}>{closeResult.message}</div> : null}
      {!error && data && openTrades.length === 0 ? <div className="daily-range-message">Tidak ada Daily Range trade aktif yang sudah terisi untuk direview.</div> : null}
      {openTrades.length > 0 ? <>
        <div className="daily-range-breakdown">
          <span>Mirrored lane P&amp;L · full breakdown ({openTrades.length} open trade{openTrades.length === 1 ? '' : 's'})</span>
          <span>klik symbol → candle review</span>
        </div>
        <div className="testnet-table-wrap">
          <table className="daily-range-table">
            <thead><tr>
              <th>Book</th><th>Symbol</th><th>Side</th><th>Setup</th><th>Qty</th><th>Entry</th><th>Mark</th><th>TP target</th><th>TP gap</th><th>Stop</th><th>R mark / MFE path</th><th>Gross mark</th><th>Economics</th><th>Range H / L</th><th>Opened (Taipei)</th><th>Intent state</th><th>Action</th>
            </tr></thead>
            <tbody>{openTrades.map((trade) => {
              const selected = selectedTrade?.tradeId === trade.tradeId;
              const gross = grossMarkPnl(trade);
              const nowR = currentR(trade);
              const gap = targetGapPct(trade);
              const geometry = geometryForTrade(trade);
              const reconcileError = reconcileErrorForDisplay(trade.lastReconcileError);
              const fadeProtection = fadeProtectionSummary(trade);
              return <tr key={trade.tradeId} className={selected ? 'is-selected' : undefined}>
                <td>Daily range</td>
                <td><button type="button" className="daily-range-symbol-button" onClick={() => setSelectedTradeId(trade.tradeId)} aria-pressed={selected} title={`Buka candle ${trade.symbol}`}>{trade.symbol}</button></td>
                <td style={{ color: toneForSide(trade.direction), fontWeight: 700 }}>{trade.direction}</td>
                <td>
                  <span className={`daily-range-state ${entryPolicyClass(trade.entryPolicy)}`} title={entryPolicyDescription(trade.entryPolicy)}>{entryPolicyLabel(trade.entryPolicy)}</span>
                  <small>{routeExitPolicyLabel(trade)}<br />{stopPolicyLabel(trade)} · logic {logicExitLabel(trade)}</small>
                  {fadeProtection ? <small className="tone-measure" title={fadeProtection.title}>{fadeProtection.text}</small> : null}
                </td>
                <td>{finite(trade.entryQty) ? Number(trade.entryQty.toFixed(8)) : '—'}</td>
                <td>{formatPrice(trade.entryFillPrice)}</td>
                <td>{formatPrice(trade.lastMarkPrice)}</td>
                <td>{formatPrice(trade.takeProfitPrice)} <small>{finite(trade.rrTarget) ? `${trade.rrTarget.toFixed(2)}R` : '—'}<br />{structuralTargetLabel(trade)}</small></td>
                <td style={{ color: toneForValue(gap) }}>{formatPercent(gap)}</td>
                <td style={{ color: C.bad }}>{formatPrice(trade.stopPrice)}</td>
                <td title={`MFE ${formatPrice(trade.mfePrice)} · MAE ${formatPrice(trade.maePrice)} · ${pathQualityLabel(trade.pathQuality)}`}>
                  <span style={{ color: toneForValue(nowR) }}>{formatR(nowR)}</span> / <span style={{ color: toneForValue(trade.mfeR) }}>{formatR(trade.mfeR)}</span>
                  <small>{pathQualityLabel(trade.pathQuality)}</small>
                </td>
                <td style={{ color: toneForValue(gross), fontWeight: 700 }}>{formatMoney(gross)}</td>
                <td>{trade.economics ? <small title={`model ${trade.economics.frictionModelId}; break-even ${formatPercent(trade.economics.breakEvenWinRate * 100)}`}>
                  planned loss {formatUnsignedMoney(trade.actualEffectiveLossUsd ?? trade.economics.expectedLossUsd ?? trade.economics.plannedRiskUsd)} · net RR {finite(trade.economics.netRewardRisk) ? `${trade.economics.netRewardRisk.toFixed(2)}R` : '—'} · BE {formatPercent(trade.economics.breakEvenWinRate * 100)}
                  {trade.economics.stopSource || trade.economics.targetSource ? <><br />SL {trade.economics.stopSource?.replaceAll('_', ' ') ?? 'structural'} · TP {structuralTargetLabel(trade)}</> : null}
                  {trade.postFillEconomicsStatus ? <><br />fill {trade.postFillEconomicsStatus}</> : null}
                  {trade.postFillGeometryStatus ? <><br />fill geometry {trade.postFillGeometryStatus}</> : null}
                  {geometry ? <><br /><span className={geometry.geometryPass ? 'tone-good' : 'tone-warning'}>{geometrySummary(trade)}</span></> : null}
                  {trade.geometryMigration ? <><br />migration {trade.geometryMigration.action}{trade.geometryMigration.reason ? ` · ${trade.geometryMigration.reason}` : ''}</> : null}
                </small> : geometry ? <small className={geometry.geometryPass ? 'tone-good' : 'tone-warning'}>{geometrySummary(trade)}</small> : <span className="tone-measure">legacy</span>}</td>
                <td>{formatPrice(trade.rangeHigh)} / {formatPrice(trade.rangeLow)}</td>
                <td>{formatTaipei(trade.entryFilledAt ?? trade.entrySubmittedAt)}</td>
                <td><span className="daily-range-state">{trade.status}</span>{reconcileError ? <small className="tone-warning daily-range-reconcile">reconcile: {reconcileError}</small> : null}</td>
                <td><div className="daily-range-action-group">
                  {isLive ? <button
                    type="button"
                    className="daily-range-close-button"
                    disabled={closeBusyTradeId !== null}
                    onClick={() => void closeTradeNow(trade)}
                    title="Market-close trade ini saja. Native stop/TP tetap aktif sampai exchange menyatakan posisi flat."
                  >{closeBusyTradeId === trade.tradeId ? 'closing…' : 'close now'}</button> : null}
                  <span className="daily-range-action">view candles</span>
                </div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </> : null}
    </section>
    {reviewLeg ? <OpenBasketReviewChart apiPrefix={apiPrefix} leg={reviewLeg} /> : <section className="testnet-panel testnet-wide-panel" id="daily-range-review-chart">
      <header><div><span>Daily Range 4H candle review</span><strong>Menunggu trade aktif</strong></div></header>
      <div className="daily-range-message">Saat ada Daily Range trade yang terisi, klik simbolnya di tabel untuk membuka candle historis dan 5m tanpa dropdown simbol.</div>
    </section>}
    <ClosedDailyRangeReport performance={data?.performance} trades={history} error={historyError} environment={data?.environment} apiPrefix={apiPrefix} />
  </>;
}

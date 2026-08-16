import { useEffect, useRef, useState } from 'react';
import './neural-mindmap.css';
// 2026-07-23 dashboard consolidation (23 sections -> 7 composites + 2 always-on zones): shared
// table/accordion primitives also used by the Research dashboard's InnovationLanesCard.
import { Disclosure, LaneMaturityTable, laneEdgeBadge, type LaneMaturityRow } from './LaneMaturityTable';
import CrossSectionalReportCard from './CrossSectionalReportCard';

const REFRESH_MS = 5_000;
const TESTNET_API_PREFIX = '/testnet/api';
// The REAL-MONEY mainnet engine, proxied by Caddy (/live/api/* → 127.0.0.1:3103).
const LIVE_API_PREFIX = '/live/api';
// Static fallback for lanes that actually flow through the live mirror. The control also
// appends current headline/watchable lane ids from main `/` so newly promoted lanes appear
// in testnet/live without another frontend deploy.
const LIVE_LANE_OPTIONS = [
  'CG_WIDE_FAST_SHORT',
  'CG_WIDE_FAST_LONG',
  'CG_WIDE_LONG_RUNNER',
  'CG_WIDE_STOP_TP_WIDE',
  'CG_MFE_GIVEBACK',
  'CG_BE_AFTER_05',
  'CROSS_SECTIONAL_MARKET_NEUTRAL',
  // 2026-07-08: extra cross-sectional executor instances wired alongside the FILTERED foundation
  // lane — each mirrors its own measured variant (trend-following / mean-reversion) and only
  // trades when BOTH this allocation weight is >0 AND that variant's own internal regime gate
  // (TREND_LONG/SHORT for TREND, MIXED_CHOP for MIXED) agrees. See cross-sectional-executor.ts.
  'CROSS_SECTIONAL_TREND',
  'CROSS_SECTIONAL_MIXED',
  // Evidence-gated bearish SHORT: base-current/no-chase entry, >=500bps stop, RR 5-8,
  // half banked at TP1 and the remainder protected at breakeven/trail. Testnet-only for now.
  'PROFIT_CORE_SHORT_TRAIL',
  // 2026-07-08: single-symbol executors with their OWN entry signals (not the shared scanner
  // candidate every CG_* variant rides on) — SingleSymbolLaneExecutor, own enable flag
  // (SHORT_FADE_EXEC_ENABLED / INTRADAY_MOMENTUM_EXEC_ENABLED on the VPS env).
  'SHORT_FADE_EXHAUSTION_CROWDED',
  'INTRADAY_MOMENTUM_BREAKOUT_LONG',
  // 2026-07-09: axis-score + crowding-state gated LONG (regime-composite-edge.ts), same
  // SingleSymbolLaneExecutor pattern (REGIME_COMPOSITE_EXEC_ENABLED on the VPS env).
  'REGIME_COMPOSITE_CONFIRMATION_LONG',
  'REGIME_COMPOSITE_CONFIRMATION_SHORT',
  // 2026-07-09: bidirectional composite estimator (axis level+velocity+Kronos, composite-estimator-edge.ts)
  // — 4 buckets, each its own SingleSymbolLaneExecutor (COMPOSITE_ESTIMATOR_EXEC_ENABLED on the VPS env).
  'COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG',
  'COMPOSITE_ESTIMATOR_BIDI_WIDE_SHORT',
  'COMPOSITE_ESTIMATOR_BIDI_FAST_LONG',
  'COMPOSITE_ESTIMATOR_BIDI_FAST_SHORT',
  // 2026-07-11: 2 variant-matrix lanes confirmed live-flowing on all 3 instances but missing from
  // this dropdown. Given with the FULL 'CG_VARIANT_MATRIX:' prefix, not the bare suffix like the
  // other entries above — CG_NO_FIB500_ENTRYSET specifically has a same-suffix LONG sibling
  // ('CG_LONG_VARIANT_MATRIX:CG_NO_FIB500_ENTRYSET', already active on the research hub's neural-map
  // though not yet on testnet/live) that live-execution-engine.ts's suffix-matching fallback would
  // silently ALSO admit if this were given bare, once that LONG variant starts flowing here too.
  'CG_VARIANT_MATRIX:CG_NO_FIB500_ENTRYSET',
  'CG_VARIANT_MATRIX:CG_EXP_SHORT_MFE_GIVEBACK_10X',
];
const PERFORMANCE_VIEW_OPTIONS = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];
const FALLBACK_REGIME_OPTIONS = [
  { value: 'all', label: 'All regimes' },
  { value: 'short', label: 'Short all' },
  { value: 'long', label: 'Long all' },
  { value: 'mixed', label: 'Mixed / choppy' },
  { value: 'short_extended', label: 'Short extended' },
  { value: 'long_extended', label: 'Long extended' },
  { value: 'short_tactical', label: 'Short tactical' },
  { value: 'long_tactical', label: 'Long tactical' },
  { value: 'unknown', label: 'Unknown' },
];
const LANE_CHART_COLORS = ['#5ce4a6', '#6fb7c9', '#f3bf5a', '#ff707a', '#a78bfa', '#f59bd3', '#92d36e', '#ff9b6f'];

// Regime tree (operator's naming) ↔ the regime engine's states, with the strategy lane each
// regime runs. Purely DESCRIPTIVE metadata now (label/lane name/note) — the actual allocation
// weights are fetched live from GET /live/regime-presets (see RegimePresetsMap / loadRegimePresets)
// so this can never drift from the backend's REGIME_AUTOPILOT_PRESETS again.
//
// 2026-07-09: this array used to ALSO carry a hardcoded copy of each preset's lane/weightPct data
// (for the "Apply preset" button) — that copy drifted from the backend the same day
// CG_WIDE_FAST_SHORT was removed from BEAR_TREND/BEARISH_CHOPPY_DEFENSIVE (a real-money loss
// driver, see regime-autopilot.ts), and the operator caught the stale button text before anyone
// clicked Apply on it. Fetching the real preset eliminates the possibility of this recurring.
const REGIME_TREE: Array<{
  label: string;
  engineRegime: string;
  lane: string;
  laneNote: string;
}> = [
  {
    label: 'Bear Trend',
    engineRegime: 'BEAR_TREND',
    lane: 'Trend Short (Breakdown Retest Short)',
    laneNote: 'protected 3R runner (MFE_GIVEBACK) + systematic cross-sectional trend-following + market-neutral ballast',
  },
  {
    label: 'Bear Choppy',
    engineRegime: 'BEARISH_CHOPPY_DEFENSIVE',
    lane: 'Short Rally Fade',
    laneNote: 'RSI-exhaustion crowded-short fade + capitulation dip-buy (new, unproven — modest slots) + cross-sectional mean-reversion + market-neutral ballast',
  },
  {
    label: 'Neutral',
    engineRegime: 'NO_TRADE',
    lane: 'Mean Reversion (cross-sectional market-neutral)',
    laneNote: 'no directional conviction → pure market-neutral',
  },
  {
    label: 'Recovery',
    engineRegime: 'NEUTRAL_RECOVERY',
    lane: 'Pullback Long (scalp)',
    laneNote: 'proven long + breakout-momentum hunter + capitulation dip-buy (new, unproven — modest slots) + cross-sectional mean-reversion + market-neutral ballast',
  },
  {
    label: 'Bull',
    engineRegime: 'TREND_RECOVERY',
    lane: 'Trend Following (breakout retest long)',
    laneNote: 'fast-bank + full-commit 3R runner + protected 3R runner (MFE_GIVEBACK) + systematic cross-sectional trend-following — no market-neutral dilution, confirmed trend concentrates fully on direction',
  },
];

interface RegimeEngineReport {
  enabled: boolean;
  snapshotCount: number;
  latest: {
    at: string;
    btcPrice: number | null;
    regime: string;
    action: string;
    lane: string | null;
    rejectedBy: string | null;
    noTradeReason: string[] | null;
    breadth: { advancersPct: number | null; percentAboveEma20: number | null; btcReturn24h: number | null };
  } | null;
  regimeCounts: Record<string, number>;
  regimeContradictionFlaggedCounts: Record<string, number>;
  transitions: Array<{ at: string; from: string; to: string }>;
}

// 2026-07-09 fix: fetched from GET /live/regime-presets (the ACTUAL backend
// REGIME_AUTOPILOT_PRESETS), not hardcoded — see that route's doc comment for the incident this
// closes (a hardcoded frontend copy drifted from the backend after a same-day preset edit).
type RegimePresetsMap = Record<string, Array<{ laneId: string; weightPct: number }>>;

interface LiveStatus {
  enabled: boolean;
  env?: string | null;
  armed?: boolean;
  newEntries?: {
    allowed: boolean;
    drainActive: boolean;
    persistedDrain: boolean;
    pausedAt: string | null;
    pauseReason: string | null;
    strategyGate: { allowed: boolean; reason: string | null };
  };
  laneSelection?: {
    allowedLaneIds: string[] | null;
    laneAllocations: Array<{ laneId: string; weightPct: number }> | null;
    mode: string;
    manualSelectorMode?: boolean;
    manualDirectionalAllocations?: {
      long: Array<{ laneId: string; weightPct: number }>;
      short: Array<{ laneId: string; weightPct: number }>;
      activeDirection: 'LONG' | 'SHORT' | null;
      entryDecision: { action: 'NO_TRADE' | 'WAIT_PULLBACK' | 'WAIT_REJECTION'; directionalBias: 'LONG' | 'SHORT' | null; reason: string; observedAt: string } | null;
    } | null;
    laneAllocationOperatorLock?: boolean;
  };
  killedAt?: string | null;
  killReason?: string | null;
  configErrors?: string[];
  health?: {
    errorStreak: number;
    clockSkewMs: number | null;
    lastTickAt: string | null;
    lastTickError: string | null;
  };
  controller?: {
    regime: string | null;
    mode: string | null;
    bias?: string | null;
    confidence?: string | null;
    estimatedRegime?: {
      posture: 'EXTENDED_TREND' | 'TACTICAL_OR_MIXED';
      direction: 'LONG' | 'SHORT' | 'MIXED' | null;
      policy: 'WIDE_TREND' | 'TACTICAL_70_30';
      reason: string;
    } | null;
    reasons?: string[];
    capturedAt?: string | null;
  } | null;
  reconcileIssues?: string[];
  watermark?: string;
  quarantinedPaperOrders?: number;
  openIntents?: Array<{
    paperOrderId: string;
    symbol: string;
    direction: 'LONG' | 'SHORT';
    state: string;
    qty: number;
  }>;
  closedToday?: {
    dateUtc: string;
    realizedPnlUsd: number;
    wins: number;
    losses: number;
  };
  consecutiveLosses?: number;
  totalRealizedPnlUsd?: number;
  /** Realized total with operator-voided closes removed — for DISPLAY only. The raw
   *  totalRealizedPnlUsd above stays exchange-true and is what the kill-switches read. */
  totalRealizedPnlUsdExcludingVoids?: number;
  reportingExcluded?: { count: number; realizedPnlUsd: number; feesUsd: number };
  reportingExcludedToday?: { count: number; realizedPnlUsd: number; feesUsd: number };
  unifiedOrchestrator?: {
    enabled: boolean;
    mode: 'UNIFIED_TESTNET' | 'DISABLED';
    brainState: 'LONG' | 'LONG_WARNING' | 'FLAT' | 'SHORT_WARNING' | 'SHORT' | 'CHOPPY_LOCK';
    activeDirection: 'LONG' | 'SHORT' | null;
    candidateDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
    candidateStreak: number;
    updatedAt: string | null;
    neutralProposalAllowed: boolean;
    neutralProposalReason: string | null;
    legacyExecutorEntryMode: 'MANAGE_ONLY' | 'UNCHANGED';
    allowedDirectionalLaneIds: string[];
    lastTrace: {
      reason: string;
      previousState: string;
      nextState: string;
      votes: Array<{ source: string; direction: string; confidence: number; reason: string; veto?: boolean }>;
    } | null;
    featureRegistry: Array<{ id: string; role: string; consumers: string[]; purpose: string }>;
  } | null;
  unifiedProposalSource?: {
    active: boolean;
    scanBatchId: string | null;
    direction: 'LONG' | 'SHORT' | null;
    posture: 'EXTENDED_TREND' | 'TACTICAL_OR_MIXED';
    selectedRecipe: string | null;
    proposalCount: number;
    symbols: string[];
    reason: string;
  } | null;
  reason?: string;
}

interface LiveAccount {
  ok?: boolean;
  reason?: string;
  walletBalance: number | null;
  availableBalance: number | null;
  unrealizedPnl: number;
  accountEquity: number | null;
  openPositionCount: number;
  openOrderCount: number;
  positions: Array<{
    symbol: string;
    direction: 'LONG' | 'SHORT';
    quantity: number;
    entryPrice: number;
    markPrice: number | null;
    targetTpPrice: number | null;
    targetTpGapPct: number | null;
    liquidationPrice: number | null;
    unrealizedPnl: number;
    estimatedCloseCostUsd?: number;
    unrealizedAfterEstimatedCloseCostUsd?: number;
    leverage: number;
    sourceOrderCount: number;
    laneIds: string[];
    intentDirection?: 'LONG' | 'SHORT' | null;
    intentQty?: number | null;
    intentEntryPrice?: number | null;
    intentUnrealizedPnl?: number | null;
    basketQty?: number | null;
    basketUnrealizedPnl?: number | null;
    singleSymbolStopPrice?: number | null;
  }>;
  lanes: Array<{
    laneId: string;
    sourceOrderCount: number;
    symbols: string[];
    notionalUsd: number;
    unrealizedPnl: number;
  }>;
  closedLanes?: Array<{
    laneId: string;
    closedCount: number;
    wins: number;
    losses: number;
    realizedPnlUsd: number;
    feesUsd: number;
    symbols: string[];
    lastClosedAt: string | null;
  }>;
  singleSymbolExecutorRealizedPnlUsd?: { today: number; allTime: number };
}

/** CORTEX #219 shadow decision-alpha — a report-only counterfactual (CORTEX has never actually resized a
 *  real order on testnet: liveBeta stays 0 unless the separate, capped promotion gate succeeds, which it
 *  has not). `today` is the same metric scoped to outcomes resolved within the current UTC day, so it can
 *  sit next to the real "Realized P&L (today)" figure for an honest, non-fabricated comparison — always in
 *  R-multiples, never converted to a dollar figure (no reliable per-outcome $-risk is available here). */
interface CortexDecisionAlphaReport {
  today: {
    examplesConsidered: number;
    decisionAlpha: { n: number; cumulativeTiltDeltaR: number; meanTiltDeltaR: number | null };
  };
}

/** CORTEX real-USDT attribution (2026-07-21) — unlike the counterfactual decision-alpha above,
 *  this IS a realized-dollar figure: per closed trade, realizedPnlUsd × tiltShare where tiltShare
 *  was captured at OPEN time from (applied − rawStatic)/applied lane weights. $0 is expected until
 *  trades opened under an active tilt actually close. See /api/live/cortex-real-attribution. */
interface CortexRealAttributionReport {
  today: { dateUtc: string; n: number; cortexUsd: number };
  allTime: { n: number; cortexUsd: number };
}

interface LanePerformancePoint {
  bucketStart: string;
  realizedPnlUsd: number;
  cumulativePnlUsd: number;
  closedCount: number;
  wins: number;
  losses: number;
}

interface LanePerformanceSeries {
  ok?: boolean;
  view: string;
  period: string;
  viewLabel: string;
  periodLabel: string;
  bucketLabel: string;
  bucketMs: number | null;
  since: string;
  until: string;
  anchor: string | null;
  regimeFilter: string;
  /** Closed cross-basket audit P&L before the selected chart period; never blended into its curve. */
  crossSectionalAuditBeforePeriod?: { closedBaskets: number; totalNetPnlUsd: number; lastClosedAt: string | null } | null;
  regimeOptions: Array<{ value: string; label: string }>;
  cohort?: { id: string; label: string; rolloutStartAt: string | null } | null;
  bucketStarts: string[];
  lanes: Array<{
    laneId: string;
    realizedPnlUsd: number;
    feesUsd: number;
    closedCount: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    symbols: string[];
    regimes: Array<{
      family: string;
      bucket: string;
      count: number;
    }>;
    points: LanePerformancePoint[];
  }>;
}

interface MainNeuralLane {
  id?: string;
  laneId?: string;
  label?: string;
  status?: string;
  health?: string;
  rotationShortlist?: {
    bearish?: Array<{ verdict?: string | null }>;
    bullish?: Array<{ verdict?: string | null }>;
  };
}

interface MainNeuralMap {
  lanes?: MainNeuralLane[];
}

function signed(value: number | null | undefined, suffix = 'USDT'): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} ${suffix}`;
}

function plain(value: number | null | undefined, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}${suffix}`;
}

function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return 'n/a';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function tone(value: number | null | undefined): string {
  if (value == null || value === 0) return 'tone-measure';
  return value > 0 ? 'tone-healthy' : 'tone-critical';
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ageSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  return `${Math.floor(ageMin / 60)}h ago`;
}

function compactLane(laneId: string): string {
  return laneId.replace(/^CG_VARIANT_MATRIX:/, '').replace(/^CG_LONG_VARIANT_MATRIX:/, '');
}

function allocationLaneValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = compactLane(raw.trim());
  if (!compact) return null;
  if (compact === 'MIXED_DIAG_REGIME') return null;
  return compact;
}

function isHeadlineAllocationLane(lane: MainNeuralLane): boolean {
  const id = allocationLaneValue(lane.id ?? lane.laneId ?? lane.label);
  if (!id) return false;
  if (id === 'H6_TREND_LONG') return false;
  if (id.includes('CG_MAKER')) return false;
  const shortlistAllows =
    lane.rotationShortlist?.bearish?.some((item) => String(item.verdict ?? '').toUpperCase() === 'ALLOW') ||
    lane.rotationShortlist?.bullish?.some((item) => String(item.verdict ?? '').toUpperCase() === 'ALLOW');
  if (shortlistAllows) return true;
  const status = (lane.status ?? '').toUpperCase();
  const health = (lane.health ?? '').toUpperCase();
  if (status.includes('QUARANTIN') || health.includes('QUARANTIN')) return false;
  if (status.includes('REJECT')) return false;
  return (
    status.includes('HEADLINE') ||
    status.includes('WATCHABLE') ||
    status.includes('STABLE_CANDIDATE') ||
    status.includes('PROMOTION_CANDIDATE')
  );
}

function extractHeadlineAllocationLanes(payload: MainNeuralMap): string[] {
  const dynamic = (payload.lanes ?? [])
    .filter(isHeadlineAllocationLane)
    .map((lane) => allocationLaneValue(lane.id ?? lane.laneId ?? lane.label))
    .filter((lane): lane is string => Boolean(lane));
  return Array.from(new Set(dynamic)).sort();
}

function formatWinRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(1)}%`;
}

function xsecEntryAttemptStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    ENTRY_ADMISSION: 'admission',
    FOUR_BRAIN_BRIDGE: 'Four-Brain bridge',
    LOSS_REENTRY_GUARD: 'guard re-entry rugi',
    OVERLAP_GUARD: 'guard overlap',
    SMART_ENTRY_REVALIDATION: 'cek harga Smart Basket',
    EXCHANGE_FILTERS: 'filter Binance',
    SIZING: 'sizing leg',
    NOTIONAL_CAP: 'batas notional bersama',
    EXPOSURE_RESERVATION: 'reservasi eksposur',
    BASKET_RESERVED: 'basket sudah direservasi',
  };
  return labels[stage] ?? stage;
}

function formatBucketLabel(iso: string, view: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (view === 'hourly') {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (view === 'daily' || view === 'weekly') {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  if (view === 'monthly') {
    return date.toLocaleDateString([], { month: 'short' });
  }
  return date.toLocaleDateString([], { year: 'numeric' });
}

// Terser than formatBucketLabel: hourly/daily views plot up to 24-31 ticks, so the axis
// needs bare numbers (hour-of-day, day-of-month) rather than formatBucketLabel's full
// "Jul 1" / "12:00 AM" strings, which would overlap at that density.
function formatAxisTick(iso: string, view: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (view === 'hourly') return `${date.getHours()}`.padStart(2, '0');
  if (view === 'daily') return `${date.getDate()}`;
  return formatBucketLabel(iso, view);
}

function pointCoord(
  point: LanePerformancePoint,
  index: number,
  count: number,
  minY: number,
  maxY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const span = Math.max(maxY - minY, 1);
  const x = count === 1 ? width / 2 : (index / (count - 1)) * width;
  const y = height - ((point.cumulativePnlUsd - minY) / span) * height;
  return { x, y };
}

function pointPath(points: LanePerformancePoint[], minY: number, maxY: number, width: number, height: number): string {
  if (points.length < 2) return '';
  return points.map((point, index) => {
    const { x, y } = pointCoord(point, index, points.length, minY, maxY, width, height);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

function localDateInput(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localMonthInput(date = new Date()): string {
  return localDateInput(date).slice(0, 7);
}

type XsecExecStatus = {
  enabled: boolean;
  tpNetReturnPct?: number;
  dailyRealizedUsd?: number;
  dailyMaxLossUsd?: number;
  openHalted?: string | null;
  lastError?: string | null;
  entryAttemptAudit?: {
    latest?: {
      at: string;
      sourceObservationId: string;
      longSymbols: string[];
      shortSymbols: string[];
      stage: string;
      outcome: 'ADMITTED' | 'DEFERRED' | 'SKIPPED';
      reason: string | null;
    } | null;
    unattributedConsumedSignal?: {
      sourceObservationId: string;
      openedAt: string;
      reason: string;
    } | null;
  };
  formationEvaluation?: {
    activationClosedBaskets: number;
    closedBaskets: number;
    status: 'COLLECTING' | 'EVALUATING';
    autoSwitch: false;
    metrics: Array<{ model: string; samples: number; meanNetReturnPct: number | null; winRatePct: number | null; worstNetReturnPct: number | null }>;
  };
  openBaskets?: Array<{
    basketId: string;
    openedAt: string;
    closesAtMs: number;
    lastNetReturn?: number | null;
    lastNetAt?: string | null;
    legs: Array<{ symbol: string; side: string; exitOrderId: string | null }>;
  }>;
};

type SingleSymbolLanePosition = {
  laneId: string;
  positionId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number | null;
  targetTpGapPct: number | null;
  targetMode: 'FIXED' | 'MFE_PROFIT_LOCK' | 'DYNAMIC';
  mfeProfitLockPrice: number | null;
  mfeProfitLockGapPct: number | null;
  mfeProfitLockNetReturn: number | null;
  staticTpMaxNetReturn: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  leverage: number | null;
  estimatedCloseCostUsd: number | null;
  unrealizedAfterEstimatedCloseCostUsd: number | null;
  peakFavorableR: number;
  openedAt: string;
};

type LaneEvaluationRow = {
  laneId: string;
  allocationWeightPct: number;
  allowed: boolean | null;
  realOpenCount: number;
  realClosedCount: number;
  realNetPnlUsd: number;
  measuredResolvedCount: number | null;
  measuredOpenCount: number | null;
  measuredNetAvgR: number | null;
  measuredWr: number | null;
  measuredPf: number | null;
  measuredEdgeReady: boolean | null;
};

// The 3 brand-new report-only shadow engines from the 2026-07-10 GPT-5.6 strategy audit (Tier 3):
// residual cross-sectional momentum + leader-laggard, liquidation-recoil cross-sectional ranking,
// compression-to-expansion ignition. None are wired to any executor or lane allocation — this panel
// exists purely so the operator can watch sample size accrue toward edgeReady without hunting down
// 3 separate API routes.
type RndLaneReport = {
  label: string;
  laneId: string;
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  edgeReady: boolean;
} | null;

type RegimeAxisTimelineData = {
  enabled: boolean;
  points: Array<{ at: string; score: number; regime: string }>;
  smoothedPoints?: Array<{ at: string; score: number }>;
  current: { at: string; score: number; regime: string } | null;
  slopePerHour: number | null;
  etaToNeutralHours: number | null;
  slopeWindowHours: number;
  zones?: Array<{ from: number; to: number; label: string; laneHint: string }>;
  perRegimeMedianScore?: Record<string, number>;
  projection?: Array<{ at: string; score: number }>;
  forecast?: {
    available: boolean;
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNCERTAIN';
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    smoothedScore: number | null;
    consensusSlopePerHour: number | null;
    slopeAgreement: number | null;
    persistenceProbability: number | null;
    horizons: Array<{
      hours: 1 | 3 | 6;
      at: string;
      expectedScore: number;
      lowerScore: number;
      upperScore: number;
      bullProbability: number;
      neutralProbability: number;
      bearProbability: number;
      analogCount: number;
    }>;
    invalidation: string;
    reason: string;
  };
  guidance?: {
    zoneLabel: string;
    direction: 'MENUJU_NETRAL' | 'MENJAUH_NETRAL' | 'FLAT';
    holdLane: string;
    switchToLane: string | null;
    switchAtScore: number | null;
    etaToSwitchHours: number | null;
    note: string;
  } | null;
  entryDecision?: {
    action: 'NO_TRADE' | 'WAIT_PULLBACK' | 'WAIT_REJECTION';
    directionalBias: 'LONG' | 'SHORT' | null;
    reason: string;
    requiredSetup: string;
    invalidation: string;
  };
  note: string;
};

type SingleSymbolPriceTimelineData = {
  enabled: boolean;
  generatedAt?: string;
  enabledForExecution?: boolean;
  note?: string;
  symbols?: Array<{
    symbol: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT'; available: boolean; reason: string | null; updatedAt: string | null;
    price: number | null; points: Array<{ at: string; price: number }>; score: number | null; confidence: number | null;
    directive: 'ENTER_LONG' | 'ENTER_SHORT' | 'WAIT'; turningPoint: string; entryReason: string;
    exitLongReason: string | null; exitShortReason: string | null;
    forecasts: Array<{ hours: 1 | 3 | 6; targetPrice: number; lowerPrice: number; upperPrice: number; expectedMovePct: number }>;
    indicators: { m5: { rsi14: number; atrPercent: number; ema20: number; ema50: number; vwap: number; volumeRatio: number | null; support: number; resistance: number; trend: string } | null;
      h1: { rsi14: number; atrPercent: number; ema20: number; ema50: number; ema200: number; vwap: number; volumeRatio: number | null; support: number; resistance: number; trend: string } | null };
  }>;
};

/** Regime-state forecast, not a price target. Raw breadth stays visible, while a causal EWMA and
 * historical-successor intervals make the useful signal legible without pretending certainty.
 * `mode` (2026-07-23 dashboard consolidation) lets the SAME computed data drive two different
 * always-vs-collapsed placements without duplicating any of the math above: 'entry' renders only
 * the canonical ENTRY DECISION callout (kept zero-click in the Regime & Direction composite),
 * 'chart' renders the SVG + forecast-horizon detail + bias-lane guidance (parked behind that
 * composite's Disclosure), 'full' (default, unchanged) renders everything exactly as before. */
function RegimeAxisChart({ data, mode = 'full' }: { data: RegimeAxisTimelineData | null; mode?: 'full' | 'entry' | 'chart' }) {
  if (!data || data.points.length < 2 || !data.current) {
    // 2026-07-23 fix: this guard used to return the same chart-oriented copy regardless of
    // `mode`, so the always-visible mode="entry" slot (Regime & Direction's zero-click summary)
    // showed "Grafik muncul..." (chart-specific wording) even though no chart is ever meant to
    // render there. Give the entry slot its own honest, non-chart-referencing empty state.
    if (mode === 'entry') {
      return (
        <div className="testnet-chart-wrap testnet-chart-wrap-entry">
          <div className="testnet-regime-entry-decision">
            <span>ENTRY DECISION SEKARANG</span>
            <strong>NO TRADE</strong>
            <em>NO DIRECTIONAL BIAS</em>
            <p>Belum ada keputusan entry yang dapat dipakai — menunggu regime engine mengumpulkan snapshot pertama.</p>
          </div>
        </div>
      );
    }
    return (
      <div className="testnet-chart-empty">
        <strong>No regime history yet</strong>
        <p>Grafik muncul setelah regime engine mengumpulkan beberapa snapshot (REGIME_ENGINE_ENABLED=1).</p>
      </div>
    );
  }

  const width = 960;
  const height = 260;
  const paddingX = 46;
  const paddingY = 30;
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingY * 2;
  const currentMs = new Date(data.current.at).getTime();
  const recentStartMs = currentMs - 24 * 3_600_000;
  const recent = data.points.filter((point) => new Date(point.at).getTime() >= recentStartMs);
  const pts = recent.length >= 2 ? recent : data.points.slice(-60);
  const smoothedByAt = new Map((data.smoothedPoints ?? []).map((point) => [point.at, point.score]));
  const smoothPts = pts.map((point) => ({ at: point.at, score: smoothedByAt.get(point.at) ?? point.score }));
  const forecast = data.forecast;
  const horizons = forecast?.available ? forecast.horizons : [];
  const forecastCenter = horizons.length > 0
    ? horizons.map((h) => ({ at: h.at, score: h.expectedScore }))
    : data.projection ?? [];
  const currentSmooth = forecast?.smoothedScore ?? smoothPts[smoothPts.length - 1]!.score;
  const t0 = new Date(pts[0]!.at).getTime();
  const t1 = horizons.length > 0 ? new Date(horizons[horizons.length - 1]!.at).getTime() : currentMs;
  const span = Math.max(1, t1 - t0);
  const xy = (p: { at: string; score: number }) => ({
    x: paddingX + ((new Date(p.at).getTime() - t0) / span) * plotWidth,
    y: paddingY + ((1 - p.score) / 2) * plotHeight,
  });
  const linePath = (rows: Array<{ at: string; score: number }>) => rows.map((p, i) => {
    const { x, y } = xy(p);
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
  const rawPath = linePath(pts);
  const smoothPath = linePath(smoothPts);
  const forecastPath = forecastCenter.length > 0
    ? linePath([{ at: data.current.at, score: currentSmooth }, ...forecastCenter])
    : '';
  const bandPath = horizons.length > 0
    ? linePath([
        { at: data.current.at, score: currentSmooth },
        ...horizons.map((h) => ({ at: h.at, score: h.lowerScore })),
        ...[...horizons].reverse().map((h) => ({ at: h.at, score: h.upperScore })),
      ]) + ' Z'
    : '';
  const zeroY = paddingY + plotHeight / 2;
  const cur = xy({ at: data.current.at, score: currentSmooth });
  const curColor = currentSmooth > 0.12 ? '#5ce4a6' : currentSmooth < -0.12 ? '#ff6b6b' : '#f0b54b';
  const forecastColor = forecast?.bias === 'BEARISH' ? '#ff6b6b' : forecast?.bias === 'NEUTRAL' ? '#f0b54b' : forecast?.bias === 'UNCERTAIN' ? '#9db1ba' : '#5ce4a6';
  const entryDecision = data.entryDecision;
  const entryColor = entryDecision?.directionalBias === 'SHORT' ? '#ff6b6b' : entryDecision?.directionalBias === 'LONG' ? '#5ce4a6' : '#f0b54b';
  const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
  const pct = (value: number | null | undefined) => value == null ? 'n/a' : `${Math.round(value * 100)}%`;

  const chartBlock = (
    <>
      <svg className="testnet-lane-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Probabilistic regime-axis forecast">
        <rect x="0" y="0" width={width} height={height} rx="12" className="testnet-chart-bg" />
        {(data.zones ?? []).map((z) => {
          const yTop = paddingY + ((1 - z.to) / 2) * plotHeight;
          const yBot = paddingY + ((1 - z.from) / 2) * plotHeight;
          const bull = (z.from + z.to) / 2 > 0.05;
          const bear = (z.from + z.to) / 2 < -0.05;
          const fill = bull ? 'rgba(92,228,166,0.06)' : bear ? 'rgba(255,107,107,0.06)' : 'rgba(240,181,75,0.05)';
          return <rect key={z.label} x={paddingX} y={yTop} width={plotWidth} height={Math.max(1, yBot - yTop)} fill={fill} />;
        })}
        {[0.25, 0.75].map((ratio) => (
          <line key={ratio} x1={paddingX} x2={width - paddingX} y1={paddingY + ratio * plotHeight} y2={paddingY + ratio * plotHeight} className="testnet-chart-grid" />
        ))}
        <line x1={paddingX} x2={width - paddingX} y1={zeroY} y2={zeroY} className="testnet-chart-zero" />
        <line x1={cur.x} x2={cur.x} y1={paddingY} y2={height - paddingY} className="testnet-chart-now" />
        <text x={paddingX} y={paddingY - 8} className="testnet-chart-axis">BULL +1</text>
        <text x={paddingX} y={zeroY - 6} className="testnet-chart-axis">NEUTRAL 0</text>
        <text x={paddingX} y={height - paddingY + 16} className="testnet-chart-axis">BEAR −1</text>
        <path d={rawPath} fill="none" stroke="#6fb3d6" strokeWidth="1.2" opacity="0.35" strokeLinejoin="round" strokeLinecap="round" />
        <path d={smoothPath} fill="none" stroke="#8bd3f0" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        {bandPath && <path d={bandPath} fill={forecastColor} opacity="0.1" stroke="none" />}
        {forecastPath && <path d={forecastPath} fill="none" stroke={forecastColor} strokeWidth="2" strokeDasharray="6 5" opacity="0.9" />}
        {horizons.map((h) => {
          const point = xy({ at: h.at, score: h.expectedScore });
          return (
            <g key={h.hours}>
              <line x1={point.x} x2={point.x} y1={xy({ at: h.at, score: h.lowerScore }).y} y2={xy({ at: h.at, score: h.upperScore }).y} stroke={forecastColor} strokeWidth="2" opacity="0.55" />
              <circle cx={point.x} cy={point.y} r="4" fill={forecastColor} />
              <text x={point.x} y={Math.max(paddingY + 12, point.y - 10)} textAnchor="middle" className="testnet-chart-forecast-label">
                +{h.hours}h {signed(h.expectedScore)}
              </text>
            </g>
          );
        })}
        {data.guidance?.switchAtScore != null && data.guidance.etaToSwitchHours != null && data.current && (() => {
          const swX = paddingX + (((currentMs + data.guidance.etaToSwitchHours * 3_600_000) - t0) / span) * plotWidth;
          const swY = paddingY + ((1 - data.guidance.switchAtScore) / 2) * plotHeight;
          if (swX > width - paddingX) return null;
          return (
            <g>
              <circle cx={swX} cy={swY} r="6" fill="none" stroke="#f0b54b" strokeWidth="2" strokeDasharray="2 2" />
              <text x={Math.min(swX + 8, width - 145)} y={swY - 8} className="testnet-chart-switch-label">
                switch conditional
              </text>
            </g>
          );
        })()}
        <circle cx={cur.x} cy={cur.y} r="5" fill={curColor} stroke="#071016" strokeWidth="1.5" />
        <text x={paddingX} y={height - 5} className="testnet-chart-time">{timeLabel(pts[0]!.at)} · −24h</text>
        <text x={cur.x} y={height - 5} className="testnet-chart-time middle">NOW</text>
        {horizons.length > 0 && <text x={width - paddingX} y={height - 5} className="testnet-chart-time end">+6h</text>}
      </svg>
      <div className="testnet-regime-forecast">
        <div className="testnet-regime-forecast-head">
          <span>REGIME FORECAST</span>
          <strong style={{ color: forecastColor }}>{forecast?.bias ?? 'UNAVAILABLE'}</strong>
          <em>{forecast?.confidence ?? 'LOW'} confidence</em>
        </div>
        <div className="testnet-regime-now">
          <span>EWMA sekarang</span>
          <strong style={{ color: curColor }}>{signed(currentSmooth)}</strong>
          <small>{data.current.regime}</small>
        </div>
        {horizons.map((h) => (
          <div className="testnet-regime-horizon" key={h.hours}>
            <b>+{h.hours}H</b>
            <strong>{signed(h.expectedScore)}</strong>
            <span>range {signed(h.lowerScore)} … {signed(h.upperScore)}</span>
            <small>B {pct(h.bullProbability)} · N {pct(h.neutralProbability)} · S {pct(h.bearProbability)} · {h.analogCount} analog</small>
          </div>
        ))}
        <div className="testnet-regime-reliability">
          <span>Persist 3h</span>
          <strong>{pct(forecast?.persistenceProbability)}</strong>
          <small>{forecast?.reason ?? 'Belum cukup history untuk forecast.'}</small>
        </div>
        <div className="testnet-regime-invalidation">{forecast?.invalidation ?? 'Tunggu snapshot tambahan.'}</div>
      </div>
    </>
  );
  const entryBlock = (
    <div className="testnet-regime-entry-decision">
      <span>ENTRY DECISION SEKARANG</span>
      <strong style={{ color: entryColor }}>{entryDecision?.action?.replaceAll('_', ' ') ?? 'NO TRADE'}</strong>
      <em>{entryDecision?.directionalBias ? `${entryDecision.directionalBias} BIAS` : 'NO DIRECTIONAL BIAS'}</em>
      <p>{entryDecision?.reason ?? 'Belum ada keputusan entry yang dapat dipakai.'}</p>
      <small><b>Wajib:</b> {entryDecision?.requiredSetup ?? 'Tunggu setup simbol.'}</small>
      <small><b>Invalid:</b> {entryDecision?.invalidation ?? forecast?.invalidation ?? 'n/a'}</small>
    </div>
  );
  const guidanceBlock = data.guidance && (
    <div className="testnet-regime-guidance">
      <strong style={{ color: '#f0b54b' }}>
        BIAS LANE {data.guidance.holdLane.replace('CG_WIDE_', '').replace('CROSS_SECTIONAL_MARKET_NEUTRAL', 'CROSS-SECTIONAL')}
      </strong>
      {data.guidance.switchToLane && data.guidance.switchAtScore != null && (
        <>
          {' '}· switch ke <strong>{data.guidance.switchToLane.replace('CG_WIDE_', '')}</strong> HANYA setelah skor menembus{' '}
          <strong>{data.guidance.switchAtScore > 0 ? '+' : ''}{data.guidance.switchAtScore}</strong>
          {data.guidance.etaToSwitchHours != null ? ` (~${data.guidance.etaToSwitchHours} jam jika momentum konsisten)` : ' (belum ada ETA yang stabil)'}
        </>
      )}
      <div>{data.guidance.note}</div>
    </div>
  );

  if (mode === 'entry') {
    return <div className="testnet-chart-wrap testnet-chart-wrap-entry">{entryBlock}</div>;
  }
  if (mode === 'chart') {
    return (
      <div className="testnet-chart-wrap">
        {chartBlock}
        {guidanceBlock}
      </div>
    );
  }
  return (
    <div className="testnet-chart-wrap">
      {chartBlock}
      {entryBlock}
      {guidanceBlock}
    </div>
  );
}

/** Price-scale-safe counterpart of RegimeAxisChart: one compact pane per symbol rather than
 * overlaying BTC/ETH/SOL nominal prices on a misleading shared y-axis. */
function SingleSymbolPriceTimelineChart({ data, positions }: { data: SingleSymbolPriceTimelineData | null; positions?: LiveAccount['positions'] }) {
  const rows = data?.symbols ?? [];
  if (!data || rows.length === 0) {
    return <div className="testnet-chart-empty"><strong>Loading BTC / ETH / SOL timeline…</strong><p>Need fresh 5m and 1h Binance candles.</p></div>;
  }
  const toneFor = (directive: string) => directive === 'ENTER_LONG' ? '#5ce4a6' : directive === 'ENTER_SHORT' ? '#ff6b6b' : '#f0b54b';
  const signedPct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
  return (
    <div className="testnet-price-timeline-list">
      {rows.map((row) => {
        if (!row.available || row.points.length < 2 || row.price == null) {
          return <div className="testnet-chart-empty" key={row.symbol}><strong>{row.symbol}: timeline unavailable</strong><p>{row.reason ?? 'Waiting for candle data.'}</p></div>;
        }
        const width = 960; const height = 160; const px = 46; const py = 22;
        const forecast = row.forecasts ?? [];
        const values = [...row.points.map((p) => p.price), ...forecast.flatMap((p) => [p.lowerPrice, p.upperPrice])];
        const rawMin = Math.min(...values); const rawMax = Math.max(...values); const pad = Math.max((rawMax - rawMin) * 0.12, row.price * 0.002);
        const min = rawMin - pad; const max = rawMax + pad; const currentAt = new Date(row.points.at(-1)!.at).getTime();
        const t0 = new Date(row.points[0]!.at).getTime(); const t1 = currentAt + 6 * 3_600_000; const span = Math.max(1, t1 - t0);
        const xy = (at: string, priceValue: number) => ({ x: px + ((new Date(at).getTime() - t0) / span) * (width - px * 2), y: py + (1 - (priceValue - min) / Math.max(max - min, 1e-9)) * (height - py * 2) });
        const line = (points: Array<{ at: string; price: number }>) => points.map((p, i) => { const v = xy(p.at, p.price); return `${i ? 'L' : 'M'} ${v.x.toFixed(1)} ${v.y.toFixed(1)}`; }).join(' ');
        const current = xy(row.points.at(-1)!.at, row.price); const targetPoints = forecast.map((p) => ({ at: new Date(currentAt + p.hours * 3_600_000).toISOString(), price: p.targetPrice }));
        const forecastLine = line([{ at: row.points.at(-1)!.at, price: row.price }, ...targetPoints]);
        const rangePath = forecast.length ? line([{ at: row.points.at(-1)!.at, price: row.price }, ...forecast.map((p) => ({ at: new Date(currentAt + p.hours * 3_600_000).toISOString(), price: p.lowerPrice })), ...[...forecast].reverse().map((p) => ({ at: new Date(currentAt + p.hours * 3_600_000).toISOString(), price: p.upperPrice }))]) + ' Z' : '';
        const color = toneFor(row.directive); const m5 = row.indicators.m5; const h1 = row.indicators.h1;
        // 2026-07-21 operator ask: the directive/confidence above is a GATE, not a trigger — it never
        // opens anything by itself (a lane must independently propose this symbol as a fresh candidate,
        // then this timeline only approves/blocks it). Surface the REAL outcome next to it so "ENTER
        // LONG 83%" is never mistaken for "a position will open": either a real open position (which
        // lane, direction, qty, entry, live uPNL) or an explicit "no open position" state.
        const openPosition = positions?.find((p) => p.symbol === row.symbol) ?? null;
        const posColor = openPosition ? (openPosition.direction === 'LONG' ? '#5ce4a6' : '#ff6b6b') : '#9db1ba';
        return <div key={row.symbol} className="testnet-price-timeline">
          <div className="testnet-regime-forecast-head"><span>{row.symbol} PRICE TIMELINE</span><strong style={{ color }}>{row.directive.replace('_', ' ')}</strong><em>{row.confidence == null ? 'n/a' : `${Math.round(row.confidence * 100)}% confidence`}</em></div>
          {/* 2026-07-23 dashboard consolidation: chart + m5/h1 indicator detail collapse behind a
             per-symbol Disclosure — the Keputusan-trade line + entry/exit reason text below stay
             outside it, always visible (real open-position state must never require a click). */}
          <Disclosure summary="Chart & forecast ▸">
            <svg className="testnet-lane-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${row.symbol} price timeline and forecast`}>
              <rect x="0" y="0" width={width} height={height} rx="12" className="testnet-chart-bg" />
              {[0.2, 0.5, 0.8].map((ratio) => <line key={ratio} x1={px} x2={width - px} y1={py + ratio * (height - py * 2)} y2={py + ratio * (height - py * 2)} className="testnet-chart-grid" />)}
              <line x1={current.x} x2={current.x} y1={py} y2={height - py} className="testnet-chart-now" />
              <path d={line(row.points)} fill="none" stroke="#8bd3f0" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
              {rangePath && <path d={rangePath} fill={color} opacity="0.12" />}
              {forecastLine && <path d={forecastLine} fill="none" stroke={color} strokeWidth="2" strokeDasharray="6 5" />}
              <circle cx={current.x} cy={current.y} r="4.5" fill={color} stroke="#071016" strokeWidth="1.5" />
              <text x={px} y={15} className="testnet-chart-axis">{price(max)}</text><text x={px} y={height - py - 4} className="testnet-chart-axis">{price(min)}</text>
              <text x={px} y={height - 7} className="testnet-chart-time">{new Date(row.points[0]!.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · -12h</text><text x={current.x} y={height - 7} className="testnet-chart-time middle">NOW</text><text x={width - px} y={height - 7} className="testnet-chart-time end">+6h</text>
              {forecast.map((f) => { const pt = xy(new Date(currentAt + f.hours * 3_600_000).toISOString(), f.targetPrice); return <g key={f.hours}><circle cx={pt.x} cy={pt.y} r="3.5" fill={color} /><text x={pt.x} y={Math.max(18, pt.y - 8)} textAnchor="middle" className="testnet-chart-forecast-label">+{f.hours}h {price(f.targetPrice)}</text></g>; })}
            </svg>
            <div className="testnet-price-timeline-meta">
              <span><b>Now</b> {price(row.price)} · score {row.score == null ? 'n/a' : `${row.score >= 0 ? '+' : ''}${row.score.toFixed(2)}`}</span>
              <span><b>Turn</b> {row.turningPoint.replaceAll('_', ' ')}</span>
              <span><b>5m</b> RSI {m5?.rsi14.toFixed(0) ?? 'n/a'} · {m5?.trend ?? 'n/a'} · vol {m5?.volumeRatio?.toFixed(2) ?? 'n/a'}x</span>
              <span><b>1h</b> RSI {h1?.rsi14.toFixed(0) ?? 'n/a'} · {h1?.trend ?? 'n/a'} · ATR {h1?.atrPercent.toFixed(2) ?? 'n/a'}%</span>
              {forecast.map((f) => <span key={f.hours}><b>+{f.hours}h</b> {price(f.targetPrice)} ({signedPct(f.expectedMovePct)}) · {price(f.lowerPrice)}–{price(f.upperPrice)}</span>)}
            </div>
          </Disclosure>
          <p className="tone-measure" style={{ margin: '5px 0 12px', fontSize: 12 }}>{row.entryReason}. Long exit: {row.exitLongReason ?? 'hold lane/stop'} · Short exit: {row.exitShortReason ?? 'hold lane/stop'}.</p>
          <p style={{ margin: '0 0 12px', fontSize: 12 }}>
            <b>Keputusan trade:</b>{' '}
            {openPosition ? (
              <span style={{ color: posColor }}>
                OPEN {openPosition.direction} {openPosition.quantity} {row.symbol.replace('USDT', '')} via{' '}
                {openPosition.laneIds.length > 0 ? openPosition.laneIds.join(', ') : 'lane tak teridentifikasi'} · entry {price(openPosition.entryPrice)} ·
                uPNL {openPosition.unrealizedPnl >= 0 ? '+' : ''}{openPosition.unrealizedPnl.toFixed(2)} USDT
              </span>
            ) : (
              <span className="tone-measure">
                Tidak ada posisi terbuka — directive di atas cuma gate, bukan pemicu; posisi baru terbuka kalau ada lane yang
                mengusulkan {row.symbol} sebagai kandidat fresh DAN directive-nya setuju.
              </span>
            )}
          </p>
        </div>;
      })}
      <p className="tone-measure" style={{ margin: '8px 0 0', fontSize: 12 }}>{data.note ?? 'Timeline is informational.'} Execution overlay: {data.enabledForExecution ? 'ON for fresh BTC/ETH/SOL single-symbol signals' : 'OFF (display only)'}.</p>
    </div>
  );
}

function LanePerformanceChart({ series }: { series: LanePerformanceSeries | null }) {
  const lanes = series?.lanes ?? [];
  const width = 920;
  const height = 280;
  const padding = 34;
  const allValues = lanes.flatMap((lane) => lane.points.map((point) => point.cumulativePnlUsd));
  const rawMin = allValues.length > 0 ? Math.min(0, ...allValues) : 0;
  const rawMax = allValues.length > 0 ? Math.max(0, ...allValues) : 1;
  const padY = Math.max((rawMax - rawMin) * 0.12, 1);
  const minY = rawMin - padY;
  const maxY = rawMax + padY;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const zeroY = padding + plotHeight - ((0 - minY) / Math.max(maxY - minY, 1)) * plotHeight;
  const labelBuckets = series?.bucketStarts ?? [];
  const tickCount = labelBuckets.length;
  // Cap tick density so a future higher-resolution view can't render illegibly-overlapping
  // labels; every view shipped today (max 31 daily buckets) renders one tick per bucket.
  const MAX_TICKS = 31;
  const tickStep = tickCount > MAX_TICKS ? Math.ceil(tickCount / MAX_TICKS) : 1;
  const axisTicks = labelBuckets
    .map((iso, index) => ({ iso, index }))
    .filter(({ index }) => index % tickStep === 0 || index === tickCount - 1);

  if (!series || lanes.length === 0) {
    return (
      <div className="testnet-chart-empty">
        <strong>No closed lane performance yet</strong>
        <p>Chart akan muncul setelah ada posisi Binance testnet yang closed dan realized P&amp;L tercatat.</p>
      </div>
    );
  }

  return (
    <div className="testnet-chart-wrap">
      <svg className="testnet-lane-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Lane performance by time bucket">
        <defs>
          <linearGradient id="laneChartFade" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#5ce4a6" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#5ce4a6" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={width} height={height} rx="12" className="testnet-chart-bg" />
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding + ratio * plotHeight;
          return <line key={ratio} x1={padding} x2={width - padding} y1={y} y2={y} className="testnet-chart-grid" />;
        })}
        <line x1={padding} x2={width - padding} y1={zeroY} y2={zeroY} className="testnet-chart-zero" />
        <text x={padding} y={18} className="testnet-chart-axis">{signed(maxY)}</text>
        <text x={padding} y={height - 22} className="testnet-chart-axis">{signed(minY)}</text>
        {axisTicks.map(({ iso, index }) => {
          const x = tickCount === 1 ? width / 2 : padding + (index / (tickCount - 1)) * plotWidth;
          return (
            <text key={iso} x={x} y={height - 8} className="testnet-chart-time middle">
              {formatAxisTick(iso, series?.view ?? 'daily')}
            </text>
          );
        })}
        {lanes.map((lane, index) => {
          const color = LANE_CHART_COLORS[index % LANE_CHART_COLORS.length];
          const path = pointPath(lane.points, minY, maxY, plotWidth, plotHeight);
          return (
            <g key={lane.laneId} transform={`translate(${padding} ${padding})`}>
              {path && (
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              {lane.points.map((point, pointIndex) => {
                if (point.closedCount <= 0) return null;
                const { x, y } = pointCoord(point, pointIndex, lane.points.length, minY, maxY, plotWidth, plotHeight);
                return (
                  <circle
                    key={`${point.bucketStart}-${pointIndex}`}
                    cx={x}
                    cy={y}
                    r={lane.points.length === 1 ? 5 : 3.5}
                    fill={color}
                    stroke="#071016"
                    strokeWidth="1.5"
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="testnet-chart-legend">
        {lanes.map((lane, index) => (
          <div key={lane.laneId}>
            <i style={{ background: LANE_CHART_COLORS[index % LANE_CHART_COLORS.length] }} />
            <span>{compactLane(lane.laneId)}</span>
            <strong className={tone(lane.realizedPnlUsd)}>{signed(lane.realizedPnlUsd)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const body = await readJsonResponse<T & { ok?: boolean; reason?: string }>(response);
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.reason ?? `Request failed (${response.status})`);
  }
  return body as T;
}

async function readJsonResponse<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response (${response.status})`);
  }
}

type PsleCellRow = {
  laneId: string; symbol: string; direction: 'LONG' | 'SHORT' | 'MIXED' | null;
  closed: number; headlineClosed: number; netAvgR: number | null; pf: number | null; wr: number | null;
  promotable: boolean; testnetCandidate: boolean;
};
type PsleReport = {
  minClosed: number; cells: PsleCellRow[];
  summary: { testnetCandidateCells: number; promotableCells: number;
    byDirection: Record<'LONG' | 'SHORT' | 'MIXED', { measured: number; testnetCandidate: number; promotable: number }> };
};

export default function TestnetExchangeDashboard() {
  const isLivePage = window.location.pathname.startsWith('/live');
  // Temporary testnet presentation guard. These panels remain available on the live page and
  // do not alter any scanner, execution, or risk-control behaviour.
  const showTestnetEngineControls = false;
  const showTestnetRegimeDirection = false;
  const showTestnetSingleSymbolTimeline = false;
  const showTestnetLaneResearch = false;
  const pageApiPrefix = isLivePage ? LIVE_API_PREFIX : TESTNET_API_PREFIX;
  const pageName = isLivePage ? 'LIVE' : 'Testnet';
  const pageSubtitle = isLivePage ? 'Binance mainnet mirror' : 'Binance testnet mirror';
  const pageScope = isLivePage ? 'Exchange-only LIVE view' : 'Exchange-only testnet view';
  const walletLabel = isLivePage ? 'mainnet wallet' : 'testnet wallet';
  const allocationLabel = isLivePage ? 'LIVE lane allocation' : 'Testnet lane allocation';
  const [account, setAccount] = useState<LiveAccount | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [laneSeries, setLaneSeries] = useState<LanePerformanceSeries | null>(null);
  const [mfeRolloutSeries, setMfeRolloutSeries] = useState<LanePerformanceSeries | null>(null);
  // Guards against the view-filter effect and the 5s auto-refresh timer racing: only the result
  // of the MOST RECENTLY STARTED loadExchangeOnly() call is ever applied, so a slower older
  // request can't resolve after a newer one and overwrite fresher wallet/position/P&L state.
  const exchangeLoadSeqRef = useRef(0);
  // 2026-07-12 fix: same race class as exchangeLoadSeqRef above — the 15s auto-refresh poll and a
  // manual close's own post-close refresh call loadSingleSymbolPositions() independently, with no
  // guard against an in-flight poll (started BEFORE the close) resolving AFTER the post-close
  // refresh and making the just-closed position reappear as still open.
  const singleSymbolLoadSeqRef = useRef(0);
  // 2026-07-12 fix: same race class — these all run on the SAME 15s auto-refresh timer with no
  // guard against a slow, older response resolving after a newer one and displaying stale data.
  const regimeReportLoadSeqRef = useRef(0);
  const regimePresetsLoadSeqRef = useRef(0);
  const perSymbolLoadSeqRef = useRef(0);
  const regimeAxisLoadSeqRef = useRef(0);
  const singleSymbolTimelineLoadSeqRef = useRef(0);
  const xsecExecLoadSeqRef = useRef(0);
  const xsecExecTrendLoadSeqRef = useRef(0);
  const xsecExecMixedLoadSeqRef = useRef(0);
  const laneEvaluationLoadSeqRef = useRef(0);
  const rndLanesLoadSeqRef = useRef(0);
  const cortexDecisionAlphaLoadSeqRef = useRef(0);
  const cortexRealAttributionLoadSeqRef = useRef(0);
  const [performanceView, setPerformanceView] = useState('hourly');
  const [performanceDay, setPerformanceDay] = useState(localDateInput());
  const [performanceMonth, setPerformanceMonth] = useState(localMonthInput());
  const [performanceYear, setPerformanceYear] = useState(`${new Date().getFullYear()}`);
  const [performanceRegime, setPerformanceRegime] = useState('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlMsg, setControlMsg] = useState<{ ok: boolean; message: string } | null>(null);
  // 2026-07-09 fix: was 4 fixed lane1..4/weight1..4 state pairs — the account now legitimately
  // runs 5 simultaneous lane allocations (MAX_LANE_ALLOCATIONS raised server-side to 10), and there
  // was no way to even SEE the current 5th lane in this form before overwriting it — editing any
  // one weight and hitting Apply silently dropped whichever lane didn't fit in slot 1-4 to
  // zero-weight/blocked, with no error. Now a dynamic array of rows, and loadCurrentAllocation()
  // below lets the operator pull the REAL server-side state into the form before editing it.
  const [allocRows, setAllocRows] = useState<Array<{ lane: string; weight: string }>>([
    { lane: 'CG_WIDE_FAST_SHORT', weight: '70' },
    { lane: 'CG_WIDE_FAST_LONG', weight: '30' },
  ]);
  // 2026-07-19 fix: these used to default to a hardcoded specific lane (CG_WIDE_FAST_LONG /
  // CG_WIDE_FAST_SHORT — a decommissioned lane on the SHORT side) instead of the real server
  // state. An operator who opened this panel and hit "Apply LONG / SHORT" before ever clicking
  // "Load current" would silently overwrite their actual live allocation with these placeholders,
  // with no warning. Now defaults to empty (same safe fallback loadManualDirectionalAllocation
  // itself already uses when the server has nothing set) and is auto-populated from the real
  // server value once below, instead of guessing.
  const [manualLongAllocRows, setManualLongAllocRows] = useState<Array<{ lane: string; weight: string }>>([{ lane: '', weight: '0' }]);
  const [manualShortAllocRows, setManualShortAllocRows] = useState<Array<{ lane: string; weight: string }>>([{ lane: '', weight: '0' }]);
  const [regimeReport, setRegimeReport] = useState<RegimeEngineReport | null>(null);
  const [regimePresets, setRegimePresets] = useState<RegimePresetsMap>({});
  const [regimeAxis, setRegimeAxis] = useState<RegimeAxisTimelineData | null>(null);
  const [singleSymbolTimeline, setSingleSymbolTimeline] = useState<SingleSymbolPriceTimelineData | null>(null);
  const [closeBusy, setCloseBusy] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [xsecExec, setXsecExec] = useState<XsecExecStatus | null>(null);
  // 2026-07-11: TREND/MIXED are separate CrossSectionalExecutor instances with their own halted/
  // error/openBaskets state (see cross-sectional-executor-{trend,mixed} routes) — before this fix
  // only the base FILTERED instance's status was ever fetched, so an operator had no way to see a
  // halted or erroring TREND/MIXED instance from this dashboard.
  const [xsecExecTrend, setXsecExecTrend] = useState<XsecExecStatus | null>(null);
  const [xsecExecMixed, setXsecExecMixed] = useState<XsecExecStatus | null>(null);
  const [singleSymbolLanePositions, setSingleSymbolLanePositions] = useState<SingleSymbolLanePosition[]>([]);
  // 2026-07-11: these panels used to silently keep the last-known data forever on a fetch failure,
  // with no way to tell "confirmed empty" apart from "we just haven't heard back in a while" — the
  // freshness dot elsewhere on the page kept reporting fresh regardless. Track each source's last
  // failure so the panel can show a stale warning instead of quietly trusting old data.
  const [singleSymbolPositionsStaleSince, setSingleSymbolPositionsStaleSince] = useState<string | null>(null);
  const [xsecExecStaleSince, setXsecExecStaleSince] = useState<string | null>(null);
  const [xsecExecTrendStaleSince, setXsecExecTrendStaleSince] = useState<string | null>(null);
  const [xsecExecMixedStaleSince, setXsecExecMixedStaleSince] = useState<string | null>(null);
  // 2026-07-12 fix: loadRegimeAxis's catch block explicitly "keeps last" on fetch failure with no
  // staleness flag — same failure mode the panels above already got a staleSince indicator for.
  const [regimeAxisStaleSince, setRegimeAxisStaleSince] = useState<string | null>(null);
  const [singleSymbolTimelineStaleSince, setSingleSymbolTimelineStaleSince] = useState<string | null>(null);
  const [laneEvaluation, setLaneEvaluation] = useState<LaneEvaluationRow[]>([]);
  const [rndLanes, setRndLanes] = useState<RndLaneReport[]>([]);
  const [cortexDecisionAlpha, setCortexDecisionAlpha] = useState<CortexDecisionAlphaReport | null>(null);
  const [cortexRealAttribution, setCortexRealAttribution] = useState<CortexRealAttributionReport | null>(null);
  const [psle, setPsle] = useState<PsleReport | null>(null);
  const [headlineLaneOptions, setHeadlineLaneOptions] = useState<string[]>([]);
  const [serverAllocationLaneOptions, setServerAllocationLaneOptions] = useState<string[]>([]);
  const laneAllocationOptions = Array.from(new Set(
    [...LIVE_LANE_OPTIONS, ...serverAllocationLaneOptions, ...headlineLaneOptions, ...allocRows.map((r) => r.lane)].filter(Boolean),
  ));

  function applyRegimePreset(preset: Array<{ laneId: string; weightPct: number }>) {
    const rows = preset
      .filter((entry) => entry.laneId.trim())
      .map((entry) => ({ lane: entry.laneId, weight: String(entry.weightPct) }));
    setAllocRows(rows.length ? rows : [{ lane: '', weight: '0' }]);
    setControlMsg({ ok: true, message: `Preset dimuat ke form ${allocationLabel} — tekan Apply untuk mengaktifkan` });
  }

  // 2026-07-09 fix: pulls the REAL current server-side allocation into the form before editing —
  // without this, the operator has no way to see what's actually active beyond the read-only
  // "active: ..." label, so any edit-and-Apply cycle risked silently dropping a lane the form
  // never knew about.
  function loadCurrentAllocation() {
    const current = status?.laneSelection?.laneAllocations;
    if (!current || current.length === 0) {
      setControlMsg({ ok: false, message: 'Load current: tidak ada allocation aktif di server (mode ALL_LANES / allow-list)' });
      return;
    }
    setAllocRows(current.map((a) => ({ lane: a.laneId, weight: String(a.weightPct) })));
    setControlMsg({ ok: true, message: `Dimuat ${current.length} lane aktif dari server ke form — edit lalu tekan Apply` });
  }

  function addAllocRow() {
    setAllocRows((rows) => [...rows, { lane: '', weight: '0' }]);
  }
  function removeAllocRow(index: number) {
    setAllocRows((rows) => rows.filter((_, i) => i !== index));
  }
  function updateAllocRow(index: number, patch: Partial<{ lane: string; weight: string }>) {
    setAllocRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  const updateManualAllocRow = (
    side: 'long' | 'short', index: number, patch: Partial<{ lane: string; weight: string }>,
  ) => {
    const setRows = side === 'long' ? setManualLongAllocRows : setManualShortAllocRows;
    setRows((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  };
  const addManualAllocRow = (side: 'long' | 'short') => {
    const setRows = side === 'long' ? setManualLongAllocRows : setManualShortAllocRows;
    setRows((rows) => [...rows, { lane: '', weight: '0' }]);
  };
  const removeManualAllocRow = (side: 'long' | 'short', index: number) => {
    const setRows = side === 'long' ? setManualLongAllocRows : setManualShortAllocRows;
    setRows((rows) => rows.length <= 1 ? rows : rows.filter((_, i) => i !== index));
  };

  async function control(url: string, body: unknown, label: string, refresh: () => Promise<void> | void) {
    if (controlBusy) return;
    setControlBusy(true);
    setControlMsg(null);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok === false) {
        setControlMsg({ ok: false, message: `${label}: ${payload?.reason ?? `failed (${response.status})`}` });
      } else {
        setControlMsg({ ok: true, message: `${label}: OK` });
      }
    } catch (controlError) {
      setControlMsg({ ok: false, message: `${label}: ${controlError instanceof Error ? controlError.message : 'request failed'}` });
    } finally {
      setControlBusy(false);
      await refresh();
    }
  }

  const armCurrent = () => {
    if (isLivePage && !window.confirm('ARM the REAL-MONEY mainnet engine? It will start mirroring signals and accepting copy orders.')) return;
    void control(`${pageApiPrefix}/live/arm`, { confirm: 'ARM' }, `Arm ${pageName}`, loadExchangeOnly);
  };
  const disarmCurrent = () => control(`${pageApiPrefix}/live/disarm`, {}, `Disarm ${pageName}`, loadExchangeOnly);
  const toggleEntryDrain = () => {
    const enable = !(status?.newEntries?.drainActive === true);
    if (!enable && isLivePage && !window.confirm('Resume NEW real-money entries? Existing exit management is already active.')) return;
    void control(
      `${pageApiPrefix}/live/new-entry-drain`,
      { enabled: enable, confirm: 'DRAIN', reason: enable ? 'dashboard operator drain' : 'dashboard operator resume' },
      enable ? 'Pause new entries' : 'Resume new entries',
      loadExchangeOnly,
    );
  };
  const toggleManualMode = () => {
    const enabling = !(status?.laneSelection?.manualSelectorMode === true);
    if (enabling && isLivePage && !window.confirm('Enable LIVE manual directional mode? It bypasses strategy admission blockers, but still requires Entry Decision bias, fresh signal, valid stop/TP, and account safety checks.')) return;
    void control(
      `${pageApiPrefix}/live/manual-mode`,
      { enabled: enabling, confirm: 'SET_MANUAL_MODE' },
      'Manual selector mode',
      loadExchangeOnly,
    );
  };

  const applyAllocation = () => {
    const allocations: Array<{ laneId: string; weightPct: number }> = [];
    allocRows.forEach(({ lane, weight }) => {
      if (lane.trim()) allocations.push({ laneId: lane.trim(), weightPct: Number(weight) });
    });
    if (allocations.length === 0) {
      setControlMsg({ ok: false, message: 'Allocation: pick at least 1 lane' });
      return;
    }
    void control(`${pageApiPrefix}/live/lane-allocations`, { allocations, confirm: 'SET_ALLOCATIONS' }, allocationLabel, loadExchangeOnly);
  };
  const clearAllocation = () =>
    control(`${pageApiPrefix}/live/lane-allocations`, { allocations: null, confirm: 'SET_ALLOCATIONS' }, `Clear ${allocationLabel}`, loadExchangeOnly);

  const loadManualDirectionalAllocation = () => {
    const current = status?.laneSelection?.manualDirectionalAllocations;
    if (!current) {
      setControlMsg({ ok: false, message: 'Manual directional allocation belum diset di server.' });
      return;
    }
    setManualLongAllocRows(current.long.length ? current.long.map((row) => ({ lane: row.laneId, weight: String(row.weightPct) })) : [{ lane: '', weight: '0' }]);
    setManualShortAllocRows(current.short.length ? current.short.map((row) => ({ lane: row.laneId, weight: String(row.weightPct) })) : [{ lane: '', weight: '0' }]);
    setControlMsg({ ok: true, message: 'Manual LONG dan SHORT allocation dimuat dari server.' });
  };
  const applyManualDirectionalAllocation = () => {
    const toRows = (rows: Array<{ lane: string; weight: string }>) => rows
      .filter((row) => row.lane.trim())
      .map((row) => ({ laneId: row.lane.trim(), weightPct: Number(row.weight) }));
    const allocations = { long: toRows(manualLongAllocRows), short: toRows(manualShortAllocRows) };
    if (allocations.long.length + allocations.short.length === 0) {
      setControlMsg({ ok: false, message: 'Manual directional allocation: pilih minimal satu lane.' });
      return;
    }
    void control(
      `${pageApiPrefix}/live/manual-directional-allocations`,
      { allocations, confirm: 'SET_MANUAL_DIRECTIONAL_ALLOCATIONS' },
      'Manual LONG/SHORT allocation',
      loadExchangeOnly,
    );
  };
  const clearManualDirectionalAllocation = () =>
    control(
      `${pageApiPrefix}/live/manual-directional-allocations`,
      { allocations: null, confirm: 'SET_MANUAL_DIRECTIONAL_ALLOCATIONS' },
      'Clear manual LONG/SHORT allocation',
      loadExchangeOnly,
    );

  async function loadHeadlineLaneOptions() {
    try {
      // 2026-07-11: was a bare '/api/shadow/neural-map' — in production Caddy's Referer-based
      // routing already sends that to THIS same instance (never to research-hub 3101, contrary to
      // what this comment used to assume) since every /api/* path matches the @liveApi/@testnetApi
      // rule first. The only place the bare path actually behaved differently was local vite dev,
      // whose proxy sends all bare /api/* to localhost:3101 regardless of which page is open (see
      // apps/web/vite.config.ts) — pageApiPrefix makes local-dev preview match real prod routing.
      const payload = await fetchJson<MainNeuralMap>(`${pageApiPrefix}/shadow/neural-map`);
      setHeadlineLaneOptions(extractHeadlineAllocationLanes(payload));
    } catch {
      // keep static fallback options
    }
  }

  async function loadServerAllocationLaneOptions() {
    try {
      const payload = await fetchJson<{ lanes?: unknown }>(`${pageApiPrefix}/live/allocation-lanes`);
      if (Array.isArray(payload.lanes)) {
        setServerAllocationLaneOptions(payload.lanes.filter((lane): lane is string => typeof lane === 'string' && lane.trim().length > 0));
      }
    } catch {
      // Static and active-allocation fallbacks keep the selector usable during a transient API error.
    }
  }

  async function copyToLive(paperOrderId: string) {
    if (copyBusy) return;
    setCopyBusy(paperOrderId);
    setCopyResult(null);
    try {
      const response = await fetch(`${TESTNET_API_PREFIX}/live/copy-to-live`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paperOrderId, confirm: 'COPY_TO_LIVE' }),
      });
      const body = await response.json();
      if (!response.ok || body?.ok === false) {
        setCopyResult({ id: paperOrderId, ok: false, message: body?.reason ?? `copy failed (${response.status})` });
      } else {
        setCopyResult({ id: paperOrderId, ok: true, message: `LIVE copied: ${body?.live?.intent?.symbol ?? paperOrderId} ${body?.live?.intent?.state ?? '(state unknown — verify on exchange)'}` });
      }
    } catch (copyError) {
      setCopyResult({ id: paperOrderId, ok: false, message: copyError instanceof Error ? copyError.message : 'copy request failed' });
    } finally {
      setCopyBusy(null);
    }
  }

  async function loadExchangeOnly() {
    const seq = ++exchangeLoadSeqRef.current;
    try {
      const anchor =
        performanceView === 'hourly'
          ? performanceDay
          : performanceView === 'daily' || performanceView === 'weekly'
            ? performanceMonth
            : performanceView === 'monthly' || performanceView === 'yearly'
              ? performanceYear
              : '';
      const seriesParams = new URLSearchParams({
        view: performanceView,
        regime: performanceRegime,
      });
      if (anchor) seriesParams.set('anchor', anchor);
      const mfeRolloutParams = new URLSearchParams(seriesParams);
      mfeRolloutParams.set('cohort', 'testnet_mfe_giveback_xrp_wld');
      const [nextStatus, nextAccount, nextLaneSeries, nextMfeRolloutSeries] = await Promise.all([
        fetchJson<LiveStatus>(`${pageApiPrefix}/live/status`),
        fetchJson<LiveAccount>(`${pageApiPrefix}/live/account`),
        fetchJson<LanePerformanceSeries>(`${pageApiPrefix}/live/lane-performance-series?${seriesParams.toString()}`),
        !isLivePage
          ? fetchJson<LanePerformanceSeries>(`${pageApiPrefix}/live/lane-performance-series?${mfeRolloutParams.toString()}`)
          : Promise.resolve(null),
      ]);
      if (seq !== exchangeLoadSeqRef.current) return; // a newer call already superseded this one
      setStatus(nextStatus);
      setAccount(nextAccount);
      setLaneSeries(nextLaneSeries);
      setMfeRolloutSeries(nextMfeRolloutSeries);
      setError(null);
      setLastLoadedAt(new Date().toISOString());
    } catch (nextError) {
      if (seq !== exchangeLoadSeqRef.current) return;
      setError(nextError instanceof Error ? nextError.message : `Unable to load Binance ${isLivePage ? 'mainnet' : 'testnet'} mirror`);
    }
  }

  // Regime engine report — report-only, market-wide (lives on the TESTNET instance). Loaded
  // INDEPENDENTLY of the exchange fetches so a live-endpoint hiccup can never skip it — that
  // was why the panel could stay blank on /live. Shown identically on both /testnet and /live.
  async function loadRegimeReport() {
    const seq = ++regimeReportLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/shadow/regime-engine-report`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== regimeReportLoadSeqRef.current) return;
      setRegimeReport(body);
    } catch {
      if (seq !== regimeReportLoadSeqRef.current) return;
      setRegimeReport(null); // fail-soft: the panel just says unavailable
    }
  }

  // 2026-07-09 fix: loads the REAL backend REGIME_AUTOPILOT_PRESETS so the "Lane Tree" panel's
  // preset buttons can never drift from what the server actually applies (see /live/regime-presets'
  // doc comment for the incident this closes).
  async function loadRegimePresets() {
    const seq = ++regimePresetsLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/live/regime-presets`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== regimePresetsLoadSeqRef.current) return;
      setRegimePresets(body);
    } catch {
      if (seq !== regimePresetsLoadSeqRef.current) return;
      setRegimePresets({}); // fail-soft: preset buttons just show nothing to apply
    }
  }

  // Operator close of one directional intent — real market order, double-gated (window.confirm
  // here + {"confirm":"CLOSE"} on the API). Only the engine's share closes; basket legs stay.
  async function closeIntentNow(paperOrderId: string, symbol: string) {
    if (closeBusy) return;
    if (!window.confirm(`Close ${symbol} sekarang? Ini order market REAL (hanya porsi engine).`)) return;
    setCloseBusy(paperOrderId);
    setCloseResult(null);
    try {
      const res = await fetch(`${pageApiPrefix}/live/close-intent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paperOrderId, confirm: 'CLOSE' }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        setCloseResult({ ok: false, message: `close ${symbol} gagal: ${body?.reason ?? res.status}` });
      } else {
        setCloseResult({ ok: true, message: `${symbol} closed · realized ${body?.realizedPnlUsd != null ? signed(body.realizedPnlUsd) : 'n/a'}` });
        void loadExchangeOnly();
      }
    } catch (err) {
      setCloseResult({ ok: false, message: err instanceof Error ? err.message : 'close request failed' });
    } finally {
      setCloseBusy(null);
    }
  }

  // Operator close of ONE single-symbol-lane-executor position (2026-07-10: operator asked for
  // separated per-lane control after noticing two lanes on the same symbol can have very different
  // track records — one proven-ish and trailing-protected, another with zero closed trades and no
  // interim protection until its hard stop). Real market order, double-gated same as closeIntentNow.
  async function closeSingleSymbolLaneNow(positionId: string, symbol: string, laneId: string) {
    if (closeBusy) return;
    const busyKey = `ssle:${positionId}`;
    if (!window.confirm(`Close ${symbol} (${compactLane(laneId)}) sekarang? Ini order market REAL, hanya lane ini.`)) return;
    setCloseBusy(busyKey);
    setCloseResult(null);
    try {
      const res = await fetch(`${pageApiPrefix}/live/single-symbol/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ positionId, confirm: 'CLOSE' }),
      });
      const body = await readJsonResponse<{ ok?: boolean; reason?: string; netPnlUsd?: number | null }>(res);
      if (!res.ok || body?.ok === false) {
        setCloseResult({ ok: false, message: `close ${symbol} (${compactLane(laneId)}) gagal: ${body?.reason ?? res.status}` });
      } else {
        setCloseResult({ ok: true, message: `${symbol} (${compactLane(laneId)}) closed · realized ${body?.netPnlUsd != null ? signed(body.netPnlUsd) : 'n/a'}` });
        void loadExchangeOnly();
        void loadSingleSymbolPositions();
      }
    } catch (err) {
      setCloseResult({ ok: false, message: err instanceof Error ? err.message : 'close request failed' });
    } finally {
      setCloseBusy(null);
    }
  }

  // Flat per-lane-position list backing the "Single-symbol executor" panel (2026-07-10) — one row
  // per lane's OWN position on a symbol, not summed across lanes, so each can be inspected/closed
  // independently.
  async function loadSingleSymbolPositions() {
    const seq = ++singleSymbolLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/live/single-symbol/positions`, { cache: 'no-store' });
      const body = await readJsonResponse<{ ok?: boolean; positions?: SingleSymbolLanePosition[] }>(res);
      if (seq !== singleSymbolLoadSeqRef.current) return; // a newer call already superseded this one
      if (res.ok && body?.ok && Array.isArray(body.positions)) {
        setSingleSymbolLanePositions(body.positions as SingleSymbolLanePosition[]);
        setSingleSymbolPositionsStaleSince(null);
      } else {
        setSingleSymbolPositionsStaleSince((prev) => prev ?? new Date().toISOString());
      }
    } catch {
      if (seq !== singleSymbolLoadSeqRef.current) return;
      setSingleSymbolPositionsStaleSince((prev) => prev ?? new Date().toISOString());
    }
  }

  // Evaluation section for the lanes being validated on testnet (2026-07-10) — merges each lane's
  // paper/shadow measurement stats with its real testnet-money execution stats in one table.
  async function loadLaneEvaluation() {
    const seq = ++laneEvaluationLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/live/lane-evaluation`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== laneEvaluationLoadSeqRef.current) return;
      if (body?.ok && Array.isArray(body.lanes)) setLaneEvaluation(body.lanes as LaneEvaluationRow[]);
    } catch {
      /* keep last */
    }
  }

  // Tier-3 R&D lanes (2026-07-10 GPT-5.6 audit): 3 brand-new report-only shadow engines, none
  // wired to any executor. Fetches all 3 report routes in parallel; a failed/missing one just
  // shows as null in the table rather than dropping the whole panel.
  async function loadRndLanes() {
    const seq = ++rndLanesLoadSeqRef.current;
    const specs: Array<{ label: string; path: string }> = [
      { label: 'Residual momentum + catch-up', path: 'residual-momentum-report' },
      { label: 'Liquidation-recoil cross-sectional', path: 'liquidation-recoil-xs-report' },
      { label: 'Compression → expansion ignition', path: 'compression-expansion-report' },
    ];
    const rows = await Promise.all(
      specs.map(async ({ label, path }) => {
        try {
          const res = await fetch(`${pageApiPrefix}/shadow/${path}`, { cache: 'no-store' });
          const body = await res.json();
          if (!body || typeof body.laneId !== 'string') return null;
          return {
            label,
            laneId: body.laneId as string,
            openCount: Number(body.openCount) || 0,
            resolvedCount: Number(body.resolvedCount) || 0,
            netAvgR: body.netAvgR == null ? null : Number(body.netAvgR),
            wr: body.wr == null ? null : Number(body.wr),
            pf: body.pf == null ? null : Number(body.pf),
            edgeReady: Boolean(body.edgeReady),
          } as RndLaneReport;
        } catch {
          return null;
        }
      }),
    );
    if (seq !== rndLanesLoadSeqRef.current) return;
    setRndLanes(rows);
  }

  // CORTEX #219 shadow decision-alpha, testnet-only (never fetched on /live — CORTEX has zero real
  // influence on mainnet, full stop, and this must never even appear to associate the two). Refreshed
  // every 60s, not the dashboard's usual faster cadences — the underlying figure only changes once per
  // CORTEX_REFIT_INTERVAL_MS cycle (minutes apart), and a tighter poll was a real contributor to the
  // 2026-07-20 testnet event-loop-starvation incident.
  async function loadCortexDecisionAlpha() {
    if (isLivePage) return;
    const seq = ++cortexDecisionAlphaLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/shadow/cortex-decision-alpha`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== cortexDecisionAlphaLoadSeqRef.current) return;
      if (body && typeof body.today === 'object') setCortexDecisionAlpha(body as CortexDecisionAlphaReport);
    } catch {
      /* keep last — a transient miss just leaves the comparison line showing the previous value */
    }
  }

  // CORTEX real-USDT attribution, testnet-only — same cadence + seq/keep-last pattern as
  // loadCortexDecisionAlpha above (the figure only moves when a tilted-lane trade closes).
  async function loadCortexRealAttribution() {
    if (isLivePage) return;
    const seq = ++cortexRealAttributionLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/live/cortex-real-attribution`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== cortexRealAttributionLoadSeqRef.current) return;
      if (body && typeof body.today === 'object' && typeof body.allTime === 'object') {
        setCortexRealAttribution(body as CortexRealAttributionReport);
      }
    } catch {
      /* keep last — a transient miss just leaves the line showing the previous value */
    }
  }

  // Cross-sectional executor status: per-basket TP gap + daily breaker state.
  async function loadXsecExec() {
    const seq = ++xsecExecLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/live/cross-sectional-executor`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== xsecExecLoadSeqRef.current) return;
      if (body && typeof body.enabled === 'boolean') {
        setXsecExec(body as XsecExecStatus);
        setXsecExecStaleSince(null);
      } else {
        setXsecExecStaleSince((prev) => prev ?? new Date().toISOString());
      }
    } catch {
      if (seq !== xsecExecLoadSeqRef.current) return;
      setXsecExecStaleSince((prev) => prev ?? new Date().toISOString());
    }
  }
  // Same shape, the TREND/MIXED sibling instances (2026-07-11: previously never fetched).
  async function loadXsecExecTrend() {
    const seq = ++xsecExecTrendLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/live/cross-sectional-executor-trend`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== xsecExecTrendLoadSeqRef.current) return;
      if (body && typeof body.enabled === 'boolean') {
        setXsecExecTrend(body as XsecExecStatus);
        setXsecExecTrendStaleSince(null);
      } else {
        setXsecExecTrendStaleSince((prev) => prev ?? new Date().toISOString());
      }
    } catch {
      if (seq !== xsecExecTrendLoadSeqRef.current) return;
      setXsecExecTrendStaleSince((prev) => prev ?? new Date().toISOString());
    }
  }
  async function loadXsecExecMixed() {
    const seq = ++xsecExecMixedLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/live/cross-sectional-executor-mixed`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== xsecExecMixedLoadSeqRef.current) return;
      if (body && typeof body.enabled === 'boolean') {
        setXsecExecMixed(body as XsecExecStatus);
        setXsecExecMixedStaleSince(null);
      } else {
        setXsecExecMixedStaleSince((prev) => prev ?? new Date().toISOString());
      }
    } catch {
      if (seq !== xsecExecMixedLoadSeqRef.current) return;
      setXsecExecMixedStaleSince((prev) => prev ?? new Date().toISOString());
    }
  }

  // Regime-axis timeline: continuous distance-to-neutral score over the engine's history.
  async function loadRegimeAxis() {
    const seq = ++regimeAxisLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/shadow/regime-axis-timeline`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== regimeAxisLoadSeqRef.current) return;
      if (Array.isArray(body?.points)) {
        setRegimeAxis(body as RegimeAxisTimelineData);
        setRegimeAxisStaleSince(null);
      } else {
        setRegimeAxisStaleSince((prev) => prev ?? new Date().toISOString());
      }
    } catch {
      if (seq !== regimeAxisLoadSeqRef.current) return;
      setRegimeAxisStaleSince((prev) => prev ?? new Date().toISOString());
    }
  }

  async function loadSingleSymbolTimeline() {
    const seq = ++singleSymbolTimelineLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/live/single-symbol-timeline`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== singleSymbolTimelineLoadSeqRef.current) return;
      if (body?.enabled === true && Array.isArray(body?.symbols)) {
        setSingleSymbolTimeline(body as SingleSymbolPriceTimelineData);
        setSingleSymbolTimelineStaleSince(null);
      } else {
        setSingleSymbolTimelineStaleSince((prev) => prev ?? new Date().toISOString());
      }
    } catch {
      if (seq !== singleSymbolTimelineLoadSeqRef.current) return;
      setSingleSymbolTimelineStaleSince((prev) => prev ?? new Date().toISOString());
    }
  }

  // Per-symbol book edge for THIS instance's book (live shows the mainnet book, testnet the testnet
  // book) — the book-proven symbols the live auto-rotation admits. Own cadence, fail-soft.
  async function loadPerSymbol() {
    const seq = ++perSymbolLoadSeqRef.current;
    try {
      const res = await fetch(`${pageApiPrefix}/shadow/per-symbol-lane-edge`, { cache: 'no-store' });
      const body = await res.json();
      if (seq !== perSymbolLoadSeqRef.current) return;
      setPsle(body);
    } catch {
      if (seq !== perSymbolLoadSeqRef.current) return;
      setPsle(null);
    }
  }

  useEffect(() => {
    void loadExchangeOnly();
  }, [performanceView, performanceDay, performanceMonth, performanceYear, performanceRegime]);

  useEffect(() => {
    void loadHeadlineLaneOptions();
    void loadServerAllocationLaneOptions();
    const timer = window.setInterval(() => {
      void loadHeadlineLaneOptions();
      void loadServerAllocationLaneOptions();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadExchangeOnly();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, performanceView, performanceDay, performanceMonth, performanceYear, performanceRegime]);

  // Regime panel loads on its own cadence, independent of the exchange fetches (so it shows
  // on /live even if a live endpoint hiccups). Refreshes every 15s.
  useEffect(() => {
    void loadRegimeReport();
    void loadRegimePresets();
    void loadPerSymbol();
    void loadRegimeAxis();
    void loadSingleSymbolTimeline();
    void loadXsecExec();
    void loadXsecExecTrend();
    void loadXsecExecMixed();
    void loadSingleSymbolPositions();
    void loadLaneEvaluation();
    void loadRndLanes();
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadRegimeReport();
      void loadRegimePresets();
      void loadPerSymbol();
      void loadRegimeAxis();
      void loadSingleSymbolTimeline();
      void loadXsecExec();
      void loadXsecExecTrend();
      void loadXsecExecMixed();
      void loadSingleSymbolPositions();
      void loadLaneEvaluation();
    void loadRndLanes();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  // CORTEX #219 shadow decision-alpha — own cadence (60s, not 15s): testnet-only, and the underlying
  // figure only changes once per refit cycle (minutes apart), so a faster poll would just be chatter.
  useEffect(() => {
    if (isLivePage) return undefined;
    void loadCortexDecisionAlpha();
    void loadCortexRealAttribution();
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadCortexDecisionAlpha();
      void loadCortexRealAttribution();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  // 2026-07-19 fix: auto-sync the manual LONG/SHORT selector with the REAL server-side allocation
  // the very first time it becomes available, instead of leaving the operator to discover (or
  // never discover) that the form was still showing an empty/placeholder default. Guarded by a
  // ref, not state, so it fires exactly once — later status polls (every few seconds while
  // autoRefresh is on) must NOT re-run this and clobber whatever the operator has since typed in,
  // mid-edit, before pressing Apply.
  const manualDirectionalAutoLoadedRef = useRef(false);
  useEffect(() => {
    if (manualDirectionalAutoLoadedRef.current) return;
    if (!status?.laneSelection?.manualDirectionalAllocations) return;
    manualDirectionalAutoLoadedRef.current = true;
    loadManualDirectionalAllocation();
  }, [status]);

  const stale = lastLoadedAt ? Date.now() - new Date(lastLoadedAt).getTime() > REFRESH_MS * 2.5 : true;
  const healthTone = status?.armed ? 'tone-healthy' : status?.health?.lastTickError ? 'tone-warning' : 'tone-measure';
  const totalSourceEntries = account?.positions.reduce((sum, position) => sum + position.sourceOrderCount, 0) ?? 0;
  const regimeOptions = laneSeries?.regimeOptions ?? FALLBACK_REGIME_OPTIONS;
  // Testnet is currently scoped to cross-sectional work plus the explicitly approved
  // XRP/WLD CG_MFE_GIVEBACK rollout. Keep the live page's full history, while the testnet
  // performance timeline shows the cross-sectional variants and this one approved CG lane.
  const isTestnetTimelineLane = (laneId: string) => laneId.startsWith('CROSS_SECTIONAL_');
  const timelineSeries = !isLivePage && laneSeries
    ? {
      ...laneSeries,
      lanes: [
        ...laneSeries.lanes.filter((lane) => isTestnetTimelineLane(lane.laneId)),
        ...(mfeRolloutSeries?.lanes ?? []).map((lane) => ({
          ...lane,
          laneId: mfeRolloutSeries?.cohort?.label ?? 'CG_MFE_GIVEBACK — XRP/WLD rollout',
        })),
      ],
    }
    : laneSeries;
  const chartTotal = timelineSeries?.lanes.reduce((sum, lane) => sum + lane.realizedPnlUsd, 0) ?? 0;
  // 2026-07-09: was CROSS_SECTIONAL_MARKET_NEUTRAL-only — missed the TREND/MIXED instances wired
  // 2026-07-08, so their basket legs fell through to the directional/foundation split as if they
  // were plain directional intents instead of hedge-managed cross-sectional legs.
  const isCrossSectionalPosition = (laneIds: string[]) =>
    laneIds.includes('CROSS_SECTIONAL_MARKET_NEUTRAL') || laneIds.includes('CROSS_SECTIONAL_TREND') || laneIds.includes('CROSS_SECTIONAL_MIXED');
  // 2026-07-09: SHORT_FADE_EXHAUSTION_CROWDED/INTRADAY_MOMENTUM_BREAKOUT_LONG (SingleSymbolLaneExecutor)
  // also write into basketQty/basketUnrealizedPnl (annotateSingleSymbolAccount reuses the same fields
  // as basket legs), so without this check they fell into the "Cross-sectional foundation" table and
  // rendered as an untouchable, timed basket leg — when they're actually a single real position with
  // its own exchange-side stop, no sibling leg, and no "naked directional bet" risk from closing it.
  const isSingleSymbolExecutorPosition = (laneIds: string[]) =>
    // Directional cross-sectional uses SingleSymbolLaneExecutor too. It has an
    // owned stop and can be closed independently, so it must never also be
    // rendered as an auto-exit-only basket merely because its account mirror
    // carries basketQty/basketUnrealizedPnl compatibility fields.
    laneIds.includes('CROSS_SECTIONAL_DIRECTIONAL_LONG') ||
    laneIds.includes('CROSS_SECTIONAL_DIRECTIONAL_SHORT') ||
    laneIds.includes('SHORT_FADE_EXHAUSTION_CROWDED') ||
    laneIds.includes('INTRADAY_MOMENTUM_BREAKOUT_LONG') ||
    laneIds.includes('REGIME_COMPOSITE_CONFIRMATION_LONG') ||
    laneIds.includes('PANIC_WASHOUT_RECLAIM_LONG') ||
    laneIds.some((id) => id.startsWith('COMPOSITE_ESTIMATOR_BIDI_'));

  // 2026-07-23 dashboard consolidation: split (2026-07-07/08 operator asks) the directional slot
  // vs the cross-sectional foundation the exact same way the old separate tables did — lifted up
  // here (unchanged predicates) so the merged "Open Positions" table and the new KPI strip's
  // synthesized count can both read the SAME derived split without recomputing it twice.
  const intentBySymbol = new Map((status?.openIntents ?? []).map((i) => [i.symbol, i]));
  const allPositions = account?.positions ?? [];
  const directionalPositions = allPositions.filter((p) => intentBySymbol.has(p.symbol));
  const foundationPositions = allPositions.filter(
    (p) => !isSingleSymbolExecutorPosition(p.laneIds) && ((p.basketQty ?? 0) !== 0 || (isCrossSectionalPosition(p.laneIds) && !intentBySymbol.has(p.symbol))),
  );
  // 2026-07-23 fix (adversarial review finding, HIGH-adjacent): folding Intent State into the
  // directional rows means an intent is only ever shown attached to a MATCHING Binance position.
  // An intent whose symbol has no matching position yet (transient mirror/exchange desync — the
  // exact class of issue quarantinedPaperOrders/reconcileIssues already track) used to still get
  // its own row in the old separate Mirror Intents table. Surface that gap explicitly instead of
  // letting the merged table look clean while a real open intent sits unresolved and unseen.
  const orphanIntents = (status?.openIntents ?? []).filter((i) => !allPositions.some((p) => p.symbol === i.symbol));
  // NEW derived display value (2026-07-23, no new fetch): sum of open positions across all 3
  // real-money books, surfaced as a single zero-click KPI that deep-links to the merged table.
  const openPositionsCount = directionalPositions.length + foundationPositions.length + singleSymbolLanePositions.length;
  // 2026-07-11: the 3 CrossSectionalExecutor instances each have independent halted/error/
  // openBaskets/staleSince state — surface all 3, not just FILTERED, so a stuck TREND or MIXED
  // instance is visible instead of silently invisible. (Unchanged data, just one combined list
  // instead of the old separate xsecInstances array + separate staleSince array.)
  const xsecInstances: Array<{ label: string; status: XsecExecStatus | null; staleSince: string | null }> = [
    { label: 'FILTERED', status: xsecExec, staleSince: xsecExecStaleSince },
    { label: 'TREND', status: xsecExecTrend, staleSince: xsecExecTrendStaleSince },
    { label: 'MIXED', status: xsecExecMixed, staleSince: xsecExecMixedStaleSince },
  ];
  // Display-only mapping of the 3 Tier-1-3 R&D shadow lanes into the shared LaneMaturityTable's
  // row shape (2026-07-23) — no new data, just reshaping `rndLanes` state for the shared component.
  // Renamed per operator ask: disambiguate from the Research dashboard's separate single-symbol lane.
  const RND_LANE_LABELS = ['Residual momentum + catch-up', 'Liquidation-recoil (cross-sectional)', 'Compression → expansion ignition'];
  const rndLaneRows: LaneMaturityRow[] = rndLanes.length === 0
    ? []
    : rndLanes.map((r, i) => r ? {
        key: r.laneId,
        // Indexed off `i`, not `r.label` string-matching (Promise.all in loadRndLanes preserves
        // the specs array's order, so the index is a robust correspondence — a label edit at the
        // fetch call-site can never silently desync the display rename this way).
        name: RND_LANE_LABELS[i] ?? r.label,
        detail: compactLane(r.laneId),
        badge: laneEdgeBadge(r.edgeReady, null),
        nLabel: `${r.resolvedCount}/${r.openCount}`,
        netAvgR: r.netAvgR,
        wr: r.wr,
        pf: r.pf,
        lastCycleLabel: null,
      } : {
        key: `rnd-missing-${i}`,
        name: RND_LANE_LABELS[i] ?? `R&D lane ${i + 1}`,
        detail: 'No data from this report route yet.',
        badge: null,
        nLabel: '—',
        netAvgR: null,
        wr: null,
        pf: null,
        lastCycleLabel: null,
        loading: true,
      });

  return (
    <div className="neural-shell testnet-shell">
      <header className="neural-topbar">
        <div className="neural-brand">
          <span className={`neural-live-dot ${stale || error ? 'is-stale' : ''}`} />
          <div>
            <p>{pageSubtitle}</p>
            <h1>Exchange P&amp;L</h1>
          </div>
        </div>
        <nav className="neural-nav" aria-label="Dashboard views">
          <button type="button" className="is-current">{pageName}</button>
        </nav>
        <div className="neural-actions">
          <label className="neural-toggle">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span />
            Live
          </label>
          <button type="button" className="neural-icon-button" title="Refresh exchange data" aria-label="Refresh exchange data" onClick={() => void loadExchangeOnly()}>
            ↻
          </button>
        </div>
      </header>

      {/* ===== Health & Alerts zone (2026-07-23 dashboard consolidation) =====
         Always renders, immediately after the topbar, before anything else. Row 1 = primary
         real-money KPIs (unchanged content/values, just regrouped). Row 2 = secondary KPIs
         (unchanged) + the new synthesized Open Positions count. Then all 3 alert banners,
         relocated here (kill-switch -> live-engine-warning -> exchange-link-error), each still
         conditional / zero height when clean, same classNames as before — just moved. */}
      <section className="neural-statusbar testnet-statusbar">
        <div>
          <span>Execution</span>
          <strong className={healthTone}>{status?.armed ? 'Armed' : 'Disarmed'}</strong>
          <small>{status?.env ?? 'loading'} · {status?.enabled === false ? 'disabled' : 'live engine'}</small>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button type="button" disabled={controlBusy || status?.armed === true} onClick={armCurrent}>Arm</button>
            <button type="button" disabled={controlBusy || status?.armed !== true} onClick={() => void disarmCurrent()}>Disarm</button>
          </div>
        </div>
        <div>
          <span>Regime</span>
          <strong>{status?.controller?.regime ?? 'Loading'}</strong>
          <small>{status?.controller?.mode ?? 'mode n/a'} · {status?.controller?.bias ?? 'bias n/a'} · {status?.controller?.confidence ?? 'confidence n/a'}</small>
        </div>
        <div>
          <span>Estimated regime</span>
          <strong>{status?.controller?.estimatedRegime?.posture === 'EXTENDED_TREND' ? 'Long/short extended' : 'Tactical / mixed'}</strong>
          <small>{status?.controller?.estimatedRegime?.policy === 'WIDE_TREND' ? 'STOP/WIDE-first trend policy' : '75% STOP WIDE · 25% EXP MFE 10x'} · {status?.controller?.estimatedRegime?.direction ?? 'n/a'}</small>
        </div>
        <div>
          <span>Binance equity</span>
          <strong>{account?.accountEquity != null ? `${account.accountEquity.toFixed(2)} USDT` : 'Loading'}</strong>
          <small>{account?.availableBalance != null ? `${account.availableBalance.toFixed(2)} available` : walletLabel}</small>
        </div>
        <div>
          <span>Unrealized P&amp;L</span>
          {(() => {
            // Split per BOOK (2026-07-08 operator): directional = Σ P&L intent dari entry-nya
            // sendiri; baskets = Σ P&L leg basket dari entry leg-nya — bukan blend netted exchange.
            // 2026-07-12 fix: SingleSymbolLaneExecutor positions (SHORT_FADE_EXHAUSTION_CROWDED etc.)
            // reuse the SAME basketUnrealizedPnl/basketQty fields (see isSingleSymbolExecutorPosition's
            // own comment above) but the rest of this page treats them as a separate, operator
            // -closeable book, not a basket hedge leg — this "baskets" subtotal silently folded them
            // in. Split into 3 explicit subtotals using the same isSingleSymbolExecutorPosition check
            // already used elsewhere on this page.
            const ps = account?.positions ?? [];
            const dirUnreal = ps.reduce((s, p) => s + (p.intentUnrealizedPnl ?? 0), 0);
            const baskUnreal = ps
              .filter((p) => !isSingleSymbolExecutorPosition(p.laneIds))
              .reduce((s, p) => s + (p.basketUnrealizedPnl ?? 0), 0);
            const singleSymbolUnreal = ps
              .filter((p) => isSingleSymbolExecutorPosition(p.laneIds))
              .reduce((s, p) => s + (p.basketUnrealizedPnl ?? 0), 0);
            return (
              <>
                <strong className={tone(account?.unrealizedPnl)}>{signed(account?.unrealizedPnl)}</strong>
                <small>directional {signed(dirUnreal)} · baskets {signed(baskUnreal)} · single-symbol {signed(singleSymbolUnreal)} · {account ? `${account.openPositionCount} pos` : 'loading'}</small>
              </>
            );
          })()}
        </div>
        <div>
          <span>Realized P&amp;L (today)</span>
          {(() => {
            // HEADLINE = HARI INI (UTC): mirror today + baskets today + single-symbol today. The
            // lifetime numbers stay visible but clearly labeled all-time — the old headline summed
            // lifetime mirror (which still carries the pre-fix churn-era losses) with baskets and
            // read like a current loss ("kayanya kebawa data lama" — it wasn't stale, just mislabeled).
            // 2026-07-09: was CROSS_SECTIONAL_MARKET_NEUTRAL-only — the 2026-07-08 TREND/MIXED
            // instances merge into their OWN closedLanes entries (see annotateCrossSectionalAccount),
            // so a banked TREND/MIXED basket previously vanished from this all-time headline.
            // 2026-07-11: was single-symbol-executor-blind too — a real +$1.39 BTC close via
            // REGIME_COMPOSITE_CONFIRMATION_LONG (already correctly folded into account.closedLanes
            // by annotateSingleSymbolAccount) never moved this headline because nothing here summed
            // it. Operator caught it live ("kalo memang udah TP, kok all-time nya masih sama").
            // singleSymbolExecutorRealizedPnlUsd is backend-computed (routes/live.ts's /api/live/account)
            // over the live list of executors, so this never has to hardcode lane ids that drift.
            // 2026-08-16 (operator decision, taken with the trade-off stated): the MIRROR lane is out
            // of this card entirely. It is NOT decommissioned — newEntriesPaused is false and it can
            // still open positions — so this card no longer reconciles with the exchange, and that is
            // the accepted cost. Two things keep it from becoming a lie:
            //   - the kill switch is untouched. status.totalRealizedPnlUsd still carries every mirror
            //     close and still drives the daily-loss, consecutive-loss and drawdown trips, so what
            //     is hidden here can never make the account less protected.
            //   - the figure below is labelled by the lanes it COVERS, never as an account total. The
            //     old "total" label would have been false the moment a lane left the sum.
            // If the mirror lane is later disarmed, its history belongs in an audit section (the
            // pattern annotateCrossSectionalAccount already uses), not silently deleted.
            const basketsAllTime = ['CROSS_SECTIONAL_MARKET_NEUTRAL', 'CROSS_SECTIONAL_TREND', 'CROSS_SECTIONAL_MIXED']
              .reduce((sum, laneId) => sum + (account?.closedLanes?.find((l) => l.laneId === laneId)?.realizedPnlUsd ?? 0), 0);
            const singleSymbolAllTime = account?.singleSymbolExecutorRealizedPnlUsd?.allTime;
            const allTime = basketsAllTime + (singleSymbolAllTime ?? 0);
            // 2026-07-11: was FILTERED-only (xsecExec?.dailyRealizedUsd) — TREND/MIXED's own daily
            // realized P&L never moved this "today" figure even though basketsAllTime above already
            // correctly folds all 3 in via account.closedLanes.
            const basketsToday = [xsecExec?.dailyRealizedUsd, xsecExecTrend?.dailyRealizedUsd, xsecExecMixed?.dailyRealizedUsd]
              .reduce<number | undefined>((sum, v) => (v != null ? (sum ?? 0) + v : sum), undefined);
            const singleSymbolToday = account?.singleSymbolExecutorRealizedPnlUsd?.today;
            const today = basketsToday != null || singleSymbolToday != null
              ? (basketsToday ?? 0) + (singleSymbolToday ?? 0)
              : undefined;
            return (
              <>
                <strong className={tone(today)}>{signed(today)}</strong>
                <small>
                  today — baskets {signed(basketsToday)} · single-symbol {signed(singleSymbolToday)}
                  <br />
                  all-time — baskets {signed(basketsAllTime)} · single-symbol {signed(singleSymbolAllTime)} · jumlah {signed(allTime)}
                  <br />
                  <span style={{ opacity: 0.7 }}>mencakup 2 lane ini saja — bukan total akun; kill-switch tetap memakai angka penuh seluruh lane</span>
                </small>
              </>
            );
          })()}
        </div>
        {/* NEW merged CORTEX tile (2026-07-23, testnet-only): the two CORTEX lines used to sit as
           extra <small> rows tucked under Realized P&L, easy to miss. Both numbers now share ONE
           always-visible line; the tooltip only adds the day/all-time breakdown, never hides either
           figure. */}
        {!isLivePage && (
          cortexDecisionAlpha && cortexRealAttribution ? (() => {
            const da = cortexDecisionAlpha.today.decisionAlpha;
            const r = da.cumulativeTiltDeltaR;
            const rText = `${r >= 0 ? '+' : ''}${r.toFixed(4)}R`;
            const usd = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
            const todayUsd = cortexRealAttribution.today.cortexUsd;
            const allTimeUsd = cortexRealAttribution.allTime.cortexUsd;
            return (
              <div>
                <span>CORTEX impact</span>
                <strong
                  className={tone(r)}
                  title={`Counterfactual decision-alpha (today, shadow evaluation-β): ${rText} across ${da.n} example${da.n === 1 ? '' : 's'}. Real USDT attribution: today ${usd(todayUsd)} · all-time ${usd(allTimeUsd)} across ${cortexRealAttribution.allTime.n} close${cortexRealAttribution.allTime.n === 1 ? '' : 's'}.`}
                >
                  {rText} (cf.) · {usd(allTimeUsd)} (real, all-time)
                </strong>
                <small>today real {usd(todayUsd)} USDT · {da.n} example{da.n === 1 ? '' : 's'} counterfactual</small>
              </div>
            );
          })() : (
            <div>
              <span>CORTEX impact</span>
              <strong className="tone-measure">Loading…</strong>
            </div>
          )
        )}
      </section>
      <div className="testnet-kpis" style={{ margin: '0 14px 8px' }}>
        <div><span>Wallet</span><strong>{plain(account?.walletBalance, ' USDT')}</strong></div>
        <div><span>Loss streak</span><strong>{status?.consecutiveLosses ?? 0}</strong></div>
        <div><span>Clock skew</span><strong>{status?.health?.clockSkewMs == null ? 'n/a' : `${Math.round(status.health.clockSkewMs)} ms`}</strong></div>
        <div><span>Last tick</span><strong>{timeAgo(status?.health?.lastTickAt)}</strong></div>
        <div>
          <span>Open TP/SL orders</span>
          <strong>{account?.openOrderCount ?? 'n/a'}</strong>
          <small>{status?.openIntents?.length ?? 0} live intents · exits can be 2x positions</small>
        </div>
        <div>
          <span>Open positions</span>
          <strong><a href="#open-positions" style={{ color: 'inherit' }}>{openPositionsCount}</a></strong>
          <small>directional + basket + single-symbol</small>
        </div>
      </div>

      {status?.killedAt && (
        <section className="testnet-panel testnet-warning">
          <span>Kill switch latched</span>
          <strong>{status.killReason ?? 'Manual or risk kill-switch engaged'}</strong>
          <p>Latched at {new Date(status.killedAt).toLocaleString()}.</p>
        </section>
      )}

      {status?.health?.lastTickError && (
        <section className="testnet-panel testnet-warning">
          <span>Live engine warning</span>
          <strong>{status.health.lastTickError}</strong>
          <p>The page is still exchange-only; this warning is from the Binance mirror engine, not diagnostics.</p>
        </section>
      )}

      {error && (
        <div className="neural-error">
          <strong>Exchange link interrupted</strong>
          <span>{error}. Last visible Binance state remains on screen.</span>
        </div>
      )}

      <p className="tone-measure" style={{ margin: '0 14px 10px', fontSize: 12 }}>
        {pageScope} — reads only `{pageApiPrefix}/live/status` and `{pageApiPrefix}/live/account`; Binance positions are netted per symbol (one exchange position can carry multiple mirrored source entries).
      </p>

      {(isLivePage || showTestnetEngineControls) && (
      <section className="testnet-panel">
        <header>
          <span>Engine Controls</span>
          <strong>
            {pageName.toLowerCase()} {status?.armed ? 'ARMED' : 'disarmed'} · {status?.newEntries?.allowed ? 'entries OPEN' : 'entries BLOCKED'}
          </strong>
        </header>
        {controlMsg && (
          <p className={controlMsg.ok ? 'tone-healthy' : 'tone-critical'} style={{ margin: '4px 0' }}>
            {controlMsg.ok ? '✓' : '✗'} {controlMsg.message}
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <div>
            <small style={{ display: 'block', marginBottom: 4 }}>
              New entries <strong className={status?.newEntries?.allowed ? 'tone-healthy' : 'tone-critical'}>
                {status?.newEntries?.drainActive
                  ? 'DRAINED'
                  : status?.laneSelection?.manualSelectorMode
                    ? status?.laneSelection?.manualDirectionalAllocations?.activeDirection ? 'MANUAL READY' : 'WAITING ENTRY DECISION'
                    : status?.newEntries?.strategyGate?.allowed ? 'OPEN' : 'REGIME BLOCKED'}
              </strong>
            </small>
            <button type="button" disabled={controlBusy} onClick={toggleEntryDrain}>
              {status?.newEntries?.drainActive ? 'Resume new entries' : 'Pause new entries'}
            </button>
            <small style={{ display: 'block', maxWidth: 340, marginTop: 4 }}>
              {status?.newEntries?.pauseReason ?? (status?.laneSelection?.manualSelectorMode
                ? 'Manual directional policy active; scanner decides the allowed side.'
                : status?.newEntries?.strategyGate?.reason) ?? 'No entry blocker'}; exits remain managed.
            </small>
          </div>
          <div>
            <small style={{ display: 'block', marginBottom: 4 }}>
              Execution mode{' '}
              <strong style={{ color: status?.laneSelection?.manualSelectorMode ? '#e0a83a' : '#4a9d6a' }}>
                {status?.laneSelection?.manualSelectorMode ? 'MANUAL (raw selector)' : 'SMART (book+regime)'}
              </strong>
            </small>
            <button
              type="button"
              disabled={controlBusy}
              onClick={toggleManualMode}
              title={
                status?.laneSelection?.manualSelectorMode
                  ? 'Manual ON: scanner Entry Decision selects LONG or SHORT allocation; admission blockers are bypassed, but all exchange/account protections remain. Click to return to SMART.'
                  : 'SMART ON: book overlay + regime direction-gate active. Click to switch to manual directional mode.'
              }
            >
              {status?.laneSelection?.manualSelectorMode ? 'Switch to SMART' : 'Switch to MANUAL directional'}
            </button>
          </div>
          {isLivePage ? <div style={{ minWidth: 430, maxWidth: 640 }}>
            <small style={{ display: 'block', marginBottom: 4 }}>
              LIVE manual long / short allocation{' '}
              <button type="button" disabled={controlBusy} onClick={loadManualDirectionalAllocation}>Load current</button>{' '}
              <span style={{ color: '#e0a83a' }}>
                active: {status?.laneSelection?.manualDirectionalAllocations?.activeDirection ?? 'NO TRADE'}
                {status?.laneSelection?.manualDirectionalAllocations?.entryDecision
                  ? ` · ${status.laneSelection.manualDirectionalAllocations.entryDecision.action.replaceAll('_', ' ')}`
                  : ' · waiting for scanner'}
              </span>
            </small>
            {(['long', 'short'] as const).map((side) => {
              const rows = side === 'long' ? manualLongAllocRows : manualShortAllocRows;
              const tone = side === 'long' ? '#5ce4a6' : '#ffbf55';
              return <div key={side} style={{ borderTop: '1px solid #22343c', paddingTop: 4, marginTop: 4 }}>
                <strong style={{ color: tone, fontSize: 12 }}>{side.toUpperCase()} selector</strong>
                {rows.map((row, i) => (
                  <div key={i} style={{ marginTop: 2 }}>
                    <select value={row.lane} onChange={(event) => updateManualAllocRow(side, i, { lane: event.target.value })}>
                      <option value="">(none)</option>
                      {laneAllocationOptions.map((lane) => <option key={lane} value={lane}>{lane}</option>)}
                    </select>{' '}
                    <input type="number" min={0} max={100} value={row.weight} onChange={(event) => updateManualAllocRow(side, i, { weight: event.target.value })} style={{ width: 56 }} />%
                    {' '}<button type="button" disabled={controlBusy || rows.length <= 1} onClick={() => removeManualAllocRow(side, i)}>Remove</button>
                  </div>
                ))}
                <button type="button" disabled={controlBusy} onClick={() => addManualAllocRow(side)}>+ Add {side}</button>
              </div>;
            })}
            <div style={{ marginTop: 6 }}>
              <button type="button" disabled={controlBusy} onClick={applyManualDirectionalAllocation}>Apply LONG / SHORT</button>{' '}
              <button type="button" disabled={controlBusy} onClick={() => void clearManualDirectionalAllocation()}>Clear</button>
            </div>
            <small style={{ display: 'block', maxWidth: 610, marginTop: 4 }}>
              Manual follows `ENTRY DECISION SEKARANG`: only the matching directional selector is admitted. `NO TRADE` opens nothing. Fresh signal, stop/TP geometry, correlation caps, kill switch, and exchange checks remain mandatory.
            </small>
          </div> : <div>
            <small style={{ display: 'block', marginBottom: 4 }}>
              {allocationLabel} — active: {status?.laneSelection?.laneAllocations
                ? status.laneSelection.laneAllocations.map((a) => `${compactLane(a.laneId)} ${a.weightPct}%`).join(' + ')
                : status?.laneSelection?.mode ?? 'n/a'}
              {' '}
              <button type="button" disabled={controlBusy} onClick={loadCurrentAllocation}>Load current</button>
              {' '}
              <span style={{ color: status?.laneSelection?.laneAllocationOperatorLock ? '#e0a83a' : '#7a8a9a' }}>
                {status?.laneSelection?.laneAllocationOperatorLock
                  ? '🔒 operator-locked (autopilot will not touch this)'
                  : 'autopilot-managed (next regime tick may change this)'}
              </span>
            </small>
            {allocRows.map((row, i) => (
              <div key={i} style={{ marginBottom: 2 }}>
                <select value={row.lane} onChange={(e) => updateAllocRow(i, { lane: e.target.value })}>
                  <option value="">(none)</option>
                  {laneAllocationOptions.map((lane) => <option key={lane} value={lane}>{lane}</option>)}
                </select>{' '}
                <input type="number" min={0} max={100} value={row.weight} onChange={(e) => updateAllocRow(i, { weight: e.target.value })} style={{ width: 56 }} />%
                {' '}
                <button type="button" disabled={controlBusy || allocRows.length <= 1} onClick={() => removeAllocRow(i)}>Remove</button>
              </div>
            ))}
            <button type="button" disabled={controlBusy} onClick={addAllocRow}>+ Add lane</button>
            {' '}
            <button type="button" disabled={controlBusy} onClick={applyAllocation}>Apply</button>{' '}
            <button type="button" disabled={controlBusy} onClick={() => void clearAllocation()}>Clear</button>
          </div>}
        </div>
      </section>
      )}

      {!isLivePage && <CrossSectionalReportCard apiPrefix={TESTNET_API_PREFIX} />}

      <main className="testnet-grid">
        {/* ===== Composite 3: Open Positions (2026-07-23 dashboard consolidation) =====
           Merges the old directional-slot table + cross-sectional foundation table +
           single-symbol executor table + mirrored-lane P&L table + mirror-intents table into
           ONE wider table. Halt/error/stale banners (previously above the foundation table only)
           now sit above the WHOLE merged table. Mirror-intents is folded into the directional
           rows on testnet (Intent state column + Copy-to-LIVE action) and cut entirely on /live
           (Copy-to-LIVE was already isLivePage-gated). Basket/foundation rows deliberately keep
           NO close action — closing one leg would leave the rest a naked directional bet, the
           same real-money safety reason the old foundation table never had a close button. */}
        <section id="open-positions" className="testnet-panel testnet-wide-panel">
          <header><span>Open Positions</span><strong>{openPositionsCount} pos</strong></header>
          <p className="tone-measure" style={{ margin: '4px 0', fontSize: 12 }}>
            Directional (operator-controlled, engine mirror) + Basket (cross-sectional hedge, automatic exit only) +
            Single-symbol (stop-protected, own exchange-side stop) in one table. Not every column applies to every
            book — blank cells are expected, not missing data.
          </p>
          {closeResult && <p className={closeResult.ok ? 'tone-healthy' : 'tone-critical'} style={{ margin: '4px 0', fontSize: 12 }}>{closeResult.message}</p>}
          {copyResult && (
            <p className={copyResult.ok ? 'tone-healthy' : 'tone-critical'} style={{ margin: '4px 0', fontSize: 12 }}>
              {copyResult.ok ? '✓' : '✗'} {copyResult.message}
            </p>
          )}
          {xsecInstances.map(({ label, status: xs }) => xs?.openHalted && (
            <p key={`halt-${label}`} className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>⛔ [{label}] {xs.openHalted}</p>
          ))}
          {xsecInstances.map(({ label, status: xs }) => {
            const latest = xs?.entryAttemptAudit?.latest ?? null;
            const legacy = xs?.entryAttemptAudit?.unattributedConsumedSignal ?? null;
            if (latest?.outcome === 'ADMITTED' || (!latest && !legacy)) return null;
            if (latest) {
              const outcome = latest.outcome === 'DEFERRED' ? 'ditunda' : 'dilewati';
              return (
                <p key={`attempt-${label}`} className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
                  ⚠ [{label}] Kandidat basket terakhir {outcome} {timeAgo(latest.at)} — {xsecEntryAttemptStageLabel(latest.stage)}:
                  {' '}{latest.reason ?? 'tanpa alasan tercatat'}.
                  {' '}Long: {latest.longSymbols.join(', ') || '—'} · Short: {latest.shortSymbols.join(', ') || '—'}.
                  {latest.outcome === 'SKIPPED' ? ' Menunggu scan baru.' : ' Akan diperiksa lagi pada tick berikutnya.'}
                </p>
              );
            }
            return (
              <p key={`attempt-legacy-${label}`} className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
                ℹ [{label}] Sinyal terakhir sudah dikonsumsi {timeAgo(legacy!.openedAt)}, tetapi itu terjadi sebelum audit entry dipasang.
                {' '}{legacy!.reason}
              </p>
            );
          })}
          {xsecInstances.map(({ label, status: xs }) => xs?.lastError && (
            <p key={`err-${label}`} className="tone-critical" style={{ margin: '4px 0', fontSize: 12 }}>executor error [{label}]: {xs.lastError}</p>
          ))}
          {xsecExec?.formationEvaluation && (
            <p style={{ margin: '4px 0', fontSize: 12 }} className={xsecExec.formationEvaluation.status === 'EVALUATING' ? 'tone-healthy' : 'tone-muted'}>
              Evaluasi pembentukan FILTERED: {xsecExec.formationEvaluation.closedBaskets}/{xsecExec.formationEvaluation.activationClosedBaskets} closed
              {' · '}{xsecExec.formationEvaluation.status === 'EVALUATING' ? 'aktif (report-only, tidak auto-ganti)' : 'mengumpulkan cohort'}
              {xsecExec.formationEvaluation.status === 'EVALUATING' && ` · ${xsecExec.formationEvaluation.metrics.map((m) => `${m.model}: ${m.meanNetReturnPct == null ? '—' : `${m.meanNetReturnPct.toFixed(3)}%`} net`).join(' | ')}`}
            </p>
          )}
          {xsecInstances.map(({ label, staleSince }) => staleSince && (
            <p key={`stale-${label}`} className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
              ⚠ [{label}] fetch gagal sejak {timeAgo(staleSince)} — data di bawah bisa basi.
            </p>
          ))}
          {singleSymbolPositionsStaleSince && (
            <p className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
              ⚠ single-symbol fetch gagal sejak {timeAgo(singleSymbolPositionsStaleSince)} — baris single-symbol di bawah bisa basi.
            </p>
          )}
          {!isLivePage && orphanIntents.length > 0 && (
            <p className="tone-critical" style={{ margin: '4px 0', fontSize: 12 }}>
              ⚠ {orphanIntents.length} intent belum punya posisi Binance yang cocok (mirror/exchange desync) — tidak muncul di tabel di bawah:{' '}
              {orphanIntents.map((i) => `${i.symbol} (${i.state})`).join(', ')}. Cek reconcileIssues / quarantinedPaperOrders.
            </p>
          )}
          {xsecInstances.some(({ status: xs }) => (xs?.openBaskets ?? []).length > 0) && (
            <div style={{ margin: '6px 0', fontSize: 12 }}>
              {xsecInstances.flatMap(({ label, status: xs }) => (xs?.openBaskets ?? []).map((b) => {
                const tp = xs?.tpNetReturnPct ?? null;
                const net = b.lastNetReturn != null ? b.lastNetReturn * 100 : null;
                const gap = tp != null && net != null ? tp - net : null;
                const hoursLeft = Math.max(0, (b.closesAtMs - Date.now()) / 3600000);
                // Stale = the 5-min TP tick hasn't stamped in >15m. A basket younger than
                // 15m legitimately has no stamp yet — warning there is a false alarm.
                const oldEnough = Date.now() - new Date(b.openedAt).getTime() > 15 * 60_000;
                const stale = b.lastNetAt ? Date.now() - new Date(b.lastNetAt).getTime() > 15 * 60_000 : oldEnough;
                return (
                  <div key={b.basketId} style={{ display: 'flex', gap: 14, padding: '2px 0', flexWrap: 'wrap' }}>
                    <span className="tone-measure">[{label}] {b.basketId}</span>
                    <span>net <strong className={net == null ? '' : net >= 0 ? 'tone-healthy' : 'tone-critical'}>{net == null ? '—' : `${net >= 0 ? '+' : ''}${net.toFixed(3)}%`}</strong></span>
                    <span>TP gap <strong className={gap != null && gap <= 0 ? 'tone-healthy' : ''}>{gap == null ? '—' : gap <= 0 ? 'REACHED — closing' : `${gap.toFixed(3)}% lagi`}</strong></span>
                    <span className="tone-measure">horizon {hoursLeft.toFixed(1)}h lagi</span>
                    {stale && <span className="tone-warning">stamp basi &gt;15m — cek executor</span>}
                  </div>
                );
              }))}
            </div>
          )}

          {/* Mirrored-lane P&L rollup: small always-visible strip, full breakdown behind Disclosure. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, margin: '6px 0', fontSize: 12 }}>
            {(account?.lanes ?? []).length === 0 ? (
              <span className="tone-measure">No mirrored Binance lane exposure.</span>
            ) : account!.lanes.map((lane) => (
              <span key={lane.laneId}>
                <strong>{compactLane(lane.laneId)}</strong>{' '}
                notional {plain(lane.notionalUsd, ' USDT')} · unrealized <span className={tone(lane.unrealizedPnl)}>{signed(lane.unrealizedPnl)}</span>
              </span>
            ))}
          </div>
          <Disclosure summary={`Mirrored Lane P&L — full breakdown (${account?.lanes.length ?? 0} lane${(account?.lanes.length ?? 0) === 1 ? '' : 's'}) ▸`}>
            <div className="testnet-table-wrap">
              <table>
                <thead>
                  <tr><th>Lane</th><th>Source entries</th><th>Symbols</th><th>Notional</th><th>Unrealized</th></tr>
                </thead>
                <tbody>
                  {(account?.lanes ?? []).length === 0 ? (
                    <tr><td colSpan={5}>No mirrored Binance lane exposure.</td></tr>
                  ) : account!.lanes.map((lane) => (
                    <tr key={lane.laneId}>
                      <td>{compactLane(lane.laneId)}</td>
                      <td>{lane.sourceOrderCount}</td>
                      <td>{lane.symbols.join(', ')}</td>
                      <td>{plain(lane.notionalUsd, ' USDT')}</td>
                      <td className={tone(lane.unrealizedPnl)}>{signed(lane.unrealizedPnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>

          <div className="testnet-table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>Book</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th>
                  <th>TP target</th><th>TP gap</th><th>Liq / margin call</th><th>Stop</th><th>R now / peak</th>
                  <th>Basket horizon</th><th>Unrealized</th><th>After fee+slip</th><th>Lev</th><th>Source entries</th><th>Source lane</th><th>Opened</th>
                  {!isLivePage && <th>Intent state</th>}
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {directionalPositions.length === 0 && foundationPositions.length === 0 && singleSymbolLanePositions.length === 0 ? (
                  <tr><td colSpan={!isLivePage ? 20 : 19}>No open positions across any book.</td></tr>
                ) : (
                  <>
                    {directionalPositions.map((p) => {
                      const intent = intentBySymbol.get(p.symbol)!;
                      const qty = Math.abs(p.intentQty ?? p.quantity);
                      const side = p.intentDirection ?? p.direction;
                      const entry = p.intentEntryPrice ?? p.entryPrice;
                      const unreal = p.intentUnrealizedPnl ?? p.unrealizedPnl;
                      const shareFrac = p.quantity > 0 ? qty / p.quantity : 1;
                      const afterCost = unreal - (p.estimatedCloseCostUsd ?? 0) * Math.min(1, shareFrac);
                      return (
                        <tr key={`directional-${p.symbol}`}>
                          <td>Directional</td>
                          <td>{p.symbol}</td>
                          <td className={side === 'SHORT' ? 'tone-warning' : 'tone-healthy'}>{side}</td>
                          <td>{Number(qty.toFixed(8))}</td>
                          <td>{price(entry)}</td>
                          <td>{price(p.markPrice)}</td>
                          <td>{price(p.targetTpPrice)}</td>
                          <td className={tone(p.targetTpGapPct)}>{percent(p.targetTpGapPct)}</td>
                          <td className="tone-critical">{price(p.liquidationPrice)}</td>
                          <td>—</td>
                          <td>—</td>
                          <td>—</td>
                          <td className={tone(unreal)}>{signed(unreal)}</td>
                          <td className={tone(afterCost)}>{signed(afterCost)}</td>
                          <td>{p.leverage}x</td>
                          <td>{p.sourceOrderCount}</td>
                          <td>{p.laneIds.length > 0 ? p.laneIds.map(compactLane).join(', ') : 'unattributed'}</td>
                          <td>—</td>
                          {!isLivePage && <td>{intent.state}</td>}
                          <td>
                            <button
                              type="button"
                              disabled={closeBusy !== null}
                              onClick={() => void closeIntentNow(intent.paperOrderId, p.symbol)}
                            >
                              {closeBusy === intent.paperOrderId ? 'closing…' : 'Close now'}
                            </button>
                            {!isLivePage && (intent.state === 'OPEN' || intent.state === 'TP1_FILLED_BE_SET') && (
                              <>
                                {' '}
                                <button
                                  type="button"
                                  disabled={copyBusy !== null}
                                  onClick={() => void copyToLive(intent.paperOrderId)}
                                  title="Open the EXACT same position (symbol/side/qty/stop/TP geometry) on the REAL mainnet engine. Requires live to be armed."
                                >
                                  {copyBusy === intent.paperOrderId ? 'Copying…' : '→ LIVE'}
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {foundationPositions.map((p) => {
                      const mixed = intentBySymbol.has(p.symbol) && (p.basketQty ?? 0) !== 0;
                      const qty = Math.abs(p.basketQty ?? p.quantity);
                      const side = p.basketQty != null ? (p.basketQty >= 0 ? 'LONG' : 'SHORT') : p.direction;
                      const entry = mixed ? null : p.entryPrice; // basket = multi-leg; blended entry menyesatkan saat nyampur
                      const unreal = p.basketUnrealizedPnl ?? p.unrealizedPnl;
                      const shareFrac = p.quantity > 0 ? qty / p.quantity : 1;
                      const afterCost = unreal - (p.estimatedCloseCostUsd ?? 0) * Math.min(1, shareFrac);
                      return (
                        <tr key={`foundation-${p.symbol}`}>
                          <td>Basket</td>
                          <td>{p.symbol}</td>
                          <td className={side === 'SHORT' ? 'tone-warning' : 'tone-healthy'}>{side}</td>
                          <td>{Number(qty.toFixed(8))}</td>
                          <td>{entry == null ? 'multi-leg' : price(entry)}</td>
                          <td>{price(p.markPrice)}</td>
                          <td>—</td>
                          <td>—</td>
                          <td className="tone-critical">{price(p.liquidationPrice)}</td>
                          <td>—</td>
                          <td>—</td>
                          <td>basket horizon</td>
                          <td className={tone(unreal)}>{signed(unreal)}</td>
                          <td className={tone(afterCost)}>{signed(afterCost)}</td>
                          <td>{p.leverage}x</td>
                          <td>{p.sourceOrderCount}</td>
                          <td>{p.laneIds.length > 0 ? p.laneIds.map(compactLane).join(', ') : 'unattributed'}</td>
                          <td>—</td>
                          {!isLivePage && <td>—</td>}
                          <td className="tone-measure" title="Menutup satu leg basket akan membuat sisa basket jadi taruhan directional telanjang — tidak ada Close now di sini, sama seperti sebelumnya.">auto-exit only</td>
                        </tr>
                      );
                    })}
                    {singleSymbolLanePositions.map((p) => {
                      const risk = Math.abs(p.entryPrice - p.stopPrice);
                      const dirSign = p.direction === 'LONG' ? 1 : -1;
                      const currentR = p.markPrice != null && risk > 0 ? ((p.markPrice - p.entryPrice) / risk) * dirSign : null;
                      const busyKey = `ssle:${p.positionId}`;
                      const hasFixedTarget = p.targetPrice != null && p.targetPrice > 0;
                      const hasMfeProfitLock = p.targetMode === 'MFE_PROFIT_LOCK' && p.mfeProfitLockPrice != null;
                      return (
                        <tr key={`single-${p.positionId}`}>
                          <td>Single-symbol</td>
                          <td>{p.symbol}</td>
                          <td className={p.direction === 'SHORT' ? 'tone-warning' : 'tone-healthy'}>{p.direction}</td>
                          <td>{p.qty}</td>
                          <td>{price(p.entryPrice)}</td>
                          <td>{price(p.markPrice)}</td>
                          <td>{hasFixedTarget ? price(p.targetPrice) : hasMfeProfitLock ? <>
                            <strong>MFE lock {percent((p.mfeProfitLockNetReturn ?? 0) * 100)}</strong>
                            <small style={{ display: 'block' }}>guide {price(p.mfeProfitLockPrice)} · static cap {percent((p.staticTpMaxNetReturn ?? 0) * 100)}</small>
                          </> : 'dynamic exit'}</td>
                          <td className={tone(hasFixedTarget ? p.targetTpGapPct : p.mfeProfitLockGapPct)}>{hasFixedTarget
                            ? percent(p.targetTpGapPct)
                            : hasMfeProfitLock
                              ? `${percent(p.mfeProfitLockGapPct)} to lock`
                              : 'dynamic exit'}</td>
                          <td>—</td>
                          <td>{price(p.stopPrice)}</td>
                          <td className={tone(currentR ?? 0)}>{currentR == null ? '—' : `${currentR.toFixed(2)}R`} / {p.peakFavorableR.toFixed(2)}R</td>
                          <td>—</td>
                          <td className={tone(p.unrealizedPnl ?? 0)}>{p.unrealizedPnl == null ? '—' : signed(p.unrealizedPnl)}</td>
                          <td className={tone(p.unrealizedAfterEstimatedCloseCostUsd)}>
                            {p.unrealizedAfterEstimatedCloseCostUsd == null ? 'exchange position not bound' : signed(p.unrealizedAfterEstimatedCloseCostUsd)}
                          </td>
                          <td>{p.leverage == null ? 'exchange position not bound' : `${p.leverage}x`}</td>
                          <td>—</td>
                          <td>{compactLane(p.laneId)}</td>
                          <td>{new Date(p.openedAt).toLocaleString()}</td>
                          {!isLivePage && <td>—</td>}
                          <td>
                            <button
                              type="button"
                              disabled={closeBusy !== null}
                              onClick={() => void closeSingleSymbolLaneNow(p.positionId, p.symbol, p.laneId)}
                            >
                              {closeBusy === busyKey ? 'closing…' : 'Close now'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ===== Composite 4: Regime & Direction ===== Unified Directional Core (testnet-only,
           unchanged gate) + regime-lane-tree (REGIME_TREE, real preset-apply buttons) + regime-axis
           current score/Entry Decision, expanded-summary by default (the preset buttons write real
           lane allocation, so they stay zero-click) — full per-feature vote table + full 1/3/6h
           forecast chart behind one Disclosure. */}
        {(isLivePage || showTestnetRegimeDirection) && (
        <section className="testnet-panel testnet-wide-panel">
          <header>
            <span>Regime &amp; Direction</span>
            <strong>
              {regimeReport?.latest
                ? `${regimeReport.latest.regime} · BTC ${price(regimeReport.latest.btcPrice)}` +
                  (regimeAxis?.current
                    ? ` · skor ${regimeAxis.current.score >= 0 ? '+' : ''}${regimeAxis.current.score.toFixed(2)} (${regimeAxis.guidance?.zoneLabel ?? '—'})`
                    : '') +
                  ` · ${regimeReport.snapshotCount} snapshots`
                : regimeReport?.enabled === false
                  ? 'engine disabled'
                  : 'loading…'}
            </strong>
          </header>

          {!isLivePage && status?.unifiedOrchestrator && (
            <div style={{ marginBottom: 10 }}>
              <header>
                <span>Unified Directional Core</span>
                <strong className={
                  status.unifiedOrchestrator.brainState === 'LONG' || status.unifiedOrchestrator.brainState === 'SHORT'
                    ? 'tone-healthy'
                    : status.unifiedOrchestrator.brainState.includes('WARNING')
                      ? 'tone-warning'
                      : 'tone-measure'
                }>
                  {status.unifiedOrchestrator.enabled ? status.unifiedOrchestrator.brainState : 'DISABLED'}
                </strong>
              </header>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div>
                  <small>Directional state</small>
                  <strong style={{ display: 'block' }}>
                    active {status.unifiedOrchestrator.activeDirection ?? 'FLAT'} · candidate {status.unifiedOrchestrator.candidateDirection}
                  </strong>
                  <small>confirmation streak {status.unifiedOrchestrator.candidateStreak} · legacy {status.unifiedOrchestrator.legacyExecutorEntryMode}</small>
                </div>
                <div>
                  <small>Execution recipes</small>
                  <strong style={{ display: 'block' }}>
                    {status.unifiedOrchestrator.allowedDirectionalLaneIds.length
                      ? status.unifiedOrchestrator.allowedDirectionalLaneIds.map(compactLane).join(' + ')
                      : 'directional entries paused'}
                  </strong>
                  <small>
                    neutral basket {status.unifiedOrchestrator.neutralProposalAllowed ? 'eligible' : 'blocked'}
                    {status.unifiedOrchestrator.neutralProposalReason ? ` · ${status.unifiedOrchestrator.neutralProposalReason}` : ''}
                  </small>
                </div>
                <div>
                  <small>Last decision</small>
                  <strong style={{ display: 'block' }}>
                    {status.unifiedOrchestrator.lastTrace
                      ? `${status.unifiedOrchestrator.lastTrace.previousState} → ${status.unifiedOrchestrator.lastTrace.nextState}`
                      : 'waiting for controller snapshot'}
                  </strong>
                  <small>{status.unifiedOrchestrator.lastTrace?.reason ?? 'No decision yet'}</small>
                </div>
                <div>
                  <small>Fresh proposal source</small>
                  <strong style={{ display: 'block' }}>
                    {status.unifiedProposalSource?.selectedRecipe
                      ? `${compactLane(status.unifiedProposalSource.selectedRecipe)} · ${status.unifiedProposalSource.proposalCount} proposal(s)`
                      : 'no active recipe'}
                  </strong>
                  <small>
                    {status.unifiedProposalSource?.symbols.length
                      ? `${status.unifiedProposalSource.posture} · ${status.unifiedProposalSource.symbols.join(', ')}`
                      : status.unifiedProposalSource?.reason ?? 'waiting for fresh scanner snapshot'}
                  </small>
                </div>
              </div>
            </div>
          )}

          <p style={{ margin: '4px 0' }} className="tone-measure">
            Report-only: the engine detects the regime + records what it WOULD do every cycle — it does not trade.
            Pick a regime&apos;s preset to prefill the lane allocation above, then press Apply.
            {regimeReport?.latest?.breadth?.advancersPct != null &&
              ` Breadth: ${(regimeReport.latest.breadth.advancersPct * 100).toFixed(0)}% advancers · ${((regimeReport.latest.breadth.percentAboveEma20 ?? 0) * 100).toFixed(0)}% above EMA20 · BTC 24h ${((regimeReport.latest.breadth.btcReturn24h ?? 0) * 100).toFixed(1)}%.`}
          </p>
          <p style={{ margin: '4px 0' }} className="tone-measure">
            &quot;{regimeReport?.latest?.regime ?? 'Regime'}&quot; = pola struktural diskrit (BUKAN penilaian arah) — cocok/tidaknya candle BTC/ETH/breadth dengan salah satu dari 5 pola tetap.
            NO_TRADE artinya tidak ada dari 4 pola directional yang cocok, dan BISA tetap muncul bareng skor Axis yang condong kuat ke satu arah (lihat panel di bawah) — itu bukan bug, keduanya mengukur hal berbeda dari data snapshot yang sama.
          </p>
          {regimeReport?.latest?.regime === 'NO_TRADE' && regimeAxis?.guidance && regimeAxis.guidance.zoneLabel !== 'NEUTRAL' && (
            <p style={{ margin: '4px 0' }} className="tone-warning">
              ⚠ Engine state NO_TRADE, tapi skor Axis saat ini {regimeAxis.current!.score >= 0 ? '+' : ''}{regimeAxis.current!.score.toFixed(2)} → zona {regimeAxis.guidance.zoneLabel} (breadth condong ke {regimeAxis.guidance.holdLane}). {regimeAxis.guidance.note}
            </p>
          )}
          <div className="testnet-table-wrap">
            <table style={{ fontSize: 11 }}>
              <thead>
                <tr><th>Regime</th><th>Engine state</th><th>Strategy lane</th><th>Snapshots</th><th>Allocation preset</th></tr>
              </thead>
              <tbody>
                {REGIME_TREE.map((row) => {
                  const isCurrent = regimeReport?.latest?.regime === row.engineRegime;
                  const count = regimeReport?.regimeCounts?.[row.engineRegime] ?? 0;
                  const flagged = regimeReport?.regimeContradictionFlaggedCounts?.[row.engineRegime] ?? 0;
                  const preset = regimePresets[row.engineRegime] ?? [];
                  return (
                    <tr key={row.engineRegime} style={isCurrent ? { outline: '1px solid #5ce4a6' } : undefined}>
                      <td className={isCurrent ? 'tone-healthy' : undefined}>
                        {isCurrent ? '▶ ' : ''}{row.label}
                      </td>
                      <td>{row.engineRegime}</td>
                      <td title={row.laneNote}>{row.lane}</td>
                      <td title={flagged > 0 ? `${flagged} of these were contradiction-flagged (detectContradictions forced NO_TRADE before this label could route to a lane) — not a clean occurrence of this regime` : undefined}>
                        {count}{flagged > 0 ? ` (${flagged} flagged)` : ''}
                      </td>
                      <td>
                        <button type="button" disabled={controlBusy || preset.length === 0} onClick={() => applyRegimePreset(preset)}>
                          {preset.length > 0
                            ? preset.map((entry) => `${compactLane(entry.laneId)} ${entry.weightPct}%`).join(' + ')
                            : 'loading…'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {regimeReport?.latest && (
            <small className="tone-measure">
              Latest decision: {regimeReport.latest.action}
              {regimeReport.latest.lane ? ` (${regimeReport.latest.lane})` : ''}
              {regimeReport.latest.rejectedBy ? ` — ${regimeReport.latest.rejectedBy}` : ''} at {timeAgo(regimeReport.latest.at)}.
              {regimeReport.transitions.length > 0 &&
                ` Last transition: ${regimeReport.transitions[regimeReport.transitions.length - 1]!.from} → ${regimeReport.transitions[regimeReport.transitions.length - 1]!.to}.`}
            </small>
          )}

          {regimeAxisStaleSince && (
            <p className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
              ⚠ regime axis fetch gagal sejak {timeAgo(regimeAxisStaleSince)} — data di atas bisa basi.
            </p>
          )}
          {/* Canonical Entry Decision callout — always visible, zero-click (mode="entry" renders
             ONLY the ENTRY DECISION SEKARANG block from RegimeAxisChart, same underlying data). */}
          <RegimeAxisChart data={regimeAxis} mode="entry" />

          <Disclosure summary="Per-feature vote table + full 1/3/6h forecast chart ▸">
            {!isLivePage && status?.unifiedOrchestrator?.lastTrace?.votes.length ? (
              <div className="testnet-table-wrap" style={{ marginBottom: 10 }}>
                <table>
                  <thead><tr><th>Feature</th><th>Vote</th><th>Confidence</th><th>Reason</th></tr></thead>
                  <tbody>
                    {status.unifiedOrchestrator.lastTrace.votes.map((vote) => (
                      <tr key={vote.source}>
                        <td>{vote.source}</td>
                        <td className={vote.veto ? 'tone-critical' : vote.direction === 'NEUTRAL' ? 'tone-measure' : 'tone-healthy'}>
                          {vote.veto ? 'VETO' : vote.direction}
                        </td>
                        <td>{Math.round(vote.confidence * 100)}%</td>
                        <td>{vote.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <p style={{ margin: '4px 0' }} className="tone-measure">
              Garis tipis = breadth mentah; garis tebal = EWMA kausal. Area forecast menunjukkan rentang p25–p75 dari momentum
              1/3/6 jam dan successor historis yang paling mirip. Ini membaca state regime, bukan target harga: gunakan `ENTRY DECISION`
              di atas untuk tahu kapan harus menunggu pullback/rejection, lalu tunggu gate simbol RC/RCS benar-benar lolos.
            </p>
            <RegimeAxisChart data={regimeAxis} mode="chart" />
          </Disclosure>
        </section>
        )}

        {/* ===== Composite 5: Single-symbol execution timeline ===== unchanged component, just
           relocated; the Keputusan-trade line + entry/exit reason stay outside the per-symbol
           chart Disclosure (see SingleSymbolPriceTimelineChart above). */}
        {(isLivePage || showTestnetSingleSymbolTimeline) && (
        <section className="testnet-panel testnet-wide-panel">
          <header>
            <span>BTC / ETH / SOL Execution Timeline</span>
            <strong>{singleSymbolTimeline?.enabledForExecution ? 'execution overlay ON' : 'display / waiting'}</strong>
          </header>
          <p style={{ margin: '4px 0' }} className="tone-measure">
            Price path 12 jam dan proyeksi 1/3/6 jam memakai consensus kausal 5m+1h: EMA, RSI, MACD,
            Bollinger, ATR, VWAP, volume, momentum, support/resistance. Ini adalah rentang probabilistik,
            bukan janji harga. Executor tetap perlu sinyal lane fresh, lalu hanya entry searah `ENTER LONG`/`ENTER SHORT`;
            posisi yang sudah terbuka hanya di-close oleh reversal kuat terkonfirmasi atau rule/stop lama. Lihat komposit
            Regime &amp; Direction di atas untuk Entry Decision kanonis.
          </p>
          {singleSymbolTimelineStaleSince && (
            <p className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
              ⚠ timeline fetch gagal sejak {timeAgo(singleSymbolTimelineStaleSince)} — entry BTC/ETH/SOL fail-closed bila execution overlay aktif; stop posisi yang ada tetap jalan.
            </p>
          )}
          <SingleSymbolPriceTimelineChart data={singleSymbolTimeline} positions={account?.positions} />
        </section>
        )}

        {/* ===== Composite 6: Lane Research & Edge Status ===== lane-evaluation + book-proven
           symbols expanded by default (both real-money-relevant); the 3 Tier-1-3 R&D shadow lanes
           (none wired to execution) behind a Disclosure, rendered via the shared LaneMaturityTable. */}
        {(isLivePage || showTestnetLaneResearch) && (
        <section className="testnet-panel testnet-wide-panel">
          <header><span>Lane Research &amp; Edge Status</span><strong>{laneEvaluation.length} lane · {rndLanes.filter(Boolean).length}/3 R&amp;D</strong></header>

          <header><span>Lane evaluation — 9 lane sedang divalidasi</span><strong>{laneEvaluation.length} lane</strong></header>
          <p className="tone-measure" style={{ margin: '4px 0', fontSize: 12 }}>
            Per lane: sisi "Measured" = sinyal paper/shadow (sample lebih cepat besar, sama persis dengan
            /api/shadow/*-report), sisi "Real" = eksekusi uang beneran di instance ini. edgeReady butuh n≥30 DAN
            netAvgR≥0.05 DAN payoff ratio&gt;1.1 — jangan simpulkan apapun sebelum itu tercapai.
          </p>
          <div className="testnet-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lane</th><th>Weight%</th><th>Allowed</th>
                  <th>Real open</th><th>Real closed</th><th>Real net P&amp;L</th>
                  <th>Measured resolved</th><th>Measured open</th><th>Net avg R</th><th>WR</th><th>PF</th><th>Edge ready</th>
                </tr>
              </thead>
              <tbody>
                {laneEvaluation.length === 0 ? (
                  <tr><td colSpan={12}>No lane evaluation data.</td></tr>
                ) : laneEvaluation.map((r) => (
                  <tr key={r.laneId}>
                    <td>{compactLane(r.laneId)}</td>
                    <td>{r.allocationWeightPct}%</td>
                    <td className={r.allowed ? 'tone-healthy' : 'tone-measure'}>{r.allowed == null ? 'n/a' : r.allowed ? 'yes' : 'no'}</td>
                    <td>{r.realOpenCount}</td>
                    <td>{r.realClosedCount}</td>
                    <td className={tone(r.realNetPnlUsd)}>{signed(r.realNetPnlUsd)}</td>
                    <td>{r.measuredResolvedCount ?? '—'}</td>
                    <td>{r.measuredOpenCount ?? '—'}</td>
                    <td className={r.measuredNetAvgR == null ? '' : tone(r.measuredNetAvgR)}>{r.measuredNetAvgR == null ? '—' : `${r.measuredNetAvgR >= 0 ? '+' : ''}${r.measuredNetAvgR.toFixed(3)}R`}</td>
                    <td>{r.measuredWr == null ? '—' : `${Math.round(r.measuredWr * 100)}%`}</td>
                    <td>{r.measuredPf == null ? '—' : r.measuredPf.toFixed(2)}</td>
                    <td className={r.measuredEdgeReady ? 'tone-healthy' : 'tone-measure'}>{r.measuredEdgeReady == null ? 'n/a' : r.measuredEdgeReady ? 'YES' : 'not yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <header style={{ marginTop: 14 }}>
            <span>Book-proven symbols ({pageName} book) — auto-rotation</span>
            <strong>{psle?.summary?.testnetCandidateCells ?? 0}</strong>
          </header>
          <p className="tone-measure" style={{ margin: '4px 0', fontSize: 12 }}>
            Each (symbol × lane × direction) scored on THIS instance&apos;s realized book. testnet-cand = book-credible (drives the live auto-rotation); PROMOTABLE = also headline-confirmed. MAKER / too-good PF/WR auto-excluded.
            {psle?.summary && (
              <> LONG {psle.summary.byDirection.LONG.testnetCandidate} · SHORT {psle.summary.byDirection.SHORT.testnetCandidate} · MIXED {psle.summary.byDirection.MIXED.testnetCandidate} · {psle.summary.promotableCells} promotable{psle.summary.promotableCells === 0 ? ' (all diagnostic-only — headline confirmation accrues over time)' : ''}</>
            )}
          </p>
          <div className="testnet-table-wrap">
            <table>
              <thead>
                <tr><th>Symbol</th><th>Dir</th><th>Lane</th><th>Book avgR</th><th>PF</th><th>WR</th><th>n</th><th>hl</th><th>Stage</th></tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = (psle?.cells ?? [])
                    .filter((c) => c.testnetCandidate || c.promotable)
                    .sort((a, b) => (b.netAvgR ?? -9) - (a.netAvgR ?? -9));
                  if (rows.length === 0) return <tr><td colSpan={9}>No book-proven symbols yet — accruing.</td></tr>;
                  return rows.map((c) => (
                    <tr key={`${c.laneId}:${c.symbol}:${c.direction}`}>
                      <td>{c.symbol.replace(/USDT$/, '')}</td>
                      <td className={c.direction === 'LONG' ? 'tone-healthy' : 'tone-critical'}>{c.direction}</td>
                      <td>{compactLane(c.laneId)}</td>
                      <td className={tone(c.netAvgR ?? 0)}>{c.netAvgR == null ? '—' : `${c.netAvgR >= 0 ? '+' : ''}${c.netAvgR.toFixed(3)}R`}</td>
                      <td>{c.pf == null ? '—' : c.pf.toFixed(2)}</td>
                      <td>{c.wr == null ? '—' : `${Math.round(c.wr * 100)}%`}</td>
                      <td>{c.closed}</td>
                      <td className={c.headlineClosed > 0 ? 'tone-healthy' : ''}>{c.headlineClosed}</td>
                      <td>{c.promotable ? <strong className="tone-healthy">PROMOTABLE</strong> : <span className="tone-measure">testnet-cand</span>}</td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>

          <Disclosure summary={`R&D lanes baru (Tier 1-3, 2026-07-10) — semua report-only (${rndLanes.filter(Boolean).length}/3) ▸`}>
            <p className="tone-measure" style={{ margin: '4px 0 8px', fontSize: 12 }}>
              3 engine baru dari audit strategi GPT-5.6: belum ada satupun yang di-wire ke eksekusi
              real atau lane allocation — cuma ngumpulin sample lewat polling dashboard ini. edgeReady
              butuh n≥30 DAN netAvgR≥0.05 DAN payoff ratio&gt;1.1, sama seperti semua lane lain.
            </p>
            <LaneMaturityTable rows={rndLaneRows} />
          </Disclosure>
        </section>
        )}

        {/* ===== Composite 7: Lane Performance Timeline ===== merges LanePerformanceChart with the
           old closed-lane-performance table; ported that table's one non-duplicate field
           ("Last close" time-ago, from account.closedLanes[].lastClosedAt) into this merged
           table's row BEFORE cutting the old separate table below. Kept expanded (not a
           Disclosure) — this section stays prominent per spec. */}
        <section className="testnet-panel testnet-wide-panel testnet-performance-panel">
          <header>
            <div>
              <span>Lane performance timeline</span>
              <strong className={tone(chartTotal)}>
                {signed(chartTotal)} · {laneSeries?.viewLabel ?? 'Loading'} · {laneSeries?.periodLabel ?? 'period'} · {laneSeries?.bucketLabel ?? 'buckets'}
              </strong>
            </div>
            <div className="testnet-filterbar">
              <label>
                Mode
                <select value={performanceView} onChange={(event) => setPerformanceView(event.target.value)}>
                  {PERFORMANCE_VIEW_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              {performanceView === 'hourly' && (
                <label>
                  Date
                  <input type="date" value={performanceDay} onChange={(event) => setPerformanceDay(event.target.value)} />
                </label>
              )}
              {(performanceView === 'daily' || performanceView === 'weekly') && (
                <label>
                  Month
                  <input type="month" value={performanceMonth} onChange={(event) => setPerformanceMonth(event.target.value)} />
                </label>
              )}
              {(performanceView === 'monthly' || performanceView === 'yearly') && (
                <label>
                  {performanceView === 'yearly' ? 'End year' : 'Year'}
                  <input type="number" min="2020" max="2100" value={performanceYear} onChange={(event) => setPerformanceYear(event.target.value)} />
                </label>
              )}
              <label>
                Regime
                <select value={performanceRegime} onChange={(event) => setPerformanceRegime(event.target.value)}>
                  {regimeOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </header>
          {!isLivePage && timelineSeries?.crossSectionalAuditBeforePeriod && (
            <p className="tone-measure" style={{ margin: '7px 0 0', fontSize: 12 }}>
              Histori cross-basket sebelum periode ini: {timelineSeries.crossSectionalAuditBeforePeriod.closedBaskets} closed basket · {signed(timelineSeries.crossSectionalAuditBeforePeriod.totalNetPnlUsd)} · terakhir {timeAgo(timelineSeries.crossSectionalAuditBeforePeriod.lastClosedAt)}. Tidak dicampur ke kurva {timelineSeries.periodLabel}; pilih tanggal close-nya untuk melihat titik chart.
            </p>
          )}
          {/* The timeline plots lane CURVES; this is the per-position record behind the directional
              ones — which exit closed each trade, and the same seven-hypothesis verdict per close.
              Linked rather than inlined: it is a full ledger, not a summary, and it lives on the API
              so no dashboard bundle carries it. Testnet-only, same as the note above. */}
          {!isLivePage && (
            <p className="tone-measure" style={{ margin: '5px 0 0', fontSize: 12 }}>
              <a
                href={`${pageApiPrefix}/live/directional-overlay-counterfactual/view`}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'inherit' }}
              >
                Catatan trade directional — tiap posisi, ditutup oleh apa, evaluasi per posisi →
              </a>
            </p>
          )}
          <LanePerformanceChart series={timelineSeries} />
          <div className="testnet-table-wrap testnet-performance-table">
            <table>
              <thead>
                <tr><th>Lane</th><th>Closed</th><th>W / L</th><th>WR</th><th>Realized</th><th>Fees</th><th>Regime mix</th><th>Symbols</th><th>Last close</th></tr>
              </thead>
              <tbody>
                {(timelineSeries?.lanes ?? []).length === 0 ? (
                  <tr><td colSpan={9}>No closed lane performance in this period/regime filter.</td></tr>
                ) : timelineSeries!.lanes.map((lane) => (
                  <tr key={lane.laneId}>
                    <td>{compactLane(lane.laneId)}</td>
                    <td>{lane.closedCount}</td>
                    <td>{lane.wins} / {lane.losses}</td>
                    <td>{formatWinRate(lane.winRatePct)}</td>
                    <td className={tone(lane.realizedPnlUsd)}>{signed(lane.realizedPnlUsd)}</td>
                    <td>{plain(lane.feesUsd, ' USDT')}</td>
                    <td>{lane.regimes.map((regime) => `${regime.bucket.toLowerCase()} ${regime.count}`).join(', ') || 'n/a'}</td>
                    <td>{lane.symbols.join(', ') || 'n/a'}</td>
                    <td>{timeAgo(account?.closedLanes?.find((cl) => cl.laneId === lane.laneId)?.lastClosedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

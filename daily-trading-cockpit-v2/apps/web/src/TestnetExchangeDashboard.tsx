import { useEffect, useRef, useState } from 'react';
import './neural-mindmap.css';

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
  regimeOptions: Array<{ value: string; label: string }>;
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
  markPrice: number | null;
  unrealizedPnl: number | null;
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
  current: { at: string; score: number; regime: string } | null;
  slopePerHour: number | null;
  etaToNeutralHours: number | null;
  slopeWindowHours: number;
  zones?: Array<{ from: number; to: number; label: string; laneHint: string }>;
  perRegimeMedianScore?: Record<string, number>;
  projection?: Array<{ at: string; score: number }>;
  guidance?: {
    zoneLabel: string;
    direction: 'MENUJU_NETRAL' | 'MENJAUH_NETRAL' | 'FLAT';
    holdLane: string;
    switchToLane: string | null;
    switchAtScore: number | null;
    etaToSwitchHours: number | null;
    note: string;
  } | null;
  note: string;
};

/** Distance-to-neutral timeline: signed breadth composite (+1 bullish … 0 neutral … −1 bearish)
 *  over the regime engine's snapshot history. The middle dashed line IS the neutral zone the
 *  operator asked about — the closer the line drifts to it, the closer the regime is to flipping. */
function RegimeAxisChart({ data }: { data: RegimeAxisTimelineData | null }) {
  const width = 920;
  const height = 220;
  const padding = 34;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  if (!data || data.points.length < 2 || !data.current) {
    return (
      <div className="testnet-chart-empty">
        <strong>No regime history yet</strong>
        <p>Grafik muncul setelah regime engine mengumpulkan beberapa snapshot (REGIME_ENGINE_ENABLED=1).</p>
      </div>
    );
  }
  const pts = data.points;
  const proj = data.projection ?? [];
  const t0 = new Date(pts[0]!.at).getTime();
  const t1 = new Date((proj.length > 0 ? proj[proj.length - 1]! : pts[pts.length - 1]!).at).getTime();
  const span = Math.max(1, t1 - t0);
  // Fixed y-domain [-1, +1]: the score is bounded by construction, and a fixed frame keeps the
  // "distance to the middle line" visually comparable across refreshes.
  const xy = (p: { at: string; score: number }) => ({
    x: padding + ((new Date(p.at).getTime() - t0) / span) * plotWidth,
    y: padding + ((1 - p.score) / 2) * plotHeight,
  });
  const path = pts.map((p, i) => {
    const { x, y } = xy(p);
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
  const zeroY = padding + plotHeight / 2;
  const cur = xy(data.current);
  const curColor = data.current.score > 0.02 ? '#5ce4a6' : data.current.score < -0.02 ? '#ff6b6b' : '#f0b54b';
  const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const eta = data.etaToNeutralHours;
  return (
    <div className="testnet-chart-wrap">
      <svg className="testnet-lane-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Regime distance-to-neutral timeline">
        <rect x="0" y="0" width={width} height={height} rx="12" className="testnet-chart-bg" />
        {(data.zones ?? []).map((z) => {
          // Zone band: y for score s = padding + ((1 - s) / 2) * plotHeight (top = +1).
          const yTop = padding + ((1 - z.to) / 2) * plotHeight;
          const yBot = padding + ((1 - z.from) / 2) * plotHeight;
          const bull = (z.from + z.to) / 2 > 0.05;
          const bear = (z.from + z.to) / 2 < -0.05;
          const fill = bull ? 'rgba(92,228,166,0.06)' : bear ? 'rgba(255,107,107,0.06)' : 'rgba(240,181,75,0.05)';
          return (
            <g key={z.label}>
              <rect x={padding} y={yTop} width={plotWidth} height={Math.max(1, yBot - yTop)} fill={fill} />
              <text x={width - padding - 4} y={(yTop + yBot) / 2 + 3} textAnchor="end" style={{ fill: bull ? '#5ce4a6' : bear ? '#ff6b6b' : '#f0b54b', font: '600 9px/1 "IBM Plex Mono", monospace', opacity: 0.85 }}>
                {z.label} · {z.laneHint}
              </text>
            </g>
          );
        })}
        {[0.25, 0.75].map((ratio) => (
          <line key={ratio} x1={padding} x2={width - padding} y1={padding + ratio * plotHeight} y2={padding + ratio * plotHeight} className="testnet-chart-grid" />
        ))}
        <line x1={padding} x2={width - padding} y1={zeroY} y2={zeroY} className="testnet-chart-zero" />
        <text x={padding} y={padding - 8} className="testnet-chart-axis">BULLISH +1</text>
        <text x={padding} y={zeroY - 6} className="testnet-chart-axis">NEUTRAL 0</text>
        <text x={padding} y={height - padding + 16} className="testnet-chart-axis">BEARISH −1</text>
        <path d={path} fill="none" stroke="#6fb3d6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {proj.length > 0 && (
          <path
            d={[data.current, ...proj].map((p, i) => { const { x, y } = xy(p!); return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`; }).join(' ')}
            fill="none" stroke={curColor} strokeWidth="1.5" strokeDasharray="5 4" opacity="0.7"
          />
        )}
        {data.guidance?.switchAtScore != null && data.guidance.etaToSwitchHours != null && data.current && (() => {
          // Titik switch: proyeksi menembus batas netral (±0.12) — di sinilah ganti lane.
          const swX = padding + (((new Date(data.current.at).getTime() + data.guidance.etaToSwitchHours * 3_600_000) - t0) / span) * plotWidth;
          const swY = padding + ((1 - data.guidance.switchAtScore) / 2) * plotHeight;
          if (swX > width - padding) return null;
          return (
            <g>
              <circle cx={swX} cy={swY} r="6" fill="none" stroke="#f0b54b" strokeWidth="2" strokeDasharray="2 2" />
              <text x={Math.min(swX + 8, width - 150)} y={swY - 8} style={{ fill: '#f0b54b', font: '600 10px/1 "IBM Plex Mono", monospace' }}>
                titik switch (~{data.guidance.etaToSwitchHours}j)
              </text>
            </g>
          );
        })()}
        <circle cx={cur.x} cy={cur.y} r="5" fill={curColor} stroke="#071016" strokeWidth="1.5" />
        <text x={padding} y={height - 6} className="testnet-chart-time">{timeLabel(pts[0]!.at)}</text>
        <text x={width - padding} y={height - 6} className="testnet-chart-time end">{timeLabel(pts[pts.length - 1]!.at)}</text>
      </svg>
      <div className="testnet-chart-legend">
        <div>
          <i style={{ background: curColor }} />
          <span>sekarang</span>
          <strong style={{ color: curColor }}>{data.current.score >= 0 ? '+' : ''}{data.current.score.toFixed(2)}</strong>
        </div>
        <div><span>{data.current.regime}</span></div>
        {data.slopePerHour != null && (
          <div><span>drift {data.slopeWindowHours}h</span><strong>{data.slopePerHour >= 0 ? '+' : ''}{data.slopePerHour.toFixed(3)}/jam</strong></div>
        )}
        <div style={{ maxWidth: 260 }}>
          <span>
            {eta != null
              ? `menyentuh netral ~${eta.toFixed(1)} jam lagi KALAU laju saat ini bertahan (ekstrapolasi, bukan ramalan)`
              : 'tidak sedang bergerak menuju netral pada laju yang berarti'}
          </span>
        </div>
      </div>
      {data.guidance && (
        <div style={{ margin: '8px 4px 0', padding: '8px 12px', border: '1px solid rgba(240,181,75,0.35)', borderRadius: 8, fontSize: 12, lineHeight: 1.55 }}>
          <strong style={{ color: '#f0b54b' }}>
            PEGANG {data.guidance.holdLane.replace('CG_WIDE_', '').replace('CROSS_SECTIONAL_MARKET_NEUTRAL', 'CROSS-SECTIONAL')}
          </strong>
          {data.guidance.switchToLane && data.guidance.switchAtScore != null && (
            <>
              {' '}· switch ke <strong>{data.guidance.switchToLane.replace('CG_WIDE_', '')}</strong> HANYA setelah skor menembus{' '}
              <strong>{data.guidance.switchAtScore > 0 ? '+' : ''}{data.guidance.switchAtScore}</strong>
              {data.guidance.etaToSwitchHours != null ? ` (~${data.guidance.etaToSwitchHours} jam lagi di laju sekarang — ekstrapolasi)` : ' (belum ada ETA — arah belum menuju batas itu)'}
            </>
          )}
          <div style={{ opacity: 0.8, marginTop: 4 }}>{data.guidance.note}</div>
        </div>
      )}
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
  const pageApiPrefix = isLivePage ? LIVE_API_PREFIX : TESTNET_API_PREFIX;
  const pageName = isLivePage ? 'LIVE' : 'Testnet';
  const pageSubtitle = isLivePage ? 'Binance mainnet mirror' : 'Binance testnet mirror';
  const pageScope = isLivePage ? 'Exchange-only LIVE view' : 'Exchange-only testnet view';
  const walletLabel = isLivePage ? 'mainnet wallet' : 'testnet wallet';
  const allocationLabel = isLivePage ? 'LIVE lane allocation' : 'Testnet lane allocation';
  const [account, setAccount] = useState<LiveAccount | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [laneSeries, setLaneSeries] = useState<LanePerformanceSeries | null>(null);
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
  const xsecExecLoadSeqRef = useRef(0);
  const xsecExecTrendLoadSeqRef = useRef(0);
  const xsecExecMixedLoadSeqRef = useRef(0);
  const laneEvaluationLoadSeqRef = useRef(0);
  const rndLanesLoadSeqRef = useRef(0);
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
  const [regimeReport, setRegimeReport] = useState<RegimeEngineReport | null>(null);
  const [regimePresets, setRegimePresets] = useState<RegimePresetsMap>({});
  const [regimeAxis, setRegimeAxis] = useState<RegimeAxisTimelineData | null>(null);
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
  const [laneEvaluation, setLaneEvaluation] = useState<LaneEvaluationRow[]>([]);
  const [rndLanes, setRndLanes] = useState<RndLaneReport[]>([]);
  const [psle, setPsle] = useState<PsleReport | null>(null);
  const [headlineLaneOptions, setHeadlineLaneOptions] = useState<string[]>([]);
  const laneAllocationOptions = Array.from(new Set(
    [...LIVE_LANE_OPTIONS, ...headlineLaneOptions, ...allocRows.map((r) => r.lane)].filter(Boolean),
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
  const toggleManualMode = () =>
    control(
      `${pageApiPrefix}/live/manual-mode`,
      { enabled: !(status?.laneSelection?.manualSelectorMode === true), confirm: 'SET_MANUAL_MODE' },
      'Manual selector mode',
      loadExchangeOnly,
    );

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

  async function copyToLive(paperOrderId: string) {
    if (copyBusy) return;
    setCopyBusy(paperOrderId);
    setCopyResult(null);
    try {
      const response = await fetch(`${TESTNET_API_PREFIX}/live/copy-to-live`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paperOrderId }),
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
      const [nextStatus, nextAccount, nextLaneSeries] = await Promise.all([
        fetchJson<LiveStatus>(`${pageApiPrefix}/live/status`),
        fetchJson<LiveAccount>(`${pageApiPrefix}/live/account`),
        fetchJson<LanePerformanceSeries>(`${pageApiPrefix}/live/lane-performance-series?${seriesParams.toString()}`),
      ]);
      if (seq !== exchangeLoadSeqRef.current) return; // a newer call already superseded this one
      setStatus(nextStatus);
      setAccount(nextAccount);
      setLaneSeries(nextLaneSeries);
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
    const timer = window.setInterval(() => {
      void loadHeadlineLaneOptions();
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
      void loadXsecExec();
      void loadXsecExecTrend();
      void loadXsecExecMixed();
      void loadSingleSymbolPositions();
      void loadLaneEvaluation();
    void loadRndLanes();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const stale = lastLoadedAt ? Date.now() - new Date(lastLoadedAt).getTime() > REFRESH_MS * 2.5 : true;
  const healthTone = status?.armed ? 'tone-healthy' : status?.health?.lastTickError ? 'tone-warning' : 'tone-measure';
  const totalSourceEntries = account?.positions.reduce((sum, position) => sum + position.sourceOrderCount, 0) ?? 0;
  const regimeOptions = laneSeries?.regimeOptions ?? FALLBACK_REGIME_OPTIONS;
  const chartTotal = laneSeries?.lanes.reduce((sum, lane) => sum + lane.realizedPnlUsd, 0) ?? 0;
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
    laneIds.includes('SHORT_FADE_EXHAUSTION_CROWDED') ||
    laneIds.includes('INTRADAY_MOMENTUM_BREAKOUT_LONG') ||
    laneIds.includes('REGIME_COMPOSITE_CONFIRMATION_LONG') ||
    laneIds.includes('PANIC_WASHOUT_RECLAIM_LONG') ||
    laneIds.some((id) => id.startsWith('COMPOSITE_ESTIMATOR_BIDI_'));

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

      <section className="neural-statusbar testnet-statusbar">
        <div>
          <span>Execution</span>
          <strong className={healthTone}>{status?.armed ? 'Armed' : 'Disarmed'}</strong>
          <small>{status?.env ?? 'loading'} · {status?.enabled === false ? 'disabled' : 'live engine'}</small>
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
            const basketsAllTime = ['CROSS_SECTIONAL_MARKET_NEUTRAL', 'CROSS_SECTIONAL_TREND', 'CROSS_SECTIONAL_MIXED']
              .reduce((sum, laneId) => sum + (account?.closedLanes?.find((l) => l.laneId === laneId)?.realizedPnlUsd ?? 0), 0);
            const singleSymbolAllTime = account?.singleSymbolExecutorRealizedPnlUsd?.allTime;
            const mirrorAllTime = status?.totalRealizedPnlUsd;
            const allTime = mirrorAllTime != null ? mirrorAllTime + basketsAllTime + (singleSymbolAllTime ?? 0) : undefined;
            const mirrorToday = status?.closedToday?.realizedPnlUsd;
            // 2026-07-11: was FILTERED-only (xsecExec?.dailyRealizedUsd) — TREND/MIXED's own daily
            // realized P&L never moved this "today" figure even though basketsAllTime above already
            // correctly folds all 3 in via account.closedLanes.
            const basketsToday = [xsecExec?.dailyRealizedUsd, xsecExecTrend?.dailyRealizedUsd, xsecExecMixed?.dailyRealizedUsd]
              .reduce<number | undefined>((sum, v) => (v != null ? (sum ?? 0) + v : sum), undefined);
            const singleSymbolToday = account?.singleSymbolExecutorRealizedPnlUsd?.today;
            const today = mirrorToday != null || basketsToday != null || singleSymbolToday != null
              ? (mirrorToday ?? 0) + (basketsToday ?? 0) + (singleSymbolToday ?? 0)
              : undefined;
            return (
              <>
                <strong className={tone(today)}>{signed(today)}</strong>
                <small>mirror {signed(mirrorToday)} · baskets {signed(basketsToday)} · single-symbol {signed(singleSymbolToday)} · all-time {signed(allTime)}</small>
              </>
            );
          })()}
        </div>
        <div>
          <span>Open TP/SL orders</span>
          <strong>{account?.openOrderCount ?? 'n/a'}</strong>
          <small>{status?.openIntents?.length ?? 0} live intents · exits can be 2x positions</small>
        </div>
      </section>

      {!isLivePage && status?.unifiedOrchestrator && (
        <section className="testnet-panel">
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
          {status.unifiedOrchestrator.lastTrace?.votes.length ? (
            <div className="testnet-table-wrap" style={{ marginTop: 10 }}>
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
        </section>
      )}

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
            <small style={{ display: 'block', marginBottom: 4 }}>{pageName} engine{isLivePage ? ' (real money)' : ''}</small>
            <button type="button" disabled={controlBusy || status?.armed === true} onClick={armCurrent}>Arm</button>{' '}
            <button type="button" disabled={controlBusy || status?.armed !== true} onClick={() => void disarmCurrent()}>Disarm</button>
          </div>
          <div>
            <small style={{ display: 'block', marginBottom: 4 }}>
              New entries <strong className={status?.newEntries?.allowed ? 'tone-healthy' : 'tone-critical'}>
                {status?.newEntries?.drainActive ? 'DRAINED' : status?.newEntries?.strategyGate?.allowed ? 'OPEN' : 'REGIME BLOCKED'}
              </strong>
            </small>
            <button type="button" disabled={controlBusy} onClick={toggleEntryDrain}>
              {status?.newEntries?.drainActive ? 'Resume new entries' : 'Pause new entries'}
            </button>
            <small style={{ display: 'block', maxWidth: 340, marginTop: 4 }}>
              {status?.newEntries?.pauseReason ?? status?.newEntries?.strategyGate?.reason ?? 'No entry blocker'}; exits remain managed.
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
              onClick={() => void toggleManualMode()}
              title={
                status?.laneSelection?.manualSelectorMode
                  ? 'Manual ON: trades exactly the lane allocation selector, bypassing the book overlay + regime direction-gate. Click to return to SMART.'
                  : 'SMART ON: book overlay + regime direction-gate active. Click to switch to MANUAL (raw selector, bypass smart logic).'
              }
            >
              {status?.laneSelection?.manualSelectorMode ? 'Switch to SMART' : 'Switch to MANUAL (bypass)'}
            </button>
          </div>
          <div>
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
          </div>
        </div>
      </section>

      <section className="testnet-panel">
        <header>
          <span>Regime Engine → Lane Tree</span>
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
          <table>
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
      </section>

      <section className="testnet-panel">
        <header>
          <span>Regime Axis — jarak ke netral</span>
          <strong>
            {regimeAxis?.current
              ? `${regimeAxis.current.regime} · skor ${regimeAxis.current.score >= 0 ? '+' : ''}${regimeAxis.current.score.toFixed(2)}`
              : 'loading…'}
          </strong>
        </header>
        <p style={{ margin: '4px 0' }} className="tone-measure">
          Skor = komposit input breadth yang dipakai regime engine sendiri (advancers %, % di atas EMA20, return BTC 24h).
          Garis tengah putus-putus = zona NETRAL: semakin garis mendekat ke tengah, semakin dekat regime ke perubahan.
          Estimasi waktu adalah ekstrapolasi laju saat ini — bukan ramalan.
        </p>
        {regimeAxisStaleSince && (
          <p className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
            ⚠ fetch gagal sejak {timeAgo(regimeAxisStaleSince)} — data di atas bisa basi.
          </p>
        )}
        <RegimeAxisChart data={regimeAxis} />
      </section>

      {error && (
        <div className="neural-error">
          <strong>Exchange link interrupted</strong>
          <span>{error}. Last visible Binance state remains on screen.</span>
        </div>
      )}

      <main className="testnet-grid">
        <section className="testnet-panel testnet-hero">
          <div>
            <span>Scope</span>
            <strong>{pageScope}</strong>
            <p>This page reads only `{pageApiPrefix}/live/status` and `{pageApiPrefix}/live/account`. Binance positions are netted per symbol, so one exchange position can contain multiple source entries from mirrored paper orders.</p>
          </div>
          <div className="testnet-kpis">
            <div><span>Wallet</span><strong>{plain(account?.walletBalance, ' USDT')}</strong></div>
            <div><span>Clock skew</span><strong>{status?.health?.clockSkewMs == null ? 'n/a' : `${Math.round(status.health.clockSkewMs)} ms`}</strong></div>
            <div><span>Last tick</span><strong>{timeAgo(status?.health?.lastTickAt)}</strong></div>
            <div><span>Loss streak</span><strong>{status?.consecutiveLosses ?? 0}</strong></div>
          </div>
        </section>

        {status?.health?.lastTickError && (
          <section className="testnet-panel testnet-warning">
            <span>Live engine warning</span>
            <strong>{status.health.lastTickError}</strong>
            <p>The page is still exchange-only; this warning is from the Binance mirror engine, not diagnostics.</p>
          </section>
        )}

        {status?.killedAt && (
          <section className="testnet-panel testnet-warning">
            <span>Kill switch latched</span>
            <strong>{status.killReason ?? 'Manual or risk kill-switch engaged'}</strong>
            <p>Latched at {new Date(status.killedAt).toLocaleString()}.</p>
          </section>
        )}

        {(() => {
          // Split (2026-07-07 operator ask): the directional slot (engine intents, operator-
          // closeable) vs the cross-sectional foundation (basket-managed, exits automatic).
          // A netted symbol carrying BOTH belongs in the directional table — the Close button
          // there flattens only the engine's share, basket legs stay open.
          const intentBySymbol = new Map((status?.openIntents ?? []).map((i) => [i.symbol, i]));
          const positions = account?.positions ?? [];
          // 2026-07-08 operator ("pisahkan unrealized antara cross sectional dan directional"):
          // a netted symbol carrying BOTH books now appears in BOTH tables, each showing ITS OWN
          // qty/entry/P&L (computed from its own entries) — never the exchange's blended row.
          const directional = positions.filter((p) => intentBySymbol.has(p.symbol));
          // 2026-07-09: single-symbol-executor positions excluded from foundation — they share the
          // basketQty/basketUnrealizedPnl fields with basket legs, but each is its own real
          // single-symbol position (own exchange-side stop, no sibling leg), not a basket hedge.
          const foundation = positions.filter(
            (p) => !isSingleSymbolExecutorPosition(p.laneIds) && ((p.basketQty ?? 0) !== 0 || (isCrossSectionalPosition(p.laneIds) && !intentBySymbol.has(p.symbol))),
          );
          // 2026-07-11: the 3 CrossSectionalExecutor instances each have independent halted/error/
          // openBaskets state — surface all 3, not just FILTERED, so a stuck TREND or MIXED instance
          // is visible here instead of silently invisible.
          const xsecInstances: Array<{ label: string; status: XsecExecStatus | null }> = [
            { label: 'FILTERED', status: xsecExec },
            { label: 'TREND', status: xsecExecTrend },
            { label: 'MIXED', status: xsecExecMixed },
          ];
          const row = (position: (typeof positions)[number], closeable: boolean) => {
            const book = closeable ? 'directional' : 'foundation';
            const mixed = intentBySymbol.has(position.symbol) && (position.basketQty ?? 0) !== 0;
            const qty = closeable
              ? Math.abs(position.intentQty ?? position.quantity)
              : Math.abs(position.basketQty ?? position.quantity);
            const side = closeable
              ? (position.intentDirection ?? position.direction)
              : (position.basketQty != null ? (position.basketQty >= 0 ? 'LONG' : 'SHORT') : position.direction);
            const entry = closeable
              ? (position.intentEntryPrice ?? position.entryPrice)
              : mixed ? null : position.entryPrice; // basket = multi-leg; blended entry menyesatkan saat nyampur
            const unreal = closeable
              ? (position.intentUnrealizedPnl ?? position.unrealizedPnl)
              : (position.basketUnrealizedPnl ?? position.unrealizedPnl);
            const shareFrac = position.quantity > 0 ? qty / position.quantity : 1;
            const afterCost = unreal - (position.estimatedCloseCostUsd ?? 0) * Math.min(1, shareFrac);
            return (
            <tr key={`${book}-${position.symbol}`}>
              <td>{position.symbol}</td>
              <td className={side === 'SHORT' ? 'tone-warning' : 'tone-healthy'}>{side}</td>
              <td>{Number(qty.toFixed(8))}</td>
              <td>{entry == null ? 'multi-leg' : price(entry)}</td>
              <td>{price(position.markPrice)}</td>
              <td>{closeable ? price(position.targetTpPrice) : 'basket horizon'}</td>
              <td className={tone(position.targetTpGapPct)}>{closeable ? percent(position.targetTpGapPct) : 'timed'}</td>
              <td className="tone-critical">{price(position.liquidationPrice)}</td>
              <td className={tone(unreal)}>{signed(unreal)}</td>
              <td className={tone(afterCost)}>{signed(afterCost)}</td>
              <td>{position.leverage}x</td>
              <td>{position.sourceOrderCount}</td>
              <td>{position.laneIds.length > 0 ? position.laneIds.map(compactLane).join(', ') : 'unattributed'}</td>
              {closeable && (
                <td>
                  <button
                    type="button"
                    disabled={closeBusy !== null}
                    onClick={() => void closeIntentNow(intentBySymbol.get(position.symbol)!.paperOrderId, position.symbol)}
                  >
                    {closeBusy === intentBySymbol.get(position.symbol)!.paperOrderId ? 'closing…' : 'Close now'}
                  </button>
                </td>
              )}
            </tr>
            );
          };
          const headCells = (withClose: boolean) => (
            <tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>TP target</th><th>TP gap</th><th>Liq / margin call</th><th>Unrealized</th><th>After fee+slip</th><th>Lev</th><th>Source entries</th><th>Mirrored lane</th>{withClose && <th>Manual</th>}</tr>
          );
          return (
            <>
              <section className="testnet-panel">
                <header><span>Directional slot — operator-controlled</span><strong>{directional.length} pos</strong></header>
                <p className="tone-measure" style={{ margin: '4px 0', fontSize: 12 }}>
                  Posisi dari lane-allocation selector (engine mirror). &quot;Close now&quot; menutup HANYA porsi engine di simbol itu —
                  leg basket cross-sectional di simbol yang sama tetap terbuka. Order market real, konfirmasi dulu.
                </p>
                {closeResult && <p className={closeResult.ok ? 'tone-healthy' : 'tone-critical'} style={{ margin: '4px 0', fontSize: 12 }}>{closeResult.message}</p>}
                <div className="testnet-table-wrap">
                  <table>
                    <thead>{headCells(true)}</thead>
                    <tbody>
                      {directional.length === 0 ? (
                        <tr><td colSpan={14}>No directional positions — pilih lane di allocation selector untuk membuka slot ini.</td></tr>
                      ) : directional.map((p) => row(p, true))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="testnet-panel">
                <header><span>Cross-sectional foundation — automatic</span><strong>{foundation.length} pos</strong></header>
                <p className="tone-measure" style={{ margin: '4px 0', fontSize: 12 }}>
                  Basket hedge (long-top / short-bottom). Exit otomatis: profit-bank {xsecExec?.tpNetReturnPct != null ? `${xsecExec.tpNetReturnPct.toFixed(2)}%` : 'net-target'} atau horizon 24 jam — tidak ada tombol close
                  per posisi di sini karena menutup satu leg membuat sisa basket jadi taruhan directional telanjang.
                </p>
                {xsecInstances.map(({ label, status: xs }) => xs?.openHalted && (
                  <p key={`halt-${label}`} className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>⛔ [{label}] {xs.openHalted}</p>
                ))}
                {xsecInstances.map(({ label, status: xs }) => xs?.lastError && (
                  <p key={`err-${label}`} className="tone-critical" style={{ margin: '4px 0', fontSize: 12 }}>executor error [{label}]: {xs.lastError}</p>
                ))}
                {[
                  { label: 'FILTERED', staleSince: xsecExecStaleSince },
                  { label: 'TREND', staleSince: xsecExecTrendStaleSince },
                  { label: 'MIXED', staleSince: xsecExecMixedStaleSince },
                ].map(({ label, staleSince }) => staleSince && (
                  <p key={`stale-${label}`} className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
                    ⚠ [{label}] fetch gagal sejak {timeAgo(staleSince)} — data di bawah bisa basi.
                  </p>
                ))}
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
                <div className="testnet-table-wrap">
                  <table>
                    <thead>{headCells(false)}</thead>
                    <tbody>
                      {foundation.length === 0 ? (
                        <tr><td colSpan={13}>No open basket positions.</td></tr>
                      ) : foundation.map((p) => row(p, false))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="testnet-panel">
                <header><span>Single-symbol executor — stop-protected</span><strong>{singleSymbolLanePositions.length} pos</strong></header>
                <p className="tone-measure" style={{ margin: '4px 0', fontSize: 12 }}>
                  SHORT_FADE_EXHAUSTION_CROWDED / INTRADAY_MOMENTUM_BREAKOUT_LONG / REGIME_COMPOSITE_CONFIRMATION_LONG /
                  COMPOSITE_ESTIMATOR_BIDI_* / PANIC_WASHOUT_RECLAIM_LONG. Satu baris per lane per simbol (2 lane yang sama-sama
                  megang 1 simbol tampil sebagai 2 baris terpisah, bukan digabung) — dilindungi STOP_MARKET real di exchange,
                  &quot;Close now&quot; hanya menutup lane di baris itu. R = (mark−entry)/(entry−stop); exit otomatis tetap
                  lewat stop atau target/MFE-giveback kalau tidak diclose manual.
                </p>
                {singleSymbolPositionsStaleSince && (
                  <p className="tone-warning" style={{ margin: '4px 0', fontSize: 12 }}>
                    ⚠ fetch gagal sejak {timeAgo(singleSymbolPositionsStaleSince)} — daftar di bawah bisa basi.
                  </p>
                )}
                {closeResult && <p className={closeResult.ok ? 'tone-healthy' : 'tone-critical'} style={{ margin: '4px 0', fontSize: 12 }}>{closeResult.message}</p>}
                <div className="testnet-table-wrap">
                  <table>
                    <thead>
                      <tr><th>Symbol</th><th>Lane</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Stop</th><th>R now / peak</th><th>Unrealized</th><th>Opened</th><th>Manual</th></tr>
                    </thead>
                    <tbody>
                      {singleSymbolLanePositions.length === 0 ? (
                        <tr><td colSpan={11}>No open single-symbol executor positions.</td></tr>
                      ) : singleSymbolLanePositions.map((p) => {
                        const risk = Math.abs(p.entryPrice - p.stopPrice);
                        const dirSign = p.direction === 'LONG' ? 1 : -1;
                        const currentR = p.markPrice != null && risk > 0 ? ((p.markPrice - p.entryPrice) / risk) * dirSign : null;
                        const busyKey = `ssle:${p.positionId}`;
                        return (
                          <tr key={p.positionId}>
                            <td>{p.symbol}</td>
                            <td>{compactLane(p.laneId)}</td>
                            <td className={p.direction === 'SHORT' ? 'tone-warning' : 'tone-healthy'}>{p.direction}</td>
                            <td>{p.qty}</td>
                            <td>{price(p.entryPrice)}</td>
                            <td>{price(p.markPrice)}</td>
                            <td>{price(p.stopPrice)}</td>
                            <td className={tone(currentR ?? 0)}>{currentR == null ? '—' : `${currentR.toFixed(2)}R`} / {p.peakFavorableR.toFixed(2)}R</td>
                            <td className={tone(p.unrealizedPnl ?? 0)}>{p.unrealizedPnl == null ? '—' : signed(p.unrealizedPnl)}</td>
                            <td>{new Date(p.openedAt).toLocaleString()}</td>
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
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="testnet-panel">
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
              </section>
              <section className="testnet-panel">
                <header><span>R&amp;D lanes baru (Tier 1-3, 2026-07-10) — semua report-only</span><strong>{rndLanes.filter(Boolean).length}/3</strong></header>
                <p className="tone-measure" style={{ margin: '4px 0', fontSize: 12 }}>
                  3 engine baru dari audit strategi GPT-5.6: belum ada satupun yang di-wire ke eksekusi
                  real atau lane allocation — cuma ngumpulin sample lewat polling dashboard ini. edgeReady
                  butuh n≥30 DAN netAvgR≥0.05 DAN payoff ratio&gt;1.1, sama seperti semua lane lain.
                </p>
                <div className="testnet-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Lane</th><th>Open</th><th>Resolved</th><th>Net avg R</th><th>WR</th><th>PF</th><th>Edge ready</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rndLanes.filter(Boolean).length === 0 ? (
                        <tr><td colSpan={7}>No R&amp;D lane data yet.</td></tr>
                      ) : rndLanes.map((r) => r && (
                        <tr key={r.laneId}>
                          <td>{r.label}</td>
                          <td>{r.openCount}</td>
                          <td>{r.resolvedCount}</td>
                          <td className={r.netAvgR == null ? '' : tone(r.netAvgR)}>{r.netAvgR == null ? '—' : `${r.netAvgR >= 0 ? '+' : ''}${r.netAvgR.toFixed(3)}R`}</td>
                          <td>{r.wr == null ? '—' : `${Math.round(r.wr * 100)}%`}</td>
                          <td>{r.pf == null ? '—' : r.pf.toFixed(2)}</td>
                          <td className={r.edgeReady ? 'tone-healthy' : 'tone-measure'}>{r.edgeReady ? 'YES' : 'not yet'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          );
        })()}

        <section className="testnet-panel">
          <header>
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
        </section>

        <section className="testnet-panel">
          <header><span>Mirrored Lane P&amp;L</span><strong>{account?.lanes.length ?? 0}</strong></header>
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
        </section>

        <section className="testnet-panel">
          <header><span>Mirror Intents</span><strong>{status?.openIntents?.length ?? 0}</strong></header>
          {copyResult && (
            <p className={copyResult.ok ? 'tone-healthy' : 'tone-critical'} style={{ margin: '4px 0' }}>
              {copyResult.ok ? '✓' : '✗'} {copyResult.message}
            </p>
          )}
          <div className="testnet-table-wrap">
            <table>
              <thead>
                <tr><th>Symbol</th><th>Side</th><th>State</th><th>Qty</th><th>Paper source</th><th>Copy</th></tr>
              </thead>
              <tbody>
                {(status?.openIntents ?? []).length === 0 ? (
                  <tr><td colSpan={6}>No active live mirror intents.</td></tr>
                ) : status!.openIntents!.map((intent) => (
                  <tr key={intent.paperOrderId}>
                    <td>{intent.symbol}</td>
                    <td>{intent.direction}</td>
                    <td>{intent.state}</td>
                    <td>{intent.qty}</td>
                    <td>{intent.paperOrderId}</td>
                    <td>
                      {!isLivePage && (intent.state === 'OPEN' || intent.state === 'TP1_FILLED_BE_SET') ? (
                        <button
                          type="button"
                          disabled={copyBusy !== null}
                          onClick={() => void copyToLive(intent.paperOrderId)}
                          title="Open the EXACT same position (symbol/side/qty/stop/TP geometry) on the REAL mainnet engine. Requires live to be armed."
                        >
                          {copyBusy === intent.paperOrderId ? 'Copying…' : '→ LIVE'}
                        </button>
                      ) : (
                        <span className="tone-measure">n/a</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="testnet-panel">
          <header><span>Closed Lane Performance</span><strong>{(account?.closedLanes ?? []).length}</strong></header>
          <div className="testnet-table-wrap">
            <table>
              <thead>
                <tr><th>Lane</th><th>Closed</th><th>W / L</th><th>Realized</th><th>Fees</th><th>Symbols</th><th>Last close</th></tr>
              </thead>
              <tbody>
                {(account?.closedLanes ?? []).length === 0 ? (
                  <tr><td colSpan={7}>No closed Binance mirror trades yet.</td></tr>
                ) : (account?.closedLanes ?? []).map((lane) => (
                  <tr key={lane.laneId}>
                    <td>{compactLane(lane.laneId)}</td>
                    <td>{lane.closedCount}</td>
                    <td>{lane.wins} / {lane.losses}</td>
                    <td className={tone(lane.realizedPnlUsd)}>{signed(lane.realizedPnlUsd)}</td>
                    <td>{plain(lane.feesUsd, ' USDT')}</td>
                    <td>{lane.symbols.join(', ')}</td>
                    <td>{timeAgo(lane.lastClosedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

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
          <LanePerformanceChart series={laneSeries} />
          <div className="testnet-table-wrap testnet-performance-table">
            <table>
              <thead>
                <tr><th>Lane</th><th>Closed</th><th>W / L</th><th>WR</th><th>Realized</th><th>Fees</th><th>Regime mix</th><th>Symbols</th></tr>
              </thead>
              <tbody>
                {(laneSeries?.lanes ?? []).length === 0 ? (
                  <tr><td colSpan={8}>No closed lane performance in this period/regime filter.</td></tr>
                ) : laneSeries!.lanes.map((lane) => (
                  <tr key={lane.laneId}>
                    <td>{compactLane(lane.laneId)}</td>
                    <td>{lane.closedCount}</td>
                    <td>{lane.wins} / {lane.losses}</td>
                    <td>{formatWinRate(lane.winRatePct)}</td>
                    <td className={tone(lane.realizedPnlUsd)}>{signed(lane.realizedPnlUsd)}</td>
                    <td>{plain(lane.feesUsd, ' USDT')}</td>
                    <td>{lane.regimes.map((regime) => `${regime.bucket.toLowerCase()} ${regime.count}`).join(', ') || 'n/a'}</td>
                    <td>{lane.symbols.join(', ') || 'n/a'}</td>
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

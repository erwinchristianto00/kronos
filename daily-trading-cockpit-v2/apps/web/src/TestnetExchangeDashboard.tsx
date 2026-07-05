import { useEffect, useState } from 'react';
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

// Regime tree (operator's naming) ↔ the regime engine's states, with the strategy
// lane each regime runs and a SUGGESTED live lane-allocation preset. Presets only
// PREFILL the allocation form — nothing changes until the operator presses Apply.
// The regime engine itself is REPORT-ONLY (it records decisions, it does not trade).
const REGIME_TREE: Array<{
  label: string;
  engineRegime: string;
  lane: string;
  laneNote: string;
  preset: { lane1: string; w1: string; lane2: string; w2: string };
}> = [
  {
    label: 'Bear Trend',
    engineRegime: 'BEAR_TREND',
    lane: 'Trend Short (Breakdown Retest Short)',
    laneNote: 'break + failed retest continuation',
    // FAST_SHORT is only marginal (book ~break-even), so pair it with the proven all-weather
    // market-neutral basket as ballast instead of going 100% into a thin edge.
    preset: { lane1: 'CG_WIDE_FAST_SHORT', w1: '60', lane2: 'CROSS_SECTIONAL_MARKET_NEUTRAL', w2: '40' },
  },
  {
    label: 'Bear Choppy',
    engineRegime: 'BEARISH_CHOPPY_DEFENSIVE',
    lane: 'Short Rally Fade',
    laneNote: 'fade weak bounces + market-neutral ballast',
    // Dropped the 30% counter-trend FAST_LONG (too much long in a bear-choppy regime); pair the
    // short fade with the market-neutral basket instead.
    preset: { lane1: 'CG_WIDE_FAST_SHORT', w1: '60', lane2: 'CROSS_SECTIONAL_MARKET_NEUTRAL', w2: '40' },
  },
  {
    label: 'Neutral',
    engineRegime: 'NO_TRADE',
    lane: 'Mean Reversion (cross-sectional market-neutral)',
    laneNote: 'no directional conviction → pure market-neutral',
    // No directional conviction → 100% market-neutral (the proven all-weather edge, +0.347%),
    // NOT a 50/50 directional pair (two weak-edge bets that don't cancel beta).
    preset: { lane1: 'CROSS_SECTIONAL_MARKET_NEUTRAL', w1: '100', lane2: '', w2: '0' },
  },
  {
    label: 'Recovery',
    engineRegime: 'NEUTRAL_RECOVERY',
    lane: 'Pullback Long (scalp)',
    laneNote: 'proven long + market-neutral ballast',
    // Longs favored (CG_WIDE_FAST_LONG is proven +0.28R/88%) + market-neutral ballast, instead of
    // a 30% counter-trend short in an early-recovery regime.
    preset: { lane1: 'CG_WIDE_FAST_LONG', w1: '60', lane2: 'CROSS_SECTIONAL_MARKET_NEUTRAL', w2: '40' },
  },
  {
    label: 'Bull',
    engineRegime: 'TREND_RECOVERY',
    lane: 'Trend Following (breakout retest long)',
    laneNote: 'runner earns its place only in a real trend',
    preset: { lane1: 'CG_WIDE_FAST_LONG', w1: '70', lane2: 'CG_WIDE_LONG_RUNNER', w2: '30' },
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
  transitions: Array<{ at: string; from: string; to: string }>;
}

interface LiveStatus {
  enabled: boolean;
  env?: string | null;
  armed?: boolean;
  laneSelection?: {
    allowedLaneIds: string[] | null;
    laneAllocations: Array<{ laneId: string; weightPct: number }> | null;
    mode: string;
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
  const firstLabel = labelBuckets[0] ? formatBucketLabel(labelBuckets[0], series?.view ?? 'daily') : 'start';
  const midLabel = labelBuckets[Math.floor(labelBuckets.length / 2)] ? formatBucketLabel(labelBuckets[Math.floor(labelBuckets.length / 2)], series?.view ?? 'daily') : '';
  const lastLabel = labelBuckets[labelBuckets.length - 1] ? formatBucketLabel(labelBuckets[labelBuckets.length - 1], series?.view ?? 'daily') : 'now';

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
        <text x={padding} y={height - 8} className="testnet-chart-time">{firstLabel}</text>
        <text x={width / 2} y={height - 8} className="testnet-chart-time middle">{midLabel}</text>
        <text x={width - padding} y={height - 8} className="testnet-chart-time end">{lastLabel}</text>
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
  const body = await response.json();
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.reason ?? `Request failed (${response.status})`);
  }
  return body as T;
}

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
  const [allocLane1, setAllocLane1] = useState('CG_WIDE_FAST_SHORT');
  const [allocLane2, setAllocLane2] = useState('CG_WIDE_FAST_LONG');
  const [allocLane3, setAllocLane3] = useState('');
  const [allocLane4, setAllocLane4] = useState('');
  const [allocWeight1, setAllocWeight1] = useState('70');
  const [allocWeight2, setAllocWeight2] = useState('30');
  const [allocWeight3, setAllocWeight3] = useState('0');
  const [allocWeight4, setAllocWeight4] = useState('0');
  const [regimeReport, setRegimeReport] = useState<RegimeEngineReport | null>(null);
  const [headlineLaneOptions, setHeadlineLaneOptions] = useState<string[]>([]);
  const laneAllocationOptions = Array.from(new Set(
    [...LIVE_LANE_OPTIONS, ...headlineLaneOptions, allocLane1, allocLane2, allocLane3, allocLane4].filter(Boolean),
  ));

  function applyRegimePreset(preset: { lane1: string; w1: string; lane2: string; w2: string }) {
    setAllocLane1(preset.lane1);
    setAllocWeight1(preset.w1);
    setAllocLane2(preset.lane2);
    setAllocWeight2(preset.w2);
    setAllocLane3('');
    setAllocWeight3('0');
    setAllocLane4('');
    setAllocWeight4('0');
    setControlMsg({ ok: true, message: `Preset dimuat ke form ${allocationLabel} — tekan Apply untuk mengaktifkan` });
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

  const applyAllocation = () => {
    const allocations: Array<{ laneId: string; weightPct: number }> = [];
    [
      [allocLane1, allocWeight1],
      [allocLane2, allocWeight2],
      [allocLane3, allocWeight3],
      [allocLane4, allocWeight4],
    ].forEach(([lane, weight]) => {
      if (lane.trim()) allocations.push({ laneId: lane.trim(), weightPct: Number(weight) });
    });
    if (allocations.length === 0) {
      setControlMsg({ ok: false, message: 'Allocation: pick at least lane 1' });
      return;
    }
    void control(`${pageApiPrefix}/live/lane-allocations`, { allocations }, allocationLabel, loadExchangeOnly);
  };
  const clearAllocation = () =>
    control(`${pageApiPrefix}/live/lane-allocations`, { allocations: null }, `Clear ${allocationLabel}`, loadExchangeOnly);

  async function loadHeadlineLaneOptions() {
    try {
      const payload = await fetchJson<MainNeuralMap>('/api/shadow/neural-map');
      setHeadlineLaneOptions(extractHeadlineAllocationLanes(payload));
    } catch {
      // Main `/` can be auth/proxy-unavailable during local dev; keep static fallback options.
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
        setCopyResult({ id: paperOrderId, ok: true, message: `LIVE copied: ${body?.live?.intent?.symbol ?? ''} ${body?.live?.intent?.state ?? 'OPEN'}` });
      }
    } catch (copyError) {
      setCopyResult({ id: paperOrderId, ok: false, message: copyError instanceof Error ? copyError.message : 'copy request failed' });
    } finally {
      setCopyBusy(null);
    }
  }

  async function loadExchangeOnly() {
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
      setStatus(nextStatus);
      setAccount(nextAccount);
      setLaneSeries(nextLaneSeries);
      setError(null);
      setLastLoadedAt(new Date().toISOString());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `Unable to load Binance ${isLivePage ? 'mainnet' : 'testnet'} mirror`);
    }
  }

  // Regime engine report — report-only, market-wide (lives on the TESTNET instance). Loaded
  // INDEPENDENTLY of the exchange fetches so a live-endpoint hiccup can never skip it — that
  // was why the panel could stay blank on /live. Shown identically on both /testnet and /live.
  async function loadRegimeReport() {
    try {
      const res = await fetch(`${TESTNET_API_PREFIX}/shadow/regime-engine-report`, { cache: 'no-store' });
      setRegimeReport(await res.json());
    } catch {
      setRegimeReport(null); // fail-soft: the panel just says unavailable
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
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadRegimeReport();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const stale = lastLoadedAt ? Date.now() - new Date(lastLoadedAt).getTime() > REFRESH_MS * 2.5 : true;
  const healthTone = status?.armed ? 'tone-healthy' : status?.health?.lastTickError ? 'tone-warning' : 'tone-measure';
  const totalSourceEntries = account?.positions.reduce((sum, position) => sum + position.sourceOrderCount, 0) ?? 0;
  const regimeOptions = laneSeries?.regimeOptions ?? FALLBACK_REGIME_OPTIONS;
  const chartTotal = laneSeries?.lanes.reduce((sum, lane) => sum + lane.realizedPnlUsd, 0) ?? 0;
  const isCrossSectionalPosition = (laneIds: string[]) => laneIds.includes('CROSS_SECTIONAL_MARKET_NEUTRAL');

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
          <strong className={tone(account?.unrealizedPnl)}>{signed(account?.unrealizedPnl)}</strong>
          <small>{account ? `${account.openPositionCount} positions · ${totalSourceEntries} source entries` : 'loading positions'}</small>
        </div>
        <div>
          <span>Realized P&amp;L</span>
          <strong className={tone(status?.totalRealizedPnlUsd)}>{signed(status?.totalRealizedPnlUsd)}</strong>
          <small>today {signed(status?.closedToday?.realizedPnlUsd)}</small>
        </div>
        <div>
          <span>Open TP/SL orders</span>
          <strong>{account?.openOrderCount ?? 'n/a'}</strong>
          <small>{status?.openIntents?.length ?? 0} live intents · exits can be 2x positions</small>
        </div>
      </section>

      <section className="testnet-panel">
        <header>
          <span>Engine Controls</span>
          <strong>
            {pageName.toLowerCase()} {status?.armed ? 'ARMED' : 'disarmed'}
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
              {allocationLabel} — active: {status?.laneSelection?.laneAllocations
                ? status.laneSelection.laneAllocations.map((a) => `${compactLane(a.laneId)} ${a.weightPct}%`).join(' + ')
                : status?.laneSelection?.mode ?? 'n/a'}
            </small>
            <select value={allocLane1} onChange={(e) => setAllocLane1(e.target.value)}>
              {laneAllocationOptions.map((lane) => <option key={lane} value={lane}>{lane}</option>)}
            </select>{' '}
            <input type="number" min={1} max={100} value={allocWeight1} onChange={(e) => setAllocWeight1(e.target.value)} style={{ width: 56 }} />%
            {' + '}
            <select value={allocLane2} onChange={(e) => setAllocLane2(e.target.value)}>
              <option value="">(none)</option>
              {laneAllocationOptions.map((lane) => <option key={lane} value={lane}>{lane}</option>)}
            </select>{' '}
            <input type="number" min={0} max={100} value={allocWeight2} onChange={(e) => setAllocWeight2(e.target.value)} style={{ width: 56 }} />%
            {' + '}
            <select value={allocLane3} onChange={(e) => setAllocLane3(e.target.value)}>
              <option value="">(none)</option>
              {laneAllocationOptions.map((lane) => <option key={lane} value={lane}>{lane}</option>)}
            </select>{' '}
            <input type="number" min={0} max={100} value={allocWeight3} onChange={(e) => setAllocWeight3(e.target.value)} style={{ width: 56 }} />%
            {' + '}
            <select value={allocLane4} onChange={(e) => setAllocLane4(e.target.value)}>
              <option value="">(none)</option>
              {laneAllocationOptions.map((lane) => <option key={lane} value={lane}>{lane}</option>)}
            </select>{' '}
            <input type="number" min={0} max={100} value={allocWeight4} onChange={(e) => setAllocWeight4(e.target.value)} style={{ width: 56 }} />%
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
              ? `${regimeReport.latest.regime} · BTC ${price(regimeReport.latest.btcPrice)} · ${regimeReport.snapshotCount} snapshots`
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
        <div className="testnet-table-wrap">
          <table>
            <thead>
              <tr><th>Regime</th><th>Engine state</th><th>Strategy lane</th><th>Snapshots</th><th>Allocation preset</th></tr>
            </thead>
            <tbody>
              {REGIME_TREE.map((row) => {
                const isCurrent = regimeReport?.latest?.regime === row.engineRegime;
                const count = regimeReport?.regimeCounts?.[row.engineRegime] ?? 0;
                return (
                  <tr key={row.engineRegime} style={isCurrent ? { outline: '1px solid #5ce4a6' } : undefined}>
                    <td className={isCurrent ? 'tone-healthy' : undefined}>
                      {isCurrent ? '▶ ' : ''}{row.label}
                    </td>
                    <td>{row.engineRegime}</td>
                    <td title={row.laneNote}>{row.lane}</td>
                    <td>{count}</td>
                    <td>
                      <button type="button" disabled={controlBusy} onClick={() => applyRegimePreset(row.preset)}>
                        {row.preset.lane2
                          ? `${compactLane(row.preset.lane1)} ${row.preset.w1}% + ${compactLane(row.preset.lane2)} ${row.preset.w2}%`
                          : `${compactLane(row.preset.lane1)} ${row.preset.w1}%`}
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

        <section className="testnet-panel">
          <header><span>Exchange Positions</span><strong>{account ? `${account.positions.length} pos · ${totalSourceEntries} entries` : '0'}</strong></header>
          <div className="testnet-table-wrap">
            <table>
              <thead>
                <tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>TP target</th><th>TP gap</th><th>Liq / margin call</th><th>Unrealized</th><th>After fee+slip</th><th>Lev</th><th>Source entries</th><th>Mirrored lane</th></tr>
              </thead>
              <tbody>
                {(account?.positions ?? []).length === 0 ? (
                  <tr><td colSpan={13}>No open Binance testnet positions.</td></tr>
                ) : account!.positions.map((position) => (
                  <tr key={position.symbol}>
                    <td>{position.symbol}</td>
                    <td className={position.direction === 'SHORT' ? 'tone-warning' : 'tone-healthy'}>{position.direction}</td>
                    <td>{position.quantity}</td>
                    <td>{price(position.entryPrice)}</td>
                    <td>{price(position.markPrice)}</td>
                    <td>{position.targetTpPrice == null && isCrossSectionalPosition(position.laneIds) ? 'basket horizon' : price(position.targetTpPrice)}</td>
                    <td className={tone(position.targetTpGapPct)}>{position.targetTpGapPct == null && isCrossSectionalPosition(position.laneIds) ? 'timed' : percent(position.targetTpGapPct)}</td>
                    <td className="tone-critical">{price(position.liquidationPrice)}</td>
                    <td className={tone(position.unrealizedPnl)}>{signed(position.unrealizedPnl)}</td>
                    <td className={tone(position.unrealizedAfterEstimatedCloseCostUsd)}>
                      {signed(position.unrealizedAfterEstimatedCloseCostUsd)}
                    </td>
                    <td>{position.leverage}x</td>
                    <td>{position.sourceOrderCount}</td>
                    <td>{position.laneIds.length > 0 ? position.laneIds.map(compactLane).join(', ') : 'unattributed'}</td>
                  </tr>
                ))}
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

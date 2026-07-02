import { useEffect, useState } from 'react';
import './neural-mindmap.css';

const REFRESH_MS = 5_000;
const TESTNET_API_PREFIX = '/testnet/api';
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

interface LiveStatus {
  enabled: boolean;
  env?: string | null;
  armed?: boolean;
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
        fetchJson<LiveStatus>(`${TESTNET_API_PREFIX}/live/status`),
        fetchJson<LiveAccount>(`${TESTNET_API_PREFIX}/live/account`),
        fetchJson<LanePerformanceSeries>(`${TESTNET_API_PREFIX}/live/lane-performance-series?${seriesParams.toString()}`),
      ]);
      setStatus(nextStatus);
      setAccount(nextAccount);
      setLaneSeries(nextLaneSeries);
      setError(null);
      setLastLoadedAt(new Date().toISOString());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load Binance testnet mirror');
    }
  }

  useEffect(() => {
    void loadExchangeOnly();
  }, [performanceView, performanceDay, performanceMonth, performanceYear, performanceRegime]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadExchangeOnly();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, performanceView, performanceDay, performanceMonth, performanceYear, performanceRegime]);

  const stale = lastLoadedAt ? Date.now() - new Date(lastLoadedAt).getTime() > REFRESH_MS * 2.5 : true;
  const healthTone = status?.armed ? 'tone-healthy' : status?.health?.lastTickError ? 'tone-warning' : 'tone-measure';
  const totalSourceEntries = account?.positions.reduce((sum, position) => sum + position.sourceOrderCount, 0) ?? 0;
  const regimeOptions = laneSeries?.regimeOptions ?? FALLBACK_REGIME_OPTIONS;
  const chartTotal = laneSeries?.lanes.reduce((sum, lane) => sum + lane.realizedPnlUsd, 0) ?? 0;

  return (
    <div className="neural-shell testnet-shell">
      <header className="neural-topbar">
        <div className="neural-brand">
          <span className={`neural-live-dot ${stale || error ? 'is-stale' : ''}`} />
          <div>
            <p>Binance testnet mirror</p>
            <h1>Exchange P&amp;L</h1>
          </div>
        </div>
        <nav className="neural-nav" aria-label="Dashboard views">
          <button type="button" className="is-current">Testnet</button>
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
          <small>{account?.availableBalance != null ? `${account.availableBalance.toFixed(2)} available` : 'testnet wallet'}</small>
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
            <strong>Exchange-only testnet view</strong>
            <p>This page reads only `{TESTNET_API_PREFIX}/live/status` and `{TESTNET_API_PREFIX}/live/account`. Binance positions are netted per symbol, so one exchange position can contain multiple source entries from mirrored paper orders.</p>
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
                    <td>{price(position.targetTpPrice)}</td>
                    <td className={tone(position.targetTpGapPct)}>{percent(position.targetTpGapPct)}</td>
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
                      {intent.state === 'OPEN' || intent.state === 'TP1_FILLED_BE_SET' ? (
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

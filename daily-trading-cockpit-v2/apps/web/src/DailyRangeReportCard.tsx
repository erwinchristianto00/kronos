import { useEffect, useState } from 'react';
import OpenBasketReviewChart, { type OpenBasketReviewLeg } from './OpenBasketReviewChart';
import {
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

const REFRESH_MS = 15_000;
const HISTORY_LIMIT = 100;
const REVIEWABLE_STATUSES = new Set(['PROTECTING', 'OPEN', 'EXIT_RECONCILING']);

type DailyRangeTrade = DailyRangeHeadlineTrade & {
  tradeId: string;
  dateUtc: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entrySubmittedAt: string;
  entryFilledAt: string | null;
  entryFillPrice: number | null;
  entryQty: number | null;
  entryNotionalUsd: number | null;
  rangeHigh: number;
  rangeLow: number;
  entryPolicy?: 'LEGACY_CONTINUATION' | 'CONTINUATION' | 'FADE';
  referenceTimezone?: 'UTC' | 'America/New_York';
  stopPrice: number | null;
  takeProfitPrice: number | null;
  lastMarkPrice: number | null;
  rrTarget: number;
  exitReason: string | null;
  exitPrice: number | null;
  grossPnlUsd: number | null;
  feesUsd: number | null;
  fundingUsd: number | null;
  realizedR: number | null;
  mfeR: number | null;
  maeR: number | null;
  holdingDurationMs: number | null;
  lastReconcileError: string | null;
};

type DailyRangePerformance = {
  closedTrades?: number;
  wins?: number;
  losses?: number;
  winRate?: number | null;
  grossPnlUsd?: number | null;
  netPnlUsd?: number | null;
  totalRealizedR?: number | null;
};

type DailyRangeStatus = {
  enabled: boolean;
  reason?: string;
  environment?: 'testnet' | 'mainnet';
  strategyVersion?: string;
  control?: { mode?: string };
  mainnetControls?: { entryBlockReason?: string | null } | null;
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

function formatTaipei(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei',
  }).format(new Date(value));
}

function formatDuration(value: number | null | undefined): string {
  if (!finite(value) || value < 0) return '—';
  const minutes = Math.max(0, Math.round(value / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
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

function closeReason(reason: string | null): string {
  if (reason === 'TAKE_PROFIT') return 'TAKE PROFIT';
  if (reason === 'STOP_LOSS') return 'STOP LOSS';
  return reason?.replaceAll('_', ' ') ?? '—';
}

function entryPolicyLabel(policy: DailyRangeTrade['entryPolicy']): string {
  if (policy === 'FADE') return 'BREAKOUT FADE';
  if (policy === 'CONTINUATION') return 'CONTINUATION';
  return 'LEGACY CONTINUATION';
}

function entryPolicyDescription(policy: DailyRangeTrade['entryPolicy']): string {
  if (policy === 'FADE') return 'Breakout gagal: harga kembali masuk ke dalam range 4H.';
  if (policy === 'CONTINUATION') return 'Breakout bertahan: close 5m berikutnya makin jauh di luar range 4H.';
  return 'Aturan continuation sebelum router otomatis diterapkan.';
}

function entryPolicyClass(policy: DailyRangeTrade['entryPolicy']): string {
  return policy === 'FADE' ? 'is-fade' : policy === 'CONTINUATION' ? 'is-continuation' : 'is-legacy';
}

function latestFirst(left: DailyRangeTrade, right: DailyRangeTrade): number {
  return Date.parse(right.exitTimestamp ?? '') - Date.parse(left.exitTimestamp ?? '');
}

function ClosedDailyRangeReport({
  performance,
  trades,
  error,
  environment,
}: {
  performance: DailyRangePerformance | undefined;
  trades: DailyRangeTrade[];
  error: string | null;
  environment: DailyRangeStatus['environment'];
}) {
  const closedTrades = trades.filter((trade) => trade.status === 'CLOSED').sort(latestFirst);
  const closedCount = performance?.closedTrades ?? closedTrades.length;
  const netRealized = performance?.netPnlUsd ?? null;
  const totalRealizedR = performance?.totalRealizedR ?? null;
  const winRate = performance?.winRate ?? null;

  return <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="daily-range-closed-report">
    <header>
      <div>
        <span>Closed Daily Range realized report</span>
        <strong style={{ color: toneForValue(netRealized) }}>
          {closedCount} closed · net realized {formatMoney(netRealized)} · {formatR(totalRealizedR)}
        </strong>
      </div>
      <span className="tone-measure">{environment === 'mainnet' ? 'LIVE · actual closed fills' : 'Testnet only · actual closed fills'}</span>
    </header>
    <div className="daily-range-report-note">
      Net realized = gross realized − fee yang tercatat + funding yang tercatat. Tidak ada slippage estimasi yang disisipkan ke hasil closed.
      {finite(winRate) ? <> Win rate {formatPercent(winRate * 100)} · {performance?.wins ?? 0}W / {performance?.losses ?? 0}L.</> : null}
    </div>
    {error ? <div className="daily-range-message tone-warning">Riwayat Daily Range belum bisa dimuat: {error}</div> : null}
    {!error && closedTrades.length === 0 ? <div className="daily-range-message">Belum ada Daily Range trade yang closed dengan fill final untuk dilaporkan.</div> : null}
    {closedTrades.length > 0 ? <div className="testnet-table-wrap">
      <table className="daily-range-table daily-range-closed-table">
        <thead><tr>
          <th>Symbol</th><th>Side</th><th>Setup</th><th>Opened (Taipei)</th><th>Entry</th><th>Exit</th><th>Hold</th><th>Reason</th><th>Gross</th><th>Fees</th><th>Funding</th><th>Net realized</th><th>R realized</th><th>MFE / MAE</th><th>Closed (Taipei)</th>
        </tr></thead>
        <tbody>{closedTrades.map((trade) => <tr key={trade.tradeId}>
          <td><strong>{trade.symbol}</strong></td>
          <td style={{ color: toneForSide(trade.direction), fontWeight: 700 }}>{trade.direction}</td>
          <td><span className={`daily-range-state ${entryPolicyClass(trade.entryPolicy)}`} title={entryPolicyDescription(trade.entryPolicy)}>{entryPolicyLabel(trade.entryPolicy)}</span></td>
          <td>{formatTaipei(trade.entryFilledAt ?? trade.entrySubmittedAt)}</td>
          <td>{formatPrice(trade.entryFillPrice)}</td>
          <td>{formatPrice(trade.exitPrice)}</td>
          <td>{formatDuration(trade.holdingDurationMs)}</td>
          <td><span className={`daily-range-state ${trade.exitReason === 'TAKE_PROFIT' ? 'is-tp' : 'is-stop'}`}>{closeReason(trade.exitReason)}</span></td>
          <td style={{ color: toneForValue(trade.grossPnlUsd) }}>{formatMoney(trade.grossPnlUsd)}</td>
          <td style={{ color: C.bad }}>{finite(trade.feesUsd) ? `-${trade.feesUsd.toFixed(4)} USDT` : '—'}</td>
          <td style={{ color: toneForValue(trade.fundingUsd) }}>{formatMoney(trade.fundingUsd)}</td>
          <td style={{ color: toneForValue(trade.netPnlUsd), fontWeight: 700 }}>{formatMoney(trade.netPnlUsd)}</td>
          <td style={{ color: toneForValue(trade.realizedR) }}>{formatR(trade.realizedR)}</td>
          <td><span style={{ color: toneForValue(trade.mfeR) }}>{formatR(trade.mfeR)}</span> / <span style={{ color: toneForValue(trade.maeR) }}>{formatR(trade.maeR)}</span></td>
          <td>{formatTaipei(trade.exitTimestamp)}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
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
  }, [apiPrefix]);

  useEffect(() => {
    if (!onHeadlineSummary) return;
    const expectedClosed = data?.performance?.closedTrades;
    const returnedClosed = history.filter((trade) => trade.status === 'CLOSED').length;
    const historyComplete = expectedClosed == null || returnedClosed >= expectedClosed;
    if (data?.enabled !== true || error != null || historyError != null || !historyComplete) {
      onHeadlineSummary(null);
      return;
    }
    onHeadlineSummary(summarizeDailyRangeHeadline(history));
  }, [data?.enabled, data?.performance?.closedTrades, error, history, historyError, onHeadlineSummary]);

  const openTrades = (data?.openTrades ?? []).filter(reviewableTrade);
  const tradeKeys = openTrades.map((trade) => trade.tradeId).join('|');
  const selectedTrade = openTrades.find((trade) => trade.tradeId === selectedTradeId) ?? openTrades[0] ?? null;
  useEffect(() => {
    if (selectedTradeId !== selectedTrade?.tradeId) setSelectedTradeId(selectedTrade?.tradeId ?? null);
  }, [selectedTradeId, selectedTrade?.tradeId, tradeKeys]);

  const reviewLeg: OpenBasketReviewLeg | null = selectedTrade ? {
    key: `daily-range:${selectedTrade.tradeId}`,
    basketId: selectedTrade.tradeId,
    signal: selectedTrade.entryPolicy === 'FADE'
      ? 'failed breakout: outside close → inside re-entry'
      : selectedTrade.entryPolicy === 'CONTINUATION'
        ? 'expanding outside closes: continuation'
        : 'two completed 5m closes beyond 00:00–04:00 UTC range',
    variant: data?.strategyVersion ?? 'daily-4h-range-acceptance-2r-v1',
    symbol: selectedTrade.symbol,
    side: selectedTrade.direction,
    openedAt: selectedTrade.entryFilledAt ?? selectedTrade.entrySubmittedAt,
    entryPrice: selectedTrade.entryFillPrice!,
    markPrice: selectedTrade.lastMarkPrice,
    grossUnrealizedUsd: grossMarkPnl(selectedTrade),
    chartEndpoint: `${apiPrefix}/live/daily-range-lane/chart?tradeId=${encodeURIComponent(selectedTrade.tradeId)}`,
    reviewKind: 'daily-range',
    stopPrice: selectedTrade.stopPrice,
    takeProfitPrice: selectedTrade.takeProfitPrice,
    entryPolicy: selectedTrade.entryPolicy,
  } : null;

  const notional = openTrades.reduce((sum, trade) => sum + (tradeNotional(trade) ?? 0), 0);
  const markPnls = openTrades.map(grossMarkPnl);
  const markPnl = markPnls.every(finite) ? markPnls.reduce((sum, pnl) => sum + (pnl ?? 0), 0) : null;
  const runtimeLabel = data?.environment === 'mainnet'
    ? data.mainnetControls?.entryBlockReason
      ? 'LIVE · OBSERVE ONLY'
      : `LIVE · ${data.control?.mode ?? 'memuat mode…'}`
    : `Testnet only · ${data?.control?.mode ?? 'memuat mode…'}`;
  const usesAutoRouter = data?.strategyVersion === 'daily-4h-range-auto-route-ny-2r-v2';

  return <>
    <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="daily-range-open-report">
      <header>
        <div>
          <span>Daily Range 4H · open trade review</span>
          <strong style={{ color: toneForValue(markPnl) }}>
            Notional {formatUnsignedMoney(notional)} · gross mark {formatMoney(markPnl)}
          </strong>
        </div>
        <span className="tone-measure">{runtimeLabel}</span>
      </header>
      <div className="daily-range-report-note">
        Range <strong>{usesAutoRouter ? '00:00–04:00 New York' : '00:00–04:00 UTC'}</strong> → {usesAutoRouter ? 'breakout bertahan = Continuation; kembali masuk range = Breakout Fade.' : 'dua close 5m selesai di luar range → native structural SL + fixed 2R TP.'}
        Klik simbol trade untuk membuka candle; level range selalu memakai data trade yang dibekukan saat entry.
      </div>
      {error ? <div className="daily-range-message tone-warning">Daily Range status unavailable: {error}</div> : null}
      {!error && data && openTrades.length === 0 ? <div className="daily-range-message">Tidak ada Daily Range trade aktif yang sudah terisi untuk direview.</div> : null}
      {openTrades.length > 0 ? <>
        <div className="daily-range-breakdown">
          <span>Mirrored lane P&amp;L · full breakdown ({openTrades.length} open trade{openTrades.length === 1 ? '' : 's'})</span>
          <span>klik symbol → candle review</span>
        </div>
        <div className="testnet-table-wrap">
          <table className="daily-range-table">
            <thead><tr>
              <th>Book</th><th>Symbol</th><th>Side</th><th>Setup</th><th>Qty</th><th>Entry</th><th>Mark</th><th>TP target</th><th>TP gap</th><th>Stop</th><th>R now / peak</th><th>Gross mark</th><th>Range H / L</th><th>Opened (Taipei)</th><th>Intent state</th><th>Action</th>
            </tr></thead>
            <tbody>{openTrades.map((trade) => {
              const selected = selectedTrade?.tradeId === trade.tradeId;
              const gross = grossMarkPnl(trade);
              const nowR = currentR(trade);
              const gap = targetGapPct(trade);
              return <tr key={trade.tradeId} className={selected ? 'is-selected' : undefined}>
                <td>Daily range</td>
                <td><button type="button" className="daily-range-symbol-button" onClick={() => setSelectedTradeId(trade.tradeId)} aria-pressed={selected} title={`Buka candle ${trade.symbol}`}>{trade.symbol}</button></td>
                <td style={{ color: toneForSide(trade.direction), fontWeight: 700 }}>{trade.direction}</td>
                <td><span className={`daily-range-state ${entryPolicyClass(trade.entryPolicy)}`} title={entryPolicyDescription(trade.entryPolicy)}>{entryPolicyLabel(trade.entryPolicy)}</span></td>
                <td>{finite(trade.entryQty) ? Number(trade.entryQty.toFixed(8)) : '—'}</td>
                <td>{formatPrice(trade.entryFillPrice)}</td>
                <td>{formatPrice(trade.lastMarkPrice)}</td>
                <td>{formatPrice(trade.takeProfitPrice)} <small>{trade.rrTarget}R</small></td>
                <td style={{ color: toneForValue(gap) }}>{formatPercent(gap)}</td>
                <td style={{ color: C.bad }}>{formatPrice(trade.stopPrice)}</td>
                <td><span style={{ color: toneForValue(nowR) }}>{formatR(nowR)}</span> / <span style={{ color: toneForValue(trade.mfeR) }}>{formatR(trade.mfeR)}</span></td>
                <td style={{ color: toneForValue(gross), fontWeight: 700 }}>{formatMoney(gross)}</td>
                <td>{formatPrice(trade.rangeHigh)} / {formatPrice(trade.rangeLow)}</td>
                <td>{formatTaipei(trade.entryFilledAt ?? trade.entrySubmittedAt)}</td>
                <td><span className="daily-range-state">{trade.status}</span>{trade.lastReconcileError ? <small className="tone-warning daily-range-reconcile">reconcile: {trade.lastReconcileError}</small> : null}</td>
                <td><span className="daily-range-action">view candles</span></td>
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
    <ClosedDailyRangeReport performance={data?.performance} trades={history} error={historyError} environment={data?.environment} />
  </>;
}

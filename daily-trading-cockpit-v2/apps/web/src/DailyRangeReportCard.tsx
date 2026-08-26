import { useEffect, useState } from 'react';
import OpenBasketReviewChart, { type OpenBasketReviewLeg } from './OpenBasketReviewChart';

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
const REVIEWABLE_STATUSES = new Set(['PROTECTING', 'OPEN', 'EXIT_RECONCILING']);

type DailyRangeTrade = {
  tradeId: string;
  dateUtc: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  status: string;
  entrySubmittedAt: string;
  entryFilledAt: string | null;
  entryFillPrice: number | null;
  entryQty: number | null;
  rangeHigh: number;
  rangeLow: number;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  lastMarkPrice: number | null;
  rrTarget: number;
  lastReconcileError: string | null;
};

type DailyRangeStatus = {
  enabled: boolean;
  reason?: string;
  strategyVersion?: string;
  control?: { mode?: string };
  openTrades?: DailyRangeTrade[];
};

function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = value < 0.0001 ? 10 : value < 0.01 ? 8 : value < 1 ? 6 : value < 100 ? 4 : 2;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function formatTaipei(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei',
  }).format(new Date(value));
}

function reviewableTrade(trade: DailyRangeTrade): boolean {
  return REVIEWABLE_STATUSES.has(trade.status)
    && trade.entryFillPrice != null
    && Number.isFinite(trade.entryFillPrice)
    && trade.entryFillPrice > 0
    && trade.entryQty != null
    && Number.isFinite(trade.entryQty)
    && trade.entryQty > 0;
}

function grossMarkPnl(trade: DailyRangeTrade): number | null {
  if (trade.entryFillPrice == null || trade.entryQty == null || trade.lastMarkPrice == null) return null;
  if (!Number.isFinite(trade.entryFillPrice) || !Number.isFinite(trade.entryQty) || !Number.isFinite(trade.lastMarkPrice)) return null;
  const direction = trade.direction === 'LONG' ? 1 : -1;
  return (trade.lastMarkPrice - trade.entryFillPrice) * trade.entryQty * direction;
}

function toneForSide(side: DailyRangeTrade['direction']): string {
  return side === 'LONG' ? C.good : C.bad;
}

export default function DailyRangeReportCard({ apiPrefix }: { apiPrefix: string }) {
  const [data, setData] = useState<DailyRangeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${apiPrefix}/live/daily-range-lane/status`, { cache: 'no-store' });
        const body = await response.json() as DailyRangeStatus;
        if (!response.ok || body.enabled !== true) throw new Error(body.reason ?? `daily range request failed (${response.status})`);
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Daily Range data unavailable');
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiPrefix]);

  const openTrades = (data?.openTrades ?? []).filter(reviewableTrade);
  const tradeKeys = openTrades.map((trade) => trade.tradeId).join('|');
  const selectedTrade = openTrades.find((trade) => trade.tradeId === selectedTradeId) ?? openTrades[0] ?? null;
  useEffect(() => {
    if (selectedTradeId !== selectedTrade?.tradeId) setSelectedTradeId(selectedTrade?.tradeId ?? null);
  }, [selectedTradeId, selectedTrade?.tradeId, tradeKeys]);

  const reviewLeg: OpenBasketReviewLeg | null = selectedTrade ? {
    key: `daily-range:${selectedTrade.tradeId}`,
    basketId: selectedTrade.tradeId,
    signal: 'two completed 5m closes beyond 00:00–04:00 UTC range',
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
  } : null;

  return <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="daily-range-open-report">
    <header>
      <div>
        <span>Daily Range 4H · open trade review</span>
        <strong>{openTrades.length} open trade{openTrades.length === 1 ? '' : 's'}</strong>
      </div>
      <span className="tone-measure">Testnet only · {data?.control?.mode ?? 'memuat mode…'}</span>
    </header>
    <div style={{ padding: '9px 12px', color: C.dim, fontSize: 11, lineHeight: 1.55, borderBottom: `1px solid ${C.border}`, background: C.sub }}>
      Range <strong style={{ color: C.text }}>00:00–04:00 UTC</strong> → dua close 5m selesai di luar range → native structural SL + fixed 2R TP.
      Klik simbol trade untuk melihat chart yang sama dengan cross-sectional basket, tetapi level range diambil dari data trade yang dibekukan saat entry.
    </div>
    {error ? <div style={{ padding: 12, color: C.bad, fontSize: 12 }}>Daily Range status unavailable: {error}</div> : null}
    {!error && data && openTrades.length === 0 ? <div style={{ padding: 12, color: C.dim, fontSize: 12 }}>Tidak ada Daily Range trade aktif yang sudah terisi untuk direview.</div> : null}
    {openTrades.length > 0 ? <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10, borderBottom: `1px solid ${C.border}` }}>
      {openTrades.map((trade) => {
        const selected = selectedTrade?.tradeId === trade.tradeId;
        const gross = grossMarkPnl(trade);
        return <button
          key={trade.tradeId}
          type="button"
          onClick={() => setSelectedTradeId(trade.tradeId)}
          aria-pressed={selected}
          style={{
            textAlign: 'left', padding: 10, borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${selected ? C.measure : C.border}`,
            background: selected ? '#19313a' : '#0b171d', color: C.text,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <strong style={{ color: toneForSide(trade.direction), fontSize: 14 }}>{trade.symbol} · {trade.direction}</strong>
            <span style={{ color: C.dim, fontSize: 10 }}>{trade.status}</span>
          </div>
          <div style={{ marginTop: 7, color: C.dim, fontSize: 11, lineHeight: 1.55 }}>
            entry {formatPrice(trade.entryFillPrice)} · mark {formatPrice(trade.lastMarkPrice)} · gross {gross == null ? '—' : `${gross >= 0 ? '+' : ''}${gross.toFixed(4)} USDT`}<br />
            range H {formatPrice(trade.rangeHigh)} / L {formatPrice(trade.rangeLow)} · SL {formatPrice(trade.stopPrice)} · TP {formatPrice(trade.takeProfitPrice)} ({trade.rrTarget}R)<br />
            open {formatTaipei(trade.entryFilledAt ?? trade.entrySubmittedAt)} Taipei
            {trade.lastReconcileError ? <><br /><span style={{ color: C.accent }}>reconcile: {trade.lastReconcileError}</span></> : null}
          </div>
        </button>;
      })}
    </div> : null}
    {reviewLeg ? <OpenBasketReviewChart apiPrefix={apiPrefix} leg={reviewLeg} /> : null}
  </section>;
}

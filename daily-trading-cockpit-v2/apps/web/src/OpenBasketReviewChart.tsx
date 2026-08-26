import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineStyle,
  type UTCTimestamp,
} from 'lightweight-charts';

const C = {
  card: '#14222a',
  sub: '#0f1c23',
  border: '#20313a',
  text: '#dbe7ec',
  dim: '#7d97a3',
  good: '#46d39a',
  bad: '#ff6b6b',
  accent: '#f0b54b',
  measure: '#6fb3d6',
};

const REFRESH_MS = 30_000;

export type OpenBasketReviewLeg = {
  key: string;
  basketId: string;
  signal: string;
  variant: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  openedAt: string;
  entryPrice: number;
  markPrice: number | null;
  grossUnrealizedUsd: number | null;
};

type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ChartResponse = {
  ok: boolean;
  symbol: string;
  source: 'BINANCE_USDM_PUBLIC';
  completedOnly: boolean;
  asOf: string;
  daily: { interval: '1d'; candles: Candle[] };
  fiveMinute: { interval: '5m'; candles: Candle[] };
  previousUtcReference4h: {
    dateUtc: string;
    fourHourOpenTime: number;
    fourHourCloseTime: number;
    rangeHigh: number;
    rangeLow: number;
  } | null;
  referenceReason: string | null;
  reason?: string;
};

type PriceLevel = {
  price: number;
  label: string;
  color: string;
};

type AcceptanceEvent = {
  at: number;
  side: 'LONG' | 'SHORT';
};

function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = value < 0.0001 ? 10 : value < 0.01 ? 8 : value < 1 ? 6 : value < 100 ? 4 : 2;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)} USDT`;
}

function formatTaipei(value: string | number): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei',
  }).format(new Date(ms));
}

function formatUtc(value: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'UTC',
  }).format(new Date(value)).replace(',', '');
}

function findAcceptanceEvents(candles: Candle[], high: number, low: number): AcceptanceEvent[] {
  const events: AcceptanceEvent[] = [];
  let longCount = 0;
  let shortCount = 0;
  let longLocked = false;
  let shortLocked = false;
  for (const candle of candles) {
    if (candle.close >= high) {
      longCount += 1;
      if (longCount >= 2 && !longLocked) {
        longLocked = true;
        events.push({ at: candle.openTime + 5 * 60_000, side: 'LONG' });
      }
    } else {
      longCount = 0;
      longLocked = false;
    }
    if (candle.close <= low) {
      shortCount += 1;
      if (shortCount >= 2 && !shortLocked) {
        shortLocked = true;
        events.push({ at: candle.openTime + 5 * 60_000, side: 'SHORT' });
      }
    } else {
      shortCount = 0;
      shortLocked = false;
    }
  }
  return events;
}

function currentAcceptance(candles: Candle[], high: number, low: number): 'LONG' | 'SHORT' | null {
  const lastTwo = candles.slice(-2);
  if (lastTwo.length !== 2) return null;
  if (lastTwo.every((candle) => candle.close >= high)) return 'LONG';
  if (lastTwo.every((candle) => candle.close <= low)) return 'SHORT';
  return null;
}

function CandlePane({
  title,
  candles,
  levels,
  ariaLabel,
}: {
  title: string;
  candles: Candle[];
  levels: PriceLevel[];
  ariaLabel: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = host.current;
    if (!node || candles.length === 0) return undefined;
    const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
    const chart = createChart(node, {
      width: Math.max(1, node.clientWidth),
      height: 300,
      layout: { background: { type: ColorType.Solid, color: '#071016' }, textColor: '#8fa5ae', fontFamily: 'IBM Plex Mono, Cascadia Code, monospace' },
      grid: { vertLines: { color: 'rgba(38, 61, 72, 0.45)' }, horzLines: { color: 'rgba(38, 61, 72, 0.45)' } },
      rightPriceScale: { borderColor: '#29414c' },
      timeScale: { borderColor: '#29414c', timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: 'rgba(143, 165, 174, 0.28)' }, horzLine: { color: 'rgba(143, 165, 174, 0.28)' } },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#5ce4a6', downColor: '#ff777d', borderVisible: false,
      wickUpColor: '#5ce4a6', wickDownColor: '#ff777d',
    });
    candleSeries.setData(candles.map((candle) => ({
      time: toTime(candle.openTime), open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    })));
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
    }, 1);
    volumeSeries.setData(candles.map((candle) => ({
      time: toTime(candle.openTime),
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(92, 228, 166, 0.45)' : 'rgba(255, 119, 125, 0.42)',
    })));
    chart.panes()[1]?.setHeight(62);
    for (const level of levels) {
      candleSeries.createPriceLine({
        price: level.price,
        color: level.color,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: level.label,
      });
    }
    chart.timeScale().fitContent();
    const resize = () => chart.resize(Math.max(1, node.clientWidth), 300);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(node);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, [candles, levels]);

  return <div style={{ minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', background: C.sub }}>
    <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 12, fontWeight: 700 }}>{title}</div>
    {candles.length === 0
      ? <div style={{ padding: 12, color: C.dim, fontSize: 12 }}>Tidak ada completed candle dari USD-M untuk chart ini.</div>
      : <div ref={host} aria-label={ariaLabel} />}
  </div>;
}

export default function OpenBasketReviewChart({ apiPrefix, leg }: { apiPrefix: string; leg: OpenBasketReviewLeg | null }) {
  const [data, setData] = useState<ChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!leg) {
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(`${apiPrefix}/live/open-basket-chart?symbol=${encodeURIComponent(leg.symbol)}`, { cache: 'no-store' });
        const body = await response.json() as ChartResponse;
        if (!response.ok || body.ok !== true || !Array.isArray(body.daily?.candles) || !Array.isArray(body.fiveMinute?.candles)) {
          throw new Error(body.reason ?? `candle request failed (${response.status})`);
        }
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Candle data unavailable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiPrefix, leg?.key, leg?.symbol]);

  if (!leg) {
    return <section className="testnet-panel testnet-wide-panel" id="open-basket-review-chart">
      <header><div><span>Basket candle review</span><strong>Menunggu basket aktif</strong></div></header>
      <div style={{ padding: 12, color: C.dim, fontSize: 12 }}>Saat ada basket aktif, klik simbolnya di tabel untuk membuka candle 1D dan 5m. Tidak ada dropdown simbol.</div>
    </section>;
  }

  const reference = data?.previousUtcReference4h ?? null;
  const dailyLevels: PriceLevel[] = reference ? [
    { price: reference.rangeHigh, label: 'Resistance', color: C.accent },
    { price: reference.rangeLow, label: 'Support', color: C.good },
  ] : [];
  const fiveMinuteLevels: PriceLevel[] = reference ? [
    { price: reference.rangeHigh, label: 'Breakout + acceptance long', color: C.accent },
    { price: reference.rangeLow, label: 'Breakdown + acceptance short', color: C.bad },
  ] : [];
  const acceptanceEvents = reference && data ? findAcceptanceEvents(data.fiveMinute.candles, reference.rangeHigh, reference.rangeLow) : [];
  const latestAcceptance = reference && data ? currentAcceptance(data.fiveMinute.candles, reference.rangeHigh, reference.rangeLow) : null;
  const latestLongAcceptance = acceptanceEvents.filter((event) => event.side === 'LONG').at(-1);
  const latestShortAcceptance = acceptanceEvents.filter((event) => event.side === 'SHORT').at(-1);

  return <section className="testnet-panel testnet-wide-panel" id="open-basket-review-chart">
    <header>
      <div>
        <span>Basket candle review · klik leg di tabel</span>
        <strong style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>{leg.symbol} · {leg.side}</strong>
      </div>
      <span style={{ color: C.dim, fontSize: 11 }}>{loading ? 'memperbarui completed candles…' : data?.asOf ? `as of ${formatTaipei(data.asOf)} Taipei` : 'memuat…'}</span>
    </header>
    <div style={{ padding: '8px 12px', display: 'flex', gap: 14, flexWrap: 'wrap', color: C.dim, fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
      <span>basket <strong style={{ color: C.text }}>{leg.basketId}</strong></span>
      <span>entry {formatPrice(leg.entryPrice)}</span>
      <span>mark {formatPrice(leg.markPrice)}</span>
      <span style={{ color: leg.grossUnrealizedUsd == null ? C.dim : leg.grossUnrealizedUsd >= 0 ? C.good : C.bad }}>leg P&amp;L {formatMoney(leg.grossUnrealizedUsd)}</span>
      <span>open {formatTaipei(leg.openedAt)} Taipei</span>
    </div>
    {error ? <div style={{ padding: 12, color: C.bad, fontSize: 12 }}>Candle chart unavailable: {error}</div> : <>
      <div style={{ padding: '9px 12px', color: C.dim, fontSize: 11, lineHeight: 1.55, borderBottom: `1px solid ${C.border}` }}>
        {reference ? <>
          Referensi: candle 4H <strong style={{ color: C.text }}>{reference.dateUtc} 00:00–04:00 UTC</strong> (hari kalender sebelum hari ini UTC).
          Resistance <strong style={{ color: C.accent }}>{formatPrice(reference.rangeHigh)}</strong> · support <strong style={{ color: C.good }}>{formatPrice(reference.rangeLow)}</strong>.
          Acceptance memakai <strong style={{ color: C.text }}>dua close 5m selesai berturut-turut</strong> di luar level tersebut.
        </> : <span>Level 4H UTC belum tersedia: {data?.referenceReason ?? 'memuat referensi'}</span>}
      </div>
      <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        <CandlePane title="1D · historical candles + resistance / support" candles={data?.daily.candles ?? []} levels={dailyLevels} ariaLabel={`${leg.symbol} 1d candle chart`} />
        <CandlePane title="5m · breakout / breakdown + acceptance threshold" candles={data?.fiveMinute.candles ?? []} levels={fiveMinuteLevels} ariaLabel={`${leg.symbol} 5m candle chart`} />
      </div>
      {reference && <div style={{ padding: '0 12px 12px', color: C.dim, fontSize: 11, lineHeight: 1.55 }}>
        Status acceptance sekarang: <strong style={{ color: latestAcceptance === 'LONG' ? C.good : latestAcceptance === 'SHORT' ? C.bad : C.text }}>{latestAcceptance ? `${latestAcceptance} confirmed` : 'belum ada dua close 5m berturut-turut'}</strong>.
        {' '}Terakhir long {latestLongAcceptance ? formatUtc(latestLongAcceptance.at) + ' UTC' : '—'} · terakhir short {latestShortAcceptance ? formatUtc(latestShortAcceptance.at) + ' UTC' : '—'}.
        {' '}Garis acceptance sama dengan level breakout/breakdown—yang membedakan adalah dua close 5m, bukan harga baru—jadi tidak dibuat garis harga palsu kedua.
      </div>}
    </>}
  </section>;
}

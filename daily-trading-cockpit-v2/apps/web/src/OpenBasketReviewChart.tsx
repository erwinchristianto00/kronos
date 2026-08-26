import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import { calculateEmaSeries, calculateStructuralTrendlines } from './openBasketChartOverlays';

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
  ema20: '#f0b54b',
  ema50: '#6f9eff',
  structuralResistance: '#ff9f66',
  structuralSupport: '#77b7ff',
};

const REFRESH_MS = 30_000;
// Keep the two candle cards deliberately tall. Structural S/R, EMA20/EMA50 and the
// 5m acceptance levels are otherwise visually compressed on a wide dashboard.
const CANDLE_CHART_HEIGHT = 540;
const VOLUME_PANE_HEIGHT = 84;
const HISTORICAL_INTERVALS = [
  { value: '15m', label: '15m' },
  { value: '1h', label: '1H' },
  { value: '4h', label: '4H' },
  { value: '1d', label: '1D' },
] as const;
type HistoricalInterval = typeof HISTORICAL_INTERVALS[number]['value'];

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
  /** Daily Range supplies an exact trade-scoped feed rather than the generic prior-day reference. */
  chartEndpoint?: string;
  reviewKind?: 'cross-sectional' | 'daily-range';
  stopPrice?: number | null;
  takeProfitPrice?: number | null;
};

type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ChartReference = {
  dateUtc: string;
  fourHourOpenTime: number;
  fourHourCloseTime: number;
  rangeHigh: number;
  rangeLow: number;
  source?: 'TRADE_PERSISTED';
};

type ChartResponse = {
  ok: boolean;
  symbol: string;
  source: 'BINANCE_USDM_PUBLIC';
  completedOnly: boolean;
  asOf: string;
  daily: { interval: '1d'; candles: Candle[] };
  fiveMinute: { interval: '5m'; candles: Candle[] };
  previousUtcReference4h?: ChartReference | null;
  reference4h?: ChartReference | null;
  referenceReason: string | null;
  reason?: string;
};

type IntervalChartResponse = {
  ok: boolean;
  symbol: string;
  interval: HistoricalInterval;
  source: 'BINANCE_USDM_PUBLIC';
  completedOnly: boolean;
  asOf: string;
  candles: Candle[];
  reason?: string;
};

type PriceLevel = {
  price: number;
  label: string;
  color: string;
};

/** A real execution marker, anchored to the completed candle that contains its fill timestamp. */
type ExecutionMarker = {
  at: string;
  price: number;
  side: 'LONG' | 'SHORT';
  label: string;
};

type AcceptanceEvent = {
  at: number;
  side: 'LONG' | 'SHORT';
};

type CandleViewport = { from: number; to: number };

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

function historicalIntervalLabel(interval: HistoricalInterval): string {
  return HISTORICAL_INTERVALS.find((item) => item.value === interval)?.label ?? interval;
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

/**
 * Lightweight Charts markers must attach to an actual bar time.  Daily Range has an exact
 * exchange fill timestamp, so bind it only to the completed 5m candle that contains that fill.
 * Do not attach it to the nearest bar outside that window: a missing/not-yet-completed candle
 * must result in no marker rather than a misleading visual entry.
 */
function entryMarkerForCompletedFiveMinuteCandle(
  candles: Candle[],
  marker: ExecutionMarker,
): SeriesMarker<UTCTimestamp> | null {
  const fillAt = Date.parse(marker.at);
  if (!Number.isFinite(fillAt) || !(marker.price > 0)) return null;
  const matchingCandle = candles.find((candle) => fillAt >= candle.openTime && fillAt < candle.openTime + 5 * 60_000);
  if (!matchingCandle) return null;
  return {
    time: Math.floor(matchingCandle.openTime / 1000) as UTCTimestamp,
    position: 'atPriceMiddle',
    price: marker.price,
    shape: 'circle',
    size: 2,
    color: marker.side === 'LONG' ? C.good : C.bad,
    text: marker.label,
  };
}

function CandlePane({
  title,
  candles,
  levels,
  ariaLabel,
  headerRight,
  error,
  showMovingAverages = false,
  showStructuralTrendlines = false,
  executionMarker,
  viewportKey,
  viewportStore,
}: {
  title: string;
  candles: Candle[];
  levels: PriceLevel[];
  ariaLabel: string;
  headerRight?: ReactNode;
  error?: string | null;
  showMovingAverages?: boolean;
  showStructuralTrendlines?: boolean;
  /** Only used by Daily Range's 5m panel, where the entry fill is persisted. */
  executionMarker?: ExecutionMarker | null;
  /** Per leg/timeframe state survives the 30s completed-candle refresh. */
  viewportKey: string;
  viewportStore: MutableRefObject<Map<string, CandleViewport>>;
}) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = host.current;
    if (!node || candles.length === 0) return undefined;
    const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
    const chart = createChart(node, {
      width: Math.max(1, node.clientWidth),
      height: CANDLE_CHART_HEIGHT,
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
    if (executionMarker) {
      const marker = entryMarkerForCompletedFiveMinuteCandle(candles, executionMarker);
      if (marker) createSeriesMarkers(candleSeries, [marker]);
    }
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
    }, 1);
    volumeSeries.setData(candles.map((candle) => ({
      time: toTime(candle.openTime),
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(92, 228, 166, 0.45)' : 'rgba(255, 119, 125, 0.42)',
    })));
    chart.panes()[1]?.setHeight(VOLUME_PANE_HEIGHT);
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
    if (showMovingAverages) {
      const addEma = (period: 20 | 50, color: string) => {
        const values = calculateEmaSeries(candles, period);
        if (values.length === 0) return;
        const emaSeries = chart.addSeries(LineSeries, {
          color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          title: `EMA${period}`,
        });
        emaSeries.setData(values.map((point) => ({ time: toTime(point.openTime), value: point.value })));
      };
      addEma(20, C.ema20);
      addEma(50, C.ema50);
    }
    if (showStructuralTrendlines) {
      for (const trendline of calculateStructuralTrendlines(candles)) {
        const isResistance = trendline.kind === 'RESISTANCE';
        const series = chart.addSeries(LineSeries, {
          color: isResistance ? C.structuralResistance : C.structuralSupport,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          title: isResistance ? 'Structural resistance · confirmed peaks' : 'Structural support · confirmed troughs',
        });
        series.setData(trendline.points.map((point) => ({ time: toTime(point.openTime), value: point.value })));
      }
    }
    // The parent refreshes completed candles every 30 seconds.  Recreating the lightweight-charts
    // instance is fine for fresh overlays, but it must not throw an operator back to fitContent
    // after they intentionally panned/zoomed to inspect an earlier structure.
    const saveViewport = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
        viewportStore.current.set(viewportKey, { from: range.from, to: range.to });
      }
    };
    const savedViewport = viewportStore.current.get(viewportKey);
    if (savedViewport) chart.timeScale().setVisibleLogicalRange(savedViewport);
    else chart.timeScale().fitContent();
    chart.timeScale().subscribeVisibleLogicalRangeChange(saveViewport);
    const resize = () => chart.resize(Math.max(1, node.clientWidth), CANDLE_CHART_HEIGHT);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(node);
    window.addEventListener('resize', resize);
    return () => {
      saveViewport();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(saveViewport);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, [candles, executionMarker, levels, showMovingAverages, showStructuralTrendlines, viewportKey, viewportStore]);

  return <div style={{ minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', background: C.sub }}>
    <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span>{title}</span>{headerRight}
    </div>
    {error
      ? <div style={{ padding: 12, color: C.bad, fontSize: 12 }}>Candle chart unavailable: {error}</div>
      : candles.length === 0
      ? <div style={{ padding: 12, color: C.dim, fontSize: 12 }}>Tidak ada completed candle dari USD-M untuk chart ini.</div>
      : <div ref={host} aria-label={ariaLabel} />}
  </div>;
}

export default function OpenBasketReviewChart({ apiPrefix, leg }: { apiPrefix: string; leg: OpenBasketReviewLeg | null }) {
  const [data, setData] = useState<ChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [historicalInterval, setHistoricalInterval] = useState<HistoricalInterval>('1d');
  const [historicalSeries, setHistoricalSeries] = useState<IntervalChartResponse | null>(null);
  const [historicalSeriesError, setHistoricalSeriesError] = useState<string | null>(null);
  const [historicalLoading, setHistoricalLoading] = useState(false);
  const viewportStore = useRef<Map<string, CandleViewport>>(new Map());
  const chartEndpoint = leg
    ? leg.chartEndpoint ?? `${apiPrefix}/live/open-basket-chart?symbol=${encodeURIComponent(leg.symbol)}`
    : null;
  // The full response remains the source of the frozen range reference.  The timeframe selector
  // only changes its historical candle series, using the same bounded public USD-M route on both
  // Testnet and Live.  Daily Range therefore never falls back to a recalculated reference range.
  const historicalEndpoint = leg
    ? `${apiPrefix}/live/open-basket-chart?symbol=${encodeURIComponent(leg.symbol)}&interval=${historicalInterval}`
    : null;

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
        const response = await fetch(chartEndpoint!, { cache: 'no-store' });
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
  }, [chartEndpoint, leg?.key]);

  useEffect(() => {
    if (!leg || historicalInterval === '1d') {
      setHistoricalSeries(null);
      setHistoricalSeriesError(null);
      setHistoricalLoading(false);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      setHistoricalLoading(true);
      setHistoricalSeriesError(null);
      setHistoricalSeries(null);
      try {
        const response = await fetch(historicalEndpoint!, { cache: 'no-store' });
        const body = await response.json() as IntervalChartResponse;
        if (!response.ok || body.ok !== true || body.interval !== historicalInterval || !Array.isArray(body.candles)) {
          throw new Error(body.reason ?? `candle request failed (${response.status})`);
        }
        if (!cancelled) setHistoricalSeries(body);
      } catch (loadError) {
        if (!cancelled) setHistoricalSeriesError(loadError instanceof Error ? loadError.message : 'Candle data unavailable');
      } finally {
        if (!cancelled) setHistoricalLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [historicalEndpoint, historicalInterval, leg?.key]);

  if (!leg) {
    return <section className="testnet-panel testnet-wide-panel candle-review-card" id="open-basket-review-chart">
      <header><div><span>Basket candle review</span><strong>Menunggu basket aktif</strong></div></header>
      <div style={{ padding: 12, color: C.dim, fontSize: 12 }}>Saat ada basket aktif, klik simbolnya di tabel untuk membuka candle 1D dan 5m. Tidak ada dropdown simbol.</div>
    </section>;
  }

  const isDailyRange = leg.reviewKind === 'daily-range';
  const reference = data?.reference4h ?? data?.previousUtcReference4h ?? null;
  const historicalCandles = historicalInterval === '1d'
    ? data?.daily.candles ?? []
    : historicalSeries?.candles ?? [];
  const historicalAsOf = historicalInterval === '1d' ? data?.asOf : historicalSeries?.asOf ?? data?.asOf;
  const historicalError = historicalInterval === '1d' ? null : historicalSeriesError;
  const tradeLevels: PriceLevel[] = isDailyRange ? [
    { price: leg.entryPrice, label: 'Entry', color: C.measure },
    ...(leg.stopPrice != null && Number.isFinite(leg.stopPrice)
      ? [{ price: leg.stopPrice, label: 'Native SL', color: C.bad }]
      : []),
    ...(leg.takeProfitPrice != null && Number.isFinite(leg.takeProfitPrice)
      ? [{ price: leg.takeProfitPrice, label: 'Native 2R TP', color: C.good }]
      : []),
  ] : [];
  const dailyLevels: PriceLevel[] = reference ? [
    { price: reference.rangeHigh, label: '4H range high · execution breakout', color: C.accent },
    { price: reference.rangeLow, label: '4H range low · execution breakdown', color: C.good },
    ...tradeLevels,
  ] : tradeLevels;
  const fiveMinuteLevels: PriceLevel[] = reference ? [
    { price: reference.rangeHigh, label: '4H range high · breakout + acceptance long', color: C.accent },
    { price: reference.rangeLow, label: '4H range low · breakdown + acceptance short', color: C.bad },
    ...tradeLevels,
  ] : tradeLevels;
  const dailyRangeEntryMarker: ExecutionMarker | null = isDailyRange && leg.openedAt && leg.entryPrice > 0
    ? {
      at: leg.openedAt,
      price: leg.entryPrice,
      side: leg.side,
      label: `ENTRY ${leg.side}`,
    }
    : null;
  // A Daily Range trade cannot be accepted before its source 4h candle has closed.  Keep the
  // existing cross-sectional review's historical display semantics unchanged.
  const acceptanceCandles = reference && data
    ? isDailyRange
      ? data.fiveMinute.candles.filter((candle) => candle.openTime >= reference.fourHourCloseTime)
      : data.fiveMinute.candles
    : [];
  const acceptanceEvents = reference ? findAcceptanceEvents(acceptanceCandles, reference.rangeHigh, reference.rangeLow) : [];
  const latestAcceptance = reference ? currentAcceptance(acceptanceCandles, reference.rangeHigh, reference.rangeLow) : null;
  const latestLongAcceptance = acceptanceEvents.filter((event) => event.side === 'LONG').at(-1);
  const latestShortAcceptance = acceptanceEvents.filter((event) => event.side === 'SHORT').at(-1);
  const reviewTitle = isDailyRange ? 'Daily Range 4H candle review · klik trade' : 'Basket candle review · klik leg di tabel';
  const ownerNoun = isDailyRange ? 'trade' : 'basket';
  const historicalTitle = `${historicalIntervalLabel(historicalInterval)} · EMA20/EMA50 + structural support / resistance`;
  const historicalControl = <label style={{ color: C.dim, fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap' }}>
    candle{' '}
    <select
      aria-label="Historical candle timeframe"
      value={historicalInterval}
      onChange={(event) => setHistoricalInterval(event.target.value as HistoricalInterval)}
      style={{ background: '#0a151b', color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 5px', fontSize: 11 }}
    >
      {HISTORICAL_INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  </label>;

  return <section className="testnet-panel testnet-wide-panel candle-review-card" id={isDailyRange ? 'daily-range-review-chart' : 'open-basket-review-chart'}>
    <header>
      <div>
        <span>{reviewTitle}</span>
        <strong style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>{leg.symbol} · {leg.side}</strong>
      </div>
      <span style={{ color: C.dim, fontSize: 11 }}>{loading || historicalLoading ? 'memperbarui completed candles…' : historicalAsOf ? `as of ${formatTaipei(historicalAsOf)} Taipei` : 'memuat…'}</span>
    </header>
    <div style={{ padding: '8px 12px', display: 'flex', gap: 14, flexWrap: 'wrap', color: C.dim, fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
      <span>{ownerNoun} <strong style={{ color: C.text }}>{leg.basketId}</strong></span>
      <span>entry {formatPrice(leg.entryPrice)}</span>
      <span>mark {formatPrice(leg.markPrice)}</span>
      <span style={{ color: leg.grossUnrealizedUsd == null ? C.dim : leg.grossUnrealizedUsd >= 0 ? C.good : C.bad }}>{isDailyRange ? 'gross mark P&L' : 'leg P&L'} {formatMoney(leg.grossUnrealizedUsd)}</span>
      {isDailyRange && <span>native SL {formatPrice(leg.stopPrice)} · TP 2R {formatPrice(leg.takeProfitPrice)}</span>}
      <span>open {formatTaipei(leg.openedAt)} Taipei</span>
    </div>
    {error ? <div style={{ padding: 12, color: C.bad, fontSize: 12 }}>Candle chart unavailable: {error}</div> : <>
      <div style={{ padding: '9px 12px', color: C.dim, fontSize: 11, lineHeight: 1.55, borderBottom: `1px solid ${C.border}` }}>
        {reference ? <>
          {isDailyRange
            ? <>Referensi eksekusi: candle 4H <strong style={{ color: C.text }}>{reference.dateUtc} 00:00–04:00 UTC</strong> yang dibekukan saat trade dibuat.</>
            : <>Referensi: candle 4H <strong style={{ color: C.text }}>{reference.dateUtc} 00:00–04:00 UTC</strong> (hari kalender sebelum hari ini UTC).</>}
          Range high <strong style={{ color: C.accent }}>{formatPrice(reference.rangeHigh)}</strong> · range low <strong style={{ color: C.good }}>{formatPrice(reference.rangeLow)}</strong>.
          Acceptance memakai <strong style={{ color: C.text }}>dua close 5m selesai berturut-turut</strong> di luar level tersebut.
          {' '}Garis putus-putus ini tetap horizontal karena ini harga high/low range 4H yang dibekukan untuk eksekusi.
          {isDailyRange && <> Titik <strong style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>ENTRY {leg.side}</strong> di panel 5m adalah fill entry aktual pada waktu fill yang tersimpan.</>}
          {' '}Garis penuh oranye/biru di panel historis adalah resistance/support struktural: masing-masing menghubungkan dua pivot peak/trough selesai paling baru dan hanya untuk review visual.
          {' '}EMA20/EMA50 juga memakai completed candle saja; tidak mengubah formation, entry, sizing, atau exit.
        </> : <span>Level 4H UTC belum tersedia: {data?.referenceReason ?? 'memuat referensi'}</span>}
      </div>
      <div className="candle-review-chart-stack">
        <CandlePane title={historicalTitle} candles={historicalCandles} levels={dailyLevels} ariaLabel={`${leg.symbol} ${historicalInterval} candle chart`} headerRight={historicalControl} error={historicalError} showMovingAverages showStructuralTrendlines viewportKey={`${leg.key}:historical:${historicalInterval}`} viewportStore={viewportStore} />
        <CandlePane title={isDailyRange ? '5m · EMA20/EMA50 + breakout / breakdown + acceptance + native bracket' : '5m · EMA20/EMA50 + breakout / breakdown + acceptance threshold'} candles={data?.fiveMinute.candles ?? []} levels={fiveMinuteLevels} ariaLabel={`${leg.symbol} 5m candle chart`} showMovingAverages executionMarker={dailyRangeEntryMarker} viewportKey={`${leg.key}:5m`} viewportStore={viewportStore} />
      </div>
      {reference && <div style={{ padding: '0 12px 12px', color: C.dim, fontSize: 11, lineHeight: 1.55 }}>
        Status acceptance sekarang: <strong style={{ color: latestAcceptance === 'LONG' ? C.good : latestAcceptance === 'SHORT' ? C.bad : C.text }}>{latestAcceptance ? `${latestAcceptance} confirmed` : 'belum ada dua close 5m berturut-turut'}</strong>.
        {' '}Terakhir long {latestLongAcceptance ? formatUtc(latestLongAcceptance.at) + ' UTC' : '—'} · terakhir short {latestShortAcceptance ? formatUtc(latestShortAcceptance.at) + ' UTC' : '—'}.
        {' '}Garis acceptance sama dengan level breakout/breakdown—yang membedakan adalah dua close 5m, bukan harga baru—jadi tidak dibuat garis harga palsu kedua.
      </div>}
    </>}
  </section>;
}

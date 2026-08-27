import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type SeriesMarker,
  type Time,
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
// Cross-sectional has one compact review pane; Daily Range compares 4H and 5m side by side.
const CROSS_SECTIONAL_CHART_HEIGHT = 400;
const DAILY_RANGE_CHART_HEIGHT = 420;
const VOLUME_PANE_HEIGHT = 84;
const DEFAULT_VISIBLE_BARS = 96;
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
  entryPolicy?: 'LEGACY_CONTINUATION' | 'CONTINUATION' | 'FADE';
  tpMultipleR?: number | null;
  exitPolicyId?: string | null;
  thesisInvalidationType?: 'RANGE_REENTRY' | 'ORIGINAL_BREAKOUT_REACCEPTANCE' | null;
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
  timezone?: 'UTC' | 'America/New_York';
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
  entryPolicy?: 'LEGACY_CONTINUATION' | 'CONTINUATION' | 'FADE';
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

// Daily Range refreshes its trade card every 15 seconds, while this component refreshes its
// completed candles every 30 seconds.  A ref inside the component disappears if React remounts
// the card during either refresh, so retain the operator's viewport for this browser tab instead.
const viewportMemory = new Map<string, CandleViewport>();
// v2 intentionally starts a fresh default viewport: the old v1 default fitted all history and
// buried the current mark/entry at the far-right edge.  Once an operator pans or zooms, that
// view remains persisted exactly as before.
const VIEWPORT_STORAGE_PREFIX = 'dtc-candle-viewport:v2:';

function validViewport(value: unknown): value is CandleViewport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { from?: unknown; to?: unknown };
  return typeof candidate.from === 'number' && Number.isFinite(candidate.from)
    && typeof candidate.to === 'number' && Number.isFinite(candidate.to)
    && candidate.to > candidate.from;
}

function readViewport(viewportKey: string): CandleViewport | null {
  const inMemory = viewportMemory.get(viewportKey);
  if (inMemory) return inMemory;
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${VIEWPORT_STORAGE_PREFIX}${viewportKey}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!validViewport(parsed)) return null;
    viewportMemory.set(viewportKey, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function persistViewport(viewportKey: string, viewport: CandleViewport): void {
  viewportMemory.set(viewportKey, viewport);
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(`${VIEWPORT_STORAGE_PREFIX}${viewportKey}`, JSON.stringify(viewport));
  } catch {
    // Storage is an operator convenience only; retain the in-memory viewport if it is unavailable.
  }
}

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

function timeToMs(time: Time): number | null {
  if (typeof time === 'number') return time * 1_000;
  if (typeof time === 'string') {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return Date.UTC(time.year, time.month - 1, time.day);
}

/** Lightweight Charts always receives UTC timestamps. Render every operator-facing axis in Taipei. */
function formatTaipeiChartTime(time: Time): string {
  const ms = timeToMs(time);
  if (ms == null) return '';
  const date = new Date(ms);
  // Daily bars are anchored at 00:00 UTC. A date-only label is clearer than showing their
  // Taiwan conversion as 08:00, while all intraday bars retain a Taipei clock time.
  const isDailyAnchor = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  return new Intl.DateTimeFormat('en-GB', isDailyAnchor
    ? { day: '2-digit', month: 'short', timeZone: 'Asia/Taipei' }
    : { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' },
  ).format(date).replace(',', '');
}

function decimalPlaces(value: number): number {
  const text = Math.abs(value).toString().toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText == null ? 0 : Number(exponentText);
  const fraction = coefficient?.split('.')[1]?.length ?? 0;
  return Math.max(0, fraction - (Number.isFinite(exponent) ? exponent : 0));
}

/**
 * Binance's candle payload is numeric, so Lightweight Charts otherwise defaults to two decimals.
 * Keep enough exchange-facing precision for tiny contracts without exposing floating-point noise.
 */
function inferPriceFormat(candles: Candle[], levels: PriceLevel[]): { type: 'price'; precision: number; minMove: number } {
  const values = [
    ...candles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close]),
    ...levels.map((level) => level.price),
  ].filter((value) => Number.isFinite(value) && value > 0);
  const magnitude = values.length > 0 ? Math.max(...values) : 1;
  const baseline = magnitude < 0.0001 ? 10 : magnitude < 0.01 ? 8 : magnitude < 1 ? 6 : magnitude < 100 ? 4 : 2;
  const payloadPrecision = values.reduce((max, value) => Math.max(max, decimalPlaces(value)), 0);
  const precision = Math.max(0, Math.min(10, Math.max(baseline, payloadPrecision)));
  return { type: 'price', precision, minMove: 10 ** -precision };
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
  liveMarkPrice,
  chartHeight,
  viewportKey,
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
  /** Account-mark snapshot, intentionally distinct from completed-candle close. */
  liveMarkPrice?: number | null;
  /** Display-only canvas height selected by review kind. */
  chartHeight: number;
  /** Per leg/timeframe state survives card remounts and completed-candle refreshes. */
  viewportKey: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const displayedLevels = useMemo<PriceLevel[]>(() => [
    ...(liveMarkPrice != null && Number.isFinite(liveMarkPrice) && liveMarkPrice > 0
      ? [{ price: liveMarkPrice, label: 'Live mark', color: C.text }]
      : []),
    ...levels,
  ], [levels, liveMarkPrice]);

  useEffect(() => {
    const node = host.current;
    if (!node || candles.length === 0) return undefined;
    const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
    const chart = createChart(node, {
      width: Math.max(1, node.clientWidth),
      height: chartHeight,
      layout: { background: { type: ColorType.Solid, color: '#071016' }, textColor: '#8fa5ae', fontFamily: 'IBM Plex Mono, Cascadia Code, monospace' },
      grid: { vertLines: { color: 'rgba(38, 61, 72, 0.45)' }, horzLines: { color: 'rgba(38, 61, 72, 0.45)' } },
      rightPriceScale: { borderColor: '#29414c' },
      timeScale: {
        borderColor: '#29414c',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => formatTaipeiChartTime(time),
      },
      localization: { locale: 'en-GB', timeFormatter: (time: Time) => formatTaipeiChartTime(time) },
      crosshair: { vertLine: { color: 'rgba(143, 165, 174, 0.28)' }, horzLine: { color: 'rgba(143, 165, 174, 0.28)' } },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#5ce4a6', downColor: '#ff777d', borderVisible: false,
      wickUpColor: '#5ce4a6', wickDownColor: '#ff777d',
      priceFormat: inferPriceFormat(candles, displayedLevels),
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
    chart.panes()[1]?.setHeight(Math.min(VOLUME_PANE_HEIGHT, Math.round(chartHeight * 0.18)));
    for (const level of displayedLevels) {
      candleSeries.createPriceLine({
        price: level.price,
        color: level.color,
        lineWidth: level.label === 'Live mark' ? 1 : 2,
        lineStyle: level.label === 'Live mark' ? LineStyle.Solid : LineStyle.Dashed,
        // Level names and values live in the compact legend below.  Putting every long label
        // on the price scale made close-together range/SL/TP levels unreadable and rounded tiny
        // contract prices into the same visual value.
        axisLabelVisible: false,
        title: '',
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
          title: '',
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
          title: '',
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
        persistViewport(viewportKey, { from: range.from, to: range.to });
      }
    };
    const savedViewport = readViewport(viewportKey);
    if (savedViewport) chart.timeScale().setVisibleLogicalRange(savedViewport);
    else {
      // The first view is an operator view, not an archive chart: keep the current mark and
      // recent price action readable.  The full history remains one scroll/pan away.
      const to = Math.max(0, candles.length - 1 + 3);
      const from = Math.max(-3, to - Math.min(DEFAULT_VISIBLE_BARS, candles.length));
      chart.timeScale().setVisibleLogicalRange({ from, to });
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(saveViewport);
    const resize = () => chart.resize(Math.max(1, node.clientWidth), chartHeight);
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
  }, [candles, chartHeight, displayedLevels, executionMarker, showMovingAverages, showStructuralTrendlines, viewportKey]);

  return <div style={{ minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', background: C.sub }}>
    <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span>{title}</span>{headerRight}
    </div>
    {error
      ? <div style={{ padding: 12, color: C.bad, fontSize: 12 }}>Candle chart unavailable: {error}</div>
      : candles.length === 0
      ? <div style={{ padding: 12, color: C.dim, fontSize: 12 }}>Tidak ada completed candle dari USD-M untuk chart ini.</div>
      : <>
        <div ref={host} aria-label={ariaLabel} />
        <div className="candle-review-level-legend" aria-label={`${ariaLabel} level legend`}>
          {displayedLevels.map((level) => (
            <span key={`${level.label}:${level.price}`}>
              <i style={{ background: level.color }} />
              <b>{level.label}</b> {formatPrice(level.price)}
            </span>
          ))}
          {showMovingAverages && <><span><i style={{ background: C.ema20 }} /><b>EMA20</b></span><span><i style={{ background: C.ema50 }} /><b>EMA50</b></span></>}
          {showStructuralTrendlines && <><span><i style={{ background: C.structuralResistance }} /><b>Resistance</b></span><span><i style={{ background: C.structuralSupport }} /><b>Support</b></span></>}
        </div>
      </>}
  </div>;
}

export default function OpenBasketReviewChart({ apiPrefix, leg }: { apiPrefix: string; leg: OpenBasketReviewLeg | null }) {
  const [data, setData] = useState<ChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A 36h basket is operated from a live/recent view.  Daily context remains one click away,
  // but must not be the default that hides the current candle and mark.
  const [historicalInterval, setHistoricalInterval] = useState<HistoricalInterval>('1h');
  const [historicalSeries, setHistoricalSeries] = useState<IntervalChartResponse | null>(null);
  const [historicalSeriesError, setHistoricalSeriesError] = useState<string | null>(null);
  const [historicalLoading, setHistoricalLoading] = useState(false);
  const chartEndpoint = leg
    ? leg.chartEndpoint ?? `${apiPrefix}/live/open-basket-chart?symbol=${encodeURIComponent(leg.symbol)}`
    : null;
  // The full response remains the source of the frozen range reference.  The timeframe selector
  // only changes its historical candle series, using the same bounded public USD-M route on both
  // Testnet and Live.  Daily Range therefore never falls back to a recalculated reference range.
  const historicalEndpoint = leg
    ? `${apiPrefix}/live/open-basket-chart?symbol=${encodeURIComponent(leg.symbol)}&interval=${historicalInterval}`
    : null;

  // Cross baskets are monitored from a recent 1H view. Daily Range keeps its 4H structural
  // context beside the actual 5m execution path. A deliberate selector change still persists
  // while the same selected leg remains open.
  useEffect(() => {
    setHistoricalInterval(leg?.reviewKind === 'daily-range' ? '4h' : '1h');
  }, [leg?.key, leg?.reviewKind]);

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

  const isDailyRange = leg?.reviewKind === 'daily-range';
  const reference = data?.reference4h ?? data?.previousUtcReference4h ?? null;
  const entryPolicy = data?.entryPolicy ?? leg?.entryPolicy ?? 'LEGACY_CONTINUATION';
  const isAutoRouterTrade = entryPolicy === 'CONTINUATION' || entryPolicy === 'FADE';
  const referenceSession = reference?.timezone === 'America/New_York' ? '00:00–04:00 New York' : '00:00–04:00 UTC';
  const historicalCandles = historicalInterval === '1d'
    ? data?.daily.candles ?? []
    : historicalSeries?.candles ?? [];
  const historicalAsOf = historicalInterval === '1d' ? data?.asOf : historicalSeries?.asOf ?? data?.asOf;
  const historicalError = historicalInterval === '1d' ? null : historicalSeriesError;
  // These props feed the imperative chart effect.  Keep their identities stable through the
  // parent card's 15s status refresh, otherwise React tears down and redraws the chart despite
  // no candle data changing.
  const tradeLevels = useMemo<PriceLevel[]>(() => !isDailyRange || !leg ? [] : [
    { price: leg.entryPrice, label: 'Entry', color: C.measure },
    ...(leg.stopPrice != null && Number.isFinite(leg.stopPrice)
      ? [{ price: leg.stopPrice, label: 'Native SL', color: C.bad }]
      : []),
    ...(leg.takeProfitPrice != null && Number.isFinite(leg.takeProfitPrice)
      ? [{ price: leg.takeProfitPrice, label: `Native ${leg.tpMultipleR ?? 2}R TP`, color: C.good }]
      : []),
  ], [isDailyRange, leg?.entryPrice, leg?.stopPrice, leg?.takeProfitPrice, leg?.tpMultipleR]);
  const dailyLevels = useMemo<PriceLevel[]>(() => reference ? [
    { price: reference.rangeHigh, label: '4H range high · execution breakout', color: C.accent },
    { price: reference.rangeLow, label: '4H range low · execution breakdown', color: C.good },
    ...tradeLevels,
  ] : tradeLevels, [reference?.rangeHigh, reference?.rangeLow, tradeLevels]);
  const fiveMinuteLevels = useMemo<PriceLevel[]>(() => reference ? [
    { price: reference.rangeHigh, label: '4H range high · breakout', color: C.accent },
    { price: reference.rangeLow, label: '4H range low · breakdown', color: C.bad },
    ...tradeLevels,
  ] : tradeLevels, [reference?.rangeHigh, reference?.rangeLow, tradeLevels]);
  const dailyRangeEntryMarker = useMemo<ExecutionMarker | null>(() => isDailyRange && leg?.openedAt && (leg.entryPrice ?? 0) > 0
    ? {
      at: leg.openedAt,
      price: leg.entryPrice,
      side: leg.side,
      label: `ENTRY ${leg.side}`,
    }
    : null, [isDailyRange, leg?.openedAt, leg?.entryPrice, leg?.side]);

  if (!leg) {
    return <section className="testnet-panel testnet-wide-panel candle-review-card" id="open-basket-review-chart">
      <header><div><span>Basket candle review</span><strong>Menunggu basket aktif</strong></div></header>
      <div style={{ padding: 12, color: C.dim, fontSize: 12 }}>Saat ada basket aktif, klik simbolnya di tabel untuk membuka candle live/recent. Tidak ada dropdown simbol.</div>
    </section>;
  }
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
  const historicalTitle = `${historicalIntervalLabel(historicalInterval)} · context candle`;
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
    <div className="candle-review-summary">
      <span><b>{ownerNoun}</b> {leg.basketId}</span>
      <span><b>entry</b> {formatPrice(leg.entryPrice)}</span>
      <span><b>live mark</b> {formatPrice(leg.markPrice)}</span>
      <span style={{ color: leg.grossUnrealizedUsd == null ? C.dim : leg.grossUnrealizedUsd >= 0 ? C.good : C.bad }}><b>{isDailyRange ? 'gross mark P&L' : 'leg P&L'}</b> {formatMoney(leg.grossUnrealizedUsd)}</span>
      {isDailyRange && <span><b>native bracket</b> SL {formatPrice(leg.stopPrice)} · TP {leg.tpMultipleR ?? 2}R {formatPrice(leg.takeProfitPrice)}</span>}
      {isDailyRange && leg.thesisInvalidationType && <span><b>logic exit</b> {leg.thesisInvalidationType === 'RANGE_REENTRY' ? '5m range re-entry' : '5m breakout re-acceptance'}</span>}
      <span><b>open</b> {formatTaipei(leg.openedAt)} Taipei</span>
    </div>
    {error ? <div style={{ padding: 12, color: C.bad, fontSize: 12 }}>Candle chart unavailable: {error}</div> : <>
      <details className="candle-review-guide">
        <summary>Guide level & data chart</summary>
        {reference ? <div>
          {isDailyRange
            ? <>Referensi eksekusi: session <strong style={{ color: C.text }}>{reference.dateUtc} {referenceSession}</strong> yang dibekukan saat trade dibuat.</>
            : <>Referensi: candle 4H <strong style={{ color: C.text }}>{reference.dateUtc} 00:00–04:00 UTC</strong> (hari kalender sebelum hari ini UTC).</>}
          {' '}Range high <strong style={{ color: C.accent }}>{formatPrice(reference.rangeHigh)}</strong> · range low <strong style={{ color: C.good }}>{formatPrice(reference.rangeLow)}</strong>.
          {isDailyRange && entryPolicy === 'FADE'
            ? <> Router: satu close 5m selesai di luar, lalu close kembali masuk range → <strong style={{ color: C.text }}>FADE</strong> berlawanan arah dengan SL di extreme breakout.</>
            : isDailyRange && entryPolicy === 'CONTINUATION'
              ? <> Router: close 5m tetap di luar dan <strong style={{ color: C.text }}>meluas lebih jauh</strong> → <strong style={{ color: C.text }}>CONTINUATION</strong> mengikuti arah breakout.</>
              : <> Acceptance memakai <strong style={{ color: C.text }}>dua close 5m selesai berturut-turut</strong> di luar level tersebut.</>}
          {' '}Semua candle adalah USD-M completed candle; `Live mark` adalah snapshot akun terbaru dan bukan candle atau prediksi. EMA/structure hanya review visual, tidak mengubah formation, entry, sizing, atau exit.
        </div> : <span>Level Daily Range belum tersedia: {data?.referenceReason ?? 'memuat referensi'}</span>}
      </details>
      <div className={`candle-review-chart-stack${isDailyRange ? ' candle-review-chart-stack--daily-range' : ''}`}>
        <CandlePane title={historicalTitle} candles={historicalCandles} levels={dailyLevels} ariaLabel={`${leg.symbol} ${historicalInterval} candle chart`} headerRight={historicalControl} error={historicalError} showMovingAverages showStructuralTrendlines liveMarkPrice={leg.markPrice} chartHeight={isDailyRange ? DAILY_RANGE_CHART_HEIGHT : CROSS_SECTIONAL_CHART_HEIGHT} viewportKey={`${apiPrefix}:${leg.key}:historical:${historicalInterval}`} />
        {isDailyRange && <CandlePane title="5m · actual execution path" candles={data?.fiveMinute.candles ?? []} levels={fiveMinuteLevels} ariaLabel={`${leg.symbol} 5m candle chart`} showMovingAverages executionMarker={dailyRangeEntryMarker} liveMarkPrice={leg.markPrice} chartHeight={DAILY_RANGE_CHART_HEIGHT} viewportKey={`${apiPrefix}:${leg.key}:5m`} />}
      </div>
      {reference && <div className="candle-review-status-line">
        {isAutoRouterTrade
          ? <>Policy entry trade ini: <strong style={{ color: entryPolicy === 'FADE' ? C.accent : C.good }}>{entryPolicy}</strong>. Satu breakout event hanya menghasilkan satu kandidat; router tidak membalik posisi continuation yang sudah terbentuk.</>
          : <>Status acceptance sekarang: <strong style={{ color: latestAcceptance === 'LONG' ? C.good : latestAcceptance === 'SHORT' ? C.bad : C.text }}>{latestAcceptance ? `${latestAcceptance} confirmed` : 'belum ada dua close 5m berturut-turut'}</strong>.
            {' '}Terakhir long {latestLongAcceptance ? formatTaipei(latestLongAcceptance.at) + ' Taipei' : '—'} · terakhir short {latestShortAcceptance ? formatTaipei(latestShortAcceptance.at) + ' Taipei' : '—'}.
            {' '}Garis acceptance sama dengan level breakout/breakdown—yang membedakan adalah dua close 5m, bukan harga baru—jadi tidak dibuat garis harga palsu kedua.</>}
      </div>}
    </>}
  </section>;
}

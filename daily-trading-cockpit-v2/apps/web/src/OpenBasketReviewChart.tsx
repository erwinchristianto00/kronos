import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BaselineSeries,
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
  entryPolicy?: 'LEGACY_CONTINUATION' | 'CONTINUATION' | 'FADE';
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
  /** Immutable execution lineage from the Daily Range trade record, never reconstructed in the UI. */
  entryEvidence?: {
    entryPolicy: 'LEGACY_CONTINUATION' | 'CONTINUATION' | 'FADE';
    breakoutDirection: 'UP' | 'DOWN' | null;
    breakoutExtreme: number | null;
    signalTimestamp: string | null;
    confirmationBar1: Candle | null;
    confirmationBar2: Candle | null;
  };
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

/** Marker attached only to a completed 5m candle whose time is explicitly stored in lineage. */
type CandleChartMarker = {
  at: number;
  price: number;
  label: string;
  position: 'aboveBar' | 'belowBar' | 'atPriceMiddle';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
};

/** The shaded bands are visualizations of the already-persisted native bracket, not a new policy. */
type TradeRiskZones = {
  entryPrice: number;
  stopPrice: number | null | undefined;
  takeProfitPrice: number | null | undefined;
  startsAt: string;
};

type CandleViewport = { from: number; to: number };

// Daily Range refreshes its trade card every 15 seconds, while this component refreshes its
// completed candles every 30 seconds.  A ref inside the component disappears if React remounts
// the card during either refresh, so retain the operator's viewport for this browser tab instead.
const viewportMemory = new Map<string, CandleViewport>();
const VIEWPORT_STORAGE_PREFIX = 'dtc-candle-viewport:v1:';

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

function historicalIntervalLabel(interval: HistoricalInterval): string {
  return HISTORICAL_INTERVALS.find((item) => item.value === interval)?.label ?? interval;
}

function markerForCompletedFiveMinuteCandle(
  candles: Candle[],
  marker: CandleChartMarker,
): SeriesMarker<UTCTimestamp> | null {
  if (!Number.isFinite(marker.at) || !(marker.price > 0)) return null;
  const matchingCandle = candles.find((candle) => candle.openTime === marker.at);
  if (!matchingCandle) return null;
  return {
    time: Math.floor(matchingCandle.openTime / 1000) as UTCTimestamp,
    position: marker.position,
    price: marker.price,
    shape: marker.shape,
    size: 2,
    color: marker.color,
    text: marker.label,
  };
}

function priceDecimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = Math.abs(value).toString().toLowerCase();
  const match = text.match(/^\d+(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) return 0;
  return Math.max(0, (match[1]?.length ?? 0) - Number(match[2] ?? 0));
}

function chartPricePrecision(candles: Candle[], levels: PriceLevel[]): number {
  const values = [
    ...candles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close]),
    ...levels.map((level) => level.price),
  ];
  return Math.min(10, Math.max(2, ...values.map(priceDecimalPlaces)));
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
  markers = [],
  riskZones,
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
  /** Only used by Daily Range's 5m panel and built from persisted C1/C2/fill evidence. */
  markers?: CandleChartMarker[];
  /** Only used by Daily Range's 5m panel for its existing native SL/TP bracket. */
  riskZones?: TradeRiskZones | null;
  /** Per leg/timeframe state survives card remounts and completed-candle refreshes. */
  viewportKey: string;
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
    const pricePrecision = chartPricePrecision(candles, levels);
    const toSeriesTime = (candle: Candle) => toTime(candle.openTime);
    if (riskZones && riskZones.entryPrice > 0) {
      const fillAt = Date.parse(riskZones.startsAt);
      const firstRiskCandle = candles.find((candle) => fillAt >= candle.openTime && fillAt < candle.openTime + 5 * 60_000);
      const riskCandles = firstRiskCandle
        ? candles.filter((candle) => candle.openTime >= firstRiskCandle.openTime)
        : [];
      const addRiskZone = (price: number | null | undefined, color: string) => {
        if (price == null || !Number.isFinite(price) || !(price > 0) || price === riskZones.entryPrice || riskCandles.length === 0) return;
        const aboveEntry = price > riskZones.entryPrice;
        const transparent = 'rgba(0, 0, 0, 0)';
        const zone = chart.addSeries(BaselineSeries, {
          baseValue: { type: 'price', price: riskZones.entryPrice },
          priceFormat: {
            type: 'price',
            precision: pricePrecision,
            minMove: 1 / 10 ** pricePrecision,
          },
          topFillColor1: aboveEntry ? color : transparent,
          topFillColor2: aboveEntry ? color : transparent,
          bottomFillColor1: aboveEntry ? transparent : color,
          bottomFillColor2: aboveEntry ? transparent : color,
          topLineColor: transparent,
          bottomLineColor: transparent,
          lineVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        zone.setData(riskCandles.map((candle) => ({ time: toSeriesTime(candle), value: price })));
      };
      // Green = favorable 2R path; red = adverse 1R path.  Both begin on the factual fill candle.
      addRiskZone(riskZones.takeProfitPrice, 'rgba(70, 211, 154, 0.15)');
      addRiskZone(riskZones.stopPrice, 'rgba(255, 107, 107, 0.15)');
    }
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#5ce4a6', downColor: '#ff777d', borderVisible: false,
      wickUpColor: '#5ce4a6', wickDownColor: '#ff777d',
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: 1 / 10 ** pricePrecision,
      },
    });
    candleSeries.setData(candles.map((candle) => ({
      time: toTime(candle.openTime), open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    })));
    if (markers.length > 0) {
      const completedMarkers = markers
        .map((marker) => markerForCompletedFiveMinuteCandle(candles, marker))
        .filter((marker): marker is SeriesMarker<UTCTimestamp> => marker !== null);
      if (completedMarkers.length > 0) createSeriesMarkers(candleSeries, completedMarkers);
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
        persistViewport(viewportKey, { from: range.from, to: range.to });
      }
    };
    const savedViewport = readViewport(viewportKey);
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
  }, [candles, levels, markers, riskZones, showMovingAverages, showStructuralTrendlines, viewportKey]);

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
  const isDailyRange = leg?.reviewKind === 'daily-range';
  const [data, setData] = useState<ChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [historicalInterval, setHistoricalInterval] = useState<HistoricalInterval>('1d');
  const [historicalSeries, setHistoricalSeries] = useState<IntervalChartResponse | null>(null);
  const [historicalSeriesError, setHistoricalSeriesError] = useState<string | null>(null);
  const [historicalLoading, setHistoricalLoading] = useState(false);
  const historicalDisplayInterval: HistoricalInterval = isDailyRange ? historicalInterval : '1d';
  const chartEndpoint = leg
    ? leg.chartEndpoint ?? `${apiPrefix}/live/open-basket-chart?symbol=${encodeURIComponent(leg.symbol)}`
    : null;
  // The full response remains the source of the frozen range reference.  The timeframe selector
  // only changes its historical candle series, using the same bounded public USD-M route on both
  // Testnet and Live.  Daily Range therefore never falls back to a recalculated reference range.
  const historicalEndpoint = leg
    ? `${apiPrefix}/live/open-basket-chart?symbol=${encodeURIComponent(leg.symbol)}&interval=${historicalDisplayInterval}`
    : null;

  // Cross-sectional review is deliberately one 1D chart.  A Daily Range trade keeps its two
  // purpose-specific views and opens its historical review at 4H by default.
  useEffect(() => {
    if (!leg) return;
    setHistoricalInterval(isDailyRange ? '4h' : '1d');
  }, [isDailyRange, leg?.key]);

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
    if (!leg || historicalDisplayInterval === '1d') {
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
        if (!response.ok || body.ok !== true || body.interval !== historicalDisplayInterval || !Array.isArray(body.candles)) {
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
  }, [historicalDisplayInterval, historicalEndpoint, leg?.key]);

  const reference = data?.reference4h ?? data?.previousUtcReference4h ?? null;
  const entryPolicy = data?.entryEvidence?.entryPolicy ?? data?.entryPolicy ?? leg?.entryPolicy ?? 'LEGACY_CONTINUATION';
  const referenceSession = reference?.timezone === 'America/New_York' ? '00:00–04:00 New York' : '00:00–04:00 UTC';
  const historicalCandles = historicalDisplayInterval === '1d'
    ? data?.daily.candles ?? []
    : historicalSeries?.candles ?? [];
  const historicalAsOf = historicalDisplayInterval === '1d' ? data?.asOf : historicalSeries?.asOf ?? data?.asOf;
  const historicalError = historicalDisplayInterval === '1d' ? null : historicalSeriesError;
  // These props feed the imperative chart effect.  Keep their identities stable through the
  // parent card's 15s status refresh, otherwise React tears down and redraws the chart despite
  // no candle data changing.
  const tradeLevels = useMemo<PriceLevel[]>(() => !isDailyRange || !leg ? [] : [
    { price: leg.entryPrice, label: 'Entry', color: C.measure },
    ...(leg.stopPrice != null && Number.isFinite(leg.stopPrice)
      ? [{ price: leg.stopPrice, label: 'Native SL', color: C.bad }]
      : []),
    ...(leg.takeProfitPrice != null && Number.isFinite(leg.takeProfitPrice)
      ? [{ price: leg.takeProfitPrice, label: 'Native 2R TP', color: C.good }]
      : []),
  ], [isDailyRange, leg?.entryPrice, leg?.stopPrice, leg?.takeProfitPrice]);
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
  const dailyRangeMarkers = useMemo<CandleChartMarker[]>(() => {
    if (!isDailyRange || !leg || !data) return [];
    const markers: CandleChartMarker[] = [];
    const evidence = data.entryEvidence;
    const direction = evidence?.breakoutDirection;
    const breakoutUp = direction === 'UP';
    const breakoutDown = direction === 'DOWN';
    const breakoutPosition = breakoutUp ? 'belowBar' : 'aboveBar';
    const breakoutShape = breakoutUp ? 'arrowUp' : 'arrowDown';
    if (evidence?.confirmationBar1 && (breakoutUp || breakoutDown)) {
      markers.push({
        at: evidence.confirmationBar1.openTime,
        price: evidence.confirmationBar1.close,
        label: `C1 BREAKOUT ${breakoutUp ? '↑' : '↓'} · close ${formatPrice(evidence.confirmationBar1.close)}`,
        position: breakoutPosition,
        shape: breakoutShape,
        color: C.accent,
      });
    }
    if (evidence?.confirmationBar2) {
      const policyLabel = entryPolicy === 'FADE'
        ? `C2 RE-ENTRY → FADE ${leg.side}`
        : entryPolicy === 'CONTINUATION'
          ? `C2 CONTINUATION ${leg.side}`
          : `C2 CONFIRMATION ${leg.side}`;
      markers.push({
        at: evidence.confirmationBar2.openTime,
        price: evidence.confirmationBar2.close,
        label: `${policyLabel} · close ${formatPrice(evidence.confirmationBar2.close)}`,
        position: leg.side === 'LONG' ? 'belowBar' : 'aboveBar',
        shape: leg.side === 'LONG' ? 'arrowUp' : 'arrowDown',
        color: leg.side === 'LONG' ? C.good : C.bad,
      });
    }
    const fillAt = Date.parse(leg.openedAt);
    const fillCandle = data.fiveMinute.candles.find((candle) => fillAt >= candle.openTime && fillAt < candle.openTime + 5 * 60_000);
    if (fillCandle && leg.entryPrice > 0) {
      markers.push({
        at: fillCandle.openTime,
        price: leg.entryPrice,
        label: `FILL ${leg.side} · ${formatPrice(leg.entryPrice)}`,
        position: 'atPriceMiddle',
        shape: 'circle',
        color: C.text,
      });
    }
    return markers;
  }, [
    data,
    entryPolicy,
    isDailyRange,
    leg?.entryPrice,
    leg?.openedAt,
    leg?.side,
  ]);
  const dailyRangeRiskZones = useMemo<TradeRiskZones | null>(() => isDailyRange && leg?.openedAt && leg.entryPrice > 0
    ? {
      entryPrice: leg.entryPrice,
      stopPrice: leg.stopPrice,
      takeProfitPrice: leg.takeProfitPrice,
      startsAt: leg.openedAt,
    }
    : null, [isDailyRange, leg?.entryPrice, leg?.openedAt, leg?.stopPrice, leg?.takeProfitPrice]);

  if (!leg) {
    return <section className="testnet-panel testnet-wide-panel candle-review-card" id="open-basket-review-chart">
      <header><div><span>Basket candle review</span><strong>Menunggu basket aktif</strong></div></header>
      <div style={{ padding: 12, color: C.dim, fontSize: 12 }}>Saat ada basket aktif, klik simbolnya di tabel untuk membuka candle 1D dan 5m. Tidak ada dropdown simbol.</div>
    </section>;
  }
  const reviewTitle = isDailyRange ? 'Daily Range 4H candle review · klik trade' : 'Basket candle review · klik leg di tabel';
  const ownerNoun = isDailyRange ? 'trade' : 'basket';
  const historicalTitle = `${historicalIntervalLabel(historicalDisplayInterval)} · EMA20/EMA50 + structural support / resistance`;
  const historicalControl = isDailyRange ? <label style={{ color: C.dim, fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap' }}>
    candle{' '}
    <select
      aria-label="Historical candle timeframe"
      value={historicalInterval}
      onChange={(event) => setHistoricalInterval(event.target.value as HistoricalInterval)}
      style={{ background: '#0a151b', color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 5px', fontSize: 11 }}
    >
      {HISTORICAL_INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  </label> : undefined;

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
            ? <>Referensi eksekusi: session <strong style={{ color: C.text }}>{reference.dateUtc} {referenceSession}</strong> yang dibekukan saat trade dibuat.</>
            : <>Referensi: candle 4H <strong style={{ color: C.text }}>{reference.dateUtc} 00:00–04:00 UTC</strong> (hari kalender sebelum hari ini UTC).</>}
          Range high <strong style={{ color: C.accent }}>{formatPrice(reference.rangeHigh)}</strong> · range low <strong style={{ color: C.good }}>{formatPrice(reference.rangeLow)}</strong>.
          {isDailyRange && entryPolicy === 'FADE'
            ? <>Router: satu close 5m selesai di luar, lalu close kembali masuk range → <strong style={{ color: C.text }}>FADE</strong> berlawanan arah dengan SL di extreme breakout.</>
            : isDailyRange && entryPolicy === 'CONTINUATION'
              ? <>Router: close 5m tetap di luar dan <strong style={{ color: C.text }}>meluas lebih jauh</strong> → <strong style={{ color: C.text }}>CONTINUATION</strong> mengikuti arah breakout.</>
              : <>Chart ini memakai candle selesai saja; tidak ada wick-only trigger.</>}
          {' '}Garis putus-putus ini tetap horizontal karena ini harga high/low range 4H yang dibekukan untuk eksekusi.
          {isDailyRange && <> Panel 5m menandai <strong style={{ color: C.accent }}>C1 breakout</strong>, <strong style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>C2 {entryPolicy === 'FADE' ? 're-entry / fade' : 'continuation'}</strong>, lalu <strong style={{ color: C.text }}>fill exchange aktual</strong> secara terpisah. Arsiran hijau = jalur TP 2R; merah = risiko sampai native SL, keduanya dimulai pada candle fill.</>}
          {' '}Garis penuh oranye/biru di panel historis adalah resistance/support struktural: masing-masing menghubungkan dua pivot peak/trough selesai paling baru dan hanya untuk review visual.
          {' '}EMA20/EMA50 juga memakai completed candle saja; tidak mengubah formation, entry, sizing, atau exit.
        </> : <span>Level Daily Range belum tersedia: {data?.referenceReason ?? 'memuat referensi'}</span>}
      </div>
      <div className="candle-review-chart-stack">
        <CandlePane title={historicalTitle} candles={historicalCandles} levels={dailyLevels} ariaLabel={`${leg.symbol} ${historicalDisplayInterval} candle chart`} headerRight={historicalControl} error={historicalError} showMovingAverages showStructuralTrendlines viewportKey={`${apiPrefix}:${leg.key}:historical:${historicalDisplayInterval}`} />
        {isDailyRange && <CandlePane title="5m · EMA20/EMA50 + C1/C2 router + native TP/SL" candles={data?.fiveMinute.candles ?? []} levels={fiveMinuteLevels} ariaLabel={`${leg.symbol} 5m candle chart`} showMovingAverages markers={dailyRangeMarkers} riskZones={dailyRangeRiskZones} viewportKey={`${apiPrefix}:${leg.key}:5m`} />}
      </div>
      {reference && isDailyRange && <div style={{ padding: '0 12px 12px', color: C.dim, fontSize: 11, lineHeight: 1.55 }}>
        Policy entry trade ini: <strong style={{ color: entryPolicy === 'FADE' ? C.accent : C.good }}>{entryPolicy}</strong>. C1/C2 ditampilkan dari record trade yang sama dengan entry; tidak diganti oleh candle yang datang setelah posisi dibuka.
      </div>}
    </>}
  </section>;
}

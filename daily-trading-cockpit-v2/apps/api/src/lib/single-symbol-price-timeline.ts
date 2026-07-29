/**
 * BTC/ETH/SOL execution timeline.
 *
 * This is intentionally a transparent, short-horizon technical consensus, not a claim that a
 * deterministic price prediction exists. It turns the same candle inputs shown to the operator
 * into a strict ENTER / WAIT / EXIT decision for the already-wired single-symbol lanes. It never
 * manufactures an order by itself: a lane must still provide a fresh, valid signal and its normal
 * exchange-side stop remains authoritative.
 */
import {
  calculateTimeframeIndicators,
  clamp,
  macd,
  type Candle,
  type TimeframeIndicatorSnapshot,
} from "@dtc/shared";

export const SINGLE_SYMBOL_TIMELINE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
export type SingleSymbolTimelineSymbol = (typeof SINGLE_SYMBOL_TIMELINE_SYMBOLS)[number];
export type SingleSymbolTimelineDirective = "ENTER_LONG" | "ENTER_SHORT" | "WAIT";
export type SingleSymbolTimelineTurningPoint = "BOTTOM_CONFIRMED" | "BOTTOM_WATCH" | "TOP_CONFIRMED" | "TOP_WATCH" | "NONE";

export type SingleSymbolPriceTimelinePoint = { at: string; price: number };

export interface SingleSymbolPriceForecast {
  hours: 1 | 3 | 6;
  targetPrice: number;
  lowerPrice: number;
  upperPrice: number;
  expectedMovePct: number;
}

export interface SingleSymbolPriceTimelineSymbolState {
  symbol: SingleSymbolTimelineSymbol;
  available: boolean;
  reason: string | null;
  updatedAt: string | null;
  price: number | null;
  points: SingleSymbolPriceTimelinePoint[];
  score: number | null;
  confidence: number | null;
  directive: SingleSymbolTimelineDirective;
  turningPoint: SingleSymbolTimelineTurningPoint;
  entryReason: string;
  exitLongReason: string | null;
  exitShortReason: string | null;
  forecasts: SingleSymbolPriceForecast[];
  indicators: {
    m5: Pick<TimeframeIndicatorSnapshot, "ema20" | "ema50" | "rsi14" | "atrPercent" | "vwap" | "volumeRatio" | "support" | "resistance" | "trend"> | null;
    h1: Pick<TimeframeIndicatorSnapshot, "ema20" | "ema50" | "ema200" | "rsi14" | "atrPercent" | "vwap" | "volumeRatio" | "support" | "resistance" | "trend"> | null;
  };
}

export interface SingleSymbolPriceTimelineSnapshot {
  generatedAt: string;
  enabledForExecution: boolean;
  note: string;
  symbols: SingleSymbolPriceTimelineSymbolState[];
}

export type TimelineCandleFetcher = (symbol: string, interval: "5m" | "1h", limit: number) => Promise<Candle[]>;

export interface TimelineEntryGateResult {
  allowed: boolean;
  reason: string | null;
}

export interface TimelineExitGateResult {
  shouldExit: boolean;
  reason: string | null;
}

const HORIZONS = [1, 3, 6] as const;
const REFRESH_MS = 45_000;
const MAX_DATA_AGE_MS = 3 * 60_000;

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function returnPct(closes: readonly number[], bars: number): number {
  const last = closes.at(-1) ?? 0;
  const earlier = closes.at(-(bars + 1)) ?? 0;
  return earlier > 0 ? (last - earlier) / earlier : 0;
}

function macdScore(closes: readonly number[], atrValue: number): number {
  const latest = macd([...closes]);
  const previous = macd(closes.slice(0, -1));
  const scale = Math.max(atrValue, Math.abs(closes.at(-1) ?? 0) * 0.001, 1e-9);
  return clamp(((latest.histogram / scale) * 0.65) + ((latest.histogram - previous.histogram) / scale) * 0.35, -1, 1);
}

function emaScore(indicator: TimeframeIndicatorSnapshot): number {
  const price = indicator.latestClose;
  let score = 0;
  score += price >= indicator.ema20 ? 0.35 : -0.35;
  score += indicator.ema20 >= indicator.ema50 ? 0.35 : -0.35;
  score += price >= indicator.vwap ? 0.2 : -0.2;
  if (indicator.timeframe === "1h") {
    if (indicator.ema200 === null) return -1;
    score += price >= indicator.ema200 ? 0.25 : -0.25;
  }
  return clamp(score, -1, 1);
}

function rsiScore(value: number): number {
  // Mildly directional in the central zone; do not turn an overbought/oversold read into an entry.
  return clamp((value - 50) / 24, -1, 1);
}

function bandScore(indicator: TimeframeIndicatorSnapshot): number {
  const width = Math.max(indicator.bollingerBands20.upper - indicator.bollingerBands20.lower, indicator.latestClose * 0.001);
  return clamp((indicator.latestClose - indicator.bollingerBands20.middle) / (width / 2), -1, 1);
}

function summary(indicator: TimeframeIndicatorSnapshot): Pick<TimeframeIndicatorSnapshot, "ema20" | "ema50" | "ema200" | "rsi14" | "atrPercent" | "vwap" | "volumeRatio" | "support" | "resistance" | "trend"> {
  return {
    ema20: indicator.ema20,
    ema50: indicator.ema50,
    ema200: indicator.ema200,
    rsi14: indicator.rsi14,
    atrPercent: indicator.atrPercent,
    vwap: indicator.vwap,
    volumeRatio: indicator.volumeRatio,
    support: indicator.support,
    resistance: indicator.resistance,
    trend: indicator.trend,
  };
}

function buildUnavailable(symbol: SingleSymbolTimelineSymbol, reason: string): SingleSymbolPriceTimelineSymbolState {
  return {
    symbol,
    available: false,
    reason,
    updatedAt: null,
    price: null,
    points: [],
    score: null,
    confidence: null,
    directive: "WAIT",
    turningPoint: "NONE",
    entryReason: `WAIT: ${reason}`,
    exitLongReason: null,
    exitShortReason: null,
    forecasts: [],
    indicators: { m5: null, h1: null },
  };
}

/** Pure technical consensus for a pre-fetched candle set. Kept pure so decisions are testable
 * without a live exchange and no future candle can enter the score. */
export function buildSingleSymbolPriceTimelineState(
  symbol: SingleSymbolTimelineSymbol,
  candles: { m5: Candle[]; h1: Candle[] },
  nowMs = Date.now(),
): SingleSymbolPriceTimelineSymbolState {
  if (candles.m5.length < 60 || candles.h1.length < 250) {
    return buildUnavailable(symbol, "insufficient 5m/1h candle history");
  }
  let m5: TimeframeIndicatorSnapshot;
  let h1: TimeframeIndicatorSnapshot;
  try {
    m5 = calculateTimeframeIndicators(candles.m5, "5m", nowMs);
    h1 = calculateTimeframeIndicators(candles.h1, "1h", nowMs);
  } catch (error) {
    return buildUnavailable(symbol, error instanceof Error ? error.message : "indicator calculation failed");
  }
  if (!m5.isFresh || !h1.isFresh) return buildUnavailable(symbol, "5m or 1h candle feed is stale");
  if (!h1.ema200Available) return buildUnavailable(symbol, "insufficient completed 1h candles for EMA200");

  const m5Closes = candles.m5.map((c) => c.close);
  const h1Closes = candles.h1.map((c) => c.close);
  const m5Momentum = clamp(returnPct(m5Closes, 6) / Math.max((m5.atrPercent / 100) * 2, 0.001), -1, 1);
  const h1Momentum = clamp(returnPct(h1Closes, 6) / Math.max((h1.atrPercent / 100) * 2, 0.001), -1, 1);
  const m5Macd = macdScore(m5Closes, Math.max(m5.atr14, 1e-9));
  const h1Macd = macdScore(h1Closes, Math.max(h1.atr14, 1e-9));
  const tactical = clamp(0.35 * emaScore(m5) + 0.22 * m5Macd + 0.18 * rsiScore(m5.rsi14) + 0.15 * bandScore(m5) + 0.1 * m5Momentum, -1, 1);
  const trend = clamp(0.42 * emaScore(h1) + 0.25 * h1Macd + 0.18 * rsiScore(h1.rsi14) + 0.15 * h1Momentum, -1, 1);
  const score = clamp(0.62 * trend + 0.38 * tactical, -1, 1);
  const directionalAgreement = Math.sign(trend) === Math.sign(tactical) && Math.abs(trend) >= 0.15 && Math.abs(tactical) >= 0.15;
  // A null baseline (bad/insufficient feed data) must never read as "confirmed" — that would let a
  // missing signal grant the same gate pass/confidence bonus as a genuinely-average volume reading.
  const volumeConfirm = m5.volumeRatio !== null && m5.volumeRatio >= 0.85;
  const confidence = clamp(0.42 + Math.abs(score) * 0.36 + (directionalAgreement ? 0.16 : 0) + (volumeConfirm ? 0.06 : 0), 0, 0.95);
  const lowerBandTouch = m5.latestClose <= m5.bollingerBands20.lower * 1.004;
  const upperBandTouch = m5.latestClose >= m5.bollingerBands20.upper * 0.996;
  const bottomConfirmed = lowerBandTouch && m5.rsi14 <= 42 && m5Macd > 0.08 && m5Momentum > 0;
  const topConfirmed = upperBandTouch && m5.rsi14 >= 58 && m5Macd < -0.08 && m5Momentum < 0;
  const turningPoint: SingleSymbolTimelineTurningPoint = bottomConfirmed
    ? "BOTTOM_CONFIRMED"
    : topConfirmed
      ? "TOP_CONFIRMED"
      : lowerBandTouch && m5.rsi14 <= 38
        ? "BOTTOM_WATCH"
        : upperBandTouch && m5.rsi14 >= 62
          ? "TOP_WATCH"
          : "NONE";

  const longReady = score >= 0.34 && confidence >= 0.64 && trend >= 0.18 && m5.rsi14 < 72 && volumeConfirm;
  const shortReady = score <= -0.34 && confidence >= 0.64 && trend <= -0.18 && m5.rsi14 > 28 && volumeConfirm;
  const directive: SingleSymbolTimelineDirective = longReady ? "ENTER_LONG" : shortReady ? "ENTER_SHORT" : "WAIT";
  const entryReason = directive === "ENTER_LONG"
    ? `ENTER LONG: consensus ${signed(score)} / ${(confidence * 100).toFixed(0)}% · H1 + 5m aligned`
    : directive === "ENTER_SHORT"
      ? `ENTER SHORT: consensus ${signed(score)} / ${(confidence * 100).toFixed(0)}% · H1 + 5m aligned`
      : `WAIT: consensus ${signed(score)} / ${(confidence * 100).toFixed(0)}%${turningPoint !== "NONE" ? ` · ${turningPoint.replace("_", " ")}` : ""}`;
  const strongBearReversal = score <= -0.55 && confidence >= 0.72 && trend <= -0.3 && tactical <= -0.25;
  const strongBullReversal = score >= 0.55 && confidence >= 0.72 && trend >= 0.3 && tactical >= 0.25;
  const atrFraction = Math.max(h1.atrPercent / 100, 0.001);
  const forecasts = HORIZONS.map((hours) => {
    const horizonScale = hours === 1 ? 0.72 : hours === 3 ? 1.38 : 2;
    const expectedMovePct = score * atrFraction * horizonScale;
    const range = atrFraction * Math.sqrt(hours) * (0.8 + (1 - confidence) * 0.8);
    return {
      hours,
      targetPrice: m5.latestClose * (1 + expectedMovePct),
      lowerPrice: m5.latestClose * (1 + expectedMovePct - range),
      upperPrice: m5.latestClose * (1 + expectedMovePct + range),
      expectedMovePct,
    };
  });
  return {
    symbol,
    available: true,
    reason: null,
    updatedAt: new Date(candles.m5.at(-1)!.openTime).toISOString(),
    price: m5.latestClose,
    points: candles.m5.slice(-144).map((candle) => ({ at: new Date(candle.openTime).toISOString(), price: candle.close })),
    score,
    confidence,
    directive,
    turningPoint,
    entryReason,
    exitLongReason: strongBearReversal ? "TIMELINE_BEAR_REVERSAL_CONFIRMED" : null,
    exitShortReason: strongBullReversal ? "TIMELINE_BULL_REVERSAL_CONFIRMED" : null,
    forecasts,
    indicators: { m5: summary(m5), h1: summary(h1) },
  };
}

export class SingleSymbolPriceTimelineService {
  private snapshot: SingleSymbolPriceTimelineSnapshot | null = null;
  private inFlight: Promise<SingleSymbolPriceTimelineSnapshot> | null = null;
  private lastRefreshMs = 0;

  constructor(
    private readonly fetchCandles: TimelineCandleFetcher,
    private readonly opts: { enabledForExecution: boolean; nowMs?: () => number } = { enabledForExecution: false },
  ) {}

  isTrackedSymbol(symbol: string): symbol is SingleSymbolTimelineSymbol {
    return (SINGLE_SYMBOL_TIMELINE_SYMBOLS as readonly string[]).includes(symbol);
  }

  async getSnapshot(force = false): Promise<SingleSymbolPriceTimelineSnapshot> {
    const now = this.opts.nowMs?.() ?? Date.now();
    if (!force && this.snapshot && now - this.lastRefreshMs < REFRESH_MS) return this.snapshot;
    if (this.inFlight) return this.inFlight;
    this.inFlight = Promise.all(
      SINGLE_SYMBOL_TIMELINE_SYMBOLS.map(async (symbol) => {
        try {
          // One extra raw bar may still be active. Fetch enough history to
          // leave the required 250 completed 1h bars after that exclusion.
          const [m5, h1] = await Promise.all([this.fetchCandles(symbol, "5m", 300), this.fetchCandles(symbol, "1h", 300)]);
          return buildSingleSymbolPriceTimelineState(symbol, { m5, h1 }, now);
        } catch (error) {
          return buildUnavailable(symbol, error instanceof Error ? error.message : "market data unavailable");
        }
      }),
    )
      .then((symbols) => ({
        generatedAt: new Date(now).toISOString(),
        enabledForExecution: this.opts.enabledForExecution,
        note: "Forecast is a causal indicator consensus and uncertainty range, not a guaranteed price. Existing lane signal, stop, freshness, and risk gates remain required.",
        symbols,
      }))
      .then((snapshot) => {
        this.snapshot = snapshot;
        this.lastRefreshMs = now;
        return snapshot;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async entryGate(symbol: string, direction: "LONG" | "SHORT"): Promise<TimelineEntryGateResult> {
    if (!this.opts.enabledForExecution || !this.isTrackedSymbol(symbol)) return { allowed: true, reason: null };
    const snapshot = await this.getSnapshot();
    const state = snapshot.symbols.find((entry) => entry.symbol === symbol);
    const now = this.opts.nowMs?.() ?? Date.now();
    const age = now - new Date(snapshot.generatedAt).getTime();
    if (!state?.available || age > MAX_DATA_AGE_MS) {
      return { allowed: false, reason: `${symbol}: timeline market data unavailable or stale` };
    }
    const wanted: SingleSymbolTimelineDirective = direction === "LONG" ? "ENTER_LONG" : "ENTER_SHORT";
    return state.directive === wanted
      ? { allowed: true, reason: null }
      : { allowed: false, reason: `${symbol}: timeline ${state.directive}; ${state.entryReason}` };
  }

  async exitGate(symbol: string, direction: "LONG" | "SHORT"): Promise<TimelineExitGateResult> {
    if (!this.opts.enabledForExecution || !this.isTrackedSymbol(symbol)) return { shouldExit: false, reason: null };
    const snapshot = await this.getSnapshot();
    const state = snapshot.symbols.find((entry) => entry.symbol === symbol);
    if (!state?.available) return { shouldExit: false, reason: null }; // stale data never forces a live exit
    const reason = direction === "LONG" ? state.exitLongReason : state.exitShortReason;
    return { shouldExit: reason !== null, reason };
  }
}

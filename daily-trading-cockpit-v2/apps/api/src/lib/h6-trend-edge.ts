// H6 trend-continuation edge (LONG) — a real signal lane, NOT a shadow validator.
//
// The bot's LONG side bleeds because every long CHASES on a short horizon in a mean-reverting
// market (see fade-long-edge.ts). A GPT deep-research pass on crypto trend literature ranked an
// adaptive 6-hour trend lane as the closest thing to a viable long core: go long only when
// multi-timeframe trend + participation agree, then buy pullbacks inside that impulse. The key
// exit lesson from the first read was that MFE existed but the pure trail gave too much back, so
// v2 banks partial profit at TP1, moves the runner to breakeven, then uses the trail only for the
// runner.
//
// Like fade-long, this is the new entry signal the chase-based scanner can't produce. It records
// pullback-continuation entries on the universe each cycle (6h candles) and resolves them by
// candle-walk with a TP1 + ATR-runner exit, accumulating OOS exactly like a variant lane. Honest cost model
// (round-trip bps / stop bps + stop-out slippage on losers). A paper adapter mirrors fresh canonical
// std observations into the paper book so H6 can build the same lane-performance evidence as the
// other paper lanes. Live remains gated by the live engine and explicit paper-order mode.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Candle } from "@dtc/shared";
import { TAKER_ROUNDTRIP_BPS, STOP_OUT_SLIPPAGE_BPS, WATCHABLE_MIN_FRESH } from "./current-guard-variant-matrix.js";
import type { PaperOpportunity } from "./paper-execution-router.js";

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const H6_TREND_INTERVAL = process.env.H6_TREND_INTERVAL || "6h";
export const H6_TREND_ROC_PERIOD = envNum("H6_TREND_ROC_PERIOD", 20); // momentum lookback (bars)
export const H6_TREND_EMA_FAST_PERIOD = envNum("H6_TREND_EMA_FAST_PERIOD", 30); // trend filter
export const H6_TREND_EMA_SLOW_PERIOD = envNum("H6_TREND_EMA_SLOW_PERIOD", 90); // trend-agreement filter
export const H6_TREND_ATR_PERIOD = envNum("H6_TREND_ATR_PERIOD", 14);
export const H6_TREND_ATR_TRAIL_MULT = Number(process.env.H6_TREND_ATR_TRAIL_MULT) || 2.5; // chandelier offset
// Research A/B: a tighter trail to bank more of the favorable move. The early read showed trades
// reach avg MFE ~+0.9R but net negative — the 2.5-ATR trail gives the move back. This variant runs
// the SAME entries through a tighter 1.5-ATR trail so, once n matures, we have the exit A/B ready.
export const H6_TREND_TIGHT_TRAIL_MULT = Number(process.env.H6_TREND_TIGHT_TRAIL_MULT) || 1.5;
export const H6_TREND_TRAIL_VARIANTS: ReadonlyArray<{ id: "std" | "tight"; mult: number }> = [
  { id: "std", mult: H6_TREND_ATR_TRAIL_MULT },
  { id: "tight", mult: H6_TREND_TIGHT_TRAIL_MULT },
];
// ROC threshold (percent). Default 0 = "momentum positive". Env-tunable to demand stronger momentum.
export const H6_TREND_ROC_THRESHOLD = Number(process.env.H6_TREND_ROC_THRESHOLD ?? 0);
export const H6_TREND_PULLBACK_EMA_PERIOD = envNum("H6_TREND_PULLBACK_EMA_PERIOD", 20);
export const H6_TREND_STRUCTURE_EMA_PERIOD = envNum("H6_TREND_STRUCTURE_EMA_PERIOD", 50);
export const H6_TREND_ADX_THRESHOLD = envNum("H6_TREND_ADX_THRESHOLD", 25);
export const H6_TREND_VOLUME_MA_PERIOD = envNum("H6_TREND_VOLUME_MA_PERIOD", 20);
export const H6_TREND_PULLBACK_TOLERANCE_BPS = envNum("H6_TREND_PULLBACK_TOLERANCE_BPS", 75);
export const H6_TREND_FUNDING_MIN = Number(process.env.H6_TREND_FUNDING_MIN ?? -0.0001); // -0.01%
export const H6_TREND_FUNDING_MAX = Number(process.env.H6_TREND_FUNDING_MAX ?? 0.002); // +0.20%, avoid crowded longs
export const H6_TREND_MIN_OI_CHANGE_PCT = Number(process.env.H6_TREND_MIN_OI_CHANGE_PCT ?? 0);
export const H6_TREND_MIN_TAKER_BUY_SELL_RATIO = Number(process.env.H6_TREND_MIN_TAKER_BUY_SELL_RATIO ?? 1);
export const H6_TREND_BTC_DOMINANCE_MAX_RISE_PCT = Number(process.env.H6_TREND_BTC_DOMINANCE_MAX_RISE_PCT ?? 0.25);
export const H6_TREND_TP1_R = Number(process.env.H6_TREND_TP1_R ?? 0.8);
export const H6_TREND_TP1_EXIT_PCT = Number(process.env.H6_TREND_TP1_EXIT_PCT ?? 0.5);
export const H6_TREND_PAPER_LANE_ID = "H6_TREND_CONTINUATION_LONG" as const;
export const H6_TREND_PAPER_VARIANT_ID = H6_TREND_PAPER_LANE_ID;
// Max bars to hold before mark-to-market (56 bars ≈ 14 days on 6h) — bounds a trend that never trails out.
export const H6_TREND_MAX_HOLD_BARS = envNum("H6_TREND_MAX_HOLD_BARS", 56);
// Recent closed bars scanned each cycle for fresh trend entries (40 ≈ 10 days on 6h). A wide window
// bootstraps resolvable OOS (older entries already have forward bars to walk); deduped by bar.
export const H6_TREND_LOOKBACK_BARS = envNum("H6_TREND_LOOKBACK_BARS", 40);
export const H6_TREND_PAPER_ADMISSION_MAX_AGE_MS = envNum(
  "H6_TREND_PAPER_ADMISSION_MAX_AGE_MS",
  7 * 60 * 60 * 1000,
);
const H6_TREND_EXPIRY_MS = 21 * 24 * 60 * 60 * 1000; // trends hold longer than fade-long's 7d

export type H6TrendGateStatus = "PASS" | "FAIL" | "UNAVAILABLE";

export interface H6TrendEntryContext {
  dailyCandles?: readonly Candle[];
  h4Candles?: readonly Candle[];
  fundingRate?: number | null;
  openInterestChangePercent?: number | null;
  takerBuySellRatio?: number | null;
  btcDominanceChangePct?: number | null;
  cvdDelta?: number | null;
}

export interface H6TrendEntryGateSnapshot {
  version: "h6-trend-continuation-v2";
  allowed: boolean;
  requireFullContext: boolean;
  reasons: string[];
  missing: string[];
  checks: {
    dailyEma50Gt200: H6TrendGateStatus;
    h4Ema20Gt50: H6TrendGateStatus;
    h6Ema20Gt50: H6TrendGateStatus;
    momentumPositive: H6TrendGateStatus;
    adxGtThreshold: H6TrendGateStatus;
    volumeGtMa20: H6TrendGateStatus;
    fundingAboveFloor: H6TrendGateStatus;
    fundingBelowCrowdedLong: H6TrendGateStatus;
    openInterestRising: H6TrendGateStatus;
    takerBuyParticipation: H6TrendGateStatus;
    btcDominanceNotRising: H6TrendGateStatus;
    cvdConfirms: H6TrendGateStatus;
    pullbackToEma20: H6TrendGateStatus;
    bullishConfirmation: H6TrendGateStatus;
  };
  metrics: {
    rocPct: number | null;
    adx: number | null;
    volumeToMa20: number | null;
    fundingRate: number | null;
    openInterestChangePercent: number | null;
    takerBuySellRatio: number | null;
    btcDominanceChangePct: number | null;
    cvdDelta: number | null;
  };
}

export interface H6TrendExitPolicySnapshot {
  version: "tp1-50-be-atr-runner-v1";
  tp1R: number;
  tp1ExitPct: number;
  breakevenAfterTp1: true;
  runner: "ATR_CHANDELIER";
}

// ── indicators ─────────────────────────────────────────────────────────────
export function computeEMA(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const mult = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += closes[i];
  sma /= period;
  out[period - 1] = sma;
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i] * mult + (out[i - 1] as number) * (1 - mult);
  }
  return out;
}

export function computeROC(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const prev = closes[i - period];
    out[i] = prev !== 0 ? ((closes[i] - prev) / prev) * 100 : null;
  }
  return out;
}

export function computeSMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function computeATR(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i];
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

export function computeADX(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period * 2) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  const plusDm: number[] = new Array(candles.length).fill(0);
  const minusDm: number[] = new Array(candles.length).fill(0);

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const prev = candles[i - 1]!;
    const upMove = current.high - prev.high;
    const downMove = prev.low - current.low;
    tr[i] = Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close));
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let trSmoothed = 0;
  let plusSmoothed = 0;
  let minusSmoothed = 0;
  for (let i = 1; i <= period; i++) {
    trSmoothed += tr[i]!;
    plusSmoothed += plusDm[i]!;
    minusSmoothed += minusDm[i]!;
  }

  const dx: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    if (i > period) {
      trSmoothed = trSmoothed - trSmoothed / period + tr[i]!;
      plusSmoothed = plusSmoothed - plusSmoothed / period + plusDm[i]!;
      minusSmoothed = minusSmoothed - minusSmoothed / period + minusDm[i]!;
    }
    const plusDi = trSmoothed > 0 ? (100 * plusSmoothed) / trSmoothed : 0;
    const minusDi = trSmoothed > 0 ? (100 * minusSmoothed) / trSmoothed : 0;
    const denom = plusDi + minusDi;
    dx[i] = denom > 0 ? (100 * Math.abs(plusDi - minusDi)) / denom : 0;
  }

  let adxSeed = 0;
  for (let i = period; i < period * 2; i++) {
    adxSeed += dx[i] ?? 0;
  }
  out[period * 2 - 1] = adxSeed / period;
  for (let i = period * 2; i < candles.length; i++) {
    out[i] = (((out[i - 1] ?? 0) * (period - 1)) + (dx[i] ?? 0)) / period;
  }
  return out;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// ── observations ─────────────────────────────────────────────────────────────
export interface H6TrendObservation {
  observationId: string;
  symbol: string;
  direction: "LONG";
  /** Exit-geometry A/B on the SAME entry: "std" (2.5-ATR trail) vs "tight" (1.5-ATR). Older obs
   *  without this field are treated as "std". */
  variant?: "std" | "tight";
  /** ATR-trail multiple for this obs (= stopDistanceBps geometry). Resolution derives the trail
   *  offset from entry−initialStop, so this is informational; defaults to std for older obs. */
  trailMult?: number;
  entryGate?: H6TrendEntryGateSnapshot;
  exitPolicy?: H6TrendExitPolicySnapshot;
  tp1Hit?: boolean;
  partialRealizedR?: number | null;
  runnerRealizedR?: number | null;
  /** Symbol is a large-cap major (LONG_LARGE_CAP finding: majors trend, high-beta alts chop). The
   *  focused long candidate = tight trail × large-cap, the cohort surfaced for the bull-regime edge. */
  isLargeCap?: boolean;
  rocAtEntry: number;
  atrAtEntry: number;
  entryPrice: number;
  initialStop: number;
  stopDistanceBps: number;
  openedAt: string;
  openedAtMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  netR: number | null;
  costR: number | null;
  maxFavorableR: number | null;
  exitReason: "TRAIL_STOP" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

function passFail(value: boolean | null): H6TrendGateStatus {
  if (value === null) return "UNAVAILABLE";
  return value ? "PASS" : "FAIL";
}

function latestEmaFastAboveSlow(candles: readonly Candle[] | undefined, fast: number, slow: number): H6TrendGateStatus {
  if (!candles || candles.length < slow + 2) return "UNAVAILABLE";
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const closed = sorted.length > 1 ? sorted.slice(0, -1) : sorted;
  if (closed.length < slow) return "UNAVAILABLE";
  const closes = closed.map((c) => c.close);
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);
  const i = closes.length - 1;
  const ef = emaFast[i];
  const es = emaSlow[i];
  if (!finiteNumber(ef) || !finiteNumber(es)) return "UNAVAILABLE";
  return ef > es ? "PASS" : "FAIL";
}

function isPullbackToEma(candles: Candle[], ema: (number | null)[], i: number): boolean | null {
  const e = ema[i];
  if (!finiteNumber(e) || i < 1) return null;
  const tolerance = (H6_TREND_PULLBACK_TOLERANCE_BPS / 10_000) * e;
  const current = candles[i]!;
  const previous = candles[i - 1]!;
  const touched = Math.min(current.low, previous.low) <= e + tolerance;
  const reclaimed = current.close >= e;
  return touched && reclaimed;
}

function isBullishConfirmation(candles: Candle[], i: number): boolean | null {
  if (i < 1) return null;
  const current = candles[i]!;
  const previous = candles[i - 1]!;
  return current.close > current.open && current.close > previous.close;
}

function conditionName(key: keyof H6TrendEntryGateSnapshot["checks"]): string {
  const names: Record<keyof H6TrendEntryGateSnapshot["checks"], string> = {
    dailyEma50Gt200: "DAILY_EMA50_NOT_ABOVE_EMA200",
    h4Ema20Gt50: "H4_EMA20_NOT_ABOVE_EMA50",
    h6Ema20Gt50: "H6_EMA20_NOT_ABOVE_EMA50",
    momentumPositive: "MOMENTUM_NOT_POSITIVE",
    adxGtThreshold: "ADX_BELOW_THRESHOLD",
    volumeGtMa20: "VOLUME_BELOW_MA20",
    fundingAboveFloor: "FUNDING_TOO_NEGATIVE",
    fundingBelowCrowdedLong: "FUNDING_CROWDED_LONG",
    openInterestRising: "OPEN_INTEREST_NOT_RISING",
    takerBuyParticipation: "TAKER_BUY_FLOW_WEAK",
    btcDominanceNotRising: "BTC_DOMINANCE_RISING",
    cvdConfirms: "CVD_NOT_CONFIRMING",
    pullbackToEma20: "NO_EMA20_PULLBACK_RECLAIM",
    bullishConfirmation: "NO_BULLISH_CONFIRMATION",
  };
  return names[key];
}

function buildH6TrendEntryGate(args: {
  candles: Candle[];
  index: number;
  ema20: (number | null)[];
  ema50: (number | null)[];
  roc: (number | null)[];
  adx: (number | null)[];
  volumeMa: (number | null)[];
  context?: H6TrendEntryContext;
  requireFullContext: boolean;
}): H6TrendEntryGateSnapshot {
  const { candles, index: i, context, requireFullContext } = args;
  const close = candles[i]?.close;
  const volume = candles[i]?.volume;
  const ema20 = args.ema20[i];
  const ema50 = args.ema50[i];
  const volumeMa = args.volumeMa[i];
  const adx = args.adx[i];
  const roc = args.roc[i];
  const funding = context?.fundingRate ?? null;
  const oiChange = context?.openInterestChangePercent ?? null;
  const takerRatio = context?.takerBuySellRatio ?? null;
  const btcDom = context?.btcDominanceChangePct ?? null;
  const cvd = context?.cvdDelta ?? null;

  const checks: H6TrendEntryGateSnapshot["checks"] = {
    dailyEma50Gt200: latestEmaFastAboveSlow(context?.dailyCandles, 50, 200),
    h4Ema20Gt50: latestEmaFastAboveSlow(context?.h4Candles, 20, 50),
    h6Ema20Gt50: passFail(finiteNumber(close) && finiteNumber(ema20) && finiteNumber(ema50) ? close > ema20 && ema20 > ema50 : null),
    momentumPositive: passFail(finiteNumber(roc) ? roc > H6_TREND_ROC_THRESHOLD : null),
    adxGtThreshold: passFail(finiteNumber(adx) ? adx > H6_TREND_ADX_THRESHOLD : null),
    volumeGtMa20: passFail(finiteNumber(volume) && finiteNumber(volumeMa) && volumeMa > 0 ? volume > volumeMa : null),
    fundingAboveFloor: passFail(finiteNumber(funding) ? funding > H6_TREND_FUNDING_MIN : null),
    fundingBelowCrowdedLong: passFail(finiteNumber(funding) ? funding < H6_TREND_FUNDING_MAX : null),
    openInterestRising: passFail(finiteNumber(oiChange) ? oiChange > H6_TREND_MIN_OI_CHANGE_PCT : null),
    takerBuyParticipation: passFail(finiteNumber(takerRatio) ? takerRatio > H6_TREND_MIN_TAKER_BUY_SELL_RATIO : null),
    btcDominanceNotRising: passFail(finiteNumber(btcDom) ? btcDom <= H6_TREND_BTC_DOMINANCE_MAX_RISE_PCT : null),
    cvdConfirms: passFail(finiteNumber(cvd) ? cvd > 0 : null),
    pullbackToEma20: passFail(isPullbackToEma(candles, args.ema20, i)),
    bullishConfirmation: passFail(isBullishConfirmation(candles, i)),
  };

  const hardRequired: Array<keyof H6TrendEntryGateSnapshot["checks"]> = [
    "dailyEma50Gt200",
    "h4Ema20Gt50",
    "h6Ema20Gt50",
    "momentumPositive",
    "adxGtThreshold",
    "volumeGtMa20",
    "fundingAboveFloor",
    "fundingBelowCrowdedLong",
    "openInterestRising",
    "takerBuyParticipation",
    "pullbackToEma20",
    "bullishConfirmation",
  ];
  const sourceOptional: Array<keyof H6TrendEntryGateSnapshot["checks"]> = ["btcDominanceNotRising", "cvdConfirms"];
  const reasons: string[] = [];
  const missing: string[] = [];
  for (const key of hardRequired) {
    if (checks[key] === "FAIL") reasons.push(conditionName(key));
    if (checks[key] === "UNAVAILABLE") {
      missing.push(conditionName(key));
      if (requireFullContext) reasons.push(`${conditionName(key)}_UNAVAILABLE`);
    }
  }
  for (const key of sourceOptional) {
    if (checks[key] === "FAIL") reasons.push(conditionName(key));
    if (checks[key] === "UNAVAILABLE") missing.push(conditionName(key));
  }

  return {
    version: "h6-trend-continuation-v2",
    allowed: reasons.length === 0,
    requireFullContext,
    reasons,
    missing,
    checks,
    metrics: {
      rocPct: finiteNumber(roc) ? roc : null,
      adx: finiteNumber(adx) ? adx : null,
      volumeToMa20: finiteNumber(volume) && finiteNumber(volumeMa) && volumeMa > 0 ? volume / volumeMa : null,
      fundingRate: finiteNumber(funding) ? funding : null,
      openInterestChangePercent: finiteNumber(oiChange) ? oiChange : null,
      takerBuySellRatio: finiteNumber(takerRatio) ? takerRatio : null,
      btcDominanceChangePct: finiteNumber(btcDom) ? btcDom : null,
      cvdDelta: finiteNumber(cvd) ? cvd : null,
    },
  };
}

// Large-cap majors — mirrors PAPER_LARGE_CAP_BASES (paper-execution-router.ts). Kept local so this
// edge module stays self-contained. LONG_LARGE_CAP finding: majors trend, high-beta alts chop.
const H6_LARGE_CAP_BASES: ReadonlySet<string> = new Set([
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "AVAX",
  "DOT", "LINK", "MATIC", "LTC", "BCH", "ATOM", "ETC", "XLM",
]);
export function h6IsLargeCap(symbol: string): boolean {
  let s = (symbol || "").toUpperCase();
  for (const q of ["USDT", "USDC", "BUSD", "USD", "PERP"]) {
    if (s.endsWith(q) && s.length > q.length) {
      s = s.slice(0, -q.length);
      break;
    }
  }
  return H6_LARGE_CAP_BASES.has(s);
}

function buildH6TrendObs(
  symbol: string,
  candles: Candle[],
  i: number,
  roc: number,
  atr: number,
  variant: "std" | "tight",
  trailMult: number,
  entryGate: H6TrendEntryGateSnapshot,
): H6TrendObservation {
  const entry = candles[i]!.close;
  const openedAtMs = candles[i]!.openTime;
  const initialStop = entry - trailMult * atr;
  // "std" keeps the original id (dedupes against pre-A/B obs → no double-count); "tight" is namespaced.
  const observationId = variant === "std" ? `h6trend:${symbol}:${openedAtMs}` : `h6trend:${variant}:${symbol}:${openedAtMs}`;
  return {
    observationId,
    symbol,
    direction: "LONG",
    variant,
    trailMult,
    entryGate,
    exitPolicy: {
      version: "tp1-50-be-atr-runner-v1",
      tp1R: H6_TREND_TP1_R,
      tp1ExitPct: H6_TREND_TP1_EXIT_PCT,
      breakevenAfterTp1: true,
      runner: "ATR_CHANDELIER",
    },
    tp1Hit: false,
    partialRealizedR: null,
    runnerRealizedR: null,
    isLargeCap: h6IsLargeCap(symbol),
    rocAtEntry: roc,
    atrAtEntry: atr,
    entryPrice: entry,
    initialStop,
    stopDistanceBps: ((entry - initialStop) / entry) * 10000,
    openedAt: new Date(openedAtMs).toISOString(),
    openedAtMs,
    status: "OPEN",
    grossR: null,
    netR: null,
    costR: null,
    maxFavorableR: null,
    exitReason: null,
    resolvedAt: null,
  };
}

export function buildH6TrendPaperOpportunities(
  observations: readonly H6TrendObservation[],
  opts: {
    now: string;
    regime: string | null;
    controllerMode: string;
    maxAgeMs?: number;
    paperOrderMode?: "HEADLINE" | "DIAGNOSTIC_ONLY";
  },
): PaperOpportunity[] {
  const nowMs = Date.parse(opts.now);
  const maxAgeMs = opts.maxAgeMs ?? H6_TREND_PAPER_ADMISSION_MAX_AGE_MS;
  const orderMode =
    opts.paperOrderMode ??
    (process.env.H6_TREND_PAPER_ORDER_MODE === "DIAGNOSTIC_ONLY" || process.env.H6_TREND_PAPER_DIAGNOSTIC === "1"
      ? "DIAGNOSTIC_ONLY"
      : "HEADLINE");
  const out: PaperOpportunity[] = [];

  for (const obs of observations) {
    if (obs.status !== "OPEN") continue;
    if ((obs.variant ?? "std") !== "std") continue;
    if (!Number.isFinite(nowMs) || nowMs - obs.openedAtMs > maxAgeMs) continue;
    const risk = obs.entryPrice - obs.initialStop;
    if (!(risk > 0) || !(obs.entryPrice > 0) || !(obs.stopDistanceBps > 0)) continue;
    const tp1R = obs.exitPolicy?.tp1R ?? H6_TREND_TP1_R;
    out.push({
      sourceCandidateId: obs.observationId,
      scanBatchId: "h6trend",
      symbol: obs.symbol,
      direction: "LONG",
      regime: opts.regime,
      laneId: H6_TREND_PAPER_LANE_ID,
      variantId: H6_TREND_PAPER_VARIANT_ID,
      controllerMode: opts.controllerMode,
      entryPrice: obs.entryPrice,
      stopLoss: obs.initialStop,
      takeProfitLevels: [obs.entryPrice + tp1R * risk],
      variantExitRule: "scaleout_tp1_trail",
      fillMode: "taker",
      plannedStopDistanceBps: obs.stopDistanceBps,
      oosUnconfirmed: true,
      paperRiskLabel: "EXPERIMENTAL",
      paperOrderMode: orderMode,
      openedAt: obs.openedAt,
      provenance: null,
      provenanceFieldMissing: [],
    });
  }

  return out;
}

/** Scan the lookback window for pullback-continuation entries on confirmed-closed bars. */
export function detectH6TrendEntries(
  symbol: string,
  candles: Candle[],
  opts: { context?: H6TrendEntryContext; requireFullContext?: boolean } = {},
): H6TrendObservation[] {
  if (candles.length < Math.max(H6_TREND_EMA_SLOW_PERIOD, H6_TREND_STRUCTURE_EMA_PERIOD, H6_TREND_VOLUME_MA_PERIOD) + 2) return [];
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume ?? 0);
  const ema20 = computeEMA(closes, H6_TREND_PULLBACK_EMA_PERIOD);
  const ema50 = computeEMA(closes, H6_TREND_STRUCTURE_EMA_PERIOD);
  const roc = computeROC(closes, H6_TREND_ROC_PERIOD);
  const atr = computeATR(candles, H6_TREND_ATR_PERIOD);
  const adx = computeADX(candles, H6_TREND_ATR_PERIOD);
  const volumeMa = computeSMA(volumes, H6_TREND_VOLUME_MA_PERIOD);
  const out: H6TrendObservation[] = [];
  const start = Math.max(1, candles.length - H6_TREND_LOOKBACK_BARS);
  for (let i = start; i < candles.length; i++) {
    const a = atr[i];
    if (a === null || !(a > 0)) continue;
    const entryGate = buildH6TrendEntryGate({
      candles,
      index: i,
      ema20,
      ema50,
      roc,
      adx,
      volumeMa,
      context: opts.context,
      requireFullContext: opts.requireFullContext ?? false,
    });
    if (entryGate.allowed) {
      // Emit one obs per exit-trail A/B variant on this same entry (std + tight).
      for (const v of H6_TREND_TRAIL_VARIANTS) {
        out.push(buildH6TrendObs(symbol, candles, i, roc[i] as number, a, v.id, v.mult, entryGate));
      }
    }
  }
  return out;
}

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

/** Resolve an OPEN H6 trend by walking candles AFTER openedAtMs with an ATR chandelier trail:
 *  before TP1, the full position is protected by the initial/trail stop. Once price reaches TP1,
 *  50% is banked, the runner stop floors at breakeven, and the ATR/chandelier trail only manages
 *  the remaining runner. No intrabar lookahead: the trail uses highs strictly BEFORE the current bar.
 *  Else mark-to-market at MAX_HOLD. Returns the patch, or null if still open. */
export function resolveH6Trend(
  obs: H6TrendObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<H6TrendObservation> | null {
  const fwd = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.entryPrice - obs.initialStop; // = mult * ATR_entry
  if (!(risk > 0)) return null;
  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<H6TrendObservation["exitReason"]>,
    maxFavorableR: number,
    tp1Hit = false,
    partialRealizedR: number | null = null,
    runnerRealizedR: number | null = null,
  ): Partial<H6TrendObservation> => {
    const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
    const status = grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
    return {
      status,
      grossR,
      costR,
      netR,
      exitReason,
      maxFavorableR,
      tp1Hit,
      partialRealizedR,
      runnerRealizedR,
      resolvedAt: new Date(atMs).toISOString(),
    };
  };
  let highestHigh = obs.entryPrice;
  let maxFavorableR = 0;
  let tp1Hit = obs.tp1Hit === true;
  const tp1R = obs.exitPolicy?.tp1R ?? H6_TREND_TP1_R;
  const tp1ExitPct = obs.exitPolicy?.tp1ExitPct ?? H6_TREND_TP1_EXIT_PCT;
  const runnerPct = Math.max(0, Math.min(1, 1 - tp1ExitPct));
  const tp1Price = obs.entryPrice + tp1R * risk;
  const bars = Math.min(fwd.length, H6_TREND_MAX_HOLD_BARS);
  for (let k = 0; k < bars; k++) {
    const c = fwd[k];
    // trail from highs strictly BEFORE this bar (no lookahead). Offset = the obs's own stop distance
    // (entry−initialStop = trailMult×ATR), so std (2.5) and tight (1.5) each trail by their own width.
    const trailStop = tp1Hit ? Math.max(obs.entryPrice, highestHigh - risk) : highestHigh - risk;
    if (c.low <= trailStop) {
      const grossR = (trailStop - obs.entryPrice) / risk;
      const reason = trailStop <= obs.initialStop ? "INITIAL_STOP" : "TRAIL_STOP";
      if (tp1Hit) {
        const runnerR = Math.max(0, grossR);
        const blendedR = tp1ExitPct * tp1R + runnerPct * runnerR;
        return finalize(
          blendedR,
          c.openTime,
          reason,
          Math.max(maxFavorableR, runnerR),
          true,
          tp1ExitPct * tp1R,
          runnerR,
        );
      }
      return finalize(grossR, c.openTime, reason, Math.max(maxFavorableR, grossR));
    }
    if (!tp1Hit && c.high >= tp1Price) {
      tp1Hit = true;
    }
    if (c.high > highestHigh) highestHigh = c.high;
    maxFavorableR = Math.max(maxFavorableR, (highestHigh - obs.entryPrice) / risk);
  }
  if (fwd.length >= H6_TREND_MAX_HOLD_BARS) {
    const c = fwd[H6_TREND_MAX_HOLD_BARS - 1];
    const runnerR = (c.close - obs.entryPrice) / risk;
    const grossR = tp1Hit ? tp1ExitPct * tp1R + runnerPct * runnerR : runnerR;
    return finalize(
      grossR,
      c.openTime,
      "MAX_HOLD_MTM",
      maxFavorableR,
      tp1Hit,
      tp1Hit ? tp1ExitPct * tp1R : null,
      tp1Hit ? runnerR : null,
    );
  }
  if (nowMs - obs.openedAtMs > H6_TREND_EXPIRY_MS) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null;
}

// ── report ─────────────────────────────────────────────────────────────────
export interface H6TrendVariantStats {
  freshValid: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  avgMaxFavorableR: number | null;
  tp1HitRate: number | null;
}
export interface H6TrendReport {
  freshValid: number;
  open: number;
  expired: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
  avgMaxFavorableR: number | null;
  tp1HitRate: number | null;
  watchableThreshold: number;
  status: "COLLECTING" | "WATCHABLE";
  totalNetR: number;
  entryPolicy: {
    name: "REGIME_FILTERED_TREND_CONTINUATION_LONG";
    required: string[];
    sourceOptional: string[];
  };
  exitPolicy: H6TrendExitPolicySnapshot;
  /** Research A/B sibling: the tight-trail (1.5-ATR) variant on the SAME entries. The top-level
   *  fields above are the "std" (2.5-ATR) lane (so the dashboard tile shows the primary). */
  tight: H6TrendVariantStats;
  /** THE focused long profit-generator candidate: tight trail × LARGE-CAP only (majors trend; alts
   *  chop) × bullish regime (cycle-gated). The thing to watch when the regime turns bull. */
  tightLargeCap: H6TrendVariantStats;
}

const _mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function h6VariantStats(observations: readonly H6TrendObservation[]): H6TrendVariantStats {
  const resolved = observations.filter(
    (o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && typeof o.netR === "number",
  );
  const nets = resolved.map((o) => o.netR as number);
  const mfes = resolved.map((o) => o.maxFavorableR).filter((r): r is number => typeof r === "number");
  const pfNum = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const pfDen = -nets.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const tp1Hits = resolved.filter((o) => o.tp1Hit === true).length;
  return {
    freshValid: resolved.length,
    netAvgR: _mean(nets),
    pf: pfDen > 0 ? pfNum / pfDen : pfNum > 0 ? Infinity : null,
    wr: resolved.length > 0 ? nets.filter((r) => r > 0).length / resolved.length : null,
    avgMaxFavorableR: _mean(mfes),
    tp1HitRate: resolved.length > 0 ? tp1Hits / resolved.length : null,
  };
}

export function buildH6TrendReport(observations: readonly H6TrendObservation[]): H6TrendReport {
  // Top-level = the "std" lane (obs with no variant predate the A/B → counted as std).
  const std = observations.filter((o) => (o.variant ?? "std") === "std");
  const tight = observations.filter((o) => o.variant === "tight");
  const s = h6VariantStats(std);
  const resolvedStd = std.filter(
    (o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && typeof o.netR === "number",
  );
  return {
    freshValid: s.freshValid,
    open: std.filter((o) => o.status === "OPEN").length,
    expired: std.filter((o) => o.status === "EXPIRED").length,
    netAvgR: s.netAvgR,
    grossAvgR: _mean(resolvedStd.map((o) => (typeof o.grossR === "number" ? o.grossR : 0))),
    pf: s.pf,
    wr: s.wr,
    avgMaxFavorableR: s.avgMaxFavorableR,
    tp1HitRate: s.tp1HitRate,
    watchableThreshold: WATCHABLE_MIN_FRESH,
    status: s.freshValid >= WATCHABLE_MIN_FRESH ? "WATCHABLE" : "COLLECTING",
    totalNetR: resolvedStd.map((o) => o.netR as number).reduce((a, b) => a + b, 0),
    entryPolicy: {
      name: "REGIME_FILTERED_TREND_CONTINUATION_LONG",
      required: [
        "Daily EMA50 > EMA200",
        "4H EMA20 > EMA50",
        "6H close > EMA20 > EMA50",
        `ROC > ${H6_TREND_ROC_THRESHOLD}`,
        `ADX > ${H6_TREND_ADX_THRESHOLD}`,
        "Volume > MA20",
        `Funding > ${(H6_TREND_FUNDING_MIN * 100).toFixed(3)}%`,
        `Funding < ${(H6_TREND_FUNDING_MAX * 100).toFixed(2)}%`,
        `Open interest change > ${H6_TREND_MIN_OI_CHANGE_PCT}%`,
        `Taker buy/sell ratio > ${H6_TREND_MIN_TAKER_BUY_SELL_RATIO}`,
        "Pullback/reclaim at EMA20",
        "Bullish confirmation candle",
      ],
      sourceOptional: [
        `BTC dominance change <= ${H6_TREND_BTC_DOMINANCE_MAX_RISE_PCT}% when wired`,
        "CVD > 0 when wired",
      ],
    },
    exitPolicy: {
      version: "tp1-50-be-atr-runner-v1",
      tp1R: H6_TREND_TP1_R,
      tp1ExitPct: H6_TREND_TP1_EXIT_PCT,
      breakevenAfterTp1: true,
      runner: "ATR_CHANDELIER",
    },
    tight: h6VariantStats(tight),
    tightLargeCap: h6VariantStats(tight.filter((o) => o.isLargeCap === true)),
  };
}

// ── store ─────────────────────────────────────────────────────────────────
interface H6TrendState {
  version: number;
  observations: H6TrendObservation[];
}

export class H6TrendStore {
  private state: H6TrendState = { version: 1, observations: [] };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<H6TrendState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as H6TrendObservation[];
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): H6TrendObservation[] {
    return this.state.observations;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: H6TrendObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<H6TrendObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf-8");
  }
}

let singleton: H6TrendStore | null = null;
export function getH6TrendStore(dataDir = "data"): H6TrendStore {
  if (!singleton) singleton = new H6TrendStore(resolve(dataDir, "h6-trend-edge.json"));
  return singleton;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface H6TrendCycleResult {
  scanned: number;
  newEntries: number;
  resolved: number;
  report: H6TrendReport;
}

/** One headless cycle: scan the universe (6h candles) for fresh uptrend entries and resolve OPEN ones
 *  by candle-walk. Report-only — never touches the paper book, live engine, or any strategy gate.
 *  Resilient: a per-symbol fetch error skips that symbol; the whole cycle never throws. */
export async function runH6TrendCycle(opts: {
  store: H6TrendStore;
  universe: readonly string[];
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  fetchContext?: (symbol: string) => Promise<H6TrendEntryContext>;
  now: number;
  maxSymbols?: number;
  /** When false (e.g. regime is not bullish), do NOT open new entries — only resolve open ones.
   *  Trend/dip longs only have an edge in a bullish regime; this gates new positions to that. */
  allowNewEntries?: boolean;
}): Promise<H6TrendCycleResult> {
  const { store, universe, fetchCandles, now } = opts;
  const symbols = opts.maxSymbols ? universe.slice(0, opts.maxSymbols) : universe;
  let scanned = 0;
  let newEntries = 0;
  let resolved = 0;
  const candlesBySymbol = new Map<string, Candle[]>();
  const contextBySymbol = new Map<string, H6TrendEntryContext>();

  for (const symbol of symbols) {
    let candles: Candle[];
    try {
      candles = await fetchCandles(symbol);
    } catch {
      continue;
    }
    if (!candles || candles.length === 0) continue;
    candles.sort((a, b) => a.openTime - b.openTime);
    // Drop the final (potentially in-progress) bar so detection + resolution use closed bars only.
    const closed = candles.length > 1 ? candles.slice(0, -1) : candles;
    if (closed.length === 0) continue;
    scanned++;
    candlesBySymbol.set(symbol, closed);
    if (opts.fetchContext) {
      try {
        contextBySymbol.set(symbol, await opts.fetchContext(symbol));
      } catch {
        contextBySymbol.set(symbol, {});
      }
    }
  }

  // Open new entries ONLY in a bullish regime (caller-gated). Resolution of OPEN obs always runs.
  if (opts.allowNewEntries !== false) {
    for (const [symbol, closed] of candlesBySymbol) {
      for (const entry of detectH6TrendEntries(symbol, closed, {
        context: contextBySymbol.get(symbol),
        requireFullContext: Boolean(opts.fetchContext),
      })) {
        if (store.add(entry)) newEntries++;
      }
    }
  }

  for (const [symbol, closed] of candlesBySymbol) {
    for (const obs of store.all) {
      if (obs.symbol !== symbol || obs.status !== "OPEN") continue;
      const patch = resolveH6Trend(obs, closed, now);
      if (patch) {
        store.update(obs.observationId, patch);
        if (patch.status !== "OPEN") resolved++;
      }
    }
  }
  store.save();
  return { scanned, newEntries, resolved, report: buildH6TrendReport(store.all) };
}

let cycleInFlight = false;
export function isH6TrendCycleInFlight(): boolean {
  return cycleInFlight;
}

/** Overlap-guarded wrapper so the 7-min ticker can't stack two cycles on the singleton store. */
export async function runH6TrendCycleGuarded(opts: {
  store: H6TrendStore;
  universe: readonly string[];
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  fetchContext?: (symbol: string) => Promise<H6TrendEntryContext>;
  now: number;
  maxSymbols?: number;
  allowNewEntries?: boolean;
}): Promise<H6TrendCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runH6TrendCycle(opts);
  } finally {
    cycleInFlight = false;
  }
}

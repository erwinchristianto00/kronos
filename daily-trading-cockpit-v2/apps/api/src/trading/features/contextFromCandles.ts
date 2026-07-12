import type { Candle } from "@dtc/shared";
import { ema, rsi, atr, vwap, average } from "@dtc/shared";
import type {
  BreadthUniverseKind,
  FeatureSourceMap,
  LiquiditySource,
  LiquidityTier,
  MarketContext,
  Timeframe,
  TimeframeFreshness,
} from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Feature adapter: historical candles → MarketContext.
//
// PURE. Given multi-timeframe BTC candles (+ optional ETH, the traded coin, a
// breadth summary, and microstructure/governance inputs that CANNOT be derived
// from candles), it produces the boolean/number flags the strategy functions
// consume. Uses the tested @dtc/shared indicators (ema/rsi/atr/vwap).
//
// HONESTY ABOUT DERIVATION QUALITY:
//   • RIGOROUS (trustworthy): price-level flags, RSI, VWAP position, volume
//     regime, range position, rejection candle, higher-low structure, ETH
//     confirmation, freshness/asOf.
//   • HEURISTIC v1 (documented, refine later): support/resistance break + retest
//     flags and liquidation-flush detection. These approximate discretionary
//     patterns from swing levels; treat as provisional until validated.
//   • MUST BE SUPPLIED (never guessed): market breadth, microstructure (spread /
//     slippage / liquidity / funding), governance counters. Missing required
//     execution/microstructure fields fail closed in buildTradingDecision.
//
// LOOKAHEAD RULE:
//   All derived flags below use only candles whose close time is <= `asOf`.
//   Future candles and the currently-forming candle are filtered out before any
//   indicator, support/retest, higher-low, or rejection calculation is made.
//
// Consistency guarantee: the adapter is written so it never emits a pair of flags
// that contextIntegrity.detectContradictions would reject (e.g. it derives
// btcBreaksBelow55000 and btcNotBreakingMajorSupport from the same threshold so
// they can't both be true). If divergent TIMEFRAMES genuinely disagree (h1 below
// 60k while the last 4H close is above 62k) it lets that surface — the integrity
// guard then correctly forces a no-trade rather than the adapter hiding it.
// ─────────────────────────────────────────────────────────────────────────────

export interface FeatureAdapterConfig {
  btcMajorSupport: number; // 55000
  btcBelowLevelA: number; // 60000
  btcBelowLevelB: number; // 62000
  btcDailyTrendLevel: number; // 65000
  rsiPeriod: number;
  atrPeriod: number;
  emaPeriod: number;
  window: number; // general lookback (bars) for volume/range/structure
  vwapWindow: number; // rolling-VWAP window (bars)
  levelTolerancePct: number; // "near a level" band
  sustainedAboveLevelConfirmBars: number; // consecutive closed 4H bars above a level ⇒ "sustained", not just a retest touch
  breadthWeakPct: number; // breadth fraction below this ⇒ weak
  breadthPositivePct: number; // breadth fraction at/above this ⇒ positive
  volumeExpansionRatio: number; // lastVol / avgVol ⇒ expansion
  volumeDeadRatio: number; // lastVol / avgVol below this ⇒ dead
  freshnessBudgetMs: Partial<Record<Timeframe, number>>;
  defaultRegimeConfidence: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureAdapterConfig = {
  btcMajorSupport: 55_000,
  btcBelowLevelA: 60_000,
  btcBelowLevelB: 62_000,
  btcDailyTrendLevel: 65_000,
  rsiPeriod: 14,
  atrPeriod: 14,
  emaPeriod: 20,
  window: 20,
  vwapWindow: 24,
  levelTolerancePct: 0.004, // 0.4%
  sustainedAboveLevelConfirmBars: 2,
  breadthWeakPct: 0.4,
  breadthPositivePct: 0.55,
  volumeExpansionRatio: 1.3,
  volumeDeadRatio: 0.6,
  freshnessBudgetMs: {
    "5m": 15 * 60_000,
    "15m": 45 * 60_000,
    "1h": 90 * 60_000,
    "4h": 6 * 3_600_000,
    "1d": 36 * 3_600_000,
  },
  defaultRegimeConfidence: 0.7,
};

const TF_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
};

export interface FeatureAdapterInput {
  /** Decision timestamp (epoch ms). */
  asOf: number;
  btc: {
    m5?: Candle[];
    m15?: Candle[];
    h1: Candle[];
    h4: Candle[];
    d1: Candle[];
  };
  /** Optional ETH candles for the confirmation flag. */
  eth?: { h1: Candle[] };
  /** Optional candles for the specific ALT being evaluated (relative-strength lane). */
  coin?: { h1: Candle[] };
  /**
   * Breadth summary from the universe scanner (fractions 0..1). Cannot be derived
   * here. For historical backtests, prefer POINT_IN_TIME. If the scanner uses
   * today's scan/liquid universe, set CURRENT_LIQUID_UNIVERSE so reports can
   * label the survivorship-bias risk instead of overstating the result.
   */
  breadth?: {
    advancersPct?: number;
    altAdvancersPct?: number;
    universeKind?: BreadthUniverseKind;
    universeSnapshotMs?: number;
    universeDescription?: string;
  };
  /** Microstructure — must be supplied (orderbook/exchange, not candles). */
  microstructure: {
    spreadBps: number;
    slippageBps: number;
    liquidityGood?: boolean;
    liquidityTooThin?: boolean;
    liquidityTier?: LiquidityTier;
    liquiditySource?: LiquiditySource;
    quoteVolumeUsd24h?: number;
    orderbookDepthUsd?: number;
    fundingRiskAbnormal?: boolean;
    assumeFundingBaseline?: boolean;
    volatilityTooHigh?: boolean;
    isDecisionZone?: boolean;
    signalConflict?: boolean;
  };
  governance: {
    dailyLossPct: number;
    consecutiveLosses: number;
    openPositions?: number;
    tradesToday?: number;
    regimeConfidence?: number;
  };
  config?: Partial<FeatureAdapterConfig>;
  /** Explicit flag overrides applied LAST (e.g. corrected breadth, known truths). */
  overrides?: Partial<MarketContext>;
}

// ── small candle helpers ─────────────────────────────────────────────────────

const closesOf = (c: Candle[]): number[] => c.map((x) => x.close);
const tail = <T>(a: T[], n: number): T[] => a.slice(-Math.min(n, a.length));
const lastClose = (c: Candle[]): number => (c.length ? c[c.length - 1]!.close : NaN);
const candleCloseTime = (c: Candle, tf: Timeframe): number => c.openTime + TF_MS[tf];

function closedCandles(c: Candle[] | undefined, tf: Timeframe, asOf: number): Candle[] {
  // Sort + dedup by openTime before filtering: the "lookahead rule" below only
  // holds if `tail(n)` returns the chronologically-latest N candles. A caller
  // that hands us an out-of-order or duplicate-timestamp array (e.g. a delayed
  // retry re-insert from a live feed) would otherwise silently shift every
  // derived feature by a bar with no error.
  const byTime = new Map<number, Candle>();
  for (const x of c ?? []) byTime.set(x.openTime, x);
  return [...byTime.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .filter((x) => candleCloseTime(x, tf) <= asOf);
}

function finitePositive(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

interface LiquidityAssessment {
  liquidityGood?: boolean;
  liquidityTooThin?: boolean;
  tier: LiquidityTier;
  source?: LiquiditySource;
  featureSource?: "SUPPLIED" | "ORDERBOOK_DEPTH" | "HEURISTIC";
}

function assessLiquidity(input: FeatureAdapterInput["microstructure"]): LiquidityAssessment {
  const tier = input.liquidityTier ?? "ALT";

  if (input.liquidityGood !== undefined) {
    const source = input.liquiditySource ?? "SUPPLIED";
    return {
      liquidityGood: input.liquidityGood,
      liquidityTooThin: input.liquidityTooThin ?? (input.liquidityGood === false ? true : undefined),
      tier,
      source,
      featureSource: source === "ORDERBOOK_DEPTH" ? "ORDERBOOK_DEPTH" : source === "HEURISTIC_SPREAD_VOLUME" ? "HEURISTIC" : "SUPPLIED",
    };
  }

  const spreadBps = input.spreadBps;
  const quoteVolumeUsd24h = input.quoteVolumeUsd24h;
  const orderbookDepthUsd = input.orderbookDepthUsd;
  const isMajor = tier === "MAJOR";

  if (finitePositive(orderbookDepthUsd) && finitePositive(quoteVolumeUsd24h)) {
    const spreadOk = spreadBps <= (isMajor ? 5 : 3);
    const volumeOk = quoteVolumeUsd24h >= (isMajor ? 50_000_000 : 10_000_000);
    const depthOk = orderbookDepthUsd >= (isMajor ? 1_000_000 : 250_000);
    const good = spreadOk && volumeOk && depthOk;
    return {
      liquidityGood: good,
      liquidityTooThin: input.liquidityTooThin ?? !good,
      tier,
      source: "ORDERBOOK_DEPTH",
      featureSource: "ORDERBOOK_DEPTH",
    };
  }

  if (finitePositive(quoteVolumeUsd24h)) {
    const spreadOk = spreadBps <= (isMajor ? 4 : 2);
    const volumeOk = quoteVolumeUsd24h >= (isMajor ? 100_000_000 : 25_000_000);
    const good = spreadOk && volumeOk;
    return {
      liquidityGood: good,
      liquidityTooThin: input.liquidityTooThin ?? !good,
      tier,
      source: "HEURISTIC_SPREAD_VOLUME",
      featureSource: "HEURISTIC",
    };
  }

  return { liquidityTooThin: input.liquidityTooThin, tier };
}

function swingHigh(c: Candle[], lookback: number): number {
  return Math.max(...tail(c, lookback).map((x) => x.high));
}
function swingLow(c: Candle[], lookback: number): number {
  return Math.min(...tail(c, lookback).map((x) => x.low));
}
function avgVolume(c: Candle[], window: number): number {
  const vols = tail(c, window + 1).slice(0, -1).map((x) => x.volume); // exclude the last bar
  return vols.length ? average(vols) : 0;
}
function nearLevel(price: number, level: number, tolPct: number): boolean {
  return Number.isFinite(price) && level > 0 && Math.abs(price - level) / level <= tolPct;
}
function rollingVwap(c: Candle[], window: number): number {
  return vwap(tail(c, window));
}
/** Higher low across the two halves of a window. */
function higherLow(c: Candle[], window: number): boolean {
  const w = tail(c, window);
  if (w.length < 6) return false;
  const mid = Math.floor(w.length / 2);
  const olderLow = Math.min(...w.slice(0, mid).map((x) => x.low));
  const recentLow = Math.min(...w.slice(mid).map((x) => x.low));
  return recentLow > olderLow;
}
/** Higher highs AND higher lows across the two halves of a window ⇒ bullish structure. */
function bullishStructure(c: Candle[], window: number): boolean {
  const w = tail(c, window);
  if (w.length < 6) return false;
  const mid = Math.floor(w.length / 2);
  const olderHigh = Math.max(...w.slice(0, mid).map((x) => x.high));
  const recentHigh = Math.max(...w.slice(mid).map((x) => x.high));
  const olderLow = Math.min(...w.slice(0, mid).map((x) => x.low));
  const recentLow = Math.min(...w.slice(mid).map((x) => x.low));
  return recentHigh > olderHigh && recentLow > olderLow;
}
/** Bearish rejection: upper wick dominates the body and the candle closes red. */
function bearishRejection(candle: Candle): boolean {
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return upperWick > body && candle.close <= candle.open;
}

/**
 * Build a MarketContext from candles + supplied inputs. Returns undefined-valued
 * flags for anything not confidently derivable; those are fail-safe (lanes that
 * need them won't fire).
 */
export function contextFromCandles(input: FeatureAdapterInput): MarketContext {
  const cfg: FeatureAdapterConfig = { ...DEFAULT_FEATURE_CONFIG, ...input.config };
  const { asOf } = input;
  const btc = {
    m5: closedCandles(input.btc.m5, "5m", asOf),
    m15: closedCandles(input.btc.m15, "15m", asOf),
    h1: closedCandles(input.btc.h1, "1h", asOf),
    h4: closedCandles(input.btc.h4, "4h", asOf),
    d1: closedCandles(input.btc.d1, "1d", asOf),
  };
  const ethH1 = closedCandles(input.eth?.h1, "1h", asOf);
  const coinH1 = closedCandles(input.coin?.h1, "1h", asOf);
  const h1 = btc.h1;
  const h4 = btc.h4;
  const d1 = btc.d1;
  const shortTf = btc.m5.length > 0 ? btc.m5 : btc.m15;

  // Data sufficiency: too few candles ⇒ low confidence + stale (fail-safe).
  const insufficient = h1.length < cfg.emaPeriod + 2 || h4.length < 4 || d1.length < 2;

  const priceH1 = lastClose(h1);
  const closeH4 = lastClose(h4);
  const closeD1 = lastClose(d1);

  const ema20 = h1.length ? ema(closesOf(h1), cfg.emaPeriod) : NaN;
  const vwapH1 = h1.length ? rollingVwap(h1, cfg.vwapWindow) : NaN;
  const rsi1h = h1.length ? rsi(closesOf(h1), cfg.rsiPeriod) : undefined;
  const rsiShortTf = shortTf.length ? rsi(closesOf(shortTf), cfg.rsiPeriod) : undefined;
  const atrH1 = h1.length ? atr(h1, cfg.atrPeriod) : 0;

  // ── price-level flags (rigorous) ─────────────────────────────────────────
  const btcBelow60000 = Number.isFinite(priceH1) ? priceH1 < cfg.btcBelowLevelA : undefined;
  const btcBelow62000 = Number.isFinite(priceH1) ? priceH1 < cfg.btcBelowLevelB : undefined;
  // Break of major support: derived from ONE threshold so it can't co-exist with
  // btcNotBreakingMajorSupport (contradiction-safe).
  const belowMajor = Number.isFinite(priceH1) && priceH1 < cfg.btcMajorSupport;
  const btcBreaksBelow55000 = belowMajor ? true : undefined;
  const btcNotBreakingMajorSupport = Number.isFinite(priceH1) ? priceH1 >= cfg.btcMajorSupport : undefined;
  const btcClose4hAbove62000 = Number.isFinite(closeH4) ? closeH4 > cfg.btcBelowLevelB : undefined;
  const btcCloseDailyAbove65000 = Number.isFinite(closeD1) ? closeD1 > cfg.btcDailyTrendLevel : undefined;

  const keyResistance = h4.length ? swingHigh(h4, cfg.window) : NaN;
  const btcBelowKeyResistance = Number.isFinite(priceH1) && Number.isFinite(keyResistance)
    ? priceH1 < keyResistance
    : undefined;

  const h4SwingLow = h4.length ? swingLow(h4, cfg.window) : NaN;
  const btcStableAboveSupport =
    Number.isFinite(priceH1) && Number.isFinite(h4SwingLow)
      ? priceH1 > cfg.btcBelowLevelB && priceH1 > h4SwingLow * 1.005 && !belowMajor
      : undefined;

  // ── VWAP / EMA / RSI-derived ─────────────────────────────────────────────
  const recentUp = h1.length >= 4 ? h1[h1.length - 1]!.close > h1[h1.length - 4]!.close : false;
  const nearEmaOrVwap =
    nearLevel(priceH1, ema20, cfg.levelTolerancePct) || nearLevel(priceH1, vwapH1, cfg.levelTolerancePct);
  const pricePullbackToVWAPOrEMA20 = nearEmaOrVwap && recentUp ? true : undefined;
  const coinCloses = coinH1.length ? closesOf(coinH1) : null;

  // ── volume regime ────────────────────────────────────────────────────────
  const avgVol = avgVolume(h1, cfg.window);
  const lastVol = h1.length ? h1[h1.length - 1]!.volume : 0;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 0;
  const volumeExpansion = avgVol > 0 ? volRatio >= cfg.volumeExpansionRatio : undefined;
  const volumeNotDead = avgVol > 0 ? volRatio > cfg.volumeDeadRatio : undefined;
  const volumeWeakOnBounce = avgVol > 0 ? recentUp && volRatio < 0.9 : undefined;

  // ── range position + rejection ───────────────────────────────────────────
  const rangeHigh = h1.length ? swingHigh(h1, cfg.window) : NaN;
  const rangeLow = h1.length ? swingLow(h1, cfg.window) : NaN;
  const rangePos =
    Number.isFinite(rangeHigh) && Number.isFinite(rangeLow) && rangeHigh > rangeLow
      ? (priceH1 - rangeLow) / (rangeHigh - rangeLow)
      : NaN;
  const priceNearLowerRange = Number.isFinite(rangePos) ? rangePos < 0.25 : undefined;
  const rejectionCandle = h1.length ? bearishRejection(h1[h1.length - 1]!) : undefined;

  // ── structure ────────────────────────────────────────────────────────────
  const btcHigherLow = h1.length >= 6 ? higherLow(h1, cfg.window) : undefined;
  const higherLowFormed = btcHigherLow;
  const marketStructureBullish = h4.length >= 6 ? bullishStructure(h4, cfg.window) : undefined;

  // ── liquidation flush (HEURISTIC v1) ─────────────────────────────────────
  const lastH1 = h1.length ? h1[h1.length - 1]! : null;
  const liquidationFlushDetected =
    lastH1 && atrH1 > 0
      ? lastH1.close < lastH1.open &&
        lastH1.high - lastH1.low > 2 * atrH1 &&
        avgVol > 0 &&
        volRatio > 1.8
      : undefined;

  // ── support/resistance break + retest (HEURISTIC v1) ─────────────────────
  // support = prior-window swing low; broken when the last close is below it.
  const priorSupport = h1.length >= cfg.window ? swingLow(h1.slice(0, -Math.floor(cfg.window / 2)), cfg.window) : NaN;
  const supportBroken = Number.isFinite(priorSupport) ? priceH1 < priorSupport : undefined;
  const closeBelowSupport = supportBroken; // close-based, same signal in v1
  // "supportHolds" only when support is NOT broken (contradiction-safe).
  const supportHolds =
    Number.isFinite(priorSupport) ? priceH1 >= priorSupport && nearLevel(priceH1, priorSupport, cfg.levelTolerancePct * 3) : undefined;
  const priorResistance = h1.length >= cfg.window ? swingHigh(h1.slice(0, -Math.floor(cfg.window / 2)), cfg.window) : NaN;
  const resistanceBroken = Number.isFinite(priorResistance) ? priceH1 > priorResistance : undefined;
  // retest of old level as support (long) / old support (short): price near the level after breaking it.
  const retestResistanceAsSupport =
    resistanceBroken === true && nearLevel(priceH1, priorResistance, cfg.levelTolerancePct * 3) ? true : undefined;
  const retestOldSupport =
    supportBroken === true && nearLevel(priceH1, priorSupport, cfg.levelTolerancePct * 3) ? true : undefined;
  // retest failed (short thesis): retested old support from below and closed back under.
  const retestFailed = retestOldSupport === true && priceH1 < priorSupport ? true : undefined;
  // 62k retest hold (long thesis): true if EITHER (a) price is in the narrow instant of
  // retesting the level itself, OR (b) BTC has SUSTAINED above 62k across the last N
  // confirmed 4H closes and is still at/above it now.
  //
  // (a) alone made this flag structurally unreachable during a real, decisive rally:
  // btcClose4hAbove62000 only turns true once an entire 4H candle CLOSES above the
  // level (up to 4h lag behind the actual cross), by which point price has typically
  // already run well outside the +/-1.2% "near level" band — confirmed live 2026-07-10:
  // BTC held above 62000 for 31+ hours with 100% breadth, yet retest62000Hold (and thus
  // NEUTRAL_RECOVERY) never fired even once in 746 snapshots, because price sat 3.97%
  // above 62000 the whole time — 3x outside the band. (b) restores the flag's own
  // documented intent ("holding above 62k after reclaim") for a genuine sustained move,
  // confirmed by sustainedAboveLevelConfirmBars consecutive 4H closes (not a single-bar
  // fluke), without loosening or touching (a)'s original narrow-band case.
  const retestAtLevel =
    btcClose4hAbove62000 === true &&
    nearLevel(priceH1, cfg.btcBelowLevelB, cfg.levelTolerancePct * 3) &&
    priceH1 >= cfg.btcBelowLevelB;
  const sustainedAbove62000 =
    btcClose4hAbove62000 === true &&
    h4.length >= cfg.sustainedAboveLevelConfirmBars &&
    tail(h4, cfg.sustainedAboveLevelConfirmBars).every((c) => c.close > cfg.btcBelowLevelB) &&
    priceH1 >= cfg.btcBelowLevelB;
  const retest62000Hold = retestAtLevel || sustainedAbove62000 ? true : undefined;

  const btcStillWeak =
    btcBelow62000 === true && (marketStructureBullish !== true) ? true : undefined;
  const pullbackHolds = supportHolds; // daily pullback-hold proxy
  const pullbackToSupport =
    Number.isFinite(priorSupport) ? nearLevel(priceH1, priorSupport, cfg.levelTolerancePct * 3) : undefined;

  // ── ETH confirmation ─────────────────────────────────────────────────────
  let ethConfirms: boolean | undefined;
  if (ethH1.length >= cfg.emaPeriod + 2) {
    const ethCloses = closesOf(ethH1);
    ethConfirms = lastClose(ethH1) > ema(ethCloses, cfg.emaPeriod) && rsi(ethCloses, cfg.rsiPeriod) >= 50;
  }

  // ── per-coin relative strength ───────────────────────────────────────────
  let coinAboveVWAP: boolean | undefined;
  let coinOutperformsBTC: boolean | undefined;
  if (coinH1.length >= cfg.vwapWindow) {
    const coinPrice = lastClose(coinH1);
    coinAboveVWAP = coinPrice > rollingVwap(coinH1, cfg.vwapWindow);
    if (coinCloses && h1.length >= cfg.window) {
      const coinRet = coinCloses[coinCloses.length - 1]! / coinCloses[Math.max(0, coinCloses.length - cfg.window)]! - 1;
      const btcRet = priceH1 / closesOf(h1)[Math.max(0, h1.length - cfg.window)]! - 1;
      coinOutperformsBTC = coinRet > btcRet;
    }
  }

  // ── breadth (supplied) ───────────────────────────────────────────────────
  const b = input.breadth;
  const marketBreadthWeak = b?.advancersPct !== undefined ? b.advancersPct < cfg.breadthWeakPct : undefined;
  const marketBreadthPositive =
    b?.advancersPct !== undefined ? b.advancersPct >= cfg.breadthPositivePct : undefined;
  const marketBreadthCollapses = b?.advancersPct !== undefined ? b.advancersPct < 0.2 : undefined;
  const altBreadthImproves =
    b?.altAdvancersPct !== undefined ? b.altAdvancersPct >= cfg.breadthWeakPct : undefined;
  const altBreadthPositive =
    b?.altAdvancersPct !== undefined ? b.altAdvancersPct >= cfg.breadthPositivePct : undefined;
  const liquidity = assessLiquidity(input.microstructure);
  const fundingRiskAbnormal =
    input.microstructure.fundingRiskAbnormal ??
    (input.microstructure.assumeFundingBaseline === true ? false : undefined);
  const fundingFeatureSource = input.microstructure.fundingRiskAbnormal !== undefined
    ? "SUPPLIED"
    : input.microstructure.assumeFundingBaseline === true
      ? "ASSUMED_BASELINE"
      : "SUPPLIED";

  // ── freshness ────────────────────────────────────────────────────────────
  const freshness: TimeframeFreshness[] = [];
  const pushFresh = (tf: Timeframe, candles: Candle[] | undefined) => {
    if (!candles || candles.length === 0) return;
    const last = candles[candles.length - 1]!;
    const budget = cfg.freshnessBudgetMs[tf];
    if (budget === undefined) return;
    freshness.push({ timeframe: tf, lastCandleCloseMs: last.openTime + TF_MS[tf], maxStalenessMs: budget });
  };
  pushFresh("5m", btc.m5);
  pushFresh("15m", btc.m15);
  pushFresh("1h", h1);
  pushFresh("4h", h4);
  pushFresh("1d", d1);

  const regimeConfidence = input.governance.regimeConfidence ?? (insufficient ? 0.5 : cfg.defaultRegimeConfidence);

  const featureSources: FeatureSourceMap = {
    btcBelow60000: ["1h"],
    btcBelow62000: ["1h"],
    btcBreaksBelow55000: ["1h"],
    btcNotBreakingMajorSupport: ["1h"],
    btcClose4hAbove62000: ["4h"],
    btcCloseDailyAbove65000: ["1d"],
    btcBelowKeyResistance: ["1h", "4h"],
    pricePullbackToVWAPOrEMA20: ["1h"],
    rsi1h: ["1h"],
    rsiShortTf: btc.m5.length > 0 ? ["5m"] : ["15m"],
    rejectionCandle: ["1h"],
    volumeWeakOnBounce: ["1h"],
    volumeExpansion: ["1h"],
    volumeNotDead: ["1h"],
    priceNearLowerRange: ["1h"],
    btcHigherLow: ["1h"],
    higherLowFormed: ["1h"],
    marketStructureBullish: ["4h"],
    liquidationFlushDetected: ["1h"],
    supportBroken: ["1h"],
    closeBelowSupport: ["1h"],
    supportHolds: ["1h"],
    pullbackHolds: ["1h"],
    pullbackToSupport: ["1h"],
    resistanceBroken: ["1h"],
    retestResistanceAsSupport: ["1h"],
    retestOldSupport: ["1h"],
    retestFailed: ["1h"],
    retest62000Hold: ["1h", "4h"],
    btcStillWeak: ["1h", "4h"],
    ethConfirms: ["1h"],
    coinAboveVWAP: ["1h"],
    coinOutperformsBTC: ["1h"],
    marketBreadthWeak: ["SUPPLIED"],
    marketBreadthPositive: ["SUPPLIED"],
    marketBreadthCollapses: ["SUPPLIED"],
    breadthUniverseKind: ["SUPPLIED"],
    breadthUniverseSnapshotMs: ["SUPPLIED"],
    breadthUniverseDescription: ["SUPPLIED"],
    altBreadthImproves: ["SUPPLIED"],
    altBreadthPositive: ["SUPPLIED"],
    liquidityGood: liquidity.featureSource ? [liquidity.featureSource] : ["SUPPLIED"],
    liquidityTooThin: liquidity.featureSource ? [liquidity.featureSource] : ["SUPPLIED"],
    liquidityTier: ["SUPPLIED"],
    liquiditySource: ["SUPPLIED"],
    spreadBps: ["SUPPLIED"],
    slippageBps: ["SUPPLIED"],
    fundingRiskAbnormal: [fundingFeatureSource],
    volatilityTooHigh: ["SUPPLIED"],
    isDecisionZone: ["SUPPLIED"],
    signalConflict: ["SUPPLIED"],
    dailyLossPct: ["GOVERNANCE"],
    consecutiveLosses: ["GOVERNANCE"],
    openPositions: ["GOVERNANCE"],
    tradesToday: ["GOVERNANCE"],
    regimeConfidence: ["GOVERNANCE"],
    asOf: ["GOVERNANCE"],
    freshness: ["GOVERNANCE"],
    dataStale: ["GOVERNANCE"],
  };

  const ctx: MarketContext = {
    // macro/structure
    btcBelow60000,
    btcBelow62000,
    btcBreaksBelow55000,
    btcClose4hAbove62000,
    btcCloseDailyAbove65000,
    retest62000Hold,
    retestFailed,
    btcHigherLow,
    pullbackHolds,
    ethConfirms,
    altBreadthImproves,
    altBreadthPositive,
    marketBreadthWeak,
    marketBreadthPositive,
    marketBreadthCollapses,
    breadthUniverseKind: b?.universeKind,
    breadthUniverseSnapshotMs: b?.universeSnapshotMs,
    breadthUniverseDescription: b?.universeDescription,
    marketStructureBullish,
    volumeNotDead,
    volumeExpansion,
    // short-fade
    btcBelowKeyResistance,
    pricePullbackToVWAPOrEMA20,
    rsi1h,
    rejectionCandle,
    volumeWeakOnBounce,
    // breakdown-retest
    supportBroken,
    closeBelowSupport,
    retestOldSupport,
    btcStillWeak,
    // micro-mean-reversion
    priceNearLowerRange,
    rsiShortTf,
    liquidationFlushDetected,
    btcNotBreakingMajorSupport,
    // long-side
    pullbackToSupport,
    supportHolds,
    resistanceBroken,
    retestResistanceAsSupport,
    higherLowFormed,
    btcStableAboveSupport,
    coinOutperformsBTC,
    coinAboveVWAP,
    liquidityGood: liquidity.liquidityGood,
    liquidityTooThin: liquidity.liquidityTooThin,
    liquidityTier: liquidity.tier,
    liquiditySource: liquidity.source,
    // governance (required)
    dailyLossPct: input.governance.dailyLossPct,
    consecutiveLosses: input.governance.consecutiveLosses,
    spreadBps: input.microstructure.spreadBps,
    slippageBps: input.microstructure.slippageBps,
    regimeConfidence,
    // no-trade flags
    isDecisionZone: input.microstructure.isDecisionZone,
    volatilityTooHigh: input.microstructure.volatilityTooHigh,
    signalConflict: input.microstructure.signalConflict,
    fundingRiskAbnormal,
    // counters
    openPositions: input.governance.openPositions,
    tradesToday: input.governance.tradesToday,
    // freshness
    asOf,
    freshness,
    featureSources,
    dataStale: insufficient ? true : undefined,
    ...input.overrides,
  };

  return ctx;
}

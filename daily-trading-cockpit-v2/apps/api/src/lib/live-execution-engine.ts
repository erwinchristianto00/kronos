/**
 * LIVE EXECUTION ENGINE (Binance USD-M Futures) — additive mirror of the existing edge.
 *
 * Consumes HEADLINE paper orders (the proven scaleout lane) from the paper-execution
 * router store and mirrors them to Binance as real orders. It changes NOTHING in the
 * strategy: no admission, exit, gate, or router code is touched — this module only
 * READS paper decisions and executes them.
 *
 * SAFETY MODEL (hard, layered):
 *  - Dormant by default: without LIVE_EXECUTION_ENABLED=1 no client is constructed and
 *    no loop runs. The rest of the app behaves exactly as before.
 *  - testnet-first: LIVE_BINANCE_ENV selects testnet/mainnet; mainnet ALSO requires
 *    LIVE_MAINNET_CONFIRM=I_UNDERSTAND_REAL_MONEY.
 *  - Arming is runtime + in-memory: restart ⇒ disarmed. Mainnet never auto-arms.
 *    Disarmed = no NEW entries; lifecycle management of already-open intents continues.
 *  - Kill-switch (manual / daily-loss / loss-streak / drawdown): cancel all orders,
 *    FLATTEN all engine positions reduce-only, disarm.
 *  - Reconciliation each tick: local intents vs exchange truth; mismatch ⇒ auto-disarm.
 *  - Exchange-error streak ⇒ auto-disarm (trade blind = halt).
 *
 * Exit semantics mirror walkVariantPath("scaleout_tp1_trail"): lock 50% at TP1 (reduce-
 * only LIMIT), then move the stop to breakeven for the runner (cancel/replace
 * STOP_MARKET). Entry is MARKET (paper fillMode "taker").
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  BinanceFuturesPrivateError,
  resolveConfirmedFillPrice,
  resolveLiveBinanceEnv,
  type BinanceFuturesPrivateClient,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type LiveBinanceEnv,
} from "./binance-futures-private.js";
import {
  MFE_GIVEBACK_ARM_R,
  MFE_GIVEBACK_FRAC,
  type VariantExitRule,
} from "./current-guard-variant-matrix.js";
import { estimateLaneSelectorV2Regime, type LaneSelectorV2EstimatedRegime } from "./lane-selector-v2.js";
import {
  parseRegimeFlipRescueConfig,
  planRegimeFlipRescue,
  type RegimeFlipRescueConfig,
  type RescueFlipAction,
  type RescueFlattenAction,
  type RescuePositionView,
  type RescueSkip,
} from "./regime-flip-rescue.js";
import { fetchCrowdingSnapshot, type CrowdSide, type CrowdingState } from "./derivatives-crowding.js";
import { clusterOf, isMajorSymbol } from "./correlation-clusters.js";
import type { BinanceClient } from "./binance.js";
import type { PaperOrder } from "./paper-execution-router.js";
import {
  getCuratedSymbolsForLane,
  type LaneSymbolCurationTier,
  type PerSymbolLaneBookEdgeReport,
} from "./per-symbol-lane-book-edge.js";
import { getLaneSymbolCurationCacheStore } from "./lane-symbol-curation-cache.js";
import { LANE_SYMBOL_CURATION_MAX_STALENESS_MS } from "./paper-opportunity-allocator.js";
import {
  directionalSymbolSizeMultiplier,
  getSymbolVolatilityCacheStore,
  refreshSymbolVolatilityCache,
  isDirectionalTechnicalGateEnabled,
  type SymbolVolatilityCacheStore,
} from "./directional-symbol-sizing.js";

// ─── config ──────────────────────────────────────────────────────────────────

export const LIVE_MAINNET_CONFIRM_PHRASE = "I_UNDERSTAND_REAL_MONEY";

export interface LiveExecutionConfig {
  enabled: boolean;
  env: LiveBinanceEnv | null;
  apiKey: string;
  apiSecret: string;
  riskUsdPerTrade: number;
  maxConcurrentPositions: number;
  /** Correlated-alt concentration cap per direction. BTC/ETH are majors; everything else is treated as the correlated alt basket. */
  maxCorrelatedAltLongPositions: number;
  maxCorrelatedAltShortPositions: number;
  /**
   * Max open positions per correlation CLUSTER per direction (replaces the flat all-alts cap above).
   * BTC/ETH (MAJORS cluster) are exempt — bounded only by maxConcurrentPositions. This lets genuinely
   * different baskets (L1 vs meme vs AI) hold their own slots instead of sharing one 3-slot alt cap,
   * while still blocking a single-cluster pile-up. See correlation-clusters.ts.
   */
  maxClusterPositions: number;
  dailyMaxLossUsd: number;
  maxConsecutiveLosses: number;
  /**
   * A realized close whose |net| is below this is a "scratch" (fee-only / breakeven exit) — it does
   * NOT count toward the consecutive-loss streak (nor reset it). Stops profit-bank / breakeven-after-cost
   * exits from false-tripping the consecutive-loss kill-switch. An "adverse" emergency flatten always
   * counts regardless of magnitude, so churn stays visible to the breaker.
   */
  scratchEpsilonUsd: number;
  maxDrawdownUsd: number;
  /** Default leverage used by all non-experimental lanes. */
  defaultLeverage: number;
  /** Hard leverage ceiling; only EXP 10x lanes may reach this cap. */
  maxLeverage: number;
  maxNotionalPerTrade: number;
  /**
   * Normal live mirror freshness window for paper HEADLINE orders. Prevents a re-arm from
   * backfilling hours-old paper signals whose market context has already drifted.
   */
  maxPaperOrderAgeMs: number;
  /** Testnet-only: mirror every open paper order, including diagnostic lanes and pre-restart orders. */
  mirrorAllPaperOrders: boolean;
  /** LIVE_MIRROR_PROVEN_SYMBOLS_ONLY=1 — see isMirrorProvenSymbolsOnly. Parsed once here so the
   *  behavior is injectable in tests without mutating process.env (which leaks across vitest
   *  worker threads). */
  mirrorProvenSymbolsOnly: boolean;
  /** Testnet-only: close a mirrored position early once exchange unrealized PnL reaches this USDT threshold. */
  testnetTakeProfitUsd: number;
  /** Testnet-only: close regime-opposing exposure once it can be flattened at estimated breakeven or better. */
  testnetRegimeExitEnabled: boolean;
  /** Testnet-only anti-bull hard-cut: once opposing exposure (e.g. shorts in a sustained bull) has been
   *  opposed continuously for this many ms, cut even the RED ones at market instead of riding them to
   *  full stops. 0 disables. */
  testnetRegimeHardCutMs: number;
  /** Conservative fee+slippage buffer used for testnet breakeven exits and dashboard net-after-cost. */
  estimatedCloseCostPct: number;
  autoArm: boolean;
  mainnetConfirmed: boolean;
  /** Mainnet opt-in: reuse the same live-mirror lane policy as /testnet instead of stable-only gates. */
  mainnetKeepTestnetPolicy: boolean;
  /** Mainnet opt-in (LIVE_MAINNET_PROFIT_PROTECTION=1): bring the regime breakeven/hard-cut exit — the
   *  same loss-limiting harvest that runs on testnet — to mainnet so counter-regime exposure doesn't
   *  bleed to full stops. Pure risk-reducer (banks scratch-greens, cuts sustained opposing losers). */
  mainnetProfitProtection: boolean;
  /** Mainnet R-based profit bank: close a position once unrealized ≥ mainnetTpR × riskUsdPerTrade.
   *  0 = off (the regime exit alone has no fixed take-profit). R-based, not a blunt absolute-USD cap. */
  mainnetTpR: number;
  /** Mainnet anti-bleed hard-cut window (ms) for sustained counter-regime exposure; 0 disables. */
  mainnetRegimeHardCutMs: number;
  /** General net-of-estimated-cost profit bank: close ANY open position (either direction, any lane,
   *  either env) once unrealized PnL minus estimatedCloseCostUsd reaches this USD amount. Takes priority
   *  over the legacy gross testnetTakeProfitUsd/mainnetTpR thresholds when set. 0 = off. */
  profitBankNetTargetUsd: number;
  /** Opposing-regime loss cut: close once adverse move reaches this fraction of the entry-to-stop distance. */
  regimeLossHardCutStopFraction: number;
  /**
   * Phase-2 exit rebuild (2026-07-05 autopsy: avg win +$0.47 vs avg loss −$2.67, losers held 9.5h).
   * forceMfeGiveback applies the MFE-giveback exit (arm ≥0.75R, bank on 50% retrace from peak) to
   * EVERY directional intent regardless of its lane's own exit rule — winners get room to run
   * instead of being capped, but a faded runner is banked before a regime flip round-trips it.
   */
  forceMfeGiveback: boolean;
  /**
   * Cut a position that has been LOSING (favorableR < 0) for longer than this. 0 = disabled.
   * The direct fix for the 567-minute median losing hold: losers no longer sit for hours waiting
   * for a regime cut to crystallize a -2.7R-sized dollar loss.
   */
  losingMaxHoldMs: number;
  /** Auto-reset of the operator lane selection: when a position opened FROM the selection
   *  closes with net realized ≤ -this many USD, the whole selection (allocations + allow-list)
   *  is cleared and control returns to the bot. Small scratch closes (fees-only, e.g. the
   *  breakeven harvest's −$0.02) stay below the threshold and do NOT reset. */
  laneSelectionLossResetUsd: number;
  /** Testnet-only regime-flip rescue (flip a stuck counter-regime position to net regime-aligned). */
  rescue: RegimeFlipRescueConfig;
  /** Testnet-only: when true the rescue PLACES orders (flip/flatten); otherwise it only shadow-evaluates.
   *  LIVE_TESTNET_RESCUE_MODE=live. Forced false unless rescue.enabled (so mainnet can never execute). */
  rescueExecute: boolean;
  /** Why the config cannot trade (empty = config valid for its env). */
  configErrors: string[];
}

export interface LiveControllerSnapshot {
  regime: string | null;
  mode: string | null;
  bias?: string | null;
  confidence?: string | null;
  estimatedRegime?: LaneSelectorV2EstimatedRegime | null;
  reasons?: string[];
  capturedAt?: string | null;
}

function envNum(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envNonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envFraction(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function boundedLeverage(value: number, maxLeverage: number): number {
  return Math.max(1, Math.min(Math.floor(value), Math.max(1, Math.floor(maxLeverage))));
}

export function parseLiveExecutionConfig(env: NodeJS.ProcessEnv = process.env): LiveExecutionConfig {
  const enabled = env.LIVE_EXECUTION_ENABLED === "1";
  const liveEnv = resolveLiveBinanceEnv(env.LIVE_BINANCE_ENV);
  const apiKey = env.LIVE_BINANCE_API_KEY ?? "";
  const apiSecret = env.LIVE_BINANCE_API_SECRET ?? "";
  const mainnetConfirmed = env.LIVE_MAINNET_CONFIRM === LIVE_MAINNET_CONFIRM_PHRASE;

  const configErrors: string[] = [];
  if (enabled) {
    if (!liveEnv) configErrors.push("LIVE_BINANCE_ENV must be 'testnet' or 'mainnet'");
    if (!apiKey || !apiSecret) configErrors.push("LIVE_BINANCE_API_KEY / LIVE_BINANCE_API_SECRET missing");
    if (liveEnv === "mainnet" && !mainnetConfirmed) {
      configErrors.push(`mainnet requires LIVE_MAINNET_CONFIRM=${LIVE_MAINNET_CONFIRM_PHRASE}`);
    }
  }

  const maxLeverage = Math.floor(envNum(env.LIVE_MAX_LEVERAGE, 2));
  const defaultLeverage = boundedLeverage(
    envNum(env.LIVE_DEFAULT_LEVERAGE, Math.min(3, maxLeverage)),
    maxLeverage,
  );

  return {
    enabled,
    env: liveEnv,
    apiKey,
    apiSecret,
    riskUsdPerTrade: envNum(env.LIVE_RISK_USD_PER_TRADE, 5),
    maxConcurrentPositions: Math.floor(envNum(env.LIVE_MAX_CONCURRENT_POSITIONS, 3)),
    maxCorrelatedAltLongPositions: envNonNegativeInt(env.LIVE_MAX_CORRELATED_ALT_LONGS, 3),
    maxCorrelatedAltShortPositions: envNonNegativeInt(env.LIVE_MAX_CORRELATED_ALT_SHORTS, 3),
    maxClusterPositions: envNonNegativeInt(env.LIVE_MAX_CLUSTER_POSITIONS, 3),
    dailyMaxLossUsd: envNum(env.LIVE_DAILY_MAX_LOSS_USD, 15),
    maxConsecutiveLosses: Math.floor(envNum(env.LIVE_MAX_CONSECUTIVE_LOSSES, 5)),
    scratchEpsilonUsd: envNum(env.LIVE_SCRATCH_EPSILON_USD, Math.max(0.05, 0.02 * envNum(env.LIVE_RISK_USD_PER_TRADE, 5))),
    maxDrawdownUsd: envNum(env.LIVE_MAX_DRAWDOWN_USD, 40),
    defaultLeverage,
    maxLeverage,
    maxNotionalPerTrade: envNum(env.LIVE_MAX_NOTIONAL_PER_TRADE, 250),
    maxPaperOrderAgeMs: Math.floor(envNum(env.LIVE_MAX_PAPER_ORDER_AGE_MS, 10 * 60 * 1000)),
    mirrorAllPaperOrders: env.LIVE_MIRROR_ALL_PAPER === "1" && liveEnv === "testnet",
    mirrorProvenSymbolsOnly: isMirrorProvenSymbolsOnly(env),
    testnetTakeProfitUsd: liveEnv === "testnet" ? envNum(env.LIVE_TESTNET_TP_USD, 0) : 0,
    testnetRegimeExitEnabled: liveEnv === "testnet" && env.LIVE_TESTNET_REGIME_EXIT !== "0",
    testnetRegimeHardCutMs: liveEnv === "testnet" ? envNum(env.LIVE_TESTNET_REGIME_HARD_CUT_MS, 30 * 60 * 1000) : 0,
    estimatedCloseCostPct: envNum(env.LIVE_ESTIMATED_CLOSE_COST_PCT, 0.0022),
    // Mainnet auto-arm needs BOTH the flag and an explicit acknowledgement token (2026-07-07,
    // operator-requested): every restart boots disarmed by design, but live restarts constantly
    // (deploys + OOM auto-restarts), so mainnet silently missed every signal window while testnet
    // kept trading. The token keeps a bare LIVE_AUTO_ARM=1 inert on real money; the constructor's
    // kill-switch latch check still blocks auto-arm after a kill regardless of both flags.
    autoArm:
      env.LIVE_AUTO_ARM === "1" &&
      (liveEnv === "testnet" ||
        env.LIVE_AUTO_ARM_MAINNET_CONFIRM === "I_UNDERSTAND_AUTO_ARM_REAL_MONEY"),
    mainnetConfirmed,
    mainnetKeepTestnetPolicy: liveEnv === "mainnet" && env.LIVE_MAINNET_KEEP_TESTNET_POLICY === "1",
    mainnetProfitProtection: liveEnv === "mainnet" && env.LIVE_MAINNET_PROFIT_PROTECTION === "1",
    mainnetTpR: liveEnv === "mainnet" ? Math.max(0, Number.parseFloat(env.LIVE_MAINNET_TP_R ?? "") || 0) : 0,
    mainnetRegimeHardCutMs: liveEnv === "mainnet" ? envNum(env.LIVE_MAINNET_REGIME_HARD_CUT_MS, 30 * 60 * 1000) : 0,
    profitBankNetTargetUsd: Math.max(0, Number.parseFloat(env.LIVE_PROFIT_BANK_NET_TARGET_USD ?? "") || 0),
    regimeLossHardCutStopFraction: envFraction(env.LIVE_REGIME_LOSS_HARD_CUT_STOP_FRACTION, 0.5),
    forceMfeGiveback: env.LIVE_FORCE_MFE_GIVEBACK === "1",
    losingMaxHoldMs: Math.max(0, Math.floor(envNum(env.LIVE_LOSING_MAX_HOLD_MS, 0))),
    laneSelectionLossResetUsd: envNum(env.LIVE_LANE_SELECTION_LOSS_RESET_USD, 0.25),
    rescue: parseRegimeFlipRescueConfig(env, liveEnv),
    rescueExecute:
      env.LIVE_TESTNET_RESCUE_ENABLED === "1" &&
      env.LIVE_TESTNET_RESCUE_MODE === "live" &&
      liveEnv === "testnet",
    configErrors,
  };
}

// ─── sizing ──────────────────────────────────────────────────────────────────

export interface LiveOrderPlan {
  ok: boolean;
  reason: string | null;
  qty: number;
  tp1Qty: number;
  notionalUsd: number;
  stopPrice: number;
  tp1Price: number;
}

export function roundDownToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  // Use string-based rounding to dodge float artifacts (e.g. 0.30000000000000004).
  const steps = Math.floor(value / step + 1e-9);
  const decimals = Math.max(0, Math.min(12, -Math.floor(Math.log10(step) + 1e-9)));
  return Number((steps * step).toFixed(decimals));
}

export function roundUpToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  const steps = Math.ceil(value / step - 1e-9);
  const decimals = Math.max(0, Math.min(12, -Math.floor(Math.log10(step) + 1e-9)));
  return Number((steps * step).toFixed(decimals));
}

/**
 * Round a protective stop trigger to the tick grid AWAY from the fill so it never lands on the
 * wrong side: a LONG sell-stop must stay strictly below the fill (round down), a SHORT buy-stop
 * strictly above it (round up). Rounding a SHORT stop DOWN can pull it onto/below the fill →
 * Binance -2021 "would immediately trigger" — the same failure class as the INJUSDT churn, just
 * for shorts with a tiny stop distance and a coarse tick.
 */
export function roundStopToSafeSide(direction: "LONG" | "SHORT", stop: number, tickSize: number): number {
  return direction === "LONG" ? roundDownToStep(stop, tickSize) : roundUpToStep(stop, tickSize);
}

/**
 * Crowding-gated exit SHADOW classifier (pure, no side effects). What crowding alone would
 * recommend for a stuck `opposingDirection` position: look at the REGIME-ALIGNED side (the
 * opposite of the stuck direction) — if that crowd is still BUILDING (funding elevated + OI
 * rising), the move is likely to continue ⇒ CUT; if it's UNWINDING/EXHAUSTING (crowd covering /
 * OI falling), a squeeze/bounce is more likely ⇒ HOLD (give the stuck side room to recover).
 * Mismatched side or NEUTRAL crowding state ⇒ no strong read.
 */
export function crowdingExitRecommendation(
  crowdSide: CrowdSide,
  crowdingState: CrowdingState,
  opposingDirection: "LONG" | "SHORT",
): "CUT" | "HOLD" | "NEUTRAL" {
  const regimeAlignedSide: CrowdSide = opposingDirection === "LONG" ? "SHORT" : "LONG";
  if (crowdSide !== regimeAlignedSide) return "NEUTRAL";
  if (crowdingState === "BUILDING") return "CUT";
  if (crowdingState === "UNWINDING" || crowdingState === "EXHAUSTING") return "HOLD";
  return "NEUTRAL";
}

/**
 * Minimum TP distance from entry for a LIVE order. A TP tighter than this can't clear round-trip
 * costs (taker fees ~0.04%×2 + spread), so the trade is structurally a loser. This is a
 * defense-in-depth gate: it blocks the malformed ~0.14% geometry that churned the early mode-2
 * shorts — regardless of which source produced the order. Coherent lane geometry (0.5R on a
 * >=300bps stop) sits at >=1.5%, far above this floor, so legitimate orders are never blocked.
 */
const MIN_TP_DISTANCE_PCT = 0.003; // 30bps

/** How often to refresh per-symbol ATR% for the directional size multiplier. ATR on 1h candles
 *  moves slowly — refetching every ~25s tick would be wasted exchange calls for no new signal. */
const SYMBOL_VOLATILITY_REFRESH_INTERVAL_MS = 20 * 60_000;

/**
 * Pyramid cap (2026-07-08, operator-requested after a real loss): a bearish/bullish signal that
 * keeps re-firing on the SAME symbol keeps adding to the SAME intent every tick. Real MAX_HOLD_CUT
 * history (8 live cuts, 2026-07-05..08) showed this compounds a normally-small loss into a large
 * one purely by size, NOT by holding longer — the 4h cut itself fired on schedule every time:
 *   SEI/FET/AVAX/INJ/WLD: 1-3 adds, maxFavorableR 0-0.20  -> losses $0.01-$0.46
 *   XRP: 7 adds, maxFavorableR 0 (never once favorable)   -> loss $1.84
 *   DOGE: 15 adds, maxFavorableR 0.12                     -> loss $4.15
 * Past PYRAMID_FREE_ADD_LIMIT adds, require the position to have shown at least
 * PYRAMID_MIN_FAVORABLE_R of real favorable movement to keep growing — a position that's added
 * repeatedly without ever proving itself stops growing, it doesn't stop existing (the original
 * size still rides to its own stop/TP/max-hold outcome untouched).
 */
const PYRAMID_FREE_ADD_LIMIT = 3;
const PYRAMID_MIN_FAVORABLE_R = 0.15;

/**
 * Pure sizing: risk a fixed USD amount over the paper geometry's stop distance, round
 * to the symbol's exchange filters, enforce notional caps. Mirrors the paper sizing
 * formula (risk / stopDistancePct) but with LIVE risk config, never paper's 1%.
 */
export function computeLiveOrderPlan(
  signal: { direction: "LONG" | "SHORT"; entryPrice: number; stopLoss: number; tp1: number },
  config: Pick<LiveExecutionConfig, "riskUsdPerTrade" | "maxNotionalPerTrade">,
  filters: FuturesSymbolFilters,
): LiveOrderPlan {
  const fail = (reason: string): LiveOrderPlan => ({ ok: false, reason, qty: 0, tp1Qty: 0, notionalUsd: 0, stopPrice: 0, tp1Price: 0 });

  const { entryPrice, stopLoss, tp1 } = signal;
  if (!(entryPrice > 0) || !(stopLoss > 0) || !(tp1 > 0)) return fail("invalid geometry");
  const stopDistancePct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (!(stopDistancePct > 0)) return fail("zero stop distance");
  const stopRightSide = signal.direction === "LONG" ? stopLoss < entryPrice : stopLoss > entryPrice;
  const tpRightSide = signal.direction === "LONG" ? tp1 > entryPrice : tp1 < entryPrice;
  if (!stopRightSide || !tpRightSide) return fail("stop/tp on wrong side of entry");
  // Defense-in-depth: refuse a TP too tight to clear round-trip costs (the malformed mode-2 geometry).
  const tpDistancePct = Math.abs(entryPrice - tp1) / entryPrice;
  if (tpDistancePct < MIN_TP_DISTANCE_PCT) {
    return fail(`tp too close to clear costs (${(tpDistancePct * 100).toFixed(2)}% < ${(MIN_TP_DISTANCE_PCT * 100).toFixed(2)}%)`);
  }

  const rawNotional = config.riskUsdPerTrade / stopDistancePct;
  const notionalUsd = Math.min(rawNotional, config.maxNotionalPerTrade);
  const qty = roundDownToStep(notionalUsd / entryPrice, filters.stepSize);
  if (!(qty > 0) || qty < filters.minQty) return fail("quantity below exchange minimum");
  if (qty * entryPrice < filters.minNotional) return fail(`notional below exchange minimum (${filters.minNotional})`);

  const tp1Qty = roundDownToStep(qty / 2, filters.stepSize);
  return {
    ok: true,
    reason: null,
    qty,
    tp1Qty, // 0 ⇒ position too small to split; runner-only (stop still protects full qty)
    notionalUsd: qty * entryPrice,
    stopPrice: roundDownToStep(stopLoss, filters.tickSize),
    tp1Price: roundDownToStep(tp1, filters.tickSize),
  };
}

// ─── intents / store ─────────────────────────────────────────────────────────

export type LiveIntentState =
  | "MIRRORED"
  | "ENTRY_PLACED"
  | "OPEN"
  | "TP1_FILLED_BE_SET"
  | "CLOSED"
  | "ERROR"
  | "KILLED";

export interface LiveIntent {
  paperOrderId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  state: LiveIntentState;
  qty: number;
  tp1Qty: number;
  plannedEntryPrice: number;
  stopLossPrice: number;
  tp1Price: number;
  filledEntryPrice: number | null;
  entryOrderId: number | null;
  stopOrderId: number | null;
  tp1OrderId: number | null;
  beStopOrderId: number | null;
  realizedPnlUsd: number | null;
  feesUsd: number | null;
  exitRule?: VariantExitRule;
  maxFavorableR?: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  lastError: string | null;
  /** Paper orders netted into this one-way Binance symbol position. */
  sourcePaperOrders?: LiveIntentSource[];
  /** True when this intent was opened WHILE an operator lane selection/allocation was active
   *  and its lane matched it — i.e. the position exists because of the operator's manual pick.
   *  A losing close of such an intent auto-resets the selection (control returns to the bot). */
  operatorLaneSelection?: boolean;
  /** Regime-flip rescue (testnet): true when this intent is the net regime-aligned leg opened by a flip.
   *  Managed only by the rescue flatten — skipped by normal lifecycle + the regime harvest. */
  rescue?: boolean;
  /** Loss already booked to the ledger when the stuck opposing leg was closed at flip (≤ 0). Lets the
   *  flatten trigger know when the WHOLE venture (booked loss + this live leg) is in profit. */
  rescuePriorRealizedUsd?: number;
  /** False when the exchange never confirmed a real entry avgPrice (see resolveConfirmedFillPrice)
   *  and filledEntryPrice fell back to the stale pre-trade paper reference price — the stop/TP
   *  geometry derived from it may be mispriced. Undefined on older persisted intents (assume true). */
  entryPriceConfirmed?: boolean;
}

export interface LiveIntentSource {
  paperOrderId: string;
  laneId: string;
  qty: number;
  regime?: string | null;
  controllerMode?: string | null;
  controllerConfidence?: string | null;
}

export type LivePerformanceView = "hourly" | "daily" | "weekly" | "monthly" | "yearly";
export type LivePerformancePeriod = "fixed";
export type LivePerformanceRegimeFilter =
  | "all"
  | "long"
  | "short"
  | "mixed"
  | "long_extended"
  | "short_extended"
  | "long_tactical"
  | "short_tactical"
  | "unknown";

type LiveRegimeFamily = "LONG" | "SHORT" | "MIXED" | "UNKNOWN";
type LiveRegimeBucket =
  | "LONG_EXTENDED"
  | "SHORT_EXTENDED"
  | "LONG_TACTICAL"
  | "SHORT_TACTICAL"
  | "MIXED"
  | "UNKNOWN";

export interface LiveLanePerformanceSeriesPoint {
  bucketStart: string;
  realizedPnlUsd: number;
  cumulativePnlUsd: number;
  closedCount: number;
  wins: number;
  losses: number;
}

export interface LiveLanePerformanceSeriesLane {
  laneId: string;
  realizedPnlUsd: number;
  feesUsd: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  symbols: string[];
  regimes: Array<{
    family: LiveRegimeFamily;
    bucket: LiveRegimeBucket;
    count: number;
  }>;
  points: LiveLanePerformanceSeriesPoint[];
}

export interface LiveLanePerformanceSeriesReport {
  view: LivePerformanceView;
  period: LivePerformancePeriod;
  viewLabel: string;
  periodLabel: string;
  bucketLabel: string;
  bucketMs: number | null;
  since: string;
  until: string;
  anchor: string | null;
  regimeFilter: LivePerformanceRegimeFilter;
  regimeOptions: Array<{ value: LivePerformanceRegimeFilter; label: string }>;
  bucketStarts: string[];
  lanes: LiveLanePerformanceSeriesLane[];
}

interface LiveDailyLedger {
  dateUtc: string;
  realizedPnlUsd: number;
  wins: number;
  losses: number;
  /** Near-breakeven fee-only closes — neither win nor loss (kept for honest accounting). */
  scratches?: number;
}

interface LiveExecutionState {
  version: number;
  intents: LiveIntent[];
  /** Mirror watermark: paper orders with createdAt <= this are never re-mirrored. */
  lastSeenCreatedAt: string;
  dailyLedger: LiveDailyLedger;
  consecutiveLosses: number;
  totalRealizedPnlUsd: number;
  /** Peak of totalRealizedPnlUsd — drawdown kill-switch baseline. */
  realizedPeakUsd: number;
  /** paperOrderId → failed live-open attempts. At MAX_MIRROR_ATTEMPTS the order is quarantined. */
  mirrorAttempts: Record<string, number>;
  /** Last fresh controller snapshot seen by the testnet regime-change harvest. */
  lastControllerRegime: string | null;
  lastControllerMode: string | null;
  /** Anti-bull hard-cut: the currently-opposed side and when that opposition began (continuously). */
  lastOpposingDirection: string | null;
  opposingSince: string | null;
  killedAt: string | null;
  killReason: string | null;
  /** Last regime-flip-rescue evaluation (shadow). What the rescue WOULD flip/flatten this tick. */
  lastRescuePlan: LiveRescuePlanSnapshot | null;
  /** Crowding-gated exit SHADOW measurement, keyed by symbol. Records what the derivatives-crowding
   *  signal WOULD recommend (CUT/HOLD/NEUTRAL) at each regime-harvest decision point, alongside what
   *  the harvest ACTUALLY did — so agreement/disagreement can be measured before ever wiring crowding
   *  into the real cut/hold decision. Never read by the harvest itself. */
  crowdingExitShadow: Record<string, CrowdingExitShadowEntry>;
  /** Operator lane selection for the live mirror. null = all lanes allowed (default).
   *  [] = block every new mirror (pause). Entries match a paper order's selectedLaneId
   *  either as the full id ("CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT") or its variant
   *  suffix ("CG_WIDE_FAST_SHORT"). Persisted so a restart keeps the selection. */
  allowedLaneIds: string[] | null;
  /** Operator WEIGHTED lane allocation (manual intervention, e.g. lane1 70% / lane2 30%).
   *  When set (non-empty) it takes precedence over allowedLaneIds: ONLY the listed lanes
   *  may open new positions, and each mirrored entry's size is scaled by weightPct/100.
   *  null = off. Persisted so a restart keeps the allocation. */
  laneAllocations: Array<{ laneId: string; weightPct: number }> | null;
  /**
   * Manual selector mode (operator toggle). When true, the scan trades RAW per the lane allocation
   * selector — bypassing the "smart" overlays (the 2b per-symbol book rotation) and the regime
   * direction-gate — so the operator's picked lanes execute regardless of regime. The HARD safety
   * rails (kill-switch, cluster cap, risk size, stop/TP geometry) are NEVER bypassed. Persisted.
   */
  manualSelectorMode: boolean;
  /** Watermark (closedAt ISO) of operator-selection closes already evaluated by the
   *  auto-reset rule, so a historical loss can never re-trigger a reset later. */
  laneSelectionLossWatermark: string | null;
  /** Last automatic selection reset (a losing operator-selected close returned control
   *  to the bot). Display-only provenance. */
  laneSelectionLastAutoReset: { at: string; symbol: string; pnlUsd: number } | null;
}

export interface CrowdingExitShadowEntry {
  symbol: string;
  at: string;
  /** Direction of the stuck (opposing) intent this snapshot was taken for. */
  intentDirection: "LONG" | "SHORT";
  crowdSide: CrowdSide;
  crowdingState: CrowdingState;
  /** What crowding alone would recommend: CUT (regime-aligned crowd still building = continuation),
   *  HOLD (regime-aligned crowd unwinding/exhausting = squeeze/bounce likely), or NEUTRAL (no read). */
  recommendation: "CUT" | "HOLD" | "NEUTRAL";
  /** What the harvest's OWN (unrelated) breakeven/hard-cut logic actually decided this tick, if anything. */
  actualAction: "CUT" | "HOLD";
  agree: boolean;
}

export interface LiveRescuePlanSnapshot {
  at: string;
  mode: "shadow" | "live";
  opposingDirection: "LONG" | "SHORT" | null;
  flips: RescueFlipAction[];
  flattens: RescueFlattenAction[];
  skips: RescueSkip[];
}

const LIVE_STATE_VERSION = 1;

export class LiveExecutionStore {
  private readonly file: string;
  private state: LiveExecutionState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "live-execution.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  get path(): string {
    return this.file;
  }

  getState(): LiveExecutionState {
    return this.state;
  }

  private _empty(): LiveExecutionState {
    return {
      version: LIVE_STATE_VERSION,
      intents: [],
      lastSeenCreatedAt: new Date().toISOString(),
      dailyLedger: { dateUtc: new Date().toISOString().slice(0, 10), realizedPnlUsd: 0, wins: 0, losses: 0 },
      consecutiveLosses: 0,
      totalRealizedPnlUsd: 0,
      realizedPeakUsd: 0,
      mirrorAttempts: {},
      lastControllerRegime: null,
      lastControllerMode: null,
      lastOpposingDirection: null,
      opposingSince: null,
      killedAt: null,
      killReason: null,
      lastRescuePlan: null,
      crowdingExitShadow: {},
      allowedLaneIds: null,
      laneAllocations: null,
      manualSelectorMode: false,
      laneSelectionLossWatermark: null,
      laneSelectionLastAutoReset: null,
    };
  }

  private _parse(path: string): LiveExecutionState | null {
    try {
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { intents?: unknown }).intents)) {
        return { ...this._empty(), ...(parsed as Partial<LiveExecutionState>) } as LiveExecutionState;
      }
    } catch {
      // corrupt/partial — fall through to backup
    }
    return null;
  }

  private _load(): LiveExecutionState {
    // Same never-silently-wipe discipline as the paper store: main → .bak → empty.
    return this._parse(this.file) ?? this._parse(`${this.file}.bak`) ?? this._empty();
  }

  save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      if (existsSync(this.file)) {
        try {
          copyFileSync(this.file, `${this.file}.bak`);
        } catch {
          // best-effort backup
        }
      }
      renameSync(tmp, this.file);
    } catch {
      // persistence failures must never break the engine loop
    }
  }
}

// ─── engine ──────────────────────────────────────────────────────────────────

/** Minimal paper-store surface the engine reads (kept narrow for tests). */
export interface PaperStoreReader {
  all: PaperOrder[];
  isAdmissionHalted(now: string): boolean;
}

/** Private-client surface the engine uses (subset — lets tests inject a fake). */
export type LivePrivateClient = Pick<
  BinanceFuturesPrivateClient,
  | "env"
  | "ensureTimeSync"
  | "getClockSkewMs"
  | "getExchangeFilters"
  | "getBalances"
  | "getPositions"
  | "isHedgeMode"
  | "setLeverage"
  | "setIsolatedMargin"
  | "getOpenOrders"
  | "getOpenAlgoOrders"
  | "queryOrder"
  | "queryAlgoOrder"
  | "placeOrder"
  | "placeAlgoOrder"
  | "cancelOrder"
  | "cancelAlgoOrder"
  | "cancelAllOrders"
  | "cancelAllAlgoOrders"
  | "getUserTrades"
>;

export interface LiveExecutionEngineOptions {
  config: LiveExecutionConfig;
  client: LivePrivateClient;
  store: LiveExecutionStore;
  paperStore: PaperStoreReader;
  isPaperOrderLiveEligible?: (order: PaperOrder, nowIso: string) => boolean;
  getControllerSnapshot?: () => LiveControllerSnapshot | null;
  nowIso?: () => string;
  /** Optional market-data client for the crowding-exit SHADOW measurement (getStatus().crowdingExitShadow).
   *  Read-only, best-effort: never throws, never changes the harvest's actual cut/hold decision.
   *  Omit to leave the measurement dormant (no market-data calls). */
  marketDataClient?: Pick<BinanceClient, "getFuturesFlow" | "getCandles">;
  /** Delay between queryOrder fill-confirmation retries (see resolveConfirmedFillPrice).
   *  Default 400ms; tests pass 0. */
  fillConfirmRetryDelayMs?: number;
  /** Net exchange qty per symbol (positive = long) legitimately owned by ANOTHER executor sharing
   *  this Binance account — today the cross-sectional basket executor. Without this, reconcile()
   *  flagged every basket leg as an "orphan exchange position" and force-disarmed within one tick
   *  of a basket opening (2026-07-07: confirmed live — armed → basket opened → next reconcile
   *  disarmed, defeating auto-arm every boot). Positions fully explained by these claims are not
   *  orphans; anything beyond the claimed qty still disarms exactly as before. */
  externalManagedNetQty?: () => Map<string, number>;
}

const ERROR_STREAK_DISARM = 3;
const REGIME_EXIT_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const OPEN_INTENT_STATES: ReadonlySet<LiveIntentState> = new Set(["MIRRORED", "ENTRY_PLACED", "OPEN", "TP1_FILLED_BE_SET"]);
const MIRRORABLE_PAPER_STATUSES: ReadonlySet<string> = new Set(["CREATED", "PAPER_SUBMITTED"]);
// Lanes whose open positions are dumped at market the instant they go net-positive after the
// estimated close cost (operator emergency-exit). Both removed LONG lanes are covered so any
// position they already opened escapes at the first profitable tick instead of round-tripping.
const LIVE_BREAKEVEN_EXIT_LANE_IDS = new Set([
  "CG_WIDE_LONG_RUNNER",
  "CG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER",
  "CG_WIDE_FAST_LONG",
  "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
]);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const LIVE_PERFORMANCE_REGIME_OPTIONS: Array<{ value: LivePerformanceRegimeFilter; label: string }> = [
  { value: "all", label: "All regimes" },
  { value: "short", label: "Short all" },
  { value: "long", label: "Long all" },
  { value: "mixed", label: "Mixed / choppy" },
  { value: "short_extended", label: "Short extended" },
  { value: "long_extended", label: "Long extended" },
  { value: "short_tactical", label: "Short tactical" },
  { value: "long_tactical", label: "Long tactical" },
  { value: "unknown", label: "Unknown" },
];
const LIVE_PERFORMANCE_VIEWS: Record<LivePerformanceView, {
  label: string;
  bucketLabel: string;
}> = {
  hourly: { label: "Hourly", bucketLabel: "24 hourly buckets" },
  daily: { label: "Daily", bucketLabel: "Days in selected month" },
  weekly: { label: "Weekly", bucketLabel: "Weeks in selected month" },
  monthly: { label: "Monthly", bucketLabel: "12 monthly buckets" },
  yearly: { label: "Yearly", bucketLabel: "3 yearly buckets" },
};
/**
 * A paper order whose live open fails this many times is quarantined — never re-mirrored.
 * Without this latch a signal that deterministically fails to open (e.g. the protective stop
 * is rejected -2021 because price gapped past it before the MARKET filled) is retried every
 * tick, each cycle paying entry+exit slippage+fees for nothing. Two attempts tolerates a
 * single transient blip while bounding a churn storm to 2 cycles instead of hundreds.
 */
const MAX_MIRROR_ATTEMPTS = 2;

function normalizePerformanceView(raw: string | null | undefined): LivePerformanceView {
  return raw && Object.prototype.hasOwnProperty.call(LIVE_PERFORMANCE_VIEWS, raw)
    ? raw as LivePerformanceView
    : "hourly";
}

function normalizePerformancePeriod(_raw: string | null | undefined): LivePerformancePeriod {
  return "fixed";
}

function normalizeRegimeFilter(raw: string | null | undefined): LivePerformanceRegimeFilter {
  return LIVE_PERFORMANCE_REGIME_OPTIONS.some((option) => option.value === raw)
    ? raw as LivePerformanceRegimeFilter
    : "all";
}

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function startOfUtcYear(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), 0, 1);
}

function parseAnchorDay(anchor: string | null | undefined, fallbackMs: number): number {
  if (anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    const [year, month, day] = anchor.split("-").map(Number);
    const parsed = Date.UTC(year, month - 1, day);
    if (Number.isFinite(parsed)) return parsed;
  }
  return startOfUtcDay(fallbackMs);
}

function parseAnchorMonth(anchor: string | null | undefined, fallbackMs: number): number {
  if (anchor && /^\d{4}-\d{2}$/.test(anchor)) {
    const [year, month] = anchor.split("-").map(Number);
    const parsed = Date.UTC(year, month - 1, 1);
    if (Number.isFinite(parsed)) return parsed;
  }
  return startOfUtcMonth(fallbackMs);
}

function parseAnchorYear(anchor: string | null | undefined, fallbackMs: number): number {
  if (anchor && /^\d{4}$/.test(anchor)) {
    const parsed = Date.UTC(Number(anchor), 0, 1);
    if (Number.isFinite(parsed)) return parsed;
  }
  return startOfUtcYear(fallbackMs);
}

function parseAnchorEndYear(anchor: string | null | undefined, fallbackMs: number): number {
  if (anchor && /^\d{4}$/.test(anchor)) {
    const year = Number(anchor);
    const parsed = Date.UTC(year - 2, 0, 1);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fallbackYear = new Date(fallbackMs).getUTCFullYear();
  return Date.UTC(fallbackYear - 2, 0, 1);
}

function addUtcMonths(ms: number, months: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoMonth(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function isoYear(ms: number): string {
  return new Date(ms).toISOString().slice(0, 4);
}

function buildFixedBucketStarts(sinceMs: number, untilMs: number, bucketMs: number): number[] {
  const out: number[] = [];
  for (let bucketMsCursor = sinceMs; bucketMsCursor < untilMs; bucketMsCursor += bucketMs) {
    out.push(bucketMsCursor);
  }
  return out;
}

function bucketStartForMs(ms: number, bucketStartsMs: number[], untilMs: number): number | null {
  if (ms < bucketStartsMs[0]! || ms >= untilMs) return null;
  let picked = bucketStartsMs[0]!;
  for (const bucketStart of bucketStartsMs) {
    if (bucketStart > ms) break;
    picked = bucketStart;
  }
  return picked;
}

function performanceWindow(input: {
  view: LivePerformanceView;
  anchor?: string | null;
  nowMs: number;
}): {
  sinceMs: number;
  untilMs: number;
  anchor: string | null;
  periodLabel: string;
  bucketMs: number | null;
  bucketStartsMs: number[];
  bucketForMs: (ms: number) => number | null;
} {
  const nowDayStart = startOfUtcDay(input.nowMs);
  if (input.view === "hourly") {
    const sinceMs = parseAnchorDay(input.anchor, input.nowMs);
    const untilMs = sinceMs + DAY_MS;
    const bucketStartsMs = buildFixedBucketStarts(sinceMs, untilMs, HOUR_MS);
    return {
      sinceMs,
      untilMs,
      anchor: isoDay(sinceMs),
      periodLabel: isoDay(sinceMs),
      bucketMs: HOUR_MS,
      bucketStartsMs,
      bucketForMs: (ms) => bucketStartForMs(ms, bucketStartsMs, untilMs),
    };
  }
  if (input.view === "monthly") {
    const sinceMs = parseAnchorYear(input.anchor, input.nowMs);
    const untilMs = addUtcMonths(sinceMs, 12);
    const bucketStartsMs = Array.from({ length: 12 }, (_, index) => addUtcMonths(sinceMs, index));
    return {
      sinceMs,
      untilMs,
      anchor: isoYear(sinceMs),
      periodLabel: isoYear(sinceMs),
      bucketMs: null,
      bucketStartsMs,
      bucketForMs: (ms) => bucketStartForMs(ms, bucketStartsMs, untilMs),
    };
  }
  if (input.view === "yearly") {
    const sinceMs = parseAnchorEndYear(input.anchor, input.nowMs);
    const bucketStartsMs = Array.from({ length: 3 }, (_, index) => Date.UTC(new Date(sinceMs).getUTCFullYear() + index, 0, 1));
    const untilMs = Date.UTC(new Date(sinceMs).getUTCFullYear() + 3, 0, 1);
    const startYear = isoYear(sinceMs);
    const endYear = `${Number(startYear) + 2}`;
    return {
      sinceMs,
      untilMs,
      anchor: endYear,
      periodLabel: `${startYear}-${endYear}`,
      bucketMs: null,
      bucketStartsMs,
      bucketForMs: (ms) => bucketStartForMs(ms, bucketStartsMs, untilMs),
    };
  }
  if (input.view === "daily") {
    const sinceMs = parseAnchorMonth(input.anchor, input.nowMs);
    const untilMs = addUtcMonths(sinceMs, 1);
    const bucketStartsMs = buildFixedBucketStarts(sinceMs, untilMs, DAY_MS);
    return {
      sinceMs,
      untilMs,
      anchor: isoMonth(sinceMs),
      periodLabel: isoMonth(sinceMs),
      bucketMs: DAY_MS,
      bucketStartsMs,
      bucketForMs: (ms) => bucketStartForMs(ms, bucketStartsMs, untilMs),
    };
  }
  if (input.view === "weekly") {
    const sinceMs = parseAnchorMonth(input.anchor, input.nowMs);
    const untilMs = addUtcMonths(sinceMs, 1);
    const bucketStartsMs = buildFixedBucketStarts(sinceMs, untilMs, WEEK_MS);
    return {
      sinceMs,
      untilMs,
      anchor: isoMonth(sinceMs),
      periodLabel: isoMonth(sinceMs),
      bucketMs: WEEK_MS,
      bucketStartsMs,
      bucketForMs: (ms) => bucketStartForMs(ms, bucketStartsMs, untilMs),
    };
  }
  const untilMs = nowDayStart + DAY_MS;
  const sinceMs = nowDayStart;
  const bucketStartsMs = buildFixedBucketStarts(sinceMs, untilMs, DAY_MS);
  return {
    sinceMs,
    untilMs,
    anchor: null,
    periodLabel: isoDay(sinceMs),
    bucketMs: DAY_MS,
    bucketStartsMs,
    bucketForMs: (ms) => bucketStartForMs(ms, bucketStartsMs, untilMs),
  };
}

function classifyLivePerformanceRegime(input: {
  regime: string | null;
  controllerMode: string | null;
  controllerConfidence: string | null;
}): { family: LiveRegimeFamily; bucket: LiveRegimeBucket } {
  if (!input.regime && !input.controllerMode) {
    return { family: "UNKNOWN", bucket: "UNKNOWN" };
  }
  const estimated = estimateLaneSelectorV2Regime({
    regime: input.regime,
    controllerMode: input.controllerMode,
    confidence: input.controllerConfidence,
  });
  if (estimated.direction === "MIXED") return { family: "MIXED", bucket: "MIXED" };
  if (estimated.direction === "LONG") {
    return {
      family: "LONG",
      bucket: estimated.posture === "EXTENDED_TREND" ? "LONG_EXTENDED" : "LONG_TACTICAL",
    };
  }
  if (estimated.direction === "SHORT") {
    return {
      family: "SHORT",
      bucket: estimated.posture === "EXTENDED_TREND" ? "SHORT_EXTENDED" : "SHORT_TACTICAL",
    };
  }
  return { family: "UNKNOWN", bucket: "UNKNOWN" };
}

function regimeFilterMatches(
  filter: LivePerformanceRegimeFilter,
  classified: { family: LiveRegimeFamily; bucket: LiveRegimeBucket },
): boolean {
  if (filter === "all") return true;
  if (filter === "long") return classified.family === "LONG";
  if (filter === "short") return classified.family === "SHORT";
  if (filter === "mixed") return classified.family === "MIXED";
  if (filter === "unknown") return classified.family === "UNKNOWN";
  if (filter === "long_extended") return classified.bucket === "LONG_EXTENDED";
  if (filter === "short_extended") return classified.bucket === "SHORT_EXTENDED";
  if (filter === "long_tactical") return classified.bucket === "LONG_TACTICAL";
  if (filter === "short_tactical") return classified.bucket === "SHORT_TACTICAL";
  return false;
}

/**
 * Live-mirror candidate admission priority tier — reorders (never rejects) candidates competing
 * for limited concurrent-position slots so proven symbols get first crack when slots are scarce.
 * "No obstruction": every candidate is still eligible and will still be admitted if slots allow it
 * at its tier — this only changes WHICH ONES win when there aren't enough slots for everyone.
 *
 *  Tier 0: symbol is in THIS lane's own curated whitelist at the deployment's tier (testnet/live).
 *  Tier 1: no tier-0 data (or symbol absent from it), but SOME lane has proven edge for this
 *          symbol+direction (bestLanePerSymbol stage TESTNET_CANDIDATE or PROMOTABLE) — a broader,
 *          intentionally looser fallback than tier 0, independent of deployment tier.
 *  Tier 2: no data in either lookup (report missing/stale, or symbol unmatched anywhere) — still
 *          admitted, just deprioritized relative to 0/1 when slots run out.
 */
export function symbolPriorityTier(
  symbol: string,
  direction: "LONG" | "SHORT",
  laneId: string,
  report: PerSymbolLaneBookEdgeReport | null,
  reportGeneratedAt: string | null,
  tier: LaneSymbolCurationTier | null,
  nowMs: number = Date.now(),
): 0 | 1 | 2 {
  if (report && tier) {
    const curation = getCuratedSymbolsForLane(
      report,
      reportGeneratedAt,
      laneId,
      tier,
      LANE_SYMBOL_CURATION_MAX_STALENESS_MS,
      nowMs,
    );
    if (curation.curated !== null && curation.curated.includes(symbol)) return 0;
  }
  if (report) {
    const best = report.bestLanePerSymbol.find((b) => b.symbol === symbol && b.direction === direction);
    if (best && best.stage !== "NONE") return 1;
  }
  return 2;
}

/** Realized-book performance for symbol+direction from the /research curation report — used to
 *  rank candidates WITHIN a priority tier so the mirror opens the BEST proven symbol first, not
 *  merely the oldest. Null = no measured book for this symbol+direction. */
export function symbolBookNetAvgR(
  symbol: string,
  direction: "LONG" | "SHORT",
  report: PerSymbolLaneBookEdgeReport | null,
): number | null {
  if (!report) return null;
  const best = report.bestLanePerSymbol.find((b) => b.symbol === symbol && b.direction === direction);
  return best && Number.isFinite(best.bestNetAvgR) ? best.bestNetAvgR : null;
}

/**
 * Pyramid cap (2026-07-08): should a further add to this intent be blocked? True once the intent
 * has already absorbed `freeAddLimit` adds AND still hasn't shown `minFavorableR` of real favorable
 * movement. See PYRAMID_FREE_ADD_LIMIT/PYRAMID_MIN_FAVORABLE_R for the real-loss evidence behind
 * the defaults. Pure so the real-money threshold logic is testable without the full engine.
 */
export function shouldCapPyramidAdd(
  intent: Pick<LiveIntent, "sourcePaperOrders" | "maxFavorableR">,
  freeAddLimit: number,
  minFavorableR: number,
): boolean {
  const addCount = intent.sourcePaperOrders?.length ?? 0;
  return addCount >= freeAddLimit && (intent.maxFavorableR ?? 0) < minFavorableR;
}

/** 2026-07-07 operator decision ("bukan sembarang buka"): when set, the mirror admits ONLY
 *  symbols with /research book proof (priority tier 0/1) — a DELIBERATE exception to the default
 *  never-rejects rule, so with zero proven symbols the directional slot stays empty rather than
 *  opening an unproven one. Off by default. */
export function isMirrorProvenSymbolsOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVE_MIRROR_PROVEN_SYMBOLS_ONLY === "1";
}

export class LiveExecutionEngine {
  private readonly config: LiveExecutionConfig;
  private readonly client: LivePrivateClient;
  private readonly store: LiveExecutionStore;
  private readonly paperStore: PaperStoreReader;
  private readonly isPaperOrderLiveEligible: (order: PaperOrder, nowIso: string) => boolean;
  private readonly getControllerSnapshot: () => LiveControllerSnapshot | null;
  private readonly nowIso: () => string;
  private readonly marketDataClient?: Pick<BinanceClient, "getFuturesFlow" | "getCandles">;
  private readonly fillConfirmRetryDelayMs: number;
  private readonly externalManagedNetQty: () => Map<string, number>;

  /** In-memory ONLY — restart always boots disarmed. */
  private armed = false;
  private errorStreak = 0;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;
  private reconcileIssues: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Newest candidates' first-failing mirror gate — pure observation for "kenapa ga ada trade?". */
  private lastMirrorFunnel: Array<{ id: string; symbol: string; direction: string; createdAt: string; reason: string; firstReason?: string }> = [];
  /** First-seen decision per candidate: after one tick, live candidates fall behind the watermark
   *  and every later funnel read shows only "behind_watermark" — the reason that MATTERED (the one
   *  from the tick that actually evaluated it) must be latched or it is lost forever. */
  private mirrorFirstReason = new Map<string, string>();
  private filtersCache: Map<string, FuturesSymbolFilters> | null = null;
  private leverageBySymbol = new Map<string, number>();
  private isolatedMarginSet = new Set<string>();
  /** Throttle for refreshSymbolVolatilityCache — ATR% moves slowly, no need to refetch every tick. */
  private lastVolatilityRefreshAtMs = 0;

  constructor(options: LiveExecutionEngineOptions) {
    this.config = options.config;
    this.client = options.client;
    this.store = options.store;
    this.paperStore = options.paperStore;
    this.isPaperOrderLiveEligible = options.isPaperOrderLiveEligible ?? (() => true);
    this.getControllerSnapshot = options.getControllerSnapshot ?? (() => null);
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.marketDataClient = options.marketDataClient;
    this.fillConfirmRetryDelayMs = options.fillConfirmRetryDelayMs ?? 400;
    this.externalManagedNetQty = options.externalManagedNetQty ?? (() => new Map());
    // Auto-arm must NOT punch through a latched kill: a restart preserves the kill until an
    // explicit resetKill(). (arm() already enforces this; the constructor path bypassed it.)
    if (this.config.autoArm && this.config.configErrors.length === 0 && !this.store.getState().killedAt) {
      this.armed = true;
    }
  }

  // ── arming / kill ──────────────────────────────────────────────────────────

  async arm(): Promise<{ ok: boolean; reason: string | null }> {
    if (this.config.configErrors.length > 0) return { ok: false, reason: this.config.configErrors.join("; ") };
    if (this.store.getState().killedAt) return { ok: false, reason: `kill-switch engaged at ${this.store.getState().killedAt}: ${this.store.getState().killReason}` };
    try {
      // Hedge mode breaks the one-way order model — refuse to arm.
      if (await this.client.isHedgeMode()) {
        return { ok: false, reason: "account is in hedge (dual-side) mode — switch to one-way mode first" };
      }
    } catch (error) {
      return { ok: false, reason: `cannot verify account mode: ${(error as Error).message}` };
    }
    // Re-check: a kill-switch can latch during the isHedgeMode() await above. Without this,
    // arm() would set armed=true right after engageKillSwitch() just disarmed and latched —
    // punching through the exact protection this function's own killedAt check exists to give.
    const postAwaitKill = this.store.getState().killedAt;
    if (postAwaitKill) {
      return { ok: false, reason: `kill-switch engaged at ${postAwaitKill}: ${this.store.getState().killReason}` };
    }
    this.armed = true;
    return { ok: true, reason: null };
  }

  disarm(reason: string): void {
    this.armed = false;
    this.pushReconcileIssues(`disarmed: ${reason}`);
  }

  /** Appends to reconcileIssues WITHOUT letting it grow unbounded. A persistent condition (e.g.
   *  an unresolved orphan exchange position) gets rediscovered and re-pushed every tick forever
   *  if left uncapped — getStatus() only ever displays the last 10 anyway (slice(-10)), so this
   *  cap is generous headroom for investigation, not a display limit. */
  private pushReconcileIssues(...msgs: string[]): void {
    this.reconcileIssues.push(...msgs);
    const MAX_RECONCILE_ISSUES = 200;
    if (this.reconcileIssues.length > MAX_RECONCILE_ISSUES) {
      this.reconcileIssues = this.reconcileIssues.slice(-MAX_RECONCILE_ISSUES);
    }
  }

  private currentControllerSnapshot(): LiveControllerSnapshot | null {
    try {
      return this.getControllerSnapshot();
    } catch {
      return null;
    }
  }

  private controllerSnapshotIsFresh(snapshot: LiveControllerSnapshot | null): boolean {
    if (!snapshot?.capturedAt) return false;
    const capturedMs = new Date(snapshot.capturedAt).getTime();
    if (!Number.isFinite(capturedMs)) return false;
    return Math.abs(Date.now() - capturedMs) <= REGIME_EXIT_SNAPSHOT_MAX_AGE_MS;
  }

  /** Manual emergency kill: cancel everything, flatten everything, disarm, latch. */
  async kill(reason: string): Promise<void> {
    await this.engageKillSwitch(`manual: ${reason}`);
  }

  /** Operator panic flatten: cancel every visible Binance USD-M order and reduce-only close every exchange position. */
  async flattenAllExchangePositions(reason: string): Promise<{
    ok: boolean;
    env: string;
    canceledOrderSymbols: string[];
    canceledAlgoSymbols: string[];
    flattened: Array<{ symbol: string; side: "BUY" | "SELL"; quantity: number; orderId: number | null }>;
    failed: Array<{ symbol: string; action: string; reason: string }>;
  }> {
    const st = this.store.getState();
    this.armed = false;
    st.killedAt = this.nowIso();
    st.killReason = `manual exchange flatten: ${reason}`;

    const failed: Array<{ symbol: string; action: string; reason: string }> = [];
    const canceledOrderSymbols: string[] = [];
    const canceledAlgoSymbols: string[] = [];
    const flattened: Array<{ symbol: string; side: "BUY" | "SELL"; quantity: number; orderId: number | null }> = [];
    const flattenOrderIdBySymbol = new Map<string, number | null>();

    const [positions, openOrders, openAlgoOrders] = await Promise.all([
      this.client.getPositions(),
      this.client.getOpenOrders(),
      this.client.getOpenAlgoOrders(),
    ]);
    const symbols = new Set<string>();
    for (const pos of positions) {
      if (Math.abs(pos.positionAmt) > 0) symbols.add(pos.symbol);
    }
    for (const order of openOrders) symbols.add(order.symbol);
    for (const order of openAlgoOrders) symbols.add(order.symbol);

    for (const symbol of Array.from(symbols).sort()) {
      try {
        await this.client.cancelAllOrders(symbol);
        canceledOrderSymbols.push(symbol);
      } catch (error) {
        failed.push({ symbol, action: "cancelAllOrders", reason: (error as Error).message });
      }
      try {
        await this.client.cancelAllAlgoOrders(symbol);
        canceledAlgoSymbols.push(symbol);
      } catch (error) {
        failed.push({ symbol, action: "cancelAllAlgoOrders", reason: (error as Error).message });
      }

      const pos = positions.find((candidate) => candidate.symbol === symbol);
      const quantity = Math.abs(pos?.positionAmt ?? 0);
      if (quantity <= 0) continue;
      const side: "BUY" | "SELL" = (pos?.positionAmt ?? 0) > 0 ? "SELL" : "BUY";
      try {
        const order = await this.client.placeOrder({
          symbol,
          side,
          type: "MARKET",
          quantity,
          reduceOnly: true,
          newClientOrderId: `dtc-flatten-${Date.now().toString(36)}-${symbol.slice(0, 8)}`,
        });
        flattened.push({ symbol, side, quantity, orderId: order.orderId ?? null });
        flattenOrderIdBySymbol.set(symbol, order.orderId ?? null);
      } catch (error) {
        failed.push({ symbol, action: "marketReduceOnly", reason: (error as Error).message });
      }
    }

    const affectedSymbols = new Set([...symbols]);
    for (const intent of st.intents) {
      if (!OPEN_INTENT_STATES.has(intent.state) || !affectedSymbols.has(intent.symbol)) continue;
      // A panic flatten is NEVER a win — book its realized P&L so it isn't silently dropped from
      // lane reports and the drawdown-peak rebase, same reasoning as the kill-switch path below.
      const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [
        intent.entryOrderId,
        intent.tp1OrderId,
        flattenOrderIdBySymbol.get(intent.symbol) ?? null,
      ]);
      intent.realizedPnlUsd = net;
      this.applyRealizedToLedger(net, "adverse");
      intent.state = "KILLED";
      intent.closeReason = `EXCHANGE_FLATTEN: ${reason}`;
      intent.closedAt = this.nowIso();
      intent.updatedAt = this.nowIso();
      if (failed.some((item) => item.symbol === intent.symbol)) {
        intent.lastError = `exchange flatten had symbol-level failures; check /api/live/status`;
      }
    }
    this.store.save();

    return {
      ok: failed.length === 0,
      env: this.client.env,
      canceledOrderSymbols,
      canceledAlgoSymbols,
      flattened,
      failed,
    };
  }

  /**
   * Clears a latched kill (deliberate operator action via route; guarded by confirm:"RESET").
   *
   * Clearing ONLY the latch is a footgun: killSwitchTrip() runs first on every tick, so if the
   * condition that tripped it still holds, the very next tick re-latches instantly (a "reset" that
   * does nothing). So a deliberate reset also gives a genuine fresh start:
   *  - consecutiveLosses → 0 (the streak that most commonly trips this).
   *  - realizedPeakUsd → current total (drawdown-from-peak re-based to 0 so a stale high-water mark
   *    can't re-kill immediately).
   * The DAILY ledger is intentionally left untouched: a daily-max-loss kill is meant to enforce a
   * cool-off for the rest of the UTC day, so it correctly re-latches until the day rolls over.
   */
  resetKill(): void {
    const st = this.store.getState();
    st.killedAt = null;
    st.killReason = null;
    st.consecutiveLosses = 0;
    st.realizedPeakUsd = st.totalRealizedPnlUsd;
    this.store.save();
  }

  isArmed(): boolean {
    return this.armed;
  }

  // ── controller ─────────────────────────────────────────────────────────────

  start(intervalMs = 25_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── status ─────────────────────────────────────────────────────────────────

  getStatus() {
    const st = this.store.getState();
    const openIntents = st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state));
    const controller = this.currentControllerSnapshot();
    return {
      enabled: this.config.enabled,
      env: this.config.env,
      armed: this.armed,
      configErrors: this.config.configErrors,
      killedAt: st.killedAt,
      killReason: st.killReason,
      health: {
        errorStreak: this.errorStreak,
        clockSkewMs: this.client.getClockSkewMs?.() ?? null,
        lastTickAt: this.lastTickAt,
        lastTickError: this.lastTickError,
      },
      controller,
      reconcileIssues: this.reconcileIssues.slice(-10),
      mirrorFunnel: this.lastMirrorFunnel,
      watermark: st.lastSeenCreatedAt,
      quarantinedPaperOrders: Object.values(st.mirrorAttempts).filter((n) => n >= MAX_MIRROR_ATTEMPTS).length,
      openIntents: openIntents.map((i) => ({
        paperOrderId: i.paperOrderId,
        symbol: i.symbol,
        direction: i.direction,
        state: i.state,
        qty: i.qty,
      })),
      closedToday: st.dailyLedger,
      consecutiveLosses: st.consecutiveLosses,
      totalRealizedPnlUsd: st.totalRealizedPnlUsd,
      limits: {
        riskUsdPerTrade: this.config.riskUsdPerTrade,
        maxConcurrentPositions: this.config.maxConcurrentPositions,
        maxCorrelatedAltLongPositions: this.config.maxCorrelatedAltLongPositions,
        maxCorrelatedAltShortPositions: this.config.maxCorrelatedAltShortPositions,
        maxClusterPositions: this.config.maxClusterPositions,
        dailyMaxLossUsd: this.config.dailyMaxLossUsd,
        maxConsecutiveLosses: this.config.maxConsecutiveLosses,
        scratchEpsilonUsd: this.config.scratchEpsilonUsd,
        maxDrawdownUsd: this.config.maxDrawdownUsd,
        defaultLeverage: this.config.defaultLeverage,
        maxLeverage: this.config.maxLeverage,
        maxNotionalPerTrade: this.config.maxNotionalPerTrade,
        maxPaperOrderAgeMs: this.config.maxPaperOrderAgeMs,
        mirrorAllPaperOrders: this.config.mirrorAllPaperOrders,
        testnetTakeProfitUsd: this.config.testnetTakeProfitUsd,
        testnetRegimeExitEnabled: this.config.testnetRegimeExitEnabled,
        estimatedCloseCostPct: this.config.estimatedCloseCostPct,
        mainnetKeepTestnetPolicy: this.config.mainnetKeepTestnetPolicy,
        mainnetProfitProtection: this.config.mainnetProfitProtection,
        mainnetTpR: this.config.mainnetTpR,
        // Effective profit-protection regardless of env, so the dashboard shows what's actually active.
        regimeExitActive: this.regimeProtectionActive(),
        regimeHardCutMs: this.regimeHardCutMsEffective(),
        regimeLossHardCutStopFraction: this.config.regimeLossHardCutStopFraction,
        forceMfeGiveback: this.config.forceMfeGiveback,
        losingMaxHoldMs: this.config.losingMaxHoldMs,
        profitBankNetTargetUsd: this.config.profitBankNetTargetUsd,
        profitBankThresholdUsd: this.profitBankThresholdUsd(),
      },
      rescue: {
        enabled: this.config.rescue?.enabled ?? false,
        mode: this.config.rescueExecute ? ("live" as const) : ("shadow" as const),
        config: this.config.rescue,
        lastPlan: st.lastRescuePlan,
      },
      // Crowding-gated exit — SHADOW only (see recordCrowdingExitShadow). Per-symbol: what crowding
      // would have recommended (CUT/HOLD) vs. what the harvest actually did, and whether they agree.
      crowdingExitShadow: st.crowdingExitShadow,
      // Operator lane selection for the mirror (POST /api/live/lanes + /api/live/lane-allocations).
      // Weighted allocations (when set) take precedence over the plain allow-list.
      laneSelection: {
        allowedLaneIds: st.allowedLaneIds ?? null,
        laneAllocations: st.laneAllocations ?? null,
        manualSelectorMode: st.manualSelectorMode === true,
        mode: st.laneAllocations && st.laneAllocations.length > 0
          ? ("WEIGHTED_ALLOCATION" as const)
          : st.allowedLaneIds === null || st.allowedLaneIds === undefined
            ? ("ALL_LANES" as const)
            : st.allowedLaneIds.length === 0
              ? ("PAUSED_ALL" as const)
              : ("SELECTED" as const),
        // Auto-reset rule: a losing operator-selected close beyond this USD clears the selection.
        lossResetUsd: this.config.laneSelectionLossResetUsd,
        lastAutoReset: st.laneSelectionLastAutoReset ?? null,
      },
    };
  }

  async getUsdtBalance(): Promise<{ walletBalance: number; availableBalance: number } | null> {
    const balances = await this.client.getBalances();
    const usdt = balances.find((b) => b.asset === "USDT");
    if (!usdt) return null;
    return { walletBalance: usdt.balance, availableBalance: usdt.availableBalance };
  }

  async getAccountSnapshot(): Promise<{
    walletBalance: number | null;
    availableBalance: number | null;
    unrealizedPnl: number;
    accountEquity: number | null;
    openPositionCount: number;
    openOrderCount: number;
    positions: Array<{
      symbol: string;
      direction: "LONG" | "SHORT";
      quantity: number;
      entryPrice: number;
      markPrice: number | null;
      targetTpPrice: number | null;
      targetTpGapPct: number | null;
      liquidationPrice: number | null;
      unrealizedPnl: number;
      estimatedCloseCostUsd: number;
      unrealizedAfterEstimatedCloseCostUsd: number;
      leverage: number;
      sourceOrderCount: number;
      laneIds: string[];
      /** DIRECTIONAL-slot share of this netted row (2026-07-08 operator: "pisahkan unrealized
       *  antara cross sectional dan directional"): the open intent's OWN qty/entry and its P&L
       *  computed from ITS entry — never the exchange's blended average. Null = no open intent. */
      intentDirection: "LONG" | "SHORT" | null;
      intentQty: number | null;
      intentEntryPrice: number | null;
      intentUnrealizedPnl: number | null;
      /** Cross-sectional share — filled by annotateCrossSectionalAccount (the executor's books). */
      basketQty: number | null;
      basketUnrealizedPnl: number | null;
    }>;
    lanes: Array<{
      laneId: string;
      sourceOrderCount: number;
      symbols: string[];
      notionalUsd: number;
      unrealizedPnl: number;
    }>;
    closedLanes: Array<{
      laneId: string;
      closedCount: number;
      wins: number;
      losses: number;
      realizedPnlUsd: number;
      feesUsd: number;
      symbols: string[];
      lastClosedAt: string | null;
    }>;
  }> {
    const [balance, rawPositions, openOrders] = await Promise.all([
      this.getUsdtBalance(),
      this.client.getPositions(),
      this.client.getOpenOrders(),
    ]);
    const liveState = this.store.getState();
    const positions = rawPositions.filter((position) => Math.abs(position.positionAmt) > 1e-12);
    const openIntents = liveState.intents.filter((intent) => OPEN_INTENT_STATES.has(intent.state));
    const paperById = this.paperOrderById();
    const activeSymbols = Array.from(new Set(openIntents.map((intent) => intent.symbol)));
    const openAlgoOrders = (
      await Promise.all(activeSymbols.map((symbol) => this.client.getOpenAlgoOrders(symbol)))
    ).flat();
    const intentBySymbol = new Map(openIntents.map((intent) => [intent.symbol, intent]));
    const laneMap = new Map<string, {
      sourceOrderCount: number;
      symbols: Set<string>;
      notionalUsd: number;
      unrealizedPnl: number;
    }>();

    const positionRows = positions.map((position) => {
      const intent = intentBySymbol.get(position.symbol);
      const sources = intent ? this.intentSources(intent, paperById) : [];
      const sourceQty = sources.reduce((sum, source) => sum + source.qty, 0);
      const positionNotional = Math.abs(position.positionAmt) * position.entryPrice;
      for (const source of sources) {
        const share = sourceQty > 0 ? source.qty / sourceQty : 1 / Math.max(sources.length, 1);
        const row = laneMap.get(source.laneId) ?? {
          sourceOrderCount: 0,
          symbols: new Set<string>(),
          notionalUsd: 0,
          unrealizedPnl: 0,
        };
        row.sourceOrderCount += 1;
        row.symbols.add(position.symbol);
        row.notionalUsd += positionNotional * share;
        row.unrealizedPnl += position.unRealizedProfit * share;
        laneMap.set(source.laneId, row);
      }
      const direction = position.positionAmt > 0 ? "LONG" as const : "SHORT" as const;
      const markPrice = position.markPrice > 0 ? position.markPrice : null;
      const estimatedCloseCostUsd = this.estimatedCloseCostUsd(position);
      const unrealizedAfterEstimatedCloseCostUsd = position.unRealizedProfit - estimatedCloseCostUsd;
      const targetTpPrice = intent && intent.tp1Price > 0 ? intent.tp1Price : null;
      const targetTpGapPct =
        markPrice !== null && targetTpPrice !== null
          ? direction === "LONG"
            ? ((targetTpPrice - markPrice) / markPrice) * 100
            : ((markPrice - targetTpPrice) / markPrice) * 100
          : null;
      return {
        symbol: position.symbol,
        direction,
        quantity: Math.abs(position.positionAmt),
        entryPrice: position.entryPrice,
        markPrice,
        targetTpPrice,
        targetTpGapPct,
        liquidationPrice: position.liquidationPrice > 0 ? position.liquidationPrice : null,
        unrealizedPnl: position.unRealizedProfit,
        estimatedCloseCostUsd,
        unrealizedAfterEstimatedCloseCostUsd,
        leverage: position.leverage,
        sourceOrderCount: sources.length,
        laneIds: Array.from(new Set(sources.map((source) => source.laneId))),
        intentDirection: intent ? intent.direction : null,
        intentQty: intent ? intent.qty : null,
        intentEntryPrice: intent ? (intent.filledEntryPrice ?? intent.plannedEntryPrice) : null,
        intentUnrealizedPnl:
          intent && markPrice !== null && (intent.filledEntryPrice ?? intent.plannedEntryPrice) > 0
            ? (intent.direction === "LONG"
                ? markPrice - (intent.filledEntryPrice ?? intent.plannedEntryPrice)
                : (intent.filledEntryPrice ?? intent.plannedEntryPrice) - markPrice) * intent.qty
            : null,
        basketQty: null,
        basketUnrealizedPnl: null,
      };
    });
    const unrealizedPnl = positions.reduce((sum, position) => sum + position.unRealizedProfit, 0);
    const closedLaneMap = new Map<string, {
      closedCount: number;
      wins: number;
      losses: number;
      realizedPnlUsd: number;
      feesUsd: number;
      symbols: Set<string>;
      lastClosedAt: string | null;
    }>();
    for (const intent of liveState.intents) {
      if (intent.realizedPnlUsd === null) continue;
      const sources = this.intentSources(intent, paperById);
      const totalQty = sources.reduce((sum, source) => sum + source.qty, 0);
      const realized = intent.realizedPnlUsd;
      const fees = intent.feesUsd ?? 0;
      const closedAt = intent.closedAt ?? intent.updatedAt;
      for (const source of sources) {
        const share = totalQty > 0 ? source.qty / totalQty : 1 / Math.max(sources.length, 1);
        const allocatedRealized = realized * share;
        const row = closedLaneMap.get(source.laneId) ?? {
          closedCount: 0,
          wins: 0,
          losses: 0,
          realizedPnlUsd: 0,
          feesUsd: 0,
          symbols: new Set<string>(),
          lastClosedAt: null,
        };
        row.closedCount += 1;
        if (allocatedRealized > 0) row.wins += 1;
        if (allocatedRealized < 0) row.losses += 1;
        row.realizedPnlUsd += allocatedRealized;
        row.feesUsd += fees * share;
        row.symbols.add(intent.symbol);
        if (closedAt && (!row.lastClosedAt || closedAt > row.lastClosedAt)) {
          row.lastClosedAt = closedAt;
        }
        closedLaneMap.set(source.laneId, row);
      }
    }

    return {
      walletBalance: balance?.walletBalance ?? null,
      availableBalance: balance?.availableBalance ?? null,
      unrealizedPnl,
      accountEquity: balance ? balance.walletBalance + unrealizedPnl : null,
      openPositionCount: positions.length,
      openOrderCount: openOrders.length + openAlgoOrders.length,
      positions: positionRows,
      lanes: Array.from(laneMap, ([laneId, row]) => ({
        laneId,
        sourceOrderCount: row.sourceOrderCount,
        symbols: Array.from(row.symbols).sort(),
        notionalUsd: row.notionalUsd,
        unrealizedPnl: row.unrealizedPnl,
      })).sort((left, right) => left.laneId.localeCompare(right.laneId)),
      closedLanes: Array.from(closedLaneMap, ([laneId, row]) => ({
        laneId,
        closedCount: row.closedCount,
        wins: row.wins,
        losses: row.losses,
        realizedPnlUsd: row.realizedPnlUsd,
        feesUsd: row.feesUsd,
        symbols: Array.from(row.symbols).sort(),
        lastClosedAt: row.lastClosedAt,
      })).sort((left, right) => right.realizedPnlUsd - left.realizedPnlUsd),
    };
  }

  getLanePerformanceSeries(options: {
    view?: string | null;
    period?: string | null;
    anchor?: string | null;
    regime?: string | null;
  } = {}): LiveLanePerformanceSeriesReport {
    const view = normalizePerformanceView(options.view);
    const period = normalizePerformancePeriod(options.period);
    const viewConfig = LIVE_PERFORMANCE_VIEWS[view];
    const regimeFilter = normalizeRegimeFilter(options.regime);
    const untilMs = new Date(this.nowIso()).getTime();
    const safeNowMs = Number.isFinite(untilMs) ? untilMs : Date.now();
    const window = performanceWindow({
      view,
      anchor: options.anchor,
      nowMs: safeNowMs,
    });
    const bucketStarts = window.bucketStartsMs.map((bucketMs) => new Date(bucketMs).toISOString());

    const paperById = this.paperOrderById();
    const laneRows = new Map<string, {
      realizedPnlUsd: number;
      feesUsd: number;
      closedCount: number;
      wins: number;
      losses: number;
      symbols: Set<string>;
      regimeCounts: Map<string, { family: LiveRegimeFamily; bucket: LiveRegimeBucket; count: number }>;
      buckets: Map<string, Omit<LiveLanePerformanceSeriesPoint, "cumulativePnlUsd">>;
    }>();

    for (const intent of this.store.getState().intents) {
      if (intent.realizedPnlUsd === null) continue;
      const closedAt = intent.closedAt ?? intent.updatedAt;
      const closedMs = new Date(closedAt).getTime();
      if (!Number.isFinite(closedMs) || closedMs < window.sinceMs || closedMs >= window.untilMs) continue;

      const bucketStartMs = window.bucketForMs(closedMs);
      if (bucketStartMs === null) continue;
      const bucketStart = new Date(bucketStartMs).toISOString();
      const sources = this.intentSources(intent, paperById);
      const totalQty = sources.reduce((sum, source) => sum + source.qty, 0);
      const realized = intent.realizedPnlUsd;
      const fees = intent.feesUsd ?? 0;

      for (const source of sources) {
        const share = totalQty > 0 ? source.qty / totalQty : 1 / Math.max(sources.length, 1);
        const classified = classifyLivePerformanceRegime({
          regime: source.regime ?? null,
          controllerMode: source.controllerMode ?? null,
          controllerConfidence: source.controllerConfidence ?? null,
        });
        if (!regimeFilterMatches(regimeFilter, classified)) continue;

        const allocatedRealized = realized * share;
        const laneId = source.laneId || "UNKNOWN";
        const row = laneRows.get(laneId) ?? {
          realizedPnlUsd: 0,
          feesUsd: 0,
          closedCount: 0,
          wins: 0,
          losses: 0,
          symbols: new Set<string>(),
          regimeCounts: new Map<string, { family: LiveRegimeFamily; bucket: LiveRegimeBucket; count: number }>(),
          buckets: new Map<string, Omit<LiveLanePerformanceSeriesPoint, "cumulativePnlUsd">>(),
        };
        row.realizedPnlUsd += allocatedRealized;
        row.feesUsd += fees * share;
        row.closedCount += 1;
        if (allocatedRealized > 0) row.wins += 1;
        if (allocatedRealized < 0) row.losses += 1;
        row.symbols.add(intent.symbol);

        const regimeKey = `${classified.family}|${classified.bucket}`;
        const regimeRow = row.regimeCounts.get(regimeKey) ?? { ...classified, count: 0 };
        regimeRow.count += 1;
        row.regimeCounts.set(regimeKey, regimeRow);

        const bucketRow = row.buckets.get(bucketStart) ?? {
          bucketStart,
          realizedPnlUsd: 0,
          closedCount: 0,
          wins: 0,
          losses: 0,
        };
        bucketRow.realizedPnlUsd += allocatedRealized;
        bucketRow.closedCount += 1;
        if (allocatedRealized > 0) bucketRow.wins += 1;
        if (allocatedRealized < 0) bucketRow.losses += 1;
        row.buckets.set(bucketStart, bucketRow);
        laneRows.set(laneId, row);
      }
    }

    const lanes = Array.from(laneRows, ([laneId, row]) => {
      let cumulativePnlUsd = 0;
      const points = bucketStarts.map((bucketStart) => {
        const bucket = row.buckets.get(bucketStart) ?? {
          bucketStart,
          realizedPnlUsd: 0,
          closedCount: 0,
          wins: 0,
          losses: 0,
        };
        cumulativePnlUsd += bucket.realizedPnlUsd;
        return {
          ...bucket,
          cumulativePnlUsd,
        };
      });
      return {
        laneId,
        realizedPnlUsd: row.realizedPnlUsd,
        feesUsd: row.feesUsd,
        closedCount: row.closedCount,
        wins: row.wins,
        losses: row.losses,
        winRatePct: row.closedCount > 0 ? (row.wins / row.closedCount) * 100 : null,
        symbols: Array.from(row.symbols).sort(),
        regimes: Array.from(row.regimeCounts.values()).sort((left, right) => right.count - left.count),
        points,
      };
    }).sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd));

    return {
      view,
      period,
      viewLabel: viewConfig.label,
      periodLabel: window.periodLabel,
      bucketLabel: viewConfig.bucketLabel,
      bucketMs: window.bucketMs,
      since: new Date(window.sinceMs).toISOString(),
      until: new Date(window.untilMs).toISOString(),
      anchor: window.anchor,
      regimeFilter,
      regimeOptions: LIVE_PERFORMANCE_REGIME_OPTIONS,
      bucketStarts,
      lanes,
    };
  }

  private estimatedCloseCostUsd(position: FuturesPosition): number {
    const referencePrice =
      position.markPrice > 0
        ? position.markPrice
        : position.entryPrice > 0
          ? position.entryPrice
          : 0;
    if (!(referencePrice > 0) || !Number.isFinite(referencePrice)) return 0;
    const notional = Math.abs(position.positionAmt) * referencePrice;
    if (!(notional > 0) || !Number.isFinite(notional)) return 0;
    return notional * this.config.estimatedCloseCostPct;
  }

  // ── tick orchestration ─────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickError = null;
    try {
      await this.client.ensureTimeSync();

      // 1. Kill-switch evaluation FIRST (uses persisted ledger; no exchange call needed).
      const trip = this.killSwitchTrip();
      if (trip) {
        await this.engageKillSwitch(trip);
        return;
      }

      // 2. Reconcile local intents vs exchange truth.
      await this.reconcile();

      // 3. Manage lifecycle of open intents (TP1 → breakeven, close detection).
      await this.manageLifecycle();

      // 4. Testnet safety harvest: on every fresh regime/mode change, flatten any exposure
      // that can clear the conservative close-cost estimate. Between changes, preserve the
      // older opposing-direction breakeven harvest so stale contra exposure can still free slots.
      await this.maybeCloseTestnetRegimeHarvest();

      // 4.5 Regime-flip rescue (testnet-only, SHADOW): evaluate + record what it would flip/flatten on
      // stuck counter-regime positions. Places no orders yet (see evaluateRegimeFlipRescue).
      await this.evaluateRegimeFlipRescue();

      // 4.6 Operator lane-selection auto-reset: a LOSING close of a position the operator's
      // selection opened returns control to the bot (clears allocations + allow-list).
      this.maybeAutoResetLaneSelection();

      // 5. Mirror new HEADLINE paper orders (only when armed + healthy).
      await this.mirrorNewSignals();

      this.errorStreak = 0;
    } catch (error) {
      this.errorStreak += 1;
      this.lastTickError = (error as Error).message ?? "unknown";
      if (this.errorStreak >= ERROR_STREAK_DISARM && this.armed) {
        this.disarm(`exchange error streak ${this.errorStreak} — trading blind is not allowed`);
      }
    } finally {
      this.lastTickAt = this.nowIso();
      this.ticking = false;
    }
  }

  /** Operator-initiated close of ONE open intent (dashboard "Close" button, 2026-07-07: full
   *  manual control over the directional slot — bank early when the regime turns). Cancels the
   *  symbol's protective orders, flattens ONLY the engine's own share of the netted position
   *  (cross-sectional basket legs on the same symbol are external claims and must stay open),
   *  books realized P&L into the ledger, state → CLOSED with OPERATOR_CLOSE. Never disarms,
   *  never latches the kill-switch. */
  async manualCloseIntent(paperOrderId: string): Promise<{ ok: boolean; reason: string | null; realizedPnlUsd: number | null }> {
    const st = this.store.getState();
    const intent = st.intents.find((i) => i.paperOrderId === paperOrderId && OPEN_INTENT_STATES.has(i.state));
    if (!intent) return { ok: false, reason: `no open intent for ${paperOrderId}`, realizedPnlUsd: null };
    try {
      await this.client.cancelAllOrders(intent.symbol);
      await this.client.cancelAllAlgoOrders(intent.symbol);
      const positions = await this.client.getPositions(intent.symbol);
      const pos = positions.find((p) => p.symbol === intent.symbol);
      const netAmt = pos?.positionAmt ?? 0;
      const externalClaim = this.externalManagedNetQty().get(intent.symbol) ?? 0;
      // The engine's actual share of the netted exchange position — Binance nets per symbol, so
      // |positionAmt| can include basket legs (either direction). Closing more than this share
      // would rip open a hedge the executor legitimately owns.
      const engineShare = netAmt - externalClaim;
      const dirSign = intent.direction === "LONG" ? 1 : -1;
      const remainingQty = intent.state === "TP1_FILLED_BE_SET" ? Math.max(0, intent.qty - intent.tp1Qty) : intent.qty;
      const closeQty = Math.min(remainingQty, Math.max(0, dirSign * engineShare));
      let flattenOrderId: number | null = null;
      if (closeQty > 1e-12) {
        // reduceOnly is only valid when the NET position still has the intent's sign; when basket
        // legs flip the net the plain close is justified by the external claim (same reasoning as
        // the cross-sectional executor's sibling-covered close).
        const reduceOnly = Math.sign(netAmt) === dirSign;
        const flatten = await this.client.placeOrder({
          symbol: intent.symbol,
          side: intent.direction === "LONG" ? "SELL" : "BUY",
          type: "MARKET",
          quantity: Number(closeQty.toFixed(8)),
          ...(reduceOnly ? { reduceOnly: true } : {}),
          newClientOrderId: `dtc-opcl-${intent.paperOrderId.slice(-12)}`,
        });
        flattenOrderId = flatten.orderId;
      }
      const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [intent.entryOrderId, intent.tp1OrderId, flattenOrderId]);
      intent.realizedPnlUsd = net;
      this.applyRealizedToLedger(net);
      intent.state = "CLOSED";
      intent.closeReason = "OPERATOR_CLOSE";
      intent.closedAt = this.nowIso();
      intent.updatedAt = this.nowIso();
      this.store.save();
      return { ok: true, reason: null, realizedPnlUsd: net };
    } catch (error) {
      intent.lastError = `operator close failed: ${(error as Error).message}`;
      intent.updatedAt = this.nowIso();
      this.store.save();
      return { ok: false, reason: (error as Error).message, realizedPnlUsd: null };
    }
  }

  // ── kill-switch ────────────────────────────────────────────────────────────

  private killSwitchTrip(): string | null {
    const st = this.store.getState();
    if (st.killedAt) return null; // already engaged/latched
    this.rollDailyLedger();
    if (st.dailyLedger.realizedPnlUsd <= -this.config.dailyMaxLossUsd) {
      return `daily max loss hit (${st.dailyLedger.realizedPnlUsd.toFixed(2)} USD <= -${this.config.dailyMaxLossUsd})`;
    }
    if (st.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      return `max consecutive losses hit (${st.consecutiveLosses})`;
    }
    const drawdown = st.realizedPeakUsd - st.totalRealizedPnlUsd;
    if (drawdown >= this.config.maxDrawdownUsd) {
      return `max drawdown hit (${drawdown.toFixed(2)} USD from peak)`;
    }
    return null;
  }

  private async engageKillSwitch(reason: string): Promise<void> {
    const st = this.store.getState();
    this.armed = false;
    st.killedAt = this.nowIso();
    st.killReason = reason;

    // Cancel all engine orders + flatten engine positions, symbol by symbol.
    const openIntents = st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state));
    for (const intent of openIntents) {
      try {
        await this.client.cancelAllOrders(intent.symbol);
        await this.client.cancelAllAlgoOrders(intent.symbol);
        const positions = await this.client.getPositions(intent.symbol);
        const pos = positions.find((p) => p.symbol === intent.symbol);
        let flattenOrderId: number | null = null;
        // Kill-switch flatten is per-INTENT panic, not per-symbol: flatten the engine share only.
        // The cross-sectional baskets are horizon-bounded hedges with their own breaker — the
        // operator's standing rule is that NOTHING force-flattens an open basket, so a kill on a
        // shared symbol must never take the basket's leg with it (same class as the 2026-07-07
        // WLD/DOGE hedge-eaten incidents).
        const killRaw = pos?.positionAmt ?? 0;
        const killShare = killRaw - (this.externalManagedNetQty().get(intent.symbol) ?? 0);
        const killAmt = Math.sign(killShare) === Math.sign(killRaw) ? Math.sign(killRaw) * Math.min(Math.abs(killShare), Math.abs(killRaw)) : 0;
        if (Math.abs(killAmt) > 1e-12) {
          const flatten = await this.client.placeOrder({
            symbol: intent.symbol,
            side: killAmt > 0 ? "SELL" : "BUY",
            type: "MARKET",
            quantity: Math.abs(killAmt),
            reduceOnly: true,
            newClientOrderId: `dtc-kill-${intent.paperOrderId.slice(-12)}`,
          });
          flattenOrderId = flatten.orderId;
        }
        // A kill-switch flatten is NEVER a win — book its realized P&L (almost always a loss, since
        // this only fires on a breaker tripping) so lane reports don't silently drop it and
        // resetKill()'s drawdown-peak rebase isn't understated right when it matters most.
        const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [intent.entryOrderId, intent.tp1OrderId, flattenOrderId]);
        intent.realizedPnlUsd = net;
        this.applyRealizedToLedger(net, "adverse");
        intent.state = "KILLED";
        intent.closeReason = `KILL_SWITCH: ${reason}`;
        intent.closedAt = this.nowIso();
        intent.updatedAt = this.nowIso();
      } catch (error) {
        intent.lastError = `kill flatten failed: ${(error as Error).message}`;
        // keep state — reconciliation will surface any residue loudly
      }
    }
    this.store.save();
  }

  // ── reconciliation ─────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    const st = this.store.getState();
    const openIntents = st.intents.filter((i) => i.state === "OPEN" || i.state === "TP1_FILLED_BE_SET");
    const issues: string[] = [];
    let dirty = false;

    const positions = await this.client.getPositions();
    const bySymbol = new Map(positions.map((p) => [p.symbol, p]));

    // MARKET entries use RESULT and should be visible immediately. A persisted
    // ENTRY_PLACED without exchange exposure is an interrupted/flattened attempt;
    // release its paper sources for a clean retry.
    for (const intent of st.intents) {
      if (intent.state !== "ENTRY_PLACED" && intent.state !== "MIRRORED") continue;
      const amt = bySymbol.get(intent.symbol)?.positionAmt ?? 0;
      if (Math.abs(amt) > 1e-12) continue;
      intent.state = "ERROR";
      intent.lastError = "entry intent has no exchange position; released for retry";
      intent.updatedAt = this.nowIso();
      dirty = true;
    }

    // Positions the cross-sectional executor legitimately owns on this same account. Binance nets
    // per symbol, so an engine intent and a basket leg on the same symbol show as ONE combined
    // position — subtract the external claim before judging what the ENGINE's share looks like.
    const external = this.externalManagedNetQty();
    // Float-sum slack only: leg quantities are exact exchange step multiples, so any real foreign
    // exposure exceeds this by orders of magnitude.
    const EXTERNAL_QTY_EPS = 1e-6;

    // Our intents must be backed by a real position in the right direction.
    const reportOnlyIssues: string[] = [];
    for (const intent of openIntents) {
      const pos = bySymbol.get(intent.symbol);
      const amt = (pos?.positionAmt ?? 0) - (external.get(intent.symbol) ?? 0);
      const expectedSign = intent.direction === "LONG" ? 1 : -1;
      if (Math.abs(amt) < 1e-12) continue; // position may have just closed — lifecycle will settle it
      if (Math.sign(amt) !== expectedSign) {
        issues.push(`position direction mismatch on ${intent.symbol}: exchange ${amt}, intent ${intent.direction}`);
        continue;
      }
      // MISSING-QTY alert (report-only, never disarms): books BIGGER than the exchange means some
      // close consumed managed exposure — 337 DOGE + 64 WLD vanished exactly this way on
      // 2026-07-07 with ZERO alerts (the orphan check only catches the opposite direction).
      // Restricted to full-TP intents (partial-TP lanes legitimately halve mid-life) and a 10%
      // slack so transient fill states don't spam; disarming here could loop, so it only reports.
      if (this.isFullTpExitRule(this.intentExitRule(intent)) && Math.abs(amt) < intent.qty * 0.9) {
        reportOnlyIssues.push(
          `MISSING QTY on ${intent.symbol}: engine share ${amt} < intent qty ${intent.qty} — managed exposure was consumed by something else (netting-blind close?)`,
        );
      }
    }
    if (reportOnlyIssues.length > 0) this.pushReconcileIssues(...reportOnlyIssues);

    // Exchange positions on symbols the engine never opened = orphans. NEVER auto-flatten
    // (could be the operator's own manual position) — disarm + surface instead. A position fully
    // explained by an external executor's claim is NOT an orphan; a position exceeding the claim
    // still is (the unexplained remainder could be a manual/foreign position).
    const engineSymbols = new Set(st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state)).map((i) => i.symbol));
    for (const pos of positions) {
      if (Math.abs(pos.positionAmt) <= 1e-12 || engineSymbols.has(pos.symbol)) continue;
      const claimed = external.get(pos.symbol) ?? 0;
      if (claimed !== 0 && Math.abs(pos.positionAmt - claimed) <= EXTERNAL_QTY_EPS) continue;
      issues.push(
        claimed !== 0
          ? `orphan exchange position ${pos.symbol} amt=${pos.positionAmt} (external executor claims only ${claimed})`
          : `orphan exchange position ${pos.symbol} amt=${pos.positionAmt} (not opened by engine)`,
      );
    }

    if (issues.length > 0) {
      this.pushReconcileIssues(...issues);
      if (this.armed) this.disarm(`reconciliation mismatch: ${issues[0]}`);
    }
    if (dirty) this.store.save();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private async manageLifecycle(): Promise<void> {
    const st = this.store.getState();
    let dirty = false;

    for (const intent of st.intents) {
      if (intent.state !== "OPEN" && intent.state !== "TP1_FILLED_BE_SET") continue;
      // Rescue legs have no normal stop/TP — they are governed solely by the rescue flatten trigger.
      if (intent.rescue) continue;
      try {
        const positions = await this.client.getPositions(intent.symbol);
        const pos = positions.find((p) => p.symbol === intent.symbol);
        const rawAmt = pos?.positionAmt ?? 0;
        // 2026-07-07 REAL-MONEY incidents (PROFIT_BANK ate the basket's 337 DOGE hedge at 14:36;
        // the add-failed emergency flatten ate its 64 WLD hedge at 14:25): Binance nets every
        // manager's exposure per symbol into ONE position, so rawAmt is NOT this intent's position
        // whenever the cross-sectional executor holds legs on the same symbol. Every lifecycle
        // decision below — flat detection, $-TP trigger, close quantities — acts on the ENGINE
        // SHARE only, exactly like the regime-harvest path's earlier fix.
        const externalClaim = this.externalManagedNetQty().get(intent.symbol) ?? 0;
        const amt = rawAmt - externalClaim;

        // Engine share flat ⇒ closed (stop, breakeven stop, or full TP fill chain) — even while
        // the NETTED position stays non-zero because a basket still holds the symbol.
        if (Math.abs(amt) < 1e-12) {
          await this.settleClosedIntent(intent);
          dirty = true;
          continue;
        }

        // Contaminated share (external claims exceed or flip the whole netted position): any close
        // computed from it would trade someone else's exposure — leave this intent to its resting
        // stop/TP for this tick and let reconcile surface the inconsistency.
        if (Math.sign(rawAmt) !== Math.sign(amt)) continue;
        const shareFrac = Math.max(0, Math.min(1, amt / rawAmt));

        const usdTp = await this.maybeCloseOnTestnetUsdTakeProfit(intent, pos, amt, shareFrac);
        if (usdTp.changed) dirty = true;
        if (usdTp.closed) continue;

        if (pos) {
          const liveBreakeven = await this.maybeCloseLiveBreakevenLaneAfterCost(intent, pos, amt, shareFrac);
          if (liveBreakeven.changed) dirty = true;
          if (liveBreakeven.closed) continue;
        }

        if (
          pos &&
          intent.state === "OPEN" &&
          (this.config.forceMfeGiveback || this.intentExitRule(intent) === "mfe_giveback")
        ) {
          const mfe = await this.manageMfeGiveback(intent, pos, amt);
          if (mfe.changed) dirty = true;
          if (mfe.closed) continue;
        }

        if (pos && intent.state === "OPEN") {
          const losingCut = await this.maybeCutLosingMaxHold(intent, pos, amt);
          if (losingCut.changed) dirty = true;
          if (losingCut.closed) continue;
        }

        // TP1 filled ⇒ move stop to breakeven for the runner (cancel + replace).
        if (
          intent.state === "OPEN" &&
          intent.tp1OrderId !== null &&
          !this.isFullTpExitRule(this.intentExitRule(intent))
        ) {
          const tp1 = await this.client.queryOrder(intent.symbol, intent.tp1OrderId);
          if (tp1.status === "FILLED") {
            if (intent.stopOrderId !== null) {
              try {
                await this.client.cancelAlgoOrder(intent.stopOrderId);
              } catch {
                // stop may already be gone — reconcile surfaces real residue
              }
            }
            const runnerQty = Math.abs(amt);
            const breakeven = intent.filledEntryPrice ?? intent.plannedEntryPrice;
            try {
              const beOrder = await this.client.placeAlgoOrder({
                symbol: intent.symbol,
                side: intent.direction === "LONG" ? "SELL" : "BUY",
                type: "STOP_MARKET",
                quantity: runnerQty,
                triggerPrice: breakeven,
                reduceOnly: true,
                workingType: "CONTRACT_PRICE",
                clientAlgoId: `dtc-${intent.paperOrderId.slice(-18)}-be`,
              });
              intent.beStopOrderId = beOrder.algoId;
              intent.state = "TP1_FILLED_BE_SET";
            } catch (error) {
              if (!(error instanceof BinanceFuturesPrivateError) || error.binanceCode !== -2021) {
                throw error;
              }
              const flat = await this.client.placeOrder({
                symbol: intent.symbol,
                side: intent.direction === "LONG" ? "SELL" : "BUY",
                type: "MARKET",
                quantity: runnerQty,
                reduceOnly: true,
                newClientOrderId: `dtc-${intent.paperOrderId.slice(-18)}-be-x`,
              });
              try {
                await this.client.cancelAllOrders(intent.symbol);
                await this.client.cancelAllAlgoOrders(intent.symbol);
              } catch {
                // best-effort cleanup after the runner is already closed.
              }
              const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [
                intent.entryOrderId,
                intent.tp1OrderId,
                flat.orderId,
              ]);
              intent.realizedPnlUsd = net;
              intent.feesUsd = null;
              intent.state = "CLOSED";
              intent.closedAt = this.nowIso();
              intent.closeReason = "BREAKEVEN_ALREADY_TOUCHED_MARKET_CLOSE";
              this.applyRealizedToLedger(net);
            }
            intent.updatedAt = this.nowIso();
            dirty = true;
          }
        }
      } catch (error) {
        intent.lastError = (error as Error).message ?? "lifecycle error";
        throw error; // counted by the tick error-streak guard
      }
    }
    if (dirty) this.store.save();
  }

  private intentHasLiveBreakevenExitLane(intent: LiveIntent): boolean {
    return this.intentSources(intent).some((source) => {
      const laneId = source.laneId ?? "";
      const variantId = laneId.split(":").pop() ?? laneId;
      return LIVE_BREAKEVEN_EXIT_LANE_IDS.has(laneId) || LIVE_BREAKEVEN_EXIT_LANE_IDS.has(variantId);
    });
  }

  private async maybeCloseLiveBreakevenLaneAfterCost(
    intent: LiveIntent,
    pos: FuturesPosition,
    amt: number,
    shareFrac = 1,
  ): Promise<{ changed: boolean; closed: boolean }> {
    // Runs on both real envs (mainnet + testnet) — operator wants the long-lane positions to bail
    // the instant they're net-positive everywhere they exist.
    if (this.config.env !== "mainnet" && this.config.env !== "testnet") return { changed: false, closed: false };
    if (!this.intentHasLiveBreakevenExitLane(intent)) return { changed: false, closed: false };
    const expectedSign = intent.direction === "LONG" ? 1 : -1;
    if (Math.sign(amt) !== expectedSign) return { changed: false, closed: false };

    // Own-entry basis — see maybeCloseOnTestnetUsdTakeProfit (shareFrac scaling of the netted
    // P&L is biased whenever the two books' entries differ).
    const beEntry = intent.filledEntryPrice ?? intent.plannedEntryPrice;
    const beMark = pos.markPrice > 0 ? pos.markPrice : null;
    if (beMark === null || !(beEntry > 0)) return { changed: false, closed: false };
    const beOwnUnrealized = (intent.direction === "LONG" ? beMark - beEntry : beEntry - beMark) * Math.abs(amt);
    const netAfterCost = beOwnUnrealized - this.estimatedCloseCostUsd(pos) * shareFrac;
    if (!Number.isFinite(netAfterCost) || netAfterCost < 0) return { changed: false, closed: false };

    const flat = await this.client.placeOrder({
      symbol: intent.symbol,
      side: amt > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: Math.abs(amt),
      reduceOnly: true,
      newClientOrderId: `dtc-${intent.paperOrderId.slice(-18)}-bev`,
    });
    try {
      await this.client.cancelAllOrders(intent.symbol);
      await this.client.cancelAllAlgoOrders(intent.symbol);
    } catch {
      // Position is already flattened; residue cleanup is best-effort.
    }
    const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [
      intent.entryOrderId,
      intent.tp1OrderId,
      flat.orderId,
    ]);
    intent.realizedPnlUsd = net;
    intent.feesUsd = null;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    intent.updatedAt = this.nowIso();
    intent.closeReason = "LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST";
    this.applyRealizedToLedger(net);
    return { changed: true, closed: true };
  }

  private opposingDirectionForController(mode: string | null | undefined): "LONG" | "SHORT" | null {
    if (mode === "LONG_ONLY") return "SHORT";
    if (mode === "SHORT_ONLY") return "LONG";
    return null;
  }

  private isCorrelatedAltSymbol(symbol: string): boolean {
    const normalized = symbol.toUpperCase();
    return normalized.endsWith("USDT") && normalized !== "BTCUSDT" && normalized !== "ETHUSDT";
  }

  private correlatedAltCap(direction: "LONG" | "SHORT"): number {
    return direction === "LONG"
      ? this.config.maxCorrelatedAltLongPositions
      : this.config.maxCorrelatedAltShortPositions;
  }

  private correlatedAltOpenCounts(intents: LiveIntent[]): Record<"LONG" | "SHORT", number> {
    const symbols: Record<"LONG" | "SHORT", Set<string>> = {
      LONG: new Set(),
      SHORT: new Set(),
    };
    for (const intent of intents) {
      if (!OPEN_INTENT_STATES.has(intent.state)) continue;
      if (!this.isCorrelatedAltSymbol(intent.symbol)) continue;
      symbols[intent.direction].add(intent.symbol);
    }
    return {
      LONG: symbols.LONG.size,
      SHORT: symbols.SHORT.size,
    };
  }

  /**
   * Open-position count per correlation cluster × direction (distinct symbols). MAJORS (BTC/ETH) are
   * excluded — they are exempt from the per-cluster cap. Keyed `${cluster}:${direction}`.
   */
  private clusterOpenCounts(intents: LiveIntent[]): Map<string, Set<string>> {
    const byKey = new Map<string, Set<string>>();
    for (const intent of intents) {
      if (!OPEN_INTENT_STATES.has(intent.state)) continue;
      if (isMajorSymbol(intent.symbol)) continue;
      const key = `${clusterOf(intent.symbol)}:${intent.direction}`;
      const set = byKey.get(key);
      if (set) set.add(intent.symbol);
      else byKey.set(key, new Set([intent.symbol]));
    }
    return byKey;
  }

  private stopLossProgressTowardStop(intent: LiveIntent, pos: FuturesPosition): number | null {
    const intentEntry = intent.filledEntryPrice ?? intent.plannedEntryPrice;
    const entry = intentEntry > 0 ? intentEntry : pos.entryPrice;
    const mark = pos.markPrice > 0 ? pos.markPrice : entry;
    const stop = intent.stopLossPrice;
    if (!(entry > 0) || !(mark > 0) || !(stop > 0)) return null;
    const risk = intent.direction === "LONG" ? entry - stop : stop - entry;
    if (!(risk > 0)) return null;
    const adverse = intent.direction === "LONG" ? entry - mark : mark - entry;
    return adverse / risk;
  }

  // ── crowding-gated exit — SHADOW measurement only (never alters cut/hold) ────

  /** Record what crowding WOULD have recommended for this stuck position, alongside what the harvest
   *  actually did. Best-effort: silently no-ops without a marketDataClient or on any fetch failure —
   *  must never affect the real cut/hold decision or throw into the harvest loop. */
  private async recordCrowdingExitShadow(
    symbol: string,
    opposingDirection: "LONG" | "SHORT",
    actualAction: "CUT" | "HOLD",
  ): Promise<void> {
    if (!this.marketDataClient) return;
    try {
      const snap = await fetchCrowdingSnapshot(this.marketDataClient, symbol, this.nowIso());
      const recommendation = crowdingExitRecommendation(snap.crowdSide, snap.crowdingState, opposingDirection);
      const st = this.store.getState();
      st.crowdingExitShadow[symbol] = {
        symbol,
        at: this.nowIso(),
        intentDirection: opposingDirection,
        crowdSide: snap.crowdSide,
        crowdingState: snap.crowdingState,
        recommendation,
        actualAction,
        agree: recommendation === "NEUTRAL" ? true : recommendation === actualAction,
      };
    } catch {
      // market-data hiccup — the shadow measurement can simply miss this tick
    }
  }

  // ── effective profit-protection (testnet always-on; mainnet via opt-in) ──────
  /** Regime breakeven/hard-cut harvest is active on testnet (its flag) OR mainnet (profit-protection opt-in). */
  private regimeProtectionActive(): boolean {
    return (
      (this.config.env === "testnet" && this.config.testnetRegimeExitEnabled) ||
      (this.config.env === "mainnet" && this.config.mainnetProfitProtection)
    );
  }
  /** Effective anti-bleed hard-cut window for the active env (0 = disabled). */
  private regimeHardCutMsEffective(): number {
    if (this.config.env === "testnet") return this.config.testnetRegimeHardCutMs;
    if (this.config.env === "mainnet" && this.config.mainnetProfitProtection) return this.config.mainnetRegimeHardCutMs;
    return 0;
  }
  /** Effective NET (after estimated close cost) profit-bank threshold (0 = no fixed take-profit).
   *  profitBankNetTargetUsd (either env, flat $ amount) takes priority when set — this is the general
   *  "bank small wins fast" target. Falls back to the legacy gross thresholds: testnet absolute USD,
   *  or mainnet R-based (mainnetTpR × riskUsdPerTrade) so it scales with risk rather than a blunt $ cap. */
  private profitBankThresholdUsd(): number {
    if (this.config.profitBankNetTargetUsd > 0) return this.config.profitBankNetTargetUsd;
    if (this.config.env === "testnet") return this.config.testnetTakeProfitUsd;
    if (this.config.env === "mainnet" && this.config.mainnetProfitProtection && this.config.mainnetTpR > 0) {
      return this.config.mainnetTpR * this.config.riskUsdPerTrade;
    }
    return 0;
  }

  private async maybeCloseTestnetRegimeHarvest(): Promise<void> {
    if (!this.regimeProtectionActive()) return;
    const controller = this.currentControllerSnapshot();
    if (!this.controllerSnapshotIsFresh(controller)) return;
    const currentRegime = controller?.regime ?? null;
    const currentMode = controller?.mode ?? null;

    const st = this.store.getState();
    const previousRegime = st.lastControllerRegime ?? null;
    const previousMode = st.lastControllerMode ?? null;
    const hasPreviousController = previousRegime !== null || previousMode !== null;
    const controllerChanged = hasPreviousController &&
      (previousRegime !== currentRegime || previousMode !== currentMode);
    const snapshotChanged = previousRegime !== currentRegime || previousMode !== currentMode;
    if (snapshotChanged) {
      st.lastControllerRegime = currentRegime;
      st.lastControllerMode = currentMode;
    }

    // Rescue legs are regime-aligned and governed by the rescue flatten — never harvest them (a regime
    // flip-back would otherwise let the harvest fight the rescue for the same symbol).
    const openIntents = st.intents.filter((intent) => OPEN_INTENT_STATES.has(intent.state) && !intent.rescue);
    const opposingDirection = this.opposingDirectionForController(currentMode);
    // Anti-bull hard-cut: track how long the SAME opposing side has persisted continuously. Reset the
    // clock whenever the opposed side changes or clears. Once opposition holds past testnetRegimeHardCutMs
    // (a sustained bull against our shorts), we cut even the RED opposing positions — they won't recover
    // in a sustained trend, so riding them to full stops only bleeds more.
    const opposingChanged = opposingDirection !== st.lastOpposingDirection;
    if (opposingChanged) {
      st.lastOpposingDirection = opposingDirection;
      st.opposingSince = opposingDirection ? this.nowIso() : null;
    }
    const hardCutMs = this.regimeHardCutMsEffective();
    const hardCut = opposingDirection !== null
      && hardCutMs > 0
      && st.opposingSince !== null
      && new Date(this.nowIso()).getTime() - new Date(st.opposingSince).getTime() >= hardCutMs;
    const harvestIntents = controllerChanged
      ? openIntents
      : opposingDirection
        ? openIntents.filter((intent) => intent.direction === opposingDirection)
        : [];
    if (harvestIntents.length === 0) {
      if (snapshotChanged || opposingChanged) this.store.save();
      return;
    }

    const positions = await this.client.getPositions();
    const bySymbol = new Map(positions.map((position) => [position.symbol, position]));
    let dirty = snapshotChanged;

    const externalClaims = this.externalManagedNetQty();
    for (const intent of harvestIntents) {
      const pos = bySymbol.get(intent.symbol);
      const amt = pos?.positionAmt ?? 0;
      if (!pos || Math.abs(amt) < 1e-12) continue;
      // 2026-07-07 REAL-MONEY INCIDENT: this loop closed Math.abs(amt) = the WHOLE netted
      // position — on a symbol shared with cross-sectional basket legs it flattened the basket's
      // hedge too (DOGEUSDT: intent 1065 + basket 665 short, harvest bought 1730, leaving two
      // baskets silently un-hedged). Everything below operates on the ENGINE'S SHARE only.
      const externalClaim = externalClaims.get(intent.symbol) ?? 0;
      const engineAmt = amt - externalClaim;
      if (Math.abs(engineAmt) < 1e-12) continue; // engine has no real exposure here
      const expectedSign = intent.direction === "LONG" ? 1 : -1;
      if (Math.sign(engineAmt) !== expectedSign) continue;
      // The exchange's unrealized/cost numbers describe the NETTED position; when the engine owns
      // only a fraction (same-sign basket legs), scale by its share. If the basket legs flipped
      // the net sign entirely, the netted P&L says nothing about the engine's leg — skip and
      // leave the intent to its own stop rather than harvest on contaminated numbers.
      if (Math.sign(amt) !== Math.sign(engineAmt)) continue;
      const shareFrac = Math.max(0, Math.min(1, engineAmt / amt));

      const estimatedCloseCostUsd = this.estimatedCloseCostUsd(pos) * shareFrac;
      const netAfterCost = pos.unRealizedProfit * shareFrac - estimatedCloseCostUsd;
      const green = Number.isFinite(netAfterCost) && netAfterCost >= 0;
      const stopLossProgress = this.stopLossProgressTowardStop(intent, pos);
      const lossHardCutThis =
        opposingDirection !== null &&
        intent.direction === opposingDirection &&
        this.config.regimeLossHardCutStopFraction > 0 &&
        stopLossProgress !== null &&
        stopLossProgress >= this.config.regimeLossHardCutStopFraction;
      // Cut RED positions ONLY when the current regime opposes them: either by sustained timer
      // or by adverse progress to stop. The loss-progress cut protects fast flips without waiting
      // for the time hard-cut window.
      const hardCutThis = hardCut && opposingDirection !== null && intent.direction === opposingDirection;
      // SHADOW measurement only — records what crowding would have recommended vs. what actually
      // happens below; never read by the cut/hold decision itself.
      if (opposingDirection !== null && intent.direction === opposingDirection) {
        await this.recordCrowdingExitShadow(intent.symbol, opposingDirection, green || hardCutThis || lossHardCutThis ? "CUT" : "HOLD");
      }
      if (!green && !hardCutThis && !lossHardCutThis) continue; // red & not an opposition cut → leave to its stop

      // Close ONLY the engine's share (bounded by the intent's remaining qty) — never the whole
      // netted position, which can include cross-sectional basket legs on the same symbol.
      const remainingQty = intent.state === "TP1_FILLED_BE_SET" ? Math.max(0, intent.qty - intent.tp1Qty) : intent.qty;
      const harvestQty = Math.min(Math.abs(engineAmt), remainingQty > 0 ? remainingQty : Math.abs(engineAmt));
      const flat = await this.client.placeOrder({
        symbol: intent.symbol,
        side: engineAmt > 0 ? "SELL" : "BUY",
        type: "MARKET",
        quantity: Number(harvestQty.toFixed(8)),
        reduceOnly: true,
        newClientOrderId: `dtc-${intent.paperOrderId.slice(-18)}-reg`,
      });
      try {
        await this.client.cancelAllOrders(intent.symbol);
        await this.client.cancelAllAlgoOrders(intent.symbol);
      } catch {
        // Position is already flattened; exit-order cleanup remains best-effort.
      }
      const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [
        intent.entryOrderId,
        intent.tp1OrderId,
        flat.orderId,
      ]);
      intent.realizedPnlUsd = net;
      intent.feesUsd = null;
      intent.state = "CLOSED";
      intent.closedAt = this.nowIso();
      intent.updatedAt = this.nowIso();
      intent.closeReason = !green
        ? (lossHardCutThis
            ? `REGIME_OPPOSITION_LOSS_HARD_CUT_${currentMode ?? "UNKNOWN"}_${Math.round(this.config.regimeLossHardCutStopFraction * 100)}PCT_STOP`
            : `REGIME_OPPOSITION_HARD_CUT_${currentMode ?? "UNKNOWN"}`)
        : controllerChanged
          ? `REGIME_CHANGE_HARVEST_${previousMode ?? previousRegime ?? "UNKNOWN"}_TO_${currentMode ?? currentRegime ?? "UNKNOWN"}`
          : `REGIME_OPPOSITION_BREAKEVEN_${currentMode ?? "UNKNOWN"}`;
      this.applyRealizedToLedger(net);
      dirty = true;
    }

    if (dirty) this.store.save();
  }

  /**
   * Regime-flip rescue (testnet-only).
   *
   * Builds one view per engine-owned symbol with live exposure and asks the pure planner what to flip
   * (a stuck counter-regime position → net regime-aligned) and flatten (a rescued symbol whose combined
   * venture cleared the target, or whose max-hold elapsed). The plan is persisted to
   * `state.lastRescuePlan` and surfaced in getStatus.
   *
   * SHADOW (default): records the plan, places no orders. LIVE (LIVE_TESTNET_RESCUE_MODE=live, testnet):
   * executes — flattens always (risk-reducing), flips only when armed (they OPEN exposure). A flip is
   * reconcile-safe because it CLOSES the stuck opposing intent and registers the resulting net leg as a
   * dedicated rescue intent, so the next reconcile sees intent.direction == position sign (no disarm).
   */
  private async evaluateRegimeFlipRescue(): Promise<void> {
    const rcfg = this.config.rescue;
    if (!rcfg?.enabled) return; // testnet-only + flag; parseRegimeFlipRescueConfig forces false on mainnet
    const controller = this.currentControllerSnapshot();
    if (!this.controllerSnapshotIsFresh(controller)) return;
    const opposingDirection = this.opposingDirectionForController(controller?.mode ?? null);

    const st = this.store.getState();
    const openIntents = st.intents.filter((intent) => OPEN_INTENT_STATES.has(intent.state));
    if (openIntents.length === 0) {
      if (st.lastRescuePlan) {
        st.lastRescuePlan = null;
        this.store.save();
      }
      return;
    }

    const engineSymbols = new Set(openIntents.map((intent) => intent.symbol));
    const rescueIntentBySymbol = new Map<string, LiveIntent>();
    const oldestNonRescueBySymbol = new Map<string, number>();
    for (const intent of openIntents) {
      if (intent.rescue) {
        rescueIntentBySymbol.set(intent.symbol, intent);
        continue;
      }
      const t = new Date(intent.createdAt).getTime();
      const prev = oldestNonRescueBySymbol.get(intent.symbol);
      if (prev === undefined || (Number.isFinite(t) && t < prev)) oldestNonRescueBySymbol.set(intent.symbol, t);
    }

    const positions = await this.client.getPositions();
    const balance = await this.getUsdtBalance();
    const nowMs = new Date(this.nowIso()).getTime();

    const views: RescuePositionView[] = [];
    for (const pos of positions) {
      if (!engineSymbols.has(pos.symbol)) continue;
      const amt = pos.positionAmt;
      if (Math.abs(amt) < 1e-12) continue;
      const rescueIntent = rescueIntentBySymbol.get(pos.symbol);
      const inRescue = !!rescueIntent;
      const estCost = this.estimatedCloseCostUsd(pos);
      views.push({
        symbol: pos.symbol,
        // The netted exchange exposure IS the truth; reconcile enforces intent==position sign.
        intentDirection: amt > 0 ? "LONG" : "SHORT",
        positionAmt: amt,
        markPrice: pos.markPrice,
        unrealizedUsd: pos.unRealizedProfit,
        netAfterCostUsd: pos.unRealizedProfit - estCost,
        openedAtMs: inRescue
          ? new Date(rescueIntent!.createdAt).getTime()
          : (oldestNonRescueBySymbol.get(pos.symbol) ?? nowMs),
        inRescue,
        priorRealizedUsd: inRescue ? (rescueIntent!.rescuePriorRealizedUsd ?? 0) : 0,
      });
    }

    const plan = planRegimeFlipRescue({
      config: rcfg,
      opposingDirection,
      nowMs,
      availableBalanceUsd: balance?.availableBalance ?? null,
      positions: views,
      activeRescueCount: rescueIntentBySymbol.size,
    });

    if (this.config.rescueExecute) {
      // Flattens first (reduce-only, risk-reducing) — allowed even while disarmed.
      for (const action of plan.flattens) {
        try {
          await this.executeRescueFlatten(action, rescueIntentBySymbol.get(action.symbol));
        } catch (error) {
          this.pushReconcileIssues(`rescue flatten ${action.symbol} failed: ${(error as Error).message}`);
        }
      }
      // Flips OPEN new exposure — only when armed.
      if (this.armed) {
        for (const action of plan.flips) {
          try {
            await this.executeRescueFlip(action, openIntents.filter((i) => i.symbol === action.symbol && !i.rescue));
          } catch (error) {
            this.pushReconcileIssues(`rescue flip ${action.symbol} failed: ${(error as Error).message}`);
          }
        }
      }
    }

    st.lastRescuePlan = {
      at: this.nowIso(),
      mode: this.config.rescueExecute ? "live" : "shadow",
      opposingDirection,
      flips: plan.flips,
      flattens: plan.flattens,
      skips: plan.skips,
    };
    this.store.save();
  }

  /** Reduce-only close the net rescue leg and settle the rescue intent. Books ONLY the live leg's
   *  realized (the stuck leg's loss was already booked at flip via rescuePriorRealizedUsd). */
  private async executeRescueFlatten(action: RescueFlattenAction, rescueIntent: LiveIntent | undefined): Promise<void> {
    if (!rescueIntent) return;
    const flat = await this.client.placeOrder({
      symbol: action.symbol,
      side: action.side,
      type: "MARKET",
      quantity: action.qty,
      reduceOnly: true,
      newClientOrderId: `dtc-${rescueIntent.paperOrderId.slice(-14)}-rscx`,
    });
    try {
      await this.client.cancelAllOrders(action.symbol);
      await this.client.cancelAllAlgoOrders(action.symbol);
    } catch {
      // residue cleanup is best-effort after the position is flat
    }
    const liveLegRealized = await this.realizedFromTrades(action.symbol, rescueIntent.createdAt, [flat.orderId]);
    rescueIntent.realizedPnlUsd = liveLegRealized;
    rescueIntent.feesUsd = null;
    rescueIntent.state = "CLOSED";
    rescueIntent.closedAt = this.nowIso();
    rescueIntent.updatedAt = this.nowIso();
    rescueIntent.closeReason = action.reason.startsWith("max-hold") ? "RESCUE_MAXHOLD_CUT" : "RESCUE_FLATTEN_TARGET";
    this.applyRealizedToLedger(liveLegRealized);
  }

  /** Place the cross-zero flip order, settle+close the stuck opposing intents (booking their realized
   *  loss), and register the resulting net leg as a dedicated rescue intent so reconcile stays sane. */
  private async executeRescueFlip(action: RescueFlipAction, opposingIntents: LiveIntent[]): Promise<void> {
    const filters = await this.getFilters(action.symbol);
    if (!filters) return;
    const qty = roundDownToStep(action.flipQty, filters.stepSize);
    if (!(qty >= filters.minQty)) return;
    const opposingAbs = opposingIntents.reduce((sum, i) => sum + Math.abs(i.qty), 0);
    if (!(qty > opposingAbs)) return; // would only reduce, not flip — leave it to the harvest

    try {
      await this.client.setLeverage(action.symbol, this.config.defaultLeverage);
    } catch {
      // leverage already set / best-effort
    }
    const flip = await this.client.placeOrder({
      symbol: action.symbol,
      side: action.side,
      type: "MARKET",
      quantity: qty,
      reduceOnly: false,
      newClientOrderId: `dtc-rescue-${action.symbol.toLowerCase().slice(0, 8)}-${this.nowIso().replace(/[^0-9]/g, "").slice(-10)}`,
    });

    // The flip order closed the opposing leg(s): book their realized loss and close them.
    let priorRealized = 0;
    for (const oi of opposingIntents) {
      const r = await this.realizedFromTrades(action.symbol, oi.createdAt, [oi.entryOrderId, oi.tp1OrderId, flip.orderId]);
      priorRealized += r;
      oi.realizedPnlUsd = r;
      oi.feesUsd = null;
      oi.state = "CLOSED";
      oi.closedAt = this.nowIso();
      oi.updatedAt = this.nowIso();
      oi.closeReason = "RESCUE_FLIP";
      this.applyRealizedToLedger(r);
    }
    try {
      await this.client.cancelAllOrders(action.symbol);
      await this.client.cancelAllAlgoOrders(action.symbol);
    } catch {
      // the opposing leg's stop/TP are stale now — best-effort cancel
    }

    const after = (await this.client.getPositions(action.symbol)).find((p) => p.symbol === action.symbol);
    const netAmt = after?.positionAmt ?? 0;
    if (Math.abs(netAmt) < 1e-12) return; // flip fully flattened — venture closed at the flip, no leg to track

    // `?? ` does NOT catch a real 0 (avgPrice is typed number, never null/undefined) — `flip.avgPrice
    // ?? after?.entryPrice` would keep a genuine avgPrice=0 echo forever, skipping the fresh,
    // exchange-confirmed after.entryPrice fetched two lines above. Explicit `> 0` checks, and prefer
    // the post-fetch exchange truth (after.entryPrice) over the order-placement echo (flip.avgPrice).
    const resolvedFlipEntry =
      after?.entryPrice && after.entryPrice > 0 ? after.entryPrice : flip.avgPrice > 0 ? flip.avgPrice : null;
    const st = this.store.getState();
    st.intents.push({
      paperOrderId: `rescue-${action.symbol}-${this.nowIso()}`,
      symbol: action.symbol,
      direction: netAmt > 0 ? "LONG" : "SHORT",
      state: "OPEN",
      qty: Math.abs(netAmt),
      tp1Qty: 0,
      plannedEntryPrice: resolvedFlipEntry ?? 0,
      stopLossPrice: 0,
      tp1Price: 0,
      filledEntryPrice: resolvedFlipEntry,
      entryPriceConfirmed: resolvedFlipEntry !== null,
      entryOrderId: flip.orderId,
      stopOrderId: null,
      tp1OrderId: null,
      beStopOrderId: null,
      realizedPnlUsd: null,
      feesUsd: null,
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
      closedAt: null,
      closeReason: null,
      lastError: null,
      rescue: true,
      rescuePriorRealizedUsd: priorRealized,
    });
  }

  private async maybeCloseOnTestnetUsdTakeProfit(
    intent: LiveIntent,
    pos: FuturesPosition | undefined,
    amt: number,
    shareFrac = 1,
  ): Promise<{ changed: boolean; closed: boolean }> {
    const threshold = this.profitBankThresholdUsd();
    if (!(threshold > 0)) return { changed: false, closed: false };
    if (!pos) return { changed: false, closed: false };
    // Trigger from the INTENT'S OWN ENTRY, never the netted exchange P&L. The earlier shareFrac
    // scaling of pos.unRealizedProfit was still biased whenever the intent's entry differed from
    // the basket legs' entries on the same symbol — 2026-07-08: two more "PROFIT_BANK_NET_1.00"
    // closes realized NEGATIVE (−0.035 DOGE, −0.015 WLD) through exactly that bias.
    const pbEntry = intent.filledEntryPrice ?? intent.plannedEntryPrice;
    const pbMark = pos.markPrice > 0 ? pos.markPrice : null;
    if (pbMark === null || !(pbEntry > 0)) return { changed: false, closed: false };
    const ownUnrealized = (intent.direction === "LONG" ? pbMark - pbEntry : pbEntry - pbMark) * Math.abs(amt);
    const netAfterCost = ownUnrealized - this.estimatedCloseCostUsd(pos) * shareFrac;
    if (!Number.isFinite(netAfterCost) || netAfterCost < threshold) return { changed: false, closed: false };

    const flat = await this.client.placeOrder({
      symbol: intent.symbol,
      side: amt > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: Math.abs(amt),
      reduceOnly: true,
      newClientOrderId: `dtc-${intent.paperOrderId.slice(-18)}-usd`,
    });
    try {
      await this.client.cancelAllOrders(intent.symbol);
      await this.client.cancelAllAlgoOrders(intent.symbol);
    } catch {
      // best-effort residue cleanup after the position has already been closed.
    }
    const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [
      intent.entryOrderId,
      intent.tp1OrderId,
      flat.orderId,
    ]);
    intent.realizedPnlUsd = net;
    intent.feesUsd = null;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    intent.updatedAt = this.nowIso();
    intent.closeReason = `PROFIT_BANK_NET_${threshold.toFixed(2)}`;
    this.applyRealizedToLedger(net);
    return { changed: true, closed: true };
  }

  private async manageMfeGiveback(intent: LiveIntent, pos: FuturesPosition, amt: number): Promise<{ changed: boolean; closed: boolean }> {
    const entry = intent.filledEntryPrice ?? intent.plannedEntryPrice;
    const risk = Math.abs(entry - intent.stopLossPrice);
    if (!(entry > 0) || !(risk > 0)) return { changed: false, closed: false };
    const mark = pos.markPrice > 0 ? pos.markPrice : pos.entryPrice > 0 ? pos.entryPrice : entry;
    const favorableR = intent.direction === "SHORT" ? (entry - mark) / risk : (mark - entry) / risk;
    const previousPeak = intent.maxFavorableR ?? 0;
    const peak = Math.max(previousPeak, favorableR);
    const changed = peak !== previousPeak;
    intent.maxFavorableR = peak;
    if (peak < MFE_GIVEBACK_ARM_R) return { changed, closed: false };

    const exitR = peak * (1 - MFE_GIVEBACK_FRAC);
    if (favorableR > exitR) return { changed, closed: false };

    try {
      if (intent.stopOrderId !== null) await this.client.cancelAlgoOrder(intent.stopOrderId);
      if (intent.tp1OrderId !== null) await this.client.cancelOrder(intent.symbol, intent.tp1OrderId);
      if (intent.beStopOrderId !== null) await this.client.cancelAlgoOrder(intent.beStopOrderId);
    } catch {
      // The reduce-only market close below is the critical safety action; cleanup is best-effort.
    }

    const flat = await this.client.placeOrder({
      symbol: intent.symbol,
      side: amt > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: Math.abs(amt),
      reduceOnly: true,
      newClientOrderId: `dtc-${intent.paperOrderId.slice(-18)}-mfe`,
    });
    try {
      await this.client.cancelAllOrders(intent.symbol);
      await this.client.cancelAllAlgoOrders(intent.symbol);
    } catch {
      // best-effort residue cleanup after the position has already been closed.
    }
    const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [
      intent.entryOrderId,
      intent.tp1OrderId,
      flat.orderId,
    ]);
    intent.realizedPnlUsd = net;
    intent.feesUsd = null;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    intent.updatedAt = this.nowIso();
    intent.closeReason = "MFE_GIVEBACK_EXIT";
    this.applyRealizedToLedger(net);
    return { changed: true, closed: true };
  }

  /**
   * Phase-2 loss-cut: a position that has been open longer than losingMaxHoldMs AND is currently
   * LOSING gets flattened at market. Winners (favorableR >= 0) are never touched — this kills the
   * "losers sit 9.5 hours until a regime cut crystallizes -$2.7" pattern without capping upside.
   */
  private async maybeCutLosingMaxHold(intent: LiveIntent, pos: FuturesPosition, amt: number): Promise<{ changed: boolean; closed: boolean }> {
    if (this.config.losingMaxHoldMs <= 0) return { changed: false, closed: false };
    const openedMs = Date.parse(intent.createdAt);
    const nowMs = Date.parse(this.nowIso());
    if (!Number.isFinite(openedMs) || !Number.isFinite(nowMs)) return { changed: false, closed: false };
    if (nowMs - openedMs < this.config.losingMaxHoldMs) return { changed: false, closed: false };

    const entry = intent.filledEntryPrice ?? intent.plannedEntryPrice;
    const risk = Math.abs(entry - intent.stopLossPrice);
    if (!(entry > 0) || !(risk > 0)) return { changed: false, closed: false };
    const mark = pos.markPrice > 0 ? pos.markPrice : pos.entryPrice > 0 ? pos.entryPrice : entry;
    const favorableR = intent.direction === "SHORT" ? (entry - mark) / risk : (mark - entry) / risk;
    if (favorableR >= 0) return { changed: false, closed: false }; // never cut a winner

    try {
      if (intent.stopOrderId !== null) await this.client.cancelAlgoOrder(intent.stopOrderId);
      if (intent.tp1OrderId !== null) await this.client.cancelOrder(intent.symbol, intent.tp1OrderId);
      if (intent.beStopOrderId !== null) await this.client.cancelAlgoOrder(intent.beStopOrderId);
    } catch {
      // The reduce-only market close below is the critical safety action; cleanup is best-effort.
    }

    const flat = await this.client.placeOrder({
      symbol: intent.symbol,
      side: amt > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: Math.abs(amt),
      reduceOnly: true,
      newClientOrderId: `dtc-${intent.paperOrderId.slice(-18)}-lmh`,
    });
    try {
      await this.client.cancelAllOrders(intent.symbol);
      await this.client.cancelAllAlgoOrders(intent.symbol);
    } catch {
      // best-effort residue cleanup after the position has already been closed.
    }
    const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [
      intent.entryOrderId,
      intent.tp1OrderId,
      flat.orderId,
    ]);
    intent.realizedPnlUsd = net;
    intent.feesUsd = null;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    intent.updatedAt = this.nowIso();
    intent.closeReason = `LOSING_MAX_HOLD_CUT_${Math.round(this.config.losingMaxHoldMs / 3_600_000)}H`;
    this.applyRealizedToLedger(net);
    return { changed: true, closed: true };
  }

  private async settleClosedIntent(intent: LiveIntent): Promise<void> {
    // Clear any leftover exit orders (e.g. TP1 still resting after a stop-out).
    try {
      await this.client.cancelAllOrders(intent.symbol);
      await this.client.cancelAllAlgoOrders(intent.symbol);
    } catch {
      // best-effort cleanup; reconcile surfaces residue
    }
    let realized = 0;
    let fees = 0;
    try {
      const triggeredAlgoOrderIds: number[] = [];
      for (const algoId of [intent.stopOrderId, intent.beStopOrderId]) {
        if (algoId === null) continue;
        try {
          const algo = await this.client.queryAlgoOrder(algoId);
          if (algo.actualOrderId !== null) triggeredAlgoOrderIds.push(algo.actualOrderId);
        } catch {
          // The trade list below still captures normal TP fills.
        }
      }
      const trades = await this.client.getUserTrades(intent.symbol, {
        startTime: new Date(intent.createdAt).getTime(),
        limit: 200,
      });
      const ourOrderIds = new Set(
        [intent.entryOrderId, intent.tp1OrderId, ...triggeredAlgoOrderIds].filter(
          (id): id is number => typeof id === "number",
        ),
      );
      for (const t of trades) {
        if (!ourOrderIds.has(t.orderId)) continue;
        realized += t.realizedPnl;
        fees += t.commission; // commissionAsset assumed USDT on USD-M pairs
      }
    } catch (error) {
      intent.lastError = `settle: trades fetch failed (${(error as Error).message}) — PnL recorded as 0, check manually`;
    }

    const net = realized - fees;
    intent.realizedPnlUsd = net;
    intent.feesUsd = fees;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    intent.updatedAt = this.nowIso();
    intent.closeReason = intent.closeReason ?? "POSITION_FLAT";

    this.applyRealizedToLedger(net);
  }

  /**
   * Fold a realized result into the daily ledger, consecutive-loss streak, total and peak.
   * EVERY exchange-realized close — a clean stop-out OR an emergency flatten — must flow
   * through here so the kill-switch and daily-loss breaker can see it. A churn storm that
   * flattened without recording its losses is exactly how the engine burned hundreds of
   * dollars while the consecutive-loss breaker sat at zero.
   */
  private applyRealizedToLedger(net: number, classification: "auto" | "adverse" = "auto"): void {
    const st = this.store.getState();
    this.rollDailyLedger();
    st.dailyLedger.realizedPnlUsd += net;
    // An emergency flatten is NEVER a win, even if its realized PnL rounds to ~0 (e.g. the trade
    // fetch failed and net came back 0). Classifying it "adverse" stops a flatten from RESETTING
    // the consecutive-loss streak and masking churn from the kill-switch.
    //
    // A near-breakeven "scratch" (an auto profit-bank / breakeven-after-cost exit that gave back
    // only fees) is NEITHER a win NOR a loss: it must not inflate the consecutive-loss streak, and
    // it must not reset it either — it is neutral. This false-tripped the kill-switch on 2026-07-04
    // (3 of the 6 "losses" that killed live were -$0.017 fee-only scratches). An "adverse" flatten
    // is exempt — it always counts as a loss regardless of magnitude, so churn stays visible.
    const isScratch = classification !== "adverse" && Math.abs(net) < this.config.scratchEpsilonUsd;
    if (isScratch) {
      st.dailyLedger.scratches = (st.dailyLedger.scratches ?? 0) + 1;
    } else {
      const isLoss = classification === "adverse" || net < 0;
      if (isLoss) {
        st.dailyLedger.losses += 1;
        st.consecutiveLosses += 1;
      } else {
        st.dailyLedger.wins += 1;
        st.consecutiveLosses = 0;
      }
    }
    st.totalRealizedPnlUsd += net;
    if (st.totalRealizedPnlUsd > st.realizedPeakUsd) st.realizedPeakUsd = st.totalRealizedPnlUsd;
  }

  /** Sum realized PnL net of fees for the given order ids on a symbol since an ISO time (best-effort; 0 on failure). */
  private async realizedFromTrades(symbol: string, sinceIso: string, orderIds: Array<number | null>): Promise<number> {
    const ids = new Set(orderIds.filter((id): id is number => typeof id === "number"));
    if (ids.size === 0) return 0;
    try {
      const trades = await this.client.getUserTrades(symbol, { startTime: new Date(sinceIso).getTime(), limit: 200 });
      let net = 0;
      for (const t of trades) {
        if (ids.has(t.orderId)) net += t.realizedPnl - t.commission;
      }
      return net;
    } catch {
      return 0;
    }
  }

  private rollDailyLedger(): void {
    const st = this.store.getState();
    const today = this.nowIso().slice(0, 10);
    if (st.dailyLedger.dateUtc !== today) {
      st.dailyLedger = { dateUtc: today, realizedPnlUsd: 0, wins: 0, losses: 0 };
    }
  }

  // ── mirroring ──────────────────────────────────────────────────────────────

  /** Weighted allocation lookup: 100 when allocations are off; the lane's weightPct when
   *  listed; 0 (blocked) when allocations are ON but the lane is not listed. */
  laneSelectionWeightPctForLane(laneId: string): number {
    const allocations = this.store.getState().laneAllocations;
    if (!allocations || allocations.length === 0) return 100;
    const variantId = laneId.split(":").pop() ?? laneId;
    const hit = allocations.find((a) => a.laneId === laneId || a.laneId === variantId);
    return hit ? hit.weightPct : 0;
  }

  /** Operator lane selection for non-paper lanes too (e.g. cross-sectional executor).
   *  Weighted allocations take precedence; otherwise the plain allow-list applies. */
  laneSelectionAllowsLane(laneId: string): boolean {
    const st = this.store.getState();
    if (st.laneAllocations && st.laneAllocations.length > 0) {
      return this.laneSelectionWeightPctForLane(laneId) > 0;
    }
    const allowed = st.allowedLaneIds;
    if (allowed === null || allowed === undefined) return true;
    const variantId = laneId.split(":").pop() ?? laneId;
    return allowed.includes(laneId) || allowed.includes(variantId);
  }

  /** True only when the operator explicitly picked this lane in weighted allocation
   *  or the legacy allow-list. Unlike laneSelectionAllowsLane(), ALL_LANES is not
   *  treated as explicit. Used for manual-only experimental lanes. */
  laneSelectionExplicitlyIncludesLane(laneId: string): boolean {
    const st = this.store.getState();
    const variantId = laneId.split(":").pop() ?? laneId;
    const allocations = st.laneAllocations ?? [];
    if (allocations.some((a) => a.laneId === laneId || a.laneId === variantId)) return true;
    const allowed = st.allowedLaneIds;
    return Array.isArray(allowed) && allowed.some((id) => id === laneId || id === variantId);
  }

  private laneAllocationWeightPct(paper: PaperOrder): number {
    return this.laneSelectionWeightPctForLane(paper.selectedLaneId ?? "");
  }

  /** Operator lane selection: weighted allocations (when set) take precedence; else the
   *  plain allow-list (null = all lanes, [] = pause all new mirrors). Matches
   *  selectedLaneId as full id or variant suffix. */
  private laneAllowedForMirror(paper: PaperOrder): boolean {
    return this.laneSelectionAllowsLane(paper.selectedLaneId ?? "");
  }

  /** True when an operator selection (weighted allocation OR allow-list) is active AND
   *  this paper order's lane is one the operator picked — i.e. the resulting position
   *  exists because of the manual selection, not the bot's normal routing. */
  private operatorSelectionActiveFor(paper: PaperOrder): boolean {
    const st = this.store.getState();
    const hasAllocations = !!st.laneAllocations && st.laneAllocations.length > 0;
    const hasAllowList = Array.isArray(st.allowedLaneIds) && st.allowedLaneIds.length > 0;
    if (!hasAllocations && !hasAllowList) return false;
    return this.laneAllowedForMirror(paper);
  }

  /**
   * Auto-reset rule (operator ask): "kalau posisi open dari lane selection yang gw pilih
   * unrealized-after-slippage-nya minus dan kena close, reset semua lane selection".
   * Evaluates operator-selection closes past the watermark; a net realized loss beyond
   * laneSelectionLossResetUsd clears BOTH the weighted allocation and the allow-list.
   * Profitable (or scratch) closes only advance the watermark — the selection persists
   * (it lives server-side, so a dashboard relogin never clears it either).
   */
  private maybeAutoResetLaneSelection(): void {
    const st = this.store.getState();
    // 2026-07-08 (manual-mode ownership): in MANUAL execution mode the operator owns the
    // allocation — silently clearing it on a losing close leaves the slot mysteriously dead
    // until the operator re-picks ("directional stuck ga bisa open" class). Auto-reset stays
    // active for smart-mode selections only.
    if (st.manualSelectorMode === true) return;
    const selectionActive =
      (!!st.laneAllocations && st.laneAllocations.length > 0) ||
      (Array.isArray(st.allowedLaneIds) && st.allowedLaneIds.length > 0);
    if (!selectionActive) return;

    const watermark = st.laneSelectionLossWatermark ?? "";
    const closes = st.intents
      .filter(
        (i) =>
          i.operatorLaneSelection === true &&
          i.state === "CLOSED" &&
          i.closedAt !== null &&
          i.closedAt > watermark &&
          i.realizedPnlUsd !== null,
      )
      .sort((a, b) => (a.closedAt! < b.closedAt! ? -1 : 1));
    if (closes.length === 0) return;

    let dirty = false;
    for (const intent of closes) {
      st.laneSelectionLossWatermark = intent.closedAt;
      dirty = true;
      if ((intent.realizedPnlUsd ?? 0) <= -this.config.laneSelectionLossResetUsd) {
        st.laneAllocations = null;
        st.allowedLaneIds = null;
        st.laneSelectionLastAutoReset = {
          at: this.nowIso(),
          symbol: intent.symbol,
          pnlUsd: intent.realizedPnlUsd ?? 0,
        };
        break; // selection is gone — control returned to the bot
      }
    }
    if (dirty) this.store.save();
  }

  /** Set (and persist) the weighted lane allocation. null turns allocations off.
   *  Each entry: laneId (full or variant suffix) + weightPct in (0, 100]. Max 4 lanes. */
  /** Operator toggle: RAW selector mode (bypass smart overlays + regime direction-gate). Persisted. */
  setManualSelectorMode(enabled: boolean): { ok: true; manualSelectorMode: boolean } {
    const st = this.store.getState();
    st.manualSelectorMode = enabled === true;
    this.store.save();
    return { ok: true, manualSelectorMode: st.manualSelectorMode };
  }

  isManualSelectorMode(): boolean {
    return this.store.getState().manualSelectorMode === true;
  }

  setLaneAllocations(
    allocations: Array<{ laneId: string; weightPct: number }> | null,
  ): { ok: boolean; reason: string | null; laneAllocations: Array<{ laneId: string; weightPct: number }> | null } {
    const st = this.store.getState();
    if (allocations === null) {
      st.laneAllocations = null;
      this.store.save();
      return { ok: true, reason: null, laneAllocations: null };
    }
    if (allocations.length === 0 || allocations.length > 4) {
      return { ok: false, reason: "allocations must list 1-4 lanes (or null to turn off)", laneAllocations: st.laneAllocations };
    }
    const cleaned: Array<{ laneId: string; weightPct: number }> = [];
    const seen = new Set<string>();
    for (const a of allocations) {
      const laneId = String(a.laneId ?? "").trim();
      const weightPct = Number(a.weightPct);
      if (laneId.length === 0) return { ok: false, reason: "empty laneId", laneAllocations: st.laneAllocations };
      if (!Number.isFinite(weightPct) || weightPct <= 0 || weightPct > 100) {
        return { ok: false, reason: `weightPct for ${laneId} must be in (0, 100]`, laneAllocations: st.laneAllocations };
      }
      if (seen.has(laneId)) return { ok: false, reason: `duplicate laneId ${laneId}`, laneAllocations: st.laneAllocations };
      seen.add(laneId);
      cleaned.push({ laneId, weightPct: Math.round(weightPct) });
    }
    st.laneAllocations = cleaned;
    this.store.save();
    return { ok: true, reason: null, laneAllocations: cleaned };
  }

  /**
   * RegimeAutopilot's allocation-apply action. Identical to setLaneAllocations, but ALSO clears
   * manualSelectorMode (atomically, in the same store save) so the dashboard never keeps showing
   * "Manual" after the regime engine has genuinely changed the allocation out from under the
   * operator. Only called when RegimeAutopilot itself decides to act (its own stability/cooldown
   * guards are unchanged) — if the operator was already in smart mode, this is a no-op on the flag.
   */
  applyRegimeAutopilotAllocation(
    allocations: Array<{ laneId: string; weightPct: number }>,
  ): { ok: boolean; reason: string | null; laneAllocations: Array<{ laneId: string; weightPct: number }> | null } {
    // Operator override (2026-07-08): manual execution mode = the operator owns the allocation.
    // Belt-and-suspenders with the autopilot's own tick guard — NO autopilot-attributed apply may
    // ever overwrite a manual selection, regardless of which caller path reaches this.
    if (this.isManualSelectorMode()) {
      return {
        ok: false,
        reason: "manual selector mode aktif — operator memegang lane allocation",
        laneAllocations: this.store.getState().laneAllocations ?? null,
      };
    }
    const result = this.setLaneAllocations(allocations);
    if (result.ok) {
      const st = this.store.getState();
      st.manualSelectorMode = false;
      this.store.save();
    }
    return result;
  }

  /**
   * Operator-triggered copy of a TESTNET position onto THIS engine (the mainnet
   * instance): same symbol/direction/qty and the same stop/TP geometry relative to
   * entry (openIntent reprices the absolute levels around the actual live fill).
   * Reuses the full openIntent machinery — isolated margin, repriced protective
   * stop, TP sizing by exit rule, and the error-flatten discipline — so a copy can
   * never exist as an unprotected position. Requires the engine to be ARMED (the
   * master switch stays the master switch; the button press does not bypass it).
   */
  async copyExternalIntent(req: {
    symbol: string;
    direction: "LONG" | "SHORT";
    qty: number;
    entryPrice: number;
    stopLossPrice: number;
    tp1Price: number;
    exitRule?: VariantExitRule | null;
    sourceLaneId?: string | null;
    sourcePaperOrderId?: string | null;
    sourceEnv?: string | null;
  }): Promise<{ ok: boolean; reason: string | null; intent?: LiveIntent }> {
    if (this.store.getState().killedAt) return { ok: false, reason: "kill switch latched" };
    if (!this.armed) return { ok: false, reason: "live engine is DISARMED — arm it first, then copy" };
    if (!(req.qty > 0) || !(req.entryPrice > 0) || !(req.stopLossPrice > 0) || !(req.tp1Price > 0)) {
      return { ok: false, reason: "invalid copy spec (qty/entry/stop/tp must be positive)" };
    }
    const stopOk = req.direction === "LONG"
      ? req.stopLossPrice < req.entryPrice && req.tp1Price > req.entryPrice
      : req.stopLossPrice > req.entryPrice && req.tp1Price < req.entryPrice;
    if (!stopOk) return { ok: false, reason: "copy geometry invalid for direction (stop/tp on wrong side)" };

    const st = this.store.getState();
    const openIntents = st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state));
    if (openIntents.some((i) => i.symbol === req.symbol)) {
      return { ok: false, reason: `an intent is already open on ${req.symbol}` };
    }
    if (openIntents.length >= this.config.maxConcurrentPositions) {
      return { ok: false, reason: `max concurrent positions reached (${this.config.maxConcurrentPositions})` };
    }

    const filters = await this.getFilters(req.symbol);
    if (!filters) return { ok: false, reason: `no exchange filters for ${req.symbol}` };

    // Copy the testnet qty exactly, capped by the live notional ceiling.
    const maxQtyByNotional = this.config.maxNotionalPerTrade / req.entryPrice;
    const qty = roundDownToStep(Math.min(req.qty, maxQtyByNotional), filters.stepSize);
    if (!(qty >= filters.minQty)) {
      return { ok: false, reason: `copied quantity ${qty} below exchange minimum ${filters.minQty}` };
    }

    const copyId = `tncopy-${Date.now().toString(36)}-${req.symbol.slice(0, 6)}`;
    const exitRule: VariantExitRule = req.exitRule ?? "scaleout_tp1_trail";
    const syntheticPaper = {
      paperOrderId: copyId,
      symbol: req.symbol,
      direction: req.direction,
      entryPrice: req.entryPrice,
      stopLoss: req.stopLossPrice,
      takeProfitLevels: [req.tp1Price],
      createdAt: this.nowIso(),
      paperStatus: "CREATED",
      paperOrderMode: "HEADLINE",
      diagnosticLabel: null,
      variantExitRule: exitRule,
      fillMode: "taker",
      selectedLaneId: `TESTNET_COPY:${req.sourceLaneId ?? "MANUAL"}`,
      regime: null,
      controllerMode: null,
      controllerConfidence: null,
    } as unknown as PaperOrder;
    const plan: LiveOrderPlan = {
      ok: true,
      reason: null,
      qty,
      tp1Qty: this.isFullTpExitRule(exitRule) ? qty : roundDownToStep(qty / 2, filters.stepSize),
      notionalUsd: qty * req.entryPrice,
      stopPrice: req.stopLossPrice,
      tp1Price: req.tp1Price,
    };

    await this.openIntent([{ paper: syntheticPaper, plan }], filters);
    const intent = this.store.getState().intents.find((i) => i.paperOrderId === copyId);
    if (!intent) return { ok: false, reason: "copy did not produce an intent (plan rejected)" };
    if (intent.state === "ERROR") {
      return { ok: false, reason: intent.lastError ?? "copy open failed (flattened safely)", intent };
    }
    return { ok: true, reason: null, intent };
  }

  /** Full copy spec for an OPEN intent (the testnet side of the copy-to-live relay). */
  getOpenIntentCopySpec(paperOrderId: string): {
    ok: boolean;
    reason: string | null;
    spec?: {
      symbol: string;
      direction: "LONG" | "SHORT";
      qty: number;
      entryPrice: number;
      stopLossPrice: number;
      tp1Price: number;
      exitRule: VariantExitRule | null;
      sourceLaneId: string | null;
      sourcePaperOrderId: string;
    };
  } {
    const intent = this.store.getState().intents.find((i) => i.paperOrderId === paperOrderId);
    if (!intent) return { ok: false, reason: `no intent found for ${paperOrderId}` };
    if (intent.state !== "OPEN" && intent.state !== "TP1_FILLED_BE_SET") {
      return { ok: false, reason: `intent is ${intent.state}, only OPEN positions can be copied` };
    }
    return {
      ok: true,
      reason: null,
      spec: {
        symbol: intent.symbol,
        direction: intent.direction,
        qty: intent.qty,
        entryPrice: intent.filledEntryPrice ?? intent.plannedEntryPrice,
        stopLossPrice: intent.stopLossPrice,
        tp1Price: intent.tp1Price,
        exitRule: intent.exitRule ?? null,
        sourceLaneId: this.intentSources(intent)[0]?.laneId ?? null,
        sourcePaperOrderId: intent.paperOrderId,
      },
    };
  }

  /** Set (and persist) the operator's lane allow-list. null restores "all lanes". */
  setAllowedLanes(laneIds: string[] | null): { allowedLaneIds: string[] | null } {
    const st = this.store.getState();
    if (laneIds === null) {
      st.allowedLaneIds = null;
    } else {
      st.allowedLaneIds = Array.from(
        new Set(laneIds.map((id) => String(id).trim()).filter((id) => id.length > 0)),
      );
    }
    this.store.save();
    return { allowedLaneIds: st.allowedLaneIds };
  }

  private async mirrorNewSignals(): Promise<void> {
    if (!this.armed) return;
    const now = this.nowIso();
    const st = this.store.getState();

    // Respect the PAPER drawdown breaker too: if the strategy layer halted itself,
    // the live mirror must not keep firing its signals.
    if (this.paperStore.isAdmissionHalted(now)) return;

    const mirrored = new Set(
      st.intents
        .filter((intent) => intent.state !== "ERROR" && intent.state !== "KILLED")
        .flatMap((intent) => this.intentSources(intent).map((source) => source.paperOrderId)),
    );
    const openCount = st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state)).length;
    const openIntentsBySymbol = new Map(
      st.intents
        .filter((intent) => OPEN_INTENT_STATES.has(intent.state))
        .map((intent) => [intent.symbol, intent]),
    );

    const curationTier = (process.env.LANE_SYMBOL_CURATION_TIER as LaneSymbolCurationTier | undefined) ?? null;
    const curationCache = getLaneSymbolCurationCacheStore().get();
    const nowMs = Date.now();

    const provenOnly = this.config.mirrorProvenSymbolsOnly;
    // MIRROR FUNNEL (2026-07-08): the operator repeatedly hits "kenapa ga ada trade?" and every
    // diagnosis so far was archaeology. Record the FIRST failing gate for the newest candidates —
    // pure observation, identical conditions to the filter below, surfaced via getStatus().
    const explainDrop = (o: PaperOrder): string => {
      if (!this.config.mirrorAllPaperOrders) {
        if (o.paperOrderMode !== "HEADLINE") return "not_headline";
        if (!this.isFreshPaperOrder(o, now)) return "stale";
        if (!this.isPaperOrderLiveEligible(o, now)) return "not_live_eligible";
      }
      if (o.diagnosticLabel != null) return "diagnostic_label";
      if (!this.laneAllowedForMirror(o)) return "lane_not_allowed";
      if (!MIRRORABLE_PAPER_STATUSES.has(o.paperStatus)) return `status_${o.paperStatus}`;
      if (!this.config.mirrorAllPaperOrders && !(o.createdAt > st.lastSeenCreatedAt)) return "behind_watermark";
      if (mirrored.has(o.paperOrderId)) return "already_mirrored";
      if ((st.mirrorAttempts[o.paperOrderId] ?? 0) >= MAX_MIRROR_ATTEMPTS) return "quarantined";
      return "candidate";
    };
    this.lastMirrorFunnel = this.paperStore.all
      .slice(-8)
      .map((o) => {
        const reason = explainDrop(o);
        if (!this.mirrorFirstReason.has(o.paperOrderId) && reason !== "behind_watermark") {
          this.mirrorFirstReason.set(o.paperOrderId, reason);
        }
        return {
          id: o.paperOrderId,
          symbol: o.symbol,
          direction: o.direction,
          createdAt: o.createdAt,
          reason,
          firstReason: this.mirrorFirstReason.get(o.paperOrderId),
        };
      });
    const ranked = this.paperStore.all
      .filter(
        (o) =>
          (this.config.mirrorAllPaperOrders ||
            (o.paperOrderMode === "HEADLINE" &&
              this.isFreshPaperOrder(o, now) &&
              this.isPaperOrderLiveEligible(o, now))) &&
          o.diagnosticLabel == null &&
          this.laneAllowedForMirror(o) && // operator lane selection (applies in ALL mirror modes)
          MIRRORABLE_PAPER_STATUSES.has(o.paperStatus) &&
          (this.config.mirrorAllPaperOrders || o.createdAt > st.lastSeenCreatedAt) &&
          !mirrored.has(o.paperOrderId) &&
          (st.mirrorAttempts[o.paperOrderId] ?? 0) < MAX_MIRROR_ATTEMPTS, // quarantine repeated open failures
      )
      .map((paper) => ({
        paper,
        tier: symbolPriorityTier(
          paper.symbol,
          paper.direction,
          paper.selectedLaneId ?? "",
          curationCache.report,
          curationCache.fetchedAt,
          curationTier,
          nowMs,
        ),
        bookNetAvgR: symbolBookNetAvgR(paper.symbol, paper.direction, curationCache.report),
      }));
    // Volatility + technical-confirmation refresh (throttled — moves slowly, no need to refetch
    // every ~25s tick). Covers EVERY candidate this tick, not just whitelist ones: the size
    // multiplier below only reads whitelist entries, but the technical gate (below) applies to
    // every candidate regardless of whitelist tier — see directional-symbol-sizing.ts.
    const candidateSymbolsThisTick = [...new Set(ranked.map((r) => r.paper.symbol))];
    const whitelistSymbolsThisTick = [...new Set(ranked.filter((r) => r.tier === 0).map((r) => r.paper.symbol))];
    await this.maybeRefreshSymbolVolatility(candidateSymbolsThisTick);
    const funnelById = new Map(this.lastMirrorFunnel.map((f) => [f.id, f]));
    const latchReason = (paperOrderId: string, reason: string) => {
      this.mirrorFirstReason.set(paperOrderId, reason);
      const f = funnelById.get(paperOrderId);
      if (f) {
        f.reason = reason;
        f.firstReason = reason;
      }
    };
    if (provenOnly) {
      for (const c of ranked) {
        if (c.tier > 1) latchReason(c.paper.paperOrderId, "unproven_symbol");
      }
    }
    const candidates = ranked
      // LIVE_MIRROR_PROVEN_SYMBOLS_ONLY: operator-requested hard gate — only book-proven symbols
      // (tier 0/1) may open the directional slot; an unproven-symbol candidate is dropped rather
      // than admitted last. This is the ONE deliberate exception to "never rejects, only reorders"
      // (flag off = the default reorder-only behavior is unchanged).
      .filter((c) => !provenOnly || c.tier <= 1)
      .sort((a, b) => {
        // Priority tier first (0=curated whitelist, 1=proven-elsewhere, 2=no data), then BEST
        // measured book performance within the tier ("buka simbol dengan performa terbaik, bukan
        // sembarang buka"), then createdAt as the final FIFO tiebreaker.
        if (a.tier !== b.tier) return a.tier - b.tier;
        const perfA = a.bookNetAvgR ?? Number.NEGATIVE_INFINITY;
        const perfB = b.bookNetAvgR ?? Number.NEGATIVE_INFINITY;
        if (perfA !== perfB) return perfB - perfA;
        return a.paper.createdAt < b.paper.createdAt ? -1 : 1;
      })
      .map((c) => c.paper);

    let slots = Math.max(0, this.config.maxConcurrentPositions - openCount);
    const clusterOpen = this.clusterOpenCounts(st.intents);
    let maxSeen = st.lastSeenCreatedAt;

    // Snapshot once per tick (not per candidate): this tick's whitelist ATR% values, for the
    // relative peer comparison in directionalSymbolSizeMultiplier below.
    const atrPctBySymbol = getSymbolVolatilityCacheStore().get().atrPctBySymbol;
    const peerAtrPcts = whitelistSymbolsThisTick
      .map((s) => atrPctBySymbol[s])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);

    const grouped = new Map<string, PaperOrder[]>();
    for (const paper of candidates) {
      const key = `${paper.symbol}:${paper.direction}`;
      grouped.set(key, [...(grouped.get(key) ?? []), paper]);
    }

    for (const papers of grouped.values()) {
      const first = papers[0]!;
      for (const paper of papers) {
        if (paper.createdAt > maxSeen) maxSeen = paper.createdAt;
      }
      const oppositeIntent = openIntentsBySymbol.get(first.symbol);
      if (oppositeIntent && oppositeIntent.direction !== first.direction) {
        for (const paper of papers) latchReason(paper.paperOrderId, "opposite_intent_open");
        continue;
      }
      if (!oppositeIntent && slots <= 0) {
        for (const paper of papers) latchReason(paper.paperOrderId, "no_slots");
        continue;
      }
      // Entry-side netting guard preview (the authoritative guard lives in openIntent): surfaced
      // here so the funnel explains WHY a candidate on a basket-opposite symbol never opens.
      const groupClaim = this.externalManagedNetQty().get(first.symbol) ?? 0;
      if (groupClaim !== 0 && Math.sign(groupClaim) !== (first.direction === "LONG" ? 1 : -1)) {
        for (const paper of papers) latchReason(paper.paperOrderId, "basket_opposite_side");
        continue;
      }
      // Per-correlation-cluster cap (MAJORS exempt). A genuinely different basket gets its own slots
      // instead of sharing one flat alt cap; a single cluster still can't pile up beyond the limit.
      const clusterKey = `${clusterOf(first.symbol)}:${first.direction}`;
      if (!oppositeIntent && !isMajorSymbol(first.symbol)) {
        if ((clusterOpen.get(clusterKey)?.size ?? 0) >= this.config.maxClusterPositions) {
          for (const paper of papers) latchReason(paper.paperOrderId, "cluster_cap");
          continue;
        }
      }
      // Technical-confirmation gate (2026-07-08, operator-requested ADD-ON — whitelist above still
      // decides which symbols/priority are eligible; this additionally requires the symbol's OWN
      // fresh candles to confirm the direction right now). Fails CLOSED: missing/stale cache data
      // blocks rather than passes, since the whole point is "don't fire without confirmation."
      if (isDirectionalTechnicalGateEnabled()) {
        const signal = getSymbolVolatilityCacheStore().get().technicalBySymbol[first.symbol]?.[first.direction];
        if (!signal?.confirmed) {
          for (const paper of papers) latchReason(paper.paperOrderId, "technical_not_confirmed");
          continue;
        }
      }
      // Pyramid cap: once an intent has absorbed PYRAMID_FREE_ADD_LIMIT adds, further adds require
      // real favorable progress (maxFavorableR) — see the constant's doc comment for the real-loss
      // evidence. The ORIGINAL position is untouched; it still rides to its own stop/TP/max-hold.
      if (
        oppositeIntent &&
        oppositeIntent.direction === first.direction &&
        shouldCapPyramidAdd(oppositeIntent, PYRAMID_FREE_ADD_LIMIT, PYRAMID_MIN_FAVORABLE_R)
      ) {
        for (const paper of papers) latchReason(paper.paperOrderId, "pyramid_capped_no_progress");
        continue;
      }
      const lanePapers = oppositeIntent
        ? papers.filter((paper) => this.paperCompatibleWithIntent(oppositeIntent, paper))
        : papers.filter((paper) => this.paperGeometryKey(paper) === this.paperGeometryKey(first));
      if (lanePapers.length === 0) continue;

      const filters = await this.getFilters(first.symbol);
      if (!filters) continue;
      const planned = lanePapers.flatMap((paper) => {
        const tp1 = paper.takeProfitLevels?.[0];
        if (typeof tp1 !== "number" || !(tp1 > 0)) return [];
        const plan = computeLiveOrderPlan(
          { direction: paper.direction, entryPrice: paper.entryPrice, stopLoss: paper.stopLoss, tp1 },
          this.config,
          filters,
        );
        if (!plan.ok) return [];
        // Operator weighted allocation: scale the entry size by the lane's weight
        // (e.g. lane1 70% / lane2 30%). combinedPlan re-rounds to stepSize and a
        // too-small scaled qty fails its minQty check (skipped, not mis-sized).
        const weightPct = this.laneAllocationWeightPct(paper);
        // Per-symbol performance+volatility tilt (2026-07-08, whitelist-scoped — see
        // directional-symbol-sizing.ts). 1x outside the curated whitelist or on missing data.
        const sizeMult = directionalSymbolSizeMultiplier({
          isWhitelisted:
            symbolPriorityTier(paper.symbol, paper.direction, paper.selectedLaneId ?? "", curationCache.report, curationCache.fetchedAt, curationTier, nowMs) === 0,
          netAvgR: symbolBookNetAvgR(paper.symbol, paper.direction, curationCache.report),
          atrPct: atrPctBySymbol[paper.symbol] ?? null,
          peerAtrPcts,
        });
        const totalScale = (weightPct / 100) * sizeMult;
        const scaled =
          totalScale === 1
            ? plan
            : { ...plan, qty: plan.qty * totalScale, notionalUsd: plan.notionalUsd * totalScale };
        return [{ paper, plan: scaled }];
      });
      if (planned.length === 0) {
        for (const paper of lanePapers) latchReason(paper.paperOrderId, "plan_not_sizeable"); // e.g. BTC: $50 cap < one 0.001-step
        continue;
      }

      // Record the attempt BEFORE placing orders and persist it, so a deterministic failure (or a
      // crash mid-open) can never be retried forever — at MAX_MIRROR_ATTEMPTS the paper order is
      // quarantined out of the candidate filter above. The add path is latched too: a repeatedly
      // failing add cancels the live stop every tick, so it must quarantine exactly like an open.
      for (const { paper } of planned) {
        st.mirrorAttempts[paper.paperOrderId] = (st.mirrorAttempts[paper.paperOrderId] ?? 0) + 1;
      }
      this.store.save();
      if (oppositeIntent) {
        await this.addToIntent(oppositeIntent, planned, filters);
        for (const { paper } of planned) latchReason(paper.paperOrderId, "added_to_intent");
      } else {
        await this.openIntent(planned, filters);
        for (const { paper } of planned) latchReason(paper.paperOrderId, "opened");
        if (!isMajorSymbol(first.symbol)) {
          const set = clusterOpen.get(clusterKey) ?? new Set<string>();
          set.add(first.symbol);
          clusterOpen.set(clusterKey, set);
        }
        slots -= 1;
      }
    }

    // Drop attempt counters for paper orders that have left the store so the map stays bounded.
    let pruned = false;
    const liveIds = new Set(this.paperStore.all.map((o) => o.paperOrderId));
    for (const id of Object.keys(st.mirrorAttempts)) {
      if (!liveIds.has(id)) {
        delete st.mirrorAttempts[id];
        pruned = true;
      }
    }
    for (const id of this.mirrorFirstReason.keys()) {
      if (!liveIds.has(id)) this.mirrorFirstReason.delete(id);
    }

    if (maxSeen !== st.lastSeenCreatedAt) {
      st.lastSeenCreatedAt = maxSeen;
      this.store.save();
    } else if (pruned) {
      this.store.save();
    }
  }

  /** Best-effort, throttled ATR% refresh for the given (whitelist) symbols. No-ops without a
   *  candle-capable marketDataClient, within the throttle window, or on an empty symbol list —
   *  none of these can ever block or fail a tick (directionalSymbolSizeMultiplier falls back to
   *  1x on missing data regardless). */
  private async maybeRefreshSymbolVolatility(symbols: string[]): Promise<void> {
    if (symbols.length === 0 || !this.marketDataClient?.getCandles) return;
    const nowMs = Date.now();
    if (nowMs - this.lastVolatilityRefreshAtMs < SYMBOL_VOLATILITY_REFRESH_INTERVAL_MS) return;
    this.lastVolatilityRefreshAtMs = nowMs;
    const client = this.marketDataClient;
    try {
      await refreshSymbolVolatilityCache(
        getSymbolVolatilityCacheStore(),
        symbols,
        (symbol, interval, limit) => client.getCandles(symbol, interval, limit),
        { nowIso: this.nowIso },
      );
    } catch {
      // best-effort — a failed refresh just leaves the previous cache in place
    }
  }

  private isFreshPaperOrder(order: PaperOrder, nowIso: string): boolean {
    const createdMs = new Date(order.createdAt).getTime();
    const nowMs = new Date(nowIso).getTime();
    if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return false;
    return nowMs - createdMs <= this.config.maxPaperOrderAgeMs;
  }

  private combinedPlan(
    planned: Array<{ paper: PaperOrder; plan: LiveOrderPlan }>,
    filters: FuturesSymbolFilters,
  ): LiveOrderPlan {
    const direction = planned[0]!.paper.direction;
    const qty = roundDownToStep(planned.reduce((sum, item) => sum + item.plan.qty, 0), filters.stepSize);
    const stops = planned.map((item) => item.plan.stopPrice);
    const targets = planned.map((item) => item.plan.tp1Price);
    // Exit sizing follows the source lane's exitRule. "tp1_full" banks 100% at TP1 (no runner) —
    // required by CG_WIDE_FAST_SHORT, whose edge depends on the full 0.5R bank (a runner round-trips
    // up and loses). All other lanes keep the scaleout_tp1_trail default (50% at TP1, trail the rest).
    // When tp1Qty == qty, a TP1 fill flattens the position and manageLifecycle settles it via the
    // "position flat ⇒ closed" path (the BE/trail branch is skipped because there is no runner).
    const fullExitAtTp1 = this.isFullTpExitRule(planned[0]!.paper.variantExitRule);
    return {
      ok: qty >= filters.minQty,
      reason: qty >= filters.minQty ? null : "aggregate quantity below exchange minimum",
      qty,
      tp1Qty: fullExitAtTp1 ? qty : roundDownToStep(qty / 2, filters.stepSize),
      notionalUsd: planned.reduce((sum, item) => sum + item.plan.notionalUsd, 0),
      stopPrice: direction === "LONG" ? Math.max(...stops) : Math.min(...stops),
      tp1Price: direction === "LONG" ? Math.min(...targets) : Math.max(...targets),
    };
  }

  private paperExitRule(paper: PaperOrder): VariantExitRule {
    return paper.variantExitRule ?? "scaleout_tp1_trail";
  }

  private intentExitRule(intent: LiveIntent): VariantExitRule {
    return intent.exitRule ?? "scaleout_tp1_trail";
  }

  private isFullTpExitRule(exitRule: VariantExitRule | null | undefined): boolean {
    return exitRule === "tp1_full" || exitRule === "mfe_giveback";
  }

  private isExperimental10xPaperOrder(paper: PaperOrder): boolean {
    const laneId = paper.selectedLaneId ?? "";
    return /(^|:)CG_EXP_.*_10X$/.test(laneId);
  }

  private leverageForPlanned(planned: Array<{ paper: PaperOrder; plan: LiveOrderPlan }>): number {
    const allExperimental10x = planned.length > 0 && planned.every(({ paper }) => this.isExperimental10xPaperOrder(paper));
    return allExperimental10x
      ? boundedLeverage(this.config.maxLeverage, this.config.maxLeverage)
      : boundedLeverage(this.config.defaultLeverage, this.config.maxLeverage);
  }

  private async ensureSymbolLeverage(symbol: string, leverage: number): Promise<void> {
    const bounded = boundedLeverage(leverage, this.config.maxLeverage);
    if (this.leverageBySymbol.get(symbol) === bounded) return;
    await this.client.setLeverage(symbol, bounded);
    this.leverageBySymbol.set(symbol, bounded);
  }

  private paperGeometryKey(paper: PaperOrder): string {
    return `${paper.selectedLaneId ?? "UNKNOWN"}|${this.paperExitRule(paper)}`;
  }

  private paperCompatibleWithIntent(intent: LiveIntent, paper: PaperOrder): boolean {
    if (this.paperExitRule(paper) !== this.intentExitRule(intent)) return false;
    const laneId = paper.selectedLaneId ?? "UNKNOWN";
    const existingLaneIds = new Set(this.intentSources(intent).map((source) => source.laneId));
    return existingLaneIds.size === 0 || existingLaneIds.has(laneId);
  }

  private repricedGeometry(
    planned: Array<{ paper: PaperOrder; plan: LiveOrderPlan }>,
    fillPrice: number,
    filters: FuturesSymbolFilters,
  ): { stopPrice: number; tp1Price: number } {
    const direction = planned[0]!.paper.direction;
    const stopDistancePct = Math.min(...planned.map(({ paper, plan }) =>
      Math.abs(paper.entryPrice - plan.stopPrice) / paper.entryPrice));
    const targetDistancePct = Math.min(...planned.map(({ paper, plan }) =>
      Math.abs(plan.tp1Price - paper.entryPrice) / paper.entryPrice));
    const stop = direction === "LONG"
      ? fillPrice * (1 - stopDistancePct)
      : fillPrice * (1 + stopDistancePct);
    const target = direction === "LONG"
      ? fillPrice * (1 + targetDistancePct)
      : fillPrice * (1 - targetDistancePct);
    return {
      stopPrice: roundStopToSafeSide(direction, stop, filters.tickSize),
      tp1Price: roundDownToStep(target, filters.tickSize),
    };
  }

  private async openIntent(
    planned: Array<{ paper: PaperOrder; plan: LiveOrderPlan }>,
    filters: FuturesSymbolFilters,
  ): Promise<void> {
    const paper = planned[0]!.paper;
    const plan = this.combinedPlan(planned, filters);
    if (!plan.ok) return;
    // ENTRY-side netting guard (2026-07-08 REAL-MONEY incident: a SHORT SUI intent opened while
    // two baskets held LONG SUI — in one-way mode the "entry" order just SOLD 47.5 of the baskets'
    // longs, its reduce-only exits then -2022-rejected against the still-net-long position, and
    // reconcile disarm-looped on the books/exchange mismatch). An intent whose direction OPPOSES
    // a non-zero external claim on the same symbol can never open cleanly on a netted account —
    // skip it entirely; the mirror retries once the basket leg is gone.
    const entryExternalClaim = this.externalManagedNetQty().get(paper.symbol) ?? 0;
    const intendedSign = paper.direction === "LONG" ? 1 : -1;
    if (entryExternalClaim !== 0 && Math.sign(entryExternalClaim) !== intendedSign) {
      console.warn(
        `[live-execution-engine] skip ${paper.direction} ${paper.symbol}: cross-sectional baskets hold ` +
          `${entryExternalClaim} on the opposite side — opening would net against (consume) the basket hedge`,
      );
      return;
    }
    const st = this.store.getState();
    const now = this.nowIso();
    const intent: LiveIntent = {
      paperOrderId: paper.paperOrderId,
      symbol: paper.symbol,
      direction: paper.direction,
      state: "MIRRORED",
      qty: plan.qty,
      tp1Qty: plan.tp1Qty,
      plannedEntryPrice: paper.entryPrice,
      stopLossPrice: plan.stopPrice,
      tp1Price: plan.tp1Price,
      filledEntryPrice: null,
      entryOrderId: null,
      stopOrderId: null,
      tp1OrderId: null,
      beStopOrderId: null,
      realizedPnlUsd: null,
      feesUsd: null,
      exitRule: this.paperExitRule(paper),
      maxFavorableR: null,
      // Tagged so a losing close of an operator-selected position can auto-reset the selection.
      operatorLaneSelection: this.operatorSelectionActiveFor(paper) || undefined,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      closeReason: null,
      lastError: null,
      sourcePaperOrders: planned.map(({ paper: source, plan: sourcePlan }) => ({
        paperOrderId: source.paperOrderId,
        laneId: source.selectedLaneId ?? "UNKNOWN",
        qty: sourcePlan.qty,
        regime: source.regime ?? null,
        controllerMode: source.controllerMode ?? null,
        controllerConfidence: source.controllerConfidence ?? null,
      })),
    };
    st.intents.push(intent);
    this.store.save();

    const idTail = paper.paperOrderId.slice(-18);
    try {
      const leverage = this.leverageForPlanned(planned);
      await this.ensureSymbolLeverage(paper.symbol, leverage);
      // One-time isolated margin setup per symbol; leverage itself is lane-specific.
      if (!this.isolatedMarginSet.has(paper.symbol)) {
        try {
          await this.client.setIsolatedMargin(paper.symbol);
          this.isolatedMarginSet.add(paper.symbol);
        } catch (error) {
          // isolated is preferred, not required (fails when a position already exists)
          intent.lastError = `isolated margin not set: ${(error as Error).message}`;
        }
      }

      const entrySide = paper.direction === "LONG" ? "BUY" : "SELL";
      const exitSide = paper.direction === "LONG" ? "SELL" : "BUY";

      const entry = await this.client.placeOrder({
        symbol: paper.symbol,
        side: entrySide,
        type: "MARKET",
        quantity: plan.qty,
        newClientOrderId: `dtc-${idTail}-e`,
      });
      intent.entryOrderId = entry.orderId;
      // Confirm the REAL fill before repricing stop/TP off it — silently trusting an
      // avgPrice=0 placeOrder response would fall back to the stale pre-trade paper price,
      // exactly the "wrong side of the actual fill" condition that once churned a stop
      // placement 258× (see the comment on repricedGeometry's caller below).
      const entryResolved = await resolveConfirmedFillPrice(this.client, paper.symbol, entry.orderId, entry.avgPrice, paper.entryPrice, {
        retryDelayMs: this.fillConfirmRetryDelayMs,
        onUnconfirmed: (sym, id, fallback) =>
          console.error(
            `[live-execution-engine] UNCONFIRMED ENTRY FILL: ${sym} order ${id} never returned a real avgPrice — ` +
              `stop/TP geometry is repriced off the fallback ${fallback} (stale paper reference), not a confirmed fill.`,
          ),
      });
      intent.filledEntryPrice = entryResolved.price;
      intent.entryPriceConfirmed = entryResolved.confirmed;
      const repriced = this.repricedGeometry(planned, intent.filledEntryPrice, filters);
      intent.stopLossPrice = repriced.stopPrice;
      intent.tp1Price = repriced.tp1Price;
      intent.state = "ENTRY_PLACED";
      intent.updatedAt = this.nowIso();
      this.store.save();

      // Protect at the REPRICED stop/target (derived from the ACTUAL fill, already stored on the
      // intent above), never the stale paper-entry geometry in `plan`. When price gaps past the
      // paper stop before the MARKET fills, a stop placed at the paper price sits on the wrong
      // side of the fill and Binance rejects it -2021 "would immediately trigger" — the exact
      // failure that churned INJUSDT 258× and burned ~$865.
      const stop = await this.client.placeAlgoOrder({
        symbol: paper.symbol,
        side: exitSide,
        type: "STOP_MARKET",
        quantity: plan.qty,
        triggerPrice: intent.stopLossPrice,
        reduceOnly: true,
        workingType: "CONTRACT_PRICE", // matches the candle-walk sim (last price, not mark)
        clientAlgoId: `dtc-${idTail}-s`,
      });
      intent.stopOrderId = stop.algoId;

      if (plan.tp1Qty > 0) {
        const tp1Order = await this.client.placeOrder({
          symbol: paper.symbol,
          side: exitSide,
          type: "LIMIT",
          quantity: plan.tp1Qty,
          price: intent.tp1Price,
          reduceOnly: true,
          timeInForce: "GTC",
          newClientOrderId: `dtc-${idTail}-t`,
        });
        intent.tp1OrderId = tp1Order.orderId;
      }
      intent.state = "OPEN";
      intent.updatedAt = this.nowIso();
      this.store.save();
    } catch (error) {
      // A position without a protective stop is NOT allowed to exist: flatten immediately.
      intent.lastError = (error as Error).message ?? "open failed";
      intent.state = "ERROR";
      intent.updatedAt = this.nowIso();
      try {
        await this.client.cancelAllOrders(paper.symbol);
        await this.client.cancelAllAlgoOrders(paper.symbol);
        const positions = await this.client.getPositions(paper.symbol);
        const rawAmt = positions.find((p) => p.symbol === paper.symbol)?.positionAmt ?? 0;
        // Flatten the ENGINE SHARE only — positionAmt is netted per symbol and can include
        // cross-sectional basket legs (2026-07-07: the sibling add-failed path bought back the
        // basket's 64 WLD hedge along with the failed intent). Cap at |rawAmt| and skip entirely
        // on a sign flip (external claims own the whole net position — nothing of ours remains).
        const share = rawAmt - (this.externalManagedNetQty().get(paper.symbol) ?? 0);
        const amt = Math.sign(share) === Math.sign(rawAmt) ? Math.sign(rawAmt) * Math.min(Math.abs(share), Math.abs(rawAmt)) : 0;
        if (Math.abs(amt) > 1e-12) {
          const flat = await this.client.placeOrder({
            symbol: paper.symbol,
            side: amt > 0 ? "SELL" : "BUY",
            type: "MARKET",
            quantity: Math.abs(amt),
            reduceOnly: true,
            newClientOrderId: `dtc-${idTail}-x`,
          });
          intent.closeReason = "EMERGENCY_FLATTEN_NO_STOP";
          // A real position was opened and immediately dumped — book the realized loss so the
          // daily-loss and consecutive-loss breakers SEE the churn instead of being blind to it.
          const net = await this.realizedFromTrades(paper.symbol, intent.createdAt, [intent.entryOrderId, flat.orderId]);
          intent.realizedPnlUsd = net;
          this.applyRealizedToLedger(net, "adverse");
        }
      } catch (flattenError) {
        intent.lastError += ` | EMERGENCY FLATTEN FAILED: ${(flattenError as Error).message} — MANUAL ACTION REQUIRED`;
        this.disarm("emergency flatten failed — manual action required");
      }
      this.store.save();
      if (error instanceof BinanceFuturesPrivateError && RETRY_FATAL.has(error.failureType)) {
        throw error; // feeds the tick error-streak
      }
    }
  }

  private async addToIntent(
    intent: LiveIntent,
    planned: Array<{ paper: PaperOrder; plan: LiveOrderPlan }>,
    filters: FuturesSymbolFilters,
  ): Promise<void> {
    if (intent.state !== "OPEN") return;
    const addition = this.combinedPlan(planned, filters);
    if (!addition.ok) return;
    // Same ENTRY-side netting guard as openIntent: never add exposure whose direction opposes a
    // live basket claim on the symbol — the add would net-consume the basket's hedge.
    const addExternalClaim = this.externalManagedNetQty().get(intent.symbol) ?? 0;
    const addSign = intent.direction === "LONG" ? 1 : -1;
    if (addExternalClaim !== 0 && Math.sign(addExternalClaim) !== addSign) return;
    const idTail = planned[0]!.paper.paperOrderId.slice(-18);

    // STEP 1 — place the add entry while the EXISTING stop/TP still protect the position. If the
    // add fails (e.g. a 6s MARKET timeout), the original protection is untouched, so we skip this
    // add and let a later tick retry — never flattening a healthy (often winning) position. The old
    // ordering cancelled the stop FIRST, so an add timeout left the position naked and dumped it at
    // market (EMERGENCY_FLATTEN_ADD_FAILED — the bleed).
    let entry: FuturesOrder;
    let entryFillResolved: { price: number; confirmed: boolean };
    try {
      await this.ensureSymbolLeverage(intent.symbol, this.leverageForPlanned(planned));
      entry = await this.client.placeOrder({
        symbol: intent.symbol,
        side: intent.direction === "LONG" ? "BUY" : "SELL",
        type: "MARKET",
        quantity: addition.qty,
        newClientOrderId: `dtc-${idTail}-a`,
      });
      // Confirm the real fill NOW, while the OLD stop/TP still protect the position — not after
      // STEP 2 cancels them, where a multi-retry confirmation would needlessly widen the naked
      // window this function's own STEP 1/STEP 2 split exists to minimize.
      entryFillResolved = await resolveConfirmedFillPrice(this.client, intent.symbol, entry.orderId, entry.avgPrice, planned[0]!.paper.entryPrice, {
        retryDelayMs: this.fillConfirmRetryDelayMs,
        onUnconfirmed: (sym, id, fallback) =>
          console.error(
            `[live-execution-engine] UNCONFIRMED ADD-ENTRY FILL: ${sym} order ${id} never returned a real avgPrice — ` +
              `averaged fill price uses the fallback ${fallback} (stale paper reference), not a confirmed fill.`,
          ),
      });
    } catch (addError) {
      // Existing stop + TP are still working → the position is safe. Skip the add; do NOT flatten.
      intent.lastError = `add entry skipped — position still protected: ${(addError as Error).message}`;
      intent.updatedAt = this.nowIso();
      this.store.save();
      if (addError instanceof BinanceFuturesPrivateError && RETRY_FATAL.has(addError.failureType)) {
        throw addError; // surface to the tick error-streak; the position remains protected
      }
      return;
    }

    // STEP 2 — the add filled. Re-establish protection for the larger position. Only THIS window
    // (old stop cancelled, before the new one lands) carries naked risk → flatten if it fails.
    try {
      if (intent.stopOrderId !== null) await this.client.cancelAlgoOrder(intent.stopOrderId);
      if (intent.tp1OrderId !== null) await this.client.cancelOrder(intent.symbol, intent.tp1OrderId);
      const oldQty = intent.qty;
      const totalQty = roundDownToStep(oldQty + addition.qty, filters.stepSize);
      const oldFill = intent.filledEntryPrice ?? intent.plannedEntryPrice;
      const newFill = entryFillResolved.price;
      intent.filledEntryPrice = ((oldFill * oldQty) + (newFill * addition.qty)) / totalQty;
      // Confirmed status is monotonic-worst: one unconfirmed leg taints the whole averaged fill.
      intent.entryPriceConfirmed = (intent.entryPriceConfirmed ?? true) && entryFillResolved.confirmed;
      const repriced = this.repricedGeometry(planned, intent.filledEntryPrice, filters);
      const oldStopDistancePct = Math.abs(oldFill - intent.stopLossPrice) / oldFill;
      const oldTargetDistancePct = Math.abs(intent.tp1Price - oldFill) / oldFill;
      const newStopDistancePct = Math.abs(intent.filledEntryPrice - repriced.stopPrice) / intent.filledEntryPrice;
      const newTargetDistancePct = Math.abs(repriced.tp1Price - intent.filledEntryPrice) / intent.filledEntryPrice;
      const stopDistancePct = Math.min(oldStopDistancePct, newStopDistancePct);
      const targetDistancePct = Math.min(oldTargetDistancePct, newTargetDistancePct);
      intent.qty = totalQty;
      intent.tp1Qty = this.isFullTpExitRule(this.intentExitRule(intent))
        ? totalQty
        : roundDownToStep(totalQty / 2, filters.stepSize);
      intent.stopLossPrice = roundStopToSafeSide(
        intent.direction,
        intent.filledEntryPrice * (intent.direction === "LONG" ? 1 - stopDistancePct : 1 + stopDistancePct),
        filters.tickSize,
      );
      intent.tp1Price = intent.direction === "LONG"
        ? roundDownToStep(intent.filledEntryPrice * (1 + targetDistancePct), filters.tickSize)
        : roundDownToStep(intent.filledEntryPrice * (1 - targetDistancePct), filters.tickSize);
      intent.sourcePaperOrders = [
        ...this.intentSources(intent),
        ...planned.map(({ paper, plan }) => ({
          paperOrderId: paper.paperOrderId,
          laneId: paper.selectedLaneId ?? "UNKNOWN",
          qty: plan.qty,
          regime: paper.regime ?? null,
          controllerMode: paper.controllerMode ?? null,
          controllerConfidence: paper.controllerConfidence ?? null,
        })),
      ];

      const exitSide = intent.direction === "LONG" ? "SELL" : "BUY";
      const stop = await this.client.placeAlgoOrder({
        symbol: intent.symbol,
        side: exitSide,
        type: "STOP_MARKET",
        quantity: totalQty,
        triggerPrice: intent.stopLossPrice,
        reduceOnly: true,
        workingType: "CONTRACT_PRICE",
        clientAlgoId: `dtc-${idTail}-as`,
      });
      intent.stopOrderId = stop.algoId;
      const tp = await this.client.placeOrder({
        symbol: intent.symbol,
        side: exitSide,
        type: "LIMIT",
        quantity: intent.tp1Qty,
        price: intent.tp1Price,
        reduceOnly: true,
        timeInForce: "GTC",
        newClientOrderId: `dtc-${idTail}-at`,
      });
      intent.tp1OrderId = tp.orderId;
      intent.updatedAt = this.nowIso();
      this.store.save();
    } catch (error) {
      // The protective stop + TP were cancelled at the top of this method, so the EXISTING position
      // is now NAKED. A position without a working stop must never persist: flatten it, book the
      // loss so the breakers see it, and mark the intent ERROR. Leaving it OPEN would also re-fire
      // addToIntent next tick and re-cancel a fresh stop — the churn class, but on a real position.
      intent.lastError = `aggregate add failed: ${(error as Error).message}`;
      intent.state = "ERROR";
      intent.updatedAt = this.nowIso();
      try {
        await this.client.cancelAllOrders(intent.symbol);
        await this.client.cancelAllAlgoOrders(intent.symbol);
        const positions = await this.client.getPositions(intent.symbol);
        const rawAmt = positions.find((p) => p.symbol === intent.symbol)?.positionAmt ?? 0;
        // ENGINE SHARE only (2026-07-07 REAL-MONEY incident: this exact flatten bought back the
        // whole netted −193 WLD — the failed intent's 129 PLUS the basket's 64 hedge — leaving
        // basket xb-mrapun17 unhedged). See the sibling comment in openIntent's catch.
        const share = rawAmt - (this.externalManagedNetQty().get(intent.symbol) ?? 0);
        const amt = Math.sign(share) === Math.sign(rawAmt) ? Math.sign(rawAmt) * Math.min(Math.abs(share), Math.abs(rawAmt)) : 0;
        if (Math.abs(amt) > 1e-12) {
          const flat = await this.client.placeOrder({
            symbol: intent.symbol,
            side: amt > 0 ? "SELL" : "BUY",
            type: "MARKET",
            quantity: Math.abs(amt),
            reduceOnly: true,
            newClientOrderId: `dtc-${idTail}-ax`,
          });
          intent.closeReason = "EMERGENCY_FLATTEN_ADD_FAILED";
          const net = await this.realizedFromTrades(intent.symbol, intent.createdAt, [intent.entryOrderId, flat.orderId]);
          intent.realizedPnlUsd = net;
          this.applyRealizedToLedger(net, "adverse");
        }
      } catch (flattenError) {
        intent.lastError += ` | EMERGENCY FLATTEN FAILED: ${(flattenError as Error).message} — MANUAL ACTION REQUIRED`;
        this.disarm("emergency flatten failed (add path) — manual action required");
      }
      this.store.save();
      if (error instanceof BinanceFuturesPrivateError && RETRY_FATAL.has(error.failureType)) {
        throw error; // feed the tick error-streak
      }
    }
  }

  private paperOrderById(): Map<string, PaperOrder> {
    return new Map(this.paperStore.all.map((order) => [order.paperOrderId, order]));
  }

  private enrichIntentSource(source: LiveIntentSource, paper: PaperOrder | undefined): LiveIntentSource {
    return {
      ...source,
      laneId: source.laneId || paper?.selectedLaneId || "UNKNOWN",
      regime: source.regime ?? paper?.regime ?? null,
      controllerMode: source.controllerMode ?? paper?.controllerMode ?? null,
      controllerConfidence: source.controllerConfidence ?? paper?.controllerConfidence ?? null,
    };
  }

  private intentSources(intent: LiveIntent, paperById = this.paperOrderById()): LiveIntentSource[] {
    if (intent.sourcePaperOrders && intent.sourcePaperOrders.length > 0) {
      return intent.sourcePaperOrders.map((source) => this.enrichIntentSource(source, paperById.get(source.paperOrderId)));
    }
    const paper = paperById.get(intent.paperOrderId);
    return [this.enrichIntentSource({
      paperOrderId: intent.paperOrderId,
      laneId: paper?.selectedLaneId ?? "UNKNOWN",
      qty: intent.qty,
    }, paper)];
  }

  private async getFilters(symbol: string): Promise<FuturesSymbolFilters | null> {
    if (!this.filtersCache) {
      this.filtersCache = await this.client.getExchangeFilters();
    }
    return this.filtersCache.get(symbol) ?? null;
  }
}

const RETRY_FATAL: ReadonlySet<string> = new Set(["timeout", "429", "network", "clock_skew"]);

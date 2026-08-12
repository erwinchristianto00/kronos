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
  type FuturesIncomeEntry,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
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
import type { CortexRealAttributionStore } from "./cortex-real-attribution.js";
import { fillFromUserTrade, type ExecutionFill, type ExecutionFillRecorder, type ExecutionFillRole } from "./execution-fill-recorder.js";
import type { PositionPathRecorder } from "./position-path-recorder.js";
import type { BinanceClient } from "./binance.js";
import type { PaperOrder } from "./paper-execution-router.js";
import type { ExecutiveReviewExecutionLink, ExecutiveReviewStore } from "./executive-review-store.js";
import { resolveExecutiveReviewPositions } from "./executive-review-runtime.js";
import { recordExecLifecycle } from "./lane-context-journal-runtime.js";
import type { LifecycleEvent } from "./execution-lifecycle-log.js";
import { isProfitCoreShortLaneId } from "./realtime-short-mirror.js";
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
  isDirectionalTechnicalSignalFresh,
  type SymbolVolatilityCacheStore,
} from "./directional-symbol-sizing.js";
import { isTestnetCrossSectionalHorizonLaneAllowed } from "./live-executor-wiring.js";

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
  /** Hard aggregate stop-risk ceiling for one intent after all pyramid adds. */
  maxAggregateIntentRiskUsd: number;
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
   * 2026-07-19 real-money audit follow-up (time-window bound on the consecutive-loss streak):
   * once recordExternalConsecutiveLossOutcome() wired ALL 9 SingleSymbolLaneExecutor instances
   * (RC/RCS/CE-x4/SF/IM/PWR) into this counter — not just the previously-sole, permanently
   * 0%-weight legacy CG_*-variant-matrix feeder — maxConsecutiveLosses stopped being dormant and
   * started being fed continuously by the lanes that actually hold real money. But the counter was
   * (and, before this field, always had been) UNBOUNDED IN TIME: a loss 3 days ago and a loss today,
   * on two independently-ticking lanes with no real correlation, chained into the same "streak" and
   * could trip the account-wide force-flatten kill-switch for ordinary multi-day trading variance,
   * not a genuine correlated failure (broken strategy/data feed/bug).
   *
   * This bounds how long a loss stays "chainable": if the gap since the last COUNTED loss exceeds
   * this many hours, the next loss starts a FRESH streak (count=1) instead of incrementing the old
   * one — see noteConsecutiveLoss()'s doc comment. Default 24h chosen from this account's real
   * cadence: RC/CE-Wide/CE-Fast combined have historically closed roughly 1-2 trades/day across all
   * 3 lanes, so consecutive closes on an ordinary trading day are commonly 6-24h apart even when
   * they land in different lanes — a 24h window still lets a same-day cluster of losses (the actual
   * correlated-failure signature: several losses close together in time) chain and trip the breaker
   * exactly as before, while a loss 3 days apart from the last one (this account's reported false-trip
   * scenario) now starts fresh instead of chaining. A shorter window (1-2h) would defeat the entire
   * point of counting a streak across a normal multi-lane trading day (real closes routinely land
   * hours apart); a much longer one (1 week) barely changes today's broken unbounded behavior.
   * Configurable via LIVE_CONSECUTIVE_LOSS_WINDOW_HOURS for an operator to retune as real cadence
   * data accumulates.
   */
  consecutiveLossWindowHours: number;
  /** Testnet-only opt-out for account-wide automatic breaker trips. Manual kill, stops,
   * reconciliation, and exchange-error safety remain active. */
  autoKillSwitchEnabled: boolean;
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
  /** Testnet-only rollout lock: no non-cross-sectional lane may create a new mirror/copy. */
  testnetOnlyCrossSectionalHorizon: boolean;
  /**
   * Testnet-only collector policy. Interleaves fresh sources by their
   * lane × direction × entry-regime exposure and never pyramids a source from
   * a different entry regime into an existing intent. It is observational
   * collection hygiene, not a mainnet lane-selection policy.
   */
  testnetStratifiedCollection: boolean;
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
  /** 2026-07-12 (profitability Stage 4): profit-bank MODE, opt-in via LIVE_PROFIT_BANK_MODE.
   *  "FLAT" (default) = the historical flat profitBankNetTargetUsd $ threshold for every position —
   *  unchanged live behavior. "R_BASED" = scale the bank target to profitBankTargetR × the
   *  position's OWN effective risk-at-stop (the REAL per-trade R, not the nominal config that the
   *  $50 notional cap silently clips — see effectiveRiskUsd), so a wider-stop/bigger-risk position
   *  is allowed to run proportionally further before banking, addressing the flat-$1 bank
   *  truncating the right tail the loss-asymmetry needs. Never changes anything unless explicitly
   *  set to R_BASED. */
  profitBankMode: "FLAT" | "R_BASED";
  /** R-multiple used when profitBankMode === "R_BASED" (LIVE_PROFIT_BANK_TARGET_R). Default 1.0. */
  profitBankTargetR: number;
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
  /**
   * 2026-07-19 real-money audit fix (BUG 4, HIGH): opt-in aggregate cap for setManualDirectionalLaneAllocations
   * (LIVE_MAX_AGGREGATE_MANUAL_DIRECTIONAL_NOTIONAL_USD). Each lane in the long/short allocation list
   * independently sizes to its OWN full maxNotionalPerTrade at weightPct:100 — nothing previously
   * normalized or capped the SUM across lanes on the same side, so e.g. 3 LONG lanes each at 100%
   * could each deploy their own full size simultaneously if signals fire together (observed live:
   * exactly this 3-lanes-at-100 configuration). 0 (default) = disabled, matching the historical
   * always-allowed behavior — combinedWorstCaseNotionalUsd() is still computed and surfaced via
   * setManualDirectionalLaneAllocations()'s return value and getStatus() regardless of whether this
   * cap is set, so the real aggregate figure is never silently hidden even when not enforced.
   */
  maxAggregateManualDirectionalNotionalUsd: number;
  /** Why the config cannot trade (empty = config valid for its env). */
  configErrors: string[];
}

export interface LiveControllerSnapshot {
  regime: string | null;
  mode: string | null;
  bias?: string | null;
  confidence?: string | null;
  /** Graduated-confidence telemetry (2026-07-12). convictionScore 0..1; gradedConfidence is the
   *  un-floored tier (may be LOW where `confidence` is floored to MEDIUM). Shadow/telemetry only. */
  convictionScore?: number | null;
  gradedConfidence?: string | null;
  estimatedRegime?: LaneSelectorV2EstimatedRegime | null;
  reasons?: string[];
  capturedAt?: string | null;
}

function envNum(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_STORED_INTENTS = envNum(process.env.LIVE_MAX_STORED_INTENTS, 2000);

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
  const riskUsdPerTrade = envNum(env.LIVE_RISK_USD_PER_TRADE, 5);
  const defaultLeverage = boundedLeverage(
    envNum(env.LIVE_DEFAULT_LEVERAGE, Math.min(3, maxLeverage)),
    maxLeverage,
  );

  return {
    enabled,
    env: liveEnv,
    apiKey,
    apiSecret,
    riskUsdPerTrade,
    maxConcurrentPositions: Math.floor(envNum(env.LIVE_MAX_CONCURRENT_POSITIONS, 3)),
    maxCorrelatedAltLongPositions: envNonNegativeInt(env.LIVE_MAX_CORRELATED_ALT_LONGS, 3),
    maxCorrelatedAltShortPositions: envNonNegativeInt(env.LIVE_MAX_CORRELATED_ALT_SHORTS, 3),
    maxAggregateIntentRiskUsd: envNum(env.LIVE_MAX_AGGREGATE_INTENT_RISK_USD, riskUsdPerTrade),
    maxClusterPositions: envNonNegativeInt(env.LIVE_MAX_CLUSTER_POSITIONS, 3),
    dailyMaxLossUsd: envNum(env.LIVE_DAILY_MAX_LOSS_USD, 15),
    maxConsecutiveLosses: Math.floor(envNum(env.LIVE_MAX_CONSECUTIVE_LOSSES, 5)),
    consecutiveLossWindowHours: envNum(env.LIVE_CONSECUTIVE_LOSS_WINDOW_HOURS, 24),
    autoKillSwitchEnabled: liveEnv !== "testnet" || env.LIVE_TESTNET_AUTO_KILL_SWITCH !== "0",
    scratchEpsilonUsd: envNum(env.LIVE_SCRATCH_EPSILON_USD, Math.max(0.05, 0.02 * envNum(env.LIVE_RISK_USD_PER_TRADE, 5))),
    maxDrawdownUsd: envNum(env.LIVE_MAX_DRAWDOWN_USD, 40),
    defaultLeverage,
    maxLeverage,
    maxNotionalPerTrade: envNum(env.LIVE_MAX_NOTIONAL_PER_TRADE, 250),
    maxPaperOrderAgeMs: Math.floor(envNum(env.LIVE_MAX_PAPER_ORDER_AGE_MS, 10 * 60 * 1000)),
    mirrorAllPaperOrders: env.LIVE_MIRROR_ALL_PAPER === "1" && liveEnv === "testnet",
    testnetOnlyCrossSectionalHorizon:
      liveEnv === "testnet" && env.TESTNET_ONLY_CROSS_SECTIONAL_HORIZON === "1",
    testnetStratifiedCollection:
      env.LIVE_TESTNET_STRATIFIED_COLLECTION === "1" && liveEnv === "testnet",
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
    profitBankMode: env.LIVE_PROFIT_BANK_MODE === "R_BASED" ? "R_BASED" : "FLAT",
    profitBankTargetR: Math.max(0, Number.parseFloat(env.LIVE_PROFIT_BANK_TARGET_R ?? "") || 1),
    regimeLossHardCutStopFraction: envFraction(env.LIVE_REGIME_LOSS_HARD_CUT_STOP_FRACTION, 0.5),
    forceMfeGiveback: env.LIVE_FORCE_MFE_GIVEBACK === "1",
    losingMaxHoldMs: Math.max(0, Math.floor(envNum(env.LIVE_LOSING_MAX_HOLD_MS, 0))),
    laneSelectionLossResetUsd: envNum(env.LIVE_LANE_SELECTION_LOSS_RESET_USD, 0.25),
    rescue: parseRegimeFlipRescueConfig(env, liveEnv),
    rescueExecute:
      env.LIVE_TESTNET_RESCUE_ENABLED === "1" &&
      env.LIVE_TESTNET_RESCUE_MODE === "live" &&
      liveEnv === "testnet",
    // 0 = disabled (default, matches historical always-allowed behavior — see the field's own doc
    // comment on LiveExecutionConfig for the real-money gap this closes).
    maxAggregateManualDirectionalNotionalUsd: envNonNegativeInt(env.LIVE_MAX_AGGREGATE_MANUAL_DIRECTIONAL_NOTIONAL_USD, 0),
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
  /** Requested risk budget after any lane/allocation scaling. Report-only. */
  plannedRiskUsd: number;
  /** Notional needed to deploy plannedRiskUsd at this stop distance, before the cap/rounding. */
  requiredNotionalUsd: number;
  /** Notional that survives the cap and exchange quantity rounding. Mirrors notionalUsd. */
  appliedNotionalUsd: number;
  /** Effective per-plan notional ceiling after lane/allocation scaling. */
  notionalCapUsd: number;
  /** Absolute entry-to-stop distance as a fraction of entry. null when geometry is invalid. */
  stopDistancePct: number | null;
  stopPrice: number;
  tp1Price: number;
  /** 2026-07-12 R-clipping telemetry: the dollars ACTUALLY at risk between entry and stop for this
   *  plan (notional × stop distance). The nominal riskUsdPerTrade config is a target, not a
   *  guarantee — whenever riskUsd/stopDistance exceeds maxNotionalPerTrade, the notional cap binds
   *  and the true R shrinks silently (measured live 2026-07-12: nominal $5 R clipped to ~$1.50 at
   *  the dominant ~300bps stop under the $50 cap). Report-only: nothing reads this for decisions;
   *  it exists so the operator's scaling arithmetic uses the REAL per-trade R, not the config's. */
  effectiveRiskUsd: number;
  /** True when maxNotionalPerTrade (not riskUsdPerTrade) determined this plan's size. */
  riskClippedByNotionalCap: boolean;
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
  const fail = (reason: string): LiveOrderPlan => ({
    ok: false,
    reason,
    qty: 0,
    tp1Qty: 0,
    notionalUsd: 0,
    plannedRiskUsd: config.riskUsdPerTrade,
    requiredNotionalUsd: 0,
    appliedNotionalUsd: 0,
    notionalCapUsd: config.maxNotionalPerTrade,
    stopDistancePct: null,
    stopPrice: 0,
    tp1Price: 0,
    effectiveRiskUsd: 0,
    riskClippedByNotionalCap: false,
  });

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
  const finalNotionalUsd = qty * entryPrice;
  return {
    ok: true,
    reason: null,
    qty,
    tp1Qty, // 0 ⇒ position too small to split; runner-only (stop still protects full qty)
    notionalUsd: finalNotionalUsd,
    plannedRiskUsd: config.riskUsdPerTrade,
    requiredNotionalUsd: rawNotional,
    appliedNotionalUsd: finalNotionalUsd,
    notionalCapUsd: config.maxNotionalPerTrade,
    stopDistancePct,
    stopPrice: roundDownToStep(stopLoss, filters.tickSize),
    tp1Price: roundDownToStep(tp1, filters.tickSize),
    effectiveRiskUsd: finalNotionalUsd * stopDistancePct,
    riskClippedByNotionalCap: rawNotional > config.maxNotionalPerTrade,
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

/**
 * What realizedFromTrades() actually established, including the PROVENANCE of `feesUsd`.
 *
 * `feesUsd: 0` is ambiguous on its own — it is what you get from a genuinely fee-free settlement,
 * from the `ids.size === 0` short-circuit (no order ids, exchange never queried), and from a query
 * that returned rows but matched none of ours. `feeSource` disambiguates:
 *   "EXCHANGE" — at least one real /userTrades commission row of ours was summed into feesUsd.
 *   null       — no commission row was ever seen. feesUsd is a structural zero, not a measurement.
 */
interface SettledFromTrades {
  netUsd: number;
  feesUsd: number;
  feeSource: "EXCHANGE" | null;
  settlementFetchComplete: boolean;
  requiredOrderIds: string[];
  matchedRequiredOrderIds: string[];
  missingRequiredOrderIds: string[];
  pageSaturated: boolean;
  /** Real exchange fill rows for the ORIGINAL entry order only (trade.orderId === the singular
   *  intent.entryOrderId, never the entryOrderIds array, which also absorbs pyramid adds) — see
   *  realizedFromTrades' own doc note. Always an array, never undefined: empty is the honest "no
   *  confirmed entry-side trade rows were matched" result, not "unknown". */
  entryFills: ExecutionFill[];
}

export interface LiveIntent {
  paperOrderId: string;
  /** Exact immutable execution identity. Present only on intents created after Executive Review wiring. */
  executionIntentId?: string;
  /** Exact persisted position identity. It is never inferred from symbol, side, price, or time window. */
  positionId?: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  state: LiveIntentState;
  qty: number;
  tp1Qty: number;
  plannedEntryPrice: number;
  stopLossPrice: number;
  tp1Price: number;
  filledEntryPrice: number | null;
  entryOrderId: string | null;
  /** Every exchange entry order absorbed into this intent, including pyramid adds. */
  entryOrderIds?: string[];
  stopOrderId: string | null;
  tp1OrderId: string | null;
  beStopOrderId: string | null;
  realizedPnlUsd: number | null;
  feesUsd: number | null;
  /** PROVENANCE of feesUsd (2026-07-26, purely additive, report-only — nothing reads it to make a
   *  decision). The single-symbol and cross-sectional executors already carry this field
   *  (SingleSymbolPosition.feeSource / ExecutorBasket.feeSource); this engine — the path behind 182
   *  closed intents — had NO way at all to tell a measured commission from an absent one, because
   *  every settle path collapses to `intent.feesUsd = settled?.feesUsd ?? null` and a settlement
   *  that queried the exchange and matched nothing returns feesUsd: 0, identical to a real $0.
   *
   *    "EXCHANGE"             — summed from at least one real /userTrades commission row for this
   *                             intent's own order ids (see SettledFromTrades.feeSource).
   *    "EXCHANGE_APPORTIONED" — the rescue-FLIP path only. ONE real exchange fee total, split
   *                             across the N opposing intents that flip closed, pro-rata by qty.
   *                             The total is measured; THIS ROW'S SLICE IS MODELLED. Deliberately
   *                             not labelled "EXCHANGE" — a cost study that treats an apportioned
   *                             slice as an observation of this intent is wrong in exactly the way
   *                             this whole field exists to prevent.
   *    undefined              — UNKNOWN. Intent closed before this field existed, never closed, the
   *                             settlement fetch failed (feesUsd null), or the settlement matched
   *                             no trade rows at all. NEVER assume exchange-true.
   *
   *  CAVEAT (same as the executors'): "EXCHANGE" documents the METHOD, not completeness. The sum is
   *  taken over one 1000-row getUserTrades page; an intent whose rows were pushed off that page by
   *  unrelated activity still labels EXCHANGE while under-counting. */
  feeSource?: "EXCHANGE" | "EXCHANGE_APPORTIONED";
  /** Exact order-id coverage for the exchange settlement that produced fees/PnL. */
  settlementFetchComplete?: boolean;
  requiredOrderIds?: string[];
  matchedRequiredOrderIds?: string[];
  missingRequiredOrderIds?: string[];
  pageSaturated?: boolean;
  /** Immutable initial execution risk. Missing values remain diagnostic-only evidence. */
  originalRiskUsd?: number;
  /** 2026-07-30 (additive, report-only): the exact moment the entry MARKET order's fill was
   *  confirmed (see resolveConfirmedFillPrice's caller) — distinct from `createdAt` (intent
   *  creation) and never a fallback to it. Undefined on intents created before this field existed,
   *  or on synthetic (rescue) intents that never go through the confirmed-fill path. */
  entryFilledAt?: string;
  /** 2026-07-30 (additive, report-only): the exact moment `applySettlementMetadata` last observed
   *  `settlementFetchComplete === true` — distinct from `closedAt` (market close) and from any
   *  earlier call that left settlement incomplete. Undefined until settlement is genuinely
   *  established complete at least once. */
  settlementResolvedAt?: string;
  /** 2026-07-30 (additive, report-only). Real /userTrades rows for the ORIGINAL entry order ONLY —
   *  matched by the singular entryOrderId, never the entryOrderIds array (which also absorbs pyramid
   *  adds; see that field's own doc note). Populated exclusively from exchange fill/trade records
   *  that report their own executedQty (ExecutionFill.qty) — never inferred from order
   *  acknowledgment, never merely because entryPriceConfirmed is true. Undefined on intents settled
   *  before this field existed; `[]` is the honest "settlement ran but matched no entry-side rows"
   *  result, distinct from "never settled". */
  confirmedEntryFills?: ExecutionFill[];
  exitRule?: VariantExitRule;
  maxFavorableR?: number | null;
  /** MAE persistence (Tier 2 audit, purely additive): running MOST NEGATIVE (worst) favorableR the
   *  position has reached, mirroring maxFavorableR's own update (same tick hook inside
   *  manageMfeGiveback(), same intents tracked). 0 while the position has never gone underwater;
   *  null on intents that never pass through that hook (rescue legs — same as maxFavorableR).
   *  Report-only: never read by any exit/close decision. */
  maxAdverseR?: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  lastError: string | null;
  /** Exit-side regime snapshot (Tier 2 audit, purely additive): the SAME three controller fields
   *  captured at entry (see LiveIntentSource.regime/controllerMode/controllerConfidence) but read
   *  LIVE at the moment of close via currentControllerSnapshot() — the same mechanism the regime
   *  harvest already uses. Lets a closed trade be compared entry-regime vs exit-regime. null when
   *  no controller snapshot was available at close time; undefined on intents that never closed. */
  exitRegime?: string | null;
  exitControllerMode?: string | null;
  exitControllerConfidence?: string | null;
  /** 2026-07-26 regime-opposition breakeven deferral (see OPPOSITION_BREAKEVEN_DEFER_MS): the first
   *  tick at which this intent WOULD have been harvested as REGIME_OPPOSITION_BREAKEVEN_* — green,
   *  counter-regime, no controller flip. The harvest then leaves it on its own stop/TP until
   *  OPPOSITION_BREAKEVEN_DEFER_MS has elapsed from this stamp. Deliberately never cleared once
   *  set: a position that dips red and comes back green keeps its ORIGINAL anchor, so the backstop
   *  measures total time-since-first-eligible rather than restarting on every wobble (strictly the
   *  more conservative reading, and it cannot be gamed by oscillation). Undefined on intents that
   *  were never eligible and on those persisted before this field existed. */
  oppositionBreakevenDeferredAt?: string | null;
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
  /** 2026-07-12 R-clipping telemetry (report-only, see LiveOrderPlan.effectiveRiskUsd): the dollars
   *  actually at risk to the stop at entry, and whether the notional cap (not riskUsdPerTrade)
   *  determined the size. Undefined on older persisted intents. */
  effectiveRiskUsd?: number | null;
  riskClippedByNotionalCap?: boolean;
  /** Full sizing provenance captured at entry. Optional on pre-telemetry persisted intents. */
  plannedRiskUsd?: number | null;
  requiredNotionalUsd?: number | null;
  appliedNotionalUsd?: number | null;
  notionalCapUsd?: number | null;
  stopDistancePct?: number | null;
  /** Durable idempotency identity for a testnet→live copy. A repeated signed request returns this
   * intent instead of opening a second real position, including after a process restart. */
  externalCopyIdempotencyKey?: string;
  /** CORTEX real-USDT attribution capture (2026-07-21, report-only — see cortex-real-attribution.ts):
   *  the lane weight the mirror sizing path ACTUALLY applied to this intent's entry (includes any
   *  active CORTEX promoted tilt) and the operator's untouched static table weight for the same
   *  lane, both frozen AT OPEN time. Pyramid adds deliberately inherit these open-time values —
   *  the whole intent's realized P&L is attributed at the open-time tilt share (documented choice;
   *  the tilt moves slowly relative to an intent's add window). Undefined on intents persisted
   *  before this feature and on non-mirror opens (operator testnet→live copy), which are therefore
   *  never attributed. */
  cortexAppliedWeightPct?: number;
  cortexRawStaticWeightPct?: number;
  /** 2026-07-21 review fix: durable per-intent dedup marker set by sweepCortexRealAttribution the
   *  moment this intent's close is booked. Persisted with the intent and dies with it, so the
   *  attribution store's bounded id-FIFO can never be the only thing standing between a re-offered
   *  terminal intent and a double-booking (FIFO eviction, LIVE_MAX_STORED_INTENTS raised above the
   *  FIFO cap, or a lost/corrupt attribution file are all covered by this flag). */
  cortexAttributed?: boolean;
  /** Optional immutable review lineage. Its absence never blocks incumbent execution. */
  executiveReviewLink?: ExecutiveReviewExecutionLink;
}

export interface LiveIntentSource {
  paperOrderId: string;
  laneId: string;
  qty: number;
  /** Stable upstream observation identity used only for causal attribution. */
  sourceObservationId?: string | null;
  regime?: string | null;
  controllerMode?: string | null;
  controllerConfidence?: string | null;
  executiveReviewLink?: ExecutiveReviewExecutionLink;
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
  /** Wall-clock (ms since epoch) of the most recently COUNTED loss in the consecutiveLosses streak
   *  above — null if the streak is currently 0 (never started, or last reset by a win/resetKill()).
   *  Read by noteConsecutiveLoss() to decide whether the NEXT loss chains onto this streak (gap <=
   *  config.consecutiveLossWindowHours) or starts a fresh one (gap exceeds it). See
   *  consecutiveLossWindowHours's doc comment on LiveExecutionConfig for the incident this bounds.
   *  Optional/undefined on state persisted before this field existed — _parse()'s `{...this._empty(),
   *  ...parsed}` merge seeds it to null (the safe "no prior counted loss" default) on first load. */
  lastLossAtMs: number | null;
  totalRealizedPnlUsd: number;
  /** Peak of totalRealizedPnlUsd — drawdown kill-switch baseline. */
  realizedPeakUsd: number;
  /** Peak of (totalRealizedPnlUsd + external executors' all-time real P&L) — the drawdown
   *  kill-switch baseline once getExternalRealizedPnlUsd is wired (2026-07-11 fix; see
   *  killSwitchTrip's doc comment). Optional/undefined on state loaded before this field existed —
   *  first read after the fix seeds it from max(realizedPeakUsd, current combined total), an
   *  honest approximation since no historical combined-total peak was ever tracked before now. */
  combinedRealizedPeakUsd?: number;
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
  /**
   * 2026-07-19 real-money audit fix (BUG 1, HIGH): paperOrderIds of intents whose kill-switch
   * flatten attempt THREW (a transient Binance/network error) and are therefore still open on the
   * exchange right now — indistinguishable, before this field existed, from either "successfully
   * flattened" or "kill-switch never engaged" anywhere in getStatus()/reconcile()/the kill route.
   * Populated by engageKillSwitch()'s per-intent loop on failure, cleared on a successful retry.
   * killSwitchTrip() never re-fires once st.killedAt is latched (see its own doc comment), so
   * retryFailedKillFlattens() — called every tick once killedAt is set — is the ONLY path that
   * revisits these until the flatten actually succeeds. Persisted so a restart doesn't lose track
   * of a still-exposed position. */
  killSwitchFlattenFailedIntentIds: string[];
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
  /** Operator allocations used only by manual mode, selected from the latest Entry Decision bias. */
  manualDirectionalAllocations: {
    long: Array<{ laneId: string; weightPct: number }>;
    short: Array<{ laneId: string; weightPct: number }>;
  } | null;
  /**
   * Lane-allocation operator lock (2026-07-09 fix, take 2). Distinct from manualSelectorMode above
   * — that field is the RAW BYPASS toggle (scan.ts admission overlays) and is exposed via the
   * dashboard's "Switch to MANUAL (bypass)" button. This field is set ONLY by
   * setLaneAllocationsAsOperator() when the operator explicitly applies a lane allocation via
   * POST /api/live/lane-allocations, and checked by RegimeAutopilot.tick() /
   * applyRegimeAutopilotAllocation() / maybeAutoResetLaneSelection() before any of them may touch
   * laneAllocations.
   *
   * Real incident: the first fix attempt (same day) reused manualSelectorMode for this lock. The
   * operator toggled the RAW BYPASS button for its own unrelated purpose, which — because both
   * concepts shared one flag — silently released the lock too, letting the next autopilot tick
   * revert a manually-set 80/8/8/4 allocation back to the NO_TRADE preset (100%
   * CROSS_SECTIONAL_MARKET_NEUTRAL) within minutes. Two independent concerns must never share one
   * boolean again.
   */
  laneAllocationOperatorLock: boolean;
  /** Watermark (closedAt ISO) of operator-selection closes already evaluated by the
   *  auto-reset rule, so a historical loss can never re-trigger a reset later. */
  laneSelectionLossWatermark: string | null;
  /** Last automatic selection reset (a losing operator-selected close returned control
   *  to the bot). Display-only provenance. */
  laneSelectionLastAutoReset: { at: string; symbol: string; pnlUsd: number } | null;
  /** Operator drain mode: blocks every NEW entry while lifecycle/reconcile/exit work keeps running. */
  newEntriesPaused: boolean;
  newEntriesPausedAt: string | null;
  newEntriesPauseReason: string | null;
}

export interface LiveNewEntryGateDecision {
  allowed: boolean;
  reason: string | null;
}

export interface ManualEntryDecisionSnapshot {
  action: "NO_TRADE" | "WAIT_PULLBACK" | "WAIT_REJECTION";
  directionalBias: "LONG" | "SHORT" | null;
  reason: string;
  observedAt: string;
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
      lastLossAtMs: null,
      totalRealizedPnlUsd: 0,
      realizedPeakUsd: 0,
      mirrorAttempts: {},
      lastControllerRegime: null,
      lastControllerMode: null,
      lastOpposingDirection: null,
      opposingSince: null,
      killedAt: null,
      killReason: null,
      killSwitchFlattenFailedIntentIds: [],
      lastRescuePlan: null,
      crowdingExitShadow: {},
      allowedLaneIds: null,
      laneAllocations: null,
      manualSelectorMode: false,
      manualDirectionalAllocations: null,
      laneAllocationOperatorLock: false,
      laneSelectionLossWatermark: null,
      laneSelectionLastAutoReset: null,
      newEntriesPaused: false,
      newEntriesPausedAt: null,
      newEntriesPauseReason: null,
    };
  }

  private _parse(path: string): LiveExecutionState | null {
    try {
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { intents?: unknown }).intents)) {
        // Legacy records persisted before entryOrderId/stopOrderId/tp1OrderId/beStopOrderId became
        // strings (see binance-futures-private.ts's order-ID precision fix) still have these as
        // bare JS numbers on disk — normalize on load so trade-matching `===` against a freshly
        // fetched (genuinely string) order id doesn't silently mismatch on type alone.
        for (const intent of (parsed as { intents: Array<Record<string, unknown>> }).intents) {
          for (const key of ["entryOrderId", "stopOrderId", "tp1OrderId", "beStopOrderId"]) {
            if (typeof intent[key] === "number") intent[key] = String(intent[key]);
          }
        }
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

  /** Bounded retention: every non-terminal intent is kept (it must stay resolvable), plus at most
   *  MAX_STORED_INTENTS terminal (CLOSED/ERROR/KILLED) ones — oldest terminal intents are dropped
   *  first once that cap is exceeded, same convention as residual-momentum-edge.ts/liquidation-
   *  recoil-cross-sectional.ts's own prune(). 2026-07-11 real-money audit fix: this is the ACTUAL
   *  mainnet trade-intent ledger (data/live-execution.json) — unlike its measurement-lane
   *  siblings, it had never been given the same fix, so it grows forever across months of live
   *  trading, one heavy record (variant snapshot, order IDs, state history) per real order. */
  private prune(): void {
    const OPEN_STATES = new Set<LiveIntentState>(["MIRRORED", "ENTRY_PLACED", "OPEN", "TP1_FILLED_BE_SET"]);
    const open = this.state.intents.filter((i) => OPEN_STATES.has(i.state));
    const terminal = this.state.intents
      .filter((i) => !OPEN_STATES.has(i.state))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const keepTerminal =
      terminal.length > MAX_STORED_INTENTS ? terminal.slice(terminal.length - MAX_STORED_INTENTS) : terminal;
    this.state.intents = [...open, ...keepTerminal];
  }

  save(): void {
    this.prune();
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
  | "getIncomeHistory"
>;

export interface LiveExecutionEngineOptions {
  config: LiveExecutionConfig;
  client: LivePrivateClient;
  store: LiveExecutionStore;
  paperStore: PaperStoreReader;
  isPaperOrderLiveEligible?: (order: PaperOrder, nowIso: string) => boolean;
  /** Optional central-orchestrator override for lane admission/weight. Returning null preserves
   *  the existing operator allocation semantics; a concrete value becomes authoritative. */
  paperLaneGate?: (order: PaperOrder) => boolean | null;
  paperLaneWeightPct?: (order: PaperOrder) => number | null;
  getControllerSnapshot?: () => LiveControllerSnapshot | null;
  nowIso?: () => string;
  /** Optional market-data client for the crowding-exit SHADOW measurement (getStatus().crowdingExitShadow).
   *  Read-only, best-effort: never throws, never changes the harvest's actual cut/hold decision.
   *  Omit to leave the measurement dormant (no market-data calls). */
  marketDataClient?: Pick<BinanceClient, "getFuturesFlow" | "getCandles" | "getBookTicker">;
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
  /** Shared strategy/regime admission gate. It affects NEW exposure only; exits always continue. */
  newEntryGate?: () => LiveNewEntryGateDecision;
  /**
   * Real realized P&L (today's UTC-day total + all-time) from every CrossSectionalExecutor and
   * SingleSymbolLaneExecutor instance — lanes that are separate classes with their own stores and
   * never flow through this engine's own applyRealizedToLedger/dailyLedger. Without this,
   * killSwitchTrip() only ever sees this engine's own mirror/directional-slot losses: a 2026-07-11
   * real-money audit found the account-wide LIVE_DAILY_MAX_LOSS_USD/LIVE_MAX_DRAWDOWN_USD safety net
   * could never trip from losses concentrated in those 11 other lanes, each of which only enforces
   * its own much smaller per-lane cap that halts new opens in that ONE lane and never reports
   * anywhere else. Omit to leave killSwitchTrip's engine-native-only behavior unchanged (e.g. in
   * tests that don't construct the other executors). See live-executor-wiring.ts's
   * sumExternalRealizedPnlUsd — the same function backs the dashboard headline and
   * wallet-reconciliation fixes from the same audit, so all three consumers agree on one number.
   */
  getExternalRealizedPnlUsd?: () => { today: number; allTime: number };
  /** 2026-07-12 kill-switch RESPONSE fix: when the (since 2026-07-11 genuinely portfolio-wide)
   *  kill-switch TRIGGER trips, the engine previously flattened only its OWN intents — the other
   *  11 executors (3 baskets + 8 single-symbol lanes) kept their positions and continued running
   *  under their own small per-lane breakers, so the account-wide "stop everything at -$X"
   *  promise only ever covered a quarter of the book. app.ts wires this to each executor's OWN
   *  orderly close method (closeAllBasketsOrderly / closeAllPositionsOrderly) — reduce-only,
   *  netting-aware closes, NEVER a blanket symbol flatten (the operator's standing rule after the
   *  2026-07-07 netting-blind-closes incident: nothing force-flattens an open basket's legs via
   *  raw symbol positions). New ENTRIES across all 11 are already halted automatically: their
   *  isAllowed gates all require engine.canOpenNewEntries(), false once killedAt latches.
   *  Best-effort: a throwing callback must never break the engine's own kill path. */
  onKillSwitchEngaged?: (reason: string) => Promise<void>;
  /**
   * 2026-07-20 real-money audit fix (BUG 1): laneId → fixed trading direction, for
   * setManualDirectionalLaneAllocations's validator (see manualDirectionalLaneMismatchReason's doc
   * comment). app.ts is the single source of truth for which lanes exist and what direction each
   * one is hardcoded to trade — this engine must never hardcode its own lane-id list, or the two
   * would drift the moment a new lane is wired. Omit (e.g. in tests) to leave every laneId
   * unchecked, matching the pre-fix behavior. Return null for a lane with no fixed single direction
   * (unknown id, or a NEUTRAL cross-sectional basket).
   */
  laneDirectionForId?: (laneId: string) => "LONG" | "SHORT" | "NEUTRAL" | null;
  /** CORTEX real-USDT attribution sink (2026-07-21, report-only — see cortex-real-attribution.ts).
   *  Injected the same optional-dep way as laneDirectionForId above: omit (e.g. in tests that
   *  don't care) and the engine records nothing. Every use is wrapped so a failure can NEVER
   *  affect trading. */
  cortexRealAttribution?: CortexRealAttributionStore;
  /** Dense per-tick R-path recorder (2026-07-22, report-only — see position-path-recorder.ts).
   *  Same optional-dep posture as cortexRealAttribution above: omit and the engine is byte-for-byte
   *  unchanged. When present, manageLifecycle appends one (tsMs, currentR) sample per OPEN intent
   *  per tick and a per-tick sweep marks terminal intents' paths closed — every call is wrapped so
   *  a failure can NEVER affect trading. */
  positionPathRecorder?: PositionPathRecorder;
  /** Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
   *  realizedFromTrades() already fetches the exchange's own per-fill rows on every settlement and
   *  keeps exactly two summed scalars (`realizedPnl - commission`, `commission`), discarding EVERY
   *  price: across the 182 closed intents in the live store there is not one exit fill price
   *  anywhere. When present, the rows that settlement already matched are persisted verbatim.
   *  NO EXTRA EXCHANGE CALL and no new round-trip — it is the same `matchedTrades` array. Same
   *  optional-dep posture as the two recorders above: omit and the engine is byte-for-byte
   *  unchanged; every use is wrapped so a failure can NEVER affect trading. */
  executionFillRecorder?: ExecutionFillRecorder;
  /** Optional shadow-only Executive Review resolver sink. app.ts never injects it on 3103. */
  executiveReviewStore?: ExecutiveReviewStore;
}

const ERROR_STREAK_DISARM = 3;
const REGIME_EXIT_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const OPEN_INTENT_STATES: ReadonlySet<LiveIntentState> = new Set(["MIRRORED", "ENTRY_PLACED", "OPEN", "TP1_FILLED_BE_SET"]);
const MIRRORABLE_PAPER_STATUSES: ReadonlySet<string> = new Set(["CREATED", "PAPER_SUBMITTED"]);
// Lanes whose open positions are dumped at market the instant they go net-positive after the
// estimated close cost (operator emergency-exit) — for a lane that's genuinely REMOVED from live
// allocation, so any position it already opened escapes at the first profitable tick instead of
// round-tripping to its own (now-abandoned) TP1/SL geometry.
//
// 2026-07-10: CG_WIDE_FAST_LONG removed from this set. A research audit found it still listed
// here even though it was reinstated into live's active lane allocation (currently 8% weight) —
// meaning every real CG_WIDE_FAST_LONG winner was being swept the instant it cleared ~22bps,
// never reaching its own designed tp1_full target (0.5R). That is almost certainly the mechanical
// cause of the lane's real-trade pattern (73%+ win rate, ~0.78 payoff ratio): winners capped near
// breakeven while losers ran to their real stop. Operator-confirmed fix. CG_WIDE_LONG_RUNNER stays
// — it is genuinely not part of live's current allocation, so the emergency-exit sweep is correct
// for it.
//
// 2026-07-26: the SAME mistake had silently recurred on testnet, because membership in this set was
// the only condition — the sweep never checked whether the lane is actually de-allocated in the
// instance it is running in. CG_WIDE_LONG_RUNNER is indeed unallocated on live (so the note above
// stayed true there) but carries a real 10% weight on testnet, so every one of its testnet winners
// was being swept at ~breakeven. Measured over testnet's own closed ledger: 40 trades closed
// LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST for a combined +$1.96, where letting the same 40 run to
// their own stop/TP was worth +$76.12 (forward 15m testnet candles from each actual close, walked
// with the intent's original geometry). Rather than delete the lane from the set — which would just
// leave the same trap armed for the next lane that gets re-funded — intentHasLiveBreakevenExitLane
// now also requires the lane to be genuinely unfunded HERE. Live behavior is byte-for-byte
// unchanged today (the lane has no live weight, so the orphan-escape sweep stays armed there).
const LIVE_BREAKEVEN_EXIT_LANE_IDS = new Set([
  "CG_WIDE_LONG_RUNNER",
  "CG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER",
]);

/**
 * PURE-GEOMETRY COHORT (2026-07-27) — the lanes listed in LIVE_PURE_GEOMETRY_LANE_IDS are left to
 * their OWN declared exit geometry: every engine overlay skips them, so the thing that closes the
 * position is the lane's own TP or stop and nothing else.
 *
 * WHY THIS EXISTS. An audit of this instance measured which rule actually produced each close:
 * POSITION_FLAT — the lane's own TP/stop firing — accounted for **116 of 800 closes (14.5%)**. The
 * rest were overlays that appear in no lane's definition: REGIME_OPPOSITION_* 199,
 * LOSING_MAX_HOLD_CUT_4H 172, REGIME_CHANGE_HARVEST_* 127, PROFIT_BANK_NET_1.00 87,
 * breakeven-after-cost 40. The corroborating number is maxFavorableR: p50 **0.0736R**, p90 0.214R,
 * and only 3 of 654 intents ever reached +0.5R. A lane declaring a 0.5R take-profit cannot possibly
 * be observed reaching it when the median position is closed by something else at +0.07R.
 *
 * So the standing conclusion "23 lanes were tested and none has edge" was never supported: ~18 of
 * 23 compute their declared geometry correctly to floating-point and then never get to execute it.
 * The lanes were not measured — they were preempted.
 *
 * WHY A SET AND NOT A GLOBAL SWITCH. Two of the four largest overlays (REGIME_OPPOSITION_* and
 * REGIME_CHANGE_HARVEST_*, together 326/800 = 41% of closes) had NO env key and NO per-lane scope
 * of any kind before this — they were unconditional, which is precisely why nobody could ever run a
 * lane as designed even on testnet. A global off-switch would be the wrong repair: these overlays
 * are real risk controls that were each added after a measured loss. A named cohort makes the
 * experiment explicit, reversible, and comparable against the lanes that keep the overlays as a
 * live control group.
 *
 * SAFETY. Empty by default, so unset ⇒ behaviour is byte-for-byte what it is today on every
 * instance. Membership is matched on the full laneId OR its variant suffix, the same way
 * LIVE_BREAKEVEN_EXIT_LANE_IDS matches. Intended for testnet: a lane in this cohort holds to its
 * own stop, which is the point, but that also means the overlays that bound hold time and bank
 * profit are not there to help it.
 */
export function pureGeometryLaneIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = (env.LIVE_PURE_GEOMETRY_LANE_IDS ?? "").trim();
  if (raw.length === 0) return new Set<string>();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
/** The `limit` realizedFromTrades asks /fapi/v1/userTrades for, and therefore the row count at which
 *  the page is SATURATED — Binance returns at most `limit` rows forward from `startTime`, so a full
 *  page means there may be rows we never saw. Named so the request and the saturation test cannot
 *  drift apart; if they do, ExecutionFillRecord.fetchComplete starts claiming a completeness it
 *  cannot know. RECORDING-ONLY: no settlement or gate decision reads the saturation flag. */
const USER_TRADES_PAGE_LIMIT = 1000;
const MAX_USER_TRADES_SETTLEMENT_PAGES = 20;

export interface UserTradesSettlementCoverage {
  trades: FuturesUserTrade[];
  settlementFetchComplete: boolean;
  requiredOrderIds: string[];
  matchedRequiredOrderIds: string[];
  missingRequiredOrderIds: string[];
  pageSaturated: boolean;
}

function settlementFillKey(trade: FuturesUserTrade): string {
  if (typeof trade.tradeId === "string" && trade.tradeId.length > 0) return `trade:${trade.tradeId}`;
  return `order:${trade.orderId}:${trade.time}:${trade.price}:${trade.qty}:${trade.commission}:${trade.realizedPnl}`;
}

function nextTradeCursor(trades: readonly FuturesUserTrade[], current: string | undefined): string | null {
  let largest: bigint | null = null;
  for (const trade of trades) {
    if (!/^\d+$/.test(trade.tradeId ?? "")) continue;
    const id = BigInt(trade.tradeId!);
    if (largest === null || id > largest) largest = id;
  }
  if (largest === null) return null;
  const next = (largest + 1n).toString();
  return current === next ? null : next;
}

/**
 * Fetches only as far as needed to prove exact order-id coverage. A full page
 * is not treated as complete by itself: the cursor must advance, a later page
 * must end, or every required entry/exit order must be observed. This helper
 * is evidence-only; callers still complete the exchange lifecycle if coverage
 * is incomplete.
 */
export async function collectUserTradesSettlementCoverage(
  client: Pick<LivePrivateClient, "getUserTrades">,
  symbol: string,
  startTime: number,
  requiredOrderIds: readonly string[],
  limit = USER_TRADES_PAGE_LIMIT,
  maxPages = MAX_USER_TRADES_SETTLEMENT_PAGES,
): Promise<UserTradesSettlementCoverage> {
  const required = [...new Set(requiredOrderIds.filter((id) => typeof id === "string" && id.length > 0))].sort();
  const seen = new Map<string, FuturesUserTrade>();
  let fromId: string | undefined;
  let pageSaturated = false;
  let exhausted = false;
  for (let pageNo = 0; pageNo < Math.max(1, maxPages); pageNo += 1) {
    const page = await client.getUserTrades(symbol, { startTime, limit, fromId });
    for (const trade of page) seen.set(settlementFillKey(trade), trade);
    const visible = new Set([...seen.values()].map((trade) => trade.orderId));
    const matched = required.filter((id) => visible.has(id));
    if (matched.length === required.length && required.length > 0) {
      return { trades: [...seen.values()], settlementFetchComplete: true, requiredOrderIds: required, matchedRequiredOrderIds: matched, missingRequiredOrderIds: [], pageSaturated };
    }
    if (page.length < limit) { exhausted = true; break; }
    pageSaturated = true;
    const next = nextTradeCursor(page, fromId);
    if (!next || next === fromId) break;
    fromId = next;
  }
  const visible = new Set([...seen.values()].map((trade) => trade.orderId));
  const matched = required.filter((id) => visible.has(id));
  const missing = required.filter((id) => !visible.has(id));
  return {
    trades: [...seen.values()],
    settlementFetchComplete: required.length > 0 ? missing.length === 0 : exhausted && !pageSaturated,
    requiredOrderIds: required,
    matchedRequiredOrderIds: matched,
    missingRequiredOrderIds: missing,
    pageSaturated,
  };
}
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
// 2026-07-26 measured exit-policy change (see maybeCloseTestnetRegimeHarvest): how long a GREEN
// counter-regime position is left to run on its own stop/TP geometry before the regime-opposition
// harvest finally takes it at market. Derived from the same forward-candle study that motivated it:
// across testnet's 78 breakeven-class closes the resolve time was 7.5h median / 16.4h p90, and
// sweeping the backstop 4h→8h→12h→24h→48h yielded +$10 / +$42 / +$54 / +$124 / +$121 versus the
// harvest-at-breakeven baseline — monotone up to 24h, then flat-to-down, so 24h is the knee.
const OPPOSITION_BREAKEVEN_DEFER_MS = DAY_MS;
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
/** 2026-07-21 fix: mirrorAllPaperOrders (testnet collection mode) bypasses lane-eligibility entirely
 *  (laneAllowedForMirror returns true unconditionally) so off-table diagnostic/research paper orders
 *  (exit-ablation variants, sizing-quality experiments, etc.) still get mirrored for real fill data —
 *  but sizing fell through to the OPERATOR's real allocation table regardless, which returns exactly
 *  0% for any lane it doesn't list. A 0% weight zeroes the plan's qty, openIntent's own combinedPlan
 *  then silently no-ops on the unsizeable plan (no order, no error) while the caller still latches
 *  "opened" — so every one of these candidates was mirrored in name only, quarantined after
 *  MAX_MIRROR_ATTEMPTS, and never produced the real fill data the collection mode exists to gather.
 *  This is the default REAL size an off-table lane gets in mirror-all mode — a lane the operator
 *  explicitly listed at 0% (a deliberate exclusion) is untouched by this and stays at 0.
 *  2026-07-21 follow-up: originally 10, which reproduced the SAME silent-fail one step later in
 *  production — 10% of the $50-capped plan is ~$5 notional, under Binance's per-symbol minQty/
 *  minNotional after stepSize rounding, so combinedPlan quietly no-oped and every fresh candidate
 *  quarantined after MAX_MIRROR_ATTEMPTS with zero exchange errors logged. This whole branch is
 *  reachable ONLY under mirrorAllPaperOrders (config-gated testnet-only), so full size is safe and
 *  matches the collection mode's original intent: real, fill-quality execution data per lane. */
const DIAGNOSTIC_LANE_MIRROR_WEIGHT_PCT = 100;
/** 2026-07-09: raised from a hardcoded 4 — operator explicitly asked to raise this so
 *  REGIME_COMPOSITE_CONFIRMATION_LONG (1 slot, already holding 3 real positions) could coexist with
 *  COMPOSITE_ESTIMATOR_BIDI's 4 new buckets (5 total) without evicting either, "for now, re-evaluate
 *  later". Env-overridable so it can be tuned without a redeploy if it needs to change again. */
const MAX_LANE_ALLOCATIONS = envNonNegativeInt(process.env.LIVE_MAX_LANE_ALLOCATIONS, 10);

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

export type TestnetCollectionRegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";

/** The regime is fixed at the source decision, never inferred from the current controller. */
export function testnetCollectionRegimeFamily(
  source: Pick<PaperOrder, "regime" | "controllerMode">,
): TestnetCollectionRegimeFamily {
  const regime = (source.regime ?? "").toUpperCase();
  if (regime.includes("BULL")) return "BULLISH";
  if (regime.includes("BEAR")) return "BEARISH";
  if (regime.includes("MIX")) return "MIXED";

  const mode = (source.controllerMode ?? "").toUpperCase();
  if (mode === "LONG_ONLY") return "BULLISH";
  if (mode === "SHORT_ONLY") return "BEARISH";
  if (mode.includes("MIX") || mode === "VALIDATION_ONLY") return "MIXED";
  return "UNKNOWN";
}

/** A CORTEX collection stratum is intentionally lane- and entry-direction-specific. */
export function testnetCollectionStratumKey(
  source: Pick<PaperOrder, "selectedLaneId" | "direction" | "regime" | "controllerMode">,
): string {
  return [
    source.selectedLaneId ?? "UNKNOWN",
    source.direction,
    testnetCollectionRegimeFamily(source),
  ].join("|");
}

/**
 * Deterministic weighted round-robin for testnet evidence collection. Existing samples are the
 * weight: the least-observed lane × direction × entry-regime gets a turn first, then the next
 * least-observed stratum. Candidates within a stratum retain their caller-provided priority.
 */
export function interleaveTestnetCollectionCandidates<T extends {
  paper: Pick<PaperOrder, "selectedLaneId" | "direction" | "regime" | "controllerMode">;
}>(
  candidates: readonly T[],
  observedByStratum: ReadonlyMap<string, number>,
): T[] {
  const queues = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = testnetCollectionStratumKey(candidate.paper);
    queues.set(key, [...(queues.get(key) ?? []), candidate]);
  }

  const emittedByStratum = new Map<string, number>();
  const output: T[] = [];
  while (queues.size > 0) {
    const nextKey = [...queues.keys()].sort((left, right) => {
      const leftWeight = (observedByStratum.get(left) ?? 0) + (emittedByStratum.get(left) ?? 0);
      const rightWeight = (observedByStratum.get(right) ?? 0) + (emittedByStratum.get(right) ?? 0);
      return leftWeight - rightWeight || left.localeCompare(right);
    })[0]!;
    const queue = queues.get(nextKey)!;
    output.push(queue.shift()!);
    emittedByStratum.set(nextKey, (emittedByStratum.get(nextKey) ?? 0) + 1);
    if (queue.length === 0) queues.delete(nextKey);
  }
  return output;
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

/**
 * 2026-07-19 real-money audit fix (BUG 4, HIGH): worst-case combined notional a directional
 * allocation list (one side — long or short — of setManualDirectionalLaneAllocations) could deploy
 * SIMULTANEOUSLY if every listed lane's signal fired at once. Each lane sizes independently to its
 * own weightPct share of maxNotionalPerTrade — nothing previously summed that across lanes, so
 * e.g. 3 lanes each at weightPct:100 read as "diversification" but structurally means up to 3x
 * maxNotionalPerTrade of real simultaneous exposure. Pure so the real-money math is testable
 * without the full engine; see LiveExecutionConfig.maxAggregateManualDirectionalNotionalUsd's doc
 * comment for how this is used (opt-in cap) and surfaced (always, via getStatus() and this
 * function's return value from setManualDirectionalLaneAllocations).
 */
export function combinedWorstCaseNotionalUsd(
  rows: ReadonlyArray<{ weightPct: number }>,
  maxNotionalPerTrade: number,
): number {
  return rows.reduce((sum, r) => sum + maxNotionalPerTrade * (Math.max(0, Math.min(100, r.weightPct)) / 100), 0);
}

/**
 * 2026-07-20 real-money audit fix (BUG 1, HIGH): setManualDirectionalLaneAllocations validated each
 * laneId as an opaque string — nothing checked it against the lane's own FIXED trading direction.
 * SingleSymbolLaneExecutor instances (RC/RCS/SF/IM/PWR + the 4 CE buckets) are each constructed in
 * app.ts with a hardcoded `direction`; their isAllowed() only ever consults
 * laneSelectionAllowsLane(laneId), which is direction-blind. If an operator (or a copy/paste error
 * in the dashboard's shared long/short lane dropdown — both rows list the SAME options) put a
 * LONG-only lane under "short", the moment the scanner's Entry Decision flipped to SHORT the lane's
 * weight>0 on the active side, opening a real LONG position at exactly the moment the engine's own
 * directional read favored SHORT. laneDirectionForId returning null (unknown lane — e.g. a CG
 * variant-matrix id with no dedicated executor, or a NEUTRAL cross-sectional basket) is NOT treated
 * as a mismatch: those lanes are either direction-agnostic or already validated by
 * isManualEntryAllowedForPaper's own `decision.directionalBias === paper.direction` check — this
 * only rejects a PROVEN conflict against a lane's own fixed direction, never an absence of proof.
 */
export function manualDirectionalLaneMismatchReason(
  side: "long" | "short",
  laneId: string,
  laneDirectionForId: (laneId: string) => "LONG" | "SHORT" | "NEUTRAL" | null,
): string | null {
  const variantId = laneId.split(":").pop() ?? laneId;
  const direction = laneDirectionForId(laneId) ?? laneDirectionForId(variantId);
  if (!direction || direction === "NEUTRAL") return null;
  if (side === "long" && direction === "SHORT") {
    return `${laneId} is a fixed SHORT-direction lane and cannot be listed under long`;
  }
  if (side === "short" && direction === "LONG") {
    return `${laneId} is a fixed LONG-direction lane and cannot be listed under short`;
  }
  return null;
}

/**
 * 2026-07-20 real-money audit fix (BUG 2, HIGH): manualEntryDecision carries an observedAt stamp
 * that nothing ever compared to "now" before treating it as authoritative for real-money admission.
 * refreshManualEntryDecision() (scan.ts) only console.errors on a persistent failure and otherwise
 * leaves the prior decision frozen — so a scan-cycle outage lasting hours left single-symbol lanes
 * opening real positions on a directional read that may have long since reversed. Threshold: the
 * scan cycle refreshes this every CORE_SCAN_AUTO_REFRESH_INTERVAL_MINUTES (scan.ts, default 7 min);
 * 3x that (21 min, rounded to 20) survives ordinary cycle jitter (one slow or skipped tick) without
 * ever treating a genuinely hours-long outage as still fresh. An unparsable timestamp is treated as
 * maximally stale (fail closed), never as fresh.
 */
export const MANUAL_ENTRY_DECISION_MAX_AGE_MS = 20 * 60 * 1000;

export function isManualEntryDecisionStale(
  observedAt: string,
  nowMs: number,
  maxAgeMs: number = MANUAL_ENTRY_DECISION_MAX_AGE_MS,
): boolean {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return true;
  return nowMs - observedMs > maxAgeMs;
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
  private readonly paperLaneGate: (order: PaperOrder) => boolean | null;
  private readonly paperLaneWeightPct: (order: PaperOrder) => number | null;
  private readonly getControllerSnapshot: () => LiveControllerSnapshot | null;
  private readonly nowIso: () => string;
  private readonly marketDataClient?: Pick<BinanceClient, "getFuturesFlow" | "getCandles" | "getBookTicker">;
  private readonly fillConfirmRetryDelayMs: number;
  private readonly externalManagedNetQty: () => Map<string, number>;
  private readonly newEntryGate: () => LiveNewEntryGateDecision;
  private readonly getExternalRealizedPnlUsd: () => { today: number; allTime: number };
  private readonly onKillSwitchEngaged: ((reason: string) => Promise<void>) | null;
  private readonly laneDirectionForId: (laneId: string) => "LONG" | "SHORT" | "NEUTRAL" | null;
  private readonly cortexRealAttribution: CortexRealAttributionStore | null;
  private readonly positionPathRecorder: PositionPathRecorder | null;
  private readonly executionFillRecorder: ExecutionFillRecorder | null;
  private readonly executiveReviewStore: ExecutiveReviewStore | null;

  /** In-memory ONLY — restart always boots disarmed. */
  private armed = false;
  private errorStreak = 0;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;
  private reconcileIssues: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** 2026-07-11 real-money audit fix: `this.ticking` only blocks a second concurrent tick() — it
   *  does NOT block manualCloseIntent()/kill()/flattenAllExchangePositions(), which the dashboard
   *  can call directly at any moment. Any code path about to flatten+settle a specific intent
   *  must claim it here first and check no one else already has it, or two overlapping paths can
   *  both flatten the same real position and double-book its realized P&L into the ledger. */
  private busyIntentIds = new Set<string>();
  /** Guards engageKillSwitch() itself against two overlapping invocations (tick()'s automatic
   *  trip and a manual kill() arriving at the same moment) double-flattening the same book. */
  private killSwitchEngaging = false;
  /** 2026-07-12 fix: copyExternalIntent()'s "no existing intent on this symbol" check ran before
   *  an await gap (getFilters), with openIntent() never re-verifying uniqueness before pushing a
   *  new intent — two overlapping calls (double-click, retry) on the same symbol could both pass
   *  the check and open two real, independently-managed positions on it. Claimed synchronously
   *  before any await, released in a finally. */
  private copyingSymbols = new Set<string>();
  /** Newest candidates' first-failing mirror gate — pure observation for "kenapa ga ada trade?". */
  private lastMirrorFunnel: Array<{ id: string; symbol: string; direction: string; createdAt: string; reason: string; firstReason?: string }> = [];
  /** First-seen decision per candidate: after one tick, live candidates fall behind the watermark
   *  and every later funnel read shows only "behind_watermark" — the reason that MATTERED (the one
   *  from the tick that actually evaluated it) must be latched or it is lost forever. */
  private mirrorFirstReason = new Map<string, string>();
  private filtersCache: Map<string, FuturesSymbolFilters> | null = null;
  private leverageBySymbol = new Map<string, number>();
  private isolatedMarginSet = new Set<string>();
  /** Scanner-owned; intentionally not persisted, so a restart can never revive a stale direction. */
  private manualEntryDecision: ManualEntryDecisionSnapshot | null = null;
  /** CORTEX Phase-4 promotion (2026-07-20): the latest gated/damped operational tilt, keyed by REAL
   *  engine lane id — set every ~5min cycle by the caller (app.ts's cortexShadowTick), null whenever
   *  this instance isn't promoted or the cycle's checks didn't pass. Intentionally not persisted:
   *  a restart must never resume a stale tilt before the next cycle re-derives it fresh. */
  private cortexPromotedWeights: Record<string, number> | null = null;
  /** Throttle for refreshSymbolVolatilityCache — ATR% moves slowly, no need to refetch every tick. */
  private lastVolatilityRefreshAtMs = 0;

  constructor(options: LiveExecutionEngineOptions) {
    this.config = options.config;
    this.client = options.client;
    this.store = options.store;
    this.paperStore = options.paperStore;
    this.isPaperOrderLiveEligible = options.isPaperOrderLiveEligible ?? (() => true);
    this.paperLaneGate = options.paperLaneGate ?? (() => null);
    this.paperLaneWeightPct = options.paperLaneWeightPct ?? (() => null);
    this.getControllerSnapshot = options.getControllerSnapshot ?? (() => null);
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.marketDataClient = options.marketDataClient;
    this.fillConfirmRetryDelayMs = options.fillConfirmRetryDelayMs ?? 400;
    this.externalManagedNetQty = options.externalManagedNetQty ?? (() => new Map());
    this.newEntryGate = options.newEntryGate ?? (() => ({ allowed: true, reason: null }));
    this.getExternalRealizedPnlUsd = options.getExternalRealizedPnlUsd ?? (() => ({ today: 0, allTime: 0 }));
    this.onKillSwitchEngaged = options.onKillSwitchEngaged ?? null;
    this.laneDirectionForId = options.laneDirectionForId ?? (() => null);
    this.cortexRealAttribution = options.cortexRealAttribution ?? null;
    this.positionPathRecorder = options.positionPathRecorder ?? null;
    this.executionFillRecorder = options.executionFillRecorder ?? null;
    this.executiveReviewStore = options.executiveReviewStore ?? null;
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

  /**
   * Regime-exit persistence (Tier 2 audit, purely additive): stamps the SAME three controller
   * fields captured at entry (LiveIntentSource.regime/controllerMode/controllerConfidence) onto
   * the intent at the moment it closes, read LIVE via currentControllerSnapshot() — the identical
   * mechanism the regime harvest already reads for its cut/hold decision. No freshness gating here
   * (unlike controllerSnapshotIsFresh, which gates a live DECISION): this is a report-only
   * best-effort snapshot for post-hoc entry-vs-exit comparison, never read by any exit/close
   * decision. null when no controller is wired/available at close time.
   */
  private stampExitControllerSnapshot(intent: LiveIntent): void {
    const controller = this.currentControllerSnapshot();
    intent.exitRegime = controller?.regime ?? null;
    intent.exitControllerMode = controller?.mode ?? null;
    intent.exitControllerConfidence = controller?.confidence ?? null;
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
    flattened: Array<{ symbol: string; side: "BUY" | "SELL"; quantity: number; orderId: string | null }>;
    failed: Array<{ symbol: string; action: string; reason: string }>;
  }> {
    const st = this.store.getState();
    this.armed = false;
    st.killedAt = this.nowIso();
    st.killReason = `manual exchange flatten: ${reason}`;

    const failed: Array<{ symbol: string; action: string; reason: string }> = [];
    const canceledOrderSymbols: string[] = [];
    const canceledAlgoSymbols: string[] = [];
    const flattened: Array<{ symbol: string; side: "BUY" | "SELL"; quantity: number; orderId: string | null }> = [];
    const flattenOrderIdBySymbol = new Map<string, string | null>();

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
      // 2026-07-11 real-money audit fix: this operator panic-flatten route can race a concurrent
      // tick() (manageLifecycle/engageKillSwitch) on the same intent — claim it first so neither
      // path double-flattens/double-books the same real close.
      if (this.busyIntentIds.has(intent.paperOrderId)) continue;
      this.busyIntentIds.add(intent.paperOrderId);
      try {
        // A panic flatten is NEVER a win — book its realized P&L so it isn't silently dropped from
        // lane reports and the drawdown-peak rebase, same reasoning as the kill-switch path below.
        const settled = await this.settleIntentAfterClose(intent, [flattenOrderIdBySymbol.get(intent.symbol) ?? null]);
        const net = settled?.netUsd ?? null;
        intent.realizedPnlUsd = net;
        intent.feesUsd = settled?.feesUsd ?? null;
        intent.feeSource = settled?.feeSource ?? undefined;
        this.applyRealizedToLedger(net, "adverse");
        intent.state = "KILLED";
        intent.closeReason = `EXCHANGE_FLATTEN: ${reason}`;
        intent.closedAt = this.nowIso();
        this.stampExitControllerSnapshot(intent);
        intent.updatedAt = this.nowIso();
        const symbolFailed = failed.some((item) => item.symbol === intent.symbol);
        if (net === null || symbolFailed) {
          intent.lastError = [
            net === null ? "P&L UNKNOWN — trades fetch failed; wallet-reconciliation will catch the true amount" : null,
            symbolFailed ? "exchange flatten had symbol-level failures; check /api/live/status" : null,
          ]
            .filter((part): part is string => part !== null)
            .join("; ");
        }
      } finally {
        this.busyIntentIds.delete(intent.paperOrderId);
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
   *  - combinedRealizedPeakUsd → current combined (engine + external lanes) total, same rebase
   *    reason (2026-07-11 fix: without this, a stale pre-reset combined peak would make
   *    killSwitchTrip's drawdown check re-trip on the very next tick even though realizedPeakUsd
   *    itself was correctly rebased — the exact footgun this method exists to avoid).
   * The DAILY ledger is intentionally left untouched: a daily-max-loss kill is meant to enforce a
   * cool-off for the rest of the UTC day, so it correctly re-latches until the day rolls over.
   *
   * 2026-07-12 fix: this mutated the same shared store with no guard against an in-flight
   * engageKillSwitch() — calling reset while the kill-triggered flatten loop is still awaiting an
   * exchange call would erase killedAt/killReason BEFORE the flatten finishes, letting arm() (and
   * then copyExternalIntent/mirrorNewSignals) re-open exposure on a symbol whose position isn't
   * actually flat yet. Guarded by the SAME killSwitchEngaging flag engageKillSwitch() itself uses.
   */
  resetKill(): { ok: boolean; reason: string | null } {
    if (this.killSwitchEngaging) {
      return { ok: false, reason: "kill-switch flatten is still in progress — wait for it to finish, then reset" };
    }
    const st = this.store.getState();
    st.killedAt = null;
    st.killReason = null;
    st.consecutiveLosses = 0;
    st.lastLossAtMs = null;
    st.realizedPeakUsd = st.totalRealizedPnlUsd;
    st.combinedRealizedPeakUsd = st.totalRealizedPnlUsd + this.safeExternalRealizedPnlUsd().allTime;
    this.store.save();
    return { ok: true, reason: null };
  }

  isArmed(): boolean {
    return this.armed;
  }

  private strategyEntryGate(): LiveNewEntryGateDecision {
    try {
      const result = this.newEntryGate();
      return result && typeof result.allowed === "boolean"
        ? { allowed: result.allowed, reason: result.reason ?? null }
        : { allowed: false, reason: "invalid strategy entry-gate response" };
    } catch (error) {
      return { allowed: false, reason: `strategy entry gate failed: ${(error as Error).message}` };
    }
  }

  /** Armed means exits/reconcile are active. This stricter method controls NEW exposure only. */
  canOpenNewEntries(): boolean {
    const st = this.store.getState();
    if (!this.armed || st.killedAt) return false;
    if (this.isNewEntryDrainActive()) return false;
    // Testnet collect-all still honours arm/disarm, the kill switch, and an
    // operator drain. It deliberately does not inherit strategy admission.
    if (this.config.mirrorAllPaperOrders) return true;
    // Manual mode bypasses strategy/admission blockers only when the scanner has produced a current
    // directional Entry Decision. Exchange health, stop/TP placement, caps, and the kill switch remain.
    if (st.manualSelectorMode && st.manualDirectionalAllocations) return this.isManualDirectionalEntryEnabled();
    return this.strategyEntryGate().allowed;
  }

  /** Same as canOpenNewEntries() but never delegates to the manual-directional bias gate — for
   *  baskets (e.g. CROSS_SECTIONAL_MARKET_NEUTRAL) whose own signal has no single-symbol
   *  directional bias to align with, so the manual selector's LONG/SHORT allocation is simply
   *  irrelevant to them. Manual mode still resolves via strategyEntryGate() below, exactly as
   *  when manual mode is off — this only removes the mode-specific short-circuit. */
  canOpenNewEntriesIgnoringManualDirectional(): boolean {
    const st = this.store.getState();
    if (!this.armed || st.killedAt) return false;
    if (this.isNewEntryDrainActive()) return false;
    if (this.config.mirrorAllPaperOrders) return true;
    return this.strategyEntryGate().allowed;
  }

  isNewEntryDrainActive(): boolean {
    return this.store.getState().newEntriesPaused === true || process.env.LIVE_NEW_ENTRY_DRAIN === "1";
  }

  setNewEntriesPaused(enabled: boolean, reason = "operator request"): {
    enabled: boolean;
    effective: boolean;
    pausedAt: string | null;
    reason: string | null;
  } {
    const st = this.store.getState();
    st.newEntriesPaused = enabled;
    st.newEntriesPausedAt = enabled ? this.nowIso() : null;
    st.newEntriesPauseReason = enabled ? reason : null;
    this.store.save();
    return {
      enabled: st.newEntriesPaused,
      effective: this.isNewEntryDrainActive(),
      pausedAt: st.newEntriesPausedAt,
      reason: st.newEntriesPauseReason,
    };
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
    const strategyEntryGate = this.strategyEntryGate();
    return {
      enabled: this.config.enabled,
      env: this.config.env,
      armed: this.armed,
      newEntries: {
        allowed: this.canOpenNewEntries(),
        drainActive: this.isNewEntryDrainActive(),
        persistedDrain: st.newEntriesPaused === true,
        pausedAt: st.newEntriesPausedAt ?? null,
        pauseReason: st.newEntriesPauseReason ?? null,
        strategyGate: strategyEntryGate,
      },
      configErrors: this.config.configErrors,
      killedAt: st.killedAt,
      killReason: st.killReason,
      // 2026-07-19 real-money audit fix (BUG 1): a kill-switch flatten that threw on a transient
      // error left a real position open with NOTHING distinguishing it from "cleanly flattened" or
      // "never killed" — see LiveExecutionState.killSwitchFlattenFailedIntentIds's doc comment.
      // Non-empty here means real, still-open exposure the kill-switch tried and failed to close;
      // retryFailedKillFlattens() keeps retrying every tick until this list empties out on its own.
      killSwitchFlattenFailures: (st.killSwitchFlattenFailedIntentIds ?? [])
        .map((paperOrderId) => {
          const intent = st.intents.find((i) => i.paperOrderId === paperOrderId);
          return intent
            ? {
                paperOrderId,
                symbol: intent.symbol,
                direction: intent.direction,
                qty: intent.qty,
                lastError: intent.lastError,
              }
            : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
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
        plannedRiskUsd: i.plannedRiskUsd ?? null,
        effectiveRiskUsd: i.effectiveRiskUsd ?? null,
        requiredNotionalUsd: i.requiredNotionalUsd ?? null,
        appliedNotionalUsd: i.appliedNotionalUsd ?? null,
        notionalCapUsd: i.notionalCapUsd ?? null,
        stopDistancePct: i.stopDistancePct ?? null,
        riskClippedByNotionalCap: i.riskClippedByNotionalCap ?? null,
      })),
      // 2026-07-12 R-clipping telemetry (report-only): the scaling arithmetic ("each $1 of R ≈
      // $X/month at measured netAvgR") is only trustworthy against the REAL per-trade R. Measured
      // live: nominal $5 risk clipped to ~$1.50 by the $50 notional cap at ~300bps stops — this
      // block makes that visible instead of leaving the config value to masquerade as reality.
      riskSizing: (() => {
        const recentClosed = st.intents
          .filter((i) => i.state === "CLOSED" && typeof i.effectiveRiskUsd === "number")
          .slice(-50);
        const withRisk = [...recentClosed, ...openIntents.filter((i) => typeof i.effectiveRiskUsd === "number")];
        const clippedCount = withRisk.filter((i) => i.riskClippedByNotionalCap === true).length;
        const avgEffective =
          withRisk.length > 0
            ? withRisk.reduce((sum, i) => sum + (i.effectiveRiskUsd ?? 0), 0) / withRisk.length
            : null;
        const average = (field: "plannedRiskUsd" | "requiredNotionalUsd" | "appliedNotionalUsd" | "notionalCapUsd" | "stopDistancePct"): number | null => {
          const values = withRisk
            .map((intent) => intent[field])
            .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        };
        return {
          nominalRiskUsdPerTrade: this.config.riskUsdPerTrade,
          avgPlannedRiskUsd: average("plannedRiskUsd"),
          avgEffectiveRiskUsd: avgEffective,
          avgRequiredNotionalUsd: average("requiredNotionalUsd"),
          avgAppliedNotionalUsd: average("appliedNotionalUsd"),
          avgNotionalCapUsd: average("notionalCapUsd"),
          avgStopDistancePct: average("stopDistancePct"),
          sampleCount: withRisk.length,
          clippedShare: withRisk.length > 0 ? clippedCount / withRisk.length : null,
          clippingRatePct: withRisk.length > 0 ? (clippedCount / withRisk.length) * 100 : null,
          warning:
            avgEffective !== null && avgEffective < this.config.riskUsdPerTrade * 0.75
              ? `effective R ($${avgEffective.toFixed(2)}) is well below nominal ($${this.config.riskUsdPerTrade}) — maxNotionalPerTrade ($${this.config.maxNotionalPerTrade}) is clipping size on ${(100 * (clippedCount / withRisk.length)).toFixed(0)}% of recent trades`
              : null,
        };
      })(),
      closedToday: st.dailyLedger,
      consecutiveLosses: st.consecutiveLosses,
      totalRealizedPnlUsd: st.totalRealizedPnlUsd,
      limits: {
        riskUsdPerTrade: this.config.riskUsdPerTrade,
        maxConcurrentPositions: this.config.maxConcurrentPositions,
        maxCorrelatedAltLongPositions: this.config.maxCorrelatedAltLongPositions,
        maxCorrelatedAltShortPositions: this.config.maxCorrelatedAltShortPositions,
        maxAggregateIntentRiskUsd: this.maxAggregateIntentRiskUsd(),
        maxClusterPositions: this.config.maxClusterPositions,
        dailyMaxLossUsd: this.config.dailyMaxLossUsd,
        maxConsecutiveLosses: this.config.maxConsecutiveLosses,
        consecutiveLossWindowHours: this.config.consecutiveLossWindowHours,
        autoKillSwitchEnabled: this.config.autoKillSwitchEnabled,
        scratchEpsilonUsd: this.config.scratchEpsilonUsd,
        maxDrawdownUsd: this.config.maxDrawdownUsd,
        defaultLeverage: this.config.defaultLeverage,
        maxLeverage: this.config.maxLeverage,
        maxNotionalPerTrade: this.config.maxNotionalPerTrade,
        maxPaperOrderAgeMs: this.config.maxPaperOrderAgeMs,
        mirrorAllPaperOrders: this.config.mirrorAllPaperOrders,
        // Deliberately testnet-only; reports whether collection is being interleaved by
        // lane, side, and entry-regime rather than a single mirror priority queue.
        testnetStratifiedCollection: this.config.testnetStratifiedCollection,
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
        profitBankMode: this.config.profitBankMode,
        profitBankTargetR: this.config.profitBankTargetR,
        maxEntryChaseStopFraction: this.maxEntryChaseStopFraction(),
        minEntryGrossTargetPct: this.minEntryGrossTargetPct(),
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
        manualDirectionalAllocations: st.manualDirectionalAllocations
          ? {
              long: st.manualDirectionalAllocations.long,
              short: st.manualDirectionalAllocations.short,
              // 2026-07-19 real-money audit fix (BUG 4): the real worst-case combined notional per
              // side if every listed lane fired at once — see combinedWorstCaseNotionalUsd's doc
              // comment. Always computed from the CURRENT persisted allocation + config so it
              // stays correct across restarts, independent of whether the aggregate cap below is
              // enforced — a 3-lanes-at-100% configuration must never read as "diversification"
              // just because nothing rejected it.
              combinedWorstCaseNotionalUsd: {
                long: combinedWorstCaseNotionalUsd(st.manualDirectionalAllocations.long, this.config.maxNotionalPerTrade),
                short: combinedWorstCaseNotionalUsd(st.manualDirectionalAllocations.short, this.config.maxNotionalPerTrade),
              },
              maxAggregateNotionalCapUsd:
                this.config.maxAggregateManualDirectionalNotionalUsd > 0 ? this.config.maxAggregateManualDirectionalNotionalUsd : null,
              activeDirection: this.manualEntryDecision?.directionalBias ?? null,
              entryDecision: this.manualEntryDecision,
              // 2026-07-20 real-money audit fix (BUG 2): surfaced so the dashboard COULD show a
              // staleness warning — see isManualEntryDecisionStale's doc comment for the threshold
              // and the outage class this guards against. false (never stale) when there is no
              // decision at all — "no decision yet" and "stale decision" are different states and
              // the dashboard's existing WAITING ENTRY DECISION copy already covers the former.
              entryDecisionStale: this.manualEntryDecision
                ? isManualEntryDecisionStale(this.manualEntryDecision.observedAt, Date.parse(this.nowIso()))
                : false,
            }
          : null,
        laneAllocationOperatorLock: st.laneAllocationOperatorLock === true,
        mode: st.manualSelectorMode && st.manualDirectionalAllocations
          ? ("MANUAL_DIRECTIONAL" as const)
          : st.laneAllocations && st.laneAllocations.length > 0
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

  /**
   * Read-only passthrough to the client's /fapi/v1/income fetch, account-wide (no symbol filter).
   * Exists so the (separate, report-only) wallet-reconciliation module can compare Binance's own
   * income ledger against the internal dailyLedger without reaching into the private `client`
   * field directly. This method itself does no comparison, no logging, and no side effects — it
   * only forwards to the client and returns whatever Binance reports.
   */
  async getIncomeHistory(startTimeMs: number, endTimeMs: number): Promise<FuturesIncomeEntry[]> {
    return this.client.getIncomeHistory({ startTime: startTimeMs, endTime: endTimeMs });
  }

  /**
   * Actual commissions attributed to engine intents that REALIZED today. Open-entry commissions are
   * deliberately excluded so wallet reconciliation compares closed economics to closed economics.
   *
   * Every TERMINAL state counts, not just "CLOSED" — matching `sweepCortexRealAttribution`'s
   * `if (OPEN_INTENT_STATES.has(intent.state)) continue;`, the codebase's canonical "has this intent
   * realized dollars" test. This used to filter `state === "CLOSED"` alone, which silently dropped
   * every KILLED close (kill-switch flatten and operator panic-flatten) and every ERROR close
   * (emergency flatten with no stop). All three of those paths set a real `intent.feesUsd` and feed
   * `applyRealizedToLedger`, so their fees ARE inside `dailyLedger.realizedPnlUsd` — the numerator
   * wallet-reconciliation grosses back up. Omitting them from the grossup understated
   * comparisonInternalUsd by exactly the omitted fee sum and produced a spurious "WALLET
   * RECONCILIATION MISMATCH" on precisely the days a kill-switch tripped, i.e. the days an operator
   * most needs that signal to be trustworthy.
   *
   * Day bucket: `closedAt` when the path stamped one (both KILLED paths do), else `updatedAt`. The
   * ERROR emergency-flatten path realizes P&L without stamping `closedAt`, and dropping it for want
   * of a timestamp would reintroduce the same understatement it is being fixed for.
   */
  getClosedTodayFeesUsd(): number {
    const dayUtc = this.nowIso().slice(0, 10);
    return this.store.getState().intents
      .filter((intent) => {
        if (OPEN_INTENT_STATES.has(intent.state)) return false;
        const realizedAt = intent.closedAt ?? intent.updatedAt;
        return (
          realizedAt?.startsWith(dayUtc) === true &&
          typeof intent.feesUsd === "number" &&
          Number.isFinite(intent.feesUsd)
        );
      })
      .reduce((sum, intent) => sum + (intent.feesUsd ?? 0), 0);
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
      /** Single-symbol-executor share — filled by annotateSingleSymbolAccount. This is a REAL
       *  exchange-side protective stop (not a basket horizon, not an engine TP1) — kept in its own
       *  field rather than reusing targetTpPrice so the dashboard can render it honestly instead of
       *  as a fabricated "TP target" (2026-07-09 audit finding). */
      singleSymbolStopPrice: number | null;
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
        singleSymbolStopPrice: null,
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
      // 2026-07-09 fix: aggregate sources by laneId FIRST. A pyramided intent can carry many
      // sources sharing the SAME laneId (repeated adds into one open position) — that is ONE
      // closed trade for that lane, not one per add. Counting per-source previously inflated
      // closedCount/wins/losses by the add count (a position pyramided 26x counted as "26 trades"),
      // which both overstated real sample size and distorted the reported win rate whenever
      // pyramiding correlated with outcome (confirmed root cause of the CG_WIDE_FAST_LONG
      // testnet/live divergence investigation — testnet's losing DOGE/WLD positions had pyramided
      // up to 26x before their stop, so those 2 real losses alone inflated the loss tally by
      // dozens). realizedPnlUsd/feesUsd stay dollar-correct either way (shares still sum to 1
      // across an intent); only the trade/win/loss COUNTS change.
      const qtyByLane = new Map<string, number>();
      for (const source of sources) {
        qtyByLane.set(source.laneId, (qtyByLane.get(source.laneId) ?? 0) + source.qty);
      }
      for (const [laneId, laneQty] of qtyByLane) {
        const share = totalQty > 0 ? laneQty / totalQty : 1 / Math.max(qtyByLane.size, 1);
        const allocatedRealized = realized * share;
        const row = closedLaneMap.get(laneId) ?? {
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
        closedLaneMap.set(laneId, row);
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

      // 2026-07-09 fix: same as getAccountSnapshot's closedLanes — aggregate sources by laneId
      // FIRST so a pyramided intent (many adds, same lane) counts as ONE closed trade, not one per
      // add (see that fix's comment for the full incident). Regime classification uses the FIRST
      // source's regime/controllerMode/confidence per lane group — that source is the original
      // entry, and later adds' regime snapshots describe re-entries into an ALREADY open position,
      // not a fresh trade worth its own classification.
      const sourcesByLane = new Map<string, LiveIntentSource[]>();
      for (const source of sources) {
        const laneId = source.laneId || "UNKNOWN";
        const list = sourcesByLane.get(laneId) ?? [];
        list.push(source);
        sourcesByLane.set(laneId, list);
      }

      for (const [laneId, laneSources] of sourcesByLane) {
        const laneQty = laneSources.reduce((sum, source) => sum + source.qty, 0);
        const share = totalQty > 0 ? laneQty / totalQty : 1 / Math.max(sourcesByLane.size, 1);
        const representative = laneSources[0]!;
        const classified = classifyLivePerformanceRegime({
          regime: representative.regime ?? null,
          controllerMode: representative.controllerMode ?? null,
          controllerConfidence: representative.controllerConfidence ?? null,
        });
        if (!regimeFilterMatches(regimeFilter, classified)) continue;

        const allocatedRealized = realized * share;
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

  private maxEntryChaseStopFraction(): number {
    const n = Number.parseFloat(process.env.LIVE_MAX_ENTRY_CHASE_STOP_FRACTION ?? "");
    return Number.isFinite(n) && n >= 0 ? n : 0.2;
  }

  private minEntryGrossTargetPct(): number {
    const n = Number.parseFloat(process.env.LIVE_MIN_ENTRY_GROSS_TARGET_PCT ?? "");
    return Number.isFinite(n) && n >= 0 ? n : 0.0035;
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

      // 1.5. Retry any per-intent kill-switch flatten that previously failed with a transient
      // error (see LiveExecutionState.killSwitchFlattenFailedIntentIds's doc comment). killSwitchTrip()
      // itself never re-fires once already latched, so this is the only path that revisits a
      // failed kill flatten on a later tick — a transient failure must self-heal, not leave real
      // exposure silently open forever.
      await this.retryFailedKillFlattens();

      // 2. Reconcile local intents vs exchange truth.
      await this.reconcile();

      // 3. Manage lifecycle of open intents (TP1 → breakeven, close detection).
      await this.manageLifecycle();

      // 3.5. CORTEX real-USDT attribution sweep (report-only, fail-safe — see its doc comment).
      this.sweepCortexRealAttribution();

      // 3.6. Dense R-path close sweep + batched persist (report-only, fail-safe — see its doc
      // comment). Runs right after lifecycle management so a close is handed to the Exit Brain's
      // reader on the same tick it settles.
      this.sweepPositionPathRecorder();

      // 3.65. Exact Executive Review intent -> position linkage. This is shadow bookkeeping only:
      // it cannot create an outcome from USD P&L, cannot change an order, and is never injected on 3103.
      this.sweepExecutiveReviewPositions();

      // 3.7. Per-fill store retention (report-only, fail-safe). Deliberately NOT its own timer —
      // the 234 MB unrotated-journal incident was caused by a file re-read on a poll, and adding a
      // second independent schedule is how that class of bug gets re-introduced. This piggybacks on
      // the tick that already runs, does no I/O unless something actually expired, and never reads
      // the file (the store is read exactly once, in its constructor).
      this.sweepExecutionFillRecorder();

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
    // 2026-07-11 real-money audit fix: this used to have no reentrancy guard at all, so an
    // in-flight tick() (manageLifecycle/engageKillSwitch, neither gated by `this.ticking` from
    // here) could flatten+settle this SAME intent concurrently — double-booking realized P&L.
    if (this.busyIntentIds.has(paperOrderId)) {
      return { ok: false, reason: "intent is already being processed by the engine — try again in a moment", realizedPnlUsd: null };
    }
    this.busyIntentIds.add(paperOrderId);
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
      let flattenOrderId: string | null = null;
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
      const settled = await this.settleIntentAfterClose(intent, [flattenOrderId]);
      const net = settled?.netUsd ?? null;
      intent.realizedPnlUsd = net;
      intent.feesUsd = settled?.feesUsd ?? null;
      intent.feeSource = settled?.feeSource ?? undefined;
      if (net === null) {
        intent.lastError = "operator close: P&L UNKNOWN — trades fetch failed after a real close; wallet-reconciliation will catch the true amount";
        this.applyRealizedToLedger(null);
      } else {
        this.applyRealizedToLedger(net);
      }
      intent.state = "CLOSED";
      intent.closeReason = "OPERATOR_CLOSE";
      intent.closedAt = this.nowIso();
      this.stampExitControllerSnapshot(intent);
      intent.updatedAt = this.nowIso();
      this.store.save();
      return { ok: true, reason: null, realizedPnlUsd: net };
    } catch (error) {
      intent.lastError = `operator close failed: ${(error as Error).message}`;
      intent.updatedAt = this.nowIso();
      this.store.save();
      return { ok: false, reason: (error as Error).message, realizedPnlUsd: null };
    } finally {
      this.busyIntentIds.delete(paperOrderId);
    }
  }

  // ── kill-switch ────────────────────────────────────────────────────────────

  /**
   * 2026-07-11 real-money audit fix: this used to compare ONLY this engine's own mirror/directional-
   * slot ledger (dailyLedger/totalRealizedPnlUsd, fed exclusively by applyRealizedToLedger) against
   * dailyMaxLossUsd/maxDrawdownUsd. The 3 CrossSectionalExecutor + 8 SingleSymbolLaneExecutor
   * instances are separate classes with their own stores and never touch this ledger — each only
   * enforces its own much smaller per-lane daily-loss cap (~$8) that halts new opens in that ONE
   * lane and reports nowhere else. Confirmed live: the account-wide "stop trading if losing more
   * than $40/day" promise could never be kept purely from losses concentrated in those 11 lanes.
   * getExternalRealizedPnlUsd() (same source as the dashboard headline and wallet-reconciliation
   * fixes from the same audit) is folded into both checks below WITHOUT touching dailyLedger/
   * consecutiveLosses/realizedPeakUsd themselves — those stay engine-native. combinedRealizedPeakUsd
   * is a NEW, separate peak tracked here (this function already runs first on every tick, so
   * updating it here needs no new hook) — its first value after this fix deploys is seeded from
   * max(realizedPeakUsd, current combined total), an honest approximation since no true historical
   * combined-total peak was ever recorded before.
   *
   * 2026-07-19 real-money audit follow-up: the paragraph above used to claim "consecutiveLosses has
   * no cross-lane equivalent worth inventing; a losing streak is inherently a per-mechanism concept"
   * — that was wrong in practice. consecutiveLosses (below) was ONLY ever incremented by this
   * engine's own applyRealizedToLedger, itself fed exclusively by the legacy CG_*-variant-matrix
   * mirror pipeline this class drives — a pipeline that sits at 0% allocation weight today (retired,
   * superseded by RC/CE in July). The 3 lanes holding 100% of today's real money
   * (REGIME_COMPOSITE_CONFIRMATION_LONG, COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG,
   * COMPOSITE_ESTIMATOR_BIDI_FAST_LONG — all SingleSymbolLaneExecutor instances) never fed this
   * counter at all, so a real losing streak concentrated entirely in those lanes could never trip
   * this specific condition — only the two dollar-based conditions above would eventually catch it.
   * recordExternalConsecutiveLossOutcome() below closes that gap: app.ts wires it into EVERY
   * SingleSymbolLaneExecutor instance's onPositionClosed callback (all 9 lanes, not just the 3
   * currently allocated weight, so a future allocation change needs no further wiring here).
   */
  /** 2026-07-12 fix: getExternalRealizedPnlUsd() fans out to 11 separate executors' getStatus()
   *  calls with no guard of its own, unlike currentControllerSnapshot()/strategyEntryGate() which
   *  both fail closed. An exception thrown by any single external executor used to abort the
   *  ENTIRE tick() before reconcile()/manageLifecycle() even ran (not just the kill-switch check),
   *  turning one flaky lane's read into a skipped safety cycle for real open positions. Degrades
   *  to {today:0, allTime:0} on failure — excludes the unreachable external component for this one
   *  read rather than crashing; the engine-native ledger/drawdown checks still run correctly. */
  private safeExternalRealizedPnlUsd(): { today: number; allTime: number } {
    try {
      return this.getExternalRealizedPnlUsd();
    } catch {
      return { today: 0, allTime: 0 };
    }
  }

  /**
   * 2026-07-19 real-money audit follow-up (time-window bound): the single choke point every loss
   * increment must go through — recordExternalConsecutiveLossOutcome() and BOTH branches of
   * applyRealizedToLedger() (the known-net path and the net===null/UNKNOWN-outcome path) all call
   * this instead of doing `st.consecutiveLosses += 1` directly, so the window logic can never be
   * applied on some paths and forgotten on others (see consecutiveLossWindowHours's doc comment on
   * LiveExecutionConfig for the incident this fixes).
   *
   * Chains onto the existing streak only if a loss was already counted (lastLossAtMs set) AND the
   * gap since it is within config.consecutiveLossWindowHours; otherwise starts a fresh streak at 1.
   * Always stamps lastLossAtMs to now so the NEXT loss's gap is measured from THIS one, not the
   * streak's original start — i.e. this is a rolling "gap since last loss" window, not a fixed
   * calendar bucket, so a genuine tight cluster of losses spanning slightly more than one window's
   * width can still chain (each individual gap stays inside the window) while an isolated loss
   * days after the last one always starts over.
   */
  private noteConsecutiveLoss(st: LiveExecutionState): void {
    const nowMs = Date.parse(this.nowIso());
    const windowMs = Math.max(0, this.config.consecutiveLossWindowHours) * 60 * 60 * 1000;
    const withinWindow = st.lastLossAtMs != null && nowMs - st.lastLossAtMs <= windowMs;
    st.consecutiveLosses = withinWindow ? st.consecutiveLosses + 1 : 1;
    st.lastLossAtMs = nowMs;
  }

  private killSwitchTrip(): string | null {
    // Existing config fixtures and persisted callers predate this testnet-only option.
    // Only an explicit false disables automatic trips; missing remains safely enabled.
    if (this.config.autoKillSwitchEnabled === false) return null;
    const st = this.store.getState();
    if (st.killedAt) return null; // already engaged/latched
    this.rollDailyLedger();
    const external = this.safeExternalRealizedPnlUsd();
    const combinedTodayPnl = st.dailyLedger.realizedPnlUsd + external.today;
    if (combinedTodayPnl <= -this.config.dailyMaxLossUsd) {
      return (
        `daily max loss hit (${combinedTodayPnl.toFixed(2)} USD <= -${this.config.dailyMaxLossUsd}` +
        ` — engine=${st.dailyLedger.realizedPnlUsd.toFixed(2)} other-lanes=${external.today.toFixed(2)})`
      );
    }
    if (st.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      return (
        `max consecutive losses hit (${st.consecutiveLosses} within ` +
        `${this.config.consecutiveLossWindowHours}h of each other)`
      );
    }
    const combinedTotalPnl = st.totalRealizedPnlUsd + external.allTime;
    const combinedPeak = Math.max(st.combinedRealizedPeakUsd ?? st.realizedPeakUsd, combinedTotalPnl);
    if (combinedPeak > (st.combinedRealizedPeakUsd ?? -Infinity)) {
      st.combinedRealizedPeakUsd = combinedPeak;
      // 2026-07-12 fix: this mutation was never explicitly persisted — a "quiet" tick (nothing
      // else this tick calls store.save()) followed by a process restart would silently roll the
      // recorded historical peak back down, understating real drawdown on the very next tick.
      this.store.save();
    }
    const drawdown = combinedPeak - combinedTotalPnl;
    if (drawdown >= this.config.maxDrawdownUsd) {
      return (
        `max drawdown hit (${drawdown.toFixed(2)} USD from peak` +
        ` — engine=${st.totalRealizedPnlUsd.toFixed(2)} other-lanes=${external.allTime.toFixed(2)})`
      );
    }
    return null;
  }

  /**
   * 2026-07-19 real-money audit fix: killSwitchTrip's maxConsecutiveLosses condition (above) was fed
   * EXCLUSIVELY by this engine's own applyRealizedToLedger — itself only ever called from the legacy
   * CG_*-variant-matrix mirror pipeline this class drives, which sits at 0% allocation weight today
   * (retired, superseded by RC/CE in July). The 3 lanes holding 100% of today's real money
   * (REGIME_COMPOSITE_CONFIRMATION_LONG, COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG,
   * COMPOSITE_ESTIMATOR_BIDI_FAST_LONG — all SingleSymbolLaneExecutor instances) never fed this
   * counter at all, so a real losing streak concentrated entirely in those lanes could never trip
   * this specific condition — only the two dollar-based conditions above would eventually catch it.
   * app.ts wires this method into EVERY SingleSymbolLaneExecutor instance's onPositionClosed
   * callback (all 9 lanes — RC/RCS/CE-WIDE_LONG/CE-WIDE_SHORT/CE-FAST_LONG/CE-FAST_SHORT/SF/IM/PWR —
   * not just the 3 currently allocated weight, so a future allocation change needs no further wiring
   * here), giving every one of them a way to feed the SAME counter killSwitchTrip() already reads.
   *
   * Uses the IDENTICAL scratch/loss/win classification applyRealizedToLedger already uses for the
   * legacy mirror pipeline: a scratch (|net| < scratchEpsilonUsd) is neutral — neither increments
   * nor resets — a real loss increments, a win resets to 0. Deliberately does NOT touch
   * dailyLedger/totalRealizedPnlUsd/realizedPeakUsd/combinedRealizedPeakUsd — those dollar totals
   * already correctly aggregate every lane's real P&L via getExternalRealizedPnlUsd/
   * safeExternalRealizedPnlUsd (see killSwitchTrip's own doc comment above); folding them in here
   * too would double-count the exact same close into both the engine-native ledger and the external
   * sum.
   *
   * Unlike applyRealizedToLedger, this never needs to handle a null net: SingleSymbolLaneExecutor
   * never finalizes a position CLOSED with an unresolved P&L — its settlement paths retry next tick
   * rather than ever settling with a fabricated/unknown number — so its onPositionClosed callback
   * only ever fires with a real, confirmed number.
   */
  recordExternalConsecutiveLossOutcome(netUsd: number): void {
    const st = this.store.getState();
    const isScratch = Math.abs(netUsd) < this.config.scratchEpsilonUsd;
    if (isScratch) return;
    if (netUsd < 0) {
      this.noteConsecutiveLoss(st);
    } else {
      st.consecutiveLosses = 0;
      st.lastLossAtMs = null;
    }
    this.store.save();
  }

  /**
   * 2026-07-19 real-money audit fix (BUG 1): does the actual cancel/flatten/settle work for ONE
   * intent's kill-switch panic-close. Extracted out of engageKillSwitch's loop (unchanged logic)
   * so retryFailedKillFlattens() can reuse the EXACT same flatten path on a later tick instead of
   * a parallel, potentially-drifting reimplementation. Returns true only once the intent has been
   * fully settled and marked KILLED; false (with intent.lastError set) on ANY throw along the way
   * — the caller is responsible for tracking/clearing killSwitchFlattenFailedIntentIds.
   */
  private async attemptKillFlatten(intent: LiveIntent, killReason: string): Promise<boolean> {
    try {
      await this.client.cancelAllOrders(intent.symbol);
      await this.client.cancelAllAlgoOrders(intent.symbol);
      const positions = await this.client.getPositions(intent.symbol);
      const pos = positions.find((p) => p.symbol === intent.symbol);
      let flattenOrderId: string | null = null;
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
      // A kill-switch flatten is NEVER a win — book its realized P&L (almost always a loss,
      // since this only fires on a breaker tripping) so lane reports don't silently drop it
      // and resetKill()'s drawdown-peak rebase isn't understated right when it matters most.
      const settled = await this.settleIntentAfterClose(intent, [flattenOrderId]);
      const net = settled?.netUsd ?? null;
      intent.realizedPnlUsd = net;
      intent.feesUsd = settled?.feesUsd ?? null;
      intent.feeSource = settled?.feeSource ?? undefined;
      if (net === null) {
        intent.lastError = "kill flatten: P&L UNKNOWN — trades fetch failed; wallet-reconciliation will catch the true amount";
      }
      this.applyRealizedToLedger(net, "adverse");
      intent.state = "KILLED";
      intent.closeReason = `KILL_SWITCH: ${killReason}`;
      intent.closedAt = this.nowIso();
      this.stampExitControllerSnapshot(intent);
      intent.updatedAt = this.nowIso();
      return true;
    } catch (error) {
      intent.lastError = `kill flatten failed: ${(error as Error).message}`;
      // keep state — reconciliation surfaces any residue loudly, and (2026-07-19 fix)
      // killSwitchFlattenFailedIntentIds/getStatus()/the kill route now surface it too, plus
      // retryFailedKillFlattens() keeps retrying this exact intent on every subsequent tick.
      return false;
    }
  }

  /** Adds/removes a paperOrderId from the persisted kill-switch-flatten-failure set. Callers own
   *  calling store.save() (both engageKillSwitch's loop and retryFailedKillFlattens already save
   *  once after their own loop). */
  private recordKillFlattenFailure(paperOrderId: string): void {
    const st = this.store.getState();
    const set = new Set(st.killSwitchFlattenFailedIntentIds ?? []);
    set.add(paperOrderId);
    st.killSwitchFlattenFailedIntentIds = [...set];
  }

  private clearKillFlattenFailure(paperOrderId: string): void {
    const st = this.store.getState();
    if (!st.killSwitchFlattenFailedIntentIds || st.killSwitchFlattenFailedIntentIds.length === 0) return;
    st.killSwitchFlattenFailedIntentIds = st.killSwitchFlattenFailedIntentIds.filter((id) => id !== paperOrderId);
  }

  /**
   * 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): retries any kill-switch
   * flatten that previously threw on a transient Binance/network error, every tick, for as long as
   * it stays unresolved. Before this existed, killSwitchTrip()'s own "already engaged/latched"
   * short-circuit meant a flatten failure during the initial engageKillSwitch() call was NEVER
   * revisited automatically — that specific position stayed open on the exchange indefinitely,
   * with nothing in getStatus()/reconcile()/the kill route distinguishing it from a clean flatten.
   * A no-op (single state read) whenever the kill-switch isn't engaged or nothing is pending.
   */
  private async retryFailedKillFlattens(): Promise<void> {
    const st = this.store.getState();
    if (!st.killedAt) return;
    const pendingIds = st.killSwitchFlattenFailedIntentIds ?? [];
    if (pendingIds.length === 0) return;
    let dirty = false;
    for (const paperOrderId of pendingIds) {
      const intent = st.intents.find((i) => i.paperOrderId === paperOrderId);
      // Already resolved by a different path since the failure was recorded (e.g. an operator
      // manualCloseIntent(), or a prior retry that this loop hadn't yet persisted) — nothing left
      // to retry; drop the stale marker rather than retrying forever against a closed intent.
      if (!intent || !OPEN_INTENT_STATES.has(intent.state)) {
        this.clearKillFlattenFailure(paperOrderId);
        dirty = true;
        continue;
      }
      if (this.busyIntentIds.has(paperOrderId)) continue; // a concurrent close/kill owns it this tick
      this.busyIntentIds.add(paperOrderId);
      try {
        const ok = await this.attemptKillFlatten(intent, st.killReason ?? "kill-switch (retry)");
        if (ok) this.clearKillFlattenFailure(paperOrderId);
        dirty = true; // lastError/state mutated either way — persist it
      } finally {
        this.busyIntentIds.delete(paperOrderId);
      }
    }
    if (dirty) this.store.save();
  }

  private async engageKillSwitch(reason: string): Promise<void> {
    // 2026-07-11 real-money audit fix: tick()'s automatic trip and a manual kill() can arrive at
    // the same moment (neither is gated by `this.ticking`) — without this guard, two overlapping
    // invocations would each snapshot+flatten the same open intents and double-book realized P&L.
    if (this.killSwitchEngaging) return;
    this.killSwitchEngaging = true;
    try {
      const st = this.store.getState();
      this.armed = false;
      st.killedAt = this.nowIso();
      st.killReason = reason;

      // Cancel all engine orders + flatten engine positions, symbol by symbol.
      const openIntents = st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state));
      for (const intent of openIntents) {
        // A concurrent manualCloseIntent() may already be flattening/settling this exact intent —
        // skip it here rather than racing; either it finishes and this intent is no longer OPEN
        // next reconcile, or it fails and reconcile/lifecycle picks it back up next tick.
        if (this.busyIntentIds.has(intent.paperOrderId)) continue;
        this.busyIntentIds.add(intent.paperOrderId);
        try {
          const ok = await this.attemptKillFlatten(intent, reason);
          if (ok) this.clearKillFlattenFailure(intent.paperOrderId);
          else this.recordKillFlattenFailure(intent.paperOrderId);
        } finally {
          this.busyIntentIds.delete(intent.paperOrderId);
        }
      }
      this.store.save();
      // 2026-07-12 kill-switch RESPONSE fix (see LiveExecutionEngineOptions.onKillSwitchEngaged):
      // after the engine's own intents are flattened, ask every other executor to close its OWN
      // positions via its OWN orderly mechanics. Best-effort — a callback failure must never break
      // this engine's already-completed kill path (killedAt is latched above regardless).
      if (this.onKillSwitchEngaged) {
        try {
          await this.onKillSwitchEngaged(reason);
        } catch (error) {
          this.reconcileIssues.push(
            `kill-switch executor-close callback failed: ${(error as Error).message} — the other executors' positions may still be open; their own per-lane exits keep managing them`,
          );
        }
      }
    } finally {
      this.killSwitchEngaging = false;
    }
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
      // 2026-07-11 real-money audit fix: a concurrent manualCloseIntent()/engageKillSwitch() call
      // (dashboard action, not gated by `this.ticking`) can flatten this SAME intent mid-await
      // below; without this guard the stale getPositions snapshot would then see it flat and
      // settle it a SECOND time here — double-booking realized P&L into the kill-switch ledger.
      if (this.busyIntentIds.has(intent.paperOrderId)) continue;
      this.busyIntentIds.add(intent.paperOrderId);
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

        // Dense R-path tick (2026-07-22, report-only — see position-path-recorder.ts): sample this
        // OPEN intent's signed mark-R once per lifecycle tick so the Exit Brain shadow scorer can
        // walk REAL recorded paths instead of 4-point skeletons. Same currentR formula as
        // manageMfeGiveback below (which only runs for mfe_giveback-ruled intents — this hook
        // covers EVERY open intent). Wrapped inside; absent recorder = no-op, zero behavior change.
        this.recordPositionPathTick(intent, pos);

        // 2026-07-19 real-money audit fix (BUG 3): the resting protective stop can be GONE
        // (triggered-and-partially-filled under thin liquidity, or cancelled/expired without ever
        // triggering) while the engine share is still nonzero — see
        // reestablishStopForResidualIfNaked's doc comment for why nothing else in this loop would
        // otherwise notice a naked residual position.
        const restop = await this.reestablishStopForResidualIfNaked(intent, amt);
        if (restop.changed) dirty = true;

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
          ((this.config.forceMfeGiveback && !this.intentSources(intent).some((source) => isProfitCoreShortLaneId(source.laneId))) ||
            this.intentExitRule(intent) === "mfe_giveback")
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
              const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
              const net = settled?.netUsd ?? null;
              intent.realizedPnlUsd = net;
              intent.feesUsd = settled?.feesUsd ?? null;
              intent.feeSource = settled?.feeSource ?? undefined;
              intent.state = "CLOSED";
              intent.closedAt = this.nowIso();
              this.stampExitControllerSnapshot(intent);
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
      } finally {
        this.busyIntentIds.delete(intent.paperOrderId);
      }
    }
    if (dirty) this.store.save();
  }

  /**
   * 2026-07-19 real-money audit fix (BUG 3, MEDIUM): a protective STOP_MARKET can fill PARTIALLY
   * under thin liquidity — Binance futures STOP_MARKET/market orders are effectively IOC once
   * triggered, so an unfilled remainder does not keep resting, it simply expires. Before this
   * existed, the intent's active stop reference (stopOrderId pre-TP1, beStopOrderId once the
   * runner is on breakeven) then pointed at a dead, no-longer-protecting order while `amt` (the
   * engine's own remaining share, computed by the caller) was still nonzero — the residual
   * quantity stayed completely naked until the position eventually hit some OTHER exit path (if
   * any). Detects exactly that — the active stop is gone from the book (whether it triggered and
   * only partially filled, or was cancelled/expired without ever triggering — both leave the same
   * naked residual) — and immediately re-establishes protection for whatever quantity is left,
   * reusing the same STOP_MARKET placement shape every other stop in this class uses.
   *
   * Fail-safe like settleIfStopTriggered's sibling logic in single-symbol-lane-executor.ts: any
   * query failure or ambiguous/unrecognized status is treated as "still resting" and retried next
   * tick, never acted on speculatively.
   */
  private async reestablishStopForResidualIfNaked(intent: LiveIntent, amt: number): Promise<{ changed: boolean }> {
    if (Math.abs(amt) < 1e-12) return { changed: false };
    const activeStopId = intent.state === "TP1_FILLED_BE_SET" ? intent.beStopOrderId : intent.stopOrderId;
    if (activeStopId === null) return { changed: false };

    let algoStatus = "";
    let actualOrderId: string | null = null;
    try {
      const algo = await this.client.queryAlgoOrder(activeStopId);
      algoStatus = algo.algoStatus;
      actualOrderId = algo.actualOrderId;
    } catch {
      return { changed: false }; // best-effort — retry next tick rather than act on an unconfirmed read
    }

    let stopIsGone: boolean;
    if (actualOrderId === null) {
      // Never triggered. Only a recognized terminal-without-trigger status means it is genuinely
      // gone from the book; NEW/WORKING/unrecognized/empty is treated as still resting.
      const s = algoStatus.trim().toUpperCase();
      stopIsGone = s === "CANCELED" || s === "CANCELLED" || s === "EXPIRED" || s === "REJECTED";
    } else {
      // Triggered — done executing (no more fills coming) is what "no longer protecting" means
      // here, regardless of whether it closed the full quantity or only part of it.
      try {
        const actual = await this.client.queryOrder(intent.symbol, actualOrderId);
        stopIsGone = actual.status !== "NEW" && actual.status !== "PARTIALLY_FILLED";
      } catch {
        return { changed: false }; // retry next tick
      }
    }
    if (!stopIsGone) return { changed: false };

    try {
      const fresh = await this.client.placeAlgoOrder({
        symbol: intent.symbol,
        side: intent.direction === "LONG" ? "SELL" : "BUY",
        type: "STOP_MARKET",
        quantity: Math.abs(amt),
        triggerPrice:
          intent.state === "TP1_FILLED_BE_SET" ? intent.filledEntryPrice ?? intent.plannedEntryPrice : intent.stopLossPrice,
        reduceOnly: true,
        workingType: "CONTRACT_PRICE",
        clientAlgoId: `dtc-${intent.paperOrderId.slice(-14)}-rs${this.nowIso().replace(/[^0-9]/g, "").slice(-8)}`,
      });
      if (intent.state === "TP1_FILLED_BE_SET") intent.beStopOrderId = fresh.algoId;
      else intent.stopOrderId = fresh.algoId;
      intent.lastError = null;
      intent.updatedAt = this.nowIso();
      return { changed: true };
    } catch (error) {
      // 2026-07-19 real-money audit follow-up: a plain retry-next-tick here re-submits a fresh
      // conditional order at the EXACT SAME trigger price that just fired — by construction of
      // this function (a stop that just triggered/expired), price has already crossed that
      // level, so Binance's -2021 ("would immediately trigger") is very likely to reject that
      // same order again on every subsequent tick, forever, leaving the residual genuinely naked
      // with no automatic resolution — this codebase has already been burned by exactly this
      // failure class (a documented incident: a stop landed on the wrong side of the actual fill,
      // churning 258x and costing ~$865). Mirror the sibling TP1→breakeven stop-placement
      // fallback a few lines above: on -2021 specifically, fall back to an immediate reduceOnly
      // MARKET close of the residual instead of retrying an order that cannot succeed.
      if (error instanceof BinanceFuturesPrivateError && error.binanceCode === -2021) {
        try {
          const flat = await this.client.placeOrder({
            symbol: intent.symbol,
            side: intent.direction === "LONG" ? "SELL" : "BUY",
            type: "MARKET",
            quantity: Math.abs(amt),
            reduceOnly: true,
            newClientOrderId: `dtc-${intent.paperOrderId.slice(-14)}-rsx${this.nowIso().replace(/[^0-9]/g, "").slice(-8)}`,
          });
          try {
            await this.client.cancelAllOrders(intent.symbol);
            await this.client.cancelAllAlgoOrders(intent.symbol);
          } catch {
            // best-effort cleanup after the residual is already closed.
          }
          const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
          const net = settled?.netUsd ?? null;
          intent.realizedPnlUsd = net;
          intent.feesUsd = settled?.feesUsd ?? null;
          intent.feeSource = settled?.feeSource ?? undefined;
          intent.state = "CLOSED";
          intent.closedAt = this.nowIso();
          this.stampExitControllerSnapshot(intent);
          intent.updatedAt = this.nowIso();
          intent.closeReason = "RESIDUAL_STOP_REESTABLISH_2021_FALLBACK_MARKET_CLOSE";
          intent.lastError = null;
          this.applyRealizedToLedger(net);
          return { changed: true };
        } catch (marketCloseError) {
          intent.lastError =
            `residual stop re-establish hit -2021 AND the immediate market-close fallback ALSO failed for ` +
            `${intent.symbol} (${intent.paperOrderId}): ${(marketCloseError as Error).message} — position is ` +
            `PARTIALLY UNPROTECTED, retrying next tick`;
          intent.updatedAt = this.nowIso();
          return { changed: true };
        }
      }
      intent.lastError =
        `residual stop re-establish failed for ${intent.symbol} (${intent.paperOrderId}) after the ` +
        `original stop partially filled/expired: ${(error as Error).message} — position is PARTIALLY ` +
        `UNPROTECTED, retrying next tick`;
      intent.updatedAt = this.nowIso();
      return { changed: true };
    }
  }

  private intentHasLiveBreakevenExitLane(intent: LiveIntent): boolean {
    return this.intentSources(intent).some((source) => {
      const laneId = source.laneId ?? "";
      const variantId = laneId.split(":").pop() ?? laneId;
      if (!LIVE_BREAKEVEN_EXIT_LANE_IDS.has(laneId) && !LIVE_BREAKEVEN_EXIT_LANE_IDS.has(variantId)) return false;
      // 2026-07-26 (see the block comment on LIVE_BREAKEVEN_EXIT_LANE_IDS): the sweep is an
      // ORPHAN-ESCAPE hatch, so it may only fire for a lane this instance genuinely does not fund.
      // The moment the operator funds the lane again, its positions own real geometry and must be
      // allowed to reach it. rawLaneAllocationWeightPctForLane is deliberate over the CORTEX-aware
      // accessor: this asks "did the OPERATOR de-allocate it", which a promoted tilt must not
      // answer. It returns 100 when allocations are off entirely (every lane funded → sweep off)
      // and 0 when the table is present but omits the lane (→ sweep armed, today's live case).
      return this.rawLaneAllocationWeightPctForLane(laneId) <= 0;
    });
  }

  /** True when this intent belongs to the pure-geometry cohort (see pureGeometryLaneIds): every
   *  engine overlay must skip it and leave the position to its own declared TP/stop. Matched on the
   *  full laneId or its variant suffix, mirroring intentHasLiveBreakevenExitLane. Deliberately does
   *  NOT require the lane to be de-allocated — unlike the orphan-escape sweep, this cohort is about
   *  a FUNDED lane being allowed to demonstrate its own geometry. */
  private isPureGeometryIntent(intent: LiveIntent): boolean {
    const ids = pureGeometryLaneIds();
    if (ids.size === 0) return false;
    return this.intentSources(intent).some((source) => {
      const laneId = source.laneId ?? "";
      const variantId = laneId.split(":").pop() ?? laneId;
      return ids.has(laneId) || ids.has(variantId);
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
    if (this.isPureGeometryIntent(intent)) return { changed: false, closed: false }; // pure-geometry cohort: own stop/TP only
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
    const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
    const net = settled?.netUsd ?? null;
    intent.realizedPnlUsd = net;
    intent.feesUsd = settled?.feesUsd ?? null;
    intent.feeSource = settled?.feeSource ?? undefined;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    this.stampExitControllerSnapshot(intent);
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

  private correlatedAltOpenSymbols(
    intents: LiveIntent[],
    externalManagedNetQty: ReadonlyMap<string, number> = new Map(),
  ): Record<"LONG" | "SHORT", Set<string>> {
    const symbols: Record<"LONG" | "SHORT", Set<string>> = {
      LONG: new Set(),
      SHORT: new Set(),
    };
    for (const intent of intents) {
      if (!OPEN_INTENT_STATES.has(intent.state)) continue;
      if (!this.isCorrelatedAltSymbol(intent.symbol)) continue;
      symbols[intent.direction].add(intent.symbol);
    }
    for (const [symbol, netQty] of externalManagedNetQty) {
      if (!this.isCorrelatedAltSymbol(symbol) || !Number.isFinite(netQty) || Math.abs(netQty) <= 1e-12) continue;
      symbols[netQty > 0 ? "LONG" : "SHORT"].add(symbol.toUpperCase());
    }
    return symbols;
  }

  private maxAggregateIntentRiskUsd(): number {
    return Math.max(0, this.config.maxAggregateIntentRiskUsd);
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
   *
   *  2026-07-12 (Stage 4): when LIVE_PROFIT_BANK_MODE === "R_BASED" (opt-in, default FLAT), the
   *  target scales to profitBankTargetR × the position's OWN effective risk-at-stop (`intentRiskUsd`,
   *  the real per-trade R that the notional cap may have clipped below nominal), so a bigger-risk
   *  position banks proportionally later instead of at a flat $ that truncates its right tail.
   *  Absent the effective risk (older intent / not supplied), falls back to nominal riskUsdPerTrade.
   *
   *  FLAT mode (default) is the historical behavior unchanged: profitBankNetTargetUsd (flat $) takes
   *  priority; else testnet absolute USD; else mainnet mainnetTpR × riskUsdPerTrade. */
  private profitBankThresholdUsd(intentRiskUsd?: number | null): number {
    if (this.config.profitBankMode === "R_BASED" && this.config.profitBankTargetR > 0) {
      const riskUsd = typeof intentRiskUsd === "number" && intentRiskUsd > 0 ? intentRiskUsd : this.config.riskUsdPerTrade;
      if (riskUsd > 0) return this.config.profitBankTargetR * riskUsd;
    }
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
      // Pure-geometry cohort: the regime overlays (REGIME_OPPOSITION_* / REGIME_CHANGE_HARVEST_*)
      // are the two that had no per-lane scope at all before 2026-07-27, and together they produced
      // 41% of this instance's closes. Skipping them here is what actually lets a listed lane reach
      // its own stop/TP. Both hard cuts live inside this loop too, which means a cohort lane keeps
      // NO regime protection at all — deliberate, and the reason this is a named opt-in set.
      if (this.isPureGeometryIntent(intent)) continue;
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

      // 2026-07-26 measured exit-policy change (see OPPOSITION_BREAKEVEN_DEFER_MS). A GREEN
      // counter-regime position with no controller flip is EXACTLY the population that used to
      // close as REGIME_OPPOSITION_BREAKEVEN_* — and harvesting it there is what cost money.
      // Testnet's own ledger, 38 such closes: +$4.35 realized, versus +$50.6 for letting the same
      // 38 run to their original stop/TP (forward 15m candles from each actual close). Live's
      // independent sample agreed in sign. So: leave it on its own geometry, but bound the wait so
      // a counter-regime position can never sit open indefinitely.
      //
      // Note this branch is reachable with hardCutThis/lossHardCutThis true — a green position
      // inside the hard-cut window was ALREADY labelled ..._BREAKEVEN_* rather than ..._HARD_CUT_*
      // by the closeReason ternary below, so it is part of the measured population and defers too.
      // The hard cuts themselves are untouched: they decide RED positions, which returned above,
      // and the same study confirmed they stay protective (328 hard-cut closes were $182 BETTER
      // cut than held). REGIME_CHANGE_HARVEST_* is likewise untouched — controllerChanged short-
      // circuits this whole block, and all five of its buckets were already net-positive.
      if (green && !controllerChanged) {
        if (!intent.oppositionBreakevenDeferredAt) {
          intent.oppositionBreakevenDeferredAt = this.nowIso();
          intent.updatedAt = this.nowIso();
          dirty = true;
        }
        const deferredSinceMs = new Date(intent.oppositionBreakevenDeferredAt).getTime();
        // An unparseable stamp must not strand the position forever — treat it as "backstop
        // already elapsed" and harvest on this tick, i.e. fail back to the old behavior.
        if (Number.isFinite(deferredSinceMs)) {
          const heldForMs = new Date(this.nowIso()).getTime() - deferredSinceMs;
          if (heldForMs < OPPOSITION_BREAKEVEN_DEFER_MS) continue;
        }
      }

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
      const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
      const net = settled?.netUsd ?? null;
      intent.realizedPnlUsd = net;
      intent.feesUsd = settled?.feesUsd ?? null;
      intent.feeSource = settled?.feeSource ?? undefined;
      intent.state = "CLOSED";
      intent.closedAt = this.nowIso();
      this.stampExitControllerSnapshot(intent);
      intent.updatedAt = this.nowIso();
      intent.closeReason = !green
        ? (lossHardCutThis
            ? `REGIME_OPPOSITION_LOSS_HARD_CUT_${currentMode ?? "UNKNOWN"}_${Math.round(this.config.regimeLossHardCutStopFraction * 100)}PCT_STOP`
            : `REGIME_OPPOSITION_HARD_CUT_${currentMode ?? "UNKNOWN"}`)
        : controllerChanged
          ? `REGIME_CHANGE_HARVEST_${previousMode ?? previousRegime ?? "UNKNOWN"}_TO_${currentMode ?? currentRegime ?? "UNKNOWN"}`
          // 2026-07-26: distinct from the old REGIME_OPPOSITION_BREAKEVEN_* label on purpose. The
          // only way to reach here now is with the deferral backstop already elapsed, so the two
          // are different populations and must never be pooled when this change is evaluated.
          : `REGIME_OPPOSITION_BREAKEVEN_DEFERRED_${Math.round(OPPOSITION_BREAKEVEN_DEFER_MS / HOUR_MS)}H_${currentMode ?? "UNKNOWN"}`;
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
      // Flips OPEN new exposure only when every new-entry gate passes. Risk-reducing flattens above
      // remain active during drain/NO_TRADE/disarm.
      if (this.canOpenNewEntries()) {
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
    const liveLegSettled = await this.settleIntentAfterClose(rescueIntent, [flat.orderId]);
    const liveLegRealized = liveLegSettled?.netUsd ?? null;
    rescueIntent.realizedPnlUsd = liveLegRealized;
    rescueIntent.feesUsd = liveLegSettled?.feesUsd ?? null;
    rescueIntent.feeSource = liveLegSettled?.feeSource ?? undefined;
    rescueIntent.state = "CLOSED";
    rescueIntent.closedAt = this.nowIso();
    this.stampExitControllerSnapshot(rescueIntent);
    rescueIntent.updatedAt = this.nowIso();
    rescueIntent.closeReason = action.reason.startsWith("max-hold") ? "RESCUE_MAXHOLD_CUT" : "RESCUE_FLATTEN_TARGET";
    this.applyRealizedToLedger(liveLegRealized);
  }

  /** Place the cross-zero flip order, settle+close the stuck opposing intents (booking their realized
   *  loss), and register the resulting net leg as a dedicated rescue intent so reconcile stays sane. */
  private async executeRescueFlip(action: RescueFlipAction, opposingIntents: LiveIntent[]): Promise<void> {
    if (!this.canOpenNewEntries()) return;
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
    //
    // 2026-07-19 real-money audit fix (BUG 2, MEDIUM): settleIntentAfterClose sums ALL trades
    // matching the SAME flip.orderId since an intent's createdAt — with 2+ opposing intents on the
    // same symbol, calling it once PER intent returned the IDENTICAL total flip P&L every time
    // (there is only ever ONE real close), and the old code then called applyRealizedToLedger(r)
    // once per intent too — double-(or N-times-)booking a SINGLE real fill's P&L into
    // totalRealizedPnlUsd/dailyLedger/consecutive-loss. Settle the flip's real P&L EXACTLY ONCE
    // (anchored on the earliest-opened opposing intent, so the trade-search window safely covers
    // every opposing intent's history), then attribute it to each intent proportionally by its own
    // qty share for display/rescuePriorRealizedUsd — the shares sum back to the one real amount,
    // and the ledger only ever sees it once.
    const anchorIntent = opposingIntents.reduce(
      (earliest, i) => (i.createdAt < earliest.createdAt ? i : earliest),
      opposingIntents[0]!,
    );
    // RECORDING-ONLY: suppress the per-fill record when this ONE settlement resolves more than one
    // opposing intent — see settleIntentAfterClose's `recordFills` parameter for why a single
    // anchor-keyed record carrying the whole flip qty would be confidently wrong (2026-07-27
    // review). With exactly one opposing intent the record is exact and is written normally.
    const flipSettled = await this.settleIntentAfterClose(
      anchorIntent,
      [flip.orderId],
      opposingIntents.length === 1,
    );
    const flipNet = flipSettled?.netUsd ?? null;
    const flipFees = flipSettled?.feesUsd ?? null;
    const totalOpposingQty = opposingIntents.reduce((sum, i) => sum + Math.abs(i.qty), 0);
    let priorRealized = 0;
    for (const oi of opposingIntents) {
      const share = totalOpposingQty > 1e-12 ? Math.abs(oi.qty) / totalOpposingQty : 1 / opposingIntents.length;
      const oiNet = flipNet === null ? null : flipNet * share;
      if (oiNet === null) {
        oi.lastError = "rescue flip: P&L UNKNOWN — trades fetch failed; wallet-reconciliation will catch the true amount";
      } else {
        priorRealized += oiNet;
      }
      oi.realizedPnlUsd = oiNet;
      oi.feesUsd = flipFees === null ? null : flipFees * share;
      // NOT "EXCHANGE". `flipFees` is one real, exchange-measured total for the single flip fill;
      // what lands on THIS intent is that total × its qty share — a modelled slice of a measured
      // number. The shares sum back to the real amount, so an aggregate over all N is exchange-true,
      // but no individual row here was ever observed at this granularity. See LiveIntent.feeSource.
      oi.feeSource = flipSettled?.feeSource === "EXCHANGE" ? "EXCHANGE_APPORTIONED" : undefined;
      oi.state = "CLOSED";
      oi.closedAt = this.nowIso();
      this.stampExitControllerSnapshot(oi);
      oi.updatedAt = this.nowIso();
      oi.closeReason = "RESCUE_FLIP";
    }
    // Book the ONE real P&L outcome exactly once, regardless of how many opposing intents it
    // resolved (see doc comment above) — this is the fix: previously this ran once per intent.
    this.applyRealizedToLedger(flipNet);
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
    if (this.isPureGeometryIntent(intent)) return { changed: false, closed: false }; // pure-geometry cohort: own stop/TP only
    // R_BASED mode scales the bank to THIS position's own effective risk-at-stop; FLAT ignores it.
    const threshold = this.profitBankThresholdUsd(intent.effectiveRiskUsd ?? null);
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
    const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
    const net = settled?.netUsd ?? null;
    intent.realizedPnlUsd = net;
    intent.feesUsd = settled?.feesUsd ?? null;
    intent.feeSource = settled?.feeSource ?? undefined;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    this.stampExitControllerSnapshot(intent);
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
    // MAE persistence (Tier 2 audit): running worst (most negative) favorableR, mirroring the peak
    // update above exactly — same tick hook, same intents, same "only update if this tick is worse
    // than the stored value" style. Purely additive: never read by the exit/close decision below.
    const previousTrough = intent.maxAdverseR ?? 0;
    const trough = Math.min(previousTrough, favorableR);
    const changed = peak !== previousPeak || trough !== previousTrough;
    intent.maxFavorableR = peak;
    intent.maxAdverseR = trough;
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
    const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
    const net = settled?.netUsd ?? null;
    intent.realizedPnlUsd = net;
    intent.feesUsd = settled?.feesUsd ?? null;
    intent.feeSource = settled?.feeSource ?? undefined;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    this.stampExitControllerSnapshot(intent);
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
    if (this.isPureGeometryIntent(intent)) return { changed: false, closed: false }; // pure-geometry cohort: own stop/TP only
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
    const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
    const net = settled?.netUsd ?? null;
    intent.realizedPnlUsd = net;
    intent.feesUsd = settled?.feesUsd ?? null;
    intent.feeSource = settled?.feeSource ?? undefined;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    this.stampExitControllerSnapshot(intent);
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
    let net: number | null = null;
    let fees: number | null = null;
    // Provenance of `fees` (2026-07-26, recording-only — see LiveIntent.feeSource). Stays undefined
    // on every abandonment path below: the algo-query escalation, a close that never became visible,
    // and the outer catch all leave `fees` null, and a settlement that matched no rows leaves it 0.
    // None of those is a measurement.
    let feeSource: "EXCHANGE" | undefined;
    try {
      const triggeredAlgoOrderIds: string[] = [];
      let algoQueryFailed = false;
      for (const algoId of [intent.stopOrderId, intent.beStopOrderId]) {
        if (algoId === null) continue;
        try {
          const algo = await this.client.queryAlgoOrder(algoId);
          if (algo.actualOrderId !== null) triggeredAlgoOrderIds.push(algo.actualOrderId);
        } catch {
          // 2026-07-11 real-money audit fix: this used to be silently swallowed, leaving
          // triggeredAlgoOrderIds empty as if the stop/breakeven never fired. The trade sum below
          // would then find ZERO matching trades for a real stop-out and book net=0 — read as a
          // harmless scratch, hiding the actual loss. Escalate to an UNKNOWN settlement instead of
          // guessing: a stale/incomplete ourOrderIds set can only UNDER-count real closing trades.
          algoQueryFailed = true;
        }
      }
      if (algoQueryFailed) {
        intent.lastError = "settle: stop/breakeven order query failed — its real closing trade may be missing from this settlement; PnL left UNKNOWN, check manually";
      } else {
        const requiredCloseOrderIds = triggeredAlgoOrderIds.length > 0
          ? triggeredAlgoOrderIds
          : [intent.tp1OrderId];
        const settled = await this.realizedFromTrades(
          intent.symbol,
          intent.createdAt,
          this.intentSettlementOrderIds(intent, triggeredAlgoOrderIds),
          {
            requiredOrderIds: [intent.entryOrderId, ...(intent.entryOrderIds ?? []), ...requiredCloseOrderIds],
            fillRecord: this.fillRecordContextForIntent(intent),
            entryOrderId: intent.entryOrderId,
          },
        );
        if (settled === null) {
          intent.lastError = "settle: closing trade not visible after retries — P&L left UNKNOWN; wallet reconciliation will catch the true amount";
        } else {
          net = settled.netUsd;
          fees = settled.feesUsd;
          feeSource = settled.feeSource ?? undefined;
          this.applySettlementMetadata(intent, settled);
        }
      }
    } catch (error) {
      intent.lastError = `settle: trades fetch failed (${(error as Error).message}) — PnL UNKNOWN, check manually`;
    }

    intent.realizedPnlUsd = net;
    intent.feesUsd = fees;
    intent.feeSource = feeSource;
    intent.state = "CLOSED";
    intent.closedAt = this.nowIso();
    this.stampExitControllerSnapshot(intent);
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
  private applyRealizedToLedger(net: number | null, classification: "auto" | "adverse" = "auto"): void {
    const st = this.store.getState();
    this.rollDailyLedger();
    if (net === null) {
      // 2026-07-11 real-money audit fix: a real close whose trades fetch failed has a GENUINELY
      // UNKNOWN dollar P&L. The old code fabricated 0 here, which then read as a harmless scratch
      // (|0| < scratchEpsilonUsd) — silently hiding a possibly real loss from the daily-loss,
      // consecutive-loss, and drawdown kill-switches. Don't touch the dollar totals (wallet-
      // reconciliation's ledger-vs-Binance-income check is the safety net for the true number),
      // but DO count the loss-streak conservatively — an unknown outcome must never look neutral.
      st.dailyLedger.losses += 1;
      this.noteConsecutiveLoss(st);
      return;
    }
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
        this.noteConsecutiveLoss(st);
      } else {
        st.dailyLedger.wins += 1;
        st.consecutiveLosses = 0;
        st.lastLossAtMs = null;
      }
    }
    st.totalRealizedPnlUsd += net;
    if (st.totalRealizedPnlUsd > st.realizedPeakUsd) st.realizedPeakUsd = st.totalRealizedPnlUsd;
  }

  /** Sum realized PnL net of fees for the given order ids on a symbol since an ISO time. Returns
   *  `null` (not a fabricated 0) when the trades fetch itself fails — 2026-07-11 real-money audit
   *  fix: a silent 0 here used to read as a harmless scratch and hide a real loss from the
   *  kill-switch; every call site must treat null as "P&L unknown", never as "$0".
   *
   *  2026-07-12 fee-recording fix: this always fetched the real commissions (net = realizedPnl −
   *  commission) but THREW THE FEE SUM AWAY, so 132 of the first 154 closed intents carried
   *  feesUsd=null and every fee report coerced them to $0 — while the exchange-true commission bill
   *  (-$15.59, 68.7% of the all-time loss) stayed invisible per-trade. Now returns both numbers so
   *  every close path records the commissions it already paid for the fetch of. Also bumped the
   *  page limit 200→1000 to match settleIfStopTriggered's earlier fix (#112 rationale).
   *
   *  2026-07-26 fee-PROVENANCE addition: also returns `feeSource` (see SettledFromTrades) so a
   *  caller can tell a MEASURED commission from a structural zero. `feesUsd: 0` is returned by two
   *  paths that never saw a commission row at all — the `ids.size === 0` short-circuit (no order
   *  ids to look up, so the exchange is never even queried) and a query that matched no rows of
   *  ours — and until now those were indistinguishable from a genuine $0 fee. Purely additive: not
   *  one arithmetic result or control-flow decision below depends on the new field. */
  private async realizedFromTrades(
    symbol: string,
    sinceIso: string,
    orderIds: Array<string | null>,
    opts: {
      /** A just-placed close can be eventually consistent in /userTrades. Never settle until
       *  these order ids are visible, otherwise entry commission alone looks like a realized loss. */
      requiredOrderIds?: Array<string | null>;
      retries?: number;
      retryDelayMs?: number;
      /** RECORDING-ONLY (2026-07-27). Present ⇒ persist the rows this settlement matched to the
       *  per-fill recorder (see executionFillRecorder). Absent ⇒ nothing is recorded and this
       *  method is byte-for-byte its old self. It is passed in rather than derived here because
       *  this method is deliberately intent-agnostic (symbol + order ids only); `entryOrderIds` is
       *  what lets a matched row be labelled ENTRY vs EXIT, which is the caller's knowledge, not
       *  this method's. NOTHING in the returned value depends on it. */
      fillRecord?: { recordId: string; laneId: string; entryOrderIds: Array<string | null> };
      /** 2026-07-30 (additive). The intent's SINGULAR, immutable entry order id (never the
       *  entryOrderIds array, which also absorbs pyramid adds — see LiveIntent.entryOrderIds' own
       *  doc note). Used ONLY to isolate entryFills below; independent of fillRecord so the original
       *  entry's confirmed-fill identity is always captured, even when no fill recorder is injected. */
      entryOrderId?: string | null;
    } = {},
  ): Promise<SettledFromTrades | null> {
    const ids = new Set(orderIds.filter((id): id is string => typeof id === "string"));
    // No order ids to look up: the exchange is never queried, so this zero is a STRUCTURAL zero and
    // feeSource stays null. Labelling it "EXCHANGE" would fabricate a measurement out of a
    // short-circuit — precisely the ambiguity this field was added to remove.
    if (ids.size === 0) {
      return {
        netUsd: 0, feesUsd: 0, feeSource: null,
        settlementFetchComplete: false, requiredOrderIds: [], matchedRequiredOrderIds: [], missingRequiredOrderIds: [], pageSaturated: false,
        entryFills: [],
      };
    }
    const required = new Set(
      (opts.requiredOrderIds ?? []).filter((id): id is string => typeof id === "string"),
    );
    const retries = Math.max(0, Math.floor(opts.retries ?? (required.size > 0 ? 6 : 0)));
    const retryDelayMs = Math.max(0, opts.retryDelayMs ?? this.fillConfirmRetryDelayMs);
    let lastIncomplete: SettledFromTrades | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const coverage = await collectUserTradesSettlementCoverage(
          this.client,
          symbol,
          new Date(sinceIso).getTime(),
          [...required],
        );
        const trades = coverage.trades;
        const matchedTrades = trades.filter((trade) => ids.has(trade.orderId));
        if (!coverage.settlementFetchComplete && attempt < retries) {
          // A just-filled order can lag /userTrades. Retry the bounded collector, but retain the
          // final partial result so the lifecycle can close diagnostic-only instead of hanging.
        } else {
          let net = 0;
          let fees = 0;
          // Provenance counter (2026-07-26, recording-only): counts the rows that actually
          // contributed to `fees`. NOT the same as matchedTrades.length in principle — the
          // `ids.has()` re-check below is the authority on what was summed — and NOT the same as
          // "fees > 0" either, since a real commission row can legitimately be 0 (a maker rebate,
          // or a rounded-to-zero dust fill). Only a counted ROW proves an exchange measurement.
          let feeRows = 0;
          for (const t of matchedTrades) {
            if (ids.has(t.orderId)) {
              net += t.realizedPnl - t.commission;
              fees += t.commission;
              feeRows += 1;
            }
          }
          // Exact confirmed-fill identity for the ORIGINAL entry order only (2026-07-30). Matched by
          // the SINGULAR opts.entryOrderId, never the entryOrderIds array — that array also absorbs
          // pyramid adds (see LiveIntent.entryOrderIds' own doc note), and a pyramid-add fill must
          // never be attributed to the original Entry decision. Each row comes straight from a real
          // /userTrades record with its own executedQty (t.qty) — never inferred from an
          // acknowledgment-only order id, and never gated on entryPriceConfirmed alone.
          const entryFills: ExecutionFill[] = opts.entryOrderId
            ? matchedTrades.filter((t) => t.orderId === opts.entryOrderId).map((t) => fillFromUserTrade(t, "ENTRY"))
            : [];
          // Per-fill execution record (2026-07-27, report-only, fail-safe — see its doc comment).
          // Placed AFTER the sum and immediately before the return so it cannot affect either: the
          // rows are the same `matchedTrades` this loop just walked, no extra fetch, and the whole
          // call is wrapped. `fetchComplete` is NOT unconditionally true (2026-07-27 review): a
          // failed or never-close-visible fetch never reaches here, but a SATURATED page can — a
          // long-lived intent on a symbol the account traded >1000 times since createdAt can lose
          // its ENTRY row off the page edge and leave an exit-only record that reads as whole.
          //
          // DOUBLE-WRAPPED ON PURPOSE. recordIntentFills is itself fully try/caught, but this call
          // sits INSIDE the enclosing `try` whose `catch` treats a throw as "the trades fetch
          // failed" — i.e. a bookkeeping exception leaking out of it would turn a successful
          // settlement into a retry and then a null P&L, which is a real trading consequence. The
          // redundant local catch makes that structurally impossible even if a future edit removes
          // the inner one.
          try {
            this.recordIntentFills(opts.fillRecord, symbol, matchedTrades, coverage.settlementFetchComplete);
          } catch {
            // report-only bookkeeping — never allowed to reach the enclosing settlement catch
          }
          const settled = {
            netUsd: net,
            feesUsd: fees,
            feeSource: feeRows > 0 ? "EXCHANGE" as const : null,
            settlementFetchComplete: coverage.settlementFetchComplete,
            requiredOrderIds: coverage.requiredOrderIds,
            matchedRequiredOrderIds: coverage.matchedRequiredOrderIds,
            missingRequiredOrderIds: coverage.missingRequiredOrderIds,
            pageSaturated: coverage.pageSaturated,
            entryFills,
          };
          if (coverage.settlementFetchComplete) return settled;
          lastIncomplete = settled;
        }
      } catch {
        if (attempt === retries) return null;
      }
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return lastIncomplete;
  }

  private intentSettlementOrderIds(intent: LiveIntent, extra: Array<string | null> = []): Array<string | null> {
    return [
      intent.entryOrderId,
      ...(intent.entryOrderIds ?? []),
      intent.tp1OrderId,
      ...extra,
    ];
  }

  private applySettlementMetadata(intent: LiveIntent, settled: SettledFromTrades | null): void {
    if (!settled) {
      intent.settlementFetchComplete = false;
      intent.requiredOrderIds = [];
      intent.matchedRequiredOrderIds = [];
      intent.missingRequiredOrderIds = [];
      intent.pageSaturated = false;
      intent.confirmedEntryFills = [];
      return;
    }
    intent.settlementFetchComplete = settled.settlementFetchComplete;
    intent.requiredOrderIds = settled.requiredOrderIds.slice();
    intent.matchedRequiredOrderIds = settled.matchedRequiredOrderIds.slice();
    intent.missingRequiredOrderIds = settled.missingRequiredOrderIds.slice();
    intent.pageSaturated = settled.pageSaturated;
    // 2026-07-30: real exchange fill rows for the ORIGINAL entry order only (never pyramid adds —
    // see realizedFromTrades' own doc note). Persisted verbatim so identity is never re-derived from
    // the acknowledged entryOrderId/entryOrderIds arrays downstream.
    intent.confirmedEntryFills = settled.entryFills.slice();
    if (settled.settlementFetchComplete) intent.settlementResolvedAt = this.nowIso();
  }

  /** Per-fill recorder context for one intent (2026-07-27, report-only). Pure field reads — no I/O,
   *  no clock, nothing that can throw meaningfully — but wrapped anyway so a malformed intent can
   *  never reach a settlement call site. Returns undefined when no recorder is injected, which
   *  makes realizedFromTrades' recording branch a no-op. */
  private fillRecordContextForIntent(
    intent: LiveIntent,
  ): { recordId: string; laneId: string; entryOrderIds: Array<string | null> } | undefined {
    try {
      if (!this.executionFillRecorder) return undefined;
      return {
        recordId: this.positionPathKeyForIntent(intent), // intent:<paperOrderId>:<createdAt>
        laneId: intent.sourcePaperOrders?.[0]?.laneId ?? "UNKNOWN",
        entryOrderIds: [intent.entryOrderId, ...(intent.entryOrderIds ?? [])],
      };
    } catch {
      return undefined;
    }
  }

  /** Persist the per-fill rows one settlement matched (2026-07-27, report-only). Never fetches —
   *  `matched` is the array realizedFromTrades already had. Fully wrapped: a failure here must
   *  NEVER affect settlement, P&L, the ledger or the kill-switch. An empty match records nothing
   *  (see recordFills' contract: no record is honest, an empty record reads as "no fills"). */
  private recordIntentFills(
    ctx: { recordId: string; laneId: string; entryOrderIds: Array<string | null> } | undefined,
    symbol: string,
    matched: FuturesUserTrade[],
    /** False when the userTrades page this match came from was SATURATED, so rows may have been cut
     *  off its edge. Passed by the caller rather than assumed true — see the call site. */
    fetchComplete: boolean,
  ): void {
    try {
      const recorder = this.executionFillRecorder;
      if (!recorder || !ctx || !Array.isArray(matched) || matched.length === 0) return;
      // Everything the settlement id set contains that is NOT an entry order is a closing order
      // (tp1, the triggered stop/breakeven's actualOrderId, or an explicit close order id) — the
      // caller supplies the entry side because only it knows which is which.
      const entryIds = new Set(ctx.entryOrderIds.filter((id): id is string => typeof id === "string"));
      const fills: ExecutionFill[] = [];
      for (const t of matched) {
        const role: ExecutionFillRole = entryIds.has(t.orderId) ? "ENTRY" : "EXIT";
        fills.push(fillFromUserTrade(t, role));
      }
      const nowMs = Date.parse(this.nowIso());
      recorder.recordFills({
        recordId: ctx.recordId,
        source: "engine",
        laneId: ctx.laneId,
        symbol,
        closedAtMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
        fetchComplete: fetchComplete === true,
        fills,
      });
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  private async settleIntentAfterClose(
    intent: LiveIntent,
    closeOrderIds: Array<string | null>,
    /** RECORDING-ONLY. Set false on the rescue-FLIP path when ONE settlement resolves N>1 opposing
     *  intents: exactly one record would be written, keyed to the ANCHOR intent, carrying the full
     *  flip qty that actually covers all N — a consumer joining fills to intents by recordId would
     *  score that intent's slippage against several times its real size and see "no fill data" for
     *  the other N−1. There is no per-intent fill to record here (there was only one real fill), so
     *  no record is the honest outcome — the same rule recordFills already applies to an empty
     *  match. The apportioned P&L itself is still labelled EXCHANGE_APPORTIONED on every intent.
     *  Purely a recording switch: `realizedFromTrades`' return value does not depend on it. */
    recordFills = true,
  ): Promise<SettledFromTrades | null> {
    const settled = await this.realizedFromTrades(
      intent.symbol,
      intent.createdAt,
      this.intentSettlementOrderIds(intent, closeOrderIds),
      {
        requiredOrderIds: [intent.entryOrderId, ...(intent.entryOrderIds ?? []), ...closeOrderIds],
        fillRecord: recordFills ? this.fillRecordContextForIntent(intent) : undefined,
        entryOrderId: intent.entryOrderId,
      },
    );
    this.applySettlementMetadata(intent, settled);
    return settled;
  }

  private rollDailyLedger(): void {
    const st = this.store.getState();
    const today = this.nowIso().slice(0, 10);
    if (st.dailyLedger.dateUtc !== today) {
      st.dailyLedger = { dateUtc: today, realizedPnlUsd: 0, wins: 0, losses: 0 };
    }
  }

  /** CORTEX real-USDT attribution sweep (2026-07-21, report-only — see cortex-real-attribution.ts).
   *
   *  WHY A SWEEP, NOT PER-CLOSE-PATH HOOKS: the engine has MANY paths that finalize an intent's
   *  realized P&L (settleClosedIntent's position-flat path, the MFE-giveback/profit-bank/regime
   *  -harvest/hard-cut flattens, manualCloseIntent, the kill-switch + panic exchange-flatten KILLED
   *  paths, and both openIntent/addToIntent EMERGENCY_FLATTEN error paths). They all converge on
   *  applyRealizedToLedger(net) — but that choke point only receives the bare number, not the
   *  intent. Rather than re-thread the intent through ~14 call sites (or hook each path and
   *  inevitably miss the next one someone adds), this sweep runs once per tick over the persisted
   *  intents and books every terminal intent (CLOSED/KILLED, plus ERROR intents whose emergency
   *  flatten realized actual dollars) exactly once — the store's own persisted dedup ids make it
   *  idempotent across ticks AND restarts, and closes that happen outside a tick (manual close,
   *  panic flatten) are simply picked up on the next one.
   *
   *  HARD SAFETY RULE: this is bookkeeping about trading, never part of it — the whole sweep is
   *  wrapped so no failure here can ever affect a trading decision, an order, or the tick. */
  private sweepCortexRealAttribution(): void {
    const attributionStore = this.cortexRealAttribution;
    if (!attributionStore) return;
    try {
      let bookedAny = false;
      for (const intent of this.store.getState().intents) {
        if (OPEN_INTENT_STATES.has(intent.state)) continue; // nothing realized yet
        // 2026-07-21 review fix: the durable per-intent flag is the PRIMARY dedup — it survives
        // attribution-file loss and id-FIFO eviction, and it also makes a lost-dedup re-book storm
        // structurally impossible (already-booked intents are skipped here regardless of the store).
        if (intent.cortexAttributed === true) continue;
        if (typeof intent.realizedPnlUsd !== "number") continue; // P&L UNKNOWN — never fabricate
        // Pre-feature intents and non-mirror opens (operator copy path) carry no open-time weight
        // capture — skip them entirely rather than invent a tilt share after the fact.
        if (typeof intent.cortexAppliedWeightPct !== "number" || typeof intent.cortexRawStaticWeightPct !== "number") continue;
        // createdAt disambiguates the rare re-mirror of the same paper order after an ERROR intent
        // (the mirrored-set check excludes ERROR/KILLED states, so one paperOrderId can produce a
        // second intent) — each intent instance books its own close exactly once.
        const recordId = `intent:${intent.paperOrderId}:${intent.createdAt}`;
        if (attributionStore.hasRecorded(recordId)) {
          // Booked previously but the flag was lost (e.g. pre-flag deploy) — repair the flag.
          intent.cortexAttributed = true;
          bookedAny = true;
          continue;
        }
        // deferSave: batch every booking this tick into ONE attribution-store write below — a
        // multi-booking tick must never turn into a per-record sync-write storm (review finding).
        const booked = attributionStore.recordClose(
          {
            recordId,
            closedAtIso: intent.closedAt ?? intent.updatedAt,
            laneId: intent.sourcePaperOrders?.[0]?.laneId ?? "UNKNOWN",
            symbol: intent.symbol,
            realizedPnlUsd: intent.realizedPnlUsd,
            appliedWeightPct: intent.cortexAppliedWeightPct,
            rawStaticWeightPct: intent.cortexRawStaticWeightPct,
          },
          { deferSave: true },
        );
        if (booked) {
          intent.cortexAttributed = true;
          bookedAny = true;
        }
      }
      if (bookedAny) {
        attributionStore.flush();
        this.store.save(); // persist the cortexAttributed flags alongside the booked records
      }
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  /** Stable path key for one intent instance — the SAME identity scheme sweepCortexRealAttribution
   *  uses (createdAt disambiguates a re-mirror of the same paper order after an ERROR intent). */
  private positionPathKeyForIntent(intent: LiveIntent): string {
    return `intent:${intent.paperOrderId}:${intent.createdAt}`;
  }

  /** Dense R-path sample for one OPEN intent (2026-07-22, report-only — see
   *  position-path-recorder.ts). currentR uses the exact formula manageMfeGiveback derives its
   *  favorableR from (entry vs mark over the entry→stop risk distance, sign-normalized so
   *  favorable is positive). deferSave batches the whole tick's samples into ONE disk write in
   *  sweepPositionPathRecorder's flush(). HARD SAFETY RULE: wrapped so no failure here can ever
   *  affect a trading decision, an order, or the tick. */
  private recordPositionPathTick(intent: LiveIntent, pos: FuturesPosition | undefined): void {
    const recorder = this.positionPathRecorder;
    if (!recorder || !pos) return;
    try {
      const entry = intent.filledEntryPrice ?? intent.plannedEntryPrice;
      const risk = Math.abs(entry - intent.stopLossPrice);
      if (!(entry > 0) || !(risk > 0)) return;
      const mark = pos.markPrice > 0 ? pos.markPrice : pos.entryPrice > 0 ? pos.entryPrice : entry;
      const currentR = intent.direction === "SHORT" ? (entry - mark) / risk : (mark - entry) / risk;
      const tsMs = Date.parse(this.nowIso());
      if (!Number.isFinite(currentR) || !Number.isFinite(tsMs)) return;
      recorder.recordTick(this.positionPathKeyForIntent(intent), tsMs, currentR, {
        meta: {
          laneId: intent.sourcePaperOrders?.[0]?.laneId ?? "UNKNOWN",
          symbol: intent.symbol,
          direction: intent.direction,
          ...(intent.sourcePaperOrders?.[0]?.sourceObservationId
            ? { signalId: intent.sourcePaperOrders[0].sourceObservationId }
            : {}),
          source: "engine",
        },
        deferSave: true,
      });
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  /** Dense R-path close sweep (2026-07-22, report-only — see position-path-recorder.ts).
   *
   *  WHY A SWEEP, NOT PER-CLOSE-PATH HOOKS: exactly sweepCortexRealAttribution's rationale above —
   *  the engine has ~14 paths that finalize an intent (lifecycle closes, manual close, kill-switch,
   *  emergency flattens), and a sweep over the persisted intents catches every one of them exactly
   *  once (markClosed no-ops for keys the recorder isn't tracking, so re-sweeping terminal intents
   *  is idempotent and closes that happen outside a tick are picked up on the next one). Also
   *  flushes the tick's deferred recordTick samples in one write and prunes expired paths.
   *
   *  finalR: NET realized R (realizedPnlUsd / effectiveRiskUsd) when both are known — the honest
   *  "what the exit actually banked" number; omitted otherwise, in which case the recorder falls
   *  back to the last recorded mark-R tick.
   *
   *  HARD SAFETY RULE: bookkeeping about trading, never part of it — fully wrapped. */
  private sweepPositionPathRecorder(): void {
    const recorder = this.positionPathRecorder;
    if (!recorder) return;
    try {
      const nowMs = Date.parse(this.nowIso());
      for (const intent of this.store.getState().intents) {
        if (OPEN_INTENT_STATES.has(intent.state)) continue; // still open — keep recording
        const key = this.positionPathKeyForIntent(intent);
        if (!recorder.isTrackingOpen(key)) continue; // never tracked, or already handed off
        const closedMs = Date.parse(intent.closedAt ?? intent.updatedAt);
        const risk = intent.effectiveRiskUsd;
        const finalR =
          typeof intent.realizedPnlUsd === "number" && Number.isFinite(intent.realizedPnlUsd) && typeof risk === "number" && risk > 0
            ? intent.realizedPnlUsd / risk
            : undefined;
        recorder.markClosed(key, Number.isFinite(closedMs) ? closedMs : nowMs, { finalR, deferSave: true });
      }
      recorder.pruneExpired(Number.isFinite(nowMs) ? nowMs : Date.now(), { deferSave: true });
      recorder.flush(); // one write for the whole tick's samples + closes; no-op while clean
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  /** Persist only explicit executive-review links carried by the incumbent intent. */
  private sweepExecutiveReviewPositions(): void {
    if (!this.executiveReviewStore) return;
    try {
      const nowMs = Date.parse(this.nowIso());
      resolveExecutiveReviewPositions(
        this.executiveReviewStore,
        this.store.getState().intents,
        Number.isFinite(nowMs) ? nowMs : Date.now(),
      );
    } catch {
      // Review telemetry is strictly fail-open relative to the incumbent execution engine.
    }
  }

  /** Per-fill store retention (2026-07-27, report-only). RETENTION ONLY — this never writes a
   *  record and never reads the file; records are written at settlement by recordIntentFills. An
   *  in-memory filter over ≤ MAX_FILL_RECORDS entries.
   *
   *  COST, STATED HONESTLY (an earlier version of this comment claimed "zero I/O in steady state",
   *  which is inverted — steady state is exactly when records reach the 90-day horizon). Once the
   *  store is older than FILL_RETENTION_MS, roughly one tick in 40 at ~7 closes/day will drop a
   *  record and pay one synchronous whole-file write (~1–3 ms at the projected ~340 KB). This runs
   *  at tick step 3.7, BEFORE mirrorNewSignals at step 5, so it is on the pre-order side of the
   *  tick — flagged rather than buried. It is immaterial against the several signed Binance
   *  round-trips the same tick already awaits (ensureTimeSync, reconcile, manageLifecycle) and
   *  against sweepPositionPathRecorder at step 3.6, which already flushes to disk on this path.
   *  Wrapped, like every other sweep here. */
  private sweepExecutionFillRecorder(): void {
    const recorder = this.executionFillRecorder;
    if (!recorder) return;
    try {
      const nowMs = Date.parse(this.nowIso());
      recorder.pruneExpired(Number.isFinite(nowMs) ? nowMs : Date.now());
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  // ── mirroring ──────────────────────────────────────────────────────────────

  private activeManualDirectionalAllocations(): Array<{ laneId: string; weightPct: number }> | null {
    const configured = this.store.getState().manualDirectionalAllocations;
    const decision = this.manualEntryDecision;
    if (!this.store.getState().manualSelectorMode || !configured || !decision?.directionalBias || decision.action === "NO_TRADE") return null;
    // 2026-07-20 real-money audit fix (BUG 2): a decision this stale is treated exactly like "no
    // decision yet" (null) — every downstream consumer (effectiveLaneAllocations,
    // isManualDirectionalEntryEnabled, canOpenNewEntries, isManualEntryAllowedForPaper) already
    // fails closed on null, so this single check protects all of them at once.
    if (isManualEntryDecisionStale(decision.observedAt, Date.parse(this.nowIso()))) return null;
    return decision.directionalBias === "LONG" ? configured.long : configured.short;
  }

  private effectiveLaneAllocations(): Array<{ laneId: string; weightPct: number }> | null {
    const st = this.store.getState();
    // Empty means an intentional directional hold while manual mode awaits a fresh Entry Decision.
    if (st.manualSelectorMode && st.manualDirectionalAllocations) return this.activeManualDirectionalAllocations() ?? [];
    return st.laneAllocations;
  }

  private isManualDirectionalEntryEnabled(): boolean {
    const active = this.activeManualDirectionalAllocations();
    return active !== null && active.length > 0;
  }

  /** CORTEX Phase-4 promotion (2026-07-20): install/clear the latest gated tilt. `null` clears any
   *  override (the default — every non-promoted instance never calls this, so it's always null there). */
  setCortexPromotedWeights(weights: Record<string, number> | null): void {
    this.cortexPromotedWeights = weights;
  }
  getCortexPromotedWeights(): Record<string, number> | null {
    return this.cortexPromotedWeights;
  }

  /** Weighted allocation lookup: 100 when allocations are off; the lane's weightPct when
   *  listed; 0 (blocked) when allocations are ON but the lane is not listed. */
  laneSelectionWeightPctForLane(laneId: string): number {
    const allocations = this.effectiveLaneAllocations();
    if (allocations === null) return 100;
    if (allocations.length === 0) return 0;
    const variantId = laneId.split(":").pop() ?? laneId;
    const hit = allocations.find((a) => a.laneId === laneId || a.laneId === variantId);
    if (!hit) return 0; // the operator explicitly excluded this lane — CORTEX may tilt it, never reinstate it
    // CORTEX promoted tilt (2026-07-20 safety-review fix): only RESCALES a lane the operator's own
    // table already funds (the `hit` check above) — never a lane the operator explicitly left out, and
    // never during the operator's own manual-directional entries (an explicit manual choice always
    // wins outright, so the brain's tilt simply goes inert for as long as manual mode is active).
    if (this.cortexPromotedWeights && !this.isManualDirectionalEntryEnabled()) {
      const w = this.cortexPromotedWeights[laneId] ?? this.cortexPromotedWeights[variantId];
      if (typeof w === "number" && Number.isFinite(w)) return Math.max(0, w);
    }
    return hit.weightPct;
  }

  /** 2026-07-21 CRITICAL fix: same lookup as laneSelectionWeightPctForLane, but NEVER consults
   *  cortexPromotedWeights. CORTEX's own "static weight" input (app.ts's staticWeightPctForLane) was
   *  wired to laneSelectionWeightPctForLane — the SAME accessor its own promoted output feeds back
   *  into — creating a self-referential feedback loop: a cycle that promotes lane X writes X's tilted
   *  weight into cortexPromotedWeights, and the NEXT cycle then reads that tilted number back as if it
   *  were the plain operator table, feeds it into decideCortex as "static", and (for a direction-split
   *  roster lane like CG_MFE_GIVEBACK_LONG/_SHORT) folds it into a phantom concentration that trips the
   *  per-lane cap — which clears the override, so the cycle after reads the TRUE table again and
   *  re-promotes, oscillating forever. Observed live: CG_MFE_GIVEBACK's real static is a flat 12%
   *  (24% folded, well under the 35% cap) but the contaminated read alternated 12%→21.5%, folding to
   *  24.0% / ~43.1% every other cycle. CORTEX's static-weight input must be immune to its own prior
   *  output, so it always reads the TRUE operator-configured table here. */
  rawLaneAllocationWeightPctForLane(laneId: string): number {
    const allocations = this.effectiveLaneAllocations();
    if (allocations === null) return 100;
    if (allocations.length === 0) return 0;
    const variantId = laneId.split(":").pop() ?? laneId;
    const hit = allocations.find((a) => a.laneId === laneId || a.laneId === variantId);
    return hit ? hit.weightPct : 0;
  }

  /** Operator lane selection for non-paper lanes too (e.g. cross-sectional executor).
   *  Weighted allocations take precedence; otherwise the plain allow-list applies. */
  laneSelectionAllowsLane(laneId: string): boolean {
    const st = this.store.getState();
    const allocations = this.effectiveLaneAllocations();
    if (allocations !== null) {
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
    const allocations = this.effectiveLaneAllocations() ?? [];
    if (allocations.some((a) => a.laneId === laneId || a.laneId === variantId)) return true;
    const allowed = st.allowedLaneIds;
    return Array.isArray(allowed) && allowed.some((id) => id === laneId || id === variantId);
  }

  private laneAllocationWeightPct(paper: PaperOrder): number {
    return this.laneAllocationWeightPctWithRaw(paper).applied;
  }

  /** Same decision tree as laneAllocationWeightPct always used (the `applied` side is byte-for-byte
   *  its old behavior), extended to ALSO report the operator's untouched static table weight for
   *  the same lane through the SAME branch that produced the applied number — so the pair is
   *  always internally consistent (CORTEX real-USDT attribution, 2026-07-21). The two can only
   *  differ on the plain table branch, where `applied` may carry an active CORTEX promoted tilt
   *  (laneSelectionWeightPctForLane) while `raw` never does (rawLaneAllocationWeightPctForLane);
   *  an orchestrator override or the diagnostic-collection fallback is not a CORTEX tilt, so both
   *  sides return the identical number there (tiltShare 0 by construction). */
  private laneAllocationWeightPctWithRaw(paper: PaperOrder): { applied: number; raw: number } {
    const override = this.paperLaneWeightPct(paper);
    if (override !== null) {
      const clamped = Math.max(0, Math.min(100, override));
      return { applied: clamped, raw: clamped };
    }
    const laneId = paper.selectedLaneId ?? "";
    const tableWeight = this.laneSelectionWeightPctForLane(laneId);
    const rawTableWeight = this.rawLaneAllocationWeightPctForLane(laneId);
    if (tableWeight > 0 || !this.config.mirrorAllPaperOrders) return { applied: tableWeight, raw: rawTableWeight };
    // tableWeight is 0 under mirrorAllPaperOrders: distinguish "the operator explicitly listed this
    // lane at 0%" (a deliberate exclusion — must stay 0, even in collection mode) from "this lane
    // simply isn't part of the real allocation table at all" (an off-table diagnostic/research
    // variant, which collection mode should still size for real — see DIAGNOSTIC_LANE_MIRROR_WEIGHT_PCT).
    const allocations = this.effectiveLaneAllocations();
    if (allocations === null || allocations.length === 0) return { applied: tableWeight, raw: rawTableWeight };
    const variantId = laneId.split(":").pop() ?? laneId;
    const listed = allocations.some((a) => a.laneId === laneId || a.laneId === variantId);
    return listed
      ? { applied: tableWeight, raw: rawTableWeight }
      : { applied: DIAGNOSTIC_LANE_MIRROR_WEIGHT_PCT, raw: DIAGNOSTIC_LANE_MIRROR_WEIGHT_PCT };
  }

  /** Operator lane selection: weighted allocations (when set) take precedence; else the
   *  plain allow-list (null = all lanes, [] = pause all new mirrors). Matches
   *  selectedLaneId as full id or variant suffix. */
  private laneAllowedForMirror(paper: PaperOrder): boolean {
    if (!isTestnetCrossSectionalHorizonLaneAllowed(this.config.env, paper.selectedLaneId)) return false;
    // LIVE_MIRROR_ALL_PAPER is parsed as testnet-only. Collection mode mirrors
    // every fresh diagnostic source so lane selection cannot starve CORTEX data.
    if (this.config.mirrorAllPaperOrders) return true;
    const override = this.paperLaneGate(paper);
    if (override !== null) return override;
    return this.laneSelectionAllowsLane(paper.selectedLaneId ?? "");
  }

  /** Unified orchestration deliberately consumes a chosen diagnostic recipe directly instead of
   *  waiting for the old promotion ladder to relabel it HEADLINE. This bypass is narrow: the
   *  central lane gate must explicitly accept the recipe and the source must still be fresh.
   *  Status, dedup, stop/TP geometry, entry quality, cluster caps and every risk check below remain
   *  unchanged. Returning null from paperLaneGate preserves the legacy source rules exactly. */
  private paperSourceEligibleForMirror(paper: PaperOrder, nowIso: string): boolean {
    if (!isTestnetCrossSectionalHorizonLaneAllowed(this.config.env, paper.selectedLaneId)) return false;
    // Testnet collection is broader than orchestration. Still require a fresh
    // source, but do not let an old unified-recipe verdict suppress it.
    if (this.config.mirrorAllPaperOrders) return this.isFreshPaperOrder(paper, nowIso);
    const override = this.paperLaneGate(paper);
    if (override !== null) return override && this.isFreshPaperOrder(paper, nowIso);
    return paper.paperOrderMode === "HEADLINE" &&
        this.isFreshPaperOrder(paper, nowIso) &&
        this.isPaperOrderLiveEligible(paper, nowIso);
  }

  /** True when an operator selection (weighted allocation OR allow-list) is active AND
   *  this paper order's lane is one the operator picked — i.e. the resulting position
   *  exists because of the manual selection, not the bot's normal routing. */
  private operatorSelectionActiveFor(paper: PaperOrder): boolean {
    const st = this.store.getState();
    const effectiveAllocations = this.effectiveLaneAllocations();
    const hasAllocations = !!effectiveAllocations && effectiveAllocations.length > 0;
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
    // 2026-07-08 (manual-mode ownership): when the operator has explicitly locked the lane
    // allocation — silently clearing it on a losing close leaves the slot mysteriously dead
    // until the operator re-picks ("directional stuck ga bisa open" class). Auto-reset stays
    // active for autopilot-managed selections only.
    if (st.laneAllocationOperatorLock === true) return;
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
    if (!st.manualSelectorMode) this.manualEntryDecision = null;
    this.store.save();
    return { ok: true, manualSelectorMode: st.manualSelectorMode };
  }

  isManualSelectorMode(): boolean {
    return this.store.getState().manualSelectorMode === true;
  }

  /** Scanner-owned direction context for manual mode. It is intentionally ephemeral: after a
   * restart the engine waits for a new scanner decision instead of trading a remembered bias. */
  setManualEntryDecision(decision: ManualEntryDecisionSnapshot | null): void {
    this.manualEntryDecision = decision
      ? {
          action: decision.action,
          directionalBias: decision.directionalBias,
          reason: decision.reason,
          observedAt: decision.observedAt,
        }
      : null;
  }

  /** Admission-only manual override. A paper signal must still be fresh and carry valid geometry;
   * this merely bypasses maturity/book/regime policy after the operator selected that directional lane. */
  isManualEntryAllowedForPaper(paper: Pick<PaperOrder, "selectedLaneId" | "direction">): boolean {
    if (!isTestnetCrossSectionalHorizonLaneAllowed(this.config.env, paper.selectedLaneId)) return false;
    const decision = this.manualEntryDecision;
    return this.isManualDirectionalEntryEnabled() &&
      decision?.directionalBias === paper.direction &&
      this.laneSelectionAllowsLane(paper.selectedLaneId ?? "");
  }

  setManualDirectionalLaneAllocations(
    allocations: { long: Array<{ laneId: string; weightPct: number }>; short: Array<{ laneId: string; weightPct: number }> } | null,
  ): {
    ok: boolean;
    reason: string | null;
    manualDirectionalAllocations: LiveExecutionState["manualDirectionalAllocations"];
    /** 2026-07-19 real-money audit fix (BUG 4): worst-case combined notional per side if every
     *  listed lane fired simultaneously — see combinedWorstCaseNotionalUsd's doc comment. Always
     *  computed (even when maxAggregateManualDirectionalNotionalUsd is 0/disabled) so the real
     *  aggregate figure is never silently hidden from whatever calls this (e.g. the dashboard). */
    combinedWorstCaseNotionalUsd?: { long: number; short: number };
  } {
    const st = this.store.getState();
    if (allocations === null) {
      st.manualDirectionalAllocations = null;
      this.manualEntryDecision = null;
      this.store.save();
      return { ok: true, reason: null, manualDirectionalAllocations: null };
    }
    const clean = (side: "long" | "short") => {
      const rows = allocations[side];
      if (!Array.isArray(rows) || rows.length > MAX_LANE_ALLOCATIONS) {
        return { ok: false as const, reason: `${side} allocations must list 0-${MAX_LANE_ALLOCATIONS} lanes` };
      }
      const seen = new Set<string>();
      const result: Array<{ laneId: string; weightPct: number }> = [];
      for (const raw of rows) {
        const laneId = String(raw.laneId ?? "").trim();
        const weightPct = Number(raw.weightPct);
        if (!laneId) return { ok: false as const, reason: `${side} allocation has empty laneId` };
        if (!Number.isFinite(weightPct) || weightPct <= 0 || weightPct > 100) {
          return { ok: false as const, reason: `${side} weightPct for ${laneId} must be in (0, 100]` };
        }
        const directionMismatch = manualDirectionalLaneMismatchReason(side, laneId, this.laneDirectionForId);
        if (directionMismatch) return { ok: false as const, reason: directionMismatch };
        if (seen.has(laneId)) return { ok: false as const, reason: `duplicate ${side} laneId ${laneId}` };
        seen.add(laneId);
        result.push({ laneId, weightPct: Math.round(weightPct) });
      }
      return { ok: true as const, rows: result };
    };
    const long = clean("long");
    if (!long.ok) return { ok: false, reason: long.reason, manualDirectionalAllocations: st.manualDirectionalAllocations };
    const short = clean("short");
    if (!short.ok) return { ok: false, reason: short.reason, manualDirectionalAllocations: st.manualDirectionalAllocations };
    if (long.rows.length + short.rows.length === 0) {
      return { ok: false, reason: "pick at least one long or short lane, or clear the manual directional allocation", manualDirectionalAllocations: st.manualDirectionalAllocations };
    }
    // 2026-07-19 real-money audit fix (BUG 4, HIGH): each lane independently sizes to its own full
    // maxNotionalPerTrade at weightPct:100 — nothing previously normalized or capped the SUM across
    // lanes on the SAME side, so e.g. 3 LONG lanes each at 100% could each deploy their own full
    // size simultaneously if signals fire together (this exact configuration was observed live).
    // Always computed and returned; only ENFORCED (rejects) when the operator has explicitly opted
    // into a cap via LIVE_MAX_AGGREGATE_MANUAL_DIRECTIONAL_NOTIONAL_USD — additive: a single lane
    // per direction (the common case) is bounded by maxNotionalPerTrade exactly as before, and a
    // previously-allowed multi-lane configuration is never silently blocked unless the operator has
    // opted in to the cap.
    const worstCase = {
      long: combinedWorstCaseNotionalUsd(long.rows, this.config.maxNotionalPerTrade),
      short: combinedWorstCaseNotionalUsd(short.rows, this.config.maxNotionalPerTrade),
    };
    const cap = this.config.maxAggregateManualDirectionalNotionalUsd;
    if (cap > 0 && (worstCase.long > cap || worstCase.short > cap)) {
      return {
        ok: false,
        reason:
          `combined worst-case notional would be long $${worstCase.long.toFixed(2)} / short $${worstCase.short.toFixed(2)}` +
          ` — exceeds the configured aggregate cap of $${cap} (LIVE_MAX_AGGREGATE_MANUAL_DIRECTIONAL_NOTIONAL_USD).` +
          ` Reduce the lane weights on that side or raise the cap explicitly.`,
        manualDirectionalAllocations: st.manualDirectionalAllocations,
        combinedWorstCaseNotionalUsd: worstCase,
      };
    }
    st.manualDirectionalAllocations = { long: long.rows, short: short.rows };
    st.laneAllocationOperatorLock = true;
    this.store.save();
    return { ok: true, reason: null, manualDirectionalAllocations: st.manualDirectionalAllocations, combinedWorstCaseNotionalUsd: worstCase };
  }

  /** True once the operator has explicitly applied a lane allocation (POST
   *  /api/live/lane-allocations) — see laneAllocationOperatorLock's doc comment on
   *  LiveExecutionState for why this is a SEPARATE flag from manualSelectorMode. */
  isLaneAllocationOperatorLocked(): boolean {
    return this.store.getState().laneAllocationOperatorLock === true;
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
    if (allocations.length === 0 || allocations.length > MAX_LANE_ALLOCATIONS) {
      return { ok: false, reason: `allocations must list 1-${MAX_LANE_ALLOCATIONS} lanes (or null to turn off)`, laneAllocations: st.laneAllocations };
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
   * laneAllocationOperatorLock (atomically, in the same store save) so the dashboard never keeps
   * showing "operator-locked" after the regime engine has genuinely changed the allocation out
   * from under the operator. Only called when RegimeAutopilot itself decides to act (its own
   * stability/cooldown guards are unchanged) — if the lock was already off, this is a no-op on
   * the flag.
   */
  applyRegimeAutopilotAllocation(
    allocations: Array<{ laneId: string; weightPct: number }>,
  ): { ok: boolean; reason: string | null; laneAllocations: Array<{ laneId: string; weightPct: number }> | null } {
    // Operator override (2026-07-08, corrected 2026-07-09 — see laneAllocationOperatorLock's doc
    // comment): the operator's explicit lane-allocation choice must never be silently overwritten.
    // Belt-and-suspenders with the autopilot's own tick guard — NO autopilot-attributed apply may
    // ever overwrite a locked selection, regardless of which caller path reaches this.
    if (this.isLaneAllocationOperatorLocked()) {
      return {
        ok: false,
        reason: "lane allocation operator lock aktif — operator memegang lane allocation",
        laneAllocations: this.store.getState().laneAllocations ?? null,
      };
    }
    const result = this.setLaneAllocations(allocations);
    if (result.ok) {
      const st = this.store.getState();
      st.laneAllocationOperatorLock = false;
      this.store.save();
    }
    return result;
  }

  /**
   * Operator-explicit allocation apply (POST /api/live/lane-allocations — the dashboard's "Apply"
   * button, including applying a regime-tree preset). Mirror image of
   * applyRegimeAutopilotAllocation above: THAT clears laneAllocationOperatorLock because
   * autopilot's own apply is the "smart" path; THIS sets it, because the operator's own explicit
   * choice must not be silently overwritten by the next autopilot tick.
   *
   * 2026-07-09 (real incident, two takes): first attempt reused the existing manualSelectorMode
   * field for this lock. That field's ORIGINAL and still-current meaning (see its own doc comment)
   * is the RAW BYPASS toggle exposed by POST /api/live/manual-mode and consumed by scan.ts's
   * realtime-short-mirror admission overlay — an entirely unrelated concern. Because both concerns
   * shared one flag, toggling the RAW BYPASS button for its own legitimate purpose silently
   * released the "operator owns the allocation" guard too, and the very next RegimeAutopilot tick
   * reverted a manually-applied 80/8/8/4 allocation back to the NO_TRADE preset (100%
   * CROSS_SECTIONAL_MARKET_NEUTRAL) within minutes — discovered only because the operator noticed
   * the dashboard's regime-tree/allocation mismatch. laneAllocationOperatorLock is a dedicated
   * field for this concern alone, checked by RegimeAutopilot.tick(),
   * applyRegimeAutopilotAllocation(), and maybeAutoResetLaneSelection() — never touched by the RAW
   * BYPASS toggle. Clicking Apply now durably means "operator owns this until they switch back to
   * SMART", not just "for however long the next background tick allows, and only if the operator
   * never touches the unrelated bypass toggle".
   *
   * Only sets the flag when actually applying an allocation (allocations !== null) — clearing
   * (null) leaves the lock as-is, since "remove my custom lanes" isn't necessarily "hand control
   * back to autopilot" and shouldn't be overloaded to mean that silently.
   */
  setLaneAllocationsAsOperator(
    allocations: Array<{ laneId: string; weightPct: number }> | null,
  ): { ok: boolean; reason: string | null; laneAllocations: Array<{ laneId: string; weightPct: number }> | null } {
    const result = this.setLaneAllocations(allocations);
    if (result.ok && allocations !== null) {
      const st = this.store.getState();
      st.laneAllocationOperatorLock = true;
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
    idempotencyKey?: string | null;
  }): Promise<{ ok: boolean; reason: string | null; intent?: LiveIntent }> {
    if (!isTestnetCrossSectionalHorizonLaneAllowed(this.config.env, req.sourceLaneId)) {
      return { ok: false, reason: "testnet is locked to the cross-sectional horizon lane" };
    }
    const idempotencyKey =
      typeof req.idempotencyKey === "string" && req.idempotencyKey.trim().length > 0
        ? req.idempotencyKey.trim()
        : null;
    if (idempotencyKey) {
      const prior = this.store
        .getState()
        .intents.find((intent) => intent.externalCopyIdempotencyKey === idempotencyKey);
      if (prior) {
        return prior.state === "ERROR"
          ? { ok: false, reason: prior.lastError ?? "prior idempotent copy failed", intent: prior }
          : { ok: true, reason: "idempotent replay: existing copy returned", intent: prior };
      }
    }
    if (this.store.getState().killedAt) return { ok: false, reason: "kill switch latched" };
    if (!this.armed) return { ok: false, reason: "live engine is DISARMED — arm it first, then copy" };
    if (!this.canOpenNewEntries()) {
      const gate = this.strategyEntryGate();
      const reason = this.isNewEntryDrainActive()
        ? "new-entry drain is active — exits remain managed, but copy/open is blocked"
        : gate.reason ?? "new-entry gate is closed";
      return { ok: false, reason };
    }
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

    if (this.copyingSymbols.has(req.symbol)) {
      return { ok: false, reason: `a copy is already in flight for ${req.symbol}` };
    }
    this.copyingSymbols.add(req.symbol);
    try {
      const filters = await this.getFilters(req.symbol);
      if (!filters) return { ok: false, reason: `no exchange filters for ${req.symbol}` };

      // Re-verify after the await gap above: a concurrent copy (or the tick's own mirrorNewSignals)
      // could have opened this symbol while we were awaiting filters.
      const stillOpen = this.store.getState().intents.filter((i) => OPEN_INTENT_STATES.has(i.state));
      if (stillOpen.some((i) => i.symbol === req.symbol)) {
        return { ok: false, reason: `an intent is already open on ${req.symbol}` };
      }

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
      const copyStopDistancePct = Math.abs(req.entryPrice - req.stopLossPrice) / req.entryPrice;
      const plan: LiveOrderPlan = {
        ok: true,
        reason: null,
        qty,
        tp1Qty: this.isFullTpExitRule(exitRule) ? qty : roundDownToStep(qty / 2, filters.stepSize),
        notionalUsd: qty * req.entryPrice,
        plannedRiskUsd: req.qty * req.entryPrice * copyStopDistancePct,
        requiredNotionalUsd: req.qty * req.entryPrice,
        appliedNotionalUsd: qty * req.entryPrice,
        notionalCapUsd: this.config.maxNotionalPerTrade,
        stopDistancePct: copyStopDistancePct,
        stopPrice: req.stopLossPrice,
        tp1Price: req.tp1Price,
        effectiveRiskUsd: qty * req.entryPrice * copyStopDistancePct,
        // Copies size from the testnet qty, not riskUsdPerTrade — "clipped" here means the live
        // notional ceiling shrank the copied qty below what testnet held.
        riskClippedByNotionalCap: req.qty > maxQtyByNotional,
      };

      await this.openIntent(
        [{ paper: syntheticPaper, plan, externalCopyIdempotencyKey: idempotencyKey ?? undefined }],
        filters,
      );
      const intent = this.store.getState().intents.find((i) => i.paperOrderId === copyId);
      if (!intent) return { ok: false, reason: "copy did not produce an intent (plan rejected)" };
      if (intent.state === "ERROR") {
        return { ok: false, reason: intent.lastError ?? "copy open failed (flattened safely)", intent };
      }
      return { ok: true, reason: null, intent };
    } finally {
      this.copyingSymbols.delete(req.symbol);
    }
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

  /** Set (and persist) the operator's lane allow-list. null restores "all lanes".
   *  2026-07-12 audit note: a round-2 bug-sweep finding claimed this should also set
   *  laneAllocationOperatorLock, mirroring setLaneAllocationsAsOperator. Re-investigated and
   *  rejected — RegimeAutopilot never writes allowedLaneIds (grepped confirmed: the only writer
   *  is this method, called solely from routes/live.ts's POST /api/live/lanes), so there is no
   *  actual autopilot-overwrite risk to protect against. Setting the lock here would instead
   *  BREAK the already-tested, intentional maybeAutoResetLaneSelection() behavior — it explicitly
   *  skips auto-reset when the lock is set, and the existing "lane selection auto-reset" test
   *  suite (see live-execution-engine.test.ts) requires a losing close to reset an allow-list-only
   *  selection same as an allocation-only one. Left as-is; not a real bug. */
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
    if (!this.canOpenNewEntries()) return;
    const now = this.nowIso();
    const st = this.store.getState();

    // Respect the PAPER drawdown breaker too: if the strategy layer halted itself,
    // the live mirror must not keep firing its signals.
    if (!this.config.mirrorAllPaperOrders && this.paperStore.isAdmissionHalted(now)) return;

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
      const orchestrated = this.config.mirrorAllPaperOrders ? null : this.paperLaneGate(o);
      if (this.config.mirrorAllPaperOrders) {
        if (!this.isFreshPaperOrder(o, now)) return "stale";
      } else if (orchestrated !== null) {
        if (!orchestrated) return "unified_recipe_not_allowed";
        if (!this.isFreshPaperOrder(o, now)) return "stale";
      } else if (!this.config.mirrorAllPaperOrders) {
        if (o.paperOrderMode !== "HEADLINE") return "not_headline";
        if (!this.isFreshPaperOrder(o, now)) return "stale";
        if (!this.isPaperOrderLiveEligible(o, now)) return "not_live_eligible";
      }
      if (!this.config.mirrorAllPaperOrders && o.diagnosticLabel != null) return "diagnostic_label";
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
          this.paperSourceEligibleForMirror(o, now) &&
          (this.config.mirrorAllPaperOrders || o.diagnosticLabel == null) &&
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
    const priorityOrderedCandidates = ranked
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
    const candidates = this.config.testnetStratifiedCollection
      ? interleaveTestnetCollectionCandidates(
          priorityOrderedCandidates.map((paper) => ({ paper })),
          this.testnetObservedStratumCounts(st.intents),
        ).map((candidate) => candidate.paper)
      : priorityOrderedCandidates;

    let slots = Math.max(0, this.config.maxConcurrentPositions - openCount);
    const externalManaged = this.externalManagedNetQty();
    const clusterOpen = this.clusterOpenCounts(st.intents);
    const correlatedAltOpen = this.correlatedAltOpenSymbols(st.intents, externalManaged);
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
      const groupClaim = externalManaged.get(first.symbol) ?? 0;
      if (groupClaim !== 0 && Math.sign(groupClaim) !== (first.direction === "LONG" ? 1 : -1)) {
        for (const paper of papers) latchReason(paper.paperOrderId, "basket_opposite_side");
        continue;
      }
      if (!oppositeIntent && this.isCorrelatedAltSymbol(first.symbol)) {
        const openSymbols = correlatedAltOpen[first.direction];
        if (!openSymbols.has(first.symbol) && openSymbols.size >= this.correlatedAltCap(first.direction)) {
          for (const paper of papers) latchReason(paper.paperOrderId, "correlated_alt_cap");
          continue;
        }
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
      // Entry-quality gate: do not pay for a signal whose favorable move already happened, whose
      // stop is already invalidated, or whose remaining target is too small to clear realistic
      // round-trip friction. Existing positions and all exits are unaffected.
      if (!this.config.mirrorAllPaperOrders && !oppositeIntent && typeof this.marketDataClient?.getBookTicker === "function") {
        let livePrice: number | null = null;
        try {
          const book = await this.marketDataClient.getBookTicker(first.symbol);
          if (book.bid !== null && book.ask !== null && book.bid > 0 && book.ask > 0) livePrice = (book.bid + book.ask) / 2;
          else if (book.bid !== null && book.bid > 0) livePrice = book.bid;
          else if (book.ask !== null && book.ask > 0) livePrice = book.ask;
        } catch {
          // Fail closed below: opening without a current reference defeats the no-chase gate.
        }
        const tp = first.takeProfitLevels?.[0];
        const risk = Math.abs(first.entryPrice - first.stopLoss);
        if (!(livePrice !== null && livePrice > 0) || !(risk > 0) || !(typeof tp === "number" && tp > 0)) {
          for (const paper of papers) latchReason(paper.paperOrderId, "entry_quality_unavailable");
          continue;
        }
        const favorableDriftR = first.direction === "LONG"
          ? (livePrice - first.entryPrice) / risk
          : (first.entryPrice - livePrice) / risk;
        const stopCrossed = first.direction === "LONG" ? livePrice <= first.stopLoss : livePrice >= first.stopLoss;
        if (stopCrossed) {
          for (const paper of papers) latchReason(paper.paperOrderId, "signal_stop_already_crossed");
          continue;
        }
        if (favorableDriftR > this.maxEntryChaseStopFraction()) {
          for (const paper of papers) latchReason(paper.paperOrderId, "entry_chase_too_far");
          continue;
        }
        const remainingGrossPct = first.direction === "LONG" ? (tp - livePrice) / livePrice : (livePrice - tp) / livePrice;
        if (remainingGrossPct < this.minEntryGrossTargetPct()) {
          for (const paper of papers) latchReason(paper.paperOrderId, "target_below_cost_buffer");
          continue;
        }
      }
      // Technical-confirmation gate (2026-07-08, operator-requested ADD-ON — whitelist above still
      // decides which symbols/priority are eligible; this additionally requires the symbol's OWN
      // fresh candles to confirm the direction right now). Fails CLOSED: missing/stale cache data
      // blocks rather than passes, since the whole point is "don't fire without confirmation."
      // 2026-07-11 fix: was only checking `!signal?.confirmed`, never this entry's OWN computedAt —
      // a persistently-failing refresh (network/API issue) kept re-serving a stale confirmed=true
      // verdict from the last successful fetch, potentially days old, under the cache's shared
      // top-level computedAt which gets re-stamped every cycle regardless of per-symbol success.
      if (!this.config.mirrorAllPaperOrders && isDirectionalTechnicalGateEnabled()) {
        const entry = getSymbolVolatilityCacheStore().get().technicalBySymbol[first.symbol];
        const signal = entry?.[first.direction];
        if (!signal?.confirmed || !isDirectionalTechnicalSignalFresh(entry, nowMs)) {
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
      if (lanePapers.length === 0) {
        if (oppositeIntent && this.config.testnetStratifiedCollection) {
          for (const paper of papers) latchReason(paper.paperOrderId, "entry_regime_isolated_open_intent");
        }
        continue;
      }

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
        // CORTEX real-USDT attribution (2026-07-21): capture the applied weight AND the raw static
        // table weight at this exact sizing moment — openIntent freezes the pair on the intent so
        // the close sweep can later attribute realizedPnlUsd × tiltShare (report-only).
        const { applied: weightPct, raw: rawWeightPct } = this.laneAllocationWeightPctWithRaw(paper);
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
            : {
                ...plan,
                qty: plan.qty * totalScale,
                notionalUsd: plan.notionalUsd * totalScale,
                plannedRiskUsd: plan.plannedRiskUsd * totalScale,
                requiredNotionalUsd: plan.requiredNotionalUsd * totalScale,
                appliedNotionalUsd: plan.appliedNotionalUsd * totalScale,
                notionalCapUsd: plan.notionalCapUsd * totalScale,
                effectiveRiskUsd: plan.effectiveRiskUsd * totalScale,
              };
        return [{ paper, plan: scaled, cortexAppliedWeightPct: weightPct, cortexRawStaticWeightPct: rawWeightPct }];
      });
      if (planned.length === 0) {
        for (const paper of lanePapers) latchReason(paper.paperOrderId, "plan_not_sizeable"); // e.g. BTC: $50 cap < one 0.001-step
        continue;
      }
      if (oppositeIntent) {
        const currentRisk = Math.max(0, oppositeIntent.effectiveRiskUsd ?? 0);
        const additionRisk = planned.reduce((sum, item) => sum + item.plan.effectiveRiskUsd, 0);
        const aggregateCap = this.maxAggregateIntentRiskUsd();
        if (currentRisk + additionRisk > aggregateCap + 1e-9) {
          for (const paper of lanePapers) latchReason(paper.paperOrderId, "aggregate_intent_risk_cap");
          continue;
        }
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
        if (this.isCorrelatedAltSymbol(first.symbol)) correlatedAltOpen[first.direction].add(first.symbol);
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
    // 2026-07-23 fix: mirrorNewSignals scales each item's plan.qty by (weight% × size-multiplier)
    // AFTER computeLiveOrderPlan already validated the UNSCALED qty against minQty/minNotional —
    // that scaled qty was never re-checked against minNotional here, only against minQty (qty count
    // can clear minQty while the scaled-down dollar notional still misses the exchange's separate
    // minNotional floor). Confirmed live on testnet: CG_LONG_VARIANT_MATRIX:CG_EXP_LONG_MFE_GIVEBACK_10X
    // hit Binance -4164 "notional must be no smaller than 5/20" on 104/201 real open attempts (52%)
    // because of exactly this gap — same silent-scale-below-floor bug class as the
    // DIAGNOSTIC_LANE_MIRROR_WEIGHT_PCT incident above, just via a different weight source.
    const entryPrice = planned[0]!.paper.entryPrice;
    const notionalUsd = qty * entryPrice;
    const effectiveRiskUsd = planned.reduce((sum, item) => sum + item.plan.effectiveRiskUsd, 0);
    const ok = qty >= filters.minQty && notionalUsd >= filters.minNotional;
    return {
      ok,
      reason: ok
        ? null
        : qty < filters.minQty
          ? "aggregate quantity below exchange minimum"
          : `aggregate notional below exchange minimum (${filters.minNotional})`,
      qty,
      tp1Qty: fullExitAtTp1 ? qty : roundDownToStep(qty / 2, filters.stepSize),
      notionalUsd,
      plannedRiskUsd: planned.reduce((sum, item) => sum + item.plan.plannedRiskUsd, 0),
      requiredNotionalUsd: planned.reduce((sum, item) => sum + item.plan.requiredNotionalUsd, 0),
      appliedNotionalUsd: notionalUsd,
      notionalCapUsd: planned.reduce((sum, item) => sum + item.plan.notionalCapUsd, 0),
      stopDistancePct: notionalUsd > 0 ? effectiveRiskUsd / notionalUsd : null,
      stopPrice: direction === "LONG" ? Math.max(...stops) : Math.min(...stops),
      tp1Price: direction === "LONG" ? Math.min(...targets) : Math.max(...targets),
      effectiveRiskUsd,
      riskClippedByNotionalCap: planned.some((item) => item.plan.riskClippedByNotionalCap),
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

  /** Recent execution provenance is the fairness denominator, not paper issuance volume. */
  private testnetObservedStratumCounts(intents: readonly LiveIntent[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const intent of intents) {
      const sources = this.intentSources(intent);
      for (const source of sources) {
        const key = testnetCollectionStratumKey({
          selectedLaneId: source.laneId,
          direction: intent.direction,
          regime: source.regime ?? null,
          controllerMode: source.controllerMode ?? "",
        });
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  private paperCompatibleWithIntent(intent: LiveIntent, paper: PaperOrder): boolean {
    if (this.paperExitRule(paper) !== this.intentExitRule(intent)) return false;
    const laneId = paper.selectedLaneId ?? "UNKNOWN";
    const existingLaneIds = new Set(this.intentSources(intent).map((source) => source.laneId));
    if (existingLaneIds.size > 0 && !existingLaneIds.has(laneId)) return false;
    if (!this.config.testnetStratifiedCollection) return true;

    const paperStratum = testnetCollectionStratumKey(paper);
    return this.intentSources(intent).some((source) =>
      testnetCollectionStratumKey({
        selectedLaneId: source.laneId,
        direction: intent.direction,
        regime: source.regime ?? null,
        controllerMode: source.controllerMode ?? "",
      }) === paperStratum,
    );
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
    planned: Array<{
      paper: PaperOrder;
      plan: LiveOrderPlan;
      cortexAppliedWeightPct?: number;
      cortexRawStaticWeightPct?: number;
      externalCopyIdempotencyKey?: string;
    }>,
    filters: FuturesSymbolFilters,
  ): Promise<void> {
    if (!this.canOpenNewEntries()) return;
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
      executionIntentId: paper.paperOrderId,
      positionId: `intent:${paper.paperOrderId}:${now}`,
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
      maxAdverseR: null,
      // Tagged so a losing close of an operator-selected position can auto-reset the selection.
      operatorLaneSelection: this.operatorSelectionActiveFor(paper) || undefined,
      effectiveRiskUsd: plan.effectiveRiskUsd,
      originalRiskUsd: plan.effectiveRiskUsd,
      riskClippedByNotionalCap: plan.riskClippedByNotionalCap,
      plannedRiskUsd: plan.plannedRiskUsd,
      requiredNotionalUsd: plan.requiredNotionalUsd,
      appliedNotionalUsd: plan.appliedNotionalUsd,
      notionalCapUsd: plan.notionalCapUsd,
      stopDistancePct: plan.stopDistancePct,
      externalCopyIdempotencyKey: planned[0]!.externalCopyIdempotencyKey,
      // CORTEX real-USDT attribution capture (2026-07-21, report-only): frozen from the mirror's
      // OWN sizing computation (see mirrorNewSignals), so the pair reflects exactly what sized
      // this entry. Undefined on non-mirror opens (operator copy path) — those are never CORTEX
      // -tilted and are deliberately left out of the attribution sweep.
      cortexAppliedWeightPct: planned[0]!.cortexAppliedWeightPct,
      cortexRawStaticWeightPct: planned[0]!.cortexRawStaticWeightPct,
      executiveReviewLink: paper.executiveReviewLink ?? undefined,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      closeReason: null,
      lastError: null,
      sourcePaperOrders: planned.map(({ paper: source, plan: sourcePlan }) => ({
        paperOrderId: source.paperOrderId,
        laneId: source.selectedLaneId ?? "UNKNOWN",
        qty: sourcePlan.qty,
        sourceObservationId: source.sourceObservationId,
        regime: source.regime ?? null,
        controllerMode: source.controllerMode ?? null,
        controllerConfidence: source.controllerConfidence ?? null,
        executiveReviewLink: source.executiveReviewLink ?? undefined,
      })),
    };
    st.intents.push(intent);
    this.store.save();

    const idTail = paper.paperOrderId.slice(-18);
    // ── Stage-2 execution-lifecycle tap (report-only, default-OFF, fail-open) ──
    // Records the ENTRY order's lifecycle timestamps (decision→submit→ack→fill / reject) for free L1 execution
    // calibration. `recordExecLifecycle` is synchronous, never throws (fail-open inside the runtime), makes no
    // exchange call and mutates nothing — so it cannot alter the awaits/retries/ordering below or the returned
    // result. Gated: ZERO I/O unless EXEC_LIFECYCLE_TIMESTAMPS=1 on 3101/3102 (hard-blocked on live 3103). The
    // stable correlation key is the ENTRY clientOrderId. Stop/TP/exit/flatten/flip order lifecycles are
    // intentionally omitted from this first wiring (surfaced here, not silently) — the entry fill is the signal.
    const entryClientId = `dtc-${idTail}-e`;
    const entryLcSide: "BUY" | "SELL" = paper.direction === "LONG" ? "BUY" : "SELL";
    const logEntryLc = (event: LifecycleEvent, cumulativeFilledQty: number | null = null): void => {
      recordExecLifecycle({
        orderId: entryClientId, decisionId: paper.paperOrderId, event, eventAtMs: Date.now(), exchangeEventAtMs: null,
        symbol: paper.symbol, side: entryLcSide, orderType: "MARKET", requestedQty: plan.qty, cumulativeFilledQty,
        source: "live-execution-engine.openIntent",
      });
    };
    logEntryLc("DECISION"); // the decision to open THIS entry is committed (intent persisted above)
    // Tracks whether the ENTRY order itself reached its fill terminal. The catch below wraps the WHOLE open path
    // (entry + protective stop + TP), so without this a stop/TP placement failure AFTER a filled entry would emit a
    // spurious REJECTED for an order that actually FINAL_FILLed — a double-terminal that corrupts the L1 calibration
    // stream. REJECTED is emitted ONLY when the entry never filled (a genuine entry-submission rejection).
    let entryFilled = false;
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

      logEntryLc("SUBMITTED"); // about to hand the entry order to the exchange
      const entry = await this.client.placeOrder({
        symbol: paper.symbol,
        side: entrySide,
        type: "MARKET",
        quantity: plan.qty,
        newClientOrderId: entryClientId,
      });
      logEntryLc("EXCHANGE_ACK"); // genuine: placeOrder returned the exchange's orderId (never synthesized)
      intent.entryOrderId = entry.orderId;
      intent.entryOrderIds = [entry.orderId];
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
      intent.entryFilledAt = this.nowIso();
      // FINAL_FILL: the entry MARKET fill is resolved. This path observes only the resolved fill, not incremental
      // partials, so FIRST_FILL is intentionally not emitted separately (documented fill contract).
      logEntryLc("FINAL_FILL", plan.qty);
      entryFilled = true; // the entry order is now a filled terminal — a later throw is NOT an entry rejection
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
      // REJECTED covers ONLY a genuine entry-submission failure (the entry never filled). If the entry already
      // FINAL_FILLed and a DOWNSTREAM protective placement (stop/TP) threw, that is NOT an entry rejection — emitting
      // it would double-terminal the entry order (finalFillAt AND rejectedAt) and pollute the L1 calibration stream.
      // The downstream failure's own lifecycle is intentionally not journaled in this first wiring. Report-only; the
      // emergency flatten + error handling below is UNCHANGED.
      if (!entryFilled) logEntryLc("REJECTED");
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
          const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
          const net = settled?.netUsd ?? null;
          intent.realizedPnlUsd = net;
          intent.feesUsd = settled?.feesUsd ?? null;
          intent.feeSource = settled?.feeSource ?? undefined;
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
    if (!this.canOpenNewEntries()) return;
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
      intent.entryOrderIds = Array.from(new Set([
        ...(intent.entryOrderIds ?? (intent.entryOrderId ? [intent.entryOrderId] : [])),
        entry.orderId,
      ]));
      intent.updatedAt = this.nowIso();
      this.store.save();
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
      // R-clipping telemetry: the add carries its own at-risk dollars; accumulate so the intent's
      // effectiveRiskUsd stays the whole position's true R (report-only, same as at open).
      intent.effectiveRiskUsd = (intent.effectiveRiskUsd ?? 0) + addition.effectiveRiskUsd;
      intent.riskClippedByNotionalCap = (intent.riskClippedByNotionalCap ?? false) || addition.riskClippedByNotionalCap;
      intent.plannedRiskUsd = (intent.plannedRiskUsd ?? 0) + addition.plannedRiskUsd;
      intent.requiredNotionalUsd = (intent.requiredNotionalUsd ?? 0) + addition.requiredNotionalUsd;
      intent.appliedNotionalUsd = (intent.appliedNotionalUsd ?? 0) + addition.appliedNotionalUsd;
      intent.notionalCapUsd = (intent.notionalCapUsd ?? 0) + addition.notionalCapUsd;
      intent.stopDistancePct =
        (intent.appliedNotionalUsd ?? 0) > 0
          ? (intent.effectiveRiskUsd ?? 0) / (intent.appliedNotionalUsd as number)
          : intent.stopDistancePct ?? null;
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
          sourceObservationId: paper.sourceObservationId,
          regime: paper.regime ?? null,
          controllerMode: paper.controllerMode ?? null,
          controllerConfidence: paper.controllerConfidence ?? null,
          executiveReviewLink: paper.executiveReviewLink ?? undefined,
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
          const settled = await this.settleIntentAfterClose(intent, [flat.orderId]);
          const net = settled?.netUsd ?? null;
          intent.realizedPnlUsd = net;
          intent.feesUsd = settled?.feesUsd ?? null;
          intent.feeSource = settled?.feeSource ?? undefined;
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
      sourceObservationId: source.sourceObservationId ?? paper?.sourceObservationId ?? null,
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
      sourceObservationId: paper?.sourceObservationId ?? null,
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

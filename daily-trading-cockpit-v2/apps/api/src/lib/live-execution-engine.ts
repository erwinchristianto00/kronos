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
import type { PaperOrder } from "./paper-execution-router.js";

// ─── config ──────────────────────────────────────────────────────────────────

export const LIVE_MAINNET_CONFIRM_PHRASE = "I_UNDERSTAND_REAL_MONEY";

export interface LiveExecutionConfig {
  enabled: boolean;
  env: LiveBinanceEnv | null;
  apiKey: string;
  apiSecret: string;
  riskUsdPerTrade: number;
  maxConcurrentPositions: number;
  dailyMaxLossUsd: number;
  maxConsecutiveLosses: number;
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
    dailyMaxLossUsd: envNum(env.LIVE_DAILY_MAX_LOSS_USD, 15),
    maxConsecutiveLosses: Math.floor(envNum(env.LIVE_MAX_CONSECUTIVE_LOSSES, 5)),
    maxDrawdownUsd: envNum(env.LIVE_MAX_DRAWDOWN_USD, 40),
    defaultLeverage,
    maxLeverage,
    maxNotionalPerTrade: envNum(env.LIVE_MAX_NOTIONAL_PER_TRADE, 250),
    maxPaperOrderAgeMs: Math.floor(envNum(env.LIVE_MAX_PAPER_ORDER_AGE_MS, 10 * 60 * 1000)),
    mirrorAllPaperOrders: env.LIVE_MIRROR_ALL_PAPER === "1" && liveEnv === "testnet",
    testnetTakeProfitUsd: liveEnv === "testnet" ? envNum(env.LIVE_TESTNET_TP_USD, 0) : 0,
    testnetRegimeExitEnabled: liveEnv === "testnet" && env.LIVE_TESTNET_REGIME_EXIT !== "0",
    testnetRegimeHardCutMs: liveEnv === "testnet" ? envNum(env.LIVE_TESTNET_REGIME_HARD_CUT_MS, 30 * 60 * 1000) : 0,
    estimatedCloseCostPct: envNum(env.LIVE_ESTIMATED_CLOSE_COST_PCT, 0.0022),
    autoArm: env.LIVE_AUTO_ARM === "1" && liveEnv === "testnet", // mainnet NEVER auto-arms
    mainnetConfirmed,
    mainnetKeepTestnetPolicy: liveEnv === "mainnet" && env.LIVE_MAINNET_KEEP_TESTNET_POLICY === "1",
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
 * Minimum TP distance from entry for a LIVE order. A TP tighter than this can't clear round-trip
 * costs (taker fees ~0.04%×2 + spread), so the trade is structurally a loser. This is a
 * defense-in-depth gate: it blocks the malformed ~0.14% geometry that churned the early mode-2
 * shorts — regardless of which source produced the order. Coherent lane geometry (0.5R on a
 * >=300bps stop) sits at >=1.5%, far above this floor, so legitimate orders are never blocked.
 */
const MIN_TP_DISTANCE_PCT = 0.003; // 30bps

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
  /** Regime-flip rescue (testnet): true when this intent is the net regime-aligned leg opened by a flip.
   *  Managed only by the rescue flatten — skipped by normal lifecycle + the regime harvest. */
  rescue?: boolean;
  /** Loss already booked to the ledger when the stuck opposing leg was closed at flip (≤ 0). Lets the
   *  flatten trigger know when the WHOLE venture (booked loss + this live leg) is in profit. */
  rescuePriorRealizedUsd?: number;
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
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
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
  yearly: { label: "Yearly", bucketLabel: "5 yearly buckets" },
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
    const parsed = Date.UTC(year - 4, 0, 1);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fallbackYear = new Date(fallbackMs).getUTCFullYear();
  return Date.UTC(fallbackYear - 4, 0, 1);
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
    const bucketStartsMs = Array.from({ length: 5 }, (_, index) => Date.UTC(new Date(sinceMs).getUTCFullYear() + index, 0, 1));
    const untilMs = Date.UTC(new Date(sinceMs).getUTCFullYear() + 5, 0, 1);
    const startYear = isoYear(sinceMs);
    const endYear = `${Number(startYear) + 4}`;
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

export class LiveExecutionEngine {
  private readonly config: LiveExecutionConfig;
  private readonly client: LivePrivateClient;
  private readonly store: LiveExecutionStore;
  private readonly paperStore: PaperStoreReader;
  private readonly isPaperOrderLiveEligible: (order: PaperOrder, nowIso: string) => boolean;
  private readonly getControllerSnapshot: () => LiveControllerSnapshot | null;
  private readonly nowIso: () => string;

  /** In-memory ONLY — restart always boots disarmed. */
  private armed = false;
  private errorStreak = 0;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;
  private reconcileIssues: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private filtersCache: Map<string, FuturesSymbolFilters> | null = null;
  private leverageBySymbol = new Map<string, number>();
  private isolatedMarginSet = new Set<string>();

  constructor(options: LiveExecutionEngineOptions) {
    this.config = options.config;
    this.client = options.client;
    this.store = options.store;
    this.paperStore = options.paperStore;
    this.isPaperOrderLiveEligible = options.isPaperOrderLiveEligible ?? (() => true);
    this.getControllerSnapshot = options.getControllerSnapshot ?? (() => null);
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
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
    this.armed = true;
    return { ok: true, reason: null };
  }

  disarm(reason: string): void {
    this.armed = false;
    this.reconcileIssues.push(`disarmed: ${reason}`);
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
      } catch (error) {
        failed.push({ symbol, action: "marketReduceOnly", reason: (error as Error).message });
      }
    }

    const affectedSymbols = new Set([...symbols]);
    for (const intent of st.intents) {
      if (!OPEN_INTENT_STATES.has(intent.state) || !affectedSymbols.has(intent.symbol)) continue;
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

  /** Clears a latched kill (deliberate operator action via route). */
  resetKill(): void {
    const st = this.store.getState();
    st.killedAt = null;
    st.killReason = null;
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
        dailyMaxLossUsd: this.config.dailyMaxLossUsd,
        maxConsecutiveLosses: this.config.maxConsecutiveLosses,
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
      },
      rescue: {
        enabled: this.config.rescue?.enabled ?? false,
        mode: this.config.rescueExecute ? ("live" as const) : ("shadow" as const),
        config: this.config.rescue,
        lastPlan: st.lastRescuePlan,
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
        if (pos && Math.abs(pos.positionAmt) > 0) {
          await this.client.placeOrder({
            symbol: intent.symbol,
            side: pos.positionAmt > 0 ? "SELL" : "BUY",
            type: "MARKET",
            quantity: Math.abs(pos.positionAmt),
            reduceOnly: true,
            newClientOrderId: `dtc-kill-${intent.paperOrderId.slice(-12)}`,
          });
        }
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

    // Our intents must be backed by a real position in the right direction.
    for (const intent of openIntents) {
      const pos = bySymbol.get(intent.symbol);
      const amt = pos?.positionAmt ?? 0;
      const expectedSign = intent.direction === "LONG" ? 1 : -1;
      if (Math.abs(amt) < 1e-12) continue; // position may have just closed — lifecycle will settle it
      if (Math.sign(amt) !== expectedSign) {
        issues.push(`position direction mismatch on ${intent.symbol}: exchange ${amt}, intent ${intent.direction}`);
      }
    }

    // Exchange positions on symbols the engine never opened = orphans. NEVER auto-flatten
    // (could be the operator's own manual position) — disarm + surface instead.
    const engineSymbols = new Set(st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state)).map((i) => i.symbol));
    for (const pos of positions) {
      if (Math.abs(pos.positionAmt) > 1e-12 && !engineSymbols.has(pos.symbol)) {
        issues.push(`orphan exchange position ${pos.symbol} amt=${pos.positionAmt} (not opened by engine)`);
      }
    }

    if (issues.length > 0) {
      this.reconcileIssues.push(...issues);
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
        const amt = pos?.positionAmt ?? 0;

        // Position flat ⇒ closed (stop, breakeven stop, or full TP fill chain).
        if (Math.abs(amt) < 1e-12) {
          await this.settleClosedIntent(intent);
          dirty = true;
          continue;
        }

        const usdTp = await this.maybeCloseOnTestnetUsdTakeProfit(intent, pos, amt);
        if (usdTp.changed) dirty = true;
        if (usdTp.closed) continue;

        if (pos) {
          const liveBreakeven = await this.maybeCloseLiveBreakevenLaneAfterCost(intent, pos, amt);
          if (liveBreakeven.changed) dirty = true;
          if (liveBreakeven.closed) continue;
        }

        if (pos && intent.state === "OPEN" && this.intentExitRule(intent) === "mfe_giveback") {
          const mfe = await this.manageMfeGiveback(intent, pos, amt);
          if (mfe.changed) dirty = true;
          if (mfe.closed) continue;
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
  ): Promise<{ changed: boolean; closed: boolean }> {
    // Runs on both real envs (mainnet + testnet) — operator wants the long-lane positions to bail
    // the instant they're net-positive everywhere they exist.
    if (this.config.env !== "mainnet" && this.config.env !== "testnet") return { changed: false, closed: false };
    if (!this.intentHasLiveBreakevenExitLane(intent)) return { changed: false, closed: false };
    const expectedSign = intent.direction === "LONG" ? 1 : -1;
    if (Math.sign(amt) !== expectedSign) return { changed: false, closed: false };

    const estimatedCloseCostUsd = this.estimatedCloseCostUsd(pos);
    const netAfterCost = pos.unRealizedProfit - estimatedCloseCostUsd;
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

  private async maybeCloseTestnetRegimeHarvest(): Promise<void> {
    if (this.config.env !== "testnet" || !this.config.testnetRegimeExitEnabled) return;
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
    const hardCut = opposingDirection !== null
      && this.config.testnetRegimeHardCutMs > 0
      && st.opposingSince !== null
      && new Date(this.nowIso()).getTime() - new Date(st.opposingSince).getTime() >= this.config.testnetRegimeHardCutMs;
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

    for (const intent of harvestIntents) {
      const pos = bySymbol.get(intent.symbol);
      const amt = pos?.positionAmt ?? 0;
      if (!pos || Math.abs(amt) < 1e-12) continue;
      const expectedSign = intent.direction === "LONG" ? 1 : -1;
      if (Math.sign(amt) !== expectedSign) continue;

      const estimatedCloseCostUsd = this.estimatedCloseCostUsd(pos);
      const netAfterCost = pos.unRealizedProfit - estimatedCloseCostUsd;
      const green = Number.isFinite(netAfterCost) && netAfterCost >= 0;
      // Cut RED positions ONLY when a sustained bull opposes them (hard-cut), never our own side.
      const hardCutThis = hardCut && opposingDirection !== null && intent.direction === opposingDirection;
      if (!green && !hardCutThis) continue; // red & not a sustained-opposition cut → leave to its stop

      const flat = await this.client.placeOrder({
        symbol: intent.symbol,
        side: amt > 0 ? "SELL" : "BUY",
        type: "MARKET",
        quantity: Math.abs(amt),
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
        ? `REGIME_OPPOSITION_HARD_CUT_${currentMode ?? "UNKNOWN"}`
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
          this.reconcileIssues.push(`rescue flatten ${action.symbol} failed: ${(error as Error).message}`);
        }
      }
      // Flips OPEN new exposure — only when armed.
      if (this.armed) {
        for (const action of plan.flips) {
          try {
            await this.executeRescueFlip(action, openIntents.filter((i) => i.symbol === action.symbol && !i.rescue));
          } catch (error) {
            this.reconcileIssues.push(`rescue flip ${action.symbol} failed: ${(error as Error).message}`);
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

    const st = this.store.getState();
    st.intents.push({
      paperOrderId: `rescue-${action.symbol}-${this.nowIso()}`,
      symbol: action.symbol,
      direction: netAmt > 0 ? "LONG" : "SHORT",
      state: "OPEN",
      qty: Math.abs(netAmt),
      tp1Qty: 0,
      plannedEntryPrice: after?.entryPrice ?? flip.avgPrice ?? 0,
      stopLossPrice: 0,
      tp1Price: 0,
      filledEntryPrice: flip.avgPrice ?? after?.entryPrice ?? null,
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
  ): Promise<{ changed: boolean; closed: boolean }> {
    const threshold = this.config.env === "testnet" ? this.config.testnetTakeProfitUsd : 0;
    if (!(threshold > 0)) return { changed: false, closed: false };
    const unrealized = pos?.unRealizedProfit ?? 0;
    if (!Number.isFinite(unrealized) || unrealized < threshold) return { changed: false, closed: false };

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
    intent.closeReason = `TESTNET_USD_TP_${threshold.toFixed(2)}`;
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
    const isLoss = classification === "adverse" || net < 0;
    if (isLoss) {
      st.dailyLedger.losses += 1;
      st.consecutiveLosses += 1;
    } else {
      st.dailyLedger.wins += 1;
      st.consecutiveLosses = 0;
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

    const candidates = this.paperStore.all
      .filter(
        (o) =>
          (this.config.mirrorAllPaperOrders ||
            (o.paperOrderMode === "HEADLINE" &&
              this.isFreshPaperOrder(o, now) &&
              this.isPaperOrderLiveEligible(o, now))) &&
          o.diagnosticLabel == null &&
          MIRRORABLE_PAPER_STATUSES.has(o.paperStatus) &&
          (this.config.mirrorAllPaperOrders || o.createdAt > st.lastSeenCreatedAt) &&
          !mirrored.has(o.paperOrderId) &&
          (st.mirrorAttempts[o.paperOrderId] ?? 0) < MAX_MIRROR_ATTEMPTS, // quarantine repeated open failures
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    let slots = Math.max(0, this.config.maxConcurrentPositions - openCount);
    let maxSeen = st.lastSeenCreatedAt;

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
      if (oppositeIntent && oppositeIntent.direction !== first.direction) continue;
      if (!oppositeIntent && slots <= 0) continue;
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
        return plan.ok ? [{ paper, plan }] : [];
      });
      if (planned.length === 0) continue;

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
      } else {
        await this.openIntent(planned, filters);
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

    if (maxSeen !== st.lastSeenCreatedAt) {
      st.lastSeenCreatedAt = maxSeen;
      this.store.save();
    } else if (pruned) {
      this.store.save();
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
      intent.filledEntryPrice = entry.avgPrice > 0 ? entry.avgPrice : paper.entryPrice;
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
        const amt = positions.find((p) => p.symbol === paper.symbol)?.positionAmt ?? 0;
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
    const idTail = planned[0]!.paper.paperOrderId.slice(-18);

    // STEP 1 — place the add entry while the EXISTING stop/TP still protect the position. If the
    // add fails (e.g. a 6s MARKET timeout), the original protection is untouched, so we skip this
    // add and let a later tick retry — never flattening a healthy (often winning) position. The old
    // ordering cancelled the stop FIRST, so an add timeout left the position naked and dumped it at
    // market (EMERGENCY_FLATTEN_ADD_FAILED — the bleed).
    let entry: FuturesOrder;
    try {
      await this.ensureSymbolLeverage(intent.symbol, this.leverageForPlanned(planned));
      entry = await this.client.placeOrder({
        symbol: intent.symbol,
        side: intent.direction === "LONG" ? "BUY" : "SELL",
        type: "MARKET",
        quantity: addition.qty,
        newClientOrderId: `dtc-${idTail}-a`,
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
      const newFill = entry.avgPrice > 0 ? entry.avgPrice : planned[0]!.paper.entryPrice;
      intent.filledEntryPrice = ((oldFill * oldQty) + (newFill * addition.qty)) / totalQty;
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
        const amt = positions.find((p) => p.symbol === intent.symbol)?.positionAmt ?? 0;
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

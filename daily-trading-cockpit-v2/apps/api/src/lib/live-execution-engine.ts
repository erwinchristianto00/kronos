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
  maxLeverage: number;
  maxNotionalPerTrade: number;
  /**
   * Normal live mirror freshness window for paper HEADLINE orders. Prevents a re-arm from
   * backfilling hours-old paper signals whose market context has already drifted.
   */
  maxPaperOrderAgeMs: number;
  /** Testnet-only: mirror every open paper order, including diagnostic lanes and pre-restart orders. */
  mirrorAllPaperOrders: boolean;
  autoArm: boolean;
  mainnetConfirmed: boolean;
  /** Why the config cannot trade (empty = config valid for its env). */
  configErrors: string[];
}

function envNum(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    maxLeverage: Math.floor(envNum(env.LIVE_MAX_LEVERAGE, 2)),
    maxNotionalPerTrade: envNum(env.LIVE_MAX_NOTIONAL_PER_TRADE, 250),
    maxPaperOrderAgeMs: Math.floor(envNum(env.LIVE_MAX_PAPER_ORDER_AGE_MS, 10 * 60 * 1000)),
    mirrorAllPaperOrders: env.LIVE_MIRROR_ALL_PAPER === "1" && liveEnv === "testnet",
    autoArm: env.LIVE_AUTO_ARM === "1" && liveEnv === "testnet", // mainnet NEVER auto-arms
    mainnetConfirmed,
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
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  lastError: string | null;
  /** Paper orders netted into this one-way Binance symbol position. */
  sourcePaperOrders?: LiveIntentSource[];
}

export interface LiveIntentSource {
  paperOrderId: string;
  laneId: string;
  qty: number;
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
  killedAt: string | null;
  killReason: string | null;
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
      killedAt: null,
      killReason: null,
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
  nowIso?: () => string;
}

const ERROR_STREAK_DISARM = 3;
const OPEN_INTENT_STATES: ReadonlySet<LiveIntentState> = new Set(["MIRRORED", "ENTRY_PLACED", "OPEN", "TP1_FILLED_BE_SET"]);
const MIRRORABLE_PAPER_STATUSES: ReadonlySet<string> = new Set(["CREATED", "PAPER_SUBMITTED"]);
/**
 * A paper order whose live open fails this many times is quarantined — never re-mirrored.
 * Without this latch a signal that deterministically fails to open (e.g. the protective stop
 * is rejected -2021 because price gapped past it before the MARKET filled) is retried every
 * tick, each cycle paying entry+exit slippage+fees for nothing. Two attempts tolerates a
 * single transient blip while bounding a churn storm to 2 cycles instead of hundreds.
 */
const MAX_MIRROR_ATTEMPTS = 2;

export class LiveExecutionEngine {
  private readonly config: LiveExecutionConfig;
  private readonly client: LivePrivateClient;
  private readonly store: LiveExecutionStore;
  private readonly paperStore: PaperStoreReader;
  private readonly isPaperOrderLiveEligible: (order: PaperOrder, nowIso: string) => boolean;
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
  private leverageSet = new Set<string>();

  constructor(options: LiveExecutionEngineOptions) {
    this.config = options.config;
    this.client = options.client;
    this.store = options.store;
    this.paperStore = options.paperStore;
    this.isPaperOrderLiveEligible = options.isPaperOrderLiveEligible ?? (() => true);
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
        maxLeverage: this.config.maxLeverage,
        maxNotionalPerTrade: this.config.maxNotionalPerTrade,
        maxPaperOrderAgeMs: this.config.maxPaperOrderAgeMs,
        mirrorAllPaperOrders: this.config.mirrorAllPaperOrders,
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
      unrealizedPnl: number;
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
  }> {
    const [balance, rawPositions, openOrders] = await Promise.all([
      this.getUsdtBalance(),
      this.client.getPositions(),
      this.client.getOpenOrders(),
    ]);
    const positions = rawPositions.filter((position) => Math.abs(position.positionAmt) > 1e-12);
    const openIntents = this.store.getState().intents.filter((intent) => OPEN_INTENT_STATES.has(intent.state));
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
      const sources = intent ? this.intentSources(intent) : [];
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
      return {
        symbol: position.symbol,
        direction: position.positionAmt > 0 ? "LONG" as const : "SHORT" as const,
        quantity: Math.abs(position.positionAmt),
        entryPrice: position.entryPrice,
        unrealizedPnl: position.unRealizedProfit,
        leverage: position.leverage,
        sourceOrderCount: sources.length,
        laneIds: Array.from(new Set(sources.map((source) => source.laneId))),
      };
    });
    const unrealizedPnl = positions.reduce((sum, position) => sum + position.unRealizedProfit, 0);

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
    };
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

      // 4. Mirror new HEADLINE paper orders (only when armed + healthy).
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
      try {
        const positions = await this.client.getPositions(intent.symbol);
        const amt = positions.find((p) => p.symbol === intent.symbol)?.positionAmt ?? 0;

        // Position flat ⇒ closed (stop, breakeven stop, or full TP fill chain).
        if (Math.abs(amt) < 1e-12) {
          await this.settleClosedIntent(intent);
          dirty = true;
          continue;
        }

        // TP1 filled ⇒ move stop to breakeven for the runner (cancel + replace).
        if (intent.state === "OPEN" && intent.tp1OrderId !== null) {
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

      const filters = await this.getFilters(first.symbol);
      if (!filters) continue;
      const planned = papers.flatMap((paper) => {
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
    const fullExitAtTp1 = planned[0]!.paper.variantExitRule === "tp1_full";
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
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      closeReason: null,
      lastError: null,
      sourcePaperOrders: planned.map(({ paper: source, plan: sourcePlan }) => ({
        paperOrderId: source.paperOrderId,
        laneId: source.selectedLaneId,
        qty: sourcePlan.qty,
      })),
    };
    st.intents.push(intent);
    this.store.save();

    const idTail = paper.paperOrderId.slice(-18);
    try {
      // One-time leverage/margin setup per symbol.
      if (!this.leverageSet.has(paper.symbol)) {
        await this.client.setLeverage(paper.symbol, this.config.maxLeverage);
        try {
          await this.client.setIsolatedMargin(paper.symbol);
        } catch (error) {
          // isolated is preferred, not required (fails when a position already exists)
          intent.lastError = `isolated margin not set: ${(error as Error).message}`;
        }
        this.leverageSet.add(paper.symbol);
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
    try {
      if (intent.stopOrderId !== null) await this.client.cancelAlgoOrder(intent.stopOrderId);
      if (intent.tp1OrderId !== null) await this.client.cancelOrder(intent.symbol, intent.tp1OrderId);

      const entry = await this.client.placeOrder({
        symbol: intent.symbol,
        side: intent.direction === "LONG" ? "BUY" : "SELL",
        type: "MARKET",
        quantity: addition.qty,
        newClientOrderId: `dtc-${idTail}-a`,
      });
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
      intent.tp1Qty = roundDownToStep(totalQty / 2, filters.stepSize);
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
          laneId: paper.selectedLaneId,
          qty: plan.qty,
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

  private intentSources(intent: LiveIntent): LiveIntentSource[] {
    if (intent.sourcePaperOrders && intent.sourcePaperOrders.length > 0) return intent.sourcePaperOrders;
    const paper = this.paperStore.all.find((order) => order.paperOrderId === intent.paperOrderId);
    return [{
      paperOrderId: intent.paperOrderId,
      laneId: paper?.selectedLaneId ?? "UNKNOWN",
      qty: intent.qty,
    }];
  }

  private async getFilters(symbol: string): Promise<FuturesSymbolFilters | null> {
    if (!this.filtersCache) {
      this.filtersCache = await this.client.getExchangeFilters();
    }
    return this.filtersCache.get(symbol) ?? null;
  }
}

const RETRY_FATAL: ReadonlySet<string> = new Set(["timeout", "429", "network", "clock_skew"]);

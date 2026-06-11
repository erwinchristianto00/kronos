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
  type PlaceOrderParams,
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
  | "queryOrder"
  | "placeOrder"
  | "cancelOrder"
  | "cancelAllOrders"
  | "getUserTrades"
>;

export interface LiveExecutionEngineOptions {
  config: LiveExecutionConfig;
  client: LivePrivateClient;
  store: LiveExecutionStore;
  paperStore: PaperStoreReader;
  nowIso?: () => string;
}

const ERROR_STREAK_DISARM = 3;
const OPEN_INTENT_STATES: ReadonlySet<LiveIntentState> = new Set(["MIRRORED", "ENTRY_PLACED", "OPEN", "TP1_FILLED_BE_SET"]);
const MIRRORABLE_PAPER_STATUSES: ReadonlySet<string> = new Set(["CREATED", "PAPER_SUBMITTED"]);

export class LiveExecutionEngine {
  private readonly config: LiveExecutionConfig;
  private readonly client: LivePrivateClient;
  private readonly store: LiveExecutionStore;
  private readonly paperStore: PaperStoreReader;
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
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    if (this.config.autoArm && this.config.configErrors.length === 0) this.armed = true;
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
      },
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

    const positions = await this.client.getPositions();
    const bySymbol = new Map(positions.map((p) => [p.symbol, p]));

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
                await this.client.cancelOrder(intent.symbol, intent.stopOrderId);
              } catch {
                // stop may already be gone — reconcile surfaces real residue
              }
            }
            const runnerQty = Math.abs(amt);
            const breakeven = intent.filledEntryPrice ?? intent.plannedEntryPrice;
            const beOrder = await this.client.placeOrder({
              symbol: intent.symbol,
              side: intent.direction === "LONG" ? "SELL" : "BUY",
              type: "STOP_MARKET",
              quantity: runnerQty,
              stopPrice: breakeven,
              reduceOnly: true,
              workingType: "CONTRACT_PRICE",
              newClientOrderId: `dtc-${intent.paperOrderId.slice(-18)}-be`,
            });
            intent.beStopOrderId = beOrder.orderId;
            intent.state = "TP1_FILLED_BE_SET";
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
    } catch {
      // best-effort cleanup; reconcile surfaces residue
    }
    let realized = 0;
    let fees = 0;
    try {
      const trades = await this.client.getUserTrades(intent.symbol, {
        startTime: new Date(intent.createdAt).getTime(),
        limit: 200,
      });
      const ourOrderIds = new Set(
        [intent.entryOrderId, intent.stopOrderId, intent.tp1OrderId, intent.beStopOrderId].filter(
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

    const st = this.store.getState();
    this.rollDailyLedger();
    st.dailyLedger.realizedPnlUsd += net;
    if (net < 0) {
      st.dailyLedger.losses += 1;
      st.consecutiveLosses += 1;
    } else {
      st.dailyLedger.wins += 1;
      st.consecutiveLosses = 0;
    }
    st.totalRealizedPnlUsd += net;
    if (st.totalRealizedPnlUsd > st.realizedPeakUsd) st.realizedPeakUsd = st.totalRealizedPnlUsd;
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

    const mirrored = new Set(st.intents.map((i) => i.paperOrderId));
    const openCount = st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state)).length;
    const openSymbols = new Set(st.intents.filter((i) => OPEN_INTENT_STATES.has(i.state)).map((i) => i.symbol));

    const candidates = this.paperStore.all
      .filter(
        (o) =>
          o.paperOrderMode === "HEADLINE" &&
          o.diagnosticLabel == null &&
          MIRRORABLE_PAPER_STATUSES.has(o.paperStatus) &&
          o.createdAt > st.lastSeenCreatedAt &&
          !mirrored.has(o.paperOrderId),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    let slots = Math.max(0, this.config.maxConcurrentPositions - openCount);
    let maxSeen = st.lastSeenCreatedAt;

    for (const paper of candidates) {
      if (paper.createdAt > maxSeen) maxSeen = paper.createdAt;
      if (slots <= 0) continue; // watermark still advances: stale signals are NOT queued for later
      if (openSymbols.has(paper.symbol)) continue;
      const tp1 = paper.takeProfitLevels?.[0];
      if (typeof tp1 !== "number" || !(tp1 > 0)) continue;

      const filters = await this.getFilters(paper.symbol);
      if (!filters) continue;
      const plan = computeLiveOrderPlan(
        { direction: paper.direction, entryPrice: paper.entryPrice, stopLoss: paper.stopLoss, tp1 },
        this.config,
        filters,
      );
      if (!plan.ok) continue;

      await this.openIntent(paper, plan);
      openSymbols.add(paper.symbol);
      slots -= 1;
    }

    if (maxSeen !== st.lastSeenCreatedAt) {
      st.lastSeenCreatedAt = maxSeen;
      this.store.save();
    }
  }

  private async openIntent(paper: PaperOrder, plan: LiveOrderPlan): Promise<void> {
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
      intent.state = "ENTRY_PLACED";
      intent.updatedAt = this.nowIso();
      this.store.save();

      const protective: PlaceOrderParams = {
        symbol: paper.symbol,
        side: exitSide,
        type: "STOP_MARKET",
        quantity: plan.qty,
        stopPrice: plan.stopPrice,
        reduceOnly: true,
        workingType: "CONTRACT_PRICE", // matches the candle-walk sim (last price, not mark)
        newClientOrderId: `dtc-${idTail}-s`,
      };
      const stop = await this.client.placeOrder(protective);
      intent.stopOrderId = stop.orderId;

      if (plan.tp1Qty > 0) {
        const tp1Order = await this.client.placeOrder({
          symbol: paper.symbol,
          side: exitSide,
          type: "LIMIT",
          quantity: plan.tp1Qty,
          price: plan.tp1Price,
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
        const positions = await this.client.getPositions(paper.symbol);
        const amt = positions.find((p) => p.symbol === paper.symbol)?.positionAmt ?? 0;
        if (Math.abs(amt) > 1e-12) {
          await this.client.placeOrder({
            symbol: paper.symbol,
            side: amt > 0 ? "SELL" : "BUY",
            type: "MARKET",
            quantity: Math.abs(amt),
            reduceOnly: true,
            newClientOrderId: `dtc-${idTail}-x`,
          });
          intent.closeReason = "EMERGENCY_FLATTEN_NO_STOP";
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

  private async getFilters(symbol: string): Promise<FuturesSymbolFilters | null> {
    if (!this.filtersCache) {
      this.filtersCache = await this.client.getExchangeFilters();
    }
    return this.filtersCache.get(symbol) ?? null;
  }
}

const RETRY_FATAL: ReadonlySet<string> = new Set(["timeout", "429", "network", "clock_skew"]);

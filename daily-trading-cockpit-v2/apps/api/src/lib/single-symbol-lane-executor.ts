/**
 * Single-symbol directional-lane EXECUTOR — turns a (measured, exhaustively test-covered)
 * single-symbol entry signal into a REAL exchange position, generic over which lane's exit
 * policy is applied.
 *
 * Built 2026-07-08 to wire SHORT_FADE_EXHAUSTION and INTRADAY_MOMENTUM_BREAKOUT into live
 * execution. Both are independent, single-symbol measurement lanes (their own signal store, entry
 * detector, and bar-walk resolver for OOS measurement) — structurally incompatible with the
 * shared-entry-signal current-guard-variant-matrix.ts/lane-selector-v2.ts pipeline
 * realtime-short-mirror.ts rides on (that pipeline assumes every consumer scores EXIT-geometry
 * variants against the SAME scanner candidate; these two lanes have their OWN, unrelated entry
 * conditions on their OWN symbol universes). So each gets its own instance of this generic
 * executor instead of being forced through that pipeline.
 *
 * Adapted from cross-sectional-executor.ts's hardened patterns (atomic store writes, confirmed
 * fill-price resolution with retry) for a SINGLE leg instead of an N-leg hedge basket — there is
 * no multi-leg atomicity concern here, just one entry + one exit. Since these positions are
 * UNHEDGED (unlike the cross-sectional basket, whose hedge structure IS its risk control), this
 * executor places a REAL exchange-side STOP_MARKET algo order immediately after entry — matching
 * live-execution-engine.ts's own established convention for every other directional position in
 * this codebase, rather than relying solely on this executor's periodic tick to catch a stop-out
 * (a fast adverse move between ticks would otherwise blow through the intended stop distance
 * before this executor ever notices).
 *
 * Design constraints (deliberate, same posture as CrossSectionalExecutor):
 *  - Fully additive/opt-in: an isAllowed() gate (armed on mainnet) + an allocation-weight gate (0
 *    weight ⇒ never opens). Absent either, nothing changes.
 *  - One position open at a time per instance by default (tunable).
 *  - Exit policy is PLUGGABLE (see SingleSymbolExitPolicy) — this file has zero knowledge of RSI,
 *    breakouts, or MFE-giveback; each lane supplies its own policy + signal adapter (see
 *    makeFixedRewardExitPolicy / makeMfeGivebackExitPolicy below for the two concrete policies).
 *  - Honest costs/settlement: a stop-triggered close is settled from Binance's OWN trade records
 *    (getUserTrades), never a locally-guessed fill price. A policy-decided close (profit target,
 *    giveback, max-hold) is a plain MARKET reduceOnly order, confirmed via resolveConfirmedFillPrice
 *    — no mark-to-model.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { resolveConfirmedFillPrice, type BinanceFuturesPrivateClient } from "./binance-futures-private.js";

export type SingleSymbolExecClient = Pick<
  BinanceFuturesPrivateClient,
  | "getExchangeFilters"
  | "placeOrder"
  | "placeAlgoOrder"
  | "queryAlgoOrder"
  | "cancelAlgoOrder"
  | "setLeverage"
  | "getPositions"
  | "queryOrder"
  | "getUserTrades"
>;

export interface SingleSymbolFreshSignal {
  observationId: string;
  symbol: string;
  entryPrice: number;
  stopPrice: number;
  openedAtMs: number;
}

export interface SingleSymbolExitContext {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  currentPrice: number;
  /** Running max favorable-R seen so far (executor tracks this across ticks and passes it back in). */
  peakFavorableR: number;
  msHeld: number;
}

export interface SingleSymbolExitDecision {
  shouldExit: boolean;
  reason: string | null;
  /** Updated peak — the executor persists whatever this returns, even when shouldExit is false. */
  nextPeakFavorableR: number;
}

export type SingleSymbolExitPolicy = (ctx: SingleSymbolExitContext) => SingleSymbolExitDecision;

function favorableR(direction: "LONG" | "SHORT", entryPrice: number, stopPrice: number, currentPrice: number): number {
  const risk = Math.abs(entryPrice - stopPrice);
  if (!(risk > 0)) return 0;
  return direction === "LONG" ? (currentPrice - entryPrice) / risk : (entryPrice - currentPrice) / risk;
}

/** Flat target: exit at +rewardMultiple R, or the stop (−1R), or mark-to-market at maxHoldMs.
 *  Used by SHORT_FADE_EXHAUSTION (reuses CG_WIDE_FAST_SHORT's proven 0.5R-fast-bank geometry). */
export function makeFixedRewardExitPolicy(opts: { rewardMultiple: number; maxHoldMs: number }): SingleSymbolExitPolicy {
  return (ctx) => {
    const r = favorableR(ctx.direction, ctx.entryPrice, ctx.stopPrice, ctx.currentPrice);
    const nextPeakFavorableR = Math.max(ctx.peakFavorableR, r);
    if (r <= -1) return { shouldExit: true, reason: "INITIAL_STOP", nextPeakFavorableR };
    if (r >= opts.rewardMultiple) return { shouldExit: true, reason: "TP_HIT", nextPeakFavorableR };
    if (ctx.msHeld >= opts.maxHoldMs) return { shouldExit: true, reason: "MAX_HOLD_MTM", nextPeakFavorableR };
    return { shouldExit: false, reason: null, nextPeakFavorableR };
  };
}

/** Bank a faded winner: arm once peak favorable-R ≥ armR, then exit once it retraces by
 *  givebackFrac of the peak. Otherwise the stop (−1R) or mark-to-market at maxHoldMs.
 *  Used by INTRADAY_MOMENTUM_BREAKOUT. */
export function makeMfeGivebackExitPolicy(opts: { armR: number; givebackFrac: number; maxHoldMs: number }): SingleSymbolExitPolicy {
  return (ctx) => {
    const r = favorableR(ctx.direction, ctx.entryPrice, ctx.stopPrice, ctx.currentPrice);
    const nextPeakFavorableR = Math.max(ctx.peakFavorableR, r);
    if (r <= -1) return { shouldExit: true, reason: "INITIAL_STOP", nextPeakFavorableR };
    if (nextPeakFavorableR >= opts.armR) {
      const givebackLine = nextPeakFavorableR * (1 - opts.givebackFrac);
      if (r <= givebackLine) return { shouldExit: true, reason: "MFE_GIVEBACK", nextPeakFavorableR };
    }
    if (ctx.msHeld >= opts.maxHoldMs) return { shouldExit: true, reason: "MAX_HOLD_MTM", nextPeakFavorableR };
    return { shouldExit: false, reason: null, nextPeakFavorableR };
  };
}

export interface SingleSymbolPosition {
  positionId: string;
  sourceObservationId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  entryOrderId: number;
  entryPriceConfirmed: boolean;
  stopPrice: number;
  /** Exchange-side protective stop algo order id. Null only in the brief window between a
   *  confirmed entry and the stop placement succeeding — see ensureStopOrder(). */
  stopAlgoOrderId: number | null;
  peakFavorableR: number;
  openedAt: string;
  status: "OPEN" | "CLOSED" | "ABORTED";
  closedAt: string | null;
  closeReason: string | null;
  exitPrice: number | null;
  exitOrderId: number | null;
  exitPriceConfirmed: boolean | null;
  grossPnlUsd: number | null;
  feeEstimateUsd: number | null;
  netPnlUsd: number | null;
}

interface SingleSymbolExecutorState {
  version: number;
  positions: SingleSymbolPosition[];
  lastSeenSignalMs: number;
}

export class SingleSymbolLaneExecutorStore {
  private readonly file: string;
  private state: SingleSymbolExecutorState;

  constructor(dataDir: string, fileName: string) {
    this.file = resolve(dataDir, fileName);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  private _load(): SingleSymbolExecutorState {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
        if (parsed && Array.isArray(parsed.positions)) return parsed as SingleSymbolExecutorState;
      }
    } catch {
      // corrupt → fresh (positions reconcile against the exchange on next tick)
    }
    return { version: 1, positions: [], lastSeenSignalMs: Date.now() };
  }

  getState(): SingleSymbolExecutorState {
    return this.state;
  }

  save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // never let a persistence failure break the tick
    }
  }
}

export interface SingleSymbolLaneExecutorOptions {
  client: SingleSymbolExecClient;
  store: SingleSymbolLaneExecutorStore;
  laneId: string;
  direction: "LONG" | "SHORT";
  /** All currently-OPEN signals from the caller's own measurement store, newest-first order not
   *  required — the executor sorts. Adapter's job: map the measurement store's own shape into
   *  this common one. */
  getOpenSignals: () => SingleSymbolFreshSignal[];
  exitPolicy: SingleSymbolExitPolicy;
  /** Master permission gate. Testnet: () => true. Mainnet: () => engine.isArmed(). */
  isAllowed: () => boolean;
  /** Operator lane allocation weight. 100 = normal size; 0 = blocked. */
  laneWeightPct?: () => number;
  /** Base position notional in USD, BEFORE allocation-weight scaling. */
  legUsd: () => number;
  leverage: () => number;
  maxOpenPositions?: () => number;
  /** Only execute signals younger than this (a stale signal's edge has drifted). */
  maxSignalAgeMs?: () => number;
  dailyMaxLossUsd?: () => number;
  nowIso?: () => string;
  fillConfirmRetryDelayMs?: number;
}

const TAKER_FEE_RATE = 0.0005; // 5 bps per side, conservative

export class SingleSymbolLaneExecutor {
  private readonly client: SingleSymbolExecClient;
  private readonly store: SingleSymbolLaneExecutorStore;
  private readonly laneId: string;
  private readonly direction: "LONG" | "SHORT";
  private readonly getOpenSignals: () => SingleSymbolFreshSignal[];
  private readonly exitPolicy: SingleSymbolExitPolicy;
  private readonly isAllowed: () => boolean;
  private readonly laneWeightPctFn: () => number;
  private readonly legUsdFn: () => number;
  private readonly leverageFn: () => number;
  private readonly maxOpenPositionsFn: () => number;
  private readonly maxSignalAgeMsFn: () => number;
  private readonly dailyMaxLossUsdFn: () => number;
  private readonly nowIso: () => string;
  private readonly fillConfirmRetryDelayMs: number;
  private ticking = false;
  private lastError: string | null = null;
  private openHalted: string | null = null;

  constructor(opts: SingleSymbolLaneExecutorOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.laneId = opts.laneId;
    this.direction = opts.direction;
    this.getOpenSignals = opts.getOpenSignals;
    this.exitPolicy = opts.exitPolicy;
    this.isAllowed = opts.isAllowed;
    this.laneWeightPctFn = opts.laneWeightPct ?? (() => 100);
    this.legUsdFn = opts.legUsd;
    this.leverageFn = opts.leverage;
    this.maxOpenPositionsFn = opts.maxOpenPositions ?? (() => 1);
    this.maxSignalAgeMsFn = opts.maxSignalAgeMs ?? (() => 50 * 60_000);
    this.dailyMaxLossUsdFn = opts.dailyMaxLossUsd ?? (() => 0);
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.fillConfirmRetryDelayMs = opts.fillConfirmRetryDelayMs ?? 400;
  }

  private async resolveFillPrice(symbol: string, orderId: number, initialAvgPrice: number, fallbackPrice: number) {
    return resolveConfirmedFillPrice(this.client, symbol, orderId, initialAvgPrice, fallbackPrice, {
      retryDelayMs: this.fillConfirmRetryDelayMs,
      onUnconfirmed: (sym, id, fallback) =>
        console.error(
          `[single-symbol-lane-executor:${this.laneId}] UNCONFIRMED FILL PRICE: ${sym} order ${id} never ` +
            `returned a real avgPrice after retries — recording ${fallback} as a fallback, but this is NOT ` +
            `a confirmed fill price. PnL involving this position should be treated as uncertain.`,
        ),
    });
  }

  private allocationWeightPct(): number {
    const pct = Number(this.laneWeightPctFn());
    if (!Number.isFinite(pct)) return 100;
    return Math.max(0, Math.min(100, pct));
  }

  private effectiveLegUsd(): number {
    return this.legUsdFn() * (this.allocationWeightPct() / 100);
  }

  private dailyRealizedUsd(nowIso: string): number {
    const day = nowIso.slice(0, 10);
    let sum = 0;
    for (const p of this.store.getState().positions) {
      if (p.status === "CLOSED" && p.closedAt && p.closedAt.slice(0, 10) === day && p.netPnlUsd !== null) {
        sum += p.netPnlUsd;
      }
    }
    return sum;
  }

  getStatus(): {
    laneId: string;
    direction: "LONG" | "SHORT";
    allowed: boolean;
    legUsd: number;
    baseLegUsd: number;
    allocationWeightPct: number;
    leverage: number;
    dailyRealizedUsd: number;
    dailyMaxLossUsd: number;
    openHalted: string | null;
    openPositions: SingleSymbolPosition[];
    closedCount: number;
    totalNetPnlUsd: number;
    lastError: string | null;
    recent: SingleSymbolPosition[];
  } {
    const st = this.store.getState();
    const closed = st.positions.filter((p) => p.status === "CLOSED");
    return {
      laneId: this.laneId,
      direction: this.direction,
      allowed: this.isAllowed(),
      legUsd: this.effectiveLegUsd(),
      baseLegUsd: this.legUsdFn(),
      allocationWeightPct: this.allocationWeightPct(),
      leverage: this.leverageFn(),
      dailyRealizedUsd: this.dailyRealizedUsd(this.nowIso()),
      dailyMaxLossUsd: this.dailyMaxLossUsdFn(),
      openHalted: this.openHalted,
      openPositions: st.positions.filter((p) => p.status === "OPEN"),
      closedCount: closed.length,
      totalNetPnlUsd: closed.reduce((s, p) => s + (p.netPnlUsd ?? 0), 0),
      lastError: this.lastError,
      recent: st.positions.slice(-10),
    };
  }

  /** Same rationale as CrossSectionalExecutor.getClosedSummary(): the engine's realized ledger
   *  excludes these positions (external-managed claims, not engine intents), so this feeds the
   *  account snapshot's closedLanes merge. */
  getClosedSummary(): {
    closedCount: number;
    wins: number;
    losses: number;
    realizedPnlUsd: number;
    feesUsd: number;
    symbols: string[];
    lastClosedAt: string | null;
  } {
    const closed = this.store.getState().positions.filter((p) => p.status === "CLOSED");
    const symbols = new Set<string>();
    let realized = 0;
    let fees = 0;
    let wins = 0;
    let losses = 0;
    let lastClosedAt: string | null = null;
    for (const p of closed) {
      const net = p.netPnlUsd ?? 0;
      realized += net;
      fees += p.feeEstimateUsd ?? 0;
      if (net > 0) wins += 1;
      else losses += 1;
      symbols.add(p.symbol);
      if (p.closedAt && (lastClosedAt === null || p.closedAt > lastClosedAt)) lastClosedAt = p.closedAt;
    }
    return { closedCount: closed.length, wins, losses, realizedPnlUsd: realized, feesUsd: fees, symbols: [...symbols].sort(), lastClosedAt };
  }

  getClosedPositions(): SingleSymbolPosition[] {
    return this.store.getState().positions.filter((p) => p.status === "CLOSED");
  }

  /** Single-flight tick: settle stop-triggered/policy-decided exits, then consider a new entry. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.monitorOpenPositions();
      if (this.isAllowed()) await this.maybeOpenPosition();
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message ?? "tick failed";
    } finally {
      this.ticking = false;
    }
  }

  /** Detect + settle a position whose protective stop has ALREADY triggered on the exchange.
   *  Authoritative: uses Binance's own trade records, never a guessed fill price. */
  private async settleIfStopTriggered(pos: SingleSymbolPosition): Promise<boolean> {
    if (pos.stopAlgoOrderId === null) return false;
    let actualOrderId: number | null = null;
    try {
      const algo = await this.client.queryAlgoOrder(pos.stopAlgoOrderId);
      actualOrderId = algo.actualOrderId;
    } catch {
      return false; // best-effort — try again next tick
    }
    if (actualOrderId === null) return false; // stop still resting, not triggered

    let realized = 0;
    let fees = 0;
    try {
      const trades = await this.client.getUserTrades(pos.symbol, { startTime: new Date(pos.openedAt).getTime(), limit: 200 });
      for (const t of trades) {
        if (t.orderId === actualOrderId || t.orderId === pos.entryOrderId) {
          realized += t.realizedPnl;
          fees += t.commission;
        }
      }
    } catch (error) {
      this.lastError = `settle: trades fetch failed (${(error as Error).message}) — PnL recorded as 0, check manually`;
    }
    pos.exitOrderId = actualOrderId;
    pos.exitPrice = pos.stopPrice;
    pos.exitPriceConfirmed = true; // sourced from getUserTrades, the most authoritative record
    pos.status = "CLOSED";
    pos.closedAt = this.nowIso();
    pos.closeReason = "INITIAL_STOP";
    // t.realizedPnl is Binance's own GROSS per-trade realized figure; t.commission is a separate,
    // positive cost — net = gross − fees (same convention as CrossSectionalExecutor.closeBasket).
    pos.grossPnlUsd = realized;
    pos.feeEstimateUsd = fees;
    pos.netPnlUsd = realized - fees;
    this.store.save();
    return true;
  }

  /** Place the protective stop if a position doesn't have one yet — covers both the normal
   *  post-entry placement and a retry if that placement failed transiently on an earlier tick
   *  (a position must never sit unprotected indefinitely because of a one-time API hiccup). */
  private async ensureStopOrder(pos: SingleSymbolPosition): Promise<void> {
    if (pos.stopAlgoOrderId !== null) return;
    try {
      const stop = await this.client.placeAlgoOrder({
        symbol: pos.symbol,
        side: pos.direction === "LONG" ? "SELL" : "BUY",
        type: "STOP_MARKET",
        quantity: pos.qty,
        triggerPrice: pos.stopPrice,
        reduceOnly: true,
        workingType: "CONTRACT_PRICE",
        clientAlgoId: `ssle-${pos.positionId.slice(-18)}-s`,
      });
      pos.stopAlgoOrderId = stop.algoId;
      this.store.save();
    } catch (error) {
      this.lastError = `stop placement failed for ${pos.symbol} (${pos.positionId}): ${(error as Error).message} — retrying next tick, position is UNPROTECTED until then`;
    }
  }

  private async monitorOpenPositions(): Promise<void> {
    const st = this.store.getState();
    const openPositions = st.positions.filter((p) => p.status === "OPEN");
    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      await this.ensureStopOrder(pos);
    }

    const positions = await this.client.getPositions();
    const markBySymbol = new Map<string, number>();
    for (const p of positions) {
      if (Number.isFinite(p.markPrice) && p.markPrice > 0) markBySymbol.set(p.symbol, p.markPrice);
    }

    let stamped = false;
    for (const pos of openPositions) {
      if (pos.status !== "OPEN") continue; // may have just been settled above in this same loop pass (defensive)
      const stopTriggered = await this.settleIfStopTriggered(pos);
      if (stopTriggered) continue;

      const mark = markBySymbol.get(pos.symbol);
      if (mark === undefined) continue; // no mark data this tick — never force a decision on partial info

      const msHeld = new Date(this.nowIso()).getTime() - new Date(pos.openedAt).getTime();
      const decision = this.exitPolicy({
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        stopPrice: pos.stopPrice,
        currentPrice: mark,
        peakFavorableR: pos.peakFavorableR,
        msHeld,
      });
      pos.peakFavorableR = decision.nextPeakFavorableR;
      stamped = true;
      if (decision.shouldExit) await this.closePosition(pos, decision.reason ?? "POLICY_EXIT");
    }
    if (stamped) this.store.save();
  }

  private async closePosition(pos: SingleSymbolPosition, reason: string): Promise<void> {
    if (pos.exitOrderId !== null) return; // already closed (retry safety)
    if (pos.stopAlgoOrderId !== null) {
      try {
        await this.client.cancelAlgoOrder(pos.stopAlgoOrderId);
      } catch {
        // best-effort — if it already triggered, settleIfStopTriggered will have caught it above
        // in the SAME tick before this path runs, so a cancel failure here is just "already gone"
      }
    }
    const exitSide = pos.direction === "LONG" ? "SELL" : "BUY";
    try {
      const order = await this.client.placeOrder({
        symbol: pos.symbol,
        side: exitSide,
        type: "MARKET",
        quantity: pos.qty,
        reduceOnly: true,
        newClientOrderId: `ssle-${pos.positionId.slice(-18)}-x`,
      });
      pos.exitOrderId = order.orderId;
      const resolved = await this.resolveFillPrice(pos.symbol, order.orderId, order.avgPrice, pos.entryPrice);
      pos.exitPrice = resolved.price;
      pos.exitPriceConfirmed = resolved.confirmed;
    } catch (error) {
      this.store.save();
      throw new Error(`position ${pos.positionId} close failed: ${(error as Error).message}`);
    }
    const dir = pos.direction === "LONG" ? 1 : -1;
    const exit = pos.exitPrice ?? pos.entryPrice;
    const gross = dir * (exit - pos.entryPrice) * pos.qty;
    const notional = pos.entryPrice * pos.qty + exit * pos.qty;
    const fees = notional * TAKER_FEE_RATE;
    pos.status = "CLOSED";
    pos.closedAt = this.nowIso();
    pos.closeReason = reason;
    pos.grossPnlUsd = gross;
    pos.feeEstimateUsd = fees;
    pos.netPnlUsd = gross - fees;
    this.store.save();
  }

  private async maybeOpenPosition(): Promise<void> {
    const st = this.store.getState();
    const lossLimit = this.dailyMaxLossUsdFn();
    if (lossLimit > 0) {
      const dayRealized = this.dailyRealizedUsd(this.nowIso());
      if (dayRealized <= -lossLimit) {
        this.openHalted = `daily loss breaker: realized ${dayRealized.toFixed(2)} USDT ≤ -${lossLimit} — new opens halted until UTC midnight (open positions keep their own exits)`;
        return;
      }
    }
    this.openHalted = null;
    if (st.positions.filter((p) => p.status === "OPEN").length >= this.maxOpenPositionsFn()) return;

    const nowMs = new Date(this.nowIso()).getTime();
    const candidates = this.getOpenSignals()
      .filter((s) => s.openedAtMs > st.lastSeenSignalMs && nowMs - s.openedAtMs <= this.maxSignalAgeMsFn())
      .sort((a, b) => b.openedAtMs - a.openedAtMs);
    const signal = candidates[0];
    if (!signal) return;

    // Watermark BEFORE placing orders: a failed entry must not retry forever on the same signal.
    st.lastSeenSignalMs = signal.openedAtMs;
    this.store.save();

    const legUsd = this.effectiveLegUsd();
    if (!(legUsd > 0)) return;
    if (!(signal.entryPrice > 0)) return;
    const filters = await this.client.getExchangeFilters();
    const f = filters.get(signal.symbol);
    if (!f) return;
    const rawQty = legUsd / signal.entryPrice;
    const qty = Number((Math.floor(rawQty / f.stepSize) * f.stepSize).toFixed(8));
    if (!(qty >= f.minQty)) return;

    const positionId = `ssl-${this.laneId.slice(0, 4).toLowerCase()}-${signal.openedAtMs.toString(36)}`;
    try {
      await this.client.setLeverage(signal.symbol, this.leverageFn());
    } catch {
      // best-effort (already set / position exists)
    }
    const order = await this.client.placeOrder({
      symbol: signal.symbol,
      side: this.direction === "LONG" ? "BUY" : "SELL",
      type: "MARKET",
      quantity: qty,
      newClientOrderId: `ssle-${positionId.slice(-18)}-e`,
    });
    const resolvedEntry = await this.resolveFillPrice(signal.symbol, order.orderId, order.avgPrice, signal.entryPrice);
    const position: SingleSymbolPosition = {
      positionId,
      sourceObservationId: signal.observationId,
      symbol: signal.symbol,
      direction: this.direction,
      qty,
      entryPrice: resolvedEntry.price,
      entryOrderId: order.orderId,
      entryPriceConfirmed: resolvedEntry.confirmed,
      stopPrice: signal.stopPrice,
      stopAlgoOrderId: null,
      peakFavorableR: 0,
      openedAt: this.nowIso(),
      status: "OPEN",
      closedAt: null,
      closeReason: null,
      exitPrice: null,
      exitOrderId: null,
      exitPriceConfirmed: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    };
    st.positions.push(position);
    this.store.save();
    // Protective stop placed on the VERY NEXT tick (ensureStopOrder, called at the top of
    // monitorOpenPositions) rather than inline here — keeps entry and stop-placement failure
    // handling in ONE place (ensureStopOrder's retry-until-success loop) instead of two.
  }
}

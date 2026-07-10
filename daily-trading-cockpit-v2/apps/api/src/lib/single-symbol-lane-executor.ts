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

import { BinanceFuturesPrivateError, resolveConfirmedFillPrice, type BinanceFuturesPrivateClient } from "./binance-futures-private.js";

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
  entryOrderId: string;
  entryPriceConfirmed: boolean;
  stopPrice: number;
  /** Exchange-side protective stop algo order id. Null only in the brief window between a
   *  confirmed entry and the stop placement succeeding — see ensureStopOrder(). */
  stopAlgoOrderId: string | null;
  /** Consecutive ensureStopOrder() failures (resets to 0 on success). A position with this > 0
   *  AND stopAlgoOrderId still null is genuinely unprotected right now, not just "about to be
   *  protected next tick" — surfaced via getStatus().unprotectedPositions so a stuck-for-hours
   *  case is distinguishable from a one-tick blip. */
  stopFailureCount: number;
  /** ISO timestamp of the FIRST failure in the current stopFailureCount streak; null once a stop
   *  placement succeeds. Lets a monitor compute how LONG a position has been unprotected. */
  stopUnprotectedSinceIso: string | null;
  /** Consecutive closePosition() order-placement failures (resets to 0 on success). A position
   *  the exit policy already decided to escape stuck OPEN with this > 0 means the close itself is
   *  failing repeatedly (e.g. a persistent non-(-2022) rejection) — surfaced via
   *  getStatus().stuckClosePositions. */
  closeFailureCount: number;
  closeFailureSinceIso: string | null;
  peakFavorableR: number;
  openedAt: string;
  status: "OPEN" | "CLOSED" | "ABORTED";
  closedAt: string | null;
  closeReason: string | null;
  exitPrice: number | null;
  exitOrderId: string | null;
  exitPriceConfirmed: boolean | null;
  grossPnlUsd: number | null;
  feeEstimateUsd: number | null;
  netPnlUsd: number | null;
}

interface SingleSymbolExecutorState {
  version: number;
  positions: SingleSymbolPosition[];
  lastSeenSignalMs: number;
  /** 2026-07-09 fix: per-signal dedup by observationId, bounded to the most recent 500. Replaces
   *  lastSeenSignalMs-only filtering for candidate selection, which had a real incident: when
   *  several signals share the EXACT SAME openedAtMs (e.g. a regime-level gate that can fire on
   *  multiple symbols in one cycle), attempting the FIRST one advanced the scalar watermark past
   *  that shared timestamp regardless of whether the attempt actually opened a position (a
   *  MIN_NOTIONAL-rejected entry still advanced it) — silently and PERMANENTLY excluding every
   *  OTHER signal sharing that timestamp, since "equal to the watermark" no longer counts as
   *  "newer". Optional for backward compatibility with state files persisted before this field
   *  existed (`?? []` at every read site). */
  attemptedObservationIds?: string[];
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
        if (parsed && Array.isArray(parsed.positions)) {
          // Legacy records persisted before entryOrderId/stopAlgoOrderId/exitOrderId became
          // strings (see binance-futures-private.ts's order-ID precision fix) still have these
          // as bare JS numbers on disk — JSON.parse doesn't know about the TS type, so it would
          // silently load them as `number`, and every trade-matching `===` against a freshly
          // fetched (genuinely string) order id would then always be false. Normalize on load so
          // the runtime value matches the type everywhere downstream.
          for (const p of parsed.positions as Array<Record<string, unknown>>) {
            if (typeof p.entryOrderId === "number") p.entryOrderId = String(p.entryOrderId);
            if (typeof p.stopAlgoOrderId === "number") p.stopAlgoOrderId = String(p.stopAlgoOrderId);
            if (typeof p.exitOrderId === "number") p.exitOrderId = String(p.exitOrderId);
          }
          return parsed as SingleSymbolExecutorState;
        }
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
  /** 2026-07-09 fix: current notional (USD) already committed to a symbol by OTHER lane
   *  instances (this instance's OWN open positions must NOT be included — the caller computes
   *  this across the OTHER executors, since this one's own admission is already naturally
   *  bounded by maxOpenPositions). Paired with maxNotionalPerSymbolAcrossLanes below. Without
   *  this, independently-admitted lanes on the same symbol each size purely from their own
   *  legUsd with zero awareness of what other lanes already committed — confirmed live
   *  (REGIME_COMPOSITE_CONFIRMATION_LONG + COMPOSITE_ESTIMATOR_BIDI's WIDE_LONG/FAST_LONG all
   *  independently going LONG on the same BTC/ETH/SOL universe). Defaults to () => 0 (no other
   *  lane's exposure known / not wired). */
  existingNotionalForSymbol?: (symbol: string) => number;
  /** 0 (default) = no cap. A fresh entry whose notional, ADDED to existingNotionalForSymbol's
   *  reading for that symbol, would exceed this is skipped (not resized) — same
   *  skip-not-silently-resize convention as every other admission gate here. Checked BEFORE
   *  marking the signal's observationId as attempted, unlike the structural minQty/minNotional
   *  checks above it: this constraint is TRANSIENT (another lane's position on the symbol may
   *  close by the next tick, freeing capacity), so the same signal deserves another chance next
   *  tick rather than being permanently blacklisted. */
  maxNotionalPerSymbolAcrossLanes?: () => number;
  /** Public-market reference used to reject a signal after price already chased its edge. */
  currentPrice?: (symbol: string) => Promise<number | null>;
  /** Maximum favorable drift since the signal, measured in entry-to-stop R. */
  maxEntryChaseStopFraction?: () => number;
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
  private readonly existingNotionalForSymbolFn: (symbol: string) => number;
  private readonly maxNotionalPerSymbolAcrossLanesFn: () => number;
  private readonly currentPriceFn: ((symbol: string) => Promise<number | null>) | null;
  private readonly maxEntryChaseStopFractionFn: () => number;
  private ticking = false;
  private lastError: string | null = null;
  private openHalted: string | null = null;
  private lastEntrySkipReason: string | null = null;

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
    this.existingNotionalForSymbolFn = opts.existingNotionalForSymbol ?? (() => 0);
    this.maxNotionalPerSymbolAcrossLanesFn = opts.maxNotionalPerSymbolAcrossLanes ?? (() => 0);
    this.currentPriceFn = opts.currentPrice ?? null;
    this.maxEntryChaseStopFractionFn = opts.maxEntryChaseStopFraction ?? (() => {
      const n = Number.parseFloat(process.env.LIVE_MAX_ENTRY_CHASE_STOP_FRACTION ?? "");
      return Number.isFinite(n) && n >= 0 ? n : 0.2;
    });
  }

  private async resolveFillPrice(symbol: string, orderId: string, initialAvgPrice: number, fallbackPrice: number) {
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
    lastEntrySkipReason: string | null;
    openPositions: SingleSymbolPosition[];
    closedCount: number;
    totalNetPnlUsd: number;
    lastError: string | null;
    recent: SingleSymbolPosition[];
    /** OPEN positions with a stop-placement failure streak in progress right now (stopAlgoOrderId
     *  still null AND stopFailureCount > 0) — genuinely unprotected, not a one-tick blip. Empty in
     *  the normal case. A non-empty array here for more than a few minutes is an alert-worthy
     *  condition: real money exposed with zero exchange-side stop protection. */
    unprotectedPositions: Array<{ positionId: string; symbol: string; stopFailureCount: number; stopUnprotectedSinceIso: string | null }>;
    /** OPEN positions whose exit policy already decided to close them, but the close order itself
     *  is repeatedly failing (closeFailureCount > 0) — stuck, retried every tick, never escalated
     *  beyond the single lastError field otherwise. */
    stuckClosePositions: Array<{ positionId: string; symbol: string; closeFailureCount: number; closeFailureSinceIso: string | null }>;
  } {
    const st = this.store.getState();
    const closed = st.positions.filter((p) => p.status === "CLOSED");
    const open = st.positions.filter((p) => p.status === "OPEN");
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
      lastEntrySkipReason: this.lastEntrySkipReason,
      openPositions: open,
      closedCount: closed.length,
      totalNetPnlUsd: closed.reduce((s, p) => s + (p.netPnlUsd ?? 0), 0),
      lastError: this.lastError,
      unprotectedPositions: open
        .filter((p) => p.stopAlgoOrderId === null && p.stopFailureCount > 0)
        .map((p) => ({ positionId: p.positionId, symbol: p.symbol, stopFailureCount: p.stopFailureCount, stopUnprotectedSinceIso: p.stopUnprotectedSinceIso })),
      stuckClosePositions: open
        .filter((p) => p.closeFailureCount > 0)
        .map((p) => ({ positionId: p.positionId, symbol: p.symbol, closeFailureCount: p.closeFailureCount, closeFailureSinceIso: p.closeFailureSinceIso })),
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

  /** Operator-triggered manual close (dashboard "Close now" button on the single-symbol-executor
   *  panel) — always allowed regardless of isAllowed()/armed state, same posture as
   *  live-execution-engine.ts's manualCloseIntent(): a risk-reducing action must never be blocked
   *  by the entry gate. Reuses closePosition() itself, so it gets the exact same battle-tested
   *  path the exit policy uses (cancel resting stop, market reduceOnly with -2022 fallback,
   *  confirmed fill via getUserTrades, honest fee-adjusted P&L). */
  async manualClosePosition(positionId: string): Promise<{ ok: boolean; reason: string | null; netPnlUsd: number | null }> {
    const pos = this.store.getState().positions.find((p) => p.positionId === positionId && p.status === "OPEN");
    if (!pos) return { ok: false, reason: `no open position ${positionId} (already closed or unknown)`, netPnlUsd: null };
    if (pos.exitOrderId !== null) {
      return { ok: false, reason: "close already in flight for this position — wait for it to settle", netPnlUsd: null };
    }
    try {
      await this.closePosition(pos, "MANUAL_CLOSE");
      return { ok: true, reason: null, netPnlUsd: pos.netPnlUsd };
    } catch (error) {
      return { ok: false, reason: (error as Error).message, netPnlUsd: null };
    }
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
    let actualOrderId: string | null = null;
    try {
      const algo = await this.client.queryAlgoOrder(pos.stopAlgoOrderId);
      actualOrderId = algo.actualOrderId;
    } catch {
      return false; // best-effort — try again next tick
    }
    // Rely on our OWN already-recorded state (not just this tick's possibly-flaky re-query) once
    // we've previously confirmed the trigger — see the exitOrderId-set-immediately step below.
    if (actualOrderId === null && pos.exitOrderId === null) return false; // stop still resting

    // Mark the exit as IN FLIGHT the moment the trigger is known, regardless of whether the P&L
    // fetch below succeeds this tick. This is what stops monitorOpenPositions' exit-policy branch
    // (and closePosition's own re-entry guard) from ever placing a SECOND close against a position
    // the exchange has already flattened via this stop.
    if (pos.exitOrderId === null) {
      pos.exitOrderId = actualOrderId;
      this.store.save();
    }

    let realized = 0;
    let fees = 0;
    let exitNotional = 0;
    let exitQty = 0;
    try {
      // Binance's per-request cap (2^10=1024, Binance documents 1000 as the max for this
      // endpoint); still not a guarantee against a very active shared symbol exceeding this many
      // trades since openedAt, but meaningfully wider than the prior 200.
      const trades = await this.client.getUserTrades(pos.symbol, { startTime: new Date(pos.openedAt).getTime(), limit: 1000 });
      for (const t of trades) {
        if (t.orderId === pos.exitOrderId) {
          exitNotional += t.price * t.qty;
          exitQty += t.qty;
        }
        if (t.orderId === pos.exitOrderId || t.orderId === pos.entryOrderId) {
          realized += t.realizedPnl;
          fees += t.commission;
        }
      }
    } catch (error) {
      this.lastError = `settle: trades fetch failed (${(error as Error).message}) — retrying next tick, P&L NOT recorded (never fabricated) for ${pos.positionId}`;
      return true; // exit already in-flight (exitOrderId set) — skip policy-exit eval this tick too
    }
    if (exitQty === 0) {
      // The exit order's own trade record hasn't shown up in this window yet (timing race right
      // after the stop fires, or — see the limit comment above — a very active shared symbol
      // pushed it out of the page). Retry next tick rather than closing with a fabricated P&L.
      this.lastError = `settle: exit order ${pos.exitOrderId} trade not found yet for ${pos.positionId} — retrying next tick, P&L NOT recorded (never fabricated)`;
      return true;
    }
    pos.exitPrice = exitNotional / exitQty; // qty-weighted average of the ACTUAL fill(s), not the trigger price
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
      pos.stopFailureCount = 0;
      pos.stopUnprotectedSinceIso = null;
      this.store.save();
    } catch (error) {
      pos.stopFailureCount += 1;
      if (pos.stopUnprotectedSinceIso === null) pos.stopUnprotectedSinceIso = this.nowIso();
      this.store.save();
      this.lastError =
        `stop placement failed for ${pos.symbol} (${pos.positionId}), attempt ${pos.stopFailureCount} ` +
        `since ${pos.stopUnprotectedSinceIso}: ${(error as Error).message} — retrying next tick, ` +
        `position is UNPROTECTED until then (see getStatus().unprotectedPositions)`;
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
      if (decision.shouldExit) {
        try {
          await this.closePosition(pos, decision.reason ?? "POLICY_EXIT");
        } catch (error) {
          // 2026-07-10 fix: closePosition() already recorded closeFailureCount/closeFailureSinceIso
          // and re-throws to signal "not closed, retry next tick" — but letting that throw escape
          // THIS loop would abort monitorOpenPositions for every position LATER in openPositions
          // this same tick, silently starving their TP/giveback checks for as long as this one
          // keeps failing. Every REGIME_COMPOSITE_CONFIRMATION_LONG / COMPOSITE_ESTIMATOR_BIDI_*
          // instance runs with maxOpenPositions > 1, so this is a real, not hypothetical, hazard.
          this.lastError = (error as Error).message;
        }
      }
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
      let order;
      try {
        order = await this.client.placeOrder({
          symbol: pos.symbol,
          side: exitSide,
          type: "MARKET",
          quantity: pos.qty,
          reduceOnly: true,
          newClientOrderId: `ssle-${pos.positionId.slice(-18)}-x`,
        });
      } catch (err) {
        // -2022 "ReduceOnly Order is rejected": the account's NETTED position on this symbol (one
        // -way mode; other executors — cross-sectional legs, another single-symbol lane's opposite
        // side — share this same account) can carry a different sign than this one position alone.
        // Retry WITHOUT reduceOnly — bounded risk: we only ever send OUR OWN recorded qty in the
        // closing direction, so this can never create MORE exposure than this position itself
        // already represents, only reduce or (worst case) flip the account's net by that qty.
        if (!(err instanceof BinanceFuturesPrivateError) || err.binanceCode !== -2022) throw err;
        order = await this.client.placeOrder({
          symbol: pos.symbol,
          side: exitSide,
          type: "MARKET",
          quantity: pos.qty,
          newClientOrderId: `ssle-${pos.positionId.slice(-18)}-x2`,
        });
      }
      pos.exitOrderId = order.orderId;
      const resolved = await this.resolveFillPrice(pos.symbol, order.orderId, order.avgPrice, pos.entryPrice);
      pos.exitPrice = resolved.price;
      pos.exitPriceConfirmed = resolved.confirmed;
      pos.closeFailureCount = 0;
      pos.closeFailureSinceIso = null;
    } catch (error) {
      pos.closeFailureCount += 1;
      if (pos.closeFailureSinceIso === null) pos.closeFailureSinceIso = this.nowIso();
      // 2026-07-10 fix: the protective stop was already (attempted-)cancelled above, unconditionally,
      // before this close attempt — if the close itself then fails, leaving stopAlgoOrderId pointing
      // at that now-cancelled order silently hides the position from getStatus().unprotectedPositions
      // (which requires stopAlgoOrderId === null) and stops ensureStopOrder() from ever replacing it
      // (it only acts when null). Reset it so both self-heal on the next tick — worst case a harmless
      // redundant stop placement attempt, never a silently-unprotected position.
      pos.stopAlgoOrderId = null;
      this.store.save();
      throw new Error(
        `position ${pos.positionId} close failed, attempt ${pos.closeFailureCount} since ` +
          `${pos.closeFailureSinceIso}: ${(error as Error).message} — position stays OPEN, will ` +
          `retry next tick (see getStatus().stuckClosePositions)`,
      );
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

    const nowMs = new Date(this.nowIso()).getTime();
    const attempted = new Set(st.attemptedObservationIds ?? []);
    const candidates = this.getOpenSignals()
      .filter((s) => !attempted.has(s.observationId) && nowMs - s.openedAtMs <= this.maxSignalAgeMsFn())
      .sort((a, b) => b.openedAtMs - a.openedAtMs);
    this.lastEntrySkipReason = null;

    // Loop (not just candidates[0]): a regime-level gate can legitimately fire on several symbols
    // in the SAME cycle (unlike a per-symbol technical trigger, which rarely does) — attempt every
    // fresh candidate up to remaining capacity in ONE tick rather than trickling one in per 5-min
    // tick. See the state interface's doc comment for the incident this (plus per-observationId
    // dedup) fixes.
    for (const signal of candidates) {
      if (st.positions.filter((p) => p.status === "OPEN").length >= this.maxOpenPositionsFn()) break;

      if (this.currentPriceFn) {
        const currentPrice = await this.currentPriceFn(signal.symbol).catch(() => null);
        const risk = Math.abs(signal.entryPrice - signal.stopPrice);
        if (!(currentPrice !== null && currentPrice > 0) || !(risk > 0)) {
          this.lastEntrySkipReason = `${signal.symbol}: live price/risk unavailable for entry-quality gate`;
          continue;
        }
        const favorableDriftR = this.direction === "LONG"
          ? (currentPrice - signal.entryPrice) / risk
          : (signal.entryPrice - currentPrice) / risk;
        const stopCrossed = this.direction === "LONG"
          ? currentPrice <= signal.stopPrice
          : currentPrice >= signal.stopPrice;
        const chaseLimit = this.maxEntryChaseStopFractionFn();
        if (stopCrossed || favorableDriftR > chaseLimit) {
          this.lastEntrySkipReason = stopCrossed
            ? `${signal.symbol}: signal invalidated because live price crossed its stop`
            : `${signal.symbol}: entry chase ${favorableDriftR.toFixed(2)}R exceeds ${chaseLimit.toFixed(2)}R`;
          continue;
        }
      }

      // 2026-07-09 fix: cap combined notional across ALL lanes for this symbol — checked FIRST,
      // before marking attempted. Unlike the structural checks below (bad price, fails
      // minQty/minNotional — permanent for this exact signal), this constraint is TRANSIENT:
      // another lane's position on the symbol may close by the next tick, freeing capacity, so
      // this same signal deserves another chance rather than being permanently blacklisted.
      // Uses legUsd as the notional estimate (the exact post-stepSize qty*price isn't known
      // yet) — close enough for a safety-net cap, not a precision requirement.
      const notionalCap = this.maxNotionalPerSymbolAcrossLanesFn();
      if (notionalCap > 0 && this.existingNotionalForSymbolFn(signal.symbol) + this.effectiveLegUsd() > notionalCap) {
        continue;
      }

      // Mark attempted BEFORE placing orders: a failed/rejected entry must not retry forever on
      // the same signal. Bounded — this is a dedup set, not a growing audit log.
      attempted.add(signal.observationId);
      st.attemptedObservationIds = Array.from(attempted).slice(-500);
      this.store.save();

      const legUsd = this.effectiveLegUsd();
      if (!(legUsd > 0)) continue;
      if (!(signal.entryPrice > 0)) continue;
      const filters = await this.client.getExchangeFilters();
      const f = filters.get(signal.symbol);
      if (!f) continue;
      const rawQty = legUsd / signal.entryPrice;
      const qty = Number((Math.floor(rawQty / f.stepSize) * f.stepSize).toFixed(8));
      if (!(qty >= f.minQty)) continue;
      if (!(qty * signal.entryPrice >= f.minNotional)) continue; // Binance rejects an order that clears minQty but misses MIN_NOTIONAL

      // Symbol fragment keeps this unique even when 2+ candidates share the identical openedAtMs
      // (the exact scenario that exposed the dedup bug above).
      const positionId = `ssl-${this.laneId.slice(0, 4).toLowerCase()}-${signal.symbol.slice(0, 3).toLowerCase()}-${signal.openedAtMs.toString(36)}`;
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
        stopFailureCount: 0,
        stopUnprotectedSinceIso: null,
        closeFailureCount: 0,
        closeFailureSinceIso: null,
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
}

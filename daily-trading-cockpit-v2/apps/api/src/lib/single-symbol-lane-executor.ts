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

import { BinanceFuturesPrivateError, resolveConfirmedFillPrice, roundToStep, type BinanceFuturesPrivateClient } from "./binance-futures-private.js";

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

/** Optional asynchronous execution overlay. It may only veto a fresh entry or request an orderly
 * exit; it never places an order itself and the lane's exchange-side STOP_MARKET stays in force. */
export type SingleSymbolTimelineEntryGate = (signal: SingleSymbolFreshSignal, direction: "LONG" | "SHORT") => Promise<{ allowed: boolean; reason: string | null }>;
export type SingleSymbolTimelineExitGate = (symbol: string, direction: "LONG" | "SHORT") => Promise<{ shouldExit: boolean; reason: string | null }>;

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
  /** Cumulative gross/fee P&L already realized from a PRIOR partial fill on this same position
   *  (2026-07-12 fix: a triggered stop can partially fill when a sibling executor's netting has
   *  reduced the exchange-side reduce-only qty available). Optional for backward compatibility
   *  with positions persisted before this field existed (`?? 0` at every read site). Added into
   *  the final leg's totals whichever path (settleIfStopTriggered or closePosition) closes the
   *  position's now-reduced remaining qty. */
  realizedPartialGrossUsd?: number;
  realizedPartialFeeUsd?: number;
  /** Set true once the entry order's own realizedPnl/commission has been folded into
   *  realizedPartial*Usd — prevents re-counting the SAME entry trade's fee/pnl on a second (or
   *  third) partial-fill cycle, since getUserTrades is re-queried from openedAt every time. */
  entryFeeRealized?: boolean;
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

  private prune(): void {
    const max = MAX_STORED_POSITIONS();
    if (this.state.positions.length <= max) return;
    const open = this.state.positions.filter((p) => p.status === "OPEN");
    const settled = this.state.positions
      .filter((p) => p.status !== "OPEN")
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, Math.max(0, max - open.length));
    this.state.positions = [...open, ...settled];
  }

  save(): void {
    try {
      this.prune();
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
  /** Optional account-wide overlay evaluated before the lane's own exit policy. It never opens
   *  exposure; it lets a central directional/risk controller bank or hard-cut legacy positions
   *  while this executor remains responsible for its own netting-aware close and stop lifecycle. */
  portfolioExitPolicy?: SingleSymbolExitPolicy;
  /** BTC/ETH/SOL multi-indicator timeline overlay. Optional and additive: its absence preserves
   * the historical executor behavior exactly. */
  timelineEntryGate?: SingleSymbolTimelineEntryGate;
  timelineExitGate?: SingleSymbolTimelineExitGate;
  /** Master permission gate. Testnet: () => true. Mainnet: () => engine.isArmed(). */
  isAllowed: () => boolean;
  /** 2026-07-12: optional human-readable reason surfaced in getStatus() when a NON-obvious gate
   *  (e.g. the regime×direction edge-memory veto) is the thing holding this lane back — isAllowed()
   *  is a bare boolean, so a false with no reason is indistinguishable from disarmed/unallocated.
   *  Report-only: null when nothing special is blocking. */
  isAllowedReason?: () => string | null;
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
   *  instances — the caller computes this across the OTHER executors; this instance's OWN open
   *  positions on the symbol are added separately inside maybeOpenPosition (2026-07-12 fix: the
   *  doc here used to claim this instance's own same-symbol exposure was "already naturally
   *  bounded by maxOpenPositions" — false, maxOpenPositions caps the TOTAL position COUNT for
   *  this instance across ALL symbols, not per-symbol, so a single instance could otherwise stack
   *  multiple same-symbol positions invisible to this cap). Paired with
   *  maxNotionalPerSymbolAcrossLanes below. Without
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
  /** 2026-07-12 fix: monitorOpenPositions() reads client.getPositions() every tick purely for
   *  markPrice — up to 8 SingleSymbolLaneExecutor instances (plus 3 CrossSectionalExecutor
   *  instances) share this ONE netted account, all independently issuing this same signed,
   *  account-wide call within the same staggered 5-minute window. markPrice is market-wide data
   *  every instance could share from ONE call. Defaults to () => this.client.getPositions()
   *  (unchanged behavior) — callers that wire a shared short-TTL cache across sibling instances
   *  (see app.ts's sharedGetPositions) cut this down to one signed call per cache window. */
  sharedGetPositions?: () => ReturnType<SingleSymbolExecClient["getPositions"]>;
  /** Atomic account-wide claim for an in-flight entry. Prevents sibling executors from sending
   * opposing orders against the same netted Binance symbol after observing stale cached state. */
  tryClaimEntrySymbol?: (symbol: string) => boolean;
  /** Releases an entry-symbol claim after every success, rejection, or failure path. */
  releaseEntrySymbol?: (symbol: string) => void;
  /** 2026-07-19 real-money audit fix: best-effort notification fired exactly once per position
   *  fully closed (stop-triggered, policy exit, manual close, or an orderly kill-switch wind-down —
   *  every one of those paths funnels through settleIfStopTriggered()/closePosition()'s own single
   *  finalization block), carrying the position's confirmed netPnlUsd. app.ts wires this to
   *  LiveExecutionEngine.recordExternalConsecutiveLossOutcome() so a losing streak concentrated
   *  entirely in THIS instance (as opposed to the legacy CG_*-variant-matrix mirror pipeline) still
   *  trips the account-wide consecutive-loss kill-switch condition — before this hook existed, that
   *  condition could only ever be fed by the mirror pipeline's own applyRealizedToLedger, which
   *  these independently-admitted single-symbol lanes never called into at all. Never invoked with
   *  a null net: unlike the mirror pipeline, this executor never finalizes a position CLOSED with
   *  an unresolved P&L — both settlement paths retry next tick rather than settle with a
   *  fabricated/unknown number. A throwing callback never interrupts this executor's own
   *  settlement bookkeeping — see notifyPositionClosed(). */
  onPositionClosed?: (netUsd: number) => void;
}

/** Store never capped closed/aborted positions, growing forever. Keeps every OPEN position
 *  unconditionally and caps settled (CLOSED/ABORTED) ones to the newest N by openedAt. */
const MAX_STORED_POSITIONS = () =>
  Math.max(1, Math.floor(Number(process.env.SINGLE_SYMBOL_EXEC_MAX_STORED_POSITIONS) || 2000));
const TAKER_FEE_RATE = 0.0005; // 5 bps per side, conservative

export class SingleSymbolLaneExecutor {
  private readonly client: SingleSymbolExecClient;
  private readonly store: SingleSymbolLaneExecutorStore;
  private readonly laneId: string;
  private readonly direction: "LONG" | "SHORT";
  private readonly getOpenSignals: () => SingleSymbolFreshSignal[];
  private readonly exitPolicy: SingleSymbolExitPolicy;
  private readonly portfolioExitPolicy: SingleSymbolExitPolicy | null;
  private readonly timelineEntryGate: SingleSymbolTimelineEntryGate | null;
  private readonly timelineExitGate: SingleSymbolTimelineExitGate | null;
  private readonly isAllowed: () => boolean;
  private readonly isAllowedReasonFn: () => string | null;
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
  private readonly sharedGetPositions: () => ReturnType<SingleSymbolExecClient["getPositions"]>;
  private readonly tryClaimEntrySymbol: (symbol: string) => boolean;
  private readonly releaseEntrySymbol: (symbol: string) => void;
  private readonly onPositionClosed: (netUsd: number) => void;
  private ticking = false;
  /** 2026-07-11 real-money audit fix: closePosition()'s `pos.exitOrderId !== null` reentry guard
   *  is TOCTOU-vulnerable — exitOrderId isn't set until AFTER the awaited cancelAlgoOrder/placeOrder
   *  calls below, so manualClosePosition() (dashboard button, not gated by `this.ticking`) racing
   *  a concurrent monitorOpenPositions() policy-exit (or two manual clicks) can both pass that
   *  check and both place a real closing order — the second one's own -2022 fallback then drops
   *  reduceOnly and OPENS A BRAND-NEW NAKED POSITION instead of just failing. Claim the position id
   *  here, synchronously, before any await, so only one caller ever proceeds. */
  private closingPositionIds = new Set<string>();
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
    this.portfolioExitPolicy = opts.portfolioExitPolicy ?? null;
    this.timelineEntryGate = opts.timelineEntryGate ?? null;
    this.timelineExitGate = opts.timelineExitGate ?? null;
    this.isAllowed = opts.isAllowed;
    this.isAllowedReasonFn = opts.isAllowedReason ?? (() => null);
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
    this.sharedGetPositions = opts.sharedGetPositions ?? (() => this.client.getPositions());
    this.tryClaimEntrySymbol = opts.tryClaimEntrySymbol ?? (() => true);
    this.releaseEntrySymbol = opts.releaseEntrySymbol ?? (() => {});
    this.onPositionClosed = opts.onPositionClosed ?? (() => {});
  }

  /** Best-effort fan-out of a finalized close to onPositionClosed — never let a throwing callback
   *  interrupt this executor's own settlement bookkeeping (same fail-open posture as
   *  live-execution-engine.ts's onKillSwitchEngaged callback). */
  private notifyPositionClosed(netUsd: number): void {
    try {
      this.onPositionClosed(netUsd);
    } catch {
      // best-effort — the position is already fully settled and persisted regardless
    }
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
    /** Non-null when a non-obvious admission gate (e.g. the regime×direction edge-memory veto) is
     *  what's currently holding this lane's `allowed` false — so the operator can tell "vetoed by
     *  proven-negative edge" apart from disarmed/unallocated/kill-switch. */
    entryBlockReason: string | null;
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
      entryBlockReason: this.isAllowedReasonFn(),
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
  /** 2026-07-12 kill-switch response fix: orderly close of every OPEN position via this executor's
   *  OWN closePosition mechanics (stop-cancel + reduce-only close with the netting-aware -2022
   *  fallback) — NEVER a blanket symbol flatten, which would recreate the 2026-07-07
   *  netting-blind-closes incident on symbols shared with sibling executors/baskets. Per-position
   *  failures are collected, not fatal: a wedged close stays OPEN and keeps retrying on its own
   *  tick (visible via getStatus().stuckClosePositions). */
  async closeAllPositionsOrderly(reason: string): Promise<{ closed: number; failed: number }> {
    const st = this.store.getState();
    const open = st.positions.filter((p) => p.status === "OPEN");
    let closed = 0;
    let failed = 0;
    for (const pos of open) {
      try {
        await this.closePosition(pos, reason);
        // closePosition no-ops (leaves OPEN) when a concurrent close already claimed the id.
        if (pos.status === "CLOSED") closed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        this.lastError = (error as Error).message ?? "kill-switch close failed";
      }
    }
    return { closed, failed };
  }

  async manualClosePosition(positionId: string): Promise<{ ok: boolean; reason: string | null; netPnlUsd: number | null }> {
    const pos = this.store.getState().positions.find((p) => p.positionId === positionId && p.status === "OPEN");
    if (!pos) return { ok: false, reason: `no open position ${positionId} (already closed or unknown)`, netPnlUsd: null };
    if (pos.exitOrderId !== null) {
      return { ok: false, reason: "close already in flight for this position — wait for it to settle", netPnlUsd: null };
    }
    try {
      await this.closePosition(pos, "MANUAL_CLOSE");
      // 2026-07-11 fix: closePosition() no-ops (leaves pos.status==="OPEN") when a concurrent close
      // already claimed this position id — don't report success for a close that never happened.
      if (pos.status !== "CLOSED") {
        return { ok: false, reason: "close already in flight for this position — wait for it to settle", netPnlUsd: null };
      }
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

  /** Sum this position's OWN realized P&L and commissions from Binance's trade records — the
   *  authoritative source (extracted 2026-07-12 from settleIfStopTriggered so closePosition's
   *  policy exits can record REAL commissions too instead of a flat TAKER_FEE_RATE estimate):
   *  the given exit order's trades plus the entry order's (once per lifetime, guarded by
   *  entryFeeRealized — trades are re-queried from openedAt on every call, so a position that
   *  already went through a partial-fill cycle would otherwise re-add the SAME entry commission).
   *  Binance's per-request cap is 1000 for this endpoint — not a guarantee against a very active
   *  shared symbol exceeding that many trades since openedAt, but the widest page available.
   *  Returns null when the fetch fails (caller falls back to an estimate or retries). */
  private async sumOwnRealizedTrades(
    pos: SingleSymbolPosition,
    exitOrderId: string | null,
  ): Promise<{ realized: number; fees: number; exitNotional: number; exitQty: number } | null> {
    const entryAlreadyBanked = pos.entryFeeRealized === true;
    try {
      const trades = await this.client.getUserTrades(pos.symbol, { startTime: new Date(pos.openedAt).getTime(), limit: 1000 });
      let realized = 0;
      let fees = 0;
      let exitNotional = 0;
      let exitQty = 0;
      for (const t of trades) {
        if (exitOrderId !== null && t.orderId === exitOrderId) {
          exitNotional += t.price * t.qty;
          exitQty += t.qty;
          realized += t.realizedPnl;
          fees += t.commission;
        } else if (t.orderId === pos.entryOrderId && !entryAlreadyBanked) {
          realized += t.realizedPnl;
          fees += t.commission;
        }
      }
      return { realized, fees, exitNotional, exitQty };
    } catch {
      return null;
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

    const summed = await this.sumOwnRealizedTrades(pos, pos.exitOrderId);
    if (summed === null) {
      this.lastError = `settle: trades fetch failed — retrying next tick, P&L NOT recorded (never fabricated) for ${pos.positionId}`;
      return true; // exit already in-flight (exitOrderId set) — skip policy-exit eval this tick too
    }
    const { realized, fees, exitNotional, exitQty } = summed;
    if (exitQty === 0) {
      // The exit order's own trade record hasn't shown up in this window yet (timing race right
      // after the stop fires, or — see the limit comment above — a very active shared symbol
      // pushed it out of the page). Retry next tick rather than closing with a fabricated P&L.
      this.lastError = `settle: exit order ${pos.exitOrderId} trade not found yet for ${pos.positionId} — retrying next tick, P&L NOT recorded (never fabricated)`;
      return true;
    }
    // 2026-07-12 fix: a triggered stop can PARTIALLY fill — cross-executor netting on this same
    // netted account (one-way mode, shared across every SingleSymbolLaneExecutor instance) can
    // clip the reduce-only qty actually available at trigger time, the same root cause already
    // documented in closePosition()'s own -2022 fallback. Previously ANY nonzero exitQty was
    // treated as a FULL close, silently dropping the unfilled remainder from every safety net:
    // it stays invisible to computeExternalManagedNetQty/computeNotionalPerSymbol (both skip any
    // position with exitOrderId !== null) and monitorOpenPositions never revisits a CLOSED
    // position — real, live, unprotected exposure nothing would ever act on again. Only treat
    // this as a full close when the fill covers the position's full remaining qty (tolerance for
    // float rounding); otherwise bank the partial P&L and re-arm protection for what's left.
    const remainingQty = pos.qty - exitQty;
    if (remainingQty > 1e-9) {
      pos.realizedPartialGrossUsd = (pos.realizedPartialGrossUsd ?? 0) + realized;
      pos.realizedPartialFeeUsd = (pos.realizedPartialFeeUsd ?? 0) + fees;
      pos.entryFeeRealized = true;
      pos.qty = remainingQty;
      pos.exitOrderId = null;
      pos.stopAlgoOrderId = null; // triggered algo order is spent; ensureStopOrder re-arms a fresh one sized to remainingQty next tick
      this.lastError = `settle: stop for ${pos.positionId} partially filled (${exitQty} of ${exitQty + remainingQty}) — banked partial P&L, re-arming protection for the remaining ${remainingQty}`;
      this.store.save();
      return true;
    }
    pos.exitPrice = exitNotional / exitQty; // qty-weighted average of the ACTUAL fill(s), not the trigger price
    pos.exitPriceConfirmed = true; // sourced from getUserTrades, the most authoritative record
    pos.status = "CLOSED";
    pos.closedAt = this.nowIso();
    pos.closeReason = "INITIAL_STOP";
    // t.realizedPnl is Binance's own GROSS per-trade realized figure; t.commission is a separate,
    // positive cost — net = gross − fees (same convention as CrossSectionalExecutor.closeBasket).
    // Includes any PRIOR partial-fill leg's real banked P&L so the total reflects this position's
    // FULL lifetime, not just the final leg.
    pos.grossPnlUsd = (pos.realizedPartialGrossUsd ?? 0) + realized;
    pos.feeEstimateUsd = (pos.realizedPartialFeeUsd ?? 0) + fees;
    const netUsd = pos.grossPnlUsd - pos.feeEstimateUsd;
    pos.netPnlUsd = netUsd;
    this.store.save();
    // 2026-07-19 real-money audit fix: feed the account-wide consecutive-loss kill-switch counter
    // (see onPositionClosed's doc comment) — every full close, stop-triggered or policy-decided,
    // must reach it, not just the legacy mirror pipeline's own applyRealizedToLedger.
    this.notifyPositionClosed(netUsd);
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

    const positions = await this.sharedGetPositions();
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
      const exitContext = {
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        stopPrice: pos.stopPrice,
        currentPrice: mark,
        peakFavorableR: pos.peakFavorableR,
        msHeld,
      };
      const portfolioDecision = this.portfolioExitPolicy?.(exitContext) ?? null;
      const laneDecision = this.exitPolicy({
        ...exitContext,
        peakFavorableR: portfolioDecision?.nextPeakFavorableR ?? exitContext.peakFavorableR,
      });
      let decision = portfolioDecision?.shouldExit ? portfolioDecision : laneDecision;
      // A timeline reversal may bank/cut a position only after the lane's own risk/TP rule has
      // declined to exit. A timeline fetch failure is fail-open for exits: the protective stop and
      // established lane policy keep managing the real position rather than a stale chart closing it.
      if (!decision.shouldExit && this.timelineExitGate) {
        try {
          const timeline = await this.timelineExitGate(pos.symbol, pos.direction);
          if (timeline.shouldExit) {
            decision = { shouldExit: true, reason: timeline.reason ?? "TIMELINE_REVERSAL", nextPeakFavorableR: laneDecision.nextPeakFavorableR };
          }
        } catch {
          // Timeline is an overlay, never a reason to interrupt established exit management.
        }
      }
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
    if (this.closingPositionIds.has(pos.positionId)) return; // a concurrent close is already in flight
    this.closingPositionIds.add(pos.positionId);
    try {
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
      // pos.qty may already reflect a smaller REMAINING qty if a prior stop trigger partially
      // filled this position (see settleIfStopTriggered's 2026-07-12 fix) — this leg's gross/fee
      // is correctly scoped to just that remainder; fold in the earlier leg's real banked P&L so
      // the total reflects this position's FULL lifetime, not just the final leg.
      //
      // 2026-07-12 fee-recording fix: prefer the REAL exchange gross/commissions from getUserTrades
      // (same authoritative source settleIfStopTriggered already uses) over the fill-price-diff +
      // flat TAKER_FEE_RATE estimate — the estimate is only the fallback when the trades fetch
      // fails, so this position must still finish closing bookkeeping-wise this tick either way.
      let gross: number;
      let fees: number;
      const settled = await this.sumOwnRealizedTrades(pos, pos.exitOrderId);
      if (settled !== null && settled.exitQty > 0) {
        gross = (pos.realizedPartialGrossUsd ?? 0) + settled.realized;
        fees = (pos.realizedPartialFeeUsd ?? 0) + settled.fees;
      } else {
        gross = (pos.realizedPartialGrossUsd ?? 0) + dir * (exit - pos.entryPrice) * pos.qty;
        const notional = pos.entryPrice * pos.qty + exit * pos.qty;
        fees = (pos.realizedPartialFeeUsd ?? 0) + notional * TAKER_FEE_RATE;
        this.lastError = `close ${pos.positionId}: exit trades not retrievable this tick — P&L recorded from fill-price estimate (fees estimated at ${TAKER_FEE_RATE * 1e4}bps/side)`;
      }
      pos.status = "CLOSED";
      pos.closedAt = this.nowIso();
      pos.closeReason = reason;
      pos.grossPnlUsd = gross;
      pos.feeEstimateUsd = fees;
      const netUsd = gross - fees;
      pos.netPnlUsd = netUsd;
      this.store.save();
      // 2026-07-19 real-money audit fix: see settleIfStopTriggered's identical call — this covers
      // every OTHER close path (policy exit, manual close, orderly kill-switch wind-down).
      this.notifyPositionClosed(netUsd);
    } finally {
      this.closingPositionIds.delete(pos.positionId);
    }
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

    // Binance USD-M one-way mode nets positions by symbol. Never let an independently-managed
    // lane reverse or reduce an existing exchange position simply because it sees an opposite
    // signal; that position must be closed by its own owner first.
    let exchangePositions: Awaited<ReturnType<SingleSymbolExecClient["getPositions"]>>;
    try {
      exchangePositions = await this.sharedGetPositions();
    } catch (error) {
      this.lastEntrySkipReason = `exchange position check failed (${(error as Error).message})`;
      return;
    }

    // Loop (not just candidates[0]): a regime-level gate can legitimately fire on several symbols
    // in the SAME cycle (unlike a per-symbol technical trigger, which rarely does) — attempt every
    // fresh candidate up to remaining capacity in ONE tick rather than trickling one in per 5-min
    // tick. See the state interface's doc comment for the incident this (plus per-observationId
    // dedup) fixes.
    for (const signal of candidates) {
      if (st.positions.filter((p) => p.status === "OPEN").length >= this.maxOpenPositionsFn()) {
        this.lastEntrySkipReason = `max open positions (${this.maxOpenPositionsFn()}) reached for this lane instance`;
        break;
      }

      if (exchangePositions.some((p) => p.symbol === signal.symbol && Math.abs(p.positionAmt) > 1e-9)) {
        this.lastEntrySkipReason = `${signal.symbol}: exchange position already exists; refusing one-way-mode netting`;
        continue;
      }

      // The BTC/ETH/SOL timeline is deliberately evaluated before consuming the observation id.
      // A WAIT is transient; the same still-fresh lane signal can become executable if the next
      // timeline refresh confirms its direction. Market-data failure therefore fails closed for a
      // NEW entry, never marks a valid signal permanently attempted.
      if (this.timelineEntryGate) {
        try {
          const timeline = await this.timelineEntryGate(signal, this.direction);
          if (!timeline.allowed) {
            this.lastEntrySkipReason = timeline.reason ?? `${signal.symbol}: timeline entry gate rejected`;
            continue;
          }
        } catch (error) {
          this.lastEntrySkipReason = `${signal.symbol}: timeline entry gate unavailable (${(error as Error).message})`;
          continue;
        }
      }

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
      if (notionalCap > 0) {
        // 2026-07-12 fix: existingNotionalForSymbolFn only ever sums OTHER lane instances —
        // this instance's OWN already-open positions on the SAME symbol (maxOpenPositions caps
        // total count across all symbols, not per-symbol, so this instance could otherwise stack
        // several) were invisible to this cap. Add them explicitly.
        const ownSameSymbolNotional = st.positions
          .filter((p) => p.status === "OPEN" && p.symbol === signal.symbol)
          .reduce((sum, p) => sum + p.qty * p.entryPrice, 0);
        if (this.existingNotionalForSymbolFn(signal.symbol) + ownSameSymbolNotional + this.effectiveLegUsd() > notionalCap) {
          // 2026-07-19 real-money audit fix: every OTHER skip branch in this function sets
          // lastEntrySkipReason; this one (and the structural rejections below) silently left it
          // null, giving the operator zero diagnostic for why a candidate was rejected.
          this.lastEntrySkipReason = `${signal.symbol}: cross-lane per-symbol notional cap exceeded (cap ${notionalCap})`;
          continue;
        }
      }

      // The shared position snapshot above is intentionally cached for monitoring efficiency.
      // It is not safe as the final authority for an entry: two sibling lane ticks can both see
      // the same cached-flat symbol and otherwise submit opposing orders into Binance one-way
      // mode. Claim synchronously, then re-read this symbol directly before consuming a signal.
      if (!this.tryClaimEntrySymbol(signal.symbol)) {
        this.lastEntrySkipReason = `${signal.symbol}: another executor is admitting this netted symbol`;
        continue;
      }
      try {
        const freshPositions = await this.client.getPositions(signal.symbol);
        if (freshPositions.some((p) => p.symbol === signal.symbol && Math.abs(p.positionAmt) > 1e-9)) {
          this.lastEntrySkipReason = `${signal.symbol}: fresh exchange position already exists; refusing one-way-mode netting`;
          continue;
        }

      // Mark attempted BEFORE placing orders: a failed/rejected entry must not retry forever on
      // the same signal. Bounded — this is a dedup set, not a growing audit log.
      attempted.add(signal.observationId);
      st.attemptedObservationIds = Array.from(attempted).slice(-500);
      this.store.save();

      const legUsd = this.effectiveLegUsd();
      if (!(legUsd > 0)) {
        // 2026-07-19 real-money audit fix: see the notional-cap skip's identical comment above —
        // this was another silent structural rejection.
        this.lastEntrySkipReason = `${signal.symbol}: invalid leg size (legUsd=${legUsd})`;
        continue;
      }
      if (!(signal.entryPrice > 0)) {
        this.lastEntrySkipReason = `${signal.symbol}: entry price unavailable`;
        continue;
      }

      // 2026-07-12 fix: everything from here down makes real network calls (exchange filters,
      // leverage, the entry order itself) — a transient failure (network blip, margin, rate
      // limit) must not permanently blacklist this signal via the attempted-mark above. Only the
      // STRUCTURAL rejections above (bad legUsd/entryPrice) and below (fails minQty/minNotional,
      // via `continue` — never thrown) stay permanent, since re-evaluating an unchanged signal
      // against unchanged geometry can't produce a different outcome.
      try {
        const filters = await this.client.getExchangeFilters();
        const f = filters.get(signal.symbol);
        if (!f) {
          // 2026-07-19 real-money audit fix: see the notional-cap skip's comment above.
          this.lastEntrySkipReason = `${signal.symbol}: exchange filters unavailable`;
          continue;
        }
        const rawQty = legUsd / signal.entryPrice;
        // 2026-07-19 real-money audit fix: the previous manual `Math.floor(rawQty / f.stepSize) *
        // f.stepSize` had no epsilon guard, so plain floating-point representation error (e.g.
        // legUsd=140.07, entryPrice=20010, stepSize=0.001 -> rawQty=0.006999999999999999) silently
        // floored to ONE STEP BELOW the correct quantity — shrinking the real order by up to one
        // stepSize (14.3% in that example) and, worse, could permanently fail a minQty/minNotional
        // check a signal should have passed. roundToStep() is the SAME epsilon-before-floor
        // convention binance-futures-private.ts's placeOrder()/placeAlgoOrder() already apply to
        // this exact quantity before it hits the exchange — reusing it here means the size checked
        // against minQty/minNotional below is the SAME size actually sent, and never rounds a
        // genuinely-below-threshold value up into passing.
        const qty = roundToStep(rawQty, f.stepSize, "down");
        if (!(qty >= f.minQty)) {
          // 2026-07-19 real-money audit fix: see the notional-cap skip's comment above.
          this.lastEntrySkipReason = `${signal.symbol}: quantity ${qty} below exchange minQty ${f.minQty}`;
          continue;
        }
        const notional = qty * signal.entryPrice;
        if (!(notional >= f.minNotional)) {
          // Binance rejects an order that clears minQty but misses MIN_NOTIONAL.
          this.lastEntrySkipReason = `${signal.symbol}: notional ${notional.toFixed(2)} below exchange minNotional ${f.minNotional}`;
          continue;
        }

        // Symbol fragment keeps this unique even when 2+ candidates share the identical openedAtMs
        // (the exact scenario that exposed the dedup bug above).
        const positionId = `ssl-${this.laneId.slice(0, 4).toLowerCase()}-${signal.symbol.slice(0, 3).toLowerCase()}-${signal.openedAtMs.toString(36)}`;
        // 2026-07-12 fix: leverage is a shared, symbol-scoped Binance account setting, not
        // per-strategy — this call used to run unconditionally on every entry with zero awareness
        // that a SIBLING executor (a different SingleSymbolLaneExecutor instance, or any other
        // real-money path on this same account) might already hold an open position on this exact
        // symbol at a DIFFERENT leverage. Binance allows changing leverage with a position open,
        // and doing so immediately recalculates that position's margin/liquidation price — the
        // "best-effort (already set / position exists)" comment this replaces assumed the call was
        // inert in that case; it is not. Skip the call entirely when ANY position already exists
        // on this symbol, accepting whatever leverage is already set rather than risk silently
        // moving someone else's real position closer to liquidation.
        try {
          const existing = await this.client.getPositions(signal.symbol);
          const hasExistingPosition = existing.some((p) => p.symbol === signal.symbol && Math.abs(p.positionAmt) > 1e-9);
          if (!hasExistingPosition) {
            await this.client.setLeverage(signal.symbol, this.leverageFn());
          }
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
        // this comment used to claim the stop is placed on the VERY NEXT tick, contradicting this
        // file's own header comment ("places a REAL exchange-side STOP_MARKET algo order
        // immediately after entry") — tick() runs monitorOpenPositions() (which calls
        // ensureStopOrder for existing positions) BEFORE maybeOpenPosition(), so a freshly-opened
        // position genuinely sat unprotected for a full tick interval, the exact fast-adverse-move
        // risk the header comment itself warns about. Now calls ensureStopOrder eagerly, same tick —
        // reuses the identical retry-safe function (no duplicated logic), so the next tick's own
        // monitorOpenPositions call is simply a no-op confirmation once this succeeds.
        await this.ensureStopOrder(position);
      } catch (error) {
        attempted.delete(signal.observationId);
        st.attemptedObservationIds = Array.from(attempted);
        this.lastEntrySkipReason = `${signal.symbol}: entry failed (${(error as Error).message}) — will retry next tick`;
        this.store.save();
      }
      } finally {
        this.releaseEntrySymbol(signal.symbol);
      }
    }
  }
}

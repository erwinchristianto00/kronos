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

import type { ExposureReserveCampaignCap, ExposureReserveRequest, ExposureReserveResult } from "./account-exposure-coordinator.js";
import { BinanceFuturesPrivateError, resolveConfirmedFillPrice, roundToStep, type BinanceFuturesPrivateClient } from "./binance-futures-private.js";
import { clusterOf, isMajorSymbol } from "./correlation-clusters.js";
import type { CortexRealAttributionStore } from "./cortex-real-attribution.js";
import { fillFromUserTrade, type ExecutionFill, type ExecutionFillRecorder } from "./execution-fill-recorder.js";
import { makerLimitPrice, resolveMakerLeg, signedMakerEntryQtyBySymbol } from "./maker-entry-plan.js";
import { confirmMakerCancel, isTerminalMakerOrderStatus } from "./maker-cancel-confirmation.js";
import type { FourBrainActualFillBindingStore } from "./four-brain-actual-fill-binding.js";
import type { FourBrainBridgeCandidate, FourBrainBridgeDecision } from "./four-brain-testnet-bridge.js";
import type { PositionPathRecorder } from "./position-path-recorder.js";

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
> &
  /** Optional so every existing fake client keeps compiling. Maker entry REFUSES to run without it:
   *  a post-only order that cannot be cancelled has no safe way to stop resting, and here that
   *  matters more than on the basket path — a partially filled resting order means a LIVE, unstopped
   *  position. */
  /** 2026-08-18: also optional. Without it reconcilePendingMakerEntries cannot resolve a resting
   *  order after a restart, so it degrades to leaving the handle pending rather than guessing. */
  Partial<Pick<BinanceFuturesPrivateClient, "cancelOrder" | "queryOrderByClientId">>;

export interface SingleSymbolFreshSignal {
  observationId: string;
  symbol: string;
  entryPrice: number;
  stopPrice: number;
  openedAtMs: number;
  /** Optional observation-owned target. Existing lanes omit this and keep their static policy. */
  targetPrice?: number | null;
  /** Optional observation-owned horizon. Existing lanes omit this and keep their static policy. */
  maxHoldMs?: number | null;
}

export interface SingleSymbolExitContext {
  symbol: string;
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

/** 2026-07-19 real-money audit fix (see settleIfStopTriggered): Binance's algo/order status
 *  vocabulary is inconsistent across endpoints (FuturesAlgoOrder.algoStatus falls back to the
 *  plain-order vocabulary — NEW | PARTIALLY_FILLED | FILLED | CANCELED | EXPIRED | REJECTED — when
 *  the algo-specific field is absent). Only the strings that unambiguously mean "gone from the
 *  order book, and NOT because it triggered/filled" count as terminal-without-trigger. Anything
 *  else (NEW/WORKING/unrecognized/empty) is treated as still resting — the same fail-safe posture
 *  as a queryAlgoOrder network failure (retry next tick rather than act on an ambiguous read). */
function isTerminalStopWithoutTrigger(algoStatus: string): boolean {
  const s = algoStatus.trim().toUpperCase();
  return s === "CANCELED" || s === "CANCELLED" || s === "EXPIRED" || s === "REJECTED";
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
 *  givebackFrac of the peak. A lane may additionally protect a specified estimated-net winner:
 *  crossing that level does NOT close the runner, but a later retrace back through it does.
 *  Otherwise the stop (−1R) or mark-to-market at maxHoldMs. */
export function makeMfeGivebackExitPolicy(opts: {
  armR: number;
  givebackFrac: number;
  maxHoldMs: number;
  /** Optional profit-lock, as a fraction of entry after estimated close cost. Not a static TP.
   *
   *  MEASURED DEFECT (2026-08-16): this is denominated in PRICE, while `armR` and the stop are
   *  denominated in R, so one config produces a different reward:risk on every position. Across 14
   *  real directional closes the stop width ranged 0.47%-2.18% of entry, which turned a single
   *  `profitLockNetReturn: 0.005` into a lock at 1.15R on ETH and 0.25R on SOL — reward:risk varying
   *  4.6x by nothing but the symbol's volatility at entry. Prefer `profitLockR` below. */
  profitLockNetReturn?: number;
  /** Profit-lock in R, the same unit as `armR` and the stop: arm once peak favorable-R reaches this
   *  level, exit if price retraces back through it.
   *
   *  Takes precedence over `profitLockNetReturn` when set, and needs neither `riskFraction` nor
   *  `estimatedCloseCostPct` to be interpreted — the geometry is the same on every symbol and at
   *  every volatility, which is the entire point. Additive on purpose: lanes that pass only
   *  `profitLockNetReturn` keep their existing behavior byte for byte. */
  profitLockR?: number;
  /** Full take-profit in R — closes the WHOLE position the moment favorable-R reaches it. There is
   *  no remainder: this is not a partial. Unset/0 = no TP, which is what every lane had before.
   *
   *  MEASURED (250 days, neutral entries, stop 2%, arm 0.75/giveback 0.30): a TP is HARMFUL below
   *  1.5R — at 0.50R it removes 97% of the result, because it caps every winner at 0.5R while stops
   *  still take a full −1R. At 1.5R it is exactly return-NEUTRAL (−0.0000R) and converts 14 points
   *  of uncertain GIVEBACK exits into certain ones, shortening holds and narrowing the spread. Above
   *  that the gain is inside the noise. So: 1.5R buys variance, not return, and anything tighter
   *  costs real money.
   *
   *  FIRES ON TICK, not intrabar. The simulation that produced those numbers used candle high/low;
   *  this policy sees whatever price the tick passes it, so in production the TP will trigger later
   *  and less often than measured. Treat the measured figures as an upper bound. */
  staticTpR?: number;
  /** One-way estimated close cost used to express the lock in net terms. Unused by `profitLockR`. */
  estimatedCloseCostPct?: number;
}): SingleSymbolExitPolicy {
  return (ctx) => {
    const r = favorableR(ctx.direction, ctx.entryPrice, ctx.stopPrice, ctx.currentPrice);
    const nextPeakFavorableR = Math.max(ctx.peakFavorableR, r);
    if (r <= -1) return { shouldExit: true, reason: "INITIAL_STOP", nextPeakFavorableR };
    const riskFraction = ctx.entryPrice > 0 ? Math.abs(ctx.entryPrice - ctx.stopPrice) / ctx.entryPrice : 0;
    const costFraction = Number.isFinite(opts.estimatedCloseCostPct) && opts.estimatedCloseCostPct! > 0
      ? opts.estimatedCloseCostPct!
      : 0;
    const lockNet = Number.isFinite(opts.profitLockNetReturn) && opts.profitLockNetReturn! > 0
      ? opts.profitLockNetReturn!
      : null;
    // Full TP is checked BEFORE the lock and the giveback: it is the highest level of the three, so
    // if price is there the other two would only ever book less.
    const tpR = Number.isFinite(opts.staticTpR) && opts.staticTpR! > 0 ? opts.staticTpR! : null;
    if (tpR !== null && r >= tpR) {
      return { shouldExit: true, reason: "STATIC_TP", nextPeakFavorableR };
    }
    // R-denominated lock wins when set: same unit as armR and the stop, so no conversion and no
    // dependence on how wide this particular position's stop happens to be.
    const lockR = Number.isFinite(opts.profitLockR) && opts.profitLockR! > 0 ? opts.profitLockR! : null;
    if (lockR !== null) {
      if (nextPeakFavorableR >= lockR && r <= lockR) {
        return { shouldExit: true, reason: "MFE_PROFIT_LOCK", nextPeakFavorableR };
      }
      if (nextPeakFavorableR >= opts.armR) {
        const givebackLineR = nextPeakFavorableR * (1 - opts.givebackFrac);
        if (r <= givebackLineR) return { shouldExit: true, reason: "MFE_GIVEBACK", nextPeakFavorableR };
      }
      if (ctx.msHeld >= opts.maxHoldMs) return { shouldExit: true, reason: "MAX_HOLD_MTM", nextPeakFavorableR };
      return { shouldExit: false, reason: null, nextPeakFavorableR };
    }
    // `peak` is stored in R while the operator target is a net return. Convert both from the
    // same frozen entry/stop geometry so the lock is invariant to mark-price scale and direction.
    const peakNetReturn = nextPeakFavorableR * riskFraction - costFraction;
    const currentNetReturn = r * riskFraction - costFraction;
    // Floating-point price/risk arithmetic can leave an exact +0.50% lock as
    // 0.005000000000000001. Treat only machine-noise as equal, never a meaningful
    // undershoot/overshoot of the operator's net threshold.
    const lockEpsilon = 1e-9;
    if (lockNet !== null && peakNetReturn >= lockNet - lockEpsilon && currentNetReturn <= lockNet + lockEpsilon) {
      return { shouldExit: true, reason: "MFE_PROFIT_LOCK", nextPeakFavorableR };
    }
    if (nextPeakFavorableR >= opts.armR) {
      const givebackLine = nextPeakFavorableR * (1 - opts.givebackFrac);
      if (r <= givebackLine) return { shouldExit: true, reason: "MFE_GIVEBACK", nextPeakFavorableR };
    }
    if (ctx.msHeld >= opts.maxHoldMs) return { shouldExit: true, reason: "MAX_HOLD_MTM", nextPeakFavorableR };
    return { shouldExit: false, reason: null, nextPeakFavorableR };
  };
}

/** A public order-book quote this process has ALREADY observed for a symbol, offered to the
 *  executor as a synchronous, zero-I/O read (see SingleSymbolLaneExecutorOptions.readPublicQuote).
 *  Purely a recording input — nothing in this file branches on it. */
export interface PublicQuoteSnapshot {
  bid: number | null;
  ask: number | null;
  /** Whatever single reference price the producer derived (normally (bid+ask)/2). */
  mid: number;
  /** Epoch ms at which the producer observed this quote. */
  atMs: number;
  /** Verbatim venue/endpoint label from the producer, persisted with every sample so a consumer
   *  can never silently forget WHICH book this came from. app.ts currently supplies
   *  "BINANCE_SPOT_BOOK_TICKER" — see readPublicQuote's doc comment for why that matters. */
  venue: string;
}

/** RECORDING-ONLY (2026-07-27). What the public market looked like immediately BEFORE this
 *  position's entry order was submitted, so a later report can compare it against the exchange's
 *  own fill. Never read by any gate, sizing, exit or admission path in this file — it is written
 *  once, into the position record, and never looked at again here.
 *
 *  READING THIS HONESTLY — three caveats, all of them persisted rather than assumed away:
 *   - `ageAtSubmitMs` is real and is NOT small. The quote is captured at the entry-chase gate;
 *     between there and placeOrder the executor awaits 2-3 signed round-trips (getPositions,
 *     getExchangeFilters, getPositions again, setLeverage). Expect hundreds of ms to low seconds
 *     from Contabo, with a 6s-per-call timeout worst case. Any report MUST discard samples above
 *     a threshold rather than average them in.
 *   - `venue` may not be the venue we traded on. app.ts's currentPublicPrice is wired to
 *     BinanceClient.getBookTicker(), which hits SPOT /api/v3/ticker/bookTicker — NOT the USD-M
 *     perp book these orders actually execute against. A fill-vs-reference difference therefore
 *     contains perp/spot BASIS as well as execution slippage, and the two cannot be separated
 *     from this record alone.
 *   - `mid` vs `bid`/`ask`. The live path is 100% taker, so a BUY lifts the ask and a SELL hits
 *     the bid. `fill - mid` is the full round-trip cost INCLUDING half the spread; `fill - ask`
 *     (BUY) or `bid - fill` (SELL) is the pure impact/latency component. Both are recorded so a
 *     consumer can compute either; neither is "the" answer. (Note: measuring against the mid
 *     yields a LARGER number than measuring against the touch, not a smaller one.)
 *  `source` is "MID_ONLY" whenever a two-sided quote was not available — in that case bid and ask
 *  are null and `atMs` is the instant BEFORE the price fetch started, so `ageAtSubmitMs` is a
 *  deliberate OVER-estimate. It is never back-filled from the signal's own entryPrice. */
export interface SubmitReferenceQuote {
  mid: number;
  bid: number | null;
  ask: number | null;
  atMs: number;
  /** this.nowIso() sampled immediately before placeOrder, minus atMs. Floored at 0 — see
   *  `clockAnomaly` for the case where that floor is hiding something. */
  ageAtSubmitMs: number;
  venue: string;
  source: "BOOK_TICKER" | "MID_ONLY";
  /** MACHINE-READABLE restatement of the venue caveat above, added 2026-07-27 because a caveat that
   *  only exists as prose inside a `venue` STRING is a caveat that will be skipped. False means the
   *  reference book is NOT the book this order executes on (today: SPOT vs USD-M perp), so
   *  `fill - mid` contains perp/spot BASIS — routinely tens of bps on a mid-cap alt, i.e. an order
   *  of magnitude larger than the 5.0 bps/side commission and capable of making execution look
   *  several times more expensive than it is. Any slippage report MUST either filter to
   *  `venueMatchesExecution === true` or model the basis explicitly; it must not average across
   *  both. "UNKNOWN" venue is treated as NOT matching — an unlabelled book is not evidence of a
   *  matching one. */
  venueMatchesExecution: boolean;
  /** Present and true ONLY when the raw (unfloored) age was NEGATIVE, i.e. the quote's `atMs`
   *  (stamped by the producer's clock in app.ts) is later than the submit instant (stamped by this
   *  executor's injected clock). `ageAtSubmitMs` is then 0 — the single most credible-looking value
   *  the field can hold, since 0 reads as "the reference was live at submission" — so without this
   *  marker a report that correctly keeps only low-age samples would preferentially retain exactly
   *  the corrupted ones. Causes: an NTP step between the book fetch and placeOrder, or a test/caller
   *  injecting a nowIso offset from app.ts's Date.now(). Absent = the delta was non-negative. */
  clockAnomaly?: true;
  /** Present and true ONLY when the two-sided quote recovered from the shared per-symbol cache has
   *  a DIFFERENT mid than the one the entry-chase gate actually evaluated. The cache is
   *  process-wide across every lane executor, so a sibling executor's fetch for the same symbol can
   *  land between this executor's own fetch and its read-back; the freshness guard accepts it
   *  (its atMs is newer) and the persisted reference is then a quote this position's gate never
   *  saw. Recording-only, and rare, but without the marker the substitution is indistinguishable
   *  from real slippage. Absent = the recorded mid is the gate's own. */
  midDiffersFromGateMid?: true;
}

/** Venue labels whose book IS the one these orders execute against (Binance USD-M perpetual
 *  futures). Anything else — including SPOT and "UNKNOWN" — sets venueMatchesExecution false. Kept
 *  as an explicit allow-list rather than a substring test so a new producer label defaults to
 *  "not the execution venue" instead of silently claiming to be. */
const EXECUTION_VENUE_LABELS: ReadonlySet<string> = new Set([
  "BINANCE_FUTURES_BOOK_TICKER",
  "BINANCE_USDM_BOOK_TICKER",
]);

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
  /** Frozen signal geometry for research-lane execution. Undefined on legacy persisted positions. */
  targetPrice?: number | null;
  /** Frozen signal horizon for research-lane execution. Undefined on legacy persisted positions. */
  maxHoldMs?: number | null;
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
  /** Positive magnitude of the deepest observed adverse R. Optional for legacy persisted rows. */
  peakAdverseR?: number;
  /** Completeness latch for direct actual-fill learning across a partial stop lifecycle. */
  actualFillSettlementComplete?: boolean;
  openedAt: string;
  status: "OPEN" | "CLOSED" | "ABORTED";
  closedAt: string | null;
  closeReason: string | null;
  exitPrice: number | null;
  exitOrderId: string | null;
  exitPriceConfirmed: boolean | null;
  grossPnlUsd: number | null;
  feeEstimateUsd: number | null;
  /** PROVENANCE of feeEstimateUsd (2026-07-26, purely additive, report-only — nothing reads it to
   *  make a decision). The field name "feeEstimateUsd" has always covered two entirely different
   *  numbers with no way to tell them apart, and a live audit of 21 closed positions found 14 real
   *  exchange commissions and 7 bit-exact TAKER_FEE_RATE estimates sitting side by side under it.
   *  The two errors point in OPPOSITE directions and partially cancel in any aggregate, which is
   *  precisely why the ambiguity survived several fee audits.
   *
   *    "EXCHANGE"            — summed from getUserTrades commission rows (sumOwnRealizedTrades).
   *    "ESTIMATE_TAKER_FLAT" — contains a modelled TAKER_FEE_RATE component: either the whole
   *                            figure (trades unavailable this tick) or the final leg only, with an
   *                            earlier partial leg's real commission folded in. Deliberately NOT
   *                            split further: any figure carrying a modelled component must be
   *                            excluded from cost analysis, so one label is enough.
   *    undefined             — position persisted before this field existed, or never closed.
   *                            UNKNOWN. Must never be assumed exchange-true.
   *
   *  "EXCHANGE" documents the METHOD, not completeness. It asserts the number came from Binance's
   *  own commission rows; it does NOT assert that every row belonging to this position is in the
   *  sum. By default it is still exit-side only (~50% of the true two-sided cost, confirmed against
   *  the exchange on the BTCUSDT 2026-07-25/26 pair) — but the reason changed on 2026-07-26. It used
   *  to be a QUERY bug (startTime = openedAt, stamped after the entry placeOrder, so the entry row
   *  was never even returned); that is fixed, see entryTradeWindowFromMs. It is now a deliberate,
   *  operator-gated CHOICE, because folding the entry commission in moves netPnlUsd and netPnlUsd
   *  drives two execution gates — see FOLD_ENTRY_LEG_INTO_PNL. Read entryLegFoldedIntoPnl on the
   *  record to know which you have; entryCommissionUsd tells you the exact size of what is missing
   *  when it is false. This flag stays independent of both so the before/after shift attributable to
   *  enabling the fold stays unambiguous. */
  feeSource?: "EXCHANGE" | "ESTIMATE_TAKER_FLAT";
  /** The exit geometry this position was OPENED under, frozen at open.
   *
   *  Without it a reader can only show today's levels against a historical position, which reads as
   *  fact and is not: positions opened 2026-08-13/14 ran armR 0.20 with a price-denominated lock,
   *  nothing like the current 0.75/0.15R. Absent on every position opened before 2026-08-17, and a
   *  reader must render those as unknown rather than substitute the running config. */
  exitGeometryAtOpen?: { armR: number; givebackFrac: number; profitLockR: number | null; staticTpR: number | null };
  /** How the ENTRY was actually filled, split by liquidity. Exact, not an estimate: Binance rejects
   *  a GTX order that would cross, so it can only fill as maker, and a MARKET order can only fill as
   *  taker — which order filled which quantity IS the split. Absent on every position opened before
   *  maker entry existed, which by construction of the code then means taker. */
  entryLiquidity?: { makerQty: number; takerQty: number; reason: string } | null;
  netPnlUsd: number | null;
  /** Cumulative gross/fee P&L already realized from a PRIOR partial fill on this same position
   *  (2026-07-12 fix: a triggered stop can partially fill when a sibling executor's netting has
   *  reduced the exchange-side reduce-only qty available). Optional for backward compatibility
   *  with positions persisted before this field existed (`?? 0` at every read site). Added into
   *  the final leg's totals whichever path (settleIfStopTriggered or closePosition) closes the
   *  position's now-reduced remaining qty. */
  realizedPartialGrossUsd?: number;
  realizedPartialFeeUsd?: number;
  /** Set true once the entry order's own realizedPnl/commission has been ACCOUNTED FOR — folded into
   *  realizedPartial*Usd when the fold predicate allowed it, and recorded into entryCommissionUsd /
   *  entryRealizedPnlUsd either way. Prevents re-counting the SAME entry trade on a second (or
   *  third) partial-fill cycle, since getUserTrades is re-queried over the same window every time. */
  entryFeeRealized?: boolean;
  /** THE FEE-WINDOW FIX (2026-07-26). Epoch ms captured immediately BEFORE the entry placeOrder,
   *  minus FEE_WINDOW_SLACK_MS — the correct lower bound for sumOwnRealizedTrades' getUserTrades
   *  window.
   *
   *  openedAt (the previous lower bound, and still the fallback for positions persisted before this
   *  field existed) is stamped AFTER placeOrder returns AND after resolveFillPrice, which can retry
   *  4x400ms plus 4 queryOrder round-trips. Binance stamps a fill's `time` on its own clock at match,
   *  i.e. before the HTTP response is even serialised, so openedAt is ALWAYS later than the entry
   *  fill. startTime is inclusive on trade time, so the entry row was always outside the window and
   *  the `t.orderId === pos.entryOrderId` branch in sumOwnRealizedTrades was unreachable — every
   *  per-position fee on this path recorded the EXIT side only, ~50% of the true two-sided cost
   *  (confirmed against the exchange on the BTCUSDT 2026-07-25/26 pair: charged 0.03218755 +
   *  0.03216179, recorded 0.03216179).
   *
   *  VISIBILITY IS NOT FOLDING. This field only changes which rows come back. Whether the entry
   *  commission then reaches feeEstimateUsd/netPnlUsd is a separate, operator-gated decision, because
   *  netPnlUsd drives the daily-loss entry gate and the consecutive-loss kill switch — see
   *  FOLD_ENTRY_LEG_INTO_PNL and sumOwnRealizedTrades. entryCommissionUsd is populated regardless.
   *
   *  Additive and optional; read by nothing but that window. Undefined = fall back to openedAt, i.e.
   *  exactly the old (mis-recording) behaviour, never a fabricated retro-fit. */
  entryTradeWindowFromMs?: number;
  /** RECORDING-ONLY. The ENTRY order's own exchange-side commission, summed from getUserTrades once
   *  entryTradeWindowFromMs makes it visible. Always populated when the entry row is seen, on every
   *  close path, REGARDLESS of FOLD_ENTRY_LEG_INTO_PNL — this is the number that makes the
   *  understatement measurable without moving anything the daily-loss gate or kill-switch reads.
   *  Assigned (not accumulated) so a settle that retries next tick cannot double-count.
   *  Undefined = the entry row was never observed (pre-fix position, or trades unavailable). */
  entryCommissionUsd?: number;
  /** RECORDING-ONLY. The entry order's own realizedPnl as Binance reports it. Normally 0 — an
   *  opening trade realizes nothing. A NONZERO value means this "entry" actually reduced an opposite
   *  position on this netted account, which is exactly the cross-executor netting hazard this file
   *  documents elsewhere and is worth being able to see after the fact. */
  entryRealizedPnlUsd?: number;
  /** True when grossPnlUsd/feeEstimateUsd/netPnlUsd on THIS record include the entry leg above;
   *  false when they are exit-side only. Lets a consumer tell a fully-costed record from a
   *  half-costed one instead of inferring it from a ratio — which is exactly what the 2026-07-26
   *  live audit had to do (14 records at ratio ~0.5, 7 at exactly 1.00) because nothing recorded it.
   *  With FOLD_ENTRY_LEG_INTO_PNL off, `true` still occurs for an entry fill Binance timestamped at
   *  or after openedAt — the rows the OLD window already returned, kept folded so this change cannot
   *  loosen a gate. Undefined = closed before this field existed, the entry row was never observed,
   *  or closed via the flat-estimate fallback. That last case is undefined and NOT false on purpose:
   *  the estimate arm's feeEstimateUsd is notional*TAKER_FEE_RATE over BOTH sides, so it already
   *  contains a modelled entry fee — `false` there would invite a consumer to add
   *  entryCommissionUsd on top and double-count it. Read it strictly three-valued: true = the
   *  exchange's entry commission is in the totals, false = the totals are exit-side only and
   *  entryCommissionUsd is additive, undefined = not answerable, do not reconstruct. */
  entryLegFoldedIntoPnl?: boolean;
  /**
   * Read-model provenance for a returned CLOSED position. The durable fields above
   * remain the exchange-order settlement captured at close time. When an executor
   * opts into own-lot attribution, getStatus()/getClosedPositions() replace the
   * displayed P&L with this position's entry-to-exit economics and retain these
   * three raw exchange figures for audit. They are never written back to the
   * executor store.
   */
  exchangeAccountGrossPnlUsd?: number | null;
  exchangeAccountFeeUsd?: number | null;
  exchangeAccountNetPnlUsd?: number | null;
  pnlAttribution?: "EXCHANGE_NETTED" | "OWN_LOT" | "INCOMPLETE";
  pnlAttributionComplete?: boolean;
  /** CORTEX real-USDT attribution capture (2026-07-21, report-only — see cortex-real-attribution.ts):
   *  the allocation weight this executor's sizing ACTUALLY applied to this entry (laneWeightPct —
   *  wired to laneSelectionWeightPctForLane in app.ts, so it includes any active CORTEX promoted
   *  tilt) and the operator's untouched static table weight (rawLaneWeightPct), both frozen AT OPEN
   *  time. Undefined on positions persisted before this feature — those are never attributed. */
  cortexAppliedWeightPct?: number;
  cortexRawStaticWeightPct?: number;
  /** RECORDING-ONLY (2026-07-27) — see SubmitReferenceQuote's doc comment for how to read it and
   *  for the three caveats (age, venue, mid-vs-touch) that are persisted rather than assumed away.
   *  Captured at the entry-chase gate from the quote currentPrice() already fetched; costs ZERO
   *  extra exchange calls and adds ZERO awaits to the order path.
   *  `null`      = no reference was available (currentPrice not wired, or it returned no usable
   *                price). NEVER back-filled from signal.entryPrice, which is up to maxSignalAgeMs
   *                (default 50 min) old and would look like a real benchmark while being one.
   *  `undefined` = position persisted before this field existed. Same meaning as null; separate
   *                only because rewriting old records would be a lie about when this was measured. */
  submitRef?: SubmitReferenceQuote | null;
}

/**
 * An entry order that has been SENT but whose outcome is not yet booked as a position.
 *
 * 2026-08-18. Post-only entry rests on the book for up to CROSS_SECTIONAL_DIRECTIONAL_MAKER_ENTRY_-
 * WAIT_MS (120s in production) while `placeEntryMakerFirst` polls it. Until today the orderId lived
 * only in a local variable, so a restart inside that window lost the only handle to it: the order
 * stays REAL on the exchange, nothing knows it exists, and if it fills the result is a live position
 * with no stop and no tracking — the "invisible naked position" class this file's own reconciliation
 * was built to prevent. cross-sectional-executor.ts already persists makerRestingOrderId on the
 * basket plan; this is the same protection for the directional lanes.
 *
 * Written BEFORE the order is sent, so even a crash between send and response leaves the handle.
 * The handle is `clientOrderId`, which is deterministic and computed before placement, so it stays
 * searchable via queryOrderByClientId no matter what happened to the response.
 */
export interface PendingMakerEntry {
  clientOrderId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  qty: number;
  placedAt: string;
  sourceObservationId: string;
  /** Everything needed to build a real, STOPPED position if the order turns out to have filled. */
  stopPrice: number;
  targetPrice?: number | null;
  maxHoldMs?: number | null;
}

interface SingleSymbolExecutorState {
  version: number;
  positions: SingleSymbolPosition[];
  /** Optional so state files written before 2026-08-18 still load unchanged. */
  pendingMakerEntries?: PendingMakerEntry[];
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

  /** Persist an entry order BEFORE it is sent. Bounded: a stuck record cannot accumulate because
   *  reconcilePendingMakerEntries drops anything the exchange says never existed. */
  addPendingMakerEntry(entry: PendingMakerEntry): void {
    const list = this.state.pendingMakerEntries ?? [];
    if (!list.some((e) => e.clientOrderId === entry.clientOrderId)) list.push(entry);
    this.state.pendingMakerEntries = list.slice(-50);
    this.save();
  }

  /** Called once the order's outcome is known — filled, rejected, or proven absent. */
  clearPendingMakerEntry(clientOrderId: string): void {
    const list = this.state.pendingMakerEntries;
    if (!list || list.length === 0) return;
    this.state.pendingMakerEntries = list.filter((e) => e.clientOrderId !== clientOrderId);
    this.save();
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
  /**
   * Optional account-level route claim for a whole formation pass. Unlike the
   * per-symbol claim below, this lets a three-symbol directional basket reserve
   * the cross-sectional route before its first order is persisted.
   */
  tryClaimEntryScope?: () => { allowed: boolean; reason?: string | null };
  /** Releases the matching optional route claim after the formation pass. */
  releaseEntryScope?: () => void;
  /** 2026-07-12: optional human-readable reason surfaced in getStatus() when a NON-obvious gate
   *  (e.g. the regime×direction edge-memory veto) is the thing holding this lane back — isAllowed()
   *  is a bare boolean, so a false with no reason is indistinguishable from disarmed/unallocated.
   *  Report-only: null when nothing special is blocking. */
  isAllowedReason?: () => string | null;
  /** Operator lane allocation weight. 100 = normal size; 0 = blocked. */
  laneWeightPct?: () => number;
  /** CORTEX real-USDT attribution (2026-07-21, report-only): the operator's untouched static
   *  table weight for this lane (rawLaneAllocationWeightPctForLane — NEVER consults CORTEX's
   *  promoted override, unlike laneWeightPct above which app.ts wires to
   *  laneSelectionWeightPctForLane). Omit and the raw side simply mirrors laneWeightPct, making
   *  every tiltShare 0 — an unwired instance can never fabricate CORTEX influence. */
  rawLaneWeightPct?: () => number;
  /** CORTEX real-USDT attribution sink (see cortex-real-attribution.ts). Optional and report-only:
   *  every use is wrapped so a failure can NEVER affect this executor's trading or settlement. */
  cortexRealAttribution?: CortexRealAttributionStore;
  /** Dense per-tick R-path recorder (2026-07-22, report-only — see position-path-recorder.ts).
   *  Same optional posture as cortexRealAttribution: omit and this executor is byte-for-byte
   *  unchanged. When present, monitorOpenPositions appends one (tsMs, currentR) sample per OPEN
   *  position per tick and both close finalizations mark the path closed — every use is wrapped
   *  so a failure can NEVER affect trading or settlement. */
  positionPathRecorder?: PositionPathRecorder;
  /** Per-fill execution recorder (2026-07-26, report-only — see execution-fill-recorder.ts).
   *  Same optional posture as cortexRealAttribution/positionPathRecorder: omit and this executor is
   *  byte-for-byte unchanged. When present, both close finalizations persist the exchange fill rows
   *  sumOwnRealizedTrades ALREADY fetched (price/qty/commission/time per fill — today only their
   *  summed realizedPnl and commission survive). No extra exchange call, no extra await on the
   *  order path; every use is wrapped so a failure can NEVER affect trading or settlement. */
  executionFillRecorder?: ExecutionFillRecorder;
  /** Durable causal binding from a Four-Brain ENTER_NOW decision to this exact exchange fill. */
  fourBrainActualFillBindings?: FourBrainActualFillBindingStore;
  /** Narrow pilot gate; outside the testnet focus it is absent and changes nothing. */
  fourBrainEntryGate?: (candidate: FourBrainBridgeCandidate) => FourBrainBridgeDecision;
  /** Base position notional in USD, BEFORE allocation-weight scaling. */
  legUsd: () => number;
  leverage: () => number;
  /** Post-only entry for THIS lane only. Default off; 18 executors share this class and only the
   *  two directional ones were analysed for it. Measured on this account: maker 2.00 vs taker 4.00
   *  bps per side, so entry-only takes the round trip from 8 to 6 bps — 0.040R to 0.030R at the 2%
   *  stop floor.
   *
   *  ENTRY ONLY, deliberately. If a resting ENTRY never fills you simply hold no position; if a
   *  resting EXIT never fills you still hold the position and it keeps losing — and exits fire
   *  precisely when price is moving, which is when a passive order is least likely to fill. The
   *  stop is a real STOP_MARKET and cannot be passive at all. */
  /** Freeze the exit geometry onto each position at open, so a report can show the levels that
   *  actually applied instead of substituting whatever is configured when the page is rendered. */
  exitGeometrySnapshot?: () => { armR: number; givebackFrac: number; profitLockR: number | null; staticTpR: number | null };
  makerEntry?: () => boolean;
  /** How long a post-only entry may rest before it is cancelled and crossed. */
  makerEntryWaitMs?: () => number;
  maxOpenPositions?: () => number;
  /**
   * Optional exact formation size. `0` (the default) preserves the normal
   * independent-single-symbol behavior. A positive value makes this executor
   * an all-or-flat formation: it will only start with exactly that many fresh,
   * distinct signals and will immediately unwind every position opened by the
   * attempt if any selected leg cannot be established.
   *
   * This cannot make exchange market orders literally simultaneous. It does
   * make a partial sequence transient and actively risk-reducing rather than
   * leaving a durable one- or two-leg directional bet after a later failure.
   * Exact formations deliberately reject maker entry: a resting order can
   * outlive a process restart and turn a partially formed basket into a live
   * exposure after this method has returned.
   */
  requiredOpenPositions?: () => number;
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
  /** 2026-07-19 real-money audit fix (confirmed finding): symbols ALREADY open in this signal's
   *  correlation cluster + direction — see correlation-clusters.ts's clusterOf() (the SAME grouping
   *  live-execution-engine.ts's own per-cluster cap already uses; this does not invent a new
   *  correlation model) — across the legacy CG_*-variant-matrix mirror AND every OTHER lane
   *  instance (this instance's OWN open positions in the same cluster are added separately inside
   *  maybeOpenPosition, same convention as existingNotionalForSymbol above). Before this, the
   *  mirror's per-cluster cap (built after a real prior loss incident: a SUI/ADA/AVAX cluster
   *  dumping together simultaneously) had ZERO reach into any of the 9 independently-admitted
   *  SingleSymbolLaneExecutor instances — SHORT_FADE_EXHAUSTION_CROWDED (a LINK/SEI/BNB/SOL-style
   *  correlated-alt universe) and INTRADAY_MOMENTUM_BREAKOUT_LONG (the entire scanner universe,
   *  which can include a correlated cluster) sit at 0% allocation weight today specifically because
   *  turning either on had no code-level safeguard against this exact risk. Defaults to
   *  () => new Set() (no visibility / not wired) — same opt-in posture as existingNotionalForSymbol.
   *  See live-executor-wiring.ts's computeClusterOpenSymbols. */
  existingClusterOpenSymbols?: (symbol: string, direction: "LONG" | "SHORT") => ReadonlySet<string>;
  /** 0 (default) = no cap. Same skip-not-blacklist TRANSIENT-retry convention as
   *  maxNotionalPerSymbolAcrossLanes: another lane's position in this cluster may close by the next
   *  tick, so a blocked signal gets another chance next tick rather than being permanently
   *  attempted. MAJORS (BTC/ETH) are exempt, matching live-execution-engine.ts's own cap. */
  maxClusterPositionsAcrossLanes?: () => number;
  /** Public-market reference used to reject a signal after price already chased its edge. */
  currentPrice?: (symbol: string) => Promise<number | null>;
  /** RECORDING-ONLY (2026-07-27). SYNCHRONOUS, zero-I/O read of the most recent public quote this
   *  process has already observed for `symbol` — a plain in-memory lookup, NOT a fetch. Exists
   *  purely so the two-sided quote that currentPrice() above already paid for (and then threw away,
   *  keeping only the mid) can be persisted onto the position as SubmitReferenceQuote.
   *
   *  Contract this executor relies on, and the reasons it is an OPTIONAL INJECTION rather than an
   *  import of some shared cache:
   *   - It MUST NOT perform I/O, await, or throw a rejection. It is called on the entry path.
   *     (It is still wrapped in try/catch here — a throw is contained, never propagated.)
   *   - Omit it and this executor is byte-for-byte unchanged except that SubmitReferenceQuote
   *     degrades to source:"MID_ONLY" (mid still captured from currentPrice's own return value).
   *   - A returned quote is ACCEPTED only when its atMs is at or after the instant this executor
   *     started its own currentPrice() await, so a stale entry left behind by an earlier tick can
   *     never be mis-attributed to this submission. A SIBLING executor's concurrent quote for the
   *     same symbol passing that test is fine — it is equally fresh or fresher — which is why the
   *     record must be read as "best quote available for this symbol at this instant", not "the
   *     exact quote this executor fetched".
   *   - VENUE WARNING: app.ts wires this from BinanceClient.getBookTicker(), which is Binance
   *     SPOT (/api/v3/ticker/bookTicker), not the USD-M perp book these orders execute against.
   *     That is why `venue` is carried through verbatim rather than assumed. */
  readPublicQuote?: (symbol: string) => PublicQuoteSnapshot | null;
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
  /**
   * Narrow exception to one-way netting: a directional lane may add only to a
   * same-direction live basket leg after the owner verifies it is net-positive
   * after estimated close cost. Omit to retain the normal hard block.
   */
  allowSameDirectionExistingPosition?: (
    symbol: string,
    direction: "LONG" | "SHORT",
  ) => Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Caps this executor itself at one open record per symbol. This is deliberately
   * separate from the cross-lane one-way-netting allowance: a directional lane may
   * add beside an eligible basket leg, but it must never pyramid a second/third
   * copy of its own symbol merely because a new scanner observation arrived.
   */
  preventSameSymbolPyramiding?: boolean;
  /**
   * Binance one-way accounts report realizedPnl against the account's netted
   * position, not a strategy lot. Opt in only where a lane shares symbols with a
   * basket and must report/train on its own entry-to-exit P&L instead.
   */
  useOwnLotPnlAttribution?: boolean;
  /** Atomic account-wide claim for an in-flight entry. Prevents sibling executors from sending
   * opposing orders against the same netted Binance symbol after observing stale cached state. */
  tryClaimEntrySymbol?: (symbol: string) => boolean;
  /** Releases an entry-symbol claim after every success, rejection, or failure path. */
  releaseEntrySymbol?: (symbol: string) => void;
  /** Shared account-exposure coordinator (account-exposure-coordinator.ts). Reserves risk capacity
   *  BEFORE an entry order is placed, synchronous and back-to-back with tryClaimEntrySymbol above
   *  (no `await` between them) — closes the gap where sizing/admission had no shared, cross-instance
   *  view of gross/directional/per-symbol/cluster/concurrent-position exposure (existingNotionalFor-
   *  Symbol/existingClusterOpenSymbols above are consulted only as allow-or-skip admission gates,
   *  never inside sizing). Defaults to an always-succeeds no-op ({ok:true, reservationId:null}) so
   *  every existing test that doesn't wire this stays byte-for-byte unaffected — same optional-
   *  closure-with-safe-default convention as every other injected accessor above. */
  reserveExposure?: (req: ExposureReserveRequest) => ExposureReserveResult;
  /** Commits a reservation from the ACTUAL fill (never the requested qty) once one lands. Optional,
   *  defaults to a no-op — see reserveExposure above. */
  commitExposureReservation?: (reservationId: string, filled: { qty: number; avgPrice: number }) => void;
  /** Releases unused capacity on rejection, timeout, cancellation, or failure. Optional, defaults to
   *  a no-op — see reserveExposure above. */
  releaseExposureReservation?: (reservationId: string, reason: string) => void;
  /** Innovation-campaign cap context (account-exposure-coordinator.ts's ExposureReserveCampaignCap),
   *  folded onto every reserveExposureFn() call below — see that type's own doc comment. Optional,
   *  defaults to () => undefined so every mainnet construction site (and every existing test) is
   *  byte-for-byte unaffected; only app.ts's innovation construction block ever wires this, via
   *  innovation-campaign.ts's campaignCapForLane(). */
  campaignCap?: () => ExposureReserveCampaignCap | undefined;
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
  /** Finalized-close detail hook. Runs only after exchange settlement and persistence. */
  onPositionClosedDetail?: (event: { symbol: string; direction: "LONG" | "SHORT"; reason: string; netUsd: number }) => void;
}

/** Store never capped closed/aborted positions, growing forever. Keeps every OPEN position
 *  unconditionally and caps settled (CLOSED/ABORTED) ones to the newest N by openedAt. */
const MAX_STORED_POSITIONS = () =>
  Math.max(1, Math.floor(Number(process.env.SINGLE_SYMBOL_EXEC_MAX_STORED_POSITIONS) || 2000));
const TAKER_FEE_RATE = 0.0005; // 5 bps per side, conservative
/** getUserTrades' startTime is compared against BINANCE's clock, not ours. This client tolerates
 *  |local − server| up to MAX_CLOCK_SKEW_MS (binance-futures-private.ts) before it refuses to sign a
 *  request at all, so even a stamp taken locally IMMEDIATELY before placeOrder can legitimately land
 *  after the exchange-stamped entry fill. Subtract comfortably more than that tolerance so the entry
 *  trade can never fall outside the window on a drifted box (a pre-submit stamp alone would fix the
 *  bug here and fail intermittently in production).
 *  Widening is safe: /fapi/v1/userTrades is ACCOUNT-scoped, not market-wide, and this account does
 *  single-digit trades per symbol per day — 10s of extra window cannot push our own rows off the
 *  limit:1000 page, and matching is by exact orderId regardless, so no other position's trades can
 *  ever be summed in. */
const FEE_WINDOW_SLACK_MS = 10_000;
/** The `limit` this executor asks /fapi/v1/userTrades for, and therefore the row count at which the
 *  page is SATURATED — Binance returns at most `limit` rows forward from `startTime`, so a full page
 *  means "there may be more rows we never saw". Kept as a named constant precisely so the request
 *  and the saturation test can never drift apart: if they do, ExecutionFillRecord.fetchComplete
 *  silently starts claiming completeness it cannot know (2026-07-27 review finding). */
const USER_TRADES_PAGE_LIMIT = 1000;
/** Default OFF, and deliberately so — but read what OFF means, because it is NOT "never fold".
 *
 *  Widening the query window (entryTradeWindowFromMs) makes the entry commission VISIBLE. That is
 *  pure recording and always happens: entryCommissionUsd / entryRealizedPnlUsd are populated on
 *  every close regardless of this flag. Folding that commission into feeEstimateUsd / grossPnlUsd /
 *  netPnlUsd is NOT recording-only: netPnlUsd feeds dailyRealizedUsd() -> the dailyMaxLossUsd gate
 *  that blocks NEW ENTRIES, and notifyPositionClosed() -> the account-wide consecutive-loss
 *  kill-switch counter (recordExternalConsecutiveLossOutcome, whose scratch/loss classification
 *  turns on |net| < scratchEpsilonUsd, default $0.10 — the same order of magnitude as one entry
 *  commission at this account's $50-150 notional). A truer, larger fee therefore blocks admission
 *  and trips a kill marginally SOONER. That is almost certainly the correct end state, but it is an
 *  execution-decision change on a real-money path and must be the operator's explicit call, made
 *  once the recorded-but-unfolded numbers show exactly how large the shift is.
 *
 *  So OFF does not mean "drop the entry leg" — dropping it would LOOSEN both gates relative to
 *  shipped behaviour, which is the wrong direction and just as much of a change. OFF means
 *  "fold exactly the entry rows the OLD window would have returned", i.e. those whose exchange
 *  timestamp is at or after openedAt (see sumOwnRealizedTrades' entryVisibleToLegacyWindow). On the
 *  live box that set is empty — which is the bug — so OFF reproduces today's totals bit for bit,
 *  while a drifted clock that DID make the entry row visible keeps folding it exactly as before.
 *  ON folds every entry row the widened window finds, i.e. the true two-sided cost.
 *  Enable per instance with SINGLE_SYMBOL_EXEC_FOLD_ENTRY_FEE=1. */
const FOLD_ENTRY_LEG_INTO_PNL = (): boolean => process.env.SINGLE_SYMBOL_EXEC_FOLD_ENTRY_FEE === "1";

interface OwnLotPnl {
  grossPnlUsd: number;
  feeUsd: number;
  netPnlUsd: number;
  complete: boolean;
}

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
  private readonly tryClaimEntryScope: () => { allowed: boolean; reason?: string | null };
  private readonly releaseEntryScope: () => void;
  private readonly isAllowedReasonFn: () => string | null;
  private readonly laneWeightPctFn: () => number;
  private readonly rawLaneWeightPctFn: (() => number) | null;
  private readonly cortexRealAttribution: CortexRealAttributionStore | null;
  private readonly positionPathRecorder: PositionPathRecorder | null;
  private readonly executionFillRecorder: ExecutionFillRecorder | null;
  private readonly fourBrainActualFillBindings: FourBrainActualFillBindingStore | null;
  private readonly fourBrainEntryGate: ((candidate: FourBrainBridgeCandidate) => FourBrainBridgeDecision) | null;
  private readonly exitGeometrySnapshotFn: (() => { armR: number; givebackFrac: number; profitLockR: number | null; staticTpR: number | null }) | null;
  private readonly makerEntryFn: () => boolean;
  private readonly makerEntryWaitMsFn: () => number;
  private readonly legUsdFn: () => number;
  private readonly leverageFn: () => number;
  private readonly maxOpenPositionsFn: () => number;
  private readonly requiredOpenPositionsFn: () => number;
  private readonly maxSignalAgeMsFn: () => number;
  private readonly dailyMaxLossUsdFn: () => number;
  private readonly nowIso: () => string;
  private readonly fillConfirmRetryDelayMs: number;
  private readonly existingNotionalForSymbolFn: (symbol: string) => number;
  private readonly maxNotionalPerSymbolAcrossLanesFn: () => number;
  private readonly existingClusterOpenSymbolsFn: (symbol: string, direction: "LONG" | "SHORT") => ReadonlySet<string>;
  private readonly maxClusterPositionsAcrossLanesFn: () => number;
  private readonly currentPriceFn: ((symbol: string) => Promise<number | null>) | null;
  private readonly readPublicQuoteFn: ((symbol: string) => PublicQuoteSnapshot | null) | null;
  private readonly maxEntryChaseStopFractionFn: () => number;
  private readonly sharedGetPositions: () => ReturnType<SingleSymbolExecClient["getPositions"]>;
  private readonly allowSameDirectionExistingPosition: ((
    symbol: string,
    direction: "LONG" | "SHORT",
  ) => Promise<{ allowed: boolean; reason?: string }>) | null;
  private readonly preventSameSymbolPyramiding: boolean;
  private readonly useOwnLotPnlAttribution: boolean;
  private readonly tryClaimEntrySymbol: (symbol: string) => boolean;
  private readonly releaseEntrySymbol: (symbol: string) => void;
  private readonly reserveExposureFn: (req: ExposureReserveRequest) => ExposureReserveResult;
  private readonly commitExposureReservationFn: (reservationId: string, filled: { qty: number; avgPrice: number }) => void;
  private readonly releaseExposureReservationFn: (reservationId: string, reason: string) => void;
  private readonly campaignCapFn: () => ExposureReserveCampaignCap | undefined;
  private readonly onPositionClosed: (netUsd: number) => void;
  private readonly onPositionClosedDetail: (event: { symbol: string; direction: "LONG" | "SHORT"; reason: string; netUsd: number }) => void;
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
    this.tryClaimEntryScope = opts.tryClaimEntryScope ?? (() => ({ allowed: true, reason: null }));
    this.releaseEntryScope = opts.releaseEntryScope ?? (() => {});
    this.isAllowedReasonFn = opts.isAllowedReason ?? (() => null);
    this.laneWeightPctFn = opts.laneWeightPct ?? (() => 100);
    this.rawLaneWeightPctFn = opts.rawLaneWeightPct ?? null;
    this.cortexRealAttribution = opts.cortexRealAttribution ?? null;
    this.positionPathRecorder = opts.positionPathRecorder ?? null;
    this.executionFillRecorder = opts.executionFillRecorder ?? null;
    this.fourBrainActualFillBindings = opts.fourBrainActualFillBindings ?? null;
    this.fourBrainEntryGate = opts.fourBrainEntryGate ?? null;
    this.exitGeometrySnapshotFn = opts.exitGeometrySnapshot ?? null;
    this.makerEntryFn = opts.makerEntry ?? (() => false);
    this.makerEntryWaitMsFn = opts.makerEntryWaitMs ?? (() => 120_000);
    this.legUsdFn = opts.legUsd;
    this.leverageFn = opts.leverage;
    this.maxOpenPositionsFn = opts.maxOpenPositions ?? (() => 1);
    this.requiredOpenPositionsFn = opts.requiredOpenPositions ?? (() => 0);
    this.maxSignalAgeMsFn = opts.maxSignalAgeMs ?? (() => 50 * 60_000);
    this.dailyMaxLossUsdFn = opts.dailyMaxLossUsd ?? (() => 0);
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.fillConfirmRetryDelayMs = opts.fillConfirmRetryDelayMs ?? 400;
    this.existingNotionalForSymbolFn = opts.existingNotionalForSymbol ?? (() => 0);
    this.maxNotionalPerSymbolAcrossLanesFn = opts.maxNotionalPerSymbolAcrossLanes ?? (() => 0);
    this.existingClusterOpenSymbolsFn = opts.existingClusterOpenSymbols ?? (() => new Set<string>());
    this.maxClusterPositionsAcrossLanesFn = opts.maxClusterPositionsAcrossLanes ?? (() => 0);
    this.currentPriceFn = opts.currentPrice ?? null;
    this.readPublicQuoteFn = opts.readPublicQuote ?? null;
    this.maxEntryChaseStopFractionFn = opts.maxEntryChaseStopFraction ?? (() => {
      const n = Number.parseFloat(process.env.LIVE_MAX_ENTRY_CHASE_STOP_FRACTION ?? "");
      return Number.isFinite(n) && n >= 0 ? n : 0.2;
    });
    this.sharedGetPositions = opts.sharedGetPositions ?? (() => this.client.getPositions());
    this.allowSameDirectionExistingPosition = opts.allowSameDirectionExistingPosition ?? null;
    this.preventSameSymbolPyramiding = opts.preventSameSymbolPyramiding === true;
    this.useOwnLotPnlAttribution = opts.useOwnLotPnlAttribution === true;
    this.tryClaimEntrySymbol = opts.tryClaimEntrySymbol ?? (() => true);
    this.releaseEntrySymbol = opts.releaseEntrySymbol ?? (() => {});
    this.reserveExposureFn = opts.reserveExposure ?? (() => ({ ok: true, reservationId: null }));
    this.commitExposureReservationFn = opts.commitExposureReservation ?? (() => {});
    this.releaseExposureReservationFn = opts.releaseExposureReservation ?? (() => {});
    this.campaignCapFn = opts.campaignCap ?? (() => undefined);
    this.onPositionClosed = opts.onPositionClosed ?? (() => {});
    this.onPositionClosedDetail = opts.onPositionClosedDetail ?? (() => {});
  }

  /** Best-effort fan-out of a finalized close to onPositionClosed — never let a throwing callback
   *  interrupt this executor's own settlement bookkeeping (same fail-open posture as
   *  live-execution-engine.ts's onKillSwitchEngaged callback). */
  private notifyPositionClosed(pos: SingleSymbolPosition, reason: string, netUsd: number): void {
    try {
      this.onPositionClosed(netUsd);
    } catch {
      // best-effort — the position is already fully settled and persisted regardless
    }
    try {
      this.onPositionClosedDetail({ symbol: pos.symbol, direction: pos.direction, reason, netUsd });
    } catch {
      // best-effort — the position is already fully settled and persisted regardless
    }
  }

  /** Epoch ms off the SAME injected clock every other timestamp in this file uses, so a test that
   *  freezes or drives nowIso drives this too. Falls back to Date.now() only if a caller supplied a
   *  clock that produces an unparseable string — never NaN. */
  private nowMs(): number {
    const ms = new Date(this.nowIso()).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }

  /** RECORDING-ONLY. Assemble the pre-submit reference from data ALREADY in hand: the mid
   *  currentPrice() just returned, plus (when injected) the two-sided quote the very same fetch
   *  produced. Zero I/O, zero awaits, and fully contained — any throw yields null and the entry
   *  proceeds exactly as it would have without this feature.
   *
   *  `observeStartMs` is the clock reading taken immediately BEFORE the currentPrice() await. A
   *  cached quote is accepted only if it was observed at or after that instant, which is what stops
   *  a leftover entry from an earlier tick (or from an unrelated symbol-sharing code path) being
   *  passed off as this submission's benchmark. When no such quote exists we still record the mid,
   *  labelled MID_ONLY, and date it at observeStartMs — i.e. the age is deliberately OVER-stated
   *  rather than flattered. */
  private captureSubmitRefBase(
    symbol: string,
    mid: number | null,
    observeStartMs: number,
  ): Omit<SubmitReferenceQuote, "ageAtSubmitMs"> | null {
    try {
      if (!(typeof mid === "number" && Number.isFinite(mid) && mid > 0)) return null;
      const raw = this.readPublicQuoteFn ? this.readPublicQuoteFn(symbol) : null;
      const fresh =
        raw
        && Number.isFinite(raw.atMs)
        && raw.atMs >= observeStartMs
        && typeof raw.mid === "number"
        && Number.isFinite(raw.mid)
        && raw.mid > 0
          ? raw
          : null;
      if (fresh) {
        const bid = typeof fresh.bid === "number" && Number.isFinite(fresh.bid) && fresh.bid > 0 ? fresh.bid : null;
        const ask = typeof fresh.ask === "number" && Number.isFinite(fresh.ask) && fresh.ask > 0 ? fresh.ask : null;
        const venue = typeof fresh.venue === "string" && fresh.venue.length > 0 ? fresh.venue : "UNKNOWN";
        return {
          mid: fresh.mid,
          bid,
          ask,
          atMs: fresh.atMs,
          venue,
          // Only a genuinely TWO-SIDED quote earns BOOK_TICKER: a one-sided book gives no touch
          // price for one of the two directions, so calling it a book quote would overstate what
          // the record can answer.
          source: bid !== null && ask !== null ? "BOOK_TICKER" : "MID_ONLY",
          venueMatchesExecution: EXECUTION_VENUE_LABELS.has(venue),
          // The cache is shared process-wide across every lane executor, so the quote read back
          // here is not guaranteed to be the one THIS gate evaluated — see midDiffersFromGateMid.
          ...(fresh.mid !== mid ? { midDiffersFromGateMid: true as const } : {}),
        };
      }
      // No usable cached quote: the mid the gate itself evaluated is by construction the gate's own,
      // but we have no venue label for it, and an unlabelled book must not claim to be the
      // execution book.
      return {
        mid,
        bid: null,
        ask: null,
        atMs: observeStartMs,
        venue: "UNKNOWN",
        source: "MID_ONLY",
        venueMatchesExecution: false,
      };
    } catch {
      // Recording must never be able to block or alter an entry.
      return null;
    }
  }

  /** RECORDING-ONLY. Freeze how stale the reference is at the exact instant the real order goes
   *  out. This is ONE clock read — no await, no network, nothing between it and placeOrder. */
  private stampSubmitRef(base: Omit<SubmitReferenceQuote, "ageAtSubmitMs"> | null): SubmitReferenceQuote | null {
    try {
      if (!base) return null;
      // base.atMs comes from the PRODUCER's clock (app.ts's Date.now()); this.nowMs() is this
      // executor's injected clock. They are the same wall clock in production, but an NTP step
      // backwards — or an injected offset clock — makes the raw delta negative. Floor it at 0 as
      // before, and MARK it: 0 is the most trustworthy-looking value the field can hold, so an
      // unmarked floored anomaly would be preferentially retained by any report that filters on
      // low age. See SubmitReferenceQuote.clockAnomaly.
      const rawAgeMs = this.nowMs() - base.atMs;
      return {
        ...base,
        ageAtSubmitMs: Math.max(0, rawAgeMs),
        ...(rawAgeMs < 0 ? { clockAnomaly: true as const } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Fill ONE entry post-only, then cross the spread for whatever did not fill.
   *
   * Returns the same three fields the MARKET path returns, with avgPrice already notional-blended,
   * so every consumer downstream is untouched by how the entry was filled.
   *
   * THE DIFFERENCE FROM THE BASKET PATH, and why this is not a copy of it: here a partial fill means
   * a LIVE, UNSTOPPED position. The caller places the STOP_MARKET only after this returns, so every
   * second spent waiting out the rest of a partially-filled order is a second of naked exposure. The
   * poll therefore BREAKS THE MOMENT ANY QUANTITY FILLS instead of serving out the timeout, which
   * bounds the unprotected window to roughly one poll rather than the full wait. A basket leg can
   * afford to wait for its remainder; a stopless position cannot.
   *
   * Any throw propagates to the caller's existing catch, which un-attempts the signal and retries
   * next tick. This function deliberately owns no recovery of its own.
   */
  /** Keyed by entry clientOrderId. Registered the instant a post-only order is sent and removed the
   *  instant this method returns — see pendingMakerEntryQtyBySymbol() for why reconcile needs it.
   *  TODO(persistence): still in-memory only. A crash while an order rests loses the orderId, and
   *  recovery has no record to query — the resulting fill becomes an unprotected naked position.
   *  cross-sectional-executor.ts solves this by persisting makerRestingOrderId on the basket plan. */
  private readonly inflightMakerEntries = new Map<string, { symbol: string; direction: "LONG" | "SHORT"; qty: number }>();

  /**
   * Registers the in-flight entry for the whole time an order of ours is out, then always clears it.
   *
   * The claim goes up BEFORE the first await, not after: `placeOrder` can time out on the RESPONSE
   * while the order itself reached the exchange, and that is precisely the case where a position
   * appears that nothing claims. Registering after the await would leave that hole open.
   *
   * Covers the MARKET path too — the claim is "this lane has an order out for qty on symbol", which
   * is equally true there, just for a much shorter time.
   */
  private async placeEntryMakerFirst(
    symbol: string,
    side: "BUY" | "SELL",
    qty: number,
    clientOrderId: string,
    refBid: number | null,
    refAsk: number | null,
  ): Promise<{ orderId: string; avgPrice: number; executedQty: number; liquidity: { makerQty: number; takerQty: number; reason: string } }> {
    this.inflightMakerEntries.set(clientOrderId, { symbol, direction: side === "BUY" ? "LONG" : "SHORT", qty });
    try {
      return await this.placeEntryMakerFirstInner(symbol, side, qty, clientOrderId, refBid, refAsk);
    } finally {
      this.inflightMakerEntries.delete(clientOrderId);
    }
  }

  private async placeEntryMakerFirstInner(
    symbol: string,
    side: "BUY" | "SELL",
    qty: number,
    clientOrderId: string,
    refBid: number | null,
    refAsk: number | null,
  ): Promise<{ orderId: string; avgPrice: number; executedQty: number; liquidity: { makerQty: number; takerQty: number; reason: string } }> {
    const dir = side === "BUY" ? "LONG" : "SHORT";
    const limitPrice = this.client.cancelOrder ? makerLimitPrice(dir, refBid, refAsk) : null;
    if (limitPrice === null) {
      const o = await this.client.placeOrder({ symbol, side, type: "MARKET", quantity: qty, newClientOrderId: clientOrderId });
      return {
        orderId: o.orderId, avgPrice: o.avgPrice, executedQty: o.executedQty,
        liquidity: { makerQty: 0, takerQty: qty, reason: this.client.cancelOrder ? "no usable submit-time quote" : "client cannot cancel — maker unsafe" },
      };
    }

    const maker = await this.client.placeOrder({
      symbol, side, type: "LIMIT", timeInForce: "GTX", price: limitPrice, quantity: qty, newClientOrderId: clientOrderId,
    });
    const waitMs = this.makerEntryWaitMsFn();
    const deadline = this.nowMs() + waitMs;
    // Bounded by poll count as well as by the clock: nowMs() is injectable, and a frozen test clock
    // would otherwise spin here forever.
    const maxPolls = Math.max(1, Math.ceil(waitMs / 1_000));
    let latest = maker;
    for (let poll = 0; poll < maxPolls; poll++) {
      if (isTerminalMakerOrderStatus(latest.status)) break;
      if (Number.isFinite(latest.executedQty) && latest.executedQty > 0) break; // live and unstopped
      if (this.nowMs() >= deadline) break;
      await new Promise((r) => setTimeout(r, 1_000));
      try { latest = await this.client.queryOrder(symbol, maker.orderId); } catch { break; }
    }

    if (!isTerminalMakerOrderStatus(latest.status)) {
      try { await this.client.cancelOrder!(symbol, maker.orderId); } catch { /* already terminal */ }
    }
    // A cancel ACK is not a final order state.  Binance can still report NEW briefly after it
    // accepts cancellation, so wait through one bounded confirmation window before deciding the
    // fallback.  If the state remains ambiguous, throw and leave the durable pending handle for
    // next-tick recovery; returning executedQty=0 here would make the caller fabricate a position.
    latest = (await confirmMakerCancel(
      latest,
      () => this.client.queryOrder(symbol, maker.orderId),
      { retryDelayMs: this.fillConfirmRetryDelayMs },
    )).order;

    const decision = resolveMakerLeg(qty, latest.status, latest.executedQty);
    if (decision.action === "UNKNOWN_REQUERY") {
      throw new Error(`${symbol}: maker entry status is inconclusive (${decision.reason}); no fallback sent`);
    }
    if (decision.action === "DONE") {
      // A terminal, confirmed maker outcome is the only non-fallback result we may book.
      return {
        orderId: maker.orderId, avgPrice: latest.avgPrice, executedQty: latest.executedQty,
        liquidity: { makerQty: decision.filledQty, takerQty: 0, reason: decision.reason },
      };
    }

    const taker = await this.client.placeOrder({
      symbol, side, type: "MARKET", quantity: decision.fallbackQty, newClientOrderId: `${clientOrderId}f`,
    });
    const makerQty = decision.filledQty;
    const takerQty = Number.isFinite(taker.executedQty) && taker.executedQty > 0 ? taker.executedQty : decision.fallbackQty;
    const makerPx = Number.isFinite(latest.avgPrice) && latest.avgPrice > 0 ? latest.avgPrice : limitPrice;
    const takerPx = Number.isFinite(taker.avgPrice) && taker.avgPrice > 0 ? taker.avgPrice : 0;
    const total = makerQty + takerQty;
    // An unconfirmed taker price (avgPrice 0 at ACK is routine) returns 0 so resolveFillPrice
    // re-queries, rather than inventing a blend from a price we do not have.
    const avgPrice = takerPx > 0 && total > 0 ? (makerQty * makerPx + takerQty * takerPx) / total : 0;
    return {
      orderId: maker.orderId, avgPrice, executedQty: total,
      liquidity: { makerQty, takerQty, reason: decision.reason },
    };
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

  /** Raw-static counterpart of allocationWeightPct (CORTEX real-USDT attribution, 2026-07-21):
   *  same clamping, but reads the operator's untouched table weight. When rawLaneWeightPct isn't
   *  wired, mirrors the applied weight so tiltShare is 0 by construction — an unwired instance
   *  must never fabricate CORTEX influence. */
  private rawAllocationWeightPct(): number {
    if (!this.rawLaneWeightPctFn) return this.allocationWeightPct();
    const pct = Number(this.rawLaneWeightPctFn());
    if (!Number.isFinite(pct)) return 100;
    return Math.max(0, Math.min(100, pct));
  }

  /**
   * Rebuild one strategy lot's economics from its own confirmed entry/exit
   * prices and commissions. Binance's trade `realizedPnl` cannot be used for
   * this when a basket and a directional lane share the same one-way symbol:
   * the exchange correctly realizes against the account-average position, but
   * that number belongs to neither strategy book on its own.
   *
   * Partial stop lifecycles are deliberately excluded until every partial leg
   * has its own durable price/fee attribution. Returning null is safer than
   * showing/training on a blended account figure.
   */
  private ownLotPnl(pos: SingleSymbolPosition): OwnLotPnl | null {
    if (pos.status !== "CLOSED") return null;
    if (
      pos.realizedPartialGrossUsd !== undefined ||
      pos.realizedPartialFeeUsd !== undefined ||
      pos.entryPriceConfirmed !== true ||
      pos.exitPriceConfirmed !== true ||
      !(typeof pos.entryPrice === "number" && Number.isFinite(pos.entryPrice) && pos.entryPrice > 0) ||
      !(typeof pos.exitPrice === "number" && Number.isFinite(pos.exitPrice) && pos.exitPrice > 0) ||
      !(typeof pos.qty === "number" && Number.isFinite(pos.qty) && pos.qty > 0)
    ) return null;

    const dir = pos.direction === "LONG" ? 1 : -1;
    const grossPnlUsd = dir * (pos.exitPrice - pos.entryPrice) * pos.qty;
    let feeUsd: number;
    let feeComplete = false;
    if (pos.feeSource === "EXCHANGE" && typeof pos.feeEstimateUsd === "number" && Number.isFinite(pos.feeEstimateUsd)) {
      if (pos.entryLegFoldedIntoPnl === true) {
        feeUsd = pos.feeEstimateUsd;
        feeComplete = true;
      } else if (
        pos.entryLegFoldedIntoPnl === false &&
        typeof pos.entryCommissionUsd === "number" &&
        Number.isFinite(pos.entryCommissionUsd)
      ) {
        feeUsd = pos.feeEstimateUsd + pos.entryCommissionUsd;
        feeComplete = true;
      } else {
        // It is unknown whether a legacy aggregate already contains the entry
        // fee. Do not add it speculatively and do not fall back to netted P&L.
        return null;
      }
    } else if (pos.feeSource === "ESTIMATE_TAKER_FLAT" && typeof pos.feeEstimateUsd === "number" && Number.isFinite(pos.feeEstimateUsd)) {
      // This is still the strategy's own price P&L, but it cannot become a
      // Four-Brain/CORTEX actual-fill outcome because at least one fee leg was
      // modelled rather than observed.
      feeUsd = pos.feeEstimateUsd;
    } else {
      return null;
    }

    return {
      grossPnlUsd,
      feeUsd,
      netPnlUsd: grossPnlUsd - feeUsd,
      complete: feeComplete && pos.actualFillSettlementComplete !== false,
    };
  }

  /** P&L used by dashboard/reporting. Never substitute an account-netted value
   * when own-lot attribution is configured but cannot be reconstructed. */
  private reportedNetPnl(pos: SingleSymbolPosition): number | null {
    if (!this.useOwnLotPnlAttribution) return pos.netPnlUsd;
    return this.ownLotPnl(pos)?.netPnlUsd ?? null;
  }

  /** P&L used by risk callbacks. Prefer the own lot when known; fall back to the
   * incumbent exchange settlement only to preserve a conservative risk signal
   * for a genuinely incomplete legacy record. */
  private riskNetPnl(pos: SingleSymbolPosition): number | null {
    return this.useOwnLotPnlAttribution ? this.ownLotPnl(pos)?.netPnlUsd ?? pos.netPnlUsd : pos.netPnlUsd;
  }

  private reportedFee(pos: SingleSymbolPosition): number | null {
    if (!this.useOwnLotPnlAttribution) return pos.feeEstimateUsd;
    return this.ownLotPnl(pos)?.feeUsd ?? null;
  }

  /** Returns an API/read-model clone. Durable store values stay untouched for
   * exchange reconciliation; the clone exposes them under exchangeAccount* so
   * a correct strategy report never erases the audit trail. */
  private reportPosition(pos: SingleSymbolPosition): SingleSymbolPosition {
    if (!this.useOwnLotPnlAttribution || pos.status !== "CLOSED") return pos;
    const own = this.ownLotPnl(pos);
    const exchange = {
      exchangeAccountGrossPnlUsd: pos.grossPnlUsd,
      exchangeAccountFeeUsd: pos.feeEstimateUsd,
      exchangeAccountNetPnlUsd: pos.netPnlUsd,
    };
    if (!own) {
      return {
        ...pos,
        ...exchange,
        grossPnlUsd: null,
        feeEstimateUsd: null,
        netPnlUsd: null,
        pnlAttribution: "INCOMPLETE",
        pnlAttributionComplete: false,
      };
    }
    return {
      ...pos,
      ...exchange,
      grossPnlUsd: own.grossPnlUsd,
      feeEstimateUsd: own.feeUsd,
      netPnlUsd: own.netPnlUsd,
      pnlAttribution: "OWN_LOT",
      pnlAttributionComplete: own.complete,
    };
  }

  /** CORTEX real-USDT attribution write for one FULLY closed position (report-only). Called from
   *  the two finalization blocks every close path funnels through — settleIfStopTriggered's
   *  full-close block (exchange-side stop fill) and closePosition's finalization (policy exit,
   *  manual close, orderly kill-switch wind-down) — right next to their notifyPositionClosed
   *  calls. A partial stop fill is deliberately NOT recorded: the final leg's netPnlUsd already
   *  folds the banked partial P&L in, so recording only at full close books the position's whole
   *  lifetime exactly once. Wrapped so a failure can NEVER affect settlement or trading. */
  private recordCortexRealAttribution(pos: SingleSymbolPosition): void {
    try {
      const store = this.cortexRealAttribution;
      if (!store) return;
      // Positions persisted before the capture fields existed carry no open-time weights — skip
      // rather than invent a tilt share after the fact.
      if (typeof pos.cortexAppliedWeightPct !== "number" || typeof pos.cortexRawStaticWeightPct !== "number") return;
      const ownLot = this.useOwnLotPnlAttribution ? this.ownLotPnl(pos) : null;
      // CORTEX must never reinforce an account-average result assigned by
      // Binance to a directional lot that shares a symbol with a basket.
      if (this.useOwnLotPnlAttribution && (!ownLot || !ownLot.complete)) return;
      const realizedPnlUsd = ownLot?.netPnlUsd ?? pos.netPnlUsd;
      if (typeof realizedPnlUsd !== "number" || !Number.isFinite(realizedPnlUsd)) return;
      store.recordClose({
        recordId: `ssle:${this.laneId}:${pos.positionId}`,
        closedAtIso: pos.closedAt ?? this.nowIso(),
        laneId: this.laneId,
        symbol: pos.symbol,
        realizedPnlUsd,
        appliedWeightPct: pos.cortexAppliedWeightPct,
        rawStaticWeightPct: pos.cortexRawStaticWeightPct,
      });
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  /** Stable dense-path key for one position — the SAME identity scheme
   *  recordCortexRealAttribution's recordId uses. */
  private positionPathKey(pos: SingleSymbolPosition): string {
    return `ssle:${this.laneId}:${pos.positionId}`;
  }

  private bindFourBrainActualFill(pos: SingleSymbolPosition): void {
    try {
      this.fourBrainActualFillBindings?.bindActualFill({
        bindingKey: this.positionPathKey(pos),
        source: "SINGLE_SYMBOL",
        laneId: this.laneId,
        symbol: pos.symbol,
        side: pos.direction,
        signalId: pos.sourceObservationId,
        openedAtMs: Date.parse(pos.openedAt),
        entryPrice: pos.entryPrice,
        entryPriceConfirmed: pos.entryPriceConfirmed,
        riskUsd: Math.abs(pos.entryPrice - pos.stopPrice) * pos.qty,
      });
    } catch {
      // Causal telemetry must never alter an exchange-protected position.
    }
  }

  /**
   * The incumbent P&L can deliberately leave the entry fee outside of its gate-facing total.
   * Four-Brain must instead use the complete exchange economics, or mark the direct outcome
   * unmeasured.  This keeps learning independent from the operator's risk-gate presentation.
   */
  private fourBrainActualNet(pos: SingleSymbolPosition): number | null {
    if (this.useOwnLotPnlAttribution) {
      const ownLot = this.ownLotPnl(pos);
      return ownLot?.complete ? ownLot.netPnlUsd : null;
    }
    if (
      pos.feeSource !== "EXCHANGE" ||
      pos.entryPriceConfirmed !== true ||
      pos.exitPriceConfirmed !== true ||
      pos.actualFillSettlementComplete === false ||
      typeof pos.netPnlUsd !== "number" ||
      !Number.isFinite(pos.netPnlUsd)
    ) return null;
    if (pos.entryLegFoldedIntoPnl === true) return pos.netPnlUsd;
    if (
      typeof pos.entryCommissionUsd !== "number" ||
      !Number.isFinite(pos.entryCommissionUsd) ||
      typeof pos.entryRealizedPnlUsd !== "number" ||
      !Number.isFinite(pos.entryRealizedPnlUsd)
    ) return null;
    return pos.netPnlUsd + pos.entryRealizedPnlUsd - pos.entryCommissionUsd;
  }

  private completeFourBrainActualFill(pos: SingleSymbolPosition, reason: string, pageSaturated: boolean): void {
    try {
      const netPnlUsd = !pageSaturated ? this.fourBrainActualNet(pos) : null;
      this.fourBrainActualFillBindings?.completeActualFill({
        bindingKey: this.positionPathKey(pos),
        closedAtMs: Date.parse(pos.closedAt ?? this.nowIso()),
        netPnlUsd,
        settlementConfirmed: netPnlUsd !== null,
        reason: netPnlUsd !== null ? reason : "EXCHANGE_SETTLEMENT_INCOMPLETE",
      });
    } catch {
      // The durable exchange position record remains authoritative.
    }
  }

  /** Dense R-path sample for one OPEN position (2026-07-22, report-only — see
   *  position-path-recorder.ts): the signed mark-R this tick, same favorableR() formula the exit
   *  policies consume. deferSave batches the whole tick's samples into monitorOpenPositions'
   *  single flush(). Wrapped so a failure can NEVER affect trading. */
  private recordPositionPathTick(pos: SingleSymbolPosition, mark: number, tsMs: number): void {
    try {
      const recorder = this.positionPathRecorder;
      if (!recorder) return;
      const currentR = favorableR(pos.direction, pos.entryPrice, pos.stopPrice, mark);
      if (!Number.isFinite(currentR) || !Number.isFinite(tsMs)) return;
      recorder.recordTick(this.positionPathKey(pos), tsMs, currentR, {
        meta: {
          laneId: this.laneId,
          symbol: pos.symbol,
          direction: pos.direction,
          signalId: pos.sourceObservationId,
          source: "executor",
        },
        deferSave: true,
      });
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  /** Seed one factual entry observation (R=0) immediately after a confirmed position is persisted.
   *  A short-lived position can otherwise close before the next monitor tick and lose the only
   *  observation that is certain at open. This is telemetry only: it neither changes entry, stop,
   *  order timing, nor any exit decision. */
  private seedPositionPathAtEntry(pos: SingleSymbolPosition): void {
    try {
      const openedMs = Date.parse(pos.openedAt);
      this.recordPositionPathTick(pos, pos.entryPrice, Number.isFinite(openedMs) ? openedMs : Date.now());
      this.positionPathRecorder?.flush();
    } catch {
      // Dense-path telemetry must never affect an already-open exchange position.
    }
  }

  /** Dense R-path close handoff (2026-07-22, report-only). Called from the SAME two finalization
   *  blocks recordCortexRealAttribution is (settleIfStopTriggered's full close + closePosition) —
   *  every close path funnels through one of them exactly once. finalR is the RAW mark-R at the
   *  recorded exit price (price-based, so a partial-fill-mutated qty cannot skew it); when the
   *  exit price is unknown the recorder falls back to the last recorded tick. Wrapped so a
   *  failure can NEVER affect settlement or trading. */
  private markPositionPathClosed(pos: SingleSymbolPosition): void {
    try {
      const recorder = this.positionPathRecorder;
      if (!recorder) return;
      const closedMs = Date.parse(pos.closedAt ?? this.nowIso());
      const finalR =
        typeof pos.exitPrice === "number" && Number.isFinite(pos.exitPrice)
          ? favorableR(pos.direction, pos.entryPrice, pos.stopPrice, pos.exitPrice)
          : undefined;
      recorder.markClosed(this.positionPathKey(pos), Number.isFinite(closedMs) ? closedMs : Date.now(), {
        finalR: Number.isFinite(finalR) ? finalR : undefined,
      });
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  private effectiveLegUsd(): number {
    return this.legUsdFn() * (this.allocationWeightPct() / 100);
  }

  private dailyRealizedUsd(nowIso: string): number {
    const day = nowIso.slice(0, 10);
    let sum = 0;
    for (const p of this.store.getState().positions) {
      const net = this.riskNetPnl(p);
      if (p.status === "CLOSED" && p.closedAt && p.closedAt.slice(0, 10) === day && net !== null) {
        sum += net;
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
    /** CLOSED records whose own-lot P&L cannot be reconstructed are deliberately
     * omitted from totalNetPnlUsd instead of borrowing Binance's netted amount. */
    unattributedClosedCount: number;
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
      totalNetPnlUsd: closed.reduce((s, p) => s + (this.reportedNetPnl(p) ?? 0), 0),
      unattributedClosedCount: closed.filter((p) => this.reportedNetPnl(p) === null).length,
      lastError: this.lastError,
      unprotectedPositions: open
        .filter((p) => p.stopAlgoOrderId === null && p.stopFailureCount > 0)
        .map((p) => ({ positionId: p.positionId, symbol: p.symbol, stopFailureCount: p.stopFailureCount, stopUnprotectedSinceIso: p.stopUnprotectedSinceIso })),
      stuckClosePositions: open
        .filter((p) => p.closeFailureCount > 0)
        .map((p) => ({ positionId: p.positionId, symbol: p.symbol, closeFailureCount: p.closeFailureCount, closeFailureSinceIso: p.closeFailureSinceIso })),
      recent: st.positions.slice(-10).map((p) => this.reportPosition(p)),
    };
  }

  /** 2026-08-05 (critical fix): non-recursive exposure surface -- laneId + OPEN positions only,
   *  read directly from the store, WITHOUT calling isAllowed() the way getStatus() does. For
   *  innovation executors, isAllowed is wired (app.ts) to innovationAllowed(laneId) ->
   *  innovationCampaignAdmissionForLane -> computeInnovationExposure(), which needs to read every
   *  sibling executor's open exposure. computeInnovationExposure used to call getStatus() for
   *  that, which recomputes isAllowed(), which calls back into computeInnovationExposure() again
   *  -- infinite mutual recursion, confirmed reproduced ("Maximum call stack size exceeded"),
   *  silently breaking LiveExecutionEngine.reconcile()/manageLifecycle()/kill-switch-retry every
   *  tick by default on testnet. Mirrors getOpenUnexitedLegs()'s identical rationale in
   *  cross-sectional-executor.ts. Use this, never getStatus(), anywhere that only needs raw open
   *  exposure and must not risk depending on isAllowed(). */
  getExposureSnapshot(): { laneId: string; openPositions: SingleSymbolPosition[]; pendingMakerEntryCount: number } {
    const state = this.store.getState();
    const open = state.positions.filter((p) => p.status === "OPEN");
    // A persisted maker entry can still fill after a process restart. It is
    // exposure-in-formation, not an empty slot another route may safely take.
    const pendingMakerEntryCount = state.pendingMakerEntries?.length ?? 0;
    return { laneId: this.laneId, openPositions: open, pendingMakerEntryCount };
  }

  /**
   * Post-only entry orders RESTING on the exchange right now, before any fill has been booked as a
   * position. Signed like a position: LONG positive, SHORT negative.
   *
   * 2026-08-17. The cross-sectional lane force-disarmed the whole account for exactly this reason —
   * a resting maker order that partially fills is REAL exchange exposure that nothing claims, so
   * reconcile() reads it as an orphan "not opened by engine" and latches the engine off. This lane
   * has the same shape, and a WIDER window: `CROSS_SECTIONAL_DIRECTIONAL_MAKER_ENTRY_WAIT_MS` is
   * 120_000, so the order can sit on the book for two minutes filling in pieces.
   *
   * In-memory on purpose, and bounded by the wait: it exists to let reconcile TOLERATE a position
   * it would otherwise call foreign, and a restart resolves that on its own (the order is gone from
   * this map, and whatever filled is a real orphan that SHOULD be flagged). What a restart does NOT
   * resolve is the order itself — see the class TODO on persisting it.
   */
  pendingMakerEntryQtyBySymbol(): Map<string, number> {
    return signedMakerEntryQtyBySymbol(this.inflightMakerEntries.values());
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
      const net = this.reportedNetPnl(p);
      if (net === null) {
        symbols.add(p.symbol);
        if (p.closedAt && (lastClosedAt === null || p.closedAt > lastClosedAt)) lastClosedAt = p.closedAt;
        continue;
      }
      realized += net;
      fees += this.reportedFee(p) ?? 0;
      if (net > 0) wins += 1;
      else losses += 1;
      symbols.add(p.symbol);
      if (p.closedAt && (lastClosedAt === null || p.closedAt > lastClosedAt)) lastClosedAt = p.closedAt;
    }
    return { closedCount: closed.length, wins, losses, realizedPnlUsd: realized, feesUsd: fees, symbols: [...symbols].sort(), lastClosedAt };
  }

  getClosedPositions(): SingleSymbolPosition[] {
    return this.store.getState().positions
      .filter((p) => p.status === "CLOSED")
      .map((p) => this.reportPosition(p));
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
      return { ok: true, reason: null, netPnlUsd: this.reportedNetPnl(pos) };
    } catch (error) {
      return { ok: false, reason: (error as Error).message, netPnlUsd: null };
    }
  }

  /** Single-flight tick: settle stop-triggered/policy-decided exits, then consider a new entry. */
  /**
   * Resolve every entry order that was sent but never booked — the crash-inside-the-maker-window
   * case. Runs FIRST, before monitorOpenPositions, so an order that filled while the process was
   * down becomes a tracked, stopped position before anything else reads the book.
   *
   * Deliberately mirrors cross-sectional-executor.ts's reconcilePlannedLeg: an ambiguous answer is
   * never treated as "no order". Only Binance saying the order does not exist (-2013), or reporting
   * it terminal with zero fill, drops the handle; anything else keeps it for the next tick.
   */
  private async reconcilePendingMakerEntries(): Promise<void> {
    const pending = this.store.getState().pendingMakerEntries ?? [];
    if (pending.length === 0 || !this.client.queryOrderByClientId) return;
    for (const entry of [...pending]) {
      let order: Awaited<ReturnType<NonNullable<SingleSymbolExecClient["queryOrderByClientId"]>>>;
      try {
        order = await this.client.queryOrderByClientId(entry.symbol, entry.clientOrderId);
      } catch (error) {
        // -2013 = order does not exist. That is PROOF it never reached the book, so the handle can
        // go. Any other error leaves it pending rather than guessing.
        if (error instanceof BinanceFuturesPrivateError && error.binanceCode === -2013) {
          this.store.clearPendingMakerEntry(entry.clientOrderId);
        }
        continue;
      }
      const executed = Number.isFinite(order.executedQty) ? order.executedQty : 0;
      const status = (order.status ?? "").trim().toUpperCase();
      if (executed > 0) {
        // It filled while nobody was watching. Adopt it as a real position and stop it THIS tick —
        // an unstopped live position is the whole reason this path exists.
        const already = this.store.getState().positions.some((p) => p.entryOrderId === order.orderId);
        if (!already) {
          const position: SingleSymbolPosition = {
            positionId: `ssle-recovered-${entry.clientOrderId}`,
            sourceObservationId: entry.sourceObservationId,
            symbol: entry.symbol,
            direction: entry.direction,
            qty: executed,
            entryPrice: order.avgPrice,
            entryOrderId: order.orderId,
            entryPriceConfirmed: Number.isFinite(order.avgPrice) && order.avgPrice > 0,
            stopPrice: entry.stopPrice,
            targetPrice: entry.targetPrice ?? null,
            maxHoldMs: entry.maxHoldMs ?? null,
            stopAlgoOrderId: null,
            stopFailureCount: 0,
            stopUnprotectedSinceIso: null,
            closeFailureCount: 0,
            closeFailureSinceIso: null,
            peakFavorableR: 0,
            openedAt: entry.placedAt,
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
          this.store.getState().positions.push(position);
          this.store.save();
          console.error(
            `[${this.laneId}] RECOVERED a filled entry nobody was tracking: ${entry.symbol} ${entry.direction} ` +
              `qty=${executed} order=${order.orderId} — placing its stop now.`,
          );
          try {
            await this.ensureStopOrder(position);
          } catch (error) {
            this.lastError = `recovered position stop failed: ${(error as Error).message}`;
          }
        }
        this.store.clearPendingMakerEntry(entry.clientOrderId);
        continue;
      }
      // Terminal with nothing filled = it is over and created no exposure.
      if (["CANCELED", "CANCELLED", "EXPIRED", "REJECTED"].includes(status)) {
        this.store.clearPendingMakerEntry(entry.clientOrderId);
      }
      // Anything else (NEW / PARTIALLY_FILLED with 0 executed / unknown) stays pending.
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.reconcilePendingMakerEntries();
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
   *  entryFeeRealized — trades are re-queried over the same window on every call, so a position that
   *  already went through a partial-fill cycle would otherwise re-add the SAME entry commission).
   *  The window starts at entryTradeWindowFromMs — stamped BEFORE the entry order went out. See
   *  that field's doc comment for the bug this fixes and why openedAt was always too late.
   *  Binance's per-request cap is 1000 for this endpoint — not a guarantee against a very active
   *  shared symbol exceeding that many trades in the window, but the widest page available.
   *  Returns null when the fetch fails (caller falls back to an estimate or retries).
   *
   *  2026-07-26 (RECORDING-ONLY): also returns `matchedFills` — the SAME rows this loop already
   *  walked, mapped verbatim (price, qty, commission, commissionAsset, realizedPnl, exchange time,
   *  orderId-as-string) for execution-fill-recorder.ts. Before this, every per-fill field except
   *  the two summed scalars was discarded here and the exit price survived only as ONE qty-weighted
   *  average, so a partial fill, a per-fill commission, or a fill-vs-quote comparison could never
   *  be reconstructed afterwards. No extra fetch: it is the same `trades` page. The entry branch's
   *  `&& !entryAlreadyBanked` guard moved from the `else if` CONDITION into the branch body purely
   *  so an already-banked entry row can still be COLLECTED for that record; there is no `else` arm,
   *  so which rows contribute to realized/fees/exitNotional/exitQty is unaffected by the move.
   *
   *  2026-07-26 (RECORDING-ONLY): entryRealized/entryFees/entryTradeSeen report the entry leg's own
   *  numbers separately, so the size of the previously-invisible understatement is measurable per
   *  position (entryCommissionUsd) WITHOUT that measurement moving anything a gate reads. They are
   *  reported IN ADDITION to — not instead of — the entry leg's contribution to realized/fees.
   *
   *  WHY THE FOLD IS PREDICATED, AND WHY THAT IS EXACTLY BEHAVIOUR-PRESERVING. Widening the window
   *  makes entry rows visible that the old query never returned. Summing them all into realized/fees
   *  would make every closed position's netPnlUsd ~one entry commission more negative, and netPnlUsd
   *  is NOT report-only: it feeds dailyRealizedUsd() -> the daily-loss gate on new entries, and
   *  notifyPositionClosed() -> the account-wide consecutive-loss kill switch. Dropping them all
   *  instead would be an equal-and-opposite change in the LOOSER direction. So an entry row is folded
   *  iff it would ALSO have been inside the old openedAt-anchored window (entryVisibleToLegacyWindow
   *  below), which reproduces the shipped totals row for row, or iff the operator has explicitly
   *  opted in via FOLD_ENTRY_LEG_INTO_PNL. `entryLegFolded` reports which happened.
   *  The ONE residual difference from the old query is page composition: /fapi/v1/userTrades returns
   *  at most `limit` rows from `startTime` forward, so on a symbol doing >1000 trades inside the
   *  window the extra 10s could in principle displace a row the old call would have returned. At
   *  this account's single-digit trades per symbol per day that cannot happen. */
  private async sumOwnRealizedTrades(
    pos: SingleSymbolPosition,
    exitOrderId: string | null,
  ): Promise<{
    realized: number;
    fees: number;
    exitNotional: number;
    exitQty: number;
    matchedFills: ExecutionFill[];
    /** ENTRY order's own rows, reported at most once per position lifetime. Zero/false when the
     *  entry rows were already banked on an earlier leg or were not in the window. */
    entryRealized: number;
    entryFees: number;
    entryTradeSeen: boolean;
    /** True when the entry leg above is ALSO included in realized/fees (see the fold rationale). */
    entryLegFolded: boolean;
    /** True when the /fapi/v1/userTrades page came back FULL (rows === the requested limit), i.e.
     *  there may be rows past the page edge we never saw. RECORDING-ONLY: it is the honest
     *  completeness signal for ExecutionFillRecord.fetchComplete and is deliberately NOT consulted
     *  by any settlement or gate decision — the fee sums behave exactly as before. */
    pageSaturated: boolean;
  } | null> {
    const entryAlreadyBanked = pos.entryFeeRealized === true;
    try {
      // THE FEE-WINDOW FIX (2026-07-26): start the window at the stamp taken BEFORE the entry order
      // went out, not at openedAt (stamped after placeOrder AND after resolveFillPrice, therefore
      // always later than Binance's own entry-fill timestamp — see entryTradeWindowFromMs). Falls
      // back to openedAt only for positions persisted before that field existed, or if a bad clock
      // ever produced a non-finite stamp: the old behaviour, never a guess.
      const stampedFromMs = pos.entryTradeWindowFromMs;
      const legacyWindowFromMs = new Date(pos.openedAt).getTime();
      const startTime =
        typeof stampedFromMs === "number" && Number.isFinite(stampedFromMs)
          ? stampedFromMs
          : legacyWindowFromMs;
      const trades = await this.client.getUserTrades(pos.symbol, { startTime, limit: USER_TRADES_PAGE_LIMIT });
      // A FULL page means Binance may have had more rows past its edge. Recording-only signal.
      const pageSaturated = Array.isArray(trades) && trades.length >= USER_TRADES_PAGE_LIMIT;
      const foldEveryEntryRow = FOLD_ENTRY_LEG_INTO_PNL();
      // When we cannot tell whether the old window would have returned a row (unparseable openedAt),
      // treat it as visible: that errs toward the LARGER, truer fee, i.e. the conservative side of
      // both gates, and it is the same answer the old code gave (it queried with that same value).
      const legacyWindowUnknowable = !Number.isFinite(legacyWindowFromMs);
      let realized = 0;
      let fees = 0;
      let exitNotional = 0;
      let exitQty = 0;
      let entryRealized = 0;
      let entryFees = 0;
      let entryTradeSeen = false;
      let entryLegFolded = false;
      const matchedFills: ExecutionFill[] = [];
      for (const t of trades) {
        if (exitOrderId !== null && t.orderId === exitOrderId) {
          exitNotional += t.price * t.qty;
          exitQty += t.qty;
          realized += t.realizedPnl;
          fees += t.commission;
          matchedFills.push(fillFromUserTrade(t, "EXIT"));
        } else if (t.orderId === pos.entryOrderId) {
          if (!entryAlreadyBanked) {
            // Always recorded — this is the measurement the window fix exists for.
            entryRealized += t.realizedPnl;
            entryFees += t.commission;
            entryTradeSeen = true;
            // Folded into the position's P&L totals only under the predicate documented above.
            // `t.time <= 0` is the real "unknowable" shape, not NaN: the client's toNum maps an
            // absent or non-numeric `time` to 0, so a NaN guard alone is DEAD and a timestamp-less
            // row would evaluate 0 >= legacyWindowFromMs → false → dropped, i.e. the SMALLER fee and
            // the LOOSER side of both gates — the opposite of what this comment block promises
            // (2026-07-27 review finding). Treat any non-positive/non-finite stamp as visible.
            const entryTimeUnknowable = !Number.isFinite(t.time) || t.time <= 0;
            const entryVisibleToLegacyWindow =
              legacyWindowUnknowable || entryTimeUnknowable || t.time >= legacyWindowFromMs;
            if (foldEveryEntryRow || entryVisibleToLegacyWindow) {
              realized += t.realizedPnl;
              fees += t.commission;
              entryLegFolded = true;
            }
          }
          matchedFills.push(fillFromUserTrade(t, "ENTRY"));
        }
      }
      return {
        realized, fees, exitNotional, exitQty, matchedFills,
        entryRealized, entryFees, entryTradeSeen, entryLegFolded, pageSaturated,
      };
    } catch {
      return null;
    }
  }

  /** RECORDING-ONLY (2026-07-26). Persist the entry leg's own exchange numbers onto the position so
   *  the fee understatement the window fix exposes is measurable per position — see
   *  entryCommissionUsd / entryRealizedPnlUsd / entryLegFoldedIntoPnl.
   *  ASSIGNED, never accumulated, and only when this call actually saw the entry rows: a settle that
   *  retries next tick, or the second leg of a partial fill (entryFeeRealized already true, so
   *  entryTradeSeen is false), must not overwrite a good value with a zero.
   *  `foldedIntoTotals` is passed by the CALLER rather than taken from `summed` because whether the
   *  entry leg reached grossPnlUsd/feeEstimateUsd depends on which arm the caller took: the flat
   *  TAKER_FEE_RATE fallback in closePosition discards `summed` entirely and models both sides
   *  itself, so the entry leg is NOT folded there no matter what this call computed.
   *  Wrapped so a failure can NEVER affect settlement or trading. */
  private recordEntryLeg(
    pos: SingleSymbolPosition,
    summed: { entryRealized: number; entryFees: number; entryTradeSeen: boolean },
    foldedIntoTotals: boolean | undefined,
  ): void {
    try {
      if (!summed.entryTradeSeen) return;
      pos.entryCommissionUsd = summed.entryFees;
      pos.entryRealizedPnlUsd = summed.entryRealized;
      pos.entryLegFoldedIntoPnl = foldedIntoTotals;
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  /** Per-fill execution record for one FULLY closed position (2026-07-26, report-only). Called from
   *  the SAME two finalization blocks recordCortexRealAttribution/markPositionPathClosed are, with
   *  the fill rows sumOwnRealizedTrades already fetched — never its own exchange call. Recording an
   *  EMPTY fill list is deliberately a no-op: "no record" is honest for a close that settled from
   *  the flat-fee estimate, whereas an empty record would read as "this close had no fills".
   *  Wrapped so a failure can NEVER affect settlement or trading. */
  private recordExecutionFills(pos: SingleSymbolPosition, fills: ExecutionFill[], fetchComplete: boolean): void {
    try {
      const recorder = this.executionFillRecorder;
      if (!recorder || !Array.isArray(fills) || fills.length === 0) return;
      const closedMs = Date.parse(pos.closedAt ?? this.nowIso());
      recorder.recordFills({
        recordId: this.positionPathKey(pos), // ssle:<laneId>:<positionId> — same identity as CORTEX attribution
        source: "ssle",
        laneId: this.laneId,
        symbol: pos.symbol,
        closedAtMs: Number.isFinite(closedMs) ? closedMs : Date.now(),
        fetchComplete,
        fills,
      });
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  /** Detect + settle a position whose protective stop has ALREADY triggered on the exchange.
   *  Authoritative: uses Binance's own trade records, never a guessed fill price. */
  private async settleIfStopTriggered(pos: SingleSymbolPosition): Promise<boolean> {
    if (pos.stopAlgoOrderId === null) return false;
    let actualOrderId: string | null = null;
    let algoStatus = "";
    try {
      const algo = await this.client.queryAlgoOrder(pos.stopAlgoOrderId);
      actualOrderId = algo.actualOrderId;
      algoStatus = algo.algoStatus;
    } catch {
      return false; // best-effort — try again next tick
    }
    // Rely on our OWN already-recorded state (not just this tick's possibly-flaky re-query) once
    // we've previously confirmed the trigger — see the exitOrderId-set-immediately step below.
    if (actualOrderId === null && pos.exitOrderId === null) {
      // 2026-07-19 real-money audit fix: actualOrderId===null used to be read UNCONDITIONALLY as
      // "stop still resting" — but stopAlgoOrderId being non-null only proves a stop WAS placed,
      // never that it is still an ACTIVE resting order right now. The exchange-side stop can be
      // cancelled or expire WITHOUT ever triggering (e.g. another part of the system calling
      // cancelAllAlgoOrders for this same symbol as part of an unrelated close/flip operation on
      // this shared netted account) — this executor previously had no way to detect that and kept
      // believing the position was protected indefinitely, when it was actually completely naked.
      // Only treat "still resting" as confirmed when algoStatus itself is ambiguous/unrecognized
      // (the same fail-safe posture as a queryAlgoOrder network failure above, which also just
      // retries next tick) — a recognized terminal-without-trigger status re-establishes
      // protection immediately instead of silently trusting the stale id.
      if (isTerminalStopWithoutTrigger(algoStatus)) {
        this.lastError =
          `stop for ${pos.symbol} (${pos.positionId}) was ${algoStatus} on the exchange WITHOUT ` +
          `triggering (position still OPEN) — re-establishing protection immediately`;
        pos.stopAlgoOrderId = null; // ensureStopOrder() only acts when this is null
        this.store.save();
        await this.ensureStopOrder(pos);
        // ensureStopOrder() itself records stopFailureCount/stopUnprotectedSinceIso (surfaced via
        // getStatus().unprotectedPositions) and this.lastError on failure — nothing further needed
        // here to make a re-establish failure operator-visible rather than silent.
      }
      return false; // stop still resting (or a fresh replacement was just placed) — no close yet
    }

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
    const { realized, fees, exitNotional, exitQty, matchedFills } = summed;
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
      if (summed.pageSaturated) pos.actualFillSettlementComplete = false;
      pos.entryFeeRealized = true;
      // RECORDING-ONLY: capture the entry leg's own numbers on the ONE call that can still see them
      // (entryFeeRealized above makes every later call skip the entry rows). `summed.entryLegFolded`
      // is honest here because this branch banks `fees` verbatim into realizedPartialFeeUsd.
      this.recordEntryLeg(pos, summed, summed.entryLegFolded);
      pos.qty = remainingQty;
      pos.exitOrderId = null;
      pos.stopAlgoOrderId = null; // triggered algo order is spent; ensureStopOrder re-arms a fresh one sized to remainingQty next tick
      this.lastError = `settle: stop for ${pos.positionId} partially filled (${exitQty} of ${exitQty + remainingQty}) — banked partial P&L, re-arming protection for the remaining ${remainingQty}`;
      this.store.save();
      // Per-fill record for THIS partial leg (2026-07-26, report-only, fail-safe). Recorded here and
      // not only at the eventual full close because this leg's exit order id is cleared on the next
      // line-of-code path (pos.exitOrderId = null above) and a fresh stop gets a NEW one — the next
      // sumOwnRealizedTrades would no longer match these rows, so they would be lost forever. The
      // recorder merges into the same recordId and dedups per fill, so this is idempotent.
      // fetchComplete is NOT unconditionally true: a saturated (full) userTrades page may have cut
      // rows off its edge, and a short fill list that claims completeness is exactly the silent
      // understatement this store exists to eliminate (2026-07-27 review finding).
      this.recordExecutionFills(pos, matchedFills, !summed.pageSaturated);
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
    // Provenance (see SingleSymbolPosition.feeSource): this path NEVER falls back to the flat
    // estimate — it returns early and retries next tick rather than settling from a model — so
    // both components here (this leg's `fees` and any earlier partial leg's realizedPartialFeeUsd,
    // itself banked from getUserTrades a few lines up) are exchange commission rows.
    pos.feeSource = "EXCHANGE";
    // RECORDING-ONLY: no-op when an earlier partial leg already banked (and recorded) the entry row.
    this.recordEntryLeg(pos, summed, summed.entryLegFolded);
    const netUsd = pos.grossPnlUsd - pos.feeEstimateUsd;
    pos.netPnlUsd = netUsd;
    this.store.save();
    this.completeFourBrainActualFill(pos, "INITIAL_STOP", summed.pageSaturated);
    // 2026-07-19 real-money audit fix: feed the account-wide consecutive-loss kill-switch counter
    // (see onPositionClosed's doc comment) — every full close, stop-triggered or policy-decided,
    // must reach it, not just the legacy mirror pipeline's own applyRealizedToLedger.
    this.notifyPositionClosed(pos, "INITIAL_STOP", this.riskNetPnl(pos) ?? netUsd);
    // CORTEX real-USDT attribution (2026-07-21, report-only, fail-safe — see its doc comment).
    this.recordCortexRealAttribution(pos);
    // Dense R-path close handoff (2026-07-22, report-only, fail-safe — see its doc comment).
    this.markPositionPathClosed(pos);
    // Per-fill execution record (2026-07-26, report-only, fail-safe — see its doc comment). The
    // rows come from the sumOwnRealizedTrades call above. A failed fetch returned early
    // (summed === null) rather than reaching here, so the only remaining incompleteness is a
    // SATURATED page — rows Binance cut off the edge of the limit:1000 window (2026-07-27 review).
    this.recordExecutionFills(pos, matchedFills, !summed.pageSaturated);
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

      // Dense R-path tick (2026-07-22, report-only — see position-path-recorder.ts). Fail-safe:
      // wrapped inside; absent recorder = no-op, zero behavior change.
      this.recordPositionPathTick(pos, mark, new Date(this.nowIso()).getTime());
      const observedR = favorableR(pos.direction, pos.entryPrice, pos.stopPrice, mark);
      if (Number.isFinite(observedR)) {
        pos.peakAdverseR = Math.max(0, Number.isFinite(pos.peakAdverseR) ? pos.peakAdverseR! : 0, -observedR);
      }

      const msHeld = new Date(this.nowIso()).getTime() - new Date(pos.openedAt).getTime();
      const exitContext = {
        symbol: pos.symbol,
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
      if (!decision.shouldExit && pos.targetPrice !== undefined && pos.targetPrice !== null) {
        const targetHit = pos.direction === "LONG" ? mark >= pos.targetPrice : mark <= pos.targetPrice;
        if (targetHit) {
          decision = {
            shouldExit: true,
            reason: "SIGNAL_TARGET",
            nextPeakFavorableR: laneDecision.nextPeakFavorableR,
          };
        }
      }
      if (!decision.shouldExit && pos.maxHoldMs !== undefined && pos.maxHoldMs !== null && msHeld >= pos.maxHoldMs) {
        decision = {
          shouldExit: true,
          reason: "SIGNAL_MAX_HOLD",
          nextPeakFavorableR: laneDecision.nextPeakFavorableR,
        };
      }
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
    // Batched persist of this tick's dense R-path samples (report-only; no-op while clean).
    try {
      this.positionPathRecorder?.flush();
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
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
      // Provenance of `fees`, recorded alongside it (see SingleSymbolPosition.feeSource). THIS
      // branch is the whole reason the flag exists: both arms write the same field name with the
      // same units, and until now the only difference between a measured commission and a modelled
      // one was which side of this `if` it came out of — information that was thrown away
      // immediately. 7 of 21 live closed positions turned out to be the estimate arm.
      let feeSource: "EXCHANGE" | "ESTIMATE_TAKER_FLAT";
      // RECORDING-ONLY: whether the entry leg actually reached gross/fees below.
      // UNDEFINED — not false — on the estimate arm, matching entryLegFoldedIntoPnl's documented
      // contract (2026-07-27 review finding). `false` there would be actively misleading, not merely
      // undocumented: that arm's fees are `notional * TAKER_FEE_RATE` with
      // notional = entryPrice*qty + exit*qty, i.e. it ALREADY models an entry-side fee, while
      // `false` advertises the totals as exit-side only. A consumer doing the obvious
      // reconstruction (`fee + (entryLegFoldedIntoPnl === false ? entryCommissionUsd : 0)`) would
      // then count the entry commission TWICE. `undefined` means "not answerable for this record",
      // which is the truth: the totals are modelled, so no exchange entry row is in them at all.
      let entryLegInTotals: boolean | undefined;
      const settled = await this.sumOwnRealizedTrades(pos, pos.exitOrderId);
      if (settled !== null && settled.exitQty > 0) {
        gross = (pos.realizedPartialGrossUsd ?? 0) + settled.realized;
        fees = (pos.realizedPartialFeeUsd ?? 0) + settled.fees;
        feeSource = "EXCHANGE";
        entryLegInTotals = settled.entryLegFolded;
      } else {
        gross = (pos.realizedPartialGrossUsd ?? 0) + dir * (exit - pos.entryPrice) * pos.qty;
        const notional = pos.entryPrice * pos.qty + exit * pos.qty;
        fees = (pos.realizedPartialFeeUsd ?? 0) + notional * TAKER_FEE_RATE;
        // ESTIMATE even when realizedPartialFeeUsd contributes a genuinely-measured component:
        // the total carries a modelled part, and a mixed number must be excluded from cost
        // analysis exactly as a fully-modelled one is. See feeSource's doc comment.
        feeSource = "ESTIMATE_TAKER_FLAT";
        this.lastError = `close ${pos.positionId}: exit trades not retrievable this tick — P&L recorded from fill-price estimate (fees estimated at ${TAKER_FEE_RATE * 1e4}bps/side)`;
      }
      pos.status = "CLOSED";
      pos.closedAt = this.nowIso();
      pos.closeReason = reason;
      pos.grossPnlUsd = gross;
      pos.feeEstimateUsd = fees;
      pos.feeSource = feeSource;
      // RECORDING-ONLY (see recordEntryLeg): no-op when the trades fetch failed outright, or when an
      // earlier partial leg already banked the entry row.
      if (settled !== null) this.recordEntryLeg(pos, settled, entryLegInTotals);
      const netUsd = gross - fees;
      pos.netPnlUsd = netUsd;
      this.store.save();
      this.completeFourBrainActualFill(pos, reason, settled?.pageSaturated ?? true);
      // 2026-07-19 real-money audit fix: see settleIfStopTriggered's identical call — this covers
      // every OTHER close path (policy exit, manual close, orderly kill-switch wind-down).
      this.notifyPositionClosed(pos, reason, this.riskNetPnl(pos) ?? netUsd);
      // CORTEX real-USDT attribution (2026-07-21, report-only, fail-safe — see its doc comment).
      this.recordCortexRealAttribution(pos);
      // Dense R-path close handoff (2026-07-22, report-only, fail-safe — see its doc comment).
      this.markPositionPathClosed(pos);
      // Per-fill execution record (2026-07-26, report-only, fail-safe — see its doc comment). Rows
      // come from the sumOwnRealizedTrades call above; when that fetch FAILED (settled === null)
      // there are no rows and nothing is recorded — the absence of a record, paired with
      // feeSource === "ESTIMATE_TAKER_FLAT", is the honest signal that this close was modelled.
      // A SUCCESSFUL fetch is still only complete if its page was not saturated (2026-07-27 review).
      this.recordExecutionFills(pos, settled?.matchedFills ?? [], settled !== null && !settled.pageSaturated);
    } finally {
      this.closingPositionIds.delete(pos.positionId);
    }
  }

  /**
   * A required-size formation may still encounter a real exchange failure after
   * one or more market orders have filled. Binance has no atomic multi-symbol
   * order, so the only safe interpretation of "exactly N" is to flatten the
   * transient legs immediately and leave the route closed if a flatten fails.
   */
  private async abortIncompleteExactFormation(
    openedThisFormation: SingleSymbolPosition[],
    requiredOpenPositions: number,
  ): Promise<void> {
    const stillOpen = openedThisFormation.filter((position) => position.status === "OPEN");
    if (stillOpen.length === 0) return;

    const failedSymbols: string[] = [];
    for (const position of stillOpen) {
      try {
        await this.closePosition(position, "INCOMPLETE_EXACT_FORMATION_ABORT");
      } catch {
        failedSymbols.push(position.symbol);
      }
    }

    if (failedSymbols.length > 0) {
      this.openHalted =
        `CRITICAL: exact ${requiredOpenPositions}-position formation reached only ${openedThisFormation.length}; ` +
        `emergency unwind failed for ${failedSymbols.join(", ")}. Remaining positions stay stopped and block every new route.`;
      this.lastEntrySkipReason = this.openHalted;
      return;
    }

    this.lastEntrySkipReason =
      `exact ${requiredOpenPositions}-position formation reached only ${openedThisFormation.length}; ` +
      "all transient legs were immediately flattened";
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
    if (candidates.length === 0) return;
    const maxOpenPositions = Math.max(0, Math.floor(this.maxOpenPositionsFn()));
    const requiredOpenPositions = Math.max(0, Math.floor(this.requiredOpenPositionsFn()));
    const alreadyOpen = st.positions.filter((p) => p.status === "OPEN").length;
    if (requiredOpenPositions > maxOpenPositions) {
      this.openHalted =
        `invalid exact-formation configuration: required ${requiredOpenPositions} positions exceeds max ${maxOpenPositions}`;
      this.lastEntrySkipReason = this.openHalted;
      return;
    }
    if (requiredOpenPositions > 0) {
      if (alreadyOpen > 0) {
        this.lastEntrySkipReason =
          `exact ${requiredOpenPositions}-position formation already has ${alreadyOpen} open position(s); no incremental entries`;
        return;
      }
      if ((st.pendingMakerEntries?.length ?? 0) > 0) {
        this.openHalted =
          `exact ${requiredOpenPositions}-position formation has pending maker entry state; refusing a new formation until reconciled`;
        this.lastEntrySkipReason = this.openHalted;
        return;
      }
      if (candidates.length !== requiredOpenPositions) {
        this.lastEntrySkipReason =
          `exact ${requiredOpenPositions}-position formation requires exactly ${requiredOpenPositions} fresh candidates; found ${candidates.length}`;
        return;
      }
      if (new Set(candidates.map((candidate) => candidate.symbol.toUpperCase())).size !== requiredOpenPositions) {
        this.lastEntrySkipReason =
          `exact ${requiredOpenPositions}-position formation requires ${requiredOpenPositions} distinct symbols`;
        return;
      }
      // A rest-on-book entry can fill after a crash/restart, when only a subset
      // of the intended symbols has ever been sent. Exact formations therefore
      // fail closed instead of accepting a future maker configuration drift.
      if (this.makerEntryFn()) {
        this.openHalted =
          `exact ${requiredOpenPositions}-position formation rejects maker entry; use immediate market entries or disable the lane`;
        this.lastEntrySkipReason = this.openHalted;
        return;
      }
    }
    if (alreadyOpen >= maxOpenPositions) {
      this.lastEntrySkipReason = `max open positions (${maxOpenPositions}) reached for this lane instance`;
      return;
    }

    // Claim once for the whole formation pass, not once per symbol: a valid
    // directional route must either establish its selected three-symbol basket
    // or leave the route free for a later, fresh decision.
    const entryScope = this.tryClaimEntryScope();
    if (!entryScope.allowed) {
      this.lastEntrySkipReason = entryScope.reason ?? "cross-sectional route is owned by another formation";
      return;
    }
    const openedThisFormation: SingleSymbolPosition[] = [];
    let exactFormationComplete = requiredOpenPositions === 0;
    try {

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
      if (st.positions.filter((p) => p.status === "OPEN").length >= maxOpenPositions) {
        this.lastEntrySkipReason = `max open positions (${maxOpenPositions}) reached for this lane instance`;
        break;
      }

      if (
        this.preventSameSymbolPyramiding &&
        st.positions.some((p) => p.status === "OPEN" && p.symbol.toUpperCase() === signal.symbol.toUpperCase())
      ) {
        this.lastEntrySkipReason =
          `${signal.symbol}: same-symbol directional position is already open; no pyramiding within this lane`;
        continue;
      }

      const existingPosition = exchangePositions.find((p) => p.symbol === signal.symbol && Math.abs(p.positionAmt) > 1e-9);
      if (existingPosition) {
        const sameDirection = this.direction === "LONG" ? existingPosition.positionAmt > 0 : existingPosition.positionAmt < 0;
        if (!sameDirection || !this.allowSameDirectionExistingPosition) {
          this.lastEntrySkipReason = `${signal.symbol}: exchange position already exists; refusing one-way-mode netting`;
          continue;
        }
        const admission = await this.allowSameDirectionExistingPosition(signal.symbol, this.direction);
        if (!admission.allowed) {
          this.lastEntrySkipReason = admission.reason ?? `${signal.symbol}: existing same-direction position is not eligible for directional add-on`;
          continue;
        }
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

      // The bridge is intentionally downstream of incumbent directional/timeline guards and
      // upstream of order placement. It only ever vetoes a new exact candidate on mature NEGATIVE
      // actual-fill evidence; positive reinforcement remains a shadow-ranking signal in this
      // rollout and cannot manufacture an entry.
      if (this.fourBrainEntryGate) {
        const bridge = this.fourBrainEntryGate({
          laneId: this.laneId,
          symbol: signal.symbol,
          side: this.direction,
          signalId: signal.observationId,
          nowMs,
          entryPrice: signal.entryPrice,
          stopPrice: signal.stopPrice,
          openedAtMs: nowMs,
        });
        if (!bridge.allowed) {
          this.lastEntrySkipReason = bridge.reason ?? `${signal.symbol}: Four-Brain pilot veto`;
          continue;
        }
      }

      // RECORDING-ONLY (2026-07-27): the pre-submit execution reference for THIS candidate. Stays
      // null unless the entry-quality gate below actually obtains a usable live price — it is never
      // back-filled from signal.entryPrice, which can be 50 minutes stale and would masquerade as a
      // real benchmark. See SubmitReferenceQuote.
      let submitRefBase: Omit<SubmitReferenceQuote, "ageAtSubmitMs"> | null = null;
      if (this.currentPriceFn) {
        // Clock read BEFORE the await, so a quote left in the cache by an earlier tick can be
        // rejected as not belonging to this submission (see captureSubmitRefBase).
        const priceObserveStartMs = this.nowMs();
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
        // Placed AFTER every gate decision above, so a rejected candidate pays literally nothing
        // for this feature. Reuses the price/quote the gate already fetched — no extra call.
        submitRefBase = this.captureSubmitRefBase(signal.symbol, currentPrice, priceObserveStartMs);
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

      // 2026-07-19 real-money audit fix (confirmed finding): correlated-cluster concentration cap,
      // extended to reach this lane instance — see existingClusterOpenSymbols's doc comment for the
      // gap this closes (live-execution-engine.ts's own per-cluster cap, built after a real prior
      // loss incident — a SUI/ADA/AVAX cluster dumping together simultaneously — previously had ZERO
      // reach into any of the 9 SingleSymbolLaneExecutor instances). Checked in the SAME spot and
      // with the SAME transient-retry convention as the notional cap immediately above: another
      // lane's position in this cluster may close by the next tick, so a blocked signal gets
      // another chance next tick rather than being permanently attempted. MAJORS (BTC/ETH) are
      // exempt, matching the mirror's own exemption.
      const clusterCap = this.maxClusterPositionsAcrossLanesFn();
      if (clusterCap > 0 && !isMajorSymbol(signal.symbol)) {
        // Mirrors the notional cap's ownSameSymbolNotional handling just above:
        // existingClusterOpenSymbolsFn only ever reports OTHER lane instances (+ the mirror) — this
        // instance's OWN already-open positions in the SAME cluster must be added explicitly.
        const ownOpenSameCluster = st.positions
          .filter((p) => p.status === "OPEN" && clusterOf(p.symbol) === clusterOf(signal.symbol))
          .map((p) => p.symbol.toUpperCase());
        const openSymbols = new Set([...this.existingClusterOpenSymbolsFn(signal.symbol, this.direction), ...ownOpenSameCluster]);
        if (!openSymbols.has(signal.symbol.toUpperCase()) && openSymbols.size >= clusterCap) {
          this.lastEntrySkipReason =
            `${signal.symbol}: correlated-cluster cap (${clusterOf(signal.symbol)}, cap ${clusterCap}) reached ` +
            `— ${openSymbols.size} symbol(s) already open`;
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
      // Hoisted from its previous call site further below (pure reorder — this formula depends only
      // on this.laneId/signal.symbol/signal.openedAtMs, all already available here). Needed now so
      // the exposure reservation below can carry the EXACT clientOrderId this entry will submit to
      // placeOrder — account-exposure-coordinator.ts's reconciliation join key.
      const positionId = `ssl-${this.laneId.slice(0, 4).toLowerCase()}-${signal.symbol.slice(0, 3).toLowerCase()}-${signal.openedAtMs.toString(36)}`;
      const entryClientOrderId = `ssle-${positionId.slice(-18)}-e`;
      // Account-exposure reservation (account-exposure-coordinator.ts). Synchronous, back-to-back
      // with tryClaimEntrySymbol above — no `await` between the two, so together they form one
      // atomic "claim symbol + reserve capacity" compound step; no concurrent reserve() call from a
      // sibling executor can ever observe the state in between. Sized from effectiveLegUsd(), the
      // SAME pre-fill notional estimate the per-symbol cap check above already uses.
      const reservation = this.reserveExposureFn({
        executorId: this.laneId,
        symbol: signal.symbol,
        direction: this.direction,
        requestedNotionalUsd: this.effectiveLegUsd(),
        clientOrderId: entryClientOrderId,
        campaignCap: this.campaignCapFn(),
      });
      if (!reservation.ok) {
        this.releaseEntrySymbol(signal.symbol);
        this.lastEntrySkipReason = reservation.reason ?? `${signal.symbol}: exposure reservation rejected`;
        continue;
      }
      const reservationId = reservation.reservationId;
      try {
        const freshPositions = await this.client.getPositions(signal.symbol);
        const freshExistingPosition = freshPositions.find((p) => p.symbol === signal.symbol && Math.abs(p.positionAmt) > 1e-9);
        if (freshExistingPosition) {
          const sameDirection = this.direction === "LONG" ? freshExistingPosition.positionAmt > 0 : freshExistingPosition.positionAmt < 0;
          const admission = sameDirection && this.allowSameDirectionExistingPosition
            ? await this.allowSameDirectionExistingPosition(signal.symbol, this.direction)
            : { allowed: false };
          if (!admission.allowed) {
            this.lastEntrySkipReason = admission.reason ?? `${signal.symbol}: fresh exchange position already exists; refusing one-way-mode netting`;
            if (reservationId) this.releaseExposureReservationFn(reservationId, "FRESH_POSITION_EXISTS");
            continue;
          }
        }

      // Mark attempted BEFORE placing orders: a failed/rejected entry must not retry forever on
      // the same signal. Bounded — this is a dedup set, not a growing audit log.
      attempted.add(signal.observationId);
      st.attemptedObservationIds = Array.from(attempted).slice(-500);
      this.store.save();

      // CORTEX real-USDT attribution capture (2026-07-21): freeze the applied + raw-static weights
      // at this exact sizing moment, and derive legUsd from the SAME applied number (identical math
      // to effectiveLegUsd()) so the captured pair is guaranteed to be what actually sized this
      // entry — never a re-read that could have moved between here and the position record below.
      const cortexAppliedWeightPct = this.allocationWeightPct();
      const cortexRawStaticWeightPct = this.rawAllocationWeightPct();
      const legUsd = this.legUsdFn() * (cortexAppliedWeightPct / 100);
      if (!(legUsd > 0)) {
        // 2026-07-19 real-money audit fix: see the notional-cap skip's identical comment above —
        // this was another silent structural rejection.
        this.lastEntrySkipReason = `${signal.symbol}: invalid leg size (legUsd=${legUsd})`;
        // No order will ever be placed for this reservation — release now rather than let it sit
        // RESERVED until the periodic staleness sweep eventually reconciles it as never-reached.
        if (reservationId) this.releaseExposureReservationFn(reservationId, "ENTRY_REJECTED:invalid_leg_size");
        continue;
      }
      if (!(signal.entryPrice > 0)) {
        this.lastEntrySkipReason = `${signal.symbol}: entry price unavailable`;
        if (reservationId) this.releaseExposureReservationFn(reservationId, "ENTRY_REJECTED:no_entry_price");
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
          if (reservationId) this.releaseExposureReservationFn(reservationId, "ENTRY_REJECTED:no_exchange_filters");
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
          if (reservationId) this.releaseExposureReservationFn(reservationId, "ENTRY_REJECTED:below_min_qty");
          continue;
        }
        const notional = qty * signal.entryPrice;
        if (!(notional >= f.minNotional)) {
          // Binance rejects an order that clears minQty but misses MIN_NOTIONAL.
          this.lastEntrySkipReason = `${signal.symbol}: notional ${notional.toFixed(2)} below exchange minNotional ${f.minNotional}`;
          if (reservationId) this.releaseExposureReservationFn(reservationId, "ENTRY_REJECTED:below_min_notional");
          continue;
        }

        // positionId (and its unique-even-when-2+-candidates-share-openedAtMs symbol fragment) is
        // computed earlier now — see the tryClaimEntrySymbol/reserveExposureFn block above; hoisted
        // there so the exposure reservation could carry this entry's exact clientOrderId.
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
        // 2026-08-18: persist the handle BEFORE the order goes out. Placed ABOVE stampSubmitRef on
        // purpose: addPendingMakerEntry does a SYNCHRONOUS store write, and the comment below is
        // explicit that nothing may sit between that stamp and placeOrder — a disk write there
        // would inflate ageAtSubmitMs and entryTradeWindowFromMs, the two numbers those stamps
        // exist to keep honest. Being merely BEFORE placeOrder is all this handle requires. A post-only entry rests on the
        // book for up to 120s; until this existed, a restart inside that window lost the only
        // reference to a REAL resting order, and a later fill became a live position with no stop
        // and no tracking. entryClientOrderId is deterministic and already computed above, so it
        // stays searchable via queryOrderByClientId even if the response never arrives.
        this.store.addPendingMakerEntry({
          clientOrderId: entryClientOrderId,
          symbol: signal.symbol,
          direction: this.direction,
          qty,
          placedAt: this.nowIso(),
          sourceObservationId: signal.observationId,
          stopPrice: signal.stopPrice,
          targetPrice: signal.targetPrice ?? null,
          maxHoldMs: signal.maxHoldMs ?? null,
        });
        // RECORDING-ONLY (2026-07-27). Freeze the reference's age at the LAST instant before the
        // real order goes out. Deliberately placed here and not in the position literal below:
        // that literal is built AFTER placeOrder AND after resolveFillPrice (which can burn
        // 4x400ms plus 4 queryOrder round-trips), so stamping there would inflate every
        // ageAtSubmitMs by the fill-confirmation latency and quietly destroy the one number that
        // tells a consumer whether the sample is usable at all.
        // Cost on the order path: ONE clock read (stampSubmitRef is Date arithmetic, wrapped in
        // its own try/catch, no await, no I/O). Nothing else sits between it and placeOrder.
        const submitRef = this.stampSubmitRef(submitRefBase);
        // THE FEE-WINDOW FIX (2026-07-26) — the lower bound sumOwnRealizedTrades will later use for
        // getUserTrades, taken HERE because openedAt (its previous lower bound, stamped in the
        // position literal below) is written AFTER placeOrder returns AND after resolveFillPrice,
        // therefore ALWAYS later than the timestamp Binance stamps on the entry fill at match time.
        // See entryTradeWindowFromMs's doc comment. Cost on the order path: ONE clock read — same
        // Date arithmetic as the line above, no await, no I/O, nothing between it and placeOrder.
        const entryTradeWindowFromMs = this.nowMs() - FEE_WINDOW_SLACK_MS;
        // Maker-first only when THIS lane opted in; otherwise the unchanged MARKET path. submitRef
        // already holds the submit-time book, so the post-only price comes from the SAME quote the
        // execution record is audited against rather than a second, later read.
        const order = this.makerEntryFn()
          ? await this.placeEntryMakerFirst(
              signal.symbol,
              this.direction === "LONG" ? "BUY" : "SELL",
              qty,
              entryClientOrderId,
              submitRef?.bid ?? null,
              submitRef?.ask ?? null,
            )
          : await this.client.placeOrder({
              symbol: signal.symbol,
              side: this.direction === "LONG" ? "BUY" : "SELL",
              type: "MARKET",
              quantity: qty,
              newClientOrderId: entryClientOrderId,
            });
        const resolvedEntry = await this.resolveFillPrice(signal.symbol, order.orderId, order.avgPrice, signal.entryPrice);
        // Commit the reservation from the ACTUAL fill — never the requested qty (order.executedQty
        // can legitimately fall short of `qty` on a genuine partial MARKET fill; falls back to the
        // requested qty only when the exchange never reports a usable executedQty, same convention
        // as cross-sectional-executor.ts's own filledQty). Idempotent no-op when reservationId is
        // null (reserveExposure not wired — the safe default).
        const filledQty = Number.isFinite(order.executedQty) && order.executedQty > 0 ? order.executedQty : qty;
        if (reservationId) this.commitExposureReservationFn(reservationId, { qty: filledQty, avgPrice: resolvedEntry.price });
        const position: SingleSymbolPosition = {
          positionId,
          sourceObservationId: signal.observationId,
          symbol: signal.symbol,
          direction: this.direction,
          // Stops and eventual reduce-only exits must use the quantity Binance
          // actually filled. Recording the requested quantity here can turn a
          // thin-book partial market fill into an oversized protective order.
          qty: filledQty,
          entryPrice: resolvedEntry.price,
          entryOrderId: order.orderId,
          entryPriceConfirmed: resolvedEntry.confirmed,
          stopPrice: signal.stopPrice,
          targetPrice: signal.targetPrice,
          maxHoldMs: signal.maxHoldMs,
          stopAlgoOrderId: null,
          stopFailureCount: 0,
          stopUnprotectedSinceIso: null,
          closeFailureCount: 0,
          closeFailureSinceIso: null,
          peakFavorableR: 0,
          peakAdverseR: 0,
          actualFillSettlementComplete: true,
          openedAt: this.nowIso(),
          entryTradeWindowFromMs,
          status: "OPEN",
          closedAt: null,
          closeReason: null,
          exitPrice: null,
          exitOrderId: null,
          exitPriceConfirmed: null,
          grossPnlUsd: null,
          feeEstimateUsd: null,
          netPnlUsd: null,
          cortexAppliedWeightPct,
          cortexRawStaticWeightPct,
          submitRef,
          ...("liquidity" in order ? { entryLiquidity: order.liquidity } : {}),
          ...(this.exitGeometrySnapshotFn ? { exitGeometryAtOpen: this.exitGeometrySnapshotFn() } : {}),
        };
        st.positions.push(position);
        this.store.save();
        if (requiredOpenPositions > 0) openedThisFormation.push(position);
        // Outcome is booked as a real position — the handle is no longer needed.
        this.store.clearPendingMakerEntry(entryClientOrderId);
        this.bindFourBrainActualFill(position);
        this.seedPositionPathAtEntry(position);
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
        // Idempotent no-op if already COMMITTED (e.g. this throw came from ensureStopOrder AFTER a
        // real fill, not from placeOrder itself — commitExposureReservationFn above already ran for
        // that case; see releaseReservation's idempotent-no-op contract).
        //
        // Only release on an UNAMBIGUOUS in-band rejection — Binance received the request and
        // explicitly answered no, so no order was created. Every OTHER failure (timeout/429/network/
        // http_error/invalid_response/clock_skew, or a non-Binance error) means we do NOT know
        // whether the order actually reached the exchange; releasing capacity here would recreate
        // the exact race this coordinator exists to close. Left RESERVED, it is picked up by the
        // periodic staleness sweep, which resolves it against Binance directly via
        // queryOrderByClientId (account-exposure-coordinator.ts's reconcileStaleReservations).
        // Mirrors cross-sectional-executor.ts's basket-abort catch — same reasoning, same guard.
        if (reservationId && error instanceof BinanceFuturesPrivateError && error.failureType === "binance_error") {
          this.releaseExposureReservationFn(reservationId, `ENTRY_FAILED:${(error as Error).message}`);
        }
        // Same split as the reservation above: only an UNAMBIGUOUS in-band rejection proves no order
        // exists, so only then is the handle safe to drop. Every ambiguous failure keeps it, and the
        // next tick's reconcilePendingMakerEntries resolves it against the exchange.
        if (error instanceof BinanceFuturesPrivateError && error.failureType === "binance_error") {
          this.store.clearPendingMakerEntry(entryClientOrderId);
        }
      }
      } finally {
        this.releaseEntrySymbol(signal.symbol);
      }
    }
    exactFormationComplete = requiredOpenPositions === 0 || openedThisFormation.length === requiredOpenPositions;
    } finally {
      if (!exactFormationComplete && openedThisFormation.length > 0) {
        await this.abortIncompleteExactFormation(openedThisFormation, requiredOpenPositions);
      }
      this.releaseEntryScope();
    }
  }
}

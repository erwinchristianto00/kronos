/**
 * Cross-sectional market-neutral EXECUTOR — turns the (measured, edgeReady) RAW
 * cross-sectional basket signal into REAL exchange positions.
 *
 * Design constraints (deliberate):
 *  - TESTNET-FIRST: enabled via CROSS_SECTIONAL_EXEC_ENABLED=1. On mainnet it
 *    additionally requires the operator's `isAllowed()` gate (the live engine's
 *    armed switch) — so the flag alone can never trade real money.
 *  - The basket is a HEDGE: k longs + k shorts at equal notional. Either the
 *    WHOLE basket opens or nothing — if any leg fails, every already-opened leg
 *    is flattened immediately (a partial basket is a naked directional bet).
 *  - One basket open at a time (v1), small fixed notional per leg, 3x leverage by default.
 *  - Exits at the signal's own horizon (default 24 bars = 24h) with MARKET
 *    reduce-only closes; P&L computed from actual fills minus a taker-fee
 *    estimate per side. Honest costs, no mark-to-model.
 *  - Consumes the SAME store the measurement lane writes (getCrossSectionalStore)
 *    so what executes is exactly what was measured — no separate signal path.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ExposureReserveCampaignCap, ExposureReserveRequest, ExposureReserveResult } from "./account-exposure-coordinator.js";
import { BinanceFuturesPrivateError, resolveConfirmedFillPrice, type BinanceFuturesPrivateClient, type FillPriceResolution, type FuturesOrder } from "./binance-futures-private.js";
import type { CortexRealAttributionStore } from "./cortex-real-attribution.js";
import { fillFromUserTrade, type ExecutionFill, type ExecutionFillRecorder, type ExecutionFillRole } from "./execution-fill-recorder.js";
import {
  CROSS_SECTIONAL_ROUNDTRIP_BPS,
  deriveAdaptiveSymbolFilters,
  regimeSkewCounterfactual,
  type RegimeSkewCounterfactual,
  type CrossSectionalObservation,
  type CrossSectionalStore,
} from "./cross-sectional-edge.js";

export const CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID = "CROSS_SECTIONAL_MARKET_NEUTRAL";
/** 2026-07-08: lane ids for the two additional executor instances (see CrossSectionalExecutorOptions
 *  targetVariant/laneId) that mirror the TREND_BETA_VOL / MIXED_MEAN_REVERSION measured variants.
 *  Each variant's own signal production already regime-gates itself (TREND_LONG/SHORT and
 *  MIXED_CHOP respectively, see cross-sectional-edge.ts's runCrossSectionalCycle) — these lane ids
 *  just let the operator/autopilot separately control the executor's allocation weight, same as
 *  every other lane. */
export const CROSS_SECTIONAL_TREND_LANE_ID = "CROSS_SECTIONAL_TREND";
export const CROSS_SECTIONAL_MIXED_LANE_ID = "CROSS_SECTIONAL_MIXED";

export type CrossSectionalExecClient = Pick<
  BinanceFuturesPrivateClient,
  "getExchangeFilters" | "placeOrder" | "setLeverage" | "getPositions" | "queryOrder" | "getUserTrades"
> & {
  /** Restart-recovery reconciliation only (see recoverIncompleteBaskets/reconcilePlannedLeg below) —
   *  deliberately OPTIONAL, not added to the Pick<...> list above, so every existing fake/test client
   *  that never wires it keeps compiling and behaves exactly as it does today (an ambiguous leg with
   *  no way to query the exchange is treated as INCONCLUSIVE and simply retried next tick, never a
   *  crash). Real production wiring is a real BinanceFuturesPrivateClient, which already implements
   *  this (see binance-futures-private.ts's own queryOrderByClientId, added for
   *  account-exposure-coordinator.ts's restart/staleness reconciliation — same endpoint, same idea,
   *  reused here for the BASKET's own bookkeeping rather than the exposure ledger's). */
  queryOrderByClientId?: (symbol: string, origClientOrderId: string) => Promise<FuturesOrder>;
};

export function isCrossSectionalExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_EXEC_ENABLED === "1";
}

/** 2026-07-07 operator decision: cross-sectional is the FOUNDATION strategy and must run at full
 *  size regardless of the lane-allocation selector — the selector becomes purely the control for
 *  the DIRECTIONAL mirror slot. Without this flag the executor's leg sizing was scaled by the
 *  selector's CROSS_SECTIONAL weight, so picking any directional allocation silently shrank (or
 *  zeroed) the foundation strategy. Armed/kill-switch gating is NOT affected by this flag. */
export function isCrossSectionalAllocationIndependent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_ALLOCATION_INDEPENDENT === "1";
}

/** 2026-07-22 (CORTEX capital-coverage diagnosis): CROSS_SECTIONAL_TREND/MIXED are gated on
 *  ADMISSION by isNewExecutorLaneAllowed(), which requires laneSelectionExplicitlyIncludesLane()
 *  — false whenever the operator's live allocation table is null/unset, which it currently is on
 *  testnet. Their signals fire on ordinary/common regime states (TREND_LONG/SHORT, MIXED_CHOP),
 *  yet neither lane has ever been given a table slot, so they sit at 0 real outcomes forever —
 *  structurally unable to ever reach CORTEX's LEARNING_ACTIVE threshold no matter what else is
 *  fixed. Setting the table to include them was investigated and rejected: ~28 other real lanes
 *  (12 executor-constructed + up to 16 actively-mirrored HEADLINE variants under
 *  LIVE_MIRROR_ALL_PAPER=1) currently rely on the table staying null (permissive-when-null), and
 *  the table's own MAX_LANE_ALLOCATIONS cap (default 10) can't even hold that many rows — so a
 *  non-null table would either reject outright or silently zero unlisted real lanes. A DEDICATED
 *  flag (deliberately separate from CROSS_SECTIONAL_ALLOCATION_INDEPENDENT, which is MARKET_
 *  NEUTRAL's own "foundation lane" sizing-independence decision — that must stay independently
 *  toggleable) reuses the SAME proven crossSectionalMarketNeutralIsAllowed() bypass for admission
 *  ONLY, on these 2 lanes only. Sizing is untouched: laneWeightPct still reads
 *  laneSelectionWeightPctForLane() normally (already 100 today under the null table, and will
 *  correctly respect a real table if the operator ever sets one). Default OFF — a deliberate,
 *  separate step from shipping this code. */
export function isCrossSectionalTrendMixedAdmissionIndependent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_TREND_MIXED_ADMISSION_INDEPENDENT === "1";
}

/** 2026-07-20 real-money audit fix (round 2): admission must mirror the sizing exemption above.
 *  A basket marked allocation-independent must not be gated behind the single-symbol lane
 *  selector at all (regular OR manual-directional flavor) — only armed/killed/drain, via
 *  `canOpenIgnoringManualDirectional`. Disabling the flag falls all the way back to the original,
 *  fully-coupled behavior (`canOpenNewEntries` + the lane-selector check) so the flag genuinely
 *  controls independence, not just sizing. Pure so app.ts's otherwise-untestable wiring closure
 *  can be covered directly. */
export function crossSectionalMarketNeutralIsAllowed(deps: {
  allocationIndependent: boolean;
  canOpenIgnoringManualDirectional: () => boolean;
  canOpenNewEntries: () => boolean;
  unifiedOrchestratorEnabled: boolean;
  allowsCrossSectionalLane: () => boolean;
  laneSelectionAllowsLane: () => boolean;
}): boolean {
  if (deps.allocationIndependent) return deps.canOpenIgnoringManualDirectional();
  return deps.unifiedOrchestratorEnabled
    ? deps.canOpenNewEntries() && deps.allowsCrossSectionalLane()
    : deps.canOpenNewEntries() && deps.laneSelectionAllowsLane();
}

const LEG_USD = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_LEG_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 25;
};
const EXEC_LEVERAGE = () => {
  const n = Number.parseInt(process.env.CROSS_SECTIONAL_EXEC_LEVERAGE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
/** Which measured variant to execute. Default FILTERED (operator: follow the /research
 *  filtered symbols, whose allow/blocklists now auto-update from measured leg returns). */
const EXEC_VARIANT = () => process.env.CROSS_SECTIONAL_EXEC_VARIANT ?? "FILTERED";
/**
 * Only execute signals younger than this — a stale basket's momentum ranking has drifted. Signals
 * emit hourly (1h bars); a 15-min window meant the executor could only catch a signal in the first
 * 15 min of the hour, so it almost never opened. Default 50 min: a <1h-old ranking is negligible
 * drift on a 24h hold, and every hourly signal becomes reliably catchable. Env-tunable.
 */
const MAX_SIGNAL_AGE_MS = () =>
  Math.max(60_000, Math.floor(Number(process.env.CROSS_SECTIONAL_EXEC_MAX_SIGNAL_AGE_MS) || 50 * 60_000));
/**
 * Max concurrently-OPEN baskets. Was hard-locked to 1 — with a 24h horizon that capped the whole
 * lane to ONE basket per day (why testnet looked dead). >1 opens a fresh basket each hour it forms,
 * diversifying entry times and accumulating proof far faster; each basket is a bounded $legUsd hedge.
 */
const MAX_OPEN_BASKETS = () =>
  Math.max(1, Math.floor(Number(process.env.CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS) || 1));
/** Store never capped closed/aborted baskets, growing forever. Keeps every OPEN basket
 *  unconditionally and caps settled (CLOSED/ABORTED) ones to the newest N by openedAt. */
const MAX_STORED_BASKETS = () =>
  Math.max(1, Math.floor(Number(process.env.CROSS_SECTIONAL_EXEC_MAX_STORED_BASKETS) || 2000));
const TAKER_FEE_RATE = 0.0005; // 5 bps per side, conservative
/** The `limit` closeBasket() asks /fapi/v1/userTrades for, and therefore the row count at which a
 *  page is SATURATED (Binance returns at most `limit` rows forward from `startTime`). Named so the
 *  request and the saturation test cannot drift apart — if they do, ExecutionFillRecord.fetchComplete
 *  starts claiming a completeness it cannot know. Recording-only; the fee sum is unaffected. */
const USER_TRADES_PAGE_LIMIT = 1000;
/**
 * Profit-bank trigger, expressed as net (cost-adjusted) return on deployed capital — same unit as
 * cross-sectional-edge.ts's netReturn. Default 0.6% is sourced from measured reality, not a guess:
 * as of 2026-07-06 the executed FILTERED variant's 77 closed baskets averaged netAvgReturn=0.592%
 * at the full 24h HORIZON exit (100% of closes were HORIZON — nothing ever exited early). Baskets
 * were sitting the full horizon even when they'd already reached-or-beaten that average well before
 * hour 24 (see recentNetReturns spread in /api/shadow/cross-sectional-report). Banking the average
 * outcome as soon as it's reached — instead of waiting out the clock for a coin-flip on the rest —
 * frees the basket slot for a fresh cycle sooner. Only ever fires on the profit side; a basket that
 * never reaches this still rides HORIZON (or an existing SL/regime-flip cut) exactly as before.
 */
const TP_NET_RETURN = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_TP_NET_RETURN ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0.006;
};
/** Basket-level safety breaker (2026-07-07 operator: "safety net, bukan profit killer"): when the
 *  day's REALIZED basket losses breach this, STOP OPENING new baskets until UTC midnight. Open
 *  baskets keep running their own exits untouched — they are hedged and horizon-bounded, and
 *  force-flattening a hedge that can still recover would be exactly the profit-killer this is
 *  deliberately not. 0 = disabled. */
const XSEC_DAILY_MAX_LOSS_USD = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_DAILY_MAX_LOSS_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export interface ExecutorLeg {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  entryOrderId: string;
  /** False when the exchange never confirmed a real fill price (see resolveFillPrice) and
   *  entryPrice fell back to the pre-trade reference price — a signal the recorded entry
   *  may not reflect what actually executed. True is the normal case. */
  entryPriceConfirmed: boolean;
  exitPrice: number | null;
  exitOrderId: string | null;
  /** Same caveat as entryPriceConfirmed, for the exit fill. Null while still open. */
  exitPriceConfirmed: boolean | null;
  /** Index into ExecutorBasket.plan this fill resolves — legs are always pushed in strict plan
   *  order (see placeRemainingLegs), so legs[k] always resolves plan[k] for k < legs.length, but
   *  this makes that pairing explicit rather than implicit-by-array-position. Optional: baskets
   *  persisted before `plan` existed (or test fixtures that never exercise the open/recovery path)
   *  never carry it, and nothing reads it as load-bearing — purely a debugging/audit aid. */
  planIndex?: number;
}

/**
 * The RESTART-DURABLE record of one planned leg's expected shape and where it is in the placement
 * lifecycle — persisted on ExecutorBasket.plan the moment a basket is sized (before ANY order is
 * placed), so a crash between "planned" and "fully filled" leaves enough on disk to resume the
 * EXACT same plan rather than guess one from whatever happens to be in `legs` (see
 * recoverIncompleteBaskets/placeRemainingLegs). requestedQty/refPrice are the REQUESTED side of the
 * requested-vs-actual pair; the ACTUAL side (once filled) lives on the corresponding ExecutorLeg —
 * see ExecutorLeg.planIndex for the pairing.
 *
 * status:
 *   "PENDING"          — planned and reserved, this leg's own placeOrder has never been attempted
 *                         by ANY process (this or a since-crashed one).
 *   "PLACING"          — a placeOrder attempt for THIS leg was in flight the moment this was last
 *                         persisted. Ambiguous on restart (see reconcilePlannedLeg) — the ONLY
 *                         status that triggers an exchange reconciliation query before resuming.
 *   "FILLED"           — real fill recorded (in `legs`), whether from a normal placeOrder response
 *                         or adopted via restart reconciliation.
 *   "FAILED"           — this leg's own placement definitively failed (the basket aborts).
 *   "NEVER_ATTEMPTED"  — a LATER leg, never reached because an earlier one in the same basket
 *                         failed (hedge-integrity: one failed leg aborts the whole basket).
 */
export interface PlannedLeg {
  planIndex: number;
  symbol: string;
  side: "LONG" | "SHORT";
  requestedQty: number;
  refPrice: number;
  /** account-exposure-coordinator.ts reservation id for THIS leg, or null when reserveExposure
   *  isn't wired (the safe no-op default — see CrossSectionalExecutorOptions.reserveExposure).
   *  Persisted (not just kept in a local closure) specifically so a restart-recovery process that
   *  never called reserveExposure itself can still commit/release the SAME reservation the
   *  original, now-dead process created. */
  reservationId: string | null;
  /** Deterministic, computed ONCE at sizing time — the exact string every placeOrder attempt for
   *  this leg (original or resumed after a restart) submits as newClientOrderId, and the exact
   *  string a restart-recovery query looks up via queryOrderByClientId. */
  entryClientOrderId: string;
  status: "PENDING" | "PLACING" | "FILLED" | "FAILED" | "NEVER_ATTEMPTED";
  failureReason: string | null;
}

export interface ExecutorBasket {
  basketId: string;
  sourceObservationId: string;
  signal: string;
  variant: string;
  openedAt: string;
  closesAtMs: number;
  /** Optional observation-owned basket geometry, enabled only for dedicated innovation executors. */
  takeProfitReturn?: number | null;
  stopLossReturn?: number | null;
  legs: ExecutorLeg[];
  /**
   * RESERVED           — basket row created, plan finalized + exposure reserved, no leg's
   *                       placeOrder has been attempted yet (legs.length === 0).
   * PLACING            — attempting the VERY FIRST leg (legs.length === 0, one attempt in flight).
   * PARTIALLY_FILLED   — at least one leg filled, fewer than plan.length total. Per-leg placement
   *                       progress for whichever leg is currently being attempted lives on
   *                       plan[i].status, not a second basket-level PLACING re-entry — the basket
   *                       stays PARTIALLY_FILLED throughout every subsequent leg attempt.
   * COMPLETE           — every planned leg filled. The healthy, steady-state, live basket — this is
   *                       what plain "OPEN" meant before this field grew real granularity.
   * CLOSED / ABORTED   — unchanged terminal states from before this field grew granularity.
   *
   * See isBasketLive() for "still relevant to exposure/leverage/netting bookkeeping" (everything
   * except CLOSED/ABORTED) vs. the strict "healthy and fully filled" COMPLETE check that gates
   * TP/HORIZON closing (see closeBasketsHittingProfitTarget/closeDueBaskets).
   */
  status: "RESERVED" | "PLACING" | "PARTIALLY_FILLED" | "COMPLETE" | "CLOSED" | "ABORTED";
  /** The expected leg plan, persisted before any order is placed — see PlannedLeg's doc comment.
   *  Optional: baskets persisted before this field existed (or a handful of test fixtures that seed
   *  a basket directly for close-path-only testing, never exercising open/recovery) don't carry it.
   *  recoverIncompleteBaskets() never touches a basket whose plan isn't a real array — it cannot
   *  safely guess a plan it was never given. */
  plan?: PlannedLeg[];
  /**
   * 2026-08-04 (concurrent-close race fix, ground truth #8): set by closeAllBasketsOrderly() when
   * it needs THIS basket closed but an in-flight placeRemainingLegs() call currently owns it (see
   * claimBasket/releaseBasket) — closeAllBasketsOrderly runs OUTSIDE tick()'s own single-flight
   * `this.ticking` guard (app.ts's kill-switch handler calls it directly), so without this field a
   * racing close could finalize the basket from whatever legs exist RIGHT NOW while the in-flight
   * loop is about to push ANOTHER leg fill onto the same object — silently overwriting the
   * finalized status and leaving that next leg permanently unaccounted for. Picked up by the SAME
   * in-flight call's own between-legs recheck (see placeRemainingLegs) within, at most, one leg's
   * placeOrder round-trip — never silently dropped. Cleared the moment it's consumed; never read
   * once a basket reaches a terminal status.
   */
  pendingKillReason?: string;
  closedAt: string | null;
  closeReason: string | null;
  grossPnlUsd: number | null;
  feeEstimateUsd: number | null;
  /** PROVENANCE of feeEstimateUsd (2026-07-26, purely additive, report-only — nothing reads it to
   *  make a decision). Same contract and same values as SingleSymbolPosition.feeSource in
   *  single-symbol-lane-executor.ts; see that field's doc comment for the full rationale.
   *
   *    "EXCHANGE"            — summed from getUserTrades commission rows for this basket's own leg
   *                            order ids.
   *    "ESTIMATE_TAKER_FLAT" — the notionalTouched × TAKER_FEE_RATE fallback, taken whenever ANY
   *                            per-symbol fetch threw or no leg order id matched a trade at all.
   *    undefined             — basket persisted before this field existed, never closed, or closed
   *                            via the RECONCILED_POSITION_ALREADY_FLAT abort path (which sets
   *                            feeEstimateUsd itself to null). UNKNOWN — never assume exchange-true.
   *
   *  CAVEAT, same as the single-symbol field: "EXCHANGE" documents the METHOD, not completeness.
   *  The sum is taken over one 1000-row getUserTrades page per unique symbol; a basket whose legs
   *  were pushed off that page by unrelated activity still labels EXCHANGE while under-counting.
   *  Only `sawAnyTrade` (all-or-nothing) is checked today, not per-leg coverage — recording a
   *  matched-vs-expected leg count would make that detectable and is a worthwhile follow-up. */
  feeSource?: "EXCHANGE" | "ESTIMATE_TAKER_FLAT";
  netPnlUsd: number | null;
  /** Stamped by every profit-target check (5-min tick): the basket's CURRENT net return vs the
   *  TP threshold, so the dashboard can show the live TP gap per basket — "tinggal berapa lagi,
   *  bakal nyampe atau engga, ada yang macet atau engga" (2026-07-07 operator ask). */
  lastNetReturn?: number | null;
  lastNetAt?: string | null;
  /** CORTEX real-USDT attribution capture-at-open (2026-07-22 bug-hunt fix): the applied vs
   *  raw-static allocation weight, frozen the instant the basket opens — same convention as
   *  SingleSymbolPosition's cortexAppliedWeightPct/cortexRawStaticWeightPct in
   *  single-symbol-lane-executor.ts. Optional so baskets persisted before this field existed are
   *  never retroactively assigned an invented tilt share. */
  cortexAppliedWeightPct?: number;
  cortexRawStaticWeightPct?: number;
}

/**
 * 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): a REAL, still-open exchange
 * position that this executor's normal bookkeeping can no longer reach through its usual
 * HORIZON/PROFIT_BANK close paths. Two origins:
 *  - maybeOpenBasket's abort path: one leg already opened, a LATER leg's placeOrder then threw
 *    (a naked directional bet), and the abort handler's OWN flatten attempt for the already-opened
 *    leg ALSO failed (e.g. a sibling XSEC executor already holds the opposite side on this symbol,
 *    or a transient exchange/network error). Before this existed, that leg fell out of the
 *    basket's bookkeeping entirely — recorded ABORTED with exitOrderId still null, but nothing
 *    ever looked at it again.
 *  - closeBasket's exit path: a genuine partial MARKET fill on the reduce-only close order left a
 *    real, un-closed remainder on the exchange (see BUG 3's executedQty validation) — the
 *    remainder is tracked here exactly like a failed-flatten leg, not silently dropped.
 * retryOrphanedLegFlattens() retries the flatten every tick until it actually resolves (either a
 * real fill, or the exchange confirming the position is already flat/opposite-signed — never
 * blindly retried forever against a position that's already gone). getStatus().orphanedLegs
 * surfaces this list so an operator (or a future account-wide reconciliation) can never mistake a
 * still-failing retry for "handled".
 */
export interface OrphanedLeg {
  basketId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  entryOrderId: string;
  /** ISO timestamp of the ORIGINAL failure that created this record — never updated on retry. */
  since: string;
  lastAttemptAt: string;
  lastError: string;
  attempts: number;
}

interface ExecutorState {
  version: number;
  baskets: ExecutorBasket[];
  /** openedAtMs watermark — signals at/below this are never re-executed. */
  lastSeenSignalMs: number;
  /** See OrphanedLeg's doc comment. Persisted so a restart doesn't lose track of a still-exposed
   *  position — same convention as live-execution-engine.ts's killSwitchFlattenFailedIntentIds. */
  orphanedLegs: OrphanedLeg[];
}

export class CrossSectionalExecutorStore {
  private readonly file: string;
  private state: ExecutorState;

  constructor(
    dataDir = "data",
    fileName = "cross-sectional-executor.json",
    private readonly initialLastSeenSignalMs = Date.now(),
  ) {
    this.file = resolve(dataDir, fileName);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  private _load(): ExecutorState {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
        if (parsed && Array.isArray(parsed.baskets)) {
          // Legacy records persisted before entryOrderId/exitOrderId became strings (see
          // binance-futures-private.ts's order-ID precision fix) still have these as bare JS
          // numbers on disk — normalize on load so trade-matching `===` against a freshly
          // fetched (genuinely string) order id doesn't silently mismatch on type alone.
          for (const b of parsed.baskets as Array<{ legs?: Array<Record<string, unknown>> }>) {
            for (const leg of b.legs ?? []) {
              if (typeof leg.entryOrderId === "number") leg.entryOrderId = String(leg.entryOrderId);
              if (typeof leg.exitOrderId === "number") leg.exitOrderId = String(leg.exitOrderId);
            }
          }
          // 2026-07-19 real-money audit fix (BUG 1): legacy records persisted before
          // orphanedLegs existed have no such field on disk — default it, never leave it
          // undefined (every reader below assumes an array).
          if (!Array.isArray((parsed as { orphanedLegs?: unknown }).orphanedLegs)) {
            (parsed as { orphanedLegs: OrphanedLeg[] }).orphanedLegs = [];
          }
          // Legacy status migration: records persisted before this task's richer status enum
          // existed used status "OPEN" for BOTH "mid-placement" and "fully filled, healthy" —
          // there is no way to recover which one a bare "OPEN" meant after the fact, but every
          // real basket that ever survived to be read back here (i.e. wasn't lost to the exact
          // CORE GAP this task closes) has `legs` reflecting what actually filled, so the safest,
          // most conservative reading is "treat every already-placed leg as the complete plan" —
          // never silently reopen/guess at continuing a placement attempt from years-old data.
          // Same defensive spirit as the entryOrderId/orphanedLegs normalization just above.
          for (const b of parsed.baskets as Array<Record<string, unknown>>) {
            const legacyStatus = b.status;
            if (legacyStatus === "OPEN") {
              const legs = Array.isArray(b.legs) ? (b.legs as Array<Record<string, unknown>>) : [];
              if (legs.length > 0) {
                // Backfill a plan 1:1 from the real legs — every entry already resolved FILLED, so
                // this basket is immediately eligible for the normal COMPLETE-only close paths
                // again (TP/HORIZON) instead of being silently stuck in permanent limbo.
                b.plan = legs.map((leg, i) => ({
                  planIndex: i,
                  symbol: leg.symbol,
                  side: leg.side,
                  requestedQty: leg.qty,
                  refPrice: leg.entryPrice,
                  reservationId: null,
                  entryClientOrderId: typeof leg.entryOrderId === "string" ? leg.entryOrderId : String(leg.entryOrderId ?? ""),
                  status: "FILLED",
                  failureReason: null,
                }));
                b.status = "COMPLETE";
              } else {
                // The exact "CORE GAP" scenario: OPEN with zero real legs and no recorded plan —
                // cannot safely guess what was intended, and cannot safely resume placing an
                // unknown plan with real money. There is no QUARANTINED state in this phase (see
                // the next phase's critical-latch work), so the safest available terminal state is
                // ABORTED — never touched again by any close/recovery path, never silently dropped.
                b.plan = [];
                b.status = "ABORTED";
                b.closedAt = b.closedAt ?? new Date().toISOString();
                b.closeReason = "PRE_MIGRATION_UNKNOWN_PLAN";
              }
            }
          }
          return parsed as ExecutorState;
        }
      }
    } catch {
      // corrupt → fresh (positions reconcile against the exchange on next tick)
    }
    return { version: 1, baskets: [], lastSeenSignalMs: this.initialLastSeenSignalMs, orphanedLegs: [] };
  }

  getState(): ExecutorState {
    return this.state;
  }

  private prune(): void {
    const max = MAX_STORED_BASKETS();
    if (this.state.baskets.length <= max) return;
    // Every non-terminal status (RESERVED/PLACING/PARTIALLY_FILLED/COMPLETE) is kept unconditionally
    // — same "never prune a still-live basket" intent as the original OPEN-only check, just widened
    // to match the richer enum (a basket mid-recovery must never be pruned out from under it).
    const isTerminal = (status: ExecutorBasket["status"]): boolean => status === "CLOSED" || status === "ABORTED";
    const open = this.state.baskets.filter((b) => !isTerminal(b.status));
    const settled = this.state.baskets
      .filter((b) => isTerminal(b.status))
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, Math.max(0, max - open.length));
    this.state.baskets = [...open, ...settled];
  }

  save(): void {
    try {
      this.prune();
      // Atomic write: the previous version wrote the same content to both a .tmp file and
      // directly to this.file, so the .tmp write was dead weight and the main write was never
      // atomic (a crash mid-write could truncate/corrupt this.file). Now the tmp file is the
      // actual write target and gets renamed into place, matching the pattern used elsewhere
      // (paper-execution-router.ts, current-guard-variant-matrix.ts).
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // never let a persistence failure break the tick
    }
  }
}

export interface CrossSectionalExecutorOptions {
  client: CrossSectionalExecClient;
  signalStore: Pick<CrossSectionalStore, "all">;
  store: CrossSectionalExecutorStore;
  /** Master permission gate. Testnet: () => true. Mainnet: () => engine.isArmed(). */
  isAllowed: () => boolean;
  /** Operator lane allocation weight. 100 = normal leg size; 0 = blocked. */
  laneWeightPct?: () => number;
  nowIso?: () => string;
  /** Delay between queryOrder confirmation retries in resolveFillPrice. Default 400ms; tests pass 0. */
  fillConfirmRetryDelayMs?: number;
  /** Daily basket loss breaker limit override (tests inject; default reads
   *  CROSS_SECTIONAL_DAILY_MAX_LOSS_USD — env mutation in tests leaks across vitest workers). */
  dailyMaxLossUsd?: () => number;
  /** 2026-07-08 (operator: "wire lane baru ke allocation selection"): which measured cross-sectional
   *  variant THIS executor instance mirrors. Defaults to the original global env read
   *  (CROSS_SECTIONAL_EXEC_VARIANT, "FILTERED") so the existing single-instance construction is
   *  byte-for-byte unchanged. Explicit override lets app.ts run MULTIPLE executor instances
   *  concurrently — one per variant (FILTERED/TREND_BETA_VOL/MIXED_MEAN_REVERSION) — each with its
   *  own lane id + allocation weight, instead of one global instance stuck on a single variant. */
  targetVariant?: string;
  /** Lane id this instance reports in getStatus()/laneWeightPct lookups. Defaults to the original
   *  CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID (unchanged for the existing FILTERED instance). */
  laneId?: string;
  /** Rolling evidence gate for NEW baskets. Existing baskets keep closing while this is false. */
  entryHealthGate?: () => { allowed: boolean; reason: string | null };
  /** 2026-07-11 real-money audit fix: FILTERED/TREND/MIXED are 3 separate CrossSectionalExecutor
   *  instances, each with its OWN store file, sharing ONE exchange account that Binance nets per
   *  symbol. siblingOppositeUnexitedQty() used to only ever see THIS instance's own baskets — so a
   *  same-symbol opposite-side leg owned by a SIBLING instance was invisible, and dropping
   *  reduceOnly on that basis could either be wrongly refused (a real -2022 later) or wrongly
   *  granted (masking real over-exposure) depending on what the sibling actually held. Defaults to
   *  none (existing single-instance behavior/tests unchanged); app.ts wires each instance to query
   *  the other two's getOpenUnexitedLegs().
   */
  siblingOpenLegs?: () => Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }>;
  /** 2026-07-12 fix: dailyRealizedUsd() only ever summed THIS instance's own CLOSED baskets, but
   *  XSEC_DAILY_MAX_LOSS_USD is ONE shared env ceiling checked independently per instance in
   *  maybeOpenBasket — so the REAL combined daily loss across all 3 sibling instances could reach
   *  up to 3x the configured limit before any single instance's own admission check ever halted.
   *  Defaults to none (existing single-instance behavior/tests unchanged); app.ts wires each
   *  instance to sum the other two's getDailyRealizedUsd(nowIso). */
  siblingDailyRealizedUsd?: (nowIso: string) => number;
  /** 2026-07-12 fix: closeBasketsHittingProfitTarget() called this.client.getPositions() (an
   *  uncached, unfiltered signed GET against the account-wide weight budget) independently in
   *  every one of the 3 sibling instances' 5-minute ticks, purely to read symbol-level markPrice —
   *  market-wide data all 3 could share from ONE call. Optional override so app.ts can inject a
   *  short-TTL shared cache across all 3 instances; defaults to the direct client call (existing
   *  single-instance behavior/tests unchanged). */
  sharedGetPositions?: () => ReturnType<CrossSectionalExecClient["getPositions"]>;
  /** 2026-07-19 real-money audit fix: notional (USD) already committed to a symbol by every
   *  OTHER executor sharing this netted Binance account — the 9 SingleSymbolLaneExecutor
   *  instances AND the 2 sibling CrossSectionalExecutor instances (never `self`; app.ts wires
   *  this the same way notionalForSymbolExcluding does for the single-symbol side — see
   *  live-executor-wiring.ts's computeNotionalPerSymbol doc comment). Before this option existed,
   *  a cross-sectional basket leg had ZERO visibility into what the single-symbol lanes (or its
   *  own siblings) already held on the same symbol, so a leg could stack arbitrarily on top of an
   *  already-capped single-symbol position. Defaults to `() => 0` (no other executor's exposure
   *  known / not wired) — existing single-instance construction and tests are unaffected. Paired
   *  with `maxNotionalPerSymbolAcrossLanes` below. */
  existingNotionalForSymbol?: (symbol: string) => number;
  /** 0 (default) = no cap, byte-identical to pre-2026-07-19 behavior. A fresh leg whose notional,
   *  ADDED to existingNotionalForSymbol's reading for that symbol PLUS this instance's own
   *  already-open basket legs on it, would exceed this is skipped — but per this executor's own
   *  hedge-integrity design constraint (see the module doc comment at the top of this file: "Either
   *  the WHOLE basket opens or nothing"), a capped leg skips the ENTIRE basket this tick, exactly
   *  like the existing missing-filters/un-sizeable-leg checks in maybeOpenBasket. This constraint is
   *  TRANSIENT (another lane's position on the symbol may close by the next tick, freeing capacity)
   *  — the watermark is already advanced before this check runs, so the signal is not retried, but
   *  the NEXT fresh signal on the same symbol gets a clean re-evaluation. */
  maxNotionalPerSymbolAcrossLanes?: () => number;
  /** Shared account-exposure coordinator (account-exposure-coordinator.ts) — this executor's
   *  FIRST-EVER in-flight per-symbol claim mechanism (unlike SingleSymbolLaneExecutor, which already
   *  has tryClaimEntrySymbol/releaseEntrySymbol; CrossSectionalExecutor has never had an equivalent,
   *  nor any cluster-based admission gate). Reserves risk capacity for EVERY planned leg, atomically,
   *  inside the sizing loop BEFORE any leg's order is placed — see maybeOpenBasket's plannedLegs
   *  loop. Optional, defaults to an always-succeeds no-op ({ok:true, reservationId:null}) so every
   *  existing test that doesn't wire this stays byte-for-byte unaffected — same optional-closure-
   *  with-safe-default convention as existingNotionalForSymbol above. */
  reserveExposure?: (req: ExposureReserveRequest) => ExposureReserveResult;
  /** Commits a reservation from the ACTUAL fill (never the requested qty) once one lands. Optional,
   *  defaults to a no-op — see reserveExposure above. */
  commitExposureReservation?: (reservationId: string, filled: { qty: number; avgPrice: number }) => void;
  /** Releases unused capacity on rejection, timeout, cancellation, or failure. Optional, defaults to
   *  a no-op — see reserveExposure above. */
  releaseExposureReservation?: (reservationId: string, reason: string) => void;
  /** Innovation-campaign cap context (account-exposure-coordinator.ts's ExposureReserveCampaignCap),
   *  folded onto every leg's reserveExposureFn() call in the sizing loop — see that type's own doc
   *  comment. Optional, defaults to () => undefined so every mainnet construction site (and every
   *  existing test) is byte-for-byte unaffected; only app.ts's innovation construction block ever
   *  wires this, via innovation-campaign.ts's campaignCapForLane(). */
  campaignCap?: () => ExposureReserveCampaignCap | undefined;
  /** CORTEX real-USDT attribution (2026-07-22 bug-hunt fix): the operator's untouched static-table
   *  weight, read the same way laneWeightPct reads the (possibly CORTEX-tilted) applied weight.
   *  Same optional posture as single-symbol-lane-executor.ts's rawLaneWeightPct — omit and this
   *  executor is byte-for-byte unchanged (rawAllocationWeightPct mirrors allocationWeightPct,
   *  tiltShare is 0 by construction). */
  rawLaneWeightPct?: () => number;
  /** CORTEX real-USDT attribution store (2026-07-22 bug-hunt fix): CROSS_SECTIONAL_MARKET_NEUTRAL/
   *  TREND/MIXED are full CORTEX_LANE_ROSTER members whose real sizing already responds to
   *  CORTEX's tilt via laneWeightPct — before this option existed, every basket this executor
   *  closed was invisible to cortex-real-attribution.ts's ledger entirely (not reported as $0,
   *  simply never recorded), silently omitting this whole execution architecture. Optional: omit
   *  and nothing is recorded, same as before this fix (existing single-instance tests unaffected). */
  cortexRealAttribution?: CortexRealAttributionStore;
  /** Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
   *  closeBasket() already fetches one getUserTrades page per unique symbol to sum the REAL
   *  commissions, then keeps `t.commission` and discards every other field of every matched row —
   *  so a basket's actual per-leg exit prices, per-fill commissions and exchange fill times exist
   *  in memory for one loop iteration and are then gone forever. This option persists those rows
   *  verbatim. NO EXTRA EXCHANGE CALL: it reuses the exact same `trades` pages that loop already
   *  fetched. Optional — omit and this executor is byte-for-byte unchanged. */
  executionFillRecorder?: ExecutionFillRecorder;
  /** Per-instance sizing/cadence overrides. Existing executors retain the global defaults. */
  legUsd?: () => number;
  leverage?: () => number;
  maxOpenBaskets?: () => number;
  maxSignalAgeMs?: () => number;
  /** Prevents client-order-id collisions between isolated innovation stores sharing a timestamp. */
  idNamespace?: string;
  /** Honor signal-owned basket TP/SL. Off by default so existing live behavior is unchanged. */
  respectSignalRiskGeometry?: boolean;
  /** Status-only enabled marker for executors that have a dedicated feature gate. */
  enabled?: () => boolean;
}

export class CrossSectionalExecutor {
  private readonly client: CrossSectionalExecClient;
  private readonly signalStore: Pick<CrossSectionalStore, "all">;
  private readonly store: CrossSectionalExecutorStore;
  private readonly isAllowed: () => boolean;
  private readonly fillConfirmRetryDelayMs: number;
  private readonly laneWeightPct: () => number;
  private readonly nowIso: () => string;
  private readonly targetVariant: string;
  private readonly laneId: string;
  private ticking = false;
  private lastError: string | null = null;
  private openHalted: string | null = null;
  /** See claimBasket/releaseBasket's own doc comment (ground truth #8, concurrent-close race). */
  private busyBasketIds = new Set<string>();
  private readonly dailyMaxLossUsdFn: () => number;
  private readonly entryHealthGate: () => { allowed: boolean; reason: string | null };
  private readonly siblingOpenLegs: () => Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }>;
  private readonly siblingDailyRealizedUsd: (nowIso: string) => number;
  private readonly sharedGetPositions: () => ReturnType<CrossSectionalExecClient["getPositions"]>;
  private readonly existingNotionalForSymbolFn: (symbol: string) => number;
  private readonly maxNotionalPerSymbolAcrossLanesFn: () => number;
  private readonly reserveExposureFn: (req: ExposureReserveRequest) => ExposureReserveResult;
  private readonly commitExposureReservationFn: (reservationId: string, filled: { qty: number; avgPrice: number }) => void;
  private readonly releaseExposureReservationFn: (reservationId: string, reason: string) => void;
  private readonly campaignCapFn: () => ExposureReserveCampaignCap | undefined;
  private readonly rawLaneWeightPctFn: (() => number) | null;
  private readonly cortexRealAttribution: CortexRealAttributionStore | null;
  private readonly executionFillRecorder: ExecutionFillRecorder | null;
  private readonly legUsdFn: () => number;
  private readonly leverageFn: () => number;
  private readonly maxOpenBasketsFn: () => number;
  private readonly maxSignalAgeMsFn: () => number;
  private readonly idNamespace: string;
  private readonly respectSignalRiskGeometry: boolean;
  private readonly enabledFn: () => boolean;

  constructor(opts: CrossSectionalExecutorOptions) {
    this.client = opts.client;
    this.signalStore = opts.signalStore;
    this.store = opts.store;
    this.isAllowed = opts.isAllowed;
    this.laneWeightPct = opts.laneWeightPct ?? (() => 100);
    this.targetVariant = opts.targetVariant ?? EXEC_VARIANT();
    this.laneId = opts.laneId ?? CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID;
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.fillConfirmRetryDelayMs = opts.fillConfirmRetryDelayMs ?? 400;
    this.existingNotionalForSymbolFn = opts.existingNotionalForSymbol ?? (() => 0);
    this.maxNotionalPerSymbolAcrossLanesFn = opts.maxNotionalPerSymbolAcrossLanes ?? (() => 0);
    this.reserveExposureFn = opts.reserveExposure ?? (() => ({ ok: true, reservationId: null }));
    this.commitExposureReservationFn = opts.commitExposureReservation ?? (() => {});
    this.releaseExposureReservationFn = opts.releaseExposureReservation ?? (() => {});
    this.campaignCapFn = opts.campaignCap ?? (() => undefined);
    this.dailyMaxLossUsdFn = opts.dailyMaxLossUsd ?? XSEC_DAILY_MAX_LOSS_USD;
    this.entryHealthGate = opts.entryHealthGate ?? (() => ({ allowed: true, reason: null }));
    this.siblingOpenLegs = opts.siblingOpenLegs ?? (() => []);
    this.siblingDailyRealizedUsd = opts.siblingDailyRealizedUsd ?? (() => 0);
    this.sharedGetPositions = opts.sharedGetPositions ?? (() => this.client.getPositions());
    this.rawLaneWeightPctFn = opts.rawLaneWeightPct ?? null;
    this.cortexRealAttribution = opts.cortexRealAttribution ?? null;
    this.executionFillRecorder = opts.executionFillRecorder ?? null;
    this.legUsdFn = opts.legUsd ?? LEG_USD;
    this.leverageFn = opts.leverage ?? EXEC_LEVERAGE;
    this.maxOpenBasketsFn = opts.maxOpenBaskets ?? MAX_OPEN_BASKETS;
    this.maxSignalAgeMsFn = opts.maxSignalAgeMs ?? MAX_SIGNAL_AGE_MS;
    this.idNamespace = (opts.idNamespace ?? this.targetVariant).replace(/[^a-zA-Z0-9]/g, "").slice(-6).toLowerCase() || "basket";
    this.respectSignalRiskGeometry = opts.respectSignalRiskGeometry ?? false;
    this.enabledFn = opts.enabled ?? isCrossSectionalExecEnabled;
  }

  /** "Still relevant to exposure/leverage/netting bookkeeping" — everything except the two terminal
   *  statuses. Deliberately BROADER than "healthy and fully filled" (see ExecutorBasket.status's own
   *  doc comment): a RESERVED/PLACING/PARTIALLY_FILLED basket can already hold REAL, exchange-filled
   *  legs (or be about to), and every consumer below existed before this task's richer enum, back
   *  when "OPEN" already covered that same mid-placement window transiently — this preserves that
   *  exact prior behavior instead of narrowing it to COMPLETE-only (which would make a stuck/
   *  recovering basket's real legs invisible to sibling-netting and leverage bookkeeping). Contrast
   *  with the strict `status === "COMPLETE"` gate closeBasketsHittingProfitTarget/closeDueBaskets use
   *  — TP/HORIZON math specifically requires the FULL intended hedge to be present. */
  private isBasketLive(basket: ExecutorBasket): boolean {
    return basket.status !== "CLOSED" && basket.status !== "ABORTED";
  }

  /**
   * 2026-08-04 (concurrent-close race fix, ground truth #8): per-basket mutual exclusion between
   * placeRemainingLegs() (which mutates basket.legs/basket.status across a whole placement
   * attempt — possibly several sequential `await`s) and closeAllBasketsOrderly()'s own
   * closeBasket() call, the ONE close path that runs OUTSIDE tick()'s `this.ticking` single-flight
   * guard (see closeAllBasketsOrderly's own doc comment). closeDueBaskets/
   * closeBasketsHittingProfitTarget never need this: they only ever touch status==="COMPLETE"
   * baskets, and placeRemainingLegs only ever runs on RESERVED/PLACING/PARTIALLY_FILLED ones — the
   * two sets can't overlap by construction, so a claim there would be inert, not protective.
   * Plain synchronous Set ops: safe without a lock library for the exact reason
   * account-exposure-coordinator.ts's own reserve()/commitReservation() are (see that file's own
   * doc comment) — Node only preempts at `await` points, so "check then insert" here is atomic
   * against every other already-queued synchronous call.
   */
  private claimBasket(basketId: string): boolean {
    if (this.busyBasketIds.has(basketId)) return false;
    this.busyBasketIds.add(basketId);
    return true;
  }
  private releaseBasket(basketId: string): void {
    this.busyBasketIds.delete(basketId);
  }

  /** This instance's own live, un-exited (exitOrderId===null) basket legs — the surface a sibling
   *  CrossSectionalExecutor instance needs to see THIS instance's exposure. */
  getOpenUnexitedLegs(): Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }> {
    const out: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }> = [];
    for (const basket of this.store.getState().baskets) {
      if (!this.isBasketLive(basket)) continue;
      for (const leg of basket.legs) {
        if (leg.exitOrderId === null) out.push({ symbol: leg.symbol, side: leg.side, qty: leg.qty });
      }
    }
    return out;
  }

  /** 2026-07-19 real-money audit fix: this instance's OWN open (un-exited) basket legs' notional
   *  on `symbol` — existingNotionalForSymbolFn only ever sums OTHER executor instances (see its own
   *  doc comment), and MAX_OPEN_BASKETS can exceed 1, so THIS instance alone could hold multiple
   *  concurrent baskets whose legs overlap on the same symbol, invisible to the cap without this
   *  (same self-inclusion fix single-symbol-lane-executor.ts already applies for its own kind). */
  private ownOpenNotionalForSymbol(symbol: string): number {
    let sum = 0;
    for (const basket of this.store.getState().baskets) {
      if (!this.isBasketLive(basket)) continue;
      for (const leg of basket.legs) {
        if (leg.exitOrderId === null && leg.symbol === symbol) sum += leg.qty * leg.entryPrice;
      }
    }
    return sum;
  }

  private entryHealth(): { allowed: boolean; reason: string | null } {
    try {
      const decision = this.entryHealthGate();
      return decision && typeof decision.allowed === "boolean"
        ? { allowed: decision.allowed, reason: decision.reason ?? null }
        : { allowed: false, reason: "invalid cross-sectional entry-health response" };
    } catch (error) {
      return { allowed: false, reason: `cross-sectional entry-health failed: ${(error as Error).message}` };
    }
  }

  /** Thin wrapper over the shared resolveConfirmedFillPrice, injecting this executor's
   *  test-overridable retry delay and a lane-tagged log line. See binance-futures-private.ts
   *  for why this confirmation step exists (basket xb-mr2x7s6e's real-world avgPrice=0 case). */
  private async resolveFillPrice(
    symbol: string,
    orderId: string,
    initialAvgPrice: number,
    fallbackPrice: number,
  ): Promise<FillPriceResolution> {
    return resolveConfirmedFillPrice(this.client, symbol, orderId, initialAvgPrice, fallbackPrice, {
      retryDelayMs: this.fillConfirmRetryDelayMs,
      onUnconfirmed: (sym, id, fallback) =>
        console.error(
          `[cross-sectional-executor] UNCONFIRMED FILL PRICE: ${sym} order ${id} never returned a ` +
            `real avgPrice after retries — recording ${fallback} as a fallback, but this is NOT a ` +
            `confirmed fill price. PnL involving this leg should be treated as uncertain.`,
        ),
    });
  }

  private allocationWeightPct(): number {
    // 2026-07-10: isCrossSectionalAllocationIndependent() was defined (2026-07-07, see its own doc
    // comment above) but never actually consulted here — the foundation lane's real leg size was
    // silently scaled by whatever % the operator gave CROSS_SECTIONAL_MARKET_NEUTRAL in the
    // directional-slot allocation table (confirmed live: 80% weight -> $20 legUsd instead of the
    // documented "$25 full size regardless of allocation"). Only the foundation lane is exempted —
    // CROSS_SECTIONAL_TREND/MIXED (separate instances, own laneId) still scale normally, matching
    // their own doc comment ("let the operator/autopilot separately control the executor's
    // allocation weight, same as every other lane").
    if (isCrossSectionalAllocationIndependent() && this.laneId === CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) {
      return 100;
    }
    const pct = Number(this.laneWeightPct());
    if (!Number.isFinite(pct)) return 100;
    return Math.max(0, Math.min(100, pct));
  }

  private effectiveLegUsd(): number {
    return this.legUsdFn() * (this.allocationWeightPct() / 100);
  }

  /** Raw-static counterpart of allocationWeightPct (CORTEX real-USDT attribution, 2026-07-22 fix):
   *  same clamping AND the same independent-allocation special case (the MARKET_NEUTRAL lane's
   *  applied weight is forced to 100 by that feature, unrelated to CORTEX — mirroring it here
   *  keeps tiltShare 0 for that case instead of misattributing independent-allocation's own effect
   *  to CORTEX). When rawLaneWeightPct isn't wired, mirrors the applied weight so tiltShare is 0
   *  by construction — an unwired instance must never fabricate CORTEX influence. */
  private rawAllocationWeightPct(): number {
    if (isCrossSectionalAllocationIndependent() && this.laneId === CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) {
      return 100;
    }
    if (!this.rawLaneWeightPctFn) return this.allocationWeightPct();
    const pct = Number(this.rawLaneWeightPctFn());
    if (!Number.isFinite(pct)) return 100;
    return Math.max(0, Math.min(100, pct));
  }

  /** CORTEX real-USDT attribution write for one fully closed basket (report-only, 2026-07-22 fix)
   *  — mirrors single-symbol-lane-executor.ts's recordCortexRealAttribution exactly. Called once
   *  from closeBasket's normal-close finalization, right next to its own store.save(). Wrapped so
   *  a failure can NEVER affect settlement. Baskets persisted before the capture fields existed
   *  carry no open-time weights and are skipped rather than assigned an invented tilt share. */
  private recordCortexRealAttribution(basket: ExecutorBasket): void {
    try {
      const store = this.cortexRealAttribution;
      if (!store) return;
      if (typeof basket.cortexAppliedWeightPct !== "number" || typeof basket.cortexRawStaticWeightPct !== "number") return;
      if (typeof basket.netPnlUsd !== "number" || !Number.isFinite(basket.netPnlUsd)) return;
      store.recordClose({
        recordId: `xsec:${this.laneId}:${basket.basketId}`,
        closedAtIso: basket.closedAt ?? this.nowIso(),
        laneId: this.laneId,
        symbol: basket.legs.map((leg) => leg.symbol).join("+"),
        realizedPnlUsd: basket.netPnlUsd,
        appliedWeightPct: basket.cortexAppliedWeightPct,
        rawStaticWeightPct: basket.cortexRawStaticWeightPct,
      });
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  getStatus(): {
    enabled: boolean;
    allowed: boolean;
    laneId: string;
    legUsd: number;
    baseLegUsd: number;
    allocationWeightPct: number;
    leverage: number;
    variant: string;
    /** Profit-bank threshold as % of deployed capital — shown next to each basket's TP gap. */
    tpNetReturnPct: number;
    /** Realized basket P&L for the current UTC day + the safety-breaker limit (0 = disabled). */
    dailyRealizedUsd: number;
    dailyMaxLossUsd: number;
    /** Non-null while the daily-loss breaker is holding NEW opens (open baskets unaffected). */
    openHalted: string | null;
    openBasket: ExecutorBasket | null;
    /** ALL currently-open baskets, not just the first (openBasket, kept for compatibility, is
     *  just openBaskets[0]). MAX_OPEN_BASKETS can exceed 1 (e.g. testnet runs 4) — any consumer
     *  attributing exchange positions to this lane must attribute EVERY open basket's legs, not
     *  only the first, or the 2nd+ basket's real positions silently show as unattributed. */
    openBaskets: ExecutorBasket[];
    closedCount: number;
    totalNetPnlUsd: number;
    lastError: string | null;
    recent: ExecutorBasket[];
    /** Age of the newest matching-variant OPEN signal, in ms; null if none exist at all.
     *  A basket can only open from a signal within MAX_SIGNAL_AGE_MS of now — surfaced here
     *  so a stuck signal pipeline (upstream of this executor) is visible, not silent. */
    signalAgeMs: number | null;
    signalMaxAgeMs: number;
    signalStale: boolean;
    /** Whether the currently-configured allowlist would have starved a side below the legs a
     *  basket needs (2026-07-07: this silently blocked SHORT-side baskets for ~18h on live —
     *  see deriveAdaptiveSymbolFilters's floor). Recomputed live from the signal store, so this
     *  reflects the CURRENT cycle, not a stale snapshot. */
    adaptiveFilters: ReturnType<typeof deriveAdaptiveSymbolFilters>["provenance"];
    /** 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): real, still-open exchange
     *  exposure this executor's normal HORIZON/PROFIT_BANK close paths can no longer reach — see
     *  OrphanedLeg's doc comment. retryOrphanedLegFlattens() retries every tick automatically, but
     *  a NON-EMPTY array here means a position is, right now, still open on the exchange with
     *  every retry so far having failed — an operator (or a future account-wide reconciliation)
     *  must never mistake a still-failing retry for "handled". */
    orphanedLegs: OrphanedLeg[];
  } {
    const st = this.store.getState();
    const closed = st.baskets.filter((b) => b.status === "CLOSED");
    const openBaskets = st.baskets.filter((b) => this.isBasketLive(b));
    const targetVariant = this.targetVariant;
    const nowMs = new Date(this.nowIso()).getTime();
    const matching = this.signalStore.all
      .filter((o) => (o.variant ?? "RAW") === targetVariant)
      .sort((a, b) => b.openedAtMs - a.openedAtMs);
    const signalAgeMs = matching[0] ? nowMs - matching[0].openedAtMs : null;
    const signalMaxAgeMs = this.maxSignalAgeMsFn();
    return {
      enabled: this.enabledFn(),
      allowed: this.isAllowed() && this.entryHealth().allowed,
      laneId: this.laneId,
      legUsd: this.effectiveLegUsd(),
      baseLegUsd: this.legUsdFn(),
      allocationWeightPct: this.allocationWeightPct(),
      leverage: this.leverageFn(),
      variant: targetVariant,
      tpNetReturnPct: TP_NET_RETURN() * 100,
      dailyRealizedUsd: this.dailyRealizedUsd(this.nowIso()),
      dailyMaxLossUsd: this.dailyMaxLossUsdFn(),
      openHalted: this.openHalted,
      openBasket: openBaskets[0] ?? null,
      openBaskets,
      closedCount: closed.length,
      totalNetPnlUsd: closed.reduce((s, b) => s + (b.netPnlUsd ?? 0), 0),
      lastError: this.lastError,
      recent: st.baskets.slice(-10),
      signalAgeMs,
      signalMaxAgeMs,
      signalStale: signalAgeMs === null || signalAgeMs > signalMaxAgeMs,
      adaptiveFilters: deriveAdaptiveSymbolFilters(this.signalStore as CrossSectionalStore).provenance,
      orphanedLegs: st.orphanedLegs ?? [],
    };
  }

  /** Realized results of every CLOSED basket, for account-level display: the engine's own
   *  realized ledger deliberately excludes these positions (they are external-managed claims,
   *  not engine intents), so without this summary a banked basket increases the REAL wallet
   *  balance while every "realized P&L" surface stays flat — exactly the operator confusion
   *  this exists to prevent (2026-07-07: "+1.45 banked, kok realized ga nambah??"). */
  getClosedSummary(): {
    closedCount: number;
    wins: number;
    losses: number;
    realizedPnlUsd: number;
    feesUsd: number;
    symbols: string[];
    lastClosedAt: string | null;
  } {
    const closed = this.store.getState().baskets.filter((b) => b.status === "CLOSED");
    const symbols = new Set<string>();
    let realized = 0;
    let fees = 0;
    let wins = 0;
    let losses = 0;
    let lastClosedAt: string | null = null;
    for (const b of closed) {
      const net = b.netPnlUsd ?? 0;
      realized += net;
      fees += b.feeEstimateUsd ?? 0;
      if (net > 0) wins += 1;
      else losses += 1;
      for (const leg of b.legs) symbols.add(leg.symbol);
      if (b.closedAt && (lastClosedAt === null || b.closedAt > lastClosedAt)) lastClosedAt = b.closedAt;
    }
    return { closedCount: closed.length, wins, losses, realizedPnlUsd: realized, feesUsd: fees, symbols: [...symbols].sort(), lastClosedAt };
  }

  /** 2026-07-12 (profitability Stage 3): report-only regime-skew counterfactual over THIS
   *  executor's real closed baskets — see regimeSkewCounterfactual. Lets the operator see whether
   *  the CROSS_SECTIONAL_REGIME_SKEW tilt (which converts the only true hedge into more same-side
   *  beta) is actually being rewarded, before deciding to keep or disable it. Never affects trading. */
  getRegimeSkewCounterfactual(): RegimeSkewCounterfactual {
    const closed = this.store.getState().baskets.filter((b) => b.status === "CLOSED");
    return regimeSkewCounterfactual(closed);
  }

  /** Every CLOSED basket, store order — feeds account-level merges that need per-basket
   *  closedAt/netPnl (e.g. the lane-performance timeline) rather than the aggregate summary. */
  getClosedBaskets(): ExecutorBasket[] {
    return this.store.getState().baskets.filter((b) => b.status === "CLOSED");
  }

  /** Single-flight tick: bank early winners, close due baskets, then consider opening a new one. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    // 2026-07-19 real-money audit fix (BUG 2): reset HERE, at the top, not unconditionally after
    // every phase runs. closeBasketsHittingProfitTarget()/closeDueBaskets() now catch and record
    // per-basket close failures internally (see their own per-basket try/catch) so ONE wedged
    // basket can no longer abort the whole tick — but that means a failure recorded mid-tick must
    // survive to the end of this function; a trailing unconditional `this.lastError = null` would
    // silently wipe it out the moment the rest of the tick completes without ALSO throwing.
    this.lastError = null;
    try {
      // 2026-07-19 real-money audit fix (BUG 1): retry any leg the basket-open abort path (or a
      // partial exit fill, see BUG 3) previously failed to flatten — see OrphanedLeg's doc
      // comment. Runs FIRST, every tick, for as long as it stays unresolved; a transient failure
      // must self-heal, not leave real exposure silently open forever.
      await this.retryOrphanedLegFlattens();
      await this.closeBasketsHittingProfitTarget();
      await this.closeDueBaskets();
      await this.ensureOpenBasketLeverage();
      // Restart-recovery (see recoverIncompleteBaskets' own doc comment): gated on isAllowed() —
      // the SAME master armed/testnet gate maybeOpenBasket itself requires — because resuming a
      // stuck placement means placing MORE real entry orders, exactly the same risk category as
      // opening a brand new basket. Deliberately NOT gated on entryHealth() (the rolling-evidence
      // quality gate for NEW signals): completing a basket this executor already committed capital
      // to is a safety operation (resolve dangling naked exposure), not a new-signal-quality
      // decision, so a "don't open new things" evidence verdict must not leave a stuck basket
      // stranded. While disarmed, a stuck basket is simply left exactly as-is (its real legs, if
      // any, stay fully visible via isBasketLive()-gated bookkeeping above and remain flattenable
      // by closeAllBasketsOrderly regardless of this gate) — never guessed at, never force-resumed.
      if (this.isAllowed()) {
        await this.recoverIncompleteBaskets();
      }
      const health = this.entryHealth();
      if (!health.allowed) {
        this.openHalted = health.reason ?? "rolling evidence gate blocked new baskets";
      } else if (this.isAllowed()) {
        await this.maybeOpenBasket();
      }
    } catch (error) {
      this.lastError = (error as Error).message ?? "tick failed";
    } finally {
      this.ticking = false;
    }
  }

  /** 2026-07-12 kill-switch response fix: orderly close of every OPEN basket via this executor's
   *  OWN closeBasket mechanics (reduce-only orders with the netting-aware -2022/stale-book
   *  handling) — NEVER a blanket symbol flatten, which would recreate the 2026-07-07
   *  netting-blind-closes incident by eating sibling hedges on shared symbols. Per-basket failures
   *  are collected, not fatal: the account-wide breaker must close as much as it can even when one
   *  basket wedges (that basket stays OPEN and keeps retrying on its own tick). */
  async closeAllBasketsOrderly(reason: string): Promise<{ closed: number; failed: number }> {
    const st = this.store.getState();
    // Broadened from the old status==="OPEN" check to isBasketLive() — a RESERVED/PLACING/
    // PARTIALLY_FILLED basket can already hold real, exchange-filled legs (or, for RESERVED with
    // zero legs, none at all), and the old single "OPEN" string already covered that exact
    // mid-placement window transiently; excluding it here would be a REGRESSION (a kill-switch that
    // can no longer see a mid-placement basket's real legs at all) rather than new behavior.
    // closeBasket() only ever iterates basket.legs (never basket.plan), so it is already safe to
    // call on a basket with fewer legs than planned — it just flattens whatever is real right now.
    const open = st.baskets.filter((b) => this.isBasketLive(b));
    let closed = 0;
    let failed = 0;
    for (const basket of open) {
      // 2026-08-04 fix (ground truth #8): this method runs OUTSIDE tick()'s own `this.ticking`
      // single-flight guard (app.ts's kill-switch handler calls it directly, independent of the
      // scheduled tick interval). If an in-flight placeRemainingLegs() call already claimed this
      // EXACT basket (see claimBasket), calling closeBasket() here concurrently would race:
      // closeBasket would finalize the basket CLOSED from whatever legs exist RIGHT NOW, and the
      // still-running placement loop would then push its NEXT leg's fill onto an object already
      // finalized CLOSED — silently overwriting that CLOSED status back to
      // COMPLETE/PARTIALLY_FILLED, with the leg closeBasket just exited now looking re-opened and
      // the newly-filled leg never accounted for by either path. Recording pendingKillReason
      // instead is safe and lossless: the in-flight loop's own between-legs recheck (see
      // placeRemainingLegs) reads this exact field and picks it up within, at most, one leg's
      // placeOrder round-trip — the kill/drain intent is deferred, never dropped.
      if (!this.claimBasket(basket.basketId)) {
        basket.pendingKillReason = reason;
        this.store.save();
        failed += 1; // not resolved by THIS call — the in-flight placement loop will finish the job
        continue;
      }
      try {
        // 2026-08-04 (review round 1 fix): reconcile any ambiguous PLACING plan entry BEFORE
        // closeBasket runs — see reconcileAmbiguousLegBeforeClose's own doc comment. Without this,
        // a basket reached by the kill-switch before recoverIncompleteBaskets ever got a chance to
        // (the cross-sectional tick's own first run is deliberately delayed 90-150s after process
        // start, but nothing delays a kill-switch trip) would have its ambiguous leg's real,
        // possibly-already-filled pre-crash order silently dropped: closeBasket only ever iterates
        // basket.legs, never basket.plan, so that fill would never become an ExecutorLeg at all, on
        // a basket about to be marked CLOSED — permanently outside every future recovery pass.
        await this.reconcileAmbiguousLegBeforeClose(basket);
        await this.closeBasket(basket, reason);
        if (basket.status === "CLOSED" || basket.status === "ABORTED") closed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        this.lastError = (error as Error).message ?? "kill-switch basket close failed";
      } finally {
        this.releaseBasket(basket.basketId);
      }
    }
    return { closed, failed };
  }

  /**
   * 2026-08-04 (review round 1 fix): reconciles basket.plan's one possibly-ambiguous entry (the
   * plan entry at index basket.legs.length, if its OWN status is "PLACING" — see PlannedLeg's own
   * doc comment) against the real exchange, adopting a genuine fill if one is found — BEFORE
   * closeBasket ever runs. closeBasket only ever iterates basket.legs, never basket.plan, so
   * without this a genuinely-filled pre-crash order sitting in "PLACING" limbo would be silently
   * finalized as gone: no ExecutorLeg ever created for it, on a basket closeBasket is about to mark
   * CLOSED — permanently outside every future recovery pass's purview (recoverIncompleteBaskets
   * only ever revisits RESERVED/PLACING/PARTIALLY_FILLED baskets) and outside the orphaned-leg
   * retry mechanism (which only ever tracks a leg closeBasket/flattenFilledLegs already knows
   * about in basket.legs). Needed specifically because closeAllBasketsOrderly (unlike
   * closeDueBaskets/closeBasketsHittingProfitTarget, both strictly COMPLETE-gated — a COMPLETE
   * basket's plan is by construction all-FILLED, never ambiguous) can reach a crash-persisted
   * basket BEFORE recoverIncompleteBaskets ever gets a chance to reconcile it: the cross-sectional
   * tick's own first run after a restart is deliberately delayed 90-150s (see app.ts's
   * setTimeout(execTick, 90_000) and siblings), but nothing delays a kill-switch trip, which is
   * driven by an entirely independent, typically much-faster-cadence engine tick.
   *
   * This is the SAME query-then-adopt-if-FILLED logic recoverIncompleteBaskets uses against
   * reconcilePlannedLeg — deliberately duplicated here rather than having recoverIncompleteBaskets
   * call this shared helper too, to keep this fix's diff isolated and that already-tested method's
   * internals untouched; both sites are small, and reconcilePlannedLeg itself remains the single
   * source of truth for the actual exchange-query/classification logic.
   *
   * INCONCLUSIVE: nothing to adopt, reservation left untouched (never guess) — closeBasket proceeds
   * exactly as before this fix, flattening whatever is real right now. NOT_PLACED: nothing to
   * adopt either, but — unlike recoverIncompleteBaskets' own NOT_PLACED handling, which reuses the
   * SAME reservation to place the leg fresh — this basket is being killed, not resumed, so the
   * reservation is released immediately rather than left for the coordinator's own staleness sweep.
   * Never throws (reconcilePlannedLeg's own contract), so a failed reconciliation attempt never
   * blocks the close it precedes.
   *
   * 2026-08-05 (review round 2 fix): the ambiguous entry at `idx` was the ONLY plan entry this
   * method ever resolved. For a basket with more than one un-filled leg remaining (a 3+-leg basket
   * killed with two or more legs never attempted, or — the more common case — a RESERVED basket
   * with an all-"PENDING" plan killed before its very first leg was ever attempted, so `idx` itself
   * is never even "PLACING") every entry strictly after `idx`, and `idx` itself whenever it was
   * never "PLACING" to begin with, fell straight through to closeBasket() untouched: closeBasket
   * only ever iterates basket.legs, never basket.plan, so those entries' reservationIds stayed
   * "RESERVED" forever from THIS basket's own perspective — closed, terminal, never revisited by
   * recoverIncompleteBaskets again — silently leaking real reserved capacity until (if ever) the
   * coordinator's OWN staleness sweep independently rediscovers and releases them. That is exactly
   * the fallback this method's own NOT_PLACED branch above was written to avoid for the one entry
   * it handles ("released immediately... rather than left for the coordinator's own staleness
   * sweep") — applied inconsistently to the rest of an identical, equally-never-attempted tail.
   * Every entry from `sweepFrom` onward below has never been attempted by ANY process (placement is
   * strictly sequential — only `idx` can ever be genuinely mid-flight), so releasing them now is
   * exactly as unambiguous as the NOT_PLACED branch's own release, never a guess.
   */
  private async reconcileAmbiguousLegBeforeClose(basket: ExecutorBasket): Promise<void> {
    const plan = basket.plan;
    if (!Array.isArray(plan)) return;
    const idx = basket.legs.length;
    if (idx >= plan.length) return;
    const ambiguous = plan[idx]!;
    // First index NOT resolved by this method's own idx-specific handling below — starts at `idx`
    // (safe to sweep immediately) and only advances past it when `idx` itself needed its own
    // dedicated handling (it was genuinely "PLACING" — adopted, marked FAILED, or, for INCONCLUSIVE,
    // deliberately left untouched and excluded from the generic sweep either way).
    let sweepFrom = idx;
    if (ambiguous.status === "PLACING") {
      sweepFrom = idx + 1;
      const resolution = await this.reconcilePlannedLeg(ambiguous.symbol, ambiguous.entryClientOrderId);
      if (resolution.outcome === "NOT_PLACED") {
        // Unlike recoverIncompleteBaskets' own NOT_PLACED handling (which falls through to placing
        // this leg fresh, reusing the SAME reservation), this basket is being KILLED, not resumed —
        // the leg will never be placed. Release the reservation NOW instead of leaving it RESERVED
        // for the coordinator's own (bounded, but non-zero) staleness sweep to eventually catch —
        // same unambiguous-only-release discipline as placeRemainingLegsLocked's own catch block:
        // this IS unambiguous (the exchange confirmed a terminal non-fill status, or that no order
        // with this clientOrderId ever reached it).
        ambiguous.status = "FAILED";
        ambiguous.failureReason = "BASKET_CLOSED_BEFORE_RECOVERY_RECONCILED_NOT_PLACED";
        if (ambiguous.reservationId) {
          this.releaseExposureReservationFn(ambiguous.reservationId, "BASKET_CLOSED_BEFORE_RECOVERY:NOT_PLACED");
        }
      } else if (resolution.outcome === "FILLED") {
        if (ambiguous.reservationId) {
          this.commitExposureReservationFn(ambiguous.reservationId, { qty: resolution.qty, avgPrice: resolution.avgPrice });
        }
        basket.legs.push({
          symbol: ambiguous.symbol,
          side: ambiguous.side,
          qty: resolution.qty,
          entryPrice: resolution.avgPrice,
          entryOrderId: resolution.orderId,
          entryPriceConfirmed: true,
          exitPrice: null,
          exitOrderId: null,
          exitPriceConfirmed: null,
          planIndex: idx,
        });
        ambiguous.status = "FILLED";
        basket.status = basket.legs.length === plan.length ? "COMPLETE" : "PARTIALLY_FILLED";
      }
      // else INCONCLUSIVE — never guess, leave `ambiguous` (idx) completely untouched; sweepFrom
      // already excludes it from the generic release pass below.
    }
    // Every remaining plan entry has never been attempted by any process — release it now (see this
    // method's own 2026-08-05 doc-comment addendum above). No-op when sweepFrom === plan.length
    // (the common 2-leg-basket case: the ambiguous entry above was the last one, nothing left).
    this.markRemainingNeverAttempted(basket, sweepFrom, "BASKET_CLOSED_BEFORE_RECOVERY:NEVER_ATTEMPTED");
    this.store.save();
  }

  /**
   * Proactively close any OPEN basket whose live net (cost-adjusted) return on deployed capital
   * has already reached TP_NET_RETURN, instead of always waiting for the fixed HORIZON. Uses
   * markPrice from getPositions() (a market-level field, safe to reuse even if another concurrent
   * basket shares the same symbol) against THIS basket's own recorded entry prices/qty — never the
   * exchange's aggregated unRealizedProfit, which would blend PnL across baskets sharing a symbol.
   */
  private async closeBasketsHittingProfitTarget(): Promise<void> {
    const st = this.store.getState();
    // Strict COMPLETE-only (not the broader isBasketLive()) — TP math below assumes the FULL
    // intended hedge is present (see the longLegs/shortLegs skip immediately inside the loop). A
    // RESERVED/PLACING/PARTIALLY_FILLED basket is mid-open, not a settled hedge to score; letting
    // recoverIncompleteBaskets() finish (or abort) it first is the correct path, not a live TP read
    // against an incomplete position.
    const openBaskets = st.baskets.filter((b) => b.status === "COMPLETE");
    if (openBaskets.length === 0) return;

    const positions = await this.sharedGetPositions();
    const markBySymbol = new Map<string, number>();
    for (const p of positions) {
      if (Number.isFinite(p.markPrice) && p.markPrice > 0) markBySymbol.set(p.symbol, p.markPrice);
    }

    let stamped = false;
    for (const basket of openBaskets) {
      const longLegs = basket.legs.filter((l) => l.side === "LONG");
      const shortLegs = basket.legs.filter((l) => l.side === "SHORT");
      // Bug fix: a basket with real legs on only ONE side (e.g. a legacy pre-migration record — see
      // CrossSectionalExecutorStore._load() — or any other lopsided-but-COMPLETE edge case) is not
      // an actual hedge. The two-sided TP formula below defaults an empty side's mean return to 0
      // and silently scores a "hedge" return off a single real leg divided by 2 — a wrong number
      // that could wrongly trigger, or wrongly withhold, a profit-target close. Skip it entirely
      // rather than invent a new lopsided-basket formula (that would be strategy-tuning, not a
      // safety fix) — it still has its own HORIZON exit (closeBasket doesn't care about leg-count
      // symmetry when actually settling) as the safety valve.
      if (longLegs.length === 0 || shortLegs.length === 0) continue;
      // 2026-08-05 (review round 3 fix): the check above only catches a FULLY one-sided basket.
      // placeRemainingLegsLocked's hedge-vs-rollback decision (ground truth item (d)) can now keep a
      // basket COMPLETE with BOTH sides non-empty yet fewer legs than its own plan — e.g. a 3-long/
      // 3-short plan whose 5th leg (2nd short) fails keeps 3 long + 1 short open as a "genuine,
      // already-balanced hedge" per that method's own check (longLegs.length>0 && shortLegs.length>0
      // — the SAME test as the line above, deliberately reused per that fix's own doc comment). That
      // check only proves "not naked", not "notionally balanced": this executor sizes every leg at
      // the SAME fixed legUsd regardless of side (see maybeOpenBasket's sizing loop, no per-side
      // capital split), so 3 long legs vs. 1 short leg is genuinely ~75%/25% notional-tilted, not the
      // 50/50 split grossReturn below assumes (mirroring legReturnContribution's equal-notional-per-
      // side convention) — that assumption holds for a basket matching its own FULL plan (symmetric
      // or intentionally regime-skewed alike), not for one reduced by an ACCIDENT of wherever a
      // mid-open failure struck. Scoring it anyway would misprice the position's real blended return
      // and could wrongly trigger, or wrongly withhold, a profit-bank close on a basket that isn't
      // the hedge this formula assumes. Same "skip, don't invent a new formula" fix as immediately
      // above; `Array.isArray` guards the handful of close-path-only test fixtures that seed a
      // COMPLETE basket with no `plan` at all (see ExecutorBasket.plan's own doc comment) — those
      // fall through to the pre-existing behavior, unchanged. This basket still has its own HORIZON
      // exit (closeBasket's PnL is summed per-leg in real dollars — see its own `gross` accumulator
      // — and never assumes a 50/50 split) as the safety valve.
      if (Array.isArray(basket.plan) && basket.legs.length !== basket.plan.length) continue;
      const legReturn = (leg: ExecutorLeg, direction: "LONG" | "SHORT"): number | null => {
        const mark = markBySymbol.get(leg.symbol);
        if (mark === undefined || !(leg.entryPrice > 0)) return null;
        return direction === "LONG" ? (mark - leg.entryPrice) / leg.entryPrice : (leg.entryPrice - mark) / leg.entryPrice;
      };
      const longReturns = longLegs.map((l) => legReturn(l, "LONG"));
      const shortReturns = shortLegs.map((l) => legReturn(l, "SHORT"));
      if (longReturns.some((r) => r === null) || shortReturns.some((r) => r === null)) continue; // incomplete mark data — skip this tick, never force a decision on partial info

      const meanLong = longReturns.length ? longReturns.reduce((a, b) => a! + b!, 0)! / longReturns.length : 0;
      const meanShort = shortReturns.length ? shortReturns.reduce((a, b) => a! + b!, 0)! / shortReturns.length : 0;
      const grossReturn = meanLong / 2 + meanShort / 2; // mirrors legReturnContribution's equal-notional formula
      const costReturn = CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;
      const netReturn = grossReturn - costReturn;
      basket.lastNetReturn = netReturn;
      basket.lastNetAt = this.nowIso();
      stamped = true;
      const threshold = this.respectSignalRiskGeometry
        ? basket.takeProfitReturn ?? Number.POSITIVE_INFINITY
        : TP_NET_RETURN();
      if (netReturn >= threshold) {
        // 2026-07-19 real-money audit fix (BUG 2): isolate this basket's close attempt so one
        // wedged basket (repeated throw, e.g. a persistent margin/rate-limit condition) cannot
        // prevent OTHER healthy baskets in this same loop from being processed this tick — mirrors
        // closeAllBasketsOrderly's own per-basket try/catch isolation above.
        try {
          await this.closeBasket(basket, "PROFIT_BANK");
        } catch (error) {
          this.lastError = (error as Error).message ?? "profit-bank close failed";
        }
      } else if (
        this.respectSignalRiskGeometry &&
        basket.stopLossReturn !== undefined &&
        basket.stopLossReturn !== null &&
        netReturn <= -basket.stopLossReturn
      ) {
        try {
          await this.closeBasket(basket, "SIGNAL_STOP");
        } catch (error) {
          this.lastError = (error as Error).message ?? "signal-stop close failed";
        }
      }
    }
    if (stamped) this.store.save(); // persist the TP-gap stamps for the dashboard
  }

  /** Public surface for sibling instances to sum THIS instance's daily realized P&L — see
   *  CrossSectionalExecutorOptions.siblingDailyRealizedUsd's doc comment. */
  getDailyRealizedUsd(nowIso: string): number {
    return this.dailyRealizedUsd(nowIso);
  }

  /** Realized basket P&L for the current UTC day — feeds the basket-level safety breaker. */
  private dailyRealizedUsd(nowIso: string): number {
    const day = nowIso.slice(0, 10);
    let sum = 0;
    for (const b of this.store.getState().baskets) {
      if (b.status === "CLOSED" && b.closedAt && b.closedAt.slice(0, 10) === day && b.netPnlUsd !== null) {
        sum += b.netPnlUsd;
      }
    }
    return sum;
  }

  private async ensureOpenBasketLeverage(): Promise<void> {
    const leverage = this.leverageFn();
    const symbols = new Set<string>();
    for (const basket of this.store.getState().baskets) {
      if (!this.isBasketLive(basket)) continue;
      for (const leg of basket.legs) symbols.add(leg.symbol);
    }
    for (const symbol of symbols) {
      try {
        await this.client.setLeverage(symbol, leverage);
      } catch {
        // best-effort (already set / exchange refused while a close is racing)
      }
    }
  }

  private async closeDueBaskets(): Promise<void> {
    const st = this.store.getState();
    const nowMs = new Date(this.nowIso()).getTime();
    for (const basket of st.baskets) {
      // Strict COMPLETE-only, same rationale as closeBasketsHittingProfitTarget above: a basket
      // still mid-open (RESERVED/PLACING/PARTIALLY_FILLED) reaching its horizon must not be closed
      // as though its CURRENT (possibly partial) leg set were the whole intended hedge — that is
      // exactly the CORE GAP this task closes. recoverIncompleteBaskets() gets first chance to
      // finish or abort it; if it's genuinely stuck (e.g. persistently INCONCLUSIVE reconciliation),
      // it now stays visibly incomplete past its horizon instead of being silently mis-closed.
      if (basket.status !== "COMPLETE") continue;
      if (nowMs < basket.closesAtMs) continue;
      // 2026-07-19 real-money audit fix (BUG 2): same per-basket isolation as
      // closeBasketsHittingProfitTarget above — one basket's HORIZON close failing must not block
      // every OTHER due basket from being closed this tick.
      try {
        await this.closeBasket(basket, "HORIZON");
      } catch (error) {
        this.lastError = (error as Error).message ?? "horizon close failed";
      }
    }
  }

  /** Un-exited qty that OTHER open baskets hold on this symbol on the OPPOSITE side. When this
   *  covers a leg's qty, closing the leg without reduceOnly is pure cross-basket bookkeeping:
   *  Binance nets per symbol, so the "close" order just transfers the exposure to the sibling
   *  baskets that legitimately own the other side — it can never create exposure the executor's
   *  own books don't account for.
   *
   *  2026-07-11 real-money audit fix: FILTERED/TREND/MIXED are 3 SEPARATE executor instances on
   *  the SAME netted account — this used to only scan THIS instance's own store, so a same-symbol
   *  opposite-side leg owned by a sibling instance was invisible. Now also includes siblingOpenLegs()
   *  (injected in app.ts as the other 2 instances' getOpenUnexitedLegs()). */
  private siblingOppositeUnexitedQty(basket: ExecutorBasket, symbol: string, side: "LONG" | "SHORT"): number {
    let qty = 0;
    for (const other of this.store.getState().baskets) {
      if (other === basket || !this.isBasketLive(other)) continue;
      for (const leg of other.legs) {
        if (leg.symbol === symbol && leg.side !== side && leg.exitOrderId === null) qty += leg.qty;
      }
    }
    for (const leg of this.siblingOpenLegs()) {
      if (leg.symbol === symbol && leg.side !== side) qty += leg.qty;
    }
    return qty;
  }

  private async closeBasket(basket: ExecutorBasket, reason: string): Promise<void> {
    const failures: string[] = [];
    let staleBookReconciled = false;
    for (const leg of basket.legs) {
      if (leg.exitOrderId !== null) continue; // already closed (retry path)
      const exitSide = leg.side === "LONG" ? "SELL" : "BUY";
      // reduceOnly is the default guard against over-closing stale basket state — but with
      // overlapping baskets the NETTED account position can carry the opposite sign (e.g. this
      // basket long SOL while two siblings are short SOL ⇒ account net short), and Binance then
      // rejects the reduce-only close with -2022, wedging the basket half-closed forever
      // (2026-07-07: testnet basket xb-mr7zdpiz stuck exactly this way for hours). Drop the flag
      // ONLY when sibling baskets' un-exited opposite exposure fully covers this leg — the one
      // case where a plain market close is provably just bookkeeping between our own baskets.
      const reduceOnly = this.siblingOppositeUnexitedQty(basket, leg.symbol, leg.side) < leg.qty - 1e-9;
      try {
        const order = await this.client.placeOrder({
          symbol: leg.symbol,
          side: exitSide,
          type: "MARKET",
          quantity: leg.qty,
          ...(reduceOnly ? { reduceOnly: true } : {}),
          newClientOrderId: `xsec-${basket.basketId.slice(-12)}-x${basket.legs.indexOf(leg)}`,
        });
        const resolved = await this.resolveFillPrice(leg.symbol, order.orderId, order.avgPrice, leg.entryPrice);
        // 2026-07-19 real-money audit fix (BUG 3): a genuine partial MARKET fill on the close
        // order leaves a real, un-closed remainder on the exchange — recording this leg as fully
        // exited would silently understate the account's true exposure. If executedQty
        // meaningfully undershoots the requested qty, only the FILLED portion is booked as
        // closed on this leg (at the confirmed fill price); the un-filled remainder is tracked
        // via the SAME orphaned-leg retry mechanism as BUG 1 (this basket stays consistent —
        // exitOrderId is still set, so the basket's own lifecycle isn't blocked — while the
        // residual keeps getting flattened automatically every tick until it too resolves).
        // 2026-07-19 real-money audit follow-up: mirror the entry-leg guard's `> 0` check exactly
        // — Binance's synchronous order ACK can come back with avgPrice=0/executedQty=0 even
        // though the order fully filled moments later (this file's own resolveFillPrice already
        // documents and works around this for price; executedQty needs the identical treatment).
        // Without the `> 0` guard, EVERY unconfirmed-at-ACK exit (a routine, frequent occurrence,
        // not an edge case) would be misread as a 100% shortfall and spuriously orphaned, even
        // though the leg is genuinely fully closed — and a retry of that bogus orphan could
        // succeed against a SIBLING executor's real position on the same symbol (the exact
        // "netting-blind-closes" bug class this codebase already had to fix once, engine-wide).
        const executedQty = Number.isFinite(order.executedQty) && order.executedQty > 0 ? order.executedQty : leg.qty;
        const shortfall = leg.qty - executedQty;
        if (shortfall > 1e-9) {
          this.recordOrphanedLeg(
            basket,
            { ...leg, qty: shortfall },
            new Error(`partial close fill: requested ${leg.qty}, executed ${executedQty} — residual ${shortfall} still open`),
          );
          leg.qty = executedQty > 0 ? executedQty : leg.qty;
        }
        leg.exitOrderId = order.orderId;
        leg.exitPrice = resolved.price;
        leg.exitPriceConfirmed = resolved.confirmed;
      } catch (error) {
        const message = (error as Error).message;
        if (reduceOnly && /(?:code\s*)?-2022|ReduceOnly Order is rejected/i.test(message)) {
          try {
            const positions = await this.client.getPositions(leg.symbol);
            const positionAmt = positions.find((position) => position.symbol === leg.symbol)?.positionAmt ?? 0;
            const expectedSign = leg.side === "LONG" ? 1 : -1;
            // The exchange no longer carries enough same-side quantity for this book leg. Retrying
            // without reduceOnly would CREATE opposite exposure. Reconcile as ABORTED (no invented
            // P&L), continue flattening every other real leg, and remove the stale claim safely.
            if (Math.abs(positionAmt) <= 1e-9 || Math.sign(positionAmt) !== expectedSign) {
              leg.exitOrderId = "POSITION_ALREADY_FLAT";
              leg.exitPrice = null;
              leg.exitPriceConfirmed = false;
              staleBookReconciled = true;
              this.store.save();
              continue;
            }
          } catch {
            // Position lookup failed: preserve the original error/retry behavior below.
          }
        }
        // Keep attempting the REMAINING legs — aborting mid-loop leaves more naked exposure
        // stuck open than closing what we can. The basket stays OPEN and retries next tick.
        failures.push(`${leg.symbol}: ${message}`);
      }
      this.store.save(); // persist per leg so a crash/retry mid-close can resume
    }
    if (failures.length > 0) {
      throw new Error(`basket ${basket.basketId} close incomplete, ${failures.length} leg(s) failed: ${failures[0]}`);
    }
    if (staleBookReconciled) {
      basket.status = "ABORTED";
      basket.closedAt = this.nowIso();
      basket.closeReason = `RECONCILED_POSITION_ALREADY_FLAT:${reason}`;
      basket.grossPnlUsd = null;
      basket.feeEstimateUsd = null;
      basket.netPnlUsd = null;
      this.store.save();
      return;
    }
    // Finalize P&L from the STORED per-leg prices, not a loop-local accumulator: on a retry after
    // a partial close, the already-exited legs are skipped above, and the old accumulator silently
    // EXCLUDED them from the basket's final P&L.
    let gross = 0;
    let notionalTouched = 0;
    for (const leg of basket.legs) {
      const exit = leg.exitPrice ?? leg.entryPrice;
      const dir = leg.side === "LONG" ? 1 : -1;
      gross += dir * (exit - leg.entryPrice) * leg.qty;
      notionalTouched += leg.entryPrice * leg.qty + exit * leg.qty;
    }
    // 2026-07-12 fee-recording fix: prefer REAL exchange commissions over the flat TAKER_FEE_RATE
    // estimate — one getUserTrades page per unique symbol, filtered to THIS basket's own entry/exit
    // orderIds (correct on the shared netted account, same convention as every other settle path).
    // The flat estimate remains the fallback when any fetch fails (the basket must still finish
    // closing bookkeeping-wise this tick), and when no trade matched at all (paranoia: an empty
    // real sum on legs that demonstrably filled means the page missed them, not that they were free).
    let realFees: number | null = 0;
    let sawAnyTrade = false;
    const orderIdsBySymbol = new Map<string, Set<string>>();
    // 2026-07-27 (RECORDING-ONLY): role lookup for the per-fill recorder. Built from the SAME leg
    // walk that builds orderIdsBySymbol, purely so a matched row can be labelled ENTRY vs EXIT.
    // KEYED `symbol|orderId`, deliberately matching orderIdsBySymbol's own scoping rather than a
    // flat account-wide map: the surrounding code has always assumed order ids are only unique
    // WITHIN a symbol, and a flat map would let one leg's exitOrderId overwrite another leg's
    // entryOrderId and mislabel both symbols' fills (2026-07-27 review finding). A row whose key is
    // in neither (impossible while `ids.has` gated it) records as "UNKNOWN" rather than being
    // silently mislabelled.
    const roleBySymbolOrderId = new Map<string, ExecutionFillRole>();
    const roleKey = (symbol: string, orderId: string): string => `${symbol}|${orderId}`;
    for (const leg of basket.legs) {
      const ids = orderIdsBySymbol.get(leg.symbol) ?? new Set<string>();
      ids.add(leg.entryOrderId);
      roleBySymbolOrderId.set(roleKey(leg.symbol, leg.entryOrderId), "ENTRY");
      if (leg.exitOrderId !== null && leg.exitOrderId !== "POSITION_ALREADY_FLAT") {
        ids.add(leg.exitOrderId);
        roleBySymbolOrderId.set(roleKey(leg.symbol, leg.exitOrderId), "EXIT");
      }
      orderIdsBySymbol.set(leg.symbol, ids);
    }
    // Per-fill rows for the recorder, collected from the pages this loop ALREADY fetches — no extra
    // exchange call, no extra latency, and the arithmetic below is untouched.
    const matchedFills: ExecutionFill[] = [];
    // RECORDING-ONLY. True as soon as ANY per-symbol page came back FULL, i.e. Binance may have cut
    // rows off its edge. Never consulted by the fee arithmetic below — only by fetchComplete.
    let anyPageSaturated = false;
    for (const [symbol, ids] of orderIdsBySymbol) {
      try {
        const trades = await this.client.getUserTrades(symbol, { startTime: new Date(basket.openedAt).getTime(), limit: USER_TRADES_PAGE_LIMIT });
        if (Array.isArray(trades) && trades.length >= USER_TRADES_PAGE_LIMIT) anyPageSaturated = true;
        for (const t of trades) {
          if (ids.has(t.orderId)) {
            realFees = (realFees ?? 0) + t.commission;
            sawAnyTrade = true;
            try {
              matchedFills.push(fillFromUserTrade(t, roleBySymbolOrderId.get(roleKey(symbol, t.orderId)) ?? "UNKNOWN"));
            } catch {
              // recording must never disturb the fee sum this loop exists for
            }
          }
        }
      } catch {
        realFees = null;
        break;
      }
    }
    const feeIsExchangeSourced = realFees !== null && sawAnyTrade;
    // `feeIsExchangeSourced` already implies `realFees !== null`, but TS cannot narrow through it:
    // `realFees` is a `let` reassigned inside the loop above, which defeats aliased-condition
    // narrowing. The redundant check is for the type checker only and changes no behaviour.
    const fees = feeIsExchangeSourced && realFees !== null ? realFees : notionalTouched * TAKER_FEE_RATE;
    basket.status = "CLOSED";
    basket.closedAt = this.nowIso();
    basket.closeReason = reason;
    basket.grossPnlUsd = gross;
    basket.feeEstimateUsd = fees;
    // Provenance recorded alongside the number (see ExecutorBasket.feeSource): which arm of the
    // ternary above produced `fees` was previously discarded, leaving a real exchange commission
    // and a flat TAKER_FEE_RATE model indistinguishable in the same field.
    basket.feeSource = feeIsExchangeSourced ? "EXCHANGE" : "ESTIMATE_TAKER_FLAT";
    basket.netPnlUsd = gross - fees;
    // 2026-07-11: lastNetReturn/lastNetAt were previously only ever stamped by the periodic
    // mark-price check in closeBasketsHittingProfitTarget() — for a HORIZON (or any other) close,
    // that field was left frozen at whatever the last mark-price tick happened to show, which can
    // disagree in SIGN with the actual settled outcome once real exit fills come in (confirmed
    // live: basket xb-mras6v04 settled netPnlUsd +$0.73 but lastNetReturn was still stamped -0.13%
    // from a stale pre-close mark-price estimate). Recompute from the FINAL exit prices here so the
    // field always reflects the true settled outcome once a basket closes, using the same blend
    // methodology as the mark-price estimate (mean long % return / 2 + mean short % return / 2,
    // minus roundtrip cost) — just fed with real fills instead of a mid-flight mark.
    const finalLongLegs = basket.legs.filter((l) => l.side === "LONG");
    const finalShortLegs = basket.legs.filter((l) => l.side === "SHORT");
    const finalLegReturn = (l: ExecutorLeg, direction: "LONG" | "SHORT"): number => {
      const exit = l.exitPrice ?? l.entryPrice;
      return direction === "LONG" ? (exit - l.entryPrice) / l.entryPrice : (l.entryPrice - exit) / l.entryPrice;
    };
    const finalMeanLong = finalLongLegs.length
      ? finalLongLegs.reduce((sum, l) => sum + finalLegReturn(l, "LONG"), 0) / finalLongLegs.length
      : 0;
    const finalMeanShort = finalShortLegs.length
      ? finalShortLegs.reduce((sum, l) => sum + finalLegReturn(l, "SHORT"), 0) / finalShortLegs.length
      : 0;
    basket.lastNetReturn = finalMeanLong / 2 + finalMeanShort / 2 - CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;
    basket.lastNetAt = basket.closedAt;
    this.store.save();
    this.recordCortexRealAttribution(basket);
    // Per-fill execution record (2026-07-27, report-only, fail-safe — see its doc comment). Rows
    // come from the getUserTrades pages the fee sum above already fetched. `fetchComplete` requires
    // BOTH that no per-symbol fetch threw (realFees !== null) AND that no page came back saturated:
    // a full limit:1000 page may have cut this basket's own rows off its edge, and a short fill list
    // that claims completeness is the same silent understatement this store exists to eliminate
    // (2026-07-27 review finding — `realFees !== null` alone detects only a THROWN fetch). A basket
    // whose fetch threw on its FIRST symbol records nothing at all (empty list ⇒ no-op), which is
    // honest — no record beats a record that reads as "these were all the fills".
    this.recordExecutionFills(basket, matchedFills, realFees !== null && !anyPageSaturated);
  }

  /** Per-fill execution record for one fully closed basket (2026-07-27, report-only). Wrapped so a
   *  failure can NEVER affect settlement or trading. Recording an EMPTY fill list is deliberately a
   *  no-op — see recordFills' own contract. */
  private recordExecutionFills(basket: ExecutorBasket, fills: ExecutionFill[], fetchComplete: boolean): void {
    try {
      const recorder = this.executionFillRecorder;
      if (!recorder || !Array.isArray(fills) || fills.length === 0) return;
      const closedMs = Date.parse(basket.closedAt ?? this.nowIso());
      recorder.recordFills({
        recordId: `xsec:${this.laneId}:${basket.basketId}`, // same identity as CORTEX attribution
        source: "xsec",
        laneId: this.laneId,
        // A basket spans many symbols; join them the same way recordCortexRealAttribution does so
        // the two stores describe the same close identically. Each FILL carries its own symbol.
        symbol: basket.legs.map((leg) => leg.symbol).join("+"),
        closedAtMs: Number.isFinite(closedMs) ? closedMs : Date.now(),
        fetchComplete,
        fills,
      });
    } catch {
      // report-only bookkeeping — a failure here must NEVER affect trading
    }
  }

  /**
   * 2026-08-04 (critical latch, ground truth item (c)): true while at least one OrphanedLeg is
   * unresolved — REAL, still-open exchange exposure this executor's normal HORIZON/PROFIT_BANK/
   * kill-switch close paths can no longer reach on their own (see OrphanedLeg's own doc comment
   * for its two origins: an abort-flatten that itself failed, or a partial-exit-fill remainder).
   * Deliberately reuses the EXISTING OrphanedLeg list — no new status/field/parallel bookkeeping —
   * both origins leave real, unaccounted-for exposure, which is exactly the condition under which
   * taking on MORE new risk is unsafe. Consulted by maybeOpenBasket (blocks a brand-new basket) AND,
   * as of 2026-08-04 (review round 1 fix), by recoverIncompleteBaskets (blocks resuming placement on
   * a plan entry that has never been attempted by any process — the same new-risk order placement
   * under a different call path; see that method's own doc comment) — every exposure-REDUCING or
   * purely-recording path (closeBasket/closeDueBaskets/closeBasketsHittingProfitTarget/
   * closeAllBasketsOrderly/retryOrphanedLegFlattens/ensureOpenBasketLeverage, and
   * recoverIncompleteBaskets' own ambiguous-leg reconciliation/adoption) reads none of this, so
   * "block NEW real-money order placement, exposure reduction/bookkeeping unaffected" falls out for
   * free. Self-healing: tick() runs retryOrphanedLegFlattens() every tick BEFORE either consumer —
   * the latch clears itself the instant the real exchange confirms the exposure is gone, never on a
   * guess or a timer.
   */
  private hasUnresolvedOrphanedExposure(): boolean {
    return (this.store.getState().orphanedLegs ?? []).length > 0;
  }

  private async maybeOpenBasket(): Promise<void> {
    if (this.hasUnresolvedOrphanedExposure()) {
      this.openHalted =
        "CRITICAL: unresolved orphaned exchange exposure from a rollback/flatten failure — new baskets blocked until every orphaned leg clears (see getStatus().orphanedLegs); existing baskets keep closing normally.";
      return;
    }
    const st = this.store.getState();
    // Basket safety breaker: halt NEW opens after a bad realized day; never touches open baskets.
    const lossLimit = this.dailyMaxLossUsdFn();
    if (lossLimit > 0) {
      const nowIso = this.nowIso();
      // 2026-07-12 fix: XSEC_DAILY_MAX_LOSS_USD is ONE shared ceiling across all 3 sibling
      // instances (FILTERED/TREND/MIXED, same netted account) — include their realized P&L too,
      // or the REAL combined daily loss could reach up to 3x this configured limit before any
      // single instance's own check ever halted.
      const dayRealized = this.dailyRealizedUsd(nowIso) + this.siblingDailyRealizedUsd(nowIso);
      if (dayRealized <= -lossLimit) {
        this.openHalted = `daily basket loss breaker: combined realized ${dayRealized.toFixed(2)} USDT ≤ -${lossLimit} — new opens halted until UTC midnight (open baskets keep their own exits)`;
        return;
      }
    }
    this.openHalted = null;
    // Broadened to isBasketLive(): a RESERVED/PLACING/PARTIALLY_FILLED basket (stuck mid-open,
    // e.g. awaiting restart-recovery reconciliation) still occupies a real slot — it must keep
    // counting against the cap exactly as a fully-open basket already did before this enum grew
    // granularity, or a stuck basket would silently let MORE concurrent baskets open than intended.
    if (st.baskets.filter((b) => this.isBasketLive(b)).length >= this.maxOpenBasketsFn()) return;

    const nowMs = new Date(this.nowIso()).getTime();
    // Newest FRESH, still-OPEN signal of the target variant we haven't executed yet.
    // Default FILTERED: symbol-filtered baskets whose allow/blocklists auto-update from
    // measured per-leg returns (see deriveAdaptiveSymbolFilters).
    const targetVariant = this.targetVariant;
    const candidates = this.signalStore.all
      .filter(
        (o: CrossSectionalObservation) =>
          o.status === "OPEN" &&
          (o.variant ?? "RAW") === targetVariant &&
          o.openedAtMs > st.lastSeenSignalMs &&
          nowMs - o.openedAtMs <= this.maxSignalAgeMsFn(),
      )
      .sort((a: CrossSectionalObservation, b: CrossSectionalObservation) => b.openedAtMs - a.openedAtMs);
    const signal = candidates[0];
    if (!signal) return;

    // Watermark BEFORE placing orders: a failed basket must not retry forever.
    st.lastSeenSignalMs = signal.openedAtMs;
    this.store.save();

    const filters = await this.client.getExchangeFilters();
    const legUsd = this.effectiveLegUsd();
    if (!(legUsd > 0)) return;
    const notionalCap = this.maxNotionalPerSymbolAcrossLanesFn();
    // 2026-07-12 fix: derived only from the signal's timestamp, with no variant component — the
    // 3 CrossSectionalExecutor instances (FILTERED/TREND/MIXED) each have their OWN store file
    // but share ONE netted Binance account, and newClientOrderId is built from this id's LAST 12
    // chars. Two instances opening baskets whose signals share the same openedAtMs would collide
    // on newClientOrderId, and Binance's per-account idempotency would treat the second instance's
    // real order as a duplicate of the first's. The variant suffix is appended at the END (not
    // the middle) so it always survives basketId.slice(-12) regardless of the timestamp's length.
    // Hoisted here (previously computed only inside the basket literal below) so every leg's
    // exposure reservation in the sizing loop can carry the basketId that groups its sibling leg
    // reservations — account-exposure-coordinator.ts's ExposureReservation.basketId.
    const basketId = `xb-${signal.openedAtMs.toString(36)}-${this.idNamespace}`;
    // Computed ONCE here, before the per-leg loop below — not once per leg. Avoids re-reading the
    // campaign file up to N times for an N-leg basket, and guarantees every leg of THIS basket-open
    // attempt is evaluated against the identical loaded campaign snapshot, even if an operator edit
    // lands on disk mid-loop.
    const campaignCap = this.campaignCapFn();
    const plannedLegs: PlannedLeg[] = [];
    // Releases every reservation already taken earlier in THIS sizing pass. Called at every early
    // `return` below so a later leg's rejection (missing filters, un-sizeable qty, notional cap, or
    // this executor's OWN first-ever in-flight claim rejecting) never leaves an earlier leg's
    // capacity reserved with no basket ever going on to consume it — this executor's hedge-integrity
    // constraint means ANY leg failing aborts the WHOLE basket, so every already-taken reservation
    // for THIS attempt is dead the moment any leg fails.
    const releasePlannedSoFar = (reason: string): void => {
      for (const planned of plannedLegs) {
        if (planned.reservationId) this.releaseExposureReservationFn(planned.reservationId, reason);
      }
    };
    for (const [side, legs] of [["LONG", signal.longLeg], ["SHORT", signal.shortLeg]] as const) {
      for (const leg of legs) {
        const f = filters.get(leg.symbol);
        if (!f || !(leg.entryPrice > 0)) { releasePlannedSoFar("SIBLING_LEG_MISSING_FILTERS"); return; } // missing filters/price ⇒ skip whole basket
        const rawQty = legUsd / leg.entryPrice;
        const qty = Math.floor(rawQty / f.stepSize) * f.stepSize;
        if (!(qty >= f.minQty)) { releasePlannedSoFar("SIBLING_LEG_UNDERSIZED"); return; } // any un-sizeable leg ⇒ skip whole basket (hedge integrity)
        // 2026-07-19 real-money audit fix: this leg's notional, ADDED to whatever every OTHER
        // executor sharing this netted account (the 9 single-symbol lanes AND this instance's own
        // 2 cross-sectional siblings, PLUS this instance's own already-open legs on the symbol)
        // already holds on this exact symbol, must not exceed the shared per-symbol cap — see
        // live-executor-wiring.ts's computeNotionalPerSymbol doc comment for the original
        // single-symbol-only incident this closes. Same skip-WHOLE-basket-this-tick convention as
        // the filters/minQty checks above (this executor's hedge-integrity design constraint: never
        // open one side without the other — see the module doc comment at the top of this file).
        // TRANSIENT, not permanent: the watermark above only advances past THIS signal, so the next
        // fresh signal gets a clean re-evaluation once the colliding exposure frees up.
        if (
          notionalCap > 0 &&
          this.existingNotionalForSymbolFn(leg.symbol) + this.ownOpenNotionalForSymbol(leg.symbol) + qty * leg.entryPrice > notionalCap
        ) { releasePlannedSoFar("SIBLING_LEG_NOTIONAL_CAP"); return; }
        // Account-exposure reservation (account-exposure-coordinator.ts) — this executor's FIRST-EVER
        // in-flight per-symbol claim (see CrossSectionalExecutorOptions.reserveExposure doc comment).
        // Reserves ALL legs upfront, atomically, before ANY leg's order fires for this basket — no
        // `await` runs between one leg's reservation and the next, so no sibling executor's tick can
        // interleave partway through this basket's sizing pass. clientOrderId matches EXACTLY what
        // the placement loop below will submit for this same leg index: basket.legs.length ===
        // plannedLegs.length at placement time for a given leg, since both are filled strictly in
        // order (see the placement loop's own newClientOrderId, built from basket.legs.length).
        // Computed ONCE here — the single source of truth both the reservation call below AND
        // every later placement/reconciliation attempt (fresh or resumed after a restart) reuse
        // verbatim, replacing the old implicit assumption that plannedLegs.length at reservation
        // time would always coincide with basket.legs.length at placement time.
        const planIndex = plannedLegs.length;
        const entryClientOrderId = `xsec-${basketId.slice(-12)}-e${planIndex}`;
        const legReservation = this.reserveExposureFn({
          executorId: this.laneId,
          symbol: leg.symbol,
          direction: side,
          requestedNotionalUsd: qty * leg.entryPrice,
          clientOrderId: entryClientOrderId,
          basketId,
          campaignCap,
        });
        if (!legReservation.ok) {
          releasePlannedSoFar(`SIBLING_LEG_RESERVE_FAILED:${legReservation.reason ?? "unknown"}`);
          return;
        }
        plannedLegs.push({
          planIndex,
          symbol: leg.symbol,
          side,
          requestedQty: Number(qty.toFixed(8)),
          refPrice: leg.entryPrice,
          reservationId: legReservation.reservationId,
          entryClientOrderId,
          status: "PENDING",
          failureReason: null,
        });
      }
    }
    if (plannedLegs.length !== signal.longLeg.length + signal.shortLeg.length) {
      releasePlannedSoFar("PLANNED_LEG_COUNT_MISMATCH");
      return;
    }

    const basket: ExecutorBasket = {
      basketId,
      sourceObservationId: signal.observationId,
      signal: signal.signal,
      variant: signal.variant ?? "RAW",
      openedAt: this.nowIso(),
      closesAtMs: signal.openedAtMs + signal.horizonMs,
      takeProfitReturn: this.respectSignalRiskGeometry ? signal.takeProfitReturn ?? null : undefined,
      stopLossReturn: this.respectSignalRiskGeometry ? signal.stopLossReturn ?? null : undefined,
      legs: [],
      status: "RESERVED",
      plan: plannedLegs,
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
      cortexAppliedWeightPct: this.allocationWeightPct(),
      cortexRawStaticWeightPct: this.rawAllocationWeightPct(),
    };

    // 2026-07-21 real-money audit fix (CRITICAL): push + save the basket BEFORE placing any order,
    // then save again after EVERY leg fills — mirroring closeBasket's own "persist per leg so a
    // crash/retry mid-close can resume" discipline (see its comment above). Before this fix, the
    // basket only ever reached st.baskets on the try's SUCCESS path or the catch's abort path; a
    // process crash/restart between a leg's placeOrder confirming filled and either of those two
    // points left a REAL, exchange-confirmed position with ZERO record anywhere — not in baskets,
    // not in orphanedLegs — because the watermark above already advanced past this signal, so it's
    // never retried either. This is the exact, confirmed root cause of the 2026-07-18 testnet
    // incident (a real WIFUSDT fill that vanished from all bookkeeping after an apparent crash mid
    // basket-open). Pushing the SAME object reference here means every later mutation (`.legs.push`,
    // `.status = "ABORTED"`, etc.) is already visible to anything reading st.baskets — including a
    // concurrent externalManagedNetQty()/reconciliation read from a different ticker, which can only
    // become MORE accurate this way (it now sees exactly the legs genuinely filled so far), never
    // less. Re-entrancy is not a concern within this class: `tick()`'s own `this.ticking` guard means
    // this method can't overlap with itself or with closeBasketsHittingProfitTarget in the same tick.
    st.baskets.push(basket);
    this.store.save();

    // Placement itself lives in placeRemainingLegs — the SAME method recoverIncompleteBaskets()
    // calls to resume a basket a restart interrupted, starting from index 0 here vs. wherever
    // basket.legs.length landed there. Sharing one implementation is the point: a fresh open and a
    // resumed one must behave identically for every leg they both place, or the two paths drift.
    await this.placeRemainingLegs(basket, 0);
  }

  /** Marks every plan entry from `fromIndex` onward NEVER_ATTEMPTED (idempotent — skips one
   *  already FILLED, which should be unreachable this far but is defensive against future
   *  reordering) and releases each one's reservation with `releaseReason`. Shared by both
   *  placeRemainingLegs interrupt paths (an ordinary leg failure calls this for everything AFTER
   *  the one it already marked FAILED itself; a kill/drain interrupt calls this starting AT the
   *  not-yet-attempted leg, since nothing failed — the loop simply stopped). */
  private markRemainingNeverAttempted(basket: ExecutorBasket, fromIndex: number, releaseReason: string): void {
    const plan = basket.plan ?? [];
    for (let j = fromIndex; j < plan.length; j++) {
      const entry = plan[j]!;
      if (entry.status === "FILLED") continue; // defensive — should be unreachable this far
      entry.status = "NEVER_ATTEMPTED";
      if (entry.reservationId) this.releaseExposureReservationFn(entry.reservationId, releaseReason);
    }
  }

  /** Flattens every already-filled leg on `basket` that isn't already exited (reduceOnly MARKET,
   *  one at a time) — the ROLLBACK half of the hedge-vs-rollback decision (see placeRemainingLegs).
   *  Extracted verbatim (same reduceOnly call, same executedQty/shortfall honoring, same
   *  recordOrphanedLeg-on-failure) from what used to be placeRemainingLegs' own inline abort
   *  handler — now shared by BOTH the ordinary-entry-failure rollback and the kill/drain-interrupt
   *  rollback (see ground truth items (d) and (a)/(b)), which is the point: one flatten
   *  implementation, not two copies that can drift. The `exitOrderId !== null` guard is new and
   *  purely defensive — under claimBasket's mutual exclusion (see its own doc comment) nothing else
   *  can be closing THIS basket's legs while this runs, so it should never trigger, but it costs
   *  nothing and matches closeBasket's own identical guard on its retry path. */
  private async flattenFilledLegs(basket: ExecutorBasket): Promise<void> {
    for (const leg of basket.legs) {
      if (leg.exitOrderId !== null) continue; // already flattened by a previous attempt
      try {
        const flat = await this.client.placeOrder({
          symbol: leg.symbol,
          side: leg.side === "LONG" ? "SELL" : "BUY",
          type: "MARKET",
          quantity: leg.qty,
          reduceOnly: true,
          newClientOrderId: `xsec-${basket.basketId.slice(-12)}-a${basket.legs.indexOf(leg)}`,
        });
        leg.exitOrderId = flat.orderId;
        const resolvedFlat = await this.resolveFillPrice(leg.symbol, flat.orderId, flat.avgPrice, leg.entryPrice);
        leg.exitPrice = resolvedFlat.price;
        leg.exitPriceConfirmed = resolvedFlat.confirmed;
        // 2026-07-19 real-money audit follow-up: same executedQty honoring as closeBasket's exit
        // path (see BUG 3) — a genuine partial fill on this rollback-flatten must not be recorded
        // as fully closed. Guarded with `> 0` exactly like the other sites, since an
        // unconfirmed-at-ACK (avgPrice=0/executedQty=0) but genuinely full fill must fall back to
        // the requested qty, not be misread as a 100% shortfall.
        const flatExecutedQty = Number.isFinite(flat.executedQty) && flat.executedQty > 0 ? flat.executedQty : leg.qty;
        const flatShortfall = leg.qty - flatExecutedQty;
        if (flatShortfall > 1e-9) {
          this.recordOrphanedLeg(
            basket,
            { ...leg, qty: flatShortfall },
            new Error(`rollback-flatten partial fill: requested ${leg.qty}, executed ${flatExecutedQty} — residual ${flatShortfall} still open`),
          );
        }
      } catch (flattenError) {
        // 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): this leg is now a REAL,
        // still-open exchange position (e.g. a sibling XSEC executor already holds the opposite
        // side on this symbol, or a transient exchange/network error) that this basket's own
        // bookkeeping can never reach again — it is recorded ABORTED with exitOrderId still null,
        // and nothing else in this file ever revisits an ABORTED basket. Track it explicitly so
        // retryOrphanedLegFlattens() (called every tick) keeps trying to flatten it, and
        // getStatus().orphanedLegs surfaces it prominently AND engages the critical latch (see
        // hasUnresolvedOrphanedExposure) — it must never again just silently fall out of this
        // basket's bookkeeping.
        this.recordOrphanedLeg(basket, leg, flattenError);
      }
    }
    this.store.save();
  }

  /**
   * Places every planned leg from `startIndex` onward, sequentially — one leg at a time, never in
   * parallel, never retried within a single attempt. Shared by TWO callers:
   *  - maybeOpenBasket(), fresh open, always startIndex=0, basket.legs empty.
   *  - recoverIncompleteBaskets(), resuming after a restart, startIndex===basket.legs.length, with
   *    the leg AT that index possibly already reconciled (adopted) by the caller beforehand.
   *
   * Claims `basket.basketId` for its entire duration (see claimBasket) so closeAllBasketsOrderly
   * can never mutate the same basket concurrently (ground truth #8) — released in a `finally`
   * regardless of how this method exits.
   *
   * Between every leg (ground truth item (a) — previously checked exactly once, at tick()'s top
   * level, before this loop ever started), re-reads the SAME `isAllowed` closure tick() already
   * consults, plus `basket.pendingKillReason` (set by a closeAllBasketsOrderly call that lost the
   * claim race — see claimBasket/closeAllBasketsOrderly). Either one stops the loop immediately.
   *
   * On a STOP (kill/drain interrupt, or an ordinary leg failure — ground truth item (d)) the
   * decision is HEDGE vs ROLLBACK:
   *  - Kill/drain interrupt: ALWAYS rolls back (flattens every already-filled leg) — a kill/drain
   *    signal means "reduce risk now", and an accidentally-balanced partial basket is not a reason
   *    to keep new exposure open through it.
   *  - An ordinary entry failure: rolls back ONLY when the already-filled legs are NOT already a
   *    real hedge (empty on either side — the same test the TP-math fix uses). When they already
   *    span BOTH sides, unwinding a working hedge would trade it for guaranteed roundtrip
   *    cost/slippage on both a close and (if a future signal re-opens) a re-open for no safety
   *    benefit — so those legs are left open and the basket is marked COMPLETE as the
   *    smaller-than-planned but genuinely balanced final shape (see ExecutorBasket.status's own
   *    doc comment). No further attempt is ever made on the un-placed legs — recoverIncompleteBaskets
   *    only revisits RESERVED/PLACING/PARTIALLY_FILLED baskets, and COMPLETE is deliberately outside
   *    that set.
   *
   * Never throws: every failure (leg placement, rollback, hedge decision, kill/drain interrupt) is
   * fully handled internally (this.lastError set) so BOTH callers can treat this as a plain,
   * non-throwing terminal outcome — recoverIncompleteBaskets in particular needs this, since it may
   * process several independent baskets in the same tick and one's failure must never stop the rest.
   */
  private async placeRemainingLegs(basket: ExecutorBasket, startIndex: number): Promise<void> {
    if (!this.claimBasket(basket.basketId)) {
      // Defensive, not a real code path: within one executor instance, placeRemainingLegs is only
      // ever invoked sequentially (maybeOpenBasket opens at most one basket per tick;
      // recoverIncompleteBaskets claims the basket itself — see placeRemainingLegsLocked's own doc
      // comment — before ever reaching this method), so this basket's own id can never already be
      // claimed by another placeRemainingLegs call. The only OTHER claimant is closeAllBasketsOrderly,
      // which never calls this method. Never silently proceeds against a basket something else owns.
      this.lastError = `basket ${basket.basketId}: placement re-entered while already claimed — skipped this attempt`;
      return;
    }
    try {
      await this.placeRemainingLegsLocked(basket, startIndex);
    } finally {
      this.releaseBasket(basket.basketId);
    }
  }

  /**
   * 2026-08-04 (review round 1 — race-condition fix): the actual placement loop, factored out of
   * placeRemainingLegs so recoverIncompleteBaskets can hold ONE claim across BOTH its ambiguous-leg
   * reconciliation query (see reconcilePlannedLeg) AND this loop, instead of claiming only once this
   * loop starts. Before this split, the reconciliation step's own FILLED-adoption (basket.legs.push +
   * basket.status mutation, in recoverIncompleteBaskets) ran with NO claim held at all — a
   * closeAllBasketsOrderly call racing that exact `await this.reconcilePlannedLeg(...)` window could
   * claim the (still-unclaimed) basket and fully CLOSE it — flattening every leg present at that
   * instant, setting status/closedAt/grossPnlUsd — and then, the instant it released, the
   * reconciliation's own adoption would run unopposed and silently overwrite status back to
   * COMPLETE/PARTIALLY_FILLED while pushing a brand-new leg with exitOrderId===null: REAL,
   * genuinely-filled exchange exposure the kill-switch pass believed it had just closed (it reports
   * `closed`, not `failed`), left permanently unflattened and invisible to every COMPLETE-only close
   * path until isAllowed() is true again. Confirmed via a direct interleaving test before this fix
   * (see [RESTART-RECOVERY: CONCURRENT CLOSE RACE] below) — reproduced exactly that corruption.
   * Caller MUST already hold basket.basketId's claim (see claimBasket/releaseBasket) — this method
   * itself never claims or releases, so it must never be called except from inside a claim/finally-
   * release pair (see placeRemainingLegs and recoverIncompleteBaskets, its only two callers).
   */
  private async placeRemainingLegsLocked(basket: ExecutorBasket, startIndex: number): Promise<void> {
    const plan = basket.plan ?? [];
    for (let i = startIndex; i < plan.length; i++) {
      const planned = plan[i]!;
      if (planned.status === "FILLED") continue; // idempotent — already resolved (e.g. by recovery)

      if (!this.isAllowed() || basket.pendingKillReason) {
        const reason = basket.pendingKillReason ?? "KILL_OR_DRAIN_MID_OPEN";
        basket.pendingKillReason = undefined;
        this.markRemainingNeverAttempted(basket, i, `KILL_OR_DRAIN_BASKET_INTERRUPTED:${reason}`);
        basket.status = "ABORTED";
        basket.closedAt = this.nowIso();
        basket.closeReason = reason;
        this.store.save();
        await this.flattenFilledLegs(basket); // always rolls back — see this method's own doc comment
        this.lastError = `basket ${basket.basketId} interrupted mid-open (${reason}) — rolled back`;
        return;
      }

      basket.status = basket.legs.length === 0 ? "PLACING" : "PARTIALLY_FILLED";
      planned.status = "PLACING";
      this.store.save();
      try {
        try {
          await this.client.setLeverage(planned.symbol, this.leverageFn());
        } catch {
          // best-effort (already set / position exists)
        }
        const order = await this.client.placeOrder({
          symbol: planned.symbol,
          side: planned.side === "LONG" ? "BUY" : "SELL",
          type: "MARKET",
          quantity: planned.requestedQty,
          newClientOrderId: planned.entryClientOrderId,
        });
        const resolvedEntry = await this.resolveFillPrice(planned.symbol, order.orderId, order.avgPrice, planned.refPrice);
        // 2026-07-19 real-money audit fix (BUG 3): a genuine partial MARKET fill (realistic on
        // thin-liquidity basket-universe symbols during volatility spikes — exactly what this
        // dispersion strategy targets) must not be silently recorded as if the full requested
        // quantity filled. Record the REAL executedQty so downstream P&L/exposure tracking
        // reflects what actually happened on the exchange, not what was requested.
        const filledQty =
          Number.isFinite(order.executedQty) && order.executedQty > 0 ? order.executedQty : planned.requestedQty;
        // Commit the reservation from this SAME real executedQty (never the requested planned.qty)
        // — idempotent no-op when reservationId is null (reserveExposure not wired, the safe default).
        if (planned.reservationId) {
          this.commitExposureReservationFn(planned.reservationId, { qty: filledQty, avgPrice: resolvedEntry.price });
        }
        basket.legs.push({
          symbol: planned.symbol,
          side: planned.side,
          qty: filledQty,
          entryPrice: resolvedEntry.price,
          entryOrderId: order.orderId,
          entryPriceConfirmed: resolvedEntry.confirmed,
          exitPrice: null,
          exitOrderId: null,
          exitPriceConfirmed: null,
          planIndex: i,
        });
        planned.status = "FILLED";
        basket.status = basket.legs.length === plan.length ? "COMPLETE" : "PARTIALLY_FILLED";
        this.store.save(); // persist per leg so a crash mid-open still records this filled leg
      } catch (error) {
        const message = (error as Error).message ?? "placeOrder failed";

        // "Timeout means UNKNOWN, not failure." (2026-08-05 live-tick reconciliation fix.) An
        // UNAMBIGUOUS BinanceFuturesPrivateError with failureType==="binance_error" is a confirmed
        // in-band rejection — Binance received the request and explicitly answered no, so no order
        // was created. Every OTHER failure (timeout/429/network/http_error/invalid_response/
        // clock_skew, or a plain non-Binance Error) is AMBIGUOUS: we do NOT know whether the order
        // actually reached the exchange. Reconcile by client/order identity via the SAME helper
        // recoverIncompleteBaskets already uses for its own crash-path "PLACING" reconciliation
        // (reconcilePlannedLeg) — ONE immediate attempt — before deciding anything. Deciding
        // hedge-vs-rollback blind here (the pre-fix bug) could push the basket to a terminal status
        // (ABORTED, or COMPLETE-as-a-reduced-hedge) this SAME tick while a leg that actually filled
        // never reached basket.legs — permanently invisible to recoverIncompleteBaskets, which only
        // ever revisits non-terminal (RESERVED/PLACING/PARTIALLY_FILLED) baskets: a genuinely naked,
        // untracked position no later restart would ever rediscover.
        const isConfirmedRejection = error instanceof BinanceFuturesPrivateError && error.failureType === "binance_error";

        if (!isConfirmedRejection) {
          const resolution = await this.reconcilePlannedLeg(planned.symbol, planned.entryClientOrderId);

          if (resolution.outcome === "FILLED") {
            // Adopt exactly like recoverIncompleteBaskets' own FILLED branch — the order actually
            // reached and filled on the exchange despite the local timeout/network error. Commit
            // (never release) the reservation and push the real fill into legs, exactly as a normal
            // in-loop fill would.
            if (planned.reservationId) {
              this.commitExposureReservationFn(planned.reservationId, { qty: resolution.qty, avgPrice: resolution.avgPrice });
            }
            basket.legs.push({
              symbol: planned.symbol,
              side: planned.side,
              qty: resolution.qty,
              entryPrice: resolution.avgPrice,
              entryOrderId: resolution.orderId,
              entryPriceConfirmed: true,
              exitPrice: null,
              exitOrderId: null,
              exitPriceConfirmed: null,
              planIndex: i,
            });
            planned.status = "FILLED";
            basket.status = basket.legs.length === plan.length ? "COMPLETE" : "PARTIALLY_FILLED";
            this.store.save();
            continue; // proceed to the next leg this SAME tick, exactly as a normal fill would
          }

          if (resolution.outcome === "INCONCLUSIVE") {
            // Never guess. planned.status stays exactly "PLACING" (set at the top of this loop
            // iteration, before the try — see PlannedLeg's own doc comment: it is the ONLY status
            // that triggers a reconciliation query before resuming) — no new enum value, never
            // "FAILED". The reservation is NOT released. basket.status stays exactly what this
            // iteration's top already set (PLACING/PARTIALLY_FILLED — both non-terminal).
            // recoverIncompleteBaskets() already scans every RESERVED/PLACING/PARTIALLY_FILLED
            // basket EVERY tick (not just after a crash) and will re-run this SAME reconciliation
            // next tick against the identical entryClientOrderId — zero new scheduling/retry code.
            // "Block retry": the reservation staying RESERVED means
            // AccountExposureCoordinator.reserve()'s own unconditional single-flight-per-symbol Gate
            // 1 rejects any OTHER reservation on this symbol — a fresh basket, a sibling instance, or
            // a SingleSymbolLaneExecutor entry — for as long as this one stays outstanding.
            this.lastError =
              `basket ${basket.basketId}: leg ${i} (${planned.symbol}) placement ambiguous (${message}) — ` +
              `exchange reconciliation INCONCLUSIVE, retaining reservation and deferring to next tick's recovery pass`;
            this.store.save();
            return;
          }
          // resolution.outcome === "NOT_PLACED": the exchange itself confirmed this attempt never
          // resulted in a live/filled order — now unambiguous, falls into the confirmed-failure
          // handling below exactly like isConfirmedRejection.
        }

        planned.status = "FAILED";
        planned.failureReason = message;
        // Account-exposure reservation cleanup (account-exposure-coordinator.ts). Release on an
        // UNAMBIGUOUS non-fill only: either Binance's own in-band rejection (isConfirmedRejection),
        // or an ambiguous failure THIS tick's own reconciliation just above confirmed NOT_PLACED —
        // both mean the exchange itself has now answered "no order", so releasing capacity here
        // cannot recreate the race this coordinator exists to close. A still-INCONCLUSIVE ambiguous
        // failure never reaches this line (it returned above, reservation untouched).
        if (planned.reservationId) {
          this.releaseExposureReservationFn(
            planned.reservationId,
            isConfirmedRejection ? `ENTRY_FAILED:${message}` : `ENTRY_FAILED_RECONCILED_NOT_PLACED:${message}`,
          );
        }
        // Every leg planned AFTER the failed one was never even attempted (this loop is
        // sequential and stops at the first throw) — those reservations are unambiguously safe
        // to release now.
        this.markRemainingNeverAttempted(basket, i + 1, "NEVER_ATTEMPTED_BASKET_ABORTED");
        this.store.save();

        // (d) hedge-vs-rollback: an ordinary entry failure — unlike a kill/drain interrupt above
        // — must not unwind an already-safely-hedged partial basket. "Safe" means the SAME test
        // the TP-math fix uses: real legs already present on BOTH sides, i.e. not one-sided.
        const longLegs = basket.legs.filter((l) => l.side === "LONG");
        const shortLegs = basket.legs.filter((l) => l.side === "SHORT");
        if (longLegs.length > 0 && shortLegs.length > 0) {
          basket.status = "COMPLETE"; // smaller than planned, but a genuine, already-balanced hedge
          this.store.save();
          this.lastError =
            `basket ${basket.basketId}: leg ${i} (${planned.symbol}) failed (${message}) — kept as a ` +
            `reduced ${basket.legs.length}/${plan.length}-leg hedge instead of unwinding a working position`;
          return;
        }

        // Not a hedge (one-sided, or zero legs) — a partial basket here is a NAKED directional
        // bet. Roll back: flatten whatever opened, record ABORTED.
        basket.status = "ABORTED";
        basket.closedAt = this.nowIso();
        basket.closeReason = `OPEN_FAILED:${message}`;
        this.store.save();
        await this.flattenFilledLegs(basket);
        this.lastError = message;
        return; // handled internally — see this method's own doc comment for why this never throws
      }
    }
    if (basket.pendingKillReason) {
      // The loop placed every remaining leg successfully (basket now COMPLETE) before this
      // between-legs check ever got a chance to catch the kill/drain signal — the claim race
      // window landed exactly at the end. Nothing left to interrupt mid-placement; hand off to
      // the SAME safe close path closeAllBasketsOrderly itself uses, now that the caller's claim
      // (see placeRemainingLegs/recoverIncompleteBaskets) is about to be released.
      const reason = basket.pendingKillReason;
      basket.pendingKillReason = undefined;
      try {
        await this.closeBasket(basket, reason);
      } catch (error) {
        this.lastError = (error as Error).message ?? "post-completion kill-switch close failed";
      }
    }
  }

  /**
   * THE CORE GAP this task closes: before this method existed, nothing ever detected a basket that
   * crashed mid-open (persisted RESERVED/PLACING/PARTIALLY_FILLED, fewer legs than its own plan)
   * and tried to finish it — it just sat there until closeDueBaskets eventually closed whatever
   * legs it happened to have as though that were the whole intended hedge (see
   * closeBasketsHittingProfitTarget/closeDueBaskets' own COMPLETE-only gating, added alongside this
   * method specifically to stop that). Runs every tick (like retryOrphanedLegFlattens), not just
   * once at startup — a genuine process restart is the common case, but this also self-heals a
   * basket left stuck by a transient INCONCLUSIVE reconciliation (see reconcilePlannedLeg) on a
   * later tick once the exchange query stops failing. Gated by the caller (tick()) on isAllowed()
   * only — see tick()'s own comment for why.
   *
   * Algorithm per incomplete basket:
   *  1. skip anything without a real plan array — cannot safely resume a plan it was never given
   *     (see ExecutorBasket.plan's own doc comment; ONLY legacy pre-migration data can even reach
   *     this, and _load() already migrates every reachable legacy shape away from these statuses).
   *  2. startIndex = basket.legs.length — the first plan entry not yet resolved.
   *  3. if that entry's OWN status is "PLACING", a placeOrder attempt for it may have been in
   *     flight when the process died — genuinely ambiguous, reconcile against the real exchange via
   *     reconcilePlannedLeg BEFORE touching it any further:
   *       - FILLED       → adopt the real fill (push to legs, commit the reservation, mark FILLED)
   *                         and continue.
   *       - NOT_PLACED   → the order never reached the exchange — safe to fall through to the
   *                         ordinary placement loop, which places it fresh.
   *       - INCONCLUSIVE → do NOT guess. Leave the basket exactly as-is and move on to the next
   *                         basket this tick; the next tick's recovery pass retries the query.
   *     Any other status at that index ("PENDING") means NO attempt was ever made for it by any
   *     process (RESERVED, or PARTIALLY_FILLED between two legs) — safe to place fresh, no query.
   *  4. resume placeRemainingLegsLocked() from wherever legs.length now stands (this basket's claim,
   *     taken before step 3, is already held — see this method's own race-condition-fix note below).
   *
   * Each basket is isolated in its own try/catch (same BUG-2 convention as
   * closeBasketsHittingProfitTarget/closeDueBaskets) so one basket's recovery failure can never
   * block another's in the same tick.
   *
   * 2026-08-04 (review round 1 — race-condition fix): claims `basket.basketId` (see
   * claimBasket/releaseBasket) BEFORE step 3's reconcilePlannedLeg query, not just around the
   * placeRemainingLegsLocked call in step 4 — the reconciliation query is a real, awaited exchange
   * round-trip, and its own FILLED-adoption mutates basket.legs/basket.status directly. Previously
   * that mutation ran completely unclaimed, so a closeAllBasketsOrderly call landing in that exact
   * window could claim and fully close the basket out from under the still-in-flight reconciliation
   * — see placeRemainingLegsLocked's own doc comment for the exact corruption this produced
   * (confirmed via a direct interleaving test, [RESTART-RECOVERY: CONCURRENT CLOSE RACE] below). A
   * failed claim here means something else (that same race) already owns this basket this instant;
   * skip it for this tick — self-healing, same "never guess, retry later" posture INCONCLUSIVE
   * already uses below, and the very next tick's recovery pass retries once the claim is free.
   */
  private async recoverIncompleteBaskets(): Promise<void> {
    const st = this.store.getState();
    const incomplete = st.baskets.filter(
      (b) => (b.status === "RESERVED" || b.status === "PLACING" || b.status === "PARTIALLY_FILLED") && Array.isArray(b.plan),
    );
    for (const basket of incomplete) {
      if (!this.claimBasket(basket.basketId)) continue; // owned by a concurrent close — retry next tick
      try {
        const plan = basket.plan!;
        const startIndex = basket.legs.length;
        if (startIndex >= plan.length) continue; // defensive — nothing left to do
        const ambiguous = plan[startIndex]!;
        if (ambiguous.status === "PLACING") {
          const resolution = await this.reconcilePlannedLeg(ambiguous.symbol, ambiguous.entryClientOrderId);
          if (resolution.outcome === "INCONCLUSIVE") continue; // never guess — retry next tick
          if (resolution.outcome === "FILLED") {
            if (ambiguous.reservationId) {
              this.commitExposureReservationFn(ambiguous.reservationId, { qty: resolution.qty, avgPrice: resolution.avgPrice });
            }
            basket.legs.push({
              symbol: ambiguous.symbol,
              side: ambiguous.side,
              qty: resolution.qty,
              entryPrice: resolution.avgPrice,
              entryOrderId: resolution.orderId,
              entryPriceConfirmed: true,
              exitPrice: null,
              exitOrderId: null,
              exitPriceConfirmed: null,
              planIndex: startIndex,
            });
            ambiguous.status = "FILLED";
            basket.status = basket.legs.length === plan.length ? "COMPLETE" : "PARTIALLY_FILLED";
            this.store.save();
          }
          // NOT_PLACED: nothing to adopt — falls through to placeRemainingLegsLocked below, which
          // will place it fresh (ambiguous.status is still "PLACING" here, but that loop overwrites
          // it unconditionally the moment it (re)starts that plan index).
        }
        // 2026-08-04 (review round 1 fix — critical-latch coverage gap): maybeOpenBasket already
        // refuses to open a brand-new basket while hasUnresolvedOrphanedExposure() is true (REAL,
        // unaccounted-for exchange exposure from a prior rollback/flatten failure) — but until this
        // check, THIS path could still place a plan entry that has never been attempted by any
        // process (a RESERVED basket that crashed before its very first leg, or any entry still
        // PENDING/just-classified-NOT_PLACED here), which is structurally identical new-risk
        // real-money order placement going around the same latch. Gated on `legs.length < plan.length`
        // (i.e. only when a NEW placeOrder is actually about to happen): the reconciliation/adoption
        // above is pure bookkeeping — recording a fill that already happened on the exchange
        // pre-crash — and must never be blocked by this latch, and neither must the pendingKillReason
        // tail check inside placeRemainingLegsLocked when nothing new needs placing (legs.length
        // already === plan.length, e.g. adoption alone just completed this basket). Self-heals
        // exactly like maybeOpenBasket's own check: left exactly as-is, retried next tick once the
        // orphan resolves — this basket's already-real legs, if any, stay fully visible/flattenable
        // regardless (see isBasketLive()/closeAllBasketsOrderly, neither of which reads this latch).
        if (basket.legs.length < plan.length && this.hasUnresolvedOrphanedExposure()) continue;
        await this.placeRemainingLegsLocked(basket, basket.legs.length);
      } catch (error) {
        this.lastError = (error as Error).message ?? "basket recovery failed";
      } finally {
        this.releaseBasket(basket.basketId);
      }
    }
  }

  /**
   * Classifies ONE ambiguous plan entry during restart-recovery, via the same queryOrderByClientId
   * endpoint and the same FILLED/terminal-no-fill/-2013-never-reached/anything-else classification
   * account-exposure-coordinator.ts's own reconcileStaleReservations already uses — duplicated
   * here, deliberately, rather than extracted into a shared helper: it is a small, stable
   * classification, and the two consumers differ (this decides whether to ADOPT a leg into a
   * basket vs. place it fresh; the coordinator only ever resolves its own reservation ledger), so a
   * shared abstraction would couple two independently-owned concerns for no real gain. Never
   * throws — an unwired client or a network failure both resolve to INCONCLUSIVE, the same
   * "don't guess, retry later" outcome as any other unrecognized state.
   */
  private async reconcilePlannedLeg(
    symbol: string,
    entryClientOrderId: string,
  ): Promise<
    | { outcome: "FILLED"; qty: number; avgPrice: number; orderId: string }
    | { outcome: "NOT_PLACED" | "INCONCLUSIVE" }
  > {
    if (!this.client.queryOrderByClientId) return { outcome: "INCONCLUSIVE" };
    try {
      const order = await this.client.queryOrderByClientId(symbol, entryClientOrderId);
      const status = (order.status ?? "").trim().toUpperCase();
      const executedQty = Number.isFinite(order.executedQty) ? order.executedQty : 0;
      if ((status === "FILLED" || status === "PARTIALLY_FILLED") && executedQty > 0) {
        return { outcome: "FILLED", qty: executedQty, avgPrice: order.avgPrice, orderId: order.orderId };
      }
      if (
        status === "CANCELED" ||
        status === "CANCELLED" ||
        status === "EXPIRED" ||
        status === "REJECTED" ||
        (status === "FILLED" && executedQty <= 0)
      ) {
        return { outcome: "NOT_PLACED" };
      }
      return { outcome: "INCONCLUSIVE" };
    } catch (error) {
      if (error instanceof BinanceFuturesPrivateError && error.binanceCode === -2013) return { outcome: "NOT_PLACED" };
      return { outcome: "INCONCLUSIVE" };
    }
  }

  /** See OrphanedLeg's doc comment. Pushes a NEW record — callers only ever invoke this once per
   *  leg (the abort-flatten catch fires at most once per leg; a partial-exit remainder is a fresh
   *  leg-like record every time), so no merge-with-existing lookup is needed. */
  private recordOrphanedLeg(basket: ExecutorBasket, leg: ExecutorLeg, error: unknown): void {
    const st = this.store.getState();
    if (!Array.isArray(st.orphanedLegs)) st.orphanedLegs = [];
    const now = this.nowIso();
    const message = (error as Error)?.message ?? "flatten failed";
    st.orphanedLegs.push({
      basketId: basket.basketId,
      symbol: leg.symbol,
      side: leg.side,
      qty: leg.qty,
      entryPrice: leg.entryPrice,
      entryOrderId: leg.entryOrderId,
      since: now,
      lastAttemptAt: now,
      lastError: message,
      attempts: 1,
    });
    this.store.save();
    console.error(
      `[cross-sectional-executor] ORPHANED LEG: ${leg.symbol} ${leg.side} qty=${leg.qty} from basket ` +
        `${basket.basketId} could NOT be flattened (${message}) — real, still-open exchange exposure. ` +
        `Tracked for automatic retry every tick; surfaced via getStatus().orphanedLegs.`,
    );
  }

  /**
   * 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): retries flattening every
   * tracked orphaned leg (see OrphanedLeg's doc comment) on every tick, for as long as it stays
   * unresolved. A plain reduceOnly MARKET close is attempted first (the safe default that can
   * never over-close); if the exchange rejects it with -2022 (this leg's side is no longer
   * covered by a same-signed position — e.g. a sibling XSEC executor's opposite exposure, or the
   * position was already closed by some other path), the real exchange position is queried and,
   * when it confirms the leg is genuinely already flat/opposite-signed, the record is resolved
   * WITHOUT creating new exposure — mirroring closeBasket's own -2022 reconciliation exactly.
   * Any other error (a transient exchange/network blip) just updates the record's lastError/
   * attempts and is retried again on the next tick.
   */
  private async retryOrphanedLegFlattens(): Promise<void> {
    const st = this.store.getState();
    const pending = st.orphanedLegs ?? [];
    if (pending.length === 0) return;
    for (const orphan of [...pending]) {
      try {
        const order = await this.client.placeOrder({
          symbol: orphan.symbol,
          side: orphan.side === "LONG" ? "SELL" : "BUY",
          type: "MARKET",
          quantity: orphan.qty,
          reduceOnly: true,
          newClientOrderId: `xsec-orph-${orphan.basketId.slice(-10)}-${orphan.symbol.slice(0, 6)}`,
        });
        // 2026-07-19 real-money audit follow-up: same executedQty honoring as BUG 3 elsewhere in
        // this file — a genuine partial fill on a RETRY must not be treated as fully resolved,
        // or the still-open remainder silently loses tracking a second time. `> 0` guard exactly
        // like the other two sites (avgPrice=0/executedQty=0 at ACK does not mean zero fill).
        const orphanExecutedQty =
          Number.isFinite(order.executedQty) && order.executedQty > 0 ? order.executedQty : orphan.qty;
        const orphanShortfall = orphan.qty - orphanExecutedQty;
        if (orphanShortfall > 1e-9) {
          // Only PARTIALLY resolved — reduce this SAME orphan record's qty to the remainder and
          // keep retrying it next tick, rather than either dropping it (losing the residual) or
          // spawning a duplicate record for it.
          const st2 = this.store.getState();
          const current = (st2.orphanedLegs ?? []).find((o) => o === orphan);
          if (current) {
            current.qty = orphanShortfall;
            current.lastAttemptAt = this.nowIso();
            current.attempts += 1;
            current.lastError = `partial retry fill: requested ${orphan.qty}, executed ${orphanExecutedQty} — residual ${orphanShortfall} still open`;
            this.store.save();
          }
          continue;
        }
        const resolved = await this.resolveFillPrice(orphan.symbol, order.orderId, order.avgPrice, orphan.entryPrice);
        this.applyOrphanResolution(orphan, order.orderId, resolved.price, resolved.confirmed);
      } catch (error) {
        const message = (error as Error).message ?? "flatten retry failed";
        if (/(?:code\s*)?-2022|ReduceOnly Order is rejected/i.test(message)) {
          try {
            const positions = await this.client.getPositions(orphan.symbol);
            const positionAmt = positions.find((p) => p.symbol === orphan.symbol)?.positionAmt ?? 0;
            const expectedSign = orphan.side === "LONG" ? 1 : -1;
            if (Math.abs(positionAmt) <= 1e-9 || Math.sign(positionAmt) !== expectedSign) {
              // The exchange no longer carries this leg — resolve WITHOUT creating opposite
              // exposure, exactly closeBasket's own RECONCILED_POSITION_ALREADY_FLAT handling.
              this.applyOrphanResolution(orphan, "POSITION_ALREADY_FLAT", null, false);
              continue;
            }
          } catch {
            // position lookup failed too — fall through, keep retrying next tick
          }
        }
        const st2 = this.store.getState();
        const current = (st2.orphanedLegs ?? []).find((o) => o === orphan);
        if (current) {
          current.lastError = message;
          current.lastAttemptAt = this.nowIso();
          current.attempts += 1;
          this.store.save();
        }
      }
    }
  }

  /** Resolves (removes) an orphaned-leg record and, when the ORIGINAL basket/leg record can
   *  still be found, updates it with the real exit — so a basket's own legs array never
   *  disagrees with what actually happened on the exchange. `exitPrice`/`exitPriceConfirmed` are
   *  null/false for the POSITION_ALREADY_FLAT reconciliation path (no real fill occurred). */
  private applyOrphanResolution(
    orphan: OrphanedLeg,
    exitOrderId: string,
    exitPrice: number | null,
    exitPriceConfirmed: boolean,
  ): void {
    const st = this.store.getState();
    const basket = st.baskets.find((b) => b.basketId === orphan.basketId);
    const leg = basket?.legs.find((l) => l.symbol === orphan.symbol && l.side === orphan.side && l.exitOrderId === null);
    if (leg) {
      leg.exitOrderId = exitOrderId;
      leg.exitPrice = exitPrice;
      leg.exitPriceConfirmed = exitPriceConfirmed;
    }
    st.orphanedLegs = (st.orphanedLegs ?? []).filter((o) => o !== orphan);
    this.store.save();
  }
}

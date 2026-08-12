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

import { resolveConfirmedFillPrice, roundToStep, type BinanceFuturesPrivateClient, type FillPriceResolution, type FuturesSymbolFilters } from "./binance-futures-private.js";
import type { CortexRealAttributionStore } from "./cortex-real-attribution.js";
import { fillFromUserTrade, type ExecutionFill, type ExecutionFillRecorder, type ExecutionFillRole } from "./execution-fill-recorder.js";
import {
  CROSS_SECTIONAL_ROUNDTRIP_BPS,
  deriveAdaptiveSymbolFilters,
  isCrossSectionalAdaptiveDisabled,
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
>;

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

/**
 * Operator override that lets the cross-sectional executor open baskets while its rolling-evidence
 * gate says NO. Default OFF. Scoped to THIS lane on purpose: rollingNetEntryHealth is shared, and a
 * bypass inside it would silently unblock every lane that consumes it.
 *
 * The gate exists because a lane whose recent measured edge is negative should not be sending
 * orders. Turning this on trades DELIBERATELY WITHOUT that evidence — which is a legitimate thing
 * to do on testnet, where the point is to generate the evidence in the first place, and a very
 * different thing to do on an account with real money.
 *
 * It is deliberately LOUD rather than silent: the gate's own verdict is preserved verbatim in the
 * reason string and re-reported by getStatus() as entryHealthBypassed + entryHealthVerdict, so
 * "this lane is trading" can never later be misread as "this lane proved itself". It can only ever
 * turn a NO into a yes — a gate that already passes is returned untouched, so the flag cannot
 * accidentally mask a genuine pass or invert into a block.
 */
export function isCrossSectionalEntryHealthBypassed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_EXEC_FORCE_IGNORE_ENTRY_HEALTH === "1";
}

export function applyEntryHealthBypass(
  gate: { allowed: boolean; reason: string | null },
  env: NodeJS.ProcessEnv = process.env,
): { allowed: boolean; reason: string | null } {
  if (gate.allowed) return gate;
  if (!isCrossSectionalEntryHealthBypassed(env)) return gate;
  return {
    allowed: true,
    reason: `ENTRY-HEALTH GATE BYPASSED BY OPERATOR — the evidence still says: ${gate.reason ?? "blocked"}`,
  };
}

const LEG_USD = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_LEG_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 25;
};

/**
 * Size one entry so the exchange's structural floors cannot turn a planned 6-leg basket into a
 * reduced hedge. The configured leg notional remains the target; only a symbol whose exchange
 * minNotional/minQty is higher is lifted to the smallest valid step-rounded quantity. This is a
 * sizing adjustment, not an admission bypass: the resulting notional is still checked by the
 * shared per-symbol cap before any order is reserved or placed.
 */
export function sizeCrossSectionalLeg(
  legUsd: number,
  entryPrice: number,
  filters: Pick<FuturesSymbolFilters, "stepSize" | "minQty" | "minNotional">,
): number | null {
  if (!(legUsd > 0) || !(entryPrice > 0) || !(filters.stepSize > 0)) return null;
  const minNotional = Number.isFinite(filters.minNotional) && filters.minNotional > 0 ? filters.minNotional : 0;
  const minQty = Number.isFinite(filters.minQty) && filters.minQty > 0 ? filters.minQty : 0;
  const targetQty = Math.max(legUsd, minNotional) / entryPrice;
  const qty = roundToStep(Math.max(targetQty, minQty), filters.stepSize, "up");
  if (!(qty > 0) || qty < minQty || qty * entryPrice + 1e-9 < minNotional) return null;
  return Number(qty.toFixed(8));
}
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
}

/**
 * Per-token realized P&L for CLOSED baskets, plus when each basket opened and closed.
 *
 * Built for the operator question "which TOKEN actually made or lost the money in this basket" —
 * the store keeps P&L at the BASKET level only (grossPnlUsd/feeEstimateUsd/netPnlUsd), so per-leg
 * numbers have to be derived from the recorded fills.
 *
 * TWO honesty constraints, both surfaced in the output rather than hidden in the arithmetic:
 *
 *  1. FEES ARE ALLOCATED, NOT MEASURED, PER LEG. closeBasket() sums commission across the whole
 *     basket; nothing attributes a commission row to one leg. Each leg is charged the basket fee in
 *     proportion to the notional it touched (entry + exit), which is exactly how a flat taker rate
 *     would fall — but on an EXCHANGE-sourced fee it is an apportionment, so `feeAllocated` is
 *     named for what it is and `feeSource` rides along at basket level.
 *  2. AN UNCONFIRMED FILL PRICE MAKES THE LEG'S NUMBER FICTION. entryPrice falls back to the
 *     pre-trade reference when the exchange never confirmed a fill (see resolveFillPrice), so a leg
 *     with entryPriceConfirmed/exitPriceConfirmed false has a realized figure computed against a
 *     price that may never have executed. Reported per leg AND aggregated per basket, so a caller
 *     can drop those rows instead of averaging them in unknowingly.
 *
 * ABORTED baskets are excluded: they never held a complete hedge, so a per-token realized figure
 * would describe a position the lane never actually ran. Legs with no exit price are skipped.
 */
export interface ClosedBasketLegRealized {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  notionalTouchedUsd: number;
  grossPnlUsd: number;
  feeAllocatedUsd: number;
  netPnlUsd: number;
  priceConfirmed: boolean;
}

export interface ClosedBasketRealized {
  basketId: string;
  variant: string;
  signal: string;
  openedAt: string;
  closedAt: string;
  holdHours: number;
  closeReason: string | null;
  grossPnlUsd: number | null;
  feeEstimateUsd: number | null;
  feeSource: string | null;
  netPnlUsd: number | null;
  /** False when ANY leg's entry or exit price was never confirmed by the exchange. */
  allPricesConfirmed: boolean;
  legs: ClosedBasketLegRealized[];
}

export function closedBasketRealizedBreakdown(
  baskets: readonly ExecutorBasket[],
): ClosedBasketRealized[] {
  const out: ClosedBasketRealized[] = [];
  for (const b of baskets) {
    if (b.status !== "CLOSED" || !b.closedAt) continue;
    const priced = b.legs.filter((l) => l.exitPrice !== null && l.entryPrice > 0 && l.qty > 0);
    const notionalOf = (l: ExecutorLeg) => l.qty * (l.entryPrice + (l.exitPrice ?? l.entryPrice));
    const totalNotional = priced.reduce((sum, l) => sum + notionalOf(l), 0);
    const basketFee = Number.isFinite(b.feeEstimateUsd ?? NaN) ? b.feeEstimateUsd! : 0;
    const legs: ClosedBasketLegRealized[] = priced.map((l) => {
      const exit = l.exitPrice!;
      const gross = l.side === "LONG" ? (exit - l.entryPrice) * l.qty : (l.entryPrice - exit) * l.qty;
      const share = totalNotional > 0 ? notionalOf(l) / totalNotional : (priced.length > 0 ? 1 / priced.length : 0);
      const fee = basketFee * share;
      return {
        symbol: l.symbol,
        side: l.side,
        qty: l.qty,
        entryPrice: l.entryPrice,
        exitPrice: exit,
        notionalTouchedUsd: notionalOf(l),
        grossPnlUsd: gross,
        feeAllocatedUsd: fee,
        netPnlUsd: gross - fee,
        priceConfirmed: l.entryPriceConfirmed === true && l.exitPriceConfirmed === true,
      };
    });
    const openedMs = new Date(b.openedAt).getTime();
    const closedMs = new Date(b.closedAt).getTime();
    out.push({
      basketId: b.basketId,
      variant: b.variant,
      signal: b.signal,
      openedAt: b.openedAt,
      closedAt: b.closedAt,
      holdHours: Number.isFinite(openedMs) && Number.isFinite(closedMs) ? (closedMs - openedMs) / 3_600_000 : 0,
      closeReason: b.closeReason,
      grossPnlUsd: b.grossPnlUsd,
      feeEstimateUsd: b.feeEstimateUsd,
      feeSource: (b as { feeSource?: string }).feeSource ?? null,
      netPnlUsd: b.netPnlUsd,
      allPricesConfirmed: legs.length > 0 && legs.every((l) => l.priceConfirmed),
      legs,
    });
  }
  return out.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
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
  status: "OPEN" | "CLOSED" | "ABORTED";
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
    const open = this.state.baskets.filter((b) => b.status === "OPEN");
    const settled = this.state.baskets
      .filter((b) => b.status !== "OPEN")
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
  private readonly dailyMaxLossUsdFn: () => number;
  private readonly entryHealthGate: () => { allowed: boolean; reason: string | null };
  private readonly siblingOpenLegs: () => Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }>;
  private readonly siblingDailyRealizedUsd: (nowIso: string) => number;
  private readonly sharedGetPositions: () => ReturnType<CrossSectionalExecClient["getPositions"]>;
  private readonly existingNotionalForSymbolFn: (symbol: string) => number;
  private readonly maxNotionalPerSymbolAcrossLanesFn: () => number;
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

  /** This instance's own open (status OPEN), un-exited (exitOrderId===null) basket legs — the
   *  surface a sibling CrossSectionalExecutor instance needs to see THIS instance's exposure. */
  getOpenUnexitedLegs(): Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }> {
    const out: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }> = [];
    for (const basket of this.store.getState().baskets) {
      if (basket.status !== "OPEN") continue;
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
      if (basket.status !== "OPEN") continue;
      for (const leg of basket.legs) {
        if (leg.exitOrderId === null && leg.symbol === symbol) sum += leg.qty * leg.entryPrice;
      }
    }
    return sum;
  }

  private entryHealth(): { allowed: boolean; reason: string | null } {
    return applyEntryHealthBypass(this.rawEntryHealth());
  }

  /** The gate's OWN verdict, before any operator bypass — what the evidence actually says. */
  private rawEntryHealth(): { allowed: boolean; reason: string | null } {
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
    /** True while CROSS_SECTIONAL_EXEC_FORCE_IGNORE_ENTRY_HEALTH=1 is overriding a FAILING gate.
     *  When true, this lane is trading WITHOUT evidence backing — never read `allowed: true`
     *  alongside this as "the edge is proven". */
    entryHealthBypassed: boolean;
    /** The rolling-evidence gate's OWN verdict, before any bypass. Survives the override so the
     *  real state is always readable. */
    entryHealthVerdict: { allowed: boolean; reason: string | null };
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
    adaptiveFiltersDisabled: boolean;
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
    const openBaskets = st.baskets.filter((b) => b.status === "OPEN");
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
      entryHealthBypassed: !this.rawEntryHealth().allowed && isCrossSectionalEntryHealthBypassed(),
      entryHealthVerdict: this.rawEntryHealth(),
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
      adaptiveFiltersDisabled: isCrossSectionalAdaptiveDisabled(),
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
    const open = st.baskets.filter((b) => b.status === "OPEN");
    let closed = 0;
    let failed = 0;
    for (const basket of open) {
      try {
        await this.closeBasket(basket, reason);
        if (basket.status !== "OPEN") closed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        this.lastError = (error as Error).message ?? "kill-switch basket close failed";
      }
    }
    return { closed, failed };
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
    const openBaskets = st.baskets.filter((b) => b.status === "OPEN");
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
      if (basket.status !== "OPEN") continue;
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
      if (basket.status !== "OPEN") continue;
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
      if (other === basket || other.status !== "OPEN") continue;
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

  private async maybeOpenBasket(): Promise<void> {
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
    if (st.baskets.filter((b) => b.status === "OPEN").length >= this.maxOpenBasketsFn()) return;

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
    const plannedLegs: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; refPrice: number }> = [];
    for (const [side, legs] of [["LONG", signal.longLeg], ["SHORT", signal.shortLeg]] as const) {
      for (const leg of legs) {
        const f = filters.get(leg.symbol);
        if (!f || !(leg.entryPrice > 0)) return; // missing filters/price ⇒ skip whole basket
        const qty = sizeCrossSectionalLeg(legUsd, leg.entryPrice, f);
        if (qty === null) return; // any un-sizeable leg ⇒ skip whole basket (hedge integrity)
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
        ) return;
        plannedLegs.push({ symbol: leg.symbol, side, qty: Number(qty.toFixed(8)), refPrice: leg.entryPrice });
      }
    }
    if (plannedLegs.length !== signal.longLeg.length + signal.shortLeg.length) return;

    const basket: ExecutorBasket = {
      // 2026-07-12 fix: derived only from the signal's timestamp, with no variant component — the
      // 3 CrossSectionalExecutor instances (FILTERED/TREND/MIXED) each have their OWN store file
      // but share ONE netted Binance account, and newClientOrderId is built from this id's LAST 12
      // chars. Two instances opening baskets whose signals share the same openedAtMs would collide
      // on newClientOrderId, and Binance's per-account idempotency would treat the second instance's
      // real order as a duplicate of the first's. The variant suffix is appended at the END (not
      // the middle) so it always survives basketId.slice(-12) regardless of the timestamp's length.
      basketId: `xb-${signal.openedAtMs.toString(36)}-${this.idNamespace}`,
      sourceObservationId: signal.observationId,
      signal: signal.signal,
      variant: signal.variant ?? "RAW",
      openedAt: this.nowIso(),
      closesAtMs: signal.openedAtMs + signal.horizonMs,
      takeProfitReturn: this.respectSignalRiskGeometry ? signal.takeProfitReturn ?? null : undefined,
      stopLossReturn: this.respectSignalRiskGeometry ? signal.stopLossReturn ?? null : undefined,
      legs: [],
      status: "OPEN",
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

    try {
      for (const planned of plannedLegs) {
        try {
          await this.client.setLeverage(planned.symbol, this.leverageFn());
        } catch {
          // best-effort (already set / position exists)
        }
        const order = await this.client.placeOrder({
          symbol: planned.symbol,
          side: planned.side === "LONG" ? "BUY" : "SELL",
          type: "MARKET",
          quantity: planned.qty,
          newClientOrderId: `xsec-${basket.basketId.slice(-12)}-e${basket.legs.length}`,
        });
        const resolvedEntry = await this.resolveFillPrice(planned.symbol, order.orderId, order.avgPrice, planned.refPrice);
        // 2026-07-19 real-money audit fix (BUG 3): a genuine partial MARKET fill (realistic on
        // thin-liquidity basket-universe symbols during volatility spikes — exactly what this
        // dispersion strategy targets) must not be silently recorded as if the full requested
        // quantity filled. Record the REAL executedQty so downstream P&L/exposure tracking
        // reflects what actually happened on the exchange, not what was requested.
        const filledQty =
          Number.isFinite(order.executedQty) && order.executedQty > 0 ? order.executedQty : planned.qty;
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
        });
        this.store.save(); // persist per leg so a crash mid-open still records this filled leg
      }
    } catch (error) {
      // A partial basket is a NAKED directional bet — flatten whatever opened, record ABORTED.
      basket.status = "ABORTED";
      basket.closedAt = this.nowIso();
      basket.closeReason = `OPEN_FAILED:${(error as Error).message}`;
      for (const leg of basket.legs) {
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
          // path (see BUG 3) — a genuine partial fill on this abort-flatten must not be recorded
          // as fully closed. Guarded with `> 0` exactly like the other two sites, since an
          // unconfirmed-at-ACK (avgPrice=0/executedQty=0) but genuinely full fill must fall back
          // to the requested qty, not be misread as a 100% shortfall.
          const flatExecutedQty = Number.isFinite(flat.executedQty) && flat.executedQty > 0 ? flat.executedQty : leg.qty;
          const flatShortfall = leg.qty - flatExecutedQty;
          if (flatShortfall > 1e-9) {
            this.recordOrphanedLeg(
              basket,
              { ...leg, qty: flatShortfall },
              new Error(`abort-flatten partial fill: requested ${leg.qty}, executed ${flatExecutedQty} — residual ${flatShortfall} still open`),
            );
          }
        } catch (flattenError) {
          // 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): this leg is now a
          // REAL, still-open exchange position (e.g. a sibling XSEC executor already holds the
          // opposite side on this symbol, or a transient exchange/network error) that this
          // basket's own bookkeeping can never reach again — it is recorded ABORTED with
          // exitOrderId still null, and nothing else in this file ever revisits an ABORTED
          // basket. Track it explicitly so retryOrphanedLegFlattens() (called every tick) keeps
          // trying to flatten it, and getStatus().orphanedLegs surfaces it prominently — it must
          // never again just silently fall out of this basket's bookkeeping.
          this.recordOrphanedLeg(basket, leg, flattenError);
        }
      }
      // basket was already pushed into st.baskets before the loop started (see comment above) —
      // no second push here, just persist the final ABORTED status/legs.
      this.store.save();
      throw error;
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

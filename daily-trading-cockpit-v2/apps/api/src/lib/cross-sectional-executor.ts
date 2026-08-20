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
import {
  buildSubmitRefBase,
  stampSubmitRef,
  type SubmitRef,
} from "./submit-reference-quote.js";
import { makerLimitPrice, resolveMakerLeg } from "./maker-entry-plan.js";
import {
  buildCurrentCrossSectionalPolicyFingerprint,
  crossSectionalMakerExitWaitMs,
  currentCrossSectionalExitPolicy,
  effectiveCrossSectionalRuntime,
  legacyCrossSectionalExitPolicy,
  type CrossSectionalEffectiveRuntime,
  type CrossSectionalExitPolicySnapshot,
  type CrossSectionalPolicyFingerprint,
} from "./cross-sectional-policy.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ExposureReserveCampaignCap, ExposureReserveRequest, ExposureReserveResult } from "./account-exposure-coordinator.js";
import { BinanceFuturesPrivateError, resolveConfirmedFillPrice, roundToStep, type BinanceFuturesPrivateClient, type FillPriceResolution, type FuturesOrder, type FuturesSymbolFilters } from "./binance-futures-private.js";
import type { CortexRealAttributionStore } from "./cortex-real-attribution.js";
import { fillFromUserTrade, type ExecutionFill, type ExecutionFillRecorder, type ExecutionFillRole } from "./execution-fill-recorder.js";
import type { FourBrainActualFillBindingStore } from "./four-brain-actual-fill-binding.js";
import type { FourBrainBridgeCandidate, FourBrainBridgeDecision } from "./four-brain-testnet-bridge.js";
import {
  evaluateCrossSectionalEntryAdmission,
  isCrossSectionalEntryTrafficLightEnabled,
  type CrossSectionalEntryAdmission,
  type CrossSectionalEntryHealthVerdict,
} from "./cross-sectional-entry-traffic-light.js";
import {
  CROSS_SECTIONAL_ROUNDTRIP_BPS,
  deriveAdaptiveSymbolFilters,
  isCrossSectionalAdaptiveDisabled,
  isCrossSectionalSmartBasketV1Enabled,
  regimeSkewCounterfactual,
  type RegimeSkewCounterfactual,
  type CrossSectionalObservation,
  type CrossSectionalStore,
} from "./cross-sectional-edge.js";

/**
 * Post-only entry legs (2026-08-16). OFF by default — every existing deployment keeps crossing the
 * spread until an operator turns this on for one instance.
 *
 * WHY: this account's own rates are maker 2.00 vs taker 4.00 bps per side (read from Binance's
 * /fapi/v1/commissionRate, not assumed), and 231 recorded fills confirm every fill so far has been
 * taker. Cross-basket's measured gross edge is ~11 bps against an 8.00 bps round-trip commission,
 * so halving the commission is worth more than any signal change measured on this lane to date.
 *
 * NOT a free win, and the fill data is the point: a resting order fills preferentially when the
 * market is moving against it. The commission saving is certain; the adverse-selection cost is not,
 * and only shows up in realised basket P&L. Both must be read together before this goes near live.
 */
export function isCrossSectionalMakerEntryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_MAKER_ENTRY_ENABLED === "1";
}
/** How long a post-only leg may rest before it is cancelled and crossed. */
export function crossSectionalMakerWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.CROSS_SECTIONAL_MAKER_WAIT_MS ?? "", 10);
  return Number.isFinite(n) && n >= 1_000 && n <= 120_000 ? n : 20_000;
}

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
> &
  /** Optional so every existing fake client keeps compiling. Maker entry REFUSES to run without
   *  it: a post-only order that cannot be cancelled has no safe way to stop resting, and leaving
   *  one on the book past its wait is worse than paying the taker fee. */
  Partial<Pick<BinanceFuturesPrivateClient, "cancelOrder">
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

/**
 * Does the account ALREADY hold a position on this symbol opposite to the side we are about to open,
 * beyond what sibling baskets legitimately explain?
 *
 * Binance nets per symbol account-wide. Two lanes on opposite sides of one symbol therefore do NOT
 * produce two positions — they cancel. Each book keeps claiming its full size, the exchange carries
 * only the remainder, and the engine force-disarms every tick on an orphan it can attribute to
 * neither. Measured on 2026-08-14: the directional lane held ETHUSDT SHORT 0.013, this executor
 * opened ETHUSDT LONG 0.011, the exchange netted to -0.002, and testnet could not stay armed until
 * the remainder was flattened by hand.
 *
 * Every existing guard for this sits on the CLOSE path (the -2022 stale-book reconcile,
 * retryOrphanedLegFlattens). Nothing looked BEFORE the order, which is the only point where the
 * collision is free to avoid.
 *
 * A sibling BASKET holding the other side is a designed-for case (see siblingOppositeUnexitedQty),
 * so its quantity is subtracted first. What remains beyond it is an unknown external holder — the
 * single-symbol/directional lanes this executor cannot see. Deliberately independent of the size we
 * intend to open: any unexplained opposite exposure is enough, because netting cancels regardless of
 * which side is larger.
 *
 * More exposure on OUR side is never a conflict — it neither hides our position nor makes our close
 * create opposite exposure.
 */
export function crossSectionalSymbolNettingConflict(
  side: "LONG" | "SHORT",
  exchangeNetQty: number,
  knownOppositeQty: number,
  tolerance = 1e-9,
): boolean {
  if (!Number.isFinite(exchangeNetQty)) return false;
  const explained = Number.isFinite(knownOppositeQty) ? Math.max(0, knownOppositeQty) : 0;
  return side === "LONG"
    ? exchangeNetQty < -explained - tolerance
    : exchangeNetQty > explained + tolerance;
}

/** Escape hatch only — the guard never places or cancels an order, it only skips a colliding
 *  signal, so leaving it on costs at most one deferred basket. */
const NETTING_GUARD_ENABLED = () => process.env.CROSS_SECTIONAL_NETTING_GUARD_DISABLED !== "1";

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

/**
 * Notional imbalance of a PLANNED basket, as a fraction of total planned notional.
 *
 * 2026-08-15: `sizeCrossSectionalLeg` can only ever ROUND UP — a symbol whose one-lot notional
 * exceeds its target leg (stepSize=1 coins priced above the leg size, e.g. AVAX at $13.44 against a
 * $7.16 target) is lifted to a full lot, and the two sides stop matching. Measured across the 9
 * baskets this executor has actually opened: at full leg size the imbalance is 0.40% / 0.93% /
 * 2.18%, but under the 0.35 learning multiplier it is 4.92% / 5.22% / 10.00%. A "market-neutral"
 * basket carrying 5-10% net directional exposure books market beta as though it were the lane's
 * cross-sectional edge — the measurement, not just the risk, is what breaks.
 *
 * Pure and side-effect free so the threshold can be exercised without an exchange.
 */
export function crossSectionalPlanNotionalImbalance(
  legs: ReadonlyArray<{ side: "LONG" | "SHORT"; requestedQty: number; refPrice: number }>,
): number {
  let longUsd = 0;
  let shortUsd = 0;
  for (const leg of legs) {
    const notional = Math.abs(leg.requestedQty * leg.refPrice);
    if (!Number.isFinite(notional)) continue;
    if (leg.side === "LONG") longUsd += notional;
    else shortUsd += notional;
  }
  const total = longUsd + shortUsd;
  if (!(total > 0)) return 0;
  return Math.abs(longUsd - shortUsd) / total;
}

/** Operator ceiling for the above, as a FRACTION. `0` (or unset/invalid) disables the guard. */
export function crossSectionalMaxPlanImbalance(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(env.CROSS_SECTIONAL_MAX_PLAN_IMBALANCE_PCT ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw / 100;
}

/** True ⇒ this plan is too lopsided to be booked as market-neutral. Never throws. */
export function crossSectionalPlanImbalanceExceeded(
  legs: ReadonlyArray<{ side: "LONG" | "SHORT"; requestedQty: number; refPrice: number }>,
  maxFraction: number,
): boolean {
  if (!(maxFraction > 0)) return false;
  return crossSectionalPlanNotionalImbalance(legs) > maxFraction;
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
/** Limits repeated symbols across concurrently live baskets; explicit testnet opt-in. */
export function isCrossSectionalOverlapGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_OVERLAP_GUARD_ENABLED === "1";
}
const MAX_OVERLAPPING_SYMBOLS = () => Math.max(0, Math.floor(Number(process.env.CROSS_SECTIONAL_MAX_OVERLAPPING_SYMBOLS) || 1));
const MAX_OVERLAPPING_SYMBOLS_PER_SIDE = () => Math.max(0, Math.floor(Number(process.env.CROSS_SECTIONAL_MAX_OVERLAPPING_SYMBOLS_PER_SIDE) || 1));
const OVERLAP_MIN_SCORE_DELTA = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_OVERLAP_MIN_SCORE_DELTA) || 0);
/** A repeated winner is continuation-only: it must still carry a strong directional score. */
const OVERLAP_MIN_ABS_SCORE = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_OVERLAP_MIN_ABS_SCORE) || 0);
/** Keep a continuation entry inside a volatility-scaled normal/underpriced range. */
const OVERLAP_MAX_ADVERSE_EXTENSION_VOL = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_OVERLAP_MAX_ADVERSE_EXTENSION_VOL) || 0);
const OVERLAP_MIN_ADVERSE_EXTENSION_PCT = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_OVERLAP_MIN_ADVERSE_EXTENSION_PCT) || 0);
/** Do not market-enter a repeat after the mark has run away from its fresh signal snapshot. */
const OVERLAP_MAX_SIGNAL_DRIFT_VOL = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_OVERLAP_MAX_SIGNAL_DRIFT_VOL) || 0);
const OVERLAP_MIN_SIGNAL_DRIFT_PCT = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_OVERLAP_MIN_SIGNAL_DRIFT_PCT) || 0);
/** Testnet-only re-entry guard. A losing live leg is not re-used on the same side for the next
 * basket until its current basket recovers or is settled. Explicit opt-in preserves every other
 * deployment's existing selection behavior. */
export function isCrossSectionalLossReentryGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_LOSS_REENTRY_GUARD_ENABLED === "1";
}
/**
 * Round-trip cost of ONE cross-sectional basket, as a fraction of DEPLOYED notional.
 *
 * The system-wide `LIVE_ESTIMATED_CLOSE_COST_PCT` (default 0.0022 = 22bps) is a single blended
 * entry+exit fee AND slippage constant — see current-guard-variant-matrix.ts's
 * PRODUCTION_BREAKEVEN_CONTROL_COST_PCT doc. It is calibrated for MAINNET single-symbol lanes,
 * where taker is 5bps/side and a stop-market exit can slip badly. Applied to a testnet 6-leg
 * basket exiting on market orders at a calm moment it overstates cost by ~1.9x, which makes every
 * open basket look worse than it is and invites closing a working position early.
 *
 * MEASURED 2026-08-15 on testnet, three independent ways that agree:
 *   1. Code: closeBasket() sums getUserTrades commissions over BOTH entryOrderId and exitOrderId,
 *      so the stored feeEstimateUsd is already a full round trip (unlike the directional lanes,
 *      whose feeEstimateUsd holds only the exit side while entryCommissionUsd goes unbooked).
 *   2. Per-fill exchange records (execution-fills.json, 66 fills, fetchComplete, not truncated):
 *      commission/touched-notional = 4.015 bps per side; ENTRY 36 fills and EXIT 30 fills both
 *      4.015. Round trip on deployed notional = 8.03 bps.
 *   3. Rate constancy: median 4.0000, min 3.9997, max 5.0000, only 2 distinct values — a flat
 *      taker rate, not a blend. Cross-checked against the basket-level field on all five closed
 *      baskets: 8.019 / 8.001 / 7.940 / 8.037 / 8.241 bps.
 *
 * Slippage, measured separately: entry 2.83 bps (n=23 legs, vs the scan reference price), exit
 * 0.93 bps mean / 0.76 median (n=30 legs, vs the 1m bar). The exit figure is NOISY (range -36 to
 * +61 bps) because a fill lands at one instant inside a moving bar, so the median is the honest
 * read; either way it is small, not the ~11 bps that would have justified 22.
 *
 * Total measured = 8.03 fee + 2.83 entry + 0.93 exit = 11.79 bps. The default below is 13 bps:
 * the fee component is exact, the slippage components are not, and understating cost is the more
 * dangerous error for a lane that may one day see real money. The margin is deliberate and stated
 * rather than hidden in a rounded-up figure.
 *
 * TESTNET-SCOPED. Mainnet taker was measured at 5bps/side on 2026-07-27 (→10bps fee) and its fee
 * ledger under-counts ~50%, so a mainnet basket costs materially more. Set the env explicitly
 * before this lane is ever pointed at a real account.
 */
export function crossSectionalEstimatedCostPct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(env.CROSS_SECTIONAL_ESTIMATED_COST_PCT ?? "");
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 0.0013;
}

const REENTRY_ESTIMATED_CLOSE_COST_PCT = () => {
  const configured = Number(
    process.env.CROSS_SECTIONAL_REENTRY_ESTIMATED_CLOSE_COST_PCT ??
      process.env.LIVE_ESTIMATED_CLOSE_COST_PCT ??
      "",
  );
  return Number.isFinite(configured) && configured >= 0 ? configured : 0.0022;
};
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
/**
 * 2026-08-17: the profit-bank TP can now be switched OFF, which was previously impossible.
 *
 * The numeric reader below falls back to 0.006 on absent/zero/negative/unparseable input, so
 * deleting the env line or setting it to 0 does NOT disable the TP — it silently moves it to 0.60%.
 * A dedicated boolean is used instead of overloading the numeric key: no existing value changes
 * meaning, and any typo (`=0`, `=true`, missing) leaves the TP exactly as it was rather than
 * silently uncapping live baskets.
 *
 * Why off: measured on 2 years of hourly klines, one slot opening and closing repeatedly for real
 * (not a ratio approximation), holding to the 48h horizon returns +68.4% over the period while
 * banking at 0.45% returns −149.2%. The TP does free the slot sooner — 535 baskets instead of 346 —
 * but each basket's expectancy is negative, so the extra turnover multiplies a loss. A paired test
 * over the same baskets agrees independently: +0.373%/basket, blocked t=+5.24, same sign in every
 * year and every quarter. Confirmed on this deployment's own 5 PROFIT_BANK closes, which gave up
 * $2.96 against a lane that made $1.69 in total.
 *
 * POSITIVE_INFINITY reuses the disabled representation the respectSignalRiskGeometry path already
 * relies on, so the comparison site needs no new branch.
 */
const TP_DISABLED = () => process.env.CROSS_SECTIONAL_EXEC_TP_DISABLED === "1";
/** Basket-level stop as a NET return, after the SAME cost model the TP check uses. 0 / unset = off,
 *  so an instance that never sets it keeps today's hold-to-horizon behaviour exactly.
 *
 *  Measured 2026-08-18 on 363 non-overlapping 48h blocks rebuilt from 2y of hourly Binance klines:
 *  a 1.5% stop lifted mean/block from +0.2102% to +0.3305% and cut the WORST block from -9.27% to
 *  -1.50%. The paired t against hold-to-horizon is +1.96 — just under the bar, so this is a
 *  promising-not-proven change, and the reason it is a switch rather than a default. The same sweep
 *  showed EVERY take-profit and every trailing-giveback variant losing, so no TP ships with it. */
/** Caps how long the executor holds a basket, INDEPENDENTLY of the signal horizon. 0 / unset = off,
 *  so the basket runs to closesAtMs exactly as it does today.
 *
 *  Why a separate key instead of lowering CROSS_SECTIONAL_HORIZON_BARS: that constant also sets the
 *  SHADOW observation horizon, and the signal name encodes MOMENTUM bars, not horizon bars — so
 *  dropping it 48 -> 36 would silently mix 48h and 36h observations under one unchanged
 *  "MOM36_FILTERED" label with nothing to tell them apart afterwards. That is the same cohort trap
 *  MOM24 -> MOM36 sprang this morning, only invisible. This key leaves the MEASUREMENT at 48h and
 *  moves only the TRADE.
 *
 *  Measured 2026-08-18 on 364 non-overlapping blocks: per-basket return at 36h is statistically
 *  identical to 48h (paired t = +0.03) — nothing is given up — but the slot frees 12h earlier, worth
 *  +35% per unit time (2.593%/month -> 3.495%/month at one basket per horizon). 32h-38h is a broad
 *  plateau rather than a single lucky point, which is the main reason this is worth shipping at all. */
const EXEC_MAX_HOLD_MS = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS ?? "");
  return Number.isFinite(n) && n > 0 ? n * 3_600_000 : 0;
};
const EXEC_STOP_NET_RETURN = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_STOP_NET_RETURN ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const TP_NET_RETURN = () => {
  if (TP_DISABLED()) return Number.POSITIVE_INFINITY;
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_TP_NET_RETURN ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0.006;
};
/** Smart Basket v1 entry revalidation is a price-refresh, not another score gate.  A basket waits
 * for the next hourly scan only when a leg ran materially *against* its intended entry between
 * scan and order; ordinary mark movement still executes at the current mark. */
const SMART_MAX_ADVERSE_ENTRY_DRIFT_VOL = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_SMART_MAX_ADVERSE_ENTRY_DRIFT_VOL) || 0.9);
const SMART_MIN_ADVERSE_ENTRY_DRIFT_PCT = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_SMART_MIN_ADVERSE_ENTRY_DRIFT_PCT) || 0.003);
/** A contextual exit needs two distinct fresh scans — one scan is only a warning. */
const SMART_INVALIDATION_SCANS = () => Math.max(2, Math.floor(Number(process.env.CROSS_SECTIONAL_SMART_INVALIDATION_SCANS) || 2));
/** Do not call a tiny cost-level flicker an MFE. This arms only after the basket banked 20bp net. */
const SMART_MFE_ARM_NET_RETURN = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_SMART_MFE_ARM_NET_RETURN) || 0.002);
/** Close a previously healthy basket only after it gives back half its achieved net return AND the
 * two-scan thesis check agrees. */
const SMART_MFE_GIVEBACK_FRACTION = () => Math.min(0.95, Math.max(0.05, Number(process.env.CROSS_SECTIONAL_SMART_MFE_GIVEBACK_FRACTION) || 0.5));
/** A separate, confirmed regime-loss exit for Smart Basket V1.  The usual contextual invalidation
 * remains in force; this catches the simpler and historically painful case where a basket is
 * losing after costs and two fresh scans agree that the market regime has flipped against its
 * currently losing side.  Off unless explicitly enabled on the testnet cohort. */
const SMART_REGIME_LOSS_EXIT_ENABLED = () => process.env.CROSS_SECTIONAL_SMART_REGIME_LOSS_EXIT === "1";
const SMART_REGIME_LOSS_RETURN = () => Math.max(0, Number(process.env.CROSS_SECTIONAL_SMART_REGIME_LOSS_RETURN) || 0.003);
/** Basket-level safety breaker (2026-07-07 operator: "safety net, bukan profit killer"): when the
 *  day's REALIZED basket losses breach this, STOP OPENING new baskets until UTC midnight. Open
 *  baskets keep running their own exits untouched — they are hedged and horizon-bounded, and
 *  force-flattening a hedge that can still recover would be exactly the profit-killer this is
 *  deliberately not. 0 = disabled. */
const XSEC_DAILY_MAX_LOSS_USD = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_DAILY_MAX_LOSS_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export interface ExitFillSlice {
  orderId: string;
  qty: number;
  price: number;
  priceConfirmed: boolean;
  liquidity: "MAKER" | "TAKER";
}

/** Durable maker-first exit audit.  All quantities are actual exchange quantities, never inferred. */
export interface ExitExecutionRecord {
  mode: "MAKER_FIRST" | "MARKET";
  decisionPrice: number | null;
  makerQty: number;
  makerPrice: number | null;
  fallbackQty: number;
  fallbackPrice: number | null;
  makerOrderId: string | null;
  fallbackOrderId: string | null;
  durationMs: number | null;
  temporaryImbalanceUsd: number | null;
  implementationShortfallUsd: number | null;
  feeEstimateUsd: number | null;
  reason: string;
  completedAt: string | null;
}

/** A post-only exit has to survive a process death just as an entry does. */
export interface MakerExitAttempt {
  phase: "PREPARED" | "RESTING" | "FALLBACK_SUBMITTED" | "RECONCILIATION_PENDING";
  requestedQty: number;
  clientOrderId: string;
  makerOrderId: string | null;
  fallbackClientOrderId: string | null;
  fallbackOrderId: string | null;
  makerPrice: number | null;
  decisionPrice: number | null;
  reduceOnly: boolean;
  startedAt: string;
}

type MakerExitCandidate = {
  leg: ExecutorLeg;
  attempt: MakerExitAttempt;
  decisionPrice: number | null;
  makerPrice: number;
  exitSide: "BUY" | "SELL";
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
  /** All exit order ids.  A maker partial plus taker remainder is two exchange orders. */
  exitOrderIds?: string[];
  /** Same caveat as entryPriceConfirmed, for the exit fill. Null while still open. */
  exitPriceConfirmed: boolean | null;
  /** Index into ExecutorBasket.plan this fill resolves — legs are always pushed in strict plan
   *  order (see placeRemainingLegs), so legs[k] always resolves plan[k] for k < legs.length, but
   *  this makes that pairing explicit rather than implicit-by-array-position. Optional: baskets
   *  persisted before `plan` existed (or test fixtures that never exercise the open/recovery path)
   *  never carry it, and nothing reads it as load-bearing — purely a debugging/audit aid. */
  planIndex?: number;
  /** Frozen signal metadata for overlap admission and after-close cohort evaluation. */
  signalWeight?: number | null;
  scoreAtOpen?: number | null;
  volatilityAtOpen?: number | null;
  targetNotionalUsd?: number | null;
  /** Restart-durable per-leg excursion path, measured in frozen R. Observational only. */
  maxFavorableR?: number | null;
  maxAdverseR?: number | null;
  lastMarkPrice?: number | null;
  lastMarkAt?: string | null;
  /** Path starts only at the first observed mark; legacy legs never get invented history. */
  pathStartedAt?: string | null;
  /** Two-sided book quote captured immediately before this leg's placeOrder, so execution
   *  cost can be split into the spread it had to cross and the slippage it actually took.
   *  Absent when no fresh quote was available — never back-filled from mark, which would
   *  silently fold half the spread into 'slippage'. See submit-reference-quote.ts. */
  submitRef?: SubmitRef | null;
  /** How this leg's ENTRY was actually filled, split by liquidity.
   *
   *  EXACT, not an estimate: a GTX order is rejected outright by Binance if it would cross, so it
   *  can only ever fill as maker; a MARKET order can only ever fill as taker. The split therefore
   *  follows from which order filled which quantity, and needs no per-fill lookup to be true.
   *
   *  ABSENT on every leg opened before 2026-08-16 — the code could place nothing but MARKET then,
   *  so absence means taker, and readers must render it as such rather than as unknown. Exits are
   *  still MARKET on every path, so there is deliberately no exit counterpart to this field. */
  entryLiquidity?: { makerQty: number; takerQty: number; reason: string } | null;
  /** Filled portions from a partial maker/taker close.  Used to avoid ever re-closing a filled lot. */
  exitFills?: ExitFillSlice[];
  /** Present between durable pre-place and final close for maker-first exits. */
  makerExitAttempt?: MakerExitAttempt | null;
  /** Full execution economics for this leg's exit. */
  exitExecution?: ExitExecutionRecord | null;
  /** Flat fields retained for control/report readers that predate exitExecution. */
  exitDecisionPrice?: number | null;
  exitMakerQty?: number | null;
  exitMakerPrice?: number | null;
  exitFallbackQty?: number | null;
  exitFallbackPrice?: number | null;
}

export interface SmartBasketRuntime {
  version: "SMART_BASKET_V1";
  sourceOpenedAtMs: number;
  axisScoreAtOpen: number | null;
  /** Net MFE measured from live marks after the same cost model used by the TP check. */
  maxNetReturn: number | null;
  maxNetAt: string | null;
  /** Highest source scan already evaluated for a two-scan invalidation. */
  lastInvalidationSignalMs: number;
  consecutiveInvalidationScans: number;
  lastInvalidationReason: string | null;
  /** Original canonical bucket, frozen at open. Missing on legacy Smart Basket records means this
   * new exit simply does not infer a regime history that was never stored. */
  regimeClassAtOpen?: "TREND_LONG" | "TREND_SHORT" | "MIXED_CHOP" | "UNKNOWN" | null;
  /** Distinct post-entry scans that confirm a regime flip while the corresponding basket side is
   * losing. Two are required before the loss exit can act. */
  lastRegimeLossSignalMs?: number;
  consecutiveRegimeLossScans?: number;
  lastRegimeLossReason?: string | null;
  /** Pre-order marks used for re-pricing/auditing the exact fill attempt. */
  entryRevalidatedAt: string | null;
  entryReferencePrices: Record<string, number>;
}

interface SmartEntryRevalidation {
  allowed: boolean;
  reason: string | null;
  at: string | null;
  referencePrices: Record<string, number>;
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
  /** The intended dollar allocation after the signal's side-neutral sizing weights. */
  targetNotionalUsd?: number | null;
  signalWeight?: number | null;
  scoreAtOpen?: number | null;
  volatilityAtOpen?: number | null;
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
  /** Set ONLY when maker entry is enabled and the post-only order did not fill in full, persisted
   *  BEFORE the taker fallback is submitted. Without it a crash between the two placements would
   *  leave recovery querying the maker id, finding it CANCELED, and never discovering a fallback
   *  order that did reach the exchange — the exact "invisible naked position" this file's
   *  reconciliation was built to prevent. */
  /** Set by the parallel pre-place pass: the post-only order for this leg is ALREADY resting on
   *  the exchange. The sequential loop then skips straight to cancel/re-query/fallback instead of
   *  placing a second one. Persisted because a crash between the pre-place and the loop must leave
   *  recovery able to find the resting order — which it does via entryClientOrderId, unchanged. */
  makerRestingOrderId?: string;
  /** Limit price the resting order was posted at, kept so a fill whose avgPrice never confirms can
   *  still be booked at the price we actually rested at rather than a guess. */
  makerRestingPrice?: number;
  /** submitRef captured at PRE-PLACE time. Without this the loop would stamp it minutes later and
   *  `ageAtSubmitMs` would describe a quote the order never saw. */
  makerSubmitRef?: SubmitRef | null;
  takerFallbackClientOrderId?: string;
  /** Report-only record of how this leg was actually filled, so the maker/taker split can be read
   *  back from the basket store without joining to exchange trades. */
  makerOutcome?: { action: string; reason: string; makerQty: number; takerQty: number };
  status: "PENDING" | "PLACING" | "FILLED" | "FAILED" | "NEVER_ATTEMPTED";
  failureReason: string | null;
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
  /** Entry liquidity split. `null` means this leg predates maker entry, which by construction of
   *  the code at the time means it was filled entirely as taker — never "unknown". */
  entryLiquidity: { makerQty: number; takerQty: number; reason: string } | null;
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
        entryLiquidity: l.entryLiquidity ?? null,
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

export type FormationEvaluationMetric = {
  model: "EQUAL_NOTIONAL" | "CAPPED_INVERSE_VOL" | "CAPPED_INVERSE_VOL_SCORE_TILT";
  samples: number;
  meanNetReturnPct: number | null;
  winRatePct: number | null;
  worstNetReturnPct: number | null;
};

/** Sizing-only closed-fill counterfactual. It never changes live selection or execution. */
export function evaluateCrossSectionalFormationCohort(
  baskets: ExecutorBasket[],
  eligibleBasketIds?: ReadonlySet<string>,
): {
  activationClosedBaskets: number;
  closedBaskets: number;
  status: "COLLECTING" | "EVALUATING";
  autoSwitch: false;
  metrics: FormationEvaluationMetric[];
} {
  const closed = baskets.filter((basket) =>
    (eligibleBasketIds === undefined || eligibleBasketIds.has(basket.basketId)) &&
    basket.status === "CLOSED" &&
    basket.accountingStatus !== "ACCOUNTING_INCOMPLETE" &&
    !isCrossSectionalBasketReportingExcluded(basket) &&
    basket.legs.length > 0 && basket.legs.every((leg) =>
    leg.exitPrice !== null && leg.entryPrice > 0 && Number.isFinite(leg.volatilityAtOpen) && leg.volatilityAtOpen! > 0 && Number.isFinite(leg.scoreAtOpen),
    ),
  );
  const models: FormationEvaluationMetric["model"][] = ["EQUAL_NOTIONAL", "CAPPED_INVERSE_VOL", "CAPPED_INVERSE_VOL_SCORE_TILT"];
  const returns = new Map(models.map((model) => [model, [] as number[]]));
  for (const basket of closed) {
    const sides: Array<["LONG" | "SHORT", ExecutorLeg[]]> = [["LONG", basket.legs.filter((leg) => leg.side === "LONG")], ["SHORT", basket.legs.filter((leg) => leg.side === "SHORT")]];
    if (sides.some(([, legs]) => legs.length === 0)) continue;
    const entryNotional = basket.legs.reduce((sum, leg) => sum + leg.entryPrice * leg.qty, 0);
    const feeRate = entryNotional > 0 && Number.isFinite(basket.feeEstimateUsd) ? basket.feeEstimateUsd! / entryNotional : 0;
    for (const model of models) {
      let net = -feeRate;
      for (const [side, legs] of sides) {
        let raw = model === "EQUAL_NOTIONAL" ? legs.map(() => 1) : legs.map((leg) => 1 / leg.volatilityAtOpen!);
        const meanRaw = raw.reduce((sum, value) => sum + value, 0) / raw.length || 1;
        raw = raw.map((value) => Math.max(0.75, Math.min(1.25, value / meanRaw)));
        if (model === "CAPPED_INVERSE_VOL_SCORE_TILT") {
          const scores = legs.map((leg) => leg.scoreAtOpen!);
          const low = Math.min(...scores);
          const high = Math.max(...scores);
          raw = raw.map((value, index) => {
            const rank = high > low ? (side === "LONG" ? (scores[index]! - low) / (high - low) : (high - scores[index]!) / (high - low)) : 0.5;
            return value * (0.9 + 0.2 * rank);
          });
        }
        const denom = raw.reduce((sum, value) => sum + value, 0) || legs.length;
        for (let index = 0; index < legs.length; index++) {
          const leg = legs[index]!;
          const legReturn = side === "LONG" ? (leg.exitPrice! - leg.entryPrice) / leg.entryPrice : (leg.entryPrice - leg.exitPrice!) / leg.entryPrice;
          net += 0.5 * raw[index]! / denom * legReturn;
        }
      }
      returns.get(model)!.push(net * 100);
    }
  }
  return {
    activationClosedBaskets: 8,
    closedBaskets: closed.length,
    status: closed.length >= 8 ? "EVALUATING" : "COLLECTING",
    autoSwitch: false,
    metrics: models.map((model) => {
      const rows = returns.get(model)!;
      return {
        model,
        samples: rows.length,
        meanNetReturnPct: rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null,
        winRatePct: rows.length ? rows.filter((value) => value > 0).length / rows.length * 100 : null,
        worstNetReturnPct: rows.length ? Math.min(...rows) : null,
      };
    }),
  };
}

export interface ExecutorBasket {
  basketId: string;
  sourceObservationId: string;
  signal: string;
  variant: string;
  openedAt: string;
  closesAtMs: number;
  /** Full policy contract frozen before any entry order is sent. Undefined means legacy. */
  policyFingerprint?: CrossSectionalPolicyFingerprint | null;
  /** Optional observation-owned basket geometry, enabled only for dedicated innovation executors. */
  takeProfitReturn?: number | null;
  stopLossReturn?: number | null;
  /** Frozen at admission so per-leg path telemetry survives restarts. */
  riskDistanceAtOpen?: number | null;
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
  /** Set ONLY at one site: closeBasket()'s staleBookReconciled branch, when a leg was closed
   *  OUT-OF-BAND (e.g. by POST /api/live/flatten-exchange's flattenAllExchangePositions(), a
   *  SEPARATE raw close path that never touches this store — see that function's own doc comment)
   *  and this basket's own bookkeeping only learns about it later, via a -2022/"already flat"
   *  reconciliation with no real fill/exit price to compute a return from. Orthogonal to `status`
   *  above (that stays ABORTED for its own lifecycle purposes) — this is a SEPARATE axis: whether
   *  the basket's P&L is a known number or a genuinely UNKNOWN one. It never replaces `status` and
   *  is never coerced to 0 — a $0 return and an UNKNOWN return are different facts. Every consumer
   *  reading closed-basket P&L for learning/PF/WR/promotion/CORTEX-label purposes MUST exclude a
   *  basket carrying this flag (`=== "ACCOUNTING_INCOMPLETE"`), never zero-fill it. undefined for
   *  every normal basket — no migration needed, same optional-field convention as feeSource above. */
  accountingStatus?: "ACCOUNTING_INCOMPLETE";
  /** A basket reaches CLOSED only after its final exchange/ledger reconciliation passes. */
  exitReconciliation?: {
    state: "CONFIRMED" | "PENDING";
    checkedAt: string;
    residualBySymbol: Array<{ symbol: string; expectedNetQty: number; exchangeNetQty: number }>;
  } | null;
  /** Stamped by every profit-target check (5-min tick): the basket's CURRENT net return vs the
   *  TP threshold, so the dashboard can show the live TP gap per basket — "tinggal berapa lagi,
   *  bakal nyampe atau engga, ada yang macet atau engga" (2026-07-07 operator ask). */
  lastNetReturn?: number | null;
  lastNetAt?: string | null;
  /** Present only for FILTERED baskets born from the testnet Smart Basket v1 formation policy.
   * Legacy/open baskets deliberately do not receive this field, so their lifecycle stays exactly
   * as it was when they were admitted. */
  smartBasket?: SmartBasketRuntime | null;
  /** Admission evidence frozen immediately before this NEW basket was reserved. Legacy baskets
   * intentionally lack it: no old position is retroactively relabelled as a learning trade. */
  entryAdmission?: CrossSectionalEntryAdmission | null;
  /** CORTEX real-USDT attribution capture-at-open (2026-07-22 bug-hunt fix): the applied vs
   *  raw-static allocation weight, frozen the instant the basket opens — same convention as
   *  SingleSymbolPosition's cortexAppliedWeightPct/cortexRawStaticWeightPct in
   *  single-symbol-lane-executor.ts. Optional so baskets persisted before this field existed are
   *  never retroactively assigned an invented tilt share. */
  cortexAppliedWeightPct?: number;
  cortexRawStaticWeightPct?: number;
  /**
   * A deliberate operator void for reporting/learning only.  The executed Binance orders and
   * every fill remain in their raw audit stores; ordinary P&L, timeline, edge, and promotion
   * readers must act as though this closed basket never happened.
   *
   * This is intentionally separate from accountingStatus: ACCOUNTING_INCOMPLETE means the P&L is
   * unknown, while OPERATOR_VOID means the known P&L is deliberately excluded from the selected
   * testnet evidence cohort.
   */
  reportingExclusion?: {
    kind: "OPERATOR_VOID";
    voidedAt: string;
    reason: string;
  } | null;
}

/** True when a closed basket is retained for audit but must never influence normal reporting or learning. */
export function isCrossSectionalBasketReportingExcluded(
  basket: Pick<ExecutorBasket, "reportingExclusion">,
): boolean {
  return basket.reportingExclusion?.kind === "OPERATOR_VOID";
}

export type CurrentPolicyForwardCohort = {
  policyId: string;
  startedAt: string | null;
  validCohortN: number;
  currentOpenN: number;
  independentEpisodes: number;
  validBasketIds: string[];
  excludedN: number;
  excludedReasons: Record<string, number>;
};

const isOperatorControlledClose = (reason: string | null): boolean =>
  /^(?:OPERATOR_|KILL_SWITCH|KILL_OR_DRAIN|DRAIN|MANUAL_)/.test(reason ?? "");

/**
 * Evidence is deliberately stricter than history.  Historical baskets remain in the ledger, but
 * only fully accounted, current-policy, non-operator closed baskets may influence formation or
 * weighting research after this cutover.
 */
export function currentPolicyForwardCohort(
  baskets: readonly ExecutorBasket[],
  currentPolicy: CrossSectionalPolicyFingerprint,
): CurrentPolicyForwardCohort {
  const startedAtMs = currentPolicy.forwardCohortStartedAt ? Date.parse(currentPolicy.forwardCohortStartedAt) : Number.NaN;
  const valid: ExecutorBasket[] = [];
  const excludedReasons: Record<string, number> = {};
  let currentOpenN = 0;
  const exclude = (reason: string) => { excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1; };

  for (const basket of baskets) {
    if (basket.status !== "CLOSED" && basket.status !== "ABORTED") {
      if (basket.policyFingerprint?.policyId === currentPolicy.policyId) currentOpenN += 1;
      continue;
    }
    if (basket.status === "ABORTED") { exclude("ABORTED"); continue; }
    if (basket.accountingStatus === "ACCOUNTING_INCOMPLETE") { exclude("ACCOUNTING_INCOMPLETE"); continue; }
    if (isCrossSectionalBasketReportingExcluded(basket)) { exclude("REPORTING_EXCLUDED"); continue; }
    if (!basket.policyFingerprint) { exclude("LEGACY_NO_FINGERPRINT"); continue; }
    if (basket.policyFingerprint.policyId !== currentPolicy.policyId) { exclude("INCOMPATIBLE_POLICY"); continue; }
    const openedAtMs = Date.parse(basket.openedAt);
    if (Number.isFinite(startedAtMs) && (!Number.isFinite(openedAtMs) || openedAtMs < startedAtMs)) { exclude("PRE_COHORT_START"); continue; }
    if (isOperatorControlledClose(basket.closeReason)) { exclude("OPERATOR_CLOSE"); continue; }
    valid.push(basket);
  }

  let independentEpisodes = 0;
  let occupiedUntilMs = Number.NEGATIVE_INFINITY;
  for (const basket of [...valid].sort((left, right) => Date.parse(left.openedAt) - Date.parse(right.openedAt))) {
    const openedAtMs = Date.parse(basket.openedAt);
    const closedAtMs = Date.parse(basket.closedAt ?? basket.openedAt);
    if (!Number.isFinite(openedAtMs)) continue;
    if (openedAtMs >= occupiedUntilMs) independentEpisodes += 1;
    occupiedUntilMs = Math.max(occupiedUntilMs, Number.isFinite(closedAtMs) ? closedAtMs : openedAtMs);
  }
  return {
    policyId: currentPolicy.policyId,
    startedAt: currentPolicy.forwardCohortStartedAt,
    validCohortN: valid.length,
    currentOpenN,
    independentEpisodes,
    validBasketIds: valid.map((basket) => basket.basketId),
    excludedN: Object.values(excludedReasons).reduce((sum, count) => sum + count, 0),
    excludedReasons,
  };
}

export interface CrossSectionalLossReentryBlock {
  symbol: string;
  side: "LONG" | "SHORT";
  grossUnrealizedUsd: number | null;
  estimatedCloseCostUsd: number | null;
  afterEstimatedCloseCostUsd: number | null;
  reason: "LOSING_AFTER_CLOSE_COST" | "MARK_UNAVAILABLE";
}

/** Pure P&L rule shared by signal selection and the final pre-order executor check. */
export function lossMakingCrossSectionalOpenLegs(
  baskets: ExecutorBasket[],
  markBySymbol: Record<string, number>,
  estimatedCloseCostPct: number,
): CrossSectionalLossReentryBlock[] {
  const aggregate = new Map<string, { symbol: string; side: "LONG" | "SHORT"; gross: number; cost: number; missingMark: boolean }>();
  for (const basket of baskets) {
    if (basket.status === "CLOSED" || basket.status === "ABORTED") continue;
    for (const leg of basket.legs) {
      if (leg.exitOrderId !== null) continue;
      const key = `${leg.symbol}|${leg.side}`;
      const current = aggregate.get(key) ?? { symbol: leg.symbol, side: leg.side, gross: 0, cost: 0, missingMark: false };
      const mark = markBySymbol[leg.symbol];
      if (!(Number.isFinite(mark) && mark > 0)) current.missingMark = true;
      else {
        const sign = leg.side === "LONG" ? 1 : -1;
        current.gross += (mark - leg.entryPrice) * leg.qty * sign;
        current.cost += mark * leg.qty * estimatedCloseCostPct;
      }
      aggregate.set(key, current);
    }
  }
  return [...aggregate.values()]
    .flatMap((entry): CrossSectionalLossReentryBlock[] => {
      if (entry.missingMark) {
        return [{ symbol: entry.symbol, side: entry.side, grossUnrealizedUsd: null, estimatedCloseCostUsd: null, afterEstimatedCloseCostUsd: null, reason: "MARK_UNAVAILABLE" }];
      }
      const after = entry.gross - entry.cost;
      return after < 0
        ? [{ symbol: entry.symbol, side: entry.side, grossUnrealizedUsd: entry.gross, estimatedCloseCostUsd: entry.cost, afterEstimatedCloseCostUsd: after, reason: "LOSING_AFTER_CLOSE_COST" }]
        : [];
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.side.localeCompare(b.side));
}

export type CrossSectionalOverlapDecision = { allowed: boolean; reason: string | null; repeatedSymbols: string[] };

/**
 * Keeps persistent momentum from silently stacking into one name. A repeat is accepted only if
 * its live predecessor is non-negative after estimated close cost AND its score is more extreme.
 * A legacy predecessor without a frozen score cannot prove a score improvement. It may therefore
 * use the compatibility path only with a stronger fresh absolute score; its persisted history is
 * never backfilled or rewritten.
 */
export function evaluateCrossSectionalOverlap(
  signal: CrossSectionalObservation,
  baskets: ExecutorBasket[],
  markBySymbol: Record<string, number>,
  estimatedCloseCostPct: number,
  limits: {
    maxTotal: number;
    maxPerSide: number;
    minScoreDelta: number;
    minAbsScore?: number;
    maxAdverseExtensionVol?: number;
    minAdverseExtensionPct?: number;
    maxSignalDriftVol?: number;
    minSignalDriftPct?: number;
  },
): CrossSectionalOverlapDecision {
  const live = baskets.filter((basket) => basket.status !== "CLOSED" && basket.status !== "ABORTED");
  const repeated: string[] = [];
  const sideCounts = new Map<"LONG" | "SHORT", number>([["LONG", 0], ["SHORT", 0]]);
  for (const [side, candidates] of [["LONG", signal.longLeg], ["SHORT", signal.shortLeg]] as const) {
    for (const candidate of candidates) {
      const existing = live.flatMap((basket) => basket.legs.filter((leg) => leg.exitOrderId === null && leg.symbol === candidate.symbol));
      if (!existing.length) continue;
      if (existing.some((leg) => leg.side !== side)) return { allowed: false, reason: `overlap guard: ${candidate.symbol} already has opposite-side exposure`, repeatedSymbols: repeated };
      if (!Number.isFinite(candidate.scoreAtOpen)) return { allowed: false, reason: `overlap guard: ${candidate.symbol} has no frozen new score`, repeatedSymbols: repeated };
      // Old rows created before per-leg score persistence cannot participate in the normal
      // "new score must improve on the old score" comparison. Do not invent a historical score:
      // require the fresh continuation to clear the normal absolute floor PLUS the configured
      // improvement margin. Known predecessors still retain their exact pairwise comparison below.
      const hasLegacyPredecessor = existing.some((leg) => !Number.isFinite(leg.scoreAtOpen));
      const requiredAbsScore = Math.max(0, limits.minAbsScore ?? 0) + (hasLegacyPredecessor ? Math.max(0, limits.minScoreDelta) : 0);
      const correctDirection = side === "LONG" ? candidate.scoreAtOpen! > 0 : candidate.scoreAtOpen! < 0;
      if (!correctDirection || Math.abs(candidate.scoreAtOpen!) < requiredAbsScore) {
        const reason = hasLegacyPredecessor
          ? `overlap guard: ${candidate.symbol} legacy predecessor requires stronger continuation conviction`
          : `overlap guard: ${candidate.symbol} continuation conviction is insufficient`;
        return { allowed: false, reason, repeatedSymbols: repeated };
      }
      if (!(Number.isFinite(candidate.entryPrice) && candidate.entryPrice > 0)) {
        return { allowed: false, reason: `overlap guard: ${candidate.symbol} fresh signal price unavailable`, repeatedSymbols: repeated };
      }
      let gross = 0;
      let closeCost = 0;
      for (const leg of existing) {
        const mark = markBySymbol[leg.symbol];
        if (!(Number.isFinite(mark) && mark > 0)) return { allowed: false, reason: `overlap guard: ${candidate.symbol} mark unavailable`, repeatedSymbols: repeated };
        const adverseExtensionEnabled = (limits.maxAdverseExtensionVol ?? 0) > 0 || (limits.minAdverseExtensionPct ?? 0) > 0;
        const signalDriftEnabled = (limits.maxSignalDriftVol ?? 0) > 0 || (limits.minSignalDriftPct ?? 0) > 0;
        const volatility = Math.max(
          Number.isFinite(candidate.volatilityAtOpen) && candidate.volatilityAtOpen! > 0 ? candidate.volatilityAtOpen! : 0,
          Number.isFinite(leg.volatilityAtOpen) && leg.volatilityAtOpen! > 0 ? leg.volatilityAtOpen! : 0,
        );
        if ((adverseExtensionEnabled || signalDriftEnabled) && volatility <= 0) {
          return { allowed: false, reason: `overlap guard: ${candidate.symbol} lacks volatility for normal-price check`, repeatedSymbols: repeated };
        }
        const adverseExtensionPct = Math.max(
          limits.minAdverseExtensionPct ?? 0,
          volatility * (limits.maxAdverseExtensionVol ?? 0),
        );
        const signalDriftPct = Math.max(
          limits.minSignalDriftPct ?? 0,
          volatility * (limits.maxSignalDriftVol ?? 0),
        );
        const extensionFromOldEntry = side === "LONG" ? mark / leg.entryPrice - 1 : 1 - mark / leg.entryPrice;
        if (adverseExtensionEnabled && extensionFromOldEntry > adverseExtensionPct) {
          return { allowed: false, reason: `overlap guard: ${candidate.symbol} mark is overextended versus old entry`, repeatedSymbols: repeated };
        }
        const driftFromFreshSignal = side === "LONG" ? mark / candidate.entryPrice - 1 : 1 - mark / candidate.entryPrice;
        if (signalDriftEnabled && driftFromFreshSignal > signalDriftPct) {
          return { allowed: false, reason: `overlap guard: ${candidate.symbol} mark ran away from fresh signal`, repeatedSymbols: repeated };
        }
        // Compatibility rows are covered by requiredAbsScore above. For rows that did record a
        // score, retain the normal per-predecessor comparison exactly as before.
        if (Number.isFinite(leg.scoreAtOpen)) {
          const improved = side === "LONG"
            ? candidate.scoreAtOpen! > leg.scoreAtOpen! + limits.minScoreDelta
            : candidate.scoreAtOpen! < leg.scoreAtOpen! - limits.minScoreDelta;
          if (!improved) return { allowed: false, reason: `overlap guard: ${candidate.symbol} score did not improve`, repeatedSymbols: repeated };
        }
        gross += (mark - leg.entryPrice) * leg.qty * (side === "LONG" ? 1 : -1);
        closeCost += mark * leg.qty * Math.max(0, estimatedCloseCostPct);
      }
      if (gross - closeCost < 0) return { allowed: false, reason: `overlap guard: ${candidate.symbol} open leg is negative after close cost`, repeatedSymbols: repeated };
      repeated.push(`${candidate.symbol} ${side}`);
      sideCounts.set(side, (sideCounts.get(side) ?? 0) + 1);
    }
  }
  if (repeated.length > limits.maxTotal) return { allowed: false, reason: `overlap guard: ${repeated.length} repeats exceeds total cap ${limits.maxTotal}`, repeatedSymbols: repeated };
  if ([...sideCounts.values()].some((count) => count > limits.maxPerSide)) return { allowed: false, reason: `overlap guard: repeats exceeds per-side cap ${limits.maxPerSide}`, repeatedSymbols: repeated };
  return { allowed: true, reason: null, repeatedSymbols: repeated };
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

/** Durable, compact audit trail for the traffic-light decision. `ADMITTED` means the full basket
 * plan was successfully reserved; exchange fills remain visible separately on the basket itself.
 * This distinction avoids ever reporting a planned order as a confirmed fill. */
export interface CrossSectionalEntryAdmissionEvent {
  at: string;
  sourceObservationId: string;
  tier: CrossSectionalEntryAdmission["tier"];
  allowed: boolean;
  learning: boolean;
  sizeMultiplier: number;
  reason: string | null;
  outcome: "ADMITTED" | "BLOCKED";
}

/**
 * Durable explanation for every fresh signal the executor actually evaluates.  This is deliberately
 * separate from EntryAdmissionEvent: an entry can clear the traffic light and still be skipped by
 * a later guard (smart price refresh, overlap, shared exposure, or sizing).  Before this record
 * existed those later paths advanced lastSeenSignalMs and the original reason vanished on the next
 * tick when openHalted was cleared.
 *
 * `ADMITTED` means the basket plan was persisted as RESERVED, not that Binance fills are confirmed.
 * `DEFERRED` leaves the signal eligible for the next tick; `SKIPPED` advances the watermark and
 * waits for a genuinely fresh scan.  Thus the audit describes execution truth without changing
 * retry or risk behavior.
 */
export type CrossSectionalEntryAttemptStage =
  | "ENTRY_ADMISSION"
  | "FOUR_BRAIN_BRIDGE"
  | "LOSS_REENTRY_GUARD"
  | "OVERLAP_GUARD"
  | "SMART_ENTRY_REVALIDATION"
  | "EXCHANGE_FILTERS"
  | "SIZING"
  | "NOTIONAL_CAP"
  | "EXPOSURE_RESERVATION"
  | "NETTING_GUARD"
  | "BASKET_RESERVED";

export interface CrossSectionalEntryAttemptEvent {
  at: string;
  sourceObservationId: string;
  sourceOpenedAtMs: number;
  variant: string;
  signal: string;
  longSymbols: string[];
  shortSymbols: string[];
  stage: CrossSectionalEntryAttemptStage;
  outcome: "ADMITTED" | "DEFERRED" | "SKIPPED";
  /** Human-readable, exact guard/exchange reason. Null only for a successful reservation. */
  reason: string | null;
  /** Live marks used by Smart Basket refresh when they were available. */
  referencePrices: Record<string, number>;
  /** Whether the signal was made ineligible for retry by lastSeenSignalMs. */
  watermarkAdvanced: boolean;
}

interface ExecutorState {
  version: number;
  baskets: ExecutorBasket[];
  /** openedAtMs watermark — signals at/below this are never re-executed. */
  lastSeenSignalMs: number;
  /** See OrphanedLeg's doc comment. Persisted so a restart doesn't lose track of a still-exposed
   *  position — same convention as live-execution-engine.ts's killSwitchFlattenFailedIntentIds. */
  orphanedLegs: OrphanedLeg[];
  /** Bounded, restart-durable traffic-light audit. Legacy files have no field and migrate to []. */
  entryAdmissions?: CrossSectionalEntryAdmissionEvent[];
  /** Bounded, restart-durable explanation for post-admission skips and successful reservations. */
  entryAttempts?: CrossSectionalEntryAttemptEvent[];
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
          if (!Array.isArray((parsed as { entryAdmissions?: unknown }).entryAdmissions)) {
            (parsed as { entryAdmissions: CrossSectionalEntryAdmissionEvent[] }).entryAdmissions = [];
          }
          if (!Array.isArray((parsed as { entryAttempts?: unknown }).entryAttempts)) {
            (parsed as { entryAttempts: CrossSectionalEntryAttemptEvent[] }).entryAttempts = [];
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
    return {
      version: 1,
      baskets: [],
      lastSeenSignalMs: this.initialLastSeenSignalMs,
      orphanedLegs: [],
      entryAdmissions: [],
      entryAttempts: [],
    };
  }

  getState(): ExecutorState {
    return this.state;
  }

  /** Reporting projection only. Raw state remains available through getState() for technical audit. */
  getReportableBaskets(): ExecutorBasket[] {
    return this.state.baskets.filter((basket) => !isCrossSectionalBasketReportingExcluded(basket));
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

/**
 * Persist an auditable reporting void without deleting exchange/order evidence.  Kept as a store
 * helper (rather than a dashboard action) so a one-off correction is explicit, reviewable, and
 * cannot accidentally send a trading instruction.
 */
export function voidClosedCrossSectionalBasketForReporting(
  store: CrossSectionalExecutorStore,
  basketId: string,
  opts: { reason: string; voidedAt?: string },
):
  | { ok: true; alreadyVoided: boolean; basketId: string; sourceObservationId: string }
  | { ok: false; reason: string } {
  const normalizedBasketId = basketId.trim();
  const reason = opts.reason.trim();
  if (!normalizedBasketId) return { ok: false, reason: "basketId is required" };
  if (!reason) return { ok: false, reason: "void reason is required" };
  const basket = store.getState().baskets.find((candidate) => candidate.basketId === normalizedBasketId);
  if (!basket) return { ok: false, reason: `basket ${normalizedBasketId} not found` };
  if (basket.status !== "CLOSED") return { ok: false, reason: `basket ${normalizedBasketId} is ${basket.status}, only CLOSED baskets can be voided` };
  if (isCrossSectionalBasketReportingExcluded(basket)) {
    return { ok: true, alreadyVoided: true, basketId: basket.basketId, sourceObservationId: basket.sourceObservationId };
  }
  basket.reportingExclusion = {
    kind: "OPERATOR_VOID",
    voidedAt: opts.voidedAt ?? new Date().toISOString(),
    reason,
  };
  store.save();
  return { ok: true, alreadyVoided: false, basketId: basket.basketId, sourceObservationId: basket.sourceObservationId };
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
  /** Synchronous, zero-I/O read of the shared per-symbol quote cache (app.ts). */
  readPublicQuote?: (symbol: string) => { bid: number | null; ask: number | null; mid: number; atMs: number; venue?: string } | null;
  /** Populates that cache for one symbol. Awaited immediately before placeOrder so the
   *  reference belongs to THIS submission; failure is swallowed and the order proceeds. */
  warmPublicQuote?: (symbol: string) => Promise<unknown>;
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
  /** Optional per-instance scope for the bounded traffic light. Defaults to the foundation
   * FILTERED lane only, so enabling its cold-start learning cohort cannot accidentally change
   * TREND/MIXED companion-lane admission. */
  entryTrafficLightEnabled?: () => boolean;
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
  /** Exact Four-Brain decision -> actual fill provenance. Telemetry only; omitted outside the
   * deliberately-scoped testnet cohort. */
  fourBrainActualFillBindings?: FourBrainActualFillBindingStore;
  /** Narrow testnet pilot gate. It may only veto a new basket on mature NEGATIVE exact-fill
   * evidence; missing or failed bridge input always leaves the incumbent executor unchanged. */
  fourBrainEntryGate?: (candidate: FourBrainBridgeCandidate) => FourBrainBridgeDecision;
  /** Per-instance sizing/cadence overrides. Existing executors retain the global defaults. */
  legUsd?: () => number;
  leverage?: () => number;
  maxOpenBaskets?: () => number;
  maxSignalAgeMs?: () => number;
  /** Testnet loss-re-entry guard controls; unset means the process env controls it. */
  lossReentryGuardEnabled?: () => boolean;
  estimatedCloseCostPct?: () => number;
  overlapGuardEnabled?: () => boolean;
  maxOverlappingSymbols?: () => number;
  maxOverlappingSymbolsPerSide?: () => number;
  overlapMinScoreDelta?: () => number;
  overlapMinAbsScore?: () => number;
  overlapMaxAdverseExtensionVol?: () => number;
  overlapMinAdverseExtensionPct?: () => number;
  overlapMaxSignalDriftVol?: () => number;
  overlapMinSignalDriftPct?: () => number;
  /** Prevents client-order-id collisions between isolated innovation stores sharing a timestamp. */
  idNamespace?: string;
  /** Honor signal-owned basket TP/SL. Off by default so existing live behavior is unchanged. */
  respectSignalRiskGeometry?: boolean;
  /** Smart Basket v1 is enabled only for the dedicated FILTERED testnet cohort.  The signal must
   * carry explicit SMART_BASKET_V1 provenance too; either condition missing is a no-op. */
  smartBasketEnabled?: () => boolean;
  smartMaxAdverseEntryDriftVol?: () => number;
  smartMinAdverseEntryDriftPct?: () => number;
  smartInvalidationScans?: () => number;
  smartMfeArmNetReturn?: () => number;
  smartMfeGivebackFraction?: () => number;
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
  private readonly readPublicQuoteFn: CrossSectionalExecutorOptions["readPublicQuote"] | null;
  private readonly warmPublicQuoteFn: CrossSectionalExecutorOptions["warmPublicQuote"] | null;
  private readonly targetVariant: string;
  private readonly laneId: string;
  private ticking = false;
  private lastError: string | null = null;
  private openHalted: string | null = null;
  /** See claimBasket/releaseBasket's own doc comment (ground truth #8, concurrent-close race). */
  private busyBasketIds = new Set<string>();
  private readonly dailyMaxLossUsdFn: () => number;
  private readonly entryHealthGate: () => { allowed: boolean; reason: string | null };
  private readonly entryTrafficLightEnabledFn: () => boolean;
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
  private readonly fourBrainActualFillBindings: FourBrainActualFillBindingStore | null;
  private readonly fourBrainEntryGate: ((candidate: FourBrainBridgeCandidate) => FourBrainBridgeDecision) | null;
  private readonly legUsdFn: () => number;
  private readonly leverageFn: () => number;
  private readonly maxOpenBasketsFn: () => number;
  private readonly maxSignalAgeMsFn: () => number;
  private readonly lossReentryGuardEnabledFn: () => boolean;
  private readonly estimatedCloseCostPctFn: () => number;
  private readonly overlapGuardEnabledFn: () => boolean;
  private readonly maxOverlappingSymbolsFn: () => number;
  private readonly maxOverlappingSymbolsPerSideFn: () => number;
  private readonly overlapMinScoreDeltaFn: () => number;
  private readonly overlapMinAbsScoreFn: () => number;
  private readonly overlapMaxAdverseExtensionVolFn: () => number;
  private readonly overlapMinAdverseExtensionPctFn: () => number;
  private readonly overlapMaxSignalDriftVolFn: () => number;
  private readonly overlapMinSignalDriftPctFn: () => number;
  private readonly idNamespace: string;
  private readonly respectSignalRiskGeometry: boolean;
  private readonly smartBasketEnabledFn: () => boolean;
  private readonly smartMaxAdverseEntryDriftVolFn: () => number;
  private readonly smartMinAdverseEntryDriftPctFn: () => number;
  private readonly smartInvalidationScansFn: () => number;
  private readonly smartMfeArmNetReturnFn: () => number;
  private readonly smartMfeGivebackFractionFn: () => number;
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
    this.readPublicQuoteFn = opts.readPublicQuote ?? null;
    this.warmPublicQuoteFn = opts.warmPublicQuote ?? null;
    this.fillConfirmRetryDelayMs = opts.fillConfirmRetryDelayMs ?? 400;
    this.existingNotionalForSymbolFn = opts.existingNotionalForSymbol ?? (() => 0);
    this.maxNotionalPerSymbolAcrossLanesFn = opts.maxNotionalPerSymbolAcrossLanes ?? (() => 0);
    this.reserveExposureFn = opts.reserveExposure ?? (() => ({ ok: true, reservationId: null }));
    this.commitExposureReservationFn = opts.commitExposureReservation ?? (() => {});
    this.releaseExposureReservationFn = opts.releaseExposureReservation ?? (() => {});
    this.campaignCapFn = opts.campaignCap ?? (() => undefined);
    this.dailyMaxLossUsdFn = opts.dailyMaxLossUsd ?? XSEC_DAILY_MAX_LOSS_USD;
    this.entryHealthGate = opts.entryHealthGate ?? (() => ({ allowed: true, reason: null }));
    this.entryTrafficLightEnabledFn = opts.entryTrafficLightEnabled ?? (() => (
      this.laneId === CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID && isCrossSectionalEntryTrafficLightEnabled()
    ));
    this.siblingOpenLegs = opts.siblingOpenLegs ?? (() => []);
    this.siblingDailyRealizedUsd = opts.siblingDailyRealizedUsd ?? (() => 0);
    this.sharedGetPositions = opts.sharedGetPositions ?? (() => this.client.getPositions());
    this.rawLaneWeightPctFn = opts.rawLaneWeightPct ?? null;
    this.cortexRealAttribution = opts.cortexRealAttribution ?? null;
    this.executionFillRecorder = opts.executionFillRecorder ?? null;
    this.fourBrainActualFillBindings = opts.fourBrainActualFillBindings ?? null;
    this.fourBrainEntryGate = opts.fourBrainEntryGate ?? null;
    this.legUsdFn = opts.legUsd ?? LEG_USD;
    this.leverageFn = opts.leverage ?? EXEC_LEVERAGE;
    this.maxOpenBasketsFn = opts.maxOpenBaskets ?? MAX_OPEN_BASKETS;
    this.maxSignalAgeMsFn = opts.maxSignalAgeMs ?? MAX_SIGNAL_AGE_MS;
    this.lossReentryGuardEnabledFn = opts.lossReentryGuardEnabled ?? isCrossSectionalLossReentryGuardEnabled;
    this.estimatedCloseCostPctFn = opts.estimatedCloseCostPct ?? REENTRY_ESTIMATED_CLOSE_COST_PCT;
    this.overlapGuardEnabledFn = opts.overlapGuardEnabled ?? isCrossSectionalOverlapGuardEnabled;
    this.maxOverlappingSymbolsFn = opts.maxOverlappingSymbols ?? MAX_OVERLAPPING_SYMBOLS;
    this.maxOverlappingSymbolsPerSideFn = opts.maxOverlappingSymbolsPerSide ?? MAX_OVERLAPPING_SYMBOLS_PER_SIDE;
    this.overlapMinScoreDeltaFn = opts.overlapMinScoreDelta ?? OVERLAP_MIN_SCORE_DELTA;
    this.overlapMinAbsScoreFn = opts.overlapMinAbsScore ?? OVERLAP_MIN_ABS_SCORE;
    this.overlapMaxAdverseExtensionVolFn = opts.overlapMaxAdverseExtensionVol ?? OVERLAP_MAX_ADVERSE_EXTENSION_VOL;
    this.overlapMinAdverseExtensionPctFn = opts.overlapMinAdverseExtensionPct ?? OVERLAP_MIN_ADVERSE_EXTENSION_PCT;
    this.overlapMaxSignalDriftVolFn = opts.overlapMaxSignalDriftVol ?? OVERLAP_MAX_SIGNAL_DRIFT_VOL;
    this.overlapMinSignalDriftPctFn = opts.overlapMinSignalDriftPct ?? OVERLAP_MIN_SIGNAL_DRIFT_PCT;
    this.idNamespace = (opts.idNamespace ?? this.targetVariant).replace(/[^a-zA-Z0-9]/g, "").slice(-6).toLowerCase() || "basket";
    this.respectSignalRiskGeometry = opts.respectSignalRiskGeometry ?? false;
    this.smartBasketEnabledFn = opts.smartBasketEnabled ?? isCrossSectionalSmartBasketV1Enabled;
    this.smartMaxAdverseEntryDriftVolFn = opts.smartMaxAdverseEntryDriftVol ?? SMART_MAX_ADVERSE_ENTRY_DRIFT_VOL;
    this.smartMinAdverseEntryDriftPctFn = opts.smartMinAdverseEntryDriftPct ?? SMART_MIN_ADVERSE_ENTRY_DRIFT_PCT;
    this.smartInvalidationScansFn = opts.smartInvalidationScans ?? SMART_INVALIDATION_SCANS;
    this.smartMfeArmNetReturnFn = opts.smartMfeArmNetReturn ?? SMART_MFE_ARM_NET_RETURN;
    this.smartMfeGivebackFractionFn = opts.smartMfeGivebackFraction ?? SMART_MFE_GIVEBACK_FRACTION;
    this.enabledFn = opts.enabled ?? isCrossSectionalExecEnabled;
  }

  /**
   * Stable identity for one actual cross-basket leg.  It deliberately carries the executor lane
   * and basket id, not just Binance's symbol/order id: the same exchange symbol can legitimately
   * appear in several independent baskets on a netted account.
   */
  private fourBrainBindingKey(basket: ExecutorBasket, leg: ExecutorLeg): string {
    return `xsec:${this.laneId}:${basket.basketId}:${leg.symbol}:${leg.side}`;
  }

  /** The Four-Brain collector expands one cross observation into one causal candidate per leg. */
  private fourBrainSignalId(basket: ExecutorBasket, leg: ExecutorLeg): string {
    return `${basket.sourceObservationId}:${leg.side}:${leg.symbol}`;
  }

  /** Bind only after an actual leg is persisted. A missing/malformed risk geometry remains an
   * explicit unmeasurable binding rather than inventing an R denominator later. */
  private bindFourBrainActualFill(basket: ExecutorBasket, leg: ExecutorLeg): void {
    try {
      this.fourBrainActualFillBindings?.bindActualFill({
        bindingKey: this.fourBrainBindingKey(basket, leg),
        source: "CROSS_SECTIONAL",
        laneId: this.laneId,
        symbol: leg.symbol,
        side: leg.side,
        signalId: this.fourBrainSignalId(basket, leg),
        openedAtMs: Date.parse(basket.openedAt),
        entryPrice: leg.entryPrice,
        entryPriceConfirmed: leg.entryPriceConfirmed,
        riskUsd:
          typeof basket.riskDistanceAtOpen === "number" && Number.isFinite(basket.riskDistanceAtOpen) && basket.riskDistanceAtOpen > 0
            ? leg.qty * leg.entryPrice * basket.riskDistanceAtOpen
            : null,
      });
    } catch {
      // Provenance loss must never change an already-confirmed exchange position.
    }
  }

  private completeFourBrainActualFill(
    basket: ExecutorBasket,
    leg: ExecutorLeg,
    input: { netPnlUsd: number | null; settlementConfirmed: boolean; reason: string },
  ): void {
    try {
      this.fourBrainActualFillBindings?.completeActualFill({
        bindingKey: this.fourBrainBindingKey(basket, leg),
        closedAtMs: Date.parse(basket.closedAt ?? this.nowIso()),
        netPnlUsd: input.netPnlUsd,
        settlementConfirmed: input.settlementConfirmed,
        reason: input.reason,
      });
    } catch {
      // Closing accounting remains the source of truth; Four-Brain telemetry is best effort.
    }
  }

  private markFourBrainBasketUnmeasured(basket: ExecutorBasket, reason: string): void {
    for (const leg of basket.legs) {
      this.completeFourBrainActualFill(basket, leg, { netPnlUsd: null, settlementConfirmed: false, reason });
    }
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

  /** Admission-only view for a same-direction directional add-on. */
  getOpenUnexitedLegsWithEntry(): Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; entryPrice: number }> {
    const out: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; entryPrice: number }> = [];
    for (const basket of this.store.getState().baskets) {
      if (!this.isBasketLive(basket)) continue;
      for (const leg of basket.legs) {
        if (leg.exitOrderId === null) out.push({ symbol: leg.symbol, side: leg.side, qty: leg.qty, entryPrice: leg.entryPrice });
      }
    }
    return out;
  }

  /** 2026-08-05 (critical fix): non-recursive exposure surface -- laneId + open baskets/orphaned
   *  legs only, read directly from the store, WITHOUT calling isAllowed()/entryHealth() the way
   *  getStatus() does. Same rationale as getOpenUnexitedLegs() just above (which already avoids
   *  getStatus() for an analogous reason) -- see single-symbol-lane-executor.ts's
   *  getExposureSnapshot() for the full recursion this closes: computeInnovationExposure()
   *  (innovation-campaign.ts) used to call getStatus() here, which recomputes
   *  isAllowed()/entryHealth(), which for innovation executors calls back into
   *  computeInnovationExposure() again -- infinite mutual recursion, confirmed reproduced. Use
   *  this, never getStatus(), anywhere that only needs raw open exposure. */
  getExposureSnapshot(): { laneId: string; openBaskets: ExecutorBasket[]; orphanedLegs: OrphanedLeg[] } {
    const st = this.store.getState();
    const openBaskets = st.baskets.filter((b) => this.isBasketLive(b));
    return { laneId: this.laneId, openBaskets, orphanedLegs: st.orphanedLegs ?? [] };
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

  /** Live learning baskets only — a legacy/open basket never consumes the bounded cold-start
   * quota, otherwise an old pre-policy trade could permanently prevent the new cohort from
   * gathering its first independent outcomes. */
  private learningOpenCount(): number {
    return this.store.getState().baskets.filter(
      (basket) => this.isBasketLive(basket) && basket.entryAdmission?.tier === "YELLOW",
    ).length;
  }

  /** One single admission decision used for both status and order placement. When the traffic
   * light is enabled, the old global bypass is deliberately NOT consulted: only the narrow,
   * testnet-only YELLOW path may bridge an incomplete sample. */
  private entryAdmissionForSignal(signal: CrossSectionalObservation | null): CrossSectionalEntryAdmission {
    const rawHealth: CrossSectionalEntryHealthVerdict = this.rawEntryHealth();
    if (!this.entryTrafficLightEnabledFn()) {
      const legacy = applyEntryHealthBypass(rawHealth);
      return {
        tier: legacy.allowed ? "GREEN" : "RED",
        allowed: legacy.allowed,
        learning: false,
        sizeMultiplier: legacy.allowed ? 1 : 0,
        maxLearningOpen: 0,
        reason: legacy.reason,
        rawHealth,
      };
    }
    return evaluateCrossSectionalEntryAdmission({
      rawHealth,
      smartBasketV1: signal !== null && this.isSmartBasketSignal(signal),
      learningOpenCount: this.learningOpenCount(),
    });
  }

  /** Persist one distinct decision per signal/outcome/reason. A blocked fresh signal may be seen
   * every five minutes while it is still fresh; deduplication keeps the report useful rather than
   * turning it into a scheduler heartbeat log. */
  private recordEntryAdmission(
    signal: CrossSectionalObservation,
    admission: CrossSectionalEntryAdmission,
    outcome: CrossSectionalEntryAdmissionEvent["outcome"],
  ): void {
    const state = this.store.getState();
    const history = state.entryAdmissions ?? (state.entryAdmissions = []);
    const previous = history[history.length - 1];
    if (
      previous &&
      previous.sourceObservationId === signal.observationId &&
      previous.tier === admission.tier &&
      previous.outcome === outcome &&
      previous.reason === admission.reason
    ) return;
    history.push({
      at: this.nowIso(),
      sourceObservationId: signal.observationId,
      tier: admission.tier,
      allowed: admission.allowed,
      learning: admission.learning,
      sizeMultiplier: admission.sizeMultiplier,
      reason: admission.reason,
      outcome,
    });
    if (history.length > 200) history.splice(0, history.length - 200);
  }

  /**
   * Persist the post-admission execution decision before a signal can become ineligible again.
   * The duplicate check only suppresses identical DEFERRED scheduler repeats; a changed reason or
   * stage is itself useful evidence and is retained.
   */
  private recordEntryAttempt(
    signal: CrossSectionalObservation,
    event: Omit<CrossSectionalEntryAttemptEvent, "at" | "sourceObservationId" | "sourceOpenedAtMs" | "variant" | "signal" | "longSymbols" | "shortSymbols">,
  ): void {
    const state = this.store.getState();
    const history = state.entryAttempts ?? (state.entryAttempts = []);
    const previous = history[history.length - 1];
    if (
      previous &&
      previous.sourceObservationId === signal.observationId &&
      previous.stage === event.stage &&
      previous.outcome === event.outcome &&
      previous.reason === event.reason &&
      previous.watermarkAdvanced === event.watermarkAdvanced
    ) return;
    history.push({
      at: this.nowIso(),
      sourceObservationId: signal.observationId,
      sourceOpenedAtMs: signal.openedAtMs,
      variant: signal.variant ?? "RAW",
      signal: signal.signal,
      longSymbols: signal.longLeg.map((leg) => leg.symbol),
      shortSymbols: signal.shortLeg.map((leg) => leg.symbol),
      ...event,
    });
    if (history.length > 200) history.splice(0, history.length - 200);
  }

  /**
   * A skipped signal must advance the watermark to avoid repeatedly chasing the exact same rank.
   * Keeping that write beside the audit makes the reason restart-durable and prevents a future
   * status call from looking like an unexplained "allowed but no basket" condition.
   */
  private skipSignal(
    signal: CrossSectionalObservation,
    stage: CrossSectionalEntryAttemptStage,
    reason: string,
    referencePrices: Record<string, number> = {},
  ): void {
    const state = this.store.getState();
    this.recordEntryAttempt(signal, {
      stage,
      outcome: "SKIPPED",
      reason,
      referencePrices,
      watermarkAdvanced: true,
    });
    state.lastSeenSignalMs = signal.openedAtMs;
    this.store.save();
    this.openHalted = reason;
  }

  /** Thin wrapper over the shared resolveConfirmedFillPrice, injecting this executor's
   *  test-overridable retry delay and a lane-tagged log line. See binance-futures-private.ts
   *  for why this confirmation step exists (basket xb-mr2x7s6e's real-world avgPrice=0 case). */
  /**
   * Place ONE entry leg post-only, then cross the spread for whatever did not fill.
   *
   * Returns the same three fields the MARKET path returns — orderId, avgPrice, executedQty — with
   * avgPrice already NOTIONAL-BLENDED across the maker and taker portions, so every downstream
   * consumer (resolveFillPrice, the leg record, P&L) is untouched by how the leg was filled.
   *
   * THE SEQUENCE MATTERS, in this order and no other:
   *   1. post-only GTX at the near touch. Binance rejects it outright rather than crossing, so a
   *      "maker" order can never quietly become a taker one.
   *   2. poll until terminal or the wait expires.
   *   3. cancel, THEN re-query. The executedQty read BEFORE the cancel is worthless: an order can
   *      fill in the window between the timeout and the cancel landing, and sizing the fallback
   *      from the stale figure is exactly how that race doubles the position.
   *   4. resolveMakerLeg decides. When it answers UNKNOWN_REQUERY no fallback is placed at all —
   *      a missing leg costs a basket, a doubled one costs money.
   *
   * Any throw from the maker attempt is DELIBERATELY not caught here: it propagates to the entry
   * loop's existing ambiguous-failure reconciliation, which already knows how to recover a leg by
   * client id and must stay the single owner of that decision.
   */
  /**
   * Post every leg's maker order AT ONCE, then wait for all of them ONCE.
   *
   * WHY THIS EXISTS. Placing legs sequentially with a per-leg timeout multiplies the wait: six legs
   * at 20s each is up to two minutes, and at the 5-minute wait the fill data actually favours it
   * would be half an hour. Every second between the first and last leg is drift the basket carries
   * as directional exposure, so the sequential shape put fill rate and neutrality in direct
   * opposition. Posting in parallel makes the total wait ONE timeout regardless of leg count, which
   * is what lets the timeout be long enough to matter — measured, 65% of orders fill within a
   * minute and 81% within five, with adverse selection flat at about -1.0 bps throughout.
   *
   * DELIBERATELY DOES NOT BOOK ANYTHING. It places and waits; the existing sequential loop still
   * owns cancelling, re-querying, the taker fallback, reservations, partial fills and every
   * ambiguous-failure path. That loop's recovery invariants are the most carefully built part of
   * this file and this change does not touch them — placeEntryLegMakerFirst simply notices the
   * order is already resting and skips its own placement.
   *
   * CRASH SAFETY. planned.status is set to PLACING and SAVED before any order is sent, exactly as
   * the sequential path does, so a crash mid-flight leaves every leg recoverable by
   * entryClientOrderId. A resting order reconciles as INCONCLUSIVE, which keeps the leg PLACING and
   * has recoverIncompleteBaskets revisit it — and because the client order id is unchanged, a retry
   * that re-places is idempotent at the exchange rather than a second position.
   */
  private async preplaceMakerLegs(plan: PlannedLeg[], quoteObserveStartMs: number): Promise<void> {
    const pending = plan.filter((p) => p.status === "PENDING" && !p.makerRestingOrderId);
    if (pending.length === 0) return;

    // Mark and persist FIRST. If the process dies between here and the exchange, every leg is
    // already marked PLACING and therefore recoverable; marking after placing would lose that.
    for (const planned of pending) planned.status = "PLACING";
    this.store.save();

    // The caller's observe-start, NOT a fresh one. buildSubmitRefBase rejects any quote stamped
    // BEFORE observeStartMs, so re-reading the clock here — after the warm has already run — marked
    // every warmed quote as too old, produced no submitRef, and left makerLimitPrice with nothing to
    // work from. Every leg then took the NO_BOOK branch and crossed the spread: the maker path could
    // not fire at all, and said so only as "no usable submit-time quote" on each leg.
    await Promise.allSettled(pending.map(async (planned) => {
      try {
        try { await this.client.setLeverage(planned.symbol, this.leverageFn()); } catch { /* already set */ }
        const submitRef = stampSubmitRef(
          buildSubmitRefBase(
            this.readPublicQuoteFn ? this.readPublicQuoteFn(planned.symbol) : null,
            quoteObserveStartMs,
            planned.side,
          ),
          Date.parse(this.nowIso()),
        );
        planned.makerSubmitRef = submitRef ?? null;
        const limitPrice = this.client.cancelOrder ? makerLimitPrice(planned.side, submitRef?.bid ?? null, submitRef?.ask ?? null) : null;
        // No usable book, or a client that cannot cancel: leave this leg entirely to the sequential
        // loop, which will cross for it. Never post what we cannot retract.
        if (limitPrice === null) return;
        const order = await this.client.placeOrder({
          symbol: planned.symbol,
          side: planned.side === "LONG" ? "BUY" : "SELL",
          type: "LIMIT",
          timeInForce: "GTX",
          price: limitPrice,
          quantity: planned.requestedQty,
          newClientOrderId: planned.entryClientOrderId,
        });
        planned.makerRestingOrderId = order.orderId;
        planned.makerRestingPrice = limitPrice;
      } catch {
        // A rejected or failed pre-place is NOT an error here. The leg keeps status PLACING with no
        // resting id, so the sequential loop treats it exactly as it would have without this pass —
        // including its own ambiguous-failure reconciliation, which is the only thing that may
        // decide whether an order reached the exchange.
      } finally {
        this.store.save();
      }
    }));

    // ONE wait for all of them. Poll every second and stop early the moment nothing is still
    // resting — a basket whose legs all filled must not sit here burning the rest of the timeout.
    const resting = pending.filter((p) => p.makerRestingOrderId);
    if (resting.length === 0) return;
    const waitMs = crossSectionalMakerWaitMs();
    const deadline = Date.parse(this.nowIso()) + waitMs;
    const terminal = new Set(["FILLED", "CANCELED", "EXPIRED", "REJECTED"]);
    // Bounded by POLL COUNT as well as by the clock. nowIso() is injectable, and a frozen or
    // non-advancing clock would otherwise leave this spinning forever — which is exactly what the
    // first run of the parallel test did before this bound existed.
    const maxPolls = Math.max(1, Math.ceil(waitMs / 1_000));
    for (let poll = 0; poll < maxPolls && Date.parse(this.nowIso()) < deadline; poll++) {
      await new Promise((r) => setTimeout(r, 1_000));
      const states = await Promise.allSettled(
        resting.map((p) => this.client.queryOrder(p.symbol, p.makerRestingOrderId as string)),
      );
      const stillResting = states.some(
        (x) => x.status === "fulfilled" && !terminal.has(String(x.value.status).toUpperCase()),
      );
      if (!stillResting) return;
    }
  }

  private async placeEntryLegMakerFirst(
    planned: PlannedLeg,
    side: "BUY" | "SELL",
    refBid: number | null,
    refAsk: number | null,
  ): Promise<{ orderId: string; avgPrice: number; executedQty: number }> {
    // Pre-placed by preplaceMakerLegs? Then the order is already resting and the wait already
    // happened — go straight to cancel/re-query/resolve. Placing a second one here would be a
    // duplicate position, which is why this check comes before everything else.
    const preplaced = planned.makerRestingOrderId
      ? { orderId: planned.makerRestingOrderId, price: planned.makerRestingPrice ?? null }
      : null;
    const limitPrice = preplaced?.price ?? (this.client.cancelOrder ? makerLimitPrice(planned.side, refBid, refAsk) : null);
    if (limitPrice === null) {
      // No usable book: cross, exactly as before. A limit derived from a broken book would rest far
      // from the market and never fill, which is worse than paying the taker fee once.
      const order = await this.client.placeOrder({
        symbol: planned.symbol, side, type: "MARKET",
        quantity: planned.requestedQty, newClientOrderId: planned.entryClientOrderId,
      });
      planned.makerOutcome = { action: "NO_BOOK", reason: this.client.cancelOrder ? "no usable submit-time quote" : "client cannot cancel — maker unsafe", makerQty: 0, takerQty: planned.requestedQty };
      return { orderId: order.orderId, avgPrice: order.avgPrice, executedQty: order.executedQty };
    }

    const maker = preplaced
      ? await this.client.queryOrder(planned.symbol, preplaced.orderId)
      : await this.client.placeOrder({
          symbol: planned.symbol, side, type: "LIMIT", timeInForce: "GTX",
          price: limitPrice, quantity: planned.requestedQty, newClientOrderId: planned.entryClientOrderId,
        });

    let latest = maker;
    // A pre-placed leg has ALREADY served its wait in preplaceMakerLegs — waiting again here would
    // reintroduce exactly the per-leg multiplication that pass exists to remove.
    if (!preplaced) {
      const waitMs = crossSectionalMakerWaitMs();
      const deadline = Date.parse(this.nowIso()) + waitMs;
      // Same poll bound as preplaceMakerLegs, for the same reason: never rely on an injected clock
      // advancing to terminate a loop.
      const maxPolls = Math.max(1, Math.ceil(waitMs / 1_000));
      for (let poll = 0; poll < maxPolls; poll++) {
        if (["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(latest.status).toUpperCase())) break;
        if (Date.parse(this.nowIso()) >= deadline) break;
        await new Promise((r) => setTimeout(r, 1_000));
        try { latest = await this.client.queryOrder(planned.symbol, maker.orderId); } catch { break; }
      }
    }

    // Cancel first, THEN read. Best-effort: a cancel that fails because the order already reached a
    // terminal state is not an error, and the re-query below is what actually decides.
    if (!["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(latest.status).toUpperCase())) {
      try { await this.client.cancelOrder!(planned.symbol, maker.orderId); } catch { /* terminal already */ }
    }
    try { latest = await this.client.queryOrder(planned.symbol, maker.orderId); } catch { /* keep last known */ }

    const decision = resolveMakerLeg(planned.requestedQty, latest.status, latest.executedQty);
    planned.makerOutcome = {
      action: decision.action, reason: decision.reason,
      makerQty: decision.filledQty, takerQty: decision.fallbackQty,
    };

    if (decision.action !== "FALLBACK_TAKER") {
      // DONE, or UNKNOWN_REQUERY — in which case no fallback may be sized. Returning the maker
      // order's own numbers lets the caller's existing partial-fill handling book exactly what the
      // exchange confirmed and orphan nothing it cannot see.
      this.store.save();
      return { orderId: maker.orderId, avgPrice: latest.avgPrice, executedQty: latest.executedQty };
    }

    // Persist the fallback identity BEFORE submitting it, so a crash in the next few hundred ms
    // still leaves recovery something to query.
    planned.takerFallbackClientOrderId = `${planned.entryClientOrderId}f`;
    this.store.save();
    const taker = await this.client.placeOrder({
      symbol: planned.symbol, side, type: "MARKET",
      quantity: decision.fallbackQty, newClientOrderId: planned.takerFallbackClientOrderId,
    });

    const makerQty = decision.filledQty;
    const takerQty = Number.isFinite(taker.executedQty) && taker.executedQty > 0 ? taker.executedQty : decision.fallbackQty;
    const makerPx = Number.isFinite(latest.avgPrice) && latest.avgPrice > 0 ? latest.avgPrice : limitPrice;
    // 2026-08-19: resolve the TAKER price against the TAKER order id, HERE, while it is in scope.
    // Returning 0 used to defer this to resolveFillPrice — but that resolver is handed the MAKER
    // order id (the identity of the leg, see below), and on this path the maker order is CANCELED
    // with executedQty 0. Querying it can never confirm a taker fill, and because CANCELED is
    // terminal resolveConfirmedFillPrice breaks out on its very first attempt without retrying.
    // Live booked 5 legs at the pre-trade REFERENCE price instead of the real fill (baskets
    // xb-msyft2cg and xb-msz3bsar, 2026-08-18). The bias is systematic, not noise: the reference
    // omits exactly the slippage the taker fallback just paid, so shorts record too high and longs
    // too low — always in the direction that flatters the position.
    const takerResolution = await resolveConfirmedFillPrice(
      this.client,
      planned.symbol,
      taker.orderId,
      taker.avgPrice,
      0,
      {
        retryDelayMs: this.fillConfirmRetryDelayMs,
        onUnconfirmed: (sym, id) =>
          console.error(
            `[cross-sectional-executor] UNCONFIRMED TAKER FALLBACK FILL: ${sym} order ${id} never ` +
              `returned a real avgPrice — leaving the leg unpriced rather than booking it at the ` +
              `pre-trade reference, which would understate entry slippage.`,
          ),
      },
    );
    const takerPx = takerResolution.price > 0 ? takerResolution.price : 0;
    const totalQty = makerQty + takerQty;
    // Blend by NOTIONAL. A taker price still unconfirmed after the resolve above leaves the blend at
    // 0 rather than inventing one — the same safe degradation as before, but now only after the
    // order that actually filled has been asked.
    const avgPrice = takerPx > 0 && totalQty > 0 ? (makerQty * makerPx + takerQty * takerPx) / totalQty : 0;
    // The MAKER order id is the leg's identity: it is what planned.entryClientOrderId maps to and
    // what every existing recovery path already looks up.
    return { orderId: maker.orderId, avgPrice, executedQty: totalQty };
  }

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

  /** Rejections live in their own append-only journal so they never become executable baskets. */
  private rejectedBasketCount(): number {
    try {
      const path = process.env.CROSS_SECTIONAL_REJECTED_LOG ?? resolve(process.cwd(), "data", "cross-sectional-rejected.jsonl");
      return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
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
    /** null when the TP is switched off — Infinity would serialise to null anyway, so the
     *  companion flag below is what makes "off" unambiguous to any reader. */
    tpNetReturnPct: number | null;
    tpDisabled: boolean;
    /** Instance-level exit limits, all null/false when their switch is off. Exposed so the
     *  dashboard states the ACTUAL exit contract instead of assuming hold-to-horizon. */
    stopNetReturnPct: number | null;
    maxHoldHours: number | null;
    measurementHorizonBars: number | null;
    measurementInterval: string;
    /** Explicit pre-cutover contract for persisted rows without a fingerprint. */
    legacyExitPolicy: CrossSectionalExitPolicySnapshot;
    effectiveRuntime: CrossSectionalEffectiveRuntime;
    currentPolicyFingerprint: CrossSectionalPolicyFingerprint;
    currentPolicyForwardCohort: CurrentPolicyForwardCohort;
    accountingCounts: { cleanN: number; quarantinedN: number; rejectedN: number };
    /** Realized basket P&L for the current UTC day + the safety-breaker limit (0 = disabled). */
    dailyRealizedUsd: number;
    dailyMaxLossUsd: number;
    /** True while CROSS_SECTIONAL_EXEC_FORCE_IGNORE_ENTRY_HEALTH=1 is overriding a FAILING gate. */
    entryHealthBypassed: boolean;
    /** The rolling-evidence gate own verdict, before any bypass. */
    entryHealthVerdict: { allowed: boolean; reason: string | null };
    /** Explicit GREEN / YELLOW / RED decision used for the newest current FILTERED signal. */
    entryAdmission: CrossSectionalEntryAdmission;
    /** Small durable audit for operators: ADMITTED is a reserved full basket plan, never a claim
     * that Binance filled it; actual fills live on `openBaskets[].legs`. */
    entryAdmissionAudit: {
      trafficLightEnabled: boolean;
      learningOpenBaskets: number;
      greenAdmitted: number;
      yellowAdmitted: number;
      redBlocked: number;
      recent: CrossSectionalEntryAdmissionEvent[];
    };
    /** Exact last attempted basket decision, retained even after a later tick clears openHalted. */
    entryAttemptAudit: {
      latest: CrossSectionalEntryAttemptEvent | null;
      recent: CrossSectionalEntryAttemptEvent[];
      /** Honest legacy fallback only: the signal was consumed before this audit existed, so no
       * guard reason is invented. It is computed from persisted watermark/basket facts. */
      unattributedConsumedSignal: {
        sourceObservationId: string;
        openedAt: string;
        reason: string;
      } | null;
    };
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
    /** True when FILTERED execution is using the static operator pool instead of old-book demotions. */
    adaptiveFiltersDisabled: boolean;
    /** Begins comparing sizing combinations after eight metadata-complete closes; report-only. */
    formationEvaluation: ReturnType<typeof evaluateCrossSectionalFormationCohort>;
    /** 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): real, still-open exchange
     *  exposure this executor's normal HORIZON/PROFIT_BANK close paths can no longer reach — see
     *  OrphanedLeg's doc comment. retryOrphanedLegFlattens() retries every tick automatically, but
     *  a NON-EMPTY array here means a position is, right now, still open on the exchange with
     *  every retry so far having failed — an operator (or a future account-wide reconciliation)
     *  must never mistake a still-failing retry for "handled". */
    orphanedLegs: OrphanedLeg[];
    /** Baskets whose real P&L is UNKNOWN, not zero — closed out-of-band (e.g. a panic
     *  flatten-exchange call) before this basket's own bookkeeping ever saw a real exit price. See
     *  ExecutorBasket.accountingStatus's own doc comment. Every learning/PF-WR/promotion/CORTEX-
     *  label consumer must exclude these, never zero-fill them — surfaced here (same shape
     *  discipline as orphanedLegs above) so an operator can never mistake "excluded" for "handled". */
    accountingIncompleteBaskets: ExecutorBasket[];
  } {
    const st = this.store.getState();
    const currentPolicyFingerprint = buildCurrentCrossSectionalPolicyFingerprint(this.nowIso());
    const currentPolicyForward = currentPolicyForwardCohort(st.baskets, currentPolicyFingerprint);
    const effectiveRuntime = effectiveCrossSectionalRuntime(Boolean(
      this.client.cancelOrder && this.client.queryOrderByClientId && this.readPublicQuoteFn,
    ));
    const currentExecutionPolicy = currentCrossSectionalExitPolicy();
    const legacyExitPolicy = legacyCrossSectionalExitPolicy();
    const closed = st.baskets.filter((b) =>
      b.status === "CLOSED" &&
      b.accountingStatus !== "ACCOUNTING_INCOMPLETE" &&
      !isCrossSectionalBasketReportingExcluded(b),
    );
    const openBaskets = st.baskets.filter((b) => this.isBasketLive(b));
    const targetVariant = this.targetVariant;
    const nowMs = new Date(this.nowIso()).getTime();
    const matching = this.signalStore.all
      .filter((o) => (o.variant ?? "RAW") === targetVariant)
      .sort((a, b) => b.openedAtMs - a.openedAtMs);
    const signalAgeMs = matching[0] ? nowMs - matching[0].openedAtMs : null;
    const signalMaxAgeMs = this.maxSignalAgeMsFn();
    const currentSignal = matching.find((signal) => signal.status === "OPEN") ?? null;
    const entryAdmission = this.entryAdmissionForSignal(currentSignal);
    const entryAdmissions = st.entryAdmissions ?? [];
    const entryAttempts = st.entryAttempts ?? [];
    const currentSignalAlreadyHasBasket = currentSignal !== null && st.baskets.some(
      (basket) => basket.sourceObservationId === currentSignal.observationId,
    );
    const currentSignalAlreadyAudited = currentSignal !== null && entryAttempts.some(
      (event) => event.sourceObservationId === currentSignal.observationId,
    );
    const unattributedConsumedSignal =
      currentSignal !== null &&
      currentSignal.openedAtMs <= st.lastSeenSignalMs &&
      !currentSignalAlreadyHasBasket &&
      !currentSignalAlreadyAudited
        ? {
            sourceObservationId: currentSignal.observationId,
            openedAt: currentSignal.openedAt,
            reason: "Sinyal ini sudah dikonsumsi sebelum audit attempt dipasang; alasan guard asli tidak pernah tersimpan.",
          }
        : null;
    return {
      enabled: this.enabledFn(),
      allowed: this.isAllowed() && entryAdmission.allowed,
      entryHealthBypassed: !this.entryTrafficLightEnabledFn() && !this.rawEntryHealth().allowed && isCrossSectionalEntryHealthBypassed(),
      entryHealthVerdict: this.rawEntryHealth(),
      entryAdmission,
      entryAdmissionAudit: {
        trafficLightEnabled: this.entryTrafficLightEnabledFn(),
        learningOpenBaskets: this.learningOpenCount(),
        greenAdmitted: entryAdmissions.filter((event) => event.outcome === "ADMITTED" && event.tier === "GREEN").length,
        yellowAdmitted: entryAdmissions.filter((event) => event.outcome === "ADMITTED" && event.tier === "YELLOW").length,
        redBlocked: entryAdmissions.filter((event) => event.outcome === "BLOCKED" && event.tier === "RED").length,
        recent: entryAdmissions.slice(-20),
      },
      entryAttemptAudit: {
        latest: entryAttempts[entryAttempts.length - 1] ?? null,
        recent: entryAttempts.slice(-20),
        unattributedConsumedSignal,
      },
      laneId: this.laneId,
      legUsd: this.effectiveLegUsd(),
      baseLegUsd: this.legUsdFn(),
      allocationWeightPct: this.allocationWeightPct(),
      leverage: this.leverageFn(),
      variant: targetVariant,
      tpNetReturnPct: currentExecutionPolicy.takeProfitEnabled && currentExecutionPolicy.takeProfitNetReturn !== null
        ? currentExecutionPolicy.takeProfitNetReturn * 100
        : null,
      tpDisabled: !currentExecutionPolicy.takeProfitEnabled,
      stopNetReturnPct: currentExecutionPolicy.stopLossNetReturn !== null ? currentExecutionPolicy.stopLossNetReturn * 100 : null,
      maxHoldHours: currentExecutionPolicy.executionCapHours,
      measurementHorizonBars: currentExecutionPolicy.measurementHorizonBars,
      measurementInterval: currentExecutionPolicy.measurementInterval,
      legacyExitPolicy,
      effectiveRuntime,
      currentPolicyFingerprint,
      currentPolicyForwardCohort: currentPolicyForward,
      accountingCounts: {
        cleanN: closed.length,
        quarantinedN: st.baskets.filter((basket) => basket.status === "CLOSED" && (basket.accountingStatus === "ACCOUNTING_INCOMPLETE" || isCrossSectionalBasketReportingExcluded(basket))).length,
        rejectedN: this.rejectedBasketCount(),
      },
      dailyRealizedUsd: this.dailyRealizedUsd(this.nowIso()),
      dailyMaxLossUsd: this.dailyMaxLossUsdFn(),
      openHalted: this.openHalted,
      openBasket: openBaskets[0] ?? null,
      openBaskets,
      closedCount: closed.length,
      totalNetPnlUsd: closed.reduce((s, b) => s + (b.netPnlUsd ?? 0), 0),
      lastError: this.lastError,
      recent: st.baskets.filter((b) => !isCrossSectionalBasketReportingExcluded(b)).slice(-10),
      signalAgeMs,
      signalMaxAgeMs,
      signalStale: signalAgeMs === null || signalAgeMs > signalMaxAgeMs,
      adaptiveFilters: deriveAdaptiveSymbolFilters(this.signalStore as CrossSectionalStore).provenance,
      adaptiveFiltersDisabled: isCrossSectionalAdaptiveDisabled(),
      formationEvaluation: evaluateCrossSectionalFormationCohort(closed, new Set(currentPolicyForward.validBasketIds)),
      orphanedLegs: st.orphanedLegs ?? [],
      accountingIncompleteBaskets: st.baskets.filter((b) => b.accountingStatus === "ACCOUNTING_INCOMPLETE"),
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
    const closed = this.store.getState().baskets.filter((b) =>
      b.status === "CLOSED" &&
      b.accountingStatus !== "ACCOUNTING_INCOMPLETE" &&
      !isCrossSectionalBasketReportingExcluded(b),
    );
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
    const closed = this.store.getState().baskets.filter((b) =>
      b.status === "CLOSED" &&
      b.accountingStatus !== "ACCOUNTING_INCOMPLETE" &&
      !isCrossSectionalBasketReportingExcluded(b),
    );
    return regimeSkewCounterfactual(closed);
  }

  /** Every reportable CLOSED basket, store order — feeds account-level merges that need per-basket
   *  closedAt/netPnl (e.g. the lane-performance timeline) rather than the aggregate summary.
   *  Excludes ACCOUNTING_INCOMPLETE baskets (see ExecutorBasket.accountingStatus) — their P&L is
   *  UNKNOWN, not zero, and every consumer of this list feeds learning/PF-WR-shaped surfaces. */
  getClosedBaskets(): ExecutorBasket[] {
    return this.store.getState().baskets.filter((b) =>
      b.status === "CLOSED" &&
      b.accountingStatus !== "ACCOUNTING_INCOMPLETE" &&
      !isCrossSectionalBasketReportingExcluded(b),
    );
  }

  /** Raw closed ledger for forensic/audit use only. Unlike getClosedBaskets(), this intentionally
   * includes operator-voided rows and accounting-incomplete rows. */
  getClosedBasketsForAudit(): ExecutorBasket[] {
    return this.store.getState().baskets.filter((b) => b.status === "CLOSED");
  }

  /** Current same-side re-entry blocks from actual exchange marks. Missing marks block safely. */
  async getLossReentryBlocks(): Promise<CrossSectionalLossReentryBlock[]> {
    if (!this.lossReentryGuardEnabledFn()) return [];
    const liveBaskets = this.store.getState().baskets.filter((basket) => this.isBasketLive(basket));
    if (!liveBaskets.length) return [];
    const positions = await this.sharedGetPositions();
    const markBySymbol = Object.fromEntries(
      positions
        .filter((position) => Number.isFinite(position.markPrice) && position.markPrice > 0)
        .map((position) => [position.symbol, position.markPrice]),
    );
    return lossMakingCrossSectionalOpenLegs(liveBaskets, markBySymbol, this.estimatedCloseCostPctFn());
  }

  private isSmartBasketSignal(signal: CrossSectionalObservation): boolean {
    return this.smartBasketEnabledFn() &&
      (signal.variant ?? "RAW") === "FILTERED" &&
      signal.smartFormation?.version === "SMART_BASKET_V1";
  }

  /**
   * Signals are hourly but the executor may reach them a few minutes later.  Refresh each actual
   * sizing reference from the exchange mark before any reservation/order.  This keeps normal moves
   * executable while refusing only a genuinely run-away, adverse entry; it is intentionally
   * fail-open on unavailable marks because a missing observation is not evidence the ranking died.
   */
  private async revalidateSmartEntry(signal: CrossSectionalObservation): Promise<SmartEntryRevalidation> {
    if (!this.isSmartBasketSignal(signal)) return { allowed: true, reason: null, at: null, referencePrices: {} };
    let positions: Awaited<ReturnType<CrossSectionalExecClient["getPositions"]>>;
    try {
      positions = await this.sharedGetPositions();
    } catch {
      return { allowed: true, reason: null, at: null, referencePrices: {} };
    }
    const marks = new Map(
      positions
        .filter((position) => Number.isFinite(position.markPrice) && position.markPrice > 0)
        .map((position) => [position.symbol, position.markPrice]),
    );
    const referencePrices: Record<string, number> = {};
    const maxAdverseVol = this.smartMaxAdverseEntryDriftVolFn();
    const minAdversePct = this.smartMinAdverseEntryDriftPctFn();
    for (const [side, legs] of [["LONG", signal.longLeg], ["SHORT", signal.shortLeg]] as const) {
      for (const leg of legs) {
        const mark = marks.get(leg.symbol);
        if (!(typeof mark === "number" && Number.isFinite(mark) && mark > 0 && leg.entryPrice > 0)) continue;
        referencePrices[leg.symbol] = mark;
        const adverseMove = side === "LONG"
          ? (mark - leg.entryPrice) / leg.entryPrice
          : (leg.entryPrice - mark) / leg.entryPrice;
        const volatility = leg.volatilityAtOpen;
        const adverseVol = Number.isFinite(volatility) && volatility! > 0 ? adverseMove / volatility! : null;
        if (
          adverseMove >= minAdversePct &&
          adverseVol !== null &&
          adverseVol > maxAdverseVol
        ) {
          return {
            allowed: false,
            reason: `smart entry refresh: ${leg.symbol} moved ${adverseMove.toFixed(4)} adverse (${adverseVol.toFixed(2)}σ) after scan; await next fresh scan`,
            at: this.nowIso(),
            referencePrices,
          };
        }
      }
    }
    return { allowed: true, reason: null, at: this.nowIso(), referencePrices };
  }

  /**
   * A fresh scan invalidates an already-open Smart Basket only when the side currently losing in
   * the real basket is contradicted by both its slower MOM sign and short-horizon confirmation.
   * A missing candidate, a single noisy scan, or a merely mediocre score is never an invalidation.
   */
  private smartInvalidationReason(
    basket: ExecutorBasket,
    signal: CrossSectionalObservation,
    longReturn: number,
    shortReturn: number,
  ): string | null {
    const formation = signal.smartFormation;
    if (formation?.version !== "SMART_BASKET_V1") return null;
    const diagnostics = formation.candidates;
    const evaluateSide = (side: "LONG" | "SHORT", sideReturn: number): string | null => {
      if (!(sideReturn < 0)) return null;
      const sideLegs = basket.legs.filter((leg) => leg.side === side && leg.exitOrderId === null);
      if (!sideLegs.length) return null;
      const bad = (candidate: typeof diagnostics[number]): boolean => {
        if (!(typeof candidate.fastSupport === "number" && candidate.fastSupport <= -0.25)) return false;
        return side === "LONG" ? candidate.score <= 0 : candidate.score >= 0;
      };
      const bySymbol = new Map(diagnostics.filter((candidate) => candidate.side === side).map((candidate) => [candidate.symbol, candidate]));
      const originalBroken = sideLegs.filter((leg) => {
        const current = bySymbol.get(leg.symbol);
        return current ? bad(current) : false;
      }).length;
      const selected = diagnostics.filter((candidate) => candidate.side === side && candidate.selected);
      const selectedBroken = selected.filter(bad).length;
      const requiredOriginal = Math.max(1, Math.ceil(sideLegs.length / 2));
      const requiredSelected = Math.max(1, Math.ceil(selected.length / 2));
      if (originalBroken >= requiredOriginal || (selected.length > 0 && selectedBroken >= requiredSelected)) {
        return `${side} thesis contradicted (${originalBroken}/${sideLegs.length} held, ${selectedBroken}/${selected.length || 0} current candidates)`;
      }
      return null;
    };
    const reasons = [evaluateSide("LONG", longReturn), evaluateSide("SHORT", shortReturn)].filter((reason): reason is string => reason !== null);
    return reasons.length ? reasons.join("; ") : null;
  }

  /** A market-neutral basket is not assumed to be beta-neutral after its legs diverge.  This exit
   * therefore needs three facts at once: the regime genuinely changed, the basket is already down
   * after costs by the configured amount, and the side that should suffer under the NEW trend is
   * actually the side losing.  A one-scan regime flicker is only recorded; two distinct scans are
   * required before a close can be requested. */
  private smartRegimeLossReason(
    basket: ExecutorBasket,
    signal: CrossSectionalObservation,
    netReturn: number,
    longReturn: number,
    shortReturn: number,
  ): string | null {
    if (!SMART_REGIME_LOSS_EXIT_ENABLED()) return null;
    const smart = basket.smartBasket;
    if (!smart || smart.version !== "SMART_BASKET_V1") return null;
    const from = smart.regimeClassAtOpen ?? null;
    const to = signal.regimeClassAtOpen ?? signal.regimeContext?.regimeClass ?? null;
    if (!from || !to || from === "UNKNOWN" || to === "UNKNOWN" || from === to) return null;
    if (!(netReturn <= -SMART_REGIME_LOSS_RETURN())) return null;
    if (to === "TREND_SHORT" && longReturn < 0) {
      return `regime ${from}→${to}; long side is losing ${(longReturn * 100).toFixed(3)}% while basket is ${(netReturn * 100).toFixed(3)}% after costs`;
    }
    if (to === "TREND_LONG" && shortReturn < 0) {
      return `regime ${from}→${to}; short side is losing ${(shortReturn * 100).toFixed(3)}% while basket is ${(netReturn * 100).toFixed(3)}% after costs`;
    }
    return null;
  }

  /** Updates persistent MFE and consumes each *distinct* post-entry hourly scan once. */
  private smartExitReason(
    basket: ExecutorBasket,
    netReturn: number,
    longReturn: number,
    shortReturn: number,
  ): string | null {
    const smart = basket.smartBasket;
    if (!smart || smart.version !== "SMART_BASKET_V1" || !this.smartBasketEnabledFn()) return null;
    const now = this.nowIso();
    if (smart.maxNetReturn === null || !Number.isFinite(smart.maxNetReturn) || netReturn > smart.maxNetReturn) {
      smart.maxNetReturn = netReturn;
      smart.maxNetAt = now;
    }
    const lastRegimeLossSignalMs = smart.lastRegimeLossSignalMs ?? smart.sourceOpenedAtMs;
    const freshSignals = this.signalStore.all
      .filter((signal) =>
        (signal.variant ?? "RAW") === "FILTERED" &&
        signal.smartFormation?.version === "SMART_BASKET_V1" &&
        signal.openedAtMs > Math.min(smart.lastInvalidationSignalMs, lastRegimeLossSignalMs) &&
        signal.openedAtMs > smart.sourceOpenedAtMs,
      )
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    for (const signal of freshSignals) {
      if (signal.openedAtMs > smart.lastInvalidationSignalMs) {
        smart.lastInvalidationSignalMs = signal.openedAtMs;
        const reason = this.smartInvalidationReason(basket, signal, longReturn, shortReturn);
        if (reason) {
          smart.consecutiveInvalidationScans += 1;
          smart.lastInvalidationReason = reason;
        } else {
          smart.consecutiveInvalidationScans = 0;
          smart.lastInvalidationReason = null;
        }
      }
      if (signal.openedAtMs > (smart.lastRegimeLossSignalMs ?? smart.sourceOpenedAtMs)) {
        smart.lastRegimeLossSignalMs = signal.openedAtMs;
        const regimeReason = this.smartRegimeLossReason(basket, signal, netReturn, longReturn, shortReturn);
        if (regimeReason) {
          smart.consecutiveRegimeLossScans = (smart.consecutiveRegimeLossScans ?? 0) + 1;
          smart.lastRegimeLossReason = regimeReason;
        } else {
          smart.consecutiveRegimeLossScans = 0;
          smart.lastRegimeLossReason = null;
        }
      }
    }
    // Ghost state above keeps collecting on every basket.  The explicit runtime switch only governs
    // whether that observation is allowed to send a real exit order.
    if (!this.basketExecutionPolicy(basket).adaptiveExitsEnabled) return null;
    if ((smart.consecutiveRegimeLossScans ?? 0) >= this.smartInvalidationScansFn()) return "SMART_REGIME_LOSS_EXIT";
    if (smart.consecutiveInvalidationScans < this.smartInvalidationScansFn()) return null;
    const mfe = smart.maxNetReturn;
    if (
      typeof mfe === "number" &&
      mfe >= this.smartMfeArmNetReturnFn() &&
      netReturn <= mfe * this.smartMfeGivebackFractionFn()
    ) {
      return "SMART_MFE_GIVEBACK";
    }
    return netReturn <= 0 ? "SMART_CONTEXT_INVALIDATION" : null;
  }

  /** New baskets freeze this at admission; legacy rows read the pre-cutover compatibility contract. */
  private basketExecutionPolicy(basket: ExecutorBasket): CrossSectionalExitPolicySnapshot {
    return basket.policyFingerprint?.execution ?? legacyCrossSectionalExitPolicy();
  }

  private shouldUseMakerExit(basket: ExecutorBasket, reason: string): boolean {
    // STOP, kill-switch, operator, stale-book reconciliation and unfinished close recovery must
    // cross immediately.  The normal scheduled hold exit is the only production policy path that
    // gets a bounded passive attempt; PROFIT_BANK is included for legacy baskets that still have it.
    if (reason !== "HORIZON" && reason !== "PROFIT_BANK") return false;
    const policy = this.basketExecutionPolicy(basket);
    return policy.makerExitEnabled && Boolean(this.client.cancelOrder && this.client.queryOrderByClientId && this.readPublicQuoteFn);
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
      // Health is evaluated together with the actual candidate inside maybeOpenBasket().  That is
      // essential for the traffic light: a YELLOW exception is valid only for a fresh Smart Basket
      // V1 signal, never as a process-wide "health bypass" before we know what would be traded.
      if (this.isAllowed()) {
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
      const resolution = ambiguous.takerFallbackClientOrderId
            ? await this.reconcilePlannedLeg(ambiguous.symbol, ambiguous.takerFallbackClientOrderId)
            : await this.reconcilePlannedLeg(ambiguous.symbol, ambiguous.entryClientOrderId);
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
          signalWeight: ambiguous.signalWeight ?? null,
          scoreAtOpen: ambiguous.scoreAtOpen ?? null,
          volatilityAtOpen: ambiguous.volatilityAtOpen ?? null,
          targetNotionalUsd: ambiguous.targetNotionalUsd ?? null,
        });
        this.bindFourBrainActualFill(basket, basket.legs[basket.legs.length - 1]!);
        ambiguous.status = "FILLED";
        basket.status = basket.legs.length === plan.length ? "COMPLETE" : "PARTIALLY_FILLED";
      }
      // else INCONCLUSIVE — never guess, leave `ambiguous` (idx) completely untouched; sweepFrom
      // already excludes it from the generic release pass below.
    }
    // Every remaining plan entry has never been attempted by any process — release it now (see this
    // method's own 2026-08-05 doc-comment addendum above). No-op when sweepFrom === plan.length
    // (the common 2-leg-basket case: the ambiguous entry above was the last one, nothing left).
    await this.markRemainingNeverAttempted(basket, sweepFrom, "BASKET_CLOSED_BEFORE_RECOVERY:NEVER_ATTEMPTED");
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
    // Track every real open leg before deciding whether a COMPLETE hedge can take profit.
    // Partial baskets cannot use TP math, but their live exposure must still be visible to
    // shadow Exit Brain. A legacy basket gets its frozen risk backfilled from its source
    // observation once; without it, leave the path unknown instead of inventing R history.
    const riskByObservationId = new Map(
      this.signalStore.all.map((observation) => [observation.observationId, observation.riskDistanceAtOpen]),
    );
    const pathNow = this.nowIso();
    for (const basket of st.baskets.filter((candidate) => this.isBasketLive(candidate))) {
      const observedRisk = basket.riskDistanceAtOpen ?? riskByObservationId.get(basket.sourceObservationId);
      if (!(typeof observedRisk === "number" && Number.isFinite(observedRisk) && observedRisk > 0 && observedRisk < 0.5)) continue;
      if (basket.riskDistanceAtOpen !== observedRisk) basket.riskDistanceAtOpen = observedRisk;
      for (const leg of basket.legs) {
        if (leg.exitOrderId !== null || !(leg.entryPrice > 0)) continue;
        const mark = markBySymbol.get(leg.symbol);
        if (!(typeof mark === "number" && Number.isFinite(mark) && mark > 0)) continue;
        const rawReturn = leg.side === "LONG" ? (mark - leg.entryPrice) / leg.entryPrice : (leg.entryPrice - mark) / leg.entryPrice;
        const currentR = rawReturn / observedRisk;
        if (!Number.isFinite(currentR)) continue;
        leg.maxFavorableR = Math.max(0, Number.isFinite(leg.maxFavorableR) ? leg.maxFavorableR! : 0, currentR);
        leg.maxAdverseR = Math.max(0, Number.isFinite(leg.maxAdverseR) ? leg.maxAdverseR! : 0, -currentR);
        leg.lastMarkPrice = mark;
        leg.lastMarkAt = pathNow;
        leg.pathStartedAt ??= pathNow;
        stamped = true;
      }
    }
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
      // Legacy baskets retain the historical equal-side TP arithmetic unchanged.  Smart Basket v1
      // persists actual signal weights at entry, so its MFE/context exit sees the same capital mix
      // the exchange was asked to trade instead of pretending capped inverse-vol legs were equal.
      const weightedContribution = (legs: ExecutorLeg[], returns: Array<number | null>, fallback: number): number => {
        if (!basket.smartBasket) return fallback / 2;
        const weights = legs.map((leg) => Number.isFinite(leg.signalWeight) && leg.signalWeight! > 0 ? leg.signalWeight! : null);
        const totalWeight = weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0);
        if (!(totalWeight > 0)) return fallback / 2;
        return returns.reduce<number>((sum, value, index) => sum + (value ?? 0) * (weights[index] ?? 0), 0);
      };
      const grossReturn = weightedContribution(longLegs, longReturns, meanLong) + weightedContribution(shortLegs, shortReturns, meanShort);
      const costReturn = CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;
      const netReturn = grossReturn - costReturn;
      basket.lastNetReturn = netReturn;
      basket.lastNetAt = this.nowIso();
      stamped = true;
      const smartExit = this.smartExitReason(basket, netReturn, meanLong, meanShort);
      if (smartExit) {
        try {
          await this.closeBasket(basket, smartExit);
        } catch (error) {
          this.lastError = (error as Error).message ?? "smart basket close failed";
        }
        continue;
      }
      // New baskets are governed by their frozen policy; a legacy row follows the explicitly
      // pinned legacy contract.  This avoids a release changing the live exit of an existing hedge.
      const executionPolicy = this.basketExecutionPolicy(basket);
      const execStop = executionPolicy.stopLossNetReturn ?? 0;
      if (execStop > 0 && netReturn <= -execStop) {
        try {
          await this.closeBasket(basket, "EXEC_STOP");
        } catch (error) {
          this.lastError = (error as Error).message ?? "exec-stop close failed";
        }
        continue;
      }
      const threshold = this.respectSignalRiskGeometry
        ? basket.takeProfitReturn ?? Number.POSITIVE_INFINITY
        : executionPolicy.takeProfitEnabled
          ? executionPolicy.takeProfitNetReturn ?? Number.POSITIVE_INFINITY
          : Number.POSITIVE_INFINITY;
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
      if (
        b.status === "CLOSED" &&
        b.accountingStatus !== "ACCOUNTING_INCOMPLETE" &&
        !isCrossSectionalBasketReportingExcluded(b) &&
        b.closedAt &&
        b.closedAt.slice(0, 10) === day &&
        b.netPnlUsd !== null
      ) {
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
      // The cap is frozen per admission.  A policy deployment must never retrospectively shorten
      // (or lengthen) a basket that was already on the exchange.
      const holdCapHours = this.basketExecutionPolicy(basket).executionCapHours;
      const holdCapMs = holdCapHours !== null ? holdCapHours * 3_600_000 : 0;
      const openedMs = Date.parse(basket.openedAt);
      const cappedDue = holdCapMs > 0 && Number.isFinite(openedMs)
        ? Math.min(basket.closesAtMs, openedMs + holdCapMs)
        : basket.closesAtMs;
      if (nowMs < cappedDue) continue;
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
  private siblingOppositeUnexitedQty(basket: ExecutorBasket | null, symbol: string, side: "LONG" | "SHORT"): number {
    let qty = 0;
    for (const other of this.store.getState().baskets) {
      if (other === basket || !this.isBasketLive(other)) continue;
      for (const leg of other.legs) {
        if (leg.symbol === symbol && leg.side !== side && leg.exitOrderId === null) qty += this.exitRemainingQty(leg);
      }
    }
    for (const leg of this.siblingOpenLegs()) {
      if (leg.symbol === symbol && leg.side !== side) qty += leg.qty;
    }
    return qty;
  }

  /** Sum only durable, exchange-confirmed exit portions. Legacy full exits retain their old shape. */
  private exitFilledQty(leg: ExecutorLeg): number {
    if (Array.isArray(leg.exitFills) && leg.exitFills.length > 0) {
      return leg.exitFills.reduce((sum, fill) => sum + (Number.isFinite(fill.qty) && fill.qty > 0 ? fill.qty : 0), 0);
    }
    return leg.exitOrderId !== null ? leg.qty : 0;
  }

  private exitRemainingQty(leg: ExecutorLeg): number {
    return Math.max(0, leg.qty - this.exitFilledQty(leg));
  }

  /**
   * Stores a close portion before deciding whether a leg is fully flat.  If Binance partially fills
   * the fallback, the next tick knows the exact remaining quantity and cannot accidentally re-close
   * the already-filled maker lot.
   */
  private recordExitFill(leg: ExecutorLeg, fill: ExitFillSlice): void {
    if (!(fill.qty > 0) || !(fill.price > 0)) return;
    const fills = leg.exitFills ?? (leg.exitFills = []);
    if (!fills.some((existing) => existing.orderId === fill.orderId)) fills.push(fill);
    const filledQty = this.exitFilledQty(leg);
    if (filledQty + 1e-9 < leg.qty) {
      leg.exitOrderId = null;
      leg.exitPrice = null;
      leg.exitPriceConfirmed = null;
      return;
    }
    const totalQty = fills.reduce((sum, entry) => sum + entry.qty, 0);
    const totalNotional = fills.reduce((sum, entry) => sum + entry.qty * entry.price, 0);
    leg.exitOrderIds = [...new Set(fills.map((entry) => entry.orderId))];
    leg.exitOrderId = leg.exitOrderIds[leg.exitOrderIds.length - 1] ?? fill.orderId;
    leg.exitPrice = totalQty > 0 ? totalNotional / totalQty : fill.price;
    leg.exitPriceConfirmed = fills.every((entry) => entry.priceConfirmed);
    leg.makerExitAttempt = null;
  }

  private exitDecisionReference(leg: ExecutorLeg, observeStartMs: number): { decisionPrice: number | null; makerPrice: number | null } {
    const exitDirection: "LONG" | "SHORT" = leg.side === "LONG" ? "SHORT" : "LONG";
    const reference = stampSubmitRef(
      buildSubmitRefBase(this.readPublicQuoteFn ? this.readPublicQuoteFn(leg.symbol) : null, observeStartMs, exitDirection),
      Date.parse(this.nowIso()),
    );
    const makerPrice = this.client.cancelOrder
      ? makerLimitPrice(exitDirection, reference?.bid ?? null, reference?.ask ?? null)
      : null;
    return { decisionPrice: reference?.touch ?? reference?.mid ?? null, makerPrice };
  }

  private updateExitExecution(
    leg: ExecutorLeg,
    update: Partial<ExitExecutionRecord> & Pick<ExitExecutionRecord, "mode" | "reason">,
  ): void {
    const previous = leg.exitExecution;
    const next: ExitExecutionRecord = {
      mode: update.mode,
      decisionPrice: update.decisionPrice ?? previous?.decisionPrice ?? null,
      makerQty: update.makerQty ?? previous?.makerQty ?? 0,
      makerPrice: update.makerPrice ?? previous?.makerPrice ?? null,
      fallbackQty: update.fallbackQty ?? previous?.fallbackQty ?? 0,
      fallbackPrice: update.fallbackPrice ?? previous?.fallbackPrice ?? null,
      makerOrderId: update.makerOrderId ?? previous?.makerOrderId ?? null,
      fallbackOrderId: update.fallbackOrderId ?? previous?.fallbackOrderId ?? null,
      durationMs: update.durationMs ?? previous?.durationMs ?? null,
      temporaryImbalanceUsd: update.temporaryImbalanceUsd ?? previous?.temporaryImbalanceUsd ?? null,
      implementationShortfallUsd: update.implementationShortfallUsd ?? previous?.implementationShortfallUsd ?? null,
      feeEstimateUsd: update.feeEstimateUsd ?? previous?.feeEstimateUsd ?? null,
      reason: update.reason,
      completedAt: update.completedAt ?? previous?.completedAt ?? null,
    };
    leg.exitExecution = next;
    leg.exitDecisionPrice = next.decisionPrice;
    leg.exitMakerQty = next.makerQty;
    leg.exitMakerPrice = next.makerPrice;
    leg.exitFallbackQty = next.fallbackQty;
    leg.exitFallbackPrice = next.fallbackPrice;
  }

  private async closeLegMarket(
    basket: ExecutorBasket,
    leg: ExecutorLeg,
    reason: string,
    opts: { decisionPrice?: number | null; makerQty?: number; makerPrice?: number | null; makerOrderId?: string | null; startedAtMs?: number; clientOrderId?: string } = {},
  ): Promise<{ staleBookReconciled: boolean }> {
    let remainingQty = this.exitRemainingQty(leg);
    if (remainingQty <= 1e-9) return { staleBookReconciled: false };
    const exitSide = leg.side === "LONG" ? "SELL" : "BUY";
    const reduceOnly = this.siblingOppositeUnexitedQty(basket, leg.symbol, leg.side) < remainingQty - 1e-9;
    try {
      let clientOrderId = opts.clientOrderId ?? `xsec-${basket.basketId.slice(-12)}-x${basket.legs.indexOf(leg)}-${this.exitFilledQty(leg).toFixed(8).replace(".", "")}`;
      let order: FuturesOrder | null = null;
      // A fallback id is persisted before POST. On restart query it first: submitting the same
      // market fallback a second time is the one failure mode that can reverse a just-closed leg.
      if (opts.clientOrderId && this.client.queryOrderByClientId) {
        try {
          const previous = await this.client.queryOrderByClientId(leg.symbol, clientOrderId);
          if (!["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(previous.status).toUpperCase())) {
            throw new Error(`${leg.symbol}: previous MARKET fallback ${clientOrderId} is still non-terminal; refusing duplicate fallback`);
          }
          const previousExecutedQty = Number.isFinite(previous.executedQty) && previous.executedQty > 0
            ? Math.min(previous.executedQty, remainingQty)
            : 0;
          if (previousExecutedQty > 0) {
            const previousResolved = await this.resolveFillPrice(leg.symbol, previous.orderId, previous.avgPrice, opts.decisionPrice ?? leg.entryPrice);
            this.recordExitFill(leg, {
              orderId: previous.orderId,
              qty: previousExecutedQty,
              price: previousResolved.price,
              priceConfirmed: previousResolved.confirmed,
              liquidity: "TAKER",
            });
          }
          if (this.exitRemainingQty(leg) <= 1e-9) return { staleBookReconciled: false };
          remainingQty = this.exitRemainingQty(leg);
          // A terminal non-fill/partial fill cannot safely reuse its client id. Persist a new
          // retry identity before it leaves this process; the old quantity has already been
          // recorded above, so only the exact residual can be crossed.
          clientOrderId = `${clientOrderId.slice(0, 32)}r${Math.max(1, Math.round(this.exitFilledQty(leg) * 1e8)) % 1000}`;
          if (leg.makerExitAttempt) {
            leg.makerExitAttempt.fallbackClientOrderId = clientOrderId;
            leg.makerExitAttempt.fallbackOrderId = previous.orderId;
          }
          this.store.save();
        } catch (error) {
          if (!this.isOrderNotFound(error)) throw error;
        }
      }
      order ??= await this.client.placeOrder({
        symbol: leg.symbol,
        side: exitSide,
        type: "MARKET",
        quantity: remainingQty,
        ...(reduceOnly ? { reduceOnly: true } : {}),
        newClientOrderId: clientOrderId,
      });
      if (leg.makerExitAttempt?.fallbackClientOrderId === clientOrderId) {
        leg.makerExitAttempt.fallbackOrderId = order.orderId;
      }
      const resolved = await this.resolveFillPrice(leg.symbol, order.orderId, order.avgPrice, opts.decisionPrice ?? leg.entryPrice);
      const executedQty = Number.isFinite(order.executedQty) && order.executedQty > 0
        ? Math.min(order.executedQty, remainingQty)
        : remainingQty;
      this.recordExitFill(leg, {
        orderId: order.orderId,
        qty: executedQty,
        price: resolved.price,
        priceConfirmed: resolved.confirmed,
        liquidity: "TAKER",
      });
      const makerQty = opts.makerQty ?? 0;
      const makerPrice = opts.makerPrice ?? null;
      const decisionPrice = opts.decisionPrice ?? null;
      const finalExitPrice = leg.exitPrice ?? resolved.price;
      const totalExitQty = makerQty + executedQty;
      const implementationShortfallUsd = decisionPrice !== null && finalExitPrice > 0
        ? (leg.side === "LONG" ? decisionPrice - finalExitPrice : finalExitPrice - decisionPrice) * totalExitQty
        : null;
      const feeEstimateUsd =
        (makerQty * (makerPrice ?? 0) * 0.0002) +
        (executedQty * resolved.price * 0.0005);
      this.updateExitExecution(leg, {
        mode: makerQty > 0 ? "MAKER_FIRST" : "MARKET",
        reason,
        decisionPrice,
        makerQty,
        makerPrice,
        makerOrderId: opts.makerOrderId ?? null,
        fallbackQty: executedQty,
        fallbackPrice: resolved.price,
        fallbackOrderId: order.orderId,
        durationMs: opts.startedAtMs === undefined ? null : Math.max(0, Date.now() - opts.startedAtMs),
        implementationShortfallUsd,
        feeEstimateUsd,
        completedAt: leg.exitOrderId !== null ? this.nowIso() : null,
      });
      this.store.save();
      return { staleBookReconciled: false };
    } catch (error) {
      const message = (error as Error).message;
      if (reduceOnly && /(?:code\s*)?-2022|ReduceOnly Order is rejected/i.test(message)) {
        try {
          const positions = await this.client.getPositions(leg.symbol);
          const positionAmt = positions.find((position) => position.symbol === leg.symbol)?.positionAmt ?? 0;
          const expectedSign = leg.side === "LONG" ? 1 : -1;
          if (Math.abs(positionAmt) <= 1e-9 || Math.sign(positionAmt) !== expectedSign) {
            leg.exitOrderId = "POSITION_ALREADY_FLAT";
            leg.exitPrice = null;
            leg.exitPriceConfirmed = false;
            this.store.save();
            return { staleBookReconciled: true };
          }
        } catch {
          // Preserve the original close error when exchange reconciliation is unavailable.
        }
      }
      throw error;
    }
  }

  private basketTemporaryImbalanceUsd(basket: ExecutorBasket): number {
    let longUsd = 0;
    let shortUsd = 0;
    for (const leg of basket.legs) {
      const notional = this.exitRemainingQty(leg) * leg.entryPrice;
      if (leg.side === "LONG") longUsd += notional;
      else shortUsd += notional;
    }
    return Math.abs(longUsd - shortUsd);
  }

  private isOrderNotFound(error: unknown): boolean {
    return error instanceof BinanceFuturesPrivateError && error.binanceCode === -2013;
  }

  private async queryMakerExitAttempt(leg: ExecutorLeg, attempt: MakerExitAttempt): Promise<FuturesOrder | null> {
    try {
      if (attempt.makerOrderId) return await this.client.queryOrder(leg.symbol, attempt.makerOrderId);
      if (!this.client.queryOrderByClientId) throw new Error("maker exit recovery unavailable: queryOrderByClientId is not wired");
      return await this.client.queryOrderByClientId(leg.symbol, attempt.clientOrderId);
    } catch (error) {
      if (this.isOrderNotFound(error)) return null;
      throw error;
    }
  }

  private async settleMakerExitAttempt(
    basket: ExecutorBasket,
    candidate: MakerExitCandidate,
    reason: string,
    makerOrder: FuturesOrder | null,
    startedAtMs: number,
  ): Promise<{ leg: ExecutorLeg; makerQty: number; makerPrice: number | null; makerOrderId: string | null; decisionPrice: number | null; fallbackClientOrderId: string } | null> {
    const { leg, attempt } = candidate;
    if (makerOrder === null) {
      // Binance explicitly says the post-only client id does not exist.  It is now safe to cross
      // the original requested quantity; any other query failure remains a hard failure instead.
      attempt.phase = "FALLBACK_SUBMITTED";
      attempt.fallbackClientOrderId ??= `${attempt.clientOrderId}f`;
      this.store.save();
      return {
        leg,
        makerQty: 0,
        makerPrice: null,
        makerOrderId: null,
        decisionPrice: attempt.decisionPrice,
        fallbackClientOrderId: attempt.fallbackClientOrderId,
      };
    }
    attempt.makerOrderId = makerOrder.orderId;
    if (!["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(makerOrder.status).toUpperCase())) {
      try { await this.client.cancelOrder!(leg.symbol, makerOrder.orderId); } catch { /* terminal race; re-query decides */ }
      makerOrder = await this.client.queryOrder(leg.symbol, makerOrder.orderId);
    }
    const decision = resolveMakerLeg(attempt.requestedQty, makerOrder.status, makerOrder.executedQty);
    if (decision.action === "UNKNOWN_REQUERY") {
      attempt.phase = "RECONCILIATION_PENDING";
      this.store.save();
      throw new Error(`${leg.symbol}: maker exit status is inconclusive (${decision.reason}); no fallback sent`);
    }
    let makerPrice: number | null = null;
    if (decision.filledQty > 0) {
      const resolved = await this.resolveFillPrice(leg.symbol, makerOrder.orderId, makerOrder.avgPrice, attempt.makerPrice ?? leg.entryPrice);
      makerPrice = resolved.price;
      this.recordExitFill(leg, {
        orderId: makerOrder.orderId,
        qty: decision.filledQty,
        price: resolved.price,
        priceConfirmed: resolved.confirmed,
        liquidity: "MAKER",
      });
    }
    const temporaryImbalanceUsd = this.basketTemporaryImbalanceUsd(basket);
    if (decision.action === "DONE") {
      const exitPrice = leg.exitPrice ?? makerPrice ?? attempt.makerPrice ?? leg.entryPrice;
      const shortfall = attempt.decisionPrice !== null
        ? (leg.side === "LONG" ? attempt.decisionPrice - exitPrice : exitPrice - attempt.decisionPrice) * decision.filledQty
        : null;
      this.updateExitExecution(leg, {
        mode: "MAKER_FIRST",
        reason,
        decisionPrice: attempt.decisionPrice,
        makerQty: decision.filledQty,
        makerPrice,
        makerOrderId: makerOrder.orderId,
        fallbackQty: 0,
        fallbackPrice: null,
        fallbackOrderId: null,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        temporaryImbalanceUsd,
        implementationShortfallUsd: shortfall,
        feeEstimateUsd: decision.filledQty * (makerPrice ?? 0) * 0.0002,
        completedAt: leg.exitOrderId !== null ? this.nowIso() : null,
      });
      this.store.save();
      return null;
    }
    attempt.phase = "FALLBACK_SUBMITTED";
    attempt.fallbackClientOrderId ??= `${attempt.clientOrderId}f`;
    this.store.save();
    return {
      leg,
      makerQty: decision.filledQty,
      makerPrice,
      makerOrderId: makerOrder.orderId,
      decisionPrice: attempt.decisionPrice,
      fallbackClientOrderId: attempt.fallbackClientOrderId,
    };
  }

  /**
   * Normal scheduled exits post every leg concurrently, wait once, then cancel and cross ONLY the
   * confirmed remainder.  STOP/kill/reconciliation routes never call this method.
   */
  private async closeBasketMakerFirst(basket: ExecutorBasket, reason: string): Promise<void> {
    const startedAtMs = Date.now();
    const liveLegs = basket.legs.filter((leg) => leg.exitOrderId === null && this.exitRemainingQty(leg) > 1e-9);
    if (liveLegs.length === 0) return;

    // A partial fallback is already an emergency residual: cross only its remaining quantity on
    // the next retry, never post a new maker order for the lot that already filled.
    const residual = liveLegs.filter((leg) => Array.isArray(leg.exitFills) && leg.exitFills.length > 0);
    const residualResults = await Promise.allSettled(residual.map((leg) => this.closeLegMarket(basket, leg, reason, {
      decisionPrice: leg.makerExitAttempt?.decisionPrice ?? leg.exitDecisionPrice ?? null,
      makerQty: leg.exitExecution?.makerQty ?? 0,
      makerPrice: leg.exitExecution?.makerPrice ?? null,
      makerOrderId: leg.exitExecution?.makerOrderId ?? null,
      startedAtMs,
      clientOrderId: leg.makerExitAttempt?.fallbackClientOrderId ?? undefined,
    })));
    const residualFailure = residualResults.find((result) => result.status === "rejected");
    if (residualFailure?.status === "rejected") throw residualFailure.reason;

    const freshLegs = liveLegs.filter((leg) => !residual.includes(leg));
    if (freshLegs.length === 0) return;

    const preexisting = freshLegs.filter((leg) => leg.makerExitAttempt !== null && leg.makerExitAttempt !== undefined);
    const fallbacks: Array<{ leg: ExecutorLeg; makerQty: number; makerPrice: number | null; makerOrderId: string | null; decisionPrice: number | null; fallbackClientOrderId: string }> = [];
    for (const leg of preexisting) {
      const attempt = leg.makerExitAttempt!;
      const candidate: MakerExitCandidate = {
        leg,
        attempt,
        decisionPrice: attempt.decisionPrice,
        makerPrice: attempt.makerPrice ?? leg.entryPrice,
        exitSide: leg.side === "LONG" ? "SELL" : "BUY",
      };
      const makerOrder = await this.queryMakerExitAttempt(leg, attempt);
      const fallback = await this.settleMakerExitAttempt(basket, candidate, reason, makerOrder, startedAtMs);
      if (fallback) fallbacks.push(fallback);
    }

    const fresh = freshLegs.filter((leg) => !preexisting.includes(leg));
    const observeStartMs = Date.now();
    if (this.warmPublicQuoteFn) await Promise.allSettled(fresh.map((leg) => this.warmPublicQuoteFn!(leg.symbol)));
    const makers: MakerExitCandidate[] = [];
    const noBook: ExecutorLeg[] = [];
    for (const leg of fresh) {
      const remainingQty = this.exitRemainingQty(leg);
      const exitSide: "BUY" | "SELL" = leg.side === "LONG" ? "SELL" : "BUY";
      const { decisionPrice, makerPrice } = this.exitDecisionReference(leg, observeStartMs);
      if (makerPrice === null || remainingQty <= 1e-9) {
        noBook.push(leg);
        continue;
      }
      const reduceOnly = this.siblingOppositeUnexitedQty(basket, leg.symbol, leg.side) < remainingQty - 1e-9;
      const attempt: MakerExitAttempt = {
        phase: "PREPARED",
        requestedQty: remainingQty,
        clientOrderId: `xsec-${basket.basketId.slice(-12)}-xm${basket.legs.indexOf(leg)}-${Math.floor(startedAtMs % 1_000_000)}`,
        makerOrderId: null,
        fallbackClientOrderId: null,
        fallbackOrderId: null,
        makerPrice,
        decisionPrice,
        reduceOnly,
        startedAt: this.nowIso(),
      };
      leg.makerExitAttempt = attempt;
      makers.push({ leg, attempt, decisionPrice, makerPrice, exitSide });
    }
    this.store.save(); // durable before ANY post-only order leaves this process

    const directResults = await Promise.allSettled(noBook.map((leg) => this.closeLegMarket(basket, leg, reason, { startedAtMs })));
    const directFailure = directResults.find((result) => result.status === "rejected");
    if (directFailure?.status === "rejected") throw directFailure.reason;

    await Promise.allSettled(makers.map(async (candidate) => {
      const { leg, attempt, makerPrice, exitSide } = candidate;
      try {
        const order = await this.client.placeOrder({
          symbol: leg.symbol,
          side: exitSide,
          type: "LIMIT",
          timeInForce: "GTX",
          price: makerPrice,
          quantity: attempt.requestedQty,
          ...(attempt.reduceOnly ? { reduceOnly: true } : {}),
          newClientOrderId: attempt.clientOrderId,
        });
        attempt.makerOrderId = order.orderId;
        attempt.phase = "RESTING";
      } finally {
        this.store.save();
      }
    }));

    // One bounded wait for the whole six-leg basket, not N×wait. Polling permits an early exit when
    // every post-only order reaches a terminal state.
    const waitMs = crossSectionalMakerExitWaitMs();
    const deadline = Date.now() + waitMs;
    while (makers.length > 0 && Date.now() < deadline) {
      const states = await Promise.allSettled(makers.map((candidate) => this.queryMakerExitAttempt(candidate.leg, candidate.attempt)));
      const anyResting = states.some((state) => state.status === "fulfilled" && state.value !== null && !["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(state.value.status).toUpperCase()));
      if (!anyResting) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(1_000, Math.max(1, deadline - Date.now()))));
    }

    await Promise.allSettled(makers.map(async (candidate) => {
      const order = await this.queryMakerExitAttempt(candidate.leg, candidate.attempt);
      if (order && !["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(order.status).toUpperCase())) {
        try { await this.client.cancelOrder!(candidate.leg.symbol, order.orderId); } catch { /* terminal race; re-query below is authoritative */ }
      }
    }));

    for (const candidate of makers) {
      const makerOrder = await this.queryMakerExitAttempt(candidate.leg, candidate.attempt);
      const fallback = await this.settleMakerExitAttempt(basket, candidate, reason, makerOrder, startedAtMs);
      if (fallback) fallbacks.push(fallback);
    }
    this.store.save(); // fallback identities are durable before any MARKET remainder goes out
    const fallbackResults = await Promise.allSettled(fallbacks.map((fallback) => this.closeLegMarket(basket, fallback.leg, reason, {
      decisionPrice: fallback.decisionPrice,
      makerQty: fallback.makerQty,
      makerPrice: fallback.makerPrice,
      makerOrderId: fallback.makerOrderId,
      startedAtMs,
      clientOrderId: fallback.fallbackClientOrderId,
    })));
    const fallbackFailure = fallbackResults.find((result) => result.status === "rejected");
    if (fallbackFailure?.status === "rejected") throw fallbackFailure.reason;
  }

  private async reconcileBasketExit(basket: ExecutorBasket): Promise<boolean> {
    // Legacy baskets retain their pre-cutover settle contract. New policy baskets must prove that
    // the exchange's net position equals the remaining sibling-book position before they become CLOSED.
    if (!basket.policyFingerprint) return true;
    const relevantSymbols = new Set(basket.legs.map((leg) => leg.symbol));
    const positions = await this.sharedGetPositions();
    const exchangeBySymbol = new Map(positions.map((position) => [position.symbol, position.positionAmt]));
    const expectedBySymbol = new Map<string, number>();
    const add = (symbol: string, side: "LONG" | "SHORT", qty: number) => {
      if (!relevantSymbols.has(symbol) || !(qty > 0)) return;
      expectedBySymbol.set(symbol, (expectedBySymbol.get(symbol) ?? 0) + (side === "LONG" ? qty : -qty));
    };
    for (const other of this.store.getState().baskets) {
      if (other === basket || !this.isBasketLive(other)) continue;
      for (const leg of other.legs) add(leg.symbol, leg.side, this.exitRemainingQty(leg));
    }
    for (const leg of this.siblingOpenLegs()) add(leg.symbol, leg.side, leg.qty);
    const residualBySymbol = [...relevantSymbols].sort().map((symbol) => ({
      symbol,
      expectedNetQty: expectedBySymbol.get(symbol) ?? 0,
      exchangeNetQty: exchangeBySymbol.get(symbol) ?? 0,
    }));
    const confirmed = residualBySymbol.every((row) => Math.abs(row.exchangeNetQty - row.expectedNetQty) <= 1e-8);
    basket.exitReconciliation = { state: confirmed ? "CONFIRMED" : "PENDING", checkedAt: this.nowIso(), residualBySymbol };
    this.store.save();
    return confirmed;
  }

  private async closeBasket(basket: ExecutorBasket, reason: string): Promise<void> {
    const failures: string[] = [];
    let staleBookReconciled = false;
    if (this.shouldUseMakerExit(basket, reason)) {
      try {
        await this.closeBasketMakerFirst(basket, reason);
      } catch (error) {
        failures.push((error as Error).message);
      }
    } else {
      // Safety/emergency exits are immediate MARKET and remain per-leg isolated: one failed leg
      // must not prevent the other legs from being flattened in the same tick.
      for (const leg of basket.legs) {
        if (leg.exitOrderId !== null) continue;
        try {
          const result = await this.closeLegMarket(basket, leg, reason);
          staleBookReconciled ||= result.staleBookReconciled;
        } catch (error) {
          failures.push(`${leg.symbol}: ${(error as Error).message}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`basket ${basket.basketId} close incomplete, ${failures.length} leg(s) failed: ${failures[0]}`);
    }
    if (basket.legs.some((leg) => leg.exitOrderId === null)) {
      throw new Error(`basket ${basket.basketId} close incomplete: exchange filled only part of one or more legs; retrying remaining quantity without reversing`);
    }
    if (staleBookReconciled) {
      basket.status = "ABORTED";
      basket.closedAt = this.nowIso();
      basket.closeReason = `RECONCILED_POSITION_ALREADY_FLAT:${reason}`;
      basket.grossPnlUsd = null;
      basket.feeEstimateUsd = null;
      basket.netPnlUsd = null;
      // Operator spec (2026-08-05, panic-flatten accounting gap): the leg was closed OUT-OF-BAND
      // (e.g. flattenAllExchangePositions(), a SEPARATE raw close path — see accountingStatus's own
      // doc comment) with no real fill/exit price ever available to this basket. null P&L alone is
      // not enough — every learning/PF-WR/promotion/CORTEX-label consumer must be able to tell
      // "genuinely unknown" apart from a real $0 close, and exclude it rather than zero-fill it.
      basket.accountingStatus = "ACCOUNTING_INCOMPLETE";
      this.markFourBrainBasketUnmeasured(basket, "ACCOUNTING_INCOMPLETE_POSITION_ALREADY_FLAT");
      this.store.save();
      return;
    }
    if (!(await this.reconcileBasketExit(basket))) {
      throw new Error(`basket ${basket.basketId} exit reconciliation pending: exchange net does not yet match sibling ledger`);
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
    // Unlike the dashboard's basket-level fee allocation, direct Four-Brain Tier-1 learning
    // needs the exchange commission for THIS exact entry+exit pair. Preserve it by order id while
    // we already have the userTrades pages in memory; no extra exchange call is introduced.
    const commissionBySymbolOrderId = new Map<string, number>();
    const roleKey = (symbol: string, orderId: string): string => `${symbol}|${orderId}`;
    for (const leg of basket.legs) {
      const ids = orderIdsBySymbol.get(leg.symbol) ?? new Set<string>();
      ids.add(leg.entryOrderId);
      roleBySymbolOrderId.set(roleKey(leg.symbol, leg.entryOrderId), "ENTRY");
      const exitOrderIds = leg.exitOrderIds ?? (leg.exitOrderId !== null ? [leg.exitOrderId] : []);
      for (const exitOrderId of exitOrderIds) {
        if (exitOrderId === "POSITION_ALREADY_FLAT") continue;
        ids.add(exitOrderId);
        roleBySymbolOrderId.set(roleKey(leg.symbol, exitOrderId), "EXIT");
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
            const commissionKey = roleKey(symbol, t.orderId);
            commissionBySymbolOrderId.set(commissionKey, (commissionBySymbolOrderId.get(commissionKey) ?? 0) + t.commission);
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
    const estimatedFees = basket.legs.reduce((sum, leg) => {
      const entry = leg.entryLiquidity
        ? leg.entryLiquidity.makerQty * leg.entryPrice * 0.0002 + leg.entryLiquidity.takerQty * leg.entryPrice * TAKER_FEE_RATE
        : leg.qty * leg.entryPrice * TAKER_FEE_RATE;
      const exitSlices = leg.exitFills;
      const exit = Array.isArray(exitSlices) && exitSlices.length > 0
        ? exitSlices.reduce((sliceSum, slice) => sliceSum + slice.qty * slice.price * (slice.liquidity === "MAKER" ? 0.0002 : TAKER_FEE_RATE), 0)
        : (leg.exitPrice ?? leg.entryPrice) * leg.qty * TAKER_FEE_RATE;
      return sum + entry + exit;
    }, 0);
    const fees = feeIsExchangeSourced && realFees !== null ? realFees : estimatedFees;
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
    // Close each causal leg only when BOTH exchange fills and BOTH commissions are present.  The
    // incumbent basket P&L can still use its documented aggregate fallback, but Four-Brain must
    // never convert an estimate or a page-truncated commission set into a supposedly actual R.
    for (const leg of basket.legs) {
      const entryCommission = commissionBySymbolOrderId.get(roleKey(leg.symbol, leg.entryOrderId));
      const exitIds = leg.exitOrderIds ?? (leg.exitOrderId && leg.exitOrderId !== "POSITION_ALREADY_FLAT" ? [leg.exitOrderId] : []);
      const exitCommission = exitIds.length > 0
        ? exitIds.reduce<number | undefined>((sum, orderId) => {
          const commission = commissionBySymbolOrderId.get(roleKey(leg.symbol, orderId));
          return commission === undefined || sum === undefined ? undefined : sum + commission;
        }, 0)
        : undefined;
      const settled =
        feeIsExchangeSourced &&
        !anyPageSaturated &&
        leg.entryPriceConfirmed === true &&
        leg.exitPriceConfirmed === true &&
        leg.exitPrice !== null &&
        entryCommission !== undefined &&
        exitCommission !== undefined;
      const grossLeg =
        settled && leg.exitPrice !== null
          ? (leg.side === "LONG" ? 1 : -1) * (leg.exitPrice - leg.entryPrice) * leg.qty
          : null;
      this.completeFourBrainActualFill(basket, leg, {
        netPnlUsd: grossLeg === null ? null : grossLeg - entryCommission! - exitCommission!,
        settlementConfirmed: settled,
        reason: settled ? reason : "EXCHANGE_SETTLEMENT_INCOMPLETE",
      });
    }
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

    const entryAdmission = this.entryAdmissionForSignal(signal);
    if (!entryAdmission.allowed) {
      this.recordEntryAdmission(signal, entryAdmission, "BLOCKED");
      this.recordEntryAttempt(signal, {
        stage: "ENTRY_ADMISSION",
        outcome: "DEFERRED",
        reason: entryAdmission.reason ?? "entry traffic light blocked new basket",
        referencePrices: {},
        watermarkAdvanced: false,
      });
      this.store.save();
      this.openHalted = entryAdmission.reason ?? "entry traffic light blocked new basket";
      return;
    }

    if (this.lossReentryGuardEnabledFn()) {
      try {
        const blocks = await this.getLossReentryBlocks();
        const blocked = new Set(blocks.map((block) => `${block.symbol}|${block.side}`));
        const conflicts = [
          ...signal.longLeg.map((leg) => `${leg.symbol}|LONG`),
          ...signal.shortLeg.map((leg) => `${leg.symbol}|SHORT`),
        ].filter((key) => blocked.has(key));
        if (conflicts.length) {
          this.skipSignal(
            signal,
            "LOSS_REENTRY_GUARD",
            `loss re-entry guard skipped stale signal: ${conflicts.join(", ")}`,
          );
          return;
        }
      } catch (error) {
        this.skipSignal(
          signal,
          "LOSS_REENTRY_GUARD",
          `loss re-entry guard could not verify live marks; skipped signal: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }

    if (this.overlapGuardEnabledFn()) {
      try {
        const positions = await this.sharedGetPositions();
        const markBySymbol = Object.fromEntries(
          positions
            .filter((position) => Number.isFinite(position.markPrice) && position.markPrice > 0)
            .map((position) => [position.symbol, position.markPrice]),
        );
        const overlap = evaluateCrossSectionalOverlap(signal, st.baskets, markBySymbol, this.estimatedCloseCostPctFn(), {
          maxTotal: this.maxOverlappingSymbolsFn(),
          maxPerSide: this.maxOverlappingSymbolsPerSideFn(),
          minScoreDelta: this.overlapMinScoreDeltaFn(),
          minAbsScore: this.overlapMinAbsScoreFn(),
          maxAdverseExtensionVol: this.overlapMaxAdverseExtensionVolFn(),
          minAdverseExtensionPct: this.overlapMinAdverseExtensionPctFn(),
          maxSignalDriftVol: this.overlapMaxSignalDriftVolFn(),
          minSignalDriftPct: this.overlapMinSignalDriftPctFn(),
        });
        if (!overlap.allowed) {
          this.skipSignal(signal, "OVERLAP_GUARD", overlap.reason ?? "overlap guard rejected basket");
          return;
        }
      } catch (error) {
        this.skipSignal(
          signal,
          "OVERLAP_GUARD",
          `overlap guard could not verify live marks; skipped signal: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }

    // Netting guard (2026-08-15) — see crossSectionalSymbolNettingConflict. Placed with the other
    // pre-open guards on purpose: this is the last point at which the collision costs nothing.
    // Skip-only, never cancels or flattens. A position row that is missing or unreadable is treated
    // as "incomplete data, do not decide" — the same convention closeBasketsHittingProfitTarget uses
    // for missing marks — so a thin positions response defers rather than blocks the lane forever.
    if (NETTING_GUARD_ENABLED()) {
      try {
        const positions = await this.sharedGetPositions();
        const conflicts: string[] = [];
        for (const [side, legs] of [["LONG", signal.longLeg], ["SHORT", signal.shortLeg]] as const) {
          for (const leg of legs) {
            const position = positions.find((row) => row.symbol === leg.symbol);
            if (!position || !Number.isFinite(position.positionAmt)) continue;
            const explained = this.siblingOppositeUnexitedQty(null, leg.symbol, side);
            if (crossSectionalSymbolNettingConflict(side, position.positionAmt, explained)) {
              conflicts.push(`${leg.symbol} ${side} vs exchange net ${position.positionAmt} (baskets explain ${explained})`);
            }
          }
        }
        if (conflicts.length) {
          this.skipSignal(
            signal,
            "NETTING_GUARD",
            `netting guard: another lane already holds the opposite side — ${conflicts.join("; ")}`,
          );
          return;
        }
      } catch (error) {
        this.skipSignal(
          signal,
          "NETTING_GUARD",
          `netting guard could not read exchange positions; skipped signal: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }

    const smartEntry = await this.revalidateSmartEntry(signal);
    if (!smartEntry.allowed) {
      // This is a defer-to-next-scan decision, not a permanent symbol rejection.  Advancing the
      // watermark prevents a five-minute loop from repeatedly chasing the exact same stale rank.
      this.skipSignal(
        signal,
        "SMART_ENTRY_REVALIDATION",
        smartEntry.reason ?? "smart entry revalidation rejected basket",
        smartEntry.referencePrices,
      );
      return;
    }

    // Capture exact causal geometry only after all upstream admission/revalidation has passed.
    // The observer remains fail-open, but now receives the same refreshed reference price and
    // frozen risk distance that this basket will actually size from.  `nowMs` is intentionally
    // the pre-submit wall clock; the eventual exchange fill binds only if it follows this record.
    if (this.fourBrainEntryGate) {
      const riskDistance = Number.isFinite(signal.riskDistanceAtOpen) && signal.riskDistanceAtOpen! > 0
        ? signal.riskDistanceAtOpen!
        : null;
      for (const [side, legs] of [["LONG", signal.longLeg], ["SHORT", signal.shortLeg]] as const) {
        for (const leg of legs) {
          const entryPrice = smartEntry.referencePrices[leg.symbol] ?? leg.entryPrice;
          const stopPrice = riskDistance !== null && Number.isFinite(entryPrice) && entryPrice > 0
            ? side === "LONG"
              ? entryPrice * (1 - riskDistance)
              : entryPrice * (1 + riskDistance)
            : null;
          const bridge = this.fourBrainEntryGate({
            laneId: this.laneId,
            symbol: leg.symbol,
            side,
            signalId: `${signal.observationId}:${side}:${leg.symbol}`,
            nowMs,
            entryPrice,
            stopPrice,
            openedAtMs: nowMs,
          });
          if (!bridge.allowed) {
            this.skipSignal(
              signal,
              "FOUR_BRAIN_BRIDGE",
              bridge.reason ?? `Four-Brain pilot blocked ${leg.symbol}/${side}`,
            );
            return;
          }
        }
      }
    }

    // Watermark BEFORE placing orders: a failed basket must not retry forever.
    st.lastSeenSignalMs = signal.openedAtMs;
    this.store.save();

    let filters: Map<string, FuturesSymbolFilters>;
    try {
      filters = await this.client.getExchangeFilters();
    } catch (error) {
      const reason = `exchange filters unavailable; skipped signal: ${error instanceof Error ? error.message : String(error)}`;
      this.skipSignal(signal, "EXCHANGE_FILTERS", reason, smartEntry.referencePrices);
      this.lastError = reason;
      return;
    }
    // YELLOW is a real but bounded testnet learning order, not a fake paper result. The same
    // multiplier reaches every leg so the basket remains market-neutral; exchange minimums can
    // still lift a leg to a valid quantity, and the existing per-symbol caps remain authoritative.
    const equalLegUsd = this.effectiveLegUsd() * entryAdmission.sizeMultiplier;
    if (!(equalLegUsd > 0)) {
      this.skipSignal(signal, "SIZING", "effective per-leg USD is not positive", smartEntry.referencePrices);
      return;
    }
    // Signal weights sum to 1 across both sides. Keeping this total equal to the legacy
    // N×legUsd gross preserves deployed capital while allowing capped inverse-vol sizing.
    const totalBasketUsd = equalLegUsd * (signal.longLeg.length + signal.shortLeg.length);
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
        const referencePrice = smartEntry.referencePrices[leg.symbol] ?? leg.entryPrice;
        if (!f || !(referencePrice > 0)) {
          releasePlannedSoFar("SIBLING_LEG_MISSING_FILTERS");
          this.skipSignal(
            signal,
            "SIZING",
            `${leg.symbol} missing exchange filters or a usable reference price`,
            smartEntry.referencePrices,
          );
          return;
        } // missing filters/price ⇒ skip whole basket
        const signalWeight = Number.isFinite(leg.weight) && leg.weight! > 0 ? leg.weight! : null;
        const targetNotionalUsd = signalWeight === null ? equalLegUsd : totalBasketUsd * signalWeight;
        const qty = sizeCrossSectionalLeg(targetNotionalUsd, referencePrice, f);
        if (qty === null) {
          releasePlannedSoFar("SIBLING_LEG_UNDERSIZED");
          this.skipSignal(
            signal,
            "SIZING",
            `${leg.symbol} cannot be sized to Binance filters from ${targetNotionalUsd.toFixed(4)} USDT`,
            smartEntry.referencePrices,
          );
          return;
        } // any un-sizeable leg ⇒ skip whole basket (hedge integrity)
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
          this.existingNotionalForSymbolFn(leg.symbol) + this.ownOpenNotionalForSymbol(leg.symbol) + qty * referencePrice > notionalCap
        ) {
          releasePlannedSoFar("SIBLING_LEG_NOTIONAL_CAP");
          this.skipSignal(
            signal,
            "NOTIONAL_CAP",
            `${leg.symbol} would exceed shared per-symbol notional cap ${notionalCap.toFixed(2)} USDT`,
            smartEntry.referencePrices,
          );
          return;
        }
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
          requestedNotionalUsd: qty * referencePrice,
          clientOrderId: entryClientOrderId,
          basketId,
          campaignCap,
        });
        if (!legReservation.ok) {
          releasePlannedSoFar(`SIBLING_LEG_RESERVE_FAILED:${legReservation.reason ?? "unknown"}`);
          this.skipSignal(
            signal,
            "EXPOSURE_RESERVATION",
            `${leg.symbol} shared exposure reservation rejected: ${legReservation.reason ?? "unknown"}`,
            smartEntry.referencePrices,
          );
          return;
        }
        plannedLegs.push({
          planIndex,
          symbol: leg.symbol,
          side,
          requestedQty: Number(qty.toFixed(8)),
          refPrice: referencePrice,
          targetNotionalUsd,
          signalWeight,
          scoreAtOpen: Number.isFinite(leg.scoreAtOpen) ? leg.scoreAtOpen! : null,
          volatilityAtOpen: Number.isFinite(leg.volatilityAtOpen) ? leg.volatilityAtOpen! : null,
          reservationId: legReservation.reservationId,
          entryClientOrderId,
          status: "PENDING",
          failureReason: null,
        });
      }
    }
    // 2026-08-15 neutrality guard — see crossSectionalPlanNotionalImbalance's doc comment. Runs
    // AFTER every leg is sized (so it sees the real, lot-rounded notionals) and BEFORE any order is
    // placed. Skip-only: it never resizes, never cancels, never opens anything. Disabled by default
    // (threshold 0) so enabling it is an explicit operator act.
    const plannedImbalanceMax = crossSectionalMaxPlanImbalance();
    if (crossSectionalPlanImbalanceExceeded(plannedLegs, plannedImbalanceMax)) {
      const pct = (100 * crossSectionalPlanNotionalImbalance(plannedLegs)).toFixed(2);
      releasePlannedSoFar("PLAN_NOTIONAL_IMBALANCE");
      this.skipSignal(
        signal,
        "SIZING",
        `planned basket is ${pct}% long/short imbalanced after lot rounding (ceiling ${(100 * plannedImbalanceMax).toFixed(2)}%) — not market-neutral`,
        smartEntry.referencePrices,
      );
      return;
    }
    if (plannedLegs.length !== signal.longLeg.length + signal.shortLeg.length) {
      releasePlannedSoFar("PLANNED_LEG_COUNT_MISMATCH");
      this.skipSignal(
        signal,
        "SIZING",
        `planned ${plannedLegs.length}/${signal.longLeg.length + signal.shortLeg.length} hedge legs`,
        smartEntry.referencePrices,
      );
      return;
    }

    const basket: ExecutorBasket = {
      basketId,
      sourceObservationId: signal.observationId,
      signal: signal.signal,
      variant: signal.variant ?? "RAW",
      openedAt: this.nowIso(),
      closesAtMs: signal.openedAtMs + signal.horizonMs,
      policyFingerprint: buildCurrentCrossSectionalPolicyFingerprint(this.nowIso()),
      takeProfitReturn: this.respectSignalRiskGeometry ? signal.takeProfitReturn ?? null : undefined,
      stopLossReturn: this.respectSignalRiskGeometry ? signal.stopLossReturn ?? null : undefined,
      riskDistanceAtOpen: Number.isFinite(signal.riskDistanceAtOpen) && signal.riskDistanceAtOpen! > 0
        ? signal.riskDistanceAtOpen!
        : null,
      smartBasket: this.isSmartBasketSignal(signal)
        ? {
            version: "SMART_BASKET_V1",
            sourceOpenedAtMs: signal.openedAtMs,
            axisScoreAtOpen: typeof signal.smartFormation?.axisScore === "number" && Number.isFinite(signal.smartFormation.axisScore)
              ? signal.smartFormation.axisScore
              : null,
            maxNetReturn: null,
            maxNetAt: null,
            lastInvalidationSignalMs: signal.openedAtMs,
            consecutiveInvalidationScans: 0,
            lastInvalidationReason: null,
            regimeClassAtOpen: signal.regimeClassAtOpen ?? signal.regimeContext?.regimeClass ?? null,
            lastRegimeLossSignalMs: signal.openedAtMs,
            consecutiveRegimeLossScans: 0,
            lastRegimeLossReason: null,
            entryRevalidatedAt: smartEntry.at,
            entryReferencePrices: smartEntry.referencePrices,
          }
        : null,
      entryAdmission,
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
    this.recordEntryAdmission(signal, entryAdmission, "ADMITTED");
    this.recordEntryAttempt(signal, {
      stage: "BASKET_RESERVED",
      outcome: "ADMITTED",
      reason: null,
      referencePrices: smartEntry.referencePrices,
      watermarkAdvanced: true,
    });
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
  private async markRemainingNeverAttempted(basket: ExecutorBasket, fromIndex: number, releaseReason: string): Promise<void> {
    const plan = basket.plan ?? [];
    for (let j = fromIndex; j < plan.length; j++) {
      const entry = plan[j]!;
      if (entry.status === "FILLED") continue; // defensive — should be unreachable this far
      // A pre-placed maker leg has a REAL order resting on the exchange. Marking it
      // NEVER_ATTEMPTED without retracting it would leave an order that can still fill into a
      // position no basket tracks — the invisible-naked-position class this file's reconciliation
      // exists to prevent. Before parallel pre-placement this could not happen, because a leg that
      // was never attempted genuinely had no order; it can now, and mid-open aborts are not rare
      // (3 of the first 10 baskets ended KILL_OR_DRAIN_MID_OPEN).
      if (entry.makerRestingOrderId && this.client.cancelOrder) {
        try { await this.client.cancelOrder(entry.symbol, entry.makerRestingOrderId); } catch { /* already terminal */ }
        // Cancel, THEN read — the order can fill in the window between the two, and only the
        // post-cancel figure is final.
        try {
          const after = await this.client.queryOrder(entry.symbol, entry.makerRestingOrderId);
          const executed = Number.isFinite(after.executedQty) && after.executedQty > 0 ? after.executedQty : 0;
          if (executed > 0) {
            // It DID fill. Hand it to the orphan machinery, which already flattens untracked
            // exposure every tick — never silently drop it just because the basket is aborting.
            this.recordOrphanedLeg(
              basket,
              {
                symbol: entry.symbol, side: entry.side, qty: executed,
                entryPrice: Number.isFinite(after.avgPrice) && after.avgPrice > 0 ? after.avgPrice : (entry.makerRestingPrice ?? 0),
                entryOrderId: entry.makerRestingOrderId,
                entryPriceConfirmed: Number.isFinite(after.avgPrice) && after.avgPrice > 0,
                exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: j,
              } as ExecutorLeg,
              new Error(`maker leg filled ${executed} while the basket was aborting (${releaseReason})`),
            );
          }
        } catch { /* unreadable — the resting order was still cancelled above */ }
        entry.makerRestingOrderId = undefined;
      }
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
    if (basket.status === "ABORTED") {
      // A rollback is intentionally excluded from the strategy's measured cohort. Even if an
      // exchange flatten happened, it was a partial/open-failure recovery rather than the selected
      // complete hedge, so it must not become a simulated or accidental Tier-1 outcome.
      this.markFourBrainBasketUnmeasured(basket, basket.closeReason ?? "BASKET_ROLLBACK_ABORTED");
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
   * On any STOP (kill/drain interrupt or an ordinary entry failure), ALWAYS ROLLBACK: flatten
   * every already-filled leg and mark the basket ABORTED. A reduced two-sided basket is still not
   * the strategy that was selected and can have materially different beta, leg weights, and exit
   * math. It must never be silently retained as a "smaller hedge".
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
    // 2026-08-15: warm the shared quote cache for every leg still to place, ONCE and in PARALLEL,
    // before any order goes out. Warming per-leg instead would put a book fetch (up to ~750ms)
    // between consecutive placements and stretch a 6-leg basket's open window from ~1s to ~4.5s —
    // more time for the market to move between legs, which is a real execution cost paid to obtain
    // a measurement. One parallel fetch costs a single round trip; the reference is then slightly
    // older for later legs, and `ageAtSubmitMs` records exactly how much so a report can filter on
    // it rather than be misled by it. Fail-open throughout: no quote simply means no submitRef.
    const quoteObserveStartMs = Date.parse(this.nowIso());
    if (this.warmPublicQuoteFn) {
      const pending = plan
        .slice(startIndex)
        .filter((p) => p.status !== "FILLED")
        .map((p) => p.symbol);
      await Promise.all(
        [...new Set(pending)].map((symbol) =>
          this.warmPublicQuoteFn!(symbol).catch(() => null),
        ),
      ).catch(() => null);
    }
    // Post every maker leg AT ONCE and serve ONE wait for all of them, before the sequential loop
    // starts resolving them. Without this the timeout multiplies by leg count, and the delay
    // between the first and last leg is drift the basket carries as directional exposure — which is
    // what forced the timeout to stay too short to be useful. Books nothing; the loop below still
    // owns every fill, reservation, fallback and recovery decision exactly as before.
    if (isCrossSectionalMakerEntryEnabled()) {
      await this.preplaceMakerLegs(plan.slice(startIndex), quoteObserveStartMs);
    }
    for (let i = startIndex; i < plan.length; i++) {
      const planned = plan[i]!;
      if (planned.status === "FILLED") continue; // idempotent — already resolved (e.g. by recovery)

      // THE REGIME GATE DECIDES WHETHER TO START A BASKET, NOT WHETHER TO FINISH ONE.
      //
      // It used to be re-read before every leg, so a scan landing mid-open aborted the basket with
      // the rest of the plan untouched: measured, 3 of the first 10 baskets ended
      // KILL_OR_DRAIN_MID_OPEN and two of those had already filled a single leg, which then had to
      // be bought and sold again for nothing. Six legs take seconds; the regime does not
      // meaningfully change inside that window, and once ANY leg is filled, completing the hedge is
      // strictly safer than unwinding half of it — a half-open market-neutral basket IS directional
      // exposure. Admission already applied this same gate before the basket was reserved.
      //
      // Keyed on legs.length rather than on the loop index on purpose: it gives the same answer to
      // a basket resumed by recovery hours later, where index says "start" but real filled legs say
      // "finish what you began".
      //
      // KILL AND DRAIN ARE DELIBERATELY NOT PART OF THIS. They stay checked before every leg,
      // because a safety stop that only runs at basket start is not a safety stop.
      //
      // legs.length ALONE IS NOT ENOUGH once orders are pre-placed. A resting GTX order is real
      // exchange exposure in flight, but nothing is booked into basket.legs until the loop below
      // resolves it — so a basket whose orders were already FILLING still read legs.length === 0.
      // On 2026-08-16 two baskets aborted that way with legs=0 while 4 of 6 symbols had actually
      // filled (WLD 57, UNI 7, DOGE 488, SUI 46.5); only the orphan machinery kept those positions
      // from going untracked, and they had to be flattened at a loss for nothing. The gate must
      // therefore also stand down the moment any order has been sent.
      const anyOrderInFlight = plan.some((p) => p.makerRestingOrderId);
      const regimeStillDecides = basket.legs.length === 0 && !anyOrderInFlight;
      if ((regimeStillDecides && !this.isAllowed()) || basket.pendingKillReason) {
        // Name the actual cause. "KILL_OR_DRAIN_MID_OPEN" was reported for BOTH a real kill and a
        // closed regime gate, which is how two regime-gate aborts read as kill-switch events.
        const reason = basket.pendingKillReason ?? "REGIME_CLOSED_BEFORE_ANY_FILL";
        basket.pendingKillReason = undefined;
        await this.markRemainingNeverAttempted(basket, i, `KILL_OR_DRAIN_BASKET_INTERRUPTED:${reason}`);
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
        // 2026-08-15: submit-time reference quote. Captured HERE — after setLeverage, immediately
        // before the order — so `ageAtSubmitMs` measures what it claims to. Best-effort in every
        // direction: a failed warm, a missing cache entry, or a stale quote all yield no submitRef
        // and the order proceeds untouched. It must never be able to block or delay a placement.
        // A pre-placed leg's quote was captured when the order was actually sent; re-stamping it
        // here would describe a book the order never saw and make ageAtSubmitMs a fiction.
        const submitRef = planned.makerSubmitRef !== undefined
          ? planned.makerSubmitRef
          : stampSubmitRef(
              buildSubmitRefBase(
                this.readPublicQuoteFn ? this.readPublicQuoteFn(planned.symbol) : null,
                quoteObserveStartMs,
                planned.side,
              ),
              Date.parse(this.nowIso()),
            );
        // Maker-first when enabled, otherwise the unchanged MARKET path. submitRef already holds
        // the submit-time book, so the post-only price comes from the SAME quote the execution
        // record is audited against rather than a second, later read.
        const order = isCrossSectionalMakerEntryEnabled()
          ? await this.placeEntryLegMakerFirst(
              planned,
              planned.side === "LONG" ? "BUY" : "SELL",
              submitRef?.bid ?? null,
              submitRef?.ask ?? null,
            )
          : await this.client.placeOrder({
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
          ...(submitRef ? { submitRef } : {}),
          ...(planned.makerOutcome
            ? { entryLiquidity: { makerQty: planned.makerOutcome.makerQty, takerQty: planned.makerOutcome.takerQty, reason: planned.makerOutcome.reason } }
            : {}),
          exitPrice: null,
          exitOrderId: null,
          exitPriceConfirmed: null,
          planIndex: i,
          signalWeight: planned.signalWeight ?? null,
          scoreAtOpen: planned.scoreAtOpen ?? null,
          volatilityAtOpen: planned.volatilityAtOpen ?? null,
          targetNotionalUsd: planned.targetNotionalUsd ?? null,
        });
        this.bindFourBrainActualFill(basket, basket.legs[basket.legs.length - 1]!);
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
          const resolution = planned.takerFallbackClientOrderId
            ? await this.reconcilePlannedLeg(planned.symbol, planned.takerFallbackClientOrderId)
            : await this.reconcilePlannedLeg(planned.symbol, planned.entryClientOrderId);

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
              signalWeight: planned.signalWeight ?? null,
              scoreAtOpen: planned.scoreAtOpen ?? null,
              volatilityAtOpen: planned.volatilityAtOpen ?? null,
              targetNotionalUsd: planned.targetNotionalUsd ?? null,
            });
            this.bindFourBrainActualFill(basket, basket.legs[basket.legs.length - 1]!);
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
        await this.markRemainingNeverAttempted(basket, i + 1, "NEVER_ATTEMPTED_BASKET_ABORTED");
        this.store.save();

        // A failed leg invalidates the selected basket even if the already-filled subset happens
        // to span both sides. Keep no reduced hedge: flatten every fill and record ABORTED.
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
          const resolution = ambiguous.takerFallbackClientOrderId
            ? await this.reconcilePlannedLeg(ambiguous.symbol, ambiguous.takerFallbackClientOrderId)
            : await this.reconcilePlannedLeg(ambiguous.symbol, ambiguous.entryClientOrderId);
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
              signalWeight: ambiguous.signalWeight ?? null,
              scoreAtOpen: ambiguous.scoreAtOpen ?? null,
              volatilityAtOpen: ambiguous.volatilityAtOpen ?? null,
              targetNotionalUsd: ambiguous.targetNotionalUsd ?? null,
            });
            this.bindFourBrainActualFill(basket, basket.legs[basket.legs.length - 1]!);
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
   *
   * 2026-08-05 (adversarial-review fix, live-tick reconciliation task): executedQty>0 is checked
   * FIRST, independent of the order's overall terminal status string. Binance Futures MARKET
   * orders (the ONLY type this executor ever places — see placeRemainingLegsLocked) that can only
   * partially match available book depth commonly terminate the UNFILLED remainder with status
   * EXPIRED (sometimes CANCELED), not FILLED/PARTIALLY_FILLED — while still reporting the genuinely
   * executed portion via a nonzero executedQty. The PREVIOUS status-string-first ordering matched
   * "EXPIRED"/"CANCELED"/"REJECTED" before ever looking at executedQty and returned NOT_PLACED for
   * that real, nonzero fill — a false negative that (a) released the reservation for capacity
   * genuinely in use and (b) discarded the fill entirely (never adopted into basket.legs, never
   * tracked as an orphan either, since orphan-tracking only ever begins from a leg already present
   * in basket.legs) — exactly the "genuinely naked, untracked position" failure mode this task's own
   * live-tick fix exists to close, reached via a different trigger. This is the SAME
   * "executedQty alone, no status gate" rule placeRemainingLegsLocked's own direct (non-error)
   * placeOrder-response handling already uses (see its filledQty derivation, BUG 3) — this fix
   * brings the RECONCILIATION classification into alignment with that already-established
   * convention rather than inventing a new one. Any status string, terminal or not, with
   * executedQty>0 is unconditionally a real fill; NOT_PLACED is now reached only for a genuinely
   * empty (executedQty<=0) terminal-no-fill status. Purely additive/widening — every case the OLD
   * condition already classified FILLED is still FILLED (a strict subset), so this cannot change
   * the outcome for any status/executedQty combination the existing test suite already covered
   * (confirmed: no existing test paired a terminal-no-fill status with a nonzero executedQty).
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
      if (executedQty > 0) {
        return { outcome: "FILLED", qty: executedQty, avgPrice: order.avgPrice, orderId: order.orderId };
      }
      if (status === "CANCELED" || status === "CANCELLED" || status === "EXPIRED" || status === "REJECTED" || status === "FILLED") {
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

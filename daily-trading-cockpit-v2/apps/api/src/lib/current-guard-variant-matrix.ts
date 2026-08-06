/**
 * CURRENT-GUARD VARIANT MATRIX (REPORT-ONLY FORWARD A/B HARNESS)
 *
 * Isolated, simulation-only tape that takes the SAME qualifying signal
 * population the F****** post-cutover current-guard lane operates on, then
 * applies 6 fixed stop/TP geometry variants to each signal and resolves each
 * variant prospectively by walking real candles. The point is a clean,
 * apples-to-apples A/B: every variant sees the same signals, every variant is
 * resolved by the same candle-walk engine and the same conventions, so any
 * difference in economics is attributable to geometry — not measurement.
 *
 * HARD CONTRACT (do not weaken):
 *  - report-only. This module never touches normal shadow positions, route
 *    selection, scoring, readiness, admission, or any live behavior.
 *  - never throws to callers; all I/O is wrapped and best-effort.
 *  - its own isolated JSON store (data/current-guard-variant-matrix.json); it
 *    NEVER reads or writes data/shadow-positions.json.
 *  - resolution is conservative and never optimistic. Same-candle SL+TP
 *    ambiguity is refined with 1m candles where available; if it cannot be
 *    refined it resolves SL-first (a loss). We never assume a higher target
 *    "would have" been reached.
 *  - liveBlocked stays true and microPilotAllowed stays false regardless of
 *    what any variant shows here. Promotion remains report-only until explicit
 *    manual approval.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { rotateJsonlIfNeeded } from "./jsonl-rotation.js";

import { type ShadowPosition, type Candle } from "@dtc/shared";
import { computeATR } from "./candle-indicators.js";
// Reused unmodified for the "production_breakeven_control" exitRule's quantity-rounding
// diagnostic (see that branch in walkVariantPath) — the SAME floor-to-stepSize helper
// binance-futures-private.ts's placeOrder()/placeAlgoOrder() apply to every real order, per
// investigation into live-execution-engine.ts's maybeCloseLiveBreakevenLaneAfterCost(). This file
// otherwise has zero dependency on the live Binance client transport; importing one small pure
// rounding function does not pull in any exchange/network/order-placement code (roundToStep has
// no side effects and no other imports).
import { roundToStep } from "./binance-futures-private.js";
// Cross-caller mutual exclusion for this store's own mutating resolver pass (see Surface A of
// the 2026-08 concurrency remediation) — beginBatch/endBatch below is flush-coalescing only and
// provides no such guarantee on its own.
import { runExclusiveForStore } from "./store-mutation-single-flight.js";

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf-8");
  renameSync(tmp, file);
}

import {
  BASE_ROUTE_POLICY_VERSION_V2,
  MIN_ADMISSION_STOP_DISTANCE_BPS_EXPORT,
  REALISTIC_FEE_BPS_PER_SIDE,
  REALISTIC_ROUND_TRIP_FEE_SLIP_BPS,
} from "./shadow-engine.js";
import { isStrongTrendRegime } from "./regime-direction-controller.js";

export const CURRENT_GUARD_VARIANT_MATRIX_LANE = "CURRENT_GUARD_VARIANT_MATRIX_V1" as const;
export const CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION = "current-guard-variant-matrix-v1" as const;

type Direction = "LONG" | "SHORT";

export type VariantMatrixVariantId =
  | "CG_BASELINE_CURRENT"
  | "CG_WIDE_STOP_TP_WIDE"
  | "CG_WIDE_LONG_RUNNER"
  | "CG_WIDE_FAST_SHORT"
  | "CG_TRAIL_AFTER_TP1"
  | "CG_SCALEOUT_TP1_TRAIL"
  | "CG_NO_FIB500_ENTRYSET"
  | "CG_MAKER_LIMIT_SIM"
  | "BL_TREND_R15_STOP200_FULL"
  | "BL_TREND_SCALEOUT_STOP200"
  // Long-only reward-geometry research lanes (GPT deep-research candidates): wide stop floor
  // + 1.2R TP, attacking the "too little realised reward vs cost" long failure mode.
  | "LG_R12_STOP250_FULL"
  | "LG_R12_STOP300_FULL"
  // Fast-exit / tight-stop research lanes (2026-06-20 audit hypotheses): the forward
  // diagnostic + VM data showed wide-stop slow-TP full exits bleed (PF ~0.3-0.4) while
  // the one fast 0.5R variant (CG_WIDE_FAST_SHORT) was the best (+0.20R). These test
  // "fast/tight beats wide/slow" from three angles, to be PROVEN out-of-sample before
  // any promotion (not tuned to the small post-reset sample).
  | "CG_WIDE_FAST_LONG"
  | "CG_TIGHT_FAST_05"
  | "CG_BE_AFTER_05"
  // MFE-giveback exit (operator-requested): baseline geometry, but lock in a faded winner by
  // exiting on a retrace from peak favorable. Direct A/B vs the tp1_full baseline on identical
  // signals; direction-agnostic (the leak hits both books).
  | "CG_MFE_GIVEBACK"
  // "Sentil" lanes (2026-06-23): the OOS-thirds audit showed baseline/maker just barely miss
  // all-three-positive (one tiny-negative middle third in the OOS2 whipsaw) while the fast 0.5R
  // lanes pass. These take the EXACT baseline/maker entry+stop and change ONLY the TP to a fast
  // 0.5R (stopFloorBps:1 is a non-binding sentinel) — isolating TP placement as the single
  // variable, to test whether banking before the bounce flips them all-OOS-positive.
  | "CG_BASELINE_FAST_05"
  | "CG_MAKER_FAST_05"
  // Experimental high-risk paper lanes (operator-requested): clone proven fast/short
  // geometries with smaller TP and 10x paper risk sizing. Paper-only diagnostics.
  | "CG_EXP_LONG_WIDE_FAST_10X"
  | "CG_EXP_LONG_TIGHT_FAST_10X"
  | "CG_EXP_LONG_MFE_GIVEBACK_10X"
  | "CG_EXP_SHORT_MFE_GIVEBACK_10X"
  | "CG_EXP_SHORT_WIDE_FAST_10X";

export const BULL_TREND_VARIANT_ID = "BL_TREND_R15_STOP200_FULL" as const;
export const BULL_SCALEOUT_VARIANT_ID = "BL_TREND_SCALEOUT_STOP200" as const;

export type VariantExitRule =
  | "tp1_full"
  | "trail_after_tp1"
  | "scaleout_tp1_trail"
  | "mfe_giveback"
  | "atr_trail"
  | "production_breakeven_control";
export type VariantFillMode = "taker" | "maker_limit";

export type VariantObservationStatus =
  | "OPEN"
  | "CLOSED_WIN"
  | "CLOSED_LOSS"
  | "NO_FILL"
  | "EXPIRED"
  | "DATA_FAILURE"
  | "REJECTED";

export type VariantIntrabarStatus =
  | "VALID_5M_ORDERED"
  | "AMBIGUOUS_SAME_CANDLE_SL_FIRST"
  | "RESOLVED_BY_1M"
  | "INTRABAR_UNAVAILABLE"
  | null;

export type VariantMatrixStatus =
  | "COLLECTING"
  | "WATCHABLE"
  | "STABLE_CANDIDATE"
  | "PROMOTION_CANDIDATE"
  | "REJECT";

/**
 * The canonical proof cohort. Direction and market context are intentionally a
 * single key: a lane can be valid for LONG_BULLISH without claiming anything
 * about the same geometry during a mixed or bearish market.
 */
export type ExactLaneContext =
  | "LONG_BULLISH"
  | "SHORT_BEARISH"
  | "LONG_MIXED"
  | "SHORT_MIXED";

export type ContextLaneStatus = VariantMatrixStatus | "NOT_APPLICABLE";

const ALL_EXACT_LANE_CONTEXTS: readonly ExactLaneContext[] = [
  "LONG_BULLISH",
  "SHORT_BEARISH",
  "LONG_MIXED",
  "SHORT_MIXED",
];
const LONG_EXACT_LANE_CONTEXTS: readonly ExactLaneContext[] = ["LONG_BULLISH", "LONG_MIXED"];
const SHORT_EXACT_LANE_CONTEXTS: readonly ExactLaneContext[] = ["SHORT_BEARISH", "SHORT_MIXED"];

// --- Cost model (per-variant, honest: cost in R = roundTripBps / stopDistanceBps) ---
// Wider stops therefore carry a smaller cost-in-R, which is the single most
// important geometry fact the edge audit surfaced.
export const TAKER_ROUNDTRIP_BPS = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS; // 22 (fee+slippage, both sides)
/**
 * Both-sides-maker round trip: Binance USD-M maker is 2 bps/side, so 4. No spread cross on either
 * leg, which is the whole point of posting a resting limit.
 *
 * 2026-07-27: was `REALISTIC_FEE_BPS_PER_SIDE + 1` = 6. That expression derived the MAKER cost from
 * the TAKER per-side rate and added an arbitrary 1 — it was never 2×2 plus a buffer, it just landed
 * near a plausible number. The taker side of that formula is now measured exactly (5.0000 bps/side,
 * reconciled against /fapi/v1/income at 3.5e-8), which is precisely why it should not be the basis
 * for the maker figure.
 *
 * WHAT THIS DOES NOT COVER, stated rather than buried: a maker_limit variant posts its ENTRY as a
 * limit, but its EXIT is only maker when a TP limit fills. A stop-out exits at market and pays the
 * 5 bps taker rate, so that round trip is really 2 + 5 = 7. One constant cannot be right for both
 * paths. `_computePaperExitCostR` already branches on TP_LIKE vs STOP_LIKE and adds
 * STOP_OUT_SLIPPAGE_BPS on the stop path, but it does NOT add the maker→taker fee difference
 * (3 bps) there.
 *
 * So this change removes a ~2 bps OVERCHARGE on every maker close and leaves a smaller ~3 bps
 * UNDERCHARGE on the maker closes that stop out. Net direction depends on a lane's stop rate; on
 * CG_MAKER_LIMIT_SIM the overcharge dominated. Fixing the stop leg properly is a cost-model change,
 * deliberately not bundled into a constant correction.
 */
export const MAKER_ROUNDTRIP_BPS = 4;
export const STRESS_EXTRA_BPS = 10; // +10bps slippage stress test
// Fresh-feed measurement: an observation is "fresh-valid" only if its entry was placed within this
// window of now — i.e. a price you could ACTUALLY have taken live. The old engine hardcoded this
// `true` on every (median-6h-stale) obs, which was misleading; now it means what it says.
export const FRESH_ENTRY_MAX_MINUTES = 10;
// Perp funding (paid ~every 8h on notional). The old cost model ignored it, overstating the net of
// multi-hour/day holds (the wide lanes hold 24h–144h). ~1.5bp/8h is a conservative typical-alt rate.
export const FUNDING_BPS_PER_8H = 1.5;
// Stop-out exits slip MORE than TP/limit exits: a stop-market order fills during a
// fast ADVERSE move (volatility / liquidation cascade), so a CLOSED_LOSS pays extra
// slippage beyond the flat round-trip. The old flat cost model missed this asymmetry,
// which made low-win-rate lanes look as cheap as high-WR ones. Modeling it honestly
// (extra cost ONLY on losers) lets the gate self-select cost-robust lanes — the
// slippage stress test showed the fast-0.5R lanes survive realistic costs while the
// SCALEOUT/baseline/aggregate "edge" is phantom. Env-tunable; applied at resolution.
export const STOP_OUT_SLIPPAGE_BPS = Number(process.env.STOP_OUT_SLIPPAGE_BPS) || 12;

// --- MFE-giveback exit (operator-requested 2026-06-22) ---
// The audit + operator both flagged the same leak: trades reach a good MFE (touched
// a high) but the exit isn't captured, then fade back to flat/negative. The mfe_giveback
// exit rule locks that in: once the trade is up >= MFE_GIVEBACK_ARM_R (in R), it trails a
// "giveback" exit at peak*(1-MFE_GIVEBACK_FRAC) of the favorable move — so a faded winner
// banks a partial gain instead of round-tripping to a stop. The hard stop and the far TP
// still bound the trade (a straight-to-TP winner takes full reward; a never-favorable trade
// stops at -1). The peak used to arm/level EXCLUDES the current candle, so there is no
// intrabar lookahead (a candle that spikes up then retraces cannot trigger off its own spike).
// Env-tunable so the arm/giveback can be swept without a rebuild.
export const MFE_GIVEBACK_ARM_R = Number(process.env.MFE_GIVEBACK_ARM_R) || 0.75;
export const MFE_GIVEBACK_FRAC = Number(process.env.MFE_GIVEBACK_FRAC) || 0.5;
export const EXPERIMENTAL_TP_NET_BUFFER_R = Number(process.env.EXPERIMENTAL_TP_NET_BUFFER_R) || 0.02;

// --- ATR/structure trailing-stop exit (Tier 2 item 5, OFFLINE ANALYSIS ONLY) ---
// Ports the proven ATR-ratchet mechanic already live in outcome-checker.ts's "trail_after_tp1"
// RUNNER state (`currentStop = Math.max(currentStop, candle.close - atr)` for LONG, symmetric
// `Math.min` for SHORT) into walkVariantPath as its own standalone exit rule. Unlike
// trail_after_tp1 (a ONE-TIME jump of the stop to breakeven on a TP1 touch), atr_trail
// continuously ratchets the stop toward price using a fresh N-period Wilder ATR recomputed from
// the SAME candle window being walked (computeATR, from candle-indicators.ts — reused, not
// duplicated). It only starts ratcheting once the running favorable excursion (peak BEFORE the
// current candle, same no-lookahead convention as mfe_giveback's arm) has passed ATR_TRAIL_ARM_R;
// once armed it stays armed (maxMfeR is monotonic). The ratchet itself is Math.max/Math.min so the
// stop NEVER loosens. Report-only/offline: no VARIANT_MATRIX_DEFINITIONS entry references this
// exitRule, so it is never mirrored against live signals, never selected by
// effectiveExitRuleForOrder/variantDefinitionForOrder in paper-execution-router.ts, and never
// touched by live-execution-engine.ts. It exists purely so scripts/backfill-cg-wide-fast-long-mfe.ts
// (and any future offline A/B) can compare it against the existing 4 exit rules on identical entries.
export const ATR_TRAIL_PERIOD = Number(process.env.ATR_TRAIL_PERIOD) || 14;
export const ATR_TRAIL_MULTIPLE = Number(process.env.ATR_TRAIL_MULTIPLE) || 2;
export const ATR_TRAIL_ARM_R = Number(process.env.ATR_TRAIL_ARM_R) || 0.5;

// --- Production breakeven-after-cost CONTROL exit (Task 1, 2026-07-10, OFFLINE ANALYSIS ONLY) ---
// Models live-execution-engine.ts's maybeCloseLiveBreakevenLaneAfterCost() (the REAL production
// mechanism, gated on LIVE_BREAKEVEN_EXIT_LANE_IDS = CG_WIDE_LONG_RUNNER / CG_WIDE_FAST_LONG) as
// its own standalone exitRule, added purely to serve as a VALIDATED CONTROL for the other 6
// exit-ablation variants (operator-approved research brief). Same additive pattern as atr_trail
// above: new union member + new branch only, VARIANT_MATRIX_DEFINITIONS untouched, so this is
// never mirrored against live signals and never touched by live-execution-engine.ts.
//
// WHAT THIS FAITHFULLY MODELS (see the exitRule==="production_breakeven_control" branch in
// walkVariantPath for the exact derivation):
//  - Activation trigger: fires the instant the position's OWN unrealized P&L (mark vs its own
//    entry) would exceed the flat round-trip cost estimate applied to current notional — i.e.
//    netAfterCost = ownUnrealizedUsd − notionalUsd*costPct >= 0 (live-execution-engine.ts:2449-
//    2451). Solved in closed form for the exact MARK PRICE at which this first becomes true
//    (see PRODUCTION_BREAKEVEN_CONTROL_COST_PCT doc below) rather than approximated.
//  - Entry+exit fee AND slippage: production does not itemize these — one blended constant,
//    estimatedCloseCostPct, sourced from env var LIVE_ESTIMATED_CLOSE_COST_PCT (default 0.0022 =
//    22bps), applied once against current notional. This control reads that SAME env var name by
//    default (see PRODUCTION_BREAKEVEN_CONTROL_COST_PCT below) rather than an independent default,
//    specifically so tuning the real production constant on any deployed instance keeps this
//    control in sync automatically instead of silently diverging (2026-07-10 fidelity-review fix —
//    an earlier version declared an unlinked constant that matched only by coincidence of
//    defaults). PRODUCTION_BREAKEVEN_CONTROL_COST_PCT itself remains available as an explicit
//    override for deliberately testing a different cost assumption in the ablation only.
//  - No arm/latch state: re-evaluated fresh; modeled as "first candle whose high/low range
//    crosses the trigger price" (see approximation note below for why this is the closest
//    discrete analog available).
//  - Close mechanics: full-size reduce-only MARKET close (no partial-TP runner state — matches
//    both real gated lanes, which use tp1_full/full-size TP1, per investigation).
//  - Quantity step-size rounding: reuses roundToStep() UNMODIFIED from binance-futures-private.ts
//    (imported above) — the exact function placeOrder() applies to every real close order.
//
// WHERE THE CANDLE-WALK PARADIGM NECESSARILY APPROXIMATES (cannot be replicated offline):
//  1. Tick cadence vs. candle granularity: production evaluates every engine tick (sub-second to
//     low-single-digit-second cadence against live mark price); this walk only knows OHLC per 5m
//     candle. A trigger price touched and reverted WITHIN one candle is indistinguishable here
//     from one touched and held — same intrabar-timing limitation the rest of this file already
//     documents (VariantWalkResult.peakAtMs, intrabarResolutionStatus).
//  2. Realized-fee reconciliation: production uses the ESTIMATE (estimatedCloseCostPct) only to
//     decide WHETHER to fire, then separately books the REAL commission from getUserTrades() into
//     realizedPnlUsd afterward. This offline walk has no real trade ledger to reconcile against —
//     grossR at the modeled trigger price IS the model's only "reality"; there is no analog of a
//     second, more-accurate correction pass. (The backfill script's reconciliation report, Task 2,
//     compares this model's grossR against the REAL realizedPnlUsd/fees for exactly this reason.)
//  3. Order-placement retry/failure/timeout: production's close is a single unretried POST; on
//     failure the exception propagates and the position remains open for re-evaluation next tick
//     (live-execution-engine.ts:2415-2418, ERROR_STREAK_DISARM=3). This walk has no notion of a
//     failed order at all — it assumes the close always succeeds instantly the trigger is touched.
//     There is no offline analog of "the close attempt failed, try again next tick" against
//     historical candles; we simply do not model order-placement failure.
//  4. Tick-ordering vs. sibling exit mechanisms (2026-07-10 fidelity-review correction — the
//     original version of this note was wrong on both points below):
//     - maybeCloseOnTestnetUsdTakeProfit() runs in the SAME tick, immediately BEFORE this
//       mechanism (live-execution-engine.ts manageLifecycle: testnet-USD-TP, then breakeven-after-
//       cost). Despite its name it is NOT testnet-only — profitBankThresholdUsd() returns
//       config.profitBankNetTargetUsd (a flat net-of-cost $ target, live default $1) on ANY
//       environment when that config is set >0, and is not restricted to the two gated lanes. It
//       uses the identical netAfterCost formula as this mechanism, just compared against a
//       positive $ threshold instead of >=0. Because 0 < that threshold, a position's netAfterCost
//       crosses this mechanism's trigger (>=0) before it can ever reach the profit-bank's higher
//       bar, so in practice the breakeven-after-cost sweep should win the race first for these two
//       lanes today — but that is a NUMERIC-ORDERING fact dependent on the current threshold
//       values, not a code-level guarantee, and is not modeled as a competing mechanism here.
//     - manageMfeGiveback() is NOT excluded from these two lanes by their tp1_full exitRule, as an
//       earlier version of this note incorrectly claimed. Its real gate (manageLifecycle, ~line
//       2333-2337) is `config.forceMfeGiveback && lane isn't a profit-core-short lane`, OR'd with
//       an exitRule==="mfe_giveback" check — forceMfeGiveback is documented (line ~152) as applying
//       "to EVERY directional intent regardless of its lane's own exit rule," and is enabled in
//       production. The real reason it doesn't preempt this mechanism today is again numeric
//       ordering, not structural exclusion: MFE-giveback only arms after +0.75R
//       (MFE_GIVEBACK_ARM_R), a far larger favorable move than this mechanism's ~0.05-0.1R-scale
//       trigger for these wide-stop lanes, and this mechanism runs first in the same tick anyway.
//     Net effect: this walk is evaluated in ISOLATION, exactly like all 6 other ablation exit
//     rules — it does not simulate either sibling mechanism competing for the same tick. This is
//     an approximately-safe simplification under TODAY's constants (both siblings' thresholds sit
//     well above this mechanism's near-zero trigger), not a guarantee that survives future tuning
//     of PRODUCTION_BREAKEVEN_CONTROL_COST_PCT, profitBankNetTargetUsd, or MFE_GIVEBACK_ARM_R.
//  5. cancelAllOrders/cancelAllAlgoOrders symbol-scoped side effects on OTHER executors sharing
//     the same symbol (investigation item 7) — has no analog in a single-position candle walk;
//     not modeled, out of scope for a per-trade exit-ablation.
//  6. Quantity-rounding's effect on the OUTCOME: per investigation item 8, production's own
//     quantity floor-rounding never changes the fired decision or the close price (a MARKET order
//     has no price to round) — it only ever shaves an economically negligible dust remainder off
//     the closed quantity. This control therefore surfaces the rounded quantity as a DIAGNOSTIC
//     field only (VariantWalkResult.productionBreakevenModeledCloseQty); it deliberately does NOT
//     feed grossR, matching production's own economics exactly (rounding is real but immaterial
//     to R).
//  7. Pyramiding: production blends ALL adds into one quantity-weighted-average entry/qty
//     (addToIntent, live-execution-engine.ts:4242-4337) BEFORE this mechanism ever evaluates —
//     i.e. by the time this check runs, pyramiding has already been fully absorbed into a single
//     blended (entryPrice, qty) pair. walkVariantPath itself only ever replays ONE entry price; the
//     existing walkPyramidOnConfirmedWinner sibling function (below) already models "a second
//     entry added mid-trade" for exactly this reason — Task 3's pyramiding test exercises THAT
//     function with exitRule: "production_breakeven_control" rather than duplicating pyramid logic
//     inside walkVariantPath a second time.
export const PRODUCTION_BREAKEVEN_CONTROL_COST_PCT =
  Number(process.env.PRODUCTION_BREAKEVEN_CONTROL_COST_PCT) ||
  Number(process.env.LIVE_ESTIMATED_CLOSE_COST_PCT) ||
  0.0022;

// --- Pyramid-only-on-confirmed-winner (Tier 2 item 5, OFFLINE ANALYSIS ONLY) ---
// Mirrors the SPIRIT of live-execution-engine.ts's real pyramid cap (shouldCapPyramidAdd /
// PYRAMID_FREE_ADD_LIMIT / PYRAMID_MIN_FAVORABLE_R = 0.15 — "no further adds without real
// favorable progress", backed by real 2026-07-08 loss evidence) for walkPyramidOnConfirmedWinner's
// FIRST add decision. It is a deliberately separate, independently-tunable constant (not an
// import of the live constant): that gate governs whether a Nth live add is BLOCKED after
// PYRAMID_FREE_ADD_LIMIT adds have already happened; this one governs whether this offline
// simulator's single hypothetical second entry is added AT ALL. Same order of magnitude, same
// "prove real progress first" intent, zero coupling to the tuned live constant.
export const PYRAMID_CONFIRMED_ADD_FAVORABLE_R = Number(process.env.PYRAMID_CONFIRMED_ADD_FAVORABLE_R) || 0.15;
export const PYRAMID_CONFIRMED_ADD_SIZE_MULTIPLE = Number(process.env.PYRAMID_CONFIRMED_ADD_SIZE_MULTIPLE) || 1;

// --- Geometry constants ---
export const WIDE_STOP_MIN_BPS = 300; // Paper-admissible wide/trail variants require >= 300bps stops
/**
 * `stopFloorBps` values at or below this are NON-BINDING SENTINELS, not real floors.
 *
 * Exactly two lanes use it: the "Sentil" lanes CG_BASELINE_FAST_05 and CG_MAKER_FAST_05 set
 * `stopFloorBps: 1` purely to route themselves through deriveVariantGeometry's wide-geometry
 * branch (which keys off `stopFloorBps != null`) so the paired TP is re-placed at
 * `tpRewardMultiple` × risk. Since raw stops are always > 1bps, `Math.max(rawStop, 1)` is a
 * deliberate no-op — the entry AND stop stay identical to their parent lanes. It is a GEOMETRY
 * instruction, never a claim that a 1bps stop is admissible.
 *
 * NOT env-tunable on purpose: this is a classification of the definitions in this file, not a
 * market judgment. Raising it would silently reclassify the genuinely binding floors — 175
 * (CG_TIGHT_FAST_05, CG_EXP_LONG_TIGHT_FAST_10X), 200 (BULL_TREND_VARIANT_ID,
 * BULL_SCALEOUT_VARIANT_ID), 250 (LG_R12_STOP250_FULL) — as sentinels and change those lanes'
 * admission behaviour too. Test [5c] in paper-opportunity-allocator.test.ts pins every one of them.
 */
export const NON_BINDING_STOP_FLOOR_MAX_BPS = 1;
/**
 * The ADMISSION floor for a variant — deliberately distinct from the stop-WIDENING floor inside
 * deriveVariantGeometry's `usesWidePaperGeometry` branch. A non-binding sentinel widens nothing
 * there (that stays true and is asserted by test [5c], see
 * NON_BINDING_STOP_FLOOR_MAX_BPS) but must still be admitted at the standard wide floor, exactly
 * like the parent lane it is supposed to A/B against: CG_BASELINE_CURRENT / CG_MAKER_LIMIT_SIM
 * carry no `stopFloorBps` at all and therefore admit at WIDE_STOP_MIN_BPS.
 *
 * Before this existed the allocator passed `def.stopFloorBps ?? WIDE_STOP_MIN_BPS` straight into
 * the admission gate, so the sentinel 1 became the floor and the two Sentil lanes admitted
 * geometry their own parents reject — breaking the "only the TP changed" isolation at the gate
 * rather than at the geometry.
 */
export function admissionStopFloorBpsForVariant(def: VariantMatrixVariantDefinition): number {
  const floor = def.stopFloorBps;
  return floor == null || floor <= NON_BINDING_STOP_FLOOR_MAX_BPS ? WIDE_STOP_MIN_BPS : floor;
}
export const MAKER_FILL_WINDOW_CANDLES = 12; // 1h on 5m candles to get a maker fill
const CANDLE_MS = 5 * 60 * 1000;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Max EXPIRED observations retained for the diagnostic count display; older ones are pruned from
 *  the store each resolve pass (they feed no stat). Bounds memory after the born-stale gate. */
const VM_MAX_EXPIRED_OBS = Number(process.env.VM_MAX_EXPIRED_OBS) || 500;
/** Cap PER TERMINAL STATUS (CLOSED_WIN/CLOSED_LOSS/REJECTED/NO_FILL/DATA_FAILURE, each
 *  independently) — bounds unbounded long-run growth while staying well above any promotion-gate
 *  sample-size need (PROMOTION_MIN_FRESH=200 below, shared across ~20-25 variants ⇒ ~200-250/variant
 *  average at this cap — right at the real floor with headroom). Unlike EXPIRED, these statuses feed
 *  real edge/PBO/backtest measurement (2026-07-07 audit: 22 files read them), so dropped records are
 *  archived to an append-only JSONL file next to the store — never discarded — for any offline
 *  analysis that wants deeper history than the live in-memory cap retains. First found via a
 *  cross-instance OOM audit: main's UNCAPPED store had reached 197MB/153k observations (81k
 *  CLOSED_WIN + 42k CLOSED_LOSS alone) and was crashing ~19x more often than testnet/live's 27MB
 *  stores — that pass added a 15000/status cap. 2026-07-08: OOM was STILL recurring roughly daily
 *  on every instance after that fix — the store simply refills to the cap (confirmed: 3101 sitting
 *  at exactly 15030/15000/15000 CLOSED_WIN/CLOSED_LOSS/REJECTED, 52,947 total, 70MB on disk) and a
 *  60k-observation array held permanently in memory + re-iterated by every measurement-report
 *  builder on every dashboard poll is enough on its own to tip a 1024MB heap. Second-pass cut to
 *  5000 (60k→20k terminal ceiling) — DATA_FAILURE was ALSO missing from this list entirely (the one
 *  status with literally no bound, though empty in practice so far; added defensively). */
const VM_MAX_TERMINAL_OBS_PER_STATUS = Number(process.env.VM_MAX_TERMINAL_OBS_PER_STATUS) || 5000;
const VM_PRUNABLE_TERMINAL_STATUSES: VariantObservationStatus[] = [
  "CLOSED_WIN",
  "CLOSED_LOSS",
  "REJECTED",
  "NO_FILL",
  "DATA_FAILURE",
];
/** Open observations older than this threshold are surfaced as "stale" in diagnostics. */
const STALE_OPEN_WARN_MS = 72 * 60 * 60 * 1000; // 72 h
const DEFAULT_MAX_HOLD_MS = STALE_OPEN_WARN_MS;
const MFE_MAE_CAP_R = 20;

// --- Anti-overfit gate thresholds (Part 5) ---
// WATCHABLE = COLLECTING→WATCHABLE gate: how many honest closes a lane needs
// before it leaves SHADOW_ONLY and can trade HEADLINE/live. Env-tunable
// (WATCHABLE_MIN_FRESH) so collection speed can be dialed without a rebuild —
// lower = faster to real trades but thinner evidence. Was 50, then 20; default 20
// here, the running system/VPS sets it lower in .env for the fresh-start collection
// sprint. STABLE/PROMOTION stay high so FULL promotion still needs depth, and the
// edge gate keeps its own EDGE_MIN_SAMPLES=30 before it will veto/allow a slice.
export const WATCHABLE_MIN_FRESH = Number(process.env.WATCHABLE_MIN_FRESH) || 20;
/**
 * RAW-ROW floors. `deriveVariantStatus` NO LONGER READS EITHER OF THESE — STABLE/PROMOTION are
 * gated on the stage proof windows (see the Point 4 block below), whose independence floors are
 * `STABLE_MIN_EFFECTIVE_N` / `PROMOTION_MIN_EFFECTIVE_N` and are on a ~1000x different scale.
 *
 * They stay exported at their existing values ONLY for the callers that apply them to raw row
 * counts, which is what they have always meant: `adaptive-lane-router.ts` (classifyLaneMaturity /
 * nextRequiredEvidence), `neural-map-telemetry.ts`, `paper-opportunity-allocator.ts`, and the
 * hardcoded duplicate in `apps/web/src/NeuralMindmap.tsx`.
 *
 * DO NOT re-wire either of these onto `effectiveN`. Doing so is the exact bug the stage thresholds
 * were introduced to remove: at the 0.333 independent-episodes/day ceiling for a 72 h max-hold,
 * `effectiveN >= 100` means 300 calendar days and `>= 200` means 600.
 */
export const STABLE_MIN_FRESH = 100;
/** See STABLE_MIN_FRESH. Raw rows only; never an effectiveN floor. */
export const PROMOTION_MIN_FRESH = 200;
export const NET_STRONG_R = 0.05;
export const PF_STRONG = 1.2;
export const PF_FLOOR = 1.0;
// Payoff floor for WATCHABLE/STABLE/PROMOTION. 2026-06-23: lowered 0.5 → 0.3 after auditing
// "why nothing promotes". The fast 0.5R exit lanes — the bot's actual money-makers (CG_WIDE_FAST_SHORT
// net +0.18R/PF 2.0, CG_TIGHT_FAST_05 net +0.16R/PF 1.8, all OOS thirds positive, +10bps positive) —
// run payoff ~0.38-0.41 in reality (win ~0.5R, lose ~1R, but win ~80%), NOT the ~0.53 the prior comment
// guessed. So a 0.5 floor benched the BEST edges at the FIRST rung (WATCHABLE) → nothing could ever
// climb the ladder. The other gates (net>NET_STRONG_R, PF>PF_STRONG, all-three-OOS-thirds positive,
// +10bps, drawdown, top-symbol share) already prove the edge is real and not high-WR luck, so the
// payoff SHAPE must not veto a proven high-WR edge. 0.3 still rejects truly degenerate shapes (with
// PF>1.2 that implies WR>~77%). Only affects lane STATUS; headline/live stays gated by liveBlocked +
// infra readiness. Env-tunable.
export const PAYOFF_WATCH = Number(process.env.PAYOFF_WATCH_FLOOR) || 0.3;
export const PAYOFF_STABLE = 0.75;
export const PAYOFF_AUTHORIZE = Number(process.env.PAYOFF_AUTHORIZE_FLOOR) || PAYOFF_WATCH;
export const MAX_DRAWDOWN_R_LIMIT = 5;
// The drawdown cap SCALES with a lane's proven profitability: a lane that has banked a large
// cumulative R can tolerate a proportionally larger peak-to-trough R drawdown. approxMaxDrawdownR is
// a monotonic all-time max, so an absolute 5R cap permanently benched the bot's best high-WR/
// low-payoff lanes (bank 0.5R, lose 1R ⇒ naturally bigger R-holes) after a single normal retrace.
// effective cap = max(MAX_DRAWDOWN_R_LIMIT, DRAWDOWN_R_TO_CUM_SHARE × cumulativeNetR) — the absolute
// floor still binds for small/unproven/losing samples; the scale only ever RELAXES for proven lanes.
export const DRAWDOWN_R_TO_CUM_SHARE = Number(process.env.DRAWDOWN_R_TO_CUM_SHARE) || 0.3;
export const MAX_TOP_SYMBOL_SHARE = 0.4;
export const PROMOTION_MIN_CALENDAR_DAYS = 5;
export const PROMOTION_MIN_DISTINCT_REGIMES = 2;
// Point 3c — symbol-diversity floor, kept SEPARATE from effectiveN (independent-episode count).
// Without this, a cohort could clear STABLE/PROMOTION's effectiveN bar using one or two symbols
// repeated across many genuinely-independent episodes — real independent draws, but not evidence the
// edge is market-wide rather than an artifact of one or two instruments. 5 matches the existing
// 5-symbol rotation convention already used by every addResolvedContextCohort test fixture; 3 is
// meaningfully stricter than the one-or-two-symbol abuse case while reachable before PROMOTION.
export const STABLE_MIN_DISTINCT_SYMBOLS = 3;
export const PROMOTION_MIN_DISTINCT_SYMBOLS = 5;

// --- Point 4: STAGE-SPECIFIC immutable proof windows ----------------------------------------
// Replaces the single frozen cut (one `cutMs`, dev = everything before it, holdout = everything
// at-or-after it, forever). That model had two defects, both fatal to the claim it was making:
//
//   1. It froze at the FIRST 20 fresh rows, at index floor(20 * 0.7) = 14 — so a lane's entire
//      development evidence was permanently the first 14 closes it ever produced, no matter how
//      many hundreds arrived later. STABLE and PROMOTION were then asked to be proven off 14 rows.
//   2. STABLE and PROMOTION shared ONE holdout. Promotion therefore re-scored the exact cohort
//      that had already authorised STABLE, which is not an out-of-sample test of the promotion
//      decision — it is the same exam sat twice.
//
// The replacement freezes each stage as a WINDOW, not a point, so a later stage can never
// retroactively change an earlier stage's holdout composition:
//
//   stableCut    = { devEndMs, holdoutEndMs }        frozen together, once
//        STABLE dev     = rows with episodeTime <  devEndMs
//        STABLE holdout = rows with episodeTime in [devEndMs, holdoutEndMs)   <- BOUNDED
//   promotionCut = { devEndMs: p }, p >= stableCut.holdoutEndMs, frozen later, once
//        PROMOTION dev     = rows with episodeTime <  p    (deliberately INCLUDES stable's dev AND
//                                                           stable's holdout — earlier validated
//                                                           evidence is legitimate development
//                                                           material for the NEXT decision)
//        PROMOTION holdout = rows with episodeTime >= p    <- open-ended, never scored before
//
// Because STABLE's holdout is bounded ABOVE at holdoutEndMs and PROMOTION's holdout starts AT OR
// AFTER that same boundary, the two holdout cohorts are DISJOINT BY CONSTRUCTION. "New and
// untouched" is then a structural property of the interval arithmetic, not a convention someone
// has to remember. See VariantMatrixStageCut / stageSlicesForCut / ensureVariantMatrixStageCuts.
//
// DISJOINT ROWS ARE NOT ENOUGH — DISJOINT EPISODES ARE THE CLAIM. Two intervals can be disjoint in
// rows and still share a market EPISODE, because an episode is a max-hold-wide window that several
// rows draw from: a boundary landing one row into a live episode leaves a 1-row stub on one side
// and the rest of the SAME window on the other, and since episode chaining restarts per slice, both
// sides count it as an independent draw. Every boundary frozen here is therefore snapped to an
// EPISODE EDGE (episodeEdgeMsOf) — a timestamp at which no episode has rows on both sides. Dev
// takes whole episodes, the holdout opens with the next episode's FIRST row, and
// devEffectiveN + holdoutEffectiveN === effectiveN over their union is an identity rather than an
// approximation. That identity is what makes each stage's holdout a genuinely unseen cohort — see
// WHAT THESE FLOORS DO AND DO NOT CLAIM below for what it does and does not license.
//
// MEMBERSHIP CLOCK — openedAt (`episodeTimeMsOf`), ONE clock everywhere in the proof path.
// The previous model used resolvedAt for membership and openedAt for independence. Under resolved
// time the disjointness above is FALSE: a trade opened inside STABLE's holdout window but held
// past promotionCut.devEndMs resolves into PROMOTION's holdout, so the same market episode gets
// scored twice as "new and untouched". Origin time also cannot be gamed by exit geometry — see
// computeEffectiveN's step 1 for why resolve time manufactures independence out of nothing.
//
// DISCIPLINE (also enforced structurally, not just by convention): a stage's holdout ECONOMICS
// (net/pf/stress on the holdout slice) must never be read by, or surfaced anywhere near, code a
// human uses to iteratively tune VARIANT_MATRIX_DEFINITIONS geometry or the threshold constants
// above — only the boolean pass/fail summaries may ever gate a status on holdout P&L. Feeding raw
// holdout numbers back into tuning would let holdout evidence leak into the very selection process
// it exists to independently verify. The holdout SHAPE fields (row counts, effectiveN, distinct
// symbols) are deliberately NOT covered by that discipline and are read directly by the status
// gate: they say how much genuinely independent evidence exists, not whether it was favourable, so
// they carry no P&L signal that could leak into selection. A count of episodes cannot tell a tuner
// which geometry won.
//
// ================= REACHABILITY (why these eight numbers, and not others) =====================
// Episode density is the ONLY scarce resource here, and its ceiling is data-independent: under the
// chaining rule in computeEffectiveN, AT MOST ONE independent episode can exist per max-hold
// window W, no matter how many symbols or scans fire inside it. So:
//        W =  72 h (the default; 15 variants)  -> <= 0.333 episodes/day  (1 per 3 days)
//        W =  24 h (the five CG_EXP_*_10X)     -> <= 1.0   episodes/day
//        W = 144 h (CG_WIDE_LONG_RUNNER)       -> <= 0.167 episodes/day  (1 per 6 days)
// Measured cadence on this instance (2026-08-01..02, 110 scan cycles / 32.98 h, 4 candidate rows
// per cycle) is ~320 observation rows/day fanned across every variant. Rows therefore accrue about
// 1000x faster than episodes. RAW-ROW thresholds and EFFECTIVE-N thresholds are consequently on
// DIFFERENT SCALES and must never share a constant — reusing STABLE_MIN_FRESH(100) /
// PROMOTION_MIN_FRESH(200) as effectiveN floors, which is what deriveVariantStatus did BEFORE this
// block existed, implies 300 and 600 CALENDAR DAYS at W=72h. That was the bug; the eight constants
// below replaced it. deriveVariantStatus no longer compares effectiveN against either MIN_FRESH.
//
// Calendar arithmetic used below (exact, not an estimate, and MEASURED end-to-end — see the
// [STAGE-REACHABILITY] test, which asserts each figure and asserts that one millisecond less does
// NOT freeze). Two facts drive it:
//
//   * E independent episodes at width W span (E-1)*W of openedAt between their first rows, and
//   * every boundary is EPISODE-ALIGNED (episodeEdgeMsOf). A BOUNDED window of E episodes therefore
//     needs the (E+1)-th episode to have opened before its boundary can be placed, so the boundary
//     sits E*W after the window's first row, not (E-1)*W. An OPEN-ENDED window needs no such
//     closing episode, so PROMOTION's holdout still costs only (PHE-1)*W.
//
//        days-to-STABLE    = (SDE + SHE)*W + Q                 [Q = STAGE_SETTLEMENT_MS, 7.0035 d]
//        days-to-PROMOTION = max((PDE + PHE - 1)*W, PDE*W + Q)
//   Both STABLE boundaries are bounded ⇒ both pay the closing episode. PROMOTION's dev boundary is
//   bounded (pays it) and sits at max(stable holdoutEnd, PDE*W) = PDE*W here, since 20 > 10+5.
//   Q applies to whichever boundary is LAST, and for PROMOTION at these widths the open-ended
//   holdout outruns the quarantine, so Q is non-binding there for all three families.
//
//   family     W     days->STABLE                days->PROMOTION
//   72 h      3 d    (10+5)*3 + 7.00 =  52.00    max(29*3, 20*3 + 7.00) =  87.00
//   24 h      1 d    (10+5)*1 + 7.00 =  22.00    max(29*1, 20*1 + 7.00) =  29.00
//  144 h      6 d    (10+5)*6 + 7.00 =  97.00    max(29*6, 20*6 + 7.00) = 174.00
//
// THESE FIGURES WENT UP, and the increase is reported rather than absorbed. The table published
// before episode alignment was 46/84, 20/28 and 85/168 — computed on the assumption that a stage
// could freeze the instant its floors were met, which is exactly the assumption that let a boundary
// land one row inside a live episode and let that episode be counted on both sides. The extra
// calendar (one max-hold window per bounded boundary, so +2W for STABLE and +W for PROMOTION's dev
// side) is the price of the holdout being genuinely new. NO THRESHOLD WAS LOWERED to keep the old
// day counts; doing so would have bought the calendar back with the same double-counted episode.
// For contrast, the bar this round REPLACED (effectiveN >= 100 / >= 200, i.e. the MIN_FRESH reuse
// described above) worked out to ~331 d and ~654 d at W=72h. It is no longer reachable in the code.
//
// WHAT THESE FLOORS DO AND DO NOT CLAIM. They are HAZARD / DIVERSITY BOUNDS. They guarantee that
// the evidence behind a status spans N separate, non-overlapping, episode-aligned market windows,
// and therefore cap how much of that status can be one lucky regime. They are NOT significance
// tests and they carry NO p-value, NO false-positive rate, and NO power claim.
//
// This is a deliberate correction. An earlier revision of this block justified the two holdout
// episode floors with a sign test — "5 independent windows all non-negative is p = 1/32, 10 is
// p = 1/1024". THE CODE NEVER COMPUTED THAT EVENT. buildStageProof evaluates the holdout with
// AGGREGATE, ROW-LEVEL statistics: mean(holdoutNet), profitFactor(holdoutNet) and
// mean(stressNetR). A positive aggregate is not "every episode non-negative" — one large positive
// episode can outweigh several negative ones and still clear every term the gate actually checks.
// Quoting a p-value for an event no gate requires overstates the evidence, so the claim is removed
// rather than reworded. If a sign test is ever wanted it has to be BUILT: partition the holdout
// with the same EpisodeAccumulator, compute a cost-adjusted and stressed mean R per episode,
// persist episodeCount / nonNegativeEpisodeCount, and gate on a predeclared threshold.
//
// The independence work these floors DO rest on is real and is enforced: because every boundary is
// snapped to an episode edge, a holdout of E episodes is E market windows no earlier stage scored,
// and devEffectiveN + holdoutEffectiveN === effectiveN over the union is an identity. That buys
// genuine out-of-sample separation. It does not by itself buy a significance claim.
//
// The ceiling is the reason to be modest here: at 0.333 episodes/day NO reachable threshold
// delivers significance for realistic effect sizes. At 10 episodes with per-episode sigma ~1R,
// SE ~0.32R and the 2-sided/80%-power MDE is ~0.89R — larger than any effect measured in this
// book. Sizing these floors as diversity bounds is the honest reading of what that ceiling allows.
//
// NOT ENV-TUNABLE, any of them. These define what counts as PROOF. Making proof tunable by
// environment variable is precisely the "measurement blocked by its own params" failure family
// (5 instances of triggers set above the population, 2026-07-26). WATCHABLE_MIN_FRESH stays
// env-tunable because it gates COLLECTION SPEED, not proof.
//
// NOT TUNED TO CURRENT LANES: the local store held ZERO observations while these were chosen, so
// fitting them to what today's lanes would pass was not even possible.

// STABLE, development side.
//   ROWS 40 — a DEPTH check, never an independence check. Sized so each independent window carries
//   ~4 closes on average (40/10 = 4.0): below ~4 closes per window, PF, payoff ratio, drawdown and
//   top-symbol share computed inside a window are one or two trades and are noise. Non-binding at
//   realistic density (see the crossover note on STABLE_MIN_EFFECTIVE_N), so the calendar is
//   governed by independence, not by row accumulation; it binds only for genuinely low-activity
//   lanes, which is correct.
export const STABLE_MIN_DEV_ROWS = 40;
//   EPISODES 10 — the smallest count at which "the edge survived ten separate non-overlapping
//   market windows" is a statement rather than an anecdote, and 10x the effectiveN=1 abuse case
//   this whole workstream exists to stop. Costs 10*3 d = 30 d of dev span at W=72h, 10 d at W=24h,
//   60 d at W=144h — E*W rather than (E-1)*W because the boundary is episode-aligned and so waits
//   for the 11th episode to open (see episodeEdgeMsOf). Crossover: episodes, not rows, are the
//   binding gate whenever a lane averages MORE than 40/10 = 4.0 fresh-valid closes per max-hold
//   window — 1.33/day at W=72h, 4.0/day at W=24h, 0.67/day at W=144h.
export const STABLE_MIN_EFFECTIVE_N = 10;
// STABLE, holdout side.
//   ROWS 20 — same ~4-closes-per-window depth rule (20/5 = 4.0).
export const STABLE_MIN_HOLDOUT_ROWS = 20;
//   EPISODES 5 — half the dev floor, deliberately. A holdout is a CONFIRMATION, not a second
//   independent full proof; requiring parity would double the calendar for no additional
//   information because the dev side already carries the point estimate. 5 is the smallest count
//   that still spans a meaningful spread of market conditions: an episode-aligned boundary makes
//   all five windows development never saw, so clearing the holdout's economics on them is
//   genuinely out-of-sample rather than a re-read of the training slice. NO p-value is claimed —
//   see WHAT THESE FLOORS DO AND DO NOT CLAIM above; the gate checks aggregate holdout economics,
//   not per-episode signs. Costs 5*3 d = 15 d of post-dev span at W=72h: this window is BOUNDED
//   above, so it also waits for the closing episode.
export const STABLE_MIN_HOLDOUT_EFFECTIVE_N = 5;

// PROMOTION, development side. Its window deliberately SUBSUMES the whole of STABLE's (dev AND
// holdout) — earlier validated evidence is legitimate development material for the next decision —
// plus at least 5 further episodes / 30 further rows of genuinely new evidence.
//   ROWS 90 — >= STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS (60) + 30, and 90/20 = 4.5 closes
//   per window, the same depth rule.
export const PROMOTION_MIN_DEV_ROWS = 90;
//   EPISODES 20 — exactly 2x STABLE. 2x is the smallest multiple that guarantees promotion's dev
//   window strictly contains STABLE's ENTIRE window with headroom (20 >= 10 + 5 = 15, i.e. 5
//   episodes / 15 days of genuinely new development evidence at W=72h), so PROMOTION can never
//   freeze at or before STABLE by ARITHMETIC rather than by convention. Costs 20*3 = 60 d of dev
//   span at W=72h — bounded above, so it too waits for the 21st episode to open.
export const PROMOTION_MIN_EFFECTIVE_N = 20;
// PROMOTION, holdout side — a cohort no earlier stage has ever scored (guaranteed by
// p >= stableCut.holdoutEndMs, and no episode straddles that boundary because it is episode-aligned).
//   ROWS 40 — 2x STABLE's holdout rows, 40/10 = 4.0 closes per window.
export const PROMOTION_MIN_HOLDOUT_ROWS = 40;
//   EPISODES 10 — 2x STABLE's holdout floor, on the same diversity-bound reasoning: an
//   episode-aligned boundary means all ten are windows no earlier stage scored, so PROMOTION's
//   confirmation is drawn entirely from market conditions neither STABLE's dev nor STABLE's holdout
//   has seen. NO p-value is claimed here either. Deliberately identical to the
//   outgoing single-stage HOLDOUT_MIN_EFFECTIVE_N so the STRICTEST rung of the new two-stage ladder
//   is no weaker than the single rung of the old one. Costs (10-1)*3 = 27 d at W=72h — the ONE
//   window whose cost episode alignment did not raise, because it is OPEN-ENDED and therefore needs
//   no closing episode to prove its last window is complete.
export const PROMOTION_MIN_HOLDOUT_EFFECTIVE_N = 10;

/**
 * Settlement quarantine — the piece that makes "immutable" true under an openedAt membership clock.
 *
 * openedAt membership creates one hazard the old resolvedAt model did not have: a position opened
 * BEFORE a frozen boundary but resolved AFTER it would later join an already-frozen slice. Neutralise
 * it structurally rather than by hoping: no candidate boundary may be placed later than
 * `maxEpisodeTimeMs(freshRows) - STAGE_SETTLEMENT_MS`. Because no observation can outlive EXPIRY_MS,
 * any row whose openedAt precedes that point has certainly terminated, so live trading can never add
 * a row behind a frozen boundary.
 *
 * Derived from the data's own newest origin time, NOT `Date.now()` — deliberately. Termination is
 * established by the existence of later evidence, not by the wall clock. That makes the whole freeze
 * path a pure function of (rows, thresholds, W): deterministic, testable without clock mocking,
 * immune to clock skew, and immune to future-dated fixtures. In production the two are equivalent.
 * If the feed stalls, stage freezes stop advancing — which is correct: no new evidence, no new proof.
 *
 * LIMITATION, documented rather than hidden: this stops LIVE TRADING from adding rows behind a
 * frozen boundary. It does not stop a historical BACKFILL that injects old-openedAt rows — those
 * land in whichever frozen window their own openedAt selects. The BOUNDARY stays immutable; the
 * slice CONTENTS can still grow that way. There is no ingest-timestamp field on the observation to
 * fix it properly, and adding one is out of scope here.
 */
export const STAGE_SETTLEMENT_MS = EXPIRY_MS + CANDLE_MS;

// Structural invariants, asserted at module load so a future edit cannot silently invert the ladder
// and make a status permanently unreachable. Unreachability is the top risk in this design because
// it looks EXACTLY like "still collecting" from every dashboard.
{
  const stageThresholds: readonly (readonly [string, number])[] = [
    ["STABLE_MIN_DEV_ROWS", STABLE_MIN_DEV_ROWS],
    ["STABLE_MIN_EFFECTIVE_N", STABLE_MIN_EFFECTIVE_N],
    ["STABLE_MIN_HOLDOUT_ROWS", STABLE_MIN_HOLDOUT_ROWS],
    ["STABLE_MIN_HOLDOUT_EFFECTIVE_N", STABLE_MIN_HOLDOUT_EFFECTIVE_N],
    ["PROMOTION_MIN_DEV_ROWS", PROMOTION_MIN_DEV_ROWS],
    ["PROMOTION_MIN_EFFECTIVE_N", PROMOTION_MIN_EFFECTIVE_N],
    ["PROMOTION_MIN_HOLDOUT_ROWS", PROMOTION_MIN_HOLDOUT_ROWS],
    ["PROMOTION_MIN_HOLDOUT_EFFECTIVE_N", PROMOTION_MIN_HOLDOUT_EFFECTIVE_N],
  ];
  for (const [name, value] of stageThresholds) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`current-guard-variant-matrix: ${name} must be a positive integer, got ${String(value)}`);
    }
  }
  // PROMOTION's development must be able to contain the WHOLE of STABLE (its dev and its holdout)
  // and still add new evidence — otherwise promotion could freeze at or before stable.
  if (PROMOTION_MIN_EFFECTIVE_N < STABLE_MIN_EFFECTIVE_N + STABLE_MIN_HOLDOUT_EFFECTIVE_N) {
    throw new Error(
      "current-guard-variant-matrix: PROMOTION_MIN_EFFECTIVE_N must be >= STABLE_MIN_EFFECTIVE_N + STABLE_MIN_HOLDOUT_EFFECTIVE_N",
    );
  }
  if (PROMOTION_MIN_DEV_ROWS < STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS) {
    throw new Error(
      "current-guard-variant-matrix: PROMOTION_MIN_DEV_ROWS must be >= STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS",
    );
  }
  // The upper rung must be a STRICTLY harder out-of-sample test, never merely an equal one.
  if (PROMOTION_MIN_HOLDOUT_EFFECTIVE_N <= STABLE_MIN_HOLDOUT_EFFECTIVE_N) {
    throw new Error(
      "current-guard-variant-matrix: PROMOTION_MIN_HOLDOUT_EFFECTIVE_N must be > STABLE_MIN_HOLDOUT_EFFECTIVE_N",
    );
  }
  if (PROMOTION_MIN_HOLDOUT_ROWS <= STABLE_MIN_HOLDOUT_ROWS) {
    throw new Error("current-guard-variant-matrix: PROMOTION_MIN_HOLDOUT_ROWS must be > STABLE_MIN_HOLDOUT_ROWS");
  }
}

// REMOVED, deliberately and by name so a rebase cannot resurrect them silently:
//   HOLDOUT_DEV_FRACTION (0.7), HOLDOUT_CUT_MIN_FRESH (20)  — the single frozen-at-14 cut.
//   HOLDOUT_MIN_FRESH (30), HOLDOUT_MIN_EFFECTIVE_N (10)    — the single-stage holdout floors.
// All four are superseded by the eight stage constants above. They are DELETED rather than left
// unused so that any surviving reader is a compile error instead of a silently stale gate.

export interface VariantMatrixVariantDefinition {
  id: VariantMatrixVariantId;
  label: string;
  /** Exact market contexts this geometry is designed to prove. Never inferred from its label. */
  applicableContexts: readonly ExactLaneContext[];
  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  costModel: VariantFillMode; // "taker" or "maker_limit" cost basis
  description: string;
  /**
   * Parameterized wide geometry. When set, the stop is floored at `stopFloorBps` and the paired
   * TP is placed at `tpRewardMultiple` × the (floored) risk distance. Omitted ⇒ raw geometry.
   * (CG_WIDE/CG_TRAIL keep their hardcoded WIDE_STOP_MIN_BPS / 1.0R behavior.)
   */
  stopFloorBps?: number;
  tpRewardMultiple?: number;
  /** Variant only admits/derives on LONG signals (rejected on SHORT). */
  longOnly?: boolean;
  /** Variant only admits/derives on SHORT signals (rejected on LONG). */
  shortOnly?: boolean;
  /** Variant is only collected while the controller is explicitly BULLISH + LONG_ONLY. */
  bullishOnly?: boolean;
  /**
   * Per-variant max-hold (hours) before the resolver marks the position to market.
   * Omitted ⇒ the global PAPER_MAX_HOLD_MS (72h). Let-it-run lanes (wide stop +
   * far TP) extend this so a slow winner is given room to trend instead of being
   * cut at 72h.
   */
  maxHoldHours?: number;
  /** Paper-only leverage label. Experimental geometry shortens TP while keeping a net-positive cost floor. */
  experimentalLeverage?: number;
  /** Paper-only risk multiplier used by the paper book to model larger size. */
  paperRiskMultiplier?: number;
  /** Explicit marker for high-risk diagnostic lanes. */
  experimentalOnly?: boolean;
  /** Symbols this variant must NEVER open in the REAL mirror (checked in lane-selector-v2.ts),
   *  regardless of direction/regime. Measurement (this store) still records observations for
   *  every symbol — only live/testnet admission is restricted — so OOS proof continues collecting
   *  in case a blocked symbol's edge recovers. 2026-07-08 operator audit: CG_WIDE_FAST_SHORT's
   *  pooled stats looked flat-to-negative on testnet/live (WR ~55%, meanR ~-0.2) despite the SAME
   *  week (07-w0) showing WLD/SUI/FET at 87-100% WR — the pooled average was being dragged down by
   *  NEAR/INJ/XRP/SEI, which sat at 17-48% WR (well under the 66.7% breakeven bar for a 0.5R
   *  target) in that SAME week, on BOTH instances independently. Not a regime-timing artifact
   *  (SUI/WLD/FET improved in the identical window) — genuine per-symbol underperformance. */
  excludedSymbols?: readonly string[];
}

export const VARIANT_MATRIX_DEFINITIONS: readonly VariantMatrixVariantDefinition[] = [
  {
    id: "CG_BASELINE_CURRENT",
    label: "Baseline current geometry (tp1 full exit)",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    description: "Benchmark: same entry/stop/tp1 as the post-cutover lane, taker cost, full exit at tp1.",
  },
  {
    id: "CG_WIDE_STOP_TP_WIDE",
    label: "Wide stop (>=300bps) with widened TP (1.5R payoff)",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    // The execution resolver enforces a 1.5R floor using the actual fill price.
    // Keep this baseline geometry admissible rather than relying on a later reject.
    tpRewardMultiple: 1.5,
    description: "Widen stop to >=300bps AND widen TP to 1.5R so the executable payoff clears the conservative admission floor.",
  },
  {
    id: "CG_TRAIL_AFTER_TP1",
    label: "Wide stop (>=300bps) with trail after 1R touch",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "trail_after_tp1",
    fillMode: "taker",
    costModel: "taker",
    description: "Use >=300bps paired 1R geometry; on target touch move stop to breakeven and ride the exact candle path.",
  },
  {
    id: "CG_SCALEOUT_TP1_TRAIL",
    label: "Scale out 50% at TP1, trail the runner",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "scaleout_tp1_trail",
    fillMode: "taker",
    costModel: "taker",
    description: "Lock 50% at TP1, trail the remaining 50% at breakeven; blended R from the exact candle path.",
  },
  {
    id: "CG_NO_FIB500_ENTRYSET",
    label: "Baseline excluding fib_500_entry signals",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    description: "Reject fib_500_entry signals (counted separately); otherwise identical to the baseline.",
  },
  {
    id: "CG_MAKER_LIMIT_SIM",
    label: "Maker/limit entry (no-fill risk) with maker cost",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "maker_limit",
    costModel: "maker_limit",
    description: "Post-only limit at entry: fills only on a pullback to entry within the fill window, else NO_FILL; maker cost.",
  },
  {
    id: BULL_TREND_VARIANT_ID,
    label: "Bull trend: stop >=200bps, TP 1.5R (full exit)",
    applicableContexts: ["LONG_BULLISH"],
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 200,
    tpRewardMultiple: 1.5,
    longOnly: true,
    bullishOnly: true,
    description:
      "Pure bullish trend lane: 200bps minimum breathing room with a 1.5R full-exit target. " +
      "At the floor, the 300bps target stays below the observed ~450bps long-move cliff while " +
      "improving payoff asymmetry and keeping 22bps round-trip cost near 0.11R.",
  },
  {
    id: BULL_SCALEOUT_VARIANT_ID,
    label: "Bull trend: stop >=200bps, scaleout 50% at 1R + BE runner",
    applicableContexts: ["LONG_BULLISH"],
    exitRule: "scaleout_tp1_trail",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 200,
    tpRewardMultiple: 1.0,
    // 2026-08-05: measured resolution time over 151 fresh-valid closes: p90 38.9h, p95 62.3h,
    // only 5.3% ever reach the 72h default. 36h sits just under p90 (barely touches the
    // legitimate tail) while halving the effectiveN episode-clustering window (blockWidthMs =
    // variantMaxHoldMs), which is what was keeping this lane's independent-episode count pinned
    // near 1 despite 150+ raw rows. See STABLE_MIN_DEV_EFFECTIVE_N.
    maxHoldHours: 36,
    longOnly: true,
    bullishOnly: true,
    description:
      "A/B sibling of the bull trend lane under identical entry gates: lock 50% at 1R and trail " +
      "the runner at breakeven — the exit family that is proven on the SHORT book. Tests whether " +
      "the long failure mode (losers run to stop, winners exit small) is an exit problem.",
  },
  {
    id: "LG_R12_STOP250_FULL",
    label: "Long: stop ≥250bps, TP 1.2R (full exit)",
    applicableContexts: LONG_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 250,
    tpRewardMultiple: 1.2,
    longOnly: true,
    description: "Reward-geometry research (GPT #1): floor stop at 250bps, place TP at 1.2× risk. Tests modest asymmetry while keeping TP inside the realised long-move band (cliff at ~450bps).",
  },
  {
    id: "LG_R12_STOP300_FULL",
    label: "Long: stop ≥300bps, TP 1.2R (full exit)",
    applicableContexts: LONG_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 1.2,
    longOnly: true,
    description: "Reward-geometry research (GPT #2): same 300bps breathing room as the proven CG_WIDE long lane, but bank 1.2R instead of 1.0R. Pure 'monetise more of the move' test.",
  },
  {
    // Placed last among the long lanes deliberately: on a no-evidence score tie
    // it must NOT preempt the established BL_TREND collection default (stable
    // sort preserves input order). Once it earns better paper economics the
    // ranker selects it on score — competing on evidence, not list position.
    id: "CG_WIDE_LONG_RUNNER",
    label: "LONG let-it-run: wide >=300bps stop, far 3R TP, ~6-day hold",
    applicableContexts: ["LONG_BULLISH"],
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300, // same breathing room as CG_WIDE; also routes through the wide-geometry path
    tpRewardMultiple: 3,
    maxHoldHours: 144,
    longOnly: true,
    description:
      "The honest improvement of the wide-stop thesis. CG_WIDE's old 1R payoff loses (1:1 needs " +
      ">50% WR, the book gets ~35%): it banks small at 1R while eating full stops. The exit search " +
      "(scripts/cgwide-exit-search.ts) re-resolved every historical CG_WIDE order under let-it-run " +
      "geometry and found LONG edge climbs monotonically with TP distance and hold (1R −0.03 → 3R " +
      "−6d +0.107R) — longs trend and get marked-to-market above water — while SHORT stays negative " +
      "under every geometry. So this lane keeps the wide stop but places a FAR 3R target and holds " +
      "~6 days, LONG-only. Direction is enforced here (longOnly) and by the regime edge gate.",
  },
  {
    // The SHORT mirror of the long-runner improvement — but the OPPOSITE geometry.
    // The short exit search (scripts/cgwide-short-search.ts) showed shorts get
    // catastrophically worse with a far TP (runner 2-3R ≈ −0.47R) because this
    // market mean-reverts UP against shorts; the WINNER is taking profit FAST
    // (wide stop, TP at 0.5R ≈ +0.055R, ~71% WR — grab the quick move before the
    // bounce). So this lane keeps the wide >=300bps stop but banks at 0.5R,
    // SHORT-only. Placed last so it never preempts a default lane on a score tie.
    id: "CG_WIDE_FAST_SHORT",
    label: "SHORT fast-TP: wide >=300bps stop, near 0.5R TP",
    applicableContexts: SHORT_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.5,
    shortOnly: true,
    // 2026-07-08: NEAR/INJ/XRP/SEI excluded from REAL admission after a per-symbol audit (see
    // excludedSymbols doc above) — WLD/DOGE/SUI/FET verified good in the same window, kept.
    excludedSymbols: ["NEARUSDT", "INJUSDT", "XRPUSDT", "SEIUSDT"],
    description:
      "Fast-take-profit SHORT: wide >=300bps stop with a near 0.5R target. Shorts in this universe " +
      "mean-revert up, so a far TP (runner) loses badly (−0.47R) while banking quickly at 0.5R is " +
      "honestly positive (+0.055R, ~71% WR). SHORT-only; the wide-stop 1R short stays vetoed by the " +
      "lane edge gate.",
  },
  {
    // Hypothesis A (disambiguation): is CG_WIDE_FAST_SHORT's edge the FAST 0.5R
    // exit, or the SHORT direction? This is its exact LONG mirror — same wide stop
    // + 0.5R fast TP, LONG-only. If it proves positive OOS too, the edge is the
    // geometry (fast exit), not the direction. NOTE: the VM source population is
    // ~99% SHORT, so this lane accrues OOS slowly — it's a probe for when long
    // shadow positions close, not a fast-maturing lane.
    id: "CG_WIDE_FAST_LONG",
    label: "LONG fast-TP: wide >=300bps stop, near 0.5R TP",
    applicableContexts: LONG_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.5,
    // 2026-08-05: measured resolution time over 189 fresh-valid closes: p90 33.2h, p95 41.2h,
    // only 1.1% ever reach the 72h default. 36h sits just above p90 (barely touches the
    // legitimate tail) while halving the effectiveN episode-clustering window (blockWidthMs =
    // variantMaxHoldMs), which is what was keeping this lane's independent-episode count pinned
    // at 2 despite 189 raw rows. See STABLE_MIN_DEV_EFFECTIVE_N.
    maxHoldHours: 36,
    longOnly: true,
    description:
      "Disambiguation lane: the exact LONG mirror of CG_WIDE_FAST_SHORT (wide >=300bps stop, fast 0.5R " +
      "target). Tests whether the fast-exit edge is geometric (works both directions) or short-specific. " +
      "Prove OOS before any read — small forward sample expected (short-biased source population).",
  },
  {
    // Hypothesis B (cut the tail): the bleeding variants are wide-stop slow-TP full
    // exits (PF ~0.3). This keeps the NATIVE ~175bps stop (no widening) and banks
    // fast at 0.5R — the tightest-stop + fastest-exit combo the geometry allows, to
    // test whether the wide-stop tail (not the entry) is what kills the longs.
    id: "CG_TIGHT_FAST_05",
    label: "Tight native stop (~175bps) + fast 0.5R TP",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 175,
    tpRewardMultiple: 0.5,
    description:
      "Native ~175bps stop (no widening) with a fast 0.5R full-exit target. Attacks the wide-stop tail " +
      "directly: if PF improves vs the wide-stop variants, the loss driver is stop width, not entry. " +
      "Direction-agnostic; prove OOS before promotion.",
  },
  {
    // Hypothesis C (remove risk early): instead of a full exit at 0.5R, move the
    // stop to breakeven once 0.5R is touched and ride the runner. Tests whether the
    // fast variants leave upside on the table that a free runner can capture without
    // re-introducing the wide-stop tail.
    id: "CG_BE_AFTER_05",
    label: "Breakeven after 0.5R touch, ride the runner",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "trail_after_tp1",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.5,
    // 2026-08-05: measured resolution time over 357 fresh-valid closes: p90 35.6h, p95 52.2h,
    // only 3.1% ever reach the 72h default (and that MAX_HOLD_MTM tail is where this lane's real
    // bleed lives — 6.7% WR / -0.60R avg on those forced closes vs 79.5% WR clean, ~34% of total
    // R lost to a 4.2%-of-rows tail). 36h sits just above p90 while halving the effectiveN
    // episode-clustering window (blockWidthMs = variantMaxHoldMs), which is what was keeping this
    // lane's independent-episode count pinned at 2 despite 357 raw rows.
    maxHoldHours: 36,
    description:
      "Wide >=300bps stop, 0.5R trigger: on a 0.5R touch move the stop to breakeven and ride the exact " +
      "candle path. Tests early risk-removal + free upside vs the fast full-exit. Direction-agnostic; " +
      "prove OOS before promotion.",
  },
  {
    // Operator-requested (2026-06-22): bank a "touched a good high then faded to flat/negative"
    // trade instead of round-tripping to a stop.
    // RE-TARGETED 2026-06-23: the first cut paired the giveback with BASELINE (~1R TP) geometry and
    // the eval proved it INERT — 0 giveback exits over 79 closes (all TP/SL), netAvgR identical to
    // baseline. Reason: arm at 0.75R is only 0.25R below a ~1R TP, so an armed trade just completes
    // to TP before it can retrace. The giveback only has room when the TP is FAR. So this now uses a
    // WIDE stop (>=300bps) + FAR 3R TP: trades can run up to a high MFE (e.g. 2R), and the giveback
    // banks the faded peak (~1R) instead of round-tripping to the stop or waiting for a rarely-hit 3R.
    // The meaningful A/B is now vs the let-it-run wide lanes (CG_WIDE_LONG_RUNNER / CG_WIDE_STOP_TP_WIDE)
    // on the SAME far-TP geometry: does banking the fade beat riding to TP/stop?
    id: "CG_MFE_GIVEBACK",
    label: "MFE-giveback exit (wide stop, 3R TP — bank the faded runner)",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "mfe_giveback",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 3,
    description:
      "Wide >=300bps stop + far 3R TP. Once up >= MFE_GIVEBACK_ARM_R it exits on a retrace to " +
      "peak*(1-MFE_GIVEBACK_FRAC) of favorable — converting 'ran up to a high MFE then round-tripped' " +
      "into a banked partial gain. The far TP gives the giveback room to operate (baseline ~1R TP made " +
      "it inert). Direction-agnostic; A/B vs the let-it-run wide lanes. Prove OOS before promotion.",
  },
  {
    // "Sentil" #1 (2026-06-23): CG_BASELINE_CURRENT with ONLY the TP moved to a fast 0.5R. The
    // OOS-thirds audit showed baseline's sole negative third is OOS2 (-0.026, the mid-window
    // whipsaw) — the fast lanes turned that same window strongly positive by banking before the
    // bounce. stopFloorBps:1 is a NON-BINDING sentinel: targetStopBps = max(rawStop, 1) = rawStop
    // (raw stops are always >1bps), so the entry AND stop stay identical to CG_BASELINE_CURRENT —
    // the only changed variable is TP placement (tiny raw tp1 → 0.5R). A clean isolation of "is
    // baseline's miss purely a TP-placement problem?". Direction-agnostic; prove OOS before promotion.
    id: "CG_BASELINE_FAST_05",
    label: "Baseline entry + fast 0.5R TP (raw stop)",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 1,
    tpRewardMultiple: 0.5,
    description:
      "Sentil of CG_BASELINE_CURRENT: identical raw entry+stop (stopFloorBps:1 never binds), TP moved " +
      "to a fast 0.5R full exit. Isolates TP placement as the single variable to test whether banking " +
      "before the OOS2 mid-window bounce flips baseline to all-three-OOS-positive.",
  },
  {
    // "Sentil" #2 (2026-06-23): CG_MAKER_LIMIT_SIM with the same fast 0.5R TP. Maker posted the best
    // raw net (+0.065) thanks to the lower maker cost; pairing that cheap fill with the proven
    // fast-bank exit is the most promising combo — capture the OOS2 down-move cheaply and bank before
    // the revert. Same non-binding stopFloorBps:1 sentinel keeps the raw stop; only fill/cost (maker)
    // and TP (0.5R) differ from CG_BASELINE_FAST_05. Direction-agnostic; prove OOS before promotion.
    id: "CG_MAKER_FAST_05",
    label: "Maker entry + fast 0.5R TP (raw stop, maker cost)",
    applicableContexts: ALL_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "maker_limit",
    costModel: "maker_limit",
    stopFloorBps: 1,
    tpRewardMultiple: 0.5,
    description:
      "Sentil of CG_MAKER_LIMIT_SIM: post-only maker fill (no-fill risk) + maker cost, raw entry+stop " +
      "(stopFloorBps:1 never binds), TP moved to a fast 0.5R full exit. Tests the cheapest-cost + " +
      "fastest-bank combo — the most promising path to a robustly positive short edge.",
  },
  {
    id: "CG_EXP_LONG_WIDE_FAST_10X",
    label: "EXP LONG 10x: wide stop, ultra-fast 0.25R TP",
    applicableContexts: LONG_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.25,
    maxHoldHours: 24,
    longOnly: true,
    experimentalLeverage: 10,
    paperRiskMultiplier: 10,
    experimentalOnly: true,
    description:
      "High-risk paper-only duplicate of CG_WIDE_FAST_LONG: same wide >=300bps stop, but TP is reduced " +
      "to 0.25R and paper risk is multiplied 10x to model aggressive short-duration sizing. Never live by default.",
  },
  {
    id: "CG_EXP_LONG_TIGHT_FAST_10X",
    label: "EXP LONG 10x: tight stop, ultra-fast 0.25R TP",
    applicableContexts: LONG_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 175,
    tpRewardMultiple: 0.25,
    maxHoldHours: 24,
    longOnly: true,
    experimentalLeverage: 10,
    paperRiskMultiplier: 10,
    experimentalOnly: true,
    description:
      "High-risk paper-only duplicate of CG_TIGHT_FAST_05 for LONG: native/tight stop, TP reduced to " +
      "0.25R, 10x paper risk sizing, 24h max hold. Tests fast scalp capture without touching live execution.",
  },
  {
    id: "CG_EXP_LONG_MFE_GIVEBACK_10X",
    label: "EXP LONG 10x: MFE giveback, 1R cap",
    applicableContexts: LONG_EXACT_LANE_CONTEXTS,
    exitRule: "mfe_giveback",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 1,
    maxHoldHours: 24,
    longOnly: true,
    experimentalLeverage: 10,
    paperRiskMultiplier: 10,
    experimentalOnly: true,
    description:
      "High-risk paper-only duplicate of MFE-GIVEBACK LONG: wide stop, TP reduced from 3R to 1R, " +
      "global MFE-giveback exit still banks retraces, 10x paper risk sizing, 24h max hold.",
  },
  {
    id: "CG_EXP_SHORT_MFE_GIVEBACK_10X",
    label: "EXP SHORT 10x: MFE giveback, 1R cap",
    applicableContexts: SHORT_EXACT_LANE_CONTEXTS,
    exitRule: "mfe_giveback",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 1,
    maxHoldHours: 24,
    shortOnly: true,
    experimentalLeverage: 10,
    paperRiskMultiplier: 10,
    experimentalOnly: true,
    description:
      "High-risk paper-only duplicate of MFE-GIVEBACK SHORT: wide stop, TP reduced from 3R to 1R, " +
      "global MFE-giveback exit still banks retraces, 10x paper risk sizing, 24h max hold.",
  },
  {
    id: "CG_EXP_SHORT_WIDE_FAST_10X",
    label: "EXP SHORT 10x: wide stop, ultra-fast 0.25R TP",
    applicableContexts: SHORT_EXACT_LANE_CONTEXTS,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.25,
    maxHoldHours: 24,
    shortOnly: true,
    experimentalLeverage: 10,
    paperRiskMultiplier: 10,
    experimentalOnly: true,
    description:
      "High-risk paper-only duplicate of CG_WIDE_FAST_SHORT: same wide stop, TP reduced to 0.25R, " +
      "10x paper risk sizing, 24h max hold for short-duration scalp measurement.",
  },
];

export const BASELINE_VARIANT_ID: VariantMatrixVariantId = "CG_BASELINE_CURRENT";

// ---------------------------------------------------------------------------
// Source qualifying signal (geometry-bearing). The route builds these from
// qualifying current-guard ShadowPositions; tests build them synthetically.
// ---------------------------------------------------------------------------
/** Regime posture at signal time — how long the regime is expected to persist. */
export type VariantPosture = "TACTICAL" | "EXTENDED";
/** Direction the regime favors at signal time (independent of the trade's own direction). */
export type VariantRegimeDirection = "LONG" | "SHORT" | "MIXED";
export type AxisRegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";

export interface VariantMatrixSignal {
  sourceSignalId: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  stopDistanceBps: number | null;
  regime: string | null;
  entryVariant: string | null;
  openedAt: string;
  closedAt: string | null;
  /** Regime posture + favored direction at signal time (fresh-feed populates these; null on legacy). */
  posture?: VariantPosture | null;
  regimeDirection?: VariantRegimeDirection | null;
  /** Derivatives crowding state at signal time (BUILDING/EXHAUSTING/UNWINDING/NEUTRAL); fresh feed. */
  crowdingState?: string | null;
  /** Shared-origin scan/episode identity (e.g. the scan cycle's generatedAt). Fresh-feed populates
   *  this; null on legacy/shadow-position-derived signals which have no batch identity. computeEffectiveN
   *  uses it as a MERGE-ONLY relation on top of the openedAt episode chaining — it can force two rows
   *  into the same independent draw, never split them into more. See its doc comment. */
  scanBatchId?: string | null;
  /** PREFERRED independent-episode identity when a producer eventually persists one. NOTHING in this
   *  repo sets it today (verified: zero producers) — it is forward support only, and every path must
   *  behave byte-identically to today while it is absent. See computeEffectiveN step 4a for the
   *  merge-only semantics and why "prefer" is implemented as merge rather than replace. */
  marketEpisodeId?: string | null;
}

export interface CurrentGuardVariantMatrixObservation {
  observationId: string;
  variantId: VariantMatrixVariantId;
  variantVersion: typeof CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION;
  sourceSignalId: string;
  sourceObservationKey: string; // `${symbol}|${direction}|${openedAt}`
  symbol: string;
  direction: Direction;
  regime: string | null;
  /** Repair-only explicit axes. Direction and regime are separate dimensions. */
  axisVersion?: 1;
  axisDirection?: Direction;
  axisRegimeFamily?: AxisRegimeFamily;
  axisKey?: string;
  /** Shared-origin scan/episode identity, copied from the source signal. Optional — absent/null on
   *  legacy rows and on rows produced from signals with no batch identity (e.g. shadow-position
   *  derived). Never backfilled. Merge-only input to computeEffectiveN when present: rows sharing it
   *  are forced into one independent draw. Its absence never adds a draw — the openedAt episode
   *  chaining is the base grouping either way. */
  scanBatchId?: string | null;
  /**
   * PREFERRED independent-episode identity — the persisted answer to "which market episode was this
   * one draw from", when a producer eventually supplies one. Optional and ABSENT on every row this
   * repo writes today: no producer exists (verified repo-wide), so this is forward support and the
   * openedAt/max-hold chaining in computeEffectiveN remains the operative identity in practice.
   *
   * "Preferred" is implemented as MERGE-ONLY, deliberately and narrowly (see computeEffectiveN step
   * 4a): a shared marketEpisodeId can COLLAPSE rows the time chain would have called separate draws
   * — e.g. a genuine episode spanning two max-hold windows — but it can never SPLIT rows that
   * overlap inside one max-hold window into more draws. Splitting is the inflating direction and
   * inflating independence is the exact failure this file exists to stop; an upstream producer bug
   * that minted a fresh id per scan would otherwise silently restore the effectiveN=1-wearing-N-hats
   * bug through a field nobody is watching. Literal replace-the-identity semantics are a separate,
   * explicitly-approved decision, not something to slip in.
   */
  marketEpisodeId?: string | null;
  /**
   * The variant's own variantMaxHoldMs(variantId) AT THE MOMENT this row was opened (recorded once,
   * in buildVariantMatrixObservationsForSignal, never backfilled). Optional and ABSENT on every row
   * this repo wrote before 2026-08-05 — a genuine "we don't know" for legacy data, not a 0/null
   * standing in for one.
   *
   * 2026-08-05 evidence-integrity fix (isolated-runtime-validation goal, requirement C): before this
   * field existed, variantMaxHoldMs(variantId) was looked up LIVE against the variant's CURRENT
   * config every time episode identity was computed, for every row regardless of age — so changing a
   * variant's maxHoldHours retroactively re-chained every already-recorded row under the new width,
   * and a position force-closed early by exactly that kind of reduction (resolutionSource:
   * "MAX_HOLD_MTM") was counted identically to one that organically ran its own full course. Both are
   * proven, executed regressions, not theoretical — see current-guard-variant-matrix.test.ts's
   * [EVIDENCE-INTEGRITY-A]/[EVIDENCE-INTEGRITY-B] and [[maxholdhours-versioning-evidence-integrity-gap-2026-08-05]].
   *
   * isFreshValidObs is the fix's one enforcement point: a row only counts toward current evidence
   * when openMaxHoldMs is ABSENT (legacy row — grandfathered in exactly as before, so this field's
   * addition changes zero observable behavior until it has been live long enough to matter) or equals
   * variantMaxHoldMs(variantId) evaluated NOW. A row whose recorded value has since drifted from the
   * live config — because the variant's maxHoldHours changed after this row opened, whether it later
   * resolved organically or was force-closed by that exact change — silently drops out of freshValid,
   * exactly like a MAX_HOLD_MTM-caused early exit already implicitly represents different economics
   * than the row's own regime intended. This is deliberately NOT retroactive for existing data (no
   * historical openMaxHoldMs is recoverable after the fact) and deliberately NOT a full "report both
   * lane versions separately" system — it closes the silent-contamination gap, nothing more.
   */
  openMaxHoldMs?: number;
  entryVariant: string | null;
  createdAt: string;
  openedAt: string;
  resolvedAt: string | null;
  updatedAt?: string | null;

  // Original geometry from the source signal.
  originalEntryPrice: number;
  originalStopLoss: number;
  originalTakeProfitLevels: number[];

  // Simulated geometry for this variant.
  simulatedEntryPrice: number;
  simulatedStopLoss: number;
  simulatedTakeProfitLevels: number[];
  stopDistanceBps: number | null;

  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  costModel: VariantFillMode;

  costR: number | null;
  grossR: number | null;
  netR: number | null;
  status: VariantObservationStatus;

  maxMfeR: number | null;
  minMaeR: number | null;
  durationMinutes: number | null;
  resolutionSource: string | null;
  intrabarResolutionStatus: VariantIntrabarStatus;
  // Minutes between the entry (openedAt) and when the observation was recorded (createdAt). The
  // fresh feed makes this ≈0; the old shadow-position feed made it ~6h median. isFreshValid is now
  // computed from it at CREATION (lag ≤ FRESH_ENTRY_MAX_MINUTES) — a real live-tradeability flag,
  // not the old hardcoded `true`.
  entryLagMinutes: number | null;
  isFreshValid: boolean | null;
  // Regime posture + favored direction captured at signal time (fresh feed; null on legacy obs).
  posture: VariantPosture | null;
  regimeDirection: VariantRegimeDirection | null;
  crowdingState: string | null;
  /** Point 3b: explicit axis-provenance stamp, set ONCE at creation — never re-derived, never
   *  backfilled onto existing rows (mirrors regime-controller-filtered-edge-shadow.ts's
   *  hasFreshForensicsVersion discipline). True only when the fresh feed supplied BOTH `posture`
   *  and `regimeDirection` at signal time. Legacy/parsed rows (selectVariantMatrixSignals, which
   *  never sets posture/regimeDirection) always get `false` here, even though they can still land
   *  in a context bucket via the regime STRING classifier (observationRegimeFamilyKey) — that
   *  string-only classification is not exact-axis proof and must never stand alone as strong
   *  individual proof of a lane x context (see buildContextEvidenceRow). */
  exactAxisProof: boolean;

  reportOnly: true;
  laneVersion: typeof CURRENT_GUARD_VARIANT_MATRIX_LANE;
}

// ---------------------------------------------------------------------------
// Resolver metadata — persisted in the store JSON so the report builder can
// surface last-run diagnostics without re-running the resolver.
// ---------------------------------------------------------------------------
export interface VariantMatrixResolverMeta {
  lastRunAt: string;
  resolvedCount: number;
  expiredCount: number;
  dataFailureCount: number;
  errorCount: number;
  /** Rotating Phase-2 start offset so successive budgeted runs cover DIFFERENT slices of the
   *  OPEN backlog. Oldest-first alone re-walked the same (genuinely unresolvable) oldest
   *  wide-stop obs every run and never reached the resolvable mid-age cohort — the same
   *  budget-starvation class as the paper-resolver fair-scheduler fix. */
  walkCursor?: number;
}

/** The two proof stages that own an immutable window. Ordered: `promotion` can only freeze after
 *  `stable` already has, and strictly at-or-after `stable`'s holdout upper bound. */
export type VariantMatrixProofStage = "stable" | "promotion";

/**
 * Point 4 — ONE immutable proof WINDOW for one stage of one proof unit (a variant, or a variant ×
 * exact-context pair; keyed by the caller).
 *
 * Both boundaries are `episodeTime` (openedAt, see episodeTimeMsOf) epoch-ms, and the clock is the
 * same one used for independence — a row can therefore never sit in one stage for counting and
 * another for economics, which was possible under the previous resolvedAt-membership model.
 *
 *   dev     = rows with episodeTime <  devEndMs
 *   holdout = rows with episodeTime in [devEndMs, holdoutEndMs)   (holdoutEndMs === null ⇒ open-ended)
 *
 * STABLE always carries a finite `holdoutEndMs`: its holdout must stop growing so PROMOTION's
 * holdout, which begins at or after that bound, is DISJOINT from it by construction rather than by
 * convention. PROMOTION carries `holdoutEndMs === null`: it is the top stage, nothing above it can
 * be contaminated, and an open-ended holdout keeps an already-promoted lane under permanent live
 * verification.
 *
 * Frozen ONCE per (key, stage) via CurrentGuardVariantMatrixStore.freezeStageCutIfAbsent and never
 * moved afterward. New evidence can change the CONTENTS of whichever window its own openedAt
 * selects (see STAGE_SETTLEMENT_MS for the quarantine that bounds this, and its documented backfill
 * limitation), but never the boundaries.
 */
export interface VariantMatrixStageCut {
  /** Schema version. Anything not === 2 on disk is dropped and treated as "no cut" (fail closed
   *  into a clean refreeze) rather than loaded into NaN comparisons. */
  v: 2;
  /** Exclusive upper bound of the development window. */
  devEndMs: number;
  /** Exclusive upper bound of the holdout window. `null` ONLY for PROMOTION (open-ended). */
  holdoutEndMs: number | null;
  frozenAt: string;
  /** Diagnostics captured at the freeze instant. NEVER read by any gate — they exist so an operator
   *  can see what the window looked like when it locked, not to be re-scored. */
  devRowsAtFreeze: number;
  devEffectiveNAtFreeze: number;
  holdoutRowsAtFreeze: number;
  holdoutEffectiveNAtFreeze: number;
}

/** Both stage windows for one proof unit. Either may be absent; `promotion` is never present
 *  without `stable`. */
export interface VariantMatrixStageCuts {
  stable?: VariantMatrixStageCut;
  promotion?: VariantMatrixStageCut;
}

// ---------------------------------------------------------------------------
// Store (mirrors the proven ParallelShadowExperimentStore pattern). Isolated
// JSON file; load/save swallow all errors so report-only never breaks the app.
// ---------------------------------------------------------------------------
interface VariantMatrixStoreState {
  observations: CurrentGuardVariantMatrixObservation[];
  resolverMeta?: VariantMatrixResolverMeta;
  /**
   * Point 4. Keyed by the caller (`${variantId}::${context}` for context rows,
   * `${variantId}::__aggregate__` for the lane-level aggregate row). Add-only, per (key, stage).
   *
   * MIGRATION — this is a NEW top-level key, deliberately, replacing `developmentHoldoutCuts`.
   * Reusing the old key with a new value shape would have been a landmine: `_load` does a blind
   * cast with no validation, so legacy `{cutMs, frozenAt, freshCountAtFreeze}` records would have
   * loaded as truthy objects with `devEndMs === undefined`, a truthiness-guarded freeze writer
   * would then no-op forever, and `rows.filter(r => t(r) < undefined)` returns an EMPTY dev slice —
   * a silent zeroing, not a visible error. With a new key an old file simply lacks it, `?? {}`
   * yields an empty map, and every lane freezes a fresh, correct stage window on the next build.
   *
   * `developmentHoldoutCuts` is no longer read OR written. Because flush() rebuilds this state from
   * the store's internal fields, the legacy key disappears from disk on the first save after
   * upgrade. That is intentional and irreversible: the legacy cut IS the frozen-at-14-rows artifact
   * being deleted, and preserving it would only risk something reading it later.
   */
  stageCuts?: Record<string, VariantMatrixStageCuts>;
}

/** Accepts a stage cut off disk only when it is structurally sound. Anything else (legacy shape,
 *  future version, corrupt numbers) is DROPPED and treated as "no cut" — fail closed into a clean
 *  refreeze rather than into NaN comparisons or an un-refreezable record. */
function isValidStageCut(value: unknown): value is VariantMatrixStageCut {
  if (!value || typeof value !== "object") return false;
  const cut = value as Partial<VariantMatrixStageCut>;
  if (cut.v !== 2) return false;
  if (typeof cut.devEndMs !== "number" || !Number.isFinite(cut.devEndMs)) return false;
  if (cut.holdoutEndMs !== null) {
    if (typeof cut.holdoutEndMs !== "number" || !Number.isFinite(cut.holdoutEndMs)) return false;
    if (cut.holdoutEndMs <= cut.devEndMs) return false;
  }
  return typeof cut.frozenAt === "string";
}

function sanitizeStageCuts(raw: unknown): Record<string, VariantMatrixStageCuts> {
  const out: Record<string, VariantMatrixStageCuts> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const cuts = value as Record<string, unknown>;
    const stable = isValidStageCut(cuts.stable) ? (cuts.stable as VariantMatrixStageCut) : undefined;
    // A promotion window is meaningless without the stable window it must sit after, and a
    // promotion cut that starts before stable's holdout ends would break the disjointness the whole
    // design rests on. Drop it rather than honour it.
    const promotionCandidate = isValidStageCut(cuts.promotion) ? (cuts.promotion as VariantMatrixStageCut) : undefined;
    const promotion =
      stable && promotionCandidate && promotionCandidate.devEndMs >= (stable.holdoutEndMs ?? Number.POSITIVE_INFINITY)
        ? promotionCandidate
        : undefined;
    if (!stable && !promotion) continue;
    const entry: VariantMatrixStageCuts = {};
    if (stable) entry.stable = stable;
    if (promotion) entry.promotion = promotion;
    out[key] = entry;
  }
  return out;
}

function observationKey(sourceObservationKey: string, variantId: string): string {
  return `${sourceObservationKey}::${variantId}`;
}

/**
 * The variant matrix's OPEN observations in the four-brain's fresh-signal shape (2026-07-28).
 *
 * WHY THIS EXISTS. Entry Brain Tier 1 had resolved 0 of 1,664 decisions and could never resolve
 * one, because the four-brain evaluated a lane set that shares NOTHING with the lane set that
 * actually opens positions:
 *
 *   evaluated  : COMPOSITE_ESTIMATOR_BIDI_* , INTRADAY_MOMENTUM_BREAKOUT_LONG ,
 *                REGIME_COMPOSITE_CONFIRMATION_LONG/SHORT   (CE and IM have never traded at all)
 *   executed   : all 309 closed position paths are CG_VARIANT_MATRIX:* / CG_LONG_VARIANT_MATRIX:*
 *   intersection: EMPTY
 *
 * Every one of the 1,664 rejections was NO_EXACT_LANE_SYMBOL_SIDE_CLOSE — not a TTL, not an
 * identity mismatch, not a competing decision. The two halves of the measurement were simply
 * looking at different universes, so waiting could never fill that column.
 *
 * NAMESPACE: emit the BARE variantId. The Tier-1 matcher's own join key is
 * `normalizeEntryTier1LaneNamespace(laneId)::SYMBOL::SIDE`, and that function strips exactly the
 * `CG_VARIANT_MATRIX:` / `CG_LONG_VARIANT_MATRIX:` prefixes — its doc comment names this pair as
 * the example it exists for. So a bare id joins to BOTH namespaces, which is what we want: the
 * same variantId legitimately appears in both (12 of them do), and the observation itself does not
 * record which writer will pick it up.
 *
 * BOUNDED on purpose: the store holds ~3,254 OPEN rows, while the sibling lane accessors return a
 * handful. Feeding all of them into every five-minute tick would change the four-brain's cost
 * profile, so this returns the freshest `cap` within `maxAgeMs`. The default window matches the
 * consumer's own maxSignalAgeMs (50 min) with headroom, because a decision older than that can
 * never own a close anyway.
 */
export function variantMatrixOpenSignals(
  store: CurrentGuardVariantMatrixStore,
  opts: { nowMs?: number; maxAgeMs?: number; cap?: number } = {},
): Array<{
  laneId: string;
  symbol: string;
  direction: Direction;
  observationId: string;
  openedAtMs: number;
  entryPrice: number;
  stopPrice: number;
}> {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60_000;
  const cap = Math.max(1, opts.cap ?? 400);
  const out: Array<{
    laneId: string;
    symbol: string;
    direction: Direction;
    observationId: string;
    openedAtMs: number;
    entryPrice: number;
    stopPrice: number;
  }> = [];
  for (const o of store.all) {
    if (o.status !== "OPEN") continue;
    const openedAtMs = Date.parse(o.openedAt);
    if (!Number.isFinite(openedAtMs) || nowMs - openedAtMs > maxAgeMs) continue;
    const entryPrice = o.simulatedEntryPrice;
    const stopPrice = o.simulatedStopLoss;
    // Never fabricate geometry: a row without a usable entry/stop is skipped, not defaulted.
    if (!(entryPrice > 0) || !(stopPrice > 0)) continue;
    out.push({
      laneId: o.variantId,
      symbol: o.symbol,
      direction: o.direction,
      observationId: o.observationId,
      openedAtMs,
      entryPrice,
      stopPrice,
    });
  }
  out.sort((a, b) => b.openedAtMs - a.openedAtMs);
  return out.slice(0, cap);
}

export class CurrentGuardVariantMatrixStore {
  private readonly file: string;
  private observations: CurrentGuardVariantMatrixObservation[];
  private resolverMetaInternal: VariantMatrixResolverMeta | null;
  // Point 4: add-only stage proof windows, keyed per proof unit then per stage. Never mutated in
  // place once a (key, stage) exists — freezeStageCutIfAbsent() is the only writer and it no-ops on
  // an existing stage.
  private stageCutsInternal: Record<string, VariantMatrixStageCuts>;
  // O(1) duplicate check for hasObservation(), maintained alongside `observations`. Before this,
  // hasObservation() did a `.some()` linear scan over the WHOLE array — fine at hundreds of obs, but
  // mirrorVariantMatrixSignals calls it once per candidate observation, and once the store grew past
  // ~80k (the fresh-VM-feed's higher ingestion rate), a single mirror cycle could do tens of millions
  // of comparisons synchronously — long enough to starve the event loop's timer queue and make an
  // `await Promise.race([x, timeout(8000)])` a few lines later actually take 200+ seconds, because the
  // 8s setTimeout callback itself couldn't fire until the synchronous scan finished. (Observed: every
  // operator-brief?resolve=1 cycle on / (3101) hanging 190-235s and getting aborted.)
  private observationKeySet: Set<string>;
  // Defers save() to a single flush on endBatch() — same fix already applied to
  // PaperExecutionRouterStore (paper-execution-router.ts). resolveVariantMatrixObservations() calls
  // bulkUpdate() (expiry sweep), pruneExpired(), pruneTerminal(), bulkUpdate() again (resolutions), and
  // setResolverMeta() — up to 5 independent full-array JSON.stringify + writeFileSync passes in ONE
  // resolver run, even though each individual call was already collapsed from O(n) per-observation to
  // O(1) per-phase. On a store that has reached 129k+ observations / ~200MB in production (see
  // buildCurrentGuardVariantMatrixReport's own doc comment on this exact store), 5 sequential full
  // rewrites of that size is what actually starved operator-brief?resolve=1 for 90-190+s per cycle
  // (`ps` showed low CPU% during the freeze, consistent with synchronous disk I/O wait, not a CPU-bound
  // loop) — every OTHER concurrent request hung too, since writeFileSync blocks the whole single-threaded
  // event loop. Wrapping the resolver's body in beginBatch()/endBatch() collapses this to ONE flush.
  private batchDepth = 0;
  private dirtyDuringBatch = false;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "current-guard-variant-matrix.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    const loaded = this._load();
    this.observations = loaded.observations;
    this.resolverMetaInternal = loaded.resolverMeta ?? null;
    this.stageCutsInternal = loaded.stageCuts ?? {};
    this.observationKeySet = new Set(
      this.observations.map((obs) => observationKey(obs.sourceObservationKey, obs.variantId)),
    );
  }

  get path(): string {
    return this.file;
  }

  get all(): CurrentGuardVariantMatrixObservation[] {
    return this.observations;
  }

  getResolverMeta(): VariantMatrixResolverMeta | null {
    return this.resolverMetaInternal;
  }

  setResolverMeta(meta: VariantMatrixResolverMeta): void {
    this.resolverMetaInternal = meta;
    this.save();
  }

  /**
   * Point 4. Read-only lookup — an empty object when nothing has been frozen yet for this key.
   *
   * Returns a DEEP-FROZEN CLONE, never the live object. The predecessor (getHoldoutCut) handed out
   * the internal record by reference, so any caller could have mutated a "frozen" boundary in place
   * and nothing would have noticed. An immutable window that a reader can edit is not immutable.
   */
  getStageCuts(key: string): Readonly<VariantMatrixStageCuts> {
    const stored = this.stageCutsInternal[key];
    const clone: VariantMatrixStageCuts = {};
    if (stored?.stable) clone.stable = Object.freeze({ ...stored.stable });
    if (stored?.promotion) clone.promotion = Object.freeze({ ...stored.promotion });
    return Object.freeze(clone);
  }

  /**
   * Point 4. Add-only per (key, stage): freezes `cut` the FIRST time this is called for that pair,
   * and is a strict no-op on every subsequent call — this is the entire mechanism that makes a
   * stage's proof window immutable. Any future caller tempted to "refresh" a window must not: doing
   * so would let newer, possibly cherry-picked data retroactively redraw a boundary, exactly what
   * the split exists to prevent.
   *
   * The presence test is `hasOwnProperty`, NOT truthiness. The predecessor used truthiness, which
   * is the landmine that would have made any legacy/undefined-ish record permanently
   * un-refreezable: a record that is present-but-unusable would have blocked the write forever
   * while every downstream slice silently evaluated empty.
   */
  freezeStageCutIfAbsent(key: string, stage: VariantMatrixProofStage, cut: VariantMatrixStageCut): void {
    const existing = this.stageCutsInternal[key] ?? {};
    if (Object.prototype.hasOwnProperty.call(existing, stage)) return; // immutable — never overwrite
    this.stageCutsInternal[key] = { ...existing, [stage]: cut };
    this.save();
  }

  private _load(): VariantMatrixStoreState {
    try {
      if (!existsSync(this.file)) return { observations: [] };
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (Array.isArray(parsed)) {
        return { observations: parsed as CurrentGuardVariantMatrixObservation[] };
      }
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { observations?: unknown }).observations)) {
        const state = parsed as VariantMatrixStoreState;
        return {
          observations: state.observations,
          resolverMeta: state.resolverMeta,
          // Validated, not blind-cast (unlike observations/resolverMeta above, which predate this).
          // A file written by an older build carries `developmentHoldoutCuts` and NO `stageCuts`;
          // that key is deliberately not read here, so such a lane starts from no cut and freezes a
          // fresh, correct stage window on the next report build.
          stageCuts: sanitizeStageCuts((parsed as { stageCuts?: unknown }).stageCuts),
        };
      }
      return { observations: [] };
    } catch {
      return { observations: [] };
    }
  }

  /** Start deferring save() to a single flush on the matching endBatch(). Nestable (paired calls only
   *  flush once the outermost endBatch() runs) — mirrors PaperExecutionRouterStore's beginBatch(). */
  beginBatch(): void {
    this.batchDepth += 1;
  }

  endBatch(): void {
    if (this.batchDepth > 0) this.batchDepth -= 1;
    if (this.batchDepth === 0 && this.dirtyDuringBatch) {
      this.dirtyDuringBatch = false;
      this.flush();
    }
  }

  save(): void {
    if (this.batchDepth > 0) {
      this.dirtyDuringBatch = true;
      return;
    }
    this.flush();
  }

  private flush(): void {
    try {
      for (const observation of this.observations) stampObservationAxis(observation);
      const state: VariantMatrixStoreState = { observations: this.observations };
      if (this.resolverMetaInternal) state.resolverMeta = this.resolverMetaInternal;
      if (Object.keys(this.stageCutsInternal).length > 0) {
        state.stageCuts = this.stageCutsInternal;
      }
      writeJsonAtomic(this.file, state);
    } catch {
      // report-only storage failures must never affect the app
    }
  }

  add(observation: CurrentGuardVariantMatrixObservation): void {
    this.observations.push(observation);
    this.observationKeySet.add(observationKey(observation.sourceObservationKey, observation.variantId));
    this.save();
  }

  addMany(observations: CurrentGuardVariantMatrixObservation[]): void {
    if (observations.length === 0) return;
    this.observations.push(...observations);
    for (const obs of observations) {
      this.observationKeySet.add(observationKey(obs.sourceObservationKey, obs.variantId));
    }
    this.save();
  }

  update(observationId: string, patch: Partial<CurrentGuardVariantMatrixObservation>): void {
    const idx = this.observations.findIndex((obs) => obs.observationId === observationId);
    if (idx < 0) return;
    this.observations[idx] = {
      ...this.observations[idx]!,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.save();
  }

  /** Apply many patches in-memory and persist ONCE. The resolver uses this to drain the
   *  expiry backlog (hundreds–thousands of stale OPEN obs) in a single save instead of one
   *  O(n) file write per observation — the per-update save was the bottleneck that let the
   *  expiry backlog starve every resolvable observation behind it. */
  bulkUpdate(updates: Array<{ observationId: string; patch: Partial<CurrentGuardVariantMatrixObservation> }>): void {
    if (updates.length === 0) return;
    const indexById = new Map<string, number>();
    this.observations.forEach((obs, i) => indexById.set(obs.observationId, i));
    const ts = new Date().toISOString();
    let touched = 0;
    for (const { observationId, patch } of updates) {
      const idx = indexById.get(observationId);
      if (idx === undefined) continue;
      this.observations[idx] = { ...this.observations[idx]!, ...patch, updatedAt: patch.updatedAt ?? ts };
      touched += 1;
    }
    if (touched > 0) this.save();
  }

  hasObservation(sourceObservationKey: string, variantId: VariantMatrixVariantId): boolean {
    return this.observationKeySet.has(observationKey(sourceObservationKey, variantId));
  }

  /** Bound memory: EXPIRED observations only feed the diagnostic `expired` COUNT — never
   *  freshValid/net/PF/OOS/drawdown/promotion. Keep the newest `maxExpired` for the count display
   *  and drop the rest (zero measurement impact). The born-stale mirror gate prevents pruned
   *  EXPIRED from re-appearing (their signals are openedAt>EXPIRY → skipped at mirror), so this
   *  one-time clears the churn backlog AND bounds the store going forward. Returns count pruned. */
  pruneExpired(maxExpired: number): number {
    const expired = this.observations.filter((obs) => obs.status === "EXPIRED");
    if (expired.length <= maxExpired) return 0;
    const tsOf = (o: CurrentGuardVariantMatrixObservation) =>
      toMs(o.resolvedAt) ?? toMs(o.updatedAt) ?? toMs(o.createdAt) ?? 0;
    const keep = new Set(
      expired.sort((a, b) => tsOf(b) - tsOf(a)).slice(0, maxExpired).map((o) => o.observationId),
    );
    const before = this.observations.length;
    const dropped: CurrentGuardVariantMatrixObservation[] = [];
    this.observations = this.observations.filter((obs) => {
      const keepIt = obs.status !== "EXPIRED" || keep.has(obs.observationId);
      if (!keepIt) dropped.push(obs);
      return keepIt;
    });
    for (const obs of dropped) {
      this.observationKeySet.delete(observationKey(obs.sourceObservationKey, obs.variantId));
    }
    const pruned = before - this.observations.length;
    if (pruned > 0) this.save();
    return pruned;
  }

  /** Same bound-memory purpose as pruneExpired, but for the terminal statuses that DO feed real
   *  measurement — so dropped records are archived (see archiveDropped), never discarded. Keeps
   *  the newest `maxPerStatus` of each status in VM_PRUNABLE_TERMINAL_STATUSES independently.
   *  OPEN and EXPIRED are untouched (EXPIRED has its own cap via pruneExpired; OPEN must never
   *  be dropped while still live). Returns count pruned. */
  pruneTerminal(maxPerStatus: number): number {
    const tsOf = (o: CurrentGuardVariantMatrixObservation) =>
      toMs(o.resolvedAt) ?? toMs(o.updatedAt) ?? toMs(o.createdAt) ?? 0;
    const keepIds = new Set<string>();
    for (const status of VM_PRUNABLE_TERMINAL_STATUSES) {
      const ofStatus = this.observations.filter((obs) => obs.status === status);
      const kept = ofStatus.length <= maxPerStatus
        ? ofStatus
        : ofStatus.sort((a, b) => tsOf(b) - tsOf(a)).slice(0, maxPerStatus);
      for (const obs of kept) keepIds.add(obs.observationId);
    }
    const before = this.observations.length;
    const dropped: CurrentGuardVariantMatrixObservation[] = [];
    this.observations = this.observations.filter((obs) => {
      const prunable = VM_PRUNABLE_TERMINAL_STATUSES.includes(obs.status);
      const keepIt = !prunable || keepIds.has(obs.observationId);
      if (!keepIt) dropped.push(obs);
      return keepIt;
    });
    for (const obs of dropped) {
      this.observationKeySet.delete(observationKey(obs.sourceObservationKey, obs.variantId));
    }
    const pruned = before - this.observations.length;
    if (pruned > 0) {
      this.archiveDropped(dropped);
      this.save();
    }
    return pruned;
  }

  /** Best-effort append-only archive for pruneTerminal's dropped records — never loaded back
   *  into memory during normal operation, so its own size never contributes to the OOM risk
   *  this whole mechanism exists to bound. Archiving failure must never block the prune it
   *  guards (losing the archive write is far better than an unbounded live store). */
  private archiveDropped(dropped: CurrentGuardVariantMatrixObservation[]): void {
    if (dropped.length === 0) return;
    try {
      const archiveFile = this.file.replace(/\.json$/, "-archive.jsonl");
      const lines = dropped.map((obs) => JSON.stringify(obs)).join("\n") + "\n";
      appendFileSync(archiveFile, lines, "utf-8");
      // 2026-07-12 fix: this file grows forever (every prune cycle appends, nothing ever trims it) —
      // "never loaded back into memory" keeps it out of the OOM this mechanism guards against, but
      // it will still exhaust VPS disk indefinitely. Reuses the same rotation helper already applied
      // to every other unbounded JSONL log this session (decision-ledger.ts etc.).
      const thresholdBytes = Number(process.env.VM_ARCHIVE_ROTATION_THRESHOLD_BYTES) || 25 * 1024 * 1024;
      const tailLines = Number(process.env.VM_ARCHIVE_ROTATION_TAIL_LINES) || 10_000;
      const result = rotateJsonlIfNeeded(archiveFile, { thresholdBytes, tailLines });
      if (result.rotated) {
        console.warn(
          `[current-guard-variant-matrix] rotated ${archiveFile}: archived ${result.fromSize ?? "?"} bytes → ${result.archivePath ?? "?"}; kept ${result.linesKept ?? 0} lines`,
        );
      }
    } catch {
      // best-effort: archiving must never block the live-store prune
    }
  }
}

let singleton: CurrentGuardVariantMatrixStore | null = null;

export function getCurrentGuardVariantMatrixStore(dataDir = "data"): CurrentGuardVariantMatrixStore {
  if (!singleton) singleton = new CurrentGuardVariantMatrixStore(dataDir);
  return singleton;
}

export function _resetCurrentGuardVariantMatrixStoreForTests(): void {
  singleton = null;
}

// ---------------------------------------------------------------------------
// Source population selection (matches the F****** post-cutover population).
// ---------------------------------------------------------------------------
function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function stopDistanceBpsOf(direction: Direction, entry: number, stop: number): number | null {
  if (!(entry > 0) || !(stop > 0)) return null;
  const dist = direction === "LONG" ? entry - stop : stop - entry;
  if (!(dist > 0)) return null;
  return (dist / entry) * 10000;
}

/**
 * Selects the qualifying current-guard signals to mirror. Same selection as the
 * post-cutover lane: current-guard generation (stop175 + anchor-consistent V2),
 * a closed+filled variant with finite realized R, and — when a cutover boundary
 * is supplied — only signals whose closedAt is strictly after the boundary.
 * Report-only; never throws.
 */
export function selectVariantMatrixSignals(
  positions: ShadowPosition[],
  cutoverTimestamp?: string | null,
): VariantMatrixSignal[] {
  const out: VariantMatrixSignal[] = [];
  const cutoverMs = cutoverTimestamp ? toMs(cutoverTimestamp) : null;
  try {
    for (const position of positions) {
      if (position.riskHygieneGuardMinStopDistanceBps !== MIN_ADMISSION_STOP_DISTANCE_BPS_EXPORT) continue;
      if (position.policyVersion !== BASE_ROUTE_POLICY_VERSION_V2) continue;
      const entry = position.entryPrice;
      const stop = position.stopLoss;
      const tp1 = position.tp1;
      if (!(typeof entry === "number" && entry > 0)) continue;
      if (!(typeof stop === "number" && stop > 0)) continue;
      if (!(typeof tp1 === "number" && tp1 > 0)) continue;
      const direction: Direction = position.direction === "SHORT" ? "SHORT" : "LONG";

      // Use the first closed+filled variant with finite realized R (mirrors the
      // post-cutover close-selection logic) to date the signal.
      let openedAt: string | null = null;
      let closedAt: string | null = null;
      for (const variant of position.variants ?? []) {
        if (variant.state !== "CLOSED" || variant.closeReason === "NO_FILL") continue;
        if (typeof variant.realizedGrossR !== "number" || typeof variant.realizedNetR !== "number") continue;
        openedAt = variant.openedAt ?? position.scannedAt ?? null;
        closedAt = variant.closedAt ?? variant.lastUpdatedAt ?? openedAt;
        break;
      }
      if (!openedAt) continue;

      const closedMs = toMs(closedAt);
      if (cutoverMs !== null) {
        if (closedMs === null || closedMs <= cutoverMs) continue; // strict post-cutover
      }

      out.push({
        sourceSignalId: position.id,
        symbol: position.symbol,
        direction,
        entryPrice: entry,
        stopLoss: stop,
        tp1,
        tp2: typeof position.tp2 === "number" ? position.tp2 : null,
        tp3: typeof position.tp3 === "number" ? position.tp3 : null,
        stopDistanceBps:
          typeof position.stopDistanceBps === "number"
            ? position.stopDistanceBps
            : stopDistanceBpsOf(direction, entry, stop),
        regime: position.marketRegime ?? position.marketRegimeAtOpen ?? null,
        entryVariant: position.selectedEntryVariant ?? null,
        openedAt,
        closedAt,
      });
    }
  } catch {
    // report-only; never break the caller
  }
  return out;
}

// ---------------------------------------------------------------------------
// Variant geometry derivation.
// ---------------------------------------------------------------------------
interface DerivedGeometry {
  kind: "ok";
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  stopDistanceBps: number;
  costR: number;
}
interface RejectedGeometry {
  kind: "rejected";
}
interface FailedGeometry {
  kind: "failed";
}
type GeometryResult = DerivedGeometry | RejectedGeometry | FailedGeometry;

function computeVariantCostR(roundTripBps: number, stopDistanceBps: number): number {
  // cost-in-R = (round-trip cost in bps) / (stop distance in bps).
  if (!(stopDistanceBps > 0)) return 0;
  return roundTripBps / stopDistanceBps;
}

function variantRoundTripBps(def: VariantMatrixVariantDefinition): number {
  return def.costModel === "maker_limit" ? MAKER_ROUNDTRIP_BPS : TAKER_ROUNDTRIP_BPS;
}

function experimentalLeverageDivisor(def: VariantMatrixVariantDefinition): number {
  const leverage = def.experimentalOnly ? def.experimentalLeverage : null;
  return typeof leverage === "number" && Number.isFinite(leverage) && leverage > 1 ? leverage : 1;
}

export function effectiveMfeGivebackArmR(
  def: VariantMatrixVariantDefinition,
  stopDistanceBps: number,
): number {
  if (def.exitRule !== "mfe_giveback") return MFE_GIVEBACK_ARM_R;
  const divisor = experimentalLeverageDivisor(def);
  if (divisor <= 1) return MFE_GIVEBACK_ARM_R;
  const stopExitCostR = computeVariantCostR(variantRoundTripBps(def) + STOP_OUT_SLIPPAGE_BPS, stopDistanceBps);
  const minNetPositiveArmR = (stopExitCostR + EXPERIMENTAL_TP_NET_BUFFER_R) / Math.max(1 - MFE_GIVEBACK_FRAC, 0.01);
  return Math.max(MFE_GIVEBACK_ARM_R / divisor, minNetPositiveArmR);
}

export function effectiveVariantTpRewardMultiple(
  def: VariantMatrixVariantDefinition,
  stopDistanceBps: number,
): number {
  const base = def.tpRewardMultiple ?? 1.0;
  const divisor = experimentalLeverageDivisor(def);
  if (divisor <= 1) return base;
  const leveragedTarget = base / divisor;
  const tpCostFloorR = computeVariantCostR(variantRoundTripBps(def), stopDistanceBps) + EXPERIMENTAL_TP_NET_BUFFER_R;
  if (def.exitRule !== "mfe_giveback") return Math.max(leveragedTarget, tpCostFloorR);
  // MFE giveback exits fire on a retrace and pay stop-like slippage. Keep the TP cap above
  // the arm level so the giveback path still has room to work after leverage compression.
  const minMfeCapR = effectiveMfeGivebackArmR(def, stopDistanceBps) * 1.5;
  return Math.max(leveragedTarget, tpCostFloorR, minMfeCapR);
}

export function deriveVariantGeometry(
  signal: VariantMatrixSignal,
  def: VariantMatrixVariantDefinition,
): GeometryResult {
  const dir = signal.direction;
  const E = signal.entryPrice;
  const S = signal.stopLoss;
  const T1 = signal.tp1;
  if (!(E > 0) || !(S > 0) || !(T1 > 0)) return { kind: "failed" };

  const baselineRisk = dir === "LONG" ? E - S : S - E;
  if (!(baselineRisk > 0)) return { kind: "failed" };
  const baselineStopBps = (baselineRisk / E) * 10000;

  const roundTripBps = variantRoundTripBps(def);

  if (def.id === "CG_NO_FIB500_ENTRYSET" && signal.entryVariant === "fib_500_entry") {
    return { kind: "rejected" };
  }

  // Long-only research lanes never derive on SHORT signals.
  if (def.longOnly && dir !== "LONG") {
    return { kind: "rejected" };
  }
  // Short-only lanes never derive on LONG signals.
  if (def.shortOnly && dir !== "SHORT") {
    return { kind: "rejected" };
  }

  const usesWidePaperGeometry =
    def.id === "CG_WIDE_STOP_TP_WIDE" ||
    def.id === "CG_TRAIL_AFTER_TP1" ||
    def.stopFloorBps != null;
  if (usesWidePaperGeometry) {
    // Widen the stop to at least the floor, and place the paired TP at `tpRewardMultiple`× the
    // (floored) risk so exit behavior is compared on fair geometry. CG_WIDE/CG_TRAIL default to
    // the 300bps floor and a 1.0R target; LG_* lanes parameterize both knobs. Never widen the
    // stop without widening the paired target.
    const stopFloorBps = def.stopFloorBps ?? WIDE_STOP_MIN_BPS;
    const targetStopBps = Math.max(baselineStopBps, stopFloorBps);
    const tpRewardMultiple = effectiveVariantTpRewardMultiple(def, targetStopBps);
    const widenedStop = dir === "LONG" ? E * (1 - targetStopBps / 10000) : E * (1 + targetStopBps / 10000);
    const widenedRisk = dir === "LONG" ? E - widenedStop : widenedStop - E;
    if (!(widenedRisk > 0)) return { kind: "failed" };
    const widenedTarget =
      dir === "LONG" ? E + tpRewardMultiple * widenedRisk : E - tpRewardMultiple * widenedRisk;
    if (!(widenedTarget > 0)) return { kind: "failed" };
    return {
      kind: "ok",
      entryPrice: E,
      stopLoss: widenedStop,
      takeProfitLevels: [widenedTarget],
      stopDistanceBps: targetStopBps,
      costR: computeVariantCostR(roundTripBps, targetStopBps),
    };
  }

  // Remaining variants keep the original entry/stop/tp1 geometry; only the
  // exit rule, fill mode and cost basis differ.
  return {
    kind: "ok",
    entryPrice: E,
    stopLoss: S,
    takeProfitLevels: [T1],
    stopDistanceBps: baselineStopBps,
    costR: computeVariantCostR(roundTripBps, baselineStopBps),
  };
}

let observationSeq = 0;
function makeObservationId(symbol: string, variantId: VariantMatrixVariantId): string {
  observationSeq += 1;
  return `${symbol}-${variantId}-${Date.now()}-${observationSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildVariantMatrixObservationsForSignal(
  signal: VariantMatrixSignal,
  nowIso = new Date().toISOString(),
): CurrentGuardVariantMatrixObservation[] {
  const key = `${signal.symbol}|${signal.direction}|${signal.openedAt}`;
  const originalTps = [signal.tp1, signal.tp2, signal.tp3].filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  // Entry freshness is decided HERE, at creation (now − entry time), not hardcoded at resolution.
  const openedMs = toMs(signal.openedAt);
  const createdMs = toMs(nowIso);
  const entryLagMinutes =
    openedMs != null && createdMs != null ? Math.max(0, Math.round((createdMs - openedMs) / 60000)) : null;
  const isFreshValid = entryLagMinutes != null ? entryLagMinutes <= FRESH_ENTRY_MAX_MINUTES : null;
  // Point 3b: exact-axis proof requires BOTH fresh-feed fields at CREATION time — never re-derived
  // later, never backfilled onto legacy rows (see the field's doc comment on the interface).
  const exactAxisProof = signal.posture != null && signal.regimeDirection != null;
  const observations: CurrentGuardVariantMatrixObservation[] = [];
  for (const def of VARIANT_MATRIX_DEFINITIONS) {
    const geo = deriveVariantGeometry(signal, def);
    const base = {
      observationId: makeObservationId(signal.symbol, def.id),
      variantId: def.id,
      variantVersion: CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION,
      sourceSignalId: signal.sourceSignalId,
      sourceObservationKey: key,
      symbol: signal.symbol,
      direction: signal.direction,
      regime: signal.regime,
      entryVariant: signal.entryVariant,
      createdAt: nowIso,
      openedAt: signal.openedAt,
      resolvedAt: null,
      originalEntryPrice: signal.entryPrice,
      originalStopLoss: signal.stopLoss,
      originalTakeProfitLevels: originalTps,
      exitRule: def.exitRule,
      fillMode: def.fillMode,
      costModel: def.costModel,
      grossR: null,
      netR: null,
      maxMfeR: null,
      minMaeR: null,
      durationMinutes: null,
      resolutionSource: null,
      intrabarResolutionStatus: null,
      entryLagMinutes,
      isFreshValid,
      posture: signal.posture ?? null,
      regimeDirection: signal.regimeDirection ?? null,
      crowdingState: signal.crowdingState ?? null,
      scanBatchId: signal.scanBatchId ?? null,
      // Forward support only — nothing produces marketEpisodeId today. Spread CONDITIONALLY so the
      // key is absent rather than `null` on the rows that will never carry one: this store has
      // reached ~200MB / 129k+ observations in production and a null-valued key on every row is
      // pure disk and JSON.parse cost for zero information.
      ...(signal.marketEpisodeId ? { marketEpisodeId: signal.marketEpisodeId } : {}),
      // 2026-08-05 evidence-integrity fix — see the field's own doc comment on the interface.
      // Unconditional (unlike marketEpisodeId above): this variant's max-hold width is always known
      // at creation time, for every row, so there is no "irrelevant" case to omit.
      openMaxHoldMs: variantMaxHoldMs(def.id),
      exactAxisProof,
      reportOnly: true as const,
      laneVersion: CURRENT_GUARD_VARIANT_MATRIX_LANE,
    };

    if (geo.kind === "rejected") {
      observations.push({
        ...base,
        simulatedEntryPrice: signal.entryPrice,
        simulatedStopLoss: signal.stopLoss,
        simulatedTakeProfitLevels: [signal.tp1],
        stopDistanceBps: signal.stopDistanceBps,
        costR: null,
        status: "REJECTED",
        resolutionSource: "ENTRY_FILTER_FIB500_EXCLUDED",
      });
      continue;
    }
    if (geo.kind === "failed") {
      observations.push({
        ...base,
        simulatedEntryPrice: signal.entryPrice,
        simulatedStopLoss: signal.stopLoss,
        simulatedTakeProfitLevels: [signal.tp1],
        stopDistanceBps: signal.stopDistanceBps,
        costR: null,
        status: "DATA_FAILURE",
        resolutionSource: "GEOMETRY_DERIVATION_FAILED",
      });
      continue;
    }

    observations.push({
      ...base,
      simulatedEntryPrice: geo.entryPrice,
      simulatedStopLoss: geo.stopLoss,
      simulatedTakeProfitLevels: geo.takeProfitLevels,
      stopDistanceBps: geo.stopDistanceBps,
      costR: geo.costR,
      status: "OPEN",
    });
  }
  return observations;
}

export function mirrorVariantMatrixSignals(
  signals: VariantMatrixSignal[],
  store: CurrentGuardVariantMatrixStore,
  nowIso = new Date().toISOString(),
): { mirrored: number; duplicates: number; skippedStale: number } {
  let mirrored = 0;
  let duplicates = 0;
  let skippedStale = 0;
  const nowMs = toMs(nowIso) ?? Date.now();
  const toAdd: CurrentGuardVariantMatrixObservation[] = [];
  for (const signal of signals) {
    // Skip BORN-STALE signals: a signal whose openedAt is already past EXPIRY_MS produces obs that
    // the resolver's Phase-1 sweep expires WITHOUT ever walking them (openedAt>EXPIRY → marked
    // EXPIRED, never resolved). Such obs never reach freshValid — they were pure churn (audit:
    // 6350 obs / ~1056/day, 100% of all expiries, ~53% of the store). Gating here yields zero
    // measurement loss (born-stale never counted) while shrinking the store, memory, and resolver
    // load. Recent signals (≤EXPIRY_MS) still mirror + resolve normally.
    const openedMs = toMs(signal.openedAt);
    if (openedMs !== null && nowMs - openedMs > EXPIRY_MS) {
      skippedStale += 1;
      continue;
    }
    const candidates = buildVariantMatrixObservationsForSignal(signal, nowIso);
    for (const obs of candidates) {
      if (store.hasObservation(obs.sourceObservationKey, obs.variantId)) {
        duplicates += 1;
        continue;
      }
      // also guard against duplicates within this same batch
      if (toAdd.some((o) => o.sourceObservationKey === obs.sourceObservationKey && o.variantId === obs.variantId)) {
        duplicates += 1;
        continue;
      }
      toAdd.push(obs);
      mirrored += 1;
    }
  }
  store.addMany(toAdd);
  return { mirrored, duplicates, skippedStale };
}

// ---------------------------------------------------------------------------
// Candle-walk resolution engine.
// ---------------------------------------------------------------------------
export type KlineTuple = [number, string, string, string, string, string, number, ...unknown[]];

export interface VariantMatrixBinanceClient {
  getKlines: (
    symbol: string,
    interval: string,
    opts: { startTime: number; endTime: number; limit: number },
  ) => Promise<KlineTuple[]>;
}

/** See paper-execution-router's equivalent: max-hold geometry may exceed the
 * venue's 1,000-candle page cap, so a single page must never stand in for the
 * requested market horizon. */
async function fetchVariantKlinesRange(
  client: VariantMatrixBinanceClient,
  symbol: string,
  startTime: number,
  endTime: number,
): Promise<KlineTuple[]> {
  const out: KlineTuple[] = [];
  const seen = new Set<number>();
  let cursor = startTime;
  let pages = 0;
  while (cursor < endTime && pages < 50) {
    pages += 1;
    const remaining = Math.ceil((endTime - cursor) / CANDLE_MS) + 2;
    const limit = Math.min(Math.max(remaining, 12), 1000);
    const page = await client.getKlines(symbol, "5m", { startTime: cursor, endTime, limit });
    if (!page.length) break;
    let lastOpen = Number.NaN;
    for (const candle of page) {
      const open = Number(candle[0]);
      if (!Number.isFinite(open)) continue;
      lastOpen = open;
      if (!seen.has(open)) {
        seen.add(open);
        out.push(candle);
      }
    }
    if (!Number.isFinite(lastOpen) || lastOpen < cursor) break;
    // A short page completes the requested range; do not keep polling a stale page.
    if (page.length < limit) break;
    const next = lastOpen + CANDLE_MS;
    if (next <= cursor) break;
    cursor = next;
  }
  return out.sort((a, b) => Number(a[0]) - Number(b[0]));
}

// ---------------------------------------------------------------------------
// OPT-IN per-candle R series (2026-07-26). PURELY ADDITIVE — see VariantWalkInput.collectRPath.
//
// WHY: exit-brain-shadow.ts can only score a trade whose recorded path carries >= minEvaluableTicks
// R observations. The only genuinely dense paths on disk are position-path-recorder.ts's REAL
// per-tick samples (live engine + single-symbol executors). This walk already reconstructs a full
// candle path for every paper/VM order but has only ever surfaced SUMMARY stats (maxMfeR/minMaeR/
// peakAtMs/grossR) from it. Collecting the series it already computes costs one array push per
// candle and unlocks a SECOND, explicitly-SIMULATED evidence tier.
//
// WHAT THE SERIES IS (and is not): ONE point per candle carrying the position's MARK-TO-MARKET R at
// that candle's close, with the candle's extremes as peakR/troughR refinements. It is NOT a stream
// of excursion statistics: an earlier draft emitted two points per candle (that candle's favorable
// and adverse EXCURSIONS, each clamped at 0 against entry), which guaranteed one ≤0 point per candle
// forever and made any arm-then-bank consumer round-trip-guard itself to ~0 on the very next candle.
// A clean +5R winner scored 0R under that shape. See VariantWalkResult.rPath for the full contract.
//
// HARD RULE (the reason this is opt-in rather than always-on): this module is REAL-MONEY-ADJACENT —
// VariantWalkResult feeds lane maturity (INSUFFICIENT→COLLECTING→WATCHABLE→STABLE_CANDIDATE) and
// STABLE_CANDIDATE is a REQUIRED gate for mainnet live eligibility (isPaperOrderLiveEligible). With
// collectRPath absent/false NOTHING changes: the `rPath` key is not even present on the returned
// object, so every existing field — and the object's own shape — is byte-identical to before.
// ---------------------------------------------------------------------------

/** One point of the opt-in per-candle R series — deliberately shaped so it is directly assignable to
 *  exit-brain-policy.ts's ExitBrainPathTick.
 *
 *  `currentR` is the position's MARK-TO-MARKET R at the candle's CLOSE, in the walk's OWN R unit
 *  ((close−E)/risk for LONG, (E−close)/risk for SHORT — the same `risk` denominator and the same
 *  direction convention maxMfeR/minMaeR use, never a second R definition). It is SIGNED and
 *  unclamped: a real unrealized-R path, not an excursion statistic.
 *
 *  `peakR`/`troughR` carry that candle's favorable/adverse EXTREMES (the very same mfeR/maeR the
 *  summary stats are built from). They are the ExitBrainPathTick fields the counterfactual evaluator
 *  already folds into its running peak/trough, so MFE/MAE information survives at one tick per candle
 *  WITHOUT fabricating an oscillation the position never experienced.
 *
 *  Raw/unrounded here; a persisting store may round (see paper-simulated-path-store.ts). */
export interface VariantRPathPoint {
  tsMs: number;
  currentR: number;
  /** This candle's favorable excursion in R (≥ 0). Omitted on the terminating tick of an INTRABAR
   *  exit — see VariantWalkResult.rPath's POST-EXIT rule. */
  peakR?: number;
  /** This candle's adverse excursion in R (≤ 0). */
  troughR?: number;
}

/** The running peak/trough a consumer folds a point into — mirrors evaluateExitBrainCounterfactual's
 *  own `Math.max(peak, currentR, peakR)` / `Math.min(trough, currentR, troughR)` exactly, so the
 *  thinner below preserves precisely what the evaluator would have seen. */
function rPathPointHigh(p: VariantRPathPoint): number {
  return typeof p.peakR === "number" && Number.isFinite(p.peakR) ? Math.max(p.currentR, p.peakR) : p.currentR;
}
function rPathPointLow(p: VariantRPathPoint): number {
  return typeof p.troughR === "number" && Number.isFinite(p.troughR) ? Math.min(p.currentR, p.troughR) : p.currentR;
}

/** Hard cap on the returned series length (mirrors position-path-recorder.ts's
 *  MAX_TICKS_PER_POSITION=600 bounds idiom). Overridable per call via VariantWalkInput.rPathMaxPoints
 *  for tests/sweeps; never unbounded. */
export const VARIANT_R_PATH_MAX_POINTS = 600;
/** Floor for a caller-supplied rPathMaxPoints — the thinner must always be able to retain
 *  {first, last, argmax, argmin}, which is what keeps the thinned series folding to the same running
 *  peak/trough as the full one. */
export const VARIANT_R_PATH_MIN_CAP = 4;

/**
 * Downsamples an R series to at most `cap` points while ALWAYS retaining the first point, the last
 * point, the global maximum and the global minimum, in original chronological order.
 *
 * That retention rule is not cosmetic — it is what makes the thinned series preserve the running
 * peak/trough a consumer would have folded out of the FULL series: argmax/argmin are taken over
 * max(currentR, peakR) / min(currentR, troughR) (exactly what evaluateExitBrainCounterfactual folds),
 * so the extreme survives any number of thinning passes even when it lives in a point's peakR/troughR
 * refinement rather than its currentR. Everything else is an even stride, so a long hold keeps a
 * uniformly-sampled shape rather than a truncated head or tail.
 *
 * Deliberately a LOCAL helper rather than an import of position-path-recorder.ts's thinOlderHalf:
 * (a) that thinner optimizes for "recent retraces matter most" on a live-growing buffer and does
 * NOT preserve extremes, which would break the invariant above; (b) this file is real-money-adjacent
 * and gains no new module dependency. Pure; exported for tests.
 */
export function thinRPathPreservingExtremes(points: VariantRPathPoint[], cap: number): VariantRPathPoint[] {
  if (!Array.isArray(points)) return [];
  const keepCap = Math.max(VARIANT_R_PATH_MIN_CAP, Math.floor(Number.isFinite(cap) ? cap : VARIANT_R_PATH_MAX_POINTS));
  const n = points.length;
  if (n <= keepCap) return points;
  let maxIdx = 0;
  let minIdx = 0;
  for (let i = 1; i < n; i += 1) {
    if (rPathPointHigh(points[i]!) > rPathPointHigh(points[maxIdx]!)) maxIdx = i;
    if (rPathPointLow(points[i]!) < rPathPointLow(points[minIdx]!)) minIdx = i;
  }
  const keep = new Set<number>([0, n - 1, maxIdx, minIdx]);
  const budget = keepCap - keep.size;
  if (budget > 0) {
    const stride = n / (budget + 1);
    for (let k = 1; k <= budget; k += 1) keep.add(Math.min(n - 1, Math.round(k * stride)));
  }
  const out: VariantRPathPoint[] = [];
  for (let i = 0; i < n; i += 1) if (keep.has(i)) out.push(points[i]!);
  return out;
}

export interface VariantWalkInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  target: number;
  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  openedAtMs: number;
  candles: KlineTuple[];
  makerFillWindowCandles?: number;
  mfeGivebackArmR?: number;
  mfeGivebackFrac?: number;
  /** atr_trail only: Wilder ATR period used to build the trailing series (default ATR_TRAIL_PERIOD). */
  atrPeriod?: number;
  /** atr_trail only: stop = close ∓ atrMultiple×ATR once armed (default ATR_TRAIL_MULTIPLE). */
  atrMultiple?: number;
  /** atr_trail only: favorable-R the trade must have peaked at (prior candle) before the stop starts
   *  ratcheting; stays armed forever after (default ATR_TRAIL_ARM_R). */
  atrTrailArmR?: number;
  /** production_breakeven_control only: single blended round-trip cost estimate (fee+slippage,
   *  both legs) as a fraction of notional — mirrors live-execution-engine.ts's
   *  estimatedCloseCostPct (default PRODUCTION_BREAKEVEN_CONTROL_COST_PCT = 0.0022 = 22bps).
   *  Overridable per-call for tests/sweeps. */
  productionBreakevenCostPct?: number;
  /** production_breakeven_control only, OPTIONAL diagnostic: the position's own close quantity
   *  (pre-rounding), paired with productionBreakevenQtyStepSize below to demonstrate the exact
   *  exchange floor-to-stepSize rounding real close orders go through. Per investigation, this
   *  rounding never changes the fired decision or the close price in production (a MARKET close
   *  has no price to round) — supplying these two fields only populates the diagnostic
   *  productionBreakevenModeledCloseQty result field; it never feeds grossR. */
  productionBreakevenCloseQty?: number;
  /** production_breakeven_control only: exchange LOT_SIZE stepSize paired with
   *  productionBreakevenCloseQty above. Both must be supplied (and > 0) for the diagnostic to
   *  compute; otherwise productionBreakevenModeledCloseQty stays null. */
  productionBreakevenQtyStepSize?: number;
  forceCloseAtEnd?: boolean;
  /** OPT-IN (2026-07-26): collect the per-candle R series this walk already computes and return it
   *  as VariantWalkResult.rPath. Absent/false ⇒ the result object does not even carry an `rPath`
   *  key and every other field is byte-identical to before this option existed. Never changes any
   *  computation, ordering or early-return — see the VariantRPathPoint block above. */
  collectRPath?: boolean;
  /** collectRPath only: hard cap on the returned series length (default VARIANT_R_PATH_MAX_POINTS,
   *  floored at VARIANT_R_PATH_MIN_CAP). Thinning always retains first/last/argmax/argmin, so the
   *  max/min-vs-maxMfeR/minMaeR consistency holds at any cap. */
  rPathMaxPoints?: number;
}

export interface VariantWalkResult {
  status: "CLOSED_WIN" | "CLOSED_LOSS" | "NO_FILL" | "UNRESOLVED";
  grossR: number | null;
  openedAtMs: number | null;
  closedAtMs: number | null;
  maxMfeR: number | null;
  minMaeR: number | null;
  /** Open-time (ms) of the candle on which maxMfeR last increased — i.e. when the trade's
   *  best favorable excursion was reached. Null whenever maxMfeR itself is null (no valid
   *  path walked, e.g. NO_FILL/UNRESOLVED) or no favorable excursion above 0 ever occurred.
   *  Approximate to candle granularity (5m) — same intrabar-timing limitation as the rest of
   *  this walk, which only knows OHLC, not exact tick order within a candle. */
  peakAtMs: number | null;
  intrabarResolutionStatus: VariantIntrabarStatus;
  isFreshValid: boolean | null;
  resolutionSource: string | null;
  /** production_breakeven_control only: the modeled arm/trigger PRICE — the closed-form price at
   *  which ownUnrealized(mark vs entry) first equals the assumed round-trip cost estimate (i.e.
   *  netAfterCost==0), mirroring live-execution-engine.ts's maybeCloseLiveBreakevenLaneAfterCost().
   *  Null for every other exitRule. Populated on EVERY result for this exitRule (even a plain
   *  CLOSED_LOSS/MAX_HOLD_MTM outcome where the trigger was never reached) so a reconciliation
   *  report can always see what the model's threshold price was. */
  productionBreakevenTriggerPrice: number | null;
  /** production_breakeven_control only, present iff BOTH productionBreakevenCloseQty and
   *  productionBreakevenQtyStepSize were supplied on input: the close quantity after applying the
   *  exact same floor-to-stepSize rounding real close orders go through (roundToStep, reused
   *  unmodified from binance-futures-private.ts). Diagnostic only — never feeds grossR (see the
   *  constant block's approximation note #6 above walkVariantPath for why). */
  productionBreakevenModeledCloseQty: number | null;
  /**
   * OPT-IN, present ONLY when VariantWalkInput.collectRPath === true (the key is absent otherwise,
   * so a default-path result object is byte-identical to before this field existed).
   *
   * The position's UNREALIZED-R path, in the walk's own R unit: ONE point per walked candle, whose
   * `currentR` is the MARK-TO-MARKET R at that candle's CLOSE, plus that candle's favorable/adverse
   * extremes carried in the point's `peakR`/`troughR` (see VariantRPathPoint). Points are stamped
   * with the candle's OPEN time, the same candle-granularity convention `peakAtMs` documents — except
   * the terminating point, which is stamped at the trade's real `closedAtMs`.
   *
   * ── NO POST-EXIT INFORMATION (the hard rule) ────────────────────────────────────────────────────
   * A recorded path describes an OPEN position, so no point may describe a moment at which the
   * position was already closed. Two consequences:
   *   - A candle's close-mark is only emitted once the position is KNOWN to have survived that
   *     candle (the walk stages it and commits it on the next iteration). On the candle that fires
   *     the exit, that close-mark is discarded — the exit happened INTRABAR, before the close.
   *   - The terminating point instead carries the trade's REALIZED exit R (`grossR`) at `closedAtMs`.
   *
   * The convention chosen for the terminating candle, and why it CANNOT flatter a downstream policy:
   *   - INTRABAR exit (stop/TP/trail/breakeven fired inside the candle): only `troughR` — that
   *     candle's ADVERSE extreme — is carried. OHLC does not say which extreme printed first, and
   *     this file's existing same-candle convention is SL-first, so the adverse extreme is treated
   *     as reachable before the exit while the FAVORABLE extreme is not recorded at all (it may be
   *     a post-fill rebound). Suppressing it can only LOWER a consumer's running peak, and lowering
   *     the peak can only make an arm-then-bank policy bank later or not at all — it can never
   *     manufacture a better exit than the one the trade actually got. Carrying `troughR` is
   *     likewise safe: a deeper running trough never improves any policy's banked R.
   *   - CLOSE exit (MAX_HOLD_MTM / TRAIL_PATH_END): the position was open for the WHOLE final
   *     candle and closes at its close, so both of that candle's extremes ARE pre-exit and both are
   *     carried; `currentR` is the realized R, which for MAX_HOLD_MTM is that same close-mark.
   *
   * ── RELATION TO THE SUMMARY STATS ───────────────────────────────────────────────────────────────
   * Same formula, same `risk` denominator, same direction convention — the series IS the walk's own
   * computation, recorded rather than only reduced. Therefore it is BOUNDED by the summary stats:
   * every currentR/peakR ≤ maxMfeR and every currentR/troughR ≥ minMaeR, and folding the series into
   * a running peak/trough reproduces maxMfeR/minMaeR EXACTLY whenever the walk's extreme is not a
   * post-exit print on the terminating candle (it is strictly smaller when it is — that gap is the
   * post-exit information being withheld on purpose, not a disagreement). maxMfeR/minMaeR themselves
   * are UNCHANGED by this option: they still see every candle in full, because they feed lane
   * maturity and mainnet live eligibility. Thinning preserves the fold (thinRPathPreservingExtremes).
   *
   *   - null (not an empty array) whenever maxMfeR/minMaeR are themselves null — i.e. NO_FILL,
   *     UNRESOLVED, or a path invalidated by the MFE_MAE_CAP_R sanity bound. The series and the
   *     summary stats are always valid or null TOGETHER.
   * This is a SIMULATED reconstruction from candles, NOT a measured per-tick recording; consumers
   * must keep it in its own evidence tier (see exit-brain-shadow.ts's MEASURED vs SIMULATED blocks).
   */
  rPath?: VariantRPathPoint[] | null;
}

function rewardR(dir: Direction, entry: number, target: number, risk: number): number {
  if (!(risk > 0)) return 0;
  return dir === "LONG" ? (target - entry) / risk : (entry - target) / risk;
}

/** Minimal KlineTuple->Candle adapter so the atr_trail exit rule can reuse the existing
 *  computeATR (candle-indicators.ts) instead of duplicating Wilder's ATR math. computeATR only
 *  reads high/low/close (and the prior candle's close for true range) — `open` is carried through
 *  for shape-correctness but is never read by computeATR. */
function klineTupleToCandle(c: KlineTuple): Candle {
  return {
    openTime: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
  };
}

/**
 * Walks the 5m candle path for a single variant geometry. Pure aside from the
 * optional async 1m-refinement callback. Conservative: same-candle SL+TP is
 * refined via `resolve1m` when available, else resolves SL-first (a loss).
 * Never assumes an un-touched higher target was reached.
 */
export async function walkVariantPath(
  input: VariantWalkInput,
  resolve1m?: (fillCandleOpenMs: number) => Promise<"SL" | "TP" | null>,
): Promise<VariantWalkResult> {
  const { direction: dir, entryPrice: E, stopLoss: S, target: T, exitRule, fillMode } = input;
  const mfeGivebackArmR = input.mfeGivebackArmR ?? MFE_GIVEBACK_ARM_R;
  const mfeGivebackFrac = input.mfeGivebackFrac ?? MFE_GIVEBACK_FRAC;
  const atrPeriod = input.atrPeriod ?? ATR_TRAIL_PERIOD;
  const atrMultiple = input.atrMultiple ?? ATR_TRAIL_MULTIPLE;
  const atrTrailArmR = input.atrTrailArmR ?? ATR_TRAIL_ARM_R;
  const productionBreakevenCostPct = input.productionBreakevenCostPct ?? PRODUCTION_BREAKEVEN_CONTROL_COST_PCT;
  const risk = dir === "LONG" ? E - S : S - E;
  // OPT-IN R-series collection (see VariantWalkInput.collectRPath). Everything below that touches
  // rPath is guarded by this flag; with it off the conditional spreads collapse to `{}` and the
  // result object keeps its exact pre-existing shape.
  const collectRPath = input.collectRPath === true;
  const rPathCap = Math.max(
    VARIANT_R_PATH_MIN_CAP,
    Math.floor(Number.isFinite(input.rPathMaxPoints) ? (input.rPathMaxPoints as number) : VARIANT_R_PATH_MAX_POINTS),
  );
  /** In-flight ceiling: the buffer is decimated back to rPathCap whenever it grows past 4× the cap,
   *  so an absurdly long candle window can never grow an unbounded array (repo OOM discipline) while
   *  the amortized cost stays O(candles). Thinning preserves the extremes, so the max/min-vs-summary
   *  consistency survives every pass. */
  const rPathInFlightCap = rPathCap * 4;
  let rPath: VariantRPathPoint[] | null = collectRPath ? [] : null;
  const empty: VariantWalkResult = {
    status: "UNRESOLVED",
    grossR: null,
    openedAtMs: null,
    closedAtMs: null,
    maxMfeR: null,
    minMaeR: null,
    peakAtMs: null,
    intrabarResolutionStatus: null,
    isFreshValid: null,
    resolutionSource: null,
    productionBreakevenTriggerPrice: null,
    productionBreakevenModeledCloseQty: null,
    // Key present ONLY when collecting — so every non-collecting return stays byte-identical.
    // `empty` is the NO_FILL/UNRESOLVED/invalid-input shape, where maxMfeR/minMaeR are null too:
    // the series and the summary stats are always valid-or-null together.
    ...(collectRPath ? { rPath: null } : {}),
  };
  if (!(risk > 0) || input.candles.length === 0) return empty;

  const candles = input.candles;
  const candleOpen = (c: KlineTuple) => Number(c[0]);
  const candleHigh = (c: KlineTuple) => Number(c[2]);
  const candleLow = (c: KlineTuple) => Number(c[3]);
  const candleClose = (c: KlineTuple) => Number(c[4]);
  const candleCloseTime = (c: KlineTuple) => {
    const raw = Number(c[6]);
    return Number.isFinite(raw) ? raw : candleOpen(c) + CANDLE_MS;
  };

  // atr_trail only: one ATR series over the FULL candle window, index-aligned with `candles` so
  // atrSeries[i] lines up directly with candles[i] inside the walk loop below. Computed once,
  // up-front, regardless of where the walk actually starts (fillIdx) — cheap (single pass) and
  // keeps the per-candle loop free of re-derivation.
  const atrSeries = exitRule === "atr_trail" ? computeATR(candles.map(klineTupleToCandle), atrPeriod) : null;

  // production_breakeven_control only: the modeled arm/trigger PRICE, solved in closed form.
  // Production's real gate (live-execution-engine.ts:2449-2451) is, in dollar terms:
  //   netAfterCost = (mark-entry)*|qty| - |qty|*mark*costPct >= 0      (LONG; SHORT mirrored)
  // Assuming the engine's own qty equals the exchange position's qty (shareFrac=1, the common
  // single-lane case — see investigation item 6), |qty| cancels and this reduces to a pure
  // function of price:
  //   LONG:  mark - entry >= mark*costPct  =>  mark >= entry / (1 - costPct)
  //   SHORT: entry - mark >= mark*costPct  =>  mark <= entry / (1 + costPct)
  // This is a FIXED price for the whole walk (not path-dependent) — production itself re-checks
  // the identical algebraic condition fresh every tick with no arm/latch state, so "does this
  // candle's high/low range cross this fixed price" is the closest discrete analog to "did any
  // tick's mark price cross it" (approximation #1 in the block comment above).
  const productionBreakevenTriggerPrice =
    exitRule === "production_breakeven_control" && productionBreakevenCostPct > 0 && productionBreakevenCostPct < 1
      ? dir === "LONG"
        ? E / (1 - productionBreakevenCostPct)
        : E / (1 + productionBreakevenCostPct)
      : null;
  // Whichever of {trigger price, real target T} requires the SMALLER favorable move is reached
  // FIRST in continuous time. Given costPct (~22bps) is normally far smaller than any of these
  // lanes' real TP distances (150-900bps), the trigger price is almost always the closer one —
  // this control preempts the "let it run to TP" thesis whenever the trade ever ticks favorable
  // by more than the cost estimate. Only in a contrived/misconfigured geometry (TP tighter than
  // the cost estimate) would T be the closer, "real" outcome instead.
  const productionBreakevenIsCloserThanTp =
    productionBreakevenTriggerPrice !== null && Number.isFinite(productionBreakevenTriggerPrice)
      ? dir === "LONG"
        ? productionBreakevenTriggerPrice <= T
        : productionBreakevenTriggerPrice >= T
      : false;
  const productionBreakevenExitR =
    productionBreakevenTriggerPrice !== null && Number.isFinite(productionBreakevenTriggerPrice)
      ? rewardR(dir, E, productionBreakevenTriggerPrice, risk)
      : 0;
  // Diagnostic only (approximation #6 above): floor the position's own close quantity to the
  // exchange stepSize using the EXACT same helper placeOrder() uses for every real close order.
  // Never feeds grossR — production's own MARKET close has no price to round, and the qty floor
  // only ever shaves an economically negligible dust remainder off the closed size.
  const productionBreakevenModeledCloseQty =
    exitRule === "production_breakeven_control" &&
    typeof input.productionBreakevenCloseQty === "number" &&
    input.productionBreakevenCloseQty > 0 &&
    typeof input.productionBreakevenQtyStepSize === "number" &&
    input.productionBreakevenQtyStepSize > 0
      ? roundToStep(input.productionBreakevenCloseQty, input.productionBreakevenQtyStepSize, "down")
      : null;

  // Locate the signal candle (the one containing openedAtMs).
  let signalIdx = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const open = candleOpen(candles[i]!);
    if (open <= input.openedAtMs && input.openedAtMs < open + CANDLE_MS) {
      signalIdx = i;
      break;
    }
    if (open > input.openedAtMs) {
      signalIdx = i;
      break;
    }
  }

  // Determine fill index.
  let fillIdx = -1;
  if (fillMode === "taker") {
    fillIdx = signalIdx; // taker fills at the signal candle
  } else {
    // maker_limit: a resting post-only limit at E fills only on a pullback to E
    // on a candle STRICTLY AFTER the signal candle (we waited rather than crossed
    // the spread). If price never revisits E within the window -> NO_FILL.
    const window = input.makerFillWindowCandles ?? MAKER_FILL_WINDOW_CANDLES;
    const start = signalIdx + 1;
    const end = Math.min(candles.length, start + window);
    for (let i = start; i < end; i += 1) {
      const filled = dir === "LONG" ? candleLow(candles[i]!) <= E : candleHigh(candles[i]!) >= E;
      if (filled) {
        fillIdx = i;
        break;
      }
    }
    if (fillIdx < 0) {
      return { ...empty, status: "NO_FILL", resolutionSource: "MAKER_NO_FILL" };
    }
  }
  if (fillIdx < 0 || fillIdx >= candles.length) return empty;

  const openedAtMs = Math.max(input.openedAtMs, candleOpen(candles[fillIdx]!));
  let maxMfeR = 0;
  let minMaeR = 0;
  let peakAtMs: number | null = null;
  let pathValid = true;

  // OPT-IN series staging (see VariantWalkResult.rPath's POST-EXIT rule). A candle's close-mark is
  // only a valid observation of an OPEN position if the position actually SURVIVED that candle —
  // which is only known once the next iteration begins, since every exit returns from inside the
  // iteration that fires it. So updatePath STAGES the candle's point and commitStagedRPathTick()
  // commits the previous one at the top of the next iteration; finalize() decides what the
  // terminating candle may contribute and discards whatever is still staged.
  let stagedRPathTick: VariantRPathPoint | null = null;
  const commitStagedRPathTick = () => {
    if (!rPath || !stagedRPathTick) return;
    rPath.push(stagedRPathTick);
    stagedRPathTick = null;
    if (rPath.length > rPathInFlightCap) rPath = thinRPathPreservingExtremes(rPath, rPathCap);
  };

  const updatePath = (high: number, low: number, close: number, atMs: number) => {
    if (!pathValid) {
      stagedRPathTick = null;
      return;
    }
    const favorable = dir === "LONG" ? Math.max(high - E, 0) : Math.max(E - low, 0);
    const adverse = dir === "LONG" ? Math.min(low - E, 0) : Math.min(E - high, 0);
    const mfeR = favorable / risk;
    const maeR = adverse / risk;
    if (!Number.isFinite(mfeR) || !Number.isFinite(maeR) || Math.abs(mfeR) > MFE_MAE_CAP_R || Math.abs(maeR) > MFE_MAE_CAP_R) {
      pathValid = false;
      stagedRPathTick = null;
      return;
    }
    if (mfeR > maxMfeR) {
      maxMfeR = mfeR;
      peakAtMs = atMs;
    }
    if (maeR < minMaeR) minMaeR = maeR;
    // OPT-IN series capture: ONE point per candle, the position's mark-to-market R at the candle's
    // CLOSE — the actual unrealized-R path — with the candle's extremes carried as the peakR/troughR
    // refinements a consumer folds into its running peak/trough. Same `risk` denominator and same
    // direction convention as mfeR/maeR above; never a second R definition.
    if (rPath) {
      const markR = dir === "LONG" ? (close - E) / risk : (E - close) / risk;
      stagedRPathTick = Number.isFinite(markR) ? { tsMs: atMs, currentR: markR, peakR: mfeR, troughR: maeR } : null;
    }
  };

  /** Set ONLY by the two path-END closes (TRAIL_PATH_END / MAX_HOLD_MTM), where the position was
   *  open for the WHOLE final candle and closes AT its close — so that candle's extremes are both
   *  genuinely pre-exit. Every other exit in this walk fires INTRABAR. Read by finalize() for the
   *  R-series termination rule only; it touches nothing else. */
  let closedAtFinalCandleClose = false;

  /**
   * Closes the R series for a RESOLVED walk. Implements VariantWalkResult.rPath's POST-EXIT rule:
   * the terminating candle's staged close-mark is DISCARDED (for an intrabar exit the close is a
   * moment the position no longer existed), and the series instead ends on the trade's realized
   * exit R stamped at its real closedAtMs.
   *
   * The terminating candle's FAVORABLE extreme is carried only for a close-exit (MAX_HOLD_MTM /
   * TRAIL_PATH_END), where the position was open for that entire candle. For an intrabar exit it is
   * withheld — it may be a post-fill rebound, and withholding it can only lower a consumer's running
   * peak, which can only make an arm-then-bank policy bank later or not at all. There is no ordering
   * of that candle's extremes which could let a policy book a better exit than the one the trade
   * actually got; the adverse extreme is still carried (SL-first, this file's existing convention),
   * and a deeper trough never improves a banked R either.
   */
  const terminateRPath = (grossR: number, closedAtMs: number): VariantRPathPoint[] => {
    const staged = stagedRPathTick;
    stagedRPathTick = null;
    const out = rPath ?? [];
    out.push({
      tsMs: closedAtMs,
      currentR: grossR,
      ...(closedAtFinalCandleClose && typeof staged?.peakR === "number" ? { peakR: staged.peakR } : {}),
      ...(typeof staged?.troughR === "number" ? { troughR: staged.troughR } : {}),
    });
    return thinRPathPreservingExtremes(out, rPathCap);
  };

  const finalize = (
    status: "CLOSED_WIN" | "CLOSED_LOSS",
    grossR: number,
    closedAtMs: number,
    resolutionSource: string,
    intrabar: VariantIntrabarStatus,
    isFreshValid: boolean,
  ): VariantWalkResult => ({
    status,
    grossR,
    openedAtMs,
    closedAtMs,
    maxMfeR: pathValid ? maxMfeR : null,
    minMaeR: pathValid ? minMaeR : null,
    peakAtMs: pathValid ? peakAtMs : null,
    intrabarResolutionStatus: intrabar,
    isFreshValid,
    resolutionSource,
    // Populated for EVERY outcome of this exitRule (not just the ones caused by the trigger
    // itself) so a reconciliation report can always see what the model's threshold was, per the
    // VariantWalkResult field doc.
    productionBreakevenTriggerPrice,
    productionBreakevenModeledCloseQty,
    // Key present ONLY when collecting (the spread is `{}` otherwise). Gated on the SAME pathValid
    // flag maxMfeR/minMaeR use, so the series can never outlive the stats it must agree with.
    ...(collectRPath ? { rPath: pathValid ? terminateRPath(grossR, closedAtMs) : null } : {}),
  });

  const fullRewardR = rewardR(dir, E, T, risk);

  // Shared trail state (trail_after_tp1 / scaleout_tp1_trail).
  let tp1Touched = false;
  // atr_trail state: starts at the original stop and only ever ratchets toward price (never
  // loosens) once armed. Independent of tp1Touched — atr_trail has no TP1-touch concept.
  let atrCurrentStop = S;

  for (let i = fillIdx; i < candles.length; i += 1) {
    const candle = candles[i]!;
    const high = candleHigh(candle);
    const low = candleLow(candle);
    const cClose = candleClose(candle);
    const cCloseTime = candleCloseTime(candle);
    const cOpen = candleOpen(candle);
    // Peak favorable BEFORE folding in this candle — used by mfe_giveback so the giveback
    // level cannot be triggered by the same candle's own new high (no intrabar lookahead).
    const peakBefore = maxMfeR;
    // We are iterating again, so nothing terminated on the PREVIOUS candle: its close-mark is now
    // known to be an observation of a still-open position and may be committed to the series.
    commitStagedRPathTick();
    updatePath(high, low, cClose, cOpen);

    const slHitAtStop = (stop: number) => (dir === "LONG" ? low <= stop : high >= stop);
    const tpHit = dir === "LONG" ? high >= T : low <= T;
    const backToEntry = dir === "LONG" ? low <= E : high >= E;

    if (exitRule === "tp1_full") {
      const slHit = slHitAtStop(S);
      if (slHit && tpHit) {
        const decided = resolve1m ? await resolve1m(cOpen) : null;
        if (decided === "TP") {
          return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "INTRABAR_1M_TP", "RESOLVED_BY_1M", true);
        }
        if (decided === "SL") {
          return finalize("CLOSED_LOSS", -1, cCloseTime, "INTRABAR_1M_SL", "RESOLVED_BY_1M", true);
        }
        // conservative SL-first
        return finalize("CLOSED_LOSS", -1, cCloseTime, "AMBIGUOUS_SL_FIRST", "AMBIGUOUS_SAME_CANDLE_SL_FIRST", true);
      }
      if (slHit) return finalize("CLOSED_LOSS", -1, cCloseTime, "CANDLE_WALK_SL", "VALID_5M_ORDERED", true);
      if (tpHit) return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "CANDLE_WALK_TP", "VALID_5M_ORDERED", true);
      continue;
    }

    if (exitRule === "mfe_giveback") {
      // Hard stop and far TP still bound the trade (SL-first on an ambiguous same-candle).
      const slHit = slHitAtStop(S);
      if (slHit && tpHit) {
        const decided = resolve1m ? await resolve1m(cOpen) : null;
        if (decided === "TP") return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "INTRABAR_1M_TP", "RESOLVED_BY_1M", true);
        return finalize("CLOSED_LOSS", -1, cCloseTime, "AMBIGUOUS_SL_FIRST", decided === "SL" ? "RESOLVED_BY_1M" : "AMBIGUOUS_SAME_CANDLE_SL_FIRST", true);
      }
      if (slHit) return finalize("CLOSED_LOSS", -1, cCloseTime, "CANDLE_WALK_SL", "VALID_5M_ORDERED", true);
      if (tpHit) return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "CANDLE_WALK_TP", "VALID_5M_ORDERED", true);
      // Giveback trail: once the PRIOR peak (excludes this candle) has armed, exit when this
      // candle retraces to peak*(1-frac) of the favorable move.
      if (peakBefore >= mfeGivebackArmR) {
        const exitR = peakBefore * (1 - mfeGivebackFrac);
        const givebackLevel = dir === "LONG" ? E + risk * exitR : E - risk * exitR;
        const retraced = dir === "LONG" ? low <= givebackLevel : high >= givebackLevel;
        if (retraced) {
          const status = exitR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
          return finalize(status, exitR, cCloseTime, "MFE_GIVEBACK_EXIT", "VALID_5M_ORDERED", true);
        }
      }
      continue;
    }

    if (exitRule === "atr_trail") {
      // Hard far TP still bounds the trade on the upside (same convention as mfe_giveback); the
      // STOP side is the ratcheted `atrCurrentStop` rather than the fixed `S`. Same-candle
      // ambiguity resolved the same conservative way as every other exit rule (1m refine, else
      // SL-first).
      const slHit = slHitAtStop(atrCurrentStop);
      if (slHit && tpHit) {
        const decided = resolve1m ? await resolve1m(cOpen) : null;
        if (decided === "TP") return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "INTRABAR_1M_TP", "RESOLVED_BY_1M", true);
        const exitR = rewardR(dir, E, atrCurrentStop, risk);
        const status = exitR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
        return finalize(status, exitR, cCloseTime, "AMBIGUOUS_SL_FIRST", decided === "SL" ? "RESOLVED_BY_1M" : "AMBIGUOUS_SAME_CANDLE_SL_FIRST", true);
      }
      if (slHit) {
        const exitR = rewardR(dir, E, atrCurrentStop, risk);
        const status = exitR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
        return finalize(status, exitR, cCloseTime, "ATR_TRAIL_STOP", "VALID_5M_ORDERED", true);
      }
      if (tpHit) return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "CANDLE_WALK_TP", "VALID_5M_ORDERED", true);
      // Ratchet using THIS candle's close, but only for the NEXT candle's touch check (the SL
      // check above already used the stop as of the END of the PREVIOUS candle — no lookahead).
      // Only once armed (peak BEFORE this candle >= atrTrailArmR; stays armed, maxMfeR is
      // monotonic) and only when ATR is available for this index. Math.max/Math.min => never loosens.
      const atrValue = atrSeries ? atrSeries[i] : null;
      if (peakBefore >= atrTrailArmR && typeof atrValue === "number" && Number.isFinite(atrValue) && atrValue > 0) {
        const trailLevel = dir === "LONG" ? cClose - atrMultiple * atrValue : cClose + atrMultiple * atrValue;
        atrCurrentStop = dir === "LONG" ? Math.max(atrCurrentStop, trailLevel) : Math.min(atrCurrentStop, trailLevel);
      }
      continue;
    }

    if (exitRule === "production_breakeven_control") {
      // Models live-execution-engine.ts's maybeCloseLiveBreakevenLaneAfterCost(). The hard SL
      // still bounds the downside exactly like every other rule (production's real stop is a
      // separate resting order, orthogonal to this mechanism, but still fires if price never
      // reaches the tiny breakeven-after-cost threshold). productionBreakevenTriggerPrice/
      // productionBreakevenIsCloserThanTp/productionBreakevenExitR are precomputed ONCE above the
      // loop (fixed price levels, not path-dependent — see that comment block for the derivation).
      const slHit = slHitAtStop(S);
      const beHit =
        productionBreakevenTriggerPrice !== null && Number.isFinite(productionBreakevenTriggerPrice)
          ? dir === "LONG"
            ? high >= productionBreakevenTriggerPrice
            : low <= productionBreakevenTriggerPrice
          : false;
      if (slHit && (beHit || tpHit)) {
        const decided = resolve1m ? await resolve1m(cOpen) : null;
        if (decided === "TP") {
          if (beHit && (productionBreakevenIsCloserThanTp || !tpHit)) {
            return finalize(
              productionBreakevenExitR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
              productionBreakevenExitR,
              cCloseTime,
              "LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST",
              "RESOLVED_BY_1M",
              true,
            );
          }
          return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "CANDLE_WALK_TP", "RESOLVED_BY_1M", true);
        }
        // Conservative SL-first — same convention as every other exit rule in this file.
        return finalize(
          "CLOSED_LOSS",
          -1,
          cCloseTime,
          "AMBIGUOUS_SL_FIRST",
          decided === "SL" ? "RESOLVED_BY_1M" : "AMBIGUOUS_SAME_CANDLE_SL_FIRST",
          true,
        );
      }
      if (slHit) return finalize("CLOSED_LOSS", -1, cCloseTime, "CANDLE_WALK_SL", "VALID_5M_ORDERED", true);
      if (beHit && tpHit) {
        // Both thresholds fall inside this candle's range. The conservative convention this file
        // already uses (never assume the FARTHER level was reached) plus the real economics
        // (production's mechanism, when its threshold is closer, would have fired first in
        // continuous time) both point the same way: take whichever requires the SMALLER move.
        if (productionBreakevenIsCloserThanTp) {
          return finalize(
            productionBreakevenExitR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
            productionBreakevenExitR,
            cCloseTime,
            "LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST",
            "VALID_5M_ORDERED",
            true,
          );
        }
        return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "CANDLE_WALK_TP", "VALID_5M_ORDERED", true);
      }
      if (beHit) {
        return finalize(
          productionBreakevenExitR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
          productionBreakevenExitR,
          cCloseTime,
          "LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST",
          "VALID_5M_ORDERED",
          true,
        );
      }
      if (tpHit) return finalize("CLOSED_WIN", fullRewardR, cCloseTime, "CANDLE_WALK_TP", "VALID_5M_ORDERED", true);
      continue;
    }

    // trail_after_tp1 and scaleout_tp1_trail share pre-touch + runner logic.
    if (!tp1Touched) {
      const slHit = slHitAtStop(S);
      if (slHit && tpHit) {
        const decided = resolve1m ? await resolve1m(cOpen) : null;
        if (decided === "SL" || decided === null) {
          return finalize("CLOSED_LOSS", -1, cCloseTime, "AMBIGUOUS_SL_FIRST", decided === "SL" ? "RESOLVED_BY_1M" : "AMBIGUOUS_SAME_CANDLE_SL_FIRST", true);
        }
        // decided === "TP": TP1 reached first this candle.
        tp1Touched = true;
        if (backToEntry) {
          const runnerR = 0;
          const grossR = exitRule === "scaleout_tp1_trail" ? 0.5 * fullRewardR + 0.5 * runnerR : runnerR;
          const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
          return finalize(status, grossR, cCloseTime, "TRAIL_BREAKEVEN_SAME_CANDLE", "RESOLVED_BY_1M", true);
        }
        continue;
      }
      if (slHit) return finalize("CLOSED_LOSS", -1, cCloseTime, "CANDLE_WALK_SL", "VALID_5M_ORDERED", true);
      if (tpHit) {
        tp1Touched = true;
        if (backToEntry) {
          // touched TP1 then returned to entry within the same candle
          const runnerR = 0;
          const grossR = exitRule === "scaleout_tp1_trail" ? 0.5 * fullRewardR + 0.5 * runnerR : runnerR;
          const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
          return finalize(status, grossR, cCloseTime, "TRAIL_BREAKEVEN_SAME_CANDLE", "VALID_5M_ORDERED", true);
        }
        continue;
      }
      continue;
    }

    // tp1Touched: trailing stop is at breakeven (E).
    if (backToEntry) {
      const runnerR = 0;
      const grossR = exitRule === "scaleout_tp1_trail" ? 0.5 * fullRewardR + 0.5 * runnerR : runnerR;
      const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
      return finalize(status, grossR, cCloseTime, "TRAIL_BREAKEVEN_EXIT", "VALID_5M_ORDERED", true);
    }
    // otherwise keep riding
  }

  // Path ended.
  if ((exitRule === "trail_after_tp1" || exitRule === "scaleout_tp1_trail") && tp1Touched) {
    const lastCandle = candles[candles.length - 1]!;
    const lastClose = candleClose(lastCandle);
    const runnerR = dir === "LONG" ? (lastClose - E) / risk : (E - lastClose) / risk;
    const grossR = exitRule === "scaleout_tp1_trail" ? 0.5 * fullRewardR + 0.5 * runnerR : runnerR;
    const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
    // Position was open for the whole final candle and closes at its close — no post-exit window.
    closedAtFinalCandleClose = true;
    return finalize(status, grossR, candleCloseTime(lastCandle), "TRAIL_PATH_END", "VALID_5M_ORDERED", true);
  }

  if (input.forceCloseAtEnd) {
    const lastCandle = candles[candles.length - 1]!;
    const lastClose = candleClose(lastCandle);
    const grossR = dir === "LONG" ? (lastClose - E) / risk : (E - lastClose) / risk;
    const status = grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
    // Position was open for the whole final candle and closes at its close — no post-exit window.
    closedAtFinalCandleClose = true;
    return finalize(status, grossR, candleCloseTime(lastCandle), "MAX_HOLD_MTM", "VALID_5M_ORDERED", true);
  }

  // Left UNRESOLVED (no forceCloseAtEnd, arm threshold never crossed, hard stop never touched):
  // still surface the modeled trigger price/qty diagnostics for production_breakeven_control so a
  // caller can see what the threshold WAS even though the walk never reached a verdict.
  return { ...empty, productionBreakevenTriggerPrice, productionBreakevenModeledCloseQty };
}

// ---------------------------------------------------------------------------
// Pyramid-only-on-confirmed-winner (Tier 2 item 5, OFFLINE ANALYSIS ONLY).
// walkVariantPath itself is untouched above and still only ever replays ONE entry — this is an
// ADDITIVE sibling function, not a modification of it. It simulates adding a SECOND same-direction
// entry once the FIRST leg has shown real favorable progress (mirrors the "no further adds without
// progress" spirit of live-execution-engine.ts's shouldCapPyramidAdd/PYRAMID_MIN_FAVORABLE_R gate —
// see PYRAMID_CONFIRMED_ADD_FAVORABLE_R's doc comment for why this is an independent constant, not
// a shared one). Both legs' EXITS are resolved entirely by walkVariantPath (reused, not
// reimplemented) — the only new logic here is "when does leg 2 get added" (a tiny favorable-R
// crossing scan, not an exit-resolution rule) and "how do the two legs combine into one R number".
// ---------------------------------------------------------------------------

/**
 * Finds the first candle (scanning from `fromIdx` onward, inclusive) where the running favorable
 * excursion from `entryPrice` — using the exact same favorable-excursion formula walkVariantPath's
 * own MFE tracker uses — reaches `thresholdR`. This is an ENTRY-timing detector, not exit logic:
 * it never decides whether/how a leg closes (walkVariantPath alone does that). Uses candle
 * high/low directly (same convention SL/TP touches use elsewhere in this file) rather than the
 * peakBefore/no-lookahead convention mfe_giveback and atr_trail use for EXITS — there is no
 * self-referential exit-off-its-own-spike concern for a pure "did we ever reach this level" scan.
 */
function findFavorableRCrossing(
  dir: Direction,
  entryPrice: number,
  risk: number,
  candles: KlineTuple[],
  fromIdx: number,
  thresholdR: number,
): { index: number; atMs: number } | null {
  if (!(risk > 0) || !(thresholdR > 0)) return null;
  for (let i = Math.max(fromIdx, 0); i < candles.length; i += 1) {
    const c = candles[i]!;
    const high = Number(c[2]);
    const low = Number(c[3]);
    const favorable = dir === "LONG" ? Math.max(high - entryPrice, 0) : Math.max(entryPrice - low, 0);
    if (favorable / risk >= thresholdR) {
      return { index: i, atMs: Number(c[0]) };
    }
  }
  return null;
}

/** Locates the index of the candle containing `atMs` (same convention walkVariantPath's own
 *  signal-candle search uses) — used only to find where to START the favorable-R crossing scan
 *  (leg 1's actual fill candle, taker OR maker — walkVariantPath already resolved which candle
 *  that was via its returned `openedAtMs`, so this never re-derives the maker fill-window logic). */
function locateCandleIndex(candles: KlineTuple[], atMs: number): number {
  for (let i = 0; i < candles.length; i += 1) {
    const open = Number(candles[i]![0]);
    if (open <= atMs && atMs < open + CANDLE_MS) return i;
    if (open > atMs) return i;
  }
  return Math.max(candles.length - 1, 0);
}

export interface PyramidWalkInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  target: number;
  /** Exit rule applied to BOTH legs (each leg is its own independent walkVariantPath replay). */
  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  openedAtMs: number;
  candles: KlineTuple[];
  /** Favorable-R the FIRST leg must reach (real, not fabricated, progress) before a second
   *  same-direction entry is added. Default PYRAMID_CONFIRMED_ADD_FAVORABLE_R. */
  addFavorableR?: number;
  /** Size of the second entry relative to the first leg's size (1 = equal size). Default
   *  PYRAMID_CONFIRMED_ADD_SIZE_MULTIPLE. */
  addSizeMultiple?: number;
  makerFillWindowCandles?: number;
  mfeGivebackArmR?: number;
  mfeGivebackFrac?: number;
  atrPeriod?: number;
  atrMultiple?: number;
  atrTrailArmR?: number;
  forceCloseAtEnd?: boolean;
}

export interface PyramidWalkResult {
  status: "CLOSED_WIN" | "CLOSED_LOSS" | "NO_FILL" | "UNRESOLVED";
  /** True only when the favorable-R threshold was actually crossed WHILE leg 1 was still open
   *  and a second leg was walked (regardless of leg 2's own eventual outcome). */
  addedSecondEntry: boolean;
  addOpenedAtMs: number | null;
  addEntryPrice: number | null;
  /** Full result of the first (original-size) entry — exactly what a plain walkVariantPath call
   *  on the same geometry/candles would return. */
  leg1: VariantWalkResult;
  /** Full result of the second (pyramided) entry, or null when no add was made or leg 1 itself
   *  never resolved (NO_FILL/UNRESOLVED — nothing to confirm a winner from). */
  leg2: VariantWalkResult | null;
  /** Size-weighted blended R across both legs: (leg1R×1 + leg2R×addSizeMultiple) / totalSize.
   *  Falls back to leg1.grossR alone when leg2 was never added or never resolved — no fabricated
   *  leg2 P&L is ever assumed. Null only when leg1 itself has no grossR (NO_FILL/UNRESOLVED). */
  combinedR: number | null;
  totalSize: number;
}

export async function walkPyramidOnConfirmedWinner(
  input: PyramidWalkInput,
  resolve1m?: (fillCandleOpenMs: number) => Promise<"SL" | "TP" | null>,
): Promise<PyramidWalkResult> {
  const addFavorableR = input.addFavorableR ?? PYRAMID_CONFIRMED_ADD_FAVORABLE_R;
  const addSizeMultiple = input.addSizeMultiple ?? PYRAMID_CONFIRMED_ADD_SIZE_MULTIPLE;

  // Leg 1: the ORIGINAL, full-size entry. Exit resolution entirely delegated to walkVariantPath —
  // this function never reimplements SL/TP/trail/giveback/atr-trail logic.
  const leg1 = await walkVariantPath(
    {
      direction: input.direction,
      entryPrice: input.entryPrice,
      stopLoss: input.stopLoss,
      target: input.target,
      exitRule: input.exitRule,
      fillMode: input.fillMode,
      openedAtMs: input.openedAtMs,
      candles: input.candles,
      makerFillWindowCandles: input.makerFillWindowCandles,
      mfeGivebackArmR: input.mfeGivebackArmR,
      mfeGivebackFrac: input.mfeGivebackFrac,
      atrPeriod: input.atrPeriod,
      atrMultiple: input.atrMultiple,
      atrTrailArmR: input.atrTrailArmR,
      forceCloseAtEnd: input.forceCloseAtEnd,
    },
    resolve1m,
  );

  const noAdd = (): PyramidWalkResult => ({
    status: leg1.status,
    addedSecondEntry: false,
    addOpenedAtMs: null,
    addEntryPrice: null,
    leg1,
    leg2: null,
    combinedR: leg1.grossR,
    totalSize: 1,
  });

  // Nothing to confirm a winner from — leg 1 never filled or never resolved.
  if (leg1.status === "NO_FILL" || leg1.status === "UNRESOLVED") return noAdd();

  const risk = input.direction === "LONG" ? input.entryPrice - input.stopLoss : input.stopLoss - input.entryPrice;
  if (!(risk > 0)) return noAdd();

  // Scan for the favorable-R crossing starting from leg 1's ACTUAL fill candle (walkVariantPath
  // already resolved taker-vs-maker fill timing for us via leg1.openedAtMs — no re-derivation of
  // the maker fill-window scan here).
  const scanFrom = locateCandleIndex(input.candles, leg1.openedAtMs ?? input.openedAtMs);
  const crossing = findFavorableRCrossing(input.direction, input.entryPrice, risk, input.candles, scanFrom, addFavorableR);

  // No confirmed-winner crossing, or it only happened at/after leg 1 already closed (too late to
  // add to a position that no longer exists) => single-entry outcome only.
  if (!crossing || (leg1.closedAtMs !== null && crossing.atMs >= leg1.closedAtMs)) return noAdd();

  // Confirmed winner: add a second same-direction entry at the crossing candle's CLOSE (a
  // conservative, tradeable reference price — not the candle's own intrabar high/low that
  // triggered the crossing). Leg 2 gets its OWN stop/target, mirroring leg 1's exact geometry
  // (same absolute risk distance, same absolute reward distance) re-based to its own entry — like
  // a real pyramid add is a brand-new order, not a fractional share of leg 1's.
  const addCandle = input.candles[crossing.index]!;
  const addEntryPrice = Number(addCandle[4]);
  const leg2StopLoss = input.direction === "LONG" ? addEntryPrice - risk : addEntryPrice + risk;
  const rewardDistance = input.direction === "LONG" ? input.target - input.entryPrice : input.entryPrice - input.target;
  const leg2Target = input.direction === "LONG" ? addEntryPrice + rewardDistance : addEntryPrice - rewardDistance;
  const remainingCandles = input.candles.slice(crossing.index);

  const leg2 = await walkVariantPath(
    {
      direction: input.direction,
      entryPrice: addEntryPrice,
      stopLoss: leg2StopLoss,
      target: leg2Target,
      exitRule: input.exitRule,
      fillMode: "taker", // the add fires on confirmed real-time progress, not a resting limit
      openedAtMs: crossing.atMs,
      candles: remainingCandles,
      mfeGivebackArmR: input.mfeGivebackArmR,
      mfeGivebackFrac: input.mfeGivebackFrac,
      atrPeriod: input.atrPeriod,
      atrMultiple: input.atrMultiple,
      atrTrailArmR: input.atrTrailArmR,
      forceCloseAtEnd: input.forceCloseAtEnd,
    },
    resolve1m,
  );

  const totalSize = 1 + addSizeMultiple;
  const combinedR =
    leg1.grossR !== null && leg2.grossR !== null
      ? (leg1.grossR * 1 + leg2.grossR * addSizeMultiple) / totalSize
      : leg1.grossR;
  const status: PyramidWalkResult["status"] =
    combinedR !== null ? (combinedR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS") : leg1.status;

  return {
    status,
    addedSecondEntry: true,
    addOpenedAtMs: crossing.atMs,
    addEntryPrice,
    leg1,
    leg2,
    combinedR,
    totalSize,
  };
}

function variantMaxHoldMs(variantId: VariantMatrixVariantId): number {
  const variantDef = VARIANT_MATRIX_DEFINITIONS.find((def) => def.id === variantId);
  return Math.min(
    (variantDef?.maxHoldHours ?? DEFAULT_MAX_HOLD_MS / (60 * 60 * 1000)) * 60 * 60 * 1000,
    EXPIRY_MS - CANDLE_MS,
  );
}

export async function resolveVariantMatrixObservations(
  store: CurrentGuardVariantMatrixStore,
  binanceClient: VariantMatrixBinanceClient,
  opts: { maxObservations?: number; maxRuntimeMs?: number; yieldEvery?: number } = {},
): Promise<{ resolved: number; expired: number; dataFailures: number; errors: number }> {
  // Cross-caller mutual exclusion (Surface A, 2026-08 concurrency remediation): two independent
  // production triggers call this exported name against the SAME store (routes/shadow.ts's
  // fire-and-forget dashboard-audit-summary call, and its operator-brief ?resolve=1 call, whose
  // own `Promise.race` against a timeout can leave a prior call's real work still running in the
  // background past its own caller's wait). A second concurrent call now JOINS the first's
  // in-flight pass instead of starting a second one over the same on-disk store. Signature and
  // return type are unchanged; every existing test awaits this once, sequentially, per its own
  // fresh store, so a solo call is unaffected — it still just awaits its own single pass.
  return runExclusiveForStore(store, () => resolveVariantMatrixObservationsInner(store, binanceClient, opts));
}

async function resolveVariantMatrixObservationsInner(
  store: CurrentGuardVariantMatrixStore,
  binanceClient: VariantMatrixBinanceClient,
  opts: { maxObservations?: number; maxRuntimeMs?: number; yieldEvery?: number } = {},
): Promise<{ resolved: number; expired: number; dataFailures: number; errors: number }> {
  let resolved = 0;
  let expired = 0;
  let dataFailures = 0;
  let errors = 0;
  // Rotating Phase-2 cursor (see walkCursor in VariantMatrixResolverMeta).
  let walkCursorStart = 0;
  let walked = 0;
  const nowMs = Date.now();
  const startedMs = nowMs;
  const maxObservations =
    typeof opts.maxObservations === "number" && Number.isFinite(opts.maxObservations) && opts.maxObservations > 0
      ? Math.floor(opts.maxObservations)
      : Number.POSITIVE_INFINITY;
  const maxRuntimeMs =
    typeof opts.maxRuntimeMs === "number" && Number.isFinite(opts.maxRuntimeMs) && opts.maxRuntimeMs > 0
      ? Math.floor(opts.maxRuntimeMs)
      : Number.POSITIVE_INFINITY;
  const yieldEvery =
    typeof opts.yieldEvery === "number" && Number.isFinite(opts.yieldEvery) && opts.yieldEvery > 0
      ? Math.floor(opts.yieldEvery)
      : 1;
  let processed = 0;
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const candleCache = new Map<string, KlineTuple[]>();
  // Phase 2 resolutions used to call store.update() per observation — an O(n) full-array
  // JSON.stringify + writeFileSync EVERY resolution (n = total store size). Harmless when the store
  // was small; with the fresh-feed's higher ingestion rate the store grew into the tens of thousands
  // and a single resolver run (up to maxObservations resolutions) could do that many full-array
  // writes back to back, blocking the whole single-threaded process for minutes (observed: a 79k-obs
  // store on / made every request time out until the process was restarted). Accumulate patches and
  // flush with ONE store.bulkUpdate() after the walk — same fix already applied to the Phase 1 expiry
  // sweep, just extended to cover the resolution loop too.
  const patches: Array<{ observationId: string; patch: Partial<CurrentGuardVariantMatrixObservation> }> = [];

  // One flush for this ENTIRE run (expiry sweep + both prune passes + resolution patches + resolver
  // meta), not one per phase — see beginBatch()'s own doc comment for why this run alone used to do up
  // to 5 sequential full-store rewrites and starve operator-brief?resolve=1 for 90-190+s.
  store.beginBatch();
  try {
    // ── Phase 1: cheap bulk expiry sweep (no I/O, NOT counted against the fetch budget). ──
    // Stale (>EXPIRY_MS) OPEN observations are marked EXPIRED in ONE save. Previously the expiry
    // gate lived inside the single resolve loop and consumed the per-run budget (`processed`), so a
    // large stale backlog at the FRONT of the insertion-ordered store drained every run before it
    // reached a single resolvable observation — the store grew to thousands of OPEN obs and NOTHING
    // ever closed. Draining expiries up-front in one pass keeps the fetch budget for real work.
    const staleIds: string[] = [];
    for (const obs of store.all) {
      if (obs.status !== "OPEN") continue;
      const openedAtMs = toMs(obs.openedAt) ?? toMs(obs.createdAt) ?? nowMs;
      if (nowMs - openedAtMs > EXPIRY_MS) staleIds.push(obs.observationId);
    }
    if (staleIds.length > 0) {
      store.bulkUpdate(
        staleIds.map((observationId) => ({
          observationId,
          patch: {
            status: "EXPIRED" as const,
            resolvedAt: new Date(nowMs).toISOString(),
            resolutionSource: "EXPIRED_UNRESOLVED",
            intrabarResolutionStatus: "INTRABAR_UNAVAILABLE" as const,
            isFreshValid: null,
          },
        })),
      );
      expired += staleIds.length;
      resolved += staleIds.length;
    }

    // ── Phase 1b: bound memory — prune EXPIRED beyond the retain cap (feeds no stat). The born-stale
    //    mirror gate stops new EXPIRED at the source; this clears the accumulated churn backlog. ──
    store.pruneExpired(VM_MAX_EXPIRED_OBS);
    // ── Phase 1c: bound memory for terminal statuses that DO feed measurement — archives the
    //    dropped records first (see pruneTerminal/archiveDropped) instead of discarding them. ──
    store.pruneTerminal(VM_MAX_TERMINAL_OBS_PER_STATUS);

    // ── Phase 2: fetch-walk the remaining young OPEN obs, oldest-first BUT starting from a
    //    ROTATING cursor. Pure oldest-first re-walked the same (genuinely unresolvable) oldest
    //    wide-stop obs every run — with a 90K OPEN backlog the budget never reached the
    //    resolvable mid-age cohort and CLOSED froze for days. The cursor advances by the number
    //    processed each run, so successive runs sweep the whole backlog fairly. Bounded by
    //    maxObservations / maxRuntimeMs so each run COMPLETES and persists. ──
    const youngSorted = store.all
      .filter((o) => o.status === "OPEN")
      .sort(
        (a, b) =>
          (toMs(a.openedAt) ?? toMs(a.createdAt) ?? 0) - (toMs(b.openedAt) ?? toMs(b.createdAt) ?? 0),
      );
    const maxHoldReady = youngSorted.filter((o) => {
      const openedAtMs = toMs(o.openedAt) ?? toMs(o.createdAt) ?? nowMs;
      return nowMs - openedAtMs >= variantMaxHoldMs(o.variantId);
    });
    const stillWalking = youngSorted.filter((o) => {
      const openedAtMs = toMs(o.openedAt) ?? toMs(o.createdAt) ?? nowMs;
      return nowMs - openedAtMs < variantMaxHoldMs(o.variantId);
    });
    const cursorRaw = store.getResolverMeta()?.walkCursor ?? 0;
    const cursor = stillWalking.length > 0 ? ((cursorRaw % stillWalking.length) + stillWalking.length) % stillWalking.length : 0;
    walkCursorStart = cursor;
    const young = [...maxHoldReady, ...stillWalking.slice(cursor), ...stillWalking.slice(0, cursor)];
    for (const obs of young) {
      if (processed >= maxObservations) break;
      if (Date.now() - startedMs >= maxRuntimeMs) break;
      processed += 1;
      walked += 1;
      if (processed % yieldEvery === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Compute age outside the try block so it is always available.
      const openedAtMs = toMs(obs.openedAt) ?? toMs(obs.createdAt) ?? nowMs;

      // ── Candle fetch + path walk ─────
      try {
        const variantDef = VARIANT_MATRIX_DEFINITIONS.find((def) => def.id === obs.variantId);
        const maxHoldMs = variantMaxHoldMs(obs.variantId);
        const maxHoldReached = nowMs - openedAtMs >= maxHoldMs;
        const closedAtMs = toMs(obs.resolvedAt) ?? null;
        const endBound = maxHoldReached
          ? Math.min(openedAtMs + maxHoldMs, nowMs + twoHoursMs)
          : Math.min((closedAtMs ?? nowMs) + twoHoursMs, nowMs + twoHoursMs);
        const startTime = openedAtMs - CANDLE_MS;
        const endTime = endBound;
        const cacheKey = `${obs.symbol}|${startTime}|${endTime}`;
        let candles = candleCache.get(cacheKey);
        if (!candles) {
          candles = await fetchVariantKlinesRange(binanceClient, obs.symbol, startTime, endTime);
          candleCache.set(cacheKey, candles);
        }

        const resolve1m = async (fillCandleOpenMs: number): Promise<"SL" | "TP" | null> => {
          try {
            const raw1m = await binanceClient.getKlines(obs.symbol, "1m", {
              startTime: fillCandleOpenMs,
              endTime: fillCandleOpenMs + CANDLE_MS,
              limit: 6,
            });
            const E = obs.simulatedEntryPrice;
            const S = obs.simulatedStopLoss;
            const T = obs.simulatedTakeProfitLevels[0] ?? null;
            for (const c of raw1m) {
              const high = Number(c[2]);
              const low = Number(c[3]);
              const slHit = obs.direction === "LONG" ? low <= S : high >= S;
              const tpHit = T !== null && (obs.direction === "LONG" ? high >= T : low <= T);
              if (slHit) return "SL";
              if (tpHit) return "TP";
            }
            return null;
          } catch {
            return null;
          }
        };

        const walk = await walkVariantPath(
          {
            direction: obs.direction,
            entryPrice: obs.simulatedEntryPrice,
            stopLoss: obs.simulatedStopLoss,
            target: obs.simulatedTakeProfitLevels[0] ?? obs.simulatedEntryPrice,
            exitRule: obs.exitRule,
            fillMode: obs.fillMode,
            openedAtMs,
            candles,
            ...(variantDef
              ? { mfeGivebackArmR: effectiveMfeGivebackArmR(variantDef, obs.stopDistanceBps || WIDE_STOP_MIN_BPS) }
              : {}),
            forceCloseAtEnd: maxHoldReached,
          },
          resolve1m,
        );

        if (walk.status === "CLOSED_WIN" || walk.status === "CLOSED_LOSS") {
          const grossR = walk.grossR ?? 0;
          const resolvedAtMs = walk.closedAtMs ?? nowMs;
          const effectiveOpenedAtMs = walk.openedAtMs ?? openedAtMs;
          // Stop-out exits pay extra slippage beyond the flat round-trip; fold it into costR so
          // netR = grossR - costR stays consistent and avgCostR reports the honest cost. This
          // applies to a CLOSED_LOSS (hit the hard stop) AND to an MFE_GIVEBACK_EXIT: a giveback
          // fires on a retrace AGAINST the position, i.e. a sell-stop below (long) / buy-stop above
          // (short), which fills during an adverse move and slips like a stop — even though it
          // banks a small win. Not costing it would over-claim the giveback edge.
          const stopTriggeredExit =
            walk.status === "CLOSED_LOSS" || walk.resolutionSource === "MFE_GIVEBACK_EXIT";
          const stopOutSlipR = stopTriggeredExit
            ? STOP_OUT_SLIPPAGE_BPS / (obs.stopDistanceBps || WIDE_STOP_MIN_BPS)
            : 0;
          const durationMin = Math.max(0, Math.round((resolvedAtMs - effectiveOpenedAtMs) / 60000));
          // Funding: perps pay ~every 8h on notional. In R-terms = (periods × bps/8h) / stopDistanceBps.
          // The old model ignored this, overstating the net of multi-hour/day holds.
          const fundingPeriods = Math.floor(durationMin / (8 * 60));
          const fundingR =
            fundingPeriods > 0
              ? (fundingPeriods * FUNDING_BPS_PER_8H) / (obs.stopDistanceBps || WIDE_STOP_MIN_BPS)
              : 0;
          const effectiveCostR = (obs.costR ?? 0) + stopOutSlipR + fundingR;
          patches.push({
            observationId: obs.observationId,
            patch: {
              status: walk.status,
              grossR,
              costR: effectiveCostR,
              netR: grossR - effectiveCostR,
              resolvedAt: new Date(resolvedAtMs).toISOString(),
              durationMinutes: durationMin,
              maxMfeR: walk.maxMfeR,
              minMaeR: walk.minMaeR,
              resolutionSource: walk.resolutionSource,
              intrabarResolutionStatus: walk.intrabarResolutionStatus,
              isFreshValid: obs.isFreshValid, // preserve creation-time freshness; never clobber it true
            },
          });
          resolved += 1;
        } else if (walk.status === "NO_FILL") {
          patches.push({
            observationId: obs.observationId,
            patch: {
              status: "NO_FILL",
              resolvedAt: new Date(nowMs).toISOString(),
              resolutionSource: walk.resolutionSource ?? "MAKER_NO_FILL",
              isFreshValid: null,
            },
          });
          resolved += 1;
        }
        // else: UNRESOLVED — leave OPEN for a future pass (within EXPIRY_MS)
      } catch {
        // ── Part 2: Harden data-failure path ─────────────────────────────
        // The expiry check already fired for any observation that is old enough,
        // so this catch block only handles observations that are genuinely within
        // the expiry window but whose candle fetch / candle walk threw.
        // Increment the diagnostic counter; leave the observation OPEN so the
        // resolver retries it on the next pass rather than permanently discarding it.
        errors += 1;
        dataFailures += 1;
      }
    }
  } catch {
    // outer report-only guard — never propagates
  }

  // Flush every resolution from this run in ONE write, regardless of how many resolved (see the
  // `patches` comment above) — even if the outer try aborted partway, whatever resolved so far persists.
  try {
    store.bulkUpdate(patches);
  } catch {
    // persistence must never break the report-only resolver
  }

  // ── Persist resolver metadata so the report builder can surface diagnostics ──
  try {
    store.setResolverMeta({
      lastRunAt: new Date(nowMs).toISOString(),
      resolvedCount: resolved,
      expiredCount: expired,
      dataFailureCount: dataFailures,
      errorCount: errors,
      // Advance the rotating Phase-2 start by how many obs this run walked, so the
      // next run picks up where this one stopped instead of re-grinding the front.
      walkCursor: walkCursorStart + walked,
    });
  } catch {
    // meta-save failure must never break the resolver
  } finally {
    // Single flush for the whole run — pairs with the beginBatch() above. Runs no matter how the
    // function above exited (including a throw this function's own guards did not anticipate), so a
    // batch can never leak open and permanently suppress persistence for this store.
    store.endBatch();
  }

  return { resolved, expired, dataFailures, errors };
}

// ---------------------------------------------------------------------------
// Report builder.
// ---------------------------------------------------------------------------
function mean(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return finite.length > 0 ? finite.reduce((s, v) => s + v, 0) / finite.length : null;
}

function profitFactor(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const pos = finite.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const neg = finite.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  return pos > 0 && neg < 0 ? pos / Math.abs(neg) : null;
}

function drawdownAndStreak(orderedNetR: number[]): { drawdownR: number | null; streak: number | null } {
  if (orderedNetR.length === 0) return { drawdownR: null, streak: null };
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let curStreak = 0;
  let maxStreak = 0;
  for (const r of orderedNetR) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    if (r < 0) {
      curStreak += 1;
      if (curStreak > maxStreak) maxStreak = curStreak;
    } else {
      curStreak = 0;
    }
  }
  return { drawdownR: maxDd, streak: maxStreak };
}

export interface VariantRollingStat {
  window: string;
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
}

export interface VariantSegmentStat {
  label: string;
  n: number;
  netAvgR: number | null;
}

export interface VariantBreakdownRow {
  key: string;
  n: number;
  netAvgR: number | null;
  grossAvgR?: number | null;
  pf?: number | null;
  wr?: number | null;
  payoffRatio?: number | null;
  avgWinR?: number | null;
  avgLossR?: number | null;
}

// ---------------------------------------------------------------------------
// Point 4 — per-stage proof evidence (the shape the status ladder actually gates on).
// ---------------------------------------------------------------------------

/**
 * Development-side evidence for ONE stage, computed over that stage's frozen dev interval
 * (`episodeTime < devEndMs`) and nothing else. All-zero / all-null while the stage is unfrozen.
 *
 * These are NOT the headline row fields. The headline (`freshValid`, `effectiveN`, `netAvgR`, …)
 * deliberately reports the FULL fresh-valid population so that live consumers — lane-selector-v2's
 * confidence term, paper-execution-router's admission floor, the REJECT rung — always see current
 * evidence and a lane that turns bad is killed on current evidence. Stage separation is enforced
 * HERE, at the gate, which is the only place it has to hold.
 */
export interface VariantMatrixStageDevEvidence {
  rows: number;
  /** Independent market episodes (computeEffectiveN) over the dev slice alone. */
  effectiveN: number;
  distinctSymbolCount: number;
  distinctRegimes: number;
  netAvgR: number | null;
  pf: number | null;
  payoffRatio: number | null;
  /**
   * +STRESS_EXTRA_BPS round-trip stress mean over the dev slice. This is the same quantity the
   * headline row publishes as `plus10bpsNetAvgR` (identical formula, identical constant) — it is
   * carried once under the stage-neutral name rather than twice under two names, so the dev and
   * holdout sides of a stage can be read side by side.
   */
  stressNetAvgR: number | null;
  approxMaxDrawdownR: number | null;
  topSymbolPnlShare: number | null;
  allThreeOosPositive: boolean;
  calendarDays: number | null;
}

/**
 * Holdout-side evidence for ONE stage, computed over that stage's frozen holdout interval.
 * All-zero / all-null / false while the stage is unfrozen — fail closed, never fail open.
 */
export interface VariantMatrixStageHoldoutEvidence {
  rows: number;
  /**
   * Rows for which the stress figure is genuinely COMPUTABLE (finite `grossR` AND
   * `stopDistanceBps > 0`). Reported separately from `rows` because a holdout can be large and
   * still have uncomputable economics; without this, such a lane stalls forever while its blocker
   * string claims a size shortfall it does not have. `sufficient` requires this to clear the row
   * floor too — a mean taken over a handful of stressable rows is not "valid cost/stress economics".
   */
  stressableRows: number;
  effectiveN: number;
  distinctSymbolCount: number;
  netAvgR: number | null;
  pf: number | null;
  stressNetAvgR: number | null;
  /**
   * THE holdout proof (spec point 4), per stage, with that stage's own thresholds. ALL FIVE of:
   * minimum raw rows, minimum effectiveN, required symbol diversity, valid cost/stress economics
   * (`stressableRows` clears the row floor), and non-negative net / PF / stress. Every term is
   * fail-closed: a null economic reading FAILS rather than passing by absence, which is the hole
   * the outgoing `holdoutNegative` form (`x !== null && x < 0`) left open.
   */
  sufficient: boolean;
  /** Diagnostic split-out of the economics term: net, PF or stress reads actively negative. */
  negative: boolean;
}

/**
 * One immutable stage's complete proof: its frozen window, both sides' evidence, the verdict, and
 * the exact numeric shortfall behind every failing term.
 */
export interface VariantMatrixStageProof {
  stage: VariantMatrixProofStage;
  /** False ⇒ no window has been frozen for this stage yet; `ok` is false and every field below is
   *  at its fail-closed value. */
  frozen: boolean;
  devEndMs: number | null;
  /** null for PROMOTION even when frozen — its holdout is deliberately open-ended (top stage;
   *  nothing above it can be contaminated, and a growing holdout keeps a promoted lane under
   *  permanent live verification). */
  holdoutEndMs: number | null;
  frozenAt: string | null;
  dev: VariantMatrixStageDevEvidence;
  holdout: VariantMatrixStageHoldoutEvidence;
  /** Dev floors AND dev economics AND `holdout.sufficient`, all ANDed. Never OR'd, never blended:
   *  a glowing holdout cannot rescue bad development and strong development cannot rescue a bad
   *  holdout. */
  ok: boolean;
  /** One entry per failing term, each naming the stage, the side, and the numeric shortfall. */
  blockers: string[];
}

/**
 * Point 4e — what has accumulated in the CURRENT evidence version so far, BEFORE any window has been
 * frozen.
 *
 * WHY THIS EXISTS. Every field of `stableProof`/`promotionProof` is fail-closed at 0/null until a
 * window freezes, and freezing needs STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS (60) eligible
 * rows before it is even ATTEMPTED. A lane that has legitimately collected e.g. 5 rows across 3
 * independent episodes therefore renders as an unbroken wall of zeros — indistinguishable on the
 * dashboard from a lane that has collected nothing at all, or from one whose evidence was just reset
 * to zero. That is a real reporting defect: the operator cannot tell "not started" from "collecting,
 * 3 of 10 episodes in".
 *
 * WHAT IT IS NOT. Provisional. Unfrozen. In-sample by construction — it is the whole current
 * population with no dev/holdout split, so it can never be out-of-sample evidence of anything. It is
 * therefore READ-ONLY REPORTING and must never be read by a gate: `deriveVariantStatus` reads
 * `stableProof.ok`/`promotionProof.ok` and nothing here, readiness/promotion/campaign/CORTEX all
 * consume those same frozen proofs, and adding a consumer of these counts to any of them would
 * re-introduce exactly the in-sample self-grading this stage machinery was built to end.
 *
 * Counts come from the SAME `describeIndependentEpisodes` implementation and the SAME
 * `isFreshValidObs` active-evidence filter the frozen proofs are built from, so a provisional
 * episode count can never disagree with the frozen one it will later become.
 */
export interface VariantMatrixPreFreezeCollection {
  /** Eligible rows in the CURRENT evidence version — identical to the row's own `freshValid`
   *  (same `fresh` population), restated here so the section is self-contained. */
  eligibleRows: number;
  /** Independent episodes over those rows, at the variant's CURRENT max-hold width. Identical to the
   *  row's `effectiveN`; named "provisional" here because no window is frozen. */
  provisionalEpisodes: number;
  /** eligibleRows / provisionalEpisodes. Null when there are no episodes yet. High values mean the
   *  rows are clustered into few real draws — the exact illusion effectiveN exists to expose. */
  rowsPerEpisode: number | null;
  calendarDays: number | null;
  distinctSymbolCount: number;
  /** Independent regime EPISODES (run-length-encoded), matching the row's `distinctRegimes`. */
  distinctRegimes: number;
  /** Rows in the single largest independent episode, and its share of `eligibleRows`. The episode-axis
   *  companion to topSymbolPnlShare: 11 rows in 1 episode is not 11 draws. */
  largestEpisodeRows: number;
  largestEpisodeShare: number | null;
  /** Fraction of PnL from the single largest-PnL symbol, same measure the frozen dev gate uses. */
  topSymbolPnlShare: number | null;
  /** Mirrors the lane's evidence-version identity so this section can be read without cross-
   *  referencing another panel — null for lanes with no active reset. */
  evidenceVersion: string | null;
  cutoverSource: "CANONICAL" | "INFERRED";
  /** Exactly what is still missing before a STABLE DEV window can FREEZE, each with its numeric
   *  shortfall. Empty once freezing is possible — which is not the same as the gate passing, and is
   *  deliberately phrased "freeze" rather than "pass" everywhere. */
  freezeBlockers: string[];
  /** The floors the blockers above are measured against, echoed so no consumer hardcodes them. */
  minRowsToAttemptFreeze: number;
  minDevRows: number;
  minDevEpisodes: number;
}

export interface CurrentGuardVariantMatrixRow {
  variantId: VariantMatrixVariantId;
  label: string;
  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  costModel: VariantFillMode;

  /** See LaneEvidenceVersionSummary. All-null/zero for every lane outside
   *  EVIDENCE_RESET_CUTOVER_VARIANT_IDS — dashboards should treat that as "no version split applies"
   *  and render current-population fields as-is, never as a false COLLECTING/legacy state. */
  evidenceVersionSummary: LaneEvidenceVersionSummary;

  total: number;
  open: number;
  resolved: number;
  /**
   * Count of fresh-valid rows in the FULL population (P_all) — every fresh-valid, exact-axis row
   * this proof unit has ever produced, growing for as long as the lane trades.
   *
   * Point 4d, and an explicit reversal of the intermediate behaviour: this is NOT the stage's
   * development slice. Scoping the headline count to a frozen dev window looked like discipline and
   * was a live-path hazard — ~20 downstream consumers (lane-selector-v2's log10(freshValid+1)
   * scoring confidence, paper-execution-router's `>= 50` admission floor, paper-opportunity-
   * allocator's economics gate, every ETA in the OOS snapshot logger) assume a live, growing count,
   * and a bounded one pins them at the boundary value forever. It also has a safety direction: the
   * REJECT rung reads this field, so a lane that turns bad must be killed on CURRENT evidence, not
   * on a slice frozen months earlier.
   *
   * Development/holdout separation is enforced at the GATE instead — see `stableProof`/
   * `promotionProof` below, which are the only things STABLE/PROMOTION read.
   */
  freshValid: number;
  /** Point 3c: count of independent market episodes over the same FULL population (openedAt chained
   *  at the variant's max-hold width, marketEpisodeId/scanBatchId merging on top) — never a raw row
   *  count, and symbol is not part of the grouping at all. Reported as a headline transparency
   *  diagnostic; the STABLE/PROMOTION gates read the per-stage `dev.effectiveN` instead, because
   *  only a frozen window's own episode count can say anything out-of-sample. See computeEffectiveN. */
  effectiveN: number;
  rejected: number;
  noFill: number;
  expired: number;
  dataFailure: number;

  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;

  // Payoff anatomy (computed on netR; breakEvenWR uses the CORRECT 1/(1+payoff)).
  avgWinR: number | null;
  avgLossR: number | null;
  payoffRatio: number | null;
  breakEvenWR: number | null;
  actualWR: number | null;

  avgCostR: number | null;
  costDragR: number | null;
  noFillRate: number | null;
  expiredRate: number | null;
  avgHoldingMinutes: number | null;
  approxMaxDrawdownR: number | null;
  maxAdverseStreak: number | null;
  topSymbolPnlShare: number | null;

  plus10bpsNetAvgR: number | null;
  plus10bpsStillPositive: boolean;

  calendarDays: number | null;
  distinctRegimes: number;
  /** Point 3c: count of distinct `symbol` values in this row's fresh population — reported SEPARATELY
   *  from effectiveN (independent-episode count) so symbol diversity and statistical independence are
   *  never conflated. See STABLE_MIN_DISTINCT_SYMBOLS/PROMOTION_MIN_DISTINCT_SYMBOLS. */
  distinctSymbolCount: number;
  byRegime: VariantBreakdownRow[];
  /** Direction cohort performance for the same fresh-valid row population. */
  byDirection?: VariantBreakdownRow[];
  /** Coarse regime-family cohort; MIXED answers choppy/range performance directly. */
  byRegimeFamily?: VariantBreakdownRow[];
  /** Exact direction x regime-family cohort, e.g. LONG_BULLISH or SHORT_BEARISH. */
  byAxis?: VariantBreakdownRow[];
  /** Exact direction x regime-family x symbol cohort, e.g. SHORT_BEARISH|INJUSDT. */
  byAxisSymbol?: VariantBreakdownRow[];
  byEntryVariant: VariantBreakdownRow[];
  bySymbol: VariantBreakdownRow[];

  oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null;
  allThreeOosPositive: boolean;
  rolling: VariantRollingStat[];

  // Point 4 — the two immutable stage proof windows. At this AGGREGATE level they are
  // diagnostic-only (mirroring effectiveN/distinctRegimes's own aggregate-vs-context split above);
  // see VariantContextEvidenceRow's copies for the ones that actually gate a status.
  /** STABLE stage: dev = episodeTime < devEndMs, holdout = [devEndMs, holdoutEndMs) — BOUNDED, so
   *  it stops growing once frozen, which is exactly what leaves the later rows untouched for
   *  PROMOTION. Fail-closed (frozen:false, ok:false, all counts 0) until a window exists. */
  stableProof: VariantMatrixStageProof;
  /** PROMOTION stage: dev = episodeTime < devEndMs (deliberately SUBSUMES the whole of STABLE's
   *  window — earlier validated evidence is legitimate development material for the next decision),
   *  holdout = episodeTime >= devEndMs, open-ended and, because devEndMs >= stableProof.holdoutEndMs,
   *  DISJOINT from STABLE's holdout by construction. Never frozen before `stableProof` is. */
  promotionProof: VariantMatrixStageProof;
  /** Point 4e — provisional, UNFROZEN collection progress for the current evidence version. Strictly
   *  report-only; see VariantMatrixPreFreezeCollection's own doc for why no gate may read it. */
  preFreezeCollection: VariantMatrixPreFreezeCollection;

  // ---- Legacy aliases of the STABLE stage. Kept at their existing names and shapes so external
  // readers (operator-brief.ts's `stageEvidenceLines`, renamed this round from `devHoldoutLine` when
  // it started rendering BOTH stages) compile unchanged. Nothing new should be built on them; read
  // `stableProof`/`promotionProof` instead.
  /** = stableProof.holdout.rows */
  holdoutFreshValid: number;
  /** = stableProof.holdout.netAvgR */
  holdoutNetAvgR: number | null;
  /** = stableProof.holdout.pf */
  holdoutPf: number | null;
  /** = stableProof.holdout.stressNetAvgR */
  holdoutStressNetAvgR: number | null;
  /** = stableProof.holdout.sufficient. SEMANTIC WIDENING vs. the intermediate tree: this used to
   *  mean "the two SIZE floors are met". It now means the FULL five-term holdout proof (rows,
   *  effectiveN, symbols, computable stress economics, non-negative net/PF/stress). */
  holdoutSufficient: boolean;
  /** = stableProof.holdout.negative */
  holdoutNegative: boolean;
  /** = stableProof.devEndMs, on the proof clock (openedAt). Null while unfrozen. */
  holdoutCutMs: number | null;
  /** = stableProof.holdoutEndMs. Null while unfrozen. */
  holdoutEndMs: number | null;
  /** = stableProof.dev.rows. NOTE this is NOT `freshValid` any more — `freshValid` is the full
   *  population and this is the STABLE window's bounded development slice. They diverge as soon as
   *  the window freezes, which is the point. */
  devN: number;
  /** = stableProof.dev.effectiveN */
  devEffectiveN: number;
  /** = stableProof.holdout.rows */
  holdoutN: number;
  /** = stableProof.holdout.effectiveN */
  holdoutEffectiveN: number;
  /** = stableProof.holdout.distinctSymbolCount */
  holdoutDistinctSymbolCount: number;
  /** = promotionProof.dev.rows — the promotion counterpart of `devN`, exposed so both stages'
   *  counts are inspectable side by side without unpacking the proof structs. */
  promotionDevN: number;
  /** = promotionProof.dev.effectiveN */
  promotionDevEffectiveN: number;
  /** = promotionProof.holdout.rows */
  promotionHoldoutN: number;
  /** = promotionProof.holdout.effectiveN */
  promotionHoldoutEffectiveN: number;

  status: VariantMatrixStatus;
  statusReason: string;
  blockers: string[];
  cautions: string[];

  /** Aggregate-only diagnostic. It must never veto an exact-context proof. */
  aggregateDiagnosticStatus?: VariantMatrixStatus;
  aggregateDiagnosticStatusReason?: string;
  aggregateDiagnosticBlockers?: string[];
  aggregateDiagnosticCautions?: string[];
  applicableContexts?: readonly ExactLaneContext[];
  contextRows?: Partial<Record<ExactLaneContext, VariantContextEvidenceRow>>;
  /** Contexts disagree, so the lane has no universal claim. */
  contextSummary?: "UNIFORM" | "CONTEXT_SPLIT";
}

/**
 * Independent evidence for one canonical proof unit: laneId × exact context.
 * Aggregate metrics deliberately stay on CurrentGuardVariantMatrixRow instead.
 */
export interface VariantContextEvidenceRow {
  context: ExactLaneContext;
  /** FULL fresh-valid population (P_all) for this exact context — see the same-named field on
   *  CurrentGuardVariantMatrixRow for why the headline count is deliberately NOT stage-scoped, and
   *  which live consumers depend on it growing. */
  freshValid: number;
  /** Point 3c: independent-episode count (see computeEffectiveN) over the same FULL population. */
  effectiveN: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
  payoffRatio: number | null;
  plus10bpsNetAvgR: number | null;
  plus10bpsStillPositive: boolean;
  approxMaxDrawdownR: number | null;
  topSymbolPnlShare: number | null;
  calendarDays: number | null;
  distinctRegimes: number;
  /** Point 3c: distinct `symbol` count for THIS exact context's fresh rows — see the same-named field
   *  on CurrentGuardVariantMatrixRow for the full doc comment. This copy is what actually gates
   *  STABLE_CANDIDATE/PROMOTION_CANDIDATE in deriveVariantStatus below. */
  distinctSymbolCount: number;
  oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null;
  allThreeOosPositive: boolean;
  // Point 4 — the two immutable stage proof windows. THIS copy (the exact lane × context proof
  // unit) is the one that actually gates STABLE_CANDIDATE / PROMOTION_CANDIDATE in
  // deriveVariantStatus below. Each context freezes its OWN windows, independently of the aggregate
  // and of every sibling context: a lane can be genuinely proven in LONG_BULLISH while its
  // SHORT_BEARISH stage is still unfrozen or its holdout negative.
  stableProof: VariantMatrixStageProof;
  promotionProof: VariantMatrixStageProof;
  // Legacy aliases of the STABLE stage — see CurrentGuardVariantMatrixRow for the field-by-field
  // mapping. Retained for shape compatibility only; the gate reads the proof structs above.
  holdoutFreshValid: number;
  holdoutNetAvgR: number | null;
  holdoutPf: number | null;
  holdoutStressNetAvgR: number | null;
  holdoutSufficient: boolean;
  holdoutNegative: boolean;
  holdoutCutMs: number | null;
  holdoutEndMs: number | null;
  devN: number;
  devEffectiveN: number;
  holdoutN: number;
  holdoutEffectiveN: number;
  holdoutDistinctSymbolCount: number;
  promotionDevN: number;
  promotionDevEffectiveN: number;
  promotionHoldoutN: number;
  promotionHoldoutEffectiveN: number;
  status: ContextLaneStatus;
  statusReason: string;
  blockers: string[];
  cautions: string[];
}

export interface ContextLaneStatusLookup {
  laneId: string;
  context: ExactLaneContext | null;
  applicable: boolean;
  direct: boolean;
  status: ContextLaneStatus;
  statusReason: string;
  blockers: string[];
  cautions: string[];
  evidence: VariantContextEvidenceRow | null;
}

export interface CurrentGuardVariantMatrixReportOptions {
  capturedAt?: string;
  cutoverTimestamp?: string | null;
  killSwitchReady?: boolean;
  orderReconciliationReady?: boolean;
  exchangeHealthReady?: boolean;
}

export interface VariantMatrixResolverDiagnostics {
  /** ISO timestamp of the last resolver run, or null if the resolver has never run. */
  lastRunAt: string | null;
  /** Number of observations resolved (CLOSED_WIN/CLOSED_LOSS/NO_FILL/EXPIRED) on the last run. */
  resolvedThisRun: number | null;
  /** Number of observations that were newly marked EXPIRED on the last run. */
  expiredThisRun: number | null;
  /** Number of observations where candle fetch / candle walk threw on the last run. */
  dataFailuresThisRun: number | null;
  /** Current count of OPEN observations older than STALE_OPEN_WARN_MS (72 h). */
  staleOpenCount: number;
  /** Age in hours of the oldest OPEN observation in the store, or null when none open. */
  oldestOpenAgeHours: number | null;
  /** Advisory action hint when stale observations are present. */
  nextAction: string | null;
}

/**
 * REPORT-ONLY synthetic "regime-adaptive" lane. Per signal, it takes the CG_WIDE full-exit outcome
 * in a confirmed strong-trend regime and the CG_SCALEOUT outcome otherwise, by PAIRING the existing
 * resolved obs of both variants on the SAME signal (sourceObservationKey). It never admits, resolves
 * or mutates anything — it is a derived measurement that answers "would switching exit by regime beat
 * plain scaleout?". `beatsScaleout` is the bar it must clear to justify a real lane.
 */
export interface RegimeAdaptiveSyntheticReport {
  reportOnly: true;
  note: string;
  /** Signals with a fresh-valid resolved obs in BOTH CG_WIDE and CG_SCALEOUT (the paired population). */
  pairedSignals: number;
  /** Of the paired signals, how many took the full-exit branch (strong trend) vs the scaleout branch (chop). */
  pickedFullExit: number;
  pickedScaleout: number;
  freshValid: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
  oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null;
  allThreeOosPositive: boolean;
  // Apples-to-apples on the SAME paired population:
  scaleoutNetAvgR: number | null;
  fullExitNetAvgR: number | null;
  /** True only when the adaptive netAvgR strictly beats plain scaleout — the promotion bar. */
  beatsScaleout: boolean;
}

export interface CurrentGuardVariantMatrixReport {
  reportOnly: true;
  laneVersion: typeof CURRENT_GUARD_VARIANT_MATRIX_LANE;
  policyVersion: typeof CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION;
  computedAt: string;
  cutoverTimestamp: string | null;
  sourcePopulationNote: string;
  totalObservations: number;
  variantCount: number;
  baselineVariantId: VariantMatrixVariantId;
  rows: CurrentGuardVariantMatrixRow[];
  bestVariantId: VariantMatrixVariantId | null;
  bestVariantNetAvgR: number | null;
  bestBeatsBaseline: boolean;
  /** Resolver run diagnostics — populated from persisted meta + live store state. */
  resolverDiagnostics: VariantMatrixResolverDiagnostics;
  /** Report-only synthetic regime-adaptive lane (full-exit in strong trend, scaleout in chop). */
  regimeAdaptiveSynthetic: RegimeAdaptiveSyntheticReport;
  killSwitchReady: boolean;
  orderReconciliationReady: boolean;
  exchangeHealthReady: boolean;
  /** Always true. The variant matrix never authorizes live trading. */
  liveBlocked: true;
  /** Always false. The variant matrix never enables a micro pilot. */
  microPilotAllowed: false;
  notes: string[];
}

/**
 * 2026-08-05 legacy-evidence reset: the 3 lanes whose maxHoldHours moved 72h -> 36h on 2026-08-04
 * (see the maxHoldHours: 36 fields on their own definitions, and
 * [[maxholdhours-versioning-evidence-integrity-gap-2026-08-05]]) already accumulated real evidence
 * — including transition-forced MAX_HOLD_MTM closes — BEFORE openMaxHoldMs existed. Every one of
 * those rows has openMaxHoldMs===undefined, so the general grandfather clause in isFreshValidObs
 * would count them exactly as it counts any other pre-fix legacy row: silently, forever, blended
 * into whatever the lane's CURRENT (36h) config says.
 *
 * That is the specific gap this constant closes, for these 3 lanes ONLY: undefined no longer
 * grandfathers in. A row counts toward these lanes' evidence if, and only if, it carries a
 * genuine, current-matching openMaxHoldMs — i.e. it was opened AFTER this reset shipped. Nothing
 * about the pre-reset rows is deleted or mutated; they simply stop counting, and remain on disk,
 * readable, for audit (see the operator-run backup taken before this reset was deployed).
 *
 * Every OTHER lane's legacy rows keep grandfathering in exactly as before — this is a narrow,
 * named exception, not a policy change to isFreshValidObs' general contract.
 */
export const EVIDENCE_RESET_CUTOVER_VARIANT_IDS: ReadonlySet<VariantMatrixVariantId> = new Set([
  "CG_WIDE_FAST_LONG",
  "CG_BE_AFTER_05",
  BULL_SCALEOUT_VARIANT_ID,
]);

/** Display-only version label for a row that counts toward one of the reset lanes' evidence — never
 *  used for any grouping/filtering decision (isFreshValidObs above is the only enforcement point).
 *  `null` for every row outside the reset set, and for a reset-lane row that hasn't been proven to
 *  match the current regime (isFreshValidObs would already exclude it from evidence, but a caller
 *  building a diagnostic view over ALL rows — not just fresh-valid ones — must not label an
 *  excluded legacy row as if it belonged to the new version). */
export function evidenceVersionLabel(obs: CurrentGuardVariantMatrixObservation): string | null {
  if (!EVIDENCE_RESET_CUTOVER_VARIANT_IDS.has(obs.variantId)) return null;
  if (obs.openMaxHoldMs === undefined || obs.openMaxHoldMs !== variantMaxHoldMs(obs.variantId)) return null;
  const hours = Math.round(obs.openMaxHoldMs / (60 * 60 * 1000));
  return `${obs.variantId}@${hours}H-v1`;
}

/**
 * The lane's CURRENT evidence-version identity, derived from CONFIG (`variantMaxHoldMs`) rather than
 * from whichever row happens to have closed.
 *
 * WHY CONFIG AND NOT DATA. A lane's active evidence version is a statement about the policy in force
 * RIGHT NOW; it is knowable the instant the config changes and does not depend on a row having
 * resolved under it yet. Deriving it from rows made the label lag reality by up to a full max-hold
 * window: immediately after a width change every existing row is (correctly) legacy, so the row-derived
 * label read `null` — "no current-version evidence yet" — while source, runtime and every newly-opened
 * row were already on the new width. That is precisely the source/runtime/UI disagreement the version
 * label exists to make visible, reproduced by the label itself.
 *
 * Agreement is by construction, not by convention: this reads the SAME `variantMaxHoldMs` that stamps
 * `openMaxHoldMs` on every new row, that `isFreshValidObs` tests rows against, and that supplies
 * `blockWidthMs` for episode clustering. So `evidenceVersionLabel(row) === currentEvidenceVersionLabel(id)`
 * holds for exactly the rows that count, and is `null` for exactly the rows that do not.
 *
 * `resetCutoverAt` deliberately stays row-derived (empirical "when did this version actually start
 * producing evidence") and remains null until a real current row exists — a policy label and an
 * observed start are different facts and are not conflated.
 */
export function currentEvidenceVersionLabel(variantId: VariantMatrixVariantId): string | null {
  if (!EVIDENCE_RESET_CUTOVER_VARIANT_IDS.has(variantId)) return null;
  const hours = Math.round(variantMaxHoldMs(variantId) / (60 * 60 * 1000));
  return `${variantId}@${hours}H-v1`;
}

/** Dashboard/telemetry-only summary of a lane's evidence-version split. Never used by any admission,
 *  sizing, or eligibility decision — those all read `isFreshValidObs`/`freshValid` directly, and this
 *  function's CURRENT branch is verified to agree with `isFreshValidObs` by construction below (same
 *  reset-lane exact-match test, applied to the same field). All-zero/null for every lane outside
 *  EVIDENCE_RESET_CUTOVER_VARIANT_IDS — there is nothing to split for a lane with no reset. */
export interface LaneEvidenceVersionSummary {
  /** The lane's CURRENT evidence-version identity, derived from CONFIG via
   *  `currentEvidenceVersionLabel` — see that function for why config and not row data. Non-null for
   *  every reset lane the moment its width is set, including before any row has closed under it (that
   *  state reads as evidenceVersion set + 0 current rows + N legacy rows, which is the honest
   *  description of a just-reset lane). Null only for a lane outside EVIDENCE_RESET_CUTOVER_VARIANT_IDS. */
  evidenceVersion: string | null;
  /** ISO openedAt of the EARLIEST currently-counting (CURRENT) row — i.e. when this lane's active
   *  evidence version empirically began. There is no stored wall-clock cutover constant (the reset
   *  keys on an exact openMaxHoldMs config match, never a timestamp), so this is derived from data,
   *  not a policy value. Null until at least one CURRENT row exists. */
  resetCutoverAt: string | null;
  resetCutoverAtMs: number | null;
  /** Rows that satisfy every fresh-valid criterion EXCEPT the version match — i.e. would count under
   *  the general (non-reset) grandfather rule, excluded here solely by EVIDENCE_RESET_CUTOVER_VARIANT_IDS.
   *  Never conflated with rows excluded for unrelated reasons (OPEN/REJECTED/EXPIRED/DATA_FAILURE, or
   *  isFreshValid false/null) — those are not "legacy version" exclusions and do not count here. */
  legacyExcludedRows: number;
  legacyExclusionReasons: { reason: string; count: number }[];
  /** Best-effort, MEASURED (not configured — no prior width is stored anywhere once superseded) from
   *  legacy rows whose resolutionSource is exactly "MAX_HOLD_MTM": such a close happens, by
   *  definition, at the max-hold boundary that was live when it was opened, so its durationMinutes is
   *  a real observation of the previous width, not an inferred guess. Null when no such row exists —
   *  never fabricated from a remembered/assumed number. */
  previousEvidenceVersion: string | null;
  /** The lane-family-wide policy version stamped on every observation (variantVersion /
   *  CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION) — the closest REAL, canonical value available
   *  today. Not reset-event-specific (this codebase has no per-reset policy-version stamp; see
   *  resolveCanonicalCutoverMetadata's own doc comment for why). Null only for non-reset lanes. */
  policyVersion: string | null;
  /** CANONICAL only if resolveCanonicalCutoverMetadata found a stored registry entry; INFERRED
   *  whenever evidenceVersion/resetCutoverAt were derived from row data instead (the only path that
   *  exists today — see that function's doc comment). Exposed so a caller/dashboard can distinguish
   *  a stored fact from a computed one rather than silently trusting whichever happened to run. */
  cutoverSource: "CANONICAL" | "INFERRED";
}

const NO_RESET_EVIDENCE_VERSION_SUMMARY: LaneEvidenceVersionSummary = {
  evidenceVersion: null,
  resetCutoverAt: null,
  resetCutoverAtMs: null,
  legacyExcludedRows: 0,
  legacyExclusionReasons: [],
  previousEvidenceVersion: null,
  policyVersion: null,
  cutoverSource: "INFERRED",
};

interface CanonicalCutoverMetadata {
  evidenceVersion: string;
  cutoverAt: string;
  policyVersion: string;
}

/**
 * 2026-08-05: the ONE preferred source for a lane's evidence-version identity — checked FIRST,
 * before any row-level inference is attempted. Returns `null` for every lane today: this codebase
 * has no stored evidence-reset registry for the variant-matrix lane family (confirmed by direct
 * search — no resetRegistry/evidenceRegistry file, no per-observation evidencePolicyVersion/
 * evidenceEra/policyDeploymentAt stamp of the kind forward-causal-collection.ts's CausalIdentity
 * uses, and current-guard-variant-matrix.json's own persisted shape is exactly
 * `{observations, resolverMeta}` — nothing else round-trips through flush()).
 * EVIDENCE_RESET_CUTOVER_VARIANT_IDS + openMaxHoldMs was a deliberate, narrower design choice
 * instead (see that constant's own doc comment) — a genuine registry (the codebase already knows
 * this pattern: base-route-current-guard-frozen.ts's FrozenCriteriaSnapshot stores a real
 * version+frozenAt+policyVersion once, for a different lane family) was never built for this reset.
 *
 * This function is the single place a future registry would be wired in — every caller already
 * reads `cutoverSource` rather than assuming, so adding a real implementation here is the ONLY
 * change that would ever be needed to switch every consumer from INFERRED to CANONICAL.
 */
function resolveCanonicalCutoverMetadata(_variantId: VariantMatrixVariantId): CanonicalCutoverMetadata | null {
  return null;
}

export function summarizeLaneEvidenceVersion(
  variantId: VariantMatrixVariantId,
  obsForVariant: readonly CurrentGuardVariantMatrixObservation[],
): LaneEvidenceVersionSummary {
  if (!EVIDENCE_RESET_CUTOVER_VARIANT_IDS.has(variantId)) return NO_RESET_EVIDENCE_VERSION_SUMMARY;
  const currentMaxHoldMs = variantMaxHoldMs(variantId);
  let evidenceVersion: string | null = null;
  let earliestCurrentMs: number | null = null;
  let excludedAbsent = 0;
  let excludedStale = 0;
  let maxLegacyMaxHoldMtmMinutes: number | null = null;
  for (const obs of obsForVariant) {
    // Every OTHER fresh-valid criterion, deliberately duplicated from isFreshValidObs rather than
    // called (there is no way to ask "would this pass ignoring only the version term" without
    // re-checking the non-version terms) — the version-specific branch below still delegates the
    // CURRENT/legacy split to the exact same `openMaxHoldMs === variantMaxHoldMs(...)` test
    // isFreshValidObs itself uses, so the two functions cannot silently disagree on that test.
    //
    // This classification loop runs REGARDLESS of canonical-vs-inferred below: legacyExcludedRows is
    // a row COUNT, not a registry fact, and there is no canonical source for it even conceptually
    // (a stored registry would supply evidenceVersion/cutoverAt/policyVersion, never a live count of
    // how many rows a growing store currently excludes).
    const wouldBeFreshIgnoringVersion =
      (obs.status === "CLOSED_WIN" || obs.status === "CLOSED_LOSS") &&
      obs.isFreshValid === true &&
      typeof obs.grossR === "number" && Number.isFinite(obs.grossR) &&
      typeof obs.netR === "number" && Number.isFinite(obs.netR);
    if (!wouldBeFreshIgnoringVersion) continue;
    if (obs.openMaxHoldMs !== undefined && obs.openMaxHoldMs === currentMaxHoldMs) {
      const label = evidenceVersionLabel(obs);
      if (label) evidenceVersion = label;
      const openedMs = toMs(obs.openedAt);
      if (openedMs !== null && (earliestCurrentMs === null || openedMs < earliestCurrentMs)) earliestCurrentMs = openedMs;
      continue;
    }
    if (obs.openMaxHoldMs === undefined) {
      excludedAbsent++;
      if (obs.resolutionSource === "MAX_HOLD_MTM" && typeof obs.durationMinutes === "number" && Number.isFinite(obs.durationMinutes)) {
        maxLegacyMaxHoldMtmMinutes = Math.max(maxLegacyMaxHoldMtmMinutes ?? 0, obs.durationMinutes);
      }
    } else {
      excludedStale++;
    }
  }
  const legacyExclusionReasons: { reason: string; count: number }[] = [];
  if (excludedAbsent > 0) {
    legacyExclusionReasons.push({
      reason: "openMaxHoldMs absent (pre-reset row, written before this field existed)",
      count: excludedAbsent,
    });
  }
  if (excludedStale > 0) {
    legacyExclusionReasons.push({
      reason: "openMaxHoldMs stale (recorded value no longer matches this lane's current config)",
      count: excludedStale,
    });
  }
  const legacyExcludedRows = excludedAbsent + excludedStale;
  const previousEvidenceVersion =
    maxLegacyMaxHoldMtmMinutes !== null
      ? `~${Math.round(maxLegacyMaxHoldMtmMinutes / 60)}H (measured from legacy MAX_HOLD_MTM closes)`
      : null;

  const canonical = resolveCanonicalCutoverMetadata(variantId);
  if (canonical) {
    return {
      evidenceVersion: canonical.evidenceVersion,
      resetCutoverAt: canonical.cutoverAt,
      resetCutoverAtMs: toMs(canonical.cutoverAt),
      legacyExcludedRows,
      legacyExclusionReasons,
      previousEvidenceVersion,
      policyVersion: canonical.policyVersion,
      cutoverSource: "CANONICAL",
    };
  }
  return {
    // Config-derived, so it is correct the instant the width changes rather than lagging until a row
    // closes under the new one. `evidenceVersion` (accumulated from rows above) is retained as a
    // cross-check: when any current row exists the two agree by construction, and this asserts that
    // rather than assuming it — a mismatch means a row was stamped with a width the config no longer
    // has, which is exactly the contamination this whole reset mechanism exists to catch.
    evidenceVersion: currentEvidenceVersionLabel(variantId) ?? evidenceVersion,
    resetCutoverAt: earliestCurrentMs !== null ? new Date(earliestCurrentMs).toISOString() : null,
    resetCutoverAtMs: earliestCurrentMs,
    legacyExcludedRows,
    legacyExclusionReasons,
    previousEvidenceVersion,
    policyVersion: CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION,
    cutoverSource: "INFERRED",
  };
}

function isFreshValidObs(obs: CurrentGuardVariantMatrixObservation): boolean {
  return (
    (obs.status === "CLOSED_WIN" || obs.status === "CLOSED_LOSS") &&
    // STRICT check (Point 3a): only an explicit `true` counts. `null` (unresolvable entry lag) and
    // `false` (stale entry) must NOT be treated as fresh — the old `!== false` truthy/defaulted
    // check let ambiguous/unknown-freshness rows through as if they were proven fresh.
    obs.isFreshValid === true &&
    typeof obs.grossR === "number" &&
    Number.isFinite(obs.grossR) &&
    typeof obs.netR === "number" &&
    Number.isFinite(obs.netR) &&
    // 2026-08-05 evidence-integrity fix — see openMaxHoldMs's own doc comment on the interface.
    // `undefined` (every row written before this field existed) is grandfathered in exactly as
    // before; a row that recorded a value which no longer matches the variant's CURRENT max-hold
    // width — because maxHoldHours changed since it opened, whether it went on to resolve organically
    // or was force-closed by that exact change — silently drops out of current evidence rather than
    // being re-chained under a width it was never actually measured against.
    //
    // 2026-08-05 legacy-evidence reset (EVIDENCE_RESET_CUTOVER_VARIANT_IDS, see its own doc comment
    // just above): for the 3 named lanes specifically, `undefined` does NOT grandfather in — those
    // lanes' entire pre-reset population (all of it undefined, since it predates openMaxHoldMs
    // existing at all) must earn its way back in only by matching, never by absence of a field.
    (EVIDENCE_RESET_CUTOVER_VARIANT_IDS.has(obs.variantId)
      ? obs.openMaxHoldMs !== undefined && obs.openMaxHoldMs === variantMaxHoldMs(obs.variantId)
      : obs.openMaxHoldMs === undefined || obs.openMaxHoldMs === variantMaxHoldMs(obs.variantId))
  );
}

/**
 * NOT THE PROOF CLOCK. Exit-time ordering, kept for ONE diagnostic-only consumer (the wide-vs-
 * scaleout paired counterfactual), which sequences realised outcomes rather than market episodes.
 *
 * It must never be reintroduced into the proof path — stage membership, effectiveN, dev/holdout
 * slicing and every economic figure derived from them run on `episodeTimeMsOf` (openedAt) and only
 * on that. Its resolve-time counterpart `resolvedMsOf`, which used to decide dev/holdout
 * membership, has been DELETED rather than left unused, so any accidental reintroduction of a
 * second clock into the proof path is a compile error instead of a silent double-count.
 */
function orderByResolved(a: CurrentGuardVariantMatrixObservation, b: CurrentGuardVariantMatrixObservation): number {
  const am = toMs(a.resolvedAt) ?? toMs(a.openedAt) ?? 0;
  const bm = toMs(b.resolvedAt) ?? toMs(b.openedAt) ?? 0;
  return am - bm;
}

/**
 * THE proof clock — the single timestamp that decides both which stage window a row belongs to and
 * which independent market episode it is a draw from.
 *
 * openedAt ONLY. `resolvedAt` is not consulted, not even as a fallback, and neither is `createdAt`
 * (which records when the ROW was written, not when the position was originated). A row whose
 * openedAt will not parse returns `null` and FAILS CLOSED: it is excluded from every stage slice
 * (it cannot be attributed to a window) and collapses into computeEffectiveN's single shared
 * `undated` node (it can only ever shrink effectiveN, never add a draw).
 *
 * WHY ONE CLOCK, AND WHY THIS ONE. Two independent reasons, both structural:
 *
 *  1. DISJOINTNESS. The design requires each stage's holdout to be a cohort no earlier stage ever
 *     scored. Under resolve-time membership that is FALSE: a trade opened inside STABLE's holdout
 *     window but held past promotionCut.devEndMs resolves into PROMOTION's holdout, so the same
 *     market episode is scored twice as "new and untouched". Under origin-time membership STABLE's
 *     holdout is [devEndMs, holdoutEndMs) and PROMOTION's is [p, inf) with p >= holdoutEndMs, so
 *     the two are disjoint by interval arithmetic.
 *  2. NO MANUFACTURED INDEPENDENCE. Exit timing is an artifact of each position's own geometry —
 *     50 positions opened by one scan cycle exit at 50 different moments as TP, stop and max-hold
 *     each fire on their own schedule. A resolve-time key scores that as up to 50 draws. It is one
 *     look at the market.
 *
 * It also removes the previous model's two-clock anomaly, in which membership ran on resolvedAt
 * while independence ran on openedAt, so a single episode straddling the boundary was counted once
 * on each side and a row could sit in one stage for counting and another for economics.
 */
function episodeTimeMsOf(obs: EpisodeTimedRow): number | null {
  return toMs(obs.openedAt);
}

/** Total order on the proof clock: episodeTime ascending, `observationId` ascending as a stable
 *  tiebreak, rows with no parseable episodeTime last. Deterministic for any input permutation. */
function orderByEpisodeTime(a: CurrentGuardVariantMatrixObservation, b: CurrentGuardVariantMatrixObservation): number {
  const am = episodeTimeMsOf(a);
  const bm = episodeTimeMsOf(b);
  if (am === null || bm === null) {
    if (am !== bm) return am === null ? 1 : -1;
  } else if (am !== bm) {
    return am - bm;
  }
  if (a.observationId < b.observationId) return -1;
  if (a.observationId > b.observationId) return 1;
  return 0;
}

/** One observation reduced to exactly what episode identity needs, and nothing else.
 *  `symbol` is deliberately absent: it is not, and must never become, part of any grouping key. */
export interface EpisodeIdentityRow {
  /** The proof clock (openedAt). `null` = unparseable ⇒ the fail-closed shared bucket. */
  episodeMs: number | null;
  observationId: string;
  batchId: string | null;
  episodeId: string | null;
}

function episodeIdentityRowOf(obs: CurrentGuardVariantMatrixObservation): EpisodeIdentityRow {
  return {
    episodeMs: episodeTimeMsOf(obs),
    observationId: obs.observationId,
    batchId: obs.scanBatchId ?? null,
    episodeId: obs.marketEpisodeId ?? null,
  };
}

/**
 * The single implementation of independent-episode identity. Rows are `push`ed in proof-clock order
 * and `count()` reports the number of independent draws seen so far.
 *
 * WHY A CLASS RATHER THAN A FUNCTION. Two callers need this: computeEffectiveN (fold the whole
 * slice, read once) and the stage-boundary search (read after every row, to find the smallest
 * boundary satisfying an episode floor). Written twice they would eventually disagree, and the two
 * places they would disagree are "how many independent episodes does this cohort have" and "where
 * did we freeze the window that claims that many" — the exact pair that must never drift apart.
 * Folding incrementally also drops the boundary search from O(n^2 log n) to O(n·α(n)).
 *
 * THE ALGORITHM, in order. It is a pure function of the pushed rows and `blockWidthMs`; nothing is
 * mutated on the caller's side and the result never depends on the order rows arrived in the source
 * array (computeEffectiveN sorts defensively; the boundary search is already walking sorted rows).
 *
 *   1. ORIGIN TIME ONLY — see episodeTimeMsOf. `resolvedAt` is unreachable from here.
 *
 *   2. DETERMINISTIC ORDER — (episodeMs asc, observationId asc), undated last.
 *
 *   3. OVERLAP-AWARE GREEDY CHAINING, not wall-clock bucketing. A NEW episode begins only when
 *      `episodeMs - currentEpisodeStartMs >= blockWidthMs`; anything opening closer than that to
 *      its episode's own first row joins that episode, because the earlier position is still in
 *      flight and therefore still correlated. `blockWidthMs` is the variant's own max-hold
 *      characteristic (variantMaxHoldMs), so the window scales with how long one observation of
 *      this geometry can stay live. This is what makes 72 hourly scan batches inside one 72 h
 *      max-hold window ONE episode regardless of where they sit relative to the epoch — the
 *      predecessor's `Math.floor(ms / blockWidthMs)` bucketing counted a scan as a fresh draw
 *      whenever it happened to land in the next wall-clock bucket.
 *      This is the SYMBOL-FREE derived identity, and it is the operative one in practice today.
 *
 *   4. UNION-FIND MERGES over the step-3 nodes. Both identity sources are MERGE-ONLY relations
 *      layered on the time chain: they may collapse nodes, they may never split one. The governing
 *      rule for the whole function is that **effectiveN is non-increasing in the amount of identity
 *      information supplied** — arriving identity can only ever reveal that two apparent draws were
 *      really one, never that one draw was really two.
 *
 *      4a. `marketEpisodeId` — the PREFERRED identity when a producer eventually persists one
 *          (nothing sets it today). Rows sharing a non-empty id are forced into one draw, which
 *          lets a genuine episode spanning two max-hold windows be counted once.
 *          EXPLICIT NARROWING, stated rather than slipped in: the spec says "prefer a real
 *          persisted marketEpisodeId when available", and a literal reading is "replace the derived
 *          identity with the persisted one". This is implemented as MERGE-ONLY, which differs in
 *          exactly one case — when a persisted id would SPLIT rows overlapping inside one
 *          blockWidthMs window into separate draws, merge-only refuses. Splitting is the inflating
 *          direction, and inflating independence is precisely the failure this whole file exists to
 *          stop: an upstream bug minting a fresh id per scan would otherwise silently restore the
 *          effectiveN=1-wearing-N-hats bug through a field nobody is watching. Zero behavioural cost
 *          today (no producer); reversible in one clause plus one test if the operator wants the
 *          literal semantics, but that is a separate, explicit decision.
 *
 *      4b. `scanBatchId` — PROVENANCE, not an independence certificate. A shared scan-batch identity
 *          is real evidence two rows came off one market reading, so it merges them even when
 *          chaining had put them in different episodes. It is NOT sufficient by itself to declare
 *          independence: 100 symbols emitted by one scan cycle share it and are one draw, and 72
 *          DISTINCT hourly batch ids inside one 72 h window are still one draw, because the time
 *          chain — not the batch ids — decides how many nodes exist, and distinct ids merge nothing.
 *          One consequence, stated rather than hidden: merging is transitive, so a batch id spanning
 *          two far-apart episodes also pulls in every unbatched row that chained into either. That
 *          direction is conservative (it can only lower effectiveN), which is why it is acceptable.
 *
 *      Merges attach to the lower node index so the resulting partition never depends on merge order.
 *
 *   5. effectiveN = the number of connected components.
 *
 * DEFENSIVE BRANCH: when `blockWidthMs` is not a positive finite number there is no episode length
 * to reason with, so the whole slice counts as ONE draw. It deliberately does NOT fall back to
 * per-row groups (an older behavior, which returned obs.length) — that would be the single most
 * inflationary answer available at exactly the moment the function has the least information.
 * Unreachable from production today: every call site passes variantMaxHoldMs(), a Math.min of two
 * positive finite literals. No rows pushed ⇒ 0.
 *
 * NOTE FOR THE BOUNDARY SEARCH: `count()` is NOT monotone in the number of rows pushed. A row that
 * opens a new node and simultaneously merges two previously-separate components lowers the count.
 * That is why the search evaluates its predicate at every row instead of binary-searching a presumed
 * monotone predicate.
 *
 * WHY ONE EPISODE CANNOT BE COUNTED ON BOTH SIDES OF A BOUNDARY. Chaining RESTARTS inside whichever
 * slice it is handed, so a slice that begins mid-episode would open a fresh node for the tail of an
 * episode the other slice has already counted — one real market window, two "independent" draws.
 * Disjoint openedAt ranges are NOT sufficient to prevent that (they were the whole of the previous
 * argument here, and the claim was false as written): an interval boundary can land strictly inside
 * an episode just as easily as between two. Two mechanisms together make it true:
 *
 *   (i)  MEMBERSHIP CLOCK. Both slicing and independence read openedAt only (episodeTimeMsOf), so a
 *        row is in exactly one slice for counting and the same one for economics. Under the previous
 *        resolvedAt-membership model a position opened before a boundary and resolved after it was
 *        development for independence and holdout for economics simultaneously.
 *   (ii) EPISODE-ALIGNED BOUNDARIES. Every frozen boundary is snapped to an episode EDGE by
 *        episodeEdgeMsOf — a timestamp at which this partition cuts no episode in half. A boundary
 *        can therefore never fall strictly inside an episode, dev ends on a whole episode and the
 *        holdout opens with the next episode's FIRST row. Because the slice then starts exactly
 *        where a chain node starts, the restarted chain reproduces this partition restricted to the
 *        slice, and devEffectiveN + holdoutEffectiveN === effectiveN over their union — an identity
 *        the seam used to break by exactly one episode per boundary.
 *
 * Neither is decorative: drop (i) and exit geometry manufactures independence; drop (ii) and the
 * boundary search re-splits an episode the instant the effectiveN floor binds before the row floor.
 *
 * Symbol diversity (how many distinct symbols contributed) is a SEPARATE concern — see
 * distinctSymbolCount and STABLE_MIN_DISTINCT_SYMBOLS/PROMOTION_MIN_DISTINCT_SYMBOLS. It must never
 * be conflated with independence: a cohort can have effectiveN=50 and distinctSymbolCount=1 (one
 * symbol, many genuinely separate episodes) or effectiveN=1 and distinctSymbolCount=100 (100
 * symbols, one shared episode) — both are real, and reporting only one of the two would hide either
 * the "not enough independent evidence" risk or the "not genuinely market-wide" risk.
 */
class EpisodeAccumulator {
  private readonly blockWidthMs: number;
  private readonly degenerate: boolean;
  /** Union-find parent array over episode nodes. Index = node id, in allocation order. */
  private readonly parent: number[] = [];
  private readonly firstNodeForEpisodeId = new Map<string, number>();
  private readonly firstNodeForBatch = new Map<string, number>();
  private currentEpisodeNode = -1;
  private currentEpisodeStartMs = 0;
  /** The single shared fail-closed node for rows with no parseable origin time. Allocated lazily so
   *  a shared scanBatchId/marketEpisodeId can still merge it into a real episode. */
  private undatedNode = -1;
  private pushedAny = false;

  constructor(blockWidthMs: number) {
    this.blockWidthMs = blockWidthMs;
    this.degenerate = !Number.isFinite(blockWidthMs) || blockWidthMs <= 0;
  }

  private allocateNode(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }

  private find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let cursor = node;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor]!;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  private union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // Attach to the lower index so the result is independent of merge order.
    this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  }

  private mergeOnKey(index: Map<string, number>, key: string, node: number): void {
    const seen = index.get(key);
    if (seen === undefined) index.set(key, node);
    else this.union(seen, node);
  }

  /**
   * Rows MUST arrive in the order defined by orderByEpisodeTime for the chaining to be correct.
   *
   * Returns the NODE this row was attached to. computeEffectiveN and the floor search ignore it and
   * only read `count()`; `episodeEdgeMsOf` needs it, because "where may a boundary be placed" is a
   * question about WHICH rows share an episode, not about how many episodes there are. Handing back
   * the node (rather than exposing the partition) keeps this class the single owner of episode
   * identity — the same reason count() lives here (see WHY A CLASS RATHER THAN A FUNCTION above).
   */
  push(row: EpisodeIdentityRow): number {
    this.pushedAny = true;
    if (this.degenerate) return 0; // one draw, whatever arrives — nothing to chain or merge.
    let node: number;
    if (row.episodeMs === null) {
      if (this.undatedNode < 0) this.undatedNode = this.allocateNode();
      node = this.undatedNode;
    } else if (this.currentEpisodeNode < 0 || row.episodeMs - this.currentEpisodeStartMs >= this.blockWidthMs) {
      this.currentEpisodeStartMs = row.episodeMs;
      this.currentEpisodeNode = this.allocateNode();
      node = this.currentEpisodeNode;
    } else {
      node = this.currentEpisodeNode;
    }
    // Merge-only, in preference order. Neither can split a node; see the class doc, step 4.
    if (row.episodeId) this.mergeOnKey(this.firstNodeForEpisodeId, row.episodeId, node);
    if (row.batchId) this.mergeOnKey(this.firstNodeForBatch, row.batchId, node);
    return node;
  }

  /**
   * The union-find ROOT of a node handed back by `push`. Two rows belong to the same independent
   * episode iff their roots are equal, so this is the per-row view of the same partition `count()`
   * summarises — one implementation, no second opinion about what an episode is.
   *
   * Only meaningful once EVERY row of the cohort has been pushed: a merge arriving later can still
   * fuse two nodes that were separate when the earlier row was pushed. Degenerate width ⇒ one shared
   * root, which is the per-row form of count()===1 and correctly admits no interior boundary at all.
   */
  rootOf(node: number): number {
    if (this.degenerate) return 0;
    return this.find(node);
  }

  /** Independent draws seen so far. Safe to call after every push. */
  count(): number {
    if (!this.pushedAny) return 0;
    if (this.degenerate) return 1;
    const roots = new Set<number>();
    for (let node = 0; node < this.parent.length; node += 1) roots.add(this.find(node));
    return roots.size;
  }
}

/**
 * Point 3c — effectiveN: count of DISTINCT INDEPENDENT MARKET EPISODES, not a raw row count and
 * never one-per-symbol. Per this repo's own standing methodology (CLAUDE.md: "Signals fire on
 * several symbols at the same instant from one market-wide reading; those are one observation"),
 * multiple symbols originating off the SAME shared episode are ONE independent draw, full stop —
 * symbol must never be crossed into the grouping key (a prior version of this function did exactly
 * that and produced effectiveN=100 for 100 symbols firing off one scan cycle, when the true
 * independent-draw count for that episode is 1).
 *
 * Thin wrapper over EpisodeAccumulator — read that class's doc comment for the algorithm, the
 * merge-only identity rules, and the defensive branch. The defensive sort here is what makes the
 * result independent of the input array's order; the boundary search feeds the same accumulator
 * rows it has already sorted, so the two can never disagree about a cohort.
 */
function computeEffectiveN(obs: readonly CurrentGuardVariantMatrixObservation[], blockWidthMs: number): number {
  if (obs.length === 0) return 0;
  return countIndependentEpisodes(obs.map(episodeIdentityRowOf), blockWidthMs);
}

/**
 * THE independent-episode count for any already-identity-mapped cohort — the exact rule
 * `computeEffectiveN` uses, exposed for report-only consumers whose rows do not live in the variant
 * matrix (research/telemetry over a lane-specific store, which has its own row shape but must never
 * get its own second definition of "independent draw").
 *
 * Deliberately generic over `EpisodeIdentityRow` rather than `CurrentGuardVariantMatrixObservation`:
 * `EpisodeAccumulator` already only ever needed {episodeMs, observationId, batchId, episodeId}, so a
 * caller adapts its rows once and inherits the union-find merge rules, the fail-closed undated
 * bucket, and the defensive sort unchanged. `computeEffectiveN` now delegates here, so there is
 * exactly ONE implementation — the same discipline EpisodeAccumulator's own doc comment states
 * ("Written twice they would eventually disagree").
 *
 * Deterministic and restart-stable: a pure function of the rows and the width. The sort is a total
 * order (episodeMs, then observationId), so the result is independent of input permutation, and
 * nothing here reads a clock, a store, or any mutable module state.
 */
export function countIndependentEpisodes(
  rows: readonly EpisodeIdentityRow[],
  blockWidthMs: number,
): number {
  return describeIndependentEpisodes(rows, blockWidthMs).episodes;
}

/**
 * The canonical independent-episode partition, exposed for research consumers
 * that need to persist a per-row assignment after their observations exist.
 *
 * This is deliberately a partition rather than a second episode-ID algorithm:
 * the returned numeric component is only meaningful within this invocation.
 * Callers that need a durable ID must hash their own non-strategy identity
 * inputs together with their versioned policy.  `observationId` is used only
 * as a stable row binding/tie-breaker and never as an episode identity key.
 */
export function partitionIndependentEpisodes(
  rows: readonly EpisodeIdentityRow[],
  blockWidthMs: number,
): ReadonlyMap<string, number> {
  const sorted = rows.slice();
  const seen = new Set<string>();
  for (const row of sorted) {
    if (!row.observationId || seen.has(row.observationId)) throw new Error("EPISODE_PARTITION_OBSERVATION_ID_INVALID");
    seen.add(row.observationId);
  }
  sorted.sort((a, b) => {
    if (a.episodeMs === null || b.episodeMs === null) {
      if (a.episodeMs !== b.episodeMs) return a.episodeMs === null ? 1 : -1;
    } else if (a.episodeMs !== b.episodeMs) {
      return a.episodeMs - b.episodeMs;
    }
    if (a.observationId < b.observationId) return -1;
    if (a.observationId > b.observationId) return 1;
    return 0;
  });
  const accumulator = new EpisodeAccumulator(blockWidthMs);
  const nodes = sorted.map((row) => accumulator.push(row));
  return new Map(sorted.map((row, index) => [row.observationId, accumulator.rootOf(nodes[index]!)]));
}

/** The independent-episode partition of a cohort, described rather than merely counted.
 *
 *  `episodes` is bit-for-bit what `countIndependentEpisodes` returns (that function delegates here),
 *  so a caller can never show an episode COUNT that disagrees with the episode SIZES beside it.
 *  `largestEpisodeRows` answers the concentration question a bare count cannot — "is this cohort's
 *  independence real, or is one episode carrying most of the rows" — which is the same hazard
 *  topSymbolPnlShare exists for, on the episode axis instead of the symbol axis.
 *
 *  Sizes come from `EpisodeAccumulator.rootOf` — the class's own per-row view of the partition
 *  `count()` summarises — so this adds NO second opinion about what an episode is (the exact thing
 *  EpisodeAccumulator's doc comment forbids). Report-only: nothing here gates any stage.
 */
export function describeIndependentEpisodes(
  rows: readonly EpisodeIdentityRow[],
  blockWidthMs: number,
): { episodes: number; largestEpisodeRows: number } {
  if (rows.length === 0) return { episodes: 0, largestEpisodeRows: 0 };
  const partition = partitionIndependentEpisodes(rows, blockWidthMs);
  const rowsPerRoot = new Map<number, number>();
  for (const root of partition.values()) {
    rowsPerRoot.set(root, (rowsPerRoot.get(root) ?? 0) + 1);
  }
  let largestEpisodeRows = 0;
  for (const count of rowsPerRoot.values()) {
    if (count > largestEpisodeRows) largestEpisodeRows = count;
  }
  return { episodes: rowsPerRoot.size, largestEpisodeRows };
}

/**
 * Point 3d — distinctRegimes as independent regime EPISODES, not distinct string labels. Chronological
 * run-length-encoding over `observationRegimeFamilyKey`: an episode boundary is only counted when the
 * FAMILY changes from the immediately-preceding (chronologically-ordered) observation. Many rows drawn
 * from the same underlying episode (e.g. a drifting label "BULLISH_EXPANSION" -> "BULLISH_PRESSURE",
 * both family BULLISH) collapse to ONE episode; a real regime flip (BULLISH -> BEARISH -> BULLISH)
 * counts as separate episodes even if the family label repeats later. Input MUST already be sorted
 * chronologically on the proof clock (both call sites sort via orderByEpisodeTime before calling
 * this). Entry-time order is also the semantically correct order here: the question this answers is
 * "what regime was the market in when this trade was ENTERED", which exit time cannot say.
 */
function countDistinctRegimeEpisodes(chronologicalObs: readonly CurrentGuardVariantMatrixObservation[]): number {
  let episodes = 0;
  let prevFamily: AxisRegimeFamily | null = null;
  for (const obs of chronologicalObs) {
    const family = observationRegimeFamilyKey(obs);
    if (family !== prevFamily) {
      episodes += 1;
      prevFamily = family;
    }
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// Point 4 — stage proof windows: membership predicates, boundary search, freeze.
// See the STAGE-SPECIFIC IMMUTABLE PROOF WINDOWS block near the threshold constants for the model,
// the reachability arithmetic and the discipline that binds the holdout economics.
// ---------------------------------------------------------------------------

/** The minimum shape the stage machinery needs from a row: the proof clock, and nothing else. */
type EpisodeTimedRow = Pick<CurrentGuardVariantMatrixObservation, "openedAt">;

/** The three populations a frozen stage window partitions its input into. `undated` rows carry no
 *  parseable proof clock, so they cannot be attributed to a window at all and belong to NEITHER
 *  side — surfaced separately rather than silently swept into development. */
export interface VariantMatrixStageSlices<T> {
  dev: T[];
  holdout: T[];
  undated: T[];
}

/**
 * THE stage membership predicate, exported so the same pure function that the report builds on can
 * be exercised directly (e.g. to prove that STABLE's holdout and PROMOTION's holdout share no row).
 *
 *   dev     = episodeTime <  cut.devEndMs
 *   holdout = cut.devEndMs <= episodeTime < cut.holdoutEndMs   (holdoutEndMs null ⇒ no upper bound)
 *
 * Membership is a pure function of the frozen boundaries and each row's OWN timestamp — never of
 * what else is in the array. Two rows can therefore never trade places because a third arrived.
 * With no cut, everything fails closed into `undated`-adjacent emptiness: both slices are empty,
 * which is what every holdout-derived field must read while a stage is unfrozen.
 */
export function stageSlicesForCut<T extends EpisodeTimedRow>(
  rows: readonly T[],
  cut: VariantMatrixStageCut | null | undefined,
): VariantMatrixStageSlices<T> {
  const dev: T[] = [];
  const holdout: T[] = [];
  const undated: T[] = [];
  for (const row of rows) {
    const ms = episodeTimeMsOf(row);
    if (ms === null) {
      undated.push(row);
      continue;
    }
    if (!cut) continue;
    if (ms < cut.devEndMs) dev.push(row);
    else if (cut.holdoutEndMs === null || ms < cut.holdoutEndMs) holdout.push(row);
  }
  return { dev, holdout, undated };
}

// (A standalone `rowsBeforeEpisodeTime(rows, boundary)` helper lived here while the headline row
// fields were dev-scoped. It is gone: `stageSlicesForCut` is now the ONLY way to split a population
// by a stage boundary, so there is exactly one membership rule and no second one to drift.)

/** A row that is known to carry a parseable proof clock. */
type DatedEpisodeRow = EpisodeIdentityRow & { episodeMs: number };

/**
 * THE EPISODE EDGES of an already-sorted, dated row list: every timestamp `t` for which the split
 * `{r : episodeMs(r) < t}` / `{r : episodeMs(r) >= t}` cuts NO independent episode in half. These
 * are the ONLY timestamps a stage boundary may be frozen at.
 *
 * WHY THIS EXISTS. Without it the searches below place a boundary the instant both floors are met.
 * Whenever the effectiveN floor binds before the row floor — i.e. whenever a lane averages MORE than
 * minRows/minEffectiveN fresh closes per max-hold window (40/10 = 4.0 for STABLE dev) — that instant
 * is the arrival of the FIRST row of the Nth episode, so the boundary lands one row into a live
 * episode. A 1-row stub then closes development while the REST OF THE SAME max-hold window opens the
 * holdout, and because chaining restarts per slice that tail is counted as a brand-new independent
 * draw. Measured on synthetic cohorts at 5, 8 and 20 closes/window, dev+holdout claimed exactly one
 * more episode than their union every time (15 claimed vs 14 real). One real market episode was
 * being counted as an independent draw on BOTH sides of the boundary, which is the single thing the
 * whole stage-window design exists to prevent.
 *
 * THE PARTITION, not just the time chain. An "episode" here is a connected component of
 * EpisodeAccumulator's partition — the openedAt chain PLUS the marketEpisodeId/scanBatchId merges.
 * Using the raw chain would be wrong in the one case it differs: a shared scanBatchId can fuse two
 * chain nodes that are far apart in time, and a boundary between them would split that component
 * into two counted draws. Asking the accumulator for each row's ROOT costs one extra pass and closes
 * that hole too, so "episode" means the same thing here as it does in effectiveN.
 *
 * ALGORITHM. Push every row, resolve each row's root only AFTER the last push (a late merge still
 * fuses earlier nodes), record the last row index of each component, then sweep forward carrying
 * `reach` = the furthest row index any component seen so far still extends to. A cut immediately
 * before row `i` is safe exactly when `reach < i`, and the timestamp that expresses it is
 * `sorted[i].episodeMs` (membership is `< b`, so row `i` and everything tied with it lands on the
 * holdout side). O(n·α(n)) — the same order as the searches it feeds.
 *
 * WHAT THIS DOES AND DOES NOT SUBSUME. Two rows sharing an episodeMs always chain into the SAME node
 * (`episodeMs - currentEpisodeStartMs` is 0 for the second one, which is < blockWidthMs for any
 * positive width), so an edge timestamp is always the FIRST instant of its component and the frozen
 * boundary VALUE can never depend on the sort's tiebreak. That much the predecessor tie-guard was
 * for, and it is genuinely subsumed. What is NOT subsumed is evaluating the stage FLOORS at the
 * right place: an edge is a timestamp, a floor is checked at a row INDEX, and when a group holds
 * several rows the two only line up at the group's first index. smallestPrefixBoundary keeps an
 * explicit `opensGroup` test for exactly that, and dropping it froze a window one episode below its
 * own floor — see the note there.
 *
 * DEGENERATE WIDTH: every row shares one root, `reach` covers the whole list from index 0, so the
 * only edge is the very first timestamp and no interior boundary exists. That is the correct reading
 * of "the whole slice is one draw" and it fails closed (no freeze) rather than open.
 */
function episodeEdgeMsOf(sorted: readonly DatedEpisodeRow[], blockWidthMs: number): ReadonlySet<number> {
  const edges = new Set<number>();
  if (sorted.length === 0) return edges;
  const accumulator = new EpisodeAccumulator(blockWidthMs);
  const nodeOfRow = sorted.map((row) => accumulator.push(row));
  const rootOfRow = nodeOfRow.map((node) => accumulator.rootOf(node));
  const lastRowOfEpisode = new Map<number, number>();
  for (let i = 0; i < rootOfRow.length; i += 1) lastRowOfEpisode.set(rootOfRow[i]!, i);
  let reach = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    if (reach < i) edges.add(sorted[i]!.episodeMs);
    reach = Math.max(reach, lastRowOfEpisode.get(rootOfRow[i]!)!);
  }
  return edges;
}

/**
 * Smallest EPISODE-ALIGNED boundary `b` such that the prefix `{r : episodeMs(r) < b}` of an
 * already-sorted, dated row list satisfies BOTH floors, or null when no such prefix exists yet.
 *
 * `episodeEdgeMs` is the edge set of the FULL population (see episodeEdgeMsOf), not of `sorted`:
 * every list handed to this function is a contiguous range of that population, and a timestamp that
 * splits no episode of the whole splits no episode of any range of it. Passing the shared set is
 * also what makes the dev boundary and the holdout boundary agree about where episodes end.
 *
 * Smallest-first is deliberate, not incidental: the minimal boundary leaves the maximum amount of
 * data available to the holdout and to every later stage, so later stages become reachable as early
 * as the evidence allows. It is also deterministic given the population.
 *
 * THE PRICE, stated rather than buried: a boundary can no longer be placed after the last row, so a
 * partially-filled trailing window does not count. The floors must be cleared by episodes the data
 * has already shown to be CLOSED — some later row must have opened the next episode — which costs
 * one further max-hold window of calendar per boundary. See the REACHABILITY table for the exact
 * day counts; they went UP, and no threshold was lowered to hide that.
 *
 * The predicate is evaluated at EVERY eligible row rather than binary-searched: `count()` is not
 * monotone in rows pushed (a merge can lower it), so a bisection would be unsound. Restricting the
 * candidates to edges does not restore monotonicity and is not an excuse to bisect.
 */
function smallestPrefixBoundary(
  sorted: readonly DatedEpisodeRow[],
  blockWidthMs: number,
  minRows: number,
  minEffectiveN: number,
  episodeEdgeMs: ReadonlySet<number>,
): number | null {
  const accumulator = new EpisodeAccumulator(blockWidthMs);
  for (let i = 0; i < sorted.length; i += 1) {
    // Candidate boundary immediately BEFORE row i, i.e. development = rows [0, i). The accumulator
    // has not yet seen row i, so count() is exactly that prefix's episode count.
    //
    // `opensGroup` is the TIE-GUARD and it is load-bearing, not defensive. Membership is `< b`, so a
    // boundary of `sorted[i].episodeMs` excludes the WHOLE timestamp group row i belongs to — but
    // `i` and `count()` describe the prefix [0, i), which for a mid-group `i` still CONTAINS part of
    // that group. Testing the floors there measures a prefix the boundary will never produce, and
    // the frozen window comes out one episode short of its own floor. (Observed, not hypothesised:
    // six closes fired off one scan instant per episode froze STABLE at devEffectiveN 9 against a
    // floor of 10, because index 55 saw ten episodes while the boundary at that timestamp only
    // delivered nine. See [STAGE-BOUNDARY-TIE].)
    const opensGroup = i === 0 || sorted[i - 1]!.episodeMs !== sorted[i]!.episodeMs;
    if (
      opensGroup &&
      i >= minRows &&
      episodeEdgeMs.has(sorted[i]!.episodeMs) &&
      accumulator.count() >= minEffectiveN
    ) {
      return sorted[i]!.episodeMs;
    }
    accumulator.push(sorted[i]!);
  }
  return null;
}

/** effectiveN over an already-sorted dated slice, using the one shared implementation. */
function effectiveNOfSorted(sorted: readonly DatedEpisodeRow[], blockWidthMs: number): number {
  const accumulator = new EpisodeAccumulator(blockWidthMs);
  for (const row of sorted) accumulator.push(row);
  return accumulator.count();
}

interface StageFreezeInputs {
  /** Every fresh row with a parseable proof clock, ascending. */
  readonly all: readonly DatedEpisodeRow[];
  /** The prefix of `all` that has certainly settled — the only place a boundary may be placed. */
  readonly settled: readonly DatedEpisodeRow[];
  readonly blockWidthMs: number;
  /** Episode edges of `all` (episodeEdgeMsOf). Computed ONCE per proof unit and shared by every
   *  search, so STABLE's two boundaries and PROMOTION's boundary cannot disagree about where an
   *  episode ends. `all` rather than `settled` on purpose: an episode whose tail sits beyond the
   *  quarantine horizon is still one episode, and a boundary must not split it either. */
  readonly episodeEdgeMs: ReadonlySet<number>;
}

/**
 * STABLE window search: the smallest `devEndMs` clearing the development floors, then the smallest
 * `holdoutEndMs` clearing the holdout floors over `[devEndMs, ...)`. Both boundaries must sit inside
 * the settlement quarantine, both are found in one forward pass each, and BOTH are episode-aligned.
 *
 * BOTH, not just `devEndMs`. `devEndMs` alignment is what stops STABLE's own dev and holdout sharing
 * an episode. `holdoutEndMs` alignment is what stops STABLE's holdout sharing one with PROMOTION's
 * cohorts, since PROMOTION's boundary is >= this value: an episode straddling `holdoutEndMs` would
 * be scored as an independent confirmation of STABLE and, in its other half, as development for the
 * promotion decision. Aligning it also makes devEffectiveN + holdoutEffectiveN === effectiveN over
 * the union `[.., holdoutEndMs)` an exact identity rather than an approximation.
 *
 * Returns null when no split satisfying all four floors exists yet — in which case NO cut is frozen
 * and every stage-derived field stays at its fail-closed value, exactly as when nothing had ever
 * been collected. A partially-satisfiable split is never frozen "to be completed later": the two
 * boundaries are chosen and locked together so that a later stage cannot redraw either one.
 */
function findStableWindow(inputs: StageFreezeInputs): { devEndMs: number; holdoutEndMs: number } | null {
  const devEndMs = smallestPrefixBoundary(
    inputs.settled,
    inputs.blockWidthMs,
    STABLE_MIN_DEV_ROWS,
    STABLE_MIN_EFFECTIVE_N,
    inputs.episodeEdgeMs,
  );
  if (devEndMs === null) return null;
  const holdoutCandidates = inputs.settled.filter((row) => row.episodeMs >= devEndMs);
  const holdoutEndMs = smallestPrefixBoundary(
    holdoutCandidates,
    inputs.blockWidthMs,
    STABLE_MIN_HOLDOUT_ROWS,
    STABLE_MIN_HOLDOUT_EFFECTIVE_N,
    inputs.episodeEdgeMs,
  );
  if (holdoutEndMs === null) return null;
  return { devEndMs, holdoutEndMs };
}

/**
 * PROMOTION window search: the smallest `p >= stableHoldoutEndMs` (and inside the quarantine) whose
 * development prefix clears the promotion development floors AND whose OPEN-ENDED suffix clears the
 * promotion holdout floors.
 *
 * `p >= stableHoldoutEndMs` is the single line that makes the two stages' holdout cohorts disjoint:
 * STABLE's holdout is bounded above at exactly that value, so no row can be in both. Change the
 * comparison and the "new and untouched" claim silently becomes false.
 *
 * PROMOTION's holdout is deliberately open-ended: it is the top stage, nothing above it can be
 * contaminated by its growth, and a growing holdout keeps an already-promoted lane under permanent
 * live verification. That is also why the suffix is taken over `all` rather than `settled` — a row
 * opened after the quarantine horizon is legitimately part of the ongoing holdout even though no
 * boundary may be placed there.
 *
 * EPISODE ALIGNMENT. Every candidate is an episode edge of the full population (episodeEdgeMsOf), so
 * promotion's development and its open-ended holdout can never share a market episode either. The
 * seed candidate `stableHoldoutEndMs` needs no separate check: it was itself frozen as an edge by
 * findStableWindow. One documented limitation — an already-frozen boundary is never re-validated, so
 * if a LATER-arriving row carried a scanBatchId/marketEpisodeId that fused an episode across that
 * frozen boundary, the boundary stays where it is. Nothing in the repo writes marketEpisodeId, and a
 * scanBatchId identifies one scan cycle whose rows share an instant, so this is a theoretical hole,
 * not a live one; the alternative (moving a frozen boundary) would break immutability, which is the
 * more valuable property.
 *
 * Cost control: candidates are walked in increasing order with the development accumulator folded
 * incrementally, and the walk STOPS as soon as fewer than PROMOTION_MIN_HOLDOUT_ROWS rows remain in
 * the suffix — that count is strictly non-increasing in `p`, so no later candidate can recover.
 */
function findPromotionBoundary(inputs: StageFreezeInputs, stableHoldoutEndMs: number): number | null {
  const { all, settled, blockWidthMs, episodeEdgeMs } = inputs;
  // A boundary must sit inside the quarantine. If stable's holdout ends beyond it, nothing is
  // eligible yet. Boundaries are now row timestamps rather than `timestamp + 1`, so the ceiling is
  // the last settled row's own timestamp.
  const maxBoundary = settled.length > 0 ? settled[settled.length - 1]!.episodeMs : Number.NEGATIVE_INFINITY;
  if (stableHoldoutEndMs > maxBoundary) return null;

  const candidates: number[] = [stableHoldoutEndMs];
  for (let i = 0; i < settled.length; i += 1) {
    const boundary = settled[i]!.episodeMs;
    if (boundary <= stableHoldoutEndMs) continue;
    if (!episodeEdgeMs.has(boundary)) continue;
    if (candidates[candidates.length - 1] === boundary) continue; // ascending ⇒ dedupe against last
    candidates.push(boundary);
  }

  const devAccumulator = new EpisodeAccumulator(blockWidthMs);
  let devCount = 0;
  let holdoutStart = 0;
  for (const boundary of candidates) {
    while (devCount < settled.length && settled[devCount]!.episodeMs < boundary) {
      devAccumulator.push(settled[devCount]!);
      devCount += 1;
    }
    while (holdoutStart < all.length && all[holdoutStart]!.episodeMs < boundary) holdoutStart += 1;
    if (all.length - holdoutStart < PROMOTION_MIN_HOLDOUT_ROWS) break; // strictly non-increasing
    if (devCount < PROMOTION_MIN_DEV_ROWS) continue;
    if (devAccumulator.count() < PROMOTION_MIN_EFFECTIVE_N) continue;
    const holdoutAccumulator = new EpisodeAccumulator(blockWidthMs);
    for (let i = holdoutStart; i < all.length; i += 1) holdoutAccumulator.push(all[i]!);
    if (holdoutAccumulator.count() >= PROMOTION_MIN_HOLDOUT_EFFECTIVE_N) return boundary;
  }
  return null;
}

/** Freeze diagnostics for a window, computed once at the freeze instant and never re-scored. */
function stageFreezeDiagnostics(
  inputs: StageFreezeInputs,
  devEndMs: number,
  holdoutEndMs: number | null,
): Pick<
  VariantMatrixStageCut,
  "devRowsAtFreeze" | "devEffectiveNAtFreeze" | "holdoutRowsAtFreeze" | "holdoutEffectiveNAtFreeze"
> {
  const dev = inputs.all.filter((row) => row.episodeMs < devEndMs);
  const holdout = inputs.all.filter(
    (row) => row.episodeMs >= devEndMs && (holdoutEndMs === null || row.episodeMs < holdoutEndMs),
  );
  return {
    devRowsAtFreeze: dev.length,
    devEffectiveNAtFreeze: effectiveNOfSorted(dev, inputs.blockWidthMs),
    holdoutRowsAtFreeze: holdout.length,
    holdoutEffectiveNAtFreeze: effectiveNOfSorted(holdout, inputs.blockWidthMs),
  };
}

/**
 * Point 4 — attempt both stage freezes for one proof unit and return the resulting (immutable)
 * windows. Called on every report build; both writes are add-only, so a stage that is already
 * frozen costs a map lookup and nothing else.
 *
 * ORDER AND PRECONDITION. STABLE is attempted first; PROMOTION is only attempted when a STABLE
 * window exists, and can only start at or after STABLE's holdout ends. Together with
 * PROMOTION_MIN_EFFECTIVE_N >= STABLE_MIN_EFFECTIVE_N + STABLE_MIN_HOLDOUT_EFFECTIVE_N (asserted at
 * module load), that makes "STABLE is reachable before PROMOTION" an arithmetic property rather
 * than a hope.
 *
 * CHEAP GUARDS FIRST. Each search is skipped outright unless the total fresh-row count could
 * possibly satisfy that stage's two row floors combined. That matters: this runs for ~84 proof keys
 * on essentially every scan, and a freeze WRITE re-serialises the whole store (which has reached
 * ~200MB in production). Both attempts are wrapped in one batch so at most a single flush occurs per
 * proof unit per build.
 *
 * DETERMINISM. Nothing here reads the wall clock. The quarantine horizon comes from the data's own
 * newest origin time (see STAGE_SETTLEMENT_MS), so two builds over the same rows produce identical
 * windows regardless of when they run; `nowIso` is recorded as `frozenAt` provenance only and is
 * never compared against anything.
 */
function ensureVariantMatrixStageCuts(
  key: string,
  fresh: readonly CurrentGuardVariantMatrixObservation[],
  blockWidthMs: number,
  store: CurrentGuardVariantMatrixStore,
  nowIso: string,
): Readonly<VariantMatrixStageCuts> {
  let cuts = store.getStageCuts(key);
  const needStable = !cuts.stable;
  const needPromotion = !cuts.promotion;
  if (!needStable && !needPromotion) return cuts;

  const stablePossible = needStable && fresh.length >= STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS;
  const promotionPossible =
    needPromotion && !needStable && fresh.length >= PROMOTION_MIN_DEV_ROWS + PROMOTION_MIN_HOLDOUT_ROWS;
  if (!stablePossible && !promotionPossible) return cuts;

  const all = fresh
    .map(episodeIdentityRowOf)
    .filter((row): row is DatedEpisodeRow => row.episodeMs !== null)
    .sort((a, b) => {
      if (a.episodeMs !== b.episodeMs) return a.episodeMs - b.episodeMs;
      if (a.observationId < b.observationId) return -1;
      if (a.observationId > b.observationId) return 1;
      return 0;
    });
  if (all.length === 0) return cuts;
  const settledMs = all[all.length - 1]!.episodeMs - STAGE_SETTLEMENT_MS;
  const settled = all.filter((row) => row.episodeMs <= settledMs);
  // ONE edge set for the whole proof unit: both STABLE boundaries and PROMOTION's read it, so no two
  // stages can disagree about where a market episode ends.
  const inputs: StageFreezeInputs = {
    all,
    settled,
    blockWidthMs,
    episodeEdgeMs: episodeEdgeMsOf(all, blockWidthMs),
  };

  store.beginBatch();
  try {
    if (stablePossible) {
      const window = findStableWindow(inputs);
      if (window) {
        store.freezeStageCutIfAbsent(key, "stable", {
          v: 2,
          devEndMs: window.devEndMs,
          holdoutEndMs: window.holdoutEndMs,
          frozenAt: nowIso,
          ...stageFreezeDiagnostics(inputs, window.devEndMs, window.holdoutEndMs),
        });
        cuts = store.getStageCuts(key);
      }
    }
    const stableHoldoutEndMs = cuts.stable?.holdoutEndMs ?? null;
    if (
      !cuts.promotion &&
      stableHoldoutEndMs !== null &&
      fresh.length >= PROMOTION_MIN_DEV_ROWS + PROMOTION_MIN_HOLDOUT_ROWS
    ) {
      const boundary = findPromotionBoundary(inputs, stableHoldoutEndMs);
      if (boundary !== null) {
        store.freezeStageCutIfAbsent(key, "promotion", {
          v: 2,
          devEndMs: boundary,
          holdoutEndMs: null,
          frozenAt: nowIso,
          ...stageFreezeDiagnostics(inputs, boundary, null),
        });
      }
    }
  } finally {
    store.endBatch();
  }
  return store.getStageCuts(key);
}

/**
 * Per-stage floors, resolved from the eight exported constants exactly once so the freeze search,
 * the proof builder and the blocker strings can never disagree about what a stage requires.
 *
 * `minDistinctSymbols` is deliberately the SAME tier the headline uses for that stage
 * (STABLE_MIN_DISTINCT_SYMBOLS / PROMOTION_MIN_DISTINCT_SYMBOLS) and is applied to BOTH sides of a
 * stage: a lane that proved a market-wide claim on 8 symbols in development and re-proved it on one
 * symbol in the holdout has not re-proven the claim it makes.
 */
const STAGE_THRESHOLDS: Readonly<
  Record<
    VariantMatrixProofStage,
    {
      readonly label: string;
      readonly minDevRows: number;
      readonly minDevEffectiveN: number;
      readonly minHoldoutRows: number;
      readonly minHoldoutEffectiveN: number;
      readonly minDistinctSymbols: number;
    }
  >
> = {
  stable: {
    label: "STABLE",
    minDevRows: STABLE_MIN_DEV_ROWS,
    minDevEffectiveN: STABLE_MIN_EFFECTIVE_N,
    minHoldoutRows: STABLE_MIN_HOLDOUT_ROWS,
    minHoldoutEffectiveN: STABLE_MIN_HOLDOUT_EFFECTIVE_N,
    minDistinctSymbols: STABLE_MIN_DISTINCT_SYMBOLS,
  },
  promotion: {
    label: "PROMOTION",
    minDevRows: PROMOTION_MIN_DEV_ROWS,
    minDevEffectiveN: PROMOTION_MIN_EFFECTIVE_N,
    minHoldoutRows: PROMOTION_MIN_HOLDOUT_ROWS,
    minHoldoutEffectiveN: PROMOTION_MIN_HOLDOUT_EFFECTIVE_N,
    minDistinctSymbols: PROMOTION_MIN_DISTINCT_SYMBOLS,
  },
};

/** Blocker-string number formatting: nulls read as "n/a" rather than silently disappearing. */
function proofNum(value: number | null, digits = 3): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/**
 * The fail-closed proof. Returned verbatim whenever a stage has no frozen window, and used as the
 * base shape everywhere else. EVERY numeric field is 0 or null and EVERY boolean is false, so a
 * consumer that forgets to check `frozen` still cannot read a passing value out of an absent proof.
 *
 * Exported because `deriveVariantStatus` takes a plain struct and is called with hand-built evidence
 * in tests: without a canonical empty proof, each such fixture would hand-roll one, and a fixture
 * that hand-rolls `ok: true` by accident is exactly the kind of silent self-authorisation this whole
 * gate exists to prevent.
 */
export function emptyVariantMatrixStageProof(
  stage: VariantMatrixProofStage,
  blockers: string[] = [],
): VariantMatrixStageProof {
  return {
    stage,
    frozen: false,
    devEndMs: null,
    holdoutEndMs: null,
    frozenAt: null,
    dev: {
      rows: 0,
      effectiveN: 0,
      distinctSymbolCount: 0,
      distinctRegimes: 0,
      netAvgR: null,
      pf: null,
      payoffRatio: null,
      stressNetAvgR: null,
      approxMaxDrawdownR: null,
      topSymbolPnlShare: null,
      allThreeOosPositive: false,
      calendarDays: null,
    },
    holdout: {
      rows: 0,
      stressableRows: 0,
      effectiveN: 0,
      distinctSymbolCount: 0,
      netAvgR: null,
      pf: null,
      stressNetAvgR: null,
      sufficient: false,
      negative: false,
    },
    ok: false,
    blockers,
  };
}

/** Per-row +STRESS_EXTRA_BPS stress return, or null when it is not computable for that row. */
function stressNetROf(obs: CurrentGuardVariantMatrixObservation, stressRoundTripBps: number): number | null {
  if (typeof obs.grossR !== "number" || obs.stopDistanceBps === null || !(obs.stopDistanceBps > 0)) return null;
  return obs.grossR - stressRoundTripBps / obs.stopDistanceBps;
}

/**
 * Point 4 — build ONE stage's complete proof from its frozen window.
 *
 * Both sides are computed from `stageSlicesForCut`, i.e. purely from the frozen boundaries and each
 * row's own proof clock (openedAt). One clock, one membership rule: a row can never be development
 * for economics and holdout for counting, which is the anomaly the previous resolve-time membership
 * left in place.
 *
 * `ok` is a flat AND over every term. Nothing is averaged, weighted or traded off:
 *   - a glowing holdout cannot rescue bad development (dev terms are ANDed in independently), and
 *   - perfect development cannot rescue a bad holdout (`holdout.sufficient` is ANDed in too).
 *
 * `blockers` names EVERY failing term with its numeric shortfall, so an operator sees the distance
 * rather than inferring it. Unfrozen stages emit ONLY the not-frozen blocker: every other field is
 * 0/null by definition at that point, and reporting "0 < 40" fifteen times would bury the one fact
 * that matters (no window exists yet).
 *
 * DISCIPLINE. `holdout.netAvgR` / `holdout.pf` / `holdout.stressNetAvgR` are holdout ECONOMICS and
 * must never be read by anything a human uses to iteratively tune variant geometry or the threshold
 * constants — only the boolean summaries (`sufficient`, `negative`, `ok`) may gate a status. The
 * holdout SHAPE fields (rows, stressableRows, effectiveN, distinctSymbolCount) carry no P&L signal
 * and are deliberately exempt.
 */
function buildStageProof(
  stage: VariantMatrixProofStage,
  cut: VariantMatrixStageCut | null,
  chronologicalFresh: readonly CurrentGuardVariantMatrixObservation[],
  stressRoundTripBps: number,
  blockWidthMs: number,
): VariantMatrixStageProof {
  const t = STAGE_THRESHOLDS[stage];
  if (!cut) {
    return emptyVariantMatrixStageProof(stage, [
      `${t.label} proof window not frozen: needs >= ${t.minDevRows} dev rows and >= ${t.minDevEffectiveN} independent dev episodes, then >= ${t.minHoldoutRows} holdout rows and >= ${t.minHoldoutEffectiveN} independent holdout episodes`,
    ]);
  }

  const { dev, holdout } = stageSlicesForCut(chronologicalFresh, cut);

  // ---- development side -----------------------------------------------------------------
  const devNet = dev.map((obs) => obs.netR);
  const devNetAvgR = mean(devNet);
  const devPf = profitFactor(devNet);
  const devWinners = dev.filter((obs) => (obs.netR ?? 0) > 0);
  const devLosers = dev.filter((obs) => (obs.netR ?? 0) <= 0);
  const devAvgWinR = mean(devWinners.map((obs) => obs.netR));
  const devAvgLossR = mean(devLosers.map((obs) => obs.netR));
  const devPayoffRatio =
    devAvgWinR !== null && devAvgLossR !== null && devAvgLossR < 0 ? devAvgWinR / Math.abs(devAvgLossR) : null;
  const devStressNetAvgR = mean(dev.map((obs) => stressNetROf(obs, stressRoundTripBps)));
  const { drawdownR: devDrawdownR } = drawdownAndStreak(dev.map((obs) => obs.netR ?? 0));
  const devTopSymbolShare = topSymbolPnlShare(dev);
  const { allThreeOosPositive: devOosPositive } = oosThirdsFor(dev);
  const devEvidence: VariantMatrixStageDevEvidence = {
    rows: dev.length,
    effectiveN: computeEffectiveN(dev, blockWidthMs),
    distinctSymbolCount: new Set(dev.map((obs) => obs.symbol)).size,
    distinctRegimes: countDistinctRegimeEpisodes(dev),
    netAvgR: devNetAvgR,
    pf: devPf,
    payoffRatio: devPayoffRatio,
    stressNetAvgR: devStressNetAvgR,
    approxMaxDrawdownR: devDrawdownR,
    topSymbolPnlShare: devTopSymbolShare,
    allThreeOosPositive: devOosPositive,
    calendarDays: calendarDays(dev),
  };

  // ---- holdout side ---------------------------------------------------------------------
  const holdoutNet = holdout.map((obs) => obs.netR);
  const holdoutStressValues = holdout.map((obs) => stressNetROf(obs, stressRoundTripBps));
  const holdoutEvidence: VariantMatrixStageHoldoutEvidence = {
    rows: holdout.length,
    stressableRows: holdoutStressValues.filter((value) => value !== null).length,
    effectiveN: computeEffectiveN(holdout, blockWidthMs),
    distinctSymbolCount: new Set(holdout.map((obs) => obs.symbol)).size,
    netAvgR: mean(holdoutNet),
    pf: profitFactor(holdoutNet),
    stressNetAvgR: mean(holdoutStressValues),
    sufficient: false, // set below
    negative: false, // set below
  };

  // spec point 4 — holdoutOk, per stage, with that stage's own thresholds. ALL FIVE required.
  const holdoutRowsOk = holdoutEvidence.rows >= t.minHoldoutRows;
  const holdoutEpisodesOk = holdoutEvidence.effectiveN >= t.minHoldoutEffectiveN;
  const holdoutSymbolsOk = holdoutEvidence.distinctSymbolCount >= t.minDistinctSymbols;
  // "Valid cost/stress economics": every row counted toward the row floor must have a computable
  // stress figure. Without this a holdout of 20 rows with 2 usable stopDistanceBps values would
  // clear the floor while its stress mean is a 2-row estimate.
  const holdoutStressableOk = holdoutEvidence.stressableRows >= t.minHoldoutRows;
  // FAIL CLOSED. The outgoing form was `x !== null && x < 0`, which PASSES when x is null — an
  // absent economic reading authorised the stage. Each term now requires a present, non-negative
  // value.
  const holdoutNetOk = holdoutEvidence.netAvgR !== null && holdoutEvidence.netAvgR >= 0;
  const holdoutPfOk = holdoutEvidence.pf !== null && holdoutEvidence.pf >= PF_FLOOR;
  const holdoutStressOk = holdoutEvidence.stressNetAvgR !== null && holdoutEvidence.stressNetAvgR >= 0;
  holdoutEvidence.sufficient =
    holdoutRowsOk &&
    holdoutEpisodesOk &&
    holdoutSymbolsOk &&
    holdoutStressableOk &&
    holdoutNetOk &&
    holdoutPfOk &&
    holdoutStressOk;
  holdoutEvidence.negative =
    (holdoutEvidence.netAvgR !== null && holdoutEvidence.netAvgR < 0) ||
    (holdoutEvidence.pf !== null && holdoutEvidence.pf < PF_FLOOR) ||
    (holdoutEvidence.stressNetAvgR !== null && holdoutEvidence.stressNetAvgR < 0);

  // ---- development floors + economics ----------------------------------------------------
  const devRowsOk = devEvidence.rows >= t.minDevRows;
  const devEpisodesOk = devEvidence.effectiveN >= t.minDevEffectiveN;
  const devSymbolsOk = devEvidence.distinctSymbolCount >= t.minDistinctSymbols;
  const devCumulativeNetR = (devEvidence.netAvgR ?? 0) * devEvidence.rows;
  const devDrawdownLimitR = Math.max(MAX_DRAWDOWN_R_LIMIT, DRAWDOWN_R_TO_CUM_SHARE * devCumulativeNetR);
  const devDrawdownOk = devEvidence.approxMaxDrawdownR === null || devEvidence.approxMaxDrawdownR <= devDrawdownLimitR;
  const devShareOk = devEvidence.topSymbolPnlShare === null || devEvidence.topSymbolPnlShare <= MAX_TOP_SYMBOL_SHARE;
  const devNetOk = devEvidence.netAvgR !== null && devEvidence.netAvgR > NET_STRONG_R;
  const devPfOk = devEvidence.pf !== null && devEvidence.pf > PF_STRONG;
  const devPayoffOk = devEvidence.payoffRatio !== null && devEvidence.payoffRatio >= PAYOFF_AUTHORIZE;

  const blockers: string[] = [];
  if (!devRowsOk) blockers.push(`${t.label} dev rows ${devEvidence.rows} < ${t.minDevRows}`);
  if (!devEpisodesOk) {
    blockers.push(`${t.label} dev effectiveN ${devEvidence.effectiveN} < ${t.minDevEffectiveN} independent episodes`);
  }
  if (!devSymbolsOk) {
    blockers.push(`${t.label} dev distinctSymbolCount ${devEvidence.distinctSymbolCount} < ${t.minDistinctSymbols}`);
  }
  if (!devNetOk) blockers.push(`${t.label} dev netAvgR ${proofNum(devEvidence.netAvgR)} <= ${NET_STRONG_R}`);
  if (!devPfOk) blockers.push(`${t.label} dev PF ${proofNum(devEvidence.pf, 2)} <= ${PF_STRONG}`);
  if (!devPayoffOk) {
    blockers.push(`${t.label} dev payoffRatio ${proofNum(devEvidence.payoffRatio, 2)} < ${PAYOFF_AUTHORIZE}`);
  }
  if (!devEvidence.allThreeOosPositive) blockers.push(`${t.label} dev OOS thirds not all positive`);
  if (!devDrawdownOk) {
    blockers.push(
      `${t.label} dev drawdown ${proofNum(devEvidence.approxMaxDrawdownR, 1)}R > ${devDrawdownLimitR.toFixed(1)}R cap`,
    );
  }
  if (!devShareOk) {
    blockers.push(
      `${t.label} dev topSymbolPnlShare ${proofNum(devEvidence.topSymbolPnlShare, 2)} > ${MAX_TOP_SYMBOL_SHARE}`,
    );
  }
  if (!holdoutRowsOk) blockers.push(`${t.label} holdout rows ${holdoutEvidence.rows} < ${t.minHoldoutRows}`);
  if (!holdoutEpisodesOk) {
    blockers.push(
      `${t.label} holdout effectiveN ${holdoutEvidence.effectiveN} < ${t.minHoldoutEffectiveN} independent episodes`,
    );
  }
  if (!holdoutSymbolsOk) {
    blockers.push(
      `${t.label} holdout distinctSymbolCount ${holdoutEvidence.distinctSymbolCount} < ${t.minDistinctSymbols}`,
    );
  }
  if (!holdoutStressableOk) {
    blockers.push(
      `${t.label} holdout stressableRows ${holdoutEvidence.stressableRows} < ${t.minHoldoutRows} (rows missing grossR/stopDistanceBps — stress economics not computable)`,
    );
  }
  if (!holdoutNetOk) {
    blockers.push(`${t.label} holdout netAvgR ${proofNum(holdoutEvidence.netAvgR)} — must be present and >= 0`);
  }
  if (!holdoutPfOk) {
    blockers.push(`${t.label} holdout PF ${proofNum(holdoutEvidence.pf, 2)} — must be present and >= ${PF_FLOOR}`);
  }
  if (!holdoutStressOk) {
    blockers.push(
      `${t.label} holdout stressNetAvgR ${proofNum(holdoutEvidence.stressNetAvgR)} — must be present and >= 0`,
    );
  }

  return {
    stage,
    frozen: true,
    devEndMs: cut.devEndMs,
    holdoutEndMs: cut.holdoutEndMs,
    frozenAt: cut.frozenAt,
    dev: devEvidence,
    holdout: holdoutEvidence,
    ok:
      devRowsOk &&
      devEpisodesOk &&
      devSymbolsOk &&
      devNetOk &&
      devPfOk &&
      devPayoffOk &&
      devEvidence.allThreeOosPositive &&
      devDrawdownOk &&
      devShareOk &&
      holdoutEvidence.sufficient,
    blockers,
  };
}

/** Both stage proofs for one proof unit, plus the legacy STABLE-aliased fields the row shapes keep. */
interface VariantMatrixStageProofBundle {
  stableProof: VariantMatrixStageProof;
  promotionProof: VariantMatrixStageProof;
  holdoutFreshValid: number;
  holdoutNetAvgR: number | null;
  holdoutPf: number | null;
  holdoutStressNetAvgR: number | null;
  holdoutSufficient: boolean;
  holdoutNegative: boolean;
  holdoutCutMs: number | null;
  holdoutEndMs: number | null;
  devN: number;
  devEffectiveN: number;
  holdoutN: number;
  holdoutEffectiveN: number;
  holdoutDistinctSymbolCount: number;
  promotionDevN: number;
  promotionDevEffectiveN: number;
  promotionHoldoutN: number;
  promotionHoldoutEffectiveN: number;
}

/**
 * Point 4e — describe the CURRENT (unfrozen) evidence version's accumulated collection progress.
 *
 * Pure and report-only: it derives everything from the same `fresh` population the frozen proofs are
 * searched over (already filtered by `isFreshValidObs`, so for a reset lane it is current-version-only
 * by construction) and the same `describeIndependentEpisodes` rule. It reads no store, freezes
 * nothing, and no caller may gate on it — see VariantMatrixPreFreezeCollection's doc comment.
 *
 * `freezeBlockers` answers "why is DEV still NOT FROZEN", which is a strictly different question from
 * "why did the gate fail" (`VariantMatrixStageProof.blockers`). A window is only ATTEMPTED once the
 * combined dev+holdout row floor is reachable, so the row shortfall is reported against that sum,
 * while the episode shortfall is reported against the dev floor it must eventually satisfy.
 */
function buildPreFreezeCollection(
  fresh: readonly CurrentGuardVariantMatrixObservation[],
  blockWidthMs: number,
  stableProof: VariantMatrixStageProof,
  evidenceVersionSummary: LaneEvidenceVersionSummary,
  calendarDays: number | null,
  distinctRegimes: number,
  distinctSymbolCount: number,
  topSymbolPnlShareValue: number | null,
): VariantMatrixPreFreezeCollection {
  const { episodes, largestEpisodeRows } = describeIndependentEpisodes(
    fresh.map(episodeIdentityRowOf),
    blockWidthMs,
  );
  const eligibleRows = fresh.length;
  const minRowsToAttemptFreeze = STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS;
  const freezeBlockers: string[] = [];
  if (stableProof.frozen) {
    // Already frozen ⇒ this section is history; say so rather than inventing a shortfall.
    return {
      eligibleRows,
      provisionalEpisodes: episodes,
      rowsPerEpisode: episodes > 0 ? eligibleRows / episodes : null,
      calendarDays,
      distinctSymbolCount,
      distinctRegimes,
      largestEpisodeRows,
      largestEpisodeShare: eligibleRows > 0 ? largestEpisodeRows / eligibleRows : null,
      topSymbolPnlShare: topSymbolPnlShareValue,
      evidenceVersion: evidenceVersionSummary.evidenceVersion,
      cutoverSource: evidenceVersionSummary.cutoverSource,
      freezeBlockers,
      minRowsToAttemptFreeze,
      minDevRows: STABLE_MIN_DEV_ROWS,
      minDevEpisodes: STABLE_MIN_EFFECTIVE_N,
    };
  }
  if (eligibleRows < minRowsToAttemptFreeze) {
    freezeBlockers.push(
      `eligible current rows ${eligibleRows} < ${minRowsToAttemptFreeze} needed before a STABLE window is attempted ` +
        `(dev ${STABLE_MIN_DEV_ROWS} + holdout ${STABLE_MIN_HOLDOUT_ROWS})`,
    );
  }
  if (episodes < STABLE_MIN_EFFECTIVE_N) {
    freezeBlockers.push(
      `provisional independent episodes ${episodes} < ${STABLE_MIN_EFFECTIVE_N} needed for the STABLE dev side`,
    );
  }
  if (distinctSymbolCount < STABLE_MIN_DISTINCT_SYMBOLS) {
    freezeBlockers.push(
      `distinct symbols ${distinctSymbolCount} < ${STABLE_MIN_DISTINCT_SYMBOLS} needed for the STABLE dev side`,
    );
  }
  if (freezeBlockers.length === 0) {
    // Enough raw material exists; the boundary search itself has not yet found a split that satisfies
    // both sides at once (or the newest rows are still inside the settlement quarantine).
    freezeBlockers.push(
      "enough rows and episodes collected; awaiting a boundary that satisfies both dev and holdout floors " +
        "(newest rows are held back by the settlement quarantine until they can no longer move)",
    );
  }
  return {
    eligibleRows,
    provisionalEpisodes: episodes,
    rowsPerEpisode: episodes > 0 ? eligibleRows / episodes : null,
    calendarDays,
    distinctSymbolCount,
    distinctRegimes,
    largestEpisodeRows,
    largestEpisodeShare: eligibleRows > 0 ? largestEpisodeRows / eligibleRows : null,
    topSymbolPnlShare: topSymbolPnlShareValue,
    evidenceVersion: evidenceVersionSummary.evidenceVersion,
    cutoverSource: evidenceVersionSummary.cutoverSource,
    freezeBlockers,
    minRowsToAttemptFreeze,
    minDevRows: STABLE_MIN_DEV_ROWS,
    minDevEpisodes: STABLE_MIN_EFFECTIVE_N,
  };
}

/**
 * Point 4 — attempt both stage freezes for one proof unit (`key`) and report both stages' proofs.
 *
 * The freezes are add-only: the first build with enough evidence locks each window, every later
 * build re-reads the SAME frozen boundaries, and they are never recomputed from the (since-grown,
 * possibly since-backfilled) input array. Before a stage's window exists its proof is the
 * fail-closed one — the same discipline as every other missing-evidence branch in this file.
 *
 * The windows must be searched over the FULL `chronologicalFresh` population; scoping the input
 * before this call would be circular. `blockWidthMs` is the caller's own `variantMaxHoldMs(def.id)`,
 * so both stages' episode grouping uses exactly the same width as the headline's.
 */
function computeStageProofs(
  key: string,
  chronologicalFresh: readonly CurrentGuardVariantMatrixObservation[],
  stressRoundTripBps: number,
  store: CurrentGuardVariantMatrixStore,
  nowIso: string,
  blockWidthMs: number,
): VariantMatrixStageProofBundle {
  const cuts = ensureVariantMatrixStageCuts(key, chronologicalFresh, blockWidthMs, store, nowIso);
  const stableProof = buildStageProof("stable", cuts.stable ?? null, chronologicalFresh, stressRoundTripBps, blockWidthMs);
  const promotionProof = buildStageProof(
    "promotion",
    cuts.promotion ?? null,
    chronologicalFresh,
    stressRoundTripBps,
    blockWidthMs,
  );
  return {
    stableProof,
    promotionProof,
    holdoutFreshValid: stableProof.holdout.rows,
    holdoutNetAvgR: stableProof.holdout.netAvgR,
    holdoutPf: stableProof.holdout.pf,
    holdoutStressNetAvgR: stableProof.holdout.stressNetAvgR,
    holdoutSufficient: stableProof.holdout.sufficient,
    holdoutNegative: stableProof.holdout.negative,
    holdoutCutMs: stableProof.devEndMs,
    holdoutEndMs: stableProof.holdoutEndMs,
    devN: stableProof.dev.rows,
    devEffectiveN: stableProof.dev.effectiveN,
    holdoutN: stableProof.holdout.rows,
    holdoutEffectiveN: stableProof.holdout.effectiveN,
    holdoutDistinctSymbolCount: stableProof.holdout.distinctSymbolCount,
    promotionDevN: promotionProof.dev.rows,
    promotionDevEffectiveN: promotionProof.dev.effectiveN,
    promotionHoldoutN: promotionProof.holdout.rows,
    promotionHoldoutEffectiveN: promotionProof.holdout.effectiveN,
  };
}

function rollingStat(label: string, ordered: CurrentGuardVariantMatrixObservation[], size: number): VariantRollingStat {
  const slice = ordered.slice(Math.max(0, ordered.length - size));
  const wins = slice.filter((o) => (o.netR ?? 0) > 0).length;
  return {
    window: label,
    n: slice.length,
    netAvgR: mean(slice.map((o) => o.netR)),
    pf: profitFactor(slice.map((o) => o.netR)),
    wr: slice.length > 0 ? wins / slice.length : null,
  };
}

function segmentStat(label: string, slice: CurrentGuardVariantMatrixObservation[]): VariantSegmentStat {
  return { label, n: slice.length, netAvgR: mean(slice.map((o) => o.netR)) };
}

function breakdownRows(
  slice: CurrentGuardVariantMatrixObservation[],
  keyFn: (o: CurrentGuardVariantMatrixObservation) => string,
): VariantBreakdownRow[] {
  const groups = new Map<string, CurrentGuardVariantMatrixObservation[]>();
  for (const o of slice) {
    const k = keyFn(o);
    const arr = groups.get(k) ?? [];
    arr.push(o);
    groups.set(k, arr);
  }
  return Array.from(groups.entries())
    .map(([key, arr]) => {
      const netVals = arr.map((o) => o.netR);
      const wins = arr.filter((o) => (o.netR ?? 0) > 0);
      const losses = arr.filter((o) => (o.netR ?? 0) <= 0);
      const avgWinR = mean(wins.map((o) => o.netR));
      const avgLossR = mean(losses.map((o) => o.netR));
      return {
        key,
        n: arr.length,
        netAvgR: mean(netVals),
        grossAvgR: mean(arr.map((o) => o.grossR)),
        pf: profitFactor(netVals),
        wr: arr.length > 0 ? wins.length / arr.length : null,
        payoffRatio: avgWinR !== null && avgLossR !== null && avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : null,
        avgWinR,
        avgLossR,
      };
    })
    .sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0));
}

function validAxisRegimeFamily(value: unknown): AxisRegimeFamily | null {
  return value === "BULLISH" || value === "BEARISH" || value === "MIXED" || value === "UNKNOWN" ? value : null;
}

function regimeFamilyKey(regime: string | null | undefined): AxisRegimeFamily {
  const label = (regime ?? "").toLowerCase();
  if (label.includes("mixed") || label.includes("chop") || label.includes("range") || label.includes("rotation") || label.includes("sideways")) {
    return "MIXED";
  }
  if (label.includes("bull")) return "BULLISH";
  if (label.includes("bear")) return "BEARISH";
  return "UNKNOWN";
}

function observationRegimeFamilyKey(obs: CurrentGuardVariantMatrixObservation): AxisRegimeFamily {
  return validAxisRegimeFamily(obs.axisRegimeFamily) ?? regimeFamilyKey(obs.regime);
}

/** Convert a resolved direction/regime pair into a promotable proof context. */
export function exactLaneContextFor(
  direction: Direction | null | undefined,
  regimeFamily: AxisRegimeFamily | string | null | undefined,
): ExactLaneContext | null {
  if (direction === "LONG" && regimeFamily === "BULLISH") return "LONG_BULLISH";
  if (direction === "SHORT" && regimeFamily === "BEARISH") return "SHORT_BEARISH";
  if (direction === "LONG" && regimeFamily === "MIXED") return "LONG_MIXED";
  if (direction === "SHORT" && regimeFamily === "MIXED") return "SHORT_MIXED";
  return null;
}

/** Legacy records with no exact direction/regime pairing remain aggregate-only diagnostics. */
export function exactLaneContextForObservation(
  obs: CurrentGuardVariantMatrixObservation,
): ExactLaneContext | "UNKNOWN_CONTEXT" {
  return exactLaneContextFor(obs.axisDirection ?? obs.direction, observationRegimeFamilyKey(obs)) ?? "UNKNOWN_CONTEXT";
}

function stampObservationAxis(obs: CurrentGuardVariantMatrixObservation): void {
  const family = observationRegimeFamilyKey(obs);
  obs.axisVersion = 1;
  obs.axisDirection = obs.direction;
  obs.axisRegimeFamily = family;
  obs.axisKey = `${obs.direction}::${family}`;
}

function topSymbolPnlShare(slice: CurrentGuardVariantMatrixObservation[]): number | null {
  if (slice.length === 0) return null;
  const totalAbs = slice.reduce((s, o) => s + Math.abs(o.netR ?? 0), 0);
  if (!(totalAbs > 0)) return null;
  const bySymbol = new Map<string, number>();
  for (const o of slice) bySymbol.set(o.symbol, (bySymbol.get(o.symbol) ?? 0) + Math.abs(o.netR ?? 0));
  return Math.max(...bySymbol.values()) / totalAbs;
}

function oosThirdsFor(
  fresh: CurrentGuardVariantMatrixObservation[],
): { oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null; allThreeOosPositive: boolean } {
  if (fresh.length < 3) return { oosThirds: null, allThreeOosPositive: false };
  const third = Math.floor(fresh.length / 3);
  const s1 = segmentStat("oos_1", fresh.slice(0, third));
  const s2 = segmentStat("oos_2", fresh.slice(third, 2 * third));
  const s3 = segmentStat("oos_3", fresh.slice(2 * third));
  const oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] = [s1, s2, s3];
  return {
    oosThirds,
    allThreeOosPositive: oosThirds.every((segment) => segment.netAvgR !== null && segment.netAvgR > 0),
  };
}

function buildContextEvidenceRow(
  def: VariantMatrixVariantDefinition,
  context: ExactLaneContext,
  observations: CurrentGuardVariantMatrixObservation[],
  infra: { killSwitchReady: boolean; orderReconciliationReady: boolean; exchangeHealthReady: boolean },
  store: CurrentGuardVariantMatrixStore,
  nowIso: string,
): VariantContextEvidenceRow {
  // Point 3b: exact-context proof is restricted to rows carrying the explicit axis stamp
  // (exactAxisProof === true). Legacy/parsed regime data can still land in a context bucket via the
  // regime STRING classifier (exactLaneContextForObservation's caller already filtered on context),
  // but without the axis stamp it may never stand alone as strong individual proof of THIS lane x
  // context — only the aggregate (buildRow, diagnostic-only) may still include it.
  // Sorted on the PROOF CLOCK (openedAt), not resolve time: countDistinctRegimeEpisodes and
  // oosThirdsFor both consume this order, and "what regime was the market in when this was entered"
  // and "were the first/second/third thirds of the ENTRY sequence all positive" are entry-time
  // questions. See episodeTimeMsOf for why there is exactly one clock in the proof path.
  const fresh = observations
    .filter(isFreshValidObs)
    .filter((obs) => obs.exactAxisProof === true)
    .sort(orderByEpisodeTime);
  const stressRoundTrip = roundTripBpsForCostModel(def.costModel) + STRESS_EXTRA_BPS;
  const blockWidthMs = variantMaxHoldMs(def.id);
  // Point 4: this exact lane x context proof unit gets its own immutable stage windows, independent
  // of the aggregate's and of every other context's — a lane can be genuinely proven in LONG_BULLISH
  // while its SHORT_BEARISH window is still unfrozen or its holdout still negative. The windows must
  // be searched over the FULL `fresh` population; scoping `fresh` before this call would be circular.
  const stageProofs = computeStageProofs(`${def.id}::${context}`, fresh, stressRoundTrip, store, nowIso, blockWidthMs);
  // Point 4d — HEADLINE METRICS ARE THE FULL POPULATION (P_all), deliberately.
  //
  // Development/holdout separation lives entirely inside `stageProofs`: each stage recomputes its
  // OWN dev economics from its OWN frozen window (see buildStageProof), and those are the only
  // numbers STABLE/PROMOTION are allowed to read. Scoping these headline fields to a frozen dev
  // window as well would separate nothing extra — the gate is already separated — while breaking
  // every live consumer that needs a growing count (lane-selector-v2's scoring confidence,
  // paper-execution-router's admission floor, paper-opportunity-allocator's economics gate) and,
  // worse, freezing the inputs to the REJECT rung so a lane that turns bad could no longer be killed
  // on current evidence.
  const netValues = fresh.map((obs) => obs.netR);
  const grossValues = fresh.map((obs) => obs.grossR);
  const winners = fresh.filter((obs) => (obs.netR ?? 0) > 0);
  const losers = fresh.filter((obs) => (obs.netR ?? 0) <= 0);
  const avgWinR = mean(winners.map((obs) => obs.netR));
  const avgLossR = mean(losers.map((obs) => obs.netR));
  const payoffRatio = avgWinR !== null && avgLossR !== null && avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : null;
  const plus10bpsNetAvgR = mean(fresh.map((obs) => stressNetROf(obs, stressRoundTrip)));
  const { drawdownR } = drawdownAndStreak(fresh.map((obs) => obs.netR ?? 0));
  const { oosThirds, allThreeOosPositive } = oosThirdsFor(fresh);
  const partial = {
    freshValid: fresh.length,
    effectiveN: computeEffectiveN(fresh, blockWidthMs),
    netAvgR: mean(netValues),
    grossAvgR: mean(grossValues),
    pf: profitFactor(netValues),
    payoffRatio,
    approxMaxDrawdownR: drawdownR,
    topSymbolPnlShare: topSymbolPnlShare(fresh),
    plus10bpsStillPositive: plus10bpsNetAvgR !== null && plus10bpsNetAvgR > 0,
    calendarDays: calendarDays(fresh),
    distinctRegimes: countDistinctRegimeEpisodes(fresh),
    distinctSymbolCount: new Set(fresh.map((obs) => obs.symbol)).size,
    allThreeOosPositive,
    ...stageProofs,
  };
  const status = deriveVariantStatus(partial, infra);
  return {
    context,
    ...partial,
    wr: fresh.length > 0 ? winners.length / fresh.length : null,
    plus10bpsNetAvgR,
    oosThirds,
    ...status,
  };
}

/** Calendar span of a slice on the PROOF CLOCK (openedAt). Deliberately not resolve time: this
 *  feeds PROMOTION_MIN_CALENDAR_DAYS, and a stage slice is DEFINED by an openedAt interval, so
 *  measuring its span on a different clock would report a span the window does not actually cover —
 *  the exact two-clock hazard episodeTimeMsOf exists to eliminate. */
function calendarDays(slice: CurrentGuardVariantMatrixObservation[]): number | null {
  const times = slice.map(episodeTimeMsOf).filter((v): v is number => v !== null);
  if (times.length === 0) return null;
  return Math.round(((Math.max(...times) - Math.min(...times)) / (24 * 60 * 60 * 1000)) * 100) / 100;
}

function roundTripBpsForCostModel(costModel: VariantFillMode): number {
  return costModel === "maker_limit" ? MAKER_ROUNDTRIP_BPS : TAKER_ROUNDTRIP_BPS;
}

/**
 * Exactly what the status ladder is allowed to see.
 *
 * The first twelve members are HEADLINE fields over the full fresh-valid population (P_all) and
 * drive REJECT / COLLECTING / WATCHABLE plus PROMOTION's calendar/regime/symbol breadth terms. The
 * last two are the per-stage proofs, and they are the ONLY thing STABLE/PROMOTION may read about
 * development-vs-holdout evidence — no raw holdout counts are handed to this function any more, so
 * a caller cannot assemble a passing holdout out of loose fields. `stableProof`/`promotionProof` are
 * REQUIRED, not optional: a hand-built evidence object must supply them explicitly (use
 * `emptyVariantMatrixStageProof(stage)`), which makes "this fixture claims a frozen proof" visible
 * at the call site instead of implied by an omitted key.
 */
type VariantStatusEvidence = Pick<
  CurrentGuardVariantMatrixRow,
  | "freshValid"
  | "effectiveN"
  | "netAvgR"
  | "pf"
  | "payoffRatio"
  | "approxMaxDrawdownR"
  | "topSymbolPnlShare"
  | "plus10bpsStillPositive"
  | "calendarDays"
  | "distinctRegimes"
  | "distinctSymbolCount"
  | "allThreeOosPositive"
  | "stableProof"
  | "promotionProof"
>;

export function deriveVariantStatus(
  row: VariantStatusEvidence,
  infra: { killSwitchReady: boolean; orderReconciliationReady: boolean; exchangeHealthReady: boolean },
): { status: VariantMatrixStatus; statusReason: string; blockers: string[]; cautions: string[] } {
  const blockers: string[] = [];
  const cautions: string[] = [];

  const net = row.netAvgR;
  const pf = row.pf;
  const payoff = row.payoffRatio;
  const dd = row.approxMaxDrawdownR;
  const share = row.topSymbolPnlShare;

  // REJECT first: enough sample and clearly value-destructive.
  if (row.freshValid >= WATCHABLE_MIN_FRESH && ((net !== null && net < 0) || (pf !== null && pf < PF_FLOOR))) {
    return {
      status: "REJECT",
      statusReason: `freshValid=${row.freshValid} with net=${net?.toFixed(3) ?? "n/a"}R PF=${pf?.toFixed(2) ?? "n/a"} — value-destructive`,
      blockers: ["negative fresh-valid economics at adequate sample"],
      cautions,
    };
  }

  // Drawdown cap scales with the lane's banked cumulative R (see DRAWDOWN_R_TO_CUM_SHARE); the
  // absolute floor still binds for small/losing samples (cumulativeNetR<=0 ⇒ floor).
  const cumulativeNetR = (net ?? 0) * row.freshValid;
  const drawdownLimitR = Math.max(MAX_DRAWDOWN_R_LIMIT, DRAWDOWN_R_TO_CUM_SHARE * cumulativeNetR);
  const drawdownOk = dd === null || dd <= drawdownLimitR;
  const shareOk = share === null || share <= MAX_TOP_SYMBOL_SHARE;
  // Point 3c: symbol diversity is a SEPARATE requirement from effectiveN (independent-episode count)
  // — a cohort must not clear STABLE/PROMOTION on one or two symbols repeated across many episodes
  // alone, since that would not be genuine market-wide proof even though the episodes themselves are
  // independent.
  const stableSymbolsOk = row.distinctSymbolCount >= STABLE_MIN_DISTINCT_SYMBOLS;
  const promotionSymbolsOk = row.distinctSymbolCount >= PROMOTION_MIN_DISTINCT_SYMBOLS;
  const infraReady = infra.killSwitchReady && infra.orderReconciliationReady && infra.exchangeHealthReady;
  // ---- Point 4 — THE STAGE GATES ---------------------------------------------------------
  //
  // STABLE and PROMOTION are decided by the two immutable stage proofs and nothing else. Each proof
  // was computed over ITS OWN frozen window (buildStageProof), with ITS OWN row/episode/symbol
  // floors and ITS OWN holdout, so the two stages can never re-score the same out-of-sample cohort:
  // STABLE's holdout is bounded at `holdoutEndMs`, PROMOTION's begins at or after that value, and
  // the freeze path enforces `promotion.devEndMs >= stable.holdoutEndMs` (ensureVariantMatrixStageCuts).
  //
  // `ok` is already a flat AND of that stage's dev floors, dev economics and five-term holdout proof
  // — it is never blended, so a positive holdout cannot rescue bad development and strong
  // development cannot rescue a bad holdout. Both default to false when the stage has no frozen
  // window, so an unfrozen stage is simply unreachable rather than accidentally open.
  //
  // GONE, deliberately: `row.effectiveN >= STABLE_MIN_FRESH` / `>= PROMOTION_MIN_FRESH`. Those two
  // constants are RAW-ROW floors (100/200 rows); reading them as independent-episode floors meant
  // 300 and 600 calendar days at the 0.333 episodes/day ceiling for a 72 h max-hold. The
  // independence floors now live in STABLE_MIN_EFFECTIVE_N / PROMOTION_MIN_EFFECTIVE_N and are
  // applied to each stage's own dev slice.
  // FAIL CLOSED AGAINST A MALFORMED CALLER. `deriveVariantStatus` is exported and takes a plain
  // struct, so a hand-built evidence object can arrive with a stage proof missing entirely even
  // though the type says otherwise. Substituting the canonical empty proof (a) keeps the gate closed
  // — `ok` is false — and (b) keeps the blocker list a real array, so the branches below can splice
  // it without a runtime throw. The substituted blocker names the omission rather than pretending
  // the stage merely has not frozen.
  const stableProof =
    row.stableProof ?? emptyVariantMatrixStageProof("stable", ["STABLE proof missing from evidence object"]);
  const promotionProof =
    row.promotionProof ?? emptyVariantMatrixStageProof("promotion", ["PROMOTION proof missing from evidence object"]);
  const stableProofOk = stableProof.ok === true;
  const promotionProofOk = promotionProof.ok === true;

  // WATCHABLE's economic terms, hoisted: STABLE requires all of them, and PROMOTION requires all of
  // STABLE. Computing them once and reusing the same booleans is what makes each rung a STRICT
  // SUPERSET of the one below it structurally, rather than by two condition lists happening to
  // agree.
  const plus10ok = row.plus10bpsStillPositive;
  const watchableTermsOk =
    row.freshValid >= WATCHABLE_MIN_FRESH &&
    net !== null && net > 0 &&
    pf !== null && pf > PF_STRONG &&
    payoff !== null && payoff >= PAYOFF_WATCH &&
    plus10ok && shareOk;

  // STABLE's own HEADLINE terms, over the full fresh population, on top of WATCHABLE's.
  //
  // These are RETAINED FROM THE PRE-STAGE-MODEL GATE ON PURPOSE and must not be folded away into the
  // stage proof. The stage proof checks the same four quantities on the frozen DEVELOPMENT WINDOW,
  // which is a different and much older population — for a lane that has been trading for months the
  // window is its first 40 closes. Dropping the headline copies would mean a lane whose full record
  // has a 20R drawdown, a negative OOS third, or a net that has decayed to +0.01R still reads
  // STABLE_CANDIDATE on the strength of a frozen slice from a year ago. STABLE_CANDIDATE is the
  // real-money eligibility gate (app.ts / lane-selector-v2.ts), so the two populations are ANDed:
  // the stage proof adds an out-of-sample requirement, it does not REPLACE the live one.
  const stableHeadlineEconomicsOk =
    row.allThreeOosPositive &&
    net !== null && net > NET_STRONG_R &&
    pf !== null && pf > PF_STRONG &&
    payoff !== null && payoff >= PAYOFF_AUTHORIZE &&
    drawdownOk;
  const stableTermsOk = watchableTermsOk && stableHeadlineEconomicsOk && stableSymbolsOk && stableProofOk;
  const promotionCalendarOk = (row.calendarDays ?? 0) >= PROMOTION_MIN_CALENDAR_DAYS;
  const promotionRegimesOk = row.distinctRegimes >= PROMOTION_MIN_DISTINCT_REGIMES;
  const promotionTermsOk =
    stableTermsOk &&
    promotionProofOk &&
    promotionCalendarOk &&
    promotionRegimesOk &&
    promotionSymbolsOk &&
    infraReady;

  // PROMOTION_CANDIDATE (still report-only; infra gates are always false today).
  if (promotionTermsOk) {
    return {
      status: "PROMOTION_CANDIDATE",
      statusReason:
        `promotion proof frozen (dev n=${promotionProof.dev.rows}/effN=${promotionProof.dev.effectiveN}, ` +
        `holdout n=${promotionProof.holdout.rows}/effN=${promotionProof.holdout.effectiveN}); ` +
        "all anti-overfit + multi-day/regime + infra gates pass. Remains report-only until explicit manual approval.",
      blockers,
      cautions: ["report-only: promotion requires explicit manual approval; liveBlocked stays true"],
    };
  }

  // STABLE_CANDIDATE.
  if (stableTermsOk) {
    // Everything blocking PROMOTION, each nameable on its own so the operator can tell them apart.
    if (!promotionProofOk) blockers.push(...promotionProof.blockers);
    if (!promotionCalendarOk) {
      blockers.push(`calendarDays ${row.calendarDays ?? 0} < ${PROMOTION_MIN_CALENDAR_DAYS} for promotion`);
    }
    if (!promotionRegimesOk) {
      blockers.push(`distinctRegimes ${row.distinctRegimes} < ${PROMOTION_MIN_DISTINCT_REGIMES} for promotion`);
    }
    if (!promotionSymbolsOk) {
      blockers.push(`distinctSymbolCount ${row.distinctSymbolCount} < ${PROMOTION_MIN_DISTINCT_SYMBOLS} for promotion`);
    }
    if (!infraReady) blockers.push("live infra gates not ready (kill-switch/order-recon/exchange-health)");
    return {
      status: "STABLE_CANDIDATE",
      statusReason:
        `stable proof frozen (dev n=${stableProof.dev.rows}/effN=${stableProof.dev.effectiveN}, ` +
        `holdout n=${stableProof.holdout.rows}/effN=${stableProof.holdout.effectiveN}), ` +
        `freshValid=${row.freshValid} — stable but not yet promotable`,
      blockers,
      cautions,
    };
  }

  // WATCHABLE.
  if (watchableTermsOk) {
    // Every reason this lane is not STABLE. The stage proof supplies its own per-term blockers with
    // the exact numeric shortfall (or the single "window not frozen" line while no window exists),
    // so an operator sees the DISTANCE to stable rather than having to infer it.
    if (!stableProofOk) blockers.push(...stableProof.blockers);
    if (!stableSymbolsOk) {
      blockers.push(`distinctSymbolCount ${row.distinctSymbolCount} < ${STABLE_MIN_DISTINCT_SYMBOLS} for stable`);
    }
    // Headline-population diagnostics that the stage blockers do NOT cover: these read the FULL
    // fresh set, not a frozen window, so they stay informative before any window exists and they
    // answer a different question ("is the lane's whole record shaped like an edge?") from the
    // stage's dev-slice terms. Named distinctly from the `STABLE dev ...` strings on purpose.
    if (!row.allThreeOosPositive) blockers.push("OOS thirds not all positive (full fresh population)");
    if (net <= NET_STRONG_R) blockers.push(`netAvgR ${net.toFixed(3)} <= ${NET_STRONG_R} (full fresh population)`);
    if (payoff < PAYOFF_AUTHORIZE) blockers.push(`payoff ${payoff.toFixed(2)} < ${PAYOFF_AUTHORIZE}`);
    if (!drawdownOk && dd !== null) {
      blockers.push(`drawdown ${dd.toFixed(1)}R > ${drawdownLimitR.toFixed(1)}R cap (full fresh population)`);
    }
    return {
      status: "WATCHABLE",
      statusReason: `freshValid=${row.freshValid}, net=${net.toFixed(3)}R PF=${pf.toFixed(2)} payoff=${payoff.toFixed(2)} — watchable`,
      blockers,
      cautions,
    };
  }

  // COLLECTING (default): list what is missing for WATCHABLE.
  if (row.freshValid < WATCHABLE_MIN_FRESH) blockers.push(`freshValid ${row.freshValid} < ${WATCHABLE_MIN_FRESH}`);
  if (net === null || net <= 0) blockers.push("netAvgR not positive");
  if (pf === null || pf <= PF_STRONG) blockers.push(`PF <= ${PF_STRONG}`);
  if (payoff === null || payoff < PAYOFF_WATCH) blockers.push(`payoffRatio < ${PAYOFF_WATCH}`);
  if (!plus10ok) blockers.push("+10bps stress not positive");
  if (!shareOk) blockers.push("top-symbol PnL share > 40%");
  return {
    status: "COLLECTING",
    statusReason: `freshValid=${row.freshValid} — collecting evidence`,
    blockers,
    cautions,
  };
}

function buildRow(
  def: VariantMatrixVariantDefinition,
  obsForVariant: CurrentGuardVariantMatrixObservation[],
  infra: { killSwitchReady: boolean; orderReconciliationReady: boolean; exchangeHealthReady: boolean },
  store: CurrentGuardVariantMatrixStore,
  nowIso: string,
): CurrentGuardVariantMatrixRow {
  const total = obsForVariant.length;
  const open = obsForVariant.filter((o) => o.status === "OPEN").length;
  const rejected = obsForVariant.filter((o) => o.status === "REJECTED").length;
  const noFill = obsForVariant.filter((o) => o.status === "NO_FILL").length;
  const expired = obsForVariant.filter((o) => o.status === "EXPIRED").length;
  const dataFailure = obsForVariant.filter((o) => o.status === "DATA_FAILURE").length;
  const resolvedObs = obsForVariant.filter((o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS");
  // Sorted on the PROOF CLOCK (openedAt) — see buildContextEvidenceRow's identical sort and
  // episodeTimeMsOf for why there is exactly one clock in the proof path.
  const fresh = resolvedObs.filter(isFreshValidObs).sort(orderByEpisodeTime);

  const stressRoundTrip = roundTripBpsForCostModel(def.costModel) + STRESS_EXTRA_BPS;
  const blockWidthMs = variantMaxHoldMs(def.id);
  // Point 4: aggregate-level stage windows, searched over the FULL `fresh` population (scoping
  // `fresh` before this call would be circular). Diagnostic-only, same status as this row's own
  // status/statusReason/blockers (see the "aggregate diagnostic" comment below) — the exact-context
  // rows built via buildContextEvidenceRow below are what actually gate proof. Keyed distinctly
  // (`__aggregate__`) so it never collides with any real ExactLaneContext key.
  const stageProofs = computeStageProofs(`${def.id}::__aggregate__`, fresh, stressRoundTrip, store, nowIso, blockWidthMs);
  // Point 4d — HEADLINE METRICS ARE THE FULL POPULATION, identical discipline to
  // buildContextEvidenceRow: development/holdout separation is enforced inside `stageProofs` (each
  // stage recomputes its own dev economics from its own frozen window), so every field below reports
  // the live, growing fresh-valid set. See the `freshValid` doc on CurrentGuardVariantMatrixRow for
  // the live consumers that depend on that and for why a bounded headline count is a safety hazard
  // rather than extra rigour.
  //
  // Breakdown tables (byRegime/byDirection/byRegimeFamily/byAxis/byAxisSymbol/byEntryVariant/
  // bySymbol) and `rolling` were already on the full population and stay there — they are now simply
  // consistent with the rest of the row rather than an exception to it.

  const netVals = fresh.map((o) => o.netR);
  const grossVals = fresh.map((o) => o.grossR);
  const netAvgR = mean(netVals);
  const grossAvgR = mean(grossVals);
  const pf = profitFactor(netVals);

  const netWinners = fresh.filter((o) => (o.netR ?? 0) > 0);
  const netLosers = fresh.filter((o) => (o.netR ?? 0) <= 0);
  const avgWinR = mean(netWinners.map((o) => o.netR));
  const avgLossR = mean(netLosers.map((o) => o.netR));
  const payoffRatio = avgWinR !== null && avgLossR !== null && avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : null;
  const breakEvenWR = payoffRatio !== null ? 1 / (1 + payoffRatio) : null;
  const actualWR = fresh.length > 0 ? netWinners.length / fresh.length : null;
  const wr = actualWR;

  const avgCostR = mean(fresh.map((o) => o.costR));
  const costDragR = grossAvgR !== null && netAvgR !== null ? grossAvgR - netAvgR : null;

  const attemptDenom = total - rejected; // attempts that could fill/resolve
  const noFillRate = attemptDenom > 0 ? noFill / attemptDenom : null;
  const expiredRate = attemptDenom > 0 ? expired / attemptDenom : null;
  const avgHoldingMinutes = mean(fresh.map((o) => o.durationMinutes));

  const { drawdownR, streak } = drawdownAndStreak(fresh.map((o) => o.netR ?? 0));
  const symbolShare = topSymbolPnlShare(fresh);
  // Hoisted (was inlined in `partial`) so preFreezeCollection can reuse the SAME summary object the
  // row publishes, rather than recomputing it and risking a second, drifting answer.
  const evidenceVersionSummary = summarizeLaneEvidenceVersion(def.id, obsForVariant);

  // Same helper the stage proofs use, so the headline stress figure and each stage's
  // `dev.stressNetAvgR`/`holdout.stressNetAvgR` can never be computed two different ways.
  const plus10Vals = fresh.map((o) => stressNetROf(o, stressRoundTrip));
  const plus10bpsNetAvgR = mean(plus10Vals);
  const plus10bpsStillPositive = plus10bpsNetAvgR !== null && plus10bpsNetAvgR > 0;

  // Point 3d: independent regime EPISODES (chronological run-length-encode over the family key),
  // not distinct string labels — many rows from the same underlying episode must not inflate this.
  const distinctRegimes = countDistinctRegimeEpisodes(fresh);
  const effectiveN = computeEffectiveN(fresh, blockWidthMs);
  const distinctSymbolCount = new Set(fresh.map((o) => o.symbol)).size;
  const byRegime = breakdownRows(fresh, (o) => o.regime ?? "UNKNOWN");
  const byDirection = breakdownRows(fresh, (o) => o.direction);
  const byRegimeFamily = breakdownRows(fresh, observationRegimeFamilyKey);
  const byAxis = breakdownRows(fresh, (o) => `${o.direction}_${observationRegimeFamilyKey(o)}`);
  const byAxisSymbol = breakdownRows(fresh, (o) => `${o.direction}_${observationRegimeFamilyKey(o)}|${o.symbol}`);
  const byEntryVariant = breakdownRows(fresh, (o) => o.entryVariant ?? "unknown");
  const bySymbol = breakdownRows(fresh, (o) => o.symbol);

  const { oosThirds, allThreeOosPositive } = oosThirdsFor(fresh);

  const rolling = [
    rollingStat("last_10", fresh, 10),
    rollingStat("last_20", fresh, 20),
    rollingStat("last_50", fresh, 50),
  ];

  const partial = {
    variantId: def.id,
    label: def.label,
    exitRule: def.exitRule,
    fillMode: def.fillMode,
    costModel: def.costModel,
    evidenceVersionSummary,
    total,
    open,
    resolved: resolvedObs.length,
    freshValid: fresh.length,
    effectiveN,
    rejected,
    noFill,
    expired,
    dataFailure,
    netAvgR,
    grossAvgR,
    pf,
    wr,
    avgWinR,
    avgLossR,
    payoffRatio,
    breakEvenWR,
    actualWR,
    avgCostR,
    costDragR,
    noFillRate,
    expiredRate,
    avgHoldingMinutes,
    approxMaxDrawdownR: drawdownR,
    maxAdverseStreak: streak,
    topSymbolPnlShare: symbolShare,
    plus10bpsNetAvgR,
    plus10bpsStillPositive,
    calendarDays: calendarDays(fresh),
    distinctRegimes,
    distinctSymbolCount,
    byRegime,
    byDirection,
    byRegimeFamily,
    byAxis,
    byAxisSymbol,
    byEntryVariant,
    bySymbol,
    oosThirds,
    allThreeOosPositive,
    rolling,
    // Point 4 — both stage proofs plus the legacy STABLE-aliased fields (devN/devEffectiveN/
    // holdoutN/holdoutEffectiveN and the six holdout* names), and the promotion counterparts.
    // `devN` is NO LONGER an alias of `freshValid`: `freshValid` is the full population and `devN`
    // is the STABLE window's bounded development slice, so they diverge the moment that window
    // freezes. operator-brief.ts's `stageEvidenceLines` (renamed this round from `devHoldoutLine`,
    // because it now renders BOTH stages rather than one dev/holdout pair) reads these to surface the
    // split in section 4.
    ...stageProofs,
    // Point 4e — provisional, unfrozen collection progress. Built from the SAME `fresh` population
    // and the SAME episode rule the stage proofs above use, so the provisional episode count and the
    // frozen one it will become can never disagree. Report-only: `deriveVariantStatus` below reads
    // `stableProof`/`promotionProof` and never this.
    preFreezeCollection: buildPreFreezeCollection(
      fresh,
      blockWidthMs,
      stageProofs.stableProof,
      evidenceVersionSummary,
      calendarDays(fresh),
      distinctRegimes,
      distinctSymbolCount,
      symbolShare,
    ),
  };

  const aggregate = deriveVariantStatus(partial, infra);
  const contextRows: Partial<Record<ExactLaneContext, VariantContextEvidenceRow>> = {};
  for (const context of def.applicableContexts) {
    contextRows[context] = buildContextEvidenceRow(
      def,
      context,
      obsForVariant.filter((obs) => exactLaneContextForObservation(obs) === context),
      infra,
      store,
      nowIso,
    );
  }
  const contextStatuses = def.applicableContexts.map((context) => contextRows[context]!.status);
  const contextSummary = new Set(contextStatuses).size > 1 ? "CONTEXT_SPLIT" : "UNIFORM";

  // `status` remains an aggregate diagnostic for old report consumers. It is deliberately not a
  // proof verdict: conditional lanes must be read through laneStatusForContext below.
  return {
    ...partial,
    status: aggregate.status,
    statusReason: aggregate.statusReason,
    blockers: aggregate.blockers,
    cautions: aggregate.cautions,
    aggregateDiagnosticStatus: aggregate.status,
    aggregateDiagnosticStatusReason: aggregate.statusReason,
    aggregateDiagnosticBlockers: aggregate.blockers,
    aggregateDiagnosticCautions: aggregate.cautions,
    applicableContexts: def.applicableContexts,
    contextRows,
    contextSummary,
  };
}

/**
 * Canonical proof lookup. Missing context/evidence fails closed as COLLECTING: callers must never
 * promote a lane using a broad direction or aggregate status as a substitute for exact proof.
 */
export function laneStatusForContext(
  report: CurrentGuardVariantMatrixReport,
  laneId: string,
  context: ExactLaneContext | null,
): ContextLaneStatusLookup {
  const variantId = laneId.split(":").pop() ?? laneId;
  const definition = VARIANT_MATRIX_DEFINITIONS.find((candidate) => candidate.id === variantId);
  if (!definition) {
    return {
      laneId,
      context,
      applicable: false,
      direct: false,
      status: "COLLECTING",
      statusReason: "unknown lane has no canonical exact-context proof",
      blockers: ["missing canonical lane definition"],
      cautions: [],
      evidence: null,
    };
  }
  if (context === null) {
    return {
      laneId,
      context,
      applicable: false,
      direct: false,
      status: "COLLECTING",
      statusReason: "missing exact direction/regime context",
      blockers: ["exact context is required for promotion/readiness"],
      cautions: [],
      evidence: null,
    };
  }
  if (!definition.applicableContexts.includes(context)) {
    return {
      laneId,
      context,
      applicable: false,
      direct: true,
      status: "NOT_APPLICABLE",
      statusReason: `${context} is outside this lane's explicit applicability map`,
      blockers: [],
      cautions: [],
      evidence: null,
    };
  }
  const row = report.rows.find((candidate) => candidate.variantId === definition.id);
  const evidence = row?.contextRows?.[context] ?? null;
  if (!evidence) {
    return {
      laneId,
      context,
      applicable: true,
      direct: false,
      status: "COLLECTING",
      statusReason: "missing exact-context cohort; aggregate status is diagnostic only",
      blockers: ["no exact-context evidence"],
      cautions: [],
      evidence: null,
    };
  }
  return {
    laneId,
    context,
    applicable: true,
    direct: true,
    status: evidence.status,
    statusReason: evidence.statusReason,
    blockers: evidence.blockers,
    cautions: evidence.cautions,
    evidence,
  };
}

/**
 * Builds the report-only synthetic regime-adaptive lane by pairing each signal's existing
 * fresh-valid CG_WIDE (full-exit) and CG_SCALEOUT obs and selecting the full-exit outcome in a
 * confirmed strong-trend regime, else the scaleout outcome. Pure; never admits/resolves/mutates.
 */
function buildRegimeAdaptiveSyntheticReport(
  all: CurrentGuardVariantMatrixObservation[],
): RegimeAdaptiveSyntheticReport {
  const wideByKey = new Map<string, CurrentGuardVariantMatrixObservation>();
  const scaleByKey = new Map<string, CurrentGuardVariantMatrixObservation>();
  for (const o of all) {
    if (!isFreshValidObs(o)) continue;
    if (o.variantId === "CG_WIDE_STOP_TP_WIDE") wideByKey.set(o.sourceObservationKey, o);
    else if (o.variantId === "CG_SCALEOUT_TP1_TRAIL") scaleByKey.set(o.sourceObservationKey, o);
  }

  const picked: CurrentGuardVariantMatrixObservation[] = [];
  const widePaired: CurrentGuardVariantMatrixObservation[] = [];
  const scaleoutPaired: CurrentGuardVariantMatrixObservation[] = [];
  let pickedFullExit = 0;
  let pickedScaleout = 0;
  for (const [key, wide] of wideByKey) {
    const scale = scaleByKey.get(key);
    if (!scale) continue; // pair only — both branches must have an apples-to-apples outcome
    widePaired.push(wide);
    scaleoutPaired.push(scale);
    if (isStrongTrendRegime(wide.regime ?? scale.regime)) {
      picked.push(wide);
      pickedFullExit += 1;
    } else {
      picked.push(scale);
      pickedScaleout += 1;
    }
  }
  picked.sort(orderByResolved);

  const netVals = picked.map((o) => o.netR);
  const netAvgR = mean(netVals);
  const grossAvgR = mean(picked.map((o) => o.grossR));
  const pf = profitFactor(netVals);
  const wins = picked.filter((o) => (o.netR ?? 0) > 0).length;
  const wr = picked.length > 0 ? wins / picked.length : null;

  let oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null = null;
  let allThreeOosPositive = false;
  if (picked.length >= 3) {
    const third = Math.floor(picked.length / 3);
    const s1 = segmentStat("oos_1", picked.slice(0, third));
    const s2 = segmentStat("oos_2", picked.slice(third, 2 * third));
    const s3 = segmentStat("oos_3", picked.slice(2 * third));
    oosThirds = [s1, s2, s3];
    allThreeOosPositive = [s1, s2, s3].every((s) => s.netAvgR !== null && s.netAvgR > 0);
  }

  const scaleoutNetAvgR = mean(scaleoutPaired.map((o) => o.netR));
  const fullExitNetAvgR = mean(widePaired.map((o) => o.netR));
  const beatsScaleout = netAvgR !== null && scaleoutNetAvgR !== null && netAvgR > scaleoutNetAvgR;

  return {
    reportOnly: true,
    note:
      "Report-only synthetic lane: per signal, takes the CG_WIDE (full-exit) outcome in a confirmed " +
      "strong-trend regime, else the CG_SCALEOUT outcome — pairing existing resolved obs on the SAME " +
      "signals. Never admits/resolves. Must beat plain scaleout (beatsScaleout) to justify a real lane.",
    pairedSignals: picked.length,
    pickedFullExit,
    pickedScaleout,
    freshValid: picked.length,
    netAvgR,
    grossAvgR,
    pf,
    wr,
    oosThirds,
    allThreeOosPositive,
    scaleoutNetAvgR,
    fullExitNetAvgR,
    beatsScaleout,
  };
}

export function buildCurrentGuardVariantMatrixReport(
  store: CurrentGuardVariantMatrixStore,
  opts: CurrentGuardVariantMatrixReportOptions = {},
): CurrentGuardVariantMatrixReport {
  const computedAt = opts.capturedAt ?? new Date().toISOString();
  const computedAtMs = new Date(computedAt).getTime();
  const nowMs = Number.isFinite(computedAtMs) ? computedAtMs : Date.now();
  const all = store.all;
  const infra = {
    killSwitchReady: Boolean(opts.killSwitchReady),
    orderReconciliationReady: Boolean(opts.orderReconciliationReady),
    exchangeHealthReady: Boolean(opts.exchangeHealthReady),
  };

  // ── Resolver diagnostics (computed from store state + persisted meta) ─────
  const openObs = all.filter((o) => o.status === "OPEN");
  const staleOpenObs = openObs.filter((o) => {
    const ageMs = nowMs - (toMs(o.openedAt) ?? toMs(o.createdAt) ?? nowMs);
    return ageMs > variantMaxHoldMs(o.variantId);
  });
  let oldestOpenAgeHours: number | null = null;
  if (openObs.length > 0) {
    const oldestMs = Math.min(...openObs.map((o) => toMs(o.openedAt) ?? toMs(o.createdAt) ?? nowMs));
    oldestOpenAgeHours = Math.round(((nowMs - oldestMs) / (60 * 60 * 1000)) * 10) / 10;
  }
  const staleOpenCount = staleOpenObs.length;
  const meta = store.getResolverMeta();
  const resolverDiagnostics: VariantMatrixResolverDiagnostics = {
    lastRunAt: meta?.lastRunAt ?? null,
    resolvedThisRun: meta?.resolvedCount ?? null,
    expiredThisRun: meta?.expiredCount ?? null,
    dataFailuresThisRun: meta?.dataFailureCount ?? null,
    staleOpenCount,
    oldestOpenAgeHours,
    nextAction:
      staleOpenCount > 0
        ? `${staleOpenCount} OPEN observation(s) past lane max-hold; call /api/shadow/dashboard-audit-summary or operator-brief?resolve=1 to force MTM/expire them.`
        : openObs.length > 0
        ? "Open observations pending — resolver runs fire-and-forget on each dashboard call."
        : null,
  };

  // Group once (O(n)) instead of re-scanning the full (129k+ and growing) store once per lane
  // definition (O(n * lane count)) — this single line was the dominant cost of this report,
  // ~4s of the ~9s /api/shadow/neural-map takes to respond (found 2026-07-06 profiling why the
  // dashboard's 5s auto-refresh was consistently outrunning its own request).
  const byVariantId = new Map<VariantMatrixVariantId, CurrentGuardVariantMatrixObservation[]>();
  for (const o of all) {
    const list = byVariantId.get(o.variantId);
    if (list) list.push(o);
    else byVariantId.set(o.variantId, [o]);
  }
  const rows = VARIANT_MATRIX_DEFINITIONS.map((def) =>
    buildRow(def, byVariantId.get(def.id) ?? [], infra, store, computedAt),
  );

  const baselineRow = rows.find((r) => r.variantId === BASELINE_VARIANT_ID) ?? null;
  const baselineNet = baselineRow?.netAvgR ?? null;

  // Best candidate = highest netAvgR among variants with enough fresh-valid
  // evidence to be watchable.
  let bestVariantId: VariantMatrixVariantId | null = null;
  let bestVariantNetAvgR: number | null = null;
  for (const r of rows) {
    if (r.freshValid < WATCHABLE_MIN_FRESH || r.netAvgR === null) continue;
    if (bestVariantNetAvgR === null || r.netAvgR > bestVariantNetAvgR) {
      bestVariantNetAvgR = r.netAvgR;
      bestVariantId = r.variantId;
    }
  }
  const bestBeatsBaseline =
    bestVariantId !== null &&
    bestVariantId !== BASELINE_VARIANT_ID &&
    bestVariantNetAvgR !== null &&
    baselineNet !== null &&
    bestVariantNetAvgR > baselineNet;

  const notes: string[] = [
    "Report-only forward A/B harness. All variants are simulated against the same qualifying signal population; liveBlocked stays true and microPilotAllowed stays false.",
    "Resolution is conservative: same-candle SL+TP is refined with 1m candles where available, else resolves SL-first (a loss). Never optimistic.",
    "Per-variant cost-in-R = round-trip bps / stop-distance bps (wider stops carry lower cost-in-R). Taker round-trip = fee+slippage; maker = conservative maker fee.",
  ];

  return {
    reportOnly: true,
    laneVersion: CURRENT_GUARD_VARIANT_MATRIX_LANE,
    policyVersion: CURRENT_GUARD_VARIANT_MATRIX_POLICY_VERSION,
    computedAt,
    cutoverTimestamp: opts.cutoverTimestamp ?? null,
    sourcePopulationNote:
      "Same qualifying current-guard population as the F****** post-cutover lane (stop175 + anchor-consistent V2; post-cutover subset when a boundary is locked).",
    totalObservations: all.length,
    variantCount: VARIANT_MATRIX_DEFINITIONS.length,
    baselineVariantId: BASELINE_VARIANT_ID,
    rows,
    bestVariantId,
    bestVariantNetAvgR,
    bestBeatsBaseline,
    resolverDiagnostics,
    regimeAdaptiveSynthetic: buildRegimeAdaptiveSyntheticReport(all),
    killSwitchReady: infra.killSwitchReady,
    orderReconciliationReady: infra.orderReconciliationReady,
    exchangeHealthReady: infra.exchangeHealthReady,
    liveBlocked: true,
    microPilotAllowed: false,
    notes,
  };
}

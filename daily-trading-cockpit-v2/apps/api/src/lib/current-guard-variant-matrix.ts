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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type ShadowPosition } from "@dtc/shared";

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

export type VariantExitRule = "tp1_full" | "trail_after_tp1" | "scaleout_tp1_trail" | "mfe_giveback";
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

// --- Cost model (per-variant, honest: cost in R = roundTripBps / stopDistanceBps) ---
// Wider stops therefore carry a smaller cost-in-R, which is the single most
// important geometry fact the edge audit surfaced.
export const TAKER_ROUNDTRIP_BPS = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS; // 22 (fee+slippage, both sides)
// Maker provides liquidity (limit, no spread cross). Binance USD-M maker fee
// ~2bps/side; we add a conservative buffer so we never over-claim the maker edge.
export const MAKER_ROUNDTRIP_BPS = REALISTIC_FEE_BPS_PER_SIDE + 1; // 6 (conservative maker round-trip)
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

// --- Geometry constants ---
export const WIDE_STOP_MIN_BPS = 300; // Paper-admissible wide/trail variants require >= 300bps stops
export const MAKER_FILL_WINDOW_CANDLES = 12; // 1h on 5m candles to get a maker fill
const CANDLE_MS = 5 * 60 * 1000;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Max EXPIRED observations retained for the diagnostic count display; older ones are pruned from
 *  the store each resolve pass (they feed no stat). Bounds memory after the born-stale gate. */
const VM_MAX_EXPIRED_OBS = Number(process.env.VM_MAX_EXPIRED_OBS) || 500;
/** Open observations older than this threshold are surfaced as "stale" in diagnostics. */
const STALE_OPEN_WARN_MS = 72 * 60 * 60 * 1000; // 72 h
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
export const STABLE_MIN_FRESH = 100;
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

export interface VariantMatrixVariantDefinition {
  id: VariantMatrixVariantId;
  label: string;
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
}

export const VARIANT_MATRIX_DEFINITIONS: readonly VariantMatrixVariantDefinition[] = [
  {
    id: "CG_BASELINE_CURRENT",
    label: "Baseline current geometry (tp1 full exit)",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    description: "Benchmark: same entry/stop/tp1 as the post-cutover lane, taker cost, full exit at tp1.",
  },
  {
    id: "CG_WIDE_STOP_TP_WIDE",
    label: "Wide stop (>=300bps) with widened TP (~1R payoff)",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    description: "Widen stop to >=300bps AND widen TP to ~1R so the payoff ratio targets ~1.0 (never widen stop alone).",
  },
  {
    id: "CG_TRAIL_AFTER_TP1",
    label: "Wide stop (>=300bps) with trail after 1R touch",
    exitRule: "trail_after_tp1",
    fillMode: "taker",
    costModel: "taker",
    description: "Use >=300bps paired 1R geometry; on target touch move stop to breakeven and ride the exact candle path.",
  },
  {
    id: "CG_SCALEOUT_TP1_TRAIL",
    label: "Scale out 50% at TP1, trail the runner",
    exitRule: "scaleout_tp1_trail",
    fillMode: "taker",
    costModel: "taker",
    description: "Lock 50% at TP1, trail the remaining 50% at breakeven; blended R from the exact candle path.",
  },
  {
    id: "CG_NO_FIB500_ENTRYSET",
    label: "Baseline excluding fib_500_entry signals",
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    description: "Reject fib_500_entry signals (counted separately); otherwise identical to the baseline.",
  },
  {
    id: "CG_MAKER_LIMIT_SIM",
    label: "Maker/limit entry (no-fill risk) with maker cost",
    exitRule: "tp1_full",
    fillMode: "maker_limit",
    costModel: "maker_limit",
    description: "Post-only limit at entry: fills only on a pullback to entry within the fill window, else NO_FILL; maker cost.",
  },
  {
    id: BULL_TREND_VARIANT_ID,
    label: "Bull trend: stop >=200bps, TP 1.5R (full exit)",
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
    exitRule: "scaleout_tp1_trail",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 200,
    tpRewardMultiple: 1.0,
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
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.5,
    shortOnly: true,
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
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.5,
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
    exitRule: "trail_after_tp1",
    fillMode: "taker",
    costModel: "taker",
    stopFloorBps: 300,
    tpRewardMultiple: 0.5,
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

// ---------------------------------------------------------------------------
// Store (mirrors the proven ParallelShadowExperimentStore pattern). Isolated
// JSON file; load/save swallow all errors so report-only never breaks the app.
// ---------------------------------------------------------------------------
interface VariantMatrixStoreState {
  observations: CurrentGuardVariantMatrixObservation[];
  resolverMeta?: VariantMatrixResolverMeta;
}

function observationKey(sourceObservationKey: string, variantId: string): string {
  return `${sourceObservationKey}::${variantId}`;
}

export class CurrentGuardVariantMatrixStore {
  private readonly file: string;
  private observations: CurrentGuardVariantMatrixObservation[];
  private resolverMetaInternal: VariantMatrixResolverMeta | null;
  // O(1) duplicate check for hasObservation(), maintained alongside `observations`. Before this,
  // hasObservation() did a `.some()` linear scan over the WHOLE array — fine at hundreds of obs, but
  // mirrorVariantMatrixSignals calls it once per candidate observation, and once the store grew past
  // ~80k (the fresh-VM-feed's higher ingestion rate), a single mirror cycle could do tens of millions
  // of comparisons synchronously — long enough to starve the event loop's timer queue and make an
  // `await Promise.race([x, timeout(8000)])` a few lines later actually take 200+ seconds, because the
  // 8s setTimeout callback itself couldn't fire until the synchronous scan finished. (Observed: every
  // operator-brief?resolve=1 cycle on / (3101) hanging 190-235s and getting aborted.)
  private observationKeySet: Set<string>;

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
        };
      }
      return { observations: [] };
    } catch {
      return { observations: [] };
    }
  }

  save(): void {
    try {
      const state: VariantMatrixStoreState = { observations: this.observations };
      if (this.resolverMetaInternal) state.resolverMeta = this.resolverMetaInternal;
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
}

export interface VariantWalkResult {
  status: "CLOSED_WIN" | "CLOSED_LOSS" | "NO_FILL" | "UNRESOLVED";
  grossR: number | null;
  openedAtMs: number | null;
  closedAtMs: number | null;
  maxMfeR: number | null;
  minMaeR: number | null;
  intrabarResolutionStatus: VariantIntrabarStatus;
  isFreshValid: boolean | null;
  resolutionSource: string | null;
}

function rewardR(dir: Direction, entry: number, target: number, risk: number): number {
  if (!(risk > 0)) return 0;
  return dir === "LONG" ? (target - entry) / risk : (entry - target) / risk;
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
  const risk = dir === "LONG" ? E - S : S - E;
  const empty: VariantWalkResult = {
    status: "UNRESOLVED",
    grossR: null,
    openedAtMs: null,
    closedAtMs: null,
    maxMfeR: null,
    minMaeR: null,
    intrabarResolutionStatus: null,
    isFreshValid: null,
    resolutionSource: null,
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
  let pathValid = true;

  const updatePath = (high: number, low: number) => {
    if (!pathValid) return;
    const favorable = dir === "LONG" ? Math.max(high - E, 0) : Math.max(E - low, 0);
    const adverse = dir === "LONG" ? Math.min(low - E, 0) : Math.min(E - high, 0);
    const mfeR = favorable / risk;
    const maeR = adverse / risk;
    if (!Number.isFinite(mfeR) || !Number.isFinite(maeR) || Math.abs(mfeR) > MFE_MAE_CAP_R || Math.abs(maeR) > MFE_MAE_CAP_R) {
      pathValid = false;
      return;
    }
    if (mfeR > maxMfeR) maxMfeR = mfeR;
    if (maeR < minMaeR) minMaeR = maeR;
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
    intrabarResolutionStatus: intrabar,
    isFreshValid,
    resolutionSource,
  });

  const fullRewardR = rewardR(dir, E, T, risk);

  // Shared trail state (trail_after_tp1 / scaleout_tp1_trail).
  let tp1Touched = false;

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
    updatePath(high, low);

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
    return finalize(status, grossR, candleCloseTime(lastCandle), "TRAIL_PATH_END", "VALID_5M_ORDERED", true);
  }

  return empty;
}

export async function resolveVariantMatrixObservations(
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
    const cursorRaw = store.getResolverMeta()?.walkCursor ?? 0;
    const cursor = youngSorted.length > 0 ? ((cursorRaw % youngSorted.length) + youngSorted.length) % youngSorted.length : 0;
    walkCursorStart = cursor;
    const young = [...youngSorted.slice(cursor), ...youngSorted.slice(0, cursor)];
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
        const closedAtMs = toMs(obs.resolvedAt) ?? null;
        const endBound = Math.min((closedAtMs ?? nowMs) + twoHoursMs, nowMs + twoHoursMs);
        const startTime = openedAtMs - CANDLE_MS;
        const endTime = endBound;
        const cacheKey = `${obs.symbol}|${startTime}|${endTime}`;
        let candles = candleCache.get(cacheKey);
        if (!candles) {
          candles = await binanceClient.getKlines(obs.symbol, "5m", {
            startTime,
            endTime,
            limit: Math.min(Math.max(Math.ceil((endTime - startTime) / CANDLE_MS) + 2, 12), 1000),
          });
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

        const variantDef = VARIANT_MATRIX_DEFINITIONS.find((def) => def.id === obs.variantId);
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

export interface CurrentGuardVariantMatrixRow {
  variantId: VariantMatrixVariantId;
  label: string;
  exitRule: VariantExitRule;
  fillMode: VariantFillMode;
  costModel: VariantFillMode;

  total: number;
  open: number;
  resolved: number;
  freshValid: number;
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
  byRegime: VariantBreakdownRow[];
  /** Direction cohort performance for the same fresh-valid row population. */
  byDirection?: VariantBreakdownRow[];
  /** Coarse regime-family cohort; MIXED answers choppy/range performance directly. */
  byRegimeFamily?: VariantBreakdownRow[];
  byEntryVariant: VariantBreakdownRow[];
  bySymbol: VariantBreakdownRow[];

  oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null;
  allThreeOosPositive: boolean;
  rolling: VariantRollingStat[];

  status: VariantMatrixStatus;
  statusReason: string;
  blockers: string[];
  cautions: string[];
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

function isFreshValidObs(obs: CurrentGuardVariantMatrixObservation): boolean {
  return (
    (obs.status === "CLOSED_WIN" || obs.status === "CLOSED_LOSS") &&
    obs.isFreshValid !== false &&
    typeof obs.grossR === "number" &&
    Number.isFinite(obs.grossR) &&
    typeof obs.netR === "number" &&
    Number.isFinite(obs.netR)
  );
}

function orderByResolved(a: CurrentGuardVariantMatrixObservation, b: CurrentGuardVariantMatrixObservation): number {
  const am = toMs(a.resolvedAt) ?? toMs(a.openedAt) ?? 0;
  const bm = toMs(b.resolvedAt) ?? toMs(b.openedAt) ?? 0;
  return am - bm;
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

function regimeFamilyKey(regime: string | null | undefined): "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN" {
  const label = (regime ?? "").toLowerCase();
  if (label.includes("mixed") || label.includes("chop") || label.includes("range") || label.includes("rotation") || label.includes("sideways")) {
    return "MIXED";
  }
  if (label.includes("bull")) return "BULLISH";
  if (label.includes("bear")) return "BEARISH";
  return "UNKNOWN";
}

function topSymbolPnlShare(slice: CurrentGuardVariantMatrixObservation[]): number | null {
  if (slice.length === 0) return null;
  const totalAbs = slice.reduce((s, o) => s + Math.abs(o.netR ?? 0), 0);
  if (!(totalAbs > 0)) return null;
  const bySymbol = new Map<string, number>();
  for (const o of slice) bySymbol.set(o.symbol, (bySymbol.get(o.symbol) ?? 0) + Math.abs(o.netR ?? 0));
  return Math.max(...bySymbol.values()) / totalAbs;
}

function calendarDays(slice: CurrentGuardVariantMatrixObservation[]): number | null {
  const times = slice.map((o) => toMs(o.resolvedAt) ?? toMs(o.openedAt)).filter((v): v is number => v !== null);
  if (times.length === 0) return null;
  return Math.round(((Math.max(...times) - Math.min(...times)) / (24 * 60 * 60 * 1000)) * 100) / 100;
}

function roundTripBpsForCostModel(costModel: VariantFillMode): number {
  return costModel === "maker_limit" ? MAKER_ROUNDTRIP_BPS : TAKER_ROUNDTRIP_BPS;
}

export function deriveVariantStatus(
  row: Omit<CurrentGuardVariantMatrixRow, "status" | "statusReason" | "blockers" | "cautions">,
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
  const infraReady = infra.killSwitchReady && infra.orderReconciliationReady && infra.exchangeHealthReady;

  // PROMOTION_CANDIDATE (still report-only; infra gates are always false today).
  if (
    row.freshValid >= PROMOTION_MIN_FRESH &&
    row.allThreeOosPositive &&
    net !== null && net > NET_STRONG_R &&
    pf !== null && pf > PF_STRONG &&
    payoff !== null && payoff >= PAYOFF_AUTHORIZE &&
    drawdownOk && shareOk &&
    (row.calendarDays ?? 0) >= PROMOTION_MIN_CALENDAR_DAYS &&
    row.distinctRegimes >= PROMOTION_MIN_DISTINCT_REGIMES &&
    infraReady
  ) {
    return {
      status: "PROMOTION_CANDIDATE",
      statusReason: "All anti-overfit + multi-day/regime + infra gates pass. Remains report-only until explicit manual approval.",
      blockers,
      cautions: ["report-only: promotion requires explicit manual approval; liveBlocked stays true"],
    };
  }

  // STABLE_CANDIDATE.
  if (
    row.freshValid >= STABLE_MIN_FRESH &&
    row.allThreeOosPositive &&
    net !== null && net > NET_STRONG_R &&
    pf !== null && pf > PF_STRONG &&
    payoff !== null && payoff >= PAYOFF_AUTHORIZE &&
    drawdownOk && shareOk
  ) {
    if (row.freshValid < PROMOTION_MIN_FRESH) blockers.push(`freshValid ${row.freshValid} < ${PROMOTION_MIN_FRESH} for promotion`);
    if ((row.calendarDays ?? 0) < PROMOTION_MIN_CALENDAR_DAYS) blockers.push("needs more calendar-day coverage");
    if (row.distinctRegimes < PROMOTION_MIN_DISTINCT_REGIMES) blockers.push("needs multiple market regimes");
    if (!infraReady) blockers.push("live infra gates not ready (kill-switch/order-recon/exchange-health)");
    return {
      status: "STABLE_CANDIDATE",
      statusReason: `freshValid=${row.freshValid}, all OOS thirds positive, payoff=${payoff.toFixed(2)} — stable but not yet promotable`,
      blockers,
      cautions,
    };
  }

  // WATCHABLE.
  const plus10ok = row.plus10bpsStillPositive;
  if (
    row.freshValid >= WATCHABLE_MIN_FRESH &&
    net !== null && net > 0 &&
    pf !== null && pf > PF_STRONG &&
    payoff !== null && payoff >= PAYOFF_WATCH &&
    plus10ok && shareOk
  ) {
    if (row.freshValid < STABLE_MIN_FRESH) blockers.push(`freshValid ${row.freshValid} < ${STABLE_MIN_FRESH} for stable`);
    if (!row.allThreeOosPositive) blockers.push("not all OOS thirds positive");
    if (payoff < PAYOFF_AUTHORIZE) blockers.push(`payoff ${payoff.toFixed(2)} < ${PAYOFF_AUTHORIZE}`);
    // Surface the STABLE-gate fails that DON'T appear in this branch's `if` condition. Without this a
    // lane that already clears freshValid≥100 + OOS + payoff but is held back ONLY by drawdown shows
    // WATCHABLE with an EMPTY blocker list — the operator can't see why it won't advance to STABLE.
    if (row.freshValid >= STABLE_MIN_FRESH && !drawdownOk && dd !== null) {
      blockers.push(`drawdown ${dd.toFixed(1)}R > ${drawdownLimitR.toFixed(1)}R cap (sole gate left below STABLE)`);
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
): CurrentGuardVariantMatrixRow {
  const total = obsForVariant.length;
  const open = obsForVariant.filter((o) => o.status === "OPEN").length;
  const rejected = obsForVariant.filter((o) => o.status === "REJECTED").length;
  const noFill = obsForVariant.filter((o) => o.status === "NO_FILL").length;
  const expired = obsForVariant.filter((o) => o.status === "EXPIRED").length;
  const dataFailure = obsForVariant.filter((o) => o.status === "DATA_FAILURE").length;
  const resolvedObs = obsForVariant.filter((o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS");
  const fresh = resolvedObs.filter(isFreshValidObs).sort(orderByResolved);

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

  const stressRoundTrip = roundTripBpsForCostModel(def.costModel) + STRESS_EXTRA_BPS;
  const plus10Vals = fresh.map((o) => {
    if (typeof o.grossR !== "number" || o.stopDistanceBps === null || !(o.stopDistanceBps > 0)) return null;
    return o.grossR - stressRoundTrip / o.stopDistanceBps;
  });
  const plus10bpsNetAvgR = mean(plus10Vals);
  const plus10bpsStillPositive = plus10bpsNetAvgR !== null && plus10bpsNetAvgR > 0;

  const regimes = new Set(fresh.map((o) => o.regime ?? "UNKNOWN"));
  const distinctRegimes = regimes.size;
  const byRegime = breakdownRows(fresh, (o) => o.regime ?? "UNKNOWN");
  const byDirection = breakdownRows(fresh, (o) => o.direction);
  const byRegimeFamily = breakdownRows(fresh, (o) => regimeFamilyKey(o.regime));
  const byEntryVariant = breakdownRows(fresh, (o) => o.entryVariant ?? "unknown");
  const bySymbol = breakdownRows(fresh, (o) => o.symbol);

  let oosThirds: [VariantSegmentStat, VariantSegmentStat, VariantSegmentStat] | null = null;
  let allThreeOosPositive = false;
  if (fresh.length >= 3) {
    const third = Math.floor(fresh.length / 3);
    const s1 = segmentStat("oos_1", fresh.slice(0, third));
    const s2 = segmentStat("oos_2", fresh.slice(third, 2 * third));
    const s3 = segmentStat("oos_3", fresh.slice(2 * third));
    oosThirds = [s1, s2, s3];
    allThreeOosPositive = [s1, s2, s3].every((s) => s.netAvgR !== null && s.netAvgR > 0);
  }

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
    total,
    open,
    resolved: resolvedObs.length,
    freshValid: fresh.length,
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
    byRegime,
    byDirection,
    byRegimeFamily,
    byEntryVariant,
    bySymbol,
    oosThirds,
    allThreeOosPositive,
    rolling,
  };

  const { status, statusReason, blockers, cautions } = deriveVariantStatus(partial, infra);
  return { ...partial, status, statusReason, blockers, cautions };
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
    return ageMs > STALE_OPEN_WARN_MS;
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
        ? `${staleOpenCount} OPEN observation(s) >72h; call /api/shadow/dashboard-audit-summary or operator-brief?resolve=1 to expire them.`
        : openObs.length > 0
        ? "Open observations pending — resolver runs fire-and-forget on each dashboard call."
        : null,
  };

  const rows = VARIANT_MATRIX_DEFINITIONS.map((def) =>
    buildRow(def, all.filter((o) => o.variantId === def.id), infra),
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

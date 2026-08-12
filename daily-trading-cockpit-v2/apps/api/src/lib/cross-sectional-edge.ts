/**
 * Cross-sectional market-neutral measurement lane (report-only).
 *
 * Each cycle ranks the scanner universe by a cross-sectional score and records report-only baskets.
 * Baseline variants measure equal-notional momentum dispersion; adaptive variants add side-specific
 * symbol eligibility, inverse-vol weighting, regime tags, and basket-level TP/SL/regime-flip exits.
 *
 * Report-only like fade-long / h6-trend: NEVER touches the allocator, paper book, or live engine.
 * Env-gated (CROSS_SECTIONAL_EDGE_DISABLED=1). It is a HYPOTHESIS — crypto is highly correlated, so
 * dispersion (the fuel) can collapse in risk-on/off; prove OOS across bull AND bear before any read.
 */
import type { Candle } from "@dtc/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { clusterOf, isMajorCluster } from "./correlation-clusters.js";

function envNumPos(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const CROSS_SECTIONAL_MAX_STORED_OBSERVATIONS = envNumPos(
  "CROSS_SECTIONAL_EDGE_MAX_STORED_OBSERVATIONS",
  5000,
);

function envNumNonNeg(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envSymbolSet(key: string, fallback: string): ReadonlySet<string> {
  const raw = process.env[key] ?? fallback;
  return new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
}

const INTERVAL_MS: Record<string, number> = {
  "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "6h": 6 * 60 * 60_000, "1d": 24 * 60 * 60_000,
};

export const CROSS_SECTIONAL_INTERVAL = process.env.CROSS_SECTIONAL_INTERVAL || "1h";
export const CROSS_SECTIONAL_MOMENTUM_BARS = envNumPos("CROSS_SECTIONAL_MOMENTUM_BARS", 24); // ROC lookback
export const CROSS_SECTIONAL_K = envNumPos("CROSS_SECTIONAL_K", 3); // legs per side (long-k / short-k)

// --- Regime-skewed composition (2026-07-08, operator-requested) ---
// Real data (99 closed FILTERED baskets): TREND_LONG-at-open baskets averaged +2.79% on the long leg
// vs -1.83% on the short leg; TREND_SHORT-at-open averaged +1.92% short vs +0.02% long — whichever
// side matches the regime carries the basket, the other is close to dead weight or a real drag. This
// tilts leg COUNT toward the regime-favored side when the regime-axis score (see
// regime-axis-timeline.ts) is outside its ±0.12 neutral boundary — the SAME boundary already proven
// out by the directional lane-switch guidance. Applied ONLY to the FILTERED (executed) variant; RAW
// stays unskewed as the enduring, unmodified OOS control. Env-gated + off by default.
export function isCrossSectionalRegimeSkewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_REGIME_SKEW_ENABLED === "1";
}
export const CROSS_SECTIONAL_REGIME_SKEW_ZONE_BOUNDARY = envNumPos("CROSS_SECTIONAL_REGIME_SKEW_ZONE_BOUNDARY", 0.12);
export const CROSS_SECTIONAL_REGIME_SKEW_DELTA = envNumPos("CROSS_SECTIONAL_REGIME_SKEW_DELTA", 1); // 3/3 -> 4/2

/** Pure: given the base per-side k and the current regime-axis score, returns the (possibly skewed)
 *  long/short leg counts. Null/non-finite/inside-neutral-zone score -> unchanged 3/3-style symmetry.
 *  The delta is capped so the disfavored side can never drop to 0 (a hedge, however small, survives). */
export function regimeSkewedK(
  baseK: number,
  axisScore: number | null,
  opts: { zoneBoundary?: number; delta?: number } = {},
): { longK: number; shortK: number } {
  const zoneBoundary = opts.zoneBoundary ?? CROSS_SECTIONAL_REGIME_SKEW_ZONE_BOUNDARY;
  if (axisScore === null || !Number.isFinite(axisScore) || Math.abs(axisScore) <= zoneBoundary) {
    return { longK: baseK, shortK: baseK };
  }
  const delta = Math.max(0, Math.min(baseK - 1, opts.delta ?? CROSS_SECTIONAL_REGIME_SKEW_DELTA));
  return axisScore > 0 ? { longK: baseK + delta, shortK: baseK - delta } : { longK: baseK - delta, shortK: baseK + delta };
}
/** 2026-07-12 (profitability Stage 3): report-only counterfactual measuring what the regime skew
 *  (CROSS_SECTIONAL_REGIME_SKEW_ENABLED, 3/3 → 4/2 in a bullish axis) actually costs or earns on
 *  REAL closed baskets. The adversarial diagnosis flagged that the skew turns the book's only
 *  genuine hedge into more same-direction beta precisely when a regime flip would hurt — this
 *  answers "is the tilt paying?" from real fills, not simulation. A basket is "skewed" when its
 *  long-leg count ≠ short-leg count. Reports each cohort's mean net return, and within skewed
 *  baskets the mean per-leg return on each side — if the LONG side (the one the skew over-weights
 *  in a bull axis) isn't out-returning the short side, the skew is adding directional risk for no
 *  edge and should be reconsidered. Pure function; caller supplies the closed baskets. */
export interface RegimeSkewCounterfactual {
  skewedCount: number;
  symmetricCount: number;
  skewedMeanNetUsd: number | null;
  symmetricMeanNetUsd: number | null;
  skewedLongLegMeanReturnPct: number | null;
  skewedShortLegMeanReturnPct: number | null;
  /** Positive ⇒ the over-weighted long side out-returned the short side on skewed baskets (skew
   *  paying); negative ⇒ the skew added long beta the dispersion didn't reward. Null until data. */
  skewLongMinusShortEdgePct: number | null;
  verdict: "SKEW_PAYING" | "SKEW_COSTING" | "INSUFFICIENT_DATA";
}
export function regimeSkewCounterfactual(
  closedBaskets: ReadonlyArray<{
    netPnlUsd: number | null;
    legs: ReadonlyArray<{ side: "LONG" | "SHORT"; entryPrice: number; exitPrice: number | null }>;
  }>,
): RegimeSkewCounterfactual {
  const mean = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const legReturnPct = (leg: { side: "LONG" | "SHORT"; entryPrice: number; exitPrice: number | null }): number | null => {
    const exit = leg.exitPrice;
    if (exit === null || !(leg.entryPrice > 0) || !(exit > 0)) return null;
    return leg.side === "LONG" ? (exit - leg.entryPrice) / leg.entryPrice : (leg.entryPrice - exit) / leg.entryPrice;
  };
  const skewedNet: number[] = [];
  const symmetricNet: number[] = [];
  const skewedLongLegReturns: number[] = [];
  const skewedShortLegReturns: number[] = [];
  for (const b of closedBaskets) {
    const longs = b.legs.filter((l) => l.side === "LONG").length;
    const shorts = b.legs.filter((l) => l.side === "SHORT").length;
    const isSkewed = longs !== shorts;
    if (typeof b.netPnlUsd === "number") (isSkewed ? skewedNet : symmetricNet).push(b.netPnlUsd);
    if (isSkewed) {
      for (const leg of b.legs) {
        const r = legReturnPct(leg);
        if (r === null) continue;
        (leg.side === "LONG" ? skewedLongLegReturns : skewedShortLegReturns).push(r);
      }
    }
  }
  const skewedLongMean = mean(skewedLongLegReturns);
  const skewedShortMean = mean(skewedShortLegReturns);
  const edge =
    skewedLongMean !== null && skewedShortMean !== null ? skewedLongMean - skewedShortMean : null;
  const verdict: RegimeSkewCounterfactual["verdict"] =
    edge === null || skewedNet.length < 5 ? "INSUFFICIENT_DATA" : edge >= 0 ? "SKEW_PAYING" : "SKEW_COSTING";
  return {
    skewedCount: skewedNet.length,
    symmetricCount: symmetricNet.length,
    skewedMeanNetUsd: mean(skewedNet),
    symmetricMeanNetUsd: mean(symmetricNet),
    skewedLongLegMeanReturnPct: skewedLongMean,
    skewedShortLegMeanReturnPct: skewedShortMean,
    skewLongMinusShortEdgePct: edge,
    verdict,
  };
}
export const CROSS_SECTIONAL_HORIZON_BARS = envNumPos("CROSS_SECTIONAL_HORIZON_BARS", 24); // forward hold (bars)
export const CROSS_SECTIONAL_ROUNDTRIP_BPS = Number(process.env.CROSS_SECTIONAL_ROUNDTRIP_BPS ?? 12); // per-position round-trip cost
export const CROSS_SECTIONAL_FILTERED_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_FILTERED`;
export const CROSS_SECTIONAL_TREND_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_TREND_BETA_VOL`;
export const CROSS_SECTIONAL_MIXED_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_MIXED_MR`;
export const CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP", 0.02); // 24h momentum spread floor
// 2026-07-08 (operator-requested): the universe was 40% L1 (SOL/AVAX/SUI/INJ/APT/SEI/NEAR/ADA),
// so a pure top-k/bottom-k score sort could fill an ENTIRE side with one correlated cluster —
// nominally "3 different symbols" but effectively one correlated bet, not the diversified hedge
// the basket is supposed to be. Caps how many of a side's selected legs may share a cluster
// (BTC/ETH majors exempt, same convention as the directional concentration cap). 0 disables.
export const CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER", 2);
// 2026-08-12: liquidity floor for the FILTERED basket's candidate pool, in USD of quote volume per
// 1h bar (median over the trailing window). 0 = DISABLED, which is the default on purpose — this
// module is shared by research/testnet/live via rsync, so a non-zero default here would silently
// narrow live's trading universe (see the CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL block above for the
// same reasoning). Exists because widening the allowlists — the change this ships alongside — hands
// the ranking the WHOLE universe, including names thin enough that a basket leg would move them.
// A 187-day replay of this module's own functions over real 1h klines measured the widened pool at
// +0.270%/day and the widened pool PLUS this floor at +0.287%/day with the worst drawdown improving
// from -8.4% to -7.0%; the floor's real job is that drawdown number, not the mean.
export const CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR = envNumNonNeg("CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR", 0);
// 168 bars = 7d of 1h candles. NOT 720 (~30d): runCrossSectionalCycleGuarded's caller fetches
// `CROSS_SECTIONAL_MOMENTUM_BARS + 5` candles per symbol, so a lookback longer than what is
// actually fetched silently starves the median and every symbol fails the sample test — see the
// minSamples note in liquidCrossSectionalSymbols for what that produced on testnet 2026-08-12.
export const CROSS_SECTIONAL_LIQUIDITY_LOOKBACK_BARS = envNumPos("CROSS_SECTIONAL_LIQUIDITY_LOOKBACK_BARS", 168);
export const CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS", 25); // proof target
export const CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS = envNumNonNeg("CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS", 35); // safer proof target
export const CROSS_SECTIONAL_TREND_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_TREND_MIN_SCORE_GAP", 0.035);
export const CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP", 0.035);
export const CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS = envNumNonNeg("CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS", 40);
export const CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS = envNumNonNeg("CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS", 30);
export const CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT = Math.min(0.9, Math.max(0.1, Number(process.env.CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT ?? 0.35)));
// 2026-07-07: "PEPEUSDT" is not a real Binance futures symbol — the exchange lists it as
// "1000PEPEUSDT" (a 1000x-multiplier contract), confirmed against the real exchangeInfo/klines
// endpoints on both mainnet and testnet (both reject plain "PEPEUSDT" with "Invalid symbol").
// Any basket containing the wrong name as a leg silently failed at getExchangeFilters() inside
// cross-sectional-executor.ts's maybeOpenBasket() — no filter entry, no error, the whole basket
// just never opened. Fixed here at the source (env default + deployed .env values) rather than
// papering over it with a translation layer in the executor, per this module's own design
// constraint: "what executes is exactly what was measured — no separate signal path."
export const CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST",
  "ADAUSDT,BNBUSDT,ETHUSDT,OPUSDT,1000PEPEUSDT,SOLUSDT,SUIUSDT",
);
// 2026-07-09 (audit finding — live starvation): with CROSS_SECTIONAL_REGIME_SKEW_ENABLED=1, a
// deeply bearish axisScore pushes shortK to baseK+delta (e.g. 3->4). The prior 5-symbol allowlist
// had NO margin above that (2 of the 5 sit in CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST-adjacent
// demotion churn — SEIUSDT/WLDUSDT — leaving exactly 3 raw-eligible, below the skewed shortK of 4).
// buildCrossSectionalBasket() returns null whenever selectedShorts.length < shortK — this basket
// silently stopped opening for ~16-21h on live/testnet, in EXACTLY the bearish regime the skew
// exists to lean into. Widened with 5 more liquid symbols (none overlapping
// CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST, to avoid the same starvation via long/short exclusivity)
// so a handful of demotions can no longer drop the raw-eligible count below the skewed floor.
export const CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST",
  "DOGEUSDT,OPUSDT,1000PEPEUSDT,SEIUSDT,WLDUSDT,ARBUSDT,XRPUSDT,LINKUSDT,WIFUSDT,AAVEUSDT",
);
export const CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST",
  "APTUSDT,AVAXUSDT,FETUSDT,INJUSDT,NEARUSDT,RNDRUSDT",
);
export const CROSS_SECTIONAL_TREND_LONG_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_LONG_ALLOWLIST",
  "SOLUSDT,ETHUSDT,OPUSDT,1000PEPEUSDT",
);
export const CROSS_SECTIONAL_TREND_LONG_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_LONG_BLOCKLIST",
  "FETUSDT,INJUSDT,ARBUSDT,NEARUSDT,AVAXUSDT,BTCUSDT",
);
export const CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST",
  "WLDUSDT,SEIUSDT,DOGEUSDT,1000PEPEUSDT,APTUSDT,OPUSDT",
);
export const CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST",
  "AVAXUSDT,INJUSDT,FETUSDT,NEARUSDT,RNDRUSDT",
);

// --- MIXED pool reconfiguration (2026-07-26, measured dead-lane fix) — OFF BY DEFAULT ---
//
// READ THIS FIRST — WHAT ENABLING CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL=1 ACTUALLY DOES.
// It changes BOTH LEGS of the MIXED basket. It is NOT a long-side-only change:
//   • LONG side  — widened from CROSS_SECTIONAL_TREND_LONG_ALLOWLIST to this instance's own
//                  CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST (the measured fix; see below).
//   • SHORT side — NARROWED. Every symbol the widened long pool can now select is added to MIXED's
//                  short BLOCKLIST, so the two legs are disjoint by construction. On the default
//                  config that removes exactly OPUSDT and 1000PEPEUSDT from MIXED's short
//                  candidates (6 → 4). On a given instance it removes whatever
//                  (widened long allowlist \ long blocklist) ∩ short allowlist happens to be —
//                  derived at call time, never hardcoded, because live's FILTERED long allowlist
//                  (7 symbols) and testnet's (21) produce different overlaps.
// The short ALLOWLIST env var is unchanged on both paths; the short LEG is not. Anyone enabling
// this on an instance with CROSS_SECTIONAL_EXEC_ENABLED=1 is changing the short side of really
// executed baskets. Measured deltas are at the bottom of this block.
//
// WHY THE SHORT SIDE HAS TO MOVE AT ALL (the defect an earlier draft of this change hid).
// buildCrossSectionalBasket enforces long/short exclusivity: a symbol eligible for both sides is
// claimed by whichever side selects first (long, in the unskewed 3/3 case MIXED runs), and the
// other side only sees the leftovers. OPUSDT and 1000PEPEUSDT sit on BOTH
// CROSS_SECTIONAL_TREND_LONG_ALLOWLIST and CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST. Today the narrow
// 4-symbol long pool claims them most of the time. Widen the long pool and the long leg often stops
// picking them, so they fall THROUGH into the short leg — a short-side change nobody configured,
// varying bar to bar with the long side's ranking. Blocking them from MIXED's short side instead
// makes the short leg immune to long-side RANKING: with the pools disjoint, no arrangement of the
// long side's scores can reach the short leg. Stated precisely, because the looser version of this
// claim is false and was caught by [SHORT-DETERMINISM]: changing the long ALLOWLIST still changes
// the short leg, because the blocklist below is DERIVED from the long pool to keep them disjoint
// (TREND ⇒ 9 symbols blocked, FILTERED ⇒ 12, the whole universe ⇒ 24, which leaves too few short
// candidates to form a basket at all). That is an operator CONFIG change, visible in the env and
// deterministic. What this buys is the removal of the EMERGENT case — the short leg moving bar to
// bar with no config change at all. Determinism, not invariance. (Removing the two symbols from the WIDENED LONG set would
// NOT work: whether the long leg claims a symbol depends on its RANK, not on pool membership, so
// the spillover would remain.)
//
// buildMixedCrossSectionalBasket borrows CROSS_SECTIONAL_TREND_LONG_ALLOWLIST, which is
// deliberately narrow (4 symbols by default). Under MEAN_REVERSION selection that pool has almost
// no room to move: the long side takes the 3 WEAKEST of 4 (mean ≈ the pool mean) while the short
// side takes the 3 STRONGEST of its 6, so |scoreGap| collapses toward zero and essentially never
// clears CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP. Independent 500-bar backtest over the observed dead
// window (26-symbol universe, 24-bar ROC):
//     MIXED as configured, 4-symbol long pool  → median scoreGap 0.0127,  2.10% of bars clear 0.035
//     MIXED with the wider FILTERED long pool  → median scoreGap 0.0589, 97.48% of bars clear 0.035
//     TREND, same 4-symbol pool but MOMENTUM   → median scoreGap 0.0178,  9.24% clear (matches its
//                                                 real 75 baskets, i.e. the model is calibrated)
// So the binding constraint is the POOL, not the threshold and not the selection mode. The
// threshold is therefore left at 0.035 on purpose: the same backtest shows that with the widened
// pool 100% of bars would clear a 0.020 threshold, i.e. every MIXED_CHOP cycle would open a basket.
// Widening the pool keeps a real, if shallow, dispersion filter where lowering the threshold does not.
//
// CAVEAT ON THAT 97.48% — it describes LONG-WIDENING ALONE, which is NOT what this flag ships.
// The short-side disjointness below cuts MIXED's short candidates from 6 to 4 on the default config,
// and buildCrossSectionalBasket returns null whenever a side cannot fill shortK legs, so the shipped
// configuration clears the threshold LESS often than 97.48%. The candle backtest was not re-run
// against the shipped configuration (this checkout has no offline candles for that window and
// Binance market data is geo-blocked here), so treat 97.48% as an upper bound, not as the shipped
// number. The only evidence available for the shipped configuration is the seeded-draw harness
// below, calibrated so the flag-off clearance matches the observed dead lane (N(0, 0.015) scores →
// flag-off 2.29% of draws form a basket, vs the backtest's 2.10%): at that calibration long-widening
// alone reaches 9.96% and the shipped configuration reaches 4.79%. i.e. roughly HALF the widening's
// improvement is given back to buy the deterministic short leg. That is the trade this flag makes.
// The IID harness cannot reproduce the backtest's absolute 97.48% (real ROCs co-move; IID draws do
// not), so read 2.29→9.96→4.79 as a RATIO between configurations, never as a forecast of live
// clearance. If the lane still looks starved once enabled on testnet, the short pool — not the
// threshold — is where to look first.
//
// Why a flag and not a new hardcoded default list: /live and /testnet are rsync-only from this
// shared source and have silently diverged before, so a changed shared default IS a change to live.
// Each instance also curates its OWN CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST — live's is 7 symbols,
// NARROWER than testnet's 21 — so baking a testnet-shaped list in here would silently widen live's
// trading universe. Resolving through that per-instance env var means enabling this can only ever
// widen MIXED's long pool to symbols the operator has ALREADY approved for LONG execution on that
// same instance; it can never import another instance's universe. This matters because
// app.ts's isCrossSectionalTrendMixedAdmissionIndependent() branch can turn MIXED into real
// mainnet baskets, so the widened pool must be safe under the assumption that someone later sets
// that flag too. With the flag unset, crossSectionalMixedLongAllowlist() and
// crossSectionalMixedShortBlocklist() return the exact same sets MIXED uses today, so an un-flagged
// deploy (including a live rsync) is a bit-for-bit no-op on BOTH legs.
//
// MEASURED LEG EFFECT — 20,000 seeded-random draws over CROSS_SECTIONAL_UNIVERSE (mulberry32 seed
// 20260726, N(0, 0.35) scores, k=3; the [DRIFT] tests below re-run a smaller deterministic version
// of exactly this comparison, so the invariants cannot silently rot):
//     flag-off vs LONG-WIDENING ALONE — 18,961 baskets form in both states
//       LONG leg differs 88.30% | SHORT leg differs 36.68%  ← the defect. Nobody configured this.
//       Every one of those short-leg changes is OPUSDT (3,791) or 1000PEPEUSDT (3,637) arriving on
//       the short leg because the widened long leg stopped claiming it. Which bars, and which of
//       the two, depends on long-side RANKING — it is emergent, not configured.
//     flag-off vs THE SHIPPED CONFIGURATION — 18,582 baskets form in both states
//       LONG leg differs 88.27% | SHORT leg differs 47.75%  ← larger, and deliberately so.
//       The short-leg delta is BIGGER than the defect's, and it is still a real short-side change on
//       really executed baskets. The difference is that it is now completely enumerable: in all
//       8,872 differing baskets the change is a single 1-for-1 substitution — OPUSDT (4,441) or
//       1000PEPEUSDT (4,431) leaves the short leg and the next-ranked of SEI/WLD/DOGE/APT takes the
//       slot. No other symbol ever moved, and never more than one per basket.
//     DETERMINISM (why the bigger number is the better outcome) — "is the realized short leg equal
//       to the top-shortK of the short pool, computed with no knowledge of the long side?"
//         flag off / long-widening alone: TRUE in 55.18% of baskets — the long side moves the short leg
//         shipped configuration:          TRUE in 100.00% of baskets (19,423/19,423)
//       So after this change nothing on the long side can move the short leg, this flag or any
//       future long-pool edit. That is the property being bought.
//     TREND: 0 of 20,000 draws produced ANY difference in a TREND basket between flag states.
export function isCrossSectionalMixedWideLongPoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL === "1";
}

/** The long-side allowlist the MIXED (mean-reversion) basket actually uses. Resolved per call
 *  rather than frozen at module load so the flag is testable and so nothing can read a stale value.
 *  The long BLOCKLIST is intentionally NOT switched — CROSS_SECTIONAL_TREND_LONG_BLOCKLIST stays
 *  applied on both paths, so widening can only ADD symbols the operator allows for longs and can
 *  never re-admit one they explicitly blocked. The TREND lane reads CROSS_SECTIONAL_TREND_* directly
 *  and never calls this, so TREND is untouched. The SHORT side is NOT untouched — see
 *  crossSectionalMixedShortBlocklist. */
export function crossSectionalMixedLongAllowlist(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (!isCrossSectionalMixedWideLongPoolEnabled(env)) return CROSS_SECTIONAL_TREND_LONG_ALLOWLIST;
  // An EMPTY allowlist means "allow every symbol" to allowed(). Widening to that would hand MIXED
  // the whole universe on the long side and (via the disjointness below) blank its short side —
  // the exact silent blast radius this flag exists to avoid. An instance that has explicitly
  // approved nothing for FILTERED longs has nothing to widen to, so keep today's narrow pool.
  return CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST.size > 0
    ? CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST
    : CROSS_SECTIONAL_TREND_LONG_ALLOWLIST;
}

/** The short-side BLOCKLIST the MIXED basket actually uses — the short half of this change.
 *
 *  Flag off: CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST verbatim (today's behavior, byte for byte).
 *  Flag on:  that blocklist PLUS every symbol the widened long pool can select, so MIXED's long and
 *            short candidate pools are provably disjoint and buildCrossSectionalBasket's
 *            long-claims-it-first exclusivity rule can never move a symbol between the legs.
 *
 *  Expressed as a BLOCKLIST rather than a narrowed allowlist on purpose: allowed() treats an EMPTY
 *  allowlist as "allow everything", so subtracting from the allowlist could silently flip the short
 *  side from "these 6 symbols" to "the entire universe" on an instance whose overlap happens to be
 *  total. A blocklist has no such degenerate case — it only ever subtracts. If the subtraction
 *  leaves fewer than shortK candidates the basket simply does not form (buildCrossSectionalBasket
 *  returns null), which is the correct fail-closed outcome: an inert lane, never an unconfigured
 *  short. Derived from the long lists passed in, so an explicit opts.longAllowlist override keeps
 *  the disjointness guarantee instead of silently voiding it. */
export function crossSectionalMixedShortBlocklist(
  opts: {
    longAllowlist?: ReadonlySet<string> | null;
    longBlocklist?: ReadonlySet<string> | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): ReadonlySet<string> {
  const env = opts.env ?? process.env;
  if (!isCrossSectionalMixedWideLongPoolEnabled(env)) return CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST;
  const longAllowlist = opts.longAllowlist ?? crossSectionalMixedLongAllowlist(env);
  const longBlocklist = opts.longBlocklist ?? CROSS_SECTIONAL_TREND_LONG_BLOCKLIST;
  const out = new Set<string>(CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST);
  // A symbol the long blocklist already rejects can never reach the long leg, so it does not need
  // to be taken off the short side — keep the narrowing as small as the guarantee allows.
  for (const symbol of longAllowlist) if (!longBlocklist.has(symbol)) out.add(symbol);
  return out;
}
// 2026-07-08 (operator-requested widening): a dedicated universe for cross-sectional, separate
// from the main scanner's UNIVERSE (scan-service.ts) — widening THAT shared constant would also
// add these symbols to Kronos forecasting, directional lane candidates, etc., none of which were
// asked for or vetted here. The prior 20 were 40% L1 (SOL/AVAX/SUI/INJ/APT/SEI/NEAR/ADA), leaving
// MEME/AI/L2_DEFI too thin to ever fill a basket leg without repeating the same few names — these
// additions deepen those thin clusters specifically (see correlation-clusters.ts), not L1 further.
// "1000PEPEUSDT" (not the scanner's bare "PEPEUSDT") is the real Binance futures symbol — see
// spotSymbolForCandles usage at this universe's fetchCandles call site for the spot/futures split.
export const CROSS_SECTIONAL_UNIVERSE: readonly string[] = [
  ...envSymbolSet(
    "CROSS_SECTIONAL_UNIVERSE",
    "BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,AVAXUSDT,LINKUSDT,SUIUSDT,1000PEPEUSDT,ARBUSDT,OPUSDT," +
      "INJUSDT,WLDUSDT,APTUSDT,SEIUSDT,NEARUSDT,BNBUSDT,XRPUSDT,ADAUSDT,FETUSDT,RNDRUSDT," +
      "WIFUSDT,TAOUSDT,ARKMUSDT,UNIUSDT,AAVEUSDT,LDOUSDT",
  ),
];
const BAR_MS = INTERVAL_MS[CROSS_SECTIONAL_INTERVAL] ?? INTERVAL_MS["1h"]!;
export const CROSS_SECTIONAL_HORIZON_MS = CROSS_SECTIONAL_HORIZON_BARS * BAR_MS;
const EXPIRY_MS = CROSS_SECTIONAL_HORIZON_MS * 3; // give up on a basket missing prices well past its horizon

export type CrossSectionalStatus = "OPEN" | "CLOSED" | "EXPIRED";
export type CrossSectionalVariant = "RAW" | "FILTERED" | "TREND_BETA_VOL" | "MIXED_MEAN_REVERSION";
export type CrossSectionalStrategyFamily = "MOMENTUM_DISPERSION" | "MEAN_REVERSION";
export type CrossSectionalRegimeClass = "TREND_LONG" | "TREND_SHORT" | "MIXED_CHOP" | "UNKNOWN";
export type CrossSectionalExitReason = "HORIZON" | "TAKE_PROFIT" | "STOP_LOSS" | "REGIME_FLIP" | "EXPIRED";

export interface CrossSectionalLeg {
  symbol: string;
  entryPrice: number;
  exitPrice: number | null;
  /** Fraction of total basket capital assigned to this leg. Missing means legacy equal-weight. */
  weight?: number | null;
}

export interface CrossSectionalRegimeContext {
  currentRegime: string | null;
  controllerMode: string | null;
  directionalBias: string | null;
  confidence: string | null;
  capturedAt: string | null;
  regimeClass: CrossSectionalRegimeClass;
}

export interface CrossSectionalObservation {
  observationId: string;
  openedAt: string;
  openedAtMs: number;
  horizonMs: number;
  signal: string;
  variant?: CrossSectionalVariant;
  strategyFamily?: CrossSectionalStrategyFamily;
  k: number;
  /** Actual per-side leg counts used (2026-07-08, regime-skewed composition) — equal to `k` on both
   *  sides unless the regime-axis score was outside the neutral zone at open. Recorded per basket
   *  so skewed vs. unskewed baskets stay auditable/comparable after the fact. */
  longK?: number;
  shortK?: number;
  longLeg: CrossSectionalLeg[];
  shortLeg: CrossSectionalLeg[];
  status: CrossSectionalStatus;
  scoreGap?: number | null;
  regimeContext?: CrossSectionalRegimeContext | null;
  regimeClassAtOpen?: CrossSectionalRegimeClass | null;
  longCapitalWeight?: number | null;
  shortCapitalWeight?: number | null;
  weightingModel?: "EQUAL_NOTIONAL" | "BETA_VOL_PROXY" | null;
  takeProfitReturn?: number | null;
  stopLossReturn?: number | null;
  /** The R-denominator FROZEN at open (fraction). CORTEX #218 divides realized netReturn by THIS to get
   *  netR — never the live CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS at resolve (a deploy between open and
   *  resolve would else silently rewrite the denominator of every open basket). Set on every basket:
   *  = the real stop for TREND_BETA_VOL/MIXED, or the frozen config stop-unit for the stopless FILTERED
   *  basket (the SAME divisor the x-side CORTEX_XSEC_STOP_RETURN uses, kept consistent + config-proof). */
  riskDistanceAtOpen?: number | null;
  regimeFlipExit?: boolean | null;
  exitReason?: CrossSectionalExitReason | null;
  /** Return on deployed capital after market-beta cancels = the cross-sectional dispersion. */
  grossReturn: number | null;
  costReturn: number | null;
  netReturn: number | null;
  longLegReturn: number | null;
  shortLegReturn: number | null;
  resolvedAt: string | null;
}

export interface ScoredSymbol {
  symbol: string;
  score: number;
  price: number;
}

interface CrossSectionalBasketOpts {
  k: number;
  /** Per-side leg count overrides (2026-07-08, regime-skewed composition). Default to `k` when
   *  unset, so every existing caller is unaffected. */
  longK?: number;
  shortK?: number;
  signal: string;
  now: string;
  openedAtMs: number;
  horizonMs: number;
  variant?: CrossSectionalVariant;
  strategyFamily?: CrossSectionalStrategyFamily;
  selectionMode?: "MOMENTUM" | "MEAN_REVERSION";
  regimeContext?: CrossSectionalRegimeContext | null;
  longAllowlist?: ReadonlySet<string> | null;
  longBlocklist?: ReadonlySet<string> | null;
  shortAllowlist?: ReadonlySet<string> | null;
  shortBlocklist?: ReadonlySet<string> | null;
  minScoreGap?: number;
  /** Max legs per side allowed to share a correlation cluster (BTC/ETH majors exempt). Undefined/0
   *  disables — every existing caller (that never sets it) keeps today's pure top-k/bottom-k sort. */
  maxPerCluster?: number;
  longCapitalWeight?: number;
  shortCapitalWeight?: number;
  weightingModel?: "EQUAL_NOTIONAL" | "BETA_VOL_PROXY";
  volBySymbol?: Record<string, number>;
  takeProfitReturn?: number | null;
  stopLossReturn?: number | null;
  /** Override the frozen-at-open R-denominator. Defaults to stopLossReturn, else the config stop-unit. */
  riskDistanceAtOpen?: number | null;
  regimeFlipExit?: boolean;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Walks the score-sorted pool taking the best k, but skips a candidate that would push its
 *  cluster's count on this side past maxPerCluster — so a heavily-populated cluster (e.g. L1)
 *  can't fill an entire side even when it dominates the universe. Majors (BTC/ETH) are exempt,
 *  matching the directional concentration cap's convention. Order-preserving: still best-score-
 *  first among whatever remains eligible, never reshuffles for "fairness" beyond the cap itself. */
function selectWithClusterCap(sorted: ScoredSymbol[], k: number, maxPerCluster?: number): ScoredSymbol[] {
  if (!maxPerCluster || maxPerCluster <= 0) return sorted.slice(0, k);
  const selected: ScoredSymbol[] = [];
  const clusterCounts = new Map<string, number>();
  for (const s of sorted) {
    if (selected.length >= k) break;
    const cluster = clusterOf(s.symbol);
    const count = clusterCounts.get(cluster) ?? 0;
    if (!isMajorCluster(cluster) && count >= maxPerCluster) continue;
    selected.push(s);
    clusterCounts.set(cluster, count + 1);
  }
  return selected;
}

function allowed(symbol: string, allowlist?: ReadonlySet<string> | null, blocklist?: ReadonlySet<string> | null): boolean {
  const s = symbol.toUpperCase();
  if (blocklist?.has(s)) return false;
  return !allowlist || allowlist.size === 0 || allowlist.has(s);
}

function clampWeight(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function scoreGapFor(longLeg: ScoredSymbol[], shortLeg: ScoredSymbol[]): number {
  return Math.abs(mean(longLeg.map((s) => s.score)) - mean(shortLeg.map((s) => s.score)));
}

function weightedLegs(
  legs: ScoredSymbol[],
  sideCapital: number,
  opts: { weightingModel?: "EQUAL_NOTIONAL" | "BETA_VOL_PROXY"; volBySymbol?: Record<string, number> },
): CrossSectionalLeg[] {
  if (legs.length === 0) return [];
  const equalWeight = sideCapital / legs.length;
  if (opts.weightingModel !== "BETA_VOL_PROXY") {
    return legs.map((s) => ({ symbol: s.symbol, entryPrice: s.price, exitPrice: null, weight: equalWeight }));
  }
  const raw = legs.map((s) => {
    const vol = opts.volBySymbol?.[s.symbol];
    return Number.isFinite(vol) && vol! > 0 ? 1 / vol! : 1;
  });
  const denom = raw.reduce((a, b) => a + b, 0) || legs.length;
  return legs.map((s, i) => ({
    symbol: s.symbol,
    entryPrice: s.price,
    exitPrice: null,
    weight: sideCapital * raw[i]! / denom,
  }));
}

function legReturnContribution(legs: CrossSectionalLeg[], direction: "LONG" | "SHORT"): { normalizedReturn: number; contribution: number; weightSum: number } {
  const returns = legs.map((l) => {
    if (!(l.exitPrice !== null && l.entryPrice > 0)) return 0;
    return direction === "LONG" ? (l.exitPrice - l.entryPrice) / l.entryPrice : (l.entryPrice - l.exitPrice) / l.entryPrice;
  });
  const hasWeights = legs.some((l) => Number.isFinite(l.weight ?? NaN));
  if (!hasWeights) {
    const normalizedReturn = mean(returns);
    return { normalizedReturn, contribution: normalizedReturn / 2, weightSum: 0.5 };
  }
  const weightSum = legs.reduce((sum, l) => sum + (Number.isFinite(l.weight ?? NaN) ? Math.max(0, l.weight!) : 0), 0);
  const contribution = legs.reduce((sum, l, i) => sum + (Number.isFinite(l.weight ?? NaN) ? Math.max(0, l.weight!) : 0) * returns[i]!, 0);
  return { normalizedReturn: weightSum > 0 ? contribution / weightSum : 0, contribution, weightSum };
}

function shouldCutForRegimeFlip(obs: CrossSectionalObservation, current?: CrossSectionalRegimeContext | null): boolean {
  if (!obs.regimeFlipExit) return false;
  const from = obs.regimeClassAtOpen ?? obs.regimeContext?.regimeClass ?? null;
  const to = current?.regimeClass ?? null;
  return from !== null && to !== null && from !== "UNKNOWN" && to !== "UNKNOWN" && from !== to;
}

/** N-bar return (ROC) from candles + the latest close. null if not enough history. */
export function crossSectionalMomentumScore(candles: Candle[], bars: number): { score: number; price: number } | null {
  if (!Array.isArray(candles) || candles.length < bars + 1) return null;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1]!;
  const past = closes[closes.length - 1 - bars]!;
  if (!(price > 0) || !(past > 0)) return null;
  return { score: (price - past) / past, price };
}

/** Rank scored symbols and build an equal-notional long-top-k / short-bottom-k basket. */
export function buildCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: CrossSectionalBasketOpts,
): CrossSectionalObservation | null {
  const valid = scored.filter((s) => Number.isFinite(s.score) && Number.isFinite(s.price) && s.price > 0);
  const mode = opts.selectionMode ?? "MOMENTUM";
  const longK = opts.longK ?? opts.k;
  const shortK = opts.shortK ?? opts.k;
  const longPoolAll = valid.filter((s) => allowed(s.symbol, opts.longAllowlist, opts.longBlocklist));
  const longSortedAll = [...longPoolAll].sort((a, b) => mode === "MEAN_REVERSION" ? a.score - b.score : b.score - a.score);
  const shortPoolAll = valid.filter((s) => allowed(s.symbol, opts.shortAllowlist, opts.shortBlocklist));
  const shortSortedAll = [...shortPoolAll].sort((a, b) => mode === "MEAN_REVERSION" ? b.score - a.score : a.score - b.score);
  // A symbol eligible for BOTH sides (e.g. via CROSS_SECTIONAL_REGIME_SKEW's own allowlists) can
  // only ever fill one leg. Whichever side selects first claims it. Previously long always went
  // first, which starves short whenever a regime skew (see regimeSkewedK) raises shortK above
  // longK — the bearish-favored side needing MORE legs lost the shared symbols to the side needing
  // FEWER (2026-07-09 audit: BEAR skew needed 4 shorts / 2 longs, but long's greedy first pick took
  // both overlap-eligible symbols, leaving short one leg short). Select the side with the LARGER
  // requirement first so a regime-favored side is never starved by the other side's leftovers.
  // Ties (the common unskewed 3/3 case) keep the original long-first order unchanged.
  let selectedLongs: ScoredSymbol[];
  let selectedShorts: ScoredSymbol[];
  if (shortK > longK) {
    selectedShorts = selectWithClusterCap(shortSortedAll, shortK, opts.maxPerCluster);
    const shortSymbols = new Set(selectedShorts.map((s) => s.symbol));
    const longRemaining = longSortedAll.filter((s) => !shortSymbols.has(s.symbol));
    selectedLongs = selectWithClusterCap(longRemaining, longK, opts.maxPerCluster);
  } else {
    selectedLongs = selectWithClusterCap(longSortedAll, longK, opts.maxPerCluster);
    const longSymbols = new Set(selectedLongs.map((s) => s.symbol));
    const shortRemaining = shortSortedAll.filter((s) => !longSymbols.has(s.symbol));
    selectedShorts = selectWithClusterCap(shortRemaining, shortK, opts.maxPerCluster);
  }
  if (selectedLongs.length < longK || selectedShorts.length < shortK) return null;
  const scoreGap = scoreGapFor(selectedLongs, selectedShorts);
  if (opts.minScoreGap !== undefined && scoreGap < opts.minScoreGap) return null;
  const longCapitalWeight = clampWeight(opts.longCapitalWeight ?? 0.5, 0.5);
  const shortCapitalWeight = clampWeight(opts.shortCapitalWeight ?? (1 - longCapitalWeight), 1 - longCapitalWeight);
  const totalCapital = longCapitalWeight + shortCapitalWeight;
  const normalizedLongCapital = longCapitalWeight / totalCapital;
  const normalizedShortCapital = shortCapitalWeight / totalCapital;
  const weightingModel = opts.weightingModel ?? "EQUAL_NOTIONAL";
  return {
    observationId: `xsec:${opts.signal}:${opts.openedAtMs}`,
    openedAt: opts.now,
    openedAtMs: opts.openedAtMs,
    horizonMs: opts.horizonMs,
    signal: opts.signal,
    variant: opts.variant ?? "RAW",
    strategyFamily: opts.strategyFamily ?? (mode === "MEAN_REVERSION" ? "MEAN_REVERSION" : "MOMENTUM_DISPERSION"),
    k: opts.k,
    longK: selectedLongs.length,
    shortK: selectedShorts.length,
    longLeg: weightedLegs(selectedLongs, normalizedLongCapital, { weightingModel, volBySymbol: opts.volBySymbol }),
    shortLeg: weightedLegs(selectedShorts, normalizedShortCapital, { weightingModel, volBySymbol: opts.volBySymbol }),
    status: "OPEN",
    scoreGap,
    regimeContext: opts.regimeContext ?? null,
    regimeClassAtOpen: opts.regimeContext?.regimeClass ?? null,
    longCapitalWeight: normalizedLongCapital,
    shortCapitalWeight: normalizedShortCapital,
    weightingModel,
    takeProfitReturn: opts.takeProfitReturn ?? null,
    stopLossReturn: opts.stopLossReturn ?? null,
    // Freeze the R-denominator at open (config-change-proof). Real stop if this basket has one, else the
    // process-frozen config stop-unit — the SAME quantity CORTEX's x-side uses, so netR is symmetric.
    riskDistanceAtOpen: opts.riskDistanceAtOpen ?? opts.stopLossReturn ?? CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS / 10_000,
    regimeFlipExit: opts.regimeFlipExit ?? false,
    exitReason: null,
    grossReturn: null,
    costReturn: null,
    netReturn: null,
    longLegReturn: null,
    shortLegReturn: null,
    resolvedAt: null,
  };
}

/**
 * Symbols whose MEDIAN quote volume per bar clears `floorUsd`, over the trailing `bars` candles.
 * Median, not mean: one listing-day or liquidation-cascade bar can carry a thin symbol's mean past
 * any floor, and that is exactly the symbol this is meant to exclude.
 *
 * A symbol with fewer than `bars / 4` usable candles is EXCLUDED, not admitted — too new or too
 * gappy to have a liquidity history is the same risk as being thin, and the fail-closed direction
 * is the one that cannot surprise the executor.
 */
export function liquidCrossSectionalSymbols(
  candlesBySymbol: Record<string, Candle[]>,
  floorUsd: number,
  bars = CROSS_SECTIONAL_LIQUIDITY_LOOKBACK_BARS,
): Set<string> {
  const out = new Set<string>();
  if (!(floorUsd > 0)) {
    for (const symbol of Object.keys(candlesBySymbol)) out.add(symbol.toUpperCase());
    return out;
  }
  // 2026-08-12 (caught on testnet within one cycle of shipping this): this was `bars / 4`, i.e. 180
  // samples against the 720-bar default. The cycle's caller only fetches MOMENTUM_BARS + 5 candles
  // per symbol (41 at the time), so EVERY symbol failed the sample test, the liquid set came back
  // EMPTY, and an empty allowlist means "allow everything" — the floor didn't just fail to bind, it
  // deleted the allowlists too. ARKMUSDT ($0.05M/h, the thinnest name in the universe) was on the
  // very first basket. Judge on whatever history is available, but never on less than a day of it.
  const minSamples = Math.max(1, Math.min(24, bars));
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    if (!Array.isArray(candles) || candles.length === 0) continue;
    const quote: number[] = [];
    for (const c of candles.slice(-bars)) {
      const q = c.close * c.volume;
      if (Number.isFinite(q) && q > 0) quote.push(q);
    }
    if (quote.length < minSamples) continue;
    quote.sort((a, b) => a - b);
    if (quote[Math.floor(quote.length / 2)]! >= floorUsd) out.add(symbol.toUpperCase());
  }
  return out;
}

/**
 * Narrow one side's allowlist to the liquid set.
 *
 * The empty-list case is the whole reason this is a named function: `allowed()` treats an EMPTY
 * allowlist as "allow EVERY symbol", so a naive intersection of [] with the liquid set yields []
 * — which reads as "allow everything" again and silently discards the floor. When the incoming
 * allowlist is empty (the widened-pool configuration), the liquid set BECOMES the allowlist.
 */
export function narrowAllowlistToLiquid(allow: readonly string[], liquid: ReadonlySet<string> | null): Set<string> {
  if (liquid === null) return new Set(allow);
  if (allow.length === 0) return new Set(liquid);
  return new Set(allow.filter((s) => liquid.has(s.toUpperCase())));
}

/**
 * Whether the liquidity floor has narrowed a side to nothing, in which case NO basket may be built.
 *
 * Fail-closed, and the reason is the same empty-list trap narrowAllowlistToLiquid exists for, one
 * level up: an empty allowlist reaching allowed() means "allow EVERY symbol", so building anyway
 * would not merely ignore the floor — it would DELETE the operator's allowlists and hand the
 * ranking the entire universe, thin names included. Strictly worse than not applying the floor at
 * all, and completely silent. Returns false when the floor is disabled (liquid === null), so the
 * un-floored path is untouched.
 */
export function crossSectionalLiquidityStarved(
  longAllow: ReadonlySet<string>,
  shortAllow: ReadonlySet<string>,
  liquid: ReadonlySet<string> | null,
): boolean {
  if (liquid === null) return false;
  return longAllow.size === 0 || shortAllow.size === 0;
}

// ── Auto-updating symbol filters (operator: "ikutin filtered symbol, auto update
// terus blacklist dan whitelist nya") ────────────────────────────────────────
//
// Derives per-symbol allow/blocklists from the MEASURED per-leg performance in the
// store's CLOSED baskets, using the static env lists as the HARD operator ceiling:
//   • a symbol with ≥ minLegSamples measured legs on a side and NEGATIVE avg return
//     is DEMOTED (removed from that side's allowlist, added to its blocklist);
//   • positive out-of-list symbols are reported in provenance, but they are NOT
//     promoted into executable allowlists. Execution must never outrun the operator
//     allow/block filters shown on /research.
// Recomputed every cycle, so the lists can demote toxic names while staying inside
// the explicit filtered universe.

export interface AdaptiveSymbolFilters {
  longAllowlist: string[];
  shortAllowlist: string[];
  longBlocklist: string[];
  shortBlocklist: string[];
  provenance: {
    closedBaskets: number;
    minLegSamples: number;
    promotedLong: string[];
    promotedShort: string[];
    demotedLong: string[];
    demotedShort: string[];
    minEligiblePerSide: number;
    /** Per-side floors actually applied — can diverge from minEligiblePerSide when regime skew
     *  raises one side's required leg count above the base K (see regimeSkewedK). */
    minEligiblePerSideLong: number;
    minEligiblePerSideShort: number;
    /** True when demotions alone would have left this side below minEligiblePerSide, so the
     *  fallback below kicked in instead. See the floor comment at its computation site. */
    longFloorApplied: boolean;
    shortFloorApplied: boolean;
  };
}

export function deriveAdaptiveSymbolFilters(
  store: CrossSectionalStore,
  opts: {
    minLegSamples?: number;
    minEligiblePerSide?: number;
    /** Per-side overrides — thread the REGIME-SKEWED longK/shortK through here (not just the base
     *  CROSS_SECTIONAL_K) when regime skew is enabled. 2026-07-11: the floor below used to always
     *  check against the unskewed base K on both sides, so when skew raised e.g. shortK from 3 to
     *  4, a side sitting at exactly 3 eligible symbols looked "fine" (3 is not < 3) even though
     *  buildFilteredCrossSectionalBasket actually needs 4 and would silently return null — the
     *  floor's whole purpose (never let a side lock out from forming baskets at all) failed
     *  silently in exactly the skewed-bearish-regime case the skew exists to lean into. Falls back
     *  to minEligiblePerSide (then CROSS_SECTIONAL_K) when not provided, so unskewed callers are
     *  unaffected. */
    minEligiblePerSideLong?: number;
    minEligiblePerSideShort?: number;
  } = {},
): AdaptiveSymbolFilters {
  const minLegSamples = opts.minLegSamples ?? 3;
  const minEligiblePerSide = opts.minEligiblePerSide ?? CROSS_SECTIONAL_K;
  const minEligiblePerSideLong = opts.minEligiblePerSideLong ?? minEligiblePerSide;
  const minEligiblePerSideShort = opts.minEligiblePerSideShort ?? minEligiblePerSide;
  const perf = new Map<string, { longN: number; longSum: number; shortN: number; shortSum: number }>();
  const bump = (symbol: string, side: "long" | "short", ret: number) => {
    const row = perf.get(symbol) ?? { longN: 0, longSum: 0, shortN: 0, shortSum: 0 };
    if (side === "long") {
      row.longN += 1;
      row.longSum += ret;
    } else {
      row.shortN += 1;
      row.shortSum += ret;
    }
    perf.set(symbol, row);
  };

  let closedBaskets = 0;
  for (const obs of store.all) {
    if (obs.status !== "CLOSED") continue;
    closedBaskets += 1;
    for (const leg of obs.longLeg) {
      if (leg.exitPrice !== null && leg.entryPrice > 0) bump(leg.symbol, "long", leg.exitPrice / leg.entryPrice - 1);
    }
    for (const leg of obs.shortLeg) {
      if (leg.exitPrice !== null && leg.entryPrice > 0) bump(leg.symbol, "short", -(leg.exitPrice / leg.entryPrice - 1));
    }
  }

  const promotedLong: string[] = [];
  const promotedShort: string[] = [];
  const demotedLong: string[] = [];
  const demotedShort: string[] = [];
  for (const [symbol, row] of perf) {
    if (row.longN >= minLegSamples) {
      if (row.longSum / row.longN > 0) promotedLong.push(symbol);
      else demotedLong.push(symbol);
    }
    if (row.shortN >= minLegSamples) {
      if (row.shortSum / row.shortN > 0) promotedShort.push(symbol);
      else demotedShort.push(symbol);
    }
  }

  const longAllowRaw = new Set<string>([...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST]);
  for (const s of demotedLong) longAllowRaw.delete(s);
  const shortAllowRaw = new Set<string>([...CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST]);
  for (const s of demotedShort) shortAllowRaw.delete(s);

  // Floor (2026-07-07 audit): demotion has no natural recovery path — a demoted symbol only
  // regains eligibility once NEW closed baskets remeasure it positive, but no new baskets can
  // form once a side drops below the k legs a basket needs. That is a PERMANENT lockout, not a
  // temporary one: live's entire cross-sectional allocation silently stopped opening SHORT-side
  // baskets for ~18h this way (all 5 configured short symbols demoted, effective allowlist 0).
  // If demotions would leave a side under minEligiblePerSide, fall back to the full configured
  // allowlist for that side THIS CYCLE ONLY — next cycle recomputes fresh from the same
  // closed-basket history, so a symbol gets a genuine chance to prove out again instead of
  // staying locked out forever with nothing left to remeasure it.
  const longFloorApplied = longAllowRaw.size < minEligiblePerSideLong;
  const shortFloorApplied = shortAllowRaw.size < minEligiblePerSideShort;
  const longAllow = longFloorApplied ? new Set(CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST) : longAllowRaw;
  const shortAllow = shortFloorApplied ? new Set(CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST) : shortAllowRaw;
  const shortBlock = new Set<string>([
    ...CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST,
    ...(shortFloorApplied ? [] : demotedShort),
  ]);
  const longBlock = new Set<string>(longFloorApplied ? [] : demotedLong);

  return {
    longAllowlist: [...longAllow].sort(),
    shortAllowlist: [...shortAllow].sort(),
    longBlocklist: [...longBlock].sort(),
    shortBlocklist: [...shortBlock].sort(),
    provenance: {
      closedBaskets,
      minLegSamples,
      promotedLong: promotedLong.sort(),
      promotedShort: promotedShort.sort(),
      demotedLong: demotedLong.sort(),
      demotedShort: demotedShort.sort(),
      minEligiblePerSide,
      minEligiblePerSideLong,
      minEligiblePerSideShort,
      longFloorApplied,
      shortFloorApplied,
    },
  };
}

export function buildFilteredCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: Omit<CrossSectionalBasketOpts, "variant" | "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap"> &
    Partial<Pick<CrossSectionalBasketOpts, "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap">>,
): CrossSectionalObservation | null {
  return buildCrossSectionalBasket(scored, {
    ...opts,
    signal: opts.signal ?? CROSS_SECTIONAL_FILTERED_SIGNAL,
    variant: "FILTERED",
    longAllowlist: opts.longAllowlist ?? CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST,
    shortAllowlist: opts.shortAllowlist ?? CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST,
    shortBlocklist: opts.shortBlocklist ?? CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST,
    minScoreGap: opts.minScoreGap ?? CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP,
    maxPerCluster: opts.maxPerCluster ?? CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER,
  });
}

export function buildTrendCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: Omit<CrossSectionalBasketOpts, "variant" | "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap" | "selectionMode" | "strategyFamily"> &
    Partial<Pick<CrossSectionalBasketOpts, "signal" | "longAllowlist" | "longBlocklist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap">>,
): CrossSectionalObservation | null {
  const longCapital = CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT;
  return buildCrossSectionalBasket(scored, {
    ...opts,
    signal: opts.signal ?? CROSS_SECTIONAL_TREND_SIGNAL,
    variant: "TREND_BETA_VOL",
    strategyFamily: "MOMENTUM_DISPERSION",
    selectionMode: "MOMENTUM",
    longAllowlist: opts.longAllowlist ?? CROSS_SECTIONAL_TREND_LONG_ALLOWLIST,
    longBlocklist: opts.longBlocklist ?? CROSS_SECTIONAL_TREND_LONG_BLOCKLIST,
    shortAllowlist: opts.shortAllowlist ?? CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST,
    shortBlocklist: opts.shortBlocklist ?? CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST,
    minScoreGap: opts.minScoreGap ?? CROSS_SECTIONAL_TREND_MIN_SCORE_GAP,
    longCapitalWeight: opts.longCapitalWeight ?? longCapital,
    shortCapitalWeight: opts.shortCapitalWeight ?? (1 - longCapital),
    weightingModel: opts.weightingModel ?? "BETA_VOL_PROXY",
    takeProfitReturn: opts.takeProfitReturn ?? CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS / 10_000,
    stopLossReturn: opts.stopLossReturn ?? CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS / 10_000,
    regimeFlipExit: opts.regimeFlipExit ?? true,
  });
}

export function buildMixedCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: Omit<CrossSectionalBasketOpts, "variant" | "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap" | "selectionMode" | "strategyFamily"> &
    Partial<Pick<CrossSectionalBasketOpts, "signal" | "longAllowlist" | "longBlocklist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap">>,
): CrossSectionalObservation | null {
  // Mixed/chop reverses extremes, but keeps the same side-specific toxicity guardrails.
  // CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL=1 moves BOTH legs (see the block at
  // isCrossSectionalMixedWideLongPoolEnabled): the long pool widens to this instance's own FILTERED
  // long allowlist, and every symbol that pool can select is blocked from the short side so the two
  // legs stay disjoint and the short leg cannot be moved by long-side ranking. With the flag unset
  // both resolvers return exactly what MIXED uses today. Explicit opts from a caller still win.
  const longAllowlist = opts.longAllowlist ?? crossSectionalMixedLongAllowlist();
  const longBlocklist = opts.longBlocklist ?? CROSS_SECTIONAL_TREND_LONG_BLOCKLIST;
  return buildCrossSectionalBasket(scored, {
    ...opts,
    signal: opts.signal ?? CROSS_SECTIONAL_MIXED_SIGNAL,
    variant: "MIXED_MEAN_REVERSION",
    strategyFamily: "MEAN_REVERSION",
    selectionMode: "MEAN_REVERSION",
    longAllowlist,
    longBlocklist,
    shortAllowlist: opts.shortAllowlist ?? CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST,
    shortBlocklist: opts.shortBlocklist ?? crossSectionalMixedShortBlocklist({ longAllowlist, longBlocklist }),
    minScoreGap: opts.minScoreGap ?? CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP,
    longCapitalWeight: opts.longCapitalWeight ?? 0.5,
    shortCapitalWeight: opts.shortCapitalWeight ?? 0.5,
    weightingModel: opts.weightingModel ?? "BETA_VOL_PROXY",
    takeProfitReturn: opts.takeProfitReturn ?? CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS / 10_000,
    stopLossReturn: opts.stopLossReturn ?? CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS / 10_000,
    regimeFlipExit: opts.regimeFlipExit ?? true,
  });
}

export function realizedVolatility(candles: Candle[], bars = CROSS_SECTIONAL_MOMENTUM_BARS): number | null {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const closes = candles.map((c) => c.close).filter((c) => Number.isFinite(c) && c > 0);
  const start = Math.max(1, closes.length - Math.max(2, bars));
  const returns: number[] = [];
  for (let i = start; i < closes.length; i += 1) {
    const prev = closes[i - 1]!;
    const next = closes[i]!;
    returns.push((next - prev) / prev);
  }
  if (returns.length < 2) return null;
  const m = mean(returns);
  return Math.sqrt(mean(returns.map((r) => (r - m) ** 2)));
}

export function classifyCrossSectionalRegime(
  input?: Partial<CrossSectionalRegimeContext> | null,
): CrossSectionalRegimeClass {
  const mode = (input?.controllerMode ?? "").toUpperCase();
  const bias = (input?.directionalBias ?? "").toUpperCase();
  const regime = (input?.currentRegime ?? "").toLowerCase();
  if (mode === "LONG_ONLY" || bias === "LONG" || regime.includes("bullish")) return "TREND_LONG";
  if (mode === "SHORT_ONLY" || bias === "SHORT" || regime.includes("bearish")) return "TREND_SHORT";
  if (
    mode === "NO_TRADE_CHOP" ||
    mode === "VALIDATION_ONLY" ||
    mode === "BOTH_ALLOWED" ||
    regime.includes("mixed") ||
    regime.includes("chop") ||
    regime.includes("range") ||
    regime.includes("rotation") ||
    regime.includes("consolidation")
  ) {
    return "MIXED_CHOP";
  }
  return "UNKNOWN";
}

export function buildCrossSectionalRegimeContext(
  input?: Partial<CrossSectionalRegimeContext> | null,
): CrossSectionalRegimeContext {
  const base = {
    currentRegime: input?.currentRegime ?? null,
    controllerMode: input?.controllerMode ?? null,
    directionalBias: input?.directionalBias ?? null,
    confidence: input?.confidence ?? null,
    capturedAt: input?.capturedAt ?? null,
  };
  return { ...base, regimeClass: input?.regimeClass ?? classifyCrossSectionalRegime(base) };
}

/**
 * Resolve a basket given current prices. Legacy equal-notional baskets close at horizon; adaptive
 * baskets can close early on TP/SL or regime flip. Weighted baskets sum per-leg return contribution.
 * Missing prices past EXPIRY_MS mark the observation EXPIRED instead of leaving it stuck open.
 */
export function resolveCrossSectional(
  obs: CrossSectionalObservation,
  pricesBySymbol: Record<string, number>,
  now: string,
  roundtripBps: number,
  opts: { regimeContext?: CrossSectionalRegimeContext | null } = {},
): CrossSectionalObservation {
  if (obs.status !== "OPEN") return obs;
  const ageMs = new Date(now).getTime() - obs.openedAtMs;

  const all = [...obs.longLeg, ...obs.shortLeg];
  const price = (s: string): number | null => {
    const p = pricesBySymbol[s];
    return Number.isFinite(p) && p > 0 ? p : null;
  };
  if (!all.every((l) => price(l.symbol) !== null)) {
    return ageMs > EXPIRY_MS ? { ...obs, status: "EXPIRED", exitReason: "EXPIRED", resolvedAt: now } : obs;
  }

  const longLeg = obs.longLeg.map((l) => ({ ...l, exitPrice: price(l.symbol)! }));
  const shortLeg = obs.shortLeg.map((l) => ({ ...l, exitPrice: price(l.symbol)! }));
  const longResolved = legReturnContribution(longLeg, "LONG");
  const shortResolved = legReturnContribution(shortLeg, "SHORT");
  const longLegReturn = longResolved.normalizedReturn;
  const shortLegReturn = shortResolved.normalizedReturn;
  const grossReturn = longResolved.contribution + shortResolved.contribution;
  const costReturn = roundtripBps / 10_000;
  const netReturn = grossReturn - costReturn;
  const takeProfit = obs.takeProfitReturn ?? null;
  const stopLoss = obs.stopLossReturn ?? null;
  const exitReason: CrossSectionalExitReason | null =
    takeProfit !== null && netReturn >= takeProfit ? "TAKE_PROFIT"
      : stopLoss !== null && netReturn <= -stopLoss ? "STOP_LOSS"
        : shouldCutForRegimeFlip(obs, opts.regimeContext) ? "REGIME_FLIP"
          : ageMs >= obs.horizonMs ? "HORIZON"
            : null;
  if (exitReason === null) return obs;
  return {
    ...obs,
    longLeg,
    shortLeg,
    status: "CLOSED",
    exitReason,
    grossReturn,
    costReturn,
    netReturn,
    longLegReturn,
    shortLegReturn,
    resolvedAt: now,
  };
}

// ─── store ───────────────────────────────────────────────────────────────────

interface CrossSectionalState {
  version: number;
  observations: CrossSectionalObservation[];
  lastCycleAt: string | null;
}

export class CrossSectionalStore {
  private readonly file: string;
  private state: CrossSectionalState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "cross-sectional-edge.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this.load();
  }

  private load(): CrossSectionalState {
    for (const path of [this.file, `${this.file}.bak`]) {
      try {
        if (!existsSync(path)) continue;
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CrossSectionalState>;
        if (Array.isArray(parsed.observations)) {
          return { version: parsed.version ?? 1, observations: parsed.observations, lastCycleAt: parsed.lastCycleAt ?? null };
        }
      } catch {
        // fall through to the next candidate / empty
      }
    }
    return { version: 1, observations: [], lastCycleAt: null };
  }

  get all(): CrossSectionalObservation[] {
    return this.state.observations;
  }

  get lastCycleAt(): string | null {
    return this.state.lastCycleAt;
  }

  markCycle(ts: string): void {
    this.state.lastCycleAt = ts;
  }

  add(obs: CrossSectionalObservation): void {
    this.state.observations.push(obs);
  }

  replace(observationId: string, next: CrossSectionalObservation): void {
    const idx = this.state.observations.findIndex((o) => o.observationId === observationId);
    if (idx >= 0) this.state.observations[idx] = next;
  }

  private prune(): void {
    if (this.state.observations.length <= CROSS_SECTIONAL_MAX_STORED_OBSERVATIONS) return;
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, Math.max(0, CROSS_SECTIONAL_MAX_STORED_OBSERVATIONS - open.length));
    this.state.observations = [...open, ...settled];
  }

  save(): void {
    try {
      this.prune();
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      if (existsSync(this.file)) {
        try {
          copyFileSync(this.file, `${this.file}.bak`);
        } catch {
          // best-effort backup
        }
      }
      renameSync(tmp, this.file);
    } catch {
      // report-only persistence failures must never affect the app
    }
  }
}

let singleton: CrossSectionalStore | null = null;
export function getCrossSectionalStore(dataDir = "data"): CrossSectionalStore {
  if (!singleton) singleton = new CrossSectionalStore(dataDir);
  return singleton;
}
export function _resetCrossSectionalStoreForTests(): void {
  singleton = null;
}

// ─── cycle ─────────────────────────────────────────────────────────────────

export interface CrossSectionalCycleResult {
  opened: number;
  openedRaw?: number;
  openedFiltered?: number;
  openedTrend?: number;
  openedMixed?: number;
  resolved: number;
  expired: number;
}

/**
 * One measurement cycle: fetch the universe once, resolve matured open baskets against the latest
 * closes, then open at most one new basket per interval bucket. Pure data accrual — report-only.
 */
export async function runCrossSectionalCycle(opts: {
  store: CrossSectionalStore;
  universe: string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  regimeContext?: CrossSectionalRegimeContext | null;
  /** Current regime-axis score (regime-axis-timeline.ts's current.score), used ONLY when
   *  CROSS_SECTIONAL_REGIME_SKEW_ENABLED=1 to tilt the FILTERED (executed) basket's leg counts
   *  toward the regime-favored side. Omit/null -> unskewed 3/3-style symmetry, same as before. */
  axisScore?: number | null;
}): Promise<CrossSectionalCycleResult> {
  const result: CrossSectionalCycleResult = { opened: 0, resolved: 0, expired: 0 };
  const nowIso = new Date(opts.now).toISOString();
  const regimeContext = opts.regimeContext ? buildCrossSectionalRegimeContext(opts.regimeContext) : null;

  const candlesBySymbol: Record<string, Candle[]> = {};
  await Promise.allSettled(
    opts.universe.map(async (s) => {
      try {
        candlesBySymbol[s] = await opts.fetchCandles(s);
      } catch {
        // a missing symbol just drops out of this cycle
      }
    }),
  );

  const pricesBySymbol: Record<string, number> = {};
  const volBySymbol: Record<string, number> = {};
  const scored: ScoredSymbol[] = [];
  for (const symbol of opts.universe) {
    const candles = candlesBySymbol[symbol];
    if (!candles?.length) continue;
    const last = candles[candles.length - 1]!;
    if (last.close > 0) pricesBySymbol[symbol] = last.close;
    const vol = realizedVolatility(candles);
    if (vol !== null && vol > 0) volBySymbol[symbol] = vol;
    const sc = crossSectionalMomentumScore(candles, CROSS_SECTIONAL_MOMENTUM_BARS);
    if (sc) scored.push({ symbol, score: sc.score, price: sc.price });
  }

  // 1. resolve matured open baskets against the latest closes
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const next = resolveCrossSectional(obs, pricesBySymbol, nowIso, CROSS_SECTIONAL_ROUNDTRIP_BPS, { regimeContext });
    if (next.status !== obs.status) {
      opts.store.replace(obs.observationId, next);
      if (next.status === "CLOSED") result.resolved += 1;
      else if (next.status === "EXPIRED") result.expired += 1;
    }
  }

  // 2. open at most ONE new basket per interval bucket (the 7-min ticker fires faster than the bars)
  const bucket = Math.floor(opts.now / BAR_MS);
  const alreadyThisBucket = (signal: string) => opts.store.all.some((o) => o.signal === signal && Math.floor(o.openedAtMs / BAR_MS) === bucket);
  const rawSignal = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}`;
  if (!alreadyThisBucket(rawSignal)) {
    const basket = buildCrossSectionalBasket(scored, {
      k: CROSS_SECTIONAL_K,
      signal: rawSignal,
      variant: "RAW",
      now: nowIso,
      openedAtMs: opts.now,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      regimeContext,
    });
    if (basket) {
      opts.store.add(basket);
      result.opened += 1;
      result.openedRaw = (result.openedRaw ?? 0) + 1;
    }
  }
  if (!isCrossSectionalFilteredDisabled() && !alreadyThisBucket(CROSS_SECTIONAL_FILTERED_SIGNAL)) {
    // Auto-updating lists: derived from the store's own measured per-leg performance
    // (env lists as the prior) — recomputed every cycle, never a frozen env var.
    // 2026-07-11: skew must be computed BEFORE deriveAdaptiveSymbolFilters, and threaded into its
    // per-side floor — the floor previously always checked the unskewed base K on both sides, so a
    // regime-skewed shortK (e.g. 3->4) could silently starve the short side one leg short of what
    // buildFilteredCrossSectionalBasket actually requires, with the floor never noticing (3
    // eligible symbols isn't "under 3", but it IS under a skewed requirement of 4).
    const skew = isCrossSectionalRegimeSkewEnabled() ? regimeSkewedK(CROSS_SECTIONAL_K, opts.axisScore ?? null) : null;
    const adaptive = deriveAdaptiveSymbolFilters(opts.store, {
      minEligiblePerSideLong: skew?.longK,
      minEligiblePerSideShort: skew?.shortK,
    });
    // Liquidity floor (default OFF — see CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR). Applied to
    // the ALLOWLISTS rather than to `scored`, so it narrows only the FILTERED basket: RAW stays the
    // unmodified OOS control, and TREND/MIXED keep reading their own env lists untouched.
    const liquid = CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR > 0
      ? liquidCrossSectionalSymbols(candlesBySymbol, CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR)
      : null;
    const longAllow = narrowAllowlistToLiquid(adaptive.longAllowlist, liquid);
    const shortAllow = narrowAllowlistToLiquid(adaptive.shortAllowlist, liquid);
    // FAIL CLOSED. An EMPTY allowlist reaches allowed() as "allow EVERY symbol", so a liquidity
    // floor that admits nothing would not merely fail to bind — it would DELETE the operator's
    // allowlists and hand the ranking the whole universe, thin names included. That is strictly
    // worse than the un-floored configuration, and it is silent. When the floor is on, an empty
    // side means "no eligible candidates this cycle": skip the basket, same fail-closed convention
    // buildCrossSectionalBasket already uses when a side cannot fill k legs.
    const liquidityStarved = crossSectionalLiquidityStarved(longAllow, shortAllow, liquid);
    const basket = liquidityStarved ? null : buildFilteredCrossSectionalBasket(scored, {
      k: CROSS_SECTIONAL_K,
      longK: skew?.longK,
      shortK: skew?.shortK,
      now: nowIso,
      openedAtMs: opts.now,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      regimeContext,
      longAllowlist: longAllow,
      shortAllowlist: shortAllow,
      shortBlocklist: new Set(adaptive.shortBlocklist),
    });
    if (basket) {
      opts.store.add(basket);
      result.opened += 1;
      result.openedFiltered = (result.openedFiltered ?? 0) + 1;
    }
  }
  if (!isCrossSectionalAdaptiveDisabled() && regimeContext?.regimeClass && regimeContext.regimeClass !== "UNKNOWN") {
    if (
      (regimeContext.regimeClass === "TREND_LONG" || regimeContext.regimeClass === "TREND_SHORT") &&
      !alreadyThisBucket(CROSS_SECTIONAL_TREND_SIGNAL)
    ) {
      const basket = buildTrendCrossSectionalBasket(scored, {
        k: CROSS_SECTIONAL_K,
        now: nowIso,
        openedAtMs: opts.now,
        horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        regimeContext,
        volBySymbol,
      });
      if (basket) {
        opts.store.add(basket);
        result.opened += 1;
        result.openedTrend = (result.openedTrend ?? 0) + 1;
      }
    }
    if (regimeContext.regimeClass === "MIXED_CHOP" && !alreadyThisBucket(CROSS_SECTIONAL_MIXED_SIGNAL)) {
      const basket = buildMixedCrossSectionalBasket(scored, {
        k: CROSS_SECTIONAL_K,
        now: nowIso,
        openedAtMs: opts.now,
        horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        regimeContext,
        volBySymbol,
      });
      if (basket) {
        opts.store.add(basket);
        result.opened += 1;
        result.openedMixed = (result.openedMixed ?? 0) + 1;
      }
    }
  }

  opts.store.markCycle(nowIso);
  opts.store.save();
  return result;
}

let cycleRunning = false;
/** Overlap-guarded wrapper so the 7-min ticker can't stack two cycles on the singleton store. */
export async function runCrossSectionalCycleGuarded(opts: {
  store: CrossSectionalStore;
  universe: string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  regimeContext?: CrossSectionalRegimeContext | null;
  axisScore?: number | null;
}): Promise<CrossSectionalCycleResult | null> {
  if (cycleRunning) return null;
  cycleRunning = true;
  try {
    return await runCrossSectionalCycle(opts);
  } finally {
    cycleRunning = false;
  }
}

// ─── report ────────────────────────────────────────────────────────────────

export interface CrossSectionalReport {
  signal: string;
  variant: CrossSectionalVariant;
  horizonBars: number;
  k: number;
  open: number;
  closed: number;
  expired: number;
  netAvgReturn: number;
  grossAvgReturn: number;
  winRate: number;
  totalNetReturn: number;
  sharpeLike: number | null; // mean/stdev of net returns (per-basket), not annualized
  longLegAvgReturn: number;
  shortLegAvgReturn: number;
  lastCycleAt: string | null;
  /** ms until the OLDEST open basket reaches its horizon (when the first "closed" appears). null if none open. */
  nextResolveInMs: number | null;
  /** the net returns of recent closed baskets, for a distribution sparkline. */
  recentNetReturns: number[];
  targetGrossReturn: number;
  edgeReady: boolean;
  byRegime: Array<{
    regimeClass: CrossSectionalRegimeClass;
    closed: number;
    netAvgReturn: number;
    grossAvgReturn: number;
    winRate: number;
  }>;
  exits: Array<{
    reason: CrossSectionalExitReason | "UNKNOWN";
    closed: number;
    netAvgReturn: number;
    winRate: number;
  }>;
}

function observationVariant(o: Pick<CrossSectionalObservation, "variant" | "signal">): CrossSectionalVariant {
  if (o.variant === "MIXED_MEAN_REVERSION" || o.signal === CROSS_SECTIONAL_MIXED_SIGNAL) return "MIXED_MEAN_REVERSION";
  if (o.variant === "TREND_BETA_VOL" || o.signal === CROSS_SECTIONAL_TREND_SIGNAL) return "TREND_BETA_VOL";
  return o.variant === "FILTERED" || o.signal === CROSS_SECTIONAL_FILTERED_SIGNAL ? "FILTERED" : "RAW";
}

function reportSignalFor(variant: CrossSectionalVariant): string {
  if (variant === "FILTERED") return CROSS_SECTIONAL_FILTERED_SIGNAL;
  if (variant === "TREND_BETA_VOL") return CROSS_SECTIONAL_TREND_SIGNAL;
  if (variant === "MIXED_MEAN_REVERSION") return CROSS_SECTIONAL_MIXED_SIGNAL;
  return `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}`;
}

function targetGrossFor(variant: CrossSectionalVariant): number {
  if (variant === "RAW") return CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;
  if (variant === "FILTERED") return CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS / 10_000;
  return CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS / 10_000;
}

function groupStats<T extends string>(
  closed: CrossSectionalObservation[],
  key: (obs: CrossSectionalObservation) => T,
): Array<{ key: T; closed: number; netAvgReturn: number; grossAvgReturn: number; winRate: number }> {
  const map = new Map<T, CrossSectionalObservation[]>();
  for (const obs of closed) {
    const k = key(obs);
    map.set(k, [...(map.get(k) ?? []), obs]);
  }
  return [...map.entries()].map(([k, rows]) => {
    const nets = rows.map((o) => o.netReturn ?? 0);
    const gross = rows.map((o) => o.grossReturn ?? 0);
    return {
      key: k,
      closed: rows.length,
      netAvgReturn: mean(nets),
      grossAvgReturn: mean(gross),
      winRate: rows.length ? rows.filter((o) => (o.netReturn ?? 0) > 0).length / rows.length : 0,
    };
  });
}

export function buildCrossSectionalReport(
  store: CrossSectionalStore,
  nowMs: number = Date.now(),
  opts: { variant?: CrossSectionalVariant; signal?: string } = {},
): CrossSectionalReport {
  const variant = opts.variant ?? (opts.signal === CROSS_SECTIONAL_FILTERED_SIGNAL ? "FILTERED" : "RAW");
  const all = store.all.filter((o) => opts.signal ? o.signal === opts.signal : observationVariant(o) === variant);
  const closed = all.filter((o) => o.status === "CLOSED" && o.netReturn !== null);
  const nets = closed.map((o) => o.netReturn!);
  const gross = closed.map((o) => o.grossReturn ?? 0);
  const m = mean(nets);
  const sd = nets.length > 1 ? Math.sqrt(mean(nets.map((x) => (x - m) ** 2))) : 0;
  const grossAvg = mean(gross);
  const targetGrossReturn = targetGrossFor(variant);
  const openRemaining = all
    .filter((o) => o.status === "OPEN")
    .map((o) => Math.max(0, o.openedAtMs + o.horizonMs - nowMs));
  const byRegime = groupStats(closed, (o) => o.regimeClassAtOpen ?? o.regimeContext?.regimeClass ?? "UNKNOWN")
    .map((r) => ({ regimeClass: r.key, closed: r.closed, netAvgReturn: r.netAvgReturn, grossAvgReturn: r.grossAvgReturn, winRate: r.winRate }));
  const exits = groupStats(closed, (o) => o.exitReason ?? "UNKNOWN")
    .map((r) => ({ reason: r.key, closed: r.closed, netAvgReturn: r.netAvgReturn, winRate: r.winRate }));
  return {
    lastCycleAt: store.lastCycleAt,
    nextResolveInMs: openRemaining.length ? Math.min(...openRemaining) : null,
    recentNetReturns: nets.slice(-30),
    signal: opts.signal ?? reportSignalFor(variant),
    variant,
    horizonBars: CROSS_SECTIONAL_HORIZON_BARS,
    k: CROSS_SECTIONAL_K,
    open: all.filter((o) => o.status === "OPEN").length,
    closed: closed.length,
    expired: all.filter((o) => o.status === "EXPIRED").length,
    netAvgReturn: m,
    grossAvgReturn: grossAvg,
    winRate: closed.length ? closed.filter((o) => o.netReturn! > 0).length / closed.length : 0,
    totalNetReturn: nets.reduce((a, b) => a + b, 0),
    sharpeLike: sd > 0 ? m / sd : null,
    longLegAvgReturn: mean(closed.map((o) => o.longLegReturn ?? 0)),
    shortLegAvgReturn: mean(closed.map((o) => o.shortLegReturn ?? 0)),
    targetGrossReturn,
    edgeReady: closed.length >= 20 && grossAvg >= targetGrossReturn && m > 0,
    byRegime,
    exits,
  };
}

export function isCrossSectionalEdgeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_EDGE_DISABLED === "1";
}

export function isCrossSectionalFilteredDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_FILTERED_DISABLED === "1";
}

export function isCrossSectionalAdaptiveDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_ADAPTIVE_DISABLED === "1";
}

export function getCrossSectionalFilteredConfig(): {
  signal: string;
  minScoreGap: number;
  targetGrossReturn: number;
  longAllowlist: string[];
  shortAllowlist: string[];
  shortBlocklist: string[];
} {
  return {
    signal: CROSS_SECTIONAL_FILTERED_SIGNAL,
    minScoreGap: CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP,
    targetGrossReturn: CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS / 10_000,
    longAllowlist: [...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST].sort(),
    shortAllowlist: [...CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST].sort(),
    shortBlocklist: [...CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST].sort(),
  };
}

export function getCrossSectionalAdaptiveConfig(): {
  trendSignal: string;
  mixedSignal: string;
  targetGrossReturn: number;
  trendMinScoreGap: number;
  mixedMinScoreGap: number;
  takeProfitReturn: number;
  stopLossReturn: number;
  trendLongCapitalWeight: number;
  trendShortCapitalWeight: number;
  trendLongAllowlist: string[];
  trendLongBlocklist: string[];
  trendShortAllowlist: string[];
  trendShortBlocklist: string[];
  /** Which pools the MIXED lane is actually running on, so /research shows the effective universe
   *  on BOTH sides instead of readers having to infer it from the TREND lists. When
   *  mixedWideLongPool is true, mixedShortBlocklist is WIDER than trendShortBlocklist by exactly
   *  mixedShortExcludedForLongOverlap — the symbols taken off MIXED's short side to keep the two
   *  legs disjoint. Additive/report-only. */
  mixedWideLongPool: boolean;
  mixedLongAllowlist: string[];
  mixedLongBlocklist: string[];
  mixedShortAllowlist: string[];
  mixedShortBlocklist: string[];
  /** Short-side candidates removed by the wide-pool flag (empty when the flag is off). */
  mixedShortExcludedForLongOverlap: string[];
} {
  return {
    trendSignal: CROSS_SECTIONAL_TREND_SIGNAL,
    mixedSignal: CROSS_SECTIONAL_MIXED_SIGNAL,
    targetGrossReturn: CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS / 10_000,
    trendMinScoreGap: CROSS_SECTIONAL_TREND_MIN_SCORE_GAP,
    mixedMinScoreGap: CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP,
    takeProfitReturn: CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS / 10_000,
    stopLossReturn: CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS / 10_000,
    trendLongCapitalWeight: CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT,
    trendShortCapitalWeight: 1 - CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT,
    trendLongAllowlist: [...CROSS_SECTIONAL_TREND_LONG_ALLOWLIST].sort(),
    trendLongBlocklist: [...CROSS_SECTIONAL_TREND_LONG_BLOCKLIST].sort(),
    trendShortAllowlist: [...CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST].sort(),
    trendShortBlocklist: [...CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST].sort(),
    mixedWideLongPool: isCrossSectionalMixedWideLongPoolEnabled(),
    mixedLongAllowlist: [...crossSectionalMixedLongAllowlist()].sort(),
    mixedLongBlocklist: [...CROSS_SECTIONAL_TREND_LONG_BLOCKLIST].sort(),
    mixedShortAllowlist: [...CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST].sort(),
    mixedShortBlocklist: [...crossSectionalMixedShortBlocklist()].sort(),
    mixedShortExcludedForLongOverlap: [...CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST]
      .filter((s) => crossSectionalMixedShortBlocklist().has(s) && !CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST.has(s))
      .sort(),
  };
}

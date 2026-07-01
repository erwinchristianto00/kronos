import type { MarketContext, Regime } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Master regime detector — PURE.
//
// Priority order is deliberate: the most decisive / most defensive states are
// checked first so an ambiguous context can never be mislabeled as a friendlier
// regime than it is.
//
//   1. BEAR_TREND              (hardest-down: only breakdown-short / no-trade)
//   2. TREND_RECOVERY          (strongest-up: full long stack)
//   3. NEUTRAL_RECOVERY        (early-up: cautious long stack)
//   4. BEARISH_CHOPPY_DEFENSIVE(default hostile chop: short-fade stack)
//   5. NO_TRADE                (nothing lines up — stand aside)
//
// NOTE: TREND/NEUTRAL are checked before BEARISH so that a genuine confirmed
// recovery (BTC reclaimed 62k/65k with confirmation) is not shadowed by the
// still-true `btcBelow*` flags a context might carry mid-transition.
// ─────────────────────────────────────────────────────────────────────────────

export function detectRegime(ctx: MarketContext): Regime {
  // 1. BEAR_TREND — major support lost, retest failed, breadth collapsing.
  if (ctx.btcBreaksBelow55000 === true && ctx.retestFailed === true && ctx.marketBreadthCollapses === true) {
    return "BEAR_TREND";
  }

  // 2. TREND_RECOVERY — daily reclaim of 65k with bullish structure + confirmation.
  if (
    ctx.btcCloseDailyAbove65000 === true &&
    ctx.pullbackHolds === true &&
    ctx.marketStructureBullish === true &&
    ctx.ethConfirms === true &&
    ctx.altBreadthPositive === true
  ) {
    return "TREND_RECOVERY";
  }

  // 3. NEUTRAL_RECOVERY — 4H reclaim of 62k, retest holds, higher low + confirmation.
  if (
    ctx.btcClose4hAbove62000 === true &&
    ctx.retest62000Hold === true &&
    ctx.btcHigherLow === true &&
    ctx.ethConfirms === true &&
    ctx.altBreadthImproves === true &&
    ctx.volumeNotDead === true
  ) {
    return "NEUTRAL_RECOVERY";
  }

  // 4. BEARISH_CHOPPY_DEFENSIVE — below 60k, OR below 62k with weak breadth.
  if (ctx.btcBelow60000 === true || (ctx.btcBelow62000 === true && ctx.marketBreadthWeak === true)) {
    return "BEARISH_CHOPPY_DEFENSIVE";
  }

  // 5. Nothing lines up.
  return "NO_TRADE";
}

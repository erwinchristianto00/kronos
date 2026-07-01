import type { MarketContext } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Context integrity — catch mutually-exclusive / stale inputs BEFORE they reach
// regime detection or a lane. detectRegime resolves ambiguity by priority, but a
// genuinely CONTRADICTORY context (e.g. a stale `btcBelow60000` still set while
// fresh recovery flags arrive) means the upstream feature layer disagrees with
// itself — the only safe response is to stand aside, not to trust the priority
// order. All functions here are PURE.
// ─────────────────────────────────────────────────────────────────────────────

/** Pairs of flags that can never be simultaneously true. */
const MUTUALLY_EXCLUSIVE: Array<[keyof MarketContext, keyof MarketContext, string]> = [
  // Price cannot be below 60k AND have a 4H/daily close above 62k/65k.
  ["btcBelow60000", "btcClose4hAbove62000", "BELOW_60K_VS_4H_ABOVE_62K"],
  ["btcBelow60000", "btcCloseDailyAbove65000", "BELOW_60K_VS_DAILY_ABOVE_65K"],
  ["btcBelow62000", "btcCloseDailyAbove65000", "BELOW_62K_VS_DAILY_ABOVE_65K"],
  ["btcBelow62000", "btcStableAboveSupport", "BELOW_62K_VS_STABLE_ABOVE_SUPPORT"],
  // Major-support break contradicts "not breaking major support" / "stable above support".
  ["btcBreaksBelow55000", "btcNotBreakingMajorSupport", "BREAKS_55K_VS_NOT_BREAKING"],
  ["btcBreaksBelow55000", "btcStableAboveSupport", "BREAKS_55K_VS_STABLE"],
  // Breadth cannot be weak/collapsing AND positive.
  ["marketBreadthWeak", "marketBreadthPositive", "BREADTH_WEAK_VS_POSITIVE"],
  ["marketBreadthCollapses", "marketBreadthPositive", "BREADTH_COLLAPSE_VS_POSITIVE"],
  ["marketBreadthCollapses", "altBreadthPositive", "BREADTH_COLLAPSE_VS_ALT_POSITIVE"],
  // A retest cannot both fail and hold; support cannot both break and hold.
  ["retestFailed", "retest62000Hold", "RETEST_FAILED_VS_HELD"],
  ["supportBroken", "supportHolds", "SUPPORT_BROKEN_VS_HOLDS"],
  ["closeBelowSupport", "supportHolds", "CLOSE_BELOW_VS_SUPPORT_HOLDS"],
  // Liquidity cannot be good and too-thin at once.
  ["liquidityGood", "liquidityTooThin", "LIQUIDITY_GOOD_VS_THIN"],
  // BTC cannot be "still weak" while "stable above support".
  ["btcStillWeak", "btcStableAboveSupport", "STILL_WEAK_VS_STABLE"],
];

/**
 * Returns the codes of every contradictory flag pair present in `ctx`.
 * Empty array = internally consistent.
 */
export function detectContradictions(ctx: MarketContext): string[] {
  const found: string[] = [];
  for (const [a, b, code] of MUTUALLY_EXCLUSIVE) {
    if (ctx[a] === true && ctx[b] === true) found.push(code);
  }
  return found;
}

/**
 * Multi-timeframe staleness. A context is stale if it was explicitly flagged
 * (`dataStale`) OR any declared timeframe's candle is older than its budget
 * relative to `asOf`. If `asOf` is absent we cannot age-check, so we only honor
 * the explicit flag (fail-open on timing, fail-safe on the explicit flag).
 */
export function stalenessReasons(ctx: MarketContext): string[] {
  const reasons: string[] = [];
  if (ctx.dataStale === true) reasons.push("EXPLICIT_STALE_FLAG");

  if (typeof ctx.asOf === "number" && Array.isArray(ctx.freshness)) {
    for (const f of ctx.freshness) {
      const age = ctx.asOf - f.lastCandleCloseMs;
      if (age > f.maxStalenessMs) reasons.push(`STALE_${f.timeframe}:${age}ms`);
    }
  }
  return reasons;
}

export function isContextStale(ctx: MarketContext): boolean {
  return stalenessReasons(ctx).length > 0;
}

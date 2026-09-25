/**
 * Exact, recovered legacy SLOW_AND_FAST side-eligibility semantics.
 *
 * This deliberately has no environment switch and no dependency on the old FILTERED wrapper.
 * Dynamic MOM36 v4 calls it only after breadth and the V4 continuation overlay have frozen the
 * required long/short counts.  It never ranks, allocates, sizes, admits, or exits a basket.
 */

export const DYNAMIC_MOM36_SLOW_FAST_POLICY_ID = "slow-fast-mom36-fast4h-strict-sign-v1" as const;
export const DYNAMIC_MOM36_SLOW_FAST_IMPLEMENTATION_VERSION =
  "legacy-d5243fd-strict-sign-verified-v1" as const;
export const DYNAMIC_MOM36_SLOW_FAST_INTERVAL = "1h" as const;
export const DYNAMIC_MOM36_SLOW_FAST_SLOW_BARS = 36 as const;
export const DYNAMIC_MOM36_SLOW_FAST_FAST_BARS = 4 as const;

export type DynamicMom36SlowFastDirection = "BULLISH" | "BEARISH" | "NEUTRAL" | "MISSING";
export type DynamicMom36SlowFastSide = "LONG" | "SHORT";

export type DynamicMom36SlowFastEvaluation = {
  slowDirection: DynamicMom36SlowFastDirection;
  fastDirection: DynamicMom36SlowFastDirection;
  longAligned: boolean;
  shortAligned: boolean;
};

function direction(value: number | null | undefined): DynamicMom36SlowFastDirection {
  if (!(typeof value === "number" && Number.isFinite(value))) return "MISSING";
  if (value > 0) return "BULLISH";
  if (value < 0) return "BEARISH";
  return "NEUTRAL";
}

/**
 * Same strict-sign predicate as legacy `sideTrendAligned()`:
 * LONG needs MOM36 > 0 and FAST4h > 0; SHORT needs both < 0.  Zero, missing, NaN, and infinity
 * are non-aligned.  Do not substitute epsilon/threshold semantics here.
 */
export function evaluateDynamicMom36SlowFast(
  slow: number | null | undefined,
  fast: number | null | undefined,
): DynamicMom36SlowFastEvaluation {
  const slowDirection = direction(slow);
  const fastDirection = direction(fast);
  return {
    slowDirection,
    fastDirection,
    longAligned: slowDirection === "BULLISH" && fastDirection === "BULLISH",
    shortAligned: slowDirection === "BEARISH" && fastDirection === "BEARISH",
  };
}

export function isDynamicMom36SlowFastAligned(
  slow: number | null | undefined,
  fast: number | null | undefined,
  side: DynamicMom36SlowFastSide,
): boolean {
  const evaluated = evaluateDynamicMom36SlowFast(slow, fast);
  return side === "LONG" ? evaluated.longAligned : evaluated.shortAligned;
}

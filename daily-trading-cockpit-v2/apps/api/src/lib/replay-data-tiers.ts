/**
 * Historical replay — data-quality tiers (Phase 2). Each reconstructed row is stamped with the external-data
 * tier it was built from. A model/feature may ONLY consume inputs its row's tier can actually support — a
 * candle-only row cannot make order-book, queue, or precise-fill claims. Missing microstructure stays MISSING:
 * this module refuses to hand out a spread / slippage / depth / imbalance / liquidation / queue feature that
 * the tier does not back, so nothing downstream can fabricate zero-spread, deep-liquidity, or zero-slippage.
 * Pure.
 */

export type DataTier = "A_CANDLE" | "B_TRADES" | "C_L2";

/** Feature families, grouped by the LOWEST tier that can legitimately produce them. */
export const TIER_A_FEATURES = [
  "ohlcv", "markPrice", "indexPrice", "funding", "openInterest",
  "trend", "volatility", "atr", "breadth", "coarseMomentum", "regimeState", "coarseEntry", "coarseExit",
] as const;
export const TIER_B_FEATURES = [
  "publicTrades", "aggressorSide", "takerFlow", "orderFlowProxy", "squeeze", "crowding",
  "liquidation", "improvedEntryTiming", "improvedExitTiming", "coarseSlippageEstimate",
] as const;
export const TIER_C_FEATURES = [
  "l1TopOfBook", "l2Depth", "spread", "depth", "imbalance", "cancelUpdateSequence",
  "queuePriority", "marketImpact", "realisticLimitFill", "spreadAwareEntry", "preciseSlippage",
] as const;

export type FeatureName =
  | (typeof TIER_A_FEATURES)[number]
  | (typeof TIER_B_FEATURES)[number]
  | (typeof TIER_C_FEATURES)[number];

const TIER_RANK: Record<DataTier, number> = { A_CANDLE: 1, B_TRADES: 2, C_L2: 3 };
const FEATURE_MIN_TIER: Record<string, DataTier> = {};
for (const f of TIER_A_FEATURES) FEATURE_MIN_TIER[f] = "A_CANDLE";
for (const f of TIER_B_FEATURES) FEATURE_MIN_TIER[f] = "B_TRADES";
for (const f of TIER_C_FEATURES) FEATURE_MIN_TIER[f] = "C_L2";

/** The minimum tier a feature requires, or null if the feature name is unknown (⇒ treated as unsupported). */
export function minTierFor(feature: string): DataTier | null {
  return FEATURE_MIN_TIER[feature] ?? null;
}

/** True iff a row at `rowTier` may legitimately provide `feature`. Unknown features are NEVER supported. */
export function tierSupports(rowTier: DataTier, feature: string): boolean {
  const need = minTierFor(feature);
  return need !== null && TIER_RANK[rowTier] >= TIER_RANK[need];
}

export interface TierGateResult {
  /** Feature → value, ONLY for features the tier supports and that were actually present (finite). */
  allowed: Record<string, number>;
  /** Requested features the tier cannot back — kept MISSING, never fabricated. */
  unsupportedByTier: string[];
  /** Tier-supported features that were simply absent in this row (missing, not fabricated to 0). */
  absent: string[];
}

/**
 * Project a raw feature bag onto what `rowTier` legitimately supports. A feature above the row's tier is
 * dropped as `unsupportedByTier` (NOT zero-filled); a supported-but-null feature is dropped as `absent`.
 */
export function gateFeaturesByTier(rowTier: DataTier, requested: Record<string, number | null | undefined>): TierGateResult {
  const allowed: Record<string, number> = {};
  const unsupportedByTier: string[] = [];
  const absent: string[] = [];
  for (const [k, v] of Object.entries(requested)) {
    if (!tierSupports(rowTier, k)) {
      unsupportedByTier.push(k);
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) allowed[k] = v;
    else absent.push(k);
  }
  return { allowed, unsupportedByTier, absent };
}

/** The eligible model uses per tier — the coarse contract the spec fixes (execution realism escalates by tier). */
export const TIER_ELIGIBLE_USES: Record<DataTier, string[]> = {
  A_CANDLE: ["MarketState", "Direction", "coarse-CORTEX", "coarse-Entry-replay", "coarse-Exit-replay"],
  B_TRADES: ["+momentum", "+order-flow-proxy", "+squeeze", "+crowding", "+entry/exit-timing", "+slippage-estimate"],
  C_L2: ["+spread-aware-entry", "+market-impact", "+queue-approx", "+realistic-limit-fills", "+precise-slippage"],
};

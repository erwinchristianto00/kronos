/**
 * Runtime mode boundaries for the cross-sectional lane.
 *
 * Formation answers only "how were symbols selected?".  Smart Basket v1 is a
 * separate lifecycle switch: it keeps entry revalidation and ghost telemetry
 * available even when production intentionally uses the plain MOM36 selector.
 */
export type CrossSectionalFormationMode = "PLAIN_MOM36" | "SMART_FORMATION_RERANK";
export type CrossSectionalAdaptiveExitMode = "OFF" | "ON";
/**
 * FILTERED-only hard eligibility.  This is deliberately separate from formation reranking:
 * it answers whether a symbol is directionally eligible for a side at all, rather than how
 * eligible candidates rank.
 */
export type CrossSectionalSideTrendAlignment = "OFF" | "SLOW_AND_FAST";

/** Utility reranking is opt-in.  An omitted/invalid env value is never allowed to enable it. */
export function isCrossSectionalSmartFormationRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_SMART_FORMATION_RERANK === "1";
}

export function crossSectionalFormationMode(env: NodeJS.ProcessEnv = process.env): CrossSectionalFormationMode {
  return isCrossSectionalSmartFormationRerankEnabled(env) ? "SMART_FORMATION_RERANK" : "PLAIN_MOM36";
}

/**
 * A relative rank alone does not make a valid long or short.  The explicit production contract
 * is slow MOM36 plus fast confirmation on the same side.  Missing/invalid config remains OFF so
 * a research caller is backwards compatible; the LIVE selection contract validates that it is ON
 * before it can admit a new Plain MOM36 basket.
 */
export function crossSectionalFilteredSideTrendAlignment(
  env: NodeJS.ProcessEnv = process.env,
): CrossSectionalSideTrendAlignment {
  return env.CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT === "1" ? "SLOW_AND_FAST" : "OFF";
}

/**
 * Smart Basket v1 owns lifecycle-only behaviour: entry revalidation, durable
 * provenance, and ghost telemetry.  It must not imply formation reranking.
 */
export function isCrossSectionalSmartBasketLifecycleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_SMART_BASKET_V1 === "1";
}

/** Compatibility default preserves pre-cutover behaviour unless OFF is explicit. */
export function crossSectionalAdaptiveExitMode(env: NodeJS.ProcessEnv = process.env): CrossSectionalAdaptiveExitMode {
  return env.CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED === "0" ? "OFF" : "ON";
}

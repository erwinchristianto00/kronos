/**
 * Runtime mode boundaries for the cross-sectional lane.
 *
 * Formation answers only "how were symbols selected?".  Smart Basket v1 is a
 * separate lifecycle switch: it keeps entry revalidation and ghost telemetry
 * available even when production intentionally uses the plain MOM36 selector.
 */
export type CrossSectionalFormationMode = "PLAIN_MOM36" | "SMART_FORMATION_RERANK";
export type CrossSectionalAdaptiveExitMode = "OFF" | "ON";

/** Utility reranking is opt-in.  An omitted/invalid env value is never allowed to enable it. */
export function isCrossSectionalSmartFormationRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_SMART_FORMATION_RERANK === "1";
}

export function crossSectionalFormationMode(env: NodeJS.ProcessEnv = process.env): CrossSectionalFormationMode {
  return isCrossSectionalSmartFormationRerankEnabled(env) ? "SMART_FORMATION_RERANK" : "PLAIN_MOM36";
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

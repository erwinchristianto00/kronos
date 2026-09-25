/**
 * Explicit scope contract for the active Four-Brain testnet experiment.
 *
 * The three currently executable cohorts have different holding behaviour:
 *
 * - CROSS_SECTIONAL_MARKET_NEUTRAL remains a basket/SWING observation.
 * - CROSS_SECTIONAL_DIRECTIONAL_* and CG_MFE_GIVEBACK_* are tactical and
 *   resolve Direction evidence on the INTRADAY horizon.
 *
 * This module is deliberately report/measurement-only. It contains no
 * executor, allocation, sizing, stop, or order-flow dependency.
 */

export const FOUR_BRAIN_TESTNET_COHORT_LANE_IDS = [
  "CROSS_SECTIONAL_MARKET_NEUTRAL",
  "CROSS_SECTIONAL_DIRECTIONAL_LONG",
  "CROSS_SECTIONAL_DIRECTIONAL_SHORT",
  "CG_MFE_GIVEBACK_LONG",
  "CG_MFE_GIVEBACK_SHORT",
] as const;

export type FourBrainTestnetCohortLaneId = (typeof FOUR_BRAIN_TESTNET_COHORT_LANE_IDS)[number];

const COHORT_LANE_IDS = new Set<string>(FOUR_BRAIN_TESTNET_COHORT_LANE_IDS);
const MFE_GIVEBACK_RAW_LANE_IDS = new Set([
  "CG_MFE_GIVEBACK",
  "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK",
]);

export interface FourBrainTestnetCohort {
  sinceMs: number;
  sinceIso: string;
  laneIds: ReadonlySet<FourBrainTestnetCohortLaneId>;
  label: string;
}

/**
 * Resolve the deployment-scoped cohort only on the testnet instance. An
 * invalid/missing cutoff intentionally disables the special scope rather than
 * silently using process-start time, which would make a restart rewrite the
 * evidence boundary.
 */
export function resolveFourBrainTestnetCohort(
  env: NodeJS.ProcessEnv = process.env,
): FourBrainTestnetCohort | null {
  if ((env.FOUR_BRAIN_TESTNET_FOCUS ?? "").trim() !== "1") return null;
  if ((env.LIVE_BINANCE_ENV ?? "").trim().toLowerCase() !== "testnet") return null;
  const sinceMs = Date.parse(env.FOUR_BRAIN_TESTNET_FOCUS_SINCE ?? "");
  if (!Number.isFinite(sinceMs)) return null;
  return {
    sinceMs,
    sinceIso: new Date(sinceMs).toISOString(),
    laneIds: new Set(FOUR_BRAIN_TESTNET_COHORT_LANE_IDS),
    label: "3 lane testnet cohort",
  };
}

/**
 * A repaired exact-fill path starts a new causal cohort at a deliberately
 * configured deployment boundary.  Old unbound fills remain readable as audit
 * evidence, but never become valid attribution by being replayed later.
 *
 * Missing or malformed configuration returns null, intentionally preserving
 * the stricter legacy status (all unbound fills remain blocking) rather than
 * silently moving the evidence boundary at process start.
 */
export function resolveFourBrainExactFillCohortSinceMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if ((env.FOUR_BRAIN_TESTNET_FOCUS ?? "").trim() !== "1") return null;
  if ((env.LIVE_BINANCE_ENV ?? "").trim().toLowerCase() !== "testnet") return null;
  const sinceMs = Date.parse(env.FOUR_BRAIN_EXACT_FILL_COHORT_SINCE ?? "");
  return Number.isFinite(sinceMs) ? sinceMs : null;
}

/**
 * Exact lane-to-horizon policy for the active cohort. The neutral basket is
 * explicitly SWING; it is no longer SWING merely because it fell through a
 * substring heuristic. The two tactical cohorts resolve after 4h.
 */
export function fourBrainTestnetCohortHorizon(
  laneId: string | null | undefined,
): "INTRADAY" | "SWING" | null {
  const id = typeof laneId === "string" ? laneId.trim().toUpperCase() : "";
  if (id === "CROSS_SECTIONAL_MARKET_NEUTRAL") return "SWING";
  if (
    id === "CROSS_SECTIONAL_DIRECTIONAL_LONG" ||
    id === "CROSS_SECTIONAL_DIRECTIONAL_SHORT" ||
    id === "CG_MFE_GIVEBACK_LONG" ||
    id === "CG_MFE_GIVEBACK_SHORT" ||
    MFE_GIVEBACK_RAW_LANE_IDS.has(id)
  ) {
    return "INTRADAY";
  }
  return null;
}

/**
 * Normalize the one direction-agnostic persisted MFE id into the two causal
 * learning ids. No prefix inference is allowed: unknown ids stay unknown.
 */
export function canonicalFourBrainTestnetCohortLaneId(
  laneId: string | null | undefined,
  direction: "LONG" | "SHORT",
): FourBrainTestnetCohortLaneId | null {
  const id = typeof laneId === "string" ? laneId.trim().toUpperCase() : "";
  if (MFE_GIVEBACK_RAW_LANE_IDS.has(id)) {
    return direction === "LONG" ? "CG_MFE_GIVEBACK_LONG" : "CG_MFE_GIVEBACK_SHORT";
  }
  return COHORT_LANE_IDS.has(id) ? id as FourBrainTestnetCohortLaneId : null;
}

/** Minimal structural contract so the Exit Brain can use this scope without a circular import. */
export interface FourBrainTestnetCohortExitTradeLike {
  laneId: string;
  direction: "LONG" | "SHORT";
  closedAtIso: string;
}

/**
 * Keep only post-cutoff resolved trades belonging to the three active testnet
 * cohorts. The returned copy also applies the exact MFE long/short identity
 * split, so an Exit report cannot pool the two directions under one raw lane.
 * When focus is not active, this is an identity transform and global behavior
 * is byte-for-byte unchanged.
 */
export function scopeExitTradeToFourBrainTestnetCohort<T extends FourBrainTestnetCohortExitTradeLike>(
  trade: T,
  cohort: FourBrainTestnetCohort | null,
): (Omit<T, "laneId"> & { laneId: string }) | null {
  if (cohort === null) return { ...trade, laneId: trade.laneId };
  const closedAtMs = Date.parse(trade.closedAtIso);
  const laneId = canonicalFourBrainTestnetCohortLaneId(trade.laneId, trade.direction);
  if (!Number.isFinite(closedAtMs) || closedAtMs < cohort.sinceMs || laneId === null || !cohort.laneIds.has(laneId)) {
    return null;
  }
  return { ...trade, laneId };
}

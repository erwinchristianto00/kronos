/**
 * Candidate catalog for the isolated, Testnet-only daily 4h range lane.
 *
 * This is deliberately disjoint from the cross-sectional candidate universe. Binance USD-M uses
 * one-way netting, so sharing a symbol would make a daily exchange-side bracket and a basket leg
 * compete for the same net quantity. The existing lease guard remains the final safety backstop;
 * this catalog prevents normal daily formation from ever reaching that conflict.
 */

export const DAILY_RANGE_AUTO_POOL_MIN_CANDIDATES = 8;

/**
 * Verified against public USD-M metadata and Testnet availability on 2026-08-26. Membership inside
 * this catalog is still refreshed automatically by CrossSectionalAutoPool every configured cadence.
 */
export const DAILY_RANGE_DEFAULT_CANDIDATE_UNIVERSE = [
  "TRXUSDT",
  "DOTUSDT",
  "XLMUSDT",
  "ATOMUSDT",
  "FILUSDT",
  "ONDOUSDT",
  "ENAUSDT",
  "RUNEUSDT",
  "SANDUSDT",
  "GALAUSDT",
] as const;

export type DailyRangeAutoPoolInput = {
  candidateUniverse: string[];
  fallbackSymbols: string[];
};

function normalizeSymbols(values: readonly string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean))].sort();
}

function configuredSymbols(raw: string | undefined): string[] {
  return normalizeSymbols((raw ?? "").split(","));
}

/**
 * A custom catalog is allowed for controlled Testnet experiments, but never if it overlaps the
 * cross-sectional candidate universe. Fail closed rather than silently dropping an operator's
 * requested symbol and leaving them with an unexpected daily pool.
 */
export function resolveDailyRangeAutoPoolInput(
  crossSectionalUniverse: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DailyRangeAutoPoolInput {
  const configured = configuredSymbols(env.DAILY_RANGE_AUTO_POOL_CANDIDATES);
  const candidateUniverse = configured.length > 0
    ? configured
    : normalizeSymbols(DAILY_RANGE_DEFAULT_CANDIDATE_UNIVERSE);
  const crossSet = new Set(normalizeSymbols(crossSectionalUniverse));
  const overlaps = candidateUniverse.filter((symbol) => crossSet.has(symbol));
  if (overlaps.length > 0) {
    throw new Error(`daily range auto-pool overlaps cross-sectional universe: ${overlaps.join(", ")}`);
  }
  if (candidateUniverse.length < DAILY_RANGE_AUTO_POOL_MIN_CANDIDATES) {
    throw new Error(
      `daily range auto-pool needs at least ${DAILY_RANGE_AUTO_POOL_MIN_CANDIDATES} disjoint candidates; got ${candidateUniverse.length}`,
    );
  }
  return {
    candidateUniverse,
    // During a public-metadata outage, retain a usable disjoint catalog instead of falling back
    // into the cross-sectional pool. Actual Testnet filters are still checked before every order.
    fallbackSymbols: candidateUniverse,
  };
}

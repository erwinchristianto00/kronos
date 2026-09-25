/** Ceiling for new cross-sectional entries; retain measurement symbols for old markouts. */
export function crossSectionalCuratedUniverse(
  measurementUniverse: readonly string[],
  longAllowlist: readonly string[],
  shortAllowlist: readonly string[],
): string[] {
  const longs = new Set(longAllowlist);
  const shorts = new Set(shortAllowlist);
  return [...new Set(measurementUniverse)].filter((symbol) => longs.has(symbol) && shorts.has(symbol));
}

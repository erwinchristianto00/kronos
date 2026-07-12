/**
 * CG_WIDE_FAST_LONG intraday/session (UTC entry-hour) interaction study — operator research brief
 * Task 4, 2026-07-10. Pure, offline aggregation over already-resolved per-trade facts. NO I/O, no
 * Binance, no LiveIntent/store knowledge — mirrors cg-wide-fast-long-path-classification.ts's own
 * "plain data bag, trivially unit-testable" convention exactly (see that module's PathWalkFacts doc).
 *
 * See apps/api/scripts/cg-wide-fast-long-hour-session-study.ts for how the enriched
 * HourInteractionTradeFacts[] below is actually ASSEMBLED for real trades: reading Task 2's persisted
 * per-trade classification JSON (cg-wide-fast-long-path-classification.ts /
 * backfill-cg-wide-fast-long-mfe.ts's PATH_CLASSIFICATION_OUTPUT_PATH), an honest feesUsd lookup
 * against the live-execution store, real entry-time ATR% (already in that JSON), real BTCUSDT candles
 * for the containing UTC hour (via the SAME fetchCandlesRange helper Task 2's backfill script uses —
 * see ../lib/candle-range-fetch.ts), and correlation-clusters.ts's own clusterOf().
 *
 * GOAL (verbatim from the operator brief): determine whether UTC entry hour is a genuine source of
 * edge, a proxy for volatility, a proxy for specific symbols/clusters, or just noise — given the small
 * per-hour sample sizes (79 total real trades spread across roughly 17 distinct hours; most hour
 * buckets are single-digit to low-teens n). Every metric below reports its own sample size so a reader
 * can judge how much to trust it; nothing here should be read as a conclusion on its own.
 *
 * EXPLICITLY SKIPPED interactions (per the brief's own instruction: "skip any interaction the brief
 * lists that has no honestly-available underlying data ... state explicitly which interactions you
 * skipped and why, rather than forcing a fabricated version"):
 *   - hour x breadthState        — no market-breadth collector was running historically for these trades.
 *   - hour x liquidityState      — no depth/liquidity snapshot was captured at entry time historically.
 *   - hour x orderFlowState      — taker-flow/crowding collectors (derivatives-crowding.ts) were built
 *                                  AFTER these 79 trades were entered; not reconstructable.
 *   - hour x priceImpactEfficiencyBucket — price-impact-efficiency.ts is a same-day (2026-07-10) build,
 *                                  same non-reconstructable-history problem Task 2 already documented.
 * These four are NOT represented anywhere in this module (no field, no bucket, no null placeholder) —
 * matching Task 2's own "omitted entirely, never nulled" convention for the identical reason.
 */

export type VolatilityState = "LOW" | "MEDIUM" | "HIGH";
export type BtcDirection = "UP" | "DOWN" | "FLAT";
export type PathClassLike = "DEAD_ON_ARRIVAL" | "SCRATCHABLE" | "TRUE_EXPANSION" | "TOXIC_REVERSAL";

/**
 * Everything the pure aggregation functions below need about ONE real trade. Deliberately a plain
 * data bag assembled by the caller (the script) from Task 2's persisted classification record plus a
 * few honest additive lookups — see this module's top doc comment for exactly where each field comes
 * from. Every field that can genuinely be unavailable for a historical trade is nullable; never
 * estimated/fabricated when null.
 */
export interface HourInteractionTradeFacts {
  tradeId: string;
  symbol: string;
  /** From correlation-clusters.ts's clusterOf(symbol) — reused directly, not rebuilt. */
  cluster: string;
  entryHourUtc: number;
  /** classifyEntryRegimeAlignmentForLong's output, reused directly from Task 2's persisted record. */
  entryRegimeAlignment: string;
  pathClass: PathClassLike;
  /** Real $ P&L, lane-share-prorated — reused directly from Task 2's persisted record. */
  realizedNetPnLUsd: number;
  /** Real $ P&L in R-multiples of planned risk. Null when planned risk was unavailable (Task 2's own
   *  documented null case). */
  realizedR: number | null;
  maxMfeR: number | null;
  minMaeR: number | null;
  /** Whole-position (un-prorated) fees, straight from the ledger (LiveIntent.feesUsd). Null =
   *  genuinely unavailable — matches the earlier finding that feesUsd is null on most
   *  CG_WIDE_FAST_LONG intents. Never estimated. NOT lane-share-prorated (see the script's doc on
   *  why: recomputing the lane-share fraction here would require duplicating backfill-cg-wide-fast-
   *  long-mfe.ts's un-exported laneShare() helper; this diagnostic reports the raw ledger figure with
   *  that limitation stated plainly instead). */
  feesUsd: number | null;
  /** entryATR / entryPrice — a fraction, comparable across symbols of very different price scales
   *  (unlike raw-price-unit ATR). Null when Task 2's entryATR was null for this trade. */
  atrPct: number | null;
  /** Assigned by assignVolatilityStateTerciles() below — a DATA-DRIVEN tercile split over this
   *  sample's own atrPct distribution, not a fixed universal threshold (this lane's typical
   *  stop-distance-relative-to-ATR profile isn't known ahead of time). Null when atrPct is null. */
  volatilityState: VolatilityState | null;
  /** BTCUSDT's % price return over the UTC CALENDAR HOUR containing this trade's entry (hour-open to
   *  hour-close of that specific hour, e.g. if entry was at 04:23 UTC this is BTC's [04:00,05:00)
   *  return) — NOT this trade's own idiosyncratic entry-to-close hold window. See the assembling
   *  script's doc comment for why a fixed calendar-hour anchor was chosen: anchoring to the trade's
   *  own hold length would make BTC-move duration-dependent per trade (a TRUE_EXPANSION trade held
   *  longer automatically accumulates more BTC drift even in pure chop), contaminating the hour-level
   *  comparison this whole study exists to run. Null when BTC candles for that hour could not be
   *  fetched (network failure — never estimated). */
  btcMovePct: number | null;
  btcDirection: BtcDirection | null;
}

function avg(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** Linear-interpolated percentile over an ALREADY-SORTED-ASCENDING array (nearest-rank with
 *  interpolation between the two bracketing ranks — the common "R-7"/Excel-style method). p in [0,1]. */
function percentileOfSorted(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/**
 * Assigns each atrPct value a data-driven LOW/MEDIUM/HIGH tercile label, computed over the terciles
 * of the sample's OWN non-null atrPct distribution (the 1/3 and 2/3 percentiles). A value <= the 1/3
 * percentile is LOW, <= the 2/3 percentile is MEDIUM, otherwise HIGH. Returns null (passthrough) for
 * any input entry that was itself null. Requires at least 2 non-null values to compute meaningful
 * percentiles; with 0 or 1 non-null values every non-null entry is labeled MEDIUM (nothing to split
 * against) — documented degenerate case, never thrown.
 *
 * Deliberately NOT a fixed universal threshold (e.g. "ATR% > 2% = HIGH") — this lane's typical
 * stop-distance-relative-to-ATR profile isn't known ahead of time, and a fixed threshold picked without
 * that context risks either bucketing everything into one label or splitting on an arbitrary,
 * unvalidated line. A same-sample tercile split is a documented simplification, not a claim that these
 * bucket edges generalize to future data.
 */
export function assignVolatilityStateTerciles(atrPcts: ReadonlyArray<number | null>): Array<VolatilityState | null> {
  const known = atrPcts.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length < 2) {
    return atrPcts.map((v) => (v === null || !Number.isFinite(v) ? null : "MEDIUM"));
  }
  const sorted = [...known].sort((a, b) => a - b);
  const p33 = percentileOfSorted(sorted, 1 / 3);
  const p67 = percentileOfSorted(sorted, 2 / 3);
  return atrPcts.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    if (v <= p33) return "LOW";
    if (v <= p67) return "MEDIUM";
    return "HIGH";
  });
}

export function btcDirectionOf(movePct: number | null): BtcDirection | null {
  if (movePct === null || !Number.isFinite(movePct)) return null;
  if (movePct > 0) return "UP";
  if (movePct < 0) return "DOWN";
  return "FLAT";
}

/** Shared per-group metric bundle — the exact statistics the operator brief asks for, computed over
 *  ANY subset of trades (a single hour, a named hour-comparison group, or an hour x subgroup cell).
 *  Every possibly-partial average carries its own sample-size field so a small n is never hidden
 *  behind a single misleadingly-precise number. */
export interface TradeGroupMetrics {
  n: number;
  netPnLUsd: number;
  avgNetR: number | null;
  nWithRealizedR: number;
  medianNetR: number | null;
  /** avgWinUsd / |avgLossUsd|. Null when there are no losses or no wins to divide. */
  payoffRatioUsd: number | null;
  /** sum(winUsd) / |sum(lossUsd)|. Null when there are no losses (undefined, not fabricated as 0 or
   *  Infinity — matches this codebase's established profit-factor convention). */
  profitFactorUsd: number | null;
  avgMfeR: number | null;
  nWithMfe: number;
  avgMaeR: number | null;
  nWithMae: number;
  /** Fraction of n classified TRUE_EXPANSION. */
  trueExpansionRate: number;
  /** Fraction of n classified SCRATCHABLE (the brief's "scratchRate"). */
  scratchRate: number;
  /** Fraction of n classified TOXIC_REVERSAL. */
  toxicReversalRate: number;
  /** Fraction of n classified DEAD_ON_ARRIVAL — not explicitly requested by the brief but included
   *  for completeness; the other three rates alone would otherwise implicitly hide this bucket. */
  deadOnArrivalRate: number;
  avgFeesUsd: number | null;
  nWithFeeData: number;
  averageAtrPct: number | null;
  nWithAtr: number;
  averageBtcMovePct: number | null;
  nWithBtcData: number;
  btcDirectionCounts: { UP: number; DOWN: number; FLAT: number; UNKNOWN: number };
}

/** Core aggregator — computes TradeGroupMetrics over an arbitrary (non-empty OR empty) subset of
 *  trades. Exported directly (not just via the hour/comparison wrappers below) so a caller can
 *  compute the SAME metric bundle over any ad-hoc slice without going through hour bucketing at all. */
export function computeGroupMetrics(records: readonly HourInteractionTradeFacts[]): TradeGroupMetrics {
  const n = records.length;
  const netPnLUsd = sum(records.map((r) => r.realizedNetPnLUsd));

  const withR = records.filter((r) => r.realizedR !== null).map((r) => r.realizedR!);
  const avgNetR = avg(withR);
  const medianNetR = median(withR);

  const winsUsd = records.filter((r) => r.realizedNetPnLUsd > 0).map((r) => r.realizedNetPnLUsd);
  const lossesUsd = records.filter((r) => r.realizedNetPnLUsd < 0).map((r) => r.realizedNetPnLUsd);
  const avgWinUsd = avg(winsUsd);
  const avgLossUsd = avg(lossesUsd);
  const payoffRatioUsd = avgWinUsd !== null && avgLossUsd !== null && avgLossUsd !== 0 ? avgWinUsd / Math.abs(avgLossUsd) : null;
  const sumLossUsd = sum(lossesUsd);
  const profitFactorUsd = sumLossUsd !== 0 ? sum(winsUsd) / Math.abs(sumLossUsd) : null;

  const withMfe = records.filter((r) => r.maxMfeR !== null).map((r) => r.maxMfeR!);
  const withMae = records.filter((r) => r.minMaeR !== null).map((r) => r.minMaeR!);

  const pathCount = (pc: PathClassLike) => records.filter((r) => r.pathClass === pc).length;

  const withFees = records.filter((r) => r.feesUsd !== null).map((r) => r.feesUsd!);
  const withAtr = records.filter((r) => r.atrPct !== null).map((r) => r.atrPct!);
  const withBtc = records.filter((r) => r.btcMovePct !== null).map((r) => r.btcMovePct!);

  const btcDirectionCounts = { UP: 0, DOWN: 0, FLAT: 0, UNKNOWN: 0 };
  for (const r of records) {
    if (r.btcDirection === "UP") btcDirectionCounts.UP += 1;
    else if (r.btcDirection === "DOWN") btcDirectionCounts.DOWN += 1;
    else if (r.btcDirection === "FLAT") btcDirectionCounts.FLAT += 1;
    else btcDirectionCounts.UNKNOWN += 1;
  }

  return {
    n,
    netPnLUsd,
    avgNetR,
    nWithRealizedR: withR.length,
    medianNetR,
    payoffRatioUsd,
    profitFactorUsd,
    avgMfeR: avg(withMfe),
    nWithMfe: withMfe.length,
    avgMaeR: avg(withMae),
    nWithMae: withMae.length,
    trueExpansionRate: n > 0 ? pathCount("TRUE_EXPANSION") / n : 0,
    scratchRate: n > 0 ? pathCount("SCRATCHABLE") / n : 0,
    toxicReversalRate: n > 0 ? pathCount("TOXIC_REVERSAL") / n : 0,
    deadOnArrivalRate: n > 0 ? pathCount("DEAD_ON_ARRIVAL") / n : 0,
    avgFeesUsd: avg(withFees),
    nWithFeeData: withFees.length,
    averageAtrPct: avg(withAtr),
    nWithAtr: withAtr.length,
    averageBtcMovePct: avg(withBtc),
    nWithBtcData: withBtc.length,
    btcDirectionCounts,
  };
}

export interface HourlyMetrics extends TradeGroupMetrics {
  hourUtc: number;
}

/** Per-UTC-entry-hour breakdown — one row per hour PRESENT in the data (hours with zero trades are
 *  simply absent, never a fabricated zero row), sorted ascending by hour. This is the primary table
 *  the operator brief asks for ("for every UTC hour present in the real trade data, reports: n,
 *  netPnL, avgNetR, ..."). */
export function computeHourlyMetrics(records: readonly HourInteractionTradeFacts[]): HourlyMetrics[] {
  const byHour = new Map<number, HourInteractionTradeFacts[]>();
  for (const r of records) {
    const list = byHour.get(r.entryHourUtc) ?? [];
    list.push(r);
    byHour.set(r.entryHourUtc, list);
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hourUtc, list]) => ({ hourUtc, ...computeGroupMetrics(list) }));
}

/** Generic hour x subgroup interaction table: hourUtc -> subgroupLabel -> TradeGroupMetrics. Records
 *  whose subgroupKeyFn returns null are bucketed under "UNKNOWN" (never silently dropped — honesty
 *  over a clean-looking table). Used by the 5 named wrappers below for the interactions the brief asks
 *  for (volatilityState, BTC direction, symbol, cluster, entryRegimeAlignment) — kept generic here so
 *  it is tested once and reused rather than duplicated per interaction. */
export function computeInteractionTable(
  records: readonly HourInteractionTradeFacts[],
  subgroupKeyFn: (r: HourInteractionTradeFacts) => string | null,
): Map<number, Map<string, TradeGroupMetrics>> {
  const byHour = new Map<number, HourInteractionTradeFacts[]>();
  for (const r of records) {
    const list = byHour.get(r.entryHourUtc) ?? [];
    list.push(r);
    byHour.set(r.entryHourUtc, list);
  }
  const out = new Map<number, Map<string, TradeGroupMetrics>>();
  for (const [hourUtc, hourRecords] of byHour) {
    const bySubgroup = new Map<string, HourInteractionTradeFacts[]>();
    for (const r of hourRecords) {
      const key = subgroupKeyFn(r) ?? "UNKNOWN";
      const list = bySubgroup.get(key) ?? [];
      list.push(r);
      bySubgroup.set(key, list);
    }
    const metricsBySubgroup = new Map<string, TradeGroupMetrics>();
    for (const [key, list] of bySubgroup) metricsBySubgroup.set(key, computeGroupMetrics(list));
    out.set(hourUtc, metricsBySubgroup);
  }
  return out;
}

export const hourXVolatilityState = (records: readonly HourInteractionTradeFacts[]) =>
  computeInteractionTable(records, (r) => r.volatilityState);
export const hourXBtcDirection = (records: readonly HourInteractionTradeFacts[]) =>
  computeInteractionTable(records, (r) => r.btcDirection);
export const hourXSymbol = (records: readonly HourInteractionTradeFacts[]) => computeInteractionTable(records, (r) => r.symbol);
export const hourXCluster = (records: readonly HourInteractionTradeFacts[]) => computeInteractionTable(records, (r) => r.cluster);
export const hourXEntryRegimeAlignment = (records: readonly HourInteractionTradeFacts[]) =>
  computeInteractionTable(records, (r) => r.entryRegimeAlignment);

/** Which single key (symbol, cluster, ...) accounts for the largest share of a group's trades, and
 *  what that share is — the direct mechanical check for "is this hour dominated by one bad symbol?"
 *  Returns null for an empty group. Ties broken by first-encountered key (documented, not
 *  significant — a genuine tie means no single key dominates anyway). */
export function dominantKeyShare(
  records: readonly HourInteractionTradeFacts[],
  keyFn: (r: HourInteractionTradeFacts) => string,
): { key: string; n: number; share: number } | null {
  if (records.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of records) {
    const k = keyFn(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: { key: string; n: number } | null = null;
  for (const [key, n] of counts) {
    if (best === null || n > best.n) best = { key, n };
  }
  return best === null ? null : { key: best.key, n: best.n, share: best.n / records.length };
}

export interface HourComparisonGroup {
  label: string;
  hours: number[];
  metrics: TradeGroupMetrics;
  dominantSymbol: { key: string; n: number; share: number } | null;
  dominantCluster: { key: string; n: number; share: number } | null;
}

/**
 * Explicit side-by-side comparison across NAMED hour groups (the operator brief's own ask: 04 UTC,
 * 16 UTC, 17 UTC, and all other hours combined). Each group's metrics answer (a) average
 * volatility/ATR, (c) BTC direction/move mix (both via TradeGroupMetrics' averageAtrPct /
 * averageBtcMovePct / btcDirectionCounts); dominantSymbol/dominantCluster directly answer (b) "is this
 * hour dominated by one symbol/cluster". (d) — "no clear explanatory feature, looks like small-sample
 * noise" — is intentionally NOT computed here as a verdict: this function reports the raw comparison
 * numbers only; the interpretation (including whether n is even large enough to draw (d) from) is left
 * to the report layer / the reader, per the brief's own warning not to over-claim from single-digit-
 * to-low-teens per-hour samples.
 */
export function buildHourComparisonReport(
  records: readonly HourInteractionTradeFacts[],
  groups: ReadonlyArray<{ label: string; hours: number[] }>,
): HourComparisonGroup[] {
  return groups.map(({ label, hours }) => {
    const hourSet = new Set(hours);
    const groupRecords = records.filter((r) => hourSet.has(r.entryHourUtc));
    return {
      label,
      hours: [...hours],
      metrics: computeGroupMetrics(groupRecords),
      dominantSymbol: dominantKeyShare(groupRecords, (r) => r.symbol),
      dominantCluster: dominantKeyShare(groupRecords, (r) => r.cluster),
    };
  });
}

/**
 * Cross Profit Protection V1 — preference selection + earlier protection.
 *
 * Three independent mechanisms, all frozen as one experiment (`cross-profit-protection-v1`):
 *
 *  1. PREFERENCE formation (never a veto). The baseline basket is formed first by the existing
 *     rules. Only if that baseline is valid do we look for a better-aligned 3L/3S combination
 *     inside the MOM36 top-5 per side. A basket that fails the existing rules stays NO_TRADE, and
 *     recent-strength data that is missing or mixed downgrades to a LABEL, never to a rejection.
 *
 *  2. NET-PROFIT FLOOR at +0.5% of frozen entry notional. The shipped ladder arms at $1.50 on a
 *     ~$150 basket (~1.0% of notional), which sits above the median observed peak: measured peaks
 *     were 1.394 / 1.008 / 0.856 / 0.695 / 0.677 % (n=5), so the majority of baskets that ever went
 *     positive were never protected at all. One of them peaked at +$1.288, missed the $1.50 arm by
 *     $0.21, and rode to the -2% hard cut.
 *
 *  3. RELATIVE deterioration exit, independent of arming. A basket may leave before -2% when its
 *     own long-minus-short edge has actually turned, measured on the six frozen symbols.
 *
 * Deliberately NOT here: any BTC or news veto. A 1-minute BTC watchdog on 3L3S baskets was tested
 * across 48 configurations and disproven (correlation ~0, sign inverted on volatility, best
 * +0.0039pp +/- 0.0063). The correct instrument for "is this basket's edge intact" is the basket's
 * own long-minus-short spread, which is what S_h below measures.
 *
 * Every threshold here is frozen as an experiment. They are not to be re-tuned to rescue any single
 * historical basket.
 */

import { accountLegSlices, type AccountedLeg } from "./basket-fill-accounting.js";
export const CROSS_PROFIT_PROTECTION_V1_POLICY_ID = "cross-profit-protection-v1";

/** Arm the net-profit floor at +0.5% of frozen entry notional. NOT 0.5R. */
export const NET_PROFIT_FLOOR_ARM_FRACTION = 0.005;
/** Once armed, keep 70% of the peak. */
export const NET_PROFIT_FLOOR_KEEP_FRACTION = 0.70;
/** Relative deterioration: 15m spread at or below this. */
export const RELATIVE_BREAKDOWN_S15M_MAX = -0.005;
/** Relative deterioration: how far below the peak p must have fallen. */
export const RELATIVE_BREAKDOWN_MIN_GIVEBACK = 0.0025;
/** Both conditions must hold on this many DISTINCT completed minutes. */
export const RELATIVE_BREAKDOWN_CONFIRMATIONS = 2;
/** The floor is quote-driven; never evaluate it more than once a second. */
export const NET_LIQ_MIN_EVALUATION_GAP_MS = 1_000;

export type CrossProfitProtectionExitReason = "NET_PROFIT_FLOOR_EXIT" | "RELATIVE_EDGE_BREAKDOWN";

export type SelectionSource = "BASELINE" | "PREFERRED";

export type SelectionLabel =
  | "PREFERRED_RECENT_STRENGTH_ALIGNED"
  | "BASELINE_ALREADY_BEST"
  | "RECENT_STRENGTH_MIXED"
  | "RECENT_STRENGTH_UNAVAILABLE";

export interface SideCandidate {
  symbol: string;
  /** Rank within its own side, 1 = strongest by MOM36. Used only for the deterministic ordering. */
  mom36Rank: number;
  /** Production weight for this leg. Normalised per side inside the spread math. */
  weight: number;
  /** Price returns over each lookback, keyed by horizon label. Null = unavailable. */
  returns: Readonly<Record<string, number | null>>;
}

export interface CombinationCandidate {
  longs: readonly SideCandidate[];
  shorts: readonly SideCandidate[];
}

/**
 * Weighted price return of one side, weights renormalised across exactly the legs given.
 *
 * Returns null if any leg is missing that horizon, so a partially-observed side can never be
 * compared against a fully-observed one.
 */
export function weightedSideReturn(
  legs: readonly SideCandidate[],
  horizon: string,
): number | null {
  if (legs.length === 0) return null;
  let weightSum = 0;
  for (const leg of legs) {
    if (!Number.isFinite(leg.weight) || leg.weight <= 0) return null;
    weightSum += leg.weight;
  }
  if (!(weightSum > 0)) return null;
  let acc = 0;
  for (const leg of legs) {
    const value = leg.returns[horizon];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    acc += value * (leg.weight / weightSum);
  }
  return acc;
}

/**
 * S_h = weighted LONG price return - weighted SHORT price return, both as PRICE returns.
 *
 * The SHORT term is the price return of the shorted names, not the P&L of being short them. A
 * positive S_h therefore means "the longs are outrunning the shorts", which is the basket's edge
 * regardless of whether the whole market is up or down. That is what makes this measure survive a
 * market-wide move: in a rally where longs +3% and shorts +1%, S is +2%; in a selloff where longs
 * -1% and shorts -3%, S is also +2%.
 */
export function relativeSpread(combination: CombinationCandidate, horizon: string): number | null {
  const longSide = weightedSideReturn(combination.longs, horizon);
  const shortSide = weightedSideReturn(combination.shorts, horizon);
  if (longSide === null || shortSide === null) return null;
  return longSide - shortSide;
}

/** Aggregate side-oriented MOM36 rank; lower is better. Pure ordering, no new utility term. */
export function aggregateMom36Rank(combination: CombinationCandidate): number {
  let total = 0;
  for (const leg of combination.longs) total += leg.mom36Rank;
  for (const leg of combination.shorts) total += leg.mom36Rank;
  return total;
}

/** Deterministic identity for a combination; also the tie-break key. */
export function combinationKey(combination: CombinationCandidate): string {
  const longs = combination.longs.map((l) => l.symbol).slice().sort().join(",");
  const shorts = combination.shorts.map((l) => l.symbol).slice().sort().join(",");
  return `L:${longs}|S:${shorts}`;
}

export interface PreferenceDecision {
  selection: SelectionSource;
  label: SelectionLabel;
  chosen: CombinationCandidate;
  entryS1h: number | null;
  entryS4h: number | null;
  consideredCount: number;
  qualifyingCount: number;
}

/**
 * Choose between the baseline basket and better recent-strength-aligned alternatives.
 *
 * Contract, in order of precedence:
 *  - the baseline is returned unchanged unless a STRICTLY better qualifying alternative exists;
 *  - "qualifying" means S_1h > 0 AND S_4h > 0 for that exact combination;
 *  - among qualifying combinations the best aggregate MOM36 rank wins, ties broken by
 *    `combinationKey` so the result never depends on candidate ordering;
 *  - if the baseline itself qualifies and nothing ranks strictly better, the baseline stands;
 *  - missing strength data or no qualifying alternative is a LABEL on the baseline, never a veto.
 *
 * `alternatives` must already have passed every existing admission rule (cluster cap, scoreGap,
 * eligibility, pool deepening). This function does not relax or re-check any of them.
 */
export function selectPreferredCombination(
  baseline: CombinationCandidate,
  alternatives: readonly CombinationCandidate[],
): PreferenceDecision {
  const baselineS1h = relativeSpread(baseline, "1h");
  const baselineS4h = relativeSpread(baseline, "4h");
  const baselineKey = combinationKey(baseline);

  const pool = [baseline, ...alternatives];
  const seen = new Set<string>();
  const unique: CombinationCandidate[] = [];
  for (const candidate of pool) {
    const key = combinationKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  const qualifying: Array<{ candidate: CombinationCandidate; rank: number; key: string }> = [];
  let anyStrengthKnown = false;
  for (const candidate of unique) {
    const s1h = relativeSpread(candidate, "1h");
    const s4h = relativeSpread(candidate, "4h");
    if (s1h === null || s4h === null) continue;
    anyStrengthKnown = true;
    if (s1h > 0 && s4h > 0) {
      qualifying.push({ candidate, rank: aggregateMom36Rank(candidate), key: combinationKey(candidate) });
    }
  }

  const baseResult = (label: SelectionLabel): PreferenceDecision => ({
    selection: "BASELINE",
    label,
    chosen: baseline,
    entryS1h: baselineS1h,
    entryS4h: baselineS4h,
    consideredCount: unique.length,
    qualifyingCount: qualifying.length,
  });

  if (!anyStrengthKnown) return baseResult("RECENT_STRENGTH_UNAVAILABLE");
  if (qualifying.length === 0) return baseResult("RECENT_STRENGTH_MIXED");

  qualifying.sort((a, b) => (a.rank - b.rank) || a.key.localeCompare(b.key));
  const best = qualifying[0]!;
  if (best.key === baselineKey) return baseResult("BASELINE_ALREADY_BEST");

  // A qualifying baseline is only displaced by a STRICTLY better aggregate rank.
  const baselineQualifies = baselineS1h !== null && baselineS4h !== null && baselineS1h > 0 && baselineS4h > 0;
  if (baselineQualifies && aggregateMom36Rank(baseline) <= best.rank) {
    return baseResult("BASELINE_ALREADY_BEST");
  }

  return {
    selection: "PREFERRED",
    label: "PREFERRED_RECENT_STRENGTH_ALIGNED",
    chosen: best.candidate,
    entryS1h: relativeSpread(best.candidate, "1h"),
    entryS4h: relativeSpread(best.candidate, "4h"),
    consideredCount: unique.length,
    qualifyingCount: qualifying.length,
  };
}

/* ------------------------------------------------------------------ */
/* Section 3 + 4 : persisted protection state                          */
/* ------------------------------------------------------------------ */

export interface CrossProfitProtectionState {
  version: "CROSS_PROFIT_PROTECTION_V1";
  policyId: string;
  /** Frozen total entry notional. Never recomputed, never shrinks with a partial close. */
  entryNotionalUsd: number;
  entryNotionalBoundAt: string | null;
  /** One per-symbol mid snapshot per completed minute. */
  spreadSamples: SpreadSample[];
  /** Last computed rolling spreads and their status, for the dashboard and post-mortem. */
  lastS15m: number | null;
  lastS30m: number | null;
  lastSpreadStatus: SpreadStatus | null;
  armFraction: number;
  keepFraction: number;
  /** Peak p over valid snapshots since entry. Null until the first valid net-liq snapshot. */
  peakNetLiqFraction: number | null;
  peakAt: string | null;
  armed: boolean;
  armedAt: string | null;
  floorFraction: number | null;
  /** Provenance guard: a mark-derived peak must never be adopted as a net-liq peak. */
  peakSource: "NET_LIQUIDATION" | null;
  lastFraction: number | null;
  lastEvaluatedAt: string | null;
  lastEvaluatedAtMs: number;
  /** Completed-minute buckets on which the deterioration conditions held. */
  breakdownConfirmations: number;
  lastBreakdownCandleMs: number | null;
  exitTrigger: {
    reason: CrossProfitProtectionExitReason;
    observedFraction: number;
    peakFraction: number | null;
    floorFraction: number | null;
    s15m: number | null;
    s30m: number | null;
    observedAt: string;
  } | null;
}

export function createCrossProfitProtectionState(
  entryNotionalUsd: number,
  policyId: string = CROSS_PROFIT_PROTECTION_V1_POLICY_ID,
): CrossProfitProtectionState {
  return {
    version: "CROSS_PROFIT_PROTECTION_V1",
    policyId,
    entryNotionalUsd,
    entryNotionalBoundAt: null,
    spreadSamples: [],
    lastS15m: null,
    lastS30m: null,
    lastSpreadStatus: null,
    armFraction: NET_PROFIT_FLOOR_ARM_FRACTION,
    keepFraction: NET_PROFIT_FLOOR_KEEP_FRACTION,
    peakNetLiqFraction: null,
    peakAt: null,
    armed: false,
    armedAt: null,
    floorFraction: null,
    peakSource: null,
    lastFraction: null,
    lastEvaluatedAt: null,
    lastEvaluatedAtMs: 0,
    breakdownConfirmations: 0,
    lastBreakdownCandleMs: null,
    exitTrigger: null,
  };
}

export interface NetLiquidationSnapshot {
  /** Estimated net liquidation P&L in USD: realized + remaining unrealized, net of costs. */
  netPnlUsd: number;
  observedAt: string;
  observedAtMs: number;
  /** False when quotes were stale/insufficient. A DEGRADED snapshot cannot raise a NEW trigger. */
  usable: boolean;
}

/**
 * Advance the net-profit floor. Quote-driven, rate-limited to one evaluation per second.
 *
 * A DEGRADED snapshot updates nothing and triggers nothing: it must not lower the peak, must not
 * arm, and must not fire. Existing hard-cut and horizon paths are untouched by this returning null.
 */
export function advanceNetProfitFloor(
  state: CrossProfitProtectionState,
  snapshot: NetLiquidationSnapshot,
): CrossProfitProtectionExitReason | null {
  if (state.exitTrigger) return null;
  if (!snapshot.usable) return null;
  if (!Number.isFinite(snapshot.netPnlUsd)) return null;
  if (!(state.entryNotionalUsd > 0)) return null;
  if (snapshot.observedAtMs - state.lastEvaluatedAtMs < NET_LIQ_MIN_EVALUATION_GAP_MS
      && state.lastEvaluatedAtMs !== 0) {
    return null;
  }
  const p = snapshot.netPnlUsd / state.entryNotionalUsd;
  state.lastFraction = p;
  state.lastEvaluatedAt = snapshot.observedAt;
  state.lastEvaluatedAtMs = snapshot.observedAtMs;

  const priorPeak = state.peakNetLiqFraction;
  if (priorPeak === null || p > priorPeak) {
    state.peakNetLiqFraction = p;
    state.peakAt = snapshot.observedAt;
    state.peakSource = "NET_LIQUIDATION";
  }
  const peak = state.peakNetLiqFraction ?? p;

  if (!state.armed && peak >= state.armFraction) {
    state.armed = true;
    state.armedAt = snapshot.observedAt;
  }
  if (!state.armed) return null;

  const candidateFloor = peak * state.keepFraction;
  state.floorFraction = state.floorFraction === null
    ? candidateFloor
    : Math.max(state.floorFraction, candidateFloor);

  if (p <= state.floorFraction + 1e-12) {
    state.exitTrigger = {
      reason: "NET_PROFIT_FLOOR_EXIT",
      observedFraction: p,
      peakFraction: state.peakNetLiqFraction,
      floorFraction: state.floorFraction,
      s15m: null,
      s30m: null,
      observedAt: snapshot.observedAt,
    };
    return "NET_PROFIT_FLOOR_EXIT";
  }
  return null;
}

export interface DeteriorationObservation {
  s15m: number | null;
  s30m: number | null;
  /** Current p. Supplied separately so deterioration works before the floor ever arms. */
  fraction: number | null;
  /** Open time of the COMPLETED minute this observation belongs to. */
  candleOpenMs: number;
  observedAt: string;
  usable: boolean;
}

/**
 * Relative deterioration exit. Independent of arming, and it never consults BTC or news.
 *
 * Requires the whole condition set to hold on two DISTINCT completed minutes; re-evaluating the
 * same candle cannot advance the count, so a faster tick can never manufacture a confirmation.
 */
export function advanceRelativeDeterioration(
  state: CrossProfitProtectionState,
  observation: DeteriorationObservation,
): CrossProfitProtectionExitReason | null {
  if (state.exitTrigger) return null;
  if (!observation.usable) return null;
  const { s15m, s30m, fraction } = observation;
  if (s15m === null || s30m === null || fraction === null) return null;
  const peak = state.peakNetLiqFraction;
  if (peak === null) return null;

  const holds = s15m <= RELATIVE_BREAKDOWN_S15M_MAX
    && s30m < 0
    && (peak - fraction) >= RELATIVE_BREAKDOWN_MIN_GIVEBACK;

  if (!holds) return null;
  // The same completed minute can be observed by several ticks; only the first one counts.
  if (state.lastBreakdownCandleMs !== null && observation.candleOpenMs <= state.lastBreakdownCandleMs) {
    return null;
  }
  // Two confirmations must be two CONSECUTIVE valid minutes. A gap means the conditions did not
  // actually persist, so the streak restarts at this minute rather than accumulating across a hole.
  const consecutive = state.lastBreakdownCandleMs !== null
    && observation.candleOpenMs - state.lastBreakdownCandleMs === 60_000;
  state.lastBreakdownCandleMs = observation.candleOpenMs;
  state.breakdownConfirmations = consecutive ? state.breakdownConfirmations + 1 : 1;
  if (state.breakdownConfirmations < RELATIVE_BREAKDOWN_CONFIRMATIONS) return null;

  state.exitTrigger = {
    reason: "RELATIVE_EDGE_BREAKDOWN",
    observedFraction: fraction,
    peakFraction: peak,
    floorFraction: state.floorFraction,
    s15m,
    s30m,
    observedAt: observation.observedAt,
  };
  return "RELATIVE_EDGE_BREAKDOWN";
}

/* ------------------------------------------------------------------ */
/* Spread series : rolling S_h from per-symbol mid quotes              */
/* ------------------------------------------------------------------ */

/** Keep half an hour of minute samples plus a little slack. */
export const SPREAD_SAMPLE_CAPACITY = 40;
/** A sample must land on the requested minute exactly; one minute of slack for tick jitter. */
export const SPREAD_WINDOW_TOLERANCE_MS = 60_000;

export interface SpreadSample {
  minuteMs: number;
  /** Mid price per symbol at that completed minute. */
  mids: Record<string, number>;
}

export type SpreadStatus = "OK" | "WARMING_UP" | "DEGRADED";

export interface SpreadReading {
  value: number | null;
  status: SpreadStatus;
}

/**
 * Record one per-symbol mid snapshot per COMPLETED minute.
 *
 * Per-SYMBOL, not the aggregated spread: a rolling return needs each leg's own base price. Storing
 * only the aggregate makes S_h irrecoverable, which is the bug this replaced - see
 * `spreadOverWindow` for the arithmetic that distinguishes the two.
 */
export function recordMidSample(
  samples: SpreadSample[],
  minuteMs: number,
  mids: Readonly<Record<string, number>>,
): SpreadSample[] {
  if (!Number.isFinite(minuteMs)) return samples;
  const clean: Record<string, number> = {};
  for (const [symbol, mid] of Object.entries(mids)) {
    if (Number.isFinite(mid) && mid > 0) clean[symbol] = mid;
  }
  if (Object.keys(clean).length === 0) return samples;
  const last = samples.at(-1) ?? null;
  if (last && minuteMs < last.minuteMs) return samples; // never reorder a causal path
  if (last && minuteMs === last.minuteMs) {
    samples[samples.length - 1] = { minuteMs, mids: clean };
  } else {
    samples.push({ minuteMs, mids: clean });
  }
  while (samples.length > SPREAD_SAMPLE_CAPACITY) samples.shift();
  return samples;
}

export interface SpreadLeg {
  symbol: string;
  side: "LONG" | "SHORT";
  /** Production weight for this leg. Normalised per side below. */
  weight: number;
}

/**
 * S_h = SUM w_LONG * r_LONG(h) - SUM w_SHORT * r_SHORT(h), weights normalised per side.
 *
 * r_i(h) = mid_i(t) / mid_i(t-h) - 1, each leg against ITS OWN price h ago.
 *
 * This is deliberately NOT `returnSinceEntry(t) - returnSinceEntry(t-h)`. Those differ: the
 * difference of two entry-based returns is (mid_t - mid_old) / ENTRY, while the rolling return is
 * (mid_t - mid_old) / MID_OLD. They agree only while price sits exactly at entry, and diverge by
 * the factor mid_old/entry as the basket moves - precisely when a deterioration read matters most.
 * If a cumulative return c is ever stored instead of a price, the correct recovery is
 * r_h = (1 + c_now) / (1 + c_old) - 1, never c_now - c_old.
 *
 * Status, never a silent zero:
 *  - WARMING_UP: history does not yet reach back a full window;
 *  - DEGRADED:   the current minute is missing, a sample is stale beyond tolerance, or a leg has no
 *                mid in one of the two snapshots.
 */
export function spreadOverWindow(
  samples: readonly SpreadSample[],
  nowMinuteMs: number,
  windowMs: number,
  legs: readonly SpreadLeg[],
): SpreadReading {
  if (legs.length === 0) return { value: null, status: "DEGRADED" };
  const current = samples.at(-1) ?? null;
  if (!current) return { value: null, status: "WARMING_UP" };
  if (current.minuteMs !== nowMinuteMs) return { value: null, status: "DEGRADED" };

  const target = nowMinuteMs - windowMs;
  const oldest = samples[0]!;
  if (oldest.minuteMs > target) return { value: null, status: "WARMING_UP" };

  let chosen: SpreadSample | null = null;
  for (const sample of samples) {
    if (sample.minuteMs <= target) chosen = sample;
  }
  if (!chosen) return { value: null, status: "WARMING_UP" };
  if (target - chosen.minuteMs > SPREAD_WINDOW_TOLERANCE_MS) return { value: null, status: "DEGRADED" };

  let longAcc = 0; let longWeight = 0;
  let shortAcc = 0; let shortWeight = 0;
  for (const leg of legs) {
    if (!Number.isFinite(leg.weight) || leg.weight <= 0) return { value: null, status: "DEGRADED" };
    const now = current.mids[leg.symbol];
    const then = chosen.mids[leg.symbol];
    if (!(Number.isFinite(now) && now > 0) || !(Number.isFinite(then) && then > 0)) {
      return { value: null, status: "DEGRADED" };
    }
    const rolling = now / then - 1;
    if (leg.side === "LONG") { longAcc += rolling * leg.weight; longWeight += leg.weight; }
    else { shortAcc += rolling * leg.weight; shortWeight += leg.weight; }
  }
  if (!(longWeight > 0) || !(shortWeight > 0)) return { value: null, status: "DEGRADED" };
  return { value: (longAcc / longWeight) - (shortAcc / shortWeight), status: "OK" };
}

/** Mid price per symbol from fresh quotes; a stale or missing quote drops that symbol. */
export function midsFromQuotes(
  symbols: readonly string[],
  quotes: ReadonlyMap<string, BookQuote>,
  nowMs: number,
  maxQuoteAgeMs: number,
): Record<string, number> {
  const mids: Record<string, number> = {};
  for (const symbol of symbols) {
    const quote = quotes.get(symbol);
    if (!quote) continue;
    if (nowMs - quote.observedAtMs > maxQuoteAgeMs) continue;
    if (!(quote.bidPrice > 0 && quote.askPrice > 0)) continue;
    mids[symbol] = (quote.bidPrice + quote.askPrice) / 2;
  }
  return mids;
}

/** Bind N0 once, from the basket's real filled notional. Never rebound, never shrunk. */
export function bindEntryNotional(
  state: CrossProfitProtectionState,
  notionalUsd: number,
  at: string,
): void {
  if (state.entryNotionalUsd > 0) return;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return;
  state.entryNotionalUsd = notionalUsd;
  state.entryNotionalBoundAt = at;
}

/* ------------------------------------------------------------------ */
/* Section 5 : estimated net liquidation                               */
/* ------------------------------------------------------------------ */

export interface BookQuote {
  symbol: string;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  observedAtMs: number;
}

export interface NetLiquidationLeg extends AccountedLeg {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  /** Set once the leg is actually closed; its P&L is then REALIZED and never re-marked. */
  exitPrice: number | null;
}

export interface NetLiquidationInput {
  legs: readonly NetLiquidationLeg[];
  quotes: ReadonlyMap<string, BookQuote>;
  nowMs: number;
  maxQuoteAgeMs: number;
  /** Fees and funding already charged by the exchange. Entry fees belong here, not in the price. */
  realizedFeesUsd: number;
  fundingUsd: number;
  /** Modelled cost of closing what is still open, in bps of that remaining notional. */
  remainingExitCostBps: number;
  /** Old frozen C cohorts retain their pre-correction economics; new cohorts require coverage. */
  legacyWholeLegAccounting?: boolean;
  costCoverageReasons?: readonly string[];
}

export interface NetLiquidationEstimate {
  netPnlUsd: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  remainingExitCostUsd: number;
  usable: boolean;
  source: "BOOK_TICKER" | "DEGRADED";
  degradedReasons: readonly string[];
}

/**
 * Estimate what the basket would actually net if it were closed right now.
 *
 * Exit side matters: a LONG is closed by SELLING into the BID, a SHORT by BUYING at the ASK. Using
 * a single mark for both flatters every basket by roughly half the spread per leg. Legs already
 * closed contribute their REALIZED P&L and are never re-marked, so a partial close can neither lose
 * that P&L nor shrink the denominator - N0 stays the frozen entry notional.
 *
 * Entry fees arrive through `realizedFeesUsd`; they are never also folded into entryPrice, and the
 * modelled `remainingExitCostBps` applies only to legs still open, so nothing is charged twice.
 *
 * Any stale or missing quote, or a leg larger than the quoted top-of-book size, makes the whole
 * estimate DEGRADED. A degraded estimate is not a price to act on - callers must not raise a NEW
 * trigger from it, while existing hard-cut and horizon paths continue on their own inputs.
 */
export function estimateNetLiquidation(input: NetLiquidationInput): NetLiquidationEstimate {
  const degraded: string[] = [...(input.costCoverageReasons ?? [])];
  if (![input.realizedFeesUsd, input.fundingUsd, input.remainingExitCostBps].every(Number.isFinite)) degraded.push("INVALID_COSTS");
  let realized = 0;
  let unrealized = 0;
  let openNotional = 0;

  for (const leg of input.legs) {
    const slices = accountLegSlices(input.legacyWholeLegAccounting ? { ...leg, exitFills: undefined } : leg);
    if (!slices) {
      degraded.push(`${leg.symbol}:UNUSABLE_LEG`);
      continue;
    }
    realized += slices.realizedPnlUsd;
    if (slices.remainingQty <= 1e-8) continue;
    const quote = input.quotes.get(leg.symbol);
    if (!quote) { degraded.push(`${leg.symbol}:NO_QUOTE`); continue; }
    if (quote.symbol !== leg.symbol || !Number.isFinite(quote.observedAtMs) || quote.observedAtMs > input.nowMs || input.nowMs - quote.observedAtMs > input.maxQuoteAgeMs) {
      degraded.push(`${leg.symbol}:STALE_QUOTE`);
      continue;
    }
    const exitPrice = leg.side === "LONG" ? quote.bidPrice : quote.askPrice;
    const availableQty = leg.side === "LONG" ? quote.bidQty : quote.askQty;
    if (!(Number.isFinite(exitPrice) && exitPrice > 0)) {
      degraded.push(`${leg.symbol}:BAD_QUOTE`);
      continue;
    }
    if (!(Number.isFinite(availableQty) && availableQty >= slices.remainingQty)) {
      // Top of book cannot absorb the leg; the true fill would walk the book, so this estimate is
      // an upper bound rather than an executable price.
      degraded.push(`${leg.symbol}:DEPTH_SHORTFALL`);
    }
    unrealized += leg.side === "LONG"
      ? (exitPrice - leg.entryPrice) * slices.remainingQty
      : (leg.entryPrice - exitPrice) * slices.remainingQty;
    openNotional += (input.legacyWholeLegAccounting ? leg.entryPrice : exitPrice) * slices.remainingQty;
  }

  const remainingExitCostUsd = openNotional * (input.remainingExitCostBps / 10_000);
  const usable = degraded.length === 0;
  const netPnlUsd = usable
    ? realized + unrealized - remainingExitCostUsd - input.realizedFeesUsd + input.fundingUsd
    : null;

  return {
    netPnlUsd,
    realizedPnlUsd: realized,
    unrealizedPnlUsd: unrealized,
    remainingExitCostUsd,
    usable,
    source: usable ? "BOOK_TICKER" : "DEGRADED",
    degradedReasons: degraded,
  };
}

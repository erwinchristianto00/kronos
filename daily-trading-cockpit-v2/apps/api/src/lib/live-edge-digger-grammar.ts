/**
 * LIVE EDGE DIGGER — the bounded rule grammar and the frozen candidate frontier.
 *
 * WHY THIS IS DATA AND NOT CODE. Every rule is a serialisable predicate object, never a closure.
 * That is what makes a candidate freezable: the rule can be content-hashed, persisted, compared
 * across restarts, and proven not to have changed. A closure could be silently edited between two
 * cycles and no evidence would show it.
 *
 * WHY THE FRONTIER IS CURATED AND SMALL, NOT A CROSS PRODUCT. The full cross product of the axes
 * below is 1,458 rules. Testing 1,458 rules against a few dozen independent episodes guarantees
 * that the best-looking one is noise: at that ratio you would expect several "p<0.01" rules from
 * pure randomness. So the frontier is a hand-enumerated set of economically-motivated theses, hard
 * capped at MAX_ENUMERATED_RULES, and EVERY rule is forward-tested — none is dropped for looking
 * bad, because dropping losers and keeping winners is itself the overfit.
 *
 * WHAT "DISCOVERY" MEANS HERE. Discovery is NOT choosing rules by their outcomes — that would be
 * backwards, and it is the single most common way a research pipeline fools its owner. Discovery is:
 * the frontier is fixed in advance, the live market decides which rules actually FIRE, and the
 * candidates that accumulate forward evidence are the ones the market is currently producing. Rule
 * selection is therefore outcome-free by construction.
 */
import { createHash } from "node:crypto";

import type { Direction, MarketFeatures, RegimeFamily, SymbolFeatures } from "./live-edge-digger-types.js";

/** Hard bound on how many rules may ever be enumerated. A larger frontier is a multiple-testing
 *  problem, not more science. */
export const MAX_ENUMERATED_RULES = 16;

/** Numeric window predicate. Both bounds inclusive; either may be omitted. */
export interface Range {
  readonly min?: number;
  readonly max?: number;
}

/** The complete predicate vocabulary. Anything not expressible here cannot become a rule — that
 *  restriction IS the complexity limit. */
export interface RulePredicates {
  readonly regimeFamilies: readonly RegimeFamily[];
  /** Market-level context. */
  readonly dispersion?: "HIGH" | "LOW";
  readonly breadth?: "HIGH" | "LOW";
  /** Symbol-level, all decision-time. */
  readonly residualRank?: Range;
  readonly momentumRank?: Range;
  readonly atrPercentile?: Range;
  readonly rangeCompressionPercentile?: Range;
  readonly fundingBps?: Range;
  readonly shockAtrUnits?: Range;
  /** Tradability floors — applied to every rule so a "signal" on an untradable symbol never counts. */
  readonly maxSpreadBps?: number;
  readonly minQuoteVolume24hUsd?: number;
}

/** Exit geometry, declared with the rule and frozen with it. */
export interface RuleGeometry {
  /** Initial stop distance in ATR units. */
  readonly stopAtrMultiple: number;
  /** Target distance as a multiple of the stop (the R multiple). */
  readonly targetRMultiple: number;
  /** Max hold in hours before a mark-to-market close. */
  readonly maxHoldHours: number;
}

export interface EdgeRule {
  readonly ruleId: string;
  readonly title: string;
  /** The economic reason this could be real — written before any outcome exists. */
  readonly thesis: string;
  readonly direction: Direction;
  readonly predicates: RulePredicates;
  readonly geometry: RuleGeometry;
  /** Conditions under which this rule should be abandoned rather than re-tuned. */
  readonly rejectionRules: readonly string[];
}

/** Universal tradability floors, applied to every rule. Kept separate so a rule cannot weaken them. */
const TRADABILITY = { maxSpreadBps: 8, minQuoteVolume24hUsd: 10_000_000 } as const;

/**
 * THE FRONTIER. Twelve theses, each with a stated mechanism. Deliberately spans mean-reversion and
 * continuation, market-neutral and directional, calm and shocked tape — so the set cannot only win
 * in one market state, and a positive result in one thesis is interpretable rather than mysterious.
 */
export const EDGE_RULE_FRONTIER: readonly EdgeRule[] = [
  {
    ruleId: "RESIDUAL_REVERSION_LONG_DISPERSED",
    title: "Buy the weakest residual when the tape is dispersed",
    thesis:
      "In a dispersed (stock-pickers') tape the market factor explains little, so an extreme negative " +
      "idiosyncratic move is more likely liquidation-driven than information-driven, and mean-reverts.",
    direction: "LONG",
    predicates: {
      regimeFamilies: ["MIXED", "BULLISH"],
      dispersion: "HIGH",
      residualRank: { max: 0.15 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2, targetRMultiple: 1.5, maxHoldHours: 24 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "RESIDUAL_REVERSION_SHORT_DISPERSED",
    title: "Sell the strongest residual when the tape is dispersed",
    thesis:
      "The mirror of the long case: in a dispersed tape an extreme POSITIVE idiosyncratic move is more " +
      "likely a crowded chase than information, since real news would drag correlated names with it and " +
      "therefore would not show up as an outlier residual in the first place.",
    direction: "SHORT",
    predicates: {
      regimeFamilies: ["MIXED", "BEARISH"],
      dispersion: "HIGH",
      residualRank: { min: 0.85 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2, targetRMultiple: 1.5, maxHoldHours: 24 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "RESIDUAL_MOMENTUM_SHORT_COHESIVE_BEAR",
    title: "Sell residual weakness when the tape is one-way bearish",
    thesis:
      "When breadth is low and the market is cohesive, weak names keep underperforming because forced " +
      "de-risking is sequential, not instantaneous.",
    direction: "SHORT",
    predicates: {
      regimeFamilies: ["BEARISH"],
      breadth: "LOW",
      residualRank: { max: 0.25 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2, targetRMultiple: 1.5, maxHoldHours: 24 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "RESIDUAL_MOMENTUM_LONG_COHESIVE_BULL",
    title: "Buy residual strength when the tape is one-way bullish",
    thesis:
      "The continuation mirror: when breadth is high, allocation into the sector is still arriving, and " +
      "flows are sequential rather than instantaneous, so the names already leading keep receiving the " +
      "marginal bid until breadth itself rolls over.",
    direction: "LONG",
    predicates: {
      regimeFamilies: ["BULLISH"],
      breadth: "HIGH",
      residualRank: { min: 0.75 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2, targetRMultiple: 1.5, maxHoldHours: 24 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "COMPRESSION_BREAK_LONG",
    title: "Buy a coiled range in a bullish tape",
    thesis:
      "Realised volatility is mean-reverting: an unusually tight range resolves into an expansion, and " +
      "in a bullish regime the resolution is upward more often than not.",
    direction: "LONG",
    predicates: {
      regimeFamilies: ["BULLISH"],
      rangeCompressionPercentile: { max: 0.2 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 1.5, targetRMultiple: 2, maxHoldHours: 36 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "COMPRESSION_BREAK_SHORT",
    title: "Sell a coiled range in a bearish tape",
    thesis:
      "The same volatility mean-reversion mechanism with the opposite resolution bias: in a bearish " +
      "regime a compressed range more often breaks down, and downside expansions travel faster than " +
      "upside ones because liquidation supply is reflexive while accumulation demand is patient.",
    direction: "SHORT",
    predicates: {
      regimeFamilies: ["BEARISH"],
      rangeCompressionPercentile: { max: 0.2 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 1.5, targetRMultiple: 2, maxHoldHours: 36 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "SHOCK_REVERSION_LONG",
    title: "Fade a downside shock",
    thesis:
      "A 15m move of several ATR is a liquidation cascade, not repricing; the last part of the move is " +
      "forced selling into a thin book and typically retraces.",
    direction: "LONG",
    predicates: {
      regimeFamilies: ["MIXED", "BULLISH", "BEARISH"],
      shockAtrUnits: { max: -2.5 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2.5, targetRMultiple: 1, maxHoldHours: 12 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "SHOCK_REVERSION_SHORT",
    title: "Fade an upside shock",
    thesis:
      "The squeeze mirror: a multi-ATR 15m rally is short covering into a thin offer, not repricing. " +
      "It is deliberately kept separate from the downside case because the two are NOT symmetric — " +
      "squeezes tend to be shorter and sharper than liquidation flushes, so this side earns its own " +
      "evidence rather than borrowing the long side's.",
    direction: "SHORT",
    predicates: {
      regimeFamilies: ["MIXED", "BULLISH", "BEARISH"],
      shockAtrUnits: { min: 2.5 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2.5, targetRMultiple: 1, maxHoldHours: 12 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "CROWDED_FUNDING_SHORT",
    title: "Sell into extreme positive funding",
    thesis:
      "Persistently positive funding means longs are paying to hold; that crowding is a real, observable " +
      "cash flow and crowded books unwind faster than they build.",
    direction: "SHORT",
    predicates: {
      regimeFamilies: ["MIXED", "BULLISH"],
      fundingBps: { min: 3 },
      momentumRank: { min: 0.7 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2, targetRMultiple: 1.5, maxHoldHours: 24 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "CROWDED_FUNDING_LONG",
    title: "Buy into extreme negative funding",
    thesis:
      "The mirror crowding case: sustained negative funding means shorts are paying to stay short, which " +
      "is a directly observable cost of carry. Crowded short books unwind upward faster than long books " +
      "unwind downward, because covering is forced while profit-taking is discretionary.",
    direction: "LONG",
    predicates: {
      regimeFamilies: ["MIXED", "BEARISH"],
      fundingBps: { max: -3 },
      momentumRank: { max: 0.3 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2, targetRMultiple: 1.5, maxHoldHours: 24 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "LOW_VOL_RELATIVE_STRENGTH_LONG",
    title: "Buy quiet relative strength",
    thesis:
      "Outperformance achieved WITHOUT elevated volatility is more likely accumulation than a chase, and " +
      "it costs less to hold because the stop can sit closer.",
    direction: "LONG",
    predicates: {
      regimeFamilies: ["BULLISH", "MIXED"],
      atrPercentile: { max: 0.4 },
      momentumRank: { min: 0.8 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2, targetRMultiple: 2, maxHoldHours: 36 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
  {
    ruleId: "HIGH_VOL_LAGGARD_SHORT",
    title: "Sell noisy laggards",
    thesis:
      "Underperformance WITH elevated volatility is distribution: holders are exiting into any bid, and " +
      "the elevated range means the move has room to continue.",
    direction: "SHORT",
    predicates: {
      regimeFamilies: ["BEARISH", "MIXED"],
      atrPercentile: { min: 0.6 },
      momentumRank: { max: 0.2 },
      ...TRADABILITY,
    },
    geometry: { stopAtrMultiple: 2, targetRMultiple: 2, maxHoldHours: 36 },
    rejectionRules: ["negative after-cost expectancy", "PF <= 1", "clustered lower bound <= 0"],
  },
];

if (EDGE_RULE_FRONTIER.length > MAX_ENUMERATED_RULES) {
  throw new Error(
    `live-edge-digger: frontier has ${EDGE_RULE_FRONTIER.length} rules, exceeding MAX_ENUMERATED_RULES=${MAX_ENUMERATED_RULES}`,
  );
}
{
  const ids = new Set(EDGE_RULE_FRONTIER.map((r) => r.ruleId));
  if (ids.size !== EDGE_RULE_FRONTIER.length) {
    throw new Error("live-edge-digger: duplicate ruleId in frontier");
  }
}

// ---------------------------------------------------------------------------
// Freezing.
// ---------------------------------------------------------------------------

/**
 * Content hash over the rule's MEANING (direction, predicates, geometry) — not its prose. Editing
 * the thesis text does not mint a new version; changing a threshold, a direction or a stop does.
 * That is the exact line between "clarified the write-up" and "changed the experiment".
 */
export function ruleContentHash(rule: EdgeRule): string {
  const material = JSON.stringify({
    ruleId: rule.ruleId,
    direction: rule.direction,
    predicates: sortedDeep(rule.predicates),
    geometry: rule.geometry,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Stable key order so an equivalent object never hashes two different ways. */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortedDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** `<ruleId>@v1-<hash>` — the identity a shadow observation is stamped with. */
export function candidateIdFor(rule: EdgeRule, version = 1): string {
  return `${rule.ruleId}@v${version}-${ruleContentHash(rule)}`;
}

// ---------------------------------------------------------------------------
// Evaluation.
// ---------------------------------------------------------------------------

function inRange(value: number | null, range: Range | undefined): boolean {
  if (!range) return true;
  if (value === null || !Number.isFinite(value)) return false; // fail closed on missing data
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/** Market-level thresholds for the qualitative buckets, declared once. */
export const MARKET_BUCKETS = {
  /** Dispersion is "HIGH" when the cross-sectional stdev of 24h returns exceeds this. */
  dispersionHigh: 0.04,
  breadthHigh: 0.6,
  breadthLow: 0.4,
} as const;

export function marketPredicatesMatch(rule: EdgeRule, market: MarketFeatures): boolean {
  if (!rule.predicates.regimeFamilies.includes(market.regimeFamily)) return false;
  const p = rule.predicates;
  if (p.dispersion) {
    if (market.dispersion === null) return false;
    const high = market.dispersion >= MARKET_BUCKETS.dispersionHigh;
    if (p.dispersion === "HIGH" && !high) return false;
    if (p.dispersion === "LOW" && high) return false;
  }
  if (p.breadth) {
    if (market.breadth === null) return false;
    if (p.breadth === "HIGH" && market.breadth < MARKET_BUCKETS.breadthHigh) return false;
    if (p.breadth === "LOW" && market.breadth > MARKET_BUCKETS.breadthLow) return false;
  }
  return true;
}

export function symbolPredicatesMatch(rule: EdgeRule, symbol: SymbolFeatures): boolean {
  const p = rule.predicates;
  if (!inRange(symbol.residualRank, p.residualRank)) return false;
  if (!inRange(symbol.momentumRank, p.momentumRank)) return false;
  if (!inRange(symbol.atrPercentile, p.atrPercentile)) return false;
  if (!inRange(symbol.rangeCompressionPercentile, p.rangeCompressionPercentile)) return false;
  if (!inRange(symbol.fundingBps, p.fundingBps)) return false;
  if (!inRange(symbol.shockAtrUnits, p.shockAtrUnits)) return false;
  if (p.maxSpreadBps !== undefined) {
    if (symbol.spreadBps === null || symbol.spreadBps > p.maxSpreadBps) return false;
  }
  if (p.minQuoteVolume24hUsd !== undefined) {
    if (symbol.quoteVolume24hUsd === null || symbol.quoteVolume24hUsd < p.minQuoteVolume24hUsd) return false;
  }
  // A rule without a usable ATR cannot size its own stop, so it must not fire.
  if (symbol.atrPct === null || !(symbol.atrPct > 0)) return false;
  return true;
}

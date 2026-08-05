/**
 * Bounded live hypothesis generation for the Live Edge Digger.
 *
 * WHY THIS EXISTS. The frontier is twelve rules somebody wrote by hand. That is a fixed, human-sized
 * search: it can only ever discover the twelve things already thought of, and every one of them was
 * conceived before the market state it now has to survive. This module lets the engine propose NEW
 * rules from what the tape is actually doing — while keeping every property that makes the existing
 * frontier trustworthy.
 *
 * WHY IT IS NOT DATA MINING. Four hard limits, each enforced here rather than described:
 *
 *  1. GENERATION IS BLIND TO OUTCOMES. The only input is `MarketFeatures` — decision-time
 *     cross-sectional structure. No resolved row, netR, MFE/MAE, realized cost or future candle is
 *     reachable from this module: it does not import ShadowObservation at all, and
 *     `assertDecisionTimeSafe` re-checks every predicate name it emits. A generator that could see
 *     outcomes would be fitting, not hypothesising, and no amount of forward testing afterwards
 *     would undo that.
 *  2. THE GRAMMAR IS THE COMPLEXITY LIMIT. Rules are assembled from the same `RulePredicates`
 *     vocabulary the hand-written frontier uses, with at most MAX_GENERATED_PREDICATES conditions.
 *     Anything inexpressible there cannot be generated, so every output is readable as a sentence
 *     and carries a stated mechanism.
 *  3. HARD CAPS. Per-cycle, per-day and total-active ceilings, checked against what is already
 *     persisted. This is the difference between "propose a few bounded ideas" and a brute-force
 *     sweep that guarantees a false positive.
 *  4. DEDUPLICATION BY NORMALIZED CONTENT HASH. A proposal equal in MEANING to anything already
 *     attempted — seed or generated, firing or dormant — is discarded before it can inflate the
 *     attempt count or be re-frozen under a new clock.
 *
 * Every generated rule is frozen exactly like a seed rule (content-hashed candidateId, anchored at
 * first evaluation) BEFORE it can produce a single observation, and is persisted even if it never
 * fires — so the multiple-testing denominator counts what was really tried.
 */
import {
  assertDecisionTimeSafe,
  type MarketFeatures,
  type RegimeFamily,
  type SymbolFeatures,
} from "./live-edge-digger-types.js";
import {
  MARKET_BUCKETS,
  candidateIdFor,
  ruleContentHash,
  type EdgeRule,
  type RulePredicates,
} from "./live-edge-digger-grammar.js";

/** Ceilings. Deliberately small: this is hypothesis generation, not a parameter sweep. */
export const MAX_GENERATED_PER_CYCLE = 2;
export const MAX_GENERATED_PER_DAY = 6;
export const MAX_ACTIVE_GENERATED = 24;
/** A generated rule may add at most this many predicates beyond its regime scope. */
export const MAX_GENERATED_PREDICATES = 3;

/** Tradability floors, identical to the frontier's. A generated rule can never weaken them. */
const TRADABILITY = { maxSpreadBps: 8, minQuoteVolume24hUsd: 10_000_000 } as const;

/** Fixed exit geometries. Generation proposes CONDITIONS, never new risk shapes — so a generated
 *  rule can never quietly widen a stop or stretch a hold to flatter itself. */
const GEOMETRIES = {
  fast: { stopAtrMultiple: 2, targetRMultiple: 1.5, maxHoldHours: 24 },
  patient: { stopAtrMultiple: 2.5, targetRMultiple: 2, maxHoldHours: 36 },
} as const;

export interface GeneratedRuleRecord {
  readonly rule: EdgeRule;
  readonly candidateId: string;
  readonly generatedAt: string;
  /** The observed market state that motivated this hypothesis — provenance, never an outcome. */
  readonly originCycleId: string;
  readonly originObservation: string;
}

export interface HypothesisGenerationInput {
  readonly market: MarketFeatures;
  readonly cycleId: string;
  readonly atIso: string;
  /** Content hashes of EVERY rule already known — seeds and previously generated alike. */
  readonly existingContentHashes: ReadonlySet<string>;
  /** Previously generated records, used for the day and total-active caps. */
  readonly existingGenerated: readonly GeneratedRuleRecord[];
}

export interface HypothesisGenerationResult {
  readonly generated: readonly GeneratedRuleRecord[];
  /** Proposals that were built and then refused, with the reason. Reported, never silently dropped —
   *  a suppressed duplicate is evidence the search is saturating, which is worth seeing. */
  readonly suppressed: readonly { reason: string; detail: string }[];
}

/** A proposal before caps/dedup: the rule plus why the live tape motivated it. */
interface Proposal {
  readonly rule: EdgeRule;
  readonly originObservation: string;
}

function countPredicates(p: RulePredicates): number {
  let n = 0;
  for (const key of ["dispersion", "breadth", "residualRank", "momentumRank", "atrPercentile",
    "rangeCompressionPercentile", "fundingBps", "shockAtrUnits"] as const) {
    if (p[key] !== undefined) n += 1;
  }
  return n;
}

function median(values: readonly number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1]! + finite[mid]!) / 2 : finite[mid]!;
}

function definedCount(symbols: readonly SymbolFeatures[], pick: (s: SymbolFeatures) => number | null): number {
  return symbols.filter((s) => {
    const v = pick(s);
    return v !== null && Number.isFinite(v);
  }).length;
}

/**
 * Builds the candidate proposals this market state motivates.
 *
 * Each branch is a MECHANISM first and a filter second: the condition is proposed because there is a
 * stated reason it could produce an edge in the state actually observed, not because the shape
 * happened to be enumerable. Branches are guarded on having enough symbols with the relevant feature
 * defined, so a rule is never proposed off two data points.
 */
function proposalsFor(market: MarketFeatures): Proposal[] {
  const out: Proposal[] = [];
  const syms = market.symbols;
  if (syms.length < 8) return out; // too thin a cross-section to say anything about structure
  const family: RegimeFamily = market.regimeFamily;
  if (family === "UNKNOWN") return out; // fail closed: an unclassified tape motivates nothing

  const dispersionHigh = market.dispersion !== null && market.dispersion >= MARKET_BUCKETS.dispersionHigh;
  const breadthHigh = market.breadth !== null && market.breadth >= MARKET_BUCKETS.breadthHigh;
  const breadthLow = market.breadth !== null && market.breadth <= MARKET_BUCKETS.breadthLow;

  // ── 1. COMPRESSION → EXPANSION. Motivated only when compression is actually present in the
  // cross-section: a volatility-expansion thesis proposed into an already-expanded tape is noise.
  if (definedCount(syms, (s) => s.rangeCompressionPercentile) >= 8) {
    const compressed = syms.filter((s) => (s.rangeCompressionPercentile ?? 1) <= 0.25).length;
    if (compressed >= 3) {
      const direction = family === "BEARISH" ? "SHORT" : "LONG";
      out.push({
        rule: {
          ruleId: `GEN_COMPRESSION_EXPANSION_${direction}`,
          title: `Take ${direction === "LONG" ? "longs" : "shorts"} out of compressed ranges in a ${family.toLowerCase()} tape`,
          thesis:
            "Range compression is a coiled-spring state: realised volatility mean-reverts upward, and " +
            "the resolution direction follows the prevailing regime because that is where resting " +
            "liquidity is thinnest. Proposed because this cycle shows a genuine cluster of compressed " +
            "names, not as a generic volatility bet.",
          direction,
          predicates: {
            regimeFamilies: [family],
            rangeCompressionPercentile: { max: 0.25 },
            atrPercentile: { max: 0.6 },
            ...TRADABILITY,
          },
          geometry: GEOMETRIES.patient,
          rejectionRules: [
            "negative after-cost expectancy over >= 5 independent episodes",
            "PF <= 1",
            "clustered lower bound <= 0",
            "abandon rather than re-tune if compression stops preceding expansion",
          ],
        },
        originObservation: `${compressed}/${syms.length} symbols in the bottom compression quartile`,
      });
    }
  }

  // ── 2. CROWDED FUNDING FADE. Only when funding is genuinely extreme somewhere in the cross-section.
  if (definedCount(syms, (s) => s.fundingBps) >= 8) {
    const fundings = syms.map((s) => s.fundingBps).filter((v): v is number => v !== null);
    const med = median(fundings);
    const crowdedLong = fundings.filter((f) => f >= 3).length;
    const crowdedShort = fundings.filter((f) => f <= -3).length;
    if (crowdedLong >= 2 && (med ?? 0) > 0) {
      out.push({
        rule: {
          ruleId: "GEN_CROWDED_FUNDING_FADE_SHORT",
          title: "Fade the most crowded longs when funding is broadly positive",
          thesis:
            "Persistently positive funding means longs are paying to hold; the marginal buyer is " +
            "leveraged and price-insensitive to carry. Such positioning unwinds violently, so the " +
            "asymmetry favours the short side once funding is extreme rather than merely positive.",
          direction: "SHORT",
          predicates: {
            regimeFamilies: [family],
            fundingBps: { min: 3 },
            momentumRank: { min: 0.7 },
            ...TRADABILITY,
          },
          geometry: GEOMETRIES.fast,
          rejectionRules: [
            "negative after-cost expectancy over >= 5 independent episodes",
            "PF <= 1",
            "clustered lower bound <= 0",
            "abandon if crowding no longer precedes unwinds",
          ],
        },
        originObservation: `${crowdedLong} symbols at funding >= 3bps, median ${med?.toFixed(2)}bps`,
      });
    }
    if (crowdedShort >= 2 && (med ?? 0) < 0) {
      out.push({
        rule: {
          ruleId: "GEN_CROWDED_FUNDING_FADE_LONG",
          title: "Fade the most crowded shorts when funding is broadly negative",
          thesis:
            "The mirror: deeply negative funding means shorts are paying carry, and a crowded short " +
            "in a name already at the weak end of the cross-section is the classic squeeze setup.",
          direction: "LONG",
          predicates: {
            regimeFamilies: [family],
            fundingBps: { max: -3 },
            momentumRank: { max: 0.3 },
            ...TRADABILITY,
          },
          geometry: GEOMETRIES.fast,
          rejectionRules: [
            "negative after-cost expectancy over >= 5 independent episodes",
            "PF <= 1",
            "clustered lower bound <= 0",
            "abandon if squeezes stop following crowded shorts",
          ],
        },
        originObservation: `${crowdedShort} symbols at funding <= -3bps, median ${med?.toFixed(2)}bps`,
      });
    }
  }

  // ── 3. SHOCK RECOIL. Requires an actual shock in the tape this cycle.
  if (definedCount(syms, (s) => s.shockAtrUnits) >= 8) {
    const shocked = syms.filter((s) => Math.abs(s.shockAtrUnits ?? 0) >= 1.5).length;
    if (shocked >= 2 && dispersionHigh) {
      out.push({
        rule: {
          ruleId: "GEN_SHOCK_RECOIL_LONG",
          title: "Buy the recoil after a sharp down-shock in a dispersed tape",
          thesis:
            "A 15m move of >=1.5 ATR without the rest of the cross-section following is a liquidity " +
            "event, not repricing — dispersion is what distinguishes the two. Forced sellers exhaust, " +
            "and the book refills at better prices.",
          direction: "LONG",
          predicates: {
            regimeFamilies: [family],
            dispersion: "HIGH",
            shockAtrUnits: { max: -1.5 },
            ...TRADABILITY,
          },
          geometry: GEOMETRIES.fast,
          rejectionRules: [
            "negative after-cost expectancy over >= 5 independent episodes",
            "PF <= 1",
            "clustered lower bound <= 0",
            "abandon if shocks prove to be information rather than liquidity",
          ],
        },
        originObservation: `${shocked} symbols shocked >= 1.5 ATR with dispersion ${market.dispersion?.toFixed(4)}`,
      });
    }
  }

  // ── 4. BREADTH-EXTREME RELATIVE STRENGTH. Only at a genuine breadth extreme.
  if (breadthHigh || breadthLow) {
    const direction = breadthHigh ? "LONG" : "SHORT";
    const rank = breadthHigh ? { min: 0.8 } : { max: 0.2 };
    out.push({
      rule: {
        ruleId: `GEN_BREADTH_EXTREME_RS_${direction}`,
        title: `Follow relative ${breadthHigh ? "strength" : "weakness"} at a breadth extreme`,
        thesis:
          "At a breadth extreme the cross-section is being repriced as a group, and allocation arrives " +
          "sequentially rather than at once. The names already at the extreme of the ranking are where " +
          "that flow lands next, until breadth itself turns.",
        direction,
        predicates: {
          regimeFamilies: [family],
          breadth: breadthHigh ? "HIGH" : "LOW",
          momentumRank: rank,
          ...TRADABILITY,
        },
        geometry: GEOMETRIES.fast,
        rejectionRules: [
          "negative after-cost expectancy over >= 5 independent episodes",
          "PF <= 1",
          "clustered lower bound <= 0",
          "abandon if breadth extremes stop being followed through",
        ],
      },
      originObservation: `breadth ${market.breadth?.toFixed(3)} (${breadthHigh ? "high" : "low"}) across ${syms.length} symbols`,
    });
  }

  return out;
}

/**
 * Generates at most `MAX_GENERATED_PER_CYCLE` genuinely new hypotheses from the CURRENT market state.
 *
 * Deterministic given the same market and the same existing set: proposals are built in a fixed
 * branch order and truncated, never sampled. Two runs over one cycle therefore produce the same
 * rules, which is what makes the freeze anchor meaningful.
 */
export function generateHypotheses(input: HypothesisGenerationInput): HypothesisGenerationResult {
  const generated: GeneratedRuleRecord[] = [];
  const suppressed: { reason: string; detail: string }[] = [];

  const dayKey = input.atIso.slice(0, 10);
  const generatedToday = input.existingGenerated.filter((g) => g.generatedAt.slice(0, 10) === dayKey).length;
  const activeTotal = input.existingGenerated.length;

  // Caps are checked BEFORE any proposal is built, so a saturated engine does no work and says so.
  if (activeTotal >= MAX_ACTIVE_GENERATED) {
    return {
      generated,
      suppressed: [{
        reason: "TOTAL_ACTIVE_CAP",
        detail: `${activeTotal} generated rules already active (cap ${MAX_ACTIVE_GENERATED}) — retire rules before proposing more`,
      }],
    };
  }
  if (generatedToday >= MAX_GENERATED_PER_DAY) {
    return {
      generated,
      suppressed: [{
        reason: "DAILY_CAP",
        detail: `${generatedToday} rules already generated on ${dayKey} (cap ${MAX_GENERATED_PER_DAY})`,
      }],
    };
  }

  const seen = new Set(input.existingContentHashes);
  const remainingToday = MAX_GENERATED_PER_DAY - generatedToday;
  const remainingTotal = MAX_ACTIVE_GENERATED - activeTotal;
  const budget = Math.min(MAX_GENERATED_PER_CYCLE, remainingToday, remainingTotal);

  for (const proposal of proposalsFor(input.market)) {
    if (generated.length >= budget) {
      suppressed.push({
        reason: "CYCLE_CAP",
        detail: `${proposal.rule.ruleId} not generated — per-cycle budget ${budget} already used`,
      });
      continue;
    }
    // Complexity ceiling. A proposal that outgrew the grammar is refused, never trimmed to fit:
    // trimming would silently change the hypothesis into one nobody stated.
    const predicateCount = countPredicates(proposal.rule.predicates);
    if (predicateCount > MAX_GENERATED_PREDICATES) {
      suppressed.push({
        reason: "TOO_COMPLEX",
        detail: `${proposal.rule.ruleId} has ${predicateCount} predicates (max ${MAX_GENERATED_PREDICATES})`,
      });
      continue;
    }
    // Leakage guard, re-asserted on the generated predicate names themselves — the generator is the
    // one place a new field name could enter the system.
    assertDecisionTimeSafe(Object.keys(proposal.rule.predicates), `generated rule ${proposal.rule.ruleId}`);

    const hash = ruleContentHash(proposal.rule);
    if (seen.has(hash)) {
      suppressed.push({
        reason: "DUPLICATE",
        detail: `${proposal.rule.ruleId} is identical in meaning to an existing rule (${hash})`,
      });
      continue;
    }
    seen.add(hash);
    generated.push({
      rule: proposal.rule,
      candidateId: candidateIdFor(proposal.rule),
      generatedAt: input.atIso,
      originCycleId: input.cycleId,
      originObservation: proposal.originObservation,
    });
  }

  return { generated, suppressed };
}

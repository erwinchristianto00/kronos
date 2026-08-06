/**
 * LIVE EDGE DIGGER — the engine.
 *
 * A running research loop: it scans the live universe each cycle using decision-time data, emits
 * NON-EXECUTABLE shadow observations for whichever frozen rules the market actually fires, resolves
 * those observations against later completed candles with a realistic cost model, and reports
 * forward evidence per candidate.
 *
 * IT CANNOT TRADE. It imports no executor, no allocator, no order path and no exchange WRITE client.
 * The only thing it produces is a report object and a report-only store. Its maximum output is a
 * lane SPECIFICATION plus a bounded experiment plan that a human must act on.
 *
 * THE FOUR THINGS THAT MAKE THIS RESEARCH RATHER THAN CURVE-FITTING:
 *
 *  1. The rule frontier is FIXED before any outcome exists, and every rule is forward-tested. Rules
 *     are never selected, dropped or re-tuned by their results (see live-edge-digger-grammar.ts).
 *  2. Every rule ever enumerated is recorded in the attempt registry, so any claimed edge can be
 *     read against the real number of tests rather than against one flattering survivor.
 *  3. Evidence is counted in INDEPENDENT EPISODES using the canonical union-find rule imported from
 *     current-guard-variant-matrix.ts — never raw rows. Fifty symbols firing off one market-wide
 *     reading are one observation, and this book has already been burned by the alternative.
 *  4. Resolution is intrabar-honest: when a bar contains BOTH the stop and the target, the outcome is
 *     recorded as ambiguous and resolved as the STOP. Assuming the good fill is how a backtest
 *     invents an edge that does not survive contact with a real book.
 */
import {
  countIndependentEpisodes,
  MAX_TOP_SYMBOL_SHARE,
  PF_FLOOR,
  PROMOTION_MIN_CALENDAR_DAYS,
  PROMOTION_MIN_HOLDOUT_EFFECTIVE_N,
  STABLE_MIN_DISTINCT_SYMBOLS,
  STABLE_MIN_EFFECTIVE_N,
  STABLE_MIN_HOLDOUT_EFFECTIVE_N,
  TAKER_ROUNDTRIP_BPS,
  type EpisodeIdentityRow,
} from "./current-guard-variant-matrix.js";
import {
  EDGE_RULE_FRONTIER,
  candidateIdFor,
  marketPredicatesMatch,
  ruleContentHash,
  symbolPredicatesMatch,
  type EdgeRule,
} from "./live-edge-digger-grammar.js";
import type { Direction, MarketFeatures, SymbolFeatures } from "./live-edge-digger-types.js";
import {
  COLLECTION_POLICY_VERSION,
  isCurrentPolicyRow,
  isJudgeableEvidence,
  isLegacyRow,
  isPolicyV2,
  maturityCensus,
  maxOverlapDepth,
  policyVersionOf,
  type CollectionPolicyVersion,
  type MaturityCensus,
} from "./live-edge-digger-collection-policy.js";
import {
  MAX_ACTIVE_GENERATED,
  MAX_GENERATED_PER_CYCLE,
  MAX_GENERATED_PER_DAY,
  MAX_GENERATED_PREDICATES,
} from "./live-edge-digger-hypotheses.js";
import type { Candle } from "@dtc/shared";

export const LIVE_EDGE_DIGGER_VERSION = "live-edge-digger-v1" as const;

/** Funding is charged per elapsed 8h settlement, at this rate. Kept explicit rather than folded into
 *  the round-trip so the funding component of a REJECT is attributable. */
export const FUNDING_BPS_PER_8H = 1.5;
/** Extra adverse slippage assumed on a stop exit — stops fill into a thinning book, never at the
 *  printed level. Omitting this is the single most common way a shadow lane overstates its edge. */
export const STOP_SLIPPAGE_BPS = 12;

// ---------------------------------------------------------------------------
// Frozen candidate + shadow observation.
// ---------------------------------------------------------------------------

/** An immutable, versioned candidate. `contentHash` covers direction+predicates+geometry, so any
 *  material change mints a different candidateId and the old evidence stays with the old rule. */
export interface FrozenCandidate {
  readonly candidateId: string;
  readonly ruleId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly title: string;
  readonly thesis: string;
  readonly direction: Direction;
  /**
   * The persisted instant this exact content hash was FIRST evaluated, or null when that is not
   * known. NEVER the report time — a freeze stamp minted at read time would land after the very
   * observations it is supposed to precede, turning the one field that carries the "frozen before
   * outcome" proof into a claim that reads as its own refutation.
   */
  readonly frozenAt: string | null;
  readonly frozenAtSource: FrozenAtSource;
  readonly rule: EdgeRule;
}

/**
 * Where `frozenAt` came from. Explicit because "we know the freeze instant" and "we have no record"
 * must never be indistinguishable to a reader deciding whether to trust the evidence.
 */
export type FrozenAtSource =
  /** Read from the persisted attempt registry — a real, monotone lower bound on the freeze time. */
  | "FIRST_EVALUATED"
  /** The rule exists in source but no cycle has evaluated it yet, so there is nothing to prove. */
  | "NOT_YET_EVALUATED"
  /** Registry entry predates this field. Honest unknown; never back-filled with a guess. */
  | "UNKNOWN_PRE_MIGRATION";

export function freezeCandidate(
  rule: EdgeRule,
  frozenAt: string | null,
  version = 1,
  frozenAtSource: FrozenAtSource = frozenAt === null ? "NOT_YET_EVALUATED" : "FIRST_EVALUATED",
): FrozenCandidate {
  return {
    candidateId: candidateIdFor(rule, version),
    ruleId: rule.ruleId,
    version,
    contentHash: ruleContentHash(rule),
    title: rule.title,
    thesis: rule.thesis,
    direction: rule.direction,
    frozenAt,
    frozenAtSource,
    rule,
  };
}

export type ShadowStatus = "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT";
export type ShadowExitReason = "TARGET" | "STOP" | "AMBIGUOUS_STOP_FIRST" | "MAX_HOLD_MTM";

/**
 * One shadow position. The `features` block is the decision-time snapshot that CAUSED it, frozen at
 * emission so the causal claim is auditable later; the outcome block is written only at resolution.
 */
export interface ShadowObservation {
  readonly observationId: string;
  readonly candidateId: string;
  readonly contentHash: string;
  readonly symbol: string;
  readonly direction: Direction;
  /** Shared-cause identity: every observation emitted by the same cycle carries the same id, which is
   *  what lets the episode counter collapse one market look into one draw. */
  readonly cycleId: string;
  readonly openedAt: string;
  readonly openedAtMs: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly targetPrice: number;
  readonly stopDistanceBps: number;
  readonly maxHoldHours: number;
  readonly regimeAtEntry: string | null;
  readonly features: SymbolFeatures;
  /**
   * The collection policy this row was gathered under. ABSENT on rows written before the field
   * existed, and absent means v1 — those were collected while re-entry was unrestricted, so their
   * row count means something different from a v2 row's. Never back-filled: a v1 row cannot be
   * retroactively made to have been collected under rules that did not exist.
   */
  readonly collectionPolicyVersion?: CollectionPolicyVersion;
  // ---- outcome (null until resolved)
  readonly status: ShadowStatus;
  readonly resolvedAt: string | null;
  readonly exitPrice: number | null;
  readonly exitReason: ShadowExitReason | null;
  readonly grossR: number | null;
  readonly costR: number | null;
  readonly netR: number | null;
  readonly holdHours: number | null;
}

// ---------------------------------------------------------------------------
// Signal emission.
// ---------------------------------------------------------------------------

/** Hard cap on shadow positions one cycle may emit per candidate. Without it a single dispersed
 *  cycle would emit 60 correlated rows and dominate the record — the concentration this engine
 *  exists to measure would be created by the engine itself. */
export const MAX_SIGNALS_PER_CANDIDATE_PER_CYCLE = 3;

export interface EmitResult {
  readonly observations: readonly ShadowObservation[];
  /** Per rule: did it fire, and how many symbols matched before the per-cycle cap. */
  readonly attempts: readonly { ruleId: string; candidateId: string; matched: number; emitted: number }[];
}

/**
 * Evaluates the WHOLE frontier against one cycle's features. Every rule is evaluated every cycle —
 * there is no early exit on a rule that has been performing badly, because that would be selection
 * by outcome.
 */
export function emitShadowSignals(
  market: MarketFeatures,
  cycleId: string,
  frozenAt: string,
  frontier: readonly EdgeRule[] = EDGE_RULE_FRONTIER,
): EmitResult {
  const observations: ShadowObservation[] = [];
  const attempts: { ruleId: string; candidateId: string; matched: number; emitted: number }[] = [];
  const openedAt = new Date(market.asOfMs).toISOString();

  for (const rule of frontier) {
    const candidate = freezeCandidate(rule, frozenAt);
    if (!marketPredicatesMatch(rule, market)) {
      attempts.push({ ruleId: rule.ruleId, candidateId: candidate.candidateId, matched: 0, emitted: 0 });
      continue;
    }
    const matches = market.symbols.filter((s) => symbolPredicatesMatch(rule, s));
    // Deterministic ordering so a restart replays the identical selection: strongest signal first,
    // ties broken by symbol name. Never random, never insertion-ordered.
    const ordered = matches.slice().sort((a, b) => {
      const av = rule.direction === "LONG" ? (a.residualRank ?? 1) : -(a.residualRank ?? 0);
      const bv = rule.direction === "LONG" ? (b.residualRank ?? 1) : -(b.residualRank ?? 0);
      return av !== bv ? av - bv : a.symbol < b.symbol ? -1 : 1;
    });
    const taken = ordered.slice(0, MAX_SIGNALS_PER_CANDIDATE_PER_CYCLE);
    for (const s of taken) {
      const atr = s.atrPct! * s.close;
      const stopDistance = atr * rule.geometry.stopAtrMultiple;
      if (!(stopDistance > 0)) continue;
      const isLong = rule.direction === "LONG";
      const stopPrice = isLong ? s.close - stopDistance : s.close + stopDistance;
      const targetPrice = isLong
        ? s.close + stopDistance * rule.geometry.targetRMultiple
        : s.close - stopDistance * rule.geometry.targetRMultiple;
      if (stopPrice <= 0 || targetPrice <= 0) continue;
      observations.push({
        observationId: `${candidate.candidateId}|${s.symbol}|${market.asOfMs}`,
        candidateId: candidate.candidateId,
        contentHash: candidate.contentHash,
        symbol: s.symbol,
        direction: rule.direction,
        cycleId,
        openedAt,
        openedAtMs: market.asOfMs,
        entryPrice: s.close,
        stopPrice,
        targetPrice,
        stopDistanceBps: (stopDistance / s.close) * 10_000,
        maxHoldHours: rule.geometry.maxHoldHours,
        regimeAtEntry: market.regime,
        features: s,
        collectionPolicyVersion: COLLECTION_POLICY_VERSION,
        status: "OPEN",
        resolvedAt: null,
        exitPrice: null,
        exitReason: null,
        grossR: null,
        costR: null,
        netR: null,
        holdHours: null,
      });
    }
    attempts.push({
      ruleId: rule.ruleId,
      candidateId: candidate.candidateId,
      matched: matches.length,
      emitted: taken.length,
    });
  }
  return { observations, attempts };
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

/**
 * Walks COMPLETED candles strictly AFTER entry and resolves one shadow position.
 *
 * Intrabar honesty: a bar that contains both levels is `AMBIGUOUS_STOP_FIRST` and pays the stop. The
 * bar's OHLC cannot say which came first, and assuming the target is how a shadow lane manufactures
 * an edge it would never have realised.
 */
export function resolveShadowObservation(
  observation: ShadowObservation,
  laterCandles: readonly Candle[],
): ShadowObservation {
  if (observation.status !== "OPEN") return observation;
  const isLong = observation.direction === "LONG";
  const risk = Math.abs(observation.entryPrice - observation.stopPrice);
  if (!(risk > 0)) return observation;

  const horizonMs = observation.maxHoldHours * 3_600_000;
  const deadline = observation.openedAtMs + horizonMs;
  const forward = laterCandles
    .filter((c) => c.openTime > observation.openedAtMs)
    .sort((a, b) => a.openTime - b.openTime);

  let exitPrice: number | null = null;
  let exitReason: ShadowExitReason | null = null;
  let exitMs: number | null = null;

  for (const candle of forward) {
    if (candle.openTime > deadline) break;
    const hitStop = isLong ? candle.low <= observation.stopPrice : candle.high >= observation.stopPrice;
    const hitTarget = isLong ? candle.high >= observation.targetPrice : candle.low <= observation.targetPrice;
    if (hitStop && hitTarget) {
      exitPrice = observation.stopPrice;
      exitReason = "AMBIGUOUS_STOP_FIRST";
      exitMs = candle.openTime;
      break;
    }
    if (hitStop) {
      exitPrice = observation.stopPrice;
      exitReason = "STOP";
      exitMs = candle.openTime;
      break;
    }
    if (hitTarget) {
      exitPrice = observation.targetPrice;
      exitReason = "TARGET";
      exitMs = candle.openTime;
      break;
    }
  }

  if (exitPrice === null) {
    const lastInHorizon = forward.filter((c) => c.openTime <= deadline).at(-1);
    // Not yet resolvable: the horizon has not elapsed in the data we hold. Stay OPEN rather than
    // closing early, which would bias every unresolved position toward its current mark.
    if (!lastInHorizon || forward.at(-1)!.openTime < deadline) return observation;
    exitPrice = lastInHorizon.close;
    exitReason = "MAX_HOLD_MTM";
    exitMs = lastInHorizon.openTime;
  }

  const grossR = ((isLong ? exitPrice - observation.entryPrice : observation.entryPrice - exitPrice) / risk);
  const holdHours = ((exitMs ?? observation.openedAtMs) - observation.openedAtMs) / 3_600_000;

  // ---- realistic cost, all three components, each expressed in R.
  const stopBps = observation.stopDistanceBps;
  const roundTripR = TAKER_ROUNDTRIP_BPS / stopBps;
  const slippageR = exitReason === "STOP" || exitReason === "AMBIGUOUS_STOP_FIRST"
    ? STOP_SLIPPAGE_BPS / stopBps
    : 0;
  const fundingPeriods = Math.floor(holdHours / 8);
  const fundingR = fundingPeriods > 0 ? (fundingPeriods * FUNDING_BPS_PER_8H) / stopBps : 0;
  const costR = -(roundTripR + slippageR + fundingR);
  const netR = grossR + costR;

  return {
    ...observation,
    status: exitReason === "MAX_HOLD_MTM" ? "CLOSED_TIMEOUT" : netR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
    resolvedAt: new Date(exitMs ?? observation.openedAtMs).toISOString(),
    exitPrice,
    exitReason,
    grossR,
    costR,
    netR,
    holdHours,
  };
}

// ---------------------------------------------------------------------------
// Forward evidence + gates.
// ---------------------------------------------------------------------------

/** Episode width. Widest rule horizon (36h) so two positions from the same market look can never be
 *  counted as separate draws just because one rule holds longer. */
export const EPISODE_BLOCK_WIDTH_MS = 36 * 3_600_000;

export type PfStatus = "COMPUTED" | "NO_LOSSES_YET" | "NO_WINS_YET" | "NO_DATA";

export interface CandidateMetrics {
  readonly n: number;
  readonly netExpectancyR: number | null;
  readonly medianNetR: number | null;
  readonly pf: number | null;
  readonly pfStatus: PfStatus;
  readonly wr: number | null;
  readonly payoffRatio: number | null;
  readonly worstNetR: number | null;
  readonly maxDrawdownR: number | null;
  readonly grossExpectancyR: number | null;
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function candidateMetrics(rows: readonly ShadowObservation[]): CandidateMetrics {
  const nets = rows.map((r) => r.netR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const gross = rows.map((r) => r.grossR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nets.length === 0) {
    return {
      n: 0, netExpectancyR: null, medianNetR: null, pf: null, pfStatus: "NO_DATA", wr: null,
      payoffRatio: null, worstNetR: null, maxDrawdownR: null, grossExpectancyR: null,
    };
  }
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v < 0);
  const pos = wins.reduce((s, v) => s + v, 0);
  const neg = losses.reduce((s, v) => s + Math.abs(v), 0);
  const sorted = nets.slice().sort((a, b) => a - b);
  // Running drawdown over the chronological equity curve.
  const chronological = rows
    .filter((r) => typeof r.netR === "number" && Number.isFinite(r.netR))
    .slice()
    .sort((a, b) => a.openedAtMs - b.openedAtMs);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of chronological) {
    cum += r.netR!;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  const avgWin = wins.length > 0 ? pos / wins.length : null;
  const avgLoss = losses.length > 0 ? neg / losses.length : null;
  return {
    n: nets.length,
    netExpectancyR: nets.reduce((s, v) => s + v, 0) / nets.length,
    medianNetR: quantile(sorted, 0.5),
    pf: pos > 0 && neg > 0 ? pos / neg : null,
    pfStatus: pos > 0 && neg === 0 ? "NO_LOSSES_YET" : neg > 0 && pos === 0 ? "NO_WINS_YET" : "COMPUTED",
    wr: wins.length / nets.length,
    payoffRatio: avgWin !== null && avgLoss !== null && avgLoss > 0 ? avgWin / avgLoss : null,
    worstNetR: sorted[0]!,
    maxDrawdownR: maxDd > 0 ? maxDd : null,
    grossExpectancyR: gross.length > 0 ? gross.reduce((s, v) => s + v, 0) / gross.length : null,
  };
}

/** Episode identity: cycleId is the shared-cause key, so one market look is one draw regardless of
 *  how many symbols or rules it triggered. */
function episodeIdentityOf(row: ShadowObservation): EpisodeIdentityRow {
  return {
    episodeMs: row.openedAtMs,
    observationId: row.observationId,
    batchId: row.cycleId,
    episodeId: null,
  };
}

export function independentEpisodes(rows: readonly ShadowObservation[]): number {
  return countIndependentEpisodes(rows.map(episodeIdentityOf), EPISODE_BLOCK_WIDTH_MS);
}

/** Deterministic PRNG — a research interval that moved between runs would be unusable as evidence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(rows: readonly ShadowObservation[]): number {
  let h = 2166136261;
  for (const r of rows) {
    for (let i = 0; i < r.observationId.length; i++) {
      h ^= r.observationId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

export interface ClusterBootstrap {
  readonly clusters: number;
  readonly lowerBound95: number | null;
  readonly upperBound95: number | null;
  readonly iterations: number;
  readonly note: string;
}

/** CLUSTER bootstrap over episodes. Resampling rows would treat correlated positions as independent
 *  draws and return an interval far too tight — the exact error this engine exists to avoid. */
export function clusterBootstrap(rows: readonly ShadowObservation[], iterations = 2000): ClusterBootstrap {
  const groups = new Map<string, ShadowObservation[]>();
  for (const r of rows) {
    if (typeof r.netR !== "number" || !Number.isFinite(r.netR)) continue;
    const key = r.cycleId;
    const list = groups.get(key);
    if (list) list.push(r); else groups.set(key, [r]);
  }
  const clusters = [...groups.values()];
  if (clusters.length < 2) {
    return {
      clusters: clusters.length, lowerBound95: null, upperBound95: null, iterations: 0,
      note: "fewer than 2 independent episodes — a clustered interval is undefined; reporting null " +
        "rather than an interval computed as if the rows were independent",
    };
  }
  const rand = mulberry32(seedFrom(rows));
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    let count = 0;
    for (let g = 0; g < clusters.length; g++) {
      const picked = clusters[Math.floor(rand() * clusters.length)]!;
      for (const r of picked) { sum += r.netR!; count++; }
    }
    if (count > 0) means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  return {
    clusters: clusters.length,
    lowerBound95: quantile(means, 0.025),
    upperBound95: quantile(means, 0.975),
    iterations,
    note: "episode-level resampling, deterministic seed",
  };
}

/** Predeclared chronological partition, by episode, fixed before any outcome existed. */
export const PARTITION_SHARES = { dev: 0.6, validation: 0.25, recent: 0.15 } as const;
export type PartitionName = "DEV" | "VALIDATION_OOS" | "RECENT";

export function partitionByEpisode(rows: readonly ShadowObservation[]): Record<PartitionName, ShadowObservation[]> {
  const byCycle = new Map<string, ShadowObservation[]>();
  for (const r of rows) {
    const list = byCycle.get(r.cycleId);
    if (list) list.push(r); else byCycle.set(r.cycleId, [r]);
  }
  const ordered = [...byCycle.entries()]
    .sort((a, b) => Math.min(...a[1].map((r) => r.openedAtMs)) - Math.min(...b[1].map((r) => r.openedAtMs)));
  const devCount = Math.floor(ordered.length * PARTITION_SHARES.dev);
  const valCount = Math.floor(ordered.length * PARTITION_SHARES.validation);
  const out: Record<PartitionName, ShadowObservation[]> = { DEV: [], VALIDATION_OOS: [], RECENT: [] };
  ordered.forEach(([, group], i) => {
    if (i < devCount) out.DEV.push(...group);
    else if (i < devCount + valCount) out.VALIDATION_OOS.push(...group);
    else out.RECENT.push(...group);
  });
  return out;
}

export interface EdgeGate {
  readonly id: string;
  readonly label: string;
  readonly current: number | null;
  readonly required: number;
  readonly comparator: ">=" | "<=";
  readonly pass: boolean;
  readonly source: string;
}

function gate(
  id: string, label: string, current: number | null, required: number,
  comparator: ">=" | "<=", source: string,
): EdgeGate {
  const pass = current === null ? false : comparator === ">=" ? current >= required : current <= required;
  return { id, label, current, required, comparator, pass, source };
}

/**
 * The candidate's position in the discovery lifecycle.
 *
 * WHY THIS REPLACED A BOOLEAN. The engine previously reported `CANDIDATE | REJECT` and pushed
 * "no resolved forward evidence yet" into the same `rejectionReasons` list as a genuine economic
 * failure. Every rule therefore read REJECT from its very first cycle — before a single outcome
 * existed — which is the one conclusion the evidence could not support. A rule that has never fired
 * and a rule that fired and lost are opposite findings; collapsing them into one word destroyed the
 * only thing a discovery scanner is for.
 *
 * The states are ordered by how much is known, and only ONE of them is a verdict against the rule:
 *  - DORMANT   — evaluated, never fired. Says something about the MARKET (these conditions have not
 *                occurred), nothing about the rule's edge.
 *  - OPEN      — fired; every observation is still unresolved. Outcomes are not yet knowable.
 *  - COLLECTING— has resolved evidence, still short of the canonical floors. Includes POSITIVE
 *                provisional results: a good-looking mean on 2 episodes is not a finding.
 *  - REJECTED  — a real, evidence-backed disqualification (integrity broken, or the economics/
 *                statistics failed on a population large enough to say so). Never assigned for
 *                absence of evidence.
 *  - CANDIDATE — every canonical gate passes.
 *  - RECOMMENDED_FOR_3102_REVIEW — the engine's MAXIMUM output. A human decides; nothing auto-enables.
 */
export type CandidateLifecycle =
  | "DORMANT"
  | "OPEN"
  | "COLLECTING"
  | "REJECTED"
  | "CANDIDATE"
  | "RECOMMENDED_FOR_3102_REVIEW";

export interface CandidateReport {
  readonly candidate: FrozenCandidate;
  readonly rawRows: number;
  readonly openRows: number;
  readonly resolvedRows: number;
  readonly independentEpisodes: number;
  readonly rowsPerEpisode: number | null;
  readonly largestEpisodeShare: number | null;
  readonly distinctSymbols: number;
  readonly distinctRegimes: number;
  readonly calendarDays: number | null;
  readonly topSymbolShare: number | null;
  readonly metrics: CandidateMetrics;
  readonly bootstrap: ClusterBootstrap;
  readonly partitions: readonly { partition: PartitionName; rows: number; episodes: number; netExpectancyR: number | null }[];
  readonly splits: {
    readonly bySymbol: readonly { key: string; rows: number; netExpectancyR: number | null }[];
    readonly byRegime: readonly { key: string; rows: number; netExpectancyR: number | null }[];
    readonly byDay: readonly { key: string; rows: number; netExpectancyR: number | null }[];
  };
  readonly comparisons: readonly { label: string; netExpectancyR: number | null; beatsCandidate: boolean }[];
  readonly gates: readonly EdgeGate[];
  readonly freezeIntegrity: FreezeIntegrity;
  /**
   * Collection-policy and censoring accounting. Everything a reader needs to tell "this rule lost"
   * apart from "this rule has not been measured yet" — the distinction the v1 report could not make.
   */
  readonly evidenceCohorts: EvidenceCohorts;
  readonly lifecycle: CandidateLifecycle;
  /** One sentence naming the BINDING fact behind `lifecycle` — never a list to interpret. */
  readonly lifecycleReason: string;
  /**
   * Disqualifying findings ONLY: integrity breaks, and economics/statistics that failed on a
   * population large enough to conclude from. An empty list here with a non-CANDIDATE lifecycle
   * means "not yet known", which is the normal early state and is never a mark against the rule.
   */
  readonly rejectionReasons: readonly string[];
  /** What must still ACCUMULATE. Immaturity lives here, never in `rejectionReasons`. */
  readonly evidenceStillNeeded: readonly string[];
  /** Multiple-testing context: how many rules were tested for this one to be reported. */
  readonly multipleTesting: {
    readonly attemptsTotal: number;
    readonly cyclesEvaluated: number;
    readonly cyclesFired: number;
    readonly note: string;
  };
}

/**
 * The three populations a candidate's rows fall into, kept strictly apart.
 *
 * The v1 report had ONE number — expectancy over resolved rows — and it was the most misleading
 * number it could have shown. In a book younger than its hold horizon the resolved rows are the
 * fast losers and nothing else, so that figure read as "this rule loses" when the correct statement
 * was "this rule has not been measured".
 */
/**
 * Evidence split by COHORT, in the three sections a reader must never confuse.
 *
 * The v1 report showed one blended set of numbers. The v2 report split matured from censored but
 * still aggregated BOTH collection policies into every "current" figure — so on 3101 at `280cf56`
 * the current-policy block reported resolvedFraction 0.252 and an earliest horizon of
 * 2026-08-06T18:01Z, when the v2 cohort had resolved 0 of 15 rows and its own earliest horizon was
 * 2026-08-07T04:09Z. Worse, every candidate read CENSORED off legacy rows while all of its actual v2
 * rows were still OPEN. A number is only as meaningful as the population it is taken over, so the
 * population is now part of the type.
 */
export interface EvidenceCohorts {
  readonly policyVersion: CollectionPolicyVersion;
  readonly cutoverAt: string | null;

  /** CURRENT_V2 — policy-v2 AND post-cutover. The ONLY population any verdict may use. */
  readonly current: {
    readonly raw: number;
    readonly open: number;
    readonly resolved: number;
    readonly matured: number;
    readonly maturedPendingResolution: number;
    readonly judgeable: number;
    /** Resolved / raw within the CURRENT cohort only. */
    readonly resolvedFraction: number | null;
    readonly independentMaturedEpisodes: number;
    /** Must be 0 — this is the number that measures whether admission is working. */
    readonly maxOverlapDepth: number;
    /** Earliest horizon completion among CURRENT rows only. Legacy rows cannot pull this earlier. */
    readonly earliestHorizonCompletionAt: string | null;
    readonly openMedianAgeHours: number | null;
    readonly openMinRemainingHours: number | null;
    /**
     * How the current statistics must be read. CENSORED is a property of the COHORT, not a state of
     * the candidate — a rule is not "censored", its evidence is.
     */
    readonly statisticLabel: "NO_EVIDENCE_YET" | "CENSORED / NOT JUDGEABLE" | "MATURED";
    /** Resolved-but-not-yet-matured expectancy WITHIN the current cohort. Diagnostic. */
    readonly provisionalResolvedOnlyR: number | null;
    /** Judgeable-only economics — what the gates actually read. */
    readonly matured_metrics: {
      readonly netExpectancyR: number | null;
      readonly episodeWeightedExpectancyR: number | null;
      readonly pf: number | null;
      readonly pfStatus: PfStatus;
      readonly grossExpectancyR: number | null;
      readonly feeR: number | null;
      readonly stopSlippageR: number | null;
      readonly fundingR: number | null;
    };
    readonly exitDistribution: readonly { exitReason: string; rows: number; netExpectancyR: number | null }[];
  };

  /** LEGACY_V1_DIAGNOSTIC — visible, never deleted, and structurally unable to reach a gate. */
  readonly legacy: {
    readonly raw: number;
    readonly open: number;
    readonly resolved: number;
    readonly maxOverlapDepth: number;
    readonly resolvedOnlyExpectancyR: number | null;
    readonly exclusionNote: string;
  };

  /** ALL_TIME_OPERATIONAL — store size only. Never an evidence figure. */
  readonly allTime: {
    readonly raw: number;
  };
}

/**
 * Mean cost components over a row set, re-derived with the engine's own formulas.
 *
 * Reconstructed rather than stored because `costR` is a single folded number; a reader cannot tell a
 * fee-dominated loss from a slippage-dominated one without the split. The formulas are the ones in
 * `resolveShadowObservation`, so the parts always sum back to the stored total.
 */
function meanCostComponents(rows: readonly ShadowObservation[]): {
  feeR: number | null; stopSlippageR: number | null; fundingR: number | null;
} {
  const scored = rows.filter((r) => typeof r.costR === "number" && typeof r.holdHours === "number" && r.stopDistanceBps > 0);
  if (scored.length === 0) return { feeR: null, stopSlippageR: null, fundingR: null };
  let fee = 0, slip = 0, fund = 0;
  for (const r of scored) {
    const stopBps = r.stopDistanceBps;
    fee += TAKER_ROUNDTRIP_BPS / stopBps;
    if (r.exitReason === "STOP" || r.exitReason === "AMBIGUOUS_STOP_FIRST") slip += STOP_SLIPPAGE_BPS / stopBps;
    const periods = Math.floor((r.holdHours as number) / 8);
    if (periods > 0) fund += (periods * FUNDING_BPS_PER_8H) / stopBps;
  }
  const n = scored.length;
  return { feeR: -(fee / n), stopSlippageR: -(slip / n), fundingR: -(fund / n) };
}

/** Equal weight per episode rather than per row — one market look is one draw. */
function episodeWeightedExpectancy(rows: readonly ShadowObservation[]): number | null {
  const scored = rows.filter((r) => typeof r.netR === "number" && Number.isFinite(r.netR));
  if (scored.length === 0) return null;
  const byEpisode = new Map<string, number[]>();
  for (const r of scored) {
    const key = r.resolvedAt ?? r.cycleId;
    const list = byEpisode.get(key);
    if (list) list.push(r.netR as number); else byEpisode.set(key, [r.netR as number]);
  }
  const perEpisode = [...byEpisode.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  return perEpisode.reduce((a, b) => a + b, 0) / perEpisode.length;
}

function buildEvidenceCohorts(
  rows: readonly ShadowObservation[],
  nowMs: number,
  cutoverAtMs: number | null,
): EvidenceCohorts {
  // THE COHORT SPLIT. Every "current" number below is taken over `current` and nothing else.
  const current = rows.filter((r) => isCurrentPolicyRow(r, cutoverAtMs));
  const legacy = rows.filter((r) => isLegacyRow(r, cutoverAtMs));

  const census = maturityCensus(current, nowMs);
  const judgeable = current.filter((r) => isJudgeableEvidence(r, nowMs, cutoverAtMs));
  const currentResolved = current.filter((r) => r.status !== "OPEN" && typeof r.netR === "number");
  const jm = candidateMetrics(judgeable);
  const cost = meanCostComponents(judgeable);

  const byExit = new Map<string, ShadowObservation[]>();
  for (const r of currentResolved) {
    const k = r.exitReason ?? "UNKNOWN";
    const list = byExit.get(k);
    if (list) list.push(r); else byExit.set(k, [r]);
  }

  const legacyResolved = legacy.filter((r) => r.status !== "OPEN" && typeof r.netR === "number");

  return {
    policyVersion: COLLECTION_POLICY_VERSION,
    cutoverAt: cutoverAtMs === null ? null : new Date(cutoverAtMs).toISOString(),
    current: {
      raw: current.length,
      open: census.open,
      resolved: census.resolved,
      matured: census.matured,
      maturedPendingResolution: census.maturedPendingResolution,
      judgeable: judgeable.length,
      resolvedFraction: census.resolvedFraction,
      independentMaturedEpisodes: independentEpisodes(judgeable),
      maxOverlapDepth: maxOverlapDepth(current, nowMs),
      earliestHorizonCompletionAt: census.earliestNextMaturityAt,
      openMedianAgeHours: census.openAgeHoursMedian,
      openMinRemainingHours: census.openRemainingHoursMin,
      statisticLabel: judgeable.length > 0
        ? "MATURED"
        : currentResolved.length > 0 ? "CENSORED / NOT JUDGEABLE" : "NO_EVIDENCE_YET",
      provisionalResolvedOnlyR: candidateMetrics(currentResolved).netExpectancyR,
      matured_metrics: {
        netExpectancyR: jm.netExpectancyR,
        episodeWeightedExpectancyR: episodeWeightedExpectancy(judgeable),
        pf: jm.pf,
        pfStatus: jm.pfStatus,
        grossExpectancyR: jm.grossExpectancyR,
        ...cost,
      },
      exitDistribution: [...byExit.entries()]
        .map(([exitReason, g]) => ({
          exitReason, rows: g.length, netExpectancyR: candidateMetrics(g).netExpectancyR,
        }))
        .sort((a, b) => b.rows - a.rows),
    },
    legacy: {
      raw: legacy.length,
      open: legacy.filter((r) => r.status === "OPEN").length,
      resolved: legacyResolved.length,
      maxOverlapDepth: maxOverlapDepth(legacy, nowMs),
      resolvedOnlyExpectancyR: candidateMetrics(legacyResolved).netExpectancyR,
      exclusionNote:
        "Collected before policy v2, when re-entry was unrestricted (measured: 80+ concurrent rows " +
        "for one candidate+symbol at one price). Retained in full and never rewritten, but excluded " +
        "from every current statistic, gate, interval, ranking, blocker and horizon.",
    },
    allTime: { raw: rows.length },
  };
}

/**
 * Checks the claim the whole engine rests on: every observation was opened under an ALREADY-FROZEN
 * rule. Verified against the persisted freeze anchor rather than asserted in prose, and surfaced as
 * data so a reader can see it was actually checked. A candidate that fails is disqualified — no
 * amount of forward evidence rescues evidence gathered under a rule that was still moving.
 */
export interface FreezeIntegrity {
  readonly frozenAt: string | null;
  readonly frozenAtSource: FrozenAtSource;
  /** Earliest observation this candidate ever opened, or null when it has never fired. */
  readonly earliestObservationAt: string | null;
  /** Rows opened at/before the freeze anchor. Must be 0. */
  readonly rowsOpenedBeforeFreeze: number;
  readonly ok: boolean;
  readonly note: string;
}

function checkFreezeIntegrity(
  candidate: FrozenCandidate,
  rows: readonly ShadowObservation[],
): FreezeIntegrity {
  const openedAts = rows.map((r) => r.openedAt).filter((v): v is string => typeof v === "string");
  const earliest = openedAts.length > 0 ? openedAts.slice().sort()[0] : null;

  if (rows.length === 0) {
    return {
      frozenAt: candidate.frozenAt, frozenAtSource: candidate.frozenAtSource,
      earliestObservationAt: null, rowsOpenedBeforeFreeze: 0, ok: true,
      note: "no observations — nothing to contradict the freeze",
    };
  }
  if (candidate.frozenAt === null) {
    // Cannot be proven either way. Fails CLOSED: unproven is not the same as proven, and this
    // engine's entire value is that it does not let those two states blur together.
    return {
      frozenAt: null, frozenAtSource: candidate.frozenAtSource,
      earliestObservationAt: earliest, rowsOpenedBeforeFreeze: 0, ok: false,
      note: candidate.frozenAtSource === "UNKNOWN_PRE_MIGRATION"
        ? "freeze anchor predates the field — cannot prove these rows were gathered under a frozen rule"
        : "rows exist but no freeze anchor was recorded — cannot prove the rule was frozen first",
    };
  }
  const frozenMs = Date.parse(candidate.frozenAt);
  const before = rows.filter((r) => {
    const t = Date.parse(r.openedAt ?? "");
    return Number.isFinite(t) && Number.isFinite(frozenMs) && t < frozenMs;
  }).length;
  return {
    frozenAt: candidate.frozenAt, frozenAtSource: candidate.frozenAtSource,
    earliestObservationAt: earliest, rowsOpenedBeforeFreeze: before, ok: before === 0,
    note: before === 0
      ? `all ${rows.length} row(s) opened at or after the freeze anchor`
      : `${before} row(s) predate the freeze anchor — the rule was not frozen before this evidence`,
  };
}

function splitBy(
  rows: readonly ShadowObservation[],
  keyOf: (r: ShadowObservation) => string | null,
): { key: string; rows: number; netExpectancyR: number | null }[] {
  const buckets = new Map<string, ShadowObservation[]>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key === null) continue;
    const list = buckets.get(key);
    if (list) list.push(r); else buckets.set(key, [r]);
  }
  return [...buckets.entries()]
    .map(([key, list]) => ({ key, rows: list.length, netExpectancyR: candidateMetrics(list).netExpectancyR }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * The smallest independent-episode population this engine is willing to call a LOSS on.
 *
 * Rejecting on fewer would discard rules for being unlucky in their first look or two — the classic
 * way a discovery process destroys its own frontier before it has learned anything, and the mirror
 * of the mistake this whole file exists to prevent (concluding from too few independent draws). Set
 * at STABLE_MIN_HOLDOUT_EFFECTIVE_N: the same number the canonical machinery already considers the
 * minimum for an out-of-sample statement in either direction.
 *
 * Below this, an ugly-looking expectancy is reported as COLLECTING with the shortfall named — never
 * as REJECTED. Freeze-integrity failures are exempt: those are structural, not statistical.
 */
export const MIN_EPISODES_TO_JUDGE = STABLE_MIN_HOLDOUT_EFFECTIVE_N;

export function buildCandidateReport(
  candidate: FrozenCandidate,
  allRows: readonly ShadowObservation[],
  attemptContext?: { attemptsTotal: number; cyclesEvaluated: number; cyclesFired: number },
  nowMs: number = Date.now(),
  cutoverAtMs: number | null = null,
): CandidateReport {
  const rows = allRows.filter((r) => r.candidateId === candidate.candidateId);
  const evidenceCohorts = buildEvidenceCohorts(rows, nowMs, cutoverAtMs);

  // THE ONE LINE THAT DECIDES WHAT MAY BE CONCLUDED.
  //
  // `resolved` used to be every row with a netR, and every gate, metric, interval and lifecycle
  // below was computed from it. That set is censored — the nearer barrier resolves first, so early
  // on it holds the fast losers and nothing else — and it mixes v1 rows collected while re-entry was
  // unrestricted (measured: 80-deep overlap) with v2 rows collected one-per-episode. Judging on it
  // produced "-1.03R, 0% win rate" for rules that had not actually been measured once.
  //
  // Everything downstream now reads ONLY policy-v2 rows whose full hold horizon has elapsed. v1 and
  // still-censored rows remain fully visible in `evidenceCohorts`, and are never deleted — they just
  // cannot vote.
  const resolved = rows.filter((r) => isJudgeableEvidence(r, nowMs, cutoverAtMs));
  const episodes = independentEpisodes(resolved);
  const metrics = candidateMetrics(resolved);
  const bootstrap = clusterBootstrap(resolved);
  const parts = partitionByEpisode(resolved);

  const cycleSizes = new Map<string, number>();
  for (const r of resolved) cycleSizes.set(r.cycleId, (cycleSizes.get(r.cycleId) ?? 0) + 1);
  const largest = cycleSizes.size > 0 ? Math.max(...cycleSizes.values()) : 0;

  const times = resolved.map((r) => r.openedAtMs);
  const calendarDays = times.length > 0
    ? Math.round(((Math.max(...times) - Math.min(...times)) / 86_400_000) * 100) / 100
    : null;

  const bySymbolAbs = new Map<string, number>();
  let totalAbs = 0;
  for (const r of resolved) {
    if (typeof r.netR !== "number") continue;
    bySymbolAbs.set(r.symbol, (bySymbolAbs.get(r.symbol) ?? 0) + Math.abs(r.netR));
    totalAbs += Math.abs(r.netR);
  }
  const topSymbolShare = totalAbs > 0 && bySymbolAbs.size > 0
    ? Math.round((Math.max(...bySymbolAbs.values()) / totalAbs) * 1000) / 1000
    : null;

  const partitions = (["DEV", "VALIDATION_OOS", "RECENT"] as const).map((partition) => ({
    partition,
    rows: parts[partition].length,
    episodes: independentEpisodes(parts[partition]),
    netExpectancyR: candidateMetrics(parts[partition]).netExpectancyR,
  }));
  const dev = partitions[0]!;
  const val = partitions[1]!;
  const recent = partitions[2]!;

  const comparisons = [
    {
      label: "NO_TRADE (flat)",
      netExpectancyR: 0,
      beatsCandidate: (metrics.netExpectancyR ?? 0) <= 0,
    },
    {
      label: "Same entries at zero cost (isolates cost drag)",
      netExpectancyR: metrics.grossExpectancyR,
      beatsCandidate: (metrics.grossExpectancyR ?? 0) > (metrics.netExpectancyR ?? 0),
    },
  ];

  const gates: EdgeGate[] = [
    gate("dev_episodes", "DEV independent episodes", dev.episodes, STABLE_MIN_EFFECTIVE_N, ">=", "STABLE_MIN_EFFECTIVE_N"),
    gate("validation_episodes", "Validation/OOS independent episodes", val.episodes, STABLE_MIN_HOLDOUT_EFFECTIVE_N, ">=", "STABLE_MIN_HOLDOUT_EFFECTIVE_N"),
    gate("recent_episodes", "Recent independent episodes", recent.episodes, PROMOTION_MIN_HOLDOUT_EFFECTIVE_N, ">=", "PROMOTION_MIN_HOLDOUT_EFFECTIVE_N"),
    gate("distinct_symbols", "Distinct symbols", new Set(resolved.map((r) => r.symbol)).size, STABLE_MIN_DISTINCT_SYMBOLS, ">=", "STABLE_MIN_DISTINCT_SYMBOLS"),
    gate("calendar_days", "Calendar days", calendarDays, PROMOTION_MIN_CALENDAR_DAYS, ">=", "PROMOTION_MIN_CALENDAR_DAYS"),
    gate("top_symbol_share", "Top-symbol share", topSymbolShare, MAX_TOP_SYMBOL_SHARE, "<=", "MAX_TOP_SYMBOL_SHARE"),
    gate("pf", "Profit factor", metrics.pf, PF_FLOOR, ">=", "PF_FLOOR"),
  ];

  // ── DISQUALIFICATIONS ────────────────────────────────────────────────────────────────────────
  // Every entry below is a POSITIVE finding against the rule, backed by evidence that exists. The
  // absence of evidence is deliberately not representable here — it belongs in evidenceStillNeeded.
  //
  // The economic/statistical tests additionally require a minimum population before they may
  // conclude anything: an expectancy computed on one or two episodes is noise, and rejecting on it
  // would discard rules for having been unlucky early, which is the classic way a discovery process
  // destroys its own frontier. MIN_EPISODES_TO_JUDGE is the smallest population this file is willing
  // to call a loss on.
  const rejectionReasons: string[] = [];

  // Freeze integrity is the ONE disqualification that does not need a large sample: evidence
  // gathered under a rule that cannot be shown to have been frozen first is not forward evidence at
  // all, however good or bad it looks.
  // Checked over the CURRENT cohort only. Freeze integrity is a disqualification, so evaluating it
  // over legacy rows would let a pre-anchor v1 row REJECT a rule whose every current row is clean —
  // another path by which legacy evidence reaches the lifecycle. Legacy provenance is reported in
  // the legacy section instead, where it cannot disqualify anything.
  const freezeIntegrity = checkFreezeIntegrity(candidate, rows.filter((r) => isCurrentPolicyRow(r, cutoverAtMs)));
  if (!freezeIntegrity.ok) rejectionReasons.push(`freeze integrity: ${freezeIntegrity.note}`);

  const judgeable = episodes >= MIN_EPISODES_TO_JUDGE;
  if (judgeable) {
    if (metrics.netExpectancyR !== null && metrics.netExpectancyR <= 0) {
      rejectionReasons.push(
        `after-cost expectancy ${metrics.netExpectancyR.toFixed(4)}R <= 0 over ${episodes} independent episodes`,
      );
    }
    if (metrics.pf !== null && metrics.pf <= PF_FLOOR) {
      rejectionReasons.push(`PF ${metrics.pf.toFixed(3)} <= ${PF_FLOOR} over ${episodes} independent episodes`);
    }
    if (bootstrap.lowerBound95 !== null && bootstrap.lowerBound95 <= 0) {
      rejectionReasons.push(`clustered 95% lower bound ${bootstrap.lowerBound95.toFixed(4)}R <= 0`);
    }
    if (topSymbolShare !== null && topSymbolShare > MAX_TOP_SYMBOL_SHARE) {
      rejectionReasons.push(`concentration: top-symbol share ${topSymbolShare} > ${MAX_TOP_SYMBOL_SHARE}`);
    }
    // Split instability: DEV and VALIDATION disagreeing in SIGN means the result is regime-specific,
    // not an edge. Only meaningful once BOTH sides have their own real evidence — a partition that
    // is merely empty must never be read as disagreement.
    if (dev.netExpectancyR !== null && val.netExpectancyR !== null &&
        dev.rows > 0 && val.rows > 0 &&
        Math.sign(dev.netExpectancyR) !== Math.sign(val.netExpectancyR)) {
      rejectionReasons.push("unstable splits: DEV and validation/OOS expectancy disagree in sign");
    }
  }

  const evidenceStillNeeded: string[] = [];
  if (resolved.length > 0 && !judgeable) {
    evidenceStillNeeded.push(
      `${MIN_EPISODES_TO_JUDGE - episodes} more independent episode(s) before economics may be judged ` +
        `(have ${episodes}; an expectancy on fewer is noise)`,
    );
  }
  if (bootstrap.lowerBound95 === null && resolved.length > 0) {
    evidenceStillNeeded.push(
      `a clustered confidence interval is not yet computable (${bootstrap.clusters} independent episode(s))`,
    );
  }
  if (dev.episodes < STABLE_MIN_EFFECTIVE_N) {
    evidenceStillNeeded.push(`${STABLE_MIN_EFFECTIVE_N - dev.episodes} more independent DEV episodes (have ${dev.episodes})`);
  }
  if (val.episodes < STABLE_MIN_HOLDOUT_EFFECTIVE_N) {
    evidenceStillNeeded.push(`${STABLE_MIN_HOLDOUT_EFFECTIVE_N - val.episodes} more validation/OOS episodes (have ${val.episodes})`);
  }
  if (recent.episodes < PROMOTION_MIN_HOLDOUT_EFFECTIVE_N) {
    evidenceStillNeeded.push(`${PROMOTION_MIN_HOLDOUT_EFFECTIVE_N - recent.episodes} more recent episodes (have ${recent.episodes})`);
  }
  if (evidenceCohorts.current.open > 0) {
    evidenceStillNeeded.push(`${evidenceCohorts.current.open} policy-v2 position(s) still open — outcomes not yet knowable`);
  }
  const immature = evidenceCohorts.current.raw - evidenceCohorts.current.matured;
  if (immature > 0) {
    evidenceStillNeeded.push(
      `${immature} policy-v2 row(s) have not completed their hold horizon` +
        `${evidenceCohorts.current.earliestHorizonCompletionAt === null ? "" : ` (earliest ${evidenceCohorts.current.earliestHorizonCompletionAt})`}` +
        ` — judging before then measures only the nearer barrier`,
    );
  }
  if (evidenceCohorts.legacy.raw > 0) {
    evidenceStillNeeded.push(
      `${evidenceCohorts.legacy.raw} legacy row(s) are retained as historical diagnostics only and ` +
        `contribute nothing to the counts above`,
    );
  }
  if (rows.length === 0) {
    evidenceStillNeeded.push("the rule's entry conditions have not occurred in the live market yet");
  }

  // ── LIFECYCLE ────────────────────────────────────────────────────────────────────────────────
  // Driven ENTIRELY by the current-policy cohort. Legacy rows cannot move a candidate off DORMANT
  // or OPEN: on 3101 at `280cf56` every rule read CENSORED because 86 legacy rows had resolved,
  // while all three of its actual v2 rows were still OPEN and nothing had been measured at all.
  //
  // CENSORED is NOT a state here. A rule is not censored — its evidence is — so the censoring shows
  // up as `evidenceCohorts.current.statisticLabel` next to the numbers it qualifies, and the
  // lifecycle stays COLLECTING, which is what "has outcomes, cannot conclude yet" already means.
  const cur = evidenceCohorts.current;
  const allGatesPass = gates.every((g) => g.pass);
  let lifecycle: CandidateLifecycle;
  let lifecycleReason: string;
  if (rejectionReasons.length > 0) {
    // REJECTED requires evidence that EXISTS and is judgeable; every producer of a rejection reason
    // reads the judgeable set, so legacy rows can never reach here.
    lifecycle = "REJECTED";
    lifecycleReason = rejectionReasons[0]!;
  } else if (allGatesPass && judgeable) {
    lifecycle = "CANDIDATE";
    lifecycleReason = "every canonical gate passes on frozen, after-cost, matured policy-v2 evidence";
  } else if (cur.judgeable > 0) {
    lifecycle = "COLLECTING";
    lifecycleReason = metrics.netExpectancyR !== null && metrics.netExpectancyR > 0
      ? `provisionally positive (${metrics.netExpectancyR.toFixed(4)}R over ${episodes} matured episode(s)) but below the canonical floors — not a finding yet`
      : `${cur.judgeable} matured observation(s) over ${episodes} independent episode(s); canonical floors not yet met`;
  } else if (cur.resolved > 0) {
    // Outcomes exist under the current policy, but none has completed its hold horizon. Still
    // COLLECTING — the statistic is what is censored, not the rule.
    lifecycle = "COLLECTING";
    lifecycleReason =
      `${cur.resolved} policy-v2 row(s) resolved but 0 matured — statistics are ` +
      `CENSORED / NOT JUDGEABLE (a stop resolves sooner than a farther target)` +
      `${cur.earliestHorizonCompletionAt === null ? "" : `; earliest horizon completes ${cur.earliestHorizonCompletionAt}`}`;
  } else if (cur.raw > 0) {
    lifecycle = "OPEN";
    lifecycleReason =
      `${cur.open} policy-v2 observation(s) open; no outcome is knowable yet` +
      `${cur.earliestHorizonCompletionAt === null ? "" : ` (earliest horizon ${cur.earliestHorizonCompletionAt})`}`;
  } else {
    lifecycle = "DORMANT";
    lifecycleReason = evidenceCohorts.legacy.raw > 0
      ? `no policy-v2 evidence yet; ${evidenceCohorts.legacy.raw} legacy row(s) are retained as historical diagnostics only`
      : "evaluated every cycle; the rule's conditions have not occurred in the live market yet";
  }

  return {
    candidate,
    rawRows: rows.length,
    // Real open count. Previously `rows.length - resolved.length`, which silently became wrong the
    // moment `resolved` narrowed to the judgeable subset — it would have counted every censored
    // resolved row as if it were still open.
    // CURRENT-cohort counts. `rawRows` stays all-time (it is the store fact the operator asks for),
    // and the split is available in `evidenceCohorts`.
    openRows: evidenceCohorts.current.open,
    resolvedRows: evidenceCohorts.current.resolved,
    independentEpisodes: episodes,
    rowsPerEpisode: episodes > 0 ? Math.round((resolved.length / episodes) * 100) / 100 : null,
    largestEpisodeShare: resolved.length > 0 ? Math.round((largest / resolved.length) * 1000) / 1000 : null,
    distinctSymbols: new Set(resolved.map((r) => r.symbol)).size,
    distinctRegimes: new Set(resolved.map((r) => r.regimeAtEntry).filter((v): v is string => v !== null)).size,
    calendarDays,
    topSymbolShare,
    metrics,
    bootstrap,
    freezeIntegrity,
    partitions,
    splits: {
      bySymbol: splitBy(resolved, (r) => r.symbol),
      byRegime: splitBy(resolved, (r) => r.regimeAtEntry),
      byDay: splitBy(resolved, (r) => r.openedAt.slice(0, 10)),
    },
    comparisons,
    gates,
    evidenceCohorts,
    lifecycle,
    lifecycleReason,
    rejectionReasons,
    evidenceStillNeeded,
    multipleTesting: {
      attemptsTotal: attemptContext?.attemptsTotal ?? 0,
      cyclesEvaluated: attemptContext?.cyclesEvaluated ?? 0,
      cyclesFired: attemptContext?.cyclesFired ?? 0,
      note:
        "This candidate is one of many rules under simultaneous test. Read any single positive " +
        "result against the total attempt count — the best of N tries is expected to look good.",
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level report.
// ---------------------------------------------------------------------------

export interface AttemptRegistryEntry {
  readonly ruleId: string;
  readonly candidateId: string;
  readonly cyclesEvaluated: number;
  readonly cyclesFired: number;
  readonly observationsEmitted: number;
  /**
   * The FIRST cycle at which this exact candidateId (rule id + content hash) was evaluated, as
   * persisted at that moment and never rewritten afterwards.
   *
   * This is the engine's freeze anchor, and it is the only timestamp here that can support the
   * "frozen before outcome" claim. It is a genuine lower bound: the rule's content hash provably
   * existed and was being evaluated at this instant, so every observation opened later was opened
   * under an already-fixed rule. Changing any threshold, direction or geometry mints a new
   * candidateId and therefore starts a fresh clock — which is the whole point of hashing the rule.
   *
   * Null only for entries written before this field existed; those report UNKNOWN rather than
   * inventing a time.
   */
  readonly firstEvaluatedAt: string | null;
}

export interface LiveEdgeDiggerReport {
  readonly version: typeof LIVE_EDGE_DIGGER_VERSION;
  readonly generatedAt: string;
  readonly reportOnly: true;
  readonly liveBlocked: true;
  readonly scanner: {
    readonly cyclesRun: number;
    readonly lastCycleAt: string | null;
    readonly lastError: string | null;
    readonly universeSize: number | null;
    readonly regime: string | null;
    readonly regimeFamily: string | null;
    readonly breadth: number | null;
    readonly cohesion: number | null;
    readonly dispersion: number | null;
  };
  /**
   * Search coverage. Separate from `scanner.universeSize` because that field is what the cycle
   * SCANNED, and reporting it as the universe let a 21-of-N search present as full-market coverage.
   * Null before the first cycle written by a build that records it.
   */
  readonly coverage: {
    readonly canonicalUniverseSize: number | null;
    readonly scannedSymbols: number | null;
    readonly excludedSymbols: number | null;
    readonly exclusionReasons: readonly { reason: string; count: number }[];
    readonly featureGaps: readonly { feature: string; missing: number }[];
    readonly cycleMs: number | null;
    readonly completedCandleWatermark: string | null;
    /** Explicit, so no reader has to infer it from two numbers. */
    readonly coverageNote: string;
  } | null;
  /** Hypotheses this engine proposed from live structure, and what it refused to propose. */
  readonly generation: {
    readonly generatedRuleCount: number;
    readonly rules: readonly {
      readonly candidateId: string;
      readonly ruleId: string;
      readonly title: string;
      readonly thesis: string;
      readonly generatedAt: string;
      readonly originCycleId: string;
      readonly originObservation: string;
    }[];
    readonly suppressed: readonly { reason: string; detail: string }[];
    readonly caps: { perCycle: number; perDay: number; totalActive: number; maxPredicates: number };
    readonly note: string;
  };
  /** Multiple-testing control: EVERY rule ever enumerated, fired or not. */
  readonly attemptRegistry: readonly AttemptRegistryEntry[];
  readonly rulesEnumerated: number;
  /** Split of `rulesEnumerated` so the seed frontier and generated rules are never conflated. */
  readonly seedRuleCount: number;
  readonly candidates: readonly CandidateReport[];
  /** Headline lifecycle census. With zero resolved outcomes this must read as DORMANT + OPEN only —
   *  any REJECTED here means a real disqualification was found, never an absence of evidence. */
  readonly lifecycleCounts: Record<CandidateLifecycle, number>;
  readonly bestCandidateId: string | null;
  /** null until a candidate passes every canonical gate. */
  readonly recommendation: string | null;
  readonly verdict:
    /** No policy-v2 row has completed its hold horizon, so nothing has been measured yet. This is
     *  NOT a negative result and must never be presented as one. */
    | "CENSORED_NO_MATURED_FORWARD_EVIDENCE"
    | "NO_PROVEN_EDGE_YET"
    | "CANDIDATE_READY_FOR_HUMAN_REVIEW";
  /** Book-wide collection-policy and censoring accounting. */
  /**
   * Book-wide accounting, split by cohort. Three sections that a reader must never blend: what the
   * CURRENT policy has measured, what the LEGACY policy left behind, and plain store facts.
   */
  readonly collection: {
    readonly policyVersion: CollectionPolicyVersion;
    readonly cutoverAt: string | null;
    /** CURRENT_V2 — policy-v2 AND post-cutover. The only population that may inform a verdict. */
    readonly current: {
      readonly raw: number;
      readonly open: number;
      readonly resolved: number;
      readonly matured: number;
      readonly judgeable: number;
      readonly resolvedFraction: number | null;
      readonly independentMaturedEpisodes: number;
      readonly maxOverlapDepth: number;
      readonly earliestHorizonCompletionAt: string | null;
      readonly suppressed: readonly { reason: string; count: number }[];
      readonly statisticLabel: "NO_EVIDENCE_YET" | "CENSORED / NOT JUDGEABLE" | "MATURED";
    };
    /** LEGACY_V1_DIAGNOSTIC — shown, never deleted, structurally unable to reach a gate. */
    readonly legacy: {
      readonly raw: number;
      readonly open: number;
      readonly resolved: number;
      readonly maxOverlapDepth: number;
      readonly resolvedOnlyExpectancyR: number | null;
      readonly exclusionNote: string;
    };
    /** ALL_TIME_OPERATIONAL — store size only, never an evidence figure. */
    readonly allTime: {
      readonly storeRows: number;
    };
    readonly note: string;
  };
  readonly notes: readonly string[];
}

export function buildLiveEdgeDiggerReport(input: {
  generatedAt: string;
  observations: readonly ShadowObservation[];
  attempts: readonly AttemptRegistryEntry[];
  scanner: LiveEdgeDiggerReport["scanner"];
  frontier?: readonly EdgeRule[];
  coverage?: {
    canonicalUniverseSize: number | null;
    scannedSymbols: number | null;
    excludedSymbols: number | null;
    exclusionReasons: readonly { reason: string; count: number }[];
    featureGaps: readonly { feature: string; missing: number }[];
    cycleMs: number | null;
    completedCandleWatermark: string | null;
  } | null;
  generatedRules?: readonly {
    candidateId: string;
    generatedAt: string;
    originCycleId: string;
    originObservation: string;
    rule: EdgeRule;
  }[];
  suppressedProposals?: readonly { reason: string; detail: string }[];
  /** First cycle that ran under collection policy v2. Persisted once, never rewritten. */
  collectionPolicyCutoverAt?: string | null;
  /** Cumulative suppression counts by reason since cutover. */
  suppressedTotals?: Readonly<Record<string, number>>;
}): LiveEdgeDiggerReport {
  const frontier = input.frontier ?? EDGE_RULE_FRONTIER;
  const generatedRules = input.generatedRules ?? [];
  const nowMs = Number.isFinite(Date.parse(input.generatedAt)) ? Date.parse(input.generatedAt) : Date.now();
  const allRows = input.observations;
  // The cutover is the second half of current-cohort membership. Null on a store that has never run
  // a v2 cycle, in which case the version stamp alone decides.
  const cutoverAtMs = input.collectionPolicyCutoverAt && Number.isFinite(Date.parse(input.collectionPolicyCutoverAt))
    ? Date.parse(input.collectionPolicyCutoverAt)
    : null;
  // The freeze anchor is READ from the persisted registry, never minted here. Keyed by candidateId
  // (rule id + content hash) so editing a threshold starts a new clock instead of inheriting the
  // previous rule's history.
  const anchorByCandidateId = new Map(input.attempts.map((a) => [a.candidateId, a]));
  const candidates = frontier
    .map((rule) => {
      const entry = anchorByCandidateId.get(candidateIdFor(rule));
      const frozenAt = entry?.firstEvaluatedAt ?? null;
      const source: FrozenAtSource = frozenAt !== null
        ? "FIRST_EVALUATED"
        : entry === undefined ? "NOT_YET_EVALUATED" : "UNKNOWN_PRE_MIGRATION";
      return buildCandidateReport(freezeCandidate(rule, frozenAt, 1, source), input.observations, {
        attemptsTotal: input.attempts.length,
        cyclesEvaluated: entry?.cyclesEvaluated ?? 0,
        cyclesFired: entry?.cyclesFired ?? 0,
      }, nowMs, cutoverAtMs);
    })
    // Report every rule, including ones with zero evidence — a rule that never fired is itself a
    // finding, and hiding it would understate the number of tests run.
    .sort((a, b) => b.independentEpisodes - a.independentEpisodes);

  const passing = candidates.filter((c) => c.lifecycle === "CANDIDATE");
  // Ranking is by ROBUST FORWARD EVIDENCE — the clustered lower bound, not headline PnL. A high mean
  // on two correlated episodes must never outrank a modest mean on many independent ones.
  const ranked = passing.slice().sort((a, b) => {
    const av = a.bootstrap.lowerBound95 ?? -Infinity;
    const bv = b.bootstrap.lowerBound95 ?? -Infinity;
    return bv - av;
  });
  const best = ranked[0] ?? null;

  // Only the single best candidate is ever promoted to the engine's maximum output, and even that is
  // a REQUEST for human review — nothing here enables anything. Every other passing candidate stays
  // CANDIDATE so the report cannot read as a slate of recommendations.
  const withRecommendation = best
    ? candidates.map((c): CandidateReport =>
        c.candidate.candidateId === best.candidate.candidateId
          ? {
              ...c,
              lifecycle: "RECOMMENDED_FOR_3102_REVIEW",
              lifecycleReason:
                "highest clustered lower bound among candidates passing every canonical gate — " +
                "submitted for human review; this engine cannot enable it",
            }
          : c,
      )
    : candidates;

  // ── BOOK-WIDE COLLECTION CENSUS, COHORT-ISOLATED ────────────────────────────────────────────
  const bookCurrent = allRows.filter((r) => isCurrentPolicyRow(r, cutoverAtMs));
  const bookLegacy = allRows.filter((r) => isLegacyRow(r, cutoverAtMs));
  const currentCensus = maturityCensus(bookCurrent, nowMs);
  const currentJudgeable = bookCurrent.filter((r) => isJudgeableEvidence(r, nowMs, cutoverAtMs));
  const currentResolved = bookCurrent.filter((r) => r.status !== "OPEN" && typeof r.netR === "number");
  const legacyResolved = bookLegacy.filter((r) => r.status !== "OPEN" && typeof r.netR === "number");

  // CUMULATIVE totals since cutover, not this cycle's — "policy v2 has prevented N duplicate
  // entries" is the number that shows the fix working. Falls back to counting the last cycle's
  // detail list on a store written before the totals were persisted.
  const suppressedCounts = new Map<string, number>();
  if (input.suppressedTotals && Object.keys(input.suppressedTotals).length > 0) {
    for (const [reason, count] of Object.entries(input.suppressedTotals)) suppressedCounts.set(reason, count);
  } else {
    for (const sp of input.suppressedProposals ?? []) {
      suppressedCounts.set(sp.reason, (suppressedCounts.get(sp.reason) ?? 0) + 1);
    }
  }

  const collection = {
    policyVersion: COLLECTION_POLICY_VERSION,
    cutoverAt: input.collectionPolicyCutoverAt ?? null,
    current: {
      raw: bookCurrent.length,
      open: currentCensus.open,
      resolved: currentCensus.resolved,
      matured: currentCensus.matured,
      judgeable: currentJudgeable.length,
      resolvedFraction: currentCensus.resolvedFraction,
      independentMaturedEpisodes: independentEpisodes(currentJudgeable),
      maxOverlapDepth: maxOverlapDepth(bookCurrent, nowMs),
      earliestHorizonCompletionAt: currentCensus.earliestNextMaturityAt,
      suppressed: [...suppressedCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      statisticLabel: (currentJudgeable.length > 0
        ? "MATURED"
        : currentResolved.length > 0 ? "CENSORED / NOT JUDGEABLE" : "NO_EVIDENCE_YET") as
        "NO_EVIDENCE_YET" | "CENSORED / NOT JUDGEABLE" | "MATURED",
    },
    legacy: {
      raw: bookLegacy.length,
      open: bookLegacy.filter((r) => r.status === "OPEN").length,
      resolved: legacyResolved.length,
      maxOverlapDepth: maxOverlapDepth(bookLegacy, nowMs),
      resolvedOnlyExpectancyR: candidateMetrics(legacyResolved).netExpectancyR,
      exclusionNote:
        "Pre-policy-v2 evidence, collected while re-entry was unrestricted. Retained in full and " +
        "never rewritten, but excluded from every current statistic, gate, interval, ranking, " +
        "blocker, lifecycle and horizon above.",
    },
    allTime: { storeRows: allRows.length },
    note:
      "Only policy-v2 rows opened at or after the cutover whose FULL hold horizon has elapsed may " +
      "inform a verdict. A stop sits nearer than a target, so an expectancy taken before maturity " +
      "measures which barrier was closer, not whether the rule has edge.",
  };

  const lifecycleCounts = withRecommendation.reduce<Record<CandidateLifecycle, number>>(
    (acc, c) => { acc[c.lifecycle] += 1; return acc; },
    { DORMANT: 0, OPEN: 0, COLLECTING: 0, REJECTED: 0, CANDIDATE: 0, RECOMMENDED_FOR_3102_REVIEW: 0 },
  );

  return {
    version: LIVE_EDGE_DIGGER_VERSION,
    generatedAt: input.generatedAt,
    reportOnly: true,
    liveBlocked: true,
    scanner: input.scanner,
    coverage: input.coverage
      ? {
          ...input.coverage,
          coverageNote:
            input.coverage.canonicalUniverseSize !== null && input.coverage.scannedSymbols !== null
              ? `Searched ${input.coverage.scannedSymbols} of ${input.coverage.canonicalUniverseSize} ` +
                `universe symbols (${input.coverage.excludedSymbols ?? 0} excluded). Findings describe ` +
                "the scanned subset only — this is NOT full-universe coverage."
              : "Coverage accounting not yet recorded by a completed cycle.",
        }
      : null,
    generation: {
      generatedRuleCount: generatedRules.length,
      rules: generatedRules.map((g) => ({
        candidateId: g.candidateId,
        ruleId: g.rule.ruleId,
        title: g.rule.title,
        thesis: g.rule.thesis,
        generatedAt: g.generatedAt,
        originCycleId: g.originCycleId,
        originObservation: g.originObservation,
      })),
      suppressed: input.suppressedProposals ?? [],
      caps: {
        perCycle: MAX_GENERATED_PER_CYCLE,
        perDay: MAX_GENERATED_PER_DAY,
        totalActive: MAX_ACTIVE_GENERATED,
        maxPredicates: MAX_GENERATED_PREDICATES,
      },
      note:
        "Generated from decision-time market structure only — no resolved outcome, MFE/MAE, realized " +
        "cost or future candle is reachable from the generator. Each is frozen by content hash at " +
        "first evaluation, before it can emit a single observation, and counts toward the same " +
        "multiple-testing denominator as the seed rules.",
    },
    attemptRegistry: input.attempts,
    rulesEnumerated: frontier.length,
    seedRuleCount: EDGE_RULE_FRONTIER.length,
    candidates: withRecommendation,
    lifecycleCounts,
    bestCandidateId: best?.candidate.candidateId ?? null,
    recommendation: best
      ? `Bounded 3102 (testnet) experiment for ${best.candidate.candidateId} — HUMAN REVIEW REQUIRED. ` +
        "This engine cannot enable it; campaigns stay OFF until an operator acts."
      : null,
    collection,
    // CENSORED is specifically the state where outcomes EXIST but none may be judged — the shape
    // that produced "-1.03R across the board" from rows that had only measured which barrier was
    // nearer. An empty book is not censored (nothing was withheld), so it keeps the plain
    // "nothing proven yet" headline; saying CENSORED there would imply suppressed evidence.
    verdict: best
      ? "CANDIDATE_READY_FOR_HUMAN_REVIEW"
      : collection.current.judgeable === 0 && collection.current.resolved > 0
        ? "CENSORED_NO_MATURED_FORWARD_EVIDENCE"
        : "NO_PROVEN_EDGE_YET",
    notes: [
      `Frontier is fixed at ${frontier.length} rules; every one is forward-tested and reported, ` +
        "including those that never fired. Rules are never selected or dropped by their outcomes.",
      "Evidence is counted in independent episodes (shared cycleId = one market look), using the " +
        "canonical countIndependentEpisodes rule imported from current-guard-variant-matrix.ts.",
      "Ranking uses the clustered bootstrap lower bound, never headline PnL.",
      "Resolution is intrabar-conservative: a bar containing both stop and target pays the stop.",
      "Costs charged: taker round-trip, stop slippage, and funding per elapsed 8h settlement.",
    ],
  };
}

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
  readonly decision: "CANDIDATE" | "REJECT";
  readonly rejectionReasons: readonly string[];
  readonly evidenceStillNeeded: readonly string[];
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

export function buildCandidateReport(
  candidate: FrozenCandidate,
  allRows: readonly ShadowObservation[],
): CandidateReport {
  const rows = allRows.filter((r) => r.candidateId === candidate.candidateId);
  const resolved = rows.filter((r) => r.status !== "OPEN" && typeof r.netR === "number");
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

  const rejectionReasons: string[] = [];
  if (resolved.length === 0) rejectionReasons.push("no resolved forward evidence yet");
  if (metrics.netExpectancyR !== null && metrics.netExpectancyR <= 0) {
    rejectionReasons.push(`after-cost expectancy ${metrics.netExpectancyR.toFixed(4)}R <= 0`);
  }
  if (metrics.pf !== null && metrics.pf <= PF_FLOOR) {
    rejectionReasons.push(`PF ${metrics.pf.toFixed(3)} <= ${PF_FLOOR}`);
  }
  if (bootstrap.lowerBound95 !== null && bootstrap.lowerBound95 <= 0) {
    rejectionReasons.push(`clustered 95% lower bound ${bootstrap.lowerBound95.toFixed(4)}R <= 0`);
  }
  if (bootstrap.lowerBound95 === null && resolved.length > 0) {
    rejectionReasons.push(`clustered interval undefined (${bootstrap.clusters} independent episode(s))`);
  }
  if (topSymbolShare !== null && topSymbolShare > MAX_TOP_SYMBOL_SHARE) {
    rejectionReasons.push(`concentration: top-symbol share ${topSymbolShare} > ${MAX_TOP_SYMBOL_SHARE}`);
  }
  // Split instability: DEV and VALIDATION disagreeing in SIGN means the result is regime-specific,
  // not an edge. Only meaningful once both sides actually have evidence.
  if (dev.netExpectancyR !== null && val.netExpectancyR !== null &&
      Math.sign(dev.netExpectancyR) !== Math.sign(val.netExpectancyR)) {
    rejectionReasons.push("unstable splits: DEV and validation/OOS expectancy disagree in sign");
  }
  if (comparisons[0]!.beatsCandidate) rejectionReasons.push("NO_TRADE (flat) beats the candidate after cost");
  // Evidence gathered under a rule that cannot be shown to have been frozen first is not forward
  // evidence at all, however good it looks. This is checked BEFORE the numeric gates matter.
  const freezeIntegrity = checkFreezeIntegrity(candidate, rows);
  if (!freezeIntegrity.ok) rejectionReasons.push(`freeze integrity: ${freezeIntegrity.note}`);
  for (const g of gates) {
    if (!g.pass) {
      rejectionReasons.push(
        `gate ${g.id}: ${g.current === null ? "not computable" : `${g.current} ${g.comparator === "<=" ? ">" : "<"} ${g.required}`}`,
      );
    }
  }

  const evidenceStillNeeded: string[] = [];
  if (dev.episodes < STABLE_MIN_EFFECTIVE_N) {
    evidenceStillNeeded.push(`${STABLE_MIN_EFFECTIVE_N - dev.episodes} more independent DEV episodes (have ${dev.episodes})`);
  }
  if (val.episodes < STABLE_MIN_HOLDOUT_EFFECTIVE_N) {
    evidenceStillNeeded.push(`${STABLE_MIN_HOLDOUT_EFFECTIVE_N - val.episodes} more validation/OOS episodes (have ${val.episodes})`);
  }
  if (recent.episodes < PROMOTION_MIN_HOLDOUT_EFFECTIVE_N) {
    evidenceStillNeeded.push(`${PROMOTION_MIN_HOLDOUT_EFFECTIVE_N - recent.episodes} more recent episodes (have ${recent.episodes})`);
  }
  if (rows.length > 0 && resolved.length < rows.length) {
    evidenceStillNeeded.push(`${rows.length - resolved.length} shadow position(s) still open — outcomes not yet knowable`);
  }

  return {
    candidate,
    rawRows: rows.length,
    openRows: rows.length - resolved.length,
    resolvedRows: resolved.length,
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
    decision: rejectionReasons.length === 0 ? "CANDIDATE" : "REJECT",
    rejectionReasons,
    evidenceStillNeeded,
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
  /** Multiple-testing control: EVERY rule ever enumerated, fired or not. */
  readonly attemptRegistry: readonly AttemptRegistryEntry[];
  readonly rulesEnumerated: number;
  readonly candidates: readonly CandidateReport[];
  readonly bestCandidateId: string | null;
  /** null until a candidate passes every canonical gate. */
  readonly recommendation: string | null;
  readonly verdict: "NO_PROVEN_EDGE_YET" | "CANDIDATE_READY_FOR_HUMAN_REVIEW";
  readonly notes: readonly string[];
}

export function buildLiveEdgeDiggerReport(input: {
  generatedAt: string;
  observations: readonly ShadowObservation[];
  attempts: readonly AttemptRegistryEntry[];
  scanner: LiveEdgeDiggerReport["scanner"];
  frontier?: readonly EdgeRule[];
}): LiveEdgeDiggerReport {
  const frontier = input.frontier ?? EDGE_RULE_FRONTIER;
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
      return buildCandidateReport(freezeCandidate(rule, frozenAt, 1, source), input.observations);
    })
    // Report every rule, including ones with zero evidence — a rule that never fired is itself a
    // finding, and hiding it would understate the number of tests run.
    .sort((a, b) => b.independentEpisodes - a.independentEpisodes);

  const passing = candidates.filter((c) => c.decision === "CANDIDATE");
  // Ranking is by ROBUST FORWARD EVIDENCE — the clustered lower bound, not headline PnL. A high mean
  // on two correlated episodes must never outrank a modest mean on many independent ones.
  const ranked = passing.slice().sort((a, b) => {
    const av = a.bootstrap.lowerBound95 ?? -Infinity;
    const bv = b.bootstrap.lowerBound95 ?? -Infinity;
    return bv - av;
  });
  const best = ranked[0] ?? null;

  return {
    version: LIVE_EDGE_DIGGER_VERSION,
    generatedAt: input.generatedAt,
    reportOnly: true,
    liveBlocked: true,
    scanner: input.scanner,
    attemptRegistry: input.attempts,
    rulesEnumerated: frontier.length,
    candidates,
    bestCandidateId: best?.candidate.candidateId ?? null,
    recommendation: best
      ? `Bounded 3102 (testnet) experiment for ${best.candidate.candidateId} — HUMAN REVIEW REQUIRED. ` +
        "This engine cannot enable it; campaigns stay OFF until an operator acts."
      : null,
    verdict: best ? "CANDIDATE_READY_FOR_HUMAN_REVIEW" : "NO_PROVEN_EDGE_YET",
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

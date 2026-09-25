import { partitionIndependentEpisodes, type EpisodeIdentityRow } from "../lib/current-guard-variant-matrix.js";
import { tournamentHash } from "./contract/tournament-contract.js";
import type {
  TournamentEpisodeAssignment,
  TournamentEpisodeLedger,
  TournamentEpisodePolicy,
  TournamentRunResult,
  TournamentTrade,
} from "./tournament-types.js";

const CANONICAL_ALGORITHM = "KRONOS_EPISODE_ACCUMULATOR_V1" as const;
const CANONICAL_ALGORITHM_VERSION = "current-guard-episode-accumulator-v1" as const;
const CANONICAL_POLICY_VERSION = "tournament-post-trade-episode-v1" as const;
const DEFAULT_BLOCK_WIDTH_BARS = 48;

/**
 * Tier-1's canonical policy is a fixed, versioned width over actual trade
 * openings. It is not a wall-clock bucket: the underlying accumulator chains
 * from each component's first trade and then applies merge-only cause/batch
 * evidence exactly as current Kronos does.
 */
export function canonicalPostTradeEpisodePolicy(timeframeMs: number): TournamentEpisodePolicy {
  if (!Number.isInteger(timeframeMs) || timeframeMs <= 0 || !Number.isSafeInteger(timeframeMs * DEFAULT_BLOCK_WIDTH_BARS)) throw new Error("TOURNAMENT_POST_TRADE_EPISODE_TIMEFRAME_INVALID");
  return Object.freeze({
    algorithm: CANONICAL_ALGORITHM,
    algorithmVersion: CANONICAL_ALGORITHM_VERSION,
    policyVersion: CANONICAL_POLICY_VERSION,
    blockWidthMs: timeframeMs * DEFAULT_BLOCK_WIDTH_BARS,
  });
}

function optionalIdentity(value: string | null | undefined, sourceHash: string | null | undefined, name: string): { value: string | null; sourceHash: string | null } {
  const normalizedValue = typeof value === "string" && value.trim() ? value : null;
  const normalizedHash = typeof sourceHash === "string" && sourceHash.trim() ? sourceHash : null;
  if ((normalizedValue === null) !== (normalizedHash === null)) throw new Error(`TOURNAMENT_POST_TRADE_EPISODE_${name}_PROVENANCE_INCOMPLETE`);
  return { value: normalizedValue, sourceHash: normalizedHash };
}

interface CanonicalTradeIdentity {
  decisionTimeMs: number;
  entryTimeMs: number;
  canonicalCycleId: string | null;
  canonicalCycleSourceHash: string | null;
  persistedMarketCauseId: string | null;
  persistedMarketCauseSourceHash: string | null;
}

function identityForTrade(trade: TournamentTrade): CanonicalTradeIdentity {
  if (!Number.isInteger(trade.decisionTimeMs) || !Number.isInteger(trade.entryTimeMs) || trade.decisionTimeMs < 0 || trade.entryTimeMs <= trade.decisionTimeMs) throw new Error(`TOURNAMENT_POST_TRADE_EPISODE_CLOCK_INVALID_${trade.tradeId}`);
  const cycle = optionalIdentity(trade.canonicalCycleId, trade.canonicalCycleSourceHash, "CYCLE");
  const cause = optionalIdentity(trade.persistedMarketCauseId, trade.persistedMarketCauseSourceHash, "MARKET_CAUSE");
  return {
    decisionTimeMs: trade.decisionTimeMs,
    entryTimeMs: trade.entryTimeMs,
    canonicalCycleId: cycle.value,
    canonicalCycleSourceHash: cycle.sourceHash,
    persistedMarketCauseId: cause.value,
    persistedMarketCauseSourceHash: cause.sourceHash,
  };
}

function orderIdentity(a: CanonicalTradeIdentity, b: CanonicalTradeIdentity): number {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

/**
 * Assigns durable episode IDs only after generated trades exist. Strategy,
 * symbol, side, prices, PnL and outcomes are deliberately absent from the
 * durable-ID input. `tradeId` only binds an assignment back to a ledger row.
 */
export function assignCanonicalPostTradeEpisodes(input: {
  trades: readonly TournamentTrade[];
  policy: TournamentEpisodePolicy;
}): TournamentEpisodeLedger {
  const policy = input.policy;
  if (policy.algorithm !== CANONICAL_ALGORITHM || policy.algorithmVersion !== CANONICAL_ALGORITHM_VERSION || policy.policyVersion !== CANONICAL_POLICY_VERSION || !Number.isInteger(policy.blockWidthMs) || policy.blockWidthMs <= 0) throw new Error("TOURNAMENT_POST_TRADE_EPISODE_POLICY_INVALID");
  const trades = input.trades.slice().sort((a, b) => a.tradeId.localeCompare(b.tradeId));
  const ids = new Set<string>();
  const identities = new Map<string, CanonicalTradeIdentity>();
  const rows: EpisodeIdentityRow[] = [];
  for (const trade of trades) {
    if (!trade.tradeId || ids.has(trade.tradeId)) throw new Error("TOURNAMENT_POST_TRADE_EPISODE_TRADE_ID_INVALID");
    ids.add(trade.tradeId);
    const identity = identityForTrade(trade); identities.set(trade.tradeId, identity);
    rows.push({
      episodeMs: identity.entryTimeMs,
      observationId: trade.tradeId,
      batchId: identity.canonicalCycleId,
      episodeId: identity.persistedMarketCauseId,
    });
  }
  const inputHash = tournamentHash({
    policy,
    bindings: trades.map((trade) => ({ tradeId: trade.tradeId, identity: identities.get(trade.tradeId)! })),
  });
  const rootByTradeId = partitionIndependentEpisodes(rows, policy.blockWidthMs);
  const identitiesByRoot = new Map<number, CanonicalTradeIdentity[]>();
  for (const trade of trades) {
    const root = rootByTradeId.get(trade.tradeId);
    if (root === undefined) throw new Error(`TOURNAMENT_POST_TRADE_EPISODE_ASSIGNMENT_MISSING_${trade.tradeId}`);
    identitiesByRoot.set(root, [...(identitiesByRoot.get(root) ?? []), identities.get(trade.tradeId)!]);
  }
  const episodeIdByRoot = new Map<number, string>();
  for (const [root, identitiesForRoot] of identitiesByRoot) {
    const canonicalInputs = [...new Map(identitiesForRoot.sort(orderIdentity).map((identity) => [JSON.stringify(identity), identity])).values()];
    episodeIdByRoot.set(root, `kronos-episode-${tournamentHash({ policy, canonicalInputs }).slice(0, 32)}`);
  }
  const assignments: TournamentEpisodeAssignment[] = trades.map((trade) => {
    const identity = identities.get(trade.tradeId)!; const root = rootByTradeId.get(trade.tradeId)!;
    return Object.freeze({ tradeId: trade.tradeId, episodeId: episodeIdByRoot.get(root)!, ...identity });
  });
  const outputHash = tournamentHash({ policy, inputHash, assignments });
  return Object.freeze({ policy: Object.freeze({ ...policy }), inputHash, outputHash, assignments: Object.freeze(assignments) });
}

function withEpisodeMetrics(run: TournamentRunResult, trades: TournamentTrade[], canonicalEpisodeProvenanceComplete: boolean): TournamentRunResult {
  const independentEpisodes = canonicalEpisodeProvenanceComplete ? new Set(trades.map((trade) => trade.marketEpisodeId)).size : 0;
  const metrics = { ...run.strategyMetrics, independentEpisodes, canonicalEpisodeProvenanceComplete };
  return { ...run, trades, strategyMetrics: metrics, metrics: { ...metrics } };
}

/** Applies a verified ledger atomically to exactly the trade set it hashed. */
export function applyCanonicalPostTradeEpisodeLedger(input: { run: TournamentRunResult; ledger: TournamentEpisodeLedger }): TournamentRunResult {
  const expected = assignCanonicalPostTradeEpisodes({ trades: input.run.trades, policy: input.ledger.policy });
  if (expected.inputHash !== input.ledger.inputHash || expected.outputHash !== input.ledger.outputHash || JSON.stringify(expected.assignments) !== JSON.stringify(input.ledger.assignments)) throw new Error("TOURNAMENT_POST_TRADE_EPISODE_LEDGER_MISMATCH");
  const assignmentByTradeId = new Map(input.ledger.assignments.map((assignment) => [assignment.tradeId, assignment]));
  const trades = input.run.trades.map((trade) => {
    const assignment = assignmentByTradeId.get(trade.tradeId);
    if (!assignment) throw new Error(`TOURNAMENT_POST_TRADE_EPISODE_ASSIGNMENT_MISSING_${trade.tradeId}`);
    return { ...trade, marketEpisodeId: assignment.episodeId };
  });
  return { ...withEpisodeMetrics(input.run, trades, true), episodeLedger: input.ledger };
}

/** A matrix assigns each strategy's actual trade cohort with the same canonical policy. */
export function attachCanonicalPostTradeEpisodes(input: { runs: readonly TournamentRunResult[]; policy: TournamentEpisodePolicy }): TournamentRunResult[] {
  return input.runs.map((run) => applyCanonicalPostTradeEpisodeLedger({ run, ledger: assignCanonicalPostTradeEpisodes({ trades: run.trades, policy: input.policy }) }));
}

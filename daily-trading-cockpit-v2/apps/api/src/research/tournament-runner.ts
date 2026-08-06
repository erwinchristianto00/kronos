import { buildRunManifest, tournamentHash } from "./contract/tournament-contract.js";
import { runTournament, type TournamentExecutionInput } from "./execution/shared-executor.js";
import type { TournamentCandle, TournamentExecutionMode, TournamentExperimentSpec, TournamentRunResult, TournamentStrategyId } from "./tournament-types.js";
import type { TournamentStrategy } from "./strategies/challengers.js";
import { assertNoValidationLeakage, buildWalkForwardPlan, type WalkForwardFold } from "./validation/walk-forward.js";
import { assessCostSensitivity, summarizeOosWindows, type CostSensitivityFinding, type OosSummary } from "./reporting/oos.js";
import { attachCanonicalPostTradeEpisodes, canonicalPostTradeEpisodePolicy } from "./post-trade-episodes.js";
import type { TournamentEpisodePolicy } from "./tournament-types.js";

export interface TournamentMatrixInput {
  spec: TournamentExperimentSpec;
  strategies: readonly TournamentStrategy[];
  execution: Omit<TournamentExecutionInput, "manifest" | "strategy">;
  /** Explicitly supplied archival timestamp; never obtain wall-clock state. */
  createdAtMs: number;
  modes?: readonly TournamentExecutionMode[];
  /** Bound by Tier1Assembly for empirical runs; generic research gets the canonical timeframe policy. */
  postTradeEpisodePolicy?: TournamentEpisodePolicy;
}

export interface TournamentMatrixResult {
  fairnessHashByMode: ReadonlyMap<TournamentExecutionMode, string>;
  runs: TournamentRunResult[];
  costSensitivity: CostSensitivityFinding[];
}

function immutableCandles(candles: readonly TournamentCandle[]): readonly TournamentCandle[] {
  return Object.freeze(candles.map((candle) => Object.freeze({ ...candle })));
}

/**
 * The single entry point for an apples-to-apples tournament matrix. Every
 * challenger shares exact candles, point-in-time universe, shared wallet,
 * execution adapters, risk caps and archival timestamp.
 */
export function runTournamentMatrix(input: TournamentMatrixInput): TournamentMatrixResult {
  const modes = input.modes ?? (input.spec.capabilityTier === "TIER_1_BASELINE" ? ["CONSERVATIVE"] : ["CONSERVATIVE", "EXPECTED", "OPTIMISTIC"] as const);
  if (new Set(input.strategies.map((strategy) => strategy.id)).size !== input.strategies.length) throw new Error("TOURNAMENT_DUPLICATE_STRATEGY_ID");
  const fairnessHashByMode = new Map<TournamentExecutionMode, string>();
  const runs: TournamentRunResult[] = [];
  // A strategy that tries to mutate an input fails rather than contaminating a
  // later challenger in the same tournament matrix.
  const candles = immutableCandles(input.execution.candles);
  for (const mode of modes) {
    fairnessHashByMode.set(mode, tournamentHash({
      dataset: input.spec.dataset,
      costs: input.spec.costs,
      portfolio: input.spec.portfolio,
      validation: input.spec.validation,
      executionMode: mode,
    }));
    for (const strategy of input.strategies) {
      const manifest = buildRunManifest({ spec: input.spec, strategyId: strategy.id, executionMode: mode, parameterSet: strategy.parameters, createdAtMs: input.createdAtMs });
      runs.push(runTournament({ ...input.execution, candles, manifest, strategy }));
    }
  }
  const episodeRuns = attachCanonicalPostTradeEpisodes({ runs, policy: input.postTradeEpisodePolicy ?? canonicalPostTradeEpisodePolicy(input.spec.dataset.timeframeMs) });
  return { fairnessHashByMode, runs: episodeRuns, costSensitivity: assessCostSensitivity(episodeRuns) };
}

export interface WalkForwardTournamentInput {
  spec: TournamentExperimentSpec;
  candles: readonly TournamentCandle[];
  /** The tuner receives training data only. It never sees test/purge/embargo/holdout. */
  chooseParameters: (input: { fold: WalkForwardFold; trainCandles: readonly TournamentCandle[] }) => {
    parameters: Record<string, string | number | boolean>;
    /** Persisted training metric; it is never calculated from the OOS slice. */
    inSampleExpectancyAfterCost: number;
  };
  buildStrategy: (parameters: Record<string, string | number | boolean>) => TournamentStrategy;
  execution: Omit<TournamentExecutionInput, "manifest" | "strategy" | "candles">;
  createdAtMs: number;
  executionMode: Exclude<TournamentExecutionMode, "OPTIMISTIC">;
  postTradeEpisodePolicy?: TournamentEpisodePolicy;
}

export interface WalkForwardTournamentResult {
  folds: Array<{ foldId: string; strategyId: TournamentStrategyId; parameters: Record<string, string | number | boolean>; inSampleExpectancyAfterCost: number; result: TournamentRunResult }>;
  oosSummary: OosSummary;
}

/** Runs only out-of-sample tests selected from prior training windows; the sealed holdout is untouched. */
export function runWalkForwardTournament(input: WalkForwardTournamentInput): WalkForwardTournamentResult {
  const timestamps = [...new Set(input.candles.map((candle) => candle.openTimeMs))].sort((a, b) => a - b);
  const plan = buildWalkForwardPlan(timestamps, input.spec.validation);
  assertNoValidationLeakage(plan);
  const results: WalkForwardTournamentResult["folds"] = [];
  for (const fold of plan.folds) {
    const trainTimes = new Set(timestamps.slice(fold.train.startIndex, fold.train.endExclusive));
    const testTimes = new Set(timestamps.slice(fold.test.startIndex, fold.test.endExclusive));
    const selection = input.chooseParameters({ fold, trainCandles: input.candles.filter((candle) => trainTimes.has(candle.openTimeMs)) });
    const strategy = input.buildStrategy(selection.parameters);
    const manifest = buildRunManifest({
      spec: { ...input.spec, parameters: { ...input.spec.parameters, ...selection.parameters, foldId: fold.foldId } },
      strategyId: strategy.id,
      executionMode: input.executionMode,
      parameterSet: selection.parameters,
      createdAtMs: input.createdAtMs,
    });
    const raw = runTournament({ ...input.execution, candles: input.candles.filter((candle) => testTimes.has(candle.openTimeMs)), manifest, strategy });
    const [result] = attachCanonicalPostTradeEpisodes({ runs: [raw], policy: input.postTradeEpisodePolicy ?? canonicalPostTradeEpisodePolicy(input.spec.dataset.timeframeMs) });
    results.push({ foldId: fold.foldId, strategyId: strategy.id, parameters: selection.parameters, inSampleExpectancyAfterCost: selection.inSampleExpectancyAfterCost, result: result! });
  }
  return { folds: results, oosSummary: summarizeOosWindows(results.map((fold) => ({ foldId: fold.foldId, inSampleExpectancyAfterCost: fold.inSampleExpectancyAfterCost, result: fold.result }))) };
}

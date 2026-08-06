import { createHash } from "node:crypto";

import {
  TOURNAMENT_VERSION,
  type TournamentDatasetManifest,
  type TournamentExperimentSpec,
  type TournamentExecutionMode,
  type TournamentHardGateVerdict,
  type TournamentMetrics,
  type TournamentRunManifest,
  type TournamentRunRegistryEntry,
  type TournamentStrategyId,
} from "../tournament-types.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function tournamentHash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function assertValidTournamentDataset(dataset: TournamentDatasetManifest): void {
  if (!dataset.candlesHash || !dataset.executionInputsHash || !dataset.historicalUniverseHash) {
    throw new Error("TOURNAMENT_DATASET_HASH_MISSING");
  }
  if (dataset.dataRange.startMs >= dataset.dataRange.endMs) throw new Error("TOURNAMENT_DATA_RANGE_INVALID");
  if (dataset.universeSnapshots.length === 0) throw new Error("TOURNAMENT_POINT_IN_TIME_UNIVERSE_MISSING");
  let prior = -Infinity;
  for (const snapshot of dataset.universeSnapshots) {
    if (snapshot.asOfMs < prior) throw new Error("TOURNAMENT_UNIVERSE_SNAPSHOTS_NOT_MONOTONIC");
    prior = snapshot.asOfMs;
    if (!snapshot.sourceHash || snapshot.eligibleSymbols.length === 0) {
      throw new Error("TOURNAMENT_UNIVERSE_SNAPSHOT_INCOMPLETE");
    }
    if (!Object.values(snapshot.evidence).every(Boolean)) {
      throw new Error("TOURNAMENT_UNIVERSE_SURVIVORSHIP_EVIDENCE_INCOMPLETE");
    }
  }
}

export function assertValidTournamentSpec(spec: TournamentExperimentSpec): void {
  if (spec.tournamentVersion !== TOURNAMENT_VERSION) throw new Error("TOURNAMENT_VERSION_MISMATCH");
  if (!spec.gitCommit || !spec.strategyVersion) throw new Error("TOURNAMENT_PROVENANCE_MISSING");
  assertValidTournamentDataset(spec.dataset);
  if (spec.portfolio.startingCapital <= 0 || spec.portfolio.riskPerTradeFraction <= 0) {
    throw new Error("TOURNAMENT_PORTFOLIO_RISK_INVALID");
  }
  if (spec.portfolio.liquidationBufferFraction < 0 || spec.portfolio.liquidationBufferFraction >= 1
    || spec.portfolio.maxPositions < 1
    || spec.portfolio.maxGrossExposureFraction <= 0
    || spec.portfolio.maxNetExposureFraction <= 0
    || spec.portfolio.maxBtcBetaFraction <= 0
    || spec.portfolio.maxCorrelationClusterFraction <= 0) {
    throw new Error("TOURNAMENT_PORTFOLIO_CONSTRAINTS_INVALID");
  }
  if (spec.validation.purgeBars < 0 || spec.validation.embargoBars < 0 || spec.validation.sealedHoldoutStartMs <= 0) {
    throw new Error("TOURNAMENT_VALIDATION_SPEC_INVALID");
  }
}

export function buildRunManifest(input: {
  spec: TournamentExperimentSpec;
  strategyId: TournamentStrategyId;
  executionMode: TournamentExecutionMode;
  parameterSet: Record<string, unknown>;
  /** Must be supplied by the caller; never use Date.now in reproducible runs. */
  createdAtMs: number;
}): TournamentRunManifest {
  assertValidTournamentSpec(input.spec);
  const inputHash = tournamentHash({
    spec: input.spec,
    strategyId: input.strategyId,
    executionMode: input.executionMode,
    parameterSet: input.parameterSet,
  });
  return {
    runId: `krtv1-${inputHash.slice(0, 20)}`,
    createdAtMs: input.createdAtMs,
    spec: input.spec,
    strategyId: input.strategyId,
    executionMode: input.executionMode,
    parameterSet: structuredClone(input.parameterSet),
    inputHash,
  };
}

/** Registry intentionally receives every attempted parameter set, including failures. */
export function registryEntry(manifest: TournamentRunManifest, valid: boolean): TournamentRunRegistryEntry {
  return {
    runId: manifest.runId,
    inputHash: manifest.inputHash,
    strategyId: manifest.strategyId,
    executionMode: manifest.executionMode,
    parameterSet: structuredClone(manifest.parameterSet),
    valid,
    createdAtMs: manifest.createdAtMs,
  };
}

export function hardGate(metrics: TournamentMetrics, input: {
  minIndependentEpisodes: number;
  minProfitFactor: number;
  maxDrawdown: number;
  minProfitableAssetRatio: number;
  conservativePass: boolean;
  stablePlateau: boolean;
  sealedHoldoutPass: boolean;
  maxTopSymbolNetPnlShare: number;
  maxTopRegimeNetPnlShare: number;
  maxTopYearNetPnlShare: number;
}): TournamentHardGateVerdict {
  const failures: string[] = [];
  if (metrics.expectancyAfterCost <= 0) failures.push("OOS_EXPECTANCY_NON_POSITIVE");
  if (metrics.independentEpisodes < input.minIndependentEpisodes) failures.push("INDEPENDENT_EVIDENCE_INSUFFICIENT");
  if (metrics.profitFactor === null || metrics.profitFactor < input.minProfitFactor) failures.push("PROFIT_FACTOR_INSUFFICIENT");
  if (metrics.maxDrawdown > input.maxDrawdown) failures.push("DRAWDOWN_EXCESSIVE");
  if (metrics.profitableAssetRatio === null || metrics.profitableAssetRatio < input.minProfitableAssetRatio) failures.push("CROSS_ASSET_BREADTH_INSUFFICIENT");
  if (!input.conservativePass) failures.push("CONSERVATIVE_EXECUTION_FAIL");
  if (!input.stablePlateau) failures.push("ISOLATED_PARAMETER_PEAK");
  if (!input.sealedHoldoutPass) failures.push("SEALED_HOLDOUT_FAIL");
  if (metrics.concentration.topSymbolNetPnlShare === null || metrics.concentration.topSymbolNetPnlShare > input.maxTopSymbolNetPnlShare) failures.push("SYMBOL_CONCENTRATION_EXCESSIVE");
  if (metrics.concentration.topRegimeNetPnlShare === null || metrics.concentration.topRegimeNetPnlShare > input.maxTopRegimeNetPnlShare) failures.push("REGIME_CONCENTRATION_EXCESSIVE");
  if (metrics.concentration.topYearNetPnlShare === null || metrics.concentration.topYearNetPnlShare > input.maxTopYearNetPnlShare) failures.push("YEAR_CONCENTRATION_EXCESSIVE");
  return { passes: failures.length === 0, failures };
}

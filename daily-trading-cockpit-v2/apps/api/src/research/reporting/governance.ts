import { hardGate } from "../contract/tournament-contract.js";
import type { TournamentHardGateVerdict, TournamentMetrics, TournamentResearchMode, TournamentStrategyId } from "../tournament-types.js";

export interface SensitivityPoint {
  parameters: Record<string, string | number | boolean>;
  oosExpectancy: number;
  conservativePass: boolean;
  profitableWindowFraction: number;
  crossAssetRatio: number | null;
}

export interface SensitivityAssessment {
  attemptedSets: number;
  positiveSets: number;
  stableNeighbourFraction: number;
  isolatedPeak: boolean;
  plateauPass: boolean;
}

function distance(a: Record<string, string | number | boolean>, b: Record<string, string | number | boolean>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]).length;
}

/** A winning point needs positive one-parameter neighbours; a single peak never passes. */
export function assessParameterPlateau(points: readonly SensitivityPoint[], selected: Record<string, string | number | boolean>): SensitivityAssessment {
  if (points.length === 0) return { attemptedSets: 0, positiveSets: 0, stableNeighbourFraction: 0, isolatedPeak: true, plateauPass: false };
  const selectedPoint = points.find((point) => JSON.stringify(point.parameters) === JSON.stringify(selected));
  const neighbours = points.filter((point) => distance(point.parameters, selected) === 1);
  const stable = neighbours.filter((point) => point.oosExpectancy > 0 && point.conservativePass && point.profitableWindowFraction >= 0.5 && (point.crossAssetRatio ?? 0) >= 0.5);
  const fraction = neighbours.length ? stable.length / neighbours.length : 0;
  return { attemptedSets: points.length, positiveSets: points.filter((point) => point.oosExpectancy > 0).length, stableNeighbourFraction: fraction, isolatedPeak: selectedPoint?.oosExpectancy !== undefined && selectedPoint.oosExpectancy > 0 && stable.length === 0, plateauPass: neighbours.length > 0 && fraction >= 0.6 };
}

export interface RankedTournamentCandidate {
  strategyId: TournamentStrategyId;
  metrics: TournamentMetrics;
  hardGate: TournamentHardGateVerdict;
  rankScore: number | null;
  rankComponents: Record<string, number>;
}

function percentile(value: number, population: number[]): number {
  const sorted = [...population].sort((a, b) => a - b);
  if (sorted.length <= 1) return 1;
  return sorted.filter((candidate) => candidate <= value).length / sorted.length;
}

/** Gates first; percentile components are used only to rank survivors. */
export function rankTournamentCandidates(input: Array<{
  strategyId: TournamentStrategyId;
  metrics: TournamentMetrics;
  researchMode: TournamentResearchMode;
  conservativePass: boolean;
  plateauPass: boolean;
  sealedHoldoutPass: boolean;
}>): RankedTournamentCandidate[] {
  if (input.some((candidate) => candidate.researchMode !== "REAL_TIER1")) throw new Error("TOURNAMENT_FIXTURE_RANKING_FORBIDDEN");
  const candidates = input.map((candidate) => ({ ...candidate, hardGate: hardGate(candidate.metrics, {
    minIndependentEpisodes: 30,
    minProfitFactor: 1.05,
    maxDrawdown: 0.25,
    minProfitableAssetRatio: 0.5,
    conservativePass: candidate.conservativePass,
    stablePlateau: candidate.plateauPass,
    sealedHoldoutPass: candidate.sealedHoldoutPass,
    maxTopSymbolNetPnlShare: 0.6,
    maxTopRegimeNetPnlShare: 0.7,
    maxTopYearNetPnlShare: 0.8,
  }) }));
  const survivors = candidates.filter((candidate) => candidate.hardGate.passes);
  const populations = {
    expectancy: survivors.map((candidate) => candidate.metrics.expectancyAfterCost),
    sharpe: survivors.map((candidate) => candidate.metrics.sharpe ?? -Infinity),
    calmar: survivors.map((candidate) => candidate.metrics.calmar ?? -Infinity),
    breadth: survivors.map((candidate) => candidate.metrics.profitableAssetRatio ?? 0),
    robustness: survivors.map((candidate) => candidate.metrics.independentEpisodes),
  };
  return candidates.map((candidate) => {
    if (!candidate.hardGate.passes) return { strategyId: candidate.strategyId, metrics: candidate.metrics, hardGate: candidate.hardGate, rankScore: null, rankComponents: {} };
    const rankComponents = {
      returnQuality: percentile(candidate.metrics.expectancyAfterCost, populations.expectancy),
      sharpe: percentile(candidate.metrics.sharpe ?? -Infinity, populations.sharpe),
      calmar: percentile(candidate.metrics.calmar ?? -Infinity, populations.calmar),
      crossAssetBreadth: percentile(candidate.metrics.profitableAssetRatio ?? 0, populations.breadth),
      evidenceRobustness: percentile(candidate.metrics.independentEpisodes, populations.robustness),
    };
    const rankScore = Object.values(rankComponents).reduce((sum, value) => sum + value, 0) / Object.keys(rankComponents).length;
    return { strategyId: candidate.strategyId, metrics: candidate.metrics, hardGate: candidate.hardGate, rankScore, rankComponents };
  }).sort((a, b) => (b.rankScore ?? -Infinity) - (a.rankScore ?? -Infinity));
}

/** Multiple-testing context, not a substitute for a full statistical proof. */
export function deflatedSharpeContext(input: { observedSharpe: number | null; independentEpisodes: number; attemptedParameterSets: number }): { observedSharpe: number | null; expectedMaximumUnderNull: number | null; adjustedExcess: number | null } {
  if (input.observedSharpe === null || input.independentEpisodes < 2 || input.attemptedParameterSets < 1) return { observedSharpe: input.observedSharpe, expectedMaximumUnderNull: null, adjustedExcess: null };
  // Blom approximation for the maximum of N standard-normal trials.
  const trials = Math.max(1, input.attemptedParameterSets);
  const p = (trials - 0.375) / (trials + 0.25);
  const z = Math.sqrt(2) * inverseErf(2 * p - 1);
  const samplingScale = 1 / Math.sqrt(input.independentEpisodes);
  const expectedMaximumUnderNull = z * samplingScale;
  return { observedSharpe: input.observedSharpe, expectedMaximumUnderNull, adjustedExcess: input.observedSharpe - expectedMaximumUnderNull };
}

function inverseErf(x: number): number {
  // Winitzki approximation, sufficient for a transparent multiple-testing context label.
  const a = 0.147; const sign = x < 0 ? -1 : 1; const ln = Math.log(1 - x * x);
  return sign * Math.sqrt(Math.sqrt((2 / (Math.PI * a) + ln / 2) ** 2 - ln / a) - (2 / (Math.PI * a) + ln / 2));
}

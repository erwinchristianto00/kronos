import {
  applyDynamicMom36Preference, selectDynamicMom36Legs, dynamicMom36CombinationRank,
  type DynamicMom36Formation, type DynamicMom36Allocation, DYNAMIC_MOM36_ALLOCATION_LABELS,
} from "./dynamic-mom36-shock-strategy.js";

export type DynamicAllocationSelectionMode = "BREADTH" | "RANK_ALL_QUALIFIED" | "SKEW_FIRST_QUALIFIED";
export function dynamicAllocationSelectionMode(value: string | undefined): DynamicAllocationSelectionMode | null {
  const mode = value?.trim().toUpperCase() || "BREADTH";
  return ["BREADTH", "RANK_ALL_QUALIFIED", "SKEW_FIRST_QUALIFIED"].includes(mode)
    ? mode as DynamicAllocationSelectionMode : null;
}
export type DynamicAllocationRankingAudit = {
  policyId: "cross-allocation-qualified-ranking-v1";
  mode: Exclude<DynamicAllocationSelectionMode, "BREADTH">;
  rankingMetric: "MEAN_CANONICAL_MOM36_SIDE_RANK_SIX_EQUAL_LEGS";
  lowerRankIsBetter: true;
  baselineAllocation: DynamicMom36Allocation;
  selectedAllocation: DynamicMom36Allocation;
  outcome: "QUALIFIED_WINNER" | "NO_QUALIFIED_KEEP_BASELINE";
  candidates: Array<{
    allocation: DynamicMom36Allocation;
    baselineLongs: string[]; baselineShorts: string[];
    selectedLongs: string[]; selectedShorts: string[];
    admissionReason: string | null;
    preferenceReason: string | null;
    qualified: boolean; rank: number | null;
    basketReturn1h: number | null; basketReturn4h: number | null;
    consideredCombinations: number; qualifyingCombinations: number;
  }>;
};

/** One frozen universe, same per-leg and final-admission guards for every geometry. */
export function rankDynamicMom36Allocations(input: {
  baseline: DynamicMom36Formation;
  allowedLongCounts: readonly number[];
  maxPerCluster: number;
  mode: Exclude<DynamicAllocationSelectionMode, "BREADTH">;
  rejectionReason: (candidate: DynamicMom36Formation) => string | null;
}): { formation: DynamicMom36Formation; audit: DynamicAllocationRankingAudit } {
  const baseline = input.baseline;
  const audit: DynamicAllocationRankingAudit = {
    policyId: "cross-allocation-qualified-ranking-v1", mode: input.mode,
    rankingMetric: "MEAN_CANONICAL_MOM36_SIDE_RANK_SIX_EQUAL_LEGS", lowerRankIsBetter: true,
    baselineAllocation: baseline.requestedAllocation, selectedAllocation: baseline.finalAllocation,
    outcome: "NO_QUALIFIED_KEEP_BASELINE", candidates: [],
  };
  const winners: Array<{ formation: DynamicMom36Formation; rank: number }> = [];
  for (const longCount of [1, 2, 4, 5, 3].filter(n => input.allowedLongCounts.includes(n))) {
    const allocation: DynamicMom36Allocation = {
      longCount, shortCount: 6 - longCount, label: DYNAMIC_MOM36_ALLOCATION_LABELS[longCount]!,
    };
    const raw = selectDynamicMom36Legs(baseline.activeUniverse, allocation, input.maxPerCluster);
    const strict = selectDynamicMom36Legs(baseline.activeUniverse, allocation, input.maxPerCluster, { slowFastApplied: true });
    const complete = strict.insufficientReason === null;
    const candidate: DynamicMom36Formation = {
      ...baseline, preference: null, requestedAllocation: allocation, finalAllocation: allocation,
      rawV3Selection: raw, slowFastStrictSelection: strict, selection: strict, selectionSource: "STRICT_SLOW_FAST",
      directionalFeasibility: {
        active: true, requestedAllocation: allocation,
        directionalPrior: longCount === 3 ? null : longCount > 3 ? "LONG" : "SHORT",
        outcome: complete ? "REQUESTED_STRICT_FEASIBLE" : "NO_FULL_STRICT_ALLOCATION",
        attempts: [], effectiveAllocation: complete ? allocation : null,
      },
    };
    // Do not rescue an inadmissible geometry through an alternative. Each admitted geometry
    // then searches the bounded qualified pool with the SAME final guard on every combination.
    const rejected = input.rejectionReason(candidate);
    const preferred = rejected === null ? applyDynamicMom36Preference(candidate, {
      maxPerCluster: input.maxPerCluster, includeSkew: true,
      admit: c => input.rejectionReason(c) === null,
    }) : candidate;
    const finalRejection = input.rejectionReason(preferred);
    const p = preferred.preference;
    const qualified = finalRejection === null && p !== null && !p.searchExhausted
      && p.s1h !== null && p.s1h > 0 && p.s4h !== null && p.s4h > 0
      && p.basketReturn1h !== null && p.basketReturn1h > 0
      && p.basketReturn4h !== null && p.basketReturn4h > 0;
    const rank = qualified ? dynamicMom36CombinationRank(baseline.activeUniverse,
      preferred.selection.selectedLongs, preferred.selection.selectedShorts) : null;
    audit.candidates.push({
      allocation, baselineLongs: strict.selectedLongs.map(r => r.symbol), baselineShorts: strict.selectedShorts.map(r => r.symbol),
      selectedLongs: preferred.selection.selectedLongs.map(r => r.symbol), selectedShorts: preferred.selection.selectedShorts.map(r => r.symbol),
      admissionReason: finalRejection, preferenceReason: p?.reason ?? null,
      qualified, rank, basketReturn1h: p?.basketReturn1h ?? null, basketReturn4h: p?.basketReturn4h ?? null,
      consideredCombinations: p?.consideredCombinations ?? 0, qualifyingCombinations: p?.qualifyingCombinations ?? 0,
    });
    if (qualified && rank !== null) winners.push({ formation: preferred, rank });
  }
  const skewTier = (f: DynamicMom36Formation) => f.finalAllocation.longCount === 3 ? 1 : 0;
  const direction = baseline.requestedAllocation.longCount !== 3
    ? Math.sign(baseline.requestedAllocation.longCount - 3)
    : Math.sign(baseline.positiveCount - baseline.negativeCount);
  const directionTier = (f: DynamicMom36Formation) => Math.sign(f.finalAllocation.longCount - 3) === direction ? 0 : 1;
  winners.sort((a, b) =>
    (input.mode === "SKEW_FIRST_QUALIFIED" ? skewTier(a.formation) - skewTier(b.formation) : 0)
    || a.rank - b.rank
    || skewTier(a.formation) - skewTier(b.formation)
    || directionTier(a.formation) - directionTier(b.formation)
    || a.formation.finalAllocation.longCount - b.formation.finalAllocation.longCount);
  const winner = winners[0];
  if (winner) {
    audit.outcome = "QUALIFIED_WINNER";
    audit.selectedAllocation = winner.formation.finalAllocation;
    return { formation: winner.formation, audit };
  }
  // Preference remains optional when all strength data is unavailable/mixed: preserve the
  // original baseline exactly and let its unchanged final admission decide whether it can trade.
  return { formation: baseline, audit };
}

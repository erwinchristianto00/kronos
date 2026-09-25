/**
 * ONE_SIDED_DIRECTIONAL_QUALITY_V1
 *
 * This module is deliberately pure.  It neither ranks symbols nor changes a V6 allocation: it
 * receives the already-resolved exact six legs and returns a compact, auditable admission opinion.
 * That boundary prevents a directional quality check from becoming a second selector.
 */
import type {
  DynamicMom36ContinuationDecision,
  DynamicMom36ShockState,
} from "./dynamic-mom36-shock-strategy.js";

export const ONE_SIDED_DIRECTIONAL_QUALITY_V1_POLICY_ID = "one-sided-directional-quality-v1" as const;
export const MIN_ONE_SIDED_QUALITY_SCORE = 2 as const;
export const ONE_SIDED_BREADTH_PERSISTENCE_RATIO = 0.70 as const;
export const ONE_SIDED_STRICT_DEPTH_MIN = 8 as const;
export const ONE_SIDED_EXHAUSTION_PERCENTILE = 0.90 as const;

export type OneSidedDirectionalSide = "LONG" | "SHORT";
export type OneSidedQualityScore = -1 | 0 | 1;

export type OneSidedBreadthScan = {
  featureTimestamp: string;
  positiveCount: number;
  negativeCount: number;
  zeroCount: number;
};

export type OneSidedDirectionalQualityContext = {
  /** Current scan first, followed by prior distinct fully-causal Dynamic MOM36 scans. */
  breadthScans: readonly OneSidedBreadthScan[];
  /** Completed causal FAST4H return, deliberately matching the canonical strict fast leg input. */
  btcFast4hReturn: number | null;
  ethFast4hReturn: number | null;
  /** Causal one-hour close-to-close return keyed by the exact selected candidate symbol. */
  selectedOneHourReturnBySymbol: Readonly<Record<string, number | null | undefined>>;
  /**
   * Per-symbol causal absolute MOM36 percentile. A missing value is deliberately neutral, never
   * treated as an unextended name. Runtime V1 only supplies this after a full 90d history exists.
   */
  absMom36PercentileBySymbol: Readonly<Record<string, number | null | undefined>>;
  percentileWindowHours: number | null;
  percentileRequiredWindowHours: number;
  percentileSource: string | null;
};

export type OneSidedDirectionalQuality = {
  policyId: typeof ONE_SIDED_DIRECTIONAL_QUALITY_V1_POLICY_ID;
  applicable: true;
  direction: OneSidedDirectionalSide;
  selectedSymbols: string[];
  minScore: typeof MIN_ONE_SIDED_QUALITY_SCORE;
  score: number;
  components: {
    breadthPersistence: {
      score: 0 | 1;
      requiredRatio: number;
      qualifyingScans: number;
      validScans: number;
      scans: Array<{ featureTimestamp: string; directionalRatio: number | null; qualifies: boolean }>;
    };
    strictEligibleDepth: {
      score: 0 | 1;
      strictEligibleCount: number;
      requiredCount: typeof ONE_SIDED_STRICT_DEPTH_MIN;
    };
    btcEthAlignment: {
      score: OneSidedQualityScore;
      btcFast4hReturn: number | null;
      ethFast4hReturn: number | null;
    };
    selectedTrajectory: {
      score: OneSidedQualityScore;
      returns: Array<{ symbol: string; oneHourReturn: number | null }>;
      medianOneHourReturn: number | null;
      alignedCount: number;
      oppositeCount: number;
      dataAvailable: boolean;
    };
    modelSupport: {
      score: OneSidedQualityScore;
      continuationDecision: DynamicMom36ContinuationDecision | "UNAVAILABLE";
      shockState: DynamicMom36ShockState | "UNAVAILABLE";
      continuationScore: OneSidedQualityScore;
      shockScore: OneSidedQualityScore;
      supportingSources: string[];
      opposingSources: string[];
    };
    exhaustionRisk: {
      score: -1 | 0;
      percentiles: Array<{ symbol: string; absMom36Percentile: number | null }>;
      medianAbsMom36Percentile: number | null;
      threshold: typeof ONE_SIDED_EXHAUSTION_PERCENTILE;
      dataAvailable: boolean;
      windowHours: number | null;
      requiredWindowHours: number;
      source: string | null;
    };
  };
  strongReversal: {
    macro: boolean;
    trajectory: boolean;
    model: boolean;
    count: number;
    veto: boolean;
  };
  decision: "PASS" | "REJECT";
  reason: "ONE_SIDED_ADMISSION_PASSED" | "ONE_SIDED_QUALITY_BELOW_MIN" | "ONE_SIDED_STRONG_REVERSAL_CONFLICT";
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sign(value: number | null | undefined): -1 | 0 | 1 | null {
  if (!finite(value)) return null;
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function modelSignalForDirection(
  direction: OneSidedDirectionalSide,
  state: DynamicMom36ContinuationDecision | DynamicMom36ShockState | "UNAVAILABLE",
): OneSidedQualityScore {
  if (state === "UNAVAILABLE" || state === "NO_EDGE" || state === "VETO") return state === "VETO" ? -1 : 0;
  if (direction === "LONG") {
    if (state === "CONFIRM_LONG") return 1;
    if (state === "CONFIRM_SHORT" || state === "CONFLICT_LONG") return -1;
    return 0;
  }
  if (state === "CONFIRM_SHORT") return 1;
  if (state === "CONFIRM_LONG" || state === "CONFLICT_SHORT") return -1;
  return 0;
}

/**
 * Score an already-fixed one-sided final plan. Neutral means exactly that: unavailable/no-edge
 * evidence does not turn into a synthetic pass or a hard rejection.
 */
export function evaluateOneSidedDirectionalQuality(input: {
  direction: OneSidedDirectionalSide;
  selected: readonly { symbol: string }[];
  strictEligibleCount: number;
  context: OneSidedDirectionalQualityContext;
  continuationDecision: DynamicMom36ContinuationDecision | null | undefined;
  shockState: DynamicMom36ShockState | null | undefined;
}): OneSidedDirectionalQuality {
  const selectedSymbols = input.selected.map((row) => row.symbol);
  const directionSign = input.direction === "LONG" ? 1 : -1;

  const distinctScans = new Map<string, OneSidedBreadthScan>();
  for (const scan of input.context.breadthScans) {
    const key = scan.featureTimestamp;
    if (!key || distinctScans.has(key)) continue;
    const total = scan.positiveCount + scan.negativeCount + scan.zeroCount;
    if (![scan.positiveCount, scan.negativeCount, scan.zeroCount, total].every(Number.isFinite) || total <= 0) continue;
    distinctScans.set(key, scan);
  }
  const breadthScans = [...distinctScans.values()]
    .sort((a, b) => Date.parse(a.featureTimestamp) - Date.parse(b.featureTimestamp))
    .slice(-3);
  const breadthEvidence = breadthScans.map((scan) => {
    const total = scan.positiveCount + scan.negativeCount + scan.zeroCount;
    const directionalCount = input.direction === "LONG" ? scan.positiveCount : scan.negativeCount;
    const directionalRatio = total > 0 ? directionalCount / total : null;
    return {
      featureTimestamp: scan.featureTimestamp,
      directionalRatio,
      qualifies: directionalRatio !== null && directionalRatio >= ONE_SIDED_BREADTH_PERSISTENCE_RATIO,
    };
  });
  const qualifyingScans = breadthEvidence.filter((row) => row.qualifies).length;
  const breadthScore: 0 | 1 = qualifyingScans >= 2 ? 1 : 0;

  const depthScore: 0 | 1 = input.strictEligibleCount >= ONE_SIDED_STRICT_DEPTH_MIN ? 1 : 0;

  const btcSign = sign(input.context.btcFast4hReturn);
  const ethSign = sign(input.context.ethFast4hReturn);
  const macroScore: OneSidedQualityScore =
    btcSign === directionSign && ethSign === directionSign ? 1
      : btcSign === -directionSign && ethSign === -directionSign ? -1
        : 0;

  const selectedReturns = selectedSymbols.map((symbol) => ({
    symbol,
    oneHourReturn: finite(input.context.selectedOneHourReturnBySymbol[symbol])
      ? input.context.selectedOneHourReturnBySymbol[symbol]!
      : null,
  }));
  const trajectoryDataAvailable = selectedReturns.length === 6 && selectedReturns.every((row) => row.oneHourReturn !== null);
  const trajectoryValues = selectedReturns.flatMap((row) => row.oneHourReturn === null ? [] : [row.oneHourReturn]);
  const trajectoryMedian = trajectoryDataAvailable ? median(trajectoryValues) : null;
  const alignedCount = trajectoryValues.filter((value) => sign(value) === directionSign).length;
  const oppositeCount = trajectoryValues.filter((value) => sign(value) === -directionSign).length;
  const trajectoryScore: OneSidedQualityScore = !trajectoryDataAvailable || trajectoryMedian === null
    ? 0
    : trajectoryMedian * directionSign > 0 && alignedCount >= 4
      ? 1
      : trajectoryMedian * directionSign < 0 && oppositeCount >= 4
        ? -1
        : 0;

  const continuationDecision = input.continuationDecision ?? "UNAVAILABLE";
  const shockState = input.shockState ?? "UNAVAILABLE";
  const continuationScore = modelSignalForDirection(input.direction, continuationDecision);
  const shockScore = modelSignalForDirection(input.direction, shockState);
  const modelScore: OneSidedQualityScore = continuationScore < 0 || shockScore < 0
    ? -1
    : continuationScore > 0 || shockScore > 0
      ? 1
      : 0;
  const supportingSources = [
    ...(continuationScore > 0 ? ["CONTINUATION"] : []),
    ...(shockScore > 0 ? ["SHOCK"] : []),
  ];
  const opposingSources = [
    ...(continuationScore < 0 ? ["CONTINUATION"] : []),
    ...(shockScore < 0 ? ["SHOCK"] : []),
  ];

  const percentileRows = selectedSymbols.map((symbol) => ({
    symbol,
    absMom36Percentile: finite(input.context.absMom36PercentileBySymbol[symbol])
      ? input.context.absMom36PercentileBySymbol[symbol]!
      : null,
  }));
  const percentileDataAvailable = percentileRows.length === 6 && percentileRows.every((row) => row.absMom36Percentile !== null);
  const percentileValues = percentileRows.flatMap((row) => row.absMom36Percentile === null ? [] : [row.absMom36Percentile]);
  const medianPercentile = percentileDataAvailable ? median(percentileValues) : null;
  const exhaustionScore: -1 | 0 = medianPercentile !== null && medianPercentile >= ONE_SIDED_EXHAUSTION_PERCENTILE ? -1 : 0;

  const score = breadthScore + depthScore + macroScore + trajectoryScore + modelScore + exhaustionScore;
  const reversalCount = Number(macroScore === -1) + Number(trajectoryScore === -1) + Number(modelScore === -1);
  const strongReversal = {
    macro: macroScore === -1,
    trajectory: trajectoryScore === -1,
    model: modelScore === -1,
    count: reversalCount,
    veto: reversalCount >= 2,
  };
  const reason = strongReversal.veto
    ? "ONE_SIDED_STRONG_REVERSAL_CONFLICT" as const
    : score >= MIN_ONE_SIDED_QUALITY_SCORE
      ? "ONE_SIDED_ADMISSION_PASSED" as const
      : "ONE_SIDED_QUALITY_BELOW_MIN" as const;

  return {
    policyId: ONE_SIDED_DIRECTIONAL_QUALITY_V1_POLICY_ID,
    applicable: true,
    direction: input.direction,
    selectedSymbols,
    minScore: MIN_ONE_SIDED_QUALITY_SCORE,
    score,
    components: {
      breadthPersistence: {
        score: breadthScore,
        requiredRatio: ONE_SIDED_BREADTH_PERSISTENCE_RATIO,
        qualifyingScans,
        validScans: breadthEvidence.length,
        scans: breadthEvidence,
      },
      strictEligibleDepth: {
        score: depthScore,
        strictEligibleCount: input.strictEligibleCount,
        requiredCount: ONE_SIDED_STRICT_DEPTH_MIN,
      },
      btcEthAlignment: {
        score: macroScore,
        btcFast4hReturn: input.context.btcFast4hReturn,
        ethFast4hReturn: input.context.ethFast4hReturn,
      },
      selectedTrajectory: {
        score: trajectoryScore,
        returns: selectedReturns,
        medianOneHourReturn: trajectoryMedian,
        alignedCount,
        oppositeCount,
        dataAvailable: trajectoryDataAvailable,
      },
      modelSupport: {
        score: modelScore,
        continuationDecision,
        shockState,
        continuationScore,
        shockScore,
        supportingSources,
        opposingSources,
      },
      exhaustionRisk: {
        score: exhaustionScore,
        percentiles: percentileRows,
        medianAbsMom36Percentile: medianPercentile,
        threshold: ONE_SIDED_EXHAUSTION_PERCENTILE,
        dataAvailable: percentileDataAvailable,
        windowHours: input.context.percentileWindowHours,
        requiredWindowHours: input.context.percentileRequiredWindowHours,
        source: input.context.percentileSource,
      },
    },
    strongReversal,
    decision: reason === "ONE_SIDED_ADMISSION_PASSED" ? "PASS" : "REJECT",
    reason,
  };
}

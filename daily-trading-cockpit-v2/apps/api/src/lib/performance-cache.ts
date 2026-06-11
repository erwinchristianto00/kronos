import type { PerformanceStats } from "@dtc/shared";

import { computePerformanceWithTiming } from "./outcome-checker.js";
import type { SignalTracker } from "./tracker.js";

export interface AnalysisPerformanceTiming {
  cacheHit: boolean;
  inputSignatureMs: number;
  readAllRawMs: number;
  computePerformanceMs: number;
  totalMs: number;
  candidateNormalizationMs: number | null;
  indicatorAggregationMs: number | null;
  replayVariantAnalysisMs: number | null;
  calibrationMs: number | null;
  routeReasonEvaluationMs: number | null;
  rankingMs: number | null;
  filterGateMs: number | null;
  loggingSerializationMs: number | null;
  diagnosticsBuildMs: number | null;
}

export interface PerformanceProviderResult {
  performance: PerformanceStats;
  timing: AnalysisPerformanceTiming;
}

interface CacheEntry {
  signature: string;
  performance: PerformanceStats;
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round(Date.now() - start));
}

function cloneWithFreshTimestamp(performance: PerformanceStats): PerformanceStats {
  return {
    ...performance,
    generatedAt: new Date().toISOString(),
  };
}

function emptyTiming(cacheHit: boolean, totalMs: number): AnalysisPerformanceTiming {
  return {
    cacheHit,
    inputSignatureMs: 0,
    readAllRawMs: 0,
    computePerformanceMs: cacheHit ? 0 : totalMs,
    totalMs,
    candidateNormalizationMs: null,
    indicatorAggregationMs: null,
    replayVariantAnalysisMs: cacheHit ? 0 : totalMs,
    calibrationMs: null,
    routeReasonEvaluationMs: null,
    rankingMs: null,
    filterGateMs: null,
    loggingSerializationMs: null,
    diagnosticsBuildMs: null,
  };
}

export class PerformanceStatsProvider {
  private cache: CacheEntry | null = null;
  private warming = false;

  constructor(private readonly tracker: SignalTracker) {}

  getPerformance(): PerformanceProviderResult {
    const totalStart = Date.now();
    const sigStart = Date.now();
    const signature = this.tracker.getPerformanceInputSignature();
    const inputSignatureMs = elapsedMs(sigStart);

    if (this.cache?.signature === signature) {
      const totalMs = elapsedMs(totalStart);
      return {
        performance: cloneWithFreshTimestamp(this.cache.performance),
        timing: {
          ...emptyTiming(true, totalMs),
          inputSignatureMs,
        },
      };
    }

    const readStart = Date.now();
    const signals = this.tracker.readAllRaw();
    const readAllRawMs = elapsedMs(readStart);
    const computeStart = Date.now();
    const { performance, timing: computeTiming } = computePerformanceWithTiming(signals, this.tracker.getLastOutcomeCheckerRunAt());
    const computePerformanceMs = elapsedMs(computeStart);
    this.cache = { signature, performance };
    const totalMs = elapsedMs(totalStart);
    return {
      performance: cloneWithFreshTimestamp(performance),
      timing: {
        ...emptyTiming(false, totalMs),
        inputSignatureMs,
        readAllRawMs,
        computePerformanceMs,
        candidateNormalizationMs: computeTiming.candidateNormalizationMs,
        indicatorAggregationMs: computeTiming.indicatorAggregationMs,
        replayVariantAnalysisMs: computeTiming.replayVariantAnalysisMs,
        calibrationMs: computeTiming.calibrationMs,
        routeReasonEvaluationMs: computeTiming.routeReasonEvaluationMs,
        rankingMs: computeTiming.rankingMs,
        filterGateMs: computeTiming.filterGateMs,
        loggingSerializationMs: computeTiming.loggingSerializationMs,
        diagnosticsBuildMs: computeTiming.diagnosticsBuildMs,
      },
    };
  }

  warm(): void {
    if (this.warming) return;
    this.warming = true;
    setImmediate(() => {
      try {
        this.getPerformance();
      } catch {
        // Best-effort background cache warmup.
      } finally {
        this.warming = false;
      }
    });
  }
}

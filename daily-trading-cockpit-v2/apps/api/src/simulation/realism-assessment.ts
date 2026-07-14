/**
 * Realism assessment suite (Market Digital Twin, Phase-1 foundation). Compares a candidate (simulated/bootstrapped)
 * return series against an OBSERVED real reference and reports distributional / dependence / tail / drawdown
 * distances. Every metric is a finite number OR null (INSUFFICIENT_DATA) — never fabricated. Thresholds are NOT set
 * by peeking at any untouched realism holdout (see PARAMETER_LOCK). Pure + deterministic.
 */
import { ksDistance, wasserstein1, autocorr, hillTailIndex, maxDrawdownDepth, std } from "./calibration-metrics.js";

export interface RealismAssessment {
  returnDistributionDistance: number | null; // Wasserstein-1 on returns
  volatilityDistributionDistance: number | null; // Wasserstein-1 on rolling vol
  autocorrelationDistance: number | null; // |acf1(real) - acf1(sim)| on raw returns
  absoluteReturnAutocorrelationDistance: number | null; // on |returns| (vol clustering)
  tailDistance: number | null; // |hill(real) - hill(sim)|
  drawdownDepthDistance: number | null;
  drawdownDurationDistance: number | null;
  regimeDurationDistance: number | null;
  regimeTransitionDistance: number | null;
  volumeDistance: number | null;
  wickGeometryDistance: number | null;
  crossAssetDependenceDistance: number | null;
  executionDistance: number | null;
  classifierValidationAuc: number | null;
  calibrationSampleSize: number;
  historicalSupportPct: number;
  extrapolationPct: number;
  status: "PASS" | "LIMITED" | "OUT_OF_DISTRIBUTION" | "INSUFFICIENT_DATA";
}

export interface RealismInput {
  realReturns: number[];
  simReturns: number[];
  /** Optional rolling-vol series (e.g. 24-bar std) for both, if available. */
  realVol?: number[];
  simVol?: number[];
  /** Optional volume series. */
  realVolume?: number[];
  simVolume?: number[];
  /** Optional wick-geometry (upper/lower wick ÷ range) samples. */
  realWick?: number[];
  simWick?: number[];
  /** Fraction of candidate points that fell inside the observed support envelope [0,1], if computed. */
  historicalSupportPct?: number;
}

const MIN_N = 50;

function rollingStd(returns: number[], window = 24): number[] {
  const out: number[] = [];
  for (let i = window; i <= returns.length; i += 1) {
    const s = std(returns.slice(i - window, i));
    if (s != null) out.push(s);
  }
  return out;
}

export function assessRealism(input: RealismInput): RealismAssessment {
  const n = Math.min(input.realReturns.length, input.simReturns.length);
  const insufficient = n < MIN_N;

  const absReal = input.realReturns.map(Math.abs);
  const absSim = input.simReturns.map(Math.abs);
  const realVol = input.realVol ?? rollingStd(input.realReturns);
  const simVol = input.simVol ?? rollingStd(input.simReturns);

  const acfDist = (() => {
    const a = autocorr(input.realReturns, 1); const b = autocorr(input.simReturns, 1);
    return a != null && b != null ? Math.abs(a - b) : null;
  })();
  const absAcfDist = (() => {
    const a = autocorr(absReal, 1); const b = autocorr(absSim, 1);
    return a != null && b != null ? Math.abs(a - b) : null;
  })();
  const tailDist = (() => {
    const a = hillTailIndex(input.realReturns); const b = hillTailIndex(input.simReturns);
    return a != null && b != null ? Math.abs(a - b) : null;
  })();
  const ddDist = (() => {
    const a = maxDrawdownDepth(input.realReturns); const b = maxDrawdownDepth(input.simReturns);
    return a != null && b != null ? Math.abs(a - b) : null;
  })();

  const historicalSupportPct = input.historicalSupportPct ?? 1;
  const extrapolationPct = 1 - historicalSupportPct;

  const status: RealismAssessment["status"] = insufficient
    ? "INSUFFICIENT_DATA"
    : extrapolationPct > 0.5
      ? "OUT_OF_DISTRIBUTION"
      // Provisional status ONLY (final PASS/LIMITED thresholds are locked pre-holdout, not decided here).
      : "LIMITED";

  return {
    returnDistributionDistance: wasserstein1(input.realReturns, input.simReturns),
    volatilityDistributionDistance: realVol.length && simVol.length ? wasserstein1(realVol, simVol) : null,
    autocorrelationDistance: acfDist,
    absoluteReturnAutocorrelationDistance: absAcfDist,
    tailDistance: tailDist,
    drawdownDepthDistance: ddDist,
    drawdownDurationDistance: null, // duration metric specified; implemented in a later phase (marked, not faked)
    regimeDurationDistance: null,
    regimeTransitionDistance: null,
    volumeDistance: input.realVolume && input.simVolume ? wasserstein1(input.realVolume, input.simVolume) : null,
    wickGeometryDistance: input.realWick && input.simWick ? ksDistance(input.realWick, input.simWick) : null,
    crossAssetDependenceDistance: null, // requires 2-symbol rolling-corr series; specified, later phase
    executionDistance: null,
    classifierValidationAuc: null, // filled by real-vs-sim-classifier when run
    calibrationSampleSize: n,
    historicalSupportPct,
    extrapolationPct,
    status,
  };
}

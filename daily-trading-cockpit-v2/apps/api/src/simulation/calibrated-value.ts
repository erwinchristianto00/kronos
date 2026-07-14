/**
 * Empirical calibration contract (Market Digital Twin, Phase-1 foundation). A value the simulator derives from data
 * (a slippage estimate, a funding assumption, …) MUST carry how it was calibrated + its uncertainty. NEVER return a
 * falsely precise value: if uncertainty cannot be estimated, it is null and the limitation is recorded. Pure types.
 */

export type CalibrationProvenance = "OBSERVED" | "EMPIRICAL_SAMPLE" | "MODEL_ESTIMATE" | "STRESS_ASSUMPTION";

export interface CalibratedValue<T> {
  value: T;
  provenance: CalibrationProvenance;
  calibrationPeriod: { startMs: number; endMs: number } | null;
  sampleSize: number | null;
  effectiveSampleSize: number | null;
  /** 0..1 subjective confidence in the calibration (NOT a probability of correctness). */
  confidence: number;
  /** Uncertainty (e.g. std of the estimate) or NULL when it genuinely cannot be estimated. */
  uncertainty: number | null;
  withinHistoricalSupport: boolean;
  method: string;
}

/** A directly observed value (confidence 1, within support). */
export function observedCalibration<T>(value: T, period: { startMs: number; endMs: number } | null, method = "direct-observation"): CalibratedValue<T> {
  return { value, provenance: "OBSERVED", calibrationPeriod: period, sampleSize: null, effectiveSampleSize: null, confidence: 1, uncertainty: 0, withinHistoricalSupport: true, method };
}

/** An empirical-sample calibration. `uncertainty` may be null if it truly cannot be estimated (recorded honestly). */
export function empiricalCalibration<T>(value: T, opts: { period: { startMs: number; endMs: number } | null; sampleSize: number; effectiveSampleSize: number | null; confidence: number; uncertainty: number | null; withinHistoricalSupport: boolean; method: string }): CalibratedValue<T> {
  return { value, provenance: "EMPIRICAL_SAMPLE", calibrationPeriod: opts.period, sampleSize: opts.sampleSize, effectiveSampleSize: opts.effectiveSampleSize, confidence: opts.confidence, uncertainty: opts.uncertainty, withinHistoricalSupport: opts.withinHistoricalSupport, method: opts.method };
}

/** A stress ASSUMPTION (not calibrated from data) — flagged out-of-support so the firewall keeps it stress-only. */
export function stressAssumption<T>(value: T, method: string): CalibratedValue<T> {
  return { value, provenance: "STRESS_ASSUMPTION", calibrationPeriod: null, sampleSize: null, effectiveSampleSize: null, confidence: 0.2, uncertainty: null, withinHistoricalSupport: false, method };
}

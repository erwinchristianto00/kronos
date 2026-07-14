/**
 * Natural-boundary detector (Market Digital Twin, Phase 2C). Classifies each real historical adjacent-candle boundary as
 * ORDINARY / STRESS / EVENT / INSUFFICIENT_DATA using empirical support thresholds fitted on CALIBRATION ONLY. Method F
 * (variable natural-boundary blocks) ends blocks only at ORDINARY boundaries so joins occur where the real market had a
 * low-discontinuity transition. Crisis/stress boundaries are NEVER removed from the source library — they are labelled
 * so stress scenarios can intentionally use them with explicit provenance. Pure + deterministic.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import { quantile } from "./calibration-metrics.js";

export type BoundaryClass = "ORDINARY_BOUNDARY" | "STRESS_BOUNDARY" | "EVENT_BOUNDARY" | "INSUFFICIENT_DATA";

export interface BoundarySupport {
  volRatioOrdinaryMax: number; // ≤ this ⇒ ordinary (calibration p90)
  volRatioStressMax: number; // ≤ this ⇒ stress; above ⇒ event (calibration p99.5)
  volumeRatioOrdinaryMax: number;
  volumeRatioStressMax: number;
  vectorDiscOrdinaryMax: number;
  labelVersion: string;
}

const rangeOf = (f: CommonMarketFrame | undefined, s: string): number | null => { const c = f?.symbols[s]?.candle.value; return c ? c.high - c.low : null; };
const volOf = (f: CommonMarketFrame | undefined, s: string): number | null => (f?.symbols[s]?.candle.value?.volume ?? null);
const ret = (frames: readonly CommonMarketFrame[], i: number, s: string): number | null => { const a = frames[i - 1]?.symbols[s]?.candle.value?.close; const b = frames[i]?.symbols[s]?.candle.value?.close; return typeof a === "number" && typeof b === "number" && a > 0 ? Math.log(b / a) : null; };

/** Per-boundary real transition metrics (candle i-1 → i). null components ⇒ missing data. */
export function boundaryMetrics(frames: readonly CommonMarketFrame[], i: number, btc: string, eth: string): { volRatio: number | null; volumeRatio: number | null; vectorDisc: number | null } {
  const pr = rangeOf(frames[i - 1], btc); const cr = rangeOf(frames[i], btc);
  const pv = volOf(frames[i - 1], btc); const cv = volOf(frames[i], btc);
  const volRatio = pr != null && cr != null && pr > 0 && cr > 0 ? Math.max(cr / pr, pr / cr) : null;
  const volumeRatio = pv != null && cv != null && pv > 0 && cv > 0 ? Math.max(cv / pv, pv / cv) : null;
  const bB = ret(frames, i, btc); const bE = ret(frames, i, eth); const pB = ret(frames, i - 1, btc); const pE = ret(frames, i - 1, eth);
  const vectorDisc = bB != null && bE != null && pB != null && pE != null ? Math.hypot(bB - pB, bE - pE) : null;
  return { volRatio, volumeRatio, vectorDisc };
}

/** Fit boundary support thresholds from CALIBRATION boundaries only (frozen percentiles). */
export function fitBoundarySupport(calibration: readonly CommonMarketFrame[], btc: string, eth: string): BoundarySupport {
  const volR: number[] = []; const volumeR: number[] = []; const vecD: number[] = [];
  for (let i = 1; i < calibration.length; i += 1) {
    const m = boundaryMetrics(calibration, i, btc, eth);
    if (m.volRatio != null) volR.push(m.volRatio); if (m.volumeRatio != null) volumeR.push(m.volumeRatio); if (m.vectorDisc != null) vecD.push(m.vectorDisc);
  }
  return {
    volRatioOrdinaryMax: quantile(volR, 0.90) ?? 3, volRatioStressMax: quantile(volR, 0.995) ?? 6,
    volumeRatioOrdinaryMax: quantile(volumeR, 0.90) ?? 5, volumeRatioStressMax: quantile(volumeR, 0.995) ?? 10,
    vectorDiscOrdinaryMax: quantile(vecD, 0.90) ?? 0.02,
    labelVersion: "phase2c-boundary-v1",
  };
}

/** Classify one boundary using the fitted support. */
export function classifyBoundary(frames: readonly CommonMarketFrame[], i: number, support: BoundarySupport, btc: string, eth: string): BoundaryClass {
  const m = boundaryMetrics(frames, i, btc, eth);
  if (m.volRatio == null || m.volumeRatio == null || m.vectorDisc == null) return "INSUFFICIENT_DATA";
  const stress = m.volRatio > support.volRatioOrdinaryMax || m.volumeRatio > support.volumeRatioOrdinaryMax || m.vectorDisc > support.vectorDiscOrdinaryMax;
  if (!stress) return "ORDINARY_BOUNDARY";
  const event = m.volRatio > support.volRatioStressMax || m.volumeRatio > support.volumeRatioStressMax;
  return event ? "EVENT_BOUNDARY" : "STRESS_BOUNDARY";
}

/** Index the ORDINARY boundaries of `frames` (indices i that are low-discontinuity transitions). */
export function ordinaryBoundaries(frames: readonly CommonMarketFrame[], support: BoundarySupport, btc: string, eth: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < frames.length; i += 1) if (classifyBoundary(frames, i, support, btc, eth) === "ORDINARY_BOUNDARY") out.push(i);
  return out;
}

/** Count boundary classes over a frame range (for reporting). */
export function boundaryClassCounts(frames: readonly CommonMarketFrame[], support: BoundarySupport, btc: string, eth: string): Record<BoundaryClass, number> {
  const c: Record<BoundaryClass, number> = { ORDINARY_BOUNDARY: 0, STRESS_BOUNDARY: 0, EVENT_BOUNDARY: 0, INSUFFICIENT_DATA: 0 };
  for (let i = 1; i < frames.length; i += 1) c[classifyBoundary(frames, i, support, btc, eth)] += 1;
  return c;
}

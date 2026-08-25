/**
 * Offline-only chronological evaluation of V4 continuation artifacts.
 *
 * It uses the exact TypeScript tree parser and `normalizeFrozenV4ContinuationOverlay` decision
 * mapping that formation uses. This is deliberately separate from trade execution: it reads a
 * frozen matrix and returns metrics; it cannot write a pointer or touch a basket.
 */
import { readFileSync } from "node:fs";
import {
  DirectionTrajectory,
  type DirectionTrajectoryArtifact,
  type TrajectoryPrediction,
  validateTrajectoryArtifact,
} from "./direction-model-runtime.js";
import { pathClassFrom, type Horizon } from "./direction-model-features.js";
import {
  applyBoundedContinuationOverlay,
  normalizeFrozenV4ContinuationOverlay,
  type DynamicMom36Allocation,
} from "./dynamic-mom36-shock-strategy.js";
import {
  CONTINUATION_FEATURE_SCHEMA_VERSION,
  CONTINUATION_HORIZONS,
  type ContinuationArtifactMetrics,
} from "./continuation-lifecycle.js";

const PATHS = [
  "PERSISTENT_UP", "PERSISTENT_DOWN", "UP_THEN_REVERSAL", "DOWN_THEN_REVERSAL",
  "EARLY_UP_THEN_FLAT", "EARLY_DOWN_THEN_FLAT", "CHOP", "TRANSITION",
] as const;
const DIRECTION_CLASSES = ["STRONG_DOWN", "NEUTRAL", "STRONG_UP"] as const;
const EMBARGO_ROWS = 36;

export type ContinuationMatrixLabel = { r: number; vol: number; z: number; cls: string };

export type ContinuationMatrixRow = {
  formationTimestampMs: number;
  maxFeatureSourceTimestampMs: number;
  baseLongCount: number;
  features: Record<string, number | null>;
  labels: Record<Horizon, ContinuationMatrixLabel>;
};

type HorizonMetricAccumulator = {
  probabilities: number[][];
  labels: number[];
  expected: number[];
  realized: number[];
};

export type ContinuationEvaluationObservation = {
  formationTimestampMs: number;
  baseLongCount: number;
  pathClass: string;
  r36: number;
  trajectoryLoss: number;
  prediction: TrajectoryPrediction;
  decision: "NO_EDGE" | "CONFIRM_LONG" | "CONFIRM_SHORT" | "CONFLICT_LONG" | "CONFLICT_SHORT";
  finalLongCount: number;
};

export type ContinuationArtifactEvaluation = {
  metrics: ContinuationArtifactMetrics;
  observations: ContinuationEvaluationObservation[];
};

function finite(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function labelsStart(header: string[]): number {
  const first = header.findIndex((value) => value === "r6");
  if (first < 0) throw new Error("continuation matrix missing H6 label columns");
  return first;
}

/** CSV is internal and numeric-only, so a strict simple parser is safer than silently accepting quotes. */
export function readContinuationMatrix(path: string): ContinuationMatrixRow[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("continuation matrix has no data rows");
  const header = lines[0]!.split(",");
  const labelStart = labelsStart(header);
  const hasSourceTimestamp = header[1] === "maxFeatureSourceTimestampMs";
  const baseLongIndex = header.indexOf("baseLongCount");
  const featureStart = hasSourceTimestamp ? (baseLongIndex === 2 ? 3 : 2) : 1;
  const featureNames = header.slice(featureStart, labelStart);
  if (!featureNames.length) throw new Error("continuation matrix has no features");
  return lines.slice(1).flatMap((line, rowIndex) => {
    const values = line.split(",");
    if (values.length !== header.length) throw new Error(`continuation matrix row ${rowIndex + 2} has wrong column count`);
    const formationTimestampMs = finite(values[0]);
    const maxFeatureSourceTimestampMs = hasSourceTimestamp ? finite(values[1]) : formationTimestampMs;
    const baseLongCount = baseLongIndex >= 0 ? finite(values[baseLongIndex]) : 3;
    if (formationTimestampMs === null || maxFeatureSourceTimestampMs === null || baseLongCount === null) {
      throw new Error(`continuation matrix row ${rowIndex + 2} has invalid metadata`);
    }
    if (maxFeatureSourceTimestampMs > formationTimestampMs) {
      throw new Error(`continuation matrix row ${rowIndex + 2} violates feature PIT timestamp`);
    }
    if (!Number.isInteger(baseLongCount) || baseLongCount < 0 || baseLongCount > 6) {
      throw new Error(`continuation matrix row ${rowIndex + 2} has invalid base long count`);
    }
    const features: Record<string, number | null> = {};
    featureNames.forEach((name, index) => { features[name] = finite(values[featureStart + index]); });
    const labels = {} as Record<Horizon, ContinuationMatrixLabel>;
    for (const [index, horizon] of CONTINUATION_HORIZONS.entries()) {
      const offset = labelStart + index * 4;
      const r = finite(values[offset]);
      const vol = finite(values[offset + 1]);
      const z = finite(values[offset + 2]);
      const cls = values[offset + 3];
      if (r === null || vol === null || z === null || !DIRECTION_CLASSES.includes(cls as (typeof DIRECTION_CLASSES)[number])) {
        throw new Error(`continuation matrix row ${rowIndex + 2} has invalid H${horizon} label`);
      }
      labels[horizon] = { r, vol, z, cls };
    }
    return [{ formationTimestampMs, maxFeatureSourceTimestampMs, baseLongCount, features, labels }];
  });
}

export function newestPurgedHoldout(rows: readonly ContinuationMatrixRow[]): ContinuationMatrixRow[] {
  const boundary = Math.floor(rows.length * 0.8) + EMBARGO_ROWS;
  return rows.slice(Math.min(rows.length, boundary));
}

function allocation(longCount: number): DynamicMom36Allocation {
  const safe = Math.max(0, Math.min(6, Math.trunc(longCount)));
  const labels: DynamicMom36Allocation["label"][] = ["0L6S", "1L5S", "2L4S", "3L3S", "4L2S", "5L1S", "6L0S"];
  return { longCount: safe, shortCount: 6 - safe, label: labels[safe]! };
}

function logLoss(probabilities: readonly number[][], labels: readonly number[]): number | null {
  if (!labels.length) return null;
  let total = 0;
  for (let index = 0; index < labels.length; index += 1) {
    const probability = probabilities[index]?.[labels[index]!] ?? 0;
    total += -Math.log(Math.max(1e-12, Math.min(1, probability)));
  }
  return total / labels.length;
}

function brier(probabilities: readonly number[][], labels: readonly number[], classes: number): number | null {
  if (!labels.length) return null;
  let total = 0;
  for (let row = 0; row < labels.length; row += 1) {
    for (let klass = 0; klass < classes; klass += 1) {
      const target = labels[row] === klass ? 1 : 0;
      const diff = (probabilities[row]?.[klass] ?? 0) - target;
      total += diff * diff;
    }
  }
  return total / (labels.length * classes);
}

function balancedAccuracy(probabilities: readonly number[][], labels: readonly number[], classes: number): number | null {
  if (!labels.length) return null;
  const recalls: number[] = [];
  for (let klass = 0; klass < classes; klass += 1) {
    let actual = 0;
    let correct = 0;
    for (let row = 0; row < labels.length; row += 1) {
      if (labels[row] !== klass) continue;
      actual += 1;
      const predicted = probabilities[row]!.reduce((best, value, index, values) => value > values[best]! ? index : best, 0);
      if (predicted === klass) correct += 1;
    }
    if (actual) recalls.push(correct / actual);
  }
  return recalls.length ? recalls.reduce((sum, value) => sum + value, 0) / recalls.length : null;
}

function baseRateLogLoss(labels: readonly number[], classes: number): number | null {
  if (!labels.length) return null;
  const counts = Array.from({ length: classes }, () => 0);
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  const probabilities = counts.map((count) => count / labels.length);
  return logLoss(labels.map(() => probabilities), labels);
}

function expectedCalibrationError(probabilities: readonly number[][], labels: readonly number[]): number | null {
  if (!labels.length) return null;
  const buckets = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
  for (let row = 0; row < labels.length; row += 1) {
    const probs = probabilities[row]!;
    const predicted = probs.reduce((best, value, index, values) => value > values[best]! ? index : best, 0);
    const confidence = probs[predicted] ?? 0;
    const bucket = Math.min(9, Math.max(0, Math.floor(confidence * 10)));
    buckets[bucket]!.count += 1;
    buckets[bucket]!.confidence += confidence;
    buckets[bucket]!.correct += predicted === labels[row] ? 1 : 0;
  }
  return buckets.reduce((sum, bucket) => {
    if (!bucket.count) return sum;
    return sum + bucket.count / labels.length * Math.abs(bucket.confidence / bucket.count - bucket.correct / bucket.count);
  }, 0);
}

function correlation(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 3 || a.length !== b.length) return null;
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let a2 = 0;
  let b2 = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index]! - meanA;
    const db = b[index]! - meanB;
    numerator += da * db;
    a2 += da * da;
    b2 += db * db;
  }
  return a2 > 0 && b2 > 0 ? numerator / Math.sqrt(a2 * b2) : null;
}

function horizonMetrics(accumulator: HorizonMetricAccumulator): {
  logLoss: number | null;
  baseRateLogLoss: number | null;
  balancedAccuracy: number | null;
  brier: number | null;
  expectedReturnCorrelation: number | null;
} {
  return {
    logLoss: logLoss(accumulator.probabilities, accumulator.labels),
    baseRateLogLoss: baseRateLogLoss(accumulator.labels, 3),
    balancedAccuracy: balancedAccuracy(accumulator.probabilities, accumulator.labels, 3),
    brier: brier(accumulator.probabilities, accumulator.labels, 3),
    expectedReturnCorrelation: correlation(accumulator.expected, accumulator.realized),
  };
}

function pathIndex(path: string): number {
  const index = PATHS.indexOf(path as (typeof PATHS)[number]);
  if (index < 0) throw new Error(`unknown V4 path class ${path}`);
  return index;
}

function directionClassIndex(cls: string): number {
  const index = DIRECTION_CLASSES.indexOf(cls as (typeof DIRECTION_CLASSES)[number]);
  if (index < 0) throw new Error(`unknown V4 direction class ${cls}`);
  return index;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function evaluateContinuationArtifact(
  artifactInput: unknown,
  rows: readonly ContinuationMatrixRow[],
  opts: { artifactId?: string; artifactSha256?: string | null } = {},
): ContinuationArtifactEvaluation {
  validateTrajectoryArtifact(artifactInput);
  const artifact = artifactInput as DirectionTrajectoryArtifact;
  const trajectory = DirectionTrajectory.fromJson(artifact);
  const pathProbabilities: number[][] = [];
  const pathLabels: number[] = [];
  const horizon = new Map<number, HorizonMetricAccumulator>(CONTINUATION_HORIZONS.map((value) => [value, {
    probabilities: [], labels: [], expected: [], realized: [],
  }]));
  const observations: ContinuationEvaluationObservation[] = [];
  const confirmationReturns: number[] = [];
  const conflictReturns: number[] = [];
  let noEdge = 0;
  let tilted = 0;
  let confirmationCount = 0;
  let conflictCount = 0;

  for (const row of rows) {
    if (row.maxFeatureSourceTimestampMs > row.formationTimestampMs) throw new Error("feature PIT timestamp violates formation cutoff");
    const prediction = trajectory.predict(row.features);
    const path = pathClassFrom(row.labels[6].z, row.labels[12].z, row.labels[24].z, row.labels[36].z);
    const probabilities = PATHS.map((name) => prediction.pathProbabilities[name] ?? 0);
    pathProbabilities.push(probabilities);
    pathLabels.push(pathIndex(path));
    const base = allocation(row.baseLongCount);
    const normalized = normalizeFrozenV4ContinuationOverlay({
      available: true,
      artifactId: opts.artifactId ?? artifact.version,
      artifactSha256: opts.artifactSha256 ?? null,
      schemaVersion: 4,
      featureVersion: CONTINUATION_FEATURE_SCHEMA_VERSION,
      calibrationVersion: `temperature-${artifact.calibrationTemperature}`,
      runtimeFunction: "offline DirectionTrajectory.predict",
      featureAtMs: row.formationTimestampMs,
      fallbackReason: null,
      trajectory: prediction,
      rawOutput: {},
    }, base);
    const finalAllocation = applyBoundedContinuationOverlay(base, normalized);
    if (normalized.decision === "NO_EDGE") noEdge += 1;
    if (finalAllocation.longCount !== base.longCount) tilted += 1;
    const r36 = row.labels[36].r;
    if (normalized.decision === "CONFIRM_LONG") { confirmationCount += 1; confirmationReturns.push(r36); }
    else if (normalized.decision === "CONFIRM_SHORT") { confirmationCount += 1; confirmationReturns.push(-r36); }
    else if (normalized.decision === "CONFLICT_LONG") { conflictCount += 1; conflictReturns.push(-r36); }
    else if (normalized.decision === "CONFLICT_SHORT") { conflictCount += 1; conflictReturns.push(r36); }
    for (const h of CONTINUATION_HORIZONS) {
      const accumulator = horizon.get(h)!;
      const detail = prediction.horizons.find((item) => item.horizon === h);
      if (!detail) throw new Error(`trajectory prediction missing H${h}`);
      accumulator.probabilities.push([detail.pStrongDown, detail.pNeutral, detail.pStrongUp]);
      accumulator.labels.push(directionClassIndex(row.labels[h].cls));
      accumulator.expected.push(detail.expectedReturn);
      accumulator.realized.push(row.labels[h].r);
    }
    const probability = probabilities[pathIndex(path)] ?? 0;
    observations.push({
      formationTimestampMs: row.formationTimestampMs,
      baseLongCount: row.baseLongCount,
      pathClass: path,
      r36,
      trajectoryLoss: -Math.log(Math.max(1e-12, Math.min(1, probability))),
      prediction,
      decision: normalized.decision,
      finalLongCount: finalAllocation.longCount,
    });
  }
  const trajectoryMetric = {
    logLoss: logLoss(pathProbabilities, pathLabels),
    baseRateLogLoss: baseRateLogLoss(pathLabels, PATHS.length),
    balancedAccuracy: balancedAccuracy(pathProbabilities, pathLabels, PATHS.length),
    brier: brier(pathProbabilities, pathLabels, PATHS.length),
    expectedReturnCorrelation: correlation(observations.map((row) => row.prediction.expectedReturn), observations.map((row) => row.r36)),
    calibrationEce: expectedCalibrationError(pathProbabilities, pathLabels),
  };
  const metrics: ContinuationArtifactMetrics = {
    trajectory: trajectoryMetric,
    horizons: Object.fromEntries(CONTINUATION_HORIZONS.map((h) => [String(h), horizonMetrics(horizon.get(h)!)])),
    decisions: {
      observations: observations.length,
      noEdgePct: observations.length ? noEdge / observations.length : null,
      tiltPct: observations.length ? tilted / observations.length : null,
      confirmationCount,
      conflictCount,
      confirmationSignedMeanReturn: mean(confirmationReturns),
      conflictSignedMeanReturn: mean(conflictReturns),
    },
    temporal: { buckets: 0, nonRegressingBuckets: 0, worstDeltaLogLoss: null, medianDeltaLogLoss: null },
    bootstrap: { deltaLogLossCiLow: null, deltaLogLossCiHigh: null },
  };
  return { metrics, observations };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function bootstrapDelta(champion: readonly ContinuationEvaluationObservation[], challenger: readonly ContinuationEvaluationObservation[]): {
  low: number | null;
  high: number | null;
} {
  if (champion.length < EMBARGO_ROWS || champion.length !== challenger.length) return { low: null, high: null };
  const blocks = Array.from({ length: Math.ceil(champion.length / EMBARGO_ROWS) }, (_, index) => {
    const start = index * EMBARGO_ROWS;
    return Array.from({ length: Math.min(EMBARGO_ROWS, champion.length - start) }, (_, offset) => start + offset);
  });
  let state = 0x9e3779b9;
  const random = (): number => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  const samples: number[] = [];
  for (let iteration = 0; iteration < 600; iteration += 1) {
    let total = 0;
    let count = 0;
    for (let pick = 0; pick < blocks.length; pick += 1) {
      for (const index of blocks[Math.floor(random() * blocks.length)]!) {
        total += challenger[index]!.trajectoryLoss - champion[index]!.trajectoryLoss;
        count += 1;
      }
    }
    samples.push(total / count);
  }
  samples.sort((a, b) => a - b);
  return { low: samples[Math.floor(samples.length * 0.025)] ?? null, high: samples[Math.floor(samples.length * 0.975)] ?? null };
}

/** Candidate minus champion: negative logloss delta is an improvement. */
export function compareContinuationArtifacts(
  champion: ContinuationArtifactEvaluation,
  challenger: ContinuationArtifactEvaluation,
): ContinuationArtifactMetrics {
  if (champion.observations.length !== challenger.observations.length ||
    champion.observations.some((row, index) => row.formationTimestampMs !== challenger.observations[index]?.formationTimestampMs)) {
    throw new Error("champion/challenger evaluation rows are not identical");
  }
  const byMonth = new Map<string, number[]>();
  for (let index = 0; index < champion.observations.length; index += 1) {
    const month = new Date(champion.observations[index]!.formationTimestampMs).toISOString().slice(0, 7);
    const deltas = byMonth.get(month) ?? [];
    deltas.push(challenger.observations[index]!.trajectoryLoss - champion.observations[index]!.trajectoryLoss);
    byMonth.set(month, deltas);
  }
  const monthly = [...byMonth.values()].filter((values) => values.length >= 10).map((values) => mean(values)!).filter(Number.isFinite);
  const confidence = bootstrapDelta(champion.observations, challenger.observations);
  return {
    ...challenger.metrics,
    temporal: {
      buckets: monthly.length,
      nonRegressingBuckets: monthly.filter((value) => value <= 0).length,
      worstDeltaLogLoss: monthly.length ? Math.max(...monthly) : null,
      medianDeltaLogLoss: median(monthly),
    },
    bootstrap: { deltaLogLossCiLow: confidence.low, deltaLogLossCiHigh: confidence.high },
  };
}

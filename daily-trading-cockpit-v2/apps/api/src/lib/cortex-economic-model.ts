/**
 * Post-fix CORTEX economic learner.
 *
 * This is intentionally a pure, report-only model.  It learns realized net R,
 * not a binary win label, and is not connected to allocation until exact
 * decision-to-outcome ownership is available for every training record.
 */
import { CORTEX_FEATURE_SCHEMA_VERSION, solveLinear } from "./cortex-brain.js";
import { ECONOMIC_HURDLE_R } from "./success-goal-contract.js";

export const CORTEX_ECONOMIC_HURDLE_R = ECONOMIC_HURDLE_R;
export const CORTEX_ECONOMIC_MIN_EFFECTIVE_N = 20;
const DEFAULT_HALF_LIFE_DAYS = 45;
const DEFAULT_RIDGE = 1;
const DEFAULT_HUBER_K = 1.5;
const MAX_ITERATIONS = 20;

export type CortexEconomicModelStatus =
  | "ACCEPTED"
  | "INSUFFICIENT_DATA"
  | "REJECTED_NON_FINITE"
  | "REJECTED_NON_CONVERGENCE"
  | "REJECTED_COEFFICIENT_JUMP";

export interface CortexEconomicExample {
  x: number[];
  realizedNetR: number;
  tMs: number;
  schemaVersion: number;
}

export interface CortexEconomicFit {
  coefficients: number[];
  residualScale: number | null;
  effectiveSampleSize: number;
  status: CortexEconomicModelStatus;
}

export interface CortexEconomicPrediction {
  predictedNetR: number | null;
  conservativeExpectedNetR: number | null;
  residualScale: number | null;
  effectiveSampleSize: number;
  modelStatus: CortexEconomicModelStatus;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function robustScale(residuals: number[]): number | null {
  const center = median(residuals);
  if (center === null) return null;
  const mad = median(residuals.map((value) => Math.abs(value - center)));
  if (mad === null || !Number.isFinite(mad)) return null;
  // Keep a tiny positive floor: perfectly fitted finite rows are still valid,
  // but must never create an infinite Huber weight or zero uncertainty.
  return Math.max(1e-6, 1.4826 * mad);
}

function weightedObjective(rows: CortexEconomicExample[], weights: number[], w: number[], prior: number[], ridge: number): number {
  let total = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const residual = row.realizedNetR - row.x.reduce((sum, value, i) => sum + value * (w[i] ?? 0), 0);
    total += weights[index]! * residual * residual;
  }
  for (let i = 0; i < w.length; i += 1) total += ridge * (w[i]! - prior[i]!) ** 2;
  return total;
}

/** Deterministic robust ridge via Huber IRLS. */
export function refitCortexEconomicModel(
  examples: CortexEconomicExample[],
  prior: number[],
  options: {
    nowMs: number;
    halfLifeDays?: number;
    ridge?: number;
    huberK?: number;
    minEffectiveN?: number;
    maxJump?: number;
  },
): CortexEconomicFit {
  const dimension = prior.length;
  const rows = examples.filter((row) =>
    row.schemaVersion === CORTEX_FEATURE_SCHEMA_VERSION &&
    Array.isArray(row.x) && row.x.length === dimension && row.x.every(Number.isFinite) &&
    Number.isFinite(row.realizedNetR) && Number.isFinite(row.tMs),
  );
  const halfLifeMs = (options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) * 86_400_000;
  const timeWeights = rows.map((row) => Math.pow(0.5, Math.max(0, options.nowMs - row.tMs) / halfLifeMs));
  const effectiveSampleSize = timeWeights.reduce((sum, value) => sum + value, 0);
  if (rows.length === 0 || effectiveSampleSize < (options.minEffectiveN ?? CORTEX_ECONOMIC_MIN_EFFECTIVE_N)) {
    return { coefficients: [...prior], residualScale: null, effectiveSampleSize, status: "INSUFFICIENT_DATA" };
  }

  const ridge = options.ridge ?? DEFAULT_RIDGE;
  const huberK = options.huberK ?? DEFAULT_HUBER_K;
  const maxJump = options.maxJump ?? 8;
  let w = [...prior];
  let scale = 1;
  let converged = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const residuals = rows.map((row) => row.realizedNetR - row.x.reduce((sum, value, i) => sum + value * (w[i] ?? 0), 0));
    scale = robustScale(residuals) ?? 1;
    const weights = residuals.map((residual, index) => {
      const standardized = Math.abs(residual) / scale;
      const huberWeight = standardized <= huberK ? 1 : huberK / standardized;
      return timeWeights[index]! * huberWeight;
    });
    const gram = Array.from({ length: dimension }, () => new Array(dimension).fill(0));
    const target = new Array(dimension).fill(0);
    for (let i = 0; i < dimension; i += 1) {
      gram[i]![i] += ridge;
      target[i] += ridge * prior[i]!;
    }
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      const weight = weights[rowIndex]!;
      for (let i = 0; i < dimension; i += 1) {
        target[i] += weight * row.x[i]! * row.realizedNetR;
        for (let j = 0; j < dimension; j += 1) gram[i]![j]! += weight * row.x[i]! * row.x[j]!;
      }
    }
    const next = solveLinear(gram, target);
    if (!next.every(Number.isFinite)) return { coefficients: [...prior], residualScale: null, effectiveSampleSize, status: "REJECTED_NON_FINITE" };
    const previousObjective = weightedObjective(rows, weights, w, prior, ridge);
    const nextObjective = weightedObjective(rows, weights, next, prior, ridge);
    if (!Number.isFinite(nextObjective) || nextObjective > previousObjective + 1e-9) {
      return { coefficients: [...prior], residualScale: null, effectiveSampleSize, status: "REJECTED_NON_CONVERGENCE" };
    }
    const jump = Math.max(...next.map((value, i) => Math.abs(value - w[i]!)));
    w = next;
    if (jump < 1e-8) {
      converged = true;
      break;
    }
  }
  if (!converged) return { coefficients: [...prior], residualScale: null, effectiveSampleSize, status: "REJECTED_NON_CONVERGENCE" };
  if (Math.max(...w.map((value, i) => Math.abs(value - prior[i]!))) > maxJump) {
    return { coefficients: [...prior], residualScale: null, effectiveSampleSize, status: "REJECTED_COEFFICIENT_JUMP" };
  }
  return { coefficients: w, residualScale: scale, effectiveSampleSize, status: "ACCEPTED" };
}

export function predictCortexEconomicNetR(
  fit: CortexEconomicFit,
  x: number[],
): CortexEconomicPrediction {
  if (
    fit.status !== "ACCEPTED" ||
    fit.residualScale === null ||
    !Array.isArray(x) || x.length !== fit.coefficients.length || !x.every(Number.isFinite)
  ) {
    return { predictedNetR: null, conservativeExpectedNetR: null, residualScale: fit.residualScale, effectiveSampleSize: fit.effectiveSampleSize, modelStatus: fit.status };
  }
  const predictedNetR = x.reduce((sum, value, i) => sum + value * fit.coefficients[i]!, 0);
  if (!Number.isFinite(predictedNetR)) {
    return { predictedNetR: null, conservativeExpectedNetR: null, residualScale: fit.residualScale, effectiveSampleSize: fit.effectiveSampleSize, modelStatus: "REJECTED_NON_FINITE" };
  }
  const uncertainty = 1.96 * fit.residualScale / Math.sqrt(Math.max(1, fit.effectiveSampleSize));
  return {
    predictedNetR,
    conservativeExpectedNetR: predictedNetR - uncertainty,
    residualScale: fit.residualScale,
    effectiveSampleSize: fit.effectiveSampleSize,
    modelStatus: fit.status,
  };
}

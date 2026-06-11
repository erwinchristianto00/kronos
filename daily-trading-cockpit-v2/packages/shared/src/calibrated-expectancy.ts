/**
 * CALIBRATED EXPECTANCY
 *
 * Debiases the planner's heuristic expectedNetR using past calibration evidence
 * (avg realized minus avg expected, per group). Pure function — no side effects
 * on shadow execution, routing rules, ranking, or live trading. Called from
 * buildVariantSelection in execution-plan.ts.
 *
 * Inputs are deliberately shallow (CalibrationGroupStat plus a few scalars) so
 * the caller can pre-compute the evidence map from any source: live
 * ExpectationCalibrationReport, performance-stats projections, or a snapshot
 * passed in via the scan pipeline.
 *
 * Outputs are advisory until the caller wires them into VariantSelectionSnapshot
 * and ProfitRouteInput.
 */

import type {
  ExecutionEntryVariant,
  ProfitRouteMode,
  ShadowPositionVariant,
} from "./types.js";

export type CalibrationConfidence = "LOW" | "MEDIUM" | "HIGH";

export type CalibrationVerdict =
  | "RAW_EDGE_NOT_VALIDATED"
  | "CALIBRATED_POSITIVE"
  | "CALIBRATED_NEGATIVE"
  | "INSUFFICIENT_SAMPLE";

export type CalibrationSourceUsed =
  | "combo"
  | "symbol+combo"
  | "entry+exit"
  | "routeMode"
  | "none";

export type CalibrationDiagnosisCode =
  | "HEURISTIC_OVERCONFIDENT"
  | "COST_DRAG_UNDERCOUNTED"
  | "STOP_TOO_TIGHT"
  | "TP_NOT_PROFITABLE_AFTER_COST"
  | "RUNNER_GIVEBACK"
  | "SYMBOL_HISTORICAL_DRAG"
  | "ROUTE_SAMPLE_TOO_SMALL"
  | "FILL_REALITY_MISMATCH"
  | "DIRECTION_BIAS_DRAG"
  | "UNKNOWN";

/** One slice of calibration evidence — avg realized vs avg expected for some group. */
export interface CalibrationGroupStat {
  count: number;
  avgExpectedNetR: number | null;
  avgRealizedNetR: number | null;
  /** avgExpected - avgRealized; positive = planner overestimated. */
  expectationError: number | null;
  diagnosis?: CalibrationDiagnosisCode[];
}

/**
 * Evidence map passed into computeCalibratedExpectedR.
 * Keys are exact strings the caller computes from shadow positions.
 *
 *   combos:        key = `${entry}__${exit}`
 *   symbolCombos:  key = `${symbol}__${entry}__${exit}`
 *   symbols:       key = symbol
 *   directions:    key = direction
 *   routeModes:    key = routeMode
 *   entries:       key = entry variant
 *   exits:         key = exit variant
 */
export interface CalibrationEvidence {
  combos: Record<string, CalibrationGroupStat>;
  symbolCombos: Record<string, CalibrationGroupStat>;
  symbols: Record<string, CalibrationGroupStat>;
  directions: Record<string, CalibrationGroupStat>;
  routeModes: Record<string, CalibrationGroupStat>;
  entries: Record<string, CalibrationGroupStat>;
  exits: Record<string, CalibrationGroupStat>;
}

export interface CalibratedExpectancyInput {
  rawExpectedGrossR: number | null;
  rawExpectedNetR: number | null;
  selectedEntryVariant: ExecutionEntryVariant;
  selectedExitVariant: ShadowPositionVariant;
  symbol: string;
  direction: "LONG" | "SHORT";
  routeMode: ProfitRouteMode;
  selectionSource: "replay" | "heuristic_fallback";
  evidence: CalibrationEvidence;
}

export interface CalibratedExpectancyResult {
  rawExpectedNetR: number | null;
  calibratedExpectedNetR: number | null;
  /** Negative value = downward adjustment applied. */
  calibrationPenaltyR: number;
  calibrationConfidence: CalibrationConfidence;
  calibrationSampleSize: number;
  calibrationSourceUsed: CalibrationSourceUsed;
  calibrationDiagnosisCodes: CalibrationDiagnosisCode[];
  calibrationVerdict: CalibrationVerdict;
  calibrationExplanation: string;
}

const MIN_USABLE_SAMPLE = 5;
const PROVISIONAL_SAMPLE = 30;
const MAX_DOWNWARD_PENALTY_R = 2.5;
const MAX_UPWARD_BOOST_R = 0.5;

const STRONG_PENALTY_DIAGNOSES: ReadonlySet<CalibrationDiagnosisCode> = new Set([
  "HEURISTIC_OVERCONFIDENT",
  "COST_DRAG_UNDERCOUNTED",
  "TP_NOT_PROFITABLE_AFTER_COST",
  "RUNNER_GIVEBACK",
  "SYMBOL_HISTORICAL_DRAG",
]);

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function confidenceFor(sample: number): CalibrationConfidence {
  if (sample >= PROVISIONAL_SAMPLE) return "HIGH";
  if (sample >= MIN_USABLE_SAMPLE) return "MEDIUM";
  return "LOW";
}

interface Resolved {
  group: CalibrationGroupStat;
  source: CalibrationSourceUsed;
  contextDiagnoses: CalibrationDiagnosisCode[];
}

function resolveGroup(input: CalibratedExpectancyInput): Resolved | null {
  const { evidence, symbol, selectedEntryVariant, selectedExitVariant, routeMode } = input;

  const comboKey = `${selectedEntryVariant}__${selectedExitVariant}`;
  const symbolComboKey = `${symbol}__${selectedEntryVariant}__${selectedExitVariant}`;

  const combo = evidence.combos[comboKey];
  const symbolCombo = evidence.symbolCombos[symbolComboKey];
  const symbolStat = evidence.symbols[symbol];
  const entryStat = evidence.entries[selectedEntryVariant];
  const exitStat = evidence.exits[selectedExitVariant];
  const routeStat = evidence.routeModes[routeMode];

  const contextDiagnoses: CalibrationDiagnosisCode[] = [];
  for (const g of [combo, symbolCombo, symbolStat, entryStat, exitStat, routeStat]) {
    if (g?.diagnosis) {
      for (const code of g.diagnosis) {
        if (!contextDiagnoses.includes(code)) contextDiagnoses.push(code);
      }
    }
  }

  // Prefer combo-level (≥5 samples) per spec.
  if (combo && combo.count >= MIN_USABLE_SAMPLE) {
    return { group: combo, source: "combo", contextDiagnoses };
  }
  // Else symbol+combo if it has enough.
  if (symbolCombo && symbolCombo.count >= MIN_USABLE_SAMPLE) {
    return { group: symbolCombo, source: "symbol+combo", contextDiagnoses };
  }
  // Else marginal entry+exit average (synthesize from entry & exit stats).
  if (entryStat && exitStat) {
    const sample = Math.min(entryStat.count, exitStat.count);
    if (sample >= MIN_USABLE_SAMPLE) {
      // Average the two marginal errors. This is a coarse proxy but better
      // than nothing — the combo-level call is the preferred path.
      const errA = entryStat.expectationError ?? 0;
      const errB = exitStat.expectationError ?? 0;
      const expA = entryStat.avgExpectedNetR ?? 0;
      const expB = exitStat.avgExpectedNetR ?? 0;
      const realA = entryStat.avgRealizedNetR ?? 0;
      const realB = exitStat.avgRealizedNetR ?? 0;
      const synth: CalibrationGroupStat = {
        count: sample,
        avgExpectedNetR: r4((expA + expB) / 2),
        avgRealizedNetR: r4((realA + realB) / 2),
        expectationError: r4((errA + errB) / 2),
      };
      return { group: synth, source: "entry+exit", contextDiagnoses };
    }
  }
  // Else routeMode-level fallback.
  if (routeStat && routeStat.count >= MIN_USABLE_SAMPLE) {
    return { group: routeStat, source: "routeMode", contextDiagnoses };
  }

  // Even with a tiny combo sample we still return it for low-confidence
  // diagnostic context, but the caller will not hard-downgrade on it.
  if (combo) return { group: combo, source: "combo", contextDiagnoses };
  if (symbolCombo) return { group: symbolCombo, source: "symbol+combo", contextDiagnoses };
  if (routeStat) return { group: routeStat, source: "routeMode", contextDiagnoses };
  return null;
}

export function computeCalibratedExpectedR(
  input: CalibratedExpectancyInput,
): CalibratedExpectancyResult {
  const raw = input.rawExpectedNetR;
  const resolved = resolveGroup(input);

  // No evidence at all
  if (!resolved) {
    return {
      rawExpectedNetR: raw,
      calibratedExpectedNetR: raw,
      calibrationPenaltyR: 0,
      calibrationConfidence: "LOW",
      calibrationSampleSize: 0,
      calibrationSourceUsed: "none",
      calibrationDiagnosisCodes: [],
      calibrationVerdict: "INSUFFICIENT_SAMPLE",
      calibrationExplanation:
        "No calibration evidence available; raw heuristic expected R is used as-is. Treat with caution.",
    };
  }

  const { group, source, contextDiagnoses } = resolved;
  const sample = group.count;
  const confidence = confidenceFor(sample);

  // Pull all diagnoses (group + ancillary). De-dupe.
  const diagnosis: CalibrationDiagnosisCode[] = [];
  for (const c of group.diagnosis ?? []) if (!diagnosis.includes(c)) diagnosis.push(c);
  for (const c of contextDiagnoses) if (!diagnosis.includes(c)) diagnosis.push(c);

  // Sample < 5: do not hard-downgrade. Keep raw, mark LOW confidence.
  if (sample < MIN_USABLE_SAMPLE) {
    return {
      rawExpectedNetR: raw,
      calibratedExpectedNetR: raw,
      calibrationPenaltyR: 0,
      calibrationConfidence: "LOW",
      calibrationSampleSize: sample,
      calibrationSourceUsed: source,
      calibrationDiagnosisCodes: diagnosis,
      calibrationVerdict: "INSUFFICIENT_SAMPLE",
      calibrationExplanation: `Only ${sample} closed calibration sample(s) from ${source}; not enough to debias yet.`,
    };
  }

  const expectationError = group.expectationError ?? 0;
  const groupRealized = group.avgRealizedNetR ?? 0;

  // Base adjustment: shift raw expected R toward the group's realized expectancy.
  // adjustment is negative when planner overestimated (expectationError > 0).
  let adjustment = -expectationError;

  // Amplify downward penalty when STRONG_PENALTY_DIAGNOSES are present.
  // Caps still apply below.
  const hasStrongPenalty = diagnosis.some((c) => STRONG_PENALTY_DIAGNOSES.has(c));
  if (hasStrongPenalty && adjustment < 0) {
    // Scale up the penalty by 1.25× when the group has known structural drag.
    adjustment *= 1.25;
  }

  // Block positive boost unless sample ≥ 30 and group realized net R is positive.
  if (adjustment > 0) {
    const allowBoost = sample >= PROVISIONAL_SAMPLE && groupRealized > 0;
    if (!allowBoost) adjustment = 0;
  }

  // Cap adjustments.
  adjustment = clamp(adjustment, -MAX_DOWNWARD_PENALTY_R, MAX_UPWARD_BOOST_R);

  const calibrated =
    raw === null ? null : r4(raw + adjustment);
  const penalty = r4(adjustment);

  let verdict: CalibrationVerdict;
  if (raw !== null && raw > 0 && calibrated !== null && calibrated <= 0) {
    verdict = "RAW_EDGE_NOT_VALIDATED";
  } else if (calibrated !== null && calibrated > 0) {
    verdict = "CALIBRATED_POSITIVE";
  } else if (calibrated !== null && calibrated <= 0) {
    verdict = "CALIBRATED_NEGATIVE";
  } else {
    verdict = "INSUFFICIENT_SAMPLE";
  }

  const explanation = (() => {
    const errStr = expectationError.toFixed(3);
    const realStr = groupRealized.toFixed(3);
    const adjStr = penalty.toFixed(3);
    if (verdict === "RAW_EDGE_NOT_VALIDATED") {
      return `Raw heuristic edge has historically overestimated realized R on this ${source} (avg realized ${realStr}R, error ${errStr}R, n=${sample}). Calibrated R adjusted by ${adjStr}R. Treat as evidence collection, not profit route.`;
    }
    if (verdict === "CALIBRATED_POSITIVE") {
      return `Calibration from ${source} (n=${sample}, avg realized ${realStr}R) supports the heuristic. Adjustment ${adjStr}R applied.`;
    }
    if (verdict === "CALIBRATED_NEGATIVE") {
      return `Calibration from ${source} (n=${sample}, avg realized ${realStr}R) indicates negative expectancy. Adjustment ${adjStr}R applied.`;
    }
    return `Calibration sample insufficient (n=${sample}); raw heuristic R retained.`;
  })();

  return {
    rawExpectedNetR: raw,
    calibratedExpectedNetR: calibrated,
    calibrationPenaltyR: penalty,
    calibrationConfidence: confidence,
    calibrationSampleSize: sample,
    calibrationSourceUsed: source,
    calibrationDiagnosisCodes: diagnosis,
    calibrationVerdict: verdict,
    calibrationExplanation: explanation,
  };
}

/** Convenience builder for an empty evidence object — useful in tests and fallbacks. */
export function emptyCalibrationEvidence(): CalibrationEvidence {
  return {
    combos: {},
    symbolCombos: {},
    symbols: {},
    directions: {},
    routeModes: {},
    entries: {},
    exits: {},
  };
}

import type {
  CalibrationEvidence,
  CalibrationGroupStat,
  CalibrationDiagnosisCode as SharedCalibrationDiagnosisCode,
  ExecutionEntryVariant,
  ProfitRouteMode,
  ShadowPosition,
  ShadowPositionVariant,
  ShadowVariantPosition,
  VariantSelectionSnapshot,
} from "@dtc/shared";
import { classifyEvidenceEra, emptyCalibrationEvidence } from "@dtc/shared";

/**
 * EXPECTATION CALIBRATION AUDIT
 *
 * Compares what the planner expected at selection time against what shadow
 * execution actually realized after close. Reporting only — no effect on
 * routing, scoring, scanner ranking, profit-routing, execution selection,
 * shadow execution, live readiness gates, or trade caps.
 *
 * Inclusion:
 *   - Closed primary-variant shadow positions only (state CLOSED on the
 *     primaryVariant, closeReason != NO_FILL).
 *   - Open/pending positions are excluded from realized calibration but
 *     counted separately in `fillStatus` aggregates if needed by callers.
 *   - All routeModes are included in the underlying dataset; the
 *     `byRouteMode` breakdown separates RESEARCH_ONLY from
 *     DATA_COLLECTION / PROFIT_CANDIDATE so it doesn't pollute the
 *     candidate-route calibration view.
 */

export type SampleTier = "early" | "provisional" | "usable";

export type DiagnosisCode =
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

export interface CalibrationPoint {
  positionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  selectedEntryVariant: ExecutionEntryVariant | string;
  selectedExitVariant: ShadowPositionVariant | string;
  routeMode: ProfitRouteMode | null;
  selectionSource: VariantSelectionSnapshot["selectionSource"] | null;
  routeScore: number | null;
  routeReasonCodes: string[];
  expectedGrossR: number | null;
  expectedNetR: number | null;
  costR: number | null;
  feeSlippageR: number | null;
  spreadR: number | null;
  stopDistanceBps: number | null;
  realizedGrossR: number | null;
  realizedNetR: number | null;
  closeReason: string;
  tp1Hit: boolean;
  tp2Hit: boolean;
  slHit: boolean;
  closedAt: string | null;
  fillStatus: "FILLED" | "NO_FILL";
  /** Calibration-adjusted R at the time the plan was emitted (if available). */
  calibratedExpectedNetR?: number | null;
  /** Era classified from the persisted plan shape; lets us split post-calibration from legacy. */
  evidenceEra?: "LEGACY_PRE_ROUTING" | "POST_ROUTING_PRE_CALIBRATION" | "POST_CALIBRATION" | "UNKNOWN";
}

export interface CalibrationGroup {
  key: string;
  /** Optional second key (e.g. exit when entry is the primary key). */
  subKey?: string;
  count: number;
  avgExpectedNetR: number | null;
  avgRealizedNetR: number | null;
  /** avgExpectedNetR - avgRealizedNetR; positive = overestimation. */
  expectationError: number | null;
  /** % of points where expectedNetR > 0 but realizedNetR <= 0. */
  overestimationRate: number;
  /** % where expectedNetR >= +0.5 but realizedNetR <= -0.5. */
  severeOverestimationRate: number;
  hitRateWhenExpectedPositive: number | null;
  avgRealizedWhenExpectedPositive: number | null;
  avgRealizedWhenExpectedNegative: number | null;
  correlation: number | null;
  sampleTier: SampleTier;
  /** Diagnostic context used by classifier (group-local averages). */
  context: {
    avgCostR: number | null;
    avgStopDistanceBps: number | null;
    tp1HitRate: number;
    slHitRate: number;
    noFillRate: number;
    runnerExitShare: number;
  };
  diagnosis: DiagnosisCode[];
}

export interface ExpectationCalibrationReport {
  generatedAt: string;
  scope: {
    closedPrimaryVariantsOnly: true;
    includesAllRouteModes: true;
    notes: string[];
  };
  total: CalibrationGroup;
  byEntryVariant: CalibrationGroup[];
  byExitVariant: CalibrationGroup[];
  byCombo: CalibrationGroup[];
  bySymbol: CalibrationGroup[];
  byDirection: CalibrationGroup[];
  byRouteMode: CalibrationGroup[];
  bySelectionSource: CalibrationGroup[];
  byRouteReasonCode: CalibrationGroup[];
  topOverestimatedCombos: CalibrationGroup[];
  topOverestimatedSymbols: CalibrationGroup[];
  topOverestimatedDirections: CalibrationGroup[];
  topOverestimatedRouteModes: CalibrationGroup[];
  topAccurateCombos: CalibrationGroup[];
  topUnderestimatedCombos: CalibrationGroup[];
  /** Raw per-trade data — useful for the candidate-detail warning lookup. */
  points: CalibrationPoint[];
  /** Post-calibration-era performance summary; tracks whether the debiasing is working. */
  postCalibration: PostCalibrationSummary;
}

export interface PostCalibrationSummary {
  postCalibrationClosedSample: number;
  postCalibrationAvgRawExpectedR: number | null;
  postCalibrationAvgCalibratedExpectedR: number | null;
  postCalibrationAvgRealizedR: number | null;
  /** raw - realized; positive = still overestimated. */
  postCalibrationExpectationErrorRaw: number | null;
  /** calibrated - realized. */
  postCalibrationExpectationErrorCalibrated: number | null;
  /** Reduction in absolute error vs raw, expressed as 0..1 (or null if not computable). */
  rawVsCalibratedErrorImprovement: number | null;
  notes: string[];
}

const MIN_GROUP_SAMPLE = 3;
const RUNNER_EXIT_VARIANTS = new Set<string>([
  "tp1_50_tp2_runner",
  "tp1_70_runner30",
  "trail_after_tp1",
  "kronos_runner_exit",
]);

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function tierFromCount(n: number): SampleTier {
  if (n > 100) return "usable";
  if (n >= 30) return "provisional";
  return "early";
}

function primaryClosedVariant(p: ShadowPosition): ShadowVariantPosition | null {
  const primary = p.variants.find((v) => v.variant === p.primaryVariant);
  if (!primary) return null;
  if (primary.state !== "CLOSED") return null;
  if (primary.closeReason === "NO_FILL") return null;
  return primary;
}

export function extractCalibrationPoints(positions: ShadowPosition[]): CalibrationPoint[] {
  const out: CalibrationPoint[] = [];
  for (const p of positions) {
    const primary = primaryClosedVariant(p);
    if (!primary) continue;
    const selection = p.variantSelection ?? null;
    out.push({
      positionId: p.id,
      symbol: p.symbol,
      direction: p.direction,
      selectedEntryVariant: selection?.selectedEntryVariant ?? p.selectedEntryVariant ?? "unknown",
      selectedExitVariant: selection?.selectedExitVariant ?? p.selectedExitVariant ?? "unknown",
      routeMode: (selection?.routeMode as ProfitRouteMode | undefined) ?? null,
      selectionSource: selection?.selectionSource ?? null,
      routeScore: selection?.routeScore ?? null,
      routeReasonCodes: selection?.routeReasonCodes ?? [],
      expectedGrossR: selection?.expectedGrossR ?? null,
      expectedNetR: selection?.expectedNetR ?? null,
      costR: p.costR ?? selection?.costR ?? null,
      feeSlippageR: p.feeSlippageR ?? selection?.feeSlippageR ?? null,
      spreadR: p.spreadR ?? selection?.spreadR ?? null,
      stopDistanceBps: p.stopDistanceBps ?? selection?.stopDistanceBps ?? null,
      realizedGrossR: primary.realizedGrossR,
      realizedNetR: primary.realizedNetR,
      closeReason: primary.closeReason,
      tp1Hit: primary.tp1Hit,
      tp2Hit: primary.tp2Hit,
      slHit: primary.closeReason === "SL" || primary.closeReason === "BREAKEVEN",
      closedAt: primary.closedAt,
      fillStatus: "FILLED",
      calibratedExpectedNetR: selection?.calibratedExpectedNetR ?? null,
      evidenceEra: classifyEvidenceEra(p),
    });
  }
  return out;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return r4(values.reduce((s, v) => s + v, 0) / values.length);
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const xm = xs.reduce((s, v) => s + v, 0) / xs.length;
  const ym = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - xm;
    const dy = ys[i] - ym;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return null;
  return r4(num / denom);
}

function summarizeGroup(
  key: string,
  points: CalibrationPoint[],
  subKey?: string,
): CalibrationGroup {
  const count = points.length;
  const expected = points.map((p) => p.expectedNetR).filter((v): v is number => v !== null);
  const realized = points.map((p) => p.realizedNetR).filter((v): v is number => v !== null);
  const avgExpectedNetR = mean(expected);
  const avgRealizedNetR = mean(realized);
  const expectationError =
    avgExpectedNetR === null || avgRealizedNetR === null
      ? null
      : r4(avgExpectedNetR - avgRealizedNetR);

  const overestimated = points.filter(
    (p) =>
      p.expectedNetR !== null &&
      p.expectedNetR > 0 &&
      p.realizedNetR !== null &&
      p.realizedNetR <= 0,
  );
  const severe = points.filter(
    (p) =>
      p.expectedNetR !== null &&
      p.expectedNetR >= 0.5 &&
      p.realizedNetR !== null &&
      p.realizedNetR <= -0.5,
  );
  const overestimationRate = count === 0 ? 0 : r4(overestimated.length / count);
  const severeOverestimationRate = count === 0 ? 0 : r4(severe.length / count);

  const expectedPositive = points.filter((p) => (p.expectedNetR ?? 0) > 0);
  const hitRateWhenExpectedPositive =
    expectedPositive.length === 0
      ? null
      : r4(
          expectedPositive.filter((p) => (p.realizedNetR ?? 0) > 0).length /
            expectedPositive.length,
        );
  const avgRealizedWhenExpectedPositive = mean(
    expectedPositive.map((p) => p.realizedNetR).filter((v): v is number => v !== null),
  );
  const expectedNegative = points.filter((p) => (p.expectedNetR ?? 0) < 0);
  const avgRealizedWhenExpectedNegative = mean(
    expectedNegative.map((p) => p.realizedNetR).filter((v): v is number => v !== null),
  );

  // Pair (expected, realized) only when both present; correlation needs both.
  const pairs: Array<[number, number]> = [];
  for (const p of points) {
    if (p.expectedNetR !== null && p.realizedNetR !== null) {
      pairs.push([p.expectedNetR, p.realizedNetR]);
    }
  }
  const correlation =
    pairs.length >= 2
      ? pearson(pairs.map((x) => x[0]), pairs.map((x) => x[1]))
      : null;

  // Diagnostic context
  const costRs = points.map((p) => p.costR).filter((v): v is number => v !== null);
  const stopBps = points.map((p) => p.stopDistanceBps).filter((v): v is number => v !== null);
  const avgCostR = mean(costRs);
  const avgStopDistanceBps = mean(stopBps);
  const tp1HitRate = count === 0 ? 0 : r4(points.filter((p) => p.tp1Hit).length / count);
  const slHitRate = count === 0 ? 0 : r4(points.filter((p) => p.slHit).length / count);
  // FILL_REALITY_MISMATCH: noFillRate isn't observable here because we already
  // filter to FILLED primary closes. Always 0 unless future code feeds NO_FILL
  // points in. Kept for shape parity with the spec.
  const noFillRate = 0;
  const runnerExitShare =
    count === 0
      ? 0
      : r4(
          points.filter((p) => RUNNER_EXIT_VARIANTS.has(String(p.selectedExitVariant))).length / count,
        );

  // Diagnosis classification — deterministic rules only.
  const diagnosis: DiagnosisCode[] = [];
  if (count < 5) diagnosis.push("ROUTE_SAMPLE_TOO_SMALL");

  if (
    (avgExpectedNetR ?? 0) > 0 &&
    (avgRealizedNetR ?? 0) < 0 &&
    severeOverestimationRate >= 0.2
  ) {
    diagnosis.push("HEURISTIC_OVERCONFIDENT");
  }

  if (
    avgCostR !== null &&
    avgCostR >= 0.3 &&
    expectationError !== null &&
    expectationError > 0.1
  ) {
    diagnosis.push("COST_DRAG_UNDERCOUNTED");
  }

  if (avgStopDistanceBps !== null && avgStopDistanceBps < 20 && slHitRate > 0.4) {
    diagnosis.push("STOP_TOO_TIGHT");
  }

  if (tp1HitRate > 0.5 && (avgRealizedNetR ?? 0) < 0) {
    diagnosis.push("TP_NOT_PROFITABLE_AFTER_COST");
  }

  // RUNNER_GIVEBACK: meaningful only when the cohort sits on a runner exit and
  // TP1 was reached but realized still went red (the runner gave back the TP1
  // partial). For TP1_FULL routes this code is irrelevant by construction.
  if (
    runnerExitShare > 0.5 &&
    tp1HitRate > 0.4 &&
    (avgRealizedNetR ?? 0) < 0
  ) {
    diagnosis.push("RUNNER_GIVEBACK");
  }

  if (key.startsWith("symbol:") && (avgRealizedNetR ?? 0) < -0.1) {
    diagnosis.push("SYMBOL_HISTORICAL_DRAG");
  }

  if (key.startsWith("direction:") && (avgRealizedNetR ?? 0) < -0.1) {
    diagnosis.push("DIRECTION_BIAS_DRAG");
  }

  if (noFillRate > 0.3) {
    diagnosis.push("FILL_REALITY_MISMATCH");
  }

  if (diagnosis.length === 0) diagnosis.push("UNKNOWN");

  return {
    key,
    subKey,
    count,
    avgExpectedNetR,
    avgRealizedNetR,
    expectationError,
    overestimationRate,
    severeOverestimationRate,
    hitRateWhenExpectedPositive,
    avgRealizedWhenExpectedPositive,
    avgRealizedWhenExpectedNegative,
    correlation,
    sampleTier: tierFromCount(count),
    context: { avgCostR, avgStopDistanceBps, tp1HitRate, slHitRate, noFillRate, runnerExitShare },
    diagnosis,
  };
}

function groupBy<K extends string>(
  points: CalibrationPoint[],
  keyOf: (p: CalibrationPoint) => K | null,
): Map<K, CalibrationPoint[]> {
  const map = new Map<K, CalibrationPoint[]>();
  for (const p of points) {
    const k = keyOf(p);
    if (k === null) continue;
    const arr = map.get(k) ?? [];
    arr.push(p);
    map.set(k, arr);
  }
  return map;
}

function asGroups<K extends string>(
  prefix: string,
  groups: Map<K, CalibrationPoint[]>,
  splitOn?: string,
): CalibrationGroup[] {
  const out: CalibrationGroup[] = [];
  for (const [k, pts] of groups) {
    const fullKey = `${prefix}:${k}`;
    let subKey: string | undefined;
    if (splitOn) {
      const parts = String(k).split(splitOn);
      subKey = parts[1];
    }
    out.push(summarizeGroup(fullKey, pts, subKey));
  }
  return out;
}

function buildTopOverestimated(groups: CalibrationGroup[], limit = 5): CalibrationGroup[] {
  return groups
    .filter((g) => g.count >= MIN_GROUP_SAMPLE && g.expectationError !== null && g.expectationError > 0)
    .sort((a, b) => (b.expectationError ?? 0) - (a.expectationError ?? 0))
    .slice(0, limit);
}

function buildTopAccurate(groups: CalibrationGroup[], limit = 5): CalibrationGroup[] {
  return groups
    .filter((g) => g.count >= MIN_GROUP_SAMPLE && g.expectationError !== null)
    .sort((a, b) => Math.abs(a.expectationError ?? 0) - Math.abs(b.expectationError ?? 0))
    .slice(0, limit);
}

function buildTopUnderestimated(groups: CalibrationGroup[], limit = 5): CalibrationGroup[] {
  return groups
    .filter((g) => g.count >= MIN_GROUP_SAMPLE && g.expectationError !== null && g.expectationError < 0)
    .sort((a, b) => (a.expectationError ?? 0) - (b.expectationError ?? 0))
    .slice(0, limit);
}

export interface ExpectationCalibrationInput {
  positions: ShadowPosition[];
}

export function buildExpectationCalibrationReport(
  input: ExpectationCalibrationInput,
  now: Date = new Date(),
): ExpectationCalibrationReport {
  const generatedAt = now.toISOString();
  const points = extractCalibrationPoints(input.positions);

  const total = summarizeGroup("total", points);

  const byEntryVariant = asGroups("entry", groupBy(points, (p) => String(p.selectedEntryVariant)));
  const byExitVariant = asGroups("exit", groupBy(points, (p) => String(p.selectedExitVariant)));
  const byCombo = asGroups(
    "combo",
    groupBy(points, (p) => `${p.selectedEntryVariant}__${p.selectedExitVariant}`),
    "__",
  );
  const bySymbol = asGroups("symbol", groupBy(points, (p) => p.symbol));
  const byDirection = asGroups("direction", groupBy(points, (p) => p.direction));
  const byRouteMode = asGroups(
    "routeMode",
    groupBy(points, (p) => (p.routeMode ?? "UNKNOWN") as string),
  );
  const bySelectionSource = asGroups(
    "source",
    groupBy(points, (p) => (p.selectionSource ?? "unknown") as string),
  );

  // For routeReasonCode breakdown, a single point can fall into multiple codes.
  const reasonCodePoints = new Map<string, CalibrationPoint[]>();
  for (const p of points) {
    for (const code of p.routeReasonCodes) {
      const arr = reasonCodePoints.get(code) ?? [];
      arr.push(p);
      reasonCodePoints.set(code, arr);
    }
  }
  const byRouteReasonCode: CalibrationGroup[] = [];
  for (const [code, pts] of reasonCodePoints) {
    byRouteReasonCode.push(summarizeGroup(`reason:${code}`, pts));
  }

  return {
    generatedAt,
    scope: {
      closedPrimaryVariantsOnly: true,
      includesAllRouteModes: true,
      notes: [
        "Closed primary-variant shadow positions only.",
        "Open/pending positions excluded from realized calibration.",
        "RESEARCH_ONLY is included in the dataset but separated in byRouteMode.",
        "Diagnosis codes are deterministic heuristics — no LLM, no live trading effect.",
        "Expected R is the planner's heuristic. This report measures whether the heuristic is calibrated.",
      ],
    },
    total,
    byEntryVariant,
    byExitVariant,
    byCombo,
    bySymbol,
    byDirection,
    byRouteMode,
    bySelectionSource,
    byRouteReasonCode,
    topOverestimatedCombos: buildTopOverestimated(byCombo),
    topOverestimatedSymbols: buildTopOverestimated(bySymbol),
    topOverestimatedDirections: buildTopOverestimated(byDirection),
    topOverestimatedRouteModes: buildTopOverestimated(byRouteMode),
    topAccurateCombos: buildTopAccurate(byCombo),
    topUnderestimatedCombos: buildTopUnderestimated(byCombo),
    points,
    postCalibration: buildPostCalibrationSummary(points),
  };
}

function buildPostCalibrationSummary(points: CalibrationPoint[]): PostCalibrationSummary {
  // Only points stamped POST_CALIBRATION OR points that have calibration fields
  // populated — both indicate the calibrated planner was in effect.
  const subset = points.filter(
    (p) =>
      p.evidenceEra === "POST_CALIBRATION" ||
      (p.calibratedExpectedNetR !== undefined && p.calibratedExpectedNetR !== null),
  );
  const count = subset.length;
  if (count === 0) {
    return {
      postCalibrationClosedSample: 0,
      postCalibrationAvgRawExpectedR: null,
      postCalibrationAvgCalibratedExpectedR: null,
      postCalibrationAvgRealizedR: null,
      postCalibrationExpectationErrorRaw: null,
      postCalibrationExpectationErrorCalibrated: null,
      rawVsCalibratedErrorImprovement: null,
      notes: ["No post-calibration closed sample yet. Run a few scans and let trades close."],
    };
  }
  const raws = subset
    .map((p) => p.expectedNetR)
    .filter((v): v is number => v !== null);
  const cals = subset
    .map((p) => p.calibratedExpectedNetR)
    .filter((v): v is number => typeof v === "number");
  const reals = subset
    .map((p) => p.realizedNetR)
    .filter((v): v is number => v !== null);

  const avgRaw = mean(raws);
  const avgCal = mean(cals);
  const avgReal = mean(reals);
  const errRaw =
    avgRaw === null || avgReal === null ? null : Math.round((avgRaw - avgReal) * 10000) / 10000;
  const errCal =
    avgCal === null || avgReal === null ? null : Math.round((avgCal - avgReal) * 10000) / 10000;
  const improvement =
    errRaw === null || errCal === null || Math.abs(errRaw) === 0
      ? null
      : Math.round(((Math.abs(errRaw) - Math.abs(errCal)) / Math.abs(errRaw)) * 10000) / 10000;

  return {
    postCalibrationClosedSample: count,
    postCalibrationAvgRawExpectedR: avgRaw,
    postCalibrationAvgCalibratedExpectedR: avgCal,
    postCalibrationAvgRealizedR: avgReal,
    postCalibrationExpectationErrorRaw: errRaw,
    postCalibrationExpectationErrorCalibrated: errCal,
    rawVsCalibratedErrorImprovement: improvement,
    notes: [
      "Subset = closed primary trades emitted under the POST_CALIBRATION decision policy.",
      "Improvement = 1 − |calibratedError| / |rawError|. Positive = calibration reduced overestimation.",
    ],
  };
}

/**
 * Project a CalibrationGroup into the lighter CalibrationGroupStat shape used
 * by the shared `computeCalibratedExpectedR` helper. Strips local-only fields
 * so the shared module stays decoupled from the API report shape.
 */
function projectGroup(g: CalibrationGroup): CalibrationGroupStat {
  return {
    count: g.count,
    avgExpectedNetR: g.avgExpectedNetR,
    avgRealizedNetR: g.avgRealizedNetR,
    expectationError: g.expectationError,
    diagnosis: g.diagnosis as SharedCalibrationDiagnosisCode[],
  };
}

function stripPrefix(key: string): string {
  const idx = key.indexOf(":");
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/**
 * Build the CalibrationEvidence map the execution-plan calibration step expects.
 * Builds a fresh per-symbol+combo group on top of the report's regular byCombo /
 * bySymbol / byDirection / byRouteMode breakdowns.
 */
export function buildCalibrationEvidenceFromPositions(
  positions: ShadowPosition[],
  now: Date = new Date(),
): CalibrationEvidence {
  const report = buildExpectationCalibrationReport({ positions }, now);
  const evidence = emptyCalibrationEvidence();

  for (const g of report.byCombo) {
    evidence.combos[stripPrefix(g.key)] = projectGroup(g);
  }
  for (const g of report.bySymbol) {
    evidence.symbols[stripPrefix(g.key)] = projectGroup(g);
  }
  for (const g of report.byDirection) {
    evidence.directions[stripPrefix(g.key)] = projectGroup(g);
  }
  for (const g of report.byRouteMode) {
    evidence.routeModes[stripPrefix(g.key)] = projectGroup(g);
  }
  for (const g of report.byEntryVariant) {
    evidence.entries[stripPrefix(g.key)] = projectGroup(g);
  }
  for (const g of report.byExitVariant) {
    evidence.exits[stripPrefix(g.key)] = projectGroup(g);
  }

  // Build symbol+combo groups directly from points (not in the standard report).
  const symbolComboGroups = new Map<string, CalibrationPoint[]>();
  for (const p of report.points) {
    const key = `${p.symbol}__${p.selectedEntryVariant}__${p.selectedExitVariant}`;
    const arr = symbolComboGroups.get(key) ?? [];
    arr.push(p);
    symbolComboGroups.set(key, arr);
  }
  for (const [key, pts] of symbolComboGroups) {
    const summary = summarizeGroup(`symbolCombo:${key}`, pts);
    evidence.symbolCombos[key] = projectGroup(summary);
  }

  return evidence;
}

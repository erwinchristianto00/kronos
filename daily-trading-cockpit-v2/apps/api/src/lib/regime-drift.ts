import type { EvidenceEra, ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra } from "@dtc/shared";

/**
 * REGIME DRIFT / LEAK DETECTOR
 *
 * Reads closed shadow trades and flags routes / symbols / regimes whose
 * realized expectancy is degrading. Read-only diagnostic — no effect on
 * routing, scanner, shadow execution, calibration, or live readiness.
 *
 * "Drift" definitions used here:
 *   recent7d   — closed within the last 7 days
 *   baseline   — closed older than 7 days, within the prior 60 days
 *   driftDelta — recent − baseline (negative = decay)
 *
 * Sample guards: a group must have ≥15 closed baseline AND ≥5 closed recent
 * to be evaluated; otherwise SAMPLE_TOO_SMALL_FOR_DRIFT is emitted.
 */

export type DriftStatus = "STABLE" | "WATCH" | "DEGRADED";

export type DriftWarningCode =
  | "REGIME_EDGE_DECAY"
  | "ROUTE_EDGE_DECAY"
  | "SYMBOL_EDGE_REVERSAL"
  | "DIRECTION_EDGE_DECAY"
  | "CALIBRATION_DRIFT"
  | "SAMPLE_TOO_SMALL_FOR_DRIFT"
  | "NO_REGIME_BASELINE";

export interface DriftGroup {
  key: string;
  closedCount: number;
  avgRealizedNetR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  recentClosedCount: number;
  recent7dNetAvgR: number | null;
  baselineClosedCount: number;
  priorBaselineNetAvgR: number | null;
  driftDeltaR: number | null;
  warnings: DriftWarningCode[];
}

export interface DriftWarning {
  code: DriftWarningCode;
  scope: "route" | "symbol" | "direction" | "regime" | "calibration";
  key: string;
  message: string;
  driftDeltaR: number | null;
  recentClosedCount: number;
  baselineClosedCount: number;
}

export interface RegimeDriftReport {
  generatedAt: string;
  overallStatus: DriftStatus;
  routeDrift: DriftGroup[];
  symbolDrift: DriftGroup[];
  directionDrift: DriftGroup[];
  regimeBreakdown: DriftGroup[];
  /** Drift in calibration accuracy: did expectation error widen recently? */
  calibrationDriftSummary: {
    baselineErrorR: number | null;
    recentErrorR: number | null;
    driftDeltaR: number | null;
    recentClosedCount: number;
    baselineClosedCount: number;
    warning: DriftWarningCode | null;
  };
  topWarnings: DriftWarning[];
  notes: string[];
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BASELINE_LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;
const MIN_BASELINE = 15;
const MIN_RECENT = 5;
const POSITIVE_BASELINE_THRESHOLD = 0.1; // baseline must clear this to be considered "had edge"
const RECENT_NEGATIVE_THRESHOLD = 0; // recent below this counts as decay
const CALIBRATION_DRIFT_DELTA_R = 0.25; // worsening of |error| by this much triggers warning

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function closedVariantsOf(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

interface ClosedRecord {
  closedAt: number;
  netR: number;
  tp1Hit: boolean;
  slHit: boolean;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: string;
  exit: string;
  regime: string | null;
  era: EvidenceEra;
  expectedNetR: number | null;
  calibratedExpectedNetR: number | null;
}

function extract(positions: ShadowPosition[]): ClosedRecord[] {
  const out: ClosedRecord[] = [];
  for (const p of positions) {
    const era = classifyEvidenceEra(p);
    for (const v of closedVariantsOf(p)) {
      const ts = v.closedAt ? new Date(v.closedAt).getTime() : 0;
      if (!ts) continue;
      out.push({
        closedAt: ts,
        netR: v.realizedNetR,
        tp1Hit: v.tp1Hit,
        slHit: v.closeReason === "SL" || v.closeReason === "BREAKEVEN",
        symbol: p.symbol,
        direction: p.direction,
        entry: p.variantSelection?.selectedEntryVariant ?? p.selectedEntryVariant ?? "unknown",
        exit: p.variantSelection?.selectedExitVariant ?? p.selectedExitVariant ?? "unknown",
        regime: p.marketRegime ?? null,
        era,
        expectedNetR: p.variantSelection?.expectedNetR ?? null,
        calibratedExpectedNetR: p.variantSelection?.calibratedExpectedNetR ?? null,
      });
    }
  }
  return out;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return r4(xs.reduce((s, v) => s + v, 0) / xs.length);
}

function pf(records: ClosedRecord[]): number | null {
  const wins = records.filter((r) => r.netR > 0);
  const losses = records.filter((r) => r.netR < 0);
  const lossMag = Math.abs(losses.reduce((s, r) => s + r.netR, 0));
  if (lossMag === 0) return null;
  return r4(wins.reduce((s, r) => s + r.netR, 0) / lossMag);
}

function buildGroup(
  key: string,
  records: ClosedRecord[],
  now: number,
  scope: "route" | "symbol" | "direction" | "regime",
): { group: DriftGroup; warning: DriftWarning | null } {
  const recentCutoff = now - RECENT_WINDOW_MS;
  const baselineFloor = now - BASELINE_LOOKBACK_MS;
  const recent = records.filter((r) => r.closedAt >= recentCutoff);
  const baseline = records.filter((r) => r.closedAt < recentCutoff && r.closedAt >= baselineFloor);

  const avgAll = mean(records.map((r) => r.netR));
  const recentAvg = mean(recent.map((r) => r.netR));
  const baselineAvg = mean(baseline.map((r) => r.netR));
  const wins = records.filter((r) => r.netR > 0);
  const slCount = records.filter((r) => r.slHit).length;

  const driftDeltaR =
    recentAvg !== null && baselineAvg !== null ? r4(recentAvg - baselineAvg) : null;

  const warnings: DriftWarningCode[] = [];
  let warning: DriftWarning | null = null;

  if (recent.length < MIN_RECENT || baseline.length < MIN_BASELINE) {
    warnings.push("SAMPLE_TOO_SMALL_FOR_DRIFT");
  } else if (
    baselineAvg !== null &&
    baselineAvg > POSITIVE_BASELINE_THRESHOLD &&
    recentAvg !== null &&
    recentAvg < RECENT_NEGATIVE_THRESHOLD
  ) {
    const code: DriftWarningCode =
      scope === "route"
        ? "ROUTE_EDGE_DECAY"
        : scope === "symbol"
        ? "SYMBOL_EDGE_REVERSAL"
        : scope === "direction"
        ? "DIRECTION_EDGE_DECAY"
        : "REGIME_EDGE_DECAY";
    warnings.push(code);
    warning = {
      code,
      scope,
      key,
      message: `${key} decayed from baseline ${baselineAvg.toFixed(3)}R (n=${baseline.length}) to recent ${recentAvg.toFixed(3)}R (n=${recent.length}). Δ=${driftDeltaR?.toFixed(3) ?? "n/a"}R`,
      driftDeltaR,
      recentClosedCount: recent.length,
      baselineClosedCount: baseline.length,
    };
  }

  const closedTp1 = records.filter((r) => r.tp1Hit);
  const profitableTp1Rate =
    closedTp1.length === 0
      ? null
      : r4(closedTp1.filter((r) => r.netR > 0).length / closedTp1.length);

  return {
    group: {
      key: `${scope}:${key}`,
      closedCount: records.length,
      avgRealizedNetR: avgAll,
      profitFactor: pf(records),
      winRate: records.length === 0 ? null : r4(wins.length / records.length),
      profitableTp1Rate,
      slRate: records.length === 0 ? null : r4(slCount / records.length),
      recentClosedCount: recent.length,
      recent7dNetAvgR: recentAvg,
      baselineClosedCount: baseline.length,
      priorBaselineNetAvgR: baselineAvg,
      driftDeltaR,
      warnings,
    },
    warning,
  };
}

function buildCalibrationDrift(records: ClosedRecord[], now: number) {
  const recentCutoff = now - RECENT_WINDOW_MS;
  const baselineFloor = now - BASELINE_LOOKBACK_MS;
  const hasCalibration = (r: ClosedRecord) =>
    r.calibratedExpectedNetR !== null && r.expectedNetR !== null;
  const recent = records.filter((r) => r.closedAt >= recentCutoff && hasCalibration(r));
  const baseline = records.filter(
    (r) => r.closedAt < recentCutoff && r.closedAt >= baselineFloor && hasCalibration(r),
  );

  const errOf = (rec: ClosedRecord) =>
    rec.calibratedExpectedNetR !== null ? rec.calibratedExpectedNetR - rec.netR : null;
  const baselineErr = mean(baseline.map(errOf).filter((v): v is number => v !== null));
  const recentErr = mean(recent.map(errOf).filter((v): v is number => v !== null));
  const driftDelta =
    baselineErr !== null && recentErr !== null
      ? r4(Math.abs(recentErr) - Math.abs(baselineErr))
      : null;
  let warning: DriftWarningCode | null = null;
  if (recent.length < MIN_RECENT || baseline.length < MIN_BASELINE) {
    warning = "SAMPLE_TOO_SMALL_FOR_DRIFT";
  } else if (driftDelta !== null && driftDelta >= CALIBRATION_DRIFT_DELTA_R) {
    warning = "CALIBRATION_DRIFT";
  }

  return {
    baselineErrorR: baselineErr,
    recentErrorR: recentErr,
    driftDeltaR: driftDelta,
    recentClosedCount: recent.length,
    baselineClosedCount: baseline.length,
    warning,
  };
}

function groupBy<K extends string>(
  records: ClosedRecord[],
  keyOf: (r: ClosedRecord) => K | null,
): Map<K, ClosedRecord[]> {
  const map = new Map<K, ClosedRecord[]>();
  for (const r of records) {
    const k = keyOf(r);
    if (k === null) continue;
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  return map;
}

function buildSection(
  recordMap: Map<string, ClosedRecord[]>,
  scope: "route" | "symbol" | "direction" | "regime",
  now: number,
): { groups: DriftGroup[]; warnings: DriftWarning[] } {
  const groups: DriftGroup[] = [];
  const warnings: DriftWarning[] = [];
  for (const [key, recs] of recordMap) {
    const built = buildGroup(key, recs, now, scope);
    groups.push(built.group);
    if (built.warning) warnings.push(built.warning);
  }
  // Sort by worst drift first
  groups.sort((a, b) => (a.driftDeltaR ?? 0) - (b.driftDeltaR ?? 0));
  return { groups, warnings };
}

export interface RegimeDriftInput {
  positions: ShadowPosition[];
}

export function buildRegimeDriftReport(
  input: RegimeDriftInput,
  now: Date = new Date(),
): RegimeDriftReport {
  const generatedAt = now.toISOString();
  const records = extract(input.positions);
  const nowMs = now.getTime();

  const routeSection = buildSection(
    groupBy(records, (r) => `${r.entry}__${r.exit}`),
    "route",
    nowMs,
  );
  const symbolSection = buildSection(
    groupBy(records, (r) => r.symbol),
    "symbol",
    nowMs,
  );
  const directionSection = buildSection(
    groupBy(records, (r) => r.direction),
    "direction",
    nowMs,
  );
  const regimeSection = buildSection(
    groupBy(records, (r) => (r.regime && r.regime.length > 0 ? r.regime : null)),
    "regime",
    nowMs,
  );

  const calibrationDriftSummary = buildCalibrationDrift(records, nowMs);

  const allWarnings: DriftWarning[] = [
    ...routeSection.warnings,
    ...symbolSection.warnings,
    ...directionSection.warnings,
    ...regimeSection.warnings,
  ];
  if (calibrationDriftSummary.warning === "CALIBRATION_DRIFT") {
    allWarnings.push({
      code: "CALIBRATION_DRIFT",
      scope: "calibration",
      key: "calibrated_expectancy",
      message: `Calibration drift: |baseline error| ${calibrationDriftSummary.baselineErrorR?.toFixed(3) ?? "n/a"}R vs |recent error| ${calibrationDriftSummary.recentErrorR?.toFixed(3) ?? "n/a"}R (Δ=${calibrationDriftSummary.driftDeltaR?.toFixed(3) ?? "n/a"}R)`,
      driftDeltaR: calibrationDriftSummary.driftDeltaR,
      recentClosedCount: calibrationDriftSummary.recentClosedCount,
      baselineClosedCount: calibrationDriftSummary.baselineClosedCount,
    });
  }

  // Overall status:
  //   DEGRADED if any decay warning fires
  //   WATCH    if calibration drift fires but no decay
  //   STABLE   otherwise
  const decayWarnings = allWarnings.filter(
    (w) =>
      w.code === "ROUTE_EDGE_DECAY" ||
      w.code === "SYMBOL_EDGE_REVERSAL" ||
      w.code === "DIRECTION_EDGE_DECAY" ||
      w.code === "REGIME_EDGE_DECAY",
  );
  const overallStatus: DriftStatus =
    decayWarnings.length > 0
      ? "DEGRADED"
      : calibrationDriftSummary.warning === "CALIBRATION_DRIFT"
      ? "WATCH"
      : "STABLE";

  // Top warnings — worst drift first, capped at 10
  const topWarnings = allWarnings
    .filter((w) => w.code !== "SAMPLE_TOO_SMALL_FOR_DRIFT")
    .sort((a, b) => (a.driftDeltaR ?? 0) - (b.driftDeltaR ?? 0))
    .slice(0, 10);

  return {
    generatedAt,
    overallStatus,
    routeDrift: routeSection.groups,
    symbolDrift: symbolSection.groups,
    directionDrift: directionSection.groups,
    regimeBreakdown: regimeSection.groups,
    calibrationDriftSummary,
    topWarnings,
    notes: [
      "Drift detector compares last 7 days to the prior 60 days. Read-only report.",
      "Baseline ≥ 15 closed AND recent ≥ 5 closed required; smaller groups emit SAMPLE_TOO_SMALL_FOR_DRIFT.",
      "Decay = baseline net R > 0.10 but recent net R < 0. Tunable, deterministic.",
      "Calibration drift = recent |error| widened by ≥0.25R vs baseline.",
    ],
  };
}

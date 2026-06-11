import type { ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra } from "@dtc/shared";

/**
 * ENTRY PRECISION COUNTERFACTUAL AUDIT
 *
 * Read-only diagnostic. Quantifies whether the current POST_CALIBRATION losses
 * are primarily caused by late / chasing fills that destroy payoff geometry:
 *
 *   - gross R becomes negative before costs because the fill price is too far
 *     outside the intended zone
 *   - SL rate rises because the fill is closer to the stop
 *   - avg loss expands beyond 1R because the entry is already wrong
 *   - TP wins are too small to offset the inflated losers
 *
 * The core tool is the "counterfactual filter simulation": re-compute all
 * performance metrics on the historical closed set after excluding (or keeping
 * only) positions that had high drift / high chase risk. This answers whether
 * precision is the primary leak WITHOUT requiring new trades.
 *
 * Does NOT change:
 *   - scanner ranking or Top-10 selection
 *   - routeMode decisions or variant selection
 *   - shadow fill logic or shadow close logic
 *   - cost model or calibrated expectancy
 *   - live readiness gates, trade caps, or live trading logic
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntryPrecisionEraFilter = "POST_CALIBRATION" | "POST_ROUTING" | "ALL";

export type DriftBucket =
  | "INSIDE_OR_BETTER"   // driftPct <= 0
  | "LOW_DRIFT"           // 0 < driftPct <= 0.25
  | "MODERATE_DRIFT"      // 0.25 < driftPct <= 0.50
  | "HIGH_DRIFT"          // 0.50 < driftPct <= 1.0
  | "EXTREME_DRIFT"       // driftPct > 1.0
  | "UNKNOWN";            // no drift data

export type ChaseRiskLabel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export type CounterfactualInterpretation =
  | "STRONGLY_IMPROVES"
  | "MODESTLY_IMPROVES"
  | "NO_CLEAR_CHANGE"
  | "WORSENS"
  | "TOO_FEW_SAMPLES";

export type EntryPrecisionMainDiagnosis =
  | "ENTRY_PRECISION_LIKELY_PRIMARY_LEAK"
  | "ENTRY_PRECISION_NOT_CONFIRMED"
  | "INSUFFICIENT_SAMPLE"
  | "MIXED";

export type EntryPrecisionFlagCode =
  | "ENTRY_DRIFT_ELEVATED"
  | "CHASE_RISK_ELEVATED"
  | "HIGH_DRIFT_TRADES_DOMINATE_LOSSES"
  | "NON_HIGH_CHASE_PERFORMS_BETTER"
  | "INSIDE_ZONE_SAMPLE_TOO_SMALL"
  | "SL_RATE_SPIKES_WITH_DRIFT"
  | "AVG_LOSS_EXPANDS_WITH_DRIFT"
  | "ROUTE_PRECISION_DEGRADES_OUTSIDE_ZONE";

export type FlagSeverity = "INFO" | "WARN" | "CRITICAL";

export interface EntryPrecisionFlag {
  code: EntryPrecisionFlagCode;
  severity: FlagSeverity;
  message: string;
}

export interface EntryPrecisionSummary {
  eraFilter: EntryPrecisionEraFilter;
  closedCount: number;
  positionsWithDriftData: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  avgEntryDriftPctOfZone: number | null;
  avgEntryDriftAtr: number | null;
  highDriftCount: number;
  highDriftRate: number | null;
  highChaseCount: number;
  highChaseRate: number | null;
  mainDiagnosis: EntryPrecisionMainDiagnosis;
}

export interface DriftBucketRow {
  bucket: DriftBucket;
  closedCount: number;
  sharePct: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  totalNetRContribution: number;
  diagnosis: string;
}

export interface ChaseBucketRow {
  chaseRisk: ChaseRiskLabel;
  closedCount: number;
  sharePct: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  totalNetRContribution: number;
  diagnosis: string;
}

export type ScenarioCode =
  | "BASELINE_ALL"
  | "EXCLUDE_DRIFT_GT_50"
  | "EXCLUDE_DRIFT_GT_100"
  | "EXCLUDE_HIGH_CHASE"
  | "EXCLUDE_HIGH_CHASE_OR_DRIFT_GT_50"
  | "KEEP_ONLY_DRIFT_LE_50"
  | "KEEP_ONLY_NON_HIGH_CHASE";

export interface CounterfactualScenario {
  scenarioCode: ScenarioCode;
  label: string;
  excludedCount: number;
  remainingCount: number;
  remainingSharePct: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  deltaNetAvgRVsBaseline: number | null;
  deltaPFVsBaseline: number | null;
  deltaSLRateVsBaseline: number | null;
  interpretation: CounterfactualInterpretation;
}

export interface RoutePrecisionRow {
  routeLabel: string;
  closedCount: number;
  avgEntryDriftPctOfZone: number | null;
  avgEntryDriftAtr: number | null;
  highDriftRate: number | null;
  highChaseRate: number | null;
  netAvgR: number | null;
  grossAvgR: number | null;
  slRate: number | null;
  profitableTp1Rate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  diagnosis: string;
}

export interface SymbolPrecisionRow {
  symbol: string;
  closedCount: number;
  avgEntryDriftPctOfZone: number | null;
  highDriftRate: number | null;
  highChaseRate: number | null;
  netAvgR: number | null;
  grossAvgR: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  totalNetRContribution: number;
  diagnosis: string;
}

export interface EntryPrecisionAuditReport {
  generatedAt: string;
  eraFilter: EntryPrecisionEraFilter;
  summary: EntryPrecisionSummary;
  driftBuckets: DriftBucketRow[];
  chaseBuckets: ChaseBucketRow[];
  counterfactuals: CounterfactualScenario[];
  routePrecision: RoutePrecisionRow[];
  symbolPrecision: SymbolPrecisionRow[];
  flags: EntryPrecisionFlag[];
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

export interface EntryPrecisionAuditInput {
  positions: ShadowPosition[];
  eraFilter?: EntryPrecisionEraFilter;
}

// ─── Internal flat record ─────────────────────────────────────────────────────

interface ClosedRecord {
  symbol: string;
  entryVariant: string;
  exitVariant: string;
  routeLabel: string;
  netR: number;
  grossR: number;
  tp1Hit: boolean;
  closeReason: string;
  /** Raw signed drift from variantSelection (null if unavailable). */
  rawDriftPct: number | null;
  /** Absolute drift value used for bucketing. */
  absDriftPct: number | null;
  driftAtr: number | null;
  chaseRisk: ChaseRiskLabel;
  driftBucket: DriftBucket;
  hasDriftData: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return r4(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function closedVariants(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

function eraInFilter(p: ShadowPosition, filter: EntryPrecisionEraFilter): boolean {
  if (filter === "ALL") return true;
  const era = classifyEvidenceEra(p);
  if (filter === "POST_CALIBRATION") return era === "POST_CALIBRATION";
  // POST_ROUTING = both POST_ROUTING_PRE_CALIBRATION and POST_CALIBRATION
  return era === "POST_ROUTING_PRE_CALIBRATION" || era === "POST_CALIBRATION";
}

function classifyDriftBucket(absDriftPct: number | null): DriftBucket {
  if (absDriftPct === null) return "UNKNOWN";
  if (absDriftPct <= 0) return "INSIDE_OR_BETTER";
  if (absDriftPct <= 0.25) return "LOW_DRIFT";
  if (absDriftPct <= 0.50) return "MODERATE_DRIFT";
  if (absDriftPct <= 1.0) return "HIGH_DRIFT";
  return "EXTREME_DRIFT";
}

function classifyChaseRisk(raw: string | null | undefined): ChaseRiskLabel {
  if (raw === "LOW" || raw === "MEDIUM" || raw === "HIGH") return raw;
  return "UNKNOWN";
}

interface GroupStats {
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  totalNetR: number;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
}

function computeGroupStats(records: ClosedRecord[]): GroupStats {
  if (records.length === 0) {
    return {
      closedCount: 0, netAvgR: null, grossAvgR: null, totalNetR: 0,
      profitFactor: null, winRate: null, tp1Rate: null, profitableTp1Rate: null,
      slRate: null, avgWinR: null, avgLossR: null,
    };
  }
  const n = records.length;
  const winners = records.filter((r) => r.netR > 0);
  const losers = records.filter((r) => r.netR < 0);
  const grossWin = winners.reduce((s, r) => s + r.netR, 0);
  const grossLoss = Math.abs(losers.reduce((s, r) => s + r.netR, 0));
  const totalNetR = records.reduce((s, r) => s + r.netR, 0);
  const totalGrossR = records.reduce((s, r) => s + r.grossR, 0);
  const tp1Hits = records.filter((r) => r.tp1Hit);
  const profitableTp1 = tp1Hits.filter((r) => r.netR > 0);
  const slCount = records.filter((r) => r.closeReason === "SL" || r.closeReason === "BREAKEVEN").length;

  return {
    closedCount: n,
    netAvgR: r4(totalNetR / n),
    grossAvgR: r4(totalGrossR / n),
    totalNetR: r4(totalNetR),
    profitFactor: grossLoss === 0 ? null : r4(grossWin / grossLoss),
    winRate: r4(winners.length / n),
    tp1Rate: r4(tp1Hits.length / n),
    profitableTp1Rate: tp1Hits.length === 0 ? null : r4(profitableTp1.length / tp1Hits.length),
    slRate: r4(slCount / n),
    avgWinR: winners.length === 0 ? null : r4(grossWin / winners.length),
    avgLossR: losers.length === 0 ? null : r4(-grossLoss / losers.length),
  };
}

function flattenClosed(
  positions: ShadowPosition[],
  eraFilter: EntryPrecisionEraFilter,
): ClosedRecord[] {
  const out: ClosedRecord[] = [];
  for (const p of positions) {
    if (!eraInFilter(p, eraFilter)) continue;
    const cvs = closedVariants(p);
    if (cvs.length === 0) continue;

    const entry = p.variantSelection?.selectedEntryVariant ?? p.selectedEntryVariant ?? "unknown";
    const exit = p.variantSelection?.selectedExitVariant ?? p.selectedExitVariant ?? "unknown";
    const rawDriftPct = p.variantSelection?.entryDriftPct ?? null;
    const absDriftPct = rawDriftPct !== null ? Math.abs(rawDriftPct) : null;
    const driftAtr = p.variantSelection?.entryDriftAtr !== undefined && p.variantSelection?.entryDriftAtr !== null
      ? Math.abs(p.variantSelection.entryDriftAtr)
      : null;
    const chaseRisk = classifyChaseRisk(p.variantSelection?.chaseRisk);
    const driftBucket = classifyDriftBucket(rawDriftPct !== null ? rawDriftPct : null);

    for (const v of cvs) {
      out.push({
        symbol: p.symbol,
        entryVariant: entry,
        exitVariant: exit,
        routeLabel: `${entry} + ${exit}`,
        netR: v.realizedNetR,
        grossR: v.realizedGrossR,
        tp1Hit: v.tp1Hit,
        closeReason: v.closeReason ?? "UNKNOWN",
        rawDriftPct,
        absDriftPct,
        driftAtr,
        chaseRisk,
        driftBucket,
        hasDriftData: rawDriftPct !== null,
      });
    }
  }
  return out;
}

// ─── Section builders ─────────────────────────────────────────────────────────

const DRIFT_BUCKET_ORDER: DriftBucket[] = [
  "INSIDE_OR_BETTER",
  "LOW_DRIFT",
  "MODERATE_DRIFT",
  "HIGH_DRIFT",
  "EXTREME_DRIFT",
  "UNKNOWN",
];

function bucketDiagnosis(bucket: DriftBucket, stats: GroupStats): string {
  const n = stats.closedCount;
  const navg = stats.netAvgR !== null ? stats.netAvgR.toFixed(4) : "n/a";
  const sl = stats.slRate !== null ? `${(stats.slRate * 100).toFixed(0)}% SL` : "? SL";
  if (n === 0) return `${bucket}: no closes.`;
  if (bucket === "INSIDE_OR_BETTER") {
    return stats.netAvgR !== null && stats.netAvgR > 0
      ? `Inside-zone fills profitable (${navg}R avg, ${sl}) — supports the precision hypothesis.`
      : `Inside-zone fills still negative (${navg}R avg, ${sl}) — route itself may be weak.`;
  }
  if (bucket === "EXTREME_DRIFT") {
    return `Extreme drift (>100% zone): ${navg}R avg, ${sl}. Fills far outside zone are most damaging.`;
  }
  if (bucket === "HIGH_DRIFT") {
    return `High drift (50–100% zone): ${navg}R avg, ${sl}. Performance degrades materially vs clean fills.`;
  }
  if (bucket === "MODERATE_DRIFT") {
    return `Moderate drift (25–50% zone): ${navg}R avg, ${sl}.`;
  }
  if (bucket === "LOW_DRIFT") {
    return `Low drift (0–25% zone): ${navg}R avg, ${sl}. Near-ideal entry quality.`;
  }
  return `Unknown drift: ${navg}R avg, ${sl}. No drift data available.`;
}

function buildDriftBuckets(records: ClosedRecord[]): DriftBucketRow[] {
  const total = records.length;
  const byBucket = new Map<DriftBucket, ClosedRecord[]>();
  for (const b of DRIFT_BUCKET_ORDER) byBucket.set(b, []);
  for (const r of records) {
    const arr = byBucket.get(r.driftBucket) ?? [];
    arr.push(r);
    byBucket.set(r.driftBucket, arr);
  }
  return DRIFT_BUCKET_ORDER.map((bucket) => {
    const recs = byBucket.get(bucket) ?? [];
    const stats = computeGroupStats(recs);
    return {
      bucket,
      closedCount: stats.closedCount,
      sharePct: total > 0 ? r4(stats.closedCount / total) : 0,
      netAvgR: stats.netAvgR,
      grossAvgR: stats.grossAvgR,
      profitFactor: stats.profitFactor,
      winRate: stats.winRate,
      tp1Rate: stats.tp1Rate,
      profitableTp1Rate: stats.profitableTp1Rate,
      slRate: stats.slRate,
      avgWinR: stats.avgWinR,
      avgLossR: stats.avgLossR,
      totalNetRContribution: stats.totalNetR,
      diagnosis: bucketDiagnosis(bucket, stats),
    };
  });
}

const CHASE_BUCKET_ORDER: ChaseRiskLabel[] = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"];

function chaseDiagnosis(risk: ChaseRiskLabel, stats: GroupStats): string {
  if (stats.closedCount === 0) return `${risk} chase risk: no closes.`;
  const navg = stats.netAvgR !== null ? stats.netAvgR.toFixed(4) : "n/a";
  const sl = stats.slRate !== null ? `${(stats.slRate * 100).toFixed(0)}% SL` : "? SL";
  if (risk === "HIGH") {
    return stats.netAvgR !== null && stats.netAvgR < -0.1
      ? `HIGH chase risk: ${navg}R avg, ${sl}. Chasing entries clearly underperforms.`
      : `HIGH chase risk: ${navg}R avg, ${sl}. Chase risk flagged but performance not clearly worse.`;
  }
  if (risk === "LOW") {
    return stats.netAvgR !== null && stats.netAvgR > 0
      ? `LOW chase risk: ${navg}R avg, ${sl}. Clean entries perform better — confirms precision hypothesis.`
      : `LOW chase risk: ${navg}R avg, ${sl}. Even clean entries are unprofitable.`;
  }
  return `${risk} chase risk: ${navg}R avg, ${sl}.`;
}

function buildChaseBuckets(records: ClosedRecord[]): ChaseBucketRow[] {
  const total = records.length;
  const byChase = new Map<ChaseRiskLabel, ClosedRecord[]>();
  for (const c of CHASE_BUCKET_ORDER) byChase.set(c, []);
  for (const r of records) {
    const arr = byChase.get(r.chaseRisk) ?? [];
    arr.push(r);
    byChase.set(r.chaseRisk, arr);
  }
  return CHASE_BUCKET_ORDER.map((risk) => {
    const recs = byChase.get(risk) ?? [];
    const stats = computeGroupStats(recs);
    return {
      chaseRisk: risk,
      closedCount: stats.closedCount,
      sharePct: total > 0 ? r4(stats.closedCount / total) : 0,
      netAvgR: stats.netAvgR,
      grossAvgR: stats.grossAvgR,
      profitFactor: stats.profitFactor,
      winRate: stats.winRate,
      tp1Rate: stats.tp1Rate,
      profitableTp1Rate: stats.profitableTp1Rate,
      slRate: stats.slRate,
      avgWinR: stats.avgWinR,
      avgLossR: stats.avgLossR,
      totalNetRContribution: stats.totalNetR,
      diagnosis: chaseDiagnosis(risk, stats),
    };
  });
}

function counterfactualInterpretation(
  delta: number | null,
  deltaPF: number | null,
  remaining: number,
): CounterfactualInterpretation {
  if (remaining < 5) return "TOO_FEW_SAMPLES";
  if (delta === null) return "NO_CLEAR_CHANGE";
  if (delta < -0.05) return "WORSENS";
  if (delta > 0.15 && (deltaPF === null || deltaPF > 0.1)) return "STRONGLY_IMPROVES";
  if (delta > 0.05) return "MODESTLY_IMPROVES";
  return "NO_CLEAR_CHANGE";
}

type ScenarioFilter = (r: ClosedRecord) => boolean;

const SCENARIO_DEFS: Array<{
  code: ScenarioCode;
  label: string;
  keep: ScenarioFilter;
}> = [
  {
    code: "BASELINE_ALL",
    label: "Baseline (all trades)",
    keep: () => true,
  },
  {
    code: "EXCLUDE_DRIFT_GT_50",
    label: "Exclude drift > 50% zone",
    keep: (r) => !r.hasDriftData || r.absDriftPct === null || r.absDriftPct <= 0.5,
  },
  {
    code: "EXCLUDE_DRIFT_GT_100",
    label: "Exclude drift > 100% zone",
    keep: (r) => !r.hasDriftData || r.absDriftPct === null || r.absDriftPct <= 1.0,
  },
  {
    code: "EXCLUDE_HIGH_CHASE",
    label: "Exclude HIGH chase risk",
    keep: (r) => r.chaseRisk !== "HIGH",
  },
  {
    code: "EXCLUDE_HIGH_CHASE_OR_DRIFT_GT_50",
    label: "Exclude HIGH chase or drift > 50%",
    keep: (r) =>
      r.chaseRisk !== "HIGH" &&
      (!r.hasDriftData || r.absDriftPct === null || r.absDriftPct <= 0.5),
  },
  {
    code: "KEEP_ONLY_DRIFT_LE_50",
    label: "Keep only drift ≤ 50%",
    keep: (r) => r.hasDriftData && r.absDriftPct !== null && r.absDriftPct <= 0.5,
  },
  {
    code: "KEEP_ONLY_NON_HIGH_CHASE",
    label: "Keep only LOW/MEDIUM chase risk",
    keep: (r) => r.chaseRisk === "LOW" || r.chaseRisk === "MEDIUM",
  },
];

function buildCounterfactuals(records: ClosedRecord[]): CounterfactualScenario[] {
  const baselineStats = computeGroupStats(records);
  const baseNetAvgR = baselineStats.netAvgR;
  const basePF = baselineStats.profitFactor;
  const baseSL = baselineStats.slRate;
  const total = records.length;

  return SCENARIO_DEFS.map(({ code, label, keep }) => {
    const remaining = records.filter(keep);
    const stats = computeGroupStats(remaining);
    const excluded = total - remaining.length;
    const remainingSharePct = total > 0 ? r4(remaining.length / total) : 0;

    const deltaNetAvgR =
      stats.netAvgR !== null && baseNetAvgR !== null
        ? r4(stats.netAvgR - baseNetAvgR)
        : null;
    const deltaPF =
      stats.profitFactor !== null && basePF !== null
        ? r4(stats.profitFactor - basePF)
        : null;
    const deltaSL =
      stats.slRate !== null && baseSL !== null
        ? r4(stats.slRate - baseSL)
        : null;

    const interp = code === "BASELINE_ALL"
      ? "NO_CLEAR_CHANGE"
      : counterfactualInterpretation(deltaNetAvgR, deltaPF, remaining.length);

    return {
      scenarioCode: code,
      label,
      excludedCount: excluded,
      remainingCount: remaining.length,
      remainingSharePct,
      netAvgR: stats.netAvgR,
      grossAvgR: stats.grossAvgR,
      profitFactor: stats.profitFactor,
      winRate: stats.winRate,
      tp1Rate: stats.tp1Rate,
      profitableTp1Rate: stats.profitableTp1Rate,
      slRate: stats.slRate,
      avgWinR: stats.avgWinR,
      avgLossR: stats.avgLossR,
      deltaNetAvgRVsBaseline: code === "BASELINE_ALL" ? null : deltaNetAvgR,
      deltaPFVsBaseline: code === "BASELINE_ALL" ? null : deltaPF,
      deltaSLRateVsBaseline: code === "BASELINE_ALL" ? null : deltaSL,
      interpretation: interp,
    };
  });
}

function routePrecisionDiagnosis(row: Omit<RoutePrecisionRow, "diagnosis">): string {
  const navg = row.netAvgR !== null ? row.netAvgR.toFixed(4) : "n/a";
  const drift = row.avgEntryDriftPctOfZone !== null
    ? `${(row.avgEntryDriftPctOfZone * 100).toFixed(1)}%`
    : "n/a";
  const highDrift = row.highDriftRate !== null
    ? `${(row.highDriftRate * 100).toFixed(0)}%`
    : "n/a";
  if (row.closedCount < 5) {
    return `${row.routeLabel}: only ${row.closedCount} close(s) — too early for route-level precision judgment.`;
  }
  if (row.avgEntryDriftPctOfZone !== null && row.avgEntryDriftPctOfZone > 0.5) {
    return `${row.routeLabel}: avg drift ${drift} (${highDrift} high-drift rate) with ${navg}R avg. ` +
      `High drift on this route — fill quality is degrading expected R/R.`;
  }
  return `${row.routeLabel}: avg drift ${drift}, net ${navg}R, ${row.closedCount} closes.`;
}

function buildRoutePrecision(records: ClosedRecord[]): RoutePrecisionRow[] {
  const byRoute = new Map<string, ClosedRecord[]>();
  for (const r of records) {
    const arr = byRoute.get(r.routeLabel) ?? [];
    arr.push(r);
    byRoute.set(r.routeLabel, arr);
  }
  const rows: RoutePrecisionRow[] = [];
  for (const [routeLabel, recs] of byRoute) {
    const stats = computeGroupStats(recs);
    const withDrift = recs.filter((r) => r.hasDriftData);
    const driftPcts = withDrift.map((r) => r.absDriftPct!);
    const driftAtrs = recs.filter((r) => r.driftAtr !== null).map((r) => r.driftAtr!);
    const highDrift = withDrift.filter((r) => r.absDriftPct !== null && r.absDriftPct > 0.5);
    const highChase = recs.filter((r) => r.chaseRisk === "HIGH");

    const row: Omit<RoutePrecisionRow, "diagnosis"> = {
      routeLabel,
      closedCount: recs.length,
      avgEntryDriftPctOfZone: mean(driftPcts),
      avgEntryDriftAtr: mean(driftAtrs),
      highDriftRate: withDrift.length > 0 ? r4(highDrift.length / withDrift.length) : null,
      highChaseRate: recs.length > 0 ? r4(highChase.length / recs.length) : null,
      netAvgR: stats.netAvgR,
      grossAvgR: stats.grossAvgR,
      slRate: stats.slRate,
      profitableTp1Rate: stats.profitableTp1Rate,
      avgWinR: stats.avgWinR,
      avgLossR: stats.avgLossR,
    };
    rows.push({ ...row, diagnosis: routePrecisionDiagnosis(row) });
  }
  return rows.sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0));
}

function symbolPrecisionDiagnosis(sym: string, stats: GroupStats, highDriftRate: number | null): string {
  const navg = stats.netAvgR !== null ? stats.netAvgR.toFixed(4) : "n/a";
  const dr = highDriftRate !== null ? `${(highDriftRate * 100).toFixed(0)}%` : "n/a";
  if (stats.closedCount < 3) return `${sym}: ${stats.closedCount} close(s) — too small to assess.`;
  if (highDriftRate !== null && highDriftRate > 0.7 && (stats.netAvgR ?? 0) < -0.1) {
    return `${sym}: ${dr} high-drift rate, ${navg}R avg. High drift may be inflating losses here.`;
  }
  if (highDriftRate !== null && highDriftRate < 0.3 && (stats.netAvgR ?? 0) > 0) {
    return `${sym}: ${dr} high-drift rate, ${navg}R avg. Clean fills correlate with positive performance.`;
  }
  return `${sym}: ${dr} high-drift rate, ${navg}R avg.`;
}

function buildSymbolPrecision(records: ClosedRecord[]): SymbolPrecisionRow[] {
  const bySymbol = new Map<string, ClosedRecord[]>();
  for (const r of records) {
    const arr = bySymbol.get(r.symbol) ?? [];
    arr.push(r);
    bySymbol.set(r.symbol, arr);
  }
  const rows: SymbolPrecisionRow[] = [];
  for (const [symbol, recs] of bySymbol) {
    const stats = computeGroupStats(recs);
    const withDrift = recs.filter((r) => r.hasDriftData);
    const driftPcts = withDrift.map((r) => r.absDriftPct!);
    const highDrift = withDrift.filter((r) => r.absDriftPct !== null && r.absDriftPct > 0.5);
    const highChase = recs.filter((r) => r.chaseRisk === "HIGH");
    const highDriftRate = withDrift.length > 0 ? r4(highDrift.length / withDrift.length) : null;

    rows.push({
      symbol,
      closedCount: recs.length,
      avgEntryDriftPctOfZone: mean(driftPcts),
      highDriftRate,
      highChaseRate: recs.length > 0 ? r4(highChase.length / recs.length) : null,
      netAvgR: stats.netAvgR,
      grossAvgR: stats.grossAvgR,
      slRate: stats.slRate,
      avgWinR: stats.avgWinR,
      avgLossR: stats.avgLossR,
      totalNetRContribution: stats.totalNetR,
      diagnosis: symbolPrecisionDiagnosis(symbol, stats, highDriftRate),
    });
  }
  return rows.sort((a, b) => a.totalNetRContribution - b.totalNetRContribution);
}

function buildFlags(
  summary: EntryPrecisionSummary,
  driftBuckets: DriftBucketRow[],
  chaseBuckets: ChaseBucketRow[],
  counterfactuals: CounterfactualScenario[],
): EntryPrecisionFlag[] {
  const flags: EntryPrecisionFlag[] = [];
  const { avgEntryDriftPctOfZone, highDriftRate, highChaseRate, closedCount } = summary;

  // ENTRY_DRIFT_ELEVATED
  if (avgEntryDriftPctOfZone !== null && avgEntryDriftPctOfZone > 0.3) {
    flags.push({
      code: "ENTRY_DRIFT_ELEVATED",
      severity: avgEntryDriftPctOfZone > 0.7 ? "CRITICAL" : "WARN",
      message:
        `Avg entry drift is ${(avgEntryDriftPctOfZone * 100).toFixed(1)}% of zone width. ` +
        `Fills this far from the zone edge shift the risk/reward unfavourably.`,
    });
  }

  // CHASE_RISK_ELEVATED
  if (highChaseRate !== null && highChaseRate > 0.25) {
    flags.push({
      code: "CHASE_RISK_ELEVATED",
      severity: highChaseRate > 0.6 ? "CRITICAL" : "WARN",
      message:
        `${(highChaseRate * 100).toFixed(0)}% of positions carry HIGH chase risk at entry ` +
        `(${summary.highChaseCount} of ${closedCount}). ` +
        `High-chase fills tend to enter above the zone midpoint, compressing upside.`,
    });
  }

  // HIGH_DRIFT_TRADES_DOMINATE_LOSSES
  const extremeBucket = driftBuckets.find((b) => b.bucket === "EXTREME_DRIFT");
  const highBucket = driftBuckets.find((b) => b.bucket === "HIGH_DRIFT");
  const highDriftTotalNeg =
    (extremeBucket?.totalNetRContribution ?? 0) + (highBucket?.totalNetRContribution ?? 0);
  const allNegR = driftBuckets
    .filter((b) => b.totalNetRContribution < 0)
    .reduce((s, b) => s + b.totalNetRContribution, 0);
  if (allNegR < -0.1 && highDriftTotalNeg / allNegR > 0.7) {
    flags.push({
      code: "HIGH_DRIFT_TRADES_DOMINATE_LOSSES",
      severity: "WARN",
      message:
        `High-drift and extreme-drift trades account for ` +
        `${((highDriftTotalNeg / allNegR) * 100).toFixed(0)}% of total negative R. ` +
        `Entry precision is a major driver of loss composition.`,
    });
  }

  // NON_HIGH_CHASE_PERFORMS_BETTER
  const nonHighChase = chaseBuckets.filter((b) => b.chaseRisk === "LOW" || b.chaseRisk === "MEDIUM");
  const highChase = chaseBuckets.find((b) => b.chaseRisk === "HIGH");
  const nonHighAvgR = nonHighChase.length > 0
    ? mean(nonHighChase.filter((b) => b.netAvgR !== null).map((b) => b.netAvgR!))
    : null;
  if (
    nonHighAvgR !== null &&
    highChase?.netAvgR !== null &&
    highChase?.netAvgR !== undefined &&
    nonHighAvgR > (highChase.netAvgR ?? 0) + 0.15 &&
    nonHighChase.some((b) => b.closedCount >= 3)
  ) {
    flags.push({
      code: "NON_HIGH_CHASE_PERFORMS_BETTER",
      severity: "INFO",
      message:
        `LOW/MEDIUM chase risk positions average ${nonHighAvgR.toFixed(4)}R vs ` +
        `${highChase?.netAvgR?.toFixed(4) ?? "n/a"}R for HIGH chase. ` +
        `Avoiding chase-risk entries shows measurable improvement in this historical sample.`,
    });
  }

  // INSIDE_ZONE_SAMPLE_TOO_SMALL
  const insideBucket = driftBuckets.find((b) => b.bucket === "INSIDE_OR_BETTER");
  if (insideBucket && insideBucket.closedCount < 3) {
    flags.push({
      code: "INSIDE_ZONE_SAMPLE_TOO_SMALL",
      severity: "INFO",
      message:
        `Only ${insideBucket.closedCount} closes from inside-zone fills. ` +
        `Insufficient data to compare inside vs outside performance reliably.`,
    });
  }

  // SL_RATE_SPIKES_WITH_DRIFT
  const insideSL = insideBucket?.slRate ?? null;
  const highDriftSL = highBucket?.slRate ?? extremeBucket?.slRate ?? null;
  if (insideSL !== null && highDriftSL !== null && highDriftSL > insideSL + 0.15 && (extremeBucket?.closedCount ?? 0) + (highBucket?.closedCount ?? 0) >= 3) {
    flags.push({
      code: "SL_RATE_SPIKES_WITH_DRIFT",
      severity: "WARN",
      message:
        `SL rate for high/extreme drift trades is ${(highDriftSL * 100).toFixed(0)}% vs ` +
        `${(insideSL * 100).toFixed(0)}% for inside-zone trades (+${((highDriftSL - insideSL) * 100).toFixed(0)}pp). ` +
        `Drifted entries have a materially higher stop-loss rate.`,
    });
  }

  // AVG_LOSS_EXPANDS_WITH_DRIFT
  const insideAvgLoss = insideBucket?.avgLossR ?? null;
  const highDriftAvgLoss = highBucket?.avgLossR ?? extremeBucket?.avgLossR ?? null;
  if (
    insideAvgLoss !== null &&
    highDriftAvgLoss !== null &&
    Math.abs(highDriftAvgLoss) > Math.abs(insideAvgLoss) + 0.15
  ) {
    flags.push({
      code: "AVG_LOSS_EXPANDS_WITH_DRIFT",
      severity: "WARN",
      message:
        `Avg loss for high/extreme drift trades is ${highDriftAvgLoss.toFixed(4)}R vs ` +
        `${insideAvgLoss.toFixed(4)}R for inside-zone trades. ` +
        `Entry drift is expanding the loss when SL is hit.`,
    });
  }

  // ROUTE_PRECISION_DEGRADES_OUTSIDE_ZONE
  const highDriftNegR = driftBuckets
    .filter((b) => b.bucket === "HIGH_DRIFT" || b.bucket === "EXTREME_DRIFT")
    .reduce((s, b) => s + b.totalNetRContribution, 0);
  if (
    highDriftRate !== null &&
    highDriftRate > 0.5 &&
    highDriftNegR < -1 &&
    summary.grossAvgR !== null &&
    summary.grossAvgR < -0.1
  ) {
    flags.push({
      code: "ROUTE_PRECISION_DEGRADES_OUTSIDE_ZONE",
      severity: "WARN",
      message:
        `More than ${(highDriftRate * 100).toFixed(0)}% of trades have high drift, ` +
        `and gross R is already negative (${summary.grossAvgR.toFixed(4)}R avg). ` +
        `The route's edge (if any) disappears when fills occur outside the planned zone.`,
    });
  }

  return flags;
}

function computeMainDiagnosis(
  summary: Pick<EntryPrecisionSummary, "closedCount" | "grossAvgR">,
  counterfactuals: CounterfactualScenario[],
): EntryPrecisionMainDiagnosis {
  if (summary.closedCount < 10) return "INSUFFICIENT_SAMPLE";

  // Look for strongest improving counterfactual
  const improving = counterfactuals.filter(
    (c) => c.scenarioCode !== "BASELINE_ALL" &&
      (c.interpretation === "STRONGLY_IMPROVES" || c.interpretation === "MODESTLY_IMPROVES"),
  );
  const stronglyImproving = improving.filter((c) => c.interpretation === "STRONGLY_IMPROVES");
  const anyWorsens = counterfactuals.some(
    (c) => c.scenarioCode !== "BASELINE_ALL" && c.interpretation === "WORSENS",
  );

  if (stronglyImproving.length >= 1 && (summary.grossAvgR ?? 0) < 0) {
    // Gross R is already negative AND exclusion strongly helps → precision is primary leak
    return "ENTRY_PRECISION_LIKELY_PRIMARY_LEAK";
  }
  if (improving.length >= 1 && anyWorsens) {
    return "MIXED";
  }
  if (improving.length >= 1) {
    // Some improvement but gross not confirmed negative or not strongly improving
    return "MIXED";
  }
  return "ENTRY_PRECISION_NOT_CONFIRMED";
}

function buildAnswerCards(
  summary: EntryPrecisionSummary,
  counterfactuals: CounterfactualScenario[],
  flags: EntryPrecisionFlag[],
): Array<{ question: string; answer: string }> {
  const cards: Array<{ question: string; answer: string }> = [];

  // 1. Is late entry the main leak?
  {
    const mainDx = summary.mainDiagnosis;
    let answer: string;
    if (mainDx === "INSUFFICIENT_SAMPLE") {
      answer = `Insufficient sample (${summary.closedCount} closed trades). ` +
        `Accumulate to ≥30 closes before treating the counterfactuals as decisive.`;
    } else if (mainDx === "ENTRY_PRECISION_LIKELY_PRIMARY_LEAK") {
      answer =
        `Entry precision is a strong suspect. Gross R is already negative ` +
        `(${summary.grossAvgR !== null ? summary.grossAvgR.toFixed(4) : "n/a"}R avg before costs), ` +
        `meaning the directional plan enters at the wrong price — not a cost issue. ` +
        `Avg drift of ${summary.avgEntryDriftPctOfZone !== null ? (summary.avgEntryDriftPctOfZone * 100).toFixed(1) : "n/a"}% ` +
        `of zone and ${summary.highChaseRate !== null ? (summary.highChaseRate * 100).toFixed(0) : "?"}% HIGH chase rate ` +
        `both support this. Counterfactual exclusions improve the picture.`;
    } else if (mainDx === "MIXED") {
      answer =
        `Partially. Some counterfactual exclusions improve performance, but the benefit is modest ` +
        `or sample remaining after exclusion is too small to be conclusive. ` +
        `Entry precision is likely a contributing factor but not the only one. ` +
        `Route logic may also be weak.`;
    } else {
      answer =
        `Not confirmed. Excluding high-drift or high-chase trades does not materially improve ` +
        `historical performance. The losses appear to come from route logic or market timing ` +
        `rather than fill quality alone.`;
    }
    cards.push({ question: "Is late entry the main leak?", answer });
  }

  // 2. What happens if high-drift trades are excluded?
  {
    const scenario = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_DRIFT_GT_50");
    let answer: string;
    if (!scenario) {
      answer = "Counterfactual not computed.";
    } else if (scenario.interpretation === "TOO_FEW_SAMPLES") {
      answer =
        `Excluding drift > 50% leaves only ${scenario.remainingCount} trades — too few for reliable conclusions. ` +
        `The exclusion is suggestive but not decisive at this sample size.`;
    } else if (scenario.interpretation === "STRONGLY_IMPROVES") {
      answer =
        `Excluding high-drift (>50% zone) trades strongly improves historical net avg R ` +
        `(${scenario.netAvgR?.toFixed(4) ?? "n/a"}R from baseline ${summary.netAvgR?.toFixed(4) ?? "n/a"}R, ` +
        `Δ${scenario.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"}) on the remaining ${scenario.remainingCount} trades. ` +
        `This is a historical counterfactual only — it does not mean all such trades should be blocked.`;
    } else if (scenario.interpretation === "MODESTLY_IMPROVES") {
      answer =
        `Modest improvement when high-drift trades excluded: ` +
        `${scenario.netAvgR?.toFixed(4) ?? "n/a"}R avg on ${scenario.remainingCount} remaining trades ` +
        `(Δ${scenario.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"}). ` +
        `Suggestive but not decisive at this sample size.`;
    } else {
      answer =
        `Excluding high-drift trades (${scenario.excludedCount} removed) does not clearly improve outcomes ` +
        `(Δ${scenario.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"} net avg R). ` +
        `Fill quality alone may not explain the losses.`;
    }
    cards.push({ question: "What happens if high-drift trades are excluded?", answer });
  }

  // 3. What happens if HIGH chase trades are excluded?
  {
    const scenario = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_HIGH_CHASE");
    let answer: string;
    if (!scenario) {
      answer = "Counterfactual not computed.";
    } else if (scenario.interpretation === "TOO_FEW_SAMPLES") {
      answer =
        `Excluding HIGH chase leaves only ${scenario.remainingCount} trades — sample too small. ` +
        `With ${summary.highChaseRate !== null ? (summary.highChaseRate * 100).toFixed(0) : "?"}% HIGH chase rate, ` +
        `almost all trades would be excluded.`;
    } else if (scenario.interpretation === "STRONGLY_IMPROVES" || scenario.interpretation === "MODESTLY_IMPROVES") {
      answer =
        `Excluding HIGH chase risk trades improves historical net avg R ` +
        `(${scenario.netAvgR?.toFixed(4) ?? "n/a"}R, Δ${scenario.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"}) ` +
        `on ${scenario.remainingCount} remaining trades. This is a historical counterfactual only.`;
    } else {
      answer =
        `No clear improvement when HIGH chase trades excluded (Δ${scenario.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"}). ` +
        `Chase risk may be a symptom of market conditions that also cause the directional loss.`;
    }
    cards.push({ question: "What happens if HIGH chase trades are excluded?", answer });
  }

  // 4. Is the route bad, or are fills bad?
  {
    const insideBucket = null; // addressed via grossAvgR
    const bestExclusion = counterfactuals
      .filter((c) => c.scenarioCode !== "BASELINE_ALL" && c.interpretation !== "TOO_FEW_SAMPLES")
      .sort((a, b) => (b.deltaNetAvgRVsBaseline ?? -Infinity) - (a.deltaNetAvgRVsBaseline ?? -Infinity))[0];
    let answer: string;
    if (summary.grossAvgR !== null && summary.grossAvgR < -0.05) {
      // Gross negative → entry quality is hurting gross R, not just net
      if (bestExclusion && (bestExclusion.deltaNetAvgRVsBaseline ?? 0) > 0.1) {
        answer =
          `Both fills and possibly the route contribute. Gross R is already negative ` +
          `(${summary.grossAvgR.toFixed(4)}R avg), meaning fills deteriorate the entry price enough ` +
          `to hurt gross outcomes. Excluding ${bestExclusion.label.toLowerCase()} improves historical ` +
          `net avg R by ${bestExclusion.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"}R. ` +
          `However, the remaining-sample R after exclusion should still be validated as the sample grows.`;
      } else {
        answer =
          `Fill quality is hurting gross R (${summary.grossAvgR.toFixed(4)}R avg before costs). ` +
          `But counterfactual exclusions don't dramatically improve outcomes, suggesting route logic ` +
          `also has a weak edge in the current regime. Both fills and route need investigation.`;
      }
    } else {
      answer =
        `Gross R is near breakeven or positive (${summary.grossAvgR?.toFixed(4) ?? "n/a"}R avg). ` +
        `The route directional logic shows some edge at the gross level. ` +
        `Losses are mainly driven by net cost (${summary.grossAvgR !== null && summary.netAvgR !== null ? (summary.grossAvgR - summary.netAvgR).toFixed(4) : "n/a"}R drag). ` +
        `Fill quality may still be a secondary factor.`;
    }
    void insideBucket;
    cards.push({ question: "Is the route bad, or are fills bad?", answer });
  }

  // 5. Do we patch execution now?
  {
    const hasCritical = flags.some((f) => f.severity === "CRITICAL");
    const bestImproving = counterfactuals
      .filter((c) => c.scenarioCode !== "BASELINE_ALL" && c.interpretation === "STRONGLY_IMPROVES")
      .sort((a, b) => (b.deltaNetAvgRVsBaseline ?? -Infinity) - (a.deltaNetAvgRVsBaseline ?? -Infinity))[0];
    let answer: string;
    if (summary.closedCount < 15) {
      answer =
        `No — sample is too small (${summary.closedCount} closed trades). ` +
        `Counterfactuals at this size react to individual outliers. ` +
        `Wait until at least 30 closes, then re-run this audit.`;
    } else if (hasCritical && bestImproving) {
      answer =
        `Evidence is accumulating but not yet sufficient for an automatic patch. ` +
        `CRITICAL flags detected (${flags.filter((f) => f.severity === "CRITICAL").map((f) => f.code).join(", ")}). ` +
        `The strongest improving scenario (${bestImproving.label}) improves net avg R by ` +
        `${bestImproving.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"}R on ${bestImproving.remainingCount} trades. ` +
        `Before patching: (1) confirm gross R also improves; (2) check that remaining sample is large enough; ` +
        `(3) review with a human before deploying any execution filter.`;
    } else if (bestImproving) {
      answer =
        `Not yet. The ${bestImproving.label} scenario improves historical net avg R ` +
        `(Δ${bestImproving.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"}, ${bestImproving.remainingCount} remaining trades), ` +
        `but the evidence is based on ${summary.closedCount} total closes — below the threshold for a reliable patch. ` +
        `Continue collecting data. Re-audit at 50+ closes.`;
    } else {
      answer =
        `No — counterfactual exclusions do not show material improvement at this stage. ` +
        `Do not add execution filters based on this data. Focus instead on understanding ` +
        `whether the route's directional logic has edge in the current regime.`;
    }
    cards.push({ question: "Do we patch execution now?", answer });
  }

  return cards;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function buildEntryPrecisionAuditReport(
  input: EntryPrecisionAuditInput,
  now: Date = new Date(),
): EntryPrecisionAuditReport {
  const generatedAt = now.toISOString();
  const eraFilter: EntryPrecisionEraFilter = input.eraFilter ?? "POST_CALIBRATION";

  const records = flattenClosed(input.positions, eraFilter);

  // Summary stats
  const overall = computeGroupStats(records);
  const withDrift = records.filter((r) => r.hasDriftData);
  const highDriftRecs = records.filter((r) => r.absDriftPct !== null && r.absDriftPct > 0.5);
  const highChaseRecs = records.filter((r) => r.chaseRisk === "HIGH");
  const driftPcts = withDrift.map((r) => r.absDriftPct!);
  const driftAtrs = records.filter((r) => r.driftAtr !== null).map((r) => r.driftAtr!);

  // Count closed records (one per variant close) that carry drift data from their position.
  const positionsWithDriftData = records.filter((r) => r.hasDriftData).length;

  const avgEntryDriftPctOfZone = mean(driftPcts);
  const avgEntryDriftAtr = mean(driftAtrs);
  const highDriftRate = withDrift.length > 0 ? r4(highDriftRecs.length / withDrift.length) : null;
  const highChaseRate = records.length > 0 ? r4(highChaseRecs.length / records.length) : null;

  // Build sections
  const driftBuckets = buildDriftBuckets(records);
  const chaseBuckets = buildChaseBuckets(records);
  const counterfactuals = buildCounterfactuals(records);
  const routePrecision = buildRoutePrecision(records);
  const symbolPrecision = buildSymbolPrecision(records);

  const mainDiagnosis = computeMainDiagnosis(
    { closedCount: records.length, grossAvgR: overall.grossAvgR },
    counterfactuals,
  );

  const summary: EntryPrecisionSummary = {
    eraFilter,
    closedCount: records.length,
    positionsWithDriftData,
    netAvgR: overall.netAvgR,
    grossAvgR: overall.grossAvgR,
    profitFactor: overall.profitFactor,
    winRate: overall.winRate,
    tp1Rate: overall.tp1Rate,
    profitableTp1Rate: overall.profitableTp1Rate,
    slRate: overall.slRate,
    avgWinR: overall.avgWinR,
    avgLossR: overall.avgLossR,
    avgEntryDriftPctOfZone,
    avgEntryDriftAtr,
    highDriftCount: highDriftRecs.length,
    highDriftRate,
    highChaseCount: highChaseRecs.length,
    highChaseRate,
    mainDiagnosis,
  };

  const flags = buildFlags(summary, driftBuckets, chaseBuckets, counterfactuals);
  const answerCards = buildAnswerCards(summary, counterfactuals, flags);

  return {
    generatedAt,
    eraFilter,
    summary,
    driftBuckets,
    chaseBuckets,
    counterfactuals,
    routePrecision,
    symbolPrecision,
    flags,
    answerCards,
    notes: [
      "Entry Precision Audit is read-only. It does not block trades, reroute plans, or change shadow execution.",
      "driftBucket based on |entryDriftPct|: INSIDE_OR_BETTER≤0, LOW≤25%, MODERATE≤50%, HIGH≤100%, EXTREME>100%.",
      "counterfactuals are historical simulations on already-closed trades only — not forward-looking signals.",
      "TOO_FEW_SAMPLES when remaining < 5 trades after exclusion — not statistically meaningful.",
      "mainDiagnosis ENTRY_PRECISION_LIKELY_PRIMARY_LEAK requires grossAvgR < 0 AND a strongly improving counterfactual.",
    ],
  };
}

import type { ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra } from "@dtc/shared";

/**
 * STOP GEOMETRY & RR CREDIBILITY AUDIT
 *
 * Read-only diagnostic that tests whether current POST_CALIBRATION losses are
 * primarily driven by:
 *   1. Overly tight stop geometry (stops clipped by normal noise)
 *   2. Inflated projected risk/reward created by narrow stops
 *   3. The combination of tight stop + extreme RR (the "false-edge" quadrant)
 *
 * Source hypothesis from winner-vs-loser audit:
 *   - Winner avg stop: 338 bps   Loser avg stop: 127 bps  (MODERATE separation)
 *   - Winner avg RR:  3.52        Loser avg RR: 9.30       (MODERATE loser-skew)
 *
 * Core tools:
 *   - Stop-distance and RR bucket tables
 *   - Combined stop × RR geometry matrix
 *   - Historical counterfactual simulations (exclude/keep subsets)
 *   - Confounder-control slices (symbol / direction / playbook)
 *   - Threshold discovery
 *   - Patch hypotheses (read-only)
 *
 * Does NOT change:
 *   - scanner ranking or Top-10 selection
 *   - opportunity/confidence scoring
 *   - routeMode decisions or variant selection
 *   - shadow fill, close, or cost logic
 *   - calibrated expectancy or route maturity
 *   - live readiness gates, symbol quarantine, trade caps
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type StopGeometryEraFilter = "POST_CALIBRATION" | "POST_ROUTING" | "ALL";

export type StopBucket =
  | "ULTRA_TIGHT"    // < 100 bps
  | "TIGHT"          // 100–175 bps
  | "MODERATE"       // 175–300 bps
  | "WIDE"           // 300–500 bps
  | "VERY_WIDE"      // > 500 bps
  | "UNKNOWN";

export type RRBucket =
  | "LOW_RR"         // < 3
  | "NORMAL_RR"      // 3–5
  | "HIGH_RR"        // 5–8
  | "EXTREME_RR"     // > 8
  | "UNKNOWN";

export type GeometryVerdict =
  | "TOXIC"
  | "WEAK"
  | "MIXED"
  | "PROMISING"
  | "TOO_EARLY";

export type StopGeometryMainDiagnosis =
  | "STOP_GEOMETRY_LIKELY_PRIMARY_LEAK"
  | "HIGH_RR_FALSE_EDGE_LIKELY"
  | "STOP_AND_RR_COMBINED_LEAK"
  | "NOT_CONFIRMED"
  | "INSUFFICIENT_SAMPLE";

export type SGCounterfactualInterpretation =
  | "STRONGLY_IMPROVES"
  | "MODESTLY_IMPROVES"
  | "NO_CLEAR_CHANGE"
  | "WORSENS"
  | "TOO_FEW_SAMPLES";

export type SGScenarioCode =
  | "BASELINE_ALL"
  | "EXCLUDE_STOP_LT_100"
  | "EXCLUDE_STOP_LT_175"
  | "EXCLUDE_RR_GT_8"
  | "EXCLUDE_RR_GT_5"
  | "EXCLUDE_STOP_LT_175_AND_RR_GT_5"
  | "KEEP_ONLY_STOP_GTE_175"
  | "KEEP_ONLY_RR_BETWEEN_3_AND_5"
  | "KEEP_ONLY_STOP_GTE_175_AND_RR_BETWEEN_3_AND_5";

export type ThresholdType = "STOP" | "RR" | "COMBINED";
export type ThresholdCaution = "EARLY" | "WATCH" | "STRONG_SIGNAL";

export type StopGeometryFlagCode =
  | "TIGHT_STOP_LOSER_SKEW"
  | "EXTREME_RR_LOSER_SKEW"
  | "TIGHT_STOP_PLUS_HIGH_RR_TOXIC"
  | "AVG_LOSS_EXPANDS_WITH_TIGHT_STOP"
  | "HIGH_RR_NOT_REALIZED"
  | "STOP_DISTANCE_SEPARATOR_EMERGING"
  | "RR_CREDIBILITY_PROBLEM_EMERGING"
  | "SAMPLE_TOO_EARLY_FOR_PATCH";

export type SGFlagSeverity = "INFO" | "WARN" | "CRITICAL";

export interface StopGeometrySummary {
  eraFilter: StopGeometryEraFilter;
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  avgStopDistanceBps: number | null;
  avgRiskReward: number | null;
  avgStopDistanceBpsWinners: number | null;
  avgStopDistanceBpsLosers: number | null;
  avgRiskRewardWinners: number | null;
  avgRiskRewardLosers: number | null;
  mainDiagnosis: StopGeometryMainDiagnosis;
}

export interface StopBucketRow {
  bucket: StopBucket;
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
  avgRiskReward: number | null;
  totalNetRContribution: number;
  diagnosis: string;
}

export interface RRBucketRow {
  bucket: RRBucket;
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
  avgStopDistanceBps: number | null;
  totalNetRContribution: number;
  diagnosis: string;
}

export interface GeometryMatrixCell {
  stopBucket: StopBucket;
  rrBucket: RRBucket;
  closedCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  totalNetRContribution: number;
  verdict: GeometryVerdict;
}

export interface SGCounterfactualScenario {
  scenarioCode: SGScenarioCode;
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
  interpretation: SGCounterfactualInterpretation;
}

export interface ConfounderSlice {
  sliceType: "direction" | "symbol" | "playbook";
  sliceValue: string;
  closedCount: number;
  avgStopDistanceBps: number | null;
  avgRiskReward: number | null;
  netAvgR: number | null;
  profitFactor: number | null;
  slRate: number | null;
  tightStopRate: number | null;    // share with stopDistanceBps < 175
  extremeRRRate: number | null;    // share with riskReward > 5
  geometryPatternNote: string;     // whether the tight-stop/extreme-RR pattern appears
}

export interface ThresholdInsight {
  thresholdType: ThresholdType;
  thresholdLabel: string;
  supportedByClosedCount: number;
  affectedTrades: number;
  excludedTradesNetAvgR: number | null;
  retainedTradesNetAvgR: number | null;
  caution: ThresholdCaution;
}

export interface SGPatchHypothesis {
  title: string;
  observedEvidence: string;
  likelyPatchSurface: "scorer penalty" | "route eligibility" | "planner explanation only" | "no patch yet";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  recommendation: "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";
}

export interface StopGeometryFlag {
  code: StopGeometryFlagCode;
  severity: SGFlagSeverity;
  message: string;
}

export interface StopGeometryAuditReport {
  generatedAt: string;
  eraFilter: StopGeometryEraFilter;
  summary: StopGeometrySummary;
  stopBuckets: StopBucketRow[];
  rrBuckets: RRBucketRow[];
  geometryMatrix: GeometryMatrixCell[];
  counterfactuals: SGCounterfactualScenario[];
  confounderSlices: ConfounderSlice[];
  thresholdInsights: ThresholdInsight[];
  patchHypotheses: SGPatchHypothesis[];
  flags: StopGeometryFlag[];
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

export interface StopGeometryAuditInput {
  positions: ShadowPosition[];
  eraFilter?: StopGeometryEraFilter;
}

// ─── Internal record ──────────────────────────────────────────────────────────

interface ClosedRecord {
  netR: number;
  grossR: number;
  tp1Hit: boolean;
  closeReason: string;
  isWinner: boolean;
  isLoser: boolean;
  symbol: string;
  direction: string;
  stopDistanceBps: number | null;
  riskReward: number | null;
  entryPlaybook: string;
  stopBucket: StopBucket;
  rrBucket: RRBucket;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function meanNum(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return r4(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function eraInFilter(p: ShadowPosition, filter: StopGeometryEraFilter): boolean {
  if (filter === "ALL") return true;
  const era = classifyEvidenceEra(p);
  if (filter === "POST_CALIBRATION") return era === "POST_CALIBRATION";
  return era === "POST_ROUTING_PRE_CALIBRATION" || era === "POST_CALIBRATION";
}

function closedVariants(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

function classifyStopBucket(bps: number | null): StopBucket {
  if (bps === null || bps === undefined) return "UNKNOWN";
  if (bps < 100) return "ULTRA_TIGHT";
  if (bps < 175) return "TIGHT";
  if (bps < 300) return "MODERATE";
  if (bps < 500) return "WIDE";
  return "VERY_WIDE";
}

function classifyRRBucket(rr: number | null): RRBucket {
  if (rr === null || rr === undefined || rr <= 0) return "UNKNOWN";
  if (rr < 3) return "LOW_RR";
  if (rr < 5) return "NORMAL_RR";
  if (rr < 8) return "HIGH_RR";
  return "EXTREME_RR";
}

function flattenClosed(positions: ShadowPosition[], eraFilter: StopGeometryEraFilter): ClosedRecord[] {
  const out: ClosedRecord[] = [];
  for (const p of positions) {
    if (!eraInFilter(p, eraFilter)) continue;
    const cvs = closedVariants(p);
    if (cvs.length === 0) continue;

    const sel = p.variantSelection;
    const plan = p.tradePlan;
    const stopBps: number | null = p.stopDistanceBps ?? sel?.stopDistanceBps ?? null;
    const rr: number | null = p.riskReward ?? null;
    const entryPlaybook: string = plan?.entryPlaybook ?? "UNKNOWN";

    for (const v of cvs) {
      out.push({
        netR: v.realizedNetR,
        grossR: v.realizedGrossR,
        tp1Hit: v.tp1Hit,
        closeReason: v.closeReason ?? "UNKNOWN",
        isWinner: v.realizedNetR > 0,
        isLoser: v.realizedNetR < 0,
        symbol: p.symbol,
        direction: p.direction,
        stopDistanceBps: stopBps,
        riskReward: rr,
        entryPlaybook,
        stopBucket: classifyStopBucket(stopBps),
        rrBucket: classifyRRBucket(rr),
      });
    }
  }
  return out;
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

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

function computeStats(records: ClosedRecord[]): GroupStats {
  if (records.length === 0) {
    return {
      closedCount: 0, netAvgR: null, grossAvgR: null, totalNetR: 0, profitFactor: null,
      winRate: null, tp1Rate: null, profitableTp1Rate: null, slRate: null,
      avgWinR: null, avgLossR: null,
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

// ─── A. Summary ───────────────────────────────────────────────────────────────

function buildSummary(
  records: ClosedRecord[],
  eraFilter: StopGeometryEraFilter,
): StopGeometrySummary {
  const stats = computeStats(records);
  const winners = records.filter((r) => r.isWinner);
  const losers = records.filter((r) => r.isLoser);

  const allStop = records.map((r) => r.stopDistanceBps).filter((v): v is number => v !== null);
  const winStop = winners.map((r) => r.stopDistanceBps).filter((v): v is number => v !== null);
  const loseStop = losers.map((r) => r.stopDistanceBps).filter((v): v is number => v !== null);
  const allRR = records.map((r) => r.riskReward).filter((v): v is number => v !== null);
  const winRR = winners.map((r) => r.riskReward).filter((v): v is number => v !== null);
  const loseRR = losers.map((r) => r.riskReward).filter((v): v is number => v !== null);

  const avgStopW = meanNum(winStop);
  const avgStopL = meanNum(loseStop);
  const avgRRW = meanNum(winRR);
  const avgRRL = meanNum(loseRR);

  let mainDiagnosis: StopGeometryMainDiagnosis = "INSUFFICIENT_SAMPLE";
  if (records.length >= 10) {
    const stopSeparation = avgStopW !== null && avgStopL !== null
      ? (avgStopW - avgStopL) / Math.max(avgStopW, avgStopL)
      : 0;
    const rrSeparation = avgRRW !== null && avgRRL !== null
      ? (avgRRL - avgRRW) / Math.max(avgRRW, avgRRL)
      : 0;
    const stopIsSeparator = stopSeparation > 0.25; // winners' stop is materially wider
    const rrIsFalseEdge = rrSeparation > 0.25;     // losers have materially higher RR

    if (stopIsSeparator && rrIsFalseEdge) {
      mainDiagnosis = "STOP_AND_RR_COMBINED_LEAK";
    } else if (stopIsSeparator) {
      mainDiagnosis = "STOP_GEOMETRY_LIKELY_PRIMARY_LEAK";
    } else if (rrIsFalseEdge) {
      mainDiagnosis = "HIGH_RR_FALSE_EDGE_LIKELY";
    } else {
      mainDiagnosis = "NOT_CONFIRMED";
    }
  }

  return {
    eraFilter,
    closedCount: records.length,
    netAvgR: stats.netAvgR,
    grossAvgR: stats.grossAvgR,
    profitFactor: stats.profitFactor,
    winRate: stats.winRate,
    avgWinR: stats.avgWinR,
    avgLossR: stats.avgLossR,
    avgStopDistanceBps: meanNum(allStop),
    avgRiskReward: meanNum(allRR),
    avgStopDistanceBpsWinners: avgStopW,
    avgStopDistanceBpsLosers: avgStopL,
    avgRiskRewardWinners: avgRRW,
    avgRiskRewardLosers: avgRRL,
    mainDiagnosis,
  };
}

// ─── B. Stop-distance buckets ─────────────────────────────────────────────────

const STOP_BUCKET_ORDER: StopBucket[] = ["ULTRA_TIGHT", "TIGHT", "MODERATE", "WIDE", "VERY_WIDE", "UNKNOWN"];

function stopBucketDiagnosis(row: { netAvgR: number | null; slRate: number | null; closedCount: number }): string {
  if (row.closedCount < 3) return "Too few trades to diagnose.";
  if ((row.netAvgR ?? 0) < -0.5 && (row.slRate ?? 0) > 0.6) return "High SL rate with deep average loss — geometry is destructive here.";
  if ((row.netAvgR ?? 0) < -0.2) return "Net negative — stop placement at this width is underperforming.";
  if ((row.netAvgR ?? 0) > 0.1) return "Positive net R — geometry appears workable at this width.";
  return "Mixed / inconclusive performance at this stop width.";
}

function buildStopBuckets(records: ClosedRecord[], total: number): StopBucketRow[] {
  const grouped = new Map<StopBucket, ClosedRecord[]>();
  for (const r of records) {
    const arr = grouped.get(r.stopBucket) ?? [];
    arr.push(r);
    grouped.set(r.stopBucket, arr);
  }

  return STOP_BUCKET_ORDER
    .filter((b) => grouped.has(b))
    .map((b) => {
      const recs = grouped.get(b)!;
      const stats = computeStats(recs);
      const rrVals = recs.map((r) => r.riskReward).filter((v): v is number => v !== null);
      return {
        bucket: b,
        closedCount: recs.length,
        sharePct: r4(recs.length / total),
        netAvgR: stats.netAvgR,
        grossAvgR: stats.grossAvgR,
        profitFactor: stats.profitFactor,
        winRate: stats.winRate,
        tp1Rate: stats.tp1Rate,
        profitableTp1Rate: stats.profitableTp1Rate,
        slRate: stats.slRate,
        avgWinR: stats.avgWinR,
        avgLossR: stats.avgLossR,
        avgRiskReward: meanNum(rrVals),
        totalNetRContribution: stats.totalNetR,
        diagnosis: stopBucketDiagnosis({ netAvgR: stats.netAvgR, slRate: stats.slRate, closedCount: recs.length }),
      };
    });
}

// ─── C. RR buckets ────────────────────────────────────────────────────────────

const RR_BUCKET_ORDER: RRBucket[] = ["LOW_RR", "NORMAL_RR", "HIGH_RR", "EXTREME_RR", "UNKNOWN"];

function rrBucketDiagnosis(row: { netAvgR: number | null; slRate: number | null; closedCount: number; bucket: RRBucket }): string {
  if (row.closedCount < 3) return "Too few trades to diagnose.";
  if (row.bucket === "EXTREME_RR" && (row.netAvgR ?? 0) < -0.3) {
    return "Extreme projected RR is not being realized — this is the false-edge pattern. High RR created by tight stop, not wide TP.";
  }
  if (row.bucket === "HIGH_RR" && (row.netAvgR ?? 0) < -0.2) {
    return "High projected RR underperforming — suspect stop is too narrow to avoid noise.";
  }
  if ((row.netAvgR ?? 0) > 0.0 && (row.bucket === "NORMAL_RR" || row.bucket === "LOW_RR")) {
    return "Modest projected RR appears realizable at this sample — planner may be better calibrated here.";
  }
  return "Mixed / inconclusive performance for this RR tier.";
}

function buildRRBuckets(records: ClosedRecord[], total: number): RRBucketRow[] {
  const grouped = new Map<RRBucket, ClosedRecord[]>();
  for (const r of records) {
    const arr = grouped.get(r.rrBucket) ?? [];
    arr.push(r);
    grouped.set(r.rrBucket, arr);
  }

  return RR_BUCKET_ORDER
    .filter((b) => grouped.has(b))
    .map((b) => {
      const recs = grouped.get(b)!;
      const stats = computeStats(recs);
      const stopVals = recs.map((r) => r.stopDistanceBps).filter((v): v is number => v !== null);
      const row = {
        bucket: b,
        closedCount: recs.length,
        sharePct: r4(recs.length / total),
        netAvgR: stats.netAvgR,
        grossAvgR: stats.grossAvgR,
        profitFactor: stats.profitFactor,
        winRate: stats.winRate,
        tp1Rate: stats.tp1Rate,
        profitableTp1Rate: stats.profitableTp1Rate,
        slRate: stats.slRate,
        avgWinR: stats.avgWinR,
        avgLossR: stats.avgLossR,
        avgStopDistanceBps: meanNum(stopVals),
        totalNetRContribution: stats.totalNetR,
        diagnosis: "",
      };
      row.diagnosis = rrBucketDiagnosis({ netAvgR: row.netAvgR, slRate: row.slRate, closedCount: row.closedCount, bucket: b });
      return row;
    });
}

// ─── D. Combined geometry matrix ──────────────────────────────────────────────

function geometryVerdict(stats: GroupStats): GeometryVerdict {
  if (stats.closedCount < 3) return "TOO_EARLY";
  if ((stats.netAvgR ?? 0) > 0.1 && (stats.winRate ?? 0) > 0.5) return "PROMISING";
  if ((stats.netAvgR ?? 0) < -0.4 && (stats.slRate ?? 0) > 0.5) return "TOXIC";
  if ((stats.netAvgR ?? 0) < -0.15) return "WEAK";
  return "MIXED";
}

function buildGeometryMatrix(records: ClosedRecord[]): GeometryMatrixCell[] {
  const grouped = new Map<string, ClosedRecord[]>();
  for (const r of records) {
    const key = `${r.stopBucket}||${r.rrBucket}`;
    const arr = grouped.get(key) ?? [];
    arr.push(r);
    grouped.set(key, arr);
  }

  const cells: GeometryMatrixCell[] = [];
  for (const [key, recs] of grouped) {
    const [stopBucket, rrBucket] = key.split("||") as [StopBucket, RRBucket];
    const stats = computeStats(recs);
    cells.push({
      stopBucket,
      rrBucket,
      closedCount: stats.closedCount,
      netAvgR: stats.netAvgR,
      profitFactor: stats.profitFactor,
      winRate: stats.winRate,
      slRate: stats.slRate,
      avgWinR: stats.avgWinR,
      avgLossR: stats.avgLossR,
      totalNetRContribution: stats.totalNetR,
      verdict: geometryVerdict(stats),
    });
  }

  // Sort: worst net R first (TOXIC at top)
  return cells.sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0));
}

// ─── E. Counterfactuals ───────────────────────────────────────────────────────

type ScenarioDef = {
  code: SGScenarioCode;
  label: string;
  keep: (r: ClosedRecord) => boolean;
};

const SCENARIO_DEFS: ScenarioDef[] = [
  {
    code: "BASELINE_ALL",
    label: "Baseline — all closed trades",
    keep: () => true,
  },
  {
    code: "EXCLUDE_STOP_LT_100",
    label: "Exclude ultra-tight stops (< 100 bps)",
    keep: (r) => r.stopDistanceBps !== null && r.stopDistanceBps >= 100,
  },
  {
    code: "EXCLUDE_STOP_LT_175",
    label: "Exclude tight stops (< 175 bps)",
    keep: (r) => r.stopDistanceBps !== null && r.stopDistanceBps >= 175,
  },
  {
    code: "EXCLUDE_RR_GT_8",
    label: "Exclude extreme projected RR (> 8×)",
    keep: (r) => r.riskReward === null || r.riskReward <= 8,
  },
  {
    code: "EXCLUDE_RR_GT_5",
    label: "Exclude high projected RR (> 5×)",
    keep: (r) => r.riskReward === null || r.riskReward <= 5,
  },
  {
    code: "EXCLUDE_STOP_LT_175_AND_RR_GT_5",
    label: "Exclude tight stop (< 175 bps) AND high RR (> 5×)",
    keep: (r) =>
      !(
        r.stopDistanceBps !== null && r.stopDistanceBps < 175 &&
        r.riskReward !== null && r.riskReward > 5
      ),
  },
  {
    code: "KEEP_ONLY_STOP_GTE_175",
    label: "Keep only: stop ≥ 175 bps",
    keep: (r) => r.stopDistanceBps !== null && r.stopDistanceBps >= 175,
  },
  {
    code: "KEEP_ONLY_RR_BETWEEN_3_AND_5",
    label: "Keep only: RR 3–5×",
    keep: (r) => r.riskReward !== null && r.riskReward >= 3 && r.riskReward <= 5,
  },
  {
    code: "KEEP_ONLY_STOP_GTE_175_AND_RR_BETWEEN_3_AND_5",
    label: "Keep only: stop ≥ 175 bps AND RR 3–5×",
    keep: (r) =>
      r.stopDistanceBps !== null && r.stopDistanceBps >= 175 &&
      r.riskReward !== null && r.riskReward >= 3 && r.riskReward <= 5,
  },
];

function cfInterpretation(
  deltaNetR: number | null,
  deltaPF: number | null,
  remaining: number,
): SGCounterfactualInterpretation {
  if (remaining < 5) return "TOO_FEW_SAMPLES";
  if (deltaNetR === null) return "NO_CLEAR_CHANGE";
  if (deltaNetR > 0.15 && (deltaPF ?? 0) > 0.1) return "STRONGLY_IMPROVES";
  if (deltaNetR > 0.05) return "MODESTLY_IMPROVES";
  if (deltaNetR < -0.05) return "WORSENS";
  return "NO_CLEAR_CHANGE";
}

function buildCounterfactuals(records: ClosedRecord[]): SGCounterfactualScenario[] {
  const baselineStats = computeStats(records);
  const total = records.length;

  return SCENARIO_DEFS.map((def) => {
    const kept = records.filter(def.keep);
    const stats = computeStats(kept);
    const excluded = total - kept.length;
    const deltaNetR = stats.netAvgR !== null && baselineStats.netAvgR !== null
      ? r4(stats.netAvgR - baselineStats.netAvgR)
      : null;
    const deltaPF = stats.profitFactor !== null && baselineStats.profitFactor !== null
      ? r4(stats.profitFactor - baselineStats.profitFactor)
      : null;
    const deltaSL = stats.slRate !== null && baselineStats.slRate !== null
      ? r4(stats.slRate - baselineStats.slRate)
      : null;

    return {
      scenarioCode: def.code,
      label: def.label,
      excludedCount: excluded,
      remainingCount: kept.length,
      remainingSharePct: total === 0 ? 0 : r4(kept.length / total),
      netAvgR: stats.netAvgR,
      grossAvgR: stats.grossAvgR,
      profitFactor: stats.profitFactor,
      winRate: stats.winRate,
      tp1Rate: stats.tp1Rate,
      profitableTp1Rate: stats.profitableTp1Rate,
      slRate: stats.slRate,
      avgWinR: stats.avgWinR,
      avgLossR: stats.avgLossR,
      deltaNetAvgRVsBaseline: deltaNetR,
      deltaPFVsBaseline: deltaPF,
      deltaSLRateVsBaseline: deltaSL,
      interpretation: cfInterpretation(deltaNetR, deltaPF, kept.length),
    };
  });
}

// ─── F. Confounder control slices ─────────────────────────────────────────────

const FOCUS_SYMBOLS = ["BNBUSDT", "NEARUSDT", "DOGEUSDT", "BTCUSDT", "SUIUSDT"];
const FOCUS_PLAYBOOKS = ["PULLBACK_RECLAIM"];

function buildConfounderSlice(
  sliceType: ConfounderSlice["sliceType"],
  sliceValue: string,
  recs: ClosedRecord[],
): ConfounderSlice {
  const stats = computeStats(recs);
  const stopVals = recs.map((r) => r.stopDistanceBps).filter((v): v is number => v !== null);
  const rrVals = recs.map((r) => r.riskReward).filter((v): v is number => v !== null);
  const tightCount = recs.filter((r) => r.stopDistanceBps !== null && r.stopDistanceBps < 175).length;
  const extremeRRCount = recs.filter((r) => r.riskReward !== null && r.riskReward > 5).length;
  const tightStopRate = recs.length > 0 ? r4(tightCount / recs.length) : null;
  const extremeRRRate = recs.length > 0 ? r4(extremeRRCount / recs.length) : null;

  let geometryPatternNote = "";
  if (recs.length < 3) {
    geometryPatternNote = "Too few trades to assess geometry independently.";
  } else {
    const parts: string[] = [];
    if ((tightStopRate ?? 0) > 0.5) parts.push(`tight stop dominant (${(tightStopRate! * 100).toFixed(0)}%)`);
    if ((extremeRRRate ?? 0) > 0.5) parts.push(`extreme RR dominant (${(extremeRRRate! * 100).toFixed(0)}%)`);
    if (parts.length === 0) {
      geometryPatternNote = `Geometry is mixed in this slice — tight-stop/extreme-RR pattern not concentrated here.`;
    } else {
      geometryPatternNote =
        `Geometry pattern present within this slice: ${parts.join(" + ")}. ` +
        `Net avg R here: ${stats.netAvgR?.toFixed(4) ?? "n/a"}R — ` +
        ((stats.netAvgR ?? 0) < -0.2
          ? "geometry problem appears independently in this slice too."
          : "performance here is less poor, suggesting concentration may drive the aggregate.");
    }
  }

  return {
    sliceType,
    sliceValue,
    closedCount: recs.length,
    avgStopDistanceBps: meanNum(stopVals),
    avgRiskReward: meanNum(rrVals),
    netAvgR: stats.netAvgR,
    profitFactor: stats.profitFactor,
    slRate: stats.slRate,
    tightStopRate,
    extremeRRRate,
    geometryPatternNote,
  };
}

function buildConfounderSlices(records: ClosedRecord[]): ConfounderSlice[] {
  const slices: ConfounderSlice[] = [];

  // By direction
  for (const dir of ["LONG", "SHORT"]) {
    const recs = records.filter((r) => r.direction === dir);
    if (recs.length > 0) slices.push(buildConfounderSlice("direction", dir, recs));
  }

  // By symbol (focus set + any with ≥3 closes)
  const symbolGroups = new Map<string, ClosedRecord[]>();
  for (const r of records) {
    const arr = symbolGroups.get(r.symbol) ?? [];
    arr.push(r);
    symbolGroups.set(r.symbol, arr);
  }
  for (const sym of FOCUS_SYMBOLS) {
    const recs = symbolGroups.get(sym) ?? [];
    if (recs.length > 0) slices.push(buildConfounderSlice("symbol", sym, recs));
  }
  // Any other symbol with ≥3 closes
  for (const [sym, recs] of symbolGroups) {
    if (!FOCUS_SYMBOLS.includes(sym) && recs.length >= 3) {
      slices.push(buildConfounderSlice("symbol", sym, recs));
    }
  }

  // By playbook
  for (const pb of FOCUS_PLAYBOOKS) {
    const recs = records.filter((r) => r.entryPlaybook === pb);
    if (recs.length > 0) slices.push(buildConfounderSlice("playbook", pb, recs));
  }
  // Other playbooks with ≥3 closes
  const pbGroups = new Map<string, ClosedRecord[]>();
  for (const r of records) {
    const arr = pbGroups.get(r.entryPlaybook) ?? [];
    arr.push(r);
    pbGroups.set(r.entryPlaybook, arr);
  }
  for (const [pb, recs] of pbGroups) {
    if (!FOCUS_PLAYBOOKS.includes(pb) && pb !== "UNKNOWN" && recs.length >= 3) {
      slices.push(buildConfounderSlice("playbook", pb, recs));
    }
  }

  return slices;
}

// ─── G. Threshold discovery ───────────────────────────────────────────────────

function buildThresholdInsights(records: ClosedRecord[]): ThresholdInsight[] {
  const insights: ThresholdInsight[] = [];
  const total = records.length;
  if (total < 5) return insights;

  // STOP thresholds
  for (const threshold of [100, 175, 300]) {
    const affected = records.filter((r) => r.stopDistanceBps !== null && r.stopDistanceBps < threshold);
    const retained = records.filter((r) => r.stopDistanceBps !== null && r.stopDistanceBps >= threshold);
    if (affected.length < 3 || retained.length < 3) continue;
    const affStats = computeStats(affected);
    const retStats = computeStats(retained);
    const caution: ThresholdCaution =
      retained.length >= 15 && (retStats.netAvgR ?? 0) - (affStats.netAvgR ?? 0) > 0.25
        ? "STRONG_SIGNAL"
        : retained.length >= 8
        ? "WATCH"
        : "EARLY";
    insights.push({
      thresholdType: "STOP",
      thresholdLabel: `stopDistanceBps < ${threshold}`,
      supportedByClosedCount: total,
      affectedTrades: affected.length,
      excludedTradesNetAvgR: affStats.netAvgR,
      retainedTradesNetAvgR: retStats.netAvgR,
      caution,
    });
  }

  // RR thresholds
  for (const threshold of [5, 8]) {
    const affected = records.filter((r) => r.riskReward !== null && r.riskReward > threshold);
    const retained = records.filter((r) => r.riskReward !== null && r.riskReward <= threshold);
    if (affected.length < 3 || retained.length < 3) continue;
    const affStats = computeStats(affected);
    const retStats = computeStats(retained);
    const caution: ThresholdCaution =
      retained.length >= 15 && (retStats.netAvgR ?? 0) - (affStats.netAvgR ?? 0) > 0.25
        ? "STRONG_SIGNAL"
        : retained.length >= 8
        ? "WATCH"
        : "EARLY";
    insights.push({
      thresholdType: "RR",
      thresholdLabel: `riskReward > ${threshold}`,
      supportedByClosedCount: total,
      affectedTrades: affected.length,
      excludedTradesNetAvgR: affStats.netAvgR,
      retainedTradesNetAvgR: retStats.netAvgR,
      caution,
    });
  }

  // COMBINED threshold
  const combined = records.filter(
    (r) => r.stopDistanceBps !== null && r.stopDistanceBps < 175 &&
            r.riskReward !== null && r.riskReward > 5,
  );
  const combinedOut = records.filter(
    (r) => !(r.stopDistanceBps !== null && r.stopDistanceBps < 175 && r.riskReward !== null && r.riskReward > 5),
  );
  if (combined.length >= 3 && combinedOut.length >= 3) {
    const combStats = computeStats(combined);
    const outStats = computeStats(combinedOut);
    const delta = (outStats.netAvgR ?? 0) - (combStats.netAvgR ?? 0);
    const caution: ThresholdCaution =
      combinedOut.length >= 15 && delta > 0.3
        ? "STRONG_SIGNAL"
        : combinedOut.length >= 8
        ? "WATCH"
        : "EARLY";
    insights.push({
      thresholdType: "COMBINED",
      thresholdLabel: "stopDistanceBps < 175 AND riskReward > 5",
      supportedByClosedCount: total,
      affectedTrades: combined.length,
      excludedTradesNetAvgR: combStats.netAvgR,
      retainedTradesNetAvgR: outStats.netAvgR,
      caution,
    });
  }

  return insights;
}

// ─── H. Patch hypotheses ──────────────────────────────────────────────────────

function buildPatchHypotheses(
  summary: StopGeometrySummary,
  counterfactuals: SGCounterfactualScenario[],
  thresholds: ThresholdInsight[],
): SGPatchHypothesis[] {
  const hypotheses: SGPatchHypothesis[] = [];

  // 1. Combined stop + RR counterfactual strongly improves
  const combCF = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_STOP_LT_175_AND_RR_GT_5");
  if (combCF && combCF.interpretation === "STRONGLY_IMPROVES") {
    hypotheses.push({
      title: "Penalize or block trades with tight stop (< 175 bps) AND high projected RR (> 5×)",
      observedEvidence:
        `Excluding tight-stop + high-RR trades improves net avg R by ${combCF.deltaNetAvgRVsBaseline?.toFixed(4)}R ` +
        `and PF by ${combCF.deltaPFVsBaseline?.toFixed(4)} (${combCF.remainingCount} trades remain). ` +
        `This is the strongest counterfactual signal.`,
      likelyPatchSurface: "route eligibility",
      confidence: combCF.remainingCount >= 15 ? "MEDIUM" : "LOW",
      recommendation: combCF.remainingCount >= 15 ? "AUDIT_DEEPER" : "WATCH",
    });
  }

  // 2. Stop-only counterfactual strongly improves
  const stopCF = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_STOP_LT_175");
  if (stopCF && (stopCF.interpretation === "STRONGLY_IMPROVES" || stopCF.interpretation === "MODESTLY_IMPROVES")) {
    hypotheses.push({
      title: "Require minimum stop distance (≥ 175 bps) before route is eligible",
      observedEvidence:
        `Excluding trades with stop < 175 bps: net avg R changes by ${stopCF.deltaNetAvgRVsBaseline?.toFixed(4)}R ` +
        `(${stopCF.remainingCount} trades remain, ${stopCF.interpretation.replace(/_/g, " ").toLowerCase()}).`,
      likelyPatchSurface: "route eligibility",
      confidence: stopCF.remainingCount >= 10 ? "MEDIUM" : "LOW",
      recommendation: stopCF.remainingCount >= 15 ? "AUDIT_DEEPER" : "WATCH",
    });
  }

  // 3. RR-only counterfactual
  const rrCF = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_RR_GT_5");
  if (rrCF && (rrCF.interpretation === "STRONGLY_IMPROVES" || rrCF.interpretation === "MODESTLY_IMPROVES")) {
    hypotheses.push({
      title: "Do not reward extreme projected RR (> 5×) without stop-distance credibility",
      observedEvidence:
        `Excluding RR > 5× trades: net avg R changes by ${rrCF.deltaNetAvgRVsBaseline?.toFixed(4)}R ` +
        `(${rrCF.remainingCount} trades remain, ${rrCF.interpretation.replace(/_/g, " ").toLowerCase()}). ` +
        `High RR from narrow stops inflates planner-side edge without realizing it.`,
      likelyPatchSurface: "scorer penalty",
      confidence: rrCF.remainingCount >= 10 ? "MEDIUM" : "LOW",
      recommendation: "WATCH",
    });
  }

  // 4. Strong threshold signal
  const strongThreshold = thresholds.find((t) => t.caution === "STRONG_SIGNAL");
  if (strongThreshold) {
    hypotheses.push({
      title: `Add a route-eligibility gate at ${strongThreshold.thresholdLabel}`,
      observedEvidence:
        `Threshold insight: trades where ${strongThreshold.thresholdLabel} ` +
        `have net avg R ${strongThreshold.excludedTradesNetAvgR?.toFixed(4)}R ` +
        `vs ${strongThreshold.retainedTradesNetAvgR?.toFixed(4)}R retained ` +
        `(${strongThreshold.affectedTrades} affected trades).`,
      likelyPatchSurface: "route eligibility",
      confidence: "MEDIUM",
      recommendation: "READY_FOR_PATCH_DISCUSSION",
    });
  }

  // Fallback: no actionable candidate yet
  if (hypotheses.length === 0) {
    hypotheses.push({
      title: "No actionable patch candidate yet — continue collecting data",
      observedEvidence:
        `With ${summary.closedCount} closed trades, no counterfactual shows strong-enough improvement ` +
        `to justify a routing or scoring change. Stop/RR geometry pattern is present but not confirmed ` +
        `at the required confidence level. Accumulate to ≥30 closes per major bucket.`,
      likelyPatchSurface: "no patch yet",
      confidence: "LOW",
      recommendation: "WATCH",
    });
  }

  return hypotheses;
}

// ─── I. Flags ─────────────────────────────────────────────────────────────────

function buildFlags(
  summary: StopGeometrySummary,
  stopBuckets: StopBucketRow[],
  rrBuckets: RRBucketRow[],
  matrix: GeometryMatrixCell[],
  counterfactuals: SGCounterfactualScenario[],
): StopGeometryFlag[] {
  const flags: StopGeometryFlag[] = [];

  // Tight stop loser skew
  const stopW = summary.avgStopDistanceBpsWinners;
  const stopL = summary.avgStopDistanceBpsLosers;
  if (stopW !== null && stopL !== null && stopW > stopL * 1.5 && summary.closedCount >= 10) {
    flags.push({
      code: "TIGHT_STOP_LOSER_SKEW",
      severity: "WARN",
      message:
        `Winners average ${stopW.toFixed(0)} bps stop vs losers ${stopL.toFixed(0)} bps ` +
        `(${((stopW / stopL - 1) * 100).toFixed(0)}% wider). Tight stop is a significant loser predictor.`,
    });
    flags.push({
      code: "STOP_DISTANCE_SEPARATOR_EMERGING",
      severity: "INFO",
      message:
        `Stop distance is emerging as a winner-separator. ` +
        `Wider stop (${stopW.toFixed(0)} bps) correlates with winners; ` +
        `narrow stop (${stopL.toFixed(0)} bps) correlates with losers.`,
    });
  }

  // Extreme RR loser skew
  const rrW = summary.avgRiskRewardWinners;
  const rrL = summary.avgRiskRewardLosers;
  if (rrW !== null && rrL !== null && rrL > rrW * 1.5 && summary.closedCount >= 10) {
    flags.push({
      code: "EXTREME_RR_LOSER_SKEW",
      severity: "WARN",
      message:
        `Losers have average projected RR of ${rrL.toFixed(2)} vs winners ${rrW.toFixed(2)}. ` +
        `Higher projected RR is correlated with worse outcomes — classic false-edge from tight stops.`,
    });
    flags.push({
      code: "RR_CREDIBILITY_PROBLEM_EMERGING",
      severity: "WARN",
      message:
        `Projected RR is systematically overstated in losing trades (avg ${rrL.toFixed(2)}×). ` +
        `The planner's RR metric may be rewarding tight-stop setups rather than genuine upside.`,
    });
  }

  // Tight stop + high RR toxic matrix cell
  const toxicCell = matrix.find(
    (c) =>
      (c.stopBucket === "ULTRA_TIGHT" || c.stopBucket === "TIGHT") &&
      (c.rrBucket === "HIGH_RR" || c.rrBucket === "EXTREME_RR") &&
      c.verdict === "TOXIC",
  );
  if (toxicCell) {
    flags.push({
      code: "TIGHT_STOP_PLUS_HIGH_RR_TOXIC",
      severity: "CRITICAL",
      message:
        `The stop:${toxicCell.stopBucket} × RR:${toxicCell.rrBucket} cell is TOXIC ` +
        `(${toxicCell.closedCount} closes, net avg R ${toxicCell.netAvgR?.toFixed(4)}R, ` +
        `SL rate ${((toxicCell.slRate ?? 0) * 100).toFixed(0)}%). ` +
        `This combination is the primary loss driver.`,
    });
  }

  // Avg loss expands with tight stop
  const ultraTightBucket = stopBuckets.find((b) => b.bucket === "ULTRA_TIGHT");
  const wideBucket = stopBuckets.find((b) => b.bucket === "WIDE" || b.bucket === "VERY_WIDE");
  if (
    ultraTightBucket && wideBucket &&
    ultraTightBucket.avgLossR !== null && wideBucket.avgLossR !== null &&
    Math.abs(ultraTightBucket.avgLossR) > Math.abs(wideBucket.avgLossR) * 1.3 &&
    ultraTightBucket.closedCount >= 3
  ) {
    flags.push({
      code: "AVG_LOSS_EXPANDS_WITH_TIGHT_STOP",
      severity: "WARN",
      message:
        `Average loss in ULTRA_TIGHT bucket (${ultraTightBucket.avgLossR.toFixed(4)}R) ` +
        `exceeds wide-stop average loss (${wideBucket.avgLossR.toFixed(4)}R). ` +
        `Tight stops produce larger R-denominated losses when they trigger.`,
    });
  }

  // High RR not realized
  const extremeRRBucket = rrBuckets.find((b) => b.bucket === "EXTREME_RR");
  if (
    extremeRRBucket && extremeRRBucket.closedCount >= 3 &&
    (extremeRRBucket.netAvgR ?? 0) < -0.3
  ) {
    flags.push({
      code: "HIGH_RR_NOT_REALIZED",
      severity: "WARN",
      message:
        `EXTREME_RR trades (> 8×) have net avg R of ${extremeRRBucket.netAvgR?.toFixed(4)}R ` +
        `from ${extremeRRBucket.closedCount} closes. ` +
        `Extreme projected RR is not being realized — consistent with false-edge from tight stops.`,
    });
  }

  // Sample too early for patch
  if (summary.closedCount < 30) {
    flags.push({
      code: "SAMPLE_TOO_EARLY_FOR_PATCH",
      severity: "INFO",
      message:
        `Current sample (${summary.closedCount} closes) is below the 30-close minimum for reliable patch decisions. ` +
        `Patterns visible now are directionally informative but not confirmation-grade.`,
    });
  }

  return flags;
}

// ─── J. Answer cards ──────────────────────────────────────────────────────────

function buildAnswerCards(
  summary: StopGeometrySummary,
  counterfactuals: SGCounterfactualScenario[],
  confounderSlices: ConfounderSlice[],
  thresholds: ThresholdInsight[],
  hypotheses: SGPatchHypothesis[],
): Array<{ question: string; answer: string }> {
  const cards: Array<{ question: string; answer: string }> = [];
  const n = summary.closedCount;

  // 1. Are tight stops a real leak?
  {
    const stopW = summary.avgStopDistanceBpsWinners;
    const stopL = summary.avgStopDistanceBpsLosers;
    let answer: string;
    if (n < 10) {
      answer = `Too few closed trades (${n}) to answer reliably. Accumulate to ≥20 closes across both stop-width groups.`;
    } else if (stopW === null || stopL === null) {
      answer = `Insufficient stop-distance data across winners and losers to compare. Data coverage is incomplete.`;
    } else {
      const pct = ((stopW / stopL - 1) * 100).toFixed(0);
      const stopCF = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_STOP_LT_175");
      answer =
        `Evidence is ${stopW > stopL * 1.5 ? "moderately supportive" : "weak"}: ` +
        `winners average ${stopW.toFixed(0)} bps stop vs losers ${stopL.toFixed(0)} bps (${pct}% wider). ` +
        (stopCF
          ? `Excluding stops < 175 bps: net avg R ${stopCF.interpretation === "WORSENS" ? "worsens" : "changes by " + stopCF.deltaNetAvgRVsBaseline?.toFixed(4) + "R"} ` +
            `(${stopCF.interpretation.replace(/_/g, " ").toLowerCase()}, ${stopCF.remainingCount} trades remain). `
          : "") +
        (n < 30
          ? "Pattern is present but sample is below 30 closes — do not patch yet."
          : "Sample is approaching actionable size. Recommend deeper audit before patching.");
    }
    cards.push({ question: "Are tight stops a real leak?", answer });
  }

  // 2. Is projected RR currently trustworthy?
  {
    const rrW = summary.avgRiskRewardWinners;
    const rrL = summary.avgRiskRewardLosers;
    let answer: string;
    if (n < 10) {
      answer = `Too few closed trades (${n}) to assess RR credibility. Accumulate more data.`;
    } else if (rrW === null || rrL === null) {
      answer = `Insufficient RR data across winners and losers. RR field may not be populated consistently.`;
    } else {
      const isFalseEdge = rrL > rrW * 1.5;
      answer =
        `Projected RR is ${isFalseEdge ? "NOT credible — losers have higher projected RR than winners" : "showing mixed results"}. ` +
        `Winners avg RR: ${rrW.toFixed(2)}× | Losers avg RR: ${rrL.toFixed(2)}×. ` +
        (isFalseEdge
          ? `This is the false-edge pattern: high RR is being generated by tight stops (small denominator), not wide TP targets. ` +
            `The planner is rewarding stop tightness rather than genuine directional edge.`
          : `The RR separation (${((rrL / rrW - 1) * 100).toFixed(0)}%) is below the 50% threshold for a false-edge call.`) +
        (n < 30 ? " Sample is still early — watch for this pattern to strengthen." : "");
    }
    cards.push({ question: "Is projected RR currently trustworthy?", answer });
  }

  // 3. Is tight stop + high RR the toxic combination?
  {
    const combCF = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_STOP_LT_175_AND_RR_GT_5");
    const stopOnly = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_STOP_LT_175");
    const rrOnly = counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_RR_GT_5");
    let answer: string;
    if (!combCF) {
      answer = "Combined counterfactual data not available.";
    } else {
      const combDelta = combCF.deltaNetAvgRVsBaseline ?? 0;
      const stopDelta = stopOnly?.deltaNetAvgRVsBaseline ?? 0;
      const rrDelta = rrOnly?.deltaNetAvgRVsBaseline ?? 0;
      const combinationIsStrongest = Math.abs(combDelta) > Math.abs(stopDelta) && Math.abs(combDelta) > Math.abs(rrDelta);
      answer =
        `Combined exclusion (stop < 175 AND RR > 5): ${combCF.interpretation.replace(/_/g, " ").toLowerCase()}, ` +
        `Δ${combDelta >= 0 ? "+" : ""}${combDelta.toFixed(4)}R, ${combCF.remainingCount} trades remain. ` +
        `Stop-only: Δ${stopDelta >= 0 ? "+" : ""}${stopDelta.toFixed(4)}R. ` +
        `RR-only: Δ${rrDelta >= 0 ? "+" : ""}${rrDelta.toFixed(4)}R. ` +
        (combinationIsStrongest
          ? `The combination shows the largest improvement — supporting the "tight stop creates false RR" hypothesis.`
          : `The combination is not clearly the dominant driver at current sample size. Both effects are present but not yet isolable.`) +
        (combCF.remainingCount < 10 ? " Too few remaining trades to confirm." : "");
    }
    cards.push({ question: "Is tight stop + high RR the toxic combination?", answer });
  }

  // 4. Does this persist after controlling for symbol/direction/playbook?
  {
    const dirSlices = confounderSlices.filter((s) => s.sliceType === "direction");
    const symSlices = confounderSlices.filter((s) => s.sliceType === "symbol" && s.closedCount >= 3);
    let answer: string;
    if (dirSlices.length === 0 && symSlices.length === 0) {
      answer = "Not enough slice data to assess confounder control. Both directions or multiple symbols need ≥3 closes each.";
    } else {
      const longSlice = dirSlices.find((s) => s.sliceValue === "LONG");
      const shortSlice = dirSlices.find((s) => s.sliceValue === "SHORT");
      const confoundedSymbols = symSlices.filter((s) => (s.tightStopRate ?? 0) > 0.5 || (s.extremeRRRate ?? 0) > 0.5);
      answer =
        `Direction control: ` +
        (longSlice ? `LONG (${longSlice.closedCount} closes, avg stop ${longSlice.avgStopDistanceBps?.toFixed(0) ?? "?"} bps, net ${longSlice.netAvgR?.toFixed(4) ?? "?"}R). ` : "LONG data insufficient. ") +
        (shortSlice ? `SHORT (${shortSlice.closedCount} closes, avg stop ${shortSlice.avgStopDistanceBps?.toFixed(0) ?? "?"} bps, net ${shortSlice.netAvgR?.toFixed(4) ?? "?"}R). ` : "SHORT data insufficient. ") +
        (confoundedSymbols.length > 0
          ? `Symbol analysis: ${confoundedSymbols.map((s) => s.sliceValue).join(", ")} show geometry pattern within their own slice — suggesting the stop/RR issue is not purely from symbol concentration. `
          : "Geometry pattern does not appear independently within individual symbol slices with sufficient data — symbol concentration may be confounding the aggregate signal. ") +
        (n < 30 ? "Confounder analysis is limited by sample size." : "");
    }
    cards.push({ question: "Does this persist after controlling for symbol/direction/playbook?", answer });
  }

  // 5. Can we patch now?
  {
    const bestHyp = hypotheses.find((h) => h.recommendation !== "WATCH");
    const strongThreshold = thresholds.find((t) => t.caution === "STRONG_SIGNAL");
    let answer: string;
    if (strongThreshold && bestHyp && bestHyp.recommendation === "READY_FOR_PATCH_DISCUSSION") {
      answer =
        `Ready for patch discussion on: "${bestHyp.title}". ` +
        `Threshold insight (${strongThreshold.thresholdLabel}) has STRONG_SIGNAL status with ${strongThreshold.supportedByClosedCount} trades. ` +
        `Affected trades: avg ${strongThreshold.excludedTradesNetAvgR?.toFixed(4)}R | Retained: avg ${strongThreshold.retainedTradesNetAvgR?.toFixed(4)}R. ` +
        `However, human review of the patch surface (${bestHyp.likelyPatchSurface}) is required before code changes.`;
    } else if (bestHyp && bestHyp.recommendation === "AUDIT_DEEPER") {
      answer =
        `Not yet, but AUDIT_DEEPER: "${bestHyp.title}". ` +
        `${bestHyp.observedEvidence} ` +
        `Confidence is ${bestHyp.confidence}. Accumulate to ≥30 closes in the affected bucket before proposing a patch.`;
    } else {
      answer =
        `No patch is justified at current sample size (${n} closes). ` +
        `The geometry pattern (wide-stop winners, narrow-stop losers; low-RR winners, high-RR losers) is visible ` +
        `but not confirmed at the required confidence level. ` +
        `Continue accumulating data and re-run this audit at 30+ closes per major stop/RR bucket.`;
    }
    cards.push({ question: "Can we patch now?", answer });
  }

  return cards;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildStopGeometryAuditReport(
  input: StopGeometryAuditInput,
  now: Date = new Date(),
): StopGeometryAuditReport {
  const generatedAt = now.toISOString();
  const eraFilter: StopGeometryEraFilter = input.eraFilter ?? "POST_CALIBRATION";
  const records = flattenClosed(input.positions, eraFilter);

  const summary = buildSummary(records, eraFilter);
  const stopBuckets = buildStopBuckets(records, records.length || 1);
  const rrBuckets = buildRRBuckets(records, records.length || 1);
  const geometryMatrix = buildGeometryMatrix(records);
  const counterfactuals = buildCounterfactuals(records);
  const confounderSlices = buildConfounderSlices(records);
  const thresholdInsights = buildThresholdInsights(records);
  const patchHypotheses = buildPatchHypotheses(summary, counterfactuals, thresholdInsights);
  const flags = buildFlags(summary, stopBuckets, rrBuckets, geometryMatrix, counterfactuals);
  const answerCards = buildAnswerCards(summary, counterfactuals, confounderSlices, thresholdInsights, patchHypotheses);

  return {
    generatedAt,
    eraFilter,
    summary,
    stopBuckets,
    rrBuckets,
    geometryMatrix,
    counterfactuals,
    confounderSlices,
    thresholdInsights,
    patchHypotheses,
    flags,
    answerCards,
    notes: [
      "Stop Geometry Audit is read-only. It does not change ranking, routing, scoring, execution, or live readiness.",
      "stopDistanceBps read from position.stopDistanceBps or variantSelection.stopDistanceBps.",
      "riskReward read from position.riskReward (TP1-based projected ratio).",
      "Stop buckets: ULTRA_TIGHT <100, TIGHT 100–175, MODERATE 175–300, WIDE 300–500, VERY_WIDE >500 bps.",
      "RR buckets: LOW_RR <3, NORMAL_RR 3–5, HIGH_RR 5–8, EXTREME_RR >8.",
      "Counterfactuals are historical simulations only — they do not recommend live filter changes.",
      "STRONGLY_IMPROVES requires deltaNetR > 0.15 AND deltaPF > 0.1 AND ≥5 remaining trades.",
      "Threshold caution STRONG_SIGNAL requires ≥15 retained trades AND delta > 0.25R.",
    ],
  };
}

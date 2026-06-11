import type { ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra } from "@dtc/shared";
import { buildRouteMaturityReport } from "./route-maturity.js";

/**
 * POST-CALIBRATION PROFIT ANATOMY
 *
 * Read-only diagnostic report. Explains *where* current-era profit is leaking
 * so a human can distinguish cost drag, stop-loss drag, TP1 conversion failure,
 * symbol/route drag, and runner giveback.
 *
 * Does NOT change:
 *  - routing decisions
 *  - routeMode assignments
 *  - shadow fills or exits
 *  - live readiness gates
 *  - scanner ranking or filtering
 *  - calibration logic
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProfitAnatomyEraFilter = "POST_CALIBRATION" | "ALL";

export type AnatomyFlagCode =
  | "TP1_NOT_PROFITABLE_AFTER_COST"
  | "STOP_LOSS_DRAG"
  | "AVG_LOSS_TOO_LARGE"
  | "COST_DRAG"
  | "RUNNER_GIVEBACK"
  | "SYMBOL_DRAG"
  | "ROUTE_CLOSE_TO_BREAKEVEN"
  | "SAMPLE_TOO_SMALL"
  | "POSITIVE_ROUTE_CANDIDATE";

export type AnatomyFlagSeverity = "INFO" | "WARN" | "CRITICAL";

export interface AnatomyFlag {
  code: AnatomyFlagCode;
  severity: AnatomyFlagSeverity;
  message: string;
}

export interface LeakRow {
  key: string;
  label: string;
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  totalNetRContribution: number;
}

export interface AnatomySummary {
  eraFilter: ProfitAnatomyEraFilter;
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  /** grossAvgR − netAvgR: positive means cost drag is present. */
  expectancyGap: number | null;
  mainDiagnosis: string;
}

export interface LeadingRouteAnatomy {
  entryVariant: string;
  exitVariant: string;
  label: string;
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyGap: number | null;
  diagnosis: string;
}

export interface LeakBreakdown {
  bySymbol: LeakRow[];
  byRouteCombo: LeakRow[];
  byExitReason: LeakRow[];
  byDirection: LeakRow[];
  byRouteMode: LeakRow[];
}

export interface AnswerCard {
  question: string;
  answer: string;
}

export interface ProfitAnatomyReport {
  generatedAt: string;
  summary: AnatomySummary;
  leadingRoute: LeadingRouteAnatomy | null;
  leakBreakdown: LeakBreakdown;
  anatomyFlags: AnatomyFlag[];
  answerCards: AnswerCard[];
  notes: string[];
}

export interface ProfitAnatomyInput {
  positions: ShadowPosition[];
  /** Defaults to POST_CALIBRATION — restrict to current-era data only. */
  eraFilter?: ProfitAnatomyEraFilter;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** A flat record combining variant-level and position-level context. */
interface FlatClosed {
  symbol: string;
  direction: string;
  routeMode: string;
  entryVariant: string;
  exitVariant: string;
  netR: number;
  grossR: number;
  tp1Hit: boolean;
  closeReason: string;
}

interface GroupStats {
  closedCount: number;
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
}

function computeGroupStats(records: FlatClosed[]): GroupStats {
  if (records.length === 0) {
    return {
      closedCount: 0, netAvgR: null, grossAvgR: null, profitFactor: null,
      winRate: null, tp1Rate: null, profitableTp1Rate: null, slRate: null,
      avgWinR: null, avgLossR: null, totalNetRContribution: 0,
    };
  }

  const winners = records.filter((r) => r.netR > 0);
  const losers = records.filter((r) => r.netR < 0);
  const grossWin = winners.reduce((s, r) => s + r.netR, 0);
  const grossLoss = Math.abs(losers.reduce((s, r) => s + r.netR, 0));

  const netAvgR = r4(records.reduce((s, r) => s + r.netR, 0) / records.length);
  const grossAvgR = r4(records.reduce((s, r) => s + r.grossR, 0) / records.length);
  const profitFactor = grossLoss === 0 ? null : r4(grossWin / grossLoss);
  const winRate = r4(winners.length / records.length);

  const tp1Hits = records.filter((r) => r.tp1Hit);
  const tp1Rate = r4(tp1Hits.length / records.length);
  const profitableTp1Count = tp1Hits.filter((r) => r.netR > 0).length;
  const profitableTp1Rate = tp1Hits.length === 0 ? null : r4(profitableTp1Count / tp1Hits.length);

  const slCount = records.filter((r) => r.closeReason === "SL" || r.closeReason === "BREAKEVEN").length;
  const slRate = r4(slCount / records.length);

  const avgWinR = winners.length === 0 ? null : r4(grossWin / winners.length);
  const avgLossR = losers.length === 0 ? null : r4(-grossLoss / losers.length);

  return {
    closedCount: records.length,
    netAvgR,
    grossAvgR,
    profitFactor,
    winRate,
    tp1Rate,
    profitableTp1Rate,
    slRate,
    avgWinR,
    avgLossR,
    totalNetRContribution: r4(records.reduce((s, r) => s + r.netR, 0)),
  };
}

function buildLeakRows(
  records: FlatClosed[],
  keyFn: (r: FlatClosed) => string,
  labelFn: (key: string) => string,
  topN = 5,
  sortByWorst = true,
): LeakRow[] {
  const groups = new Map<string, FlatClosed[]>();
  for (const r of records) {
    const k = keyFn(r);
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }

  const rows: LeakRow[] = [];
  for (const [key, rs] of groups) {
    const stats = computeGroupStats(rs);
    rows.push({
      key,
      label: labelFn(key),
      ...stats,
    });
  }

  if (sortByWorst) {
    rows.sort((a, b) => a.totalNetRContribution - b.totalNetRContribution);
  } else {
    rows.sort((a, b) => b.totalNetRContribution - a.totalNetRContribution);
  }

  return rows.slice(0, topN);
}

function closedVariantsOf(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

function flattenClosed(positions: ShadowPosition[]): FlatClosed[] {
  const out: FlatClosed[] = [];
  for (const p of positions) {
    const entry = p.variantSelection?.selectedEntryVariant ?? p.selectedEntryVariant ?? "unknown";
    const exit = p.variantSelection?.selectedExitVariant ?? p.selectedExitVariant ?? "unknown";
    const routeMode = p.variantSelection?.routeMode ?? "UNKNOWN";
    for (const v of closedVariantsOf(p)) {
      out.push({
        symbol: p.symbol,
        direction: p.direction,
        routeMode,
        entryVariant: entry,
        exitVariant: exit,
        netR: v.realizedNetR,
        grossR: v.realizedGrossR,
        tp1Hit: v.tp1Hit,
        closeReason: v.closeReason ?? "UNKNOWN",
      });
    }
  }
  return out;
}

// ─── Diagnosis ────────────────────────────────────────────────────────────────

const SAMPLE_THRESHOLD = 30;
const SL_DRAG_THRESHOLD = 0.4;
const COST_DRAG_THRESHOLD = 0.05;
const TP1_PROFITABLE_WARN = 0.55; // below this → TP1 not converting
const AVG_LOSS_LARGE_RATIO = 2.0; // |avgLoss| > avgWin * ratio → flagged

function diagnoseSummary(
  closedCount: number,
  netAvgR: number | null,
  grossAvgR: number | null,
  profitFactor: number | null,
  slRate: number | null,
  profitableTp1Rate: number | null,
  tp1Rate: number | null,
  avgWinR: number | null,
  avgLossR: number | null,
  expectancyGap: number | null,
): string {
  if (closedCount < SAMPLE_THRESHOLD) {
    return `Sample is early (${closedCount} closed, target ≥ ${SAMPLE_THRESHOLD}). Metrics are directional only — continue collecting.`;
  }
  if (netAvgR !== null && netAvgR >= 0.1) {
    return "System is net-positive. Focus on maintaining edge and scaling sample.";
  }
  const parts: string[] = [];
  if (slRate !== null && slRate > SL_DRAG_THRESHOLD) {
    parts.push(`stop-loss rate high (${(slRate * 100).toFixed(0)}%)`);
  }
  if (
    tp1Rate !== null && tp1Rate > 0.3 &&
    profitableTp1Rate !== null && profitableTp1Rate < TP1_PROFITABLE_WARN
  ) {
    parts.push(`TP1 hits not converting to net profit after cost (${(profitableTp1Rate * 100).toFixed(0)}% profitable)`);
  }
  if (expectancyGap !== null && expectancyGap > COST_DRAG_THRESHOLD) {
    parts.push(`cost drag reducing gross R by ${expectancyGap.toFixed(4)}R per trade`);
  }
  if (
    avgWinR !== null && avgLossR !== null &&
    Math.abs(avgLossR) > avgWinR * AVG_LOSS_LARGE_RATIO
  ) {
    parts.push(`avg loss (${avgLossR.toFixed(4)}R) is oversized vs avg win (${avgWinR.toFixed(4)}R)`);
  }
  if (parts.length === 0) {
    if (netAvgR !== null && netAvgR > -0.1) {
      return "Route is near breakeven. Continue collecting — the leading route is not yet proven.";
    }
    return "System is net-negative. More data needed to isolate the primary leak source.";
  }
  return `Primary leaks: ${parts.join("; ")}.`;
}

function diagnoseRoute(
  label: string,
  closedCount: number,
  netAvgR: number | null,
  profitFactor: number | null,
  slRate: number | null,
  profitableTp1Rate: number | null,
  tp1Rate: number | null,
  avgLossR: number | null,
  avgWinR: number | null,
  expectancyGap: number | null,
): string {
  if (closedCount < SAMPLE_THRESHOLD) {
    return `${label} has ${closedCount} closes (target ≥ ${SAMPLE_THRESHOLD}). COLLECTING — treat metrics as directional.`;
  }
  if (netAvgR !== null && netAvgR > 0.1 && (profitFactor ?? 0) > 1.3) {
    return `${label} is net-positive with solid PF. Promotable candidate pending sample growth.`;
  }
  const parts: string[] = [];
  if (slRate !== null && slRate > SL_DRAG_THRESHOLD) {
    parts.push(`SL drag (${(slRate * 100).toFixed(0)}%)`);
  }
  if (tp1Rate !== null && tp1Rate > 0.3 && profitableTp1Rate !== null && profitableTp1Rate < TP1_PROFITABLE_WARN) {
    parts.push(`TP1 hits not converting after cost`);
  }
  if (expectancyGap !== null && expectancyGap > COST_DRAG_THRESHOLD) {
    parts.push(`cost drag (${expectancyGap.toFixed(4)}R/trade)`);
  }
  if (avgWinR !== null && avgLossR !== null && Math.abs(avgLossR) > avgWinR * 1.5) {
    parts.push(`avg loss oversized`);
  }
  if (parts.length === 0 && netAvgR !== null && netAvgR > -0.15) {
    return `${label} is near breakeven. Not proven yet — watch for trend.`;
  }
  return parts.length > 0 ? `${label}: ${parts.join(", ")}.` : `${label} is net-negative.`;
}

// ─── Flag generation ─────────────────────────────────────────────────────────

function buildFlags(
  summary: AnatomySummary,
  flatClosed: FlatClosed[],
  bySymbol: LeakRow[],
  byRouteCombo: LeakRow[],
): AnatomyFlag[] {
  const flags: AnatomyFlag[] = [];

  if (summary.closedCount < SAMPLE_THRESHOLD) {
    flags.push({
      code: "SAMPLE_TOO_SMALL",
      severity: "INFO",
      message: `Only ${summary.closedCount} closed trades in scope. Metrics are early signals, not stable edges.`,
    });
  }

  if (summary.slRate !== null && summary.slRate > SL_DRAG_THRESHOLD) {
    flags.push({
      code: "STOP_LOSS_DRAG",
      severity: "WARN",
      message: `SL rate is ${(summary.slRate * 100).toFixed(1)}% (threshold: ${SL_DRAG_THRESHOLD * 100}%). Stops are being hit too frequently — check entry timing or SL placement.`,
    });
  }

  if (
    summary.tp1Rate !== null && summary.tp1Rate > 0.3 &&
    summary.profitableTp1Rate !== null && summary.profitableTp1Rate < TP1_PROFITABLE_WARN
  ) {
    flags.push({
      code: "TP1_NOT_PROFITABLE_AFTER_COST",
      severity: summary.profitableTp1Rate < 0.4 ? "CRITICAL" : "WARN",
      message: `TP1 hit rate is ${(summary.tp1Rate * 100).toFixed(1)}% but only ${(summary.profitableTp1Rate * 100).toFixed(1)}% of TP1 closes are profitable after cost. Cost drag or partial fills are eating the win.`,
    });
  }

  if (summary.expectancyGap !== null && summary.expectancyGap > COST_DRAG_THRESHOLD) {
    flags.push({
      code: "COST_DRAG",
      severity: summary.expectancyGap > 0.15 ? "CRITICAL" : "WARN",
      message: `Avg cost drag = ${summary.expectancyGap.toFixed(4)}R per trade (gross ${summary.grossAvgR?.toFixed(4) ?? "n/a"}R → net ${summary.netAvgR?.toFixed(4) ?? "n/a"}R). Fee + slippage + spread is compounding.`,
    });
  }

  if (
    summary.avgWinR !== null &&
    summary.avgLossR !== null &&
    Math.abs(summary.avgLossR) > summary.avgWinR * AVG_LOSS_LARGE_RATIO
  ) {
    flags.push({
      code: "AVG_LOSS_TOO_LARGE",
      severity: "WARN",
      message: `Avg loss (${summary.avgLossR.toFixed(4)}R) is ${(Math.abs(summary.avgLossR) / summary.avgWinR).toFixed(1)}× the avg win (${summary.avgWinR.toFixed(4)}R). Risk/reward skewed negative.`,
    });
  }

  // Runner giveback: positions that hit TP1 but used a runner and came back negative
  const runnerGivebacks = flatClosed.filter(
    (r) => r.exitVariant.includes("runner") && r.tp1Hit && r.netR < 0,
  );
  if (runnerGivebacks.length >= 2) {
    flags.push({
      code: "RUNNER_GIVEBACK",
      severity: "WARN",
      message: `${runnerGivebacks.length} runner trades hit TP1 but closed negative after runner management. Consider tighter runner exits.`,
    });
  }

  // Symbol drag: worst symbol with ≥5 closes has strongly negative contribution
  const heavySymbolDrag = bySymbol.find(
    (s) => s.closedCount >= 5 && s.totalNetRContribution < -1.0,
  );
  if (heavySymbolDrag) {
    flags.push({
      code: "SYMBOL_DRAG",
      severity: "WARN",
      message: `${heavySymbolDrag.label} is dragging net P&L by ${heavySymbolDrag.totalNetRContribution.toFixed(4)}R across ${heavySymbolDrag.closedCount} closes.`,
    });
  }

  // Route close to breakeven (leading route)
  if (
    summary.netAvgR !== null &&
    summary.netAvgR > -0.15 && summary.netAvgR < 0.05 &&
    summary.closedCount >= SAMPLE_THRESHOLD
  ) {
    flags.push({
      code: "ROUTE_CLOSE_TO_BREAKEVEN",
      severity: "INFO",
      message: `Net avg R is ${summary.netAvgR.toFixed(4)}R — near breakeven. Route is not proven profitable yet but not strongly negative.`,
    });
  }

  // Positive route candidate: any route combo with ≥10 closes and positive avg R
  const positiveCombo = byRouteCombo.find(
    (r) => r.closedCount >= 10 && (r.netAvgR ?? -1) > 0,
  );
  if (positiveCombo) {
    flags.push({
      code: "POSITIVE_ROUTE_CANDIDATE",
      severity: "INFO",
      message: `${positiveCombo.label} shows positive net avg R (${positiveCombo.netAvgR?.toFixed(4) ?? "n/a"}R) with ${positiveCombo.closedCount} closes. Monitor for promotion.`,
    });
  }

  return flags;
}

// ─── Answer cards ────────────────────────────────────────────────────────────

function buildAnswerCards(
  summary: AnatomySummary,
  leadingRoute: LeadingRouteAnatomy | null,
  flags: AnatomyFlag[],
): AnswerCard[] {
  const cards: AnswerCard[] = [];

  // "Why still negative?"
  {
    const reasons: string[] = [];
    if (flags.some((f) => f.code === "SAMPLE_TOO_SMALL")) {
      reasons.push("Sample is still early — only directional signals are available");
    }
    if (flags.some((f) => f.code === "STOP_LOSS_DRAG")) {
      reasons.push(`SL rate is high (${summary.slRate !== null ? `${(summary.slRate * 100).toFixed(0)}%` : "n/a"}), dragging down avg R`);
    }
    if (flags.some((f) => f.code === "TP1_NOT_PROFITABLE_AFTER_COST")) {
      reasons.push("TP1 hits are not converting to net profit after fees and spread");
    }
    if (flags.some((f) => f.code === "COST_DRAG")) {
      reasons.push(`Cost drag is consuming gross profit (gap: ${summary.expectancyGap?.toFixed(4) ?? "n/a"}R/trade)`);
    }
    if (flags.some((f) => f.code === "AVG_LOSS_TOO_LARGE")) {
      reasons.push("Avg loss trades are too large relative to avg win trades");
    }
    cards.push({
      question: "Why still negative?",
      answer:
        reasons.length > 0
          ? reasons.join(". ") + "."
          : summary.netAvgR !== null && summary.netAvgR > -0.05
          ? "System is near breakeven — likely noise at this sample size. Continue collecting."
          : "Losses are distributed — no single dominant cause at this sample size.",
    });
  }

  // "What improved?"
  {
    const improvements: string[] = [];
    if (leadingRoute !== null && (leadingRoute.netAvgR ?? -999) > -0.2) {
      improvements.push(
        `Leading route (${leadingRoute.label}) is closer to breakeven than legacy data suggested`,
      );
    }
    if (
      summary.profitFactor !== null &&
      summary.profitFactor > 0 &&
      summary.profitFactor < 1 &&
      summary.closedCount > 0
    ) {
      improvements.push("System has moved from all-loss to partial-winner territory");
    }
    if (
      summary.tp1Rate !== null &&
      summary.tp1Rate > 0.3 &&
      summary.profitableTp1Rate !== null &&
      summary.profitableTp1Rate > 0.5
    ) {
      improvements.push("TP1 conversion rate is above 50% — entry timing is working");
    }
    cards.push({
      question: "What improved?",
      answer:
        improvements.length > 0
          ? improvements.join(". ") + "."
          : "Insufficient data to identify improvements vs baseline. ERA isolation is working correctly.",
    });
  }

  // "What to watch next?"
  {
    const watches: string[] = [];
    if (leadingRoute !== null && leadingRoute.closedCount < SAMPLE_THRESHOLD) {
      watches.push(
        `Build the leading route (${leadingRoute.label}) to ≥${SAMPLE_THRESHOLD} closes — only ${leadingRoute.closedCount} so far`,
      );
    }
    if (flags.some((f) => f.code === "STOP_LOSS_DRAG")) {
      watches.push("Watch whether SL rate improves as the scanner learns better entry timing");
    }
    if (flags.some((f) => f.code === "TP1_NOT_PROFITABLE_AFTER_COST")) {
      watches.push("Track whether profitableTp1Rate rises with more data — current dip may be small-sample noise");
    }
    if (flags.some((f) => f.code === "SYMBOL_DRAG")) {
      watches.push("Monitor worst-drag symbol for improvement or consider removing from scan universe");
    }
    cards.push({
      question: "What to watch next?",
      answer:
        watches.length > 0
          ? watches.join(". ") + "."
          : "Continue shadow collection. Check back when closedCount ≥ 30 for the leading route.",
    });
  }

  // "Do we patch now?"
  {
    const critical = flags.filter((f) => f.severity === "CRITICAL");
    cards.push({
      question: "Do we patch now?",
      answer:
        critical.length > 0
          ? `${critical.length} CRITICAL flag(s) detected: ${critical.map((f) => f.code).join(", ")}. Review manually before deciding.`
          : summary.closedCount < SAMPLE_THRESHOLD
          ? "No — sample is too small. Any patch would be reacting to noise. Keep collecting."
          : flags.some((f) => f.severity === "WARN")
          ? "Not yet — WARN flags present but no CRITICAL issues. Continue monitoring; patch only if trend persists past 30 closes."
          : "No patch needed. System is within expected early-collection bounds.",
    });
  }

  return cards;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function buildProfitAnatomyReport(
  input: ProfitAnatomyInput,
  now: Date = new Date(),
): ProfitAnatomyReport {
  const generatedAt = now.toISOString();
  const eraFilter: ProfitAnatomyEraFilter = input.eraFilter ?? "POST_CALIBRATION";

  // Apply era filter
  const filtered =
    eraFilter === "ALL"
      ? input.positions
      : input.positions.filter((p) => classifyEvidenceEra(p) === "POST_CALIBRATION");

  // Flatten to closed records
  const flatClosed = flattenClosed(filtered);
  const n = flatClosed.length;

  // Summary stats
  const stats = computeGroupStats(flatClosed);
  const expectancyGap =
    stats.grossAvgR !== null && stats.netAvgR !== null
      ? r4(stats.grossAvgR - stats.netAvgR)
      : null;

  // Leak breakdown tables (sorted by worst net R contribution)
  const bySymbol = buildLeakRows(
    flatClosed,
    (r) => r.symbol,
    (k) => k,
  );
  const byRouteCombo = buildLeakRows(
    flatClosed,
    (r) => `${r.entryVariant}__${r.exitVariant}`,
    (k) => k.replace("__", " + "),
  );
  const byExitReason = buildLeakRows(
    flatClosed,
    (r) => r.closeReason,
    (k) => k,
  );
  const byDirection = buildLeakRows(
    flatClosed,
    (r) => r.direction,
    (k) => k,
  );
  const byRouteMode = buildLeakRows(
    flatClosed,
    (r) => r.routeMode,
    (k) => k,
  );

  const mainDiagnosis = diagnoseSummary(
    n,
    stats.netAvgR,
    stats.grossAvgR,
    stats.profitFactor,
    stats.slRate,
    stats.profitableTp1Rate,
    stats.tp1Rate,
    stats.avgWinR,
    stats.avgLossR,
    expectancyGap,
  );

  const summary: AnatomySummary = {
    eraFilter,
    closedCount: n,
    netAvgR: stats.netAvgR,
    grossAvgR: stats.grossAvgR,
    profitFactor: stats.profitFactor,
    winRate: stats.winRate,
    tp1Rate: stats.tp1Rate,
    profitableTp1Rate: stats.profitableTp1Rate,
    slRate: stats.slRate,
    avgWinR: stats.avgWinR,
    avgLossR: stats.avgLossR,
    expectancyGap,
    mainDiagnosis,
  };

  // Leading route — reuse route maturity's leading cohort to avoid duplicating sort logic
  let leadingRoute: LeadingRouteAnatomy | null = null;
  if (eraFilter === "POST_CALIBRATION" || eraFilter === "ALL") {
    const maturityFilter = eraFilter === "POST_CALIBRATION" ? "POST_CALIBRATION" : "ALL_TIME";
    const maturityReport = buildRouteMaturityReport(
      { positions: input.positions, eraFilter: maturityFilter },
      now,
    );
    const leader = maturityReport.leadingCohort;
    if (leader) {
      const cohortData = maturityReport.cohorts.find(
        (c) => c.entryVariant === leader.entryVariant && c.exitVariant === leader.exitVariant,
      );
      if (cohortData) {
        const gap =
          cohortData.grossAvgR !== null && cohortData.netAvgR !== null
            ? r4(cohortData.grossAvgR - cohortData.netAvgR)
            : null;
        leadingRoute = {
          entryVariant: cohortData.entryVariant,
          exitVariant: cohortData.exitVariant,
          label: `${cohortData.entryVariant} + ${cohortData.exitVariant}`,
          closedCount: cohortData.closedCount,
          netAvgR: cohortData.netAvgR,
          grossAvgR: cohortData.grossAvgR,
          profitFactor: cohortData.profitFactor,
          tp1Rate: cohortData.tp1Rate,
          profitableTp1Rate: cohortData.profitableTp1Rate,
          slRate: cohortData.slRate,
          avgWinR: cohortData.avgWinR,
          avgLossR: cohortData.avgLossR,
          expectancyGap: gap,
          diagnosis: diagnoseRoute(
            `${cohortData.entryVariant} + ${cohortData.exitVariant}`,
            cohortData.closedCount,
            cohortData.netAvgR,
            cohortData.profitFactor,
            cohortData.slRate,
            cohortData.profitableTp1Rate,
            cohortData.tp1Rate,
            cohortData.avgLossR,
            cohortData.avgWinR,
            gap,
          ),
        };
      }
    }
  }

  const anatomyFlags = buildFlags(summary, flatClosed, bySymbol, byRouteCombo);
  const answerCards = buildAnswerCards(summary, leadingRoute, anatomyFlags);

  return {
    generatedAt,
    summary,
    leadingRoute,
    leakBreakdown: { bySymbol, byRouteCombo, byExitReason, byDirection, byRouteMode },
    anatomyFlags,
    answerCards,
    notes: [
      "Profit Anatomy is read-only. It does not change routing, execution, calibration, or live readiness.",
      `Era filter: ${eraFilter}. Only positions from the selected era are included.`,
      "expectancyGap = grossAvgR − netAvgR. Positive values indicate cost drag (fees + spread + slippage).",
      "Leak tables sorted by worst totalNetRContribution (most negative first). Top 5 per dimension.",
    ],
  };
}

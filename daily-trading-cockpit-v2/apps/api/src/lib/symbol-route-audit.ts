import type { EvidenceEra, ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra } from "@dtc/shared";

/**
 * SYMBOL × ROUTE PAYOFF GEOMETRY AUDIT
 *
 * Read-only diagnostic that cross-examines symbol-level performance against
 * route-level performance to determine whether current underperformance is:
 *
 *   SYMBOL_CONCENTRATED — a few symbols drag the route for everyone else
 *   ROUTE_UNIVERSAL     — the route loses across the board regardless of symbol
 *   PAYOFF_GEOMETRY     — avg win too small vs avg loss too large
 *   MIXED               — combination of the above
 *
 * Does NOT change:
 *   - scanner ranking or Top-10 selection
 *   - routeMode decisions or variant selection
 *   - shadow execution, fills, or exits
 *   - calibrated expectancy
 *   - live readiness gates or trade caps
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SymbolRouteEraFilter = "POST_CALIBRATION" | "POST_ROUTING" | "ALL";

export type SampleTierLabel = "EMPTY" | "EARLY" | "SMALL" | "WATCHABLE" | "USABLE";

export type SymbolRouteVerdict =
  | "PROMISING"
  | "BREAKEVEN_CANDIDATE"
  | "SYMBOL_ROUTE_DRAG"
  | "INSUFFICIENT_SAMPLE"
  | "TOXIC";

export type MainDiagnosis =
  | "SYMBOL_CONCENTRATED"
  | "ROUTE_UNIVERSAL"
  | "PAYOFF_GEOMETRY"
  | "MIXED";

export type BestRouteVerdict =
  | "HAS_POSITIVE_ROUTE"
  | "NO_PROVEN_ROUTE"
  | "ROUTE_DEPENDENT"
  | "TOO_EARLY";

export type ConcentrationRisk = "LOW" | "MEDIUM" | "HIGH";

export type SymbolRouteFlagCode =
  | "SYMBOL_DRAG_CONCENTRATED"
  | "ROUTE_DEPENDENT_BY_SYMBOL"
  | "PAYOFF_RATIO_WEAK"
  | "AVG_LOSS_TOO_LARGE"
  | "COST_DRAG_SECONDARY"
  | "PROFITABLE_SYMBOL_EARLY_SAMPLE"
  | "BAD_SYMBOL_MAY_NEED_QUARANTINE"
  | "RANKING_EXPOSURE_MISMATCH";

export type FlagSeverity = "INFO" | "WARN" | "CRITICAL";

export interface SymbolRouteRow {
  symbol: string;
  entryVariant: string;
  exitVariant: string;
  routeLabel: string;
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  /** Total net R summed across all closes for this symbol-route combo. */
  totalNetR: number;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  /** |avgWinR| / |avgLossR| — > 1 means each win offsets more than one equal-prob loss. */
  payoffRatioAbs: number | null;
  /** grossAvgR − netAvgR: positive = cost drag present. */
  costDrag: number | null;
  sampleTier: SampleTierLabel;
  verdict: SymbolRouteVerdict;
}

export interface BestRouteBySymbol {
  symbol: string;
  totalClosedCount: number;
  currentBestRouteLabel: string;
  bestRouteClosedCount: number;
  bestRouteNetAvgR: number | null;
  bestRoutePF: number | null;
  bestRoutePayoffRatio: number | null;
  worstRouteLabel: string | null;
  worstRouteNetAvgR: number | null;
  verdict: BestRouteVerdict;
  diagnosis: string;
}

export interface RouteComparison {
  routeLabel: string;
  entryVariant: string;
  exitVariant: string;
  symbolsTested: string[];
  positiveSymbols: string[];
  negativeSymbols: string[];
  symbolsWithAtLeast5Closes: number;
  netAvgR: number | null;
  totalNetRContribution: number;
  concentrationRisk: ConcentrationRisk;
  diagnosis: string;
}

export interface RankingExposure {
  /** Symbols with the most shadow positions (proxy for scanner selection frequency). */
  symbolsMostFrequentlySelected: Array<{ symbol: string; selectionCount: number }>;
  /** Symbols with the most negative closed net R contribution. */
  symbolsMostNegativeNetContribution: Array<{ symbol: string; totalNetR: number; closedCount: number }>;
  /** Symbols with the most positive closed net R contribution. */
  symbolsMostPositiveNetContribution: Array<{ symbol: string; totalNetR: number; closedCount: number }>;
  warnings: string[];
}

export interface AnswerCard {
  question: string;
  answer: string;
}

export interface SymbolRouteFlag {
  code: SymbolRouteFlagCode;
  severity: FlagSeverity;
  message: string;
}

export interface SymbolRouteAuditSummary {
  eraFilter: SymbolRouteEraFilter;
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  mainDiagnosis: MainDiagnosis;
  mainDiagnosisExplanation: string;
}

export interface SymbolRouteAuditReport {
  generatedAt: string;
  eraFilter: SymbolRouteEraFilter;
  summary: SymbolRouteAuditSummary;
  /** All symbol-route combinations sorted by totalNetR ascending (worst first). */
  symbolRouteMatrix: SymbolRouteRow[];
  bestRouteBySymbol: BestRouteBySymbol[];
  routeComparisons: RouteComparison[];
  rankingExposure: RankingExposure;
  answerCards: AnswerCard[];
  flags: SymbolRouteFlag[];
  notes: string[];
}

export interface SymbolRouteAuditInput {
  positions: ShadowPosition[];
  eraFilter?: SymbolRouteEraFilter;
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

function eraInFilter(era: EvidenceEra, filter: SymbolRouteEraFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "POST_CALIBRATION") return era === "POST_CALIBRATION";
  return era === "POST_ROUTING_PRE_CALIBRATION" || era === "POST_CALIBRATION";
}

function sampleTierFrom(n: number): SampleTierLabel {
  if (n === 0) return "EMPTY";
  if (n < 5) return "EARLY";
  if (n < 15) return "SMALL";
  if (n < 30) return "WATCHABLE";
  return "USABLE";
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
  payoffRatioAbs: number | null;
  costDrag: number | null;
}

interface FlatClosed {
  symbol: string;
  direction: string;
  entryVariant: string;
  exitVariant: string;
  routeMode: string;
  netR: number;
  grossR: number;
  tp1Hit: boolean;
  closeReason: string;
}

function computeGroupStats(records: FlatClosed[]): GroupStats {
  if (records.length === 0) {
    return {
      closedCount: 0, netAvgR: null, grossAvgR: null, totalNetR: 0, profitFactor: null,
      winRate: null, tp1Rate: null, profitableTp1Rate: null, slRate: null,
      avgWinR: null, avgLossR: null, payoffRatioAbs: null, costDrag: null,
    };
  }
  const winners = records.filter((r) => r.netR > 0);
  const losers = records.filter((r) => r.netR < 0);
  const grossWin = winners.reduce((s, r) => s + r.netR, 0);
  const grossLoss = Math.abs(losers.reduce((s, r) => s + r.netR, 0));
  const totalNetR = records.reduce((s, r) => s + r.netR, 0);
  const totalGrossR = records.reduce((s, r) => s + r.grossR, 0);
  const n = records.length;

  const netAvgR = r4(totalNetR / n);
  const grossAvgR = r4(totalGrossR / n);
  const profitFactor = grossLoss === 0 ? null : r4(grossWin / grossLoss);
  const winRate = r4(winners.length / n);

  const tp1Hits = records.filter((r) => r.tp1Hit);
  const tp1Rate = r4(tp1Hits.length / n);
  const profitableTp1Count = tp1Hits.filter((r) => r.netR > 0).length;
  const profitableTp1Rate = tp1Hits.length === 0 ? null : r4(profitableTp1Count / tp1Hits.length);

  const slCount = records.filter((r) => r.closeReason === "SL" || r.closeReason === "BREAKEVEN").length;
  const slRate = r4(slCount / n);

  const avgWinR = winners.length === 0 ? null : r4(grossWin / winners.length);
  const avgLossR = losers.length === 0 ? null : r4(-grossLoss / losers.length);

  const payoffRatioAbs =
    avgWinR !== null && avgLossR !== null && avgLossR !== 0
      ? r4(Math.abs(avgWinR) / Math.abs(avgLossR))
      : null;

  const costDrag = r4(grossAvgR - netAvgR);

  return {
    closedCount: n, netAvgR, grossAvgR, totalNetR: r4(totalNetR), profitFactor,
    winRate, tp1Rate, profitableTp1Rate, slRate, avgWinR, avgLossR,
    payoffRatioAbs, costDrag,
  };
}

function verdictFor(stats: GroupStats): SymbolRouteVerdict {
  if (stats.closedCount < 5) return "INSUFFICIENT_SAMPLE";
  if (stats.netAvgR !== null && stats.netAvgR < -0.3 && (stats.slRate ?? 0) > 0.45) return "TOXIC";
  if (stats.netAvgR !== null && stats.netAvgR < -0.1) return "SYMBOL_ROUTE_DRAG";
  if (stats.netAvgR !== null && stats.netAvgR < 0.1) return "BREAKEVEN_CANDIDATE";
  return "PROMISING";
}

function flattenClosed(positions: ShadowPosition[]): FlatClosed[] {
  const out: FlatClosed[] = [];
  for (const p of positions) {
    const entry = p.variantSelection?.selectedEntryVariant ?? p.selectedEntryVariant ?? "unknown";
    const exit = p.variantSelection?.selectedExitVariant ?? p.selectedExitVariant ?? "unknown";
    const routeMode = p.variantSelection?.routeMode ?? "UNKNOWN";
    for (const v of closedVariants(p)) {
      out.push({
        symbol: p.symbol,
        direction: p.direction,
        entryVariant: entry,
        exitVariant: exit,
        routeMode,
        netR: v.realizedNetR,
        grossR: v.realizedGrossR,
        tp1Hit: v.tp1Hit,
        closeReason: v.closeReason ?? "UNKNOWN",
      });
    }
  }
  return out;
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildMatrix(flatClosed: FlatClosed[]): SymbolRouteRow[] {
  // Group by symbol + entry + exit
  const groups = new Map<string, FlatClosed[]>();
  for (const r of flatClosed) {
    const key = `${r.symbol}__${r.entryVariant}__${r.exitVariant}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const rows: SymbolRouteRow[] = [];
  for (const [key, records] of groups) {
    const [symbol, entryVariant, exitVariant] = key.split("__") as [string, string, string];
    const stats = computeGroupStats(records);
    rows.push({
      symbol,
      entryVariant,
      exitVariant,
      routeLabel: `${entryVariant} + ${exitVariant}`,
      ...stats,
      sampleTier: sampleTierFrom(stats.closedCount),
      verdict: verdictFor(stats),
    });
  }

  // Sort: worst totalNetRContribution first
  return rows.sort((a, b) => a.totalNetR - b.totalNetR);
}

function buildBestRouteBySymbol(matrix: SymbolRouteRow[]): BestRouteBySymbol[] {
  // Group matrix rows by symbol
  const bySymbol = new Map<string, SymbolRouteRow[]>();
  for (const row of matrix) {
    const arr = bySymbol.get(row.symbol) ?? [];
    arr.push(row);
    bySymbol.set(row.symbol, arr);
  }

  const result: BestRouteBySymbol[] = [];
  for (const [symbol, rows] of bySymbol) {
    const withData = rows.filter((r) => r.closedCount > 0);
    const withMinData = rows.filter((r) => r.closedCount >= 5);
    const totalClosedCount = rows.reduce((s, r) => s + r.closedCount, 0);

    // Pick best route: highest netAvgR among all routes with at least 1 close
    // Prefer routes with >= 5 closes when available
    const candidates = withMinData.length > 0 ? withMinData : withData;
    if (candidates.length === 0) {
      result.push({
        symbol,
        totalClosedCount,
        currentBestRouteLabel: "none",
        bestRouteClosedCount: 0,
        bestRouteNetAvgR: null,
        bestRoutePF: null,
        bestRoutePayoffRatio: null,
        worstRouteLabel: null,
        worstRouteNetAvgR: null,
        verdict: "TOO_EARLY",
        diagnosis: `${symbol}: no closes yet.`,
      });
      continue;
    }

    const sorted = [...candidates].sort(
      (a, b) => (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity),
    );
    const best = sorted[0];
    const worst = sorted[sorted.length - 1] !== best ? sorted[sorted.length - 1] : null;

    // Verdict
    let verdict: BestRouteVerdict;
    if (best.closedCount < 5) {
      verdict = "TOO_EARLY";
    } else if ((best.netAvgR ?? -1) > 0) {
      verdict = "HAS_POSITIVE_ROUTE";
    } else if (worst !== null && (best.netAvgR ?? -1) - (worst.netAvgR ?? -1) > 0.2) {
      verdict = "ROUTE_DEPENDENT"; // significant spread between routes
    } else {
      verdict = "NO_PROVEN_ROUTE";
    }

    // Diagnosis
    let diagnosis: string;
    if (verdict === "TOO_EARLY") {
      diagnosis = `${symbol}: only ${best.closedCount} close(s) — too early to conclude.`;
    } else if (verdict === "HAS_POSITIVE_ROUTE") {
      diagnosis = `${symbol}: ${best.routeLabel} is net-positive (${best.netAvgR?.toFixed(4) ?? "n/a"}R avg) with ${best.closedCount} closes.`;
    } else if (verdict === "ROUTE_DEPENDENT") {
      diagnosis =
        `${symbol}: route performance differs significantly. Best: ${best.routeLabel} (${best.netAvgR?.toFixed(4) ?? "n/a"}R), ` +
        `worst: ${worst?.routeLabel ?? "n/a"} (${worst?.netAvgR?.toFixed(4) ?? "n/a"}R). Symbol may respond differently to routing.`;
    } else {
      diagnosis = `${symbol}: no proven profitable route yet. Best available: ${best.routeLabel} (${best.netAvgR?.toFixed(4) ?? "n/a"}R avg, ${best.closedCount} closes).`;
    }

    result.push({
      symbol,
      totalClosedCount,
      currentBestRouteLabel: best.routeLabel,
      bestRouteClosedCount: best.closedCount,
      bestRouteNetAvgR: best.netAvgR,
      bestRoutePF: best.profitFactor,
      bestRoutePayoffRatio: best.payoffRatioAbs,
      worstRouteLabel: worst?.routeLabel ?? null,
      worstRouteNetAvgR: worst?.netAvgR ?? null,
      verdict,
      diagnosis,
    });
  }

  // Sort by totalClosedCount descending (most data first)
  return result.sort((a, b) => b.totalClosedCount - a.totalClosedCount);
}

function buildRouteComparisons(matrix: SymbolRouteRow[]): RouteComparison[] {
  // Group matrix rows by route combo
  const byRoute = new Map<string, SymbolRouteRow[]>();
  for (const row of matrix) {
    const key = `${row.entryVariant}__${row.exitVariant}`;
    const arr = byRoute.get(key) ?? [];
    arr.push(row);
    byRoute.set(key, arr);
  }

  const result: RouteComparison[] = [];
  for (const [key, rows] of byRoute) {
    const [entryVariant, exitVariant] = key.split("__") as [string, string];
    const flatAll = rows.flatMap((r) =>
      Array.from({ length: r.closedCount }, () => ({
        symbol: r.symbol,
        netR: r.totalNetR,
        netAvgR: r.netAvgR,
      })),
    );
    // Per-row stats:
    const totalNetR = r4(rows.reduce((s, r) => s + r.totalNetR, 0));
    const allNetRs = rows.filter((r) => r.closedCount > 0).map((r) => r.netAvgR ?? 0);
    const netAvgR = allNetRs.length === 0 ? null : mean(allNetRs);

    const positiveSymbols = rows
      .filter((r) => r.closedCount >= 5 && (r.netAvgR ?? -1) > 0)
      .map((r) => r.symbol);
    const negativeSymbols = rows
      .filter((r) => r.closedCount >= 5 && (r.netAvgR ?? 0) <= 0)
      .map((r) => r.symbol);
    const symbolsWithAtLeast5Closes = rows.filter((r) => r.closedCount >= 5).length;
    const symbolsTested = rows.map((r) => r.symbol);

    // Concentration risk: what % of total negative R comes from the single worst symbol?
    const negativeTotalR = rows
      .filter((r) => r.totalNetR < 0)
      .reduce((s, r) => s + r.totalNetR, 0);
    const worstSymbolR = rows
      .filter((r) => r.totalNetR < 0)
      .sort((a, b) => a.totalNetR - b.totalNetR)[0]?.totalNetR ?? 0;
    let concentrationRisk: ConcentrationRisk = "LOW";
    if (negativeTotalR < 0) {
      const worstFraction = Math.abs(worstSymbolR) / Math.abs(negativeTotalR);
      if (worstFraction > 0.6) concentrationRisk = "HIGH";
      else if (worstFraction > 0.35) concentrationRisk = "MEDIUM";
    }

    // Diagnosis
    let diagnosis: string;
    if (symbolsWithAtLeast5Closes < 2) {
      diagnosis = "Insufficient sample across symbols — too early to judge route breadth.";
    } else if (positiveSymbols.length > negativeSymbols.length * 2) {
      diagnosis = "Broad edge — route is profitable across most symbols tested.";
    } else if (positiveSymbols.length >= 1 && negativeSymbols.length >= 2) {
      diagnosis = `Edge only on a few symbols (${positiveSymbols.join(", ")}); negative on ${negativeSymbols.join(", ")}.`;
    } else if (negativeSymbols.length > positiveSymbols.length * 2) {
      diagnosis = `Broadly weak — route underperforms on most symbols (${negativeSymbols.slice(0, 3).join(", ")}${negativeSymbols.length > 3 ? "…" : ""}).`;
    } else {
      diagnosis = "Mixed results — route performance depends on symbol.";
    }

    void flatAll; // suppress unused warning
    result.push({
      routeLabel: `${entryVariant} + ${exitVariant}`,
      entryVariant,
      exitVariant,
      symbolsTested,
      positiveSymbols,
      negativeSymbols,
      symbolsWithAtLeast5Closes,
      netAvgR,
      totalNetRContribution: totalNetR,
      concentrationRisk,
      diagnosis,
    });
  }

  return result.sort((a, b) => a.totalNetRContribution - b.totalNetRContribution);
}

function buildRankingExposure(
  filtered: ShadowPosition[],
  flatClosed: FlatClosed[],
): RankingExposure {
  // Selection frequency = count of shadow positions per symbol
  const selectionMap = new Map<string, number>();
  for (const p of filtered) {
    selectionMap.set(p.symbol, (selectionMap.get(p.symbol) ?? 0) + 1);
  }
  const symbolsMostFrequentlySelected = [...selectionMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([symbol, selectionCount]) => ({ symbol, selectionCount }));

  // Net R by symbol (closed only)
  const netRMap = new Map<string, { total: number; count: number }>();
  for (const r of flatClosed) {
    const entry = netRMap.get(r.symbol) ?? { total: 0, count: 0 };
    entry.total += r.netR;
    entry.count += 1;
    netRMap.set(r.symbol, entry);
  }

  const symbolNetRList = [...netRMap.entries()].map(([symbol, d]) => ({
    symbol,
    totalNetR: r4(d.total),
    closedCount: d.count,
  }));

  const symbolsMostNegativeNetContribution = [...symbolNetRList]
    .sort((a, b) => a.totalNetR - b.totalNetR)
    .slice(0, 5);
  const symbolsMostPositiveNetContribution = [...symbolNetRList]
    .sort((a, b) => b.totalNetR - a.totalNetR)
    .slice(0, 5);

  // Warnings
  const warnings: string[] = [];
  const topSelected = new Set(symbolsMostFrequentlySelected.slice(0, 3).map((s) => s.symbol));
  for (const neg of symbolsMostNegativeNetContribution) {
    if (topSelected.has(neg.symbol) && neg.totalNetR < -2.0) {
      warnings.push(
        `${neg.symbol} is frequently selected (${selectionMap.get(neg.symbol) ?? 0} positions) ` +
        `but contributes strongly negative realized R (${neg.totalNetR.toFixed(4)}R across ${neg.closedCount} closes).`,
      );
    }
  }
  for (const pos of symbolsMostPositiveNetContribution) {
    if (!topSelected.has(pos.symbol) && pos.totalNetR > 0 && pos.closedCount > 0) {
      warnings.push(
        `${pos.symbol} has positive realized contribution (+${pos.totalNetR.toFixed(4)}R) ` +
        `but is under-selected (${selectionMap.get(pos.symbol) ?? 0} positions). ` +
        `Sample is ${pos.closedCount} closes — too early to justify weighting change.`,
      );
    }
  }
  if (warnings.length === 0 && symbolNetRList.length > 0) {
    warnings.push("No significant ranking-to-realized-R mismatch detected at current sample size.");
  }

  return {
    symbolsMostFrequentlySelected,
    symbolsMostNegativeNetContribution,
    symbolsMostPositiveNetContribution,
    warnings,
  };
}

function buildFlags(
  summary: SymbolRouteAuditSummary,
  matrix: SymbolRouteRow[],
  routeComparisons: RouteComparison[],
  rankingExposure: RankingExposure,
): SymbolRouteFlag[] {
  const flags: SymbolRouteFlag[] = [];
  const { closedCount, netAvgR, avgWinR, avgLossR } = summary;

  // SYMBOL_DRAG_CONCENTRATED
  const totalNegR = matrix.filter((r) => r.totalNetR < 0).reduce((s, r) => s + r.totalNetR, 0);
  const top2NegR = matrix
    .filter((r) => r.totalNetR < 0)
    .slice(0, 2)
    .reduce((s, r) => s + r.totalNetR, 0);
  if (totalNegR < 0 && top2NegR / totalNegR > 0.65) {
    const topTwo = matrix.filter((r) => r.totalNetR < 0).slice(0, 2).map((r) => r.symbol);
    flags.push({
      code: "SYMBOL_DRAG_CONCENTRATED",
      severity: "WARN",
      message: `${[...new Set(topTwo)].join(", ")} account for >${(top2NegR / totalNegR * 100).toFixed(0)}% of total negative R contribution. Remove or quarantine these symbols to isolate route edge.`,
    });
  }

  // ROUTE_DEPENDENT_BY_SYMBOL
  const routeWithBothSigns = routeComparisons.find(
    (rc) => rc.positiveSymbols.length >= 1 && rc.negativeSymbols.length >= 1,
  );
  if (routeWithBothSigns) {
    flags.push({
      code: "ROUTE_DEPENDENT_BY_SYMBOL",
      severity: "INFO",
      message:
        `${routeWithBothSigns.routeLabel} produces mixed results: positive on ` +
        `${routeWithBothSigns.positiveSymbols.join(", ")} and negative on ` +
        `${routeWithBothSigns.negativeSymbols.slice(0, 3).join(", ")}. Route edge is symbol-dependent.`,
    });
  }

  // PAYOFF_RATIO_WEAK
  if (avgWinR !== null && avgLossR !== null) {
    const ratio = Math.abs(avgWinR) / Math.abs(avgLossR);
    if (ratio < 0.5) {
      flags.push({
        code: "PAYOFF_RATIO_WEAK",
        severity: ratio < 0.3 ? "CRITICAL" : "WARN",
        message:
          `Payoff ratio = ${ratio.toFixed(2)} (avg win ${avgWinR.toFixed(4)}R vs avg loss ${avgLossR.toFixed(4)}R). ` +
          `Each loss erases ${(1 / ratio).toFixed(1)} wins. Geometry requires a very high win rate to be profitable.`,
      });
    }
  }

  // AVG_LOSS_TOO_LARGE
  if (avgLossR !== null && Math.abs(avgLossR) > 0.8) {
    flags.push({
      code: "AVG_LOSS_TOO_LARGE",
      severity: "WARN",
      message: `Avg loss is ${avgLossR.toFixed(4)}R — significantly beyond the nominal 1R stop. Likely caused by entry drift outside zone, SL slippage, or narrow stop distances.`,
    });
  }

  // COST_DRAG_SECONDARY
  const avgCostDrag = matrix.length > 0
    ? mean(matrix.filter((r) => r.costDrag !== null).map((r) => r.costDrag!))
    : null;
  if (avgCostDrag !== null && avgCostDrag > 0.1 && (netAvgR ?? 0) < -0.1) {
    flags.push({
      code: "COST_DRAG_SECONDARY",
      severity: "INFO",
      message: `Avg cost drag across symbol-route combos is ${avgCostDrag.toFixed(4)}R. Cost is a contributing factor but the strategy is also unprofitable at the gross level. Fixing entry quality matters more than reducing costs.`,
    });
  }

  // PROFITABLE_SYMBOL_EARLY_SAMPLE
  const profitableEarly = matrix.find(
    (r) => (r.netAvgR ?? -1) > 0 && r.closedCount > 0 && r.closedCount < 15,
  );
  if (profitableEarly) {
    flags.push({
      code: "PROFITABLE_SYMBOL_EARLY_SAMPLE",
      severity: "INFO",
      message: `${profitableEarly.symbol} (${profitableEarly.routeLabel}) shows positive avg R (${profitableEarly.netAvgR?.toFixed(4) ?? "n/a"}R) with only ${profitableEarly.closedCount} closes. Promising but too early to confirm — continue collecting.`,
    });
  }

  // BAD_SYMBOL_MAY_NEED_QUARANTINE
  const toxicRows = matrix.filter((r) => r.verdict === "TOXIC" || (r.closedCount >= 5 && (r.netAvgR ?? 0) < -0.5));
  for (const row of toxicRows.slice(0, 2)) {
    flags.push({
      code: "BAD_SYMBOL_MAY_NEED_QUARANTINE",
      severity: "WARN",
      message: `${row.symbol} + ${row.routeLabel}: ${row.closedCount} closes with net ${row.netAvgR?.toFixed(4) ?? "n/a"}R avg and SL rate ${row.slRate !== null ? (row.slRate * 100).toFixed(0) : "n/a"}%. Consider excluding from the scan universe for this route until sample improves.`,
    });
  }

  // RANKING_EXPOSURE_MISMATCH
  if (rankingExposure.warnings.some((w) => w.includes("frequently selected") && w.includes("negative"))) {
    flags.push({
      code: "RANKING_EXPOSURE_MISMATCH",
      severity: "WARN",
      message: rankingExposure.warnings.find((w) => w.includes("frequently selected") && w.includes("negative")) ?? "Ranking-to-realized-R mismatch detected.",
    });
  }

  void closedCount; // used implicitly via summary
  return flags;
}

function buildAnswerCards(
  summary: SymbolRouteAuditSummary,
  matrix: SymbolRouteRow[],
  routeComparisons: RouteComparison[],
  bestRouteBySymbol: BestRouteBySymbol[],
  flags: SymbolRouteFlag[],
): AnswerCard[] {
  const cards: AnswerCard[] = [];

  // 1. "Is the route universally bad?"
  {
    const rc = routeComparisons[0]; // worst route (if any)
    const positiveCount = rc?.positiveSymbols.length ?? 0;
    const negativeCount = rc?.negativeSymbols.length ?? 0;
    let answer: string;
    if (!rc || rc.symbolsWithAtLeast5Closes < 2) {
      answer = "Too few symbol-route combinations with ≥5 closes to determine route universality. Continue collecting.";
    } else if (positiveCount === 0 && negativeCount >= 2) {
      answer = `Yes — ${rc.routeLabel} is negative across all symbols tested with sufficient data (${negativeCount} negative, 0 positive). Route edge appears structurally weak, not symbol-dependent.`;
    } else if (positiveCount >= 1 && negativeCount >= 1) {
      answer = `No — ${rc.routeLabel} is not universally bad. It is positive on ${positiveCount} symbol(s) and negative on ${negativeCount}. A few symbols are dragging down the aggregate.`;
    } else {
      answer = `Mostly negative (${negativeCount} symbols) with limited positive signal. Route appears broadly weak but sample is still growing.`;
    }
    cards.push({ question: "Is the route universally bad?", answer });
  }

  // 2. "Are some symbols sabotaging the route?"
  {
    const hasConcentrated = flags.some((f) => f.code === "SYMBOL_DRAG_CONCENTRATED");
    const topDrags = matrix.filter((r) => r.totalNetR < -2).map((r) => r.symbol);
    let answer: string;
    if (hasConcentrated) {
      answer = `Yes — symbol drag is concentrated. ${[...new Set(topDrags)].slice(0, 3).join(", ")} account for most of the total negative R. Removing or quarantining these symbols would significantly improve aggregate metrics.`;
    } else if (topDrags.length > 0) {
      answer = `Partially — ${[...new Set(topDrags)].join(", ")} contribute meaningfully negative R, but drag is spread across multiple symbols. Not a single saboteur.`;
    } else {
      answer = "No individual symbol is clearly sabotaging the route at current sample sizes. Losses appear distributed.";
    }
    cards.push({ question: "Are some symbols sabotaging the route?", answer });
  }

  // 3. "Do some bad symbols have better alternative routes?"
  {
    const badSymbols = bestRouteBySymbol.filter((b) => b.verdict !== "HAS_POSITIVE_ROUTE" && b.totalClosedCount >= 5);
    const routeDependent = bestRouteBySymbol.filter((b) => b.verdict === "ROUTE_DEPENDENT");
    let answer: string;
    if (routeDependent.length > 0) {
      answer = `${routeDependent.map((b) => b.symbol).join(", ")} show route-dependent behaviour — results differ across routes. Testing alternative entry/exit variants for these symbols may improve aggregate R. However, sample sizes remain small.`;
    } else if (badSymbols.length === 0) {
      answer = "All symbols with sufficient data have been tested on the same route. Insufficient multi-route data to compare alternatives.";
    } else {
      answer = `${badSymbols.map((b) => b.symbol).join(", ")} have no proven positive route yet. Without data from alternative routes, it is not possible to say whether a different route would help.`;
    }
    cards.push({ question: "Do some bad symbols have better alternative routes?", answer });
  }

  // 4. "Should Top 10 eventually rotate based on symbol-route evidence?"
  {
    const hasRankingMismatch = flags.some((f) => f.code === "RANKING_EXPOSURE_MISMATCH");
    const posSymbols = bestRouteBySymbol.filter((b) => b.verdict === "HAS_POSITIVE_ROUTE");
    let answer: string;
    if (hasRankingMismatch) {
      answer = `Yes — there is a mismatch between selection frequency and realized R. Symbols that appear frequently in the Top 10 are contributing negative realized R. Once sample reaches ≥30 closes per symbol-route, ranking should weight realized edge, not just scanner score.`;
    } else if (posSymbols.length > 0) {
      answer = `Possibly — ${posSymbols.map((b) => b.symbol).join(", ")} show positive realized R so far. If the pattern holds past 15–30 closes, these should be weighted higher in scanner consideration. No change yet.`;
    } else {
      answer = "Insufficient evidence to recommend a ranking rotation. Build sample to ≥30 closes per symbol-route before considering any adjustment.";
    }
    cards.push({ question: "Should Top 10 eventually rotate based on symbol-route evidence?", answer });
  }

  // 5. "Do we patch ranking now?"
  {
    const criticalFlags = flags.filter((f) => f.severity === "CRITICAL");
    let answer: string;
    if (criticalFlags.length > 0) {
      answer = `Not automatically — ${criticalFlags.map((f) => f.code).join(", ")} flag(s) are CRITICAL. Investigate manually before patching. Ranking changes require at least 30 closes per target symbol-route.`;
    } else if (summary.closedCount < 30) {
      answer = `No — sample is too small (${summary.closedCount} closes total, target ≥30 per symbol-route). Any patch would react to noise. Continue collecting and audit again when closer to 30 closes per major symbol.`;
    } else {
      answer = "No immediate patch needed. Monitor flags across next 2–3 weeks of data accumulation. Patch only if symbol-drag patterns survive past the 30-close threshold per symbol-route.";
    }
    cards.push({ question: "Do we patch ranking now?", answer });
  }

  return cards;
}

function computeMainDiagnosis(
  summary: Pick<SymbolRouteAuditSummary, "closedCount" | "avgWinR" | "avgLossR">,
  matrix: SymbolRouteRow[],
): { diagnosis: MainDiagnosis; explanation: string } {
  const { avgWinR, avgLossR } = summary;

  // Check payoff geometry first
  const payoffRatio =
    avgWinR !== null && avgLossR !== null && avgLossR !== 0
      ? Math.abs(avgWinR) / Math.abs(avgLossR)
      : null;
  const poorGeometry = payoffRatio !== null && payoffRatio < 0.4;

  // Check symbol concentration
  const totalNegR = matrix.filter((r) => r.totalNetR < 0).reduce((s, r) => s + r.totalNetR, 0);
  const top2NegR = matrix
    .filter((r) => r.totalNetR < 0)
    .slice(0, 2)
    .reduce((s, r) => s + r.totalNetR, 0);
  const concentrated = totalNegR < 0 && Math.abs(top2NegR) / Math.abs(totalNegR) > 0.65;

  // Check route universality
  const routeGroups = new Map<string, { pos: number; neg: number }>();
  for (const row of matrix) {
    if (row.closedCount < 5) continue;
    const key = `${row.entryVariant}__${row.exitVariant}`;
    const entry = routeGroups.get(key) ?? { pos: 0, neg: 0 };
    if ((row.netAvgR ?? -1) > 0) entry.pos += 1;
    else entry.neg += 1;
    routeGroups.set(key, entry);
  }
  const isUniversallyBad = [...routeGroups.values()].every((g) => g.pos === 0 && g.neg >= 2);

  if (poorGeometry && !concentrated) {
    return {
      diagnosis: "PAYOFF_GEOMETRY",
      explanation: `Avg loss (${avgLossR?.toFixed(4) ?? "n/a"}R) is ${payoffRatio !== null ? (1 / payoffRatio).toFixed(1) : "many"}× the avg win (${avgWinR?.toFixed(4) ?? "n/a"}R). The payoff structure requires an unusually high win rate to break even — this is a geometry problem, not just a symbol or route problem.`,
    };
  }
  if (concentrated && !isUniversallyBad) {
    return {
      diagnosis: "SYMBOL_CONCENTRATED",
      explanation: `A small number of symbols account for the majority of negative R contribution. The route may have a viable edge on other symbols — isolating or removing the drag symbols is the highest-priority diagnostic step.`,
    };
  }
  if (isUniversallyBad) {
    return {
      diagnosis: "ROUTE_UNIVERSAL",
      explanation: `The route underperforms across most symbols with sufficient data. This suggests the route strategy itself (entry/exit variant) is not generating edge in the current market regime, regardless of symbol.`,
    };
  }
  return {
    diagnosis: "MIXED",
    explanation:
      poorGeometry
        ? `Multiple factors: payoff geometry is weak AND symbol drag is present. Both the route structure and specific symbols contribute to underperformance.`
        : `Performance varies across symbols and routes. No single dominant cause. Continue building sample to isolate whether symbol drag or route edge is the primary driver.`,
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function buildSymbolRouteAuditReport(
  input: SymbolRouteAuditInput,
  now: Date = new Date(),
): SymbolRouteAuditReport {
  const generatedAt = now.toISOString();
  const eraFilter: SymbolRouteEraFilter = input.eraFilter ?? "POST_CALIBRATION";

  // Apply era filter
  const filtered =
    eraFilter === "ALL"
      ? input.positions
      : input.positions.filter((p) => eraInFilter(classifyEvidenceEra(p), eraFilter));

  const flatClosed = flattenClosed(filtered);

  // Overall stats (same as profit-anatomy summary)
  const overallStats = computeGroupStats(flatClosed);

  // Build sections
  const matrix = buildMatrix(flatClosed);
  const bestRouteBySymbol = buildBestRouteBySymbol(matrix);
  const routeComparisons = buildRouteComparisons(matrix);
  const rankingExposure = buildRankingExposure(filtered, flatClosed);

  const { diagnosis: mainDiagnosis, explanation: mainDiagnosisExplanation } =
    computeMainDiagnosis(
      { closedCount: flatClosed.length, avgWinR: overallStats.avgWinR, avgLossR: overallStats.avgLossR },
      matrix,
    );

  const summary: SymbolRouteAuditSummary = {
    eraFilter,
    closedCount: flatClosed.length,
    netAvgR: overallStats.netAvgR,
    grossAvgR: overallStats.grossAvgR,
    profitFactor: overallStats.profitFactor,
    avgWinR: overallStats.avgWinR,
    avgLossR: overallStats.avgLossR,
    tp1ProfitableRate: overallStats.profitableTp1Rate,
    slRate: overallStats.slRate,
    mainDiagnosis,
    mainDiagnosisExplanation,
  };

  const flags = buildFlags(summary, matrix, routeComparisons, rankingExposure);
  const answerCards = buildAnswerCards(summary, matrix, routeComparisons, bestRouteBySymbol, flags);

  return {
    generatedAt,
    eraFilter,
    summary,
    symbolRouteMatrix: matrix,
    bestRouteBySymbol,
    routeComparisons,
    rankingExposure,
    answerCards,
    flags,
    notes: [
      "Symbol × Route Audit is read-only. No routing, ranking, or execution logic is changed.",
      "symbolRouteMatrix sorted by totalNetR ascending (worst first).",
      "payoffRatioAbs = |avgWinR| / |avgLossR|. > 1 means each win offsets more than one loss.",
      "sampleTier: EMPTY=0, EARLY=1-4, SMALL=5-14, WATCHABLE=15-29, USABLE=≥30.",
      "Verdict TOXIC requires closedCount≥5, netAvgR<-0.3, slRate>45%.",
    ],
  };
}

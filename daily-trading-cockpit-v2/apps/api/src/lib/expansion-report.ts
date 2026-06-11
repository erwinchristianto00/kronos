import type {
  ExecutionEntryVariant,
  PerformanceStats,
  ProfitRouteMode,
  ProfitRouteReasonCode,
  ShadowPosition,
  ShadowPositionVariant,
} from "@dtc/shared";

export interface SymbolExpansionRow {
  symbol: string;
  direction: "LONG" | "SHORT" | "MIXED";
  profitCandidateIdeas: number;
  dataCollectionIdeas: number;
  researchOnlyIdeas: number;
  avgRouteScore: number;
  avgNetR: number | null;
  winRate: number | null;
  tag: "PROFIT" | "PROMOTABLE" | "MIXED" | "TOXIC";
  topBlocker: string | null;
}

export interface VariantExpansionRow {
  entryVariant: ExecutionEntryVariant;
  exitVariant: ShadowPositionVariant;
  ideas: number;
  profitCandidateCount: number;
  researchOnlyCount: number;
  avgNetR: number | null;
  avgRouteScore: number;
  tag: "BEST" | "BREAKEVEN" | "TOXIC";
}

export interface ReasonCodeFrequency {
  code: ProfitRouteReasonCode;
  count: number;
  pct: number;
}

export interface DirectionRow {
  ideas: number;
  profitCandidates: number;
  researchOnly: number;
  avgNetR: number | null;
  profitCandidatePct: number;
}

export interface RouteModeDistribution {
  PROFIT_CANDIDATE: number;
  DATA_COLLECTION: number;
  RESEARCH_ONLY: number;
  profitCandidatePct: number;
  researchOnlyPct: number;
}

export interface EntryVariantSelectionCount {
  entryVariant: string;
  count: number;
  pct: number;
  profitCandidateCount: number;
  avgNetR: number | null;
}

export interface ExpansionReport {
  generatedAt: string;
  totalIdeas: number;
  profitCandidateCount: number;
  dataCollectionCount: number;
  researchOnlyCount: number;
  routeModeDistribution: RouteModeDistribution;
  promotableSymbols: SymbolExpansionRow[];
  toxicSymbols: SymbolExpansionRow[];
  allSymbols: SymbolExpansionRow[];
  breakEvenVariants: VariantExpansionRow[];
  topToxicCombos: VariantExpansionRow[];
  topPromotableCombos: VariantExpansionRow[];
  topProfitPattern: VariantExpansionRow | null;
  directionBreakdown: { LONG: DirectionRow; SHORT: DirectionRow };
  topBlockerCodes: ReasonCodeFrequency[];
  topPositiveCodes: ReasonCodeFrequency[];
  variantTable: VariantExpansionRow[];
  entryVariantSelectionCounts: EntryVariantSelectionCount[];
  noChaseAtrSelectedCount: number;
  fib500SelectedCount: number;
  shortCandidateCount: number;
  longCandidateCount: number;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function directionOf(p: ShadowPosition): "LONG" | "SHORT" {
  return p.direction === "SHORT" ? "SHORT" : "LONG";
}

function netROfPosition(p: ShadowPosition): number | null {
  const closed = p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
  if (closed.length === 0) return null;
  return round2(closed.reduce((s, v) => s + v.realizedNetR, 0) / closed.length);
}

function winRateOfPosition(p: ShadowPosition): number | null {
  const closed = p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
  if (closed.length === 0) return null;
  return round2(closed.filter((v) => v.realizedNetR > 0).length / closed.length);
}

function avgNetROf(positions: ShadowPosition[]): number | null {
  const withData = positions.map(netROfPosition).filter((r): r is number => r !== null);
  if (withData.length === 0) return null;
  return round2(withData.reduce((s, r) => s + r, 0) / withData.length);
}

function avgWinRateOf(positions: ShadowPosition[]): number | null {
  const withData = positions.map(winRateOfPosition).filter((r): r is number => r !== null);
  if (withData.length === 0) return null;
  return round2(withData.reduce((s, r) => s + r, 0) / withData.length);
}

const NEGATIVE_CODES: ProfitRouteReasonCode[] = [
  "TOXIC_VARIANT",
  "ALL_REPLAY_VARIANTS_NEGATIVE",
  "NEGATIVE_NET_EVIDENCE",
  "NO_EVIDENCE",
  "EARLY_SAMPLE",
  "SYMBOL_NET_NEGATIVE",
  "SIDE_NET_NEGATIVE",
  "KRONOS_HORIZON_CONFLICT",
  "KRONOS_DISAGREES",
  "WHALE_DISAGREES",
  "RUNNER_BLOCKED_BY_HORIZON_CONFLICT",
  "RUNNER_REQUIRES_POSITIVE_NET",
  "COST_R_HIGH",
  "STOP_TOO_TIGHT",
  "TP1_NOT_PROFITABLE_AFTER_COST",
];

const POSITIVE_CODES: ProfitRouteReasonCode[] = [
  "POSITIVE_NET_EVIDENCE",
  "SYMBOL_NET_POSITIVE",
  "KRONOS_AGREES",
  "WHALE_AGREES",
  "RUNNER_OK",
  "TP1_PROFITABLE_AFTER_COST",
  "PROFITABLE_REPLAY_CHOICE",
  "TOXIC_VARIANT_OVERRIDDEN_BY_SYMBOL",
];

export function buildExpansionReport(
  positions: ShadowPosition[],
  _perf: PerformanceStats | null = null,
): ExpansionReport {
  const generatedAt = new Date().toISOString();
  const total = positions.length;

  const byMode = (mode: ProfitRouteMode) =>
    positions.filter((p) => (p.variantSelection?.routeMode ?? "RESEARCH_ONLY") === mode);

  const profitCandidates = byMode("PROFIT_CANDIDATE");
  const dataCollection = byMode("DATA_COLLECTION");
  const researchOnly = byMode("RESEARCH_ONLY");

  // Per-symbol aggregation
  const symbolMap = new Map<string, ShadowPosition[]>();
  for (const p of positions) {
    const arr = symbolMap.get(p.symbol) ?? [];
    arr.push(p);
    symbolMap.set(p.symbol, arr);
  }

  const allSymbols: SymbolExpansionRow[] = [];
  for (const [symbol, symPositions] of symbolMap) {
    const pc = symPositions.filter((p) => p.variantSelection?.routeMode === "PROFIT_CANDIDATE").length;
    const dc = symPositions.filter((p) => p.variantSelection?.routeMode === "DATA_COLLECTION").length;
    const ro = symPositions.filter((p) => (p.variantSelection?.routeMode ?? "RESEARCH_ONLY") === "RESEARCH_ONLY").length;

    const scores = symPositions
      .map((p) => p.variantSelection?.routeScore ?? null)
      .filter((s): s is number => s !== null);
    const avgRouteScore = scores.length ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

    const avgNetR = avgNetROf(symPositions);
    const winRate = avgWinRateOf(symPositions);

    // Most common blocker among RESEARCH_ONLY in this symbol
    const roPositions = symPositions.filter((p) => (p.variantSelection?.routeMode ?? "RESEARCH_ONLY") === "RESEARCH_ONLY");
    const codeFreq = new Map<string, number>();
    for (const p of roPositions) {
      for (const code of p.variantSelection?.routeReasonCodes ?? []) {
        if (NEGATIVE_CODES.includes(code as ProfitRouteReasonCode)) {
          codeFreq.set(code, (codeFreq.get(code) ?? 0) + 1);
        }
      }
    }
    const topBlocker = codeFreq.size > 0
      ? [...codeFreq.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : null;

    const directions = new Set(symPositions.map(directionOf));
    const direction: SymbolExpansionRow["direction"] =
      directions.size > 1 ? "MIXED" : directions.has("SHORT") ? "SHORT" : "LONG";

    let tag: SymbolExpansionRow["tag"];
    if (pc > 0 && ro === 0) tag = "PROFIT";
    else if (pc > 0) tag = "MIXED";
    else if (avgRouteScore > -10 && ro > 0) tag = "PROMOTABLE";
    else tag = "TOXIC";

    allSymbols.push({
      symbol,
      direction,
      profitCandidateIdeas: pc,
      dataCollectionIdeas: dc,
      researchOnlyIdeas: ro,
      avgRouteScore,
      avgNetR,
      winRate,
      tag,
      topBlocker,
    });
  }

  allSymbols.sort((a, b) => b.avgRouteScore - a.avgRouteScore);
  const promotableSymbols = allSymbols.filter((r) => r.tag === "PROMOTABLE");
  const toxicSymbols = allSymbols.filter((r) => r.tag === "TOXIC");

  // Per-variant-combo aggregation
  const variantMap = new Map<string, ShadowPosition[]>();
  for (const p of positions) {
    const key = `${p.variantSelection?.selectedEntryVariant ?? "unknown"}__${p.variantSelection?.selectedExitVariant ?? "unknown"}`;
    const arr = variantMap.get(key) ?? [];
    arr.push(p);
    variantMap.set(key, arr);
  }

  const variantTable: VariantExpansionRow[] = [];
  for (const [key, vPositions] of variantMap) {
    const [entryVariant, exitVariant] = key.split("__") as [ExecutionEntryVariant, ShadowPositionVariant];
    const pc = vPositions.filter((p) => p.variantSelection?.routeMode === "PROFIT_CANDIDATE").length;
    const ro = vPositions.filter((p) => (p.variantSelection?.routeMode ?? "RESEARCH_ONLY") === "RESEARCH_ONLY").length;
    const scores = vPositions.map((p) => p.variantSelection?.routeScore ?? null).filter((s): s is number => s !== null);
    const avgRouteScore = scores.length ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const avgNetR = avgNetROf(vPositions);

    let tag: VariantExpansionRow["tag"];
    if (pc > 0 && avgNetR !== null && avgNetR > 0) tag = "BEST";
    else if (avgRouteScore > -10) tag = "BREAKEVEN";
    else tag = "TOXIC";

    variantTable.push({
      entryVariant,
      exitVariant,
      ideas: vPositions.length,
      profitCandidateCount: pc,
      researchOnlyCount: ro,
      avgNetR,
      avgRouteScore,
      tag,
    });
  }
  variantTable.sort((a, b) => b.avgRouteScore - a.avgRouteScore);

  const topProfitPattern = variantTable.find((r) => r.tag === "BEST") ?? null;
  const breakEvenVariants = variantTable.filter((r) => r.tag === "BREAKEVEN");

  // Direction breakdown
  const mkDir = (dir: "LONG" | "SHORT"): DirectionRow => {
    const dirPos = positions.filter((p) => directionOf(p) === dir);
    const pc2 = dirPos.filter((p) => p.variantSelection?.routeMode === "PROFIT_CANDIDATE").length;
    const ro2 = dirPos.filter((p) => (p.variantSelection?.routeMode ?? "RESEARCH_ONLY") === "RESEARCH_ONLY").length;
    return {
      ideas: dirPos.length,
      profitCandidates: pc2,
      researchOnly: ro2,
      avgNetR: avgNetROf(dirPos),
      profitCandidatePct: dirPos.length ? round2(pc2 / dirPos.length) : 0,
    };
  };

  // Blocker code frequency across all RESEARCH_ONLY
  const blockerFreq = new Map<string, number>();
  const positiveFreq = new Map<string, number>();
  for (const p of positions) {
    for (const code of p.variantSelection?.routeReasonCodes ?? []) {
      if (NEGATIVE_CODES.includes(code as ProfitRouteReasonCode)) {
        blockerFreq.set(code, (blockerFreq.get(code) ?? 0) + 1);
      }
      if (POSITIVE_CODES.includes(code as ProfitRouteReasonCode)) {
        positiveFreq.set(code, (positiveFreq.get(code) ?? 0) + 1);
      }
    }
  }

  const mkFreqList = (freq: Map<string, number>): ReasonCodeFrequency[] =>
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([code, count]) => ({
        code: code as ProfitRouteReasonCode,
        count,
        pct: total > 0 ? round2(count / total) : 0,
      }));

  // Entry variant selection counts
  const entryFreq = new Map<string, ShadowPosition[]>();
  for (const p of positions) {
    const k = p.variantSelection?.selectedEntryVariant ?? "unknown";
    const arr = entryFreq.get(k) ?? [];
    arr.push(p);
    entryFreq.set(k, arr);
  }
  const entryVariantSelectionCounts: EntryVariantSelectionCount[] = [...entryFreq.entries()]
    .map(([entryVariant, eps]) => ({
      entryVariant,
      count: eps.length,
      pct: total > 0 ? round2(eps.length / total) : 0,
      profitCandidateCount: eps.filter((p) => p.variantSelection?.routeMode === "PROFIT_CANDIDATE").length,
      avgNetR: avgNetROf(eps),
    }))
    .sort((a, b) => b.count - a.count);

  const noChaseAtrSelectedCount = entryFreq.get("no_chase_atr_entry")?.length ?? 0;
  const fib500SelectedCount = entryFreq.get("fib_500_entry")?.length ?? 0;
  const longCandidateCount = positions.filter((p) => directionOf(p) === "LONG").length;
  const shortCandidateCount = positions.filter((p) => directionOf(p) === "SHORT").length;

  const topToxicCombos = variantTable.filter((r) => r.tag === "TOXIC").slice(0, 5);
  const topPromotableCombos = variantTable
    .filter((r) => r.tag === "BREAKEVEN" || r.tag === "BEST")
    .slice(0, 5);

  const routeModeDistribution: RouteModeDistribution = {
    PROFIT_CANDIDATE: profitCandidates.length,
    DATA_COLLECTION: dataCollection.length,
    RESEARCH_ONLY: researchOnly.length,
    profitCandidatePct: total > 0 ? round2(profitCandidates.length / total) : 0,
    researchOnlyPct: total > 0 ? round2(researchOnly.length / total) : 0,
  };

  return {
    generatedAt,
    totalIdeas: total,
    profitCandidateCount: profitCandidates.length,
    dataCollectionCount: dataCollection.length,
    researchOnlyCount: researchOnly.length,
    routeModeDistribution,
    promotableSymbols,
    toxicSymbols,
    allSymbols,
    breakEvenVariants,
    topToxicCombos,
    topPromotableCombos,
    topProfitPattern,
    directionBreakdown: { LONG: mkDir("LONG"), SHORT: mkDir("SHORT") },
    topBlockerCodes: mkFreqList(blockerFreq),
    topPositiveCodes: mkFreqList(positiveFreq),
    variantTable,
    entryVariantSelectionCounts,
    noChaseAtrSelectedCount,
    fib500SelectedCount,
    shortCandidateCount,
    longCandidateCount,
  };
}

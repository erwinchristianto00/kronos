import type {
  ExecutionEntryVariant,
  ProfitRouteMode,
  ShadowPosition,
  ShadowPositionVariant,
} from "@dtc/shared";

export interface RouteModeCounts {
  PROFIT_CANDIDATE: number;
  DATA_COLLECTION: number;
  RESEARCH_ONLY: number;
  profitCandidatePct: number;
  researchOnlyPct: number;
  dataCollectionPct: number;
}

export interface ScopeMetrics {
  ideas: number;
  closedCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
}

export interface VariantComboRow {
  entryVariant: ExecutionEntryVariant | string;
  exitVariant: ShadowPositionVariant | string;
  ideas: number;
  closedCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  /** True when both entry and exit are "unknown" — indicates pre-routing legacy positions. */
  isLegacyUnknown?: boolean;
}

export type Fib500TpFullStatus = "collecting" | "promising" | "promotable";

/**
 * Tracks the fib_500 + tp1_full cohort's progress toward PROFIT_CANDIDATE promotion.
 * Status is advisory only — the router does not auto-promote based on this.
 * Promotion requires explicit evidence review (targetResolved reached, positive metrics).
 */
export interface Fib500TpFullWatcher {
  ideas: number;
  resolved: number;
  targetResolved: number;
  netAvgR: number | null;
  profitFactor: number | null;
  profitableTp1Rate: number | null;
  status: Fib500TpFullStatus;
}

export interface RoutingMonitorReport {
  generatedAt: string;
  date: string;
  routeModeDistribution: RouteModeCounts;
  newIdeasToday: number;
  newIdeasTodayByRoute: { PROFIT_CANDIDATE: number; DATA_COLLECTION: number; RESEARCH_ONLY: number };
  dataCollection: ScopeMetrics;
  profitCandidate: ScopeMetrics;
  researchOnly: ScopeMetrics;
  fib500TpFull: Fib500TpFullWatcher;
  noChaseAtrSelectedCount: number;
  kronosRunnerSelectedCount: number;
  tp1FullSelectedCount: number;
  fib500SelectedCount: number;
  topProfitLeaks: VariantComboRow[];
  topImprovingRoutes: VariantComboRow[];
  /**
   * Legacy "unknown + unknown" combos shown separately.
   * These are pre-routing positions where variantSelection was absent.
   * Excluded from topProfitLeaks / topImprovingRoutes to avoid distorting evidence.
   */
  legacyLeaks: VariantComboRow[];
}

// How many resolved shadow closes needed before fib_500+tp1_full can be "promotable".
const FIB500_TPFULL_TARGET_RESOLVED = 20;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function routeOf(p: ShadowPosition): ProfitRouteMode {
  return (p.variantSelection?.routeMode ?? "RESEARCH_ONLY") as ProfitRouteMode;
}

function closedVariants(p: ShadowPosition) {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

function scopeMetrics(positions: ShadowPosition[]): ScopeMetrics {
  const allClosed = positions.flatMap(closedVariants);
  if (positions.length === 0) {
    return { ideas: 0, closedCount: 0, netAvgR: null, profitFactor: null, winRate: null, profitableTp1Rate: null, slRate: null };
  }
  if (allClosed.length === 0) {
    return { ideas: positions.length, closedCount: 0, netAvgR: null, profitFactor: null, winRate: null, profitableTp1Rate: null, slRate: null };
  }
  const winners = allClosed.filter((v) => v.realizedNetR > 0);
  const losers = allClosed.filter((v) => v.realizedNetR < 0);
  const lossMag = Math.abs(losers.reduce((s, v) => s + v.realizedNetR, 0));
  const tp1HitVariants = positions.flatMap((p) => p.variants.filter((v) => v.tp1Hit));
  const profitableTp1Count = tp1HitVariants.filter((v) => v.realizedNetR > 0).length;
  const slCount = allClosed.filter((v) => v.closeReason === "SL" || v.closeReason === "BREAKEVEN").length;
  return {
    ideas: positions.length,
    closedCount: allClosed.length,
    netAvgR: round4(allClosed.reduce((s, v) => s + v.realizedNetR, 0) / allClosed.length),
    profitFactor:
      lossMag === 0 ? null : round4(winners.reduce((s, v) => s + v.realizedNetR, 0) / lossMag),
    winRate: round4(winners.length / allClosed.length),
    profitableTp1Rate: tp1HitVariants.length === 0 ? null : round4(profitableTp1Count / tp1HitVariants.length),
    slRate: round4(slCount / allClosed.length),
  };
}

function buildComboRow(
  entryVariant: string,
  exitVariant: string,
  ps: ShadowPosition[],
): VariantComboRow {
  const isLegacyUnknown = entryVariant === "unknown" && exitVariant === "unknown";
  const closed = ps.flatMap(closedVariants);
  if (closed.length === 0) {
    return { entryVariant, exitVariant, ideas: ps.length, closedCount: 0, netAvgR: null, profitFactor: null, winRate: null, ...(isLegacyUnknown ? { isLegacyUnknown: true } : {}) };
  }
  const winners = closed.filter((v) => v.realizedNetR > 0);
  const losers = closed.filter((v) => v.realizedNetR < 0);
  const lossMag = Math.abs(losers.reduce((s, v) => s + v.realizedNetR, 0));
  return {
    entryVariant,
    exitVariant,
    ideas: ps.length,
    closedCount: closed.length,
    netAvgR: round4(closed.reduce((s, v) => s + v.realizedNetR, 0) / closed.length),
    profitFactor: lossMag === 0 ? null : round4(winners.reduce((s, v) => s + v.realizedNetR, 0) / lossMag),
    winRate: round4(winners.length / closed.length),
    ...(isLegacyUnknown ? { isLegacyUnknown: true } : {}),
  };
}

function buildFib500Watcher(positions: ShadowPosition[]): Fib500TpFullWatcher {
  const fib500TpFullPositions = positions.filter(
    (p) =>
      p.variantSelection?.selectedEntryVariant === "fib_500_entry" &&
      p.variantSelection?.selectedExitVariant === "tp1_full_exit",
  );
  const closed = fib500TpFullPositions.flatMap(closedVariants);
  const resolved = closed.length;

  if (resolved === 0) {
    return {
      ideas: fib500TpFullPositions.length,
      resolved: 0,
      targetResolved: FIB500_TPFULL_TARGET_RESOLVED,
      netAvgR: null,
      profitFactor: null,
      profitableTp1Rate: null,
      status: "collecting",
    };
  }

  const netAvgR = round4(closed.reduce((s, v) => s + v.realizedNetR, 0) / closed.length);
  const winners = closed.filter((v) => v.realizedNetR > 0);
  const losers = closed.filter((v) => v.realizedNetR < 0);
  const lossMag = Math.abs(losers.reduce((s, v) => s + v.realizedNetR, 0));
  const profitFactor = lossMag === 0 ? null : round4(winners.reduce((s, v) => s + v.realizedNetR, 0) / lossMag);
  const tp1Hits = closed.filter((v) => v.tp1Hit);
  const profitableTp1Rate =
    tp1Hits.length === 0
      ? null
      : round4(tp1Hits.filter((v) => v.realizedNetR > 0).length / tp1Hits.length);

  const status: Fib500TpFullStatus =
    resolved >= FIB500_TPFULL_TARGET_RESOLVED &&
    netAvgR > 0.2 &&
    (profitFactor ?? 0) > 1.5
      ? "promotable"
      : resolved >= 10 && netAvgR > 0 && (profitFactor ?? 0) > 1
      ? "promising"
      : "collecting";

  return {
    ideas: fib500TpFullPositions.length,
    resolved,
    targetResolved: FIB500_TPFULL_TARGET_RESOLVED,
    netAvgR,
    profitFactor,
    profitableTp1Rate,
    status,
  };
}

export function buildRoutingMonitorReport(
  positions: ShadowPosition[],
  now: Date = new Date(),
): RoutingMonitorReport {
  const generatedAt = now.toISOString();
  const date = generatedAt.slice(0, 10);

  const total = positions.length;

  const byMode = (mode: ProfitRouteMode) => positions.filter((p) => routeOf(p) === mode);
  const profitCandidates = byMode("PROFIT_CANDIDATE");
  const dataCollection = byMode("DATA_COLLECTION");
  const researchOnly = byMode("RESEARCH_ONLY");

  const routeModeDistribution: RouteModeCounts = {
    PROFIT_CANDIDATE: profitCandidates.length,
    DATA_COLLECTION: dataCollection.length,
    RESEARCH_ONLY: researchOnly.length,
    profitCandidatePct: total > 0 ? round4(profitCandidates.length / total) : 0,
    researchOnlyPct: total > 0 ? round4(researchOnly.length / total) : 0,
    dataCollectionPct: total > 0 ? round4(dataCollection.length / total) : 0,
  };

  const isNewToday = (p: ShadowPosition): boolean => (p.firstSeenAt ?? "").slice(0, 10) === date;
  const newToday = positions.filter(isNewToday);

  const newIdeasTodayByRoute = {
    PROFIT_CANDIDATE: newToday.filter((p) => routeOf(p) === "PROFIT_CANDIDATE").length,
    DATA_COLLECTION: newToday.filter((p) => routeOf(p) === "DATA_COLLECTION").length,
    RESEARCH_ONLY: newToday.filter((p) => routeOf(p) === "RESEARCH_ONLY").length,
  };

  // Variant selection counts
  let noChaseAtrSelectedCount = 0;
  let kronosRunnerSelectedCount = 0;
  let tp1FullSelectedCount = 0;
  let fib500SelectedCount = 0;
  for (const p of positions) {
    const e = p.variantSelection?.selectedEntryVariant;
    const x = p.variantSelection?.selectedExitVariant;
    if (e === "no_chase_atr_entry") noChaseAtrSelectedCount += 1;
    if (e === "fib_500_entry") fib500SelectedCount += 1;
    if (x === "kronos_runner_exit") kronosRunnerSelectedCount += 1;
    if (x === "tp1_full_exit") tp1FullSelectedCount += 1;
  }

  // fib_500 + tp1_full promotion watcher
  const fib500TpFull = buildFib500Watcher(positions);

  // Per-combo aggregation
  const comboMap = new Map<string, ShadowPosition[]>();
  for (const p of positions) {
    const e = p.variantSelection?.selectedEntryVariant ?? "unknown";
    const x = p.variantSelection?.selectedExitVariant ?? "unknown";
    const key = `${e}__${x}`;
    const arr = comboMap.get(key) ?? [];
    arr.push(p);
    comboMap.set(key, arr);
  }

  const comboRows: VariantComboRow[] = [];
  for (const [key, ps] of comboMap) {
    const [entryVariant, exitVariant] = key.split("__") as [string, string];
    comboRows.push(buildComboRow(entryVariant, exitVariant, ps));
  }

  // Separate legacy (unknown+unknown) from evidence rows.
  // Legacy positions pre-date routing; exclude them from leak/improving analysis
  // to avoid distorting route-selection evidence.
  const evidenceRows = comboRows.filter((r) => !r.isLegacyUnknown);
  const legacyRows = comboRows.filter((r) => r.isLegacyUnknown);

  // Top profit leaks: worst negative netAvgR with meaningful sample (≥3 closed)
  const topProfitLeaks = evidenceRows
    .filter((r) => r.closedCount >= 3 && r.netAvgR !== null && r.netAvgR < 0)
    .sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0))
    .slice(0, 5);

  // Top improving routes: best positive netAvgR with meaningful sample (≥3 closed)
  const topImprovingRoutes = evidenceRows
    .filter((r) => r.closedCount >= 3 && r.netAvgR !== null && r.netAvgR > -0.05)
    .sort((a, b) => (b.netAvgR ?? 0) - (a.netAvgR ?? 0))
    .slice(0, 5);

  // Legacy leaks: unknown+unknown combos, sorted by worst R for visibility
  const legacyLeaks = legacyRows
    .filter((r) => r.closedCount >= 1)
    .sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0));

  return {
    generatedAt,
    date,
    routeModeDistribution,
    newIdeasToday: newToday.length,
    newIdeasTodayByRoute,
    dataCollection: scopeMetrics(dataCollection),
    profitCandidate: scopeMetrics(profitCandidates),
    researchOnly: scopeMetrics(researchOnly),
    fib500TpFull,
    noChaseAtrSelectedCount,
    kronosRunnerSelectedCount,
    tp1FullSelectedCount,
    fib500SelectedCount,
    topProfitLeaks,
    topImprovingRoutes,
    legacyLeaks,
  };
}

// Used by tests for stable comparison
export const _internals = { round2, round4 };

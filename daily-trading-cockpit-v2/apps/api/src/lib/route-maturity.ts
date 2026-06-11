import type { EvidenceEra, ExecutionEntryVariant, ShadowPosition, ShadowPositionVariant, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra } from "@dtc/shared";

/**
 * SHADOW ROUTE MATURITY
 *
 * Multi-cohort report. Groups shadow positions by selectedEntryVariant +
 * selectedExitVariant and tracks each cohort's evidence accumulation BEFORE
 * promotion to full-auto live trading.
 *
 *   - Scope: routeMode in {DATA_COLLECTION, PROFIT_CANDIDATE}
 *   - Excluded: RESEARCH_ONLY
 *
 * Live Auto Readiness (see live-readiness.ts) is the FINAL eligibility check
 * once a route has been promoted; it is locked to fib_500+tp1_full and
 * PROFIT_CANDIDATE only. This module is the precursor that surfaces every
 * cohort still in collection.
 *
 * No effect on routing, promotion, scanner ranking, or shadow execution.
 */

export type MaturityStatus = "COLLECTING" | "PROMISING" | "PROMOTABLE" | "DEGRADING" | "WEAK";

export type SampleTier = "early" | "provisional" | "usable";

export interface CohortMaturity {
  entryVariant: ExecutionEntryVariant | string;
  exitVariant: ShadowPositionVariant | string;
  totalIdeas: number;
  openCount: number;
  closedCount: number;
  noFillCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  sampleTier: SampleTier;
  routeModeDistribution: { DATA_COLLECTION: number; PROFIT_CANDIDATE: number };
  /** Number of closes within the last 7 days. */
  recentClosedCount: number;
  /** Net avg R for closes within the last 7 days. */
  recentNetAvgR: number | null;
  estimatedDaysTo30Closed: number | null;
  estimatedDaysTo100Closed: number | null;
  maturityStatus: MaturityStatus;
  /** True if this cohort matches a hardcoded priority list. */
  isPriorityCohort: boolean;
  /** True if any position in this cohort has been seen by the scanner in the last 24h. */
  isCurrentlySelected: boolean;
}

export interface RouteMaturityReport {
  generatedAt: string;
  scope: { includes: ["DATA_COLLECTION", "PROFIT_CANDIDATE"]; excludes: ["RESEARCH_ONLY"] };
  eraFilter: RouteMaturityEraFilter;
  cohorts: CohortMaturity[];
  /** Highest-evidence cohort among priority+selected ones; null if none qualify. */
  leadingCohort: { entryVariant: string; exitVariant: string } | null;
  notes: string[];
}

const PROMISING_MIN_CLOSED = 15;
const PROMOTABLE_MIN_CLOSED = 30;
const LIVE_READY_TARGET = 100;
const PROMOTABLE_NET_AVG_R = 0.1;
const PROMOTABLE_PF = 1.2;
const PROMOTABLE_TP1_PROFIT_RATE = 0.5;
const PROMOTABLE_SL_RATE_MAX = 0.4;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CURRENTLY_SELECTED_WINDOW_MS = 24 * 60 * 60 * 1000;

const PRIORITY_COHORTS: Array<{ entry: ExecutionEntryVariant; exit: ShadowPositionVariant }> = [
  { entry: "fib_500_entry", exit: "tp1_full_exit" },
  { entry: "vwap_retest_entry", exit: "tp1_full_exit" },
  { entry: "fib_382_entry", exit: "tp1_full_exit" },
];

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function tierFromResolved(resolved: number): SampleTier {
  if (resolved > 100) return "usable";
  if (resolved >= 30) return "provisional";
  return "early";
}

function closedVariantsOf(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

function openVariantsOf(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state !== "CLOSED");
}

function noFillCountOf(p: ShadowPosition): number {
  return p.variants.filter((v) => v.closeReason === "NO_FILL").length;
}

function isInScope(p: ShadowPosition): boolean {
  const mode = p.variantSelection?.routeMode;
  return mode === "DATA_COLLECTION" || mode === "PROFIT_CANDIDATE";
}

function isPriority(entry: string, exit: string): boolean {
  return PRIORITY_COHORTS.some((c) => c.entry === entry && c.exit === exit);
}

function maturityFor(input: {
  closedCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  recentNetAvgR: number | null;
}): MaturityStatus {
  const {
    closedCount,
    netAvgR,
    profitFactor,
    profitableTp1Rate,
    slRate,
    recentNetAvgR,
  } = input;

  // COLLECTING short-circuits everything else when the sample is too thin —
  // there's no signal worth interpreting yet.
  if (closedCount < PROMISING_MIN_CLOSED) return "COLLECTING";

  // DEGRADING is a warning state: all-time positive but the last 7 days slipped
  // into the red. Catch it BEFORE classifying as PROMISING/PROMOTABLE because
  // recent direction matters more than averaged history.
  if (
    netAvgR !== null &&
    netAvgR > 0 &&
    recentNetAvgR !== null &&
    recentNetAvgR < 0
  ) {
    return "DEGRADING";
  }

  const promotable =
    closedCount >= PROMOTABLE_MIN_CLOSED &&
    (netAvgR ?? -1) > PROMOTABLE_NET_AVG_R &&
    (profitFactor ?? 0) > PROMOTABLE_PF &&
    (profitableTp1Rate ?? 0) > PROMOTABLE_TP1_PROFIT_RATE &&
    (slRate ?? 1) < PROMOTABLE_SL_RATE_MAX;
  if (promotable) return "PROMOTABLE";

  const promising =
    (netAvgR ?? -1) > 0 &&
    (profitFactor ?? 0) > 1;
  if (promising) return "PROMISING";

  return "WEAK";
}

function estimateDays(remaining: number, recentClosedCount: number): number | null {
  if (remaining <= 0) return 0;
  if (recentClosedCount <= 0) return null;
  const perDay = recentClosedCount / 7;
  if (perDay <= 0) return null;
  return Math.ceil(remaining / perDay);
}

function buildCohort(
  entryVariant: string,
  exitVariant: string,
  positions: ShadowPosition[],
  now: Date,
): CohortMaturity {
  const totalIdeas = positions.length;
  const openCount = positions.flatMap(openVariantsOf).length;
  const closedAll = positions.flatMap(closedVariantsOf);
  const closedCount = closedAll.length;
  const noFillCount = positions.reduce((s, p) => s + noFillCountOf(p), 0);

  const winners = closedAll.filter((v) => v.realizedNetR > 0);
  const losers = closedAll.filter((v) => v.realizedNetR < 0);
  const lossMag = Math.abs(losers.reduce((s, v) => s + v.realizedNetR, 0));
  const netAvgR =
    closedCount === 0 ? null : r4(closedAll.reduce((s, v) => s + v.realizedNetR, 0) / closedCount);
  const grossAvgR =
    closedCount === 0 ? null : r4(closedAll.reduce((s, v) => s + v.realizedGrossR, 0) / closedCount);
  const profitFactor =
    lossMag === 0 ? null : r4(winners.reduce((s, v) => s + v.realizedNetR, 0) / lossMag);
  const winRate = closedCount === 0 ? null : r4(winners.length / closedCount);

  const allVariants = positions.flatMap((p) => p.variants);
  const tp1Hits = allVariants.filter((v) => v.tp1Hit);
  const tp1Rate = allVariants.length === 0 ? null : r4(tp1Hits.length / allVariants.length);
  // profitableTp1Rate is measured on the closed sample with tp1 touched.
  const closedTp1 = closedAll.filter((v) => v.tp1Hit);
  const profitableTp1Rate =
    closedTp1.length === 0
      ? null
      : r4(closedTp1.filter((v) => v.realizedNetR > 0).length / closedTp1.length);

  const slCount = closedAll.filter((v) => v.closeReason === "SL" || v.closeReason === "BREAKEVEN").length;
  const slRate = closedCount === 0 ? null : r4(slCount / closedCount);

  const avgWinR = winners.length === 0 ? null : r4(winners.reduce((s, v) => s + v.realizedNetR, 0) / winners.length);
  const avgLossR = losers.length === 0 ? null : r4(losers.reduce((s, v) => s + v.realizedNetR, 0) / losers.length);

  const routeModeDistribution = {
    DATA_COLLECTION: positions.filter((p) => p.variantSelection?.routeMode === "DATA_COLLECTION").length,
    PROFIT_CANDIDATE: positions.filter((p) => p.variantSelection?.routeMode === "PROFIT_CANDIDATE").length,
  };

  const recentCutoff = now.getTime() - RECENT_WINDOW_MS;
  const recentClosed = closedAll.filter((v) => {
    const t = v.closedAt ? new Date(v.closedAt).getTime() : 0;
    return t >= recentCutoff;
  });
  const recentClosedCount = recentClosed.length;
  const recentNetAvgR =
    recentClosedCount === 0 ? null : r4(recentClosed.reduce((s, v) => s + v.realizedNetR, 0) / recentClosedCount);

  const estimatedDaysTo30Closed = estimateDays(Math.max(0, PROMOTABLE_MIN_CLOSED - closedCount), recentClosedCount);
  const estimatedDaysTo100Closed = estimateDays(Math.max(0, LIVE_READY_TARGET - closedCount), recentClosedCount);

  const isCurrentlySelected = positions.some((p) => {
    const t = new Date(p.lastSeenAt ?? p.firstSeenAt ?? 0).getTime();
    return now.getTime() - t <= CURRENTLY_SELECTED_WINDOW_MS;
  });

  const maturityStatus = maturityFor({
    closedCount,
    netAvgR,
    profitFactor,
    profitableTp1Rate,
    slRate,
    recentNetAvgR,
  });

  return {
    entryVariant,
    exitVariant,
    totalIdeas,
    openCount,
    closedCount,
    noFillCount,
    netAvgR,
    grossAvgR,
    profitFactor,
    winRate,
    tp1Rate,
    profitableTp1Rate,
    slRate,
    avgWinR,
    avgLossR,
    sampleTier: tierFromResolved(closedCount),
    routeModeDistribution,
    recentClosedCount,
    recentNetAvgR,
    estimatedDaysTo30Closed,
    estimatedDaysTo100Closed,
    maturityStatus,
    isPriorityCohort: isPriority(entryVariant, exitVariant),
    isCurrentlySelected,
  };
}

function cohortSortKey(c: CohortMaturity): [number, number, number, number] {
  // Sort priority cohorts to the top, then currently-selected, then by closed
  // sample, then by recent activity. Negate counts because we want descending.
  return [
    c.isPriorityCohort ? 0 : 1,
    c.isCurrentlySelected ? 0 : 1,
    -c.closedCount,
    -c.recentClosedCount,
  ];
}

function compareCohorts(a: CohortMaturity, b: CohortMaturity): number {
  const ka = cohortSortKey(a);
  const kb = cohortSortKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

function pickLeadingCohort(cohorts: CohortMaturity[]): RouteMaturityReport["leadingCohort"] {
  // Leading cohort: must be priority OR currently-selected, must have ≥1 close,
  // pick the one with the most closed samples. Promotion is still a manual decision.
  const eligible = cohorts.filter(
    (c) => (c.isPriorityCohort || c.isCurrentlySelected) && c.closedCount > 0,
  );
  if (eligible.length === 0) return null;
  const leader = eligible.slice().sort((a, b) => b.closedCount - a.closedCount)[0];
  return { entryVariant: leader.entryVariant, exitVariant: leader.exitVariant };
}

export type RouteMaturityEraFilter = "ALL_TIME" | "POST_ROUTING" | "POST_CALIBRATION";

export interface RouteMaturityInput {
  positions: ShadowPosition[];
  /**
   * When set, restricts the input to positions whose inferred era is in scope.
   *   ALL_TIME            — every position
   *   POST_ROUTING        — POST_ROUTING_PRE_CALIBRATION + POST_CALIBRATION
   *   POST_CALIBRATION    — POST_CALIBRATION only (default for the UI default view)
   */
  eraFilter?: RouteMaturityEraFilter;
}

function eraInFilter(era: EvidenceEra, filter: RouteMaturityEraFilter): boolean {
  if (filter === "ALL_TIME") return true;
  if (filter === "POST_CALIBRATION") return era === "POST_CALIBRATION";
  // POST_ROUTING — anything from the routing fix onward
  return era === "POST_ROUTING_PRE_CALIBRATION" || era === "POST_CALIBRATION";
}

export function buildRouteMaturityReport(
  input: RouteMaturityInput,
  now: Date = new Date(),
): RouteMaturityReport {
  const generatedAt = now.toISOString();
  // Default to ALL_TIME at the function level for backward compatibility; the
  // UI/endpoint applies the POST_CALIBRATION default explicitly so legacy
  // callers (tests, alternate consumers) don't silently drop data.
  const filter: RouteMaturityEraFilter = input.eraFilter ?? "ALL_TIME";
  const eraFiltered =
    filter === "ALL_TIME"
      ? input.positions
      : input.positions.filter((p) => eraInFilter(classifyEvidenceEra(p), filter));
  const inScope = eraFiltered.filter(isInScope);

  // Group by entryVariant + exitVariant
  const groups = new Map<string, ShadowPosition[]>();
  for (const p of inScope) {
    const entry = p.variantSelection?.selectedEntryVariant;
    const exit = p.variantSelection?.selectedExitVariant;
    if (!entry || !exit) continue;
    const key = `${entry}__${exit}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  const cohorts: CohortMaturity[] = [];
  for (const [key, ps] of groups) {
    const [entry, exit] = key.split("__") as [string, string];
    cohorts.push(buildCohort(entry, exit, ps, now));
  }

  // Ensure priority cohorts always appear in the report, even with zero samples,
  // so the UI can show "0 closed, COLLECTING" rather than hiding them.
  for (const pc of PRIORITY_COHORTS) {
    if (!cohorts.some((c) => c.entryVariant === pc.entry && c.exitVariant === pc.exit)) {
      cohorts.push(buildCohort(pc.entry, pc.exit, [], now));
    }
  }

  cohorts.sort(compareCohorts);

  return {
    generatedAt,
    scope: { includes: ["DATA_COLLECTION", "PROFIT_CANDIDATE"], excludes: ["RESEARCH_ONLY"] },
    eraFilter: filter,
    cohorts,
    leadingCohort: pickLeadingCohort(cohorts),
    notes: [
      "Route Maturity = shadow evidence accumulation before promotion.",
      "Live Auto Readiness = final full-auto eligibility after promotion.",
      "Scope: DATA_COLLECTION + PROFIT_CANDIDATE. RESEARCH_ONLY excluded.",
      "Status: COLLECTING<15 closed | PROMISING ≥15 & net>0 & PF>1 | PROMOTABLE ≥30 & net>0.10 & PF>1.2 & TP1prof>50% & SL<40% | DEGRADING all-time net>0 but recent net<0 | WEAK otherwise.",
    ],
  };
}

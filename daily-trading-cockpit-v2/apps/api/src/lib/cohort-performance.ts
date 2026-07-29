import type { EvidenceEra, ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra, CURRENT_EVIDENCE_ERA } from "@dtc/shared";

/**
 * COHORT PERFORMANCE BY EVIDENCE ERA
 *
 * Splits shadow positions by which planner generation produced them so the
 * dashboard can compare:
 *   LEGACY_PRE_ROUTING           — pre-fix toxic data
 *   POST_ROUTING_PRE_CALIBRATION — after no_chase/runner patches
 *   POST_CALIBRATION             — historical calibrated cohort
 *   POST_END_TO_END_CORRECTNESS_FIX_V1 — current correctness-migrated cohort
 *
 * Reporting only. Does not mutate inputs and does not change any decision
 * rule. Old records keep their original shape; era is inferred read-only.
 */

export type CohortEra = EvidenceEra;

export interface CohortRow {
  key: string; // e.g. combo:fib_500_entry__tp1_full_exit
  count: number;
  netAvgR: number | null;
}

export interface CohortStats {
  era: CohortEra;
  totalIdeas: number;
  closedCount: number;
  openCount: number;
  noFillCount: number;
  avgExpectedNetR: number | null;
  avgCalibratedExpectedNetR: number | null;
  avgRealizedNetR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  topEntryExitCombos: CohortRow[];
  worstEntryExitCombos: CohortRow[];
  topSymbols: CohortRow[];
  worstSymbols: CohortRow[];
  routeModeDistribution: {
    PROFIT_CANDIDATE: number;
    DATA_COLLECTION: number;
    RESEARCH_ONLY: number;
    UNKNOWN: number;
  };
  diagnosisSummary: Record<string, number>;
}

export interface CohortDelta {
  netAvgRDelta: number | null;
  profitFactorDelta: number | null;
  slRateDelta: number | null;
  overestimationErrorDelta: number | null;
}

export interface CohortPerformanceReport {
  generatedAt: string;
  currentEra: CohortEra;
  byEra: Partial<Record<CohortEra, CohortStats>>;
  /** Delta of currentEra metrics minus LEGACY_PRE_ROUTING metrics, where present. */
  currentEraVsLegacyDelta: CohortDelta | null;
  notes: string[];
}

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return r4(xs.reduce((s, v) => s + v, 0) / xs.length);
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

function buildCohort(era: CohortEra, positions: ShadowPosition[]): CohortStats {
  const closed = positions.flatMap(closedVariantsOf);
  const open = positions.flatMap(openVariantsOf).length;
  const noFill = positions.reduce((s, p) => s + noFillCountOf(p), 0);

  const expectedNets = positions
    .map((p) => p.variantSelection?.expectedNetR ?? null)
    .filter((v): v is number => v !== null);
  const calibratedNets = positions
    .map((p) => p.variantSelection?.calibratedExpectedNetR ?? null)
    .filter((v): v is number => typeof v === "number");
  const realizedNets = closed.map((v) => v.realizedNetR);

  const winners = closed.filter((v) => v.realizedNetR > 0);
  const losers = closed.filter((v) => v.realizedNetR < 0);
  const lossMag = Math.abs(losers.reduce((s, v) => s + v.realizedNetR, 0));
  const profitFactor =
    lossMag === 0 ? null : r4(winners.reduce((s, v) => s + v.realizedNetR, 0) / lossMag);

  const allVariants = positions.flatMap((p) => p.variants);
  const tp1HitAll = allVariants.filter((v) => v.tp1Hit);
  const tp1Rate = allVariants.length === 0 ? null : r4(tp1HitAll.length / allVariants.length);

  const closedTp1 = closed.filter((v) => v.tp1Hit);
  const profitableTp1Rate =
    closedTp1.length === 0
      ? null
      : r4(closedTp1.filter((v) => v.realizedNetR > 0).length / closedTp1.length);

  const slCount = closed.filter((v) => v.closeReason === "SL" || v.closeReason === "BREAKEVEN").length;
  const slRate = closed.length === 0 ? null : r4(slCount / closed.length);

  // Per-combo (entry+exit) aggregation
  const comboMap = new Map<string, number[]>();
  for (const p of positions) {
    const entry = p.variantSelection?.selectedEntryVariant ?? p.selectedEntryVariant ?? "unknown";
    const exit = p.variantSelection?.selectedExitVariant ?? p.selectedExitVariant ?? "unknown";
    const key = `combo:${entry}__${exit}`;
    const closedR = closedVariantsOf(p).map((v) => v.realizedNetR);
    if (closedR.length === 0) continue;
    const arr = comboMap.get(key) ?? [];
    arr.push(...closedR);
    comboMap.set(key, arr);
  }
  const comboRows: CohortRow[] = [];
  for (const [key, rs] of comboMap) {
    comboRows.push({ key, count: rs.length, netAvgR: mean(rs) });
  }
  comboRows.sort((a, b) => (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity));
  const topEntryExitCombos = comboRows.filter((c) => c.count >= 3).slice(0, 5);
  const worstEntryExitCombos = [...comboRows]
    .filter((c) => c.count >= 3)
    .sort((a, b) => (a.netAvgR ?? Infinity) - (b.netAvgR ?? Infinity))
    .slice(0, 5);

  // Per-symbol
  const symbolMap = new Map<string, number[]>();
  for (const p of positions) {
    const closedR = closedVariantsOf(p).map((v) => v.realizedNetR);
    if (closedR.length === 0) continue;
    const arr = symbolMap.get(p.symbol) ?? [];
    arr.push(...closedR);
    symbolMap.set(p.symbol, arr);
  }
  const symbolRows: CohortRow[] = [];
  for (const [sym, rs] of symbolMap) {
    symbolRows.push({ key: `symbol:${sym}`, count: rs.length, netAvgR: mean(rs) });
  }
  symbolRows.sort((a, b) => (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity));
  const topSymbols = symbolRows.filter((s) => s.count >= 3).slice(0, 5);
  const worstSymbols = [...symbolRows]
    .filter((s) => s.count >= 3)
    .sort((a, b) => (a.netAvgR ?? Infinity) - (b.netAvgR ?? Infinity))
    .slice(0, 5);

  // Route mode distribution
  const routeModeDistribution = {
    PROFIT_CANDIDATE: 0,
    DATA_COLLECTION: 0,
    RESEARCH_ONLY: 0,
    UNKNOWN: 0,
  };
  for (const p of positions) {
    const mode = p.variantSelection?.routeMode;
    if (mode === "PROFIT_CANDIDATE" || mode === "DATA_COLLECTION" || mode === "RESEARCH_ONLY") {
      routeModeDistribution[mode] += 1;
    } else {
      routeModeDistribution.UNKNOWN += 1;
    }
  }

  // Diagnosis summary — count occurrences of each calibration diagnosis code
  const diagnosisSummary: Record<string, number> = {};
  for (const p of positions) {
    const codes = p.variantSelection?.calibrationDiagnosisCodes ?? [];
    for (const c of codes) {
      diagnosisSummary[c] = (diagnosisSummary[c] ?? 0) + 1;
    }
  }

  return {
    era,
    totalIdeas: positions.length,
    closedCount: closed.length,
    openCount: open,
    noFillCount: noFill,
    avgExpectedNetR: mean(expectedNets),
    avgCalibratedExpectedNetR: mean(calibratedNets),
    avgRealizedNetR: mean(realizedNets),
    profitFactor,
    winRate: closed.length === 0 ? null : r4(winners.length / closed.length),
    tp1Rate,
    profitableTp1Rate,
    slRate,
    avgWinR: winners.length === 0 ? null : mean(winners.map((v) => v.realizedNetR)),
    avgLossR: losers.length === 0 ? null : mean(losers.map((v) => v.realizedNetR)),
    topEntryExitCombos,
    worstEntryExitCombos,
    topSymbols,
    worstSymbols,
    routeModeDistribution,
    diagnosisSummary,
  };
}

function safeDelta(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return r4(a - b);
}

export interface CohortPerformanceInput {
  positions: ShadowPosition[];
}

export function buildCohortPerformanceReport(
  input: CohortPerformanceInput,
  now: Date = new Date(),
): CohortPerformanceReport {
  // Bucket positions by era (read-only inference)
  const buckets = new Map<CohortEra, ShadowPosition[]>();
  for (const p of input.positions) {
    const era = classifyEvidenceEra(p);
    const arr = buckets.get(era) ?? [];
    arr.push(p);
    buckets.set(era, arr);
  }

  const byEra: Partial<Record<CohortEra, CohortStats>> = {};
  for (const [era, ps] of buckets) {
    byEra[era] = buildCohort(era, ps);
  }

  const current = byEra[CURRENT_EVIDENCE_ERA];
  const legacy = byEra["LEGACY_PRE_ROUTING"];
  const currentEraVsLegacyDelta: CohortDelta | null =
    current && legacy
      ? {
          netAvgRDelta: safeDelta(current.avgRealizedNetR, legacy.avgRealizedNetR),
          profitFactorDelta: safeDelta(current.profitFactor, legacy.profitFactor),
          slRateDelta: safeDelta(current.slRate, legacy.slRate),
          overestimationErrorDelta: (() => {
            const cErr =
              current.avgExpectedNetR !== null && current.avgRealizedNetR !== null
                ? current.avgExpectedNetR - current.avgRealizedNetR
                : null;
            const lErr =
              legacy.avgExpectedNetR !== null && legacy.avgRealizedNetR !== null
                ? legacy.avgExpectedNetR - legacy.avgRealizedNetR
                : null;
            return safeDelta(cErr, lErr);
          })(),
        }
      : null;

  return {
    generatedAt: now.toISOString(),
    currentEra: CURRENT_EVIDENCE_ERA,
    byEra,
    currentEraVsLegacyDelta,
    notes: [
      "Era classification is deterministic and read-only. No historical record is mutated.",
      "Legacy/calibration eras are audit-only. POST_END_TO_END_CORRECTNESS_FIX_V1 is the current decision policy.",
      "Reporting only — does not change routing, scanner, shadow execution, or live readiness.",
    ],
  };
}

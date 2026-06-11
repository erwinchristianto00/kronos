/**
 * CONDITIONAL ALPHA STABILITY MONITOR (Reporting-only)
 *
 * Tracks whether WHALE_AGREES and WHALE_AGREES + NO_HORIZON_CONFLICT filters
 * on the BEARISH_EXPANSION+SHORT BASE cohort are becoming temporally and
 * symbol-concentration stable.
 *
 * Does NOT change:
 *   - scanner ranking / Top-10 selection
 *   - opportunity / confidence / danger / edge scoring
 *   - routeMode decisions, variant selection, or promotion logic
 *   - shadow fill, close, cost, or calibration logic
 *   - live readiness, symbol quarantine, trade caps
 *   - stop / TP geometry or universe rotation
 *   - adaptive gate readiness thresholds
 */

import type { StrategyExperienceRecord } from "@dtc/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConditionalAlphaStabilityStatus =
  | "PROMISING_BUT_RECENCY_CONCENTRATED"
  | "PROMISING_BUT_SYMBOL_CONCENTRATED"
  | "PROMISING_STABILIZING"
  | "TOO_EARLY_OR_UNCLEAR";

export interface ConditionalAlphaStabilityEntry {
  filterLabel: string;
  n: number;
  netAvgR: number;
  deltaNetAvgR: number;
  earlyHalfNetAvgR: number;
  lateHalfNetAvgR: number;
  top1SymbolNetSumShare: number;
  /** Top-2 symbol share using signed total netSumR as denominator. Used for status classification. */
  top2SignedNetSumShare: number;
  /**
   * Top-2 symbol share using positive-only netSumR as denominator.
   * Numerator = combined positive netSumR from the top-2 positive-contributing symbols.
   * Denominator = sum of all positive symbol netSumR contributions.
   * null when no symbol has a positive netSumR.
   */
  top2PositiveNetSumShare: number | null;
  positiveContributorCount: number;
  negativeContributorCount: number;
  status: ConditionalAlphaStabilityStatus;
}

export interface ConditionalAlphaStabilityReport {
  baseN: number;
  baseNetAvgR: number;
  entries: ConditionalAlphaStabilityEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function avgNetR(records: StrategyExperienceRecord[]): number {
  if (records.length === 0) return 0;
  const vals = records
    .map((r) => r.outcome.realizedNetR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return 0;
  return r4(vals.reduce((sum, v) => sum + v, 0) / vals.length);
}

function netSumR(records: StrategyExperienceRecord[]): number {
  const vals = records
    .map((r) => r.outcome.realizedNetR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return vals.reduce((sum, v) => sum + v, 0);
}

// ─── BASE cohort predicate ─────────────────────────────────────────────────

function isBearishShort(rec: StrategyExperienceRecord): boolean {
  const regime = rec.context.marketRegime;
  if (regime === null || regime === undefined || regime === "") return false;
  const s = String(regime).toUpperCase();
  const isBearish = s.includes("BEAR");
  return isBearish && rec.context.direction === "SHORT";
}

// ─── Filter predicates ─────────────────────────────────────────────────────

function isWhaleAgrees(rec: StrategyExperienceRecord): boolean {
  return rec.context.whaleAgreement === "AGREES";
}

function isNoHorizonConflict(rec: StrategyExperienceRecord): boolean {
  return rec.context.horizonConflict === false;
}

// ─── Symbol concentration metrics ─────────────────────────────────────────

interface SymbolContributionMetrics {
  top1Share: number;
  top2SignedShare: number;
  top2PositiveShare: number | null;
  positiveContributorCount: number;
  negativeContributorCount: number;
}

function computeSymbolConcentration(records: StrategyExperienceRecord[]): SymbolContributionMetrics {
  if (records.length === 0) {
    return {
      top1Share: 1.0,
      top2SignedShare: 1.0,
      top2PositiveShare: null,
      positiveContributorCount: 0,
      negativeContributorCount: 0,
    };
  }

  // Group by symbol
  const bySymbol = new Map<string, StrategyExperienceRecord[]>();
  for (const rec of records) {
    const sym = rec.context.symbol;
    const list = bySymbol.get(sym) ?? [];
    list.push(rec);
    bySymbol.set(sym, list);
  }

  // Compute netSumR per symbol
  const symbolSums: Array<{ symbol: string; netSum: number }> = [];
  for (const [symbol, recs] of bySymbol) {
    symbolSums.push({ symbol, netSum: netSumR(recs) });
  }

  const positiveContributorCount = symbolSums.filter((s) => s.netSum > 0).length;
  const negativeContributorCount = symbolSums.filter((s) => s.netSum < 0).length;

  const totalSignedNetSum = symbolSums.reduce((sum, s) => sum + s.netSum, 0);

  // Sort by netSum descending to find top contributors
  const sortedBySigned = [...symbolSums].sort((a, b) => b.netSum - a.netSum);
  const top1Sum = sortedBySigned[0]?.netSum ?? 0;
  const top2Sum = (sortedBySigned[0]?.netSum ?? 0) + (sortedBySigned[1]?.netSum ?? 0);

  // Signed-share: if total netSumR <= 0, degenerate → 1.0
  const top2SignedShare: number = totalSignedNetSum <= 0
    ? 1.0
    : r4(top2Sum / totalSignedNetSum);
  const top1Share: number = totalSignedNetSum <= 0
    ? 1.0
    : r4(top1Sum / totalSignedNetSum);

  // Positive-share: denominator = sum of positive-only symbol netSumR
  const positiveSymbols = symbolSums.filter((s) => s.netSum > 0);
  let top2PositiveShare: number | null = null;
  if (positiveSymbols.length > 0) {
    const totalPositiveNetSum = positiveSymbols.reduce((sum, s) => sum + s.netSum, 0);
    const sortedByPositive = [...positiveSymbols].sort((a, b) => b.netSum - a.netSum);
    const top1Positive = sortedByPositive[0]?.netSum ?? 0;
    const top2Positive = (sortedByPositive[0]?.netSum ?? 0) + (sortedByPositive[1]?.netSum ?? 0);
    top2PositiveShare = r4(Math.min(top2Positive, totalPositiveNetSum) / totalPositiveNetSum);
  }

  return {
    top1Share,
    top2SignedShare,
    top2PositiveShare,
    positiveContributorCount,
    negativeContributorCount,
  };
}

// ─── Status classifier ─────────────────────────────────────────────────────

const MIN_N_WHALE_AGREES = 50;
const MIN_N_WHALE_PLUS_NO_HC = 40;
const SYMBOL_CONCENTRATION_THRESHOLD = 0.75;

function classifyStabilityStatus(
  filterName: string,
  n: number,
  netAvgR: number,
  deltaNetAvgR: number,
  earlyHalfNetAvgR: number,
  lateHalfNetAvgR: number,
  top2SignedNetSumShare: number,
): ConditionalAlphaStabilityStatus {
  // Gate: both net and delta must be positive
  if (netAvgR <= 0 || deltaNetAvgR <= 0) {
    return "TOO_EARLY_OR_UNCLEAR";
  }

  // Recency concentration check (before symbol concentration)
  if (earlyHalfNetAvgR <= 0 && lateHalfNetAvgR > 0) {
    return "PROMISING_BUT_RECENCY_CONCENTRATED";
  }

  // Symbol concentration check (uses signed-share for conservatism)
  if (top2SignedNetSumShare >= SYMBOL_CONCENTRATION_THRESHOLD) {
    return "PROMISING_BUT_SYMBOL_CONCENTRATED";
  }

  // PROMISING_STABILIZING: all conditions met
  const minN = filterName === "WHALE_AGREES" ? MIN_N_WHALE_AGREES : MIN_N_WHALE_PLUS_NO_HC;
  if (
    netAvgR > 0 &&
    deltaNetAvgR > 0 &&
    earlyHalfNetAvgR > 0 &&
    lateHalfNetAvgR > 0 &&
    top2SignedNetSumShare < SYMBOL_CONCENTRATION_THRESHOLD &&
    n >= minN
  ) {
    return "PROMISING_STABILIZING";
  }

  return "TOO_EARLY_OR_UNCLEAR";
}

// ─── Per-filter entry builder ──────────────────────────────────────────────

function buildFilterEntry(
  filterLabel: string,
  cohort: StrategyExperienceRecord[],
  baseNetAvgR: number,
): ConditionalAlphaStabilityEntry {
  const n = cohort.length;

  if (n === 0) {
    return {
      filterLabel,
      n: 0,
      netAvgR: 0,
      deltaNetAvgR: -baseNetAvgR,
      earlyHalfNetAvgR: 0,
      lateHalfNetAvgR: 0,
      top1SymbolNetSumShare: 1.0,
      top2SignedNetSumShare: 1.0,
      top2PositiveNetSumShare: null,
      positiveContributorCount: 0,
      negativeContributorCount: 0,
      status: "TOO_EARLY_OR_UNCLEAR",
    };
  }

  // Sort by openedAt for temporal split
  const sorted = [...cohort].sort((a, b) => {
    const ta = a.outcome.openedAt ?? "";
    const tb = b.outcome.openedAt ?? "";
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  const earlyCount = Math.ceil(n / 2);
  const earlyHalf = sorted.slice(0, earlyCount);
  const lateHalf = sorted.slice(earlyCount);

  const netAvgRVal = avgNetR(cohort);
  const deltaNetAvgRVal = r4(netAvgRVal - baseNetAvgR);
  const earlyHalfNetAvgRVal = avgNetR(earlyHalf);
  const lateHalfNetAvgRVal = avgNetR(lateHalf);

  const { top1Share, top2SignedShare, top2PositiveShare, positiveContributorCount, negativeContributorCount } =
    computeSymbolConcentration(cohort);

  const status = classifyStabilityStatus(
    filterLabel,
    n,
    netAvgRVal,
    deltaNetAvgRVal,
    earlyHalfNetAvgRVal,
    lateHalfNetAvgRVal,
    top2SignedShare,
  );

  return {
    filterLabel,
    n,
    netAvgR: netAvgRVal,
    deltaNetAvgR: deltaNetAvgRVal,
    earlyHalfNetAvgR: earlyHalfNetAvgRVal,
    lateHalfNetAvgR: lateHalfNetAvgRVal,
    top1SymbolNetSumShare: top1Share,
    top2SignedNetSumShare: top2SignedShare,
    top2PositiveNetSumShare: top2PositiveShare,
    positiveContributorCount,
    negativeContributorCount,
    status,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute the conditional alpha stability report from a set of
 * StrategyExperienceRecords. Input should already be era-filtered
 * (POST_CALIBRATION) by the caller.
 *
 * This function is read-only and advisory. It does not influence any
 * trading behavior, gate readiness, or strategy logic.
 */
export function computeConditionalAlphaStability(
  records: StrategyExperienceRecord[],
): ConditionalAlphaStabilityReport {
  // BASE cohort: BEARISH_EXPANSION + SHORT (all routes)
  const base = records.filter(isBearishShort);
  const baseN = base.length;
  const baseNetAvgRVal = avgNetR(base);

  // Filter A: BASE + whaleAgreement=AGREES
  const filterA = base.filter(isWhaleAgrees);

  // Filter B: BASE + whaleAgreement=AGREES + horizonConflict=false
  const filterB = filterA.filter(isNoHorizonConflict);

  return {
    baseN,
    baseNetAvgR: baseNetAvgRVal,
    entries: [
      buildFilterEntry("WHALE_AGREES", filterA, baseNetAvgRVal),
      buildFilterEntry("WHALE_AGREES + NO_HC", filterB, baseNetAvgRVal),
    ],
  };
}

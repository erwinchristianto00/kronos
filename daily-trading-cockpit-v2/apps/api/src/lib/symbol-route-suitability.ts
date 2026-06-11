import type { StrategyExperienceRecord } from "@dtc/shared";
import {
  computeSignalMultiplicity,
  isEarlyPromisingBlocked,
  type SignalMultiplicitySummary,
} from "./signal-multiplicity-guardrail.js";

/**
 * SYMBOL–ROUTE SUITABILITY INTELLIGENCE (Phase 2B.1)
 *
 * Read-only advisory engine that estimates, per (symbol, direction) pair, which
 * (entryVariant, exitVariant) route currently appears most suitable based on
 * resolved StrategyExperienceRecord history. The engine produces:
 *
 *   - Per-cohort assessments (symbol + direction + route)
 *   - Per (symbol, direction) summary picking the best advisory route
 *   - Per-route heterogeneity scan (does a route work everywhere, nowhere, or only on some symbols?)
 *   - A readiness block that is ALWAYS readyForRoutingInfluence = false in 2B.1
 *
 * Does NOT change:
 *   - scanner ranking / Top-10 selection
 *   - opportunity / confidence / danger scoring
 *   - routeMode decisions or variant selection
 *   - shadow fill, close, cost, or calibration logic
 *   - live readiness, symbol quarantine, trade caps
 *   - stop / TP geometry or universe rotation
 *
 * The output is intended for human review only.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SuitabilityEvidenceEra = "POST_CALIBRATION" | "ALL_TIME";

export type SampleTier = "EMPTY" | "TOO_EARLY" | "EARLY" | "WATCHABLE" | "EVALUABLE";

export type ConfidenceTier = "LOW" | "MEDIUM" | "HIGH";

export type LocalVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "TOO_EARLY_POSITIVE"
  | "TOO_EARLY_NEGATIVE"
  | "EARLY_PROMISING"
  | "EARLY_TOXIC"
  | "WATCHABLE_PROMISING"
  | "WATCHABLE_WEAK"
  | "EVALUABLE_PROMISING"
  | "EVALUABLE_TOXIC"
  | "MIXED";

export type SymbolDirectionVerdict =
  | "NO_PROVEN_ROUTE"
  | "ONE_EARLY_PROMISING"
  | "ROUTE_DISAGREEMENT"
  | "MOSTLY_NEGATIVE"
  | "INSUFFICIENT_EVIDENCE";

export type RouteHeterogeneityVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "BROADLY_PROMISING"
  | "BROADLY_WEAK"
  | "SYMBOL_SENSITIVE"
  | "MIXED_EARLY";

export interface SymbolRouteCandidateAssessment {
  symbol: string;
  direction: "LONG" | "SHORT";
  selectedEntryVariant: string | null;
  selectedExitVariant: string | null;
  routeCombo: string;
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
  sampleTier: SampleTier;
  rawPerformanceScore: number;
  sampleWeight: number;
  localSuitabilityScore: number;
  confidenceTier: ConfidenceTier;
  localVerdict: LocalVerdict;
  reasons: string[];
  /** Raw sample count (same as closedCount). */
  nRaw: number;
  /** Distinct independent signals after deduplication by time+price bucket. */
  nEffective: number;
  /** nEffective / nRaw (1.0 when nRaw=0). */
  multiplicityRatio: number;
  /** True when nRaw>=3 and nEffective/nRaw < 0.50. */
  signalMultiplicityWarning: boolean;
  /**
   * True when this cohort is blocked from EARLY_PROMISING due to signal
   * multiplicity warning OR all records being RAW_EDGE_NOT_VALIDATED.
   * Populated from isEarlyPromisingBlocked(); stored here so callers
   * can filter without re-computing the guardrail logic.
   */
  earlyPromisingBlocked: boolean;
}

export interface SymbolDirectionSuitabilitySummary {
  symbol: string;
  direction: "LONG" | "SHORT";
  observedRouteCount: number;
  totalClosedCount: number;
  bestAdvisoryRoute: SymbolRouteCandidateAssessment | null;
  alternativeRoutes: SymbolRouteCandidateAssessment[];
  localEvidenceVerdict: SymbolDirectionVerdict;
}

export interface RouteHeterogeneityAssessment {
  routeCombo: string;
  selectedEntryVariant: string | null;
  selectedExitVariant: string | null;
  meaningfulSliceCount: number;
  positiveSliceCount: number;
  negativeSliceCount: number;
  neutralSliceCount: number;
  strongestPositiveSlice: {
    symbol: string;
    direction: "LONG" | "SHORT";
    closedCount: number;
    netAvgR: number;
  } | null;
  strongestNegativeSlice: {
    symbol: string;
    direction: "LONG" | "SHORT";
    closedCount: number;
    netAvgR: number;
  } | null;
  verdict: RouteHeterogeneityVerdict;
}

export interface SymbolRouteSuitabilityReadiness {
  advisoryEngineReady: boolean;
  readyForRoutingInfluence: boolean;
  reasons: string[];
}

export interface SymbolRouteSuitabilityReport {
  generatedAt: string;
  evidenceEra: SuitabilityEvidenceEra;
  metadata: {
    resolvedExperienceRecordCount: number;
    symbolDirectionPairCount: number;
    /** Raw-count-based pair thresholds (for backward compatibility). */
    pairsWithAtLeast5Closes: number;
    pairsWithAtLeast15Closes: number;
    pairsWithAtLeast30Closes: number;
    /** Effective-n-based pair thresholds (deduplicated signal count). */
    pairsWithAtLeast5ClosesEffective: number;
    pairsWithAtLeast15ClosesEffective: number;
    pairsWithAtLeast30ClosesEffective: number;
  };
  candidateAssessments: SymbolRouteCandidateAssessment[];
  symbolDirectionSummaries: SymbolDirectionSuitabilitySummary[];
  routeHeterogeneity: RouteHeterogeneityAssessment[];
  topPromisingCohorts: SymbolRouteCandidateAssessment[];
  topToxicCohorts: SymbolRouteCandidateAssessment[];
  /**
   * The credibility-blocked cohort with the highest raw netAvgR, if any.
   * Shown separately in the dashboard as a raw-return leader with a
   * "credibility warning: multiplicity" annotation. Null when no
   * credibility-blocked cohort has a positive netAvgR.
   */
  highestRawReturnMultiplicityFlaggedCohort: SymbolRouteCandidateAssessment | null;
  readiness: SymbolRouteSuitabilityReadiness;
  notes: string[];
}

export interface SymbolRouteSuitabilityInput {
  evidenceEra?: SuitabilityEvidenceEra;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function avgFinite(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return r4(finite.reduce((sum, v) => sum + v, 0) / finite.length);
}

function routeComboLabel(entry: string | null | undefined, exit: string | null | undefined): string {
  return `${entry ?? "UNKNOWN_ENTRY"} + ${exit ?? "UNKNOWN_EXIT"}`;
}

/**
 * Sample tier boundaries — 0=EMPTY, 1–4=TOO_EARLY, 5–14=EARLY, 15–29=WATCHABLE, 30+=EVALUABLE.
 * Chosen so verdict transitions match the conservative thresholds in the verdict rules below.
 */
function classifySampleTier(count: number): SampleTier {
  if (count <= 0) return "EMPTY";
  if (count < 5) return "TOO_EARLY";
  if (count < 15) return "EARLY";
  if (count < 30) return "WATCHABLE";
  return "EVALUABLE";
}

function sampleWeightOf(tier: SampleTier): number {
  switch (tier) {
    case "EMPTY": return 0;
    case "TOO_EARLY": return 0.2;
    case "EARLY": return 0.4;
    case "WATCHABLE": return 0.7;
    case "EVALUABLE": return 1.0;
  }
}

function confidenceTierOf(tier: SampleTier): ConfidenceTier {
  if (tier === "EMPTY" || tier === "TOO_EARLY") return "LOW";
  if (tier === "EVALUABLE") return "HIGH";
  return "MEDIUM";
}

function profitFactorOf(records: StrategyExperienceRecord[]): number | null {
  const netRs = records.map((r) => r.outcome.realizedNetR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const winSum = netRs.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const lossAbs = Math.abs(netRs.filter((v) => v < 0).reduce((sum, v) => sum + v, 0));
  if (lossAbs === 0) return winSum > 0 ? null : null;
  return r4(winSum / lossAbs);
}

/**
 * rawPerformanceScore (0–100) blends five normalized signals into an explainable,
 * monotonic score: netAvgR (capped at ±0.6 → ±30 pts), PF proximity to/above 1.2
 * (0–25 pts), tp1ProfitableRate above 0.55 (0–15 pts), slRate below 0.40 (0–15 pts),
 * and win/loss asymmetry avgWinR/|avgLossR| (0–15 pts). 50 is neutral.
 */
function rawPerformanceScoreOf(input: {
  netAvgR: number | null;
  profitFactor: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
}): number {
  // netAvgR contribution: ±0.6R → ±30pts around 50
  let score = 50;
  if (input.netAvgR !== null) {
    const capped = Math.max(-0.6, Math.min(0.6, input.netAvgR));
    score += (capped / 0.6) * 30;
  }
  // profit factor: 1.0 neutral, 1.2 baseline good, scale up to +25 at PF=3.0; PF<1 subtracts
  if (input.profitFactor !== null) {
    const pf = input.profitFactor;
    if (pf >= 1.2) {
      score += Math.min(25, ((pf - 1.2) / 1.8) * 25);
    } else if (pf < 1.0) {
      score -= Math.min(25, ((1.0 - pf) / 1.0) * 25);
    }
    // 1.0–1.2 = neutral band
  }
  // tp1ProfitableRate: 0.55 baseline → +15 at 1.0, -10 at 0
  if (input.tp1ProfitableRate !== null) {
    if (input.tp1ProfitableRate >= 0.55) {
      score += ((input.tp1ProfitableRate - 0.55) / 0.45) * 15;
    } else {
      score -= ((0.55 - input.tp1ProfitableRate) / 0.55) * 10;
    }
  }
  // slRate: 0.40 baseline → reward below, penalize above (+15 to -15)
  if (input.slRate !== null) {
    if (input.slRate <= 0.40) {
      score += ((0.40 - input.slRate) / 0.40) * 15;
    } else {
      score -= ((input.slRate - 0.40) / 0.60) * 15;
    }
  }
  // win/loss asymmetry: ratio = avgWinR / |avgLossR|; 1.0 neutral, 2.0 → +15, 0.5 → -15
  if (input.avgWinR !== null && input.avgLossR !== null && input.avgLossR < 0) {
    const ratio = input.avgWinR / Math.abs(input.avgLossR);
    if (ratio >= 1) {
      score += Math.min(15, ((ratio - 1) / 1) * 15);
    } else {
      score -= Math.min(15, ((1 - ratio) / 1) * 15);
    }
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Local verdict rules — conservative ladder keyed on sample tier and netAvgR/PF/slRate.
 * Only EVALUABLE_PROMISING (30+ closes, netAvgR>0.15, PF>1.2) is "confirmed promising".
 * EARLY and WATCHABLE flag direction but require more data for promotion to 2B.2.
 *
 * earlyPromisingBlocked: when true, EARLY_PROMISING is suppressed (returns MIXED).
 * This is set when signalMultiplicityWarning is true OR all records are RAW_EDGE_NOT_VALIDATED.
 * The effective-n threshold also applies: nEffective must meet the same threshold as count.
 */
function localVerdictOf(
  count: number,
  netAvgR: number | null,
  profitFactor: number | null,
  slRate: number | null,
  earlyPromisingBlocked = false,
  nEffective = count,
): LocalVerdict {
  if (count === 0 || netAvgR === null) return "INSUFFICIENT_EVIDENCE";
  if (count < 5) return netAvgR > 0 ? "TOO_EARLY_POSITIVE" : "TOO_EARLY_NEGATIVE";
  const pf = profitFactor ?? 0;
  const sl = slRate ?? 0;
  if (count < 15) {
    // Require nEffective >= 5 threshold and no multiplicity warning
    if (!earlyPromisingBlocked && nEffective >= 5 && netAvgR > 0.10 && pf > 1.0) return "EARLY_PROMISING";
    if (netAvgR < -0.10 || sl > 0.6) return "EARLY_TOXIC";
    return "MIXED";
  }
  if (count < 30) {
    if (netAvgR > 0.15 && pf > 1.2 && sl < 0.40) return "WATCHABLE_PROMISING";
    if (netAvgR < -0.15 || pf < 0.5) return "WATCHABLE_WEAK";
    return "MIXED";
  }
  if (netAvgR > 0.15 && pf > 1.2) return "EVALUABLE_PROMISING";
  if (netAvgR < -0.15 || pf < 0.5) return "EVALUABLE_TOXIC";
  return "MIXED";
}

function reasonsFor(c: SymbolRouteCandidateAssessment): string[] {
  const out: string[] = [];
  if (c.closedCount === 0) {
    out.push("No closed trades for this cohort yet.");
    return out;
  }
  if (c.netAvgR !== null) out.push(`Net avg R: ${c.netAvgR.toFixed(4)} over ${c.closedCount} closes.`);
  if (c.profitFactor !== null) out.push(`Profit factor: ${c.profitFactor.toFixed(2)} (>1.2 = baseline good).`);
  if (c.tp1ProfitableRate !== null) out.push(`TP1-profitable rate: ${(c.tp1ProfitableRate * 100).toFixed(0)}% (baseline 55%).`);
  if (c.slRate !== null) out.push(`SL rate: ${(c.slRate * 100).toFixed(0)}% (baseline 40%).`);
  if (c.sampleTier === "TOO_EARLY" || c.sampleTier === "EARLY") {
    out.push("Sample is below 15 closes — directional signal only, not confirmation-grade.");
  } else if (c.sampleTier === "EVALUABLE") {
    out.push("Sample is 30+ closes — verdict is confirmation-grade.");
  }
  return out;
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function filterByEra(records: StrategyExperienceRecord[], era: SuitabilityEvidenceEra): StrategyExperienceRecord[] {
  if (era === "ALL_TIME") return records;
  return records.filter((r) => (r.context.evidenceEra ?? r.outcome.evidenceEra) === "POST_CALIBRATION");
}

// ─── Cohort assessment ────────────────────────────────────────────────────────

function buildCandidateAssessment(records: StrategyExperienceRecord[]): SymbolRouteCandidateAssessment {
  const first = records[0];
  const symbol = first.context.symbol;
  const direction = first.context.direction;
  const entry = first.context.selectedEntryVariant ?? first.outcome.selectedEntryVariant ?? null;
  const exit = first.context.selectedExitVariant ?? first.outcome.selectedExitVariant ?? null;

  const closedCount = records.length;
  const netRs = records.map((r) => r.outcome.realizedNetR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const winners = records.filter((r) => (r.outcome.realizedNetR ?? 0) > 0);
  const losers = records.filter((r) => (r.outcome.realizedNetR ?? 0) < 0);
  const netAvgR = avgFinite(netRs);
  const grossAvgR = avgFinite(records.map((r) => r.outcome.realizedGrossR));
  const winRate = closedCount > 0 ? r4(winners.length / closedCount) : null;
  const profitFactor = profitFactorOf(records);
  const slCount = records.filter((r) => r.outcome.slHit === true || r.outcome.closeReason === "SL" || r.outcome.closeReason === "BREAKEVEN").length;
  const slRate = closedCount > 0 ? r4(slCount / closedCount) : null;
  const tp1ProfitCount = records.filter((r) => r.outcome.tp1Hit === true && (r.outcome.realizedNetR ?? 0) > 0).length;
  const tp1ProfitableRate = closedCount > 0 ? r4(tp1ProfitCount / closedCount) : null;
  const avgWinR = avgFinite(winners.map((r) => r.outcome.realizedNetR));
  const avgLossR = avgFinite(losers.map((r) => r.outcome.realizedNetR));
  const avgMfeR = avgFinite(records.map((r) => r.outcome.maxFavorableExcursionR ?? r.outcome.mfeR));
  const avgMaeR = avgFinite(records.map((r) => r.outcome.maxAdverseExcursionR ?? r.outcome.maeR));

  const sampleTier = classifySampleTier(closedCount);
  const sampleWeight = sampleWeightOf(sampleTier);
  const rawPerformanceScore = rawPerformanceScoreOf({
    netAvgR, profitFactor, tp1ProfitableRate, slRate, avgWinR, avgLossR,
  });
  const localSuitabilityScore = Math.round(rawPerformanceScore * sampleWeight);
  const confidenceTier = confidenceTierOf(sampleTier);

  // Signal multiplicity guardrail
  const multiplicity: SignalMultiplicitySummary = computeSignalMultiplicity(records);
  const earlyPromisingBlocked = isEarlyPromisingBlocked(records, multiplicity);
  const localVerdict = localVerdictOf(
    closedCount,
    netAvgR,
    profitFactor,
    slRate,
    earlyPromisingBlocked,
    multiplicity.nEffective,
  );

  const assessment: SymbolRouteCandidateAssessment = {
    symbol,
    direction,
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    routeCombo: routeComboLabel(entry, exit),
    closedCount,
    netAvgR,
    grossAvgR,
    profitFactor,
    winRate,
    tp1ProfitableRate,
    slRate,
    avgWinR,
    avgLossR,
    avgMfeR,
    avgMaeR,
    sampleTier,
    rawPerformanceScore,
    sampleWeight,
    localSuitabilityScore,
    confidenceTier,
    localVerdict,
    reasons: [],
    nRaw: multiplicity.nRaw,
    nEffective: multiplicity.nEffective,
    multiplicityRatio: multiplicity.multiplicityRatio,
    signalMultiplicityWarning: multiplicity.signalMultiplicityWarning,
    earlyPromisingBlocked,
  };
  assessment.reasons = reasonsFor(assessment);
  return assessment;
}

// ─── Symbol-direction summary ─────────────────────────────────────────────────

function summarizeSymbolDirection(
  symbol: string,
  direction: "LONG" | "SHORT",
  routes: SymbolRouteCandidateAssessment[],
): SymbolDirectionSuitabilitySummary {
  const sorted = [...routes].sort((a, b) => b.localSuitabilityScore - a.localSuitabilityScore);
  const best = sorted[0] ?? null;
  const alternatives = sorted.slice(1, 3);
  const totalClosedCount = routes.reduce((sum, r) => sum + r.closedCount, 0);

  let verdict: SymbolDirectionVerdict;
  const meaningful = routes.filter((r) => r.closedCount >= 5);
  if (totalClosedCount === 0) {
    verdict = "INSUFFICIENT_EVIDENCE";
  } else if (meaningful.length === 0) {
    verdict = "INSUFFICIENT_EVIDENCE";
  } else {
    const promising = meaningful.filter((r) =>
      r.localVerdict === "EARLY_PROMISING" ||
      r.localVerdict === "WATCHABLE_PROMISING" ||
      r.localVerdict === "EVALUABLE_PROMISING",
    );
    const toxic = meaningful.filter((r) =>
      r.localVerdict === "EARLY_TOXIC" ||
      r.localVerdict === "WATCHABLE_WEAK" ||
      r.localVerdict === "EVALUABLE_TOXIC",
    );
    if (promising.length > 0 && toxic.length > 0) {
      verdict = "ROUTE_DISAGREEMENT";
    } else if (promising.length === 1 && meaningful.length >= 1 && toxic.length === 0) {
      verdict = "ONE_EARLY_PROMISING";
    } else if (toxic.length === meaningful.length) {
      verdict = "MOSTLY_NEGATIVE";
    } else if (promising.length === 0) {
      verdict = "NO_PROVEN_ROUTE";
    } else {
      verdict = "ONE_EARLY_PROMISING";
    }
  }

  return {
    symbol,
    direction,
    observedRouteCount: routes.length,
    totalClosedCount,
    bestAdvisoryRoute: best,
    alternativeRoutes: alternatives,
    localEvidenceVerdict: verdict,
  };
}

// ─── Route heterogeneity ──────────────────────────────────────────────────────

/**
 * Heterogeneity verdict — counts only slices with ≥5 closes ("meaningful").
 * INSUFFICIENT_EVIDENCE if <3 meaningful slices; BROADLY_PROMISING/WEAK at ≥70%
 * one-sided; SYMBOL_SENSITIVE if at least one positive and one negative slice
 * are both meaningful; otherwise MIXED_EARLY.
 */
function classifyHeterogeneity(
  positive: number,
  negative: number,
  meaningful: number,
): RouteHeterogeneityVerdict {
  if (meaningful < 3) return "INSUFFICIENT_EVIDENCE";
  if (positive / meaningful >= 0.7) return "BROADLY_PROMISING";
  if (negative / meaningful >= 0.7) return "BROADLY_WEAK";
  if (positive >= 1 && negative >= 1) return "SYMBOL_SENSITIVE";
  return "MIXED_EARLY";
}

function buildRouteHeterogeneity(candidates: SymbolRouteCandidateAssessment[]): RouteHeterogeneityAssessment[] {
  const groups = new Map<string, SymbolRouteCandidateAssessment[]>();
  for (const c of candidates) {
    const list = groups.get(c.routeCombo) ?? [];
    list.push(c);
    groups.set(c.routeCombo, list);
  }
  const out: RouteHeterogeneityAssessment[] = [];
  for (const [routeCombo, list] of groups) {
    const meaningful = list.filter((c) => c.closedCount >= 5);
    const positive = meaningful.filter((c) => (c.netAvgR ?? 0) > 0.05);
    const negative = meaningful.filter((c) => (c.netAvgR ?? 0) < -0.05);
    const neutral = meaningful.filter((c) => {
      const v = c.netAvgR ?? 0;
      return v >= -0.05 && v <= 0.05;
    });
    const strongestPositive = [...positive].sort((a, b) => (b.netAvgR ?? 0) - (a.netAvgR ?? 0))[0];
    const strongestNegative = [...negative].sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0))[0];
    const sample = list[0];
    out.push({
      routeCombo,
      selectedEntryVariant: sample?.selectedEntryVariant ?? null,
      selectedExitVariant: sample?.selectedExitVariant ?? null,
      meaningfulSliceCount: meaningful.length,
      positiveSliceCount: positive.length,
      negativeSliceCount: negative.length,
      neutralSliceCount: neutral.length,
      strongestPositiveSlice: strongestPositive
        ? { symbol: strongestPositive.symbol, direction: strongestPositive.direction, closedCount: strongestPositive.closedCount, netAvgR: strongestPositive.netAvgR ?? 0 }
        : null,
      strongestNegativeSlice: strongestNegative
        ? { symbol: strongestNegative.symbol, direction: strongestNegative.direction, closedCount: strongestNegative.closedCount, netAvgR: strongestNegative.netAvgR ?? 0 }
        : null,
      verdict: classifyHeterogeneity(positive.length, negative.length, meaningful.length),
    });
  }
  return out.sort((a, b) => b.meaningfulSliceCount - a.meaningfulSliceCount);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildSymbolRouteSuitabilityReport(
  records: StrategyExperienceRecord[],
  opts: SymbolRouteSuitabilityInput = {},
  now: Date = new Date(),
): SymbolRouteSuitabilityReport {
  const generatedAt = now.toISOString();
  const evidenceEra: SuitabilityEvidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const filtered = filterByEra(records, evidenceEra);

  // Group by (symbol, direction, entry, exit)
  const cohortGroups = new Map<string, StrategyExperienceRecord[]>();
  for (const rec of filtered) {
    const entry = rec.context.selectedEntryVariant ?? rec.outcome.selectedEntryVariant ?? "UNKNOWN_ENTRY";
    const exit = rec.context.selectedExitVariant ?? rec.outcome.selectedExitVariant ?? "UNKNOWN_EXIT";
    const key = [rec.context.symbol, rec.context.direction, entry, exit].join("|");
    const list = cohortGroups.get(key) ?? [];
    list.push(rec);
    cohortGroups.set(key, list);
  }
  const candidateAssessments: SymbolRouteCandidateAssessment[] = [];
  for (const list of cohortGroups.values()) {
    candidateAssessments.push(buildCandidateAssessment(list));
  }
  candidateAssessments.sort((a, b) => b.localSuitabilityScore - a.localSuitabilityScore);

  // Group by (symbol, direction)
  const sdGroups = new Map<string, SymbolRouteCandidateAssessment[]>();
  for (const c of candidateAssessments) {
    const key = `${c.symbol}|${c.direction}`;
    const list = sdGroups.get(key) ?? [];
    list.push(c);
    sdGroups.set(key, list);
  }
  const symbolDirectionSummaries: SymbolDirectionSuitabilitySummary[] = [];
  for (const [key, list] of sdGroups) {
    const [symbol, direction] = key.split("|") as [string, "LONG" | "SHORT"];
    symbolDirectionSummaries.push(summarizeSymbolDirection(symbol, direction, list));
  }
  symbolDirectionSummaries.sort((a, b) =>
    (b.bestAdvisoryRoute?.localSuitabilityScore ?? -1) - (a.bestAdvisoryRoute?.localSuitabilityScore ?? -1),
  );

  // Route heterogeneity
  const routeHeterogeneity = buildRouteHeterogeneity(candidateAssessments);

  // Top promising / toxic cohorts: require minimum 5 closes for the lists to be
  // meaningful; otherwise tiny samples dominate.
  const meaningful = candidateAssessments.filter((c) => c.closedCount >= 5);

  // Credibility-blocked cohorts (multiplicity warning OR all RAW_EDGE_NOT_VALIDATED)
  // must NOT appear as "Top promising cohort". They may appear under the separate
  // "highest raw-return multiplicity-flagged cohort" label.
  const topPromisingCohorts = [...meaningful]
    .filter((c) => (c.netAvgR ?? 0) > 0 && !c.earlyPromisingBlocked)
    .sort((a, b) => b.localSuitabilityScore - a.localSuitabilityScore)
    .slice(0, 5);
  const topToxicCohorts = [...meaningful]
    .filter((c) => (c.netAvgR ?? 0) < 0)
    .sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0))
    .slice(0, 5);

  // Highest raw-return cohort among credibility-blocked candidates (Issue 3).
  // Displayed separately with an explicit credibility warning — never under "Top promising".
  const highestRawReturnMultiplicityFlaggedCohort = [...meaningful]
    .filter((c) => c.earlyPromisingBlocked && (c.netAvgR ?? 0) > 0)
    .sort((a, b) => (b.netAvgR ?? 0) - (a.netAvgR ?? 0))[0] ?? null;

  // Metadata counts — raw (backward compat) and effective-n based (Issue 2).
  // Raw counts use closedCount sums; effective-n counts use nEffective sums per pair.
  const pairRawTotals = new Map<string, number>();
  const pairEffTotals = new Map<string, number>();
  for (const c of candidateAssessments) {
    const key = `${c.symbol}|${c.direction}`;
    pairRawTotals.set(key, (pairRawTotals.get(key) ?? 0) + c.closedCount);
    pairEffTotals.set(key, (pairEffTotals.get(key) ?? 0) + c.nEffective);
  }
  const pairsWithAtLeast5Closes = [...pairRawTotals.values()].filter((n) => n >= 5).length;
  const pairsWithAtLeast15Closes = [...pairRawTotals.values()].filter((n) => n >= 15).length;
  const pairsWithAtLeast30Closes = [...pairRawTotals.values()].filter((n) => n >= 30).length;
  const pairsWithAtLeast5ClosesEffective = [...pairEffTotals.values()].filter((n) => n >= 5).length;
  const pairsWithAtLeast15ClosesEffective = [...pairEffTotals.values()].filter((n) => n >= 15).length;
  const pairsWithAtLeast30ClosesEffective = [...pairEffTotals.values()].filter((n) => n >= 30).length;

  // Readiness — ALWAYS readyForRoutingInfluence = false in Phase 2B.1.
  const readinessReasons: string[] = [
    "Phase 2B.1 is advisory-only — this engine does not influence ranking, routing, or execution.",
  ];
  if (pairsWithAtLeast30ClosesEffective < 3) {
    readinessReasons.push(`Need ≥30 effective closes per cohort across ≥3 symbol-direction pairs (currently ${pairsWithAtLeast30ClosesEffective}).`);
  }
  readinessReasons.push("Need stable recent performance and corroboration from market-regime evidence before routing promotion.");
  const readiness: SymbolRouteSuitabilityReadiness = {
    advisoryEngineReady: true,
    readyForRoutingInfluence: false,
    reasons: readinessReasons,
  };

  return {
    generatedAt,
    evidenceEra,
    metadata: {
      resolvedExperienceRecordCount: filtered.length,
      symbolDirectionPairCount: sdGroups.size,
      pairsWithAtLeast5Closes,
      pairsWithAtLeast15Closes,
      pairsWithAtLeast30Closes,
      pairsWithAtLeast5ClosesEffective,
      pairsWithAtLeast15ClosesEffective,
      pairsWithAtLeast30ClosesEffective,
    },
    candidateAssessments,
    symbolDirectionSummaries,
    routeHeterogeneity,
    topPromisingCohorts,
    topToxicCohorts,
    highestRawReturnMultiplicityFlaggedCohort,
    readiness,
    notes: [
      "Symbol-Route Suitability Intelligence is read-only and advisory. It does not change ranking, routing, execution, live readiness, stop/TP behavior, or universe rotation.",
      "Sample tiers: EMPTY=0, TOO_EARLY=1–4, EARLY=5–14, WATCHABLE=15–29, EVALUABLE=30+ closes.",
      "Suitability score = rawPerformanceScore (0–100) × sampleWeight (0–1). Confidence tier follows sample tier.",
      "Route heterogeneity uses only slices with ≥5 closes. SYMBOL_SENSITIVE means at least one positive and one negative meaningful slice exist for the same route.",
      "Only EVALUABLE_PROMISING (≥30 closes, netAvgR>0.15, PF>1.2) is confirmation-grade. Other promising verdicts are directional only.",
      "topPromisingCohorts excludes credibility-blocked cohorts (signalMultiplicityWarning=true OR all records RAW_EDGE_NOT_VALIDATED). Blocked cohorts with positive netAvgR appear under highestRawReturnMultiplicityFlaggedCohort only.",
      "pairs >=5/>=15/>=30 counts are shown in both raw and effective-n bases. Effective-n counts deduplicate signals sharing the same 15-min time bucket and 5-bps price bucket.",
    ],
  };
}

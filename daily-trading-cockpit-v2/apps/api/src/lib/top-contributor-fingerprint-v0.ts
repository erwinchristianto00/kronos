/**
 * TOP-CONTRIBUTOR FINGERPRINT V0 (Reporting-only, advisory)
 *
 * Derives a "top contributor" fingerprint profile from the audit's discriminative
 * features (stopDistanceBps, entryDriftPctOfZone, with supporting chaseRisk and
 * entryDriftAtr) on the BASE cohort:
 *   POST_CALIBRATION + BEAR-regime + SHORT + vwap_retest_entry + tp1_full_exit
 *   intersected with WHALE_AGREES.
 *
 * Then per-record evaluation classifies a new context as match / veto / neither.
 *
 * Does NOT change:
 *   - scanner ranking / Top-10 selection / admission
 *   - opportunity / confidence / danger / edge scoring
 *   - routeMode decisions, variant selection, or promotion logic
 *   - shadow fill, close, cost, or calibration logic
 *   - live readiness, symbol quarantine, trade caps
 *   - stop / TP geometry, universe rotation, external discovery
 *   - adaptive gate readiness thresholds, conditional alpha stability logic
 *
 * No symbol hardcoding. Symbols are observed only via per-symbol grouping
 * by `context.symbol`; FET/SUI/INJ etc. are NEVER inputs.
 */

import type { StrategyContextSnapshot, StrategyExperienceRecord } from "@dtc/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TopContributorFingerprintProfileStatus = "READY" | "INSUFFICIENT_DATA";

export interface TopContributorFingerprintProfileV0 {
  policyVersion: "tc-fp-v0";
  status: TopContributorFingerprintProfileStatus;
  /** BASE+WHALE cohort size used to derive the profile. */
  sampleSize: number;
  topContributorRecordCount: number;
  negativeRecordCount: number;
  matchThresholds: {
    /** ceiling on stopDistanceBps; lower (tighter) is better */
    stopDistanceBpsMax: number | null;
    /** ceiling on entryDriftPctOfZone; more-negative is better, so the ceiling is the p75 of TOP values */
    entryDriftPctOfZoneMax: number | null;
    /** supporting: chaseRisk=HIGH is binary; entryDriftAtr >= this counts as a supporting hit */
    supportingEntryDriftAtrMin: number | null;
  };
  vetoThresholds: {
    /** any stopDistanceBps >= this triggers a veto */
    stopDistanceBpsMin: number | null;
    /** any entryDriftPctOfZone >= this triggers a veto */
    entryDriftPctOfZoneMin: number | null;
  };
  notes: string[];
}

export interface TopContributorFingerprintEvaluation {
  policyVersion: "tc-fp-v0";
  match: boolean;
  vetoed: boolean;
  reasonCodes: string[];
  /** 0..2: chaseRisk==HIGH + entryDriftAtr >= supportingEntryDriftAtrMin */
  supportingHits: number;
  profileStatus: TopContributorFingerprintProfileStatus;
}

export interface TopContributorFingerprintBucketEconomics {
  n: number;
  netAvgR: number | null;
  profitFactor: number | null;
  netSumR: number | null;
}

export type TopContributorFingerprintRobustnessStatus =
  | "CONCENTRATION_BLOCKED"
  | "PROMISING_BUT_UNPROVEN"
  | "ROBUSTNESS_IMPROVING"
  | "INSUFFICIENT_DATA";

export interface TopContributorFingerprintRobustnessSummary {
  status: TopContributorFingerprintRobustnessStatus;
  matchCalendarDayCount: number;
  matchDistinctSymbolCount: number;
  matchPositiveSymbolCount: number;
  /** Top-1 positive symbol share of total positive-contributor MATCH netSumR. null when no positive symbol. */
  top1SymbolShareOfMatchNetSumR: number | null;
  /** Top-2 positive symbol share of total positive-contributor MATCH netSumR. null when no positive symbol. */
  top2SymbolShareOfMatchNetSumR: number | null;
  /** Average realizedNetR of MATCH records NOT in the top-2 positive symbols. null when no such records exist. */
  exTop2SymbolMatchNetAvgR: number | null;
  /** Any MATCH record had realizedNetR < 0. */
  matchHasRealizedLoss: boolean;
  /** MATCH bucket profitFactor is computable (at least one realized loss in MATCH). */
  matchProfitFactorComputable: boolean;
  blockers: string[];
}

export interface TopContributorFingerprintThresholdOverlap {
  /** stopVetoMin <= stopMatchMax: NEITHER safe zone is squeezed on the stop dimension */
  stopCrossed: boolean;
  /** driftVetoMin <= driftMatchMax: NEITHER safe zone is squeezed on the drift dimension */
  driftCrossed: boolean;
  /** true when either dimension is crossed — NEITHER may mathematically collapse to zero */
  anyCrossed: boolean;
}

export interface TopContributorFingerprintReport {
  profile: TopContributorFingerprintProfileV0;
  evaluations: {
    matchCount: number;
    vetoCount: number;
    neitherCount: number;
    /** = sampleSize when profile READY; 0 otherwise */
    evaluatedCohortSize: number;
  };
  /**
   * Per-bucket outcome economics (realizedNetR from StrategyExperienceRecord.outcome).
   * Populated only when profile.status === "READY"; all fields null/0 otherwise.
   */
  buckets: {
    match: TopContributorFingerprintBucketEconomics;
    veto: TopContributorFingerprintBucketEconomics;
    neither: TopContributorFingerprintBucketEconomics;
  };
  /**
   * Records where coreMatch=true AND vetoed=true — absorbed into veto by veto-wins precedence.
   * Exposed for reporting; does NOT change bucket assignment or any live behavior.
   * null when profile is INSUFFICIENT_DATA.
   */
  bothMatchAndVetoCount: number | null;
  /** Economics of the BOTH_MATCH_AND_VETO sub-population. null when profile not READY. */
  bothMatchAndVetoEconomics: TopContributorFingerprintBucketEconomics | null;
  /** Economics of veto records where coreMatch was false (pure-veto). null when profile not READY. */
  vetoOnlyEconomics: TopContributorFingerprintBucketEconomics | null;
  /**
   * Whether match/veto thresholds cross, which mathematically forces NEITHER → 0.
   * null when profile is INSUFFICIENT_DATA (thresholds unavailable).
   */
  thresholdOverlap: TopContributorFingerprintThresholdOverlap | null;
  /**
   * REPORT-ONLY robustness interpretation layer for the MATCH bucket.
   * Populated for all profile statuses; status = INSUFFICIENT_DATA when profile not READY
   * or matchN < 5.
   */
  robustness: TopContributorFingerprintRobustnessSummary;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_TOP_RECORDS = 10;
const MIN_NEGATIVE_RECORDS = 3;
/**
 * Supporting threshold fallback derived from prior audit (audit-top-contributor-fingerprint.mjs).
 * The audit observed that top contributors clustered at entryDriftAtr >= 2.0; we use this as
 * a fixed supporting-hit threshold rather than a per-cohort derivation, because it is a
 * stable cross-cohort signal in the original audit.
 */
const SUPPORTING_ENTRY_DRIFT_ATR_DEFAULT = 2.0;

/** MATCH records must reach this count before robustness metrics are meaningful. */
const ROBUSTNESS_MIN_MATCH_N = 5;
/** Top-2 positive symbol share must be below this to clear the concentration blocker. */
const ROBUSTNESS_SYMBOL_CONCENTRATION_THRESHOLD = 0.60;
/** Ex-top-2 symbols must have average netR above this to clear the quality blocker. */
const ROBUSTNESS_EX_TOP2_MIN_AVG_R = 0.15;
/** MATCH records must span at least this many distinct calendar days. */
const ROBUSTNESS_MIN_CALENDAR_DAYS = 5;
/** MATCH records must involve at least this many distinct symbols. */
const ROBUSTNESS_MIN_DISTINCT_SYMBOLS = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Quantile of a *sorted* numeric array using linear interpolation, matching the
 * audit script's `quantile(sorted, q)` implementation.
 */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

function p75(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.75);
}

function netSumR(records: StrategyExperienceRecord[]): number {
  let sum = 0;
  for (const r of records) {
    const v = r.outcome.realizedNetR;
    if (isFiniteNumber(v)) sum += v;
  }
  return sum;
}

function computeBucketEconomics(records: StrategyExperienceRecord[]): TopContributorFingerprintBucketEconomics {
  const n = records.length;
  if (n === 0) return { n: 0, netAvgR: null, profitFactor: null, netSumR: null };

  let sumWins = 0;
  let sumLossAbs = 0;
  let sumAll = 0;
  let valueCount = 0;
  for (const r of records) {
    const v = r.outcome.realizedNetR;
    if (!isFiniteNumber(v)) continue;
    sumAll += v;
    valueCount++;
    if (v > 0) sumWins += v;
    else if (v < 0) sumLossAbs += Math.abs(v);
  }

  const netAvgRVal = valueCount === 0 ? null : r4(sumAll / valueCount);
  // PF = gross wins / gross losses; null when no losses (undefined/∞); 0 when no wins
  const profitFactor = sumLossAbs === 0 ? null : r4(sumWins / sumLossAbs);

  return {
    n,
    netAvgR: netAvgRVal,
    profitFactor,
    netSumR: valueCount === 0 ? null : r4(sumAll),
  };
}

function emptyBucketEconomics(): TopContributorFingerprintBucketEconomics {
  return { n: 0, netAvgR: null, profitFactor: null, netSumR: null };
}

// ─── Robustness helpers ───────────────────────────────────────────────────────

function countCalendarDays(records: StrategyExperienceRecord[]): number {
  const days = new Set<string>();
  for (const r of records) {
    const oa = r.outcome.openedAt;
    if (typeof oa === "string" && oa.length >= 10) {
      days.add(oa.slice(0, 10)); // YYYY-MM-DD
    }
  }
  return days.size;
}

function countDistinctSymbolsInRecords(records: StrategyExperienceRecord[]): number {
  const syms = new Set<string>();
  for (const r of records) {
    const sym = r.context.symbol;
    if (typeof sym === "string" && sym.length > 0) syms.add(sym);
  }
  return syms.size;
}

function emptyRobustnessSummary(): TopContributorFingerprintRobustnessSummary {
  return {
    status: "INSUFFICIENT_DATA",
    matchCalendarDayCount: 0,
    matchDistinctSymbolCount: 0,
    matchPositiveSymbolCount: 0,
    top1SymbolShareOfMatchNetSumR: null,
    top2SymbolShareOfMatchNetSumR: null,
    exTop2SymbolMatchNetAvgR: null,
    matchHasRealizedLoss: false,
    matchProfitFactorComputable: false,
    blockers: ["insufficient-match-data"],
  };
}

function computeRobustnessSummary(
  matchRecords: StrategyExperienceRecord[],
  profile: TopContributorFingerprintProfileV0,
  matchBucketEconomics: TopContributorFingerprintBucketEconomics,
): TopContributorFingerprintRobustnessSummary {
  const matchN = matchRecords.length;

  // Fast path: too little data
  if (profile.status !== "READY" || matchN < ROBUSTNESS_MIN_MATCH_N) {
    return {
      ...emptyRobustnessSummary(),
      matchCalendarDayCount: countCalendarDays(matchRecords),
      matchDistinctSymbolCount: countDistinctSymbolsInRecords(matchRecords),
    };
  }

  const calendarDayCount = countCalendarDays(matchRecords);
  const distinctSymbolCount = countDistinctSymbolsInRecords(matchRecords);

  // Symbol concentration: top-2 by positive netSumR
  const matchSymStats = groupBySymbol(matchRecords);
  const positiveMatchSyms = matchSymStats
    .filter((s) => s.netSum > 0)
    .sort((a, b) => b.netSum - a.netSum);
  const matchPositiveSymbolCount = positiveMatchSyms.length;
  const totalPositiveNetSum = positiveMatchSyms.reduce((s, x) => s + x.netSum, 0);

  let top1SymbolShareOfMatchNetSumR: number | null = null;
  let top2SymbolShareOfMatchNetSumR: number | null = null;
  const top2Symbols = new Set(positiveMatchSyms.slice(0, 2).map((s) => s.symbol));

  if (totalPositiveNetSum > 0) {
    const top1Net = positiveMatchSyms[0]?.netSum ?? 0;
    const top2Net = (positiveMatchSyms[0]?.netSum ?? 0) + (positiveMatchSyms[1]?.netSum ?? 0);
    top1SymbolShareOfMatchNetSumR = r4(Math.min(top1Net, totalPositiveNetSum) / totalPositiveNetSum);
    top2SymbolShareOfMatchNetSumR = r4(Math.min(top2Net, totalPositiveNetSum) / totalPositiveNetSum);
  }

  // Ex-top2 netAvgR: average realizedNetR of records NOT in the top-2 positive symbols
  const exTop2Records = matchRecords.filter((rec) => {
    const sym = rec.context.symbol;
    return typeof sym !== "string" || sym.length === 0 || !top2Symbols.has(sym);
  });
  let exTop2SymbolMatchNetAvgR: number | null = null;
  if (exTop2Records.length > 0) {
    const vals = exTop2Records
      .map((r) => r.outcome.realizedNetR)
      .filter((v): v is number => isFiniteNumber(v));
    if (vals.length > 0) {
      exTop2SymbolMatchNetAvgR = r4(vals.reduce((s, v) => s + v, 0) / vals.length);
    }
  }

  const matchHasRealizedLoss = matchRecords.some((r) => {
    const v = r.outcome.realizedNetR;
    return isFiniteNumber(v) && v < 0;
  });
  const matchProfitFactorComputable = matchBucketEconomics.profitFactor !== null;

  // Blocker list
  const blockers: string[] = [];

  if (
    top2SymbolShareOfMatchNetSumR === null ||
    top2SymbolShareOfMatchNetSumR >= ROBUSTNESS_SYMBOL_CONCENTRATION_THRESHOLD
  ) {
    const shareStr =
      top2SymbolShareOfMatchNetSumR !== null
        ? `${Math.round(top2SymbolShareOfMatchNetSumR * 100)}%`
        : "no-positive-data";
    blockers.push(`top2-sym-share=${shareStr}`);
  }
  if (calendarDayCount < ROBUSTNESS_MIN_CALENDAR_DAYS) {
    blockers.push(calendarDayCount <= 1 ? "single-day" : `few-days=${calendarDayCount}`);
  }
  if (distinctSymbolCount < ROBUSTNESS_MIN_DISTINCT_SYMBOLS) {
    blockers.push(distinctSymbolCount <= 1 ? "single-symbol" : `few-symbols=${distinctSymbolCount}`);
  }
  if (exTop2SymbolMatchNetAvgR === null) {
    blockers.push("ex-top2-no-data");
  } else if (exTop2SymbolMatchNetAvgR <= ROBUSTNESS_EX_TOP2_MIN_AVG_R) {
    blockers.push(`ex-top2-weak=${exTop2SymbolMatchNetAvgR.toFixed(2)}R`);
  }
  if (!matchHasRealizedLoss) {
    blockers.push("no-losses-yet");
  }
  if (profile.negativeRecordCount <= MIN_NEGATIVE_RECORDS) {
    blockers.push("profile-loo-fragile");
  }

  // Status classification
  let status: TopContributorFingerprintRobustnessStatus;
  if (blockers.length === 0) {
    status = "ROBUSTNESS_IMPROVING";
  } else {
    const hasConcentrationBlocker = blockers.some(
      (b) =>
        b.startsWith("top2-sym-share") ||
        b === "single-day" ||
        b.startsWith("few-days=") ||
        b === "single-symbol" ||
        b.startsWith("few-symbols="),
    );
    status = hasConcentrationBlocker ? "CONCENTRATION_BLOCKED" : "PROMISING_BUT_UNPROVEN";
  }

  return {
    status,
    matchCalendarDayCount: calendarDayCount,
    matchDistinctSymbolCount: distinctSymbolCount,
    matchPositiveSymbolCount,
    top1SymbolShareOfMatchNetSumR,
    top2SymbolShareOfMatchNetSumR,
    exTop2SymbolMatchNetAvgR,
    matchHasRealizedLoss,
    matchProfitFactorComputable,
    blockers,
  };
}

// ─── Cohort predicates ────────────────────────────────────────────────────────

function isBaseCohort(rec: StrategyExperienceRecord): boolean {
  const ctx = rec.context;
  if (ctx.evidenceEra !== "POST_CALIBRATION") return false;
  const regime = ctx.marketRegime;
  if (regime === null || regime === undefined || regime === "") return false;
  if (!String(regime).toUpperCase().includes("BEAR")) return false;
  if (ctx.direction !== "SHORT") return false;
  if (ctx.selectedEntryVariant !== "vwap_retest_entry") return false;
  if (ctx.selectedExitVariant !== "tp1_full_exit") return false;
  return true;
}

function isWhaleAgrees(rec: StrategyExperienceRecord): boolean {
  return rec.context.whaleAgreement === "AGREES";
}

// ─── Bucketing ────────────────────────────────────────────────────────────────

interface SymbolStat {
  symbol: string;
  records: StrategyExperienceRecord[];
  netSum: number;
}

function groupBySymbol(cohort: StrategyExperienceRecord[]): SymbolStat[] {
  const bySymbol = new Map<string, StrategyExperienceRecord[]>();
  for (const r of cohort) {
    const sym = r.context.symbol;
    if (typeof sym !== "string" || sym.length === 0) continue;
    const list = bySymbol.get(sym) ?? [];
    list.push(r);
    bySymbol.set(sym, list);
  }
  const out: SymbolStat[] = [];
  for (const [symbol, records] of bySymbol) {
    out.push({ symbol, records, netSum: netSumR(records) });
  }
  return out;
}

interface Buckets {
  topRecords: StrategyExperienceRecord[];
  negativeRecords: StrategyExperienceRecord[];
}

/**
 * Mirror the audit script bucketing: TOP = top-2 by positive netSumR;
 * NEGATIVE = symbols whose netSumR < 0.
 * (OTHER_POSITIVE / NEUTRAL not strictly needed for threshold derivation.)
 */
function bucketCohort(cohort: StrategyExperienceRecord[]): Buckets {
  const stats = groupBySymbol(cohort);
  const positive = stats.filter((s) => s.netSum > 0).sort((a, b) => b.netSum - a.netSum);
  const topSyms = new Set(positive.slice(0, 2).map((s) => s.symbol));
  const topRecords: StrategyExperienceRecord[] = [];
  const negativeRecords: StrategyExperienceRecord[] = [];
  for (const s of stats) {
    if (topSyms.has(s.symbol)) {
      for (const r of s.records) topRecords.push(r);
    } else if (s.netSum < 0) {
      for (const r of s.records) negativeRecords.push(r);
    }
  }
  return { topRecords, negativeRecords };
}

// ─── Feature extraction helpers ───────────────────────────────────────────────

function extractFinite(
  records: StrategyExperienceRecord[],
  pick: (ctx: StrategyContextSnapshot) => number | null | undefined,
): number[] {
  const out: number[] = [];
  for (const r of records) {
    const v = pick(r.context);
    if (isFiniteNumber(v)) out.push(v);
  }
  return out;
}

// ─── Profile derivation ───────────────────────────────────────────────────────

function emptyProfile(sampleSize: number, notes: string[]): TopContributorFingerprintProfileV0 {
  return {
    policyVersion: "tc-fp-v0",
    status: "INSUFFICIENT_DATA",
    sampleSize,
    topContributorRecordCount: 0,
    negativeRecordCount: 0,
    matchThresholds: {
      stopDistanceBpsMax: null,
      entryDriftPctOfZoneMax: null,
      supportingEntryDriftAtrMin: null,
    },
    vetoThresholds: {
      stopDistanceBpsMin: null,
      entryDriftPctOfZoneMin: null,
    },
    notes,
  };
}

function deriveProfile(cohort: StrategyExperienceRecord[]): TopContributorFingerprintProfileV0 {
  const notes: string[] = [];
  const sampleSize = cohort.length;

  if (sampleSize === 0) {
    notes.push("BASE+WHALE cohort is empty.");
    return emptyProfile(0, notes);
  }

  const { topRecords, negativeRecords } = bucketCohort(cohort);

  if (topRecords.length < MIN_TOP_RECORDS || negativeRecords.length < MIN_NEGATIVE_RECORDS) {
    notes.push(
      `Insufficient bucket coverage: top=${topRecords.length} (need ${MIN_TOP_RECORDS}), neg=${negativeRecords.length} (need ${MIN_NEGATIVE_RECORDS}).`,
    );
    const prof = emptyProfile(sampleSize, notes);
    prof.topContributorRecordCount = topRecords.length;
    prof.negativeRecordCount = negativeRecords.length;
    return prof;
  }

  // Match thresholds (TOP bucket)
  const topStopBps = extractFinite(topRecords, (c) => c.stopDistanceBps);
  const topEntryDrift = extractFinite(topRecords, (c) => c.entryDriftPctOfZone);

  // Veto floors (NEGATIVE bucket median)
  const negStopBps = extractFinite(negativeRecords, (c) => c.stopDistanceBps);
  const negEntryDrift = extractFinite(negativeRecords, (c) => c.entryDriftPctOfZone);

  // P75 of TOP for stopDistanceBps: ceiling on "tight" (lower) values.
  // P75 of TOP for entryDriftPctOfZone: TOP values are negative; p75 ≈ the less-negative end,
  // so the "max allowed" is "values must be <= this number" — i.e. at least as negative as p75.
  const stopDistanceBpsMax = p75(topStopBps);
  const entryDriftPctOfZoneMax = p75(topEntryDrift);

  const stopDistanceBpsMin = median(negStopBps);
  const entryDriftPctOfZoneMin = median(negEntryDrift);

  if (topStopBps.length === 0) notes.push("stopDistanceBps (TOP): insufficient values");
  if (topEntryDrift.length === 0) notes.push("entryDriftPctOfZone (TOP): insufficient values");
  if (negStopBps.length === 0) notes.push("stopDistanceBps (NEGATIVE): insufficient values");
  if (negEntryDrift.length === 0) notes.push("entryDriftPctOfZone (NEGATIVE): insufficient values");

  return {
    policyVersion: "tc-fp-v0",
    status: "READY",
    sampleSize,
    topContributorRecordCount: topRecords.length,
    negativeRecordCount: negativeRecords.length,
    matchThresholds: {
      stopDistanceBpsMax: stopDistanceBpsMax === null ? null : r4(stopDistanceBpsMax),
      entryDriftPctOfZoneMax: entryDriftPctOfZoneMax === null ? null : r4(entryDriftPctOfZoneMax),
      supportingEntryDriftAtrMin: SUPPORTING_ENTRY_DRIFT_ATR_DEFAULT,
    },
    vetoThresholds: {
      stopDistanceBpsMin: stopDistanceBpsMin === null ? null : r4(stopDistanceBpsMin),
      entryDriftPctOfZoneMin: entryDriftPctOfZoneMin === null ? null : r4(entryDriftPctOfZoneMin),
    },
    notes,
  };
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

export function evaluateTopContributorFingerprintV0(
  ctx: StrategyContextSnapshot,
  profile: TopContributorFingerprintProfileV0,
): TopContributorFingerprintEvaluation {
  if (profile.status === "INSUFFICIENT_DATA") {
    return {
      policyVersion: "tc-fp-v0",
      match: false,
      vetoed: false,
      reasonCodes: ["PROFILE_INSUFFICIENT_DATA"],
      supportingHits: 0,
      profileStatus: "INSUFFICIENT_DATA",
    };
  }

  const reasonCodes: string[] = [];
  const stopBps = ctx.stopDistanceBps;
  const entryDrift = ctx.entryDriftPctOfZone;
  const entryDriftAtr = ctx.entryDriftAtr;
  const chaseRisk = ctx.chaseRisk;

  // Veto checks
  let vetoed = false;
  const stopVetoFloor = profile.vetoThresholds.stopDistanceBpsMin;
  const entryDriftVetoFloor = profile.vetoThresholds.entryDriftPctOfZoneMin;
  if (
    stopVetoFloor !== null &&
    isFiniteNumber(stopBps) &&
    stopBps >= stopVetoFloor
  ) {
    vetoed = true;
    reasonCodes.push("VETO_STOP_TOO_WIDE");
  }
  if (
    entryDriftVetoFloor !== null &&
    isFiniteNumber(entryDrift) &&
    entryDrift >= entryDriftVetoFloor
  ) {
    vetoed = true;
    reasonCodes.push("VETO_ENTRY_DRIFT_TOO_POSITIVE");
  }

  // Core match checks
  const stopMaxOk =
    profile.matchThresholds.stopDistanceBpsMax !== null &&
    isFiniteNumber(stopBps) &&
    stopBps <= profile.matchThresholds.stopDistanceBpsMax;
  const entryDriftMaxOk =
    profile.matchThresholds.entryDriftPctOfZoneMax !== null &&
    isFiniteNumber(entryDrift) &&
    entryDrift <= profile.matchThresholds.entryDriftPctOfZoneMax;

  if (stopMaxOk) reasonCodes.push("STOP_DISTANCE_TIGHT_OK");
  else reasonCodes.push("CORE_STOP_DISTANCE_FAILED");
  if (entryDriftMaxOk) reasonCodes.push("ENTRY_DRIFT_NEGATIVE_OK");
  else reasonCodes.push("CORE_ENTRY_DRIFT_FAILED");

  const coreMatch = stopMaxOk && entryDriftMaxOk;
  const match = coreMatch && !vetoed;

  // Supporting hits
  let supportingHits = 0;
  if (chaseRisk === "HIGH") supportingHits++;
  const supportAtrMin = profile.matchThresholds.supportingEntryDriftAtrMin;
  if (
    supportAtrMin !== null &&
    isFiniteNumber(entryDriftAtr) &&
    entryDriftAtr >= supportAtrMin
  ) {
    supportingHits++;
  }

  return {
    policyVersion: "tc-fp-v0",
    match,
    vetoed,
    reasonCodes,
    supportingHits,
    profileStatus: profile.status,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build an advisory top-contributor-fingerprint report from
 * StrategyExperienceRecords. Read-only. Does not influence any behavior.
 */
export function buildTopContributorFingerprintReport(
  records: StrategyExperienceRecord[],
): TopContributorFingerprintReport {
  const base = records.filter(isBaseCohort);
  const cohort = base.filter(isWhaleAgrees);
  const profile = deriveProfile(cohort);

  if (profile.status === "INSUFFICIENT_DATA") {
    return {
      profile,
      evaluations: {
        matchCount: 0,
        vetoCount: 0,
        neitherCount: 0,
        evaluatedCohortSize: 0,
      },
      buckets: {
        match: emptyBucketEconomics(),
        veto: emptyBucketEconomics(),
        neither: emptyBucketEconomics(),
      },
      bothMatchAndVetoCount: null,
      bothMatchAndVetoEconomics: null,
      vetoOnlyEconomics: null,
      thresholdOverlap: null,
      robustness: emptyRobustnessSummary(),
    };
  }

  const matchRecords: StrategyExperienceRecord[] = [];
  const vetoRecords: StrategyExperienceRecord[] = [];
  const neitherRecords: StrategyExperienceRecord[] = [];
  // Sub-populations within VETO: coreMatch=true means it would also match if not vetoed
  const bothMatchAndVetoRecords: StrategyExperienceRecord[] = [];
  const vetoOnlyRecords: StrategyExperienceRecord[] = [];

  for (const rec of cohort) {
    const evalResult = evaluateTopContributorFingerprintV0(rec.context, profile);
    if (evalResult.vetoed) {
      vetoRecords.push(rec);
      // Re-check coreMatch: the evaluation already computed it internally; we reconstruct
      // by checking whether the record satisfies match thresholds independently of veto.
      const stopBps = rec.context.stopDistanceBps;
      const entryDrift = rec.context.entryDriftPctOfZone;
      const stopMaxOk =
        profile.matchThresholds.stopDistanceBpsMax !== null &&
        isFiniteNumber(stopBps) &&
        stopBps <= profile.matchThresholds.stopDistanceBpsMax;
      const entryDriftMaxOk =
        profile.matchThresholds.entryDriftPctOfZoneMax !== null &&
        isFiniteNumber(entryDrift) &&
        entryDrift <= profile.matchThresholds.entryDriftPctOfZoneMax;
      const coreMatch = stopMaxOk && entryDriftMaxOk;
      if (coreMatch) bothMatchAndVetoRecords.push(rec);
      else vetoOnlyRecords.push(rec);
    } else if (evalResult.match) {
      matchRecords.push(rec);
    } else {
      neitherRecords.push(rec);
    }
  }

  const matchBucket = computeBucketEconomics(matchRecords);

  // Threshold crossing: if stopVetoMin <= stopMatchMax, the "safe zone" (stop not triggering veto)
  // is contained within the core-match zone — NEITHER collapses for that dimension.
  const sMax = profile.matchThresholds.stopDistanceBpsMax;
  const sMin = profile.vetoThresholds.stopDistanceBpsMin;
  const eMax = profile.matchThresholds.entryDriftPctOfZoneMax;
  const eMin = profile.vetoThresholds.entryDriftPctOfZoneMin;
  const stopCrossed = sMin !== null && sMax !== null && sMin <= sMax;
  const driftCrossed = eMin !== null && eMax !== null && eMin <= eMax;
  const thresholdOverlap: TopContributorFingerprintThresholdOverlap = {
    stopCrossed,
    driftCrossed,
    anyCrossed: stopCrossed || driftCrossed,
  };

  return {
    profile,
    evaluations: {
      matchCount: matchRecords.length,
      vetoCount: vetoRecords.length,
      neitherCount: neitherRecords.length,
      evaluatedCohortSize: cohort.length,
    },
    buckets: {
      match: matchBucket,
      veto: computeBucketEconomics(vetoRecords),
      neither: computeBucketEconomics(neitherRecords),
    },
    bothMatchAndVetoCount: bothMatchAndVetoRecords.length,
    bothMatchAndVetoEconomics: computeBucketEconomics(bothMatchAndVetoRecords),
    vetoOnlyEconomics: computeBucketEconomics(vetoOnlyRecords),
    thresholdOverlap,
    robustness: computeRobustnessSummary(matchRecords, profile, matchBucket),
  };
}

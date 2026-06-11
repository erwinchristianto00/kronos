import type { ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { buildRouteMaturityReport, type CohortMaturity } from "./route-maturity.js";

/**
 * LIVE READINESS GATE
 *
 * Purpose: evaluate whether the shadow data set is mature enough that full-auto
 * live trading *could* be safely enabled in a future release. This file does NOT
 * enable live trading. It only computes a score and gate results.
 *
 * Hard rule: readiness gates and warning events MUST NOT stop shadow collection
 * or block new shadow trades. They are advisory and inform future live-safety
 * design only.
 *
 * Scope: only `fib_500_entry + tp1_full_exit` positions that are also routed
 * PROFIT_CANDIDATE primary trades qualify as the "candidate live route".
 *
 * Shadow realism the gate assumes (already enforced in shadow-engine.ts):
 *   - Pending limit fills wait for an actual candle to touch the zone.
 *   - Round-trip fees + slippage + spread are deducted from realized R.
 *   - When SL and TP1 print in the same candle, conservative stop-first applies
 *     (no optimistic same-candle TP).
 *   - `tp1_full_exit` exits 100% at TP1; no runner remains on this route.
 */

export type LiveGateStatus = "PASS" | "FAIL";

export type LiveReadinessGateCode =
  | "CLOSED_SAMPLE_SUFFICIENT"
  | "NET_AVG_R_POSITIVE"
  | "PROFIT_FACTOR_OK"
  | "TP1_PROFITABLE_RATE_OK"
  | "SL_RATE_OK"
  | "MAX_LOSING_STREAK_OK"
  | "RECENT_DAYS_POSITIVE"
  | "WORST_DAY_OK"
  | "DATA_COVERAGE_OK"
  | "KRONOS_HEALTHY";

export type LiveReadinessWarningCode =
  | "DAILY_NET_R_BELOW_NEG_2"
  | "THREE_CONSECUTIVE_LOSSES"
  | "KRONOS_DEGRADED"
  | "BINANCE_COVERAGE_LOW"
  | "SPREAD_ABNORMAL"
  | "ROUTE_EXPECTANCY_NEGATIVE";

export type RouteAlignmentStatus = "MATCH" | "MISMATCH" | "NO_LEADING_COHORT";

export interface LeadingMaturityCohort {
  entryVariant: string;
  exitVariant: string;
  /** Human-readable label, e.g. "fib_500_entry + tp1_full_exit" */
  label: string;
  eraFilter: "POST_CALIBRATION";
  closedCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  maturityStatus: CohortMaturity["maturityStatus"];
}

export interface LiveReadinessGate {
  code: LiveReadinessGateCode;
  status: LiveGateStatus;
  threshold: string;
  actual: string;
}

export interface LiveReadinessReport {
  generatedAt: string;
  routeUnderEvaluation: { entryVariant: "fib_500_entry"; exitVariant: "tp1_full_exit" };
  closedSampleCount: number;
  targetClosedSampleCount: number;
  recentClosesPerDay: number | null;
  estimatedDaysToTarget: number | null;
  score: number;
  liveReady: boolean;
  passedGates: LiveReadinessGateCode[];
  failedGates: LiveReadinessGateCode[];
  gates: LiveReadinessGate[];
  warningEvents: LiveReadinessWarningCode[];
  metrics: {
    netAvgR: number | null;
    profitFactor: number | null;
    tp1ProfitableRate: number | null;
    slRate: number | null;
    maxLosingStreak: number;
    recentPositiveDays: number;
    recentTotalDays: number;
    worstDayNetR: number | null;
    dataCoverage: number;
    kronosHealthy: boolean;
    todayNetR: number;
    lastThreeAllLosses: boolean;
  };
  /**
   * Read-only alignment metadata. Compares the gate's locked evaluation route
   * (fib_500_entry + tp1_full_exit) against the current POST_CALIBRATION
   * maturity leader in Shadow Route Maturity. Advisory only — has no effect on
   * gates, score, shadow execution, or routing.
   */
  lockedEvaluationRoute: { entryVariant: "fib_500_entry"; exitVariant: "tp1_full_exit"; label: string };
  leadingMaturityCohort: LeadingMaturityCohort | null;
  routeAlignmentStatus: RouteAlignmentStatus;
  routeAlignmentMessage: string;
  /** Plain-English advisory copy for the UI. */
  notes: string[];
}

export interface LiveReadinessSourcesInput {
  positions: ShadowPosition[];
  kronos?: { healthy: boolean } | null;
  /** 0..1 — share of scans where Binance coverage was sufficient. Defaults to 1. */
  binanceCoverage?: number;
  /** True if the operator has observed abnormally wide spreads today. */
  spreadAbnormal?: boolean;
}

const TARGET_CLOSED = 100;
const NET_AVG_R_GATE = 0.15;
const PF_GATE = 1.3;
const TP1_PROFIT_RATE_GATE = 0.55;
const SL_RATE_GATE = 0.35;
const MAX_LOSING_STREAK_GATE = 4;
const RECENT_DAYS_WINDOW = 10;
const RECENT_DAYS_POSITIVE_GATE = 7;
const WORST_DAY_GATE = -2;
const DATA_COVERAGE_GATE = 0.95;

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function isCandidateLiveRoute(p: ShadowPosition): boolean {
  // The candidate live route is locked to fib_500 + tp1_full and only counts
  // primary PROFIT_CANDIDATE trades. RESEARCH/DATA_COLLECTION are excluded
  // because they are not eligible for promotion to live.
  return (
    p.variantSelection?.selectedEntryVariant === "fib_500_entry" &&
    p.variantSelection?.selectedExitVariant === "tp1_full_exit" &&
    p.variantSelection?.routeMode === "PROFIT_CANDIDATE"
  );
}

function closedVariantsOf(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

interface ClosedRecord {
  closedAt: string; // ISO
  netR: number;
  tp1Hit: boolean;
  closeReason: ShadowVariantPosition["closeReason"];
}

function flatClosedRecords(positions: ShadowPosition[]): ClosedRecord[] {
  const out: ClosedRecord[] = [];
  for (const p of positions) {
    for (const v of closedVariantsOf(p)) {
      out.push({
        closedAt: v.closedAt ?? p.lastEvaluatedAt,
        netR: v.realizedNetR,
        tp1Hit: v.tp1Hit,
        closeReason: v.closeReason,
      });
    }
  }
  return out.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
}

function computeMaxLosingStreak(records: ClosedRecord[]): number {
  let max = 0;
  let cur = 0;
  for (const r of records) {
    if (r.netR < 0) {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

function bucketByDay(records: ClosedRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of records) {
    const day = r.closedAt.slice(0, 10);
    map.set(day, (map.get(day) ?? 0) + r.netR);
  }
  return map;
}

function recentDays(
  daily: Map<string, number>,
  now: Date,
  windowDays: number,
): { positive: number; total: number; worst: number | null; todayNetR: number } {
  const todayStr = now.toISOString().slice(0, 10);
  // Build last `windowDays` days ending at today
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    days.push(d.toISOString().slice(0, 10));
  }
  let positive = 0;
  let total = 0;
  let worst: number | null = null;
  for (const day of days) {
    if (daily.has(day)) {
      const v = daily.get(day) ?? 0;
      total += 1;
      if (v > 0) positive += 1;
      if (worst === null || v < worst) worst = v;
    }
  }
  return { positive, total, worst, todayNetR: daily.get(todayStr) ?? 0 };
}

function estimateRecentPace(records: ClosedRecord[], now: Date): number | null {
  // Average closes per day across days that had any closes within the last 7
  // days. Returns null if no recent activity.
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recent = records.filter((r) => new Date(r.closedAt).getTime() >= cutoff);
  if (recent.length === 0) return null;
  const byDay = new Map<string, number>();
  for (const r of recent) {
    const day = r.closedAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const totalDays = Math.max(byDay.size, 1);
  return r4(recent.length / totalDays);
}

function makeGate(
  code: LiveReadinessGateCode,
  pass: boolean,
  threshold: string,
  actual: string,
): LiveReadinessGate {
  return { code, status: pass ? "PASS" : "FAIL", threshold, actual };
}

export function buildLiveReadinessReport(
  input: LiveReadinessSourcesInput,
  now: Date = new Date(),
): LiveReadinessReport {
  const generatedAt = now.toISOString();
  const coverage = input.binanceCoverage ?? 1;
  const kronosHealthy = input.kronos?.healthy ?? true;
  const spreadAbnormal = !!input.spreadAbnormal;

  // Filter to the candidate live route only.
  const routePositions = input.positions.filter(isCandidateLiveRoute);
  const closedRecords = flatClosedRecords(routePositions);
  const closedSampleCount = closedRecords.length;

  // Metrics
  const winners = closedRecords.filter((r) => r.netR > 0);
  const losers = closedRecords.filter((r) => r.netR < 0);
  const grossWin = winners.reduce((s, r) => s + r.netR, 0);
  const grossLoss = Math.abs(losers.reduce((s, r) => s + r.netR, 0));
  const netAvgR = closedSampleCount === 0 ? null : r4(closedRecords.reduce((s, r) => s + r.netR, 0) / closedSampleCount);
  const profitFactor = grossLoss === 0 ? (winners.length === 0 ? null : null) : r4(grossWin / grossLoss);

  const tp1Hits = closedRecords.filter((r) => r.tp1Hit);
  const tp1ProfitableRate =
    tp1Hits.length === 0 ? null : r4(tp1Hits.filter((r) => r.netR > 0).length / tp1Hits.length);

  const slCount = closedRecords.filter((r) => r.closeReason === "SL" || r.closeReason === "BREAKEVEN").length;
  const slRate = closedSampleCount === 0 ? null : r4(slCount / closedSampleCount);

  const maxLosingStreak = computeMaxLosingStreak(closedRecords);

  const daily = bucketByDay(closedRecords);
  const recent = recentDays(daily, now, RECENT_DAYS_WINDOW);

  // Recent pace + ETA
  const recentClosesPerDay = estimateRecentPace(closedRecords, now);
  const remaining = Math.max(0, TARGET_CLOSED - closedSampleCount);
  const estimatedDaysToTarget =
    recentClosesPerDay === null || recentClosesPerDay <= 0
      ? null
      : Math.ceil(remaining / recentClosesPerDay);

  // 3 consecutive losses (most recent)
  const lastThree = closedRecords.slice(-3);
  const lastThreeAllLosses = lastThree.length === 3 && lastThree.every((r) => r.netR < 0);

  // Gates — each is a hard PASS/FAIL. score = 10 per pass. liveReady = all pass.
  const gates: LiveReadinessGate[] = [
    makeGate(
      "CLOSED_SAMPLE_SUFFICIENT",
      closedSampleCount >= TARGET_CLOSED,
      `>= ${TARGET_CLOSED} closed primary PROFIT_CANDIDATE trades on fib_500+tp1_full`,
      `${closedSampleCount}`,
    ),
    makeGate(
      "NET_AVG_R_POSITIVE",
      netAvgR !== null && netAvgR > NET_AVG_R_GATE,
      `netAvgR > ${NET_AVG_R_GATE}`,
      netAvgR === null ? "n/a" : netAvgR.toFixed(4),
    ),
    makeGate(
      "PROFIT_FACTOR_OK",
      profitFactor !== null && profitFactor > PF_GATE,
      `PF > ${PF_GATE}`,
      profitFactor === null ? "n/a" : profitFactor.toFixed(4),
    ),
    makeGate(
      "TP1_PROFITABLE_RATE_OK",
      tp1ProfitableRate !== null && tp1ProfitableRate > TP1_PROFIT_RATE_GATE,
      `> ${TP1_PROFIT_RATE_GATE * 100}%`,
      tp1ProfitableRate === null ? "n/a" : `${(tp1ProfitableRate * 100).toFixed(2)}%`,
    ),
    makeGate(
      "SL_RATE_OK",
      slRate !== null && slRate < SL_RATE_GATE,
      `< ${SL_RATE_GATE * 100}%`,
      slRate === null ? "n/a" : `${(slRate * 100).toFixed(2)}%`,
    ),
    makeGate(
      "MAX_LOSING_STREAK_OK",
      maxLosingStreak <= MAX_LOSING_STREAK_GATE,
      `<= ${MAX_LOSING_STREAK_GATE}`,
      `${maxLosingStreak}`,
    ),
    makeGate(
      "RECENT_DAYS_POSITIVE",
      recent.positive >= RECENT_DAYS_POSITIVE_GATE,
      `>= ${RECENT_DAYS_POSITIVE_GATE} positive of last ${RECENT_DAYS_WINDOW} days with data`,
      `${recent.positive}/${recent.total}`,
    ),
    makeGate(
      "WORST_DAY_OK",
      recent.worst === null ? false : recent.worst > WORST_DAY_GATE,
      `> ${WORST_DAY_GATE}R`,
      recent.worst === null ? "n/a" : `${recent.worst.toFixed(2)}R`,
    ),
    makeGate(
      "DATA_COVERAGE_OK",
      coverage >= DATA_COVERAGE_GATE,
      `>= ${DATA_COVERAGE_GATE * 100}%`,
      `${(coverage * 100).toFixed(2)}%`,
    ),
    makeGate(
      "KRONOS_HEALTHY",
      kronosHealthy,
      "Kronos healthy",
      kronosHealthy ? "healthy" : "degraded",
    ),
  ];

  const passedGates = gates.filter((g) => g.status === "PASS").map((g) => g.code);
  const failedGates = gates.filter((g) => g.status === "FAIL").map((g) => g.code);
  const score = passedGates.length * 10;
  const liveReady = failedGates.length === 0;

  // Warning events — advisory only. They are NOT used to stop or cap shadow.
  const warningEvents: LiveReadinessWarningCode[] = [];
  if (recent.todayNetR <= -2) warningEvents.push("DAILY_NET_R_BELOW_NEG_2");
  if (lastThreeAllLosses) warningEvents.push("THREE_CONSECUTIVE_LOSSES");
  if (!kronosHealthy) warningEvents.push("KRONOS_DEGRADED");
  if (coverage < DATA_COVERAGE_GATE) warningEvents.push("BINANCE_COVERAGE_LOW");
  if (spreadAbnormal) warningEvents.push("SPREAD_ABNORMAL");
  if (netAvgR !== null && netAvgR < 0) warningEvents.push("ROUTE_EXPECTANCY_NEGATIVE");

  const notes: string[] = [
    "Live readiness is advisory only. Shadow collection continues regardless of this report.",
    "Hard gates do not cap shadow trades, daily losses, or open positions.",
    "Candidate live route: fib_500_entry + tp1_full_exit, primary PROFIT_CANDIDATE only.",
    "Shadow realism: pending limit fill, fee+slippage+spread costs, conservative same-candle SL/TP, TP1 full exit only (no runner).",
    "Live Auto Readiness evaluates a fixed route only. It does not automatically follow whichever route leads Shadow Route Maturity.",
  ];

  // ── Route Alignment (read-only, purely informational) ──────────────────────
  // Compare the gate's locked route to the current POST_CALIBRATION maturity
  // leader. Reuses buildRouteMaturityReport so there is no duplicated sort
  // logic. Has zero effect on gates, score, shadow execution, or routing.
  const LOCKED_ENTRY = "fib_500_entry";
  const LOCKED_EXIT = "tp1_full_exit";
  const lockedEvaluationRoute = {
    entryVariant: LOCKED_ENTRY as "fib_500_entry",
    exitVariant: LOCKED_EXIT as "tp1_full_exit",
    label: `${LOCKED_ENTRY} + ${LOCKED_EXIT}`,
  };

  const maturityReport = buildRouteMaturityReport(
    { positions: input.positions, eraFilter: "POST_CALIBRATION" },
    now,
  );
  const leader = maturityReport.leadingCohort;
  const leaderCohortData = leader
    ? maturityReport.cohorts.find(
        (c) => c.entryVariant === leader.entryVariant && c.exitVariant === leader.exitVariant,
      )
    : null;

  const leadingMaturityCohort: LeadingMaturityCohort | null = leaderCohortData
    ? {
        entryVariant: leaderCohortData.entryVariant,
        exitVariant: leaderCohortData.exitVariant,
        label: `${leaderCohortData.entryVariant} + ${leaderCohortData.exitVariant}`,
        eraFilter: "POST_CALIBRATION",
        closedCount: leaderCohortData.closedCount,
        netAvgR: leaderCohortData.netAvgR,
        profitFactor: leaderCohortData.profitFactor,
        maturityStatus: leaderCohortData.maturityStatus,
      }
    : null;

  let routeAlignmentStatus: RouteAlignmentStatus;
  let routeAlignmentMessage: string;

  if (!leader) {
    routeAlignmentStatus = "NO_LEADING_COHORT";
    routeAlignmentMessage =
      "Shadow Route Maturity has no eligible leading cohort (POST_CALIBRATION, ≥1 close) yet. " +
      "The locked evaluation route (fib_500_entry + tp1_full_exit) stands as the sole candidate.";
  } else if (
    leader.entryVariant === LOCKED_ENTRY &&
    leader.exitVariant === LOCKED_EXIT
  ) {
    routeAlignmentStatus = "MATCH";
    routeAlignmentMessage =
      `The leading POST_CALIBRATION maturity cohort (${lockedEvaluationRoute.label}) ` +
      "matches the locked evaluation route. Evidence is building on the intended path.";
  } else {
    routeAlignmentStatus = "MISMATCH";
    routeAlignmentMessage =
      `Shadow Route Maturity's current POST_CALIBRATION leader is ` +
      `${leader.entryVariant} + ${leader.exitVariant}, which differs from the locked ` +
      `evaluation route (${lockedEvaluationRoute.label}). ` +
      "Live Auto Readiness gates evaluate the locked route only and do not automatically follow " +
      "the maturity leader. This is informational — no action is required.";
  }

  return {
    generatedAt,
    routeUnderEvaluation: { entryVariant: "fib_500_entry", exitVariant: "tp1_full_exit" },
    closedSampleCount,
    targetClosedSampleCount: TARGET_CLOSED,
    recentClosesPerDay,
    estimatedDaysToTarget,
    score,
    liveReady,
    passedGates,
    failedGates,
    gates,
    warningEvents,
    metrics: {
      netAvgR,
      profitFactor,
      tp1ProfitableRate,
      slRate,
      maxLosingStreak,
      recentPositiveDays: recent.positive,
      recentTotalDays: recent.total,
      worstDayNetR: recent.worst,
      dataCoverage: r4(coverage),
      kronosHealthy,
      todayNetR: r4(recent.todayNetR),
      lastThreeAllLosses,
    },
    lockedEvaluationRoute,
    leadingMaturityCohort,
    routeAlignmentStatus,
    routeAlignmentMessage,
    notes,
  };
}

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  EVIDENCE_POLICY_VERSION,
  END_TO_END_CORRECTNESS_DEPLOYED_AT,
  EXECUTION_POLICY_VERSION,
  type TrackedSignal,
} from "@dtc/shared";

import { computePerformance } from "../src/lib/outcome-checker.js";
import { PerformanceStatsProvider } from "../src/lib/performance-cache.js";
import { SignalTracker } from "../src/lib/tracker.js";

function makeSignal(overrides: Partial<TrackedSignal> = {}): TrackedSignal {
  const has = <K extends keyof TrackedSignal>(key: K) => Object.prototype.hasOwnProperty.call(overrides, key);

  return {
    id: overrides.id ?? "signal-1",
    scannedAt: overrides.scannedAt ?? "2026-05-07T00:00:00.000Z",
    firstSeenAt: overrides.firstSeenAt ?? overrides.scannedAt ?? "2026-05-07T00:00:00.000Z",
    lastSeenAt: overrides.lastSeenAt ?? overrides.scannedAt ?? "2026-05-07T00:00:00.000Z",
    firstStatus: overrides.firstStatus ?? overrides.finalStatus ?? "READY",
    scanCount: overrides.scanCount ?? 1,
    isDuplicateSuppressed: overrides.isDuplicateSuppressed ?? false,
    normalizedSignalKey: overrides.normalizedSignalKey ?? "BTCUSDT|LONG|INTRADAY_5M_15M_1H|99.00000000:101.00000000|TREND_CONTINUATION",
    timeframeBucket: overrides.timeframeBucket ?? "INTRADAY_5M_15M_1H",
    signalFamily: overrides.signalFamily ?? "TREND_CONTINUATION",
    latestScore: overrides.latestScore ?? overrides.opportunityScore ?? 72,
    latestStatus: overrides.latestStatus ?? overrides.finalStatus ?? "READY",
    latestReason: overrides.latestReason ?? overrides.reason ?? [],
    bestStatus: overrides.bestStatus ?? overrides.finalStatus ?? "READY",
    statusHistory: overrides.statusHistory ?? [{ status: overrides.finalStatus ?? "READY", seenAt: overrides.scannedAt ?? "2026-05-07T00:00:00.000Z" }],
    symbol: overrides.symbol ?? "BTCUSDT",
    direction: overrides.direction ?? "LONG",
    finalStatus: overrides.finalStatus ?? "READY",
    opportunityScore: overrides.opportunityScore ?? 72,
    dangerScore: overrides.dangerScore ?? 28,
    confidence: overrides.confidence ?? 68,
    longScore: overrides.longScore ?? 60,
    shortScore: overrides.shortScore ?? 42,
    kronosScore: overrides.kronosScore ?? 25,
    priceAtScan: overrides.priceAtScan ?? 100,
    entryZone: has("entryZone") ? (overrides.entryZone ?? null) : [99, 101],
    stopLoss: has("stopLoss") ? (overrides.stopLoss ?? null) : 95,
    tp1: has("tp1") ? (overrides.tp1 ?? null) : 105,
    tp2: has("tp2") ? (overrides.tp2 ?? null) : 108,
    tp3: has("tp3") ? (overrides.tp3 ?? null) : 112,
    reason: overrides.reason ?? [],
    directionConflict: overrides.directionConflict ?? false,
    sourceConflict: overrides.sourceConflict ?? false,
    kronosBias: overrides.kronosBias ?? "LONG",
    kronosBias1h: overrides.kronosBias1h ?? null,
    kronosBias4h: overrides.kronosBias4h ?? null,
    selectedKronosBias: overrides.selectedKronosBias ?? overrides.kronosBias ?? "LONG",
    kronosConfidence: overrides.kronosConfidence ?? 70,
    kronosConfidenceBucket: overrides.kronosConfidenceBucket ?? "STRONG",
    expectedReturn1h: overrides.expectedReturn1h ?? null,
    expectedReturn4h: overrides.expectedReturn4h ?? null,
    horizonConflict: overrides.horizonConflict ?? false,
    selectedExecutionPlan: overrides.selectedExecutionPlan ?? null,
    whaleSignal: overrides.whaleSignal ?? "BULLISH",
    whaleScore: overrides.whaleScore ?? 65,
    sentimentSignal: overrides.sentimentSignal ?? "UNAVAILABLE",
    sentimentScore: overrides.sentimentScore ?? 0,
    analysisContext: overrides.analysisContext ?? {
      marketRegime: "Mixed rotation",
      spreadPercent: 0.02,
      riskReward: 2,
      fiveMinuteEma20: 99.5,
      fiveMinuteVwap: 99.25,
      fiveMinuteAtr14: 1.5,
      fiveMinuteAtrPercent: 1.5,
      fiveMinuteVolumeRatio: 1.2,
      fiveMinuteTrend: overrides.direction === "SHORT" ? "BEARISH" : "BULLISH",
      fifteenMinuteTrend: overrides.direction === "SHORT" ? "BEARISH" : "BULLISH",
      oneHourTrend: overrides.direction === "SHORT" ? "BEARISH" : "BULLISH",
      fibonacci: {
        recentHigh: 112,
        recentLow: 92,
        retracement236: 107.28,
        retracement382: 104.36,
        retracement500: 102,
        retracement618: 99.64,
        retracement786: 96.28,
        extension1272: 117.44,
        extension1618: 124.36,
      },
    },
    outcomes: overrides.outcomes ?? {
      "30m": null,
      "1h": {
        checkedAt: "2026-05-07T01:00:00.000Z",
        priceAtCheck: 103,
        priceChangePct: 3,
        maxFavorableExcursionPct: 4,
        maxAdverseExcursionPct: 1,
        rResult: 0.6,
        grossRResult: 0.6,
        netRResult: 0.54,
        outcomeQuality: "VALID_RISK",
        profitableAfterCosts: true,
        slHit: false,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        result: "OPEN",
      },
      "4h": {
        checkedAt: "2026-05-07T04:00:00.000Z",
        priceAtCheck: 106,
        priceChangePct: 6,
        maxFavorableExcursionPct: 9,
        maxAdverseExcursionPct: 2,
        rResult: 1.2,
        grossRResult: 1.2,
        netRResult: 1.14,
        outcomeQuality: "VALID_RISK",
        profitableAfterCosts: true,
        slHit: false,
        tp1Hit: true,
        tp2Hit: false,
        tp3Hit: false,
        result: "TP1",
      },
      "24h": null,
    },
  };
}

describe("computePerformance", () => {
  it("only marks a homogeneous explicitly stamped cohort as post-fix evidence", () => {
    const currentPlan = {
      evidenceEra: CURRENT_EVIDENCE_ERA,
      decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      policyDeploymentAt: END_TO_END_CORRECTNESS_DEPLOYED_AT,
    } as TrackedSignal["selectedExecutionPlan"];
    const current = computePerformance([makeSignal({ id: "current", selectedExecutionPlan: currentPlan })]);
    expect(current.evidenceEra).toBe(CURRENT_EVIDENCE_ERA);
    expect(current.evidencePolicyVersion).toBe(EVIDENCE_POLICY_VERSION);
    expect(current.postFixSignalCount).toBe(1);
    expect(current.legacySignalCount).toBe(0);

    const mixed = computePerformance([
      makeSignal({ id: "current", selectedExecutionPlan: currentPlan }),
      makeSignal({ id: "legacy", selectedExecutionPlan: null }),
    ]);
    expect(mixed.evidenceEra).toBeNull();
    expect(mixed.evidencePolicyVersion).toBeNull();
    expect(mixed.postFixSignalCount).toBe(1);
    expect(mixed.legacySignalCount).toBe(1);
  });

  it("treats a partially stamped migration plan as legacy evidence", () => {
    const partial = {
      evidenceEra: CURRENT_EVIDENCE_ERA,
      decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      policyDeploymentAt: END_TO_END_CORRECTNESS_DEPLOYED_AT,
    } as TrackedSignal["selectedExecutionPlan"];
    const report = computePerformance([makeSignal({ selectedExecutionPlan: partial })]);
    expect(report.postFixSignalCount).toBe(0);
    expect(report.legacySignalCount).toBe(1);
  });

  it("counts Kronos agreement only for matching directional bias and ignores neutral/unavailable", () => {
    const signals: TrackedSignal[] = [
      makeSignal({ id: "agree-long", direction: "LONG", kronosBias: "LONG", kronosConfidenceBucket: "STRONG" }),
      makeSignal({ id: "agree-short", direction: "SHORT", kronosBias: "SHORT", kronosConfidenceBucket: "MEDIUM", whaleSignal: "BEARISH" }),
      makeSignal({ id: "disagree-long", direction: "LONG", kronosBias: "SHORT", kronosConfidenceBucket: "STRONG" }),
      makeSignal({ id: "neutral", direction: "LONG", kronosBias: "NEUTRAL", kronosConfidenceBucket: "WEAK" }),
      makeSignal({ id: "unavailable", direction: "SHORT", kronosBias: "UNAVAILABLE", kronosConfidenceBucket: "WEAK" }),
    ];

    const perf = computePerformance(signals);

    expect(perf.kronosAgreement.agrees.total).toBe(2);
    expect(perf.kronosAgreement.disagrees.total).toBe(1);
    expect(perf.kronosAgreement.unavailable.total).toBe(2);
    expect(perf.windows["4h"].kronosAgreement.agrees.total).toBe(2);
    expect(perf.kronosConfidenceSplit.STRONG.agrees.total).toBe(1);
    expect(perf.kronosConfidenceSplit.STRONG.disagrees.total).toBe(1);
    expect(perf.kronosConfidenceSplit.MEDIUM.agrees.total).toBe(1);
    expect(perf.kronosConfidenceSplit.WEAK.ignored.total).toBe(2);
  });

  it("performance provider is output-equivalent, cacheable, and invalidates on raw history changes", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "performance-provider-test-"));
    const tracker = new SignalTracker(dir);
    const firstSignals = [
      makeSignal({ id: "provider-1", symbol: "BTCUSDT" }),
      makeSignal({ id: "provider-2", symbol: "ETHUSDT", direction: "SHORT", kronosBias: "SHORT", whaleSignal: "BEARISH" }),
    ];
    tracker.writeAllRaw(firstSignals);
    const provider = new PerformanceStatsProvider(tracker);

    const first = provider.getPerformance();
    const direct = computePerformance(tracker.readAllRaw(), tracker.getLastOutcomeCheckerRunAt());
    expect({ ...first.performance, generatedAt: "same" }).toEqual({ ...direct, generatedAt: "same" });
    expect(first.timing.cacheHit).toBe(false);

    const second = provider.getPerformance();
    expect(second.timing.cacheHit).toBe(true);
    expect({ ...second.performance, generatedAt: "same" }).toEqual({ ...direct, generatedAt: "same" });

    tracker.writeAllRaw([...firstSignals, makeSignal({ id: "provider-3", symbol: "SOLUSDT" })]);
    const third = provider.getPerformance();
    expect(third.timing.cacheHit).toBe(false);
    expect(third.performance.rawScans).toBe(3);
  });

  it("uses selected Kronos bias and treats horizon conflict as unavailable for agreement buckets", () => {
    const signals: TrackedSignal[] = [
      makeSignal({
        id: "selected-agree",
        direction: "LONG",
        kronosBias: "SHORT",
        selectedKronosBias: "LONG",
        kronosConfidenceBucket: "STRONG",
      }),
      makeSignal({
        id: "conflicted",
        direction: "LONG",
        kronosBias: "LONG",
        selectedKronosBias: "LONG",
        kronosConfidenceBucket: "STRONG",
        horizonConflict: true,
      }),
    ];

    const perf = computePerformance(signals);

    expect(perf.kronosAgreement.agrees.total).toBe(1);
    expect(perf.kronosAgreement.disagrees.total).toBe(0);
    expect(perf.kronosAgreement.unavailable.total).toBe(1);
    expect(perf.kronosConfidenceSplit.STRONG.agrees.total).toBe(1);
  });

  it("computes low-sample warning, R metrics, and status transition insights", () => {
    const signals: TrackedSignal[] = [
      makeSignal({
        id: "wait-worked",
        finalStatus: "WAIT",
        outcomes: {
          "30m": null,
          "1h": {
            checkedAt: "2026-05-07T01:00:00.000Z",
            priceAtCheck: 104,
            priceChangePct: 4,
            maxFavorableExcursionPct: 5,
            maxAdverseExcursionPct: 1,
            rResult: 0.8,
            grossRResult: 0.8,
            netRResult: 0.74,
            outcomeQuality: "VALID_RISK",
            profitableAfterCosts: true,
            slHit: false,
            tp1Hit: true,
            tp2Hit: false,
            tp3Hit: false,
            result: "TP1",
          },
          "4h": {
            checkedAt: "2026-05-07T04:00:00.000Z",
            priceAtCheck: 107,
            priceChangePct: 7,
            maxFavorableExcursionPct: 10,
            maxAdverseExcursionPct: 1.5,
            rResult: 1.4,
            grossRResult: 1.4,
            netRResult: 1.34,
            outcomeQuality: "VALID_RISK",
            profitableAfterCosts: true,
            slHit: false,
            tp1Hit: true,
            tp2Hit: true,
            tp3Hit: false,
            result: "TP2",
          },
          "24h": null,
        },
      }),
      makeSignal({
        id: "ready-failed",
        symbol: "ETHUSDT",
        direction: "SHORT",
        finalStatus: "READY",
        kronosBias: "SHORT",
        whaleSignal: "BEARISH",
        outcomes: {
          "30m": null,
          "1h": {
            checkedAt: "2026-05-07T01:00:00.000Z",
            priceAtCheck: 98,
            priceChangePct: 2,
            maxFavorableExcursionPct: 2,
            maxAdverseExcursionPct: 4,
            rResult: -0.4,
            grossRResult: -0.4,
            netRResult: -0.46,
            outcomeQuality: "VALID_RISK",
            profitableAfterCosts: false,
            slHit: false,
            tp1Hit: false,
            tp2Hit: false,
            tp3Hit: false,
            result: "OPEN",
          },
          "4h": {
            checkedAt: "2026-05-07T04:00:00.000Z",
            priceAtCheck: 96,
            priceChangePct: -4,
            maxFavorableExcursionPct: 1,
            maxAdverseExcursionPct: 6,
            rResult: -1,
            grossRResult: -1,
            netRResult: -1.06,
            outcomeQuality: "VALID_RISK",
            profitableAfterCosts: false,
            slHit: true,
            tp1Hit: false,
            tp2Hit: false,
            tp3Hit: false,
            result: "SL",
          },
          "24h": null,
        },
      }),
      makeSignal({
        id: "still-open",
        symbol: "SOLUSDT",
        finalStatus: "WATCH",
        kronosBias: "UNAVAILABLE",
        whaleSignal: "UNAVAILABLE",
        outcomes: {
          "30m": null,
          "1h": {
            checkedAt: "2026-05-07T01:00:00.000Z",
            priceAtCheck: 100.5,
            priceChangePct: 0.5,
            maxFavorableExcursionPct: 2,
            maxAdverseExcursionPct: 1,
            rResult: null,
            grossRResult: null,
            netRResult: null,
            outcomeQuality: "INVALID_RISK",
            profitableAfterCosts: false,
            slHit: false,
            tp1Hit: false,
            tp2Hit: false,
            tp3Hit: false,
            result: "OPEN",
          },
          "4h": {
            checkedAt: "2026-05-07T04:00:00.000Z",
            priceAtCheck: 100.5,
            priceChangePct: 0.5,
            maxFavorableExcursionPct: 2,
            maxAdverseExcursionPct: 1,
            rResult: null,
            grossRResult: null,
            netRResult: null,
            outcomeQuality: "INVALID_RISK",
            profitableAfterCosts: false,
            slHit: false,
            tp1Hit: false,
            tp2Hit: false,
            tp3Hit: false,
            result: "OPEN",
          },
          "24h": null,
        },
      }),
    ];

    const perf = computePerformance(signals);

    expect(perf.withOutcome).toBe(3);
    expect(perf.rawScans).toBe(3);
    expect(perf.uniqueTrackedSignals).toBe(3);
    expect(perf.suppressedDuplicateScans).toBe(0);
    expect(perf.primaryWindow).toBe("1h");
    expect(perf.secondaryWindow).toBe("4h");
    expect(perf.resolvedOutcomes).toBe(1);
    expect(perf.openOutcomes).toBe(2);
    expect(perf.activeOpenSignals).toBe(0);
    expect(perf.expiredSignals).toBe(1);
    expect(perf.invalidRiskSignals).toBe(1);
    expect(perf.lowSample).toBe(true);
    expect(perf.statusTransitions.waitWorked).toBe(1);
    expect(perf.statusTransitions.readyFailed).toBe(0);
    expect(perf.byStatus.WATCH.invalidRisk).toBe(1);
    expect(perf.byStatus.WATCH.avgRResult).toBeNull();
    expect(perf.byStatus.WAIT.avgGrossRResult).toBe(1);
    expect(perf.byStatus.WAIT.avgNetRResult).toBeCloseTo(0.94, 3);
    expect(perf.byStatus.WAIT.profitableTp1Hit).toBe(1);
    expect(perf.byStatus.WATCH.avgRUnknownReasons.openOutcome).toBe(1);
    expect(perf.byStatus.READY.avgRResult).toBeNull();
    expect(perf.byStatus.WAIT.tp1Rate).toBe(1);
    expect(perf.byDirection.LONG.avgMaxFavorableExcursionPct).toBeCloseTo(3.5, 5);
    expect(perf.byDirection.LONG.avgMaxAdverseExcursionPct).toBeCloseTo(1, 5);
    expect(perf.windows["4h"].resolvedOutcomes).toBe(2);
    expect(perf.windows["4h"].statusTransitions.readyFailed).toBe(1);
    expect(perf.earlySampleSymbols).toHaveLength(3);
    expect(perf.insights).toHaveLength(6);
    expect(perf.tradeReadiness.find((item) => item.status === "READY")?.recommendation).toContain("30 resolved samples");
    expect(perf.dedupeAudit.duplicateSuppressionWindowMinutes).toBe(60);
    expect(perf.executionCost.roundTripCostBps).toBeGreaterThan(0);
  });

  it("uses unique signals only when legacy duplicates exist", () => {
    const openOutcomes = {
      "30m": null,
      "1h": null,
      "4h": null,
      "24h": null,
    } as TrackedSignal["outcomes"];
    const base = makeSignal({
      id: "dup-1",
      scannedAt: "2026-05-07T00:00:00.000Z",
      firstSeenAt: "2026-05-07T00:00:00.000Z",
      lastSeenAt: "2026-05-07T00:00:00.000Z",
      scanCount: 1,
      latestScore: 72,
      latestStatus: "READY",
      latestReason: ["Test signal"],
      normalizedSignalKey: "BTCUSDT|LONG|INTRADAY_5M_15M_1H|99.00000000:101.00000000|TREND_CONTINUATION",
      outcomes: openOutcomes,
    });
    const duplicate = makeSignal({
      id: "dup-2",
      scannedAt: "2026-05-07T00:10:00.000Z",
      firstSeenAt: "2026-05-07T00:10:00.000Z",
      lastSeenAt: "2026-05-07T00:10:00.000Z",
      scanCount: 1,
      latestScore: 74,
      latestStatus: "READY",
      latestReason: ["Updated signal"],
      normalizedSignalKey: "BTCUSDT|LONG|INTRADAY_5M_15M_1H|99.00000000:101.00000000|TREND_CONTINUATION",
      outcomes: openOutcomes,
    });

    const perf = computePerformance([base, duplicate]);

    expect(perf.totalSignals).toBe(1);
    expect(perf.rawScans).toBe(2);
    expect(perf.uniqueTrackedSignals).toBe(1);
    expect(perf.suppressedDuplicateScans).toBe(1);
    expect(perf.byStatus.READY.total).toBe(1);
  });

  it("treats TP1 as non-profitable when net R is negative after costs", () => {
    const signal = makeSignal({
      id: "tp1-net-negative",
      tp1: 100.25,
      outcomes: {
        "30m": null,
        "1h": {
          checkedAt: "2026-05-07T01:00:00.000Z",
          priceAtCheck: Number.NaN,
          priceChangePct: 0.1,
          maxFavorableExcursionPct: 0.2,
          maxAdverseExcursionPct: 0.05,
          rResult: 0.05,
          grossRResult: 0.05,
          netRResult: -0.03,
          outcomeQuality: "VALID_RISK",
          profitableAfterCosts: false,
          slHit: false,
          tp1Hit: true,
          tp2Hit: false,
          tp3Hit: false,
          result: "TP1",
        },
        "4h": null,
        "24h": null,
      },
    });

    const perf = computePerformance([signal]);

    expect(perf.byStatus.READY.tp1Hit).toBe(1);
    expect(perf.byStatus.READY.profitableTp1Hit).toBe(0);
    expect(perf.byStatus.READY.avgNetRResult).toBeCloseTo(-0.01, 3);
  });

  it("recomputes LONG TP1 gross/net R from resolved legacy outcomes with NaN fields", () => {
    const signal = makeSignal({
      id: "legacy-long-tp1",
      direction: "LONG",
      priceAtScan: 100,
      stopLoss: 95,
      tp1: 105,
      outcomes: {
        "30m": null,
        "1h": {
          checkedAt: "2026-05-07T01:00:00.000Z",
          priceAtCheck: Number.NaN,
          priceChangePct: 0,
          maxFavorableExcursionPct: 5,
          maxAdverseExcursionPct: 1,
          rResult: Number.NaN,
          grossRResult: Number.NaN,
          netRResult: Number.NaN,
          outcomeQuality: "VALID_RISK",
          profitableAfterCosts: false,
          slHit: false,
          tp1Hit: true,
          tp2Hit: false,
          tp3Hit: false,
          result: "TP1",
        },
        "4h": null,
        "24h": null,
      },
    });

    const perf = computePerformance([signal]);

    expect(perf.byStatus.READY.avgGrossRResult).toBeCloseTo(1, 5);
    expect(perf.byStatus.READY.avgNetRResult).toBeCloseTo(0.94, 3);
    expect(perf.byStatus.READY.profitableTp1Hit).toBe(1);
  });

  it("recomputes SHORT TP1 gross/net R from resolved legacy outcomes with NaN fields", () => {
    const signal = makeSignal({
      id: "legacy-short-tp1",
      direction: "SHORT",
      priceAtScan: 100,
      stopLoss: 105,
      tp1: 95,
      outcomes: {
        "30m": null,
        "1h": {
          checkedAt: "2026-05-07T01:00:00.000Z",
          priceAtCheck: Number.NaN,
          priceChangePct: 0,
          maxFavorableExcursionPct: 5,
          maxAdverseExcursionPct: 1,
          rResult: Number.NaN,
          grossRResult: Number.NaN,
          netRResult: Number.NaN,
          outcomeQuality: "VALID_RISK",
          profitableAfterCosts: false,
          slHit: false,
          tp1Hit: true,
          tp2Hit: false,
          tp3Hit: false,
          result: "TP1",
        },
        "4h": null,
        "24h": null,
      },
    });

    const perf = computePerformance([signal]);

    expect(perf.byDirection.SHORT.avgGrossRResult).toBeCloseTo(1, 5);
    expect(perf.byDirection.SHORT.avgNetRResult).toBeCloseTo(0.94, 3);
    expect(perf.byDirection.SHORT.profitableTp1Hit).toBe(1);
  });

  it("recomputes SL net R from stop loss when legacy resolved outcome has NaN fields", () => {
    const signal = makeSignal({
      id: "legacy-sl",
      outcomes: {
        "30m": null,
        "1h": {
          checkedAt: "2026-05-07T01:00:00.000Z",
          priceAtCheck: Number.NaN,
          priceChangePct: 0,
          maxFavorableExcursionPct: 1,
          maxAdverseExcursionPct: 5,
          rResult: Number.NaN,
          grossRResult: Number.NaN,
          netRResult: Number.NaN,
          outcomeQuality: "VALID_RISK",
          profitableAfterCosts: false,
          slHit: true,
          tp1Hit: false,
          tp2Hit: false,
          tp3Hit: false,
          result: "SL",
        },
        "4h": null,
        "24h": null,
      },
    });

    const perf = computePerformance([signal]);

    expect(perf.byStatus.READY.avgGrossRResult).toBe(-1);
    expect(perf.byStatus.READY.avgNetRResult).toBeCloseTo(-1.06, 3);
  });

  it("keeps net edge unknown for invalid risk and missing exit records", () => {
    const invalidRisk = makeSignal({
      id: "invalid-risk",
      symbol: "ETHUSDT",
      normalizedSignalKey: "ETHUSDT|LONG|INTRADAY_5M_15M_1H|99.00000000:101.00000000|TREND_CONTINUATION",
      stopLoss: 100,
      outcomes: {
        "30m": null,
        "1h": {
          checkedAt: "2026-05-07T01:00:00.000Z",
          priceAtCheck: 101,
          priceChangePct: 1,
          maxFavorableExcursionPct: 1,
          maxAdverseExcursionPct: 0.5,
          rResult: Number.NaN,
          grossRResult: Number.NaN,
          netRResult: Number.NaN,
          outcomeQuality: "INVALID_RISK",
          profitableAfterCosts: false,
          slHit: false,
          tp1Hit: false,
          tp2Hit: false,
          tp3Hit: false,
          result: "TP1",
        },
        "4h": null,
        "24h": null,
      },
    });
    const missingExit = makeSignal({
      id: "missing-exit",
      symbol: "SOLUSDT",
      normalizedSignalKey: "SOLUSDT|LONG|INTRADAY_5M_15M_1H|99.00000000:101.00000000|TREND_CONTINUATION",
      tp1: null,
      outcomes: {
        "30m": null,
        "1h": {
          checkedAt: "2026-05-07T01:00:00.000Z",
          priceAtCheck: Number.NaN,
          priceChangePct: 0,
          maxFavorableExcursionPct: 1,
          maxAdverseExcursionPct: 0.5,
          rResult: Number.NaN,
          grossRResult: Number.NaN,
          netRResult: Number.NaN,
          outcomeQuality: "VALID_RISK",
          profitableAfterCosts: false,
          slHit: false,
          tp1Hit: true,
          tp2Hit: false,
          tp3Hit: false,
          result: "TP1",
        },
        "4h": null,
        "24h": null,
      },
    });

    const perf = computePerformance([invalidRisk, missingExit]);

    expect(perf.byStatus.READY.avgNetRResult).toBeNull();
    expect(perf.byStatus.READY.avgRUnknownReasons.invalidRisk).toBeGreaterThan(0);
    expect(perf.byStatus.READY.avgRUnknownReasons.missingExit).toBeGreaterThan(0);
  });

  it("creates shadow entry and exit variants with deterministic net R analytics", () => {
    const signal = makeSignal({
      id: "variant-source",
      direction: "LONG",
      outcomes: {
        "30m": null,
        "1h": {
          checkedAt: "2026-05-07T01:00:00.000Z",
          priceAtCheck: 108,
          priceChangePct: 8,
          maxFavorableExcursionPct: 10,
          maxAdverseExcursionPct: 1,
          rResult: 1.6,
          grossRResult: 1.6,
          netRResult: 1.544,
          outcomeQuality: "VALID_RISK",
          profitableAfterCosts: true,
          slHit: false,
          tp1Hit: true,
          tp2Hit: true,
          tp3Hit: false,
          result: "TP2",
        },
        "4h": null,
        "24h": null,
      },
    });

    const perf = computePerformance([signal]);
    const byKey = new Map(perf.windows["1h"].shadowVariants.map((variant) => [variant.key, variant] as const));

    expect(byKey.get("fib_382_entry")?.signals).toBe(1);
    expect(byKey.get("kronos_runner_exit")?.resolved).toBe(1);
    expect(byKey.get("tp1_fast_exit")?.avgNetRResult).not.toBeNull();
    expect(byKey.get("tp1_50_tp2_runner")?.avgNetRResult).not.toBeNull();
  });

  it("tracks no-chase ATR entry conservatively when price is stretched", () => {
    const signal = makeSignal({
      id: "no-chase",
      priceAtScan: 110,
      entryZone: [100, 101],
      analysisContext: {
        marketRegime: "Mixed rotation",
        spreadPercent: 0.02,
        riskReward: 2,
        fiveMinuteEma20: 101,
        fiveMinuteVwap: 100.8,
        fiveMinuteAtr14: 2,
        fiveMinuteAtrPercent: 1.8,
        fiveMinuteVolumeRatio: 0.8,
        fiveMinuteTrend: "BULLISH",
        fifteenMinuteTrend: "BULLISH",
        oneHourTrend: "BULLISH",
        fibonacci: {
          recentHigh: 114,
          recentLow: 94,
          retracement236: 109.28,
          retracement382: 106.36,
          retracement500: 104,
          retracement618: 101.64,
          retracement786: 98.28,
          extension1272: 119.44,
          extension1618: 126.36,
        },
      },
      outcomes: {
        "30m": null,
        "1h": {
          checkedAt: "2026-05-07T01:00:00.000Z",
          priceAtCheck: 111,
          priceChangePct: 1,
          maxFavorableExcursionPct: 2,
          maxAdverseExcursionPct: 3,
          rResult: 0.2,
          grossRResult: 0.2,
          netRResult: 0.144,
          outcomeQuality: "VALID_RISK",
          profitableAfterCosts: true,
          slHit: false,
          tp1Hit: false,
          tp2Hit: false,
          tp3Hit: false,
          result: "OPEN",
        },
        "4h": null,
        "24h": null,
      },
    });

    const perf = computePerformance([signal]);
    const noChase = perf.windows["1h"].shadowVariants.find((variant) => variant.key === "no_chase_atr_entry");

    expect(noChase?.signals).toBe(1);
    expect(noChase?.open).toBe(1);
    expect(noChase?.avgNetRResult).toBeNull();
  });
});

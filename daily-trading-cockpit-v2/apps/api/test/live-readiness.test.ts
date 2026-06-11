import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildLiveReadinessReport } from "../src/lib/live-readiness.js";

const FOCUS_ENTRY: ExecutionEntryVariant = "fib_500_entry";
const FOCUS_EXIT: ShadowPositionVariant = "tp1_full_exit";

function makeSelection(
  entry: ExecutionEntryVariant,
  exit: ShadowPositionVariant,
  routeMode: VariantSelectionSnapshot["routeMode"],
): VariantSelectionSnapshot {
  return {
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    expectedGrossR: 0,
    expectedNetR: 0,
    netEdgeAfterCost: null,
    profitFactor: null,
    fillRate: null,
    noFillRate: null,
    costR: null,
    spreadR: null,
    feeSlippageR: null,
    stopDistanceBps: null,
    variantSampleSize: 0,
    variantConfidenceTier: "usable",
    routeMode,
    // Stamp evidenceEra so classifyEvidenceEra() returns POST_CALIBRATION for
    // all test positions, matching the era filter used by the alignment check.
    evidenceEra: "POST_CALIBRATION",
    selectionSource: "heuristic_fallback",
    costAssumption: "",
    selectionReason: "",
    entryDriftPct: null,
    entryDriftAtr: null,
    entryQualityExplanation: [],
    exitPlanExplanation: [],
    chaseRisk: "LOW",
  };
}

/**
 * Build a single shadow position with N closed variants.
 * Each "close" is a separate variant slot, simulating distinct closed trades —
 * this matches how shadow records realized R per variant.
 */
function makePosition(opts: {
  id: string;
  entry?: ExecutionEntryVariant;
  exit?: ShadowPositionVariant;
  routeMode?: VariantSelectionSnapshot["routeMode"];
  firstSeenAt?: string;
  /** Per-close: { netR, closedAt (ISO), tp1Hit?, reason? } */
  closes: Array<{
    netR: number;
    closedAt: string;
    tp1Hit?: boolean;
    reason?: "TP1_FULL" | "SL" | "BREAKEVEN" | "TRAIL_STOP";
  }>;
}): ShadowPosition {
  const entry = opts.entry ?? FOCUS_ENTRY;
  const exit = opts.exit ?? FOCUS_EXIT;
  const routeMode = opts.routeMode ?? "PROFIT_CANDIDATE";
  const firstSeenAt = opts.firstSeenAt ?? opts.closes[0]?.closedAt ?? "2026-05-01T00:00:00.000Z";
  const variants = opts.closes.map((c) => ({
    variant: exit,
    state: "CLOSED" as const,
    openedAt: firstSeenAt,
    lastUpdatedAt: c.closedAt,
    closedAt: c.closedAt,
    remainingSizePct: 0,
    realizedGrossR: c.netR,
    realizedNetR: c.netR,
    tp1Hit: c.tp1Hit ?? (c.netR > 0),
    tp2Hit: false,
    tp3Hit: false,
    slHit: (c.reason ?? (c.netR < 0 ? "SL" : "TP1_FULL")) === "SL",
    closeReason: c.reason ?? (c.netR < 0 ? "SL" : "TP1_FULL"),
  }));
  return {
    id: opts.id,
    ideaKey: opts.id,
    symbol: "BTCUSDT",
    direction: "LONG",
    signalFamily: "BREAKOUT",
    scannedAt: firstSeenAt,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    lastEvaluatedAt: firstSeenAt,
    scanCount: 1,
    latestStatus: "READY",
    latestScore: 60,
    latestReason: [],
    entryZone: [99, 101],
    entryPrice: 100,
    stopLoss: 97,
    tp1: 103,
    tp2: 105,
    tp3: 108,
    riskReward: 2,
    dangerScore: 30,
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    variantSelection: makeSelection(entry, exit, routeMode),
    primaryVariant: exit,
    tradePlan: {
      entryZone: [99, 101], stopLoss: 97, tp1: 103, tp2: 105, tp3: 108,
      riskReward: 2, runnerAllowed: false, reason: "", explanation: "", contextExplanation: [],
      trailing: { active: false, mode: "NONE", anchor: null, distancePct: null, distanceR: null, explanation: [] },
      partialPlan: { tp1Action: "FULL_EXIT", tp1ExitPct: 100, breakevenAfterTp1: true, runnerPct: 0, runnerInvalidations: [] },
      timing: { entryAction: "ENTER_ON_TRIGGER", entryAnchor: "MID_ZONE", waitForCloseConfirmation: false, cancelIfInvalidated: true, reentryRule: "NO_REENTRY", driftWarning: null },
      playbook: { entryPlaybook: "PULLBACK_RECLAIM", exitMode: "TP1_FAST", confidence: 0.6 },
      biasSummary: "", contextSummary: "",
    },
    variants,
  };
}

/**
 * Build a healthy 100-trade dataset spread across 10 days that passes ALL gates.
 * Per day: 8 winners @ +0.4R, 2 losers @ -0.5R.
 * Totals: 80 wins (+32R) + 20 losses (-10R) = +22R net / 100 = +0.22 netAvgR.
 * PF = 32/10 = 3.2, SL rate = 20%, TP1 profitable rate = 100% (only wins set tp1Hit),
 * max losing streak = 2, every day net positive.
 */
function buildHealthyDataset(referenceDate: string): ShadowPosition[] {
  const closes: Array<{ netR: number; closedAt: string; tp1Hit: boolean; reason: "TP1_FULL" | "SL" }> = [];
  const ref = new Date(referenceDate).getTime();
  for (let dayIdx = 9; dayIdx >= 0; dayIdx -= 1) {
    const dayStart = new Date(ref - dayIdx * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 10; i += 1) {
      const isWinner = i < 8;
      const time = new Date(dayStart.getTime() + (i + 1) * 60 * 60 * 1000).toISOString();
      closes.push(
        isWinner
          ? { netR: 0.4, closedAt: time, tp1Hit: true, reason: "TP1_FULL" }
          : { netR: -0.5, closedAt: time, tp1Hit: false, reason: "SL" },
      );
    }
  }
  return [makePosition({ id: "healthy", closes })];
}

describe("buildLiveReadinessReport — hard gates", () => {
  const NOW = "2026-05-15T23:00:00.000Z";
  const now = new Date(NOW);

  it("liveReady=false when closed sample < 100", () => {
    const positions = [
      makePosition({
        id: "few",
        closes: Array.from({ length: 50 }, (_, i) => ({
          netR: 0.3,
          closedAt: `2026-05-${String(5 + (i % 10)).padStart(2, "0")}T10:00:00.000Z`,
          tp1Hit: true,
          reason: "TP1_FULL" as const,
        })),
      }),
    ];
    const r = buildLiveReadinessReport({ positions }, now);
    expect(r.liveReady).toBe(false);
    expect(r.failedGates).toContain("CLOSED_SAMPLE_SUFFICIENT");
    expect(r.closedSampleCount).toBe(50);
  });

  it("liveReady=false when PF <= 1.3", () => {
    // 100 closes: 50 winners @ +0.3R, 50 losers @ -0.3R → PF = 1.0
    const closes: Array<{ netR: number; closedAt: string; tp1Hit: boolean; reason: "TP1_FULL" | "SL" }> = [];
    for (let i = 0; i < 100; i += 1) {
      const day = String(5 + (i % 10)).padStart(2, "0");
      const isWin = i % 2 === 0;
      closes.push({
        netR: isWin ? 0.3 : -0.3,
        closedAt: `2026-05-${day}T${String(10 + (i % 6)).padStart(2, "0")}:00:00.000Z`,
        tp1Hit: isWin,
        reason: isWin ? "TP1_FULL" : "SL",
      });
    }
    const r = buildLiveReadinessReport({ positions: [makePosition({ id: "pf", closes })] }, now);
    expect(r.liveReady).toBe(false);
    expect(r.failedGates).toContain("PROFIT_FACTOR_OK");
  });

  it("liveReady=false when netAvgR <= 0.15", () => {
    // 100 closes averaging ~0.05R → just above zero but below gate
    const closes = Array.from({ length: 100 }, (_, i) => {
      const day = String(5 + (i % 10)).padStart(2, "0");
      const isWin = i % 5 !== 0; // 80 winners +0.1, 20 losers -0.15 → avg = 0.05
      return {
        netR: isWin ? 0.1 : -0.15,
        closedAt: `2026-05-${day}T${String(10 + (i % 6)).padStart(2, "0")}:00:00.000Z`,
        tp1Hit: isWin,
        reason: (isWin ? "TP1_FULL" : "SL") as "TP1_FULL" | "SL",
      };
    });
    const r = buildLiveReadinessReport({ positions: [makePosition({ id: "net", closes })] }, now);
    expect(r.liveReady).toBe(false);
    expect(r.failedGates).toContain("NET_AVG_R_POSITIVE");
  });

  it("liveReady=false when SL rate too high", () => {
    // 100 closes: 50% wins, 50% SL → SL rate = 50%, exceeds 35% cap
    const closes = Array.from({ length: 100 }, (_, i) => {
      const day = String(5 + (i % 10)).padStart(2, "0");
      const isWin = i % 2 === 0;
      return {
        netR: isWin ? 1.0 : -0.5,
        closedAt: `2026-05-${day}T${String(10 + (i % 6)).padStart(2, "0")}:00:00.000Z`,
        tp1Hit: isWin,
        reason: (isWin ? "TP1_FULL" : "SL") as "TP1_FULL" | "SL",
      };
    });
    const r = buildLiveReadinessReport({ positions: [makePosition({ id: "sl", closes })] }, now);
    expect(r.failedGates).toContain("SL_RATE_OK");
    expect(r.liveReady).toBe(false);
  });

  it("liveReady=false when Kronos source is unhealthy", () => {
    const positions = buildHealthyDataset(NOW);
    const r = buildLiveReadinessReport({ positions, kronos: { healthy: false } }, now);
    expect(r.failedGates).toContain("KRONOS_HEALTHY");
    expect(r.warningEvents).toContain("KRONOS_DEGRADED");
    expect(r.liveReady).toBe(false);
  });

  it("liveReady=true only when all gates pass", () => {
    const positions = buildHealthyDataset(NOW);
    const r = buildLiveReadinessReport({ positions, kronos: { healthy: true }, binanceCoverage: 1.0 }, now);
    if (!r.liveReady) {
      // Surface which gate failed to make debugging future regressions easier.
      throw new Error(`expected liveReady=true, failed gates: ${r.failedGates.join(", ")}`);
    }
    expect(r.liveReady).toBe(true);
    expect(r.score).toBe(100);
    expect(r.failedGates).toEqual([]);
    expect(r.passedGates.length).toBe(10);
  });
});

describe("buildLiveReadinessReport — risk events do not gate shadow", () => {
  const NOW = "2026-05-15T23:00:00.000Z";
  const now = new Date(NOW);

  it("warning events surface but do not affect shadow positions count", () => {
    // 100 closes, mostly fine, but with a -2.5R day today and bad recent losses.
    // The point is: warningEvents fire, but the report does not return any field
    // that suggests shadow execution should stop.
    const closes: Array<{ netR: number; closedAt: string; tp1Hit: boolean; reason: "TP1_FULL" | "SL" }> = [];
    for (let i = 0; i < 97; i += 1) {
      const day = String(5 + (i % 10)).padStart(2, "0");
      closes.push({
        netR: 0.4,
        closedAt: `2026-05-${day}T10:00:00.000Z`,
        tp1Hit: true,
        reason: "TP1_FULL",
      });
    }
    // Three back-to-back losses today summing to -3R
    closes.push({ netR: -1, closedAt: "2026-05-15T18:00:00.000Z", tp1Hit: false, reason: "SL" });
    closes.push({ netR: -1, closedAt: "2026-05-15T19:00:00.000Z", tp1Hit: false, reason: "SL" });
    closes.push({ netR: -1, closedAt: "2026-05-15T20:00:00.000Z", tp1Hit: false, reason: "SL" });

    const positions = [makePosition({ id: "warn", closes })];
    const r = buildLiveReadinessReport({ positions }, now);

    // Risk events surfaced
    expect(r.warningEvents).toContain("DAILY_NET_R_BELOW_NEG_2");
    expect(r.warningEvents).toContain("THREE_CONSECUTIVE_LOSSES");

    // But the report is purely descriptive — closedSampleCount reflects ALL
    // collected closes (no filtering by risk). 100 closes recorded.
    expect(r.closedSampleCount).toBe(100);

    // And the report does not expose any "stop shadow" / "block trades" field.
    const reportKeys = Object.keys(r);
    expect(reportKeys).not.toContain("stopShadow");
    expect(reportKeys).not.toContain("blockNewTrades");
    expect(reportKeys).not.toContain("dailyLossCap");
  });

  it("excludes non-fib500+tp1_full and non-PROFIT_CANDIDATE positions from the gate", () => {
    const positions = [
      // Eligible: fib_500 + tp1_full + PROFIT_CANDIDATE
      makePosition({
        id: "eligible", entry: "fib_500_entry", exit: "tp1_full_exit", routeMode: "PROFIT_CANDIDATE",
        closes: [{ netR: 0.5, closedAt: "2026-05-15T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" }],
      }),
      // Wrong route: DATA_COLLECTION
      makePosition({
        id: "data", entry: "fib_500_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        closes: Array.from({ length: 50 }, (_, i) => ({
          netR: 1.0, closedAt: `2026-05-${String(5 + (i % 10)).padStart(2, "0")}T11:00:00.000Z`,
          tp1Hit: true, reason: "TP1_FULL" as const,
        })),
      }),
      // Wrong variants: different entry
      makePosition({
        id: "other-entry", entry: "vwap_retest_entry", exit: "tp1_full_exit", routeMode: "PROFIT_CANDIDATE",
        closes: Array.from({ length: 50 }, (_, i) => ({
          netR: 1.0, closedAt: `2026-05-${String(5 + (i % 10)).padStart(2, "0")}T12:00:00.000Z`,
          tp1Hit: true, reason: "TP1_FULL" as const,
        })),
      }),
    ];
    const r = buildLiveReadinessReport({ positions }, now);
    // Only the 1 eligible close counts
    expect(r.closedSampleCount).toBe(1);
  });

  it("estimates days to 100-closed-sample target based on recent pace", () => {
    // 20 closes in the last 7 days → ~3/day → ~27 days to reach 100
    const closes = Array.from({ length: 20 }, (_, i) => {
      const dayOffset = i % 7;
      const closedAt = new Date(new Date(NOW).getTime() - dayOffset * 24 * 60 * 60 * 1000).toISOString();
      return { netR: 0.4, closedAt, tp1Hit: true, reason: "TP1_FULL" as const };
    });
    const positions = [makePosition({ id: "pace", closes })];
    const r = buildLiveReadinessReport({ positions }, now);
    expect(r.recentClosesPerDay).not.toBeNull();
    expect(r.estimatedDaysToTarget).not.toBeNull();
    expect((r.estimatedDaysToTarget ?? 0)).toBeGreaterThan(0);
  });

  it("route under evaluation is locked to fib_500_entry + tp1_full_exit", () => {
    const r = buildLiveReadinessReport({ positions: [] }, now);
    expect(r.routeUnderEvaluation).toEqual({ entryVariant: "fib_500_entry", exitVariant: "tp1_full_exit" });
    // Empty input: all gates fail (no data), but report still returns.
    expect(r.liveReady).toBe(false);
    expect(r.failedGates.length).toBeGreaterThan(0);
  });
});

describe("buildLiveReadinessReport — route alignment", () => {
  const NOW = "2026-05-15T23:00:00.000Z";
  const now = new Date(NOW);

  it("routeAlignmentStatus=NO_LEADING_COHORT when no POST_CALIBRATION position has a close", () => {
    // Positions with no closes → no leading cohort in maturity report
    const positions = [
      makePosition({ id: "open-only", closes: [] }),
    ];
    const r = buildLiveReadinessReport({ positions }, now);
    expect(r.routeAlignmentStatus).toBe("NO_LEADING_COHORT");
    expect(r.leadingMaturityCohort).toBeNull();
    expect(r.lockedEvaluationRoute).toEqual({
      entryVariant: "fib_500_entry",
      exitVariant: "tp1_full_exit",
      label: "fib_500_entry + tp1_full_exit",
    });
    expect(r.routeAlignmentMessage).toBeTruthy();
  });

  it("routeAlignmentStatus=MATCH when fib_500_entry+tp1_full_exit leads POST_CALIBRATION maturity", () => {
    // fib_500 + tp1_full PROFIT_CANDIDATE (in scope for maturity) has 2 closes;
    // no other cohort has any → fib_500+tp1_full is the leading cohort
    const positions = [
      makePosition({
        id: "fib-lead",
        entry: "fib_500_entry",
        exit: "tp1_full_exit",
        routeMode: "PROFIT_CANDIDATE",
        closes: [
          { netR: 0.4, closedAt: "2026-05-14T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" },
          { netR: 0.3, closedAt: "2026-05-15T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" },
        ],
      }),
    ];
    const r = buildLiveReadinessReport({ positions }, now);
    expect(r.routeAlignmentStatus).toBe("MATCH");
    expect(r.leadingMaturityCohort).not.toBeNull();
    expect(r.leadingMaturityCohort?.entryVariant).toBe("fib_500_entry");
    expect(r.leadingMaturityCohort?.exitVariant).toBe("tp1_full_exit");
    expect(r.leadingMaturityCohort?.eraFilter).toBe("POST_CALIBRATION");
    expect(r.routeAlignmentMessage).toMatch(/matches the locked evaluation route/i);
  });

  it("routeAlignmentStatus=MISMATCH when a different cohort leads POST_CALIBRATION maturity", () => {
    // vwap_retest (DATA_COLLECTION) has 3 closes, fib_500 has 0 live closes →
    // maturity leader is vwap_retest, which differs from the locked gate route
    const positions = [
      makePosition({
        id: "vwap-lead",
        entry: "vwap_retest_entry",
        exit: "tp1_full_exit",
        routeMode: "DATA_COLLECTION",
        closes: [
          { netR: 0.2, closedAt: "2026-05-13T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" },
          { netR: 0.3, closedAt: "2026-05-14T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" },
          { netR: -0.1, closedAt: "2026-05-15T10:00:00.000Z", tp1Hit: false, reason: "SL" },
        ],
      }),
    ];
    const r = buildLiveReadinessReport({ positions }, now);
    expect(r.routeAlignmentStatus).toBe("MISMATCH");
    expect(r.leadingMaturityCohort?.entryVariant).toBe("vwap_retest_entry");
    expect(r.leadingMaturityCohort?.exitVariant).toBe("tp1_full_exit");
    expect(r.routeAlignmentMessage).toMatch(/differs from the locked evaluation route/i);
    // Alignment must not affect gate score — score is driven purely by gate
    // results. With 0 fib_500 live closes, data-independent gates still pass
    // (MAX_LOSING_STREAK_OK, DATA_COVERAGE_OK, KRONOS_HEALTHY) → score = 30.
    expect(r.score).toBe(30);
  });

  it("score and liveReady are not affected by routeAlignmentStatus", () => {
    // Build the healthy dataset (all gates pass) — alignment is MATCH because
    // the healthy dataset uses fib_500+tp1_full PROFIT_CANDIDATE
    const positions = buildHealthyDataset(NOW);
    const r = buildLiveReadinessReport({ positions, kronos: { healthy: true }, binanceCoverage: 1.0 }, now);
    // Alignment should be MATCH (fib_500 leads the maturity as the only cohort)
    expect(r.routeAlignmentStatus).toBe("MATCH");
    // Score and liveReady remain driven purely by gates, not alignment
    expect(r.score).toBe(100);
    expect(r.liveReady).toBe(true);
    // Adding a mismatch scenario: inject vwap with more closes, re-check score stays same
    const vwapPositions = Array.from({ length: 10 }, (_, i) =>
      makePosition({
        id: `vwap-${i}`,
        entry: "vwap_retest_entry",
        exit: "tp1_full_exit",
        routeMode: "DATA_COLLECTION",
        closes: [{ netR: 0.5, closedAt: `2026-05-${String(5 + (i % 10)).padStart(2, "0")}T10:00:00.000Z`, tp1Hit: true, reason: "TP1_FULL" }],
      }),
    );
    const mixedPositions = [...positions, ...vwapPositions];
    const r2 = buildLiveReadinessReport({ positions: mixedPositions, kronos: { healthy: true }, binanceCoverage: 1.0 }, now);
    // vwap now has 10 closes vs fib_500's 100; fib_500 still wins
    expect(r2.routeAlignmentStatus).toBe("MATCH");
    expect(r2.score).toBe(100);
    expect(r2.liveReady).toBe(true);
  });
});

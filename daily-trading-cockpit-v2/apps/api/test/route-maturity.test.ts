import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildRouteMaturityReport, type CohortMaturity } from "../src/lib/route-maturity.js";

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
    variantConfidenceTier: "provisional",
    routeMode,
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

function makePosition(opts: {
  id: string;
  entry?: ExecutionEntryVariant;
  exit?: ShadowPositionVariant;
  routeMode?: VariantSelectionSnapshot["routeMode"];
  firstSeenAt?: string;
  lastSeenAt?: string;
  closes: Array<{
    netR: number;
    closedAt: string;
    tp1Hit?: boolean;
    reason?: "TP1_FULL" | "SL" | "BREAKEVEN" | "TRAIL_STOP";
  }>;
}): ShadowPosition {
  const entry = opts.entry ?? FOCUS_ENTRY;
  const exit = opts.exit ?? FOCUS_EXIT;
  const routeMode = opts.routeMode ?? "DATA_COLLECTION";
  const firstSeenAt = opts.firstSeenAt ?? opts.closes[0]?.closedAt ?? "2026-05-01T00:00:00.000Z";
  const lastSeenAt = opts.lastSeenAt ?? firstSeenAt;
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
    id: opts.id, ideaKey: opts.id, symbol: "BTCUSDT", direction: "LONG", signalFamily: "BREAKOUT",
    scannedAt: firstSeenAt, firstSeenAt, lastSeenAt, lastEvaluatedAt: lastSeenAt,
    scanCount: 1, latestStatus: "READY", latestScore: 60, latestReason: [],
    entryZone: [99, 101], entryPrice: 100, stopLoss: 97, tp1: 103, tp2: 105, tp3: 108,
    riskReward: 2, dangerScore: 30,
    selectedEntryVariant: entry, selectedExitVariant: exit,
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

function findCohort(cohorts: CohortMaturity[], entry: string, exit: string): CohortMaturity | undefined {
  return cohorts.find((c) => c.entryVariant === entry && c.exitVariant === exit);
}

describe("buildRouteMaturityReport — scope", () => {
  const NOW = "2026-05-20T12:00:00.000Z";
  const now = new Date(NOW);

  it("includes DATA_COLLECTION + PROFIT_CANDIDATE positions in their cohorts", () => {
    const positions = [
      makePosition({
        id: "dc", routeMode: "DATA_COLLECTION",
        closes: [{ netR: 0.5, closedAt: "2026-05-19T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" }],
      }),
      makePosition({
        id: "pc", routeMode: "PROFIT_CANDIDATE",
        closes: [{ netR: 0.3, closedAt: "2026-05-19T11:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" }],
      }),
    ];
    const r = buildRouteMaturityReport({ positions }, now);
    const cohort = findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit");
    expect(cohort).toBeDefined();
    expect(cohort!.totalIdeas).toBe(2);
    expect(cohort!.closedCount).toBe(2);
    expect(cohort!.routeModeDistribution.DATA_COLLECTION).toBe(1);
    expect(cohort!.routeModeDistribution.PROFIT_CANDIDATE).toBe(1);
  });

  it("excludes RESEARCH_ONLY positions entirely", () => {
    const positions = [
      makePosition({
        id: "ro", routeMode: "RESEARCH_ONLY",
        closes: Array.from({ length: 10 }, (_, i) => ({
          netR: -0.5, closedAt: `2026-05-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`,
          tp1Hit: false, reason: "SL" as const,
        })),
      }),
      makePosition({
        id: "dc", routeMode: "DATA_COLLECTION",
        closes: [{ netR: 0.5, closedAt: "2026-05-19T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" }],
      }),
    ];
    const r = buildRouteMaturityReport({ positions }, now);
    const cohort = findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!;
    // Only the 1 DATA_COLLECTION close counts; RESEARCH_ONLY excluded.
    expect(cohort.closedCount).toBe(1);
    expect(cohort.netAvgR).toBe(0.5);
  });

  it("scope is locked to DATA_COLLECTION + PROFIT_CANDIDATE", () => {
    const r = buildRouteMaturityReport({ positions: [] }, now);
    expect(r.scope.includes).toEqual(["DATA_COLLECTION", "PROFIT_CANDIDATE"]);
    expect(r.scope.excludes).toEqual(["RESEARCH_ONLY"]);
  });
});

describe("buildRouteMaturityReport — cohort grouping", () => {
  const NOW = "2026-05-20T12:00:00.000Z";
  const now = new Date(NOW);

  it("groups positions by selectedEntryVariant + selectedExitVariant", () => {
    const positions = [
      makePosition({
        id: "a", entry: "fib_500_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        closes: [{ netR: 0.5, closedAt: "2026-05-19T10:00:00.000Z" }],
      }),
      makePosition({
        id: "b", entry: "fib_500_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        closes: [{ netR: 0.3, closedAt: "2026-05-19T11:00:00.000Z" }],
      }),
      makePosition({
        id: "c", entry: "vwap_retest_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        closes: [{ netR: -0.2, closedAt: "2026-05-19T12:00:00.000Z" }],
      }),
      makePosition({
        id: "d", entry: "fib_382_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        closes: [{ netR: 1.0, closedAt: "2026-05-19T13:00:00.000Z" }],
      }),
    ];
    const r = buildRouteMaturityReport({ positions }, now);
    const fib500 = findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!;
    const vwap = findCohort(r.cohorts, "vwap_retest_entry", "tp1_full_exit")!;
    const fib382 = findCohort(r.cohorts, "fib_382_entry", "tp1_full_exit")!;
    expect(fib500.totalIdeas).toBe(2);
    expect(fib500.closedCount).toBe(2);
    expect(vwap.totalIdeas).toBe(1);
    expect(fib382.totalIdeas).toBe(1);
  });

  it("always includes priority cohorts (fib_500, vwap_retest, fib_382 with tp1_full) even with zero samples", () => {
    const r = buildRouteMaturityReport({ positions: [] }, now);
    expect(findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")).toBeDefined();
    expect(findCohort(r.cohorts, "vwap_retest_entry", "tp1_full_exit")).toBeDefined();
    expect(findCohort(r.cohorts, "fib_382_entry", "tp1_full_exit")).toBeDefined();
    // Each starts at COLLECTING with 0 closed.
    expect(findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!.maturityStatus).toBe("COLLECTING");
    expect(findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!.isPriorityCohort).toBe(true);
  });

  it("priority cohorts are sorted to the top of the cohorts list", () => {
    const positions = [
      // Non-priority cohort with lots of data
      makePosition({
        id: "big", entry: "ema20_pullback_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        closes: Array.from({ length: 25 }, (_, i) => ({
          netR: 0.3, closedAt: `2026-05-${String(10 + (i % 10)).padStart(2, "0")}T10:00:00.000Z`,
        })),
      }),
      // Priority cohort with little data
      makePosition({
        id: "small-prio", entry: "fib_500_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        closes: [{ netR: 0.4, closedAt: "2026-05-19T10:00:00.000Z" }],
      }),
    ];
    const r = buildRouteMaturityReport({ positions }, now);
    // Priority cohorts come first regardless of sample size.
    expect(r.cohorts[0].isPriorityCohort).toBe(true);
  });
});

describe("buildRouteMaturityReport — maturity status", () => {
  const NOW = "2026-05-20T12:00:00.000Z";
  const now = new Date(NOW);

  it("COLLECTING when closed < 15", () => {
    const positions = [
      makePosition({
        id: "few", routeMode: "DATA_COLLECTION",
        closes: Array.from({ length: 10 }, (_, i) => ({
          netR: 1.0, closedAt: `2026-05-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`,
          tp1Hit: true, reason: "TP1_FULL" as const,
        })),
      }),
    ];
    const r = buildRouteMaturityReport({ positions }, now);
    expect(findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!.maturityStatus).toBe("COLLECTING");
  });

  it("PROMISING at ≥15 closed with net>0 and PF>1", () => {
    const wins = Array.from({ length: 11 }, (_, i) => ({
      netR: 0.4, closedAt: `2026-05-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`,
      tp1Hit: true, reason: "TP1_FULL" as const,
    }));
    const losses = Array.from({ length: 5 }, (_, i) => ({
      netR: -0.3, closedAt: `2026-05-${String(10 + i).padStart(2, "0")}T14:00:00.000Z`,
      tp1Hit: false, reason: "SL" as const,
    }));
    const positions = [makePosition({ id: "p", routeMode: "DATA_COLLECTION", closes: [...wins, ...losses] })];
    const r = buildRouteMaturityReport({ positions }, now);
    expect(findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!.maturityStatus).toBe("PROMISING");
  });

  it("PROMOTABLE at ≥30 closed with net>0.10, PF>1.2, TP1prof>50%, SL<40%", () => {
    const closes: Array<{ netR: number; closedAt: string; tp1Hit: boolean; reason: "TP1_FULL" | "SL" }> = [];
    for (let i = 0; i < 22; i += 1) {
      closes.push({
        netR: 0.5, closedAt: `2026-05-${String(5 + (i % 10)).padStart(2, "0")}T${String(10 + (i % 8)).padStart(2, "0")}:00:00.000Z`,
        tp1Hit: true, reason: "TP1_FULL",
      });
    }
    for (let i = 0; i < 8; i += 1) {
      closes.push({
        netR: -0.3, closedAt: `2026-05-${String(5 + (i % 10)).padStart(2, "0")}T${String(18 + (i % 4)).padStart(2, "0")}:00:00.000Z`,
        tp1Hit: false, reason: "SL",
      });
    }
    const r = buildRouteMaturityReport(
      { positions: [makePosition({ id: "p", routeMode: "DATA_COLLECTION", closes })] },
      now,
    );
    expect(findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!.maturityStatus).toBe("PROMOTABLE");
  });

  it("DEGRADING when all-time net>0 but recent net<0", () => {
    // Old history: 14 wins @ +0.5 (way more than 7 days ago)
    // Recent week: 5 losses @ -0.4 → recent net negative
    // Old history is far enough away that recent window only sees the 5 losses.
    const old = Array.from({ length: 14 }, (_, i) => ({
      netR: 0.5, closedAt: `2026-04-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`,
      tp1Hit: true, reason: "TP1_FULL" as const,
    }));
    const recent = Array.from({ length: 5 }, (_, i) => ({
      netR: -0.4,
      closedAt: new Date(new Date(NOW).getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
      tp1Hit: false, reason: "SL" as const,
    }));
    const positions = [makePosition({ id: "p", routeMode: "DATA_COLLECTION", closes: [...old, ...recent] })];
    const r = buildRouteMaturityReport({ positions }, now);
    const cohort = findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!;
    expect(cohort.closedCount).toBe(19);
    expect((cohort.netAvgR ?? 0)).toBeGreaterThan(0);
    expect((cohort.recentNetAvgR ?? 0)).toBeLessThan(0);
    expect(cohort.maturityStatus).toBe("DEGRADING");
  });

  it("WEAK when sample sufficient but not positive enough for PROMISING", () => {
    // 20 closes, all break-even/slight negative — fails PROMISING & not COLLECTING
    const closes = Array.from({ length: 20 }, (_, i) => ({
      netR: -0.05,
      closedAt: `2026-05-${String(5 + i).padStart(2, "0")}T10:00:00.000Z`,
      tp1Hit: false, reason: "SL" as const,
    }));
    const positions = [makePosition({ id: "p", routeMode: "DATA_COLLECTION", closes })];
    const r = buildRouteMaturityReport({ positions }, now);
    const cohort = findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!;
    expect(cohort.closedCount).toBe(20);
    expect(cohort.maturityStatus).toBe("WEAK");
  });
});

describe("buildRouteMaturityReport — pace and leadership", () => {
  const NOW = "2026-05-20T12:00:00.000Z";
  const now = new Date(NOW);

  it("estimates days to 30 and 100 closed from recent activity", () => {
    // 14 closes within last 7 days → 2/day average
    const closes = Array.from({ length: 14 }, (_, i) => {
      const dayOffset = i % 7;
      const closedAt = new Date(new Date(NOW).getTime() - dayOffset * 24 * 60 * 60 * 1000 + i * 1000).toISOString();
      return { netR: 0.4, closedAt, tp1Hit: true, reason: "TP1_FULL" as const };
    });
    const positions = [makePosition({ id: "p", routeMode: "DATA_COLLECTION", closes })];
    const r = buildRouteMaturityReport({ positions }, now);
    const cohort = findCohort(r.cohorts, "fib_500_entry", "tp1_full_exit")!;
    expect(cohort.recentClosedCount).toBe(14);
    expect(cohort.estimatedDaysTo30Closed).not.toBeNull();
    expect(cohort.estimatedDaysTo100Closed).not.toBeNull();
    // Need 16 more for 30 at 2/day → 8 days; 86 more for 100 → 43 days
    expect(cohort.estimatedDaysTo30Closed).toBe(8);
    expect(cohort.estimatedDaysTo100Closed).toBe(43);
  });

  it("leadingCohort picks the priority/selected cohort with the most closed samples", () => {
    const positions = [
      makePosition({
        id: "fib500", entry: "fib_500_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        lastSeenAt: NOW,
        closes: Array.from({ length: 5 }, (_, i) => ({
          netR: 0.4, closedAt: `2026-05-19T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
          tp1Hit: true, reason: "TP1_FULL" as const,
        })),
      }),
      makePosition({
        id: "vwap", entry: "vwap_retest_entry", exit: "tp1_full_exit", routeMode: "DATA_COLLECTION",
        lastSeenAt: NOW,
        closes: [{ netR: 0.3, closedAt: "2026-05-19T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" }],
      }),
    ];
    const r = buildRouteMaturityReport({ positions }, now);
    expect(r.leadingCohort).toEqual({ entryVariant: "fib_500_entry", exitVariant: "tp1_full_exit" });
  });

  it("leadingCohort is null when no cohort has any closes", () => {
    const r = buildRouteMaturityReport({ positions: [] }, now);
    expect(r.leadingCohort).toBeNull();
  });
});

describe("buildRouteMaturityReport — era filtering", () => {
  const NOW = "2026-05-20T12:00:00.000Z";
  const now = new Date(NOW);

  // Helper that returns a position with a configurable era stamp
  function makeWithStamp(opts: {
    id: string;
    stampEra?: "POST_CALIBRATION" | "POST_ROUTING_PRE_CALIBRATION" | "LEGACY_PRE_ROUTING";
    closes: Array<{ netR: number; closedAt: string }>;
  }): ShadowPosition {
    const base = makePosition({
      id: opts.id,
      routeMode: "DATA_COLLECTION",
      closes: opts.closes,
    });
    if (opts.stampEra === "LEGACY_PRE_ROUTING") {
      // Drop the entire variantSelection so the classifier returns LEGACY_PRE_ROUTING
      return { ...base, variantSelection: undefined as unknown as VariantSelectionSnapshot };
    }
    if (opts.stampEra === "POST_ROUTING_PRE_CALIBRATION") {
      // routeMode set but no calibration fields
      const { calibratedExpectedNetR, calibrationVerdict, calibrationConfidence, evidenceEra, ...rest } =
        base.variantSelection as VariantSelectionSnapshot & Record<string, unknown>;
      void calibratedExpectedNetR; void calibrationVerdict; void calibrationConfidence; void evidenceEra;
      return { ...base, variantSelection: rest as VariantSelectionSnapshot };
    }
    // POST_CALIBRATION: explicitly stamp
    return {
      ...base,
      variantSelection: {
        ...base.variantSelection,
        calibratedExpectedNetR: 0.1,
        calibrationVerdict: "CALIBRATED_POSITIVE",
        evidenceEra: "POST_CALIBRATION",
      } as VariantSelectionSnapshot,
    };
  }

  it("POST_CALIBRATION filter (default) excludes legacy and pre-calibration positions", () => {
    const positions = [
      makeWithStamp({ id: "legacy", stampEra: "LEGACY_PRE_ROUTING", closes: [{ netR: -1.0, closedAt: "2026-05-15T10:00:00.000Z" }] }),
      makeWithStamp({ id: "preCal", stampEra: "POST_ROUTING_PRE_CALIBRATION", closes: [{ netR: -0.5, closedAt: "2026-05-15T10:00:00.000Z" }] }),
      makeWithStamp({ id: "cal", stampEra: "POST_CALIBRATION", closes: [{ netR: 0.4, closedAt: "2026-05-15T10:00:00.000Z" }] }),
    ];
    const r = buildRouteMaturityReport({ positions, eraFilter: "POST_CALIBRATION" }, now);
    expect(r.eraFilter).toBe("POST_CALIBRATION");
    const cohort = r.cohorts.find((c) => c.entryVariant === "fib_500_entry" && c.exitVariant === "tp1_full_exit");
    expect(cohort?.closedCount).toBe(1);
    expect(cohort?.netAvgR).toBeCloseTo(0.4, 4);
  });

  it("ALL_TIME filter includes legacy + post-calibration when both carry an entry/exit variant", () => {
    // LEGACY_PRE_ROUTING strips variantSelection → cohort grouping can't pin
    // it to a specific entry/exit. Use POST_ROUTING_PRE_CALIBRATION here so
    // both positions land in the fib_500_entry+tp1_full_exit cohort under
    // ALL_TIME.
    const positions = [
      makeWithStamp({ id: "preCal", stampEra: "POST_ROUTING_PRE_CALIBRATION", closes: [{ netR: -0.5, closedAt: "2026-05-15T10:00:00.000Z" }] }),
      makeWithStamp({ id: "cal", stampEra: "POST_CALIBRATION", closes: [{ netR: 0.4, closedAt: "2026-05-15T10:00:00.000Z" }] }),
    ];
    const r = buildRouteMaturityReport({ positions, eraFilter: "ALL_TIME" }, now);
    const cohort = r.cohorts.find((c) => c.entryVariant === "fib_500_entry" && c.exitVariant === "tp1_full_exit");
    expect(cohort?.closedCount).toBe(2);
  });

  it("ALL_TIME with LEGACY_PRE_ROUTING positions doesn't crash — they land under no cohort", () => {
    const positions = [
      makeWithStamp({ id: "legacy", stampEra: "LEGACY_PRE_ROUTING", closes: [{ netR: -1.0, closedAt: "2026-05-15T10:00:00.000Z" }] }),
      makeWithStamp({ id: "cal", stampEra: "POST_CALIBRATION", closes: [{ netR: 0.4, closedAt: "2026-05-15T10:00:00.000Z" }] }),
    ];
    const r = buildRouteMaturityReport({ positions, eraFilter: "ALL_TIME" }, now);
    const cohort = r.cohorts.find((c) => c.entryVariant === "fib_500_entry" && c.exitVariant === "tp1_full_exit");
    // Legacy w/o variantSelection has no entry/exit; only the calibrated position
    // contributes to the cohort row.
    expect(cohort?.closedCount).toBe(1);
  });

  it("POST_ROUTING filter includes routing+calibration but not legacy", () => {
    const positions = [
      makeWithStamp({ id: "legacy", stampEra: "LEGACY_PRE_ROUTING", closes: [{ netR: -1.0, closedAt: "2026-05-15T10:00:00.000Z" }] }),
      makeWithStamp({ id: "preCal", stampEra: "POST_ROUTING_PRE_CALIBRATION", closes: [{ netR: -0.5, closedAt: "2026-05-15T10:00:00.000Z" }] }),
      makeWithStamp({ id: "cal", stampEra: "POST_CALIBRATION", closes: [{ netR: 0.4, closedAt: "2026-05-15T10:00:00.000Z" }] }),
    ];
    const r = buildRouteMaturityReport({ positions, eraFilter: "POST_ROUTING" }, now);
    const cohort = r.cohorts.find((c) => c.entryVariant === "fib_500_entry" && c.exitVariant === "tp1_full_exit");
    expect(cohort?.closedCount).toBe(2);
  });
});

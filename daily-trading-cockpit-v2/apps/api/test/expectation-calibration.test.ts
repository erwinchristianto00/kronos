import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import {
  buildExpectationCalibrationReport,
  extractCalibrationPoints,
  type CalibrationGroup,
  type DiagnosisCode,
} from "../src/lib/expectation-calibration.js";

function makeSelection(
  entry: ExecutionEntryVariant,
  exit: ShadowPositionVariant,
  routeMode: VariantSelectionSnapshot["routeMode"],
  expectedNetR: number,
  overrides: Partial<VariantSelectionSnapshot> = {},
): VariantSelectionSnapshot {
  return {
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    expectedGrossR: expectedNetR + 0.1,
    expectedNetR,
    netEdgeAfterCost: expectedNetR,
    profitFactor: null,
    fillRate: null,
    noFillRate: null,
    costR: 0.2,
    spreadR: 0.05,
    feeSlippageR: 0.15,
    stopDistanceBps: 35,
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
    routeReasonCodes: [],
    ...overrides,
  };
}

interface PositionOpts {
  id: string;
  symbol?: string;
  direction?: "LONG" | "SHORT";
  entry?: ExecutionEntryVariant;
  exit?: ShadowPositionVariant;
  routeMode?: VariantSelectionSnapshot["routeMode"];
  expectedNetR?: number;
  selectionOverrides?: Partial<VariantSelectionSnapshot>;
  /** If absent, the position has no closed primary variant (open state). */
  realizedNetR?: number;
  realizedGrossR?: number;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  closeReason?: "TP1_FULL" | "SL" | "BREAKEVEN" | "TRAIL_STOP" | "TP2" | "TP3" | "OPEN" | "NO_FILL";
  costR?: number;
  stopDistanceBps?: number;
}

function makePosition(opts: PositionOpts): ShadowPosition {
  const entry = opts.entry ?? "fib_500_entry";
  const exit = opts.exit ?? "tp1_full_exit";
  const routeMode = opts.routeMode ?? "PROFIT_CANDIDATE";
  const expectedNetR = opts.expectedNetR ?? 0.3;
  const realized = opts.realizedNetR;
  const closeReason =
    opts.closeReason ?? (realized === undefined ? "OPEN" : realized > 0 ? "TP1_FULL" : "SL");
  const variant: ShadowPositionVariant = exit;
  const variantRecord =
    realized === undefined
      ? {
          variant,
          state: "OPEN" as const,
          openedAt: "2026-05-10T10:00:00.000Z",
          lastUpdatedAt: "2026-05-10T10:00:00.000Z",
          closedAt: null,
          remainingSizePct: 1,
          realizedGrossR: 0,
          realizedNetR: 0,
          tp1Hit: false,
          tp2Hit: false,
          tp3Hit: false,
          slHit: false,
          closeReason: "OPEN" as const,
        }
      : {
          variant,
          state: "CLOSED" as const,
          openedAt: "2026-05-10T10:00:00.000Z",
          lastUpdatedAt: "2026-05-10T11:00:00.000Z",
          closedAt: "2026-05-10T11:00:00.000Z",
          remainingSizePct: 0,
          realizedGrossR: opts.realizedGrossR ?? realized,
          realizedNetR: realized,
          tp1Hit: opts.tp1Hit ?? realized > 0,
          tp2Hit: opts.tp2Hit ?? false,
          tp3Hit: false,
          slHit: closeReason === "SL" || closeReason === "BREAKEVEN",
          closeReason,
        };
  return {
    id: opts.id,
    ideaKey: opts.id,
    symbol: opts.symbol ?? "BTCUSDT",
    direction: opts.direction ?? "LONG",
    signalFamily: "BREAKOUT",
    scannedAt: "2026-05-10T10:00:00.000Z",
    firstSeenAt: "2026-05-10T10:00:00.000Z",
    lastSeenAt: "2026-05-10T10:00:00.000Z",
    lastEvaluatedAt: "2026-05-10T11:00:00.000Z",
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
    costR: opts.costR ?? 0.2,
    feeSlippageR: 0.15,
    spreadR: 0.05,
    stopDistanceBps: opts.stopDistanceBps ?? 35,
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    variantSelection: makeSelection(entry, exit, routeMode, expectedNetR, opts.selectionOverrides),
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
    variants: [variantRecord],
  };
}

function findGroup(groups: CalibrationGroup[], suffix: string): CalibrationGroup | undefined {
  return groups.find((g) => g.key.endsWith(suffix));
}

describe("extractCalibrationPoints — inclusion", () => {
  it("includes only closed primary-variant positions", () => {
    const positions = [
      makePosition({ id: "closed", expectedNetR: 0.3, realizedNetR: 0.4 }),
      makePosition({ id: "open" }),
    ];
    const points = extractCalibrationPoints(positions);
    expect(points.length).toBe(1);
    expect(points[0].positionId).toBe("closed");
  });

  it("excludes NO_FILL closes", () => {
    const positions = [
      makePosition({ id: "nofill", expectedNetR: 0.3, realizedNetR: 0, closeReason: "NO_FILL" }),
      makePosition({ id: "real", expectedNetR: 0.3, realizedNetR: 0.4 }),
    ];
    const points = extractCalibrationPoints(positions);
    expect(points.length).toBe(1);
    expect(points[0].positionId).toBe("real");
  });

  it("captures selection-time expected R and close-time realized R", () => {
    const positions = [
      makePosition({ id: "p", expectedNetR: 1.7, realizedNetR: -0.5, closeReason: "SL" }),
    ];
    const [pt] = extractCalibrationPoints(positions);
    expect(pt.expectedNetR).toBe(1.7);
    expect(pt.realizedNetR).toBe(-0.5);
    expect(pt.closeReason).toBe("SL");
    expect(pt.slHit).toBe(true);
  });
});

describe("buildExpectationCalibrationReport — overestimation detection", () => {
  it("counts expected-positive + realized-negative as overestimation", () => {
    const positions = [
      makePosition({ id: "1", expectedNetR: 0.3, realizedNetR: -0.4 }),
      makePosition({ id: "2", expectedNetR: 0.6, realizedNetR: -0.3 }),
      makePosition({ id: "3", expectedNetR: 0.2, realizedNetR: 0.4 }), // accurate
    ];
    const r = buildExpectationCalibrationReport({ positions });
    expect(r.total.count).toBe(3);
    expect(r.total.overestimationRate).toBeCloseTo(2 / 3, 4);
    expect((r.total.expectationError ?? 0)).toBeGreaterThan(0);
  });

  it("detects severe overestimation: expected ≥ +0.5 but realized ≤ -0.5", () => {
    const positions = [
      makePosition({ id: "s1", expectedNetR: 1.71, realizedNetR: -0.6 }),
      makePosition({ id: "s2", expectedNetR: 0.7, realizedNetR: -0.8 }),
      makePosition({ id: "ok", expectedNetR: 0.4, realizedNetR: 0.3 }),
    ];
    const r = buildExpectationCalibrationReport({ positions });
    expect(r.total.severeOverestimationRate).toBeCloseTo(2 / 3, 4);
  });

  it("avgRealizedWhenExpectedPositive reflects realized outcomes for positively-expected trades", () => {
    const positions = [
      makePosition({ id: "a", expectedNetR: 0.5, realizedNetR: -0.3 }),
      makePosition({ id: "b", expectedNetR: 0.5, realizedNetR: -0.1 }),
      makePosition({ id: "c", expectedNetR: -0.2, realizedNetR: 0.1 }),
    ];
    const r = buildExpectationCalibrationReport({ positions });
    expect(r.total.hitRateWhenExpectedPositive).toBe(0);
    expect(r.total.avgRealizedWhenExpectedPositive).toBeCloseTo(-0.2, 4);
    expect(r.total.avgRealizedWhenExpectedNegative).toBeCloseTo(0.1, 4);
  });
});

describe("buildExpectationCalibrationReport — grouping", () => {
  it("groups by entry+exit combo independently", () => {
    const positions = [
      makePosition({ id: "fib1", entry: "fib_500_entry", exit: "tp1_full_exit", expectedNetR: 0.5, realizedNetR: -0.4 }),
      makePosition({ id: "fib2", entry: "fib_500_entry", exit: "tp1_full_exit", expectedNetR: 0.5, realizedNetR: -0.5 }),
      makePosition({ id: "fib3", entry: "fib_500_entry", exit: "tp1_full_exit", expectedNetR: 0.5, realizedNetR: -0.6 }),
      makePosition({ id: "vwap1", entry: "vwap_retest_entry", exit: "tp1_full_exit", expectedNetR: 0.3, realizedNetR: 0.4 }),
      makePosition({ id: "vwap2", entry: "vwap_retest_entry", exit: "tp1_full_exit", expectedNetR: 0.3, realizedNetR: 0.5 }),
      makePosition({ id: "vwap3", entry: "vwap_retest_entry", exit: "tp1_full_exit", expectedNetR: 0.3, realizedNetR: 0.6 }),
    ];
    const r = buildExpectationCalibrationReport({ positions });
    const fib = findGroup(r.byCombo, ":fib_500_entry__tp1_full_exit");
    const vwap = findGroup(r.byCombo, ":vwap_retest_entry__tp1_full_exit");
    expect(fib).toBeDefined();
    expect(vwap).toBeDefined();
    expect(fib!.count).toBe(3);
    expect(vwap!.count).toBe(3);
    expect((fib!.expectationError ?? 0)).toBeGreaterThan(0); // overestimated
    expect((vwap!.expectationError ?? 0)).toBeLessThan(0); // underestimated
  });

  it("topOverestimatedCombos surfaces the worst overestimators (≥3 closed)", () => {
    const positions = [
      // Big overestimator: 3 closes with expected +0.5 but realized -0.5
      makePosition({ id: "bad1", entry: "fib_500_entry", expectedNetR: 0.5, realizedNetR: -0.5 }),
      makePosition({ id: "bad2", entry: "fib_500_entry", expectedNetR: 0.5, realizedNetR: -0.5 }),
      makePosition({ id: "bad3", entry: "fib_500_entry", expectedNetR: 0.5, realizedNetR: -0.5 }),
      // Tiny sample (excluded from top tables)
      makePosition({ id: "small", entry: "vwap_retest_entry", expectedNetR: 0.5, realizedNetR: -0.5 }),
      makePosition({ id: "small2", entry: "vwap_retest_entry", expectedNetR: 0.5, realizedNetR: -0.5 }),
    ];
    const r = buildExpectationCalibrationReport({ positions });
    expect(r.topOverestimatedCombos.length).toBe(1);
    expect(r.topOverestimatedCombos[0].key).toBe("combo:fib_500_entry__tp1_full_exit");
  });

  it("RESEARCH_ONLY appears in byRouteMode but separately from DATA_COLLECTION / PROFIT_CANDIDATE", () => {
    const positions = [
      makePosition({ id: "ro1", routeMode: "RESEARCH_ONLY", expectedNetR: 0.5, realizedNetR: -0.6 }),
      makePosition({ id: "ro2", routeMode: "RESEARCH_ONLY", expectedNetR: 0.5, realizedNetR: -0.5 }),
      makePosition({ id: "ro3", routeMode: "RESEARCH_ONLY", expectedNetR: 0.5, realizedNetR: -0.4 }),
      makePosition({ id: "dc1", routeMode: "DATA_COLLECTION", expectedNetR: 0.2, realizedNetR: 0.1 }),
      makePosition({ id: "pc1", routeMode: "PROFIT_CANDIDATE", expectedNetR: 0.3, realizedNetR: 0.2 }),
    ];
    const r = buildExpectationCalibrationReport({ positions });
    const ro = findGroup(r.byRouteMode, ":RESEARCH_ONLY");
    const dc = findGroup(r.byRouteMode, ":DATA_COLLECTION");
    const pc = findGroup(r.byRouteMode, ":PROFIT_CANDIDATE");
    expect(ro).toBeDefined();
    expect(dc).toBeDefined();
    expect(pc).toBeDefined();
    expect(ro!.count).toBe(3);
    expect(dc!.count).toBe(1);
    expect(pc!.count).toBe(1);
  });
});

describe("buildExpectationCalibrationReport — diagnosis codes", () => {
  function diag(g: CalibrationGroup | undefined): DiagnosisCode[] {
    return g?.diagnosis ?? [];
  }

  it("HEURISTIC_OVERCONFIDENT fires when expected>0, realized<0, with severe overestimation", () => {
    const positions = Array.from({ length: 6 }, (_, i) =>
      makePosition({ id: `h${i}`, expectedNetR: 0.8, realizedNetR: -0.7, closeReason: "SL" }),
    );
    const r = buildExpectationCalibrationReport({ positions });
    expect(diag(r.total)).toContain("HEURISTIC_OVERCONFIDENT");
  });

  it("TP_NOT_PROFITABLE_AFTER_COST fires when TP1 hit rate high but realized net negative", () => {
    // 5 closes: all TP1-hit but realized -0.05 (after-cost loss despite reaching TP1)
    const positions = Array.from({ length: 5 }, (_, i) =>
      makePosition({
        id: `tp${i}`,
        expectedNetR: 0.1,
        realizedNetR: -0.05,
        tp1Hit: true,
        closeReason: "TP1_FULL",
      }),
    );
    const r = buildExpectationCalibrationReport({ positions });
    expect(r.total.context.tp1HitRate).toBeGreaterThan(0.5);
    expect(diag(r.total)).toContain("TP_NOT_PROFITABLE_AFTER_COST");
  });

  it("STOP_TOO_TIGHT fires when avg stop distance is very small and SL rate high", () => {
    const positions = Array.from({ length: 6 }, (_, i) =>
      makePosition({
        id: `s${i}`,
        expectedNetR: 0.2,
        realizedNetR: -0.5,
        closeReason: "SL",
        stopDistanceBps: 12,
      }),
    );
    const r = buildExpectationCalibrationReport({ positions });
    expect(diag(r.total)).toContain("STOP_TOO_TIGHT");
  });

  it("ROUTE_SAMPLE_TOO_SMALL fires when group count < 5", () => {
    const positions = [
      makePosition({ id: "1", expectedNetR: 0.3, realizedNetR: 0.4 }),
      makePosition({ id: "2", expectedNetR: 0.3, realizedNetR: 0.4 }),
    ];
    const r = buildExpectationCalibrationReport({ positions });
    expect(diag(r.total)).toContain("ROUTE_SAMPLE_TOO_SMALL");
  });

  it("SYMBOL_HISTORICAL_DRAG fires on symbol groups with realized < -0.10", () => {
    const positions = Array.from({ length: 5 }, (_, i) =>
      makePosition({
        id: `bad${i}`,
        symbol: "BADCOIN",
        expectedNetR: 0.3,
        realizedNetR: -0.5,
      }),
    );
    const r = buildExpectationCalibrationReport({ positions });
    const sym = findGroup(r.bySymbol, ":BADCOIN");
    expect(diag(sym)).toContain("SYMBOL_HISTORICAL_DRAG");
    // But total shouldn't carry SYMBOL_HISTORICAL_DRAG (it's symbol-specific)
    expect(diag(r.total)).not.toContain("SYMBOL_HISTORICAL_DRAG");
  });

  it("DIRECTION_BIAS_DRAG fires on direction groups with realized < -0.10", () => {
    const positions = Array.from({ length: 5 }, (_, i) =>
      makePosition({
        id: `sh${i}`,
        direction: "SHORT",
        expectedNetR: 0.3,
        realizedNetR: -0.4,
      }),
    );
    const r = buildExpectationCalibrationReport({ positions });
    const dir = findGroup(r.byDirection, ":SHORT");
    expect(diag(dir)).toContain("DIRECTION_BIAS_DRAG");
  });

  it("UNKNOWN is the last-resort diagnosis when no rule matches", () => {
    // Well-calibrated, large enough sample, no flags
    const positions = Array.from({ length: 6 }, (_, i) =>
      makePosition({
        id: `ok${i}`,
        expectedNetR: 0.3,
        realizedNetR: 0.28,
        tp1Hit: true,
        closeReason: "TP1_FULL",
      }),
    );
    const r = buildExpectationCalibrationReport({ positions });
    expect(diag(r.total)).toEqual(["UNKNOWN"]);
  });
});

describe("buildExpectationCalibrationReport — post-calibration summary", () => {
  function makeCalibrated(id: string, raw: number, calibrated: number, realized: number): ShadowPosition {
    // Position with calibration fields stamped; treated as POST_CALIBRATION era.
    const p = makePosition({ id, expectedNetR: raw, realizedNetR: realized });
    return {
      ...p,
      variantSelection: {
        ...p.variantSelection,
        calibratedExpectedNetR: calibrated,
        calibrationVerdict: "CALIBRATED_NEGATIVE",
        evidenceEra: "POST_CALIBRATION",
        decisionPolicyVersion: "calibrated-expectancy-v1",
      },
    };
  }

  it("computes raw vs calibrated expectation error and improvement ratio", () => {
    const positions = [
      // Raw expected +0.5, calibrated +0.2, realized -0.1 → rawErr=+0.6, calErr=+0.3 → 50% improvement
      makeCalibrated("a", 0.5, 0.2, -0.1),
      makeCalibrated("b", 0.5, 0.2, -0.1),
      makeCalibrated("c", 0.5, 0.2, -0.1),
    ];
    const r = buildExpectationCalibrationReport({ positions });
    expect(r.postCalibration.postCalibrationClosedSample).toBe(3);
    expect(r.postCalibration.postCalibrationAvgRawExpectedR).toBeCloseTo(0.5, 4);
    expect(r.postCalibration.postCalibrationAvgCalibratedExpectedR).toBeCloseTo(0.2, 4);
    expect(r.postCalibration.postCalibrationAvgRealizedR).toBeCloseTo(-0.1, 4);
    expect(r.postCalibration.postCalibrationExpectationErrorRaw).toBeCloseTo(0.6, 4);
    expect(r.postCalibration.postCalibrationExpectationErrorCalibrated).toBeCloseTo(0.3, 4);
    expect(r.postCalibration.rawVsCalibratedErrorImprovement).toBeCloseTo(0.5, 4);
  });

  it("returns zero-sample summary when no post-calibration record exists", () => {
    // Make a plain position with no calibration fields → not part of post-calibration subset
    const positions = [makePosition({ id: "x", expectedNetR: 0.4, realizedNetR: -0.5 })];
    const r = buildExpectationCalibrationReport({ positions });
    expect(r.postCalibration.postCalibrationClosedSample).toBe(0);
    expect(r.postCalibration.postCalibrationAvgRealizedR).toBeNull();
    expect(r.postCalibration.rawVsCalibratedErrorImprovement).toBeNull();
  });
});

describe("buildExpectationCalibrationReport — no behavioral side effects", () => {
  it("does not mutate the input positions", () => {
    const positions = [
      makePosition({ id: "1", expectedNetR: 0.5, realizedNetR: -0.5 }),
      makePosition({ id: "2", expectedNetR: 0.5, realizedNetR: 0.4 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(positions));
    buildExpectationCalibrationReport({ positions });
    expect(positions).toEqual(snapshot);
  });

  it("report response has no field that could be interpreted as 'stop shadow' / 'block trades'", () => {
    const r = buildExpectationCalibrationReport({ positions: [] });
    const keys = Object.keys(r);
    expect(keys).not.toContain("stopShadow");
    expect(keys).not.toContain("blockNewTrades");
    expect(keys).not.toContain("dailyLossCap");
    expect(keys).not.toContain("changeRouting");
  });
});

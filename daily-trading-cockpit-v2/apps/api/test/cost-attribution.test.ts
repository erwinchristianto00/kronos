import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildCostAttributionReport } from "../src/lib/cost-attribution.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelection(
  entry: ExecutionEntryVariant,
  exit: ShadowPositionVariant,
  routeMode: VariantSelectionSnapshot["routeMode"],
  overrides: Partial<VariantSelectionSnapshot> = {},
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
    costR: 0.03,
    spreadR: 0.02,
    feeSlippageR: 0.01,
    stopDistanceBps: 150,
    variantSampleSize: 0,
    variantConfidenceTier: "usable",
    routeMode,
    evidenceEra: "POST_CALIBRATION",
    selectionSource: "heuristic_fallback",
    costAssumption: "model",
    selectionReason: "",
    entryDriftPct: null,
    entryDriftAtr: null,
    entryQualityExplanation: [],
    exitPlanExplanation: [],
    chaseRisk: "LOW",
    ...overrides,
  };
}

function makePosition(opts: {
  id: string;
  symbol?: string;
  entry?: ExecutionEntryVariant;
  exit?: ShadowPositionVariant;
  routeMode?: VariantSelectionSnapshot["routeMode"];
  evidenceEra?: VariantSelectionSnapshot["evidenceEra"];
  selectionOverrides?: Partial<VariantSelectionSnapshot>;
  positionCostR?: number | null;
  positionSpreadR?: number | null;
  positionFeeSlippageR?: number | null;
  stopDistanceBps?: number | null;
  entryFillReason?: string;
  closes: Array<{
    grossR: number;
    netR: number;
    closedAt: string;
    tp1Hit?: boolean;
    reason?: "TP1_FULL" | "SL" | "BREAKEVEN";
  }>;
}): ShadowPosition {
  const entry = opts.entry ?? "fib_500_entry";
  const exit = opts.exit ?? "tp1_full_exit";
  const routeMode = opts.routeMode ?? "DATA_COLLECTION";
  const era = opts.evidenceEra ?? "POST_CALIBRATION";
  const firstSeenAt = opts.closes[0]?.closedAt ?? "2026-05-01T00:00:00.000Z";
  const sel = makeSelection(entry, exit, routeMode, {
    evidenceEra: era,
    ...(opts.selectionOverrides ?? {}),
  });

  const variants = opts.closes.map((c) => ({
    variant: exit,
    state: "CLOSED" as const,
    openedAt: firstSeenAt,
    lastUpdatedAt: c.closedAt,
    closedAt: c.closedAt,
    remainingSizePct: 0,
    realizedGrossR: c.grossR,
    realizedNetR: c.netR,
    unrealizedR: 0,
    currentPrice: 100,
    stopPrice: null,
    tp1Hit: c.tp1Hit ?? (c.netR > 0),
    tp2Hit: false,
    tp3Hit: false,
    slMovedToBreakeven: false,
    closeReason: c.reason ?? (c.netR < 0 ? "SL" : "TP1_FULL"),
    profitableAfterCosts: c.netR > 0,
  }));

  return {
    id: opts.id,
    ideaKey: opts.id,
    symbol: opts.symbol ?? "BTCUSDT",
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
    variantSelection: sel,
    primaryVariant: exit,
    stopDistanceBps: opts.stopDistanceBps ?? null,
    costR: opts.positionCostR ?? null,
    spreadR: opts.positionSpreadR ?? null,
    feeSlippageR: opts.positionFeeSlippageR ?? null,
    entryFillReason: opts.entryFillReason,
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildCostAttributionReport — empty and safe defaults", () => {
  it("returns a valid safe report with no positions", () => {
    const r = buildCostAttributionReport({ positions: [] });
    expect(r.summary.positionCount).toBe(0);
    expect(r.summary.closedVariantCount).toBe(0);
    expect(r.summary.avgActualCostR).toBeNull();
    expect(r.summary.avgModelCostR).toBeNull();
    expect(r.summary.costOverrunR).toBeNull();
    expect(r.summary.hasCostData).toBe(false);
    expect(r.bySymbol).toEqual([]);
    expect(r.flags).toBeDefined();
    expect(r.interpretation).toBeTruthy();
    expect(r.notes.length).toBeGreaterThan(0);
    // No trading mutation fields
    expect(Object.keys(r)).not.toContain("stopShadow");
    expect(Object.keys(r)).not.toContain("routeMode");
  });
});

describe("buildCostAttributionReport — era filter", () => {
  it("excludes non-POST_CALIBRATION positions", () => {
    const legacyPos = makePosition({
      id: "legacy",
      evidenceEra: "LEGACY_PRE_ROUTING",
      closes: [{ grossR: 0.5, netR: 0.45, closedAt: "2026-04-01T10:00:00.000Z" }],
    });
    const currentPos = makePosition({
      id: "current",
      evidenceEra: "POST_CALIBRATION",
      closes: [{ grossR: 0.4, netR: 0.37, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({
      positions: [legacyPos, currentPos],
      eraFilter: "POST_CALIBRATION",
    });
    expect(r.summary.positionCount).toBe(1);
    expect(r.summary.closedVariantCount).toBe(1);
  });

  it("includes all positions when eraFilter is ALL", () => {
    const legacyPos = makePosition({
      id: "legacy2", evidenceEra: "LEGACY_PRE_ROUTING",
      closes: [{ grossR: 0.5, netR: 0.45, closedAt: "2026-04-01T10:00:00.000Z" }],
    });
    const currentPos = makePosition({
      id: "current2", evidenceEra: "POST_CALIBRATION",
      closes: [{ grossR: 0.4, netR: 0.37, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [legacyPos, currentPos], eraFilter: "ALL" });
    expect(r.summary.positionCount).toBe(2);
    expect(r.summary.closedVariantCount).toBe(2);
  });
});

describe("buildCostAttributionReport — cost stats", () => {
  it("computes avgActualCostR = grossR − netR correctly", () => {
    // gross 0.5, net 0.35 → realized cost = 0.15
    const pos = makePosition({
      id: "cost1",
      closes: [{ grossR: 0.5, netR: 0.35, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    expect(r.summary.avgActualCostR).toBeCloseTo(0.15, 4);
  });

  it("computes avgModelCostR from variantSelection.costR", () => {
    // model costR = 0.03 (set in makeSelection defaults)
    const pos = makePosition({
      id: "cost2",
      closes: [{ grossR: 0.5, netR: 0.35, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    // variantSelection.costR = 0.03
    expect(r.summary.avgModelCostR).toBeCloseTo(0.03, 4);
  });

  it("computes costOverrunR and marks model as uncalibrated when overrun > 30%", () => {
    // actual cost = 0.15, model = 0.03 → overrun = 0.12 = 400% → CRITICAL
    const pos = makePosition({
      id: "overrun",
      selectionOverrides: { costR: 0.03 },
      closes: [{ grossR: 0.5, netR: 0.35, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    expect(r.summary.costOverrunR).toBeCloseTo(0.12, 4);
    expect(r.summary.costModelCalibrated).toBe(false);
    expect(r.flags.some((f) => f.code === "COST_MODEL_UNDERESTIMATED")).toBe(true);
  });

  it("marks model as calibrated when overrun is within ±30%", () => {
    // actual cost = 0.032, model = 0.03 → overrun ≈ 6.7% → calibrated
    const pos = makePosition({
      id: "calibrated",
      selectionOverrides: { costR: 0.03 },
      closes: [{ grossR: 0.4, netR: 0.368, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    expect(r.summary.costModelCalibrated).toBe(true);
    expect(r.flags.some((f) => f.code === "COST_MODEL_ACCURATE")).toBe(true);
    expect(r.flags.some((f) => f.code === "COST_MODEL_UNDERESTIMATED")).toBe(false);
  });

  it("uses position-level costR when available over variantSelection", () => {
    // position.costR = 0.05 should override variantSelection.costR = 0.03
    const pos = makePosition({
      id: "pos-cost",
      positionCostR: 0.05,
      selectionOverrides: { costR: 0.03 }, // should be overridden
      closes: [{ grossR: 0.4, netR: 0.36, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    // actual cost = 0.04, model = 0.05 (position-level wins)
    expect(r.summary.avgModelCostR).toBeCloseTo(0.05, 4);
  });
});

describe("buildCostAttributionReport — bySymbol", () => {
  it("groups by symbol and sorts by worst totalNetRContribution", () => {
    const bnb = makePosition({
      id: "bnb", symbol: "BNBUSDT",
      closes: [
        { grossR: 0.1, netR: -0.9, closedAt: "2026-05-01T10:00:00.000Z" },
        { grossR: 0.1, netR: -0.8, closedAt: "2026-05-02T10:00:00.000Z" },
      ],
    });
    const btc = makePosition({
      id: "btc", symbol: "BTCUSDT",
      closes: [{ grossR: 0.5, netR: 0.4, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [bnb, btc] });
    expect(r.bySymbol.length).toBe(2);
    // BNBUSDT has -1.7 total net R → worst
    expect(r.bySymbol[0].symbol).toBe("BNBUSDT");
    expect(r.bySymbol[0].totalNetRContribution).toBeCloseTo(-1.7, 3);
    expect(r.bySymbol[0].closedCount).toBe(2);
    expect(r.bySymbol[0].avgActualCostR).toBeCloseTo(0.95, 3); // avg of (0.1-(-0.9)=1.0) and (0.1-(-0.8)=0.9)
  });

  it("computes per-symbol cost overrun", () => {
    const pos = makePosition({
      id: "sym-overrun", symbol: "ETHUSDT",
      selectionOverrides: { costR: 0.03 },
      closes: [{ grossR: 0.5, netR: 0.2, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    const ethRow = r.bySymbol.find((s) => s.symbol === "ETHUSDT");
    expect(ethRow).toBeDefined();
    expect(ethRow!.avgActualCostR).toBeCloseTo(0.3, 4); // 0.5 - 0.2
    expect(ethRow!.avgModelCostR).toBeCloseTo(0.03, 4);
    expect(ethRow!.overrunR).toBeCloseTo(0.27, 4);
  });
});

describe("buildCostAttributionReport — entry fill quality", () => {
  it("captures entry drift stats from variantSelection", () => {
    const pos = makePosition({
      id: "drift",
      selectionOverrides: { entryDriftPct: 0.65, entryDriftAtr: 0.8 },
      closes: [{ grossR: 0.3, netR: 0.27, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    expect(r.entryFillQuality.positionsWithFillData).toBe(1);
    expect(r.entryFillQuality.avgEntryDriftPct).toBeCloseTo(0.65, 3);
    expect(r.entryFillQuality.avgEntryDriftAtr).toBeCloseTo(0.8, 3);
    expect(r.entryFillQuality.highDriftCount).toBe(1); // drift > 50%
  });

  it("flags ENTRY_DRIFT_ELEVATED when avg drift > 30%", () => {
    const pos = makePosition({
      id: "high-drift",
      selectionOverrides: { entryDriftPct: 0.55 },
      closes: [{ grossR: 0.3, netR: 0.27, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    expect(r.flags.some((f) => f.code === "ENTRY_DRIFT_ELEVATED")).toBe(true);
  });

  it("flags NARROW_STOP_DISTANCE when avg stop < 100bps", () => {
    const pos = makePosition({
      id: "narrow",
      selectionOverrides: { stopDistanceBps: 60 },
      closes: [{ grossR: 0.3, netR: 0.27, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos] });
    expect(r.flags.some((f) => f.code === "NARROW_STOP_DISTANCE")).toBe(true);
  });

  it("captures fill reason distribution", () => {
    const pos1 = makePosition({
      id: "fill1", entryFillReason: "ZONE_TOUCH",
      closes: [{ grossR: 0.3, netR: 0.27, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const pos2 = makePosition({
      id: "fill2", entryFillReason: "ZONE_TOUCH",
      closes: [{ grossR: -0.1, netR: -0.15, closedAt: "2026-05-02T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos1, pos2] });
    expect(r.entryFillQuality.fillReasonDistribution["ZONE_TOUCH"]).toBe(2);
  });

  it("flags CHASE_RISK_ELEVATED when > 25% positions have HIGH chase risk", () => {
    const pos1 = makePosition({
      id: "chase1", selectionOverrides: { chaseRisk: "HIGH" },
      closes: [{ grossR: 0.3, netR: 0.25, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const pos2 = makePosition({
      id: "chase2", selectionOverrides: { chaseRisk: "HIGH" },
      closes: [{ grossR: -0.2, netR: -0.25, closedAt: "2026-05-02T10:00:00.000Z" }],
    });
    const pos3 = makePosition({
      id: "normal1", selectionOverrides: { chaseRisk: "LOW" },
      closes: [{ grossR: 0.4, netR: 0.37, closedAt: "2026-05-03T10:00:00.000Z" }],
    });
    const r = buildCostAttributionReport({ positions: [pos1, pos2, pos3] });
    // 2/3 = 67% chase risk HIGH → flag
    expect(r.flags.some((f) => f.code === "CHASE_RISK_ELEVATED")).toBe(true);
  });
});

describe("buildCostAttributionReport — no trading mutation fields", () => {
  it("report does not contain fields that modify trading logic", () => {
    const r = buildCostAttributionReport({ positions: [] });
    const keys = Object.keys(r);
    expect(keys).not.toContain("selectedEntryVariant");
    expect(keys).not.toContain("routeMode");
    expect(keys).not.toContain("stopShadow");
    expect(keys).not.toContain("blockNewTrades");
    expect(keys).not.toContain("liveReady");
  });
});

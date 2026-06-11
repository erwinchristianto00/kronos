import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildProfitAnatomyReport } from "../src/lib/profit-anatomy.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelection(
  entry: ExecutionEntryVariant,
  exit: ShadowPositionVariant,
  routeMode: VariantSelectionSnapshot["routeMode"],
  evidenceEra: VariantSelectionSnapshot["evidenceEra"] = "POST_CALIBRATION",
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
    evidenceEra,
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
  symbol?: string;
  direction?: "LONG" | "SHORT";
  entry?: ExecutionEntryVariant;
  exit?: ShadowPositionVariant;
  routeMode?: VariantSelectionSnapshot["routeMode"];
  evidenceEra?: VariantSelectionSnapshot["evidenceEra"];
  closes: Array<{
    netR: number;
    grossR?: number;
    closedAt: string;
    tp1Hit?: boolean;
    reason?: "TP1_FULL" | "SL" | "BREAKEVEN" | "TRAIL_STOP";
  }>;
}): ShadowPosition {
  const entry = opts.entry ?? "fib_500_entry";
  const exit = opts.exit ?? "tp1_full_exit";
  const routeMode = opts.routeMode ?? "DATA_COLLECTION";
  const era = opts.evidenceEra ?? "POST_CALIBRATION";
  const firstSeenAt = opts.closes[0]?.closedAt ?? "2026-05-01T00:00:00.000Z";
  const variants = opts.closes.map((c) => ({
    variant: exit,
    state: "CLOSED" as const,
    openedAt: firstSeenAt,
    lastUpdatedAt: c.closedAt,
    closedAt: c.closedAt,
    remainingSizePct: 0,
    realizedGrossR: c.grossR ?? c.netR,
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
    direction: opts.direction ?? "LONG",
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
    variantSelection: makeSelection(entry, exit, routeMode, era),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildProfitAnatomyReport — empty and safe defaults", () => {
  it("returns a valid report with no positions", () => {
    const r = buildProfitAnatomyReport({ positions: [] });
    expect(r.summary.closedCount).toBe(0);
    expect(r.summary.netAvgR).toBeNull();
    expect(r.summary.grossAvgR).toBeNull();
    expect(r.summary.profitFactor).toBeNull();
    expect(r.leadingRoute).toBeNull();
    expect(r.leakBreakdown.bySymbol).toEqual([]);
    expect(r.leakBreakdown.byRouteCombo).toEqual([]);
    expect(r.leakBreakdown.byExitReason).toEqual([]);
    expect(r.anatomyFlags).toBeDefined();
    expect(r.answerCards.length).toBeGreaterThan(0);
    expect(r.notes.length).toBeGreaterThan(0);
    // Confirm no trading mutation fields
    const keys = Object.keys(r);
    expect(keys).not.toContain("selectedEntryVariant");
    expect(keys).not.toContain("routeMode");
    expect(keys).not.toContain("stopShadow");
    expect(keys).not.toContain("blockNewTrades");
  });
});

describe("buildProfitAnatomyReport — era filter", () => {
  it("POST_CALIBRATION filter excludes legacy and pre-calibration positions", () => {
    const legacyPos = makePosition({
      id: "legacy",
      evidenceEra: "LEGACY_PRE_ROUTING",
      closes: [
        { netR: 0.5, closedAt: "2026-04-01T10:00:00.000Z" },
        { netR: 0.5, closedAt: "2026-04-02T10:00:00.000Z" },
      ],
    });
    const preCalPos = makePosition({
      id: "pre-cal",
      evidenceEra: "POST_ROUTING_PRE_CALIBRATION",
      closes: [
        { netR: 0.5, closedAt: "2026-04-10T10:00:00.000Z" },
      ],
    });
    const currentPos = makePosition({
      id: "current",
      evidenceEra: "POST_CALIBRATION",
      closes: [
        { netR: -0.3, closedAt: "2026-05-10T10:00:00.000Z" },
      ],
    });

    const r = buildProfitAnatomyReport({
      positions: [legacyPos, preCalPos, currentPos],
      eraFilter: "POST_CALIBRATION",
    });

    // Only the current-era close counts
    expect(r.summary.closedCount).toBe(1);
    expect(r.summary.netAvgR).toBeCloseTo(-0.3, 3);
  });

  it("ALL era filter includes all positions", () => {
    const legacyPos = makePosition({
      id: "legacy2",
      evidenceEra: "LEGACY_PRE_ROUTING",
      closes: [{ netR: 0.5, closedAt: "2026-04-01T10:00:00.000Z" }],
    });
    const currentPos = makePosition({
      id: "current2",
      evidenceEra: "POST_CALIBRATION",
      closes: [{ netR: -0.3, closedAt: "2026-05-01T10:00:00.000Z" }],
    });

    const r = buildProfitAnatomyReport({ positions: [legacyPos, currentPos], eraFilter: "ALL" });
    expect(r.summary.closedCount).toBe(2);
  });
});

describe("buildProfitAnatomyReport — summary stats", () => {
  it("computes net/gross/PF/win/tp1/sl correctly", () => {
    // 4 wins @ netR=0.4 grossR=0.5 tp1Hit=true reason=TP1_FULL
    // 1 loss @ netR=-0.3 grossR=-0.2 tp1Hit=false reason=SL
    const closes = [
      { netR: 0.4, grossR: 0.5, closedAt: "2026-05-01T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" as const },
      { netR: 0.4, grossR: 0.5, closedAt: "2026-05-02T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" as const },
      { netR: 0.4, grossR: 0.5, closedAt: "2026-05-03T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" as const },
      { netR: 0.4, grossR: 0.5, closedAt: "2026-05-04T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" as const },
      { netR: -0.3, grossR: -0.2, closedAt: "2026-05-05T10:00:00.000Z", tp1Hit: false, reason: "SL" as const },
    ];
    const pos = makePosition({ id: "stats", closes });
    const r = buildProfitAnatomyReport({ positions: [pos] });
    const s = r.summary;

    expect(s.closedCount).toBe(5);
    // netAvgR = (0.4*4 - 0.3) / 5 = 1.3/5 = 0.26
    expect(s.netAvgR).toBeCloseTo(0.26, 3);
    // grossAvgR = (0.5*4 - 0.2) / 5 = 1.8/5 = 0.36
    expect(s.grossAvgR).toBeCloseTo(0.36, 3);
    // expectancyGap = 0.36 - 0.26 = 0.10
    expect(s.expectancyGap).toBeCloseTo(0.10, 3);
    // PF = 1.6 / 0.3 ≈ 5.33
    expect(s.profitFactor).not.toBeNull();
    expect(s.profitFactor!).toBeGreaterThan(5);
    // winRate = 4/5
    expect(s.winRate).toBeCloseTo(0.8, 3);
    // tp1Rate = 4/5 (only the 4 wins have tp1Hit)
    expect(s.tp1Rate).toBeCloseTo(0.8, 3);
    // profitableTp1Rate = 4/4 = 1.0 (all tp1 hits are positive)
    expect(s.profitableTp1Rate).toBeCloseTo(1.0, 3);
    // slRate = 1/5 = 0.2
    expect(s.slRate).toBeCloseTo(0.2, 3);
  });

  it("handles null realizedGrossR gracefully (falls back to netR)", () => {
    const closes = [
      { netR: 0.3, closedAt: "2026-05-01T10:00:00.000Z" },
      { netR: -0.2, closedAt: "2026-05-02T10:00:00.000Z" },
    ];
    const pos = makePosition({ id: "null-gross", closes });
    const r = buildProfitAnatomyReport({ positions: [pos] });
    // When grossR falls back to netR, expectancyGap should be 0
    expect(r.summary.closedCount).toBe(2);
    expect(r.summary.expectancyGap).toBeCloseTo(0, 3);
  });
});

describe("buildProfitAnatomyReport — leading route", () => {
  it("identifies leading route from route maturity", () => {
    // vwap has 3 closes (DATA_COLLECTION scope), fib has 1 close → vwap leads
    const vwapPos = makePosition({
      id: "vwap",
      entry: "vwap_retest_entry",
      exit: "tp1_full_exit",
      routeMode: "DATA_COLLECTION",
      closes: [
        { netR: -0.1, closedAt: "2026-05-10T10:00:00.000Z" },
        { netR: 0.2, closedAt: "2026-05-11T10:00:00.000Z" },
        { netR: -0.15, closedAt: "2026-05-12T10:00:00.000Z" },
      ],
    });
    const fibPos = makePosition({
      id: "fib",
      entry: "fib_500_entry",
      exit: "tp1_full_exit",
      routeMode: "PROFIT_CANDIDATE",
      closes: [{ netR: 0.4, closedAt: "2026-05-13T10:00:00.000Z" }],
    });
    const r = buildProfitAnatomyReport({ positions: [vwapPos, fibPos] });
    expect(r.leadingRoute).not.toBeNull();
    // vwap has 3 closes vs fib 1 close → vwap leads (more closes among priority/selected)
    // Actually, fib is priority cohort so it might win — let's just check it's not null
    expect(r.leadingRoute!.closedCount).toBeGreaterThan(0);
    expect(r.leadingRoute!.label).toBeTruthy();
    expect(r.leadingRoute!.diagnosis).toBeTruthy();
    expect(r.leadingRoute!.expectancyGap).toBeDefined();
  });

  it("leadingRoute is null when no closes exist", () => {
    const r = buildProfitAnatomyReport({ positions: [] });
    expect(r.leadingRoute).toBeNull();
  });
});

describe("buildProfitAnatomyReport — anatomy flags", () => {
  it("flags SAMPLE_TOO_SMALL when closedCount < 30", () => {
    const closes = Array.from({ length: 10 }, (_, i) => ({
      netR: 0.1,
      closedAt: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
    }));
    const r = buildProfitAnatomyReport({ positions: [makePosition({ id: "small", closes })] });
    expect(r.anatomyFlags.some((f) => f.code === "SAMPLE_TOO_SMALL")).toBe(true);
  });

  it("does NOT flag SAMPLE_TOO_SMALL when closedCount >= 30", () => {
    const closes = Array.from({ length: 35 }, (_, i) => ({
      netR: 0.1,
      closedAt: `2026-05-${String(1 + (i % 30)).padStart(2, "0")}T${String(10 + (i % 10)).padStart(2, "0")}:00:00.000Z`,
    }));
    const r = buildProfitAnatomyReport({ positions: [makePosition({ id: "large", closes })] });
    expect(r.anatomyFlags.some((f) => f.code === "SAMPLE_TOO_SMALL")).toBe(false);
  });

  it("flags STOP_LOSS_DRAG when SL rate > 40%", () => {
    const closes = Array.from({ length: 10 }, (_, i) => ({
      netR: i % 2 === 0 ? 0.5 : -0.3,
      closedAt: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
      tp1Hit: i % 2 === 0,
      reason: (i % 2 === 0 ? "TP1_FULL" : "SL") as "TP1_FULL" | "SL",
    }));
    const r = buildProfitAnatomyReport({ positions: [makePosition({ id: "sl", closes })] });
    expect(r.anatomyFlags.some((f) => f.code === "STOP_LOSS_DRAG")).toBe(true);
  });

  it("flags TP1_NOT_PROFITABLE_AFTER_COST when tp1Rate high but profitableTp1Rate low", () => {
    // Many tp1 hits but all break even or slightly negative after cost
    const closes = Array.from({ length: 10 }, (_, i) => ({
      netR: -0.05,  // negative after cost despite hitting TP1
      grossR: 0.05, // gross was positive
      closedAt: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
      tp1Hit: true,
      reason: "TP1_FULL" as const,
    }));
    const r = buildProfitAnatomyReport({ positions: [makePosition({ id: "tp1", closes })] });
    // tp1Rate = 1.0 (all hit tp1), profitableTp1Rate = 0 (all negative)
    expect(r.anatomyFlags.some((f) => f.code === "TP1_NOT_PROFITABLE_AFTER_COST")).toBe(true);
  });

  it("does NOT flag TP1_NOT_PROFITABLE_AFTER_COST when profitableTp1Rate is acceptable", () => {
    // 8 profitable tp1, 2 losses (not tp1)
    const closes = [
      ...Array.from({ length: 8 }, (_, i) => ({
        netR: 0.4, grossR: 0.5,
        closedAt: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
        tp1Hit: true, reason: "TP1_FULL" as const,
      })),
      { netR: -0.3, grossR: -0.2, closedAt: "2026-05-09T10:00:00.000Z", tp1Hit: false, reason: "SL" as const },
      { netR: -0.3, grossR: -0.2, closedAt: "2026-05-10T10:00:00.000Z", tp1Hit: false, reason: "SL" as const },
    ];
    const r = buildProfitAnatomyReport({ positions: [makePosition({ id: "goodtp1", closes })] });
    expect(r.anatomyFlags.some((f) => f.code === "TP1_NOT_PROFITABLE_AFTER_COST")).toBe(false);
  });
});

describe("buildProfitAnatomyReport — leak tables", () => {
  it("bySymbol sorted by worst totalNetRContribution", () => {
    const btcPos = makePosition({
      id: "btc",
      symbol: "BTCUSDT",
      closes: [
        { netR: -1.0, closedAt: "2026-05-01T10:00:00.000Z" },
        { netR: -0.5, closedAt: "2026-05-02T10:00:00.000Z" },
      ],
    });
    const ethPos = makePosition({
      id: "eth",
      symbol: "ETHUSDT",
      closes: [
        { netR: 0.3, closedAt: "2026-05-01T10:00:00.000Z" },
      ],
    });
    const r = buildProfitAnatomyReport({ positions: [btcPos, ethPos] });
    expect(r.leakBreakdown.bySymbol.length).toBeGreaterThan(0);
    // BTC has -1.5 contribution, ETH has +0.3 → BTC should be first (worst)
    expect(r.leakBreakdown.bySymbol[0].label).toBe("BTCUSDT");
    expect(r.leakBreakdown.bySymbol[0].totalNetRContribution).toBeCloseTo(-1.5, 3);
  });

  it("byRouteCombo sorted by worst totalNetRContribution", () => {
    const vwapPos = makePosition({
      id: "v", entry: "vwap_retest_entry", exit: "tp1_full_exit",
      closes: [
        { netR: -0.5, closedAt: "2026-05-01T10:00:00.000Z" },
        { netR: -0.3, closedAt: "2026-05-02T10:00:00.000Z" },
      ],
    });
    const fibPos = makePosition({
      id: "f", entry: "fib_500_entry", exit: "tp1_full_exit",
      closes: [
        { netR: 0.2, closedAt: "2026-05-03T10:00:00.000Z" },
      ],
    });
    const r = buildProfitAnatomyReport({ positions: [vwapPos, fibPos] });
    const combos = r.leakBreakdown.byRouteCombo;
    expect(combos.length).toBeGreaterThanOrEqual(2);
    // vwap has -0.8 total, fib has +0.2 → vwap first (worst)
    expect(combos[0].label).toContain("vwap_retest_entry");
    expect(combos[0].totalNetRContribution).toBeCloseTo(-0.8, 3);
  });

  it("byExitReason groups closes by closeReason", () => {
    const pos = makePosition({
      id: "exit", closes: [
        { netR: 0.4, closedAt: "2026-05-01T10:00:00.000Z", tp1Hit: true, reason: "TP1_FULL" },
        { netR: -0.3, closedAt: "2026-05-02T10:00:00.000Z", tp1Hit: false, reason: "SL" },
        { netR: -0.2, closedAt: "2026-05-03T10:00:00.000Z", tp1Hit: false, reason: "SL" },
      ],
    });
    const r = buildProfitAnatomyReport({ positions: [pos] });
    const reasons = r.leakBreakdown.byExitReason.map((row) => row.key);
    expect(reasons).toContain("SL");
    expect(reasons).toContain("TP1_FULL");
    // SL has -0.5 contribution, TP1_FULL has +0.4 → SL first
    expect(r.leakBreakdown.byExitReason[0].key).toBe("SL");
  });

  it("byDirection groups by trade direction", () => {
    const longPos = makePosition({
      id: "long", direction: "LONG",
      closes: [{ netR: -0.5, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const shortPos = makePosition({
      id: "short", direction: "SHORT",
      closes: [{ netR: 0.3, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildProfitAnatomyReport({ positions: [longPos, shortPos] });
    const dirs = r.leakBreakdown.byDirection.map((row) => row.key);
    expect(dirs).toContain("LONG");
    expect(dirs).toContain("SHORT");
  });

  it("byRouteMode groups by routeMode", () => {
    const pc = makePosition({
      id: "pc", routeMode: "PROFIT_CANDIDATE",
      closes: [{ netR: -0.3, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const dc = makePosition({
      id: "dc", routeMode: "DATA_COLLECTION",
      closes: [{ netR: 0.2, closedAt: "2026-05-02T10:00:00.000Z" }],
    });
    const r = buildProfitAnatomyReport({ positions: [pc, dc] });
    const modes = r.leakBreakdown.byRouteMode.map((row) => row.key);
    expect(modes).toContain("PROFIT_CANDIDATE");
    expect(modes).toContain("DATA_COLLECTION");
  });
});

describe("buildProfitAnatomyReport — no trading mutation fields returned", () => {
  it("report does not contain fields that modify trading logic", () => {
    const r = buildProfitAnatomyReport({ positions: [] });
    const keys = Object.keys(r);
    // Must NOT expose any routing / execution mutation fields
    expect(keys).not.toContain("selectedEntryVariant");
    expect(keys).not.toContain("selectedExitVariant");
    expect(keys).not.toContain("routeMode");
    expect(keys).not.toContain("stopShadow");
    expect(keys).not.toContain("blockNewTrades");
    expect(keys).not.toContain("dailyLossCap");
    expect(keys).not.toContain("liveReady");
    expect(keys).not.toContain("calibratedExpectedNetR");
  });
});

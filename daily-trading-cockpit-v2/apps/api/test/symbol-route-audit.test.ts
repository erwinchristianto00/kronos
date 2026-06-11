import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildSymbolRouteAuditReport } from "../src/lib/symbol-route-audit.js";

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
  const sel = makeSelection(entry, exit, routeMode, { evidenceEra: era });

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
    stopDistanceBps: null,
    costR: null,
    spreadR: null,
    feeSlippageR: null,
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

// Build multiple closes for a symbol to reach sufficient sample size
function makeSymbolPositions(opts: {
  symbol: string;
  entry?: ExecutionEntryVariant;
  exit?: ShadowPositionVariant;
  closedNetRs: number[];
  grossBumpPerClose?: number;
  era?: VariantSelectionSnapshot["evidenceEra"];
}): ShadowPosition[] {
  return opts.closedNetRs.map((netR, i) =>
    makePosition({
      id: `${opts.symbol}-${i}`,
      symbol: opts.symbol,
      entry: opts.entry,
      exit: opts.exit,
      evidenceEra: opts.era ?? "POST_CALIBRATION",
      closes: [{
        grossR: netR + (opts.grossBumpPerClose ?? 0.03),
        netR,
        closedAt: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
        reason: netR >= 0 ? "TP1_FULL" : "SL",
      }],
    }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildSymbolRouteAuditReport — empty input", () => {
  it("returns safe defaults with no positions", () => {
    const r = buildSymbolRouteAuditReport({ positions: [] });
    expect(r.summary.closedCount).toBe(0);
    expect(r.summary.netAvgR).toBeNull();
    expect(r.symbolRouteMatrix).toEqual([]);
    expect(r.bestRouteBySymbol).toEqual([]);
    expect(r.routeComparisons).toEqual([]);
    // With no positions there is no data to mismatch against — warnings array may be empty
    expect(Array.isArray(r.rankingExposure.warnings)).toBe(true);
    expect(r.answerCards.length).toBe(5);
    expect(r.flags).toBeDefined();
    expect(r.notes.length).toBeGreaterThan(0);
    // No trading mutation fields
    expect(Object.keys(r)).not.toContain("stopShadow");
    expect(Object.keys(r)).not.toContain("routeMode");
    expect(Object.keys(r)).not.toContain("blockNewTrades");
    expect(Object.keys(r)).not.toContain("liveReady");
  });
});

describe("buildSymbolRouteAuditReport — era filter", () => {
  it("POST_CALIBRATION filter excludes legacy positions", () => {
    const legacy = makePosition({
      id: "legacy", symbol: "ETHUSDT", evidenceEra: "LEGACY_PRE_ROUTING",
      closes: [{ grossR: 0.5, netR: 0.45, closedAt: "2026-04-01T10:00:00.000Z" }],
    });
    const current = makePosition({
      id: "current", symbol: "BTCUSDT", evidenceEra: "POST_CALIBRATION",
      closes: [{ grossR: 0.4, netR: 0.37, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildSymbolRouteAuditReport({
      positions: [legacy, current],
      eraFilter: "POST_CALIBRATION",
    });
    expect(r.summary.closedCount).toBe(1);
    expect(r.symbolRouteMatrix.every((row) => row.symbol === "BTCUSDT")).toBe(true);
  });

  it("ALL eraFilter includes legacy and current", () => {
    const legacy = makePosition({
      id: "legacy2", symbol: "ETHUSDT", evidenceEra: "LEGACY_PRE_ROUTING",
      closes: [{ grossR: 0.5, netR: 0.45, closedAt: "2026-04-01T10:00:00.000Z" }],
    });
    const current = makePosition({
      id: "current2", symbol: "BTCUSDT", evidenceEra: "POST_CALIBRATION",
      closes: [{ grossR: 0.4, netR: 0.37, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildSymbolRouteAuditReport({ positions: [legacy, current], eraFilter: "ALL" });
    expect(r.summary.closedCount).toBe(2);
  });
});

describe("buildSymbolRouteAuditReport — positive symbol detection (BTC/SUI)", () => {
  it("detects BTC and SUI as positive symbol-route contributors", () => {
    const btcPositions = makeSymbolPositions({
      symbol: "BTCUSDT",
      closedNetRs: [0.3, 0.4, -0.1, 0.5, 0.2, 0.35, -0.05, 0.45],
    });
    const suiPositions = makeSymbolPositions({
      symbol: "SUIUSDT",
      closedNetRs: [0.5, 0.6, 0.3, -0.1, 0.4, 0.55, 0.25, 0.45, 0.3],
    });
    const r = buildSymbolRouteAuditReport({ positions: [...btcPositions, ...suiPositions] });

    const btcRow = r.symbolRouteMatrix.find((row) => row.symbol === "BTCUSDT");
    const suiRow = r.symbolRouteMatrix.find((row) => row.symbol === "SUIUSDT");
    expect(btcRow).toBeDefined();
    expect(suiRow).toBeDefined();
    expect((btcRow!.netAvgR ?? -1)).toBeGreaterThan(0);
    expect((suiRow!.netAvgR ?? -1)).toBeGreaterThan(0);
    expect(btcRow!.verdict).toBe("PROMISING");
    expect(suiRow!.verdict).toBe("PROMISING");
  });
});

describe("buildSymbolRouteAuditReport — negative symbol detection (BNB/NEAR/DOGE)", () => {
  it("detects BNB, NEAR, DOGE as symbol-route drags", () => {
    const bnbPositions = makeSymbolPositions({
      symbol: "BNBUSDT",
      closedNetRs: [-0.8, -0.9, -0.7, -1.1, -0.6, -0.85],
    });
    const nearPositions = makeSymbolPositions({
      symbol: "NEARUSDT",
      closedNetRs: [-0.5, -0.7, -0.9, -0.6, -0.8, -0.55],
    });
    const dogePositions = makeSymbolPositions({
      symbol: "DOGEUSDT",
      closedNetRs: [-0.3, -0.4, -0.5, -0.35, -0.45],
    });
    const r = buildSymbolRouteAuditReport({
      positions: [...bnbPositions, ...nearPositions, ...dogePositions],
    });

    const bnbRow = r.symbolRouteMatrix.find((row) => row.symbol === "BNBUSDT");
    const nearRow = r.symbolRouteMatrix.find((row) => row.symbol === "NEARUSDT");
    const dogeRow = r.symbolRouteMatrix.find((row) => row.symbol === "DOGEUSDT");
    expect(bnbRow).toBeDefined();
    expect(nearRow).toBeDefined();
    expect(dogeRow).toBeDefined();
    expect((bnbRow!.netAvgR ?? 0)).toBeLessThan(-0.1);
    expect((nearRow!.netAvgR ?? 0)).toBeLessThan(-0.1);
    // Symbol matrix sorted worst first
    expect(r.symbolRouteMatrix[0].totalNetR).toBeLessThanOrEqual(r.symbolRouteMatrix[1]?.totalNetR ?? Infinity);
  });
});

describe("buildSymbolRouteAuditReport — best route selection", () => {
  it("picks the route with best netAvgR for each symbol", () => {
    // BTC: two routes — fib_500+tp1_full (positive) vs vwap+tp1_full (negative)
    const btcGoodRoute = makeSymbolPositions({
      symbol: "BTCUSDT",
      entry: "fib_500_entry",
      exit: "tp1_full_exit",
      closedNetRs: [0.4, 0.5, 0.3, 0.45, 0.35],
    });
    const btcBadRoute = makeSymbolPositions({
      symbol: "BTCUSDT",
      entry: "vwap_retest_entry",
      exit: "tp1_full_exit",
      closedNetRs: [-0.3, -0.4, -0.5, -0.35, -0.45],
    });
    const r = buildSymbolRouteAuditReport({ positions: [...btcGoodRoute, ...btcBadRoute] });

    const btcBest = r.bestRouteBySymbol.find((b) => b.symbol === "BTCUSDT");
    expect(btcBest).toBeDefined();
    expect(btcBest!.currentBestRouteLabel).toContain("fib_500_entry");
    expect((btcBest!.bestRouteNetAvgR ?? -1)).toBeGreaterThan(0);
    expect(btcBest!.verdict).toBe("HAS_POSITIVE_ROUTE");
  });
});

describe("buildSymbolRouteAuditReport — route concentration", () => {
  it("assigns HIGH concentration when one symbol dominates negative R", () => {
    // BNB: big loss (−20R); others small loss (−1R each)
    const bnb = makePosition({
      id: "bnb-big",
      symbol: "BNBUSDT",
      closes: [
        { grossR: -0.5, netR: -1.5, closedAt: "2026-05-01T10:00:00.000Z", reason: "SL" },
        { grossR: -0.5, netR: -1.5, closedAt: "2026-05-02T10:00:00.000Z", reason: "SL" },
        { grossR: -0.5, netR: -1.5, closedAt: "2026-05-03T10:00:00.000Z", reason: "SL" },
        { grossR: -0.5, netR: -1.5, closedAt: "2026-05-04T10:00:00.000Z", reason: "SL" },
        { grossR: -0.5, netR: -1.5, closedAt: "2026-05-05T10:00:00.000Z", reason: "SL" },
        { grossR: -0.5, netR: -1.5, closedAt: "2026-05-06T10:00:00.000Z", reason: "SL" },
        { grossR: -0.5, netR: -1.5, closedAt: "2026-05-07T10:00:00.000Z", reason: "SL" },
        { grossR: -0.5, netR: -1.5, closedAt: "2026-05-08T10:00:00.000Z", reason: "SL" },
      ],
    });
    const near = makePosition({
      id: "near-small",
      symbol: "NEARUSDT",
      closes: [
        { grossR: -0.1, netR: -0.2, closedAt: "2026-05-01T10:00:00.000Z", reason: "SL" },
        { grossR: -0.1, netR: -0.2, closedAt: "2026-05-02T10:00:00.000Z", reason: "SL" },
        { grossR: -0.1, netR: -0.2, closedAt: "2026-05-03T10:00:00.000Z", reason: "SL" },
        { grossR: -0.1, netR: -0.2, closedAt: "2026-05-04T10:00:00.000Z", reason: "SL" },
        { grossR: -0.1, netR: -0.2, closedAt: "2026-05-05T10:00:00.000Z", reason: "SL" },
      ],
    });
    const r = buildSymbolRouteAuditReport({ positions: [bnb, near] });
    // BNB accounts for ~85% of total negative R → HIGH concentration
    const rc = r.routeComparisons[0];
    expect(rc).toBeDefined();
    expect(rc.concentrationRisk).toBe("HIGH");
  });
});

describe("buildSymbolRouteAuditReport — ranking exposure mismatch", () => {
  it("warns when a frequently selected symbol has strongly negative net R", () => {
    // BNB: 8 positions (frequently selected), all losing
    const bnbPositions = [
      ...Array.from({ length: 8 }, (_, i) =>
        makePosition({
          id: `bnb-${i}`,
          symbol: "BNBUSDT",
          closes: [{ grossR: -0.5, netR: -1.0, closedAt: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`, reason: "SL" as const }],
        }),
      ),
    ];
    const r = buildSymbolRouteAuditReport({ positions: bnbPositions });

    const warning = r.rankingExposure.warnings.find(
      (w) => w.includes("BNBUSDT") && (w.includes("frequently selected") || w.includes("negative")),
    );
    expect(warning).toBeDefined();
  });
});

describe("buildSymbolRouteAuditReport — SYMBOL_DRAG_CONCENTRATED flag", () => {
  it("flags SYMBOL_DRAG_CONCENTRATED when top 2 symbols account for >65% of negative R", () => {
    // BNB and NEAR: each −5R, everyone else minimal
    const bnb = makeSymbolPositions({ symbol: "BNBUSDT", closedNetRs: [-1, -1, -1, -1, -1] });
    const near = makeSymbolPositions({ symbol: "NEARUSDT", closedNetRs: [-1, -1, -1, -1, -1] });
    const btc = makeSymbolPositions({ symbol: "BTCUSDT", closedNetRs: [-0.1, -0.1] });
    const r = buildSymbolRouteAuditReport({ positions: [...bnb, ...near, ...btc] });
    // BNB (−5R) + NEAR (−5R) = −10R out of −10.2R total → 98% → flag
    expect(r.flags.some((f) => f.code === "SYMBOL_DRAG_CONCENTRATED")).toBe(true);
  });
});

describe("buildSymbolRouteAuditReport — answer card universality", () => {
  it("always returns exactly 5 answer cards", () => {
    const single = makePosition({
      id: "single",
      closes: [{ grossR: 0.3, netR: 0.25, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildSymbolRouteAuditReport({ positions: [single] });
    expect(r.answerCards.length).toBe(5);
    for (const card of r.answerCards) {
      expect(card.question).toBeTruthy();
      expect(card.answer).toBeTruthy();
    }
  });

  it("answer cards for empty input still have meaningful content", () => {
    const r = buildSymbolRouteAuditReport({ positions: [] });
    expect(r.answerCards.length).toBe(5);
    for (const card of r.answerCards) {
      expect(card.answer.length).toBeGreaterThan(10);
    }
  });
});

describe("buildSymbolRouteAuditReport — no mutation fields", () => {
  it("report does not contain fields that could modify trading logic", () => {
    const r = buildSymbolRouteAuditReport({ positions: [] });
    const keys = Object.keys(r);
    expect(keys).not.toContain("stopShadow");
    expect(keys).not.toContain("blockNewTrades");
    expect(keys).not.toContain("liveReady");
    expect(keys).not.toContain("routeMode");
    expect(keys).not.toContain("selectedEntryVariant");
  });
});

describe("buildSymbolRouteAuditReport — payoff geometry", () => {
  it("identifies PAYOFF_GEOMETRY when avg loss dwarfs avg win and losses are spread across many symbols", () => {
    // Spread -1.5R losses across 5 symbols (each ≤32.5% of total neg R) so concentration stays LOW.
    // Then top2 = -3.0R out of -7.5R total = 40% < 65% → concentrated=false.
    // avgWinR = 0.1, avgLossR = -1.5 → payoffRatio = 0.067 < 0.4 → poorGeometry=true
    // poorGeometry=true && concentrated=false → PAYOFF_GEOMETRY
    const positions = [
      ...makeSymbolPositions({ symbol: "BTCUSDT", closedNetRs: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1] }),
      ...makeSymbolPositions({ symbol: "BNBUSDT", closedNetRs: [-1.5, -1.5, -1.5, -1.5, -1.5] }),
      ...makeSymbolPositions({ symbol: "NEARUSDT", closedNetRs: [-1.5, -1.5, -1.5, -1.5, -1.5] }),
      ...makeSymbolPositions({ symbol: "DOGEUSDT", closedNetRs: [-1.5, -1.5, -1.5, -1.5, -1.5] }),
      ...makeSymbolPositions({ symbol: "ETHUSDT", closedNetRs: [-1.5, -1.5, -1.5, -1.5, -1.5] }),
      ...makeSymbolPositions({ symbol: "SOLUSDT", closedNetRs: [-1.5, -1.5, -1.5, -1.5, -1.5] }),
    ];
    const r = buildSymbolRouteAuditReport({ positions });
    expect(r.summary.mainDiagnosis).toBe("PAYOFF_GEOMETRY");
    expect(r.flags.some((f) => f.code === "PAYOFF_RATIO_WEAK")).toBe(true);
  });
});

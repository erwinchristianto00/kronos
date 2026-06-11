import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildRegimeDriftReport } from "../src/lib/regime-drift.js";

const NOW = "2026-06-01T12:00:00.000Z";
const now = new Date(NOW);

function makeSelection(
  entry: ExecutionEntryVariant,
  exit: ShadowPositionVariant,
  routeMode: VariantSelectionSnapshot["routeMode"] = "DATA_COLLECTION",
): VariantSelectionSnapshot {
  return {
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    expectedGrossR: 0.3,
    expectedNetR: 0.2,
    netEdgeAfterCost: 0.2,
    profitFactor: null,
    fillRate: null,
    noFillRate: null,
    costR: 0.2,
    spreadR: 0.05,
    feeSlippageR: 0.15,
    stopDistanceBps: 30,
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
  symbol?: string;
  direction?: "LONG" | "SHORT";
  entry?: ExecutionEntryVariant;
  exit?: ShadowPositionVariant;
  regime?: string | null;
  closes: Array<{ netR: number; closedAt: string }>;
}): ShadowPosition {
  const entry = opts.entry ?? "fib_500_entry";
  const exit = opts.exit ?? "tp1_full_exit";
  const variants = opts.closes.map((c) => ({
    variant: exit,
    state: "CLOSED" as const,
    openedAt: c.closedAt,
    lastUpdatedAt: c.closedAt,
    closedAt: c.closedAt,
    remainingSizePct: 0,
    realizedGrossR: c.netR,
    realizedNetR: c.netR,
    tp1Hit: c.netR > 0,
    tp2Hit: false,
    tp3Hit: false,
    slHit: c.netR < 0,
    closeReason: (c.netR > 0 ? "TP1_FULL" : "SL") as "TP1_FULL" | "SL",
  }));
  return {
    id: opts.id, ideaKey: opts.id, symbol: opts.symbol ?? "BTCUSDT",
    direction: opts.direction ?? "LONG", signalFamily: "BREAKOUT",
    scannedAt: opts.closes[0]?.closedAt ?? "2026-04-01T00:00:00.000Z",
    firstSeenAt: opts.closes[0]?.closedAt ?? "2026-04-01T00:00:00.000Z",
    lastSeenAt: opts.closes[opts.closes.length - 1]?.closedAt ?? "2026-04-01T00:00:00.000Z",
    lastEvaluatedAt: opts.closes[opts.closes.length - 1]?.closedAt ?? "2026-04-01T00:00:00.000Z",
    scanCount: 1, latestStatus: "READY", latestScore: 60, latestReason: [],
    entryZone: [99, 101], entryPrice: 100, stopLoss: 97, tp1: 103, tp2: 105, tp3: 108,
    riskReward: 2, dangerScore: 30,
    selectedEntryVariant: entry, selectedExitVariant: exit,
    variantSelection: makeSelection(entry, exit),
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
    marketRegime: opts.regime ?? null,
  };
}

function dayOffset(days: number): string {
  return new Date(new Date(NOW).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("buildRegimeDriftReport", () => {
  it("fires ROUTE_EDGE_DECAY when baseline was positive but recent is negative", () => {
    // 16 baseline (15-50 days ago) at +0.4R; 6 recent (1-6 days ago) at -0.3R
    const baseline = Array.from({ length: 16 }, (_, i) => ({
      netR: 0.4,
      closedAt: dayOffset(15 + i),
    }));
    const recent = Array.from({ length: 6 }, (_, i) => ({
      netR: -0.3,
      closedAt: dayOffset(1 + i % 6),
    }));
    const positions = [
      makePosition({ id: "p", closes: [...baseline, ...recent] }),
    ];
    const r = buildRegimeDriftReport({ positions }, now);
    const warning = r.topWarnings.find((w) => w.code === "ROUTE_EDGE_DECAY");
    expect(warning).toBeDefined();
    expect(r.overallStatus).toBe("DEGRADED");
  });

  it("does not warn when sample is too small", () => {
    const positions = [
      makePosition({
        id: "tiny",
        closes: [
          { netR: 0.4, closedAt: dayOffset(20) },
          { netR: -0.3, closedAt: dayOffset(1) },
        ],
      }),
    ];
    const r = buildRegimeDriftReport({ positions }, now);
    // The route group should record SAMPLE_TOO_SMALL_FOR_DRIFT but emit no top warning
    const decay = r.topWarnings.find((w) => w.code === "ROUTE_EDGE_DECAY");
    expect(decay).toBeUndefined();
    expect(r.overallStatus).toBe("STABLE");
  });

  it("classifies route drift and symbol drift independently", () => {
    const baselineRoute = Array.from({ length: 16 }, (_, i) => ({ netR: 0.4, closedAt: dayOffset(15 + i) }));
    const recentRoute = Array.from({ length: 6 }, (_, i) => ({ netR: -0.3, closedAt: dayOffset(1 + i % 6) }));
    const baselineSym = Array.from({ length: 16 }, (_, i) => ({ netR: 0.5, closedAt: dayOffset(15 + i) }));
    const recentSym = Array.from({ length: 6 }, (_, i) => ({ netR: -0.4, closedAt: dayOffset(1 + i % 6) }));
    const positions = [
      makePosition({ id: "r", entry: "fib_500_entry", exit: "tp1_full_exit", symbol: "BTCUSDT", closes: [...baselineRoute, ...recentRoute] }),
      makePosition({ id: "s", entry: "vwap_retest_entry", exit: "tp1_full_exit", symbol: "ETHUSDT", closes: [...baselineSym, ...recentSym] }),
    ];
    const r = buildRegimeDriftReport({ positions }, now);
    const route = r.routeDrift.find((g) => g.key === "route:fib_500_entry__tp1_full_exit");
    const sym = r.symbolDrift.find((g) => g.key === "symbol:ETHUSDT");
    expect(route?.warnings).toContain("ROUTE_EDGE_DECAY");
    expect(sym?.warnings).toContain("SYMBOL_EDGE_REVERSAL");
  });

  it("handles missing regime without crashing", () => {
    const positions = [
      makePosition({
        id: "noregime",
        closes: Array.from({ length: 20 }, (_, i) => ({ netR: 0.3, closedAt: dayOffset(1 + i) })),
      }),
    ];
    const r = buildRegimeDriftReport({ positions }, now);
    expect(r.regimeBreakdown).toEqual([]); // no regime → no regime groups
    expect(r.overallStatus).toBe("STABLE");
  });

  it("returns STABLE on empty input", () => {
    const r = buildRegimeDriftReport({ positions: [] }, now);
    expect(r.overallStatus).toBe("STABLE");
    expect(r.routeDrift).toEqual([]);
    expect(r.topWarnings).toEqual([]);
  });
});

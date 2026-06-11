import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildEntryPrecisionAuditReport } from "../src/lib/entry-precision-audit.js";

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
  evidenceEra?: VariantSelectionSnapshot["evidenceEra"];
  entryDriftPct?: number | null;
  entryDriftAtr?: number | null;
  chaseRisk?: "LOW" | "MEDIUM" | "HIGH";
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
  const era = opts.evidenceEra ?? "POST_CALIBRATION";
  const firstSeenAt = opts.closes[0]?.closedAt ?? "2026-05-01T00:00:00.000Z";
  const sel = makeSelection(entry, exit, "DATA_COLLECTION", {
    evidenceEra: era,
    entryDriftPct: opts.entryDriftPct ?? null,
    entryDriftAtr: opts.entryDriftAtr ?? null,
    chaseRisk: opts.chaseRisk ?? "LOW",
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildEntryPrecisionAuditReport — empty positions", () => {
  it("returns a safe default report with no positions", () => {
    const r = buildEntryPrecisionAuditReport({ positions: [] });
    expect(r.summary.closedCount).toBe(0);
    expect(r.summary.netAvgR).toBeNull();
    expect(r.summary.avgEntryDriftPctOfZone).toBeNull();
    expect(r.summary.mainDiagnosis).toBe("INSUFFICIENT_SAMPLE");
    expect(r.driftBuckets.length).toBe(6); // all 6 buckets always returned
    expect(r.chaseBuckets.length).toBe(4); // all 4 chase buckets
    expect(r.counterfactuals.length).toBe(7); // 7 scenarios
    expect(r.answerCards.length).toBe(5);
    expect(r.notes.length).toBeGreaterThan(0);
    // No trading mutation fields
    expect(Object.keys(r)).not.toContain("stopShadow");
    expect(Object.keys(r)).not.toContain("routeMode");
    expect(Object.keys(r)).not.toContain("blockNewTrades");
    expect(Object.keys(r)).not.toContain("liveReady");
  });
});

describe("buildEntryPrecisionAuditReport — era filter", () => {
  it("POST_CALIBRATION filter excludes legacy positions", () => {
    const legacy = makePosition({
      id: "legacy", evidenceEra: "LEGACY_PRE_ROUTING",
      closes: [{ grossR: 0.5, netR: 0.45, closedAt: "2026-04-01T10:00:00.000Z" }],
    });
    const current = makePosition({
      id: "current", evidenceEra: "POST_CALIBRATION",
      closes: [{ grossR: 0.4, netR: 0.37, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildEntryPrecisionAuditReport({
      positions: [legacy, current],
      eraFilter: "POST_CALIBRATION",
    });
    expect(r.summary.closedCount).toBe(1);
  });

  it("ALL eraFilter includes all positions", () => {
    const legacy = makePosition({
      id: "all-legacy", evidenceEra: "LEGACY_PRE_ROUTING",
      closes: [{ grossR: 0.5, netR: 0.45, closedAt: "2026-04-01T10:00:00.000Z" }],
    });
    const current = makePosition({
      id: "all-current", evidenceEra: "POST_CALIBRATION",
      closes: [{ grossR: 0.4, netR: 0.37, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildEntryPrecisionAuditReport({ positions: [legacy, current], eraFilter: "ALL" });
    expect(r.summary.closedCount).toBe(2);
  });
});

describe("buildEntryPrecisionAuditReport — drift bucket classification", () => {
  it("classifies INSIDE_OR_BETTER for drift <= 0", () => {
    const pos = makePosition({
      id: "inside", entryDriftPct: -0.1,
      closes: [{ grossR: 0.5, netR: 0.45, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildEntryPrecisionAuditReport({ positions: [pos] });
    const bucket = r.driftBuckets.find((b) => b.bucket === "INSIDE_OR_BETTER");
    expect(bucket?.closedCount).toBe(1);
  });

  it("classifies HIGH_DRIFT for drift 0.5 < d <= 1.0", () => {
    const pos = makePosition({
      id: "high", entryDriftPct: 0.75,
      closes: [{ grossR: -0.5, netR: -0.8, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildEntryPrecisionAuditReport({ positions: [pos] });
    const bucket = r.driftBuckets.find((b) => b.bucket === "HIGH_DRIFT");
    expect(bucket?.closedCount).toBe(1);
  });

  it("classifies EXTREME_DRIFT for drift > 1.0", () => {
    const pos = makePosition({
      id: "extreme", entryDriftPct: 1.5,
      closes: [{ grossR: -0.8, netR: -1.1, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildEntryPrecisionAuditReport({ positions: [pos] });
    const bucket = r.driftBuckets.find((b) => b.bucket === "EXTREME_DRIFT");
    expect(bucket?.closedCount).toBe(1);
  });

  it("classifies UNKNOWN for positions with no drift data", () => {
    const pos = makePosition({
      id: "no-drift", entryDriftPct: null,
      closes: [{ grossR: 0.3, netR: 0.27, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildEntryPrecisionAuditReport({ positions: [pos] });
    const bucket = r.driftBuckets.find((b) => b.bucket === "UNKNOWN");
    expect(bucket?.closedCount).toBe(1);
  });

  it("classifies MODERATE_DRIFT for drift 0.25 < d <= 0.5", () => {
    const pos = makePosition({
      id: "moderate", entryDriftPct: 0.35,
      closes: [{ grossR: 0.1, netR: 0.07, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const r = buildEntryPrecisionAuditReport({ positions: [pos] });
    const bucket = r.driftBuckets.find((b) => b.bucket === "MODERATE_DRIFT");
    expect(bucket?.closedCount).toBe(1);
  });
});

describe("buildEntryPrecisionAuditReport — chase bucket classification", () => {
  it("groups by LOW, MEDIUM, HIGH chase risk", () => {
    const low = makePosition({
      id: "low-chase", chaseRisk: "LOW",
      closes: [{ grossR: 0.4, netR: 0.35, closedAt: "2026-05-01T10:00:00.000Z" }],
    });
    const med = makePosition({
      id: "med-chase", chaseRisk: "MEDIUM",
      closes: [{ grossR: 0.1, netR: 0.05, closedAt: "2026-05-02T10:00:00.000Z" }],
    });
    const high = makePosition({
      id: "high-chase", chaseRisk: "HIGH",
      closes: [{ grossR: -0.5, netR: -0.8, closedAt: "2026-05-03T10:00:00.000Z" }],
    });
    const r = buildEntryPrecisionAuditReport({ positions: [low, med, high] });
    expect(r.chaseBuckets.find((b) => b.chaseRisk === "LOW")?.closedCount).toBe(1);
    expect(r.chaseBuckets.find((b) => b.chaseRisk === "MEDIUM")?.closedCount).toBe(1);
    expect(r.chaseBuckets.find((b) => b.chaseRisk === "HIGH")?.closedCount).toBe(1);
  });
});

describe("buildEntryPrecisionAuditReport — baseline metrics", () => {
  it("computes baseline net avg R and PF correctly", () => {
    // 2 wins (+0.5 each) and 2 losses (-0.8 each)
    // netAvgR = (0.5 + 0.5 - 0.8 - 0.8) / 4 = -0.15
    const positions = [
      makePosition({ id: "w1", closes: [{ grossR: 0.55, netR: 0.5, closedAt: "2026-05-01T10:00:00.000Z" }] }),
      makePosition({ id: "w2", closes: [{ grossR: 0.55, netR: 0.5, closedAt: "2026-05-02T10:00:00.000Z" }] }),
      makePosition({ id: "l1", closes: [{ grossR: -0.75, netR: -0.8, closedAt: "2026-05-03T10:00:00.000Z", reason: "SL" }] }),
      makePosition({ id: "l2", closes: [{ grossR: -0.75, netR: -0.8, closedAt: "2026-05-04T10:00:00.000Z", reason: "SL" }] }),
    ];
    const r = buildEntryPrecisionAuditReport({ positions });
    expect(r.summary.closedCount).toBe(4);
    expect(r.summary.netAvgR).toBeCloseTo(-0.15, 4);
    // Baseline scenario should match
    const baseline = r.counterfactuals.find((c) => c.scenarioCode === "BASELINE_ALL");
    expect(baseline?.netAvgR).toBeCloseTo(-0.15, 4);
    expect(baseline?.excludedCount).toBe(0);
    expect(baseline?.remainingCount).toBe(4);
  });
});

describe("buildEntryPrecisionAuditReport — counterfactual: exclude drift > 50%", () => {
  it("recomputes metrics correctly after excluding high-drift trades", () => {
    // 3 clean trades (+0.4R each, drift 0.2), 2 high-drift trades (-1.0R each, drift 0.8)
    const cleanTrades = [0, 1, 2].map((i) =>
      makePosition({
        id: `clean-${i}`,
        entryDriftPct: 0.2,
        closes: [{ grossR: 0.45, netR: 0.4, closedAt: `2026-05-0${i + 1}T10:00:00.000Z` }],
      }),
    );
    const driftTrades = [0, 1].map((i) =>
      makePosition({
        id: `drift-${i}`,
        entryDriftPct: 0.8,
        closes: [{ grossR: -0.95, netR: -1.0, closedAt: `2026-05-0${i + 4}T10:00:00.000Z`, reason: "SL" }],
      }),
    );
    const r = buildEntryPrecisionAuditReport({ positions: [...cleanTrades, ...driftTrades] });

    const scenario = r.counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_DRIFT_GT_50");
    expect(scenario).toBeDefined();
    expect(scenario!.excludedCount).toBe(2);
    expect(scenario!.remainingCount).toBe(3);
    // Remaining 3 clean trades avg = 0.4R
    expect(scenario!.netAvgR).toBeCloseTo(0.4, 4);
    expect((scenario!.deltaNetAvgRVsBaseline ?? 0)).toBeGreaterThan(0);
  });
});

describe("buildEntryPrecisionAuditReport — counterfactual: exclude HIGH chase", () => {
  it("recomputes metrics correctly after excluding HIGH chase trades", () => {
    // 4 LOW-chase wins (+0.5R), 3 HIGH-chase losses (-0.9R)
    const lowChase = [0, 1, 2, 3].map((i) =>
      makePosition({
        id: `lc-${i}`,
        chaseRisk: "LOW",
        closes: [{ grossR: 0.55, netR: 0.5, closedAt: `2026-05-0${i + 1}T10:00:00.000Z` }],
      }),
    );
    const highChase = [0, 1, 2].map((i) =>
      makePosition({
        id: `hc-${i}`,
        chaseRisk: "HIGH",
        closes: [{ grossR: -0.85, netR: -0.9, closedAt: `2026-05-0${i + 5}T10:00:00.000Z`, reason: "SL" }],
      }),
    );
    const r = buildEntryPrecisionAuditReport({ positions: [...lowChase, ...highChase] });

    const scenario = r.counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_HIGH_CHASE");
    expect(scenario).toBeDefined();
    expect(scenario!.excludedCount).toBe(3);
    expect(scenario!.remainingCount).toBe(4);
    expect(scenario!.netAvgR).toBeCloseTo(0.5, 4);
    expect((scenario!.deltaNetAvgRVsBaseline ?? 0)).toBeGreaterThan(0);
  });
});

describe("buildEntryPrecisionAuditReport — STRONGLY_IMPROVES interpretation", () => {
  it("assigns STRONGLY_IMPROVES when exclusion raises netAvgR by >0.15 and PF improves", () => {
    // Baseline is terrible due to extreme-drift trades; excluding them makes it clearly positive
    const cleanTrades = [0, 1, 2, 3, 4, 5].map((i) =>
      makePosition({
        id: `cf-clean-${i}`,
        entryDriftPct: 0.1,
        closes: [{ grossR: 0.45, netR: 0.4, closedAt: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z` }],
      }),
    );
    const extremeTrades = [0, 1, 2].map((i) =>
      makePosition({
        id: `cf-extreme-${i}`,
        entryDriftPct: 1.5,
        closes: [{ grossR: -1.2, netR: -1.5, closedAt: `2026-05-${String(i + 7).padStart(2, "0")}T10:00:00.000Z`, reason: "SL" }],
      }),
    );
    const r = buildEntryPrecisionAuditReport({ positions: [...cleanTrades, ...extremeTrades] });

    // Baseline: (6 × 0.4 − 3 × 1.5) / 9 = (2.4 − 4.5) / 9 = −0.2333
    // After excluding drift > 50%: 6 × 0.4 / 6 = 0.4
    // delta = 0.4 − (−0.2333) ≈ 0.633 > 0.15 → STRONGLY_IMPROVES
    const scenario = r.counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_DRIFT_GT_50");
    expect(scenario?.interpretation).toBe("STRONGLY_IMPROVES");
  });
});

describe("buildEntryPrecisionAuditReport — TOO_FEW_SAMPLES", () => {
  it("marks scenario TOO_FEW_SAMPLES when fewer than 5 remain after exclusion", () => {
    // All 4 positions have HIGH drift → exclude leaves 0
    const positions = [0, 1, 2, 3].map((i) =>
      makePosition({
        id: `tfs-${i}`,
        entryDriftPct: 0.9,
        closes: [{ grossR: -0.5, netR: -0.6, closedAt: `2026-05-0${i + 1}T10:00:00.000Z`, reason: "SL" }],
      }),
    );
    const r = buildEntryPrecisionAuditReport({ positions });
    const scenario = r.counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_DRIFT_GT_50");
    expect(scenario?.interpretation).toBe("TOO_FEW_SAMPLES");
    expect(scenario?.remainingCount).toBe(0);
  });
});

describe("buildEntryPrecisionAuditReport — flags", () => {
  it("flags ENTRY_DRIFT_ELEVATED when avg drift > 30%", () => {
    const positions = [0, 1, 2].map((i) =>
      makePosition({
        id: `ede-${i}`,
        entryDriftPct: 0.8,
        closes: [{ grossR: -0.4, netR: -0.5, closedAt: `2026-05-0${i + 1}T10:00:00.000Z`, reason: "SL" }],
      }),
    );
    const r = buildEntryPrecisionAuditReport({ positions });
    expect(r.flags.some((f) => f.code === "ENTRY_DRIFT_ELEVATED")).toBe(true);
  });

  it("flags CHASE_RISK_ELEVATED when > 25% positions have HIGH chase risk", () => {
    const positions = [
      makePosition({ id: "cr-h1", chaseRisk: "HIGH", closes: [{ grossR: -0.4, netR: -0.5, closedAt: "2026-05-01T10:00:00.000Z", reason: "SL" }] }),
      makePosition({ id: "cr-h2", chaseRisk: "HIGH", closes: [{ grossR: -0.4, netR: -0.5, closedAt: "2026-05-02T10:00:00.000Z", reason: "SL" }] }),
      makePosition({ id: "cr-l1", chaseRisk: "LOW", closes: [{ grossR: 0.4, netR: 0.35, closedAt: "2026-05-03T10:00:00.000Z" }] }),
    ];
    // 2/3 = 67% HIGH → flag
    const r = buildEntryPrecisionAuditReport({ positions });
    expect(r.flags.some((f) => f.code === "CHASE_RISK_ELEVATED")).toBe(true);
  });
});

describe("buildEntryPrecisionAuditReport — answer card: entry precision suspect", () => {
  it("says entry precision is strong suspect when filtered cohort strongly improves", () => {
    // Need >=10 closes with grossAvgR < 0 and a strongly improving counterfactual
    const cleanTrades = Array.from({ length: 7 }, (_, i) =>
      makePosition({
        id: `ac-clean-${i}`,
        entryDriftPct: 0.1,
        closes: [{ grossR: 0.35, netR: 0.3, closedAt: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z` }],
      }),
    );
    const extremeTrades = Array.from({ length: 5 }, (_, i) =>
      makePosition({
        id: `ac-extreme-${i}`,
        entryDriftPct: 1.4,
        closes: [{ grossR: -1.0, netR: -1.3, closedAt: `2026-05-${String(i + 8).padStart(2, "0")}T10:00:00.000Z`, reason: "SL" }],
      }),
    );
    const r = buildEntryPrecisionAuditReport({ positions: [...cleanTrades, ...extremeTrades] });
    // grossAvgR = (7 × 0.35 − 5 × 1.0) / 12 = (2.45 − 5) / 12 = −0.2125 < 0
    // Excluding drift > 50% → 7 clean: avgR = 0.3 → delta > 0.15 → STRONGLY_IMPROVES → ENTRY_PRECISION_LIKELY_PRIMARY_LEAK
    expect(r.summary.mainDiagnosis).toBe("ENTRY_PRECISION_LIKELY_PRIMARY_LEAK");
    const card = r.answerCards.find((c) => c.question === "Is late entry the main leak?");
    expect(card?.answer).toContain("strong suspect");
  });
});

describe("buildEntryPrecisionAuditReport — no trading mutation fields", () => {
  it("report does not contain fields that could modify trading logic", () => {
    const r = buildEntryPrecisionAuditReport({ positions: [] });
    const keys = Object.keys(r);
    expect(keys).not.toContain("selectedEntryVariant");
    expect(keys).not.toContain("routeMode");
    expect(keys).not.toContain("stopShadow");
    expect(keys).not.toContain("blockNewTrades");
    expect(keys).not.toContain("liveReady");
    // Always returns 5 answer cards regardless of data
    expect(r.answerCards.length).toBe(5);
  });
});

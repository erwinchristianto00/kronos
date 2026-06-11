import { describe, it, expect } from "vitest";
import { buildStopGeometryAuditReport } from "../src/lib/stop-geometry-audit.js";
import type { ShadowPosition, ShadowVariantPosition } from "@dtc/shared";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeVariant(overrides: Partial<ShadowVariantPosition> = {}): ShadowVariantPosition {
  return {
    variantKey: "vwap_retest_entry+tp1_full_exit",
    entryVariant: "vwap_retest_entry",
    exitVariant: "tp1_full_exit",
    state: "CLOSED",
    closeReason: "TP1",
    realizedNetR: 0.5,
    realizedGrossR: 0.6,
    tp1Hit: true,
    entryPrice: 100,
    exitPrice: 105,
    qty: 1,
    side: "LONG",
    openedAt: "2025-01-15T10:00:00Z",
    closedAt: "2025-01-15T12:00:00Z",
    ...overrides,
  } as ShadowVariantPosition;
}

function makePosition(
  symbol: string,
  direction: "LONG" | "SHORT",
  stopBps: number | null,
  riskReward: number | null,
  variants: ShadowVariantPosition[],
  overrides: Partial<ShadowPosition> = {},
): ShadowPosition {
  return {
    id: `pos-${symbol}-${Math.random().toString(36).slice(2)}`,
    symbol,
    direction,
    signalFamily: "VWAP",
    dangerScore: 40,
    riskReward,
    costR: 0.05,
    stopDistanceBps: stopBps,
    marketRegime: "TRENDING",
    latestStatus: "TRADE_NOW",
    variants,
    selectedEntryVariant: "vwap_retest_entry",
    selectedExitVariant: "tp1_full_exit",
    variantSelection: {
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      routeMode: "SHADOW",
      routeScore: 0.72,
      calibratedExpectedNetR: 0.15,
      stopDistanceBps: stopBps,
      routeReasonCodes: [],
      evidenceEra: "POST_CALIBRATION",
    },
    tradePlan: {
      directionQuality: "CLEAR",
      directionGap: 0.3,
      horizonConflict: false,
      entryPlaybook: "RETEST_ENTRY",
    },
    ...overrides,
  } as unknown as ShadowPosition;
}

// POST_CALIBRATION positions with explicit era stamp on variantSelection
function pcPos(
  symbol: string,
  direction: "LONG" | "SHORT",
  stopBps: number | null,
  riskReward: number | null,
  netR: number,
  closeReason: "TP1" | "SL" | "TP2" = "TP1",
  overrides: Partial<ShadowPosition> = {},
): ShadowPosition {
  const tp1Hit = closeReason === "TP1" || closeReason === "TP2";
  return makePosition(
    symbol, direction, stopBps, riskReward,
    [makeVariant({ realizedNetR: netR, realizedGrossR: netR + 0.05, closeReason, tp1Hit })],
    overrides,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildStopGeometryAuditReport", () => {
  it("empty input returns safe report", () => {
    const r = buildStopGeometryAuditReport({ positions: [] });
    expect(r.summary.closedCount).toBe(0);
    expect(r.summary.mainDiagnosis).toBe("INSUFFICIENT_SAMPLE");
    expect(r.stopBuckets).toEqual([]);
    expect(r.rrBuckets).toEqual([]);
    expect(r.geometryMatrix).toEqual([]);
    expect(r.counterfactuals.length).toBe(9); // all 9 scenarios still run
    expect(r.patchHypotheses.length).toBeGreaterThan(0);
    expect(r.answerCards.length).toBe(5);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("POST_CALIBRATION filter works — excludes positions without era stamp", () => {
    // Legacy: no evidenceEra in variantSelection → inferrred from routeMode+calibration
    // To make a true LEGACY, set variantSelection to null
    const legacyPos = {
      ...pcPos("BTC", "LONG", 200, 3, 0.5),
      variantSelection: null,
    } as unknown as ShadowPosition;

    const pcGoodPos = pcPos("ETH", "SHORT", 150, 4, -0.6);

    const r = buildStopGeometryAuditReport({
      positions: [legacyPos, pcGoodPos],
      eraFilter: "POST_CALIBRATION",
    });
    expect(r.summary.closedCount).toBe(1); // only pcGoodPos
    expect(r.summary.mainDiagnosis).toBe("INSUFFICIENT_SAMPLE"); // < 10 trades
  });

  it("stop bucket classification works", () => {
    const positions = [
      pcPos("BTC", "LONG", 50, 5, -0.5, "SL"),    // ULTRA_TIGHT
      pcPos("ETH", "LONG", 120, 4, -0.4, "SL"),   // TIGHT
      pcPos("SOL", "LONG", 250, 3, 0.6),           // MODERATE
      pcPos("BNB", "LONG", 400, 2.5, 0.4),         // WIDE
      pcPos("SUI", "LONG", 600, 2, 0.5),           // VERY_WIDE
      pcPos("ADA", "LONG", null, 3, 0.2),          // UNKNOWN
    ];
    const r = buildStopGeometryAuditReport({ positions });
    const bucketNames = r.stopBuckets.map((b) => b.bucket);
    expect(bucketNames).toContain("ULTRA_TIGHT");
    expect(bucketNames).toContain("TIGHT");
    expect(bucketNames).toContain("MODERATE");
    expect(bucketNames).toContain("WIDE");
    expect(bucketNames).toContain("VERY_WIDE");

    const ultraTight = r.stopBuckets.find((b) => b.bucket === "ULTRA_TIGHT")!;
    expect(ultraTight.closedCount).toBe(1);

    const moderate = r.stopBuckets.find((b) => b.bucket === "MODERATE")!;
    expect((moderate.netAvgR ?? 0)).toBeGreaterThan(0);
  });

  it("RR bucket classification works", () => {
    const positions = [
      pcPos("BTC", "LONG", 200, 1.5, -0.4, "SL"),  // LOW_RR < 3
      pcPos("ETH", "LONG", 200, 4.0, 0.3),          // NORMAL_RR 3–5
      pcPos("SOL", "LONG", 200, 6.5, -0.7, "SL"),   // HIGH_RR 5–8
      pcPos("BNB", "LONG", 200, 10.0, -0.9, "SL"),  // EXTREME_RR > 8
      pcPos("SUI", "LONG", 200, null, 0.1),          // UNKNOWN
    ];
    const r = buildStopGeometryAuditReport({ positions });
    const bucketNames = r.rrBuckets.map((b) => b.bucket);
    expect(bucketNames).toContain("LOW_RR");
    expect(bucketNames).toContain("NORMAL_RR");
    expect(bucketNames).toContain("HIGH_RR");
    expect(bucketNames).toContain("EXTREME_RR");

    const extremeRR = r.rrBuckets.find((b) => b.bucket === "EXTREME_RR")!;
    expect((extremeRR.netAvgR ?? 0)).toBeLessThan(0);
  });

  it("combined geometry matrix aggregates correctly", () => {
    const positions = [
      // ULTRA_TIGHT + EXTREME_RR → all losers
      pcPos("BTC", "LONG", 50, 12, -0.8, "SL"),
      pcPos("BNB", "LONG", 80, 10, -0.7, "SL"),
      pcPos("SOL", "LONG", 60, 15, -0.9, "SL"),
      // WIDE + NORMAL_RR → all winners
      pcPos("ETH", "SHORT", 400, 4, 0.6),
      pcPos("SUI", "SHORT", 450, 3.5, 0.5),
    ];
    const r = buildStopGeometryAuditReport({ positions });

    // ULTRA_TIGHT + EXTREME_RR cell
    const toxicCell = r.geometryMatrix.find(
      (c) => c.stopBucket === "ULTRA_TIGHT" && (c.rrBucket === "EXTREME_RR" || c.rrBucket === "HIGH_RR"),
    );
    expect(toxicCell).toBeDefined();
    expect((toxicCell?.netAvgR ?? 0)).toBeLessThan(0);

    // WIDE + NORMAL_RR cell
    const goodCell = r.geometryMatrix.find(
      (c) => c.stopBucket === "WIDE" && c.rrBucket === "NORMAL_RR",
    );
    expect(goodCell).toBeDefined();
    expect((goodCell?.netAvgR ?? 0)).toBeGreaterThan(0);
  });

  it("counterfactual EXCLUDE_STOP_LT_175 recomputes metrics correctly", () => {
    // 4 tight-stop losers (< 175 bps) and 4 wide-stop winners (>= 175 bps)
    const positions = [
      pcPos("BTC", "LONG", 100, 8, -0.8, "SL"),
      pcPos("BNB", "LONG", 150, 9, -0.7, "SL"),
      pcPos("DOGE", "LONG", 120, 10, -0.6, "SL"),
      pcPos("ADA", "LONG", 140, 7, -0.9, "SL"),
      pcPos("ETH", "SHORT", 300, 3, 0.5),
      pcPos("SOL", "SHORT", 250, 3.5, 0.4),
      pcPos("SUI", "SHORT", 350, 4, 0.6),
      pcPos("NEAR", "SHORT", 400, 3, 0.5),
    ];
    const r = buildStopGeometryAuditReport({ positions });

    const baseline = r.counterfactuals.find((c) => c.scenarioCode === "BASELINE_ALL")!;
    const filtered = r.counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_STOP_LT_175")!;

    expect(filtered.remainingCount).toBe(4); // only wide-stop trades remain
    expect(filtered.excludedCount).toBe(4);
    expect((filtered.netAvgR ?? 0)).toBeGreaterThan((baseline.netAvgR ?? -Infinity));
    expect((filtered.deltaNetAvgRVsBaseline ?? 0)).toBeGreaterThan(0);
    expect(filtered.interpretation).not.toBe("WORSENS");
  });

  it("counterfactual EXCLUDE_RR_GT_5 recomputes metrics correctly", () => {
    // 3 high-RR losers and 3 normal-RR winners
    const positions = [
      pcPos("BTC", "LONG", 100, 8, -0.7, "SL"),
      pcPos("BNB", "LONG", 90, 12, -0.8, "SL"),
      pcPos("DOGE", "LONG", 110, 7, -0.6, "SL"),
      pcPos("ETH", "SHORT", 200, 4, 0.5),
      pcPos("SOL", "SHORT", 250, 3.5, 0.4),
      pcPos("SUI", "SHORT", 300, 3, 0.6),
    ];
    const r = buildStopGeometryAuditReport({ positions });

    const filtered = r.counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_RR_GT_5")!;
    expect(filtered.remainingCount).toBe(3); // only normal-RR trades
    expect((filtered.netAvgR ?? 0)).toBeGreaterThan(0); // winners only remain
    expect((filtered.deltaNetAvgRVsBaseline ?? 0)).toBeGreaterThan(0);
  });

  it("combined exclusion improves when synthetic data supports it", () => {
    // Create clear pattern: tight stop (< 175) + high RR (> 5) are all losers
    // Wide stop (>= 175) + normal RR (3-5) are all winners
    const positions = [
      // Toxic quadrant
      pcPos("BTC", "LONG", 80, 9, -0.9, "SL"),
      pcPos("BNB", "LONG", 100, 11, -0.8, "SL"),
      pcPos("DOGE", "LONG", 120, 8, -0.7, "SL"),
      pcPos("ADA", "LONG", 150, 10, -0.8, "SL"),
      pcPos("XRP", "LONG", 90, 12, -1.0, "SL"),
      // Healthy quadrant
      pcPos("ETH", "SHORT", 300, 4, 0.6),
      pcPos("SOL", "SHORT", 250, 3.5, 0.5),
      pcPos("SUI", "SHORT", 350, 3, 0.7),
      pcPos("NEAR", "SHORT", 400, 4.5, 0.6),
      pcPos("AVAX", "SHORT", 280, 3.8, 0.5),
    ];
    const r = buildStopGeometryAuditReport({ positions });

    const combCF = r.counterfactuals.find((c) => c.scenarioCode === "EXCLUDE_STOP_LT_175_AND_RR_GT_5")!;
    expect(combCF.remainingCount).toBe(5); // only healthy quadrant
    expect((combCF.deltaNetAvgRVsBaseline ?? 0)).toBeGreaterThan(0);
    // Combined scenario should strongly improve
    expect(["STRONGLY_IMPROVES", "MODESTLY_IMPROVES"]).toContain(combCF.interpretation);
  });

  it("confounder control distinguishes independent geometry issue from symbol-only concentration", () => {
    // Tight stops spread across directions, not just one direction
    const positions = [
      // LONG tight stops → bad
      pcPos("BTC", "LONG", 100, 9, -0.7, "SL"),
      pcPos("ETH", "LONG", 120, 8, -0.8, "SL"),
      pcPos("SOL", "LONG", 90, 10, -0.6, "SL"),
      // SHORT tight stops → also bad
      pcPos("BNB", "SHORT", 110, 11, -0.9, "SL"),
      pcPos("ADA", "SHORT", 140, 9, -0.7, "SL"),
      pcPos("DOGE", "SHORT", 130, 8, -0.8, "SL"),
    ];
    const r = buildStopGeometryAuditReport({ positions });

    const longSlice = r.confounderSlices.find((s) => s.sliceType === "direction" && s.sliceValue === "LONG");
    const shortSlice = r.confounderSlices.find((s) => s.sliceType === "direction" && s.sliceValue === "SHORT");

    expect(longSlice).toBeDefined();
    expect(shortSlice).toBeDefined();
    // Both directions should show tight stops
    expect((longSlice?.tightStopRate ?? 0)).toBeGreaterThan(0);
    expect((shortSlice?.tightStopRate ?? 0)).toBeGreaterThan(0);
  });

  it("threshold insight emitted when toxic pattern is concentrated", () => {
    // 5 tight-stop losers, 5 wide-stop winners → clear threshold signal at 175
    const positions = [
      pcPos("BTC", "LONG", 80, 10, -0.9, "SL"),
      pcPos("BNB", "LONG", 100, 9, -0.8, "SL"),
      pcPos("DOGE", "LONG", 120, 11, -0.7, "SL"),
      pcPos("ADA", "LONG", 90, 8, -0.8, "SL"),
      pcPos("XRP", "LONG", 140, 12, -0.9, "SL"),
      pcPos("ETH", "SHORT", 300, 4, 0.6),
      pcPos("SOL", "SHORT", 350, 3.5, 0.7),
      pcPos("SUI", "SHORT", 250, 4.5, 0.5),
      pcPos("NEAR", "SHORT", 400, 3, 0.8),
      pcPos("AVAX", "SHORT", 280, 4, 0.6),
    ];
    const r = buildStopGeometryAuditReport({ positions });

    // Should have threshold insights for stop thresholds
    expect(r.thresholdInsights.length).toBeGreaterThan(0);
    const stopInsight = r.thresholdInsights.find((t) => t.thresholdType === "STOP");
    expect(stopInsight).toBeDefined();
    // Tight-stop trades should have worse avg R than retained trades
    expect((stopInsight?.excludedTradesNetAvgR ?? 0)).toBeLessThan(0);
    expect((stopInsight?.retainedTradesNetAvgR ?? 0)).toBeGreaterThan(
      stopInsight?.excludedTradesNetAvgR ?? -Infinity,
    );
  });

  it("answer cards remain conservative on tiny sample", () => {
    const positions = [
      pcPos("BTC", "LONG", 100, 8, -0.5, "SL"),
      pcPos("ETH", "SHORT", 300, 4, 0.4),
    ];
    const r = buildStopGeometryAuditReport({ positions });
    expect(r.answerCards.length).toBe(5);
    // With only 2 trades, answers should mention insufficient data
    const firstCard = r.answerCards[0].answer.toLowerCase();
    expect(firstCard).toMatch(/too few|insufficient|accumulate/);
  });

  it("no ranking, routing, or execution mutation fields returned", () => {
    const positions = [
      pcPos("BTC", "LONG", 200, 4, 0.5),
    ];
    const r = buildStopGeometryAuditReport({ positions });
    const keys = Object.keys(r);
    expect(keys).not.toContain("newRoute");
    expect(keys).not.toContain("selectedVariant");
    expect(keys).not.toContain("liveGate");
    expect(keys).not.toContain("rankingAdjustment");
    expect(typeof r.generatedAt).toBe("string");
    expect(typeof r.eraFilter).toBe("string");
    expect(r.notes.some((n) => n.toLowerCase().includes("read-only"))).toBe(true);
  });
});

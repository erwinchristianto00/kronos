import { describe, it, expect } from "vitest";
import { buildWinnerLoserAuditReport } from "../src/lib/winner-loser-audit.js";
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
  variants: ShadowVariantPosition[],
  overrides: Partial<ShadowPosition> = {},
): ShadowPosition {
  return {
    id: `pos-${symbol}-${direction}-${Math.random().toString(36).slice(2)}`,
    symbol,
    direction,
    signalFamily: "VWAP",
    dangerScore: 40,
    riskReward: 2.5,
    costR: 0.05,
    stopDistanceBps: 80,
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
      rawExpectedNetR: 0.25,
      calibrationVerdict: "CALIBRATED_POSITIVE",
      costR: 0.05,
      stopDistanceBps: 80,
      chaseRisk: "LOW",
      entryDriftPct: 0.1,
      routeReasonCodes: ["KRONOS_AGREES"],
    },
    tradePlan: {
      directionQuality: "CLEAR",
      directionGap: 0.3,
      horizonConflict: false,
      entryPlaybook: "RETEST_ENTRY",
    },
    evidenceEra: "POST_CALIBRATION",
    ...overrides,
  } as unknown as ShadowPosition;
}

/** POST_CALIBRATION era marker on variantSelection */
function withEra(pos: ShadowPosition, era: string): ShadowPosition {
  return {
    ...pos,
    variantSelection: { ...(pos.variantSelection as object), evidenceEra: era },
  } as ShadowPosition;
}

// Build a position that classifyEvidenceEra will read as POST_CALIBRATION
// classifyEvidenceEra checks pos.variantSelection.evidenceEra
function pcPosition(
  symbol: string,
  direction: "LONG" | "SHORT",
  variants: ShadowVariantPosition[],
  overrides: Partial<ShadowPosition> = {},
): ShadowPosition {
  const base = makePosition(symbol, direction, variants, overrides);
  return withEra(base, "POST_CALIBRATION");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildWinnerLoserAuditReport", () => {
  it("empty positions returns safe report", () => {
    const r = buildWinnerLoserAuditReport({ positions: [] });
    expect(r.summary.closedCount).toBe(0);
    expect(r.summary.mainDiagnosis).toBe("INSUFFICIENT_SAMPLE");
    expect(r.featureComparisons).toEqual([]);
    expect(r.topWinnerSignals).toEqual([]);
    expect(r.topLoserSignals).toEqual([]);
    expect(r.contextSlices).toEqual([]);
    expect(r.patchHypotheses.length).toBeGreaterThan(0); // fallback "no patch yet"
    expect(Array.isArray(r.flags)).toBe(true);
    expect(r.answerCards.length).toBe(5);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("POST_CALIBRATION filter excludes legacy positions", () => {
    // classifyEvidenceEra infers era from variantSelection fields.
    // A true legacy position must have NO variantSelection (or one with no routeMode/calibration).
    const legacyVariant = makeVariant({ realizedNetR: 0.8 });
    const legacy = {
      ...makePosition("BTC", "LONG", [legacyVariant]),
      variantSelection: null, // forces classifyEvidenceEra to return LEGACY_PRE_ROUTING
    } as unknown as ShadowPosition;

    const pcVariant = makeVariant({ realizedNetR: -0.5 });
    const pc = pcPosition("ETH", "SHORT", [pcVariant]);

    const r = buildWinnerLoserAuditReport({ positions: [legacy, pc], eraFilter: "POST_CALIBRATION" });
    // Only pc included → 1 close, 0 winners, 1 loser
    expect(r.summary.closedCount).toBe(1);
    expect(r.summary.loserCount).toBe(1);
    expect(r.summary.winnerCount).toBe(0);
  });

  it("ALL filter includes all eras", () => {
    const legacyVariant = makeVariant({ realizedNetR: 0.6 });
    const legacy = makePosition("BTC", "LONG", [legacyVariant]);

    const pcVariant = makeVariant({ realizedNetR: -0.5 });
    const pc = pcPosition("ETH", "SHORT", [pcVariant]);

    const r = buildWinnerLoserAuditReport({ positions: [legacy, pc], eraFilter: "ALL" });
    expect(r.summary.closedCount).toBe(2);
  });

  it("winners vs losers split is correct", () => {
    const positions = [
      pcPosition("BTC", "LONG", [makeVariant({ realizedNetR: 0.8 })]),
      pcPosition("BTC", "LONG", [makeVariant({ realizedNetR: 0.5 })]),
      pcPosition("ETH", "SHORT", [makeVariant({ realizedNetR: -0.4 })]),
      pcPosition("ETH", "SHORT", [makeVariant({ realizedNetR: -0.6 })]),
      pcPosition("SOL", "LONG", [makeVariant({ realizedNetR: 0 })]),
    ];
    const r = buildWinnerLoserAuditReport({ positions });
    expect(r.summary.closedCount).toBe(5);
    expect(r.summary.winnerCount).toBe(2);
    expect(r.summary.loserCount).toBe(2);
    expect(r.summary.breakevenCount).toBe(1);
  });

  it("topWinnerSignals detects a supported winner-skewed feature", () => {
    // dangerScore: winners have low danger (20), losers have high danger (80)
    const lowDangerPos = (sym: string) =>
      pcPosition(sym, "LONG", [makeVariant({ realizedNetR: 0.8 })], { dangerScore: 20 });
    const highDangerPos = (sym: string) =>
      pcPosition(sym, "SHORT", [makeVariant({ realizedNetR: -0.6 })], { dangerScore: 80 });

    const positions = [
      lowDangerPos("BTC"), lowDangerPos("ETH"), lowDangerPos("SOL"),
      lowDangerPos("BNB"), lowDangerPos("SUI"),
      highDangerPos("DOGE"), highDangerPos("ADA"), highDangerPos("XRP"),
      highDangerPos("AVAX"), highDangerPos("MATIC"),
    ];
    const r = buildWinnerLoserAuditReport({ positions });
    // dangerScore should show up as WINNER_SKEW (lower danger → winner)
    const dangerFeat = r.featureComparisons.find((f) => f.featureName === "dangerScore");
    expect(dangerFeat).toBeDefined();
    expect(dangerFeat?.liftOrDrag).toBe("WINNER_SKEW");

    // topWinnerSignals should not be empty
    expect(r.topWinnerSignals.length).toBeGreaterThan(0);
  });

  it("topLoserSignals detects a supported loser-skewed feature", () => {
    // Create a counter-intuitive scenario: losers have CLEAR direction quality more than winners.
    // directionClear: trueIsWinnerFavorable=true, isTrue = quality==="CLEAR"
    // If losers have MORE CLEAR quality: delta = wClearRate - lClearRate < 0
    // → NOT (delta > 0 && trueIsWinnerFavorable) → LOSER_SKEW
    const vagueWinPos = (sym: string) =>
      pcPosition(sym, "LONG", [makeVariant({ realizedNetR: 0.6 })], {
        tradePlan: { directionQuality: "MIXED", directionGap: 0.1, horizonConflict: false,
          entryPlaybook: "RETEST_ENTRY" },
      } as Partial<ShadowPosition>);

    const clearLosePos = (sym: string) =>
      pcPosition(sym, "SHORT", [makeVariant({ realizedNetR: -0.7 })], {
        tradePlan: { directionQuality: "CLEAR", directionGap: 0.5, horizonConflict: false,
          entryPlaybook: "RETEST_ENTRY" },
      } as Partial<ShadowPosition>);

    const positions = [
      vagueWinPos("BTC"), vagueWinPos("ETH"), vagueWinPos("SOL"),
      vagueWinPos("BNB"), vagueWinPos("SUI"),
      clearLosePos("DOGE"), clearLosePos("ADA"), clearLosePos("XRP"),
      clearLosePos("AVAX"), clearLosePos("MATIC"),
    ];
    const r = buildWinnerLoserAuditReport({ positions });
    // directionClear should be LOSER_SKEW (losers have more CLEAR direction)
    const clearFeat = r.featureComparisons.find((f) => f.featureName === "directionClear");
    expect(clearFeat).toBeDefined();
    expect(clearFeat?.liftOrDrag).toBe("LOSER_SKEW");
    expect(r.topLoserSignals.length).toBeGreaterThan(0);
  });

  it("does not emit highChaseRisk=true as a loser signal when the loser-skewed condition is actually false", () => {
    const winner = (sym: string) =>
      pcPosition(sym, "LONG", [makeVariant({ realizedNetR: 0.8 })], {
        variantSelection: { chaseRisk: "HIGH" },
      } as Partial<ShadowPosition>);

    const loserHigh = (sym: string) =>
      pcPosition(sym, "SHORT", [makeVariant({ realizedNetR: -0.7 })], {
        variantSelection: { chaseRisk: "HIGH" },
      } as Partial<ShadowPosition>);

    const loserLow = (sym: string) =>
      pcPosition(sym, "SHORT", [makeVariant({ realizedNetR: -0.7 })], {
        variantSelection: { chaseRisk: "LOW" },
      } as Partial<ShadowPosition>);

    const positions = [
      winner("BTC"), winner("ETH"), winner("SOL"), winner("BNB"), winner("SUI"),
      loserHigh("DOGE"), loserHigh("ADA"), loserHigh("XRP"), loserHigh("AVAX"),
      loserLow("MATIC"),
    ];

    const r = buildWinnerLoserAuditReport({ positions });
    const chaseFeat = r.featureComparisons.find((f) => f.featureName === "highChaseRisk");
    expect(chaseFeat?.liftOrDrag).toBe("LOSER_SKEW");

    const topLoser = r.topLoserSignals.find((signal) => signal.feature.startsWith("highChaseRisk"));
    expect(topLoser).toBeDefined();
    expect(topLoser?.feature).toBe("highChaseRisk=false");
    expect(topLoser?.observedPattern).toBe("Losers: 20% vs winners: 0%");
    expect(r.topLoserSignals.some((signal) => signal.feature === "highChaseRisk=true")).toBe(false);
  });

  it("leading route audit covers vwap_retest_entry + tp1_full_exit specifically", () => {
    const positions = [
      pcPosition("BTC", "LONG", [makeVariant({ realizedNetR: 0.6 })]),
      pcPosition("ETH", "SHORT", [makeVariant({ realizedNetR: -0.5 })]),
    ];
    const r = buildWinnerLoserAuditReport({ positions });
    expect(r.leadingRouteAudit.routeLabel).toBe("vwap_retest_entry + tp1_full_exit");
  });

  it("leadingRouteAudit returns INSUFFICIENT_SAMPLE when fewer than 5 closes", () => {
    const positions = [
      pcPosition("BTC", "LONG", [makeVariant({ realizedNetR: 0.6 })]),
      pcPosition("ETH", "SHORT", [makeVariant({ realizedNetR: -0.5 })]),
    ];
    const r = buildWinnerLoserAuditReport({ positions });
    expect(r.leadingRouteAudit.routeDiagnosis).toBe("INSUFFICIENT_SAMPLE");
  });

  it("toxic symbol-direction-route slice detected", () => {
    // BTC/SHORT loses every time with SL
    const positions: ShadowPosition[] = [];
    for (let i = 0; i < 5; i++) {
      positions.push(
        pcPosition("BTC", "SHORT", [
          makeVariant({ realizedNetR: -0.8, closeReason: "SL", tp1Hit: false }),
        ]),
      );
    }
    // Add some winners on other symbols to not make it LOSSES_BROAD_BASED
    for (let i = 0; i < 5; i++) {
      positions.push(
        pcPosition("ETH", "LONG", [makeVariant({ realizedNetR: 0.6 })]),
      );
    }
    const r = buildWinnerLoserAuditReport({ positions });
    const toxic = r.contextSlices.filter((s) => s.verdict === "TOXIC_SLICE");
    expect(toxic.length).toBeGreaterThan(0);
    expect(toxic[0].symbol).toBe("BTC");
    // Flags should include SYMBOL_DIRECTION_TOXIC_SLICE
    expect(r.flags.some((f) => f.code === "SYMBOL_DIRECTION_TOXIC_SLICE")).toBe(true);
  });

  it("promising symbol-direction-route slice detected", () => {
    const positions: ShadowPosition[] = [];
    // BTC/LONG: consistently wins with high netR and winRate
    for (let i = 0; i < 5; i++) {
      positions.push(
        pcPosition("BTC", "LONG", [makeVariant({ realizedNetR: 0.8, tp1Hit: true })]),
      );
    }
    // ETH loses to provide contrast
    for (let i = 0; i < 5; i++) {
      positions.push(
        pcPosition("ETH", "SHORT", [makeVariant({ realizedNetR: -0.4, closeReason: "SL" })]),
      );
    }
    const r = buildWinnerLoserAuditReport({ positions });
    const promising = r.contextSlices.filter((s) => s.verdict === "PROMISING_SLICE");
    expect(promising.length).toBeGreaterThan(0);
    expect(r.flags.some((f) => f.code === "SYMBOL_DIRECTION_PROMISING_SLICE")).toBe(true);
  });

  it("patch hypotheses generated without mutating strategy", () => {
    const positions = [
      pcPosition("BTC", "LONG", [makeVariant({ realizedNetR: 0.5 })]),
      pcPosition("ETH", "SHORT", [makeVariant({ realizedNetR: -0.6 })]),
    ];
    const r = buildWinnerLoserAuditReport({ positions });
    expect(r.patchHypotheses.length).toBeGreaterThan(0);
    // The notes should say this is read-only
    expect(r.notes.some((n) => n.toLowerCase().includes("read-only"))).toBe(true);
  });

  it("answer cards are conservative on small sample", () => {
    const positions = [
      pcPosition("BTC", "LONG", [makeVariant({ realizedNetR: 0.5 })]),
    ];
    const r = buildWinnerLoserAuditReport({ positions });
    expect(r.answerCards.length).toBe(5);
    // With only 1 close, should mention "too few"
    const firstCard = r.answerCards[0].answer.toLowerCase();
    expect(firstCard).toMatch(/too few|insufficient|early|accumulate/);
  });

  it("no routing or ranking mutation fields returned", () => {
    const positions = [
      pcPosition("BTC", "LONG", [makeVariant({ realizedNetR: 0.5 })]),
    ];
    const r = buildWinnerLoserAuditReport({ positions });
    // Report should NOT contain fields that could indicate live mutation
    const keys = Object.keys(r);
    expect(keys).not.toContain("newRoute");
    expect(keys).not.toContain("selectedVariant");
    expect(keys).not.toContain("liveGate");
    expect(keys).not.toContain("rankingAdjustment");
    // generatedAt, eraFilter, summary etc. should exist
    expect(typeof r.generatedAt).toBe("string");
    expect(typeof r.eraFilter).toBe("string");
  });
});

import { describe, it, expect } from "vitest";
import { buildSymbolRouteSuitabilityReport } from "../src/lib/symbol-route-suitability.js";
import type { StrategyExperienceRecord } from "@dtc/shared";

// ─── Fixture builders ─────────────────────────────────────────────────────────

let counter = 0;

function makeRecord(opts: {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  entry?: string | null;
  exit?: string | null;
  netR?: number;
  grossR?: number;
  tp1Hit?: boolean;
  slHit?: boolean;
  closeReason?: "TP1" | "TP2" | "SL" | "BREAKEVEN" | "TIME" | null;
  era?: "POST_CALIBRATION" | "POST_ROUTING_PRE_CALIBRATION" | "LEGACY_PRE_ROUTING" | null;
}): StrategyExperienceRecord {
  const netR = opts.netR ?? 0;
  const closeReason = opts.closeReason ?? (netR > 0 ? "TP1" : "SL");
  const slHit = opts.slHit ?? (closeReason === "SL" || closeReason === "BREAKEVEN");
  const tp1Hit = opts.tp1Hit ?? (closeReason === "TP1" || closeReason === "TP2");
  return {
    context: {
      schemaVersion: 1,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction ?? "LONG",
      scanTimestamp: null,
      evidenceEra: opts.era ?? "POST_CALIBRATION",
      selectedEntryVariant: opts.entry === undefined ? "vwap_retest_entry" : opts.entry,
      selectedExitVariant: opts.exit === undefined ? "tp1_full_exit" : opts.exit,
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `pos-${++counter}`,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction ?? "LONG",
      selectedEntryVariant: opts.entry === undefined ? "vwap_retest_entry" : opts.entry,
      selectedExitVariant: opts.exit === undefined ? "tp1_full_exit" : opts.exit,
      evidenceEra: opts.era ?? "POST_CALIBRATION",
      realizedNetR: netR,
      realizedGrossR: opts.grossR ?? netR + 0.05,
      winnerLabel: netR > 0 ? "WIN" : netR < 0 ? "LOSS" : "BREAKEVEN",
      tp1Hit,
      slHit,
      closeReason,
    } as StrategyExperienceRecord["outcome"],
  };
}

function many(n: number, base: Parameters<typeof makeRecord>[0]): StrategyExperienceRecord[] {
  return Array.from({ length: n }, () => makeRecord(base));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildSymbolRouteSuitabilityReport", () => {
  it("empty input returns safe empty report", () => {
    const r = buildSymbolRouteSuitabilityReport([]);
    expect(r.metadata.resolvedExperienceRecordCount).toBe(0);
    expect(r.metadata.symbolDirectionPairCount).toBe(0);
    expect(r.candidateAssessments).toEqual([]);
    expect(r.symbolDirectionSummaries).toEqual([]);
    expect(r.routeHeterogeneity).toEqual([]);
    expect(r.topPromisingCohorts).toEqual([]);
    expect(r.topToxicCohorts).toEqual([]);
    expect(r.readiness.advisoryEngineReady).toBe(true);
    expect(r.readiness.readyForRoutingInfluence).toBe(false);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("groups records by (symbol, direction, entry, exit) correctly", () => {
    const records = [
      ...many(3, { symbol: "BTCUSDT", direction: "LONG", entry: "vwap_retest_entry", exit: "tp1_full_exit", netR: 0.5 }),
      ...many(2, { symbol: "BTCUSDT", direction: "LONG", entry: "vwap_retest_entry", exit: "tp2_full_exit", netR: 0.4 }),
      ...many(4, { symbol: "BTCUSDT", direction: "SHORT", entry: "vwap_retest_entry", exit: "tp1_full_exit", netR: -0.3 }),
      ...many(5, { symbol: "ETHUSDT", direction: "LONG", entry: "breakout_entry", exit: "tp1_full_exit", netR: 0.2 }),
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    expect(r.candidateAssessments.length).toBe(4);
    const btcLongTp1 = r.candidateAssessments.find(
      (c) => c.symbol === "BTCUSDT" && c.direction === "LONG" && c.selectedExitVariant === "tp1_full_exit",
    );
    expect(btcLongTp1?.closedCount).toBe(3);
    expect(btcLongTp1?.routeCombo).toBe("vwap_retest_entry + tp1_full_exit");
    expect(r.metadata.symbolDirectionPairCount).toBe(3);
  });

  it("sample tier boundaries: 0/1/4/5/14/15/29/30", () => {
    const cases: Array<{ count: number; expected: string }> = [
      { count: 1, expected: "TOO_EARLY" },
      { count: 4, expected: "TOO_EARLY" },
      { count: 5, expected: "EARLY" },
      { count: 14, expected: "EARLY" },
      { count: 15, expected: "WATCHABLE" },
      { count: 29, expected: "WATCHABLE" },
      { count: 30, expected: "EVALUABLE" },
    ];
    for (const c of cases) {
      const r = buildSymbolRouteSuitabilityReport(
        many(c.count, { symbol: `SYM${c.count}USDT`, direction: "LONG", netR: 0.2 }),
      );
      const cohort = r.candidateAssessments[0];
      expect(cohort.closedCount).toBe(c.count);
      expect(cohort.sampleTier).toBe(c.expected);
    }
  });

  it("verdict transitions: TOO_EARLY_POSITIVE / EARLY_PROMISING / EVALUABLE_TOXIC / MIXED", () => {
    // TOO_EARLY_POSITIVE: n<5, netAvgR>0
    const earlyPos = buildSymbolRouteSuitabilityReport(many(3, { symbol: "A", direction: "LONG", netR: 0.3 }));
    expect(earlyPos.candidateAssessments[0].localVerdict).toBe("TOO_EARLY_POSITIVE");

    // TOO_EARLY_NEGATIVE
    const earlyNeg = buildSymbolRouteSuitabilityReport(many(3, { symbol: "B", direction: "LONG", netR: -0.3 }));
    expect(earlyNeg.candidateAssessments[0].localVerdict).toBe("TOO_EARLY_NEGATIVE");

    // EARLY_PROMISING: 5–14, netAvgR>0.10, PF>1.0
    const earlyPromising = buildSymbolRouteSuitabilityReport([
      ...many(6, { symbol: "C", direction: "LONG", netR: 0.5 }),
      ...many(2, { symbol: "C", direction: "LONG", netR: -0.2 }),
    ]);
    expect(earlyPromising.candidateAssessments[0].localVerdict).toBe("EARLY_PROMISING");

    // EVALUABLE_TOXIC: 30+, netAvgR<-0.15
    const evalToxic = buildSymbolRouteSuitabilityReport(many(32, { symbol: "D", direction: "LONG", netR: -0.4 }));
    expect(evalToxic.candidateAssessments[0].localVerdict).toBe("EVALUABLE_TOXIC");

    // MIXED at WATCHABLE (15+, but not strong enough for PROMISING and not weak enough for WEAK)
    const mixed = buildSymbolRouteSuitabilityReport([
      ...many(8, { symbol: "E", direction: "LONG", netR: 0.05 }),
      ...many(8, { symbol: "E", direction: "LONG", netR: -0.05 }),
    ]);
    expect(["MIXED"]).toContain(mixed.candidateAssessments[0].localVerdict);
  });

  it("EVALUABLE_PROMISING requires 30+ closes with strong stats", () => {
    const promising = buildSymbolRouteSuitabilityReport([
      ...many(25, { symbol: "X", direction: "LONG", netR: 0.5 }),
      ...many(7, { symbol: "X", direction: "LONG", netR: -0.3 }),
    ]);
    expect(promising.candidateAssessments[0].localVerdict).toBe("EVALUABLE_PROMISING");
  });

  it("suitability score weights high-sample positive cohorts above tiny-sample positive cohorts", () => {
    const records = [
      ...many(2, { symbol: "TINY", direction: "LONG", netR: 0.55 }), // TOO_EARLY positive
      ...many(30, { symbol: "BIG", direction: "LONG", netR: 0.30 }), // EVALUABLE positive (lower netR)
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    const tiny = r.candidateAssessments.find((c) => c.symbol === "TINY")!;
    const big = r.candidateAssessments.find((c) => c.symbol === "BIG")!;
    expect(big.localSuitabilityScore).toBeGreaterThan(tiny.localSuitabilityScore);
    expect(big.confidenceTier).toBe("HIGH");
    expect(tiny.confidenceTier).toBe("LOW");
  });

  it("symbol-direction summary picks the route with the highest suitability score", () => {
    const records = [
      ...many(20, { symbol: "BTCUSDT", direction: "LONG", entry: "vwap_retest_entry", exit: "tp1_full_exit", netR: 0.4 }),
      ...many(8, { symbol: "BTCUSDT", direction: "LONG", entry: "breakout_entry", exit: "tp1_full_exit", netR: 0.05 }),
      ...many(6, { symbol: "BTCUSDT", direction: "LONG", entry: "breakout_entry", exit: "tp2_full_exit", netR: -0.1 }),
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    const summary = r.symbolDirectionSummaries.find((s) => s.symbol === "BTCUSDT" && s.direction === "LONG")!;
    expect(summary.bestAdvisoryRoute?.routeCombo).toBe("vwap_retest_entry + tp1_full_exit");
    expect(summary.alternativeRoutes.length).toBe(2);
  });

  it("all-negative symbol-direction does not claim 'promising'", () => {
    const records = [
      ...many(10, { symbol: "DOOM", direction: "LONG", entry: "vwap_retest_entry", exit: "tp1_full_exit", netR: -0.4 }),
      ...many(8, { symbol: "DOOM", direction: "LONG", entry: "breakout_entry", exit: "tp1_full_exit", netR: -0.5 }),
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    const summary = r.symbolDirectionSummaries.find((s) => s.symbol === "DOOM")!;
    expect(summary.localEvidenceVerdict).toBe("MOSTLY_NEGATIVE");
    expect(summary.bestAdvisoryRoute?.localVerdict).not.toBe("EARLY_PROMISING");
    expect(summary.bestAdvisoryRoute?.localVerdict).not.toBe("WATCHABLE_PROMISING");
    expect(summary.bestAdvisoryRoute?.localVerdict).not.toBe("EVALUABLE_PROMISING");
  });

  it("route heterogeneity: SYMBOL_SENSITIVE when divergent slices exist for same route", () => {
    const records = [
      ...many(8, { symbol: "BTCUSDT", direction: "LONG", entry: "vwap_retest_entry", exit: "tp1_full_exit", netR: 0.4 }),
      ...many(8, { symbol: "ETHUSDT", direction: "LONG", entry: "vwap_retest_entry", exit: "tp1_full_exit", netR: -0.4 }),
      ...many(5, { symbol: "SOLUSDT", direction: "LONG", entry: "vwap_retest_entry", exit: "tp1_full_exit", netR: 0.05 }),
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    const route = r.routeHeterogeneity.find((h) => h.routeCombo === "vwap_retest_entry + tp1_full_exit")!;
    expect(route.verdict).toBe("SYMBOL_SENSITIVE");
    expect(route.strongestPositiveSlice?.symbol).toBe("BTCUSDT");
    expect(route.strongestNegativeSlice?.symbol).toBe("ETHUSDT");
  });

  it("route heterogeneity: BROADLY_WEAK when consistently poor across symbols", () => {
    const records = [
      ...many(7, { symbol: "BTCUSDT", direction: "LONG", entry: "bad_entry", exit: "bad_exit", netR: -0.3 }),
      ...many(7, { symbol: "ETHUSDT", direction: "LONG", entry: "bad_entry", exit: "bad_exit", netR: -0.4 }),
      ...many(7, { symbol: "SOLUSDT", direction: "LONG", entry: "bad_entry", exit: "bad_exit", netR: -0.25 }),
      ...many(7, { symbol: "BNBUSDT", direction: "LONG", entry: "bad_entry", exit: "bad_exit", netR: -0.35 }),
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    const route = r.routeHeterogeneity.find((h) => h.routeCombo === "bad_entry + bad_exit")!;
    expect(route.verdict).toBe("BROADLY_WEAK");
  });

  it("route heterogeneity: INSUFFICIENT_EVIDENCE when ≤2 meaningful slices", () => {
    const records = [
      ...many(8, { symbol: "BTCUSDT", direction: "LONG", entry: "lonely_entry", exit: "lonely_exit", netR: 0.3 }),
      ...many(6, { symbol: "ETHUSDT", direction: "LONG", entry: "lonely_entry", exit: "lonely_exit", netR: 0.2 }),
      ...many(2, { symbol: "SOLUSDT", direction: "LONG", entry: "lonely_entry", exit: "lonely_exit", netR: 0.1 }), // < 5, not meaningful
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    const route = r.routeHeterogeneity.find((h) => h.routeCombo === "lonely_entry + lonely_exit")!;
    expect(route.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("route heterogeneity: BROADLY_PROMISING when consistently positive across symbols", () => {
    const records = [
      ...many(7, { symbol: "BTCUSDT", direction: "LONG", entry: "good_entry", exit: "good_exit", netR: 0.4 }),
      ...many(7, { symbol: "ETHUSDT", direction: "LONG", entry: "good_entry", exit: "good_exit", netR: 0.3 }),
      ...many(7, { symbol: "SOLUSDT", direction: "LONG", entry: "good_entry", exit: "good_exit", netR: 0.25 }),
      ...many(7, { symbol: "BNBUSDT", direction: "LONG", entry: "good_entry", exit: "good_exit", netR: 0.35 }),
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    const route = r.routeHeterogeneity.find((h) => h.routeCombo === "good_entry + good_exit")!;
    expect(route.verdict).toBe("BROADLY_PROMISING");
  });

  it("evidence era filter: POST_CALIBRATION excludes legacy records", () => {
    const records = [
      ...many(5, { symbol: "BTCUSDT", direction: "LONG", netR: 0.4, era: "POST_CALIBRATION" }),
      ...many(5, { symbol: "BTCUSDT", direction: "LONG", netR: -0.5, era: "LEGACY_PRE_ROUTING" }),
    ];
    const rPost = buildSymbolRouteSuitabilityReport(records, { evidenceEra: "POST_CALIBRATION" });
    expect(rPost.metadata.resolvedExperienceRecordCount).toBe(5);
    expect(rPost.candidateAssessments[0].netAvgR).toBeGreaterThan(0);

    const rAll = buildSymbolRouteSuitabilityReport(records, { evidenceEra: "ALL_TIME" });
    expect(rAll.metadata.resolvedExperienceRecordCount).toBe(10);
  });

  it("readiness is always advisory-only in Phase 2B.1", () => {
    const records = many(100, { symbol: "BTCUSDT", direction: "LONG", netR: 0.6 });
    const r = buildSymbolRouteSuitabilityReport(records);
    expect(r.readiness.advisoryEngineReady).toBe(true);
    expect(r.readiness.readyForRoutingInfluence).toBe(false);
    expect(r.readiness.reasons.some((m) => m.includes("advisory"))).toBe(true);
  });

  it("metadata reports closed-count thresholds correctly per (symbol, direction) pair", () => {
    const records = [
      ...many(35, { symbol: "BIGPAIR", direction: "LONG", entry: "e1", exit: "x1", netR: 0.2 }),
      ...many(16, { symbol: "MIDPAIR", direction: "LONG", entry: "e1", exit: "x1", netR: 0.1 }),
      ...many(6, { symbol: "SMALL", direction: "LONG", entry: "e1", exit: "x1", netR: 0.0 }),
      ...many(2, { symbol: "TINY", direction: "LONG", entry: "e1", exit: "x1", netR: 0.0 }),
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    expect(r.metadata.pairsWithAtLeast5Closes).toBe(3);
    expect(r.metadata.pairsWithAtLeast15Closes).toBe(2);
    expect(r.metadata.pairsWithAtLeast30Closes).toBe(1);
  });

  // ── ISSUE 1: Multiplicity-flagged cohort must NOT appear as "Top promising" ──

  it("ISSUE 1a: multiplicity-flagged DOGE-like cohort (nRaw=5, nEff=1, warning=true) does NOT appear in topPromisingCohorts", () => {
    // 5 records all sharing the same time+price bucket → nEffective=1, warning=true
    const dogeRecords = Array.from({ length: 5 }, () =>
      makeRecord({
        symbol: "DOGEUSDT",
        direction: "LONG",
        entry: "fib_500_entry",
        exit: "tp1_full_exit",
        netR: 0.35,
      }),
    );
    // Give them the same openedAt and entryPrice through the context
    // (signal-multiplicity-guardrail uses outcome.openedAt and context.entryPrice)
    // Since makeRecord does not set openedAt/entryPrice, all records will land in
    // unique null-price buckets — but signalMultiplicityWarning requires the guardrail.
    // We test via earlyPromisingBlocked=true on the cohort (warning path).
    // Use a fixture that forces the warning via the suitability report builder:
    // To get signalMultiplicityWarning, the records must share time+price buckets.
    // Inject via the raw context fields used by computeSignalMultiplicity.
    const dogeRecordsWithBucket = dogeRecords.map((r) => ({
      ...r,
      context: {
        ...r.context,
        entryPrice: 0.1523,
      },
      outcome: {
        ...r.outcome,
        openedAt: "2024-01-01T10:05:00.000Z",
      },
    }));
    const report = buildSymbolRouteSuitabilityReport(dogeRecordsWithBucket as any);
    const cohort = report.candidateAssessments[0];
    expect(cohort).toBeDefined();
    expect(cohort.signalMultiplicityWarning).toBe(true);
    expect(cohort.earlyPromisingBlocked).toBe(true);
    // Must NOT appear in topPromisingCohorts
    expect(report.topPromisingCohorts.some((c) => c.symbol === "DOGEUSDT")).toBe(false);
    // Must appear in highestRawReturnMultiplicityFlaggedCohort instead
    expect(report.highestRawReturnMultiplicityFlaggedCohort?.symbol).toBe("DOGEUSDT");
  });

  it("ISSUE 1b: cohort where all rows are RAW_EDGE_NOT_VALIDATED does NOT appear in topPromisingCohorts", () => {
    // 6 records all RAW_EDGE_NOT_VALIDATED with positive netR → would qualify for EARLY_PROMISING
    // but earlyPromisingBlocked=true due to calibrationVerdict
    const records = Array.from({ length: 6 }, (_, i) =>
      makeRecord({
        symbol: "RAWUSDT",
        direction: "LONG",
        entry: "fib_500_entry",
        exit: "tp1_full_exit",
        netR: 0.4,
      }),
    ).map((r) => ({
      ...r,
      context: {
        ...r.context,
        calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" as const,
        entryPrice: 100 + Math.random(), // unique prices → no multiplicity warning
      },
      outcome: {
        ...r.outcome,
        openedAt: new Date(Date.now() + Math.random() * 1e9).toISOString(), // unique times
      },
    }));
    const report = buildSymbolRouteSuitabilityReport(records as any);
    const cohort = report.candidateAssessments[0];
    expect(cohort).toBeDefined();
    expect(cohort.earlyPromisingBlocked).toBe(true);
    // Must NOT appear in topPromisingCohorts
    expect(report.topPromisingCohorts.some((c) => c.symbol === "RAWUSDT")).toBe(false);
  });

  it("ISSUE 1c: genuinely credible cohort (no blocker) CAN appear in topPromisingCohorts", () => {
    // 8 records, unique time+price buckets, no RAW_EDGE_NOT_VALIDATED
    const BASE_MS = new Date("2024-06-01T10:00:00.000Z").getTime();
    const records = Array.from({ length: 8 }, (_, i) =>
      makeRecord({
        symbol: "BTCUSDT",
        direction: "LONG",
        entry: "vwap_retest_entry",
        exit: "tp1_full_exit",
        netR: 0.4,
      }),
    ).map((r, i) => ({
      ...r,
      context: {
        ...r.context,
        entryPrice: 45000 + i * 500,
        calibrationVerdict: null as null,
      },
      outcome: {
        ...r.outcome,
        openedAt: new Date(BASE_MS + i * 20 * 60_000).toISOString(),
      },
    }));
    const report = buildSymbolRouteSuitabilityReport(records as any);
    const cohort = report.candidateAssessments[0];
    expect(cohort).toBeDefined();
    expect(cohort.earlyPromisingBlocked).toBe(false);
    expect(report.topPromisingCohorts.some((c) => c.symbol === "BTCUSDT")).toBe(true);
  });

  it("ISSUE 1d: if no credible promising cohort exists, topPromisingCohorts is empty (honest fallback)", () => {
    // Only multiplicity-blocked cohort with positive netAvgR
    const records = Array.from({ length: 5 }, () =>
      makeRecord({
        symbol: "DOGEUSDT",
        direction: "LONG",
        entry: "fib_500_entry",
        exit: "tp1_full_exit",
        netR: 0.35,
      }),
    ).map((r) => ({
      ...r,
      context: { ...r.context, entryPrice: 0.1523 },
      outcome: { ...r.outcome, openedAt: "2024-01-01T10:05:00.000Z" },
    }));
    const report = buildSymbolRouteSuitabilityReport(records as any);
    expect(report.topPromisingCohorts).toHaveLength(0);
    // The blocked cohort is surfaced separately
    expect(report.highestRawReturnMultiplicityFlaggedCohort).not.toBeNull();
  });

  // ── ISSUE 2: pairs >=5/>=15/>=30 — effective-n counts ────────────────────────

  it("ISSUE 2: reports both raw and effective-n based pair counts", () => {
    // BIGPAIR: 35 raw, all unique → 35 effective
    // MIDPAIR: 16 raw, all unique → 16 effective
    // SMALL:   6 raw, all unique → 6 effective
    // TINY:    2 raw → 2 effective
    const records = [
      ...many(35, { symbol: "BIGPAIR2", direction: "LONG", entry: "e1", exit: "x1", netR: 0.2 }),
      ...many(16, { symbol: "MIDPAIR2", direction: "LONG", entry: "e1", exit: "x1", netR: 0.1 }),
      ...many(6, { symbol: "SMALL2", direction: "LONG", entry: "e1", exit: "x1", netR: 0.0 }),
      ...many(2, { symbol: "TINY2", direction: "LONG", entry: "e1", exit: "x1", netR: 0.0 }),
    ];
    const r = buildSymbolRouteSuitabilityReport(records);
    // Raw counts (unchanged)
    expect(r.metadata.pairsWithAtLeast5Closes).toBe(3);
    expect(r.metadata.pairsWithAtLeast15Closes).toBe(2);
    expect(r.metadata.pairsWithAtLeast30Closes).toBe(1);
    // Effective counts exist
    expect(typeof r.metadata.pairsWithAtLeast5ClosesEffective).toBe("number");
    expect(typeof r.metadata.pairsWithAtLeast15ClosesEffective).toBe("number");
    expect(typeof r.metadata.pairsWithAtLeast30ClosesEffective).toBe("number");
  });

  it("ISSUE 2: effective-n counts are <= raw counts when duplicates inflate raw", () => {
    // A cohort where all records share the same time+price bucket (nEffective=1 even though nRaw=5)
    const records = Array.from({ length: 5 }, () =>
      makeRecord({ symbol: "INFLATUSDT", direction: "LONG", entry: "e1", exit: "x1", netR: 0.3 }),
    ).map((r) => ({
      ...r,
      context: { ...r.context, entryPrice: 0.1523 },
      outcome: { ...r.outcome, openedAt: "2024-01-01T10:05:00.000Z" },
    }));
    const r = buildSymbolRouteSuitabilityReport(records as any);
    // raw count = 5 → raw >=5 = 1 pair
    expect(r.metadata.pairsWithAtLeast5Closes).toBe(1);
    // nEffective = 1 → effective >=5 = 0 pairs
    expect(r.metadata.pairsWithAtLeast5ClosesEffective).toBe(0);
    expect(r.metadata.pairsWithAtLeast15ClosesEffective).toBe(0);
    expect(r.metadata.pairsWithAtLeast30ClosesEffective).toBe(0);
  });

  // ── ISSUE 3: highestRawReturnMultiplicityFlaggedCohort ────────────────────────

  it("ISSUE 3: highestRawReturnMultiplicityFlaggedCohort is null when no blocked cohort has positive netAvgR", () => {
    // Only non-blocked cohorts
    const records = many(8, { symbol: "CLEANUSDT", direction: "LONG", netR: 0.3 });
    const r = buildSymbolRouteSuitabilityReport(records);
    expect(r.highestRawReturnMultiplicityFlaggedCohort).toBeNull();
  });

  it("ISSUE 3: highestRawReturnMultiplicityFlaggedCohort is set when a blocked cohort has the highest raw netAvgR", () => {
    // One credible cohort with netAvgR=0.2 (should be topPromising)
    // One multiplicity-flagged cohort with netAvgR=0.4 (should be highestRawReturn only)
    const BASE_MS = new Date("2024-06-01T10:00:00.000Z").getTime();
    const credibleRecords = Array.from({ length: 6 }, (_, i) =>
      makeRecord({ symbol: "ETHUSDT", direction: "LONG", entry: "e1", exit: "x1", netR: 0.2 }),
    ).map((r, i) => ({
      ...r,
      context: { ...r.context, entryPrice: 3000 + i * 10 },
      outcome: { ...r.outcome, openedAt: new Date(BASE_MS + i * 20 * 60_000).toISOString() },
    }));
    const flaggedRecords = Array.from({ length: 5 }, () =>
      makeRecord({ symbol: "DOGEUSDT", direction: "LONG", entry: "e1", exit: "x1", netR: 0.4 }),
    ).map((r) => ({
      ...r,
      context: { ...r.context, entryPrice: 0.1523 },
      outcome: { ...r.outcome, openedAt: "2024-01-01T10:05:00.000Z" },
    }));
    const r = buildSymbolRouteSuitabilityReport([...credibleRecords, ...flaggedRecords] as any);
    // ETHUSDT appears in topPromisingCohorts
    expect(r.topPromisingCohorts.some((c) => c.symbol === "ETHUSDT")).toBe(true);
    // DOGEUSDT does NOT appear in topPromisingCohorts
    expect(r.topPromisingCohorts.some((c) => c.symbol === "DOGEUSDT")).toBe(false);
    // DOGEUSDT appears in highestRawReturnMultiplicityFlaggedCohort
    expect(r.highestRawReturnMultiplicityFlaggedCohort?.symbol).toBe("DOGEUSDT");
    expect(r.highestRawReturnMultiplicityFlaggedCohort?.earlyPromisingBlocked).toBe(true);
  });

  it("earlyPromisingBlocked field is present on all candidate assessments", () => {
    const records = many(6, { symbol: "BTCUSDT", direction: "LONG", netR: 0.3 });
    const r = buildSymbolRouteSuitabilityReport(records);
    for (const c of r.candidateAssessments) {
      expect(typeof c.earlyPromisingBlocked).toBe("boolean");
    }
  });
});

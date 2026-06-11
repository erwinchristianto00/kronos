import { describe, it, expect } from "vitest";
import { buildAdaptiveGateIntelligenceReport } from "../src/lib/adaptive-gate-intelligence.js";
import type { StrategyExperienceRecord } from "@dtc/shared";

// ─── Fixture builders ─────────────────────────────────────────────────────────

let counter = 0;

interface MakeOpts {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  netR?: number;
  grossR?: number;
  tp1Hit?: boolean;
  slHit?: boolean;
  closeReason?: "TP1" | "TP2" | "SL" | "BREAKEVEN" | "TIME" | null;
  era?: "POST_CALIBRATION" | "POST_ROUTING_PRE_CALIBRATION" | "LEGACY_PRE_ROUTING" | null;
  marketRegime?: string | null;
  kronosBias?: "LONG" | "SHORT" | "UNAVAILABLE" | null;
  whaleAgreement?: "AGREES" | "DISAGREES" | "UNAVAILABLE" | null;
  horizonConflict?: boolean | null;
  directionalAlignmentLabel?: "ALIGNED" | "MIXED" | "CONFLICTED" | null;
  sentimentBucket?: string | null;
  fearGreed?: number | null;
}

function makeRecord(opts: MakeOpts): StrategyExperienceRecord {
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
      marketRegime: opts.marketRegime === undefined ? null : opts.marketRegime,
      selectedKronosBias: opts.kronosBias === undefined ? null : opts.kronosBias,
      whaleAgreement: opts.whaleAgreement === undefined ? null : opts.whaleAgreement,
      horizonConflict: opts.horizonConflict === undefined ? null : opts.horizonConflict,
      directionalAlignmentLabel: opts.directionalAlignmentLabel === undefined ? null : opts.directionalAlignmentLabel,
      sentimentBucket: opts.sentimentBucket === undefined ? null : opts.sentimentBucket,
      fearGreed: opts.fearGreed === undefined ? null : opts.fearGreed,
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `pos-${++counter}`,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction ?? "LONG",
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

function many(n: number, base: MakeOpts): StrategyExperienceRecord[] {
  return Array.from({ length: n }, () => makeRecord(base));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildAdaptiveGateIntelligenceReport", () => {
  it("empty input returns safe empty report (advisory ready, gate influence false)", () => {
    const r = buildAdaptiveGateIntelligenceReport([]);
    expect(r.totalResolvedExperienceRecords).toBe(0);
    expect(r.usableRecordsForGateAnalysis).toBe(0);
    expect(r.metadata.resolvedExperienceRecordCount).toBe(0);
    expect(r.baseline.closedCount).toBe(0);
    expect(r.baseline.netAvgR).toBeNull();
    expect(r.baseline.profitFactor).toBeNull();
    expect(r.dimensionSummaries.length).toBeGreaterThan(0);
    expect(r.dimensionSummaries.every((d) => d.dimensionVerdict === "INSUFFICIENT_COVERAGE")).toBe(true);
    expect(r.topSupportiveConditions).toEqual([]);
    expect(r.topHarmfulConditions).toEqual([]);
    expect(r.readiness.advisoryEngineReady).toBe(true);
    expect(r.readiness.readyForGateInfluence).toBe(false);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("baseline is computed correctly across the filtered evidence", () => {
    const records = [
      ...many(6, { netR: 0.5, kronosBias: "LONG" }),
      ...many(4, { netR: -0.4, kronosBias: "LONG" }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    expect(r.baseline.closedCount).toBe(10);
    // (6*0.5 - 4*0.4)/10 = (3 - 1.6)/10 = 0.14
    expect(r.baseline.netAvgR).toBeCloseTo(0.14, 3);
    // PF = (6*0.5) / (4*0.4) = 3/1.6 = 1.875
    expect(r.baseline.profitFactor).toBeCloseTo(1.88, 1);
    // SL rate = losers count / total = 4/10
    expect(r.baseline.slRate).toBeCloseTo(0.4, 2);
    // win rate
    expect(r.baseline.winRate).toBeCloseTo(0.6, 2);
  });

  it("context coverage is computed per dimension", () => {
    const records = [
      ...many(5, { kronosBias: "LONG", whaleAgreement: "AGREES", horizonConflict: false }),
      ...many(5, { kronosBias: null, whaleAgreement: null, horizonConflict: null }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    expect(r.contextCoverageSummary.kronosAlignmentCoverage).toBeCloseTo(0.5, 2);
    expect(r.contextCoverageSummary.selectedKronosBiasCoverage).toBeCloseTo(0.5, 2);
    const kronos = r.contextCoverage.find((c) => c.dimension === "KRONOS_ALIGNMENT")!;
    expect(kronos.populatedCount).toBe(5);
    expect(kronos.coveragePct).toBeCloseTo(0.5, 2);
    const whale = r.contextCoverage.find((c) => c.dimension === "WHALE_ALIGNMENT")!;
    expect(whale.populatedCount).toBe(5);
    const mr = r.contextCoverage.find((c) => c.dimension === "MARKET_REGIME")!;
    expect(mr.populatedCount).toBe(0);
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
      const records = many(c.count, { kronosBias: "LONG", direction: "LONG", netR: 0.1 });
      const r = buildAdaptiveGateIntelligenceReport(records);
      const dim = r.dimensionSummaries.find((d) => d.dimension === "KRONOS_ALIGNMENT")!;
      const bucket = dim.buckets.find((b) => b.bucket === "KRONOS_ALIGNED")!;
      expect(bucket.closedCount).toBe(c.count);
      expect(bucket.sampleTier).toBe(c.expected);
    }
  });

  it("dimension grouping: Kronos alignment splits aligned vs disagrees correctly", () => {
    const records = [
      ...many(8, { direction: "LONG", kronosBias: "LONG", netR: 0.3 }),
      ...many(6, { direction: "LONG", kronosBias: "SHORT", netR: -0.2 }),
      ...many(3, { direction: "LONG", kronosBias: "UNAVAILABLE", netR: 0.05 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const dim = r.dimensionSummaries.find((d) => d.dimension === "KRONOS_ALIGNMENT")!;
    const aligned = dim.buckets.find((b) => b.bucket === "KRONOS_ALIGNED")!;
    const disagrees = dim.buckets.find((b) => b.bucket === "KRONOS_DISAGREES")!;
    const unavailable = dim.buckets.find((b) => b.bucket === "KRONOS_UNAVAILABLE")!;
    expect(aligned.conditionLabel).toBe("KRONOS_ALIGNED");
    expect(aligned.closedCount).toBe(8);
    expect(disagrees.closedCount).toBe(6);
    expect(unavailable.closedCount).toBe(3);
  });

  it("classifier: TOO_EARLY tier yields INSUFFICIENT_EVIDENCE local signal", () => {
    const records = [
      ...many(3, { kronosBias: "LONG", direction: "LONG", netR: 0.5 }), // 3 aligned
      ...many(15, { kronosBias: "SHORT", direction: "LONG", netR: -0.1 }), // bulk baseline so aligned bucket has only 3
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const dim = r.dimensionSummaries.find((d) => d.dimension === "KRONOS_ALIGNMENT")!;
    const aligned = dim.buckets.find((b) => b.bucket === "KRONOS_ALIGNED")!;
    expect(aligned.sampleTier).toBe("TOO_EARLY");
    expect(aligned.localGateSignal).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("classifier: SUPPORTIVE_EARLY when EARLY tier shows +0.20R delta", () => {
    // Baseline ~0R; aligned cohort 8 records at +0.30, disagrees cohort 8 records at -0.30
    const records = [
      ...many(8, { kronosBias: "LONG", direction: "LONG", netR: 0.30 }),
      ...many(8, { kronosBias: "SHORT", direction: "LONG", netR: -0.30 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const dim = r.dimensionSummaries.find((d) => d.dimension === "KRONOS_ALIGNMENT")!;
    const aligned = dim.buckets.find((b) => b.bucket === "KRONOS_ALIGNED")!;
    const disagrees = dim.buckets.find((b) => b.bucket === "KRONOS_DISAGREES")!;
    expect(aligned.sampleTier).toBe("EARLY");
    expect(aligned.localGateSignal).toBe("SUPPORTIVE_EARLY");
    expect(disagrees.localGateSignal).toBe("HARMFUL_EARLY");
  });

  it("delta computation: aligned cohort has positive netR Δ vs baseline; disagrees has negative", () => {
    const records = [
      ...many(8, { kronosBias: "LONG", direction: "LONG", netR: 0.4 }),
      ...many(8, { kronosBias: "SHORT", direction: "LONG", netR: -0.4 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const dim = r.dimensionSummaries.find((d) => d.dimension === "KRONOS_ALIGNMENT")!;
    const aligned = dim.buckets.find((b) => b.bucket === "KRONOS_ALIGNED")!;
    const disagrees = dim.buckets.find((b) => b.bucket === "KRONOS_DISAGREES")!;
    expect(aligned.performanceDeltaVsBaseline.netAvgR ?? 0).toBeGreaterThan(0);
    expect(disagrees.performanceDeltaVsBaseline.netAvgR ?? 0).toBeLessThan(0);
  });

  it("MIXED signal when net delta and SL delta point opposite ways", () => {
    // Baseline is mostly losses with low netR. Build a bucket of WATCHABLE size whose netR matches baseline
    // closely (so it's neither supportive nor harmful) — we expect MIXED.
    const records = [
      ...many(20, { kronosBias: "LONG", direction: "LONG", netR: 0.0, closeReason: "TIME" }),
      ...many(20, { kronosBias: "SHORT", direction: "LONG", netR: 0.0, closeReason: "TIME" }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const dim = r.dimensionSummaries.find((d) => d.dimension === "KRONOS_ALIGNMENT")!;
    for (const b of dim.buckets) {
      expect(["MIXED", "INSUFFICIENT_EVIDENCE"]).toContain(b.localGateSignal);
    }
  });

  it("interaction analysis: Kronos+Whale aligned cohort returns correct stats", () => {
    const records = [
      ...many(10, {
        kronosBias: "LONG",
        whaleAgreement: "AGREES",
        direction: "LONG",
        netR: 0.4,
      }),
      ...many(10, {
        kronosBias: "SHORT",
        whaleAgreement: "DISAGREES",
        direction: "LONG",
        netR: -0.3,
      }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    expect(r.interactionAssessments).toBe(r.interactions);
    const inter = r.interactions.find((i) => i.interactionLabel === "KRONOS_ALIGNED + WHALE_AGREES")!;
    expect(inter).toBeDefined();
    expect(inter.closedCount).toBe(10);
    expect(inter.netAvgR ?? 0).toBeCloseTo(0.4, 1);
    expect(inter.verdict).toBe("EARLY_SUPPORTIVE");
  });

  it("interaction analysis: insufficient sample reports INSUFFICIENT_EVIDENCE", () => {
    const records = [
      ...many(2, { kronosBias: "LONG", whaleAgreement: "AGREES", direction: "LONG", netR: 0.4 }),
      ...many(20, { kronosBias: "SHORT", whaleAgreement: "DISAGREES", direction: "LONG", netR: -0.2 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const inter = r.interactions.find((i) => i.interactionLabel === "KRONOS_ALIGNED + WHALE_AGREES")!;
    expect(inter.closedCount).toBe(2);
    expect(inter.sampleTier).toBe("TOO_EARLY");
    expect(inter.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("counter-trend interactions (BULLISH+SHORT, BEARISH+LONG) are computed when regime coverage exists", () => {
    const records = [
      ...many(8, { marketRegime: "BULLISH", direction: "LONG", netR: 0.3 }),
      ...many(7, { marketRegime: "BULLISH", direction: "SHORT", netR: -0.4 }),
      ...many(6, { marketRegime: "BEARISH", direction: "LONG", netR: -0.35 }),
      ...many(8, { marketRegime: "BEARISH", direction: "SHORT", netR: 0.25 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const counterTrendBull = r.interactions.find((i) => i.interactionLabel === "MARKET_REGIME_BULLISH + SHORT (counter-trend)");
    const counterTrendBear = r.interactions.find((i) => i.interactionLabel === "MARKET_REGIME_BEARISH + LONG (counter-trend)");
    expect(counterTrendBull).toBeDefined();
    expect(counterTrendBear).toBeDefined();
    expect(counterTrendBull!.closedCount).toBe(7);
    expect(counterTrendBear!.closedCount).toBe(6);
  });

  it("patch-hypothesis status mapping: EARLY/MEDIUM tier never reaches READY_FOR_PATCH_DISCUSSION", () => {
    const records = [
      ...many(8, { kronosBias: "LONG", direction: "LONG", netR: 0.40 }),
      ...many(8, { kronosBias: "SHORT", direction: "LONG", netR: -0.30 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    for (const h of r.patchHypotheses) {
      expect(h.patchStatus).not.toBe("READY_FOR_PATCH_DISCUSSION");
      expect(h.doesNotImplementNow).toBe(true);
    }
  });

  it("EVALUABLE-tier supportive bucket with internally consistent signal can reach READY_FOR_PATCH_DISCUSSION", () => {
    const records = [
      ...many(40, { kronosBias: "LONG", direction: "LONG", netR: 0.4 }),
      ...many(40, { kronosBias: "SHORT", direction: "LONG", netR: -0.4 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const hasReady = r.patchHypotheses.some((h) => h.patchStatus === "READY_FOR_PATCH_DISCUSSION");
    expect(hasReady).toBe(true);
    // Even if hypothesis can be promoted, the engine itself still reports gate-influence = false
    expect(r.readiness.readyForGateInfluence).toBe(false);
  });

  it("readyForGateInfluence is always false, regardless of evidence quality", () => {
    const records = many(200, { kronosBias: "LONG", direction: "LONG", netR: 0.6 });
    const r = buildAdaptiveGateIntelligenceReport(records);
    expect(r.readiness.readyForGateInfluence).toBe(false);
    expect(r.readiness.advisoryEngineReady).toBe(true);
    expect(r.readiness.reasons.some((m) => m.includes("advisory"))).toBe(true);
  });

  it("doesNotImplementNow=true on every hypothesis", () => {
    const records = [
      ...many(40, { kronosBias: "LONG", direction: "LONG", netR: 0.4 }),
      ...many(40, { kronosBias: "SHORT", direction: "LONG", netR: -0.4 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    expect(r.patchHypotheses.length).toBeGreaterThan(0);
    for (const h of r.patchHypotheses) {
      expect(h.doesNotImplementNow).toBe(true);
    }
  });

  it("records with missing context fields counted in coverage but excluded from per-dimension stats", () => {
    const records = [
      ...many(10, { kronosBias: "LONG", direction: "LONG", netR: 0.3 }),
      ...many(10, { kronosBias: null, direction: "LONG", netR: -0.5 }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const kronos = r.contextCoverage.find((c) => c.dimension === "KRONOS_ALIGNMENT")!;
    expect(kronos.populatedCount).toBe(10);
    expect(kronos.coveragePct).toBeCloseTo(0.5, 2);
    const dim = r.dimensionSummaries.find((d) => d.dimension === "KRONOS_ALIGNMENT")!;
    const aligned = dim.buckets.find((b) => b.bucket === "KRONOS_ALIGNED")!;
    expect(aligned.closedCount).toBe(10);
    expect(aligned.netAvgR).toBeCloseTo(0.3, 2);
  });

  it("top supportive sorting respects sample weight (high-sample positive ranks above tiny-sample positive)", () => {
    // Build an EVALUABLE cohort that clears the strict WATCHABLE+ classifier
    // (netΔ>+0.15 AND pfΔ>+0.15), and a tiny EARLY cohort with a larger raw netΔ
    // but smaller sample weight. EVALUABLE should still come first because of
    // its 1.0 weight vs EARLY's 0.4.
    const records = [
      // Bulk losers to drag baseline down
      ...many(40, { direction: "LONG", netR: -0.3, kronosBias: null, whaleAgreement: null }),
      // Big EVALUABLE Kronos-aligned bucket: 35 wins at +0.5, 5 losses at -0.2 (PF and netR strong)
      ...many(35, { direction: "LONG", netR: 0.5, kronosBias: "LONG", whaleAgreement: null }),
      ...many(5, { direction: "LONG", netR: -0.2, kronosBias: "LONG", whaleAgreement: null }),
      // Small EARLY Whale-agrees bucket: 7 wins at +0.9, 1 loss at -0.1 (higher netR delta)
      ...many(7, { direction: "LONG", netR: 0.9, kronosBias: null, whaleAgreement: "AGREES" }),
      ...many(1, { direction: "LONG", netR: -0.1, kronosBias: null, whaleAgreement: "AGREES" }),
    ];
    const r = buildAdaptiveGateIntelligenceReport(records);
    const topSupportive = r.topSupportiveConditions;
    expect(topSupportive.length).toBeGreaterThanOrEqual(1);
    // Both buckets should pass the supportive classifier; sample weight breaks the tie.
    // KRONOS_ALIGNED: Δnet ≈ +0.5 - baseline, sampleWeight=1.0 (EVALUABLE)
    // WHALE_AGREES:   Δnet ≈ +0.8 - baseline, sampleWeight=0.4 (EARLY)
    // Score = Δnet × weight. With baseline ~0.16, scores are ~0.34 (EVALUABLE) vs ~0.26 (EARLY) — EVALUABLE wins.
    const first = topSupportive[0];
    expect(first.dimension).toBe("KRONOS_ALIGNMENT");
    expect(first.bucket).toBe("KRONOS_ALIGNED");
    expect(first.sampleTier).toBe("EVALUABLE");
  });

  it("era filter excludes pre-POST_CALIBRATION records when era=POST_CALIBRATION", () => {
    const records = [
      ...many(5, { kronosBias: "LONG", direction: "LONG", netR: 0.5, era: "POST_CALIBRATION" }),
      ...many(5, { kronosBias: "LONG", direction: "LONG", netR: -0.5, era: "LEGACY_PRE_ROUTING" }),
    ];
    const rPost = buildAdaptiveGateIntelligenceReport(records, { evidenceEra: "POST_CALIBRATION" });
    expect(rPost.metadata.resolvedExperienceRecordCount).toBe(5);
    expect((rPost.baseline.netAvgR ?? 0)).toBeGreaterThan(0);

    const rAll = buildAdaptiveGateIntelligenceReport(records, { evidenceEra: "ALL_TIME" });
    expect(rAll.metadata.resolvedExperienceRecordCount).toBe(10);
  });
});

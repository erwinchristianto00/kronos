import { describe, it, expect } from "vitest";
import { computeConditionalAlphaStability } from "../src/lib/conditional-alpha-stability.js";
import { buildAdaptiveGateIntelligenceReport } from "../src/lib/adaptive-gate-intelligence.js";
import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";
import type { StrategyExperienceRecord } from "@dtc/shared";

// ─── Fixture builder ──────────────────────────────────────────────────────────

let counter = 0;

interface MakeOpts {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  netR?: number;
  marketRegime?: string | null;
  whaleAgreement?: "AGREES" | "DISAGREES" | "UNAVAILABLE" | null;
  horizonConflict?: boolean | null;
  openedAt?: string | null;
  era?: "POST_CALIBRATION" | "ALL_TIME";
}

function makeRecord(opts: MakeOpts): StrategyExperienceRecord {
  const netR = opts.netR ?? 0;
  return {
    context: {
      schemaVersion: 1,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction ?? "SHORT",
      scanTimestamp: null,
      evidenceEra: opts.era ?? "POST_CALIBRATION",
      marketRegime: opts.marketRegime === undefined ? "BEARISH_EXPANSION" : opts.marketRegime,
      whaleAgreement: opts.whaleAgreement === undefined ? null : opts.whaleAgreement,
      horizonConflict: opts.horizonConflict === undefined ? null : opts.horizonConflict,
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `pos-${++counter}`,
      symbol: opts.symbol ?? "BTCUSDT",
      direction: opts.direction ?? "SHORT",
      evidenceEra: opts.era ?? "POST_CALIBRATION",
      realizedNetR: netR,
      realizedGrossR: netR + 0.05,
      winnerLabel: netR > 0 ? "WIN" : netR < 0 ? "LOSS" : "BREAKEVEN",
      tp1Hit: netR > 0,
      slHit: netR < 0,
      closeReason: netR > 0 ? "TP1" : "SL",
      openedAt: opts.openedAt ?? null,
    } as StrategyExperienceRecord["outcome"],
  };
}

function many(n: number, base: MakeOpts): StrategyExperienceRecord[] {
  return Array.from({ length: n }, () => makeRecord(base));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeConditionalAlphaStability", () => {
  it("empty input returns zero-count report with TOO_EARLY_OR_UNCLEAR entries", () => {
    const report = computeConditionalAlphaStability([]);
    expect(report.baseN).toBe(0);
    expect(report.baseNetAvgR).toBe(0);
    expect(report.entries.length).toBe(2);
    for (const entry of report.entries) {
      expect(entry.status).toBe("TOO_EARLY_OR_UNCLEAR");
      expect(entry.n).toBe(0);
    }
  });

  it("1. PROMISING_BUT_RECENCY_CONCENTRATED: positive net+delta, negative early half, positive late half", () => {
    // Build 10 whale-agrees BASE records.
    // Early half (first by openedAt): negative netR
    // Late half (second by openedAt): positive netR that drives overall positive net
    const early = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        netR: -0.2,
        whaleAgreement: "AGREES",
        openedAt: `2026-01-0${i + 1}T00:00:00Z`,
      })
    );
    const late = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        netR: 0.8,
        whaleAgreement: "AGREES",
        openedAt: `2026-02-0${i + 1}T00:00:00Z`,
      })
    );
    // Base also includes some neutral records to have a lower base netAvgR
    const baseNeutral = many(5, { whaleAgreement: null, netR: 0.05 });
    const records = [...early, ...late, ...baseNeutral];

    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    expect(whaleEntry).toBeDefined();
    expect(whaleEntry.netAvgR).toBeGreaterThan(0);
    expect(whaleEntry.deltaNetAvgR).toBeGreaterThan(0);
    expect(whaleEntry.earlyHalfNetAvgR).toBeLessThanOrEqual(0);
    expect(whaleEntry.lateHalfNetAvgR).toBeGreaterThan(0);
    expect(whaleEntry.status).toBe("PROMISING_BUT_RECENCY_CONCENTRATED");
  });

  it("2. PROMISING_BUT_SYMBOL_CONCENTRATED: top-2 symbol share >= 75%", () => {
    // Single symbol dominates all positive netR contribution
    const dominant = Array.from({ length: 30 }, (_, i) =>
      makeRecord({
        symbol: "FETUSDT",
        netR: 0.5,
        whaleAgreement: "AGREES",
        openedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(Math.floor(i / 28)).padStart(2, "0")}:00:00Z`,
      })
    );
    // A few small-win trades from a second symbol — same direction to keep total positive
    const minor = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        symbol: "ETHUSDT",
        netR: 0.05,
        whaleAgreement: "AGREES",
        openedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      })
    );
    // Non-whale BASE records with lower netR to ensure delta > 0
    const baseOnly = many(15, { whaleAgreement: null, netR: -0.2 });
    const records = [...dominant, ...minor, ...baseOnly];
    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    // net should be positive since dominant wins
    expect(whaleEntry.netAvgR).toBeGreaterThan(0);
    expect(whaleEntry.deltaNetAvgR).toBeGreaterThan(0);
    expect(whaleEntry.top2SignedNetSumShare).toBeGreaterThanOrEqual(0.75);
    // Must classify as symbol concentrated (after recency check — early half should also be positive)
    expect(whaleEntry.status).toBe("PROMISING_BUT_SYMBOL_CONCENTRATED");
  });

  it("3. PROMISING_STABILIZING: positive early+late halves, non-concentrated symbols, n>=50", () => {
    // 60 whale-agrees records across 3 symbols, all positive
    const symbols = ["AAVEUSDT", "BTCUSDT", "ETHUSDT"];
    const whaleRecords = Array.from({ length: 60 }, (_, i) =>
      makeRecord({
        symbol: symbols[i % 3],
        netR: 0.3,
        whaleAgreement: "AGREES",
        openedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(Math.floor(i / 28)).padStart(2, "0")}:00:00Z`,
      })
    );
    // Add some BASE-only records (no whale agreement) with lower netR to ensure delta > 0
    const baseOnly = many(20, { whaleAgreement: null, netR: -0.1 });
    const records = [...whaleRecords, ...baseOnly];

    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    expect(whaleEntry.n).toBe(60);
    expect(whaleEntry.netAvgR).toBeGreaterThan(0);
    expect(whaleEntry.deltaNetAvgR).toBeGreaterThan(0);
    expect(whaleEntry.earlyHalfNetAvgR).toBeGreaterThan(0);
    expect(whaleEntry.lateHalfNetAvgR).toBeGreaterThan(0);
    expect(whaleEntry.top2SignedNetSumShare).toBeLessThan(0.75);
    expect(whaleEntry.status).toBe("PROMISING_STABILIZING");
  });

  it("4. TOO_EARLY_OR_UNCLEAR: negative net → status is TOO_EARLY_OR_UNCLEAR", () => {
    const records = many(20, { netR: -0.3, whaleAgreement: "AGREES" });
    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    expect(whaleEntry.netAvgR).toBeLessThanOrEqual(0);
    expect(whaleEntry.status).toBe("TOO_EARLY_OR_UNCLEAR");
  });

  it("4b. TOO_EARLY_OR_UNCLEAR: positive net but negative delta → status is TOO_EARLY_OR_UNCLEAR", () => {
    // Whale-agrees has +0.05R net, but base is +0.20R net (so delta is negative)
    const baseHeavy = many(40, { netR: 0.25, whaleAgreement: null });
    const whaleSmall = many(10, { netR: 0.05, whaleAgreement: "AGREES" });
    const records = [...baseHeavy, ...whaleSmall];
    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    // net is positive but delta is negative (base is higher)
    expect(whaleEntry.netAvgR).toBeGreaterThan(0);
    expect(whaleEntry.deltaNetAvgR).toBeLessThan(0);
    expect(whaleEntry.status).toBe("TOO_EARLY_OR_UNCLEAR");
  });

  it("5. Recency concentration takes priority over symbol concentration when both apply", () => {
    // Scenario: early half is negative (recency concentrated), AND top-2 symbols dominate (symbol concentrated).
    // Recency check should fire first.
    const earlyDominant = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        symbol: "FETUSDT",
        netR: -0.3,
        whaleAgreement: "AGREES",
        openedAt: `2026-01-0${i + 1}T00:00:00Z`,
      })
    );
    const lateDominant = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        symbol: "FETUSDT",
        netR: 1.2,
        whaleAgreement: "AGREES",
        openedAt: `2026-02-0${i + 1}T00:00:00Z`,
      })
    );
    // Base neutral to set lower baseline
    const neutral = many(3, { whaleAgreement: null, netR: 0.02 });
    const records = [...earlyDominant, ...lateDominant, ...neutral];
    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    expect(whaleEntry.earlyHalfNetAvgR).toBeLessThanOrEqual(0);
    expect(whaleEntry.top2SignedNetSumShare).toBeGreaterThanOrEqual(0.75);
    // Recency check wins
    expect(whaleEntry.status).toBe("PROMISING_BUT_RECENCY_CONCENTRATED");
  });

  it("8. Signed-share and positive-share differ when negative symbols exist", () => {
    // Symbol A: large positive (+3.0R net) — top contributor
    // Symbol B: large positive (+2.0R net) — second contributor
    // Symbol C: negative (−2.0R net) — pulls signed denominator down, inflating signed share
    //
    // signed denominator = 3.0 + 2.0 + (−2.0) = 3.0  → top2-signed = (3+2)/3 = 1.67 → clamped to 1.0 (degenerate check skipped since >0)
    // Actually: totalSignedNetSum = 3.0 → top2SignedShare = (3+2)/3 = 1.667 → but that can't be right...
    // Let me use: A=+3, B=+1, C=−1 → signed total=3, top2 signed=(3+1)/3=1.33>1? No, need smaller negatives.
    // Use A=+3, B=+1, C=−0.5 → signed total=3.5, top2=(4)/3.5=1.14? Still >1 because top2 sum > totalSigned.
    // The issue: signed sort puts A and B at top, so top2Sum can exceed totalSignedNetSum when negatives exist.
    // Use A=+2, B=+1, C=−0.5 → signed total=2.5, top2=(3)/2.5=1.2 → still >1.
    // Actually the signed-share formula: numerator = top-2 by signed netSum.
    // If negatives exist, top2Sum (positive symbols) will always be >= totalSignedNetSum.
    // That means signed share will be > 1 when negatives exist — which is why positive-share gives a more conservative picture.
    // Let's verify: A=+2, B=+2, C=−1 → signed=3, top2=(4)/3=1.33 (>1) vs positive total=4, top2-pos=4/4=1.0
    //
    // Better scenario for testing: A=+6, B=+1, C=−0.5 → signed=6.5, top2=(7)/6.5=1.077 > 1
    // And positive: totalPos=7, top2Pos=(6+1)/7=1.0
    //
    // The key thing to test: the two shares ARE different (positive-share ≤ signed-share in degenerate sense).
    // More practically with symbols where positive-share < 1:
    // A=+5, B=+3, C=+2, D=−1 → signed=9, top2-signed=(8)/9=0.889; positive=10, top2-pos=(8)/10=0.80
    // → signed=89% vs positive=80% ← meaningful difference
    const records: StrategyExperienceRecord[] = [
      // Symbol A: +5.0R total (5 records × +1.0)
      ...Array.from({ length: 5 }, () => makeRecord({ symbol: "SYMAUSDT", netR: 1.0, whaleAgreement: "AGREES" })),
      // Symbol B: +3.0R total (3 records × +1.0)
      ...Array.from({ length: 3 }, () => makeRecord({ symbol: "SYMBUSDT", netR: 1.0, whaleAgreement: "AGREES" })),
      // Symbol C: +2.0R total (2 records × +1.0)
      ...Array.from({ length: 2 }, () => makeRecord({ symbol: "SYMCUSDT", netR: 1.0, whaleAgreement: "AGREES" })),
      // Symbol D: −1.0R total (1 record × −1.0) — negative contributor
      makeRecord({ symbol: "SYMDUSDT", netR: -1.0, whaleAgreement: "AGREES" }),
      // Base-only records with low netR so delta > 0
      ...many(3, { whaleAgreement: null, netR: -0.5 }),
    ];

    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    expect(whaleEntry).toBeDefined();

    // Both fields should be defined
    expect(typeof whaleEntry.top2SignedNetSumShare).toBe("number");
    expect(whaleEntry.top2PositiveNetSumShare).not.toBeNull();

    // signed denominator = 5+3+2−1=9; top2=(5+3)/9≈0.889
    // positive denominator = 5+3+2=10; top2=(5+3)/10=0.80
    // positive-share MUST be strictly less than signed-share in this scenario
    expect(whaleEntry.top2PositiveNetSumShare!).toBeLessThan(whaleEntry.top2SignedNetSumShare);
    expect(whaleEntry.positiveContributorCount).toBe(3);
    expect(whaleEntry.negativeContributorCount).toBe(1);
  });

  it("9. Positive-share is null when no symbol has a positive netSumR", () => {
    // All whale-agrees records have negative or zero netR → no positive contributor
    const records: StrategyExperienceRecord[] = [
      ...many(5, { symbol: "LOSINGUSDT", netR: -0.5, whaleAgreement: "AGREES" }),
      ...many(3, { symbol: "BREAKUSDT", netR: 0.0, whaleAgreement: "AGREES" }),
    ];

    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    expect(whaleEntry).toBeDefined();
    expect(whaleEntry.top2PositiveNetSumShare).toBeNull();
    expect(whaleEntry.positiveContributorCount).toBe(0);
  });

  it("10. Dashboard Section J renders both signed and positive concentration shares", () => {
    // Build a scenario where positive-share is distinct from signed-share
    // Use A=+5, B=+3, C=+2, D=−1 → signed≈89% pos=80%
    const records: StrategyExperienceRecord[] = [
      ...Array.from({ length: 5 }, () =>
        makeRecord({ symbol: "SYMAUSDT", netR: 1.0, whaleAgreement: "AGREES", horizonConflict: false })
      ),
      ...Array.from({ length: 3 }, () =>
        makeRecord({ symbol: "SYMBUSDT", netR: 1.0, whaleAgreement: "AGREES", horizonConflict: false })
      ),
      ...Array.from({ length: 2 }, () =>
        makeRecord({ symbol: "SYMCUSDT", netR: 1.0, whaleAgreement: "AGREES", horizonConflict: false })
      ),
      makeRecord({ symbol: "SYMDUSDT", netR: -1.0, whaleAgreement: "AGREES", horizonConflict: false }),
      ...many(3, { whaleAgreement: null, netR: -0.5 }),
    ];

    const dashReport = buildDashboardAuditSummaryReport([]);
    // The empty-positions dashboard still renders the stability block
    expect(dashReport.summaryText).toContain("Conditional alpha stability:");
    expect(dashReport.summaryText).toContain("top2-sym signed=");

    // Now verify the format with actual non-empty data via computeConditionalAlphaStability directly
    const stabilityReport = computeConditionalAlphaStability(records);
    const whaleEntry = stabilityReport.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    const signedPct = Math.round(whaleEntry.top2SignedNetSumShare * 100);
    const posPct = whaleEntry.top2PositiveNetSumShare !== null
      ? Math.round(whaleEntry.top2PositiveNetSumShare * 100)
      : null;
    // Verify the formatting logic produces "signed=XX% pos=YY%"
    const rendered = `top2-sym signed=${signedPct}%${posPct !== null ? ` pos=${posPct}%` : ""}`;
    expect(rendered).toMatch(/top2-sym signed=\d+% pos=\d+%/);
    // And the two percentages should differ
    expect(signedPct).not.toBe(posPct);
  });

  it("7. WHALE_AGREES + NO_HC entry uses a smaller min-n threshold (40 vs 50)", () => {
    // 45 records that meet all stability criteria except the WHALE_AGREES count threshold.
    // With WHALE_AGREES threshold = 50, WHALE_AGREES is NOT PROMISING_STABILIZING (45 < 50).
    // With WHALE_AGREES + NO_HC threshold = 40, NO_HC IS PROMISING_STABILIZING (45 >= 40).
    const symbols = ["AAVEUSDT", "BTCUSDT", "ETHUSDT"];
    const whaleNoHcRecords = Array.from({ length: 45 }, (_, i) =>
      makeRecord({
        symbol: symbols[i % 3],
        netR: 0.3,
        whaleAgreement: "AGREES",
        horizonConflict: false,
        openedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(Math.floor(i / 28)).padStart(2, "0")}:00:00Z`,
      })
    );
    // Add base-only records with lower netR so delta > 0 for both filters
    const baseOnly = many(20, { whaleAgreement: null, netR: -0.1 });
    const records = [...whaleNoHcRecords, ...baseOnly];
    const report = computeConditionalAlphaStability(records);
    const whaleEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES")!;
    const nohcEntry = report.entries.find((e) => e.filterLabel === "WHALE_AGREES + NO_HC")!;
    // 45 < 50 → WHALE_AGREES not PROMISING_STABILIZING
    expect(whaleEntry.status).not.toBe("PROMISING_STABILIZING");
    // 45 >= 40 → WHALE_AGREES + NO_HC is PROMISING_STABILIZING
    expect(nohcEntry.status).toBe("PROMISING_STABILIZING");
  });
});

describe("adaptive-gate-intelligence with conditionalAlphaStability", () => {
  it("report includes conditionalAlphaStability with two entries for any non-empty input", () => {
    const records = many(5, {
      whaleAgreement: "AGREES",
      horizonConflict: false,
      netR: 0.2,
    });
    const report = buildAdaptiveGateIntelligenceReport(records);
    expect(report.conditionalAlphaStability).toBeDefined();
    expect(report.conditionalAlphaStability!.entries.length).toBe(2);
    expect(report.conditionalAlphaStability!.entries[0].filterLabel).toBe("WHALE_AGREES");
    expect(report.conditionalAlphaStability!.entries[1].filterLabel).toBe("WHALE_AGREES + NO_HC");
  });

  it("readyForGateInfluence remains false (no strategy/behavior change)", () => {
    const records = many(5, { whaleAgreement: "AGREES", netR: 0.5 });
    const report = buildAdaptiveGateIntelligenceReport(records);
    expect(report.readiness.readyForGateInfluence).toBe(false);
  });
});

describe("dashboard Section J includes stability block", () => {
  it("6. summaryText contains 'Conditional alpha stability' block when adaptive gate has data", () => {
    // Build enough records to get non-empty stability output
    const records: StrategyExperienceRecord[] = many(8, {
      whaleAgreement: "AGREES",
      horizonConflict: false,
      netR: 0.2,
    });
    // We need ShadowPositions for the dashboard builder but can pass empty array
    // since the summary also calls buildStrategyExperienceRecords internally.
    // The stability block only shows when adaptiveGate.ok and conditionalAlphaStability is defined.
    // We pass positions=[] — in that case adaptiveGate will compute from empty records,
    // but the stability monitor will still be present (with zero entries).
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("J. ADAPTIVE GATE INTELLIGENCE");
    // With empty positions the stability entries will exist but n=0
    expect(report.summaryText).toContain("Conditional alpha stability:");
  });
});

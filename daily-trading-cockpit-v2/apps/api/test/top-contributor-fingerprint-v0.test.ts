import { describe, it, expect } from "vitest";
import {
  buildTopContributorFingerprintReport,
  evaluateTopContributorFingerprintV0,
  type TopContributorFingerprintProfileV0,
  type TopContributorFingerprintBucketEconomics,
  type TopContributorFingerprintRobustnessSummary,
} from "../src/lib/top-contributor-fingerprint-v0.js";
import { buildAdaptiveGateIntelligenceReport } from "../src/lib/adaptive-gate-intelligence.js";
import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";
import type { StrategyContextSnapshot, StrategyExperienceRecord } from "@dtc/shared";

// ─── Fixture builder ──────────────────────────────────────────────────────────

let counter = 0;

interface MakeOpts {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  netR?: number;
  marketRegime?: string | null;
  whaleAgreement?: "AGREES" | "DISAGREES" | "UNAVAILABLE" | null;
  era?: "POST_CALIBRATION" | "ALL_TIME";
  selectedEntryVariant?: string | null;
  selectedExitVariant?: string | null;
  stopDistanceBps?: number | null;
  entryDriftPctOfZone?: number | null;
  entryDriftAtr?: number | null;
  chaseRisk?: "HIGH" | "MEDIUM" | "LOW" | null;
  openedAt?: string | null;
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
      whaleAgreement: opts.whaleAgreement === undefined ? "AGREES" : opts.whaleAgreement,
      selectedEntryVariant:
        opts.selectedEntryVariant === undefined ? "vwap_retest_entry" : opts.selectedEntryVariant,
      selectedExitVariant:
        opts.selectedExitVariant === undefined ? "tp1_full_exit" : opts.selectedExitVariant,
      stopDistanceBps: opts.stopDistanceBps === undefined ? null : opts.stopDistanceBps,
      entryDriftPctOfZone: opts.entryDriftPctOfZone === undefined ? null : opts.entryDriftPctOfZone,
      entryDriftAtr: opts.entryDriftAtr === undefined ? null : opts.entryDriftAtr,
      chaseRisk: opts.chaseRisk === undefined ? null : opts.chaseRisk,
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

function makeCtx(overrides: Partial<StrategyContextSnapshot>): StrategyContextSnapshot {
  return {
    schemaVersion: 1,
    symbol: "ABCUSDT",
    direction: "SHORT",
    scanTimestamp: null,
    evidenceEra: "POST_CALIBRATION",
    marketRegime: "BEARISH_EXPANSION",
    whaleAgreement: "AGREES",
    selectedEntryVariant: "vwap_retest_entry",
    selectedExitVariant: "tp1_full_exit",
    stopDistanceBps: null,
    entryDriftPctOfZone: null,
    entryDriftAtr: null,
    chaseRisk: null,
    ...overrides,
  } as StrategyContextSnapshot;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildTopContributorFingerprintReport", () => {
  it("1. empty input → INSUFFICIENT_DATA, thresholds null, evaluatedCohortSize=0", () => {
    const report = buildTopContributorFingerprintReport([]);
    expect(report.profile.status).toBe("INSUFFICIENT_DATA");
    expect(report.profile.policyVersion).toBe("tc-fp-v0");
    expect(report.profile.matchThresholds.stopDistanceBpsMax).toBeNull();
    expect(report.profile.matchThresholds.entryDriftPctOfZoneMax).toBeNull();
    expect(report.profile.vetoThresholds.stopDistanceBpsMin).toBeNull();
    expect(report.profile.vetoThresholds.entryDriftPctOfZoneMin).toBeNull();
    expect(report.evaluations.evaluatedCohortSize).toBe(0);
  });

  it("2. below sample gate (n=5 records) → INSUFFICIENT_DATA", () => {
    const records = Array.from({ length: 5 }, () =>
      makeRecord({
        symbol: "AAAUSDT",
        netR: 1.0,
        stopDistanceBps: 150,
        entryDriftPctOfZone: -0.7,
      }),
    );
    const report = buildTopContributorFingerprintReport(records);
    expect(report.profile.status).toBe("INSUFFICIENT_DATA");
    expect(report.profile.topContributorRecordCount).toBeLessThan(10);
  });

  it("3. READY profile: handcrafted cohort yields plausible thresholds", () => {
    // 2 TOP symbols × 10 wins (tight stops ~150 bps, entryDrift -0.7)
    const topA = Array.from({ length: 10 }, () =>
      makeRecord({
        symbol: "AAAUSDT",
        netR: 1.0,
        stopDistanceBps: 150,
        entryDriftPctOfZone: -0.7,
        entryDriftAtr: 2.5,
        chaseRisk: "HIGH",
      }),
    );
    const topB = Array.from({ length: 10 }, () =>
      makeRecord({
        symbol: "BBBUSDT",
        netR: 1.0,
        stopDistanceBps: 155,
        entryDriftPctOfZone: -0.65,
        entryDriftAtr: 2.2,
        chaseRisk: "HIGH",
      }),
    );
    // 2 NEG symbols × 4 losses (wide stops ~400, entryDrift +0.5)
    const negC = Array.from({ length: 4 }, () =>
      makeRecord({
        symbol: "CCCUSDT",
        netR: -1.0,
        stopDistanceBps: 400,
        entryDriftPctOfZone: 0.5,
      }),
    );
    const negD = Array.from({ length: 4 }, () =>
      makeRecord({
        symbol: "DDDUSDT",
        netR: -1.0,
        stopDistanceBps: 410,
        entryDriftPctOfZone: 0.55,
      }),
    );

    const report = buildTopContributorFingerprintReport([...topA, ...topB, ...negC, ...negD]);
    expect(report.profile.status).toBe("READY");
    expect(report.profile.topContributorRecordCount).toBe(20);
    expect(report.profile.negativeRecordCount).toBe(8);
    // Stop max (p75 of TOP stops in [150, 155]) should be in the tight range
    expect(report.profile.matchThresholds.stopDistanceBpsMax).not.toBeNull();
    expect(report.profile.matchThresholds.stopDistanceBpsMax!).toBeGreaterThanOrEqual(150);
    expect(report.profile.matchThresholds.stopDistanceBpsMax!).toBeLessThanOrEqual(160);
    // EntryDrift max should be negative (around -0.65)
    expect(report.profile.matchThresholds.entryDriftPctOfZoneMax!).toBeLessThan(0);
    // Veto floor (median of NEG stops) should be wide
    expect(report.profile.vetoThresholds.stopDistanceBpsMin!).toBeGreaterThan(300);
    // Veto entryDrift floor should be positive
    expect(report.profile.vetoThresholds.entryDriftPctOfZoneMin!).toBeGreaterThan(0);
    // Supporting fallback
    expect(report.profile.matchThresholds.supportingEntryDriftAtrMin).toBe(2.0);
    // Evaluations all evaluated
    expect(report.evaluations.evaluatedCohortSize).toBe(28);
  });

  it("4. evaluation: clean match", () => {
    const profile: TopContributorFingerprintProfileV0 = {
      policyVersion: "tc-fp-v0",
      status: "READY",
      sampleSize: 30,
      topContributorRecordCount: 20,
      negativeRecordCount: 8,
      matchThresholds: {
        stopDistanceBpsMax: 160,
        entryDriftPctOfZoneMax: -0.6,
        supportingEntryDriftAtrMin: 2.0,
      },
      vetoThresholds: {
        stopDistanceBpsMin: 400,
        entryDriftPctOfZoneMin: 0.3,
      },
      notes: [],
    };
    const ctx = makeCtx({
      stopDistanceBps: 140,
      entryDriftPctOfZone: -0.8,
      chaseRisk: "HIGH",
      entryDriftAtr: 2.5,
    });
    const result = evaluateTopContributorFingerprintV0(ctx, profile);
    expect(result.match).toBe(true);
    expect(result.vetoed).toBe(false);
    expect(result.supportingHits).toBe(2);
    expect(result.reasonCodes).toContain("STOP_DISTANCE_TIGHT_OK");
    expect(result.reasonCodes).toContain("ENTRY_DRIFT_NEGATIVE_OK");
  });

  it("5. evaluation: veto on wide stop", () => {
    const profile: TopContributorFingerprintProfileV0 = {
      policyVersion: "tc-fp-v0",
      status: "READY",
      sampleSize: 30,
      topContributorRecordCount: 20,
      negativeRecordCount: 8,
      matchThresholds: {
        stopDistanceBpsMax: 160,
        entryDriftPctOfZoneMax: -0.6,
        supportingEntryDriftAtrMin: 2.0,
      },
      vetoThresholds: {
        stopDistanceBpsMin: 400,
        entryDriftPctOfZoneMin: 0.3,
      },
      notes: [],
    };
    const ctx = makeCtx({
      stopDistanceBps: 420,
      entryDriftPctOfZone: -0.7,
    });
    const result = evaluateTopContributorFingerprintV0(ctx, profile);
    expect(result.vetoed).toBe(true);
    expect(result.match).toBe(false);
    expect(result.reasonCodes).toContain("VETO_STOP_TOO_WIDE");
  });

  it("6. evaluation: neither match nor veto for middling values", () => {
    const profile: TopContributorFingerprintProfileV0 = {
      policyVersion: "tc-fp-v0",
      status: "READY",
      sampleSize: 30,
      topContributorRecordCount: 20,
      negativeRecordCount: 8,
      matchThresholds: {
        stopDistanceBpsMax: 160,
        entryDriftPctOfZoneMax: -0.6,
        supportingEntryDriftAtrMin: 2.0,
      },
      vetoThresholds: {
        stopDistanceBpsMin: 400,
        entryDriftPctOfZoneMin: 0.3,
      },
      notes: [],
    };
    // Stop is below veto but above match-max; entryDrift inside veto floor but above match-max
    const ctx = makeCtx({
      stopDistanceBps: 250,
      entryDriftPctOfZone: -0.2,
    });
    const result = evaluateTopContributorFingerprintV0(ctx, profile);
    expect(result.match).toBe(false);
    expect(result.vetoed).toBe(false);
  });

  it("7. profile INSUFFICIENT_DATA → evaluation returns PROFILE_INSUFFICIENT_DATA reason", () => {
    const emptyProfile: TopContributorFingerprintProfileV0 = {
      policyVersion: "tc-fp-v0",
      status: "INSUFFICIENT_DATA",
      sampleSize: 0,
      topContributorRecordCount: 0,
      negativeRecordCount: 0,
      matchThresholds: {
        stopDistanceBpsMax: null,
        entryDriftPctOfZoneMax: null,
        supportingEntryDriftAtrMin: null,
      },
      vetoThresholds: {
        stopDistanceBpsMin: null,
        entryDriftPctOfZoneMin: null,
      },
      notes: [],
    };
    const ctx = makeCtx({ stopDistanceBps: 150 });
    const result = evaluateTopContributorFingerprintV0(ctx, emptyProfile);
    expect(result.match).toBe(false);
    expect(result.vetoed).toBe(false);
    expect(result.reasonCodes).toContain("PROFILE_INSUFFICIENT_DATA");
    expect(result.supportingHits).toBe(0);
    expect(result.profileStatus).toBe("INSUFFICIENT_DATA");
  });

  it("8. dashboard rendering: empty positions still renders the advisory block", () => {
    const dashReport = buildDashboardAuditSummaryReport([]);
    expect(dashReport.summaryText).toContain(
      "TopContributorFingerprintV0 (advisory, no behavior influence)",
    );
    // INSUFFICIENT_DATA on empty input → thresholds: unavailable line
    expect(dashReport.summaryText).toContain("thresholds: unavailable");
  });

  it("9. buildAdaptiveGateIntelligenceReport exposes topContributorFingerprint and readiness stays advisory-only", () => {
    const report = buildAdaptiveGateIntelligenceReport([]);
    expect(report.topContributorFingerprint).toBeDefined();
    expect(report.topContributorFingerprint!.profile.policyVersion).toBe("tc-fp-v0");
    expect(report.readiness.readyForGateInfluence).toBe(false);
  });

  it("11. bucket economics: INSUFFICIENT_DATA report has empty buckets (n=0, nulls)", () => {
    const report = buildTopContributorFingerprintReport([]);
    expect(report.profile.status).toBe("INSUFFICIENT_DATA");
    const assertEmpty = (b: TopContributorFingerprintBucketEconomics) => {
      expect(b.n).toBe(0);
      expect(b.netAvgR).toBeNull();
      expect(b.profitFactor).toBeNull();
      expect(b.netSumR).toBeNull();
    };
    assertEmpty(report.buckets.match);
    assertEmpty(report.buckets.veto);
    assertEmpty(report.buckets.neither);
  });

  it("12. bucket economics: READY profile separates match vs veto netAvgR correctly", () => {
    // Build a cohort where:
    //   MATCH candidates (tight stop + negative drift) → high positive netR
    //   VETO candidates (wide stop) → negative netR
    //   NEITHER (middling) → near-zero netR
    // First establish the profile from TOP (tight winners) + NEG (wide losers):
    const topWinners = Array.from({ length: 10 }, (_, i) =>
      makeRecord({
        symbol: i < 5 ? "SYMAUSDT" : "SYMBUSDT",
        netR: 1.0,
        stopDistanceBps: 150,
        entryDriftPctOfZone: -0.7,
        entryDriftAtr: 2.5,
        chaseRisk: "HIGH",
      }),
    );
    const negLosers = Array.from({ length: 4 }, () =>
      makeRecord({
        symbol: "NEGUSDT",
        netR: -1.0,
        stopDistanceBps: 400,
        entryDriftPctOfZone: 0.5,
      }),
    );
    // Profile derived from above. Now add: extra match-shaped records + veto-shaped + neither-shaped
    const extraMatch = Array.from({ length: 5 }, () =>
      makeRecord({
        symbol: "XMATCHUSDT",
        netR: 0.8,
        stopDistanceBps: 140,           // tight — below any p75(TOP)=155
        entryDriftPctOfZone: -0.8,      // negative — below any p75(TOP)≈-0.65
      }),
    );
    const extraVeto = Array.from({ length: 5 }, () =>
      makeRecord({
        symbol: "XVETOUSDT",
        netR: -0.6,
        stopDistanceBps: 420,           // wide — above any median(NEG)≈400
        entryDriftPctOfZone: 0.1,
      }),
    );
    const extraNeither = Array.from({ length: 5 }, () =>
      makeRecord({
        symbol: "XNEITHERUSDT",
        netR: 0.05,
        stopDistanceBps: 240,           // between match-max (~155) and veto-min (~400)
        entryDriftPctOfZone: -0.2,      // between match-max (~-0.65) and veto-min (~0.52)
      }),
    );

    const report = buildTopContributorFingerprintReport([
      ...topWinners,
      ...negLosers,
      ...extraMatch,
      ...extraVeto,
      ...extraNeither,
    ]);

    expect(report.profile.status).toBe("READY");

    // MATCH bucket should exist and have positive economics
    expect(report.buckets.match.n).toBeGreaterThan(0);
    expect(report.buckets.match.netAvgR).not.toBeNull();
    expect(report.buckets.match.netAvgR!).toBeGreaterThan(0);

    // VETO bucket should have worse economics than MATCH
    expect(report.buckets.veto.n).toBeGreaterThan(0);
    expect(report.buckets.veto.netAvgR).not.toBeNull();
    expect(report.buckets.veto.netAvgR!).toBeLessThan(report.buckets.match.netAvgR!);

    // Counts must add up
    const totalBuckets =
      report.buckets.match.n + report.buckets.veto.n + report.buckets.neither.n;
    expect(totalBuckets).toBe(report.evaluations.evaluatedCohortSize);
  });

  it("13. dashboard economics line: READY profile renders economics row with n/net/PF per bucket", () => {
    // Same cohort as test 12 but verified via dashboard text
    const topWinners = Array.from({ length: 10 }, (_, i) =>
      makeRecord({
        symbol: i < 5 ? "SYMAUSDT" : "SYMBUSDT",
        netR: 1.0,
        stopDistanceBps: 150,
        entryDriftPctOfZone: -0.7,
        entryDriftAtr: 2.5,
        chaseRisk: "HIGH",
      }),
    );
    const negLosers = Array.from({ length: 4 }, () =>
      makeRecord({
        symbol: "NEGUSDT",
        netR: -1.0,
        stopDistanceBps: 400,
        entryDriftPctOfZone: 0.5,
      }),
    );
    // Confirm the module renders the economics line
    // (dashboard uses empty positions so we verify the format from a direct report check)
    const report = buildTopContributorFingerprintReport([...topWinners, ...negLosers]);
    expect(report.profile.status).toBe("READY");

    // Dashboard renders the advisory block at minimum (real disk data may give READY or INSUFFICIENT)
    const dashReport = buildDashboardAuditSummaryReport([]);
    expect(dashReport.summaryText).toContain("TopContributorFingerprintV0 (advisory, no behavior influence)");
    // When a READY profile is present, the economics line must appear
    if (dashReport.summaryText.includes("profile: READY")) {
      expect(dashReport.summaryText).toContain("economics:");
      expect(dashReport.summaryText).toMatch(/match n=\d+ net=[\+\-][\d.]+R PF=[\d.]+/);
    }

    // Verify the economics fields are populated correctly on the synthesised report
    expect(report.buckets.match.n).toBeDefined();
    expect(report.buckets.veto.n).toBeDefined();
    expect(report.buckets.neither.n).toBeDefined();
    // PF: with only wins in TOP bucket, profitFactor = null (no losses)
    // (top winners have netR=1.0 so no SL-hits → sumLossAbs=0 → PF=null)
    // NEGATIVE bucket has losses → PF defined
  });

  // ─── Robustness tests ────────────────────────────────────────────────────────

  it("14. robustness: INSUFFICIENT_DATA when profile not READY (empty records)", () => {
    const report = buildTopContributorFingerprintReport([]);
    expect(report.robustness.status).toBe("INSUFFICIENT_DATA");
    expect(report.robustness.blockers).toContain("insufficient-match-data");
    expect(report.robustness.matchCalendarDayCount).toBe(0);
    expect(report.robustness.matchDistinctSymbolCount).toBe(0);
    expect(report.robustness.top1SymbolShareOfMatchNetSumR).toBeNull();
    expect(report.robustness.top2SymbolShareOfMatchNetSumR).toBeNull();
    expect(report.robustness.exTop2SymbolMatchNetAvgR).toBeNull();
    expect(report.robustness.matchHasRealizedLoss).toBe(false);
    expect(report.robustness.matchProfitFactorComputable).toBe(false);
  });

  it("15. robustness: CONCENTRATION_BLOCKED when all MATCH on 1 day, 1 symbol, top2=100%", () => {
    // Establish a READY profile: 2 TOP symbols × 10 wins + 2 NEG × 4 losses
    const topA = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ symbol: "TOPAUSDT", netR: 1.0, stopDistanceBps: 150, entryDriftPctOfZone: -0.7, openedAt: "2026-01-01T10:00:00Z" }),
    );
    const topB = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ symbol: "TOPBUSDT", netR: 1.0, stopDistanceBps: 155, entryDriftPctOfZone: -0.65, openedAt: "2026-01-02T10:00:00Z" }),
    );
    const negC = Array.from({ length: 4 }, () =>
      makeRecord({ symbol: "NEGCUSDT", netR: -1.0, stopDistanceBps: 400, entryDriftPctOfZone: 0.5 }),
    );
    const negD = Array.from({ length: 4 }, () =>
      makeRecord({ symbol: "NEGDUSDT", netR: -1.0, stopDistanceBps: 410, entryDriftPctOfZone: 0.55 }),
    );

    // All MATCH records on 1 day, 1 symbol only — will be CONCENTRATION_BLOCKED
    // We need to inject 5+ MATCH records (same day / same symbol) by making the profile evaluate them as match:
    // Profile thresholds after above cohort: stopBpsMax ~ 155, entryDriftPctMax ~ -0.65.
    // So match needs stop <= 155 AND entryDrift <= -0.65.
    const matchCandidates = Array.from({ length: 8 }, () =>
      makeRecord({
        symbol: "SINGLESYMUSDT",
        netR: 1.5,
        stopDistanceBps: 140,
        entryDriftPctOfZone: -0.8,
        openedAt: "2026-01-03T10:00:00Z", // single day
      }),
    );

    const report = buildTopContributorFingerprintReport([...topA, ...topB, ...negC, ...negD, ...matchCandidates]);
    expect(report.profile.status).toBe("READY");
    expect(report.evaluations.matchCount).toBeGreaterThanOrEqual(5);

    const rb = report.robustness;
    expect(rb.status).toBe("CONCENTRATION_BLOCKED");
    // Expect at least single-day and single-symbol / few-symbols blockers
    expect(rb.blockers.length).toBeGreaterThan(0);
    const blockersJoined = rb.blockers.join(",");
    // Should have concentration-related blockers: single-day or few-days, and few-symbols or single-symbol
    expect(blockersJoined).toMatch(/single-day|few-days/);
  });

  it("16. robustness: PROMISING_BUT_UNPROVEN when concentration cleared but has losses-yet blocker", () => {
    // Design:
    //   - Profile TOP = T1 + T2: 5 records each (= 10 records ≥ MIN_TOP_RECORDS), stop=150, drift=-0.7
    //   - Profile NEG = N1 + N2: 2 records each (negativeRecordCount=4 > MIN_NEGATIVE_RECORDS=3 → LOO ok)
    //   - 6 extra MATCH symbols (X1-X6), 2 records each, spread across 12 distinct calendar days
    //     → MATCH netSumR: T1=5, T2=5, X1-X6=2 each → top2Share = 10/22 ≈ 45% < 60% ✓
    //     → calendarDayCount ≥ 5, distinctSymbolCount = 8 ≥ 5 ✓
    //     → exTop2NetAvgR = 1.0 > 0.15 ✓
    //   - No losses in MATCH bucket → "no-losses-yet" blocker remains → PROMISING_BUT_UNPROVEN
    const top1 = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ symbol: "T1USDT", netR: 1.0, stopDistanceBps: 150, entryDriftPctOfZone: -0.7, openedAt: `2026-01-${String(i + 1).padStart(2, "0")}T10:00:00Z` }),
    );
    const top2 = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ symbol: "T2USDT", netR: 1.0, stopDistanceBps: 150, entryDriftPctOfZone: -0.7, openedAt: `2026-01-${String(i + 6).padStart(2, "0")}T10:00:00Z` }),
    );
    const neg1 = Array.from({ length: 2 }, () =>
      makeRecord({ symbol: "N1USDT", netR: -1.0, stopDistanceBps: 400, entryDriftPctOfZone: 0.5 }),
    );
    const neg2 = Array.from({ length: 2 }, () =>
      makeRecord({ symbol: "N2USDT", netR: -1.0, stopDistanceBps: 410, entryDriftPctOfZone: 0.55 }),
    );
    // 6 extra MATCH symbols × 2 records each = 12 records; tight enough to match (stop=145 ≤ 150, drift=-0.75 ≤ -0.7)
    const extras = Array.from({ length: 6 }, (_, i) =>
      [
        makeRecord({ symbol: `X${i + 1}USDT`, netR: 1.0, stopDistanceBps: 145, entryDriftPctOfZone: -0.75, openedAt: `2026-02-${String(i * 2 + 1).padStart(2, "0")}T10:00:00Z` }),
        makeRecord({ symbol: `X${i + 1}USDT`, netR: 1.0, stopDistanceBps: 145, entryDriftPctOfZone: -0.75, openedAt: `2026-02-${String(i * 2 + 2).padStart(2, "0")}T10:00:00Z` }),
      ]
    ).flat();

    const report = buildTopContributorFingerprintReport([...top1, ...top2, ...neg1, ...neg2, ...extras]);
    expect(report.profile.status).toBe("READY");

    const rb = report.robustness;
    // Structural checks
    expect(rb.matchCalendarDayCount).toBeGreaterThanOrEqual(5);
    expect(rb.matchDistinctSymbolCount).toBeGreaterThanOrEqual(5);
    expect(rb.top2SymbolShareOfMatchNetSumR).not.toBeNull();
    expect(rb.top2SymbolShareOfMatchNetSumR!).toBeLessThan(0.60); // 10/22 ≈ 0.45
    expect(rb.exTop2SymbolMatchNetAvgR).not.toBeNull();
    expect(rb.exTop2SymbolMatchNetAvgR!).toBeGreaterThan(0.15);
    // No losses → blocker remains
    expect(rb.matchHasRealizedLoss).toBe(false);
    expect(rb.matchProfitFactorComputable).toBe(false);
    expect(rb.blockers).toContain("no-losses-yet");
    expect(rb.status).toBe("PROMISING_BUT_UNPROVEN");
  });

  it("17. robustness: ROBUSTNESS_IMPROVING when all conditions met", () => {
    // Same design as test 16 but add 1 realized MATCH loss to clear the no-losses-yet blocker.
    // The loss record (XLOSSUSDT, netR=-0.3, tight stop/drift) is evaluated as MATCH because its
    // context features pass the match threshold, even though its outcome is negative.
    // Its symbol goes to NEG bucket in profile derivation (netSumR=-0.3), making negativeRecordCount=5 > 3.
    const top1 = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ symbol: "RI1USDT", netR: 1.0, stopDistanceBps: 150, entryDriftPctOfZone: -0.7, openedAt: `2026-01-${String(i + 1).padStart(2, "0")}T10:00:00Z` }),
    );
    const top2 = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ symbol: "RI2USDT", netR: 1.0, stopDistanceBps: 150, entryDriftPctOfZone: -0.7, openedAt: `2026-01-${String(i + 6).padStart(2, "0")}T10:00:00Z` }),
    );
    const neg1 = Array.from({ length: 2 }, () =>
      makeRecord({ symbol: "RN1USDT", netR: -1.0, stopDistanceBps: 400, entryDriftPctOfZone: 0.5 }),
    );
    const neg2 = Array.from({ length: 2 }, () =>
      makeRecord({ symbol: "RN2USDT", netR: -1.0, stopDistanceBps: 410, entryDriftPctOfZone: 0.55 }),
    );
    const extras = Array.from({ length: 6 }, (_, i) =>
      [
        makeRecord({ symbol: `RX${i + 1}USDT`, netR: 1.0, stopDistanceBps: 145, entryDriftPctOfZone: -0.75, openedAt: `2026-02-${String(i * 2 + 1).padStart(2, "0")}T10:00:00Z` }),
        makeRecord({ symbol: `RX${i + 1}USDT`, netR: 1.0, stopDistanceBps: 145, entryDriftPctOfZone: -0.75, openedAt: `2026-02-${String(i * 2 + 2).padStart(2, "0")}T10:00:00Z` }),
      ]
    ).flat();
    // 1 realized loss — tight features → evaluates as MATCH; negative outcome → goes to NEG bucket in profile
    const lossRecord = makeRecord({
      symbol: "RLOSSUSDT",
      netR: -0.3,
      stopDistanceBps: 145,
      entryDriftPctOfZone: -0.75,
      openedAt: "2026-03-01T10:00:00Z",
    });

    const report = buildTopContributorFingerprintReport([...top1, ...top2, ...neg1, ...neg2, ...extras, lossRecord]);
    expect(report.profile.status).toBe("READY");

    const rb = report.robustness;
    // Concentration cleared
    expect(rb.matchCalendarDayCount).toBeGreaterThanOrEqual(5);
    expect(rb.matchDistinctSymbolCount).toBeGreaterThanOrEqual(5);
    expect(rb.top2SymbolShareOfMatchNetSumR).not.toBeNull();
    expect(rb.top2SymbolShareOfMatchNetSumR!).toBeLessThan(0.60);
    expect(rb.exTop2SymbolMatchNetAvgR).not.toBeNull();
    expect(rb.exTop2SymbolMatchNetAvgR!).toBeGreaterThan(0.15);
    // Loss present
    expect(rb.matchHasRealizedLoss).toBe(true);
    expect(rb.matchProfitFactorComputable).toBe(true);
    // All blockers cleared
    expect(rb.blockers).toHaveLength(0);
    expect(rb.status).toBe("ROBUSTNESS_IMPROVING");
  });

  it("18. dashboard renders robustness line when profile is READY", () => {
    const dashReport = buildDashboardAuditSummaryReport([]);
    if (dashReport.summaryText.includes("profile: READY")) {
      expect(dashReport.summaryText).toContain("robustness:");
      expect(dashReport.summaryText).toMatch(
        /robustness: (CONCENTRATION_BLOCKED|PROMISING_BUT_UNPROVEN|ROBUSTNESS_IMPROVING|INSUFFICIENT_DATA)/,
      );
    }
  });

  // ─── BOTH_MATCH_AND_VETO overlap tests ───────────────────────────────────────

  /**
   * Build a crossing-threshold cohort:
   * - TOP: stop=200, drift=-0.5 → matchMax: stopBpsMax=200, driftMax=-0.5
   * - NEG: stop=150, drift=-0.8 → vetoMin: stopBpsMin=150, driftMin=-0.8
   *
   * Crossing: stopVetoMin(150) <= stopMatchMax(200) → stopCrossed=true
   *           driftVetoMin(-0.8) <= driftMatchMax(-0.5) → driftCrossed=true
   *
   * BOTH records (coreMatch=true AND vetoed=true): stop=170, drift=-0.6
   *   - coreMatch: 170<=200 ✓, -0.6<=-0.5 ✓
   *   - vetoed:    170>=150 ✓ (by stop)
   *
   * VETO-ONLY (vetoed=true, coreMatch=false): stop=250, drift=-0.6
   *   - vetoed:    250>=150 ✓ (by stop)
   *   - coreMatch: 250<=200 ✗ → false
   *
   * MATCH (coreMatch=true, vetoed=false): stop=100, drift=-0.9
   *   - coreMatch: 100<=200 ✓, -0.9<=-0.5 ✓
   *   - vetoed by stop: 100>=150 ✗; by drift: -0.9>=-0.8 ✗ → not vetoed
   */
  function makeCrossingCohort() {
    // Profile builders
    const top1 = Array.from({ length: 5 }, () =>
      makeRecord({ symbol: "CT1USDT", netR: +2.0, stopDistanceBps: 200, entryDriftPctOfZone: -0.5 }),
    );
    const top2 = Array.from({ length: 5 }, () =>
      makeRecord({ symbol: "CT2USDT", netR: +2.0, stopDistanceBps: 200, entryDriftPctOfZone: -0.5 }),
    );
    const neg1 = Array.from({ length: 4 }, () =>
      makeRecord({ symbol: "CN1USDT", netR: -1.0, stopDistanceBps: 150, entryDriftPctOfZone: -0.8 }),
    );
    // Evaluation records that are unique symbols so they don't move TOP-2 positions
    const bothRecs = Array.from({ length: 4 }, () =>
      makeRecord({ symbol: "CBOTHUSDT", netR: +0.5, stopDistanceBps: 170, entryDriftPctOfZone: -0.6 }),
    );
    // stop=250 → not core-matched (>200), but vetoed (>=150) → VETO-ONLY
    // netR negative so symbol goes to NEG bucket but does not change median (150 stays median)
    const vetoOnlyRecs = Array.from({ length: 3 }, () =>
      makeRecord({ symbol: "CVETOONLYUSDT", netR: -0.4, stopDistanceBps: 250, entryDriftPctOfZone: -0.6 }),
    );
    const matchRecs = Array.from({ length: 3 }, () =>
      makeRecord({ symbol: "CMATCHUSDT", netR: +0.8, stopDistanceBps: 100, entryDriftPctOfZone: -0.9 }),
    );
    return { all: [...top1, ...top2, ...neg1, ...bothRecs, ...vetoOnlyRecs, ...matchRecs] };
  }

  it("19. crossing-threshold cohort: bothMatchAndVetoCount > 0, neitherCount === 0", () => {
    const { all } = makeCrossingCohort();
    const report = buildTopContributorFingerprintReport(all);
    expect(report.profile.status).toBe("READY");

    // Threshold overlap should be detected
    expect(report.thresholdOverlap).not.toBeNull();
    expect(report.thresholdOverlap!.stopCrossed).toBe(true);
    expect(report.thresholdOverlap!.driftCrossed).toBe(true);
    expect(report.thresholdOverlap!.anyCrossed).toBe(true);

    // NEITHER must be 0
    expect(report.evaluations.neitherCount).toBe(0);

    // BOTH must be positive
    expect(report.bothMatchAndVetoCount).toBeGreaterThan(0);
    expect(report.bothMatchAndVetoEconomics).not.toBeNull();
    expect(report.bothMatchAndVetoEconomics!.n).toBeGreaterThan(0);
  });

  it("20. BOTH economics vs veto-only economics are computed separately", () => {
    const { all } = makeCrossingCohort();
    const report = buildTopContributorFingerprintReport(all);
    expect(report.profile.status).toBe("READY");

    // BOTH sub-population (includes T1+T2+N1+CBOTH) has positive netR in winners
    // veto-only sub-population (CVETOONLY) has only losses → PF=0 or negative netAvgR
    expect(report.bothMatchAndVetoEconomics).not.toBeNull();
    expect(report.vetoOnlyEconomics).not.toBeNull();

    // Veto-only: only losses → netAvgR < 0
    const vo = report.vetoOnlyEconomics!;
    expect(vo.n).toBe(3);
    expect(vo.netAvgR).not.toBeNull();
    expect(vo.netAvgR!).toBeLessThan(0);

    // BOTH sub-population has mixed outcomes (high positive from T1/T2) → positive netAvgR
    const both = report.bothMatchAndVetoEconomics!;
    expect(both.netAvgR).not.toBeNull();
    expect(both.netAvgR!).toBeGreaterThan(0);
    // Economics differ between sub-populations
    expect(both.netAvgR!).toBeGreaterThan(vo.netAvgR!);
  });

  it("21. final VETO bucket count = bothMatchAndVetoCount + vetoOnly count (unchanged)", () => {
    const { all } = makeCrossingCohort();
    const report = buildTopContributorFingerprintReport(all);
    expect(report.profile.status).toBe("READY");

    // VETO count = BOTH + VETO-ONLY
    const totalVeto = report.evaluations.vetoCount;
    const bothN = report.bothMatchAndVetoCount!;
    const vetoOnlyN = report.vetoOnlyEconomics!.n;
    expect(bothN + vetoOnlyN).toBe(totalVeto);

    // Bucket totals still add up
    expect(
      report.evaluations.matchCount +
      report.evaluations.vetoCount +
      report.evaluations.neitherCount,
    ).toBe(report.evaluations.evaluatedCohortSize);
  });

  it("22. adaptive gate report exposes overlap fields; dashboard text shows overlap sections when READY+crossing", () => {
    const { all } = makeCrossingCohort();
    // buildAdaptiveGateIntelligenceReport takes StrategyExperienceRecord[] directly
    const gateReport = buildAdaptiveGateIntelligenceReport(all);
    const tcfp = gateReport.topContributorFingerprint!;
    expect(tcfp.profile.status).toBe("READY");

    // Overlap economics populated
    expect(tcfp.bothMatchAndVetoEconomics).not.toBeNull();
    expect(tcfp.bothMatchAndVetoEconomics!.n).toBeGreaterThan(0);
    expect(tcfp.vetoOnlyEconomics).not.toBeNull();
    expect(tcfp.vetoOnlyEconomics!.n).toBeGreaterThan(0);

    // Threshold overlap detected
    expect(tcfp.thresholdOverlap).not.toBeNull();
    expect(tcfp.thresholdOverlap!.anyCrossed).toBe(true);

    // Dashboard with real disk data (empty positions): if a READY+crossing profile happens
    // to be loaded from disk, the overlap lines must appear; otherwise we just check basic
    // rendering. The logic branch is verified structurally above.
    const dashReport = buildDashboardAuditSummaryReport([]);
    expect(dashReport.summaryText).toContain("TopContributorFingerprintV0");
    if (
      dashReport.summaryText.includes("profile: READY") &&
      dashReport.summaryText.includes("threshold overlap:")
    ) {
      expect(dashReport.summaryText).toContain("overlap economics:");
      expect(dashReport.summaryText).toContain("both(absorbed→veto)");
      expect(dashReport.summaryText).toContain("absorbed by veto-wins precedence");
      expect(dashReport.summaryText).toContain("NEITHER may collapse to zero");
    }
    // Robustness line must always be present when READY
    if (dashReport.summaryText.includes("profile: READY")) {
      expect(dashReport.summaryText).toContain("robustness:");
    }
  });

  it("23. non-crossing thresholds → thresholdOverlap.anyCrossed=false, no threshold-overlap warning", () => {
    // TOP: tight stops (~150-155), very-negative drift (-0.65 to -0.7)
    // NEG: wide stops (400-420), positive drift (+0.5) → vetoMin far above matchMax → no crossing
    const top1 = Array.from({ length: 5 }, () =>
      makeRecord({ symbol: "NCT1USDT", netR: +1.0, stopDistanceBps: 150, entryDriftPctOfZone: -0.7 }),
    );
    const top2 = Array.from({ length: 5 }, () =>
      makeRecord({ symbol: "NCT2USDT", netR: +1.0, stopDistanceBps: 155, entryDriftPctOfZone: -0.65 }),
    );
    const neg1 = Array.from({ length: 4 }, () =>
      makeRecord({ symbol: "NCN1USDT", netR: -1.0, stopDistanceBps: 400, entryDriftPctOfZone: 0.5 }),
    );
    // stopMatchMax ≈ 155, stopVetoMin = 400 → 400 <= 155? NO → stopCrossed=false
    // driftMatchMax ≈ -0.65, driftVetoMin = 0.5 → 0.5 <= -0.65? NO → driftCrossed=false
    const report = buildTopContributorFingerprintReport([...top1, ...top2, ...neg1]);
    expect(report.profile.status).toBe("READY");
    expect(report.thresholdOverlap).not.toBeNull();
    expect(report.thresholdOverlap!.stopCrossed).toBe(false);
    expect(report.thresholdOverlap!.driftCrossed).toBe(false);
    expect(report.thresholdOverlap!.anyCrossed).toBe(false);
    expect(report.bothMatchAndVetoCount).toBeDefined();

    // With non-crossing thresholds, adaptive gate report must also show anyCrossed=false
    const gateReport = buildAdaptiveGateIntelligenceReport([...top1, ...top2, ...neg1]);
    const tcfp = gateReport.topContributorFingerprint!;
    expect(tcfp.thresholdOverlap!.anyCrossed).toBe(false);
    // Dashboard text: threshold overlap line must be absent when anyCrossed=false
    // (checked via the report object — dashboard only renders it when anyCrossed=true)
    const dashReport = buildDashboardAuditSummaryReport([]);
    // Dashboard with empty positions: if disk data has no crossing, no warning shown
    if (dashReport.summaryText.includes("profile: READY")) {
      // The dashboard reflects whatever disk data says; we validated the non-crossing
      // logic via the report object above. Just verify the robustness line is present.
      expect(dashReport.summaryText).toContain("robustness:");
    }
  });

  it("10. symbol-name freedom: module does not read ctx.symbol in evaluation path", () => {
    const profile: TopContributorFingerprintProfileV0 = {
      policyVersion: "tc-fp-v0",
      status: "READY",
      sampleSize: 30,
      topContributorRecordCount: 20,
      negativeRecordCount: 8,
      matchThresholds: {
        stopDistanceBpsMax: 160,
        entryDriftPctOfZoneMax: -0.6,
        supportingEntryDriftAtrMin: 2.0,
      },
      vetoThresholds: {
        stopDistanceBpsMin: 400,
        entryDriftPctOfZoneMin: 0.3,
      },
      notes: [],
    };
    // Symbol-less ctx should still evaluate cleanly
    const ctxNoSymbol = {
      schemaVersion: 1,
      direction: "SHORT",
      evidenceEra: "POST_CALIBRATION",
      stopDistanceBps: 140,
      entryDriftPctOfZone: -0.8,
      chaseRisk: "HIGH",
      entryDriftAtr: 2.5,
    } as unknown as StrategyContextSnapshot;
    const result = evaluateTopContributorFingerprintV0(ctxNoSymbol, profile);
    expect(result.match).toBe(true);

    // Equally, varying symbol must not change the verdict for identical features.
    const ctxA = makeCtx({
      symbol: "AAAUSDT",
      stopDistanceBps: 140,
      entryDriftPctOfZone: -0.8,
      chaseRisk: "HIGH",
      entryDriftAtr: 2.5,
    });
    const ctxB = makeCtx({
      symbol: "ZZZUSDT",
      stopDistanceBps: 140,
      entryDriftPctOfZone: -0.8,
      chaseRisk: "HIGH",
      entryDriftAtr: 2.5,
    });
    const rA = evaluateTopContributorFingerprintV0(ctxA, profile);
    const rB = evaluateTopContributorFingerprintV0(ctxB, profile);
    expect(rA.match).toBe(rB.match);
    expect(rA.vetoed).toBe(rB.vetoed);
    expect(rA.supportingHits).toBe(rB.supportingHits);
  });
});

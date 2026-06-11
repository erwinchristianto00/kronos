import { describe, it, expect, beforeEach } from "vitest";
import {
  computeSignalMultiplicity,
  bucketOpenedAt,
  bucketEntryPrice,
  formatMultiplicitySummary,
  isEarlyPromisingBlocked,
  _resetNullPriceCounter,
} from "../src/lib/signal-multiplicity-guardrail.js";
import { buildSymbolRouteSuitabilityReport } from "../src/lib/symbol-route-suitability.js";
import type { StrategyExperienceRecord } from "@dtc/shared";

// ─── Fixture builder ──────────────────────────────────────────────────────────

let _counter = 0;

/**
 * Creates a minimal StrategyExperienceRecord for testing signal multiplicity.
 * openedAt goes into outcome.openedAt; entryPrice into context.entryPrice.
 */
function makeRec(opts: {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  entry?: string;
  exit?: string;
  openedAt?: string | null;
  entryPrice?: number | null;
  netR?: number;
  calibrationVerdict?: "RAW_EDGE_NOT_VALIDATED" | "CALIBRATED_POSITIVE" | "CALIBRATED_NEGATIVE" | "INSUFFICIENT_SAMPLE" | null;
}): StrategyExperienceRecord {
  const netR = opts.netR ?? 0.3;
  return {
    context: {
      schemaVersion: 1,
      symbol: opts.symbol ?? "DOGEUSDT",
      direction: opts.direction ?? "LONG",
      scanTimestamp: null,
      evidenceEra: "POST_CALIBRATION",
      selectedEntryVariant: opts.entry ?? "fib_500_entry",
      selectedExitVariant: opts.exit ?? "tp1_full_exit",
      entryPrice: opts.entryPrice ?? 0.1,
      calibrationVerdict: opts.calibrationVerdict ?? null,
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `pos-${++_counter}`,
      symbol: opts.symbol ?? "DOGEUSDT",
      direction: opts.direction ?? "LONG",
      selectedEntryVariant: opts.entry ?? "fib_500_entry",
      selectedExitVariant: opts.exit ?? "tp1_full_exit",
      evidenceEra: "POST_CALIBRATION",
      openedAt: opts.openedAt ?? "2024-01-01T10:00:00.000Z",
      realizedNetR: netR,
      realizedGrossR: netR + 0.05,
      winnerLabel: netR > 0 ? "WIN" : netR < 0 ? "LOSS" : "BREAKEVEN",
      tp1Hit: netR > 0,
      slHit: netR < 0,
      closeReason: netR > 0 ? "TP1" : "SL",
    } as StrategyExperienceRecord["outcome"],
  };
}

function many(n: number, opts: Parameters<typeof makeRec>[0]): StrategyExperienceRecord[] {
  return Array.from({ length: n }, () => makeRec(opts));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("signal-multiplicity-guardrail", () => {
  beforeEach(() => {
    _resetNullPriceCounter();
  });

  // ── Test 1: All records unique → nEffective = nRaw, no warning ───────────

  it("1. all records unique → nEffective = nRaw, no warning", () => {
    const BASE_MS = new Date("2024-01-01T10:00:00.000Z").getTime();
    // Spread across 5 different 15-min buckets
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRec({
        openedAt: new Date(BASE_MS + i * 20 * 60_000).toISOString(), // 20-min gaps
        entryPrice: 0.1 * (1 + i * 0.01),
      }),
    );
    const result = computeSignalMultiplicity(records);
    expect(result.nRaw).toBe(5);
    expect(result.nEffective).toBe(5);
    expect(result.multiplicityRatio).toBeCloseTo(1.0);
    expect(result.signalMultiplicityWarning).toBe(false);
  });

  // ── Test 2: DOGE regression — 5 records same 15-min bucket, same price ───

  it("2. DOGE regression: 5 records with same time bucket and price bucket → nEffective=1, warning fires", () => {
    // All share the exact same openedAt and price
    const records = many(5, {
      symbol: "DOGEUSDT",
      direction: "LONG",
      entry: "fib_500_entry",
      exit: "tp1_full_exit",
      openedAt: "2024-01-01T10:05:00.000Z",
      entryPrice: 0.1523,
    });
    const result = computeSignalMultiplicity(records);
    expect(result.nRaw).toBe(5);
    expect(result.nEffective).toBe(1);
    expect(result.multiplicityRatio).toBeCloseTo(0.2);
    expect(result.signalMultiplicityWarning).toBe(true);
  });

  // ── Test 3: Mixed — 2 duplicates + 3 unique ───────────────────────────────

  it("3. mixed: 2 in same bucket + 3 unique → nEffective=4, correct ratio", () => {
    const BASE_MS = new Date("2024-01-01T10:00:00.000Z").getTime();
    // 2 records share bucket at T=0
    const dupes = many(2, { openedAt: "2024-01-01T10:05:00.000Z", entryPrice: 0.1523 });
    // 3 records in different 15-min buckets
    const uniques = [
      makeRec({ openedAt: new Date(BASE_MS + 20 * 60_000).toISOString(), entryPrice: 0.152 }),
      makeRec({ openedAt: new Date(BASE_MS + 40 * 60_000).toISOString(), entryPrice: 0.153 }),
      makeRec({ openedAt: new Date(BASE_MS + 60 * 60_000).toISOString(), entryPrice: 0.154 }),
    ];
    const result = computeSignalMultiplicity([...dupes, ...uniques]);
    expect(result.nRaw).toBe(5);
    expect(result.nEffective).toBe(4);
    expect(result.multiplicityRatio).toBeCloseTo(4 / 5);
    // ratio = 0.8 — above 0.5 threshold → no warning
    expect(result.signalMultiplicityWarning).toBe(false);
  });

  // ── Test 4: nRaw=2 both in same bucket → nEffective=1 but no warning ─────

  it("4. nRaw=2 with both in same bucket → nEffective=1 but no warning (nRaw < 3)", () => {
    const records = many(2, {
      openedAt: "2024-01-01T10:05:00.000Z",
      entryPrice: 0.1523,
    });
    const result = computeSignalMultiplicity(records);
    expect(result.nRaw).toBe(2);
    expect(result.nEffective).toBe(1);
    expect(result.multiplicityRatio).toBeCloseTo(0.5);
    // nRaw < 3 so no warning even though ratio = 0.5
    expect(result.signalMultiplicityWarning).toBe(false);
  });

  // ── Test 5: Exactly nRaw=3 with nEffective=1 → warning fires ─────────────

  it("5. nRaw=3 all in same bucket → ratio=0.333, warning fires", () => {
    const records = many(3, {
      openedAt: "2024-01-01T10:05:00.000Z",
      entryPrice: 0.1523,
    });
    const result = computeSignalMultiplicity(records);
    expect(result.nRaw).toBe(3);
    expect(result.nEffective).toBe(1);
    expect(result.multiplicityRatio).toBeCloseTo(1 / 3);
    expect(result.signalMultiplicityWarning).toBe(true);
  });

  // ── Test 6: Price buckets — verify 5bps boundary ─────────────────────────

  it("6. price buckets: same price → same bucket; prices separated by >5bps → different buckets", () => {
    // Two prices in the same 5bps bucket
    const p1 = 0.15230;
    // price2 must be in the exact same log-price bucket
    const sameBucketIndex = Math.floor(Math.log(p1) / 0.0005);
    // price in same bucket
    const p2 = Math.exp((sameBucketIndex + 0.4) * 0.0005); // 0.4 of the way into the bucket
    // price in next bucket (clearly beyond ~5bps)
    const p3 = Math.exp((sameBucketIndex + 1.5) * 0.0005);

    expect(bucketEntryPrice(p1)).toBe(sameBucketIndex);
    expect(bucketEntryPrice(p2)).toBe(sameBucketIndex); // same bucket
    expect(bucketEntryPrice(p3)).not.toBe(sameBucketIndex); // different bucket

    // Two records same price bucket, same time bucket → 1 effective
    const r1 = many(2, {
      openedAt: "2024-01-01T10:05:00.000Z",
      entryPrice: p1,
    });
    const res1 = computeSignalMultiplicity(r1);
    expect(res1.nEffective).toBe(1);

    // A record with p3 (different price bucket) should add another unique key
    const r2 = [
      makeRec({ openedAt: "2024-01-01T10:05:00.000Z", entryPrice: p1 }),
      makeRec({ openedAt: "2024-01-01T10:05:00.000Z", entryPrice: p3 }),
    ];
    const res2 = computeSignalMultiplicity(r2);
    expect(res2.nEffective).toBe(2);
  });

  // ── Test 7: 15-min time buckets ───────────────────────────────────────────

  it("7. 15-min time buckets: T and T+14min in same bucket; T and T+16min in different buckets", () => {
    const T = new Date("2024-01-01T10:00:00.000Z").getTime();
    const T_14 = new Date(T + 14 * 60_000).toISOString();
    const T_16 = new Date(T + 16 * 60_000).toISOString();
    const T_str = new Date(T).toISOString();

    // T and T+14 should be in the same 15-min bucket
    expect(bucketOpenedAt(T)).toBe(bucketOpenedAt(T + 14 * 60_000));
    // T and T+16 should be in different 15-min buckets (crosses the 15-min boundary)
    expect(bucketOpenedAt(T)).not.toBe(bucketOpenedAt(T + 16 * 60_000));

    // Records at T and T+14 (same bucket) → nEffective=1
    const sameBucket = [
      makeRec({ openedAt: T_str, entryPrice: 0.1523 }),
      makeRec({ openedAt: T_14, entryPrice: 0.1523 }),
    ];
    const res1 = computeSignalMultiplicity(sameBucket);
    expect(res1.nEffective).toBe(1);

    // Records at T and T+16 (different buckets) → nEffective=2
    const diffBucket = [
      makeRec({ openedAt: T_str, entryPrice: 0.1523 }),
      makeRec({ openedAt: T_16, entryPrice: 0.1523 }),
    ];
    const res2 = computeSignalMultiplicity(diffBucket);
    expect(res2.nEffective).toBe(2);
  });

  // ── Test 8: RAW_EDGE_NOT_VALIDATED prevents EARLY_PROMISING ──────────────

  it("8. RAW_EDGE_NOT_VALIDATED on all records prevents EARLY_PROMISING label", () => {
    // 8 records that would normally qualify as EARLY_PROMISING (nRaw>=5, netR>0.10, PF>1.0)
    // but all have calibrationVerdict=RAW_EDGE_NOT_VALIDATED
    const records = [
      ...many(6, {
        symbol: "BTCUSDT",
        direction: "LONG",
        entry: "fib_500_entry",
        exit: "tp1_full_exit",
        openedAt: "2024-01-01T10:05:00.000Z",
        entryPrice: 45000,
        netR: 0.5,
        calibrationVerdict: "RAW_EDGE_NOT_VALIDATED",
      }),
      ...many(2, {
        symbol: "BTCUSDT",
        direction: "LONG",
        entry: "fib_500_entry",
        exit: "tp1_full_exit",
        openedAt: "2024-01-01T10:25:00.000Z",
        entryPrice: 45010,
        netR: -0.1,
        calibrationVerdict: "RAW_EDGE_NOT_VALIDATED",
      }),
    ];
    const report = buildSymbolRouteSuitabilityReport(records);
    const cohort = report.candidateAssessments[0];
    expect(cohort).toBeDefined();
    expect(cohort.localVerdict).not.toBe("EARLY_PROMISING");
    // Should be MIXED (blocked from EARLY_PROMISING)
    expect(cohort.localVerdict).toBe("MIXED");
  });

  // ── Test 9: signalMultiplicityWarning prevents EARLY_PROMISING ───────────

  it("9. signalMultiplicityWarning prevents EARLY_PROMISING even if nRaw >= 5", () => {
    // 5 records that would be EARLY_PROMISING but all in same bucket
    // nEffective will be 1 (or very few), triggering the warning
    const records = many(5, {
      symbol: "DOGEUSDT",
      direction: "LONG",
      entry: "fib_500_entry",
      exit: "tp1_full_exit",
      openedAt: "2024-01-01T10:05:00.000Z",
      entryPrice: 0.1523,
      netR: 0.35,
    });

    // First verify the raw multiplicity
    const mult = computeSignalMultiplicity(records);
    expect(mult.signalMultiplicityWarning).toBe(true);

    // Then verify the verdict is not EARLY_PROMISING
    const report = buildSymbolRouteSuitabilityReport(records);
    const cohort = report.candidateAssessments[0];
    expect(cohort).toBeDefined();
    expect(cohort.signalMultiplicityWarning).toBe(true);
    expect(cohort.localVerdict).not.toBe("EARLY_PROMISING");
  });

  // ── Test 10: maturity check uses nEffective threshold ────────────────────

  it("10. maturity check uses nEffective threshold: nRaw=5 but nEffective=2 → not EARLY_PROMISING", () => {
    // 3 records in one bucket (dupes) + 2 in different buckets = nRaw=5, nEffective=3
    const T = new Date("2024-01-01T10:00:00.000Z").getTime();
    const records = [
      // 3 in same bucket: same time, same price
      makeRec({ openedAt: new Date(T).toISOString(), entryPrice: 0.1523, netR: 0.4 }),
      makeRec({ openedAt: new Date(T).toISOString(), entryPrice: 0.1523, netR: 0.4 }),
      makeRec({ openedAt: new Date(T).toISOString(), entryPrice: 0.1523, netR: 0.4 }),
      // 2 unique (different time buckets)
      makeRec({ openedAt: new Date(T + 20 * 60_000).toISOString(), entryPrice: 0.152, netR: 0.4 }),
      makeRec({ openedAt: new Date(T + 40 * 60_000).toISOString(), entryPrice: 0.154, netR: -0.1 }),
    ];

    const mult = computeSignalMultiplicity(records);
    // 3 dupes + 2 unique = 3 effective: (T,p1), (T+20,p2), (T+40,p3)
    expect(mult.nRaw).toBe(5);
    expect(mult.nEffective).toBe(3);
    // ratio = 3/5 = 0.6 → no warning (above 0.5)
    expect(mult.signalMultiplicityWarning).toBe(false);

    // Now with a ratio below 0.5 (3 in same bucket → nEffective=1 out of nRaw=3 → warning)
    const tightDupes = many(3, {
      openedAt: new Date(T).toISOString(),
      entryPrice: 0.1523,
      netR: 0.4,
    });
    const mult2 = computeSignalMultiplicity(tightDupes);
    expect(mult2.nRaw).toBe(3);
    expect(mult2.nEffective).toBe(1);
    expect(mult2.signalMultiplicityWarning).toBe(true);

    // Build suitability report with nRaw=5 but nEffective=1 (5 exact dupes)
    const allDupes = many(5, {
      symbol: "TESTUSDT",
      direction: "LONG",
      entry: "fib_500_entry",
      exit: "tp1_full_exit",
      openedAt: new Date(T).toISOString(),
      entryPrice: 0.1523,
      netR: 0.4,
    });
    const report = buildSymbolRouteSuitabilityReport(allDupes);
    const cohort = report.candidateAssessments[0];
    expect(cohort.nRaw).toBe(5);
    expect(cohort.nEffective).toBe(1);
    // nEffective (1) is below the threshold of 5 → EARLY_PROMISING is blocked
    expect(cohort.localVerdict).not.toBe("EARLY_PROMISING");
  });

  // ── Test 11: Dashboard Section I format strings ───────────────────────────

  it("11. formatMultiplicitySummary renders correct format strings", () => {
    // nRaw=5, nEff=1, warning → "n=5 (nEff=1, ⚠ MULTIPLICITY)"
    expect(formatMultiplicitySummary({ nRaw: 5, nEffective: 1, multiplicityRatio: 0.2, signalMultiplicityWarning: true }))
      .toBe("n=5 (nEff=1, ⚠ MULTIPLICITY)");

    // nRaw=5, nEff=4, no warning → "n=5 (nEff=4)"
    expect(formatMultiplicitySummary({ nRaw: 5, nEffective: 4, multiplicityRatio: 0.8, signalMultiplicityWarning: false }))
      .toBe("n=5 (nEff=4)");

    // nRaw=5, nEff=5, no warning → "n=5" (no parenthetical)
    expect(formatMultiplicitySummary({ nRaw: 5, nEffective: 5, multiplicityRatio: 1.0, signalMultiplicityWarning: false }))
      .toBe("n=5");

    // nRaw=0 → "n=0"
    expect(formatMultiplicitySummary({ nRaw: 0, nEffective: 0, multiplicityRatio: 1.0, signalMultiplicityWarning: false }))
      .toBe("n=0");

    // nRaw=3, nEff=1, warning fires → warning format
    expect(formatMultiplicitySummary({ nRaw: 3, nEffective: 1, multiplicityRatio: 1 / 3, signalMultiplicityWarning: true }))
      .toBe("n=3 (nEff=1, ⚠ MULTIPLICITY)");
  });

  // ── BOUNDARY FIX: nRaw=14, nEff=7, ratio=0.500 (FET-like) ───────────────

  it("BOUNDARY: nRaw=14, nEff=7, ratio=exactly 0.500 → signalMultiplicityWarning=true (FET-like false-positive guard)", () => {
    // Simulate FETUSDT SHORT audit: 14 raw records, 7 effective signals, ratio exactly 0.50
    // Prior to boundary fix this was < 0.50 only, so exactly 0.50 would NOT warn.
    // After fix (<=), warning MUST fire at exactly 0.50.
    const BASE_MS = new Date("2024-01-01T10:00:00.000Z").getTime();
    // 7 distinct time+price buckets, each with 2 duplicate records (7 * 2 = 14 raw, 7 effective)
    const records: StrategyExperienceRecord[] = [];
    for (let i = 0; i < 7; i++) {
      const openedAt = new Date(BASE_MS + i * 20 * 60_000).toISOString(); // different 15-min buckets
      const entryPrice = 0.1 + i * 0.01; // different price buckets
      records.push(makeRec({ symbol: "FETUSDT", direction: "SHORT", openedAt, entryPrice }));
      records.push(makeRec({ symbol: "FETUSDT", direction: "SHORT", openedAt, entryPrice })); // exact duplicate
    }
    const result = computeSignalMultiplicity(records);
    expect(result.nRaw).toBe(14);
    expect(result.nEffective).toBe(7);
    expect(result.multiplicityRatio).toBeCloseTo(0.5);
    // PATCH 1: boundary fix — <= 0.50 now triggers warning
    expect(result.signalMultiplicityWarning).toBe(true);
  });

  it("BOUNDARY: ratio strictly > 0.50 → signalMultiplicityWarning=false (e.g. nRaw=10, nEff=6, ratio=0.6)", () => {
    const BASE_MS = new Date("2024-01-01T10:00:00.000Z").getTime();
    // 6 distinct buckets with 1 duplicate in first bucket: 7 raw, 6 effective, ratio=6/7≈0.857
    // Or more precisely: 10 raw, 6 effective, ratio=0.6
    // Construct: 5 unique records + 5 more records where each shares a bucket with one of the first 5
    // = 5 effective only (one per pair), so ratio=5/10=0.5 → that would trigger. Need ratio > 0.5.
    // Let's do: 3 unique records + 7 in same bucket = 10 raw, 4 effective, ratio=0.4 triggers.
    // Instead: 6 unique + 4 sharing pairs with 2 of those 6 = 10 raw, 8 effective, ratio=0.8
    const records: StrategyExperienceRecord[] = [];
    for (let i = 0; i < 6; i++) {
      records.push(makeRec({
        openedAt: new Date(BASE_MS + i * 20 * 60_000).toISOString(),
        entryPrice: 0.1 + i * 0.01,
      }));
    }
    // Add 4 duplicates for slots 0 and 1 (2 dupes each): still 6 effective, 10 raw, ratio=6/10=0.6
    for (let i = 0; i < 2; i++) {
      records.push(makeRec({ openedAt: new Date(BASE_MS).toISOString(), entryPrice: 0.1 }));
      records.push(makeRec({ openedAt: new Date(BASE_MS + 20 * 60_000).toISOString(), entryPrice: 0.11 }));
    }
    const result = computeSignalMultiplicity(records);
    expect(result.nRaw).toBe(10);
    expect(result.nEffective).toBe(6);
    expect(result.multiplicityRatio).toBeCloseTo(0.6);
    expect(result.signalMultiplicityWarning).toBe(false);
  });

  it("BOUNDARY: ratio < 0.50 (pre-existing behavior) → signalMultiplicityWarning=true (e.g. nRaw=10, nEff=4)", () => {
    const BASE_MS = new Date("2024-01-01T10:00:00.000Z").getTime();
    // 4 unique records + 6 duplicates spread across those 4 buckets = 10 raw, 4 effective, ratio=0.4
    const records: StrategyExperienceRecord[] = [];
    for (let i = 0; i < 4; i++) {
      records.push(makeRec({
        openedAt: new Date(BASE_MS + i * 20 * 60_000).toISOString(),
        entryPrice: 0.1 + i * 0.01,
      }));
    }
    // 6 more duplicates across the same 4 buckets
    for (let i = 0; i < 6; i++) {
      const bucketIdx = i % 4;
      records.push(makeRec({
        openedAt: new Date(BASE_MS + bucketIdx * 20 * 60_000).toISOString(),
        entryPrice: 0.1 + bucketIdx * 0.01,
      }));
    }
    const result = computeSignalMultiplicity(records);
    expect(result.nRaw).toBe(10);
    expect(result.nEffective).toBe(4);
    expect(result.multiplicityRatio).toBeCloseTo(0.4);
    expect(result.signalMultiplicityWarning).toBe(true);
  });

  // ── Additional: isEarlyPromisingBlocked ───────────────────────────────────

  it("isEarlyPromisingBlocked: false when no warning and no RAW_EDGE_NOT_VALIDATED", () => {
    const BASE_MS = new Date("2024-01-01T10:00:00.000Z").getTime();
    // 5 records with unique timestamps (different 15-min buckets) and different prices
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRec({
        netR: 0.3,
        calibrationVerdict: "CALIBRATED_POSITIVE",
        openedAt: new Date(BASE_MS + i * 20 * 60_000).toISOString(),
        entryPrice: 0.1 + i * 0.01,
      }),
    );
    const mult = computeSignalMultiplicity(records);
    expect(mult.signalMultiplicityWarning).toBe(false);
    expect(isEarlyPromisingBlocked(records, mult)).toBe(false);
  });

  it("isEarlyPromisingBlocked: true when multiplicity warning fires", () => {
    const records = many(5, {
      openedAt: "2024-01-01T10:05:00.000Z",
      entryPrice: 0.1523,
    });
    const mult = computeSignalMultiplicity(records);
    expect(mult.signalMultiplicityWarning).toBe(true);
    expect(isEarlyPromisingBlocked(records, mult)).toBe(true);
  });

  it("isEarlyPromisingBlocked: true when all records are RAW_EDGE_NOT_VALIDATED", () => {
    const records = many(3, {
      calibrationVerdict: "RAW_EDGE_NOT_VALIDATED",
    });
    const mult = computeSignalMultiplicity(records);
    expect(isEarlyPromisingBlocked(records, mult)).toBe(true);
  });

  it("isEarlyPromisingBlocked: false when only some records are RAW_EDGE_NOT_VALIDATED", () => {
    const records = [
      makeRec({ calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }),
      makeRec({ calibrationVerdict: "CALIBRATED_POSITIVE" }),
    ];
    const mult = computeSignalMultiplicity(records);
    expect(isEarlyPromisingBlocked(records, mult)).toBe(false);
  });

  // ── Candidate assessment fields are present ───────────────────────────────

  it("candidateAssessment includes nRaw, nEffective, multiplicityRatio, signalMultiplicityWarning", () => {
    const BASE_MS = new Date("2024-01-01T10:00:00.000Z").getTime();
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRec({
        symbol: "BTCUSDT",
        direction: "LONG",
        openedAt: new Date(BASE_MS + i * 20 * 60_000).toISOString(),
        entryPrice: 45000 + i * 100,
        netR: 0.3,
      }),
    );
    const report = buildSymbolRouteSuitabilityReport(records);
    const cohort = report.candidateAssessments[0];
    expect(cohort).toBeDefined();
    expect(typeof cohort.nRaw).toBe("number");
    expect(typeof cohort.nEffective).toBe("number");
    expect(typeof cohort.multiplicityRatio).toBe("number");
    expect(typeof cohort.signalMultiplicityWarning).toBe("boolean");
    expect(cohort.nRaw).toBe(5);
    expect(cohort.nEffective).toBe(5);
    expect(cohort.signalMultiplicityWarning).toBe(false);
  });
});

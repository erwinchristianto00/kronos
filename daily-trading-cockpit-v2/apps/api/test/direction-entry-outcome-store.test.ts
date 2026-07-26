/**
 * DirectionEntryOutcomeStore + buildDirectionEntryOutcomeReport tests.
 *
 * Focus (per task spec): idempotent per-decisionId booking, the INSUFFICIENT_DATA floor (n < 20 —
 * CORTEX_ATTR_MIN_EXAMPLES_ACTIVE, reused verbatim), and the Tier 1 / Tier 2 Entry non-blending
 * guarantee (never merged into one field anywhere in the report).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DirectionEntryOutcomeStore,
  DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE,
  buildDirectionEntryOutcomeReport,
  type DirectionOutcomeRecord,
  type EntryOutcomeRecord,
} from "../src/lib/direction-entry-outcome-store.js";
import { CORTEX_ATTR_MIN_EXAMPLES_ACTIVE } from "../src/lib/cortex-attribution.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-direction-entry-outcome-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const HOUR_MS = 3_600_000;

function directionRecord(n: number, overrides: Partial<DirectionOutcomeRecord> = {}): DirectionOutcomeRecord {
  return {
    decisionId: `dir-${n}`,
    horizon: "SCALP",
    action: "LONG",
    asOfMs: n * HOUR_MS,
    status: "RESOLVED",
    chosenNetR: 0.1,
    win: 1,
    regretR: 0,
    calibrationGapR: 0.02,
    ...overrides,
  };
}

function entryRecord(n: number, overrides: Partial<EntryOutcomeRecord> = {}): EntryOutcomeRecord {
  return {
    decisionId: `entry-${n}`,
    tier: "TIER1_REALIZED",
    laneId: "CG_WIDE_FAST_LONG",
    symbolOrBasketId: "BTCUSDT",
    side: "LONG",
    action: "ENTER_NOW",
    confidence: "MEASURED",
    asOfMs: n * HOUR_MS,
    status: "RESOLVED",
    expectedNetR: 0.2,
    realizedNetR: 0.25,
    realizedRSource: "engine",
    horizonTruncated: null,
    matchedCloseKey: null,
    ...overrides,
  };
}

describe("DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE reuses CORTEX_ATTR_MIN_EXAMPLES_ACTIVE verbatim", () => {
  it("is exactly the same value (the small-n floor idiom), not re-derived", () => {
    expect(DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE).toBe(CORTEX_ATTR_MIN_EXAMPLES_ACTIVE);
    expect(DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE).toBe(20);
  });
});

describe("DirectionEntryOutcomeStore — idempotent per-decisionId booking", () => {
  it("recordDirectionOutcome is a no-op (returns false, no double count) on a decisionId already booked", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    const rec = directionRecord(1);
    expect(store.recordDirectionOutcome(rec, HOUR_MS)).toBe(true);
    expect(store.recordDirectionOutcome(rec, HOUR_MS)).toBe(false);
    // booked exactly once — the horizon aggregate's n must not double-count a re-offered decisionId
    expect(store.getState().direction.perHorizon.SCALP!.n).toBe(1);
    expect(store.getState().direction.evaluatedCount).toBe(1);
  });

  it("recordEntryOutcome is a no-op (returns false, no double count) on a decisionId already booked", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    const rec = entryRecord(1);
    expect(store.recordEntryOutcome(rec)).toBe(true);
    expect(store.recordEntryOutcome(rec)).toBe(false);
    expect(store.getState().entry.resolvedRealMatchCount).toBe(1);
  });

  it("survives a crash-and-restart mid-cycle: reloading from disk still refuses to double-book the same id", () => {
    const dir = tmp();
    const store = new DirectionEntryOutcomeStore(dir);
    store.recordDirectionOutcome(directionRecord(1), HOUR_MS);
    // reload — simulates a fresh process picking the persisted state back up
    const reloaded = new DirectionEntryOutcomeStore(dir);
    expect(reloaded.hasProcessedDirection("dir-1")).toBe(true);
    expect(reloaded.recordDirectionOutcome(directionRecord(1), HOUR_MS)).toBe(false);
    expect(reloaded.getState().direction.evaluatedCount).toBe(1);
  });
});

describe("INSUFFICIENT_DATA floor (n < 20) — never a naked misleadingly-precise percentage", () => {
  it("Direction perHorizon/perAction reports insufficientData + null rate fields below the floor, real numbers at/above it", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    // 19 LONG/SCALP resolutions — one short of the floor.
    for (let i = 0; i < DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE - 1; i++) {
      store.recordDirectionOutcome(directionRecord(i, { asOfMs: i * HOUR_MS }), HOUR_MS);
    }
    let report = store.buildReport();
    const scalpBelow = report.direction.perHorizon.find((h) => h.horizon === "SCALP")!;
    expect(scalpBelow.insufficientEffectiveSampleSize).toBe(true);
    const longBelow = scalpBelow.perAction.find((a) => a.action === "LONG")!;
    expect(longBelow.insufficientData).toBe(true);
    expect(longBelow.winRate).toBeNull();
    expect(longBelow.meanNetR).toBeNull();

    // one more (distinct hour ⇒ distinct block ⇒ effectiveN also crosses the floor) reaches exactly 20.
    store.recordDirectionOutcome(
      directionRecord(DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE, { asOfMs: DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE * HOUR_MS }),
      HOUR_MS,
    );
    report = store.buildReport();
    const scalpAtFloor = report.direction.perHorizon.find((h) => h.horizon === "SCALP")!;
    expect(scalpAtFloor.n).toBe(20);
    expect(scalpAtFloor.insufficientEffectiveSampleSize).toBe(false);
    const longAtFloor = scalpAtFloor.perAction.find((a) => a.action === "LONG")!;
    expect(longAtFloor.insufficientData).toBe(false);
    expect(longAtFloor.winRate).not.toBeNull();
    expect(longAtFloor.meanNetR).not.toBeNull();
  });

  it("Entry perAction/perLane/perSymbol report insufficientData below the floor and real numbers at/above it", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    for (let i = 0; i < DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE - 1; i++) {
      store.recordEntryOutcome(entryRecord(i));
    }
    let report = store.buildReport();
    const enterNowMeasured = report.entry.perAction.find((a) => a.action === "ENTER_NOW" && a.confidence === "MEASURED")!;
    expect(enterNowMeasured.insufficientData).toBe(true);
    expect(enterNowMeasured.winRate).toBeNull();
    const laneBelow = report.entry.perLane.find((l) => l.laneId === "CG_WIDE_FAST_LONG")!;
    expect(laneBelow.insufficientData).toBe(true);

    store.recordEntryOutcome(entryRecord(DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE));
    report = store.buildReport();
    const enterNowAtFloor = report.entry.perAction.find((a) => a.action === "ENTER_NOW" && a.confidence === "MEASURED")!;
    expect(enterNowAtFloor.n).toBe(20);
    expect(enterNowAtFloor.insufficientData).toBe(false);
    expect(enterNowAtFloor.winRate).not.toBeNull();
    const laneAtFloor = report.entry.perLane.find((l) => l.laneId === "CG_WIDE_FAST_LONG")!;
    expect(laneAtFloor.insufficientData).toBe(false);
  });

  it("a bucket that has never been observed (n=0) is still emitted, honestly insufficientData with null rates", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    const report = store.buildReport();
    const neverObserved = report.entry.perAction.find((a) => a.action === "WAIT_BREAKOUT" && a.confidence === "MEASURED")!;
    expect(neverObserved).toBeDefined();
    expect(neverObserved.n).toBe(0);
    expect(neverObserved.insufficientData).toBe(true);
    expect(neverObserved.winRate).toBeNull();
  });
});

describe("Entry Tier 1 / Tier 2 — NEVER blended into one field anywhere in the report", () => {
  it("with both tiers present, calibration reports them as two SEPARATE rows, never merged into one aggregate", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    // 5 Tier 1 (realized, MEASURED, engine-sourced) + 3 Tier 2 (simulated, MEASURED) rows — deliberately
    // different realizedNetR distributions so a blended mean would be trivially detectable as wrong.
    for (let i = 0; i < 5; i++) {
      store.recordEntryOutcome(
        entryRecord(i, { tier: "TIER1_REALIZED", realizedNetR: 1.0, expectedNetR: 1.0, realizedRSource: "engine", horizonTruncated: null }),
      );
    }
    for (let i = 5; i < 8; i++) {
      store.recordEntryOutcome(
        entryRecord(i, {
          tier: "TIER2_SIMULATED",
          realizedNetR: -1.0,
          expectedNetR: -1.0,
          realizedRSource: null,
          horizonTruncated: false,
        }),
      );
    }
    const report = store.buildReport();

    // coverage keeps the tier split visible as separate counters — never a combined "resolved" number.
    expect(report.entry.coverage.resolvedRealMatch).toBe(5);
    expect(report.entry.coverage.resolvedSimulated).toBe(3);

    // calibration: exactly 2 rows, one per tier, each reflecting ONLY its own tier's rows.
    expect(report.entry.calibration).toHaveLength(2);
    const tier1 = report.entry.calibration.find((c) => c.tier === "TIER1_REALIZED")!;
    const tier2 = report.entry.calibration.find((c) => c.tier === "TIER2_SIMULATED")!;
    expect(tier1.n).toBe(5);
    expect(tier2.n).toBe(3);
    // A blended mean across all 8 rows would be (5*1.0 + 3*-1.0)/8 = 0.25 — assert neither tier row
    // shows that blended value; each tier's own cumNetR/n reflects ONLY its own rows.
    expect(tier1.cumNetR).toBeCloseTo(5.0, 6);
    expect(tier2.cumNetR).toBeCloseTo(-3.0, 6);

    // recent rows retain the tier tag per-record — a reader can always tell which tier produced which row.
    const recentTiers = new Set(report.entry.recent.map((r) => r.tier));
    expect(recentTiers.has("TIER1_REALIZED")).toBe(true);
    expect(recentTiers.has("TIER2_SIMULATED")).toBe(true);
  });
});

describe("buildDirectionEntryOutcomeReport — cycleMeta + shape", () => {
  it("carries generatedAt/reportOnly/cycleMeta through untouched from the persisted state", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    store.recordCycle("2026-07-23T00:00:00.000Z", 3, "boom: direction-candles failed");
    const report = store.buildReport();
    expect(report.reportOnly).toBe(true);
    expect(report.cycleMeta.lastRunAtIso).toBe("2026-07-23T00:00:00.000Z");
    expect(report.cycleMeta.lastProcessed).toBe(3);
    expect(report.cycleMeta.lastError).toBe("boom: direction-candles failed");
  });
});

describe("REGRESSION (adversarial review 2026-07-23): Direction perAction/calibration gate on OWN n, not just shared effectiveN", () => {
  it("a bucket with n=1 of its OWN observations must stay insufficientData:true even once the horizon's shared effectiveN crosses the floor", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    // 19 LONG resolutions (distinct hourly blocks) + 1 SHORT resolution (a distinct 20th hourly block) —
    // exactly the reviewer's repro: this pushes the horizon's SHARED effectiveN to 20, but the SHORT
    // bucket itself has only ever seen n=1 real observation.
    for (let i = 0; i < 19; i++) {
      store.recordDirectionOutcome(directionRecord(i, { action: "LONG", asOfMs: i * HOUR_MS }), HOUR_MS);
    }
    store.recordDirectionOutcome(
      directionRecord(19, { action: "SHORT", asOfMs: 19 * HOUR_MS, chosenNetR: 5, win: 1 }),
      HOUR_MS,
    );

    const report = store.buildReport();
    const scalp = report.direction.perHorizon.find((h) => h.horizon === "SCALP")!;
    expect(scalp.effectiveN).toBe(20);
    expect(scalp.insufficientEffectiveSampleSize).toBe(false); // horizon-level gate is legitimately open

    const shortBucket = scalp.perAction.find((a) => a.action === "SHORT")!;
    expect(shortBucket.n).toBe(1);
    // Pre-fix, this bucket incorrectly reported insufficientData:false with a naked "100% win rate / 5.0
    // mean R" from a single observation — exactly the misleadingly-precise percentage the module's own
    // INSUFFICIENT_DATA floor doc says must never happen.
    expect(shortBucket.insufficientData).toBe(true);
    expect(shortBucket.winRate).toBeNull();
    expect(shortBucket.meanNetR).toBeNull();

    // Same leak applies to direction.calibration (same effectiveN-only gate) — assert it too.
    const shortCalibration = report.direction.calibration.find((c) => c.horizon === "SCALP" && c.action === "SHORT")!;
    expect(shortCalibration.insufficientData).toBe(true);
    expect(shortCalibration.winRate).toBeNull();

    // The LONG bucket legitimately has n=19 (one short of the floor) — still correctly gated, unaffected.
    const longBucket = scalp.perAction.find((a) => a.action === "LONG")!;
    expect(longBucket.n).toBe(19);
    expect(longBucket.insufficientData).toBe(true);
  });
});

describe("REGRESSION (adversarial review 2026-07-23): calibration winRate is null, never a fabricated 0", () => {
  it("entry.calibration rows (win is never a meaningful concept there) report winRate:null, not a fabricated 0", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    // 25 TIER1_REALIZED rows, all winners (+1.0R) — if winRate were computed as wins/n with win always
    // passed as null (calibration rows never track win), this would show a fabricated "0% win rate"
    // right next to a correct +1.0 mean R.
    for (let i = 0; i < 25; i++) {
      store.recordEntryOutcome(entryRecord(i, { tier: "TIER1_REALIZED", realizedNetR: 1.0, expectedNetR: 1.0 }));
    }
    const report = store.buildReport();
    const tier1 = report.entry.calibration.find((c) => c.tier === "TIER1_REALIZED")!;
    expect(tier1.n).toBe(25);
    expect(tier1.meanNetR).toBeCloseTo(1.0, 6);
    expect(tier1.winRate).toBeNull();
  });
});

describe("REGRESSION (adversarial review 2026-07-23): entry.calibration is a TRUE running counter, survives records pruning", () => {
  it("calibration.n keeps growing past MAX_ENTRY_RECORDS (2500), matching resolvedRealMatchCount, never silently stalling", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    const totalRows = 2600; // > MAX_ENTRY_RECORDS (2500) — records array itself gets pruned to the newest 2500
    for (let i = 0; i < totalRows; i++) {
      store.recordEntryOutcome(entryRecord(i, { tier: "TIER1_REALIZED", realizedNetR: 0.5, expectedNetR: 0.5 }));
    }
    const report = store.buildReport();
    // The bounded detail array is indeed pruned (proves the test actually exercises the pruning boundary).
    expect(store.getState().entry.records.length).toBeLessThan(totalRows);
    // But calibration.n and resolvedRealMatchCount — both true running counters — must agree with the
    // full cumulative total, NOT the pruned records-array length.
    expect(report.entry.coverage.resolvedRealMatch).toBe(totalRows);
    const tier1 = report.entry.calibration.find((c) => c.tier === "TIER1_REALIZED")!;
    expect(tier1.n).toBe(totalRows);
  });
});

describe("REGRESSION (adversarial review 2026-07-23): Entry perAction/perLane/perSymbol are tier-scoped, never blended", () => {
  it("Tier 1 (real, +1.0R) and Tier 2 (simulated, -1.0R) for the SAME action/lane/symbol never net to a blended 0", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    // 25 per tier — clears the DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE (20) floor so meanNetR is a real
    // number, not null, making a blend vs. non-blend genuinely distinguishable in this assertion.
    for (let i = 0; i < 25; i++) {
      store.recordEntryOutcome(
        entryRecord(i, { tier: "TIER1_REALIZED", realizedNetR: 1.0, expectedNetR: 1.0, realizedRSource: "engine" }),
      );
    }
    for (let i = 25; i < 50; i++) {
      store.recordEntryOutcome(
        entryRecord(i, {
          tier: "TIER2_SIMULATED",
          realizedNetR: -1.0,
          expectedNetR: -1.0,
          realizedRSource: null,
          horizonTruncated: false,
        }),
      );
    }
    const report = store.buildReport();

    // perAction: same action ("ENTER_NOW") + confidence ("MEASURED") for both tiers — must appear as TWO
    // separate rows, each reflecting ONLY its own tier, never a blended (25*1.0 + 25*-1.0)/50 = 0.
    const tier1Action = report.entry.perAction.find((a) => a.tier === "TIER1_REALIZED" && a.action === "ENTER_NOW" && a.confidence === "MEASURED")!;
    const tier2Action = report.entry.perAction.find((a) => a.tier === "TIER2_SIMULATED" && a.action === "ENTER_NOW" && a.confidence === "MEASURED")!;
    expect(tier1Action.n).toBe(25);
    expect(tier1Action.meanNetR).toBeCloseTo(1.0, 6);
    expect(tier2Action.n).toBe(25);
    expect(tier2Action.meanNetR).toBeCloseTo(-1.0, 6);

    // perLane: same lane ("CG_WIDE_FAST_LONG") for both tiers — two rows, never one blended n=50/mean=0 row.
    const laneRows = report.entry.perLane.filter((l) => l.laneId === "CG_WIDE_FAST_LONG");
    expect(laneRows).toHaveLength(2);
    const tier1Lane = laneRows.find((l) => l.tier === "TIER1_REALIZED")!;
    const tier2Lane = laneRows.find((l) => l.tier === "TIER2_SIMULATED")!;
    expect(tier1Lane.n).toBe(25);
    expect(tier1Lane.meanNetR).toBeCloseTo(1.0, 6);
    expect(tier2Lane.n).toBe(25);
    expect(tier2Lane.meanNetR).toBeCloseTo(-1.0, 6);

    // perSymbol: same symbol ("BTCUSDT") for both tiers — two rows, never one blended row.
    const symRows = report.entry.perSymbol.filter((s) => s.symbolOrBasketId === "BTCUSDT");
    expect(symRows).toHaveLength(2);
    const tier1Sym = symRows.find((s) => s.tier === "TIER1_REALIZED")!;
    const tier2Sym = symRows.find((s) => s.tier === "TIER2_SIMULATED")!;
    expect(tier1Sym.n).toBe(25);
    expect(tier1Sym.meanNetR).toBeCloseTo(1.0, 6);
    expect(tier2Sym.n).toBe(25);
    expect(tier2Sym.meanNetR).toBeCloseTo(-1.0, 6);
  });
});

describe("REGRESSION (adversarial review 2026-07-23): Tier 1 'one close claimed once' cross-cycle memory", () => {
  it("hasClaimedTier1CloseKey tracks a matchedCloseKey once booked, and survives a reload from disk", () => {
    const dir = tmp();
    const store = new DirectionEntryOutcomeStore(dir);
    expect(store.hasClaimedTier1CloseKey("CG_WIDE_FAST_LONG::BTCUSDT::LONG::1")).toBe(false);
    store.recordEntryOutcome(
      entryRecord(1, { tier: "TIER1_REALIZED", matchedCloseKey: "CG_WIDE_FAST_LONG::BTCUSDT::LONG::1" }),
    );
    expect(store.hasClaimedTier1CloseKey("CG_WIDE_FAST_LONG::BTCUSDT::LONG::1")).toBe(true);
    expect(store.hasClaimedTier1CloseKey("some-other-close-key")).toBe(false);

    const reloaded = new DirectionEntryOutcomeStore(dir);
    expect(reloaded.hasClaimedTier1CloseKey("CG_WIDE_FAST_LONG::BTCUSDT::LONG::1")).toBe(true);
  });
});

describe("buildDirectionEntryOutcomeReport — pure builder, exported for tests", () => {
  it("accepts live pendingCounts from the ledger without the store itself needing to track pending", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    const report = buildDirectionEntryOutcomeReport(store.getState(), {
      directionByHorizon: { SCALP: 4, INTRADAY: 1 },
      entry: 7,
    });
    expect(report.direction.coverage.pending).toBe(5);
    expect(report.entry.coverage.pending).toBe(7);
  });
});

describe("netRTrackedN / winTrackedN expose the TRUE denominator behind meanNetR / winRate", () => {
  // Reproduces the real testnet 2026-07-25 case: Entry Tier-2 calibration reported n=10808 next to
  // meanR -0.368R, but only 62 of those rows carried an R at all — the rest were SKIP rows that resolve
  // with realizedNetR:null by design. The mean was always computed correctly (over the 62); what was
  // missing was any way for a reader to see that `n` was NOT the evidence count.
  function skipRow(n: number): EntryOutcomeRecord {
    return entryRecord(n, {
      tier: "TIER2_SIMULATED",
      action: "SKIP",
      confidence: "EXPERIMENTAL_COST_OF_CAUTION",
      expectedNetR: null,
      realizedNetR: null, // NOT_ENTERED — no R exists for a trade never taken
      realizedRSource: null,
    });
  }
  function enteredRow(n: number, realizedNetR: number): EntryOutcomeRecord {
    return entryRecord(n, {
      tier: "TIER2_SIMULATED",
      action: "ENTER_NOW",
      confidence: "MEASURED",
      realizedNetR,
    });
  }

  it("reports netRTrackedN as the count of rows that actually supplied an R, not n", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    // 30 R-bearing rows (each -1R) + 300 null-R SKIP rows, all in the same Tier-2 bucket.
    for (let i = 0; i < 30; i += 1) store.recordEntryOutcome(enteredRow(i, -1));
    for (let i = 0; i < 300; i += 1) store.recordEntryOutcome(skipRow(1000 + i));

    const report = buildDirectionEntryOutcomeReport(store.getState());
    const calib = report.entry.calibration.find((c) => c.tier === "TIER2_SIMULATED")!;

    expect(calib.n).toBe(330); // every row counts toward n
    expect(calib.netRTrackedN).toBe(30); // ...but only 30 carried an R
    // FAILS WITHOUT FIX: before netRTrackedN was exposed, a consumer had only `n` (330) to pair with a
    // mean derived from 30 rows — an 11x overstatement of the evidence.
    expect(calib.netRTrackedN).toBeLessThan(calib.n);
    // the mean itself was and remains correct: -30R over 30 R-bearing rows, NOT diluted across 330
    expect(calib.meanNetR).toBe(-1);
    expect(calib.cumNetR).toBe(-30);
  });

  it("netRTrackedN === n when every row carries an R (no spurious qualifier to render)", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    for (let i = 0; i < 25; i += 1) store.recordEntryOutcome(enteredRow(i, 0.4));
    const report = buildDirectionEntryOutcomeReport(store.getState());
    const calib = report.entry.calibration.find((c) => c.tier === "TIER2_SIMULATED")!;
    expect(calib.n).toBe(25);
    expect(calib.netRTrackedN).toBe(25);
    expect(calib.meanNetR).toBe(0.4);
  });

  it("an all-SKIP bucket reports netRTrackedN 0 and a null mean — never a fabricated +0.000R", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    for (let i = 0; i < 50; i += 1) store.recordEntryOutcome(skipRow(i));
    const report = buildDirectionEntryOutcomeReport(store.getState());
    const calib = report.entry.calibration.find((c) => c.tier === "TIER2_SIMULATED")!;
    expect(calib.n).toBe(50);
    expect(calib.netRTrackedN).toBe(0);
    expect(calib.meanNetR).toBeNull();
    expect(calib.winTrackedN).toBe(0);
    expect(calib.winRate).toBeNull();
  });
});

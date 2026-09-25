import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DirectionEntryOutcomeStore,
  type EntryOutcomeRecord,
} from "../src/lib/direction-entry-outcome-store.js";
import {
  FOUR_BRAIN_REINFORCEMENT_BLOCK_MS,
  FOUR_BRAIN_REINFORCEMENT_MIN_EFFECTIVE_SAMPLES,
  FourBrainExecutionReinforcementStore,
  foldEntryOutcomeRecordsForExecutionReinforcement,
} from "../src/lib/four-brain-execution-reinforcement.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-four-brain-reinforcement-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function record(n: number, overrides: Partial<EntryOutcomeRecord> = {}): EntryOutcomeRecord {
  return {
    decisionId: `entry-${n}`,
    tier: "TIER1_REALIZED",
    laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
    symbolOrBasketId: "ETHUSDT",
    side: "LONG",
    action: "ENTER_NOW",
    confidence: "MEASURED",
    asOfMs: n * FOUR_BRAIN_REINFORCEMENT_BLOCK_MS,
    status: "RESOLVED",
    expectedNetR: 0.2,
    realizedNetR: 0.2,
    realizedRSource: "executor",
    horizonTruncated: null,
    matchedCloseKey: `close-${n}`,
    canonicalRegimeFamily: "BULLISH",
    scannerRegime: "BULLISH_EXPANSION",
    marketContextSnapshotId: `snapshot-${n}`,
    ...overrides,
  };
}

const query = {
  canonicalRegimeFamily: "BULLISH" as const,
  laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
  symbolOrBasketId: "ETHUSDT",
  side: "LONG" as const,
};

describe("Four-Brain exact-fill reinforcement", () => {
  it("uses only exact Tier-1 ENTER_NOW testnet fills and never borrows another regime/symbol/action/tier", () => {
    const records = [
      record(1),
      record(2, { tier: "TIER2_SIMULATED" }),
      record(3, { action: "WAIT_CONFIRMATION" }),
      record(4, { canonicalRegimeFamily: "BEARISH" }),
      record(5, { symbolOrBasketId: "XRPUSDT" }),
      record(6, { canonicalRegimeFamily: null }),
    ];
    const folded = foldEntryOutcomeRecordsForExecutionReinforcement(records);
    expect(folded.get("BULLISH::CROSS_SECTIONAL_DIRECTIONAL_LONG::ETHUSDT::LONG")).toMatchObject({ n: 1 });
    expect(folded.get("BEARISH::CROSS_SECTIONAL_DIRECTIONAL_LONG::ETHUSDT::LONG")).toMatchObject({ n: 1 });
    expect(folded.get("BULLISH::CROSS_SECTIONAL_DIRECTIONAL_LONG::XRPUSDT::LONG")).toMatchObject({ n: 1 });
    expect(folded.size).toBe(3);
  });

  it("does not double-count the same matched close even if persisted data contains a duplicate", () => {
    const folded = foldEntryOutcomeRecordsForExecutionReinforcement([
      record(1),
      record(2, { matchedCloseKey: "close-1", realizedNetR: 5 }),
    ]);
    expect(folded.get("BULLISH::CROSS_SECTIONAL_DIRECTIONAL_LONG::ETHUSDT::LONG")).toMatchObject({ n: 1, sumNetR: 0.2 });
  });

  it("does not emit a positive or negative score before eight non-overlapping exact-fill blocks", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    for (let i = 0; i < FOUR_BRAIN_REINFORCEMENT_MIN_EFFECTIVE_SAMPLES - 1; i += 1) {
      store.recordEntryOutcome(record(i, { realizedNetR: -2 }));
    }
    const reinforcement = new FourBrainExecutionReinforcementStore(store).lookup(query);
    expect(reinforcement.verdict).toBe("INSUFFICIENT");
    expect(reinforcement.avgNetR).toBeNull();
    expect(reinforcement.adjustment).toBe(0);
  });

  it("earns a bounded positive boost only from a profitable exact cohort, while another symbol stays cold", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    for (let i = 0; i < FOUR_BRAIN_REINFORCEMENT_MIN_EFFECTIVE_SAMPLES; i += 1) {
      store.recordEntryOutcome(record(i, { realizedNetR: 0.2 }));
    }
    const reinforcementStore = new FourBrainExecutionReinforcementStore(store);
    const positive = reinforcementStore.lookup(query);
    expect(positive.verdict).toBe("POSITIVE");
    expect(positive.avgNetR).toBeCloseTo(0.2, 8);
    expect(positive.adjustment).toBeGreaterThan(0);
    expect(positive.adjustment).toBeLessThanOrEqual(0.1);
    expect(reinforcementStore.lookup({ ...query, symbolOrBasketId: "XRPUSDT" }).verdict).toBe("INSUFFICIENT");
  });

  it("produces a bounded negative advisory from a losing exact cohort", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    for (let i = 0; i < FOUR_BRAIN_REINFORCEMENT_MIN_EFFECTIVE_SAMPLES; i += 1) {
      store.recordEntryOutcome(record(i, { realizedNetR: -0.2 }));
    }
    const negative = new FourBrainExecutionReinforcementStore(store).lookup(query);
    expect(negative.verdict).toBe("NEGATIVE");
    expect(negative.adjustment).toBeLessThan(0);
    expect(negative.adjustment).toBeGreaterThanOrEqual(-0.1);
  });

  it("reports persisted actual-fill feedback separately from the wider ranking fold", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    store.recordEntryOutcome(record(1, { realizedRSource: "actual_fill_binding" }));
    store.recordEntryOutcome(record(2, { realizedRSource: "executor" }));
    const status = new FourBrainExecutionReinforcementStore(store).getStatus();
    expect(status.actualFillOutcomeRecords).toBe(1);
    expect(status.actualFillRankingRecords).toBe(1);
    expect(status.rankingRecords).toBe(2);
    expect(status.bucketCount).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  allocateDailyRangeBatch,
  type DailyRangeAllocationCandidate,
} from "../src/lib/daily-range-selector.js";

const candidates: DailyRangeAllocationCandidate[] = [
  { signalId: "a", symbol: "A", legacySequence: 0, selectorScore: 0.8 },
  { signalId: "b", symbol: "B", legacySequence: 1, selectorScore: 0.7 },
  { signalId: "c", symbol: "C", legacySequence: 2, selectorScore: 0.6 },
  { signalId: "d", symbol: "D", legacySequence: 3, selectorScore: 0.5 },
];

function shuffled<T>(source: readonly T[], seed: number): T[] {
  const out = [...source];
  let state = seed >>> 0;
  for (let index = out.length - 1; index > 0; index--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

function selected(input: readonly DailyRangeAllocationCandidate[], mode: "SEEDED_RANDOM_BASELINE" | "VALIDATED_SELECTOR" | "ECONOMIC_QUALITY_BASELINE" | "SHADOW_ALPHA_SELECTOR") {
  return allocateDailyRangeBatch({
    mode,
    strategyVersion: "daily-range-test-v2",
    batchTimestampMs: 123_456_000,
    environment: "testnet",
    availableSlots: 2,
    candidates: input,
  }).decisions.filter((row) => row.selected).map((row) => row.symbol);
}

describe("Daily Range batch allocator", () => {
  it("selects the same validated top-N across 1,000 candidate input permutations", () => {
    for (let seed = 1; seed <= 1_000; seed++) {
      expect(selected(shuffled(candidates, seed), "VALIDATED_SELECTOR")).toEqual(["A", "B"]);
    }
  });

  it("uses the same seeded-random baseline selection across 1,000 permutations", () => {
    const baseline = selected(candidates, "SEEDED_RANDOM_BASELINE");
    for (let seed = 1; seed <= 1_000; seed++) {
      expect(selected(shuffled(candidates, seed), "SEEDED_RANDOM_BASELINE")).toEqual(baseline);
    }
  });

  it("uses the same economic top-N across 1,000 permutations and never consults alpha shadow score", () => {
    const economic = candidates.map((candidate, index) => ({
      ...candidate,
      // Deliberately reverse alpha score from the economic quality order.
      selectorScore: 1 - index / 10,
      economic: {
        breakEvenWinRate: 0.40 + index / 100,
        costRatio: 0.10 + index / 100,
        plannedRiskUsd: 0.25 - index / 1_000,
        qualityTieBreakHash: `quality-${index}`,
      },
    }));
    for (let seed = 1; seed <= 1_000; seed++) {
      expect(selected(shuffled(economic, seed), "ECONOMIC_QUALITY_BASELINE")).toEqual(["A", "B"]);
      expect(selected(shuffled(economic, seed), "SHADOW_ALPHA_SELECTOR")).toEqual(["A", "B"]);
    }
  });

  it("derives the neutral baseline ordering from the declared environment seed", () => {
    const input = {
      mode: "SEEDED_RANDOM_BASELINE" as const,
      strategyVersion: "daily-range-test-v2",
      batchTimestampMs: 123_456_000,
      availableSlots: 2,
      candidates,
    };
    const testnet = allocateDailyRangeBatch({ ...input, environment: "testnet" });
    const mainnet = allocateDailyRangeBatch({ ...input, environment: "mainnet" });
    expect(testnet.seed).not.toBe(mainnet.seed);
    expect(testnet.decisions.map((row) => row.tieBreakHash)).not.toEqual(mainnet.decisions.map((row) => row.tieBreakHash));
  });

  it("exposes the historical loop-order defect only in the disabled legacy replay mode", () => {
    const first = allocateDailyRangeBatch({
      mode: "LOOP_ORDER_LEGACY",
      strategyVersion: "legacy",
      batchTimestampMs: 1,
      environment: "testnet",
      availableSlots: 1,
      candidates: [
        { signalId: "a", symbol: "AAA", legacySequence: 0, selectorScore: null },
        { signalId: "b", symbol: "BBB", legacySequence: 1, selectorScore: null },
        { signalId: "c", symbol: "CCC", legacySequence: 2, selectorScore: null },
      ],
    });
    const reversed = allocateDailyRangeBatch({
      mode: "LOOP_ORDER_LEGACY",
      strategyVersion: "legacy",
      batchTimestampMs: 1,
      environment: "testnet",
      availableSlots: 1,
      candidates: [
        { signalId: "a", symbol: "AAA", legacySequence: 2, selectorScore: null },
        { signalId: "b", symbol: "BBB", legacySequence: 1, selectorScore: null },
        { signalId: "c", symbol: "CCC", legacySequence: 0, selectorScore: null },
      ],
    });
    expect(first.decisions.find((row) => row.selected)?.symbol).toBe("AAA");
    expect(reversed.decisions.find((row) => row.selected)?.symbol).toBe("CCC");
  });

  it("fails closed without a validated score and reports a paused batch explicitly", () => {
    const unready = allocateDailyRangeBatch({
      mode: "VALIDATED_SELECTOR",
      strategyVersion: "v2",
      batchTimestampMs: 1,
      environment: "mainnet",
      availableSlots: 1,
      candidates: [{ signalId: "a", symbol: "AAA", legacySequence: 0, selectorScore: null }],
    });
    expect(unready.decisions[0]).toMatchObject({ selected: false, skipReason: "SELECTOR_NOT_READY" });

    const paused = allocateDailyRangeBatch({
      mode: "PAUSED",
      strategyVersion: "v2",
      batchTimestampMs: 1,
      environment: "mainnet",
      availableSlots: 1,
      candidates: [{ signalId: "a", symbol: "AAA", legacySequence: 0, selectorScore: null }],
    });
    expect(paused.decisions[0]).toMatchObject({ selected: false, skipReason: "LIVE_NEW_ENTRY_PAUSED" });
  });
});

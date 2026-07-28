import { describe, it, expect } from "vitest";
import {
  COMPARISON_VARIANTS,
  simulateEntryAcrossVariants,
  aggregateVariant,
  type EntryLike,
} from "../scripts/cgwide-fast-long-exit-ablation.js";
import type { KlineTuple } from "../src/lib/current-guard-variant-matrix.js";

function candle(openMs: number, high: number, low: number, close: number): KlineTuple {
  return [openMs, "0", String(high), String(low), String(close), "0", openMs + 300000];
}

const OPEN_MS = new Date("2026-05-20T00:00:00.000Z").getTime();

describe("cgwide-fast-long-exit-ablation", () => {
  it("runs every comparison row against the same entry+candles and returns one outcome per key", async () => {
    const entry: EntryLike = {
      symbol: "ETHUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 97, // 300bps-ish wide stop, matching CG_WIDE_FAST_LONG's own geometry
      stopDistanceBps: ((100 - 97) / 100) * 10000,
      openedAtMs: OPEN_MS,
    };
    // First candle stays below every row's target/add level (no ambiguity); second candle runs
    // well past every row's own target (0.5R / 2R / 3R) without ever dipping back toward any
    // stop, so every row — including the pyramid add's own leg 2 — resolves CLOSED_WIN cleanly.
    const candles: KlineTuple[] = [candle(OPEN_MS, 101, 99.5, 100.5), candle(OPEN_MS + 300000, 130, 105, 125)];
    const outcomes = await simulateEntryAcrossVariants(entry, candles);
    expect(outcomes.size).toBe(COMPARISON_VARIANTS.length);
    for (const v of COMPARISON_VARIANTS) {
      const o = outcomes.get(v.key);
      expect(o, `missing outcome for ${v.key}`).toBeDefined();
      expect(o!.netR).not.toBeNull();
      expect(o!.grossR).toBeGreaterThan(0);
    }
  });

  it("the tp1_full @0.5R row matches a hand-computed net R (cost-adjusted)", async () => {
    const entry: EntryLike = {
      symbol: "ETHUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 97,
      stopDistanceBps: ((100 - 97) / 100) * 10000, // 300
      openedAtMs: OPEN_MS,
    };
    // target = 100 + 0.5*3 = 101.5
    const candles: KlineTuple[] = [candle(OPEN_MS, 102, 99, 101.8)];
    const outcomes = await simulateEntryAcrossVariants(entry, candles);
    const row = outcomes.get("tp1_full @0.5R (current CG_WIDE_FAST_LONG)")!;
    expect(row.status).toBe("CLOSED_WIN");
    expect(row.grossR).toBeCloseTo(0.5, 6);
    // netR = grossR - (22/300) [no stop-out slip on a winner]
    expect(row.netR).toBeCloseTo(0.5 - 22 / 300, 6);
  });

  it("the pyramid row reports a combined+ADD status and a strictly higher net R than the single-entry baseline when the add triggers", async () => {
    const entry: EntryLike = {
      symbol: "ETHUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 97,
      stopDistanceBps: 1000, // wide enough that neither leg's cost dwarfs the reward
      openedAtMs: OPEN_MS,
    };
    // risk = 3 (entry 100, stop 97). Add level (1.0R) = 103; the pyramid row's own (2R) target =
    // 106. Second candle touches both in one bar: leg 1 hits its 2R target (grossR=2.0) and the
    // add level is touched too, opening leg 2 at 103 (stop 100, inherited target 106 -> grossR=1.0).
    const candles: KlineTuple[] = [
      candle(OPEN_MS, 101, 99.5, 100.5),
      candle(OPEN_MS + 300000, 112, 100.5, 111),
    ];
    const outcomes = await simulateEntryAcrossVariants(entry, candles);
    const pyramidKey = COMPARISON_VARIANTS.find((v) => v.isPyramid)!.key;
    const row = outcomes.get(pyramidKey)!;
    expect(row.status).toContain("+ADD");
    const baseline = outcomes.get("tp1_full @0.5R (current CG_WIDE_FAST_LONG)")!;
    expect(row.netR).not.toBeNull();
    expect(baseline.netR).not.toBeNull();
    expect(row.netR as number).toBeGreaterThan(baseline.netR as number);
  });

  it("aggregateVariant computes n / win rate / netAvgR / payoff over resolved outcomes only", () => {
    const stat = aggregateVariant([
      { netR: 1, grossR: 1.1, status: "CLOSED_WIN", resolutionSource: null },
      { netR: -1, grossR: -1, status: "CLOSED_LOSS", resolutionSource: null },
      { netR: null, grossR: null, status: "UNRESOLVED", resolutionSource: null }, // excluded
    ]);
    expect(stat.n).toBe(2);
    expect(stat.wr).toBeCloseTo(0.5, 6);
    expect(stat.netAvgR).toBeCloseTo(0, 6);
    expect(stat.payoffRatio).toBeCloseTo(1, 6);
  });

  it("aggregateVariant returns nulls (never throws) on an empty/all-unresolved set", () => {
    expect(aggregateVariant([])).toEqual({ n: 0, wr: null, netAvgR: null, payoffRatio: null });
    expect(
      aggregateVariant([{ netR: null, grossR: null, status: "UNRESOLVED", resolutionSource: null }]),
    ).toEqual({ n: 0, wr: null, netAvgR: null, payoffRatio: null });
  });
});

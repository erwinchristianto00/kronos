import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  analyzeHardCutCounterfactuals,
  extractHardCutIntents,
  type HardCutIntentInput,
} from "../src/lib/hard-cut-counterfactual.js";

function bar(high: number, low: number, close = (high + low) / 2): Candle {
  return { openTime: 0, open: close, high, low, close, volume: 1 };
}
const WINDOW = 12 * 60 * 60_000;
const NOW = 1_000_000_000_000;
const shortCut = (over: Partial<HardCutIntentInput> = {}): HardCutIntentInput => ({
  symbol: "ETHUSDT", direction: "SHORT", entryPrice: 100, stopPrice: 103, qty: 1,
  cutRealizedUsd: -1, cutAtMs: NOW - WINDOW - 1, ...over,
});

describe("hard-cut-counterfactual analyzer", () => {
  it("[SAVED] cut beats riding when price would have hit the stop (delta > 0)", async () => {
    // SHORT cut at -1 USD; afterwards price rallies through the 103 stop → ride loses qty*(100-103) = -3.
    const r = await analyzeHardCutCounterfactuals(
      [shortCut()],
      async () => [bar(101, 99), bar(104, 100)], // 2nd bar high 104 >= stop 103
      { windowMs: WINDOW, nowMs: NOW },
    );
    const rec = r.records[0]!;
    expect(rec.cfOutcome).toBe("RIDE_HIT_STOP");
    expect(rec.cfRealizedUsd).toBeCloseTo(-3, 9);
    expect(rec.deltaUsd).toBeCloseTo(-1 - -3, 9); // +2 → cut saved $2
    expect(rec.deltaUsd!).toBeGreaterThan(0);
    expect(r.summary.cutHelped).toBe(1);
  });

  it("[WHIPSAW] cut hurts when the bull fakes out and price recovers (delta < 0)", async () => {
    // SHORT cut at -1; price never hits 103, drifts back down to 96 → ride would profit qty*(100-96)=+4.
    const r = await analyzeHardCutCounterfactuals(
      [shortCut()],
      async () => [bar(101, 99), bar(100, 95, 96)],
      { windowMs: WINDOW, nowMs: NOW },
    );
    const rec = r.records[0]!;
    expect(rec.cfOutcome).toBe("RIDE_RECOVERED");
    expect(rec.cfRealizedUsd).toBeCloseTo(4, 9);
    expect(rec.deltaUsd!).toBeLessThan(0); // -1 - 4 = -5 → whipsaw
    expect(r.summary.cutWhipsawed).toBe(1);
  });

  it("[PENDING] a too-recent cut is not judged yet", async () => {
    const r = await analyzeHardCutCounterfactuals(
      [shortCut({ cutAtMs: NOW - 60_000 })], // 1 min ago, window 12h
      async () => [bar(104, 100)],
      { windowMs: WINDOW, nowMs: NOW },
    );
    expect(r.records[0]!.cfOutcome).toBe("PENDING");
    expect(r.summary.pending).toBe(1);
    expect(r.summary.resolved).toBe(0);
  });

  it("[VERDICT] needs a minimum sample before declaring a verdict", async () => {
    const cuts = Array.from({ length: 6 }, () => shortCut());
    const r = await analyzeHardCutCounterfactuals(cuts, async () => [bar(104, 100)], { windowMs: WINDOW, nowMs: NOW });
    expect(r.summary.resolved).toBe(6);
    expect(r.summary.verdict).toBe("HARD_CUT_HELPS"); // all hit stop → cut saved money
    const small = await analyzeHardCutCounterfactuals([shortCut()], async () => [bar(104, 100)], { windowMs: WINDOW, nowMs: NOW });
    expect(small.summary.verdict).toBe("INSUFFICIENT_DATA"); // n < 5
  });

  it("[EXTRACT] pulls only REGIME_OPPOSITION_HARD_CUT intents and parses geometry", () => {
    const state = {
      intents: [
        { symbol: "ETHUSDT", direction: "SHORT", closeReason: "REGIME_OPPOSITION_HARD_CUT_LONG_ONLY", filledEntryPrice: 100, stopLossPrice: 103, qty: 0.5, realizedPnlUsd: -1.2, closedAt: "2099-01-02T00:00:00.000Z" },
        { symbol: "BTCUSDT", direction: "SHORT", closeReason: "POSITION_FLAT", filledEntryPrice: 50000, stopLossPrice: 51500, qty: 0.01, realizedPnlUsd: 2, closedAt: "2099-01-02T00:00:00.000Z" },
        { symbol: "SOLUSDT", direction: "LONG", closeReason: "REGIME_OPPOSITION_HARD_CUT_SHORT_ONLY", filledEntryPrice: 70, stopLossPrice: 67, qty: 1, realizedPnlUsd: -0.5, closedAt: "2099-01-02T01:00:00.000Z" },
      ],
    };
    const out = extractHardCutIntents(state);
    expect(out.map((o) => o.symbol)).toEqual(["ETHUSDT", "SOLUSDT"]); // POSITION_FLAT excluded
    expect(out[0]!.entryPrice).toBe(100);
    expect(out[0]!.stopPrice).toBe(103);
    expect(out[1]!.direction).toBe("LONG");
  });
});

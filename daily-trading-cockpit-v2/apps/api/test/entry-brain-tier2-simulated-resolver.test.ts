import { describe, it, expect } from "vitest";
import type { PathCandle } from "../src/lib/entry-exit-counterfactual.js";
import type { PendingEntryRow } from "../src/lib/four-brain-outcome-ledger.js";
import {
  resolveEntryTier2Row,
  entryTier2ConfidenceForAction,
  bucketChaseRiskByDecile,
  bucketSlippageRiskByDecile,
  ENTRY_TIER2_HORIZON_BARS,
  ENTRY_TIER2_WAIT_WINDOW_BARS,
  type EntryTier2DecileInput,
} from "../src/lib/entry-brain-tier2-simulated-resolver.js";

const c = (o: number, h: number, l: number, cl: number, t = 0): PathCandle => ({ openTime: t, open: o, high: h, low: l, close: cl });

const baseRow = (overrides: Partial<PendingEntryRow> = {}): PendingEntryRow => ({
  decisionId: "d1",
  asOfMs: 1_000_000,
  symbolOrBasketId: "BTCUSDT",
  laneId: "CG_WIDE",
  side: "LONG",
  action: "ENTER_NOW",
  targetEntry: 100,
  initialStopPrice: 98, // riskDistance = 2
  expectedNetR: 0.3,
  ...overrides,
});

describe("resolveEntryTier2Row — geometry + null-safety", () => {
  it("never invents entryPrice/riskDistance: uses row.targetEntry and |targetEntry-initialStopPrice| exactly, even when candles[0]'s real close differs", () => {
    // candles[0]'s own close (123, wildly different) must NOT leak into the resolution.
    const path = [c(123, 123, 123, 123, 1_000_000), c(100, 105, 99.5, 104, 1_000_900)];
    const row = baseRow();
    const resolved = resolveEntryTier2Row(row, path);
    expect(resolved).not.toBeNull();
    expect(resolved!.entryPrice).toBe(100); // row.targetEntry, not candles[0].close
    expect(resolved!.riskDistance).toBe(2); // |100-98|, never a re-derived ATR distance
    expect(resolved!.result.outcome.entryPrice).toBe(100);
  });

  it("returns null when targetEntry is missing (never invents the decision's own geometry)", () => {
    expect(resolveEntryTier2Row(baseRow({ targetEntry: null }), [c(100, 100, 100, 100)])).toBeNull();
  });

  it("returns null when initialStopPrice is missing", () => {
    expect(resolveEntryTier2Row(baseRow({ initialStopPrice: null }), [c(100, 100, 100, 100)])).toBeNull();
  });

  it("returns null when targetEntry equals initialStopPrice (zero riskDistance)", () => {
    expect(resolveEntryTier2Row(baseRow({ initialStopPrice: 100 }), [c(100, 100, 100, 100)])).toBeNull();
  });

  it("returns null on an empty candle path", () => {
    expect(resolveEntryTier2Row(baseRow(), [])).toBeNull();
  });
});

describe("resolveEntryTier2Row — ENTER_NOW stop-out (loss case)", () => {
  it("hits the hard stop and reports a loss, stoppedOut=true", () => {
    // entry 100, stop 98 (riskDistance=2). Bar 1 crashes through the stop.
    const path = [c(100, 100, 100, 100, 0), c(100, 100.5, 97, 97.5, 900_000)];
    const resolved = resolveEntryTier2Row(baseRow({ action: "ENTER_NOW" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.result.outcome.stoppedOut).toBe(true);
    expect(resolved!.result.outcome.grossR).toBe(-1);
    expect(resolved!.result.outcome.netR).toBeLessThan(-1); // -1 minus round-trip cost
    expect(resolved!.confidence).toBe("MEASURED");
  });
});

describe("resolveEntryTier2Row — ENTER_NOW time-exit at horizon cap", () => {
  it("reaches the cap without ever touching the stop: resolves at the cap candle's close, not stopped out", () => {
    // Build ENTRY_TIER2_HORIZON_BARS+2 quiet candles that never approach the 98 stop.
    const path: PathCandle[] = [c(100, 100, 100, 100, 0)];
    for (let i = 1; i <= ENTRY_TIER2_HORIZON_BARS + 2; i += 1) {
      path.push(c(100 + i * 0.01, 100.5 + i * 0.01, 99.5 + i * 0.01, 100.2 + i * 0.01, i * 900_000));
    }
    const resolved = resolveEntryTier2Row(baseRow({ action: "ENTER_NOW" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.result.outcome.stoppedOut).toBe(false);
    expect(resolved!.result.outcome.exitBar).toBe(ENTRY_TIER2_HORIZON_BARS); // capped exactly at the named constant
    expect(resolved!.result.outcome.exitPrice).toBe(path[ENTRY_TIER2_HORIZON_BARS]!.close); // cap candle's CLOSE
    expect(resolved!.confidence).toBe("MEASURED");
  });
});

describe("resolveEntryTier2Row — ambiguous intrabar", () => {
  it("a bar touching BOTH the stop and a >=+1R favorable extreme is flagged ambiguous, resolved adverse-first (never silently favorable)", () => {
    // entry 100, riskDistance 2 (stop @ 98). Bar1 high=102.5 (+1.25R) AND low=97.5 (through stop) in the same bar.
    const path = [c(100, 100, 100, 100, 0), c(100, 102.5, 97.5, 98, 900_000)];
    const resolved = resolveEntryTier2Row(baseRow({ action: "ENTER_NOW" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.result.outcome.ambiguousIntrabar).toBe(true);
    expect(resolved!.result.outcome.stoppedOut).toBe(true); // resolved adverse (stop) first, never favorably
    expect(resolved!.result.outcome.grossR).toBe(-1);
  });
});

describe("confidence tagging — permanent schema field", () => {
  it("ENTER_NOW always MEASURED", () => {
    expect(entryTier2ConfidenceForAction("ENTER_NOW")).toBe("MEASURED");
  });
  it("WAIT_PULLBACK / WAIT_BREAKOUT / WAIT_CONFIRMATION / SKIP always EXPERIMENTAL_COST_OF_CAUTION", () => {
    expect(entryTier2ConfidenceForAction("WAIT_PULLBACK")).toBe("EXPERIMENTAL_COST_OF_CAUTION");
    expect(entryTier2ConfidenceForAction("WAIT_BREAKOUT")).toBe("EXPERIMENTAL_COST_OF_CAUTION");
    expect(entryTier2ConfidenceForAction("WAIT_CONFIRMATION")).toBe("EXPERIMENTAL_COST_OF_CAUTION");
    expect(entryTier2ConfidenceForAction("SKIP")).toBe("EXPERIMENTAL_COST_OF_CAUTION");
  });

  it("resolveEntryTier2Row carries the tag through end-to-end for a WAIT row", () => {
    const path = [c(100, 100, 100, 100, 0), c(100, 100.2, 99, 99.5, 900_000), c(99.5, 102, 99.5, 101.5, 1_800_000)];
    const resolved = resolveEntryTier2Row(baseRow({ action: "WAIT_PULLBACK" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.confidence).toBe("EXPERIMENTAL_COST_OF_CAUTION");
  });

  it("resolveEntryTier2Row carries the tag through end-to-end for a SKIP row", () => {
    const path = [c(100, 100, 100, 100, 0), c(100, 101, 99.5, 100.5, 900_000)];
    const resolved = resolveEntryTier2Row(baseRow({ action: "SKIP" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.confidence).toBe("EXPERIMENTAL_COST_OF_CAUTION");
    expect(resolved!.result.outcome.entered).toBe(false); // SKIP never "enters" a simulated trade
  });
});

describe("resolveEntryTier2Row — horizonTruncated (candle under-fetch detection)", () => {
  it("flags horizonTruncated when a WAIT_PULLBACK trigger fires after bar 0 and the caller supplied only the un-corrected ENTRY_TIER2_HORIZON_BARS+1 candles", () => {
    // Bars 1-7: quiet, no pullback trigger (pullTarget = 100 - 0.5*2 = 99; low stays above 99).
    const path: PathCandle[] = [c(100, 100, 100, 100, 0)];
    for (let i = 1; i <= 7; i += 1) path.push(c(100, 100.5, 99.5, 100.2, i * 900_000));
    // Bar 8: dips to the pullback target (low=98.5 <= 99) without touching ENTER_NOW's own stop (98).
    path.push(c(100, 100.5, 98.5, 99, 8 * 900_000));
    // Bars 9..32 (the full un-corrected candle count the OLD docstring asked for): quiet, never near the
    // pulled trade's own stop (99 - 2 = 97).
    for (let i = 9; i <= ENTRY_TIER2_HORIZON_BARS; i += 1) path.push(c(99, 99.5, 98, 99.2, i * 900_000));

    const resolved = resolveEntryTier2Row(baseRow({ action: "WAIT_PULLBACK" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.result.outcome.entered).toBe(true);
    expect(resolved!.result.outcome.stoppedOut).toBe(false);
    expect(resolved!.result.outcome.entryBar).toBe(8);
    // The path ran out at bar 32 (path.length-1), NOT at the trade's own entryBar(8)+horizon(32)=40 —
    // only 24 bars walked instead of the intended 32.
    expect(resolved!.result.outcome.exitBar).toBe(ENTRY_TIER2_HORIZON_BARS);
    expect(resolved!.result.outcome.exitBar! - resolved!.result.outcome.entryBar!).toBe(ENTRY_TIER2_HORIZON_BARS - 8);
    expect(resolved!.horizonTruncated).toBe(true);
  });

  it("does NOT flag horizonTruncated for the same WAIT_PULLBACK trigger when the caller supplies the CORRECTED candle count (horizon + wait window)", () => {
    const path: PathCandle[] = [c(100, 100, 100, 100, 0)];
    for (let i = 1; i <= 7; i += 1) path.push(c(100, 100.5, 99.5, 100.2, i * 900_000));
    path.push(c(100, 100.5, 98.5, 99, 8 * 900_000)); // same trigger at bar 8
    for (let i = 9; i <= ENTRY_TIER2_HORIZON_BARS + ENTRY_TIER2_WAIT_WINDOW_BARS; i += 1) {
      path.push(c(99, 99.5, 98, 99.2, i * 900_000));
    }

    const resolved = resolveEntryTier2Row(baseRow({ action: "WAIT_PULLBACK" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.result.outcome.entryBar).toBe(8);
    // Now the trade gets its own FULL 32-bar horizon from its own entry bar (8+32=40).
    expect(resolved!.result.outcome.exitBar).toBe(8 + ENTRY_TIER2_HORIZON_BARS);
    expect(resolved!.horizonTruncated).toBe(false);
  });

  it("does NOT flag horizonTruncated for an ENTER_NOW full-horizon time-exit (genuine cap, not an under-fetch)", () => {
    const path: PathCandle[] = [c(100, 100, 100, 100, 0)];
    for (let i = 1; i <= ENTRY_TIER2_HORIZON_BARS + 2; i += 1) {
      path.push(c(100 + i * 0.01, 100.5 + i * 0.01, 99.5 + i * 0.01, 100.2 + i * 0.01, i * 900_000));
    }
    const resolved = resolveEntryTier2Row(baseRow({ action: "ENTER_NOW" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.horizonTruncated).toBe(false);
  });

  it("does NOT flag horizonTruncated on a stop-out (a stop is never a truncation)", () => {
    const path = [c(100, 100, 100, 100, 0), c(100, 100.5, 97, 97.5, 900_000)];
    const resolved = resolveEntryTier2Row(baseRow({ action: "ENTER_NOW" }), path);
    expect(resolved).not.toBeNull();
    expect(resolved!.result.outcome.stoppedOut).toBe(true);
    expect(resolved!.horizonTruncated).toBe(false);
  });
});

describe("decile bucketing — report over existing fields, no new model", () => {
  it("buckets chaseRisk into 10 fixed [0,1] deciles and averages netR per bucket", () => {
    const rows: EntryTier2DecileInput[] = [
      { chaseRisk: 0.05, slippageRisk: 0.05, netR: 0.5 },
      { chaseRisk: 0.09, slippageRisk: 0.91, netR: -0.5 },
      { chaseRisk: 0.95, slippageRisk: 0.2, netR: -1.0 },
    ];
    const chaseBuckets = bucketChaseRiskByDecile(rows);
    expect(chaseBuckets).toHaveLength(10);
    expect(chaseBuckets[0]!.n).toBe(2); // both 0.05 and 0.09 land in decile 0
    expect(chaseBuckets[0]!.meanNetR).toBeCloseTo(0.0); // mean of 0.5 and -0.5
    expect(chaseBuckets[9]!.n).toBe(1); // 0.95 lands in decile 9
    expect(chaseBuckets[9]!.meanNetR).toBeCloseTo(-1.0);
    expect(chaseBuckets[5]!.n).toBe(0);
    expect(chaseBuckets[5]!.meanNetR).toBeNull(); // never a fabricated 0 for an empty bucket

    const slipBuckets = bucketSlippageRiskByDecile(rows);
    expect(slipBuckets[9]!.n).toBe(1); // 0.91
    expect(slipBuckets[0]!.n).toBe(1); // 0.05
    expect(slipBuckets[2]!.n).toBe(1); // 0.2
  });

  it("excludes null/out-of-range x from every bucket rather than clamping", () => {
    const rows: EntryTier2DecileInput[] = [
      { chaseRisk: null, slippageRisk: null, netR: 1 },
      { chaseRisk: 1.5, slippageRisk: -0.1, netR: 1 },
    ];
    const chaseBuckets = bucketChaseRiskByDecile(rows);
    expect(chaseBuckets.reduce((s, b) => s + b.n, 0)).toBe(0);
    const slipBuckets = bucketSlippageRiskByDecile(rows);
    expect(slipBuckets.reduce((s, b) => s + b.n, 0)).toBe(0);
  });

  it("a decile with entries but all-null netR reports n>0 and meanNetR null (never fabricated)", () => {
    const rows: EntryTier2DecileInput[] = [{ chaseRisk: 0.5, slippageRisk: 0.5, netR: null }];
    expect(bucketChaseRiskByDecile(rows)[5]!.n).toBe(1);
    expect(bucketChaseRiskByDecile(rows)[5]!.meanNetR).toBeNull();
  });
});

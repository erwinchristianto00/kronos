import { describe, expect, it } from "vitest";
import { reconstructSymbol, hasDataGapInLookback, HOUR, WARMUP, GAP_LOOKBACK_BARS, type Candle } from "../src/lib/replay-tier-a-core.js";

/**
 * Regression tests for BUG 1 (data-integrity) in the Tier-A FROZEN reconstruction core
 * (apps/api/src/lib/replay-tier-a-core.ts) — an OFFLINE, report-only historical replay pipeline.
 *
 * `dataGap` was hardcoded `false` at every classifyReplayRow call site, so the DATA_GAP quality classification
 * could never fire even when the underlying candle series had a genuine gap (e.g. a missing monthly CSV
 * silently concatenated as `[]` by the 6mo runner scripts — see scripts/replay-tier-a-6mo-run.ts line ~142 and
 * scripts/replay-entry-exit-6mo-run.ts line ~49, both of which substitute `[]` for any absent file rather than
 * failing loudly). Fixed by `hasDataGapInLookback`, which actually detects a non-contiguous 1h boundary inside
 * the causal lookback window feeding a row's features.
 */

const closeTimeOf = (openTime: number): number => openTime + HOUR - 1;

/** A plausible, gently-oscillating candle so ATR/EMA/percentile features are non-degenerate (finite, ATR>0). */
function makeCandle(openTime: number, k: number): Candle {
  const close = 100 + (k % 7) * 0.3;
  const open = close - 0.05;
  return { openTime, open, high: close + 0.25, low: close - 0.25, close, volume: 10, takerBuy: 5, closeTime: closeTimeOf(openTime) };
}

describe("BUG 1 — DATA_GAP can actually fire (hasDataGapInLookback)", () => {
  it("no gap in a fully contiguous series", () => {
    const candles = Array.from({ length: 300 }, (_, k) => makeCandle(k * HOUR, k));
    expect(hasDataGapInLookback(candles, 250, GAP_LOOKBACK_BARS)).toBe(false);
  });

  it("detects a gap within the lookback window, not beyond it", () => {
    // Build a series with a single non-contiguous boundary at index 100 (simulates a missing monthly file
    // silently concatenated — see scripts/replay-tier-a-6mo-run.ts line ~142 / replay-entry-exit-6mo-run.ts
    // line ~49, which substitute `[]` for any absent file rather than failing loudly).
    const candles: Candle[] = [];
    let openTime = 0;
    for (let k = 0; k < 100; k += 1) { candles.push(makeCandle(openTime, k)); openTime += HOUR; }
    openTime += 5 * HOUR; // the gap: a silently-dropped 5-bar stretch
    for (let k = 100; k < 300; k += 1) { candles.push(makeCandle(openTime, k)); openTime += HOUR; }

    // Just after the gap (index 105): well inside the 168-bar lookback ⇒ must be flagged.
    expect(hasDataGapInLookback(candles, 105, GAP_LOOKBACK_BARS)).toBe(true);
    // Far after the gap (index 100 + 168 + 10 = 278): outside the lookback ⇒ must NOT be flagged.
    expect(hasDataGapInLookback(candles, 278, GAP_LOOKBACK_BARS)).toBe(false);
    // Before the gap entirely: must NOT be flagged.
    expect(hasDataGapInLookback(candles, 70, GAP_LOOKBACK_BARS)).toBe(false);
  });

  it("reconstructSymbol wires the gap into classifyReplayRow: rows near a real gap are DATA_GAP, rows far from it are not", () => {
    const candles: Candle[] = [];
    let openTime = 0;
    for (let k = 0; k < 100; k += 1) { candles.push(makeCandle(openTime, k)); openTime += HOUR; }
    openTime += 5 * HOUR; // silently-dropped monthly-file stretch
    for (let k = 100; k < 300; k += 1) { candles.push(makeCandle(openTime, k)); openTime += HOUR; }

    const { marketRows } = reconstructSymbol("TESTGAP", candles);
    // marketRows[j] corresponds to loop index i = WARMUP + j (no rows are skipped in this fixture: openTime+HOUR
    // always <= closeTime+1, so the leak-guard never rejects a row here).
    expect(marketRows.length).toBe(candles.length - WARMUP);
    const rowAt = (i: number) => marketRows[i - WARMUP]!;

    // Before the fix this was impossible: dataGap was hardcoded false, so DATA_GAP could never appear here
    // even though the row's causal lookback genuinely overlaps a silently-dropped stretch of candles.
    expect(rowAt(105).status).toBe("DATA_GAP");
    // A row far enough past the gap that it has scrolled out of the lookback window must NOT be DATA_GAP.
    expect(rowAt(278).status).not.toBe("DATA_GAP");
    expect(rowAt(278).status).toBe("GOLD");
  });
});

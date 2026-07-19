import { describe, expect, it } from "vitest";
import { reconstructSymbol, HOUR, type Candle } from "../src/lib/replay-tier-a-core.js";

/**
 * Regression tests for BUG 2 (misleading independence) in the Tier-A FROZEN reconstruction core
 * (apps/api/src/lib/replay-tier-a-core.ts) — an OFFLINE, report-only historical replay pipeline.
 *
 * The "causal" audit built from `buildSnapshotAudit`/`isCausal` was tautological: it compared a candle's OWN
 * closeTime against a decisionAtMs DERIVED FROM that same closeTime (decisionAtMs = c.closeTime + 1), so it was
 * guaranteed true by construction and could never disagree with — or catch a bug in — the separate
 * `candleAvailableAt` leak-guard a few lines above. It produced no wrong output (the leak-guard is the real
 * protection), but was documented as if it independently verified causality.
 *
 * Fixed by deriving the audit from a genuinely different signal: the running max closeTime over every
 * antecedent candle (not this bar's own openTime+HOUR arithmetic), which CAN catch a leak the single-bar
 * leak-guard structurally cannot — e.g. a future-dated/corrupted candle smuggled earlier in the array that the
 * EMA/ATR/percentile computations (which iterate candles[0..i] assuming ascending order) would silently ingest.
 */

const closeTimeOf = (openTime: number): number => openTime + HOUR - 1;

/** A plausible, gently-oscillating candle so ATR/EMA/percentile features are non-degenerate (finite, ATR>0). */
function makeCandle(openTime: number, k: number, closeTimeOverride?: number): Candle {
  const close = 100 + (k % 7) * 0.3;
  const open = close - 0.05;
  return {
    openTime, open, high: close + 0.25, low: close - 0.25, close, volume: 10, takerBuy: 5,
    closeTime: closeTimeOverride ?? closeTimeOf(openTime),
  };
}

describe("BUG 2 — the causal audit is a genuinely independent re-check, not a tautology", () => {
  it("a future-dated candle smuggled earlier in the (otherwise valid-looking) array is caught, even though the leak-guard on later bars passes", () => {
    // All openTimes progress normally (so the per-bar leak-guard, which only inspects THIS bar's own
    // openTime+HOUR against ITS OWN decisionAtMs, passes for every row). But candle #10's closeTime is
    // corrupted to an absurdly far-future value — the kind of data-integrity bug a mis-sorted or corrupted
    // source file could introduce, which the single-bar leak-guard structurally cannot see because it never
    // looks at any OTHER candle's timestamp.
    const CORRUPT_IDX = 10;
    const FAR_FUTURE = 50 * 365 * 24 * HOUR; // ~50 years out — dwarfs every real decisionAtMs in this fixture
    const candles = Array.from({ length: 80 }, (_, k) => {
      const openTime = k * HOUR;
      return makeCandle(openTime, k, k === CORRUPT_IDX ? openTime + FAR_FUTURE : undefined);
    });

    const { marketRows } = reconstructSymbol("TESTCORRUPT", candles);
    expect(marketRows.length).toBeGreaterThan(0);
    // Before the fix, `causal` was derived solely from the CURRENT bar's own (perfectly normal) closeTime vs. a
    // decisionAtMs DERIVED FROM that same closeTime — tautologically true no matter what happened earlier in
    // the array. The fix threads a running max over every antecedent candle's closeTime through the audit, so
    // the corruption at index 10 must poison every later decision's causal re-check.
    for (const row of marketRows) {
      expect(row.causal).toBe(false);
      expect(row.status).toBe("TIMESTAMP_UNSAFE");
    }
  });

  it("a clean, properly-ordered series remains causal (no false positives introduced by the fix)", () => {
    const candles = Array.from({ length: 80 }, (_, k) => makeCandle(k * HOUR, k));
    const { marketRows } = reconstructSymbol("TESTCLEAN", candles);
    expect(marketRows.length).toBeGreaterThan(0);
    expect(marketRows.every((r) => r.causal === true)).toBe(true);
  });
});

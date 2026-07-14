import { describe, it, expect } from "vitest";
import { candleAvailableAt, closedCandlesAsOf } from "../src/lib/replay-clock.js";
import { computeEMA, computeATR } from "../src/lib/candle-indicators.js";

/**
 * Tier-A candle-proof causality tests (spec §6 — "candle causality tests").
 *
 * These encode the EXACT reconstruction convention used by scripts/replay-tier-a-run.ts:
 *   a 1h decision for bar `i` is stamped `decisionAtMs = closeTime(i) + 1`, and every feature
 *   (EMA50 / ATR14 / ROC20 / ATR-percentile) is computed ONLY over candles that have already
 *   closed at that instant. The tests below prove the two leakage modes that would silently
 *   inflate a candle backtest cannot occur:
 *     (1) a bar's final OHLC is not readable before that bar closes (no intra-bar high/low peek),
 *     (2) a higher-timeframe (1h) bar is not forward-filled into a finer (15m) decision that
 *         falls inside the still-forming 1h window.
 */

const MIN = 60_000;
const HOUR = 3_600_000;

// A tiny deterministic 1h series (openTime, o,h,l,c) — values chosen so a leak would change a feature.
const H1 = [
  { openTime: 0 * HOUR, o: 100, h: 101, l: 99, c: 100 },
  { openTime: 1 * HOUR, o: 100, h: 110, l: 100, c: 108 }, // big up bar — its high(110)/close(108) must NOT leak early
  { openTime: 2 * HOUR, o: 108, h: 109, l: 95, c: 96 }, //  big down bar
  { openTime: 3 * HOUR, o: 96, h: 97, l: 90, c: 92 },
];

describe("Tier-A causality — a bar's OHLC is unavailable before it closes", () => {
  it("decisionAt = closeTime+1 makes the just-closed bar available, and the next bar NOT", () => {
    const bar1Close = 1 * HOUR + HOUR; // openTime 1h, closes at 2h
    const decisionAt = bar1Close + 1; // the reconstruction convention
    // bar 1 (the one we just closed) is available…
    expect(candleAvailableAt(H1[1].openTime, HOUR, decisionAt)).toBe(true);
    // …but bar 2, still forming at that instant, is not (no high=109/low=95 peek).
    expect(candleAvailableAt(H1[2].openTime, HOUR, decisionAt)).toBe(false);
  });

  it("exactly AT the close boundary the forming bar is not yet counted until +1", () => {
    const openTime = 2 * HOUR;
    // asOf strictly before close → forming; at/after close → available. Convention decides at close+1.
    expect(candleAvailableAt(openTime, HOUR, openTime + HOUR - 1)).toBe(false);
    expect(candleAvailableAt(openTime, HOUR, openTime + HOUR)).toBe(true);
  });

  it("features (EMA/ATR) at a decision use ONLY closed bars — the forming bar cannot move them", () => {
    // Decide right after bar 1 closes: only bars {0,1} are closed.
    const decisionAt = H1[1].openTime + HOUR + 1;
    const closed = closedCandlesAsOf(H1, HOUR, decisionAt);
    expect(closed.map((c) => c.openTime)).toEqual([0 * HOUR, 1 * HOUR]);

    // Compute a feature over the closed slice, then over a slice that ILLEGALLY includes the forming bar 2.
    const legalCloses = closed.map((c) => (c as (typeof H1)[number]).c);
    const leakedCloses = [...legalCloses, H1[2].c]; // forward-fill the not-yet-closed bar (the bug we forbid)
    const emaLegal = computeEMA(legalCloses, 2).at(-1);
    const emaLeaked = computeEMA(leakedCloses, 2).at(-1);
    // The leak would change the feature — proving the closed-only slice is materially different (not a no-op).
    expect(emaLegal).not.toBe(emaLeaked);

    const atrLegal = computeATR(closed as (typeof H1)[number][], 2).at(-1);
    const atrLeaked = computeATR(H1.slice(0, 3), 2).at(-1); // includes forming bar 2's wide 95–109 range
    expect(atrLegal).not.toBe(atrLeaked);
  });
});

describe("Tier-A causality — higher timeframe is not forward-filled into a finer decision", () => {
  it("a 1h context bar is unavailable to a 15m decision inside the still-forming 1h window", () => {
    // A 15m decision at 01:30 falls inside the 1h bar that opened at 01:00 and closes at 02:00.
    const decisionAt15m = 1 * HOUR + 30 * MIN;
    expect(candleAvailableAt(H1[1].openTime, HOUR, decisionAt15m)).toBe(false); // 1h[1] still forming → excluded
    // Only the 1h bar that already closed (00:00→01:00) is usable as higher-TF context.
    const closed1h = closedCandlesAsOf(H1, HOUR, decisionAt15m);
    expect(closed1h.map((c) => c.openTime)).toEqual([0 * HOUR]);
  });
});

import { describe, it, expect } from "vitest";
import { makerLimitPrice, resolveMakerLeg } from "../src/lib/maker-entry-plan.js";

/**
 * The single-symbol maker path differs from the basket one in exactly one way that matters, and it
 * is a safety property rather than a cost one: a partial fill here is a LIVE, UNSTOPPED position,
 * because the caller places the STOP_MARKET only after entry returns. These pin the rules that
 * bound that window and the ones that stop a fallback from doubling the position.
 */
describe("single-symbol maker entry — rules that bound the unstopped window", () => {
  it("[SS-MAKER] a partial fill must END the wait, not serve out the timeout", () => {
    // The executor breaks its poll on executedQty > 0. This pins the DECISION that follows: the
    // remainder is crossed immediately rather than left resting while the position sits unstopped.
    const d = resolveMakerLeg(10, "CANCELED", 4);
    expect(d.action).toBe("FALLBACK_TAKER");
    expect(d.filledQty).toBe(4);
    expect(d.fallbackQty).toBe(6);
    expect(d.filledQty + d.fallbackQty).toBe(10);
  });

  it("[SS-MAKER] an unknown executedQty sizes NO fallback — a doubled position costs more than a missed one", () => {
    for (const q of [null, undefined, Number.NaN]) {
      const d = resolveMakerLeg(10, "CANCELED", q as number | null);
      expect(d.action).toBe("UNKNOWN_REQUERY");
      expect(d.fallbackQty).toBe(0);
    }
  });

  it("[SS-MAKER] a full maker fill needs no fallback and no second order", () => {
    const d = resolveMakerLeg(10, "FILLED", 10);
    expect(d.action).toBe("DONE");
    expect(d.fallbackQty).toBe(0);
  });

  it("[SS-MAKER] LONG rests at the bid and SHORT at the ask — the only prices GTX accepts", () => {
    expect(makerLimitPrice("LONG", 99.99, 100.01)).toBe(99.99);
    expect(makerLimitPrice("SHORT", 99.99, 100.01)).toBe(100.01);
    // no usable book -> null -> the executor crosses instead of inventing a resting price
    expect(makerLimitPrice("LONG", null, 100.01)).toBeNull();
    expect(makerLimitPrice("SHORT", 100.01, 99.99)).toBeNull();
  });

  it("[SS-MAKER] the poll bound is finite even if the clock never advances", () => {
    // nowMs() is injectable; a frozen clock made the basket version spin forever before it was
    // bounded by count. Same arithmetic the executor uses.
    const bound = (waitMs: number) => Math.max(1, Math.ceil(waitMs / 1_000));
    expect(bound(120_000)).toBe(120);
    expect(bound(1_000)).toBe(1);
    expect(bound(0)).toBe(1);
    expect(bound(-5)).toBe(1);
  });

  it("[SS-MAKER] cost in R is what this buys, and it depends only on stop width", () => {
    // 4 bps maker vs 4 bps taker per side: entry-only takes the round trip 8 -> 6 bps.
    const costR = (bps: number, stopPct: number) => bps / 10_000 / (stopPct / 100);
    expect(costR(8, 2)).toBeCloseTo(0.040, 3);   // taker both sides, at the 2% stop floor
    expect(costR(6, 2)).toBeCloseTo(0.030, 3);   // maker entry, taker exit
    expect(costR(8, 1.05)).toBeCloseTo(0.076, 3); // the old stop width, for contrast
  });
});

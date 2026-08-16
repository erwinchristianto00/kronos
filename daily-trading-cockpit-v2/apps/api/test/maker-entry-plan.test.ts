import { describe, it, expect } from "vitest";
import { makerLimitPrice, resolveMakerLeg, commissionBpsByLiquidity } from "../src/lib/maker-entry-plan.js";
import { buildSubmitRefBase } from "../src/lib/submit-reference-quote.js";

describe("makerLimitPrice", () => {
  it("[MAKER-PX] joins the near touch, which is the only price GTX will accept", () => {
    expect(makerLimitPrice("LONG", 100, 100.1)).toBe(100);   // BUY rests at the bid
    expect(makerLimitPrice("SHORT", 100, 100.1)).toBe(100.1); // SELL rests at the ask
  });

  it("[MAKER-PX] refuses to invent a price from an unusable book", () => {
    // A limit derived from a broken book rests far from the market and never fills; the caller
    // must fall back to its normal taker order instead.
    expect(makerLimitPrice("LONG", null, 100)).toBeNull();
    expect(makerLimitPrice("LONG", 100, null)).toBeNull();
    expect(makerLimitPrice("LONG", 0, 100)).toBeNull();
    expect(makerLimitPrice("LONG", -1, 100)).toBeNull();
    expect(makerLimitPrice("LONG", Number.NaN, 100)).toBeNull();
    expect(makerLimitPrice("SHORT", 100.1, 100)).toBeNull(); // crossed book, transient but real
    expect(makerLimitPrice("SHORT", 100, 100)).toBeNull();   // zero spread: either side would cross
  });
});

describe("resolveMakerLeg", () => {
  it("[MAKER-FILL] a FILLED status is authoritative even when executedQty comes back 0", () => {
    // Binance ACKs do this; the sibling executors already work around it for avgPrice.
    const r = resolveMakerLeg(10, "FILLED", 0);
    expect(r.action).toBe("DONE");
    expect(r.filledQty).toBe(10);
    expect(r.fallbackQty).toBe(0);
  });

  it("[MAKER-FILL] an unfilled cancel crosses for the WHOLE leg", () => {
    const r = resolveMakerLeg(10, "CANCELED", 0);
    expect(r.action).toBe("FALLBACK_TAKER");
    expect(r.filledQty).toBe(0);
    expect(r.fallbackQty).toBe(10);
  });

  it("[MAKER-FILL] a partial cancel crosses for the REMAINDER, never the whole leg", () => {
    // Crossing for the whole leg here would double the position — the expensive direction of the
    // cancel race this module exists to arbitrate.
    const r = resolveMakerLeg(10, "CANCELED", 4);
    expect(r.action).toBe("FALLBACK_TAKER");
    expect(r.filledQty).toBe(4);
    expect(r.fallbackQty).toBe(6);
  });

  it("[MAKER-FILL] a cancel that raced a complete fill books the leg and crosses for nothing", () => {
    // The other direction of the same race: the order filled between the timeout and the cancel.
    const r = resolveMakerLeg(10, "CANCELED", 10);
    expect(r.action).toBe("DONE");
    expect(r.fallbackQty).toBe(0);
    expect(r.filledQty).toBe(10);
  });

  it("[MAKER-UNKNOWN] a dead order with NO executedQty must be re-queried, never guessed", () => {
    // Both convenient guesses are wrong here: assume 0 and the fallback doubles the position,
    // assume full and the basket silently carries a missing leg.
    for (const q of [null, undefined, Number.NaN, -1]) {
      const r = resolveMakerLeg(10, "CANCELED", q as number | null);
      expect(r.action).toBe("UNKNOWN_REQUERY");
      expect(r.fallbackQty).toBe(0);
      expect(r.filledQty).toBe(0);
    }
  });

  it("[MAKER-UNKNOWN] a still-live or unrecognised status never sizes a fallback", () => {
    for (const s of ["NEW", "PARTIALLY_FILLED", "SOMETHING_NEW", "", null, undefined]) {
      const r = resolveMakerLeg(10, s as string | null, 4);
      expect(r.action).toBe("UNKNOWN_REQUERY");
      expect(r.fallbackQty).toBe(0);
    }
  });

  it("[MAKER-FILL] float noise below tolerance counts as complete, a real shortfall does not", () => {
    expect(resolveMakerLeg(10, "CANCELED", 10 - 1e-12).action).toBe("DONE");
    const short = resolveMakerLeg(10, "CANCELED", 9.999);
    expect(short.action).toBe("FALLBACK_TAKER");
    expect(short.fallbackQty).toBeCloseTo(0.001, 12);
  });

  it("[MAKER-FILL] every path conserves quantity: filled + fallback == requested", () => {
    for (const [status, exec] of [["FILLED", 0], ["FILLED", 10], ["CANCELED", 0], ["CANCELED", 3], ["CANCELED", 10], ["EXPIRED", 7], ["REJECTED", 0]] as const) {
      const r = resolveMakerLeg(10, status, exec);
      if (r.action === "UNKNOWN_REQUERY") continue;
      expect(r.filledQty + r.fallbackQty).toBeCloseTo(10, 9);
    }
  });
});

describe("commissionBpsByLiquidity", () => {
  it("[MAKER-BPS] reproduces the measured taker baseline of 4.00 bps/side", () => {
    // Shape of the 231 real fills recorded on testnet: every one maker=false at 4.00 bps.
    const fills = Array.from({ length: 5 }, () => ({ price: 100, qty: 1, commission: 0.04, maker: false }));
    const out = commissionBpsByLiquidity(fills);
    expect(out.taker.bps).toBeCloseTo(4.0, 9);
    expect(out.taker.n).toBe(5);
    expect(out.maker.bps).toBeNull();
  });

  it("[MAKER-BPS] EXCLUDES unreported liquidity flags instead of counting them as taker", () => {
    // `false` is the value we expect, so bucketing unknowns into it would destroy the only thing
    // the flag is for — the whole point is proving maker fills happened, not assuming they didn't.
    const out = commissionBpsByLiquidity([
      { price: 100, qty: 1, commission: 0.016, maker: true },
      { price: 100, qty: 1, commission: 0.04, maker: false },
      { price: 100, qty: 1, commission: 0.04 },
    ]);
    expect(out.maker).toEqual({ n: 1, bps: 1.6 });
    expect(out.taker).toEqual({ n: 1, bps: 4.0 });
    expect(out.unreported).toBe(1);
  });

  it("[MAKER-BPS] weights by notional, not by fill count", () => {
    // One big fill and one tiny fill must not each count for half.
    const out = commissionBpsByLiquidity([
      { price: 100, qty: 99, commission: 0.99, maker: true },   // 1.0 bps on $9,900
      { price: 100, qty: 1, commission: 0.10, maker: true },    // 10.0 bps on $100
    ]);
    expect(out.maker.bps).toBeCloseTo((1.09 / 10000) * 10000, 6);
    expect(out.maker.bps).toBeLessThan(2); // notional-weighted, nowhere near the 5.5 a mean-of-bps gives
  });

  it("[MAKER-BPS] an empty or unusable set yields null, never NaN or a fabricated zero", () => {
    expect(commissionBpsByLiquidity([]).taker.bps).toBeNull();
    expect(commissionBpsByLiquidity([{ price: 0, qty: 1, commission: 1, maker: false }]).taker.bps).toBeNull();
  });
});

describe("submit-time quote freshness — the rule that made maker entry inert", () => {
  const quote = (atMs: number) => ({ bid: 99.99, ask: 100.01, mid: 100, atMs, venue: "BINANCE_USDM_BOOK_TICKER" });

  it("[QUOTE-AGE] a quote warmed BEFORE the observe-start is rejected, and that is correct", () => {
    // buildSubmitRefBase's own rule: atMs < observeStartMs means the quote cannot belong to this
    // submission. Sound on its own — the bug was a CALLER re-reading the clock after the warm.
    expect(buildSubmitRefBase(quote(1_000), 2_000, "SHORT")).toBeNull();
  });

  it("[QUOTE-AGE] a quote warmed AFTER the observe-start is accepted with both sides", () => {
    // This is the shape preplaceMakerLegs must produce: observe-start taken by the caller BEFORE
    // the warm, so the warmed quote is newer and a post-only price can be derived from it.
    const ref = buildSubmitRefBase(quote(2_000), 1_000, "SHORT");
    expect(ref).not.toBeNull();
    expect(ref!.bid).toBe(99.99);
    expect(ref!.ask).toBe(100.01);
    expect(makerLimitPrice("SHORT", ref!.bid, ref!.ask)).toBe(100.01);
    expect(makerLimitPrice("LONG", ref!.bid, ref!.ask)).toBe(99.99);
  });

  it("[QUOTE-AGE] no quote means no maker price — the leg must cross, never guess one", () => {
    expect(buildSubmitRefBase(null, 1_000, "SHORT")).toBeNull();
    expect(makerLimitPrice("SHORT", null, null)).toBeNull();
  });
});

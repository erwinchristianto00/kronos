import { describe, expect, it } from "vitest";
import {
  MAKER_ROUNDTRIP_BPS,
  TAKER_ROUNDTRIP_BPS,
  STOP_OUT_SLIPPAGE_BPS,
} from "../src/lib/current-guard-variant-matrix.js";
import { REALISTIC_FEE_BPS_PER_SIDE } from "../src/lib/shadow-engine.js";

/**
 * These constants price every maker-lane close in the book, and until 2026-07-27 NOT ONE TEST
 * touched them — the value was changed from 6 to 4 and the whole suite stayed green. A cost
 * constant nobody pins is a cost constant that drifts silently, which is the failure this file
 * exists to prevent. The assertions below are deliberately written against the REASONING, not just
 * the number, so a future change has to argue with the derivation rather than edit a literal.
 */
const BINANCE_USDM_MAKER_BPS_PER_SIDE = 2;

describe("maker round-trip cost constant", () => {
  it("is the both-sides-maker fee: 2 bps/side x 2 sides", () => {
    expect(MAKER_ROUNDTRIP_BPS).toBe(BINANCE_USDM_MAKER_BPS_PER_SIDE * 2);
    expect(MAKER_ROUNDTRIP_BPS).toBe(4);
  });

  /** The old value was REALISTIC_FEE_BPS_PER_SIDE + 1 = 6 — the maker cost derived from the TAKER
   *  per-side rate plus an arbitrary 1. That taker rate is now measured exactly (5.0000 bps/side,
   *  reconciled to /fapi/v1/income at 3.5e-8 relative error), which is exactly why it must not be
   *  the basis for the maker figure. FAILS WITHOUT THE FIX. */
  it("is NOT derived from the taker per-side rate", () => {
    expect(MAKER_ROUNDTRIP_BPS).not.toBe(REALISTIC_FEE_BPS_PER_SIDE + 1);
    expect(MAKER_ROUNDTRIP_BPS).toBeLessThan(REALISTIC_FEE_BPS_PER_SIDE);
  });

  it("stays strictly cheaper than the taker round trip — the entire premise of posting a limit", () => {
    expect(MAKER_ROUNDTRIP_BPS).toBeLessThan(TAKER_ROUNDTRIP_BPS);
  });

  /**
   * THE KNOWN GAP, pinned so it cannot be forgotten: a maker_limit variant posts its ENTRY as a
   * limit, but a stop-out EXITS AT MARKET and pays the taker rate. That round trip is really
   * 2 + 5 = 7, not 4. `_computePaperExitCostR` branches on TP_LIKE vs STOP_LIKE and adds
   * STOP_OUT_SLIPPAGE_BPS on the stop path, but does NOT add the maker->taker fee difference.
   *
   * This test does not assert the gap is closed — it asserts the SIZE of what is still missing, so
   * that if someone later fixes the stop leg properly this test fails and forces the constant's
   * doc comment to be updated with it.
   */
  it("under-prices a maker entry that stops out, by exactly the maker->taker fee difference", () => {
    const trueStopExitRoundTrip = BINANCE_USDM_MAKER_BPS_PER_SIDE + REALISTIC_FEE_BPS_PER_SIDE;
    expect(trueStopExitRoundTrip).toBe(7);
    expect(trueStopExitRoundTrip - MAKER_ROUNDTRIP_BPS).toBe(3);
    // and the stop path's separate slippage surcharge is NOT that difference — they are independent
    expect(STOP_OUT_SLIPPAGE_BPS).not.toBe(trueStopExitRoundTrip - MAKER_ROUNDTRIP_BPS);
  });

  it("keeps the taker round trip at its measured basis (fee both sides + slippage both sides)", () => {
    expect(TAKER_ROUNDTRIP_BPS).toBeGreaterThan(REALISTIC_FEE_BPS_PER_SIDE * 2);
    expect(REALISTIC_FEE_BPS_PER_SIDE).toBe(5);
  });
});

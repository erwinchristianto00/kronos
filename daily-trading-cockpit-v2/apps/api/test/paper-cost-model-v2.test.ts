import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  paperExitCostRV2, paperFundingCostR, slipAlreadyInGrossBps, PAPER_FUNDING_BPS_PER_8H,
} from "../src/lib/paper-cost-model-v2.js";

/**
 * The v2 cost arithmetic, extracted from paper-execution-router.ts so live/3103 — whose router is
 * ~977 lines behind canonical and cannot take the file wholesale — can charge the IDENTICAL cost.
 * The alternative was duplicating the formula into live, which is worse than leaving it unported:
 * two copies that must agree exactly, or the cohorts diverge silently and every cross-instance cost
 * comparison becomes a lie rather than an obvious bug.
 */
const REF = {
  stopBps: 300, costModel: "taker" as const,
  takerRoundTripBps: 22, makerRoundTripBps: 4, realisticFeeBpsPerSide: 5, stopOutSlippageBps: 12,
};
const ENTRY_SLIP = 3, TP_SLIP = 2, STOP_SLIP = 4;

describe("the exit kind changes the charge, which no flat model can do", () => {
  const cost = (kind: "TP_LIKE" | "STOP_LIKE" | "MARK_TO_MARKET") =>
    paperExitCostRV2({ ...REF, kind, slipAlreadyInGrossBps: slipAlreadyInGrossBps(kind, ENTRY_SLIP, TP_SLIP, STOP_SLIP) });

  it("matches the router's reference geometry exactly", () => {
    expect(cost("STOP_LIKE")).toBeCloseTo(-(22 + 12 - (3 + 4)) / 300, 9); // -27/300
    expect(cost("TP_LIKE")).toBeCloseTo(-(22 - (3 + 2)) / 300, 9); // -20/300
    expect(cost("MARK_TO_MARKET")).toBeCloseTo(-(22 - (3 + 4)) / 300, 9); // -15/300
  });

  /** Impossible to satisfy with any flat cost model — this is the property v2 exists for. */
  it("a stop always costs strictly more than a TP on the same geometry", () => {
    expect(cost("STOP_LIKE")).toBeLessThan(cost("TP_LIKE"));
  });

  /** THE TRAP that caught the first draft of this module. MARK_TO_MARKET nets out the STOP
   *  slippage, not the TP one — it exits at a candle close with no resting limit protecting it.
   *  Inverting it silently moves the MTM charge from 15bps to 20bps. */
  it("MARK_TO_MARKET nets out the STOP slippage, not the TP slippage", () => {
    expect(slipAlreadyInGrossBps("MARK_TO_MARKET", ENTRY_SLIP, TP_SLIP, STOP_SLIP)).toBe(ENTRY_SLIP + STOP_SLIP);
    expect(slipAlreadyInGrossBps("STOP_LIKE", ENTRY_SLIP, TP_SLIP, STOP_SLIP)).toBe(ENTRY_SLIP + STOP_SLIP);
    expect(slipAlreadyInGrossBps("TP_LIKE", ENTRY_SLIP, TP_SLIP, STOP_SLIP)).toBe(ENTRY_SLIP + TP_SLIP);
  });

  it("but MARK_TO_MARKET pays NO stop-out surcharge — nothing was triggered", () => {
    expect(cost("MARK_TO_MARKET")).toBeGreaterThan(cost("STOP_LIKE"));
  });
});

describe("maker is cheaper than taker, and the floor cannot be defeated", () => {
  it("a maker round-trip costs a fraction of a taker one", () => {
    const maker = paperExitCostRV2({ ...REF, costModel: "maker_limit", kind: "TP_LIKE", slipAlreadyInGrossBps: 0 });
    const taker = paperExitCostRV2({ ...REF, kind: "TP_LIKE", slipAlreadyInGrossBps: 0 });
    expect(maker).toBeCloseTo(-4 / 300, 9);
    expect(maker).toBeGreaterThan(taker);
  });

  /** THE GUARD: an over-configured slippage setting may reduce the modeled cost but must never
   *  erase it. Without the floor this returns 0 — a free round trip. */
  it("absurd slippage cannot drive the charge to zero", () => {
    const c = paperExitCostRV2({ ...REF, kind: "TP_LIKE", slipAlreadyInGrossBps: 10_000 });
    expect(c).toBeCloseTo(-(5 * 2) / 300, 9); // floored at fee-only, both sides
    expect(c).toBeLessThan(0);
  });

  it("no risk unit means no fabricated charge", () => {
    expect(paperExitCostRV2({ ...REF, stopBps: 0, kind: "TP_LIKE", slipAlreadyInGrossBps: 0 })).toBe(0);
    expect(paperExitCostRV2({ ...REF, stopBps: -1, kind: "TP_LIKE", slipAlreadyInGrossBps: 0 })).toBe(0);
  });
});

describe("funding charges completed periods only", () => {
  const H = 3_600_000;
  it("charges each completed 8h period", () => {
    expect(paperFundingCostR(300, 0, 8 * H)).toBeCloseTo(-PAPER_FUNDING_BPS_PER_8H / 300, 9);
    expect(paperFundingCostR(300, 0, 24 * H)).toBeCloseTo(-(3 * PAPER_FUNDING_BPS_PER_8H) / 300, 9);
  });

  /** Venues settle funding at discrete times. Prorating a partial period would invent a cost that
   *  was never incurred — a position closed at 7h59m has genuinely paid nothing. */
  it("does NOT prorate a partial period", () => {
    expect(paperFundingCostR(300, 0, 8 * H - 1)).toBe(0);
    expect(paperFundingCostR(300, 0, 15 * H)).toBeCloseTo(-PAPER_FUNDING_BPS_PER_8H / 300, 9);
  });

  it("returns 0 rather than guessing when a timestamp is missing or impossible", () => {
    expect(paperFundingCostR(300, null, 24 * H)).toBe(0);
    expect(paperFundingCostR(300, 0, null)).toBe(0);
    expect(paperFundingCostR(300, 0, Number.NaN)).toBe(0);
    expect(paperFundingCostR(300, 24 * H, 8 * H)).toBe(0); // exit before open
  });

  it("is added on TOP of the floored round-trip, not folded inside it", () => {
    const floored = paperExitCostRV2({ ...REF, kind: "TP_LIKE", slipAlreadyInGrossBps: 10_000, openedAtMs: 0, exitAtMs: 24 * H });
    expect(floored).toBeCloseTo(-(5 * 2) / 300 - (3 * PAPER_FUNDING_BPS_PER_8H) / 300, 9);
  });
});

describe("[FUNDING-GRID] funding follows the venue's fixed UTC grid, not time-since-open", () => {
  const H = 3_600_000;
  const DAY = 24 * H;
  // A day boundary in ms is grid-aligned by construction (the epoch is 00:00 UTC and 8h divides
  // 24h), so `base + 7h58m` sits 2 minutes before a REAL 08:00 UTC settlement.
  const base = 20_000 * DAY;

  /**
   * The case the old `floor((exit - open) / 8h)` form got wrong. A position opened at 07:58 UTC and
   * closed at 08:05 UTC is held across one real funding settlement and pays for it; measuring 8h
   * blocks from the open scored `floor(7min / 8h) = 0` and charged nothing.
   */
  it("charges a 7-minute hold that straddles a settlement", () => {
    const cost = paperFundingCostR(300, base + 7 * H + 58 * 60_000, base + 8 * H + 5 * 60_000);
    expect(cost).toBeCloseTo(-PAPER_FUNDING_BPS_PER_8H / 300, 9);
    // The elapsed-time form would have returned exactly 0 here.
    expect(cost).not.toBe(0);
  });

  /** The mirror case: a hold nearly 8h long that crosses NO settlement is still free. Length alone
   *  decides nothing — only how many settlement instants the position spanned. */
  it("charges nothing for an equally long hold that crosses no settlement", () => {
    expect(paperFundingCostR(300, base + 8 * H + 1000, base + 15 * H)).toBe(0);
  });

  /** Old and new agree whenever the open happens to be phase-aligned, which is why every
   *  pre-existing funding test (all opening at the epoch) kept passing through this change. */
  it("still matches the elapsed-time answer when the open IS grid-aligned", () => {
    expect(paperFundingCostR(300, base, base + 24 * H)).toBeCloseTo(-(3 * PAPER_FUNDING_BPS_PER_8H) / 300, 9);
  });

  /** Boundary convention: a settlement exactly at the open is not held across; one exactly at the
   *  exit is. Stated explicitly so it cannot drift into an off-by-one later. */
  it("excludes a settlement at the open instant and includes one at the exit instant", () => {
    expect(paperFundingCostR(300, base, base + 8 * H - 1)).toBe(0);
    expect(paperFundingCostR(300, base, base + 8 * H)).toBeCloseTo(-PAPER_FUNDING_BPS_PER_8H / 300, 9);
  });
});

describe("[MAKER-STOP] a maker lane exits at market on a stop, and pays the taker rate to do it", () => {
  const maker = (kind: "TP_LIKE" | "STOP_LIKE" | "MARK_TO_MARKET") =>
    paperExitCostRV2({ ...REF, costModel: "maker_limit", kind, slipAlreadyInGrossBps: 0 });

  /**
   * A maker_limit order posts its ENTRY as a resting limit, but only a TP LIMIT fill exits as maker.
   * A stop-out leaves at market and pays the 5bps taker rate, so the round trip is 2 + 5 = 7, not 4.
   * Both roundTrip AND the fee floor used to be pinned to the all-maker constant, so the Math.max
   * floor could not catch the shortfall: the most a maker stop-out could ever be charged was
   * 4 + 12 = 16bps against a real 19bps — a fixed 3bps/stopBps undercharge on every maker-lane LOSS,
   * i.e. the same flatter-the-low-win-rate-lane asymmetry STOP_OUT_SLIPPAGE_BPS exists to remove.
   */
  it("charges maker-in/taker-out plus the stop-out surcharge on a stop", () => {
    expect(maker("STOP_LIKE")).toBeCloseTo(-(2 + 5 + 12) / 300, 9); // 19/300, was 16/300
  });

  it("leaves the all-maker basis on a TP, where both legs really are maker", () => {
    expect(maker("TP_LIKE")).toBeCloseTo(-4 / 300, 9);
  });

  /** An MTM horizon close also exits at market — no resting limit protects it — so it carries the
   *  taker exit fee too, while still paying NO stop-out surcharge (nothing was triggered). */
  it("charges the taker exit on a mark-to-market close, but no stop-out surcharge", () => {
    expect(maker("MARK_TO_MARKET")).toBeCloseTo(-(2 + 5) / 300, 9);
  });

  /** The floor must track the same basis, or it silently re-introduces the undercharge whenever
   *  configured slippage is large enough to bind. */
  it("floors a maker stop at the maker-in/taker-out fee, not at the all-maker fee", () => {
    const overSlipped = paperExitCostRV2({
      ...REF, costModel: "maker_limit", kind: "STOP_LIKE", slipAlreadyInGrossBps: 10_000,
    });
    expect(overSlipped).toBeCloseTo(-(2 + 5) / 300, 9); // floor binds at 7, not at 4
  });

  it("keeps a maker stop strictly cheaper than the taker equivalent", () => {
    const takerStop = paperExitCostRV2({ ...REF, kind: "STOP_LIKE", slipAlreadyInGrossBps: 0 });
    expect(maker("STOP_LIKE")).toBeGreaterThan(takerStop); // less negative
  });
});

describe("it stays portable to an older instance", () => {
  /** The whole reason this file exists. An import here would drag live's missing dependency graph
   *  back in and the port would stall again. */
  it("imports nothing", () => {
    const src = readFileSync(new URL("../src/lib/paper-cost-model-v2.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

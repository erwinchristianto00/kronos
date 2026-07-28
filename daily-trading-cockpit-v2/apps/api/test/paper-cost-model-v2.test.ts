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

describe("it stays portable to an older instance", () => {
  /** The whole reason this file exists. An import here would drag live's missing dependency graph
   *  back in and the port would stall again. */
  it("imports nothing", () => {
    const src = readFileSync(new URL("../src/lib/paper-cost-model-v2.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

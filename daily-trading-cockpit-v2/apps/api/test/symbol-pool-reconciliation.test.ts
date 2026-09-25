import { describe, it, expect } from "vitest";
import { poolReconciliationPlan, type PoolSymbolReading, type PoolThresholds } from "../src/lib/symbol-pool-reconciliation.js";

const TH: PoolThresholds = {
  minLiquidityUsdPerHour: 200_000,
  maxOneLotUsd: 8.75,
  hysteresisFraction: 0.10, // enter >= 220k, leave < 180k
  minPoolSize: 8,
};
const sym = (o: Partial<PoolSymbolReading> & { symbol: string }): PoolSymbolReading => ({
  liquidityUsdPerHour: 500_000, oneLotUsd: 1, inPool: true, ...o,
});
/** A healthy pool of n symbols, so min-size never masks the behaviour under test. */
const filler = (n: number) => Array.from({ length: n }, (_, i) => sym({ symbol: `F${i}USDT` }));

describe("poolReconciliationPlan — hysteresis", () => {
  it("[POOL-HYST] WIF at 0.44% below the floor is HELD, not dropped", () => {
    // The real case that prompted this: $199,118 against a $200,000 floor. A hard threshold would
    // drop it today and re-add it tomorrow, rewriting the pool the overlap guard compares against
    // every few hours.
    const plan = poolReconciliationPlan(
      [...filler(19), sym({ symbol: "WIFUSDT", liquidityUsdPerHour: 199_118, oneLotUsd: 5 })],
      TH,
    );
    const d = plan.decisions.find((x) => x.symbol === "WIFUSDT")!;
    expect(d.action).toBe("HOLD_BAND");
    expect(plan.drops).not.toContain("WIFUSDT");
    expect(plan.changed).toBe(false);
    expect(plan.heldDespiteFailure.map((x) => x.symbol)).toContain("WIFUSDT");
  });

  it("[POOL-HYST] a symbol genuinely below the exit band IS dropped", () => {
    const plan = poolReconciliationPlan(
      [...filler(19), sym({ symbol: "DEADUSDT", liquidityUsdPerHour: 120_000 })],
      TH,
    );
    expect(plan.drops).toEqual(["DEADUSDT"]);
    expect(plan.changed).toBe(true);
    expect(plan.proposedPool).not.toContain("DEADUSDT");
  });

  it("[POOL-HYST] entering needs MORE than leaving needs — that gap is the whole point", () => {
    // 210k: above the floor, below the entry band. In -> stays in. Out -> stays out. The same
    // reading gives opposite memberships, which is what stops the flapping.
    const inPool = poolReconciliationPlan([...filler(19), sym({ symbol: "XUSDT", liquidityUsdPerHour: 210_000 })], TH);
    const outPool = poolReconciliationPlan([...filler(19), sym({ symbol: "XUSDT", liquidityUsdPerHour: 210_000, inPool: false })], TH);
    expect(inPool.decisions.find((d) => d.symbol === "XUSDT")!.action).toBe("HOLD_BAND");
    expect(outPool.decisions.find((d) => d.symbol === "XUSDT")!.action).toBe("KEEP");
    expect(inPool.changed).toBe(false);
    expect(outPool.changed).toBe(false);
  });

  it("[POOL-HYST] a symbol clearing the entry band IS added", () => {
    const plan = poolReconciliationPlan([...filler(20), sym({ symbol: "NEWUSDT", liquidityUsdPerHour: 250_000, inPool: false })], TH);
    expect(plan.adds).toEqual(["NEWUSDT"]);
    expect(plan.proposedPool).toContain("NEWUSDT");
  });

  it("[POOL-HYST] zero hysteresis reproduces the old flapping behaviour exactly", () => {
    // Kept as an explicit escape hatch, and pinned so nobody assumes the band is unavoidable.
    const plan = poolReconciliationPlan(
      [...filler(19), sym({ symbol: "WIFUSDT", liquidityUsdPerHour: 199_118 })],
      { ...TH, hysteresisFraction: 0 },
    );
    expect(plan.drops).toEqual(["WIFUSDT"]);
  });
});

describe("poolReconciliationPlan — the guards that stop it doing harm", () => {
  it("[POOL-GUARD] a symbol with an OPEN position is never dropped", () => {
    // Pulling a symbol out from under a live position turns a pool edit into an execution event.
    const plan = poolReconciliationPlan(
      [...filler(19), sym({ symbol: "OPENUSDT", liquidityUsdPerHour: 50_000, hasOpenPosition: true })],
      TH,
    );
    expect(plan.drops).toEqual([]);
    expect(plan.decisions.find((d) => d.symbol === "OPENUSDT")!.action).toBe("HOLD_OPEN");
    expect(plan.heldDespiteFailure.map((x) => x.symbol)).toContain("OPENUSDT");
  });

  it("[POOL-GUARD] the pool is never starved below minPoolSize, worst liquidity dropped first", () => {
    // 9 in pool, 3 failing, floor 8 -> only the single worst may go.
    const readings = [
      ...filler(6),
      sym({ symbol: "AUSDT", liquidityUsdPerHour: 100_000 }),
      sym({ symbol: "BUSDT", liquidityUsdPerHour: 50_000 }),
      sym({ symbol: "CUSDT", liquidityUsdPerHour: 20_000 }),
    ];
    const plan = poolReconciliationPlan(readings, TH);
    expect(plan.drops).toEqual(["CUSDT"]); // the worst, and only one
    expect(plan.proposedPool).toHaveLength(8);
    const held = plan.heldDespiteFailure.map((x) => x.symbol);
    expect(held).toContain("AUSDT");
    expect(held).toContain("BUSDT");
  });

  it("[POOL-GUARD] min-size can only cancel drops, never invent an add", () => {
    // A tiny failing pool must not be topped up with symbols the criteria reject.
    const plan = poolReconciliationPlan(
      [sym({ symbol: "AUSDT", liquidityUsdPerHour: 10_000 }), sym({ symbol: "BUSDT", liquidityUsdPerHour: 10_000, inPool: false })],
      TH,
    );
    expect(plan.adds).toEqual([]);
    expect(plan.proposedPool).toEqual(["AUSDT"]);
  });

  it("[POOL-GUARD] an unmeasured symbol is HELD, and an all-unmeasured read is flagged", () => {
    // A failed exchange read is not evidence against a symbol; treating it as one would empty the
    // pool during an outage.
    const plan = poolReconciliationPlan(
      [sym({ symbol: "AUSDT", liquidityUsdPerHour: null }), sym({ symbol: "BUSDT", oneLotUsd: null })],
      TH,
    );
    expect(plan.drops).toEqual([]);
    expect(plan.unmeasured).toBe(true);
    expect(plan.proposedPool).toEqual(["AUSDT", "BUSDT"]);
  });

  it("[POOL-GUARD] an oversized lot has NO hysteresis — it is arithmetic, not a rolling measure", () => {
    const plan = poolReconciliationPlan([...filler(19), sym({ symbol: "BTCUSDT", oneLotUsd: 63.07 })], TH);
    expect(plan.drops).toEqual(["BTCUSDT"]);
  });

  it("[POOL-GUARD] a pool already matching the criteria proposes no change at all", () => {
    const plan = poolReconciliationPlan(filler(20), TH);
    expect(plan.changed).toBe(false);
    expect(plan.adds).toEqual([]);
    expect(plan.drops).toEqual([]);
  });
});

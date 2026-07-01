import { describe, it, expect } from "vitest";
import type { BacktestBar, MarketContext } from "../src/trading/index.js";
import { runBacktest, rejectStrategy, runBacktestCostScenarios, walkForwardBacktest } from "../src/trading/index.js";

const MIN = 60_000;

// A context that triggers SHORT_RALLY_FADE in bearish-chop. The sim overwrites
// the governance counters (dailyLossPct/consecutiveLosses/openPositions/tradesToday).
function fadeCtx(): MarketContext {
  return {
    dailyLossPct: 0,
    consecutiveLosses: 0,
    spreadBps: 2,
    slippageBps: 2,
    liquidityGood: true,
    fundingRiskAbnormal: false,
    regimeConfidence: 0.9,
    openPositions: 0,
    tradesToday: 0,
    btcBelow60000: true,
    btcBelowKeyResistance: true,
    pricePullbackToVWAPOrEMA20: true,
    rsi1h: 62,
    rejectionCandle: true,
    volumeWeakOnBounce: true,
    marketBreadthWeak: true,
  };
}

// A context that never trades (NO_TRADE regime).
function flatCtx(): MarketContext {
  return {
    dailyLossPct: 0,
    consecutiveLosses: 0,
    spreadBps: 2,
    slippageBps: 2,
    liquidityGood: true,
    fundingRiskAbnormal: false,
    regimeConfidence: 0.9,
    openPositions: 0,
    tradesToday: 0,
  };
}

// entry bar (short-fade signal) followed by a follow-through bar that resolves it.
function shortPair(t0: number, resolve: "TP" | "SL"): BacktestBar[] {
  const entry: BacktestBar = {
    timestamp: t0,
    ctx: fadeCtx(),
    price: 100,
    high: 100.5,
    low: 99.5,
    atr: 1,
  };
  // short: TP ≈ 99.48 (entry-0.5), SL ≈ 100.68 (entry+0.7) after ~2bps entry slippage.
  // TP bar keeps its high below entry (~99.98) so the breakeven ratchet — armed by
  // the favorable low — is not itself tripped intrabar by a wick back up.
  const exit: BacktestBar =
    resolve === "TP"
      ? { timestamp: t0 + MIN, ctx: flatCtx(), price: 99.3, high: 99.9, low: 99.2, atr: 1 }
      : { timestamp: t0 + MIN, ctx: flatCtx(), price: 101, high: 101.2, low: 100.5, atr: 1 };
  return [entry, exit];
}

describe("runBacktest", () => {
  it("simulates a winning short-fade trade with honest costs", () => {
    const m = runBacktest({ bars: shortPair(0, "TP"), startingEquity: 10_000 });
    expect(m.numTrades).toBe(1);
    const t = m.trades[0]!;
    expect(t.action).toBe("ENTER_SHORT");
    expect(t.lane).toBe("SHORT_RALLY_FADE");
    expect(t.exitReason).toBe("TP");
    expect(t.netPnl).toBeGreaterThan(0);
    expect(m.totalReturn).toBeGreaterThan(0);
    expect(m.feeImpact).toBeGreaterThan(0);
    expect(m.slippageImpact).toBeGreaterThan(0);
    expect(m.spreadImpact).toBe(0);
    expect(m.shortPerformanceByRegime.BEARISH_CHOPPY_DEFENSIVE?.trades).toBe(1);
  });

  it("simulates a losing short-fade trade (stop hit)", () => {
    const m = runBacktest({ bars: shortPair(0, "SL"), startingEquity: 10_000 });
    expect(m.numTrades).toBe(1);
    expect(m.trades[0]!.exitReason).toBe("SL");
    expect(m.trades[0]!.netPnl).toBeLessThan(0);
    expect(m.totalReturn).toBeLessThan(0);
  });

  it("counts no-trade days and opens nothing on flat context", () => {
    const bars: BacktestBar[] = [
      { timestamp: 0, ctx: flatCtx(), price: 100, high: 100.2, low: 99.8, atr: 1 },
      { timestamp: MIN, ctx: flatCtx(), price: 100, high: 100.2, low: 99.8, atr: 1 },
    ];
    const m = runBacktest({ bars, startingEquity: 10_000 });
    expect(m.numTrades).toBe(0);
    expect(m.noTradeDays).toBe(1);
  });

  it("enforces the loss cooldown: a valid setup right after a loss is skipped", () => {
    // loss pair on day, then an immediate fade setup one minute later — inside the
    // 180-min two-loss / 45-min single-loss cooldown, so no second trade opens.
    const loss = shortPair(0, "SL");
    const immediate: BacktestBar = { timestamp: 2 * MIN, ctx: fadeCtx(), price: 100, high: 100.5, low: 99.5, atr: 1 };
    const m = runBacktest({ bars: [...loss, immediate], startingEquity: 10_000, respectCooldowns: true });
    expect(m.numTrades).toBe(1); // only the first (losing) trade
  });

  it("runs optimistic/base/pessimistic cost scenarios with increasingly brutal costs", () => {
    const results = runBacktestCostScenarios({
      bars: shortPair(0, "TP"),
      startingEquity: 10_000,
    });

    expect(Object.keys(results).sort()).toEqual(["base", "optimistic", "pessimistic"]);
    expect(results.base.feeImpact).toBeGreaterThan(results.optimistic.feeImpact);
    expect(results.pessimistic.feeImpact).toBeGreaterThan(results.base.feeImpact);
    expect(results.base.spreadImpact).toBeGreaterThan(results.optimistic.spreadImpact);
    expect(results.pessimistic.spreadImpact).toBeGreaterThan(results.base.spreadImpact);
    expect(results.base.slippageImpact).toBeGreaterThan(results.optimistic.slippageImpact);
    expect(results.pessimistic.slippageImpact).toBeGreaterThan(results.base.slippageImpact);
    expect(results.base.fundingImpact).toBeGreaterThan(0);
    expect(results.pessimistic.fundingImpact).toBeGreaterThan(results.base.fundingImpact);
  });
});

describe("rejectStrategy", () => {
  it("rejects a book of pure losses on profit factor", () => {
    // three losing pairs spaced beyond cooldown (>180 min apart) so each trades.
    const bars = [
      ...shortPair(0, "SL"),
      ...shortPair(200 * MIN, "SL"),
      ...shortPair(400 * MIN, "SL"),
    ];
    const m = runBacktest({ bars, startingEquity: 10_000, respectCooldowns: true });
    expect(m.numTrades).toBeGreaterThanOrEqual(1);
    const r = rejectStrategy(m);
    expect(r.rejected).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("PROFIT_FACTOR_BELOW"))).toBe(true);
  });

  it("rejects a strategy that never traded (unproven)", () => {
    const m = runBacktest({
      bars: [{ timestamp: 0, ctx: flatCtx(), price: 100, high: 100.1, low: 99.9, atr: 1 }],
      startingEquity: 10_000,
    });
    const r = rejectStrategy(m);
    expect(r.rejected).toBe(true);
    expect(r.reasons).toContain("NO_TRADES");
  });

  it("accepts a clean winner that clears the profit-factor floor", () => {
    // two wins spaced beyond cooldown → PF is Infinity (no losses) ≥ 1.2.
    const bars = [...shortPair(0, "TP"), ...shortPair(200 * MIN, "TP")];
    const m = runBacktest({ bars, startingEquity: 10_000, respectCooldowns: true });
    const r = rejectStrategy(m, { chopDays: 1, maxChopTradesPerDay: 10 });
    expect(r.rejected).toBe(false);
  });
});

describe("walkForwardBacktest", () => {
  it("flags single-period dependence when only one fold is profitable", () => {
    // fold 1 wins, folds 2-4 lose → 1 profitable fold of 4 → curve-fit risk.
    const bars = [
      ...shortPair(0, "TP"),
      ...shortPair(200 * MIN, "SL"),
      ...shortPair(400 * MIN, "SL"),
      ...shortPair(600 * MIN, "SL"),
    ];
    const wf = walkForwardBacktest({ bars, startingEquity: 10_000, respectCooldowns: true }, 4);
    expect(wf.folds.length).toBe(4);
    expect(wf.profitableFolds).toBe(1);
    expect(wf.singlePeriodDependence).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import type { FeatureAdapterInput } from "../src/trading/index.js";
import {
  breadthFromCandles,
  contextFromCandles,
  detectContradictions,
  buildTradingDecision,
} from "../src/trading/index.js";

const HOUR = 3_600_000;

// Build a synthetic candle series from a list of closes (flat-ish OHLC around each close).
function series(closes: number[], startTs: number, stepMs: number, volume = 1000): Candle[] {
  return closes.map((close, i) => ({
    openTime: startTs + i * stepMs,
    open: i === 0 ? close : closes[i - 1]!,
    high: Math.max(close, i === 0 ? close : closes[i - 1]!) * 1.001,
    low: Math.min(close, i === 0 ? close : closes[i - 1]!) * 0.999,
    close,
    volume,
  }));
}

// A descending BTC series that ends below 60k (bearish).
function bearishBtc(asOf: number) {
  const closesH1 = Array.from({ length: 40 }, (_, i) => 61_000 - i * 60); // 61000 → ~58,660
  const closesH4 = Array.from({ length: 20 }, (_, i) => 61_500 - i * 120);
  const closesD1 = Array.from({ length: 10 }, (_, i) => 62_000 - i * 300);
  return {
    m15: series(Array.from({ length: 40 }, (_, i) => 60_000 - i * 20), asOf - 40 * 15 * 60_000, 15 * 60_000),
    h1: series(closesH1, asOf - 40 * HOUR, HOUR),
    h4: series(closesH4, asOf - 20 * 4 * HOUR, 4 * HOUR),
    d1: series(closesD1, asOf - 10 * 24 * HOUR, 24 * HOUR),
  };
}

function microstructure(overrides: Partial<FeatureAdapterInput["microstructure"]> = {}) {
  return { spreadBps: 2, slippageBps: 2, liquidityGood: true, fundingRiskAbnormal: false, ...overrides };
}
function governance(overrides: Partial<FeatureAdapterInput["governance"]> = {}) {
  return { dailyLossPct: 0, consecutiveLosses: 0, openPositions: 0, tradesToday: 0, ...overrides };
}
const nearLevelDistancePct = (price: number, level: number) => Math.abs(price - level) / level;

describe("contextFromCandles", () => {
  const asOf = 2_000_000_000_000;

  it("derives bearish price-level flags from a descending BTC series", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      microstructure: microstructure(),
      governance: governance(),
    });
    expect(ctx.btcBelow60000).toBe(true);
    expect(ctx.btcBelow62000).toBe(true);
    expect(ctx.btcClose4hAbove62000).toBe(false);
    expect(ctx.btcCloseDailyAbove65000).toBe(false);
    // Above 55k → not breaking major support, and NOT flagged as a 55k break.
    expect(ctx.btcNotBreakingMajorSupport).toBe(true);
    expect(ctx.btcBreaksBelow55000).toBeUndefined();
    // required governance passthrough
    expect(ctx.spreadBps).toBe(2);
    expect(ctx.dailyLossPct).toBe(0);
  });

  it("computes RSI, populates freshness, and self-consistency (no contradictions)", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      microstructure: microstructure(),
      governance: governance(),
    });
    expect(typeof ctx.rsi1h).toBe("number");
    expect(ctx.asOf).toBe(asOf);
    expect(ctx.freshness?.some((f) => f.timeframe === "1h")).toBe(true);
    expect(ctx.featureSources?.retestFailed).toEqual(["1h"]);
    expect(ctx.featureSources?.btcClose4hAbove62000).toEqual(["4h"]);
    // The adapter must never emit a contradictory pair from clean, consistent data.
    expect(detectContradictions(ctx)).toEqual([]);
  });

  it("ignores future or unfinished candles before deriving flags", () => {
    const btc = bearishBtc(asOf);
    const baseCtx = contextFromCandles({
      asOf,
      btc,
      microstructure: microstructure(),
      governance: governance(),
    });

    const futureSpike = {
      openTime: asOf,
      open: 58_000,
      high: 80_000,
      low: 57_000,
      close: 78_000,
      volume: 100_000,
    };
    const withUnclosed = contextFromCandles({
      asOf,
      btc: {
        ...btc,
        h1: [...btc.h1, futureSpike],
      },
      microstructure: microstructure(),
      governance: governance(),
    });

    expect(withUnclosed.btcBelow60000).toBe(baseCtx.btcBelow60000);
    expect(withUnclosed.btcBelow62000).toBe(baseCtx.btcBelow62000);
    expect(withUnclosed.rsi1h).toBe(baseCtx.rsi1h);
    expect(withUnclosed.freshness?.find((f) => f.timeframe === "1h")?.lastCandleCloseMs).toBe(
      baseCtx.freshness?.find((f) => f.timeframe === "1h")?.lastCandleCloseMs,
    );
  });

  it("is not corrupted by an out-of-order candle appended after the true latest bar", () => {
    const btc = bearishBtc(asOf);
    const baseCtx = contextFromCandles({
      asOf,
      btc,
      microstructure: microstructure(),
      governance: governance(),
    });

    // A stale/duplicate candle from an earlier point in time (e.g. a delayed API
    // retry re-insert), appended AFTER the chronologically-latest bar rather than
    // in its correct position. Its own close time is still <= asOf, so it isn't
    // dropped by the future-candle filter — only ordering can save us here.
    const outOfOrderStale = {
      openTime: btc.h1[5]!.openTime,
      open: 65_000,
      high: 65_100,
      low: 64_900,
      close: 65_000, // well ABOVE 60k, unlike the true latest (bearish) close
      volume: 1_000,
    };
    const withOutOfOrder = contextFromCandles({
      asOf,
      btc: { ...btc, h1: [...btc.h1, outOfOrderStale] },
      microstructure: microstructure(),
      governance: governance(),
    });

    // If `closedCandles` trusted array position instead of chronological order,
    // `lastClose` would read the misplaced 65k candle and flip these flags.
    expect(withOutOfOrder.btcBelow60000).toBe(baseCtx.btcBelow60000);
    expect(withOutOfOrder.btcBelow60000).toBe(true);
    expect(withOutOfOrder.rsi1h).toBe(baseCtx.rsi1h);
  });

  it("leaves un-derivable flags undefined (fail-safe) when inputs are absent", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      microstructure: microstructure(),
      governance: governance(),
    });
    // No breadth input supplied → breadth flags undefined (not fabricated).
    expect(ctx.marketBreadthWeak).toBeUndefined();
    expect(ctx.marketBreadthPositive).toBeUndefined();
    // No coin input → relative-strength flags undefined.
    expect(ctx.coinOutperformsBTC).toBeUndefined();
  });

  it("flags stale data (and low confidence) when candle history is too short", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: {
        h1: series([59_000, 58_900], asOf - 2 * HOUR, HOUR),
        h4: series([59_500], asOf - 4 * HOUR, 4 * HOUR),
        d1: series([60_000], asOf - 24 * HOUR, 24 * HOUR),
      },
      microstructure: microstructure(),
      governance: governance(),
    });
    expect(ctx.dataStale).toBe(true);
    expect(ctx.regimeConfidence).toBeLessThan(0.6);
  });

  it("passes supplied breadth + microstructure through to flags", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      breadth: {
        advancersPct: 0.25,
        altAdvancersPct: 0.3,
        universeKind: "CURRENT_LIQUID_UNIVERSE",
        universeDescription: "current scan universe only; not full historical crypto universe",
      },
      microstructure: microstructure({ liquidityTooThin: true, spreadBps: 12 }),
      governance: governance(),
    });
    expect(ctx.marketBreadthWeak).toBe(true);
    expect(ctx.marketBreadthPositive).toBe(false);
    expect(ctx.breadthUniverseKind).toBe("CURRENT_LIQUID_UNIVERSE");
    expect(ctx.liquidityTooThin).toBe(true);
    expect(ctx.spreadBps).toBe(12);
  });

  it("labels fundingRiskAbnormal=false as ASSUMED_BASELINE when funding data is absent by policy", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      microstructure: {
        spreadBps: 2,
        slippageBps: 2,
        liquidityGood: true,
        assumeFundingBaseline: true,
      },
      governance: governance(),
    });
    expect(ctx.fundingRiskAbnormal).toBe(false);
    expect(ctx.featureSources?.fundingRiskAbnormal).toEqual(["ASSUMED_BASELINE"]);

    const d = buildTradingDecision(ctx);
    expect(d.trace?.featureSources?.fundingRiskAbnormal).toEqual(["ASSUMED_BASELINE"]);
  });

  it("applies stricter liquidity thresholds to alts than BTC/ETH/SOL majors", () => {
    const shared = {
      spreadBps: 4,
      slippageBps: 2,
      quoteVolumeUsd24h: 80_000_000,
      orderbookDepthUsd: 1_500_000,
      fundingRiskAbnormal: false,
    };
    const majorCtx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      microstructure: { ...shared, liquidityTier: "MAJOR" },
      governance: governance(),
    });
    const altCtx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      microstructure: { ...shared, liquidityTier: "ALT" },
      governance: governance(),
    });

    expect(majorCtx.liquidityGood).toBe(true);
    expect(majorCtx.liquiditySource).toBe("ORDERBOOK_DEPTH");
    expect(majorCtx.featureSources?.liquidityGood).toEqual(["ORDERBOOK_DEPTH"]);
    expect(altCtx.liquidityGood).toBe(false);
    expect(altCtx.liquidityTooThin).toBe(true);
  });

  it("falls back to a conservative liquidity heuristic when orderbook depth is missing", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      microstructure: {
        spreadBps: 3,
        slippageBps: 2,
        liquidityTier: "MAJOR",
        quoteVolumeUsd24h: 120_000_000,
        fundingRiskAbnormal: false,
      },
      governance: governance(),
    });

    expect(ctx.liquidityGood).toBe(true);
    expect(ctx.liquiditySource).toBe("HEURISTIC_SPREAD_VOLUME");
    expect(ctx.featureSources?.liquidityGood).toEqual(["HEURISTIC"]);
  });

  it("end-to-end: adapter output flows into buildTradingDecision and yields a valid decision with a trace", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      breadth: { advancersPct: 0.25 },
      microstructure: microstructure(),
      governance: governance(),
    });
    const d = buildTradingDecision(ctx);
    // Whatever it decides, it must be a well-formed decision carrying a trace,
    // and it must never be a forbidden entry.
    expect(["ENTER_LONG", "ENTER_SHORT", "NO_TRADE"]).toContain(d.action);
    expect(d.trace?.detectedRegime).toBeDefined();
    expect(d.trace?.featureSources?.btcBelow60000).toEqual(["1h"]);
    if (d.action !== "NO_TRADE") {
      expect(["SHORT_RALLY_FADE", "BREAKDOWN_RETEST_SHORT", "MICRO_MEAN_REVERSION"]).toContain(d.lane);
    }
  });

  // 2026-07-10: retest62000Hold was fixed to add a "sustained above the level" path
  // alongside the original narrow-band "retest at the level" path, because the
  // narrow-band-only version made NEUTRAL_RECOVERY structurally unreachable during a
  // real, decisive rally (0/746 real production snapshots) — see contextFromCandles.ts.
  function recoveryBtc(
    asOf: number,
    opts: { h4Tail: [number, number]; h1LastClose: number },
  ) {
    const closesH1 = Array.from({ length: 40 }, (_, i) => 58_000 + i * ((opts.h1LastClose - 58_000) / 39));
    closesH1[closesH1.length - 1] = opts.h1LastClose;
    const closesH4 = [
      ...Array.from({ length: 18 }, (_, i) => 58_000 + i * 100),
      opts.h4Tail[0],
      opts.h4Tail[1],
    ];
    const closesD1 = Array.from({ length: 10 }, (_, i) => 60_000 + i * 200);
    return {
      h1: series(closesH1, asOf - 40 * HOUR, HOUR),
      h4: series(closesH4, asOf - 20 * 4 * HOUR, 4 * HOUR),
      d1: series(closesD1, asOf - 10 * 24 * HOUR, 24 * HOUR),
    };
  }

  it("retest62000Hold: fires on a sustained rally (2 consecutive 4H closes above 62000) even far from the level", () => {
    const ctx = contextFromCandles({
      asOf,
      // 2 consecutive confirmed 4H closes above 62000, current price 64240 — 3.6% away,
      // well outside the 1.2% narrow-band tolerance. Only the new sustained-above path
      // can make this true.
      btc: recoveryBtc(asOf, { h4Tail: [62_800, 63_900], h1LastClose: 64_240 }),
      microstructure: microstructure(),
      governance: governance(),
    });
    expect(ctx.btcClose4hAbove62000).toBe(true);
    expect(nearLevelDistancePct(64_240, 62_000)).toBeGreaterThan(0.012);
    expect(ctx.retest62000Hold).toBe(true);
  });

  it("retest62000Hold: stays undefined on a single-bar poke above 62000 that hasn't confirmed twice yet", () => {
    const ctx = contextFromCandles({
      asOf,
      // Same far-from-level price as above, but only the LAST 4H bar closed above
      // 62000 — the one before it (h4[length-2]) did not. Isolates the "2 consecutive
      // bars" requirement: far from the level AND not yet sustained ⇒ must stay undefined.
      btc: recoveryBtc(asOf, { h4Tail: [61_500, 63_900], h1LastClose: 64_240 }),
      microstructure: microstructure(),
      governance: governance(),
    });
    expect(ctx.btcClose4hAbove62000).toBe(true);
    expect(ctx.retest62000Hold).toBeUndefined();
  });

  it("retest62000Hold: original narrow-band retest-at-level case is unchanged (regression)", () => {
    const ctx = contextFromCandles({
      asOf,
      // Price sitting within 1.2% of 62000 (62035, 0.056% away) — the ORIGINAL passing
      // case. The last 4H bar closed above 62000 but the one before did NOT (61200), so
      // sustainedAbove62000 is false here — proving retestAtLevel alone still fires this
      // true, untouched by the new branch.
      btc: recoveryBtc(asOf, { h4Tail: [61_200, 62_300], h1LastClose: 62_035 }),
      microstructure: microstructure(),
      governance: governance(),
    });
    expect(ctx.btcClose4hAbove62000).toBe(true);
    expect(nearLevelDistancePct(62_035, 62_000)).toBeLessThan(0.012);
    expect(ctx.retest62000Hold).toBe(true);
  });

  it("respects explicit overrides applied last", () => {
    const ctx = contextFromCandles({
      asOf,
      btc: bearishBtc(asOf),
      microstructure: microstructure(),
      governance: governance(),
      overrides: { marketBreadthWeak: true, signalConflict: true },
    });
    expect(ctx.marketBreadthWeak).toBe(true);
    expect(ctx.signalConflict).toBe(true);
  });
});

describe("breadthFromCandles", () => {
  const asOf = 2_000_000_000_000;

  it("derives breadth metrics and flags from closed universe candles", () => {
    const btc = series(Array.from({ length: 60 }, (_, i) => 60_000 + i * 10), asOf - 60 * HOUR, HOUR);
    const universe = Array.from({ length: 8 }, (_, i) => ({
      symbol: `ALT${i}USDT`,
      h1: series(
        Array.from({ length: 60 }, (_, j) => 100 + j * (i < 6 ? 0.8 : -0.2)),
        asOf - 60 * HOUR,
        HOUR,
      ),
    }));
    const result = breadthFromCandles({
      asOf,
      btc,
      universe,
      universeKind: "CURRENT_LIQUID_UNIVERSE",
      universeDescription: "test universe",
      minSymbols: 8,
    });

    expect(result.unavailableReason).toBeUndefined();
    expect(result.breadth?.universeKind).toBe("CURRENT_LIQUID_UNIVERSE");
    expect(result.metrics?.symbolCount).toBe(8);
    expect(result.metrics?.percentAboveEma20).toBeGreaterThan(0);
    expect(typeof result.flags?.marketBreadthPositive).toBe("boolean");
    expect(typeof result.flags?.altBreadthImproves).toBe("boolean");
  });

  it("does not fabricate breadth when the universe has insufficient lookback", () => {
    const btc = series(Array.from({ length: 60 }, (_, i) => 60_000 + i * 10), asOf - 60 * HOUR, HOUR);
    const result = breadthFromCandles({
      asOf,
      btc,
      universe: [{ symbol: "ETHUSDT", h1: series([100, 101], asOf - 2 * HOUR, HOUR) }],
      universeKind: "CURRENT_LIQUID_UNIVERSE",
      minSymbols: 8,
    });

    expect(result.breadth).toBeUndefined();
    expect(result.unavailableReason).toMatch(/UNIVERSE_LOOKBACK_INSUFFICIENT/);
  });
});

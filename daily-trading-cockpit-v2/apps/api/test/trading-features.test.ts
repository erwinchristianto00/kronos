import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import type { FeatureAdapterInput } from "../src/trading/index.js";
import {
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
        universeKind: "CURRENT_HIGH_LIQUIDITY_MAJORS",
        universeDescription: "current majors only; not full historical crypto universe",
      },
      microstructure: microstructure({ liquidityTooThin: true, spreadBps: 12 }),
      governance: governance(),
    });
    expect(ctx.marketBreadthWeak).toBe(true);
    expect(ctx.marketBreadthPositive).toBe(false);
    expect(ctx.breadthUniverseKind).toBe("CURRENT_HIGH_LIQUIDITY_MAJORS");
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

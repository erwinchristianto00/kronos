import { describe, expect, it } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  SingleSymbolPriceTimelineService,
  buildSingleSymbolPriceTimelineState,
} from "../src/lib/single-symbol-price-timeline.js";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

function candles(intervalMs: number, slope: number, count = 260, volumeAt?: (i: number) => number): Candle[] {
  const start = NOW - (count - 1) * intervalMs;
  return Array.from({ length: count }, (_, i) => {
    const base = 200 + i * slope;
    // Oscillation keeps RSI below its chase ceiling while preserving a clear structural slope.
    const wave = Math.sin(i / 1.7) * Math.abs(slope) * 6;
    const close = base + wave;
    const open = base + Math.sin((i - 1) / 5) * Math.abs(slope) * 1.2;
    return {
      openTime: start + i * intervalMs,
      open,
      close,
      high: Math.max(open, close) + 0.25,
      low: Math.min(open, close) - 0.25,
      volume: volumeAt ? volumeAt(i) : 100 + i * 0.5,
    };
  });
}

describe("single-symbol price timeline", () => {
  it("keeps an upward forecast but waits rather than chasing a completed-candle top", () => {
    const state = buildSingleSymbolPriceTimelineState("BTCUSDT", { m5: candles(5 * 60_000, 0.14), h1: candles(60 * 60_000, 0.25) }, NOW);
    expect(state.available).toBe(true);
    expect(state.directive, JSON.stringify({ score: state.score, confidence: state.confidence, reason: state.entryReason, indicators: state.indicators })).toBe("WAIT");
    expect(state.score).toBeGreaterThan(0.34);
    expect(state.forecasts[0]!.targetPrice).toBeGreaterThan(state.price!);
    expect(state.exitShortReason).toBe("TIMELINE_BULL_REVERSAL_CONFIRMED");
  });

  it("does not chase an already-oversold bearish move even when the causal forecast remains downward", () => {
    const m5 = candles(5 * 60_000, -0.14);
    // Force a completed downside extension, not merely a weak downtrend.
    for (let i = m5.length - 8; i < m5.length; i += 1) {
      const candle = m5[i]!;
      const drop = (i - (m5.length - 8) + 1) * 3;
      candle.close -= drop;
      candle.low = Math.min(candle.low, candle.close - 0.25);
    }
    const state = buildSingleSymbolPriceTimelineState("ETHUSDT", { m5, h1: candles(60 * 60_000, -0.25) }, NOW);
    expect(state.available).toBe(true);
    expect(state.directive).toBe("WAIT");
    expect(state.score).toBeLessThan(-0.34);
    expect(state.forecasts[0]!.targetPrice).toBeLessThan(state.price!);
    // An oversold downtrend is not enough to liquidate a long: only the stricter
    // reversal threshold may request an exit, avoiding exit-chasing at the bottom.
    expect(state.exitLongReason).toBeNull();
  });

  it("fails closed for a tracked entry when the public candle feed is unavailable, but never requests a forced exit", async () => {
    const service = new SingleSymbolPriceTimelineService(async () => { throw new Error("feed down"); }, { enabledForExecution: true, nowMs: () => NOW });
    await expect(service.entryGate("BTCUSDT", "LONG")).resolves.toEqual({ allowed: false, reason: "BTCUSDT: timeline market data unavailable or stale" });
    await expect(service.exitGate("BTCUSDT", "LONG")).resolves.toEqual({ shouldExit: false, reason: null });
  });

  it("fails safe to WAIT when the 5m volume baseline is corrupted (avg<=0), instead of treating it as confirmed", () => {
    const count = 260;
    // 20-candle baseline window `calculateTimeframeIndicators` reads is candles.slice(-22,-2);
    // zeroing it makes the SMA baseline <=0, which is exactly the real Binance feed glitch that
    // makes `volumeRatio` null (see packages/shared/src/indicators.ts latestComparableVolume).
    const zeroedBaselineVolume = (i: number) => (i >= count - 22 && i < count - 2 ? 0 : 100 + i * 0.5);
    const m5 = candles(5 * 60_000, 0.14, count, zeroedBaselineVolume);
    const h1 = candles(60 * 60_000, 0.25, count);
    const state = buildSingleSymbolPriceTimelineState("BTCUSDT", { m5, h1 }, NOW);
    expect(state.available).toBe(true);
    expect(state.indicators.m5?.volumeRatio).toBeNull();
    // Same price/score inputs as the aligned-bullish case above (which yields ENTER_LONG); only the
    // volume baseline is corrupted here, so a null baseline must not itself grant the gate pass.
    expect(state.directive, JSON.stringify({ score: state.score, confidence: state.confidence, reason: state.entryReason })).toBe("WAIT");
  });

  it("does not restrict symbols outside the explicitly monitored BTC/ETH/SOL set", async () => {
    const service = new SingleSymbolPriceTimelineService(async () => [], { enabledForExecution: true, nowMs: () => NOW });
    await expect(service.entryGate("DOGEUSDT", "LONG")).resolves.toEqual({ allowed: true, reason: null });
    await expect(service.exitGate("DOGEUSDT", "SHORT")).resolves.toEqual({ shouldExit: false, reason: null });
  });
});

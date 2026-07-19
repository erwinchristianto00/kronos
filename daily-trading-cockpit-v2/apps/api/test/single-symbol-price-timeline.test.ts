import { describe, expect, it } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  SingleSymbolPriceTimelineService,
  buildSingleSymbolPriceTimelineState,
} from "../src/lib/single-symbol-price-timeline.js";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

function candles(intervalMs: number, slope: number, count = 220): Candle[] {
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
      volume: 100 + i * 0.5,
    };
  });
}

describe("single-symbol price timeline", () => {
  it("produces a causal bullish directive and upward forecast from aligned 5m/1h inputs", () => {
    const state = buildSingleSymbolPriceTimelineState("BTCUSDT", { m5: candles(5 * 60_000, 0.14), h1: candles(60 * 60_000, 0.25) }, NOW);
    expect(state.available).toBe(true);
    expect(state.directive, JSON.stringify({ score: state.score, confidence: state.confidence, reason: state.entryReason, indicators: state.indicators })).toBe("ENTER_LONG");
    expect(state.score).toBeGreaterThan(0.34);
    expect(state.forecasts[0]!.targetPrice).toBeGreaterThan(state.price!);
    expect(state.exitShortReason).toBe("TIMELINE_BULL_REVERSAL_CONFIRMED");
  });

  it("does not chase an already-oversold bearish move even when the causal forecast remains downward", () => {
    const state = buildSingleSymbolPriceTimelineState("ETHUSDT", { m5: candles(5 * 60_000, -0.14), h1: candles(60 * 60_000, -0.25) }, NOW);
    expect(state.available).toBe(true);
    expect(state.directive).toBe("WAIT");
    expect(state.score).toBeLessThan(-0.34);
    expect(state.forecasts[0]!.targetPrice).toBeLessThan(state.price!);
    expect(state.exitLongReason).toBe("TIMELINE_BEAR_REVERSAL_CONFIRMED");
  });

  it("fails closed for a tracked entry when the public candle feed is unavailable, but never requests a forced exit", async () => {
    const service = new SingleSymbolPriceTimelineService(async () => { throw new Error("feed down"); }, { enabledForExecution: true, nowMs: () => NOW });
    await expect(service.entryGate("BTCUSDT", "LONG")).resolves.toEqual({ allowed: false, reason: "BTCUSDT: timeline market data unavailable or stale" });
    await expect(service.exitGate("BTCUSDT", "LONG")).resolves.toEqual({ shouldExit: false, reason: null });
  });

  it("does not restrict symbols outside the explicitly monitored BTC/ETH/SOL set", async () => {
    const service = new SingleSymbolPriceTimelineService(async () => [], { enabledForExecution: true, nowMs: () => NOW });
    await expect(service.entryGate("DOGEUSDT", "LONG")).resolves.toEqual({ allowed: true, reason: null });
    await expect(service.exitGate("DOGEUSDT", "SHORT")).resolves.toEqual({ shouldExit: false, reason: null });
  });
});

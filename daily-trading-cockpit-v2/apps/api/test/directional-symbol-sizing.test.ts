import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle } from "@dtc/shared";

import {
  computeAtrPctFromCandles,
  directionalSymbolSizeMultiplier,
  evaluateDirectionalTechnicalConfirmation,
  isDirectionalTechnicalGateEnabled,
  SymbolVolatilityCacheStore,
  refreshSymbolVolatilityCache,
  _resetSymbolVolatilityCacheStoreForTests,
} from "../src/lib/directional-symbol-sizing.js";

let t = 1_000_000_000_000;
function bar(close: number, opts: { high?: number; low?: number } = {}): Candle {
  t += 3_600_000;
  return { openTime: t, open: close, high: opts.high ?? close, low: opts.low ?? close, close, volume: 100 };
}

/** n candles oscillating +/-swing around `base` — a stable, predictable true range each bar. */
function steadyCandles(n: number, base: number, swing: number): Candle[] {
  t = 1_000_000_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    candles.push(bar(base, { high: base + swing, low: base - swing }));
  }
  return candles;
}

/** n candles compounding by stepPct each bar (positive = uptrend, negative = downtrend) — clean
 *  EMA/ROC alignment without pushing RSI to its extremes. */
function trendingCandles(n: number, start: number, stepPct: number): Candle[] {
  t = 1_000_000_000_000;
  const candles: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= 1 + stepPct;
    candles.push(bar(price));
  }
  return candles;
}

/** A sustained trend that alternates every bar (net drift in `sign`'s direction, larger step that
 *  way than the pullback) — EMA/ROC read a clean trend, but RSI sees a genuine gain AND loss every
 *  other bar, so it settles mid-range (~65-70 / ~30-35) instead of pinning at the 0/100 extreme a
 *  monotonic series would produce. */
function sustainedTrendWithNoise(n: number, start: number, sign: 1 | -1): Candle[] {
  t = 1_000_000_000_000;
  const candles: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= i % 2 === 0 ? 1 + sign * 0.008 : 1 - sign * 0.004;
    candles.push(bar(price));
  }
  return candles;
}

describe("evaluateDirectionalTechnicalConfirmation", () => {
  it("confirms LONG on a sustained uptrend (EMA aligned, momentum up, not overextended)", () => {
    const sig = evaluateDirectionalTechnicalConfirmation(sustainedTrendWithNoise(60, 100, 1), "LONG");
    expect(sig.emaAligned).toBe(true);
    expect(sig.momentumAligned).toBe(true);
    expect(sig.notOverextended).toBe(true);
    expect(sig.confirmed).toBe(true);
  });

  it("rejects LONG on a sustained downtrend (wrong side of everything)", () => {
    const sig = evaluateDirectionalTechnicalConfirmation(sustainedTrendWithNoise(60, 100, -1), "LONG");
    expect(sig.emaAligned).toBe(false);
    expect(sig.momentumAligned).toBe(false);
    expect(sig.confirmed).toBe(false);
  });

  it("confirms SHORT on a sustained downtrend (mirror of the LONG case)", () => {
    const sig = evaluateDirectionalTechnicalConfirmation(sustainedTrendWithNoise(60, 100, -1), "SHORT");
    expect(sig.emaAligned).toBe(true);
    expect(sig.momentumAligned).toBe(true);
    expect(sig.notOverextended).toBe(true);
    expect(sig.confirmed).toBe(true);
  });

  it("rejects SHORT on a sustained uptrend", () => {
    const sig = evaluateDirectionalTechnicalConfirmation(sustainedTrendWithNoise(60, 100, 1), "SHORT");
    expect(sig.confirmed).toBe(false);
  });

  it("rejects a flat/choppy market for BOTH directions (no trend structure, no momentum)", () => {
    const flat = steadyCandles(60, 100, 0.5);
    expect(evaluateDirectionalTechnicalConfirmation(flat, "LONG").confirmed).toBe(false);
    expect(evaluateDirectionalTechnicalConfirmation(flat, "SHORT").confirmed).toBe(false);
  });

  it("fails CLOSED (confirmed=false) on insufficient candle history, for both directions", () => {
    const short = steadyCandles(10, 100, 1);
    expect(evaluateDirectionalTechnicalConfirmation(short, "LONG").confirmed).toBe(false);
    expect(evaluateDirectionalTechnicalConfirmation(short, "SHORT").confirmed).toBe(false);
  });

  it("rejects a LONG chasing an already-overextended monotonic move (RSI pinned at 100)", () => {
    // Every single bar a gain -> avgLoss=0 -> RSI=100, well past the anti-chase ceiling.
    const sig = evaluateDirectionalTechnicalConfirmation(trendingCandles(60, 100, 0.01), "LONG");
    expect(sig.emaAligned).toBe(true);
    expect(sig.momentumAligned).toBe(true);
    expect(sig.notOverextended).toBe(false);
    expect(sig.confirmed).toBe(false);
  });
});

describe("isDirectionalTechnicalGateEnabled", () => {
  it("is off unless explicitly enabled via env", () => {
    expect(isDirectionalTechnicalGateEnabled({})).toBe(false);
    expect(isDirectionalTechnicalGateEnabled({ DIRECTIONAL_TECHNICAL_GATE_ENABLED: "1" })).toBe(true);
    expect(isDirectionalTechnicalGateEnabled({ DIRECTIONAL_TECHNICAL_GATE_ENABLED: "true" })).toBe(false);
  });
});

describe("computeAtrPctFromCandles", () => {
  it("returns null when candles don't exceed the ATR period", () => {
    expect(computeAtrPctFromCandles(steadyCandles(10, 100, 1), 14)).toBeNull();
  });

  it("computes ATR as a fraction of the last close for a steady oscillation", () => {
    // true range each bar = high-low = 2*swing = 4; ATR converges to ~4 after warmup.
    const atrPct = computeAtrPctFromCandles(steadyCandles(40, 100, 2), 14);
    expect(atrPct).not.toBeNull();
    expect(atrPct!).toBeGreaterThan(0.03);
    expect(atrPct!).toBeLessThan(0.05);
  });

  it("scales proportionally with swing size (double swing -> roughly double ATR%)", () => {
    const small = computeAtrPctFromCandles(steadyCandles(40, 100, 1), 14)!;
    const big = computeAtrPctFromCandles(steadyCandles(40, 100, 2), 14)!;
    expect(big / small).toBeGreaterThan(1.8);
    expect(big / small).toBeLessThan(2.2);
  });
});

describe("directionalSymbolSizeMultiplier", () => {
  it("is always 1x outside the curated whitelist, regardless of performance/volatility", () => {
    const mult = directionalSymbolSizeMultiplier({
      isWhitelisted: false,
      netAvgR: 0.5,
      atrPct: 0.01,
      peerAtrPcts: [0.05, 0.05, 0.05],
    });
    expect(mult).toBe(1);
  });

  it("is neutral (1x) when whitelisted but no performance/volatility data exists", () => {
    const mult = directionalSymbolSizeMultiplier({
      isWhitelisted: true,
      netAvgR: null,
      atrPct: null,
      peerAtrPcts: [],
    });
    expect(mult).toBe(1);
  });

  it("scales UP for proven positive performance", () => {
    const mult = directionalSymbolSizeMultiplier({
      isWhitelisted: true,
      netAvgR: 0.3,
      atrPct: null,
      peerAtrPcts: [],
    });
    expect(mult).toBeGreaterThan(1);
  });

  it("scales DOWN for negative-but-still-whitelisted performance", () => {
    const mult = directionalSymbolSizeMultiplier({
      isWhitelisted: true,
      netAvgR: -0.2,
      atrPct: null,
      peerAtrPcts: [],
    });
    expect(mult).toBeLessThan(1);
  });

  it("scales UP a symbol currently calmer than its whitelist peers", () => {
    const mult = directionalSymbolSizeMultiplier({
      isWhitelisted: true,
      netAvgR: null,
      atrPct: 0.02, // half the peer median
      peerAtrPcts: [0.04, 0.04, 0.04],
    });
    expect(mult).toBeGreaterThan(1);
  });

  it("scales DOWN a symbol currently choppier than its whitelist peers", () => {
    const mult = directionalSymbolSizeMultiplier({
      isWhitelisted: true,
      netAvgR: null,
      atrPct: 0.08, // double the peer median
      peerAtrPcts: [0.04, 0.04, 0.04],
    });
    expect(mult).toBeLessThan(1);
  });

  it("never exceeds the combined ceiling even when both factors point up", () => {
    const mult = directionalSymbolSizeMultiplier({
      isWhitelisted: true,
      netAvgR: 5, // absurdly large, would blow past PERF_MULT_MAX alone
      atrPct: 0.001, // absurdly calm vs peers
      peerAtrPcts: [0.1, 0.1, 0.1],
    });
    expect(mult).toBeLessThanOrEqual(1.75);
  });

  it("never drops below the combined floor even when both factors point down", () => {
    const mult = directionalSymbolSizeMultiplier({
      isWhitelisted: true,
      netAvgR: -5,
      atrPct: 1,
      peerAtrPcts: [0.001, 0.001, 0.001],
    });
    expect(mult).toBeGreaterThanOrEqual(0.5);
  });
});

describe("SymbolVolatilityCacheStore + refreshSymbolVolatilityCache", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dtc-vol-cache-"));
    _resetSymbolVolatilityCacheStoreForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("populates ATR% per symbol from a fake candle fetcher", async () => {
    const store = new SymbolVolatilityCacheStore(dir);
    const fetchCandles = async (symbol: string) =>
      symbol === "BTCUSDT" ? steadyCandles(40, 60000, 300) : steadyCandles(40, 1, 0.05);
    const result = await refreshSymbolVolatilityCache(store, ["BTCUSDT", "DOGEUSDT"], fetchCandles);
    expect(result.refreshed).toBe(2);
    expect(result.failed).toBe(0);
    const state = store.get();
    expect(state.atrPctBySymbol.BTCUSDT).toBeGreaterThan(0);
    expect(state.atrPctBySymbol.DOGEUSDT).toBeGreaterThan(0);
  });

  it("keeps the previous cached value for a symbol whose fetch fails, without wiping others", async () => {
    const store = new SymbolVolatilityCacheStore(dir);
    const goodFetch = async () => steadyCandles(40, 100, 2);
    await refreshSymbolVolatilityCache(store, ["BTCUSDT", "DOGEUSDT"], goodFetch);
    const priorDoge = store.get().atrPctBySymbol.DOGEUSDT;

    const flakyFetch = async (symbol: string) => {
      if (symbol === "DOGEUSDT") throw new Error("simulated exchange timeout");
      return steadyCandles(40, 100, 3); // BTCUSDT gets fresh data
    };
    const result = await refreshSymbolVolatilityCache(store, ["BTCUSDT", "DOGEUSDT"], flakyFetch);
    expect(result.failed).toBe(1);
    const state = store.get();
    expect(state.atrPctBySymbol.DOGEUSDT).toBe(priorDoge); // untouched by the failure
    expect(state.atrPctBySymbol.BTCUSDT).toBeGreaterThan(0);
  });

  it("persists across store instances (atomic tmp+rename load/save round-trip)", async () => {
    const store1 = new SymbolVolatilityCacheStore(dir);
    await refreshSymbolVolatilityCache(store1, ["ETHUSDT"], async () => steadyCandles(40, 3000, 15));
    const store2 = new SymbolVolatilityCacheStore(dir);
    expect(store2.get().atrPctBySymbol.ETHUSDT).toBe(store1.get().atrPctBySymbol.ETHUSDT);
  });
});

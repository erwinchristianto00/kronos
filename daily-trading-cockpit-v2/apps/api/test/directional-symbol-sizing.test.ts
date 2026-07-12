import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle } from "@dtc/shared";

import {
  computeAtrPctFromCandles,
  directionalSymbolSizeMultiplier,
  evaluateDirectionalTechnicalConfirmation,
  isDecisionScoreSizeMultEnabled,
  isDirectionalTechnicalGateEnabled,
  isDirectionalTechnicalSignalFresh,
  TECHNICAL_SIGNAL_MAX_STALE_MS,
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

describe("directionalSymbolSizeMultiplier — decisionScore quality tilt (DECISION_SCORE_SIZE_MULT_ENABLED)", () => {
  // Exactly the fixtures from the describe block above, reused verbatim as the baseline-preservation
  // proof: every one of these must produce the SAME output with the flag off as it did before this
  // factor existed (fail-without/pass-with baseline).
  const existingFixtures = [
    { isWhitelisted: false, netAvgR: 0.5, atrPct: 0.01, peerAtrPcts: [0.05, 0.05, 0.05] },
    { isWhitelisted: true, netAvgR: null, atrPct: null, peerAtrPcts: [] },
    { isWhitelisted: true, netAvgR: 0.3, atrPct: null, peerAtrPcts: [] },
    { isWhitelisted: true, netAvgR: -0.2, atrPct: null, peerAtrPcts: [] },
    { isWhitelisted: true, netAvgR: null, atrPct: 0.02, peerAtrPcts: [0.04, 0.04, 0.04] },
    { isWhitelisted: true, netAvgR: null, atrPct: 0.08, peerAtrPcts: [0.04, 0.04, 0.04] },
    { isWhitelisted: true, netAvgR: 5, atrPct: 0.001, peerAtrPcts: [0.1, 0.1, 0.1] },
    { isWhitelisted: true, netAvgR: -5, atrPct: 1, peerAtrPcts: [0.001, 0.001, 0.001] },
  ];

  it("is off unless explicitly enabled via env", () => {
    expect(isDecisionScoreSizeMultEnabled({})).toBe(false);
    expect(isDecisionScoreSizeMultEnabled({ DECISION_SCORE_SIZE_MULT_ENABLED: "1" })).toBe(true);
    expect(isDecisionScoreSizeMultEnabled({ DECISION_SCORE_SIZE_MULT_ENABLED: "true" })).toBe(false);
  });

  it("(1) FLAG OFF/UNSET: output is IDENTICAL to pre-existing behavior across every existing fixture, " +
    "even when a decisionScore is supplied — this is the baseline-preservation proof", () => {
    for (const fixture of existingFixtures) {
      const todaysBehavior = directionalSymbolSizeMultiplier(fixture); // no env arg — every real call site today
      const explicitlyOff = directionalSymbolSizeMultiplier(fixture, {});
      const offWithScoreAttached = directionalSymbolSizeMultiplier({ ...fixture, decisionScore: 95 }, {});
      const offWithScoreAttachedNoEnvArg = directionalSymbolSizeMultiplier({ ...fixture, decisionScore: 95 });
      expect(explicitlyOff).toBe(todaysBehavior);
      expect(offWithScoreAttached).toBe(todaysBehavior);
      expect(offWithScoreAttachedNoEnvArg).toBe(todaysBehavior);
    }
  });

  it("(2) FLAG ON: higher decision score -> strictly larger multiplier, within the documented [0.5, 1.5] quality clamp", () => {
    const enabledEnv = { DECISION_SCORE_SIZE_MULT_ENABLED: "1" };
    const neutral = { isWhitelisted: true, netAvgR: null, atrPct: null, peerAtrPcts: [] };
    const low = directionalSymbolSizeMultiplier({ ...neutral, decisionScore: 0 }, enabledEnv);
    const mid = directionalSymbolSizeMultiplier({ ...neutral, decisionScore: 50 }, enabledEnv);
    const high = directionalSymbolSizeMultiplier({ ...neutral, decisionScore: 100 }, enabledEnv);
    expect(low).toBeCloseTo(0.5, 10); // score=0 floors at the documented 0.5x
    expect(mid).toBe(1); // score=50 is neutral by design (no tilt either way)
    expect(high).toBeCloseTo(1.5, 10); // score=100 ceilings at the documented 1.5x
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(0.5);
    expect(high).toBeLessThanOrEqual(1.5);
  });

  it("(3) FLAG ON but decisionScore missing/null/non-finite: quality factor still resolves to neutral 1.0", () => {
    const enabledEnv = { DECISION_SCORE_SIZE_MULT_ENABLED: "1" };
    const inputsNoScore = { isWhitelisted: true, netAvgR: 0.3, atrPct: null, peerAtrPcts: [] };
    const flagOffBaseline = directionalSymbolSizeMultiplier(inputsNoScore, {});
    expect(directionalSymbolSizeMultiplier(inputsNoScore, enabledEnv)).toBe(flagOffBaseline); // decisionScore undefined
    expect(directionalSymbolSizeMultiplier({ ...inputsNoScore, decisionScore: null }, enabledEnv)).toBe(flagOffBaseline);
    expect(directionalSymbolSizeMultiplier({ ...inputsNoScore, decisionScore: Number.NaN }, enabledEnv)).toBe(flagOffBaseline);
  });

  it("FLAG ON: stacks multiplicatively with perf/vol factors, still bounded by the existing combined clamp", () => {
    const enabledEnv = { DECISION_SCORE_SIZE_MULT_ENABLED: "1" };
    const mult = directionalSymbolSizeMultiplier(
      {
        isWhitelisted: true,
        netAvgR: 5, // would blow past PERF_MULT_MAX alone
        atrPct: 0.001, // absurdly calm vs peers
        peerAtrPcts: [0.1, 0.1, 0.1],
        decisionScore: 100, // pushes quality mult to its 1.5x ceiling too
      },
      enabledEnv,
    );
    expect(mult).toBeLessThanOrEqual(1.75); // same TOTAL_MULT_MAX ceiling as before this change
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

  // [STALE-FIX] 2026-07-11: a persistently-failing refresh must not let a stale confirmed/
  // unconfirmed verdict from days ago keep silently gating real-money entries forever — this is
  // the per-symbol computedAt stamped on every successful fetch, checked independently of the
  // cache-wide computedAt (which used to re-stamp every cycle regardless of per-symbol success).
  it("[STALE-FIX] a symbol whose fetch keeps failing goes stale even while OTHER symbols keep refreshing successfully", async () => {
    const store = new SymbolVolatilityCacheStore(dir);
    let clockMs = 1_800_000_000_000;
    const nowIso = () => new Date(clockMs).toISOString();

    // Cycle 1: both symbols fetch successfully.
    await refreshSymbolVolatilityCache(
      store,
      ["BTCUSDT", "DOGEUSDT"],
      async () => steadyCandles(40, 100, 2),
      { nowIso },
    );
    const btcEntryAfterCycle1 = store.get().technicalBySymbol.BTCUSDT!;
    const dogeEntryAfterCycle1 = store.get().technicalBySymbol.DOGEUSDT!;
    expect(isDirectionalTechnicalSignalFresh(btcEntryAfterCycle1, clockMs)).toBe(true);
    expect(isDirectionalTechnicalSignalFresh(dogeEntryAfterCycle1, clockMs)).toBe(true);

    // Advance the clock well past TECHNICAL_SIGNAL_MAX_STALE_MS, simulating several refresh cycles
    // where DOGEUSDT's fetch keeps throwing (e.g. a persistent exchange/network issue) while
    // BTCUSDT keeps succeeding normally.
    clockMs += TECHNICAL_SIGNAL_MAX_STALE_MS * 2;
    await refreshSymbolVolatilityCache(
      store,
      ["BTCUSDT", "DOGEUSDT"],
      async (symbol) => {
        if (symbol === "DOGEUSDT") throw new Error("simulated persistent exchange timeout");
        return steadyCandles(40, 100, 2);
      },
      { nowIso },
    );

    const btcEntryAfterCycle2 = store.get().technicalBySymbol.BTCUSDT!;
    const dogeEntryAfterCycle2 = store.get().technicalBySymbol.DOGEUSDT!;
    // BTCUSDT kept refreshing successfully — still fresh.
    expect(isDirectionalTechnicalSignalFresh(btcEntryAfterCycle2, clockMs)).toBe(true);
    // DOGEUSDT's entry is untouched (same object as cycle 1) and is now stale relative to the
    // advanced clock — the exact scenario the old code would have silently kept trusting.
    expect(dogeEntryAfterCycle2.computedAt).toBe(dogeEntryAfterCycle1.computedAt);
    expect(isDirectionalTechnicalSignalFresh(dogeEntryAfterCycle2, clockMs)).toBe(false);
  });

  it("[STALE-FIX] isDirectionalTechnicalSignalFresh fails closed on a missing entry or an invalid computedAt", () => {
    expect(isDirectionalTechnicalSignalFresh(undefined, Date.now())).toBe(false);
    expect(
      isDirectionalTechnicalSignalFresh(
        {
          LONG: { direction: "LONG", emaAligned: true, momentumAligned: true, notOverextended: true, confirmed: true, emaFast: 1, emaSlow: 1, roc: 1, rsi: 50 },
          SHORT: { direction: "SHORT", emaAligned: false, momentumAligned: false, notOverextended: false, confirmed: false, emaFast: null, emaSlow: null, roc: null, rsi: null },
          computedAt: "not-a-real-timestamp",
        },
        Date.now(),
      ),
    ).toBe(false);
  });
});

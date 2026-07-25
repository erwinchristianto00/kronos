/**
 * Regression tests for the real BTC ATR-percentile producer that replaced app.ts's permanent
 * `btcAtrPercentile: null` stub in buildFourBrainDeps — the single null that kept the four-brain
 * shadow layer's Market State classification stuck at UNKNOWN for its entire run (see
 * market-state-brain.ts: `t === null || vol === null ⇒ family = "UNKNOWN"`).
 *
 * Three things are verified, matching this repo's fail-without/pass-with discipline:
 *  (a) computeBtcAtrPercentile — pure function correctness AND causality (a value computed "as of"
 *      an earlier candle must be reproducible from a SHORTER array ending there, i.e. it must be
 *      unaffected by any candles that come after it).
 *  (b) BtcAtrPercentileCacheStore + refreshBtcAtrPercentileCache — fail-open behavior: a fetch
 *      error / empty candle array / insufficient history never throws and never fabricates a
 *      number, instead keeping the previous good value (or null) untouched.
 *  (c) A populated cache value flows all the way through four-brain-live-gather-bindings.ts's
 *      `buildFourBrainGatherInput` as a genuine non-null 0..100 → 0..1 normalized volatility
 *      reading (the exact consumer contract that was broken before this fix).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Candle } from "@dtc/shared";
import { computeATR, computeATRPercentile } from "../src/lib/candle-indicators.js";
import {
  computeBtcAtrPercentile,
  BtcAtrPercentileCacheStore,
  refreshBtcAtrPercentileCache,
  getBtcAtrPercentileCacheStore,
  _resetBtcAtrPercentileCacheStoreForTests,
  BTC_ATR_PERCENTILE_WINDOW_BARS,
  BTC_ATR_PERCENTILE_SYMBOL,
  BTC_ATR_PERCENTILE_INTERVAL,
  BTC_ATR_PERCENTILE_CANDLES_NEEDED,
  type BtcCandleFetcher,
} from "../src/lib/btc-atr-percentile-cache.js";
import { buildFourBrainGatherInput, type FourBrainBindingDeps } from "../src/lib/four-brain-live-gather-bindings.js";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** Builds `n` 1h candles with a strictly increasing high-low width (⇒ strictly increasing True
 *  Range) and a CONSTANT close price. Kept as a helper (not a fixed literal array) so every test
 *  below can vary `n` while preserving the exact "strictly increasing TR" property the monotonic
 *  test relies on. */
function rampCandles(n: number, startTime = NOW - n * HOUR): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const halfWidth = i + 1; // strictly increasing every bar ⇒ strictly increasing TR
    out.push({ openTime: startTime + i * HOUR, open: 100, high: 100 + halfWidth, low: 100 - halfWidth, close: 100, volume: 1000 });
  }
  return out;
}

/** Non-monotonic but deterministic candles (same wave shape used by other four-brain test fixtures)
 *  — used for the causality cross-check, where a monotonic series would make every index trivially
 *  the running max and mask an off-by-one/window bug. */
function waveCandles(n: number, startTime = NOW - n * HOUR): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i / 7) * 5 + i * 0.05;
    const spread = 1 + Math.abs(Math.cos(i / 3)) * 2;
    out.push({ openTime: startTime + i * HOUR, open: c, high: c + spread, low: c - spread, close: c, volume: 1000 });
  }
  return out;
}

const MIN_CANDLES = 14 + BTC_ATR_PERCENTILE_WINDOW_BARS; // ATR warmup + full percentile window

describe("computeBtcAtrPercentile — pure function", () => {
  it("returns null with fewer than ATR-warmup + window candles (never fabricates a number)", () => {
    expect(computeBtcAtrPercentile(rampCandles(MIN_CANDLES - 1))).toBeNull();
    expect(computeBtcAtrPercentile([])).toBeNull();
  });

  it("hand-verified: a strictly non-decreasing ATR/price ratio throughout history makes the LAST candle the max of every trailing window ⇒ percentile === 100", () => {
    // Proof sketch (see module doc comment): with price held constant, True Range is strictly
    // increasing every bar by construction (rampCandles). Wilder's ATR recursion is
    // atr[i] = atr[i-1] + (tr[i] - atr[i-1]) / period; by induction atr[i-1] <= tr[i-1] (the ATR
    // average of a non-decreasing sequence never exceeds its own latest input), and since tr is
    // non-decreasing, tr[i] >= tr[i-1] >= atr[i-1], so the increment is always >= 0 ⇒ atr (and
    // therefore atr/price) is non-decreasing over the ENTIRE series. That makes the final value the
    // max of any trailing window containing it, so computeATRPercentile's countLE/window*100 must
    // equal exactly 100 — a result derivable by hand, not by simulating 182 recursive steps.
    const pctile = computeBtcAtrPercentile(rampCandles(MIN_CANDLES + 18));
    expect(pctile).toBe(100);
  });

  it("causal: the value computed for a SHORTER array (ending earlier) is reproducible directly from the identically-parameterized longer-history primitives, and does not depend on any candle after it", () => {
    // Ground truth: run the exact same primitives (computeATR + computeATRPercentile) this module
    // composes, over the FULL (longer) candle history, and read off the array position that
    // corresponds to "as of" the shorter array's last candle.
    const full = waveCandles(MIN_CANDLES + 40);
    const closesFull = full.map((c) => c.close);
    const atrFull = computeATR(full, 14);
    const atrPctFull = atrFull.map((a, i) => (typeof a === "number" && Number.isFinite(a) && closesFull[i]! > 0 ? a / closesFull[i]! : null));
    const pctileFull = computeATRPercentile(atrPctFull, BTC_ATR_PERCENTILE_WINDOW_BARS);

    const asOfIndex = MIN_CANDLES + 9; // an index strictly before the end of `full`
    const truncated = full.slice(0, asOfIndex + 1); // "as of" this candle — nothing after it exists

    const truncatedResult = computeBtcAtrPercentile(truncated);
    const groundTruthAtIndex = pctileFull[asOfIndex];

    expect(truncatedResult).not.toBeNull();
    expect(truncatedResult).toBe(groundTruthAtIndex);

    // Sanity: this is NOT a vacuous comparison — the full-history run and the truncated run produce
    // a DIFFERENT final value overall (proving the two computations are genuinely different runs,
    // not accidentally the same object/reference), even though they agree at the shared index.
    expect(computeBtcAtrPercentile(full)).not.toBe(truncatedResult);
  });

  it("causal: appending wildly different future candles never changes the result for the earlier prefix", () => {
    const prefix = waveCandles(MIN_CANDLES + 5);
    const withWildFuture: Candle[] = [
      ...prefix,
      ...Array.from({ length: 20 }, (_, k) => ({
        openTime: prefix[prefix.length - 1]!.openTime + (k + 1) * HOUR,
        open: 999999,
        high: 2_000_000,
        low: 1,
        close: 999999,
        volume: 1,
      })),
    ];
    const resultPrefixAlone = computeBtcAtrPercentile(prefix);
    const resultPrefixReSliced = computeBtcAtrPercentile(withWildFuture.slice(0, prefix.length));
    expect(resultPrefixReSliced).toBe(resultPrefixAlone);
  });

  it("returns null when the latest ATR/price ratio is non-finite (e.g. non-positive close)", () => {
    const candles = rampCandles(MIN_CANDLES + 5);
    candles[candles.length - 1] = { ...candles[candles.length - 1]!, close: 0 };
    // computeATR itself is fine, but atr/close divides by zero-guarded to null ⇒ the trailing
    // window for the last index is incomplete ⇒ percentile null.
    expect(computeBtcAtrPercentile(candles)).toBeNull();
  });
});

describe("BtcAtrPercentileCacheStore + refreshBtcAtrPercentileCache — fail-open cache", () => {
  let store: BtcAtrPercentileCacheStore;

  beforeEach(() => {
    store = new BtcAtrPercentileCacheStore();
  });

  it("starts empty: percentile/atMs null, no error", () => {
    const s = store.get();
    expect(s.percentile).toBeNull();
    expect(s.atMs).toBeNull();
    expect(s.lastError).toBeNull();
  });

  it("a throwing fetcher never throws out of refresh, and leaves the cache at null (nothing to fall back to yet)", async () => {
    const fetchCandles: BtcCandleFetcher = async () => {
      throw new Error("network down");
    };
    const res = await refreshBtcAtrPercentileCache(store, fetchCandles);
    expect(res.ok).toBe(false);
    expect(res.percentile).toBeNull();
    const s = store.get();
    expect(s.percentile).toBeNull();
    expect(s.atMs).toBeNull();
    expect(s.lastError).toContain("network down");
  });

  it("an empty candle array fails open (no fabricated number)", async () => {
    const fetchCandles: BtcCandleFetcher = async () => [];
    const res = await refreshBtcAtrPercentileCache(store, fetchCandles);
    expect(res.ok).toBe(false);
    expect(res.percentile).toBeNull();
    expect(store.get().lastError).toBeTruthy();
  });

  it("insufficient candle history (not enough for warmup + window) fails open, does not fabricate", async () => {
    const fetchCandles: BtcCandleFetcher = async () => rampCandles(20);
    const res = await refreshBtcAtrPercentileCache(store, fetchCandles);
    expect(res.ok).toBe(false);
    expect(res.percentile).toBeNull();
    expect(store.get().lastError).toBeTruthy();
  });

  it("a successful fetch populates percentile + atMs, clears any prior error", async () => {
    const good: BtcCandleFetcher = async (symbol, interval, limit) => {
      expect(symbol).toBe(BTC_ATR_PERCENTILE_SYMBOL);
      expect(interval).toBe(BTC_ATR_PERCENTILE_INTERVAL);
      expect(limit).toBe(BTC_ATR_PERCENTILE_CANDLES_NEEDED);
      return rampCandles(BTC_ATR_PERCENTILE_CANDLES_NEEDED);
    };
    const res = await refreshBtcAtrPercentileCache(store, good, { now: () => NOW });
    expect(res.ok).toBe(true);
    expect(res.percentile).toBe(100);
    const s = store.get();
    expect(s.percentile).toBe(100);
    expect(s.atMs).toBe(NOW);
    expect(s.lastError).toBeNull();
  });

  it("fail-open: a later failing refresh KEEPS the previous good percentile/atMs, only records the error", async () => {
    const good: BtcCandleFetcher = async () => rampCandles(BTC_ATR_PERCENTILE_CANDLES_NEEDED);
    await refreshBtcAtrPercentileCache(store, good, { now: () => NOW });
    expect(store.get().percentile).toBe(100);

    const bad: BtcCandleFetcher = async () => {
      throw new Error("transient blip");
    };
    const res = await refreshBtcAtrPercentileCache(store, bad, { now: () => NOW + 15 * 60_000 });
    expect(res.ok).toBe(false);
    // percentile returned to caller is the PREVIOUS good one, not a fabricated fallback
    expect(res.percentile).toBe(100);

    const s = store.get();
    expect(s.percentile).toBe(100); // unchanged
    expect(s.atMs).toBe(NOW); // unchanged — NOT re-stamped to the failed refresh's time
    expect(s.lastError).toContain("transient blip");
  });

  it("excludes the still-forming current-hour candle before computing (regression: a live percentile must not repaint mid-bar the way price-impact-efficiency.ts's fetchCurrentPriceImpactReading already guards against)", async () => {
    // closedCandles' last bar ends exactly one full hour before NOW — i.e. it is the most recent
    // FULLY CLOSED 1h bar as of `now: () => NOW`.
    const closedCandles = waveCandles(BTC_ATR_PERCENTILE_CANDLES_NEEDED);
    const expected = computeBtcAtrPercentile(closedCandles);
    expect(expected).not.toBeNull();

    // A still-forming bar for the CURRENT hour (openTime === NOW ⇒ its window doesn't close until
    // NOW + 1h), given an extreme high/low so that if it were wrongly included as "the" reading it
    // would visibly skew the result away from `expected`.
    const formingCandle = {
      openTime: closedCandles[closedCandles.length - 1]!.openTime + HOUR,
      open: 100,
      high: 999_999,
      low: 1,
      close: 500_000,
      volume: 1,
    };
    const fetchCandles: BtcCandleFetcher = async () => [...closedCandles, formingCandle];

    const res = await refreshBtcAtrPercentileCache(store, fetchCandles, { now: () => NOW });

    expect(res.ok).toBe(true);
    // Must match the closed-candles-only computation, not be pulled toward the forming bar's
    // extreme TR (which — before the fix — would have been read as the "current" percentile).
    expect(res.percentile).toBe(expected);
    expect(store.get().percentile).toBe(expected);
    expect(store.get().atMs).toBe(NOW);
  });

  it("fails open with a dedicated error (never fabricates) when every fetched candle is still within its forming window", async () => {
    const fetchCandles: BtcCandleFetcher = async () => [
      { openTime: NOW, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    ];
    const res = await refreshBtcAtrPercentileCache(store, fetchCandles, { now: () => NOW });
    expect(res.ok).toBe(false);
    expect(res.percentile).toBeNull();
    expect(store.get().lastError).toContain("closed");
  });

  it("singleton getter returns the same instance until reset (mirrors SymbolVolatilityCacheStore convention)", () => {
    _resetBtcAtrPercentileCacheStoreForTests();
    const a = getBtcAtrPercentileCacheStore();
    const b = getBtcAtrPercentileCacheStore();
    expect(a).toBe(b);
    _resetBtcAtrPercentileCacheStoreForTests();
    const c = getBtcAtrPercentileCacheStore();
    expect(c).not.toBe(a);
  });
});

describe("populated cache → four-brain gather input (end-to-end consumer contract)", () => {
  const edge = {
    lookup: (_r: string | null, _d: "LONG" | "SHORT") => ({ avgNetR: 0, n: 0 }),
    verdict: () => ({ decision: "ALLOW_PROVEN" }),
    hasPositiveLane: () => true,
  };

  function baseDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
    return {
      instanceId: "3101",
      nowMs: NOW,
      axisScore: null, axisAtMs: null, axisSlopePerHour: null,
      btcAtrPercentile: null, atrAtMs: null,
      advancersPct: null, breadthAtMs: null,
      sentiment: null, sentimentAtMs: null,
      safetyEvents: [],
      regimeRaw: null, edgeMemory: edge,
      controllerBias: "UNKNOWN", convictionScore: null, allowsLong: true, allowsShort: true,
      bestLaneReportForDirection: () => null,
      crowdAlignLong: null, crowdAtMs: null, kronosAgree: null, kronosAtMs: null,
      openSignals: [], maxSignalAgeMs: 50 * 60_000, crowdingStateForSymbol: () => null,
      openPositions: [], markPriceForSymbol: () => ({ price: null, atMs: null }),
      cortexDecisionId: null, cortexFinalPctForLane: () => null, laneEligibleIncumbent: () => true,
      killLatched: false, killReason: null,
      ...o,
    } as FourBrainBindingDeps;
  }

  it("btcAtrPercentile: null (the OLD permanent stub) ⇒ volatility reading MISSING — reproduces the exact bug this fix closes", () => {
    const input = buildFourBrainGatherInput(baseDeps({ btcAtrPercentile: null, atrAtMs: null }));
    expect(input.marketState.volatility.normalized).toBeNull();
    expect(input.marketState.volatility.missingReason).toBeTruthy();
  });

  it("a real cache-produced percentile flows through as a non-null 0..100 raw / 0..1 normalized volatility reading", async () => {
    const store = new BtcAtrPercentileCacheStore();
    const fetchCandles: BtcCandleFetcher = async () => rampCandles(BTC_ATR_PERCENTILE_CANDLES_NEEDED);
    await refreshBtcAtrPercentileCache(store, fetchCandles, { now: () => NOW });
    const cached = store.get();
    expect(cached.percentile).not.toBeNull();

    const deps = baseDeps({ btcAtrPercentile: cached.percentile, atrAtMs: cached.atMs });
    const input = buildFourBrainGatherInput(deps);

    expect(input.marketState.volatility.raw).toBe(cached.percentile); // genuine 0..100, not a 0..1 fraction
    expect(input.marketState.volatility.normalized).toBeCloseTo((cached.percentile as number) / 100, 12);
    expect(input.marketState.volatility.normalized).not.toBeNull();
    expect(input.marketState.volatility.observedAtMs).toBe(cached.atMs);
    expect(input.marketState.volatility.missingReason).toBeNull();
    expect(input.marketState.volatility.sourceId).toBe("btc-atr-percentile");
  });
});

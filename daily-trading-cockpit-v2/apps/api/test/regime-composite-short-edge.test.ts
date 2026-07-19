import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  detectRegimeCompositeShortEntry,
  evaluateRegimeCompositeShortEntry,
  resolveRegimeCompositeShortObservation,
  buildRegimeCompositeShortReport,
  runRegimeCompositeShortCycle,
  RegimeCompositeShortStore,
  RCS_AXIS_SCORE_MAX,
  RCS_ATR_STOP_MULT,
  RCS_MAX_HOLD_BARS,
  regimeCompositeShortOpenSignals,
  type RegimeCompositeShortObservation,
} from "../src/lib/regime-composite-short-edge.js";
import type { CrowdingSnapshot } from "../src/lib/derivatives-crowding.js";

let t = 1_000_000_000_000;
function bar(close: number, opts: { open?: number; high?: number; low?: number } = {}): Candle {
  t += 3_600_000;
  return { openTime: t, open: opts.open ?? close, high: opts.high ?? close, low: opts.low ?? close, close, volume: 100 };
}

/** N bars with a real (non-zero) range each, so ATR is computable and positive. */
function candlesWithRange(n: number, basePrice = 100, rangeEach = 1): Candle[] {
  t = 1_000_000_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = basePrice + i * 0.1;
    candles.push(bar(c, { high: c + rangeEach, low: c - rangeEach }));
  }
  return candles;
}

function shortRetestCandles(): Candle[] {
  t = 1_000_000_000_000;
  const candles = Array.from({ length: 20 }, () => bar(100, { high: 101, low: 99 }));
  candles.push(bar(100.4, { open: 100, high: 100.6, low: 99.8 }));
  // Tests EMA20 from below, leaves an upper-wick rejection, and closes back below the mean.
  candles.push(bar(99.7, { open: 100.3, high: 101, low: 99.6 }));
  return candles;
}

function crowdSnap(over: Partial<CrowdingSnapshot> = {}): CrowdingSnapshot {
  return {
    symbol: "TESTUSDT",
    fundingRate: 0,
    fundingBps: 0,
    oiChangePercent: 0,
    oiTrend: "FLAT",
    takerBuySellRatio: null,
    longShortRatio: null,
    crowdSide: "NEUTRAL",
    crowdingLevel: "NEUTRAL",
    crowdingState: "NEUTRAL",
    flowConfirmed: null,
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

describe("regime-composite-short — entry gate (bearish axis ceiling + crowding, both must pass)", () => {
  it("fires when axis score is below the bearish ceiling AND crowding is NEUTRAL", () => {
    const candles = shortRetestCandles();
    const sig = detectRegimeCompositeShortEntry(candles, RCS_AXIS_SCORE_MAX - 0.1, crowdSnap());
    expect(sig).not.toBeNull();
    expect(sig!.entryPrice).toBe(candles[candles.length - 1]!.close);
    // stop sits ABOVE entry for a short — the mirror of the long lane
    expect(sig!.initialStop).toBeGreaterThan(sig!.entryPrice);
    expect(sig!.crowdingStateAtEntry).toBe("NEUTRAL");
  });

  it("fires when crowding is BUILDING (the other allowed state)", () => {
    const candles = shortRetestCandles();
    const sig = detectRegimeCompositeShortEntry(candles, RCS_AXIS_SCORE_MAX - 0.1, crowdSnap({ crowdingState: "BUILDING" }));
    expect(sig).not.toBeNull();
  });

  it("rejects when axis score is ABOVE the bearish ceiling (not bearish enough), even with favorable crowding", () => {
    const candles = candlesWithRange(20);
    const sig = detectRegimeCompositeShortEntry(candles, RCS_AXIS_SCORE_MAX + 0.01, crowdSnap());
    expect(sig).toBeNull();
  });

  it("rejects a strongly BULLISH axis score (positive) outright", () => {
    const candles = candlesWithRange(20);
    expect(detectRegimeCompositeShortEntry(candles, 0.9, crowdSnap())).toBeNull();
  });

  it("rejects when axis score is null (unavailable) regardless of crowding", () => {
    const candles = candlesWithRange(20);
    expect(detectRegimeCompositeShortEntry(candles, null, crowdSnap())).toBeNull();
  });

  it("rejects EXHAUSTING crowding even with a strongly bearish axis score", () => {
    const candles = candlesWithRange(20);
    const sig = detectRegimeCompositeShortEntry(candles, -0.9, crowdSnap({ crowdingState: "EXHAUSTING" }));
    expect(sig).toBeNull();
  });

  it("rejects UNWINDING crowding even with a strongly bearish axis score", () => {
    const candles = candlesWithRange(20);
    const sig = detectRegimeCompositeShortEntry(candles, -0.9, crowdSnap({ crowdingState: "UNWINDING" }));
    expect(sig).toBeNull();
  });

  it("rejects a null crowding snapshot (fetch failed — must not silently pass)", () => {
    const candles = candlesWithRange(20);
    expect(detectRegimeCompositeShortEntry(candles, -0.9, null)).toBeNull();
  });

  it("returns null with too few candles even when both gates pass", () => {
    expect(detectRegimeCompositeShortEntry([bar(100), bar(101)], -0.9, crowdSnap())).toBeNull();
  });

  it("rejects a waterfall short as oversold and tells the caller to wait for a pullback", () => {
    const candles = shortRetestCandles();
    const last = candles[candles.length - 1]!;
    candles[candles.length - 1] = { ...last, open: 100.3, high: 101, low: 95.5, close: 96 };
    const result = evaluateRegimeCompositeShortEntry(candles, -0.9, crowdSnap());
    expect(result.signal).toBeNull();
    expect(["RSI_OVERSOLD_WAIT_PULLBACK", "LATE_EXTENSION_WAIT_PULLBACK"]).toContain(result.rejection);
  });

  it("rejects bearish regime alone when no EMA20 retest/rejection exists", () => {
    const candles = shortRetestCandles();
    const last = candles[candles.length - 1]!;
    candles[candles.length - 1] = { ...last, open: 100.3, high: 100.4, low: 100.1, close: 100.2 };
    const result = evaluateRegimeCompositeShortEntry(candles, -0.9, crowdSnap());
    expect(result.signal).toBeNull();
    expect(["NO_EMA20_RETEST", "NO_BEARISH_REJECTION"]).toContain(result.rejection);
  });
});

function obs(over: Partial<RegimeCompositeShortObservation> = {}): RegimeCompositeShortObservation {
  const entryPrice = 100;
  const initialStop = entryPrice + RCS_ATR_STOP_MULT * 4; // risk = 8 at ATR=4, stop ABOVE
  return {
    observationId: "rcs:TEST:1", symbol: "TESTUSDT", direction: "SHORT",
    entryPrice, initialStop, stopDistanceBps: ((initialStop - entryPrice) / entryPrice) * 10000,
    atrAtEntry: 4, axisScoreAtEntry: -0.5, crowdingStateAtEntry: "NEUTRAL", fundingBpsAtEntry: 0,
    entrySetup: "EMA20_RETEST_REJECTION", ema20AtEntry: 100, extensionBelowEmaAtr: 0.075,
    openedAt: new Date(1_000_000_000_000).toISOString(), openedAtMs: 1_000_000_000_000,
    status: "OPEN", grossR: null, costR: null, netR: null, maxFavorableR: null, exitReason: null, resolvedAt: null,
    ...over,
  };
}

function fwd(prices: Array<{ close: number; high?: number; low?: number }>): Candle[] {
  let ft = 1_000_000_000_000;
  return prices.map((p) => {
    ft += 3_600_000;
    return { openTime: ft, open: p.close, high: p.high ?? p.close, low: p.low ?? p.close, close: p.close, volume: 100 };
  });
}

describe("regime-composite-short — resolution (MFE-giveback, SHORT direction)", () => {
  it("books the loss at the initial stop (−1R) when price rises through it", () => {
    // entry 100, stop 108. A bar whose HIGH pierces 108 stops the short out at −1R.
    const patch = resolveRegimeCompositeShortObservation(obs(), fwd([{ close: 105, high: 109 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("banks a faded winner on MFE giveback once armed and retraced (favorable = price falling)", () => {
    // risk = 8 (entry 100, stop 108). Fall to 94 (0.75R armed via low), then close back up to 98
    // (favorable closeR 0.25R <= giveback line 0.375R) → bank. No bar high touches 108.
    const patch = resolveRegimeCompositeShortObservation(
      obs(),
      fwd([{ close: 94, low: 94, high: 96 }, { close: 98, low: 98, high: 99 }]),
      Date.now(),
    );
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("MFE_GIVEBACK");
    expect(patch?.maxFavorableR).toBeCloseTo(0.75, 6);
  });

  it("marks to market at max hold when neither stop nor giveback fires", () => {
    const flatBars = Array.from({ length: RCS_MAX_HOLD_BARS }, () => ({ close: 99.5, high: 99.6, low: 99.4 }));
    const patch = resolveRegimeCompositeShortObservation(obs(), fwd(flatBars), Date.now());
    expect(patch?.exitReason).toBe("MAX_HOLD_MTM");
  });

  it("returns null (still open) with insufficient forward candles and not yet stale", () => {
    expect(resolveRegimeCompositeShortObservation(obs(), [], obs().openedAtMs + 3_600_000)).toBeNull();
  });

  it("expires a stale OPEN observation with no forward candles ever", () => {
    const staleNowMs = obs().openedAtMs + RCS_MAX_HOLD_BARS * 3_600_000 * 4;
    const patch = resolveRegimeCompositeShortObservation(obs(), [], staleNowMs);
    expect(patch?.status).toBe("EXPIRED");
  });
});

describe("regime-composite-short — report", () => {
  it("is not edgeReady below the sample floor even if every trade won", () => {
    const wins = Array.from({ length: 10 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.4 }));
    expect(buildRegimeCompositeShortReport(wins).edgeReady).toBe(false);
  });

  it("counts OPEN observations separately from resolved", () => {
    const report = buildRegimeCompositeShortReport([obs({ status: "OPEN" }), obs({ observationId: "x2", status: "CLOSED_WIN", netR: 0.3 })]);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(1);
  });
});

describe("regime-composite-short — cycle (bearish axis gate first, bounds the crowding fetch)", () => {
  it("never calls the crowding client when the axis score is ABOVE the bearish ceiling", async () => {
    const store = new RegimeCompositeShortStore(`/tmp/rcs-test-${Date.now()}-${Math.random()}.json`);
    let crowdingCalls = 0;
    const result = await runRegimeCompositeShortCycle({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisScore: RCS_AXIS_SCORE_MAX + 0.1, // not bearish enough
      fetchCandles: async () => shortRetestCandles(),
      crowdingClient: {
        getFuturesFlow: async () => {
          crowdingCalls += 1;
          return { fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: null, longShortRatio: null };
        },
      },
    });
    expect(crowdingCalls).toBe(0);
    expect(result.axisGateFail).toBe(1);
    expect(result.recorded).toBe(0);
  });

  it("records a SHORT signal when the bearish axis gate AND crowding gate both pass", async () => {
    const store = new RegimeCompositeShortStore(`/tmp/rcs-test-${Date.now()}-${Math.random()}.json`);
    const result = await runRegimeCompositeShortCycle({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisScore: RCS_AXIS_SCORE_MAX - 0.1, // bearish enough
      fetchCandles: async () => shortRetestCandles(),
      crowdingClient: {
        getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: null, longShortRatio: null }),
      },
    });
    expect(result.crowdingGateFail).toBe(0);
    expect(result.recorded).toBe(1);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.direction).toBe("SHORT");
    expect(regimeCompositeShortOpenSignals(store)).toHaveLength(1);
  });

  it("rejects a symbol when crowding fails (EXHAUSTING) even though the bearish axis gate passed", async () => {
    const store = new RegimeCompositeShortStore(`/tmp/rcs-test-${Date.now()}-${Math.random()}.json`);
    const result = await runRegimeCompositeShortCycle({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisScore: RCS_AXIS_SCORE_MAX - 0.1,
      fetchCandles: async () => shortRetestCandles(),
      crowdingClient: {
        getFuturesFlow: async () => ({ fundingRate: 0.001, openInterestChangePercent: 2, takerBuySellRatio: null, longShortRatio: null }),
      },
    });
    expect(result.crowdingGateFail).toBe(1);
    expect(result.recorded).toBe(0);
  });

  it("stops recording once the lane-local max-concurrent cap is reached", async () => {
    const store = new RegimeCompositeShortStore(`/tmp/rcs-test-${Date.now()}-${Math.random()}.json`);
    const neutralCrowding = { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: null, longShortRatio: null }) };
    const result = await runRegimeCompositeShortCycle({
      store,
      universe: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
      now: Date.now(),
      axisScore: RCS_AXIS_SCORE_MAX - 0.1,
      maxConcurrent: 2,
      fetchCandles: async () => shortRetestCandles(),
      crowdingClient: neutralCrowding,
    });
    expect(result.recorded).toBe(2);
    expect(store.all.filter((o) => o.status === "OPEN")).toHaveLength(2);
  });
});

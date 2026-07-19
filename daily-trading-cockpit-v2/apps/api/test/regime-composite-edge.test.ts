import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  detectRegimeCompositeEntry,
  evaluateRegimeCompositeEntry,
  resolveRegimeCompositeObservation,
  buildRegimeCompositeReport,
  runRegimeCompositeCycle,
  runRegimeCompositeCycleGuarded,
  RegimeCompositeStore,
  RC_AXIS_SCORE_MIN,
  RC_ATR_STOP_MULT,
  RC_MAX_HOLD_BARS,
  regimeCompositeOpenSignals,
  regimeCompositeExitPolicy,
  isRegimeCompositeExecEnabled,
  RC_EXEC_LEG_USD,
  RC_EXEC_LEVERAGE,
  RC_EXEC_MAX_SIGNAL_AGE_MS,
  RC_EXEC_DAILY_MAX_LOSS_USD,
  type RegimeCompositeObservation,
} from "../src/lib/regime-composite-edge.js";
import type { CrowdingSnapshot } from "../src/lib/derivatives-crowding.js";

let t = 1_000_000_000_000;
function bar(close: number, opts: { open?: number; high?: number; low?: number } = {}): Candle {
  t += 3_600_000;
  return { openTime: t, open: opts.open ?? close, high: opts.high ?? close, low: opts.low ?? close, close, volume: 100 };
}

/** N bars with a real (non-zero) daily range each, so ATR is computable and positive. */
function candlesWithRange(n: number, basePrice = 100, rangeEach = 1): Candle[] {
  t = 1_000_000_000_000;
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = basePrice + i * 0.1;
    candles.push(bar(c, { high: c + rangeEach, low: c - rangeEach }));
  }
  return candles;
}

function longRetestCandles(): Candle[] {
  t = 1_000_000_000_000;
  const candles = Array.from({ length: 20 }, () => bar(100, { high: 101, low: 99 }));
  candles.push(bar(98.8, { open: 100, high: 100.2, low: 98.5 }));
  // Tests EMA20 from above, leaves a lower-side rejection, and closes back over the mean.
  candles.push(bar(100.4, { open: 99.5, high: 100.8, low: 99.1 }));
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
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

describe("regime-composite — entry gate (axis score + crowding, both must pass)", () => {
  it("fires when axis score clears the floor AND crowding is NEUTRAL", () => {
    const candles = longRetestCandles();
    const sig = detectRegimeCompositeEntry(candles, RC_AXIS_SCORE_MIN + 0.1, crowdSnap());
    expect(sig).not.toBeNull();
    expect(sig!.entryPrice).toBe(candles[candles.length - 1]!.close);
    expect(sig!.initialStop).toBeLessThan(sig!.entryPrice);
    expect(sig!.crowdingStateAtEntry).toBe("NEUTRAL");
  });

  it("fires when crowding is BUILDING (the other allowed state)", () => {
    const candles = longRetestCandles();
    const sig = detectRegimeCompositeEntry(candles, RC_AXIS_SCORE_MIN + 0.1, crowdSnap({ crowdingState: "BUILDING" }));
    expect(sig).not.toBeNull();
  });

  it("rejects when axis score is below the floor, even with favorable crowding", () => {
    const candles = candlesWithRange(20);
    const sig = detectRegimeCompositeEntry(candles, RC_AXIS_SCORE_MIN - 0.01, crowdSnap());
    expect(sig).toBeNull();
  });

  it("rejects when axis score is null (unavailable) regardless of crowding", () => {
    const candles = candlesWithRange(20);
    expect(detectRegimeCompositeEntry(candles, null, crowdSnap())).toBeNull();
  });

  it("rejects EXHAUSTING crowding even with a strongly bullish axis score", () => {
    const candles = candlesWithRange(20);
    const sig = detectRegimeCompositeEntry(candles, 0.9, crowdSnap({ crowdingState: "EXHAUSTING" }));
    expect(sig).toBeNull();
  });

  it("rejects UNWINDING crowding even with a strongly bullish axis score", () => {
    const candles = candlesWithRange(20);
    const sig = detectRegimeCompositeEntry(candles, 0.9, crowdSnap({ crowdingState: "UNWINDING" }));
    expect(sig).toBeNull();
  });

  it("rejects a null crowding snapshot (fetch failed — must not silently pass)", () => {
    const candles = candlesWithRange(20);
    expect(detectRegimeCompositeEntry(candles, 0.9, null)).toBeNull();
  });

  it("returns null with too few candles even when both gates pass", () => {
    expect(detectRegimeCompositeEntry([bar(100), bar(101)], 0.9, crowdSnap())).toBeNull();
  });

  it("rejects a vertical long as overbought and tells the caller to wait for a pullback", () => {
    const candles = longRetestCandles();
    const last = candles[candles.length - 1]!;
    candles[candles.length - 1] = { ...last, open: 99.7, high: 105, low: 99.4, close: 104 };
    const result = evaluateRegimeCompositeEntry(candles, 0.9, crowdSnap());
    expect(result.signal).toBeNull();
    expect(["RSI_OVERBOUGHT_WAIT_PULLBACK", "LATE_EXTENSION_WAIT_PULLBACK"]).toContain(result.rejection);
  });

  it("rejects bullish regime alone when no EMA20 retest/rejection exists", () => {
    const candles = longRetestCandles();
    const last = candles[candles.length - 1]!;
    candles[candles.length - 1] = { ...last, open: 99.1, high: 99.2, low: 98.7, close: 98.9 };
    const result = evaluateRegimeCompositeEntry(candles, 0.9, crowdSnap());
    expect(result.signal).toBeNull();
    expect(["NO_EMA20_RETEST", "NO_BULLISH_REJECTION"]).toContain(result.rejection);
  });
});

function obs(over: Partial<RegimeCompositeObservation> = {}): RegimeCompositeObservation {
  const entryPrice = 100;
  const initialStop = entryPrice - RC_ATR_STOP_MULT * 4; // risk = 8 at ATR=4
  return {
    observationId: "rc:TEST:1", symbol: "TESTUSDT", direction: "LONG",
    entryPrice, initialStop, stopDistanceBps: ((entryPrice - initialStop) / entryPrice) * 10000,
    atrAtEntry: 4, axisScoreAtEntry: 0.5, crowdingStateAtEntry: "NEUTRAL", fundingBpsAtEntry: 0,
    entrySetup: "EMA20_RETEST_REJECTION", ema20AtEntry: 100, extensionAboveEmaAtr: 0.075,
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

describe("regime-composite — resolution (MFE-giveback, LONG direction)", () => {
  it("books the loss at the initial stop (−1R) when price drops through it", () => {
    const patch = resolveRegimeCompositeObservation(obs(), fwd([{ close: 95, low: 91 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("banks a faded winner on MFE giveback once armed and retraced", () => {
    // risk = 8 (entry 100, stop 92). Peak to 106 (0.75R armed), then close back to 102 (giveback line 0.375R@102).
    const patch = resolveRegimeCompositeObservation(
      obs(),
      fwd([{ close: 106, high: 106 }, { close: 102, high: 102 }]),
      Date.now(),
    );
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("MFE_GIVEBACK");
    expect(patch?.maxFavorableR).toBeCloseTo(0.75, 6);
  });

  it("marks to market at max hold when neither stop nor giveback fires", () => {
    const flatBars = Array.from({ length: RC_MAX_HOLD_BARS }, () => ({ close: 100.5, high: 100.6, low: 100.4 }));
    const patch = resolveRegimeCompositeObservation(obs(), fwd(flatBars), Date.now());
    expect(patch?.exitReason).toBe("MAX_HOLD_MTM");
  });

  it("returns null (still open) with insufficient forward candles and not yet stale", () => {
    expect(resolveRegimeCompositeObservation(obs(), [], obs().openedAtMs + 3_600_000)).toBeNull();
  });

  it("expires a stale OPEN observation with no forward candles ever", () => {
    const staleNowMs = obs().openedAtMs + RC_MAX_HOLD_BARS * 3_600_000 * 4;
    const patch = resolveRegimeCompositeObservation(obs(), [], staleNowMs);
    expect(patch?.status).toBe("EXPIRED");
  });
});

describe("regime-composite — report", () => {
  it("is not edgeReady below the sample floor even if every trade won", () => {
    const wins = Array.from({ length: 10 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.4 }));
    const report = buildRegimeCompositeReport(wins);
    expect(report.edgeReady).toBe(false);
  });

  it("is edgeReady with adequate sample, positive net, and a real payoff", () => {
    const wins = Array.from({ length: 25 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.35, exitReason: "MFE_GIVEBACK" }));
    const losses = Array.from({ length: 10 }, (_, i) => obs({ observationId: `l${i}`, status: "CLOSED_LOSS", netR: -1.05, exitReason: "INITIAL_STOP" }));
    const report = buildRegimeCompositeReport([...wins, ...losses]);
    expect(report.resolvedCount).toBe(35);
    expect(report.wr).toBeCloseTo(25 / 35, 6);
  });

  it("counts OPEN observations separately from resolved", () => {
    const report = buildRegimeCompositeReport([obs({ status: "OPEN" }), obs({ observationId: "x2", status: "CLOSED_WIN", netR: 0.3 })]);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(1);
  });
});

describe("regime-composite — cycle (axis gate first, bounds the crowding fetch)", () => {
  it("never calls the crowding client when the axis score is below the floor", async () => {
    const store = new RegimeCompositeStore(`/tmp/regime-composite-test-${Date.now()}-${Math.random()}.json`);
    let crowdingCalls = 0;
    const result = await runRegimeCompositeCycle({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisScore: RC_AXIS_SCORE_MIN - 0.1,
      fetchCandles: async () => longRetestCandles(),
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

  it("records a signal when the axis gate AND crowding gate both pass", async () => {
    const store = new RegimeCompositeStore(`/tmp/regime-composite-test-${Date.now()}-${Math.random()}.json`);
    const result = await runRegimeCompositeCycle({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisScore: RC_AXIS_SCORE_MIN + 0.1,
      fetchCandles: async () => longRetestCandles(),
      crowdingClient: {
        getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: null, longShortRatio: null }),
      },
    });
    expect(result.crowdingGateFail).toBe(0);
    expect(result.recorded).toBe(1);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.direction).toBe("LONG");
  });

  it("rejects a symbol when crowding fails even though the axis gate passed", async () => {
    const store = new RegimeCompositeStore(`/tmp/regime-composite-test-${Date.now()}-${Math.random()}.json`);
    const result = await runRegimeCompositeCycle({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisScore: RC_AXIS_SCORE_MIN + 0.1,
      fetchCandles: async () => longRetestCandles(),
      crowdingClient: {
        // EXTREME funding + rising OI ⇒ EXHAUSTING ⇒ gate fails.
        getFuturesFlow: async () => ({ fundingRate: 0.001, openInterestChangePercent: 2, takerBuySellRatio: null, longShortRatio: null }),
      },
    });
    expect(result.crowdingGateFail).toBe(1);
    expect(result.recorded).toBe(0);
  });

  it("stops recording once the lane-local max-concurrent cap is reached", async () => {
    const store = new RegimeCompositeStore(`/tmp/regime-composite-test-${Date.now()}-${Math.random()}.json`);
    const neutralCrowding = { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: null, longShortRatio: null }) };
    const result = await runRegimeCompositeCycle({
      store,
      universe: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
      now: Date.now(),
      axisScore: RC_AXIS_SCORE_MIN + 0.1,
      maxConcurrent: 2,
      fetchCandles: async () => longRetestCandles(),
      crowdingClient: neutralCrowding,
    });
    expect(result.recorded).toBe(2);
    expect(store.all.filter((o) => o.status === "OPEN")).toHaveLength(2);
  });
});

describe("regime-composite — cycle liveness meta", () => {
  const neutralCrowding = {
    getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: null, longShortRatio: null }),
  };

  it("[LIVENESS] persists lastCycleAt + accumulates the gate funnel across cycles and reloads", async () => {
    const file = `/tmp/regime-composite-meta-${Date.now()}-${Math.random()}.json`;
    const store = new RegimeCompositeStore(file);
    const base = { store, universe: ["BTCUSDT"] as const, fetchCandles: async () => longRetestCandles(), crowdingClient: neutralCrowding };
    await runRegimeCompositeCycle({ ...base, now: Date.now(), axisScore: RC_AXIS_SCORE_MIN - 0.1 });
    await runRegimeCompositeCycle({ ...base, now: Date.now() + 3_600_000, axisScore: RC_AXIS_SCORE_MIN - 0.1 });
    const meta = store.cycleMeta;
    expect(meta.cycles).toBe(2);
    expect(meta.lastCycleAt).not.toBeNull();
    expect(meta.axisGateFailTotal).toBe(2);
    expect(meta.recordedTotal).toBe(0);
    expect(meta.lastCycleError).toBeNull();
    const reloaded = new RegimeCompositeStore(file);
    expect(reloaded.cycleMeta.cycles).toBe(2);
    expect(reloaded.cycleMeta.axisGateFailTotal).toBe(2);
    const report = buildRegimeCompositeReport(reloaded.all, reloaded.cycleMeta);
    expect(report.cycleMeta?.cycles).toBe(2);
  });

  it("[LIVENESS] a crashing cycle records lastCycleError instead of looking identical to 'no signal'", async () => {
    const store = new RegimeCompositeStore(`/tmp/regime-composite-meta-err-${Date.now()}-${Math.random()}.json`);
    const orig = store.save.bind(store);
    let threw = false;
    store.save = () => {
      if (!threw) { threw = true; throw new Error("disk full"); }
      orig();
    };
    const crashed = await runRegimeCompositeCycleGuarded({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisScore: RC_AXIS_SCORE_MIN + 0.1,
      fetchCandles: async () => candlesWithRange(20),
      crowdingClient: neutralCrowding,
    });
    expect(crashed).toBeNull();
    expect(store.cycleMeta.lastCycleError).toBe("disk full");
  });
});

function rcObs(over: Partial<RegimeCompositeObservation> = {}): RegimeCompositeObservation {
  return {
    observationId: "rc:TESTUSDT:1",
    symbol: "TESTUSDT",
    direction: "LONG",
    entryPrice: 100,
    initialStop: 92,
    stopDistanceBps: 800,
    atrAtEntry: 4,
    axisScoreAtEntry: 0.5,
    crowdingStateAtEntry: "NEUTRAL",
    fundingBpsAtEntry: 0,
    openedAt: new Date(1_000_000_000_000).toISOString(),
    openedAtMs: 1_000_000_000_000,
    status: "OPEN",
    grossR: null,
    costR: null,
    netR: null,
    maxFavorableR: null,
    exitReason: null,
    resolvedAt: null,
    ...over,
  };
}

describe("regime-composite — live execution wiring adapters", () => {
  it("[regimeCompositeOpenSignals] maps only OPEN observations into the generic executor's fresh-signal shape", () => {
    const store = new RegimeCompositeStore(`/tmp/rc-adapter-${Date.now()}-${Math.random()}.json`);
    store.add(rcObs({ observationId: "rc:A:1", symbol: "BTCUSDT", status: "OPEN" }));
    store.add(rcObs({ observationId: "rc:B:1", symbol: "ETHUSDT", status: "CLOSED_WIN" }));
    const signals = regimeCompositeOpenSignals(store);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      observationId: "rc:A:1",
      symbol: "BTCUSDT",
      entryPrice: 100,
      stopPrice: 92,
      openedAtMs: 1_000_000_000_000,
    });
  });

  it("[regimeCompositeOpenSignals] returns an empty array when the store has no OPEN observations", () => {
    const store = new RegimeCompositeStore(`/tmp/rc-adapter-${Date.now()}-${Math.random()}.json`);
    store.add(rcObs({ status: "CLOSED_LOSS" }));
    expect(regimeCompositeOpenSignals(store)).toEqual([]);
  });

  it("[regimeCompositeExitPolicy] stays open before arming, exits on stop, and banks the MFE giveback", () => {
    const policy = regimeCompositeExitPolicy();
    const open = policy({ direction: "LONG", entryPrice: 100, stopPrice: 92, currentPrice: 101, peakFavorableR: 0, msHeld: 1000 });
    expect(open.shouldExit).toBe(false);

    const stopped = policy({ direction: "LONG", entryPrice: 100, stopPrice: 92, currentPrice: 92, peakFavorableR: 0, msHeld: 1000 });
    expect(stopped.shouldExit).toBe(true);
    expect(stopped.reason).toBe("INITIAL_STOP");

    // risk=8, arm at peak >= 0.75R (106), giveback line at 0.375R (103) once armed.
    const armed = policy({ direction: "LONG", entryPrice: 100, stopPrice: 92, currentPrice: 106, peakFavorableR: 0, msHeld: 1000 });
    expect(armed.shouldExit).toBe(false);
    expect(armed.nextPeakFavorableR).toBeCloseTo(0.75, 6);
    const banked = policy({ direction: "LONG", entryPrice: 100, stopPrice: 92, currentPrice: 102, peakFavorableR: armed.nextPeakFavorableR, msHeld: 1000 });
    expect(banked.shouldExit).toBe(true);
    expect(banked.reason).toBe("MFE_GIVEBACK");
  });

  it("[regimeCompositeExitPolicy] falls back to MAX_HOLD_MTM once RC_MAX_HOLD_BARS worth of ms has elapsed", () => {
    const policy = regimeCompositeExitPolicy();
    const decision = policy({
      direction: "LONG", entryPrice: 100, stopPrice: 92, currentPrice: 100.5, peakFavorableR: 0,
      msHeld: RC_MAX_HOLD_BARS * 3_600_000,
    });
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe("MAX_HOLD_MTM");
  });

  it("[isRegimeCompositeExecEnabled] is off by default and only on with the exact '1' flag", () => {
    expect(isRegimeCompositeExecEnabled({})).toBe(false);
    expect(isRegimeCompositeExecEnabled({ REGIME_COMPOSITE_EXEC_ENABLED: "true" })).toBe(false);
    expect(isRegimeCompositeExecEnabled({ REGIME_COMPOSITE_EXEC_ENABLED: "1" })).toBe(true);
  });

  describe("RC_EXEC_* config readers", () => {
    const keys = [
      "REGIME_COMPOSITE_EXEC_LEG_USD",
      "REGIME_COMPOSITE_EXEC_LEVERAGE",
      "REGIME_COMPOSITE_EXEC_MAX_SIGNAL_AGE_MS",
      "REGIME_COMPOSITE_EXEC_DAILY_MAX_LOSS_USD",
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    });

    it("RC_EXEC_LEG_USD defaults to 130 (clears ~2 BTCUSDT stepSize units at its real live price) and honors a valid positive override", () => {
      expect(RC_EXEC_LEG_USD()).toBe(130);
      process.env.REGIME_COMPOSITE_EXEC_LEG_USD = "150";
      expect(RC_EXEC_LEG_USD()).toBe(150);
    });

    it("RC_EXEC_LEG_USD ignores a non-positive or garbage override and falls back to the default", () => {
      process.env.REGIME_COMPOSITE_EXEC_LEG_USD = "-5";
      expect(RC_EXEC_LEG_USD()).toBe(130);
      process.env.REGIME_COMPOSITE_EXEC_LEG_USD = "not-a-number";
      expect(RC_EXEC_LEG_USD()).toBe(130);
    });

    it("RC_EXEC_LEVERAGE defaults to 3, floors a fractional override, rejects <1", () => {
      expect(RC_EXEC_LEVERAGE()).toBe(3);
      process.env.REGIME_COMPOSITE_EXEC_LEVERAGE = "5";
      expect(RC_EXEC_LEVERAGE()).toBe(5);
      process.env.REGIME_COMPOSITE_EXEC_LEVERAGE = "0";
      expect(RC_EXEC_LEVERAGE()).toBe(3);
    });

    it("RC_EXEC_MAX_SIGNAL_AGE_MS defaults to 10 minutes and floors at 60s", () => {
      expect(RC_EXEC_MAX_SIGNAL_AGE_MS()).toBe(10 * 60_000);
      process.env.REGIME_COMPOSITE_EXEC_MAX_SIGNAL_AGE_MS = "1000";
      expect(RC_EXEC_MAX_SIGNAL_AGE_MS()).toBe(60_000);
      process.env.REGIME_COMPOSITE_EXEC_MAX_SIGNAL_AGE_MS = "120000";
      expect(RC_EXEC_MAX_SIGNAL_AGE_MS()).toBe(120_000);
    });

    it("RC_EXEC_DAILY_MAX_LOSS_USD defaults to 8 (a real cap, unlike its siblings' 0/no-cap default) and honors an override", () => {
      expect(RC_EXEC_DAILY_MAX_LOSS_USD()).toBe(8);
      process.env.REGIME_COMPOSITE_EXEC_DAILY_MAX_LOSS_USD = "15";
      expect(RC_EXEC_DAILY_MAX_LOSS_USD()).toBe(15);
    });
  });
});

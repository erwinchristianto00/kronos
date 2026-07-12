import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  detectIntradayMomentumEntry,
  resolveIntradayMomentum,
  buildIntradayMomentumReport,
  type IntradayMomentumObservation,
  IM_ATR_STOP_MULT,
  IM_MAX_HOLD_BARS,
  IntradayMomentumStore,
  intradayMomentumOpenSignals,
  intradayMomentumExitPolicy,
  isIntradayMomentumExecEnabled,
  IM_EXEC_LEG_USD,
  IM_EXEC_LEVERAGE,
  IM_EXEC_MAX_SIGNAL_AGE_MS,
  IM_EXEC_DAILY_MAX_LOSS_USD,
  IM_EXEC_MAX_CONCURRENT,
} from "../src/lib/intraday-momentum-edge.js";

let t = 1_000_000_000_000;
function bar(close: number, opts: { high?: number; low?: number; volume?: number } = {}): Candle {
  t += 3_600_000;
  return {
    openTime: t,
    open: close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: opts.volume ?? 100,
  };
}

/** A flat, low-volume base of `n` bars around `price`, then a breakout bar. */
function baseThenBreakout(): Candle[] {
  t = 1_000_000_000_000;
  const base: Candle[] = [];
  for (let i = 0; i < 30; i++) base.push(bar(100, { high: 101, low: 99, volume: 100 }));
  // breakout: close 108 above the 101 prior high, 3x volume, above EMA, positive ROC, modest extension
  base.push(bar(108, { high: 108.5, low: 100.5, volume: 400 }));
  return base;
}

describe("intraday momentum hunter — entry signal", () => {
  it("fires on a high-volume breakout with momentum", () => {
    const sig = detectIntradayMomentumEntry(baseThenBreakout());
    expect(sig).not.toBeNull();
    expect(sig!.entryPrice).toBe(108);
    expect(sig!.breakoutHigh).toBe(101);
    expect(sig!.volumeRatio).toBeGreaterThan(1.5);
    expect(sig!.initialStop).toBeLessThan(108);
    expect(sig!.stopDistanceBps).toBeGreaterThan(0);
  });

  it("rejects a breakout WITHOUT a volume surge", () => {
    const c = baseThenBreakout();
    c[c.length - 1] = { ...c[c.length - 1]!, volume: 120 }; // barely above avg → below 1.5x
    expect(detectIntradayMomentumEntry(c)).toBeNull();
  });

  it("rejects when the close does NOT break the prior high", () => {
    const c = baseThenBreakout();
    c[c.length - 1] = { ...c[c.length - 1]!, close: 100.5, high: 100.8 }; // below the 101 prior high
    expect(detectIntradayMomentumEntry(c)).toBeNull();
  });

  it("rejects a vertical over-extension (anti-chase)", () => {
    const c = baseThenBreakout();
    c[c.length - 1] = { ...c[c.length - 1]!, close: 180, high: 181, volume: 400 }; // way above EMA in ATR terms
    expect(detectIntradayMomentumEntry(c)).toBeNull();
  });

  it("returns null with too few candles", () => {
    expect(detectIntradayMomentumEntry([bar(100), bar(101)])).toBeNull();
  });
});

function obs(over: Partial<IntradayMomentumObservation> = {}): IntradayMomentumObservation {
  const entryPrice = 100;
  const initialStop = 100 - IM_ATR_STOP_MULT * 4; // risk = 6 → stop 94
  return {
    observationId: "im:TEST:1", symbol: "TESTUSDT", direction: "LONG",
    entryPrice, initialStop, stopDistanceBps: ((entryPrice - initialStop) / entryPrice) * 10000,
    atrAtEntry: 4, rocAtEntry: 5, breakoutHigh: 99, volumeRatio: 3, atrExtension: 1,
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

describe("intraday momentum hunter — MFE-giveback resolution", () => {
  it("books the loss at the initial stop (−1R)", () => {
    const o = obs(); // entry 100, stop 94, risk 6
    const patch = resolveIntradayMomentum(o, fwd([{ close: 98, low: 93 }]), 2_000_000_000_000)!;
    expect(patch.status).toBe("CLOSED_LOSS");
    expect(patch.grossR).toBeCloseTo(-1, 6);
    expect(patch.exitReason).toBe("INITIAL_STOP");
  });

  it("lets the winner run then banks it on a 50% retrace from peak (MFE-giveback)", () => {
    const o = obs(); // risk 6
    // rise to +2R (peak high 112), then close retraces to +1R (106) ≤ peak×0.5=+1R
    const patch = resolveIntradayMomentum(
      o,
      fwd([{ close: 110, high: 112, low: 100 }, { close: 106, high: 107, low: 105 }]),
      2_000_000_000_000,
    )!;
    expect(patch.exitReason).toBe("MFE_GIVEBACK");
    expect(patch.maxFavorableR).toBeCloseTo(2, 6);
    expect(patch.grossR).toBeCloseTo(1, 6); // banked at the giveback line, not at the stop
    expect(patch.status).toBe("CLOSED_WIN");
  });

  it("does NOT giveback before arming (peak < 0.75R)", () => {
    const o = obs();
    // small wiggle: peak +0.3R, never arms → stays open (no stop, no max-hold yet)
    const patch = resolveIntradayMomentum(o, fwd([{ close: 101, high: 101.8, low: 100 }]), 1_000_000_000_100);
    expect(patch).toBeNull();
  });

  it("marks to market at MAX_HOLD when neither stop nor giveback fires", () => {
    const o = obs();
    // 24 flat-ish bars that never stop out and never retrace enough to giveback
    const bars = Array.from({ length: 24 }, () => ({ close: 100.5, high: 100.9, low: 99.5 }));
    const patch = resolveIntradayMomentum(o, fwd(bars), 2_000_000_000_000)!;
    expect(patch.exitReason).toBe("MAX_HOLD_MTM");
  });
});

describe("intraday momentum hunter — report", () => {
  it("aggregates net/pf/wr and edge-readiness honestly", () => {
    const wins = Array.from({ length: 20 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", grossR: 1, netR: 0.9, maxFavorableR: 1.5, exitReason: "MFE_GIVEBACK" }));
    const losses = Array.from({ length: 15 }, (_, i) => obs({ observationId: `l${i}`, status: "CLOSED_LOSS", grossR: -1, netR: -1.05, maxFavorableR: 0.2, exitReason: "INITIAL_STOP" }));
    const r = buildIntradayMomentumReport([...wins, ...losses, obs({ observationId: "open1", status: "OPEN" })]);
    expect(r.resolvedCount).toBe(35);
    expect(r.openCount).toBe(1);
    expect(r.wr).toBeCloseTo(20 / 35, 3);
    expect(r.netAvgR).toBeGreaterThan(0);
    expect(r.pf).toBeGreaterThan(1);
    expect(r.mfeGivebackShare).toBeCloseTo(20 / 35, 3);
  });

  it("is NOT edge-ready below the sample floor", () => {
    const few = Array.from({ length: 10 }, (_, i) => obs({ observationId: `x${i}`, status: "CLOSED_WIN", grossR: 1, netR: 0.9 }));
    expect(buildIntradayMomentumReport(few).edgeReady).toBe(false);
  });
});

describe("intraday momentum hunter — report-only enrichment (order-flow + decision score)", () => {
  it("records enrichment fields when enrichSignal succeeds, without changing whether the signal is recorded", async () => {
    const { runIntradayMomentumCycle, IntradayMomentumStore } = await import("../src/lib/intraday-momentum-edge.js");
    const store = new IntradayMomentumStore(`/tmp/im-test-${Math.random()}.json`);
    const candles = (() => {
      let tt = 1_000_000_000_000;
      const bars = [];
      for (let i = 0; i < 30; i++) {
        tt += 3_600_000;
        bars.push({ openTime: tt, open: 100, high: 101, low: 99, close: 100, volume: 100 });
      }
      tt += 3_600_000;
      bars.push({ openTime: tt, open: 108, high: 108.5, low: 100.5, close: 108, volume: 400 });
      return bars;
    })();
    const result = await runIntradayMomentumCycle({
      store,
      universe: ["ENRICHUSDT"],
      now: candles[candles.length - 1]!.openTime + 1,
      fetchCandles: async () => candles,
      enrichSignal: async () => ({ takerBuyRatio: 0.72, spreadBps: 3, decisionScore: 81 }),
    });
    expect(result.recorded).toBe(1);
    const obs = store.all[0]!;
    expect(obs.takerBuyRatioAtEntry).toBeCloseTo(0.72, 6);
    expect(obs.spreadBpsAtEntry).toBeCloseTo(3, 6);
    expect(obs.decisionScoreAtEntry).toBe(81);
  });

  it("still records the signal (with null enrichment) when enrichSignal throws", async () => {
    const { runIntradayMomentumCycle, IntradayMomentumStore } = await import("../src/lib/intraday-momentum-edge.js");
    const store = new IntradayMomentumStore(`/tmp/im-test-${Math.random()}.json`);
    const candles = (() => {
      let tt = 1_000_000_000_000;
      const bars = [];
      for (let i = 0; i < 30; i++) {
        tt += 3_600_000;
        bars.push({ openTime: tt, open: 100, high: 101, low: 99, close: 100, volume: 100 });
      }
      tt += 3_600_000;
      bars.push({ openTime: tt, open: 108, high: 108.5, low: 100.5, close: 108, volume: 400 });
      return bars;
    })();
    const result = await runIntradayMomentumCycle({
      store,
      universe: ["FAILUSDT"],
      now: candles[candles.length - 1]!.openTime + 1,
      fetchCandles: async () => candles,
      enrichSignal: async () => {
        throw new Error("network blip");
      },
    });
    expect(result.recorded).toBe(1); // recording still succeeds
    expect(store.all[0]!.decisionScoreAtEntry).toBeNull();
  });
});

describe("intraday momentum hunter — live execution wiring adapters", () => {
  it("[intradayMomentumOpenSignals] maps only OPEN observations into the generic executor's fresh-signal shape", () => {
    const store = new IntradayMomentumStore(`/tmp/im-adapter-${Date.now()}-${Math.random()}.json`);
    store.add(obs({ observationId: "im:A:1", symbol: "AUSDT", status: "OPEN" }));
    store.add(obs({ observationId: "im:B:1", symbol: "BUSDT", status: "CLOSED_WIN" }));
    const signals = intradayMomentumOpenSignals(store);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      observationId: "im:A:1",
      symbol: "AUSDT",
      entryPrice: 100,
      stopPrice: 100 - IM_ATR_STOP_MULT * 4,
      openedAtMs: 1_000_000_000_000,
    });
  });

  it("[intradayMomentumOpenSignals] returns an empty array when the store has no OPEN observations", () => {
    const store = new IntradayMomentumStore(`/tmp/im-adapter-${Date.now()}-${Math.random()}.json`);
    store.add(obs({ status: "CLOSED_LOSS" }));
    expect(intradayMomentumOpenSignals(store)).toEqual([]);
  });

  it("[intradayMomentumExitPolicy] exits at INITIAL_STOP once price reaches -1R on a LONG", () => {
    const policy = intradayMomentumExitPolicy();
    const decision = policy({ direction: "LONG", entryPrice: 100, stopPrice: 95, currentPrice: 95, peakFavorableR: 0, msHeld: 1000 });
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe("INITIAL_STOP");
  });

  it("[intradayMomentumExitPolicy] banks MFE_GIVEBACK once armed and price retraces past the giveback line", () => {
    const policy = intradayMomentumExitPolicy();
    // Simulate an already-armed peak of 1.0R (>= IM_MFE_ARM_R) fed back in, then a retrace to 0.4R —
    // below the giveback line (peak * (1 - IM_MFE_GIVEBACK_FRAC) = 0.5).
    const decision = policy({ direction: "LONG", entryPrice: 100, stopPrice: 95, currentPrice: 102, peakFavorableR: 1.0, msHeld: 1000 });
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe("MFE_GIVEBACK");
    expect(decision.nextPeakFavorableR).toBe(1.0);
  });

  it("[intradayMomentumExitPolicy] does NOT giveback-exit before the arm threshold is reached", () => {
    const policy = intradayMomentumExitPolicy();
    // r = 0.6R — favorable but below IM_MFE_ARM_R (0.75), so no giveback line applies yet.
    const decision = policy({ direction: "LONG", entryPrice: 100, stopPrice: 95, currentPrice: 103, peakFavorableR: 0, msHeld: 1000 });
    expect(decision.shouldExit).toBe(false);
    expect(decision.nextPeakFavorableR).toBeCloseTo(0.6, 6);
  });

  it("[intradayMomentumExitPolicy] falls back to MAX_HOLD_MTM once IM_MAX_HOLD_BARS worth of ms has elapsed", () => {
    const policy = intradayMomentumExitPolicy();
    const decision = policy({
      direction: "LONG", entryPrice: 100, stopPrice: 95, currentPrice: 100.5, peakFavorableR: 0,
      msHeld: IM_MAX_HOLD_BARS * 3_600_000,
    });
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe("MAX_HOLD_MTM");
  });

  it("[intradayMomentumExitPolicy] stays open when neither stop, giveback, nor max-hold has been reached", () => {
    const policy = intradayMomentumExitPolicy();
    const decision = policy({ direction: "LONG", entryPrice: 100, stopPrice: 95, currentPrice: 100.5, peakFavorableR: 0, msHeld: 1000 });
    expect(decision.shouldExit).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it("[isIntradayMomentumExecEnabled] is off by default and only on with the exact '1' flag", () => {
    expect(isIntradayMomentumExecEnabled({})).toBe(false);
    expect(isIntradayMomentumExecEnabled({ INTRADAY_MOMENTUM_EXEC_ENABLED: "true" })).toBe(false);
    expect(isIntradayMomentumExecEnabled({ INTRADAY_MOMENTUM_EXEC_ENABLED: "1" })).toBe(true);
  });

  describe("IM_EXEC_* config readers", () => {
    const keys = [
      "INTRADAY_MOMENTUM_EXEC_LEG_USD",
      "INTRADAY_MOMENTUM_EXEC_LEVERAGE",
      "INTRADAY_MOMENTUM_EXEC_MAX_SIGNAL_AGE_MS",
      "INTRADAY_MOMENTUM_EXEC_DAILY_MAX_LOSS_USD",
      "INTRADAY_MOMENTUM_EXEC_MAX_CONCURRENT",
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

    it("IM_EXEC_LEG_USD defaults to 25 and honors a valid positive override", () => {
      expect(IM_EXEC_LEG_USD()).toBe(25);
      process.env.INTRADAY_MOMENTUM_EXEC_LEG_USD = "40";
      expect(IM_EXEC_LEG_USD()).toBe(40);
    });

    it("IM_EXEC_LEG_USD ignores a non-positive or garbage override and falls back to the default", () => {
      process.env.INTRADAY_MOMENTUM_EXEC_LEG_USD = "-5";
      expect(IM_EXEC_LEG_USD()).toBe(25);
      process.env.INTRADAY_MOMENTUM_EXEC_LEG_USD = "not-a-number";
      expect(IM_EXEC_LEG_USD()).toBe(25);
    });

    it("IM_EXEC_LEVERAGE defaults to 3, floors a fractional override, rejects <1", () => {
      expect(IM_EXEC_LEVERAGE()).toBe(3);
      process.env.INTRADAY_MOMENTUM_EXEC_LEVERAGE = "5";
      expect(IM_EXEC_LEVERAGE()).toBe(5);
      process.env.INTRADAY_MOMENTUM_EXEC_LEVERAGE = "0";
      expect(IM_EXEC_LEVERAGE()).toBe(3);
    });

    it("IM_EXEC_MAX_SIGNAL_AGE_MS defaults to 50 minutes and floors at 60s", () => {
      expect(IM_EXEC_MAX_SIGNAL_AGE_MS()).toBe(50 * 60_000);
      process.env.INTRADAY_MOMENTUM_EXEC_MAX_SIGNAL_AGE_MS = "1000";
      expect(IM_EXEC_MAX_SIGNAL_AGE_MS()).toBe(60_000); // floored
      process.env.INTRADAY_MOMENTUM_EXEC_MAX_SIGNAL_AGE_MS = "120000";
      expect(IM_EXEC_MAX_SIGNAL_AGE_MS()).toBe(120_000);
    });

    it("IM_EXEC_DAILY_MAX_LOSS_USD defaults to 0 (no cap) and honors a positive override", () => {
      expect(IM_EXEC_DAILY_MAX_LOSS_USD()).toBe(0);
      process.env.INTRADAY_MOMENTUM_EXEC_DAILY_MAX_LOSS_USD = "15";
      expect(IM_EXEC_DAILY_MAX_LOSS_USD()).toBe(15);
    });

    it("IM_EXEC_MAX_CONCURRENT defaults to 1 (matching the executor's own prior hardcoded default) and honors a positive override", () => {
      expect(IM_EXEC_MAX_CONCURRENT()).toBe(1);
      process.env.INTRADAY_MOMENTUM_EXEC_MAX_CONCURRENT = "5";
      expect(IM_EXEC_MAX_CONCURRENT()).toBe(5);
    });

    it("IM_EXEC_MAX_CONCURRENT ignores <1 or garbage and falls back to the default", () => {
      process.env.INTRADAY_MOMENTUM_EXEC_MAX_CONCURRENT = "0";
      expect(IM_EXEC_MAX_CONCURRENT()).toBe(1);
      process.env.INTRADAY_MOMENTUM_EXEC_MAX_CONCURRENT = "not-a-number";
      expect(IM_EXEC_MAX_CONCURRENT()).toBe(1);
    });
  });
});

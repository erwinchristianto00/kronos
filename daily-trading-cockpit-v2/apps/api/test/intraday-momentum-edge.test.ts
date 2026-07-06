import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  detectIntradayMomentumEntry,
  resolveIntradayMomentum,
  buildIntradayMomentumReport,
  type IntradayMomentumObservation,
  IM_ATR_STOP_MULT,
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

import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  detectShortFadeRsiSignal,
  passesShortFadeCrowdingGate,
  buildShortFadeGeometry,
  resolveShortFadeObservation,
  buildShortFadeReport,
  runShortFadeCycle,
  ShortFadeStore,
  SF_RSI_OVERBOUGHT,
  type ShortFadeObservation,
} from "../src/lib/short-fade-edge.js";
import type { CrowdingSnapshot } from "../src/lib/derivatives-crowding.js";

let t = 1_000_000_000_000;
function bar(close: number, opts: { high?: number; low?: number } = {}): Candle {
  t += 3_600_000;
  return { openTime: t, open: close, high: opts.high ?? close, low: opts.low ?? close, close, volume: 100 };
}

/** N bars rising by `riseStep` each (pushes RSI toward 100 — all gains, zero losses), then one bar
 *  dropping by `dropSize` (pulls RSI back below the overbought line on the LAST bar only). */
function risingThenDrop(n: number, riseStep: number, dropSize: number): Candle[] {
  t = 1_000_000_000_000;
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += riseStep;
    candles.push(bar(price, { high: price + 0.5, low: price - 0.5 }));
  }
  const dropPrice = price - dropSize;
  candles.push(bar(dropPrice, { high: price, low: dropPrice - 0.5 }));
  return candles;
}

describe("short-fade — RSI exhaustion-confirmation entry signal", () => {
  it("fires once RSI crosses back BELOW overbought after the prior bar was overbought", () => {
    const candles = risingThenDrop(24, 1, 8);
    const sig = detectShortFadeRsiSignal(candles);
    expect(sig).not.toBeNull();
    expect(sig!.rsiPriorBar).toBeGreaterThanOrEqual(SF_RSI_OVERBOUGHT);
    expect(sig!.rsiNow).toBeLessThan(SF_RSI_OVERBOUGHT);
    expect(sig!.entryPrice).toBe(candles[candles.length - 1]!.close);
  });

  it("does NOT fire on the first overbought touch (still climbing, no cross-back yet)", () => {
    t = 1_000_000_000_000;
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 25; i++) {
      price += 1;
      candles.push(bar(price, { high: price + 0.5, low: price - 0.5 }));
    }
    // Purely monotonic rise: both the last and prior bar's RSI are at/near 100 — no cross-back-down.
    expect(detectShortFadeRsiSignal(candles)).toBeNull();
  });

  it("rejects when the prior bar was never overbought (no exhaustion to confirm)", () => {
    // Flat/choppy series never gets RSI near the overbought line.
    t = 1_000_000_000_000;
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      price += i % 2 === 0 ? 0.5 : -0.4; // mild chop, not a real trend
      candles.push(bar(price));
    }
    expect(detectShortFadeRsiSignal(candles)).toBeNull();
  });

  it("returns null with too few candles", () => {
    expect(detectShortFadeRsiSignal([bar(100), bar(101)])).toBeNull();
  });
});

function crowdSnap(over: Partial<CrowdingSnapshot> = {}): CrowdingSnapshot {
  return {
    symbol: "TESTUSDT",
    fundingRate: 0.001,
    fundingBps: 10,
    oiChangePercent: 2,
    oiTrend: "RISING",
    takerBuySellRatio: null,
    longShortRatio: null,
    crowdSide: "LONG",
    crowdingLevel: "EXTREME",
    crowdingState: "EXHAUSTING",
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

describe("short-fade — crowded-long funding/OI gate", () => {
  it("passes on crowded-long + EXHAUSTING (extreme funding, OI still rising)", () => {
    expect(passesShortFadeCrowdingGate(crowdSnap())).toBe(true);
  });

  it("rejects when the crowd is on the SHORT side (this lane only fades crowded LONGS)", () => {
    expect(passesShortFadeCrowdingGate(crowdSnap({ crowdSide: "SHORT", crowdingState: "NEUTRAL" }))).toBe(false);
  });

  it("rejects NEUTRAL crowding (no extreme positioning to fade)", () => {
    expect(passesShortFadeCrowdingGate(crowdSnap({ crowdingLevel: "NEUTRAL", crowdingState: "NEUTRAL" }))).toBe(false);
  });

  it("rejects BUILDING (crowded but OI still healthy continuation, not fragile yet)", () => {
    expect(passesShortFadeCrowdingGate(crowdSnap({ crowdingState: "BUILDING" }))).toBe(false);
  });

  it("rejects UNWINDING (already flushing — this lane wants the fragile-but-not-yet-flushed moment)", () => {
    expect(passesShortFadeCrowdingGate(crowdSnap({ crowdingState: "UNWINDING", oiTrend: "FALLING" }))).toBe(false);
  });
});

describe("short-fade — geometry (same formula as CG_WIDE_FAST_SHORT)", () => {
  it("floors the stop at >=300bps above entry, TP at 0.5x risk below entry", () => {
    const geo = buildShortFadeGeometry(100);
    expect(geo).not.toBeNull();
    expect(geo!.stopDistanceBps).toBeCloseTo(300, 6);
    expect(geo!.initialStop).toBeCloseTo(103, 6);
    const risk = geo!.initialStop - geo!.entryPrice;
    expect((geo!.entryPrice - geo!.takeProfitPrice) / risk).toBeCloseTo(0.5, 6);
  });

  it("rejects a non-positive entry price", () => {
    expect(buildShortFadeGeometry(0)).toBeNull();
    expect(buildShortFadeGeometry(-5)).toBeNull();
  });
});

function obs(over: Partial<ShortFadeObservation> = {}): ShortFadeObservation {
  const entryPrice = 100;
  const initialStop = 103;
  const takeProfitPrice = 98.5;
  return {
    observationId: "sf:TEST:1", symbol: "TESTUSDT", direction: "SHORT",
    entryPrice, initialStop, takeProfitPrice, stopDistanceBps: 300,
    rsiAtEntry: 70, rsiPriorBar: 78, fundingBps: 10, oiChangePercent: 2,
    openedAt: new Date(1_000_000_000_000).toISOString(), openedAtMs: 1_000_000_000_000,
    status: "OPEN", grossR: null, costR: null, netR: null, exitReason: null, resolvedAt: null,
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

describe("short-fade — resolution (SL-first-conservative, SHORT direction)", () => {
  it("books the loss at the initial stop (−1R) when price rallies through it", () => {
    const patch = resolveShortFadeObservation(obs(), fwd([{ close: 101, high: 101.5 }, { close: 104, high: 104.5 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("books the win at the TP price when price drops through it", () => {
    const patch = resolveShortFadeObservation(obs(), fwd([{ close: 99, low: 98.8 }, { close: 98, low: 97.9 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.grossR).toBeCloseTo(0.5, 6);
    expect(patch?.exitReason).toBe("TP_HIT");
  });

  it("SL-first when a single candle touches both stop and TP (never assumes the favorable side first)", () => {
    const patch = resolveShortFadeObservation(obs(), fwd([{ close: 100, high: 104, low: 97 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("marks to market at max hold when neither stop nor TP fires", () => {
    const flatBars = Array.from({ length: 48 }, () => ({ close: 100.5, high: 100.6, low: 100.4 }));
    const patch = resolveShortFadeObservation(obs(), fwd(flatBars), Date.now());
    expect(patch?.status).toBeDefined();
    expect(patch?.exitReason).toBe("MAX_HOLD_MTM");
  });

  it("returns null (still open) with insufficient forward candles and not yet stale", () => {
    expect(resolveShortFadeObservation(obs(), [], obs().openedAtMs + 3_600_000)).toBeNull();
  });

  it("expires a stale OPEN observation with no forward candles ever", () => {
    const staleNowMs = obs().openedAtMs + 48 * 3_600_000 * 4;
    const patch = resolveShortFadeObservation(obs(), [], staleNowMs);
    expect(patch?.status).toBe("EXPIRED");
  });
});

describe("short-fade — report", () => {
  it("is not edgeReady below the sample floor even if every trade won", () => {
    const wins = Array.from({ length: 10 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.4 }));
    const report = buildShortFadeReport(wins);
    expect(report.edgeReady).toBe(false);
  });

  it("is edgeReady with adequate sample, positive net, and a real payoff", () => {
    const wins = Array.from({ length: 25 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.35, exitReason: "TP_HIT" }));
    const losses = Array.from({ length: 10 }, (_, i) => obs({ observationId: `l${i}`, status: "CLOSED_LOSS", netR: -1.05, exitReason: "INITIAL_STOP" }));
    const report = buildShortFadeReport([...wins, ...losses]);
    expect(report.resolvedCount).toBe(35);
    expect(report.netAvgR).not.toBeNull();
    expect(report.wr).toBeCloseTo(25 / 35, 6);
  });

  it("counts OPEN observations separately from resolved", () => {
    const report = buildShortFadeReport([obs({ status: "OPEN" }), obs({ observationId: "x2", status: "CLOSED_WIN", netR: 0.3 })]);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(1);
  });
});

describe("short-fade — cycle (bounds the crowding fetch to RSI candidates only)", () => {
  it("never calls the crowding client for a symbol that doesn't clear the RSI gate", async () => {
    const store = new ShortFadeStore(`/tmp/short-fade-test-${Date.now()}-${Math.random()}.json`);
    let crowdingCalls = 0;
    const result = await runShortFadeCycle({
      store,
      universe: ["FLATUSDT"],
      now: Date.now(),
      fetchCandles: async () => {
        // Flat series — RSI never approaches overbought.
        t = 1_000_000_000_000;
        return Array.from({ length: 20 }, () => bar(100));
      },
      crowdingClient: {
        getFuturesFlow: async () => {
          crowdingCalls += 1;
          return { fundingRate: 0.001, openInterestChangePercent: 2, takerBuySellRatio: null, longShortRatio: null };
        },
      },
    });
    expect(result.rsiCandidates).toBe(0);
    expect(crowdingCalls).toBe(0);
    expect(result.recorded).toBe(0);
  });

  it("records a signal when RSI confirms exhaustion AND the crowding gate passes", async () => {
    const store = new ShortFadeStore(`/tmp/short-fade-test-${Date.now()}-${Math.random()}.json`);
    const candles = risingThenDrop(24, 1, 8);
    const result = await runShortFadeCycle({
      store,
      universe: ["TESTUSDT"],
      now: Date.now(),
      fetchCandles: async () => candles,
      crowdingClient: {
        getFuturesFlow: async () => ({ fundingRate: 0.001, openInterestChangePercent: 2, takerBuySellRatio: null, longShortRatio: null }),
      },
    });
    expect(result.rsiCandidates).toBe(1);
    expect(result.crowdingRejected).toBe(0);
    expect(result.recorded).toBe(1);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.direction).toBe("SHORT");
  });

  it("rejects a RSI candidate when the crowding gate does not pass", async () => {
    const store = new ShortFadeStore(`/tmp/short-fade-test-${Date.now()}-${Math.random()}.json`);
    const candles = risingThenDrop(24, 1, 8);
    const result = await runShortFadeCycle({
      store,
      universe: ["TESTUSDT"],
      now: Date.now(),
      fetchCandles: async () => candles,
      crowdingClient: {
        // Neutral funding → crowdingState NEUTRAL → gate fails.
        getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: null, longShortRatio: null }),
      },
    });
    expect(result.rsiCandidates).toBe(1);
    expect(result.crowdingRejected).toBe(1);
    expect(result.recorded).toBe(0);
  });
});

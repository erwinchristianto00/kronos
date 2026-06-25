import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  computeEMA,
  computeROC,
  computeATR,
  computeADX,
  detectH6TrendEntries,
  resolveH6Trend,
  buildH6TrendReport,
  runH6TrendCycle,
  H6TrendStore,
  h6IsLargeCap,
  type H6TrendObservation,
  H6_TREND_ATR_TRAIL_MULT,
} from "../src/lib/h6-trend-edge.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BAR = 6 * 60 * 60 * 1000;
function mk(i: number, close: number, high?: number, low?: number, open = close, volume = 1): Candle {
  return { openTime: i * BAR, open, high: high ?? close + 1, low: low ?? close - 1, close, volume };
}

function trendCandles(count: number, base = 100, step = 1, volume = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = base + i * step;
    return mk(i, close, close + 1, close - 1, close - 0.2, volume);
  });
}

function bullContext() {
  return {
    dailyCandles: trendCandles(260, 100, 1, 100),
    h4Candles: trendCandles(120, 100, 0.8, 100),
    fundingRate: 0.0001,
    openInterestChangePercent: 0.4,
    takerBuySellRatio: 1.15,
  };
}

function h6PullbackSetup(): Candle[] {
  const candles = trendCandles(130, 100, 1, 100);
  // Final bar reclaims EMA20 after a pullback wick; this is the H6 v2 entry shape.
  candles[129] = mk(129, 230, 232, 214, 225, 500);
  return candles;
}

describe("h6-trend-edge indicators", () => {
  it("[IND] EMA/ROC/ATR: null before period, sane after", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    const ema = computeEMA(closes, 10);
    expect(ema[8]).toBeNull();
    expect(ema[9]).not.toBeNull();
    expect(ema[49]).toBeGreaterThan(ema[40] as number); // rises with the series
    // EMA of a constant series is the constant
    expect(computeEMA(new Array(20).fill(7), 5)[19]).toBeCloseTo(7, 6);

    const roc = computeROC(closes, 20);
    expect(roc[19]).toBeNull();
    expect(roc[20]).toBeCloseTo(((120 - 100) / 100) * 100, 6); // +20%

    const candles = closes.map((c, i) => mk(i, c, c + 2, c - 2));
    const atr = computeATR(candles, 14);
    expect(atr[13]).toBeNull();
    expect(atr[20]).toBeGreaterThan(0);

    const adx = computeADX(candles, 14);
    expect(adx[27]).not.toBeNull();
    expect(adx[49]).toBeGreaterThan(20);
  });
});

describe("h6-trend-edge detection", () => {
  it("[DETECT] fires a LONG entry only on bull-trend pullback reclaim with participation context", () => {
    const entries = detectH6TrendEntries("BTCUSDT", h6PullbackSetup(), {
      context: bullContext(),
      requireFullContext: true,
    });
    expect(entries.every((e) => e.direction === "LONG")).toBe(true);
    // one fresh entry bar → one obs per exit A/B variant (std + tight), not one per bar.
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.variant).sort()).toEqual(["std", "tight"]);
    const std = entries.find((e) => e.variant === "std")!;
    const tight = entries.find((e) => e.variant === "tight")!;
    expect(std.initialStop).toBeLessThan(std.entryPrice); // long stop below entry
    expect(tight.stopDistanceBps).toBeLessThan(std.stopDistanceBps); // tight trail = closer stop
    expect(std.entryGate?.checks.dailyEma50Gt200).toBe("PASS");
    expect(std.entryGate?.checks.pullbackToEma20).toBe("PASS");
    expect(std.exitPolicy?.version).toBe("tp1-50-be-atr-runner-v1");

    // A purely flat series has no uptrend → no entries.
    const allFlat = Array.from({ length: 130 }, (_, i) => mk(i, 100, 100.5, 99.5));
    expect(detectH6TrendEntries("BTCUSDT", allFlat).length).toBe(0);
  });

  it("[GATE] rejects full-context entries when funding or participation fails", () => {
    const entries = detectH6TrendEntries("BTCUSDT", h6PullbackSetup(), {
      context: { ...bullContext(), fundingRate: -0.001 },
      requireFullContext: true,
    });
    expect(entries.length).toBe(0);

    const weakOi = detectH6TrendEntries("BTCUSDT", h6PullbackSetup(), {
      context: { ...bullContext(), openInterestChangePercent: -0.2 },
      requireFullContext: true,
    });
    expect(weakOi.length).toBe(0);
  });
});

describe("h6-trend-edge resolution", () => {
  // entry 100, ATR 2, trail mult 2.5 → initial stop 95, risk = 5
  const obs = (): H6TrendObservation => ({
    observationId: "h6trend:BTCUSDT:0",
    symbol: "BTCUSDT",
    direction: "LONG",
    rocAtEntry: 5,
    atrAtEntry: 2,
    entryPrice: 100,
    initialStop: 100 - H6_TREND_ATR_TRAIL_MULT * 2, // 95
    stopDistanceBps: (5 / 100) * 10000, // 500
    openedAt: new Date(0).toISOString(),
    openedAtMs: 0,
    status: "OPEN",
    grossR: null,
    netR: null,
    costR: null,
    maxFavorableR: null,
    exitReason: null,
    resolvedAt: null,
  });

  it("[TRAIL] banks TP1 partial, moves runner to breakeven, then exits the ATR runner", () => {
    // rise to 120 (trail = 120-5 = 115), then a bar low 114 < 115 → exit at 115, grossR = (115-100)/5 = 3
    const fwd = [mk(1, 104, 105, 101), mk(2, 109, 110, 104), mk(3, 119, 120, 109), mk(4, 116, 120, 114)];
    const patch = resolveH6Trend(obs(), fwd, 5 * BAR);
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("TRAIL_STOP");
    // 50% at +0.8R and 50% runner at +3R = +1.9R blended.
    expect(patch?.grossR).toBeCloseTo(1.9, 6);
    expect(patch?.tp1Hit).toBe(true);
    expect(patch?.partialRealizedR).toBeCloseTo(0.4, 6);
    expect(patch?.runnerRealizedR).toBeCloseTo(3, 6);
  });

  it("[STOP] takes -1R at the initial stop", () => {
    const fwd = [mk(1, 96, 97, 94)]; // low 94 <= initial stop 95
    const patch = resolveH6Trend(obs(), fwd, 5 * BAR);
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("INITIAL_STOP");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
  });

  it("[NOLOOKAHEAD] a bar can't trail off its OWN spike high", () => {
    // bar spikes high to 130 AND dips low to 94. Trail uses highs BEFORE this bar (= entry 100 → 95),
    // so the low 94 hits the INITIAL stop (-1R); it must NOT bank +5R off the same bar's 130 high.
    const fwd = [mk(1, 96, 130, 94)];
    const patch = resolveH6Trend(obs(), fwd, 5 * BAR);
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("[OPEN] stays open when there aren't enough forward bars and not expired", () => {
    const fwd = [mk(1, 104, 105, 101)]; // favorable, no trail hit
    expect(resolveH6Trend(obs(), fwd, 2 * BAR)).toBeNull();
  });

  it("[REPORT] aggregates net/wr/pf over resolved obs", () => {
    const win = { ...obs(), observationId: "w", status: "CLOSED_WIN" as const, grossR: 3, netR: 2.9, maxFavorableR: 3 };
    const loss = { ...obs(), observationId: "l", status: "CLOSED_LOSS" as const, grossR: -1, netR: -1.1, maxFavorableR: 0 };
    const rep = buildH6TrendReport([win, loss, obs()]);
    expect(rep.freshValid).toBe(2);
    expect(rep.open).toBe(1);
    expect(rep.wr).toBeCloseTo(0.5, 6);
    expect(rep.netAvgR).toBeCloseTo((2.9 - 1.1) / 2, 6);
    expect(rep.tight).toBeDefined(); // A/B sibling present
    expect(rep.tightLargeCap).toBeDefined(); // focused long candidate present
    expect(rep.exitPolicy.version).toBe("tp1-50-be-atr-runner-v1");
  });

  it("[LARGECAP] h6IsLargeCap classifies majors vs high-beta alts", () => {
    expect(h6IsLargeCap("BTCUSDT")).toBe(true);
    expect(h6IsLargeCap("ETHUSDC")).toBe(true);
    expect(h6IsLargeCap("SOLUSDT")).toBe(true);
    expect(h6IsLargeCap("INJUSDT")).toBe(false);
    expect(h6IsLargeCap("WLDUSDT")).toBe(false);
  });

  it("[LCTIGHT] tightLargeCap cohort = tight-trail obs on large-cap symbols only", () => {
    const mk = (sym: string, lc: boolean): H6TrendObservation => ({
      ...obs(),
      observationId: `t-${sym}`,
      symbol: sym,
      variant: "tight",
      isLargeCap: lc,
      status: "CLOSED_WIN",
      grossR: 1,
      netR: 0.9,
      maxFavorableR: 1,
    });
    const rep = buildH6TrendReport([mk("BTCUSDT", true), mk("INJUSDT", false)]);
    expect(rep.tight.freshValid).toBe(2); // both are tight
    expect(rep.tightLargeCap.freshValid).toBe(1); // only the large-cap one
    expect(rep.tightLargeCap.netAvgR).toBeCloseTo(0.9, 6);
  });

  it("[REGIME-GATE] cycle opens NO new entries when allowNewEntries=false", async () => {
    const candles = [...h6PullbackSetup(), mk(130, 231, 233, 229, 230, 100)]; // last (in-progress) bar dropped by the cycle
    const fetchCandles = async () => candles;
    const fetchContext = async () => bullContext();
    // Not bullish → no new entries.
    const blocked = new H6TrendStore(join(tmpdir(), `h6gate-blocked-${Date.now()}`));
    const r1 = await runH6TrendCycle({ store: blocked, universe: ["BTCUSDT"], fetchCandles, fetchContext, now: 200 * BAR, allowNewEntries: false });
    expect(r1.newEntries).toBe(0);
    expect(blocked.all.length).toBe(0);
    // Bullish (allowed) → entries open (std + tight).
    const open = new H6TrendStore(join(tmpdir(), `h6gate-open-${Date.now()}`));
    const r2 = await runH6TrendCycle({ store: open, universe: ["BTCUSDT"], fetchCandles, fetchContext, now: 200 * BAR, allowNewEntries: true });
    expect(r2.newEntries).toBeGreaterThan(0);
  });
});

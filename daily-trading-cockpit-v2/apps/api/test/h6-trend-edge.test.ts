import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  computeEMA,
  computeROC,
  computeATR,
  detectH6TrendEntries,
  resolveH6Trend,
  buildH6TrendReport,
  runH6TrendCycle,
  H6TrendStore,
  type H6TrendObservation,
  H6_TREND_ATR_TRAIL_MULT,
} from "../src/lib/h6-trend-edge.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BAR = 6 * 60 * 60 * 1000;
function mk(i: number, close: number, high?: number, low?: number): Candle {
  return { openTime: i * BAR, open: close, high: high ?? close + 1, low: low ?? close - 1, close, volume: 1 };
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
  });
});

describe("h6-trend-edge detection", () => {
  it("[DETECT] fires a fresh LONG entry on a base→uptrend, none on a flat series", () => {
    // 90 flat bars (EMAs converge to 100) then a steady ramp up.
    const flat = Array.from({ length: 90 }, (_, i) => mk(i, 100, 100.5, 99.5));
    const ramp = Array.from({ length: 40 }, (_, k) => {
      const c = 101 + k; // 101..140
      return mk(90 + k, c, c + 1, c - 1);
    });
    const entries = detectH6TrendEntries("BTCUSDT", [...flat, ...ramp]);
    expect(entries.every((e) => e.direction === "LONG")).toBe(true);
    // one fresh entry bar → one obs per exit A/B variant (std + tight), not one per bar.
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.variant).sort()).toEqual(["std", "tight"]);
    const std = entries.find((e) => e.variant === "std")!;
    const tight = entries.find((e) => e.variant === "tight")!;
    expect(std.initialStop).toBeLessThan(std.entryPrice); // long stop below entry
    expect(tight.stopDistanceBps).toBeLessThan(std.stopDistanceBps); // tight trail = closer stop

    // A purely flat series has no uptrend → no entries.
    const allFlat = Array.from({ length: 130 }, (_, i) => mk(i, 100, 100.5, 99.5));
    expect(detectH6TrendEntries("BTCUSDT", allFlat).length).toBe(0);
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

  it("[TRAIL] banks a winner when price runs up then pierces the chandelier trail", () => {
    // rise to 120 (trail = 120-5 = 115), then a bar low 114 < 115 → exit at 115, grossR = (115-100)/5 = 3
    const fwd = [mk(1, 104, 105, 101), mk(2, 109, 110, 104), mk(3, 119, 120, 109), mk(4, 116, 120, 114)];
    const patch = resolveH6Trend(obs(), fwd, 5 * BAR);
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("TRAIL_STOP");
    expect(patch?.grossR).toBeCloseTo(3, 6);
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
  });

  it("[REGIME-GATE] cycle opens NO new entries when allowNewEntries=false", async () => {
    const flat = Array.from({ length: 90 }, (_, i) => mk(i, 100, 100.5, 99.5));
    const ramp = Array.from({ length: 40 }, (_, k) => { const c = 101 + k; return mk(90 + k, c, c + 1, c - 1); });
    const candles = [...flat, ...ramp, mk(130, 142, 143, 141)]; // last (in-progress) bar dropped by the cycle
    const fetchCandles = async () => candles;
    // Not bullish → no new entries.
    const blocked = new H6TrendStore(join(tmpdir(), `h6gate-blocked-${Date.now()}`));
    const r1 = await runH6TrendCycle({ store: blocked, universe: ["BTCUSDT"], fetchCandles, now: 200 * BAR, allowNewEntries: false });
    expect(r1.newEntries).toBe(0);
    expect(blocked.all.length).toBe(0);
    // Bullish (allowed) → entries open (std + tight).
    const open = new H6TrendStore(join(tmpdir(), `h6gate-open-${Date.now()}`));
    const r2 = await runH6TrendCycle({ store: open, universe: ["BTCUSDT"], fetchCandles, now: 200 * BAR, allowNewEntries: true });
    expect(r2.newEntries).toBeGreaterThan(0);
  });
});

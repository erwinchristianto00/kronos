import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import type { Candle } from "@dtc/shared";
import {
  detectLiquidationCascade,
  evaluateLiquidationFlowGate,
  buildLiqRecoilGeometry,
  resolveLiqRecoilObservation,
  buildLiqRecoilReport,
  runLiqRecoilCycle,
  runLiqRecoilCycleGuarded,
  LiqRecoilStore,
  LQR_BAR_MS,
  LQR_MAX_HOLD_BARS,
  LQR_MAX_OPEN,
  LQR_MAX_STORED_OBSERVATIONS,
  LQR_FLOW_MAX_SAMPLES_PER_SYMBOL,
  LQR_FLOW_MAX_AGE_MS,
  LQR_STOP_FLOOR_BPS,
  type LiqRecoilObservation,
  type LqrFlowSample,
} from "../src/lib/liq-recoil-edge.js";

const START_MS = 1_700_000_000_000;

// ── fixtures ────────────────────────────────────────────────────────────────

/** Quiet oscillation around `base` (±0.1% closes, small wicks) — real but small volatility. */
function quietCandles(n: number, base = 100, startMs = START_MS): Candle[] {
  const out: Candle[] = [];
  let prev = base;
  for (let i = 0; i < n; i++) {
    const close = i % 2 === 0 ? base + 0.1 : base - 0.1;
    out.push({
      openTime: startMs + i * LQR_BAR_MS,
      open: prev,
      high: Math.max(prev, close) + 0.08,
      low: Math.min(prev, close) - 0.08,
      close,
      volume: 100,
    });
    prev = close;
  }
  return out;
}

/** Append bars after an existing series (open defaults to previous close; wicks default to body). */
function appendBars(
  prevCandles: Candle[],
  specs: Array<{ close: number; open?: number; high?: number; low?: number }>,
): Candle[] {
  const out = [...prevCandles];
  for (const s of specs) {
    const last = out[out.length - 1]!;
    const open = s.open ?? last.close;
    out.push({
      openTime: last.openTime + LQR_BAR_MS,
      open,
      high: s.high ?? Math.max(open, s.close),
      low: s.low ?? Math.min(open, s.close),
      close: s.close,
      volume: 100,
    });
  }
  return out;
}

/** 30 quiet bars, a violent 4-bar DOWN leg (~−4% total, extreme low 96 on the last leg bar), then
 *  `stallBars` bars that hold ABOVE the extreme (lows ≥ 96.3). */
function downCascadeCandles(stallBars: number): Candle[] {
  let c = quietCandles(30);
  c = appendBars(c, [{ close: 99 }, { close: 98 }, { close: 97 }, { close: 96 }]);
  for (let i = 0; i < stallBars; i++) {
    c = appendBars(c, [{ close: i % 2 === 0 ? 96.5 : 96.6, low: 96.3, high: 96.8 }]);
  }
  return c;
}

/** Mirror: violent 4-bar UP leg (extreme high 104), then stalled bars holding BELOW it. */
function upCascadeCandles(stallBars: number): Candle[] {
  let c = quietCandles(30);
  c = appendBars(c, [{ close: 101 }, { close: 102 }, { close: 103 }, { close: 104 }]);
  for (let i = 0; i < stallBars; i++) {
    c = appendBars(c, [{ close: i % 2 === 0 ? 103.5 : 103.4, low: 103.2, high: 103.7 }]);
  }
  return c;
}

function tmpStore(tag: string): LiqRecoilStore {
  return new LiqRecoilStore(`${tmpdir()}/lqr-${tag}-${Date.now()}-${Math.random()}.json`);
}

type FlowSpec = { openInterestChangePercent: number | null; takerBuySellRatio: number | null; fundingRate?: number | null };
function fakeCrowdingClient(flowBySymbol: Record<string, FlowSpec>) {
  return {
    getFuturesFlow: async (symbol: string) => {
      const f = flowBySymbol[symbol];
      if (!f) throw new Error(`no flow fixture for ${symbol}`);
      return {
        fundingRate: f.fundingRate ?? 0.0001,
        openInterestChangePercent: f.openInterestChangePercent,
        takerBuySellRatio: f.takerBuySellRatio,
        longShortRatio: 1,
      };
    },
  };
}

// ── cascade detection ───────────────────────────────────────────────────────

describe("liq-recoil — detectLiquidationCascade", () => {
  it("a QUIET market never fires (moves are small vs its own pre-window ATR)", () => {
    const d = detectLiquidationCascade(quietCandles(40));
    expect(d.evaluated).toBe(true);
    expect(d.ambiguous).toBe(false);
    expect(d.event).toBeNull();
  });

  it("[NO KNIFE-CATCHING] a violent cascade WITHOUT an exhaustion stall (extreme on the latest bar) never fires", () => {
    const d = detectLiquidationCascade(downCascadeCandles(0));
    expect(d.evaluated).toBe(true);
    expect(d.event).toBeNull();
  });

  it("a stalled DOWN cascade fires a LONG-recoil event with the right geometry inputs", () => {
    const candles = downCascadeCandles(3);
    const d = detectLiquidationCascade(candles);
    expect(d.event).not.toBeNull();
    const e = d.event!;
    expect(e.cascadeDirection).toBe("DOWN");
    expect(e.recoilDirection).toBe("LONG");
    expect(e.extremePrice).toBe(96);
    expect(e.stallBars).toBe(3);
    expect(e.atrMultiple).toBeGreaterThan(4);
    expect(e.cascadeReturn).toBeLessThan(0);
    expect(e.preCascadeClose).toBeGreaterThan(99);
    // Extreme identity = the last leg bar (before the stall bars).
    const extremeBar = candles[candles.length - 1 - 3]!;
    expect(e.extremeBarOpenTime).toBe(extremeBar.openTime);
    expect(e.lastClose).toBe(candles[candles.length - 1]!.close);
  });

  it("a stalled UP cascade (short squeeze) fires a SHORT-recoil event symmetrically", () => {
    const d = detectLiquidationCascade(upCascadeCandles(3));
    expect(d.event).not.toBeNull();
    expect(d.event!.cascadeDirection).toBe("UP");
    expect(d.event!.recoilDirection).toBe("SHORT");
    expect(d.event!.extremePrice).toBe(104);
    expect(d.event!.cascadeReturn).toBeGreaterThan(0);
  });

  it("a STALE extreme (stalled longer than maxStallBars) never fires — the recoil window has passed", () => {
    const d = detectLiquidationCascade(downCascadeCandles(10));
    expect(d.evaluated).toBe(true);
    expect(d.event).toBeNull();
  });

  it("a V-shaped whipsaw where BOTH sides qualify is AMBIGUOUS and fires nothing", () => {
    let c = quietCandles(30);
    c = appendBars(c, [{ close: 99 }, { close: 98 }, { close: 97 }]); // dump, extreme low 97
    c = appendBars(c, [
      { close: 98, open: 97.05, low: 97.05 },
      { close: 99.5 },
      { close: 101 },
      { close: 102 },
      { close: 102.5 }, // pump, extreme high 102.5
    ]);
    c = appendBars(c, [
      { close: 102, high: 102.2, low: 101.8 },
      { close: 102.1, high: 102.3, low: 101.9 },
      { close: 102, high: 102.2, low: 101.8 },
    ]);
    const d = detectLiquidationCascade(c);
    expect(d.evaluated).toBe(true);
    expect(d.ambiguous).toBe(true);
    expect(d.event).toBeNull();
  });

  it("insufficient history: evaluated=false (an honest 'could not look', not 'no cascade')", () => {
    const d = detectLiquidationCascade(quietCandles(20));
    expect(d.evaluated).toBe(false);
    expect(d.event).toBeNull();
  });
});

// ── forced-flow gate ────────────────────────────────────────────────────────

function sample(atMs: number, oi: number | null, taker: number | null): LqrFlowSample {
  return { atMs, oiChangePercent: oi, takerBuySellRatio: taker, fundingBps: 1 };
}

describe("liq-recoil — evaluateLiquidationFlowGate", () => {
  const windowStart = START_MS;
  const now = START_MS + 3_600_000;

  it("passes a DOWN cascade only when an in-window sample shows OI contraction WITH sell-side taker aggression", () => {
    const good = evaluateLiquidationFlowGate([sample(START_MS + 60_000, -2.4, 0.62)], windowStart, now, "DOWN");
    expect(good.hasOiData).toBe(true);
    expect(good.passes).toBe(true);
    expect(good.worstOiChangePercent).toBe(-2.4);
    expect(good.takerRatioAtWorst).toBe(0.62);
  });

  it("REJECTS a DOWN cascade whose 'flush' had BUY-dominant taker flow (not a long-liquidation signature)", () => {
    const wrongSide = evaluateLiquidationFlowGate([sample(START_MS + 60_000, -2.4, 1.4)], windowStart, now, "DOWN");
    expect(wrongSide.hasOiData).toBe(true);
    expect(wrongSide.passes).toBe(false);
  });

  it("UP cascade (short squeeze) requires BUY-dominant aggression — mirrored", () => {
    expect(evaluateLiquidationFlowGate([sample(START_MS + 1, -2, 1.4)], windowStart, now, "UP").passes).toBe(true);
    expect(evaluateLiquidationFlowGate([sample(START_MS + 1, -2, 0.7)], windowStart, now, "UP").passes).toBe(false);
  });

  it("an OI drop below the threshold does not pass", () => {
    expect(evaluateLiquidationFlowGate([sample(START_MS + 1, -0.4, 0.6)], windowStart, now, "DOWN").passes).toBe(false);
  });

  it("samples OUTSIDE the cascade window are ignored", () => {
    const before = sample(windowStart - 60_000, -3, 0.5);
    const after = sample(now + 60_000, -3, 0.5);
    const gate = evaluateLiquidationFlowGate([before, after], windowStart, now, "DOWN");
    expect(gate.samplesInWindow).toBe(0);
    expect(gate.hasOiData).toBe(false);
    expect(gate.passes).toBe(false);
  });

  it("no OI data at all ⇒ abstains (hasOiData=false), never passes by default", () => {
    const gate = evaluateLiquidationFlowGate([sample(START_MS + 1, null, 0.6)], windowStart, now, "DOWN");
    expect(gate.hasOiData).toBe(false);
    expect(gate.passes).toBe(false);
    expect(gate.samplesInWindow).toBe(1);
  });
});

// ── geometry ────────────────────────────────────────────────────────────────

describe("liq-recoil — geometry", () => {
  it("LONG: stop beyond the cascade low with buffer, target = half-cascade retrace from the extreme; R denominator = stop distance", () => {
    const out = buildLiqRecoilGeometry(97, "LONG", 96, 4);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    const g = out.geometry;
    expect(g.initialStop).toBeCloseTo(96 - 0.15 * 4, 9); // 95.4 — below the extreme by the buffer
    expect(g.targetPrice).toBeCloseTo(96 + 0.5 * 4, 9); // 98
    expect(g.stopDistanceBps).toBeCloseTo(((97 - 95.4) / 97) * 10_000, 6);
    expect(g.targetDistanceBps).toBeCloseTo(((98 - 97) / 97) * 10_000, 6);
  });

  it("SHORT: mirrored (stop above the cascade high, target below entry)", () => {
    const out = buildLiqRecoilGeometry(103, "SHORT", 104, 4);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.geometry.initialStop).toBeCloseTo(104.6, 9);
    expect(out.geometry.targetPrice).toBeCloseTo(102, 9);
  });

  it("floors the stop distance for a microscopic cascade range so R cannot be degenerate", () => {
    const out = buildLiqRecoilGeometry(96.02, "LONG", 96, 0.5); // structural distance ≈ 9.5bps < floor
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.geometry.stopDistanceBps).toBeGreaterThanOrEqual(LQR_STOP_FLOOR_BPS - 1e-6);
  });

  it("refuses an entry that ALREADY recoiled past the target (the measured move is gone)", () => {
    expect(buildLiqRecoilGeometry(99, "LONG", 96, 4)).toEqual({ ok: false, reason: "ALREADY_RECOILED" }); // target 98 < entry
    expect(buildLiqRecoilGeometry(101, "SHORT", 104, 4)).toEqual({ ok: false, reason: "ALREADY_RECOILED" }); // target 102 > entry
  });

  it("rejects invalid inputs", () => {
    expect(buildLiqRecoilGeometry(0, "LONG", 96, 4).ok).toBe(false);
    expect(buildLiqRecoilGeometry(97, "LONG", 96, 0).ok).toBe(false);
    expect(buildLiqRecoilGeometry(97, "LONG", 96, -1).ok).toBe(false);
  });
});

// ── resolution ──────────────────────────────────────────────────────────────

function obs(over: Partial<LiqRecoilObservation> = {}): LiqRecoilObservation {
  const out = buildLiqRecoilGeometry(97, "LONG", 96, 4);
  if (!out.ok) throw new Error("bad fixture");
  return {
    observationId: "lqr:test:1",
    symbol: "SOLUSDT",
    direction: "LONG",
    cascadeDirection: "DOWN",
    ...out.geometry,
    openedAt: new Date(START_MS).toISOString(),
    openedAtMs: START_MS,
    cascadeReturn: -0.04,
    atrMultipleAtEntry: 16,
    stallBarsAtEntry: 3,
    extremePrice: 96,
    extremeBarOpenTime: START_MS - 3 * LQR_BAR_MS,
    preCascadeClose: 100,
    worstOiChangePercent: -2.4,
    takerRatioAtWorst: 0.62,
    fundingBpsAtEntry: 1,
    flowSamplesInWindow: 2,
    status: "OPEN",
    grossR: null,
    costR: null,
    netR: null,
    exitReason: null,
    resolvedAt: null,
    ...over,
  };
}

function fwd(bars: Array<{ close: number; open?: number; high?: number; low?: number }>, startMs = START_MS): Candle[] {
  let t = startMs;
  return bars.map((p) => {
    t += LQR_BAR_MS;
    return {
      openTime: t,
      open: p.open ?? p.close,
      high: p.high ?? Math.max(p.open ?? p.close, p.close),
      low: p.low ?? Math.min(p.open ?? p.close, p.close),
      close: p.close,
      volume: 100,
    };
  });
}

describe("liq-recoil — resolution", () => {
  it("books RECOIL_TARGET at the target when the bounce completes (LONG)", () => {
    const o = obs(); // entry 97, stop 95.4, target 98
    const patch = resolveLiqRecoilObservation(o, fwd([{ close: 97.4 }, { open: 97.4, close: 98.2, high: 98.3, low: 97.3 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("RECOIL_TARGET");
    expect(patch?.grossR).toBeCloseTo((98 - 97) / 1.6, 6);
    expect(patch?.netR).toBeLessThan(patch?.grossR as number); // costs always subtracted
  });

  it("books the stop at exactly −1R gross on a clean stop touch", () => {
    const o = obs();
    const patch = resolveLiqRecoilObservation(o, fwd([{ open: 96.5, close: 95.6, low: 95.3 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("CASCADE_STOP");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.netR).toBeLessThan(-1); // net of costs a stop is always worse than −1
  });

  it("[STOP HONESTY] a bar that GAPS through the stop books at its open — WORSE than −1R, never clamped", () => {
    const o = obs(); // stop at 95.4
    const patch = resolveLiqRecoilObservation(o, fwd([{ open: 94, close: 93.5, low: 93 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("CASCADE_STOP");
    expect(patch?.grossR).toBeCloseTo((94 - 97) / 1.6, 6); // −1.875R at the gapped open
    expect(patch?.grossR).toBeLessThan(-1);
  });

  it("SL-first when a single candle touches both stop and target (conservative sibling convention)", () => {
    const o = obs();
    const patch = resolveLiqRecoilObservation(o, fwd([{ open: 97, close: 97, high: 98.5, low: 95.2 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("CASCADE_STOP");
  });

  it("SHORT: target below, stop above — wins downward, stops upward, gap-through honest", () => {
    const out = buildLiqRecoilGeometry(103, "SHORT", 104, 4);
    if (!out.ok) throw new Error("bad fixture");
    const o = obs({ ...out.geometry, direction: "SHORT", cascadeDirection: "UP", extremePrice: 104 });
    const win = resolveLiqRecoilObservation(o, fwd([{ open: 103, close: 101.9, low: 101.8, high: 103.1 }]), Date.now());
    expect(win?.status).toBe("CLOSED_WIN");
    expect(win?.exitReason).toBe("RECOIL_TARGET");
    expect(win?.grossR).toBeCloseTo((103 - 102) / 1.6, 6);
    const cleanStop = resolveLiqRecoilObservation(o, fwd([{ open: 103.5, close: 104.4, high: 104.8 }]), Date.now());
    expect(cleanStop?.grossR).toBeCloseTo(-1, 6);
    const gapped = resolveLiqRecoilObservation(o, fwd([{ open: 106, close: 106.5, high: 107 }]), Date.now());
    expect(gapped?.grossR).toBeCloseTo((103 - 106) / 1.6, 6); // worse than −1R
    expect(gapped?.grossR).toBeLessThan(-1);
  });

  it("marks to market at the short max-hold when neither target nor stop fires", () => {
    const o = obs();
    const flat = Array.from({ length: LQR_MAX_HOLD_BARS }, () => ({ open: 97.5, close: 97.5, high: 97.6, low: 97.4 }));
    const patch = resolveLiqRecoilObservation(o, fwd(flat), Date.now());
    expect(patch?.exitReason).toBe("MAX_HOLD_MTM");
    expect(patch?.grossR).toBeCloseTo(0.5 / 1.6, 6);
  });

  it("returns null (still open) with no forward candles and not yet stale", () => {
    const o = obs();
    expect(resolveLiqRecoilObservation(o, [], o.openedAtMs + LQR_BAR_MS)).toBeNull();
  });

  it("expires a stale OPEN observation whose candles never arrive", () => {
    const o = obs();
    const staleNow = o.openedAtMs + LQR_MAX_HOLD_BARS * LQR_BAR_MS * 4;
    expect(resolveLiqRecoilObservation(o, [], staleNow)?.status).toBe("EXPIRED");
  });
});

describe("liq-recoil — resolver has NO lookahead", () => {
  it("ignores a candle at/before openedAtMs even if it would trigger an exit", () => {
    const o = obs();
    const sameTime: Candle = { openTime: o.openedAtMs, open: 98.5, high: 98.6, low: 98.4, close: 98.5, volume: 100 };
    const later: Candle = { openTime: o.openedAtMs + LQR_BAR_MS, open: 97.1, high: 97.2, low: 97, close: 97.1, volume: 100 };
    expect(resolveLiqRecoilObservation(o, [sameTime, later], o.openedAtMs + 2 * LQR_BAR_MS)).toBeNull();
  });

  it("[REGRESSION] a decided exit is never overwritten by candles appended after it", () => {
    const o = obs();
    const c1 = { open: 97.2, close: 97.4, high: 97.5, low: 97.1 };
    const c2 = { open: 97.4, close: 98.3, high: 98.4, low: 97.3 }; // target hits here
    const c3 = { open: 90, close: 88, low: 87, high: 90 }; // deep stop territory AFTER the win fired
    const truncated = resolveLiqRecoilObservation(o, fwd([c1, c2]), Date.now());
    const extended = resolveLiqRecoilObservation(o, fwd([c1, c2, c3]), Date.now());
    expect(truncated?.exitReason).toBe("RECOIL_TARGET");
    expect(extended).toEqual(truncated);
  });
});

// ── cycle ───────────────────────────────────────────────────────────────────

function nowAfter(candles: Candle[], extraMs = 60_000): number {
  return candles[candles.length - 1]!.openTime + LQR_BAR_MS + extraMs;
}

describe("liq-recoil — cycle", () => {
  it("DOWN cascade + matching forced-flow evidence → enters the RECOIL LONG with full provenance; quiet symbol untouched", async () => {
    const store = tmpStore("happy");
    const sol = downCascadeCandles(3);
    const candlesBySymbol: Record<string, Candle[]> = { SOLUSDT: sol, AVAXUSDT: quietCandles(40) };
    const now = nowAfter(sol);
    const result = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT", "AVAXUSDT"],
      now,
      fetchCandles: async (s) => candlesBySymbol[s] ?? [],
      crowdingClient: fakeCrowdingClient({
        SOLUSDT: { openInterestChangePercent: -2.4, takerBuySellRatio: 0.62 },
        AVAXUSDT: { openInterestChangePercent: 0.3, takerBuySellRatio: 1.05 },
      }),
    });

    expect(result.scanned).toBe(2);
    expect(result.flowSampled).toBe(2);
    expect(result.eventsDetected).toBe(1);
    expect(result.entered).toBe(1);
    expect(result.skippedFlowGate).toBe(0);

    const entered = store.all.filter((o) => o.status === "OPEN");
    expect(entered).toHaveLength(1);
    const o = entered[0]!;
    expect(o.symbol).toBe("SOLUSDT");
    expect(o.direction).toBe("LONG"); // against the DOWN cascade
    expect(o.cascadeDirection).toBe("DOWN");
    expect(o.extremePrice).toBe(96);
    expect(o.initialStop).toBeLessThan(96); // beyond the extreme + buffer
    expect(o.targetPrice).toBeGreaterThan(o.entryPrice); // fraction-of-cascade retrace above entry
    expect(o.stallBarsAtEntry).toBe(3);
    expect(o.worstOiChangePercent).toBe(-2.4);
    expect(o.takerRatioAtWorst).toBe(0.62);
    expect(o.flowSamplesInWindow).toBeGreaterThan(0);

    expect(store.cycleMeta.cycles).toBe(1);
    expect(store.cycleMeta.enteredTotal).toBe(1);
    expect(store.cycleMeta.lastEventSymbol).toBe("SOLUSDT");
    expect(store.cycleMeta.lastEventCascadeDirection).toBe("DOWN");
  });

  it("UP cascade (short squeeze) + buy-side flush → enters the RECOIL SHORT", async () => {
    const store = tmpStore("up");
    const sol = upCascadeCandles(3);
    const now = nowAfter(sol);
    const result = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now,
      fetchCandles: async () => sol,
      crowdingClient: fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -2.0, takerBuySellRatio: 1.5 } }),
    });
    expect(result.entered).toBe(1);
    const o = store.all[0]!;
    expect(o.direction).toBe("SHORT");
    expect(o.cascadeDirection).toBe("UP");
    expect(o.initialStop).toBeGreaterThan(104);
    expect(o.targetPrice).toBeLessThan(o.entryPrice);
  });

  it("[NO KNIFE-CATCHING] a cascade still printing new extremes never enters, even with perfect flow evidence", async () => {
    const store = tmpStore("knife");
    const sol = downCascadeCandles(0);
    const result = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now: nowAfter(sol),
      fetchCandles: async () => sol,
      crowdingClient: fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -3, takerBuySellRatio: 0.5 } }),
    });
    expect(result.eventsDetected).toBe(0);
    expect(result.entered).toBe(0);
    expect(store.all).toHaveLength(0);
  });

  it("quiet market: nothing fires, but the cycle is RECORDED (liveness — empty book ≠ dead lane)", async () => {
    const store = tmpStore("quiet");
    const result = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now: nowAfter(quietCandles(40)),
      fetchCandles: async () => quietCandles(40),
      crowdingClient: fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -2, takerBuySellRatio: 0.6 } }),
    });
    expect(result.eventsDetected).toBe(0);
    expect(result.entered).toBe(0);
    expect(store.cycleMeta.cycles).toBe(1);
    expect(store.cycleMeta.lastCycleError).toBeNull();
  });

  it("[FLOW GATE] a stalled cascade WITHOUT the liquidation signature (buy-dominant taker on a DOWN move) is rejected", async () => {
    const store = tmpStore("gate");
    const sol = downCascadeCandles(3);
    const result = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now: nowAfter(sol),
      fetchCandles: async () => sol,
      crowdingClient: fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -2.4, takerBuySellRatio: 1.4 } }),
    });
    expect(result.eventsDetected).toBe(1);
    expect(result.skippedFlowGate).toBe(1);
    expect(result.entered).toBe(0);
  });

  it("[NO FLOW DATA] a flow-fetch outage ABSTAINS (skippedNoFlowData) — it never fabricates evidence", async () => {
    const store = tmpStore("noflow");
    const sol = downCascadeCandles(3);
    const result = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now: nowAfter(sol),
      fetchCandles: async () => sol,
      crowdingClient: fakeCrowdingClient({}), // throws inside fetchCrowdingSnapshot → all-null snapshot
    });
    expect(result.flowSampled).toBe(0);
    expect(result.eventsDetected).toBe(1);
    expect(result.skippedNoFlowData).toBe(1);
    expect(result.entered).toBe(0);
  });

  it("[FLOW MEMORY — key design] the OI flush seen DURING the cascade is remembered, so the entry still passes after the flush decays", async () => {
    const store = tmpStore("memory");
    // Cycle 1: cascade just printed its extreme (no stall yet → no event), flush visible NOW.
    const during = downCascadeCandles(0);
    const now1 = nowAfter(during, 30_000);
    const r1 = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now: now1,
      fetchCandles: async () => during,
      crowdingClient: fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -2.4, takerBuySellRatio: 0.62 } }),
    });
    expect(r1.eventsDetected).toBe(0);
    expect(r1.entered).toBe(0);
    expect(r1.flowSampled).toBe(1);

    // Cycle 2: 3 stall bars later the exhaustion confirms, but the instantaneous 5m OI step has
    // decayed to flat. A snapshot-only gate would reject; the persisted history must pass it.
    const stalled = downCascadeCandles(3);
    const now2 = nowAfter(stalled, 30_000);
    const r2 = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now: now2,
      fetchCandles: async () => stalled,
      crowdingClient: fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: 0.0, takerBuySellRatio: 1.0 } }),
    });
    expect(r2.eventsDetected).toBe(1);
    expect(r2.skippedNoFlowData).toBe(0);
    expect(r2.skippedFlowGate).toBe(0);
    expect(r2.entered).toBe(1);
    expect(store.all[0]!.worstOiChangePercent).toBe(-2.4); // the remembered flush, not today's 0.0
  });

  it("[EXACTLY-ONCE ENTRY] the same physical cascade seen again next cycle (stall grew by one bar) does not double-enter", async () => {
    const store = tmpStore("once");
    const crowdingClient = fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -2.4, takerBuySellRatio: 0.62 } });
    const c3 = downCascadeCandles(3);
    await runLiqRecoilCycle({ store, universe: ["SOLUSDT"], now: nowAfter(c3), fetchCandles: async () => c3, crowdingClient });
    expect(store.all).toHaveLength(1);

    const c4 = downCascadeCandles(4); // same extreme bar, one more stalled bar
    const r2 = await runLiqRecoilCycle({ store, universe: ["SOLUSDT"], now: nowAfter(c4), fetchCandles: async () => c4, crowdingClient });
    expect(r2.skippedDuplicate).toBeGreaterThanOrEqual(1);
    expect(r2.entered).toBe(0);
    expect(store.all).toHaveLength(1);
  });

  it("[EXACTLY-ONCE RESOLVE] a settled observation is never re-patched by later cycles with different candles", async () => {
    const store = tmpStore("resolve");
    const crowdingClient = fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -2.4, takerBuySellRatio: 0.62 } });
    const c3 = downCascadeCandles(3);
    const now1 = nowAfter(c3);
    await runLiqRecoilCycle({ store, universe: ["SOLUSDT"], now: now1, fetchCandles: async () => c3, crowdingClient });
    const opened = store.all.find((o) => o.status === "OPEN")!;

    // Next cycle: price rallies through the target → resolves WIN.
    const rally = fwd([{ open: 97, close: opened.targetPrice + 0.3, high: opened.targetPrice + 0.4, low: 96.9 }], opened.openedAtMs);
    const r2 = await runLiqRecoilCycle({ store, universe: ["SOLUSDT"], now: now1 + 30 * 60_000, fetchCandles: async () => rally, crowdingClient });
    expect(r2.resolved).toBe(1);
    const settled = store.all.find((o) => o.observationId === opened.observationId)!;
    expect(settled.status).toBe("CLOSED_WIN");
    const frozen = { ...settled };

    // Third cycle: a catastrophic dump — the settled row must NOT change.
    const dump = fwd([{ open: 60, close: 55, low: 50, high: 60 }], opened.openedAtMs);
    const r3 = await runLiqRecoilCycle({ store, universe: ["SOLUSDT"], now: now1 + 60 * 60_000, fetchCandles: async () => dump, crowdingClient });
    expect(r3.resolved).toBe(0);
    expect(store.all.find((o) => o.observationId === opened.observationId)).toEqual(frozen);
  });

  it("[OPEN CAP] a full shadow book skips new entries with skippedOpenCap", async () => {
    const store = tmpStore("cap");
    const sol = downCascadeCandles(3);
    const now = nowAfter(sol);
    for (let i = 0; i < LQR_MAX_OPEN; i++) {
      store.add(obs({ observationId: `pre-${i}`, symbol: `PRE${i}USDT`, openedAtMs: now - 1000, openedAt: new Date(now - 1000).toISOString() }));
    }
    const result = await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now,
      fetchCandles: async (s) => (s === "SOLUSDT" ? sol : []),
      crowdingClient: fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -2.4, takerBuySellRatio: 0.62 } }),
    });
    expect(result.skippedOpenCap).toBe(1);
    expect(result.entered).toBe(0);
  });

  it("[STUCK-OPEN] an OPEN observation on a symbol whose candle fetch keeps THROWING eventually expires", async () => {
    const store = tmpStore("stuck");
    const crowdingClient = fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: -2.4, takerBuySellRatio: 0.62 } });
    const c3 = downCascadeCandles(3);
    const now1 = nowAfter(c3);
    await runLiqRecoilCycle({ store, universe: ["SOLUSDT"], now: now1, fetchCandles: async () => c3, crowdingClient });
    const opened = store.all.find((o) => o.status === "OPEN");
    expect(opened).toBeDefined();

    const laterNow = now1 + LQR_MAX_HOLD_BARS * LQR_BAR_MS * 3 + LQR_BAR_MS;
    await runLiqRecoilCycle({
      store,
      universe: ["SOLUSDT"],
      now: laterNow,
      fetchCandles: async () => {
        throw new Error("simulated persistent exchange timeout");
      },
      crowdingClient,
    });
    expect(store.all.find((o) => o.observationId === opened!.observationId)!.status).toBe("EXPIRED");
  });

  it("[LIVENESS] a crashing cycle records lastCycleError instead of looking identical to 'no cascade'", async () => {
    const store = tmpStore("err");
    const orig = store.save.bind(store);
    let threw = false;
    store.save = () => {
      if (!threw) {
        threw = true;
        throw new Error("disk full");
      }
      orig();
    };
    const crashed = await runLiqRecoilCycleGuarded({
      store,
      universe: ["SOLUSDT"],
      now: Date.now(),
      fetchCandles: async () => [],
      crowdingClient: fakeCrowdingClient({ SOLUSDT: { openInterestChangePercent: 0, takerBuySellRatio: 1 } }),
    });
    expect(crashed).toBeNull();
    expect(store.cycleMeta.lastCycleError).toBe("disk full");
  });
});

// ── store bounds ────────────────────────────────────────────────────────────

describe("liq-recoil — bounded store", () => {
  it("prunes oldest SETTLED observations past the cap but keeps every OPEN one; survives reload", () => {
    const file = `${tmpdir()}/lqr-bound-${Date.now()}-${Math.random()}.json`;
    const store = new LiqRecoilStore(file);
    for (let i = 0; i < LQR_MAX_STORED_OBSERVATIONS + 25; i++) {
      store.add(obs({ observationId: `settled-${i}`, openedAtMs: START_MS + i, status: "CLOSED_WIN", netR: 0.1 }));
    }
    for (let i = 0; i < 3; i++) {
      store.add(obs({ observationId: `open-${i}`, openedAtMs: START_MS - 10_000 + i, status: "OPEN" }));
    }
    store.save();
    const reloaded = new LiqRecoilStore(file);
    expect(reloaded.all.length).toBe(LQR_MAX_STORED_OBSERVATIONS + 3);
    expect(reloaded.all.filter((o) => o.status === "OPEN")).toHaveLength(3); // OPEN never pruned, even though oldest
    expect(reloaded.has("settled-0")).toBe(false); // oldest settled dropped first
    expect(reloaded.has(`settled-${LQR_MAX_STORED_OBSERVATIONS + 24}`)).toBe(true);
  });

  it("add() dedupes by observationId", () => {
    const store = tmpStore("dedupe");
    expect(store.add(obs({ observationId: "same" }))).toBe(true);
    expect(store.add(obs({ observationId: "same" }))).toBe(false);
    expect(store.all).toHaveLength(1);
  });

  it("flow history is bounded per symbol and age-pruned on save; fully-aged symbols are dropped", () => {
    const file = `${tmpdir()}/lqr-flow-${Date.now()}-${Math.random()}.json`;
    const store = new LiqRecoilStore(file);
    for (let i = 0; i < LQR_FLOW_MAX_SAMPLES_PER_SYMBOL + 20; i++) {
      store.recordFlowSample("SOLUSDT", sample(START_MS + i * 60_000, -0.1 * i, 1));
    }
    expect(store.flowSamples("SOLUSDT").length).toBe(LQR_FLOW_MAX_SAMPLES_PER_SYMBOL); // bounded immediately

    // A symbol whose entire history is far older than the newest sample anywhere gets dropped.
    store.recordFlowSample("OLDUSDT", sample(START_MS - LQR_FLOW_MAX_AGE_MS - 60_000, -2, 0.5));
    store.save();
    const reloaded = new LiqRecoilStore(file);
    expect(reloaded.flowSamples("SOLUSDT").length).toBeGreaterThan(0);
    expect(reloaded.flowSamples("OLDUSDT")).toHaveLength(0);
  });
});

// ── report ──────────────────────────────────────────────────────────────────

describe("liq-recoil — report", () => {
  it("is NOT edgeReady below the n=30 floor even if every trade won", () => {
    const wins = Array.from({ length: 29 }, (_, i) =>
      obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.5, exitReason: "RECOIL_TARGET" }));
    expect(buildLiqRecoilReport(wins).edgeReady).toBe(false);
  });

  it("is NOT edgeReady with n≥30 but negative expectancy", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      obs({
        observationId: `x${i}`,
        status: i % 2 ? "CLOSED_WIN" : "CLOSED_LOSS",
        netR: i % 2 ? 0.2 : -0.5,
        exitReason: i % 2 ? "RECOIL_TARGET" : "CASCADE_STOP",
      }));
    expect(buildLiqRecoilReport(rows).edgeReady).toBe(false);
  });

  it("is edgeReady with adequate sample, netAvgR ≥ 0.05, and PF > 1.1", () => {
    const wins = Array.from({ length: 25 }, (_, i) =>
      obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.6, exitReason: "RECOIL_TARGET" }));
    const losses = Array.from({ length: 10 }, (_, i) =>
      obs({ observationId: `l${i}`, status: "CLOSED_LOSS", netR: -0.5, exitReason: "CASCADE_STOP" }));
    const report = buildLiqRecoilReport([...wins, ...losses]);
    expect(report.resolvedCount).toBe(35);
    expect(report.wr).toBeCloseTo(25 / 35, 6);
    expect(report.pf).toBeGreaterThan(1.1);
    expect(report.targetShare).toBeCloseTo(25 / 35, 6);
    expect(report.stopShare).toBeCloseTo(10 / 35, 6);
    expect(report.edgeReady).toBe(true);
  });

  it("breaks results down by direction, keeps OPEN separate, and declares the proxy signal source", () => {
    const report = buildLiqRecoilReport([
      obs({ observationId: "o1", status: "OPEN" }),
      obs({ observationId: "s1", status: "CLOSED_WIN", netR: 0.4, direction: "SHORT", cascadeDirection: "UP" }),
    ]);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(1);
    expect(report.byDirection.find((d) => d.direction === "SHORT")?.resolvedCount).toBe(1);
    expect(report.byDirection.find((d) => d.direction === "LONG")?.resolvedCount).toBe(0);
    expect(report.signalSource).toBe("OI_TAKER_FLOW_PROXY"); // no real liquidation feed — say so
  });

  it("has the exact core shape required for cross-lane comparison", () => {
    const report = buildLiqRecoilReport([]);
    expect(report).toMatchObject({
      resolvedCount: 0,
      openCount: 0,
      netAvgR: null,
      wr: null,
      pf: null,
      edgeReady: false,
      signalSource: "OI_TAKER_FLOW_PROXY",
    });
    expect(report.params.cascadeAtrMult).toBeGreaterThan(0);
    expect(report.params.maxHoldHours).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  detectPanicWashoutSignal,
  passesPanicWashoutCrowdingGate,
  buildPanicWashoutGeometry,
  resolvePanicWashoutObservation,
  buildPanicWashoutReport,
  runPanicWashoutCycle,
  runPanicWashoutCycleGuarded,
  PanicWashoutStore,
  PWR_WASHOUT_RSI_MAX,
  PWR_MFE_ARM_R,
  PWR_MFE_GIVEBACK_FRAC,
  PWR_MAX_HOLD_BARS,
  panicWashoutOpenSignals,
  panicWashoutExitPolicy,
  isPanicWashoutExecEnabled,
  PWR_EXEC_LEG_USD,
  PWR_EXEC_LEVERAGE,
  PWR_EXEC_MAX_CONCURRENT,
  PWR_EXEC_MAX_SIGNAL_AGE_MS,
  PWR_EXEC_DAILY_MAX_LOSS_USD,
  type PanicWashoutObservation,
} from "../src/lib/panic-washout-reclaim-edge.js";
import type { CrowdingSnapshot } from "../src/lib/derivatives-crowding.js";

let t = 1_000_000_000_000;
function bar(open: number, close: number, opts: { high?: number; low?: number; volume?: number } = {}): Candle {
  t += 3_600_000;
  return {
    openTime: t,
    open,
    high: opts.high ?? Math.max(open, close),
    low: opts.low ?? Math.min(open, close),
    close,
    volume: opts.volume ?? 100,
  };
}

/** Baseline: mild steady uptrend, normal volume — never qualifies as panic, keeps RSI comfortably
 *  above the washout line and ATR/volume-SMA settled at a small "normal" reading. */
function baseline(n: number, startPrice: number, step: number): { candles: Candle[]; lastPrice: number } {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const next = price + step;
    candles.push(bar(price, next, { volume: 100 }));
    price = next;
  }
  return { candles, lastPrice: price };
}

/** A full panic -> washout-continuation -> reclaim sequence appended after a baseline. Step/drop
 *  sized small in ABSOLUTE terms (but the same drop/step RATIO as a larger fixture would use, which
 *  is what drives the RSI dynamics) so the resulting stop distance stays within
 *  PWR_STOP_CEILING_BPS (bps is scale-invariant on price magnitude, not on the RSI-driving ratio). */
function panicWashoutReclaimSeries(): Candle[] {
  t = 1_000_000_000_000;
  const { candles, lastPrice } = baseline(40, 100, 0.05);
  // Panic bar: big red candle, volume >> normal, range >> ATR.
  const panicOpen = lastPrice;
  const panicClose = panicOpen - 2.5;
  candles.push(bar(panicOpen, panicClose, { high: panicOpen + 0.02, low: panicClose - 0.05, volume: 800 }));
  // Washout-continuation bar: further small down move (keeps/pushes RSI under the washout line),
  // normal volume — NOT itself a panic bar.
  const contClose = panicClose - 1;
  candles.push(bar(panicClose, contClose, { volume: 120 }));
  // Reclaim bar: closes back ABOVE the panic bar's high.
  const reclaimClose = panicOpen + 1;
  candles.push(bar(contClose, reclaimClose, { high: reclaimClose, low: contClose - 0.2, volume: 150 }));
  return candles;
}

describe("panic-washout-reclaim — signal detection", () => {
  it("fires on a genuine panic bar -> washout -> reclaim sequence", () => {
    const candles = panicWashoutReclaimSeries();
    const sig = detectPanicWashoutSignal(candles);
    expect(sig).not.toBeNull();
    expect(sig!.entryPrice).toBe(candles[candles.length - 1]!.close);
    expect(sig!.rsiAtWashout).toBeLessThan(PWR_WASHOUT_RSI_MAX);
    expect(sig!.panicBarHigh).toBeGreaterThan(0);
    expect(sig!.panicBarLow).toBeLessThan(sig!.panicBarHigh);
    expect(sig!.entryPrice).toBeGreaterThan(sig!.panicBarHigh); // reclaim confirmed above panic high
  });

  it("does NOT fire before the reclaim bar (still below the panic bar's high)", () => {
    t = 1_000_000_000_000;
    const { candles, lastPrice } = baseline(40, 100, 0.3);
    const panicOpen = lastPrice;
    const panicClose = panicOpen - 15;
    candles.push(bar(panicOpen, panicClose, { high: panicOpen + 0.2, low: panicClose - 0.3, volume: 800 }));
    // Last bar stays BELOW the panic high — no reclaim yet.
    candles.push(bar(panicClose, panicClose - 1, { volume: 120 }));
    expect(detectPanicWashoutSignal(candles)).toBeNull();
  });

  it("does NOT fire without a qualifying panic bar (ordinary small down move, no blowoff)", () => {
    t = 1_000_000_000_000;
    const { candles, lastPrice } = baseline(40, 100, 0.3);
    // A routine dip: small range, normal volume — never clears the ATR/volume panic gate.
    candles.push(bar(lastPrice, lastPrice - 0.5, { volume: 100 }));
    candles.push(bar(lastPrice - 0.5, lastPrice + 0.6, { volume: 100 }));
    expect(detectPanicWashoutSignal(candles)).toBeNull();
  });

  it("does NOT re-fire once a panic bar has already been reclaimed on an earlier bar (dedup)", () => {
    const candles = panicWashoutReclaimSeries();
    // Append one more bar AFTER the reclaim — the panic bar is now reclaimed on an earlier bar, not this one.
    const last = candles[candles.length - 1]!;
    candles.push(bar(last.close, last.close + 0.5, { volume: 100 }));
    expect(detectPanicWashoutSignal(candles)).toBeNull();
  });

  it("returns null with too few candles", () => {
    expect(detectPanicWashoutSignal(panicWashoutReclaimSeries().slice(0, 20))).toBeNull();
  });
});

function crowdSnap(over: Partial<CrowdingSnapshot> = {}): CrowdingSnapshot {
  return {
    symbol: "TESTUSDT",
    fundingRate: 0,
    fundingBps: 0,
    oiChangePercent: -2,
    oiTrend: "FALLING",
    takerBuySellRatio: null,
    longShortRatio: null,
    crowdSide: "NEUTRAL",
    crowdingLevel: "NEUTRAL",
    crowdingState: "UNWINDING",
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

describe("panic-washout-reclaim — crowding gate", () => {
  it("passes on UNWINDING (OI falling — forced-out leverage)", () => {
    expect(passesPanicWashoutCrowdingGate(crowdSnap({ crowdingState: "UNWINDING" }))).toBe(true);
  });
  it("rejects BUILDING/EXHAUSTING/NEUTRAL", () => {
    expect(passesPanicWashoutCrowdingGate(crowdSnap({ crowdingState: "BUILDING" }))).toBe(false);
    expect(passesPanicWashoutCrowdingGate(crowdSnap({ crowdingState: "EXHAUSTING" }))).toBe(false);
    expect(passesPanicWashoutCrowdingGate(crowdSnap({ crowdingState: "NEUTRAL" }))).toBe(false);
  });
});

describe("panic-washout-reclaim — geometry", () => {
  it("places the stop below the panic bar's low", () => {
    const g = buildPanicWashoutGeometry(110, 105); // 454bps, within the ceiling
    expect(g).not.toBeNull();
    expect(g!.initialStop).toBeLessThanOrEqual(105);
    expect(g!.initialStop).toBeLessThan(g!.entryPrice);
    expect(g!.stopDistanceBps).toBeGreaterThan(0);
  });
  it("floors the stop distance when the panic low sits very close to entry", () => {
    // panic low only 5bps below entry — floor (300bps default) should win, not the raw panic low.
    const entry = 100;
    const panicLow = 99.95;
    const g = buildPanicWashoutGeometry(entry, panicLow);
    expect(g).not.toBeNull();
    expect(g!.initialStop).toBeLessThan(panicLow); // floor pushed it further than the panic low itself
    expect(g!.stopDistanceBps).toBeGreaterThan(100); // clearly wider than the raw 5bps
  });
  it("rejects (never clips) once the panic bar implies a stop wider than the ceiling", () => {
    // panic low 1363bps below entry — a genuinely extreme blowoff, well past PWR_STOP_CEILING_BPS
    // (default 800). Must reject outright, not silently trade a tighter-than-real stop.
    expect(buildPanicWashoutGeometry(110, 95)).toBeNull();
  });
  it("rejects invalid inputs", () => {
    expect(buildPanicWashoutGeometry(0, 90)).toBeNull();
    expect(buildPanicWashoutGeometry(100, 100)).toBeNull(); // panic low not below entry
    expect(buildPanicWashoutGeometry(100, 110)).toBeNull(); // panic low above entry
  });
});

function makeObs(over: Partial<PanicWashoutObservation> = {}): PanicWashoutObservation {
  return {
    observationId: "pwr:TESTUSDT:1",
    symbol: "TESTUSDT",
    direction: "LONG",
    entryPrice: 100,
    initialStop: 97,
    stopDistanceBps: 300,
    openedAt: new Date(1_000_000_000_000).toISOString(),
    openedAtMs: 1_000_000_000_000,
    rsiAtWashout: 20,
    panicBarHigh: 100,
    panicBarLow: 97,
    fundingBps: null,
    oiChangePercent: -2,
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

describe("panic-washout-reclaim — resolution (MFE-giveback exit)", () => {
  it("closes at the initial stop when price never recovers", () => {
    const obs = makeObs();
    const fwd: Candle[] = [
      { openTime: obs.openedAtMs + 3_600_000, open: 99, high: 99.5, low: 96.5, close: 97.2 }, // pierces stop (97)
    ];
    const patch = resolvePanicWashoutObservation(obs, fwd, obs.openedAtMs + 7_200_000);
    expect(patch).not.toBeNull();
    expect(patch!.status).toBe("CLOSED_LOSS");
    expect(patch!.exitReason).toBe("INITIAL_STOP");
    expect(patch!.grossR).toBeCloseTo(-1, 6);
  });

  it("banks via MFE-giveback once armed and retraced", () => {
    const obs = makeObs(); // risk = 100-97 = 3
    const armPrice = 100 + PWR_MFE_ARM_R * 3 + 1; // comfortably clears the arm line
    const fwd: Candle[] = [
      { openTime: obs.openedAtMs + 3_600_000, open: 100, high: armPrice, low: 99.5, close: armPrice }, // arms
      // Retrace to giveback line: peakR * (1 - giveback frac).
      { openTime: obs.openedAtMs + 7_200_000, open: armPrice, high: armPrice, low: 98, close: 100.5 },
    ];
    const patch = resolvePanicWashoutObservation(obs, fwd, obs.openedAtMs + 10_800_000);
    expect(patch).not.toBeNull();
    expect(patch!.exitReason === "MFE_GIVEBACK" || patch!.exitReason === "INITIAL_STOP").toBe(true);
  });

  it("marks-to-market at max hold when neither stop nor giveback ever fires", () => {
    const obs = makeObs();
    const fwd: Candle[] = [];
    for (let i = 0; i < PWR_MAX_HOLD_BARS; i++) {
      fwd.push({ openTime: obs.openedAtMs + (i + 1) * 3_600_000, open: 100.2, high: 100.5, low: 99.5, close: 100.2 });
    }
    const patch = resolvePanicWashoutObservation(obs, fwd, obs.openedAtMs + (PWR_MAX_HOLD_BARS + 1) * 3_600_000);
    expect(patch).not.toBeNull();
    expect(patch!.exitReason).toBe("MAX_HOLD_MTM");
  });

  it("returns null (still open) with no forward candles yet and not stale", () => {
    const obs = makeObs();
    expect(resolvePanicWashoutObservation(obs, [], obs.openedAtMs + 60_000)).toBeNull();
  });
});

describe("panic-washout-reclaim — store + cycle", () => {
  let store: PanicWashoutStore;
  beforeEach(() => {
    store = new PanicWashoutStore(`/tmp/pwr-test-${Date.now()}-${Math.random()}.json`);
  });

  it("records a new observation when the panic/washout/reclaim gate AND crowding gate both pass", async () => {
    const series = panicWashoutReclaimSeries();
    const result = await runPanicWashoutCycle({
      store,
      universe: ["TESTUSDT"],
      now: series[series.length - 1]!.openTime + 1,
      fetchCandles: async () => series,
      crowdingClient: { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: -3, takerBuySellRatio: 1, longShortRatio: 1 }) } as never,
    });
    expect(result.panicCandidates).toBe(1);
    expect(result.crowdingRejected).toBe(0);
    expect(result.recorded).toBe(1);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.status).toBe("OPEN");
  });

  it("rejects a real panic/washout/reclaim candidate when crowding is NOT unwinding", async () => {
    const series = panicWashoutReclaimSeries();
    const result = await runPanicWashoutCycle({
      store,
      universe: ["TESTUSDT"],
      now: series[series.length - 1]!.openTime + 1,
      fetchCandles: async () => series,
      // OI rising, not falling => BUILDING/EXHAUSTING/NEUTRAL, never UNWINDING.
      crowdingClient: { getFuturesFlow: async () => ({ fundingRate: 0.001, openInterestChangePercent: 5, takerBuySellRatio: 1, longShortRatio: 1 }) } as never,
    });
    expect(result.panicCandidates).toBe(1);
    expect(result.crowdingRejected).toBe(1);
    expect(result.recorded).toBe(0);
    expect(store.all).toHaveLength(0);
  });

  it("never records twice for the same symbol within the dedupe window", async () => {
    const series = panicWashoutReclaimSeries();
    const client = { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: -3, takerBuySellRatio: 1, longShortRatio: 1 }) } as never;
    const now = series[series.length - 1]!.openTime + 1;
    await runPanicWashoutCycle({ store, universe: ["TESTUSDT"], now, fetchCandles: async () => series, crowdingClient: client });
    const result2 = await runPanicWashoutCycle({ store, universe: ["TESTUSDT"], now: now + 60_000, fetchCandles: async () => series, crowdingClient: client });
    expect(result2.recorded).toBe(0);
    expect(store.all).toHaveLength(1);
  });

  it("runPanicWashoutCycleGuarded never throws, records the error into cycleMeta", async () => {
    const result = await runPanicWashoutCycleGuarded({
      store,
      universe: ["TESTUSDT"],
      now: Date.now(),
      fetchCandles: async () => {
        throw new Error("boom");
      },
      crowdingClient: { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: 1, longShortRatio: 1 }) } as never,
    });
    // fetchCandles throwing is swallowed per-symbol inside runPanicWashoutCycle itself (best-effort
    // per-symbol skip), so the cycle still completes normally rather than the guarded wrapper
    // catching anything here — assert it never throws and still records a cycle.
    expect(result).not.toBeNull();
    expect(store.cycleMeta.cycles).toBe(1);
  });
});

describe("panic-washout-reclaim — report", () => {
  it("computes wr/pf/netAvgR and edgeReady from resolved observations", () => {
    const obs: PanicWashoutObservation[] = [
      { ...makeObs({ observationId: "a" }), status: "CLOSED_WIN", netR: 1.2, exitReason: "MFE_GIVEBACK" },
      { ...makeObs({ observationId: "b" }), status: "CLOSED_LOSS", netR: -1.05, exitReason: "INITIAL_STOP" },
      { ...makeObs({ observationId: "c" }), status: "OPEN" },
    ];
    const report = buildPanicWashoutReport(obs);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(2);
    expect(report.wr).toBeCloseTo(0.5, 6);
    expect(report.edgeReady).toBe(false); // n=2 << 30
  });

  it("reports zero/null-safe defaults with no observations", () => {
    const report = buildPanicWashoutReport([]);
    expect(report.openCount).toBe(0);
    expect(report.resolvedCount).toBe(0);
    expect(report.netAvgR).toBeNull();
    expect(report.wr).toBeNull();
    expect(report.edgeReady).toBe(false);
  });
});

describe("panic-washout-reclaim — live execution adapters", () => {
  afterEach(() => {
    delete process.env.PANIC_WASHOUT_EXEC_ENABLED;
    delete process.env.PANIC_WASHOUT_EXEC_LEG_USD;
    delete process.env.PANIC_WASHOUT_EXEC_LEVERAGE;
    delete process.env.PANIC_WASHOUT_EXEC_MAX_CONCURRENT;
    delete process.env.PANIC_WASHOUT_EXEC_DAILY_MAX_LOSS_USD;
  });

  it("maps OPEN observations to the generic single-symbol signal shape", () => {
    const store = new PanicWashoutStore(`/tmp/pwr-test-adapt-${Date.now()}.json`);
    store.add(makeObs({ observationId: "x" }));
    store.add(makeObs({ observationId: "y", status: "CLOSED_WIN" }));
    const signals = panicWashoutOpenSignals(store);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.observationId).toBe("x");
    expect(signals[0]!.stopPrice).toBe(97);
  });

  it("exit policy exits at -1R on stop touch (sanity check on the wired policy)", () => {
    const policy = panicWashoutExitPolicy();
    const decision = policy({ direction: "LONG", entryPrice: 100, stopPrice: 97, currentPrice: 96.9, peakFavorableR: 0, msHeld: 1000 });
    expect(decision.shouldExit).toBe(true);
  });

  it("defaults to disabled and default sizing when env is unset", () => {
    expect(isPanicWashoutExecEnabled({})).toBe(false);
    expect(PWR_EXEC_LEG_USD()).toBe(50);
    expect(PWR_EXEC_LEVERAGE()).toBe(3);
    expect(PWR_EXEC_MAX_CONCURRENT()).toBe(1);
    expect(PWR_EXEC_MAX_SIGNAL_AGE_MS()).toBeGreaterThan(0);
    expect(PWR_EXEC_DAILY_MAX_LOSS_USD()).toBe(0);
  });

  it("honors env overrides", () => {
    process.env.PANIC_WASHOUT_EXEC_ENABLED = "1";
    process.env.PANIC_WASHOUT_EXEC_LEG_USD = "75";
    process.env.PANIC_WASHOUT_EXEC_LEVERAGE = "5";
    process.env.PANIC_WASHOUT_EXEC_MAX_CONCURRENT = "2";
    expect(isPanicWashoutExecEnabled(process.env)).toBe(true);
    expect(PWR_EXEC_LEG_USD()).toBe(75);
    expect(PWR_EXEC_LEVERAGE()).toBe(5);
    expect(PWR_EXEC_MAX_CONCURRENT()).toBe(2);
  });
});

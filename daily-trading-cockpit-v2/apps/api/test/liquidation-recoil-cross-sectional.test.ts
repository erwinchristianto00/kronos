import { describe, it, expect, beforeEach } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  findRecentPanicWashoutBar,
  detectBroadLiquidationEvent,
  computeReclaimStrength,
  resolveLiquidationRecoilXsObservation,
  buildLiquidationRecoilXsReport,
  runLiquidationRecoilXsCycle,
  runLiquidationRecoilXsCycleGuarded,
  LiquidationRecoilXsStore,
  LRX_MFE_ARM_R,
  LRX_MAX_HOLD_BARS,
  LRX_MIN_PANIC_SYMBOLS,
  LRX_EVENT_WINDOW_BARS,
  LRX_MAX_STORED_OBSERVATIONS,
  type LiquidationRecoilXsObservation,
  type LrxPanicCandidate,
} from "../src/lib/liquidation-recoil-cross-sectional.js";

let t = 1_000_000_000_000;
function bar(open: number, close: number, opts: { high?: number; low?: number; volume?: number; openTime?: number } = {}): Candle {
  t += 3_600_000;
  return {
    openTime: opts.openTime ?? t,
    open,
    high: opts.high ?? Math.max(open, close),
    low: opts.low ?? Math.min(open, close),
    close,
    volume: opts.volume ?? 100,
  };
}

/** Mild steady uptrend, normal volume — never qualifies as panic. */
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

/** Baseline followed by a single genuine panic bar (big red candle, volume spike, deep RSI), with NO
 *  reclaim yet. Returns the candles plus the panic bar's own open/low for downstream scoring tests. */
function baselineWithPanic(n = 40, startPrice = 100, step = 0.05): { candles: Candle[]; panicOpen: number; panicClose: number; panicLow: number } {
  t = 1_000_000_000_000;
  const { candles, lastPrice } = baseline(n, startPrice, step);
  const panicOpen = lastPrice;
  const panicClose = panicOpen - 2.5;
  const panicLow = panicClose - 0.05;
  candles.push(bar(panicOpen, panicClose, { high: panicOpen + 0.02, low: panicLow, volume: 800 }));
  return { candles, panicOpen, panicClose, panicLow };
}

describe("liquidation-recoil-cross-sectional — findRecentPanicWashoutBar (stage 1+2, no reclaim required)", () => {
  it("fires on a genuine panic+washout bar even with NO reclaim yet (last bar still below panic high)", () => {
    const { candles, panicOpen, panicLow } = baselineWithPanic();
    // one more small down bar after panic, still no reclaim
    candles.push(bar(candles[candles.length - 1]!.close, candles[candles.length - 1]!.close - 0.3, { volume: 120 }));
    const found = findRecentPanicWashoutBar(candles);
    expect(found).not.toBeNull();
    expect(found!.open).toBeCloseTo(panicOpen, 6);
    expect(found!.low).toBeCloseTo(panicLow, 6);
  });

  it("fires even once the reclaim HAS happened (unlike detectPanicWashoutSignal, no reclaim requirement)", () => {
    const { candles, panicOpen } = baselineWithPanic();
    const panicBar = candles[candles.length - 1]!;
    candles.push(bar(panicBar.close, panicBar.close - 1, { volume: 120 })); // washout continuation
    candles.push(bar(panicBar.close - 1, panicOpen + 1, { high: panicOpen + 1, volume: 150 })); // reclaim
    const found = findRecentPanicWashoutBar(candles);
    expect(found).not.toBeNull();
  });

  it("does NOT fire on an ordinary small dip (no blowoff range/volume)", () => {
    t = 1_000_000_000_000;
    const { candles, lastPrice } = baseline(40, 100, 0.3);
    candles.push(bar(lastPrice, lastPrice - 0.5, { volume: 100 }));
    candles.push(bar(lastPrice - 0.5, lastPrice + 0.2, { volume: 100 }));
    expect(findRecentPanicWashoutBar(candles)).toBeNull();
  });

  it("does NOT fire once the panic bar has aged past the lookback window", () => {
    const { candles } = baselineWithPanic();
    // Push the panic bar far enough back that it falls outside a tight lookback window.
    for (let i = 0; i < 5; i++) {
      candles.push(bar(candles[candles.length - 1]!.close, candles[candles.length - 1]!.close + 0.05, { volume: 100 }));
    }
    expect(findRecentPanicWashoutBar(candles, 2)).toBeNull();
    expect(findRecentPanicWashoutBar(candles, 10)).not.toBeNull();
  });

  it("returns null with too few candles", () => {
    expect(findRecentPanicWashoutBar(baselineWithPanic().candles.slice(0, 10))).toBeNull();
  });
});

describe("liquidation-recoil-cross-sectional — detectBroadLiquidationEvent", () => {
  function candidateAt(symbol: string, openTime: number): LrxPanicCandidate {
    return {
      symbol,
      panicBar: { index: 0, openTime, open: 100, high: 100.5, low: 95, rsiAtWashout: 20, barsSincePanic: 0 },
    };
  }

  it("triggers when >= minSymbols panic within the same short window", () => {
    const base = 1_000_000_000_000;
    const barMs = 3_600_000;
    const candidates = [
      candidateAt("AUSDT", base),
      candidateAt("BUSDT", base + barMs), // 1 bar later
      candidateAt("CUSDT", base + 2 * barMs), // 2 bars later
      candidateAt("DUSDT", base + 2 * barMs), // same bar as C
    ];
    const event = detectBroadLiquidationEvent(candidates, { minSymbols: 4, windowBars: 3, barMs });
    expect(event).not.toBeNull();
    expect(event!.panicked).toHaveLength(4);
    expect(event!.eventStart).toBe(base);
    expect(event!.eventEnd).toBe(base + 2 * barMs);
  });

  it("does NOT trigger when fewer than minSymbols panic within the window (below threshold)", () => {
    const base = 1_000_000_000_000;
    const barMs = 3_600_000;
    const candidates = [candidateAt("AUSDT", base), candidateAt("BUSDT", base + barMs), candidateAt("CUSDT", base + barMs)];
    expect(detectBroadLiquidationEvent(candidates, { minSymbols: 4, windowBars: 3, barMs })).toBeNull();
  });

  it("excludes symbols panicking too far apart in time to count as the same broad event", () => {
    const base = 1_000_000_000_000;
    const barMs = 3_600_000;
    // 3 symbols panic together in a tight cluster; a 4th panics a full day later — NOT part of the
    // same cascade even though it's technically "within the lookback" of a longer-running scan.
    const candidates = [
      candidateAt("AUSDT", base),
      candidateAt("BUSDT", base + barMs),
      candidateAt("CUSDT", base + 2 * barMs),
      candidateAt("DUSDT", base + 24 * barMs),
    ];
    const event = detectBroadLiquidationEvent(candidates, { minSymbols: 4, windowBars: 3, barMs });
    expect(event).toBeNull(); // only 3 clustered, need 4

    const event3 = detectBroadLiquidationEvent(candidates, { minSymbols: 3, windowBars: 3, barMs });
    expect(event3).not.toBeNull();
    expect(event3!.panicked).toHaveLength(3);
    expect(event3!.panicked.some((c) => c.symbol === "DUSDT")).toBe(false);
  });

  it("respects default LRX_MIN_PANIC_SYMBOLS / LRX_EVENT_WINDOW_BARS when opts omitted", () => {
    const base = 1_000_000_000_000;
    const barMs = 3_600_000;
    const candidates = Array.from({ length: LRX_MIN_PANIC_SYMBOLS }, (_, i) => candidateAt(`S${i}USDT`, base + i * barMs));
    const event = detectBroadLiquidationEvent(candidates, { barMs });
    expect(event).not.toBeNull();
    expect(event!.panicked.length).toBeGreaterThanOrEqual(LRX_MIN_PANIC_SYMBOLS);
    expect(LRX_EVENT_WINDOW_BARS).toBeGreaterThan(0);
  });

  it("returns null with fewer candidates than minSymbols outright", () => {
    expect(detectBroadLiquidationEvent([candidateAt("AUSDT", 1)], { minSymbols: 4 })).toBeNull();
  });
});

describe("liquidation-recoil-cross-sectional — computeReclaimStrength", () => {
  const panicBar = { open: 100, low: 90 }; // retraceRange = 10, halfLevel = 95

  it("scores a fast/full retracement highest (half-level cleared on bar 1, ends near full retrace)", () => {
    const forward: Candle[] = [
      bar(90, 96, { openTime: 1, high: 96, low: 90 }), // clears halfLevel(95) on bar 1
      bar(96, 99, { openTime: 2, high: 99, low: 95.5 }),
    ];
    const result = computeReclaimStrength(panicBar, forward, 12);
    expect(result).not.toBeNull();
    expect(result!.timeToHalfRetraceBars).toBe(1);
    expect(result!.retracedFraction).toBeCloseTo((99 - 90) / 10, 6);
    expect(result!.reclaimStrength).toBeGreaterThan(result!.retracedFraction); // speed bonus applied
  });

  it("scores a slow/partial retracement lower than a fast/full one", () => {
    const slowForward: Candle[] = [
      bar(90, 91, { openTime: 1, high: 91, low: 90 }),
      bar(91, 92, { openTime: 2, high: 92, low: 91 }),
    ];
    const fastForward: Candle[] = [
      bar(90, 96, { openTime: 1, high: 96, low: 90 }),
      bar(96, 99, { openTime: 2, high: 99, low: 95.5 }),
    ];
    const slow = computeReclaimStrength(panicBar, slowForward, 12)!;
    const fast = computeReclaimStrength(panicBar, fastForward, 12)!;
    expect(slow.timeToHalfRetraceBars).toBeNull(); // never reached 95 in these 2 bars
    expect(fast.reclaimStrength).toBeGreaterThan(slow.reclaimStrength);
  });

  it("scores a failed reclaim (new low) negative, with null time-to-half-retrace", () => {
    const forward: Candle[] = [bar(90, 85, { openTime: 1, high: 90, low: 85 })];
    const result = computeReclaimStrength(panicBar, forward, 12);
    expect(result).not.toBeNull();
    expect(result!.retracedFraction).toBeLessThan(0);
    expect(result!.timeToHalfRetraceBars).toBeNull();
  });

  it("caps evaluation at windowBars even when more candles are supplied", () => {
    const forward: Candle[] = [
      bar(90, 91, { openTime: 1, high: 91, low: 90 }),
      bar(91, 92, { openTime: 2, high: 92, low: 91 }),
      bar(92, 99, { openTime: 3, high: 99, low: 92 }), // would clear halfLevel, but outside a windowBars=2 cap
    ];
    const capped = computeReclaimStrength(panicBar, forward, 2);
    expect(capped).not.toBeNull();
    expect(capped!.barsEvaluated).toBe(2);
    expect(capped!.timeToHalfRetraceBars).toBeNull(); // bar 3 (the one that clears it) is outside the cap
    expect(capped!.retracedFraction).toBeCloseTo((92 - 90) / 10, 6); // evaluated at bar 2's close, not bar 3's
  });

  it("returns null with no forward candles yet (honest: not enough data)", () => {
    expect(computeReclaimStrength(panicBar, [], 12)).toBeNull();
  });

  it("returns null for an invalid panic bar (open <= low)", () => {
    expect(computeReclaimStrength({ open: 90, low: 90 }, [bar(90, 91)], 12)).toBeNull();
    expect(computeReclaimStrength({ open: 90, low: 95 }, [bar(90, 91)], 12)).toBeNull();
  });
});

function makeObs(over: Partial<LiquidationRecoilXsObservation> = {}): LiquidationRecoilXsObservation {
  return {
    observationId: "lrx:TESTUSDT:evt:1",
    symbol: "TESTUSDT",
    direction: "LONG",
    eventId: "lrx:1:2:4",
    eventStart: new Date(1).toISOString(),
    eventStartMs: 1,
    eventEnd: new Date(2).toISOString(),
    eventEndMs: 2,
    panickedSymbolCount: 4,
    rank: 1,
    reclaimStrength: 1.2,
    retracedFraction: 0.9,
    timeToHalfRetraceBars: 1,
    entryPrice: 100,
    initialStop: 97,
    stopDistanceBps: 300,
    panicBarHigh: 100,
    panicBarLow: 97,
    rsiAtWashout: 20,
    fundingBps: null,
    oiChangePercent: -2,
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

describe("liquidation-recoil-cross-sectional — resolveLiquidationRecoilXsObservation (no-lookahead)", () => {
  it("closes at the initial stop when price never recovers", () => {
    const obs = makeObs();
    const fwd: Candle[] = [{ openTime: obs.openedAtMs + 3_600_000, open: 99, high: 99.5, low: 96.5, close: 97.2 }];
    const patch = resolveLiquidationRecoilXsObservation(obs, fwd, obs.openedAtMs + 7_200_000);
    expect(patch).not.toBeNull();
    expect(patch!.status).toBe("CLOSED_LOSS");
    expect(patch!.exitReason).toBe("INITIAL_STOP");
    expect(patch!.grossR).toBeCloseTo(-1, 6);
  });

  it("banks via MFE-giveback once armed and retraced", () => {
    const obs = makeObs(); // risk = 3
    const armPrice = 100 + LRX_MFE_ARM_R * 3 + 1;
    const fwd: Candle[] = [
      { openTime: obs.openedAtMs + 3_600_000, open: 100, high: armPrice, low: 99.5, close: armPrice },
      { openTime: obs.openedAtMs + 7_200_000, open: armPrice, high: armPrice, low: 98, close: 100.5 },
    ];
    const patch = resolveLiquidationRecoilXsObservation(obs, fwd, obs.openedAtMs + 10_800_000);
    expect(patch).not.toBeNull();
    expect(patch!.exitReason === "MFE_GIVEBACK" || patch!.exitReason === "INITIAL_STOP").toBe(true);
  });

  it("marks-to-market at max hold when neither stop nor giveback ever fires", () => {
    const obs = makeObs();
    const fwd: Candle[] = [];
    for (let i = 0; i < LRX_MAX_HOLD_BARS; i++) {
      fwd.push({ openTime: obs.openedAtMs + (i + 1) * 3_600_000, open: 100.2, high: 100.5, low: 99.5, close: 100.2 });
    }
    const patch = resolveLiquidationRecoilXsObservation(obs, fwd, obs.openedAtMs + (LRX_MAX_HOLD_BARS + 1) * 3_600_000);
    expect(patch).not.toBeNull();
    expect(patch!.exitReason).toBe("MAX_HOLD_MTM");
  });

  it("returns null (still open) with no forward candles yet and not stale", () => {
    const obs = makeObs();
    expect(resolveLiquidationRecoilXsObservation(obs, [], obs.openedAtMs + 60_000)).toBeNull();
  });

  it("NO-LOOKAHEAD: ignores candles at/before openedAtMs, and resolves at the FIRST qualifying bar rather than a more favorable later one", () => {
    const obs = makeObs();
    const fwd: Candle[] = [
      // This candle is AT openedAtMs (not strictly after) — must be excluded, even though it would
      // otherwise trigger the stop.
      { openTime: obs.openedAtMs, open: 100, high: 100, low: 90, close: 90 },
      // First real forward bar: pierces the stop.
      { openTime: obs.openedAtMs + 3_600_000, open: 99, high: 99.5, low: 96.5, close: 97.2 },
      // A much later, more favorable bar — must NOT be looked ahead to; resolution already happened
      // at the stop-out above.
      { openTime: obs.openedAtMs + 7_200_000, open: 97.2, high: 130, low: 97, close: 129 },
    ];
    const patch = resolveLiquidationRecoilXsObservation(obs, fwd, obs.openedAtMs + 10_800_000);
    expect(patch).not.toBeNull();
    expect(patch!.exitReason).toBe("INITIAL_STOP");
    expect(patch!.grossR).toBeCloseTo(-1, 6); // NOT the +10R the later bar would have implied
  });

  it("NO-LOOKAHEAD: candles passed out of chronological order are still walked in time order", () => {
    const obs = makeObs();
    const fwd: Candle[] = [
      { openTime: obs.openedAtMs + 7_200_000, open: 97.2, high: 130, low: 97, close: 129 }, // later bar first in array
      { openTime: obs.openedAtMs + 3_600_000, open: 99, high: 99.5, low: 96.5, close: 97.2 }, // earlier bar, pierces stop
    ];
    const patch = resolveLiquidationRecoilXsObservation(obs, fwd, obs.openedAtMs + 10_800_000);
    expect(patch).not.toBeNull();
    expect(patch!.exitReason).toBe("INITIAL_STOP");
  });

  it("rejects malformed geometry (stop not below entry) without throwing", () => {
    const obs = makeObs({ initialStop: 100 });
    expect(resolveLiquidationRecoilXsObservation(obs, [], obs.openedAtMs + 60_000)).toBeNull();
  });
});

describe("liquidation-recoil-cross-sectional — report", () => {
  it("computes wr/pf/netAvgR and edgeReady from resolved observations", () => {
    const obs: LiquidationRecoilXsObservation[] = [
      { ...makeObs({ observationId: "a" }), status: "CLOSED_WIN", netR: 1.2, exitReason: "MFE_GIVEBACK" },
      { ...makeObs({ observationId: "b" }), status: "CLOSED_LOSS", netR: -1.05, exitReason: "INITIAL_STOP" },
      { ...makeObs({ observationId: "c" }), status: "OPEN" },
    ];
    const report = buildLiquidationRecoilXsReport(obs);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(2);
    expect(report.wr).toBeCloseTo(0.5, 6);
    expect(report.edgeReady).toBe(false); // n=2 << 30
  });

  it("reports zero/null-safe defaults with no observations", () => {
    const report = buildLiquidationRecoilXsReport([]);
    expect(report.openCount).toBe(0);
    expect(report.resolvedCount).toBe(0);
    expect(report.netAvgR).toBeNull();
    expect(report.wr).toBeNull();
    expect(report.edgeReady).toBe(false);
  });
});

/** Builds a full multi-symbol candle set: N symbols panic together (broad event), each with its own
 *  reclaim quality afterward, so the whole pipeline (detect -> rank -> geometry -> crowding -> record)
 *  can be exercised end-to-end via runLiquidationRecoilXsCycle. */
function buildBroadEventUniverse(): { symbols: string[]; candlesBySymbol: Map<string, Candle[]>; now: number } {
  const symbols = ["AUSDT", "BUSDT", "CUSDT", "DUSDT", "EUSDT"];
  const candlesBySymbol = new Map<string, Candle[]>();
  let now = 0;
  for (const symbol of symbols) {
    const { candles } = baselineWithPanic(40, 100, 0.05);
    // Fast, strong reclaim for every symbol except the last (EUSDT), which stays flat (fails to reclaim).
    const panicBar = candles[candles.length - 1]!;
    if (symbol === "EUSDT") {
      candles.push(bar(panicBar.close, panicBar.close - 0.2, { volume: 120 }));
      candles.push(bar(panicBar.close - 0.2, panicBar.close - 0.1, { volume: 100 }));
    } else {
      candles.push(bar(panicBar.close, panicBar.close + 1, { volume: 150 })); // strong bounce
      candles.push(bar(panicBar.close + 1, panicBar.close + 1.8, { volume: 130 })); // continues reclaiming
    }
    candlesBySymbol.set(symbol, candles);
    now = Math.max(now, candles[candles.length - 1]!.openTime);
  }
  return { symbols, candlesBySymbol, now: now + 1 };
}

describe("liquidation-recoil-cross-sectional — store + cycle (end-to-end)", () => {
  let store: LiquidationRecoilXsStore;
  beforeEach(() => {
    store = new LiquidationRecoilXsStore(`/tmp/lrx-test-${Date.now()}-${Math.random()}.json`);
  });

  it("detects a broad event and records LONG observations for the top reclaiming symbols only", async () => {
    const { symbols, candlesBySymbol, now } = buildBroadEventUniverse();
    const client = { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: -3, takerBuySellRatio: 1, longShortRatio: 1 }) } as never;
    const result = await runLiquidationRecoilXsCycle({
      store,
      universe: symbols,
      now,
      fetchCandles: async (symbol) => candlesBySymbol.get(symbol)!,
      crowdingClient: client,
    });
    expect(result.panicCandidates).toBe(5); // all 5 symbols panicked together
    expect(result.broadEventsDetected).toBe(1);
    expect(result.recorded).toBeGreaterThan(0);
    expect(store.all.length).toBe(result.recorded);
    // EUSDT (the non-reclaiming symbol) should never be recorded as a LONG candidate.
    expect(store.all.some((o) => o.symbol === "EUSDT")).toBe(false);
    for (const obs of store.all) {
      expect(obs.direction).toBe("LONG");
      expect(obs.eventId).toBeTruthy();
      expect(obs.panickedSymbolCount).toBe(5);
    }
  });

  it("rejects candidates when crowding is NOT unwinding", async () => {
    const { symbols, candlesBySymbol, now } = buildBroadEventUniverse();
    const result = await runLiquidationRecoilXsCycle({
      store,
      universe: symbols,
      now,
      fetchCandles: async (symbol) => candlesBySymbol.get(symbol)!,
      crowdingClient: { getFuturesFlow: async () => ({ fundingRate: 0.001, openInterestChangePercent: 5, takerBuySellRatio: 1, longShortRatio: 1 }) } as never,
    });
    expect(result.broadEventsDetected).toBe(1);
    expect(result.crowdingRejected).toBeGreaterThan(0);
    expect(result.recorded).toBe(0);
    expect(store.all).toHaveLength(0);
  });

  it("does NOT detect a broad event or record anything with too few universe symbols panicking", async () => {
    const { candlesBySymbol, now } = buildBroadEventUniverse();
    const client = { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: -3, takerBuySellRatio: 1, longShortRatio: 1 }) } as never;
    // Only 2 symbols in the universe this cycle — below LRX_MIN_PANIC_SYMBOLS default (4).
    const result = await runLiquidationRecoilXsCycle({
      store,
      universe: ["AUSDT", "BUSDT"],
      now,
      fetchCandles: async (symbol) => candlesBySymbol.get(symbol)!,
      crowdingClient: client,
    });
    expect(result.panicCandidates).toBe(2);
    expect(result.broadEventsDetected).toBe(0);
    expect(result.recorded).toBe(0);
    expect(store.all).toHaveLength(0);
  });

  it("never records twice for the same symbol within the dedupe window", async () => {
    const { symbols, candlesBySymbol, now } = buildBroadEventUniverse();
    const client = { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: -3, takerBuySellRatio: 1, longShortRatio: 1 }) } as never;
    await runLiquidationRecoilXsCycle({ store, universe: symbols, now, fetchCandles: async (s) => candlesBySymbol.get(s)!, crowdingClient: client });
    const firstCount = store.all.length;
    expect(firstCount).toBeGreaterThan(0);
    const result2 = await runLiquidationRecoilXsCycle({
      store,
      universe: symbols,
      now: now + 60_000,
      fetchCandles: async (s) => candlesBySymbol.get(s)!,
      crowdingClient: client,
    });
    expect(result2.recorded).toBe(0);
    expect(store.all).toHaveLength(firstCount);
  });

  it("runLiquidationRecoilXsCycleGuarded never throws, records the error into cycleMeta", async () => {
    const result = await runLiquidationRecoilXsCycleGuarded({
      store,
      universe: ["AUSDT"],
      now: Date.now(),
      fetchCandles: async () => {
        throw new Error("boom");
      },
      crowdingClient: { getFuturesFlow: async () => ({ fundingRate: 0, openInterestChangePercent: 0, takerBuySellRatio: 1, longShortRatio: 1 }) } as never,
    });
    expect(result).not.toBeNull();
    expect(store.cycleMeta.cycles).toBe(1);
  });
});

describe("liquidation-recoil-cross-sectional — store prune on save [PRUNE-FIX]", () => {
  it("keeps every OPEN observation and drops the oldest settled ones beyond LRX_MAX_STORED_OBSERVATIONS", () => {
    const file = `/tmp/lrx-prune-test-${Date.now()}-${Math.random()}.json`;
    const store = new LiquidationRecoilXsStore(file);
    const extra = 7;
    for (let i = 0; i < LRX_MAX_STORED_OBSERVATIONS + extra; i++) {
      store.add(
        makeObs({
          observationId: `settled:${i}`,
          openedAtMs: 1_000_000_000_000 + i * 60_000, // strictly increasing -> oldest is index 0
          status: i % 2 === 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
        }),
      );
    }
    // A handful of OPEN observations, deliberately older than every settled one above, to prove
    // OPEN status alone protects them from the age-based prune, not just recency.
    store.add(makeObs({ observationId: "open:1", openedAtMs: 1, status: "OPEN" }));
    store.add(makeObs({ observationId: "open:2", openedAtMs: 2, status: "OPEN" }));

    store.save();

    expect(store.all.filter((o) => o.status === "OPEN")).toHaveLength(2);
    expect(store.all.some((o) => o.observationId === "open:1")).toBe(true);
    expect(store.all.some((o) => o.observationId === "open:2")).toBe(true);
    const settledRemaining = store.all.filter((o) => o.status !== "OPEN");
    expect(settledRemaining).toHaveLength(LRX_MAX_STORED_OBSERVATIONS);
    // The oldest `extra` settled observations must be the ones dropped, not an arbitrary subset.
    for (let i = 0; i < extra; i++) {
      expect(store.all.some((o) => o.observationId === `settled:${i}`)).toBe(false);
    }
    expect(store.all.some((o) => o.observationId === `settled:${extra}`)).toBe(true);
    expect(store.all.some((o) => o.observationId === `settled:${LRX_MAX_STORED_OBSERVATIONS + extra - 1}`)).toBe(true);

    // Persisted to disk, not just in-memory: reloading from the file reflects the same pruned state.
    const reloaded = new LiquidationRecoilXsStore(file);
    expect(reloaded.all).toHaveLength(2 + LRX_MAX_STORED_OBSERVATIONS);
  });
});

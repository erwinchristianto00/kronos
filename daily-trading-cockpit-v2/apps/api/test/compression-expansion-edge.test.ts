import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import type { FuturesAggTradeSnapshot } from "../src/lib/binance.js";
import {
  detectCompressionIgnitionSignal,
  passesCompressionIgnitionTakerFlowGate,
  buildCompressionExpansionGeometry,
  resolveCompressionExpansionObservation,
  buildCompressionExpansionReport,
  runCompressionExpansionCycle,
  runCompressionExpansionCycleGuarded,
  CompressionExpansionStore,
  CE_COMPRESSION_SUSTAIN_BARS,
  CE_IGNITION_VOLUME_MULT,
  CE_TAKER_BUY_RATIO_MIN,
  CE_FAR_TARGET_R_MULTIPLE,
  CE_MAX_HOLD_BARS,
  type CompressionExpansionObservation,
} from "../src/lib/compression-expansion-edge.js";

// ── synthetic candle builders ────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

/** Zero-net-drift-every-8-bars pattern with meaningfully large swings, used to build a "volatile
 *  history" regime so ATR/BBW start out HIGH before decaying into a later compression regime. */
const VOLATILE_PATTERN = [4, -3, 5, -6, 3, -4, 6, -5];

interface BuildOpts {
  direction: "LONG" | "SHORT";
  /** Total quiet/compression bars laid down before the breakout candle (default 30 — long enough
   *  for ATR to Wilder-decay low and for Bollinger-band-width's 20-bar window to fully settle, but
   *  short enough that the trailing 100-bar percentile window (used to rank BOTH metrics) is still
   *  dominated by the volatile warm-up regime rather than by a long plateau of tied-low quiet
   *  readings, which would otherwise inflate the percentile rank back above the compression
   *  threshold). */
  quietBars?: number;
  /** Breakout candle's volume as a multiple of the compression window's own average volume. */
  breakoutVolumeMult?: number;
  /** How far past the compression range edge the breakout candle's close lands (price units). */
  breakoutMargin?: number;
  /** If true, the breakout candle's close stays INSIDE the compression range (no real breakout). */
  noBreakout?: boolean;
  /** Bar offset (counted back from the breakout bar, 1..CE_COMPRESSION_SUSTAIN_BARS) at which to
   *  inject a single high-range/high-volume spike, breaking the "sustained" requirement. */
  spikeAtOffsetFromEnd?: number;
}

/** Builds: ~100-bar volatile warm-up regime, then a long quiet/compressed regime, then one breakout
 *  candle. Returns the full candle array plus the exact compression range computed the same way the
 *  detector itself computes it (max high / min low over the LAST CE_COMPRESSION_SUSTAIN_BARS quiet
 *  bars), so tests can assert against it directly. */
function buildCompressedThenBreakoutCandles(opts: BuildOpts): { candles: Candle[]; compressionRangeHigh: number; compressionRangeLow: number } {
  const quietBars = opts.quietBars ?? 30;
  const candles: Candle[] = [];
  let t = 1_700_000_000_000;
  let price = 100;

  // 1. Volatile warm-up regime (100 bars) — keeps ATR/BBW elevated so the later quiet regime reads
  //    as a genuine LOW percentile relative to this trailing history.
  for (let i = 0; i < 100; i++) {
    const delta = VOLATILE_PATTERN[i % VOLATILE_PATTERN.length]!;
    price += delta;
    const open = price - delta;
    const high = Math.max(open, price) + 2;
    const low = Math.min(open, price) - 2;
    candles.push({ openTime: t, open, high, low, close: price, volume: 500 });
    t += HOUR_MS;
  }

  // 2. Quiet/compression regime: tight oscillation around a fixed base, low (but non-zero) volume.
  const quietBase = price;
  for (let i = 0; i < quietBars; i++) {
    const offsetFromEnd = quietBars - i; // 1 = last quiet bar (immediately before breakout)
    const isSpike = opts.spikeAtOffsetFromEnd !== undefined && offsetFromEnd === opts.spikeAtOffsetFromEnd;
    if (isSpike) {
      const spikeDelta = 15;
      candles.push({ openTime: t, open: quietBase, high: quietBase + spikeDelta + 2, low: quietBase - 2, close: quietBase + spikeDelta, volume: 3000 });
    } else {
      const wobble = i % 2 === 0 ? 0.15 : -0.15;
      const close = quietBase + wobble;
      candles.push({
        openTime: t,
        open: quietBase,
        high: Math.max(quietBase, close) + 0.05,
        low: Math.min(quietBase, close) - 0.05,
        close,
        volume: 80,
      });
    }
    t += HOUR_MS;
  }

  // Exact compression range as the detector itself will compute it: max high / min low over the
  // LAST CE_COMPRESSION_SUSTAIN_BARS quiet bars (indices length-CE_COMPRESSION_SUSTAIN_BARS..length-1
  // of `candles` so far, i.e. strictly before the breakout bar we're about to append).
  const sustainWindow = candles.slice(candles.length - CE_COMPRESSION_SUSTAIN_BARS);
  const compressionRangeHigh = Math.max(...sustainWindow.map((c) => c.high));
  const compressionRangeLow = Math.min(...sustainWindow.map((c) => c.low));
  const compressionAvgVolume = sustainWindow.reduce((a, c) => a + c.volume, 0) / sustainWindow.length;

  // 3. Breakout candle.
  const margin = opts.breakoutMargin ?? 5;
  const volumeMult = opts.breakoutVolumeMult ?? CE_IGNITION_VOLUME_MULT + 1; // comfortably clears the gate by default
  const breakoutVolume = compressionAvgVolume * volumeMult;
  let breakoutClose: number;
  if (opts.noBreakout) {
    breakoutClose = quietBase; // stays inside the range
  } else if (opts.direction === "LONG") {
    breakoutClose = compressionRangeHigh + margin;
  } else {
    breakoutClose = compressionRangeLow - margin;
  }
  const breakoutOpen = quietBase;
  candles.push({
    openTime: t,
    open: breakoutOpen,
    high: Math.max(breakoutOpen, breakoutClose) + 0.5,
    low: Math.min(breakoutOpen, breakoutClose) - 0.5,
    close: breakoutClose,
    volume: breakoutVolume,
  });

  return { candles, compressionRangeHigh, compressionRangeLow };
}

function trades(buyQty: number, sellQty: number, atMs: number): FuturesAggTradeSnapshot[] {
  const out: FuturesAggTradeSnapshot[] = [];
  // isBuyerMaker=false -> the TAKER was the buyer (hit the ask) -> buy volume.
  if (buyQty > 0) out.push({ price: 100, quantity: buyQty, isBuyerMaker: false, timestamp: atMs + 1000 });
  // isBuyerMaker=true -> the TAKER was the seller (hit the bid) -> sell volume.
  if (sellQty > 0) out.push({ price: 100, quantity: sellQty, isBuyerMaker: true, timestamp: atMs + 2000 });
  return out;
}

// ── compression + ignition detector ─────────────────────────────────────────

describe("compression-expansion — detector: compression sustained + confirmed ignition", () => {
  it("fires LONG once a sustained compression regime breaks out upward on strong volume", () => {
    const { candles, compressionRangeHigh, compressionRangeLow } = buildCompressedThenBreakoutCandles({ direction: "LONG" });
    const sig = detectCompressionIgnitionSignal(candles);
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("LONG");
    expect(sig!.compressionRangeHigh).toBeCloseTo(compressionRangeHigh, 6);
    expect(sig!.compressionRangeLow).toBeCloseTo(compressionRangeLow, 6);
    expect(sig!.entryPrice).toBe(candles[candles.length - 1]!.close);
    expect(sig!.entryPrice).toBeGreaterThan(compressionRangeHigh);
    expect(sig!.volumeRatio).toBeGreaterThanOrEqual(CE_IGNITION_VOLUME_MULT);
    expect(sig!.breakoutOpenMs).toBe(candles[candles.length - 1]!.openTime);
  });

  it("fires SHORT once a sustained compression regime breaks out downward on strong volume", () => {
    const { candles, compressionRangeLow } = buildCompressedThenBreakoutCandles({ direction: "SHORT" });
    const sig = detectCompressionIgnitionSignal(candles);
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("SHORT");
    expect(sig!.entryPrice).toBeLessThan(compressionRangeLow);
  });

  it("does NOT fire when price never actually clears the compression range", () => {
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG", noBreakout: true });
    expect(detectCompressionIgnitionSignal(candles)).toBeNull();
  });

  it("does NOT fire when the breakout candle's volume fails the ignition multiple", () => {
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG", breakoutVolumeMult: 1.1 });
    expect(detectCompressionIgnitionSignal(candles)).toBeNull();
  });

  it("does NOT fire when the compression is not sustained (one bar inside the window spikes)", () => {
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG", spikeAtOffsetFromEnd: 3 });
    expect(detectCompressionIgnitionSignal(candles)).toBeNull();
  });

  it("does NOT fire on a continuously volatile series that was never compressed", () => {
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG", quietBars: 0 });
    expect(detectCompressionIgnitionSignal(candles)).toBeNull();
  });

  it("returns null with too few candles", () => {
    expect(detectCompressionIgnitionSignal([{ openTime: 1, open: 100, high: 101, low: 99, close: 100, volume: 10 }])).toBeNull();
  });
});

describe("compression-expansion — order-flow ignition confirmation gate", () => {
  it("passes LONG once taker-buy-ratio clears the threshold", () => {
    expect(passesCompressionIgnitionTakerFlowGate("LONG", { takerBuyRatio: CE_TAKER_BUY_RATIO_MIN, signedVolume: 1, buyVolume: 1, sellVolume: 0, totalVolume: 1, tradeCount: 1, tradeIntensityPerSec: null })).toBe(true);
  });

  it("rejects LONG when taker flow is not lopsided enough", () => {
    expect(passesCompressionIgnitionTakerFlowGate("LONG", { takerBuyRatio: 0.55, signedVolume: 1, buyVolume: 1, sellVolume: 1, totalVolume: 2, tradeCount: 2, tradeIntensityPerSec: null })).toBe(false);
  });

  it("passes SHORT once taker-buy-ratio is lopsided toward SELL", () => {
    expect(passesCompressionIgnitionTakerFlowGate("SHORT", { takerBuyRatio: 1 - CE_TAKER_BUY_RATIO_MIN, signedVolume: -1, buyVolume: 0, sellVolume: 1, totalVolume: 1, tradeCount: 1, tradeIntensityPerSec: null })).toBe(true);
  });

  it("rejects when there are no trades at all (takerBuyRatio null)", () => {
    expect(passesCompressionIgnitionTakerFlowGate("LONG", { takerBuyRatio: null, signedVolume: 0, buyVolume: 0, sellVolume: 0, totalVolume: 0, tradeCount: 0, tradeIntensityPerSec: null })).toBe(false);
  });
});

// ── geometry ─────────────────────────────────────────────────────────────────

describe("compression-expansion — geometry", () => {
  it("LONG: floors the stop when the compression range is tighter than the floor", () => {
    const geo = buildCompressionExpansionGeometry("LONG", 100, 99.7, 100.3);
    expect(geo).not.toBeNull();
    expect(geo!.initialStop).toBeCloseTo(98.5, 6); // 100 * (1 - 150bps)
    expect(geo!.stopDistanceBps).toBeCloseTo(150, 6);
    expect(geo!.targetPrice).toBeCloseTo(100 + CE_FAR_TARGET_R_MULTIPLE * 1.5, 6);
  });

  it("LONG: uses the real compression range when it's wider than the floor (and within the ceiling)", () => {
    const geo = buildCompressionExpansionGeometry("LONG", 100, 95, 100.3);
    expect(geo).not.toBeNull();
    expect(geo!.initialStop).toBeCloseTo(95, 6);
    expect(geo!.stopDistanceBps).toBeCloseTo(500, 6);
  });

  it("LONG: rejects (never clips) once the implied stop is wider than the ceiling", () => {
    expect(buildCompressionExpansionGeometry("LONG", 100, 90, 100.3)).toBeNull();
  });

  it("SHORT: floors the stop when the compression range is tighter than the floor", () => {
    const geo = buildCompressionExpansionGeometry("SHORT", 100, 99.7, 100.3);
    expect(geo).not.toBeNull();
    expect(geo!.initialStop).toBeCloseTo(101.5, 6); // 100 * (1 + 150bps)
  });

  it("SHORT: rejects once the implied stop is wider than the ceiling", () => {
    expect(buildCompressionExpansionGeometry("SHORT", 100, 99.7, 110)).toBeNull();
  });

  it("rejects a non-positive entry price", () => {
    expect(buildCompressionExpansionGeometry("LONG", 0, 95, 100)).toBeNull();
  });
});

// ── resolver (walkVariantPath reuse, no-lookahead) ──────────────────────────

function ceObs(over: Partial<CompressionExpansionObservation> = {}): CompressionExpansionObservation {
  const entryPrice = 100;
  const initialStop = 97;
  const risk = entryPrice - initialStop;
  return {
    observationId: "ce:TESTUSDT:1",
    symbol: "TESTUSDT",
    direction: "LONG",
    entryPrice,
    initialStop,
    targetPrice: entryPrice + CE_FAR_TARGET_R_MULTIPLE * risk,
    stopDistanceBps: (risk / entryPrice) * 10000,
    openedAt: new Date(1_000_000_000_000).toISOString(),
    openedAtMs: 1_000_000_000_000,
    atrAtBreakout: 1,
    atrPercentileAtCompression: 10,
    bbWidthPercentileAtCompression: 10,
    volumeRatio: 2,
    takerBuyRatio: 0.65,
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

function bar(openTime: number, close: number, opts: { high?: number; low?: number; open?: number } = {}): Candle {
  return { openTime, open: opts.open ?? close, high: opts.high ?? close, low: opts.low ?? close, close, volume: 100 };
}

describe("compression-expansion — resolver (reuses walkVariantPath, no lookahead)", () => {
  it("returns null (still open) with no forward candles yet and not stale", () => {
    const obs = ceObs();
    expect(resolveCompressionExpansionObservation(obs, [], obs.openedAtMs + HOUR_MS)).resolves.toBeNull();
  });

  it("books the loss at the initial stop when price drops through it on the very next candle", async () => {
    const obs = ceObs();
    const candles = [
      bar(obs.openedAtMs, 100, { high: 100.5, low: 99.5 }),
      bar(obs.openedAtMs + HOUR_MS, 97, { high: 100, low: 96 }), // low 96 <= stop 97
    ];
    const patch = await resolveCompressionExpansionObservation(obs, candles, obs.openedAtMs + 2 * HOUR_MS);
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    // walkVariantPath's atr_trail rule labels EVERY stop-out "ATR_TRAIL_STOP" (whether still at the
    // original level or already ratcheted) — there is no separate "still at the original stop"
    // label for this exit rule.
    expect(patch?.exitReason).toBe("ATR_TRAIL_STOP");
  });

  it("still-open (UNRESOLVED walk, before max-hold) returns null rather than fabricating a close", async () => {
    const obs = ceObs();
    // A handful of flat forward candles, well short of CE_MAX_HOLD_BARS, never touching stop/target.
    const candles = [
      bar(obs.openedAtMs, 100, { high: 100.5, low: 99.5 }),
      ...Array.from({ length: 5 }, (_, i) => bar(obs.openedAtMs + (i + 1) * HOUR_MS, 100.2, { high: 100.4, low: 99.9 })),
    ];
    const patch = await resolveCompressionExpansionObservation(obs, candles, obs.openedAtMs + 6 * HOUR_MS);
    expect(patch).toBeNull();
  });

  it("no-lookahead: the same still-open case stays open regardless of how few candles have printed so far", async () => {
    const obs = ceObs();
    const onlyEntry = [bar(obs.openedAtMs, 100, { high: 100.5, low: 99.5 })];
    const patch = await resolveCompressionExpansionObservation(obs, onlyEntry, obs.openedAtMs + HOUR_MS);
    expect(patch).toBeNull();
  });

  it("[NO-SAME-BAR-EXIT, 2026-07-12 fix] the entry candle's OWN high/low can never trigger a same-bar stop/target touch", async () => {
    const obs = ceObs();
    // The entry candle's own low (96) pierces the stop (97) — entryPrice=100 is that SAME candle's
    // close, so a stop touch that occurred at/before the close within this very candle could never
    // have chronologically followed the entry. Only a LATER candle should be able to trigger it.
    const candles = [
      bar(obs.openedAtMs, 100, { high: 100.5, low: 96 }), // entry candle: low pierces the stop
      bar(obs.openedAtMs + HOUR_MS, 100.2, { high: 100.4, low: 99.9 }), // next candle: flat, no touch
    ];
    const patch = await resolveCompressionExpansionObservation(obs, candles, obs.openedAtMs + 2 * HOUR_MS);
    expect(patch).toBeNull(); // still open — the entry candle's own low must not count
  });

  it("rides a sustained climb and exits via the ATR TRAIL stop (not the far target) on a reversal", async () => {
    const obs = ceObs();
    const candles: Candle[] = [bar(obs.openedAtMs, 100, { high: 100.5, low: 99.5 })];
    let t = obs.openedAtMs;
    let price = 100;
    // Steady climb for 30 bars — arms the ATR trail (peak favorable R passes 0.5) and lets it
    // ratchet upward, well short of the far target (100 + 8*3 = 124).
    for (let i = 0; i < 30; i++) {
      t += HOUR_MS;
      price += 0.6;
      candles.push(bar(t, price, { high: price + 0.3, low: price - 0.3 }));
    }
    // Sharp reversal candle — should trip the ratcheted ATR-trail stop, not the original -1R stop.
    t += HOUR_MS;
    candles.push(bar(t, price - 5, { high: price + 0.2, low: price - 6 }));
    const patch = await resolveCompressionExpansionObservation(obs, candles, t + HOUR_MS);
    expect(patch).not.toBeNull();
    expect(patch?.exitReason).toBe("ATR_TRAIL_STOP");
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.grossR as number).toBeGreaterThan(0);
    expect(patch?.grossR as number).toBeLessThan(CE_FAR_TARGET_R_MULTIPLE);
    expect(patch?.netR as number).toBeLessThan(patch?.grossR as number); // cost applied
  });

  it("marks to market at CE_MAX_HOLD_BARS once neither stop, target, nor trail has fired", async () => {
    const obs = ceObs();
    const candles: Candle[] = [bar(obs.openedAtMs, 100, { high: 100.5, low: 99.5 })];
    let t = obs.openedAtMs;
    for (let i = 0; i < CE_MAX_HOLD_BARS + 2; i++) {
      t += HOUR_MS;
      candles.push(bar(t, 100.3, { high: 100.5, low: 99.9 }));
    }
    const patch = await resolveCompressionExpansionObservation(obs, candles, t + HOUR_MS);
    expect(patch?.exitReason).toBe("MAX_HOLD_MTM");
    expect(patch?.status).toBeDefined();
  });

  it("expires a stale OPEN observation with no forward candles ever printed", async () => {
    const obs = ceObs();
    const staleNowMs = obs.openedAtMs + CE_MAX_HOLD_BARS * HOUR_MS * 3 + HOUR_MS;
    const patch = await resolveCompressionExpansionObservation(obs, [], staleNowMs);
    expect(patch?.status).toBe("EXPIRED");
  });
});

// ── report ────────────────────────────────────────────────────────────────

describe("compression-expansion — report", () => {
  it("is not edgeReady below the sample floor even if every trade won", () => {
    const wins = Array.from({ length: 10 }, (_, i) => ceObs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.4, exitReason: "ATR_TRAIL_STOP" }));
    const report = buildCompressionExpansionReport(wins);
    expect(report.edgeReady).toBe(false);
  });

  it("is edgeReady with adequate sample, positive net, and a real payoff", () => {
    const wins = Array.from({ length: 25 }, (_, i) => ceObs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.5, exitReason: "ATR_TRAIL_STOP" }));
    const losses = Array.from({ length: 10 }, (_, i) => ceObs({ observationId: `l${i}`, status: "CLOSED_LOSS", netR: -1.05, exitReason: "ATR_TRAIL_STOP" }));
    const report = buildCompressionExpansionReport([...wins, ...losses]);
    expect(report.resolvedCount).toBe(35);
    expect(report.wr).toBeCloseTo(25 / 35, 6);
    expect(report.edgeReady).toBe(true);
    expect(report.atrTrailStopShare).toBeCloseTo(1, 6); // all 35 exited via the ATR trail
  });

  it("counts OPEN observations separately from resolved", () => {
    const report = buildCompressionExpansionReport([ceObs({ status: "OPEN" }), ceObs({ observationId: "x2", status: "CLOSED_WIN", netR: 0.3 })]);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(1);
  });
});

// ── cycle (cheap candle gate first, order-flow confirmation second) ────────

describe("compression-expansion — cycle", () => {
  it("never calls the aggTrades client for a symbol that doesn't clear the compression+ignition gate", async () => {
    const store = new CompressionExpansionStore(`/tmp/ce-test-${Date.now()}-${Math.random()}.json`);
    let aggTradeCalls = 0;
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG", noBreakout: true });
    const result = await runCompressionExpansionCycle({
      store,
      universe: ["FLATUSDT"],
      now: Date.now(),
      fetchCandles: async () => candles,
      client: {
        getFuturesAggTrades: async () => {
          aggTradeCalls += 1;
          return [];
        },
      },
    });
    expect(result.compressionIgnitionCandidates).toBe(0);
    expect(aggTradeCalls).toBe(0);
    expect(result.recorded).toBe(0);
  });

  it("records a LONG observation when compression+ignition fires AND taker flow confirms it", async () => {
    const store = new CompressionExpansionStore(`/tmp/ce-test-${Date.now()}-${Math.random()}.json`);
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG" });
    const breakoutMs = candles[candles.length - 1]!.openTime;
    const result = await runCompressionExpansionCycle({
      store,
      universe: ["TESTUSDT"],
      now: Date.now(),
      fetchCandles: async () => candles,
      client: { getFuturesAggTrades: async () => trades(80, 10, breakoutMs) },
    });
    expect(result.compressionIgnitionCandidates).toBe(1);
    expect(result.takerFlowRejected).toBe(0);
    expect(result.recorded).toBe(1);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.direction).toBe("LONG");
  });

  it("rejects a compression+ignition candidate when taker flow does not confirm the direction", async () => {
    const store = new CompressionExpansionStore(`/tmp/ce-test-${Date.now()}-${Math.random()}.json`);
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG" });
    const breakoutMs = candles[candles.length - 1]!.openTime;
    const result = await runCompressionExpansionCycle({
      store,
      universe: ["TESTUSDT"],
      now: Date.now(),
      fetchCandles: async () => candles,
      // Even 50/50 taker flow — not lopsided enough to confirm a LONG ignition.
      client: { getFuturesAggTrades: async () => trades(50, 50, breakoutMs) },
    });
    expect(result.compressionIgnitionCandidates).toBe(1);
    expect(result.takerFlowRejected).toBe(1);
    expect(result.recorded).toBe(0);
  });

  it("dedupes: does not record a second OPEN observation for the same symbol within the dedupe window", async () => {
    const store = new CompressionExpansionStore(`/tmp/ce-test-${Date.now()}-${Math.random()}.json`);
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG" });
    const breakoutMs = candles[candles.length - 1]!.openTime;
    const base = {
      store,
      universe: ["TESTUSDT"] as const,
      fetchCandles: async () => candles,
      client: { getFuturesAggTrades: async () => trades(80, 10, breakoutMs) },
    };
    await runCompressionExpansionCycle({ ...base, now: Date.now() });
    const second = await runCompressionExpansionCycle({ ...base, now: Date.now() });
    expect(second.recorded).toBe(0);
    expect(store.all).toHaveLength(1);
  });

  it("[LIVENESS] persists lastCycleAt + accumulates the gate funnel across cycles and reloads", async () => {
    const file = `/tmp/ce-meta-${Date.now()}-${Math.random()}.json`;
    const store = new CompressionExpansionStore(file);
    const { candles } = buildCompressedThenBreakoutCandles({ direction: "LONG", noBreakout: true });
    const base = { store, universe: ["TESTUSDT"] as const, fetchCandles: async () => candles, client: { getFuturesAggTrades: async () => [] } };
    await runCompressionExpansionCycle({ ...base, now: Date.now() });
    await runCompressionExpansionCycle({ ...base, now: Date.now() + HOUR_MS });
    const meta = store.cycleMeta;
    expect(meta.cycles).toBe(2);
    expect(meta.lastCycleAt).not.toBeNull();
    expect(meta.recordedTotal).toBe(0);
    expect(meta.lastCycleError).toBeNull();
    const reloaded = new CompressionExpansionStore(file);
    expect(reloaded.cycleMeta.cycles).toBe(2);
    const report = buildCompressionExpansionReport(reloaded.all, reloaded.cycleMeta);
    expect(report.cycleMeta?.cycles).toBe(2);
  });

  it("[LIVENESS] a crashing cycle records lastCycleError instead of looking identical to 'no signal'", async () => {
    const store = new CompressionExpansionStore(`/tmp/ce-meta-err-${Date.now()}-${Math.random()}.json`);
    const orig = store.save.bind(store);
    let threw = false;
    store.save = () => {
      if (!threw) {
        threw = true;
        throw new Error("disk full");
      }
      orig();
    };
    const crashed = await runCompressionExpansionCycleGuarded({
      store,
      universe: ["TESTUSDT"],
      now: Date.now(),
      fetchCandles: async () => buildCompressedThenBreakoutCandles({ direction: "LONG", noBreakout: true }).candles,
      client: { getFuturesAggTrades: async () => [] },
    });
    expect(crashed).toBeNull();
    expect(store.cycleMeta.lastCycleError).toBe("disk full");
  });
});

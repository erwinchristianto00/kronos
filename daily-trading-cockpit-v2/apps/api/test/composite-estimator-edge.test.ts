import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Candle, KronosPrediction } from "@dtc/shared";
import {
  normalizeVelocity,
  normalizeKronos,
  classifyComposite,
  buildCompositeGeometry,
  resolveCompositeObservation,
  buildCompositeEstimatorReport,
  runCompositeEstimatorCycle,
  runCompositeEstimatorCycleGuarded,
  CompositeEstimatorStore,
  CE_DEADZONE,
  CE_STEEP_THRESHOLD,
  CE_CONFLICT_MIN_MAGNITUDE,
  CE_VELOCITY_SAT_PER_HR,
  CE_KRONOS_RETURN_SAT_PCT,
  CE_UNPROVEN_BUCKETS,
  compositeEstimatorOpenSignals,
  compositeEstimatorExitPolicy,
  isCompositeEstimatorExecEnabled,
  ceExecLegUsdForBucket,
  ceLaneIdForBucket,
  CE_EXEC_LEG_USD,
  CE_EXEC_LEVERAGE,
  CE_EXEC_MAX_SIGNAL_AGE_MS,
  CE_EXEC_DAILY_MAX_LOSS_USD,
  CE_UNPROVEN_QUADRANT_SIZE_MULT,
  type CompositeEstimatorObservation,
  type CEBucket,
} from "../src/lib/composite-estimator-edge.js";

let t = 1_000_000_000_000;
function bar(close: number, opts: { high?: number; low?: number } = {}): Candle {
  t += 3_600_000;
  return { openTime: t, open: close, high: opts.high ?? close, low: opts.low ?? close, close, volume: 100 };
}
function candles(n: number, basePrice = 100): Candle[] {
  t = 1_000_000_000_000;
  return Array.from({ length: n }, (_, i) => bar(basePrice + i * 0.1));
}

function kronosPrediction(over: Partial<KronosPrediction> = {}): KronosPrediction {
  return {
    available: true,
    expectedReturn1h: 0.01,
    kronosConfidenceBucket: "STRONG",
    horizonConflict: false,
    ...over,
  } as KronosPrediction;
}

describe("composite-estimator — normalizeVelocity", () => {
  it("passes null through", () => {
    expect(normalizeVelocity(null)).toBeNull();
  });
  it("clamps to [-1,1] at the saturation point", () => {
    expect(normalizeVelocity(CE_VELOCITY_SAT_PER_HR * 2)).toBeCloseTo(1, 6);
    expect(normalizeVelocity(-CE_VELOCITY_SAT_PER_HR * 2)).toBeCloseTo(-1, 6);
  });
  it("scales linearly below saturation", () => {
    expect(normalizeVelocity(CE_VELOCITY_SAT_PER_HR / 2)).toBeCloseTo(0.5, 6);
  });
});

describe("composite-estimator — normalizeKronos", () => {
  it("returns null when unavailable", () => {
    expect(normalizeKronos(kronosPrediction({ available: false }))).toBeNull();
    expect(normalizeKronos(null)).toBeNull();
    expect(normalizeKronos(undefined)).toBeNull();
  });
  it("returns null on horizonConflict even if otherwise available", () => {
    expect(normalizeKronos(kronosPrediction({ horizonConflict: true }))).toBeNull();
  });
  it("returns null when there is no usable expected return", () => {
    expect(normalizeKronos(kronosPrediction({ expectedReturn1h: undefined, expectedReturn4h: undefined, expectedReturn3: undefined, expectedReturn6: undefined }))).toBeNull();
    expect(normalizeKronos(kronosPrediction({ expectedReturn1h: 0 }))).toBeNull();
  });
  it("falls back through the horizon chain: 1h -> 4h -> 3 -> 6", () => {
    const n = normalizeKronos(kronosPrediction({ expectedReturn1h: undefined, expectedReturn4h: 0.005 }));
    expect(n?.dir).toBe(1);
  });
  it("maps confidence bucket to weight (STRONG=1.0, MEDIUM=0.6, WEAK=0.3)", () => {
    expect(normalizeKronos(kronosPrediction({ kronosConfidenceBucket: "STRONG" }))!.weight).toBe(1.0);
    expect(normalizeKronos(kronosPrediction({ kronosConfidenceBucket: "MEDIUM" }))!.weight).toBe(0.6);
    expect(normalizeKronos(kronosPrediction({ kronosConfidenceBucket: "WEAK" }))!.weight).toBe(0.3);
  });
  it("clamps magnitude at the return-saturation point and preserves sign", () => {
    const n = normalizeKronos(kronosPrediction({ expectedReturn1h: -CE_KRONOS_RETURN_SAT_PCT * 5 }));
    expect(n?.dir).toBe(-1);
    expect(n?.mag).toBeCloseTo(1, 6);
    expect(n!.contribution).toBeLessThan(0);
  });
});

describe("composite-estimator — classifyComposite (gates + direction + bucket)", () => {
  it("rejects INSUFFICIENT_INPUTS when both velocity and kronos are unavailable", () => {
    const r = classifyComposite(0.5, null, null);
    expect(r).toEqual({ rejectReason: "INSUFFICIENT_INPUTS" });
  });

  it("rejects AXIS_INTERNAL_CONFLICT when level and velocity disagree above the conflict floor", () => {
    const r = classifyComposite(0.5, -(CE_CONFLICT_MIN_MAGNITUDE + 0.1), null, );
    // velocity alone (no kronos) still counts as "sufficient" input, so conflict gate must fire first.
    expect(r).toEqual({ rejectReason: "AXIS_INTERNAL_CONFLICT" });
  });

  it("does NOT flag a conflict when one of level/velocity is below the conflict floor", () => {
    const r = classifyComposite(0.1, -(CE_CONFLICT_MIN_MAGNITUDE + 0.2), kronosPrediction({ expectedReturn1h: 0.02 }));
    expect("rejectReason" in r).toBe(false);
  });

  it("rejects AMBIGUOUS_NEAR_ZERO when the composite falls inside the deadzone", () => {
    // level and velocity both tiny, kronos absent -> composite ~0, deadzone widened 1.5x with no kronos.
    const r = classifyComposite(0.01, 0.001 * CE_VELOCITY_SAT_PER_HR, null);
    expect(r).toEqual({ rejectReason: "AMBIGUOUS_NEAR_ZERO" });
  });

  it("[DEADZONE-WIDENING] the SAME level+velocity composite (0.15) is rejected with no Kronos but accepted once Kronos is available", () => {
    // level=0.2, velocity normalized to 0.28 -> composite (no kronos) = 0.4*0.2 + 0.25*0.28 = 0.15.
    // Without kronos: effective deadzone = 0.12*1.5 = 0.18 -> 0.15 < 0.18 -> rejected.
    const velocitySlope = 0.28 * CE_VELOCITY_SAT_PER_HR;
    const withoutKronos = classifyComposite(0.2, velocitySlope, null);
    expect(withoutKronos).toEqual({ rejectReason: "AMBIGUOUS_NEAR_ZERO" });
    // With ANY kronos signal available: effective deadzone reverts to 0.12, and kronos only ADDS
    // to the composite (same sign) -> 0.15+ >= 0.12 -> accepted.
    const withKronos = classifyComposite(0.2, velocitySlope, kronosPrediction({ expectedReturn1h: 0.002, kronosConfidenceBucket: "WEAK" }));
    expect("rejectReason" in withKronos).toBe(false);
  });

  it("classifies LONG + WIDE when the composite is strongly positive (all 3 signals agree, steep)", () => {
    const r = classifyComposite(0.9, CE_VELOCITY_SAT_PER_HR, kronosPrediction({ expectedReturn1h: CE_KRONOS_RETURN_SAT_PCT, kronosConfidenceBucket: "STRONG" }));
    expect("rejectReason" in r).toBe(false);
    if ("rejectReason" in r) throw new Error("unreachable");
    expect(r.direction).toBe("LONG");
    expect(r.bucket).toBe("WIDE_LONG");
    expect(r.composite).toBeGreaterThanOrEqual(CE_STEEP_THRESHOLD);
  });

  it("classifies SHORT + WIDE when the composite is strongly negative", () => {
    const r = classifyComposite(-0.9, -CE_VELOCITY_SAT_PER_HR, kronosPrediction({ expectedReturn1h: -CE_KRONOS_RETURN_SAT_PCT, kronosConfidenceBucket: "STRONG" }));
    if ("rejectReason" in r) throw new Error("unreachable");
    expect(r.direction).toBe("SHORT");
    expect(r.bucket).toBe("WIDE_SHORT");
  });

  it("classifies LONG + FAST when the composite is positive but below the steep threshold", () => {
    // level 0.2 + a full-magnitude WEAK kronos signal -> composite ~0.185: clears the 0.12
    // deadzone but stays under the 0.45 steep threshold.
    const r = classifyComposite(0.2, null, kronosPrediction({ expectedReturn1h: CE_KRONOS_RETURN_SAT_PCT, kronosConfidenceBucket: "WEAK" }));
    if ("rejectReason" in r) throw new Error(`unexpected reject: ${JSON.stringify(r)}`);
    expect(r.direction).toBe("LONG");
    expect(r.bucket).toBe("FAST_LONG");
    expect(Math.abs(r.composite)).toBeGreaterThanOrEqual(CE_DEADZONE);
    expect(Math.abs(r.composite)).toBeLessThan(CE_STEEP_THRESHOLD);
  });

  it("classifies SHORT + FAST when the composite is negative but below the steep threshold", () => {
    const r = classifyComposite(-0.2, null, kronosPrediction({ expectedReturn1h: -CE_KRONOS_RETURN_SAT_PCT, kronosConfidenceBucket: "WEAK" }));
    if ("rejectReason" in r) throw new Error(`unexpected reject: ${JSON.stringify(r)}`);
    expect(r.direction).toBe("SHORT");
    expect(r.bucket).toBe("FAST_SHORT");
  });

  it("a missing signal shrinks the composite ceiling, never inflates it (no renormalization)", () => {
    // With all 3 maximally agreeing, ceiling = W_LEVEL+W_VELOCITY+W_KRONOS = 1.0.
    const full = classifyComposite(1, CE_VELOCITY_SAT_PER_HR, kronosPrediction({ expectedReturn1h: CE_KRONOS_RETURN_SAT_PCT, kronosConfidenceBucket: "STRONG" }));
    // With kronos missing, the SAME level+velocity produce a strictly smaller composite (never larger).
    const partial = classifyComposite(1, CE_VELOCITY_SAT_PER_HR, null);
    if ("rejectReason" in full || "rejectReason" in partial) throw new Error("unexpected reject");
    expect(partial.composite).toBeLessThan(full.composite);
  });
});

describe("composite-estimator — geometry (reuses CG_WIDE_LONG_RUNNER / CG_WIDE_FAST_SHORT parameters)", () => {
  it("WIDE_LONG: stop below entry, TP at 3x risk above entry, 144h max hold", () => {
    const geo = buildCompositeGeometry(100, "LONG", "WIDE_LONG");
    expect(geo).not.toBeNull();
    expect(geo!.initialStop).toBeLessThan(100);
    expect(geo!.stopDistanceBps).toBeCloseTo(300, 6);
    const risk = geo!.entryPrice - geo!.initialStop;
    expect((geo!.takeProfitPrice - geo!.entryPrice) / risk).toBeCloseTo(3, 6);
    expect(geo!.maxHoldHours).toBe(144);
  });

  it("WIDE_SHORT: stop above entry, TP at 3x risk below entry", () => {
    const geo = buildCompositeGeometry(100, "SHORT", "WIDE_SHORT");
    expect(geo!.initialStop).toBeGreaterThan(100);
    const risk = geo!.initialStop - geo!.entryPrice;
    expect((geo!.entryPrice - geo!.takeProfitPrice) / risk).toBeCloseTo(3, 6);
  });

  it("FAST_LONG: stop below entry, TP at 0.5x risk above entry, 48h max hold", () => {
    const geo = buildCompositeGeometry(100, "LONG", "FAST_LONG");
    const risk = geo!.entryPrice - geo!.initialStop;
    expect((geo!.takeProfitPrice - geo!.entryPrice) / risk).toBeCloseTo(0.5, 6);
    expect(geo!.maxHoldHours).toBe(48);
  });

  it("FAST_SHORT: stop above entry, TP at 0.5x risk below entry", () => {
    const geo = buildCompositeGeometry(100, "SHORT", "FAST_SHORT");
    const risk = geo!.initialStop - geo!.entryPrice;
    expect((geo!.entryPrice - geo!.takeProfitPrice) / risk).toBeCloseTo(0.5, 6);
  });

  it("rejects a non-positive entry price", () => {
    expect(buildCompositeGeometry(0, "LONG", "WIDE_LONG")).toBeNull();
    expect(buildCompositeGeometry(-5, "SHORT", "FAST_SHORT")).toBeNull();
  });
});

function obs(over: Partial<CompositeEstimatorObservation> = {}): CompositeEstimatorObservation {
  const entryPrice = 100;
  const initialStop = 97; // LONG, risk = 3
  return {
    observationId: "ce:TEST:1", symbol: "TESTUSDT", direction: "LONG", bucket: "FAST_LONG",
    entryPrice, initialStop, takeProfitPrice: 101.5, stopDistanceBps: 300, tpRewardMultiple: 0.5, maxHoldHours: 48,
    compositeAtEntry: 0.2, levelAtEntry: 0.3, velocityAtEntry: 0.1, kronosContributionAtEntry: 0.2,
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

describe("composite-estimator — resolution (direction-aware, SL-first-conservative)", () => {
  it("LONG: books the loss at the initial stop when price drops through it", () => {
    const patch = resolveCompositeObservation(obs(), fwd([{ close: 96, low: 95 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("LONG: books the win at the TP price when price rises through it", () => {
    const patch = resolveCompositeObservation(obs(), fwd([{ close: 102, high: 102 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.grossR).toBeCloseTo(0.5, 6);
    expect(patch?.exitReason).toBe("TP_HIT");
  });

  it("LONG: SL-first when a single candle touches both stop and TP", () => {
    const patch = resolveCompositeObservation(obs(), fwd([{ close: 100, high: 103, low: 96 }]), Date.now());
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("SHORT: books the loss at the initial stop when price rallies through it", () => {
    const shortObs = obs({ direction: "SHORT", initialStop: 103, takeProfitPrice: 98.5 });
    const patch = resolveCompositeObservation(shortObs, fwd([{ close: 104, high: 104.5 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("SHORT: books the win at the TP price when price drops through it", () => {
    const shortObs = obs({ direction: "SHORT", initialStop: 103, takeProfitPrice: 98.5 });
    const patch = resolveCompositeObservation(shortObs, fwd([{ close: 98, low: 97.8 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("TP_HIT");
  });

  it("marks to market at max hold when neither stop nor TP fires", () => {
    const flatBars = Array.from({ length: 48 }, () => ({ close: 100.2, high: 100.3, low: 100.1 }));
    const patch = resolveCompositeObservation(obs(), fwd(flatBars), Date.now());
    expect(patch?.exitReason).toBe("MAX_HOLD_MTM");
  });

  it("returns null (still open) with insufficient forward candles and not yet stale", () => {
    expect(resolveCompositeObservation(obs(), [], obs().openedAtMs + 3_600_000)).toBeNull();
  });

  it("expires a stale OPEN observation with no forward candles ever", () => {
    const staleNowMs = obs().openedAtMs + 48 * 3_600_000 * 4;
    expect(resolveCompositeObservation(obs(), [], staleNowMs)?.status).toBe("EXPIRED");
  });
});

describe("composite-estimator — report", () => {
  it("splits stats per bucket and flags proven vs unproven", () => {
    const observations = [
      obs({ observationId: "1", bucket: "WIDE_LONG", status: "CLOSED_WIN", netR: 0.5 }),
      obs({ observationId: "2", bucket: "WIDE_SHORT", status: "CLOSED_LOSS", netR: -1 }),
      obs({ observationId: "3", bucket: "FAST_LONG", status: "OPEN" }),
    ];
    const report = buildCompositeEstimatorReport(observations);
    const wideLong = report.buckets.find((b) => b.bucket === "WIDE_LONG")!;
    const wideShort = report.buckets.find((b) => b.bucket === "WIDE_SHORT")!;
    expect(wideLong.proven).toBe(true);
    expect(wideShort.proven).toBe(false);
    expect(wideLong.resolvedCount).toBe(1);
    expect(report.buckets.find((b) => b.bucket === "FAST_LONG")!.openCount).toBe(1);
  });

  it("CE_UNPROVEN_BUCKETS contains exactly WIDE_SHORT and FAST_LONG", () => {
    expect(CE_UNPROVEN_BUCKETS.has("WIDE_SHORT")).toBe(true);
    expect(CE_UNPROVEN_BUCKETS.has("FAST_LONG")).toBe(true);
    expect(CE_UNPROVEN_BUCKETS.has("WIDE_LONG")).toBe(false);
    expect(CE_UNPROVEN_BUCKETS.has("FAST_SHORT")).toBe(false);
  });
});

describe("composite-estimator — cycle", () => {
  it("records a bucketed observation when the composite clears the gates", async () => {
    const store = new CompositeEstimatorStore(`/tmp/ce-test-${Date.now()}-${Math.random()}.json`);
    const result = await runCompositeEstimatorCycle({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisLevel: 0.9,
      axisVelocitySlopePerHour: CE_VELOCITY_SAT_PER_HR,
      fetchCandles: async () => candles(20),
      fetchKronos: async () => kronosPrediction({ expectedReturn1h: CE_KRONOS_RETURN_SAT_PCT, kronosConfidenceBucket: "STRONG" }),
    });
    expect(result.recorded).toBe(1);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.bucket).toBe("WIDE_LONG");
  });

  it("counts rejects into the correct funnel bucket and records nothing", async () => {
    const store = new CompositeEstimatorStore(`/tmp/ce-test-${Date.now()}-${Math.random()}.json`);
    const result = await runCompositeEstimatorCycle({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      axisLevel: null,
      axisVelocitySlopePerHour: null,
      fetchCandles: async () => candles(20),
      fetchKronos: async () => null,
    });
    expect(result.insufficientInputs).toBe(1);
    expect(result.recorded).toBe(0);
  });

  it("never calls fetchKronos for a symbol whose candle fetch failed", async () => {
    const store = new CompositeEstimatorStore(`/tmp/ce-test-${Date.now()}-${Math.random()}.json`);
    let kronosCalls = 0;
    await runCompositeEstimatorCycle({
      store,
      universe: ["BROKENUSDT"],
      now: Date.now(),
      axisLevel: 0.9,
      axisVelocitySlopePerHour: CE_VELOCITY_SAT_PER_HR,
      fetchCandles: async () => { throw new Error("network down"); },
      fetchKronos: async () => { kronosCalls += 1; return null; },
    });
    expect(kronosCalls).toBe(0);
  });

  it("respects the per-bucket max-concurrent cap independently of other buckets", async () => {
    const store = new CompositeEstimatorStore(`/tmp/ce-test-${Date.now()}-${Math.random()}.json`);
    const result = await runCompositeEstimatorCycle({
      store,
      universe: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
      now: Date.now(),
      axisLevel: 0.9,
      axisVelocitySlopePerHour: CE_VELOCITY_SAT_PER_HR,
      maxConcurrentPerBucket: 2,
      fetchCandles: async () => candles(20),
      fetchKronos: async () => kronosPrediction({ expectedReturn1h: CE_KRONOS_RETURN_SAT_PCT, kronosConfidenceBucket: "STRONG" }),
    });
    expect(result.recorded).toBe(2); // 3rd symbol blocked by the WIDE_LONG bucket cap
    expect(store.all.filter((o) => o.bucket === "WIDE_LONG")).toHaveLength(2);
  });
});

describe("composite-estimator — cycle liveness meta", () => {
  it("[LIVENESS] persists lastCycleAt + accumulates the reject funnel across cycles and reloads", async () => {
    const file = `/tmp/ce-meta-${Date.now()}-${Math.random()}.json`;
    const store = new CompositeEstimatorStore(file);
    const base = { store, universe: ["BTCUSDT"] as const, fetchCandles: async () => candles(20), fetchKronos: async () => null };
    await runCompositeEstimatorCycle({ ...base, now: Date.now(), axisLevel: null, axisVelocitySlopePerHour: null });
    await runCompositeEstimatorCycle({ ...base, now: Date.now() + 3_600_000, axisLevel: null, axisVelocitySlopePerHour: null });
    expect(store.cycleMeta.cycles).toBe(2);
    expect(store.cycleMeta.insufficientInputsTotal).toBe(2);
    const reloaded = new CompositeEstimatorStore(file);
    expect(reloaded.cycleMeta.cycles).toBe(2);
  });

  it("[LIVENESS] a crashing cycle records lastCycleError instead of looking identical to 'no signal'", async () => {
    const store = new CompositeEstimatorStore(`/tmp/ce-meta-err-${Date.now()}-${Math.random()}.json`);
    const orig = store.save.bind(store);
    let threw = false;
    store.save = () => {
      if (!threw) { threw = true; throw new Error("disk full"); }
      orig();
    };
    const crashed = await runCompositeEstimatorCycleGuarded({
      store, universe: ["BTCUSDT"], now: Date.now(), axisLevel: null, axisVelocitySlopePerHour: null,
      fetchCandles: async () => candles(20), fetchKronos: async () => null,
    });
    expect(crashed).toBeNull();
    expect(store.cycleMeta.lastCycleError).toBe("disk full");
  });
});

describe("composite-estimator — live execution wiring adapters", () => {
  it("[compositeEstimatorOpenSignals] filters to only the requested bucket's OPEN observations", () => {
    const store = new CompositeEstimatorStore(`/tmp/ce-adapter-${Date.now()}-${Math.random()}.json`);
    store.add(obs({ observationId: "a", symbol: "AUSDT", bucket: "WIDE_LONG", status: "OPEN" }));
    store.add(obs({ observationId: "b", symbol: "BUSDT", bucket: "FAST_SHORT", status: "OPEN" }));
    store.add(obs({ observationId: "c", symbol: "CUSDT", bucket: "WIDE_LONG", status: "CLOSED_WIN" }));
    const signals = compositeEstimatorOpenSignals(store, "WIDE_LONG");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.symbol).toBe("AUSDT");
  });

  it("[compositeEstimatorExitPolicy] WIDE uses the 3R target, FAST uses the 0.5R target", () => {
    const widePolicy = compositeEstimatorExitPolicy("WIDE_LONG");
    const wideExit = widePolicy({ direction: "LONG", entryPrice: 100, stopPrice: 97, currentPrice: 109, peakFavorableR: 0, msHeld: 1000 });
    expect(wideExit.shouldExit).toBe(true);
    expect(wideExit.reason).toBe("TP_HIT");

    const fastPolicy = compositeEstimatorExitPolicy("FAST_SHORT");
    const fastExit = fastPolicy({ direction: "SHORT", entryPrice: 100, stopPrice: 103, currentPrice: 98.5, peakFavorableR: 0, msHeld: 1000 });
    expect(fastExit.shouldExit).toBe(true);
    expect(fastExit.reason).toBe("TP_HIT");
  });

  it("[isCompositeEstimatorExecEnabled] is off by default and only on with the exact '1' flag", () => {
    expect(isCompositeEstimatorExecEnabled({})).toBe(false);
    expect(isCompositeEstimatorExecEnabled({ COMPOSITE_ESTIMATOR_EXEC_ENABLED: "true" })).toBe(false);
    expect(isCompositeEstimatorExecEnabled({ COMPOSITE_ESTIMATOR_EXEC_ENABLED: "1" })).toBe(true);
  });

  it("[ceLaneIdForBucket] produces a distinct lane id per bucket", () => {
    const ids = (["WIDE_LONG", "WIDE_SHORT", "FAST_LONG", "FAST_SHORT"] as CEBucket[]).map(ceLaneIdForBucket);
    expect(new Set(ids).size).toBe(4);
  });

  it("[ceExecLegUsdForBucket] applies the unproven-quadrant size cut only to WIDE_SHORT/FAST_LONG", () => {
    const base = CE_EXEC_LEG_USD();
    expect(ceExecLegUsdForBucket("WIDE_LONG")).toBe(base);
    expect(ceExecLegUsdForBucket("FAST_SHORT")).toBe(base);
    expect(ceExecLegUsdForBucket("WIDE_SHORT")).toBeCloseTo(base * CE_UNPROVEN_QUADRANT_SIZE_MULT(), 6);
    expect(ceExecLegUsdForBucket("FAST_LONG")).toBeCloseTo(base * CE_UNPROVEN_QUADRANT_SIZE_MULT(), 6);
  });

  describe("CE_EXEC_* config readers", () => {
    const keys = [
      "COMPOSITE_ESTIMATOR_EXEC_LEG_USD",
      "COMPOSITE_ESTIMATOR_EXEC_LEVERAGE",
      "COMPOSITE_ESTIMATOR_EXEC_MAX_SIGNAL_AGE_MS",
      "COMPOSITE_ESTIMATOR_EXEC_DAILY_MAX_LOSS_USD",
      "COMPOSITE_ESTIMATOR_UNPROVEN_QUADRANT_SIZE_MULT",
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

    it("CE_EXEC_LEG_USD defaults to 150 (clears BTCUSDT's stepSize even after the 0.5x unproven cut)", () => {
      expect(CE_EXEC_LEG_USD()).toBe(150);
      process.env.COMPOSITE_ESTIMATOR_EXEC_LEG_USD = "200";
      expect(CE_EXEC_LEG_USD()).toBe(200);
    });

    it("CE_EXEC_LEVERAGE defaults to 3, rejects <1", () => {
      expect(CE_EXEC_LEVERAGE()).toBe(3);
      process.env.COMPOSITE_ESTIMATOR_EXEC_LEVERAGE = "0";
      expect(CE_EXEC_LEVERAGE()).toBe(3);
    });

    it("CE_EXEC_MAX_SIGNAL_AGE_MS defaults to 50 minutes and floors at 60s", () => {
      expect(CE_EXEC_MAX_SIGNAL_AGE_MS()).toBe(50 * 60_000);
      process.env.COMPOSITE_ESTIMATOR_EXEC_MAX_SIGNAL_AGE_MS = "1000";
      expect(CE_EXEC_MAX_SIGNAL_AGE_MS()).toBe(60_000);
    });

    it("CE_EXEC_DAILY_MAX_LOSS_USD defaults to a real 8 (not 0/no-cap)", () => {
      expect(CE_EXEC_DAILY_MAX_LOSS_USD()).toBe(8);
    });

    it("CE_UNPROVEN_QUADRANT_SIZE_MULT defaults to 0.5 and rejects values outside (0,1]", () => {
      expect(CE_UNPROVEN_QUADRANT_SIZE_MULT()).toBe(0.5);
      process.env.COMPOSITE_ESTIMATOR_UNPROVEN_QUADRANT_SIZE_MULT = "1.5";
      expect(CE_UNPROVEN_QUADRANT_SIZE_MULT()).toBe(0.5);
      process.env.COMPOSITE_ESTIMATOR_UNPROVEN_QUADRANT_SIZE_MULT = "0.25";
      expect(CE_UNPROVEN_QUADRANT_SIZE_MULT()).toBe(0.25);
    });
  });
});

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import type { Candle } from "@dtc/shared";
import {
  detectBtcShock,
  scoreLagCandidate,
  rankLaggards,
  isAlreadyMoved,
  buildBtcLeadLagGeometry,
  resolveBtcLeadLagObservation,
  buildBtcLeadLagReport,
  runBtcLeadLagCycle,
  runBtcLeadLagCycleGuarded,
  BtcLeadLagSnapStore,
  BLS_BAR_MS,
  BLS_MAX_HOLD_BARS,
  BLS_MAX_STORED_OBSERVATIONS,
  BLS_STOP_FLOOR_BPS,
  type BtcLeadLagObservation,
  type BtcLeadLagScore,
  type BtcShockAssessment,
} from "../src/lib/btc-leadlag-snap-edge.js";

const START_MS = 1_700_000_000_000;

function candlesFromCloses(closes: number[], startMs = START_MS, stepMs = BLS_BAR_MS): Candle[] {
  return closes.map((close, i) => ({
    openTime: startMs + i * stepMs,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  }));
}

/** Compounds a starting price forward through a per-bar returns series. Returns length + 1 closes. */
function compound(start: number, returns: number[]): number[] {
  const closes = [start];
  for (const r of returns) closes.push(closes[closes.length - 1]! * (1 + r));
  return closes;
}

/** Quiet alternating per-bar returns (±0.1%) — a market with real but small vol. */
function quietReturns(bars: number): number[] {
  return Array.from({ length: bars }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001));
}

/** Quiet baseline then a 3-bar up (or down) shock of `shockPerBar` per bar. */
function shockedBtcReturns(quietBars: number, shockPerBar: number): number[] {
  return [...quietReturns(quietBars), shockPerBar, shockPerBar, shockPerBar];
}

function tmpStore(tag: string): BtcLeadLagSnapStore {
  return new BtcLeadLagSnapStore(`${tmpdir()}/bls-${tag}-${Date.now()}-${Math.random()}.json`);
}

// ── shock detection ─────────────────────────────────────────────────────────

describe("btc-leadlag — detectBtcShock", () => {
  it("does NOT flag a shock in a quiet market (small moves vs its own vol)", () => {
    const btc = candlesFromCloses(compound(100, quietReturns(119)));
    const shock = detectBtcShock(btc);
    expect(shock).not.toBeNull();
    expect(shock!.isShock).toBe(false);
    expect(shock!.direction).toBeNull();
    expect(Math.abs(shock!.zScore)).toBeLessThan(3);
  });

  it("flags an up-shock (LONG) when the short-window return dwarfs BTC's own recent vol", () => {
    const btc = candlesFromCloses(compound(100, shockedBtcReturns(116, 0.01)));
    const shock = detectBtcShock(btc);
    expect(shock).not.toBeNull();
    expect(shock!.isShock).toBe(true);
    expect(shock!.direction).toBe("LONG");
    expect(shock!.zScore).toBeGreaterThan(3);
    expect(shock!.shockReturn).toBeGreaterThan(0.025);
    // Shock identity = the last CLOSED bar of the window.
    const lastCandle = btc[btc.length - 1]!;
    expect(shock!.shockBarOpenTime).toBe(lastCandle.openTime);
    expect(shock!.shockBarCloseTime).toBe(lastCandle.openTime + BLS_BAR_MS);
  });

  it("flags a down-shock (SHORT) symmetrically", () => {
    const btc = candlesFromCloses(compound(100, shockedBtcReturns(116, -0.01)));
    const shock = detectBtcShock(btc);
    expect(shock!.isShock).toBe(true);
    expect(shock!.direction).toBe("SHORT");
    expect(shock!.zScore).toBeLessThan(-3);
  });

  it("the threshold is self-normalizing: the SAME absolute move is a shock in a calm market but NOT in an already-volatile one", () => {
    const move = 0.004; // +0.4% per bar for 3 bars
    const calm = detectBtcShock(candlesFromCloses(compound(100, shockedBtcReturns(116, move))));
    expect(calm!.isShock).toBe(true);
    // Volatile baseline: ±1.2% alternating bars — the same 3×0.4% push is unremarkable there.
    const wildReturns = Array.from({ length: 116 }, (_, i) => (i % 2 === 0 ? 0.012 : -0.012));
    const wild = detectBtcShock(candlesFromCloses(compound(100, [...wildReturns, move, move, move])));
    expect(wild!.isShock).toBe(false);
  });

  it("returns null with insufficient history (cannot estimate a baseline)", () => {
    expect(detectBtcShock(candlesFromCloses(compound(100, quietReturns(10))))).toBeNull();
  });

  it("returns null on a dead flat series (zero vol — no identifiable scale)", () => {
    expect(detectBtcShock(candlesFromCloses(Array.from({ length: 120 }, () => 100)))).toBeNull();
  });
});

// ── residual-gap scoring ────────────────────────────────────────────────────

function shockFixture(): { btc: Candle[]; shock: BtcShockAssessment } {
  const btc = candlesFromCloses(compound(100, shockedBtcReturns(116, 0.01)));
  const shock = detectBtcShock(btc)!;
  expect(shock.isShock).toBe(true);
  return { btc, shock };
}

describe("btc-leadlag — scoreLagCandidate", () => {
  it("an alt that FROZE during the shock shows a large positive residual gap; one that ALREADY moved with BTC shows ~zero", () => {
    const { btc, shock } = shockFixture();
    const btcReturns = shockedBtcReturns(116, 0.01);
    // Laggard: tracks BTC 1:1 in the baseline, flat through the 3 shock bars.
    const laggardReturns = [...btcReturns.slice(0, 116), 0, 0, 0];
    const laggard = scoreLagCandidate(candlesFromCloses(compound(50, laggardReturns)), btc, shock, { symbol: "SOLUSDT" });
    // Mover: tracks BTC 1:1 including the shock.
    const mover = scoreLagCandidate(candlesFromCloses(compound(50, btcReturns)), btc, shock, { symbol: "AVAXUSDT" });

    expect(laggard.ok).toBe(true);
    expect(mover.ok).toBe(true);
    if (!laggard.ok || !mover.ok) throw new Error("unreachable");
    expect(laggard.score.beta).toBeGreaterThan(0.5);
    expect(laggard.score.actualMove).toBeCloseTo(0, 3);
    expect(laggard.score.signedGap).toBeGreaterThan(0.02); // ~beta × 3% still unpriced
    expect(Math.abs(mover.score.signedGap)).toBeLessThan(0.005); // already repriced
    expect(laggard.score.signedGap).toBeGreaterThan(mover.score.signedGap);
    expect(laggard.score.cluster).toBe("L1");
  });

  it("refuses to score (NO_DATA) when the alt's series does not END at the shock bar (stale latest candle)", () => {
    const { btc, shock } = shockFixture();
    const staleAlt = candlesFromCloses(compound(50, shockedBtcReturns(116, 0.01))).slice(0, -1); // missing the shock-end bar
    const out = scoreLagCandidate(staleAlt, btc, shock, { symbol: "SOLUSDT" });
    expect(out).toEqual({ ok: false, reason: "NO_DATA" });
  });

  it("skips with NO_BETA when there are too few aligned bars to estimate beta", () => {
    const { btc, shock } = shockFixture();
    const shortAlt = candlesFromCloses(compound(50, shockedBtcReturns(116, 0.01))).slice(-20); // ends at shock, but only 19 returns
    const out = scoreLagCandidate(shortAlt, btc, shock, { symbol: "SOLUSDT" });
    expect(out).toEqual({ ok: false, reason: "NO_BETA" });
  });

  it("skips with LOW_BETA for an uncorrelated (flat) symbol — no beta-implied expected move to lag behind", () => {
    const { btc, shock } = shockFixture();
    const flatAlt = candlesFromCloses(Array.from({ length: 120 }, () => 50));
    const out = scoreLagCandidate(flatAlt, btc, shock, { symbol: "SOLUSDT" });
    expect(out).toEqual({ ok: false, reason: "LOW_BETA" });
  });
});

// ── ranking ─────────────────────────────────────────────────────────────────

function score(symbol: string, over: Partial<BtcLeadLagScore>): BtcLeadLagScore {
  return { symbol, cluster: "L1", price: 100, beta: 1.5, actualMove: 0, expectedMove: 0.03, signedGap: 0.03, ...over };
}

describe("btc-leadlag — rankLaggards", () => {
  it("ranks the MOST-lagging alt first and EXCLUDES one that already moved with BTC", () => {
    const a = score("SOLUSDT", { actualMove: 0.001, signedGap: 0.029 }); // barely moved — big laggard
    const b = score("AVAXUSDT", { actualMove: 0.02, signedGap: 0.01 }); // partial laggard
    const c = score("NEARUSDT", { actualMove: 0.029, signedGap: 0.001 }); // already repriced — below min gap
    const ranked = rankLaggards([c, b, a]);
    expect(ranked.map((r) => r.symbol)).toEqual(["SOLUSDT", "AVAXUSDT"]);
    expect(isAlreadyMoved(c)).toBe(true);
    expect(isAlreadyMoved(a)).toBe(false);
  });

  it("EXCLUDES an alt that OVERSHOT the shock (negative signed gap — nothing left to snap)", () => {
    const overshot = score("SOLUSDT", { actualMove: 0.05, signedGap: -0.02 });
    expect(rankLaggards([overshot])).toEqual([]);
    expect(isAlreadyMoved(overshot)).toBe(true);
  });

  it("handles DOWN-shocks: an alt that hasn't fallen yet has a positive signed gap and ranks as a SHORT candidate", () => {
    // expected = beta × (−2%) = −3%; actual −0.1% → signedGap = (−0.03 − (−0.001)) × (−1) = +0.029
    const laggard = score("SOLUSDT", { expectedMove: -0.03, actualMove: -0.001, signedGap: 0.029 });
    const fallen = score("AVAXUSDT", { expectedMove: -0.03, actualMove: -0.029, signedGap: 0.001 });
    const ranked = rankLaggards([fallen, laggard]);
    expect(ranked.map((r) => r.symbol)).toEqual(["SOLUSDT"]);
  });

  it("caps at topN", () => {
    const many = Array.from({ length: 6 }, (_, i) => score(`S${i}USDT`, { signedGap: 0.03 - i * 0.001 }));
    expect(rankLaggards(many, { topN: 2 }).map((r) => r.symbol)).toEqual(["S0USDT", "S1USDT"]);
  });
});

// ── geometry ────────────────────────────────────────────────────────────────

describe("btc-leadlag — geometry", () => {
  it("LONG: target above entry BY the gap, stop below by gap × multiple; R denominator = stop distance", () => {
    const geo = buildBtcLeadLagGeometry(100, "LONG", 0.02)!;
    expect(geo.convergenceTarget).toBeCloseTo(102, 9);
    expect(geo.initialStop).toBeCloseTo(97, 9); // 1.5 × 2% = 3%
    expect(geo.stopDistanceBps).toBeCloseTo(300, 6);
    expect(geo.targetDistanceBps).toBeCloseTo(200, 6);
  });

  it("SHORT: mirrored (target below, stop above)", () => {
    const geo = buildBtcLeadLagGeometry(100, "SHORT", 0.02)!;
    expect(geo.convergenceTarget).toBeCloseTo(98, 9);
    expect(geo.initialStop).toBeCloseTo(103, 9);
  });

  it("floors the stop for a microscopic gap so R cannot be degenerate", () => {
    const geo = buildBtcLeadLagGeometry(100, "LONG", 0.0002)!; // 2bps gap → 3bps unfloored stop
    expect(geo.stopDistanceBps).toBeCloseTo(BLS_STOP_FLOOR_BPS, 6);
  });

  it("rejects invalid inputs", () => {
    expect(buildBtcLeadLagGeometry(0, "LONG", 0.02)).toBeNull();
    expect(buildBtcLeadLagGeometry(100, "LONG", 0)).toBeNull();
    expect(buildBtcLeadLagGeometry(100, "LONG", -0.01)).toBeNull();
  });
});

// ── resolution ──────────────────────────────────────────────────────────────

function obs(over: Partial<BtcLeadLagObservation> = {}): BtcLeadLagObservation {
  const geo = buildBtcLeadLagGeometry(100, "LONG", 0.02)!;
  return {
    observationId: "bls:test:1",
    symbol: "SOLUSDT",
    cluster: "L1",
    direction: "LONG",
    ...geo,
    openedAt: new Date(START_MS).toISOString(),
    openedAtMs: START_MS,
    betaAtEntry: 1.5,
    btcShockReturn: 0.02,
    btcShockZScore: 4,
    expectedMoveAtEntry: 0.03,
    actualMoveAtEntry: 0.01,
    residualGapAtEntry: 0.02,
    shockBarOpenTime: START_MS - BLS_BAR_MS,
    detectionLatencyMs: 120_000,
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
    t += BLS_BAR_MS;
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

describe("btc-leadlag — resolution", () => {
  it("books CONVERGED at the target when the gap closes (LONG)", () => {
    const o = obs();
    const patch = resolveBtcLeadLagObservation(o, fwd([{ close: 101 }, { close: o.convergenceTarget + 0.5, high: o.convergenceTarget + 0.5 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("CONVERGED");
    // grossR = targetDistance / stopDistance = 2% / 3%
    expect(patch?.grossR).toBeCloseTo(0.02 / 0.03, 6);
    expect(patch?.netR).toBeLessThan(patch?.grossR as number); // costs always subtracted
  });

  it("books the stop at exactly −1R gross on a clean stop touch", () => {
    const o = obs();
    const patch = resolveBtcLeadLagObservation(o, fwd([{ open: 99, close: 96.5, low: o.initialStop - 0.5 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("RESIDUAL_STOP");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.netR).toBeLessThan(-1); // net of costs a stop is always worse than −1
  });

  it("[STOP HONESTY] a bar that GAPS through the stop books at its open — WORSE than −1R, never clamped", () => {
    const o = obs(); // stop at 97
    const patch = resolveBtcLeadLagObservation(o, fwd([{ open: 94, close: 93, low: 92.5 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("RESIDUAL_STOP");
    expect(patch?.grossR).toBeCloseTo((94 - 100) / 3, 6); // −2R at the gapped open
    expect(patch?.grossR).toBeLessThan(-1);
  });

  it("SL-first when a single candle touches both stop and target (conservative sibling convention)", () => {
    const o = obs();
    const patch = resolveBtcLeadLagObservation(o, fwd([{ open: 100, close: 100, high: o.convergenceTarget + 1, low: o.initialStop - 1 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("RESIDUAL_STOP");
  });

  it("SHORT: converges downward, stops upward", () => {
    const geo = buildBtcLeadLagGeometry(100, "SHORT", 0.02)!;
    const o = obs({ ...geo, direction: "SHORT" });
    const win = resolveBtcLeadLagObservation(o, fwd([{ close: 97.9, low: geo.convergenceTarget - 0.1 }]), Date.now());
    expect(win?.status).toBe("CLOSED_WIN");
    expect(win?.exitReason).toBe("CONVERGED");
    const loss = resolveBtcLeadLagObservation(o, fwd([{ open: 101, close: 103.5, high: geo.initialStop + 0.5 }]), Date.now());
    expect(loss?.status).toBe("CLOSED_LOSS");
    expect(loss?.grossR).toBeCloseTo(-1, 6);
  });

  it("marks to market at max hold when neither fires", () => {
    const o = obs();
    const flat = Array.from({ length: BLS_MAX_HOLD_BARS }, () => ({ close: 100.5 }));
    const patch = resolveBtcLeadLagObservation(o, fwd(flat), Date.now());
    expect(patch?.exitReason).toBe("MAX_HOLD_MTM");
    expect(patch?.grossR).toBeCloseTo(0.5 / 3, 6);
  });

  it("returns null (still open) with no forward candles and not yet stale", () => {
    const o = obs();
    expect(resolveBtcLeadLagObservation(o, [], o.openedAtMs + BLS_BAR_MS)).toBeNull();
  });

  it("expires a stale OPEN observation whose candles never arrive", () => {
    const o = obs();
    const staleNow = o.openedAtMs + BLS_MAX_HOLD_BARS * BLS_BAR_MS * 4;
    expect(resolveBtcLeadLagObservation(o, [], staleNow)?.status).toBe("EXPIRED");
  });
});

describe("btc-leadlag — resolver has NO lookahead", () => {
  it("ignores a candle at/before openedAtMs even if it would trigger an exit", () => {
    const o = obs();
    const sameTime: Candle = { openTime: o.openedAtMs, open: o.convergenceTarget, high: o.convergenceTarget + 5, low: o.convergenceTarget - 1, close: o.convergenceTarget, volume: 100 };
    const later: Candle = { openTime: o.openedAtMs + BLS_BAR_MS, open: 100.1, high: 100.2, low: 100, close: 100.1, volume: 100 };
    expect(resolveBtcLeadLagObservation(o, [sameTime, later], o.openedAtMs + 2 * BLS_BAR_MS)).toBeNull();
  });

  it("[REGRESSION 2026-07-22] a candle with a non-finite low/high/open is excluded, never silently treated as a non-touch", () => {
    // A malformed forward candle (finite close, but low is NaN — a plausible partial/degraded API
    // response) must not be trusted for stop/target-touch detection. Bar 1 is a normal, clearly
    // non-touching candle; bar 2 (the last bar within maxHoldBars=2) is malformed. Before the fix,
    // the malformed bar's NaN low made `slHit`/`tpHit` both silently evaluate false, so it fell
    // through to MAX_HOLD_MTM using its (finite) close — fabricating a resolved exit from a candle
    // whose true intrabar range was unknown. After the fix, the malformed bar is dropped entirely,
    // leaving only the 1 valid bar — under maxHoldBars=2, that's still "still open" (null).
    const o = obs();
    const bar1: Candle = { openTime: o.openedAtMs + BLS_BAR_MS, open: 100, high: 100.3, low: 99.8, close: 100.1, volume: 100 };
    const malformed: Candle = { openTime: o.openedAtMs + 2 * BLS_BAR_MS, open: 100.1, high: 100.4, low: NaN, close: 100.2, volume: 100 };
    const patch = resolveBtcLeadLagObservation(o, [bar1, malformed], Date.now(), { maxHoldBars: 2 });
    expect(patch).toBeNull(); // still open — the malformed bar must not manufacture a resolution
  });

  it("[REGRESSION] a decided exit is never overwritten by candles appended after it — truncated and extended calls resolve identically", () => {
    const o = obs();
    const c1 = { close: 100.4 };
    const c2 = { close: o.convergenceTarget + 1, high: o.convergenceTarget + 1 }; // converges here
    const c3 = { open: 90, close: 88, low: 87 }; // deep stop territory AFTER the win already fired
    const truncated = resolveBtcLeadLagObservation(o, fwd([c1, c2]), Date.now());
    const extended = resolveBtcLeadLagObservation(o, fwd([c1, c2, c3]), Date.now());
    expect(truncated?.exitReason).toBe("CONVERGED");
    expect(extended).toEqual(truncated);
  });
});

// ── cycle ───────────────────────────────────────────────────────────────────

function cycleFixture(): {
  btcCloses: number[];
  candlesBySymbol: Record<string, Candle[]>;
  now: number;
  shockBarOpenTime: number;
} {
  const btcReturns = shockedBtcReturns(116, 0.01);
  const btcCloses = compound(100, btcReturns);
  const laggardReturns = [...btcReturns.slice(0, 116), 0, 0, 0]; // froze during the shock
  const candlesBySymbol: Record<string, Candle[]> = {
    BTCUSDT: candlesFromCloses(btcCloses),
    SOLUSDT: candlesFromCloses(compound(50, laggardReturns)), // laggard → should be entered
    AVAXUSDT: candlesFromCloses(compound(50, btcReturns)), // already moved → skipped
  };
  const lastOpen = START_MS + (btcCloses.length - 1) * BLS_BAR_MS;
  return { btcCloses, candlesBySymbol, now: lastOpen + BLS_BAR_MS + 120_000, shockBarOpenTime: lastOpen };
}

describe("btc-leadlag — cycle", () => {
  it("on a shock: enters the LAGGARD long, skips the already-moved alt, records liveness meta + detection latency", async () => {
    const store = tmpStore("cycle");
    const { candlesBySymbol, now, shockBarOpenTime } = cycleFixture();
    const result = await runBtcLeadLagCycle({
      store,
      universe: ["SOLUSDT", "AVAXUSDT"],
      now,
      fetchCandles: async (s) => candlesBySymbol[s] ?? [],
    });

    expect(result.shockEvaluated).toBe(true);
    expect(result.shockDetected).toBe(true);
    expect(result.direction).toBe("LONG");
    expect(result.entriesRecorded).toBe(1);
    expect(result.skippedAlreadyMoved).toBe(1);
    expect(result.detectionLatencyMs).toBe(120_000); // now − shock bar close

    const entered = store.all.filter((o) => o.status === "OPEN");
    expect(entered).toHaveLength(1);
    expect(entered[0]!.symbol).toBe("SOLUSDT");
    expect(entered[0]!.direction).toBe("LONG");
    expect(entered[0]!.shockBarOpenTime).toBe(shockBarOpenTime);
    expect(entered[0]!.detectionLatencyMs).toBe(120_000);
    expect(entered[0]!.residualGapAtEntry).toBeGreaterThan(0.02);

    expect(store.cycleMeta.cycles).toBe(1);
    expect(store.cycleMeta.shocksDetectedTotal).toBe(1);
    expect(store.cycleMeta.entriesRecordedTotal).toBe(1);
    expect(store.cycleMeta.lastShockDirection).toBe("LONG");
  });

  it("a DOWN-shock enters the alt that hasn't FALLEN yet, as a SHORT", async () => {
    const store = tmpStore("down");
    const btcReturns = shockedBtcReturns(116, -0.01);
    const laggardReturns = [...btcReturns.slice(0, 116), 0, 0, 0]; // held up while BTC dumped
    const candlesBySymbol: Record<string, Candle[]> = {
      BTCUSDT: candlesFromCloses(compound(100, btcReturns)),
      SOLUSDT: candlesFromCloses(compound(50, laggardReturns)),
      AVAXUSDT: candlesFromCloses(compound(50, btcReturns)), // already dumped with BTC
    };
    const now = START_MS + 119 * BLS_BAR_MS + BLS_BAR_MS + 60_000;
    const result = await runBtcLeadLagCycle({
      store,
      universe: ["SOLUSDT", "AVAXUSDT"],
      now,
      fetchCandles: async (s) => candlesBySymbol[s] ?? [],
    });
    expect(result.direction).toBe("SHORT");
    expect(result.entriesRecorded).toBe(1);
    const entered = store.all[0]!;
    expect(entered.symbol).toBe("SOLUSDT");
    expect(entered.direction).toBe("SHORT");
    expect(entered.convergenceTarget).toBeLessThan(entered.entryPrice);
    expect(entered.initialStop).toBeGreaterThan(entered.entryPrice);
  });

  it("[EXACTLY-ONCE ENTRY] the same shock bar observed on a second cycle (slow-ticker overlap) does not double-enter or double-count the shock", async () => {
    const store = tmpStore("once");
    const { candlesBySymbol, now } = cycleFixture();
    const base = { store, universe: ["SOLUSDT", "AVAXUSDT"], fetchCandles: async (s: string) => candlesBySymbol[s] ?? [] };
    await runBtcLeadLagCycle({ ...base, now });
    const afterFirst = store.all.length;
    expect(afterFirst).toBe(1);
    await runBtcLeadLagCycle({ ...base, now: now + 60_000 }); // same closed candles, 1 min later
    expect(store.all.length).toBe(afterFirst);
    expect(store.cycleMeta.shocksDetectedTotal).toBe(1); // deduped by shock-bar identity
  });

  it("[EXACTLY-ONCE RESOLVE] a settled observation is never re-patched by later cycles with different candles", async () => {
    const store = tmpStore("resolve");
    const { candlesBySymbol, now } = cycleFixture();
    const base = { store, universe: ["SOLUSDT", "AVAXUSDT"] };
    await runBtcLeadLagCycle({ ...base, now, fetchCandles: async (s: string) => candlesBySymbol[s] ?? [] });
    const opened = store.all.find((o) => o.status === "OPEN")!;

    // Next cycle (quiet BTC, no shock): SOL rallies through the convergence target → resolves WIN.
    const laterStart = opened.openedAtMs + BLS_BAR_MS;
    const quietBtc = candlesFromCloses(compound(100, quietReturns(119)), laterStart);
    const solWin = fwd([{ close: opened.convergenceTarget + 1, high: opened.convergenceTarget + 1 }], opened.openedAtMs);
    await runBtcLeadLagCycle({
      ...base,
      now: now + 40 * 60_000,
      fetchCandles: async (s: string) => (s === "BTCUSDT" ? quietBtc : s === "SOLUSDT" ? solWin : []),
    });
    const settled = store.all.find((o) => o.observationId === opened.observationId)!;
    expect(settled.status).toBe("CLOSED_WIN");
    const frozen = { ...settled };

    // Third cycle: SOL now shows a catastrophic dump — the settled row must NOT change.
    const solDump = fwd([{ open: 10, close: 9, low: 8 }], opened.openedAtMs);
    const third = await runBtcLeadLagCycle({
      ...base,
      now: now + 80 * 60_000,
      fetchCandles: async (s: string) => (s === "BTCUSDT" ? quietBtc : s === "SOLUSDT" ? solDump : []),
    });
    expect(third.resolved).toBe(0);
    expect(store.all.find((o) => o.observationId === opened.observationId)).toEqual(frozen);
  });

  it("quiet market: shock evaluated but NOT detected — and the universe is not even fetched (fetch-budget)", async () => {
    const store = tmpStore("quiet");
    const fetched: string[] = [];
    const quietBtc = candlesFromCloses(compound(100, quietReturns(119)));
    const result = await runBtcLeadLagCycle({
      store,
      universe: ["SOLUSDT", "AVAXUSDT"],
      now: Date.now(),
      fetchCandles: async (s) => {
        fetched.push(s);
        return s === "BTCUSDT" ? quietBtc : [];
      },
    });
    expect(result.shockEvaluated).toBe(true);
    expect(result.shockDetected).toBe(false);
    expect(result.entriesRecorded).toBe(0);
    expect(fetched).toEqual(["BTCUSDT"]); // no open book, no shock → BTC only
    expect(store.cycleMeta.cycles).toBe(1); // liveness: an empty book is still a recorded cycle
  });

  it("insufficient BTC data: shockEvaluated=false (an honest 'could not look', not 'no shock')", async () => {
    const store = tmpStore("nobtc");
    const result = await runBtcLeadLagCycle({
      store,
      universe: ["SOLUSDT"],
      now: Date.now(),
      fetchCandles: async () => [],
    });
    expect(result.shockEvaluated).toBe(false);
    expect(result.shockDetected).toBe(false);
  });

  it("excludes OTHER-cluster symbols even when an override universe smuggles them in", async () => {
    const store = tmpStore("other");
    const { candlesBySymbol, now } = cycleFixture();
    const result = await runBtcLeadLagCycle({
      store,
      universe: ["SOLUSDT", "RANDOMCOINUSDT"],
      now,
      fetchCandles: async (s) => candlesBySymbol[s] ?? candlesBySymbol["SOLUSDT"]!,
    });
    expect(result.scanned).toBe(1); // RANDOMCOINUSDT (OTHER cluster) never scanned
    expect(store.all.every((o) => o.symbol !== "RANDOMCOINUSDT")).toBe(true);
  });

  it("[STUCK-OPEN] an OPEN observation on a symbol whose fetch keeps THROWING eventually expires", async () => {
    const store = tmpStore("stuck");
    const { candlesBySymbol, now } = cycleFixture();
    await runBtcLeadLagCycle({ store, universe: ["SOLUSDT", "AVAXUSDT"], now, fetchCandles: async (s) => candlesBySymbol[s] ?? [] });
    const opened = store.all.find((o) => o.status === "OPEN");
    expect(opened).toBeDefined();

    const laterNow = now + BLS_MAX_HOLD_BARS * BLS_BAR_MS * 3 + BLS_BAR_MS;
    const quietBtc = candlesFromCloses(compound(100, quietReturns(119)), laterNow - 120 * BLS_BAR_MS);
    await runBtcLeadLagCycle({
      store,
      universe: ["SOLUSDT", "AVAXUSDT"],
      now: laterNow,
      fetchCandles: async (s) => {
        if (s === "SOLUSDT") throw new Error("simulated persistent exchange timeout");
        return s === "BTCUSDT" ? quietBtc : [];
      },
    });
    expect(store.all.find((o) => o.observationId === opened!.observationId)!.status).toBe("EXPIRED");
  });

  it("[LIVENESS] a crashing cycle records lastCycleError instead of looking identical to 'no signal'", async () => {
    const store = tmpStore("err");
    const orig = store.save.bind(store);
    let threw = false;
    store.save = () => {
      if (!threw) { threw = true; throw new Error("disk full"); }
      orig();
    };
    const crashed = await runBtcLeadLagCycleGuarded({
      store,
      universe: ["SOLUSDT"],
      now: Date.now(),
      fetchCandles: async () => [],
    });
    expect(crashed).toBeNull();
    expect(store.cycleMeta.lastCycleError).toBe("disk full");
  });
});

// ── store bounds ────────────────────────────────────────────────────────────

describe("btc-leadlag — bounded store", () => {
  it("prunes oldest SETTLED observations past the cap but keeps every OPEN one; survives reload", () => {
    const file = `${tmpdir()}/bls-bound-${Date.now()}-${Math.random()}.json`;
    const store = new BtcLeadLagSnapStore(file);
    for (let i = 0; i < BLS_MAX_STORED_OBSERVATIONS + 25; i++) {
      store.add(obs({ observationId: `settled-${i}`, openedAtMs: START_MS + i, status: "CLOSED_WIN", netR: 0.1 }));
    }
    for (let i = 0; i < 3; i++) {
      store.add(obs({ observationId: `open-${i}`, openedAtMs: START_MS - 10_000 + i, status: "OPEN" }));
    }
    store.save();
    const reloaded = new BtcLeadLagSnapStore(file);
    expect(reloaded.all.length).toBe(BLS_MAX_STORED_OBSERVATIONS + 3);
    expect(reloaded.all.filter((o) => o.status === "OPEN")).toHaveLength(3); // OPEN never pruned, even though oldest
    // Oldest settled dropped first.
    expect(reloaded.has("settled-0")).toBe(false);
    expect(reloaded.has(`settled-${BLS_MAX_STORED_OBSERVATIONS + 24}`)).toBe(true);
  });

  it("add() dedupes by observationId", () => {
    const store = tmpStore("dedupe");
    expect(store.add(obs({ observationId: "same" }))).toBe(true);
    expect(store.add(obs({ observationId: "same" }))).toBe(false);
    expect(store.all).toHaveLength(1);
  });
});

// ── report ──────────────────────────────────────────────────────────────────

describe("btc-leadlag — report", () => {
  it("is NOT edgeReady below the n=30 floor even if every trade won", () => {
    const wins = Array.from({ length: 29 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.5, exitReason: "CONVERGED" }));
    expect(buildBtcLeadLagReport(wins).edgeReady).toBe(false);
  });

  it("is NOT edgeReady with n≥30 but negative expectancy", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      obs({ observationId: `x${i}`, status: i % 2 ? "CLOSED_WIN" : "CLOSED_LOSS", netR: i % 2 ? 0.2 : -0.5, exitReason: i % 2 ? "CONVERGED" : "RESIDUAL_STOP" }));
    expect(buildBtcLeadLagReport(rows).edgeReady).toBe(false);
  });

  it("is edgeReady with adequate sample, netAvgR ≥ 0.05, and PF > 1.1", () => {
    const wins = Array.from({ length: 25 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.6, exitReason: "CONVERGED" }));
    const losses = Array.from({ length: 10 }, (_, i) => obs({ observationId: `l${i}`, status: "CLOSED_LOSS", netR: -0.5, exitReason: "RESIDUAL_STOP" }));
    const report = buildBtcLeadLagReport([...wins, ...losses]);
    expect(report.resolvedCount).toBe(35);
    expect(report.wr).toBeCloseTo(25 / 35, 6);
    expect(report.pf).toBeGreaterThan(1.1);
    expect(report.convergedShare).toBeCloseTo(25 / 35, 6);
    expect(report.stopShare).toBeCloseTo(10 / 35, 6);
    expect(report.edgeReady).toBe(true);
  });

  it("surfaces avg lag-to-convergence and avg detection latency (the slow-cadence handicap, measured)", () => {
    const openedAtMs = START_MS;
    const rows = [
      obs({ observationId: "c1", status: "CLOSED_WIN", netR: 0.5, exitReason: "CONVERGED", openedAtMs, resolvedAt: new Date(openedAtMs + 600_000).toISOString(), detectionLatencyMs: 100_000 }),
      obs({ observationId: "c2", status: "CLOSED_WIN", netR: 0.5, exitReason: "CONVERGED", openedAtMs, resolvedAt: new Date(openedAtMs + 1_200_000).toISOString(), detectionLatencyMs: 300_000 }),
      obs({ observationId: "s1", status: "CLOSED_LOSS", netR: -1.1, exitReason: "RESIDUAL_STOP", openedAtMs, resolvedAt: new Date(openedAtMs + 60_000).toISOString(), detectionLatencyMs: 200_000 }),
    ];
    const report = buildBtcLeadLagReport(rows);
    expect(report.avgLagToConvergenceMs).toBeCloseTo(900_000, 3); // CONVERGED rows only
    expect(report.avgDetectionLatencyMs).toBeCloseTo(200_000, 3); // all rows
  });

  it("breaks results down by direction and keeps OPEN separate from resolved", () => {
    const report = buildBtcLeadLagReport([
      obs({ observationId: "o1", status: "OPEN" }),
      obs({ observationId: "s1", status: "CLOSED_WIN", netR: 0.4, direction: "SHORT" }),
    ]);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(1);
    expect(report.byDirection.find((d) => d.direction === "SHORT")?.resolvedCount).toBe(1);
    expect(report.byDirection.find((d) => d.direction === "LONG")?.resolvedCount).toBe(0);
  });

  it("has the exact core shape required for cross-lane comparison", () => {
    const report = buildBtcLeadLagReport([]);
    expect(report).toMatchObject({
      resolvedCount: 0,
      openCount: 0,
      netAvgR: null,
      wr: null,
      pf: null,
      edgeReady: false,
      avgLagToConvergenceMs: null,
    });
    expect(report.params.shockK).toBeGreaterThan(0);
  });
});

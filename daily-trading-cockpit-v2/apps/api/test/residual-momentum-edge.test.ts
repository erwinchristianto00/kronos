import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  computeSimpleReturns,
  computeOlsBeta,
  computeResidualMomentumScore,
  rankResidualMomentum,
  computeRankPersistence,
  detectLeaderLaggardCatchUp,
  buildResidualMomentumGeometry,
  resolveResidualMomentumObservation,
  buildResidualMomentumReport,
  runResidualMomentumCycle,
  runResidualMomentumCycleGuarded,
  ResidualMomentumStore,
  RM_MAX_HOLD_BARS,
  type ResidualMomentumObservation,
  type ResidualMomentumSymbolScore,
} from "../src/lib/residual-momentum-edge.js";

function candlesFromCloses(closes: number[], startMs = 1_000_000_000_000, stepMs = 3_600_000): Candle[] {
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

describe("residual-momentum — computeSimpleReturns", () => {
  it("computes per-bar simple returns", () => {
    expect(computeSimpleReturns([100, 110, 99])).toEqual([
      (110 - 100) / 100,
      (99 - 110) / 110,
    ]);
  });

  it("returns an empty array for a single close", () => {
    expect(computeSimpleReturns([100])).toEqual([]);
  });
});

describe("residual-momentum — computeOlsBeta (known synthetic beta)", () => {
  it("recovers an exact beta when the symbol moves in a perfectly proportional relationship to the market", () => {
    // Market (BTC) returns with real variety (no constant series -> nonzero Var(x)).
    const btcReturns = [0.01, -0.015, 0.02, -0.01, 0.005, -0.02, 0.015, -0.005, 0.01, -0.01];
    const trueBeta = 2.0;
    const symbolReturns = btcReturns.map((r) => trueBeta * r);
    const beta = computeOlsBeta(symbolReturns, btcReturns);
    expect(beta).not.toBeNull();
    expect(beta!).toBeCloseTo(trueBeta, 9);
  });

  it("recovers a fractional/negative beta just as exactly", () => {
    const btcReturns = [0.02, -0.03, 0.01, -0.005, 0.015, -0.01, 0.025, -0.02];
    const trueBeta = -0.5;
    const symbolReturns = btcReturns.map((r) => trueBeta * r);
    const beta = computeOlsBeta(symbolReturns, btcReturns);
    expect(beta!).toBeCloseTo(trueBeta, 9);
  });

  it("returns null when the market series has zero variance (no identifiable slope)", () => {
    const btcReturns = [0.01, 0.01, 0.01, 0.01];
    const symbolReturns = [0.02, 0.02, 0.02, 0.02];
    expect(computeOlsBeta(symbolReturns, btcReturns)).toBeNull();
  });

  it("returns null with fewer than 2 observations", () => {
    expect(computeOlsBeta([0.01], [0.02])).toBeNull();
    expect(computeOlsBeta([], [])).toBeNull();
  });
});

describe("residual-momentum — computeResidualMomentumScore (beta + residual return on candles)", () => {
  const btcReturns = [0.01, -0.02, 0.015, -0.01, 0.02, -0.015, 0.01, -0.005];
  const trueBeta = 1.5;

  it("reports ~zero residual return when the symbol tracks BTC in exact proportion to its own beta", () => {
    const symbolReturns = btcReturns.map((r) => trueBeta * r);
    const btcCloses = compound(100, btcReturns);
    const symbolCloses = compound(50, symbolReturns);
    const btcCandles = candlesFromCloses(btcCloses);
    const symbolCandles = candlesFromCloses(symbolCloses);

    const score = computeResidualMomentumScore(symbolCandles, btcCandles, {
      betaWindowBars: 8, momentumBars: 4, minBetaSamples: 4,
    });
    expect(score).not.toBeNull();
    expect(score!.beta).toBeCloseTo(trueBeta, 2);
    expect(score!.residualReturn).toBeCloseTo(0, 2);
  });

  it("reports a clearly POSITIVE residual return when the symbol outperforms what its beta predicts", () => {
    const symbolReturns = btcReturns.map((r) => trueBeta * r);
    // Idiosyncratic pump on the final (most recent) bar only.
    symbolReturns[symbolReturns.length - 1] = symbolReturns[symbolReturns.length - 1]! + 0.05;
    const btcCloses = compound(100, btcReturns);
    const symbolCloses = compound(50, symbolReturns);
    const score = computeResidualMomentumScore(candlesFromCloses(symbolCloses), candlesFromCloses(btcCloses), {
      betaWindowBars: 8, momentumBars: 4, minBetaSamples: 4,
    });
    expect(score).not.toBeNull();
    expect(score!.residualReturn).toBeGreaterThan(0.02);
  });

  it("reports a clearly NEGATIVE residual return when the symbol underperforms what its beta predicts", () => {
    const symbolReturns = btcReturns.map((r) => trueBeta * r);
    symbolReturns[symbolReturns.length - 1] = symbolReturns[symbolReturns.length - 1]! - 0.05;
    const btcCloses = compound(100, btcReturns);
    const symbolCloses = compound(50, symbolReturns);
    const score = computeResidualMomentumScore(candlesFromCloses(symbolCloses), candlesFromCloses(btcCloses), {
      betaWindowBars: 8, momentumBars: 4, minBetaSamples: 4,
    });
    expect(score).not.toBeNull();
    expect(score!.residualReturn).toBeLessThan(-0.02);
  });

  it("a high-beta symbol that simply amplifies BTC's move shows ~zero residual (raw ROC would rank it high; residual correctly discounts it)", () => {
    // Symbol moves 3x BTC on every bar -- a raw-ROC ranking would see a huge move, but it's ALL
    // beta-implied co-movement, no genuine idiosyncratic component.
    const amplifiedReturns = btcReturns.map((r) => 3 * r);
    const btcCloses = compound(100, btcReturns);
    const symbolCloses = compound(50, amplifiedReturns);
    const score = computeResidualMomentumScore(candlesFromCloses(symbolCloses), candlesFromCloses(btcCloses), {
      betaWindowBars: 8, momentumBars: 4, minBetaSamples: 4,
    });
    expect(score).not.toBeNull();
    expect(score!.beta).toBeCloseTo(3, 2);
    expect(Math.abs(score!.residualReturn)).toBeLessThan(0.01);
  });

  it("returns null when there isn't enough aligned history", () => {
    const btcCandles = candlesFromCloses(compound(100, btcReturns.slice(0, 3)));
    const symbolCandles = candlesFromCloses(compound(50, btcReturns.slice(0, 3).map((r) => trueBeta * r)));
    expect(computeResidualMomentumScore(symbolCandles, btcCandles, { betaWindowBars: 8, momentumBars: 4, minBetaSamples: 4 })).toBeNull();
  });

  it("returns null when BTC and symbol candles don't share any common openTimes (misalignment guard)", () => {
    const btcCandles = candlesFromCloses(compound(100, btcReturns), 1_000_000_000_000);
    // Shifted timeline -- zero overlapping openTimes with the BTC series above.
    const symbolCandles = candlesFromCloses(compound(50, btcReturns.map((r) => trueBeta * r)), 2_000_000_000_000);
    expect(computeResidualMomentumScore(symbolCandles, btcCandles, { betaWindowBars: 8, momentumBars: 4, minBetaSamples: 4 })).toBeNull();
  });
});

describe("residual-momentum — rankResidualMomentum", () => {
  it("ranks descending by residualReturn, rank 1 = highest", () => {
    const scores: ResidualMomentumSymbolScore[] = [
      { symbol: "A", price: 1, beta: 1, symbolReturn: 0, btcReturn: 0, residualReturn: 0.02 },
      { symbol: "B", price: 1, beta: 1, symbolReturn: 0, btcReturn: 0, residualReturn: 0.05 },
      { symbol: "C", price: 1, beta: 1, symbolReturn: 0, btcReturn: 0, residualReturn: -0.01 },
    ];
    const ranked = rankResidualMomentum(scores);
    expect(ranked.map((r) => r.symbol)).toEqual(["B", "A", "C"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});

describe("residual-momentum — computeRankPersistence", () => {
  it("is 1.0 (maximally persistent) when the rank never changes", () => {
    expect(computeRankPersistence([3, 3, 3, 3], 10)).toBeCloseTo(1, 9);
  });

  it("is 0.0 when the rank swings the full width of the universe every observation", () => {
    expect(computeRankPersistence([1, 10, 1, 10], 10)).toBeCloseTo(0, 9);
  });

  it("is somewhere in between for partial rank drift", () => {
    const p = computeRankPersistence([1, 2, 1, 3], 10);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("returns 0 with fewer than 2 history points (not enough evidence yet)", () => {
    expect(computeRankPersistence([5], 10)).toBe(0);
    expect(computeRankPersistence([], 10)).toBe(0);
  });
});

function score(symbol: string, residualReturn: number): ResidualMomentumSymbolScore {
  return { symbol, price: 100, beta: 1, symbolReturn: residualReturn, btcReturn: 0, residualReturn };
}

describe("residual-momentum — detectLeaderLaggardCatchUp", () => {
  it("flags a LONG catch-up candidate when most L1-cluster members are strongly up but one is still lagging", () => {
    const scores = [
      score("SOLUSDT", 0.05),
      score("AVAXUSDT", 0.06),
      score("NEARUSDT", 0.055),
      score("SUIUSDT", 0.001), // laggard: essentially hasn't moved
    ];
    const candidates = detectLeaderLaggardCatchUp(scores);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.symbol).toBe("SUIUSDT");
    expect(candidates[0]!.direction).toBe("LONG");
    expect(candidates[0]!.cluster).toBe("L1");
  });

  it("flags a SHORT catch-up candidate (symmetric mirror) when most members are strongly down but one hasn't fallen yet", () => {
    const scores = [
      score("SOLUSDT", -0.05),
      score("AVAXUSDT", -0.06),
      score("NEARUSDT", -0.055),
      score("SUIUSDT", -0.001), // laggard on the downside
    ];
    const candidates = detectLeaderLaggardCatchUp(scores);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.symbol).toBe("SUIUSDT");
    expect(candidates[0]!.direction).toBe("SHORT");
  });

  it("does NOT trigger when fewer than the strong-fraction threshold of the cluster is moving strongly", () => {
    const scores = [
      score("SOLUSDT", 0.05), // strong
      score("AVAXUSDT", 0.002), // not strong
      score("NEARUSDT", 0.001), // not strong
      score("SUIUSDT", 0.001), // not strong
    ];
    // Only 1/4 = 25% strong, below the 60% default fraction -- no candidates at all.
    expect(detectLeaderLaggardCatchUp(scores)).toEqual([]);
  });

  it("does NOT trigger on the OTHER cluster even if most members show a strong move (heterogeneous grab-bag, not a real correlation group)", () => {
    const scores = [
      score("RANDOMCOINUSDT", 0.05),
      score("ANOTHERCOINUSDT", 0.06),
      score("YETANOTHERCOINUSDT", 0.055),
      score("MYSTERYCOINUSDT", 0.001),
    ];
    expect(detectLeaderLaggardCatchUp(scores)).toEqual([]);
  });

  it("does NOT trigger when the cluster has fewer than minClusterSize present members", () => {
    // MAJORS cluster: only ETHUSDT present (BTC is the benchmark, excluded from the ranked universe
    // upstream) -- a single-member cluster is too thin a sample.
    const scores = [score("ETHUSDT", 0.05)];
    expect(detectLeaderLaggardCatchUp(scores)).toEqual([]);
  });

  it("flags every qualifying laggard, not just one, when a cluster has multiple laggards", () => {
    // 3/5 = 60% strong -- exactly at the default strong-fraction threshold.
    const scores = [
      score("SOLUSDT", 0.05),
      score("AVAXUSDT", 0.06),
      score("APTUSDT", 0.07),
      score("NEARUSDT", 0.001), // laggard 1
      score("SUIUSDT", 0.002), // laggard 2
    ];
    const candidates = detectLeaderLaggardCatchUp(scores);
    expect(candidates.map((c) => c.symbol).sort()).toEqual(["NEARUSDT", "SUIUSDT"]);
  });
});

describe("residual-momentum — geometry", () => {
  it("builds LONG geometry: stop below entry, TP above entry, at RM_TP_REWARD_MULTIPLE x risk", () => {
    const geo = buildResidualMomentumGeometry(100, "LONG");
    expect(geo).not.toBeNull();
    expect(geo!.initialStop).toBeLessThan(100);
    expect(geo!.takeProfitPrice).toBeGreaterThan(100);
    const risk = geo!.entryPrice - geo!.initialStop;
    expect((geo!.takeProfitPrice - geo!.entryPrice) / risk).toBeCloseTo(1.5, 6);
  });

  it("builds SHORT geometry: stop above entry, TP below entry", () => {
    const geo = buildResidualMomentumGeometry(100, "SHORT");
    expect(geo).not.toBeNull();
    expect(geo!.initialStop).toBeGreaterThan(100);
    expect(geo!.takeProfitPrice).toBeLessThan(100);
  });

  it("rejects a non-positive entry price", () => {
    expect(buildResidualMomentumGeometry(0, "LONG")).toBeNull();
    expect(buildResidualMomentumGeometry(-10, "SHORT")).toBeNull();
  });
});

function obs(over: Partial<ResidualMomentumObservation> = {}): ResidualMomentumObservation {
  const geo = buildResidualMomentumGeometry(100, "LONG")!;
  return {
    observationId: "rm:test:1",
    symbol: "TESTUSDT",
    kind: "DISPERSION_LONG",
    direction: "LONG",
    ...geo,
    residualReturnAtEntry: 0.05,
    betaAtEntry: 1.2,
    rankAtEntry: 1,
    persistenceAtEntry: 0.8,
    cluster: null,
    clusterAvgResidualReturnAtEntry: null,
    openedAt: new Date(1_000_000_000_000).toISOString(),
    openedAtMs: 1_000_000_000_000,
    status: "OPEN",
    grossR: null,
    costR: null,
    netR: null,
    exitReason: null,
    resolvedAt: null,
    ...over,
  };
}

function fwd(prices: Array<{ close: number; high?: number; low?: number }>, startMs = 1_000_000_000_000): Candle[] {
  let t = startMs;
  return prices.map((p) => {
    t += 3_600_000;
    return { openTime: t, open: p.close, high: p.high ?? p.close, low: p.low ?? p.close, close: p.close, volume: 100 };
  });
}

describe("residual-momentum — resolution (LONG)", () => {
  it("books the win at the TP price when price rallies through it", () => {
    const o = obs();
    const patch = resolveResidualMomentumObservation(o, fwd([{ close: 101, high: 101.2 }, { close: o.takeProfitPrice + 1, high: o.takeProfitPrice + 1 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("TP_HIT");
  });

  it("books the loss at the initial stop when price falls through it", () => {
    const o = obs();
    const patch = resolveResidualMomentumObservation(o, fwd([{ close: 99, low: o.initialStop - 1 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.grossR).toBeCloseTo(-1, 6);
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("SL-first when a single candle touches both stop and TP", () => {
    const o = obs();
    const patch = resolveResidualMomentumObservation(o, fwd([{ close: 100, high: o.takeProfitPrice + 1, low: o.initialStop - 1 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });

  it("marks to market at max hold when neither stop nor TP fires", () => {
    const o = obs();
    const flatBars = Array.from({ length: RM_MAX_HOLD_BARS }, () => ({ close: 100.2, high: 100.3, low: 100.1 }));
    const patch = resolveResidualMomentumObservation(o, fwd(flatBars), Date.now());
    expect(patch?.exitReason).toBe("MAX_HOLD_MTM");
  });

  it("returns null (still open) with insufficient forward candles and not yet stale", () => {
    const o = obs();
    expect(resolveResidualMomentumObservation(o, [], o.openedAtMs + 3_600_000)).toBeNull();
  });

  it("expires a stale OPEN observation with no forward candles ever", () => {
    const o = obs();
    const staleNowMs = o.openedAtMs + RM_MAX_HOLD_BARS * 3_600_000 * 4;
    expect(resolveResidualMomentumObservation(o, [], staleNowMs)?.status).toBe("EXPIRED");
  });
});

describe("residual-momentum — resolution (SHORT)", () => {
  it("books the win at the TP price when price falls through it", () => {
    const o = obs({ ...buildResidualMomentumGeometry(100, "SHORT")!, direction: "SHORT", kind: "DISPERSION_SHORT" });
    const patch = resolveResidualMomentumObservation(o, fwd([{ close: 99, low: o.takeProfitPrice - 1 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("TP_HIT");
  });

  it("books the loss at the initial stop when price rallies through it", () => {
    const o = obs({ ...buildResidualMomentumGeometry(100, "SHORT")!, direction: "SHORT", kind: "DISPERSION_SHORT" });
    const patch = resolveResidualMomentumObservation(o, fwd([{ close: 101, high: o.initialStop + 1 }]), Date.now());
    expect(patch?.status).toBe("CLOSED_LOSS");
    expect(patch?.exitReason).toBe("INITIAL_STOP");
  });
});

// ── no-lookahead regression ──────────────────────────────────────────────────
describe("residual-momentum — resolver has NO lookahead", () => {
  it("ignores a candle at/before openedAtMs even if it would trigger an exit (never uses the entry bar's own future-relative-to-nothing data)", () => {
    const o = obs();
    // A candle stamped exactly at openedAtMs (not strictly after) that would hit TP if considered.
    const sameTimeCandle: Candle = { openTime: o.openedAtMs, open: o.takeProfitPrice, high: o.takeProfitPrice + 5, low: o.takeProfitPrice - 1, close: o.takeProfitPrice, volume: 100 };
    // The only genuinely-forward candle does not trigger anything.
    const laterCandle: Candle = { openTime: o.openedAtMs + 3_600_000, open: 100.1, high: 100.2, low: 100, close: 100.1, volume: 100 };
    const patch = resolveResidualMomentumObservation(o, [sameTimeCandle, laterCandle], o.openedAtMs + 3_600_000 * 2);
    expect(patch).toBeNull(); // still open -- the same-timestamp candle must never be consulted
  });

  it("[REGRESSION] the decided exit at the FIRST qualifying forward candle is never overwritten by appending more candles afterward, even ones that would reverse the outcome", () => {
    const o = obs();
    // c1: no trigger. c2: hits TP (favorable). c3/c4 (only appended in the second call): would have
    // hit the stop far below entry if the resolver ever looked past c2 -- it must not.
    const c1 = { close: 100.2, high: 100.3, low: 100.1 };
    const c2 = { close: o.takeProfitPrice + 2, high: o.takeProfitPrice + 2, low: o.takeProfitPrice - 1 }; // TP hit here
    const c3 = { close: o.initialStop - 50, high: o.initialStop - 40, low: o.initialStop - 60 }; // deep "stop" territory, AFTER TP already fired
    const c4 = { close: o.initialStop - 100, high: o.initialStop - 90, low: o.initialStop - 110 };

    const truncated = resolveResidualMomentumObservation(o, fwd([c1, c2]), Date.now());
    const extended = resolveResidualMomentumObservation(o, fwd([c1, c2, c3, c4]), Date.now());

    expect(truncated?.status).toBe("CLOSED_WIN");
    expect(truncated?.exitReason).toBe("TP_HIT");
    // The extended (future-laden) call must produce the IDENTICAL resolution -- proof that later
    // candle data (c3/c4) never influenced an already-decided exit.
    expect(extended).toEqual(truncated);
  });

  it("[REGRESSION] a stop hit at the first qualifying candle is never overwritten by a later, more-favorable candle even if it would have produced a bigger/opposite result", () => {
    const o = obs();
    const c1 = { close: o.initialStop - 1, low: o.initialStop - 2, high: o.initialStop + 1 }; // stop hit here
    const c2 = { close: o.takeProfitPrice + 50, high: o.takeProfitPrice + 60, low: o.takeProfitPrice + 40 }; // huge favorable move AFTER the stop already fired

    const truncated = resolveResidualMomentumObservation(o, fwd([c1]), Date.now());
    const extended = resolveResidualMomentumObservation(o, fwd([c1, c2]), Date.now());

    expect(truncated?.status).toBe("CLOSED_LOSS");
    expect(truncated?.exitReason).toBe("INITIAL_STOP");
    expect(extended).toEqual(truncated);
  });
});

describe("residual-momentum — report", () => {
  it("is not edgeReady below the sample floor even if every trade won", () => {
    const wins = Array.from({ length: 10 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.4 }));
    expect(buildResidualMomentumReport(wins).edgeReady).toBe(false);
  });

  it("is edgeReady with adequate sample, positive net, and a real payoff", () => {
    const wins = Array.from({ length: 25 }, (_, i) => obs({ observationId: `w${i}`, status: "CLOSED_WIN", netR: 0.6, exitReason: "TP_HIT" }));
    const losses = Array.from({ length: 10 }, (_, i) => obs({ observationId: `l${i}`, status: "CLOSED_LOSS", netR: -0.5, exitReason: "INITIAL_STOP" }));
    const report = buildResidualMomentumReport([...wins, ...losses]);
    expect(report.resolvedCount).toBe(35);
    expect(report.netAvgR).not.toBeNull();
    expect(report.wr).toBeCloseTo(25 / 35, 6);
    expect(report.pf).toBeGreaterThan(1.1);
    expect(report.edgeReady).toBe(true);
  });

  it("counts OPEN observations separately from resolved and breaks results down byKind", () => {
    const report = buildResidualMomentumReport([
      obs({ status: "OPEN" }),
      obs({ observationId: "x2", status: "CLOSED_WIN", netR: 0.3, kind: "CATCHUP_LONG" }),
    ]);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(1);
    const catchupRow = report.byKind.find((k) => k.kind === "CATCHUP_LONG");
    expect(catchupRow?.resolvedCount).toBe(1);
    const dispersionRow = report.byKind.find((k) => k.kind === "DISPERSION_LONG");
    expect(dispersionRow?.resolvedCount).toBe(0);
  });

  it("has the exact core report shape required for cross-lane comparison", () => {
    const report = buildResidualMomentumReport([]);
    expect(report).toMatchObject({
      resolvedCount: 0,
      openCount: 0,
      netAvgR: null,
      wr: null,
      pf: null,
      edgeReady: false,
    });
  });
});

describe("residual-momentum — cycle", () => {
  function makeSeries(closes: number[]): Candle[] {
    return candlesFromCloses(closes, 1_000_000_000_000);
  }

  it("scores the universe, records dispersion top/bottom signals, and persists rank history", async () => {
    const store = new ResidualMomentumStore(`/tmp/rm-test-${Date.now()}-${Math.random()}.json`);
    // 65 bars comfortably clears the default RM_BETA_WINDOW_BARS(60)+1 alignment requirement.
    const btcReturns = Array.from({ length: 65 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.008));
    const btcCloses = compound(100, btcReturns);

    const candlesBySymbol: Record<string, Candle[]> = {
      BTCUSDT: makeSeries(btcCloses),
      // Strong positive residual: beats what beta=1 implies.
      WINNERUSDT: makeSeries(compound(50, btcReturns.map((r, i) => r + (i === btcReturns.length - 1 ? 0.08 : 0)))),
      // Strong negative residual.
      LOSERUSDT: makeSeries(compound(50, btcReturns.map((r, i) => r - (i === btcReturns.length - 1 ? 0.08 : 0)))),
      // Tracks beta exactly -- near-zero residual, should not be selected ahead of the extremes.
      NEUTRALUSDT: makeSeries(compound(50, btcReturns)),
    };

    const result = await runResidualMomentumCycle({
      store,
      universe: ["BTCUSDT", "WINNERUSDT", "LOSERUSDT", "NEUTRALUSDT"],
      now: Date.now(),
      fetchCandles: async (symbol) => candlesBySymbol[symbol] ?? [],
    });

    expect(result.scored).toBe(3); // BTC excluded from the ranked/tradable universe
    expect(result.dispersionRecorded).toBeGreaterThan(0);
    const longs = store.all.filter((o) => o.kind === "DISPERSION_LONG");
    const shorts = store.all.filter((o) => o.kind === "DISPERSION_SHORT");
    expect(longs.some((o) => o.symbol === "WINNERUSDT")).toBe(true);
    expect(shorts.some((o) => o.symbol === "LOSERUSDT")).toBe(true);
    // Rank history persisted for every scored symbol.
    expect(store.rankHistoryFor("WINNERUSDT").length).toBeGreaterThan(0);
  });

  it("dedupes: does not open a second DISPERSION_LONG for a symbol with a recent OPEN one of the same kind", async () => {
    const store = new ResidualMomentumStore(`/tmp/rm-test-${Date.now()}-${Math.random()}.json`);
    const btcReturns = Array.from({ length: 65 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.008));
    const btcCloses = compound(100, btcReturns);
    const candlesBySymbol: Record<string, Candle[]> = {
      BTCUSDT: makeSeries(btcCloses),
      WINNERUSDT: makeSeries(compound(50, btcReturns.map((r, i) => r + (i === btcReturns.length - 1 ? 0.08 : 0)))),
      LOSERUSDT: makeSeries(compound(50, btcReturns.map((r, i) => r - (i === btcReturns.length - 1 ? 0.08 : 0)))),
    };
    const base = {
      store,
      universe: ["BTCUSDT", "WINNERUSDT", "LOSERUSDT"],
      fetchCandles: async (symbol: string) => candlesBySymbol[symbol] ?? [],
    };
    const now = Date.now();
    await runResidualMomentumCycle({ ...base, now });
    const afterFirst = store.all.length;
    expect(afterFirst).toBeGreaterThan(0); // sanity: the first cycle actually recorded something
    await runResidualMomentumCycle({ ...base, now: now + 60_000 }); // 1 minute later, well inside the 1h dedupe window
    expect(store.all.length).toBe(afterFirst);
  });

  it("[LIVENESS] persists cycle meta across cycles and reloads, and the report surfaces it", async () => {
    const file = `/tmp/rm-meta-${Date.now()}-${Math.random()}.json`;
    const store = new ResidualMomentumStore(file);
    const btcReturns = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.008));
    const candlesBySymbol: Record<string, Candle[]> = {
      BTCUSDT: makeSeries(compound(100, btcReturns)),
      AUSDT: makeSeries(compound(50, btcReturns)),
    };
    const base = { store, universe: ["BTCUSDT", "AUSDT"], fetchCandles: async (s: string) => candlesBySymbol[s] ?? [] };
    await runResidualMomentumCycle({ ...base, now: Date.now() });
    await runResidualMomentumCycle({ ...base, now: Date.now() + 3_600_000 });
    expect(store.cycleMeta.cycles).toBe(2);
    expect(store.cycleMeta.lastCycleAt).not.toBeNull();
    expect(store.cycleMeta.lastCycleError).toBeNull();

    const reloaded = new ResidualMomentumStore(file);
    expect(reloaded.cycleMeta.cycles).toBe(2);
    const report = buildResidualMomentumReport(reloaded.all, reloaded.cycleMeta);
    expect(report.cycleMeta?.cycles).toBe(2);
  });

  it("[LIVENESS] a crashing cycle records lastCycleError instead of looking identical to 'no signal'", async () => {
    const store = new ResidualMomentumStore(`/tmp/rm-err-${Date.now()}-${Math.random()}.json`);
    const orig = store.save.bind(store);
    let threw = false;
    store.save = () => {
      if (!threw) { threw = true; throw new Error("disk full"); }
      orig();
    };
    const crashed = await runResidualMomentumCycleGuarded({
      store,
      universe: ["BTCUSDT"],
      now: Date.now(),
      fetchCandles: async () => [],
    });
    expect(crashed).toBeNull();
    expect(store.cycleMeta.lastCycleError).toBe("disk full");
  });

  it("gracefully records zero scored/recorded when BTC candles are unavailable", async () => {
    const store = new ResidualMomentumStore(`/tmp/rm-nobtc-${Date.now()}-${Math.random()}.json`);
    const result = await runResidualMomentumCycle({
      store,
      universe: ["AUSDT"],
      now: Date.now(),
      fetchCandles: async (symbol) => (symbol === "BTCUSDT" ? [] : candlesFromCloses([100, 101, 102])),
    });
    expect(result.scored).toBe(0);
    expect(result.dispersionRecorded).toBe(0);
    expect(result.catchupRecorded).toBe(0);
  });

  // [STUCK-OPEN-FIX] 2026-07-11: a symbol whose fetchCandles keeps THROWING (not just returning
  // empty) previously skipped resolveResidualMomentumObservation entirely every cycle — its
  // built-in stale-expiry fallback (fwd.length===0 && well past RM_MAX_HOLD_BARS) never got a
  // chance to run, so the observation stayed OPEN forever, biasing openCount/resolvedCount/netAvgR.
  it("[STUCK-OPEN-FIX] an OPEN observation on a symbol whose fetch keeps throwing eventually EXPIRES instead of staying stuck OPEN forever", async () => {
    const store = new ResidualMomentumStore(`/tmp/rm-stuck-${Date.now()}-${Math.random()}.json`);
    const btcReturns = Array.from({ length: 65 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.008));
    const btcCloses = compound(100, btcReturns);
    const candlesBySymbol: Record<string, number[]> = {
      BTCUSDT: btcCloses,
      WINNERUSDT: compound(50, btcReturns.map((r, i) => r + (i === btcReturns.length - 1 ? 0.08 : 0))),
      LOSERUSDT: compound(50, btcReturns.map((r, i) => r - (i === btcReturns.length - 1 ? 0.08 : 0))),
      NEUTRALUSDT: compound(50, btcReturns),
    };
    const now0 = Date.now();

    // Cycle 1: same 4-symbol universe as the "scores the universe" test above — WINNERUSDT opens a
    // real DISPERSION_LONG observation.
    await runResidualMomentumCycle({
      store,
      universe: ["BTCUSDT", "WINNERUSDT", "LOSERUSDT", "NEUTRALUSDT"],
      now: now0,
      fetchCandles: async (symbol) => makeSeries(candlesBySymbol[symbol] ?? []),
    });
    const opened = store.all.find((o) => o.symbol === "WINNERUSDT" && o.status === "OPEN");
    expect(opened).toBeDefined();

    // Subsequent cycle, well past this dispersion lane's stale-expiry threshold (RM_MAX_HOLD_BARS
    // hours * 3): WINNERUSDT's own fetch now THROWS every time (simulating a persistent exchange/
    // network failure on exactly the symbol with the open observation).
    const laterNow = now0 + RM_MAX_HOLD_BARS * 3_600_000 * 3 + 3_600_000;
    await runResidualMomentumCycle({
      store,
      universe: ["BTCUSDT", "WINNERUSDT", "LOSERUSDT", "NEUTRALUSDT"],
      now: laterNow,
      fetchCandles: async (symbol) => {
        if (symbol === "WINNERUSDT") throw new Error("simulated persistent exchange timeout");
        return makeSeries(candlesBySymbol[symbol] ?? []);
      },
    });

    const after = store.all.find((o) => o.observationId === opened!.observationId)!;
    expect(after.status).toBe("EXPIRED"); // not stuck OPEN forever
  });
});

describe("residual-momentum — rank-history persistence in the store", () => {
  it("bounds the ring buffer to RM_RANK_HISTORY_MAX and survives a reload", () => {
    const file = `/tmp/rm-rankhist-${Date.now()}-${Math.random()}.json`;
    const store = new ResidualMomentumStore(file);
    for (let i = 1; i <= 30; i++) store.pushRank("AUSDT", i);
    expect(store.rankHistoryFor("AUSDT").length).toBeLessThanOrEqual(20);
    // Most recent ranks are retained (the buffer drops the OLDEST first).
    expect(store.rankHistoryFor("AUSDT")[store.rankHistoryFor("AUSDT").length - 1]).toBe(30);
    store.save();
    const reloaded = new ResidualMomentumStore(file);
    expect(reloaded.rankHistoryFor("AUSDT")).toEqual(store.rankHistoryFor("AUSDT"));
  });
});

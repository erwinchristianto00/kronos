import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  deriveAdaptiveSymbolFilters,
  crossSectionalMomentumScore,
  buildCrossSectionalBasket,
  buildFilteredCrossSectionalBasket,
  buildTrendCrossSectionalBasket,
  buildMixedCrossSectionalBasket,
  resolveCrossSectional,
  buildCrossSectionalReport,
  runCrossSectionalCycle,
  CrossSectionalStore,
  CROSS_SECTIONAL_HORIZON_MS,
  CROSS_SECTIONAL_FILTERED_SIGNAL,
  CROSS_SECTIONAL_TREND_SIGNAL,
  CROSS_SECTIONAL_MIXED_SIGNAL,
  buildCrossSectionalRegimeContext,
  CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST,
  CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST,
  CROSS_SECTIONAL_TREND_LONG_ALLOWLIST,
  CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST,
  regimeSkewedK,
  regimeSkewCounterfactual,
  type ScoredSymbol,
  type CrossSectionalObservation,
} from "../src/lib/cross-sectional-edge.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mkCandle(close: number): Candle {
  return { openTime: 0, open: close, high: close, low: close, close, volume: 1 };
}
function candles(closes: number[]): Candle[] {
  return closes.map(mkCandle);
}
function scored(rows: Array<[string, number, number]>): ScoredSymbol[] {
  return rows.map(([symbol, score, price]) => ({ symbol, score, price }));
}
function freshStore(): CrossSectionalStore {
  return new CrossSectionalStore(mkdtempSync(join(tmpdir(), "xsec-")));
}
const T0 = "2099-01-02T00:00:00.000Z";
const T0ms = new Date(T0).getTime();

describe("cross-sectional-edge — market-neutral measurement lane", () => {
  it("[SCORE] momentum score is the N-bar return + latest close", () => {
    const s = crossSectionalMomentumScore(candles([100, 101, 110]), 2); // (110-100)/100
    expect(s).not.toBeNull();
    expect(s!.score).toBeCloseTo(0.1, 9);
    expect(s!.price).toBe(110);
    expect(crossSectionalMomentumScore(candles([100, 101]), 5)).toBeNull(); // not enough history
  });

  it("[BASKET] longs the top-k scores, shorts the bottom-k", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 10], ["B", 0.3, 20], ["C", -0.1, 30], ["D", -0.4, 40]]),
      { k: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS },
    )!;
    expect(b.longLeg.map((l) => l.symbol)).toEqual(["A"]); // highest score
    expect(b.shortLeg.map((l) => l.symbol)).toEqual(["D"]); // lowest score
    expect(b.status).toBe("OPEN");
  });

  it("[FILTERED] applies long/short symbol guardrails and score-gap floor", () => {
    const b = buildFilteredCrossSectionalBasket(
      scored([
        ["FETUSDT", 0.12, 10], // high score but not long-allowlisted
        ["SOLUSDT", 0.10, 20],
        ["AVAXUSDT", 0.08, 30],
        ["INJUSDT", -0.20, 40], // weak but short-blocklisted
        ["WLDUSDT", -0.12, 50],
        ["DOGEUSDT", -0.08, 60],
      ]),
      {
        k: 2,
        now: T0,
        openedAtMs: T0ms,
        horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        minScoreGap: 0.05,
        longAllowlist: new Set(["SOLUSDT", "AVAXUSDT"]),
        shortAllowlist: new Set(["WLDUSDT", "DOGEUSDT", "INJUSDT"]),
        shortBlocklist: new Set(["INJUSDT"]),
      },
    )!;
    expect(b.signal).toBe(CROSS_SECTIONAL_FILTERED_SIGNAL);
    expect(b.variant).toBe("FILTERED");
    expect(b.longLeg.map((l) => l.symbol)).toEqual(["SOLUSDT", "AVAXUSDT"]);
    expect(b.shortLeg.map((l) => l.symbol)).toEqual(["WLDUSDT", "DOGEUSDT"]);
    expect(b.scoreGap).toBeGreaterThanOrEqual(0.05);
  });

  it("[FILTERED-GAP] refuses low-dispersion baskets", () => {
    const b = buildFilteredCrossSectionalBasket(
      scored([["SOLUSDT", 0.021, 20], ["AVAXUSDT", 0.020, 30], ["WLDUSDT", 0.019, 50], ["DOGEUSDT", 0.018, 60]]),
      {
        k: 2,
        now: T0,
        openedAtMs: T0ms,
        horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        minScoreGap: 0.01,
        longAllowlist: new Set(["SOLUSDT", "AVAXUSDT"]),
        shortAllowlist: new Set(["WLDUSDT", "DOGEUSDT"]),
      },
    );
    expect(b).toBeNull();
  });

  it("[INSUFFICIENT] returns null when there aren't enough names for both legs", () => {
    const b = buildCrossSectionalBasket(scored([["A", 0.5, 10], ["B", 0.3, 20]]), {
      k: 2, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS,
    });
    expect(b).toBeNull(); // need 2*k = 4
  });

  it("[NEUTRAL] a uniform market move nets ~0 (beta cancels)", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 100], ["B", 0.3, 100], ["C", -0.1, 100], ["D", -0.4, 100]]),
      { k: 2, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: 1000 },
    )!;
    // every symbol rises +10% → longs +10%, shorts -10% (as shorts) → net 0 before cost
    const prices = { A: 110, B: 110, C: 110, D: 110 };
    const r = resolveCrossSectional(b, prices, new Date(T0ms + 2000).toISOString(), 0);
    expect(r.status).toBe("CLOSED");
    expect(r.grossReturn!).toBeCloseTo(0, 9);
  });

  it("[DISPERSION] positive when the longs outperform the shorts, regardless of market direction", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 100], ["B", 0.3, 100], ["C", -0.1, 100], ["D", -0.4, 100]]),
      { k: 2, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: 1000 },
    )!;
    // BULL but longs lead: longs +20%, shorts only +5% → still positive dispersion
    const bull = resolveCrossSectional(b, { A: 120, B: 120, C: 105, D: 105 }, new Date(T0ms + 2000).toISOString(), 0);
    expect(bull.grossReturn!).toBeGreaterThan(0);
    // BEAR but longs lead (fall less): longs -5%, shorts -20% → still positive
    const bear = resolveCrossSectional(b, { A: 95, B: 95, C: 80, D: 80 }, new Date(T0ms + 2000).toISOString(), 0);
    expect(bear.grossReturn!).toBeGreaterThan(0);
  });

  it("[RESOLVE-HORIZON] does not resolve before the horizon, resolves after", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 100], ["B", -0.4, 100]]),
      { k: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: 10_000 },
    )!;
    const prices = { A: 110, B: 90 };
    const early = resolveCrossSectional(b, prices, new Date(T0ms + 5_000).toISOString(), 0);
    expect(early.status).toBe("OPEN"); // before horizon
    const late = resolveCrossSectional(b, prices, new Date(T0ms + 11_000).toISOString(), 0);
    expect(late.status).toBe("CLOSED");
    // long A +10%, short B +10% (price fell 10% → short gains 10%) → gross = (0.1+0.1)/2 = 0.1
    expect(late.grossReturn!).toBeCloseTo(0.1, 9);
  });

  it("[COST] netReturn = grossReturn − roundtrip bps", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 100], ["B", -0.4, 100]]),
      { k: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: 1000 },
    )!;
    const r = resolveCrossSectional(b, { A: 110, B: 90 }, new Date(T0ms + 2000).toISOString(), 12);
    expect(r.grossReturn!).toBeCloseTo(0.1, 9);
    expect(r.netReturn!).toBeCloseTo(0.1 - 0.0012, 9); // 12 bps
  });

  it("[WEIGHTED] trend basket uses side-specific symbols and weighted contributions", () => {
    const b = buildTrendCrossSectionalBasket(
      scored([
        ["FETUSDT", 0.30, 100], // toxic long should be blocked
        ["SOLUSDT", 0.20, 100],
        ["ETHUSDT", 0.15, 100],
        ["AVAXUSDT", -0.40, 100], // toxic short should be blocked
        ["WLDUSDT", -0.30, 100],
        ["DOGEUSDT", -0.20, 100],
      ]),
      {
        k: 2,
        now: T0,
        openedAtMs: T0ms,
        horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        minScoreGap: 0.01,
        longCapitalWeight: 0.25,
        shortCapitalWeight: 0.75,
        weightingModel: "EQUAL_NOTIONAL",
      },
    )!;
    expect(b.signal).toBe(CROSS_SECTIONAL_TREND_SIGNAL);
    expect(b.longLeg.map((l) => l.symbol)).toEqual(["SOLUSDT", "ETHUSDT"]);
    expect(b.shortLeg.map((l) => l.symbol)).toEqual(["WLDUSDT", "DOGEUSDT"]);
    const r = resolveCrossSectional(b, { SOLUSDT: 110, ETHUSDT: 110, WLDUSDT: 90, DOGEUSDT: 90 }, new Date(T0ms + CROSS_SECTIONAL_HORIZON_MS + 1).toISOString(), 0);
    // Long side contributes 25% * +10%; short side contributes 75% * +10%.
    expect(r.grossReturn!).toBeCloseTo(0.1, 9);
  });

  it("[MIXED-MR] mixed variant fades extremes instead of following momentum", () => {
    const b = buildMixedCrossSectionalBasket(
      scored([
        ["SOLUSDT", -0.20, 100],
        ["ETHUSDT", -0.10, 100],
        ["WLDUSDT", 0.30, 100],
        ["DOGEUSDT", 0.20, 100],
      ]),
      {
        k: 2,
        now: T0,
        openedAtMs: T0ms,
        horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        minScoreGap: 0.01,
      },
    )!;
    expect(b.signal).toBe(CROSS_SECTIONAL_MIXED_SIGNAL);
    expect(b.strategyFamily).toBe("MEAN_REVERSION");
    expect(b.longLeg.map((l) => l.symbol)).toEqual(["SOLUSDT", "ETHUSDT"]);
    expect(b.shortLeg.map((l) => l.symbol)).toEqual(["WLDUSDT", "DOGEUSDT"]);
  });

  it("[EARLY-EXIT] adaptive basket closes on basket-level TP/SL before horizon", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 100], ["B", -0.4, 100]]),
      { k: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS, takeProfitReturn: 0.01, stopLossReturn: 0.01 },
    )!;
    const tp = resolveCrossSectional(b, { A: 105, B: 95 }, new Date(T0ms + 60_000).toISOString(), 0);
    expect(tp.status).toBe("CLOSED");
    expect(tp.exitReason).toBe("TAKE_PROFIT");

    const b2 = buildCrossSectionalBasket(
      scored([["A", 0.5, 100], ["B", -0.4, 100]]),
      { k: 1, signal: "MOM2", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS, takeProfitReturn: 0.01, stopLossReturn: 0.01 },
    )!;
    const sl = resolveCrossSectional(b2, { A: 95, B: 105 }, new Date(T0ms + 60_000).toISOString(), 0);
    expect(sl.status).toBe("CLOSED");
    expect(sl.exitReason).toBe("STOP_LOSS");
  });

  it("[REGIME-TAG] stores regime context and cuts adaptive basket on regime flip", () => {
    const openRegime = buildCrossSectionalRegimeContext({ currentRegime: "Bearish pressure", controllerMode: "SHORT_ONLY", directionalBias: "SHORT", confidence: "MEDIUM" });
    const nextRegime = buildCrossSectionalRegimeContext({ currentRegime: "Choppy rotation", controllerMode: "VALIDATION_ONLY", directionalBias: "MIXED", confidence: "LOW" });
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 100], ["B", -0.4, 100]]),
      { k: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS, regimeContext: openRegime, regimeFlipExit: true },
    )!;
    expect(b.regimeClassAtOpen).toBe("TREND_SHORT");
    const r = resolveCrossSectional(b, { A: 100.1, B: 99.9 }, new Date(T0ms + 60_000).toISOString(), 0, { regimeContext: nextRegime });
    expect(r.status).toBe("CLOSED");
    expect(r.exitReason).toBe("REGIME_FLIP");
  });

  it("[EXPIRE] a basket whose prices stay missing past EXPIRY is EXPIRED, not stuck OPEN", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 100], ["B", -0.4, 100]]),
      { k: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: 1000 },
    )!;
    const farFuture = new Date(T0ms + CROSS_SECTIONAL_HORIZON_MS * 10).toISOString();
    const r = resolveCrossSectional(b, { A: 110 }, farFuture, 0); // B missing
    expect(r.status).toBe("EXPIRED");
  });

  it("[CYCLE] opens one basket per bucket and resolves matured ones", async () => {
    const store = freshStore();
    const universe = ["A", "B", "C", "D", "E", "F"]; // need >= 2*K (default K=3)
    const ramp = (slope: number) => candles(Array.from({ length: 30 }, (_, i) => 100 + i * slope));
    const data: Record<string, Candle[]> = {
      A: ramp(1.0), B: ramp(0.8), C: ramp(0.4), D: ramp(-0.4), E: ramp(-0.8), F: ramp(-1.0),
    };
    const r1 = await runCrossSectionalCycle({ store, universe, now: T0ms, fetchCandles: async (s) => data[s]! });
    expect(r1.opened).toBe(1);
    const obs = store.all[0]!;
    expect(obs.longLeg.length + obs.shortLeg.length).toBeGreaterThan(0);
    expect(obs.status).toBe("OPEN");

    // same bucket → no second basket
    const r2 = await runCrossSectionalCycle({ store, universe, now: T0ms + 60_000, fetchCandles: async (s) => data[s]! });
    expect(r2.opened).toBe(0);

    // far past horizon → resolve
    const later = T0ms + CROSS_SECTIONAL_HORIZON_MS + BAR_FUDGE;
    const r3 = await runCrossSectionalCycle({ store, universe, now: later, fetchCandles: async (s) => data[s]! });
    expect(store.all.some((o) => o.status === "CLOSED")).toBe(true);
    expect(r3.resolved).toBeGreaterThanOrEqual(1);
  });

  it("[REPORT] aggregates net/gross/WR over closed baskets", () => {
    const store = freshStore();
    const close = (net: number, signal = "MOM", variant: "RAW" | "FILTERED" = "RAW"): CrossSectionalObservation => ({
      observationId: `xsec:MOM:${Math.round(net * 1e6)}`, openedAt: T0, openedAtMs: T0ms, horizonMs: 1000,
      signal, variant, k: 1, longLeg: [], shortLeg: [], status: "CLOSED",
      grossReturn: net + 0.001, costReturn: 0.001, netReturn: net, longLegReturn: 0.05, shortLegReturn: 0.05, resolvedAt: T0,
    });
    store.add(close(0.02));
    store.add(close(-0.01));
    store.add(close(0.03));
    store.add(close(0.50, CROSS_SECTIONAL_FILTERED_SIGNAL, "FILTERED"));
    const rep = buildCrossSectionalReport(store);
    expect(rep.closed).toBe(3);
    expect(rep.winRate).toBeCloseTo(2 / 3, 6);
    expect(rep.totalNetReturn).toBeCloseTo(0.04, 9);
    expect(rep.netAvgReturn).toBeCloseTo(0.04 / 3, 9);
    const filtered = buildCrossSectionalReport(store, T0ms, { variant: "FILTERED" });
    expect(filtered.closed).toBe(1);
    expect(filtered.netAvgReturn).toBeCloseTo(0.5, 9);
  });
});

describe("regimeSkewedK — regime-conditioned basket composition (2026-07-08)", () => {
  it("stays symmetric when the score is null/missing", () => {
    expect(regimeSkewedK(3, null)).toEqual({ longK: 3, shortK: 3 });
  });

  it("stays symmetric inside the neutral zone (|score| <= boundary)", () => {
    expect(regimeSkewedK(3, 0.05)).toEqual({ longK: 3, shortK: 3 });
    expect(regimeSkewedK(3, -0.05)).toEqual({ longK: 3, shortK: 3 });
    expect(regimeSkewedK(3, 0.12)).toEqual({ longK: 3, shortK: 3 }); // boundary itself must be CROSSED
    expect(regimeSkewedK(3, -0.12)).toEqual({ longK: 3, shortK: 3 });
  });

  it("favors longs once the score crosses the bull boundary", () => {
    expect(regimeSkewedK(3, 0.13)).toEqual({ longK: 4, shortK: 2 });
  });

  it("favors shorts once the score crosses the bear boundary", () => {
    expect(regimeSkewedK(3, -0.13)).toEqual({ longK: 2, shortK: 4 });
  });

  it("never drops the disfavored side to 0, even with a large delta", () => {
    expect(regimeSkewedK(1, 0.5, { delta: 5 })).toEqual({ longK: 1, shortK: 1 }); // baseK=1 has no room to skew
    expect(regimeSkewedK(2, -0.5, { delta: 5 })).toEqual({ longK: 1, shortK: 3 }); // capped at baseK-1=1
  });

  it("respects custom zoneBoundary and delta overrides", () => {
    expect(regimeSkewedK(3, 0.2, { zoneBoundary: 0.3 })).toEqual({ longK: 3, shortK: 3 }); // wider neutral zone
    expect(regimeSkewedK(3, 0.13, { delta: 2 })).toEqual({ longK: 5, shortK: 1 });
  });
});

describe("regimeSkewCounterfactual — is the skew tilt paying? (2026-07-12 profitability Stage 3)", () => {
  const leg = (side: "LONG" | "SHORT", entryPrice: number, exitPrice: number | null) => ({ side, entryPrice, exitPrice });
  it("returns INSUFFICIENT_DATA below the sample floor", () => {
    const r = regimeSkewCounterfactual([
      { netPnlUsd: 1, legs: [leg("LONG", 100, 102), leg("LONG", 50, 51), leg("SHORT", 10, 9.9)] },
    ]);
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.skewedCount).toBe(1);
  });

  it("partitions skewed (long≠short) vs symmetric baskets and reports each cohort's mean net", () => {
    const skewed = { netPnlUsd: 2, legs: [leg("LONG", 100, 102), leg("LONG", 100, 101), leg("SHORT", 100, 99)] };
    const symmetric = { netPnlUsd: -1, legs: [leg("LONG", 100, 100), leg("SHORT", 100, 100)] };
    const r = regimeSkewCounterfactual([skewed, symmetric]);
    expect(r.skewedCount).toBe(1);
    expect(r.symmetricCount).toBe(1);
    expect(r.skewedMeanNetUsd).toBeCloseTo(2, 9);
    expect(r.symmetricMeanNetUsd).toBeCloseTo(-1, 9);
  });

  it("verdicts SKEW_COSTING when the over-weighted long side under-returns the short side", () => {
    // 5 skewed baskets, longs flat (0%), shorts +2% each — the dispersion is on the short side, so
    // over-weighting longs (the bull skew) is adding directional risk the book isn't rewarded for.
    const baskets = Array.from({ length: 5 }, () => ({
      netPnlUsd: 0.5,
      legs: [leg("LONG", 100, 100), leg("LONG", 100, 100), leg("SHORT", 100, 98)],
    }));
    const r = regimeSkewCounterfactual(baskets);
    expect(r.skewedLongLegMeanReturnPct).toBeCloseTo(0, 9);
    expect(r.skewedShortLegMeanReturnPct).toBeCloseTo(0.02, 9);
    expect(r.skewLongMinusShortEdgePct).toBeCloseTo(-0.02, 9);
    expect(r.verdict).toBe("SKEW_COSTING");
  });

  it("verdicts SKEW_PAYING when the over-weighted long side out-returns the short side", () => {
    const baskets = Array.from({ length: 5 }, () => ({
      netPnlUsd: 1,
      legs: [leg("LONG", 100, 103), leg("LONG", 100, 103), leg("SHORT", 100, 100)],
    }));
    const r = regimeSkewCounterfactual(baskets);
    expect(r.skewLongMinusShortEdgePct!).toBeGreaterThan(0);
    expect(r.verdict).toBe("SKEW_PAYING");
  });
});

describe("[SKEW] buildCrossSectionalBasket with asymmetric longK/shortK", () => {
  it("selects the actual per-side counts, not just a single shared k", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.9, 10], ["B", 0.7, 20], ["C", 0.5, 30], ["D", -0.1, 40], ["E", -0.3, 50]]),
      { k: 3, longK: 4, shortK: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS },
    )!;
    expect(b).not.toBeNull();
    expect(b.longLeg.map((l) => l.symbol)).toEqual(["A", "B", "C", "D"]);
    expect(b.shortLeg.map((l) => l.symbol)).toEqual(["E"]);
    expect(b.longK).toBe(4);
    expect(b.shortK).toBe(1);
  });

  it("falls back to k on both sides when longK/shortK are omitted (unchanged existing behavior)", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 10], ["B", 0.3, 20], ["C", -0.1, 30], ["D", -0.4, 40]]),
      { k: 2, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS },
    )!;
    expect(b.longK).toBe(2);
    expect(b.shortK).toBe(2);
  });

  it("still requires enough names for the SKEWED count on each side", () => {
    const b = buildCrossSectionalBasket(
      scored([["A", 0.5, 10], ["B", 0.3, 20], ["C", -0.1, 30]]),
      { k: 3, longK: 4, shortK: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS },
    );
    expect(b).toBeNull(); // only 2 non-long names left, needs 4 longs total from a 3-symbol universe
  });

  // 2026-07-09 audit: live's FILTERED basket stopped opening for 16h+ under a bearish regime skew
  // (longK=2, shortK=4). Root cause: OP/PEPE were eligible for BOTH sides (shared allow/deny lists),
  // and long — going first — greedily claimed both (they scored highest overall), leaving short
  // only 3 of its required 4 legs. Fixed by letting whichever side needs MORE legs select first.
  it("[OVERLAP-PRIORITY] short (needing more legs under a bearish skew) claims a dual-eligible symbol before long, so it isn't starved", () => {
    const longAllowlist = new Set(["OP", "PEPE", "ETH", "ADA"]);
    const shortAllowlist = new Set(["OP", "PEPE", "X", "Y", "Z"]);
    const b = buildCrossSectionalBasket(
      scored([
        ["OP", 0.09, 1], ["PEPE", 0.05, 2], ["ETH", 0.02, 3], ["ADA", -0.02, 4],
        ["X", -0.05, 5], ["Y", -0.03, 6], ["Z", -0.01, 7],
      ]),
      {
        k: 3, longK: 2, shortK: 4, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        longAllowlist, shortAllowlist,
      },
    );
    expect(b).not.toBeNull();
    expect(b!.shortLeg.map((l) => l.symbol).sort()).toEqual(["PEPE", "X", "Y", "Z"]);
    expect(b!.longLeg.map((l) => l.symbol).sort()).toEqual(["ETH", "OP"]);
  });

  it("[OVERLAP-PRIORITY] ties (longK === shortK, the common unskewed case) keep the original long-first order", () => {
    const longAllowlist = new Set(["OP", "PEPE"]);
    const shortAllowlist = new Set(["OP", "PEPE", "X"]);
    const b = buildCrossSectionalBasket(
      scored([["OP", 0.09, 1], ["PEPE", 0.05, 2], ["X", -0.05, 3]]),
      {
        k: 1, longK: 1, shortK: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        longAllowlist, shortAllowlist,
      },
    );
    expect(b).not.toBeNull();
    // Long still picks first (OP, the top scorer) — short falls back to its next-best eligible (X).
    expect(b!.longLeg.map((l) => l.symbol)).toEqual(["OP"]);
    expect(b!.shortLeg.map((l) => l.symbol)).toEqual(["X"]);
  });
});

describe("[CLUSTER-CAP] buildCrossSectionalBasket with maxPerCluster (2026-07-08)", () => {
  // Real default-map clusters: SOLUSDT/AVAXUSDT/SUIUSDT/NEARUSDT = L1, ARBUSDT/OPUSDT = L2_DEFI,
  // BTCUSDT/ETHUSDT = MAJORS (exempt from the cap).
  it("skips a same-cluster candidate past the cap, picking the next-best DIFFERENT cluster instead", () => {
    const b = buildCrossSectionalBasket(
      scored([
        ["SOLUSDT", 0.9, 10], ["AVAXUSDT", 0.8, 20], ["SUIUSDT", 0.7, 30], // 3x L1, best-scored
        ["ARBUSDT", 0.6, 40], // L2_DEFI, next-best after the L1 cap trips
        ["DOGEUSDT", -0.5, 50], ["WLDUSDT", -0.6, 60], ["FETUSDT", -0.7, 70], // short-side supply
      ]),
      { k: 3, maxPerCluster: 2, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS },
    )!;
    expect(b).not.toBeNull();
    // SOL + AVAX fill the L1 cap (2); SUI (3rd L1) is skipped; ARB (L2_DEFI) fills the 3rd slot.
    expect(b.longLeg.map((l) => l.symbol)).toEqual(["SOLUSDT", "AVAXUSDT", "ARBUSDT"]);
  });

  it("exempts MAJORS (BTC/ETH) from the cluster cap", () => {
    const b = buildCrossSectionalBasket(
      scored([["BTCUSDT", 0.9, 10], ["ETHUSDT", 0.8, 20], ["SOLUSDT", 0.1, 30], ["ARBUSDT", -0.1, 40]]),
      { k: 2, maxPerCluster: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS },
    )!;
    expect(b.longLeg.map((l) => l.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]); // both MAJORS, cap=1 would otherwise block the 2nd
  });

  it("disabled (maxPerCluster unset/0) behaves exactly like the pre-existing top-k sort", () => {
    const b = buildCrossSectionalBasket(
      scored([["SOLUSDT", 0.9, 10], ["AVAXUSDT", 0.8, 20], ["SUIUSDT", 0.7, 30]]),
      { k: 3, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS },
    );
    expect(b).toBeNull(); // needs 2*k=6 names total; unaffected by the cluster cap either way
  });
});

const BAR_FUDGE = 60 * 60_000 + 1000; // one 1h bar + a little, to push past the horizon

describe("deriveAdaptiveSymbolFilters — demotes toxic symbols inside hard operator lists", () => {

  function closedObs(id: string, longLegs: Array<[string, number, number]>, shortLegs: Array<[string, number, number]>) {
    return {
      observationId: id,
      openedAt: T0,
      openedAtMs: T0ms,
      horizonMs: 3_600_000,
      signal: "MOM24",
      variant: "RAW" as const,
      k: longLegs.length,
      longLeg: longLegs.map(([symbol, entryPrice, exitPrice]) => ({ symbol, entryPrice, exitPrice })),
      shortLeg: shortLegs.map(([symbol, entryPrice, exitPrice]) => ({ symbol, entryPrice, exitPrice })),
      status: "CLOSED" as const,
      grossReturn: 0, costReturn: 0, netReturn: 0, longLegReturn: 0, shortLegReturn: 0,
      resolvedAt: T0,
    };
  }

  it("keeps allowlists inside operator filters while demoting measured losers", () => {
    const store = freshStore();
    // SOL long leg: 3 wins (+2% each) → remains allowed.
    // FETUSDT long: 3 losses (-2%) → demoted long (blocked) even though not in env lists.
    // NEARUSDT short: 3 wins (price fell) → provenance records it as positive, but hard block stays.
    // DOGEUSDT short: 3 losses (price rose) → demoted from env short allowlist + blocklisted.
    for (let i = 0; i < 3; i++) {
      store.add(closedObs(`a${i}`, [["SOLUSDT", 100, 102], ["FETUSDT", 1, 0.98]], [["NEARUSDT", 2, 1.9], ["DOGEUSDT", 0.07, 0.075]]) as never);
    }
    const f = deriveAdaptiveSymbolFilters(store);
    expect(f.longAllowlist).toContain("SOLUSDT");
    expect(f.longAllowlist).not.toContain("FETUSDT");
    expect(f.longBlocklist).toContain("FETUSDT");
    expect(f.shortAllowlist).not.toContain("NEARUSDT"); // hard operator block stays blocked
    expect(f.shortBlocklist).toContain("NEARUSDT");
    expect(f.shortAllowlist).not.toContain("DOGEUSDT");
    expect(f.shortBlocklist).toContain("DOGEUSDT");
    expect(f.provenance.closedBaskets).toBe(3);
    expect(f.provenance.promotedShort).toContain("NEARUSDT");
    expect(f.provenance.demotedShort).toContain("DOGEUSDT");
  });

  it("below the min sample size, the env lists pass through unchanged", () => {
    const store = freshStore();
    store.add(closedObs("one", [["SOLUSDT", 100, 90]], [["DOGEUSDT", 0.07, 0.08]]) as never); // 1 bad sample each
    const f = deriveAdaptiveSymbolFilters(store);
    // n=1 < 3 ⇒ no demotion: env allowlists intact.
    expect(f.longAllowlist).toContain("SOLUSDT");
    expect(f.shortAllowlist).toContain("DOGEUSDT");
    expect(f.longBlocklist).toEqual([]);
  });

  // [FLOOR] 2026-07-07 audit: demotion has no recovery path (a demoted symbol only regains
  // eligibility via a NEW closed basket remeasuring it, but no new baskets form once a side
  // drops below k legs) — a PERMANENT lockout, not a temporary one. This silently stopped ALL
  // SHORT-side baskets on live for ~18h once every configured short symbol got demoted.
  it("[FLOOR] falls back to the full allowlist when demotions would starve a side below minEligiblePerSide", () => {
    const store = freshStore();
    // Demote EVERY default SHORT-allowlist symbol (read from the real constant, not a hardcoded
    // snapshot — 2026-07-09 audit widened this list, and a stale hardcoded subset here would leave
    // un-demoted symbols surviving, silently un-triggering the floor this test exists to prove).
    const shortSymbols = [...CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST];
    for (let i = 0; i < 3; i++) {
      store.add(
        closedObs(
          `s${i}`,
          [["SOLUSDT", 100, 102]], // long side stays healthy (1 winner, not enough to demote/matter)
          shortSymbols.map((sym): [string, number, number] => [sym, 1, 1.02]), // price rose ⇒ short loses
        ) as never,
      );
    }
    const f = deriveAdaptiveSymbolFilters(store, { minEligiblePerSide: 3 });
    expect(f.provenance.demotedShort.sort()).toEqual(shortSymbols.sort());
    // Floor kicked in: falls back to the FULL configured short allowlist, not the (empty) demoted one.
    expect(f.provenance.shortFloorApplied).toBe(true);
    expect(f.shortAllowlist.sort()).toEqual(shortSymbols.sort());
    // The floor also resets this side's blocklist — a floored symbol must not still be blocked,
    // or the floor would be a no-op (allowlist says yes, blocklist says no).
    for (const sym of shortSymbols) expect(f.shortBlocklist).not.toContain(sym);
    // Long side wasn't starved — no floor, ordinary demotion behavior unaffected.
    expect(f.provenance.longFloorApplied).toBe(false);
    expect(f.provenance.minEligiblePerSide).toBe(3);
  });

  it("[FLOOR] does not trigger when enough symbols survive demotion", () => {
    const store = freshStore();
    // Demote only ONE of the default short symbols — plenty remain, still >= k=3, no floor needed.
    for (let i = 0; i < 3; i++) {
      store.add(closedObs(`o${i}`, [], [["DOGEUSDT", 1, 1.02]]) as never);
    }
    const f = deriveAdaptiveSymbolFilters(store, { minEligiblePerSide: 3 });
    expect(f.provenance.shortFloorApplied).toBe(false);
    expect(f.shortAllowlist).not.toContain("DOGEUSDT");
    expect(f.shortAllowlist).toContain("OPUSDT"); // untouched, still eligible
  });

  // [SKEW-FLOOR] 2026-07-11: regime skew can raise shortK above the base K (e.g. 3->4 via
  // regimeSkewedK), but the floor previously only ever checked the unskewed shared
  // minEligiblePerSide on both sides — a short side sitting at exactly the base K eligible symbols
  // looked "fine" (not under the base K) even though buildFilteredCrossSectionalBasket actually
  // needs the SKEWED count and would silently return null. Fixed by threading separate per-side
  // floors through; this proves the shared value alone misses it while the per-side override catches it.
  it("[SKEW-FLOOR] per-side floor override catches a regime-skewed shortK requirement the shared minEligiblePerSide would miss", () => {
    const store = freshStore();
    // Demote only ONE short symbol — plenty remain relative to the unskewed base K, same setup as
    // the "does not trigger" test above.
    for (let i = 0; i < 3; i++) {
      store.add(closedObs(`p${i}`, [], [["DOGEUSDT", 1, 1.02]]) as never);
    }
    const remaining = CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST.size - 1; // one demoted out of the full list

    // Old behavior (shared value only, matching the unskewed base K): floor correctly stays off —
    // this is the "no regime skew" case and must remain unaffected.
    const unskewed = deriveAdaptiveSymbolFilters(store, { minEligiblePerSide: 3 });
    expect(unskewed.provenance.shortFloorApplied).toBe(false);

    // Regime skew raises the ACTUAL short requirement one past what remains eligible — the
    // per-side override must catch this even though the shared/base value alone would not.
    const skewed = deriveAdaptiveSymbolFilters(store, {
      minEligiblePerSide: 3,
      minEligiblePerSideShort: remaining + 1,
    });
    expect(skewed.provenance.shortFloorApplied).toBe(true);
    expect(skewed.provenance.minEligiblePerSideShort).toBe(remaining + 1);
    // Long side is unaffected by the short-side override.
    expect(skewed.provenance.longFloorApplied).toBe(false);
    expect(skewed.provenance.minEligiblePerSideLong).toBe(3);
  });

  // [SYMBOL-NAME] 2026-07-07: "PEPEUSDT" is not a real Binance futures symbol (the exchange lists
  // it as "1000PEPEUSDT", a 1000x-multiplier contract — confirmed against the real exchangeInfo
  // and klines endpoints on both mainnet and testnet, both reject plain "PEPEUSDT" as invalid).
  // A basket containing the wrong name as a leg silently failed to size at getExchangeFilters()
  // in the executor, with no error surfaced. Guard against this exact typo recurring in any of
  // the default allow/blocklists.
  it("[SYMBOL-NAME] no default allowlist references the invalid bare 'PEPEUSDT' symbol", () => {
    const lists = [
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST,
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST,
      CROSS_SECTIONAL_TREND_LONG_ALLOWLIST,
      CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST,
    ];
    for (const list of lists) {
      expect(list.has("PEPEUSDT")).toBe(false);
    }
    // The correctly-named contract should still be reachable where the old lists referenced it.
    expect(CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST.has("1000PEPEUSDT")).toBe(true);
    expect(CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST.has("1000PEPEUSDT")).toBe(true);
  });
});

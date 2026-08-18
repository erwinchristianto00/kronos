import { describe, it, expect, vi } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  deriveAdaptiveSymbolFilters,
  getCrossSectionalFilteredExecutionFilters,
  crossSectionalMomentumScore,
  buildCrossSectionalBasket,
  buildFilteredCrossSectionalBasket,
  buildTrendCrossSectionalBasket,
  buildMixedCrossSectionalBasket,
  resolveCrossSectional,
  buildCrossSectionalReport,
  getCrossSectionalReportSinceMs,
  runCrossSectionalCycle,
  CrossSectionalStore,
  CROSS_SECTIONAL_HORIZON_MS,
  CROSS_SECTIONAL_FILTERED_SIGNAL,
  CROSS_SECTIONAL_TREND_SIGNAL,
  CROSS_SECTIONAL_MIXED_SIGNAL,
  buildCrossSectionalRegimeContext,
  CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST,
  CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST,
  CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST,
  CROSS_SECTIONAL_TREND_LONG_ALLOWLIST,
  CROSS_SECTIONAL_TREND_LONG_BLOCKLIST,
  CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST,
  CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST,
  CROSS_SECTIONAL_UNIVERSE,
  CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP,
  crossSectionalMixedLongAllowlist,
  crossSectionalMixedShortBlocklist,
  isCrossSectionalMixedWideLongPoolEnabled,
  getCrossSectionalAdaptiveConfig,
  regimeSkewedK,
  regimeSkewCounterfactual,
  liquidCrossSectionalSymbols,
  narrowAllowlistToLiquid,
  CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR,
  CROSS_SECTIONAL_LIQUIDITY_LOOKBACK_BARS,
  crossSectionalLiquidityStarved,
  isCrossSectionalAdaptiveDemotionFrozen,
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

  it("[FILTERED-SIZING] keeps 50/50 sides while capping inverse-vol legs near equal size", () => {
    const b = buildFilteredCrossSectionalBasket(
      scored([["SOLUSDT", 0.2, 100], ["ETHUSDT", 0.1, 100], ["WLDUSDT", -0.1, 100], ["DOGEUSDT", -0.2, 100]]),
      {
        k: 2, now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS, minScoreGap: 0.01,
        longAllowlist: new Set(["SOLUSDT", "ETHUSDT"]), shortAllowlist: new Set(["WLDUSDT", "DOGEUSDT"]),
        volBySymbol: { SOLUSDT: 0.01, ETHUSDT: 0.20, WLDUSDT: 0.02, DOGEUSDT: 0.30 },
      },
    )!;
    expect(b.weightingModel).toBe("CAPPED_INVERSE_VOL");
    expect(b.longLeg.reduce((sum, leg) => sum + (leg.weight ?? 0), 0)).toBeCloseTo(0.5, 9);
    expect(b.shortLeg.reduce((sum, leg) => sum + (leg.weight ?? 0), 0)).toBeCloseTo(0.5, 9);
    expect(Math.max(...b.longLeg.map((leg) => leg.weight ?? 0))).toBeLessThanOrEqual(0.3125 + 1e-9);
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
    store.add({ ...close(0.04), observationId: "xsec:new-era", openedAt: new Date(T0ms + 1).toISOString(), openedAtMs: T0ms + 1 });
    const freshEra = buildCrossSectionalReport(store, T0ms + 2, { variant: "RAW", sinceMs: T0ms + 1 });
    expect(freshEra.closed).toBe(1);
    expect(freshEra.totalNetReturn).toBeCloseTo(0.04, 9);
  });

  it("[REPORT CUTOFF] parses the shared evidence-era cutoff", () => {
    expect(getCrossSectionalReportSinceMs({ CROSS_SECTIONAL_REPORT_START_AT: "2026-08-12T00:00:00.000Z" })).toBe(
      Date.parse("2026-08-12T00:00:00.000Z"),
    );
    expect(getCrossSectionalReportSinceMs({ CROSS_SECTIONAL_REPORT_START_AT: "not-a-date" })).toBeUndefined();
    expect(getCrossSectionalReportSinceMs({})).toBeUndefined();
  });
});

// ── CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL (2026-07-26) ────────────────────────────────────────
// MIXED borrows TREND's 4-symbol long allowlist. Under MEAN_REVERSION that pool has no room to
// move (3 weakest of 4 ≈ the pool mean) while the short side picks the 3 strongest of 6, so the
// score gap collapses and the lane stopped forming baskets. The flag widens ONLY the MIXED long
// pool, to the instance's own FILTERED long allowlist. Default = today's behavior, bit for bit.
//
// Runs the flag through process.env (not an injected env) on purpose: the point of these tests is
// that buildMixedCrossSectionalBasket's DEFAULT path consults the flag, which is exactly the path
// a deployed instance takes. Always restored in `finally` so nothing leaks to a later test.
function withMixedWideLongPool<T>(value: string | undefined, fn: () => T): T {
  const KEY = "CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL";
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
}

/** Symbols on the FILTERED long allowlist that are NOT on TREND's — i.e. exactly what widening adds. */
const WIDENING_ADDS = [...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST].filter(
  (s) => !CROSS_SECTIONAL_TREND_LONG_ALLOWLIST.has(s),
);

const BASKET_BASE = { k: 3, now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS } as const;

describe("[MIXED-POOL] CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL — widening the dead MIXED long pool", () => {
  it("the fixture is only meaningful if the source defaults still make FILTERED wider than TREND", () => {
    // Guards the whole block: if someone renarrows the FILTERED list to a subset of TREND's, the
    // tests below would pass vacuously instead of failing loudly.
    expect(CROSS_SECTIONAL_TREND_LONG_ALLOWLIST.size).toBe(4);
    expect(WIDENING_ADDS.sort()).toEqual(["ADAUSDT", "BNBUSDT", "SUIUSDT"]);
  });

  it("[RESOLVER] default resolves to TREND's narrow long pool; only an exact \"1\" widens it", () => {
    const trend = [...CROSS_SECTIONAL_TREND_LONG_ALLOWLIST].sort();
    const filtered = [...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST].sort();
    const at = (env: NodeJS.ProcessEnv) => [...crossSectionalMixedLongAllowlist(env)].sort();
    expect(at({} as NodeJS.ProcessEnv)).toEqual(trend); // unset — today's behavior
    expect(at({ CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL: "0" } as NodeJS.ProcessEnv)).toEqual(trend);
    expect(at({ CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL: "" } as NodeJS.ProcessEnv)).toEqual(trend);
    expect(at({ CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL: "true" } as NodeJS.ProcessEnv)).toEqual(trend);
    expect(at({ CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL: "1" } as NodeJS.ProcessEnv)).toEqual(filtered);
    expect(isCrossSectionalMixedWideLongPoolEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCrossSectionalMixedWideLongPoolEnabled({ CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  // The measured root cause, reproduced at basket level: identical scores, identical 0.035
  // threshold — the ONLY difference is the size of the long pool. Narrow => scoreGap 0.020 => no
  // basket (the dead lane). Wide => scoreGap 0.262 => basket. Fails without the flag wiring.
  const deadLaneScores = scored([
    // TREND long pool: tightly clustered, so picking 3 of 4 barely moves the long mean.
    ["SOLUSDT", 0.050, 100], ["ETHUSDT", 0.052, 100], ["OPUSDT", 0.054, 100], ["1000PEPEUSDT", 0.056, 100],
    // Only reachable once the long pool is widened.
    ["ADAUSDT", -0.200, 100], ["BNBUSDT", -0.190, 100], ["SUIUSDT", -0.180, 100],
    // Short pool (TREND short allowlist) — unchanged by this flag.
    ["WLDUSDT", 0.070, 100], ["SEIUSDT", 0.072, 100], ["DOGEUSDT", 0.074, 100], ["APTUSDT", 0.060, 100],
  ]);

  it("[DEFAULT] with the flag unset the narrow pool cannot clear 0.035 — today's dead lane, unchanged", () => {
    const b = withMixedWideLongPool(undefined, () => buildMixedCrossSectionalBasket(deadLaneScores, { ...BASKET_BASE }));
    expect(b).toBeNull();
    // And prove WHY it is null: it is the pool, not the threshold. Same scores, same 0.035, but a
    // long pool handed in explicitly as the wide one => a basket forms.
    const forced = buildMixedCrossSectionalBasket(deadLaneScores, {
      ...BASKET_BASE,
      longAllowlist: CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST,
    });
    expect(forced).not.toBeNull();
    expect(forced!.scoreGap!).toBeGreaterThan(CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP);
  });

  it("[FLAG] with the flag set the widened pool forms the basket the lane has been missing", () => {
    const b = withMixedWideLongPool("1", () => buildMixedCrossSectionalBasket(deadLaneScores, { ...BASKET_BASE }));
    expect(b).not.toBeNull();
    expect(b!.signal).toBe(CROSS_SECTIONAL_MIXED_SIGNAL);
    expect(b!.strategyFamily).toBe("MEAN_REVERSION");
    // Mean reversion longs the weakest — now reachable outside TREND's 4.
    expect(b!.longLeg.map((l) => l.symbol)).toEqual(["ADAUSDT", "BNBUSDT", "SUIUSDT"]);
    expect(b!.shortLeg.map((l) => l.symbol)).toEqual(["DOGEUSDT", "SEIUSDT", "WLDUSDT"]);
    expect(b!.scoreGap!).toBeCloseTo(0.262, 9);
  });

  // Same universe, but shorts stretched far enough that BOTH pools clear the threshold — isolates
  // the composition change from the "did a basket form at all" question.
  const bothFormScores = scored([
    ["SOLUSDT", 0.050, 100], ["ETHUSDT", 0.052, 100], ["OPUSDT", 0.054, 100], ["1000PEPEUSDT", 0.056, 100],
    ["ADAUSDT", -0.200, 100], ["BNBUSDT", -0.190, 100], ["SUIUSDT", -0.180, 100],
    ["WLDUSDT", 0.300, 100], ["SEIUSDT", 0.320, 100], ["DOGEUSDT", 0.340, 100], ["APTUSDT", 0.060, 100],
  ]);

  it("[DEFAULT] flag unset keeps the EXACT legs MIXED picks today (never reaches the wider names)", () => {
    const b = withMixedWideLongPool(undefined, () => buildMixedCrossSectionalBasket(bothFormScores, { ...BASKET_BASE }))!;
    expect(b).not.toBeNull();
    expect(b.longLeg.map((l) => l.symbol)).toEqual(["SOLUSDT", "ETHUSDT", "OPUSDT"]);
    for (const s of WIDENING_ADDS) expect(b.longLeg.map((l) => l.symbol)).not.toContain(s);
  });

  it("[RISK-PARAMS] the flag moves pools only — capital split, TP and SL are identical", () => {
    const narrow = withMixedWideLongPool(undefined, () => buildMixedCrossSectionalBasket(bothFormScores, { ...BASKET_BASE }))!;
    const wide = withMixedWideLongPool("1", () => buildMixedCrossSectionalBasket(bothFormScores, { ...BASKET_BASE }))!;
    expect(wide.longLeg.map((l) => l.symbol)).toEqual(["ADAUSDT", "BNBUSDT", "SUIUSDT"]); // long side did change
    expect(wide.shortCapitalWeight).toBe(narrow.shortCapitalWeight);
    expect(wide.longCapitalWeight).toBe(narrow.longCapitalWeight);
    expect(wide.takeProfitReturn).toBe(narrow.takeProfitReturn);
    expect(wide.stopLossReturn).toBe(narrow.stopLossReturn);
    expect(wide.riskDistanceAtOpen).toBe(narrow.riskDistanceAtOpen);
    expect(wide.weightingModel).toBe(narrow.weightingModel);
  });

  // ── The short side. This is the half an earlier revision described as "untouched"; it is not. ──
  //
  // buildCrossSectionalBasket gives a both-sides-eligible symbol to whichever side selects first
  // (long, in MIXED's unskewed 3/3 case). OPUSDT and 1000PEPEUSDT are on BOTH TREND allowlists, so
  // widening the long pool alone makes the long leg stop claiming them on many bars and they fall
  // THROUGH into the short leg — an unconfigured, rank-dependent short-side change. The shipped
  // design blocks the widened long pool's symbols from MIXED's short side instead, which is a
  // SMALLER-pool short-side change (6 candidates → 4) and a LARGER short-leg delta, but a fully
  // enumerable one, after which the long side cannot influence the short leg at all.
  it("[SHORT-POOL] the fixture is only meaningful while OPUSDT/1000PEPEUSDT are on BOTH TREND lists", () => {
    const overlap = [...CROSS_SECTIONAL_TREND_LONG_ALLOWLIST].filter((s) => CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST.has(s));
    expect(overlap.sort()).toEqual(["1000PEPEUSDT", "OPUSDT"]);
  });

  it("[SHORT-POOL] flag off = today's short blocklist byte for byte; flag on adds the long-eligible pool", () => {
    const off = withMixedWideLongPool(undefined, () => crossSectionalMixedShortBlocklist());
    expect(off).toBe(CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST); // same object — nothing derived, nothing added
    const on = withMixedWideLongPool("1", () => crossSectionalMixedShortBlocklist());
    for (const s of CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST) expect(on.has(s)).toBe(true);
    // Everything the widened long pool can select is blocked from the short side...
    for (const s of CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST) {
      if (!CROSS_SECTIONAL_TREND_LONG_BLOCKLIST.has(s)) expect(on.has(s)).toBe(true);
    }
    // ...and the OPERATIONALLY VISIBLE effect is exactly the two overlap symbols: MIXED's short
    // candidate pool goes 6 → 4. This is the number that must appear in any operator description.
    const shortCandidates = (bl: ReadonlySet<string>) => [...CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST].filter((s) => !bl.has(s)).sort();
    expect(shortCandidates(off)).toEqual(["1000PEPEUSDT", "APTUSDT", "DOGEUSDT", "OPUSDT", "SEIUSDT", "WLDUSDT"]);
    expect(shortCandidates(on)).toEqual(["APTUSDT", "DOGEUSDT", "SEIUSDT", "WLDUSDT"]);
  });

  it("[SHORT-POOL] a long BLOCKLISTed symbol is not needlessly taken off the short side", () => {
    // ARBUSDT is on CROSS_SECTIONAL_TREND_LONG_BLOCKLIST, so it can never reach the long leg and
    // therefore never needs removing from the short side. Keeps the narrowing minimal.
    expect(CROSS_SECTIONAL_TREND_LONG_BLOCKLIST.has("ARBUSDT")).toBe(true);
    const on = withMixedWideLongPool("1", () =>
      crossSectionalMixedShortBlocklist({ longAllowlist: new Set(["ARBUSDT", "SOLUSDT"]) }),
    );
    expect(on.has("SOLUSDT")).toBe(true);
    expect(on.has("ARBUSDT")).toBe(false);
  });

  // The scores that expose the drift: OPUSDT is the STRONGEST of TREND's 4-symbol long pool, so
  // mean-reversion's "long the 3 weakest" drops it — and today it lands on the short leg.
  const driftScores = scored([
    ["SOLUSDT", -0.30, 100], ["ETHUSDT", -0.28, 100], ["1000PEPEUSDT", -0.26, 100], ["OPUSDT", 0.40, 100],
    ["ADAUSDT", -0.50, 100], ["BNBUSDT", -0.48, 100], ["SUIUSDT", -0.46, 100],
    ["WLDUSDT", 0.30, 100], ["SEIUSDT", 0.28, 100], ["DOGEUSDT", 0.26, 100], ["APTUSDT", 0.24, 100],
  ]);

  it("[DRIFT] long widening ALONE pushes OPUSDT across to the short leg — the defect, pinned", () => {
    const off = withMixedWideLongPool(undefined, () => buildMixedCrossSectionalBasket(driftScores, { ...BASKET_BASE }))!;
    expect(off.shortLeg.map((l) => l.symbol)).toEqual(["OPUSDT", "WLDUSDT", "SEIUSDT"]);
    // Reproduce the reviewed draft by pinning the short blocklist back to today's.
    const draft = withMixedWideLongPool("1", () =>
      buildMixedCrossSectionalBasket(driftScores, { ...BASKET_BASE, shortBlocklist: CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST }),
    )!;
    expect(draft.shortLeg.map((l) => l.symbol)).toEqual(["OPUSDT", "WLDUSDT", "SEIUSDT"]);
    // OPUSDT survives on the short leg here only because the long side never wanted it; flip its
    // rank inside the WIDENED long pool and the short leg changes without any short config change.
    const flipped = driftScores.map((s) => (s.symbol === "OPUSDT" ? { ...s, score: -0.60 } : s));
    const draftFlipped = withMixedWideLongPool("1", () =>
      buildMixedCrossSectionalBasket(flipped, { ...BASKET_BASE, shortBlocklist: CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST }),
    )!;
    expect(draftFlipped.longLeg.map((l) => l.symbol)).toContain("OPUSDT");
    expect(draftFlipped.shortLeg.map((l) => l.symbol)).not.toContain("OPUSDT"); // long-side rank moved the short leg
  });

  it("[SHORT-DETERMINISM] under the flag, long-side RANKING can no longer move the short leg", () => {
    // The property this design actually buys, stated precisely. Corrected 2026-07-26: an earlier
    // version of this test swept four different long ALLOWLISTS and demanded one identical short
    // leg. That expectation is impossible by construction and the test failed: the short blocklist
    // is DERIVED from the long allowlist to keep the pools disjoint, so a wider long allowlist
    // necessarily blocks more short candidates (TREND ⇒ 9 blocked, FILTERED ⇒ 12, whole universe
    // ⇒ 24, which swallows WLD/SEI/DOGE and forms no basket at all). Changing the long ALLOWLIST is
    // an operator CONFIG change that legitimately moves both pools, and it is visible in the env.
    // What must never happen again is the EMERGENT drift: the short leg moving because of where the
    // long side's SCORES happened to rank, with no config change at all. So: hold the long pool
    // fixed, vary only the long-side symbols' scores, and require the short leg to sit still.
    const longSide = ["SOLUSDT", "ETHUSDT", "1000PEPEUSDT", "OPUSDT", "ADAUSDT", "BNBUSDT", "SUIUSDT"];
    const rank = (seed: number): ScoredSymbol[] => {
      let s = seed >>> 0;
      const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
      const overrides = new Map(longSide.map((sym) => [sym, next()]));
      return driftScores.map((r) => ({ ...r, score: overrides.get(r.symbol) ?? r.score }));
    };
    const legsOn = new Set<string>();
    const legsOff = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      legsOn.add(
        withMixedWideLongPool("1", () => {
          const b = buildMixedCrossSectionalBasket(rank(seed), { ...BASKET_BASE });
          return b === null ? "NO_BASKET" : b.shortLeg.map((l) => l.symbol).join(",");
        }),
      );
      legsOff.add(
        withMixedWideLongPool(undefined, () => {
          const b = buildMixedCrossSectionalBasket(rank(seed), { ...BASKET_BASE });
          return b === null ? "NO_BASKET" : b.shortLeg.map((l) => l.symbol).join(",");
        }),
      );
    }
    // Flag ON: the short pool is disjoint from the long pool, so no long-side ranking can reach it.
    expect(legsOn.size).toBe(1);
    expect([...legsOn][0]).not.toBe("NO_BASKET");
    // Flag OFF (today): the same sweep DOES move the short leg — the defect this change removes.
    expect(legsOff.size).toBeGreaterThan(1);
  });

  it("[DRIFT] the shipped design substitutes ONE short symbol, and never lets the long side pick it", () => {
    const off = withMixedWideLongPool(undefined, () => buildMixedCrossSectionalBasket(driftScores, { ...BASKET_BASE }))!;
    const on = withMixedWideLongPool("1", () => buildMixedCrossSectionalBasket(driftScores, { ...BASKET_BASE }))!;
    // The short leg DID change — this is the honest claim, not "untouched".
    expect(off.shortLeg.map((l) => l.symbol)).toEqual(["OPUSDT", "WLDUSDT", "SEIUSDT"]);
    expect(on.shortLeg.map((l) => l.symbol)).toEqual(["WLDUSDT", "SEIUSDT", "DOGEUSDT"]);
    // ...by exactly one 1-for-1 substitution: OPUSDT out, the next-ranked short candidate in.
    const left = off.shortLeg.map((l) => l.symbol).filter((s) => !on.shortLeg.some((x) => x.symbol === s));
    const joined = on.shortLeg.map((l) => l.symbol).filter((s) => !off.shortLeg.some((x) => x.symbol === s));
    expect(left).toEqual(["OPUSDT"]);
    expect(joined).toEqual(["DOGEUSDT"]);
    // And the legs are disjoint by construction on both paths.
    for (const l of on.longLeg) expect(on.shortLeg.map((x) => x.symbol)).not.toContain(l.symbol);
  });

  it("[SHORT-POOL] an exhausted short pool fails CLOSED — no basket, never an unfiltered short side", () => {
    // allowed() treats an EMPTY allowlist as "allow everything". If the disjointness had been
    // implemented by subtracting from the short ALLOWLIST, a total overlap would have flipped the
    // short side to the whole universe. Expressed as a blocklist it can only ever starve.
    const totalOverlap = new Set(CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST);
    const b = withMixedWideLongPool("1", () =>
      buildMixedCrossSectionalBasket(driftScores, { ...BASKET_BASE, longAllowlist: totalOverlap }),
    );
    expect(b).toBeNull();
    // Same starvation guard for an instance that approved nothing for FILTERED longs: there is
    // nothing to widen to, so the flag keeps today's narrow pool rather than "allow everything".
    expect(crossSectionalMixedLongAllowlist({ CROSS_SECTIONAL_MIXED_WIDE_LONG_POOL: "1" } as NodeJS.ProcessEnv).size).toBeGreaterThan(0);
  });

  it("[THRESHOLD] the 0.035 gap still binds under the widened pool — widening never lowers the bar", () => {
    expect(CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP).toBe(0.035);
    expect(getCrossSectionalAdaptiveConfig().mixedMinScoreGap).toBe(0.035);
    // Widened pool, but a genuine gap of 0.025 — between the rejected 0.020 proposal and 0.035.
    const marginal = scored([
      ["ADAUSDT", 0.000, 100], ["BNBUSDT", 0.001, 100], ["SUIUSDT", 0.002, 100],
      ["SOLUSDT", 0.050, 100], ["ETHUSDT", 0.050, 100],
      ["OPUSDT", 0.011, 100], ["1000PEPEUSDT", 0.012, 100],
      ["WLDUSDT", 0.025, 100], ["SEIUSDT", 0.026, 100], ["DOGEUSDT", 0.027, 100], ["APTUSDT", 0.010, 100],
    ]);
    expect(withMixedWideLongPool("1", () => buildMixedCrossSectionalBasket(marginal, { ...BASKET_BASE }))).toBeNull();
    // Same input, same widened pool, threshold explicitly dropped to the rejected 0.020 => it WOULD
    // have opened. So the rejection above is the threshold doing its job, not a starved pool.
    const at020 = withMixedWideLongPool("1", () =>
      buildMixedCrossSectionalBasket(marginal, { ...BASKET_BASE, minScoreGap: 0.020 }),
    )!;
    expect(at020).not.toBeNull();
    expect(at020.scoreGap!).toBeCloseTo(0.025, 9);
    expect(at020.scoreGap!).toBeLessThan(CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP);
  });

  it("[TREND-LANE] the TREND lane's long pool is NOT widened by this flag", () => {
    // ADA/BNB/SUI carry the top momentum scores here: if the flag leaked into TREND, they would
    // take the whole long side.
    const trendScores = scored([
      ["ADAUSDT", 0.500, 100], ["BNBUSDT", 0.490, 100], ["SUIUSDT", 0.480, 100],
      ["SOLUSDT", 0.200, 100], ["ETHUSDT", 0.190, 100], ["OPUSDT", 0.180, 100], ["1000PEPEUSDT", 0.170, 100],
      ["WLDUSDT", -0.300, 100], ["SEIUSDT", -0.310, 100], ["DOGEUSDT", -0.320, 100], ["APTUSDT", -0.100, 100],
    ]);
    const build = () => buildTrendCrossSectionalBasket(trendScores, { ...BASKET_BASE })!;
    const off = withMixedWideLongPool(undefined, build);
    const on = withMixedWideLongPool("1", build);
    expect(off.signal).toBe(CROSS_SECTIONAL_TREND_SIGNAL);
    expect(off.longLeg.map((l) => l.symbol)).toEqual(["SOLUSDT", "ETHUSDT", "OPUSDT"]);
    expect(on.longLeg.map((l) => l.symbol)).toEqual(off.longLeg.map((l) => l.symbol));
    expect(on.shortLeg.map((l) => l.symbol)).toEqual(off.shortLeg.map((l) => l.symbol));
    for (const s of WIDENING_ADDS) expect(on.longLeg.map((l) => l.symbol)).not.toContain(s);
  });

  it("[CONFIG] the adaptive config reports BOTH pools MIXED is actually running on", () => {
    const off = withMixedWideLongPool(undefined, () => getCrossSectionalAdaptiveConfig());
    expect(off.mixedWideLongPool).toBe(false);
    expect(off.mixedLongAllowlist).toEqual([...CROSS_SECTIONAL_TREND_LONG_ALLOWLIST].sort());
    expect(off.mixedShortBlocklist).toEqual([...CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST].sort());
    expect(off.mixedShortExcludedForLongOverlap).toEqual([]); // flag off ⇒ nothing removed
    const on = withMixedWideLongPool("1", () => getCrossSectionalAdaptiveConfig());
    expect(on.mixedWideLongPool).toBe(true);
    expect(on.mixedLongAllowlist).toEqual([...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST].sort());
    // The short side is reported as changed, and by exactly which symbols — an operator reading
    // /research must be able to see the short-side narrowing without reading this file.
    expect(on.mixedShortExcludedForLongOverlap).toEqual(["1000PEPEUSDT", "OPUSDT"]);
    expect(on.mixedShortBlocklist.length).toBeGreaterThan(off.mixedShortBlocklist.length);
    expect(on.mixedShortAllowlist).toEqual(off.mixedShortAllowlist); // the env ALLOWLIST really is unchanged
    // TREND's reported lists are the same object on both paths.
    expect(on.trendLongAllowlist).toEqual(off.trendLongAllowlist);
    expect(on.trendShortAllowlist).toEqual(off.trendShortAllowlist);
    expect(on.trendShortBlocklist).toEqual(off.trendShortBlocklist);
  });

  // ── Randomized-draw regression pin ────────────────────────────────────────────────────────────
  // A miniature of the 20,000-draw harness quoted in the source comment (same PRNG, same seed, same
  // score distribution, 2,000 draws for suite speed). It fails if a future change either brings the
  // nondeterministic spillover back or silently alters the shipped configuration's leg deltas.
  function mulberry32(a: number): () => number {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normal(rnd: () => number): number {
    return Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
  }

  it("[DRAWS] over seeded random draws: spillover is eliminated and the short leg becomes deterministic", () => {
    const rnd = mulberry32(20260726);
    const shortAllow = CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST;
    let bothDraft = 0;
    let bothShipped = 0;
    let draftShortDiff = 0;
    let shippedShortDiff = 0;
    let shippedShortIsPoolOnly = 0;
    let shippedFormed = 0;
    let draftSpilloverSymbolsOnly = 0;
    let trendDiff = 0;

    for (let i = 0; i < 2000; i += 1) {
      const s = CROSS_SECTIONAL_UNIVERSE.map((symbol) => ({ symbol, score: normal(rnd) * 0.35, price: 100 }));
      const legs = (b: CrossSectionalObservation | null) => (b === null ? null : b.shortLeg.map((l) => l.symbol).sort().join(","));
      const off = withMixedWideLongPool(undefined, () => buildMixedCrossSectionalBasket(s, { ...BASKET_BASE }));
      const draft = withMixedWideLongPool("1", () =>
        buildMixedCrossSectionalBasket(s, { ...BASKET_BASE, shortBlocklist: CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST }),
      );
      const shipped = withMixedWideLongPool("1", () => buildMixedCrossSectionalBasket(s, { ...BASKET_BASE }));
      if (shipped) shippedFormed += 1;

      if (off && draft) {
        bothDraft += 1;
        if (legs(off) !== legs(draft)) {
          draftShortDiff += 1;
          const joined = draft.shortLeg.map((l) => l.symbol).filter((x) => !off.shortLeg.some((y) => y.symbol === x));
          if (joined.every((x) => x === "OPUSDT" || x === "1000PEPEUSDT")) draftSpilloverSymbolsOnly += 1;
        }
      }
      if (off && shipped) {
        bothShipped += 1;
        if (legs(off) !== legs(shipped)) shippedShortDiff += 1;
      }
      if (shipped) {
        // The short leg the short POOL alone implies — computed with zero knowledge of the long side.
        const bl = withMixedWideLongPool("1", () => crossSectionalMixedShortBlocklist());
        const poolOnly = s
          .filter((x) => shortAllow.has(x.symbol) && !bl.has(x.symbol))
          .sort((a, b) => b.score - a.score) // MEAN_REVERSION shorts the strongest
          .slice(0, 3)
          .map((x) => x.symbol)
          .sort()
          .join(",");
        if (legs(shipped) === poolOnly) shippedShortIsPoolOnly += 1;
      }
      const t = (v: string | undefined) => JSON.stringify(withMixedWideLongPool(v, () => buildTrendCrossSectionalBasket(s, { ...BASKET_BASE })));
      if (t(undefined) !== t("1")) trendDiff += 1;
    }

    // Enough baskets formed for the ratios below to mean something.
    expect(bothDraft).toBeGreaterThan(1500);
    expect(bothShipped).toBeGreaterThan(1500);
    // THE DEFECT: long-widening alone moves the short leg on a large fraction of baskets, and every
    // such move is one of the two both-sides-eligible symbols arriving from the long pool.
    expect(draftShortDiff / bothDraft).toBeGreaterThan(0.30);
    expect(draftSpilloverSymbolsOnly).toBe(draftShortDiff);
    // THE SHIPPED CONFIGURATION: the short leg moves MORE, not less — stated honestly — but it is
    // now a pure function of the short pool in EVERY basket. That second line is the whole point.
    expect(shippedShortDiff / bothShipped).toBeGreaterThan(0.40);
    expect(shippedShortIsPoolOnly).toBe(shippedFormed);
    // TREND never differs between flag states, on any draw.
    expect(trendDiff).toBe(0);
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

  it("[STATIC-POOL] disables old-book auto-demotion when the operator flag is on", () => {
    const store = freshStore();
    for (let i = 0; i < 3; i++) {
      store.add(closedObs(`static-${i}`, [], [["DOGEUSDT", 1, 1.02]]) as never);
    }
    vi.stubEnv("CROSS_SECTIONAL_ADAPTIVE_DISABLED", "1");
    try {
      const f = getCrossSectionalFilteredExecutionFilters(store);
      expect(f.adaptiveDisabled).toBe(true);
      expect(f.longAllowlist).toEqual([...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST]);
      expect(f.shortAllowlist).toEqual([...CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST]);
      expect(f.shortBlocklist).toEqual([...CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

describe("cross-sectional-edge — liquidity floor (2026-08-12)", () => {
  // quote volume per bar = close * volume, so these are $/bar directly
  const bars = (perBar: number, n = 400): Candle[] =>
    Array.from({ length: n }, () => ({ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: perBar }));

  it("[LIQ-DEFAULT] ships DISABLED — a non-zero default would silently narrow live's universe", () => {
    expect(CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR).toBe(0);
  });

  it("[LIQ-OFF] floor of 0 admits every symbol, thin ones included", () => {
    const out = liquidCrossSectionalSymbols({ FATUSDT: bars(5_000_000), THINUSDT: bars(1) }, 0);
    expect(out.has("FATUSDT")).toBe(true);
    expect(out.has("THINUSDT")).toBe(true);
  });

  it("[LIQ-FLOOR] keeps symbols at/above the floor and drops the ones below", () => {
    const out = liquidCrossSectionalSymbols(
      { FATUSDT: bars(5_000_000), EDGEUSDT: bars(1_000_000), THINUSDT: bars(50_000) },
      1_000_000,
    );
    expect([...out].sort()).toEqual(["EDGEUSDT", "FATUSDT"]); // >= is inclusive
  });

  it("[LIQ-MEDIAN] uses the MEDIAN, so one fat bar cannot rescue a thin symbol", () => {
    const spiky = bars(1_000, 400);
    spiky[399] = { openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 10_000_000_000 };
    const mean = spiky.reduce((s, c) => s + c.close * c.volume, 0) / spiky.length;
    expect(mean).toBeGreaterThan(1_000_000); // the mean WOULD have passed
    expect(liquidCrossSectionalSymbols({ SPIKYUSDT: spiky }, 1_000_000).has("SPIKYUSDT")).toBe(false);
  });

  it("[LIQ-THIN-HISTORY] under a day of bars is EXCLUDED, but a day is enough to judge on", () => {
    const floor = 1_000;
    expect(liquidCrossSectionalSymbols({ NEWUSDT: bars(9_000_000, 10) }, floor).has("NEWUSDT")).toBe(false);
    expect(liquidCrossSectionalSymbols({ NEWUSDT: bars(9_000_000, 24) }, floor).has("NEWUSDT")).toBe(true);
    expect(liquidCrossSectionalSymbols({ EMPTYUSDT: [] }, floor).has("EMPTYUSDT")).toBe(false);
  });

  it("[LIQ-FETCH-DEPTH] judges on whatever history the caller fetched — a deep window must not starve it", () => {
    // THE 2026-08-12 TESTNET BUG. The sample minimum was bars/4 (180 of the 720-bar default) while
    // runCrossSectionalCycleGuarded's caller fetches only MOMENTUM_BARS + 5 candles. Every symbol
    // failed, the liquid set came back EMPTY, and an empty allowlist is "allow everything" — so the
    // floor deleted the allowlists instead of narrowing them. ARKMUSDT ($0.05M/h) traded on the
    // very first basket. 41 bars is what the caller actually supplies; it must be judged, not skipped.
    const fetched = 41;
    const fat = liquidCrossSectionalSymbols({ FATUSDT: bars(5_000_000, fetched) }, 1_000_000, 720);
    expect(fat.has("FATUSDT")).toBe(true);
    const thin = liquidCrossSectionalSymbols({ THINUSDT: bars(50_000, fetched) }, 1_000_000, 720);
    expect(thin.has("THINUSDT")).toBe(false);
  });

  it("[LIQ-LOOKBACK-DEFAULT] the default window is not deeper than a cycle plausibly fetches", () => {
    expect(CROSS_SECTIONAL_LIQUIDITY_LOOKBACK_BARS).toBeLessThanOrEqual(168);
  });

  it("[LIQ-NULL] a null liquid set is a byte-for-byte passthrough, including the empty list", () => {
    expect([...narrowAllowlistToLiquid(["AUSDT", "BUSDT"], null)]).toEqual(["AUSDT", "BUSDT"]);
    expect([...narrowAllowlistToLiquid([], null)]).toEqual([]); // stays "allow everything"
  });

  it("[LIQ-EMPTY-TRAP] an EMPTY allowlist means allow-everything, so the liquid set BECOMES the allowlist", () => {
    const liquid = new Set(["AUSDT", "BUSDT"]);
    // the bug this guards: intersecting [] with liquid yields [], which allowed() reads as
    // "allow every symbol" — silently discarding the floor on exactly the widened-pool config
    // this feature exists for.
    expect([...narrowAllowlistToLiquid([], liquid)].sort()).toEqual(["AUSDT", "BUSDT"]);
  });

  it("[LIQ-INTERSECT] a non-empty allowlist is intersected, never widened", () => {
    const liquid = new Set(["AUSDT", "CUSDT"]);
    expect([...narrowAllowlistToLiquid(["AUSDT", "BUSDT"], liquid)]).toEqual(["AUSDT"]);
    expect([...narrowAllowlistToLiquid(["ausdt"], liquid)]).toEqual(["ausdt"]); // case-insensitive match
  });

  it("[LIQ-STARVED] a floor that admits nothing blocks the basket instead of widening it", () => {
    const empty = new Set<string>();
    const some = new Set(["AUSDT"]);
    // floor OFF -> never starved, the un-floored path must be untouched
    expect(crossSectionalLiquidityStarved(empty, empty, null)).toBe(false);
    // floor ON and a side narrowed to nothing -> starved, because building would read that empty
    // list as "allow everything" and trade the WHOLE universe, thin names included
    expect(crossSectionalLiquidityStarved(empty, some, new Set(["AUSDT"]))).toBe(true);
    expect(crossSectionalLiquidityStarved(some, empty, new Set(["AUSDT"]))).toBe(true);
    expect(crossSectionalLiquidityStarved(some, some, new Set(["AUSDT"]))).toBe(false);
  });

  it("[LIQ-BASKET] fail-without/pass-with: the floor keeps a thin top-ranked symbol OUT of the legs", () => {
    // SEIUSDT is the strongest short candidate here and is on the FILTERED short allowlist.
    const rows = scored([
      ["ETHUSDT", 0.09, 100], ["SOLUSDT", 0.08, 100], ["BNBUSDT", 0.07, 100], ["ADAUSDT", 0.06, 100],
      ["SEIUSDT", -0.09, 100], ["WLDUSDT", -0.08, 100], ["ARBUSDT", -0.07, 100], ["XRPUSDT", -0.06, 100],
    ]);
    const opts = {
      k: 3, now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      longAllowlist: new Set<string>(), shortBlocklist: new Set<string>(), maxPerCluster: 0,
    };
    const withoutFloor = buildFilteredCrossSectionalBasket(rows, {
      ...opts, shortAllowlist: narrowAllowlistToLiquid([], null),
    })!;
    expect(withoutFloor.shortLeg.map((l) => l.symbol)).toContain("SEIUSDT");

    const liquid = new Set(["ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT", "WLDUSDT", "ARBUSDT", "XRPUSDT"]);
    const withFloor = buildFilteredCrossSectionalBasket(rows, {
      ...opts, longAllowlist: narrowAllowlistToLiquid([], liquid), shortAllowlist: narrowAllowlistToLiquid([], liquid),
    })!;
    expect(withFloor.shortLeg.map((l) => l.symbol)).not.toContain("SEIUSDT");
    expect(withFloor.shortLeg).toHaveLength(3); // still forms a full basket from what remains
  });
});

describe("cross-sectional-edge — adaptive demotion freeze (2026-08-12)", () => {
  it("[FREEZE-DEFAULT] ships OFF, and only the exact string \"1\" enables it", () => {
    expect(isCrossSectionalAdaptiveDemotionFrozen({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCrossSectionalAdaptiveDemotionFrozen({ CROSS_SECTIONAL_ADAPTIVE_DEMOTION_FROZEN: "1" } as NodeJS.ProcessEnv)).toBe(true);
    for (const v of ["0", "", "true", "yes"]) {
      expect(isCrossSectionalAdaptiveDemotionFrozen({ CROSS_SECTIONAL_ADAPTIVE_DEMOTION_FROZEN: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it("[FREEZE-OFF-UNCHANGED] with the flag off, demotion still runs exactly as before", () => {
    // a symbol with >= 3 measured LONG legs averaging negative must still be demoted
    const store = freshStore();
    for (let i = 0; i < 3; i++) {
      store.add({
        observationId: `o${i}`, openedAt: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        signal: CROSS_SECTIONAL_FILTERED_SIGNAL, variant: "FILTERED", strategyFamily: "MOMENTUM_DISPERSION",
        k: 3, longK: 1, shortK: 1,
        longLeg: [{ symbol: "ADAUSDT", entryPrice: 100, exitPrice: 90, weight: 0.5 }],
        shortLeg: [{ symbol: "DOGEUSDT", entryPrice: 100, exitPrice: 90, weight: 0.5 }],
        status: "CLOSED", scoreGap: 0.1, regimeContext: null, regimeClassAtOpen: null,
        longCapitalWeight: 0.5, shortCapitalWeight: 0.5, weightingModel: "EQUAL_NOTIONAL",
        takeProfitReturn: null, stopLossReturn: null, riskDistanceAtOpen: 0.003, regimeFlipExit: false,
        exitReason: "HORIZON", grossReturn: 0, costReturn: 0, netReturn: 0,
        longLegReturn: -0.1, shortLegReturn: 0.1, resolvedAt: T0,
      } as CrossSectionalObservation);
    }
    const out = deriveAdaptiveSymbolFilters(store);
    expect(out.provenance.demotedLong).toContain("ADAUSDT");
    expect(out.longAllowlist).not.toContain("ADAUSDT");
  });
});

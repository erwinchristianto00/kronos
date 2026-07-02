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

const BAR_FUDGE = 60 * 60_000 + 1000; // one 1h bar + a little, to push past the horizon

describe("deriveAdaptiveSymbolFilters — auto-updating allow/blocklists from measured legs", () => {

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

  it("promotes measured winners into allowlists and demotes measured losers (env = prior)", () => {
    const store = freshStore();
    // SOL long leg: 3 wins (+2% each) → promoted long (already in env allow — stays).
    // FETUSDT long: 3 losses (-2%) → demoted long (blocked) even though not in env lists.
    // NEARUSDT short: 3 wins (price fell) → promoted short, UN-blocked from env shortBlocklist.
    // DOGEUSDT short: 3 losses (price rose) → demoted from env short allowlist + blocklisted.
    for (let i = 0; i < 3; i++) {
      store.add(closedObs(`a${i}`, [["SOLUSDT", 100, 102], ["FETUSDT", 1, 0.98]], [["NEARUSDT", 2, 1.9], ["DOGEUSDT", 0.07, 0.075]]) as never);
    }
    const f = deriveAdaptiveSymbolFilters(store);
    expect(f.longAllowlist).toContain("SOLUSDT");
    expect(f.longAllowlist).not.toContain("FETUSDT");
    expect(f.longBlocklist).toContain("FETUSDT");
    expect(f.shortAllowlist).toContain("NEARUSDT"); // measured-positive un-blocks the env-era block
    expect(f.shortBlocklist).not.toContain("NEARUSDT");
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
});

import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  deriveAdaptiveSymbolFilters,
  getCrossSectionalFilteredExecutionFilters,
  shouldApplyCandleLiquidityFloor,
  crossSectionalMomentumScore,
  buildCrossSectionalBasket,
  buildFilteredCrossSectionalBasket,
  filteredWeightingModel,
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
  CROSS_SECTIONAL_TREND_LONG_BLOCKLIST,
  CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST,
  CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST,
  CROSS_SECTIONAL_UNIVERSE,
  CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP,
  crossSectionalMixedLongAllowlist,
  crossSectionalMixedShortBlocklist,
  crossSectionalLegScaleAnomaly,
  crossSectionalScaleAnomalies,
  isCrossSectionalMixedWideLongPoolEnabled,
  getCrossSectionalAdaptiveConfig,
  regimeSkewedK,
  regimeSkewCounterfactual,
  type ScoredSymbol,
  type CrossSectionalObservation,
  nonOverlappingClosedSample,
} from "../src/lib/cross-sectional-edge.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterOf } from "../src/lib/correlation-clusters.js";
import type { SymbolReliabilitySnapshot } from "../src/lib/cross-sectional-symbol-reliability.js";

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
const DAY_MS = 24 * 60 * 60_000;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

  describe("[SCORE-RANK] CAPPED_SCORE_RANK sizes by conviction, not by calmness", () => {
    // 2026-08-17. The live basket xb-msw8ddsf-ltered sized WLD (+4.674% MOM36) at weight 0.132 and
    // TAO (+0.051%) at 0.219 under CAPPED_INVERSE_VOL, because TAO was the calmest leg. These pin
    // the reversal: the leg carrying the signal must get the most capital on BOTH sides.
    const wlBasket = (model: "CAPPED_INVERSE_VOL" | "CAPPED_SCORE_RANK") =>
      buildCrossSectionalBasket(
        [
          { symbol: "WLDUSDT", score: 0.04674, price: 0.3629, volatility: 0.009044, fastReturn: 0, extensionVol: 0 },
          { symbol: "UNIUSDT", score: 0.02191, price: 3.306, volatility: 0.003762, fastReturn: 0, extensionVol: 0 },
          { symbol: "TAOUSDT", score: 0.00051, price: 197.46, volatility: 0.001776, fastReturn: 0, extensionVol: 0 },
          { symbol: "1000PEPEUSDT", score: -0.02264, price: 0.0025915, volatility: 0.004067, fastReturn: 0, extensionVol: 0 },
          { symbol: "BNBUSDT", score: -0.00896, price: 606.36, volatility: 0.001281, fastReturn: 0, extensionVol: 0 },
          { symbol: "SUIUSDT", score: -0.00850, price: 0.6771, volatility: 0.001896, fastReturn: 0, extensionVol: 0 },
        ],
        {
          k: 3, signal: "MOM36", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS,
          weightingModel: model,
          volBySymbol: { WLDUSDT: 0.009044, UNIUSDT: 0.003762, TAOUSDT: 0.001776, "1000PEPEUSDT": 0.004067, BNBUSDT: 0.001281, SUIUSDT: 0.001896 },
        },
      )!;

    it("reproduces the inversion under the OLD model — strongest signal, smallest weight", () => {
      const b = wlBasket("CAPPED_INVERSE_VOL");
      const w = Object.fromEntries(b.longLeg.map((l) => [l.symbol, l.weight!]));
      expect(w.WLDUSDT!).toBeLessThan(w.TAOUSDT!); // the defect, pinned
    });

    it("REVERSES it: the strongest long score now carries the most capital", () => {
      const b = wlBasket("CAPPED_SCORE_RANK");
      const w = Object.fromEntries(b.longLeg.map((l) => [l.symbol, l.weight!]));
      expect(w.WLDUSDT!).toBeGreaterThan(w.UNIUSDT!);
      expect(w.UNIUSDT!).toBeGreaterThan(w.TAOUSDT!);
    });

    it("tilts the SHORT side toward the MOST NEGATIVE score, not the highest", () => {
      const b = wlBasket("CAPPED_SCORE_RANK");
      const w = Object.fromEntries(b.shortLeg.map((l) => [l.symbol, l.weight!]));
      expect(w["1000PEPEUSDT"]!).toBeGreaterThan(w.BNBUSDT!); // -2.264% is the strongest short
      expect(w["1000PEPEUSDT"]!).toBeGreaterThan(w.SUIUSDT!);
    });

    it("keeps each side's capital at 0.5 and respects the 0.75-1.25 clip (max 1.67x spread)", () => {
      const b = wlBasket("CAPPED_SCORE_RANK");
      for (const legs of [b.longLeg, b.shortLeg]) {
        expect(legs.reduce((sum, l) => sum + l.weight!, 0)).toBeCloseTo(0.5, 9);
        const ws = legs.map((l) => l.weight!);
        expect(Math.max(...ws) / Math.min(...ws)).toBeLessThanOrEqual(1.25 / 0.75 + 1e-9);
      }
    });

    it("equal scores on a side fall back to equal weights, never a divide-by-zero", () => {
      const b = buildCrossSectionalBasket(
        [
          { symbol: "A", score: 0.05, price: 10, volatility: 0.01, fastReturn: 0, extensionVol: 0 },
          { symbol: "B", score: 0.05, price: 10, volatility: 0.02, fastReturn: 0, extensionVol: 0 },
          { symbol: "C", score: -0.05, price: 10, volatility: 0.01, fastReturn: 0, extensionVol: 0 },
          { symbol: "D", score: -0.05, price: 10, volatility: 0.02, fastReturn: 0, extensionVol: 0 },
        ],
        { k: 2, signal: "MOM36", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS, weightingModel: "CAPPED_SCORE_RANK" },
      )!;
      for (const legs of [b.longLeg, b.shortLeg]) {
        expect(legs[0]!.weight!).toBeCloseTo(legs[1]!.weight!, 12);
        expect(legs.reduce((s, l) => s + l.weight!, 0)).toBeCloseTo(0.5, 12);
      }
    });
  });

  describe("[GAP-REJECT] the gate now records what it refused", () => {
    // Before this hook a rejected basket was written nowhere, so the live store held ZERO
    // observations below the 0.02 floor and the gate could never be evaluated from real data.
    const scoredPair = (longScore: number, shortScore: number) => [
      { symbol: "A", score: longScore, price: 10, volatility: 0.01, fastReturn: 0, extensionVol: 0 },
      { symbol: "B", score: shortScore, price: 20, volatility: 0.02, fastReturn: 0, extensionVol: 0 },
    ];
    const opts = (extra: Record<string, unknown>) => ({
      k: 1, signal: "MOM36_FILTERED", now: T0, openedAtMs: T0ms,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS, minScoreGap: 0.02, ...extra,
    });

    it("fires with the composition it WOULD have opened when the gap is too small", () => {
      const seen: unknown[] = [];
      const b = buildCrossSectionalBasket(scoredPair(0.005, -0.004), opts({ onGapReject: (i: unknown) => seen.push(i) }));
      expect(b).toBeNull(); // still refused — the gate itself is unchanged
      expect(seen).toHaveLength(1);
      const info = seen[0] as { scoreGap: number; minScoreGap: number; longs: Array<{ symbol: string }>; shorts: Array<{ symbol: string }> };
      expect(info.scoreGap).toBeCloseTo(0.009, 9);
      expect(info.minScoreGap).toBe(0.02);
      expect(info.longs.map((l) => l.symbol)).toEqual(["A"]);
      expect(info.shorts.map((l) => l.symbol)).toEqual(["B"]);
    });

    it("does NOT fire when the gap passes — only refusals are recorded", () => {
      const seen: unknown[] = [];
      const b = buildCrossSectionalBasket(scoredPair(0.05, -0.05), opts({ onGapReject: (i: unknown) => seen.push(i) }));
      expect(b).not.toBeNull();
      expect(seen).toHaveLength(0);
    });

    it("behaves exactly as before when no hook is supplied", () => {
      expect(buildCrossSectionalBasket(scoredPair(0.005, -0.004), opts({}))).toBeNull();
    });

    it("a THROWING hook never breaks basket formation", () => {
      expect(() =>
        buildCrossSectionalBasket(scoredPair(0.005, -0.004), opts({ onGapReject: () => { throw new Error("sink down"); } })),
      ).not.toThrow();
    });
  });

  describe("[SCORE-RANK] filteredWeightingModel env selection", () => {
    it("accepts the four real models, case-insensitively", () => {
      expect(filteredWeightingModel({ CROSS_SECTIONAL_FILTERED_WEIGHTING: "CAPPED_SCORE_RANK" } as NodeJS.ProcessEnv)).toBe("CAPPED_SCORE_RANK");
      expect(filteredWeightingModel({ CROSS_SECTIONAL_FILTERED_WEIGHTING: " equal_notional " } as NodeJS.ProcessEnv)).toBe("EQUAL_NOTIONAL");
    });

    it("falls back to the PREVIOUS production model on anything unrecognised — never equal-weight by accident", () => {
      expect(filteredWeightingModel({} as NodeJS.ProcessEnv)).toBe("CAPPED_INVERSE_VOL");
      expect(filteredWeightingModel({ CROSS_SECTIONAL_FILTERED_WEIGHTING: "typo" } as NodeJS.ProcessEnv)).toBe("CAPPED_INVERSE_VOL");
      expect(filteredWeightingModel({ CROSS_SECTIONAL_FILTERED_WEIGHTING: "" } as NodeJS.ProcessEnv)).toBe("CAPPED_INVERSE_VOL");
    });
  });

  it("[OPERATOR-VOID] retains a raw source observation but removes it from the report and future edge cohort", () => {
    const store = freshStore();
    const closed = (observationId: string, netReturn: number): CrossSectionalObservation => ({
      ...buildCrossSectionalBasket(
        scored([["SOLUSDT", 0.2, 100], ["DOGEUSDT", -0.2, 0.1]]),
        { k: 1, signal: "MOM24", now: T0, openedAtMs: T0ms, horizonMs: CROSS_SECTIONAL_HORIZON_MS },
      )!,
      observationId,
      status: "CLOSED",
      grossReturn: netReturn + 0.001,
      costReturn: 0.001,
      netReturn,
      longLegReturn: netReturn,
      shortLegReturn: 0,
      resolvedAt: T0,
    });
    store.add(closed("kept", 0.02));
    store.add(closed("voided", -0.5));

    const voided = store.voidObservationForReporting("voided", {
      reason: "linked executed basket was operator-voided",
      voidedAt: T0,
      sourceBasketId: "xb-test-void",
    });
    expect(voided).toMatchObject({ ok: true, alreadyVoided: false, observationId: "voided" });
    expect(store.all).toHaveLength(2); // raw record remains for audit
    expect(store.reportable.map((observation) => observation.observationId)).toEqual(["kept"]);

    const report = buildCrossSectionalReport(store, T0ms + 1, { signal: "MOM24" });
    expect(report.closed).toBe(1);
    expect(report.totalNetReturn).toBeCloseTo(0.02, 12);
    expect(report.recentNetReturns).toEqual([0.02]);
    expect(store.voidObservationForReporting("voided", { reason: "retry" })).toMatchObject({ ok: true, alreadyVoided: true });
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

  describe("[FILTERED SIDE TREND] refuses to force a symbol onto the wrong side", () => {
    const common = {
      k: 3,
      now: T0,
      openedAtMs: T0ms,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      minScoreGap: 0,
      maxPerCluster: 0,
    };

    it("uses only slow-and-fast aligned names and fails closed when the market has no eligible hedge side", () => {
      const aligned = withEnv({ CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "1" }, () =>
        buildFilteredCrossSectionalBasket([
          { symbol: "L_REVERSING", score: 0.30, price: 100, fastReturn: -0.01 },
          { symbol: "L1", score: 0.25, price: 100, fastReturn: 0.03 },
          { symbol: "L2", score: 0.20, price: 100, fastReturn: 0.02 },
          { symbol: "L3", score: 0.15, price: 100, fastReturn: 0.01 },
          { symbol: "S_REVERSING", score: -0.30, price: 100, fastReturn: 0.01 },
          { symbol: "S1", score: -0.25, price: 100, fastReturn: -0.03 },
          { symbol: "S2", score: -0.20, price: 100, fastReturn: -0.02 },
          { symbol: "S3", score: -0.15, price: 100, fastReturn: -0.01 },
        ], {
          ...common,
          longAllowlist: new Set(["L_REVERSING", "L1", "L2", "L3"]),
          shortAllowlist: new Set(["S_REVERSING", "S1", "S2", "S3"]),
        }),
      )!;
      expect(aligned.longLeg.map((leg) => leg.symbol)).toEqual(["L1", "L2", "L3"]);
      expect(aligned.shortLeg.map((leg) => leg.symbol)).toEqual(["S1", "S2", "S3"]);

      const fallingOnly: ScoredSymbol[] = [
        { symbol: "F1", score: -0.30, price: 100, fastReturn: -0.03 },
        { symbol: "F2", score: -0.20, price: 100, fastReturn: -0.02 },
        { symbol: "F3", score: -0.10, price: 100, fastReturn: -0.01 },
        { symbol: "F4", score: -0.05, price: 100, fastReturn: -0.01 },
      ];
      withEnv({ CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "1" }, () => {
        expect(buildFilteredCrossSectionalBasket(fallingOnly, {
          ...common,
          longAllowlist: new Set(fallingOnly.map((row) => row.symbol)),
          shortAllowlist: new Set(fallingOnly.map((row) => row.symbol)),
        })).toBeNull();
      });
    });

    it("keeps rank-only selection available only behind the explicit OFF setting", () => {
      const risingOnly: ScoredSymbol[] = [
        { symbol: "R1", score: 0.30, price: 100, fastReturn: 0.03 },
        { symbol: "R2", score: 0.20, price: 100, fastReturn: 0.02 },
        { symbol: "R3", score: 0.10, price: 100, fastReturn: 0.01 },
        { symbol: "R4", score: 0.05, price: 100, fastReturn: 0.01 },
        { symbol: "R5", score: 0.04, price: 100, fastReturn: 0.01 },
        { symbol: "R6", score: 0.03, price: 100, fastReturn: 0.01 },
      ];
      const allSymbols = new Set(risingOnly.map((row) => row.symbol));
      const legacy = withEnv({ CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "0" }, () =>
        buildFilteredCrossSectionalBasket(risingOnly, {
          ...common,
          longAllowlist: allSymbols,
          shortAllowlist: allSymbols,
        }),
      )!;
      expect(legacy.shortLeg.map((leg) => leg.symbol)).toEqual(["R6", "R5", "R4"]);
    });
  });

  it("[SMART BASKET V1] keeps the same FILTERED universe/K but prefers a close-ranked, confirmed normal-range leg over a stretched reversal", () => {
    const detailed: ScoredSymbol[] = [
      // Raw top long, but it just reversed hard after a 3σ extension.  This is the NEAR/AVAX
      // failure shape from the testnet review: not excluded, merely no longer automatic top-k.
      { symbol: "L1", score: 0.2200, price: 100, fastReturn: -0.04, volatility: 0.02, extensionVol: 3 },
      { symbol: "L2", score: 0.2199, price: 100, fastReturn: 0.04, volatility: 0.02, extensionVol: 0 },
      { symbol: "L3", score: 0.2198, price: 100, fastReturn: 0.04, volatility: 0.02, extensionVol: 0 },
      { symbol: "L4", score: 0.2197, price: 100, fastReturn: 0.01, volatility: 0.02, extensionVol: 0 },
      { symbol: "S1", score: -0.20, price: 100, fastReturn: -0.01, volatility: 0.02, extensionVol: 0 },
      { symbol: "S2", score: -0.19, price: 100, fastReturn: -0.01, volatility: 0.02, extensionVol: 0 },
      { symbol: "S3", score: -0.18, price: 100, fastReturn: -0.01, volatility: 0.02, extensionVol: 0 },
    ];
    const common = {
      k: 2,
      now: T0,
      openedAtMs: T0ms,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      minScoreGap: 0,
      maxPerCluster: 0,
      longAllowlist: new Set(["L1", "L2", "L3", "L4"]),
      shortAllowlist: new Set(["S1", "S2", "S3"]),
    };
    const legacy = buildFilteredCrossSectionalBasket(detailed, { ...common, smartFormation: { enabled: false } })!;
    const smart = buildFilteredCrossSectionalBasket(detailed, {
      ...common,
      smartFormation: { enabled: true, axisScore: -0.4 },
    })!;

    expect(legacy.longLeg.map((leg) => leg.symbol)).toEqual(["L1", "L2"]);
    expect(smart.longLeg.map((leg) => leg.symbol)).toEqual(["L2", "L3"]);
    expect(smart.shortLeg).toHaveLength(2);
    expect(smart.smartFormation).toMatchObject({ version: "SMART_BASKET_V1", axisScore: -0.4 });
    expect(smart.smartFormation!.candidates.find((candidate) => candidate.symbol === "L1")!.selected).toBe(false);
    expect(smart.longLeg.every((leg) => leg.fastReturnAtOpen !== undefined && leg.extensionVolAtOpen !== undefined)).toBe(true);
  });

  describe("[FORMATION MODE] lifecycle flags never select symbols", () => {
    const detailed: ScoredSymbol[] = [
      { symbol: "SOLUSDT", score: 0.2200, price: 100, fastReturn: -0.04, volatility: 0.02, extensionVol: 3 },
      { symbol: "AVAXUSDT", score: 0.2199, price: 100, fastReturn: 0.04, volatility: 0.02, extensionVol: 0 },
      { symbol: "SUIUSDT", score: 0.2198, price: 100, fastReturn: 0.04, volatility: 0.02, extensionVol: 0 },
      { symbol: "UNIUSDT", score: 0.2197, price: 100, fastReturn: 0.01, volatility: 0.02, extensionVol: 0 },
      { symbol: "AAVEUSDT", score: 0.2196, price: 100, fastReturn: 0.04, volatility: 0.02, extensionVol: 0 },
      { symbol: "DOGEUSDT", score: -0.2000, price: 100, fastReturn: -0.01, volatility: 0.02, extensionVol: 0 },
      { symbol: "1000PEPEUSDT", score: -0.1900, price: 100, fastReturn: -0.01, volatility: 0.02, extensionVol: 0 },
      { symbol: "XRPUSDT", score: -0.1800, price: 100, fastReturn: -0.01, volatility: 0.02, extensionVol: 0 },
      { symbol: "WLDUSDT", score: -0.1700, price: 100, fastReturn: -0.01, volatility: 0.02, extensionVol: 0 },
    ];
    const common = {
      k: 3,
      now: T0,
      openedAtMs: T0ms,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      minScoreGap: 0.058,
      maxPerCluster: 2,
      weightingModel: "CAPPED_SCORE_RANK" as const,
      longAllowlist: new Set(["SOLUSDT", "AVAXUSDT", "SUIUSDT", "UNIUSDT", "AAVEUSDT"]),
      shortAllowlist: new Set(["DOGEUSDT", "1000PEPEUSDT", "XRPUSDT", "WLDUSDT"]),
    };
    const shape = (basket: NonNullable<ReturnType<typeof buildFilteredCrossSectionalBasket>>) => ({
      formationMode: basket.formationMode,
      smartFormation: basket.smartFormation,
      scoreGap: basket.scoreGap,
      weightingModel: basket.weightingModel,
      long: basket.longLeg.map((leg) => ({ symbol: leg.symbol, weight: leg.weight })),
      short: basket.shortLeg.map((leg) => ({ symbol: leg.symbol, weight: leg.weight })),
    });

    it("SMART_BASKET_V1=1 plus RERANK=0 is exactly the canonical Plain MOM36 basket", () => {
      const canonical = buildCrossSectionalBasket(detailed, {
        ...common,
        signal: CROSS_SECTIONAL_FILTERED_SIGNAL,
        variant: "FILTERED",
        formationMode: "PLAIN_MOM36",
      })!;
      const production = withEnv({
        CROSS_SECTIONAL_SMART_BASKET_V1: "1",
        CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      }, () => buildFilteredCrossSectionalBasket(detailed, common)!);

      expect(production.formationMode).toBe("PLAIN_MOM36");
      expect(production.smartFormation).toBeNull();
      expect(shape(production)).toEqual(shape(canonical));
    });

    it("RERANK=1 enters the Smart Formation path even when the lifecycle flag is OFF", () => {
      const plain = withEnv({
        CROSS_SECTIONAL_SMART_BASKET_V1: "1",
        CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      }, () => buildFilteredCrossSectionalBasket(detailed, common)!);
      const smart = withEnv({
        CROSS_SECTIONAL_SMART_BASKET_V1: "0",
        CROSS_SECTIONAL_SMART_FORMATION_RERANK: "1",
      }, () => buildFilteredCrossSectionalBasket(detailed, common)!);

      expect(smart.formationMode).toBe("SMART_FORMATION_RERANK");
      expect(smart.smartFormation).toMatchObject({ version: "SMART_BASKET_V1" });
      expect(smart.longLeg.map((leg) => leg.symbol)).not.toEqual(plain.longLeg.map((leg) => leg.symbol));
    });

    it("lifecycle and ghost toggles leave plain symbols, cluster cap, scoreGap, and weights unchanged", () => {
      const lifecycleOff = withEnv({
        CROSS_SECTIONAL_SMART_BASKET_V1: "0",
        CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
        CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "0",
        CROSS_SECTIONAL_SMART_INVALIDATION_SCANS: "2",
      }, () => buildFilteredCrossSectionalBasket(detailed, common)!);
      const lifecycleOn = withEnv({
        CROSS_SECTIONAL_SMART_BASKET_V1: "1",
        CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
        CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "1",
        CROSS_SECTIONAL_SMART_INVALIDATION_SCANS: "999",
      }, () => buildFilteredCrossSectionalBasket(detailed, common)!);

      expect(shape(lifecycleOn)).toEqual(shape(lifecycleOff));
      expect(lifecycleOn.weightingModel).toBe("CAPPED_SCORE_RANK");
      expect(lifecycleOn.scoreGap).toBeGreaterThanOrEqual(0.058);
    });
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

  it("[SCALE-GUARD] voids a 1000PEPE spot/futures price-scale mismatch from reporting", () => {
    // The multiplier contract is priced near 0.003, while bare spot PEPE is
    // near 0.000003.  A resolver may close the observation for auditability,
    // but it must never let that ~1000x unit mismatch into learned results.
    const basket = buildCrossSectionalBasket(
      scored([["SOLUSDT", 0.5, 100], ["1000PEPEUSDT", -0.4, 0.003]]),
      { k: 1, signal: "MOM", now: T0, openedAtMs: T0ms, horizonMs: 1_000 },
    )!;
    const resolved = resolveCrossSectional(
      basket,
      { SOLUSDT: 101, "1000PEPEUSDT": 0.000003 },
      new Date(T0ms + 2_000).toISOString(),
      0,
    );

    expect(crossSectionalLegScaleAnomaly(0.003, 0.000003)).toBe(true);
    expect(crossSectionalScaleAnomalies([...resolved.longLeg, ...resolved.shortLeg])).toEqual([
      "1000PEPEUSDT entry=0.003 exit=0.000003",
    ]);
    expect(resolved.reportingExclusion).toMatchObject({
      kind: "OPERATOR_VOID",
      reason: expect.stringContaining("AUTOMATIC SCALE GUARD"),
    });
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

// ── Symbol Reliability V1 formation wiring ─────────────────────────────────

const RELIABILITY_TEST_UNIVERSE = [
  "ETHUSDT", "SOLUSDT", "OPUSDT", "BNBUSDT", "ADAUSDT", "SUIUSDT", "1000PEPEUSDT",
  "WLDUSDT", "DOGEUSDT", "SEIUSDT", "ARBUSDT", "XRPUSDT", "LINKUSDT", "WIFUSDT", "AAVEUSDT",
];

function reliabilityCandles(score: number): Candle[] {
  const start = 100;
  const end = start * (1 + score);
  return Array.from({ length: 30 }, (_, index) => {
    const fraction = index < 5 ? 0 : (index - 5) / 24;
    return mkCandle(start + (end - start) * fraction);
  });
}

const RELIABILITY_TEST_SCORES: Record<string, number> = {
  ETHUSDT: 0.16, SOLUSDT: 0.14, OPUSDT: 0.12, BNBUSDT: 0.10, ADAUSDT: 0.08, SUIUSDT: 0.06, "1000PEPEUSDT": 0.04,
  WLDUSDT: -0.16, DOGEUSDT: -0.14, SEIUSDT: -0.12, ARBUSDT: -0.10, XRPUSDT: -0.08, LINKUSDT: -0.06, WIFUSDT: -0.04, AAVEUSDT: -0.02,
};

function reliabilitySnapshot(quarantined: Array<{ symbol: string; side: "LONG" | "SHORT" }> = []): SymbolReliabilitySnapshot {
  return {
    version: "SYMBOL_RELIABILITY_V1",
    enabled: true,
    persistence: { status: "HEALTHY", source: "PRIMARY", reason: null, recoveredAt: null },
    evidenceContract: "ACTUAL_NO_TP_HOLD_36H_INDEPENDENT_EPISODES_V1",
    evaluatedAt: T0,
    evaluationId: "sr-v1-test",
    evaluationCycle: 1,
    evidenceChanged: false,
    independentEpisodes: 0,
    eligibleBaskets: 0,
    excludedBaskets: {},
    minimumIndependentEpisodes: 8,
    statuses: [
      { symbol: "ETHUSDT", side: "LONG", status: "HEALTHY" },
      { symbol: "SOLUSDT", side: "LONG", status: "QUARANTINED" },
      { symbol: "OPUSDT", side: "LONG", status: "DEGRADED" },
      { symbol: "WLDUSDT", side: "SHORT", status: "INSUFFICIENT_DATA" },
    ] as SymbolReliabilitySnapshot["statuses"],
    quarantined: quarantined.map((row) => ({ ...row, reason: "strict two-cycle evidence" })),
    lastFormationDecision: null,
  };
}

async function runReliabilityFormation(
  snapshot: SymbolReliabilitySnapshot | null,
  now: number,
): Promise<{ store: CrossSectionalStore; decisions: NonNullable<CrossSectionalObservation["symbolReliability"]>[] }> {
  const store = freshStore();
  const decisions: NonNullable<CrossSectionalObservation["symbolReliability"]>[] = [];
  await runCrossSectionalCycle({
    store,
    universe: RELIABILITY_TEST_UNIVERSE,
    now,
    fetchCandles: async (symbol) => reliabilityCandles(RELIABILITY_TEST_SCORES[symbol]!),
    symbolReliabilitySnapshotGetter: () => snapshot,
    symbolReliabilityDecisionRecorder: (decision) => {
      decisions.push(decision);
      return true;
    },
  });
  return { store, decisions };
}

function filteredShape(store: CrossSectionalStore): { long: Array<{ symbol: string; score: number | undefined; weight: number | null | undefined }>; short: Array<{ symbol: string; score: number | undefined; weight: number | null | undefined }>; scoreGap: number | null | undefined } {
  const basket = store.all.find((row) => row.variant === "FILTERED")!;
  return {
    long: basket.longLeg.map((leg) => ({ symbol: leg.symbol, score: leg.scoreAtOpen, weight: leg.weight })),
    short: basket.shortLeg.map((leg) => ({ symbol: leg.symbol, score: leg.scoreAtOpen, weight: leg.weight })),
    scoreGap: basket.scoreGap,
  };
}

describe("[SYMBOL-RELIABILITY] Plain MOM36 formation gate", () => {
  const formationEnv = {
    CROSS_SECTIONAL_ADAPTIVE_DISABLED: "1",
    CROSS_SECTIONAL_FILTERED_DISABLED: "0",
    CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
    CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
    CROSS_SECTIONAL_STAND_DOWN_14D_PCT: undefined,
  };

  it("keeps scores, universe, selection, gap, and weights bit-for-bit unchanged for HEALTHY/DEGRADED/INSUFFICIENT_DATA", async () => {
    await withEnvAsync({ ...formationEnv, CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: undefined }, async () => {
      const baseline = await runReliabilityFormation(null, T0ms + 10 * DAY_MS);
      await withEnvAsync({ CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "1" }, async () => {
        const observed = await runReliabilityFormation(reliabilitySnapshot(), T0ms + 11 * DAY_MS);
        expect(filteredShape(observed.store)).toEqual(filteredShape(baseline.store));
        const basket = observed.store.all.find((row) => row.variant === "FILTERED")!;
        expect(basket.symbolReliability?.quarantined).toEqual([]);
        expect(basket.formationMode).toBe("PLAIN_MOM36");
      });
    });
  });

  it("removes only a QUARANTINED LONG, reselects a full hedge, and records exact provenance", async () => {
    await withEnvAsync({ ...formationEnv, CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "1" }, async () => {
      const baseline = await runReliabilityFormation(reliabilitySnapshot(), T0ms + 12 * DAY_MS);
      const observed = await runReliabilityFormation(reliabilitySnapshot([{ symbol: "SOLUSDT", side: "LONG" }]), T0ms + 13 * DAY_MS);
      const basket = observed.store.all.find((row) => row.variant === "FILTERED")!;
      const before = filteredShape(baseline.store);
      const after = filteredShape(observed.store);

      expect(before.long.map((leg) => leg.symbol)).toContain("SOLUSDT");
      expect(after.long.map((leg) => leg.symbol)).not.toContain("SOLUSDT");
      expect(after.short).toEqual(before.short); // LONG quarantine cannot rewrite the short hedge
      expect(after.long).toHaveLength(3);
      expect(after.short).toHaveLength(3);
      expect(after.scoreGap).toBeGreaterThanOrEqual(0.02);
      expect(basket.longLeg.reduce((sum, leg) => sum + (leg.weight ?? 0), 0)).toBeCloseTo(0.5, 12);
      expect(basket.shortLeg.reduce((sum, leg) => sum + (leg.weight ?? 0), 0)).toBeCloseTo(0.5, 12);
      for (const side of [basket.longLeg, basket.shortLeg]) {
        const byCluster = new Map<string, number>();
        for (const leg of side) byCluster.set(clusterOf(leg.symbol), (byCluster.get(clusterOf(leg.symbol)) ?? 0) + 1);
        expect([...byCluster.entries()].every(([cluster, count]) => cluster === "MAJORS" || count <= 2)).toBe(true);
      }
      expect(basket.symbolReliability).toMatchObject({
        decision: "PASS",
        selectedBefore: { LONG: before.long.map((leg) => leg.symbol), SHORT: before.short.map((leg) => leg.symbol) },
        selectedAfter: { LONG: after.long.map((leg) => leg.symbol), SHORT: after.short.map((leg) => leg.symbol) },
        scoreGapBefore: before.scoreGap,
        scoreGapAfter: after.scoreGap,
      });
      expect(basket.symbolReliability?.replacements).toContainEqual({ side: "LONG", removed: "SOLUSDT", replacement: "BNBUSDT" });
      expect(observed.decisions).toHaveLength(1);
    });
  });

  it("fails closed to NO_TRADE when quarantine leaves fewer than 3 LONG candidates, while preserving the audit record", async () => {
    await withEnvAsync({ ...formationEnv, CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "1" }, async () => {
      const result = await runReliabilityFormation(reliabilitySnapshot([
        { symbol: "ETHUSDT", side: "LONG" }, { symbol: "SOLUSDT", side: "LONG" }, { symbol: "OPUSDT", side: "LONG" },
        { symbol: "BNBUSDT", side: "LONG" }, { symbol: "ADAUSDT", side: "LONG" }, { symbol: "SUIUSDT", side: "LONG" }, { symbol: "1000PEPEUSDT", side: "LONG" },
      ]), T0ms + 14 * DAY_MS);
      expect(result.store.all.some((row) => row.variant === "FILTERED")).toBe(false);
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]).toMatchObject({
        decision: "NO_TRADE_INSUFFICIENT_ELIGIBLE",
        selectedAfter: { LONG: [], SHORT: [] },
        scoreGapAfter: null,
      });
    });
  });

  it("holds a new FILTERED basket when reliability persistence is unavailable instead of treating it as insufficient evidence", async () => {
    await withEnvAsync({ ...formationEnv, CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "1" }, async () => {
      const snapshot = reliabilitySnapshot();
      snapshot.persistence = {
        status: "UNAVAILABLE",
        source: null,
        reason: "primary and backup ledger are invalid",
        recoveredAt: null,
      };
      const result = await runReliabilityFormation(snapshot, T0ms + 15 * DAY_MS);
      expect(result.store.all.some((row) => row.variant === "FILTERED")).toBe(false);
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]).toMatchObject({
        decision: "NO_TRADE_OTHER",
        persistence: { status: "UNAVAILABLE" },
        selectedAfter: { LONG: [], SHORT: [] },
      });
    });
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

  it("[AUTO-POOL-CEILING] uses a runtime C1/C2 list as a strict execution ceiling and preserves the manual short block", () => {
    withEnv({ CROSS_SECTIONAL_ADAPTIVE_DISABLED: "1" }, () => {
      const filters = getCrossSectionalFilteredExecutionFilters(freshStore(), {
        baseLongAllowlist: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        baseShortAllowlist: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        baseShortBlocklist: ["SOLUSDT"],
      });
      expect(filters.longAllowlist).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
      expect(filters.shortAllowlist).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
      expect(filters.shortBlocklist).toEqual(["SOLUSDT"]);
    });
  });

  it("[AUTO-POOL-VENUE] skips the unrelated spot candle-liquidity floor only after a valid USD-M pool is active", () => {
    expect(shouldApplyCandleLiquidityFloor(null)).toBe(true);
    expect(shouldApplyCandleLiquidityFloor({ enabled: true, state: "STALE_FALLBACK" } as never)).toBe(true);
    expect(shouldApplyCandleLiquidityFloor({ enabled: true, state: "ACTIVE" } as never)).toBe(false);
  });

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

  it("[SOFT-THEN-HARD] ignores pre-cutoff history, nudges rank first, then only hard-demotes after current-era proof", () => {
    const keys = [
      "CROSS_SECTIONAL_ADAPTIVE_MODE",
      "CROSS_SECTIONAL_ADAPTIVE_START_AT",
      "CROSS_SECTIONAL_ADAPTIVE_HARD_MIN_LEG_SAMPLES",
      "CROSS_SECTIONAL_ADAPTIVE_HARD_MIN_CLOSED_BASKETS",
      "CROSS_SECTIONAL_ADAPTIVE_SOFT_SCORE_WEIGHT",
    ] as const;
    const before = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      const cutoffMs = T0ms;
      Object.assign(process.env, {
        CROSS_SECTIONAL_ADAPTIVE_MODE: "SOFT_THEN_HARD",
        CROSS_SECTIONAL_ADAPTIVE_START_AT: new Date(cutoffMs).toISOString(),
        CROSS_SECTIONAL_ADAPTIVE_HARD_MIN_LEG_SAMPLES: "3",
        CROSS_SECTIONAL_ADAPTIVE_HARD_MIN_CLOSED_BASKETS: "8",
        CROSS_SECTIONAL_ADAPTIVE_SOFT_SCORE_WEIGHT: "0.35",
      });
      const store = freshStore();
      // Older bad history is deliberately outside the new evidence era.
      const old = closedObs("old", [], [["DOGEUSDT", 1, 1.05]]) as CrossSectionalObservation;
      old.openedAtMs = cutoffMs - 1;
      store.add(old);
      for (let i = 0; i < 3; i++) {
        const fresh = closedObs(`fresh-${i}`, [], [["DOGEUSDT", 1, 1.02]]) as CrossSectionalObservation;
        fresh.openedAtMs = cutoffMs + i + 1;
        store.add(fresh);
      }

      const soft = deriveAdaptiveSymbolFilters(store);
      expect(soft.provenance).toMatchObject({ closedBaskets: 3, mode: "SOFT_THEN_HARD", hardDemotionsActive: false, sinceMs: cutoffMs });
      expect(soft.provenance.demotedShort).toContain("DOGEUSDT");
      expect(soft.shortAllowlist).toContain("DOGEUSDT"); // still rankable in the soft phase
      expect(soft.shortScoreAdjustmentBySymbol.DOGEUSDT).toBeGreaterThan(0); // weaker short ranks less aggressively

      process.env.CROSS_SECTIONAL_ADAPTIVE_HARD_MIN_CLOSED_BASKETS = "3";
      const hard = deriveAdaptiveSymbolFilters(store);
      expect(hard.provenance.hardDemotionsActive).toBe(true);
      expect(hard.shortAllowlist).not.toContain("DOGEUSDT");
    } finally {
      for (const key of keys) {
        const value = before.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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


describe("nonOverlappingClosedSample — hourly opens, 48h holds", () => {
  const H = 48 * 3_600_000;
  const at = (hoursFromStart: number) => ({ openedAtMs: 1_000_000_000_000 + hoursFromStart * 3_600_000, horizonMs: H });

  it("keeps ONE sample per horizon when baskets open every hour", () => {
    // 96 hourly opens across 4 days. Naively that is 96 'trials'; only 2 of them
    // fail to share a holding period with a kept neighbour.
    const closed = Array.from({ length: 96 }, (_, i) => at(i));
    const kept = nonOverlappingClosedSample(closed);
    expect(kept.length).toBe(2);
    expect(kept[0]!.openedAtMs).toBe(at(0).openedAtMs);
    expect(kept[1]!.openedAtMs).toBe(at(48).openedAtMs);
  });

  it("never keeps two samples whose holding periods touch", () => {
    const closed = Array.from({ length: 200 }, (_, i) => at(i * 0.5));
    const kept = nonOverlappingClosedSample(closed);
    for (const [a, b] of kept.slice(0, -1).map((x, i) => [x, kept[i + 1]!] as const)) {
      expect(b.openedAtMs).toBeGreaterThanOrEqual(a.openedAtMs + a.horizonMs);
    }
  });

  it("does not depend on input order — it sorts by open time", () => {
    const forward = [at(0), at(1), at(48), at(49), at(96)];
    const shuffled = [at(49), at(96), at(0), at(48), at(1)];
    expect(nonOverlappingClosedSample(shuffled).map((o) => o.openedAtMs))
      .toEqual(nonOverlappingClosedSample(forward).map((o) => o.openedAtMs));
    expect(nonOverlappingClosedSample(forward).length).toBe(3);
  });

  it("returns every row when they already do not overlap, and handles 0/1 rows", () => {
    expect(nonOverlappingClosedSample([]).length).toBe(0);
    expect(nonOverlappingClosedSample([at(0)]).length).toBe(1);
    expect(nonOverlappingClosedSample([at(0), at(48), at(96)]).length).toBe(3);
  });
});

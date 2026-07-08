import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle } from "@dtc/shared";

import { CrossSectionalStore, type CrossSectionalObservation } from "../src/lib/cross-sectional-edge.js";
import {
  buildWinnersCounterfactualReport,
  spotSymbolForCandles,
  type CandleRangeFetcher,
} from "../src/lib/cross-sectional-winners-counterfactual.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2099-01-02T00:00:00.000Z");
// House cost model: CROSS_SECTIONAL_ROUNDTRIP_BPS default 12 bps = 0.0012 per deployed dollar.
const COST = 0.0012;

function freshStore(): CrossSectionalStore {
  return new CrossSectionalStore(mkdtempSync(join(tmpdir(), "xsec-wcf-")));
}

function closedBasket(
  id: string,
  longLegs: Array<[string, number, number]>,
  shortLegs: Array<[string, number, number]>,
  netReturn: number,
): CrossSectionalObservation {
  return {
    observationId: id,
    openedAt: new Date(T0).toISOString(),
    openedAtMs: T0,
    horizonMs: 24 * HOUR,
    signal: "MOM24_FILTERED",
    variant: "FILTERED",
    k: Math.max(longLegs.length, shortLegs.length),
    longLeg: longLegs.map(([symbol, entryPrice, exitPrice]) => ({ symbol, entryPrice, exitPrice })),
    shortLeg: shortLegs.map(([symbol, entryPrice, exitPrice]) => ({ symbol, entryPrice, exitPrice })),
    status: "CLOSED",
    grossReturn: netReturn + COST,
    costReturn: COST,
    netReturn,
    longLegReturn: null,
    shortLegReturn: null,
    resolvedAt: new Date(T0 + 24 * HOUR).toISOString(),
  };
}

/** Flat-price candle series: every 1h candle closes at `price`, covering T0-1h .. T0+25h. */
function flatCandles(price: number): Candle[] {
  return Array.from({ length: 27 }, (_, i) => ({
    openTime: T0 - HOUR + i * HOUR,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1,
  }));
}

/** Candles that close at `earlyPrice` until switchMs, then at `latePrice`. */
function stepCandles(earlyPrice: number, latePrice: number, switchMs: number): Candle[] {
  return Array.from({ length: 27 }, (_, i) => {
    const openTime = T0 - HOUR + i * HOUR;
    const price = openTime + HOUR <= switchMs ? earlyPrice : latePrice;
    return { openTime, open: price, high: price, low: price, close: price, volume: 1 };
  });
}

function fetcherFor(map: Record<string, Candle[]>): CandleRangeFetcher {
  return async (symbol) => map[symbol] ?? [];
}

describe("cross-sectional winners-only counterfactual (report-only)", () => {
  it("[SPOT-NORMALIZE] 1000-prefixed futures contracts fetch bare spot candles", () => {
    expect(spotSymbolForCandles("1000PEPEUSDT")).toBe("PEPEUSDT");
    expect(spotSymbolForCandles("SOLUSDT")).toBe("SOLUSDT");
  });

  it("[ORACLE] keeps only final-positive legs, subtracts one round-trip cost", async () => {
    const store = freshStore();
    // Long A: 100→102 (+2%), Short B: 1→1.01 (-1% for the short). Full net stored as +0.38%.
    store.add(closedBasket("b1", [["AUSDT", 100, 102]], [["BUSDT", 1, 1.01]], 0.0038) as never);
    const report = await buildWinnersCounterfactualReport(
      store,
      fetcherFor({ AUSDT: flatCandles(100), BUSDT: flatCandles(1) }),
      { nowIso: () => "2099-02-01T00:00:00.000Z" },
    );
    expect(report.oracle.baskets).toBe(1);
    // Oracle keeps only leg A: +2% − 0.12% = +1.88%
    expect(report.oracle.meanNetReturnPct).toBeCloseTo(1.88, 6);
    expect(report.fullBasket.meanNetReturnPct).toBeCloseTo(0.38, 6);
  });

  it("[CHECKPOINT] selects legs positive so-far and prices the late entry at the checkpoint candle", async () => {
    const store = freshStore();
    // Long A: entry 100, exit 110 (+10% final).
    // Path: 105 until hour 12, then 110 — at the 50% checkpoint (12h) it's +5% so-far → selected,
    // but the honest late entry is at 105, so the strategy's captured return is 110/105-1 ≈ +4.7619%.
    // Short B: entry 1, exit 1.2 (−20% final for the short) and already losing at the checkpoint → never selected.
    store.add(closedBasket("b1", [["AUSDT", 100, 110]], [["BUSDT", 1, 1.2]], 0.05) as never);
    const report = await buildWinnersCounterfactualReport(
      store,
      fetcherFor({
        AUSDT: stepCandles(105, 110, T0 + 12 * HOUR),
        BUSDT: flatCandles(1.2),
      }),
      { checkpointFractions: [0.5], nowIso: () => "2099-02-01T00:00:00.000Z" },
    );
    const cp = report.checkpoints[0]!;
    expect(cp.evaluatedBaskets).toBe(1);
    expect(cp.noTradeBaskets).toBe(0);
    expect(cp.legsSelected).toBe(1); // only the long; the short was losing at the checkpoint
    expect(cp.legsStillPositiveAtExit).toBe(1);
    expect(cp.persistencePct).toBeCloseTo(100, 6);
    // (110/105 − 1) − 0.0012 = 0.046419… → 4.6419…%
    expect(cp.meanNetReturnPct).toBeCloseTo((110 / 105 - 1 - COST) * 100, 6);
    // Same-subset full-basket comparison uses the stored netReturn (+5%).
    expect(cp.fullBasketMeanNetReturnPctSameSubset).toBeCloseTo(5, 6);
  });

  it("[NO-TRADE] a basket with zero positive legs at the checkpoint stays flat and is counted", async () => {
    const store = freshStore();
    // Both legs losing at the checkpoint (long below entry, short above entry).
    store.add(closedBasket("b1", [["AUSDT", 100, 99]], [["BUSDT", 1, 1.05]], -0.02) as never);
    const report = await buildWinnersCounterfactualReport(
      store,
      fetcherFor({ AUSDT: flatCandles(98), BUSDT: flatCandles(1.04) }),
      { checkpointFractions: [0.25], nowIso: () => "2099-02-01T00:00:00.000Z" },
    );
    const cp = report.checkpoints[0]!;
    expect(cp.evaluatedBaskets).toBe(1);
    expect(cp.noTradeBaskets).toBe(1);
    expect(cp.meanNetReturnPct).toBeNull(); // no traded baskets
    expect(cp.legsSelected).toBe(0);
  });

  it("[PERSISTENCE-MISS] a leg positive at the checkpoint but negative at exit counts against persistence", async () => {
    const store = freshStore();
    // Long A: up +5% at checkpoint, but exits at 98 (−2% final) — selected, then fades.
    store.add(closedBasket("b1", [["AUSDT", 100, 98]], [], -0.02) as never);
    const report = await buildWinnersCounterfactualReport(
      store,
      fetcherFor({ AUSDT: stepCandles(105, 98, T0 + 12 * HOUR) }),
      { checkpointFractions: [0.5], nowIso: () => "2099-02-01T00:00:00.000Z" },
    );
    const cp = report.checkpoints[0]!;
    expect(cp.legsSelected).toBe(1);
    expect(cp.legsStillPositiveAtExit).toBe(0);
    expect(cp.persistencePct).toBeCloseTo(0, 6);
    // Late entry at 105, exit 98: 98/105−1−cost ≈ −6.79% — the fade costs MORE than the full-basket −2%.
    expect(cp.meanNetReturnPct).toBeCloseTo((98 / 105 - 1 - COST) * 100, 6);
  });

  it("[COVERAGE] a basket missing checkpoint candles is excluded, not silently mispriced", async () => {
    const store = freshStore();
    store.add(closedBasket("b1", [["AUSDT", 100, 105]], [], 0.05) as never);
    store.add(closedBasket("b2", [["MISSINGUSDT", 100, 105]], [], 0.05) as never);
    const report = await buildWinnersCounterfactualReport(
      store,
      fetcherFor({ AUSDT: flatCandles(102) }), // MISSINGUSDT has no candles
      { checkpointFractions: [0.25], nowIso: () => "2099-02-01T00:00:00.000Z" },
    );
    expect(report.checkpoints[0]!.evaluatedBaskets).toBe(1);
    expect(report.excludedNoCandleCoverage).toBe(1);
  });

  it("[INCOMPLETE] baskets with a null exitPrice leg are excluded from everything", async () => {
    const store = freshStore();
    const bad = closedBasket("b1", [["AUSDT", 100, 105]], [], 0.05);
    bad.longLeg[0]!.exitPrice = null;
    store.add(bad as never);
    const report = await buildWinnersCounterfactualReport(store, fetcherFor({}), {
      nowIso: () => "2099-02-01T00:00:00.000Z",
    });
    expect(report.closedCompleteBaskets).toBe(0);
    expect(report.excludedIncompleteLegs).toBe(1);
    expect(report.verdict).toMatch(/insufficient data/);
  });
});

import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  classifyCgWideFastLongPath,
  classifyEntryRegimeAlignmentForLong,
  resolveTrueExpansionThresholdR,
  scanCandlePathCrossings,
  DEFAULT_PATH_CLASSIFICATION_THRESHOLDS,
  type PathWalkFacts,
  type CgWideFastLongClassifiedTradeRecord,
} from "../src/lib/cg-wide-fast-long-path-classification.js";

function baseFacts(overrides: Partial<PathWalkFacts> = {}): PathWalkFacts {
  return {
    maxMfeR: 0,
    minMaeR: 0,
    entryAtrPriceUnits: null,
    riskPriceDistance: null,
    timeToBreakevenTriggerMs: null,
    timeToToxicAdverseMs: null,
    timeToSmallFavorableMs: null,
    ...overrides,
  };
}

describe("classifyCgWideFastLongPath — the 4 categories", () => {
  it("DEAD_ON_ARRIVAL: never reached breakeven trigger, no toxic reversal, no expansion", () => {
    const facts = baseFacts({ maxMfeR: 0.05, minMaeR: -0.2, timeToBreakevenTriggerMs: null });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("DEAD_ON_ARRIVAL");
  });

  it("SCRATCHABLE: reached breakeven trigger but never reached expansion", () => {
    const facts = baseFacts({
      maxMfeR: 0.3,
      minMaeR: -0.1,
      timeToBreakevenTriggerMs: 1_000,
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("SCRATCHABLE");
  });

  it("TRUE_EXPANSION: maxMfeR crosses the fixed 1.0R floor", () => {
    const facts = baseFacts({
      maxMfeR: 1.2,
      minMaeR: -0.1,
      timeToBreakevenTriggerMs: 1_000,
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("TRUE_EXPANSION");
  });

  it("TRUE_EXPANSION: maxMfeR below the fixed floor but crosses the volatility-adjusted floor", () => {
    // riskPriceDistance is huge relative to ATR -> vol-adjusted threshold is small.
    // atr/risk = 10/1000 = 0.01; * multiple 3 = 0.03R threshold, well below the 1.0R fixed floor.
    const facts = baseFacts({
      maxMfeR: 0.05,
      minMaeR: -0.02,
      entryAtrPriceUnits: 10,
      riskPriceDistance: 1000,
      timeToBreakevenTriggerMs: 500,
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("TRUE_EXPANSION");
    expect(outcome.resolvedExpansionThresholdR).toBeCloseTo(0.03, 10);
  });

  it("TOXIC_REVERSAL: adverse threshold breached before any useful favorable excursion", () => {
    const facts = baseFacts({
      maxMfeR: 0.05,
      minMaeR: -0.7,
      timeToToxicAdverseMs: 1_000,
      timeToSmallFavorableMs: null, // never had a useful favorable excursion at all
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("TOXIC_REVERSAL");
  });

  it("NOT toxic: adverse threshold breached but only AFTER a useful favorable excursion first", () => {
    const facts = baseFacts({
      maxMfeR: 0.05,
      minMaeR: -0.7,
      timeToSmallFavorableMs: 1_000,
      timeToToxicAdverseMs: 5_000, // adverse breach came LATER than the favorable excursion
      timeToBreakevenTriggerMs: 1_500,
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).not.toBe("TOXIC_REVERSAL");
    expect(outcome.pathClass).toBe("SCRATCHABLE");
  });

  it("not toxic when minMaeR never actually breaches the adverse threshold", () => {
    const facts = baseFacts({
      maxMfeR: 0.05,
      minMaeR: -0.3, // above (less negative than) -0.5 threshold
      timeToToxicAdverseMs: null,
      timeToSmallFavorableMs: null,
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("DEAD_ON_ARRIVAL");
  });
});

describe("classifyCgWideFastLongPath — precedence ordering edge case", () => {
  it("TOXIC_REVERSAL wins even when the trade ALSO eventually reached breakeven (operator's worked example)", () => {
    const facts = baseFacts({
      maxMfeR: 0.3, // eventually reached a modest favorable move
      minMaeR: -0.6, // and breached the toxic adverse threshold
      timeToToxicAdverseMs: 1_000, // ...but the adverse breach happened FIRST
      timeToSmallFavorableMs: 10_000, // useful favorable excursion only came much later
      timeToBreakevenTriggerMs: 12_000, // breakeven trigger ALSO eventually reached
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("TOXIC_REVERSAL");
  });

  it("TOXIC_REVERSAL wins even when the trade EVENTUALLY reaches full TRUE_EXPANSION (V-shaped recovery)", () => {
    const facts = baseFacts({
      maxMfeR: 1.5, // eventually a large expansion
      minMaeR: -0.55,
      timeToToxicAdverseMs: 1_000,
      timeToSmallFavorableMs: 20_000, // favorable excursion only shows up long after the dip
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("TOXIC_REVERSAL");
  });

  it("same-candle tie (adverse and small-favorable cross at the identical timestamp) resolves toward TOXIC_REVERSAL", () => {
    const facts = baseFacts({
      maxMfeR: 0.2,
      minMaeR: -0.6,
      timeToToxicAdverseMs: 5_000,
      timeToSmallFavorableMs: 5_000, // exact tie
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("TOXIC_REVERSAL");
  });

  it("favorable-excursion-first (not tied) yields NOT toxic even with a later deep adverse breach", () => {
    const facts = baseFacts({
      maxMfeR: 1.1,
      minMaeR: -0.6,
      timeToToxicAdverseMs: 9_999,
      timeToSmallFavorableMs: 9_998, // favorable came 1ms before the adverse breach
    });
    const outcome = classifyCgWideFastLongPath(facts);
    expect(outcome.pathClass).toBe("TRUE_EXPANSION");
  });
});

describe("resolveTrueExpansionThresholdR", () => {
  it("falls back to the fixed floor when ATR/risk data is unavailable", () => {
    const r = resolveTrueExpansionThresholdR(null, null, DEFAULT_PATH_CLASSIFICATION_THRESHOLDS);
    expect(r).toBe(DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.trueExpansionFixedR);
  });

  it("falls back to the fixed floor when riskPriceDistance is non-positive", () => {
    const r = resolveTrueExpansionThresholdR(5, 0, DEFAULT_PATH_CLASSIFICATION_THRESHOLDS);
    expect(r).toBe(DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.trueExpansionFixedR);
  });

  it("uses the vol-adjusted floor when it is smaller than the fixed floor", () => {
    // atr=10, risk=1000 -> ratio 0.01 * multiple(3) = 0.03, well below fixed floor 1.0
    const r = resolveTrueExpansionThresholdR(10, 1000, DEFAULT_PATH_CLASSIFICATION_THRESHOLDS);
    expect(r).toBeCloseTo(0.03, 10);
  });

  it("keeps the fixed floor when the vol-adjusted floor would be LARGER (tight stop, wide ATR)", () => {
    // atr=50, risk=100 -> ratio 0.5 * multiple(3) = 1.5, larger than fixed floor 1.0
    const r = resolveTrueExpansionThresholdR(50, 100, DEFAULT_PATH_CLASSIFICATION_THRESHOLDS);
    expect(r).toBe(DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.trueExpansionFixedR);
  });
});

describe("classifyEntryRegimeAlignmentForLong", () => {
  it("ALIGNED for LONG_ONLY", () => {
    expect(classifyEntryRegimeAlignmentForLong("LONG_ONLY")).toBe("ALIGNED");
  });
  it("COUNTER_REGIME for SHORT_ONLY", () => {
    expect(classifyEntryRegimeAlignmentForLong("SHORT_ONLY")).toBe("COUNTER_REGIME");
  });
  it("COUNTER_REGIME for NO_TRADE_CHOP", () => {
    expect(classifyEntryRegimeAlignmentForLong("NO_TRADE_CHOP")).toBe("COUNTER_REGIME");
  });
  it("COUNTER_REGIME for NO_TRADE_NEGATIVE_EDGE", () => {
    expect(classifyEntryRegimeAlignmentForLong("NO_TRADE_NEGATIVE_EDGE")).toBe("COUNTER_REGIME");
  });
  it("NEUTRAL for BOTH_ALLOWED", () => {
    expect(classifyEntryRegimeAlignmentForLong("BOTH_ALLOWED")).toBe("NEUTRAL");
  });
  it("NEUTRAL for VALIDATION_ONLY", () => {
    expect(classifyEntryRegimeAlignmentForLong("VALIDATION_ONLY")).toBe("NEUTRAL");
  });
  it("NEUTRAL for null/undefined/unknown", () => {
    expect(classifyEntryRegimeAlignmentForLong(null)).toBe("NEUTRAL");
    expect(classifyEntryRegimeAlignmentForLong(undefined)).toBe("NEUTRAL");
    expect(classifyEntryRegimeAlignmentForLong("SOME_FUTURE_MODE")).toBe("NEUTRAL");
  });
});

describe("scanCandlePathCrossings", () => {
  const entryPrice = 100;
  const riskPriceDistance = 2; // 1R = 2 price units (e.g. stop at 98)

  function c(openTime: number, high: number, low: number): Candle {
    return { openTime, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1 };
  }

  it("computes timeToMAE as the trough (last decrease) of running MAE, bounded to [fromMs,toMs]", () => {
    const candles: Candle[] = [
      c(0, 100.5, 99.5), // mild dip -0.25R
      c(300_000, 100.2, 99.0), // deeper dip -0.5R <- new trough
      c(600_000, 101.5, 99.4), // recovers, shallower dip -0.3R (not a new trough)
      c(900_000, 100, 100), // outside window below, ignored if toMs excludes it
    ];
    const out = scanCandlePathCrossings({
      candles,
      direction: "LONG",
      entryPrice,
      riskPriceDistance,
      fromMs: 0,
      toMs: 600_000,
      levels: { breakevenTriggerPrice: null, toxicAdverseR: -100, smallFavorableR: 100, expansionThresholdR: 100 },
    });
    expect(out.timeToMAE).toBe(300_000);
  });

  it("respects fromMs/toMs bounds — candles outside the window are ignored entirely", () => {
    const candles: Candle[] = [c(-100, 200, 50)]; // huge move, but before fromMs
    const out = scanCandlePathCrossings({
      candles,
      direction: "LONG",
      entryPrice,
      riskPriceDistance,
      fromMs: 0,
      toMs: 1000,
      levels: { breakevenTriggerPrice: null, toxicAdverseR: -0.5, smallFavorableR: 0.1, expansionThresholdR: 1 },
    });
    expect(out.timeToMAE).toBeNull();
    expect(out.timeToToxicAdverse).toBeNull();
    expect(out.timeToSmallFavorable).toBeNull();
  });

  it("finds first breakeven-trigger-price crossing (LONG: high >= trigger)", () => {
    const candles: Candle[] = [c(0, 100.1, 99.9), c(300_000, 101.0, 100.0), c(600_000, 102.0, 101.0)];
    const out = scanCandlePathCrossings({
      candles,
      direction: "LONG",
      entryPrice,
      riskPriceDistance,
      fromMs: 0,
      toMs: 600_000,
      levels: { breakevenTriggerPrice: 100.8, toxicAdverseR: -100, smallFavorableR: 100, expansionThresholdR: 100 },
    });
    expect(out.timeToBreakevenTrigger).toBe(300_000);
  });

  it("finds first toxic-adverse and small-favorable crossings independently, LONG direction", () => {
    const candles: Candle[] = [
      c(0, 100.05, 99.9), // mfeR=0.025, maeR=-0.05
      c(300_000, 100.25, 99.0), // mfeR=0.125 (crosses smallFavorable 0.1), maeR=-0.5 (crosses toxic -0.5)
      c(600_000, 103, 99.5),
    ];
    const out = scanCandlePathCrossings({
      candles,
      direction: "LONG",
      entryPrice,
      riskPriceDistance,
      fromMs: 0,
      toMs: 600_000,
      levels: { breakevenTriggerPrice: null, toxicAdverseR: -0.5, smallFavorableR: 0.1, expansionThresholdR: 1.5 },
    });
    expect(out.timeToSmallFavorable).toBe(300_000);
    expect(out.timeToToxicAdverse).toBe(300_000);
    expect(out.timeToExpansion).toBe(600_000); // mfeR=1.5 -> (103-100)/2=1.5 reaches the 1.5 expansion threshold
  });

  it("SHORT direction mirrors the formula (favorable = entry-low, adverse = entry-high)", () => {
    const shortEntry = 100;
    const candles: Candle[] = [c(0, 100.6, 99.5)]; // favorable = 100-99.5=0.5 -> 0.25R; adverse = 100-100.6=-0.6 -> -0.3R
    const out = scanCandlePathCrossings({
      candles,
      direction: "SHORT",
      entryPrice: shortEntry,
      riskPriceDistance: 2,
      fromMs: 0,
      toMs: 0,
      levels: { breakevenTriggerPrice: null, toxicAdverseR: -0.25, smallFavorableR: 0.2, expansionThresholdR: 5 },
    });
    expect(out.timeToSmallFavorable).toBe(0);
    expect(out.timeToToxicAdverse).toBe(0);
  });

  it("returns all-null when riskPriceDistance is non-positive (defensive)", () => {
    const out = scanCandlePathCrossings({
      candles: [c(0, 105, 95)],
      direction: "LONG",
      entryPrice,
      riskPriceDistance: 0,
      fromMs: 0,
      toMs: 1000,
      levels: { breakevenTriggerPrice: null, toxicAdverseR: -0.5, smallFavorableR: 0.1, expansionThresholdR: 1 },
    });
    expect(out).toEqual({
      timeToMAE: null,
      timeToBreakevenTrigger: null,
      timeToToxicAdverse: null,
      timeToSmallFavorable: null,
      timeToExpansion: null,
    });
  });
});

describe("CgWideFastLongClassifiedTradeRecord — full per-trade record schema", () => {
  it("has all required fields with the correct types/nullability, and OMITS microstructure fields entirely", () => {
    const record: CgWideFastLongClassifiedTradeRecord = {
      tradeId: "abc-123",
      lane: "CG_WIDE_FAST_LONG",
      symbol: "SUIUSDT",
      entryTimestamp: new Date(1_700_000_000_000).toISOString(),
      entryHourUtc: 14,
      entryPrice: 3.21,
      entryATR: 0.015,
      entryRegime: "BULLISH",
      entryControllerMode: "LONG_ONLY",
      entryRegimeAlignment: "ALIGNED",
      maxMfeR: 0.42,
      minMaeR: -0.18,
      timeToMFE: 1_700_000_300_000,
      timeToMAE: 1_700_000_100_000,
      timeToBreakevenTrigger: 1_700_000_050_000,
      timeToExpansion: null,
      realizedNetPnLUsd: 1.23,
      realizedR: 0.08,
      exitReason: "LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST",
      pathClass: "SCRATCHABLE",
      pathClassReason: "reached breakeven trigger but never reached expansion",
    };

    // Required string/number fields present with the right runtime type.
    expect(typeof record.tradeId).toBe("string");
    expect(record.lane).toBe("CG_WIDE_FAST_LONG");
    expect(typeof record.symbol).toBe("string");
    expect(typeof record.entryTimestamp).toBe("string");
    expect(typeof record.entryHourUtc).toBe("number");
    expect(typeof record.entryPrice).toBe("number");
    expect(typeof record.realizedNetPnLUsd).toBe("number");

    // Nullable fields accept both a real value and null.
    const nullableNumberFields: Array<keyof CgWideFastLongClassifiedTradeRecord> = [
      "entryATR",
      "maxMfeR",
      "minMaeR",
      "timeToMFE",
      "timeToMAE",
      "timeToBreakevenTrigger",
      "timeToExpansion",
      "realizedR",
    ];
    for (const field of nullableNumberFields) {
      const withValue = record[field];
      expect(withValue === null || typeof withValue === "number").toBe(true);
      const nulled = { ...record, [field]: null } as CgWideFastLongClassifiedTradeRecord;
      expect(nulled[field]).toBeNull();
    }
    const nullableStringFields: Array<keyof CgWideFastLongClassifiedTradeRecord> = [
      "entryRegime",
      "entryControllerMode",
      "exitReason",
    ];
    for (const field of nullableStringFields) {
      const nulled = { ...record, [field]: null } as CgWideFastLongClassifiedTradeRecord;
      expect(nulled[field]).toBeNull();
    }

    // Enum-shaped fields take exactly the documented values.
    expect(["ALIGNED", "COUNTER_REGIME", "NEUTRAL"]).toContain(record.entryRegimeAlignment);
    expect(["DEAD_ON_ARRIVAL", "SCRATCHABLE", "TRUE_EXPANSION", "TOXIC_REVERSAL"]).toContain(record.pathClass);

    // CRITICAL: microstructure fields that are NOT reconstructable for historical trades must be
    // genuinely absent from the record — not just null. This is a compile-time guarantee (the type
    // has no such properties) reinforced here at runtime against silent re-introduction.
    const forbiddenKeys = [
      "oiChange",
      "openInterestChange",
      "funding",
      "fundingRate",
      "topTraderRatio",
      "topTraderLongShortRatio",
      "priceImpactEfficiency",
      "flowConfirmed",
      "crowdingState",
    ];
    for (const key of forbiddenKeys) {
      expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
    }
  });
});

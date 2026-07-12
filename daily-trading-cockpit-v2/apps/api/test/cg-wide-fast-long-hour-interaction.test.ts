import { describe, expect, it } from "vitest";
import {
  assignVolatilityStateTerciles,
  btcDirectionOf,
  buildHourComparisonReport,
  computeGroupMetrics,
  computeHourlyMetrics,
  computeInteractionTable,
  dominantKeyShare,
  hourXCluster,
  hourXSymbol,
  type HourInteractionTradeFacts,
} from "../src/lib/cg-wide-fast-long-hour-interaction.js";

function trade(overrides: Partial<HourInteractionTradeFacts> & { tradeId: string }): HourInteractionTradeFacts {
  return {
    symbol: "SOLUSDT",
    cluster: "L1",
    entryHourUtc: 4,
    entryRegimeAlignment: "NEUTRAL",
    pathClass: "DEAD_ON_ARRIVAL",
    realizedNetPnLUsd: 0,
    realizedR: null,
    maxMfeR: null,
    minMaeR: null,
    feesUsd: null,
    atrPct: null,
    volatilityState: null,
    btcMovePct: null,
    btcDirection: null,
    ...overrides,
  };
}

describe("assignVolatilityStateTerciles", () => {
  it("splits a known 6-value sample into hand-computed LOW/MEDIUM/HIGH terciles", () => {
    // sorted = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]
    // p33 (idx = 1/3*5 = 1.667, interpolate between sorted[1]=0.02 and sorted[2]=0.03, frac=0.667):
    //   0.02*(1-0.667) + 0.03*0.667 = 0.02*0.333 + 0.03*0.667 = 0.006667 + 0.02 = 0.026667
    // p67 (idx = 2/3*5 = 3.333, interpolate between sorted[3]=0.04 and sorted[4]=0.05, frac=0.333):
    //   0.04*0.667 + 0.05*0.333 = 0.026667 + 0.016667 = 0.043333
    // buckets: 0.01,0.02 <= 0.026667 -> LOW; 0.03,0.04 <= 0.043333 -> MEDIUM; 0.05,0.06 -> HIGH
    const result = assignVolatilityStateTerciles([0.01, 0.02, 0.03, 0.04, 0.05, 0.06]);
    expect(result).toEqual(["LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH"]);
  });

  it("passes null through unchanged and excludes nulls from the percentile computation", () => {
    const result = assignVolatilityStateTerciles([0.01, null, 0.02, 0.03, 0.04, 0.05, 0.06]);
    expect(result).toEqual(["LOW", null, "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH"]);
  });

  it("labels every non-null value MEDIUM when fewer than 2 non-null values exist (degenerate case)", () => {
    expect(assignVolatilityStateTerciles([0.05])).toEqual(["MEDIUM"]);
    expect(assignVolatilityStateTerciles([null, null])).toEqual([null, null]);
    expect(assignVolatilityStateTerciles([])).toEqual([]);
  });
});

describe("btcDirectionOf", () => {
  it("maps sign of the move to UP/DOWN/FLAT, and null through null", () => {
    expect(btcDirectionOf(1.5)).toBe("UP");
    expect(btcDirectionOf(-0.3)).toBe("DOWN");
    expect(btcDirectionOf(0)).toBe("FLAT");
    expect(btcDirectionOf(null)).toBeNull();
    expect(btcDirectionOf(Number.NaN)).toBeNull();
  });
});

describe("computeGroupMetrics", () => {
  it("computes n/netPnL/avgNetR/medianNetR/payoff/profitFactor on a hand-computed 5-trade sample", () => {
    // Wins: +10 (R=1.0), +6 (R=0.6)   Losses: -4 (R=-0.5), -2 (R=-0.25)   Scratch: 0 (R=0)
    const records = [
      trade({ tradeId: "1", realizedNetPnLUsd: 10, realizedR: 1.0, pathClass: "TRUE_EXPANSION" }),
      trade({ tradeId: "2", realizedNetPnLUsd: 6, realizedR: 0.6, pathClass: "TRUE_EXPANSION" }),
      trade({ tradeId: "3", realizedNetPnLUsd: -4, realizedR: -0.5, pathClass: "TOXIC_REVERSAL" }),
      trade({ tradeId: "4", realizedNetPnLUsd: -2, realizedR: -0.25, pathClass: "SCRATCHABLE" }),
      trade({ tradeId: "5", realizedNetPnLUsd: 0, realizedR: 0, pathClass: "DEAD_ON_ARRIVAL" }),
    ];
    const m = computeGroupMetrics(records);
    expect(m.n).toBe(5);
    expect(m.netPnLUsd).toBeCloseTo(10 + 6 - 4 - 2 + 0, 10);
    // netR values sorted: [-0.5, -0.25, 0, 0.6, 1.0] -> median = 0
    expect(m.medianNetR).toBeCloseTo(0, 10);
    // avg = (1.0 + 0.6 - 0.5 - 0.25 + 0) / 5 = 0.85/5 = 0.17
    expect(m.avgNetR).toBeCloseTo(0.17, 10);
    expect(m.nWithRealizedR).toBe(5);
    // avgWinUsd = (10+6)/2 = 8, avgLossUsd = (-4-2)/2 = -3 -> payoff = 8/3
    expect(m.payoffRatioUsd).toBeCloseTo(8 / 3, 10);
    // profitFactor = sum(wins)/|sum(losses)| = 16/6
    expect(m.profitFactorUsd).toBeCloseTo(16 / 6, 10);
    expect(m.trueExpansionRate).toBeCloseTo(2 / 5, 10);
    expect(m.scratchRate).toBeCloseTo(1 / 5, 10);
    expect(m.toxicReversalRate).toBeCloseTo(1 / 5, 10);
    expect(m.deadOnArrivalRate).toBeCloseTo(1 / 5, 10);
  });

  it("returns null profitFactor/payoffRatio when there are no losses, never 0 or Infinity", () => {
    const records = [
      trade({ tradeId: "1", realizedNetPnLUsd: 5, realizedR: 0.5 }),
      trade({ tradeId: "2", realizedNetPnLUsd: 3, realizedR: 0.3 }),
    ];
    const m = computeGroupMetrics(records);
    expect(m.profitFactorUsd).toBeNull();
    expect(m.payoffRatioUsd).toBeNull();
  });

  it("returns all-null/zero metrics for an empty group without throwing", () => {
    const m = computeGroupMetrics([]);
    expect(m.n).toBe(0);
    expect(m.netPnLUsd).toBe(0);
    expect(m.avgNetR).toBeNull();
    expect(m.medianNetR).toBeNull();
    expect(m.profitFactorUsd).toBeNull();
    expect(m.trueExpansionRate).toBe(0);
  });

  it("computes avgFeesUsd only over trades with known feesUsd, reporting nWithFeeData honestly", () => {
    const records = [
      trade({ tradeId: "1", feesUsd: 0.5 }),
      trade({ tradeId: "2", feesUsd: null }),
      trade({ tradeId: "3", feesUsd: 1.5 }),
    ];
    const m = computeGroupMetrics(records);
    expect(m.nWithFeeData).toBe(2);
    expect(m.avgFeesUsd).toBeCloseTo(1.0, 10);
  });

  it("tallies btcDirectionCounts including UNKNOWN for null direction", () => {
    const records = [
      trade({ tradeId: "1", btcDirection: "UP" }),
      trade({ tradeId: "2", btcDirection: "UP" }),
      trade({ tradeId: "3", btcDirection: "DOWN" }),
      trade({ tradeId: "4", btcDirection: null }),
    ];
    const m = computeGroupMetrics(records);
    expect(m.btcDirectionCounts).toEqual({ UP: 2, DOWN: 1, FLAT: 0, UNKNOWN: 1 });
  });
});

describe("computeHourlyMetrics", () => {
  it("buckets by entryHourUtc, only including hours actually present, sorted ascending", () => {
    const records = [
      trade({ tradeId: "1", entryHourUtc: 16, realizedNetPnLUsd: 2 }),
      trade({ tradeId: "2", entryHourUtc: 4, realizedNetPnLUsd: -3 }),
      trade({ tradeId: "3", entryHourUtc: 4, realizedNetPnLUsd: -1 }),
      trade({ tradeId: "4", entryHourUtc: 9, realizedNetPnLUsd: 5 }),
    ];
    const rows = computeHourlyMetrics(records);
    expect(rows.map((r) => r.hourUtc)).toEqual([4, 9, 16]);
    const hour4 = rows.find((r) => r.hourUtc === 4)!;
    expect(hour4.n).toBe(2);
    expect(hour4.netPnLUsd).toBeCloseTo(-4, 10);
    // hour 5, 6, ... etc are simply absent, not fabricated zero rows
    expect(rows.some((r) => r.hourUtc === 5)).toBe(false);
  });
});

describe("computeInteractionTable / hourXSymbol / hourXCluster", () => {
  it("builds hour -> subgroup -> metrics, bucketing null subgroup keys under UNKNOWN", () => {
    const records = [
      trade({ tradeId: "1", entryHourUtc: 4, symbol: "SOLUSDT", cluster: "L1", realizedNetPnLUsd: -3 }),
      trade({ tradeId: "2", entryHourUtc: 4, symbol: "SOLUSDT", cluster: "L1", realizedNetPnLUsd: -1 }),
      trade({ tradeId: "3", entryHourUtc: 4, symbol: "1000PEPEUSDT", cluster: "MEME", realizedNetPnLUsd: 2 }),
    ];
    const bySymbol = hourXSymbol(records);
    const hour4 = bySymbol.get(4)!;
    expect(hour4.get("SOLUSDT")!.n).toBe(2);
    expect(hour4.get("SOLUSDT")!.netPnLUsd).toBeCloseTo(-4, 10);
    expect(hour4.get("1000PEPEUSDT")!.n).toBe(1);

    const byCluster = hourXCluster(records);
    expect(byCluster.get(4)!.get("L1")!.n).toBe(2);
    expect(byCluster.get(4)!.get("MEME")!.n).toBe(1);
  });

  it("buckets a null subgroup key (e.g. unresolved volatilityState) under UNKNOWN", () => {
    const records = [
      trade({ tradeId: "1", entryHourUtc: 4, volatilityState: "HIGH" }),
      trade({ tradeId: "2", entryHourUtc: 4, volatilityState: null }),
    ];
    const table = computeInteractionTable(records, (r) => r.volatilityState);
    const hour4 = table.get(4)!;
    expect(hour4.get("HIGH")!.n).toBe(1);
    expect(hour4.get("UNKNOWN")!.n).toBe(1);
  });
});

describe("dominantKeyShare", () => {
  it("identifies the symbol accounting for the largest share of a group's trades", () => {
    const records = [
      trade({ tradeId: "1", symbol: "SOLUSDT" }),
      trade({ tradeId: "2", symbol: "SOLUSDT" }),
      trade({ tradeId: "3", symbol: "SOLUSDT" }),
      trade({ tradeId: "4", symbol: "ADAUSDT" }),
    ];
    const dominant = dominantKeyShare(records, (r) => r.symbol);
    expect(dominant).toEqual({ key: "SOLUSDT", n: 3, share: 0.75 });
  });

  it("returns null for an empty group", () => {
    expect(dominantKeyShare([], (r) => r.symbol)).toBeNull();
  });
});

describe("buildHourComparisonReport", () => {
  it("groups 04h / 16h+17h / other-combined exactly per the operator brief's ask, hand-computed", () => {
    const records = [
      // 04h: 2 trades, both losing, both SOLUSDT (dominant symbol check)
      trade({ tradeId: "a", entryHourUtc: 4, symbol: "SOLUSDT", realizedNetPnLUsd: -2, realizedR: -0.4 }),
      trade({ tradeId: "b", entryHourUtc: 4, symbol: "SOLUSDT", realizedNetPnLUsd: -1, realizedR: -0.2 }),
      // 16h + 17h combined: 2 winning trades across two different symbols
      trade({ tradeId: "c", entryHourUtc: 16, symbol: "ADAUSDT", realizedNetPnLUsd: 3, realizedR: 0.5 }),
      trade({ tradeId: "d", entryHourUtc: 17, symbol: "AVAXUSDT", realizedNetPnLUsd: 2, realizedR: 0.3 }),
      // other hours: 1 trade
      trade({ tradeId: "e", entryHourUtc: 9, symbol: "SUIUSDT", realizedNetPnLUsd: 1, realizedR: 0.1 }),
    ];
    const groups = buildHourComparisonReport(records, [
      { label: "04h", hours: [4] },
      { label: "16h+17h", hours: [16, 17] },
      { label: "other", hours: [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23] },
    ]);
    const g04 = groups.find((g) => g.label === "04h")!;
    expect(g04.metrics.n).toBe(2);
    expect(g04.metrics.netPnLUsd).toBeCloseTo(-3, 10);
    expect(g04.dominantSymbol).toEqual({ key: "SOLUSDT", n: 2, share: 1 });

    const gCombined = groups.find((g) => g.label === "16h+17h")!;
    expect(gCombined.metrics.n).toBe(2);
    expect(gCombined.metrics.netPnLUsd).toBeCloseTo(5, 10);
    // two different symbols, neither dominant beyond 50%
    expect(gCombined.dominantSymbol!.share).toBeCloseTo(0.5, 10);

    const gOther = groups.find((g) => g.label === "other")!;
    expect(gOther.metrics.n).toBe(1);
  });

  it("handles an hour group with zero matching trades without throwing", () => {
    const records = [trade({ tradeId: "a", entryHourUtc: 9 })];
    const groups = buildHourComparisonReport(records, [{ label: "04h", hours: [4] }]);
    expect(groups[0]!.metrics.n).toBe(0);
    expect(groups[0]!.dominantSymbol).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  advanceNetProfitFloor,
  advanceRelativeDeterioration,
  createCrossProfitProtectionState,
  estimateNetLiquidation,
  relativeSpread,
  selectPreferredCombination,
  midsFromQuotes,
  recordMidSample,
  spreadOverWindow,
  type BookQuote,
  type CombinationCandidate,
  type SideCandidate,
  type SpreadLeg,
  type SpreadSample,
} from "../src/lib/cross-profit-protection-v1.js";

const leg = (symbol: string, mom36Rank: number, returns: Record<string, number | null>): SideCandidate =>
  ({ symbol, mom36Rank, weight: 1 / 6, returns });

const combo = (longs: SideCandidate[], shorts: SideCandidate[]): CombinationCandidate => ({ longs, shorts });

const flat = { "1h": 0.0, "4h": 0.0, "15m": 0.0, "30m": 0.0 };

describe("cross profit protection v1 — preference selection", () => {
  it("returns the EXACT baseline symbols and weights when nothing qualifies", () => {
    // Every candidate has a negative 1h spread, so none can qualify. The baseline must survive
    // untouched: recent strength that is mixed is a label, never a veto.
    const baseline = combo(
      [leg("AAA", 1, { ...flat, "1h": -0.01, "4h": -0.01 }), leg("BBB", 2, { ...flat, "1h": -0.01, "4h": -0.01 }), leg("CCC", 3, { ...flat, "1h": -0.01, "4h": -0.01 })],
      [leg("XXX", 1, { ...flat, "1h": 0.01, "4h": 0.01 }), leg("YYY", 2, { ...flat, "1h": 0.01, "4h": 0.01 }), leg("ZZZ", 3, { ...flat, "1h": 0.01, "4h": 0.01 })],
    );
    const decision = selectPreferredCombination(baseline, []);
    expect(decision.selection).toBe("BASELINE");
    expect(decision.label).toBe("RECENT_STRENGTH_MIXED");
    expect(decision.chosen).toBe(baseline);
    expect(decision.chosen.longs.map((l) => l.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(decision.chosen.shorts.map((l) => l.symbol)).toEqual(["XXX", "YYY", "ZZZ"]);
    expect(decision.chosen.longs.every((l) => l.weight === 1 / 6)).toBe(true);
  });

  it("labels missing strength data as UNAVAILABLE and still keeps the baseline", () => {
    const baseline = combo(
      [leg("AAA", 1, { "1h": null, "4h": null }), leg("BBB", 2, { "1h": null, "4h": null }), leg("CCC", 3, { "1h": null, "4h": null })],
      [leg("XXX", 1, { "1h": null, "4h": null }), leg("YYY", 2, { "1h": null, "4h": null }), leg("ZZZ", 3, { "1h": null, "4h": null })],
    );
    const decision = selectPreferredCombination(baseline, []);
    expect(decision.label).toBe("RECENT_STRENGTH_UNAVAILABLE");
    expect(decision.chosen).toBe(baseline);
  });

  it("keeps the baseline when it is already the best qualifying combination", () => {
    const strongLongs = [leg("AAA", 1, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("BBB", 2, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("CCC", 3, { ...flat, "1h": 0.03, "4h": 0.03 })];
    const weakShorts = [leg("XXX", 1, { ...flat, "1h": 0.01, "4h": 0.01 }), leg("YYY", 2, { ...flat, "1h": 0.01, "4h": 0.01 }), leg("ZZZ", 3, { ...flat, "1h": 0.01, "4h": 0.01 })];
    const baseline = combo(strongLongs, weakShorts);
    const worseRank = combo(
      [leg("DDD", 4, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("EEE", 5, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("FFF", 6, { ...flat, "1h": 0.03, "4h": 0.03 })],
      weakShorts,
    );
    const decision = selectPreferredCombination(baseline, [worseRank]);
    expect(decision.selection).toBe("BASELINE");
    expect(decision.label).toBe("BASELINE_ALREADY_BEST");
  });

  it("prefers a qualifying alternative with a strictly better aggregate MOM36 rank", () => {
    const shorts = [leg("XXX", 1, { ...flat, "1h": 0.01, "4h": 0.01 }), leg("YYY", 2, { ...flat, "1h": 0.01, "4h": 0.01 }), leg("ZZZ", 3, { ...flat, "1h": 0.01, "4h": 0.01 })];
    // Baseline qualifies but ranks 4+5+6 on the long side; the alternative ranks 1+2+3.
    const baseline = combo(
      [leg("DDD", 4, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("EEE", 5, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("FFF", 6, { ...flat, "1h": 0.03, "4h": 0.03 })],
      shorts,
    );
    const better = combo(
      [leg("AAA", 1, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("BBB", 2, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("CCC", 3, { ...flat, "1h": 0.03, "4h": 0.03 })],
      shorts,
    );
    const decision = selectPreferredCombination(baseline, [better]);
    expect(decision.selection).toBe("PREFERRED");
    expect(decision.chosen.longs.map((l) => l.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("is order-independent: equal ranks tie-break deterministically", () => {
    const shorts = [leg("XXX", 1, { ...flat, "1h": 0.01, "4h": 0.01 }), leg("YYY", 2, { ...flat, "1h": 0.01, "4h": 0.01 }), leg("ZZZ", 3, { ...flat, "1h": 0.01, "4h": 0.01 })];
    const baseline = combo([leg("MMM", 9, { ...flat, "1h": -0.05, "4h": -0.05 }), leg("NNN", 9, { ...flat, "1h": -0.05, "4h": -0.05 }), leg("OOO", 9, { ...flat, "1h": -0.05, "4h": -0.05 })], shorts);
    const a = combo([leg("AAA", 2, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("BBB", 2, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("CCC", 2, { ...flat, "1h": 0.03, "4h": 0.03 })], shorts);
    const b = combo([leg("DDD", 2, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("EEE", 2, { ...flat, "1h": 0.03, "4h": 0.03 }), leg("FFF", 2, { ...flat, "1h": 0.03, "4h": 0.03 })], shorts);
    const forward = selectPreferredCombination(baseline, [a, b]);
    const reversed = selectPreferredCombination(baseline, [b, a]);
    expect(forward.chosen.longs.map((l) => l.symbol)).toEqual(reversed.chosen.longs.map((l) => l.symbol));
  });
});

describe("cross profit protection v1 — relative spread survives market direction", () => {
  it("bullish: LONG +3% vs SHORT +1% is a POSITIVE relative spread", () => {
    const c = combo(
      [leg("A", 1, { "1h": 0.03 }), leg("B", 2, { "1h": 0.03 }), leg("C", 3, { "1h": 0.03 })],
      [leg("X", 1, { "1h": 0.01 }), leg("Y", 2, { "1h": 0.01 }), leg("Z", 3, { "1h": 0.01 })],
    );
    expect(relativeSpread(c, "1h")).toBeCloseTo(0.02, 12);
  });

  it("bearish: LONG -1% vs SHORT -3% is ALSO a positive relative spread", () => {
    // The basket's edge is intact in a falling market too: the shorts fell further than the longs.
    const c = combo(
      [leg("A", 1, { "1h": -0.01 }), leg("B", 2, { "1h": -0.01 }), leg("C", 3, { "1h": -0.01 })],
      [leg("X", 1, { "1h": -0.03 }), leg("Y", 2, { "1h": -0.03 }), leg("Z", 3, { "1h": -0.03 })],
    );
    expect(relativeSpread(c, "1h")).toBeCloseTo(0.02, 12);
  });

  it("returns null rather than a partial spread when a leg lacks the horizon", () => {
    const c = combo(
      [leg("A", 1, { "1h": 0.03 }), leg("B", 2, { "1h": null }), leg("C", 3, { "1h": 0.03 })],
      [leg("X", 1, { "1h": 0.01 }), leg("Y", 2, { "1h": 0.01 }), leg("Z", 3, { "1h": 0.01 })],
    );
    expect(relativeSpread(c, "1h")).toBeNull();
  });
});

describe("cross profit protection v1 — net-profit floor", () => {
  const snap = (netPnlUsd: number, ms: number, usable = true) =>
    ({ netPnlUsd, observedAt: new Date(ms).toISOString(), observedAtMs: ms, usable });
  const N0 = 150;
  const base = 1_700_000_000_000;

  it("arms at +0.5% of frozen notional and keeps a monotonic floor", () => {
    const state = createCrossProfitProtectionState(N0);
    expect(advanceNetProfitFloor(state, snap(0.30, base))).toBeNull();      // +0.20%, below arm
    expect(state.armed).toBe(false);
    expect(advanceNetProfitFloor(state, snap(0.75, base + 2_000))).toBeNull(); // +0.50% exactly
    expect(state.armed).toBe(true);
    expect(state.floorFraction).toBeCloseTo(0.005 * 0.70, 12);

    expect(advanceNetProfitFloor(state, snap(1.50, base + 4_000))).toBeNull(); // +1.00%
    const raised = state.floorFraction!;
    expect(raised).toBeCloseTo(0.01 * 0.70, 12);

    // Peak falls back; the floor must NOT follow it down.
    expect(advanceNetProfitFloor(state, snap(1.20, base + 6_000))).toBeNull();
    expect(state.floorFraction).toBe(raised);
  });

  it("exits when p falls to the floor", () => {
    const state = createCrossProfitProtectionState(N0);
    advanceNetProfitFloor(state, snap(1.50, base));                 // +1.00%, arms, floor 0.70%
    const reason = advanceNetProfitFloor(state, snap(1.04, base + 2_000)); // ~+0.693%
    expect(reason).toBe("NET_PROFIT_FLOOR_EXIT");
    expect(state.exitTrigger?.reason).toBe("NET_PROFIT_FLOOR_EXIT");
  });

  it("keeps the floor when a rehydrated state carries a floor above peak x keep", () => {
    // The peak is monotonic in-process, so the Math.max guard is only ever load-bearing across a
    // restart: a state restored with a floor already above peak*keep must not have it walked back
    // down on the next observation. Without the guard this test fails.
    const state = createCrossProfitProtectionState(N0);
    advanceNetProfitFloor(state, snap(1.50, base));            // peak +1.00%, floor 0.70%
    const restored = JSON.parse(JSON.stringify(state)) as typeof state;
    restored.floorFraction = 0.0095;                            // durably recorded, higher than peak*keep
    advanceNetProfitFloor(restored, snap(1.49, base + 5_000));  // still above the floor, no exit
    expect(restored.floorFraction).toBeCloseTo(0.0095, 12);
  });

  it("is restart-safe: floor and peak survive a rehydrated state object", () => {
    const state = createCrossProfitProtectionState(N0);
    advanceNetProfitFloor(state, snap(1.50, base));
    const rehydrated = JSON.parse(JSON.stringify(state)) as typeof state;
    expect(rehydrated.armed).toBe(true);
    expect(rehydrated.floorFraction).toBeCloseTo(0.007, 12);
    // A later, lower observation on the restored state must not reset the floor downward.
    advanceNetProfitFloor(rehydrated, snap(1.20, base + 10_000));
    expect(rehydrated.floorFraction).toBeCloseTo(0.007, 12);
  });

  it("a DEGRADED snapshot arms nothing, moves nothing, and triggers nothing", () => {
    const state = createCrossProfitProtectionState(N0);
    expect(advanceNetProfitFloor(state, snap(5.0, base, false))).toBeNull();
    expect(state.armed).toBe(false);
    expect(state.peakNetLiqFraction).toBeNull();
  });

  it("never adopts a peak that did not come from a net-liq snapshot", () => {
    const state = createCrossProfitProtectionState(N0);
    advanceNetProfitFloor(state, snap(1.50, base));
    expect(state.peakSource).toBe("NET_LIQUIDATION");
  });
});

describe("cross profit protection v1 — relative deterioration", () => {
  const N0 = 150;
  const base = 1_700_000_000_000;
  const obs = (candleOpenMs: number, fraction: number, s15m: number, s30m: number) =>
    ({ s15m, s30m, fraction, candleOpenMs, observedAt: new Date(candleOpenMs).toISOString(), usable: true });

  const armedPeakState = () => {
    const state = createCrossProfitProtectionState(N0);
    // Peak +0.40%: deliberately BELOW the +0.5% arm, to prove deterioration does not need arming.
    advanceNetProfitFloor(state, { netPnlUsd: 0.60, observedAt: new Date(base).toISOString(), observedAtMs: base, usable: true });
    return state;
  };

  it("can exit BEFORE the floor ever arms", () => {
    const state = armedPeakState();
    expect(state.armed).toBe(false);
    expect(advanceRelativeDeterioration(state, obs(base + 60_000, 0.0, -0.006, -0.002))).toBeNull();
    const reason = advanceRelativeDeterioration(state, obs(base + 120_000, 0.0, -0.006, -0.002));
    expect(reason).toBe("RELATIVE_EDGE_BREAKDOWN");
    expect(state.armed).toBe(false);
  });

  it("two ticks on the SAME completed minute are not two confirmations", () => {
    const state = armedPeakState();
    expect(advanceRelativeDeterioration(state, obs(base + 60_000, 0.0, -0.006, -0.002))).toBeNull();
    expect(state.breakdownConfirmations).toBe(1);
    // Same candle observed again by a faster tick.
    expect(advanceRelativeDeterioration(state, obs(base + 60_000, 0.0, -0.006, -0.002))).toBeNull();
    expect(state.breakdownConfirmations).toBe(1);
  });

  it("does not fire when any single condition is missing", () => {
    const state = armedPeakState();
    // s15m not deep enough
    advanceRelativeDeterioration(state, obs(base + 60_000, 0.0, -0.004, -0.002));
    // s30m not negative
    advanceRelativeDeterioration(state, obs(base + 120_000, 0.0, -0.006, 0.001));
    // giveback below 0.25%
    advanceRelativeDeterioration(state, obs(base + 180_000, 0.0038, -0.006, -0.002));
    expect(state.breakdownConfirmations).toBe(0);
  });
});

describe("cross profit protection v1 — one close intent", () => {
  it("a second simultaneous trigger cannot overwrite the first", () => {
    const N0 = 150;
    const base = 1_700_000_000_000;
    const state = createCrossProfitProtectionState(N0);
    advanceNetProfitFloor(state, { netPnlUsd: 1.50, observedAt: new Date(base).toISOString(), observedAtMs: base, usable: true });
    const first = advanceNetProfitFloor(state, { netPnlUsd: 1.04, observedAt: new Date(base + 2_000).toISOString(), observedAtMs: base + 2_000, usable: true });
    expect(first).toBe("NET_PROFIT_FLOOR_EXIT");
    // Deterioration conditions are also satisfied now; it must not raise a second intent.
    const second = advanceRelativeDeterioration(state, {
      s15m: -0.02, s30m: -0.02, fraction: -0.01, candleOpenMs: base + 60_000,
      observedAt: new Date(base + 60_000).toISOString(), usable: true,
    });
    expect(second).toBeNull();
    expect(state.exitTrigger?.reason).toBe("NET_PROFIT_FLOOR_EXIT");
  });
});

describe("cross profit protection v1 — net liquidation", () => {
  const quote = (symbol: string, bid: number, ask: number, ms: number, qty = 1e9): BookQuote =>
    ({ symbol, bidPrice: bid, bidQty: qty, askPrice: ask, askQty: qty, observedAtMs: ms });
  const now = 1_700_000_000_000;

  it("closes LONGs on the BID and SHORTs on the ASK", () => {
    const est = estimateNetLiquidation({
      legs: [
        { symbol: "AAA", side: "LONG", qty: 10, entryPrice: 10, exitPrice: null },
        { symbol: "XXX", side: "SHORT", qty: 10, entryPrice: 10, exitPrice: null },
      ],
      quotes: new Map([["AAA", quote("AAA", 10.5, 10.6, now)], ["XXX", quote("XXX", 9.4, 9.5, now)]]),
      nowMs: now, maxQuoteAgeMs: 5_000, realizedFeesUsd: 0, fundingUsd: 0, remainingExitCostBps: 0,
    });
    // LONG sells the 10.5 bid (+5), SHORT buys back the 9.5 ask (+5) — never the flattering side.
    expect(est.usable).toBe(true);
    expect(est.unrealizedPnlUsd).toBeCloseTo(10, 9);
  });

  it("keeps realized P&L from closed legs and never shrinks N0", () => {
    const est = estimateNetLiquidation({
      legs: [
        { symbol: "AAA", side: "LONG", qty: 10, entryPrice: 10, exitPrice: 11 },   // closed, +10
        { symbol: "XXX", side: "SHORT", qty: 10, entryPrice: 10, exitPrice: null }, // open
      ],
      quotes: new Map([["XXX", quote("XXX", 9.4, 9.5, now)]]),
      nowMs: now, maxQuoteAgeMs: 5_000, realizedFeesUsd: 0, fundingUsd: 0, remainingExitCostBps: 0,
    });
    expect(est.usable).toBe(true);
    expect(est.realizedPnlUsd).toBeCloseTo(10, 9);
    expect(est.unrealizedPnlUsd).toBeCloseTo(5, 9);
    expect(est.netPnlUsd).toBeCloseTo(15, 9);
  });

  it("charges the remaining exit cost only on legs still open", () => {
    const est = estimateNetLiquidation({
      legs: [
        { symbol: "AAA", side: "LONG", qty: 10, entryPrice: 10, exitPrice: 11 },
        { symbol: "XXX", side: "SHORT", qty: 10, entryPrice: 10, exitPrice: null },
      ],
      quotes: new Map([["XXX", quote("XXX", 10, 10, now)]]),
      nowMs: now, maxQuoteAgeMs: 5_000, realizedFeesUsd: 0, fundingUsd: 0, remainingExitCostBps: 100,
    });
    // Only the open $100 leg is charged: 100 * 1% = 1.00, not the closed one.
    expect(est.remainingExitCostUsd).toBeCloseTo(1, 9);
  });

  it("goes DEGRADED on a stale quote, a missing quote, or insufficient depth", () => {
    const stale = estimateNetLiquidation({
      legs: [{ symbol: "AAA", side: "LONG", qty: 1, entryPrice: 10, exitPrice: null }],
      quotes: new Map([["AAA", quote("AAA", 10, 10, now - 60_000)]]),
      nowMs: now, maxQuoteAgeMs: 5_000, realizedFeesUsd: 0, fundingUsd: 0, remainingExitCostBps: 0,
    });
    expect(stale.usable).toBe(false);
    expect(stale.netPnlUsd).toBeNull();
    expect(stale.degradedReasons).toContain("AAA:STALE_QUOTE");

    const missing = estimateNetLiquidation({
      legs: [{ symbol: "AAA", side: "LONG", qty: 1, entryPrice: 10, exitPrice: null }],
      quotes: new Map(), nowMs: now, maxQuoteAgeMs: 5_000, realizedFeesUsd: 0, fundingUsd: 0, remainingExitCostBps: 0,
    });
    expect(missing.degradedReasons).toContain("AAA:NO_QUOTE");

    const thin = estimateNetLiquidation({
      legs: [{ symbol: "AAA", side: "LONG", qty: 100, entryPrice: 10, exitPrice: null }],
      quotes: new Map([["AAA", quote("AAA", 10, 10, now, 1)]]),
      nowMs: now, maxQuoteAgeMs: 5_000, realizedFeesUsd: 0, fundingUsd: 0, remainingExitCostBps: 0,
    });
    expect(thin.usable).toBe(false);
    expect(thin.degradedReasons).toContain("AAA:DEPTH_SHORTFALL");
  });

  it("does not double-count entry fees already charged by the exchange", () => {
    const est = estimateNetLiquidation({
      legs: [{ symbol: "AAA", side: "LONG", qty: 10, entryPrice: 10, exitPrice: null }],
      quotes: new Map([["AAA", quote("AAA", 10, 10, now)]]),
      nowMs: now, maxQuoteAgeMs: 5_000, realizedFeesUsd: 0.25, fundingUsd: 0, remainingExitCostBps: 0,
    });
    // Entry price is the raw fill; the fee is subtracted once, from realizedFeesUsd.
    expect(est.netPnlUsd).toBeCloseTo(-0.25, 9);
  });
});

describe("cross profit protection v1 — wiring (source-level guard)", () => {
  const executor = readFileSync(new URL("../src/lib/cross-sectional-executor.ts", import.meta.url), "utf8");

  it("attaches the policy to NEW dynamic baskets only, never backfills an existing one", () => {
    // Presence of the state is the dispatch marker. A basket opened before this policy existed has
    // no state and must keep exactly its frozen behaviour.
    expect(executor).toContain("crossProfitProtection: dynamicV3Signal");
    expect(executor).toContain("createCrossProfitProtectionState(0, CROSS_PROFIT_PROTECTION_V1_POLICY_ID)");
    expect(executor).toContain('state.version === "CROSS_PROFIT_PROTECTION_V1"');
  });

  it("does not touch admission, formation, or any existing entry gate", () => {
    // This release only adds an EXIT path. Nothing here may weaken an entry rule.
    const start = executor.indexOf("const protection = this.basketProfitProtection(basket)");
    const end = executor.indexOf("if (this.isDynamicV3Basket(basket)) {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const wiredBlock = executor.slice(start, end);
    expect(wiredBlock).not.toContain("admission");
    expect(wiredBlock).not.toContain("scoreGap");
    expect(wiredBlock).not.toContain("clusterCap");
  });

  it("leaves the existing hard cut and horizon reachable when protection declines to fire", () => {
    // The protection block only `continue`s when it actually raised an exit; otherwise control
    // falls through to the ladder/hard-cut evaluation immediately below it.
    expect(executor).toContain("if (protectionExit) {");
    expect(executor).toContain("if (this.isDynamicV3Basket(basket)) {");
  });

  it("binds N0 from the basket's real filled notional, not from the plan", () => {
    expect(executor).toContain("bindEntryNotional(protection, basket.legs.reduce((sum, leg) => sum + leg.entryPrice * leg.qty, 0), pathNow)");
  });

  it("prices the exit from the book, and degrades rather than inventing a price", () => {
    expect(executor).toContain("getExecutionBookTickers");
    expect(executor).toContain("CROSS_PROFIT_PROTECTION_MAX_QUOTE_AGE_MS");
    expect(executor).toContain("netLiquidationSource: estimate.source");
  });
});

describe("cross profit protection v1 — rolling S_h (formula regression)", () => {
  const M = 60_000;
  const t0 = 1_700_000_000_000;
  const legs: SpreadLeg[] = [
    { symbol: "L1", side: "LONG", weight: 1 },
    { symbol: "S1", side: "SHORT", weight: 1 },
  ];

  it("uses each leg's OWN price h ago, not its return since entry", () => {
    // The distinguishing case: price has drifted far from entry, so entry != mid(t-h).
    //   LONG  mid(t-h)=200 -> mid(t)=220   rolling r = 220/200 - 1 = +10.00%
    //   SHORT mid(t-h)=100 -> mid(t)=100   rolling r = 0
    //   correct S_15m = +10.00%
    // The rejected formula, difference of entry-based returns with entry=100, would give
    //   (220-200)/100 = +20.00%  ->  S_15m = +20.00%   (exactly double here)
    const samples: SpreadSample[] = [];
    recordMidSample(samples, t0, { L1: 200, S1: 100 });
    for (let i = 1; i <= 15; i++) recordMidSample(samples, t0 + i * M, { L1: 200, S1: 100 });
    recordMidSample(samples, t0 + 15 * M, { L1: 220, S1: 100 });

    const reading = spreadOverWindow(samples, t0 + 15 * M, 15 * M, legs);
    expect(reading.status).toBe("OK");
    expect(reading.value).toBeCloseTo(0.10, 12);
    // Pin the rejection explicitly so a future refactor cannot quietly reintroduce it.
    expect(reading.value).not.toBeCloseTo(0.20, 6);
  });

  it("is a true ratio: doubling both endpoints leaves the rolling return unchanged", () => {
    const a: SpreadSample[] = [];
    recordMidSample(a, t0, { L1: 100, S1: 100 });
    for (let i = 1; i <= 15; i++) recordMidSample(a, t0 + i * M, { L1: 110, S1: 100 });
    const b: SpreadSample[] = [];
    recordMidSample(b, t0, { L1: 200, S1: 200 });
    for (let i = 1; i <= 15; i++) recordMidSample(b, t0 + i * M, { L1: 220, S1: 200 });
    const ra = spreadOverWindow(a, t0 + 15 * M, 15 * M, legs);
    const rb = spreadOverWindow(b, t0 + 15 * M, 15 * M, legs);
    expect(ra.value).toBeCloseTo(rb.value!, 12);
  });

  it("normalises weights per side, so an unequal side does not distort the spread", () => {
    const heavy: SpreadLeg[] = [
      { symbol: "L1", side: "LONG", weight: 3 },
      { symbol: "L2", side: "LONG", weight: 1 },
      { symbol: "S1", side: "SHORT", weight: 1 },
    ];
    const samples: SpreadSample[] = [];
    recordMidSample(samples, t0, { L1: 100, L2: 100, S1: 100 });
    for (let i = 1; i <= 15; i++) recordMidSample(samples, t0 + i * M, { L1: 100, L2: 100, S1: 100 });
    recordMidSample(samples, t0 + 15 * M, { L1: 110, L2: 100, S1: 100 });
    // Weighted long return = (3*0.10 + 1*0.0)/4 = 0.075; short = 0.
    const reading = spreadOverWindow(samples, t0 + 15 * M, 15 * M, heavy);
    expect(reading.value).toBeCloseTo(0.075, 12);
  });

  it("reports WARMING_UP while history is shorter than the window, never zero", () => {
    const samples: SpreadSample[] = [];
    for (let i = 0; i <= 5; i++) recordMidSample(samples, t0 + i * M, { L1: 100, S1: 100 });
    const reading = spreadOverWindow(samples, t0 + 5 * M, 15 * M, legs);
    expect(reading.status).toBe("WARMING_UP");
    expect(reading.value).toBeNull();
  });

  it("reports DEGRADED when the current minute is missing or a leg has no mid", () => {
    const samples: SpreadSample[] = [];
    for (let i = 0; i <= 15; i++) recordMidSample(samples, t0 + i * M, { L1: 100, S1: 100 });
    // current minute is one ahead of the newest sample
    expect(spreadOverWindow(samples, t0 + 16 * M, 15 * M, legs).status).toBe("DEGRADED");

    const holed: SpreadSample[] = [];
    recordMidSample(holed, t0, { L1: 100 }); // S1 never observed at the old end
    for (let i = 1; i <= 15; i++) recordMidSample(holed, t0 + i * M, { L1: 100, S1: 100 });
    const reading = spreadOverWindow(holed, t0 + 15 * M, 15 * M, legs);
    expect(reading.status).toBe("DEGRADED");
    expect(reading.value).toBeNull();
  });

  it("drops a stale or missing quote instead of inventing a mid", () => {
    const now = t0;
    const quotes = new Map<string, BookQuote>([
      ["L1", { symbol: "L1", bidPrice: 99, bidQty: 10, askPrice: 101, askQty: 10, observedAtMs: now }],
      ["S1", { symbol: "S1", bidPrice: 99, bidQty: 10, askPrice: 101, askQty: 10, observedAtMs: now - 60_000 }],
    ]);
    const mids = midsFromQuotes(["L1", "S1", "MISSING"], quotes, now, 15_000);
    expect(mids).toEqual({ L1: 100 });
  });
});

describe("cross profit protection v1 — consecutive-minute confirmations", () => {
  const M = 60_000;
  const t0 = 1_700_000_000_000;
  const obs = (candleOpenMs: number) => ({
    s15m: -0.006, s30m: -0.002, fraction: 0.0,
    candleOpenMs, observedAt: new Date(candleOpenMs).toISOString(), usable: true,
  });
  const seeded = () => {
    const state = createCrossProfitProtectionState(150);
    advanceNetProfitFloor(state, { netPnlUsd: 0.60, observedAt: new Date(t0).toISOString(), observedAtMs: t0, usable: true });
    return state;
  };

  it("fires on two CONSECUTIVE valid minutes", () => {
    const state = seeded();
    expect(advanceRelativeDeterioration(state, obs(t0 + M))).toBeNull();
    expect(advanceRelativeDeterioration(state, obs(t0 + 2 * M))).toBe("RELATIVE_EDGE_BREAKDOWN");
  });

  it("a GAP restarts the streak instead of accumulating across it", () => {
    const state = seeded();
    expect(advanceRelativeDeterioration(state, obs(t0 + M))).toBeNull();
    // Minute t0+2M did not qualify; the next qualifying minute is t0+3M.
    expect(advanceRelativeDeterioration(state, obs(t0 + 3 * M))).toBeNull();
    expect(state.breakdownConfirmations).toBe(1);
    expect(advanceRelativeDeterioration(state, obs(t0 + 4 * M))).toBe("RELATIVE_EDGE_BREAKDOWN");
  });
});

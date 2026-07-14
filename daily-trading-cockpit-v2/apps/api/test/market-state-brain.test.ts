import { describe, it, expect } from "vitest";
import { decideMarketState } from "../src/lib/market-state-brain.js";
import { checkMarketStateInvariants } from "../src/lib/four-brain-invariants.js";
import { marketInput, src, NOW, MIN } from "./four-brain-fixtures.js";

describe("Market State Brain", () => {
  it("UNKNOWN when core (trend/volatility) data is insufficient — never fabricates a regime", () => {
    const d = decideMarketState(marketInput({ trend: src(null), volatility: src(null), momentum: src(null) }));
    expect(d.family).toBe("UNKNOWN");
    expect(d.confidence).toBeLessThanOrEqual(0.25);
    expect(d.components.trendScore).toBeNull();
    expect(checkMarketStateInvariants(d).ok).toBe(true);
  });

  it("bullish trend + elevated event risk → BULLISH bias with high transition risk", () => {
    const d = decideMarketState(marketInput({ trend: src(0.7), momentum: src(0.6), volatility: src(0.5), breadth: src(0.5), eventRisk: src(0.8) }));
    expect(d.bias).toBe("BULLISH");
    expect(d.transitionRisk).toBeGreaterThanOrEqual(0.7);
    expect(checkMarketStateInvariants(d).ok).toBe(true);
  });

  it("PANIC and a normal bearish TREND are DISTINCT families", () => {
    const panic = decideMarketState(marketInput({ trend: src(-0.5), momentum: src(-0.6), volatility: src(0.95), breadth: src(-0.6) }));
    const bearTrend = decideMarketState(marketInput({ trend: src(-0.6), momentum: src(-0.5), volatility: src(0.45), breadth: src(-0.4) }));
    expect(panic.family).toBe("PANIC");
    expect(bearTrend.family).toBe("TREND");
    expect(panic.family).not.toBe(bearTrend.family);
    expect(bearTrend.bias).toBe("BEARISH");
  });

  it("stale sentiment becomes neutral (dropped to null), doesn't poison the state", () => {
    const d = decideMarketState(marketInput({ sentiment: src(0.9, 3 * 60 * 60 * MIN) })); // 3h old vs 60min TTL
    expect(d.sourceStatuses.sentiment).toBe("STALE");
    expect(d.components.sentimentScore).toBeNull();
  });

  it("missing external enrichment (eventRisk + sentiment) does not fail the decision", () => {
    const d = decideMarketState(marketInput({ eventRisk: src(null), sentiment: src(null) }));
    expect(d.sourceStatuses.eventRisk).toBe("MISSING");
    expect(d.family).not.toBe("UNKNOWN"); // core data still present
    expect(checkMarketStateInvariants(d).ok).toBe(true);
  });

  it("a FUTURE component timestamp is rejected (ERROR, unused) — causal contract", () => {
    const d = decideMarketState(marketInput({ trend: { value: 0.9, asOfMs: NOW + 10 * MIN } }));
    expect(d.sourceStatuses.trend).toBe("ERROR");
    expect(d.components.trendScore).toBeNull(); // the future value never enters the state
  });

  it("only the narrow deterministic safety events set EVENT_DRIVEN — geopolitical soft risk does NOT", () => {
    const withEvent = decideMarketState(marketInput({ safetyEvents: [{ kind: "DEPEG", asOfMs: NOW - MIN }] }));
    expect(withEvent.family).toBe("EVENT_DRIVEN");
    // A high SOFT eventRisk (macro/geopolitical) must NOT shut trading into EVENT_DRIVEN — it only lifts transitionRisk.
    const softOnly = decideMarketState(marketInput({ eventRisk: src(0.95), safetyEvents: [] }));
    expect(softOnly.family).not.toBe("EVENT_DRIVEN");
    expect(softOnly.transitionRisk).toBeGreaterThanOrEqual(0.9);
  });

  it("never hard-gates: output carries no long/short block field (pure description)", () => {
    const d = decideMarketState(marketInput({ trend: src(0.9) }));
    expect(d).not.toHaveProperty("allowLong");
    expect(d).not.toHaveProperty("blockShort");
  });

  it("review regression: a bogus safety-event kind can NOT drive EVENT_DRIVEN (only the narrow 5 do)", () => {
    // A geopolitical/macro "event" mislabelled as a safety event must be filtered out.
    const bogus = decideMarketState(marketInput({ safetyEvents: [{ kind: "GEOPOLITICAL" as never, asOfMs: NOW - MIN }] }));
    expect(bogus.family).not.toBe("EVENT_DRIVEN");
    // A real one still works.
    const real = decideMarketState(marketInput({ safetyEvents: [{ kind: "HACK", asOfMs: NOW - MIN }] }));
    expect(real.family).toBe("EVENT_DRIVEN");
  });

  it("is deterministic — same fixture replays identically", () => {
    const a = decideMarketState(marketInput());
    const b = decideMarketState(marketInput());
    expect(a).toEqual(b);
  });
});

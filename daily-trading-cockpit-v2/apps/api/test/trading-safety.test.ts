import { describe, it, expect } from "vitest";
import type { MarketContext, Regime, RiskConfig, StrategyLane } from "../src/trading/index.js";
import {
  assertNoForbiddenRisk,
  assertNoForbiddenLane,
  assertStrategyModeSafe,
  assertLaneSafe,
  riskConfigViolation,
  isForbiddenLaneId,
  decisionSafetyRejection,
  validateFrameworkInvariants,
  detectContradictions,
  stalenessReasons,
  isContextStale,
  buildTradingDecision,
  makeRiskConfig,
  STRATEGY_MODES,
  shortRallyFade,
  breakdownRetestShort,
  microMeanReversion,
  pullbackLongScalp,
  breakoutRetestLong,
  relativeStrengthLong,
} from "../src/trading/index.js";

const ALL_LANES = [
  shortRallyFade,
  breakdownRetestShort,
  microMeanReversion,
  pullbackLongScalp,
  breakoutRetestLong,
  relativeStrengthLong,
];

function base(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    dailyLossPct: 0,
    consecutiveLosses: 0,
    spreadBps: 2,
    slippageBps: 2,
    regimeConfidence: 0.9,
    openPositions: 0,
    tradesToday: 0,
    ...overrides,
  };
}

// A context that WOULD trigger SHORT_RALLY_FADE in bearish chop.
function fadeSetup(overrides: Partial<MarketContext> = {}): MarketContext {
  return base({
    btcBelow60000: true,
    btcBelowKeyResistance: true,
    pricePullbackToVWAPOrEMA20: true,
    rsi1h: 62,
    rejectionCandle: true,
    volumeWeakOnBounce: true,
    marketBreadthWeak: true,
    ...overrides,
  });
}

// ── 1. RiskConfig bypass gap is real, but caught at runtime ──────────────────

describe("RiskConfig enforcement", () => {
  it("the TYPE does not stop a martingale/averaging risk literal (documents the gap)", () => {
    // This compiles fine — proving TS alone is insufficient. Runtime catches it.
    const evil: RiskConfig = {
      riskPerTradePct: 5,
      maxOpenPositions: 3,
      allowAveragingDown: true,
      allowMartingale: true,
    };
    expect(riskConfigViolation(evil)).toBe("MARTINGALE_ENABLED");
  });

  it("makeRiskConfig can never enable averaging/martingale", () => {
    const r = makeRiskConfig(0.15, 1);
    expect(r.allowAveragingDown).toBe(false);
    expect(r.allowMartingale).toBe(false);
    expect(riskConfigViolation(r)).toBeNull();
  });

  it("assertNoForbiddenRisk throws on martingale and on averaging-down", () => {
    expect(() =>
      assertNoForbiddenRisk({ riskPerTradePct: 1, maxOpenPositions: 1, allowAveragingDown: false, allowMartingale: true }),
    ).toThrow(/MARTINGALE/);
    expect(() =>
      assertNoForbiddenRisk({ riskPerTradePct: 1, maxOpenPositions: 1, allowAveragingDown: true, allowMartingale: false }),
    ).toThrow(/AVERAGING_DOWN/);
    expect(() => assertNoForbiddenRisk(makeRiskConfig(0.1, 1))).not.toThrow();
  });

  it("riskConfigViolation flags invalid numerics", () => {
    expect(riskConfigViolation({ riskPerTradePct: -1, maxOpenPositions: 1, allowAveragingDown: false, allowMartingale: false })).toBe(
      "INVALID_RISK_PER_TRADE",
    );
    expect(riskConfigViolation({ riskPerTradePct: 1, maxOpenPositions: -1, allowAveragingDown: false, allowMartingale: false })).toBe(
      "INVALID_MAX_OPEN_POSITIONS",
    );
  });
});

// ── 2/3. Forbidden lanes + hard gate ─────────────────────────────────────────

describe("forbidden lane enforcement", () => {
  it("isForbiddenLaneId / assertNoForbiddenLane cover the ban-list", () => {
    for (const id of ["MARTINGALE", "AVERAGING_DOWN", "DCA_LONG", "GRID_LONG", "HOLD_UNTIL_RECOVERY"]) {
      expect(isForbiddenLaneId(id)).toBe(true);
      expect(() => assertNoForbiddenLane(id)).toThrow();
    }
    expect(isForbiddenLaneId("SHORT_RALLY_FADE")).toBe(false);
    expect(() => assertNoForbiddenLane("SHORT_RALLY_FADE")).not.toThrow();
  });

  it("assertStrategyModeSafe passes every shipped mode", () => {
    for (const mode of Object.values(STRATEGY_MODES)) {
      expect(() => assertStrategyModeSafe(mode)).not.toThrow();
    }
  });

  it("assertStrategyModeSafe throws when a forbidden lane is not disabled", () => {
    const broken = {
      ...STRATEGY_MODES.BEARISH_CHOPPY_DEFENSIVE,
      disabledLanes: ["SHORT_RALLY_FADE"], // dropped the forbidden set
    };
    expect(() => assertStrategyModeSafe(broken)).toThrow(/forbidden lane not disabled/);
  });

  it("assertStrategyModeSafe throws when a forbidden lane is weighted", () => {
    const broken = {
      ...STRATEGY_MODES.BEARISH_CHOPPY_DEFENSIVE,
      laneWeight: { ...STRATEGY_MODES.BEARISH_CHOPPY_DEFENSIVE.laneWeight, MARTINGALE: 0.5 },
    };
    expect(() => assertStrategyModeSafe(broken)).toThrow(/forbidden lane weighted/);
  });

  it("validateFrameworkInvariants passes for all shipped lanes + modes", () => {
    expect(() => validateFrameworkInvariants(ALL_LANES)).not.toThrow();
    for (const lane of ALL_LANES) expect(() => assertLaneSafe(lane)).not.toThrow();
  });
});

// ── 4. Forbidden lane / risk cannot produce an ENTER via buildTradingDecision ─

describe("hard gate: no forbidden entry can escape buildTradingDecision", () => {
  // A malicious lane that always wants to enter, with a forbidden id.
  const forbiddenLane: StrategyLane = {
    id: "DCA_LONG" as StrategyLane["id"], // forbidden id (cast past the LaneId union)
    action: "ENTER_LONG",
    enabledRegimes: ["BEARISH_CHOPPY_DEFENSIVE"],
    exit: { takeProfitATR: 0.5, stopLossATR: 0.7, maxHoldMinutes: 60 },
    risk: makeRiskConfig(0.15, 1),
    shouldEnter: () => true,
  };

  // A structurally-valid-id lane but with a martingale risk config.
  const martingaleLane: StrategyLane = {
    id: "SHORT_RALLY_FADE",
    action: "ENTER_SHORT",
    enabledRegimes: ["BEARISH_CHOPPY_DEFENSIVE"],
    exit: { takeProfitATR: 0.5, stopLossATR: 0.7, maxHoldMinutes: 60 },
    risk: { riskPerTradePct: 5, maxOpenPositions: 3, allowAveragingDown: false, allowMartingale: true },
    shouldEnter: () => true,
  };

  const routingWith = (lane: StrategyLane): Record<Regime, StrategyLane[]> => ({
    BEARISH_CHOPPY_DEFENSIVE: [lane],
    BEAR_TREND: [],
    NEUTRAL_RECOVERY: [],
    TREND_RECOVERY: [],
    NO_TRADE: [],
  });

  it("rejects a forbidden lane id even though its predicate returns true", () => {
    const d = buildTradingDecision(fadeSetup(), { routing: routingWith(forbiddenLane) });
    expect(d.action).toBe("NO_TRADE");
    expect(d.trace?.rejectedBy).toBe("FORBIDDEN_LANE_HARD_GATE");
  });

  it("rejects a lane whose risk config enables martingale", () => {
    const d = buildTradingDecision(fadeSetup(), { routing: routingWith(martingaleLane) });
    expect(d.action).toBe("NO_TRADE");
    expect(d.trace?.rejectedBy).toBe("FORBIDDEN_LANE_HARD_GATE");
    expect(String(d.trace?.noTradeReason)).toContain("MARTINGALE_ENABLED");
  });

  it("decisionSafetyRejection is null for a clean ENTER and set for a bad one", () => {
    expect(
      decisionSafetyRejection({
        action: "ENTER_SHORT",
        lane: "SHORT_RALLY_FADE",
        regime: "BEARISH_CHOPPY_DEFENSIVE",
        exit: { takeProfitATR: 0.5, stopLossATR: 0.7, maxHoldMinutes: 60 },
        risk: makeRiskConfig(0.15, 1),
      }),
    ).toBeNull();
    expect(
      decisionSafetyRejection({
        action: "ENTER_LONG",
        lane: "DCA_LONG" as "MICRO_MEAN_REVERSION",
        regime: "BEARISH_CHOPPY_DEFENSIVE",
        exit: { takeProfitATR: 0.5, stopLossATR: 0.7, maxHoldMinutes: 60 },
        risk: makeRiskConfig(0.15, 1),
      })?.code,
    ).toBe("FORBIDDEN_LANE");
  });
});

// ── 6. Contradiction detection ───────────────────────────────────────────────

describe("context contradiction detection", () => {
  it("flags stale btcBelow60000 combined with recovery flags", () => {
    const c = detectContradictions(base({ btcBelow60000: true, btcClose4hAbove62000: true }));
    expect(c).toContain("BELOW_60K_VS_4H_ABOVE_62K");
  });

  it("flags a range of mutually-exclusive pairs", () => {
    expect(detectContradictions(base({ marketBreadthWeak: true, marketBreadthPositive: true }))).toContain(
      "BREADTH_WEAK_VS_POSITIVE",
    );
    expect(detectContradictions(base({ supportBroken: true, supportHolds: true }))).toContain(
      "SUPPORT_BROKEN_VS_HOLDS",
    );
    expect(detectContradictions(base({ retestFailed: true, retest62000Hold: true }))).toContain(
      "RETEST_FAILED_VS_HELD",
    );
    expect(detectContradictions(base({ liquidityGood: true, liquidityTooThin: true }))).toContain(
      "LIQUIDITY_GOOD_VS_THIN",
    );
  });

  it("a consistent context has no contradictions", () => {
    expect(detectContradictions(fadeSetup())).toEqual([]);
  });

  it("buildTradingDecision stands aside on a contradictory context (even one that would otherwise trade)", () => {
    // fade setup PLUS a contradictory recovery flag → NO_TRADE by contradiction.
    const d = buildTradingDecision(fadeSetup({ btcClose4hAbove62000: true }));
    expect(d.action).toBe("NO_TRADE");
    expect(d.trace?.rejectedBy).toBe("CONTRADICTORY_CONTEXT");
    expect(d.trace?.contradictions.length).toBeGreaterThan(0);
  });
});

// ── 5. Freshness ─────────────────────────────────────────────────────────────

describe("multi-timeframe freshness", () => {
  it("explicit dataStale flag makes the context stale", () => {
    expect(isContextStale(base({ dataStale: true }))).toBe(true);
    expect(stalenessReasons(base({ dataStale: true }))).toContain("EXPLICIT_STALE_FLAG");
  });

  it("a timeframe older than its budget (relative to asOf) is stale", () => {
    const asOf = 1_000_000_000_000;
    const stale = base({
      asOf,
      freshness: [{ timeframe: "1h", lastCandleCloseMs: asOf - 5 * 60_000, maxStalenessMs: 60_000 }],
    });
    expect(isContextStale(stale)).toBe(true);
    expect(stalenessReasons(stale).some((r) => r.startsWith("STALE_1h"))).toBe(true);
  });

  it("a fresh timeframe within budget is not stale", () => {
    const asOf = 1_000_000_000_000;
    const fresh = base({
      asOf,
      freshness: [{ timeframe: "1h", lastCandleCloseMs: asOf - 30_000, maxStalenessMs: 120_000 }],
    });
    expect(isContextStale(fresh)).toBe(false);
  });

  it("buildTradingDecision stands aside on stale data", () => {
    const d = buildTradingDecision(fadeSetup({ dataStale: true }));
    expect(d.action).toBe("NO_TRADE");
    expect(d.trace?.rejectedBy).toBe("DATA_STALE");
  });
});

// ── 7. Decision trace / logging fields ───────────────────────────────────────

describe("decision trace fields", () => {
  it("populates detectedRegime + selectedLane on an entry", () => {
    const d = buildTradingDecision(fadeSetup());
    expect(d.action).toBe("ENTER_SHORT");
    expect(d.trace?.detectedRegime).toBe("BEARISH_CHOPPY_DEFENSIVE");
    expect(d.trace?.selectedLane).toBe("SHORT_RALLY_FADE");
    expect(d.trace?.rejectedBy).toBeNull();
  });

  it("records riskGuardReason when the book is full", () => {
    const d = buildTradingDecision(fadeSetup({ openPositions: 1 }));
    expect(d.action).toBe("NO_TRADE");
    expect(d.trace?.rejectedBy).toBe("RISK_GUARD");
    expect(d.trace?.riskGuardReason).toBeTruthy();
  });

  it("records noTradeReason from the environment guard", () => {
    const d = buildTradingDecision(fadeSetup({ signalConflict: true }));
    expect(d.trace?.rejectedBy).toBe("NO_TRADE_GUARD");
    expect(d.trace?.noTradeReason).toContain("SIGNAL_CONFLICT");
  });

  it("records NO_VALID_LANE_SETUP when a regime is active but no lane fires", () => {
    // Bearish regime, but none of the short/micro setups present.
    const d = buildTradingDecision(base({ btcBelow60000: true }));
    expect(d.action).toBe("NO_TRADE");
    expect(d.trace?.rejectedBy).toBe("NO_VALID_LANE_SETUP");
  });
});

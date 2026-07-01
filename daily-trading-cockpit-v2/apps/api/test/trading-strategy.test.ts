import { describe, it, expect } from "vitest";
import type { MarketContext, Regime } from "../src/trading/index.js";
import {
  detectRegime,
  evaluateNoTrade,
  riskGuard,
  buildTradingDecision,
  getStrategyMode,
  STRATEGY_MODES,
  FORBIDDEN_LANES,
  shortRallyFade,
  breakdownRetestShort,
  microMeanReversion,
  pullbackLongScalp,
  breakoutRetestLong,
  relativeStrengthLong,
} from "../src/trading/index.js";

// Clean governance floor: no losing day, tight book, high confidence, flat book.
function base(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    dailyLossPct: 0,
    consecutiveLosses: 0,
    spreadBps: 2,
    slippageBps: 2,
    liquidityGood: true,
    fundingRiskAbnormal: false,
    regimeConfidence: 0.9,
    openPositions: 0,
    tradesToday: 0,
    ...overrides,
  };
}

// Detection flag sets that make detectRegime return a specific regime.
const BEAR_TREND_FLAGS = { btcBreaksBelow55000: true, retestFailed: true, marketBreadthCollapses: true };
const TREND_FLAGS = {
  btcCloseDailyAbove65000: true,
  pullbackHolds: true,
  marketStructureBullish: true,
  ethConfirms: true,
  altBreadthPositive: true,
};
const NEUTRAL_FLAGS = {
  btcClose4hAbove62000: true,
  retest62000Hold: true,
  btcHigherLow: true,
  ethConfirms: true,
  altBreadthImproves: true,
  volumeNotDead: true,
};

describe("detectRegime", () => {
  it("returns each regime for its canonical flag set", () => {
    expect(detectRegime(base(BEAR_TREND_FLAGS))).toBe("BEAR_TREND");
    expect(detectRegime(base(TREND_FLAGS))).toBe("TREND_RECOVERY");
    expect(detectRegime(base(NEUTRAL_FLAGS))).toBe("NEUTRAL_RECOVERY");
    expect(detectRegime(base({ btcBelow60000: true }))).toBe("BEARISH_CHOPPY_DEFENSIVE");
    expect(detectRegime(base({ btcBelow62000: true, marketBreadthWeak: true }))).toBe(
      "BEARISH_CHOPPY_DEFENSIVE",
    );
    expect(detectRegime(base({}))).toBe("NO_TRADE");
  });

  it("honors priority: BEAR_TREND wins over a co-present bearish-chop signal", () => {
    expect(detectRegime(base({ ...BEAR_TREND_FLAGS, btcBelow60000: true }))).toBe("BEAR_TREND");
  });

  it("honors priority: a confirmed TREND_RECOVERY is not shadowed by stale bearish flags", () => {
    expect(
      detectRegime(base({ ...TREND_FLAGS, btcBelow62000: true, marketBreadthWeak: true })),
    ).toBe("TREND_RECOVERY");
  });

  it("bearish-chop needs weak breadth when only below 62000 (not below 60000)", () => {
    expect(detectRegime(base({ btcBelow62000: true, marketBreadthWeak: false }))).toBe("NO_TRADE");
  });
});

describe("evaluateNoTrade", () => {
  it("passes a clean context", () => {
    expect(evaluateNoTrade(base({})).triggered).toBe(false);
  });

  it.each([
    ["DAILY_LOSS_CAP", { dailyLossPct: 1.0 }],
    ["CONSECUTIVE_LOSSES", { consecutiveLosses: 2 }],
    ["SPREAD_TOO_WIDE", { spreadBps: 9 }],
    ["SLIPPAGE_TOO_HIGH", { slippageBps: 11 }],
    ["LOW_REGIME_CONFIDENCE", { regimeConfidence: 0.5 }],
    ["BTC_DECISION_ZONE", { isDecisionZone: true }],
    ["VOLATILITY_ABNORMAL", { volatilityTooHigh: true }],
    ["SIGNAL_CONFLICT", { signalConflict: true }],
    ["LIQUIDITY_TOO_THIN", { liquidityTooThin: true }],
    ["FUNDING_RISK_ABNORMAL", { fundingRiskAbnormal: true }],
  ] as Array<[string, Partial<MarketContext>]>)("triggers on %s", (reason, override) => {
    const evalResult = evaluateNoTrade(base(override));
    expect(evalResult.triggered).toBe(true);
    expect(evalResult.reasons).toContain(reason);
  });
});

describe("riskGuard", () => {
  const mode = getStrategyMode("BEARISH_CHOPPY_DEFENSIVE").risk;

  it("allows a clean context", () => {
    expect(riskGuard(base({}), mode).allowed).toBe(true);
  });

  it("rejects daily-loss cap, consecutive losses, max open, max trades, wide spread, high slippage", () => {
    expect(riskGuard(base({ dailyLossPct: 1.0 }), mode).allowed).toBe(false);
    expect(riskGuard(base({ consecutiveLosses: 2 }), mode).allowed).toBe(false);
    expect(riskGuard(base({ openPositions: 1 }), mode).allowed).toBe(false); // mode cap = 1
    expect(riskGuard(base({ tradesToday: 3 }), mode).allowed).toBe(false); // mode cap = 3
    expect(riskGuard(base({ spreadBps: 9 }), mode).allowed).toBe(false);
    expect(riskGuard(base({ slippageBps: 11 }), mode).allowed).toBe(false);
  });

  it("honors a tighter per-context override but never a looser one", () => {
    // Override tighter than the mode's 3/day → rejected at 2.
    expect(riskGuard(base({ tradesToday: 2, maxTradesPerDay: 2 }), mode).allowed).toBe(false);
    // Override "looser" (10/day) cannot loosen below the mode cap of 3 → still rejected at 3.
    expect(riskGuard(base({ tradesToday: 3, maxTradesPerDay: 10 }), mode).allowed).toBe(false);
  });
});

// ── per-lane predicates ──────────────────────────────────────────────────────

describe("lane predicates (shouldEnter true/false)", () => {
  it("SHORT_RALLY_FADE", () => {
    const ok = base({
      regime: "BEARISH_CHOPPY_DEFENSIVE",
      btcBelowKeyResistance: true,
      pricePullbackToVWAPOrEMA20: true,
      rsi1h: 60,
      rejectionCandle: true,
      volumeWeakOnBounce: true,
      marketBreadthWeak: true,
    });
    expect(shortRallyFade.shouldEnter(ok)).toBe(true);
    expect(shortRallyFade.shouldEnter({ ...ok, rsi1h: 80 })).toBe(false); // outside 55-70
    expect(shortRallyFade.shouldEnter({ ...ok, rejectionCandle: false })).toBe(false);
  });

  it("BREAKDOWN_RETEST_SHORT (both bearish regimes)", () => {
    const ok = base({
      regime: "BEARISH_CHOPPY_DEFENSIVE",
      supportBroken: true,
      closeBelowSupport: true,
      retestOldSupport: true,
      retestFailed: true,
      btcStillWeak: true,
    });
    expect(breakdownRetestShort.shouldEnter(ok)).toBe(true);
    expect(breakdownRetestShort.shouldEnter({ ...ok, regime: "BEAR_TREND" })).toBe(true);
    expect(breakdownRetestShort.shouldEnter({ ...ok, retestFailed: false })).toBe(false);
  });

  it("MICRO_MEAN_REVERSION", () => {
    const ok = base({
      regime: "BEARISH_CHOPPY_DEFENSIVE",
      priceNearLowerRange: true,
      rsiShortTf: 20,
      liquidationFlushDetected: true,
      btcNotBreakingMajorSupport: true,
    });
    expect(microMeanReversion.shouldEnter(ok)).toBe(true);
    expect(microMeanReversion.shouldEnter({ ...ok, rsiShortTf: 30 })).toBe(false); // not < 25
    expect(microMeanReversion.shouldEnter({ ...ok, liquidationFlushDetected: false })).toBe(false);
  });

  it("PULLBACK_LONG_SCALP", () => {
    const ok = base({
      regime: "NEUTRAL_RECOVERY",
      btcClose4hAbove62000: true,
      pullbackToSupport: true,
      supportHolds: true,
      volumeNotDead: true,
      marketBreadthPositive: true,
    });
    expect(pullbackLongScalp.shouldEnter(ok)).toBe(true);
    expect(pullbackLongScalp.shouldEnter({ ...ok, supportHolds: false })).toBe(false);
  });

  it("BREAKOUT_RETEST_LONG (both recovery regimes)", () => {
    const ok = base({
      regime: "NEUTRAL_RECOVERY",
      resistanceBroken: true,
      retestResistanceAsSupport: true,
      higherLowFormed: true,
      marketBreadthPositive: true,
      volumeExpansion: true,
    });
    expect(breakoutRetestLong.shouldEnter(ok)).toBe(true);
    expect(breakoutRetestLong.shouldEnter({ ...ok, regime: "TREND_RECOVERY" })).toBe(true);
    expect(breakoutRetestLong.shouldEnter({ ...ok, volumeExpansion: false })).toBe(false);
  });

  it("RELATIVE_STRENGTH_LONG", () => {
    const ok = base({
      regime: "NEUTRAL_RECOVERY",
      btcStableAboveSupport: true,
      coinOutperformsBTC: true,
      coinAboveVWAP: true,
      volumeExpansion: true,
      liquidityGood: true,
    });
    expect(relativeStrengthLong.shouldEnter(ok)).toBe(true);
    expect(relativeStrengthLong.shouldEnter({ ...ok, coinOutperformsBTC: false })).toBe(false);
  });

  it("every lane forbids averaging-down and martingale", () => {
    for (const lane of [
      shortRallyFade,
      breakdownRetestShort,
      microMeanReversion,
      pullbackLongScalp,
      breakoutRetestLong,
      relativeStrengthLong,
    ]) {
      expect(lane.risk.allowAveragingDown).toBe(false);
      expect(lane.risk.allowMartingale).toBe(false);
    }
  });
});

// ── master decision ──────────────────────────────────────────────────────────

describe("buildTradingDecision", () => {
  it("enters SHORT_RALLY_FADE in bearish-chop with a valid fade setup", () => {
    const d = buildTradingDecision(
      base({
        btcBelow60000: true,
        btcBelowKeyResistance: true,
        pricePullbackToVWAPOrEMA20: true,
        rsi1h: 62,
        rejectionCandle: true,
        volumeWeakOnBounce: true,
        marketBreadthWeak: true,
      }),
    );
    expect(d.action).toBe("ENTER_SHORT");
    if (d.action === "ENTER_SHORT") {
      expect(d.lane).toBe("SHORT_RALLY_FADE");
      expect(d.regime).toBe("BEARISH_CHOPPY_DEFENSIVE");
      expect(d.exit.takeProfitATR).toBe(0.5);
    }
  });

  it("returns NO_TRADE when a valid setup collides with a no-trade trigger", () => {
    const d = buildTradingDecision(
      base({
        btcBelow60000: true,
        btcBelowKeyResistance: true,
        pricePullbackToVWAPOrEMA20: true,
        rsi1h: 62,
        rejectionCandle: true,
        volumeWeakOnBounce: true,
        marketBreadthWeak: true,
        signalConflict: true, // <- conflict
      }),
    );
    expect(d.action).toBe("NO_TRADE");
    if (d.action === "NO_TRADE") expect(d.reason.triggered).toContain("SIGNAL_CONFLICT");
  });

  it("returns NO_TRADE via the risk guard when the book is already full", () => {
    const d = buildTradingDecision(
      base({
        btcBelow60000: true,
        btcBelowKeyResistance: true,
        pricePullbackToVWAPOrEMA20: true,
        rsi1h: 62,
        rejectionCandle: true,
        volumeWeakOnBounce: true,
        marketBreadthWeak: true,
        openPositions: 1, // mode cap = 1
      }),
    );
    expect(d.action).toBe("NO_TRADE");
    if (d.action === "NO_TRADE") {
      expect(String(d.reason.triggered)).toContain("RISK_GUARD");
    }
  });

  it("allows the ONE long exception in bearish-chop: MICRO_MEAN_REVERSION", () => {
    const d = buildTradingDecision(
      base({
        btcBelow60000: true,
        priceNearLowerRange: true,
        rsiShortTf: 18,
        liquidationFlushDetected: true,
        btcNotBreakingMajorSupport: true,
      }),
    );
    expect(d.action).toBe("ENTER_LONG");
    if (d.action === "ENTER_LONG") expect(d.lane).toBe("MICRO_MEAN_REVERSION");
  });

  it("never enters a NON-micro long in bearish-chop, even with long-ish structure", () => {
    const d = buildTradingDecision(
      base({
        btcBelow60000: true, // forces BEARISH_CHOPPY_DEFENSIVE
        // pullback-long business flags present, but this is a bearish regime:
        pullbackToSupport: true,
        supportHolds: true,
        marketBreadthPositive: true,
        volumeNotDead: true,
      }),
    );
    expect(d.action).toBe("NO_TRADE");
  });

  it("never enters a short in NEUTRAL_RECOVERY, even with breakdown structure", () => {
    const d = buildTradingDecision(
      base({
        ...NEUTRAL_FLAGS, // forces NEUTRAL_RECOVERY
        supportBroken: true,
        closeBelowSupport: true,
        retestOldSupport: true,
        retestFailed: true,
        btcStillWeak: true,
      }),
    );
    expect(d.action).not.toBe("ENTER_SHORT");
  });

  it("enters PULLBACK_LONG_SCALP on a clean neutral-recovery pullback", () => {
    const d = buildTradingDecision(
      base({
        ...NEUTRAL_FLAGS,
        pullbackToSupport: true,
        supportHolds: true,
        marketBreadthPositive: true,
      }),
    );
    expect(d.action).toBe("ENTER_LONG");
    if (d.action === "ENTER_LONG") expect(d.lane).toBe("PULLBACK_LONG_SCALP");
  });

  it("stands aside entirely in the NO_TRADE regime", () => {
    const d = buildTradingDecision(base({}));
    expect(d.action).toBe("NO_TRADE");
    if (d.action === "NO_TRADE") expect(d.reason.triggered).toContain("REGIME_NO_TRADE");
  });
});

describe("strategy modes", () => {
  it("every mode disables the entire forbidden lane set", () => {
    for (const regime of Object.keys(STRATEGY_MODES) as Regime[]) {
      const disabled = STRATEGY_MODES[regime].disabledLanes;
      for (const forbidden of FORBIDDEN_LANES) {
        expect(disabled).toContain(forbidden);
      }
    }
  });

  it("BEAR_TREND only permits breakdown-short + no-trade (all long + fade lanes disabled)", () => {
    const disabled = STRATEGY_MODES.BEAR_TREND.disabledLanes;
    expect(disabled).toContain("SHORT_RALLY_FADE");
    expect(disabled).toContain("PULLBACK_LONG_SCALP");
    expect(disabled).not.toContain("BREAKDOWN_RETEST_SHORT");
  });
});

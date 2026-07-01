import type { MarketContext, StrategyLane } from "../types.js";
import { makeRiskConfig } from "../constants.js";
import { passesLaneFloor } from "./laneKit.js";

// ─────────────────────────────────────────────────────────────────────────────
// BREAKOUT RETEST LONG — resistance-becomes-support continuation.
//
// Eligible in NEUTRAL_RECOVERY and TREND_RECOVERY. Enter only once broken
// resistance has been retested AS support with a higher low, on breadth + volume
// expansion. (The lane-floor also blocks a losing day / wide book — stricter than
// the raw spec list, and harmless since the guards enforce it anyway.)
// ─────────────────────────────────────────────────────────────────────────────

export const breakoutRetestLong: StrategyLane = {
  id: "BREAKOUT_RETEST_LONG",
  action: "ENTER_LONG",
  enabledRegimes: ["NEUTRAL_RECOVERY", "TREND_RECOVERY"],
  exit: {
    takeProfitATR: 0.8,
    stopLossATR: 0.6,
    maxHoldMinutes: 180,
    moveStopToBreakevenAfterATR: 0.4,
    breakevenStopMode: "NET_BREAKEVEN",
  },
  risk: makeRiskConfig(0.2, 1),
  shouldEnter(ctx: MarketContext): boolean {
    return (
      (ctx.regime === "NEUTRAL_RECOVERY" || ctx.regime === "TREND_RECOVERY") &&
      ctx.resistanceBroken === true &&
      ctx.retestResistanceAsSupport === true &&
      ctx.higherLowFormed === true &&
      ctx.marketBreadthPositive === true &&
      ctx.volumeExpansion === true &&
      passesLaneFloor(ctx)
    );
  },
};

import type { MarketContext, StrategyLane } from "../types.js";
import { makeRiskConfig } from "../constants.js";
import { passesLaneFloor } from "./laneKit.js";

// ─────────────────────────────────────────────────────────────────────────────
// PULLBACK LONG SCALP — primary lane for NEUTRAL_RECOVERY.
//
// Do NOT chase the green candle. Wait for the breakout, the pullback into
// support, and a HOLD of that support on non-dead volume with positive breadth.
// Only after BTC has reclaimed 62k on the 4H.
// ─────────────────────────────────────────────────────────────────────────────

export const pullbackLongScalp: StrategyLane = {
  id: "PULLBACK_LONG_SCALP",
  action: "ENTER_LONG",
  enabledRegimes: ["NEUTRAL_RECOVERY"],
  exit: {
    takeProfitATR: 0.6,
    stopLossATR: 0.5,
    maxHoldMinutes: 120,
    moveStopToBreakevenAfterATR: 0.35,
    breakevenStopMode: "NET_BREAKEVEN",
  },
  risk: makeRiskConfig(0.2, 1),
  shouldEnter(ctx: MarketContext): boolean {
    return (
      ctx.regime === "NEUTRAL_RECOVERY" &&
      ctx.btcClose4hAbove62000 === true &&
      ctx.pullbackToSupport === true &&
      ctx.supportHolds === true &&
      ctx.volumeNotDead === true &&
      ctx.marketBreadthPositive === true &&
      passesLaneFloor(ctx)
    );
  },
};

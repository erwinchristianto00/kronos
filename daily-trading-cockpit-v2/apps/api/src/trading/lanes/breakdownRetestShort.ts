import type { MarketContext, StrategyLane } from "../types.js";
import { makeRiskConfig } from "../constants.js";
import { passesLaneFloor } from "./laneKit.js";

// ─────────────────────────────────────────────────────────────────────────────
// BREAKDOWN RETEST SHORT — secondary lane for bearish continuation.
//
// Do NOT chase the first breakdown candle. Wait for the support break, the
// retest of old support (now resistance), and a FAILED reclaim.
// ─────────────────────────────────────────────────────────────────────────────

export const breakdownRetestShort: StrategyLane = {
  id: "BREAKDOWN_RETEST_SHORT",
  action: "ENTER_SHORT",
  enabledRegimes: ["BEARISH_CHOPPY_DEFENSIVE", "BEAR_TREND"],
  exit: {
    takeProfitATR: 0.7,
    stopLossATR: 0.8,
    maxHoldMinutes: 90,
    moveStopToBreakevenAfterATR: 0.4,
  },
  risk: makeRiskConfig(0.15, 1),
  shouldEnter(ctx: MarketContext): boolean {
    return (
      (ctx.regime === "BEARISH_CHOPPY_DEFENSIVE" || ctx.regime === "BEAR_TREND") &&
      ctx.supportBroken === true &&
      ctx.closeBelowSupport === true &&
      ctx.retestOldSupport === true &&
      ctx.retestFailed === true &&
      ctx.btcStillWeak === true &&
      passesLaneFloor(ctx)
    );
  },
};

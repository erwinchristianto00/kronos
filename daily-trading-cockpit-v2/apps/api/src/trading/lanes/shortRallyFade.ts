import type { MarketContext, StrategyLane } from "../types.js";
import { GUARD_THRESHOLDS, makeRiskConfig } from "../constants.js";
import { inRange, passesLaneFloor } from "./laneKit.js";

// ─────────────────────────────────────────────────────────────────────────────
// SHORT RALLY FADE — primary lane for BEARISH_CHOPPY_DEFENSIVE.
//
// Do NOT short after price has already dumped. Wait for a WEAK bounce and short
// only after rejection from VWAP / EMA20 / local resistance on weak volume.
// ─────────────────────────────────────────────────────────────────────────────

export const shortRallyFade: StrategyLane = {
  id: "SHORT_RALLY_FADE",
  action: "ENTER_SHORT",
  enabledRegimes: ["BEARISH_CHOPPY_DEFENSIVE"],
  exit: {
    takeProfitATR: 0.5,
    stopLossATR: 0.7,
    maxHoldMinutes: 60,
    moveStopToBreakevenAfterATR: 0.35,
    breakevenStopMode: "NET_BREAKEVEN",
  },
  risk: makeRiskConfig(0.15, 1),
  shouldEnter(ctx: MarketContext): boolean {
    return (
      ctx.regime === "BEARISH_CHOPPY_DEFENSIVE" &&
      ctx.btcBelowKeyResistance === true &&
      ctx.pricePullbackToVWAPOrEMA20 === true &&
      inRange(ctx.rsi1h, GUARD_THRESHOLDS.shortFadeRsiLow, GUARD_THRESHOLDS.shortFadeRsiHigh) &&
      ctx.rejectionCandle === true &&
      ctx.volumeWeakOnBounce === true &&
      ctx.marketBreadthWeak === true &&
      passesLaneFloor(ctx)
    );
  },
};

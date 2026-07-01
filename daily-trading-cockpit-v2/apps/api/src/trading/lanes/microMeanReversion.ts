import type { MarketContext, StrategyLane } from "../types.js";
import { GUARD_THRESHOLDS, makeRiskConfig } from "../constants.js";
import { passesLaneFloor } from "./laneKit.js";

// ─────────────────────────────────────────────────────────────────────────────
// MICRO MEAN REVERSION — small lane only (the ONE long allowed in bearish chop).
//
// Quick bounce scalp after an EXTREME flush. This is NOT bottom fishing, NOT DCA,
// NOT hold-until-recovery: tiny size (0.05%), tight 20-minute time-stop, and it
// only fires when BTC is NOT breaking major support (i.e. a flush inside a range,
// not the start of a trend leg down).
// ─────────────────────────────────────────────────────────────────────────────

export const microMeanReversion: StrategyLane = {
  id: "MICRO_MEAN_REVERSION",
  action: "ENTER_LONG",
  enabledRegimes: ["BEARISH_CHOPPY_DEFENSIVE"],
  exit: {
    takeProfitATR: 0.3,
    stopLossATR: 0.5,
    maxHoldMinutes: 20,
  },
  risk: makeRiskConfig(0.05, 1),
  shouldEnter(ctx: MarketContext): boolean {
    return (
      ctx.regime === "BEARISH_CHOPPY_DEFENSIVE" &&
      ctx.priceNearLowerRange === true &&
      typeof ctx.rsiShortTf === "number" &&
      ctx.rsiShortTf < GUARD_THRESHOLDS.microReversionRsiMax &&
      ctx.liquidationFlushDetected === true &&
      ctx.btcNotBreakingMajorSupport === true &&
      passesLaneFloor(ctx)
    );
  },
};

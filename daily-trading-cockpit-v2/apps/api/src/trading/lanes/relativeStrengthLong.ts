import type { MarketContext, StrategyLane } from "../types.js";
import { makeRiskConfig } from "../constants.js";
import { passesLaneFloor } from "./laneKit.js";

// ─────────────────────────────────────────────────────────────────────────────
// RELATIVE STRENGTH LONG — satellite lane for NEUTRAL_RECOVERY, only once BTC is
// STABLE above support.
//
// Do NOT buy weak alts because they are "cheap". Buy the coin that OUTPERFORMS
// BTC while BTC is stable, above VWAP, on volume expansion and good liquidity.
// ─────────────────────────────────────────────────────────────────────────────

export const relativeStrengthLong: StrategyLane = {
  id: "RELATIVE_STRENGTH_LONG",
  action: "ENTER_LONG",
  enabledRegimes: ["NEUTRAL_RECOVERY"],
  exit: {
    takeProfitATR: 0.8,
    stopLossATR: 0.7,
    maxHoldMinutes: 180,
  },
  risk: makeRiskConfig(0.15, 1),
  shouldEnter(ctx: MarketContext): boolean {
    return (
      ctx.regime === "NEUTRAL_RECOVERY" &&
      ctx.btcStableAboveSupport === true &&
      ctx.coinOutperformsBTC === true &&
      ctx.coinAboveVWAP === true &&
      ctx.volumeExpansion === true &&
      ctx.liquidityGood === true &&
      passesLaneFloor(ctx)
    );
  },
};

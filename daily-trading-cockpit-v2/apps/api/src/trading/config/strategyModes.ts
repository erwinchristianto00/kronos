import type { Regime, StrategyMode } from "../types.js";
import { FORBIDDEN_LANES } from "../constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-regime strategy modes: lane allocation intent, mode-level risk governance
// (caps + cooldowns consumed by riskGuard), execution preferences, and the
// explicit ban-list. Every mode's `disabledLanes` includes the global
// FORBIDDEN_LANES so no regime can ever surface a martingale/DCA/averaging lane.
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN = [...FORBIDDEN_LANES];

export const STRATEGY_MODES: Record<Regime, StrategyMode> = {
  BEAR_TREND: {
    regime: "BEAR_TREND",
    laneWeight: {
      BREAKDOWN_RETEST_SHORT: 0.7,
      NO_TRADE: 0.3,
    },
    risk: {
      maxOpenPositions: 1,
      maxTradesPerDay: 2,
      maxDailyLossPct: 1.0,
      riskPerTradePct: 0.15,
      cooldownAfterLossMinutes: 45,
      cooldownAfterTwoLossesMinutes: 180,
    },
    execution: {
      preferMakerOrders: true,
      avoidMarketOrderDuringSpike: true,
      maxSpreadBps: 8,
      maxSlippageBps: 10,
    },
    // Only breakdown-retest-short and no-trade are allowed; everything long is off.
    disabledLanes: [
      ...FORBIDDEN,
      "SHORT_RALLY_FADE",
      "MICRO_MEAN_REVERSION",
      "PULLBACK_LONG_SCALP",
      "BREAKOUT_RETEST_LONG",
      "RELATIVE_STRENGTH_LONG",
    ],
  },

  BEARISH_CHOPPY_DEFENSIVE: {
    regime: "BEARISH_CHOPPY_DEFENSIVE",
    laneWeight: {
      SHORT_RALLY_FADE: 0.55,
      BREAKDOWN_RETEST_SHORT: 0.25,
      MICRO_MEAN_REVERSION: 0.1,
      NO_TRADE: 0.1,
    },
    risk: {
      maxOpenPositions: 1,
      maxTradesPerDay: 3,
      maxDailyLossPct: 1.0,
      riskPerTradePct: 0.15,
      cooldownAfterLossMinutes: 45,
      cooldownAfterTwoLossesMinutes: 180,
    },
    execution: {
      preferMakerOrders: true,
      avoidMarketOrderDuringSpike: true,
      maxSpreadBps: 8,
      maxSlippageBps: 10,
    },
    disabledLanes: [
      ...FORBIDDEN,
      "PULLBACK_LONG_SCALP",
      "BREAKOUT_RETEST_LONG",
      "RELATIVE_STRENGTH_LONG",
    ],
  },

  NEUTRAL_RECOVERY: {
    regime: "NEUTRAL_RECOVERY",
    laneWeight: {
      PULLBACK_LONG_SCALP: 0.45,
      BREAKOUT_RETEST_LONG: 0.3,
      RELATIVE_STRENGTH_LONG: 0.15,
      NO_TRADE: 0.1,
    },
    risk: {
      maxOpenPositions: 1,
      maxTradesPerDay: 4,
      maxDailyLossPct: 1.0,
      riskPerTradePct: 0.2,
      cooldownAfterLossMinutes: 45,
      cooldownAfterTwoLossesMinutes: 180,
    },
    execution: {
      preferMakerOrders: true,
      avoidMarketOrderDuringSpike: true,
      maxSpreadBps: 8,
      maxSlippageBps: 10,
    },
    disabledLanes: [
      ...FORBIDDEN,
      "SHORT_RALLY_FADE",
      "BREAKDOWN_RETEST_SHORT",
      "MICRO_MEAN_REVERSION",
    ],
  },

  TREND_RECOVERY: {
    regime: "TREND_RECOVERY",
    laneWeight: {
      // LONG_PULLBACK_TREND + MOMENTUM_CONTINUATION are TODO (modules not built yet).
      LONG_PULLBACK_TREND: 0.45,
      BREAKOUT_RETEST_LONG: 0.3,
      MOMENTUM_CONTINUATION: 0.15,
      NO_TRADE: 0.1,
    },
    risk: {
      maxOpenPositions: 2,
      maxTradesPerDay: 5,
      maxDailyLossPct: 1.25,
      riskPerTradePct: 0.25,
      cooldownAfterLossMinutes: 30,
      cooldownAfterTwoLossesMinutes: 120,
    },
    execution: {
      preferMakerOrders: true,
      avoidMarketOrderDuringSpike: true,
      maxSpreadBps: 8,
      maxSlippageBps: 10,
    },
    disabledLanes: [
      ...FORBIDDEN,
      "SHORT_RALLY_FADE",
      "BREAKDOWN_RETEST_SHORT",
      "MICRO_MEAN_REVERSION",
    ],
  },

  NO_TRADE: {
    regime: "NO_TRADE",
    laneWeight: { NO_TRADE: 1.0 },
    risk: {
      maxOpenPositions: 0,
      maxTradesPerDay: 0,
      maxDailyLossPct: 1.0,
      riskPerTradePct: 0,
      cooldownAfterLossMinutes: 45,
      cooldownAfterTwoLossesMinutes: 180,
    },
    execution: {
      preferMakerOrders: true,
      avoidMarketOrderDuringSpike: true,
      maxSpreadBps: 8,
      maxSlippageBps: 10,
    },
    // Everything off.
    disabledLanes: [
      ...FORBIDDEN,
      "SHORT_RALLY_FADE",
      "BREAKDOWN_RETEST_SHORT",
      "MICRO_MEAN_REVERSION",
      "PULLBACK_LONG_SCALP",
      "BREAKOUT_RETEST_LONG",
      "RELATIVE_STRENGTH_LONG",
    ],
  },
};

export function getStrategyMode(regime: Regime): StrategyMode {
  return STRATEGY_MODES[regime];
}

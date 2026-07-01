// ─────────────────────────────────────────────────────────────────────────────
// Regime-based strategy framework — shared types.
//
// This module set is a HYPOTHESIS. Every lane is unproven until it survives a
// backtest + walk-forward + fee/slippage/funding model + paper trading. Nothing
// here is wired into the live execution engine. Detection and lane functions are
// PURE: they evaluate a MarketContext and return a decision. No exchange calls,
// no side effects, no clock reads.
// ─────────────────────────────────────────────────────────────────────────────

export type Regime =
  | "BEAR_TREND"
  | "BEARISH_CHOPPY_DEFENSIVE"
  | "NEUTRAL_RECOVERY"
  | "TREND_RECOVERY"
  | "NO_TRADE";

/** Active lanes this framework actually implements. */
export type LaneId =
  | "SHORT_RALLY_FADE"
  | "BREAKDOWN_RETEST_SHORT"
  | "MICRO_MEAN_REVERSION"
  | "PULLBACK_LONG_SCALP"
  | "BREAKOUT_RETEST_LONG"
  | "RELATIVE_STRENGTH_LONG"
  | "NO_TRADE";

export type EntryAction = "ENTER_LONG" | "ENTER_SHORT";

export interface ExitConfig {
  /** Take-profit distance as a multiple of ATR. */
  takeProfitATR: number;
  /** Stop-loss distance as a multiple of ATR. */
  stopLossATR: number;
  /** Hard time-stop: close the position after this many minutes regardless of PnL. */
  maxHoldMinutes: number;
  /** Once price has moved this many ATR in favor, ratchet the stop to breakeven. */
  moveStopToBreakevenAfterATR?: number;
}

export interface RiskConfig {
  riskPerTradePct: number;
  maxOpenPositions: number;
  /** HARD INVARIANT: always false. Averaging down is forbidden framework-wide. */
  allowAveragingDown: boolean;
  /** HARD INVARIANT: always false. Martingale is forbidden framework-wide. */
  allowMartingale: boolean;
}

export type TradingDecision =
  | {
      action: "ENTER_LONG";
      lane: LaneId;
      regime: Regime;
      exit: ExitConfig;
      risk: RiskConfig;
    }
  | {
      action: "ENTER_SHORT";
      lane: LaneId;
      regime: Regime;
      exit: ExitConfig;
      risk: RiskConfig;
    }
  | {
      action: "NO_TRADE";
      regime: Regime;
      reason: Record<string, unknown>;
    };

/**
 * Flat, fully-optional context bag describing the market at decision time. It is
 * intentionally boolean-heavy: the upstream feature layer (indicators, breadth,
 * microstructure) is responsible for reducing raw candles/orderbook into these
 * flags, keeping the strategy functions pure and trivially testable. Numeric
 * governance fields (dailyLossPct, spreadBps, …) are required because every guard
 * depends on them.
 */
export interface MarketContext {
  // ── BTC macro / regime structure ─────────────────────────────────────────
  btcBelow60000?: boolean;
  btcBelow62000?: boolean;
  btcBreaksBelow55000?: boolean;
  btcClose4hAbove62000?: boolean;
  btcCloseDailyAbove65000?: boolean;
  retest62000Hold?: boolean;
  retestFailed?: boolean;
  btcHigherLow?: boolean;
  /** TREND_RECOVERY: the pullback into the daily structure held (higher-low intact). */
  pullbackHolds?: boolean;
  ethConfirms?: boolean;
  altBreadthImproves?: boolean;
  altBreadthPositive?: boolean;
  marketBreadthWeak?: boolean;
  marketBreadthPositive?: boolean;
  marketBreadthCollapses?: boolean;
  marketStructureBullish?: boolean;
  volumeNotDead?: boolean;
  volumeExpansion?: boolean;

  // ── Short-rally-fade inputs ──────────────────────────────────────────────
  btcBelowKeyResistance?: boolean;
  pricePullbackToVWAPOrEMA20?: boolean;
  rsi1h?: number;
  rejectionCandle?: boolean;
  volumeWeakOnBounce?: boolean;

  // ── Breakdown-retest-short inputs ────────────────────────────────────────
  supportBroken?: boolean;
  closeBelowSupport?: boolean;
  retestOldSupport?: boolean;
  btcStillWeak?: boolean;

  // ── Micro-mean-reversion inputs ──────────────────────────────────────────
  priceNearLowerRange?: boolean;
  rsiShortTf?: number;
  liquidationFlushDetected?: boolean;
  btcNotBreakingMajorSupport?: boolean;

  // ── Long-side (recovery) inputs ──────────────────────────────────────────
  pullbackToSupport?: boolean;
  supportHolds?: boolean;
  resistanceBroken?: boolean;
  retestResistanceAsSupport?: boolean;
  higherLowFormed?: boolean;
  btcStableAboveSupport?: boolean;
  coinOutperformsBTC?: boolean;
  coinAboveVWAP?: boolean;
  liquidityGood?: boolean;
  liquidityTooThin?: boolean;

  // ── Governance / guards (required) ───────────────────────────────────────
  dailyLossPct: number;
  consecutiveLosses: number;
  spreadBps: number;
  slippageBps: number;
  regimeConfidence: number;

  // ── No-trade risk flags ──────────────────────────────────────────────────
  isDecisionZone?: boolean;
  volatilityTooHigh?: boolean;
  signalConflict?: boolean;
  fundingRiskAbnormal?: boolean;

  // ── Position / activity counters (used by riskGuard) ─────────────────────
  openPositions?: number;
  tradesToday?: number;

  // ── Optional per-context overrides of mode caps (else mode config wins) ──
  maxDailyLossPct?: number;
  maxOpenPositions?: number;
  maxTradesPerDay?: number;
  maxSpreadBps?: number;
  maxSlippageBps?: number;

  // ── Enrichment (filled by buildTradingDecision after detection) ──────────
  regime?: Regime;
}

/** A lane is a self-contained entry hypothesis. `shouldEnter` must be pure. */
export interface StrategyLane {
  id: LaneId;
  action: EntryAction;
  /** Regimes in which this lane is even eligible to be routed. */
  enabledRegimes: Regime[];
  exit: ExitConfig;
  risk: RiskConfig;
  /** Pure predicate: given the (regime-enriched) context, should we enter? */
  shouldEnter(ctx: MarketContext): boolean;
}

export interface GuardResult {
  allowed: boolean;
  reason: string;
}

export type OrderType = "maker" | "market";

export interface ExecutionDirective {
  allowed: boolean;
  reason: string;
  orderType: OrderType;
  maxHoldMinutes: number;
  moveStopToBreakevenAfterATR?: number;
}

// ── Strategy mode configuration (per regime) ────────────────────────────────

export interface ModeRiskConfig {
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxDailyLossPct: number;
  riskPerTradePct: number;
  cooldownAfterLossMinutes: number;
  cooldownAfterTwoLossesMinutes: number;
}

export interface ModeExecutionConfig {
  preferMakerOrders: boolean;
  avoidMarketOrderDuringSpike: boolean;
  maxSpreadBps: number;
  maxSlippageBps: number;
}

export interface StrategyMode {
  regime: Regime;
  /** Soft allocation intent across lanes; NOT used to force entries, only to document/size. */
  laneWeight: Partial<Record<string, number>>;
  risk: ModeRiskConfig;
  execution: ModeExecutionConfig;
  /** Lanes explicitly banned in this regime (superset of the global forbidden set). */
  disabledLanes: string[];
}

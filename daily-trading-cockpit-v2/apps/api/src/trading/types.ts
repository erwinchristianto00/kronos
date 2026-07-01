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

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/**
 * Multi-timeframe freshness budget. The feature layer stamps, per timeframe, the
 * close time of the last candle it used and how stale that candle is allowed to
 * be before the derived flags for that timeframe are untrustworthy. `isContextStale`
 * (contextIntegrity.ts) compares `lastCandleCloseMs + maxStalenessMs` against
 * `MarketContext.asOf`.
 *
 * TODO(freshness): today this is a single flat check. A richer future version
 * should (a) let each LANE declare which timeframes it depends on so a stale 4H
 * only vetoes lanes that read the 4H, and (b) distinguish "no data yet" from
 * "data went stale" for clearer diagnostics.
 */
export interface TimeframeFreshness {
  timeframe: Timeframe;
  /** Close time (epoch ms) of the most recent candle used for this timeframe. */
  lastCandleCloseMs: number;
  /** Max age (ms) past the candle close before this timeframe is considered stale. */
  maxStalenessMs: number;
}

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

/** Which gate produced (or blocked) a decision — for logging/telemetry. */
export type RejectedBy =
  | "CONTRADICTORY_CONTEXT"
  | "DATA_STALE"
  | "MISSING_EXECUTION_DATA"
  | "REGIME_NO_TRADE"
  | "NO_TRADE_GUARD"
  | "RISK_GUARD"
  | "EXECUTION_GUARD"
  | "FORBIDDEN_LANE_HARD_GATE"
  | "NO_VALID_LANE_SETUP";

/**
 * Structured decision log. Always attached by buildTradingDecision so every
 * outcome (entry or stand-aside) is fully explainable after the fact. Optional on
 * the type so decisions built by lower-level helpers still typecheck.
 */
export interface DecisionTrace {
  detectedRegime: Regime;
  selectedLane: LaneId | null;
  /** The gate that caused a NO_TRADE (null when an entry was taken). */
  rejectedBy: RejectedBy | null;
  /** No-trade guard trigger codes (null when the guard did not fire). */
  noTradeReason: string[] | null;
  riskGuardReason: string | null;
  /** The execution-guard reason from the last lane that was signal-valid but exec-blocked. */
  executionGuardReason: string | null;
  /** Contradiction codes detected in the context (empty when none). */
  contradictions: string[];
  /** Optional map from flat flags back to their source timeframe(s) or supplied source. */
  featureSources?: FeatureSourceMap;
}

export type TradingDecision =
  | {
      action: "ENTER_LONG";
      lane: LaneId;
      regime: Regime;
      exit: ExitConfig;
      risk: RiskConfig;
      trace?: DecisionTrace;
    }
  | {
      action: "ENTER_SHORT";
      lane: LaneId;
      regime: Regime;
      exit: ExitConfig;
      risk: RiskConfig;
      trace?: DecisionTrace;
    }
  | {
      action: "NO_TRADE";
      regime: Regime;
      reason: Record<string, unknown>;
      trace?: DecisionTrace;
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
  /** Breadth universe provenance. CURRENT_HIGH_LIQUIDITY_MAJORS is a documented survivorship-bias risk. */
  breadthUniverseKind?: BreadthUniverseKind;
  breadthUniverseSnapshotMs?: number;
  breadthUniverseDescription?: string;
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
  liquidityTier?: LiquidityTier;
  liquiditySource?: LiquiditySource;

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

  // ── Data freshness (multi-timeframe) ─────────────────────────────────────
  /** Decision timestamp (epoch ms). Freshness checks compare candle ages to this. */
  asOf?: number;
  /** Per-timeframe last-close timestamps + staleness budgets (see TimeframeFreshness). */
  freshness?: TimeframeFreshness[];
  /** Coarse escape hatch: upstream may set this directly to force a no-trade. */
  dataStale?: boolean;
  /** Optional provenance for flattened flags, filled by adapters/backtests when available. */
  featureSources?: FeatureSourceMap;

  // ── Enrichment (filled by buildTradingDecision after detection) ──────────
  regime?: Regime;
}

export type FeatureSource =
  | Timeframe
  | "SUPPLIED"
  | "GOVERNANCE"
  | "OVERRIDE"
  | "ASSUMED_BASELINE"
  | "ORDERBOOK_DEPTH"
  | "HEURISTIC"
  | "BREADTH_ADAPTER";
export type FeatureSourceMap = Partial<Record<keyof MarketContext, FeatureSource[]>>;
export type BreadthUniverseKind = "POINT_IN_TIME" | "CURRENT_HIGH_LIQUIDITY_MAJORS" | "CURRENT_LIQUID_UNIVERSE";
export type LiquidityTier = "MAJOR" | "ALT";
export type LiquiditySource = "SUPPLIED" | "ORDERBOOK_DEPTH" | "HEURISTIC_SPREAD_VOLUME";

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

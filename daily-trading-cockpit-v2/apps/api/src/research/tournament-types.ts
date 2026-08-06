/**
 * Kronos Research Tournament v1 — research-only canonical types.
 *
 * No runtime module imports this directory.  A tournament run is valid only when
 * the dataset and point-in-time universe contracts below are complete.
 */

export const TOURNAMENT_VERSION = "kronos-research-tournament-v1" as const;

export type TournamentExecutionMode = "CONSERVATIVE" | "EXPECTED" | "OPTIMISTIC";
export type TournamentCapabilityTier = "TIER_1_BASELINE" | "TIER_2_EXPECTED_EXECUTION" | "TIER_3_EXACT_KRONOS";
export type TournamentResearchMode = "FIXTURE_SMOKE" | "REAL_TIER1";
export type TournamentEmpiricalClassification = "TEST_ONLY_NON_EMPIRICAL" | "REAL_SOURCE_BACKED";
export type TournamentDatasetArtifactKind = "COMPLETED_CANDLES" | "FUNDING_SETTLEMENTS" | "LISTING_DELISTING_TIMELINE" | "FUTURES_AVAILABILITY_TIMELINE" | "MINIMUM_HISTORY_ELIGIBILITY" | "PIT_LIQUIDITY_SPREAD" | "FEE_ASSUMPTIONS" | "PORTFOLIO_RISK_SNAPSHOTS" | "CANONICAL_EPISODES" | "KRONOS_DECISION_LEDGER";
export type TournamentSide = "LONG" | "SHORT";
export type TournamentExitReason = "STOP" | "TARGET" | "TIME" | "END_OF_DATA" | "REBALANCE";
export type TournamentStrategyId =
  | "CASH"
  | "BTC_BUY_AND_HOLD"
  | "EQUAL_WEIGHT_HOLD"
  | "DONCHIAN"
  | "DONCHIAN_WITH_KRONOS_REGIME"
  | "MACD"
  | "MACD_WITH_KRONOS_REGIME"
  | "EMA_CROSS"
  | "RSI_MEAN_REVERSION"
  | "RANDOM_CONTROL"
  | "KRONOS_CURRENT";

export interface TournamentCandle {
  symbol: string;
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** An eligibility snapshot may only describe information observable at `asOfMs`. */
export interface PointInTimeUniverseSnapshot {
  asOfMs: number;
  eligibleSymbols: string[];
  /** Source artifact hash for the exchange/listing snapshot itself. */
  sourceHash: string;
  /** All checks are required: the runner fails closed when any is absent. */
  evidence: {
    listedThen: true;
    sufficientHistoryThen: true;
    liquidityVolumeEligibleThen: true;
    spreadEligibleThen: true;
    futuresAvailableThen: true;
    delistingCheckedThen: true;
  };
  /** Tier-1 assembler persists every included/excluded symbol decision into the snapshot identity. */
  universeProvenance?: {
    decisionTimeMs: number;
    policyVersion: string;
    thresholds: Record<string, number | string>;
    symbols: Array<{
      symbol: string;
      eligible: boolean;
      reason: string;
      listingState: string;
      listingSourceHash: string;
      futuresAvailable: boolean;
      futuresSourceHash: string;
      minimumHistoryEligible: boolean;
      minimumHistorySourceHash: string;
      liquidityReason: string;
      liquiditySourceHash: string | null;
    }>;
  };
}

export interface TournamentDatasetManifest {
  provider: string;
  dataRange: { startMs: number; endMs: number };
  candlesHash: string;
  fundingHash: string | null;
  /** Hash of point-in-time fee/slippage inputs used by EXPECTED execution. */
  executionInputsHash: string;
  historicalUniverseHash: string;
  canonicalEpisodeHash: string;
  portfolioRiskHash: string;
  /** Immutable Dataset Foundry artifact manifests used in this exact run. */
  /** References Foundry semanticManifestHash values, never rows-only hashes. */
  artifactSemanticManifestHashes: string[];
  artifactKinds: TournamentDatasetArtifactKind[];
  timeframe: string;
  timeframeMs: number;
  universeSnapshots: PointInTimeUniverseSnapshot[];
}

export interface TournamentCostModel {
  makerFeeBps: number;
  takerFeeBps: number;
  baseSlippageBps: number;
  pessimisticSlippageMultiplier: number;
  /** Funding paid per eight-hour interval, signed by position side. */
  fundingEnabled: boolean;
  fillMode: "NEXT_OPEN" | "REALISTIC_LIMIT" | "UPPER_BOUND";
  intrabarAmbiguity: "STOP_FIRST" | "PATH_ASSUMPTION" | "TARGET_FIRST";
}

export interface TournamentPortfolioConstraints {
  startingCapital: number;
  riskPerTradeFraction: number;
  maxPositions: number;
  maxGrossExposureFraction: number;
  maxNetExposureFraction: number;
  maxBtcBetaFraction: number;
  maxCorrelationClusterFraction: number;
  liquidationBufferFraction: number;
  /** Initial margin reserved per unit of gross notional; no implicit leverage. */
  initialMarginFraction: number;
  /** A risk snapshot older than this is invalid, never silently reused. */
  maxPortfolioRiskSnapshotAgeMs: number;
}

export interface TournamentValidationSpec {
  trainBars: number;
  testBars: number;
  stepBars: number;
  purgeBars: number;
  embargoBars: number;
  sealedHoldoutStartMs: number;
  minIndependentEpisodes: number;
  minOosProfitabilityFraction: number;
}

export interface TournamentExperimentSpec {
  tournamentVersion: typeof TOURNAMENT_VERSION;
  gitCommit: string;
  strategyVersion: string;
  randomSeed: number;
  capabilityTier: TournamentCapabilityTier;
  /** Fixture smoke output is permanently non-empirical and cannot enter governance. */
  researchMode: TournamentResearchMode;
  dataset: TournamentDatasetManifest;
  costs: TournamentCostModel;
  portfolio: TournamentPortfolioConstraints;
  validation: TournamentValidationSpec;
  parameters: Record<string, unknown>;
}

export interface TournamentIntent {
  strategyId: TournamentStrategyId;
  symbol: string;
  side: TournamentSide;
  /** Decision is based on the completed candle at `decisionTimeMs`. */
  decisionTimeMs: number;
  /** Execution may only start at the next completed bar's open. */
  entryAtOpenTimeMs: number;
  stopFraction: number | null;
  targetFraction: number | null;
  maxHoldBars: number;
  exitTemplate: string;
  score: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface TournamentTrade {
  tradeId: string;
  strategyId: TournamentStrategyId;
  symbol: string;
  side: TournamentSide;
  entryTimeMs: number;
  exitTimeMs: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notionalAtEntry: number;
  grossPnl: number;
  feeCost: number;
  slippageCost: number;
  fundingCost: number;
  netPnl: number;
  exitReason: TournamentExitReason;
  holdingBars: number;
  marketEpisodeId: string;
  regime: string | null;
}

export interface TournamentNavPoint {
  timestampMs: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  grossExposure: number;
  netExposure: number;
  marginUsage: number;
  liquidationBuffer: number;
}

export interface FundingSettlement {
  symbol: string;
  /** Exchange schedule identity used by both coverage and execution. */
  canonicalSettlementTimeMs: number;
  /** Source-observed timestamp; may differ from canonical identity only within contract tolerance. */
  observedSettlementTimeMs: number;
  alignmentOffsetMs: number;
  scheduleSourceHash: string;
  /** Signed rate: a positive rate is paid by LONG and received by SHORT. */
  rate: number;
  sourceHash: string;
}

export interface PointInTimePortfolioRiskSnapshot {
  asOfMs: number;
  validUntilMs: number;
  sourceHash: string;
  btcBetaBySymbol: Record<string, number>;
  correlationClusterBySymbol: Record<string, string>;
}

export interface TournamentMetrics {
  tradeCount: number;
  independentEpisodes: number;
  expectancyAfterCost: number;
  profitFactor: number | null;
  winRate: number;
  payoffRatio: number | null;
  sharpe: number | null;
  calmar: number | null;
  maxDrawdown: number;
  netPnl: number;
  returnFraction: number;
  profitableAssetRatio: number | null;
  concentration: {
    topSymbolNetPnlShare: number | null;
    topRegimeNetPnlShare: number | null;
    topYearNetPnlShare: number | null;
  };
  canonicalEpisodeProvenanceComplete: boolean;
  /** False when a HALTED final mark leaves an unexecutable open position. */
  terminalPositionsResolved?: boolean;
}

export interface TournamentTerminalOpenPosition {
  symbol: string;
  side: TournamentSide;
  notional: number;
  unrealizedPnl: number;
  blocker: "TERMINAL_POSITION_UNRESOLVED";
}

/** Portfolio-path observability is reported separately from trade-quality metrics. */
export interface TournamentPortfolioMetrics {
  peakOpenPositions: number;
  peakGrossExposureFraction: number;
  peakAbsoluteNetExposureFraction: number;
  peakBtcBetaFraction: number;
  liquidationBufferFraction: number;
  navPointCount: number;
}

export interface TournamentRunManifest {
  runId: string;
  createdAtMs: number;
  empiricalClassification: TournamentEmpiricalClassification;
  spec: TournamentExperimentSpec;
  executionMode: TournamentExecutionMode;
  strategyId: TournamentStrategyId;
  parameterSet: Record<string, unknown>;
  inputHash: string;
}

export interface TournamentRunResult {
  manifest: TournamentRunManifest;
  /** Trade-quality result for this strategy before portfolio-cap observability. */
  strategyMetrics: TournamentMetrics;
  /** Shared-wallet portfolio observability for exactly this strategy run. */
  portfolioMetrics: TournamentPortfolioMetrics;
  /** Alias retained for rank/report consumers; equals strategyMetrics. */
  metrics: TournamentMetrics;
  navLedger: TournamentNavPoint[];
  trades: TournamentTrade[];
  terminalOpenPositions: TournamentTerminalOpenPosition[];
  warnings: string[];
  valid: boolean;
  invalidReasons: string[];
}

export interface TournamentRunRegistryEntry {
  runId: string;
  inputHash: string;
  strategyId: TournamentStrategyId;
  executionMode: TournamentExecutionMode;
  parameterSet: Record<string, unknown>;
  valid: boolean;
  createdAtMs: number;
}

export interface TournamentHardGateVerdict {
  passes: boolean;
  failures: string[];
}

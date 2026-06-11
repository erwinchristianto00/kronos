export type Direction = "LONG" | "SHORT" | "NEUTRAL";
export type FinalStatus = "TRADE_NOW" | "READY" | "WAIT" | "WATCH" | "SKIP";
export type TrendLabel = "BULLISH" | "BEARISH" | "SIDEWAYS";
export type ExternalSignalLabel = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNAVAILABLE";
export type SocialScope = "MARKET" | "SYMBOL";
export type KronosAvailabilityReasonCode =
  | "TIMEOUT"
  | "UNSUPPORTED_SYMBOL"
  | "NOT_ENOUGH_CANDLES"
  | "INVALID_INPUT"
  | "PREDICTION_FAILED"
  | "MODEL_BUSY"
  | "UNAVAILABLE";
export type KronosServiceState = "REACHABLE" | "FORECAST_HEALTHY" | "DEGRADED" | "OFFLINE";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MacdSnapshot {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
}

export interface TimeframeIndicatorSnapshot {
  timeframe: "5m" | "15m" | "1h";
  latestClose: number;
  ema20: number;
  ema50: number;
  ema200: number;
  sma20: number;
  rsi14: number;
  macd: MacdSnapshot;
  bollingerBands20: BollingerBands;
  atr14: number;
  atrPercent: number;
  vwap: number;
  volumeRatio: number | null;
  bodyWickRatio: number;
  support: number;
  resistance: number;
  recentSwingHigh: number;
  recentSwingLow: number;
  distanceFromEma20: number;
  distanceFromVwap: number;
  breakoutHigh: boolean;
  breakoutLow: boolean;
  trend: TrendLabel;
  isFresh: boolean;
  lastOpenTime: number;
}

export interface FibonacciLevels {
  recentHigh: number;
  recentLow: number;
  retracement236: number;
  retracement382: number;
  retracement500: number;
  retracement618: number;
  retracement786: number;
  extension1272: number;
  extension1618: number;
}

export interface AtrPlan {
  atr14: number;
  atrPercent: number;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskReward: number | null;
}

export interface IndicatorSet {
  fiveMinute: TimeframeIndicatorSnapshot;
  fifteenMinute: TimeframeIndicatorSnapshot;
  oneHour: TimeframeIndicatorSnapshot;
  fibonacci: FibonacciLevels;
  atr: AtrPlan;
}

export interface KronosPrediction {
  available: boolean;
  reason?: string;
  availabilityReasonCode?: KronosAvailabilityReasonCode;
  degradedSampling?: boolean;
  kronosLongProbability?: number;
  kronosShortProbability?: number;
  kronosBias?: Direction;
  kronosBias1h?: Direction;
  kronosBias4h?: Direction;
  selectedKronosBias?: Direction;
  expectedReturn3?: number;
  expectedReturn6?: number;
  expectedVolatility?: number;
  kronosConfidence?: number;
  kronosRisk?: number;
  currentPrice?: number;
  forecastMedianClose?: number;
  forecastP25Close?: number;
  forecastP75Close?: number;
  forecastMaxHigh?: number;
  forecastMinLow?: number;
  expectedReturn15m?: number;
  expectedReturn1h?: number;
  expectedReturn4h?: number;
  probabilityUp?: number;
  probabilityDown?: number;
  kronosConfidenceBucket?: "STRONG" | "MEDIUM" | "WEAK";
  horizonConflict?: boolean;
}

export interface WhaleSignal {
  available: boolean;
  signal: ExternalSignalLabel;
  score: number;
  reason?: string;
}

export interface SentimentSignal {
  available: boolean;
  signal: ExternalSignalLabel;
  score: number;
  confidence?: number;
  scope?: SocialScope;
  source?: string;
  reason?: string;
}

export interface VolumeSnapshot {
  quoteVolume24h: number | null;
  baseVolume24h: number | null;
  volumeRatio5m: number | null;
}

export interface SpreadSnapshot {
  bid: number | null;
  ask: number | null;
  absolute: number | null;
  percent: number | null;
}

export interface ChartPoint {
  time: number;
  value: number;
}

export interface Candidate {
  rank: number;
  symbol: string;
  direction: Direction;
  status: FinalStatus;
  longScore: number;
  shortScore: number;
  opportunityScore: number;
  dangerScore: number;
  confidence: number;
  dataQualityScore: number;
  liquidityScore: number;
  volatilityScore: number;
  trendScore: number;
  volumeScore: number;
  kronosScore: number;
  finalDirection: Direction;
  finalStatus: FinalStatus;
  sourceConflict: boolean;
  directionConflict: boolean;
  kronosBias: Direction | "UNAVAILABLE";
  kronosBias1h?: Direction | "UNAVAILABLE" | null;
  kronosBias4h?: Direction | "UNAVAILABLE" | null;
  selectedKronosBias?: Direction | "UNAVAILABLE" | null;
  kronosConfidence: number | null;
  kronosReason?: string | null;
  kronosAvailabilityReasonCode?: KronosAvailabilityReasonCode | null;
  expectedReturn3: number | null;
  expectedReturn6: number | null;
  kronosRisk?: number | null;
  currentPrice?: number | null;
  forecastMedianClose?: number | null;
  forecastP25Close?: number | null;
  forecastP75Close?: number | null;
  forecastMaxHigh?: number | null;
  forecastMinLow?: number | null;
  expectedReturn15m?: number | null;
  expectedReturn1h?: number | null;
  expectedReturn4h?: number | null;
  probabilityUp?: number | null;
  probabilityDown?: number | null;
  kronosConfidenceBucket?: "STRONG" | "MEDIUM" | "WEAK" | null;
  horizonConflict?: boolean | null;
  indicators: IndicatorSet;
  fibonacci: FibonacciLevels;
  atr: AtrPlan;
  volume: VolumeSnapshot;
  spread: SpreadSnapshot;
  whale: WhaleSignal;
  sentiment: SentimentSignal;
  entryZone: [number, number] | null;
  stopLoss: number | null;
  takeProfits: {
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
  };
  riskReward: number | null;
  reason: string[];
  blockers: string[];
  chart: ChartPoint[];
  selectedExecutionPlan?: VariantSelectionSnapshot | null;
}

export interface CoverageSnapshot {
  totalSymbols: number;
  scannedSymbols: number;
  returnedSymbols: number;
  skippedSymbols: number;
  percent: number;
  liveSymbols?: number;
  cacheFreshSymbols?: number;
}

export interface CapabilitySnapshot {
  configured?: boolean;
  available: boolean;
  provider?: string;
  message: string;
  state?: KronosServiceState;
  reachable?: boolean;
  forecastHealthy?: boolean;
  degraded?: boolean;
  attempted?: number;
  succeeded?: number;
  failed?: number;
  timeout?: number;
  invalidInput?: number;
  predictionFailed?: number;
  modelBusy?: number;
  successRate?: number;
}

export interface SymbolFailure {
  symbol: string;
  stage: string;
  failureType: "timeout" | "429" | "network" | "invalid_response" | "unsupported";
  reason: string;
}

export interface ScanDiagnostics {
  universe: string[];
  skippedSymbols: string[];
  symbolFailures: SymbolFailure[];
  hiddenSkips: Candidate[];
  kronos: CapabilitySnapshot;
  whale: CapabilitySnapshot;
  sentiment: CapabilitySnapshot;
  trackingQueued?: boolean;
  shadowQueued?: boolean;
  outcomeCheckQueued?: boolean;
  trackerLastUpdatedAt?: string | null;
}

export interface ScanResult {
  generatedAt: string;
  coverage: CoverageSnapshot;
  marketRegime: string;
  top10: Candidate[];
  diagnostics: ScanDiagnostics;
}

export interface OutcomeWindow {
  checkedAt: string;
  priceAtCheck: number;
  priceChangePct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  metricsSource?: "BASE" | "VARIANT";
  entryFilledAt?: string | null;
  entryFillPrice?: number | null;
  exitPrice?: number | null;
  ambiguousSameCandle?: boolean;
  candlePath?: Candle[];
  rResult: number | null;
  grossRResult: number | null;
  netRResult: number | null;
  outcomeQuality: "VALID_RISK" | "INVALID_RISK";
  profitableAfterCosts: boolean;
  slHit: boolean;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  result: "TP1" | "TP2" | "TP3" | "SL" | "OPEN" | "EXPIRED" | "NO_FILL";
}

export interface AvgRUnknownReasons {
  missingEntry: number;
  missingStopLoss: number;
  missingExit: number;
  invalidRisk: number;
  openOutcome: number;
  noCandlePath: number;
}

export type SampleTier = "EARLY_SIGNAL" | "PROVISIONAL" | "USABLE";
export type TimeframeBucket = "INTRADAY_5M_15M_1H";
export type SignalFamily = "BREAKOUT" | "PULLBACK" | "TREND_CONTINUATION" | "ROTATION_SETUP";
export type ShadowVariantCategory = "ENTRY" | "EXIT" | "COMBINATION";
export type DirectionQuality = "CLEAR" | "MIXED" | "NO_EDGE";
export type EntryPlaybook =
  | "PULLBACK_RECLAIM"
  | "BREAKOUT_RETEST"
  | "LIQUIDITY_SWEEP_RECLAIM"
  | "RETRACE_REJECTION"
  | "BREAKDOWN_RETEST"
  | "LIQUIDITY_SWEEP_REJECTION";
export type EntryTimingAction = "ENTER_ON_TRIGGER" | "WAIT_BETTER_ENTRY" | "NO_CHASE" | "CANCEL_IF_INVALIDATED";
export type ExitMode =
  | "TP1_FAST"
  | "TP1_PARTIAL_RUNNER"
  | "TRAIL_AFTER_TP1"
  | "EXIT_ON_KRONOS_FLIP"
  | "EXIT_ON_WHALE_FLIP"
  | "EXIT_ON_VWAP_LOSS";
export type ShadowVariantKey =
  | "base_current"
  | "fib_382_entry"
  | "fib_500_entry"
  | "fib_618_entry"
  | "ema20_pullback_entry"
  | "vwap_retest_entry"
  | "no_chase_atr_entry"
  | "tp1_fast_exit"
  | "tp1_50_tp2_runner"
  | "kronos_runner_exit"
  | "kronos_flip_exit"
  | "trail_after_tp1"
  | "whale_conflict_exit"
  | "fib_extension_exit"
  | "kronos_strong_agree_only"
  | "whale_agree_only"
  | "kronos_and_whale_agree"
  | "fib_entry_plus_kronos_exit"
  | "fib_entry_plus_whale_confirm"
  | "indicator_confluence_only";

export interface StatusHistoryEntry {
  status: FinalStatus;
  seenAt: string;
}

export interface TrackedSignal {
  id: string;
  scannedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  firstStatus: FinalStatus;
  scanCount: number;
  isDuplicateSuppressed: boolean;
  normalizedSignalKey: string;
  timeframeBucket: TimeframeBucket;
  signalFamily: SignalFamily;
  latestScore: number;
  latestStatus: FinalStatus;
  latestReason: string[];
  bestStatus: FinalStatus;
  statusHistory: StatusHistoryEntry[];
  symbol: string;
  direction: Direction;
  finalStatus: FinalStatus;
  opportunityScore: number;
  dangerScore: number;
  confidence: number;
  longScore: number;
  shortScore: number;
  kronosScore: number;
  priceAtScan: number;
  entryZone: [number, number] | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  reason: string[];
  directionConflict: boolean;
  sourceConflict: boolean;
  kronosBias: Direction | "UNAVAILABLE";
  kronosBias1h?: Direction | "UNAVAILABLE" | null;
  kronosBias4h?: Direction | "UNAVAILABLE" | null;
  selectedKronosBias?: Direction | "UNAVAILABLE" | null;
  kronosConfidence: number | null;
  kronosConfidenceBucket?: "STRONG" | "MEDIUM" | "WEAK" | null;
  expectedReturn1h?: number | null;
  expectedReturn4h?: number | null;
  horizonConflict?: boolean | null;
  selectedExecutionPlan?: VariantSelectionSnapshot | null;
  whaleSignal: ExternalSignalLabel;
  whaleScore: number;
  sentimentSignal: ExternalSignalLabel;
  sentimentScore: number;
  analysisContext?: {
    marketRegime: string | null;
    spreadPercent: number | null;
    riskReward: number | null;
    fiveMinuteEma20: number | null;
    fiveMinuteVwap: number | null;
    fiveMinuteAtr14: number | null;
    fiveMinuteAtrPercent: number | null;
    fiveMinuteVolumeRatio: number | null;
    fiveMinuteTrend: TrendLabel | null;
    fifteenMinuteTrend: TrendLabel | null;
    oneHourTrend: TrendLabel | null;
    fibonacci: FibonacciLevels | null;
  } | null;
  outcomes: {
    "30m": OutcomeWindow | null;
    "1h": OutcomeWindow | null;
    "4h": OutcomeWindow | null;
    "24h": OutcomeWindow | null;
  };
}

export interface StatusStats {
  total: number;
  withOutcome: number;
  resolved: number;
  sampleTier: SampleTier;
  validRisk: number;
  invalidRisk: number;
  tp1Hit: number;
  profitableTp1Hit: number;
  tp2Hit: number;
  tp3Hit: number;
  slHit: number;
  open: number;
  hitRate: number;
  tp1Rate: number;
  profitableTp1Rate: number;
  tp2Rate: number;
  slRate: number;
  avgMaxFavorableExcursionPct: number;
  avgMaxAdverseExcursionPct: number;
  avgRResult: number | null;
  avgGrossRResult: number | null;
  avgNetRResult: number | null;
  avgRUnknownReasons: AvgRUnknownReasons;
}

export interface AgreementStats {
  total: number;
  withOutcome: number;
  resolved: number;
  sampleTier: SampleTier;
  validRisk: number;
  invalidRisk: number;
  tp1Hit: number;
  profitableTp1Hit: number;
  tp2Hit: number;
  slHit: number;
  hitRate: number;
  tp1Rate: number;
  profitableTp1Rate: number;
  tp2Rate: number;
  slRate: number;
  avgMaxFavorableExcursionPct: number;
  avgMaxAdverseExcursionPct: number;
  avgRResult: number | null;
  avgGrossRResult: number | null;
  avgNetRResult: number | null;
  avgRUnknownReasons: AvgRUnknownReasons;
}

export interface SymbolStats {
  symbol: string;
  total: number;
  withOutcome: number;
  resolved: number;
  sampleTier: SampleTier;
  validRisk: number;
  invalidRisk: number;
  tp1Hit: number;
  profitableTp1Hit: number;
  tp2Hit: number;
  slHit: number;
  hitRate: number;
  tp1Rate: number;
  profitableTp1Rate: number;
  tp2Rate: number;
  slRate: number;
  avgMaxFavorableExcursionPct: number;
  avgMaxAdverseExcursionPct: number;
  avgRResult: number | null;
  avgGrossRResult: number | null;
  avgNetRResult: number | null;
  avgRUnknownReasons: AvgRUnknownReasons;
}

export interface ShadowVariantStats {
  key: ShadowVariantKey;
  label: string;
  category: ShadowVariantCategory;
  signals: number;
  withOutcome: number;
  resolved: number;
  validRisk: number;
  invalidRisk: number;
  tp1Hit: number;
  profitableTp1Hit: number;
  tp2Hit: number;
  tp3Hit: number;
  slHit: number;
  open: number;
  hitRate: number;
  tp1Rate: number;
  profitableTp1Rate: number;
  tp2Rate: number;
  slRate: number;
  avgMaxFavorableExcursionPct: number;
  avgMaxAdverseExcursionPct: number;
  avgRResult: number | null;
  avgGrossRResult: number | null;
  avgNetRResult: number | null;
  profitFactor: number | null;
  avgRUnknownReasons: AvgRUnknownReasons;
}

export interface ExecutionCostConfig {
  feeBpsPerSide: number;
  slippageBpsPerSide: number;
  roundTripCostBps: number;
}

export interface PerformanceInsightCard {
  label: string;
  value: string;
  tone: "green" | "amber" | "slate";
  detail: string;
}

export interface TradeReadinessRecommendation {
  status: "READY" | "WAIT" | "WATCH";
  sampleTier: SampleTier;
  recommendation: string;
}

export interface DedupeAuditSnapshot {
  duplicateSuppressionWindowMinutes: number;
  activeOpenSignals: number;
  rawScans: number;
  uniqueSignals: number;
  note: string;
}

export interface MigrationAuditSnapshot {
  currentCanonicalSample: number;
  archivedPreDedupeSample: number;
  migratedResolvedOutcomes: number;
  skippedLegacyRecords: number;
  skippedLegacyReasons: string[];
  note: string;
}

export interface LifecycleDiagnosticsSnapshot {
  oldestActiveSignalAgeMinutes: number | null;
  next1hCheckDueAt: string | null;
  next4hCheckDueAt: string | null;
  lastOutcomeCheckerRunAt: string | null;
}

export interface PerformanceWindowSnapshot {
  window: "1h" | "4h";
  withOutcome: number;
  resolvedOutcomes: number;
  openOutcomes: number;
  lowSample: boolean;
  byStatus: Record<string, StatusStats>;
  byDirection: Record<string, AgreementStats>;
  kronosAgreement: { agrees: AgreementStats; disagrees: AgreementStats; unavailable: AgreementStats };
  kronosConfidenceSplit: {
    STRONG: { agrees: AgreementStats; disagrees: AgreementStats };
    MEDIUM: { agrees: AgreementStats; disagrees: AgreementStats };
    WEAK: { ignored: AgreementStats };
  };
  whaleAgreement: { agrees: AgreementStats; disagrees: AgreementStats; unavailable: AgreementStats };
  bySymbol: SymbolStats[];
  earlySampleSymbols: SymbolStats[];
  shadowVariants: ShadowVariantStats[];
  variantCombinations: VariantCombinationStats[];
  insights: PerformanceInsightCard[];
  tradeReadiness: TradeReadinessRecommendation[];
  statusTransitions: {
    waitWorked: number;
    readyFailed: number;
  };
}

export interface EdgeScoreSnapshot {
  score: number;
  historicalNetExpectancy: number;
  kronosForecastSupport: number;
  whaleFlowSupport: number;
  entryQuality: number;
  fibAtrRrQuality: number;
  volumeRegimeCompatibility: number;
  entryQualityLabel: string;
  bestShadowEntryVariant: ShadowVariantKey | null;
  bestShadowExitVariant: ShadowVariantKey | null;
  kronosExitGuidance: string;
  whaleGuidance: string;
  netEdgeWarning: string | null;
  noChase: boolean;
  horizonConflict: boolean;
  shortHorizonOnly: boolean;
  notes: string[];
  cautions: string[];
}

export interface TradePlanSnapshot {
  directionGap: number;
  directionQuality: DirectionQuality;
  biasSummary: string;
  entryPlaybook: EntryPlaybook;
  entryAction: EntryTimingAction;
  exactEntryTrigger: string;
  noChaseWarning: string | null;
  invalidation: string[];
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  exitMode: ExitMode;
  earlyExitCondition: string;
  runnerAllowed: boolean;
  horizonConflict: boolean;
  shortHorizonOnly: boolean;
  stagedEntrySplit: string;
  stagedExitSplit: string;
  why: string[];
}

export type ShadowPositionVariant =
  | "tp1_full_exit"
  | "tp1_50_tp2_runner"
  | "tp1_70_runner30"
  | "trail_after_tp1"
  | "kronos_runner_exit"
  | "kronos_flip_exit"
  | "whale_conflict_exit"
  | "vwap_loss_exit";

export type ExecutionEntryVariant =
  | "base_current_entry"
  | "fib_382_entry"
  | "fib_500_entry"
  | "fib_618_entry"
  | "vwap_retest_entry"
  | "ema20_pullback_entry"
  | "no_chase_atr_entry";

export type VariantConfidenceTier = "early" | "provisional" | "usable";
export type ProfitRouteMode = "PROFIT_CANDIDATE" | "DATA_COLLECTION" | "RESEARCH_ONLY";

export type ProfitRouteReasonCode =
  | "POSITIVE_NET_EVIDENCE"
  | "NEGATIVE_NET_EVIDENCE"
  | "NEUTRAL_NET_EVIDENCE"
  | "NO_EVIDENCE"
  | "EARLY_SAMPLE"
  | "TOXIC_VARIANT"
  | "TOXIC_VARIANT_OVERRIDDEN_BY_SYMBOL"
  | "ALL_REPLAY_VARIANTS_NEGATIVE"
  | "SIDE_NET_NEGATIVE"
  | "SYMBOL_NET_NEGATIVE"
  | "SYMBOL_NET_POSITIVE"
  | "KRONOS_HORIZON_CONFLICT"
  | "KRONOS_AGREES"
  | "KRONOS_DISAGREES"
  | "WHALE_AGREES"
  | "WHALE_DISAGREES"
  | "RUNNER_REQUIRES_POSITIVE_NET"
  | "RUNNER_BLOCKED_BY_HORIZON_CONFLICT"
  | "RUNNER_OK"
  | "COST_R_HIGH"
  | "STOP_TOO_TIGHT"
  | "TP1_PROFITABLE_AFTER_COST"
  | "TP1_NOT_PROFITABLE_AFTER_COST"
  | "PROFITABLE_REPLAY_CHOICE"
  | "CALIBRATION_BLOCKS_PROMOTION"
  | "STOP_DISTANCE_ULTRA_TIGHT";

export type ReflectionCode =
  | "GOOD_TP1_CAPTURE"
  | "TP1_NOT_PROFITABLE_AFTER_COST"
  | "STOP_TOO_TIGHT"
  | "CHASE_ENTRY"
  | "RUNNER_GIVEBACK"
  | "SYMBOL_TOXIC"
  | "SIDE_TOXIC"
  | "VARIANT_TOXIC"
  | "KRONOS_CONFLICT_IGNORED"
  | "WHALE_CONFLICT_IGNORED"
  | "NO_FILL_RESEARCH"
  | "COST_R_TOO_HIGH"
  | "PROFITABLE_AFTER_COST";

export interface ScannerDiagnostics {
  profitCandidateSimilarityScore: number;
  researchRiskScore: number;
  topPositiveEvidence: string[];
  topNegativeEvidence: string[];
  closestPathToProfitCandidate: string;
}

export interface VariantSelectionSnapshot {
  selectedEntryVariant: ExecutionEntryVariant;
  selectedExitVariant: ShadowPositionVariant;
  expectedGrossR: number | null;
  expectedNetR: number | null;
  netEdgeAfterCost: number | null;
  profitFactor: number | null;
  fillRate: number | null;
  noFillRate: number | null;
  costR: number | null;
  spreadR: number | null;
  feeSlippageR: number | null;
  stopDistanceBps: number | null;
  variantSampleSize: number;
  variantConfidenceTier: VariantConfidenceTier;
  routeMode: ProfitRouteMode;
  routeScore?: number;
  routeReasonCodes?: ProfitRouteReasonCode[];
  routeExplanation?: string;
  primaryProfitEligible?: boolean;
  researchReason?: string | null;
  dataCollectionReason?: string | null;
  diagnostics?: ScannerDiagnostics;
  /** Calibration-adjusted expectancy fields (optional — populated when evidence is available). */
  rawExpectedNetR?: number | null;
  calibratedExpectedNetR?: number | null;
  calibrationPenaltyR?: number;
  calibrationConfidence?: "LOW" | "MEDIUM" | "HIGH";
  calibrationSampleSize?: number;
  calibrationSourceUsed?: "combo" | "symbol+combo" | "entry+exit" | "routeMode" | "none";
  calibrationDiagnosisCodes?: string[];
  calibrationVerdict?:
    | "RAW_EDGE_NOT_VALIDATED"
    | "CALIBRATED_POSITIVE"
    | "CALIBRATED_NEGATIVE"
    | "INSUFFICIENT_SAMPLE";
  calibrationExplanation?: string;
  /** Evidence era stamped at plan-build time; "POST_CALIBRATION" for new records. */
  evidenceEra?: "LEGACY_PRE_ROUTING" | "POST_ROUTING_PRE_CALIBRATION" | "POST_CALIBRATION" | "UNKNOWN";
  /** Decision-policy version string; bump when planner rules change. */
  decisionPolicyVersion?: string;
  selectionSource: "replay" | "heuristic_fallback";
  costAssumption: string;
  selectionReason: string;
  entryDriftPct: number | null;
  entryDriftAtr: number | null;
  entryQualityExplanation: string[];
  exitPlanExplanation: string[];
  chaseRisk: "LOW" | "MEDIUM" | "HIGH";
}

export interface VariantCombinationStats {
  entryVariant: ExecutionEntryVariant;
  exitVariant: ShadowPositionVariant;
  attempted: number;
  filled: number;
  noFill: number;
  resolved: number;
  validResolved: number;
  tp1: number;
  tp2: number;
  tp3: number;
  profitableTp1: number;
  sl: number;
  winRate: number;
  grossAvgR: number | null;
  netAvgR: number | null;
  profitFactor: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyPerTrade: number | null;
  runnerSuccessRate: number;
  ambiguousSameCandleCount: number;
  sampleTier: VariantConfidenceTier;
}

export type ShadowPositionState = "OPEN" | "PARTIAL" | "CLOSED";
export type ShadowCloseReason =
  | "TP1_FULL"
  | "TP2"
  | "TP3"
  | "SL"
  | "BREAKEVEN"
  | "KRONOS_FLIP"
  | "WHALE_CONFLICT"
  | "VWAP_LOSS"
  | "TRAIL_STOP"
  | "TIME_EXPIRED"
  | "NO_FILL"
  | "OPEN";

export interface ShadowVariantPosition {
  variant: ShadowPositionVariant;
  state: ShadowPositionState;
  openedAt: string;
  lastUpdatedAt: string;
  closedAt: string | null;
  remainingSizePct: number;
  realizedGrossR: number;
  realizedNetR: number;
  unrealizedR: number;
  currentPrice: number;
  stopPrice: number | null;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  slMovedToBreakeven: boolean;
  closeReason: ShadowCloseReason;
  profitableAfterCosts: boolean;
  /**
   * Phase 3.1 toxicity-evidence instrumentation — DATA ONLY.
   * Per-variant MFE/MAE excursion (analytical; never used to trigger exits).
   * NO_FILL variants leave these null. Absolute units are in price.
   */
  mfeAbs?: number | null;
  maeAbs?: number | null;
  mfeR?: number | null;
  maeR?: number | null;
  maxFavorablePrice?: number | null;
  maxAdversePrice?: number | null;
  maxFavorableAt?: string | null;
  maxAdverseAt?: string | null;
  /**
   * Phase 3.1 R-geometry snapshot captured at resolve time (variant entry).
   * entryPriceUsed mirrors position.entryPrice at fill; stopPriceUsed mirrors
   * the variant's initial stopPrice; tp1PriceUsed mirrors position.tp1.
   * initialRiskAbs is the absolute distance between entryPriceUsed and stopPriceUsed.
   */
  entryPriceUsed?: number | null;
  stopPriceUsed?: number | null;
  tp1PriceUsed?: number | null;
  initialRiskAbs?: number | null;
  tp1RewardAbs?: number | null;
  tp1RewardR?: number | null;
  slRiskR?: number | null;
  /**
   * Phase 3.1 compact forward-path summary (no raw candle arrays).
   * pathStartAt = first candle observed after entry fill; pathEndAt = last candle
   * before/at resolution; resolutionPrice = price at variant close (or last seen
   * for non-closed variants); pathCandleCount = number of candles observed.
   */
  pathStartAt?: string | null;
  pathEndAt?: string | null;
  pathHigh?: number | null;
  pathLow?: number | null;
  resolutionPrice?: number | null;
  pathCandleCount?: number | null;
  timeToHighMs?: number | null;
  timeToLowMs?: number | null;
}

export interface ShadowPosition {
  id: string;
  ideaKey: string;
  marketIdeaKey?: string;
  symbol: string;
  direction: Exclude<Direction, "NEUTRAL">;
  signalFamily: SignalFamily;
  scannedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEvaluatedAt: string;
  scanCount: number;
  latestStatus: FinalStatus;
  latestScore: number;
  latestReason: string[];
  entryZone: [number, number] | null;
  marketEntryZone?: [number, number] | null;
  entryState?: "PENDING_ENTRY" | "FILLED";
  entryPrice: number;
  entryFilledAt?: string;
  entryFillReason?: string;
  spreadPercent?: number | null;
  stopDistanceBps?: number | null;
  costR?: number | null;
  spreadR?: number | null;
  feeSlippageR?: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  riskReward: number | null;
  dangerScore: number;
  selectedEntryVariant: ExecutionEntryVariant;
  selectedExitVariant: ShadowPositionVariant;
  variantSelection: VariantSelectionSnapshot;
  primaryVariant: ShadowPositionVariant;
  tradePlan: TradePlanSnapshot;
  variants: ShadowVariantPosition[];
  /** Market regime at the time the shadow record was opened. */
  marketRegime?: string | null;
  /**
   * Market regime label at the time this shadow position was opened.
   * Alias/supplement to marketRegime; used by retrospective audit modules.
   * Added in Phase 2F.1 — undefined/null on legacy records.
   */
  marketRegimeAtOpen?: string | null;
  /** Canonical Phase 2A selection-time intelligence snapshot; optional for historical records. */
  strategyContextSnapshot?: import("./strategy-intelligence.js").StrategyContextSnapshot | null;
  /** Analytical-only path metrics captured after fill; never used to trigger exits. */
  maxFavorablePrice?: number | null;
  maxAdversePrice?: number | null;
  maxFavorableExcursionR?: number | null;
  maxAdverseExcursionR?: number | null;
  maxFavorableAt?: string | null;
  maxAdverseAt?: string | null;
  /**
   * Policy version marker for anchor-consistency tracking.
   * "base-route-anchor-consistent-v2" stamps records where costR and
   * grossR are computed from the same entry-price anchor (the variant
   * anchor for non-base entries; currentPrice for base_current_entry).
   * Undefined/null on legacy records created before the Phase 2
   * anchor-consistency patch.
   */
  policyVersion?: string | null;
  /**
   * Risk hygiene guard generation: the minimum stop distance (in bps) that was
   * enforced at position creation time. Stamped on all new positions so the
   * hygiene monitor can separate pre-175 tape from post-175 (current guard) tape.
   * Undefined/null on positions created before the guard generation field was added.
   */
  riskHygieneGuardMinStopDistanceBps?: number | null;
  /**
   * Version string for the risk hygiene guard that was active at position creation.
   * Matches the exported RISK_HYGIENE_GUARD_V1 constant in shadow-engine.ts.
   */
  riskHygieneGuardVersion?: string | null;
}

export type ShadowExecutionEventType =
  | "OPENED"
  | "ENTRY_PENDING"
  | "ENTRY_SKIPPED"
  | "ENTRY_AMBIGUOUS"
  | "TP1_HIT"
  | "SL_MOVED"
  | "TP2_HIT"
  | "RUNNER_EXIT"
  | "EARLY_EXIT"
  | "SL_HIT"
  | "CLOSED"
  | "NO_FILL"
  | "DUPLICATE_SUPPRESSED";

export interface ShadowExecutionEvent {
  id: string;
  positionId: string;
  ideaKey: string;
  symbol: string;
  direction: Exclude<Direction, "NEUTRAL">;
  variant: ShadowPositionVariant | "idea";
  type: ShadowExecutionEventType;
  message: string;
  createdAt: string;
  price: number | null;
  rValue: number | null;
}

export interface ShadowVariantPerformance {
  variant: ShadowPositionVariant;
  total: number;
  resolved: number;
  open: number;
  profitable: number;
  tp1Hit: number;
  slHit: number;
  grossAvgR: number | null;
  netAvgR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyPerTrade: number | null;
  winRate: number;
  profitFactor: number | null;
}

export interface ShadowScopePerformance {
  uniqueIdeas: number;
  closedPositions: number;
  total: number;
  closed: number;
  open: number;
  dailyClosedGrossR: number;
  dailyClosedNetR: number;
  dailyProfitFactor: number | null;
  winRate: number;
  profitFactor: number | null;
  grossAvgR: number | null;
  netAvgR: number | null;
  expectancyPerTrade: number | null;
  tp1Rate?: number;
  profitableTp1Rate?: number;
  slRate?: number;
  avgWinR?: number | null;
  avgLossR?: number | null;
}

export interface ShadowExecutionSummary {
  rawExecutedTrades: number;
  uniqueIdeas: number;
  openPositions: number;
  closedPositions: number;
  winRate: number;
  profitFactor: number | null;
  grossAvgR: number | null;
  netAvgR: number | null;
  dailyClosedGrossR: number;
  dailyClosedNetR: number;
  dailyProfitFactor: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyPerTrade: number | null;
  noFillRate: number;
  runnerSuccessRate: number;
  profitabilityExplanation: string;
  tp1Rate: number;
  slRate: number;
  bestVariant: ShadowPositionVariant | null;
  duplicateSuppressionWindowMinutes: number;
  activeOpenIdeaCount: number;
  suppressedDuplicates: number;
  bestVariantStats: ShadowVariantPerformance | null;
  variants: ShadowVariantPerformance[];
  bestVariantCombinations: VariantCombinationStats[];
  primaryProfitCandidate: ShadowScopePerformance;
  researchExecution: ShadowScopePerformance;
  dataCollectionExecution: ShadowScopePerformance;
}

export interface ShadowStateSnapshot {
  generatedAt: string;
  summary: ShadowExecutionSummary;
  openPositions: ShadowPosition[];
  recentLog: ShadowExecutionEvent[];
}

export interface PerformanceStats {
  primaryWindow: "1h";
  secondaryWindow: "4h";
  executionCost: ExecutionCostConfig;
  totalSignals: number;
  rawScans: number;
  uniqueTrackedSignals: number;
  suppressedDuplicateScans: number;
  withOutcome: number;
  resolvedOutcomes: number;
  openOutcomes: number;
  activeOpenSignals: number;
  expiredSignals: number;
  invalidRiskSignals: number;
  lowSample: boolean;
  byStatus: Record<string, StatusStats>;
  byDirection: Record<string, AgreementStats>;
  kronosAgreement: { agrees: AgreementStats; disagrees: AgreementStats; unavailable: AgreementStats };
  kronosConfidenceSplit: {
    STRONG: { agrees: AgreementStats; disagrees: AgreementStats };
    MEDIUM: { agrees: AgreementStats; disagrees: AgreementStats };
    WEAK: { ignored: AgreementStats };
  };
  whaleAgreement: { agrees: AgreementStats; disagrees: AgreementStats; unavailable: AgreementStats };
  bySymbol: SymbolStats[];
  earlySampleSymbols: SymbolStats[];
  insights: PerformanceInsightCard[];
  tradeReadiness: TradeReadinessRecommendation[];
  dedupeAudit: DedupeAuditSnapshot;
  migrationAudit: MigrationAuditSnapshot;
  lifecycle: LifecycleDiagnosticsSnapshot;
  statusTransitions: {
    waitWorked: number;
    readyFailed: number;
  };
  windows: {
    "1h": PerformanceWindowSnapshot;
    "4h": PerformanceWindowSnapshot;
  };
  generatedAt: string;
}

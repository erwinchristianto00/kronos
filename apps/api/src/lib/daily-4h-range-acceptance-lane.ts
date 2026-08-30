/**
 * DAILY 4H RANGE ACCEPTANCE — isolated 4h acceptance lane.
 *
 * This module intentionally has no dependency on MOM36, the regime controller, a
 * continuation model, or the Dynamic basket admission path.  It owns its own
 * deterministic state, signal history, exchange order ids, and safety controls.
 *
 * Binance USD-M accounts in this deployment are one-way/netted.  A persisted
 * open/pending trade is therefore also a symbol lease: other entry paths must not
 * open the same symbol while this lane's reduce-only bracket is live.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  BinanceFuturesPrivateError,
  type BinanceFuturesPrivateClient,
  type FuturesAlgoOrder,
  type FuturesIncomeEntry,
  type FuturesKline,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
} from "./binance-futures-private.js";
import type { DailyRangePoolEvidence, DailyRangePoolSymbolAudit } from "./daily-range-auto-pool.js";
import {
  DAILY_RANGE_TESTNET_MAX_OPEN_TRADES_DEFAULT,
  type DailyRangeMainnetControls,
} from "./daily-range-mainnet-policy.js";
import {
  allocateDailyRangeBatch,
  type DailyRangeAllocatorMode,
  type DailyRangeAllocationSkipReason,
} from "./daily-range-selector.js";
import {
  DAILY_RANGE_ALPHA_SELECTOR_POLICY_ID,
  DAILY_RANGE_ECONOMIC_ALLOCATOR_POLICY_ID,
  DAILY_RANGE_EXECUTION_ECONOMICS_POLICY_ID,
  DAILY_RANGE_FRICTION_INCLUSIVE_RISK_POLICY_ID,
  DAILY_RANGE_FRICTION_DEFINITION_VERSION,
  DAILY_RANGE_MAX_COST_RATIO,
  DAILY_RANGE_MAX_STRUCTURAL_STOP_PCT,
  DAILY_RANGE_MAX_TARGET_ATR4H_MULTIPLE,
  DAILY_RANGE_MAX_TARGET_DISTANCE_PCT,
  DAILY_RANGE_MAX_NOTIONAL_USD,
  DAILY_RANGE_MAX_PLANNED_RISK_USD,
  DAILY_RANGE_TRADE_GEOMETRY_POLICY_ID,
  buildEmpiricalFrictionModel,
  calculateCausalAtr14,
  conservativeFallbackFrictionModel,
  expectedDailyRangeEntryPrice,
  evaluateDailyRangeTradeGeometry,
  evaluateActualFillEconomics,
  prepareDailyRangeEconomics,
  type DailyRangeAtr4hFeature,
  type DailyRangeFrictionModel,
  type DailyRangeFrictionSample,
  type DailyRangeGeometryRejectReason,
  type DailyRangePreTradeEconomics,
  type DailyRangeTradeGeometry,
} from "./daily-range-economics.js";
import {
  DAILY_RANGE_NEXT_SR_TARGET_POLICY_ID,
  DAILY_RANGE_STRUCTURAL_SR_POLICY_ID,
  dailyRangeStructuralStopSource,
  resolveDailyRangeStructuralTarget,
  type DailyRangeStructuralTarget,
  type DailyRangeStructuralTargetResolution,
} from "./daily-range-structural-sr.js";
import {
  type DailyRangeContractPathEvent,
  type DailyRangeContractPathSource,
  type DailyRangePathQuality,
} from "./daily-range-contract-path.js";
import {
  DAILY_RANGE_FADE_MFE_POLICY_ID,
  advanceDailyRangeFadeMfe,
  bindDailyRangeFadeMfeTarget,
  createDailyRangeFadeMfeState,
  markDailyRangeFadeMfeDegraded,
  type DailyRangeFadeMfeExitReason,
  type DailyRangeFadeMfeState,
} from "./daily-range-fade-mfe.js";
import {
  advanceDailyRangeAutoRoute,
  blankDailyRangeAutoRouteState,
  type DailyRangeAutoRouteEntryMode,
  type DailyRangeAutoRouteEntryTiming,
  type DailyRangeAutoRouteState,
} from "./daily-range-auto-route.js";
import {
  DAILY_RANGE_FADE_BRACKET_ONLY_EXIT_POLICY_ID,
  DAILY_RANGE_ROUTE_EXIT_POLICY_ID,
  dailyRangeRouteExitPolicyForSignal,
  dailyRangeTpMultipleForRoute,
  evaluateDailyRangeThesisInvalidation,
  isDailyRangeRouteExitPolicy,
  isDailyRangeRouteExitV1,
  type DailyRangeRouteExitPolicySnapshot,
  type DailyRangeThesisInvalidationDecision,
  type DailyRangeThesisInvalidationReason,
} from "./daily-range-route-exit.js";
import type { DailyRangeSelectorArtifactRegistryStatus } from "./daily-range-selector-artifacts.js";
import {
  captureDailyRangeClosedChartSnapshot,
  pendingDailyRangeClosedChartSnapshot,
  readDailyRangeClosedChartSnapshotSvg,
  type DailyRangeClosedChartSnapshot,
} from "./daily-range-closed-chart-snapshot.js";

export const DAILY_RANGE_LANE_ID = "DAILY_4H_RANGE_ACCEPTANCE";
/** Preserved solely for legacy trades and their immutable exit/reconciliation lineage. */
export const DAILY_RANGE_STRATEGY_VERSION = "daily-4h-range-acceptance-2r-v1";
/**
 * New entries route one completed 5m breakout event by its observed path:
 * persistent expanding closes continue; a close back inside fades the failed
 * breakout.  The reference session is 00:00-04:00 America/New_York.
 */
export const DAILY_RANGE_AUTO_ROUTE_STRATEGY_VERSION = "daily-4h-range-auto-route-ny-2r-v2";
/** V3 makes the route and candidate taxonomy explicit for every new signal. */
export const DAILY_RANGE_AUTO_ROUTE_V3_STRATEGY_VERSION = "daily-4h-range-auto-route-ny-meme-v3";
export type DailyRangeStrategyVersion =
  | typeof DAILY_RANGE_STRATEGY_VERSION
  | typeof DAILY_RANGE_AUTO_ROUTE_STRATEGY_VERSION
  | typeof DAILY_RANGE_AUTO_ROUTE_V3_STRATEGY_VERSION;
export type DailyRangeStrategyMode = "LEGACY_CONTINUATION" | "AUTO_ROUTE_NY_V2" | "AUTO_ROUTE_NY_V3";
export type DailyRangeEntryPolicy = "LEGACY_CONTINUATION" | "CONTINUATION" | "FADE";
export type DailyRangeBreakoutDirection = "UP" | "DOWN";
/** No model has allocation authority. New data is collected under this immutable policy label. */
/** Historical v1 batch lineage remains immutable and readable. */
export const DAILY_RANGE_SELECTOR_POLICY_VERSION = "DAILY_RANGE_BATCH_SELECTOR_SHADOW_V1";
/** V3 selection is economic baseline; alpha remains explicitly non-authoritative. */
export const DAILY_RANGE_ECONOMIC_SELECTOR_POLICY_VERSION = DAILY_RANGE_ECONOMIC_ALLOCATOR_POLICY_ID;
export const DAILY_RANGE_TRADE_NOTIONAL_USD = DAILY_RANGE_MAX_NOTIONAL_USD;
export const DAILY_RANGE_LEVERAGE = 1;
export const DAILY_RANGE_RR = 2;

const FIVE_MIN_MS = 5 * 60_000;
const FOUR_HOURS_MS = 4 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const EPSILON = 1e-9;
const MAX_FRESH_SIGNAL_AGE_MS = 95_000;
/** Binance's event clock may lead the local receipt clock by a few milliseconds. */
const MAX_BOOK_SOURCE_FUTURE_SKEW_MS = 5_000;
const CONFIRM_RETRIES = 4;
const DEFAULT_CONFIRM_RETRY_MS = 350;
const MAX_SIGNAL_COHORTS = 20_000;
const MAX_COUNTERFACTUAL_MATURATION_PER_TICK = 50;
const ALLOCATOR_LOCK_STALE_MS = 10 * 60_000;
const RESEARCH_ENTRY_FEE_BPS = 4;
const RESEARCH_EXIT_FEE_BPS = 4;
const RESEARCH_SLIPPAGE_BPS = 0;
const NEW_YORK_TIME_ZONE = "America/New_York";
/** A quote older than this at allocation is not a causal executable decision. */
const MAX_DECISION_BBO_AGE_MS = 30_000;
/** Persist live path extrema in bounded batches; never sync-write for every aggTrade. */
const PATH_PERSIST_INTERVAL_MS = 5_000;
/** A recovery run is deliberately bounded. Longer or gapped windows stay explicit INCOMPLETE. */
const MAX_PATH_RECOVERY_BARS = 15_000;
/** A queued websocket event is never allowed to become a delayed MFE decision. */
const MAX_FADE_MFE_EVENT_PROCESSING_DELAY_MS = 5_000;
/** A temporary public-candle outage may not erase a close snapshot; retry gently and boundedly. */
const CLOSED_CHART_SNAPSHOT_RETRY_MS = 5 * 60_000;

export type DailyRangeDirection = "LONG" | "SHORT";
export type DailyRangeControlMode = "DISARMED" | "ARMED";
export type DailyRangeTradeStatus =
  | "ENTRY_SUBMITTING"
  | "ENTRY_RECONCILING"
  | "PROTECTING"
  | "OPEN"
  | "EXIT_RECONCILING"
  | "CLOSED"
  | "ENTRY_ABORT_INVALID_RISK"
  | "ENTRY_ABORT_POST_FILL_GEOMETRY_FAIL"
  | "ENTRY_ABORT_POST_FILL_ECONOMICS_FAIL"
  | "ENTRY_ABORT_POST_FILL_RISK_FAIL"
  | "ENTRY_ABORT_PROTECTION_FAILED"
  | "ENTRY_ABORT_EXECUTION_FAILED"
  | "ENTRY_ABORT_SYMBOL_IN_FLIGHT"
  | "ENTRY_ABORT_ACCOUNT_CONFLICT";

export type DailyRangeSignalReason =
  | "SHORT_BLOCKED"
  | "CROSS_SECTIONAL_PRIORITY_WINDOW"
  | "SYMBOL_OCCUPIED_BY_OTHER_STRATEGY"
  | "LANE_POSITION_ALREADY_OPEN"
  | "OUTSIDE_ENTRY_WINDOW"
  | "EXECUTION_INELIGIBLE"
  | "STALE_DATA"
  | "ACCOUNT_STATE_UNKNOWN"
  | "INSUFFICIENT_MARGIN"
  | "MISSED_SIGNAL_RECOVERY"
  | "LANE_DISARMED"
  | "ENTRY_IN_FLIGHT"
  | "MAINNET_EXECUTION_DISABLED"
  | "LIVE_CONTINUATION_EXECUTION_DISABLED"
  | "ACCOUNT_ENTRY_BLOCKED"
  | "MAX_OPEN_TRADES_REACHED"
  | "MAX_GROSS_NOTIONAL_REACHED"
  | "NO_AVAILABLE_SLOT"
  | "SKIP_CAP_LOWER_RANK"
  | "STRATEGY_SYMBOL_CONFLICT"
  | "SPREAD_HARD_REJECT"
  | "SELECTOR_NOT_READY"
  | "STOP_ECONOMICS_FAIL"
  | "NET_REWARD_NON_POSITIVE"
  | "STRUCTURAL_STOP_TOO_WIDE"
  | "TARGET_DISTANCE_TOO_WIDE"
  | "TARGET_REACHABILITY_FAIL"
  | "TARGET_REACHABILITY_DATA_UNAVAILABLE"
  | "STRUCTURAL_TARGET_INVALID"
  | "STRUCTURAL_TARGET_UNAVAILABLE"
  | "RISK_BUDGET_UNEXECUTABLE"
  | "BBO_STALE"
  | "FRICTION_MODEL_UNAVAILABLE"
  | "NEGATIVE_EXPECTED_VALUE"
  | "POST_FILL_ECONOMICS_FAIL"
  | "POST_FILL_RISK_FAIL"
  | "ALPHA_SELECTOR_SHADOW_ONLY"
  | "LIVE_NEW_ENTRY_PAUSED"
  | "SELECTED_EXECUTION_FAILED"
  | "RETIRED_STRATEGY_VERSION";

export interface DailyRangeCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DailyRangeLevel {
  dateUtc: string;
  symbol: string;
  fourHourOpenTime: number;
  fourHourCloseTime: number;
  rangeHigh: number;
  rangeLow: number;
  rangeWidth: number;
  rangeWidthPct: number | null;
  dailyUniverseMembership: true;
  createdAt: string;
}

type DailyRangeRouterState = DailyRangeAutoRouteState;

export interface DailyRangeSymbolState {
  lastProcessedBarOpenTime: number | null;
  previousClosedCandle: DailyRangeCandle | null;
  longCount: 0 | 1 | 2;
  shortCount: 0 | 1 | 2;
  longLocked: boolean;
  shortLocked: boolean;
  /** Present only for the V2/V3 per-symbol breakout router. Legacy rows stay valid. */
  router?: DailyRangeRouterState;
}

/**
 * Immutable C1-C6 proof for a MOM36 symbol added after the initial Daily
 * session snapshot. The lane begins observing only from this admission point;
 * it never replays a breakout that happened before the symbol was eligible.
 */
export interface DailyRangeBorrowedUniverseAdmission {
  symbol: string;
  admittedAt: string;
  source: string;
  poolEvidence: DailyRangePoolEvidence | null;
}

export interface DailyRangeDayState {
  dateUtc: string;
  initializedAt: string;
  universeSymbols: string[];
  universeSource: string;
  /** Immutable C1-C6 evidence at the moment the UTC universe was frozen. */
  poolEvidence?: DailyRangePoolEvidence | null;
  /** Additive, immutable evidence for dynamic unused-MOM36 admissions. */
  borrowedUniverseAdmissions?: Record<string, DailyRangeBorrowedUniverseAdmission>;
  levels: Record<string, DailyRangeLevel>;
  invalidReferenceSymbols: Array<{ symbol: string; reason: string }>;
  symbolStates: Record<string, DailyRangeSymbolState>;
  /** Optional because legacy UTC-v1 day records remain immutable and readable. */
  strategyVersion?: DailyRangeStrategyVersion;
  strategyMode?: DailyRangeStrategyMode;
  /** V3 policy guard: a current-day router is never silently reinterpreted. */
  autoRouteEntryMode?: DailyRangeAutoRouteEntryMode;
  referenceTimezone?: "UTC" | "America/New_York";
  referenceRangeOpenTime?: number;
  referenceRangeCloseTime?: number;
  entryWindowCloseTime?: number;
}

interface DailyRangeRuntimeReferenceWindow {
  dayKey: string;
  date: string;
  referenceTimezone: "UTC" | "America/New_York";
  rangeOpenTime: number;
  rangeCloseTime: number;
  entryWindowCloseTime: number;
}

export interface DailyRangeSignal {
  signalId: string;
  strategyVersion: DailyRangeStrategyVersion;
  laneId: typeof DAILY_RANGE_LANE_ID;
  dateUtc: string;
  symbol: string;
  direction: DailyRangeDirection;
  rangeHigh: number;
  rangeLow: number;
  confirmationBar1: DailyRangeCandle | null;
  confirmationBar2: DailyRangeCandle;
  signalTimestamp: string;
  signalTimestampMs: number;
  entryEligible: boolean;
  reason: DailyRangeSignalReason | null;
  entryAttemptedAt: string | null;
  tradeId: string | null;
  /** Fields below were added with the batch/PIT allocator and are optional for legacy rows. */
  signalBatchTimestamp?: string;
  eligibleSince?: string;
  poolVersion?: number | null;
  universePolicyId?: string | null;
  selectorMode?: DailyRangeAllocatorMode;
  selectorId?: string | null;
  selectorScore?: number | null;
  selectorRank?: number | null;
  /** Frozen pre-allocation V3 economic decision. Absent is legacy evidence. */
  economics?: DailyRangePreTradeEconomics | null;
  /** Route authority is persisted separately from the structural evaluation. */
  routeExecutionEnabled?: boolean;
  /** False for Live Continuation shadow rows; they never reach allocation. */
  executionEligible?: boolean;
  /** Snapshot is retained even when geometry rejects before allocation. */
  geometry?: DailyRangeTradeGeometry | null;
  alphaSelector?: DailyRangeAlphaSelectorSnapshot | null;
  actuallySelected?: boolean;
  actuallyExecuted?: boolean;
  research?: DailyRangeSignalResearchRecord | null;
  /** V2/V3 lineage. Absent is an intentional legacy-v1 continuation record. */
  entryPolicy?: DailyRangeEntryPolicy;
  /** Exact completed-bar condition that produced a V3 signal. */
  entryTiming?: DailyRangeAutoRouteEntryTiming | null;
  breakoutDirection?: DailyRangeBreakoutDirection | null;
  breakoutId?: string | null;
  breakoutExtreme?: number | null;
  referenceTimezone?: "UTC" | "America/New_York";
  referenceRangeOpenTime?: number | null;
  referenceRangeCloseTime?: number | null;
  /** Present only for new route-specific-exit candidates; legacy rows remain frozen. */
  routeExitPolicy?: DailyRangeRouteExitPolicySnapshot | null;
}

export type DailyRangePitQuality = "FULL_PIT" | "PARTIAL_RECONSTRUCTION" | "UNAVAILABLE";
export type DailyRangeCounterfactualStatus = "PENDING" | "MATURE_TP" | "MATURE_SL" | "OUTCOME_AMBIGUOUS";

/** Detached execution-quality read captured when the signal batch is finalized. */
export interface DailyRangeSignalMarketQualitySnapshot {
  capturedAt: string;
  poolCapturedAt: string | null;
  /**
   * FULL_PIT requires the frozen UTC-day pool evidence plus a BBO captured in
   * the forward decision phase before allocation. The signal is only knowable
   * after C2 closes, so a current BBO naturally follows that candle; it is
   * causal when its exchange timestamp is not after the local decision read.
   * A recovery read is never allowed to upgrade an old signal to FULL_PIT.
   */
  pitQuality: DailyRangePitQuality;
  capturePhase: "FORWARD_BEFORE_ALLOCATION" | "RECOVERY_AFTER_ALLOCATION";
  bookSnapshotQuality:
    | "STRICT_AT_OR_BEFORE_SIGNAL"
    | "AT_DECISION_BEFORE_ALLOCATION"
    | "NEAR_SIGNAL_AFTER_CLOSE"
    | "RECOVERY_AFTER_ALLOCATION"
    | "FUTURE_OF_DECISION"
    | "UNAVAILABLE";
  bookObservedAt: string | null;
  /** Local receipt timestamp of the exact BBO payload; legacy rows may omit it. */
  bookReceivedAt?: string | null;
  /** Exchange event timestamp, normalized from the BBO payload when supplied. */
  bboEventTime?: string | null;
  /** Explicit alias for decision/audit consumers; never synthesized from a later read. */
  bboReceivedAt?: string | null;
  bookSourceTime: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  quoteVolume24hUsd: number | null;
  medianSpreadBps: number | null;
  currentSpreadBps: number | null;
  fiveMinuteData: "OK" | "MISSING" | "STALE" | "GAPPED" | null;
  fourHourData: "OK" | "MISSING" | "STALE" | "GAPPED" | null;
  listedDays: number | null;
  c1Pass: boolean | null;
  c2Pass: boolean | null;
  c3Pass: boolean | null;
  c4Pass: boolean | null;
  c5Pass: boolean | null;
  c6Pass: boolean | null;
  poolAudit: DailyRangePoolSymbolAudit | null;
  /**
   * The feature builder runs before allocation. Age is measured from that
   * immutable capture to allocation; null means the candidate never obtained a
   * complete feature snapshot and cannot be represented as fresh.
   */
  featureSnapshotAt?: string | null;
  featureAgeMs?: number | null;
}

/** Small, interpretable, no-lookahead feature record. It is data collection only. */
export interface DailyRangeSignalFeatureSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  sourceBarCloseTime: number;
  pitQuality: DailyRangePitQuality;
  breakout: {
    boundary: number;
    c1ExtensionPrice: number;
    c2ExtensionPrice: number;
    c1ExtensionOfRange: number | null;
    c2ExtensionOfRange: number | null;
    c2ExtensionOfAtr: number | null;
    c2ExtensionPct: number | null;
    atr14: number | null;
    realizedVolatility: number | null;
  };
  relativeVolume: {
    confirmation1: number | null;
    confirmation2: number | null;
    c1Vs12: number | null;
    c1Vs24: number | null;
    c1Vs36: number | null;
    c2Vs12: number | null;
    c2Vs24: number | null;
    c2Vs36: number | null;
    combinedVs12: number | null;
    combinedVs24: number | null;
    combinedVs36: number | null;
  };
  trend: {
    return1h: number | null;
    return4h: number | null;
    sideAlignedReturn1h: number | null;
    sideAlignedReturn4h: number | null;
    sideAligned1h: boolean | null;
    sideAligned4h: boolean | null;
  };
  rangeQuality: {
    rangeWidthOfPrice: number | null;
    rangeWidthOfAtr: number | null;
    referenceBodyOfRange: number | null;
    upperWickPct: number | null;
    lowerWickPct: number | null;
    referenceVolume: number | null;
    referenceVolumeVsRecent: number | null;
  };
  marketRegime: {
    btcReturn1h: number | null;
    btcReturn4h: number | null;
    ethReturn1h: number | null;
    ethReturn4h: number | null;
    btcSideAligned1h: boolean | null;
    btcSideAligned4h: boolean | null;
    universePositive1hPct: number | null;
    universeNegative1hPct: number | null;
  };
}

/** Research-only mirror of the incumbent entry/SL/2R semantics; never sends an order. */
export interface DailyRangeCounterfactualOutcome {
  status: DailyRangeCounterfactualStatus;
  entryConvention: "C2_CLOSE_PIT_CANONICAL_V1" | "AUTO_ROUTE_5M_CLOSE_PIT_V2" | "AUTO_ROUTE_5M_CLOSE_PIT_V3" | "STRUCTURAL_BBO_PIT_V1";
  entryPrice: number;
  structuralStop: number;
  takeProfit: number;
  /** Labels prevent a future 1R continuation record from blending with legacy 2R. */
  exitPolicyId?: string | null;
  tpMultipleR?: number | null;
  thesisInvalidationType?: string | null;
  tickSize: number | null;
  quantity: number | null;
  modeledEntryFeeBps: number;
  modeledExitFeeBps: number;
  modeledSlippageBps: number;
  startedAt: string;
  lastCheckedBarOpenTime: number | null;
  maturedAt: string | null;
  grossR: number | null;
  netModeledR: number | null;
  grossPnlUsd: number | null;
  netModeledPnlUsd: number | null;
  mfePct: number | null;
  maePct: number | null;
  holdingDurationMs: number | null;
  ambiguityReason: string | null;
}

export interface DailyRangeSignalResearchRecord {
  marketQuality: DailyRangeSignalMarketQualitySnapshot | null;
  features: DailyRangeSignalFeatureSnapshot | null;
  counterfactual: DailyRangeCounterfactualOutcome | null;
}

/** A shadow selector record has no allocation authority until a separately approved artifact exists. */
export interface DailyRangeAlphaSelectorSnapshot {
  policyId: typeof DAILY_RANGE_ALPHA_SELECTOR_POLICY_ID;
  selectorId: string | null;
  status: "SHADOW_ONLY" | "VALIDATED" | "UNAVAILABLE" | "FALLBACK_ECONOMIC";
  pTp: number | null;
  expectedNetR: number | null;
  expectedNetUsd: number | null;
  /** Read-only route-aware payoff facts. Alpha remains non-authoritative. */
  tpMultipleR?: number | null;
  netWinR?: number | null;
  netLossR?: number | null;
  breakEvenWinRate?: number | null;
  reason: "ALPHA_SELECTOR_SHADOW_ONLY" | "SELECTOR_NOT_READY" | "NEGATIVE_EXPECTED_VALUE" | null;
  featureSnapshotAt: string | null;
}

export interface DailyRangeSignalCohortCandidate {
  signalId: string;
  symbol: string;
  direction: DailyRangeDirection;
  /** Exact order handed to the unchanged baseline entry loop for this scheduler tick. */
  executionSequence: number;
  cohortSequence: number;
  rangeHigh: number;
  rangeLow: number;
  rangeWidth: number;
  rangeWidthPct: number | null;
  confirmationClose: number;
  /**
   * Signed C2 distance from the original breakout boundary. It is positive
   * while price remains outside; a FADE correctly records a non-positive
   * value because C2 is the confirmed re-entry inside the range.
   */
  breakoutDistancePrice: number;
  /** Same distance normalized by that symbol's frozen 4h range width. */
  breakoutDistanceOfRange: number | null;
  /** Immutable day-level C1-C6 evidence for this candidate, if capture completed. */
  poolAudit: DailyRangePoolSymbolAudit | null;
  marketQuality?: DailyRangeSignalMarketQualitySnapshot | null;
  features?: DailyRangeSignalFeatureSnapshot | null;
  counterfactual?: DailyRangeCounterfactualOutcome | null;
  selectorMode?: DailyRangeAllocatorMode;
  selectorId?: string | null;
  selectorScore?: number | null;
  selectorRank?: number | null;
  tieBreakHash?: string | null;
  economics?: DailyRangePreTradeEconomics | null;
  routeExecutionEnabled?: boolean;
  executionEligible?: boolean;
  geometry?: DailyRangeTradeGeometry | null;
  routeExitPolicy?: DailyRangeRouteExitPolicySnapshot | null;
  alphaSelector?: DailyRangeAlphaSelectorSnapshot | null;
  actuallySelected?: boolean;
  actuallyExecuted?: boolean;
  skipReason?: DailyRangeSignalReason | null;
  /** Filled only from the existing signal outcome; no extra execution decision is made here. */
  decision: {
    entryEligible: boolean;
    reason: DailyRangeSignalReason | null;
    tradeId: string | null;
    entryAttemptedAt: string | null;
  } | null;
}

/** Candidates that competed in one completed 5m bar.  This is observation-only. */
export interface DailyRangeSignalCohort {
  cohortId: string;
  strategyVersion: DailyRangeStrategyVersion;
  laneId: typeof DAILY_RANGE_LANE_ID;
  selectorPolicyVersion: string;
  dateUtc: string;
  signalTimestamp: string;
  signalTimestampMs: number;
  observedAt: string;
  finalizedAt: string | null;
  candidates: DailyRangeSignalCohortCandidate[];
  /** Absent on passive pre-fix cohorts; they are never retroactively allocated. */
  allocation?: {
    allocatorMode: DailyRangeAllocatorMode;
    effectiveAllocatorMode?: DailyRangeAllocatorMode;
    selectorStatus: "SHADOW" | "VALIDATED" | "NOT_READY";
    selectorId: string | null;
    availableSlots: number | null;
    pendingReservationsAtBatch: number;
    candidateCount: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    oversubscriptionRatio: number | null;
    batchComplete: boolean;
    selectedSignalIds: string[];
    finalizedAt: string | null;
    allocationError: string | null;
    economicsPolicyId?: string;
    frictionModelId?: string | null;
    frictionModelSource?: "EMPIRICAL_LEDGER" | "CONSERVATIVE_FALLBACK" | null;
    allocationCutoffAt?: string | null;
    /** Same-batch observation freshness, calculated from persisted candidates. */
    minFeatureAgeMs?: number | null;
    maxFeatureAgeMs?: number | null;
    featureAgeSpreadMs?: number | null;
  };
}

export type DailyRangeHistoryKind = "levels" | "signals" | "trades" | "cohorts" | "batches" | "pool-evidence";

export type DailyRangeOpenPositionGeometryMigrationStatus = "PASS" | "FAIL" | "UNKNOWN" | "BLOCKED" | "FROZEN";
export type DailyRangeOpenPositionGeometryMigrationReason =
  | DailyRangeGeometryRejectReason
  | "OPEN_POSITION_ATR_MIGRATION_UNKNOWN"
  | "FROZEN_PRE_STRUCTURAL_POLICY"
  | "OPERATOR_REQUESTED_CLOSE_GEOMETRY_PATCH"
  | "OPUSDT_OWNERSHIP_CONFLICT"
  | "OPEN_POSITION_OWNERSHIP_CONFLICT";

/**
 * Durable one-time evaluation for a trade opened before geometry-v1.  It keeps
 * the original entry/SL/TP untouched for PASS/UNKNOWN rows and records every
 * safe flatten attempt explicitly for audit/restart recovery.
 */
export interface DailyRangeOpenPositionGeometryMigration {
  geometryPolicyId: typeof DAILY_RANGE_TRADE_GEOMETRY_POLICY_ID;
  evaluatedAt: string;
  originalDecisionAt: string | null;
  status: DailyRangeOpenPositionGeometryMigrationStatus;
  reason: DailyRangeOpenPositionGeometryMigrationReason | null;
  action: "KEPT" | "FLATTEN_PENDING" | "FLATTENED" | "BLOCKED";
  geometry: DailyRangeTradeGeometry;
}

export interface DailyRangeTrade {
  tradeId: string;
  signalId: string;
  strategyVersion: DailyRangeStrategyVersion;
  laneId: typeof DAILY_RANGE_LANE_ID;
  dateUtc: string;
  symbol: string;
  direction: DailyRangeDirection;
  status: DailyRangeTradeStatus;
  entryOrderId: string | null;
  entryClientOrderId: string;
  signalTimestamp: string;
  entrySubmittedAt: string;
  entryFilledAt: string | null;
  entryFillPrice: number | null;
  entryQty: number | null;
  /** Exact user-fill count when settlement has been observed. */
  entryFillCount?: number | null;
  /** Exact rounded market quantity persisted before POST for unknown-order reconciliation. */
  requestedQty: number | null;
  entryNotionalUsd: number | null;
  entrySlippageBps: number | null;
  signalReferencePrice: number | null;
  /** Immutable V3 decision facts, persisted before the market POST. */
  economics?: DailyRangePreTradeEconomics | null;
  /** Immutable candidate-time geometry; actual fills never rewrite it. */
  geometry?: DailyRangeTradeGeometry | null;
  alphaSelector?: DailyRangeAlphaSelectorSnapshot | null;
  actualStopRiskBps?: number | null;
  actualCostRatio?: number | null;
  /** Explicitly distinguish economics from a material dollar-risk breach. */
  actualInitialRiskUsd?: number | null;
  actualEffectiveLossUsd?: number | null;
  postFillEconomicsStatus?: "PASS" | "POST_FILL_ECONOMICS_FAIL" | "POST_FILL_RISK_FAIL" | null;
  postFillGeometryStatus?: "PASS" | DailyRangeGeometryRejectReason | null;
  /** One-time upgrade audit for a position that existed before geometry-v1. */
  geometryMigration?: DailyRangeOpenPositionGeometryMigration | null;
  rangeHigh: number;
  rangeLow: number;
  /** V2/V3 route + reference lineage; absent fields identify untouched legacy trades. */
  entryPolicy?: DailyRangeEntryPolicy;
  /** Preserved from the originating V3 signal for execution audit. */
  entryTiming?: DailyRangeAutoRouteEntryTiming | null;
  breakoutDirection?: DailyRangeBreakoutDirection | null;
  breakoutId?: string | null;
  breakoutExtreme?: number | null;
  referenceTimezone?: "UTC" | "America/New_York";
  referenceRangeOpenTime?: number | null;
  referenceRangeCloseTime?: number | null;
  /** Frozen for new route-specific exits; absence is the immutable legacy policy. */
  routeExitPolicy?: DailyRangeRouteExitPolicySnapshot | null;
  /** Durable completed-bar watermark for the logical exit watcher. */
  lastThesisInvalidationBarOpenTime?: number | null;
  thesisInvalidation?: DailyRangeThesisInvalidationRecord | null;
  confirmationBar1: DailyRangeCandle;
  confirmationBar2: DailyRangeCandle;
  structuralStopRaw: number;
  /** Frozen raw target from the selected PIT-safe structural S/R level. */
  structuralTargetRaw?: number | null;
  stopPrice: number | null;
  takeProfitRaw: number | null;
  takeProfitPrice: number | null;
  /** Frozen rounded 2R target for post-logical-exit research only. */
  oldPolicyTakeProfitPrice?: number | null;
  initialRiskPrice: number | null;
  initialRiskPct: number | null;
  initialRiskDollar: number | null;
  /** Retained for legacy reporting; new V1 rows equal routeExitPolicy.tpMultipleR. */
  rrTarget: number;
  stopAlgoOrderId: string | null;
  stopClientAlgoId: string;
  takeProfitAlgoOrderId: string | null;
  takeProfitClientAlgoId: string;
  exitOrderId: string | null;
  exitClientOrderId: string | null;
  exitReason: string | null;
  exitTimestamp: string | null;
  exitPrice: number | null;
  /** Executable bid/ask captured immediately before a lane-originated market exit. */
  exitReferencePrice: number | null;
  /** Positive means adverse slippage versus exitReferencePrice. Null for native trigger exits without a pre-trigger quote. */
  exitSlippageBps: number | null;
  grossPnlUsd: number | null;
  feesUsd: number | null;
  /** Exact per-order commissions for V3 and later. Legacy records retain only feesUsd. */
  entryFeesUsd?: number | null;
  exitFeesUsd?: number | null;
  exitFillCount?: number | null;
  feeEvidence?: "EXACT_FILL_COMMISSION" | "LEGACY_COMBINED_FEE_ALLOCATION" | null;
  fundingUsd: number | null;
  netPnlUsd: number | null;
  grossR: number | null;
  realizedR: number | null;
  mfePct: number | null;
  maePct: number | null;
  mfeR: number | null;
  maeR: number | null;
  /** Native brackets trigger on CONTRACT_PRICE, so this path observes contract trades, not account mark snapshots. */
  mfePrice?: number | null;
  mfeEventTime?: string | null;
  maePrice?: number | null;
  maeEventTime?: string | null;
  lastPathPrice?: number | null;
  lastPathEventTime?: string | null;
  lastPathReceivedAt?: string | null;
  /** Latest source that contributed a persisted excursion observation. */
  pathSource?: DailyRangeContractPathSource | null;
  /** Exact only when a continuous contract-trade stream covers entry through terminal exit. */
  pathQuality?: DailyRangePathQuality | null;
  pathStreamStartedAt?: string | null;
  pathGapReason?: string | null;
  /** Terminal wall clock when the measurement window was closed. Later events are ignored. */
  pathFrozenAt?: string | null;
  pathRecoveryAt?: string | null;
  pathRecoveryReason?: string | null;
  /** Present only on new BREAKOUT FADE trades after the MFE 50/75 V1 cutover. */
  fadeMfe?: DailyRangeFadeMfeState | null;
  /** Read-only original-bracket outcome after a real MFE logical exit. */
  fadeMfeCounterfactual?: DailyRangeFadeMfeCounterfactual | null;
  lastMarkPrice: number | null;
  holdingDurationMs: number | null;
  /**
   * Immutable SVG artifact created after a confirmed close. It is presentation
   * evidence only: a missing chart must never block a real exit settlement.
   */
  closedChartSnapshot?: DailyRangeClosedChartSnapshot | null;
  abortReason: string | null;
  lastReconcileError: string | null;
}

export interface DailyRangeOldPolicyCounterfactual {
  status: "PENDING" | "MATURE_TP" | "MATURE_SL" | "OUTCOME_AMBIGUOUS" | "UNAVAILABLE";
  exitPolicyId: "legacy-global-2r-bracket";
  tpMultipleR: 2;
  structuralStop: number;
  takeProfit: number;
  startedAt: string;
  lastCheckedBarOpenTime: number | null;
  maturedAt: string | null;
  exitPrice: number | null;
  grossR: number | null;
  ambiguityReason: string | null;
}

/** Research-only continuation of the original native structural bracket after an MFE exit. */
export interface DailyRangeFadeMfeCounterfactual {
  status: "PENDING" | "MATURE_TP" | "MATURE_SL" | "OUTCOME_AMBIGUOUS" | "UNAVAILABLE";
  originalStructuralSL: number;
  originalStructuralTP: number;
  startedAt: string;
  lastCheckedBarOpenTime: number | null;
  maturedAt: string | null;
  exitPrice: number | null;
  grossR: number | null;
  ambiguityReason: string | null;
}

/** Immutable evidence captured before the canonical logical flatten begins. */
export interface DailyRangeThesisInvalidationRecord {
  reason: DailyRangeThesisInvalidationReason;
  invalidationCandleOpenTime: number;
  invalidationCandleCloseTime: number;
  invalidationClose: number;
  referenceBoundary: number;
  distanceFromBoundary: number;
  mfeAtThesisInvalidation: number | null;
  maeAtThesisInvalidation: number | null;
  actualExitFill: number | null;
  exitSlippageBps: number | null;
  oldStructuralStop: number | null;
  oldNativeTakeProfit: number | null;
  oldPolicyCounterfactual: DailyRangeOldPolicyCounterfactual | null;
}

/**
 * The only account-level claim this isolated lane is allowed to publish.  It
 * exists for reconciliation/reporting; it never carries permission for another
 * component to amend, close, or resize the trade.
 */
export interface DailyRangeOpenPositionClaim {
  laneId: typeof DAILY_RANGE_LANE_ID;
  tradeId: string;
  symbol: string;
  direction: DailyRangeDirection;
  qty: number;
  entryPrice: number;
  openedAt: string;
  status: Extract<DailyRangeTradeStatus, "PROTECTING" | "OPEN" | "EXIT_RECONCILING">;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  entryPolicy: DailyRangeEntryPolicy;
  exitPolicyId: string | null;
  tpMultipleR: number;
  thesisInvalidationType: string | null;
  lastReconcileError: string | null;
}

export interface DailyRangeCanaryEvidence {
  canaryId: string;
  at: string;
  status: "RUNNING" | "PASSED" | "FAILED";
  symbol: string | null;
  side: "BUY";
  intendedNotionalUsd: number;
  leverage: number;
  /** Exact rounded quantity reserved before the canary MARKET POST. Optional for pre-v2 evidence. */
  requestedQty?: number | null;
  entryOrderId: string | null;
  entryClientOrderId: string | null;
  entryFillPrice: number | null;
  entryQty: number | null;
  stopAlgoOrderId: string | null;
  takeProfitAlgoOrderId: string | null;
  closeOrderId: string | null;
  positionVerified: boolean;
  bracketVerified: boolean;
  bracketCancelled: boolean;
  closeVerified: boolean;
  orphanOrders: number | null;
  orphanPosition: boolean | null;
  failure: string | null;
}

export interface DailyRangeRuntimeState {
  reconciledAt: string | null;
  reconciliationError: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastProcessedMarketBarOpenTime: number | null;
  startedAt: string | null;
}

interface DailyRangePersistedState {
  version: 1;
  control: {
    mode: DailyRangeControlMode;
    armedAt: string | null;
    disarmedAt: string | null;
    disarmReason: string | null;
  };
  days: Record<string, DailyRangeDayState>;
  signals: DailyRangeSignal[];
  signalCohorts: DailyRangeSignalCohort[];
  trades: DailyRangeTrade[];
  canaries: DailyRangeCanaryEvidence[];
  /** Immutable model snapshots; a decision day points to exactly one id. */
  frictionModels?: DailyRangeFrictionModel[];
  frictionModelByUtcDate?: Record<string, string>;
  runtime: DailyRangeRuntimeState;
}

interface DailyRangeAllocatorLock {
  readonly ownerId: string;
  release(): void;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcDayStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function firstReferenceReadyAtMs(ms: number): number {
  return utcDayStartMs(ms) + FOUR_HOURS_MS;
}

export function inDailyRangeEntryWindow(ms: number): boolean {
  const start = utcDayStartMs(ms);
  return ms >= start + FOUR_HOURS_MS && ms < start + DAY_MS;
}

export interface DailyRangeReferenceWindow {
  date: string;
  timezone: "America/New_York";
  rangeOpenTime: number;
  rangeCloseTime: number;
  entryWindowCloseTime: number;
}

function zonedDateParts(ms: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const read = (kind: "year" | "month" | "day"): number => Number(parts.find((part) => part.type === kind)?.value);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`cannot resolve ${timeZone} calendar date`);
  }
  return { year, month, day };
}

function zonedOffsetMs(ms: number, timeZone: string): number {
  const token = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(ms)).find((part) => part.type === "timeZoneName")?.value ?? "";
  if (token === "GMT") return 0;
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(token);
  if (!match) throw new Error(`cannot resolve ${timeZone} offset (${token || "missing"})`);
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return (match[1] === "+" ? 1 : -1) * minutes * 60_000;
}

/**
 * Convert an unambiguous wall-clock New York timestamp to UTC.  The strategy
 * only asks for midnight and 04:00, which exist on both US DST transition days;
 * the iteration still rechecks the offset at the candidate instant so a 3h/5h
 * real-time session is represented correctly.
 */
function newYorkWallClockMs(year: number, month: number, day: number, hour: number): number {
  const nominalUtc = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let candidate = nominalUtc - zonedOffsetMs(nominalUtc, NEW_YORK_TIME_ZONE);
  for (let attempt = 0; attempt < 2; attempt++) {
    const corrected = nominalUtc - zonedOffsetMs(candidate, NEW_YORK_TIME_ZONE);
    if (corrected === candidate) return corrected;
    candidate = corrected;
  }
  return candidate;
}

/** Completed 00:00-04:00 America/New_York session and same-local-day entry window. */
export function newYorkDailyRangeWindow(ms: number): DailyRangeReferenceWindow {
  const { year, month, day } = zonedDateParts(ms, NEW_YORK_TIME_ZONE);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const rangeOpenTime = newYorkWallClockMs(year, month, day, 0);
  const rangeCloseTime = newYorkWallClockMs(year, month, day, 4);
  const entryWindowCloseTime = newYorkWallClockMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0);
  return {
    date: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    timezone: NEW_YORK_TIME_ZONE,
    rangeOpenTime,
    rangeCloseTime,
    entryWindowCloseTime,
  };
}

export function inNewYorkDailyRangeEntryWindow(ms: number): boolean {
  const window = newYorkDailyRangeWindow(ms);
  return ms >= window.rangeCloseTime && ms < window.entryWindowCloseTime;
}

function lastClosedFiveMinuteOpenTime(ms: number): number | null {
  const currentOpen = Math.floor(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
  const completedOpen = currentOpen - FIVE_MIN_MS;
  return completedOpen >= 0 ? completedOpen : null;
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function blankSymbolState(lastProcessedBarOpenTime: number | null): DailyRangeSymbolState {
  return {
    lastProcessedBarOpenTime,
    previousClosedCandle: null,
    longCount: 0,
    shortCount: 0,
    longLocked: false,
    shortLocked: false,
  };
}

function blankRouterState(): DailyRangeRouterState {
  return blankDailyRangeAutoRouteState();
}

function routerStateFor(symbolState: DailyRangeSymbolState): DailyRangeRouterState {
  const prior = symbolState.router;
  if (prior) return prior;
  const next = blankRouterState();
  symbolState.router = next;
  return next;
}

function clonePoolAudit(audit: DailyRangePoolSymbolAudit): DailyRangePoolSymbolAudit {
  return { ...audit, failures: [...audit.failures] };
}

/** The pool keeps rolling evidence; a Daily day must own a detached copy. */
function clonePoolEvidence(evidence: DailyRangePoolEvidence | null | undefined): DailyRangePoolEvidence | null {
  if (!evidence) return null;
  return {
    ...evidence,
    activeSymbols: [...evidence.activeSymbols],
    thresholds: { ...evidence.thresholds },
    reconciliation: evidence.reconciliation
      ? {
        ...evidence.reconciliation,
        adds: [...evidence.reconciliation.adds],
        drops: [...evidence.reconciliation.drops],
        rejectionCounts: { ...evidence.reconciliation.rejectionCounts },
        crossSectionalExcluded: [...evidence.reconciliation.crossSectionalExcluded],
        strategyOwnedExcluded: [...evidence.reconciliation.strategyOwnedExcluded],
      }
      : null,
    auditBySymbol: Object.fromEntries(Object.entries(evidence.auditBySymbol)
      .map(([symbol, audit]) => [symbol, clonePoolAudit(audit)])),
    missingAuditSymbols: [...evidence.missingAuditSymbols],
  };
}

function compactPoolEvidenceForSymbol(
  evidence: DailyRangePoolEvidence | null | undefined,
  symbol: string,
): DailyRangePoolEvidence | null {
  const cloned = clonePoolEvidence(evidence);
  if (!cloned) return null;
  const normalized = normalizeSymbol(symbol);
  const audit = cloned.auditBySymbol[normalized] ?? null;
  return {
    ...cloned,
    activeSymbols: cloned.activeSymbols.includes(normalized) ? [normalized] : [],
    auditBySymbol: audit ? { [normalized]: audit } : {},
    missingAuditSymbols: audit ? [] : [normalized],
  };
}

function cohortPoolEvidenceForSymbol(day: DailyRangeDayState, symbol: string): DailyRangePoolEvidence | null {
  const normalized = normalizeSymbol(symbol);
  return day.borrowedUniverseAdmissions?.[normalized]?.poolEvidence ?? day.poolEvidence ?? null;
}

function cloneCohortPoolAudit(day: DailyRangeDayState, symbol: string): DailyRangePoolSymbolAudit | null {
  const audit = cohortPoolEvidenceForSymbol(day, symbol)?.auditBySymbol[normalizeSymbol(symbol)] ?? null;
  return audit ? clonePoolAudit(audit) : null;
}

function isAutoRouteStrategyVersion(strategyVersion: DailyRangeStrategyVersion): boolean {
  return strategyVersion === DAILY_RANGE_AUTO_ROUTE_STRATEGY_VERSION
    || strategyVersion === DAILY_RANGE_AUTO_ROUTE_V3_STRATEGY_VERSION;
}

function signalCohortId(strategyVersion: DailyRangeStrategyVersion, dateUtc: string, signalTimestampMs: number): string {
  const prefix = strategyVersion === DAILY_RANGE_AUTO_ROUTE_V3_STRATEGY_VERSION
    ? "drra3-cohort"
    : strategyVersion === DAILY_RANGE_AUTO_ROUTE_STRATEGY_VERSION ? "drra2-cohort" : "drra-cohort";
  return `${prefix}-${dateUtc}-${signalTimestampMs}`;
}

function emptyState(nowMs: number): DailyRangePersistedState {
  return {
    version: 1,
    control: { mode: "DISARMED", armedAt: null, disarmedAt: iso(nowMs), disarmReason: "initial state" },
    days: {},
    signals: [],
    signalCohorts: [],
    trades: [],
    canaries: [],
    frictionModels: [],
    frictionModelByUtcDate: {},
    runtime: {
      reconciledAt: null,
      reconciliationError: null,
      lastTickAt: null,
      lastError: null,
      lastProcessedMarketBarOpenTime: null,
      startedAt: iso(nowMs),
    },
  };
}

/**
 * A separate, atomic JSON state file.  Unlike incumbent best-effort telemetry
 * stores, failure to persist a new entry state is surfaced to the caller so an
 * order can never be sent without a durable ownership/reconciliation handle.
 */
export class DailyRangeLaneStore {
  private readonly file: string;
  private state: DailyRangePersistedState;

  constructor(dataDir = "data", fileName = "daily-4h-range-acceptance-2r-v1.json", nowMs = Date.now()) {
    this.file = resolve(dataDir, fileName);
    mkdirSync(dirname(this.file), { recursive: true });
    this.state = this.load(nowMs);
  }

  private load(nowMs: number): DailyRangePersistedState {
    try {
      if (!existsSync(this.file)) return emptyState(nowMs);
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DailyRangePersistedState>;
      if (parsed?.version !== 1 || !parsed.control || !parsed.days || !Array.isArray(parsed.signals) || !Array.isArray(parsed.trades)) {
        return emptyState(nowMs);
      }
      return {
        version: 1,
        control: {
          mode: parsed.control.mode === "ARMED" ? "ARMED" : "DISARMED",
          armedAt: parsed.control.armedAt ?? null,
          disarmedAt: parsed.control.disarmedAt ?? null,
          disarmReason: parsed.control.disarmReason ?? null,
        },
        days: parsed.days as Record<string, DailyRangeDayState>,
        signals: parsed.signals as DailyRangeSignal[],
        signalCohorts: Array.isArray(parsed.signalCohorts) ? parsed.signalCohorts as DailyRangeSignalCohort[] : [],
        trades: parsed.trades as DailyRangeTrade[],
        canaries: Array.isArray(parsed.canaries) ? parsed.canaries as DailyRangeCanaryEvidence[] : [],
        frictionModels: Array.isArray(parsed.frictionModels) ? parsed.frictionModels as DailyRangeFrictionModel[] : [],
        frictionModelByUtcDate: parsed.frictionModelByUtcDate && typeof parsed.frictionModelByUtcDate === "object"
          ? parsed.frictionModelByUtcDate as Record<string, string>
          : {},
        runtime: {
          reconciledAt: parsed.runtime?.reconciledAt ?? null,
          reconciliationError: parsed.runtime?.reconciliationError ?? null,
          lastTickAt: parsed.runtime?.lastTickAt ?? null,
          lastError: parsed.runtime?.lastError ?? null,
          lastProcessedMarketBarOpenTime: parsed.runtime?.lastProcessedMarketBarOpenTime ?? null,
          startedAt: parsed.runtime?.startedAt ?? iso(nowMs),
        },
      };
    } catch {
      // A corrupt file cannot safely prove order ownership.  Preserve it for forensics
      // and start with a safe disarmed state rather than trading from invented data.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // The caller will remain disarmed when persistence cannot be repaired.
      }
      return emptyState(nowMs);
    }
  }

  getState(): DailyRangePersistedState {
    return this.state;
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf8");
    renameSync(tmp, this.file);
  }

  /** Durable, release-shared archive beside the state ledger. */
  closedChartSnapshotDirectory(): string {
    return resolve(dirname(this.file), "daily-range-closed-chart-snapshots");
  }

  /**
   * One allocator authority for the shared per-environment state file.  The
   * normal PM2 topology is one process, but this lock makes an accidental second
   * process fail closed before it can reserve the same portfolio slot.  A dead
   * owner can be recovered only after a conservative stale period.
   */
  tryAcquireAllocatorLock(nowMs: number): DailyRangeAllocatorLock | null {
    const path = `${this.file}.allocator.lock`;
    const ownerId = randomUUID();
    const attempt = (): DailyRangeAllocatorLock | null => {
      try {
        const fd = openSync(path, "wx", 0o640);
        try {
          writeFileSync(fd, JSON.stringify({ ownerId, pid: process.pid, acquiredAtMs: nowMs }), "utf8");
        } finally {
          closeSync(fd);
        }
        return {
          ownerId,
          release: () => {
            try {
              const current = JSON.parse(readFileSync(path, "utf8")) as { ownerId?: string };
              if (current.ownerId === ownerId) unlinkSync(path);
            } catch {
              // A restart or already-released lock is safe: never unlink an unknown owner.
            }
          },
        };
      } catch {
        return null;
      }
    };
    const acquired = attempt();
    if (acquired) return acquired;
    try {
      const prior = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; acquiredAtMs?: number };
      const pid = Number(prior.pid);
      const acquiredAtMs = Number(prior.acquiredAtMs);
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (!alive && Number.isFinite(acquiredAtMs) && nowMs - acquiredAtMs >= ALLOCATOR_LOCK_STALE_MS) {
        renameSync(path, `${path}.stale-${nowMs}`);
        return attempt();
      }
    } catch {
      // Unknown lock provenance is not safe to remove. The caller will retry on a later tick.
    }
    return null;
  }

  arm(at: string): void {
    this.state.control = { mode: "ARMED", armedAt: at, disarmedAt: null, disarmReason: null };
    this.save();
  }

  disarm(at: string, reason: string): void {
    this.state.control = { ...this.state.control, mode: "DISARMED", disarmedAt: at, disarmReason: reason };
    this.save();
  }

  hasActiveSymbolLease(symbol: string): DailyRangeTrade | null {
    const normalized = normalizeSymbol(symbol);
    return this.state.trades.find((trade) =>
      trade.symbol === normalized &&
      ["ENTRY_SUBMITTING", "ENTRY_RECONCILING", "PROTECTING", "OPEN", "EXIT_RECONCILING"].includes(trade.status),
    ) ?? null;
  }

  findTrade(tradeId: string): DailyRangeTrade | null {
    return this.state.trades.find((trade) => trade.tradeId === tradeId) ?? null;
  }

  findSignal(signalId: string): DailyRangeSignal | null {
    return this.state.signals.find((signal) => signal.signalId === signalId) ?? null;
  }
}

export type DailyRangeExecClient = Pick<
  BinanceFuturesPrivateClient,
  | "getExchangeFilters"
  | "getPositions"
  | "getOpenOrders"
  | "getOpenAlgoOrders"
  | "getBookTicker"
  | "getKlines"
  | "isHedgeMode"
  | "setLeverage"
  | "placeOrder"
  | "placeAlgoOrder"
  | "queryOrder"
  | "queryOrderByClientId"
  | "queryAlgoOrder"
  | "cancelOrder"
  | "cancelAlgoOrder"
  | "getUserTrades"
  | "getIncomeHistory"
>;

export interface DailyRangeUniverseSnapshot {
  symbols: string[];
  source: string;
  /** Optional so legacy/test fixtures remain valid; production supplies it from the auto-pool. */
  poolEvidence?: DailyRangePoolEvidence | null;
  /** MOM36 symbols temporarily admitted under the controlled borrowing policy. */
  borrowedSymbols?: string[];
}

export interface DailyRangeEntryClaims {
  tryClaimEntrySymbol: (symbol: string, owner: string) => boolean;
  releaseEntrySymbol: (symbol: string, owner: string) => void;
}

/** Account-level safety gate, deliberately independent from Daily Range's signal logic. */
export interface DailyRangeEntryGateDecision {
  allowed: boolean;
  reason: string | null;
}

/** Per-symbol ownership/priority gate checked again immediately before entry. */
export interface DailyRangeSymbolEntryGateDecision {
  allowed: boolean;
  reason: string | null;
}

export interface DailyRangeAcceptanceLaneOptions {
  client: DailyRangeExecClient;
  store: DailyRangeLaneStore;
  /** Current durable C1/C2 pool. It is copied once into each UTC day record. */
  getUniverse: () => DailyRangeUniverseSnapshot;
  /**
   * Latest C1-C6 evidence used for the live, same-batch preflight only.  It is
   * never substituted for the frozen day evidence in research features.
   */
  getSignalPoolEvidence?: (symbols: readonly string[]) => DailyRangePoolEvidence | null;
  getShortBlocklist: () => ReadonlySet<string>;
  entryClaims: DailyRangeEntryClaims;
  /**
   * Read-only ownership view of every non-Daily lane.  Geometry migration uses
   * it as an additional stop condition before it can send a reduce-only close.
   */
  foreignOwnershipForSymbol?: (symbol: string) => readonly string[];
  environment: "testnet" | "mainnet";
  /** Omitted means Mainnet is observation-only and structurally cannot enter. */
  mainnetControls?: DailyRangeMainnetControls;
  /**
   * Testnet executes the neutral baseline under the same finite portfolio cap
   * as the Live strategy. Mainnet always uses its dedicated controls instead.
   */
  testnetMaxOpenTrades?: number;
  /** Mainnet account-health / kill-switch gate. It cannot relax lane-local controls. */
  entryGate?: () => DailyRangeEntryGateDecision;
  /** Cannot relax C1-C6; only blocks a symbol that has been returned to another lane. */
  symbolEntryGate?: (symbol: string) => DailyRangeSymbolEntryGateDecision;
  /** Best-effort notification after one real, settled lane close. */
  onTradeClosed?: (netPnlUsd: number) => void;
  /** PAUSED is the Mainnet-safe default; Testnet defaults to the non-alpha economic baseline. */
  allocatorMode?: DailyRangeAllocatorMode;
  /** Null until a separately promoted model artifact exists. */
  selectorId?: string | null;
  /** Read-only artifact registry status; it never grants allocation authority. */
  selectorArtifactStatus?: () => DailyRangeSelectorArtifactRegistryStatus;
  /**
   * Production selects AUTO_ROUTE_NY_V2/V3 explicitly. The legacy default is
   * retained for deterministic historical fixtures and old durable records.
   */
  strategyMode?: DailyRangeStrategyMode;
  /** Required by the V3 app wiring; omitted mode remains the historical V2 route. */
  autoRouteEntryMode?: DailyRangeAutoRouteEntryMode;
  /**
   * Explicit opt-in for new Structural S/R V1 entries.  Omitting this keeps
   * legacy fixtures and immutable historical rows on their existing policy.
   */
  structuralSrPolicyEnabled?: boolean;
  nowMs?: () => number;
  confirmRetryMs?: number;
}

function symbolSide(direction: DailyRangeDirection): "BUY" | "SELL" {
  return direction === "LONG" ? "BUY" : "SELL";
}

function exitSide(direction: DailyRangeDirection): "BUY" | "SELL" {
  return direction === "LONG" ? "SELL" : "BUY";
}

function directionSign(direction: DailyRangeDirection): number {
  return direction === "LONG" ? 1 : -1;
}

function roundToStep(value: number, step: number, mode: "down" | "up"): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  const units = value / step;
  const rounded = mode === "down" ? Math.floor(units + 1e-10) : Math.ceil(units - 1e-10);
  const result = rounded * step;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  return Number(result.toFixed(Math.min(14, decimals)));
}

export function roundDailyRangeBracket(input: {
  direction: DailyRangeDirection;
  entry: number;
  rawStop: number;
  tickSize: number;
  /** Explicit for V1 route exits; omitted only by frozen legacy 2R callers. */
  tpMultipleR?: number;
  /** Structural S/R V1 target. When present, this always wins over fixed R. */
  rawTarget?: number | null;
}): {
  stop: number;
  takeProfitRaw: number;
  takeProfit: number;
  riskPrice: number;
  rewardPrice: number;
} | null {
  if (!finitePositive(input.entry) || !finitePositive(input.rawStop) || !finitePositive(input.tickSize)) return null;
  const stop = input.direction === "LONG"
    ? roundToStep(input.rawStop, input.tickSize, "down")
    : roundToStep(input.rawStop, input.tickSize, "up");
  const riskPrice = input.direction === "LONG" ? input.entry - stop : stop - input.entry;
  if (!(riskPrice > EPSILON)) return null;
  const hasStructuralTarget = finitePositive(input.rawTarget);
  const tpMultipleR = finitePositive(input.tpMultipleR) ? input.tpMultipleR : DAILY_RANGE_RR;
  const takeProfitRaw = hasStructuralTarget
    ? input.rawTarget!
    : input.direction === "LONG"
      ? input.entry + tpMultipleR * riskPrice
      : input.entry - tpMultipleR * riskPrice;
  // A structural target is an obstacle, not a minimum distance.  Rounding a
  // long up through resistance (or a short down through support) would invent
  // reward the decision never had.
  const takeProfit = input.direction === "LONG"
    ? roundToStep(takeProfitRaw, input.tickSize, hasStructuralTarget ? "down" : "up")
    : roundToStep(takeProfitRaw, input.tickSize, hasStructuralTarget ? "up" : "down");
  const roundedReward = input.direction === "LONG" ? takeProfit - input.entry : input.entry - takeProfit;
  if (!(takeProfit > 0) || !(roundedReward > EPSILON)) return null;
  if (!hasStructuralTarget && roundedReward + EPSILON < tpMultipleR * riskPrice) return null;
  return { stop, takeProfitRaw, takeProfit, riskPrice, rewardPrice: roundedReward };
}

export function structuralStopForAcceptance(input: {
  direction: DailyRangeDirection;
  rangeHigh: number;
  rangeLow: number;
  confirmationBar1: DailyRangeCandle;
  confirmationBar2: DailyRangeCandle;
}): number {
  return input.direction === "LONG"
    ? Math.min(input.rangeHigh, input.confirmationBar1.low, input.confirmationBar2.low)
    : Math.max(input.rangeLow, input.confirmationBar1.high, input.confirmationBar2.high);
}

/** Exact per-policy stop source. Fade never substitutes a discretionary level. */
export function structuralStopForDailyRangeSignal(signal: Pick<
  DailyRangeSignal,
  "direction" | "rangeHigh" | "rangeLow" | "confirmationBar1" | "confirmationBar2" | "entryPolicy" | "breakoutExtreme"
>): number {
  if (signal.entryPolicy === "FADE") {
    const extreme = signal.breakoutExtreme;
    if (!finitePositive(extreme)) return Number.NaN;
    const entry = signal.confirmationBar2.close;
    if (signal.direction === "LONG" ? extreme >= entry - EPSILON : extreme <= entry + EPSILON) return Number.NaN;
    return extreme;
  }
  if (!signal.confirmationBar1) return Number.NaN;
  return structuralStopForAcceptance({
    direction: signal.direction,
    rangeHigh: signal.rangeHigh,
    rangeLow: signal.rangeLow,
    confirmationBar1: signal.confirmationBar1,
    confirmationBar2: signal.confirmationBar2,
  });
}

/** The breakout event side is distinct from the eventual trade side for a fade. */
function breakoutDirectionForSignal(signal: Pick<DailyRangeSignal, "direction" | "entryPolicy" | "breakoutDirection">): DailyRangeBreakoutDirection {
  if (signal.entryPolicy === "FADE" && signal.breakoutDirection) return signal.breakoutDirection;
  return signal.direction === "LONG" ? "UP" : "DOWN";
}

function breakoutBoundaryForSignal(signal: Pick<DailyRangeSignal, "direction" | "entryPolicy" | "breakoutDirection" | "rangeHigh" | "rangeLow">): number {
  return breakoutDirectionForSignal(signal) === "UP" ? signal.rangeHigh : signal.rangeLow;
}

function breakoutExtensionForSignal(
  signal: Pick<DailyRangeSignal, "direction" | "entryPolicy" | "breakoutDirection" | "rangeHigh" | "rangeLow">,
  candle: Pick<DailyRangeCandle, "close">,
): number {
  const boundary = breakoutBoundaryForSignal(signal);
  return breakoutDirectionForSignal(signal) === "UP" ? candle.close - boundary : boundary - candle.close;
}

function asDailyCandle(value: FuturesKline): DailyRangeCandle {
  return {
    openTime: value.openTime,
    closeTime: value.closeTime,
    open: value.open,
    high: value.high,
    low: value.low,
    close: value.close,
    volume: value.volume,
  };
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function medianNumber(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle] ?? null
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return finiteNumber(numerator) && finiteNumber(denominator) && Math.abs(denominator) > EPSILON
    ? numerator / denominator
    : null;
}

function returnOverBars(candles: readonly DailyRangeCandle[], bars: number): number | null {
  const rows = candles.slice(-(bars + 1));
  if (rows.length !== bars + 1 || !contiguousFiveMinuteBars(rows)) return null;
  const last = rows.at(-1);
  const prior = rows[0];
  return last && prior && finitePositive(last.close) && finitePositive(prior.close)
    ? last.close / prior.close - 1
    : null;
}

/** Never bridge a public-data gap when deriving a causal feature. */
function contiguousFiveMinuteBars(rows: readonly DailyRangeCandle[]): boolean {
  return rows.length > 0 && rows.every((row, index) =>
    index === 0 || row.openTime === (rows[index - 1]?.openTime ?? row.openTime) + FIVE_MIN_MS,
  );
}

function atr(candles: readonly DailyRangeCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const rows = candles.slice(-(period + 1));
  if (!contiguousFiveMinuteBars(rows)) return null;
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!;
    const priorClose = rows[index - 1]!.close;
    ranges.push(Math.max(row.high - row.low, Math.abs(row.high - priorClose), Math.abs(row.low - priorClose)));
  }
  return ranges.length === period ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : null;
}

function realizedVolatility(candles: readonly DailyRangeCandle[], period = 24): number | null {
  if (candles.length < period + 1) return null;
  const rows = candles.slice(-(period + 1));
  if (!contiguousFiveMinuteBars(rows)) return null;
  const returns: number[] = [];
  for (let index = 1; index < rows.length; index++) {
    const prior = rows[index - 1]!.close;
    const current = rows[index]!.close;
    if (!finitePositive(prior) || !finitePositive(current)) return null;
    returns.push(Math.log(current / prior));
  }
  if (returns.length !== period) return null;
  return Math.sqrt(returns.reduce((sum, value) => sum + value * value, 0) / returns.length);
}

function relativeVolumeFor(
  candles: readonly DailyRangeCandle[],
  targetOpenTime: number,
  lookback: number,
): number | null {
  const index = candles.findIndex((row) => row.openTime === targetOpenTime);
  if (index < lookback) return null;
  const target = candles[index];
  const rows = candles.slice(index - lookback, index + 1);
  if (!contiguousFiveMinuteBars(rows)) return null;
  const baseline = medianNumber(rows.slice(0, -1).map((row) => row.volume));
  return target ? ratio(target.volume, baseline) : null;
}

function sideAligned(value: number | null, direction: DailyRangeDirection): boolean | null {
  return value === null ? null : direction === "LONG" ? value > 0 : value < 0;
}

function sideAlignedReturn(value: number | null, direction: DailyRangeDirection): number | null {
  return value === null ? null : direction === "LONG" ? value : -value;
}

function spreadBps(book: { bid: number | null; ask: number | null }): number | null {
  if (!finitePositive(book.bid) || !finitePositive(book.ask)) return null;
  const mid = (book.bid + book.ask) / 2;
  return mid > EPSILON ? (book.ask - book.bid) / mid * 10_000 : null;
}

function cPass(audit: DailyRangePoolSymbolAudit | null, prefix: string): boolean | null {
  return audit ? !audit.failures.some((failure) => failure.startsWith(prefix)) : null;
}

function safeCsvCell(value: unknown): string {
  const raw = typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function toMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function orderWasExplicitlyRejected(error: unknown): boolean {
  return error instanceof BinanceFuturesPrivateError && error.failureType === "binance_error";
}

/**
 * A Binance 418/429 circuit is transport state, not evidence that an owned
 * position, its quantity, or its native brackets are wrong. The engine health
 * surface owns that warning; persisting it against every trade made `/live`
 * look like each trade had independently failed reconciliation.
 */
function isRateLimitedTransportFailure(error: unknown): boolean {
  if (error instanceof BinanceFuturesPrivateError) return error.failureType === "429";
  const message = error instanceof Error ? error.message : String(error);
  return isRateLimitTransportMessage(message);
}

function isRateLimitTransportMessage(value: string | null | undefined): boolean {
  return typeof value === "string" && /(?:rate limited|HTTP\s*(?:418|429)|transport cooldown)/i.test(value);
}

function isTransientRateLimitReconciliationDiagnostic(value: string | null | undefined): boolean {
  return typeof value === "string" &&
    /^(?:account reconciliation unavailable|bracket transition recheck unavailable):/i.test(value) &&
    isRateLimitTransportMessage(value);
}

/** Clear only the old transport-shaped UI noise; preserve actual safety diagnostics. */
function clearTransientRateLimitReconciliationDiagnostics(
  state: DailyRangePersistedState,
  trades: readonly DailyRangeTrade[],
): boolean {
  let changed = false;
  if (isRateLimitTransportMessage(state.runtime.reconciliationError)) {
    state.runtime.reconciliationError = null;
    changed = true;
  }
  for (const trade of trades) {
    if (!isTransientRateLimitReconciliationDiagnostic(trade.lastReconcileError)) continue;
    trade.lastReconcileError = null;
    changed = true;
  }
  return changed;
}

function orderStatusFilled(order: FuturesOrder | null): boolean {
  return order !== null && order.status === "FILLED" && order.executedQty > EPSILON && order.avgPrice > 0;
}

function algoLooksTriggered(order: FuturesAlgoOrder | null): boolean {
  if (!order) return false;
  const status = order.algoStatus.toUpperCase();
  return order.actualOrderId !== null || status.includes("TRIGGER") || status.includes("FINISH") || status.includes("EXECUT");
}

function isTerminalTradeStatus(status: DailyRangeTradeStatus): boolean {
  return status === "CLOSED" || status.startsWith("ENTRY_ABORT_");
}

function clampQty(rawQty: number, filter: FuturesSymbolFilters): number | null {
  const qty = roundToStep(rawQty, filter.stepSize, "down");
  if (!(qty >= filter.minQty - EPSILON)) return null;
  return qty;
}

function canaryClientId(kind: "E" | "SL" | "TP" | "X", symbol: string, nowMs: number): string {
  return `DRCANARY-${symbol.slice(0, 7)}-${nowMs.toString(36)}-${kind}`.slice(0, 36);
}

function signalId(strategyVersion: DailyRangeStrategyVersion, dateUtc: string, symbol: string, direction: DailyRangeDirection, closeTime: number): string {
  const prefix = strategyVersion === DAILY_RANGE_AUTO_ROUTE_V3_STRATEGY_VERSION
    ? "drra3"
    : strategyVersion === DAILY_RANGE_AUTO_ROUTE_STRATEGY_VERSION ? "drra2" : "drra1";
  return `${prefix}-${dateUtc.replaceAll("-", "")}-${symbol.toLowerCase().slice(0, 8)}-${direction[0]}-${closeTime.toString(36)}`.slice(0, 60);
}

function tradeIdFromSignal(signal: DailyRangeSignal): string {
  const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
  const prefix = signal.strategyVersion === DAILY_RANGE_AUTO_ROUTE_V3_STRATEGY_VERSION
    ? "drra3"
    : signal.strategyVersion === DAILY_RANGE_AUTO_ROUTE_STRATEGY_VERSION ? "drra2" : "drra1";
  return `${prefix}-${signal.symbol.toLowerCase().slice(0, 8)}-${signal.signalTimestampMs.toString(36)}-${nonce}`.slice(0, 32);
}

function entryClientId(tradeId: string): string {
  return `${tradeId}-e`.slice(0, 36);
}

function algoClientId(tradeId: string, kind: "sl" | "tp"): string {
  return `${tradeId}-${kind}`.slice(0, 36);
}

function exitClientId(tradeId: string): string {
  return `${tradeId}-x`.slice(0, 36);
}

export class DailyRangeAcceptanceLane {
  private readonly client: DailyRangeExecClient;
  private readonly store: DailyRangeLaneStore;
  private readonly getUniverse: () => DailyRangeUniverseSnapshot;
  private readonly getSignalPoolEvidence: (symbols: readonly string[]) => DailyRangePoolEvidence | null;
  private readonly getShortBlocklist: () => ReadonlySet<string>;
  private readonly entryClaims: DailyRangeEntryClaims;
  private readonly foreignOwnershipForSymbol: (symbol: string) => readonly string[];
  private readonly environment: "testnet" | "mainnet";
  private readonly mainnetControls: DailyRangeMainnetControls | null;
  private readonly testnetMaxOpenTrades: number;
  private readonly entryGate: () => DailyRangeEntryGateDecision;
  private readonly symbolEntryGate: (symbol: string) => DailyRangeSymbolEntryGateDecision;
  private readonly onTradeClosed: ((netPnlUsd: number) => void) | null;
  private readonly allocatorMode: DailyRangeAllocatorMode;
  private readonly selectorId: string | null;
  private readonly selectorArtifactStatus: () => DailyRangeSelectorArtifactRegistryStatus;
  private readonly strategyMode: DailyRangeStrategyMode;
  private readonly strategyVersion: DailyRangeStrategyVersion;
  private readonly autoRouteEntryMode: DailyRangeAutoRouteEntryMode;
  private readonly structuralSrPolicyEnabled: boolean;
  private readonly nowMs: () => number;
  private readonly confirmRetryMs: number;
  private ticking = false;
  private startupReconciled = false;
  private closingTradeIds = new Set<string>();
  private mfeExitEvaluations = new Set<string>();
  private pathDirty = false;
  private lastPathPersistAtMs = 0;

  constructor(opts: DailyRangeAcceptanceLaneOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.getUniverse = opts.getUniverse;
    this.getSignalPoolEvidence = opts.getSignalPoolEvidence ?? (() => null);
    this.getShortBlocklist = opts.getShortBlocklist;
    this.entryClaims = opts.entryClaims;
    this.foreignOwnershipForSymbol = opts.foreignOwnershipForSymbol ?? (() => []);
    this.environment = opts.environment;
    this.mainnetControls = opts.mainnetControls ?? null;
    const testnetCap = Math.floor(opts.testnetMaxOpenTrades ?? DAILY_RANGE_TESTNET_MAX_OPEN_TRADES_DEFAULT);
    this.testnetMaxOpenTrades = Number.isFinite(testnetCap) && testnetCap >= 1
      ? testnetCap
      : DAILY_RANGE_TESTNET_MAX_OPEN_TRADES_DEFAULT;
    this.entryGate = opts.entryGate ?? (() => ({ allowed: true, reason: null }));
    this.symbolEntryGate = opts.symbolEntryGate ?? (() => ({ allowed: true, reason: null }));
    this.onTradeClosed = opts.onTradeClosed ?? null;
    this.allocatorMode = opts.allocatorMode
      ?? (opts.environment === "mainnet" ? opts.mainnetControls?.allocatorMode ?? "PAUSED" : "ECONOMIC_QUALITY_BASELINE");
    this.selectorId = opts.selectorId ?? null;
    this.selectorArtifactStatus = opts.selectorArtifactStatus ?? (() => ({
      available: false,
      activeSelectorId: null,
      activeStatus: "MISSING",
      fallback: "ECONOMIC_QUALITY_BASELINE",
      reason: "selector artifact registry is not configured",
      promotionGates: null,
    }));
    this.strategyMode = opts.strategyMode ?? "LEGACY_CONTINUATION";
    if (this.strategyMode === "AUTO_ROUTE_NY_V3" && !opts.autoRouteEntryMode) {
      throw new Error("AUTO_ROUTE_NY_V3 requires an explicit autoRouteEntryMode");
    }
    this.strategyVersion = this.strategyMode === "AUTO_ROUTE_NY_V3"
      ? DAILY_RANGE_AUTO_ROUTE_V3_STRATEGY_VERSION
      : this.strategyMode === "AUTO_ROUTE_NY_V2"
        ? DAILY_RANGE_AUTO_ROUTE_STRATEGY_VERSION
        : DAILY_RANGE_STRATEGY_VERSION;
    this.autoRouteEntryMode = opts.autoRouteEntryMode ?? "FOLLOW_THROUGH_OR_FIRST_REENTRY";
    this.structuralSrPolicyEnabled = opts.structuralSrPolicyEnabled === true;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.confirmRetryMs = opts.confirmRetryMs ?? DEFAULT_CONFIRM_RETRY_MS;
  }

  private isAutoRoute(): boolean {
    return this.strategyMode === "AUTO_ROUTE_NY_V2" || this.strategyMode === "AUTO_ROUTE_NY_V3";
  }

  private isAutoRouteV3(): boolean {
    return this.strategyMode === "AUTO_ROUTE_NY_V3";
  }

  /**
   * Live Continuation remains observable, structured, scored, and labelable,
   * but it is never an executable allocation candidate until the dedicated
   * control is intentionally enabled.  This guard is deliberately independent
   * from the route classifier and from the generic mainnet arm state.
   */
  private isLiveContinuationShadow(signal: Pick<DailyRangeSignal, "entryPolicy">): boolean {
    return this.structuralSrPolicyEnabled
      && this.environment === "mainnet"
      && signal.entryPolicy === "CONTINUATION"
      && this.mainnetControls?.continuationExecutionEnabled !== true;
  }

  /**
   * A daily cohort's initial policy and levels are immutable once it has
   * produced a live trade. An unused MOM36 symbol may be appended later only
   * through the separate, non-replaying borrow admission below.
   */
  private currentDayPolicyMatches(day: DailyRangeDayState | null): boolean {
    return day !== null
      && day.strategyVersion === this.strategyVersion
      && day.strategyMode === this.strategyMode
      && (!this.isAutoRouteV3() || day.autoRouteEntryMode === this.autoRouteEntryMode);
  }

  private currentReferenceWindow(now: number): DailyRangeRuntimeReferenceWindow {
    if (this.isAutoRoute()) {
      const window = newYorkDailyRangeWindow(now);
      return {
        dayKey: `NY:${window.date}`,
        date: window.date,
        referenceTimezone: window.timezone,
        rangeOpenTime: window.rangeOpenTime,
        rangeCloseTime: window.rangeCloseTime,
        entryWindowCloseTime: window.entryWindowCloseTime,
      };
    }
    const start = utcDayStartMs(now);
    return {
      dayKey: utcDate(now),
      date: utcDate(now),
      referenceTimezone: "UTC",
      rangeOpenTime: start,
      rangeCloseTime: start + FOUR_HOURS_MS,
      entryWindowCloseTime: start + DAY_MS,
    };
  }

  private inEntryWindow(ms: number): boolean {
    if (this.isAutoRoute()) return inNewYorkDailyRangeEntryWindow(ms);
    return inDailyRangeEntryWindow(ms);
  }

  isSymbolLeased(symbol: string): { tradeId: string; direction: DailyRangeDirection; status: DailyRangeTradeStatus } | null {
    const trade = this.store.hasActiveSymbolLease(symbol);
    return trade ? { tradeId: trade.tradeId, direction: trade.direction, status: trade.status } : null;
  }

  /**
   * Symbols held by this lane in Binance's one-way/netted account.  This includes unresolved
   * entry/reconciliation states as well as filled positions: a forming cross-sectional basket
   * must skip all of them rather than discovering the conflict only at executor submission.
   */
  getActiveLeaseSymbols(): string[] {
    return [...new Set(
      this.store.getState().trades
        .filter((trade) => !isTerminalTradeStatus(trade.status))
        .map((trade) => trade.symbol),
    )].sort();
  }

  /**
   * Subscribe before an entry can occur: all current Daily pool symbols plus
   * active leases. This is observation-only and has no effect on admission,
   * quantity, native brackets, or exits.
   */
  getPathSubscriptionSymbols(): string[] {
    const universe = this.getUniverse().symbols.map(normalizeSymbol);
    return [...new Set([...universe, ...this.getActiveLeaseSymbols()])].sort();
  }

  /**
   * Contract-price path update from the app-owned aggregate-trade stream.
   * It persists path telemetry and, only after a causal giveback, schedules
   * the canonical asynchronous safe-flatten path. The websocket handler itself
   * never submits, amends, or cancels an order.
   */
  ingestContractPricePath(event: DailyRangeContractPathEvent): void {
    if (!finitePositive(event.price) || !Number.isFinite(event.eventTimeMs) || !Number.isFinite(event.receivedAtMs)) return;
    const symbol = normalizeSymbol(event.symbol);
    let changed = false;
    let mustPersistMfe = false;
    for (const trade of this.store.getState().trades) {
      if (trade.symbol !== symbol || isTerminalTradeStatus(trade.status) || trade.pathFrozenAt != null) continue;
      const entryAt = toMs(trade.entryFilledAt);
      if (entryAt === null || event.eventTimeMs < entryAt) continue;
      if (event.source === "CONTRACT_AGG_TRADE") {
        const streamStartedAtMs = event.streamStartedAtMs;
        if (streamStartedAtMs === null || streamStartedAtMs > entryAt) {
          changed = this.markPathIncomplete(trade, "stream did not continuously cover the entry") || changed;
        } else if (trade.pathQuality === null || trade.pathQuality === undefined) {
          trade.pathQuality = "EXACT_STREAM";
          trade.pathStreamStartedAt = iso(streamStartedAtMs);
          changed = true;
        }
      }
      changed = this.recordPathObservation(trade, event) || changed;
      const mfe = this.advanceFadeMfeFromLiveContractPrice(trade, event);
      changed = mfe.changed || changed;
      mustPersistMfe = mfe.mustPersist || mustPersistMfe;
    }
    if (mustPersistMfe) {
      this.store.save();
      this.pathDirty = false;
      this.lastPathPersistAtMs = this.nowMs();
    } else if (changed) {
      this.persistPathObservationsIfDue();
    }
  }

  /** A disconnect/reconnect means a live open trade has an unobserved interval. */
  markContractPathStreamGap(reason = "contract-price stream interrupted"): void {
    let changed = false;
    for (const trade of this.store.getState().trades) {
      if (isTerminalTradeStatus(trade.status) || trade.pathFrozenAt != null || toMs(trade.entryFilledAt) === null) continue;
      changed = this.markPathIncomplete(trade, reason) || changed;
      if (trade.fadeMfe?.mfePolicyId === DAILY_RANGE_FADE_MFE_POLICY_ID) {
        const next = markDailyRangeFadeMfeDegraded(trade.fadeMfe, `MFE disabled: ${reason}`, this.nowMs());
        if (next.health !== trade.fadeMfe.health || next.degradedReason !== trade.fadeMfe.degradedReason) changed = true;
        trade.fadeMfe = next;
      }
    }
    if (changed) this.persistPathObservationsIfDue(true);
  }

  private advanceFadeMfeFromLiveContractPrice(
    trade: DailyRangeTrade,
    event: DailyRangeContractPathEvent,
  ): { changed: boolean; mustPersist: boolean } {
    const policy = trade.fadeMfe;
    if (trade.entryPolicy !== "FADE" || !policy || policy.mfePolicyId !== DAILY_RANGE_FADE_MFE_POLICY_ID) {
      return { changed: false, mustPersist: false };
    }
    // MFE authority is unavailable before protection is OPEN, from recovered
    // OHLC, or after a path gap. Native structural SL/TP remains unchanged.
    if (trade.status !== "OPEN" || event.source !== "CONTRACT_AGG_TRADE" || trade.pathQuality !== "EXACT_STREAM") {
      const next = markDailyRangeFadeMfeDegraded(
        policy,
        trade.pathQuality === "INCOMPLETE"
          ? "MFE requires a continuous contract-price stream"
          : "MFE awaits an OPEN trade with continuous contract-price data",
        this.nowMs(),
      );
      const changed = next.health !== policy.health || next.degradedReason !== policy.degradedReason;
      trade.fadeMfe = next;
      return { changed, mustPersist: changed };
    }
    const ageMs = this.nowMs() - event.receivedAtMs;
    if (ageMs < 0 || ageMs > MAX_FADE_MFE_EVENT_PROCESSING_DELAY_MS) {
      const next = markDailyRangeFadeMfeDegraded(policy, `MFE event stale (${ageMs}ms)`, this.nowMs());
      const changed = next.health !== policy.health || next.degradedReason !== policy.degradedReason;
      trade.fadeMfe = next;
      return { changed, mustPersist: changed };
    }
    const result = advanceDailyRangeFadeMfe({
      state: policy,
      direction: trade.direction,
      price: event.price,
      eventTimeMs: event.eventTimeMs,
      receivedAtMs: event.receivedAtMs,
    });
    trade.fadeMfe = result.state;
    if (result.shouldExit && result.exitReason) this.scheduleFadeMfeGivebackExit(trade, event, result.exitReason);
    return { changed: result.changed, mustPersist: result.floorChanged || result.shouldExit };
  }

  private scheduleFadeMfeGivebackExit(
    trade: DailyRangeTrade,
    event: DailyRangeContractPathEvent,
    reason: DailyRangeFadeMfeExitReason,
  ): void {
    if (this.mfeExitEvaluations.has(trade.tradeId)) return;
    this.mfeExitEvaluations.add(trade.tradeId);
    void this.flattenOnFadeMfeGiveback(trade, event, reason)
      .catch((error) => {
        trade.lastReconcileError = `${reason}: MFE evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
        this.store.save();
      })
      .finally(() => this.mfeExitEvaluations.delete(trade.tradeId));
  }

  /**
   * Report exact filled, still-open daily-range ownership to the shared account
   * view. Pending submissions deliberately do not appear here: before a fill is
   * proven, presenting requested quantity as an exchange position would invent
   * attribution. The lane's own startup reconciliation remains responsible for
   * those pending states.
  */
  getOpenPositionClaims(): DailyRangeOpenPositionClaim[] {
    return this.store.getState().trades.flatMap((trade) => {
      const status = trade.status;
      if (status !== "PROTECTING" && status !== "OPEN" && status !== "EXIT_RECONCILING") return [];
      if (!finitePositive(trade.entryQty) || !finitePositive(trade.entryFillPrice)) return [];
      return [{
        laneId: DAILY_RANGE_LANE_ID,
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        direction: trade.direction,
        qty: trade.entryQty,
        entryPrice: trade.entryFillPrice,
        openedAt: trade.entryFilledAt ?? trade.entrySubmittedAt,
        status,
        stopPrice: trade.stopPrice,
        takeProfitPrice: trade.takeProfitPrice,
        entryPolicy: trade.entryPolicy ?? "LEGACY_CONTINUATION",
        exitPolicyId: trade.routeExitPolicy?.exitPolicyId ?? null,
        tpMultipleR: trade.routeExitPolicy?.tpMultipleR ?? trade.rrTarget,
        thesisInvalidationType: trade.routeExitPolicy?.thesisInvalidationType ?? null,
        lastReconcileError: trade.lastReconcileError,
      }];
    });
  }

  /**
   * Signed quantities with a confirmed Daily Range ownership record. app.ts
   * supplies them to the account engine's reconciliation in both runtimes, so
   * a protected Daily Range position is not mistaken for an orphan or netted
   * away by a different executor.
   */
  managedNetQty(): Map<string, number> {
    const net = new Map<string, number>();
    for (const trade of this.store.getState().trades) {
      if (isTerminalTradeStatus(trade.status)) continue;
      // Before a market order is fully adopted, only a bounded pending claim is
      // safe: a terminal partial fill may be anywhere between zero and the
      // requested quantity. See pendingEntryNetQty() below.
      if (trade.status === "ENTRY_SUBMITTING" || trade.status === "ENTRY_RECONCILING") continue;
      const qty = trade.entryQty;
      if (!finitePositive(qty)) continue;
      net.set(trade.symbol, (net.get(trade.symbol) ?? 0) + directionSign(trade.direction) * qty);
    }
    return net;
  }

  /**
   * Bounded, not-yet-adopted Daily Range entry quantities.  The account engine
   * uses this only as a reconciliation tolerance band: it can explain a
   * partial/full fill up to the exact requested amount, never a larger or
   * opposite-side position.  This covers both a normal durable entry and the
   * deliberately separate DRCANARY lifecycle.
   */
  pendingEntryNetQty(): Map<string, number> {
    const pending = new Map<string, number>();
    const add = (symbol: string, qty: number, sign: number): void => {
      if (!finitePositive(qty)) return;
      pending.set(symbol, (pending.get(symbol) ?? 0) + sign * qty);
    };
    for (const trade of this.store.getState().trades) {
      if (trade.status !== "ENTRY_SUBMITTING" && trade.status !== "ENTRY_RECONCILING") continue;
      add(trade.symbol, trade.requestedQty ?? 0, directionSign(trade.direction));
    }
    for (const canary of this.store.getState().canaries) {
      if (canary.status !== "RUNNING" || !canary.symbol) continue;
      // The controlled canary is deliberately long-only. Keeping this explicit
      // makes a future canary-side expansion require an intentional review.
      add(canary.symbol, canary.requestedQty ?? 0, canary.side === "BUY" ? 1 : -1);
    }
    return pending;
  }

  /**
   * Realized Daily Range P&L for account-level safety aggregation.  It uses the
   * actual exit timestamp (UTC), not the date of the 00:00–04:00 range, so a
   * trade that closes after midnight cannot be counted in the wrong loss day.
   */
  realizedPnlSummary(dayUtc = utcDate(this.nowMs())): { today: number; allTime: number } {
    const settled = this.store.getState().trades.filter((trade) =>
      isTerminalTradeStatus(trade.status) && Number.isFinite(trade.netPnlUsd),
    );
    return {
      today: settled
        .filter((trade) => trade.exitTimestamp?.startsWith(dayUtc))
        .reduce((sum, trade) => sum + (trade.netPnlUsd ?? 0), 0),
      allTime: settled.reduce((sum, trade) => sum + (trade.netPnlUsd ?? 0), 0),
    };
  }

  private mainnetControlBlockReason(action: "canary" | "arm" | "entry"): string | null {
    if (this.environment !== "mainnet") return null;
    const controls = this.mainnetControls;
    if (!controls?.executionEnabled) return "Daily Range mainnet execution is disabled";
    if (!controls.confirmed) return "Daily Range mainnet confirmation is missing";
    if (controls.maxOpenTrades < 1) return "Daily Range mainnet max-open-trades cap is not positive";
    if (controls.maxGrossNotionalUsd + EPSILON < DAILY_RANGE_TRADE_NOTIONAL_USD) {
      return `Daily Range mainnet gross-notional cap is below ${DAILY_RANGE_TRADE_NOTIONAL_USD} USDT`;
    }
    if (action === "canary" && !controls.canaryEnabled) return "Daily Range mainnet canary is disabled";
    if ((action === "arm" || action === "entry") && !controls.armEnabled) return "Daily Range mainnet arm is disabled";
    if (action === "entry" && controls.newEntryMode === "PAUSED_SELECTION_FIX") {
      return "Daily Range new entries are paused for selection-fix validation";
    }
    return null;
  }

  private selectorStatus(): "SHADOW" | "VALIDATED" | "NOT_READY" {
    // No artifact has passed the historical + forward promotion contract in
    // this release. A configured VALIDATED mode therefore falls back to the
    // economic allocator rather than falsely advertising alpha authority.
    if (this.allocatorMode === "SHADOW_ALPHA_SELECTOR" || this.allocatorMode === "SHADOW_SELECTOR") return "SHADOW";
    if (this.allocatorMode === "ECONOMIC_QUALITY_BASELINE" || this.allocatorMode === "SEEDED_RANDOM_BASELINE") return "SHADOW";
    return "NOT_READY";
  }

  private effectiveAllocatorMode(): DailyRangeAllocatorMode {
    if (this.environment === "mainnet" && this.allocatorMode === "SEEDED_RANDOM_BASELINE") {
      return "ECONOMIC_QUALITY_BASELINE";
    }
    if (this.allocatorMode === "SHADOW_ALPHA_SELECTOR" || this.allocatorMode === "SHADOW_SELECTOR") {
      return "ECONOMIC_QUALITY_BASELINE";
    }
    // The V3 runtime does not ship a promoted alpha artifact. Keep the selected
    // candidates attributable to the economic comparator until one exists.
    if (this.allocatorMode === "VALIDATED_ALPHA_SELECTOR" || this.allocatorMode === "VALIDATED_SELECTOR") {
      return "ECONOMIC_QUALITY_BASELINE";
    }
    return this.allocatorMode;
  }

  /** A manually enabled Live baseline must never look like an alpha promotion. */
  private operatorSelectorStatus(): "SHADOW" | "VALIDATED" | "NOT_READY" | "NO_VALIDATED_ALPHA_SELECTOR" {
    if (this.environment === "mainnet" && (this.allocatorMode === "SEEDED_RANDOM_BASELINE" || this.allocatorMode === "VALIDATED_ALPHA_SELECTOR" || this.allocatorMode === "VALIDATED_SELECTOR")) {
      return "NO_VALIDATED_ALPHA_SELECTOR";
    }
    return this.selectorStatus();
  }

  private frictionSampleForTrade(trade: DailyRangeTrade): DailyRangeFrictionSample | null {
    if (trade.status !== "CLOSED" || !trade.exitTimestamp || !finitePositive(trade.entryFillPrice) || !finitePositive(trade.entryQty) || !finitePositive(trade.exitPrice)) return null;
    const entryNotional = trade.entryFillPrice * trade.entryQty;
    const exitNotional = trade.exitPrice * trade.entryQty;
    if (!(entryNotional > 0) || !(exitNotional > 0)) return null;
    // A zero commission is still a real, exact exchange fact (for example a
    // temporary rebate).  Do not silently relabel it as a legacy estimated
    // split merely because it is not positive.
    const exact = trade.feeEvidence === "EXACT_FILL_COMMISSION"
      || (
        typeof trade.entryFeesUsd === "number" && Number.isFinite(trade.entryFeesUsd)
        && typeof trade.exitFeesUsd === "number" && Number.isFinite(trade.exitFeesUsd)
      );
    const totalFees = Math.max(0, trade.feesUsd ?? 0);
    const combinedNotional = entryNotional + exitNotional;
    const entryFees = exact ? Math.max(0, trade.entryFeesUsd ?? 0) : totalFees * entryNotional / combinedNotional;
    const exitFees = exact ? Math.max(0, trade.exitFeesUsd ?? 0) : totalFees * exitNotional / combinedNotional;
    const entryFeeBps = entryFees / entryNotional * 10_000;
    const exitFeeBps = exitFees / exitNotional * 10_000;
    const entryAdverseBps = Math.max(0, trade.entrySlippageBps ?? 0);
    const exitAdverseBps = Math.max(0, trade.exitSlippageBps ?? 0);
    const stopGapBps = trade.exitReason === "STOP_LOSS" && finitePositive(trade.stopPrice)
      ? Math.max(0, 10_000 * (trade.direction === "LONG"
        ? (trade.stopPrice - trade.exitPrice) / trade.stopPrice
        : (trade.exitPrice - trade.stopPrice) / trade.stopPrice))
      : null;
    const tpExitAdverseBps = trade.exitReason === "TAKE_PROFIT" && finitePositive(trade.takeProfitPrice)
      ? Math.max(0, 10_000 * (trade.direction === "LONG"
        ? (trade.takeProfitPrice - trade.exitPrice) / trade.takeProfitPrice
        : (trade.exitPrice - trade.takeProfitPrice) / trade.takeProfitPrice)) + exitAdverseBps
      : null;
    const stopExitAdverseBps = trade.exitReason === "STOP_LOSS" ? exitAdverseBps : null;
    return {
      tradeId: trade.tradeId,
      closedAt: trade.exitTimestamp,
      entryFeeBps,
      exitFeeBps,
      entryAdverseBps,
      takeProfitExitAdverseBps: tpExitAdverseBps,
      stopExitAdverseBps,
      stopGapBps,
      exitReason: trade.exitReason === "TAKE_PROFIT" ? "TAKE_PROFIT" : trade.exitReason === "STOP_LOSS" ? "STOP_LOSS" : "OTHER",
      feeEvidence: exact ? "EXACT_FILL_COMMISSION" : "LEGACY_COMBINED_FEE_ALLOCATION",
      sourceFillCount: exact
        && Number.isFinite(trade.entryFillCount) && Number.isFinite(trade.exitFillCount)
        ? Math.max(0, trade.entryFillCount ?? 0) + Math.max(0, trade.exitFillCount ?? 0)
        : null,
    };
  }

  /**
   * Freeze no more than one friction model per UTC decision date. Existing
   * trade records remain immutable; only the model registry grows. Mainnet
   * fails closed if its own ledger cannot produce a usable model.
   */
  private ensureFrictionModel(now = this.nowMs()): DailyRangeFrictionModel | null {
    const state = this.store.getState();
    const date = utcDate(now);
    const models = state.frictionModels ?? (state.frictionModels = []);
    const byDate = state.frictionModelByUtcDate ?? (state.frictionModelByUtcDate = {});
    const existingId = byDate[date];
    const existing = existingId ? models.find((model) => model.id === existingId) ?? null : null;
    if (existing
      && existing.environment === this.environment
      && existing.definitionVersion === DAILY_RANGE_FRICTION_DEFINITION_VERSION) {
      return existing;
    }
    const cutoffAt = iso(now);
    const samples = state.trades
      .map((trade) => this.frictionSampleForTrade(trade))
      .filter((sample): sample is DailyRangeFrictionSample => sample !== null);
    const empirical = buildEmpiricalFrictionModel({ samples, createdAt: cutoffAt, cutoffAt, environment: this.environment });
    const model = empirical ?? (this.environment === "testnet" ? conservativeFallbackFrictionModel(cutoffAt, cutoffAt, this.environment) : null);
    if (!model) return null;
    models.push(model);
    byDate[date] = model.id;
    this.store.save();
    console.log(`[daily-range-lane] FRICTION_MODEL_FROZEN id=${model.id} source=${model.source} samples=${model.sampleCount} cutoff=${model.cutoffAt}`);
    return model;
  }

  private frozenFrictionModelForSignalTimestamp(signalTimestampMs: number): DailyRangeFrictionModel | null {
    const state = this.store.getState();
    const date = utcDate(signalTimestampMs);
    const id = state.frictionModelByUtcDate?.[date] ?? null;
    const model = id ? state.frictionModels?.find((candidate) => candidate.id === id) ?? null : null;
    return model
      && model.environment === this.environment
      && model.definitionVersion === DAILY_RANGE_FRICTION_DEFINITION_VERSION
      ? model
      : null;
  }

  private entryLimitReason(): Extract<DailyRangeSignalReason, "MAX_OPEN_TRADES_REACHED" | "MAX_GROSS_NOTIONAL_REACHED"> | null {
    const activeTrades = this.store.getState().trades.filter((trade) => !isTerminalTradeStatus(trade.status));
    const maxOpenTrades = this.environment === "mainnet"
      ? this.mainnetControls?.maxOpenTrades ?? 0
      : this.testnetMaxOpenTrades;
    if (activeTrades.length >= maxOpenTrades) return "MAX_OPEN_TRADES_REACHED";
    if (this.environment !== "mainnet") return null;
    const controls = this.mainnetControls;
    if (!controls) return "MAX_OPEN_TRADES_REACHED";
    // Every pending/filled trade reserves the full intended 25 USDT before its
    // market POST.  That makes the gross cap atomic even when several C2 signals
    // arrive in the same scheduler tick; actual fill drift can only be observed,
    // never used to squeeze in an extra order.
    const reservedGrossUsd = (activeTrades.length + 1) * DAILY_RANGE_TRADE_NOTIONAL_USD;
    if (reservedGrossUsd > controls.maxGrossNotionalUsd + EPSILON) return "MAX_GROSS_NOTIONAL_REACHED";
    return null;
  }

  getStatus(): Record<string, unknown> {
    const now = this.nowMs();
    const state = this.store.getState();
    const window = this.currentReferenceWindow(now);
    const date = window.date;
    const day = state.days[window.dayKey] ?? null;
    const performance = this.performanceSummary();
    const signalsToday = state.signals.filter((signal) => signal.strategyVersion === this.strategyVersion && signal.dateUtc === date);
    const tradesToday = state.trades.filter((trade) => trade.strategyVersion === this.strategyVersion && trade.dateUtc === date);
    const openTrades = state.trades.filter((trade) => !isTerminalTradeStatus(trade.status));
    const capacity = this.allocationCapacity();
    const batches = state.signalCohorts.filter((batch) => batch.strategyVersion === this.strategyVersion && batch.allocation);
    const lastBatch = [...batches]
      .sort((a, b) => b.signalTimestampMs - a.signalTimestampMs || b.cohortId.localeCompare(a.cohortId))[0] ?? null;
    const lastBatchEconomicRejects = lastBatch?.candidates.filter((candidate) => [
      "STOP_ECONOMICS_FAIL", "RISK_BUDGET_UNEXECUTABLE", "BBO_STALE", "FRICTION_MODEL_UNAVAILABLE", "NET_REWARD_NON_POSITIVE", "NEGATIVE_EXPECTED_VALUE",
    ].includes(candidate.skipReason ?? "")).length ?? 0;
    const openPathQuality = openTrades.reduce<Record<string, number>>((counts, trade) => {
      const key = trade.pathQuality ?? "UNOBSERVED_LEGACY";
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const fadeMfeTrades = state.trades.filter((trade) => trade.fadeMfe?.mfePolicyId === DAILY_RANGE_FADE_MFE_POLICY_ID);
    const openFadeMfeTrades = openTrades.filter((trade) => trade.fadeMfe?.mfePolicyId === DAILY_RANGE_FADE_MFE_POLICY_ID);
    const fadeMfeCounterfactuals = fadeMfeTrades
      .map((trade) => trade.fadeMfeCounterfactual)
      .filter((outcome): outcome is DailyRangeFadeMfeCounterfactual => outcome !== null && outcome !== undefined);
    const researchSignals = state.signals.filter((signal) => signal.research?.counterfactual !== null && signal.research?.counterfactual !== undefined);
    const counterfactuals = researchSignals.map((signal) => signal.research?.counterfactual!).filter(Boolean);
    const fullPitMature = (signal: DailyRangeSignal | undefined): boolean => (
      signal?.research?.marketQuality?.pitQuality === "FULL_PIT"
      && signal.research.features?.pitQuality === "FULL_PIT"
      && (signal.research.counterfactual?.status === "MATURE_TP" || signal.research.counterfactual?.status === "MATURE_SL")
    );
    const signalById = new Map(state.signals.map((signal) => [signal.signalId, signal]));
    const matureFullPITSignals = state.signals.filter(fullPitMature);
    /**
     * A forward selector comparison is valid only when the complete scarce
     * slot cohort is both causally complete and labelled. Counting a batch
     * with one mature row and several pending/partial peers would overstate
     * progress toward the >=20 forward FULL_PIT gate.
     */
    const matureFullPITOversubscribedBatches = batches.filter((batch) => {
      const slots = batch.allocation?.availableSlots;
      return slots !== null
        && slots !== undefined
        && batch.candidates.length > slots
        && batch.candidates.length > 0
        && batch.candidates.every((candidate) => fullPitMature(signalById.get(candidate.signalId)));
    }).length;
    const mainnetPausedForSelection = this.environment === "mainnet" && (
      this.mainnetControls?.newEntryMode === "PAUSED_SELECTION_FIX"
      || state.control.disarmReason?.startsWith("SELECTION_FIX_PENDING_VALIDATION") === true
    );
    const entryControlReason = this.mainnetControlBlockReason("entry");
    const effectiveAllocatorMode = this.effectiveAllocatorMode();
    const selectorArtifact = this.selectorArtifactStatus();
    const frictionModelId = state.frictionModelByUtcDate?.[utcDate(now)] ?? null;
    const frictionModel = frictionModelId ? state.frictionModels?.find((model) => model.id === frictionModelId) ?? null : null;
    const frictionUnavailable = !frictionModel;
    const economicsSignals = state.signals.filter((signal) => signal.economics !== null && signal.economics !== undefined);
    const economicRejectReasons = new Set<DailyRangeSignalReason>([
      "STOP_ECONOMICS_FAIL",
      "RISK_BUDGET_UNEXECUTABLE",
      "BBO_STALE",
      "FRICTION_MODEL_UNAVAILABLE",
      "NET_REWARD_NON_POSITIVE",
      "NEGATIVE_EXPECTED_VALUE",
    ]);
    const legacyGeometryDiagnosticReasons: DailyRangeGeometryRejectReason[] = [
      "STRUCTURAL_STOP_TOO_WIDE",
      "TARGET_DISTANCE_TOO_WIDE",
      "TARGET_REACHABILITY_FAIL",
      "TARGET_REACHABILITY_DATA_UNAVAILABLE",
    ];
    const geometryDiagnosticCounts = Object.fromEntries(legacyGeometryDiagnosticReasons.map((reason) => [
      reason,
      state.signals.filter((signal) => signal.geometry?.legacyDiagnosticReason === reason).length,
    ]));
    const economicRejectCount = state.signals.filter((signal) => signal.reason !== null && economicRejectReasons.has(signal.reason)).length;
    const geometrySignals = state.signals.filter((signal) => signal.geometry !== null && signal.geometry !== undefined);
    const mean = (values: number[]): number | null => values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    const plannedRisks = economicsSignals.map((signal) => signal.economics!.plannedRiskUsd).filter(finiteNumber);
    // V3 metrics must never borrow legacy position risk: an old fixed-notional
    // trade can legitimately exceed the new 0.25-USDT planned-risk cap.
    const actualRisks = state.trades
      .filter((trade) => trade.economics !== null && trade.economics !== undefined)
      .map((trade) => trade.actualInitialRiskUsd ?? trade.initialRiskDollar)
      .filter(finiteNumber);
    const policyCutoverPending = day !== null
      && !this.currentDayPolicyMatches(day)
      && state.trades.some((trade) => trade.dateUtc === date && !isTerminalTradeStatus(trade.status));
    const newEntriesEnabled = state.control.mode === "ARMED"
      && effectiveAllocatorMode !== "PAUSED"
      && entryControlReason === null
      && !frictionUnavailable
      && !policyCutoverPending;
    const newEntryReason = !newEntriesEnabled
      ? policyCutoverPending ? "POLICY_CUTOVER_PENDING_ACTIVE_TRADE"
        : mainnetPausedForSelection ? "SELECTION_FIX_PENDING_VALIDATION"
        : effectiveAllocatorMode === "PAUSED" ? "ALLOCATOR_PAUSED"
          : state.control.mode !== "ARMED" ? state.control.disarmReason ?? "LANE_DISARMED"
            : entryControlReason ?? (frictionUnavailable ? "FRICTION_MODEL_UNAVAILABLE" : null)
      : null;
    return {
      ok: true,
      environment: this.environment,
      laneId: DAILY_RANGE_LANE_ID,
      strategyVersion: this.strategyVersion,
      strategyMode: this.strategyMode,
      routeExitPolicy: {
        policyId: this.structuralSrPolicyEnabled
          ? "daily-route-exit-structural-sr-v1"
          : DAILY_RANGE_FADE_BRACKET_ONLY_EXIT_POLICY_ID,
        structurePolicyId: this.structuralSrPolicyEnabled ? DAILY_RANGE_STRUCTURAL_SR_POLICY_ID : null,
        targetPolicyId: this.structuralSrPolicyEnabled ? DAILY_RANGE_NEXT_SR_TARGET_POLICY_ID : null,
        appliesTo: "NEW_AUTO_ROUTE_ENTRIES_ONLY",
        completedCandleInterval: "5m",
        entryMode: this.autoRouteEntryMode,
        continuation: {
          enabled: this.autoRouteEntryMode !== "FADE_FIRST_REENTRY_ONLY",
          executionAuthority: this.environment === "mainnet" && this.mainnetControls?.continuationExecutionEnabled !== true
            ? "SHADOW_ONLY"
            : "EXECUTION",
          entryTiming: this.autoRouteEntryMode === "CONTINUATION_FIRST_OUTSIDE_CLOSE"
            ? "FIRST_OUTSIDE_CLOSE"
            : "FOLLOW_THROUGH_CLOSE",
          target: this.structuralSrPolicyEnabled ? "NEXT_PIT_SAFE_RESISTANCE_OR_SUPPORT" : `${dailyRangeTpMultipleForRoute("CONTINUATION")}R`,
          hardStop: "FROZEN_STRUCTURAL_STOP",
          thesisInvalidationType: "RANGE_REENTRY",
        },
        fade: {
          policyId: this.structuralSrPolicyEnabled ? "daily-route-exit-structural-sr-v1" : DAILY_RANGE_FADE_BRACKET_ONLY_EXIT_POLICY_ID,
          enabled: this.autoRouteEntryMode !== "CONTINUATION_FIRST_OUTSIDE_CLOSE",
          executionAuthority: "EXECUTION",
          entryTiming: "FIRST_REENTRY_CLOSE",
          target: this.structuralSrPolicyEnabled ? "NEXT_PIT_SAFE_RESISTANCE_OR_SUPPORT" : `${dailyRangeTpMultipleForRoute("FADE")}R`,
          hardStop: "FROZEN_STRUCTURAL_STOP",
          thesisInvalidationType: this.structuralSrPolicyEnabled ? "ORIGINAL_BREAKOUT_REACCEPTANCE" : "NONE",
        },
      },
      utcNow: iso(now),
      control: state.control,
      reconciled: this.startupReconciled,
      runtime: state.runtime,
      today: {
        dateUtc: date,
        rangeInitialized: day !== null,
        rangeReady: now >= window.rangeCloseTime,
        entryWindowOpen: this.inEntryWindow(now),
        referenceTimezone: window.referenceTimezone,
        referenceRangeOpenTime: window.rangeOpenTime,
        referenceRangeCloseTime: window.rangeCloseTime,
        entryWindowCloseTime: window.entryWindowCloseTime,
        dailyUniverseCount: day?.universeSymbols.length ?? 0,
        /** Immutable source captured for this reference session; lets operators verify pool isolation. */
        dailyUniverseSource: day?.universeSource ?? null,
        dailyUniverseSymbols: day?.universeSymbols ?? [],
        /** Later additive admissions are shown separately from the frozen base cohort. */
        borrowedMOM36Symbols: Object.keys(day?.borrowedUniverseAdmissions ?? {}).sort(),
        poolEvidence: day?.poolEvidence ? {
          schemaVersion: day.poolEvidence.schemaVersion,
          poolVersion: day.poolEvidence.poolVersion,
          state: day.poolEvidence.state,
          capturedAt: day.poolEvidence.capturedAt,
          auditedSymbols: Object.keys(day.poolEvidence.auditBySymbol).length,
          missingAuditSymbols: day.poolEvidence.missingAuditSymbols,
        } : null,
        monitoringSymbols: Object.keys(day?.levels ?? {}).length,
        invalidReferenceSymbols: day?.invalidReferenceSymbols ?? [],
        signals: signalsToday.length,
        signalCohorts: state.signalCohorts.filter((cohort) => cohort.strategyVersion === this.strategyVersion && cohort.dateUtc === date).length,
        executedTrades: tradesToday.filter((trade) => trade.entryOrderId !== null).length,
        closedTrades: tradesToday.filter((trade) => trade.status === "CLOSED").length,
      },
      nextReferenceReset: iso(this.currentReferenceWindow(window.entryWindowCloseTime + 1).rangeCloseTime),
      openTrades,
      totalHistoricalTrades: state.trades.filter((trade) => trade.entryOrderId !== null).length,
      performance,
      mainnetControls: this.environment === "mainnet" ? {
        executionEnabled: this.mainnetControls?.executionEnabled ?? false,
        continuationExecutionEnabled: this.mainnetControls?.continuationExecutionEnabled ?? false,
        confirmed: this.mainnetControls?.confirmed ?? false,
        canaryEnabled: this.mainnetControls?.canaryEnabled ?? false,
        armEnabled: this.mainnetControls?.armEnabled ?? false,
        maxOpenTrades: this.mainnetControls?.maxOpenTrades ?? 0,
        maxGrossNotionalUsd: this.mainnetControls?.maxGrossNotionalUsd ?? 0,
        newEntryMode: this.mainnetControls?.newEntryMode ?? "PAUSED_SELECTION_FIX",
        allocatorMode: this.mainnetControls?.allocatorMode ?? "PAUSED",
        entryBlockReason: this.mainnetControlBlockReason("entry"),
      } : null,
      allocatorMode: this.allocatorMode,
      effectiveAllocatorMode,
      newEntriesEnabled,
      newEntryReason,
      selectorStatus: this.operatorSelectorStatus(),
      selectorId: this.selectorId,
      selectorArtifact,
      alphaSelector: {
        policyId: DAILY_RANGE_ALPHA_SELECTOR_POLICY_ID,
        executionAuthority: false,
        status: this.selectorStatus() === "SHADOW" ? "SHADOW_ONLY" : "UNAVAILABLE",
        promotion: "requires historical gates plus 20 mature FULL_PIT oversubscribed forward batches and explicit mainnet approval",
        artifactStatus: selectorArtifact.activeStatus,
        artifactFallback: selectorArtifact.fallback,
        forwardGate: {
          matureFullPITOversubscribedBatches,
          requiredMatureFullPITOversubscribedBatches: 20,
          status: matureFullPITOversubscribedBatches >= 20 ? "COUNT_REACHED_NOT_APPROVED" : "COLLECTING",
        },
      },
      economics: {
        policyId: DAILY_RANGE_EXECUTION_ECONOMICS_POLICY_ID,
        allocatorPolicyId: DAILY_RANGE_ECONOMIC_ALLOCATOR_POLICY_ID,
        riskPolicyId: DAILY_RANGE_FRICTION_INCLUSIVE_RISK_POLICY_ID,
        maxNotionalUsd: DAILY_RANGE_TRADE_NOTIONAL_USD,
        maxPlannedRiskUsd: DAILY_RANGE_MAX_PLANNED_RISK_USD,
        costRatioAuthority: "DIAGNOSTIC_ONLY",
        legacyMaxCostRatioDiagnostic: DAILY_RANGE_MAX_COST_RATIO,
        bboMaxAgeMs: MAX_DECISION_BBO_AGE_MS,
        /** The immutable model is safe to expose: it contains execution-cost
         * percentiles and provenance only, never credentials or order state. */
        frictionModel: frictionModel ? { ...frictionModel } : null,
        candidateSummary: {
          evaluated: economicsSignals.length,
          economicsRejected: economicRejectCount,
          averageStopRiskBps: mean(economicsSignals.map((signal) => signal.economics!.stopRiskBps).filter(finiteNumber)),
          averageCostRatio: mean(economicsSignals.map((signal) => signal.economics!.costRatio).filter(finiteNumber)),
          plannedRiskUsd: {
            count: plannedRisks.length,
            minimum: plannedRisks.length ? Math.min(...plannedRisks) : null,
            average: mean(plannedRisks),
            maximum: plannedRisks.length ? Math.max(...plannedRisks) : null,
          },
          actualInitialRiskUsd: {
            count: actualRisks.length,
            average: mean(actualRisks),
            maximum: actualRisks.length ? Math.max(...actualRisks) : null,
          },
        },
      },
      geometry: {
        policyId: DAILY_RANGE_TRADE_GEOMETRY_POLICY_ID,
        admissionAuthority: "DIAGNOSTIC_ONLY",
        legacyDiagnostics: {
          maxStructuralStopPct: DAILY_RANGE_MAX_STRUCTURAL_STOP_PCT,
          maxTargetDistancePct: DAILY_RANGE_MAX_TARGET_DISTANCE_PCT,
          maxTargetAtr4hMultiple: DAILY_RANGE_MAX_TARGET_ATR4H_MULTIPLE,
        },
        atrDefinition: "WILDER_ATR14_COMPLETED_4H_CAUSAL",
        candidateSummary: {
          evaluated: geometrySignals.length,
          passed: geometrySignals.filter((signal) => signal.geometry!.geometryPass).length,
          rejected: geometrySignals.filter((signal) => !signal.geometry!.geometryPass).length,
          legacyDiagnosticCounts: geometryDiagnosticCounts,
        },
        legacyDiagnosticCounts: geometryDiagnosticCounts,
      },
      availableSlots: capacity.displaySlots,
      maxDailyPositions: capacity.maxOpenTrades,
      openDailyPositions: openTrades.filter((trade) => ["PROTECTING", "OPEN", "EXIT_RECONCILING"].includes(trade.status)).length,
      pendingReservations: capacity.pendingReservations,
      lastCompletedBatch: lastBatch ? {
        cohortId: lastBatch.cohortId,
        timestamp: lastBatch.signalTimestamp,
        finalizedAt: lastBatch.allocation?.finalizedAt ?? null,
        complete: lastBatch.allocation?.batchComplete ?? false,
        candidateCount: lastBatch.allocation?.candidateCount ?? lastBatch.candidates.length,
        selectedCount: lastBatch.allocation?.selectedSignalIds.length ?? 0,
        economicRejects: lastBatchEconomicRejects,
        minFeatureAgeMs: lastBatch.allocation?.minFeatureAgeMs ?? null,
        maxFeatureAgeMs: lastBatch.allocation?.maxFeatureAgeMs ?? null,
        featureAgeSpreadMs: lastBatch.allocation?.featureAgeSpreadMs ?? null,
        candidates: lastBatch.candidates.map((candidate) => ({
          symbol: candidate.symbol,
          alphaScore: candidate.alphaSelector?.pTp ?? null,
          alphaStatus: candidate.alphaSelector?.status ?? null,
          economicRank: candidate.selectorRank ?? null,
          selected: candidate.actuallySelected ?? false,
          routeExecutionEnabled: candidate.routeExecutionEnabled ?? true,
          executionEligible: candidate.executionEligible ?? true,
          skipReason: candidate.skipReason ?? null,
          geometry: candidate.geometry ?? candidate.economics?.geometry ?? null,
          economics: candidate.economics ?? null,
          routeExitPolicy: candidate.routeExitPolicy ?? null,
        })),
      } : null,
      lastBatchCandidateCount: lastBatch?.allocation?.candidateCount ?? 0,
      lastBatchSelectedCount: lastBatch?.allocation?.selectedSignalIds.length ?? 0,
      dataHealth: {
        candidateSignalsCollected: state.signals.filter((signal) => signal.signalBatchTimestamp !== undefined).length,
        maturedSignals: counterfactuals.filter((outcome) => outcome.status === "MATURE_TP" || outcome.status === "MATURE_SL").length,
        pendingSignals: counterfactuals.filter((outcome) => outcome.status === "PENDING").length,
        ambiguousSignals: counterfactuals.filter((outcome) => outcome.status === "OUTCOME_AMBIGUOUS").length,
        oversubscribedBatches: batches.filter((batch) => {
          const slots = batch.allocation?.availableSlots;
          return slots !== null && slots !== undefined && batch.candidates.length > slots;
        }).length,
        fullPITSignals: state.signals.filter((signal) => signal.research?.marketQuality?.pitQuality === "FULL_PIT" && signal.research.features?.pitQuality === "FULL_PIT").length,
        matureFullPITSignals: matureFullPITSignals.length,
        matureFullPITOversubscribedBatches,
        partialReconstructedSignals: state.signals.filter((signal) => signal.research?.marketQuality?.pitQuality === "PARTIAL_RECONSTRUCTION" || signal.research?.features?.pitQuality === "PARTIAL_RECONSTRUCTION").length,
        lastSignalTimestamp: state.signals.at(-1)?.signalTimestamp ?? null,
      },
      mfeMae: {
        triggerWorkingType: "CONTRACT_PRICE",
        collection: "BINANCE_USDM_AGG_TRADE_STREAM",
        fallback: "COMPLETE_1M_OHLC_ONLY",
        openPathQuality,
        frozenClosedTrades: state.trades.filter((trade) => isTerminalTradeStatus(trade.status) && trade.pathFrozenAt != null).length,
        incompleteClosedTrades: state.trades.filter((trade) => isTerminalTradeStatus(trade.status) && trade.pathQuality === "INCOMPLETE").length,
      },
      fadeMfe: {
        policyId: DAILY_RANGE_FADE_MFE_POLICY_ID,
        appliesTo: "NEW_BREAKOUT_FADE_ONLY",
        priceSource: "CONTRACT_AGG_TRADE",
        stage1: { armProgress: 0.5, staticFloor: 0.25, peakRetention: 0.5 },
        stage2: { armProgress: 0.75, staticFloor: 0.5, peakRetention: 2 / 3 },
        ratchet: "MAX(previousFloor, stageDerivedFloor); never lowers",
        activeOpenTrades: openFadeMfeTrades.length,
        stage1ArmedCount: openFadeMfeTrades.filter((trade) => trade.fadeMfe?.stage1Armed).length,
        stage2ArmedCount: openFadeMfeTrades.filter((trade) => trade.fadeMfe?.stage2Armed).length,
        degradedOpenTrades: openFadeMfeTrades.filter((trade) => trade.fadeMfe?.health === "DEGRADED").length,
        stage1ExitCount: fadeMfeTrades.filter((trade) => trade.exitReason === "FADE_MFE_STAGE1_GIVEBACK_EXIT").length,
        stage2ExitCount: fadeMfeTrades.filter((trade) => trade.exitReason === "FADE_MFE_STAGE2_GIVEBACK_EXIT").length,
        counterfactual: {
          pending: fadeMfeCounterfactuals.filter((outcome) => outcome.status === "PENDING").length,
          maturedTp: fadeMfeCounterfactuals.filter((outcome) => outcome.status === "MATURE_TP").length,
          maturedSl: fadeMfeCounterfactuals.filter((outcome) => outcome.status === "MATURE_SL").length,
          ambiguous: fadeMfeCounterfactuals.filter((outcome) => outcome.status === "OUTCOME_AMBIGUOUS").length,
          unavailable: fadeMfeCounterfactuals.filter((outcome) => outcome.status === "UNAVAILABLE").length,
        },
      },
      lastCanary: state.canaries.at(-1) ?? null,
    };
  }

  /** Read-only review accessor for a durable lane-owned trade.  The returned
   * record is detached from store state so API/dashboard callers cannot alter
   * entry, bracket, or reconciliation ownership by accident. */
  findTrade(tradeId: string): DailyRangeTrade | null {
    const trade = this.store.findTrade(tradeId);
    return trade ? {
      ...trade,
      confirmationBar1: { ...trade.confirmationBar1 },
      confirmationBar2: { ...trade.confirmationBar2 },
    } : null;
  }

  history(kind: DailyRangeHistoryKind, limit = 500): unknown[] {
    const bounded = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const state = this.store.getState();
    if (kind === "levels") {
      return Object.values(state.days)
        .flatMap((day) => Object.values(day.levels))
        .sort((a, b) => b.fourHourOpenTime - a.fourHourOpenTime || a.symbol.localeCompare(b.symbol))
        .slice(0, bounded);
    }
    if (kind === "pool-evidence") {
      return Object.values(state.days)
        .flatMap((day) => day.poolEvidence || Object.keys(day.borrowedUniverseAdmissions ?? {}).length > 0 ? [{
          dateUtc: day.dateUtc,
          frozenAt: day.initializedAt,
          universeSource: day.universeSource,
          universeSymbols: [...day.universeSymbols],
          evidence: clonePoolEvidence(day.poolEvidence),
          borrowedUniverseAdmissions: Object.fromEntries(
            Object.entries(day.borrowedUniverseAdmissions ?? {}).map(([symbol, admission]) => [symbol, {
              ...admission,
              poolEvidence: clonePoolEvidence(admission.poolEvidence),
            }]),
          ),
        }] : [])
        .sort((a, b) => b.dateUtc.localeCompare(a.dateUtc))
        .slice(0, bounded);
    }
    if (kind === "cohorts" || kind === "batches") {
      return [...state.signalCohorts]
        .sort((a, b) => b.signalTimestampMs - a.signalTimestampMs || b.cohortId.localeCompare(a.cohortId))
        .slice(0, bounded);
    }
    const rows = kind === "signals" ? state.signals : state.trades;
    return [...rows].slice(-bounded).reverse();
  }

  exportCsv(kind: DailyRangeHistoryKind): string {
    const rows = this.history(kind, 10_000) as Array<Record<string, unknown>>;
    if (rows.length === 0) return "";
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return [columns.join(","), ...rows.map((row) => columns.map((column) => safeCsvCell(row[column])).join(","))].join("\n");
  }

  private performanceSummary(): Record<string, unknown> {
    const executed = this.store.getState().trades.filter((trade) => trade.entryOrderId !== null);
    const closed = executed.filter((trade) => trade.status === "CLOSED" && trade.realizedR !== null && trade.netPnlUsd !== null);
    const wins = closed.filter((trade) => (trade.netPnlUsd ?? 0) > 0);
    const losses = closed.filter((trade) => (trade.netPnlUsd ?? 0) < 0);
    const totalR = closed.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0);
    const grossProfit = wins.reduce((sum, trade) => sum + Math.max(0, trade.netPnlUsd ?? 0), 0);
    const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(Math.min(0, trade.netPnlUsd ?? 0)), 0);
    const mean = closed.length ? totalR / closed.length : null;
    const sortedR = closed.map((trade) => trade.realizedR ?? 0).sort((a, b) => a - b);
    const median = sortedR.length === 0 ? null : sortedR.length % 2 ? sortedR[(sortedR.length - 1) / 2]! : (sortedR[sortedR.length / 2 - 1]! + sortedR[sortedR.length / 2]!) / 2;
    const avgHold = closed.length
      ? closed.reduce((sum, trade) => sum + (trade.holdingDurationMs ?? 0), 0) / closed.length
      : null;
    const byDirection = (direction: DailyRangeDirection) => {
      const rows = closed.filter((trade) => trade.direction === direction);
      return {
        trades: rows.length,
        netPnlUsd: rows.reduce((sum, trade) => sum + (trade.netPnlUsd ?? 0), 0),
        realizedR: rows.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0),
      };
    };
    const bySymbol: Record<string, { trades: number; netPnlUsd: number; realizedR: number }> = {};
    const byDate: Record<string, { trades: number; netPnlUsd: number; realizedR: number }> = {};
    for (const trade of closed) {
      const add = (target: Record<string, { trades: number; netPnlUsd: number; realizedR: number }>, key: string) => {
        const row = target[key] ?? { trades: 0, netPnlUsd: 0, realizedR: 0 };
        row.trades += 1;
        row.netPnlUsd += trade.netPnlUsd ?? 0;
        row.realizedR += trade.realizedR ?? 0;
        target[key] = row;
      };
      add(bySymbol, trade.symbol);
      add(byDate, trade.dateUtc);
    }
    // Policy cohorts are intentionally immutable.  A legacy 2R continuation
    // must never blend into the new 1R continuation headline merely because
    // both happen to share an entry route name.
    const routeCohortKey = (trade: DailyRangeTrade): string => {
      const policyId = trade.routeExitPolicy?.exitPolicyId ?? "legacy-global-2r-bracket";
      const route = trade.routeExitPolicy?.route ?? trade.entryPolicy ?? "LEGACY_CONTINUATION";
      const tpMultipleR = trade.routeExitPolicy?.tpMultipleR ?? trade.rrTarget ?? DAILY_RANGE_RR;
      return `${policyId}:${route}:${tpMultipleR}R`;
    };
    const summarizeRouteCohort = (rows: DailyRangeTrade[]) => {
      const cohortWins = rows.filter((trade) => (trade.netPnlUsd ?? 0) > 0);
      const cohortLosses = rows.filter((trade) => (trade.netPnlUsd ?? 0) < 0);
      const cohortGrossProfit = cohortWins.reduce((sum, trade) => sum + Math.max(0, trade.netPnlUsd ?? 0), 0);
      const cohortGrossLoss = cohortLosses.reduce((sum, trade) => sum + Math.abs(Math.min(0, trade.netPnlUsd ?? 0)), 0);
      const average = (values: Array<number | null | undefined>): number | null => {
        const usable = values.filter(finiteNumber);
        return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
      };
      return {
        trades: rows.length,
        wins: cohortWins.length,
        losses: cohortLosses.length,
        logicalInvalidations: rows.filter((trade) => trade.exitReason === "CONTINUATION_RANGE_REENTRY_EXIT" || trade.exitReason === "FADE_BREAKOUT_REACCEPTANCE_EXIT").length,
        grossPnlUsd: rows.reduce((sum, trade) => sum + (trade.grossPnlUsd ?? 0), 0),
        feesUsd: rows.reduce((sum, trade) => sum + (trade.feesUsd ?? 0), 0),
        fundingUsd: rows.reduce((sum, trade) => sum + (trade.fundingUsd ?? 0), 0),
        netPnlUsd: rows.reduce((sum, trade) => sum + (trade.netPnlUsd ?? 0), 0),
        grossR: rows.reduce((sum, trade) => sum + (trade.grossR ?? 0), 0),
        netR: rows.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0),
        averageMfeR: average(rows.map((trade) => trade.mfeR)),
        averageMaeR: average(rows.map((trade) => trade.maeR)),
        winRate: rows.length ? cohortWins.length / rows.length : null,
        profitFactor: cohortGrossLoss > 0 ? cohortGrossProfit / cohortGrossLoss : cohortGrossProfit > 0 ? null : null,
        averageHoldingDurationMs: average(rows.map((trade) => trade.holdingDurationMs)),
      };
    };
    const routeCohorts: Record<string, ReturnType<typeof summarizeRouteCohort>> = {};
    for (const trade of closed) {
      const key = routeCohortKey(trade);
      const rows = closed.filter((candidate) => routeCohortKey(candidate) === key);
      if (!routeCohorts[key]) routeCohorts[key] = summarizeRouteCohort(rows);
    }
    return {
      totalSignals: this.store.getState().signals.length,
      executedTrades: executed.length,
      openTrades: executed.filter((trade) => !isTerminalTradeStatus(trade.status)).length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : null,
      grossPnlUsd: closed.reduce((sum, trade) => sum + (trade.grossPnlUsd ?? 0), 0),
      netPnlUsd: closed.reduce((sum, trade) => sum + (trade.netPnlUsd ?? 0), 0),
      totalRealizedR: totalR,
      meanR: mean,
      medianR: median,
      expectancyR: mean,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null,
      averageWinnerR: wins.length ? wins.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0) / wins.length : null,
      averageLoserR: losses.length ? losses.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0) / losses.length : null,
      averageHoldingDurationMs: avgHold,
      long: byDirection("LONG"),
      short: byDirection("SHORT"),
      bySymbol,
      byUtcDate: byDate,
      routeCohorts,
      takeProfitCount: closed.filter((trade) => trade.exitReason === "TAKE_PROFIT").length,
      stopLossCount: closed.filter((trade) => trade.exitReason === "STOP_LOSS").length,
      continuationRangeReentryExitCount: closed.filter((trade) => trade.exitReason === "CONTINUATION_RANGE_REENTRY_EXIT").length,
      fadeBreakoutReacceptanceExitCount: closed.filter((trade) => trade.exitReason === "FADE_BREAKOUT_REACCEPTANCE_EXIT").length,
      executionAbortCount: this.store.getState().trades.filter((trade) => trade.status.startsWith("ENTRY_ABORT_")).length,
    };
  }

  /** Manual lane kill switch. Existing exchange-native brackets are left intact. */
  disarm(reason = "manual lane disarm"): { ok: boolean; mode: DailyRangeControlMode } {
    this.store.disarm(iso(this.nowMs()), reason);
    return { ok: true, mode: "DISARMED" };
  }

  arm(): { ok: boolean; reason: string | null; mode: DailyRangeControlMode } {
    const mainnetBlock = this.mainnetControlBlockReason("arm");
    if (mainnetBlock) {
      return { ok: false, reason: mainnetBlock, mode: "DISARMED" };
    }
    const lastCanary = this.store.getState().canaries.at(-1);
    if (!lastCanary || lastCanary.status !== "PASSED") {
      return { ok: false, reason: "a complete DRCANARY lifecycle must pass before arm", mode: "DISARMED" };
    }
    if (!this.startupReconciled) {
      return { ok: false, reason: "exchange/account reconciliation is not complete", mode: "DISARMED" };
    }
    this.resetTodayDetectionAtArm();
    this.store.arm(iso(this.nowMs()));
    return { ok: true, reason: null, mode: "ARMED" };
  }

  /**
   * A manual re-arm is a fresh observation boundary, not permission to replay
   * candles completed while the lane was DISARMED.  Resetting both the
   * watermark and the C1/C2 state prevents a pre-arm C1 from combining with a
   * post-arm C2, or a fully missed C1/C2 pair from being entered late.
   */
  private resetTodayDetectionAtArm(): void {
    const now = this.nowMs();
    const state = this.store.getState();
    const day = state.days[this.currentReferenceWindow(now).dayKey];
    const latestCompletedOpen = lastClosedFiveMinuteOpenTime(now);
    if (!day || latestCompletedOpen === null) return;

    for (const symbol of Object.keys(day.levels)) {
      const symbolState = day.symbolStates[symbol] ?? blankSymbolState(latestCompletedOpen);
      symbolState.lastProcessedBarOpenTime = Math.max(symbolState.lastProcessedBarOpenTime ?? latestCompletedOpen, latestCompletedOpen);
      symbolState.previousClosedCandle = null;
      symbolState.longCount = 0;
      symbolState.shortCount = 0;
      symbolState.longLocked = false;
      symbolState.shortLocked = false;
      if (this.isAutoRoute()) symbolState.router = blankRouterState();
      day.symbolStates[symbol] = symbolState;
    }
    state.runtime.lastProcessedMarketBarOpenTime = Math.max(
      state.runtime.lastProcessedMarketBarOpenTime ?? latestCompletedOpen,
      latestCompletedOpen,
    );
  }

  /**
   * One scheduler tick.  The cadence may be faster than five minutes for bracket
   * reconciliation; kline processing itself is watermark driven and occurs only
   * once for every completed 5m candle.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const startedAt = this.nowMs();
    const state = this.store.getState();
    state.runtime.lastTickAt = iso(startedAt);
    try {
      if (!this.startupReconciled) await this.reconcileOnStartup();
      const exchangeReconciled = await this.reconcileOpenTrades();
      if (exchangeReconciled) {
        await this.migrateOpenTradesToGeometryPolicy();
        await this.resumePendingFadeMfeExitIntents();
        // Logical exits are independent from the entry window. A disarmed lane
        // still retains its native safety, and a protected V1 position still
        // receives its completed-5m thesis check without enabling any entry.
        await this.processRouteSpecificThesisInvalidations();
      }
      // Research labels mature independently from entry mode. A paused/disarmed
      // lane must never abandon already-recorded counterfactual outcomes.
      await this.matureCounterfactualOutcomes();
      await this.matureThesisInvalidationCounterfactuals();
      await this.matureFadeMfeCounterfactuals();
      // If a process ended between the order attempt and the passive cohort
      // snapshot, recover the outcome from the durable signal record only.
      this.syncSignalCohortDecisions();
      await this.retryOnePendingClosedChartSnapshot();
      if (this.isAutoRoute()) {
        // Freeze the V3 daily friction model at the most recent completed
        // five-minute boundary even before the NY 00:00-04:00 reference range
        // is ready.  Otherwise a safe, fresh deployment at 00:xx New York
        // would misleadingly remain FRICTION_MODEL_UNAVAILABLE for hours.
        // This has no entry authority: it only creates an immutable model
        // snapshot from terminal records already known at that boundary.
        const completedBoundary = lastClosedFiveMinuteOpenTime(startedAt);
        if (completedBoundary !== null) this.ensureFrictionModel(completedBoundary + FIVE_MIN_MS);
      }
      const policyReadyForEntries = await this.ensureTodayRange();
      // A policy cutover never reinterprets a day that still owns an exchange
      // trade. Reconciliation and all existing exits already ran above; only
      // fresh signal processing must wait until the inherited trade is terminal.
      if (!policyReadyForEntries) {
        this.store.save();
        return;
      }
      if (state.control.mode !== "ARMED") {
        state.runtime.lastError = null;
        this.store.save();
        return;
      }
      if (!this.inEntryWindow(this.nowMs())) {
        state.runtime.lastError = null;
        this.store.save();
        return;
      }
      await this.processCompletedBars();
      state.runtime.lastError = null;
      this.store.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.runtime.lastError = message;
      try {
        this.store.save();
      } catch {
        // A store error is already the primary, surfaced error.
      }
      console.error(`[daily-range-lane] TICK_FAILED ${message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileOnStartup(): Promise<void> {
    const state = this.store.getState();
    try {
      const hedge = await this.client.isHedgeMode();
      if (hedge) throw new Error("P0: account is in hedge mode; daily lane requires verified one-way semantics");
      await this.reconcilePendingEntries();
      await this.reconcileOpenTrades();
      this.startupReconciled = true;
      state.runtime.reconciledAt = iso(this.nowMs());
      state.runtime.reconciliationError = null;
      this.store.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.runtime.reconciliationError = message;
      this.store.disarm(iso(this.nowMs()), `startup reconciliation failed: ${message}`);
      throw error;
    }
  }

  /**
   * Build one immutable NY/UTC reference level from already-completed market
   * data. It is shared by normal day initialization and later MOM36 borrowing
   * so both paths enforce exactly the same data-completeness rule.
   */
  private async buildDailyReferenceLevel(
    symbol: string,
    window: DailyRangeRuntimeReferenceWindow,
  ): Promise<{ symbol: string; level: DailyRangeLevel | null; reason: string | null }> {
    try {
      let high: number;
      let low: number;
      if (this.isAutoRoute()) {
        // Binance native 4h bars are UTC anchored. A NY-local session must
        // therefore be composed from completed 5m USD-M bars, otherwise DST
        // silently selects the prior NY evening rather than 00:00-04:00.
        const expectedCount = (window.rangeCloseTime - window.rangeOpenTime) / FIVE_MIN_MS;
        const rows = await this.client.getKlines(symbol, "5m", {
          startTime: window.rangeOpenTime,
          endTime: window.rangeCloseTime - 1,
          // NY 00:00-04:00 contains exactly 48 completed 5m bars. Request no
          // more than that; admission must not create an avoidable REST burst.
          limit: expectedCount,
        });
        const exact = rows.map(asDailyCandle)
          .filter((candle) => candle.openTime >= window.rangeOpenTime && candle.closeTime < window.rangeCloseTime)
          .sort((left, right) => left.openTime - right.openTime);
        const complete = exact.length === expectedCount
          && exact[0]?.openTime === window.rangeOpenTime
          && exact.at(-1)?.closeTime === window.rangeCloseTime - 1
          && contiguousFiveMinuteBars(exact);
        if (!complete) {
          return {
            symbol,
            level: null,
            reason: "missing/gapped completed 5m candles for NY 00:00-04:00 reference",
          };
        }
        high = Math.max(...exact.map((candle) => candle.high));
        low = Math.min(...exact.map((candle) => candle.low));
      } else {
        const candles = await this.client.getKlines(symbol, "4h", {
          startTime: window.rangeOpenTime,
          endTime: window.rangeCloseTime - 1,
          limit: 3,
        });
        const exact = candles.find((candle) => candle.openTime === window.rangeOpenTime && candle.closeTime < window.rangeCloseTime);
        if (!exact) {
          return { symbol, level: null, reason: "missing completed UTC 00:00-04:00 candle" };
        }
        high = exact.high;
        low = exact.low;
      }
      if (!(high > low) || !finitePositive(high) || !finitePositive(low)) {
        return { symbol, level: null, reason: "invalid completed Daily Range high/low" };
      }
      return {
        symbol,
        level: {
          dateUtc: window.date,
          symbol,
          fourHourOpenTime: window.rangeOpenTime,
          fourHourCloseTime: window.rangeCloseTime,
          rangeHigh: high,
          rangeLow: low,
          rangeWidth: high - low,
          rangeWidthPct: low > 0 ? (high - low) / low : null,
          dailyUniverseMembership: true,
          createdAt: iso(this.nowMs()),
        },
        reason: null,
      };
    } catch (error) {
      return {
        symbol,
        level: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Add currently borrowable MOM36 names to an already-initialized Daily Range
   * day. This is deliberately additive and sequential: it never rewrites a
   * prior level, never replays older candles, and avoids a concurrent burst of
   * public REST requests when a Cross-Sectional basket first opens.
   */
  private async enrollBorrowedMOM36Symbols(
    day: DailyRangeDayState,
    window: DailyRangeRuntimeReferenceWindow,
    now: number,
  ): Promise<void> {
    const snapshot = this.getUniverse();
    const activeSymbols = new Set(snapshot.symbols.map(normalizeSymbol).filter(Boolean));
    const priorInvalid = new Set(day.invalidReferenceSymbols.map(({ symbol }) => normalizeSymbol(symbol)));
    const priorAdmissions = new Set(Object.keys(day.borrowedUniverseAdmissions ?? {}).map(normalizeSymbol));
    const candidates = [...new Set((snapshot.borrowedSymbols ?? []).map(normalizeSymbol).filter(Boolean))]
      .filter((symbol) => activeSymbols.has(symbol))
      .filter((symbol) => !day.universeSymbols.includes(symbol))
      .filter((symbol) => !priorAdmissions.has(symbol) && !priorInvalid.has(symbol))
      .sort();
    if (candidates.length === 0) return;

    const latestCompleted = lastClosedFiveMinuteOpenTime(now);
    if (latestCompleted === null) return;
    day.borrowedUniverseAdmissions ??= {};
    let admitted = 0;
    let rejected = 0;
    for (const symbol of candidates) {
      // Do not fan out a full MOM36 request batch. A late borrow is optional;
      // keeping the executor's exchange budget healthy is more important than
      // admitting all symbols a few milliseconds earlier.
      const result = await this.buildDailyReferenceLevel(symbol, window);
      if (!result.level) {
        day.invalidReferenceSymbols.push({ symbol, reason: result.reason ?? "invalid reference" });
        rejected += 1;
        continue;
      }
      day.universeSymbols.push(symbol);
      day.universeSymbols.sort();
      day.levels[symbol] = result.level;
      const symbolState = blankSymbolState(latestCompleted);
      if (this.isAutoRoute()) symbolState.router = blankRouterState();
      day.symbolStates[symbol] = symbolState;
      day.borrowedUniverseAdmissions[symbol] = {
        symbol,
        admittedAt: iso(now),
        source: snapshot.source,
        poolEvidence: compactPoolEvidenceForSymbol(snapshot.poolEvidence, symbol),
      };
      admitted += 1;
    }
    if (admitted > 0 || rejected > 0) {
      this.store.save();
      console.log(
        `[daily-range-lane] DAILY_RANGE_MOM36_BORROW_ADMISSION date=${day.dateUtc} admitted=${admitted} invalid=${rejected} observedFrom=${iso(latestCompleted + FIVE_MIN_MS)} source=${snapshot.source}`,
      );
    }
  }

  private async ensureTodayRange(): Promise<boolean> {
    const now = this.nowMs();
    const window = this.currentReferenceWindow(now);
    if (now < window.rangeCloseTime) return true;
    const state = this.store.getState();
    const existingDay = state.days[window.dayKey] ?? null;
    const existingPolicyMatches = this.currentDayPolicyMatches(existingDay);
    if (existingDay && existingPolicyMatches) {
      // A disarmed lane has no entry authority, so defer optional borrowing
      // rather than spending exchange budget during a cooldown/recovery.
      if (state.control.mode === "ARMED" && this.inEntryWindow(now)) {
        await this.enrollBorrowedMOM36Symbols(existingDay, window, now);
      }
      return true;
    }
    if (existingDay && state.trades.some((trade) => trade.dateUtc === window.date && !isTerminalTradeStatus(trade.status))) {
      // Never rewrite a live day's router/universe while it owns an exchange
      // position. It keeps its original immutable bracket; lifecycle/reconcile
      // remains active, but fresh entries are blocked until it is terminal.
      const message = `policy cutover pending: active Daily Range trade still belongs to ${existingDay.strategyVersion ?? "legacy"}`;
      if (state.runtime.lastError !== message) {
        console.log(`[daily-range-lane] DAILY_RANGE_POLICY_CUTOVER_BLOCKED date=${window.date} inherited=${existingDay.strategyVersion ?? "legacy"}`);
      }
      state.runtime.lastError = message;
      this.store.save();
      return false;
    }

    const snapshot = this.getUniverse();
    const symbols = [...new Set(snapshot.symbols.map(normalizeSymbol).filter(Boolean))].sort();
    if (symbols.length === 0) throw new Error("daily universe snapshot is empty");
    if (existingDay) {
      delete state.days[window.dayKey];
      console.log(
        `[daily-range-lane] DAILY_RANGE_POLICY_CUTOVER date=${window.date} from=${existingDay.strategyVersion ?? "legacy"}/${existingDay.strategyMode ?? "legacy"} to=${this.strategyVersion}/${this.strategyMode} entryMode=${this.autoRouteEntryMode}`,
      );
    }
    const levelResults = await Promise.all(symbols.map((symbol) => this.buildDailyReferenceLevel(symbol, window)));
    const latestCompleted = lastClosedFiveMinuteOpenTime(now);
    const levels: Record<string, DailyRangeLevel> = {};
    const invalidReferenceSymbols: Array<{ symbol: string; reason: string }> = [];
    const symbolStates: Record<string, DailyRangeSymbolState> = {};
    for (const result of levelResults) {
      if (result.level) {
        levels[result.symbol] = result.level;
        // Startup is never an excuse to enter based on a bar which closed before
        // this lane was armed. An already-armed restart retains a persisted watermark.
        const symbolState = blankSymbolState(latestCompleted);
        if (this.isAutoRoute()) symbolState.router = blankRouterState();
        symbolStates[result.symbol] = symbolState;
      } else {
        invalidReferenceSymbols.push({ symbol: result.symbol, reason: result.reason ?? "invalid reference" });
      }
    }
    state.days[window.dayKey] = {
      dateUtc: window.date,
      initializedAt: iso(this.nowMs()),
      universeSymbols: symbols,
      universeSource: snapshot.source,
      poolEvidence: clonePoolEvidence(snapshot.poolEvidence),
      levels,
      invalidReferenceSymbols,
      symbolStates,
      strategyVersion: this.strategyVersion,
      strategyMode: this.strategyMode,
      autoRouteEntryMode: this.isAutoRouteV3() ? this.autoRouteEntryMode : undefined,
      referenceTimezone: window.referenceTimezone,
      referenceRangeOpenTime: window.rangeOpenTime,
      referenceRangeCloseTime: window.rangeCloseTime,
      entryWindowCloseTime: window.entryWindowCloseTime,
    };
    this.store.save();
    console.log(
      `[daily-range-lane] DAILY_RANGE_INITIALIZED date=${window.date} mode=${this.strategyMode} timezone=${window.referenceTimezone} universe=${symbols.length} valid=${Object.keys(levels).length} invalid=${invalidReferenceSymbols.length} source=${snapshot.source} poolEvidence=${snapshot.poolEvidence ? "CAPTURED" : "UNAVAILABLE"}`,
    );
    return true;
  }

  private async processCompletedBars(): Promise<void> {
    const now = this.nowMs();
    const window = this.currentReferenceWindow(now);
    const state = this.store.getState();
    const day = state.days[window.dayKey];
    if (!day) return;
    const latestCompletedOpen = lastClosedFiveMinuteOpenTime(now);
    if (latestCompletedOpen === null || latestCompletedOpen < window.rangeCloseTime) return;
    if (this.isAutoRoute()) {
      // The model/fingerprint boundary is a completed five-minute boundary,
      // not a random scheduler instant. A later batch on that UTC day can only
      // reference this one immutable model.
      this.ensureFrictionModel(latestCompletedOpen + FIVE_MIN_MS);
    }
    const actions: DailyRangeSignal[] = [];
    for (const [symbol, level] of Object.entries(day.levels)) {
      const symbolState = day.symbolStates[symbol] ?? blankSymbolState(latestCompletedOpen);
      day.symbolStates[symbol] = symbolState;
      const initialOpen = Math.max(
        window.rangeCloseTime,
        (symbolState.lastProcessedBarOpenTime ?? (window.rangeCloseTime - FIVE_MIN_MS)) + FIVE_MIN_MS,
      );
      if (initialOpen > latestCompletedOpen) continue;
      let candles: DailyRangeCandle[];
      try {
        const rows = await this.client.getKlines(symbol, "5m", {
          startTime: initialOpen,
          endTime: latestCompletedOpen + FIVE_MIN_MS - 1,
          limit: 500,
        });
        candles = rows
          .map(asDailyCandle)
          .filter((bar) => bar.openTime >= initialOpen && bar.openTime <= latestCompletedOpen && bar.closeTime < now)
          .sort((a, b) => a.openTime - b.openTime);
      } catch (error) {
        state.runtime.lastError = `${symbol}: 5m fetch failed: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
      for (const candle of candles) {
        const expected = (symbolState.lastProcessedBarOpenTime ?? candle.openTime - FIVE_MIN_MS) + FIVE_MIN_MS;
        if (candle.openTime !== expected) {
          state.runtime.lastError = `${symbol}: missing 5m candle at ${iso(expected)}`;
          break; // do not leap over a missing state transition
        }
        const emitted = this.applyCandle(day, level, symbolState, candle);
        symbolState.lastProcessedBarOpenTime = candle.openTime;
        symbolState.previousClosedCandle = candle;
        if (emitted) actions.push(emitted);
        // The watermark and any emitted signal form one atomic file update. A crash
        // cannot create an unrecorded advance or duplicate reprocessing of the same bar.
        this.store.save();
      }
    }
    state.runtime.lastProcessedMarketBarOpenTime = latestCompletedOpen;
    this.store.save();
    // Phase A is complete: every symbol's closed candles have been evaluated and
    // all newly valid signals are durable.  No order may be placed above this
    // line.  The finalizer below groups by canonical C2 close timestamp and
    // reserves the complete selected batch before any exchange POST.
    this.captureSignalBatches(day, actions);
    // Capture the non-reconstructable BBO immediately after every symbol has
    // finished C2 evaluation and before batch allocation can submit an order.
    // This is the forward decision boundary: a signal cannot be known before
    // C2 closes, so the just-observed BBO is causal even though it follows the
    // candle timestamp. Recovery reads below never receive this authority.
    await this.captureSignalTimeMarketQuality(day, actions, "FORWARD_BEFORE_ALLOCATION");
    // V3 AUTO_ROUTE candidates get their causal feature snapshot before any
    // scarce-slot allocation. Legacy V1 evidence stays on its original passive
    // post-allocation collection path and is never retroactively reinterpreted.
    if (this.isAutoRoute()) {
      await this.capturePendingResearchSnapshots(day, "FORWARD_BEFORE_ALLOCATION");
    }
    await this.finalizePendingSignalBatches(day);
    await this.capturePendingResearchSnapshots(day, "RECOVERY_AFTER_ALLOCATION");
    await this.matureCounterfactualOutcomes();
    this.syncSignalCohortDecisions();
  }

  /** Replays only policies that opt into a completed-candle thesis exit. */
  private async processRouteSpecificThesisInvalidations(): Promise<void> {
    const now = this.nowMs();
    const latestCompletedOpen = lastClosedFiveMinuteOpenTime(now);
    if (latestCompletedOpen === null) return;
    const active = this.store.getState().trades
      .filter((trade) => trade.status === "OPEN"
        && isDailyRangeRouteExitPolicy(trade.routeExitPolicy)
        && trade.routeExitPolicy.thesisInvalidationType !== "NONE")
      .sort((left, right) => left.entrySubmittedAt.localeCompare(right.entrySubmittedAt) || left.tradeId.localeCompare(right.tradeId));
    for (const trade of active) {
      if (this.closingTradeIds.has(trade.tradeId) || trade.thesisInvalidation) continue;
      const policy = trade.routeExitPolicy;
      if (!policy) continue;
      const entryFilledAt = toMs(trade.entryFilledAt) ?? toMs(trade.entrySubmittedAt);
      if (entryFilledAt === null) continue;
      // The thesis watcher starts with the first *whole completed* 5m candle
      // after the real entry.  It must not retrospectively turn a pre-fill C2
      // or a candle already in progress at fill time into a logical exit.
      const firstEligibleOpen = Math.ceil(entryFilledAt / FIVE_MIN_MS) * FIVE_MIN_MS;
      let nextOpen = Math.max(
        (trade.lastThesisInvalidationBarOpenTime ?? trade.confirmationBar2.openTime) + FIVE_MIN_MS,
        trade.confirmationBar2.openTime + FIVE_MIN_MS,
        firstEligibleOpen,
      );
      let complete = true;
      while (nextOpen <= latestCompletedOpen && trade.status === "OPEN" && !trade.thesisInvalidation) {
        const endOpen = Math.min(latestCompletedOpen, nextOpen + 499 * FIVE_MIN_MS);
        let rows: DailyRangeCandle[];
        try {
          rows = (await this.client.getKlines(trade.symbol, "5m", {
            startTime: nextOpen,
            endTime: endOpen + FIVE_MIN_MS - 1,
            limit: 500,
          }))
            .map(asDailyCandle)
            .filter((candle) => candle.openTime >= nextOpen && candle.openTime <= endOpen
              && candle.closeTime === candle.openTime + FIVE_MIN_MS - 1
              && candle.closeTime < now)
            .sort((left, right) => left.openTime - right.openTime);
        } catch {
          complete = false;
          break;
        }
        const expectedCount = Math.floor((endOpen - nextOpen) / FIVE_MIN_MS) + 1;
        if (rows.length !== expectedCount || rows.some((row, index) => row.openTime !== nextOpen + index * FIVE_MIN_MS)) {
          // Do not leap a missing close and silently manufacture an invalidation.
          complete = false;
          break;
        }
        for (const candle of rows) {
          const decision = evaluateDailyRangeThesisInvalidation({ policy, candle });
          trade.lastThesisInvalidationBarOpenTime = candle.openTime;
          if (!decision) continue;
          this.store.save();
          await this.flattenOnRouteThesisInvalidation(trade, decision);
          break;
        }
        nextOpen = endOpen + FIVE_MIN_MS;
      }
      if (complete || trade.lastThesisInvalidationBarOpenTime !== null) this.store.save();
    }
  }

  private oldPolicyCounterfactualForThesisExit(trade: DailyRangeTrade, at: string): DailyRangeOldPolicyCounterfactual | null {
    if (!finitePositive(trade.stopPrice) || !finitePositive(trade.oldPolicyTakeProfitPrice ?? null)) return null;
    return {
      status: "PENDING",
      exitPolicyId: "legacy-global-2r-bracket",
      tpMultipleR: 2,
      structuralStop: trade.stopPrice,
      takeProfit: trade.oldPolicyTakeProfitPrice!,
      startedAt: at,
      lastCheckedBarOpenTime: null,
      maturedAt: null,
      exitPrice: null,
      grossR: null,
      ambiguityReason: null,
    };
  }

  /**
   * Reconcile immediately before creating the single logical-exit intent. If a
   * native TP/SL already won the race, reconciliation makes it terminal and no
   * market exit or second P&L record is created.
   */
  private async flattenOnRouteThesisInvalidation(
    trade: DailyRangeTrade,
    decision: DailyRangeThesisInvalidationDecision,
  ): Promise<void> {
    if (trade.status !== "OPEN" || trade.thesisInvalidation || this.closingTradeIds.has(trade.tradeId)) return;
    const reconciled = await this.reconcileOpenTrades();
    if (!reconciled || trade.status !== "OPEN" || trade.thesisInvalidation || this.closingTradeIds.has(trade.tradeId)) return;
    const at = iso(decision.candleCloseTime + 1);
    trade.thesisInvalidation = {
      reason: decision.reason,
      invalidationCandleOpenTime: decision.candleOpenTime,
      invalidationCandleCloseTime: decision.candleCloseTime,
      invalidationClose: decision.candleClose,
      referenceBoundary: decision.referenceBoundary,
      distanceFromBoundary: decision.distanceFromBoundary,
      mfeAtThesisInvalidation: trade.mfeR ?? null,
      maeAtThesisInvalidation: trade.maeR ?? null,
      actualExitFill: null,
      exitSlippageBps: null,
      oldStructuralStop: trade.stopPrice,
      oldNativeTakeProfit: trade.oldPolicyTakeProfitPrice ?? trade.takeProfitPrice,
      oldPolicyCounterfactual: this.oldPolicyCounterfactualForThesisExit(trade, at),
    };
    this.store.save();
    await this.emergencyFlatten(trade, "CLOSED", decision.reason);
    if ((trade.status as DailyRangeTradeStatus) === "CLOSED" && trade.exitReason === decision.reason && trade.thesisInvalidation) {
      trade.thesisInvalidation.actualExitFill = trade.exitPrice;
      trade.thesisInvalidation.exitSlippageBps = trade.exitSlippageBps;
      this.store.save();
    }
  }

  private fadeMfeCounterfactualForExit(trade: DailyRangeTrade, startedAt: string): DailyRangeFadeMfeCounterfactual | null {
    if (!finitePositive(trade.stopPrice) || !finitePositive(trade.takeProfitPrice)) return null;
    return {
      status: "PENDING",
      originalStructuralSL: trade.stopPrice,
      originalStructuralTP: trade.takeProfitPrice,
      startedAt,
      lastCheckedBarOpenTime: null,
      maturedAt: null,
      exitPrice: null,
      grossR: null,
      ambiguityReason: null,
    };
  }

  /**
   * MFE uses the identical race discipline as the existing thesis invalidation:
   * reconcile first, write one durable intent, then delegate all exchange work
   * to the ownership-checked reduce-only flatten path.
   */
  private async flattenOnFadeMfeGiveback(
    trade: DailyRangeTrade,
    event: DailyRangeContractPathEvent,
    requestedReason: DailyRangeFadeMfeExitReason,
  ): Promise<void> {
    const initial = trade.fadeMfe;
    if (trade.status !== "OPEN" || !initial || initial.mfePolicyId !== DAILY_RANGE_FADE_MFE_POLICY_ID
      || this.closingTradeIds.has(trade.tradeId)) return;
    const reconciled = await this.reconcileOpenTrades();
    const policy = trade.fadeMfe;
    const eventAgeMs = this.nowMs() - event.receivedAtMs;
    if (!reconciled || trade.status !== "OPEN" || !policy || policy.mfePolicyId !== DAILY_RANGE_FADE_MFE_POLICY_ID
      || policy.health !== "HEALTHY" || eventAgeMs < 0 || eventAgeMs > MAX_FADE_MFE_EVENT_PROCESSING_DELAY_MS
      || this.closingTradeIds.has(trade.tradeId)) {
      if (policy && (eventAgeMs < 0 || eventAgeMs > MAX_FADE_MFE_EVENT_PROCESSING_DELAY_MS)) {
        trade.fadeMfe = markDailyRangeFadeMfeDegraded(policy, `MFE event stale before exit (${eventAgeMs}ms)`, this.nowMs());
        this.store.save();
      }
      return;
    }
    const reason: DailyRangeFadeMfeExitReason = policy.stage2Armed
      ? "FADE_MFE_STAGE2_GIVEBACK_EXIT"
      : requestedReason;
    if (!policy.stage1Armed || policy.mfeExitFloorProgress === null || policy.mfeExitFloorPrice === null) return;
    if (policy.mfeExitIntentReason !== null && policy.mfeExitIntentReason !== reason) {
      // Stage 2 takes precedence if it armed between two queued events, but a
      // prior intent must never become a second market-close identity.
      return;
    }
    if (policy.mfeExitIntentAt === null) {
      const at = iso(event.eventTimeMs);
      policy.mfeExitIntentAt = at;
      policy.mfeExitIntentReason = reason;
      policy.exitAttribution = {
        highestArmedStage: policy.stage2Armed ? 2 : 1,
        peakMfeProgress: policy.peakMfeProgress,
        peakMfePrice: policy.peakMfePrice,
        peakMfeAt: policy.peakMfeAt,
        floorProgressAtExit: policy.mfeExitFloorProgress,
        floorPriceAtExit: policy.mfeExitFloorPrice,
        triggerPrice: event.price,
        triggerAt: at,
        actualExitFill: null,
        exitSlippageBps: null,
        grossR: null,
        netR: null,
        originalStructuralSL: trade.stopPrice,
        originalStructuralTP: trade.takeProfitPrice,
        terminalOutcome: "PENDING",
      };
      trade.fadeMfeCounterfactual = this.fadeMfeCounterfactualForExit(trade, at);
      this.store.save();
    }
    await this.emergencyFlatten(trade, "CLOSED", reason);
    if ((trade.status as DailyRangeTradeStatus) !== "CLOSED" || !trade.fadeMfe?.exitAttribution) return;
    const attribution = trade.fadeMfe.exitAttribution;
    if (trade.exitReason === reason) {
      attribution.actualExitFill = trade.exitPrice;
      attribution.exitSlippageBps = trade.exitSlippageBps;
      attribution.grossR = trade.grossR;
      attribution.netR = trade.realizedR;
      attribution.terminalOutcome = "MFE_EXIT";
      if (trade.fadeMfeCounterfactual) trade.fadeMfeCounterfactual.startedAt = trade.exitTimestamp ?? attribution.triggerAt;
    } else {
      attribution.terminalOutcome = trade.exitReason === "TAKE_PROFIT"
        ? "NATIVE_TP"
        : trade.exitReason === "STOP_LOSS" ? "NATIVE_SL" : "OTHER";
      // No counterfactual is meaningful when native protection won the race.
      trade.fadeMfeCounterfactual = null;
    }
    this.store.save();
  }

  /**
   * A crash can happen after the causal exit intent was durably written but
   * before the reduce-only close reaches the exchange. Resume that already
   * authorized intent after a fresh reconciliation; do not wait for another
   * price event or silently abandon the protection.
   */
  private async resumePendingFadeMfeExitIntents(): Promise<void> {
    const pending = this.store.getState().trades
      .filter((trade) => trade.status === "OPEN"
        && trade.fadeMfe?.mfePolicyId === DAILY_RANGE_FADE_MFE_POLICY_ID
        && trade.fadeMfe.mfeExitIntentAt !== null
        && trade.fadeMfe.mfeExitIntentReason !== null
        && trade.fadeMfe.exitAttribution?.terminalOutcome === "PENDING")
      .sort((left, right) => left.entrySubmittedAt.localeCompare(right.entrySubmittedAt) || left.tradeId.localeCompare(right.tradeId));
    for (const trade of pending) {
      const policy = trade.fadeMfe;
      const reason = policy?.mfeExitIntentReason;
      if (!policy || !reason || this.closingTradeIds.has(trade.tradeId)) continue;
      const reconciled = await this.reconcileOpenTrades();
      if (!reconciled || trade.status !== "OPEN" || this.closingTradeIds.has(trade.tradeId)) continue;
      await this.emergencyFlatten(trade, "CLOSED", reason);
    }
  }

  /** Continue research-only tracking of the legacy global-2R bracket after a logical exit. */
  private async matureThesisInvalidationCounterfactuals(): Promise<void> {
    const pending = this.store.getState().trades
      .filter((trade) => trade.status === "CLOSED" && trade.thesisInvalidation?.oldPolicyCounterfactual?.status === "PENDING")
      .sort((left, right) => (left.exitTimestamp ?? left.entrySubmittedAt).localeCompare(right.exitTimestamp ?? right.entrySubmittedAt))
      .slice(0, MAX_COUNTERFACTUAL_MATURATION_PER_TICK);
    if (pending.length === 0) return;
    const now = this.nowMs();
    const latestCompletedMinuteOpen = Math.floor(now / 60_000) * 60_000 - 60_000;
    if (latestCompletedMinuteOpen < 0) return;
    await Promise.all(pending.map(async (trade) => {
      const record = trade.thesisInvalidation;
      const outcome = record?.oldPolicyCounterfactual;
      if (!record || !outcome || outcome.status !== "PENDING" || !finitePositive(trade.entryFillPrice) || !finitePositive(trade.stopPrice)) return;
      const startTime = outcome.lastCheckedBarOpenTime ?? Math.floor((record.invalidationCandleCloseTime + 1) / 60_000) * 60_000;
      try {
        const rows = await this.client.getKlines(trade.symbol, "1m", {
          startTime,
          endTime: latestCompletedMinuteOpen + 60_000 - 1,
          limit: 1_500,
        });
        const candles = rows.map(asDailyCandle)
          .filter((candle) => candle.openTime >= startTime && candle.closeTime < now)
          .sort((left, right) => left.openTime - right.openTime);
        for (const candle of candles) {
          const tpHit = trade.direction === "LONG" ? candle.high >= outcome.takeProfit : candle.low <= outcome.takeProfit;
          const slHit = trade.direction === "LONG" ? candle.low <= outcome.structuralStop : candle.high >= outcome.structuralStop;
          if (!tpHit && !slHit) continue;
          outcome.maturedAt = iso(candle.closeTime + 1);
          if (tpHit && slHit) {
            outcome.status = "OUTCOME_AMBIGUOUS";
            outcome.ambiguityReason = "1m OHLC touched legacy TP and structural SL in the same candle";
            return;
          }
          const exitPrice = tpHit ? outcome.takeProfit : outcome.structuralStop;
          const risk = trade.direction === "LONG"
            ? trade.entryFillPrice - trade.stopPrice
            : trade.stopPrice - trade.entryFillPrice;
          outcome.status = tpHit ? "MATURE_TP" : "MATURE_SL";
          outcome.exitPrice = exitPrice;
          outcome.grossR = risk > EPSILON
            ? (trade.direction === "LONG" ? exitPrice - trade.entryFillPrice : trade.entryFillPrice - exitPrice) / risk
            : null;
          return;
        }
        const last = candles.at(-1);
        if (last) outcome.lastCheckedBarOpenTime = last.openTime + 60_000;
      } catch {
        // Leave the shadow record pending rather than inventing a path result.
      }
    }));
    this.store.save();
  }

  /**
   * Research-only original-bracket continuation after a real MFE close. It
   * never creates an order and starts only at the next full 1m candle, so the
   * MFE exit minute is never reconstructed from ambiguous OHLC ordering.
   */
  private async matureFadeMfeCounterfactuals(): Promise<void> {
    const pending = this.store.getState().trades
      .filter((trade) => trade.status === "CLOSED"
        && trade.fadeMfe?.exitAttribution?.terminalOutcome === "MFE_EXIT"
        && trade.fadeMfeCounterfactual?.status === "PENDING")
      .sort((left, right) => (left.exitTimestamp ?? left.entrySubmittedAt).localeCompare(right.exitTimestamp ?? right.entrySubmittedAt))
      .slice(0, MAX_COUNTERFACTUAL_MATURATION_PER_TICK);
    if (pending.length === 0) return;
    const now = this.nowMs();
    const latestCompletedMinuteOpen = Math.floor(now / 60_000) * 60_000 - 60_000;
    if (latestCompletedMinuteOpen < 0) return;
    await Promise.all(pending.map(async (trade) => {
      const outcome = trade.fadeMfeCounterfactual;
      if (!outcome || outcome.status !== "PENDING" || !finitePositive(trade.entryFillPrice)) return;
      const startedAt = toMs(outcome.startedAt);
      if (startedAt === null) {
        outcome.status = "UNAVAILABLE";
        outcome.ambiguityReason = "MFE counterfactual lacks a confirmed logical-exit timestamp";
        return;
      }
      const startTime = outcome.lastCheckedBarOpenTime ?? Math.ceil((startedAt + 1) / 60_000) * 60_000;
      if (startTime > latestCompletedMinuteOpen) return;
      try {
        const rows = await this.client.getKlines(trade.symbol, "1m", {
          startTime,
          endTime: latestCompletedMinuteOpen + 60_000 - 1,
          limit: 1_500,
        });
        const candles = rows.map(asDailyCandle)
          .filter((candle) => candle.openTime >= startTime && candle.closeTime < now)
          .sort((left, right) => left.openTime - right.openTime);
        for (const candle of candles) {
          const tpHit = trade.direction === "LONG"
            ? candle.high >= outcome.originalStructuralTP
            : candle.low <= outcome.originalStructuralTP;
          const slHit = trade.direction === "LONG"
            ? candle.low <= outcome.originalStructuralSL
            : candle.high >= outcome.originalStructuralSL;
          if (!tpHit && !slHit) continue;
          outcome.maturedAt = iso(candle.closeTime + 1);
          if (tpHit && slHit) {
            outcome.status = "OUTCOME_AMBIGUOUS";
            outcome.ambiguityReason = "1m OHLC touched original structural TP and SL in the same candle";
            return;
          }
          const exitPrice = tpHit ? outcome.originalStructuralTP : outcome.originalStructuralSL;
          const risk = Math.abs(trade.entryFillPrice - outcome.originalStructuralSL);
          outcome.status = tpHit ? "MATURE_TP" : "MATURE_SL";
          outcome.exitPrice = exitPrice;
          outcome.grossR = risk > EPSILON
            ? (trade.direction === "LONG" ? exitPrice - trade.entryFillPrice : trade.entryFillPrice - exitPrice) / risk
            : null;
          return;
        }
        const last = candles.at(-1);
        if (last) outcome.lastCheckedBarOpenTime = last.openTime + 60_000;
      } catch {
        // Keep PENDING: research evidence must never invent a path result or
        // send any order when history is temporarily unavailable.
      }
    }));
    this.store.save();
  }

  private applyCandle(
    day: DailyRangeDayState,
    level: DailyRangeLevel,
    symbolState: DailyRangeSymbolState,
    candle: DailyRangeCandle,
  ): DailyRangeSignal | null {
    if (this.isAutoRoute()) return this.applyAutoRouteCandle(day, level, symbolState, candle);
    const longQualified = candle.close >= level.rangeHigh;
    const shortQualified = candle.close <= level.rangeLow;
    // The locks are directional.  A close below HIGH resets the LONG run and a
    // close above LOW resets the SHORT run, exactly matching the V1 contract.
    // Thus an immediate high-to-low reversal resets the former long acceptance
    // while beginning a fresh short count; it still needs two bars on its own
    // side before it can signal.
    let emitted: DailyRangeSignal | null = null;
    if (longQualified) {
      if (symbolState.longCount === 0) symbolState.longCount = 1;
      else if (symbolState.longCount === 1) {
        symbolState.longCount = 2;
        if (!symbolState.longLocked) {
          symbolState.longLocked = true;
          emitted = this.recordSignal(day, level, "LONG", symbolState.previousClosedCandle, candle);
        }
      }
    } else {
      symbolState.longCount = 0;
      symbolState.longLocked = false;
    }
    if (shortQualified) {
      if (symbolState.shortCount === 0) symbolState.shortCount = 1;
      else if (symbolState.shortCount === 1) {
        symbolState.shortCount = 2;
        if (!symbolState.shortLocked && emitted === null) {
          symbolState.shortLocked = true;
          emitted = this.recordSignal(day, level, "SHORT", symbolState.previousClosedCandle, candle);
        }
      }
    } else {
      symbolState.shortCount = 0;
      symbolState.shortLocked = false;
    }
    return emitted;
  }

  /**
   * The router consumes completed 5m bars only. V2 retains the historical
   * C2-follow-through rule; V3 selects either first re-entry Fade only or
   * first-outside Continuation only through the explicit policy passed below.
   */
  private applyAutoRouteCandle(
    day: DailyRangeDayState,
    level: DailyRangeLevel,
    symbolState: DailyRangeSymbolState,
    candle: DailyRangeCandle,
  ): DailyRangeSignal | null {
    const transition = advanceDailyRangeAutoRoute({
      dateUtc: day.dateUtc,
      symbol: level.symbol,
      rangeHigh: level.rangeHigh,
      rangeLow: level.rangeLow,
      state: routerStateFor(symbolState),
      candle,
      entryMode: this.autoRouteEntryMode,
    });
    symbolState.router = transition.state;
    const decision = transition.decision;
    if (!decision) return null;
    // The pure state machine deliberately returns the historical C1/C2 pair;
    // only this lane owns signal ids, durable state, and execution lineage.
    return this.recordSignal(day, level, decision.direction, decision.confirmationBar1, decision.confirmationBar2, {
      entryPolicy: decision.entryPolicy,
      breakoutDirection: decision.breakoutDirection,
      breakoutId: decision.breakoutId,
      breakoutExtreme: decision.breakoutExtreme,
      entryTiming: decision.entryTiming ?? null,
    });
  }

  private recordSignal(
    day: DailyRangeDayState,
    level: DailyRangeLevel,
    direction: DailyRangeDirection,
    confirmationBar1: DailyRangeCandle | null,
    confirmationBar2: DailyRangeCandle,
    route: {
      entryPolicy: DailyRangeEntryPolicy;
      breakoutDirection: DailyRangeBreakoutDirection | null;
      breakoutId: string | null;
      breakoutExtreme: number | null;
      entryTiming: DailyRangeAutoRouteEntryTiming | null;
    } | null = null,
  ): DailyRangeSignal {
    const state = this.store.getState();
    // A fade can legitimately re-enter several completed bars after its first
    // outside close. Continuation and legacy signals still require adjacent C1/C2.
    const allowNonContiguousBreakout = route?.entryPolicy === "FADE";
    const firstOutsideContinuation = route?.entryTiming === "FIRST_OUTSIDE_CLOSE";
    const bar1 = confirmationBar1 && (
      allowNonContiguousBreakout
      || firstOutsideContinuation && confirmationBar1.openTime === confirmationBar2.openTime
      || confirmationBar1.openTime === confirmationBar2.openTime - FIVE_MIN_MS
    )
      ? confirmationBar1
      : null;
    const window = this.currentReferenceWindow(confirmationBar2.closeTime + 1);
    // The policy becomes effective only at this clean completed-5m decision
    // boundary. Existing durable signals/trades have no such snapshot and stay
    // on their original global-2R exit lineage.
    const routeExitPolicy = this.isAutoRoute()
      ? dailyRangeRouteExitPolicyForSignal({
        route: route?.entryPolicy ?? null,
        originalBreakoutDirection: route?.breakoutDirection ?? null,
        rangeHigh: level.rangeHigh,
        rangeLow: level.rangeLow,
        effectiveAt: iso(confirmationBar2.closeTime + 1),
        structuralSrEnabled: this.structuralSrPolicyEnabled,
      })
      : null;
    const entryPolicy = route?.entryPolicy ?? "LEGACY_CONTINUATION";
    const routeExecutionEnabled = !this.isLiveContinuationShadow({ entryPolicy });
    const signal: DailyRangeSignal = {
      signalId: signalId(this.strategyVersion, day.dateUtc, level.symbol, direction, confirmationBar2.closeTime),
      strategyVersion: this.strategyVersion,
      laneId: DAILY_RANGE_LANE_ID,
      dateUtc: day.dateUtc,
      symbol: level.symbol,
      direction,
      rangeHigh: level.rangeHigh,
      rangeLow: level.rangeLow,
      confirmationBar1: bar1,
      confirmationBar2,
      signalTimestamp: iso(confirmationBar2.closeTime + 1),
      signalTimestampMs: confirmationBar2.closeTime + 1,
      entryEligible: false,
      reason: bar1 === null ? "STALE_DATA" : null,
      entryAttemptedAt: null,
      tradeId: null,
      signalBatchTimestamp: iso(confirmationBar2.closeTime + 1),
      eligibleSince: iso(confirmationBar2.closeTime + 1),
      poolVersion: cohortPoolEvidenceForSymbol(day, level.symbol)?.poolVersion ?? null,
      universePolicyId: day.universeSource,
      selectorMode: this.allocatorMode,
      selectorId: this.selectorId,
      selectorScore: null,
      selectorRank: null,
      economics: null,
      routeExecutionEnabled,
      executionEligible: routeExecutionEnabled,
      geometry: null,
      alphaSelector: null,
      actuallySelected: false,
      actuallyExecuted: false,
      research: { marketQuality: null, features: null, counterfactual: null },
      entryPolicy,
      entryTiming: route?.entryTiming ?? null,
      breakoutDirection: route?.breakoutDirection ?? null,
      breakoutId: route?.breakoutId ?? null,
      breakoutExtreme: route?.breakoutExtreme ?? null,
      referenceTimezone: day.referenceTimezone ?? window.referenceTimezone,
      referenceRangeOpenTime: day.referenceRangeOpenTime ?? level.fourHourOpenTime,
      referenceRangeCloseTime: day.referenceRangeCloseTime ?? level.fourHourCloseTime,
      routeExitPolicy,
    };
    state.signals.push(signal);
    console.log(`[daily-range-lane] ${signal.entryPolicy}_${direction}_CONFIRMED symbol=${signal.symbol} signal=${signal.signalId} timing=${signal.entryTiming ?? "legacy"} breakout=${signal.breakoutId ?? "legacy"}`);
    return signal;
  }

  private candidateFromSignal(
    day: DailyRangeDayState,
    signal: DailyRangeSignal,
    executionSequence: number,
    cohortSequence: number,
  ): DailyRangeSignalCohortCandidate {
    const rangeWidth = signal.rangeHigh - signal.rangeLow;
    const breakoutDistancePrice = breakoutExtensionForSignal(signal, signal.confirmationBar2);
    return {
      signalId: signal.signalId,
      symbol: signal.symbol,
      direction: signal.direction,
      executionSequence,
      cohortSequence,
      rangeHigh: signal.rangeHigh,
      rangeLow: signal.rangeLow,
      rangeWidth,
      rangeWidthPct: signal.rangeLow > 0 ? rangeWidth / signal.rangeLow : null,
      confirmationClose: signal.confirmationBar2.close,
      breakoutDistancePrice,
      breakoutDistanceOfRange: rangeWidth > EPSILON ? breakoutDistancePrice / rangeWidth : null,
      poolAudit: cloneCohortPoolAudit(day, signal.symbol),
      marketQuality: signal.research?.marketQuality ?? null,
      features: signal.research?.features ?? null,
      counterfactual: signal.research?.counterfactual ?? null,
      selectorMode: signal.selectorMode ?? this.allocatorMode,
      selectorId: signal.selectorId ?? this.selectorId,
      selectorScore: signal.selectorScore ?? null,
      selectorRank: signal.selectorRank ?? null,
      tieBreakHash: null,
      economics: signal.economics ?? null,
      routeExecutionEnabled: signal.routeExecutionEnabled ?? true,
      executionEligible: signal.executionEligible ?? true,
      geometry: signal.geometry ?? signal.economics?.geometry ?? null,
      routeExitPolicy: signal.routeExitPolicy ?? null,
      alphaSelector: signal.alphaSelector ?? null,
      actuallySelected: signal.actuallySelected ?? false,
      actuallyExecuted: signal.actuallyExecuted ?? false,
      skipReason: signal.reason,
      decision: null,
    };
  }

  /**
   * Persist every acceptance signal first.  A delayed/missing symbol may add a
   * candidate to an existing timestamp later, so an incomplete batch is merged
   * rather than prematurely finalized.
   */
  private captureSignalBatches(day: DailyRangeDayState, actions: readonly DailyRangeSignal[]): void {
    if (actions.length === 0) return;
    const state = this.store.getState();
    const byId = new Map(state.signalCohorts.map((cohort) => [cohort.cohortId, cohort]));
    const grouped = new Map<number, Array<{ signal: DailyRangeSignal; executionSequence: number }>>();
    actions.forEach((signal, executionSequence) => {
      const rows = grouped.get(signal.signalTimestampMs) ?? [];
      rows.push({ signal, executionSequence });
      grouped.set(signal.signalTimestampMs, rows);
    });
    let changed = false;
    for (const [signalTimestampMs, rows] of grouped) {
      const cohortId = signalCohortId(this.strategyVersion, day.dateUtc, signalTimestampMs);
      let cohort = byId.get(cohortId);
      if (!cohort) {
        cohort = {
          cohortId,
          strategyVersion: this.strategyVersion,
          laneId: DAILY_RANGE_LANE_ID,
          selectorPolicyVersion: isAutoRouteStrategyVersion(this.strategyVersion)
            ? DAILY_RANGE_ECONOMIC_SELECTOR_POLICY_VERSION
            : DAILY_RANGE_SELECTOR_POLICY_VERSION,
          dateUtc: day.dateUtc,
          signalTimestamp: iso(signalTimestampMs),
          signalTimestampMs,
          observedAt: iso(this.nowMs()),
          finalizedAt: null,
          candidates: [],
          allocation: {
            allocatorMode: this.allocatorMode,
            selectorStatus: this.selectorStatus(),
            selectorId: this.selectorId,
            availableSlots: null,
            pendingReservationsAtBatch: 0,
            candidateCount: 0,
            longCandidateCount: 0,
            shortCandidateCount: 0,
            oversubscriptionRatio: null,
            batchComplete: false,
            selectedSignalIds: [],
            finalizedAt: null,
            allocationError: null,
          },
        };
        state.signalCohorts.push(cohort);
        byId.set(cohortId, cohort);
        changed = true;
      }
      // Passive legacy cohorts remain immutable evidence and cannot be upgraded
      // into an allocation authority after a restart.
      if (!cohort.allocation) continue;
      const knownSignals = new Set(cohort.candidates.map((candidate) => candidate.signalId));
      for (const { signal, executionSequence } of rows) {
        if (knownSignals.has(signal.signalId)) continue;
        cohort.candidates.push(this.candidateFromSignal(day, signal, executionSequence, cohort.candidates.length));
        knownSignals.add(signal.signalId);
        changed = true;
      }
      this.refreshBatchCounts(cohort);
    }
    if (!changed) return;
    if (state.signalCohorts.length > MAX_SIGNAL_COHORTS) {
      state.signalCohorts.splice(0, state.signalCohorts.length - MAX_SIGNAL_COHORTS);
    }
    this.store.save();
  }

  private refreshBatchCounts(cohort: DailyRangeSignalCohort): void {
    if (!cohort.allocation) return;
    cohort.allocation.candidateCount = cohort.candidates.length;
    cohort.allocation.longCandidateCount = cohort.candidates.filter((candidate) => candidate.direction === "LONG").length;
    cohort.allocation.shortCandidateCount = cohort.candidates.length - cohort.allocation.longCandidateCount;
  }

  /**
   * Freeze the mutable market-quality facts as close as the public BBO API can
   * observe them. This runs after the whole candle batch is known but before
   * allocation/entry. It never retries or overwrites a saved record: a failed
   * contemporaneous read is honest UNAVAILABLE evidence, not a reason to copy
   * a later quote into the old signal.
   */
  private async captureSignalTimeMarketQuality(
    day: DailyRangeDayState,
    signals: readonly DailyRangeSignal[],
    capturePhase: "FORWARD_BEFORE_ALLOCATION" | "RECOVERY_AFTER_ALLOCATION",
  ): Promise<void> {
    const missing = signals.filter((signal) => !this.researchFor(signal).marketQuality);
    if (missing.length === 0) return;
    await Promise.all(missing.map(async (signal) => {
      const research = this.researchFor(signal);
      if (research.marketQuality) return;
      const poolAudit = cloneCohortPoolAudit(day, signal.symbol);
      let bestBid: number | null = null;
      let bestAsk: number | null = null;
      let currentSpreadBps: number | null = null;
      let bookSourceTime: number | null = null;
      let bookObservedAt: string | null = null;
      let bookObservedAtMs: number | null = null;
      try {
        const book = await this.client.getBookTicker(signal.symbol);
        bestBid = book.bid;
        bestAsk = book.ask;
        bookSourceTime = book.time;
        bookObservedAtMs = this.nowMs();
        bookObservedAt = iso(bookObservedAtMs);
        currentSpreadBps = spreadBps(book);
      } catch {
        // Preserve a concrete absence at signal time; a later successful BBO
        // must not be written backward into this candidate.
      }
      const cohortPoolEvidence = cohortPoolEvidenceForSymbol(day, signal.symbol);
      const poolCapturedAtMs = toMs(cohortPoolEvidence?.capturedAt ?? null);
      const frozenPoolIsCausal = poolAudit !== null
        && poolCapturedAtMs !== null
        && poolCapturedAtMs <= signal.signalTimestampMs;
      const strictBookIsCausal = bookSourceTime !== null && bookSourceTime <= signal.signalTimestampMs;
      const bookIsAtDecision = bookObservedAtMs !== null
        && bookSourceTime !== null
        && bestBid !== null
        && bestBid > 0
        && bestAsk !== null
        && bestAsk > 0
        && bookSourceTime <= bookObservedAtMs + MAX_BOOK_SOURCE_FUTURE_SKEW_MS;
      const forwardDecisionBookIsCausal = capturePhase === "FORWARD_BEFORE_ALLOCATION" && bookIsAtDecision;
      const bookSnapshotQuality = bookObservedAt === null || bookSourceTime === null
        ? "UNAVAILABLE" as const
        : !bookIsAtDecision ? "FUTURE_OF_DECISION" as const
          : capturePhase === "RECOVERY_AFTER_ALLOCATION" ? "RECOVERY_AFTER_ALLOCATION" as const
            : strictBookIsCausal ? "STRICT_AT_OR_BEFORE_SIGNAL" as const
              : "AT_DECISION_BEFORE_ALLOCATION" as const;
      research.marketQuality = {
        capturedAt: iso(this.nowMs()),
        poolCapturedAt: cohortPoolEvidence?.capturedAt ?? null,
        pitQuality: frozenPoolIsCausal && forwardDecisionBookIsCausal
          ? "FULL_PIT"
          : poolAudit && bookIsAtDecision ? "PARTIAL_RECONSTRUCTION" : "UNAVAILABLE",
        capturePhase,
        bookSnapshotQuality,
        bookObservedAt,
        bookReceivedAt: bookObservedAt,
        bboEventTime: bookSourceTime !== null && Number.isFinite(bookSourceTime) ? iso(bookSourceTime) : null,
        bboReceivedAt: bookObservedAt,
        bookSourceTime,
        bestBid,
        bestAsk,
        quoteVolume24hUsd: poolAudit?.quoteVolume24hUsd ?? null,
        medianSpreadBps: poolAudit?.medianSpreadBps ?? null,
        currentSpreadBps,
        fiveMinuteData: poolAudit?.fiveMinuteData ?? null,
        fourHourData: poolAudit?.fourHourData ?? null,
        listedDays: poolAudit?.listedDays ?? null,
        c1Pass: cPass(poolAudit, "C1_"),
        c2Pass: cPass(poolAudit, "C2_"),
        c3Pass: cPass(poolAudit, "C3_"),
        c4Pass: cPass(poolAudit, "C4_"),
        c5Pass: cPass(poolAudit, "C5_"),
        c6Pass: cPass(poolAudit, "C6_"),
        poolAudit: poolAudit ? clonePoolAudit(poolAudit) : null,
        featureSnapshotAt: null,
        featureAgeMs: null,
      };
    }));
    this.store.save();
  }

  private batchIsComplete(day: DailyRangeDayState, cohort: DailyRangeSignalCohort): boolean {
    const candleOpenTime = cohort.signalTimestampMs - 1 - FIVE_MIN_MS;
    return Object.keys(day.levels).every((symbol) => (day.symbolStates[symbol]?.lastProcessedBarOpenTime ?? -1) >= candleOpenTime);
  }

  private allocationCapacity(): { slots: number; displaySlots: number; pendingReservations: number; maxOpenTrades: number } {
    const active = this.store.getState().trades.filter((trade) => !isTerminalTradeStatus(trade.status));
    const pendingReservations = active.filter((trade) => trade.status === "ENTRY_SUBMITTING" || trade.status === "ENTRY_RECONCILING").length;
    const controls = this.mainnetControls;
    const maxOpenTrades = this.environment === "mainnet"
      ? controls?.maxOpenTrades ?? 0
      : this.testnetMaxOpenTrades;
    const byCount = Math.max(0, maxOpenTrades - active.length);
    const byGross = this.environment === "mainnet"
      ? Math.max(0, Math.floor(((controls?.maxGrossNotionalUsd ?? 0) - active.length * DAILY_RANGE_TRADE_NOTIONAL_USD + EPSILON) / DAILY_RANGE_TRADE_NOTIONAL_USD))
      : Number.POSITIVE_INFINITY;
    const slots = Math.min(byCount, byGross);
    return { slots, displaySlots: slots, pendingReservations, maxOpenTrades };
  }

  /**
   * Re-arming creates a fresh observation boundary. A policy candidate generated
   * before that boundary must never be filled later from a durable cohort or
   * recovery path. Legacy records intentionally retain their historical
   * behavior; only the new route-specific policy gets this cutover guard.
   */
  private v1SignalArmEpochBlockReason(signal: DailyRangeSignal): DailyRangeSignalReason | null {
    if (!isDailyRangeRouteExitPolicy(signal.routeExitPolicy)) return null;
    const armedAt = toMs(this.store.getState().control.armedAt);
    const effectiveAt = toMs(signal.routeExitPolicy.effectiveAt) ?? signal.signalTimestampMs;
    if (armedAt !== null && Math.max(signal.signalTimestampMs, effectiveAt) < armedAt) {
      return "MISSED_SIGNAL_RECOVERY";
    }
    return null;
  }

  private batchCandidateBlockReason(signal: DailyRangeSignal): DailyRangeSignalReason | null {
    const state = this.store.getState();
    if (signal.strategyVersion !== this.strategyVersion) return "RETIRED_STRATEGY_VERSION";
    if (signal.executionEligible === false || this.isLiveContinuationShadow(signal)) {
      signal.routeExecutionEnabled = false;
      signal.executionEligible = false;
      return "LIVE_CONTINUATION_EXECUTION_DISABLED";
    }
    if (state.control.mode !== "ARMED") return "LANE_DISARMED";
    const mainnetBlock = this.mainnetControlBlockReason("entry");
    if (mainnetBlock) {
      return this.mainnetControls?.newEntryMode === "PAUSED_SELECTION_FIX"
        ? "LIVE_NEW_ENTRY_PAUSED"
        : "MAINNET_EXECUTION_DISABLED";
    }
    let accountGate: DailyRangeEntryGateDecision;
    try {
      accountGate = this.entryGate();
    } catch (error) {
      accountGate = { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!accountGate.allowed) return "ACCOUNT_ENTRY_BLOCKED";
    const symbolBlock = this.symbolEntryBlockReason(signal.symbol);
    if (symbolBlock) return symbolBlock;
    const armEpochBlock = this.v1SignalArmEpochBlockReason(signal);
    if (armEpochBlock) return armEpochBlock;
    if (!this.inEntryWindow(signal.signalTimestampMs)) return "OUTSIDE_ENTRY_WINDOW";
    if (this.nowMs() - signal.signalTimestampMs > MAX_FRESH_SIGNAL_AGE_MS) return "MISSED_SIGNAL_RECOVERY";
    if (!signal.confirmationBar1 || signal.reason === "STALE_DATA") return "STALE_DATA";
    if (signal.direction === "SHORT" && this.getShortBlocklist().has(signal.symbol)) return "SHORT_BLOCKED";
    if (this.store.hasActiveSymbolLease(signal.symbol)) return "LANE_POSITION_ALREADY_OPEN";
    return null;
  }

  private symbolEntryBlockReason(symbol: string): DailyRangeSignalReason | null {
    try {
      const decision = this.symbolEntryGate(symbol);
      if (decision.allowed) return null;
      console.log(`[daily-range-lane] SYMBOL_ENTRY_BLOCKED symbol=${normalizeSymbol(symbol)} reason=${decision.reason ?? "unspecified"}`);
      return "CROSS_SECTIONAL_PRIORITY_WINDOW";
    } catch (error) {
      console.warn(`[daily-range-lane] SYMBOL_ENTRY_GATE_UNAVAILABLE symbol=${normalizeSymbol(symbol)} error=${error instanceof Error ? error.message : String(error)}`);
      return "STRATEGY_SYMBOL_CONFLICT";
    }
  }

  private async batchExchangeBlockReason(signal: DailyRangeSignal): Promise<DailyRangeSignalReason | null> {
    try {
      const account = await this.readSymbolAccount(signal.symbol);
      return this.foreignAccountReason(signal.symbol, account) ? "STRATEGY_SYMBOL_CONFLICT" : null;
    } catch {
      return "ACCOUNT_STATE_UNKNOWN";
    }
  }

  private async finalizePendingSignalBatches(day: DailyRangeDayState): Promise<void> {
    const batches = this.store.getState().signalCohorts
      .filter((cohort) => cohort.strategyVersion === this.strategyVersion && cohort.dateUtc === day.dateUtc && cohort.allocation && cohort.allocation.finalizedAt === null)
      .sort((a, b) => a.signalTimestampMs - b.signalTimestampMs || a.cohortId.localeCompare(b.cohortId));
    for (const batch of batches) {
      if (!this.batchIsComplete(day, batch)) continue;
      await this.finalizeSignalBatch(batch);
    }
  }

  private alphaSnapshotForSignal(signal: DailyRangeSignal): DailyRangeAlphaSelectorSnapshot {
    const featureSnapshotAt = signal.research?.features?.capturedAt ?? null;
    const economics = signal.economics ?? null;
    if (this.allocatorMode === "SHADOW_ALPHA_SELECTOR" || this.allocatorMode === "SHADOW_SELECTOR" || this.allocatorMode === "ECONOMIC_QUALITY_BASELINE") {
      return {
        policyId: DAILY_RANGE_ALPHA_SELECTOR_POLICY_ID,
        selectorId: this.selectorId,
        status: "SHADOW_ONLY",
        pTp: null,
        expectedNetR: null,
        expectedNetUsd: null,
        tpMultipleR: economics?.tpMultipleR ?? null,
        netWinR: economics?.netWinR ?? null,
        netLossR: economics?.netLossR ?? null,
        breakEvenWinRate: economics?.breakEvenWinRate ?? null,
        reason: "ALPHA_SELECTOR_SHADOW_ONLY",
        featureSnapshotAt,
      };
    }
    return {
      policyId: DAILY_RANGE_ALPHA_SELECTOR_POLICY_ID,
      selectorId: this.selectorId,
      status: "FALLBACK_ECONOMIC",
      pTp: null,
      expectedNetR: null,
      expectedNetUsd: null,
      tpMultipleR: economics?.tpMultipleR ?? null,
      netWinR: economics?.netWinR ?? null,
      netLossR: economics?.netLossR ?? null,
      breakEvenWinRate: economics?.breakEvenWinRate ?? null,
      reason: "SELECTOR_NOT_READY",
      featureSnapshotAt,
    };
  }

  /**
   * Fetch enough strictly pre-decision 4h history to calculate ATR14.  The
   * pure calculator rejects an incomplete tail, so this helper never fills a
   * gap with a newer bar or an interpolation.
   */
  private async causalAtr4hForDecision(symbol: string, decisionAtMs: number): Promise<DailyRangeAtr4hFeature | null> {
    try {
      const rows = await this.client.getKlines(symbol, "4h", {
        startTime: Math.max(0, decisionAtMs - 128 * FOUR_HOURS_MS),
        endTime: decisionAtMs - 1,
        limit: 128,
      });
      return calculateCausalAtr14({ candles: rows, decisionAtMs });
    } catch {
      return null;
    }
  }

  /**
   * Fetch only completed 1h/4h candles ending strictly before the decision.
   * The same 4h payload supplies the legacy ATR diagnostic, so structural S/R
   * does not add a duplicate 4h read per candidate.  A missing history never
   * falls back to a synthetic fixed-R target.
   */
  private async causalStructuralContextForDecision(input: {
    signal: DailyRangeSignal;
    expectedEntry: number;
  }): Promise<{ target: DailyRangeStructuralTargetResolution; atr4hFeature: DailyRangeAtr4hFeature | null }> {
    const { signal, expectedEntry } = input;
    try {
      const decisionAtMs = signal.signalTimestampMs;
      const [oneHourRows, fourHourRows] = await Promise.all([
        this.client.getKlines(signal.symbol, "1h", {
          startTime: Math.max(0, decisionAtMs - 256 * 60 * 60_000),
          endTime: decisionAtMs - 1,
          limit: 256,
        }),
        this.client.getKlines(signal.symbol, "4h", {
          startTime: Math.max(0, decisionAtMs - 128 * FOUR_HOURS_MS),
          endTime: decisionAtMs - 1,
          limit: 128,
        }),
      ]);
      const target = resolveDailyRangeStructuralTarget({
        direction: signal.direction,
        route: signal.entryPolicy ?? "LEGACY_CONTINUATION",
        expectedEntry,
        rangeHigh: signal.rangeHigh,
        rangeLow: signal.rangeLow,
        referenceRangeCloseTime: signal.referenceRangeCloseTime,
        decisionAtMs,
        oneHourCandles: oneHourRows.map((row) => ({
          openTime: row.openTime,
          closeTime: row.closeTime,
          high: row.high,
          low: row.low,
          close: row.close,
        })),
        fourHourCandles: fourHourRows.map((row) => ({
          openTime: row.openTime,
          closeTime: row.closeTime,
          high: row.high,
          low: row.low,
          close: row.close,
        })),
      });
      return {
        target,
        atr4hFeature: calculateCausalAtr14({ candles: fourHourRows, decisionAtMs }),
      };
    } catch {
      return {
        target: { ok: false, reason: "STRUCTURAL_TARGET_UNAVAILABLE", candidatesConsidered: 0 },
        atr4hFeature: null,
      };
    }
  }

  private async finalizeSignalBatch(batch: DailyRangeSignalCohort): Promise<void> {
    const allocation = batch.allocation;
    if (!allocation || allocation.finalizedAt !== null) return;
    const lock = this.store.tryAcquireAllocatorLock(this.nowMs());
    if (!lock) {
      allocation.allocationError = "ALLOCATOR_AUTHORITY_BUSY";
      this.store.save();
      return;
    }
    const reservations: Array<{ signal: DailyRangeSignal; trade: DailyRangeTrade }> = [];
    try {
      const signals = new Map(this.store.getState().signals.map((signal) => [signal.signalId, signal]));
      const allocationAtMs = this.nowMs();
      const v3Batch = isAutoRouteStrategyVersion(batch.strategyVersion);
      const effectiveAllocatorMode = v3Batch ? this.effectiveAllocatorMode() : this.allocatorMode;
      const frictionModel = v3Batch
        ? this.frozenFrictionModelForSignalTimestamp(batch.signalTimestampMs) ?? this.ensureFrictionModel(batch.signalTimestampMs)
        : null;
      let filters: Map<string, FuturesSymbolFilters> | null = null;
      if (v3Batch) {
        try {
          filters = await this.client.getExchangeFilters();
        } catch {
          // A missing filter is handled as an unexecutable risk budget for every
          // candidate.  Never recover it from a later tick after a selection.
        }
      }
      const signalPoolEvidence = clonePoolEvidence(this.getSignalPoolEvidence(
        [...new Set(batch.candidates.map((candidate) => candidate.symbol))],
      ));
      const preflight = await Promise.all(batch.candidates.map(async (candidate) => {
        const signal = signals.get(candidate.signalId) ?? null;
        if (!signal) return { candidate, signal, block: "STALE_DATA" as DailyRangeSignalReason };
        if (v3Batch) {
          const quality = signal.research?.marketQuality ?? null;
          if (quality) {
            const featureSnapshotAt = signal.research?.features?.capturedAt ?? quality.featureSnapshotAt ?? null;
            quality.featureSnapshotAt = featureSnapshotAt;
            const featureSnapshotMs = toMs(featureSnapshotAt);
            quality.featureAgeMs = featureSnapshotMs === null
              ? null
              : Math.max(0, allocationAtMs - featureSnapshotMs);
          }
          const bbo = quality && quality.capturePhase === "FORWARD_BEFORE_ALLOCATION"
            && finitePositive(quality.bestBid) && finitePositive(quality.bestAsk) && quality.bookObservedAt
            ? {
              bid: quality.bestBid,
              ask: quality.bestAsk,
              observedAt: quality.bookObservedAt,
              sourceTime: quality.bookSourceTime,
              receivedAt: quality.bookReceivedAt ?? quality.bookObservedAt,
            }
            : null;
          const expectedEntry = bbo && frictionModel
            ? expectedDailyRangeEntryPrice({ side: signal.direction, bbo, frictionModel })
            : null;
          if (!frictionModel) {
            signal.economics = null;
            signal.geometry = null;
            signal.alphaSelector = this.alphaSnapshotForSignal(signal);
            candidate.economics = null;
            candidate.geometry = null;
            candidate.alphaSelector = signal.alphaSelector;
            return { candidate, signal, block: "FRICTION_MODEL_UNAVAILABLE" as DailyRangeSignalReason };
          }
          if (!expectedEntry) {
            signal.economics = null;
            signal.geometry = null;
            signal.alphaSelector = this.alphaSnapshotForSignal(signal);
            candidate.economics = null;
            candidate.geometry = null;
            candidate.alphaSelector = signal.alphaSelector;
            return { candidate, signal, block: "BBO_STALE" as DailyRangeSignalReason };
          }
          const structuralContext = await this.causalStructuralContextForDecision({ signal, expectedEntry });
          if (!structuralContext.target.ok) {
            signal.economics = null;
            signal.geometry = null;
            signal.alphaSelector = this.alphaSnapshotForSignal(signal);
            candidate.economics = null;
            candidate.geometry = null;
            candidate.alphaSelector = signal.alphaSelector;
            return { candidate, signal, block: structuralContext.target.reason as DailyRangeSignalReason };
          }
          const prepared = prepareDailyRangeEconomics({
            side: signal.direction,
            route: signal.entryPolicy ?? "LEGACY_CONTINUATION",
            symbol: signal.symbol,
            batchTimestampMs: batch.signalTimestampMs,
            rawStructuralStop: structuralStopForDailyRangeSignal(signal),
            stopSource: dailyRangeStructuralStopSource(signal.entryPolicy ?? "LEGACY_CONTINUATION"),
            structuralTarget: structuralContext.target.target,
            bbo,
            filter: filters?.get(signal.symbol) ?? null,
            frictionModel,
            bboMaxAgeMs: MAX_DECISION_BBO_AGE_MS,
            allocationAtMs,
            atr4hFeature: structuralContext.atr4hFeature,
          });
          signal.economics = prepared.ok ? prepared.economics : null;
          signal.geometry = prepared.ok ? prepared.economics.geometry : prepared.geometry ?? null;
          signal.alphaSelector = this.alphaSnapshotForSignal(signal);
          candidate.economics = signal.economics;
          candidate.geometry = signal.geometry;
          candidate.alphaSelector = signal.alphaSelector;
          candidate.selectorMode = this.allocatorMode;
          candidate.selectorId = this.selectorId;
          candidate.selectorScore = signal.alphaSelector.pTp;
          if (!prepared.ok) return { candidate, signal, block: prepared.reason as DailyRangeSignalReason };
          this.refreshCounterfactualWithStructuralEconomics(signal);
          if (this.isLiveContinuationShadow(signal)) {
            signal.routeExecutionEnabled = false;
            signal.executionEligible = false;
            candidate.routeExecutionEnabled = false;
            candidate.executionEligible = false;
            return { candidate, signal, block: "LIVE_CONTINUATION_EXECUTION_DISABLED" as DailyRangeSignalReason };
          }
          signal.routeExecutionEnabled = true;
          signal.executionEligible = true;
          candidate.routeExecutionEnabled = true;
          candidate.executionEligible = true;
        }
        const normalBlock = this.batchCandidateBlockReason(signal);
        if (normalBlock) return { candidate, signal, block: normalBlock };
        const poolAudit = signalPoolEvidence?.auditBySymbol[signal.symbol] ?? null;
        if (poolAudit?.failures.includes("C3_HARD_SPREAD")) {
          return { candidate, signal, block: "SPREAD_HARD_REJECT" as DailyRangeSignalReason };
        }
        return { candidate, signal, block: await this.batchExchangeBlockReason(signal) };
      }));
      const featureAges = batch.candidates
        .map((candidate) => signals.get(candidate.signalId)?.research?.marketQuality?.featureAgeMs ?? null)
        .filter(finiteNumber);
      allocation.minFeatureAgeMs = featureAges.length ? Math.min(...featureAges) : null;
      allocation.maxFeatureAgeMs = featureAges.length ? Math.max(...featureAges) : null;
      allocation.featureAgeSpreadMs = featureAges.length
        ? allocation.maxFeatureAgeMs! - allocation.minFeatureAgeMs!
        : null;
      const eligible: DailyRangeSignal[] = [];
      for (const { candidate, signal, block } of preflight) {
        if (!signal) continue;
        if (block) {
          signal.actuallySelected = false;
          signal.actuallyExecuted = false;
          candidate.skipReason = block;
          this.markSignal(signal, {
            eligible: false,
            reason: block,
            // A Live Continuation shadow row is a completed research decision,
            // not an attempted entry or an intent/reservation.
            recordAttempt: block !== "LIVE_CONTINUATION_EXECUTION_DISABLED",
          });
          continue;
        }
        eligible.push(signal);
      }
      const capacity = this.allocationCapacity();
      allocation.selectorStatus = this.selectorStatus();
      allocation.effectiveAllocatorMode = effectiveAllocatorMode;
      allocation.availableSlots = capacity.displaySlots;
      allocation.pendingReservationsAtBatch = capacity.pendingReservations;
      allocation.batchComplete = true;
      allocation.oversubscriptionRatio = capacity.displaySlots !== null && capacity.displaySlots > 0
        ? eligible.length / capacity.displaySlots
        : capacity.displaySlots === 0 && eligible.length > 0 ? Number.POSITIVE_INFINITY : null;
      if (v3Batch) {
        allocation.economicsPolicyId = DAILY_RANGE_EXECUTION_ECONOMICS_POLICY_ID;
        allocation.frictionModelId = frictionModel?.id ?? null;
        allocation.frictionModelSource = frictionModel?.source ?? null;
        allocation.allocationCutoffAt = iso(allocationAtMs);
      }

      const result = allocateDailyRangeBatch({
        mode: effectiveAllocatorMode,
        strategyVersion: batch.strategyVersion,
        batchTimestampMs: batch.signalTimestampMs,
        environment: this.environment,
        availableSlots: capacity.slots,
        candidates: eligible.map((signal) => ({
          signalId: signal.signalId,
          symbol: signal.symbol,
          legacySequence: batch.candidates.find((candidate) => candidate.signalId === signal.signalId)?.executionSequence ?? Number.MAX_SAFE_INTEGER,
          selectorScore: v3Batch ? signal.alphaSelector?.pTp ?? null : this.selectorId ? signal.selectorScore ?? null : null,
          selectorExpectedNetUsd: v3Batch ? signal.alphaSelector?.expectedNetUsd ?? null : null,
          economic: v3Batch && signal.economics ? {
            breakEvenWinRate: signal.economics.breakEvenWinRate,
            costRatio: signal.economics.costRatio,
            plannedRiskUsd: signal.economics.plannedRiskUsd,
            qualityTieBreakHash: signal.economics.qualityTieBreakHash,
          } : null,
        })),
      });
      const decisions = new Map(result.decisions.map((decision) => [decision.signalId, decision]));
      allocation.selectedSignalIds = result.decisions.filter((decision) => decision.selected).map((decision) => decision.signalId);
      for (const signal of eligible) {
        const decision = decisions.get(signal.signalId);
        if (!decision) continue;
        const candidate = batch.candidates.find((row) => row.signalId === signal.signalId);
        if (candidate) {
          candidate.tieBreakHash = decision.tieBreakHash;
          candidate.selectorMode = this.allocatorMode;
          candidate.selectorId = this.selectorId;
          candidate.selectorScore = decision.selectorScore;
          candidate.selectorRank = decision.selectorRank;
          candidate.economics = signal.economics ?? null;
          candidate.alphaSelector = signal.alphaSelector ?? null;
          candidate.actuallySelected = decision.selected;
          candidate.skipReason = decision.skipReason as DailyRangeSignalReason | null;
        }
        signal.selectorMode = this.allocatorMode;
        signal.selectorId = this.selectorId;
        signal.selectorScore = decision.selectorScore;
        signal.selectorRank = decision.selectorRank;
        signal.actuallySelected = decision.selected;
        signal.actuallyExecuted = false;
        if (!decision.selected) {
          this.markSignal(signal, { eligible: false, reason: decision.skipReason as DailyRangeSignalReason });
          continue;
        }
        const trade = this.createPendingTrade(signal, { persist: false });
        if (!trade) {
          this.markSignal(signal, { eligible: false, reason: "SELECTED_EXECUTION_FAILED" });
          continue;
        }
        reservations.push({ signal, trade });
      }
      allocation.finalizedAt = iso(this.nowMs());
      allocation.allocationError = null;
      // This is the allocation commit point: every selected slot is persisted
      // together before the first MARKET POST.  A crash before this write has no
      // reservation; a crash after it has the complete deterministic batch.
      this.store.save();
    } finally {
      lock.release();
    }
    // A selected order failure intentionally leaves its slot unused.  Lower rank
    // candidates are never promoted after a delay because that would corrupt
    // same-batch attribution.
    await Promise.all(reservations.map(({ signal, trade }) => this.executeReservedSignal(signal, trade)));
    this.syncSignalCohortDecisions();
  }

  private async executeReservedSignal(signal: DailyRangeSignal, trade: DailyRangeTrade): Promise<void> {
    const symbolBlock = this.symbolEntryBlockReason(signal.symbol);
    if (symbolBlock) {
      this.abortTrade(trade, "ENTRY_ABORT_ACCOUNT_CONFLICT", "symbol entry priority changed after batch reservation");
      this.markSignal(signal, { eligible: false, reason: symbolBlock, tradeId: trade.tradeId });
      return;
    }
    if (!this.entryClaims.tryClaimEntrySymbol(signal.symbol, DAILY_RANGE_LANE_ID)) {
      this.abortTrade(trade, "ENTRY_ABORT_SYMBOL_IN_FLIGHT", "shared in-flight symbol claim is held by another lane");
      this.markSignal(signal, { eligible: false, reason: "SELECTED_EXECUTION_FAILED", tradeId: trade.tradeId });
      return;
    }
    try {
      await this.submitTradeEntry(trade, signal);
      signal.actuallyExecuted = trade.entryOrderId !== null;
      if (isTerminalTradeStatus(trade.status) && trade.status !== "CLOSED") {
        this.markSignal(signal, { eligible: false, reason: "SELECTED_EXECUTION_FAILED", tradeId: trade.tradeId });
      } else {
        this.store.save();
      }
    } catch (error) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", error instanceof Error ? error.message : String(error));
      this.markSignal(signal, { eligible: false, reason: "SELECTED_EXECUTION_FAILED", tradeId: trade.tradeId });
    } finally {
      this.entryClaims.releaseEntrySymbol(signal.symbol, DAILY_RANGE_LANE_ID);
    }
  }

  /** Rejoins persisted decisions/research after allocation, safe across restarts. */
  private syncSignalCohortDecisions(): void {
    const state = this.store.getState();
    if (state.signalCohorts.length === 0) return;
    const signals = new Map(state.signals.map((signal) => [signal.signalId, signal]));
    let changed = false;
    for (const cohort of state.signalCohorts) {
      let complete = true;
      for (const candidate of cohort.candidates) {
        const signal = signals.get(candidate.signalId);
        const decision = signal && (signal.entryAttemptedAt !== null || signal.reason !== null || signal.tradeId !== null)
          ? {
            entryEligible: signal.entryEligible,
            reason: signal.reason,
            tradeId: signal.tradeId,
            entryAttemptedAt: signal.entryAttemptedAt,
          }
          : null;
        const next = signal ? {
          marketQuality: signal.research?.marketQuality ?? null,
          features: signal.research?.features ?? null,
          counterfactual: signal.research?.counterfactual ?? null,
          selectorMode: signal.selectorMode ?? candidate.selectorMode,
          selectorId: signal.selectorId ?? candidate.selectorId ?? null,
          selectorScore: signal.selectorScore ?? null,
          selectorRank: signal.selectorRank ?? null,
          economics: signal.economics ?? null,
          routeExecutionEnabled: signal.routeExecutionEnabled ?? true,
          executionEligible: signal.executionEligible ?? true,
          alphaSelector: signal.alphaSelector ?? null,
          actuallySelected: signal.actuallySelected ?? false,
          actuallyExecuted: signal.actuallyExecuted ?? false,
          skipReason: signal.reason,
        } : null;
        if (JSON.stringify(candidate.decision) !== JSON.stringify(decision)) {
          candidate.decision = decision;
          changed = true;
        }
        if (next && JSON.stringify({
          marketQuality: candidate.marketQuality ?? null,
          features: candidate.features ?? null,
          counterfactual: candidate.counterfactual ?? null,
          selectorMode: candidate.selectorMode,
          selectorId: candidate.selectorId ?? null,
          selectorScore: candidate.selectorScore ?? null,
          selectorRank: candidate.selectorRank ?? null,
          economics: candidate.economics ?? null,
          routeExecutionEnabled: candidate.routeExecutionEnabled ?? true,
          executionEligible: candidate.executionEligible ?? true,
          alphaSelector: candidate.alphaSelector ?? null,
          actuallySelected: candidate.actuallySelected ?? false,
          actuallyExecuted: candidate.actuallyExecuted ?? false,
          skipReason: candidate.skipReason ?? null,
        }) !== JSON.stringify(next)) {
          candidate.marketQuality = next.marketQuality;
          candidate.features = next.features;
          candidate.counterfactual = next.counterfactual;
          candidate.selectorMode = next.selectorMode;
          candidate.selectorId = next.selectorId;
          candidate.selectorScore = next.selectorScore;
          candidate.selectorRank = next.selectorRank;
          candidate.economics = next.economics;
          candidate.routeExecutionEnabled = next.routeExecutionEnabled;
          candidate.executionEligible = next.executionEligible;
          candidate.alphaSelector = next.alphaSelector;
          candidate.actuallySelected = next.actuallySelected;
          candidate.actuallyExecuted = next.actuallyExecuted;
          candidate.skipReason = next.skipReason;
          changed = true;
        }
        if (decision === null) complete = false;
      }
      const nextFinalizedAt = complete ? cohort.finalizedAt ?? iso(this.nowMs()) : null;
      if (cohort.finalizedAt !== nextFinalizedAt) {
        cohort.finalizedAt = nextFinalizedAt;
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  private researchFor(signal: DailyRangeSignal): DailyRangeSignalResearchRecord {
    if (!signal.research) signal.research = { marketQuality: null, features: null, counterfactual: null };
    return signal.research;
  }

  private async capturePendingResearchSnapshots(
    day: DailyRangeDayState,
    phase: "FORWARD_BEFORE_ALLOCATION" | "RECOVERY_AFTER_ALLOCATION" = "RECOVERY_AFTER_ALLOCATION",
  ): Promise<void> {
    const batches = this.store.getState().signalCohorts
      .filter((batch) => batch.strategyVersion === this.strategyVersion && batch.dateUtc === day.dateUtc && batch.allocation && (
        phase === "FORWARD_BEFORE_ALLOCATION"
          ? batch.allocation.finalizedAt === null
          : batch.allocation.batchComplete
      ))
      .sort((a, b) => a.signalTimestampMs - b.signalTimestampMs || a.cohortId.localeCompare(b.cohortId));
    for (const batch of batches) {
      const signals = batch.candidates
        .map((candidate) => this.store.findSignal(candidate.signalId))
        .filter((signal): signal is DailyRangeSignal => signal !== null);
      if (signals.length === 0) continue;
      // Recovery reads can document an absence but never upgrade an old batch
      // to a causal decision observation. Normal flow already captured BBO
      // before this pre-allocation feature pass.
      if (phase === "RECOVERY_AFTER_ALLOCATION") {
        await this.captureSignalTimeMarketQuality(day, signals, "RECOVERY_AFTER_ALLOCATION");
      }
      const needsCapture = signals.some((signal) => {
        const research = signal.research;
        const awaitingStructuralDecision = signal.routeExitPolicy?.targetPolicyId === DAILY_RANGE_NEXT_SR_TARGET_POLICY_ID
          && !signal.economics;
        return !research?.marketQuality || !research.features || (!research?.counterfactual && !awaitingStructuralDecision);
      });
      if (!needsCapture) continue;

      const candleEnd = batch.signalTimestampMs - 1;
      const candleStart = candleEnd - 60 * FIVE_MIN_MS;
      const universeSymbols = Object.keys(day.levels);
      const histories = new Map<string, DailyRangeCandle[]>();
      await Promise.all(universeSymbols.map(async (symbol) => {
        try {
          const rows = await this.client.getKlines(symbol, "5m", { startTime: candleStart, endTime: candleEnd, limit: 100 });
          histories.set(symbol, rows.map(asDailyCandle).filter((row) => row.closeTime <= candleEnd).sort((a, b) => a.openTime - b.openTime));
        } catch {
          histories.set(symbol, []);
        }
      }));
      const [btcCandles, ethCandles, filters] = await Promise.all([
        this.readResearchCandles("BTCUSDT", candleStart, candleEnd),
        this.readResearchCandles("ETHUSDT", candleStart, candleEnd),
        this.readResearchFilters(),
      ]);
      const oneHourReturns = [...histories.values()].map((candles) => returnOverBars(candles, 12)).filter(finiteNumber);
      const universePositive1hPct = oneHourReturns.length > 0
        ? oneHourReturns.filter((value) => value > 0).length / oneHourReturns.length
        : null;
      const universeNegative1hPct = oneHourReturns.length > 0
        ? oneHourReturns.filter((value) => value < 0).length / oneHourReturns.length
        : null;

      await Promise.all(signals.map(async (signal) => {
        const research = this.researchFor(signal);
        if (!research.features) {
          const reference = await this.readReferenceFourHour(signal, day);
          research.features = this.buildFeatureSnapshot({
            signal,
            candles: histories.get(signal.symbol) ?? [],
            reference,
            btcCandles,
            ethCandles,
            universePositive1hPct,
            universeNegative1hPct,
          });
        }
        if (research.marketQuality) {
          research.marketQuality.featureSnapshotAt = research.features?.capturedAt ?? null;
        }
        // A Structural S/R counterfactual cannot exist before the same-batch
        // BBO, target and risk plan are frozen.  Do not manufacture a 0R
        // placeholder that could falsely mature at entry price.
        if (!research.counterfactual
          && !(signal.routeExitPolicy?.targetPolicyId === DAILY_RANGE_NEXT_SR_TARGET_POLICY_ID && !signal.economics)) {
          research.counterfactual = this.initializeCounterfactual(signal, filters?.get(signal.symbol) ?? null);
        }
      }));
      this.store.save();
    }
    this.syncSignalCohortDecisions();
  }

  private async readResearchCandles(symbol: string, startTime: number, endTime: number): Promise<DailyRangeCandle[]> {
    try {
      const rows = await this.client.getKlines(symbol, "5m", { startTime, endTime, limit: 100 });
      return rows.map(asDailyCandle).filter((row) => row.closeTime <= endTime).sort((a, b) => a.openTime - b.openTime);
    } catch {
      return [];
    }
  }

  private async readResearchFilters(): Promise<Map<string, FuturesSymbolFilters> | null> {
    try {
      return await this.client.getExchangeFilters();
    } catch {
      return null;
    }
  }

  private async readReferenceFourHour(signal: DailyRangeSignal, day: DailyRangeDayState): Promise<DailyRangeCandle[]> {
    const level = day.levels[signal.symbol];
    if (!level) return [];
    try {
      if (isAutoRouteStrategyVersion(signal.strategyVersion)) {
        const startTime = signal.referenceRangeOpenTime ?? level.fourHourOpenTime;
        const endTime = signal.referenceRangeCloseTime ?? level.fourHourCloseTime;
        const rows = await this.client.getKlines(signal.symbol, "5m", {
          startTime,
          endTime: endTime - 1,
          limit: 100,
        });
        const candles = rows.map(asDailyCandle)
          .filter((row) => row.openTime >= startTime && row.closeTime < endTime)
          .sort((left, right) => left.openTime - right.openTime);
        if (candles.length === 0 || !contiguousFiveMinuteBars(candles)) return [];
        return [{
          openTime: startTime,
          closeTime: endTime - 1,
          open: candles[0]!.open,
          high: Math.max(...candles.map((row) => row.high)),
          low: Math.min(...candles.map((row) => row.low)),
          close: candles.at(-1)!.close,
          volume: candles.reduce((sum, row) => sum + row.volume, 0),
        }];
      }
      const rows = await this.client.getKlines(signal.symbol, "4h", {
        startTime: level.fourHourOpenTime - 7 * FOUR_HOURS_MS,
        endTime: level.fourHourCloseTime - 1,
        limit: 8,
      });
      return rows.map(asDailyCandle).filter((row) => row.closeTime <= level.fourHourCloseTime - 1).sort((a, b) => a.openTime - b.openTime);
    } catch {
      return [];
    }
  }

  private buildFeatureSnapshot(input: {
    signal: DailyRangeSignal;
    candles: DailyRangeCandle[];
    reference: DailyRangeCandle[];
    btcCandles: DailyRangeCandle[];
    ethCandles: DailyRangeCandle[];
    universePositive1hPct: number | null;
    universeNegative1hPct: number | null;
  }): DailyRangeSignalFeatureSnapshot {
    const { signal, candles, reference } = input;
    const rangeWidth = signal.rangeHigh - signal.rangeLow;
    const boundary = breakoutBoundaryForSignal(signal);
    const extension = (candle: DailyRangeCandle): number => breakoutExtensionForSignal(signal, candle);
    const c1ExtensionPrice = extension(signal.confirmationBar1 ?? signal.confirmationBar2);
    const c2ExtensionPrice = extension(signal.confirmationBar2);
    const atr14 = atr(candles, 14);
    const c1Baseline = (lookback: number): number | null => {
      const index = candles.findIndex((row) => row.openTime === (signal.confirmationBar1?.openTime ?? -1));
      const rows = index >= lookback ? candles.slice(index - lookback, index + 1) : [];
      return contiguousFiveMinuteBars(rows) ? medianNumber(rows.slice(0, -1).map((row) => row.volume)) : null;
    };
    const combinedRelative = (lookback: number): number | null => {
      const baseline = c1Baseline(lookback);
      const c1 = signal.confirmationBar1?.volume ?? null;
      return c1 === null ? null : ratio(c1 + signal.confirmationBar2.volume, baseline === null ? null : 2 * baseline);
    };
    const referenceStart = signal.referenceRangeOpenTime ?? utcDayStartMs(signal.signalTimestampMs);
    const referenceCandle = reference.find((row) => row.openTime === referenceStart) ?? null;
    const referenceRange = referenceCandle ? referenceCandle.high - referenceCandle.low : null;
    const referenceBody = referenceCandle && referenceRange && referenceRange > EPSILON
      ? Math.abs(referenceCandle.close - referenceCandle.open) / referenceRange
      : null;
    const upperWick = referenceCandle && referenceRange && referenceRange > EPSILON
      ? (referenceCandle.high - Math.max(referenceCandle.open, referenceCandle.close)) / referenceRange
      : null;
    const lowerWick = referenceCandle && referenceRange && referenceRange > EPSILON
      ? (Math.min(referenceCandle.open, referenceCandle.close) - referenceCandle.low) / referenceRange
      : null;
    const referenceIndex = referenceCandle ? reference.findIndex((row) => row.openTime === referenceCandle.openTime) : -1;
    const priorReferenceMedian = referenceIndex >= 3
      ? medianNumber(reference.slice(Math.max(0, referenceIndex - 6), referenceIndex).map((row) => row.volume))
      : null;
    const return1h = returnOverBars(candles, 12);
    const return4h = returnOverBars(candles, 48);
    const btcReturn1h = returnOverBars(input.btcCandles, 12);
    const btcReturn4h = returnOverBars(input.btcCandles, 48);
    const ownHistory = candles.filter((row) => row.openTime <= signal.confirmationBar2.openTime);
    const btcHistory = input.btcCandles.filter((row) => row.openTime <= signal.confirmationBar2.openTime);
    const ethHistory = input.ethCandles.filter((row) => row.openTime <= signal.confirmationBar2.openTime);
    const hasFullOwnHistory = ownHistory.at(-1)?.openTime === signal.confirmationBar2.openTime
      && contiguousFiveMinuteBars(ownHistory.slice(-49));
    const hasFullBtcHistory = btcHistory.at(-1)?.openTime === signal.confirmationBar2.openTime
      && contiguousFiveMinuteBars(btcHistory.slice(-49));
    const hasFullEthHistory = ethHistory.at(-1)?.openTime === signal.confirmationBar2.openTime
      && contiguousFiveMinuteBars(ethHistory.slice(-49));
    return {
      schemaVersion: 1,
      capturedAt: iso(this.nowMs()),
      sourceBarCloseTime: signal.confirmationBar2.closeTime,
      pitQuality: hasFullOwnHistory && hasFullBtcHistory && hasFullEthHistory ? "FULL_PIT" : "UNAVAILABLE",
      breakout: {
        boundary,
        c1ExtensionPrice,
        c2ExtensionPrice,
        c1ExtensionOfRange: rangeWidth > EPSILON ? c1ExtensionPrice / rangeWidth : null,
        c2ExtensionOfRange: rangeWidth > EPSILON ? c2ExtensionPrice / rangeWidth : null,
        c2ExtensionOfAtr: ratio(c2ExtensionPrice, atr14),
        c2ExtensionPct: ratio(c2ExtensionPrice, signal.confirmationBar2.close),
        atr14,
        realizedVolatility: realizedVolatility(candles, 24),
      },
      relativeVolume: {
        confirmation1: signal.confirmationBar1?.volume ?? null,
        confirmation2: signal.confirmationBar2.volume,
        c1Vs12: signal.confirmationBar1 ? relativeVolumeFor(candles, signal.confirmationBar1.openTime, 12) : null,
        c1Vs24: signal.confirmationBar1 ? relativeVolumeFor(candles, signal.confirmationBar1.openTime, 24) : null,
        c1Vs36: signal.confirmationBar1 ? relativeVolumeFor(candles, signal.confirmationBar1.openTime, 36) : null,
        c2Vs12: relativeVolumeFor(candles, signal.confirmationBar2.openTime, 12),
        c2Vs24: relativeVolumeFor(candles, signal.confirmationBar2.openTime, 24),
        c2Vs36: relativeVolumeFor(candles, signal.confirmationBar2.openTime, 36),
        combinedVs12: combinedRelative(12),
        combinedVs24: combinedRelative(24),
        combinedVs36: combinedRelative(36),
      },
      trend: {
        return1h,
        return4h,
        sideAlignedReturn1h: sideAlignedReturn(return1h, signal.direction),
        sideAlignedReturn4h: sideAlignedReturn(return4h, signal.direction),
        sideAligned1h: sideAligned(return1h, signal.direction),
        sideAligned4h: sideAligned(return4h, signal.direction),
      },
      rangeQuality: {
        rangeWidthOfPrice: ratio(rangeWidth, signal.confirmationBar2.close),
        rangeWidthOfAtr: ratio(rangeWidth, atr14),
        referenceBodyOfRange: referenceBody,
        upperWickPct: upperWick,
        lowerWickPct: lowerWick,
        referenceVolume: referenceCandle?.volume ?? null,
        referenceVolumeVsRecent: ratio(referenceCandle?.volume ?? null, priorReferenceMedian),
      },
      marketRegime: {
        btcReturn1h,
        btcReturn4h,
        ethReturn1h: returnOverBars(input.ethCandles, 12),
        ethReturn4h: returnOverBars(input.ethCandles, 48),
        btcSideAligned1h: sideAligned(btcReturn1h, signal.direction),
        btcSideAligned4h: sideAligned(btcReturn4h, signal.direction),
        universePositive1hPct: input.universePositive1hPct,
        universeNegative1hPct: input.universeNegative1hPct,
      },
    };
  }

  private initializeCounterfactual(signal: DailyRangeSignal, filter: FuturesSymbolFilters | null): DailyRangeCounterfactualOutcome {
    const entryPrice = signal.confirmationBar2.close;
    const routeExitPolicy = signal.routeExitPolicy ?? null;
    const tpMultipleR = routeExitPolicy?.tpMultipleR ?? DAILY_RANGE_RR;
    const structuralStop = structuralStopForDailyRangeSignal({
      ...signal,
      confirmationBar1: signal.confirmationBar1 ?? signal.confirmationBar2,
    });
    const rounded = filter ? roundDailyRangeBracket({
      direction: signal.direction,
      entry: entryPrice,
      rawStop: structuralStop,
      tickSize: filter.tickSize,
      tpMultipleR,
    }) : null;
    const risk = signal.direction === "LONG" ? entryPrice - (rounded?.stop ?? structuralStop) : (rounded?.stop ?? structuralStop) - entryPrice;
    const takeProfit = rounded?.takeProfit ?? (signal.direction === "LONG"
      ? entryPrice + tpMultipleR * risk
      : entryPrice - tpMultipleR * risk);
    const quantity = filter ? clampQty(DAILY_RANGE_TRADE_NOTIONAL_USD / entryPrice, filter) : null;
    return {
      status: "PENDING",
      entryConvention: signal.strategyVersion === DAILY_RANGE_AUTO_ROUTE_V3_STRATEGY_VERSION
        ? "AUTO_ROUTE_5M_CLOSE_PIT_V3"
        : signal.strategyVersion === DAILY_RANGE_AUTO_ROUTE_STRATEGY_VERSION
          ? "AUTO_ROUTE_5M_CLOSE_PIT_V2"
          : "C2_CLOSE_PIT_CANONICAL_V1",
      entryPrice,
      structuralStop: rounded?.stop ?? structuralStop,
      takeProfit,
      exitPolicyId: routeExitPolicy?.exitPolicyId ?? "legacy-global-2r-bracket",
      tpMultipleR,
      thesisInvalidationType: routeExitPolicy?.thesisInvalidationType ?? null,
      tickSize: filter?.tickSize ?? null,
      quantity,
      modeledEntryFeeBps: RESEARCH_ENTRY_FEE_BPS,
      modeledExitFeeBps: RESEARCH_EXIT_FEE_BPS,
      modeledSlippageBps: RESEARCH_SLIPPAGE_BPS,
      startedAt: signal.signalTimestamp,
      lastCheckedBarOpenTime: null,
      maturedAt: null,
      grossR: null,
      netModeledR: null,
      grossPnlUsd: null,
      netModeledPnlUsd: null,
      mfePct: null,
      maePct: null,
      holdingDurationMs: null,
      ambiguityReason: null,
    };
  }

  /**
   * A new Structural S/R candidate is born before its BBO/economics plan is
   * frozen, so the forward research collector initially has only the legacy
   * C2-close placeholder.  Replace that untouched placeholder exactly once
   * before the batch allocation/maturation phase; never rewrite a labelled or
   * partially observed historical outcome.
   */
  private refreshCounterfactualWithStructuralEconomics(signal: DailyRangeSignal): void {
    const economics = signal.economics;
    const research = this.researchFor(signal);
    if (!research.counterfactual && economics?.structurePolicyId === DAILY_RANGE_STRUCTURAL_SR_POLICY_ID) {
      research.counterfactual = this.initializeCounterfactual(signal, null);
    }
    const outcome = research.counterfactual;
    if (!economics
      || economics.structurePolicyId !== DAILY_RANGE_STRUCTURAL_SR_POLICY_ID
      || !outcome
      || outcome.status !== "PENDING"
      || outcome.lastCheckedBarOpenTime !== null) return;
    outcome.entryConvention = "STRUCTURAL_BBO_PIT_V1";
    outcome.entryPrice = economics.expectedEntryPrice;
    outcome.structuralStop = economics.expectedStopPrice;
    outcome.takeProfit = economics.expectedTakeProfitPrice;
    outcome.exitPolicyId = signal.routeExitPolicy?.exitPolicyId ?? null;
    outcome.tpMultipleR = economics.grossStructuralRR;
    outcome.thesisInvalidationType = signal.routeExitPolicy?.thesisInvalidationType ?? null;
    outcome.quantity = economics.requestedQty;
  }

  private async matureCounterfactualOutcomes(): Promise<void> {
    const pending = this.store.getState().signals
      .filter((signal) => signal.research?.counterfactual?.status === "PENDING")
      .sort((a, b) => a.signalTimestampMs - b.signalTimestampMs)
      .slice(0, MAX_COUNTERFACTUAL_MATURATION_PER_TICK);
    if (pending.length === 0) return;
    const now = this.nowMs();
    const lastCompletedMinuteOpen = Math.floor(now / 60_000) * 60_000 - 60_000;
    if (lastCompletedMinuteOpen < 0) return;
    await Promise.all(pending.map(async (signal) => {
      const outcome = signal.research?.counterfactual;
      if (!outcome || outcome.status !== "PENDING") return;
      try {
        const startTime = outcome.lastCheckedBarOpenTime ?? signal.signalTimestampMs;
        const rows = await this.client.getKlines(signal.symbol, "1m", {
          startTime,
          endTime: lastCompletedMinuteOpen + 60_000 - 1,
          limit: 1_500,
        });
        const candles = rows.map(asDailyCandle).filter((row) => row.closeTime < now).sort((a, b) => a.openTime - b.openTime);
        let mfe = outcome.mfePct ?? Number.NEGATIVE_INFINITY;
        let mae = outcome.maePct ?? Number.POSITIVE_INFINITY;
        for (const candle of candles) {
          const favorable = signal.direction === "LONG"
            ? (candle.high - outcome.entryPrice) / outcome.entryPrice
            : (outcome.entryPrice - candle.low) / outcome.entryPrice;
          const adverse = signal.direction === "LONG"
            ? (candle.low - outcome.entryPrice) / outcome.entryPrice
            : (outcome.entryPrice - candle.high) / outcome.entryPrice;
          mfe = Math.max(mfe, favorable);
          mae = Math.min(mae, adverse);
          const tpHit = signal.direction === "LONG" ? candle.high >= outcome.takeProfit : candle.low <= outcome.takeProfit;
          const slHit = signal.direction === "LONG" ? candle.low <= outcome.structuralStop : candle.high >= outcome.structuralStop;
          if (!tpHit && !slHit) continue;
          outcome.mfePct = Number.isFinite(mfe) ? mfe : null;
          outcome.maePct = Number.isFinite(mae) ? mae : null;
          outcome.maturedAt = iso(candle.closeTime + 1);
          outcome.holdingDurationMs = Math.max(0, candle.closeTime + 1 - signal.signalTimestampMs);
          if (tpHit && slHit) {
            outcome.status = "OUTCOME_AMBIGUOUS";
            outcome.ambiguityReason = "1m OHLC touched SL and TP in the same candle; sequence is not provable";
            return;
          }
          const exitPrice = tpHit ? outcome.takeProfit : outcome.structuralStop;
          const riskPrice = Math.abs(outcome.entryPrice - outcome.structuralStop);
          const grossR = riskPrice > EPSILON
            ? (signal.direction === "LONG" ? exitPrice - outcome.entryPrice : outcome.entryPrice - exitPrice) / riskPrice
            : null;
          outcome.status = tpHit ? "MATURE_TP" : "MATURE_SL";
          outcome.grossR = grossR;
          if (outcome.quantity !== null) {
            const grossPnl = (signal.direction === "LONG" ? exitPrice - outcome.entryPrice : outcome.entryPrice - exitPrice) * outcome.quantity;
            const fees = (outcome.entryPrice + exitPrice) * outcome.quantity * (outcome.modeledEntryFeeBps + outcome.modeledExitFeeBps) / 10_000;
            outcome.grossPnlUsd = grossPnl;
            outcome.netModeledPnlUsd = grossPnl - fees;
            const riskUsd = riskPrice * outcome.quantity;
            outcome.netModeledR = riskUsd > EPSILON ? (grossPnl - fees) / riskUsd : null;
          }
          return;
        }
        if (Number.isFinite(mfe)) outcome.mfePct = mfe;
        if (Number.isFinite(mae)) outcome.maePct = mae;
        const last = candles.at(-1);
        if (last) outcome.lastCheckedBarOpenTime = last.openTime + 60_000;
      } catch {
        // A temporary public-data failure leaves PENDING intact; no future label is fabricated.
      }
    }));
    this.store.save();
    this.syncSignalCohortDecisions();
  }

  private markSignal(signal: DailyRangeSignal, input: {
    eligible: boolean;
    reason: DailyRangeSignalReason | null;
    tradeId?: string | null;
    /** False for intentionally non-executable research/shadow decisions. */
    recordAttempt?: boolean;
  }): void {
    signal.entryEligible = input.eligible;
    signal.reason = input.reason;
    if (input.tradeId !== undefined) signal.tradeId = input.tradeId;
    if (input.recordAttempt !== false) signal.entryAttemptedAt = iso(this.nowMs());
    this.store.save();
  }

  private createPendingTrade(signal: DailyRangeSignal, options: { persist?: boolean } = {}): DailyRangeTrade | null {
    if (!signal.confirmationBar1 || signal.executionEligible === false || this.isLiveContinuationShadow(signal)) return null;
    // The normal AUTO_ROUTE_V2 allocator only reaches this constructor after it
    // persisted a V3 economic plan. The defensive legacy fallback below exists
    // solely for historical fixtures/reconciliation paths, not a public entry
    // route, so older durable records remain readable.
    const tradeId = tradeIdFromSignal(signal);
    const rawStop = signal.economics?.rawStructuralStop ?? structuralStopForDailyRangeSignal(signal);
    if (!finitePositive(rawStop)) return null;
    const trade: DailyRangeTrade = {
      tradeId,
      signalId: signal.signalId,
      strategyVersion: signal.strategyVersion,
      laneId: DAILY_RANGE_LANE_ID,
      dateUtc: signal.dateUtc,
      symbol: signal.symbol,
      direction: signal.direction,
      status: "ENTRY_SUBMITTING",
      entryOrderId: null,
      entryClientOrderId: entryClientId(tradeId),
      signalTimestamp: signal.signalTimestamp,
      entrySubmittedAt: iso(this.nowMs()),
      entryFilledAt: null,
      entryFillPrice: null,
      entryQty: null,
      entryFillCount: null,
      requestedQty: signal.economics?.requestedQty ?? null,
      entryNotionalUsd: null,
      entrySlippageBps: null,
      signalReferencePrice: signal.economics
        ? signal.direction === "LONG" ? signal.economics.decisionAsk : signal.economics.decisionBid
        : null,
      economics: signal.economics ?? null,
      geometry: signal.geometry ?? signal.economics?.geometry ?? null,
      alphaSelector: signal.alphaSelector ?? null,
      actualStopRiskBps: null,
      actualCostRatio: null,
      actualInitialRiskUsd: null,
      actualEffectiveLossUsd: null,
      postFillEconomicsStatus: null,
      postFillGeometryStatus: null,
      geometryMigration: null,
      rangeHigh: signal.rangeHigh,
      rangeLow: signal.rangeLow,
      entryPolicy: signal.entryPolicy ?? "LEGACY_CONTINUATION",
      entryTiming: signal.entryTiming ?? null,
      breakoutDirection: signal.breakoutDirection ?? null,
      breakoutId: signal.breakoutId ?? null,
      breakoutExtreme: signal.breakoutExtreme ?? null,
      referenceTimezone: signal.referenceTimezone ?? "UTC",
      referenceRangeOpenTime: signal.referenceRangeOpenTime ?? null,
      referenceRangeCloseTime: signal.referenceRangeCloseTime ?? null,
      routeExitPolicy: signal.routeExitPolicy ?? null,
      lastThesisInvalidationBarOpenTime: signal.routeExitPolicy ? signal.confirmationBar2.openTime : null,
      thesisInvalidation: null,
      confirmationBar1: signal.confirmationBar1,
      confirmationBar2: signal.confirmationBar2,
      structuralStopRaw: rawStop,
      structuralTargetRaw: signal.economics?.rawStructuralTarget ?? null,
      stopPrice: null,
      takeProfitRaw: null,
      takeProfitPrice: null,
      oldPolicyTakeProfitPrice: null,
      initialRiskPrice: null,
      initialRiskPct: null,
      initialRiskDollar: null,
      rrTarget: signal.economics?.grossStructuralRR ?? signal.routeExitPolicy?.tpMultipleR ?? DAILY_RANGE_RR,
      stopAlgoOrderId: null,
      stopClientAlgoId: algoClientId(tradeId, "sl"),
      takeProfitAlgoOrderId: null,
      takeProfitClientAlgoId: algoClientId(tradeId, "tp"),
      exitOrderId: null,
      exitClientOrderId: null,
      exitReason: null,
      exitTimestamp: null,
      exitPrice: null,
      exitReferencePrice: null,
      exitSlippageBps: null,
      grossPnlUsd: null,
      feesUsd: null,
      entryFeesUsd: null,
      exitFeesUsd: null,
      exitFillCount: null,
      feeEvidence: null,
      fundingUsd: null,
      netPnlUsd: null,
      grossR: null,
      realizedR: null,
      mfePct: null,
      maePct: null,
      mfeR: null,
      maeR: null,
      mfePrice: null,
      mfeEventTime: null,
      maePrice: null,
      maeEventTime: null,
      lastPathPrice: null,
      lastPathEventTime: null,
      lastPathReceivedAt: null,
      pathSource: null,
      pathQuality: null,
      pathStreamStartedAt: null,
      pathGapReason: null,
      pathFrozenAt: null,
      pathRecoveryAt: null,
      pathRecoveryReason: null,
      fadeMfe: (signal.entryPolicy ?? "LEGACY_CONTINUATION") === "FADE"
        ? createDailyRangeFadeMfeState(iso(this.nowMs()))
        : null,
      fadeMfeCounterfactual: null,
      lastMarkPrice: null,
      holdingDurationMs: null,
      abortReason: null,
      lastReconcileError: null,
    };
    this.store.getState().trades.push(trade);
    signal.tradeId = tradeId;
    if (options.persist !== false) this.store.save(); // durable lease BEFORE a private order can be sent
    return trade;
  }

  private async executeFreshSignal(signal: DailyRangeSignal): Promise<void> {
    const state = this.store.getState();
    const now = this.nowMs();
    if (state.control.mode !== "ARMED") {
      this.markSignal(signal, { eligible: false, reason: "LANE_DISARMED" });
      return;
    }
    if (signal.strategyVersion !== this.strategyVersion) {
      this.markSignal(signal, { eligible: false, reason: "RETIRED_STRATEGY_VERSION" });
      return;
    }
    if (signal.executionEligible === false || this.isLiveContinuationShadow(signal)) {
      signal.routeExecutionEnabled = false;
      signal.executionEligible = false;
      this.markSignal(signal, { eligible: false, reason: "LIVE_CONTINUATION_EXECUTION_DISABLED", recordAttempt: false });
      return;
    }
    if (this.mainnetControlBlockReason("entry")) {
      this.markSignal(signal, { eligible: false, reason: "MAINNET_EXECUTION_DISABLED" });
      return;
    }
    let accountGate: DailyRangeEntryGateDecision;
    try {
      accountGate = this.entryGate();
    } catch (error) {
      accountGate = { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!accountGate?.allowed) {
      this.markSignal(signal, { eligible: false, reason: "ACCOUNT_ENTRY_BLOCKED" });
      return;
    }
    const symbolBlock = this.symbolEntryBlockReason(signal.symbol);
    if (symbolBlock) {
      this.markSignal(signal, { eligible: false, reason: symbolBlock });
      return;
    }
    const armEpochBlock = this.v1SignalArmEpochBlockReason(signal);
    if (armEpochBlock) {
      this.markSignal(signal, { eligible: false, reason: armEpochBlock });
      return;
    }
    const limitReason = this.entryLimitReason();
    if (limitReason) {
      this.markSignal(signal, { eligible: false, reason: limitReason });
      return;
    }
    if (!this.inEntryWindow(signal.signalTimestampMs)) {
      this.markSignal(signal, { eligible: false, reason: "OUTSIDE_ENTRY_WINDOW" });
      return;
    }
    if (now - signal.signalTimestampMs > MAX_FRESH_SIGNAL_AGE_MS) {
      this.markSignal(signal, { eligible: false, reason: "MISSED_SIGNAL_RECOVERY" });
      return;
    }
    if (!signal.confirmationBar1 || signal.reason === "STALE_DATA") {
      this.markSignal(signal, { eligible: false, reason: "STALE_DATA" });
      return;
    }
    if (signal.direction === "SHORT" && this.getShortBlocklist().has(signal.symbol)) {
      this.markSignal(signal, { eligible: false, reason: "SHORT_BLOCKED" });
      console.log(`[daily-range-lane] SIGNAL_BLOCKED_SHORT symbol=${signal.symbol} signal=${signal.signalId}`);
      return;
    }
    if (this.store.hasActiveSymbolLease(signal.symbol)) {
      this.markSignal(signal, { eligible: false, reason: "LANE_POSITION_ALREADY_OPEN" });
      return;
    }

    const trade = this.createPendingTrade(signal);
    if (!trade) {
      this.markSignal(signal, { eligible: false, reason: "STALE_DATA" });
      return;
    }
    if (!this.entryClaims.tryClaimEntrySymbol(signal.symbol, DAILY_RANGE_LANE_ID)) {
      this.abortTrade(trade, "ENTRY_ABORT_SYMBOL_IN_FLIGHT", "shared in-flight symbol claim is held by another lane");
      this.markSignal(signal, { eligible: false, reason: "ENTRY_IN_FLIGHT", tradeId: trade.tradeId });
      return;
    }
    try {
      await this.submitTradeEntry(trade, signal);
    } finally {
      this.entryClaims.releaseEntrySymbol(signal.symbol, DAILY_RANGE_LANE_ID);
    }
  }

  private async readSymbolAccount(symbol: string): Promise<{ positions: FuturesPosition[]; orders: FuturesOrder[]; algos: FuturesAlgoOrder[] }> {
    const [positions, orders, algos] = await Promise.all([
      this.client.getPositions(symbol),
      this.client.getOpenOrders(symbol),
      this.client.getOpenAlgoOrders(symbol),
    ]);
    return { positions, orders, algos };
  }

  /** A confirmed market fill can precede positionRisk visibility by a few polls. */
  private async readVisiblePosition(symbol: string): Promise<FuturesPosition | null> {
    for (let attempt = 0; attempt < CONFIRM_RETRIES; attempt++) {
      const rows = await this.client.getPositions(symbol);
      const position = rows.find((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON) ?? null;
      if (position) return position;
      if (attempt + 1 < CONFIRM_RETRIES && this.confirmRetryMs > 0) {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, this.confirmRetryMs));
      }
    }
    return null;
  }

  private scheduleImmediateReconcile(): void {
    setTimeout(() => void this.tick(), Math.max(250, this.confirmRetryMs));
  }

  private foreignAccountReason(symbol: string, account: { positions: FuturesPosition[]; orders: FuturesOrder[]; algos: FuturesAlgoOrder[] }): string | null {
    const position = account.positions.find((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON);
    if (position) return `foreign exchange position ${position.positionAmt}`;
    if (account.orders.some((order) => order.symbol === symbol)) return "foreign open regular order";
    if (account.algos.some((order) => order.symbol === symbol)) return "foreign open conditional order";
    return null;
  }

  private async submitTradeEntry(trade: DailyRangeTrade, signal: DailyRangeSignal): Promise<void> {
    let account: { positions: FuturesPosition[]; orders: FuturesOrder[]; algos: FuturesAlgoOrder[] };
    try {
      account = await this.readSymbolAccount(trade.symbol);
    } catch (error) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", `account state unknown: ${error instanceof Error ? error.message : String(error)}`);
      this.markSignal(signal, { eligible: false, reason: "ACCOUNT_STATE_UNKNOWN", tradeId: trade.tradeId });
      return;
    }
    const foreign = this.foreignAccountReason(trade.symbol, account);
    if (foreign) {
      this.abortTrade(trade, "ENTRY_ABORT_ACCOUNT_CONFLICT", foreign);
      this.markSignal(signal, { eligible: false, reason: "SYMBOL_OCCUPIED_BY_OTHER_STRATEGY", tradeId: trade.tradeId });
      console.log(`[daily-range-lane] SYMBOL_OCCUPIED_BY_OTHER_STRATEGY symbol=${trade.symbol} detail=${foreign}`);
      return;
    }

    let filters: Map<string, FuturesSymbolFilters>;
    let referencePrice: number;
    try {
      filters = await this.client.getExchangeFilters();
      if (trade.economics) {
        // V3 uses the persisted pre-allocation BBO side for execution lineage.
        // It never replaces the selected candidate's decision price with a
        // newer quote just before the POST.
        referencePrice = trade.direction === "LONG" ? trade.economics.decisionAsk : trade.economics.decisionBid;
      } else {
        // Only immutable legacy records arrive here without a V3 plan.
        const book = await this.client.getBookTicker(trade.symbol);
        referencePrice = trade.direction === "LONG" ? book.ask ?? 0 : book.bid ?? 0;
      }
    } catch (error) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", `execution reference unavailable: ${error instanceof Error ? error.message : String(error)}`);
      this.markSignal(signal, { eligible: false, reason: "EXECUTION_INELIGIBLE", tradeId: trade.tradeId });
      return;
    }
    const filter = filters.get(trade.symbol);
    if (!filter || !finitePositive(referencePrice)) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", "symbol is not execution-feasible on testnet");
      this.markSignal(signal, { eligible: false, reason: "EXECUTION_INELIGIBLE", tradeId: trade.tradeId });
      return;
    }
    const plannedQty = trade.economics ? trade.requestedQty : clampQty(DAILY_RANGE_TRADE_NOTIONAL_USD / referencePrice, filter);
    const qty = plannedQty === null ? null : clampQty(plannedQty, filter);
    const expectedNotional = trade.economics?.plannedNotionalUsd ?? (qty === null ? 0 : qty * referencePrice);
    const frozenQtyChanged = trade.economics && qty !== null && Math.abs(qty - plannedQty!) > Math.max(EPSILON, plannedQty! * 1e-9);
    if (qty === null || frozenQtyChanged || expectedNotional + EPSILON < filter.minNotional) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", trade.economics
        ? "frozen V3 quantity is no longer executable under the current exchange filter"
        : "25 USDT cannot satisfy exchange quantity/minNotional filter");
      this.markSignal(signal, { eligible: false, reason: trade.economics ? "RISK_BUDGET_UNEXECUTABLE" : "EXECUTION_INELIGIBLE", tradeId: trade.tradeId });
      return;
    }
    trade.signalReferencePrice = referencePrice;
    trade.requestedQty = qty;
    this.store.save();
    try {
      await this.client.setLeverage(trade.symbol, DAILY_RANGE_LEVERAGE);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", `unable to set required 1x leverage: ${message}`);
      this.markSignal(signal, {
        eligible: false,
        reason: error instanceof BinanceFuturesPrivateError && error.binanceCode === -2019 ? "INSUFFICIENT_MARGIN" : "EXECUTION_INELIGIBLE",
        tradeId: trade.tradeId,
      });
      return;
    }
    this.markSignal(signal, { eligible: true, reason: null, tradeId: trade.tradeId });
    this.store.save();
    let order: FuturesOrder | null = null;
    try {
      order = await this.client.placeOrder({
        symbol: trade.symbol,
        side: symbolSide(trade.direction),
        type: "MARKET",
        quantity: qty,
        newClientOrderId: trade.entryClientOrderId,
      });
    } catch (error) {
      const recovered = await this.queryEntryByClientId(trade);
      if (recovered && orderStatusFilled(recovered)) {
        await this.adoptConfirmedEntry(trade, recovered, referencePrice, filter);
        return;
      }
      if (orderWasExplicitlyRejected(error)) {
        const reason = error instanceof Error ? error.message : String(error);
        this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", reason);
        this.markSignal(signal, {
          eligible: false,
          reason: error instanceof BinanceFuturesPrivateError && error.binanceCode === -2019 ? "INSUFFICIENT_MARGIN" : "EXECUTION_INELIGIBLE",
          tradeId: trade.tradeId,
        });
        return;
      }
      trade.status = "ENTRY_RECONCILING";
      trade.lastReconcileError = `entry status unknown: ${error instanceof Error ? error.message : String(error)}`;
      this.store.save();
      return;
    }
    const confirmed = await this.confirmFilledOrder(trade.symbol, order);
    if (!confirmed) {
      trade.status = "ENTRY_RECONCILING";
      trade.lastReconcileError = "market entry not yet confirmed; no retry will be sent";
      this.store.save();
      // A MARKET order is normally final immediately, but a venue can briefly
      // report PARTIALLY_FILLED before its terminal status reaches order query.
      // Reconcile sooner than the normal 30s scheduler: a terminal partial fill
      // must be adopted and bracketed (or flattened), never left naked.
      this.scheduleImmediateReconcile();
      return;
    }
    await this.adoptConfirmedEntry(trade, confirmed, referencePrice, filter);
  }

  private async queryEntryByClientId(trade: DailyRangeTrade): Promise<FuturesOrder | null> {
    try {
      return await this.client.queryOrderByClientId(trade.symbol, trade.entryClientOrderId);
    } catch {
      return null;
    }
  }

  private async confirmFilledOrder(symbol: string, initial: FuturesOrder): Promise<FuturesOrder | null> {
    if (orderStatusFilled(initial)) return initial;
    let last: FuturesOrder | null = initial;
    for (let attempt = 0; attempt < CONFIRM_RETRIES; attempt++) {
      if (this.confirmRetryMs > 0) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, this.confirmRetryMs));
      try {
        const queried = await this.client.queryOrder(symbol, initial.orderId);
        last = queried;
        if (orderStatusFilled(queried)) return queried;
        if (!["NEW", "PARTIALLY_FILLED"].includes(queried.status)) return null;
      } catch {
        // Status remains genuinely unknown; caller persists reconciliation state.
      }
    }
    return orderStatusFilled(last) ? last : null;
  }

  /**
   * The private transport intentionally never retries a POST.  A canary follows
   * the same idempotent recovery contract as a real entry: resolve its exact
   * client id before declaring the submission failed or attempting cleanup.
   */
  private async submitCanaryMarketOrder(input: {
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    reduceOnly?: boolean;
    clientOrderId: string;
  }): Promise<FuturesOrder> {
    let initial: FuturesOrder | null = null;
    try {
      initial = await this.client.placeOrder({
        symbol: input.symbol,
        side: input.side,
        type: "MARKET",
        quantity: input.quantity,
        reduceOnly: input.reduceOnly,
        newClientOrderId: input.clientOrderId,
      });
    } catch (error) {
      try {
        initial = await this.client.queryOrderByClientId(input.symbol, input.clientOrderId);
      } catch {
        throw error;
      }
    }
    const confirmed = await this.confirmFilledOrder(input.symbol, initial);
    if (!confirmed) throw new Error(`canary market order ${input.clientOrderId} is not confirmed filled`);
    return confirmed;
  }

  private async adoptConfirmedEntry(
    trade: DailyRangeTrade,
    order: FuturesOrder,
    referencePrice: number,
    filter: FuturesSymbolFilters,
  ): Promise<void> {
    const qty = order.executedQty;
    const entry = order.avgPrice;
    if (!(qty > EPSILON) || !(entry > 0)) {
      trade.status = "ENTRY_RECONCILING";
      trade.lastReconcileError = "entry fill had no executable quantity/price";
      this.store.save();
      return;
    }
    const structuralTarget = trade.economics?.structurePolicyId === DAILY_RANGE_STRUCTURAL_SR_POLICY_ID
      ? trade.structuralTargetRaw ?? trade.economics.rawStructuralTarget
      : null;
    const tpMultipleR = structuralTarget === null
      ? trade.routeExitPolicy?.tpMultipleR ?? trade.rrTarget ?? DAILY_RANGE_RR
      : undefined;
    const bracket = roundDailyRangeBracket({
      direction: trade.direction,
      entry,
      rawStop: trade.structuralStopRaw,
      tickSize: filter.tickSize,
      tpMultipleR,
      rawTarget: structuralTarget,
    });
    const oldPolicyBracket = isDailyRangeRouteExitV1(trade.routeExitPolicy)
      ? roundDailyRangeBracket({
        direction: trade.direction,
        entry,
        rawStop: trade.structuralStopRaw,
        tickSize: filter.tickSize,
        tpMultipleR: DAILY_RANGE_RR,
      })
      : null;
    trade.entryOrderId = order.orderId;
    trade.entryFilledAt = iso(order.updateTime > 0 ? order.updateTime : this.nowMs());
    trade.entryFillPrice = entry;
    trade.entryQty = qty;
    trade.entryNotionalUsd = entry * qty;
    trade.entrySlippageBps = referencePrice > 0
      ? 10_000 * (trade.direction === "LONG" ? (entry - referencePrice) / referencePrice : (referencePrice - entry) / referencePrice)
      : null;
    if (!bracket) {
      trade.lastReconcileError = "actual fill makes structural R invalid after conservative tick rounding";
      this.store.save();
      await this.emergencyFlatten(trade, "ENTRY_ABORT_INVALID_RISK", "ENTRY_ABORT_INVALID_RISK");
      return;
    }
    trade.stopPrice = bracket.stop;
    trade.takeProfitRaw = bracket.takeProfitRaw;
    trade.takeProfitPrice = bracket.takeProfit;
    if (trade.fadeMfe?.mfePolicyId === DAILY_RANGE_FADE_MFE_POLICY_ID) {
      trade.fadeMfe = bindDailyRangeFadeMfeTarget(trade.fadeMfe, {
        entryPrice: trade.entryFillPrice,
        structuralTakeProfit: trade.takeProfitPrice,
      });
    }
    trade.oldPolicyTakeProfitPrice = oldPolicyBracket?.takeProfit ?? null;
    trade.initialRiskPrice = bracket.riskPrice;
    trade.initialRiskPct = bracket.riskPrice / entry;
    trade.initialRiskDollar = bracket.riskPrice * qty;
    trade.rrTarget = bracket.rewardPrice / bracket.riskPrice;
    trade.actualInitialRiskUsd = trade.initialRiskDollar;
    if (!(trade.initialRiskDollar > 0)) {
      trade.lastReconcileError = "initial dollar risk is not positive";
      this.store.save();
      await this.emergencyFlatten(trade, "ENTRY_ABORT_INVALID_RISK", "ENTRY_ABORT_INVALID_RISK");
      return;
    }
    if (trade.geometry) {
      const actualGeometry = evaluateDailyRangeTradeGeometry({
        expectedEntryPrice: entry,
        expectedStopPrice: bracket.stop,
        expectedTakeProfitPrice: bracket.takeProfit,
        tpMultipleR: trade.rrTarget,
        atr4hFeature: trade.geometry.atr4h !== null
          && trade.geometry.atrSourceLastClosedAt !== null
          && trade.geometry.atrFeatureTimestamp !== null
          ? {
            atr4h: trade.geometry.atr4h,
            atrSourceLastClosedAt: trade.geometry.atrSourceLastClosedAt,
            atrFeatureTimestamp: trade.geometry.atrFeatureTimestamp,
          }
          : null,
        authority: trade.economics?.structurePolicyId === DAILY_RANGE_STRUCTURAL_SR_POLICY_ID
          ? "DIAGNOSTIC_ONLY"
          : "LEGACY_ENFORCED",
      });
      trade.postFillGeometryStatus = actualGeometry.geometryPass
        ? "PASS"
        : actualGeometry.geometryRejectReason;
      if (!actualGeometry.geometryPass) {
        const reason = actualGeometry.geometryRejectReason ?? "TARGET_REACHABILITY_DATA_UNAVAILABLE";
        trade.lastReconcileError = `POST_FILL_GEOMETRY_FAIL: ${reason}`;
        trade.status = "PROTECTING";
        this.store.save();
        try {
          // Preserve the exact structural bracket while the idempotent
          // reduce-only close settles; never repair a bad fill by moving either
          // level.
          await this.placeAndVerifyBrackets(trade);
        } catch (error) {
          trade.lastReconcileError = `POST_FILL_GEOMETRY_FAIL: protective bracket setup failed: ${error instanceof Error ? error.message : String(error)}`;
          this.store.save();
        }
        await this.emergencyFlatten(trade, "ENTRY_ABORT_POST_FILL_GEOMETRY_FAIL", `POST_FILL_GEOMETRY_FAIL:${reason}`);
        return;
      }
    }
    if (trade.economics) {
      const fillEconomics = evaluateActualFillEconomics({
        side: trade.direction,
        entryPrice: entry,
        quantity: qty,
        stopPrice: bracket.stop,
        expectedCostRatio: trade.economics.costRatio,
        expectedPlannedRiskUsd: trade.economics.plannedRiskUsd,
        safeLossFrictionBps: trade.economics.safeLossFrictionBps,
      });
      if (!fillEconomics) {
        trade.postFillEconomicsStatus = "POST_FILL_ECONOMICS_FAIL";
        trade.lastReconcileError = "POST_FILL_ECONOMICS_FAIL: actual fill cannot form a valid structural-risk record";
        trade.status = "PROTECTING";
        this.store.save();
        try {
          // Keep the frozen structural native protection live while the
          // exact reduce-only flatten is being reconciled. The failure never
          // widens or rewrites either bracket.
          await this.placeAndVerifyBrackets(trade);
        } catch (error) {
          trade.lastReconcileError = `POST_FILL_ECONOMICS_FAIL: protective bracket setup failed: ${error instanceof Error ? error.message : String(error)}`;
          this.store.save();
        }
        await this.emergencyFlatten(trade, "ENTRY_ABORT_POST_FILL_ECONOMICS_FAIL", "POST_FILL_ECONOMICS_FAIL");
        return;
      }
      trade.actualStopRiskBps = fillEconomics.actualStopRiskBps;
      trade.actualCostRatio = fillEconomics.actualCostRatio;
      trade.actualInitialRiskUsd = fillEconomics.actualInitialRiskUsd;
      trade.actualEffectiveLossUsd = fillEconomics.actualEffectiveLossUsd;
      trade.postFillEconomicsStatus = fillEconomics.violation ?? "PASS";
      if (fillEconomics.materialViolation) {
        const violation = fillEconomics.violation ?? "POST_FILL_ECONOMICS_FAIL";
        trade.lastReconcileError = violation === "POST_FILL_RISK_FAIL"
          ? `${violation}: actualEffectiveLossUsd=${fillEconomics.actualEffectiveLossUsd.toFixed(8)} planned=${trade.economics.plannedRiskUsd.toFixed(8)}`
          : `${violation}: actual fill economics could not be formed`;
        trade.status = "PROTECTING";
        this.store.save();
        try {
          await this.placeAndVerifyBrackets(trade);
        } catch (error) {
          trade.lastReconcileError = `${violation}: protective bracket setup failed: ${error instanceof Error ? error.message : String(error)}`;
          this.store.save();
        }
        await this.emergencyFlatten(
          trade,
          violation === "POST_FILL_RISK_FAIL" ? "ENTRY_ABORT_POST_FILL_RISK_FAIL" : "ENTRY_ABORT_POST_FILL_ECONOMICS_FAIL",
          violation,
        );
        return;
      }
    }
    trade.status = "PROTECTING";
    trade.lastReconcileError = null;
    this.store.save();
    try {
      await this.placeAndVerifyBrackets(trade);
      trade.status = "OPEN";
      trade.lastReconcileError = null;
      this.store.save();
      console.log(
        `[daily-range-lane] ENTRY_PROTECTED trade=${trade.tradeId} symbol=${trade.symbol} qty=${qty} entry=${entry} stop=${trade.stopPrice} tp=${trade.takeProfitPrice}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trade.lastReconcileError = `bracket setup failed: ${message}`;
      this.store.save();
      await this.emergencyFlatten(trade, "ENTRY_ABORT_PROTECTION_FAILED", `ENTRY_ABORT_PROTECTION_FAILED:${message}`);
    }
  }

  private async placeAndVerifyBrackets(trade: DailyRangeTrade): Promise<void> {
    if (!finitePositive(trade.entryQty) || !finitePositive(trade.stopPrice) || !finitePositive(trade.takeProfitPrice)) {
      throw new Error("cannot create brackets without confirmed qty/stop/take-profit");
    }
    const account = await this.readSymbolAccount(trade.symbol);
    let pos = account.positions.find((row) => row.symbol === trade.symbol && Math.abs(row.positionAmt) > EPSILON) ?? null;
    if (!pos) pos = await this.readVisiblePosition(trade.symbol);
    if (!pos || Math.sign(pos.positionAmt) !== directionSign(trade.direction) || Math.abs(Math.abs(pos.positionAmt) - trade.entryQty) > Math.max(EPSILON, trade.entryQty * 1e-6)) {
      throw new Error("exchange position does not exactly match lane-owned entry quantity");
    }
    if (pos.leverage !== DAILY_RANGE_LEVERAGE) {
      throw new Error(`exchange leverage ${pos.leverage} differs from required ${DAILY_RANGE_LEVERAGE}x`);
    }
    const existingStop = account.algos.find((algo) => algo.clientAlgoId === trade.stopClientAlgoId) ?? null;
    const existingTp = account.algos.find((algo) => algo.clientAlgoId === trade.takeProfitClientAlgoId) ?? null;
    if (existingStop) trade.stopAlgoOrderId = existingStop.algoId;
    if (existingTp) trade.takeProfitAlgoOrderId = existingTp.algoId;
    this.store.save();
    if (!trade.stopAlgoOrderId) {
      const stop = await this.submitAlgoOrRecover({
        trade,
        type: "STOP_MARKET",
        triggerPrice: trade.stopPrice,
        clientAlgoId: trade.stopClientAlgoId,
      });
      if (!stop) throw new Error("stop order outcome is unknown or absent");
      trade.stopAlgoOrderId = stop.algoId;
      this.store.save();
    }
    if (!trade.takeProfitAlgoOrderId) {
      const takeProfit = await this.submitAlgoOrRecover({
        trade,
        type: "TAKE_PROFIT_MARKET",
        triggerPrice: trade.takeProfitPrice,
        clientAlgoId: trade.takeProfitClientAlgoId,
      });
      if (!takeProfit) throw new Error("take-profit order outcome is unknown or absent");
      trade.takeProfitAlgoOrderId = takeProfit.algoId;
      this.store.save();
    }
    const active = await this.client.getOpenAlgoOrders(trade.symbol);
    const stopActive = active.some((algo) => algo.algoId === trade.stopAlgoOrderId || algo.clientAlgoId === trade.stopClientAlgoId);
    const tpActive = active.some((algo) => algo.algoId === trade.takeProfitAlgoOrderId || algo.clientAlgoId === trade.takeProfitClientAlgoId);
    if (!stopActive || !tpActive) {
      throw new Error(`protective bracket verification failed (stop=${stopActive}, takeProfit=${tpActive})`);
    }
  }

  private async submitAlgoOrRecover(input: {
    trade: DailyRangeTrade;
    type: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
    triggerPrice: number;
    clientAlgoId: string;
  }): Promise<FuturesAlgoOrder | null> {
    try {
      return await this.client.placeAlgoOrder({
        symbol: input.trade.symbol,
        side: exitSide(input.trade.direction),
        type: input.type,
        quantity: input.trade.entryQty!,
        triggerPrice: input.triggerPrice,
        reduceOnly: true,
        clientAlgoId: input.clientAlgoId,
        workingType: "CONTRACT_PRICE",
      });
    } catch (error) {
      const active = await this.client.getOpenAlgoOrders(input.trade.symbol).catch(() => [] as FuturesAlgoOrder[]);
      const recovered = active.find((algo) => algo.clientAlgoId === input.clientAlgoId) ?? null;
      if (recovered) return recovered;
      if (orderWasExplicitlyRejected(error)) throw error;
      // Do not blindly resend an unknown conditional order. A naked position is
      // safer to flatten than to pair with a possibly-duplicated hidden bracket.
      return null;
    }
  }

  private abortTrade(trade: DailyRangeTrade, status: Extract<DailyRangeTradeStatus, `ENTRY_ABORT_${string}`>, reason: string): void {
    trade.status = status;
    trade.abortReason = reason;
    trade.lastReconcileError = reason;
    if (!trade.exitTimestamp) trade.exitTimestamp = iso(this.nowMs());
    this.store.save();
  }

  private async reconcilePendingEntries(): Promise<void> {
    const pending = this.store.getState().trades.filter((trade) => trade.status === "ENTRY_SUBMITTING" || trade.status === "ENTRY_RECONCILING");
    for (const trade of pending) {
      const order = await this.queryEntryByClientId(trade);
      const terminalPartialFill = order !== null &&
        order.executedQty > EPSILON &&
        order.avgPrice > 0 &&
        !["NEW", "PARTIALLY_FILLED"].includes(order.status);
      if (order && (orderStatusFilled(order) || terminalPartialFill)) {
        let filter: FuturesSymbolFilters | null = null;
        try {
          filter = (await this.client.getExchangeFilters()).get(trade.symbol) ?? null;
        } catch {
          // Keep the lease pending: without tick filters a bracket cannot be made safe.
        }
        if (!filter) {
          trade.status = "ENTRY_RECONCILING";
          trade.lastReconcileError = "filled entry found but exchange filters are unavailable";
          this.store.save();
          continue;
        }
        await this.adoptConfirmedEntry(trade, order, trade.signalReferencePrice ?? order.avgPrice, filter);
        continue;
      }
      if (order && !["NEW", "PARTIALLY_FILLED"].includes(order.status)) {
        this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", `entry terminal without fill: ${order.status}`);
        continue;
      }
      try {
        const account = await this.readSymbolAccount(trade.symbol);
        const position = account.positions.find((row) => row.symbol === trade.symbol && Math.abs(row.positionAmt) > EPSILON);
        if (!position && order === null) {
          // queryOrderByClientId may be temporarily unreachable; keep the durable
          // lease rather than treating a missing response as proof of no order.
          trade.status = "ENTRY_RECONCILING";
          trade.lastReconcileError = "entry query remains inconclusive; no resend";
          this.store.save();
        } else if (position) {
          trade.status = "ENTRY_RECONCILING";
          trade.lastReconcileError = "exchange position exists but entry order cannot be proven by clientOrderId";
          this.store.disarm(iso(this.nowMs()), "unreconciled daily lane entry position");
        }
        if (order?.status === "PARTIALLY_FILLED" && position) {
          trade.status = "ENTRY_RECONCILING";
          trade.lastReconcileError = "market entry remains partially filled; waiting for terminal exchange state before exact-quantity protection";
          this.store.save();
          this.scheduleImmediateReconcile();
        }
      } catch (error) {
        trade.status = "ENTRY_RECONCILING";
        trade.lastReconcileError = `pending entry reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
        this.store.save();
      }
    }
  }

  private async reconcileOpenTrades(): Promise<boolean> {
    const active = this.store.getState().trades.filter((trade) =>
      ["PROTECTING", "OPEN", "EXIT_RECONCILING"].includes(trade.status),
    );
    if (active.length === 0) return true;
    let positions: FuturesPosition[];
    let algos: FuturesAlgoOrder[];
    try {
      [positions, algos] = await Promise.all([this.client.getPositions(), this.client.getOpenAlgoOrders()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = this.store.getState();
      if (isRateLimitedTransportFailure(error)) {
        // The client has already opened an account-wide cooldown circuit. Do
        // not relabel healthy trades as reconciliation failures while no
        // exchange read is permitted, and do not keep an older 418 attached.
        if (clearTransientRateLimitReconciliationDiagnostics(state, active)) this.store.save();
        return false;
      }
      for (const trade of active) trade.lastReconcileError = `account reconciliation unavailable: ${message}`;
      state.runtime.reconciliationError = message;
      this.store.save();
      return false;
    }
    for (const trade of active) {
      const position = positions.find((row) => row.symbol === trade.symbol && Math.abs(row.positionAmt) > EPSILON) ?? null;
      if (!position) {
        await this.finalizeFlatTrade(trade, algos);
        continue;
      }
      if (!finitePositive(trade.entryQty) || Math.sign(position.positionAmt) !== directionSign(trade.direction) || Math.abs(Math.abs(position.positionAmt) - trade.entryQty) > Math.max(EPSILON, trade.entryQty * 1e-6)) {
        trade.lastReconcileError = `P0 ownership mismatch: exchange=${position.positionAmt}, laneQty=${trade.entryQty ?? "null"}`;
        this.store.disarm(iso(this.nowMs()), `ownership mismatch on ${trade.symbol}`);
        continue;
      }
      // Account mark is reconciliatory only. Native brackets use CONTRACT_PRICE,
      // so mark snapshots must never be presented as MFE/MAE path extrema.
      this.updateReconciledMark(trade, position.markPrice);
      const stopActive = algos.some((algo) => algo.algoId === trade.stopAlgoOrderId || algo.clientAlgoId === trade.stopClientAlgoId);
      const tpActive = algos.some((algo) => algo.algoId === trade.takeProfitAlgoOrderId || algo.clientAlgoId === trade.takeProfitClientAlgoId);
      if (!stopActive || !tpActive) {
        // Position risk and open conditional orders are separate Binance
        // snapshots. A native TP/SL can disappear from the latter just after
        // the former was read, even though that position has already gone
        // flat. Never turn that transition into a false naked-position alarm.
        let refreshedPosition: FuturesPosition | null;
        let refreshedAlgos: FuturesAlgoOrder[];
        try {
          // Read in this order: if a native exit settles while the algo book is
          // being refreshed, the following position read observes flatness and
          // lets normal exit reconciliation prove the fill.
          refreshedAlgos = await this.client.getOpenAlgoOrders(trade.symbol);
          refreshedPosition = await this.readVisiblePosition(trade.symbol);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isRateLimitedTransportFailure(error)) {
            const state = this.store.getState();
            if (clearTransientRateLimitReconciliationDiagnostics(state, active)) this.store.save();
            return false;
          }
          trade.lastReconcileError = `bracket transition recheck unavailable: ${message}`;
          this.store.save();
          continue;
        }
        if (!refreshedPosition) {
          await this.finalizeFlatTrade(trade, refreshedAlgos);
          continue;
        }
        const refreshedStopActive = refreshedAlgos.some((algo) => algo.algoId === trade.stopAlgoOrderId || algo.clientAlgoId === trade.stopClientAlgoId);
        const refreshedTpActive = refreshedAlgos.some((algo) => algo.algoId === trade.takeProfitAlgoOrderId || algo.clientAlgoId === trade.takeProfitClientAlgoId);
        if (refreshedStopActive && refreshedTpActive) {
          this.updateReconciledMark(trade, refreshedPosition.markPrice);
          trade.lastReconcileError = null;
          if (trade.status === "PROTECTING") trade.status = "OPEN";
          continue;
        }
        if (Math.sign(refreshedPosition.positionAmt) !== directionSign(trade.direction) || Math.abs(Math.abs(refreshedPosition.positionAmt) - trade.entryQty) > Math.max(EPSILON, trade.entryQty * 1e-6)) {
          trade.lastReconcileError = `P0 ownership mismatch after bracket recheck: exchange=${refreshedPosition.positionAmt}, laneQty=${trade.entryQty ?? "null"}`;
          this.store.disarm(iso(this.nowMs()), `ownership mismatch on ${trade.symbol}`);
          this.store.save();
          continue;
        }
        // A native conditional order may already have triggered while its
        // reduce-only fill is still settling. Its historical identity is more
        // authoritative than a transient open-position snapshot, so wait for
        // normal exit reconciliation instead of submitting a second close.
        const [refreshedStop, refreshedTp] = await Promise.all([
          this.queryAlgoSafely(trade.stopAlgoOrderId),
          this.queryAlgoSafely(trade.takeProfitAlgoOrderId),
        ]);
        if (algoLooksTriggered(refreshedStop) || algoLooksTriggered(refreshedTp)) {
          trade.status = "EXIT_RECONCILING";
          trade.lastReconcileError = "native exit transition observed; awaiting settled exchange position";
          this.store.save();
          this.scheduleImmediateReconcile();
          continue;
        }
        trade.lastReconcileError = `protective bracket missing while position remains (stop=${refreshedStopActive}, tp=${refreshedTpActive})`;
        this.store.disarm(iso(this.nowMs()), `missing bracket on ${trade.symbol}`);
        this.store.save();
        await this.emergencyFlatten(trade, "ENTRY_ABORT_PROTECTION_FAILED", "missing exchange-native bracket while position open");
        continue;
      }
      // A past transport failure must not remain attached to a healthy, freshly
      // verified trade. Leaving it here made the status endpoint report a stale
      // 418 even after a later reconciliation had proved both native brackets.
      trade.lastReconcileError = null;
      if (trade.status === "PROTECTING") {
        trade.status = "OPEN";
      }
    }
    const state = this.store.getState();
    state.runtime.reconciledAt = iso(this.nowMs());
    state.runtime.reconciliationError = null;
    this.store.save();
    return true;
  }

  private openTradeGeometry(trade: DailyRangeTrade, atr4hFeature: DailyRangeAtr4hFeature | null): DailyRangeTradeGeometry {
    return evaluateDailyRangeTradeGeometry({
      expectedEntryPrice: trade.entryFillPrice ?? Number.NaN,
      expectedStopPrice: trade.stopPrice ?? Number.NaN,
      expectedTakeProfitPrice: trade.takeProfitPrice ?? Number.NaN,
      tpMultipleR: trade.routeExitPolicy?.tpMultipleR ?? trade.rrTarget ?? DAILY_RANGE_RR,
      atr4hFeature,
      authority: trade.economics?.structurePolicyId === DAILY_RANGE_STRUCTURAL_SR_POLICY_ID
        ? "DIAGNOSTIC_ONLY"
        : "LEGACY_ENFORCED",
    });
  }

  private recordGeometryMigration(
    trade: DailyRangeTrade,
    migration: DailyRangeOpenPositionGeometryMigration,
  ): void {
    trade.geometryMigration = migration;
    this.store.save();
  }

  private migrationIsSettled(trade: DailyRangeTrade): boolean {
    const migration = trade.geometryMigration;
    return migration?.geometryPolicyId === DAILY_RANGE_TRADE_GEOMETRY_POLICY_ID
      && (migration.status === "PASS" || migration.status === "UNKNOWN" || migration.status === "BLOCKED" || migration.status === "FROZEN" || migration.action === "FLATTENED");
  }

  /**
   * Safe one-time migration for positions that predate the geometry policy.
   * It runs only after a fresh exchange reconciliation, preserves all passing
   * brackets verbatim, and delegates every flatten to the lane's existing
   * exact-quantity ownership-checked emergency path.
   */
  private async migrateOpenTradesToGeometryPolicy(): Promise<void> {
    const active = this.store.getState().trades
      .filter((trade) => ["PROTECTING", "OPEN", "EXIT_RECONCILING"].includes(trade.status))
      .sort((left, right) => left.entrySubmittedAt.localeCompare(right.entrySubmittedAt) || left.tradeId.localeCompare(right.tradeId));
    for (const trade of active) {
      if (this.migrationIsSettled(trade)) continue;
      if (this.closingTradeIds.has(trade.tradeId)) continue;

      // Existing open positions are immutable at the Structural S/R V1
      // cutover.  They retain their own frozen entry, native brackets and
      // policy lineage; this release must not close, resize or reinterpret
      // them under new target/geometry rules.
      if (trade.economics?.structurePolicyId === DAILY_RANGE_STRUCTURAL_SR_POLICY_ID) continue;

      const frozenGeometry = this.openTradeGeometry(trade, null);
      this.recordGeometryMigration(trade, {
        geometryPolicyId: DAILY_RANGE_TRADE_GEOMETRY_POLICY_ID,
        evaluatedAt: iso(this.nowMs()),
        originalDecisionAt: toMs(trade.signalTimestamp) === null ? null : iso(toMs(trade.signalTimestamp)!),
        status: "FROZEN",
        reason: "FROZEN_PRE_STRUCTURAL_POLICY",
        action: "KEPT",
        geometry: frozenGeometry,
      });
    }
  }

  private updateReconciledMark(trade: DailyRangeTrade, markPrice: number): void {
    if (!finitePositive(markPrice)) return;
    trade.lastMarkPrice = markPrice;
  }

  private markPathIncomplete(trade: DailyRangeTrade, reason: string): boolean {
    const nextReason = trade.pathGapReason ?? reason;
    if (trade.pathQuality === "INCOMPLETE" && trade.pathGapReason === nextReason) return false;
    trade.pathQuality = "INCOMPLETE";
    trade.pathGapReason = nextReason;
    return true;
  }

  /** Apply exactly one observed path point; caller already proved its temporal scope. */
  private recordPathObservation(trade: DailyRangeTrade, event: DailyRangeContractPathEvent): boolean {
    const entry = trade.entryFillPrice;
    const risk = trade.initialRiskPrice;
    const entryAt = toMs(trade.entryFilledAt);
    const exitAt = toMs(trade.exitTimestamp);
    if (!finitePositive(entry) || !finitePositive(risk) || entryAt === null || event.eventTimeMs < entryAt) return false;
    if (exitAt !== null && event.eventTimeMs > exitAt) return false;
    if (trade.pathFrozenAt != null && event.source !== "RECOVERED_1M") return false;
    const favorablePrice = trade.direction === "LONG" ? event.price - entry : entry - event.price;
    const r = favorablePrice / risk;
    const pct = favorablePrice / entry;
    if (!Number.isFinite(r) || !Number.isFinite(pct)) return false;
    let changed = false;
    if (trade.lastPathPrice !== event.price || trade.lastPathEventTime !== iso(event.eventTimeMs) || trade.pathSource !== event.source) {
      changed = true;
    }
    trade.lastPathPrice = event.price;
    trade.lastPathEventTime = iso(event.eventTimeMs);
    trade.lastPathReceivedAt = iso(event.receivedAtMs);
    trade.pathSource = event.source;
    if ((trade.mfeR ?? Number.NEGATIVE_INFINITY) <= r) {
      trade.mfeR = r;
      trade.mfePct = pct;
      trade.mfePrice = event.price;
      trade.mfeEventTime = iso(event.eventTimeMs);
      changed = true;
    }
    if ((trade.maeR ?? Number.POSITIVE_INFINITY) >= r) {
      trade.maeR = r;
      trade.maePct = pct;
      trade.maePrice = event.price;
      trade.maeEventTime = iso(event.eventTimeMs);
      changed = true;
    }
    return changed;
  }

  private persistPathObservationsIfDue(force = false): void {
    this.pathDirty = true;
    const now = this.nowMs();
    if (!force && now - this.lastPathPersistAtMs < PATH_PERSIST_INTERVAL_MS) return;
    this.store.save();
    this.pathDirty = false;
    this.lastPathPersistAtMs = now;
  }

  /**
   * Native exit fills are terminal contract-price observations. They are added
   * even when a stop/TP fired between stream messages, then all later live
   * events are rejected by the frozen exit timestamp.
   */
  private recordTerminalExitPath(trade: DailyRangeTrade): void {
    const price = trade.exitPrice;
    const exitAt = toMs(trade.exitTimestamp);
    if (!finitePositive(price) || exitAt === null) return;
    if (trade.pathQuality !== "EXACT_STREAM") {
      this.markPathIncomplete(trade, "no continuous contract-price stream through terminal exit");
    }
    this.recordPathObservation(trade, {
      symbol: trade.symbol,
      price,
      eventTimeMs: exitAt,
      receivedAtMs: this.nowMs(),
      source: "EXIT_FILL",
      streamStartedAtMs: null,
    });
  }

  /**
   * Deterministic, non-interpolated fallback for a missing live stream. Only
   * complete one-minute candles fully contained inside entry..exit are used;
   * partial boundary candles are excluded rather than leaking pre-entry or
   * post-exit prices into MFE/MAE. OHLC ordering remains unknowable, therefore
   * a successful reconstruction is always labelled APPROX_1M, never exact.
   */
  private async recoverTerminalPathFromOneMinuteCandles(trade: DailyRangeTrade): Promise<void> {
    if (trade.pathQuality === "EXACT_STREAM") {
      trade.pathRecoveryAt = iso(this.nowMs());
      trade.pathRecoveryReason = "not needed: continuous contract-price stream";
      return;
    }
    const entryAt = toMs(trade.entryFilledAt);
    const exitAt = toMs(trade.exitTimestamp);
    if (entryAt === null || exitAt === null || exitAt <= entryAt) {
      this.markPathIncomplete(trade, "cannot recover path without ordered entry and exit timestamps");
      trade.pathRecoveryAt = iso(this.nowMs());
      trade.pathRecoveryReason = "ordered entry/exit timestamps unavailable";
      return;
    }
    const firstOpen = Math.ceil(entryAt / 60_000) * 60_000;
    const lastOpen = Math.floor((exitAt - 60_000) / 60_000) * 60_000;
    if (lastOpen < firstOpen) {
      this.markPathIncomplete(trade, "no complete one-minute candle falls wholly inside entry..exit");
      trade.pathRecoveryAt = iso(this.nowMs());
      trade.pathRecoveryReason = "no fully contained one-minute candles";
      return;
    }
    const expectedBars = Math.floor((lastOpen - firstOpen) / 60_000) + 1;
    if (expectedBars > MAX_PATH_RECOVERY_BARS) {
      this.markPathIncomplete(trade, "one-minute recovery window exceeds bounded verifier limit");
      trade.pathRecoveryAt = iso(this.nowMs());
      trade.pathRecoveryReason = `recovery window has ${expectedBars} bars; limit=${MAX_PATH_RECOVERY_BARS}`;
      return;
    }
    const recovered: DailyRangeCandle[] = [];
    let nextOpen = firstOpen;
    try {
      while (nextOpen <= lastOpen) {
        const endOpen = Math.min(lastOpen, nextOpen + (1_500 - 1) * 60_000);
        const rows = await this.client.getKlines(trade.symbol, "1m", {
          startTime: nextOpen,
          endTime: endOpen + 59_999,
          limit: 1_500,
        });
        const candles = rows
          .map(asDailyCandle)
          .filter((row) => row.openTime >= nextOpen && row.openTime <= endOpen && row.closeTime + 1 <= exitAt)
          .sort((a, b) => a.openTime - b.openTime);
        recovered.push(...candles);
        nextOpen = endOpen + 60_000;
      }
    } catch (error) {
      this.markPathIncomplete(trade, "one-minute recovery fetch failed");
      trade.pathRecoveryAt = iso(this.nowMs());
      trade.pathRecoveryReason = error instanceof Error ? error.message : String(error);
      return;
    }
    const contiguous = recovered.length === expectedBars && recovered.every((candle, index) =>
      candle.openTime === firstOpen + index * 60_000,
    );
    if (!contiguous) {
      this.markPathIncomplete(trade, "one-minute recovery has a missing or duplicate candle");
      trade.pathRecoveryAt = iso(this.nowMs());
      trade.pathRecoveryReason = `expected ${expectedBars} complete 1m candles, received ${recovered.length}`;
      return;
    }
    for (const candle of recovered) {
      const favorable = trade.direction === "LONG" ? candle.high : candle.low;
      const adverse = trade.direction === "LONG" ? candle.low : candle.high;
      const eventTimeMs = candle.closeTime;
      this.recordPathObservation(trade, {
        symbol: trade.symbol,
        price: favorable,
        eventTimeMs,
        receivedAtMs: this.nowMs(),
        source: "RECOVERED_1M",
        streamStartedAtMs: null,
      });
      this.recordPathObservation(trade, {
        symbol: trade.symbol,
        price: adverse,
        eventTimeMs,
        receivedAtMs: this.nowMs(),
        source: "RECOVERED_1M",
        streamStartedAtMs: null,
      });
    }
    trade.pathQuality = "APPROX_1M";
    trade.pathGapReason = null;
    trade.pathRecoveryAt = iso(this.nowMs());
    trade.pathRecoveryReason = "complete one-minute OHLC recovery; intra-minute ordering is not inferable";
  }

  private async freezeTerminalPath(trade: DailyRangeTrade): Promise<void> {
    this.recordTerminalExitPath(trade);
    try {
      await this.recoverTerminalPathFromOneMinuteCandles(trade);
    } catch (error) {
      this.markPathIncomplete(trade, "terminal path recovery threw unexpectedly");
      trade.pathRecoveryAt = iso(this.nowMs());
      trade.pathRecoveryReason = error instanceof Error ? error.message : String(error);
    }
    trade.pathFrozenAt = iso(this.nowMs());
    this.pathDirty = false;
    this.lastPathPersistAtMs = this.nowMs();
  }

  /**
   * Presentation capture happens only after the exchange exit and accounting
   * record have both settled. It is intentionally best-effort: an unavailable
   * public candle feed can leave the UI artifact PENDING but can never reopen,
   * delay, or relabel the already-confirmed trade close.
   */
  private async captureClosedChartSnapshot(trade: DailyRangeTrade): Promise<void> {
    if (trade.status !== "CLOSED" || trade.closedChartSnapshot?.status === "CAPTURED") return;
    const requestedAt = iso(this.nowMs());
    try {
      trade.closedChartSnapshot = pendingDailyRangeClosedChartSnapshot(trade, requestedAt);
      this.store.save();
      const snapshot = await captureDailyRangeClosedChartSnapshot({
        directory: this.store.closedChartSnapshotDirectory(),
        client: this.client,
        trade,
        nowMs: this.nowMs,
      });
      trade.closedChartSnapshot = snapshot;
      this.store.save();
    } catch (error) {
      // The settlement is already durable before this method is reached. Keep
      // a truthful pending state for the report instead of allowing an image
      // failure to mutate the real exit's accounting or ownership status.
      trade.closedChartSnapshot = {
        ...pendingDailyRangeClosedChartSnapshot(trade, requestedAt),
        reason: "snapshot capture failed: " + (error instanceof Error ? error.message : String(error)),
      };
      try {
        this.store.save();
      } catch {
        // A state-store failure is independently surfaced by the runtime; the
        // image archive is never allowed to throw through close reconciliation.
      }
    }
  }

  /** At most one presentation-only retry per scheduler tick, never for legacy rows. */
  private async retryOnePendingClosedChartSnapshot(): Promise<void> {
    const now = this.nowMs();
    const candidate = this.store.getState().trades.find((trade) => {
      if (trade.status !== "CLOSED" || trade.closedChartSnapshot?.status !== "PENDING") return false;
      const lastAttemptMs = toMs(trade.closedChartSnapshot.requestedAt);
      return lastAttemptMs === null || now - lastAttemptMs >= CLOSED_CHART_SNAPSHOT_RETRY_MS;
    });
    if (candidate) await this.captureClosedChartSnapshot(candidate);
  }

  /** Read-only image accessor used only by the Daily Range closed-report route. */
  readClosedChartSnapshotSvg(tradeId: string): string | null {
    const trade = this.store.findTrade(tradeId);
    return trade ? readDailyRangeClosedChartSnapshotSvg(this.store.closedChartSnapshotDirectory(), trade.closedChartSnapshot) : null;
  }

  private async finalizeFlatTrade(trade: DailyRangeTrade, openAlgos: FuturesAlgoOrder[]): Promise<void> {
    if (this.closingTradeIds.has(trade.tradeId)) return;
    this.closingTradeIds.add(trade.tradeId);
    try {
      let exitReason: string | null = trade.exitReason;
      let exitOrderId: string | null = trade.exitOrderId;
      if (!exitOrderId) {
        const stop = await this.queryAlgoSafely(trade.stopAlgoOrderId);
        const tp = await this.queryAlgoSafely(trade.takeProfitAlgoOrderId);
        if (algoLooksTriggered(tp)) {
          exitReason = "TAKE_PROFIT";
          exitOrderId = tp?.actualOrderId ?? null;
        } else if (algoLooksTriggered(stop)) {
          exitReason = "STOP_LOSS";
          exitOrderId = stop?.actualOrderId ?? null;
        }
      }
      if (!exitOrderId || !exitReason) {
        trade.status = "EXIT_RECONCILING";
        trade.lastReconcileError = "exchange is flat but no owned exit order can yet be proven";
        this.store.save();
        return;
      }
      await this.cancelOpenSiblingOrders(trade, openAlgos);
      const positionAfterCancel = await this.client.getPositions(trade.symbol);
      if (positionAfterCancel.some((position) => position.symbol === trade.symbol && Math.abs(position.positionAmt) > EPSILON)) {
        trade.status = "EXIT_RECONCILING";
        trade.lastReconcileError = "position reappeared during sibling cancellation";
        this.store.save();
        return;
      }
      const exit = await this.client.queryOrder(trade.symbol, exitOrderId);
      if (!orderStatusFilled(exit)) {
        trade.status = "EXIT_RECONCILING";
        trade.lastReconcileError = `exit order ${exitOrderId} is not yet confirmed filled`;
        this.store.save();
        return;
      }
      trade.exitOrderId = exitOrderId;
      trade.exitReason = exitReason;
      trade.exitPrice = exit.avgPrice;
      trade.exitTimestamp = iso(exit.updateTime > 0 ? exit.updateTime : this.nowMs());
      await this.settleClosedTrade(trade, "CLOSED");
      console.log(`[daily-range-lane] TRADE_CLOSED trade=${trade.tradeId} symbol=${trade.symbol} reason=${exitReason}`);
    } catch (error) {
      trade.status = "EXIT_RECONCILING";
      trade.lastReconcileError = `flat-trade reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.store.save();
    } finally {
      this.closingTradeIds.delete(trade.tradeId);
    }
  }

  private async queryAlgoSafely(algoId: string | null): Promise<FuturesAlgoOrder | null> {
    if (!algoId) return null;
    try {
      return await this.client.queryAlgoOrder(algoId);
    } catch {
      return null;
    }
  }

  private async cancelOpenSiblingOrders(trade: DailyRangeTrade, openAlgos?: FuturesAlgoOrder[]): Promise<void> {
    const active = openAlgos ?? await this.client.getOpenAlgoOrders(trade.symbol);
    for (const algo of active) {
      const own = algo.algoId === trade.stopAlgoOrderId || algo.algoId === trade.takeProfitAlgoOrderId ||
        algo.clientAlgoId === trade.stopClientAlgoId || algo.clientAlgoId === trade.takeProfitClientAlgoId;
      if (!own) continue;
      try {
        await this.client.cancelAlgoOrder(algo.algoId);
      } catch (error) {
        // A terminal/just-triggered sibling can return an error because it is no
        // longer cancelable. Re-read open orders before deciding it is unresolved.
        const retryOpen = await this.client.getOpenAlgoOrders(trade.symbol).catch(() => [] as FuturesAlgoOrder[]);
        if (retryOpen.some((candidate) => candidate.algoId === algo.algoId || candidate.clientAlgoId === algo.clientAlgoId)) {
          throw error;
        }
      }
    }
    const left = await this.client.getOpenAlgoOrders(trade.symbol);
    const ownLeft = left.filter((algo) =>
      algo.algoId === trade.stopAlgoOrderId || algo.algoId === trade.takeProfitAlgoOrderId ||
      algo.clientAlgoId === trade.stopClientAlgoId || algo.clientAlgoId === trade.takeProfitClientAlgoId,
    );
    if (ownLeft.length > 0) throw new Error(`owned bracket sibling remains open (${ownLeft.map((algo) => algo.algoId).join(",")})`);
  }

  private async settleClosedTrade(trade: DailyRangeTrade, terminalStatus: "CLOSED" | Extract<DailyRangeTradeStatus, `ENTRY_ABORT_${string}`>): Promise<void> {
    if (!trade.entryOrderId || !trade.exitOrderId || !finitePositive(trade.initialRiskDollar)) {
      throw new Error("cannot settle without confirmed entry, exit, and initial dollar risk");
    }
    const start = Math.max(0, (toMs(trade.entrySubmittedAt) ?? this.nowMs()) - 10_000);
    const [fills, income] = await Promise.all([
      this.client.getUserTrades(trade.symbol, { startTime: start, limit: 1000 }),
      this.client.getIncomeHistory({ startTime: start, endTime: this.nowMs(), incomeType: "FUNDING_FEE", limit: 1000 }),
    ]);
    const ownIds = new Set([trade.entryOrderId, trade.exitOrderId]);
    const ownFills = fills.filter((fill) => ownIds.has(fill.orderId));
    if (!ownFills.some((fill) => fill.orderId === trade.exitOrderId)) {
      throw new Error("exchange user-trade ledger has not yet exposed the confirmed exit fill");
    }
    const gross = ownFills.reduce((sum, fill) => sum + fill.realizedPnl, 0);
    const fees = ownFills.reduce((sum, fill) => sum + Math.abs(fill.commission), 0);
    const entryFees = ownFills
      .filter((fill) => fill.orderId === trade.entryOrderId)
      .reduce((sum, fill) => sum + Math.abs(fill.commission), 0);
    const exitFees = ownFills
      .filter((fill) => fill.orderId === trade.exitOrderId)
      .reduce((sum, fill) => sum + Math.abs(fill.commission), 0);
    const entryFillCount = ownFills.filter((fill) => fill.orderId === trade.entryOrderId).length;
    const exitFillCount = ownFills.filter((fill) => fill.orderId === trade.exitOrderId).length;
    const funding = income
      .filter((entry) => entry.symbol === trade.symbol && entry.time >= start)
      .reduce((sum, entry) => sum + entry.income, 0);
    trade.grossPnlUsd = gross;
    trade.feesUsd = fees;
    trade.entryFeesUsd = entryFees;
    trade.exitFeesUsd = exitFees;
    trade.entryFillCount = entryFillCount;
    trade.exitFillCount = exitFillCount;
    trade.feeEvidence = "EXACT_FILL_COMMISSION";
    trade.fundingUsd = funding;
    trade.netPnlUsd = gross - fees + funding;
    trade.grossR = gross / trade.initialRiskDollar;
    trade.realizedR = trade.netPnlUsd / trade.initialRiskDollar;
    const mfeAttribution = trade.fadeMfe?.exitAttribution ?? null;
    if (mfeAttribution) {
      mfeAttribution.actualExitFill = trade.exitPrice;
      mfeAttribution.exitSlippageBps = trade.exitSlippageBps;
      mfeAttribution.grossR = trade.grossR;
      mfeAttribution.netR = trade.realizedR;
      if (trade.exitReason === "FADE_MFE_STAGE1_GIVEBACK_EXIT" || trade.exitReason === "FADE_MFE_STAGE2_GIVEBACK_EXIT") {
        mfeAttribution.terminalOutcome = "MFE_EXIT";
        if (trade.fadeMfeCounterfactual) {
          trade.fadeMfeCounterfactual.startedAt = trade.exitTimestamp ?? mfeAttribution.triggerAt;
        }
      } else {
        mfeAttribution.terminalOutcome = trade.exitReason === "TAKE_PROFIT"
          ? "NATIVE_TP"
          : trade.exitReason === "STOP_LOSS" ? "NATIVE_SL" : "OTHER";
        // If a native order won the race, there was no independent MFE exit to
        // counterfactually continue.
        trade.fadeMfeCounterfactual = null;
      }
    }
    const opened = toMs(trade.entryFilledAt) ?? toMs(trade.entrySubmittedAt) ?? this.nowMs();
    const closed = toMs(trade.exitTimestamp) ?? this.nowMs();
    trade.holdingDurationMs = Math.max(0, closed - opened);
    // Measurement follows the actual native working type (CONTRACT_PRICE),
    // and is frozen before the terminal record becomes externally visible.
    await this.freezeTerminalPath(trade);
    trade.status = terminalStatus;
    trade.lastReconcileError = null;
    this.store.save();
    if (Number.isFinite(trade.netPnlUsd)) {
      try {
        this.onTradeClosed?.(trade.netPnlUsd!);
      } catch {
        // Accounting/kill-switch telemetry must never turn a confirmed, settled
        // lane close back into an error or duplicate its exchange handling.
      }
    }
    if (terminalStatus === "CLOSED") await this.captureClosedChartSnapshot(trade);
  }

  /** Close exactly one owned daily-lane trade. It never touches a basket or another lane. */
  async manualCloseTrade(tradeId: string): Promise<{ ok: boolean; reason: string | null; netPnlUsd: number | null }> {
    const trade = this.store.findTrade(tradeId);
    if (!trade) return { ok: false, reason: "daily lane trade not found", netPnlUsd: null };
    if (isTerminalTradeStatus(trade.status)) return { ok: false, reason: `trade is already ${trade.status}`, netPnlUsd: trade.netPnlUsd };
    await this.emergencyFlatten(trade, "CLOSED", "MANUAL_CLOSE");
    return {
      ok: trade.status === "CLOSED",
      reason: trade.status === "CLOSED" ? null : trade.lastReconcileError ?? `close remains ${trade.status}`,
      netPnlUsd: trade.netPnlUsd,
    };
  }

  /**
   * Account-kill counterpart to the other lane executors' orderly close methods.
   * It disarms first, reconciles any uncertain entry once, then only sends an
   * exact-quantity reduce-only exit for a position this lane can prove it owns.
   */
  async closeAllTradesOrderly(reason: string): Promise<{ closed: number; failed: number }> {
    this.disarm(reason);
    try {
      await this.reconcilePendingEntries();
    } catch {
      // The per-trade loop below records unresolved pending entries as failures;
      // never turn an account-wide kill into a blanket symbol flatten.
    }
    let closed = 0;
    let failed = 0;
    const candidates = this.store.getState().trades.filter((trade) => !isTerminalTradeStatus(trade.status));
    for (const trade of candidates) {
      if (!finitePositive(trade.entryQty)) {
        failed += 1;
        continue;
      }
      await this.emergencyFlatten(trade, "CLOSED", reason);
      if (trade.status === "CLOSED") closed += 1;
      else failed += 1;
    }
    return { closed, failed };
  }

  /**
   * Market-close while leaving any existing protective orders active until exchange
   * flatness is proven. This ordering prevents a failed/manual market close from
   * turning a protected trade into a naked one.
   */
  private async emergencyFlatten(
    trade: DailyRangeTrade,
    terminalStatus: "CLOSED" | Extract<DailyRangeTradeStatus, `ENTRY_ABORT_${string}`>,
    reason: string,
  ): Promise<void> {
    if (this.closingTradeIds.has(trade.tradeId)) return;
    this.closingTradeIds.add(trade.tradeId);
    try {
      if (!finitePositive(trade.entryQty)) {
        this.abortTrade(trade, terminalStatus === "CLOSED" ? "ENTRY_ABORT_EXECUTION_FAILED" : terminalStatus, `${reason}: no confirmed owned quantity`);
        return;
      }
      const position = await this.readVisiblePosition(trade.symbol);
      if (!position) {
        // No quantity means there is nothing safe to market-close. Keep the lease only
        // if an exit identity cannot be proved by normal reconciliation.
        if (trade.exitOrderId) {
          await this.cancelOpenSiblingOrders(trade);
          await this.settleClosedTrade(trade, terminalStatus);
        } else {
          trade.status = "EXIT_RECONCILING";
          trade.lastReconcileError = `${reason}: exchange flat before an owned exit can be identified`;
          this.store.disarm(iso(this.nowMs()), `${reason}: confirmed entry not yet visible for safe flatten`);
          this.store.save();
          this.scheduleImmediateReconcile();
        }
        return;
      }
      if (Math.sign(position.positionAmt) !== directionSign(trade.direction) || Math.abs(Math.abs(position.positionAmt) - trade.entryQty) > Math.max(EPSILON, trade.entryQty * 1e-6)) {
        trade.status = "EXIT_RECONCILING";
        trade.lastReconcileError = `${reason}: refusing close due to ownership mismatch exchange=${position.positionAmt} lane=${trade.entryQty}`;
        this.store.disarm(iso(this.nowMs()), `ownership mismatch while emergency closing ${trade.symbol}`);
        return;
      }
      const clientId = trade.exitClientOrderId ?? exitClientId(trade.tradeId);
      trade.exitClientOrderId = clientId;
      trade.exitReason = reason;
      trade.status = "EXIT_RECONCILING";
      try {
        const book = await this.client.getBookTicker(trade.symbol);
        const reference = exitSide(trade.direction) === "SELL" ? book.bid : book.ask;
        trade.exitReferencePrice = finitePositive(reference) ? reference : null;
      } catch {
        // Exit safety must not depend on an auxiliary public quote. Keep the
        // missing reference explicit rather than fabricating zero slippage.
        trade.exitReferencePrice = null;
      }
      this.store.save();
      let order: FuturesOrder | null = null;
      try {
        order = await this.client.placeOrder({
          symbol: trade.symbol,
          side: exitSide(trade.direction),
          type: "MARKET",
          quantity: trade.entryQty,
          reduceOnly: true,
          newClientOrderId: clientId,
        });
      } catch (error) {
        try {
          order = await this.client.queryOrderByClientId(trade.symbol, clientId);
        } catch {
          if (orderWasExplicitlyRejected(error)) {
            trade.lastReconcileError = `${reason}: exit rejected: ${error instanceof Error ? error.message : String(error)}`;
          } else {
            trade.lastReconcileError = `${reason}: exit status unknown; protective brackets intentionally retained`;
          }
          this.store.save();
          return;
        }
      }
      const confirmed = await this.confirmFilledOrder(trade.symbol, order);
      if (!confirmed) {
        trade.lastReconcileError = `${reason}: exit fill not yet confirmed; protective brackets retained`;
        this.store.save();
        return;
      }
      const after = await this.client.getPositions(trade.symbol);
      if (after.some((row) => row.symbol === trade.symbol && Math.abs(row.positionAmt) > EPSILON)) {
        trade.lastReconcileError = `${reason}: market exit did not leave the owned symbol flat; brackets retained`;
        this.store.save();
        return;
      }
      trade.exitOrderId = confirmed.orderId;
      trade.exitPrice = confirmed.avgPrice;
      trade.exitSlippageBps = finitePositive(trade.exitReferencePrice)
        ? 10_000 * (trade.direction === "LONG"
          ? (trade.exitReferencePrice - confirmed.avgPrice) / trade.exitReferencePrice
          : (confirmed.avgPrice - trade.exitReferencePrice) / trade.exitReferencePrice)
        : null;
      trade.exitTimestamp = iso(confirmed.updateTime > 0 ? confirmed.updateTime : this.nowMs());
      await this.cancelOpenSiblingOrders(trade);
      await this.settleClosedTrade(trade, terminalStatus);
      console.log(`[daily-range-lane] ${reason} trade=${trade.tradeId} symbol=${trade.symbol} exit=${trade.exitPrice}`);
    } catch (error) {
      trade.status = "EXIT_RECONCILING";
      trade.lastReconcileError = `${reason}: flatten failed: ${error instanceof Error ? error.message : String(error)}`;
      this.store.save();
    } finally {
      this.closingTradeIds.delete(trade.tradeId);
    }
  }

  /** Controlled exchange canary.  It is deliberately separate from signal/trade history. */
  async runCanary(): Promise<DailyRangeCanaryEvidence> {
    const mainnetBlock = this.mainnetControlBlockReason("canary");
    if (mainnetBlock) throw new Error(mainnetBlock);
    if (this.store.getState().control.mode === "ARMED") throw new Error("disarm daily lane before running a canary");
    if (!this.startupReconciled) await this.reconcileOnStartup();
    if (!await this.ensureTodayRange()) {
      throw new Error("daily range policy cutover is pending an inherited active trade");
    }
    const now = this.nowMs();
    const evidence: DailyRangeCanaryEvidence = {
      canaryId: `DRCANARY-${now.toString(36)}`,
      at: iso(now),
      status: "RUNNING",
      symbol: null,
      side: "BUY",
      intendedNotionalUsd: DAILY_RANGE_TRADE_NOTIONAL_USD,
      leverage: DAILY_RANGE_LEVERAGE,
      requestedQty: null,
      entryOrderId: null,
      entryClientOrderId: null,
      entryFillPrice: null,
      entryQty: null,
      stopAlgoOrderId: null,
      takeProfitAlgoOrderId: null,
      closeOrderId: null,
      positionVerified: false,
      bracketVerified: false,
      bracketCancelled: false,
      closeVerified: false,
      orphanOrders: null,
      orphanPosition: null,
      failure: null,
    };
    this.store.getState().canaries.push(evidence);
    this.store.save();
    let claimed = false;
    try {
      const symbol = await this.selectCanarySymbol();
      if (!symbol) throw new Error("no liquid daily-universe symbol is exchange-flat and unoccupied for DRCANARY");
      evidence.symbol = symbol;
      if (!this.entryClaims.tryClaimEntrySymbol(symbol, "DRCANARY")) throw new Error("canary symbol is currently claimed by another entry path");
      claimed = true;
      const [filters, book, account] = await Promise.all([
        this.client.getExchangeFilters(),
        this.client.getBookTicker(symbol),
        this.readSymbolAccount(symbol),
      ]);
      const foreign = this.foreignAccountReason(symbol, account);
      if (foreign) throw new Error(`canary symbol became occupied: ${foreign}`);
      const filter = filters.get(symbol);
      const reference = book.ask ?? 0;
      if (!filter || !finitePositive(reference)) throw new Error("canary symbol lacks a valid filter/ask");
      const qty = clampQty(DAILY_RANGE_TRADE_NOTIONAL_USD / reference, filter);
      if (!qty || qty * reference + EPSILON < filter.minNotional) throw new Error("canary 25 USDT quantity is not executable");
      const entryId = canaryClientId("E", symbol, now);
      evidence.entryClientOrderId = entryId;
      // Persist the exact bounded claim BEFORE the private POST.  The shared
      // account engine can then distinguish this controlled lifecycle from an
      // orphan position if its reconciliation tick races the canary fill.
      evidence.requestedQty = qty;
      this.store.save();
      await this.client.setLeverage(symbol, DAILY_RANGE_LEVERAGE);
      const entry = await this.submitCanaryMarketOrder({
        symbol,
        side: "BUY",
        quantity: qty,
        clientOrderId: entryId,
      });
      evidence.entryOrderId = entry.orderId;
      evidence.entryFillPrice = entry.avgPrice;
      evidence.entryQty = entry.executedQty;
      const afterEntry = await this.client.getPositions(symbol);
      const canaryPosition = afterEntry.find((row) => row.symbol === symbol && row.positionAmt > EPSILON) ?? null;
      if (!canaryPosition || Math.abs(canaryPosition.positionAmt - entry.executedQty) > Math.max(EPSILON, entry.executedQty * 1e-6) || canaryPosition.leverage !== DAILY_RANGE_LEVERAGE) {
        throw new Error("canary entry position/leverage did not match confirmed fill");
      }
      evidence.positionVerified = true;
      const stopPrice = roundToStep(entry.avgPrice * 0.90, filter.tickSize, "down");
      const tpPrice = roundToStep(entry.avgPrice * 1.10, filter.tickSize, "up");
      const stop = await this.client.placeAlgoOrder({
        symbol, side: "SELL", type: "STOP_MARKET", quantity: entry.executedQty, triggerPrice: stopPrice,
        reduceOnly: true, clientAlgoId: canaryClientId("SL", symbol, now), workingType: "CONTRACT_PRICE",
      });
      evidence.stopAlgoOrderId = stop.algoId;
      const tp = await this.client.placeAlgoOrder({
        symbol, side: "SELL", type: "TAKE_PROFIT_MARKET", quantity: entry.executedQty, triggerPrice: tpPrice,
        reduceOnly: true, clientAlgoId: canaryClientId("TP", symbol, now), workingType: "CONTRACT_PRICE",
      });
      evidence.takeProfitAlgoOrderId = tp.algoId;
      const bracket = await this.client.getOpenAlgoOrders(symbol);
      if (!bracket.some((algo) => algo.algoId === stop.algoId) || !bracket.some((algo) => algo.algoId === tp.algoId)) {
        throw new Error("canary protective bracket was not visible at exchange");
      }
      evidence.bracketVerified = true;
      await this.client.cancelAlgoOrder(stop.algoId);
      await this.client.cancelAlgoOrder(tp.algoId);
      const afterCancel = await this.client.getOpenAlgoOrders(symbol);
      if (afterCancel.some((algo) => algo.algoId === stop.algoId || algo.algoId === tp.algoId)) throw new Error("canary bracket cancellation left an open order");
      evidence.bracketCancelled = true;
      const closed = await this.submitCanaryMarketOrder({
        symbol,
        side: "SELL",
        quantity: entry.executedQty,
        reduceOnly: true,
        clientOrderId: canaryClientId("X", symbol, now),
      });
      evidence.closeOrderId = closed.orderId;
      const [afterClosePosition, finalRegularOrders, finalAlgoOrders] = await Promise.all([
        this.client.getPositions(symbol), this.client.getOpenOrders(symbol), this.client.getOpenAlgoOrders(symbol),
      ]);
      evidence.orphanPosition = afterClosePosition.some((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON);
      evidence.orphanOrders = finalRegularOrders.filter((order) => order.symbol === symbol).length + finalAlgoOrders.filter((algo) => algo.symbol === symbol).length;
      if (evidence.orphanPosition || evidence.orphanOrders !== 0) throw new Error("canary cleanup left exchange exposure/order");
      evidence.closeVerified = true;
      evidence.status = "PASSED";
      this.store.save();
      console.log(`[daily-range-lane] DRCANARY_PASSED symbol=${symbol} entry=${entry.orderId} stop=${stop.algoId} tp=${tp.algoId} close=${closed.orderId}`);
      return evidence;
    } catch (error) {
      evidence.status = "FAILED";
      evidence.failure = error instanceof Error ? error.message : String(error);
      await this.cleanupCanary(evidence);
      this.store.save();
      console.error(`[daily-range-lane] DRCANARY_FAILED ${evidence.failure}`);
      return evidence;
    } finally {
      if (claimed && evidence.symbol) this.entryClaims.releaseEntrySymbol(evidence.symbol, "DRCANARY");
    }
  }

  private async selectCanarySymbol(): Promise<string | null> {
    const state = this.store.getState();
    const day = state.days[utcDate(this.nowMs())];
    const candidates = day?.universeSymbols ?? this.getUniverse().symbols;
    const preferred = ["ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT", "XRPUSDT"];
    const ordered = [...new Set(candidates.map(normalizeSymbol))].sort((a, b) => {
      const pa = preferred.indexOf(a);
      const pb = preferred.indexOf(b);
      return (pa < 0 ? 999 : pa) - (pb < 0 ? 999 : pb) || a.localeCompare(b);
    });
    for (const symbol of ordered) {
      if (this.store.hasActiveSymbolLease(symbol)) continue;
      try {
        const account = await this.readSymbolAccount(symbol);
        if (!this.foreignAccountReason(symbol, account)) return symbol;
      } catch {
        // A candidate that cannot be proven exchange-flat cannot be a canary.
      }
    }
    return null;
  }

  private async cleanupCanary(evidence: DailyRangeCanaryEvidence): Promise<void> {
    if (!evidence.symbol) return;
    const symbol = evidence.symbol;
    try {
      // A POST response may be unknown while the market order is still resting
      // at the exchange. Cancel only this canary's exact client id; never sweep
      // regular orders belonging to another strategy.
      if (evidence.entryClientOrderId) {
        const regular = await this.client.getOpenOrders(symbol);
        const ownEntry = regular.find((order) => order.clientOrderId === evidence.entryClientOrderId);
        if (ownEntry) await this.client.cancelOrder(symbol, ownEntry.orderId).catch(() => undefined);
      }
      const positions = await this.client.getPositions(symbol);
      const position = positions.find((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON) ?? null;
      if (position) {
        const clientId = canaryClientId("X", symbol, this.nowMs());
        const side: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
        try {
          const order = await this.submitCanaryMarketOrder({
            symbol,
            side,
            quantity: Math.abs(position.positionAmt),
            reduceOnly: true,
            clientOrderId: clientId,
          });
          evidence.closeOrderId = order.orderId;
        } catch {
          // Evidence below reports any remaining orphan; never hide a failed cleanup.
        }
      }
      // Keep protection active until the emergency close is actually flat.  A
      // canary must never teach the production path a naked-position sequence.
      const afterExit = await this.client.getPositions(symbol);
      const stillOpen = afterExit.some((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON);
      if (!stillOpen) {
        const algos = await this.client.getOpenAlgoOrders(symbol);
        for (const algo of algos) {
          if (algo.algoId === evidence.stopAlgoOrderId || algo.algoId === evidence.takeProfitAlgoOrderId || algo.clientAlgoId.startsWith("DRCANARY")) {
            await this.client.cancelAlgoOrder(algo.algoId).catch(() => undefined);
          }
        }
      }
      const [afterPositions, regular, finalAlgos] = await Promise.all([this.client.getPositions(symbol), this.client.getOpenOrders(symbol), this.client.getOpenAlgoOrders(symbol)]);
      evidence.orphanPosition = afterPositions.some((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON);
      evidence.orphanOrders = regular.filter((order) => order.symbol === symbol).length + finalAlgos.filter((algo) => algo.symbol === symbol).length;
    } catch (cleanupError) {
      evidence.failure = `${evidence.failure ?? "canary failed"}; cleanup error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
  }
}

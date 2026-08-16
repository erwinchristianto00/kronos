import Fastify, { type FastifyInstance } from "fastify";
import { DECISION_PIPELINE_POLICY_VERSION, completedCandles, type Candle } from "@dtc/shared";
import { BinanceClient } from "./lib/binance.js";
import { HttpKronosClient } from "./lib/kronos.js";
import { HttpForecastChallengerClient } from "./lib/forecast-challenger.js";
import {
  ForecastChallengerBtcAnchorCache,
  refreshForecastChallengerBtcAnchor,
} from "./lib/forecast-challenger-btc-anchor.js";
import { TlobCollector } from "./lib/tlob-collector.js";
import { OutcomeChecker } from "./lib/outcome-checker.js";
import { PerformanceStatsProvider } from "./lib/performance-cache.js";
import { ScanService } from "./lib/scan-service.js";
import { ShadowExecutionEngine } from "./lib/shadow-engine.js";
import { getDecisionLedger } from "./lib/decision-ledger.js";
import { NotificationService } from "./lib/notification-service.js";
import { HttpSocialClient } from "./lib/social.js";
import { SignalTracker } from "./lib/tracker.js";
import { BinanceWhaleClient } from "./lib/whale.js";
import { registerKronosRoutes } from "./routes/kronos.js";
import { registerLiveRoutes } from "./routes/live.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerOutcomesRoutes } from "./routes/outcomes.js";
import { registerScanRoute } from "./routes/scan.js";
import { registerShadowRoutes } from "./routes/shadow.js";
import { registerTradingAssistantRoutes } from "./routes/trading-assistant.js";
import { BinanceFuturesPrivateClient } from "./lib/binance-futures-private.js";
import {
  CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
  CROSS_SECTIONAL_TREND_LANE_ID,
  CROSS_SECTIONAL_MIXED_LANE_ID,
  CrossSectionalExecutor,
  CrossSectionalExecutorStore,
  isCrossSectionalExecEnabled,
  isCrossSectionalAllocationIndependent,
  isCrossSectionalTrendMixedAdmissionIndependent,
  crossSectionalMarketNeutralIsAllowed,
} from "./lib/cross-sectional-executor.js";
import { buildCrossSectionalReport, getCrossSectionalReportSinceMs, getCrossSectionalStore } from "./lib/cross-sectional-edge.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  makeMfeGivebackExitPolicy,
  type PublicQuoteSnapshot,
  type SingleSymbolExitPolicy,
} from "./lib/single-symbol-lane-executor.js";
import {
  asCrossSectionalSignalStore,
  fundingCarryBaskets,
  hedgedResidualBaskets,
  innovationTestnetAdmissionAllowed,
  innovationTestnetLegUsd,
  innovationTestnetWeight,
  isInnovationTestnetExecutionEnabled,
  singleSignalsForDirection,
  startInnovationTestnetExecutorSchedule,
} from "./lib/innovation-testnet-execution.js";
import { BLS_LANE_ID, getBtcLeadLagSnapStore } from "./lib/btc-leadlag-snap-edge.js";
import { FC_PAPER_LANE_ID, getFundingCarryStore } from "./lib/funding-carry-edge.js";
import { FC_V2_LANE_ID, getFundingCarryCrowdingV2Store } from "./lib/funding-carry-crowding-v2.js";
import { HRS_V2_LANE_ID, getHedgedResidualShortV2Store } from "./lib/hedged-residual-short-v2.js";
import { LQR_LANE_ID, getLiqRecoilStore } from "./lib/liq-recoil-edge.js";
import { LQR_V2_LANE_ID, getLiqRecoilStrictReclaimV2Store } from "./lib/liq-recoil-strict-reclaim-v2.js";
import { CE_V2_LANE_ID, getCompressionRetestV2Store } from "./lib/compression-retest-v2.js";
import { QITF_LANE_ID, getQueueImbalanceToxicFlowStore } from "./lib/queue-imbalance-toxic-flow-edge.js";
import {
  getShortFadeStore,
  isShortFadeExecEnabled,
  shortFadeExitPolicy,
  shortFadeOpenSignals,
  SF_EXEC_LEG_USD,
  SF_EXEC_LEVERAGE,
  SF_EXEC_MAX_SIGNAL_AGE_MS,
  SF_EXEC_DAILY_MAX_LOSS_USD,
  SF_EXEC_MAX_CONCURRENT,
  SF_PAPER_LANE_ID,
} from "./lib/short-fade-edge.js";
import {
  getIntradayMomentumStore,
  isIntradayMomentumExecEnabled,
  intradayMomentumExitPolicy,
  intradayMomentumOpenSignals,
  IM_EXEC_LEG_USD,
  IM_EXEC_LEVERAGE,
  IM_EXEC_MAX_SIGNAL_AGE_MS,
  IM_EXEC_DAILY_MAX_LOSS_USD,
  IM_EXEC_MAX_CONCURRENT,
  IM_PAPER_LANE_ID,
} from "./lib/intraday-momentum-edge.js";
import {
  getPanicWashoutStore,
  isPanicWashoutExecEnabled,
  panicWashoutExitPolicy,
  panicWashoutOpenSignals,
  PWR_EXEC_LEG_USD,
  PWR_EXEC_LEVERAGE,
  PWR_EXEC_MAX_CONCURRENT,
  PWR_EXEC_MAX_SIGNAL_AGE_MS,
  PWR_EXEC_DAILY_MAX_LOSS_USD,
  PWR_PAPER_LANE_ID,
} from "./lib/panic-washout-reclaim-edge.js";
import {
  getRegimeCompositeStore,
  isRegimeCompositeExecEnabled,
  regimeCompositeExitPolicy,
  regimeCompositeOpenSignals,
  RC_EXEC_LEG_USD,
  RC_EXEC_LEVERAGE,
  RC_EXEC_MAX_SIGNAL_AGE_MS,
  RC_EXEC_DAILY_MAX_LOSS_USD,
  RC_EXEC_MAX_CONCURRENT,
  RC_PAPER_LANE_ID,
} from "./lib/regime-composite-edge.js";
import {
  getRegimeCompositeShortStore,
  isRegimeCompositeShortExecEnabled,
  regimeCompositeShortExitPolicy,
  regimeCompositeShortOpenSignals,
  RCS_EXEC_DAILY_MAX_LOSS_USD,
  RCS_EXEC_LEG_USD,
  RCS_EXEC_LEVERAGE,
  RCS_EXEC_MAX_CONCURRENT,
  RCS_EXEC_MAX_SIGNAL_AGE_MS,
  RCS_PAPER_LANE_ID,
} from "./lib/regime-composite-short-edge.js";
import {
  getCompositeEstimatorStore,
  isCompositeEstimatorExecEnabled,
  compositeEstimatorExitPolicy,
  compositeEstimatorOpenSignals,
  ceExecLegUsdForBucket,
  ceExecMaxSignalAgeMsForBucket,
  CE_EXEC_LEVERAGE,
  CE_EXEC_DAILY_MAX_LOSS_USD,
  CE_EXEC_MAX_CONCURRENT,
  ceLaneIdForBucket,
  buildCompositeEstimatorReport,
  type CEBucket,
} from "./lib/composite-estimator-edge.js";
import { computeExternalManagedNetQty, computeNotionalPerSymbol, maxNotionalPerSymbolAcrossLanes, computeClusterOpenSymbols, maxClusterPositionsAcrossLanes, isNewExecutorLaneAllowed, isTestnetCrossSectionalHorizonLaneAllowed, newExecutorLaneGate, rollingNetEntryHealth, sumExternalRealizedPnlUsd } from "./lib/live-executor-wiring.js";
import {
  CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID,
  CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID,
  DIRECTIONAL_REGIME_DAILY_MAX_LOSS_USD,
  DIRECTIONAL_REGIME_LEG_USD,
  DIRECTIONAL_REGIME_LEVERAGE,
  DIRECTIONAL_REGIME_MAX_HOLD_HOURS,
  DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS,
  DIRECTIONAL_REGIME_MAX_SIGNAL_AGE_MS,
  DIRECTIONAL_REGIME_MFE_ARM_R,
  DIRECTIONAL_REGIME_MFE_GIVEBACK_FRACTION,
  DIRECTIONAL_REGIME_MFE_PROFIT_LOCK_NET_RETURN,
  DIRECTIONAL_REGIME_MFE_PROFIT_LOCK_R,
  DIRECTIONAL_REGIME_MAKER_ENTRY,
  DIRECTIONAL_REGIME_MAKER_ENTRY_WAIT_MS,
  DirectionalReversalStateStore,
  buildCrossSectionalDirectionalRegimeDecision,
  confirmCrossSectionalDirectionalRegime,
  crossSectionalDirectionalOpenSignals,
  isCrossSectionalDirectionalRegimeExecEnabled,
} from "./lib/cross-sectional-directional-regime.js";
import {
  AccountExposureCoordinator,
  AccountExposureReservationStore,
  reservationReconcileIntervalMs,
} from "./lib/account-exposure-coordinator.js";
import {
  loadInnovationCampaign,
  innovationCampaignAdmission,
  computeInnovationExposure,
  buildInnovationCampaignDiagnostics,
  campaignCapForLane,
  type InnovationCampaignDiagnostics,
} from "./lib/innovation-campaign.js";
import { clusterOf } from "./lib/correlation-clusters.js";
import { RegimeAutopilot, isRegimeAutopilotEnabled } from "./lib/regime-autopilot.js";
import { getRegimeEngineStore } from "./lib/regime-engine-service.js";
import { buildRegimeAxisTimeline } from "./lib/regime-axis-timeline.js";
import { SingleSymbolPriceTimelineService } from "./lib/single-symbol-price-timeline.js";
import {
  LiveExecutionEngine,
  LiveExecutionStore,
  parseLiveExecutionConfig,
  symbolPriorityTier,
  type LiveExecutionConfig,
  type LiveNewEntryGateDecision,
} from "./lib/live-execution-engine.js";
import { getLaneSymbolCurationCacheStore } from "./lib/lane-symbol-curation-cache.js";
import type { LaneSymbolCurationTier } from "./lib/per-symbol-lane-book-edge.js";
import { getPaperExecutionRouterStore, peekPaperExecutionRouterStore, type PaperOrder } from "./lib/paper-execution-router.js";
import {
  isForceEligibleForDirection,
  getRealtimeShortMirrorStore,
  isRealtimeShortAllowedLaneId,
  isRealtimeShortMirrorEnabled,
  isRealtimeShortSelectableLaneId,
  isProfitCoreShortLaneId,
} from "./lib/realtime-short-mirror.js";
import {
  buildCurrentGuardVariantMatrixReport,
  exactLaneContextFor,
  getCurrentGuardVariantMatrixStore,
  laneStatusForContext,
  type ContextLaneStatusLookup,
  type CurrentGuardVariantMatrixStore,
  variantMatrixOpenSignals,
} from "./lib/current-guard-variant-matrix.js";
import {
  canonicalMarketRegimeExecutionPolicy,
  edgeMemoryLabelForCanonicalFamily,
  type CanonicalMarketRegimeSnapshot,
} from "./lib/canonical-market-regime-execution-policy.js";
// 2026-08 canonical-market-regime rollout — canonical-market-regime-engine.ts (requirement #3) has
// now landed. `getCanonicalMarketRegimeSnapshot` is its THE non-nullable public getter (kill-switch
// -> ENGINE_DISABLED degraded snapshot; otherwise the store's own `latest` if one has ever been
// recorded, else a cold-start degraded snapshot — never null/undefined). Aliased on import solely to
// avoid shadowing the shared `getCanonicalMarketRegimeSnapshot` closure buildApp() itself defines
// below (which every execution-affecting consumer in this file calls) — that closure's only job is
// to delegate to this real accessor now that it exists; see its own doc comment for why the
// indirection is kept even though it is currently a single pass-through. The engine's own real
// `CanonicalMarketRegimeSnapshot` (canonical-market-regime-engine.ts) is a strict field-superset of
// this file's imported structural-mirror type of the same name (two extra fields,
// `enterCandidate`/`enterCandidateCycles`, that no consumer in this file reads) — every field the
// mirror declares matches the real type exactly, so a real snapshot satisfies the mirror structurally
// with zero adapter code, exactly as canonical-market-regime-execution-policy.ts's own header
// predicted.
import { getCanonicalMarketRegimeSnapshot as getLatestCanonicalMarketRegimeEngineSnapshot } from "./lib/canonical-market-regime-engine.js";
import {
  ingestCanonicalMarketRegimeRawObservations,
  recordCanonicalMarketRegimeSnapshot,
  getCanonicalMarketRegimeSnapshotStore,
} from "./lib/canonical-market-regime-engine.js";
import { resolveCanonicalMarketRegimeUniverse } from "./lib/canonical-market-regime-universe.js";
// 2026-08 canonical-market-regime scheduler wiring fix — see canonical-market-regime-scheduler.ts's own
// header for why this file (not canonical-market-regime-engine.ts/-universe.ts, both of which
// explicitly defer cadence scheduling + the impure fetch shell to "a later wiring stage") owns the
// ingest -> compute -> record orchestration cycle. Call site is right after `liveEngine.start()` below.
import {
  runCanonicalMarketRegimeEngineCycleGuarded,
  CANONICAL_MARKET_REGIME_ENGINE_TICK_INTERVAL_MS,
} from "./lib/canonical-market-regime-scheduler.js";
import { getLatestScanCandidates } from "./lib/latest-scan-candidates-cache.js";
import { kronosAgreeFromScan } from "./lib/kronos-agree-reading.js";
import { getKronosBtcAnchorCache, refreshKronosBtcAnchor } from "./lib/kronos-btc-anchor-cache.js";
import { buildRegimeDirectionControllerReport } from "./lib/regime-direction-controller.js";
import { getRegimeDirectionControllerSnapshotStore } from "./lib/regime-direction-controller-snapshot.js";
import { getRegimeEdgeMemory } from "./lib/regime-edge-memory.js";
import { cortexBrainMode } from "./lib/cortex-brain.js";
import { CortexBrainStore, CortexDecisionJournal, runCortexShadowTick } from "./lib/cortex-brain-store.js";
import { publishCortexDecisionSnapshotsForScan, scanBatchTickBinding } from "./lib/cortex-decision-snapshot.js";
import { allocationContextWithExactCortexPaperBridge } from "./lib/cortex-paper-allocation-bridge.js";
import { buildPaperOrderOwnershipIndex } from "./lib/paper-order-ownership-index.js";
import { buildLiveIntentIndexByPaperOrderId } from "./lib/live-intent-index.js";
import { cortexProductionChainDiagnostics, recordCortexProductionChainDiagnostic } from "./lib/cortex-production-chain-diagnostics.js";
import { standaloneCortexShadowAllowed } from "./lib/cortex-instance-diagnosis.js";
import { runFourBrainShadowCycle } from "./lib/four-brain-live-wiring.js";
import { classifyIncumbentLanes } from "./lib/four-brain-lane-support.js";
import { buildLaneContextSnapshotInputs } from "./lib/lane-context-snapshot-source.js";
import {
  computeDepthImbalance,
  computeExpectedSlippageBps,
  computeSpreadBps,
  parseDepthPayload,
} from "./lib/order-flow-microstructure.js";
import { fetchGdeltDocEventRisk } from "./lib/four-brain-gdelt-doc-event-risk.js";
import { fetchGoogleNewsRssEventRisk } from "./lib/four-brain-google-news-rss-event-risk.js";
import { journalLaneSnapshots, laneJournalActive } from "./lib/lane-context-journal-runtime.js";
import { FourBrainMetricsAggregator } from "./lib/four-brain-metrics.js";
import {
  FourBrainRecentDecisionsBuffer,
  hydrateFourBrainRecentDecisionsBuffer,
  wrapFourBrainJournalAppendForRecentDecisions,
} from "./lib/four-brain-recent-decisions.js";
import {
  FourBrainOutcomeLedger,
  rehydrateFourBrainOutcomeLedgerFromJournals,
  wrapFourBrainJournalAppendForOutcomeLedger,
  type FourBrainOutcomeHorizon,
} from "./lib/four-brain-outcome-ledger.js";
import { buildExecutiveDecisionRecord } from "./lib/four-brain-journal.js";
import { loadPendingLedgerSnapshot, savePendingLedgerSnapshot } from "./lib/four-brain-pending-ledger-store.js";
import {
  buildFourBrainGatherInput,
  fourBrainInstanceAllowed,
  fourBrainShadowActive,
  FOUR_BRAIN_LIVE_INSTANCE_PORT,
  makeEntryMicrostructureAccessor,
  marketLiquidityScoreFromExecutionCost,
  resolveFourBrainInstanceId,
  type EntryOrderflowSnapshot,
  type FourBrainBindingDeps,
} from "./lib/four-brain-live-gather-bindings.js";
import { assembleFourBrainTick, FRESHNESS_TTL_MS } from "./lib/four-brain-live-gather.js";
import { evaluateFourBrainPreEntryCandidate } from "./lib/four-brain-shadow-tick.js";
import { staticAllocationContext, unavailableMarketContext } from "./lib/authority-contract.js";
import { ExecutiveReviewStore } from "./lib/executive-review-store.js";
import { attachExecutiveReviewToExactPaperOrder } from "./lib/executive-review-admission.js";
import { markTerminalExecutiveReviewsTier2Only } from "./lib/executive-review-runtime.js";
import { MarketContextSnapshotStore } from "./lib/market-context-snapshot-store.js";
import { fourBrainMode } from "./lib/four-brain-types.js";
import { getBtcAtrPercentileCacheStore, refreshBtcAtrPercentileCache, BTC_ATR_PERCENTILE_SYMBOL, BTC_ATR_PERCENTILE_INTERVAL, BTC_ATR_PERCENTILE_CANDLES_NEEDED } from "./lib/btc-atr-percentile-cache.js";
import { buildLiveBestLaneReportForDirection } from "./lib/four-brain-best-lane-report.js";
import { getLiveMarkPriceCacheStore, refreshLiveMarkPriceCache } from "./lib/live-mark-price-cache.js";
import {
  CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID,
  CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
  CORTEX_LANE_ROSTER,
  gatherCortexContext,
  normalizeCortexStaticWeightPctForLane,
} from "./lib/cortex-live-gather.js";
import { buildLiveCortexGatherDeps } from "./lib/cortex-live-gather-bindings.js";
import { getCortexRealAttributionStore } from "./lib/cortex-real-attribution.js";
import { getExecutionFillRecorder } from "./lib/execution-fill-recorder.js";
import { getPositionPathRecorder } from "./lib/position-path-recorder.js";
import { getFourBrainActualFillBindingStore, type FourBrainActualFillBindingStore } from "./lib/four-brain-actual-fill-binding.js";
import { getFourBrainExecutionReinforcement, type FourBrainExecutionReinforcementStatus } from "./lib/four-brain-execution-reinforcement.js";
import {
  FourBrainTestnetBridge,
  normalizeFourBrainTestnetLane,
  type FourBrainBridgeCandidate,
} from "./lib/four-brain-testnet-bridge.js";
import { resolveFourBrainExactFillCohortSinceMs } from "./lib/four-brain-testnet-cohort.js";
import { getDirectionEntryOutcomeStore, buildDirectionEntryOutcomeReport, DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE, type DirectionEntryOutcomeReport } from "./lib/direction-entry-outcome-store.js";
import {
  runDirectionEntryReconciliationCycleGuarded,
  directionEntryReconcilerActive,
} from "./lib/direction-entry-reconciler.js";
import { ENTRY_TIER2_HORIZON_BARS, ENTRY_TIER2_WAIT_WINDOW_BARS } from "./lib/entry-brain-tier2-simulated-resolver.js";
import { runCortexNightlyRefit, getLatestCortexRefitReport } from "./lib/cortex-refit-runner-bindings.js";
import {
  estimateLaneSelectorV2Regime,
  isLaneSelectorV2LongWideStopOverride,
} from "./lib/lane-selector-v2.js";
import {
  buildRegimeRotationShortlistReport,
  rotationShortlistDecision,
  rotationShortlistFamilyHasSymbols,
} from "./lib/regime-rotation-shortlist.js";
import {
  UnifiedTestnetOrchestrator,
  UnifiedTestnetOrchestratorStore,
  isUnifiedTestnetOrchestratorEnabled,
  type UnifiedDirection,
  type UnifiedFeatureVote,
} from "./lib/unified-testnet-orchestrator.js";
import { UnifiedTestnetProposalStore } from "./lib/unified-testnet-proposal-source.js";

export interface AppOptions {
  fetchImpl?: typeof fetch;
  kronosBaseUrl?: string;
  /** Optional local-only Python sidecar. It is advisory and testnet-gated below. */
  challengerBaseUrl?: string;
  notificationDataDir?: string;
  notificationService?: NotificationService;
}

const DEFAULT_KRONOS_BASE_URL = "http://localhost:8001";

/**
 * Exit Brain's MAE convention is a signed adverse R: 0 when a position has never gone adverse and
 * negative below entry. The engine already persists that convention, while the two executor stores
 * deliberately retain a positive magnitude for their own reports. Convert only at the Four-Brain
 * read boundary, preserving each executor's stored schema and never manufacturing a path sample.
 */
export function normalizeFourBrainMaeR(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 ? -value : value;
}

/**
 * Pure builder for the four-brain shadow-tick EXECUTIVE_DECISION journal context. Bug fix: the
 * `runFourBrainShadowCycle` call site below used to supply NO `journalContext` at all, so every
 * EXECUTIVE_DECISION record ever appended to data/four-brain-decision-journal.jsonl carried
 * instanceId/rawFeatures/normalizedFeatures/sourceStatuses/missingReasons/incumbent as hard `null` — the
 * audit trail this layer exists to build was silently incomplete. This turns the EXACT gather-deps
 * snapshot the tick's brains just consumed (captured by the call site, never re-derived/re-fetched) into
 * the journal's provenance fields. Exported + pure (zero I/O) so it is directly unit-testable with plain
 * fixture objects. Every MISSING/FRESH classification + missingReason mirrors the SAME known-unavailable
 * sources already documented at their source in buildFourBrainDeps (sentiment/crowdAlignLong/kronosAgree
 * have no live sync producer today; btcAtrPercentile now DOES — see BtcAtrPercentileCacheStore — so it
 * classifies FRESH/MISSING on that cache's own populated state instead) — never fabricated.
 */
export function buildFourBrainJournalContext(
  base: Pick<
    FourBrainBindingDeps,
    | "instanceId"
    | "axisScore"
    | "axisSlopePerHour"
    | "btcAtrPercentile"
    | "advancersPct"
    | "sentiment"
    | "regimeRaw"
    | "controllerBias"
    | "convictionScore"
    | "allowsLong"
    | "allowsShort"
    | "crowdAlignLong"
    | "kronosAgree"
    | "chronos2Agree"
    | "timesfmAgree"
    | "killLatched"
    | "killReason"
    | "openPositions"
    | "openSignals"
  >,
  activeAllocation: { laneId: string; weightPct: number }[],
): Record<string, unknown> {
  const missingReasons: Record<string, string> = {};
  if (base.axisScore == null) missingReasons.axisScore = "no regime-axis snapshot available yet";
  if (base.advancersPct == null) missingReasons.breadth = "no regime-engine snapshot available yet";
  if (base.regimeRaw == null) missingReasons.regimeRaw = "no regime classification available yet";
  if (base.btcAtrPercentile == null) {
    missingReasons.btcAtrPercentile = "BTC ATR-percentile cache not yet warm (first refresh pending) or refresh persistently failing";
  }
  if (base.sentiment == null) missingReasons.sentiment = "no market-wide sentiment producer (sync-safe)";
  if (base.crowdAlignLong == null) missingReasons.crowdAlignLong = "no sync crowd-align producer";
  if (base.kronosAgree == null) missingReasons.kronosAgree = "no sync kronos-agree producer";
  if (base.chronos2Agree == null) missingReasons.chronos2Agree = "Chronos-2 challenger unavailable, neutral, or not yet warm";
  if (base.timesfmAgree == null) missingReasons.timesfmAgree = "TimesFM challenger unavailable, neutral, or not yet warm";

  const sourceStatuses: Record<string, string> = {
    axisScore: base.axisScore != null ? "FRESH" : "MISSING",
    axisSlopePerHour: base.axisSlopePerHour != null ? "FRESH" : "MISSING",
    breadth: base.advancersPct != null ? "FRESH" : "MISSING",
    regimeRaw: base.regimeRaw != null ? "FRESH" : "MISSING",
    btcAtrPercentile: base.btcAtrPercentile != null ? "FRESH" : "MISSING",
    sentiment: base.sentiment != null ? "FRESH" : "MISSING",
    crowdAlignLong: base.crowdAlignLong != null ? "FRESH" : "MISSING",
    kronosAgree: base.kronosAgree != null ? "FRESH" : "MISSING",
    chronos2Agree: base.chronos2Agree != null ? "FRESH" : "MISSING",
    timesfmAgree: base.timesfmAgree != null ? "FRESH" : "MISSING",
  };

  return {
    instanceId: base.instanceId,
    rawFeatures: {
      regimeRaw: base.regimeRaw,
      axisScore: base.axisScore,
      axisSlopePerHour: base.axisSlopePerHour,
      advancersPct: base.advancersPct,
      btcAtrPercentile: base.btcAtrPercentile,
      sentiment: base.sentiment,
      crowdAlignLong: base.crowdAlignLong,
      kronosAgree: base.kronosAgree,
      chronos2Agree: base.chronos2Agree,
      timesfmAgree: base.timesfmAgree,
      convictionScore: base.convictionScore,
      controllerBias: base.controllerBias,
      killLatched: base.killLatched,
      killReason: base.killReason,
      openPositionCount: base.openPositions.length,
      openSignalCount: base.openSignals.length,
    },
    normalizedFeatures: {
      axisScore: base.axisScore,
      axisSlopePerHour: base.axisSlopePerHour,
      advancersPct: base.advancersPct,
      convictionScore: base.convictionScore,
      allowsLong: base.allowsLong,
      allowsShort: base.allowsShort,
      chronos2Agree: base.chronos2Agree,
      timesfmAgree: base.timesfmAgree,
    },
    sourceStatuses,
    missingReasons,
    incumbent: {
      laneAllocations: activeAllocation,
      controllerBias: base.controllerBias,
      allowsLong: base.allowsLong,
      allowsShort: base.allowsShort,
      killLatched: base.killLatched,
      killReason: base.killReason,
    },
  };
}

/**
 * Execution readiness may relax maturity only after the order has an actual canonical proof unit.
 * This is deliberately independent of operator force, rotation, and mainnet override policy.
 *
 * 2026-08 remediation (gap #2): `applicable`/`direct`/`evidence !== null` alone are NOT sufficient.
 * Every context a lane declares applicable gets an evidence row the moment that lane is evaluated
 * (see the unconditional per-context loop in buildCurrentGuardVariantMatrixReport), so a context
 * with ZERO real observations, or with observations that are ALL legacy-shaped
 * (`exactAxisProof !== true`), still produces a non-null `evidence` row. `evidence.freshValid` is
 * the size of the `fresh` population inside buildContextEvidenceRow, which is filtered on
 * `exactAxisProof === true` (in addition to isFreshValidObs) before anything is counted — so
 * `freshValid > 0` is the practical realization of "at least one real exact-axis-proof observation
 * exists for this exact lane x context" under the current construction. No separate boolean is
 * needed on the evidence row for this; requiring `freshValid > 0` here IS the check. This does not
 * change behavior for a genuinely-proven STABLE_CANDIDATE context: STABLE_CANDIDATE structurally
 * requires `freshValid >= WATCHABLE_MIN_FRESH` (> 0) already, so this only closes the gap for
 * contexts that were never really proven in the first place.
 *
 * Called from exactly one production call site (buildIsPaperOrderLiveEligible below, evaluated
 * once, up front, before any override path — manual, force, rotation, or the explicit unproven
 * override — is even considered), so strengthening this function in place closes gap #2 for every
 * path that reads it, not just the manual-path ordering bug that motivated this remediation.
 */
export function hasExactContextReadinessProof(contextProof: ContextLaneStatusLookup): boolean {
  return (
    contextProof.context !== null &&
    contextProof.applicable === true &&
    contextProof.direct === true &&
    contextProof.evidence !== null &&
    contextProof.evidence.freshValid > 0 &&
    contextProof.status !== "NOT_APPLICABLE"
  );
}

/**
 * The rotation shortlist is a symbol-level REFINEMENT, never a substitute for exact-context lane
 * maturity proof. `isPaperOrderLiveEligible` used to gate this on `liveConfig.env === "mainnet"`
 * only — on any non-mainnet env (testnet, research) the function fell straight through to the
 * rotation-shortlist branch below, so a COLLECTING/WATCHABLE/REJECT lane (or one with missing
 * proof) could be admitted purely because the shortlist happened to ALLOW that symbol. This gate
 * is now environment-independent: it blocks whenever maturity has not been proven and the operator
 * has not set the explicit, visible `LIVE_UNPROVEN_EXECUTION_OVERRIDE=1` escape hatch. It never
 * rewrites or fakes `contextProof.status` — `maturityEligible` is computed upstream from the real
 * evidence status (plus the operator-force / long-wide-stop overrides, which themselves require
 * real `exactContextResolved`/context proof and are left untouched by this gate).
 */
export function paperOrderMaturityGateBlocks(
  maturityEligible: boolean,
  unprovenExecutionOverrideActive: boolean,
): boolean {
  return !maturityEligible && !unprovenExecutionOverrideActive;
}

export interface IsPaperOrderLiveEligibleDeps {
  liveConfig: LiveExecutionConfig;
  getUnifiedOrchestrator: () => UnifiedTestnetOrchestrator | null;
  getLiveEngine: () => LiveExecutionEngine | null;
  getVariantMatrixStore: () => CurrentGuardVariantMatrixStore;
  /**
   * 2026-08 canonical-market-regime redirect: the live canonical snapshot this function's step 3
   * (regimeFamily) and new step 4b (the canonical regime-policy block) both read. Matches the
   * existing getter pattern (`getVariantMatrixStore`, `getUnifiedOrchestrator`, `getLiveEngine`) —
   * a getter, not a plain value, for the same reason those are: buildApp() wires this from a
   * singleton/accessor that may not be fully constructed yet at the moment this factory itself
   * runs. Nullable defensively (the real accessor's own contract never actually returns null — see
   * canonical-market-regime-engine.ts's `getCanonicalMarketRegimeSnapshot`) — canonicalMarketRegimeExecutionPolicy
   * treats null as blocked, never as allowed-by-default (see that module's own header), so a future
   * caller passing null by mistake can never silently widen eligibility.
   */
  getCanonicalMarketRegimeSnapshot: () => CanonicalMarketRegimeSnapshot | null;
}

/**
 * 2026-08 remediation: this is the REAL body of the `isPaperOrderLiveEligible` closure that
 * buildApp() wires into LiveExecutionEngine (invoked at live-execution-engine.ts's
 * `paperSourceEligibleForMirror`/mirror-funnel call sites, surfaced there as the "not_live_eligible"
 * mirror-drop reason). It used to be defined ONLY inline inside buildApp(), so the only test that
 * ever existed for the env-independence fix (`paperOrderMaturityGateBlocks`, above) exercised the
 * extracted pure gate with hand-picked booleans and never this wiring — a mutation reinstating the
 * original `liveConfig.env === "mainnet" &&` restriction right here left the whole suite green.
 * Extracted (byte-identical logic, same free variables now passed as `deps`) purely so a test can
 * construct this SAME function with a real, non-mainnet `liveConfig` and a real
 * `CurrentGuardVariantMatrixStore` and call it directly — buildApp() below calls this with its own
 * live singletons/getters, unchanged in every observable way. `getUnifiedOrchestrator`/`getLiveEngine`
 * are getters, not plain values, because buildApp() assigns those `let` bindings AFTER this factory
 * runs (this factory is called from inside the very `new LiveExecutionEngine({...})` call that
 * assigns `liveEngine`) — the original inline closure read them from the enclosing scope at
 * INVOCATION time (when the mirror actually runs), and getters preserve that exactly.
 *
 * 2026-08 remediation (defect 1 — ordering): the exact-context proof gate used to sit AFTER the
 * manual-entry early return, so any order admitted by operator manual directional mode never
 * reached it — manual mode could open a lane x context with NO real proof behind it at all (no
 * observations, or only legacy-shaped ones). The gate now runs FIRST, right after the two
 * lane-identity branches that must precede it. Current, authoritative top-to-bottom order:
 *   1. unifiedOrchestrator delegation — unchanged.
 *   2. isProfitCoreShortLaneId — MUST run before the proof gate: this lane is deliberately absent
 *      from VARIANT_MATRIX_DEFINITIONS (it is a separate OOS forward test, not a variant-matrix
 *      lane) and would always fail the proof gate if judged against one.
 *   3. laneVariantId / orderEstimatedRegime / regimeFamily / exactContext / contextProof — computed
 *      once, up front, from `order` (and the report) alone. 2026-08 canonical-market-regime
 *      redirect: `regimeFamily` now comes from a live lookup of `deps.getCanonicalMarketRegimeSnapshot()`
 *      instead of being re-derived from the frozen `order.regime` string (producer A). See the code
 *      comment at this step's own definition below for the full rationale; `orderEstimatedRegime`
 *      itself is UNCHANGED and still computed the same way, since steps 8/9 still read its
 *      `.direction` field, not `regimeFamily`.
 *   4. hasExactContextReadinessProof(contextProof) — the hard existence boundary. Computed and
 *      checked ONCE; nothing below recomputes exactContext/contextProof.
 *  4b. 2026-08 canonical-market-regime addition (requirement #8): `canonicalMarketRegimeExecutionPolicy`
 *      — an ADDITIONAL, independent AND-ed gate (LOW_COVERAGE/PANIC), never a replacement for step 4
 *      or anything below. Deliberately placed BEFORE step 5 (manual entry): unlike step 5's
 *      "regime-policy blockers" reference below (which is the PRE-EXISTING step 8 MIXED-NEARUSDT
 *      check, still bypassed by manual mode exactly as before), THIS new block is NOT bypassable by
 *      manual mode — a manually-selected entry must not be able to open through a market-wide PANIC
 *      or data-quality blackout the automated paths already refuse, mirroring how armed/killed/drain
 *      inside canOpenNewEntries() also has no manual-mode exemption. This is a real, intentional
 *      behavior change (an operator's manual override can now be blocked here where it previously
 *      could not), not a silent side effect. This block never itself checks
 *      armed/kill/drain/caps/reconciliation/exchange-filters/protective-exits — see
 *      canonical-market-regime-execution-policy.ts's own header for that boundary.
 *   5. isManualEntryAllowedForPaper — now gated behind steps 4 AND 4b, so manual mode still bypasses
 *      the PRE-EXISTING step 8 MIXED-regime/NEARUSDT lane-book restriction (its own, narrower job)
 *      but can never bypass proof EXISTENCE (step 4) or the new canonical regime-policy block (4b).
 *   6. useTestnetPolicy / manuallySelected — pure, unchanged.
 *   7. realtime-short lane-id gate — unchanged.
 *   8. MIXED-regime NEARUSDT block — unchanged.
 *   9. forceEligibleForDirection / authorizedLongWideOverride / maturityEligible /
 *      paperOrderMaturityGateBlocks — unchanged logic, now reading the contextProof from step 3.
 *  10. rotation-shortlist logic — unchanged (rotationShortlist itself is still derived from
 *      `report`, just built lazily right before this step instead of alongside `report` in step 3,
 *      since nothing before step 10 reads it — a side-effect-free deferral, not a behavior change).
 * For every input where NO override (manual/force/authorized-override/unproven-override) is active,
 * this reordering changes nothing observable: every gate that returns `false` still returns `false`
 * for the exact same reason, just resequenced among other `false`-returning checks. In particular, a
 * genuinely-proven STABLE_CANDIDATE context with no override active reaches the exact same
 * maturityEligible/rotation computation as before, fed the exact same values. The only behavior
 * changes are: (a) manual entry (and, incidentally, force/rotation/unproven-override, which already
 * ran after this gate) can no longer proceed against a context with zero genuine exact-axis-proof
 * observations — see hasExactContextReadinessProof's own doc comment for gap #2; (b) a
 * manually-selected PROFIT_CORE_SHORT_TRAIL order outside testnet+SHORT — previously admissible via
 * the manual override, since isManualEntryAllowedForPaper itself checks neither `liveConfig.env` nor
 * direction against that lane's own restriction — can no longer be, because isProfitCoreShortLaneId's
 * unconditional check now runs before the manual check for that lane id specifically; and (c), new
 * this round, manual entry (and force/rotation/unproven-override) can no longer proceed while the
 * canonical regime engine reports LOW_COVERAGE or PANIC (step 4b) — this is a materially larger
 * blast radius than (a)/(b) since it can block ANY lane/context/override, not just unproven ones,
 * whenever the market-wide snapshot itself is untrustworthy or in a declared panic. (a), (b), and
 * (c) are direct, intended consequences of the required ordering above, not incidental ones.
 */
export function buildIsPaperOrderLiveEligible(
  deps: IsPaperOrderLiveEligibleDeps,
): (order: PaperOrder) => boolean {
  return (order) => {
    const { liveConfig } = deps;
    const unifiedOrchestrator = deps.getUnifiedOrchestrator();
    const liveEngine = deps.getLiveEngine();
    if (unifiedOrchestrator?.isEnabled()) {
      return unifiedOrchestrator.allowsPaperOrder({
        selectedLaneId: order.selectedLaneId,
        direction: order.direction,
      });
    }
    if (isProfitCoreShortLaneId(order.selectedLaneId)) {
      // The new lane is an OOS forward test, not a backdoor around mainnet's proven-only gate.
      // MUST run before the exact-context proof gate below: this lane is deliberately absent from
      // VARIANT_MATRIX_DEFINITIONS (see laneStatusForContext's `!definition` branch), so it can
      // never carry an exact proof context — gating it on context-proof would permanently and
      // silently disable this lane's entire testnet forward test. Also, deliberately, MUST run
      // before the manual-entry check below: isManualEntryAllowedForPaper does not itself restrict
      // by env or direction, so this lane's own testnet+SHORT-only restriction must be checked first.
      return liveConfig.env === "testnet" && order.direction === "SHORT";
    }
    // Exact applicability is a hard execution boundary, computed once and checked immediately,
    // before ANY override path (manual, force, rotation, or the explicit unproven override) is even
    // considered. Those paths may relax MATURITY only; none may invent, borrow, or bypass a proof
    // context or a genuine exact-axis-proof observation population (see
    // hasExactContextReadinessProof's own doc comment for the freshValid>0 requirement).
    const report = buildCurrentGuardVariantMatrixReport(deps.getVariantMatrixStore());
    const laneVariantId = order.selectedLaneId.split(":").pop() ?? order.selectedLaneId;
    // orderEstimatedRegime is STILL computed here, unchanged — step 8's MIXED-NEARUSDT block and
    // step 9's forceEligibleForDirection/authorizedLongWideOverride read orderEstimatedRegime.direction,
    // not regimeFamily, and must keep doing so unchanged (see this function's own top-of-file doc).
    const orderEstimatedRegime = estimateLaneSelectorV2Regime({
      regime: order.regime,
      controllerMode: order.controllerMode,
      confidence: order.controllerConfidence ?? null,
    });
    // 2026-08 canonical-market-regime redirect: regimeFamily now comes from a LIVE lookup of the
    // canonical engine's snapshot at evaluation time, not a re-derivation of the FROZEN order.regime
    // string (producer A, stamped once at order-creation — routes/scan.ts's `regime:
    // result.marketRegime` — order.regime itself is untouched and still stored for history/display).
    // estimateLaneSelectorV2Regime/rotationRegimeFamilyForLabel are no longer called for
    // regime-FAMILY purposes here (rotationRegimeFamilyForLabel is no longer called at all in this
    // function); orderEstimatedRegime.direction above is a separate, still-legitimate use. A
    // missing/never-ticked snapshot resolves to "UNKNOWN" — never a silent fallback to any real
    // family — which structurally fails exactLaneContextFor below (it has no UNKNOWN branch),
    // matching this whole rollout's fail-closed discipline.
    const regimeFamily = deps.getCanonicalMarketRegimeSnapshot()?.regimeFamily ?? "UNKNOWN";
    const exactContext = exactLaneContextFor(order.direction, regimeFamily);
    const contextProof = laneStatusForContext(
      report,
      laneVariantId,
      exactContext,
    );
    if (!hasExactContextReadinessProof(contextProof)) return false;
    // 2026-08 canonical-market-regime addition (requirement #8) — see this function's own
    // top-of-file doc, step 4b. An ADDITIONAL, independent AND-ed gate, never a replacement for the
    // proof-existence check above or anything below. Placed here (before manual-entry) deliberately:
    // a manually-selected entry must not be able to bypass a market-wide PANIC or LOW_COVERAGE
    // blackout the automated paths already refuse — mirrors how armed/killed/drain inside
    // canOpenNewEntries() also has no manual-mode exemption. This check never itself reads
    // armed/kill/drain/caps/reconciliation/exchange-filters/protective-exits — see
    // canonical-market-regime-execution-policy.ts's own header for that boundary; it can only ADD
    // restriction on top of whatever those (unrelated, untouched) gates already decided elsewhere.
    const canonicalRegimeDecision = canonicalMarketRegimeExecutionPolicy({
      snapshot: deps.getCanonicalMarketRegimeSnapshot(),
      nowMs: Date.now(),
    });
    if (!canonicalRegimeDecision.allowed) return false;
    // Operator manual directional mode is a narrow admission override: it may bypass maturity,
    // book, and regime-policy blockers only for the currently selected Entry Decision side and
    // explicitly selected lane. The engine still enforces freshness, geometry, caps, and all
    // exchange/account safety before it can open anything. Runs AFTER the exact-context proof gate
    // above: manual entry must never admit an order for a lane x context with no real,
    // exact-axis-proof observations at all. ("regime-policy blockers" here refers to the PRE-
    // EXISTING step 8 MIXED-NEARUSDT check further below, which manual mode still bypasses exactly
    // as before — NOT the new canonical regime-policy block just above, which manual mode can never
    // bypass; see step 4b's own comment.)
    if (liveEngine?.isManualEntryAllowedForPaper(order)) return true;
    const useTestnetPolicy =
      liveConfig.env === "testnet" ||
      (liveConfig.env === "mainnet" && liveConfig.mainnetKeepTestnetPolicy);
    const manuallySelected = liveEngine?.laneSelectionExplicitlyIncludesLane(order.selectedLaneId) ?? false;
    if (
      useTestnetPolicy &&
      !(
        isRealtimeShortAllowedLaneId(order.selectedLaneId) ||
        isRealtimeShortSelectableLaneId(order.selectedLaneId, manuallySelected)
      )
    ) return false;
    if (
      useTestnetPolicy &&
      orderEstimatedRegime.direction === "MIXED" &&
      order.symbol.toUpperCase() === "NEARUSDT"
    ) {
      return false;
    }
    const forceEligibleForDirection = isForceEligibleForDirection(order.direction, laneVariantId);
    const authorizedLongWideOverride = isLaneSelectorV2LongWideStopOverride({
      variantId: laneVariantId,
      direction: order.direction,
      estimatedRegime: orderEstimatedRegime,
    });
    const maturityEligible =
      contextProof.status === "STABLE_CANDIDATE" ||
      forceEligibleForDirection ||
      authorizedLongWideOverride;
    if (
      paperOrderMaturityGateBlocks(
        maturityEligible,
        process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE === "1",
      )
    ) return false;
    const rotationShortlist = buildRegimeRotationShortlistReport(report);
    const rotationEligible = rotationShortlistDecision(rotationShortlist, {
      laneId: order.selectedLaneId,
      variantId: laneVariantId,
      symbol: order.symbol,
      direction: order.direction,
      regimeFamily,
    }).allowed;
    const rotationGateActive =
      (order.direction === "LONG" && regimeFamily === "BULLISH") ||
      (order.direction === "SHORT" && regimeFamily === "BEARISH");
    if (rotationGateActive) {
      if (rotationEligible) return true;
      // 2026-07-08: the shortlist is built from THIS instance's own VM book. Live never
      // accrues VM observations, so in an extended regime its shortlist is structurally
      // EMPTY and vetoed every candidate (`symbol_not_shortlisted` on all symbols → zero
      // trades under FAST_SHORT 100%). Empty-because-no-data is not "no good symbols":
      // fall back to the /research curation whitelist (the operator's mandated brain) —
      // still proven-symbols-only (tier ≤ 1), never a free pass.
      if (!rotationShortlistFamilyHasSymbols(rotationShortlist, regimeFamily)) {
        const curationCache = getLaneSymbolCurationCacheStore().get();
        const tier = symbolPriorityTier(
          order.symbol,
          order.direction,
          order.selectedLaneId,
          curationCache?.report ?? null,
          curationCache?.fetchedAt ?? null,
          (process.env.LANE_SYMBOL_CURATION_TIER as LaneSymbolCurationTier | undefined) ?? null,
        );
        return tier <= 1;
      }
      return false;
    }
    return maturityEligible;
  };
}

export interface UnifiedRegimeEntryGateDeps {
  getUnifiedOrchestrator: () => UnifiedTestnetOrchestrator | null;
  /**
   * 2026-08 canonical-market-regime redirect: the live canonical snapshot this gate now consults
   * instead of regime-engine-service's own snapshot store. Matches the exact getter-pattern
   * `IsPaperOrderLiveEligibleDeps.getCanonicalMarketRegimeSnapshot` already uses above — in
   * production buildApp() wires BOTH from the SAME single shared accessor
   * (`getCanonicalMarketRegimeSnapshot`, defined once inside buildApp()), never two independently
   * duplicated placeholders that could silently drift apart.
   */
  getCanonicalMarketRegimeSnapshot: () => CanonicalMarketRegimeSnapshot | null;
  /** Injectable for tests; defaults to the real `process.env` (same convention
   *  `isInnovationTestnetExecutionEnabled`'s own `env` parameter already uses). */
  env?: NodeJS.ProcessEnv;
}

/**
 * 2026-08 canonical-market-regime rollout — extracted, testable body of the master
 * `unifiedRegimeEntryGate` closure buildApp() wires as `newEntryGate` into LiveExecutionEngine. This
 * IS the shared master gate underneath `canOpenNewEntries()` /
 * `canOpenNewEntriesIgnoringManualDirectional()` — LiveExecutionEngine's own paper mirror
 * (`mirrorNewSignals` starts `if (!this.canOpenNewEntries()) return;`), SingleSymbolLaneExecutor
 * (via `newExecutorLaneGate` -> `engine.canOpenNewEntries()`, live-executor-wiring.ts), CrossSectionalExecutor
 * (MARKET_NEUTRAL and the admission-independent TREND/MIXED variants), and every innovation testnet
 * executor all inherit whatever this function decides — changing it here propagates to all of them
 * automatically, with no per-lane code change required.
 *
 * Extracted (mirroring `buildIsPaperOrderLiveEligible`'s own precedent immediately above, for the
 * identical reason) because this closure used to be defined ONLY inline inside buildApp() —
 * unexported and untested; no test file has ever referenced it by name. The hard rule that every fix
 * needs a fail-without/pass-with test cannot be met against an inline closure with no way to
 * construct it against hand-built fixtures, so this stage extracts it the same way: byte-identical
 * logic, same free variables now passed as `deps`. buildApp() below calls
 * `buildUnifiedRegimeEntryGate({...})` with its own live singletons/getters and wires the returned
 * zero-arg closure exactly where the inline version used to sit
 * (`newEntryGate: unifiedRegimeEntryGate`), unchanged in every observable way.
 *
 * 2026-08 canonical-market-regime redirect (this round's actual behavior change): the body used to
 * read regime-engine-service's OWN snapshot store (`getRegimeEngineStore().snapshots`) directly —
 * staleness against `LIVE_REGIME_GATE_MAX_AGE_MS` and an `action === "NO_TRADE"` check. It now
 * consults the ONE canonical engine's shared `canonicalMarketRegimeExecutionPolicy` decision instead,
 * so there is genuinely one provider gating entries, not two independent ones that could disagree.
 * regime-engine-service.ts, detectRegime.ts, and regime-autopilot.ts are completely untouched by this
 * redirect — regime-engine-service.ts keeps recording its own snapshots exactly as before
 * (RegimeAutopilot still reads them for lane-ALLOCATION weighting, unchanged, out of scope this
 * round); this call site simply stops READING them for the entry-eligibility decision, which
 * incidentally makes that module's own "report-only, never wired to execution" header comment
 * accurate again rather than aspirational.
 *
 * The two existing escape hatches (`LIVE_REGIME_NO_TRADE_OVERRIDE=1`,
 * `REGIME_ENGINE_EXECUTION_GATE_ENABLED=0`) keep their exact names/positions/semantics, still
 * short-circuiting BEFORE the (now-redirected) canonical-regime check — an operator relying on
 * either today sees no behavior change from this redirect UNLESS they are on the live instance
 * (3103), where 2026-08's regime-escape-hatch hardening (see
 * `regimeGateEscapeHatchAllowedOnInstance` immediately below) now hard-blocks both, structurally,
 * regardless of what either env var is set to.
 */

/**
 * 2026-08 regime-escape-hatch hardening. Both `LIVE_REGIME_NO_TRADE_OVERRIDE` and
 * `REGIME_ENGINE_EXECUTION_GATE_ENABLED=0` are pre-existing, deliberate operator escape hatches
 * that fully disable canonical-regime new-entry protection — but as originally written they were
 * honored identically on every instance, including 3103 (the one real-money mainnet box), with no
 * visibility, expiry, or audit trail. Investigation found zero evidence anywhere in this repo's
 * history, comments, tests, or docs that 3103 has ever legitimately relied on either var (both were
 * introduced as an undiscussed one-liner buried in an unrelated batch commit), so this hard-removes
 * eligibility on 3103 specifically rather than adding a reason/expiry/audit fallback — matching the
 * repo-wide convention (`fourBrainInstanceAllowed`, `crisis-mode-instance-guard.ts`'s
 * `canApplyCrisisModeActions`) that any authority/execution-risk concern hard-blocks 3103
 * unconditionally, never via an overridable exception.
 *
 * Reuses `resolveFourBrainInstanceId`/`FOUR_BRAIN_LIVE_INSTANCE_PORT` — the SAME instance-identity
 * resolver five other modules in this repo already import by direct reference for exactly this kind
 * of "am I 3103" check (forward-causal-collection.ts, lane-context-journal-binding.ts,
 * cortex-collection-status.ts, direction-entry-reconciler.ts, cortex-instance-diagnosis.ts) — never
 * reimplemented, so this can never independently drift from the one place that already tracks it.
 * Deliberately does NOT call `fourBrainInstanceAllowed()` itself: that additionally applies
 * `FOUR_BRAIN_INSTANCE_ALLOWLIST`, a four-brain-specific config knob unrelated to this gate — reusing
 * it here would silently couple an operator's four-brain allowlist edit to this gate's escape-hatch
 * eligibility.
 *
 * Belt-and-suspenders (mirrors `fourBrainInstanceAllowed`'s own dual check): blocks if EITHER the
 * resolved instance id OR the raw serving `PORT` is 3103, so a stray `FOUR_BRAIN_INSTANCE_ID` that
 * relabels the live box can never smuggle the escape hatch back onto real money. Fails closed on a
 * missing `PORT` too — `resolveFourBrainInstanceId` falls back to `FOUR_BRAIN_DEFAULT_PORT` ("3101"),
 * matching `server.ts`'s own `Number(process.env.PORT ?? 3101)` default, so an unset-PORT process is
 * correctly treated as 3101 (override-eligible), never as an unrecognized/blocked id.
 */
export function regimeGateEscapeHatchAllowedOnInstance(env: NodeJS.ProcessEnv): boolean {
  const instanceId = resolveFourBrainInstanceId(env);
  const rawPort = (env.PORT ?? "").toString().trim();
  return instanceId !== FOUR_BRAIN_LIVE_INSTANCE_PORT && rawPort !== FOUR_BRAIN_LIVE_INSTANCE_PORT;
}

export function buildUnifiedRegimeEntryGate(
  deps: UnifiedRegimeEntryGateDeps,
): () => LiveNewEntryGateDecision {
  return () => {
    const unifiedOrchestrator = deps.getUnifiedOrchestrator();
    if (unifiedOrchestrator?.isEnabled() && !unifiedOrchestrator.canOpenNewEntries()) {
      const status = unifiedOrchestrator.getStatus();
      return {
        allowed: false,
        reason: `unified orchestrator ${status.brainState}: ${status.lastTrace?.reason ?? "direction not confirmed"}`,
      };
    }
    const env = deps.env ?? process.env;
    if (
      regimeGateEscapeHatchAllowedOnInstance(env) &&
      (env.LIVE_REGIME_NO_TRADE_OVERRIDE === "1" || env.REGIME_ENGINE_EXECUTION_GATE_ENABLED === "0")
    ) {
      return { allowed: true, reason: null };
    }
    const decision = canonicalMarketRegimeExecutionPolicy({
      snapshot: deps.getCanonicalMarketRegimeSnapshot(),
      nowMs: Date.now(),
    });
    return { allowed: decision.allowed, reason: decision.reason };
  };
}

export interface ManualDirectionalRegimeSafetyGateDeps {
  /** Same shared, single accessor every other canonical-regime consumer in this file uses (see
   *  UnifiedRegimeEntryGateDeps's/IsPaperOrderLiveEligibleDeps's own identical field) — buildApp()
   *  wires this from the ONE `getCanonicalMarketRegimeSnapshot` closure variable it defines once. */
  getCanonicalMarketRegimeSnapshot: () => CanonicalMarketRegimeSnapshot | null;
}

/**
 * 2026-08 manual-directional canonical-regime enforcement fix.
 * `LiveExecutionEngine.canOpenNewEntries()`'s manual-directional branch (live-execution-engine.ts)
 * used to short-circuit straight to `isManualDirectionalEntryEnabled()` — a maturity/proof-boundary
 * check only — and never reached `strategyEntryGate()`/`newEntryGate()` (`buildUnifiedRegimeEntryGate`
 * above), the ONLY path that otherwise consults `canonicalMarketRegimeExecutionPolicy` for new-entry
 * admission. That meant an operator's manual directional selection could open through a market-wide
 * PANIC or a LOW_COVERAGE data blackout that every non-manual lane already refuses. Manual mode is
 * meant to relax MATURITY only (skip "has this lane proven itself enough" checks) — never
 * account-risk or market-state safety checks; see this task's own design note.
 *
 * This factory is a second, independent, narrower gate dedicated to that one branch — modeled
 * byte-for-byte on `buildIsPaperOrderLiveEligible`'s own step 4b above (an unconditional,
 * un-escape-hatched call to `canonicalMarketRegimeExecutionPolicy`), the already-shipped precedent
 * for the identical problem on the paper-mirror path (landed `72b9a1a`). Deliberately NOT
 * `buildUnifiedRegimeEntryGate` itself (left byte-identical and untouched, so its own existing
 * structural/behavioral test coverage stays valid) and deliberately NOT honoring
 * `LIVE_REGIME_NO_TRADE_OVERRIDE`/`REGIME_ENGINE_EXECUTION_GATE_ENABLED` (those two escape hatches
 * only ever existed inside `buildUnifiedRegimeEntryGate`'s own tail) — this is strictly MORE
 * conservative, never less safe, than either existing gate.
 *
 * Wired into `LiveExecutionEngine`'s new `regimeSafetyGate` option (live-execution-engine.ts) and
 * AND-ed there with the pre-existing `isManualDirectionalEntryEnabled()` check inside
 * `canOpenNewEntries()`'s manual branch — see that method's own doc comment. For any input, the new
 * combined result being `true` implies the old (maturity-only) result was already `true`: this can
 * only ever narrow what manual mode admits, never widen it.
 */
export function buildManualDirectionalRegimeSafetyGate(
  deps: ManualDirectionalRegimeSafetyGateDeps,
): () => LiveNewEntryGateDecision {
  return () => {
    const decision = canonicalMarketRegimeExecutionPolicy({
      snapshot: deps.getCanonicalMarketRegimeSnapshot(),
      nowMs: Date.now(),
    });
    return { allowed: decision.allowed, reason: decision.reason };
  };
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.get("/api/health", async () => {
    return {
      ok: true,
      service: "daily-trading-cockpit-v2-api",
    };
  });
  // Read-only observability for exact CORTEX chain hand-offs. This endpoint has no control-plane
  // side effects and cannot alter execution, allocation, or the shadow learner.
  app.get("/api/cortex/production-chain-diagnostics", async () => ({
    reportOnly: true,
    counters: cortexProductionChainDiagnostics(),
  }));

  const binanceClient = new BinanceClient(options.fetchImpl);
  const kronosClient = new HttpKronosClient(
    options.kronosBaseUrl ?? process.env.KRONOS_BASE_URL ?? DEFAULT_KRONOS_BASE_URL,
    options.fetchImpl,
  );
  // Do not configure the sidecar by default. The process is additionally gated to
  // the 3102 testnet instance below, so an env copied onto 3103 cannot affect live.
  const challengerBaseUrl =
    options.challengerBaseUrl ??
    (process.env.CORTEX_CHALLENGERS_ENABLED === "1"
      ? process.env.CHALLENGER_BASE_URL ?? "http://127.0.0.1:8002"
      : undefined);
  const chronos2Client = new HttpForecastChallengerClient(
    challengerBaseUrl,
    "chronos2",
    options.fetchImpl,
  );
  const timesfmClient = new HttpForecastChallengerClient(
    challengerBaseUrl,
    "timesfm",
    options.fetchImpl,
  );
  const whaleClient = new BinanceWhaleClient(binanceClient);
  const socialClient = new HttpSocialClient({
    provider: process.env.SOCIAL_SENTIMENT_PROVIDER,
    baseUrl: process.env.SOCIAL_SENTIMENT_URL,
    redditClientId: process.env.REDDIT_CLIENT_ID,
    redditClientSecret: process.env.REDDIT_CLIENT_SECRET,
    redditUserAgent: process.env.REDDIT_USER_AGENT,
    redditSubreddits: process.env.REDDIT_SUBREDDITS,
    fetchImpl: options.fetchImpl,
  });
  const scanService = new ScanService(binanceClient, kronosClient, whaleClient, socialClient);
  const notificationService =
    options.notificationService ??
    new NotificationService({
      dataDir: options.notificationDataDir,
      fetchImpl: options.fetchImpl,
    });

  // Prime the Kronos model before the first scan so the warm-up latency
  // doesn't count against the first user request.
  kronosClient.warmUp().catch(() => {});

  // Disable tracking in test environments to avoid disk I/O during tests.
  const isTest = Boolean(process.env.VITEST);
  // Executive review is strictly shadow-only and is hard-blocked on 3103 by the shared instance guard.
  // Constructing the store does not create a review; only an incumbent producer with exact IDs may do that.
  const executiveReviewStore = !isTest && fourBrainShadowActive(process.env)
    ? new ExecutiveReviewStore("data/executive-review-store.json")
    : null;
  const marketContextSnapshotStore = !isTest && fourBrainShadowActive(process.env)
    ? new MarketContextSnapshotStore("data")
    : null;
  const tracker = isTest ? null : new SignalTracker();
  const performanceProvider = tracker ? new PerformanceStatsProvider(tracker) : null;
  const outcomeChecker = tracker ? new OutcomeChecker(tracker, binanceClient) : null;
  const shadowEngine = isTest || !tracker
    ? null
    : new ShadowExecutionEngine(
        binanceClient,
        () => performanceProvider?.getPerformance().performance ?? null,
      );
  if (shadowEngine && process.env.DECISION_LEDGER_DISABLED !== "1") {
    try {
      shadowEngine.setDecisionLedger(getDecisionLedger(process.env.DECISION_LEDGER_FILE ?? "data/decision-log.jsonl"));
    } catch (err) {
      // ledger wiring is best-effort
      console.error("[app] decision-ledger wiring failed:", err);
    }
  }

  performanceProvider?.warm();

  // Declared here (assigned below) so the shadow routes can READ the live engine's in-memory
  // status (sync getStatus, no I/O) for the order-reconciliation readiness gate, via a lazy getter.
  let liveEngine: LiveExecutionEngine | null = null;
  // Declared here (assigned inside the four-brain `if (!isTest)` block below, from that block's OWN
  // local `const`s — see the "Ref" suffix) so the shadow routes' /api/shadow/four-brain handler can
  // READ the live metrics aggregator + recent-decisions ring buffer via a lazy getter — same threading
  // pattern as `liveEngine` above. Stay null (⇒ the route fails open to an empty/disabled shape) on any
  // instance/test run that never constructs them.
  let fourBrainMetricsRef: FourBrainMetricsAggregator | null = null;
  let fourBrainRecentDecisionsRef: FourBrainRecentDecisionsBuffer | null = null;
  // Scoped testnet-only causal-fill store + the narrow negative-evidence bridge. These remain
  // null everywhere else, so neither mainnet nor research receives an execution dependency.
  let fourBrainActualFillBindingsRef: FourBrainActualFillBindingStore | null = null;
  // Deliberate immutable repair boundary for exact-fill attribution.  The shadow route is
  // registered before live wiring, so it reads this by lazy closure after assignment below.
  let fourBrainExactFillCohortSinceMs: number | null = null;
  let fourBrainTestnetBridgeRef: FourBrainTestnetBridge | null = null;
  /**
   * Report-only pre-submit tap. Its return is ignored by the gate, so this observer can never
   * relax, block, size, or otherwise alter an incumbent entry.
   */
  let fourBrainPreEntryObserverRef: ((candidate: FourBrainBridgeCandidate) => void) | null = null;
  // Same threading pattern, for the Direction/Entry counterfactual outcome reconciler's own report.
  // Stays null (⇒ the route fails open to an empty/disabled shape) unless directionEntryReconcilerActive
  // (its own 3-layer gate — see direction-entry-reconciler.ts) is true on this instance.
  let directionEntryOutcomeReportGetterRef: (() => DirectionEntryOutcomeReport | null) | null = null;
  // Read-only status of the persisted actual-fill feedback that shadow ranking consumes.  Kept as
  // a getter because the isolated testnet cohort data root is chosen later during engine wiring.
  let fourBrainExecutionReinforcementStatusGetterRef: (() => FourBrainExecutionReinforcementStatus | null) | null = null;
  // Read-only capture of the engine's execution store so the report-only four-brain shadow tick can
  // enumerate FULL open intents (getStatus().openIntents is a reduced shape). Assigned during engine
  // construction below; stays null on instances that build no engine (e.g. 3101 research). READ-ONLY —
  // the four-brain path never mutates it.
  let liveExecutionStore: LiveExecutionStore | null = null;
  let crossSectionalExecutor: CrossSectionalExecutor | null = null;
  // 2026-07-08: two more instances mirroring TREND_BETA_VOL / MIXED_MEAN_REVERSION, alongside the
  // FILTERED foundation instance above (see cross-sectional-executor.ts's targetVariant/laneId).
  let crossSectionalTrendExecutor: CrossSectionalExecutor | null = null;
  let crossSectionalMixedExecutor: CrossSectionalExecutor | null = null;
  // Testnet-only directional companions of the market-neutral cross-sectional lane. These use the
  // core scan's existing score/quality evidence and are mutually exclusive with new 3x3 baskets.
  let crossSectionalDirectionalLongExecutor: SingleSymbolLaneExecutor | null = null;
  let crossSectionalDirectionalShortExecutor: SingleSymbolLaneExecutor | null = null;
  let crossSectionalDirectionalDecisionRef = () =>
    buildCrossSectionalDirectionalRegimeDecision(getLatestScanCandidates());
  // 2026-07-08: SHORT_FADE_EXHAUSTION / INTRADAY_MOMENTUM_BREAKOUT — independent, single-symbol
  // measurement lanes with their OWN entry signals (not the shared scanner candidate every CG_*
  // variant rides on), so each gets its own SingleSymbolLaneExecutor instance instead of being
  // forced through the VM/lane-selector-v2 directional-mirror pipeline.
  let shortFadeExecutor: SingleSymbolLaneExecutor | null = null;
  let intradayMomentumExecutor: SingleSymbolLaneExecutor | null = null;
  // 2026-07-09: REGIME_COMPOSITE_CONFIRMATION_LONG — same single-symbol executor pattern, own
  // axis-score + crowding-state entry gate (see regime-composite-edge.ts).
  let regimeCompositeExecutor: SingleSymbolLaneExecutor | null = null;
  let regimeCompositeShortExecutor: SingleSymbolLaneExecutor | null = null;
  // 2026-07-09: COMPOSITE_ESTIMATOR_BIDI — bidirectional (axis level + velocity + Kronos), 4
  // buckets (WIDE_LONG/WIDE_SHORT/FAST_LONG/FAST_SHORT), each its own fixed-direction executor
  // instance fed by ONE shared measurement store filtered per bucket (see composite-estimator-edge.ts).
  let compositeEstimatorWideLongExecutor: SingleSymbolLaneExecutor | null = null;
  let compositeEstimatorWideShortExecutor: SingleSymbolLaneExecutor | null = null;
  let compositeEstimatorFastLongExecutor: SingleSymbolLaneExecutor | null = null;
  let compositeEstimatorFastShortExecutor: SingleSymbolLaneExecutor | null = null;
  // 2026-07-09: PANIC_WASHOUT_RECLAIM_LONG — capitulation/washout/reclaim dip-buy, see
  // panic-washout-reclaim-edge.ts. Wired straight to live on operator's explicit request with ZERO
  // prior measurement of this exact 3-stage signal.
  let panicWashoutExecutor: SingleSymbolLaneExecutor | null = null;
  // Testnet-only bridge from /research observations into the proven exchange executors. These
  // arrays stay empty on research/mainnet, making the feature structurally incapable of touching
  // real-money 3103 even if an innovation flag is accidentally copied there.
  const innovationBasketExecutors: CrossSectionalExecutor[] = [];
  const innovationSingleSymbolExecutors: SingleSymbolLaneExecutor[] = [];
  // Fail-closed campaign control (see innovation-campaign.ts). Unconditional so diagnostics work
  // even when the gate below never fires (mainnet, or INNOVATION_TESTNET_EXEC_DISABLED=1) — same
  // reasoning as allCrossSectionalLaneExecutors() below being safe to reference before any
  // executor is constructed: these closures are only ever CALLED during a tick or an HTTP
  // request, well after every executor below has been constructed and assigned. Engine-agnostic
  // by design — only innovationAllowed() inside the gate further below ANDs in the engine's own
  // canOpenNewEntriesIgnoringManualDirectional(); this pair never references liveEngine at all.
  const innovationCampaignAdmissionForLane = (laneId: string): { allowed: boolean; reason: string | null } =>
    innovationCampaignAdmission(
      loadInnovationCampaign("data", "innovation-campaign.json"),
      laneId,
      computeInnovationExposure(innovationBasketExecutors, innovationSingleSymbolExecutors),
    );
  const innovationCampaignSnapshot = (): InnovationCampaignDiagnostics =>
    buildInnovationCampaignDiagnostics(
      loadInnovationCampaign("data", "innovation-campaign.json"),
      computeInnovationExposure(innovationBasketExecutors, innovationSingleSymbolExecutors),
    );
  let regimeAutopilot: RegimeAutopilot | null = null;
  let unifiedOrchestrator: UnifiedTestnetOrchestrator | null = null;
  let unifiedProposalStore: UnifiedTestnetProposalStore | null = null;
  // One shared BTC/ETH/SOL timeline for the dashboard and every single-symbol executor. The
  // optional execution overlay is opt-in per environment; the data endpoint remains available in
  // either mode so an operator can inspect exactly what would have been allowed.
  let singleSymbolPriceTimeline: SingleSymbolPriceTimelineService | null = null;

  // 2026-07-09 fix, widened 2026-07-11: the SHARED single source of truth for "every single-symbol
  // / cross-sectional executor instance that exists" — consumed by the per-symbol notional cap
  // (computeNotionalPerSymbol), the reconcile-safety net-qty tracker (computeExternalManagedNetQty),
  // and the external realized-P&L sum (sumExternalRealizedPnlUsd, feeding the kill-switch/wallet-
  // reconciliation/dashboard headline). Before 2026-07-11 these 3 consumers each had their OWN
  // hand-duplicated literal array here in app.ts — the exact "hardcoded lane list drift" bug class
  // found repeatedly in this session's audits (a 12th executor added to only 2 of the 3 lists would
  // silently reopen the 2026-07-09 concentration-cap incident computeNotionalPerSymbol's own doc
  // comment describes). A new executor now only has to be added to these 2 closures — every
  // consumer below reuses them, so there is nothing else to remember.
  // Referencing the mutable `let` bindings above is safe: these are only ever CALLED during a tick,
  // well after every executor below has been constructed and assigned.
  const allCrossSectionalLaneExecutors = (): Array<CrossSectionalExecutor | null> => [
    crossSectionalExecutor,
    crossSectionalTrendExecutor,
    crossSectionalMixedExecutor,
    ...innovationBasketExecutors,
  ];
  const allSingleSymbolLaneExecutors = (): Array<SingleSymbolLaneExecutor | null> => [
    shortFadeExecutor,
    intradayMomentumExecutor,
    regimeCompositeExecutor,
    regimeCompositeShortExecutor,
    compositeEstimatorWideLongExecutor,
    compositeEstimatorWideShortExecutor,
    compositeEstimatorFastLongExecutor,
    compositeEstimatorFastShortExecutor,
    panicWashoutExecutor,
    crossSectionalDirectionalLongExecutor,
    crossSectionalDirectionalShortExecutor,
    ...innovationSingleSymbolExecutors,
  ];
  /** Notional already committed to `symbol` by every OTHER single-symbol executor (excludes
   *  `self` — an instance's own admission is already bounded by its own maxOpenPositions, and
   *  double-counting itself would make the cap tighter than intended).
   *  2026-07-19 real-money audit fix: now ALSO includes every open cross-sectional basket leg on
   *  the symbol (all 3 of MARKET_NEUTRAL/TREND/MIXED — never `self`, they're never a
   *  SingleSymbolLaneExecutor) — before this, a single-symbol lane's own admission gate had zero
   *  visibility into what the cross-sectional baskets already held on the same symbol. See
   *  live-executor-wiring.ts's computeNotionalPerSymbol doc comment. */
  const notionalForSymbolExcluding = (self: SingleSymbolLaneExecutor | null, symbol: string): number =>
    computeNotionalPerSymbol(allSingleSymbolLaneExecutors().filter((e) => e !== self), allCrossSectionalLaneExecutors()).get(symbol) ?? 0;
  /** Mirror of notionalForSymbolExcluding for the cross-sectional side: notional already committed
   *  to `symbol` by every OTHER cross-sectional executor instance (excludes `self`) PLUS every
   *  single-symbol lane executor. 2026-07-19 real-money audit fix: closes the gap where
   *  CROSS_SECTIONAL_MARKET_NEUTRAL/TREND/MIXED had zero visibility into the 9 single-symbol lanes'
   *  (or each other's) same-symbol exposure despite sharing ONE netted Binance account —
   *  MARKET_NEUTRAL's own long/short allowlists include ETHUSDT/SOLUSDT, 2 of the exact 3 symbols
   *  RC/CE-WIDE_LONG/CE-FAST_LONG trade real money on today. */
  const crossSectionalNotionalForSymbolExcluding = (self: CrossSectionalExecutor | null, symbol: string): number =>
    computeNotionalPerSymbol(allSingleSymbolLaneExecutors(), allCrossSectionalLaneExecutors().filter((e) => e !== self)).get(symbol) ?? 0;
  /** 2026-07-19 real-money audit fix (confirmed finding): extends live-execution-engine.ts's own
   *  correlated-cluster cap (built after a real prior loss incident — a SUI/ADA/AVAX cluster dumping
   *  together simultaneously) to reach the single-symbol lanes, the SAME way notionalForSymbolExcluding
   *  above already does for the flat per-symbol notional cap. Combines the legacy mirror's OWN open
   *  intents (`engine.getStatus().openIntents` — the engine's private per-cluster bookkeeping isn't
   *  reusable from outside the class) with every cross-sectional basket leg and every OTHER
   *  single-symbol lane's open position, grouped via the SAME clusterOf() map the mirror's own cap
   *  uses (see live-executor-wiring.ts's computeClusterOpenSymbols doc comment). */
  const clusterOpenSymbolsExcluding = (self: SingleSymbolLaneExecutor | null, symbol: string, direction: "LONG" | "SHORT"): ReadonlySet<string> =>
    computeClusterOpenSymbols(
      liveEngine?.getStatus().openIntents ?? [],
      allCrossSectionalLaneExecutors(),
      allSingleSymbolLaneExecutors().filter((e) => e !== self),
    ).get(`${clusterOf(symbol)}:${direction}`) ?? new Set<string>();
  /** Reuses the LIVE engine's OWN configured cap (guaranteed identical to what its OWN per-cluster
   *  admission check enforces — see LiveExecutionEngine.config.maxClusterPositions, surfaced via
   *  getStatus().limits) rather than independently re-parsing the env var, so this can never drift
   *  from the mirror's real threshold. Falls back to maxClusterPositionsAcrossLanes()'s own default
   *  only in the (practically unreachable) case of no engine — every single-symbol executor's
   *  isAllowed() already requires an armed engine before maybeOpenPosition ever runs. */
  const clusterCapAcrossLanes = (): number => liveEngine?.getStatus().limits.maxClusterPositions ?? maxClusterPositionsAcrossLanes();

  const coreScanAutoRefreshController = await registerScanRoute(app, scanService, tracker, outcomeChecker, shadowEngine, {
    binanceClient,
    performanceProvider,
    liveEngineGetter: () => liveEngine,
  });
  await registerKronosRoutes(app, kronosClient, binanceClient);
  await registerOutcomesRoutes(app, tracker, performanceProvider);
  await registerShadowRoutes(app, shadowEngine, {
    binanceClient,
    metadataFetchImpl: options.fetchImpl,
    coreScanAutoRefreshController,
    notificationService,
    liveEngineGetter: () => liveEngine,
    crossSectionalReentryBlocksGetter: async () => {
      const blocks = await crossSectionalExecutor?.getLossReentryBlocks() ?? [];
      return {
        longBlocklist: blocks.filter((block) => block.side === "LONG").map((block) => block.symbol),
        shortBlocklist: blocks.filter((block) => block.side === "SHORT").map((block) => block.symbol),
      };
    },
    kronosClient,
    fourBrainMetricsGetter: () => fourBrainMetricsRef?.summary() ?? null,
    fourBrainRecentDecisionsGetter: () => fourBrainRecentDecisionsRef?.getAll() ?? null,
    directionEntryOutcomeReportGetter: () => directionEntryOutcomeReportGetterRef?.() ?? null,
    fourBrainBridgeGetter: () => fourBrainTestnetBridgeRef?.getStatus() ?? null,
    fourBrainActualFillBindingStatusGetter: () => fourBrainActualFillBindingsRef?.getStatus({ sinceMs: fourBrainExactFillCohortSinceMs }) ?? null,
    fourBrainExecutionReinforcementStatusGetter: () => fourBrainExecutionReinforcementStatusGetterRef?.() ?? null,
  });
  await registerNotificationRoutes(app, notificationService);
  await registerTradingAssistantRoutes(app);

  // Live-execution mirror (Binance USD-M). Fully dormant unless LIVE_EXECUTION_ENABLED=1:
  // no private client is constructed, no loop runs, nothing else in the app changes.
  // Strategy code is untouched — the engine only READS the paper store's decisions.
  const liveConfig = parseLiveExecutionConfig();
  // This cohort boundary is shared by the execution wiring and the shadow/outcome wiring below.
  // Defining it at app scope prevents the two paths from accidentally writing separate cohorts.
  const fourBrainTestnetFocusEnabled =
    !isTest && liveConfig.env === "testnet" && process.env.FOUR_BRAIN_TESTNET_FOCUS === "1";
  const fourBrainOutcomeDataDirRuntime = fourBrainTestnetFocusEnabled ? "data/four-brain-testnet-focus" : "data";
  fourBrainExactFillCohortSinceMs = resolveFourBrainExactFillCohortSinceMs();
  if (liveConfig.enabled && liveConfig.configErrors.length === 0 && liveConfig.env) {
    const liveClient = new BinanceFuturesPrivateClient({
      apiKey: liveConfig.apiKey,
      apiSecret: liveConfig.apiSecret,
      env: liveConfig.env,
      fetchImpl: options.fetchImpl,
    });
    // RECORDING-ONLY (2026-07-27). Keep the existing SPOT mid as the entry-quality gate input, while
    // prewarming an independent book reference from the SAME USD-M testnet/mainnet base used for
    // execution. The execution-book fetch runs in parallel and is capped at 750ms; failure/timeout
    // falls back to the old cross-venue sample and never blocks an order.
    //
    // Bounded: one entry per symbol, capped, evicting the oldest insertion. This is a last-value
    // cache, never a log — nothing reads it on a timer and nothing iterates it.
    const MAX_PUBLIC_QUOTE_SYMBOLS = 256;
    const publicQuoteCache = new Map<string, PublicQuoteSnapshot>();
    const readPublicQuote = (symbol: string): PublicQuoteSnapshot | null => publicQuoteCache.get(symbol) ?? null;
    const rememberPublicQuote = (symbol: string, snapshot: PublicQuoteSnapshot): void => {
      try {
        if (!publicQuoteCache.has(symbol) && publicQuoteCache.size >= MAX_PUBLIC_QUOTE_SYMBOLS) {
          const oldest = publicQuoteCache.keys().next();
          if (!oldest.done) publicQuoteCache.delete(oldest.value);
        }
        publicQuoteCache.set(symbol, snapshot);
      } catch {
        // Recording must never be able to disturb the gate that just fetched this quote.
      }
    };
    const currentPublicPrice = async (symbol: string): Promise<number | null> => {
      const executionBookPromise = Promise.race([
        liveClient.getBookTicker(symbol).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 750)),
      ]);
      const [book, executionBook] = await Promise.all([
        binanceClient.getBookTicker(symbol),
        executionBookPromise,
      ]);
      // Stamped AFTER the await, so the age the executor derives from it is the age of the
      // OBSERVATION, never of the request that produced it.
      const atMs = Date.now();
      // Identical precedence/return values to the pre-2026-07-27 body (both-sided mid, else the
      // single usable side, else null) — restructured only so the quote can be remembered.
      const mid = book.bid !== null && book.ask !== null && book.bid > 0 && book.ask > 0
        ? (book.bid + book.ask) / 2
        : book.bid !== null && book.bid > 0
          ? book.bid
          : book.ask !== null && book.ask > 0
            ? book.ask
            : null;
      if (mid !== null) {
        const executionMid =
          executionBook?.bid && executionBook.ask
            ? (executionBook.bid + executionBook.ask) / 2
            : executionBook?.bid ?? executionBook?.ask ?? null;
        rememberPublicQuote(
          symbol,
          executionMid !== null
            ? {
                bid: executionBook?.bid ?? null,
                ask: executionBook?.ask ?? null,
                mid: executionMid,
                // Local response-observation time drives age. Exchange time is not substituted
                // because even a healthy clock offset could make a fresh quote look future/stale.
                atMs,
                venue: "BINANCE_USDM_BOOK_TICKER",
              }
            : {
                bid: book.bid !== null && book.bid > 0 ? book.bid : null,
                ask: book.ask !== null && book.ask > 0 ? book.ask : null,
                mid,
                atMs,
                venue: "BINANCE_SPOT_BOOK_TICKER",
              },
        );
      }
      return mid;
    };
    singleSymbolPriceTimeline = new SingleSymbolPriceTimelineService(
      (symbol, interval, limit) => binanceClient.getCandles(symbol, interval, limit),
      { enabledForExecution: process.env.SINGLE_SYMBOL_TIMELINE_EXEC_ENABLED === "1" },
    );
    // 2026-07-12 fix: every executor sharing this ONE netted account (3 CrossSectionalExecutor +
    // up to 8 SingleSymbolLaneExecutor instances) independently called client.getPositions() every
    // tick purely to read market-wide markPrice data — up to 11 redundant signed, account-wide
    // calls within the same staggered 5-minute window. Short-TTL (30s, well under any single
    // instance's own tick cadence) cache shared by ALL of them via each executor's own
    // sharedGetPositions option, so at most one signed call goes out per cache window regardless
    // of how many instances' ticks land inside it.
    let cachedPositions: { at: number; promise: ReturnType<typeof liveClient.getPositions> } | null = null;
    // Split out so a caller that needs the ACTUAL fetch timestamp (not just the promise) — see
    // live-mark-price-cache.ts's non-interference contract — can read `{at, promise}` atomically in
    // one synchronous call, with zero change to sharedGetPositions's own behavior/timing for its
    // existing 11+ callers (sharedGetPositions below is unchanged in every observable way — same
    // cache object, same 30s window, same returned promise).
    const ensureCachedPositions = (): { at: number; promise: ReturnType<typeof liveClient.getPositions> } => {
      const now = Date.now();
      if (!cachedPositions || now - cachedPositions.at > 30_000) {
        const promise = liveClient.getPositions();
        // Piggyback the account-exposure coordinator's manual/external-position snapshot onto this
        // SAME promise — ZERO new Binance calls (see AccountExposureCoordinator.updatePositionSnapshot's
        // doc comment). Attached only here, at the point a NEW promise is created, not on every
        // ensureCachedPositions() call within the 30s window — every other consumer below still reads
        // this identical, unmodified promise. exposureCoordinator is declared further below (same
        // forward-reference-by-closure pattern already used throughout this function, e.g.
        // allCrossSectionalLaneExecutors reading `let crossSectionalExecutor` before it is assigned) —
        // safe because this closure is never CALLED until well after that const has been initialized.
        promise.then((positions) => exposureCoordinator.updatePositionSnapshot(positions)).catch(() => {});
        cachedPositions = { at: now, promise };
      }
      return cachedPositions;
    };
    const sharedGetPositions = () => ensureCachedPositions().promise;
    // Four-brain markPriceForSymbol pipeline (item 3 of 3 four-brain data gaps — see
    // live-mark-price-cache.ts's module doc comment). Registered HERE (inside `if (liveConfig.enabled)`,
    // not in the four-brain `if (!isTest)` block below) purely because `sharedGetPositions` — a plain
    // `const` — is block-scoped to THIS `if` and is not visible from that sibling block. The cache STORE
    // itself is a module-level singleton (getLiveMarkPriceCacheStore), so buildFourBrainDeps below can
    // still read it synchronously by calling the same getter independently — no shared variable needed
    // across the two blocks, exactly like btcAtrPercentileCache's own singleton pattern.
    // Gated IDENTICALLY to the other 2 four-brain-only refresh intervals (ATR-percentile, four-brain
    // cycle itself): fourBrainMode==="shadow" && fourBrainInstanceAllowed ⇒ never schedules on live/3103,
    // and is a pure no-op (zero extra I/O) whenever four-brain shadow mode is off.
    // refreshLiveMarkPriceCache calls ensureCachedPositions() itself each cycle (via the closure below)
    // rather than attaching a `.then()` onto one captured promise: ensureCachedPositions already
    // de-dupes/caches upstream (repeated calls inside its own 30s window return the SAME
    // `{at, promise}` pair, so this costs zero extra Binance calls), and calling it fresh each cycle
    // means a stale/nulled `cachedPositions` (see releaseEntrySymbol above, which resets it to null on
    // entry) is naturally picked up next cycle instead of this reader ever holding a stale reference.
    // 2026-07-23 fix: stamp the cache with the ACTUAL fetch timestamp (`at`, captured atomically with
    // the promise via ensureCachedPositions), not `Date.now()` at the moment this refresh happens to
    // run. Since this refresh's own 25s cadence is SHORTER than sharedGetPositions's 30s de-dup window,
    // roughly every other cycle reuses an already-resolved promise from up to ~30s earlier — stamping
    // with call-time would silently understate staleness by up to that ~30s, letting data close to
    // FRESHNESS_TTL_MS.position's 60s bound read as near-real-time. See refreshLiveMarkPriceCache's own
    // doc comment for the full non-interference contract (it only reads the resolved value; it never
    // mutates or replaces `cachedPositions`; a rejection is caught inside its own try/catch and can
    // never become an unhandled rejection or crash this timer).
    if (!isTest && fourBrainMode(process.env) === "shadow" && fourBrainInstanceAllowed(process.env)) {
      const liveMarkPriceCache = getLiveMarkPriceCacheStore();
      const fetchPositionsWithTimestamp = () => {
        const c = ensureCachedPositions();
        return { promise: c.promise, fetchedAtMs: c.at };
      };
      const runLiveMarkPriceRefresh = (): void => {
        void refreshLiveMarkPriceCache(liveMarkPriceCache, fetchPositionsWithTimestamp);
      };
      setTimeout(runLiveMarkPriceRefresh, 10_000);
      setInterval(runLiveMarkPriceRefresh, 25_000); // comfortably under FRESHNESS_TTL_MS.position (60s)
    }
    // Binance USD-M runs in one-way mode: a BUY from one lane can reduce or reverse a SELL from
    // another lane on the same symbol. Monitoring may share the cache above, but entry admission
    // needs a synchronous per-symbol claim plus the executor's direct final exchange recheck.
    const entrySymbolsInFlight = new Set<string>();
    const singleSymbolEntryClaims = {
      tryClaimEntrySymbol: (symbol: string) => {
        if (entrySymbolsInFlight.has(symbol)) return false;
        entrySymbolsInFlight.add(symbol);
        return true;
      },
      releaseEntrySymbol: (symbol: string) => {
        entrySymbolsInFlight.delete(symbol);
        // The direct entry check may have discovered a new position. Do not let the shared
        // monitoring snapshot keep reporting the pre-entry flat account for another 30 seconds.
        cachedPositions = null;
      },
      timelineEntryGate: (signal: { symbol: string }, direction: "LONG" | "SHORT") =>
        singleSymbolPriceTimeline?.entryGate(signal.symbol, direction) ?? Promise.resolve({ allowed: true, reason: null }),
      timelineExitGate: (symbol: string, direction: "LONG" | "SHORT") =>
        singleSymbolPriceTimeline?.exitGate(symbol, direction) ?? Promise.resolve({ shouldExit: false, reason: null }),
    };
    // Shared account-exposure coordinator (account-exposure-coordinator.ts) — the reserve-then-
    // commit-then-release capacity ledger for EVERY SingleSymbolLaneExecutor/CrossSectionalExecutor
    // real exchange-entry path, mainnet AND innovation-testnet lanes alike. Constructed ONCE here,
    // alongside entrySymbolsInFlight/cachedPositions above — same "one shared instance, spread into
    // every constructor call site" pattern as singleSymbolEntryClaims/sharedGetPositions.
    const exposureCoordinator = new AccountExposureCoordinator({
      store: new AccountExposureReservationStore("data", "account-exposure-reservations.json"),
      // Same shared closures every other cross-lane exposure accessor above already reuses (see
      // notionalForSymbolExcluding/clusterOpenSymbolsExcluding) — never a second, independently
      // maintained executor list.
      getSingleSymbolExecutors: allSingleSymbolLaneExecutors,
      getCrossSectionalExecutors: allCrossSectionalLaneExecutors,
      // Optional; the legacy mirror's own open intents (S3 in the coordinator's own doc comment).
      // liveEngine is assigned further below — this closure is only ever called during a tick, well
      // after that assignment has run (same forward-reference pattern as unifiedRegimeEntryGate and
      // every isAllowed gate below that reads `engineForGate`/`liveEngine`).
      getLegacyMirrorOpenIntents: () => liveEngine?.getStatus().openIntents ?? [],
      // Restart/staleness reconciliation join key lookup (see binance-futures-private.ts's
      // queryOrderByClientId doc comment) — reuses the SAME signed client every executor below
      // shares, never a second HTTP path.
      queryOrderByClientId: liveClient.queryOrderByClientId.bind(liveClient),
    });
    // Spread into every SingleSymbolLaneExecutor AND CrossSectionalExecutor constructor call below
    // (mainnet and innovation-testnet alike) — same spread-object convention as singleSymbolEntryClaims.
    // .bind() (not a wrapper closure) so each function keeps the coordinator's own exact signature.
    const sharedExposureReservation = {
      reserveExposure: exposureCoordinator.reserve.bind(exposureCoordinator),
      commitExposureReservation: exposureCoordinator.commitReservation.bind(exposureCoordinator),
      releaseExposureReservation: exposureCoordinator.releaseReservation.bind(exposureCoordinator),
    };
    if (!isTest) {
      // One-time restart reconciliation, then the SAME routine again on a recurring timer — see
      // reconcileStaleReservations' doc comment for why these are deliberately unified rather than
      // two separate mechanisms. Gated identically to every other interval in this file.
      void exposureCoordinator.reconcileOnStartup();
      setInterval(() => void exposureCoordinator.reconcileStaleReservations(), reservationReconcileIntervalMs());
    }
    // 2026-08 canonical-market-regime rollout — the ONE shared accessor for the canonical engine's
    // snapshot. canonical-market-regime-engine.ts (requirement #3 of this rollout) now exists and
    // exports its own non-nullable `getCanonicalMarketRegimeSnapshot` (imported above as
    // `getLatestCanonicalMarketRegimeEngineSnapshot`). EVERY execution-affecting consumer of the
    // canonical regime — unifiedRegimeEntryGate below, edgeVeto's regime-string source (both call
    // sites, including the REGIME_EDGE_MEMORY vote inside tickUnifiedOrchestrator),
    // CrossSectionalExecutor MARKET_NEUTRAL's entryHealthGate, innovationTestnetAdmissionAllowed's
    // call site, and IsPaperOrderLiveEligibleDeps.getCanonicalMarketRegimeSnapshot below — calls this
    // SAME function, never an independently duplicated accessor per call site. This is load-bearing,
    // not cosmetic: adversarial test I ("all executors receive identical policy for the same
    // snapshot") is only a meaningful check of genuinely shared wiring if there is exactly one
    // accessor, not several copies that happen to agree today. It also means any future change to
    // HOW the live snapshot is obtained (e.g. adding caching, a different store path) is a one-line
    // change here, not a hunt across 6 call sites.
    //
    // UPDATE (2026-08, deployment-scope-gap fix) — this reconnection ALONE used to not make the engine
    // "live": until this fix, nothing in the codebase called `ingestCanonicalMarketRegimeRawObservations`
    // / `computeCanonicalMarketRegimeSnapshot` / `recordCanonicalMarketRegimeSnapshot` on any cadence
    // (grepped repo-wide; confirmed absent outside canonical-market-regime-engine.ts's own test and
    // canonical-market-regime-calibration.ts's offline replay tooling), so
    // `getLatestCanonicalMarketRegimeEngineSnapshot()` could only ever resolve to its cold-start
    // degraded default. The impure fetch shell (BinanceClient candles + getFuturesFlow), universe
    // resolution, and cadence scheduling were explicitly out of scope for
    // canonical-market-regime-engine.ts itself (see that file's own header, "STAGE 4" section:
    // "Deliberately NOT in this stage... left for a genuinely separate, later wiring stage") — that
    // later stage now exists: `runCanonicalMarketRegimeEngineCycleGuarded` is registered on a
    // setInterval right after `liveEngine.start()` below (see that call site's own comment for the
    // full wiring). Once deployed, a healthy tick replaces the degraded default with a real snapshot;
    // until then (not-yet-deployed, first-tick-still-pending, or the engine explicitly disabled via
    // CANONICAL_MARKET_REGIME_ENGINE_DISABLED), this accessor still resolves to
    // `degradedLowCoverageSnapshot(...)` — the SAME safe, fail-closed, all-new-entries-blocked behavior
    // the original `() => null` stub produced (canonicalMarketRegimeExecutionPolicy treats both
    // identically: null snapshot -> blocked; a non-null but LOW_COVERAGE snapshot -> also blocked). DO
    // NOT replace this with anything that could ever resolve to an allowed-by-default decision (e.g.
    // an `?? { allowed: true }`-shaped fallback) — a missing/cold-start/disabled engine must only ever
    // narrow eligibility.
    const getCanonicalMarketRegimeSnapshot = (): CanonicalMarketRegimeSnapshot | null =>
      getLatestCanonicalMarketRegimeEngineSnapshot();
    // The direct-fill ledger is isolated to the user-selected testnet cohort. It starts empty at
    // this deployment boundary and is never constructed for research/mainnet. The bridge itself
    // is still fail-open unless its separate `pilot` switch is explicitly present in the testnet
    // environment.
    if (fourBrainTestnetFocusEnabled) {
      fourBrainActualFillBindingsRef = getFourBrainActualFillBindingStore(fourBrainOutcomeDataDirRuntime);
      fourBrainTestnetBridgeRef = new FourBrainTestnetBridge({
        dataDir: fourBrainOutcomeDataDirRuntime,
        getCanonicalRegimeFamily: () => getCanonicalMarketRegimeSnapshot()?.regimeFamily ?? null,
      });
    }
    const fourBrainPilotEntryGate = fourBrainTestnetBridgeRef
      ? (candidate: Parameters<FourBrainTestnetBridge["evaluate"]>[0]) => {
          // Capture exact identity/geometry while the candidate is still on the executor path. The
          // observer is fail-open and discarded; evaluate() remains the only value the executor uses.
          try {
            fourBrainPreEntryObserverRef?.(candidate);
          } catch {
            // Shadow audit must never alter an incumbent order decision.
          }
          return fourBrainTestnetBridgeRef!.evaluate(candidate);
        }
      : undefined;
    const unifiedRegimeEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => unifiedOrchestrator,
      getCanonicalMarketRegimeSnapshot,
    });
    const unifiedEnabled = isUnifiedTestnetOrchestratorEnabled(
      process.env,
      liveConfig.env === "testnet" ? "testnet" : "mainnet",
    );
    unifiedOrchestrator = new UnifiedTestnetOrchestrator({
      enabled: unifiedEnabled,
      store: new UnifiedTestnetOrchestratorStore("data"),
      confirmSamples: Number(process.env.UNIFIED_DIRECTION_CONFIRM_SAMPLES) || 2,
      choppySamples: Number(process.env.UNIFIED_CHOPPY_LOCK_SAMPLES) || 2,
      estimatedCloseCostPct: liveConfig.estimatedCloseCostPct,
    });
    const basePaperStore = isRealtimeShortMirrorEnabled()
      ? getRealtimeShortMirrorStore()
      : getPaperExecutionRouterStore();
    unifiedProposalStore = unifiedEnabled
      ? new UnifiedTestnetProposalStore({
          baseStore: basePaperStore,
          getOrchestratorStatus: () => unifiedOrchestrator?.getStatus() ?? null,
          getScan: getLatestScanCandidates,
          getPosture: () => liveEngine?.getStatus().controller?.estimatedRegime?.posture ?? "TACTICAL_OR_MIXED",
          maxCandidates: Number(process.env.UNIFIED_PROPOSAL_MAX_CANDIDATES) || 3,
          minConfidence: Number(process.env.UNIFIED_PROPOSAL_MIN_CONFIDENCE) || 60,
        })
      : null;
    liveEngine = new LiveExecutionEngine({
      config: liveConfig,
      client: liveClient,
      store: (liveExecutionStore = new LiveExecutionStore()),
      // CORTEX real-USDT attribution (2026-07-21, report-only, fail-safe — see
      // cortex-real-attribution.ts): the engine sweeps its own closed intents into this store;
      // the SingleSymbolLaneExecutor instances below write to the SAME singleton at their close
      // finalization, so /api/live/cortex-real-attribution reports one unified number.
      cortexRealAttribution: getCortexRealAttributionStore(),
      // Dense per-tick R-path recorder (2026-07-22, report-only, fail-safe — see
      // position-path-recorder.ts): the engine samples every OPEN intent's mark-R once per tick
      // and hands CLOSED paths to the Exit Brain shadow scorer's reader (routes/shadow.ts). The
      // SingleSymbolLaneExecutor instances below record into this SAME singleton.
      positionPathRecorder: getPositionPathRecorder(),
      // Per-fill execution recorder (2026-07-27, report-only, fail-safe — see
      // execution-fill-recorder.ts). This is the HIGHEST-VALUE writer of the three: the engine
      // settles ~182 of the store's closed intents through realizedFromTrades, which already
      // fetches every fill's price/qty/commission/time and keeps only two summed scalars — there is
      // currently not one exit fill price persisted anywhere. No new exchange call: the rows are
      // the ones settlement already matched. Same singleton as the executors below.
      executionFillRecorder: getExecutionFillRecorder(),
      fourBrainActualFillBindings: fourBrainActualFillBindingsRef ?? undefined,
      fourBrainEntryGate: fourBrainPilotEntryGate,
      executiveReviewStore: executiveReviewStore ?? undefined,
      // Crowding-exit SHADOW measurement only (getStatus().crowdingExitShadow) — read-only market
      // data, never touches order placement. Reuses the same market-data client scan.ts uses.
      marketDataClient: binanceClient,
      newEntryGate: unifiedRegimeEntryGate,
      // 2026-08 manual-directional canonical-regime enforcement fix — see
      // buildManualDirectionalRegimeSafetyGate's own doc comment above for the full rationale.
      // Shares the SAME getCanonicalMarketRegimeSnapshot closure every other consumer in this
      // function uses (shorthand reference, not a redefinition).
      regimeSafetyGate: buildManualDirectionalRegimeSafetyGate({ getCanonicalMarketRegimeSnapshot }),
      // Cross-sectional basket legs (and now the 2 single-symbol executors' positions) share this
      // Binance account but are NOT engine intents — reconcile must know about them or it flags
      // every leg/position as an orphan and disarms one tick after it opens. Lazy closure: the
      // executors are constructed later in this function (they need the engine for their own
      // isAllowed gate), so resolve at call time.
      // 2026-07-08: sums across ALL 11 executor instances (cross-sectional FILTERED/TREND/MIXED +
      // the 8 single-symbol executors) — the same starvation/false-orphan class of bug the original
      // single-instance fix addressed would otherwise recur for every one of the new instances' own
      // open legs. 2026-07-11: reuses the shared allCrossSectionalLaneExecutors()/
      // allSingleSymbolLaneExecutors() closures above instead of its own duplicated literal array.
      externalManagedNetQty: () =>
        computeExternalManagedNetQty(allCrossSectionalLaneExecutors(), allSingleSymbolLaneExecutors()),
      // 2026-07-11 real-money audit fix: same shared closures as externalManagedNetQty above, so the
      // account-wide kill-switch (killSwitchTrip) can finally see real losses/gains from these lanes
      // instead of only its own mirror/directional-slot ledger — see live-executor-wiring.ts's
      // sumExternalRealizedPnlUsd doc comment.
      getExternalRealizedPnlUsd: () =>
        sumExternalRealizedPnlUsd(allCrossSectionalLaneExecutors(), allSingleSymbolLaneExecutors()),
      // 2026-07-12 kill-switch RESPONSE fix: when the account-wide breaker trips, close the OTHER
      // 11 executors' positions too — via each executor's OWN orderly close (reduce-only,
      // netting-aware), never a blanket symbol flatten (2026-07-07 netting-blind-closes rule).
      // New entries across all 11 are already halted by their isAllowed gates once killedAt latches.
      onKillSwitchEngaged: async (reason: string) => {
        const killReason = `KILL_SWITCH_PORTFOLIO: ${reason}`;
        for (const exec of allCrossSectionalLaneExecutors()) {
          if (!exec) continue;
          try {
            await exec.closeAllBasketsOrderly(killReason);
          } catch (error) {
            console.error(`[app] kill-switch basket close failed: ${(error as Error).message}`);
          }
        }
        for (const exec of allSingleSymbolLaneExecutors()) {
          if (!exec) continue;
          try {
            await exec.closeAllPositionsOrderly(killReason);
          } catch (error) {
            console.error(`[app] kill-switch single-symbol close failed: ${(error as Error).message}`);
          }
        }
      },
      // 2026-07-20 real-money audit fix (BUG 1): laneId → fixed direction lookup for
      // setManualDirectionalLaneAllocations's validator. CORTEX_LANE_ROSTER is already this
      // codebase's single code-anchored source of truth for every lane's construction-time
      // direction (kept in sync with the SingleSymbolLaneExecutor instantiations below) — reused
      // here rather than duplicating a second lane-id list inside live-execution-engine.ts.
      laneDirectionForId: (laneId) => CORTEX_LANE_ROSTER.find((entry) => entry.laneId === laneId)?.direction ?? null,
      // "Mode 2" (REALTIME_SHORT_MIRROR_ENABLED=1): the engine mirrors ONLY the dedicated
      // real-time short store — fresh, short-only, stable-lane orders — and never the
      // measurement paper book. Flag off → unchanged (reads the normal paper book).
      paperStore: unifiedProposalStore ?? basePaperStore,
      paperLaneGate: (order) => unifiedOrchestrator?.isEnabled()
        ? unifiedOrchestrator.allowsPaperOrder({ selectedLaneId: order.selectedLaneId, direction: order.direction })
        : null,
      paperLaneWeightPct: (order) => unifiedOrchestrator?.isEnabled()
        ? (unifiedOrchestrator.allowsPaperOrder({ selectedLaneId: order.selectedLaneId, direction: order.direction }) ? 100 : 0)
        : null,
      isPaperOrderLiveEligible: buildIsPaperOrderLiveEligible({
        liveConfig,
        getUnifiedOrchestrator: () => unifiedOrchestrator,
        getLiveEngine: () => liveEngine,
        getVariantMatrixStore: () => getCurrentGuardVariantMatrixStore(),
        // 2026-08 canonical-market-regime redirect: wired to the SAME shared
        // `getCanonicalMarketRegimeSnapshot` accessor defined once above (see its own doc comment
        // right before `unifiedRegimeEntryGate`) — every other execution-affecting consumer this
        // round (unifiedRegimeEntryGate, edgeVeto's two call sites, CrossSectionalExecutor
        // MARKET_NEUTRAL's entryHealthGate, innovationTestnetAdmissionAllowed's call site) reads the
        // exact same function, never an independently duplicated placeholder. It resolves to a real
        // canonical-market-regime-engine.ts snapshot now that module exists, but that snapshot is
        // still always the cold-start `degradedLowCoverageSnapshot(...)` (LOW_COVERAGE, regimeFamily
        // forced MIXED-then-UNKNOWN-mapped as applicable) until a later, separate wiring stage adds
        // the live ingestion cadence (see the shared accessor's own doc comment above for why).
        // canonicalMarketRegimeExecutionPolicy treats both a null AND a LOW_COVERAGE snapshot as
        // blocked, and a missing/degraded regimeFamily read here resolves to "UNKNOWN", which
        // structurally fails exactLaneContextFor (step 3) — so this deliberately narrows paper->live
        // eligibility rather than silently widening it while the engine has not yet ticked. The day
        // that ingestion cadence lands, this accessor starts returning real market-derived snapshots
        // with zero further changes to this call site or any of the other 5.
        getCanonicalMarketRegimeSnapshot,
      }),
      getControllerSnapshot: () => {
        const cached = getLatestScanCandidates();
        const scanStatus = coreScanAutoRefreshController.getStatus();
        const fallbackSnapshot =
          cached || scanStatus.lastAutoRefreshResultSummary
            ? null
            : getRegimeDirectionControllerSnapshotStore().readLatest();
        const regime =
          cached?.marketRegime ??
          scanStatus.lastAutoRefreshResultSummary?.marketRegime ??
          fallbackSnapshot?.currentRegime ??
          null;
        // Smart direction gate wired here too (2026-07-01) so the live engine's OWN view of
        // regime/direction (feeds the regime breakeven/hard-cut harvest + this status snapshot)
        // stays consistent with the mode-2 mirror's admission gate (scan.ts) — both read the same
        // process-wide edge-memory singleton, so a direction proven non-positive collapses to
        // NO_TRADE_NEGATIVE_EDGE everywhere the engine looks, not just at entry.
        // Graduated-confidence inputs (2026-07-12): the current regime-axis breadth composite + its
        // velocity, so a directional trend's confidence reflects the real evidence strength instead of
        // a hardcoded MEDIUM. Live-safe (confidence is floored ≥ MEDIUM for trends in Phase 1 — the
        // upgrade to HIGH is invisible to live admission, which only distinguishes MEDIUM||HIGH).
        const controllerAxis = buildRegimeAxisTimeline(getRegimeEngineStore().snapshots);
        const controller = buildRegimeDirectionControllerReport({
          currentRegime: regime,
          adaptiveDirectionBias: null,
          primaryValidationLane: null,
          edgeGate: getRegimeEdgeMemory(),
          axisScore: controllerAxis.current?.score ?? null,
          axisSlopePerHour: controllerAxis.slopePerHour ?? null,
        });
        const estimatedRegime = estimateLaneSelectorV2Regime({
          regime: controller.currentRegime,
          controllerMode: controller.controllerMode,
          confidence: controller.confidence,
        });
        return {
          regime: controller.currentRegime,
          mode: controller.controllerMode,
          bias: controller.directionalBias,
          confidence: controller.confidence,
          convictionScore: controller.convictionScore,
          gradedConfidence: controller.gradedConfidence,
          estimatedRegime,
          reasons: controller.reasonCodes,
          capturedAt: cached?.scanFinishedAt ?? scanStatus.lastAutoRefreshFinishedAt ?? fallbackSnapshot?.capturedAt ?? null,
        };
      },
    });
    const tickUnifiedOrchestrator = () => {
      if (!unifiedOrchestrator?.isEnabled() || !liveEngine) return;
      const controller = liveEngine.getStatus().controller;
      const primaryDirection: UnifiedDirection =
        controller?.mode === "LONG_ONLY" || controller?.bias === "LONG"
          ? "LONG"
          : controller?.mode === "SHORT_ONLY" || controller?.bias === "SHORT"
            ? "SHORT"
            : "NEUTRAL";
      const nowMs = Date.now();
      const freshWindowMs = Math.max(15 * 60_000, Number(process.env.UNIFIED_FEATURE_SIGNAL_MAX_AGE_MS) || 2 * 60 * 60_000);
      const rcSignals = regimeCompositeOpenSignals(getRegimeCompositeStore())
        .filter((signal) => nowMs - signal.openedAtMs <= freshWindowMs);
      const rcsSignals = regimeCompositeShortOpenSignals(getRegimeCompositeShortStore())
        .filter((signal) => nowMs - signal.openedAtMs <= freshWindowMs);
      const ceLongSignals = ["WIDE_LONG", "FAST_LONG"]
        .flatMap((bucket) => compositeEstimatorOpenSignals(getCompositeEstimatorStore(), bucket as CEBucket))
        .filter((signal) => nowMs - signal.openedAtMs <= freshWindowMs);
      const ceShortSignals = ["WIDE_SHORT", "FAST_SHORT"]
        .flatMap((bucket) => compositeEstimatorOpenSignals(getCompositeEstimatorStore(), bucket as CEBucket))
        .filter((signal) => nowMs - signal.openedAtMs <= freshWindowMs);
      const votes: UnifiedFeatureVote[] = [];
      // REGIME_COMPOSITE_CONFIRMATION is a LONG-ONLY measurement lane (regime-composite-edge.ts:
      // RC_PAPER_LANE_ID = "REGIME_COMPOSITE_CONFIRMATION_LONG"; regimeCompositeOpenSignals can only
      // ever emit LONG). Pushing a hardcoded direction:"LONG" vote unconditionally made it
      // structurally asymmetric — it could confirm a LONG cheaply but, whenever the primary was
      // SHORT, it landed as OPPOSING support that one-sidedly penalized the short while being
      // physically incapable of ever confirming one (there is no bearish-breadth counterpart). Gate
      // it to a LONG primary so it acts as honest long-confirmation only and never blocks shorts.
      // (The symmetric long-term fix is a real bearish-breadth signal; CE_BIDI already votes both sides.)
      if (rcSignals.length > 0 && primaryDirection === "LONG") {
        votes.push({
          source: "REGIME_COMPOSITE_CONFIRMATION",
          direction: "LONG",
          confidence: Math.min(1, rcSignals.length / 3),
          reason: `${rcSignals.length} fresh axis+crowding confirmation signal(s)`,
        });
      }
      // 2026-07-12: the bearish-breadth counterpart (regime-composite-short-edge.ts). RC could only
      // ever confirm LONG; this SHORT confirmation lane gives the brain a symmetric bearish read
      // (axis <= -threshold + same crowding-stability filter), so a SHORT primary is now confirmable
      // by real breadth evidence instead of riding on the single CE_BIDI voter. Gated to a SHORT
      // primary — mirror of the RC LONG gate above.
      if (rcsSignals.length > 0 && primaryDirection === "SHORT") {
        votes.push({
          source: "REGIME_COMPOSITE_SHORT_CONFIRMATION",
          direction: "SHORT",
          confidence: Math.min(1, rcsSignals.length / 3),
          reason: `${rcsSignals.length} fresh bearish axis+crowding confirmation signal(s)`,
        });
      }
      if (ceLongSignals.length > 0 || ceShortSignals.length > 0) {
        const total = ceLongSignals.length + ceShortSignals.length;
        const direction: UnifiedDirection = ceLongSignals.length === ceShortSignals.length
          ? "NEUTRAL"
          : ceLongSignals.length > ceShortSignals.length
            ? "LONG"
            : "SHORT";
        votes.push({
          source: "COMPOSITE_ESTIMATOR_BIDI",
          direction,
          confidence: total > 0 ? Math.abs(ceLongSignals.length - ceShortSignals.length) / total : 0,
          reason: `${ceLongSignals.length} long vs ${ceShortSignals.length} short fresh bucket signal(s)`,
        });
      }
      // 2026-07-12: wire the measured regime×direction edge-memory as a REAL veto. The orchestrator's
      // veto branch (candidateFrom, unified-testnet-orchestrator.ts:189-193) was dead — no vote source
      // ever set veto:true, so the "strongest override path" never fired. If the primary direction is
      // PROVEN net-negative in the current regime (VETO_NEGATIVE: n≥30, avgNetR≤0) and no proven-positive
      // lane rescues it, veto → the brain drops to NEUTRAL instead of arming a direction it has already
      // measured to lose here. Fails OPEN on insufficient samples (ALLOW_INSUFFICIENT) or a blank regime,
      // so it can only ever block a demonstrated loser, never become a new blanket gate. Uses the same
      // regime string the brain's primaryDirection is derived from (controller.regime), so they agree.
      if (primaryDirection === "LONG" || primaryDirection === "SHORT") {
        // 2026-08 canonical-market-regime redirect: regime SOURCE only — every line below in this
        // block (mem.verdict/hasPositiveLane/the veto vote push) is byte-identical; `controller`
        // itself and every OTHER field read off it elsewhere in this function (mode, bias,
        // confidence, convictionScore, gradedConfidence, estimatedRegime, reasons, capturedAt) are
        // completely unaffected — only this one local variable's source changes, from the live
        // producer-A read (controller.regime) to the canonical engine's regimeFamily mapped onto the
        // SAME three edge-memory buckets producer A's free-text already landed in (see
        // edgeMemoryLabelForCanonicalFamily's doc comment, verified directly against the real
        // regime-edge-memory.ts normalizeRegimeFamily by
        // canonical-market-regime-execution-policy.test.ts).
        const regimeForEdge = edgeMemoryLabelForCanonicalFamily(
          getCanonicalMarketRegimeSnapshot()?.regimeFamily ?? "UNKNOWN",
        );
        if (regimeForEdge && regimeForEdge.trim().length > 0) {
          const edgeMem = getRegimeEdgeMemory();
          const edgeV = edgeMem.verdict(regimeForEdge, primaryDirection);
          if (!edgeV.allowed && !edgeMem.hasPositiveLane(regimeForEdge, primaryDirection)) {
            votes.push({
              source: "REGIME_EDGE_MEMORY",
              direction: primaryDirection,
              confidence: 1,
              veto: true,
              reason: `${primaryDirection} proven net-negative in "${regimeForEdge}" (${edgeV.reasonCode})`,
            });
          }
        }
      }
      const xsecReport = buildCrossSectionalReport(getCrossSectionalStore(), nowMs, {
        variant: "FILTERED",
        sinceMs: getCrossSectionalReportSinceMs(),
      });
      const xsecHealth = rollingNetEntryHealth(xsecReport.recentNetReturns);
      const capturedAt = controller?.capturedAt ?? new Date(nowMs).toISOString();
      const sampleId = controller?.capturedAt ?? `fallback:${Math.floor(nowMs / (15 * 60_000))}:${primaryDirection}`;
      unifiedOrchestrator.update({
        sampleId,
        capturedAt,
        primaryDirection,
        primaryConfidence:
          controller?.confidence === "LOW" || controller?.confidence === "MEDIUM" || controller?.confidence === "HIGH"
            ? controller.confidence
            : null,
        primaryReason: controller?.reasons?.join(", ") || controller?.regime || "controller unavailable",
        votes,
        neutralProposalAllowed: xsecHealth.allowed,
        neutralProposalReason: xsecHealth.reason,
      });
    };
    tickUnifiedOrchestrator();
    if (!isTest && unifiedEnabled) setInterval(tickUnifiedOrchestrator, 30_000);

    // ── CORTEX central-brain SHADOW / (2026-07-20) PROMOTED-LIVE tick ────────────────────────────
    // Gated hard on CENTRAL_BRAIN_MODE in {'shadow','live'} (default OFF ⇒ pure no-op). In 'shadow' it
    // gathers the current federated context per lane, runs decideCortex, and APPENDS a BRAIN_DECISION
    // to the journal — it DRIVES NOTHING (never calls setAllocations). In 'live' (opt-in, testnet-only
    // per the operator's explicit 2026-07-20 approval) it ADDITIONALLY computes a gated/damped/ramped
    // promoted decision and pushes its per-lane weights into the live engine — see runCortexShadowTick's
    // doc for the full promotion contract (regime-coverage gate, blindCapital damping, per-cycle
    // invariant fallback, hard LIVE_BINANCE_ENV≠mainnet circuit breaker independent of this mode flag).
    // resolvedThisCycle=0 in both modes: β only ever advances via the outcome-attribution + nightly-refit
    // increment (#218), never by this per-cycle tick.
    const cortexStore = new CortexBrainStore("data/cortex-brain.json");
    const cortexJournal = new CortexDecisionJournal("data/cortex-decision-journal.jsonl");
    const cortexShadowTick = () => {
      try {
        if (!liveEngine) return;
        const mode = cortexBrainMode(process.env);
        if (mode === "off") {
          // Mode flipped off (possibly straight from 'live') ⇒ clear any previously-installed promoted
          // tilt immediately, every tick, so turning CORTEX off can never leave a stale override stuck
          // in the engine (setCortexPromotedWeights(null) on an already-null field is a cheap no-op).
          liveEngine.setCortexPromotedWeights(null);
          return;
        }
        const engine = liveEngine;
        const cached = getLatestScanCandidates();
        // Blocker 4: the scanBatchId-binding decision (unpublished batch -> real scanBatchId for the
        // tick AND attempt publish; already-published batch -> scanBatchId: null AND no publish
        // attempt) is derived once, up front, by the single shared helper — see its doc in
        // cortex-decision-snapshot.ts for why an already-published repeat must run fully unbound
        // rather than just skipping the publish call while still tagging its output with the real id.
        const scanBatchBinding = scanBatchTickBinding(cached?.scanBatchId);
        const scanStatus = coreScanAutoRefreshController.getStatus();
        const fallbackSnapshot =
          cached || scanStatus.lastAutoRefreshResultSummary ? null : getRegimeDirectionControllerSnapshotStore().readLatest();
        const regime =
          cached?.marketRegime ?? scanStatus.lastAutoRefreshResultSummary?.marketRegime ?? fallbackSnapshot?.currentRegime ?? null;
        const axis = buildRegimeAxisTimeline(getRegimeEngineStore().snapshots);
        const report = buildRegimeDirectionControllerReport({
          currentRegime: regime,
          adaptiveDirectionBias: null,
          primaryValidationLane: null,
          edgeGate: getRegimeEdgeMemory(),
          axisScore: axis.current?.score ?? null,
          axisSlopePerHour: axis.slopePerHour ?? null,
        });
        const status = engine.getStatus();
        // 2026-07-21 CRITICAL fix: must read the TRUE operator table (rawLaneAllocationWeightPctForLane),
        // never laneSelectionWeightPctForLane — that accessor ALSO applies CORTEX's own promoted-weight
        // override, so using it here fed CORTEX's prior output back in as this cycle's "static" input,
        // a self-referential loop that manufactured a phantom concentration and blocked promotion forever.
        const staticWeightPctForLane = normalizeCortexStaticWeightPctForLane(
          (laneId) => engine.rawLaneAllocationWeightPctForLane(laneId),
        );
        const deps = buildLiveCortexGatherDeps({
          staticWeightPctForLane,
          edgeMemory: getRegimeEdgeMemory(),
          controller: {
            directionalBias: report.directionalBias,
            convictionScore: report.convictionScore,
            allowsLong: report.allowsLong,
            allowsShort: report.allowsShort,
            controllerMode: report.controllerMode,
            edgeGated: report.edgeGated,
          },
          regimeRaw: regime,
          axisScore: axis.current?.score ?? null,
          axisSlopePerHour: axis.slopePerHour ?? null,
          killLatched: status.killedAt != null,
          killBudgetUsd: status.limits?.maxDrawdownUsd ?? null,
        });
        const context = gatherCortexContext(deps);
        // End-to-end correctness migration: the legacy logistic learner is
        // diagnostic-only. Its output cannot become an allocation authority
        // while post-fix economic evidence and exact ownership are incomplete.
        // Passing null actively clears a prior override on every tick.
        const promotion = null;
        const { promotedWeights, snapshots } = runCortexShadowTick({
          store: cortexStore,
          journal: cortexJournal,
          context,
          nowIso: new Date().toISOString(),
          scanBatchId: scanBatchBinding.tickScanBatchId,
          mode,
          resolvedThisCycle: 0,
          promotion,
        });
        if (scanBatchBinding.shouldPublish) {
          // Blocker 4 / Point 1: this 5-min tick can re-fire against the SAME scanBatchId as its own
          // prior call (the scan cache refreshes only every 7 min) — that repeat must never be
          // attempted as a fresh publish, since its content (a new nowIso ⇒ new atMs ⇒ new
          // decisionIds) can never byte-match the first call and would poison the batch as a false
          // CONFLICT. scanBatchTickBinding already ensures the tick above ran unbound (scanBatchId:
          // null) in that case, so there is nothing new to publish here either. A genuinely different
          // publish under this scanBatchId from any OTHER source is unaffected — this guard only ever
          // skips OUR OWN routine repeat, publishCortexDecisionSnapshotsForScan itself is unchanged.
          const publication = publishCortexDecisionSnapshotsForScan(scanBatchBinding.tickScanBatchId, snapshots);
          if (publication === "CONFLICT" || publication === "INVALID") {
            recordCortexProductionChainDiagnostic("CORTEX_SCAN_PUBLICATION_CONFLICT");
          }
        }
        // Every cycle re-derives this from scratch and pushes it (including null) — a lost gate, a
        // failed invariant check, or the mode dropping back to 'shadow' all self-heal to the incumbent
        // table within one tick.
        engine.setCortexPromotedWeights(promotedWeights);
      } catch (err) {
        console.error("[cortex-shadow] tick failed", err);
        // 2026-07-20 safety-review fix (HIGH): a mid-cycle throw here must NEVER leave a PRIOR cycle's
        // promoted override installed and unrefreshed — a stuck real-money-adjacent tilt from a broken
        // cycle is worse than falling back to the incumbent table. Every failure clears the override;
        // it only comes back once a cycle completes cleanly end to end.
        liveEngine?.setCortexPromotedWeights(null);
      }
    };
    if (!isTest) {
      cortexShadowTick();
      setInterval(cortexShadowTick, 5 * 60_000);
    }

    // ── CORTEX #218 nightly refit (outcome-attribution + per-archetype logistic refit) ───────────────
    // Gated on shadow OR live mode (opt-out CORTEX_REFIT_ENABLED=0) — learning must keep running even
    // once an instance is promoted, so the ramp/gate/damping the promotion reads all stay current.
    // Idempotent: attributes each lane's OWN resolved closes to their owning decisions, refits the
    // archetype coefficients (ACCEPTED only), and advances cumulativeResolved/resolvedByFamily via the
    // monotonic watermark. It NEVER touches CORTEX_LIVE_BETA (0) or the promoted β — this writes only
    // the coefficients + coverage report that cortexPromotedBeta later reads; the tick above is the
    // only place a gated/damped β ever gets computed. Runs at boot + every 6h (a same-run re-read adds
    // 0, so cadence is harmless); the report feeds #219 and gates the promotion above.
    const cortexRefitTick = () => {
      try {
        const refitMode = cortexBrainMode(process.env);
        if ((refitMode !== "shadow" && refitMode !== "live") || !liveEngine || process.env.CORTEX_REFIT_ENABLED === "0") return;
        const engine = liveEngine;
        const now = new Date();
        // 2026-07-21 CRITICAL fix: same reasoning as the shadow-tick site above — the nightly refit's
        // own notion of "static weight" (which feeds cortexBlindCapitalPct/roster coverage) must also be
        // immune to CORTEX's own currently-installed promoted override.
        const staticWeightPctForLane = normalizeCortexStaticWeightPctForLane(
          (laneId) => engine.rawLaneAllocationWeightPctForLane(laneId),
        );
        const report = runCortexNightlyRefit({
          store: cortexStore,
          dataDir: "data",
          journalFile: "data/cortex-decision-journal.jsonl",
          staticWeightPctForLane,
          nowMs: now.getTime(),
          nowIso: now.toISOString(),
        });
        console.log(
          `[cortex-refit] examples=${report.examplesTotal} (+${report.examplesNew} new) resolved=${report.coverage.cumulativeResolved} ` +
            `families=${report.coverage.regimeFamiliesWithOutcomes} blindCapital=${report.coverage.blindCapitalPct.toFixed(0)}% ` +
            `refits=[${report.archetypes.map((a) => `${a.archetype}:${a.status}`).join(", ")}]`,
        );
      } catch (err) {
        console.error("[cortex-refit] pass failed", err);
      }
    };
    if (!isTest) {
      cortexRefitTick();
      // Testnet can refit more frequently to turn resolved collection into
      // feedback quickly. Production retains the six-hour default unless an
      // operator explicitly configures a different cadence.
      const cortexRefitIntervalMs = Math.max(
        60_000,
        Number(process.env.CORTEX_REFIT_INTERVAL_MS ?? 6 * 60 * 60_000),
      );
      setInterval(cortexRefitTick, cortexRefitIntervalMs);
    }

    const legacyEntryAllowed = (
      laneId: string,
      direction: "LONG" | "SHORT",
      fallback: () => boolean,
    ): boolean => isTestnetCrossSectionalHorizonLaneAllowed(liveConfig.env, laneId)
      && (unifiedOrchestrator?.isEnabled()
        ? unifiedOrchestrator.allowsLegacySingleSymbolEntry(laneId, direction)
        : fallback());

    /**
     * The explanation half of legacyEntryAllowed: which rule is actually holding this lane's
     * isAllowed() false. Mirrors the predicate's branch order exactly, so a null here means "every
     * condition passed", not "the one condition I happened to check passed".
     *
     * WHY (2026-07-27): every executor below was wired with `isAllowedReason: () => edgeVeto(dir).reason`
     * — the LAST of five conditions. REGIME_COMPOSITE_CONFIRMATION_LONG, the only lane on this
     * account with a positive real-money record (9 closes, +$7.79), stopped opening on 2026-07-14
     * while its own signal store kept producing candidates through 2026-07-26. For twelve days its
     * status panel showed `entryBlockReason: null` and nobody could see anything wrong, because the
     * blocking condition was one of the four the reason function could not observe. Silence read as
     * health. Every lane here now reports the rule that stopped it.
     */
    const legacyEntryBlockReason = (
      laneId: string,
      direction: "LONG" | "SHORT",
      engine: Parameters<typeof newExecutorLaneGate>[2],
      mainnetEntryEligible: boolean,
    ): string | null => {
      if (unifiedOrchestrator?.isEnabled()) {
        return unifiedOrchestrator.allowsLegacySingleSymbolEntry(laneId, direction)
          ? null
          : "unified orchestrator is enabled and denied this legacy single-symbol entry";
      }
      return (
        newExecutorLaneGate(
          laneId,
          liveConfig.env === "testnet" ? "testnet" : "mainnet",
          engine,
          { mainnetEntryEligible },
        ).reason ?? edgeVeto(direction).reason
      );
    };

    // 2026-07-12 (profitability Stage 3): the learned regime×direction edge-memory veto — measured
    // to work where blanket regime-gating cost the book ~201R — was wired into the mode-2 mirror
    // admission and the live engine's controller snapshot, but NOT the single-symbol executors that
    // actually hold the live-allocated weight (RC/CE/CG). Compose it into their isAllowed as an
    // additive protection: a direction proven net-negative in the current regime family (n≥30,
    // avgNetR≤0) is vetoed UNLESS a specific proven-positive lane rescues it (hasPositiveLane,
    // same semantics as regime-direction-controller.ts). NEVER applied to the market-neutral basket
    // executors (a per-direction veto would break their long/short hedge invariant). Fails OPEN on
    // a missing/blank regime — it protects, it does not become a new blanket gate. Uses the SAME
    // regime string the live engine's own controller snapshot reads, so the two never disagree.
    //
    // 2026-08 canonical-market-regime redirect: `currentRegimeStringForVeto` used to read the LIVE
    // producer-A regime string (scan cache -> auto-refresh summary -> regime-direction-controller
    // snapshot fallback, exactly like `getControllerSnapshot` above). It now returns the canonical
    // engine's regimeFamily mapped onto the SAME three edge-memory buckets producer A's free-text
    // already landed in (see `edgeMemoryLabelForCanonicalFamily`'s doc comment, verified directly
    // against the real regime-edge-memory.ts `normalizeRegimeFamily` by
    // canonical-market-regime-execution-policy.test.ts). `edgeVeto` itself below (the
    // mem.verdict(...)/hasPositiveLane(...) logic) is BYTE-IDENTICAL — only this string source
    // changes.
    //
    // Note on the "fails OPEN on a missing/blank regime" line immediately below: with the shared
    // accessor now reconnected to the real (if still perpetually cold-start, pending a future
    // ingestion-cadence stage) engine, `getCanonicalMarketRegimeSnapshot()` is NEVER null anymore —
    // `degradedLowCoverageSnapshot()` forces `regimeFamily: "MIXED"` (requirement #5), which
    // `edgeMemoryLabelForCanonicalFamily` maps to the truthy string "CANONICAL_MIXED_ROTATION", not
    // null/empty. So this fail-open branch is no longer reached on cold start (it WAS, when the
    // shared accessor was a `() => null` stub) — `edgeVeto` now genuinely queries
    // `getRegimeEdgeMemory().verdict("CANONICAL_MIXED_ROTATION", direction)` even during cold start.
    // This still does not widen anything for the ALLOWED boolean: every direct `.allowed` caller of
    // `edgeVeto` (every SingleSymbolLaneExecutor `isAllowed` below) is gated behind
    // `isNewExecutorLaneAllowed`/`newExecutorLaneGate` -> `engine.canOpenNewEntries()` -> the
    // now-redirected `unifiedRegimeEntryGate`, which blocks FIRST via `&&` short-circuit whenever the
    // canonical snapshot is LOW_COVERAGE (cold start included) — `edgeVeto(...).allowed` is never
    // even evaluated for gating while the engine has not ticked. The ONE place this genuinely changes
    // observable behavior is the REGIME_EDGE_MEMORY vote site below (not gated behind
    // canOpenNewEntries()): it can now push a real veto vote for "CANONICAL_MIXED_ROTATION" where it
    // previously silently never fired — but a veto can only ever SUPPRESS a direction, never grant
    // one, so this is a strictly more-conservative activation, not a widening. See this round's
    // report for the full reasoning.
    const currentRegimeStringForVeto = (): string | null =>
      edgeMemoryLabelForCanonicalFamily(getCanonicalMarketRegimeSnapshot()?.regimeFamily ?? "UNKNOWN");
    const edgeVeto = (direction: "LONG" | "SHORT"): { allowed: boolean; reason: string | null } => {
      const regime = currentRegimeStringForVeto();
      if (!regime || regime.trim().length === 0) return { allowed: true, reason: null }; // fail-open
      const mem = getRegimeEdgeMemory();
      const v = mem.verdict(regime, direction);
      if (v.allowed) return { allowed: true, reason: null }; // ALLOW_PROVEN / ALLOW_INSUFFICIENT
      if (mem.hasPositiveLane(regime, direction)) return { allowed: true, reason: null }; // lane rescue
      return {
        allowed: false,
        reason: `edge-memory veto: ${direction} proven non-positive in "${regime}" (${v.reasonCode ?? "VETO_NEGATIVE"})`,
      };
    };
    const unifiedPortfolioExitPolicy: SingleSymbolExitPolicy | undefined = unifiedOrchestrator?.isEnabled()
      ? (ctx) => unifiedOrchestrator!.legacyExitDecision(ctx)
      : undefined;
    if (!isTest) liveEngine.start();

    crossSectionalDirectionalDecisionRef = () => {
      const canonical = canonicalMarketRegimeExecutionPolicy({
        snapshot: getCanonicalMarketRegimeSnapshot(),
        nowMs: Date.now(),
      });
      const basketOwnedLegs = [
        ...(crossSectionalExecutor?.getOpenUnexitedLegs() ?? []),
        ...(crossSectionalTrendExecutor?.getOpenUnexitedLegs() ?? []),
        ...(crossSectionalMixedExecutor?.getOpenUnexitedLegs() ?? []),
      ];
      return confirmCrossSectionalDirectionalRegime(
        buildCrossSectionalDirectionalRegimeDecision(getLatestScanCandidates(), {
          // Opposite basket side is never rankable. Same side reaches the
          // live P&L admission check below and is rejected while underwater.
          excludedLongSymbols: new Set(basketOwnedLegs.filter((leg) => leg.side === "SHORT").map((leg) => leg.symbol)),
          excludedShortSymbols: new Set(basketOwnedLegs.filter((leg) => leg.side === "LONG").map((leg) => leg.symbol)),
        }),
        {
          allowed: canonical.allowed,
          requireRetest: canonical.requireRetest,
          regimeFamily: canonical.regimeFamily,
          reason: canonical.reason,
        },
      );
    };
    const crossSectionalDirectionalDecision = () => crossSectionalDirectionalDecisionRef();
    // Directional conviction and a market-neutral hedge are distinct decisions.
    // A valid canonical MIXED regime may have an inconclusive directional scan;
    // in that case keep directional lanes flat but let the fully hedged 3x3
    // executor evaluate its own independent FILTERED signal and safeguards.
    const directionalRegimeAllowsBalancedBasket = () => {
      if (!isCrossSectionalDirectionalRegimeExecEnabled()) return true;
      const decision = crossSectionalDirectionalDecision();
      return decision.mode === "BALANCED_3X3" ||
        (decision.mode === "NO_TRADE" && decision.canonicalAllowed === true && decision.canonicalRegimeFamily === "MIXED");
    };
    const directionalReversalStore = new DirectionalReversalStateStore("data");
    const directionalRegimeExitPolicy = (activeMode: "BEAR_SHORT_3" | "BULL_LONG_3"): SingleSymbolExitPolicy => (ctx) => {
      const risk = Math.abs(ctx.entryPrice - ctx.stopPrice);
      const r = risk > 0
        ? (ctx.direction === "LONG" ? ctx.currentPrice - ctx.entryPrice : ctx.entryPrice - ctx.currentPrice) / risk
        : 0;
      const nextPeakFavorableR = Math.max(ctx.peakFavorableR, r);
      const decision = crossSectionalDirectionalDecision();
      const reversal = directionalReversalStore.observe(ctx.symbol, activeMode, decision, Date.now());
      return {
        shouldExit: reversal.shouldExit,
        reason: reversal.reason,
        nextPeakFavorableR,
      };
    };

    // Cross-sectional market-neutral EXECUTOR (testnet-first). Env-gated; on mainnet
    // it additionally requires the engine to be ARMED, so the flag alone can never
    // trade real money. Consumes the same store the measurement lane writes.
    if (isCrossSectionalExecEnabled()) {
      const engineForGate = liveEngine;
      crossSectionalExecutor = new CrossSectionalExecutor({
        client: liveClient,
        signalStore: getCrossSectionalStore(),
        store: new CrossSectionalExecutorStore(),
        // 2026-07-20 real-money audit fix (round 2): the first pass only swapped canOpenNewEntries()
        // for the manual-directional-blind variant, but every isAllowed() branch still ANDed
        // laneSelectionAllowsLane()/allowsCrossSectionalLane() — both of which ALSO route through
        // effectiveLaneAllocations()'s manual-directional substitution once manual mode is on, so a
        // basket that (by design) is never listed in either LONG/SHORT array stayed blocked exactly
        // as before. When isCrossSectionalAllocationIndependent() is on, admission must mirror the
        // sizing exemption above and skip the lane-selector check ENTIRELY (armed/killed/drain only,
        // via canOpenNewEntriesIgnoringManualDirectional()) — otherwise fall back to the original,
        // fully-coupled behavior so disabling the flag really does disable independence, not just sizing.
        isAllowed: () => directionalRegimeAllowsBalancedBasket() && crossSectionalMarketNeutralIsAllowed({
          allocationIndependent: isCrossSectionalAllocationIndependent(),
          canOpenIgnoringManualDirectional: () => engineForGate?.canOpenNewEntriesIgnoringManualDirectional() ?? false,
          canOpenNewEntries: () => engineForGate?.canOpenNewEntries() ?? false,
          unifiedOrchestratorEnabled: unifiedOrchestrator?.isEnabled() ?? false,
          allowsCrossSectionalLane: () => unifiedOrchestrator?.allowsCrossSectionalLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) ?? false,
          laneSelectionAllowsLane: () => engineForGate?.laneSelectionAllowsLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) ?? false,
        }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) ?? 0,
        // 2026-07-22 bug-hunt fix: this executor's real basket closes were never wired into
        // cortex-real-attribution.ts at all (see CrossSectionalExecutorOptions.rawLaneWeightPct /
        // .cortexRealAttribution doc comments) — same pattern as every other lane below.
        rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) ?? 100,
        // 2026-08-15: submit-time reference quote for every basket leg. `warmPublicQuote` is the
        // SAME currentPublicPrice the single-symbol lanes already use — it fetches the USD-M book
        // ticker and populates the shared cache as a side effect — and `readPublicQuote` is the
        // synchronous read of that cache. Cross-basket previously had only Binance's MARK price
        // (via getPositions), which is not the book: a market BUY lifts the ask, so `fill - mark`
        // folds half the spread into what looks like slippage and the two cannot be separated
        // afterwards. Both are optional in the executor and every failure path is swallowed there,
        // so this can only ever add a record — never block or delay a placement.
        readPublicQuote,
        warmPublicQuote: currentPublicPrice,
        cortexRealAttribution: getCortexRealAttributionStore(),
        // Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
        // closeBasket() already fetches one getUserTrades page per unique symbol to sum the real
        // commissions and discards every other field of every matched row; this persists them.
        // No new exchange call. Same singleton as the engine and the single-symbol lanes.
        executionFillRecorder: getExecutionFillRecorder(),
        fourBrainActualFillBindings: fourBrainActualFillBindingsRef ?? undefined,
        fourBrainEntryGate: fourBrainPilotEntryGate,
        entryHealthGate: () => {
          const report = buildCrossSectionalReport(getCrossSectionalStore(), Date.now(), {
            variant: "FILTERED",
            sinceMs: getCrossSectionalReportSinceMs(),
          });
          const rolling = rollingNetEntryHealth(report.recentNetReturns);
          if (!rolling.allowed) return rolling; // existing PnL-rolling-health gate wins first, unchanged
          // 2026-08 canonical-market-regime addition (requirement #7): an ADDITIONAL AND-ed term,
          // never a replacement for the rolling-health gate above — same shared
          // canonicalMarketRegimeExecutionPolicy decision every other execution-affecting path this
          // round now consults, not a reimplementation. TREND/MIXED variants need no equivalent
          // change here: they already read canOpenNewEntriesIgnoringManualDirectional() ->
          // unifiedRegimeEntryGate when admission-independent (isCrossSectionalTrendMixedAdmissionIndependent),
          // which inherits the canonical engine via that one redirect automatically, with no
          // per-lane code change. cross-sectional-edge.ts's own signal-production regime
          // conditioning (classifyCrossSectionalRegime / basket selection) is untouched — this is
          // execution policy only.
          const regimeDecision = canonicalMarketRegimeExecutionPolicy({
            snapshot: getCanonicalMarketRegimeSnapshot(),
            nowMs: Date.now(),
          });
          if (!regimeDecision.allowed) return { allowed: false, reason: regimeDecision.reason };
          return rolling;
        },
        // 2026-07-11 real-money audit fix: FILTERED/TREND/MIXED share ONE netted exchange account —
        // closures over these `let`s so each sees the OTHER TWO's CURRENT legs at tick time, not
        // their (still-null) construction-time value. See CrossSectionalExecutorOptions.siblingOpenLegs.
        siblingOpenLegs: () => [
          ...(crossSectionalTrendExecutor?.getOpenUnexitedLegs() ?? []),
          ...(crossSectionalMixedExecutor?.getOpenUnexitedLegs() ?? []),
        ],
        // 2026-07-12 real-money audit fix: XSEC_DAILY_MAX_LOSS_USD is ONE shared ceiling across all
        // 3 sibling instances — see CrossSectionalExecutorOptions.siblingDailyRealizedUsd.
        siblingDailyRealizedUsd: (nowIso) =>
          (crossSectionalTrendExecutor?.getDailyRealizedUsd(nowIso) ?? 0) +
          (crossSectionalMixedExecutor?.getDailyRealizedUsd(nowIso) ?? 0),
        sharedGetPositions,
        // 2026-07-19 real-money audit fix: see CrossSectionalExecutorOptions.existingNotionalForSymbol
        // and live-executor-wiring.ts's computeNotionalPerSymbol doc comment — closes the gap where
        // this lane's ETHUSDT/SOLUSDT legs had zero visibility into the 9 single-symbol lanes'
        // (RC/CE-WIDE_LONG/CE-FAST_LONG included) already-open same-symbol exposure.
        existingNotionalForSymbol: (symbol) => crossSectionalNotionalForSymbolExcluding(crossSectionalExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        ...sharedExposureReservation,
      });
      if (!isTest) {
        const execTick = () => void crossSectionalExecutor?.tick();
        setTimeout(execTick, 90_000); // first run after the first cross-sectional cycle
        setInterval(execTick, 5 * 60_000);
      }

      // 2026-07-08 (operator: "wire lane baru ke allocation selection, jangan sampe ada blocker"):
      // two ADDITIONAL executor instances, one per newly-wired cross-sectional variant. Unlike the
      // FILTERED foundation instance above, these are NOT allocation-independent — they trade only
      // once an explicit allocation (operator or regime-autopilot preset) gives their lane id a
      // weight, the same opt-in convention used for every other newly-wired lane in this batch
      // (see lane-selector-v2.ts's manualEnabledVariantIds bypass on the directional-mirror side).
      // Each variant's OWN signal production already regime-gates itself (TREND_LONG/SHORT and
      // MIXED_CHOP respectively — see cross-sectional-edge.ts), so this allocation gate is a
      // second, independent layer of control, not a duplicate of that regime gate.
      crossSectionalTrendExecutor = new CrossSectionalExecutor({
        client: liveClient,
        signalStore: getCrossSectionalStore(),
        store: new CrossSectionalExecutorStore(undefined, "cross-sectional-executor-trend.json"),
        targetVariant: "TREND_BETA_VOL",
        laneId: CROSS_SECTIONAL_TREND_LANE_ID,
        // 2026-07-08 audit fix: isNewExecutorLaneAllowed requires EXPLICIT allocation inclusion,
        // not just laneSelectionAllowsLane (which defaults to true when NO allocation is set at
        // all — the "reorder, never reject" ALL_LANES convention every established lane relies
        // on). Without this, a brand-new lane the operator has never actually picked would
        // silently trade at FULL SIZE the instant the engine is armed and no allocation happens
        // to be active yet (e.g. right after a restart, before RegimeAutopilot's first apply, or
        // during an auto-reset-on-loss window).
        // 2026-07-22 (CORTEX capital-coverage diagnosis): when explicitly turned on, this lane
        // becomes admission-independent — same bypass shape as MARKET_NEUTRAL's own
        // allocationIndependent branch above (armed/kill-switch/drain only, via
        // canOpenNewEntriesIgnoringManualDirectional) — see
        // isCrossSectionalTrendMixedAdmissionIndependent's doc comment for why. Off by default;
        // the rest of this ternary is untouched, so disabling the flag is a byte-for-byte revert.
        isAllowed: () => !isTestnetCrossSectionalHorizonLaneAllowed(liveConfig.env, CROSS_SECTIONAL_TREND_LANE_ID)
          ? false
          : isCrossSectionalTrendMixedAdmissionIndependent()
            ? (engineForGate?.canOpenNewEntriesIgnoringManualDirectional() ?? false)
          : unifiedOrchestrator?.isEnabled()
            ? unifiedOrchestrator.allowsCrossSectionalLane(CROSS_SECTIONAL_TREND_LANE_ID)
            : isNewExecutorLaneAllowed(CROSS_SECTIONAL_TREND_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_TREND_LANE_ID) ?? 100,
        // 2026-07-22 bug-hunt fix: see the FILTERED instance above.
        rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(CROSS_SECTIONAL_TREND_LANE_ID) ?? 100,
        cortexRealAttribution: getCortexRealAttributionStore(),
        // Per-fill execution recorder — see the FILTERED instance above.
        executionFillRecorder: getExecutionFillRecorder(),
        siblingOpenLegs: () => [
          ...(crossSectionalExecutor?.getOpenUnexitedLegs() ?? []),
          ...(crossSectionalMixedExecutor?.getOpenUnexitedLegs() ?? []),
        ],
        siblingDailyRealizedUsd: (nowIso) =>
          (crossSectionalExecutor?.getDailyRealizedUsd(nowIso) ?? 0) +
          (crossSectionalMixedExecutor?.getDailyRealizedUsd(nowIso) ?? 0),
        sharedGetPositions,
        // Same 2026-07-19 real-money audit fix as the foundation instance above.
        existingNotionalForSymbol: (symbol) => crossSectionalNotionalForSymbolExcluding(crossSectionalTrendExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        ...sharedExposureReservation,
      });
      crossSectionalMixedExecutor = new CrossSectionalExecutor({
        client: liveClient,
        signalStore: getCrossSectionalStore(),
        store: new CrossSectionalExecutorStore(undefined, "cross-sectional-executor-mixed.json"),
        targetVariant: "MIXED_MEAN_REVERSION",
        laneId: CROSS_SECTIONAL_MIXED_LANE_ID,
        // Same 2026-07-08 fix as CROSS_SECTIONAL_TREND above, plus the same 2026-07-22
        // admission-independence bypass (see CROSS_SECTIONAL_TREND's isAllowed above).
        isAllowed: () => !isTestnetCrossSectionalHorizonLaneAllowed(liveConfig.env, CROSS_SECTIONAL_MIXED_LANE_ID)
          ? false
          : isCrossSectionalTrendMixedAdmissionIndependent()
            ? (engineForGate?.canOpenNewEntriesIgnoringManualDirectional() ?? false)
          : unifiedOrchestrator?.isEnabled()
            ? unifiedOrchestrator.allowsCrossSectionalLane(CROSS_SECTIONAL_MIXED_LANE_ID)
            : isNewExecutorLaneAllowed(CROSS_SECTIONAL_MIXED_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_MIXED_LANE_ID) ?? 100,
        // 2026-07-22 bug-hunt fix: see the FILTERED instance above.
        rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(CROSS_SECTIONAL_MIXED_LANE_ID) ?? 100,
        cortexRealAttribution: getCortexRealAttributionStore(),
        // Per-fill execution recorder — see the FILTERED instance above.
        executionFillRecorder: getExecutionFillRecorder(),
        siblingOpenLegs: () => [
          ...(crossSectionalExecutor?.getOpenUnexitedLegs() ?? []),
          ...(crossSectionalTrendExecutor?.getOpenUnexitedLegs() ?? []),
        ],
        siblingDailyRealizedUsd: (nowIso) =>
          (crossSectionalExecutor?.getDailyRealizedUsd(nowIso) ?? 0) +
          (crossSectionalTrendExecutor?.getDailyRealizedUsd(nowIso) ?? 0),
        sharedGetPositions,
        // Same 2026-07-19 real-money audit fix as the foundation instance above.
        existingNotionalForSymbol: (symbol) => crossSectionalNotionalForSymbolExcluding(crossSectionalMixedExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        ...sharedExposureReservation,
      });
      if (!isTest) {
        // Staggered start/interval offsets vs. the FILTERED tick above — purely to avoid dispatching
        // 3 executors' Binance calls in the exact same event-loop tick, not a correctness requirement.
        const trendTick = () => void crossSectionalTrendExecutor?.tick();
        const mixedTick = () => void crossSectionalMixedExecutor?.tick();
        setTimeout(trendTick, 120_000);
        setInterval(trendTick, 5 * 60_000);
        setTimeout(mixedTick, 150_000);
        setInterval(mixedTick, 5 * 60_000);
      }
    }

    // Directional cross-sectional sublanes (testnet only). The selector is mutually exclusive:
    // BEAR_SHORT_3 opens the three highest-quality relative-model weak shorts; BULL_LONG_3 is
    // symmetric; BALANCED_3X3 leaves this pair flat and permits the existing complete hedge.
    // A changed, stale, contradictory, or incomplete scan yields NO_TRADE and blocks new
    // directional entries while its exchange STOP_MARKET remains live. An open directional
    // position closes from this overlay only after two distinct scans confirm the opposite mode.
    if (isCrossSectionalDirectionalRegimeExecEnabled()) {
      const engineForGate = liveEngine;
      const laneAllowed = (laneId: string, mode: "BEAR_SHORT_3" | "BULL_LONG_3") =>
        isTestnetCrossSectionalHorizonLaneAllowed(liveConfig.env, laneId) &&
        crossSectionalDirectionalDecision().mode === mode &&
        (engineForGate?.canOpenNewEntriesIgnoringManualDirectional() ?? false);
      const laneReason = (mode: "BEAR_SHORT_3" | "BULL_LONG_3") => {
        const decision = crossSectionalDirectionalDecision();
        return decision.mode === mode ? null : decision.reason;
      };
      const common = {
        client: liveClient,
        exitPolicy: makeMfeGivebackExitPolicy({
          armR: DIRECTIONAL_REGIME_MFE_ARM_R(),
          givebackFrac: DIRECTIONAL_REGIME_MFE_GIVEBACK_FRACTION(),
          profitLockNetReturn: DIRECTIONAL_REGIME_MFE_PROFIT_LOCK_NET_RETURN(),
          profitLockR: DIRECTIONAL_REGIME_MFE_PROFIT_LOCK_R(),
          estimatedCloseCostPct: liveConfig.estimatedCloseCostPct,
          maxHoldMs: DIRECTIONAL_REGIME_MAX_HOLD_HOURS() * 3_600_000,
        }),
        // Post-only entry, THESE TWO LANES ONLY. Every other SingleSymbolLaneExecutor keeps
        // crossing — none of them was analysed for maker fills.
        makerEntry: DIRECTIONAL_REGIME_MAKER_ENTRY,
        makerEntryWaitMs: DIRECTIONAL_REGIME_MAKER_ENTRY_WAIT_MS,
        laneWeightPct: () => 100,
        rawLaneWeightPct: () => 100,
        cortexRealAttribution: getCortexRealAttributionStore(),
        positionPathRecorder: getPositionPathRecorder(),
        executionFillRecorder: getExecutionFillRecorder(),
        fourBrainActualFillBindings: fourBrainActualFillBindingsRef ?? undefined,
        fourBrainEntryGate: fourBrainPilotEntryGate,
        legUsd: DIRECTIONAL_REGIME_LEG_USD,
        leverage: DIRECTIONAL_REGIME_LEVERAGE,
        maxOpenPositions: DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS,
        maxSignalAgeMs: DIRECTIONAL_REGIME_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: DIRECTIONAL_REGIME_DAILY_MAX_LOSS_USD,
        maxNotionalPerSymbolAcrossLanes,
        maxClusterPositionsAcrossLanes: clusterCapAcrossLanes,
        currentPrice: currentPublicPrice,
        readPublicQuote,
        sharedGetPositions,
        // The selector may revisit the same symbol on later scans, but SHORT/LONG 3
        // means three distinct symbols, never three independent copies of BNB/XRP.
        preventSameSymbolPyramiding: true,
        // Binance reports realized P&L on the account-netted symbol. Directional
        // results must use the lot's own entry/exit economics when a basket shares it,
        // otherwise dashboard/CORTEX/Four-Brain can learn a basket's P&L as theirs.
        useOwnLotPnlAttribution: true,
        allowSameDirectionExistingPosition: async (symbol: string, direction: "LONG" | "SHORT") => {
          const basketLegs = [
            ...(crossSectionalExecutor?.getOpenUnexitedLegsWithEntry() ?? []),
            ...(crossSectionalTrendExecutor?.getOpenUnexitedLegsWithEntry() ?? []),
            ...(crossSectionalMixedExecutor?.getOpenUnexitedLegsWithEntry() ?? []),
          ].filter((leg) => leg.symbol === symbol);
          if (basketLegs.length === 0) {
            return { allowed: false, reason: `${symbol}: existing position is not owned by a live basket` };
          }
          if (basketLegs.some((leg) => leg.side !== direction)) {
            return { allowed: false, reason: `${symbol}: basket has opposite-side leg; directional entry would net/reverse it` };
          }
          const mark = await currentPublicPrice(symbol).catch(() => null);
          if (!(typeof mark === "number" && Number.isFinite(mark) && mark > 0)) {
            return { allowed: false, reason: `${symbol}: harga live tidak tersedia untuk verifikasi P&L basket` };
          }
          const configuredCost = Number.parseFloat(process.env.LIVE_ESTIMATED_CLOSE_COST_PCT ?? "");
          const estimatedCloseCostPct = Number.isFinite(configuredCost) && configuredCost >= 0 ? configuredCost : 0.0022;
          const netAfterCloseCost = basketLegs.reduce((sum, leg) => {
            const gross = (direction === "LONG" ? mark - leg.entryPrice : leg.entryPrice - mark) * leg.qty;
            return sum + gross - mark * leg.qty * estimatedCloseCostPct;
          }, 0);
          if (!(netAfterCloseCost > 0)) {
            return {
              allowed: false,
              reason: `${symbol}: basket ${direction} masih ${netAfterCloseCost.toFixed(4)} USDT setelah estimasi biaya; directional tidak boleh menambah posisi kalah`,
            };
          }
          return { allowed: true };
        },
        onPositionClosed: (netUsd: number) => engineForGate?.recordExternalConsecutiveLossOutcome(netUsd),
        onPositionClosedDetail: ({ symbol, reason }: { symbol: string; reason: string }) => {
          if (reason.startsWith("DIRECTIONAL_REVERSAL_CONFIRMED:")) {
            directionalReversalStore.recordConfirmedReversalExit(symbol, Date.now());
          }
        },
        ...singleSymbolEntryClaims,
        ...sharedExposureReservation,
      };
      crossSectionalDirectionalShortExecutor = new SingleSymbolLaneExecutor({
        ...common,
        store: new SingleSymbolLaneExecutorStore("data", "cross-sectional-directional-short-executor.json"),
        laneId: CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID,
        direction: "SHORT",
        // Use the same confirmed decision as isAllowed(): canonical MIXED may reduce
        // scanner-led exposure to one/two slots, so signals must not re-expand to three.
        getOpenSignals: () => crossSectionalDirectionalOpenSignals(getLatestScanCandidates(), "SHORT", crossSectionalDirectionalDecision())
          .filter((signal) => directionalReversalStore.canOpen(signal.symbol, Date.now())),
        portfolioExitPolicy: directionalRegimeExitPolicy("BEAR_SHORT_3"),
        isAllowed: () => laneAllowed(CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID, "BEAR_SHORT_3"),
        isAllowedReason: () => laneReason("BEAR_SHORT_3"),
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(crossSectionalDirectionalShortExecutor, symbol),
        existingClusterOpenSymbols: (symbol, direction) =>
          clusterOpenSymbolsExcluding(crossSectionalDirectionalShortExecutor, symbol, direction),
      });
      crossSectionalDirectionalLongExecutor = new SingleSymbolLaneExecutor({
        ...common,
        store: new SingleSymbolLaneExecutorStore("data", "cross-sectional-directional-long-executor.json"),
        laneId: CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID,
        direction: "LONG",
        // See the matching SHORT executor above: pass the confirmed, sized decision.
        getOpenSignals: () => crossSectionalDirectionalOpenSignals(getLatestScanCandidates(), "LONG", crossSectionalDirectionalDecision())
          .filter((signal) => directionalReversalStore.canOpen(signal.symbol, Date.now())),
        portfolioExitPolicy: directionalRegimeExitPolicy("BULL_LONG_3"),
        isAllowed: () => laneAllowed(CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID, "BULL_LONG_3"),
        isAllowedReason: () => laneReason("BULL_LONG_3"),
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(crossSectionalDirectionalLongExecutor, symbol),
        existingClusterOpenSymbols: (symbol, direction) =>
          clusterOpenSymbolsExcluding(crossSectionalDirectionalLongExecutor, symbol, direction),
      });
      // Testnet is an execution environment too.  Previously these ticks only
      // ran outside testnet, leaving the directional lane permanently unable
      // to collect any sample even after a fresh scan became eligible.
      const directionalTickIntervalMs = isTest ? 30_000 : 5 * 60_000;
      const shortDirectionalInitialDelayMs = isTest ? 15_000 : 130_000;
      const longDirectionalInitialDelayMs = isTest ? 20_000 : 160_000;
      {
        const shortTick = () => void crossSectionalDirectionalShortExecutor?.tick();
        const longTick = () => void crossSectionalDirectionalLongExecutor?.tick();
        setTimeout(shortTick, shortDirectionalInitialDelayMs);
        setInterval(shortTick, directionalTickIntervalMs);
        setTimeout(longTick, longDirectionalInitialDelayMs);
        setInterval(longTick, directionalTickIntervalMs);
      }
    }

    // SHORT_FADE_EXHAUSTION single-symbol EXECUTOR (2026-07-08). Own enable flag
    // (SHORT_FADE_EXEC_ENABLED), independent of the cross-sectional/live-execution flags — this
    // lane never executed a real order anywhere before this date. On mainnet additionally requires
    // the engine ARMED, same posture as every other executor. Allocation-weight gated (NOT
    // allocation-independent) — trades only once the operator/autopilot names its lane id.
    if (isShortFadeExecEnabled()) {
      const engineForGate = liveEngine;
      shortFadeExecutor = new SingleSymbolLaneExecutor({
        client: liveClient,
        store: new SingleSymbolLaneExecutorStore("data", "short-fade-executor.json"),
        laneId: SF_PAPER_LANE_ID,
        direction: "SHORT",
        getOpenSignals: () => shortFadeOpenSignals(getShortFadeStore()),
        exitPolicy: shortFadeExitPolicy(),
        portfolioExitPolicy: unifiedPortfolioExitPolicy,
        // 2026-07-08 audit fix: see the cross-sectional TREND/MIXED comment above — require
        // EXPLICIT allocation inclusion so this never-before-executed lane can't silently fire at
        // full size before it has ever actually been named in an allocation.
        isAllowed: () => legacyEntryAllowed(
          SF_PAPER_LANE_ID,
          "SHORT",
          () => isNewExecutorLaneAllowed(SF_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }) && edgeVeto("SHORT").allowed,
        ),
        isAllowedReason: () => legacyEntryBlockReason(SF_PAPER_LANE_ID, "SHORT", engineForGate, false),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(SF_PAPER_LANE_ID) ?? 100,
        // CORTEX real-USDT attribution (2026-07-21, report-only): raw static weight (never tilted)
        // + shared attribution sink — same pair on every SingleSymbolLaneExecutor below.
        rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(SF_PAPER_LANE_ID) ?? 100,
        cortexRealAttribution: getCortexRealAttributionStore(),
        // Dense per-tick R-path recorder (2026-07-22, report-only) — same shared singleton as the
        // engine's own wiring above; same line on every SingleSymbolLaneExecutor below.
        positionPathRecorder: getPositionPathRecorder(),
        // Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
        // Reuses the getUserTrades pages this executor already fetches at settlement; no new
        // exchange call, no order-path work. Same process-wide singleton for every writer.
        executionFillRecorder: getExecutionFillRecorder(),
        legUsd: SF_EXEC_LEG_USD,
        leverage: SF_EXEC_LEVERAGE,
        maxOpenPositions: SF_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: SF_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: SF_EXEC_DAILY_MAX_LOSS_USD,
        // 2026-07-09 fix: cross-lane per-symbol notional cap — see live-executor-wiring.ts's
        // computeNotionalPerSymbol doc comment for the incident this closes.
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(shortFadeExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        // 2026-07-19 real-money audit fix: correlated-cluster cap, extended from the mirror — see
        // clusterOpenSymbolsExcluding's doc comment. This is the FIRST of the two lanes the audit
        // finding specifically flagged (SHORT_FADE_EXHAUSTION_CROWDED trades a
        // LINK/SEI/BNB/SOL-style correlated-alt universe) — currently at 0% weight, so this wiring
        // is a no-op until the operator raises it above 0.
        existingClusterOpenSymbols: (symbol, direction) => clusterOpenSymbolsExcluding(shortFadeExecutor, symbol, direction),
        maxClusterPositionsAcrossLanes: clusterCapAcrossLanes,
        currentPrice: currentPublicPrice,
        // RECORDING-ONLY (2026-07-27): synchronous, zero-I/O read of the two-sided quote the
        // currentPrice fetch above already produced. See SingleSymbolLaneExecutorOptions.readPublicQuote.
        readPublicQuote,
        sharedGetPositions,
        // 2026-07-19 real-money audit fix: feed the account-wide consecutive-loss kill-switch
        // condition (LiveExecutionEngine.recordExternalConsecutiveLossOutcome's doc comment) —
        // this lane's own closes never reached that counter before, so a losing streak concentrated
        // entirely here could never trip it. Same wiring on every sibling single-symbol executor
        // below, regardless of current allocation weight.
        onPositionClosed: (netUsd) => engineForGate?.recordExternalConsecutiveLossOutcome(netUsd),
        ...singleSymbolEntryClaims,
        ...sharedExposureReservation,
      });
      if (!isTest) {
        const sfTick = () => void shortFadeExecutor?.tick();
        setTimeout(sfTick, 180_000);
        setInterval(sfTick, 5 * 60_000);
      }
    }

    // INTRADAY_MOMENTUM_BREAKOUT single-symbol EXECUTOR (2026-07-08). Same posture as
    // SHORT_FADE_EXHAUSTION above, own enable flag (INTRADAY_MOMENTUM_EXEC_ENABLED).
    if (isIntradayMomentumExecEnabled()) {
      const engineForGate = liveEngine;
      intradayMomentumExecutor = new SingleSymbolLaneExecutor({
        client: liveClient,
        store: new SingleSymbolLaneExecutorStore("data", "intraday-momentum-executor.json"),
        laneId: IM_PAPER_LANE_ID,
        direction: "LONG",
        getOpenSignals: () => intradayMomentumOpenSignals(getIntradayMomentumStore()),
        exitPolicy: intradayMomentumExitPolicy(),
        portfolioExitPolicy: unifiedPortfolioExitPolicy,
        // 2026-07-08 audit fix: same as SHORT_FADE_EXHAUSTION above.
        isAllowed: () => legacyEntryAllowed(
          IM_PAPER_LANE_ID,
          "LONG",
          () => isNewExecutorLaneAllowed(IM_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }) && edgeVeto("LONG").allowed,
        ),
        isAllowedReason: () => legacyEntryBlockReason(IM_PAPER_LANE_ID, "LONG", engineForGate, false),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(IM_PAPER_LANE_ID) ?? 100,
        rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(IM_PAPER_LANE_ID) ?? 100,
        cortexRealAttribution: getCortexRealAttributionStore(),
        positionPathRecorder: getPositionPathRecorder(),
        // Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
        // Reuses the getUserTrades pages this executor already fetches at settlement; no new
        // exchange call, no order-path work. Same process-wide singleton for every writer.
        executionFillRecorder: getExecutionFillRecorder(),
        legUsd: IM_EXEC_LEG_USD,
        leverage: IM_EXEC_LEVERAGE,
        maxOpenPositions: IM_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: IM_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: IM_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(intradayMomentumExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        // 2026-07-19 real-money audit fix: see shortFadeExecutor above. This is the SECOND lane the
        // audit finding specifically flagged (INTRADAY_MOMENTUM_BREAKOUT_LONG trades the entire
        // scanner universe, which can include a correlated-alt cluster) — currently at 0% weight,
        // so this wiring is a no-op until the operator raises it above 0.
        existingClusterOpenSymbols: (symbol, direction) => clusterOpenSymbolsExcluding(intradayMomentumExecutor, symbol, direction),
        maxClusterPositionsAcrossLanes: clusterCapAcrossLanes,
        currentPrice: currentPublicPrice,
        // RECORDING-ONLY (2026-07-27): synchronous, zero-I/O read of the two-sided quote the
        // currentPrice fetch above already produced. See SingleSymbolLaneExecutorOptions.readPublicQuote.
        readPublicQuote,
        sharedGetPositions,
        // 2026-07-19 real-money audit fix — see shortFadeExecutor above.
        onPositionClosed: (netUsd) => engineForGate?.recordExternalConsecutiveLossOutcome(netUsd),
        ...singleSymbolEntryClaims,
        ...sharedExposureReservation,
      });
      if (!isTest) {
        const imTick = () => void intradayMomentumExecutor?.tick();
        setTimeout(imTick, 210_000);
        setInterval(imTick, 5 * 60_000);
      }
    }

    // REGIME_COMPOSITE_CONFIRMATION_LONG single-symbol EXECUTOR (2026-07-09). Same posture as
    // SHORT_FADE_EXHAUSTION/INTRADAY_MOMENTUM_BREAKOUT above, own enable flag
    // (REGIME_COMPOSITE_EXEC_ENABLED). See regime-composite-edge.ts — this lane gates on axis
    // score + per-symbol crowding state instead of cross-sectional dispersion or per-symbol
    // rotation history, wired straight to live on operator's explicit 2026-07-09 request with
    // zero prior measurement (see that module's header comment).
    if (isRegimeCompositeExecEnabled()) {
      const engineForGate = liveEngine;
      regimeCompositeExecutor = new SingleSymbolLaneExecutor({
        client: liveClient,
        store: new SingleSymbolLaneExecutorStore("data", "regime-composite-executor.json"),
        laneId: RC_PAPER_LANE_ID,
        direction: "LONG",
        getOpenSignals: () => regimeCompositeOpenSignals(getRegimeCompositeStore()),
        exitPolicy: regimeCompositeExitPolicy(),
        portfolioExitPolicy: unifiedPortfolioExitPolicy,
        // 2026-07-08 audit fix pattern (same as its siblings above): require EXPLICIT allocation
        // inclusion so this never-before-executed lane can't silently fire at full size before
        // the operator has ever actually named its lane id in an allocation.
        // 2026-07-10: operator explicitly granted mainnet eligibility to THIS lane specifically
        // (real track record: 2 open live positions plus a real MFE_GIVEBACK profit close) after
        // formalizing it into the live allocation table at a small (3%) weight — see
        // regime-classifier-neutral-recovery-stuck-fix-2026-07-10 / the live-profitability-pathway
        // audit that surfaced this lane was silently running outside the allocation table. Its
        // siblings (PANIC_WASHOUT_RECLAIM_LONG, SHORT_FADE_EXHAUSTION_CROWDED) stay ineligible —
        // this is a per-lane decision, not a blanket override.
        isAllowed: () => legacyEntryAllowed(
          RC_PAPER_LANE_ID,
          "LONG",
          () => isNewExecutorLaneAllowed(RC_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: true }) && edgeVeto("LONG").allowed,
        ),
        isAllowedReason: () => legacyEntryBlockReason(RC_PAPER_LANE_ID, "LONG", engineForGate, true),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(RC_PAPER_LANE_ID) ?? 100,
        rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(RC_PAPER_LANE_ID) ?? 100,
        cortexRealAttribution: getCortexRealAttributionStore(),
        positionPathRecorder: getPositionPathRecorder(),
        // Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
        // Reuses the getUserTrades pages this executor already fetches at settlement; no new
        // exchange call, no order-path work. Same process-wide singleton for every writer.
        executionFillRecorder: getExecutionFillRecorder(),
        legUsd: RC_EXEC_LEG_USD,
        leverage: RC_EXEC_LEVERAGE,
        maxOpenPositions: RC_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: RC_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: RC_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(regimeCompositeExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        // 2026-07-19 real-money audit fix: see shortFadeExecutor above.
        existingClusterOpenSymbols: (symbol, direction) => clusterOpenSymbolsExcluding(regimeCompositeExecutor, symbol, direction),
        maxClusterPositionsAcrossLanes: clusterCapAcrossLanes,
        currentPrice: currentPublicPrice,
        // RECORDING-ONLY (2026-07-27): synchronous, zero-I/O read of the two-sided quote the
        // currentPrice fetch above already produced. See SingleSymbolLaneExecutorOptions.readPublicQuote.
        readPublicQuote,
        sharedGetPositions,
        // 2026-07-19 real-money audit fix — see shortFadeExecutor above. This lane is one of the 3
        // holding 100% of today's real money — the original motivating gap for this fix.
        onPositionClosed: (netUsd) => engineForGate?.recordExternalConsecutiveLossOutcome(netUsd),
        ...singleSymbolEntryClaims,
        ...sharedExposureReservation,
      });
      if (!isTest) {
        const rcTick = () => void regimeCompositeExecutor?.tick();
        setTimeout(rcTick, 240_000);
        setInterval(rcTick, 5 * 60_000);
      }
    }

    // Bearish counterpart of REGIME_COMPOSITE_CONFIRMATION_LONG. It only opens its own fresh
    // BTC/ETH/SOL signals after the operator explicitly allocates this lane.
    if (isRegimeCompositeShortExecEnabled()) {
      const engineForGate = liveEngine;
      regimeCompositeShortExecutor = new SingleSymbolLaneExecutor({
        client: liveClient,
        store: new SingleSymbolLaneExecutorStore("data", "regime-composite-short-executor.json"),
        laneId: RCS_PAPER_LANE_ID,
        direction: "SHORT",
        getOpenSignals: () => regimeCompositeShortOpenSignals(getRegimeCompositeShortStore()),
        exitPolicy: regimeCompositeShortExitPolicy(),
        portfolioExitPolicy: unifiedPortfolioExitPolicy,
        isAllowed: () => legacyEntryAllowed(
          RCS_PAPER_LANE_ID,
          "SHORT",
          () => isNewExecutorLaneAllowed(RCS_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: true }) && edgeVeto("SHORT").allowed,
        ),
        isAllowedReason: () => legacyEntryBlockReason(RCS_PAPER_LANE_ID, "SHORT", engineForGate, true),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(RCS_PAPER_LANE_ID) ?? 100,
        rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(RCS_PAPER_LANE_ID) ?? 100,
        cortexRealAttribution: getCortexRealAttributionStore(),
        positionPathRecorder: getPositionPathRecorder(),
        // Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
        // Reuses the getUserTrades pages this executor already fetches at settlement; no new
        // exchange call, no order-path work. Same process-wide singleton for every writer.
        executionFillRecorder: getExecutionFillRecorder(),
        legUsd: RCS_EXEC_LEG_USD,
        leverage: RCS_EXEC_LEVERAGE,
        maxOpenPositions: RCS_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: RCS_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: RCS_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(regimeCompositeShortExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        // 2026-07-19 real-money audit fix: see shortFadeExecutor above.
        existingClusterOpenSymbols: (symbol, direction) => clusterOpenSymbolsExcluding(regimeCompositeShortExecutor, symbol, direction),
        maxClusterPositionsAcrossLanes: clusterCapAcrossLanes,
        currentPrice: currentPublicPrice,
        // RECORDING-ONLY (2026-07-27): synchronous, zero-I/O read of the two-sided quote the
        // currentPrice fetch above already produced. See SingleSymbolLaneExecutorOptions.readPublicQuote.
        readPublicQuote,
        sharedGetPositions,
        // 2026-07-19 real-money audit fix — see shortFadeExecutor above.
        onPositionClosed: (netUsd) => engineForGate?.recordExternalConsecutiveLossOutcome(netUsd),
        ...singleSymbolEntryClaims,
        ...sharedExposureReservation,
      });
      if (!isTest) {
        const rcsTick = () => void regimeCompositeShortExecutor?.tick();
        setTimeout(rcsTick, 255_000);
        setInterval(rcsTick, 5 * 60_000);
      }
    }

    // PANIC_WASHOUT_RECLAIM_LONG single-symbol EXECUTOR (2026-07-09). Same posture as
    // REGIME_COMPOSITE_CONFIRMATION_LONG above, own enable flag (PANIC_WASHOUT_EXEC_ENABLED). See
    // panic-washout-reclaim-edge.ts — wired straight to live on operator's explicit request with
    // ZERO prior measurement of this exact 3-stage signal; sized smaller (PWR_EXEC_LEG_USD) than
    // its siblings for that reason.
    if (isPanicWashoutExecEnabled()) {
      const engineForGate = liveEngine;
      panicWashoutExecutor = new SingleSymbolLaneExecutor({
        client: liveClient,
        store: new SingleSymbolLaneExecutorStore("data", "panic-washout-reclaim-executor.json"),
        laneId: PWR_PAPER_LANE_ID,
        direction: "LONG",
        getOpenSignals: () => panicWashoutOpenSignals(getPanicWashoutStore()),
        exitPolicy: panicWashoutExitPolicy(),
        portfolioExitPolicy: unifiedPortfolioExitPolicy,
        // 2026-07-08 audit fix pattern (same as its siblings above): require EXPLICIT allocation
        // inclusion so this never-before-executed lane can't silently fire at full size before
        // the operator has ever actually named its lane id in an allocation.
        isAllowed: () => legacyEntryAllowed(
          PWR_PAPER_LANE_ID,
          "LONG",
          () => isNewExecutorLaneAllowed(PWR_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }) && edgeVeto("LONG").allowed,
        ),
        isAllowedReason: () => legacyEntryBlockReason(PWR_PAPER_LANE_ID, "LONG", engineForGate, false),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(PWR_PAPER_LANE_ID) ?? 100,
        rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(PWR_PAPER_LANE_ID) ?? 100,
        cortexRealAttribution: getCortexRealAttributionStore(),
        positionPathRecorder: getPositionPathRecorder(),
        // Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
        // Reuses the getUserTrades pages this executor already fetches at settlement; no new
        // exchange call, no order-path work. Same process-wide singleton for every writer.
        executionFillRecorder: getExecutionFillRecorder(),
        legUsd: PWR_EXEC_LEG_USD,
        leverage: PWR_EXEC_LEVERAGE,
        maxOpenPositions: PWR_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: PWR_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: PWR_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(panicWashoutExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        // 2026-07-19 real-money audit fix: see shortFadeExecutor above.
        existingClusterOpenSymbols: (symbol, direction) => clusterOpenSymbolsExcluding(panicWashoutExecutor, symbol, direction),
        maxClusterPositionsAcrossLanes: clusterCapAcrossLanes,
        currentPrice: currentPublicPrice,
        // RECORDING-ONLY (2026-07-27): synchronous, zero-I/O read of the two-sided quote the
        // currentPrice fetch above already produced. See SingleSymbolLaneExecutorOptions.readPublicQuote.
        readPublicQuote,
        sharedGetPositions,
        // 2026-07-19 real-money audit fix — see shortFadeExecutor above.
        onPositionClosed: (netUsd) => engineForGate?.recordExternalConsecutiveLossOutcome(netUsd),
        ...singleSymbolEntryClaims,
        ...sharedExposureReservation,
      });
      if (!isTest) {
        const pwrTick = () => void panicWashoutExecutor?.tick();
        setTimeout(pwrTick, 270_000);
        setInterval(pwrTick, 5 * 60_000);
      }
    }

    // COMPOSITE_ESTIMATOR_BIDI single-symbol EXECUTORS (2026-07-09), one per bucket. Same posture
    // as every other single-symbol executor above, own enable flag (COMPOSITE_ESTIMATOR_EXEC_ENABLED)
    // shared across all 4 (they're one conceptual lane, not 4 independent ones — see
    // composite-estimator-edge.ts). WIDE_SHORT/FAST_LONG are the UNPROVEN quadrants (zero measured
    // edge anywhere in this codebase, unlike WIDE_LONG/FAST_SHORT) — ceExecLegUsdForBucket applies
    // the size cut there, not a separate gate, so real evidence still accrues for all 4 buckets.
    if (isCompositeEstimatorExecEnabled()) {
      const engineForGate = liveEngine;
      const buildCompositeEstimatorExecutor = (
        bucket: CEBucket,
        direction: "LONG" | "SHORT",
        storeFile: string,
        selfGetter: () => SingleSymbolLaneExecutor | null,
      ) => {
        const laneId = ceLaneIdForBucket(bucket);
        return new SingleSymbolLaneExecutor({
          client: liveClient,
          store: new SingleSymbolLaneExecutorStore("data", storeFile),
          laneId,
          direction,
          getOpenSignals: () => compositeEstimatorOpenSignals(getCompositeEstimatorStore(), bucket),
          exitPolicy: compositeEstimatorExitPolicy(bucket),
          portfolioExitPolicy: unifiedPortfolioExitPolicy,
          // 2026-07-08 audit fix pattern (same as every sibling above): require EXPLICIT allocation
          // inclusion so a never-before-executed lane can't silently fire at full size before the
          // operator has ever actually named its lane id in an allocation.
          // 2026-07-10: operator granted mainnet eligibility to WIDE_LONG specifically (real track
          // record: an open live position plus a real profit close today) after formalizing it into
          // the live allocation table at a small (3%) weight. WIDE_SHORT and FAST_SHORT (the
          // remaining unproven/negative quadrants) stay ineligible — a per-bucket decision, not a
          // blanket override.
          // 2026-07-19: operator explicitly reviewed FAST_LONG's measured track record (n=30
          // resolved observations, win rate 70%, profit factor 1.115, mean +0.033R/trade — thin but
          // genuinely positive) and granted mainnet eligibility to this bucket specifically. This
          // does not contradict CE_UNPROVEN_BUCKETS in composite-estimator-edge.ts, which still
          // correctly keeps applying its conservative size-cut to FAST_LONG given the thin sample —
          // that label refers to zero PRIOR backtest evidence at this module's 2026-07-09 design
          // time, not the live measurement accrued since, and the size-cut behavior is intentionally
          // left untouched (same conservative-sizing posture as WIDE_LONG's own 3% promotion above).
          // WIDE_SHORT and FAST_SHORT remain ineligible — both are measured net-negative in live data
          // (PF 0.575 and 0.558 respectively) — this is a per-bucket decision, not a blanket change.
          isAllowed: () => legacyEntryAllowed(
            laneId,
            direction,
            () => isNewExecutorLaneAllowed(laneId, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: bucket === "WIDE_LONG" || bucket === "FAST_LONG" }) && edgeVeto(direction).allowed,
          ),
          isAllowedReason: () => legacyEntryBlockReason(laneId, direction, engineForGate, bucket === "WIDE_LONG" || bucket === "FAST_LONG"),
          laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(laneId) ?? 100,
          rawLaneWeightPct: () => engineForGate?.rawLaneAllocationWeightPctForLane(laneId) ?? 100,
          cortexRealAttribution: getCortexRealAttributionStore(),
          positionPathRecorder: getPositionPathRecorder(),
          // Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
          // Reuses the getUserTrades pages this executor already fetches at settlement; no new
          // exchange call, no order-path work. Same process-wide singleton for every writer.
          executionFillRecorder: getExecutionFillRecorder(),
          legUsd: () => ceExecLegUsdForBucket(bucket),
          leverage: CE_EXEC_LEVERAGE,
          maxOpenPositions: CE_EXEC_MAX_CONCURRENT,
          // 2026-07-19: FAST_LONG now resolves its OWN freshness-window override
          // (COMPOSITE_ESTIMATOR_FAST_LONG_EXEC_MAX_SIGNAL_AGE_MS, falling back to the shared
          // default when unset) via ceExecMaxSignalAgeMsForBucket — WIDE_LONG/WIDE_SHORT/FAST_SHORT
          // still resolve through the unchanged shared CE_EXEC_MAX_SIGNAL_AGE_MS. Added as
          // infrastructure only — the env var is deliberately left UNSET, see the doc comment on
          // CE_FAST_LONG_EXEC_MAX_SIGNAL_AGE_MS in composite-estimator-edge.ts for why (the low
          // historical trade count here was actually caused by a separate mainnetEntryEligible
          // hardcode, not confirmed to be caused by staleness).
          maxSignalAgeMs: () => ceExecMaxSignalAgeMsForBucket(bucket),
          dailyMaxLossUsd: CE_EXEC_DAILY_MAX_LOSS_USD,
          // 2026-07-09 fix: cross-lane per-symbol notional cap — selfGetter lets each of the 4
          // buckets exclude only ITS OWN positions (not the other 3 buckets, which DO count
          // toward each other's exposure on the same symbol, same as every other lane).
          existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(selfGetter(), symbol),
          maxNotionalPerSymbolAcrossLanes,
          // 2026-07-19 real-money audit fix: see shortFadeExecutor above. selfGetter (same rationale
          // as the notional cap immediately above) lets each of the 4 buckets exclude only ITS OWN
          // positions from the "other lanes" side — the caller adds this instance's own open
          // positions back in separately (see existingClusterOpenSymbols's doc comment).
          existingClusterOpenSymbols: (symbol, entryDirection) => clusterOpenSymbolsExcluding(selfGetter(), symbol, entryDirection),
          maxClusterPositionsAcrossLanes: clusterCapAcrossLanes,
          currentPrice: currentPublicPrice,
          // RECORDING-ONLY (2026-07-27) — see shortFadeExecutor above.
          readPublicQuote,
          sharedGetPositions,
          // 2026-07-19 real-money audit fix — see shortFadeExecutor above. WIDE_LONG/FAST_LONG are 2
          // of the 3 lanes holding 100% of today's real money — the original motivating gap.
          onPositionClosed: (netUsd) => engineForGate?.recordExternalConsecutiveLossOutcome(netUsd),
          ...singleSymbolEntryClaims,
          ...sharedExposureReservation,
        });
      };
      compositeEstimatorWideLongExecutor = buildCompositeEstimatorExecutor("WIDE_LONG", "LONG", "composite-estimator-wide-long-executor.json", () => compositeEstimatorWideLongExecutor);
      compositeEstimatorWideShortExecutor = buildCompositeEstimatorExecutor("WIDE_SHORT", "SHORT", "composite-estimator-wide-short-executor.json", () => compositeEstimatorWideShortExecutor);
      compositeEstimatorFastLongExecutor = buildCompositeEstimatorExecutor("FAST_LONG", "LONG", "composite-estimator-fast-long-executor.json", () => compositeEstimatorFastLongExecutor);
      compositeEstimatorFastShortExecutor = buildCompositeEstimatorExecutor("FAST_SHORT", "SHORT", "composite-estimator-fast-short-executor.json", () => compositeEstimatorFastShortExecutor);
      if (!isTest) {
        // Staggered offsets, purely to avoid dispatching 4 executors' Binance calls in the same tick.
        const ticks: Array<[() => SingleSymbolLaneExecutor | null, number]> = [
          [() => compositeEstimatorWideLongExecutor, 270_000],
          [() => compositeEstimatorWideShortExecutor, 285_000],
          [() => compositeEstimatorFastLongExecutor, 300_000],
          [() => compositeEstimatorFastShortExecutor, 315_000],
        ];
        for (const [getExec, offsetMs] of ticks) {
          const tick = () => void getExec()?.tick();
          setTimeout(tick, offsetMs);
          setInterval(tick, 5 * 60_000);
        }
      }
    }

    // /research innovation execution bridge. This is deliberately testnet-only and has no
    // strategy-evidence, promotion, quarantine, edge-memory, or unified-orchestrator gate.
    // It still uses the established executors, so armed/kill/drain state, exchange filters,
    // one-way netting, protective stops, allocation, notional caps, and cluster caps remain intact.
    // 2026-08 canonical-market-regime addition (requirement #7): this bridge now ALSO has a regime
    // gate — see innovationAllowed below — an ADDITIONAL AND-ed term alongside the pre-existing
    // armed/kill/drain check, never a research-maturity/allocation gate (those remain intentionally
    // absent, per the rest of this comment).
    if (liveEngine && isInnovationTestnetExecutionEnabled(liveConfig.env)) {
      const engineForGate = liveEngine;
      // Fail-closed campaign control (innovation-campaign.ts): AND, never a replacement —
      // canOpenNewEntriesIgnoringManualDirectional() still runs and still governs
      // armed/kill/drain/regime exactly as before. Only a lane the CURRENT campaign explicitly
      // admits (enabled, within window, named in allowedLaneIds, under every cap) can ever reach
      // that engine check at all.
      const innovationAllowed = (laneId: string): boolean =>
        isTestnetCrossSectionalHorizonLaneAllowed(liveConfig.env, laneId) &&
        innovationCampaignAdmissionForLane(laneId).allowed &&
        innovationTestnetAdmissionAllowed(
          engineForGate.canOpenNewEntriesIgnoringManualDirectional(),
          // 2026-08 canonical-market-regime addition (requirement #7): the SAME shared
          // canonicalMarketRegimeExecutionPolicy decision every other execution-affecting path this
          // round now consults, AND-ed alongside the pre-existing armed/kill/drain check inside
          // innovationTestnetAdmissionAllowed. Deliberate belt-and-suspenders with the
          // unifiedRegimeEntryGate redirect above: canOpenNewEntriesIgnoringManualDirectional()
          // already inherits the canonical engine transitively (it calls into the now-redirected
          // unifiedRegimeEntryGate), so today this AND is redundant with that inherited block —
          // made explicit anyway per the operator's own "make the call explicit either way and say
          // so" instruction, so innovationTestnetAdmissionAllowed stays correct in isolation (it is
          // directly unit-tested) rather than correct only by accident of today's caller.
          canonicalMarketRegimeExecutionPolicy({
            snapshot: getCanonicalMarketRegimeSnapshot(),
            nowMs: Date.now(),
          }).allowed,
        );
      const innovationWeight = (laneId: string): number => {
        const selected = engineForGate.laneSelectionWeightPctForLane(laneId);
        return innovationTestnetWeight(selected);
      };
      const innovationLegUsd = (): number => {
        const configured = Number(process.env.INNOVATION_TESTNET_LEG_USD);
        return innovationTestnetLegUsd(configured);
      };
      const innovationLeverage = (): number => {
        const configured = Number(process.env.INNOVATION_TESTNET_LEVERAGE);
        return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 3;
      };
      const innovationMaxOpen = (): number => {
        const configured = Number(process.env.INNOVATION_TESTNET_MAX_OPEN_PER_EXECUTOR);
        return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 4;
      };
      const innovationFreshMs = (): number => {
        const configured = Number(process.env.INNOVATION_TESTNET_MAX_SIGNAL_AGE_MS);
        return Number.isFinite(configured) && configured >= 60_000 ? Math.floor(configured) : 60 * 60_000;
      };

      const basketDescriptors = [
        {
          laneId: FC_PAPER_LANE_ID,
          observations: () => fundingCarryBaskets(getFundingCarryStore().all),
        },
        {
          laneId: FC_V2_LANE_ID,
          observations: () => fundingCarryBaskets(getFundingCarryCrowdingV2Store().all),
        },
        {
          laneId: HRS_V2_LANE_ID,
          observations: () => hedgedResidualBaskets(getHedgedResidualShortV2Store().all),
        },
      ];
      for (const descriptor of basketDescriptors) {
        let executor: CrossSectionalExecutor;
        executor = new CrossSectionalExecutor({
          client: liveClient,
          signalStore: asCrossSectionalSignalStore(descriptor.observations),
          store: new CrossSectionalExecutorStore(
            "data",
            `innovation-${descriptor.laneId.toLowerCase()}.json`,
            Date.now() - innovationFreshMs(),
          ),
          targetVariant: "FILTERED",
          laneId: descriptor.laneId,
          idNamespace: descriptor.laneId,
          enabled: () => true,
          isAllowed: () => innovationAllowed(descriptor.laneId),
          laneWeightPct: () => innovationWeight(descriptor.laneId),
          rawLaneWeightPct: () => innovationWeight(descriptor.laneId),
          cortexRealAttribution: getCortexRealAttributionStore(),
          executionFillRecorder: getExecutionFillRecorder(),
          entryHealthGate: () => innovationCampaignAdmissionForLane(descriptor.laneId),
          legUsd: innovationLegUsd,
          leverage: innovationLeverage,
          maxOpenBaskets: innovationMaxOpen,
          maxSignalAgeMs: innovationFreshMs,
          dailyMaxLossUsd: () => 0,
          respectSignalRiskGeometry: true,
          siblingOpenLegs: () =>
            allCrossSectionalLaneExecutors()
              .filter((candidate): candidate is CrossSectionalExecutor => candidate !== null && candidate !== executor)
              .flatMap((candidate) => candidate.getOpenUnexitedLegs()),
          siblingDailyRealizedUsd: (nowIso) =>
            allCrossSectionalLaneExecutors()
              .filter((candidate): candidate is CrossSectionalExecutor => candidate !== null && candidate !== executor)
              .reduce((sum, candidate) => sum + candidate.getDailyRealizedUsd(nowIso), 0),
          sharedGetPositions,
          existingNotionalForSymbol: (symbol) => crossSectionalNotionalForSymbolExcluding(executor, symbol),
          maxNotionalPerSymbolAcrossLanes,
          ...sharedExposureReservation,
          // Atomic campaign-cap enforcement (account-exposure-coordinator.ts's reserve() gate 2) —
          // re-read fresh on every call, same "no caching, operator edit takes effect immediately"
          // contract as loadInnovationCampaign itself. Only these innovation construction sites ever
          // populate campaignCap; every mainnet executor below gets the default () => undefined.
          campaignCap: () => campaignCapForLane(loadInnovationCampaign("data", "innovation-campaign.json"), descriptor.laneId),
        });
        innovationBasketExecutors.push(executor);
      }

      const singleDescriptors = [
        { laneId: BLS_LANE_ID, observations: () => getBtcLeadLagSnapStore().all, policy: "FIXED" },
        { laneId: LQR_LANE_ID, observations: () => getLiqRecoilStore().all, policy: "FIXED" },
        { laneId: LQR_V2_LANE_ID, observations: () => getLiqRecoilStrictReclaimV2Store().all, policy: "FIXED" },
        { laneId: CE_V2_LANE_ID, observations: () => getCompressionRetestV2Store().all, policy: "TRAIL" },
        { laneId: QITF_LANE_ID, observations: () => getQueueImbalanceToxicFlowStore().all, policy: "FIXED" },
      ] as const;
      for (const descriptor of singleDescriptors) {
        for (const direction of ["LONG", "SHORT"] as const) {
          let executor: SingleSymbolLaneExecutor;
          executor = new SingleSymbolLaneExecutor({
            client: liveClient,
            store: new SingleSymbolLaneExecutorStore(
              "data",
              `innovation-${descriptor.laneId.toLowerCase()}-${direction.toLowerCase()}.json`,
            ),
            laneId: descriptor.laneId,
            direction,
            getOpenSignals: () => singleSignalsForDirection(descriptor.observations(), direction),
            exitPolicy:
              descriptor.policy === "TRAIL"
                ? makeMfeGivebackExitPolicy({ armR: 0.5, givebackFrac: 0.5, maxHoldMs: 7 * 24 * 3_600_000 })
                : makeFixedRewardExitPolicy({ rewardMultiple: 100, maxHoldMs: 7 * 24 * 3_600_000 }),
            isAllowed: () => innovationAllowed(descriptor.laneId),
            isAllowedReason: () => innovationCampaignAdmissionForLane(descriptor.laneId).reason,
            laneWeightPct: () => innovationWeight(descriptor.laneId),
            rawLaneWeightPct: () => innovationWeight(descriptor.laneId),
            cortexRealAttribution: getCortexRealAttributionStore(),
            positionPathRecorder: getPositionPathRecorder(),
            executionFillRecorder: getExecutionFillRecorder(),
            legUsd: innovationLegUsd,
            leverage: innovationLeverage,
            maxOpenPositions: innovationMaxOpen,
            maxSignalAgeMs: innovationFreshMs,
            dailyMaxLossUsd: () => 0,
            existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(executor, symbol),
            maxNotionalPerSymbolAcrossLanes,
            existingClusterOpenSymbols: (symbol, entryDirection) =>
              clusterOpenSymbolsExcluding(executor, symbol, entryDirection),
            maxClusterPositionsAcrossLanes: clusterCapAcrossLanes,
            currentPrice: currentPublicPrice,
            readPublicQuote,
            maxEntryChaseStopFraction: () => 10,
            sharedGetPositions,
            onPositionClosed: (netUsd) => engineForGate.recordExternalConsecutiveLossOutcome(netUsd),
            ...singleSymbolEntryClaims,
            ...sharedExposureReservation,
            // Atomic campaign-cap enforcement — see the identical comment at the basket-descriptor
            // construction site above.
            campaignCap: () => campaignCapForLane(loadInnovationCampaign("data", "innovation-campaign.json"), descriptor.laneId),
          });
          innovationSingleSymbolExecutors.push(executor);
        }
      }

      if (!isTest) {
        const tickInnovations = async () => {
          for (const executor of innovationBasketExecutors) await executor.tick();
          for (const executor of innovationSingleSymbolExecutors) await executor.tick();
        };
        startInnovationTestnetExecutorSchedule(tickInnovations);
      }
    }

    // Regime auto-pilot (Tier 1) — auto-syncs the lane allocation to the report-only regime engine's
    // detected regime, with anti-whipsaw guards. Env-gated (REGIME_AUTOPILOT_ENABLED), testnet-first.
    // Requires the regime engine to be producing snapshots (REGIME_ENGINE_ENABLED=1). Never arms.
    if (isRegimeAutopilotEnabled() && liveEngine) {
      const engineForPilot = liveEngine;
      regimeAutopilot = new RegimeAutopilot({
        setAllocations: (a) => engineForPilot.applyRegimeAutopilotAllocation(a),
        getLatestRegime: () => {
          const snaps = getRegimeEngineStore().snapshots;
          return snaps.length > 0 ? snaps[snaps.length - 1]!.regime : null;
        },
        // Operator lane-allocation lock = operator owns the allocation; autopilot observes only.
        // NOT the same as isManualSelectorMode() (that's the unrelated RAW BYPASS toggle) — see
        // laneAllocationOperatorLock's doc comment on LiveExecutionState for the 2026-07-09
        // incident this distinction fixes.
        isManualMode: () => engineForPilot.isLaneAllocationOperatorLocked(),
        nowMs: () => Date.now(),
      });
      if (!isTest) {
        const pilotTick = () => { try { regimeAutopilot?.tick(); } catch { /* report-driven; never break the loop */ } };
        setTimeout(pilotTick, 120_000);
        setInterval(pilotTick, 5 * 60_000);
      }
    }
  }

  // 2026-08 canonical-market-regime scheduler wiring fix (HIGH deployment-scope gap) — the missing
  // orchestration cycle itself. Before this, ingestCanonicalMarketRegimeRawObservations /
  // computeCanonicalMarketRegimeSnapshot / recordCanonicalMarketRegimeSnapshot had zero production
  // callers, so getCanonicalMarketRegimeSnapshot() above could only ever resolve to its cold-start
  // degraded default. runCanonicalMarketRegimeEngineCycleGuarded (canonical-market-regime-scheduler.ts)
  // owns the ordering (resolveUniverse -> ingestRawObservations -> fetch BTC candles/per-symbol
  // funding+OI -> compute -> record), the overlap guard (a module-level single-flight latch — see
  // that file's own OVERLAP GUARD note for why module-level, not a buildApp()-local `let`, is what
  // keeps this safe even if buildApp() were somehow invoked twice), and the coarse kill switch
  // (CANONICAL_MARKET_REGIME_ENGINE_DISABLED, re-checked every cycle before any I/O — same env key
  // getCanonicalMarketRegimeSnapshot() already honors, not a second flag). This call site only
  // supplies the real dependencies: `binanceClient` (already used identically for the BTC
  // ATR-percentile/Kronos-anchor refreshes below) satisfies both CanonicalMarketRegimeUniverseFetchCtx
  // and the funding/OI/candle fetchers structurally, zero adapter code — mirrors
  // tlobCollector.collect(binanceClient, ...) below. getPriorSnapshot reads the store's own nullable
  // `.get()` (never the non-nullable degraded-default accessor above) so a genuine cold start is
  // never fed into the hysteresis/dedup logic as if it were a real prior cycle. BTC candles are run
  // through the same completedCandles(...) causal filter the engine's own per-symbol ingestion
  // applies internally (and refreshBtcAtrPercentileCache applies for this identical BTCUSDT/1h
  // series) — without it a still-forming hourly bar would repaint riskStress mid-hour. Cadence is
  // CANONICAL_MARKET_REGIME_ENGINE_TICK_INTERVAL_MS (5 minutes, that module's own doc-comment-stated
  // constant, matching the engine's own "5-minute tick / 1h-candle cadence" design).
  //
  // PLACEMENT FIX (2026-08-05): this block originally lived a few hundred lines earlier, physically
  // inside `if (liveConfig.enabled && liveConfig.configErrors.length === 0 && liveConfig.env) { ... }`
  // (right after `liveEngine.start()`), while its own doc comment claimed registration was
  // "unconditional under `!isTest`". That claim was false as deployed: LIVE_EXECUTION_ENABLED is "0" on
  // both research instances (3101 and the 3111 staging mirror), so the scheduler never registered
  // there at all — confirmed live via a research-staging instance that produced zero
  // "[canonical-market-regime-universe] resolved" log lines across its full runtime, versus a
  // testnet-staging instance (LIVE_EXECUTION_ENABLED=1) that logged a successful cycle within seconds
  // of boot. getCanonicalMarketRegimeSnapshot() on research was therefore still stuck at its cold-start
  // degraded default the whole time this "fix" was believed shipped. Moved here, past the liveConfig
  // block's closing brace, so registration is actually unconditional under `!isTest` as intended —
  // regime classification has nothing to do with whether live execution is configured. Never throws
  // (see that function's own doc comment); a failed cycle is still logged so a dead engine is visible
  // in the process logs rather than silently stuck at its degraded default again.
  const runCanonicalMarketRegimeEngineTick = (): void => {
    void runCanonicalMarketRegimeEngineCycleGuarded({
      resolveUniverse: (nowMs) => resolveCanonicalMarketRegimeUniverse({ nowMs, ctx: binanceClient }),
      ingestRawObservations: ingestCanonicalMarketRegimeRawObservations,
      fetchBtcCandles: () =>
        binanceClient
          .getCandles(BTC_ATR_PERCENTILE_SYMBOL, BTC_ATR_PERCENTILE_INTERVAL, BTC_ATR_PERCENTILE_CANDLES_NEEDED)
          .then((candles) => completedCandles(candles, BTC_ATR_PERCENTILE_INTERVAL)),
      fetchFuturesFlow: (symbol) => binanceClient.getFuturesFlow(symbol),
      getPriorSnapshot: () => getCanonicalMarketRegimeSnapshotStore().get(),
      recordSnapshot: recordCanonicalMarketRegimeSnapshot,
    })
      .then((result) => {
        if (result && !result.ok) {
          console.error(`[canonical-market-regime] cycle failed: ${result.error}`);
        }
      })
      .catch((err) => console.error("[canonical-market-regime] scheduler tick threw unexpectedly", err));
  };
  if (!isTest) {
    // 30s warm-up offset: after the ATR-percentile(10s)/Kronos-anchor(20s) BTC producers get their own
    // head start, before this heavier per-universe-symbol (up to 60) funding+OI fan-out fires — avoids
    // stacking every network-bound startup producer into the same instant.
    setTimeout(runCanonicalMarketRegimeEngineTick, 30_000);
    setInterval(runCanonicalMarketRegimeEngineTick, CANONICAL_MARKET_REGIME_ENGINE_TICK_INTERVAL_MS);
  }

  // Research/testnet-only CORTEX lifecycle for an allowlisted instance with execution disabled.
  // This is shadow-only and has no engine reference, promotion object, allocation setter, or execution
  // callback. The hard instance gate excludes 3103 independently of environment configuration.
  if (!isTest && standaloneCortexShadowAllowed({ env: process.env, liveEnginePresent: liveEngine != null })) {
    const cortexStore = new CortexBrainStore("data/cortex-brain.json");
    const cortexJournal = new CortexDecisionJournal("data/cortex-decision-journal.jsonl");
    // No live engine means no incumbent allocation. A synthetic 100%-per-lane
    // baseline made research coverage look funded when it was not.
    const staticWeightPctForLane = normalizeCortexStaticWeightPctForLane(() => 0);
    const cortexStandaloneContext = () => {
      const cached = getLatestScanCandidates();
      const scanStatus = coreScanAutoRefreshController.getStatus();
      const fallbackSnapshot =
        cached || scanStatus.lastAutoRefreshResultSummary ? null : getRegimeDirectionControllerSnapshotStore().readLatest();
      const regime =
        cached?.marketRegime ?? scanStatus.lastAutoRefreshResultSummary?.marketRegime ?? fallbackSnapshot?.currentRegime ?? null;
      const axis = buildRegimeAxisTimeline(getRegimeEngineStore().snapshots);
      const report = buildRegimeDirectionControllerReport({
        currentRegime: regime,
        adaptiveDirectionBias: null,
        primaryValidationLane: null,
        edgeGate: getRegimeEdgeMemory(),
        axisScore: axis.current?.score ?? null,
        axisSlopePerHour: axis.slopePerHour ?? null,
      });
      return gatherCortexContext(
        buildLiveCortexGatherDeps({
          staticWeightPctForLane,
          edgeMemory: getRegimeEdgeMemory(),
          controller: {
            directionalBias: report.directionalBias,
            convictionScore: report.convictionScore,
            allowsLong: report.allowsLong,
            allowsShort: report.allowsShort,
            controllerMode: report.controllerMode,
            edgeGated: report.edgeGated,
          },
          regimeRaw: regime,
          axisScore: axis.current?.score ?? null,
          axisSlopePerHour: axis.slopePerHour ?? null,
          killLatched: false,
          killBudgetUsd: null,
        }),
      );
    };
    const cortexStandaloneShadowTick = () => {
      try {
        if (!standaloneCortexShadowAllowed({ env: process.env, liveEnginePresent: liveEngine != null })) return;
        const cached = getLatestScanCandidates();
        // Blocker 4: see the identical guard/rationale in cortexShadowTick above — the shared helper
        // derives the tick's own scanBatchId (null ⇒ unbound/report-only when already published) and
        // the publish gate together, from one place.
        const scanBatchBinding = scanBatchTickBinding(cached?.scanBatchId);
        const result = runCortexShadowTick({
          store: cortexStore,
          journal: cortexJournal,
          context: cortexStandaloneContext(),
          nowIso: new Date().toISOString(),
          scanBatchId: scanBatchBinding.tickScanBatchId,
          mode: "shadow",
          resolvedThisCycle: 0,
          promotion: null,
        });
        if (scanBatchBinding.shouldPublish) {
          // Blocker 4: see the identical guard/rationale in cortexShadowTick above — this standalone
          // tick is the other of the only two callers of publishCortexDecisionSnapshotsForScan in the
          // repo, and re-fires on the same 5-min-vs-7-min-cache cadence.
          const publication = publishCortexDecisionSnapshotsForScan(scanBatchBinding.tickScanBatchId, result.snapshots);
          if (publication === "CONFLICT" || publication === "INVALID") {
            recordCortexProductionChainDiagnostic("CORTEX_SCAN_PUBLICATION_CONFLICT");
          }
        }
      } catch (err) {
        console.error("[cortex-shadow-standalone] tick failed", err);
      }
    };
    const cortexStandaloneRefitTick = () => {
      try {
        if (
          !standaloneCortexShadowAllowed({ env: process.env, liveEnginePresent: liveEngine != null }) ||
          process.env.CORTEX_REFIT_ENABLED === "0"
        ) return;
        const now = new Date();
        const report = runCortexNightlyRefit({
          store: cortexStore,
          dataDir: "data",
          journalFile: "data/cortex-decision-journal.jsonl",
          staticWeightPctForLane,
          baselineAvailable: false,
          nowMs: now.getTime(),
          nowIso: now.toISOString(),
        });
        console.log(
          `[cortex-refit-standalone] examples=${report.examplesTotal} (+${report.examplesNew} new) ` +
            `resolved=${report.coverage.cumulativeResolved} families=${report.coverage.regimeFamiliesWithOutcomes} ` +
            `blindCapital=${report.coverage.baselineAvailable ? `${report.coverage.blindCapitalPct.toFixed(0)}%` : "n/a"}`,
        );
      } catch (err) {
        console.error("[cortex-refit-standalone] pass failed", err);
      }
    };
    cortexStandaloneShadowTick();
    cortexStandaloneRefitTick();
    setInterval(cortexStandaloneShadowTick, 5 * 60_000);
    const cortexRefitIntervalMs = Math.max(
      60_000,
      Number(process.env.CORTEX_REFIT_INTERVAL_MS ?? 6 * 60 * 60_000),
    );
    setInterval(cortexStandaloneRefitTick, cortexRefitIntervalMs);
  }
  // ── Four-Brain intelligence layer — SHADOW tick (2026-07-13, testnet wiring) ─────────────────────
  // Report-only decision architecture (Market State / Direction / Entry / Exit + Executive) layered
  // ABOVE the incumbent + CORTEX. Placed OUTSIDE `if (liveConfig.enabled)` so it runs on 3101 (research,
  // no live engine) too. Runs ONLY when FOUR_BRAIN_MODE==="shadow" AND the instance is allowlisted
  // (3101 + 3102; the live 3103 is HARD-BLOCKED inside fourBrainInstanceAllowed regardless of env).
  // Default (mode off) ⇒ a pure no-op: zero I/O, zero gather, zero journal. It DRIVES NOTHING — never
  // sets allocations, places/cancels orders, mutates stops/positions/sizing, changes CORTEX_LIVE_BETA
  // (0), or lane eligibility. Every engine-dependent read degrades gracefully when liveEngine is null
  // (3101), so the tick still observes market state + direction + entry candidates from the lane stores.
  // Journal is instance-isolated (data/four-brain-decision-journal.jsonl per repo) + rotation-bounded
  // (CortexDecisionJournal 8MB→.1). Known-MISSING inputs (market-wide ATR%ile/sentiment/crowd/kronos,
  // sync mark price) are emitted MISSING — never fabricated — exactly as the source mapping documented.
  if (!isTest) {
    const fourBrainJournal = new CortexDecisionJournal("data/four-brain-decision-journal.jsonl");
    const fourBrainMetrics = new FourBrainMetricsAggregator();
    /** See collectFourBrainOpenSignals below: this scope is testnet/advisory-only. */
    const fourBrainTestnetFocus = fourBrainTestnetFocusEnabled;
    const fourBrainFocusSinceMs = (() => {
      const parsed = Date.parse(process.env.FOUR_BRAIN_TESTNET_FOCUS_SINCE ?? "");
      return Number.isFinite(parsed) ? parsed : Date.now();
    })();
    // A clean persisted cohort: never read legacy outcomes/pending rows, while retaining only
    // post-cutoff decisions across a testnet restart.
    const fourBrainOutcomeDataDir = fourBrainOutcomeDataDirRuntime;
    const focusedFourBrainLaneIds = new Set<string>([
      CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
      CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID,
      CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID,
      CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID,
      CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
    ]);
    // Bounded ring buffer (last 100) of recent MARKET_SNAPSHOT / EXECUTIVE_DECISION journal records, fed
    // at journal-append time below (see wrapFourBrainJournalAppendForRecentDecisions) — the operator
    // dashboard's /api/shadow/four-brain route reads this, NEVER the journal file, on every request.
    const fourBrainRecentDecisions = new FourBrainRecentDecisionsBuffer({ capacity: 100 });
    if (fourBrainShadowActive(process.env)) {
      const restored = hydrateFourBrainRecentDecisionsBuffer(
        fourBrainRecentDecisions,
        "data/four-brain-decision-journal.jsonl",
      );
      if (restored > 0) console.log(`[four-brain-shadow] restored ${restored} recent dashboard decisions after restart`);
    }
    // Bounded FIFO ledger (Direction cap 2000 / Entry cap 10000) of pending DIRECTION + ENTRY decisions,
    // fed at journal-append time below (see wrapFourBrainJournalAppendForOutcomeLedger) — the FOUNDATION
    // for a follow-up Direction/Entry Brain counterfactual outcome-resolution phase (not built here).
    // Deliberately separate from fourBrainRecentDecisions above: that 100-slot dashboard ring is far too
    // small to survive a 24h SWING decision's own resolution horizon.
    const fourBrainOutcomeLedger = new FourBrainOutcomeLedger();
    // Direction/Entry counterfactual outcome store (2026-07-23) — the persisted destination the
    // reconciler below writes RESOLVED/INSTRUMENT_DATA_MISSING/EXPIRED_UNRESOLVABLE outcomes into. The
    // store itself is safe to construct unconditionally (pure bookkeeping, mirrors every other
    // report-only store in this codebase); only the RECONCILER INTERVAL and the report getter below are
    // gated.
    const directionEntryOutcomeStore = getDirectionEntryOutcomeStore(fourBrainOutcomeDataDir);
    if (fourBrainTestnetFocus) {
      fourBrainExecutionReinforcementStatusGetterRef = () =>
        getFourBrainExecutionReinforcement(fourBrainOutcomeDataDir).getStatus();
    }
    if (directionEntryReconcilerActive(process.env)) {
      // Durable snapshot FIRST (2026-07-28). The journal replay below can only see ~2.4h — the two
      // journal files together — so INTRADAY (4h) and SWING (24h) rows could never survive a restart,
      // and research/3101 with its 254 restarts had never once held a resolved SWING row. This file
      // holds the pending rows themselves and has no such window. Journal replay still runs after, as
      // a second source; ids restored here are fed through its existing hasProcessed* predicates so a
      // row present in both is admitted exactly once (pushEntry, unlike pushDirection, does not dedup).
      const snapshot = loadPendingLedgerSnapshot(fourBrainOutcomeDataDir);
      for (const row of snapshot.direction) fourBrainOutcomeLedger.pushDirection(row);
      for (const row of snapshot.entry) fourBrainOutcomeLedger.pushEntry(row);
      const restoredDirectionIds = new Set(snapshot.direction.map((r) => r.decisionId));
      const restoredEntryIds = new Set(snapshot.entry.map((r) => r.decisionId));
      console.log(
        `[four-brain-pending-snapshot] instance=${resolveFourBrainInstanceId(process.env)} ` +
          `direction=${snapshot.direction.length} entry=${snapshot.entry.length} ` +
          `root=${fourBrainOutcomeDataDir} skipped=${snapshot.skippedReason ?? "none"}`,
      );
      const rehydrated = fourBrainTestnetFocus ? null : rehydrateFourBrainOutcomeLedgerFromJournals({
        ledger: fourBrainOutcomeLedger,
        journalFiles: [
          "data/four-brain-decision-journal.jsonl.1",
          "data/four-brain-decision-journal.jsonl",
        ],
        hasProcessedDirection: (decisionId) =>
          restoredDirectionIds.has(decisionId) || directionEntryOutcomeStore.hasProcessedDirection(decisionId),
        hasProcessedEntry: (decisionId) =>
          restoredEntryIds.has(decisionId) || directionEntryOutcomeStore.hasProcessedEntry(decisionId),
      });
      if (rehydrated) console.log(
        `[four-brain-outcome-rehydrate] instance=${resolveFourBrainInstanceId(process.env)} ` +
          `direction=${rehydrated.directionPendingRestored}/${rehydrated.directionEligibleUnprocessed} ` +
          `entry=${rehydrated.entryPendingRestored}/${rehydrated.entryEligibleUnprocessed} ` +
          `evicted=${rehydrated.directionEvictedDuringRehydrate + rehydrated.entryEvictedDuringRehydrate} ` +
          `entryIdsMigrated=${rehydrated.entryDecisionIdsMigrated} ` +
          `duplicates=${rehydrated.duplicateDirectionRowsSkipped + rehydrated.duplicateEntryRowsSkipped} ` +
          `skippedProcessed=${rehydrated.directionSkippedProcessed + rehydrated.entrySkippedProcessed} ` +
          `badLines=${rehydrated.badLines}`,
      );
    }
    // 2026-07-23 fix: only expose these to the /api/shadow/four-brain route's getters (⇒ `enabled:true`)
    // when the shadow cycle is ACTUALLY armed on this instance (fourBrainShadowActive — same composed
    // gate used below to arm the interval). This `if (!isTest)` block runs on every non-test process
    // regardless of FOUR_BRAIN_MODE, so unconditionally assigning fourBrainMetricsRef/
    // fourBrainRecentDecisionsRef here previously made the route report enabled:true (with an honestly
    // all-zero, but misleadingly-labeled, health object) even on an instance where shadow mode is off —
    // indistinguishable on the dashboard from "shadow mode is on and just hasn't completed a tick yet".
    if (fourBrainShadowActive(process.env)) {
      fourBrainMetricsRef = fourBrainMetrics; // exposed to the shadow routes' lazy getter (see above)
      fourBrainRecentDecisionsRef = fourBrainRecentDecisions; // exposed to the shadow routes' lazy getter
    }
    // Same fail-open discipline for the Direction/Entry outcome report — gated on the RECONCILER's own
    // (stricter, 3-layer) activation, not merely fourBrainShadowActive, since the report is meaningless
    // (perpetually empty) on an instance where the reconciler itself never runs.
    if (directionEntryReconcilerActive(process.env)) {
      directionEntryOutcomeReportGetterRef = () => {
        const pendingDirectionRows = fourBrainOutcomeLedger.getPendingDirectionRows();
        const directionByHorizon: Partial<Record<FourBrainOutcomeHorizon, number>> = {};
        for (const row of pendingDirectionRows) directionByHorizon[row.horizon] = (directionByHorizon[row.horizon] ?? 0) + 1;
        return buildDirectionEntryOutcomeReport(directionEntryOutcomeStore.getState(), {
          directionByHorizon,
          entry: fourBrainOutcomeLedger.entrySize,
        });
      };
    }
    // Real BTC ATR-percentile producer for buildFourBrainDeps (see call site below) — gated + intervaled
    // identically to the four-brain cycle itself (fourBrainMode==="shadow" && fourBrainInstanceAllowed), so
    // 3103 (live) never schedules this extra fetch either, matching every other four-brain-only interval in
    // this block.
    const btcAtrPercentileCache = getBtcAtrPercentileCacheStore();
    const kronosBtcAnchorCache = getKronosBtcAnchorCache();
    // New CPU forecasters are strictly a 3102 observation source. They only feed
    // Direction Brain's report-only shadow tick; CORTEX/execution remains unchanged.
    const challengerTestnetEnabled =
      process.env.CORTEX_CHALLENGERS_ENABLED === "1" &&
      resolveFourBrainInstanceId(process.env) === "3102";
    const chronos2BtcAnchorCache = new ForecastChallengerBtcAnchorCache();
    const timesfmBtcAnchorCache = new ForecastChallengerBtcAnchorCache();
    const tlobCollector = new TlobCollector();
    let fourBrainBtcFlowCache: {
      sentiment: number | null;
      crowdAlignLong: number | null;
      atMs: number;
    } | null = null;
    // Market State receives two additional report-only sources. Both retain their producer's own
    // observation time; a failed refresh preserves the old cache so normal freshness rules can
    // mark it STALE instead of silently minting a fresh neutral value.
    let fourBrainBtcLiquidityCache: {
      score: number | null;
      spreadBps: number | null;
      expectedSlippageBpsBuy: number | null;
      expectedSlippageBpsSell: number | null;
      atMs: number;
    } | null = null;
    let fourBrainEventRiskCache: { score: number | null; atMs: number; sourceId: string } | null = null;
    const ratioToSigned = (ratio: number | null): number | null =>
      typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0
        ? Math.max(-1, Math.min(1, (ratio - 1) / (ratio + 1)))
        : null;
    const CE_ALL_BUCKETS: CEBucket[] = ["WIDE_LONG", "FAST_LONG", "WIDE_SHORT", "FAST_SHORT"];
    // Retained handle for the report-only lane-context snapshot ticker (registered once, below) — see Stage-2 timer
    // ownership: single registration at boot, cleared on shutdown so a flush attempt never blocks termination.
    let laneContextSnapshotTimer: ReturnType<typeof setInterval> | null = null;
    // Retained handle: the SAME per-tick ownership index buildFourBrainDeps just built (below), so
    // onExecutiveDecision's attachExecutiveReviewToExactPaperOrder call can do an O(1)-ish lookup
    // through it instead of a fresh linear scan over the full order book — GAP A. Reused rather than
    // rebuilt, exactly like lastFourBrainGatherBase's own per-cycle retention contract further down.
    let lastPaperOrderOwnershipIndex: ReturnType<typeof buildPaperOrderOwnershipIndex> | null = null;
    // Retained handle: the SAME per-tick live-intent index buildFourBrainDeps just built (below), so
    // onExecutiveDecision's late-binding attach (point 2) can do an O(1)-ish lookup through it instead
    // of a fresh linear scan over the full intent store — point 5, mirroring
    // lastPaperOrderOwnershipIndex's identical per-cycle retention contract immediately above.
    let lastLiveIntentIndexByPaperOrderId: ReturnType<typeof buildLiveIntentIndexByPaperOrderId> | null = null;

    /**
     * Testnet experiment scope.  Four-Brain starts with exactly the three
     * currently executable cohorts and an explicit deployment cut, so old
     * CG/legacy evidence cannot leak into the new learning population.
     * It is collection/advisory-only; this flag is never consulted by any
     * execution, sizing, stop, or exit code.
     */
    const collectFourBrainOpenSignals = (nowMs = Date.now()): FourBrainBindingDeps["openSignals"] => {
      const out: FourBrainBindingDeps["openSignals"] = [];
      // An already-open basket/position is Exit-Brain material, not a new Entry-Brain opportunity.
      // Keeping it here through a long position horizon caused every 5-minute tick to recount a
      // stale signal as a fresh Entry decision.
      const entrySignalFresh = (openedAtMs: number): boolean =>
        Number.isFinite(openedAtMs)
          && openedAtMs <= nowMs + 60_000
          && nowMs - openedAtMs <= FRESHNESS_TTL_MS.signal;
      const add = (
        laneId: string,
        direction: "LONG" | "SHORT",
        sigs: { observationId: string; symbol: string; entryPrice: number; stopPrice: number; openedAtMs: number }[],
      ): void => {
        for (const s of sigs) {
          if (fourBrainTestnetFocus && !entrySignalFresh(s.openedAtMs)) continue;
          out.push({ laneId, symbol: s.symbol, direction, observationId: s.observationId, openedAtMs: s.openedAtMs, entryPrice: s.entryPrice, stopPrice: s.stopPrice });
        }
      };
      if (fourBrainTestnetFocus) {
        // Cross-horizon FILTERED/MOM36. Its frozen riskDistanceAtOpen is the
        // only honest per-leg invalidation proxy available in the observation;
        // a stopless/invalid row is skipped rather than invented.
        try {
          for (const basket of getCrossSectionalStore().reportable) {
            if (
              basket.status !== "OPEN"
              || basket.variant !== "FILTERED"
              || basket.openedAtMs < fourBrainFocusSinceMs
              || !entrySignalFresh(basket.openedAtMs)
            ) continue;
            const risk = basket.riskDistanceAtOpen;
            if (!(typeof risk === "number" && Number.isFinite(risk) && risk > 0 && risk < 0.5)) continue;
            for (const leg of basket.longLeg) {
              const stopPrice = leg.entryPrice * (1 - risk);
              if (stopPrice > 0) add(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID, "LONG", [{
                observationId: `${basket.observationId}:LONG:${leg.symbol}`,
                symbol: leg.symbol,
                entryPrice: leg.entryPrice,
                stopPrice,
                openedAtMs: basket.openedAtMs,
              }]);
            }
            for (const leg of basket.shortLeg) {
              const stopPrice = leg.entryPrice * (1 + risk);
              if (stopPrice > leg.entryPrice) add(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID, "SHORT", [{
                observationId: `${basket.observationId}:SHORT:${leg.symbol}`,
                symbol: leg.symbol,
                entryPrice: leg.entryPrice,
                stopPrice,
                openedAtMs: basket.openedAtMs,
              }]);
            }
          }
        } catch { /* unavailable cross-sectional store => no fabricated signal */ }

        // Directional sectional is already guarded by the live selector. Feed
        // only its exact chosen candidates, retaining the scan fingerprint in
        // observationId so future outcomes can join causally.
        try {
          const decision = crossSectionalDirectionalDecisionRef();
          add(CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID, "LONG", crossSectionalDirectionalOpenSignals(getLatestScanCandidates(), "LONG", decision));
          add(CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID, "SHORT", crossSectionalDirectionalOpenSignals(getLatestScanCandidates(), "SHORT", decision));
        } catch { /* stale/missing scan => no directional signal */ }

        // CG MFE Giveback: only the active XRP/WLD rollout, split by side so
        // one direction can never borrow evidence from the other.
        try {
          for (const signal of variantMatrixOpenSignals(getCurrentGuardVariantMatrixStore())) {
            if (
              signal.laneId !== "CG_MFE_GIVEBACK"
              || !["XRPUSDT", "WLDUSDT"].includes(signal.symbol)
              || signal.openedAtMs < fourBrainFocusSinceMs
              || !entrySignalFresh(signal.openedAtMs)
            ) continue;
            out.push({
              ...signal,
              laneId: signal.direction === "LONG" ? CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID : CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
              sourceKind: "VARIANT_MATRIX_SHADOW",
            });
          }
        } catch { /* unavailable matrix store => no CG signal */ }
        return out;
      }
      try { add(SF_PAPER_LANE_ID, "SHORT", shortFadeOpenSignals(getShortFadeStore())); } catch { /* lane store unavailable ⇒ skip (no fabrication) */ }
      try { add(IM_PAPER_LANE_ID, "LONG", intradayMomentumOpenSignals(getIntradayMomentumStore())); } catch { /* */ }
      try { add(RC_PAPER_LANE_ID, "LONG", regimeCompositeOpenSignals(getRegimeCompositeStore())); } catch { /* */ }
      try { add(RCS_PAPER_LANE_ID, "SHORT", regimeCompositeShortOpenSignals(getRegimeCompositeShortStore())); } catch { /* */ }
      try { add(PWR_PAPER_LANE_ID, "LONG", panicWashoutOpenSignals(getPanicWashoutStore())); } catch { /* */ }
      for (const bucket of CE_ALL_BUCKETS) {
        try { add(ceLaneIdForBucket(bucket), bucket.includes("SHORT") ? "SHORT" : "LONG", compositeEstimatorOpenSignals(getCompositeEstimatorStore(), bucket)); } catch { /* */ }
      }
      // 2026-07-28: the six lanes above are the ONLY ones the four-brain used to see, and not one of
      // them appears in a single closed position path — all 309 come from the CG variant matrix. That
      // made Entry Brain Tier 1 a permanently empty join (0 of 1,664, every rejection
      // NO_EXACT_LANE_SYMBOL_SIDE_CLOSE) and is the concrete reason the brains never connected to
      // anything that trades.
      //
      // 2026-08-02 (four-brain-sourcing, point 3): CG signals now come from TWO distinct,
      // separately-tagged sources rather than one — see FourBrainBindingDeps.openSignals' doc
      // comment (four-brain-live-gather-bindings.ts) for the full sourceKind contract.
      //
      //   1. PAPER_ORDER_OWNED — real, currently-actionable PaperOrder rows (paperStatus CREATED
      //      or PAPER_SUBMITTED), for both sourceTypes that can carry a CG candidate
      //      (VARIANT_MATRIX_OBSERVATION and SCAN_CANDIDATE_LANE_ALLOCATOR). laneId/observationId
      //      are read verbatim off order.selectedLaneId/order.sourceObservationId — THE canonical
      //      persisted ownership triple (paper-order-ownership-index.ts) — so these candidates are
      //      trivially attachable to a real Executive Review BY CONSTRUCTION: the
      //      allocationContextForLane ownership-index lookup below, and later
      //      attachExecutiveReviewToExactPaperOrder, both key on this exact triple. A
      //      VARIANT_MATRIX_OBSERVATION order structurally can never carry a CORTEX link (no
      //      scanBatchId, forward-causal-collection.ts's validCortexSnapshot hard-requires one) —
      //      it is deliberately NOT excluded here; it truthfully resolves to
      //      CORTEX_ALLOCATION_LINK_MISSING downstream instead of silently vanishing.
      //   2. VARIANT_MATRIX_SHADOW — the original CG variant-matrix shadow tape
      //      (CurrentGuardVariantMatrixObservation via variantMatrixOpenSignals), kept EXACTLY as
      //      before (not removed) for report-only Entry Brain diagnostic coverage. Its ids are
      //      vmStore's own synthetic ids in a disjoint id space from any real PaperOrder, so it is
      //      structurally NEVER attachable to a real Executive Review — no extra gating is needed
      //      to enforce that; the ownership-key equality simply never matches. The bare variantId
      //      (no CG_VARIANT_MATRIX:/CG_LONG_VARIANT_MATRIX: prefix) is what visibly distinguishes
      //      it from a PAPER_ORDER_OWNED row's prefixed selectedLaneId, on top of the explicit
      //      sourceKind tag.
      //
      // The two sources can both report the SAME underlying vmStore observation once it has been
      // admitted into a PaperOrder (a VARIANT_MATRIX_OBSERVATION order's sourceObservationId IS
      // the vmStore observationId it was built from) — that is deliberate, not a duplicate bug:
      // the rows carry different laneId strings (prefixed vs bare), so identityKey() in
      // four-brain-live-gather.ts never collides them; the shadow-tape row simply stays a
      // non-attachable, report-only echo of the same signal alongside the real, attachable one.
      try {
        const paperStore = peekPaperExecutionRouterStore();
        if (paperStore) {
          for (const order of paperStore.all) {
            if (order.paperStatus !== "CREATED" && order.paperStatus !== "PAPER_SUBMITTED") continue;
            if (order.sourceType !== "VARIANT_MATRIX_OBSERVATION" && order.sourceType !== "SCAN_CANDIDATE_LANE_ALLOCATOR") continue;
            const openedAtMs = Date.parse(order.firstSeenAt ?? order.createdAt);
            if (!Number.isFinite(openedAtMs)) continue; // never fabricate a signal age from an unparseable timestamp
            if (!Number.isFinite(order.entryPrice) || !Number.isFinite(order.stopLoss)) continue; // never fabricate geometry
            // Point 11: report-only visibility split by admission path — never read by any selection,
            // admission, allocation, or execution branch. Path A (VARIANT_MATRIX_OBSERVATION) is
            // structurally non-attachable (no scanBatchId), so it is flagged generically rather than
            // conflated with a real rejection; Path B (SCAN_CANDIDATE_LANE_ALLOCATOR) can carry a real
            // CORTEX link, so it is flagged as chain-eligible.
            recordCortexProductionChainDiagnostic(
              order.sourceType === "SCAN_CANDIDATE_LANE_ALLOCATOR"
                ? "CORTEX_CHAIN_ELIGIBLE_CANDIDATE"
                : "GENERIC_FOUR_BRAIN_DIAGNOSTIC_CANDIDATE",
            );
            out.push({
              laneId: order.selectedLaneId,
              symbol: order.symbol,
              direction: order.direction,
              observationId: order.sourceObservationId,
              openedAtMs,
              entryPrice: order.entryPrice,
              stopPrice: order.stopLoss,
              sourceKind: "PAPER_ORDER_OWNED",
            });
          }
        }
      } catch { /* store unavailable ⇒ skip (no fabrication) */ }
      try {
        for (const s of variantMatrixOpenSignals(getCurrentGuardVariantMatrixStore())) {
          out.push({ ...s, sourceKind: "VARIANT_MATRIX_SHADOW" });
        }
      } catch { /* store unavailable ⇒ skip (no fabrication) */ }
      return out;
    };

    const activeFourBrainAllocation = (): { laneId: string; weightPct: number }[] => {
      if (fourBrainTestnetFocus) {
        // Reporting scope only. These rows are the whole Four-Brain cohort on
        // testnet; they never write back into LiveExecutionEngine allocation.
        return [...focusedFourBrainLaneIds].map((laneId) => ({ laneId, weightPct: 100 }));
      }
      const allocs = liveEngine?.getStatus().laneSelection?.laneAllocations;
      if (allocs && allocs.length > 0) return allocs.map((a) => ({ laneId: a.laneId, weightPct: a.weightPct }));
      // allocations OFF or no engine ⇒ treat every roster lane as active at 100 (degenerate all-lanes case)
      return CORTEX_LANE_ROSTER.map((e) => ({ laneId: e.laneId, weightPct: 100 }));
    };

    const buildFourBrainDeps = (nowMs: number): Omit<FourBrainBindingDeps, "entryMicrostructure" | "exitSignals"> => {
      const engine = liveEngine; // null on 3101 ⇒ engine-dependent fields degrade
      const status = engine ? engine.getStatus() : null;
      const snaps = getRegimeEngineStore().snapshots;
      const latestSnap = snaps.length ? snaps[snaps.length - 1]! : null;
      const axis = buildRegimeAxisTimeline(snaps);
      const scanCached = getLatestScanCandidates();
      const regime = scanCached?.marketRegime ?? latestSnap?.regime ?? null;
      // Testnet Four-Brain observes the three executable cohorts. It may
      // analyse technical features, but the executor's canonical regime owns
      // the visible/actionable market state.
      const canonicalForFourBrain = fourBrainTestnetFocus ? getLatestCanonicalMarketRegimeEngineSnapshot() : null;
      const edgeMem = getRegimeEdgeMemory();
      // 2026-07-26 PROVENANCE FIX — every Direction reading below used to be stamped `axisAtMs`, the
      // regime AXIS's clock, no matter which producer the value actually came from. These two carry
      // the producers' own clocks instead (see FourBrainBindingDeps.edgeMemoryUpdatedAtMs).
      const parseAtMs = (iso: string | null | undefined): number | null => {
        if (typeof iso !== "string") return null;
        const ms = Date.parse(iso);
        return Number.isFinite(ms) ? ms : null;
      };
      // Edge-memory's own last write. seededAt is deliberately NOT a fallback: a seeded-but-never-
      // updated store has no live observation to be fresh about.
      const edgeMemoryUpdatedAtMs = parseAtMs(edgeMem.snapshot().liveUpdatedAt);
      // The controller report is computed synchronously, so its real age is the age of the regime
      // input it derives from — and the timestamp must follow the SAME fallback chain `regime` above
      // took, or it would describe a different source than the value. scanFinishedAt is the scan's
      // own generatedAt (see latest-scan-candidates-cache.ts's anti-lookahead invariant).
      const controllerCapturedAtMs = scanCached?.marketRegime
        ? parseAtMs(scanCached.scanFinishedAt)
        : parseAtMs(latestSnap?.at);
      const controller = buildRegimeDirectionControllerReport({
        currentRegime: regime,
        adaptiveDirectionBias: null,
        primaryValidationLane: null,
        edgeGate: edgeMem,
        axisScore: axis.current?.score ?? null,
        axisSlopePerHour: axis.slopePerHour ?? null,
      });
      const intents = liveExecutionStore ? liveExecutionStore.getState().intents : [];
      const openStates = new Set(["MIRRORED", "ENTRY_PLACED", "OPEN", "TP1_FILLED_BE_SET"]);
      const intentOpenPositions: FourBrainBindingDeps["openPositions"] = intents
        .filter((i) => openStates.has(i.state))
        .map((i) => ({
          paperOrderId: i.paperOrderId,
          laneId: i.sourcePaperOrders?.[0]?.laneId ?? "UNKNOWN",
          symbol: i.symbol,
          direction: i.direction,
          entryPrice: i.filledEntryPrice ?? i.plannedEntryPrice,
          stopPrice: i.stopLossPrice,
          mfeR: i.maxFavorableR ?? null,
          maeR: normalizeFourBrainMaeR(i.maxAdverseR),
          createdAtMs: Date.parse(i.createdAt),
        }));
      /**
       * The live-intent store owns CG, but cross baskets and directional sectional positions are
       * persisted by their own executors. Reading only intents made Four-Brain report zero open
       * positions while the testnet held a real six-leg cross basket: Entry saw candidates, Exit
       * saw nothing. Adapt those executor-owned positions here, read-only and testnet-focus scoped.
       *
       * Cross legs use the exact source observation's frozen risk distance to derive the same
       * per-leg stop proxy used by the testnet Four-Brain entry cohort. If that immutable geometry
       * is unavailable, skip rather than invent a stop/R denominator. This is shadow telemetry;
       * no Four-Brain decision is fed to an executor or exchange client.
       */
      const executorOpenPositions: FourBrainBindingDeps["openPositions"] = [];
      if (fourBrainTestnetFocus) {
        try {
          const observationsById = new Map(getCrossSectionalStore().all.map((observation) => [observation.observationId, observation]));
          for (const basket of crossSectionalExecutor?.getStatus().openBaskets ?? []) {
            const observation = observationsById.get(basket.sourceObservationId);
            const risk = observation?.riskDistanceAtOpen;
            const createdAtMs = Date.parse(basket.openedAt);
            if (!(typeof risk === "number" && Number.isFinite(risk) && risk > 0 && risk < 0.5 && Number.isFinite(createdAtMs))) continue;
            for (const leg of basket.legs) {
              if (leg.exitOrderId !== null || !(leg.entryPrice > 0)) continue;
              const stopPrice = leg.side === "LONG" ? leg.entryPrice * (1 - risk) : leg.entryPrice * (1 + risk);
              if (!(stopPrice > 0)) continue;
              executorOpenPositions.push({
                paperOrderId: `xsec:${basket.basketId}:${leg.symbol}:${leg.side}`,
                laneId: CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
                symbol: leg.symbol,
                direction: leg.side,
                entryPrice: leg.entryPrice,
                stopPrice,
                mfeR: leg.maxFavorableR ?? null,
                maeR: normalizeFourBrainMaeR(leg.maxAdverseR),
                createdAtMs,
              });
            }
          }
        } catch { /* executor/store unavailable => do not fabricate a position */ }
        for (const [laneId, executor] of [
          [CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID, crossSectionalDirectionalLongExecutor],
          [CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID, crossSectionalDirectionalShortExecutor],
        ] as const) {
          try {
            for (const position of executor?.getStatus().openPositions ?? []) {
              const createdAtMs = Date.parse(position.openedAt);
              if (!(position.entryPrice > 0 && position.stopPrice > 0 && Number.isFinite(createdAtMs))) continue;
              executorOpenPositions.push({
                paperOrderId: position.positionId,
                laneId,
                symbol: position.symbol,
                direction: position.direction,
                entryPrice: position.entryPrice,
                stopPrice: position.stopPrice,
                mfeR: position.peakFavorableR ?? null,
                maeR: normalizeFourBrainMaeR(position.peakAdverseR),
                createdAtMs,
              });
            }
          } catch { /* executor/store unavailable => do not fabricate a position */ }
        }
      }
      const openPositions = [...intentOpenPositions, ...executorOpenPositions]
        .filter((position) => !fourBrainTestnetFocus || focusedFourBrainLaneIds.has(position.laneId));
      const crowdingShadow = status?.crowdingExitShadow ?? {};
      // Built ONCE per gather/tick (same PER-CALL contract as ceBucketsOnce below) from the current
      // PaperOrder list, so every lane's allocationContextForLane call this tick shares one O(orders)
      // index instead of each candidate re-deriving its own O(orders) scan/filter.
      const paperOrderOwnershipIndex = buildPaperOrderOwnershipIndex(peekPaperExecutionRouterStore()?.all ?? []);
      lastPaperOrderOwnershipIndex = paperOrderOwnershipIndex;
      // Built ONCE per gather/tick from the SAME liveExecutionStore intents this cycle's `intents`
      // local (above) already read — point 5. Every subsequent late-binding attach lookup this cycle
      // (onExecutiveDecision, below) is then O(1) through this index rather than a fresh linear scan.
      const liveIntentIndexByPaperOrderId = buildLiveIntentIndexByPaperOrderId(intents);
      lastLiveIntentIndexByPaperOrderId = liveIntentIndexByPaperOrderId;
      // Memoized PER-CALL (one buildFourBrainDeps() == one gather/tick, per its own doc comment above) so
      // the 4 CE bucket lanes share ONE composite-estimator report build, not one per direction × per CE
      // lane bestLaneReportForDirection ends up scanning — mirrors buildLiveCortexGatherDeps's identical
      // ceBucketsOnce contract in cortex-live-gather-bindings.ts (same underlying store, independent memo).
      let ceBucketsCache: ReturnType<typeof buildCompositeEstimatorReport>["buckets"] | undefined;
      const ceBucketsOnce = (): ReturnType<typeof buildCompositeEstimatorReport>["buckets"] => {
        if (ceBucketsCache === undefined) {
          try {
            ceBucketsCache = buildCompositeEstimatorReport(getCompositeEstimatorStore().all).buckets;
          } catch {
            ceBucketsCache = [];
          }
        }
        return ceBucketsCache;
      };
      return {
        instanceId: resolveFourBrainInstanceId(process.env),
        nowMs,
        fourBrainOutcomeDataDir,
        axisScore: axis.current?.score ?? null,
        axisAtMs: axis.current?.at ? Date.parse(axis.current.at) : null,
        axisSlopePerHour: axis.slopePerHour ?? null,
        // Real 0..100 BTC ATR-percentile, refreshed on its own ~15min interval below (see
        // runBtcAtrPercentileRefresh) and read synchronously here — never fabricated: null until
        // the first refresh completes or after a persistent fetch failure (fail-open).
        btcAtrPercentile: btcAtrPercentileCache.get().percentile,
        atrAtMs: btcAtrPercentileCache.get().atMs,
        advancersPct: latestSnap?.breadth.advancersPct ?? null,
        breadthAtMs: latestSnap?.at ? Date.parse(latestSnap.at) : null,
        // BTC USD-M depth is an explicitly labelled global execution-cost proxy, not a fabricated
        // all-symbol depth number. `score=null` stays MISSING; an observed too-thin book is a real 0.
        marketLiquidityScore: fourBrainBtcLiquidityCache?.score ?? null,
        marketLiquidityAtMs: fourBrainBtcLiquidityCache?.score !== null
          ? fourBrainBtcLiquidityCache?.atMs ?? null
          : null,
        // Quantitative conflict-news volume. GDELT DOC is primary and Google News RSS is a labelled
        // fallback only when GDELT is unavailable/rate-limited. This remains Market State context:
        // it never calls a live executor or changes sizing, stops, or admission policy.
        eventRiskScore: fourBrainEventRiskCache?.score ?? null,
        eventRiskAtMs: fourBrainEventRiskCache?.score !== null
          ? fourBrainEventRiskCache?.atMs ?? null
          : null,
        eventRiskSourceId: fourBrainEventRiskCache?.sourceId ?? "gdelt-conflict-news-volume-risk",
        eventRiskMissingReason: "GDELT DOC / Google News RSS conflict-news snapshots unavailable",
        // BTC USD-M global long/short ratio mapped monotonically from (0,+inf) to (-1,+1).
        // This is a measured derivatives proxy, not fabricated market-wide certainty.
        sentiment: fourBrainBtcFlowCache?.sentiment ?? null,
        sentimentAtMs: fourBrainBtcFlowCache?.sentiment !== null
          ? fourBrainBtcFlowCache?.atMs ?? null
          : null,
        safetyEvents: [],
        marketStateAuthority: canonicalForFourBrain ? {
          source: "TESTNET_EXECUTOR",
          canonicalRegimeFamily: canonicalForFourBrain.regimeFamily,
          scannerRegime: scanCached?.marketRegime ?? null,
          capturedAtMs: canonicalForFourBrain.atMs,
        } : null,
        regimeRaw: regime,
        edgeMemory: edgeMem,
        edgeMemoryUpdatedAtMs,
        controllerCapturedAtMs,
        controllerBias: controller.directionalBias,
        convictionScore: Number.isFinite(controller.convictionScore) ? controller.convictionScore : null,
        allowsLong: controller.allowsLong,
        allowsShort: controller.allowsShort,
        // Real per-direction lane-edge accessor (item 2 of the 3 permanent-null four-brain data gaps —
        // see btc-atr-percentile-cache.ts for item 1). Picks the highest-netAvgR roster lane with
        // resolvedCount>0 for the requested direction, reusing the SAME RC/RCS/SF/IM/PWR/CE store+report
        // builders CORTEX's own gather already reads (see four-brain-best-lane-report.ts's doc comment
        // for the exact selection rule + why n=0 lanes are never selectable).
        bestLaneReportForDirection: buildLiveBestLaneReportForDirection("data", ceBucketsOnce, nowMs),
        // BTC taker buy/sell ratio uses the same signed transform; >0 means aggressive flow leans long.
        crowdAlignLong: fourBrainBtcFlowCache?.crowdAlignLong ?? null,
        crowdAtMs: fourBrainBtcFlowCache?.crowdAlignLong !== null
          ? fourBrainBtcFlowCache?.atMs ?? null
          : null,
        // 2026-07-28: was a hardcoded null with the note "no sync kronos-agree producer", which left
        // the Direction Brain calling market direction on ~2 of its 5 sub-signals. Kronos was never
        // unreachable — it runs on this host (pm2 `kronos`, 127.0.0.1:8001) and the scanner already
        // calls it every cycle. Read from THAT result rather than issuing a second predict(): kronos.ts
        // serialises inference through one global concurrency slot, so an independent per-tick consumer
        // would contend with the scanner for it. See kronos-agree-reading.ts for the −1..1 mapping and
        // for why an absent/zero-confidence opinion returns null rather than 0.
        // 2026-07-28 (second pass): the scan reading alone was MISSING on 100% of decisions, because
        // `top10` is an OPPORTUNITY ranking and BTC — the calmest large-cap there is — almost never
        // earns a slot in one. An anchor must not have to qualify as an opportunity first. So the
        // scan stays the PREFERRED source (free, in memory, freshest) and the dedicated BTC producer
        // below is the fallback for the usual case where BTC did not make the list.
        ...(() => {
          const fromScan = kronosAgreeFromScan(scanCached?.candidates, "BTCUSDT", parseAtMs(scanCached?.scanFinishedAt));
          if (fromScan.agree !== null) return { kronosAgree: fromScan.agree, kronosAtMs: fromScan.atMs };
          const anchor = kronosBtcAnchorCache.get();
          return { kronosAgree: anchor.agree, kronosAtMs: anchor.atMs };
        })(),
        // Advisory only. A missing/failed/challenger-neutral result is passed as
        // null, never as a fabricated zero vote.
        chronos2Agree: chronos2BtcAnchorCache.get().agree,
        chronos2AtMs: chronos2BtcAnchorCache.get().atMs,
        timesfmAgree: timesfmBtcAnchorCache.get().agree,
        timesfmAtMs: timesfmBtcAnchorCache.get().atMs,
        // STAGED SCALP (2026-07-28). SCALP was unreachable — laneHorizon() could only return INTRADAY
        // or SWING, so no candidate ever carried it and the SCALP direction decision could never
        // attach to anything. Reassigning the FAST lanes outright would have fixed that by gutting
        // INTRADAY, whose population those lanes ARE. So the promotion waits until INTRADAY has enough
        // independent samples to be judged at all; from that point the fast lanes move to the shorter
        // horizon on their own. Read fresh each tick — no restart or operator step is needed to flip
        // it, and it can flip back if retention ever drops INTRADAY below the bar again.
        scalpHorizonEnabled:
          (directionEntryOutcomeStore.getState().direction.perHorizon.INTRADAY?.effectiveN ?? 0) >=
          DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE,
        // Per-horizon resolved counts, so a horizon that has learned NOTHING can bootstrap out of
        // all-FLAT (direction-brain.ts's coldStart). Enabling SCALP hours ago proved the need: 376
        // decisions, 376 FLAT, with no path out — a fresh horizon cannot make either side PROVEN_
        // anything, and an unmeasured side scores 0 against a FLAT baseline that floors at 0.6.
        // Read live each tick, so the allowance closes by itself the moment the horizon has any
        // evidence of its own.
        directionResolvedNByHorizon: (() => {
          const ph = directionEntryOutcomeStore.getState().direction.perHorizon;
          return { SCALP: ph.SCALP?.n ?? 0, INTRADAY: ph.INTRADAY?.n ?? 0, SWING: ph.SWING?.n ?? 0 };
        })(),
        openSignals: collectFourBrainOpenSignals(nowMs),
        maxSignalAgeMs: 50 * 60_000,
        crowdingStateForSymbol: (symbol) => crowdingShadow[symbol]?.crowdingState ?? null,
        openPositions,
        // Real synchronous {price,atMs} mark accessor (item 3 of the 3 permanent-null four-brain data
        // gaps — see live-mark-price-cache.ts's module doc comment). Backed by a module-level singleton
        // cache refreshed every 25s (well under FRESHNESS_TTL_MS.position's 60s) from the SAME
        // sharedGetPositions() promise every executor already reads — see that refresh registration's
        // own doc comment (near `sharedGetPositions` above) for why it lives in that other block and the
        // non-interference contract with sharedGetPositions. Never fabricates: an unknown symbol, or one
        // whose last refresh predates this call by more than the consumer's own TTL, yields
        // {price:null, atMs:null} exactly like the old stub did — the difference is a symbol WITH a real,
        // fresh position now gets a genuine mark instead of a permanent null.
        markPriceForSymbol: (symbol) => getLiveMarkPriceCacheStore().get(symbol),
        // Four-Brain receives strictly read-only, incumbent operator allocation telemetry. No synthetic
        // CORTEX id is created: beta remains zero and no exact promoted snapshot exists to hand off.
        allocationContextForLane: (laneId, candidate) => {
          const base = staticAllocationContext(engine ? engine.rawLaneAllocationWeightPctForLane(laneId) : null);
          // The bridge itself fails immediately/distinctly on OWNERSHIP_MISSING/OWNERSHIP_AMBIGUOUS
          // (never a fallthrough guess) — see cortex-paper-allocation-bridge.ts. This callback's own
          // contract (four-brain-live-gather-bindings.ts) is fixed to return a plain AllocationContext,
          // so a non-BRIDGED result here still falls back to `base` exactly as before, preserving the
          // downstream contract while the bridge's own return has already been made explicit.
          const result = allocationContextWithExactCortexPaperBridge({
            base,
            candidate,
            laneId,
            ownershipIndex: paperOrderOwnershipIndex,
          });
          return result.status === "BRIDGED" ? result.context : base;
        },
        // A review may only use a scanner context that was atomically persisted before the decision.
        // Missing/future scanner timestamps remain explicit unavailable lineage, never a latest-cache join.
        marketContext: (() => {
          const sourceCutoffMs = parseAtMs(scanCached?.scanFinishedAt);
          const fresh = sourceCutoffMs !== null && nowMs - sourceCutoffMs <= FRESHNESS_TTL_MS.regime;
          return marketContextSnapshotStore?.capture({
            instanceId: resolveFourBrainInstanceId(process.env),
            asOfMs: nowMs,
            sourceCutoffMs: fresh ? sourceCutoffMs : Number.NaN,
            decisionPipelinePolicyVersion: DECISION_PIPELINE_POLICY_VERSION,
          }) ?? unavailableMarketContext(nowMs);
        })(),
        laneEligibleIncumbent: (laneId) => (engine ? engine.rawLaneAllocationWeightPctForLane(laneId) > 0 : true),
        killLatched: status?.killedAt != null,
        killReason: status?.killReason ?? null,
      };
    };

    // ── Stage-2 lane-context SNAPSHOT tap (report-only, default-OFF, fail-open) ──
    // Captures the Direction-Brain decision context (regime, per-lane edge-memory, controller conviction/mode, axis,
    // eligibility, static+cortex weights, per-lane veto) for EVERY active incumbent lane exactly once, at the
    // four-brain decision cadence. Values are frozen as-captured (the journal deep-copies), so a later edge-memory
    // mutation cannot alter a recorded snapshot. Fully independent of the four-brain executive: its own try/catch on
    // its own ticker ⇒ a snapshot failure cannot suppress the four-brain tick or the resolution scan, and vice versa.
    // Internally re-gated (journalLaneSnapshots) ⇒ ZERO I/O unless LANE_CONTEXT_JOURNAL_MODE=shadow on 3101/3102.
    const captureLaneContextSnapshots = (nowMs: number): void => {
      try {
        const snaps = getRegimeEngineStore().snapshots;
        const latestSnap = snaps.length ? snaps[snaps.length - 1]! : null;
        const regime = getLatestScanCandidates()?.marketRegime ?? latestSnap?.regime ?? null;
        const edgeMem = getRegimeEdgeMemory();
        const axis = buildRegimeAxisTimeline(snaps);
        const controller = buildRegimeDirectionControllerReport({
          currentRegime: regime,
          adaptiveDirectionBias: null,
          primaryValidationLane: null,
          edgeGate: edgeMem,
          axisScore: axis.current?.score ?? null,
          axisSlopePerHour: axis.slopePerHour ?? null,
        });
        const coverage = classifyIncumbentLanes(activeFourBrainAllocation());
        const inputs = buildLaneContextSnapshotInputs({
          regimeRaw: regime,
          axisScore: axis.current?.score ?? null,
          controllerMode: controller.directionalBias,
          conviction: Number.isFinite(controller.convictionScore) ? controller.convictionScore : null,
          lanes: coverage.lanes,
          laneEdgeStat: (dir, lane) => { const s = edgeMem.laneLookup(regime, dir, lane); return { n: s.n, avgNetR: s.avgNetR }; },
          laneVeto: (dir, lane) => { const v = edgeMem.laneVerdict(regime, dir, lane); return { vetoed: v.decision === "VETO_NEGATIVE", reason: v.reasonCode }; },
          cortexFinalPctForLane: (lane) => (liveEngine ? liveEngine.laneSelectionWeightPctForLane(lane) : null),
          laneEligibleIncumbent: (lane) => (liveEngine ? liveEngine.laneSelectionWeightPctForLane(lane) > 0 : true),
        });
        journalLaneSnapshots(nowMs, inputs);
      } catch { /* report-only: a snapshot failure must never disturb any live cycle */ }
    };
    // Armed by the lane-context journal's OWN activation (independent of four-brain mode) so the resolution chain
    // (snapshot → outcome) stays coherent under a single LANE_CONTEXT_JOURNAL_MODE flag. Registered once at boot
    // (the null-guard blocks a duplicate interval on any bootstrap retry); cleared on shutdown so nothing blocks
    // termination. `journalLaneSnapshots` re-checks activation ⇒ even if armed, it is a no-op when mode is off.
    if (laneJournalActive(process.env) && laneContextSnapshotTimer === null) {
      setTimeout(() => captureLaneContextSnapshots(Date.now()), 60_000);
      laneContextSnapshotTimer = setInterval(() => captureLaneContextSnapshots(Date.now()), 5 * 60_000);
      const clearLaneContextSnapshotTimer = (): void => {
        try { if (laneContextSnapshotTimer) { clearInterval(laneContextSnapshotTimer); laneContextSnapshotTimer = null; } }
        catch { /* clearing is best-effort; a failure must never block process termination */ }
      };
      process.once("SIGTERM", clearLaneContextSnapshotTimer);
      process.once("SIGINT", clearLaneContextSnapshotTimer);
    }

    // Retained handle: the EXACT gather-deps snapshot buildFourBrainDeps produced for the in-flight cycle,
    // captured here so journalContext (below) reports the SAME per-tick feature snapshot the brains just
    // decided from — never a separately re-derived (and potentially drifted) recomputation.
    let lastFourBrainGatherBase: Omit<FourBrainBindingDeps, "entryMicrostructure" | "exitSignals"> | null = null;
    const buildFourBrainDepsForCycle = (nowMs: number): Omit<FourBrainBindingDeps, "entryMicrostructure" | "exitSignals"> => {
      const built = buildFourBrainDeps(nowMs);
      lastFourBrainGatherBase = built;
      return built;
    };

    /**
     * The pre-submit observer is intentionally synchronous and cache-only: an executor must never
     * wait on public market data just to produce shadow telemetry. The periodic shadow cycle is the
     * sole network warmer. Values are timestamped so a stale cache becomes MISSING rather than being
     * silently reused as current entry evidence.
     */
    type FourBrainMarketCacheRow<T> = { value: T; fetchedAtMs: number };
    const fourBrainCandleCache = new Map<string, FourBrainMarketCacheRow<Candle[] | null>>();
    const fourBrainOrderflowCache = new Map<string, FourBrainMarketCacheRow<EntryOrderflowSnapshot | null>>();
    const readFreshFourBrainCache = <T>(
      cache: Map<string, FourBrainMarketCacheRow<T>>,
      symbol: string,
      nowMs: number,
      ttlMs: number,
    ): T | null => {
      const row = cache.get(symbol.trim().toUpperCase());
      if (!row || row.fetchedAtMs > nowMs + 60_000 || nowMs - row.fetchedAtMs > ttlMs) return null;
      return row.value;
    };
    const fetchFourBrainFuturesCandles = async (symbol: string): Promise<Candle[] | null> => {
      const normalized = symbol.trim().toUpperCase();
      const value = await binanceClient.getFuturesCandles(normalized, "15m", 150).catch(() => null);
      fourBrainCandleCache.set(normalized, { value, fetchedAtMs: Date.now() });
      return value;
    };
    const fetchFourBrainOrderflow = async (symbol: string): Promise<EntryOrderflowSnapshot | null> => {
      const normalized = symbol.trim().toUpperCase();
      let value: EntryOrderflowSnapshot | null = null;
      try {
        const payload = await binanceClient.getFuturesDepth(normalized, 100);
        const depth = parseDepthPayload(payload);
        const bestBid = depth.bids[0]?.price ?? null;
        const bestAsk = depth.asks[0]?.price ?? null;
        const configured = Number(process.env.FOUR_BRAIN_REFERENCE_NOTIONAL_USD ?? "250");
        const referenceNotionalUsd = Number.isFinite(configured)
          ? Math.min(5_000, Math.max(25, configured))
          : 250;
        const buySlip = computeExpectedSlippageBps(depth, "BUY", referenceNotionalUsd);
        const sellSlip = computeExpectedSlippageBps(depth, "SELL", referenceNotionalUsd);
        const depthImbalance =
          bestBid !== null && bestAsk !== null
            ? computeDepthImbalance(depth, bestBid, bestAsk, 10).imbalance
            : null;
        value = {
          spreadBps: bestBid !== null && bestAsk !== null ? computeSpreadBps(bestBid, bestAsk) : null,
          expectedSlippageBpsBuy: buySlip,
          expectedSlippageBpsSell: sellSlip,
          bookDepthOkBuy: buySlip !== null,
          bookDepthOkSell: sellSlip !== null,
          bookImbalance: depthImbalance,
          observedAtMs: Date.now(),
        };
      } catch {
        value = null;
      }
      fourBrainOrderflowCache.set(normalized, { value, fetchedAtMs: Date.now() });
      return value;
    };
    const appendFourBrainJournal = wrapFourBrainJournalAppendForOutcomeLedger(
      wrapFourBrainJournalAppendForRecentDecisions(
        (record) => fourBrainJournal.append(record),
        fourBrainRecentDecisions,
      ),
      fourBrainOutcomeLedger,
    );

    if (fourBrainTestnetFocus) {
      fourBrainPreEntryObserverRef = (candidate) => {
        try {
          const bindings = fourBrainActualFillBindingsRef;
          const nowMs = candidate.nowMs;
          const entryPrice = candidate.entryPrice;
          const stopPrice = candidate.stopPrice;
          const openedAtMs = candidate.openedAtMs;
          const signalId = candidate.signalId?.trim() ?? "";
          if (
            !bindings
            || !Number.isFinite(nowMs)
            || !(typeof entryPrice === "number" && entryPrice > 0)
            || !(typeof stopPrice === "number" && stopPrice > 0)
            || !(typeof openedAtMs === "number" && Number.isFinite(openedAtMs))
            || !signalId
          ) return;
          const laneId = normalizeFourBrainTestnetLane(candidate.laneId, candidate.side);
          if (!focusedFourBrainLaneIds.has(laneId)) return;
          const preEntryDeps: Omit<FourBrainBindingDeps, "entryMicrostructure" | "exitSignals"> = {
            ...buildFourBrainDeps(nowMs),
            nowMs,
            openSignals: [{
              laneId,
              symbol: candidate.symbol,
              direction: candidate.side,
              observationId: signalId,
              openedAtMs,
              entryPrice,
              stopPrice,
            }],
            openPositions: [],
          };
          const entryMicrostructure = makeEntryMicrostructureAccessor({
            candlesFor: (symbol) => readFreshFourBrainCache(fourBrainCandleCache, symbol, nowMs, FRESHNESS_TTL_MS.candle),
            orderflowFor: (symbol) => readFreshFourBrainCache(fourBrainOrderflowCache, symbol, nowMs, FRESHNESS_TTL_MS.orderflow),
            timeframe: "15m",
            nowMs,
          });
          const gathered = assembleFourBrainTick(buildFourBrainGatherInput({
            ...preEntryDeps,
            entryMicrostructure,
            exitSignals: () => null,
          }));
          const evaluation = evaluateFourBrainPreEntryCandidate(gathered);
          if (!evaluation) return;
          bindings.observeExecutiveDecision(evaluation.executive, { signalId }, { source: "PRE_ENTRY_EXECUTOR" });
          appendFourBrainJournal({
            ...buildExecutiveDecisionRecord(evaluation.executive, {
              ...buildFourBrainJournalContext(preEntryDeps, activeFourBrainAllocation()),
              invariantViolations: evaluation.invariantViolations,
              signalId,
            }),
            captureStage: "PRE_ENTRY_EXECUTOR",
          });
        } catch {
          // All telemetry failure paths are intentionally ignored by the incumbent executor.
        }
      };
    }

    const fourBrainCycle = (): void => {
      void runFourBrainShadowCycle({
        buildDeps: buildFourBrainDepsForCycle,
        fetchCandles: fetchFourBrainFuturesCandles,
        fetchOrderflow: fetchFourBrainOrderflow,
        prewarmSymbols: () => fourBrainTestnetFocus
          ? [
              ...(getLatestScanCandidates()?.candidates ?? []).map((candidate) => candidate.symbol),
              "XRPUSDT",
              "WLDUSDT",
            ]
          : [],
        candleTimeframe: "15m",
        activeAllocation: activeFourBrainAllocation,
        // Wrapped so the SAME journalAppend call that writes the real file also mirrors records into two
        // independent, best-effort side-observers — the bounded recent-decisions ring buffer (dashboard)
        // and the bounded Direction/Entry outcome ledger (counterfactual-resolution foundation) — while
        // the real file append (fourBrainJournal.append, innermost) stays the single unconditional/
        // unaltered call; see four-brain-recent-decisions.ts / four-brain-outcome-ledger.ts's own doc
        // comments.
        journalAppend: appendFourBrainJournal,
        // Bug fix: previously unsupplied ⇒ every journaled EXECUTIVE_DECISION had instanceId/rawFeatures/
        // normalizedFeatures/sourceStatuses/missingReasons/incumbent hard-null. Built from this cycle's own
        // captured gather deps (never fabricated) + the live incumbent lane allocation.
        journalContext: () =>
          lastFourBrainGatherBase
            ? buildFourBrainJournalContext(lastFourBrainGatherBase, activeFourBrainAllocation())
            : { instanceId: resolveFourBrainInstanceId(process.env) },
        onExecutiveDecision: (executive, identity) => {
          // Scheduled rows remain shadow/review audit only. Exact actual-fill attribution is
          // captured exclusively by the synchronous pre-submit observer above, so a later periodic
          // scan cannot be misrepresented as the decision that caused an exchange fill.
          if (!executiveReviewStore) return;
          try {
            const paperStore = peekPaperExecutionRouterStore();
            if (!paperStore) return;
            const result = attachExecutiveReviewToExactPaperOrder({
              reviewStore: executiveReviewStore,
              paperStore,
              executive,
              candidateId: identity.signalId,
              // The SAME this-cycle intent index buildFourBrainDeps already built (point 5) — never a
              // fresh linear scan/map over liveExecutionStore.getState().intents per candidate.
              // Includes conflictedPaperOrderIds (live-intent-index.ts's documented collision
              // policy) alongside the resolvable keys: a paperOrderId the index could not resolve
              // to exactly one owning intent still unambiguously belongs to at least one live
              // intent, so it must still be treated as executing — attachExecutiveReviewToExactPaperOrder
              // then fails closed on it via its pre-existing INTENT_INDEX_MISS path (the index has
              // no resolvable entry for it), never guessing which intent owns it.
              executingPaperOrderIds: new Set([
                ...(lastLiveIntentIndexByPaperOrderId?.keys() ?? []),
                ...(lastLiveIntentIndexByPaperOrderId?.conflictedPaperOrderIds ?? []),
              ]),
              // The SAME this-cycle ownership index buildFourBrainDeps already built (GAP A) — never a
              // fresh linear scan. Empty-map fallback only if no cycle has run yet this process, which
              // fails closed exactly like a real 0-match lookup (NO_EXACT_CANDIDATE), never fabricating
              // a match.
              paperOrderOwnershipIndex: lastPaperOrderOwnershipIndex ?? new Map(),
              // Point 2/5: enables late-binding attach when the order already turned into a live
              // execution intent before this review ran. Omitting either param (no cycle has produced
              // an index yet, or no liveExecutionStore configured) falls back to today's exact
              // ORDER_ALREADY_EXECUTING behavior — see attachExecutiveReviewToExactPaperOrder's own
              // doc comment.
              liveIntentIndexByPaperOrderId: lastLiveIntentIndexByPaperOrderId ?? new Map(),
              saveLiveIntents: () => liveExecutionStore?.save(),
              // The SAME this-cycle gather deps that already feed journalContext above — never a
              // later/current rehydration — so this snapshot is exactly what this tick's brains
              // consumed. Deep-cloned by attachExecutiveReviewToExactPaperOrder before persisting.
              brainFeatureSnapshot: lastFourBrainGatherBase
                ? buildFourBrainJournalContext(lastFourBrainGatherBase, activeFourBrainAllocation())
                : null,
            });
            // Result is no longer discarded — report-only visibility into every distinct late-binding
            // rejection (point 2), never read anywhere that influences selection/admission/allocation/
            // execution. Every other ExecutiveReviewAdmissionResult already records its own diagnostic
            // internally (CORTEX_CANDIDATE_OWNERSHIP_MISSING/AMBIGUOUS, CORTEX_EXECUTIVE_ATTACHMENT_
            // REJECTED) or is an ordinary, expected non-event (NO_EXACT_CANDIDATE, MARKET_CONTEXT_
            // UNAVAILABLE, ORDER_ALREADY_LINKED, ORDER_ALREADY_EXECUTING, POST_FIX_POLICY_MISSING,
            // STALE_CAUSAL_IDENTITY, REVIEW_CONFLICT).
            switch (result) {
              case "INTENT_TERMINAL":
                recordCortexProductionChainDiagnostic("CORTEX_LATE_BINDING_INTENT_TERMINAL");
                break;
              case "INTENT_LINEAGE_MISSING":
                recordCortexProductionChainDiagnostic("CORTEX_LATE_BINDING_LINEAGE_MISSING");
                break;
              case "INTENT_LINEAGE_CONFLICT":
                recordCortexProductionChainDiagnostic("CORTEX_LATE_BINDING_LINEAGE_CONFLICT");
                break;
              case "INTENT_REVIEW_CONFLICT":
                recordCortexProductionChainDiagnostic("CORTEX_LATE_BINDING_REVIEW_CONFLICT");
                break;
              case "INTENT_INDEX_MISS":
                recordCortexProductionChainDiagnostic("CORTEX_LATE_BINDING_INDEX_MISS");
                break;
              default:
                break;
            }
          } catch {
            // Executive review creation cannot affect incumbent paper/exchange execution.
          }
        },
        metrics: fourBrainMetrics,
        now: () => Date.now(),
        perfNow: () => performance.now(), // monotonic clock for gather/inference/journal LATENCY only
      })
        .then((res) => {
          if (executiveReviewStore) {
            try {
              const paperStore = peekPaperExecutionRouterStore();
              if (paperStore) {
                markTerminalExecutiveReviewsTier2Only(
                  executiveReviewStore,
                  paperStore.all,
                  new Set((liveExecutionStore?.getState().intents ?? []).map((intent) => intent.paperOrderId)),
                );
              }
            } catch {
              // Tier classification remains fail-open relative to the incumbent cycle.
            }
          }
          if (!res.ran) return;
          const s = fourBrainMetrics.summary();
          console.log(
            `[four-brain-shadow] instance=${resolveFourBrainInstanceId(process.env)} reason=${res.tick?.reason} ` +
              `lanes=${res.tick?.metrics.laneCoverage ?? 0} positions=${res.tick?.metrics.positionCoverage ?? 0} ` +
              `decisions=${res.tick?.metrics.decisions ?? 0} coverage=${res.coverage?.capitalCoveragePct.toFixed(0) ?? "?"}% ` +
              `completed=${s.ticks.completed} skipped=${s.ticks.skippedSingleFlight} gatherErr=${s.ticks.gatherErrors} brainErr=${s.ticks.brainErrors}`,
          );
        })
        .catch((err) => console.error("[four-brain-shadow] cycle failed", err));
    };
    // Arm the interval ONLY where the tick could actually run — 3103 (live) never even schedules it.
    if (fourBrainShadowActive(process.env)) {
      // Run once as soon as bootstrap completes. The bounded prewarm in
      // four-brain-live-wiring keeps this report-only startup read from
      // blocking the service, while avoiding an empty dashboard after restart.
      console.log(`[four-brain-shadow] scheduling immediate startup cycle instance=${resolveFourBrainInstanceId(process.env)}`);
      setTimeout(() => {
        console.log(`[four-brain-shadow] starting immediate startup cycle instance=${resolveFourBrainInstanceId(process.env)}`);
        fourBrainCycle();
      }, 0);
      setInterval(fourBrainCycle, 5 * 60_000);

      // BTC ATR-percentile refresh — ATR-percentile is slow-moving (7d rolling window), so a 15min cadence is
      // ample (mirrors SYMBOL_VOLATILITY_REFRESH_INTERVAL_MS's 20min choice for the same reason). Near-immediate
      // warm-up fire so the value isn't null for the first full interval if avoidable; both calls are
      // fire-and-forget (refreshBtcAtrPercentileCache never throws — fail-open, see its own doc comment).
      // BTC anchor for kronosAgree — same 15-min cadence and same gating as the ATR producer beside
      // it, so 3103 (live) never schedules this extra inference either. Deliberately NOT per-tick:
      // kronos.ts serialises inference through one global concurrency slot and a five-minute consumer
      // would contend with the scanner for it.
      const runKronosBtcAnchorRefresh = (): void => {
        void refreshKronosBtcAnchor(
          kronosBtcAnchorCache,
          (symbol, interval, limit) => binanceClient.getCandles(symbol, interval, limit),
          (symbol, timeframe, candles) => kronosClient.predict(symbol, timeframe, candles),
          Date.now(),
        );
      };
      const runBtcAtrPercentileRefresh = (): void => {
        void refreshBtcAtrPercentileCache(btcAtrPercentileCache, (symbol, interval, limit) =>
          binanceClient.getCandles(symbol, interval, limit),
        );
      };
      setTimeout(runBtcAtrPercentileRefresh, 10_000);
      setInterval(runBtcAtrPercentileRefresh, 15 * 60_000);
      // Global liquidity proxy: one BTC USD-M depth snapshot per minute. It uses the same 25..5000
      // USD reference-notional clamp as Entry Brain's per-symbol depth read, but remains advisory
      // Market State telemetry and never feeds an executor directly.
      const refreshFourBrainBtcLiquidity = (): void => {
        void binanceClient.getFuturesDepth("BTCUSDT", 100)
          .then((payload) => {
            const depth = parseDepthPayload(payload);
            const bestBid = depth.bids[0]?.price ?? null;
            const bestAsk = depth.asks[0]?.price ?? null;
            const configured = Number(process.env.FOUR_BRAIN_REFERENCE_NOTIONAL_USD ?? "250");
            const referenceNotionalUsd = Number.isFinite(configured)
              ? Math.min(5_000, Math.max(25, configured))
              : 250;
            const spreadBps = bestBid !== null && bestAsk !== null
              ? computeSpreadBps(bestBid, bestAsk)
              : null;
            const expectedSlippageBpsBuy = computeExpectedSlippageBps(depth, "BUY", referenceNotionalUsd);
            const expectedSlippageBpsSell = computeExpectedSlippageBps(depth, "SELL", referenceNotionalUsd);
            fourBrainBtcLiquidityCache = {
              score: marketLiquidityScoreFromExecutionCost({ spreadBps, expectedSlippageBpsBuy, expectedSlippageBpsSell }),
              spreadBps,
              expectedSlippageBpsBuy,
              expectedSlippageBpsSell,
              atMs: Date.now(),
            };
          })
          .catch(() => {
            // Keep the last actual observation; freshness logic owns the eventual STALE state.
          });
      };
      setTimeout(refreshFourBrainBtcLiquidity, 15_000);
      setInterval(refreshFourBrainBtcLiquidity, 60_000);
      // Offset from the ATR refresh so the two BTC producers never fire in the same tick.
      setTimeout(runKronosBtcAnchorRefresh, 20_000);
      setInterval(runKronosBtcAnchorRefresh, 15 * 60_000);

      // GDELT DOC is primary; Google News RSS is the labelled fallback when the public GDELT API
      // rate-limits this server. Both are transparent article-volume proxies (not LLM classifiers),
      // isolated to this testnet-only shadow source. An error leaves the cache untouched rather than
      // publishing a made-up zero.
      const refreshFourBrainEventRisk = (): void => {
        void (async () => {
          const primary = await fetchGdeltDocEventRisk();
          if (primary.ok) {
            fourBrainEventRiskCache = {
              score: primary.risk.score,
              atMs: primary.risk.observedAtMs,
              sourceId: "gdelt-conflict-news-volume-risk",
            };
            return;
          }
          const fallback = await fetchGoogleNewsRssEventRisk();
          if (!fallback.ok) return;
          fourBrainEventRiskCache = {
            score: fallback.risk.score,
            atMs: fallback.risk.observedAtMs,
            sourceId: "google-news-rss-conflict-volume-risk",
          };
        })()
          .catch(() => {
            // The cache remains at its last measured value and naturally becomes STALE.
          });
      };
      setTimeout(refreshFourBrainEventRisk, 40_000);
      setInterval(refreshFourBrainEventRisk, 15 * 60_000);

      if (challengerTestnetEnabled) {
        // The Python process uses a global inference lock. These offsets also
        // prevent model loading or a cold inference burst at application boot.
        const refreshChronos2 = (): void => {
          void refreshForecastChallengerBtcAnchor(
            chronos2BtcAnchorCache,
            (symbol, interval, limit) => binanceClient.getCandles(symbol, interval, limit),
            (symbol, timeframe, candles) => chronos2Client.predict(symbol, timeframe, candles),
          );
        };
        const refreshTimesfm = (): void => {
          void refreshForecastChallengerBtcAnchor(
            timesfmBtcAnchorCache,
            (symbol, interval, limit) => binanceClient.getCandles(symbol, interval, limit),
            (symbol, timeframe, candles) => timesfmClient.predict(symbol, timeframe, candles),
          );
        };
        const collectTlob = (): void => {
          const symbols = (process.env.TLOB_COLLECT_SYMBOLS ?? "BTCUSDT,ETHUSDT,SOLUSDT")
            .split(",")
            .map((symbol) => symbol.trim().toUpperCase())
            .filter((symbol) => /^[A-Z0-9]{5,20}$/.test(symbol));
          if (symbols.length === 0) return;
          void tlobCollector.collect(binanceClient, symbols).then((result) => {
            if (result.failed > 0) {
              console.warn(`[tlob-collector] captured=${result.captured} failed=${result.failed}`);
            }
          }).catch((error) => console.warn("[tlob-collector] collection failed", error));
        };
        setTimeout(refreshChronos2, 45_000);
        setInterval(refreshChronos2, 20 * 60_000);
        setTimeout(refreshTimesfm, 105_000);
        setInterval(refreshTimesfm, 20 * 60_000);
        if (process.env.TLOB_COLLECTOR_ENABLED === "1") {
          setTimeout(collectTlob, 135_000);
          setInterval(collectTlob, 60_000);
        }
      }

      const refreshFourBrainBtcFlow = (): void => {
        void binanceClient.getFuturesFlow("BTCUSDT")
          .then((flow) => {
            fourBrainBtcFlowCache = {
              sentiment: ratioToSigned(flow.longShortRatio),
              crowdAlignLong: ratioToSigned(flow.takerBuySellRatio),
              atMs: Date.now(),
            };
          })
          .catch(() => {
            // Preserve the last observation so normal freshness classification can turn it STALE.
          });
      };
      setTimeout(refreshFourBrainBtcFlow, 20_000);
      setInterval(refreshFourBrainBtcFlow, 5 * 60_000);
    }

    // ── Direction/Entry counterfactual outcome RECONCILER (2026-07-23) — its OWN interval, its OWN
    // try/catch, fully decoupled from the four-brain shadow tick's interval/exception handling above: a
    // bug in this reconciler can never affect that tick, or vice versa (see direction-entry-reconciler.ts's
    // own doc). Gated by directionEntryReconcilerActive — 3 ANDed layers (a brand-new, separate
    // FOUR_BRAIN_OUTCOME_MODE flag; fourBrainInstanceAllowed; fourBrainShadowActive) so enabling the
    // four-brain shadow tick alone can NEVER also turn this on, and 3103 (live) is hard-blocked exactly
    // like every other four-brain-only interval regardless of env.
    if (directionEntryReconcilerActive(process.env)) {
      const runDirectionEntryReconciliation = (): void => {
        void runDirectionEntryReconciliationCycleGuarded({
          ledger: fourBrainOutcomeLedger,
          store: directionEntryOutcomeStore,
          listClosedPositionPaths: () => getPositionPathRecorder().listClosedPaths(),
          fetchDirectionCandles: () => binanceClient.getFuturesCandles("BTCUSDT", "1h", 500).catch(() => null),
          fetchEntryTier2Candles: (symbol, sinceMs) =>
            binanceClient
              .getFuturesCandles(symbol, "15m", ENTRY_TIER2_HORIZON_BARS + ENTRY_TIER2_WAIT_WINDOW_BARS + 1, { startTime: sinceMs })
              .catch(() => null),
          actualFillBindings: fourBrainActualFillBindingsRef ?? undefined,
          now: () => Date.now(),
        })
          .then((res) => {
            if (!res) return; // single-flight skip — a prior cycle is still in flight
            // Persist the pending rows every cycle. This is the ONLY thing standing between a SWING
            // decision and the next restart: rows are small and bounded by the ledger's own FIFO, so
            // the write is cheap next to the candle fetches this cycle just did. Failure is swallowed
            // inside the store — durability must never cost the reconciler its cycle.
            savePendingLedgerSnapshot({
              direction: fourBrainOutcomeLedger.getPendingDirectionRows(),
              entry: fourBrainOutcomeLedger.getPendingEntryRows(),
            }, fourBrainOutcomeDataDir);
            console.log(
              `[direction-entry-reconciler] instance=${resolveFourBrainInstanceId(process.env)} ` +
                `directionProcessed=${res.directionProcessed} entryProcessed=${res.entryProcessed} ` +
                `directActualFill=${res.directActualFillProcessed} ` +
                `tier1Matched=${res.tier1Diagnostics?.matchedRows ?? 0} ` +
                `tier1NoIdentityClose=${res.tier1Diagnostics?.rejectionReasons.NO_EXACT_LANE_SYMBOL_SIDE_CLOSE ?? 0} ` +
                `tier1SignalMismatch=${res.tier1Diagnostics?.rejectionReasons.SIGNAL_ID_MISMATCH ?? 0} ` +
                `tier1SignalMatches=${res.tier1Diagnostics?.signalIdentityMatches ?? 0} ` +
                `error=${res.error ?? "none"}`,
            );
          })
          .catch((err) => console.error("[direction-entry-reconciler] cycle failed", err));
      };
      setTimeout(runDirectionEntryReconciliation, 120_000);
      setInterval(runDirectionEntryReconciliation, 15 * 60_000);
    }
  }

  await registerLiveRoutes(app, liveEngine, {
    configErrors: liveConfig.enabled ? liveConfig.configErrors : [],
    crossSectionalExecutor: () => crossSectionalExecutor,
    crossSectionalTrendExecutor: () => crossSectionalTrendExecutor,
    crossSectionalMixedExecutor: () => crossSectionalMixedExecutor,
    directionalRegimeDecision: () => crossSectionalDirectionalDecisionRef(),
    crossSectionalDirectionalLongExecutor: () => crossSectionalDirectionalLongExecutor,
    crossSectionalDirectionalShortExecutor: () => crossSectionalDirectionalShortExecutor,
    shortFadeExecutor: () => shortFadeExecutor,
    intradayMomentumExecutor: () => intradayMomentumExecutor,
    regimeCompositeExecutor: () => regimeCompositeExecutor,
    regimeCompositeShortExecutor: () => regimeCompositeShortExecutor,
    compositeEstimatorWideLongExecutor: () => compositeEstimatorWideLongExecutor,
    compositeEstimatorWideShortExecutor: () => compositeEstimatorWideShortExecutor,
    compositeEstimatorFastLongExecutor: () => compositeEstimatorFastLongExecutor,
    compositeEstimatorFastShortExecutor: () => compositeEstimatorFastShortExecutor,
    panicWashoutExecutor: () => panicWashoutExecutor,
    innovationBasketExecutors: () => innovationBasketExecutors,
    innovationSingleSymbolExecutors: () => innovationSingleSymbolExecutors,
    innovationCampaign: () => innovationCampaignSnapshot(),
    regimeAutopilot: () => regimeAutopilot,
    unifiedOrchestrator: () => unifiedOrchestrator,
    unifiedProposalStore: () => unifiedProposalStore,
    singleSymbolPriceTimeline: () => singleSymbolPriceTimeline,
  });

  return app;
}

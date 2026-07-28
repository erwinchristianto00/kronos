import Fastify, { type FastifyInstance } from "fastify";
import { BinanceClient } from "./lib/binance.js";
import { HttpKronosClient } from "./lib/kronos.js";
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
import { buildCrossSectionalReport, getCrossSectionalStore } from "./lib/cross-sectional-edge.js";
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
import { computeExternalManagedNetQty, computeNotionalPerSymbol, maxNotionalPerSymbolAcrossLanes, computeClusterOpenSymbols, maxClusterPositionsAcrossLanes, isNewExecutorLaneAllowed, newExecutorLaneGate, rollingNetEntryHealth, sumExternalRealizedPnlUsd } from "./lib/live-executor-wiring.js";
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
} from "./lib/live-execution-engine.js";
import { getLaneSymbolCurationCacheStore } from "./lib/lane-symbol-curation-cache.js";
import type { LaneSymbolCurationTier } from "./lib/per-symbol-lane-book-edge.js";
import { getPaperExecutionRouterStore } from "./lib/paper-execution-router.js";
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
  getCurrentGuardVariantMatrixStore,
  variantMatrixOpenSignals,
} from "./lib/current-guard-variant-matrix.js";
import { getLatestScanCandidates } from "./lib/latest-scan-candidates-cache.js";
import { kronosAgreeFromScan } from "./lib/kronos-agree-reading.js";
import { buildRegimeDirectionControllerReport } from "./lib/regime-direction-controller.js";
import { getRegimeDirectionControllerSnapshotStore } from "./lib/regime-direction-controller-snapshot.js";
import { getRegimeEdgeMemory } from "./lib/regime-edge-memory.js";
import { cortexBrainMode, cortexPromotionBlockedByEnv } from "./lib/cortex-brain.js";
import { CortexBrainStore, CortexDecisionJournal, runCortexShadowTick } from "./lib/cortex-brain-store.js";
import { standaloneCortexShadowAllowed } from "./lib/cortex-instance-diagnosis.js";
import { runFourBrainShadowCycle } from "./lib/four-brain-live-wiring.js";
import { classifyIncumbentLanes } from "./lib/four-brain-lane-support.js";
import { buildLaneContextSnapshotInputs } from "./lib/lane-context-snapshot-source.js";
import {
  computeExpectedSlippageBps,
  computeSpreadBps,
  parseDepthPayload,
} from "./lib/order-flow-microstructure.js";
import { journalLaneSnapshots, laneJournalActive } from "./lib/lane-context-journal-runtime.js";
import { FourBrainMetricsAggregator } from "./lib/four-brain-metrics.js";
import {
  FourBrainRecentDecisionsBuffer,
  wrapFourBrainJournalAppendForRecentDecisions,
} from "./lib/four-brain-recent-decisions.js";
import {
  FourBrainOutcomeLedger,
  rehydrateFourBrainOutcomeLedgerFromJournals,
  wrapFourBrainJournalAppendForOutcomeLedger,
  type FourBrainOutcomeHorizon,
} from "./lib/four-brain-outcome-ledger.js";
import { resolveFourBrainInstanceId, fourBrainInstanceAllowed, fourBrainShadowActive, type FourBrainBindingDeps } from "./lib/four-brain-live-gather-bindings.js";
import { fourBrainMode } from "./lib/four-brain-types.js";
import { getBtcAtrPercentileCacheStore, refreshBtcAtrPercentileCache } from "./lib/btc-atr-percentile-cache.js";
import { buildLiveBestLaneReportForDirection } from "./lib/four-brain-best-lane-report.js";
import { getLiveMarkPriceCacheStore, refreshLiveMarkPriceCache } from "./lib/live-mark-price-cache.js";
import { CORTEX_LANE_ROSTER, gatherCortexContext, normalizeCortexStaticWeightPctForLane } from "./lib/cortex-live-gather.js";
import { buildLiveCortexGatherDeps } from "./lib/cortex-live-gather-bindings.js";
import { getCortexRealAttributionStore } from "./lib/cortex-real-attribution.js";
import { getExecutionFillRecorder } from "./lib/execution-fill-recorder.js";
import { getPositionPathRecorder } from "./lib/position-path-recorder.js";
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
  rotationRegimeFamilyForLabel,
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
  notificationDataDir?: string;
  notificationService?: NotificationService;
}

const DEFAULT_KRONOS_BASE_URL = "http://localhost:8001";

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

  const sourceStatuses: Record<string, string> = {
    axisScore: base.axisScore != null ? "FRESH" : "MISSING",
    axisSlopePerHour: base.axisSlopePerHour != null ? "FRESH" : "MISSING",
    breadth: base.advancersPct != null ? "FRESH" : "MISSING",
    regimeRaw: base.regimeRaw != null ? "FRESH" : "MISSING",
    btcAtrPercentile: base.btcAtrPercentile != null ? "FRESH" : "MISSING",
    sentiment: base.sentiment != null ? "FRESH" : "MISSING",
    crowdAlignLong: base.crowdAlignLong != null ? "FRESH" : "MISSING",
    kronosAgree: base.kronosAgree != null ? "FRESH" : "MISSING",
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

  const binanceClient = new BinanceClient(options.fetchImpl);
  const kronosClient = new HttpKronosClient(
    options.kronosBaseUrl ?? process.env.KRONOS_BASE_URL ?? DEFAULT_KRONOS_BASE_URL,
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
  // Same threading pattern, for the Direction/Entry counterfactual outcome reconciler's own report.
  // Stays null (⇒ the route fails open to an empty/disabled shape) unless directionEntryReconcilerActive
  // (its own 3-layer gate — see direction-entry-reconciler.ts) is true on this instance.
  let directionEntryOutcomeReportGetterRef: (() => DirectionEntryOutcomeReport | null) | null = null;
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
    kronosClient,
    fourBrainMetricsGetter: () => fourBrainMetricsRef?.summary() ?? null,
    fourBrainRecentDecisionsGetter: () => fourBrainRecentDecisionsRef?.getAll() ?? null,
    directionEntryOutcomeReportGetter: () => directionEntryOutcomeReportGetterRef?.() ?? null,
  });
  await registerNotificationRoutes(app, notificationService);
  await registerTradingAssistantRoutes(app);

  // Live-execution mirror (Binance USD-M). Fully dormant unless LIVE_EXECUTION_ENABLED=1:
  // no private client is constructed, no loop runs, nothing else in the app changes.
  // Strategy code is untouched — the engine only READS the paper store's decisions.
  const liveConfig = parseLiveExecutionConfig();
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
        cachedPositions = { at: now, promise: liveClient.getPositions() };
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
    const unifiedRegimeEntryGate = () => {
      if (unifiedOrchestrator?.isEnabled() && !unifiedOrchestrator.canOpenNewEntries()) {
        const status = unifiedOrchestrator.getStatus();
        return {
          allowed: false,
          reason: `unified orchestrator ${status.brainState}: ${status.lastTrace?.reason ?? "direction not confirmed"}`,
        };
      }
      if (process.env.LIVE_REGIME_NO_TRADE_OVERRIDE === "1" || process.env.REGIME_ENGINE_EXECUTION_GATE_ENABLED === "0") {
        return { allowed: true, reason: null };
      }
      const snapshots = getRegimeEngineStore().snapshots;
      const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;
      if (!latest) return { allowed: false, reason: "regime engine has no snapshot" };
      const ageMs = Date.now() - new Date(latest.at).getTime();
      const maxAgeMs = Math.max(60_000, Number(process.env.LIVE_REGIME_GATE_MAX_AGE_MS) || 20 * 60_000);
      if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
        return { allowed: false, reason: `regime engine snapshot stale (${Math.round(ageMs / 1000)}s)` };
      }
      if (latest.action === "NO_TRADE") {
        return { allowed: false, reason: `regime engine NO_TRADE${latest.rejectedBy ? ` (${latest.rejectedBy})` : ""}` };
      }
      return { allowed: true, reason: null };
    };
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
      // Crowding-exit SHADOW measurement only (getStatus().crowdingExitShadow) — read-only market
      // data, never touches order placement. Reuses the same market-data client scan.ts uses.
      marketDataClient: binanceClient,
      newEntryGate: unifiedRegimeEntryGate,
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
      isPaperOrderLiveEligible: (order) => {
        if (unifiedOrchestrator?.isEnabled()) {
          return unifiedOrchestrator.allowsPaperOrder({
            selectedLaneId: order.selectedLaneId,
            direction: order.direction,
          });
        }
        // Operator manual directional mode is a narrow admission override: it may bypass maturity,
        // book, and regime-policy blockers only for the currently selected Entry Decision side and
        // explicitly selected lane. The engine still enforces freshness, geometry, caps, and all
        // exchange/account safety before it can open anything.
        if (liveEngine?.isManualEntryAllowedForPaper(order)) return true;
        const useTestnetPolicy =
          liveConfig.env === "testnet" ||
          (liveConfig.env === "mainnet" && liveConfig.mainnetKeepTestnetPolicy);
        const manuallySelected = liveEngine?.laneSelectionExplicitlyIncludesLane(order.selectedLaneId) ?? false;
        if (isProfitCoreShortLaneId(order.selectedLaneId)) {
          // The new lane is an OOS forward test, not a backdoor around mainnet's proven-only gate.
          return liveConfig.env === "testnet" && order.direction === "SHORT";
        }
        if (
          useTestnetPolicy &&
          !(
            isRealtimeShortAllowedLaneId(order.selectedLaneId) ||
            isRealtimeShortSelectableLaneId(order.selectedLaneId, manuallySelected)
          )
        ) return false;
        const orderEstimatedRegime = estimateLaneSelectorV2Regime({
          regime: order.regime,
          controllerMode: order.controllerMode,
          confidence: order.controllerConfidence ?? null,
        });
        if (
          useTestnetPolicy &&
          orderEstimatedRegime.direction === "MIXED" &&
          order.symbol.toUpperCase() === "NEARUSDT"
        ) {
          return false;
        }
        const report = buildCurrentGuardVariantMatrixReport(getCurrentGuardVariantMatrixStore());
        const rotationShortlist = buildRegimeRotationShortlistReport(report);
        const laneVariantId = order.selectedLaneId.split(":").pop() ?? order.selectedLaneId;
        const row = report.rows.find((candidate) => candidate.variantId === laneVariantId);
        // Force-eligible lanes (operator opt-in REALTIME_SHORT_FORCE_FAST_LONG/SHORT=1 +
        // FORCE_ELIGIBLE_LONG_VARIANT_IDS/FORCE_ELIGIBLE_SHORT_VARIANT_IDS below) are meant to trade
        // regardless of THIS instance's own thin/decaying STABLE_CANDIDATE label — live's local VM
        // book accrues observations slowly, so freshValid can dip back under the STABLE threshold
        // long after a lane was proven. Without this check, the hard gate below returned false
        // BEFORE the force-eligible bypass further down was ever consulted, silently defeating the
        // operator's own opt-in the moment freshValid decayed (2026-07-11 incident: CG_WIDE_FAST_LONG
        // went dark for 32h+ this way despite REALTIME_SHORT_FORCE_FAST_LONG=1 being set).
        const forceEligibleForDirection = isForceEligibleForDirection(order.direction, laneVariantId);
        if (
          liveConfig.env === "mainnet" &&
          row?.status !== "STABLE_CANDIDATE" &&
          process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE !== "1" &&
          !forceEligibleForDirection
        ) return false;
        const regimeFamily =
          orderEstimatedRegime.direction === "LONG"
            ? "BULLISH"
            : orderEstimatedRegime.direction === "SHORT"
              ? "BEARISH"
              : rotationRegimeFamilyForLabel(order.regime);
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
        return (
          row?.status === "STABLE_CANDIDATE" ||
          // Operator force-enabled lanes (e.g. CG_WIDE_FAST_SHORT/CG_WIDE_FAST_LONG) trade before
          // STABLE — only when the matching REALTIME_SHORT_FORCE_FAST_LONG/SHORT flag is set (off
          // by default ⇒ stable-only gate preserved). LONG counterpart (2026-07-07): lets
          // CG_WIDE_FAST_LONG trade in a long-permissive regime whose estimate direction is not
          // (yet) LONG — e.g. controller LONG_ONLY while the estimate still reads MIXED.
          // Bullish-estimate longs take the rotation-shortlist path above instead; this only
          // covers the fallback branch.
          isForceEligibleForDirection(order.direction, laneVariantId) ||
          isLaneSelectorV2LongWideStopOverride({
            variantId: laneVariantId,
            direction: order.direction,
            estimatedRegime: orderEstimatedRegime,
          })
        );
      },
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
        const regimeForEdge = controller?.regime ?? null;
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
      const xsecReport = buildCrossSectionalReport(getCrossSectionalStore(), nowMs, { variant: "FILTERED" });
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
        // 2026-07-21 operator ask: only the roster lanes the nightly refit has actually proven
        // LEARNING_ACTIVE may receive CORTEX's tilt — everything else stays pinned to its exact
        // static value inside runCortexShadowTick, while shadow collection/attribution continues for
        // every lane regardless (unaffected by this set).
        const learningActiveLaneIds = new Set(
          (getLatestCortexRefitReport()?.perLane ?? []).filter((l) => l.status === "LEARNING_ACTIVE").map((l) => l.laneId),
        );
        const promotion = mode === "live"
          ? {
              regimeCoverageGateMet: getLatestCortexRefitReport()?.coverage.regimeCoverageGateMet ?? false,
              blindCapitalPct: getLatestCortexRefitReport()?.coverage.blindCapitalPct ?? 100,
              envBlocked: cortexPromotionBlockedByEnv(process.env),
              learningActiveLaneIds,
            }
          : null;
        const { promotedWeights } = runCortexShadowTick({
          store: cortexStore,
          journal: cortexJournal,
          context,
          nowIso: new Date().toISOString(),
          mode,
          resolvedThisCycle: 0,
          promotion,
        });
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
    ): boolean => unifiedOrchestrator?.isEnabled()
      ? unifiedOrchestrator.allowsLegacySingleSymbolEntry(laneId, direction)
      : fallback();

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
    const currentRegimeStringForVeto = (): string | null => {
      const cached = getLatestScanCandidates();
      const scanStatus = coreScanAutoRefreshController.getStatus();
      const fallbackSnapshot =
        cached || scanStatus.lastAutoRefreshResultSummary
          ? null
          : getRegimeDirectionControllerSnapshotStore().readLatest();
      return (
        cached?.marketRegime ??
        scanStatus.lastAutoRefreshResultSummary?.marketRegime ??
        fallbackSnapshot?.currentRegime ??
        null
      );
    };
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
        isAllowed: () => crossSectionalMarketNeutralIsAllowed({
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
        cortexRealAttribution: getCortexRealAttributionStore(),
        // Per-fill execution recorder (2026-07-27, report-only — see execution-fill-recorder.ts).
        // closeBasket() already fetches one getUserTrades page per unique symbol to sum the real
        // commissions and discards every other field of every matched row; this persists them.
        // No new exchange call. Same singleton as the engine and the single-symbol lanes.
        executionFillRecorder: getExecutionFillRecorder(),
        entryHealthGate: () => {
          const report = buildCrossSectionalReport(getCrossSectionalStore(), Date.now(), { variant: "FILTERED" });
          return rollingNetEntryHealth(report.recentNetReturns);
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
        isAllowed: () => isCrossSectionalTrendMixedAdmissionIndependent()
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
      });
      crossSectionalMixedExecutor = new CrossSectionalExecutor({
        client: liveClient,
        signalStore: getCrossSectionalStore(),
        store: new CrossSectionalExecutorStore(undefined, "cross-sectional-executor-mixed.json"),
        targetVariant: "MIXED_MEAN_REVERSION",
        laneId: CROSS_SECTIONAL_MIXED_LANE_ID,
        // Same 2026-07-08 fix as CROSS_SECTIONAL_TREND above, plus the same 2026-07-22
        // admission-independence bypass (see CROSS_SECTIONAL_TREND's isAllowed above).
        isAllowed: () => isCrossSectionalTrendMixedAdmissionIndependent()
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
    // strategy-evidence, promotion, quarantine, regime, edge-memory, or unified-orchestrator gate.
    // It still uses the established executors, so armed/kill/drain state, exchange filters,
    // one-way netting, protective stops, allocation, notional caps, and cluster caps remain intact.
    if (liveEngine && isInnovationTestnetExecutionEnabled(liveConfig.env)) {
      const engineForGate = liveEngine;
      const innovationAllowed = (): boolean =>
        innovationTestnetAdmissionAllowed(engineForGate.canOpenNewEntriesIgnoringManualDirectional());
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
          isAllowed: innovationAllowed,
          laneWeightPct: () => innovationWeight(descriptor.laneId),
          rawLaneWeightPct: () => innovationWeight(descriptor.laneId),
          cortexRealAttribution: getCortexRealAttributionStore(),
          executionFillRecorder: getExecutionFillRecorder(),
          entryHealthGate: () => ({ allowed: true, reason: null }),
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
            isAllowed: innovationAllowed,
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
  // Research/testnet-only CORTEX lifecycle for an allowlisted instance with execution disabled.
  // This is shadow-only and has no engine reference, promotion object, allocation setter, or execution
  // callback. The hard instance gate excludes 3103 independently of environment configuration.
  if (!isTest && standaloneCortexShadowAllowed({ env: process.env, liveEnginePresent: liveEngine != null })) {
    const cortexStore = new CortexBrainStore("data/cortex-brain.json");
    const cortexJournal = new CortexDecisionJournal("data/cortex-decision-journal.jsonl");
    const staticWeightPctForLane = normalizeCortexStaticWeightPctForLane(() => 100);
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
        runCortexShadowTick({
          store: cortexStore,
          journal: cortexJournal,
          context: cortexStandaloneContext(),
          nowIso: new Date().toISOString(),
          mode: "shadow",
          resolvedThisCycle: 0,
          promotion: null,
        });
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
          nowMs: now.getTime(),
          nowIso: now.toISOString(),
        });
        console.log(
          `[cortex-refit-standalone] examples=${report.examplesTotal} (+${report.examplesNew} new) ` +
            `resolved=${report.coverage.cumulativeResolved} families=${report.coverage.regimeFamiliesWithOutcomes} ` +
            `blindCapital=${report.coverage.blindCapitalPct.toFixed(0)}%`,
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
    // Bounded ring buffer (last 100) of recent MARKET_SNAPSHOT / EXECUTIVE_DECISION journal records, fed
    // at journal-append time below (see wrapFourBrainJournalAppendForRecentDecisions) — the operator
    // dashboard's /api/shadow/four-brain route reads this, NEVER the journal file, on every request.
    const fourBrainRecentDecisions = new FourBrainRecentDecisionsBuffer({ capacity: 100 });
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
    const directionEntryOutcomeStore = getDirectionEntryOutcomeStore();
    if (directionEntryReconcilerActive(process.env)) {
      const rehydrated = rehydrateFourBrainOutcomeLedgerFromJournals({
        ledger: fourBrainOutcomeLedger,
        journalFiles: [
          "data/four-brain-decision-journal.jsonl.1",
          "data/four-brain-decision-journal.jsonl",
        ],
        hasProcessedDirection: (decisionId) => directionEntryOutcomeStore.hasProcessedDirection(decisionId),
        hasProcessedEntry: (decisionId) => directionEntryOutcomeStore.hasProcessedEntry(decisionId),
      });
      console.log(
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
    let fourBrainBtcFlowCache: {
      sentiment: number | null;
      crowdAlignLong: number | null;
      atMs: number;
    } | null = null;
    const ratioToSigned = (ratio: number | null): number | null =>
      typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0
        ? Math.max(-1, Math.min(1, (ratio - 1) / (ratio + 1)))
        : null;
    const CE_ALL_BUCKETS: CEBucket[] = ["WIDE_LONG", "FAST_LONG", "WIDE_SHORT", "FAST_SHORT"];
    // Retained handle for the report-only lane-context snapshot ticker (registered once, below) — see Stage-2 timer
    // ownership: single registration at boot, cleared on shutdown so a flush attempt never blocks termination.
    let laneContextSnapshotTimer: ReturnType<typeof setInterval> | null = null;

    const collectFourBrainOpenSignals = (): FourBrainBindingDeps["openSignals"] => {
      const out: FourBrainBindingDeps["openSignals"] = [];
      const add = (
        laneId: string,
        direction: "LONG" | "SHORT",
        sigs: { observationId: string; symbol: string; entryPrice: number; stopPrice: number; openedAtMs: number }[],
      ): void => {
        for (const s of sigs) out.push({ laneId, symbol: s.symbol, direction, observationId: s.observationId, openedAtMs: s.openedAtMs, entryPrice: s.entryPrice, stopPrice: s.stopPrice });
      };
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
      // anything that trades. Each row carries its own variantId and side, so these are pushed
      // directly rather than through add(); the bare variantId is deliberate — the Tier-1 matcher
      // strips the CG_VARIANT_MATRIX:/CG_LONG_VARIANT_MATRIX: prefixes itself, so it joins to both.
      try { for (const s of variantMatrixOpenSignals(getCurrentGuardVariantMatrixStore())) out.push(s); } catch { /* store unavailable ⇒ skip (no fabrication) */ }
      return out;
    };

    const activeFourBrainAllocation = (): { laneId: string; weightPct: number }[] => {
      const allocs = liveEngine?.getStatus().laneSelection?.laneAllocations;
      if (allocs && allocs.length > 0) return allocs.map((a) => ({ laneId: a.laneId, weightPct: a.weightPct }));
      // allocations OFF or no engine ⇒ treat every roster lane as active at 100 (degenerate all-lanes case)
      return CORTEX_LANE_ROSTER.map((e) => ({ laneId: e.laneId, weightPct: 100 }));
    };

    const buildFourBrainDeps = (nowMs: number): Omit<FourBrainBindingDeps, "entryMicrostructure"> => {
      const engine = liveEngine; // null on 3101 ⇒ engine-dependent fields degrade
      const status = engine ? engine.getStatus() : null;
      const snaps = getRegimeEngineStore().snapshots;
      const latestSnap = snaps.length ? snaps[snaps.length - 1]! : null;
      const axis = buildRegimeAxisTimeline(snaps);
      const scanCached = getLatestScanCandidates();
      const regime = scanCached?.marketRegime ?? latestSnap?.regime ?? null;
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
      const openPositions = intents
        .filter((i) => openStates.has(i.state))
        .map((i) => ({
          paperOrderId: i.paperOrderId,
          laneId: i.sourcePaperOrders?.[0]?.laneId ?? "UNKNOWN",
          symbol: i.symbol,
          direction: i.direction,
          entryPrice: i.filledEntryPrice ?? i.plannedEntryPrice,
          stopPrice: i.stopLossPrice,
          mfeR: i.maxFavorableR ?? null,
          maeR: i.maxAdverseR ?? null,
          createdAtMs: Date.parse(i.createdAt),
        }));
      const crowdingShadow = status?.crowdingExitShadow ?? {};
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
        // BTC USD-M global long/short ratio mapped monotonically from (0,+inf) to (-1,+1).
        // This is a measured derivatives proxy, not fabricated market-wide certainty.
        sentiment: fourBrainBtcFlowCache?.sentiment ?? null,
        sentimentAtMs: fourBrainBtcFlowCache?.sentiment !== null
          ? fourBrainBtcFlowCache?.atMs ?? null
          : null,
        safetyEvents: [],
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
        bestLaneReportForDirection: buildLiveBestLaneReportForDirection("data", ceBucketsOnce),
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
        ...(() => {
          const k = kronosAgreeFromScan(scanCached?.candidates, "BTCUSDT", parseAtMs(scanCached?.scanFinishedAt));
          return { kronosAgree: k.agree, kronosAtMs: k.atMs };
        })(),
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
        openSignals: collectFourBrainOpenSignals(),
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
        // CORTEX exposes no decision id; at β=0 its finalPct equals the incumbent static weight, which is
        // the correct allocation CONTEXT for the report-only executive linkage.
        cortexDecisionId: `four-brain:${nowMs}`,
        cortexFinalPctForLane: (laneId) => (engine ? engine.laneSelectionWeightPctForLane(laneId) : null),
        laneEligibleIncumbent: (laneId) => (engine ? engine.laneSelectionWeightPctForLane(laneId) > 0 : true),
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
    let lastFourBrainGatherBase: Omit<FourBrainBindingDeps, "entryMicrostructure"> | null = null;
    const buildFourBrainDepsForCycle = (nowMs: number): Omit<FourBrainBindingDeps, "entryMicrostructure"> => {
      const built = buildFourBrainDeps(nowMs);
      lastFourBrainGatherBase = built;
      return built;
    };

    const fourBrainCycle = (): void => {
      void runFourBrainShadowCycle({
        buildDeps: buildFourBrainDepsForCycle,
        fetchCandles: (symbol) => binanceClient.getCandles(symbol, "15m", 150).catch(() => null),
        fetchOrderflow: async (symbol) => {
          try {
            const payload = await binanceClient.getFuturesDepth(symbol, 100);
            const depth = parseDepthPayload(payload);
            const bestBid = depth.bids[0]?.price ?? null;
            const bestAsk = depth.asks[0]?.price ?? null;
            const configured = Number(process.env.FOUR_BRAIN_REFERENCE_NOTIONAL_USD ?? "250");
            const referenceNotionalUsd = Number.isFinite(configured)
              ? Math.min(5_000, Math.max(25, configured))
              : 250;
            const observedAtMs = Date.now();
            const buySlip = computeExpectedSlippageBps(depth, "BUY", referenceNotionalUsd);
            const sellSlip = computeExpectedSlippageBps(depth, "SELL", referenceNotionalUsd);
            return {
              spreadBps:
                bestBid !== null && bestAsk !== null
                  ? computeSpreadBps(bestBid, bestAsk)
                  : null,
              expectedSlippageBpsBuy: buySlip,
              expectedSlippageBpsSell: sellSlip,
              bookDepthOkBuy: buySlip !== null,
              bookDepthOkSell: sellSlip !== null,
              observedAtMs,
            };
          } catch {
            return null;
          }
        },
        candleTimeframe: "15m",
        activeAllocation: activeFourBrainAllocation,
        // Wrapped so the SAME journalAppend call that writes the real file also mirrors records into two
        // independent, best-effort side-observers — the bounded recent-decisions ring buffer (dashboard)
        // and the bounded Direction/Entry outcome ledger (counterfactual-resolution foundation) — while
        // the real file append (fourBrainJournal.append, innermost) stays the single unconditional/
        // unaltered call; see four-brain-recent-decisions.ts / four-brain-outcome-ledger.ts's own doc
        // comments.
        journalAppend: wrapFourBrainJournalAppendForOutcomeLedger(
          wrapFourBrainJournalAppendForRecentDecisions(
            (r) => fourBrainJournal.append(r),
            fourBrainRecentDecisions,
          ),
          fourBrainOutcomeLedger,
        ),
        // Bug fix: previously unsupplied ⇒ every journaled EXECUTIVE_DECISION had instanceId/rawFeatures/
        // normalizedFeatures/sourceStatuses/missingReasons/incumbent hard-null. Built from this cycle's own
        // captured gather deps (never fabricated) + the live incumbent lane allocation.
        journalContext: () =>
          lastFourBrainGatherBase
            ? buildFourBrainJournalContext(lastFourBrainGatherBase, activeFourBrainAllocation())
            : { instanceId: resolveFourBrainInstanceId(process.env) },
        metrics: fourBrainMetrics,
        now: () => Date.now(),
        perfNow: () => performance.now(), // monotonic clock for gather/inference/journal LATENCY only
      })
        .then((res) => {
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
      setTimeout(fourBrainCycle, 90_000);
      setInterval(fourBrainCycle, 5 * 60_000);

      // BTC ATR-percentile refresh — ATR-percentile is slow-moving (7d rolling window), so a 15min cadence is
      // ample (mirrors SYMBOL_VOLATILITY_REFRESH_INTERVAL_MS's 20min choice for the same reason). Near-immediate
      // warm-up fire so the value isn't null for the first full interval if avoidable; both calls are
      // fire-and-forget (refreshBtcAtrPercentileCache never throws — fail-open, see its own doc comment).
      const runBtcAtrPercentileRefresh = (): void => {
        void refreshBtcAtrPercentileCache(btcAtrPercentileCache, (symbol, interval, limit) =>
          binanceClient.getCandles(symbol, interval, limit),
        );
      };
      setTimeout(runBtcAtrPercentileRefresh, 10_000);
      setInterval(runBtcAtrPercentileRefresh, 15 * 60_000);

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
          fetchDirectionCandles: () => binanceClient.getCandles("BTCUSDT", "1h", 500).catch(() => null),
          fetchEntryTier2Candles: (symbol, sinceMs) =>
            binanceClient
              .getCandles(symbol, "15m", ENTRY_TIER2_HORIZON_BARS + ENTRY_TIER2_WAIT_WINDOW_BARS + 1, { startTime: sinceMs })
              .catch(() => null),
          now: () => Date.now(),
        })
          .then((res) => {
            if (!res) return; // single-flight skip — a prior cycle is still in flight
            console.log(
              `[direction-entry-reconciler] instance=${resolveFourBrainInstanceId(process.env)} ` +
                `directionProcessed=${res.directionProcessed} entryProcessed=${res.entryProcessed} ` +
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
    regimeAutopilot: () => regimeAutopilot,
    unifiedOrchestrator: () => unifiedOrchestrator,
    unifiedProposalStore: () => unifiedProposalStore,
    singleSymbolPriceTimeline: () => singleSymbolPriceTimeline,
  });

  return app;
}

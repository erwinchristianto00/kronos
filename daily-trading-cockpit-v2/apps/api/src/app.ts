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
import { BinanceFuturesPrivateClient } from "./lib/binance-futures-private.js";
import {
  CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
  CROSS_SECTIONAL_TREND_LANE_ID,
  CROSS_SECTIONAL_MIXED_LANE_ID,
  CrossSectionalExecutor,
  CrossSectionalExecutorStore,
  isCrossSectionalExecEnabled,
} from "./lib/cross-sectional-executor.js";
import { buildCrossSectionalReport, getCrossSectionalStore } from "./lib/cross-sectional-edge.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  type SingleSymbolExitPolicy,
} from "./lib/single-symbol-lane-executor.js";
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
  regimeCompositeShortOpenSignals,
  RCS_PAPER_LANE_ID,
} from "./lib/regime-composite-short-edge.js";
import {
  getCompositeEstimatorStore,
  isCompositeEstimatorExecEnabled,
  compositeEstimatorExitPolicy,
  compositeEstimatorOpenSignals,
  ceExecLegUsdForBucket,
  CE_EXEC_LEVERAGE,
  CE_EXEC_MAX_SIGNAL_AGE_MS,
  CE_EXEC_DAILY_MAX_LOSS_USD,
  CE_EXEC_MAX_CONCURRENT,
  ceLaneIdForBucket,
  type CEBucket,
} from "./lib/composite-estimator-edge.js";
import { computeExternalManagedNetQty, computeNotionalPerSymbol, maxNotionalPerSymbolAcrossLanes, isNewExecutorLaneAllowed, rollingNetEntryHealth, sumExternalRealizedPnlUsd } from "./lib/live-executor-wiring.js";
import { RegimeAutopilot, isRegimeAutopilotEnabled } from "./lib/regime-autopilot.js";
import { getRegimeEngineStore } from "./lib/regime-engine-service.js";
import { buildRegimeAxisTimeline } from "./lib/regime-axis-timeline.js";
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
} from "./lib/current-guard-variant-matrix.js";
import { getLatestScanCandidates } from "./lib/latest-scan-candidates-cache.js";
import { buildRegimeDirectionControllerReport } from "./lib/regime-direction-controller.js";
import { getRegimeDirectionControllerSnapshotStore } from "./lib/regime-direction-controller-snapshot.js";
import { getRegimeEdgeMemory } from "./lib/regime-edge-memory.js";
import { cortexBrainMode } from "./lib/cortex-brain.js";
import { CortexBrainStore, CortexDecisionJournal, runCortexShadowTick } from "./lib/cortex-brain-store.js";
import { runFourBrainShadowCycle } from "./lib/four-brain-live-wiring.js";
import { classifyIncumbentLanes } from "./lib/four-brain-lane-support.js";
import { buildLaneContextSnapshotInputs } from "./lib/lane-context-snapshot-source.js";
import { journalLaneSnapshots, laneJournalActive } from "./lib/lane-context-journal-runtime.js";
import { FourBrainMetricsAggregator } from "./lib/four-brain-metrics.js";
import { resolveFourBrainInstanceId, fourBrainInstanceAllowed, type FourBrainBindingDeps } from "./lib/four-brain-live-gather-bindings.js";
import { fourBrainMode } from "./lib/four-brain-types.js";
import { CORTEX_LANE_ROSTER, gatherCortexContext, normalizeCortexStaticWeightPctForLane } from "./lib/cortex-live-gather.js";
import { buildLiveCortexGatherDeps } from "./lib/cortex-live-gather-bindings.js";
import { runCortexNightlyRefit } from "./lib/cortex-refit-runner-bindings.js";
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
    } catch {
      // ledger wiring is best-effort
    }
  }

  performanceProvider?.warm();

  // Declared here (assigned below) so the shadow routes can READ the live engine's in-memory
  // status (sync getStatus, no I/O) for the order-reconciliation readiness gate, via a lazy getter.
  let liveEngine: LiveExecutionEngine | null = null;
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
  let regimeAutopilot: RegimeAutopilot | null = null;
  let unifiedOrchestrator: UnifiedTestnetOrchestrator | null = null;
  let unifiedProposalStore: UnifiedTestnetProposalStore | null = null;

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
  ];
  const allSingleSymbolLaneExecutors = (): Array<SingleSymbolLaneExecutor | null> => [
    shortFadeExecutor,
    intradayMomentumExecutor,
    regimeCompositeExecutor,
    compositeEstimatorWideLongExecutor,
    compositeEstimatorWideShortExecutor,
    compositeEstimatorFastLongExecutor,
    compositeEstimatorFastShortExecutor,
    panicWashoutExecutor,
  ];
  /** Notional already committed to `symbol` by every OTHER single-symbol executor (excludes
   *  `self` — an instance's own admission is already bounded by its own maxOpenPositions, and
   *  double-counting itself would make the cap tighter than intended). */
  const notionalForSymbolExcluding = (self: SingleSymbolLaneExecutor | null, symbol: string): number =>
    computeNotionalPerSymbol(allSingleSymbolLaneExecutors().filter((e) => e !== self)).get(symbol) ?? 0;

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
  });
  await registerNotificationRoutes(app, notificationService);

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
    const currentPublicPrice = async (symbol: string): Promise<number | null> => {
      const book = await binanceClient.getBookTicker(symbol);
      if (book.bid !== null && book.ask !== null && book.bid > 0 && book.ask > 0) return (book.bid + book.ask) / 2;
      if (book.bid !== null && book.bid > 0) return book.bid;
      if (book.ask !== null && book.ask > 0) return book.ask;
      return null;
    };
    // 2026-07-12 fix: every executor sharing this ONE netted account (3 CrossSectionalExecutor +
    // up to 8 SingleSymbolLaneExecutor instances) independently called client.getPositions() every
    // tick purely to read market-wide markPrice data — up to 11 redundant signed, account-wide
    // calls within the same staggered 5-minute window. Short-TTL (30s, well under any single
    // instance's own tick cadence) cache shared by ALL of them via each executor's own
    // sharedGetPositions option, so at most one signed call goes out per cache window regardless
    // of how many instances' ticks land inside it.
    let cachedPositions: { at: number; promise: ReturnType<typeof liveClient.getPositions> } | null = null;
    const sharedGetPositions = () => {
      const now = Date.now();
      if (!cachedPositions || now - cachedPositions.at > 30_000) {
        cachedPositions = { at: now, promise: liveClient.getPositions() };
      }
      return cachedPositions.promise;
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

    // ── CORTEX central-brain SHADOW tick (2026-07-12) ────────────────────────────────────────────
    // Gated hard on CENTRAL_BRAIN_MODE==='shadow' (default OFF ⇒ this is a pure no-op and NOTHING in the
    // live path changes). In shadow it gathers the current federated context per lane, runs decideCortex,
    // and APPENDS a BRAIN_DECISION to the journal — it DRIVES NOTHING (never calls setAllocations). The
    // brain's only authority remains a weight vector that would flow through the engine's guards; here it
    // is purely observed + scored vs the incumbent. resolvedThisCycle=0 keeps β=0 (== post-federated-veto
    // incumbent) until the outcome-attribution + nightly-refit increment (#218) advances the ramp.
    const cortexStore = new CortexBrainStore("data/cortex-brain.json");
    const cortexJournal = new CortexDecisionJournal("data/cortex-decision-journal.jsonl");
    const cortexShadowTick = () => {
      try {
        if (cortexBrainMode(process.env) !== "shadow" || !liveEngine) return;
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
        const staticWeightPctForLane = normalizeCortexStaticWeightPctForLane(
          (laneId) => engine.laneSelectionWeightPctForLane(laneId),
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
        runCortexShadowTick({ store: cortexStore, journal: cortexJournal, context, nowIso: new Date().toISOString(), mode: "shadow", resolvedThisCycle: 0 });
      } catch (err) {
        console.error("[cortex-shadow] tick failed", err);
      }
    };
    if (!isTest) {
      cortexShadowTick();
      setInterval(cortexShadowTick, 5 * 60_000);
    }

    // ── CORTEX #218 nightly refit (outcome-attribution + per-archetype logistic refit) ───────────────
    // Gated on shadow mode (opt-out CORTEX_REFIT_ENABLED=0). Report-only + idempotent: attributes each
    // lane's OWN resolved closes to their owning decisions, refits the archetype coefficients (ACCEPTED
    // only), and advances cumulativeResolved/resolvedByFamily via the monotonic watermark. It NEVER touches
    // CORTEX_LIVE_BETA (0) — learning ≠ going live; the operational allocation stays the β=0 incumbent.
    // Runs at boot + every 6h (a same-run re-read adds 0, so cadence is harmless); the report feeds #219.
    const cortexRefitTick = () => {
      try {
        if (cortexBrainMode(process.env) !== "shadow" || !liveEngine || process.env.CORTEX_REFIT_ENABLED === "0") return;
        const engine = liveEngine;
        const now = new Date();
        const staticWeightPctForLane = normalizeCortexStaticWeightPctForLane(
          (laneId) => engine.laneSelectionWeightPctForLane(laneId),
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
        isAllowed: () => unifiedOrchestrator?.isEnabled()
          ? (engineForGate?.canOpenNewEntries() ?? false) &&
            unifiedOrchestrator.allowsCrossSectionalLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID)
          : (engineForGate?.canOpenNewEntries() ?? false) &&
            (engineForGate?.laneSelectionAllowsLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) ?? false),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) ?? 0,
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
        isAllowed: () => unifiedOrchestrator?.isEnabled()
          ? unifiedOrchestrator.allowsCrossSectionalLane(CROSS_SECTIONAL_TREND_LANE_ID)
          : isNewExecutorLaneAllowed(CROSS_SECTIONAL_TREND_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_TREND_LANE_ID) ?? 100,
        siblingOpenLegs: () => [
          ...(crossSectionalExecutor?.getOpenUnexitedLegs() ?? []),
          ...(crossSectionalMixedExecutor?.getOpenUnexitedLegs() ?? []),
        ],
        siblingDailyRealizedUsd: (nowIso) =>
          (crossSectionalExecutor?.getDailyRealizedUsd(nowIso) ?? 0) +
          (crossSectionalMixedExecutor?.getDailyRealizedUsd(nowIso) ?? 0),
        sharedGetPositions,
      });
      crossSectionalMixedExecutor = new CrossSectionalExecutor({
        client: liveClient,
        signalStore: getCrossSectionalStore(),
        store: new CrossSectionalExecutorStore(undefined, "cross-sectional-executor-mixed.json"),
        targetVariant: "MIXED_MEAN_REVERSION",
        laneId: CROSS_SECTIONAL_MIXED_LANE_ID,
        // Same 2026-07-08 fix as CROSS_SECTIONAL_TREND above.
        isAllowed: () => unifiedOrchestrator?.isEnabled()
          ? unifiedOrchestrator.allowsCrossSectionalLane(CROSS_SECTIONAL_MIXED_LANE_ID)
          : isNewExecutorLaneAllowed(CROSS_SECTIONAL_MIXED_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_MIXED_LANE_ID) ?? 100,
        siblingOpenLegs: () => [
          ...(crossSectionalExecutor?.getOpenUnexitedLegs() ?? []),
          ...(crossSectionalTrendExecutor?.getOpenUnexitedLegs() ?? []),
        ],
        siblingDailyRealizedUsd: (nowIso) =>
          (crossSectionalExecutor?.getDailyRealizedUsd(nowIso) ?? 0) +
          (crossSectionalTrendExecutor?.getDailyRealizedUsd(nowIso) ?? 0),
        sharedGetPositions,
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
        isAllowedReason: () => edgeVeto("SHORT").reason,
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(SF_PAPER_LANE_ID) ?? 100,
        legUsd: SF_EXEC_LEG_USD,
        leverage: SF_EXEC_LEVERAGE,
        maxOpenPositions: SF_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: SF_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: SF_EXEC_DAILY_MAX_LOSS_USD,
        // 2026-07-09 fix: cross-lane per-symbol notional cap — see live-executor-wiring.ts's
        // computeNotionalPerSymbol doc comment for the incident this closes.
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(shortFadeExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        currentPrice: currentPublicPrice,
        sharedGetPositions,
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
        isAllowedReason: () => edgeVeto("LONG").reason,
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(IM_PAPER_LANE_ID) ?? 100,
        legUsd: IM_EXEC_LEG_USD,
        leverage: IM_EXEC_LEVERAGE,
        maxOpenPositions: IM_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: IM_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: IM_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(intradayMomentumExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        currentPrice: currentPublicPrice,
        sharedGetPositions,
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
        isAllowedReason: () => edgeVeto("LONG").reason,
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(RC_PAPER_LANE_ID) ?? 100,
        legUsd: RC_EXEC_LEG_USD,
        leverage: RC_EXEC_LEVERAGE,
        maxOpenPositions: RC_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: RC_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: RC_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(regimeCompositeExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        currentPrice: currentPublicPrice,
        sharedGetPositions,
      });
      if (!isTest) {
        const rcTick = () => void regimeCompositeExecutor?.tick();
        setTimeout(rcTick, 240_000);
        setInterval(rcTick, 5 * 60_000);
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
        isAllowedReason: () => edgeVeto("LONG").reason,
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(PWR_PAPER_LANE_ID) ?? 100,
        legUsd: PWR_EXEC_LEG_USD,
        leverage: PWR_EXEC_LEVERAGE,
        maxOpenPositions: PWR_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: PWR_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: PWR_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(panicWashoutExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        currentPrice: currentPublicPrice,
        sharedGetPositions,
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
          // the live allocation table at a small (3%) weight. The other 3 buckets (WIDE_SHORT,
          // FAST_LONG, FAST_SHORT — the unproven quadrants per this module's own header comment)
          // stay ineligible — a per-bucket decision, not a blanket override.
          isAllowed: () => legacyEntryAllowed(
            laneId,
            direction,
            () => isNewExecutorLaneAllowed(laneId, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: bucket === "WIDE_LONG" }) && edgeVeto(direction).allowed,
          ),
          isAllowedReason: () => edgeVeto(direction).reason,
          laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(laneId) ?? 100,
          legUsd: () => ceExecLegUsdForBucket(bucket),
          leverage: CE_EXEC_LEVERAGE,
          maxOpenPositions: CE_EXEC_MAX_CONCURRENT,
          maxSignalAgeMs: CE_EXEC_MAX_SIGNAL_AGE_MS,
          dailyMaxLossUsd: CE_EXEC_DAILY_MAX_LOSS_USD,
          // 2026-07-09 fix: cross-lane per-symbol notional cap — selfGetter lets each of the 4
          // buckets exclude only ITS OWN positions (not the other 3 buckets, which DO count
          // toward each other's exposure on the same symbol, same as every other lane).
          existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(selfGetter(), symbol),
          maxNotionalPerSymbolAcrossLanes,
          currentPrice: currentPublicPrice,
          sharedGetPositions,
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
      const regime = getLatestScanCandidates()?.marketRegime ?? latestSnap?.regime ?? null;
      const edgeMem = getRegimeEdgeMemory();
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
      return {
        instanceId: resolveFourBrainInstanceId(process.env),
        nowMs,
        axisScore: axis.current?.score ?? null,
        axisAtMs: axis.current?.at ? Date.parse(axis.current.at) : null,
        axisSlopePerHour: axis.slopePerHour ?? null,
        // No valid market-wide 0..100 ATR-percentile producer (the cached BTC value is an ATR/price
        // fraction, wrong scale) ⇒ MISSING, never fabricated.
        btcAtrPercentile: null,
        atrAtMs: null,
        advancersPct: latestSnap?.breadth.advancersPct ?? null,
        breadthAtMs: latestSnap?.at ? Date.parse(latestSnap.at) : null,
        // No market-wide sentiment / crowd-align / kronos-agree −1..1 producer ⇒ MISSING (CORTEX
        // neutral-fills the same inputs). Per-symbol async producers exist but are not sync-safe here.
        sentiment: null,
        sentimentAtMs: null,
        safetyEvents: [],
        regimeRaw: regime,
        edgeMemory: edgeMem,
        controllerBias: controller.directionalBias,
        convictionScore: Number.isFinite(controller.convictionScore) ? controller.convictionScore : null,
        allowsLong: controller.allowsLong,
        allowsShort: controller.allowsShort,
        bestLaneReportForDirection: () => null,
        crowdAlignLong: null,
        crowdAtMs: null,
        kronosAgree: null,
        kronosAtMs: null,
        openSignals: collectFourBrainOpenSignals(),
        maxSignalAgeMs: 50 * 60_000,
        crowdingStateForSymbol: (symbol) => crowdingShadow[symbol]?.crowdingState ?? null,
        openPositions,
        // No sync {price,atMs} mark source ⇒ MISSING (atMs null ⇒ the gather never treats it as fresh).
        // Testnet holds 0 open positions today, so live exit coverage is zero; the replay harness supplies
        // the exit-decision example. Honest — not a stub that pretends the mark is fresh.
        markPriceForSymbol: () => ({ price: null, atMs: null }),
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

    const fourBrainCycle = (): void => {
      void runFourBrainShadowCycle({
        buildDeps: buildFourBrainDeps,
        fetchCandles: (symbol) => binanceClient.getCandles(symbol, "15m", 150).catch(() => null),
        candleTimeframe: "15m",
        activeAllocation: activeFourBrainAllocation,
        journalAppend: (r) => fourBrainJournal.append(r),
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
              `completed=${s.ticks.completed} skipped=${s.ticks.skippedSingleFlight} gatherErr=${s.ticks.gatherErrors}`,
          );
        })
        .catch((err) => console.error("[four-brain-shadow] cycle failed", err));
    };
    // Arm the interval ONLY where the tick could actually run — 3103 (live) never even schedules it.
    if (fourBrainMode(process.env) === "shadow" && fourBrainInstanceAllowed(process.env)) {
      setTimeout(fourBrainCycle, 90_000);
      setInterval(fourBrainCycle, 5 * 60_000);
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
    compositeEstimatorWideLongExecutor: () => compositeEstimatorWideLongExecutor,
    compositeEstimatorWideShortExecutor: () => compositeEstimatorWideShortExecutor,
    compositeEstimatorFastLongExecutor: () => compositeEstimatorFastLongExecutor,
    compositeEstimatorFastShortExecutor: () => compositeEstimatorFastShortExecutor,
    panicWashoutExecutor: () => panicWashoutExecutor,
    regimeAutopilot: () => regimeAutopilot,
    unifiedOrchestrator: () => unifiedOrchestrator,
    unifiedProposalStore: () => unifiedProposalStore,
  });

  return app;
}

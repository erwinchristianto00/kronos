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
import { SingleSymbolLaneExecutor, SingleSymbolLaneExecutorStore } from "./lib/single-symbol-lane-executor.js";
import {
  getShortFadeStore,
  isShortFadeExecEnabled,
  shortFadeExitPolicy,
  shortFadeOpenSignals,
  SF_EXEC_LEG_USD,
  SF_EXEC_LEVERAGE,
  SF_EXEC_MAX_SIGNAL_AGE_MS,
  SF_EXEC_DAILY_MAX_LOSS_USD,
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
import { computeExternalManagedNetQty, computeNotionalPerSymbol, maxNotionalPerSymbolAcrossLanes, isNewExecutorLaneAllowed, rollingNetEntryHealth } from "./lib/live-executor-wiring.js";
import { RegimeAutopilot, isRegimeAutopilotEnabled } from "./lib/regime-autopilot.js";
import { getRegimeEngineStore } from "./lib/regime-engine-service.js";
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
  FORCE_ELIGIBLE_SHORT_VARIANT_IDS,
  FORCE_ELIGIBLE_LONG_VARIANT_IDS,
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

  // 2026-07-09 fix: all 8 single-symbol executors, for the cross-lane per-symbol notional cap
  // (computeNotionalPerSymbol) — see that function's doc comment for the incident this closes.
  // Referencing the mutable `let` bindings above is safe: this is only ever CALLED during a tick,
  // well after every executor below has been constructed and assigned.
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
    const unifiedRegimeEntryGate = () => {
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
    liveEngine = new LiveExecutionEngine({
      config: liveConfig,
      client: liveClient,
      store: new LiveExecutionStore(),
      // Crowding-exit SHADOW measurement only (getStatus().crowdingExitShadow) — read-only market
      // data, never touches order placement. Reuses the same market-data client scan.ts uses.
      marketDataClient: binanceClient,
      newEntryGate: unifiedRegimeEntryGate,
      // Cross-sectional basket legs (and now the 2 single-symbol executors' positions) share this
      // Binance account but are NOT engine intents — reconcile must know about them or it flags
      // every leg/position as an orphan and disarms one tick after it opens. Lazy closure: the
      // executors are constructed later in this function (they need the engine for their own
      // isAllowed gate), so resolve at call time.
      // 2026-07-08: sums across ALL FIVE executor instances (cross-sectional FILTERED + TREND +
      // MIXED, plus the new SHORT_FADE_EXHAUSTION + INTRADAY_MOMENTUM_BREAKOUT single-symbol
      // executors) — the same starvation/false-orphan class of bug the original single-instance
      // fix addressed would otherwise recur for every one of the new instances' own open legs.
      externalManagedNetQty: () =>
        computeExternalManagedNetQty(
          [crossSectionalExecutor, crossSectionalTrendExecutor, crossSectionalMixedExecutor],
          [
            shortFadeExecutor,
            intradayMomentumExecutor,
            regimeCompositeExecutor,
            compositeEstimatorWideLongExecutor,
            compositeEstimatorWideShortExecutor,
            compositeEstimatorFastLongExecutor,
            compositeEstimatorFastShortExecutor,
            panicWashoutExecutor,
          ],
        ),
      // "Mode 2" (REALTIME_SHORT_MIRROR_ENABLED=1): the engine mirrors ONLY the dedicated
      // real-time short store — fresh, short-only, stable-lane orders — and never the
      // measurement paper book. Flag off → unchanged (reads the normal paper book).
      paperStore: isRealtimeShortMirrorEnabled()
        ? getRealtimeShortMirrorStore()
        : getPaperExecutionRouterStore(),
      isPaperOrderLiveEligible: (order) => {
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
        if (
          liveConfig.env === "mainnet" &&
          row?.status !== "STABLE_CANDIDATE" &&
          process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE !== "1"
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
          // Operator force-enabled short lanes (e.g. CG_WIDE_FAST_SHORT) trade before STABLE — only
          // when REALTIME_SHORT_FORCE_FAST_SHORT=1 (off by default ⇒ stable-only gate preserved).
          (process.env.REALTIME_SHORT_FORCE_FAST_SHORT === "1" &&
            order.direction === "SHORT" &&
            FORCE_ELIGIBLE_SHORT_VARIANT_IDS.has(laneVariantId)) ||
          // LONG counterpart (2026-07-07): lets CG_WIDE_FAST_LONG trade in a long-permissive regime
          // whose estimate direction is not (yet) LONG — e.g. controller LONG_ONLY while the
          // estimate still reads MIXED. Bullish-estimate longs take the rotation-shortlist path
          // above instead; this only covers the fallback branch.
          (process.env.REALTIME_SHORT_FORCE_FAST_LONG === "1" &&
            order.direction === "LONG" &&
            FORCE_ELIGIBLE_LONG_VARIANT_IDS.has(laneVariantId)) ||
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
        const controller = buildRegimeDirectionControllerReport({
          currentRegime: regime,
          adaptiveDirectionBias: null,
          primaryValidationLane: null,
          edgeGate: getRegimeEdgeMemory(),
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
          estimatedRegime,
          reasons: controller.reasonCodes,
          capturedAt: cached?.scanFinishedAt ?? scanStatus.lastAutoRefreshFinishedAt ?? fallbackSnapshot?.capturedAt ?? null,
        };
      },
    });
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
        isAllowed: () =>
          (engineForGate?.canOpenNewEntries() ?? false) &&
          (engineForGate?.laneSelectionAllowsLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) ?? false),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) ?? 0,
        entryHealthGate: () => {
          const report = buildCrossSectionalReport(getCrossSectionalStore(), Date.now(), { variant: "FILTERED" });
          return rollingNetEntryHealth(report.recentNetReturns);
        },
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
        isAllowed: () => isNewExecutorLaneAllowed(CROSS_SECTIONAL_TREND_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_TREND_LANE_ID) ?? 100,
      });
      crossSectionalMixedExecutor = new CrossSectionalExecutor({
        client: liveClient,
        signalStore: getCrossSectionalStore(),
        store: new CrossSectionalExecutorStore(undefined, "cross-sectional-executor-mixed.json"),
        targetVariant: "MIXED_MEAN_REVERSION",
        laneId: CROSS_SECTIONAL_MIXED_LANE_ID,
        // Same 2026-07-08 fix as CROSS_SECTIONAL_TREND above.
        isAllowed: () => isNewExecutorLaneAllowed(CROSS_SECTIONAL_MIXED_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(CROSS_SECTIONAL_MIXED_LANE_ID) ?? 100,
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
        // 2026-07-08 audit fix: see the cross-sectional TREND/MIXED comment above — require
        // EXPLICIT allocation inclusion so this never-before-executed lane can't silently fire at
        // full size before it has ever actually been named in an allocation.
        isAllowed: () => isNewExecutorLaneAllowed(SF_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(SF_PAPER_LANE_ID) ?? 100,
        legUsd: SF_EXEC_LEG_USD,
        leverage: SF_EXEC_LEVERAGE,
        maxSignalAgeMs: SF_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: SF_EXEC_DAILY_MAX_LOSS_USD,
        // 2026-07-09 fix: cross-lane per-symbol notional cap — see live-executor-wiring.ts's
        // computeNotionalPerSymbol doc comment for the incident this closes.
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(shortFadeExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        currentPrice: currentPublicPrice,
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
        // 2026-07-08 audit fix: same as SHORT_FADE_EXHAUSTION above.
        isAllowed: () => isNewExecutorLaneAllowed(IM_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(IM_PAPER_LANE_ID) ?? 100,
        legUsd: IM_EXEC_LEG_USD,
        leverage: IM_EXEC_LEVERAGE,
        maxSignalAgeMs: IM_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: IM_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(intradayMomentumExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        currentPrice: currentPublicPrice,
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
        // 2026-07-08 audit fix pattern (same as its siblings above): require EXPLICIT allocation
        // inclusion so this never-before-executed lane can't silently fire at full size before
        // the operator has ever actually named its lane id in an allocation.
        isAllowed: () => isNewExecutorLaneAllowed(RC_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(RC_PAPER_LANE_ID) ?? 100,
        legUsd: RC_EXEC_LEG_USD,
        leverage: RC_EXEC_LEVERAGE,
        maxOpenPositions: RC_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: RC_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: RC_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(regimeCompositeExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        currentPrice: currentPublicPrice,
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
        // 2026-07-08 audit fix pattern (same as its siblings above): require EXPLICIT allocation
        // inclusion so this never-before-executed lane can't silently fire at full size before
        // the operator has ever actually named its lane id in an allocation.
        isAllowed: () => isNewExecutorLaneAllowed(PWR_PAPER_LANE_ID, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
        laneWeightPct: () => engineForGate?.laneSelectionWeightPctForLane(PWR_PAPER_LANE_ID) ?? 100,
        legUsd: PWR_EXEC_LEG_USD,
        leverage: PWR_EXEC_LEVERAGE,
        maxOpenPositions: PWR_EXEC_MAX_CONCURRENT,
        maxSignalAgeMs: PWR_EXEC_MAX_SIGNAL_AGE_MS,
        dailyMaxLossUsd: PWR_EXEC_DAILY_MAX_LOSS_USD,
        existingNotionalForSymbol: (symbol) => notionalForSymbolExcluding(panicWashoutExecutor, symbol),
        maxNotionalPerSymbolAcrossLanes,
        currentPrice: currentPublicPrice,
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
          // 2026-07-08 audit fix pattern (same as every sibling above): require EXPLICIT allocation
          // inclusion so a never-before-executed lane can't silently fire at full size before the
          // operator has ever actually named its lane id in an allocation.
          isAllowed: () => isNewExecutorLaneAllowed(laneId, liveConfig.env === "testnet" ? "testnet" : "mainnet", engineForGate, { mainnetEntryEligible: false }),
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
  });

  return app;
}

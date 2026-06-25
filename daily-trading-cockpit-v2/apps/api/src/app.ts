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
  LiveExecutionEngine,
  LiveExecutionStore,
  parseLiveExecutionConfig,
} from "./lib/live-execution-engine.js";
import { getPaperExecutionRouterStore } from "./lib/paper-execution-router.js";
import {
  getRealtimeShortMirrorStore,
  isRealtimeShortMirrorEnabled,
} from "./lib/realtime-short-mirror.js";
import {
  buildCurrentGuardVariantMatrixReport,
  getCurrentGuardVariantMatrixStore,
} from "./lib/current-guard-variant-matrix.js";

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

  const coreScanAutoRefreshController = await registerScanRoute(app, scanService, tracker, outcomeChecker, shadowEngine, { binanceClient, performanceProvider });
  await registerKronosRoutes(app, kronosClient, binanceClient);
  await registerOutcomesRoutes(app, tracker, performanceProvider);
  // Declared here (assigned below) so the shadow routes can READ the live engine's in-memory
  // status (sync getStatus, no I/O) for the order-reconciliation readiness gate, via a lazy getter.
  let liveEngine: LiveExecutionEngine | null = null;
  await registerShadowRoutes(app, shadowEngine, {
    binanceClient,
    metadataFetchImpl: options.fetchImpl,
    coreScanAutoRefreshController,
    notificationService,
    liveEngineGetter: () => liveEngine,
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
    liveEngine = new LiveExecutionEngine({
      config: liveConfig,
      client: liveClient,
      store: new LiveExecutionStore(),
      // "Mode 2" (REALTIME_SHORT_MIRROR_ENABLED=1): the engine mirrors ONLY the dedicated
      // real-time short store — fresh, short-only, stable-lane orders — and never the
      // measurement paper book. Flag off → unchanged (reads the normal paper book).
      paperStore: isRealtimeShortMirrorEnabled()
        ? getRealtimeShortMirrorStore()
        : getPaperExecutionRouterStore(),
      isPaperOrderLiveEligible: (order) => {
        const report = buildCurrentGuardVariantMatrixReport(getCurrentGuardVariantMatrixStore());
        const laneVariantId = order.selectedLaneId.split(":").pop() ?? order.selectedLaneId;
        const row = report.rows.find((candidate) => candidate.variantId === laneVariantId);
        return row?.status === "STABLE_CANDIDATE";
      },
    });
    if (!isTest) liveEngine.start();
  }
  await registerLiveRoutes(app, liveEngine, { configErrors: liveConfig.enabled ? liveConfig.configErrors : [] });

  return app;
}

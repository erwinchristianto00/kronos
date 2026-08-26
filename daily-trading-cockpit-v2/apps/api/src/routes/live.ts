/**
 * /api/live/* — control surface for the live-execution engine (Binance USD-M mirror).
 *
 * The engine is OPTIONAL: when LIVE_EXECUTION_ENABLED!=1 it is never constructed and
 * these routes report { enabled:false } without touching anything. Keys are never
 * echoed by any endpoint.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Candle } from "@dtc/shared";
import {
  isOverlayClose, realisedNetR, replayOwnExit, positionCostR, summariseCounterfactual,
  ownExitParamsFromEnv, type DirectionalClosedPosition, type Bar, type CounterfactualRow,
} from "../lib/directional-overlay-counterfactual.js";
import { dirname, resolve } from "node:path";

import { buildInstrumentationReport } from "../lib/instrumentation-report.js";
import { rejectedBasketLogPath } from "../lib/rejected-basket-recorder.js";
import type { FastifyInstance } from "fastify";

import { BinanceFuturesPrivateError, withBinanceTransportSource, type BinanceFuturesRateLimitStatus } from "../lib/binance-futures-private.js";
import type { LiveExecutionEngine } from "../lib/live-execution-engine.js";
import { fullyCostedNetPnlUsd, fullyCostedFeeUsd } from "../lib/fully-costed-net-pnl.js";
import { poolReconciliationPlan } from "../lib/symbol-pool-reconciliation.js";
import {
  evaluateSymbolEligibility, effectiveLegUsd, oneLotNotionalUsd, DEFAULT_ELIGIBILITY,
  type SymbolEligibilityInput, type EligibilityVerdict,
} from "../lib/symbol-eligibility.js";
import {
  closedBasketRealizedBreakdown,
  crossSectionalEstimatedCostPct,
  isCrossSectionalBasketReportingExcluded,
  type CrossSectionalExecutor,
} from "../lib/cross-sectional-executor.js";
import type { CrossSectionalAutoPool, CrossSectionalAutoPoolSnapshot } from "../lib/cross-sectional-auto-pool.js";
import type { SymbolReliabilitySnapshot } from "../lib/cross-sectional-symbol-reliability.js";
import { DAILY_RANGE_LANE_ID, type DailyRangeAcceptanceLane } from "../lib/daily-4h-range-acceptance-lane.js";
import type { DailyRangeAutoPoolSnapshot } from "../lib/daily-range-auto-pool.js";
import type { SingleSymbolLaneExecutor } from "../lib/single-symbol-lane-executor.js";
import {
  CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID,
  CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID,
  DIRECTIONAL_REGIME_MFE_PROFIT_LOCK_NET_RETURN,
  DIRECTIONAL_REGIME_STATIC_TP_MAX_NET_RETURN,
  type CrossSectionalDirectionalDecision,
} from "../lib/cross-sectional-directional-regime.js";
import {
  EXECUTABLE_INNOVATION_LANE_IDS,
  INNOVATION_POLICY_ONLY_IDS,
} from "../lib/innovation-testnet-execution.js";
import type { InnovationCampaignDiagnostics } from "../lib/innovation-campaign.js";
import type { SingleSymbolPriceTimelineService } from "../lib/single-symbol-price-timeline.js";
import type { FuturesReferenceHealthSnapshot } from "../lib/futures-reference-health.js";
import { REGIME_AUTOPILOT_PRESETS, type RegimeAutopilot } from "../lib/regime-autopilot.js";
import { getShortFadeStore, buildShortFadeReport, SF_PAPER_LANE_ID } from "../lib/short-fade-edge.js";
import { getIntradayMomentumStore, buildIntradayMomentumReport, IM_PAPER_LANE_ID } from "../lib/intraday-momentum-edge.js";
import { getRegimeCompositeStore, buildRegimeCompositeReport, RC_PAPER_LANE_ID } from "../lib/regime-composite-edge.js";
import { getRegimeCompositeShortStore, buildRegimeCompositeShortReport, RCS_PAPER_LANE_ID } from "../lib/regime-composite-short-edge.js";
import { getPanicWashoutStore, buildPanicWashoutReport, PWR_PAPER_LANE_ID } from "../lib/panic-washout-reclaim-edge.js";
import { getCompositeEstimatorStore, buildCompositeEstimatorReport, ceLaneIdForBucket, type CEBucket } from "../lib/composite-estimator-edge.js";
import { LANE_SELECTOR_V2_LIVE_SUPPORTED_VARIANT_IDS, laneSelectorV2LaneId } from "../lib/lane-selector-v2.js";
import { buildLiveWalletReconciliationReport, resolveDayUtc } from "../lib/wallet-reconciliation.js";
import { getCortexRealAttributionStore } from "../lib/cortex-real-attribution.js";
import { getFundingFeeRecorder, withFundingFeeRecording } from "../lib/funding-fee-recorder.js";
import { sumExternalClosedFeesUsd, sumExternalRealizedPnlUsd } from "../lib/live-executor-wiring.js";
import { getCrossSectionalReportSinceMs, CROSS_SECTIONAL_HORIZON_MS } from "../lib/cross-sectional-edge.js";
import { continuationChampionDetail } from "../lib/continuation-champion-registry.js";
import {
  continuationLifecyclePaths,
  queuedLifecycleCommands,
  queueLifecycleCommand,
  readCollectorHealth,
  readLabelMaturationStatus,
  readLifecycleStatus,
  type ContinuationLifecycleCommand,
} from "../lib/continuation-lifecycle.js";
import { dynamicMom36ContinuationArtifactStatus } from "../lib/dynamic-mom36-continuation-runtime.js";
import type { UnifiedTestnetOrchestrator } from "../lib/unified-testnet-orchestrator.js";
import type { UnifiedTestnetProposalStore } from "../lib/unified-testnet-proposal-source.js";
import {
  CopyAuditLogger,
  CopyReplayGuard,
  copyPayloadSha256,
  isLoopbackAddress,
  signCopyRequest,
  verifyCopyRequest,
  type CopyAuditEvent,
  type CopyAuthHeaders,
} from "../lib/copy-to-live-security.js";

/** 2026-07-10: was named PROFIT_CORE_SHORT_ENABLED (the flag), but the lane id itself only ever
 *  appears inline in realtime-short-mirror.ts (PROFIT_CORE_SHORT_TRAIL_LANE_ID) — not re-exported
 *  from anywhere routes/live.ts already imports, so it's spelled out here to avoid a wider import. */
const PROFIT_CORE_SHORT_TRAIL_LANE_ID = "PROFIT_CORE_SHORT_TRAIL";

// The served dashboard asks only for these operator review windows.  Bounding both interval and
// count keeps a chart refresh from becoming an arbitrary market-data proxy.
const OPEN_BASKET_CHART_LIMITS = {
  // The two views actually rendered in the dashboard.  They deliberately retain
  // enough completed history to review the path rather than only the latest bar.
  "5m": 576,  // 48h
  "1d": 120,  // 120 completed daily candles
  // Kept for the older read-only chart clients and for the prior-UTC-day range
  // reference that the new 5m view draws.  The 4h selector needs a complete
  // EMA50 plus enough completed pivots to render structural trendlines; this
  // remains a bounded, display-only USD-M public-candle read.
  "15m": 192,
  "1h": 168,
  "4h": 96,   // 16d: full EMA50 + confirmed pivots, including prior UTC 00:00-04:00 bar
} as const;
type OpenBasketChartInterval = keyof typeof OPEN_BASKET_CHART_LIMITS;
const FOUR_HOURS_MS = 4 * 60 * 60_000;

function isOpenBasketChartInterval(value: unknown): value is OpenBasketChartInterval {
  return typeof value === "string" && Object.hasOwn(OPEN_BASKET_CHART_LIMITS, value);
}

function validOpenBasketChartSymbol(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{4,30}$/.test(value);
}

type OpenBasketChartCandle = Pick<Candle, "openTime" | "open" | "high" | "low" | "close" | "volume">;

function cleanOpenBasketChartCandles(candles: readonly Candle[]): OpenBasketChartCandle[] {
  return candles
    .filter((candle) =>
      Number.isFinite(candle.openTime) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.volume) &&
      candle.openTime > 0 && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 && candle.volume >= 0,
    )
    .map((candle) => ({
      openTime: candle.openTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }))
    .sort((a, b) => a.openTime - b.openTime);
}

function previousUtcDayStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0);
}

/** Parse only a canonical persisted UTC trade date.  A Daily Range chart must
 * never substitute today's/yesterday's range when its original reference is
 * missing or malformed. */
function utcDateStartMs(dateUtc: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) return null;
  const value = Date.parse(`${dateUtc}T00:00:00.000Z`);
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString().slice(0, 10) === dateUtc ? value : null;
}

/** Canonical choices for the operator allocation selector. Keep this server-owned so newly
 * wired executors do not disappear just because a frontend fallback list was not updated. */
const OPERATOR_ALLOCATION_LANE_IDS = [
  ...LANE_SELECTOR_V2_LIVE_SUPPORTED_VARIANT_IDS.map((variantId) => laneSelectorV2LaneId(variantId)),
  "CROSS_SECTIONAL_MARKET_NEUTRAL",
  "CROSS_SECTIONAL_TREND",
  "CROSS_SECTIONAL_MIXED",
  CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID,
  CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID,
  PROFIT_CORE_SHORT_TRAIL_LANE_ID,
  SF_PAPER_LANE_ID,
  IM_PAPER_LANE_ID,
  RC_PAPER_LANE_ID,
  RCS_PAPER_LANE_ID,
  PWR_PAPER_LANE_ID,
  ...EXECUTABLE_INNOVATION_LANE_IDS,
  ...(["WIDE_LONG", "WIDE_SHORT", "FAST_LONG", "FAST_SHORT"] as CEBucket[]).map(ceLaneIdForBucket),
];

type LiveAccountSnapshot = Awaited<ReturnType<LiveExecutionEngine["getAccountSnapshot"]>>;

type OpenBasketExitPolicy = {
  executionCapHours?: number | null;
  takeProfitEnabled?: boolean;
  stopLossEnabled?: boolean;
  adaptiveExitsEnabled?: boolean;
};

type OpenBasketDeadlineInput = {
  openedAt: string;
  closesAtMs: number;
  /** Dynamic MOM36 persists the actual-fill-based deadline separately for audit clarity. */
  horizonExitAtMs?: number | null;
  policyFingerprint?: { execution?: OpenBasketExitPolicy | null } | null;
};

/**
 * The persisted `closesAtMs` belongs to the research measurement horizon.  The exchange executor
 * can have an earlier, frozen hold cap; surface the same minimum that closeDueBaskets() uses so a
 * report/UI never promises a later close than the engine will actually schedule.
 */
export function scheduledOpenBasketDeadline(
  basket: OpenBasketDeadlineInput,
  legacyExitPolicy: OpenBasketExitPolicy | null | undefined,
): {
  scheduledCloseAtMs: number | null;
  executionCapHours: number | null;
  deadlineSource: "BASKET_POLICY_FINGERPRINT" | "LEGACY_BASKET_CONTRACT" | "MEASUREMENT_HORIZON";
  mayExitEarlier: boolean;
} {
  const hasFingerprint = basket.policyFingerprint?.execution != null;
  const policy = basket.policyFingerprint?.execution ?? legacyExitPolicy ?? null;
  const rawCapHours = policy?.executionCapHours;
  const executionCapHours = typeof rawCapHours === "number" && Number.isFinite(rawCapHours) && rawCapHours > 0
    ? rawCapHours
    : null;
  const openedAtMs = Date.parse(basket.openedAt);
  const cappedCloseAtMs = executionCapHours != null && Number.isFinite(openedAtMs)
    ? openedAtMs + executionCapHours * 3_600_000
    : null;
  const measurementCloseAtMs = Number.isFinite(basket.closesAtMs) ? basket.closesAtMs : null;
  const frozenActualEntryDeadline = typeof basket.horizonExitAtMs === "number" && Number.isFinite(basket.horizonExitAtMs)
    ? basket.horizonExitAtMs
    : null;
  const scheduledCloseAtMs = frozenActualEntryDeadline ?? (cappedCloseAtMs != null && measurementCloseAtMs != null
    ? Math.min(cappedCloseAtMs, measurementCloseAtMs)
    : cappedCloseAtMs ?? measurementCloseAtMs);
  return {
    scheduledCloseAtMs,
    executionCapHours,
    deadlineSource: hasFingerprint
      ? "BASKET_POLICY_FINGERPRINT"
      : policy != null
        ? "LEGACY_BASKET_CONTRACT"
        : "MEASUREMENT_HORIZON",
    mayExitEarlier: Boolean(policy?.takeProfitEnabled || policy?.stopLossEnabled || policy?.adaptiveExitsEnabled),
  };
}

const DASHBOARD_ACCOUNT_CACHE_TTL_MS = 15_000;
const TESTNET_DASHBOARD_ACCOUNT_CACHE_TTL_MS = 30_000;
const DASHBOARD_ACCOUNT_RATE_LIMIT_BACKOFF_MS = 60_000;

/**
 * The dashboard is observability-only. Testnet's private REST path repeatedly hit 418 when a 15s
 * account snapshot ran beside active reconciliation loops, so retain a fresh-enough 30s view there
 * while keeping Live's existing 15s display cadence unchanged. A bounded env override is provided
 * for an incident response, but cannot accidentally turn this into a sub-second poller.
 */
export function resolveDashboardAccountCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.LIVE_DASHBOARD_ACCOUNT_CACHE_TTL_MS ?? "");
  if (Number.isFinite(configured) && configured >= 5_000 && configured <= 5 * 60_000) {
    return Math.floor(configured);
  }
  return env.LIVE_BINANCE_ENV === "testnet"
    ? TESTNET_DASHBOARD_ACCOUNT_CACHE_TTL_MS
    : DASHBOARD_ACCOUNT_CACHE_TTL_MS;
}

/**
 * Account data is observability-only here.  Never feed this cache into entry, exit, reconciliation,
 * or order logic: it exists solely to make several dashboard panels share one verified USD-M
 * account read and to keep displaying an explicitly stale last-good snapshot during a Binance ban.
 */
type DashboardAccountSnapshot = {
  snapshot: LiveAccountSnapshot;
  source: "USD_M_PRIVATE_ACCOUNT" | "USD_M_PRIVATE_CACHE" | "LAST_GOOD_USD_M_PRIVATE_CACHE";
  fetchedAt: string;
  ageMs: number;
  stale: boolean;
  retryAt: string | null;
  lastFailure: string | null;
};

class DashboardAccountSnapshotUnavailableError extends Error {
  readonly retryAt: string | null;
  readonly rateLimited: boolean;

  constructor(message: string, opts: { retryAt?: string | null; rateLimited?: boolean } = {}) {
    super(message);
    this.name = "DashboardAccountSnapshotUnavailableError";
    this.retryAt = opts.retryAt ?? null;
    this.rateLimited = opts.rateLimited ?? false;
  }
}

function isBinanceRateLimit(error: unknown): boolean {
  return error instanceof BinanceFuturesPrivateError && error.failureType === "429";
}

/** Prefer the transport's observed Binance expiry over a dashboard-local guess. */
function rateLimitRetryAfterMs(error: unknown, nowMs: number, fallbackMs: number): number {
  const retryAt = error instanceof BinanceFuturesPrivateError ? Date.parse(error.retryAt ?? "") : Number.NaN;
  return Number.isFinite(retryAt) && retryAt > nowMs ? retryAt : nowMs + fallbackMs;
}

function dashboardAccountFailure(error: unknown, fallback: string): {
  statusCode: 502 | 503;
  body: { ok: false; reason: string; retryAt?: string | null };
} {
  const message = error instanceof Error ? error.message : fallback;
  if (error instanceof DashboardAccountSnapshotUnavailableError) {
    return {
      statusCode: error.rateLimited ? 503 : 502,
      body: { ok: false, reason: message, retryAt: error.retryAt },
    };
  }
  return { statusCode: 502, body: { ok: false, reason: message } };
}

function createDashboardAccountSnapshotReader(
  engine: LiveExecutionEngine,
  options: {
    nowMs?: () => number;
    cacheTtlMs?: number;
    rateLimitBackoffMs?: number;
  } = {},
): () => Promise<DashboardAccountSnapshot> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? resolveDashboardAccountCacheTtlMs();
  const rateLimitBackoffMs = options.rateLimitBackoffMs ?? DASHBOARD_ACCOUNT_RATE_LIMIT_BACKOFF_MS;
  let cache: { snapshot: LiveAccountSnapshot; fetchedAtMs: number } | null = null;
  let retryAfterMs = 0;
  let lastFailure: string | null = null;
  let inFlight: Promise<DashboardAccountSnapshot> | null = null;

  const cached = (
    source: DashboardAccountSnapshot["source"],
    stale: boolean,
  ): DashboardAccountSnapshot => {
    if (!cache) throw new Error("dashboard account cache unexpectedly empty");
    const now = nowMs();
    return {
      snapshot: cache.snapshot,
      source,
      fetchedAt: new Date(cache.fetchedAtMs).toISOString(),
      ageMs: Math.max(0, now - cache.fetchedAtMs),
      stale,
      retryAt: retryAfterMs > now ? new Date(retryAfterMs).toISOString() : null,
      lastFailure,
    };
  };

  return async (): Promise<DashboardAccountSnapshot> => withBinanceTransportSource("dashboard.account", async () => {
    const now = nowMs();
    if (cache && now - cache.fetchedAtMs < cacheTtlMs) {
      return cached("USD_M_PRIVATE_CACHE", false);
    }
    if (retryAfterMs > now) {
      if (cache) return cached("LAST_GOOD_USD_M_PRIVATE_CACHE", true);
      throw new DashboardAccountSnapshotUnavailableError(
        "Binance USD-M account snapshot is cooling down after rate limit",
        { retryAt: new Date(retryAfterMs).toISOString(), rateLimited: true },
      );
    }
    if (inFlight) return inFlight;

    inFlight = (async (): Promise<DashboardAccountSnapshot> => {
      try {
        const snapshot = await engine.getAccountSnapshot();
        cache = { snapshot, fetchedAtMs: nowMs() };
        retryAfterMs = 0;
        lastFailure = null;
        return cached("USD_M_PRIVATE_ACCOUNT", false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "account snapshot failed";
        lastFailure = message;
        if (isBinanceRateLimit(error)) {
          retryAfterMs = Math.max(retryAfterMs, rateLimitRetryAfterMs(error, nowMs(), rateLimitBackoffMs));
        }
        if (cache) return cached("LAST_GOOD_USD_M_PRIVATE_CACHE", true);
        throw new DashboardAccountSnapshotUnavailableError(message, {
          retryAt: retryAfterMs > nowMs() ? new Date(retryAfterMs).toISOString() : null,
          rateLimited: isBinanceRateLimit(error),
        });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  });
}

/** The account route adds report-only executor attribution. Keep that mutation out of the shared
 * dashboard cache, or a second caller inside the TTL would double-count its lane totals. */
function cloneLiveAccountSnapshot(snapshot: LiveAccountSnapshot): LiveAccountSnapshot {
  return {
    ...snapshot,
    positions: snapshot.positions.map((position) => ({ ...position, laneIds: [...position.laneIds] })),
    lanes: snapshot.lanes.map((lane) => ({ ...lane, symbols: [...lane.symbols] })),
    closedLanes: snapshot.closedLanes.map((lane) => ({ ...lane, symbols: [...lane.symbols] })),
  };
}

type CrossSectionalUnrealizedExtrema = {
  grossHighUsd: number;
  grossLowUsd: number;
  afterEstimatedCloseCostHighUsd: number;
  afterEstimatedCloseCostLowUsd: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
  closedAt?: string;
  /** Keyed by side+symbol because a symbol may legally appear on both sides in different legs. */
  legs?: Record<string, CrossSectionalLegUnrealizedExtrema>;
};

type CrossSectionalLegUnrealizedExtrema = {
  grossHighUsd: number;
  grossLowUsd: number;
  afterEstimatedCloseCostHighUsd: number;
  afterEstimatedCloseCostLowUsd: number;
  /** Basket open time: the known zero-P&L baseline for this leg. */
  entryAt: string;
  firstRecordedAt: string;
  lastRecordedAt: string;
  closedAt?: string;
};

type CrossSectionalUnrealizedExtremaStore = {
  version: 1;
  baskets: Record<string, CrossSectionalUnrealizedExtrema>;
};

function crossSectionalUnrealizedExtremaFile(): string {
  return resolve(process.cwd(), process.env.CROSS_SECTIONAL_UNREALIZED_EXTREMA_FILE ?? "data/cross-sectional-unrealized-extrema.json");
}

function readCrossSectionalUnrealizedExtremaStore(): CrossSectionalUnrealizedExtremaStore {
  const file = crossSectionalUnrealizedExtremaFile();
  try {
    if (!existsSync(file)) return { version: 1, baskets: {} };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CrossSectionalUnrealizedExtremaStore>;
    return parsed.version === 1 && parsed.baskets && typeof parsed.baskets === "object"
      ? { version: 1, baskets: parsed.baskets }
      : { version: 1, baskets: {} };
  } catch {
    return { version: 1, baskets: {} };
  }
}

function writeCrossSectionalUnrealizedExtremaStore(store: CrossSectionalUnrealizedExtremaStore): void {
  const file = crossSectionalUnrealizedExtremaFile();
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2));
  renameSync(temp, file);
}

/** Presentation-only baseline for a fresh testnet evaluation era. The carried
 * XRP position remains visible and managed; only its pre-reset P&L is excluded
 * from the new-era headline. */
type TestnetPnlEra = {
  version: 1;
  startedAt: string;
  carriedDirectionalUnrealizedUsd: number;
  carriedSymbols: string[];
};

function testnetPnlEraFile(): string {
  return resolve(process.cwd(), process.env.TESTNET_PNL_ERA_FILE ?? "data/testnet-pnl-era.json");
}

function readTestnetPnlEra(): TestnetPnlEra | null {
  try {
    const parsed = JSON.parse(readFileSync(testnetPnlEraFile(), "utf8")) as Partial<TestnetPnlEra>;
    return parsed.version === 1 && typeof parsed.startedAt === "string" &&
      typeof parsed.carriedDirectionalUnrealizedUsd === "number" && Array.isArray(parsed.carriedSymbols)
      ? {
        version: 1,
        startedAt: parsed.startedAt,
        carriedDirectionalUnrealizedUsd: parsed.carriedDirectionalUnrealizedUsd,
        carriedSymbols: parsed.carriedSymbols.map(String),
      }
      : null;
  } catch {
    return null;
  }
}

function recordCrossSectionalUnrealizedExtrema(
  samples: Array<{
    basketId: string;
    grossUsd: number;
    afterEstimatedCloseCostUsd: number;
    legs: Array<{
      symbol: string;
      side: "LONG" | "SHORT";
      grossUsd: number;
      afterEstimatedCloseCostUsd: number;
      /** Closing this leg immediately at its entry price already costs money. */
      entryAfterEstimatedCloseCostUsd: number;
      entryAt: string;
    }>;
  }>,
  closed: Array<{ basketId: string; closedAt: string }>,
  nowIso: string,
): Record<string, CrossSectionalUnrealizedExtrema> {
  const store = readCrossSectionalUnrealizedExtremaStore();
  let changed = false;
  for (const sample of samples) {
    if (!Number.isFinite(sample.grossUsd) || !Number.isFinite(sample.afterEstimatedCloseCostUsd)) continue;
    const previous = store.baskets[sample.basketId];
    const basket = previous
      ? {
        ...previous,
        grossHighUsd: Math.max(previous.grossHighUsd, sample.grossUsd),
        grossLowUsd: Math.min(previous.grossLowUsd, sample.grossUsd),
        afterEstimatedCloseCostHighUsd: Math.max(previous.afterEstimatedCloseCostHighUsd, sample.afterEstimatedCloseCostUsd),
        afterEstimatedCloseCostLowUsd: Math.min(previous.afterEstimatedCloseCostLowUsd, sample.afterEstimatedCloseCostUsd),
        lastRecordedAt: nowIso,
      }
      : {
        grossHighUsd: sample.grossUsd,
        grossLowUsd: sample.grossUsd,
        afterEstimatedCloseCostHighUsd: sample.afterEstimatedCloseCostUsd,
        afterEstimatedCloseCostLowUsd: sample.afterEstimatedCloseCostUsd,
        firstRecordedAt: nowIso,
        lastRecordedAt: nowIso,
      };
    const legs = { ...(previous?.legs ?? {}) };
    for (const leg of sample.legs) {
      if (!Number.isFinite(leg.grossUsd) || !Number.isFinite(leg.afterEstimatedCloseCostUsd)) continue;
      const key = `${leg.side}:${leg.symbol}`;
      const priorLeg = legs[key];
      // Gross P&L is exactly zero at entry. Net-after-close-cost is NOT: closing immediately
      // incurs the estimated close cost. Do not give the after-cost path a fictional zero baseline.
      const entryAfterCost = Number.isFinite(leg.entryAfterEstimatedCloseCostUsd)
        ? leg.entryAfterEstimatedCloseCostUsd
        : leg.afterEstimatedCloseCostUsd;
      // Older records incorrectly clamped the after-cost baseline to zero. A zero high/low on a
      // leg with a negative entry-after-cost is therefore migrated to the honest entry baseline.
      const previousAfterHigh = priorLeg?.afterEstimatedCloseCostHighUsd === 0 && entryAfterCost < 0
        ? entryAfterCost
        : priorLeg?.afterEstimatedCloseCostHighUsd;
      const previousAfterLow = priorLeg?.afterEstimatedCloseCostLowUsd === 0 && entryAfterCost < 0
        ? entryAfterCost
        : priorLeg?.afterEstimatedCloseCostLowUsd;
      legs[key] = priorLeg
        ? {
          ...priorLeg,
          grossHighUsd: Math.max(priorLeg.grossHighUsd, leg.grossUsd),
          grossLowUsd: Math.min(priorLeg.grossLowUsd, leg.grossUsd),
          afterEstimatedCloseCostHighUsd: Math.max(previousAfterHigh ?? entryAfterCost, leg.afterEstimatedCloseCostUsd),
          afterEstimatedCloseCostLowUsd: Math.min(previousAfterLow ?? entryAfterCost, leg.afterEstimatedCloseCostUsd),
          lastRecordedAt: nowIso,
        }
        : {
          grossHighUsd: Math.max(0, leg.grossUsd),
          grossLowUsd: Math.min(0, leg.grossUsd),
          afterEstimatedCloseCostHighUsd: Math.max(entryAfterCost, leg.afterEstimatedCloseCostUsd),
          afterEstimatedCloseCostLowUsd: Math.min(entryAfterCost, leg.afterEstimatedCloseCostUsd),
          entryAt: leg.entryAt,
          firstRecordedAt: nowIso,
          lastRecordedAt: nowIso,
        };
    }
    store.baskets[sample.basketId] = { ...basket, legs };
    changed = true;
  }
  for (const basket of closed) {
    const previous = store.baskets[basket.basketId];
    if (previous && previous.closedAt !== basket.closedAt) {
      store.baskets[basket.basketId] = {
        ...previous,
        closedAt: basket.closedAt,
        legs: Object.fromEntries(Object.entries(previous.legs ?? {}).map(([key, leg]) => [key, { ...leg, closedAt: basket.closedAt }])),
      };
      changed = true;
    }
  }
  if (changed) writeCrossSectionalUnrealizedExtremaStore(store);
  return store.baskets;
}

export function annotateCrossSectionalAccount(
  snapshot: LiveAccountSnapshot,
  executor: CrossSectionalExecutor | null,
): LiveAccountSnapshot {
  if (!executor) return snapshot;
  // 2026-07-08: generalized from the single hardcoded market-neutral lane id so the SAME function
  // annotates any of the (now multiple) executor instances — each instance reports its own laneId
  // via getStatus(), so calling this once per instance (app.ts's registerLiveRoutes wiring) merges
  // all of them into the one account snapshot without duplicating this logic per variant.
  const laneId = executor.getStatus().laneId;

  // Closed baskets: the engine's realized ledger deliberately excludes executor positions (they
  // are external-managed claims, not engine intents), so banked basket P&L must be merged into
  // closedLanes here — otherwise every realized display stays flat while the actual wallet
  // balance moves (2026-07-07 operator: "+1.45 banked, kok realized ga nambah??").
  const closedSummary = executor.getClosedSummary();
  if (closedSummary.closedCount > 0) {
    const existingClosed = snapshot.closedLanes.find((lane) => lane.laneId === laneId);
    if (existingClosed) {
      existingClosed.closedCount += closedSummary.closedCount;
      existingClosed.wins += closedSummary.wins;
      existingClosed.losses += closedSummary.losses;
      existingClosed.realizedPnlUsd += closedSummary.realizedPnlUsd;
      existingClosed.feesUsd += closedSummary.feesUsd;
      existingClosed.symbols = Array.from(new Set([...existingClosed.symbols, ...closedSummary.symbols])).sort();
      if (closedSummary.lastClosedAt && (!existingClosed.lastClosedAt || closedSummary.lastClosedAt > existingClosed.lastClosedAt)) {
        existingClosed.lastClosedAt = closedSummary.lastClosedAt;
      }
    } else {
      snapshot.closedLanes.push({
        laneId,
        closedCount: closedSummary.closedCount,
        wins: closedSummary.wins,
        losses: closedSummary.losses,
        realizedPnlUsd: closedSummary.realizedPnlUsd,
        feesUsd: closedSummary.feesUsd,
        symbols: closedSummary.symbols,
        lastClosedAt: closedSummary.lastClosedAt,
      });
    }
  }

  // ALL open baskets, not just the first — MAX_OPEN_BASKETS can exceed 1 (testnet runs 4), and
  // Binance nets same-symbol legs from different baskets into one account-level position. Only
  // attributing the first basket left every OTHER basket's real exchange positions silently
  // unattributed on the dashboard (2026-07-07: confirmed on testnet — 4 concurrent baskets, only
  // one basket's symbols got tagged, the rest showed "unattributed").
  const openBaskets = executor.getStatus().openBaskets;
  if (openBaskets.length === 0) return snapshot;

  const laneRow = {
    laneId,
    sourceOrderCount: 0,
    symbols: new Set<string>(),
    notionalUsd: 0,
    unrealizedPnl: 0,
  };

  for (const openBasket of openBaskets) {
    for (const leg of openBasket.legs) {
      if (leg.exitOrderId !== null) continue;
      // Match by SYMBOL (not symbol+direction): with a directional intent on the same symbol the
      // NETTED row's direction can differ from the leg's side, and the basket share must still be
      // attributed (2026-07-08 operator: "pisahkan unrealized antara cross sectional dan directional").
      const row = snapshot.positions.find((position) => position.symbol === leg.symbol);
      if (!row) continue;

      const positionQty = Number(row.quantity);
      const share = Number.isFinite(positionQty) && positionQty > 0 ? Math.min(1, leg.qty / positionQty) : 1;
      row.sourceOrderCount += 1;
      if (!row.laneIds.includes(laneId)) {
        row.laneIds.push(laneId);
      }
      // The basket's OWN P&L for this leg, from ITS entry price — never the exchange's blended
      // average entry of the netted position.
      const legDir = leg.side === "LONG" ? 1 : -1;
      const legUnrealized = row.markPrice !== null && leg.entryPrice > 0 ? (row.markPrice - leg.entryPrice) * leg.qty * legDir : null;
      row.basketQty = (row.basketQty ?? 0) + leg.qty * legDir;
      if (legUnrealized !== null) row.basketUnrealizedPnl = (row.basketUnrealizedPnl ?? 0) + legUnrealized;
      laneRow.sourceOrderCount += 1;
      laneRow.symbols.add(row.symbol);
      laneRow.notionalUsd += Math.abs(leg.qty * leg.entryPrice);
      laneRow.unrealizedPnl += legUnrealized ?? row.unrealizedPnl * share;
    }
  }

  if (laneRow.sourceOrderCount > 0) {
    const existing = snapshot.lanes.find((lane) => lane.laneId === laneId);
    if (existing) {
      existing.sourceOrderCount += laneRow.sourceOrderCount;
      existing.symbols = Array.from(new Set([...existing.symbols, ...laneRow.symbols])).sort();
      existing.notionalUsd += laneRow.notionalUsd;
      existing.unrealizedPnl += laneRow.unrealizedPnl;
    } else {
      snapshot.lanes.push({
        laneId,
        sourceOrderCount: laneRow.sourceOrderCount,
        symbols: Array.from(laneRow.symbols).sort(),
        notionalUsd: laneRow.notionalUsd,
        unrealizedPnl: laneRow.unrealizedPnl,
      });
      snapshot.lanes.sort((left, right) => left.laneId.localeCompare(right.laneId));
    }
  }

  return snapshot;
}

type LiveLaneSeriesReport = ReturnType<LiveExecutionEngine["getLanePerformanceSeries"]>;

/** Merge the cross-sectional executor's CLOSED baskets into the lane-performance timeline as
 *  their own lane. Same rationale as annotateCrossSectionalAccount: basket P&L never passes
 *  through engine intents, so without this the timeline shows a flat foundation lane while the
 *  wallet moves. Baskets carry no regime tag (market-neutral by design), so they are merged only
 *  into the unfiltered ("all") view — a regime-filtered view must not include unclassifiable P&L. */
export function mergeCrossSectionalIntoLaneSeries(
  report: LiveLaneSeriesReport,
  executor: CrossSectionalExecutor | null,
): LiveLaneSeriesReport {
  if (!executor || report.regimeFilter !== "all") return report;
  // 2026-07-08: generalized to executor.getStatus().laneId (see annotateCrossSectionalAccount
  // above) so this same function merges any of the (now multiple) executor instances' closed
  // baskets, called once per instance.
  const laneId = executor.getStatus().laneId;
  const sinceMs = new Date(report.since).getTime();
  const untilMs = new Date(report.until).getTime();
  const bucketStartsMs = report.bucketStarts.map((s) => new Date(s).getTime());

  const perBucket = new Map<string, { realizedPnlUsd: number; closedCount: number; wins: number; losses: number }>();
  let realizedPnlUsd = 0;
  let feesUsd = 0;
  let wins = 0;
  let losses = 0;
  let closedCount = 0;
  const symbols = new Set<string>();
  for (const basket of executor.getClosedBaskets()) {
    if (!basket.closedAt || basket.netPnlUsd === null || basket.accountingStatus === "ACCOUNTING_INCOMPLETE") continue;
    const closedMs = new Date(basket.closedAt).getTime();
    if (!Number.isFinite(closedMs) || closedMs < sinceMs || closedMs >= untilMs) continue;
    // Greatest bucket start <= closedAt (bucket lengths vary across views, e.g. monthly).
    let bucketIdx = -1;
    for (let i = 0; i < bucketStartsMs.length; i += 1) {
      if (bucketStartsMs[i]! <= closedMs) bucketIdx = i;
      else break;
    }
    if (bucketIdx < 0) continue;
    const key = report.bucketStarts[bucketIdx]!;
    const bucket = perBucket.get(key) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
    bucket.realizedPnlUsd += basket.netPnlUsd;
    bucket.closedCount += 1;
    if (basket.netPnlUsd > 0) bucket.wins += 1;
    if (basket.netPnlUsd < 0) bucket.losses += 1;
    perBucket.set(key, bucket);
    realizedPnlUsd += basket.netPnlUsd;
    feesUsd += basket.feeEstimateUsd ?? 0;
    closedCount += 1;
    if (basket.netPnlUsd > 0) wins += 1;
    if (basket.netPnlUsd < 0) losses += 1;
    for (const leg of basket.legs) symbols.add(leg.symbol);
  }
  if (closedCount === 0) return report;

  const existing = report.lanes.find((lane) => lane.laneId === laneId);
  if (existing) {
    // An engine intent tagged with the same lane id would be rare, but merge pointwise instead of
    // pushing a duplicate laneId the chart would render twice.
    existing.realizedPnlUsd += realizedPnlUsd;
    existing.feesUsd += feesUsd;
    existing.closedCount += closedCount;
    existing.wins += wins;
    existing.losses += losses;
    existing.winRatePct = existing.closedCount > 0 ? (existing.wins / existing.closedCount) * 100 : null;
    existing.symbols = Array.from(new Set([...existing.symbols, ...symbols])).sort();
    let cumulative = 0;
    for (const point of existing.points) {
      const add = perBucket.get(point.bucketStart);
      if (add) {
        point.realizedPnlUsd += add.realizedPnlUsd;
        point.closedCount += add.closedCount;
        point.wins += add.wins;
        point.losses += add.losses;
      }
      cumulative += point.realizedPnlUsd;
      point.cumulativePnlUsd = cumulative;
    }
  } else {
    let cumulative = 0;
    const points = report.bucketStarts.map((bucketStart) => {
      const bucket = perBucket.get(bucketStart) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
      cumulative += bucket.realizedPnlUsd;
      return { bucketStart, ...bucket, cumulativePnlUsd: cumulative };
    });
    report.lanes.push({
      laneId,
      realizedPnlUsd,
      feesUsd,
      closedCount,
      wins,
      losses,
      winRatePct: closedCount > 0 ? (wins / closedCount) * 100 : null,
      symbols: Array.from(symbols).sort(),
      regimes: [],
      points,
    });
  }
  report.lanes.sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd));
  return report;
}

export type SingleSymbolLanePositionRow = {
  laneId: string;
  positionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  stopPrice: number;
  /** Frozen signal target when this lane opened with a fixed TP. Null means the
   *  lane is managed by its dynamic exit policy, not that a target fetch failed. */
  targetPrice: number | null;
  /** Direction-aware distance from the current mark to a frozen fixed target. */
  targetTpGapPct: number | null;
  /** Whether TP columns represent a fixed exchange target, MFE profit lock, or no target. */
  targetMode: "FIXED" | "MFE_PROFIT_LOCK" | "DYNAMIC";
  /** Active directional MFE lock, calculated from entry + configured estimated close cost. */
  mfeProfitLockPrice: number | null;
  mfeProfitLockGapPct: number | null;
  mfeProfitLockNetReturn: number | null;
  /** Informational maximum for future static defaults; it is never a live TP by itself. */
  staticTpMaxNetReturn: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  /** Exchange leverage for this bound lane position. Never guess from config. */
  leverage: number | null;
  /** Pro-rata share of the exchange position's current estimated close cost.
   *  Null when the lane cannot be safely bound to the exchange position. */
  estimatedCloseCostUsd: number | null;
  unrealizedAfterEstimatedCloseCostUsd: number | null;
  peakFavorableR: number;
  openedAt: string;
};

type SingleSymbolExchangePositionContext = Pick<
  LiveAccountSnapshot["positions"][number],
  "direction" | "quantity" | "markPrice" | "leverage" | "estimatedCloseCostUsd"
>;

/** One row per lane's OWN open position (2026-07-10: operator wants to inspect/close each lane's
 *  position on a symbol independently — two lanes holding the same symbol net into one exchange
 *  position but can have very different track records/protection, e.g. a proven-ish
 *  trailing-protected lane vs an unproven fixed-target lane with none). Unlike
 *  annotateSingleSymbolAccount (which sums across lanes into the netted-position view), this never
 *  aggregates — every open SingleSymbolPosition across every executor gets its own row. */
export function flattenSingleSymbolPositions(
  executors: SingleSymbolLaneExecutor[],
  exchangeBySymbol: Map<string, SingleSymbolExchangePositionContext>,
): SingleSymbolLanePositionRow[] {
  const tracked = executors.flatMap((exec) => {
    const laneId = exec.getStatus().laneId;
    return exec.getStatus().openPositions.map((position) => ({ laneId, position }));
  });

  // A symbol can be shared by several same-side lane claims. Cost allocation is
  // only reportable when their durable quantities fit inside the exchange-side
  // net position; otherwise rendering a pro-rata fee would fabricate attribution.
  const trackedQtyBySymbolSide = new Map<string, number>();
  for (const { position } of tracked) {
    const key = `${position.symbol}:${position.direction}`;
    trackedQtyBySymbolSide.set(key, (trackedQtyBySymbolSide.get(key) ?? 0) + Math.abs(position.qty));
  }

  return tracked.map(({ laneId, position: p }) => {
    const exchange = exchangeBySymbol.get(p.symbol) ?? null;
    const markPrice = exchange?.markPrice ?? null;
    const dir = p.direction === "LONG" ? 1 : -1;
    const unrealizedPnl = markPrice !== null ? (markPrice - p.entryPrice) * p.qty * dir : null;
    const exchangeQty = Math.abs(Number(exchange?.quantity ?? 0));
    const trackedQty = trackedQtyBySymbolSide.get(`${p.symbol}:${p.direction}`) ?? 0;
    const safelyBound =
      exchange?.direction === p.direction &&
      Number.isFinite(exchangeQty) &&
      exchangeQty > 0 &&
      trackedQty <= exchangeQty + 1e-8;
    const costShare = safelyBound ? Math.min(1, Math.abs(p.qty) / exchangeQty) : null;
    const estimatedCloseCostUsd =
      costShare !== null && Number.isFinite(exchange?.estimatedCloseCostUsd)
        ? exchange!.estimatedCloseCostUsd * costShare
        : null;
    const targetPrice = typeof p.targetPrice === "number" && Number.isFinite(p.targetPrice) && p.targetPrice > 0
      ? p.targetPrice
      : null;
    const targetTpGapPct =
      targetPrice !== null && markPrice !== null && markPrice > 0
        ? ((targetPrice - markPrice) / markPrice) * dir * 100
        : null;
    const directionalMfe = laneId === CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID || laneId === CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID;
    const mfeProfitLockNetReturn = directionalMfe && targetPrice === null
      ? DIRECTIONAL_REGIME_MFE_PROFIT_LOCK_NET_RETURN()
      : null;
    const estimatedCloseCostPctRaw = Number(process.env.LIVE_ESTIMATED_CLOSE_COST_PCT);
    const estimatedCloseCostPct = Number.isFinite(estimatedCloseCostPctRaw) && estimatedCloseCostPctRaw >= 0
      ? estimatedCloseCostPctRaw
      : 0.0022;
    const mfeProfitLockPrice = mfeProfitLockNetReturn !== null && p.entryPrice > 0
      ? p.entryPrice * (dir === 1
        ? 1 + mfeProfitLockNetReturn + estimatedCloseCostPct
        : 1 - mfeProfitLockNetReturn - estimatedCloseCostPct)
      : null;
    const mfeProfitLockGapPct =
      mfeProfitLockPrice !== null && markPrice !== null && markPrice > 0
        ? ((mfeProfitLockPrice - markPrice) / markPrice) * dir * 100
        : null;
    return {
      laneId,
      positionId: p.positionId,
      symbol: p.symbol,
      direction: p.direction,
      qty: p.qty,
      entryPrice: p.entryPrice,
      stopPrice: p.stopPrice,
      targetPrice,
      targetTpGapPct,
      targetMode: targetPrice !== null ? "FIXED" : mfeProfitLockPrice !== null ? "MFE_PROFIT_LOCK" : "DYNAMIC",
      mfeProfitLockPrice,
      mfeProfitLockGapPct,
      mfeProfitLockNetReturn,
      staticTpMaxNetReturn: directionalMfe ? DIRECTIONAL_REGIME_STATIC_TP_MAX_NET_RETURN() : null,
      markPrice,
      unrealizedPnl,
      leverage: safelyBound && Number.isFinite(exchange?.leverage) ? exchange!.leverage : null,
      estimatedCloseCostUsd,
      unrealizedAfterEstimatedCloseCostUsd:
        unrealizedPnl !== null && estimatedCloseCostUsd !== null ? unrealizedPnl - estimatedCloseCostUsd : null,
      peakFavorableR: p.peakFavorableR,
      openedAt: p.openedAt,
    };
  });
}

type MeasuredLaneStats = { resolvedCount: number; openCount: number; netAvgR: number | null; wr: number | null; pf: number | null; edgeReady: boolean };
type SingleSymbolExecutorStatus = ReturnType<SingleSymbolLaneExecutor["getStatus"]>;
export type LaneEvaluationRow = {
  laneId: string;
  allocationWeightPct: number;
  allowed: boolean | null;
  realOpenCount: number;
  realClosedCount: number;
  realNetPnlUsd: number;
  measuredResolvedCount: number | null;
  measuredOpenCount: number | null;
  measuredNetAvgR: number | null;
  measuredWr: number | null;
  measuredPf: number | null;
  measuredEdgeReady: boolean | null;
};

/** Pulls each lane's OWN paper/shadow report over its OWN store — the exact same numbers
 *  /api/shadow/*-report already show, just gathered in one place for the evaluation panel below. */
export function buildMeasuredLaneStats(): Map<string, MeasuredLaneStats> {
  const byLane = new Map<string, MeasuredLaneStats>();
  const sf = buildShortFadeReport(getShortFadeStore().all);
  byLane.set(SF_PAPER_LANE_ID, { resolvedCount: sf.resolvedCount, openCount: sf.openCount, netAvgR: sf.netAvgR, wr: sf.wr, pf: sf.pf, edgeReady: sf.edgeReady });
  const im = buildIntradayMomentumReport(getIntradayMomentumStore().all);
  byLane.set(IM_PAPER_LANE_ID, { resolvedCount: im.resolvedCount, openCount: im.openCount, netAvgR: im.netAvgR, wr: im.wr, pf: im.pf, edgeReady: im.edgeReady });
  const rc = buildRegimeCompositeReport(getRegimeCompositeStore().all);
  byLane.set(RC_PAPER_LANE_ID, { resolvedCount: rc.resolvedCount, openCount: rc.openCount, netAvgR: rc.netAvgR, wr: rc.wr, pf: rc.pf, edgeReady: rc.edgeReady });
  const rcs = buildRegimeCompositeShortReport(getRegimeCompositeShortStore().all);
  byLane.set(RCS_PAPER_LANE_ID, { resolvedCount: rcs.resolvedCount, openCount: rcs.openCount, netAvgR: rcs.netAvgR, wr: rcs.wr, pf: rcs.pf, edgeReady: rcs.edgeReady });
  const pwr = buildPanicWashoutReport(getPanicWashoutStore().all);
  byLane.set(PWR_PAPER_LANE_ID, { resolvedCount: pwr.resolvedCount, openCount: pwr.openCount, netAvgR: pwr.netAvgR, wr: pwr.wr, pf: pwr.pf, edgeReady: pwr.edgeReady });
  const ce = buildCompositeEstimatorReport(getCompositeEstimatorStore().all);
  for (const bucket of ce.buckets) {
    byLane.set(ceLaneIdForBucket(bucket.bucket as CEBucket), {
      resolvedCount: bucket.resolvedCount,
      openCount: bucket.openCount,
      netAvgR: bucket.netAvgR,
      wr: bucket.wr,
      pf: bucket.pf,
      edgeReady: bucket.edgeReady,
    });
  }
  return byLane;
}

/** Evaluation section for the lanes being validated on testnet (2026-07-10 operator ask): one row
 *  per lane merging (a) the paper/shadow measurement side (buildMeasuredLaneStats above) and (b)
 *  the real testnet-money execution side — openCount/closedCount/netPnlUsd from the
 *  SingleSymbolLaneExecutor's own getStatus(), plus the lane's current allocation weight/allowed
 *  state. PROFIT_CORE_SHORT_TRAIL has no paper/shadow report (it rides the plain paper->live
 *  mirror, not a SingleSymbolLaneExecutor) — its real side comes from the account snapshot's
 *  closedLanes instead, and its measurement fields are null (honestly, not fabricated 0s — there
 *  is no such report to read for it). */
export function buildLaneEvaluationRows(
  execStatuses: SingleSymbolExecutorStatus[],
  measuredByLane: Map<string, MeasuredLaneStats>,
  profitCoreClosedLane: { closedCount: number; realizedPnlUsd: number } | null,
  fallbackWeightPct: (laneId: string) => number,
): LaneEvaluationRow[] {
  const execByLane = new Map(execStatuses.map((s) => [s.laneId, s]));
  const laneIds = [PROFIT_CORE_SHORT_TRAIL_LANE_ID, ...execStatuses.map((s) => s.laneId)];
  return laneIds.map((laneId) => {
    const exec = execByLane.get(laneId) ?? null;
    const measured = measuredByLane.get(laneId) ?? null;
    return {
      laneId,
      allocationWeightPct: exec?.allocationWeightPct ?? fallbackWeightPct(laneId),
      allowed: exec?.allowed ?? null,
      realOpenCount: exec?.openPositions.length ?? 0,
      realClosedCount: exec?.closedCount ?? profitCoreClosedLane?.closedCount ?? 0,
      realNetPnlUsd: exec?.totalNetPnlUsd ?? profitCoreClosedLane?.realizedPnlUsd ?? 0,
      measuredResolvedCount: measured?.resolvedCount ?? null,
      measuredOpenCount: measured?.openCount ?? null,
      measuredNetAvgR: measured?.netAvgR ?? null,
      measuredWr: measured?.wr ?? null,
      measuredPf: measured?.pf ?? null,
      measuredEdgeReady: measured?.edgeReady ?? null,
    };
  });
}

/** Single-symbol-executor analog of annotateCrossSectionalAccount above — same rationale (a
 *  position opened by SHORT_FADE_EXHAUSTION/INTRADAY_MOMENTUM_BREAKOUT is NOT an engine intent, so
 *  without this its real fill would show up as an "unattributed" exchange position and its banked
 *  P&L would never move the account snapshot's realized figures). Simpler than the basket version:
 *  one leg per position, no multi-basket accumulation needed. */
export function annotateSingleSymbolAccount(
  snapshot: LiveAccountSnapshot,
  executor: SingleSymbolLaneExecutor | null,
): LiveAccountSnapshot {
  if (!executor) return snapshot;
  const status = executor.getStatus();
  const laneId = status.laneId;

  const closedSummary = executor.getClosedSummary();
  if (closedSummary.closedCount > 0) {
    const existingClosed = snapshot.closedLanes.find((lane) => lane.laneId === laneId);
    if (existingClosed) {
      existingClosed.closedCount += closedSummary.closedCount;
      existingClosed.wins += closedSummary.wins;
      existingClosed.losses += closedSummary.losses;
      existingClosed.realizedPnlUsd += closedSummary.realizedPnlUsd;
      existingClosed.feesUsd += closedSummary.feesUsd;
      existingClosed.symbols = Array.from(new Set([...existingClosed.symbols, ...closedSummary.symbols])).sort();
      if (closedSummary.lastClosedAt && (!existingClosed.lastClosedAt || closedSummary.lastClosedAt > existingClosed.lastClosedAt)) {
        existingClosed.lastClosedAt = closedSummary.lastClosedAt;
      }
    } else {
      snapshot.closedLanes.push({
        laneId,
        closedCount: closedSummary.closedCount,
        wins: closedSummary.wins,
        losses: closedSummary.losses,
        realizedPnlUsd: closedSummary.realizedPnlUsd,
        feesUsd: closedSummary.feesUsd,
        symbols: closedSummary.symbols,
        lastClosedAt: closedSummary.lastClosedAt,
      });
    }
  }

  const openPositions = status.openPositions;
  if (openPositions.length === 0) return snapshot;

  const laneRow = { laneId, sourceOrderCount: 0, symbols: new Set<string>(), notionalUsd: 0, unrealizedPnl: 0 };
  for (const pos of openPositions) {
    const row = snapshot.positions.find((position) => position.symbol === pos.symbol);
    if (!row) continue;
    const positionQty = Number(row.quantity);
    const share = Number.isFinite(positionQty) && positionQty > 0 ? Math.min(1, pos.qty / positionQty) : 1;
    row.sourceOrderCount += 1;
    if (!row.laneIds.includes(laneId)) row.laneIds.push(laneId);
    const dir = pos.direction === "LONG" ? 1 : -1;
    const legUnrealized = row.markPrice !== null && pos.entryPrice > 0 ? (row.markPrice - pos.entryPrice) * pos.qty * dir : null;
    row.basketQty = (row.basketQty ?? 0) + pos.qty * dir;
    if (legUnrealized !== null) row.basketUnrealizedPnl = (row.basketUnrealizedPnl ?? 0) + legUnrealized;
    // Real exchange-side protective stop — NOT an engine TP1, never conflate with targetTpPrice
    // (2026-07-09 audit finding: the dashboard was rendering this book type's TP columns as if it
    // were a basket, with no way to show the stop it's ACTUALLY protected by).
    row.singleSymbolStopPrice = pos.stopPrice;
    laneRow.sourceOrderCount += 1;
    laneRow.symbols.add(row.symbol);
    laneRow.notionalUsd += Math.abs(pos.qty * pos.entryPrice);
    laneRow.unrealizedPnl += legUnrealized ?? row.unrealizedPnl * share;
  }

  if (laneRow.sourceOrderCount > 0) {
    const existing = snapshot.lanes.find((lane) => lane.laneId === laneId);
    if (existing) {
      existing.sourceOrderCount += laneRow.sourceOrderCount;
      existing.symbols = Array.from(new Set([...existing.symbols, ...laneRow.symbols])).sort();
      existing.notionalUsd += laneRow.notionalUsd;
      existing.unrealizedPnl += laneRow.unrealizedPnl;
    } else {
      snapshot.lanes.push({
        laneId,
        sourceOrderCount: laneRow.sourceOrderCount,
        symbols: Array.from(laneRow.symbols).sort(),
        notionalUsd: laneRow.notionalUsd,
        unrealizedPnl: laneRow.unrealizedPnl,
      });
      snapshot.lanes.sort((left, right) => left.laneId.localeCompare(right.laneId));
    }
  }
  return snapshot;
}

/**
 * Daily-range trades do not pass through LiveExecutionEngine intents or a
 * SingleSymbolLaneExecutor. Their ownership is nonetheless durable and exact:
 * accept it only when the exchange row has the same symbol, side, and quantity.
 * A mismatch intentionally remains unattributed so the existing fail-closed
 * reconciliation alarm stays visible instead of relabelling foreign exposure.
 */
export function annotateDailyRangeAccount(
  snapshot: LiveAccountSnapshot,
  lane: DailyRangeAcceptanceLane | null,
): LiveAccountSnapshot {
  if (!lane) return snapshot;
  const claims = lane.getOpenPositionClaims();
  if (claims.length === 0) return snapshot;

  const laneRow = { laneId: DAILY_RANGE_LANE_ID, sourceOrderCount: 0, symbols: new Set<string>(), notionalUsd: 0, unrealizedPnl: 0 };
  for (const claim of claims) {
    const row = snapshot.positions.find((position) => position.symbol === claim.symbol);
    if (!row || row.direction !== claim.direction) continue;
    const quantityTolerance = Math.max(1e-9, claim.qty * 1e-6);
    if (Math.abs(row.quantity - claim.qty) > quantityTolerance) continue;

    row.sourceOrderCount += 1;
    if (!row.laneIds.includes(DAILY_RANGE_LANE_ID)) row.laneIds.push(DAILY_RANGE_LANE_ID);
    const direction = claim.direction === "LONG" ? 1 : -1;
    const unrealized = row.markPrice !== null
      ? (row.markPrice - claim.entryPrice) * claim.qty * direction
      : null;
    row.dailyRangeTradeId = claim.tradeId;
    row.dailyRangeQty = claim.qty * direction;
    row.dailyRangeEntryPrice = claim.entryPrice;
    row.dailyRangeUnrealizedPnl = unrealized;
    row.dailyRangeStopPrice = claim.stopPrice;
    row.dailyRangeTakeProfitPrice = claim.takeProfitPrice;
    row.dailyRangeOpenedAt = claim.openedAt;
    row.dailyRangeStatus = claim.status;
    row.dailyRangeLastReconcileError = claim.lastReconcileError;

    laneRow.sourceOrderCount += 1;
    laneRow.symbols.add(claim.symbol);
    laneRow.notionalUsd += Math.abs(claim.qty * claim.entryPrice);
    laneRow.unrealizedPnl += unrealized ?? row.unrealizedPnl;
  }

  if (laneRow.sourceOrderCount > 0) {
    const existing = snapshot.lanes.find((row) => row.laneId === DAILY_RANGE_LANE_ID);
    if (existing) {
      existing.sourceOrderCount += laneRow.sourceOrderCount;
      existing.symbols = Array.from(new Set([...existing.symbols, ...laneRow.symbols])).sort();
      existing.notionalUsd += laneRow.notionalUsd;
      existing.unrealizedPnl += laneRow.unrealizedPnl;
    } else {
      snapshot.lanes.push({
        laneId: DAILY_RANGE_LANE_ID,
        sourceOrderCount: laneRow.sourceOrderCount,
        symbols: Array.from(laneRow.symbols).sort(),
        notionalUsd: laneRow.notionalUsd,
        unrealizedPnl: laneRow.unrealizedPnl,
      });
      snapshot.lanes.sort((left, right) => left.laneId.localeCompare(right.laneId));
    }
  }
  return snapshot;
}

/** Single-symbol-executor analog of mergeCrossSectionalIntoLaneSeries above. */
export function mergeSingleSymbolIntoLaneSeries(
  report: LiveLaneSeriesReport,
  executor: SingleSymbolLaneExecutor | null,
): LiveLaneSeriesReport {
  if (!executor || report.regimeFilter !== "all") return report;
  const laneId = executor.getStatus().laneId;
  const sinceMs = new Date(report.since).getTime();
  const untilMs = new Date(report.until).getTime();
  const bucketStartsMs = report.bucketStarts.map((s) => new Date(s).getTime());

  const perBucket = new Map<string, { realizedPnlUsd: number; closedCount: number; wins: number; losses: number }>();
  let realizedPnlUsd = 0;
  let feesUsd = 0;
  let wins = 0;
  let losses = 0;
  let closedCount = 0;
  const symbols = new Set<string>();
  for (const pos of executor.getClosedPositions()) {
    if (!pos.closedAt || pos.netPnlUsd === null) continue;
    const closedMs = new Date(pos.closedAt).getTime();
    if (!Number.isFinite(closedMs) || closedMs < sinceMs || closedMs >= untilMs) continue;
    let bucketIdx = -1;
    for (let i = 0; i < bucketStartsMs.length; i += 1) {
      if (bucketStartsMs[i]! <= closedMs) bucketIdx = i;
      else break;
    }
    if (bucketIdx < 0) continue;
    const key = report.bucketStarts[bucketIdx]!;
    // 2026-08-15: present the FULLY COSTED economics. pos.netPnlUsd is deliberately exit-side only
    // — it is what the daily-loss gate and the consecutive-loss kill switch read, and
    // FOLD_ENTRY_LEG_INTO_PNL exists so an operator decides when those gates start seeing the entry
    // commission. Nothing is rewritten in the store and no gate input moves; this is a READ-side
    // reconstruction from fields the record already carries, and it declines to reconstruct when
    // the flag is undefined (the flat-estimate arm already models both sides — adding there would
    // double-count). Measured on the XSEC directional lanes: 13 closed positions, all
    // entryLegFoldedIntoPnl=false, the presented net overstating by 23% of the SHORT lane's total.
    const netUsd = fullyCostedNetPnlUsd(pos) ?? pos.netPnlUsd;
    const feeUsd = fullyCostedFeeUsd(pos) ?? pos.feeEstimateUsd ?? 0;
    const bucket = perBucket.get(key) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
    bucket.realizedPnlUsd += netUsd;
    bucket.closedCount += 1;
    if (netUsd > 0) bucket.wins += 1;
    if (netUsd < 0) bucket.losses += 1;
    perBucket.set(key, bucket);
    realizedPnlUsd += netUsd;
    feesUsd += feeUsd;
    closedCount += 1;
    if (netUsd > 0) wins += 1;
    if (netUsd < 0) losses += 1;
    symbols.add(pos.symbol);
  }
  if (closedCount === 0) return report;

  const existing = report.lanes.find((lane) => lane.laneId === laneId);
  if (existing) {
    existing.realizedPnlUsd += realizedPnlUsd;
    existing.feesUsd += feesUsd;
    existing.closedCount += closedCount;
    existing.wins += wins;
    existing.losses += losses;
    existing.winRatePct = existing.closedCount > 0 ? (existing.wins / existing.closedCount) * 100 : null;
    existing.symbols = Array.from(new Set([...existing.symbols, ...symbols])).sort();
    let cumulative = 0;
    for (const point of existing.points) {
      const add = perBucket.get(point.bucketStart);
      if (add) {
        point.realizedPnlUsd += add.realizedPnlUsd;
        point.closedCount += add.closedCount;
        point.wins += add.wins;
        point.losses += add.losses;
      }
      cumulative += point.realizedPnlUsd;
      point.cumulativePnlUsd = cumulative;
    }
  } else {
    let cumulative = 0;
    const points = report.bucketStarts.map((bucketStart) => {
      const bucket = perBucket.get(bucketStart) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
      cumulative += bucket.realizedPnlUsd;
      return { bucketStart, ...bucket, cumulativePnlUsd: cumulative };
    });
    report.lanes.push({
      laneId,
      realizedPnlUsd,
      feesUsd,
      closedCount,
      wins,
      losses,
      winRatePct: closedCount > 0 ? (wins / closedCount) * 100 : null,
      symbols: Array.from(symbols).sort(),
      regimes: [],
      points,
    });
  }
  report.lanes.sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd));
  return report;
}

interface OverlayCfLane {
  error?: string;
  summary: {
    n: number; independentEpisodes: number; distinctDays: number;
    actualMeanR: number | null; counterfactualMeanR: number | null; deltaMeanR: number | null;
    stopsHit: number; exitMix: Record<string, number>; verdict: string;
  } | null;
  rows: CounterfactualRow[];
}
interface OverlayCfPayload {
  generatedAt: string;
  measuredCostBps: number;
  ownExitParams: { armR: number; givebackFraction: number; profitLockNetReturn: number; staticTpMaxNetReturn: number; maxHoldHours: number };
  lanes: Record<string, OverlayCfLane>;
}
let overlayCfCache: { atMs: number; payload: unknown } | null = null;
/** Criteria verdict for one symbol, plus what the ACTIVE pool currently does with it. Shared by the
 *  standalone page and the dashboard panel so the two can never disagree about the same symbol. */
interface PoolReportRow {
  symbol: string;
  liquidityUsdPerHour: number | null;
  oneLotUsd: number | null;
  /** C1/C2 only. C3-C5 are not evaluated here and are reported as unevaluated, never as passes. */
  failures: Array<{ code: string; detail: string }>;
  passesEvaluated: boolean;
  inPool: boolean;
  shortBlocked: boolean;
  /** false when the ACTIVE pool and the criteria disagree about this symbol. */
  agreesWithCriteria: boolean;
}
interface PoolReport {
  generatedAt: string;
  /** When false the exchange read failed, EVERY criterion is unmeasured, and the rows below say
   *  nothing about eligibility. Without this flag a failed fetch renders as "every symbol fails",
   *  which is the most misleading thing this page could possibly show. */
  measured: boolean;
  leg: { baseUsd: number; multiplier: number; effectiveUsd: number | null; oneLotCeilingUsd: number | null };
  thresholds: { minLiquidityUsdPerHour: number; maxLotFractionOfLeg: number; minListedDays: number; maxFundingCarryBps: number; maxCorrelation: number };
  counts: { universe: number; passesEvaluated: number; poolLong: number; poolShort: number; shortBlocked: number; shortEligible: number };
  rows: PoolReportRow[];
  mismatch: string[];
  blockedInPool: string[];
  /** Evaluated separately because BTC is not in the universe and so has no row above. */
  btc: { oneLotUsd: number | null; legNeededUsd: number | null };
  /** THE actionable verdict, hysteresis-aware. `mismatch` above is the RAW threshold comparison and
   *  is kept only because it is a fact per symbol; consumers deciding whether anything must CHANGE
   *  must read this instead. Both the API page and the dashboard panel had their own copy of that
   *  decision and disagreed about WIF, so it lives here now — one computation, one answer. */
  reconciliation: {
    changed: boolean;
    adds: string[];
    drops: string[];
    held: Array<{ symbol: string; action: string; reason: string }>;
    unmeasured: boolean;
  };
  /** Runtime membership used for NEW FILTERED baskets. Existing baskets retain frozen legs. */
  autoPool: CrossSectionalAutoPoolSnapshot | null;
  /** Compatibility contract for the currently served dashboard overlay. Keep this alias until the
   * overlay and the versioned API release are cut over together. */
  automation: CrossSectionalAutoPoolSnapshot | null;
  unevaluatedCriteria: Array<{ code: string; why: string }>;
}
let poolReportCache: { atMs: number; report: PoolReport } | null = null;

export async function registerLiveRoutes(
  app: FastifyInstance,
  engine: LiveExecutionEngine | null,
  opts: {
    configErrors?: string[];
    crossSectionalExecutor?: () => CrossSectionalExecutor | null;
    /** Isolated, structurally Testnet-only daily 4h range acceptance lane. */
    dailyRangeLane?: () => DailyRangeAcceptanceLane | null;
    /** C1-C6 pool evidence for the isolated Testnet Daily Range lane. */
    dailyRangeAutoPoolSnapshot?: () => DailyRangeAutoPoolSnapshot | null;
    /** Same durable C1/C2 pool consumed by Dynamic formation; status only on this route. */
    crossSectionalAutoPool?: () => CrossSectionalAutoPool | null;
    /** API-owned V1 circuit-breaker state; presentation only, never recalculated by the dashboard. */
    symbolReliabilitySnapshotGetter?: () => SymbolReliabilitySnapshot | null;
    // 2026-07-08: two more instances (TREND_BETA_VOL / MIXED_MEAN_REVERSION), wired alongside the
    // original FILTERED foundation instance above. Optional/independent — either can be absent
    // (e.g. disabled, or an older deploy) without affecting the other's routes.
    crossSectionalTrendExecutor?: () => CrossSectionalExecutor | null;
    crossSectionalMixedExecutor?: () => CrossSectionalExecutor | null;
    directionalRegimeDecision?: () => CrossSectionalDirectionalDecision;
    crossSectionalDirectionalLongExecutor?: () => SingleSymbolLaneExecutor | null;
    crossSectionalDirectionalShortExecutor?: () => SingleSymbolLaneExecutor | null;
    // 2026-07-08: SHORT_FADE_EXHAUSTION / INTRADAY_MOMENTUM_BREAKOUT single-symbol executors.
    // Same optional/independent contract as the cross-sectional getters above.
    shortFadeExecutor?: () => SingleSymbolLaneExecutor | null;
    intradayMomentumExecutor?: () => SingleSymbolLaneExecutor | null;
    // 2026-07-09: REGIME_COMPOSITE_CONFIRMATION_LONG. Same optional/independent contract.
    regimeCompositeExecutor?: () => SingleSymbolLaneExecutor | null;
    regimeCompositeShortExecutor?: () => SingleSymbolLaneExecutor | null;
    // 2026-07-09: COMPOSITE_ESTIMATOR_BIDI's 4 buckets. Same optional/independent contract.
    compositeEstimatorWideLongExecutor?: () => SingleSymbolLaneExecutor | null;
    compositeEstimatorWideShortExecutor?: () => SingleSymbolLaneExecutor | null;
    compositeEstimatorFastLongExecutor?: () => SingleSymbolLaneExecutor | null;
    compositeEstimatorFastShortExecutor?: () => SingleSymbolLaneExecutor | null;
    panicWashoutExecutor?: () => SingleSymbolLaneExecutor | null;
    innovationBasketExecutors?: () => CrossSectionalExecutor[];
    innovationSingleSymbolExecutors?: () => SingleSymbolLaneExecutor[];
    innovationCampaign?: () => InnovationCampaignDiagnostics;
    regimeAutopilot?: () => RegimeAutopilot | null;
    unifiedOrchestrator?: () => UnifiedTestnetOrchestrator | null;
    unifiedProposalStore?: () => UnifiedTestnetProposalStore | null;
    singleSymbolPriceTimeline?: () => SingleSymbolPriceTimelineService | null;
    /** Bounded completed public USD-M candles for the read-only open-basket chart. */
    marketCandles?: (symbol: string, interval: OpenBasketChartInterval, limit: number) => Promise<Candle[]>;
    /** Test seam only. Production uses the current UTC clock to choose yesterday's 00:00 4h bar. */
    openBasketChartNowMs?: () => number;
    /** Read-only USD-M sizing-reference diagnostics. Never reaches any order route. */
    futuresReferenceHealth?: () => FuturesReferenceHealthSnapshot | null;
    /** Read-only private-transport telemetry. The route never makes a Binance request itself. */
    binanceTransportStatus?: () => BinanceFuturesRateLimitStatus | null;
    /** Optional, bounded public-USD-M refresh for a diagnostic watch list. */
    probeFuturesReferenceHealth?: (symbols: string[]) => Promise<FuturesReferenceHealthSnapshot | null>;
    /** Test seam only. Production uses a 30s Testnet / 15s Live shared read and a 60s HTTP-418 cooldown. */
    dashboardAccountSnapshot?: {
      nowMs?: () => number;
      cacheTtlMs?: number;
      rateLimitBackoffMs?: number;
    };
    /** Test seam only. Production uses durable data-dir backed defaults. */
    copySecurity?: {
      secret?: string;
      replayGuard?: CopyReplayGuard;
      auditLogger?: CopyAuditLogger;
      nowMs?: () => number;
    };
  } = {},
): Promise<void> {
  const copySecurityDataDir = process.env.LIVE_COPY_SECURITY_DATA_DIR ?? "data";
  const copySecret = (): string => opts.copySecurity?.secret ?? process.env.LIVE_COPY_SHARED_SECRET ?? "";
  const copyReplayGuard = opts.copySecurity?.replayGuard ?? new CopyReplayGuard(copySecurityDataDir);
  const copyAuditLogger = opts.copySecurity?.auditLogger ?? new CopyAuditLogger(copySecurityDataDir);
  const copyNowMs = (): number => opts.copySecurity?.nowMs?.() ?? Date.now();
  const continuationPaths = () => continuationLifecyclePaths();
  const readDashboardAccountSnapshot = engine
    ? createDashboardAccountSnapshotReader(engine, opts.dashboardAccountSnapshot)
    : null;
  const openBasketChartCache = new Map<string, { cachedAtMs: number; candles: Candle[] }>();
  const openBasketChartNowMs = (): number => opts.openBasketChartNowMs?.() ?? Date.now();
  const readOpenBasketChartCandles = async (
    symbol: string,
    interval: OpenBasketChartInterval,
  ): Promise<Candle[]> => {
    const source = opts.marketCandles;
    if (!source) throw new Error("public USD-M candle source unavailable");
    const key = `${symbol}:${interval}`;
    const nowMs = openBasketChartNowMs();
    const cached = openBasketChartCache.get(key);
    if (cached && nowMs - cached.cachedAtMs < 30_000) return cached.candles;
    const candles = await source(symbol, interval, OPEN_BASKET_CHART_LIMITS[interval]);
    openBasketChartCache.set(key, { cachedAtMs: nowMs, candles });
    return candles;
  };
  const copyHeader = (headers: Record<string, unknown>, name: string): string | undefined => {
    const value = headers[name];
    return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] ?? "") : undefined;
  };
  const appendCopyAudit = (event: Omit<CopyAuditEvent, "at">): { ok: boolean; reason: string | null } =>
    copyAuditLogger.append({ ...event, at: new Date(copyNowMs()).toISOString() });
  const allCrossSectionalExecutors = () =>
    [
      opts.crossSectionalExecutor?.() ?? null,
      opts.crossSectionalTrendExecutor?.() ?? null,
      opts.crossSectionalMixedExecutor?.() ?? null,
      ...(opts.innovationBasketExecutors?.() ?? []),
    ].filter(
      (exec): exec is CrossSectionalExecutor => exec !== null,
    );
  const allSingleSymbolExecutors = () =>
    [
      opts.shortFadeExecutor?.() ?? null,
      opts.intradayMomentumExecutor?.() ?? null,
      opts.regimeCompositeExecutor?.() ?? null,
      opts.regimeCompositeShortExecutor?.() ?? null,
      opts.compositeEstimatorWideLongExecutor?.() ?? null,
      opts.compositeEstimatorWideShortExecutor?.() ?? null,
      opts.compositeEstimatorFastLongExecutor?.() ?? null,
      opts.compositeEstimatorFastShortExecutor?.() ?? null,
      opts.panicWashoutExecutor?.() ?? null,
      opts.crossSectionalDirectionalLongExecutor?.() ?? null,
      opts.crossSectionalDirectionalShortExecutor?.() ?? null,
      ...(opts.innovationSingleSymbolExecutors?.() ?? []),
    ].filter((exec): exec is SingleSymbolLaneExecutor => exec !== null);
  app.get("/api/live/status", async () => {
    if (!engine) {
      return {
        enabled: false,
        configErrors: opts.configErrors ?? [],
        reason:
          opts.configErrors && opts.configErrors.length > 0
            ? `live execution enabled but misconfigured: ${opts.configErrors.join("; ")}`
            : "live execution disabled (set LIVE_EXECUTION_ENABLED=1 + LIVE_BINANCE_* env to enable)",
      };
    }
    return {
      ...engine.getStatus(),
      unifiedOrchestrator: opts.unifiedOrchestrator?.()?.getStatus() ?? null,
      unifiedProposalSource: opts.unifiedProposalStore?.()?.getStatus() ?? null,
    };
  });

  // This intentionally returns the client-owned evidence as-is and does no network I/O.  It lets
  // an operator distinguish an active cooldown from an old failure, and identify the bounded
  // caller/endpoint/weight history without ever exposing signed URLs, API keys, or signatures.
  app.get("/api/live/binance-transport", async (request, reply) => {
    const status = opts.binanceTransportStatus?.() ?? null;
    if (!status) {
      reply.code(503);
      return { available: false, reason: "private Binance transport is unavailable because execution runtime is disabled" };
    }
    return { available: true, ...status };
  });

  app.get("/api/live/futures-reference-health", async (request, reply) => {
    const query = request.query as { symbols?: unknown };
    const raw = Array.isArray(query.symbols)
      ? query.symbols.map((value) => String(value)).join(",")
      : typeof query.symbols === "string"
        ? query.symbols
        : "";
    const symbols = Array.from(new Set(
      (raw ? raw.split(",") : ["1000PEPEUSDT", "SOLUSDT", "PEPEUSDT"])
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => /^[A-Z0-9]{4,30}$/.test(symbol)),
    )).slice(0, 12);
    const report = opts.probeFuturesReferenceHealth
      ? await opts.probeFuturesReferenceHealth(symbols)
      : opts.futuresReferenceHealth?.() ?? null;
    if (!report) {
      reply.code(503);
      return {
        enabled: false,
        reason: "USD-M reference health unavailable because live futures runtime is disabled",
        sourceChain: ["USD_M_MARK_PRICE", "USD_M_BOOK_TICKER", "POSITION_RISK", "FAIL_CLOSED"],
      };
    }
    return report;
  });

  app.get("/api/live/allocation-lanes", async () => ({
    lanes: Array.from(new Set(OPERATOR_ALLOCATION_LANE_IDS)).sort(),
  }));
  app.get("/api/live/innovation-executors", async () => ({
    executableLaneIds: EXECUTABLE_INNOVATION_LANE_IDS,
    policyOnly: INNOVATION_POLICY_ONLY_IDS,
    campaign: opts.innovationCampaign?.() ?? null,
    basket: (opts.innovationBasketExecutors?.() ?? []).map((executor) => executor.getStatus()),
    singleSymbol: (opts.innovationSingleSymbolExecutors?.() ?? []).map((executor) => executor.getStatus()),
  }));

  // Shared BTC/ETH/SOL price timeline for the operator and the optional single-symbol execution
  // overlay. The service uses public candles only; no account or order action happens on GET.
  app.get("/api/live/single-symbol-timeline", async (_request, reply) => {
    const timeline = opts.singleSymbolPriceTimeline?.() ?? null;
    if (!timeline) {
      reply.code(503);
      return { enabled: false, reason: "single-symbol timeline unavailable because live market runtime is disabled" };
    }
    return { enabled: true, ...(await timeline.getSnapshot()) };
  });

  // Read-only chart feed for the currently served Open Basket panel.  It uses public USD-M
  // candles only; no order client, account state, or forming candle can reach this route.
  //
  // Without `interval`, this is the dashboard bundle: completed 1d + 5m candles, plus the
  // PREVIOUS UTC calendar day's exact 00:00-04:00 4h range.  That range is display-only and is
  // intentionally separate from any current-day trading lane's reference range.  With `interval`,
  // retain the older single-series contract for existing read-only clients.
  app.get("/api/live/open-basket-chart", async (request, reply) => {
    const query = request.query as { symbol?: unknown; interval?: unknown };
    const symbol = typeof query.symbol === "string" ? query.symbol.trim().toUpperCase() : "";
    if (!validOpenBasketChartSymbol(symbol)) {
      reply.code(400);
      return { ok: false, reason: "valid USD-M symbol is required" };
    }
    if (query.interval !== undefined && !isOpenBasketChartInterval(query.interval)) {
      reply.code(400);
      return { ok: false, reason: "interval must be one of 5m, 15m, 1h, 4h, 1d" };
    }
    try {
      if (isOpenBasketChartInterval(query.interval)) {
        const candles = cleanOpenBasketChartCandles(await readOpenBasketChartCandles(symbol, query.interval));
        return {
          ok: true,
          symbol,
          interval: query.interval,
          source: "BINANCE_USDM_PUBLIC" as const,
          completedOnly: true,
          asOf: new Date(openBasketChartNowMs()).toISOString(),
          candles,
        };
      }

      const nowMs = openBasketChartNowMs();
      const previousDayStartMs = previousUtcDayStartMs(nowMs);
      const [dailyCandles, fiveMinuteCandles, fourHourCandles] = await Promise.all([
        readOpenBasketChartCandles(symbol, "1d"),
        readOpenBasketChartCandles(symbol, "5m"),
        readOpenBasketChartCandles(symbol, "4h"),
      ]);
      const reference = cleanOpenBasketChartCandles(fourHourCandles)
        .find((candle) => candle.openTime === previousDayStartMs) ?? null;
      const referenceValid = reference !== null && reference.high > reference.low;
      return {
        ok: true,
        symbol,
        source: "BINANCE_USDM_PUBLIC" as const,
        completedOnly: true,
        asOf: new Date(nowMs).toISOString(),
        daily: { interval: "1d" as const, candles: cleanOpenBasketChartCandles(dailyCandles) },
        fiveMinute: { interval: "5m" as const, candles: cleanOpenBasketChartCandles(fiveMinuteCandles) },
        previousUtcReference4h: referenceValid
          ? {
            dateUtc: new Date(previousDayStartMs).toISOString().slice(0, 10),
            fourHourOpenTime: previousDayStartMs,
            fourHourCloseTime: previousDayStartMs + FOUR_HOURS_MS,
            rangeHigh: reference.high,
            rangeLow: reference.low,
          }
          : null,
        referenceReason: referenceValid ? null : `missing or invalid completed 4h candle at ${new Date(previousDayStartMs).toISOString()}`,
      };
    } catch (error) {
      reply.code(503);
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "public USD-M candle source unavailable",
      };
    }
  });

  app.post("/api/live/arm", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "ARM") {
      reply.code(400);
      return { ok: false, reason: 'arming requires body {"confirm":"ARM"}' };
    }
    const result = await engine.arm();
    if (!result.ok) reply.code(409);
    return { ...result, armed: engine.isArmed() };
  });

  app.post("/api/live/disarm", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    engine.disarm("manual disarm via /api/live/disarm");
    return { ok: true, armed: engine.isArmed() };
  });

  // Drain NEW entries without disabling reconciliation, protective exits, TP/SL, or policy closes.
  // This is deliberately separate from disarm: the engine can remain armed as an exit manager.
  app.post("/api/live/new-entry-drain", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { enabled?: unknown; confirm?: unknown; reason?: unknown };
    if (typeof body.enabled !== "boolean" || body.confirm !== "DRAIN") {
      reply.code(400);
      return { ok: false, reason: 'body must be {"enabled":true|false,"confirm":"DRAIN","reason":"optional"}' };
    }
    return {
      ok: true,
      ...engine.setNewEntriesPaused(
        body.enabled,
        typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "operator request",
      ),
      armed: engine.isArmed(),
    };
  });

  // RECEIVER (runs on the MAINNET instance): open an exact copy of a testnet
  // position. Requires {"confirm":"COPY"} and the engine to be ARMED. The stop/TP
  // geometry is preserved relative to entry; the protective stop is placed before
  // the intent is considered OPEN (same machinery as the normal mirror).
  app.post("/api/live/copy-intent", async (request, reply) => {
    const body = (request.body ?? {}) as {
      confirm?: string;
      symbol?: string;
      direction?: "LONG" | "SHORT";
      qty?: number;
      entryPrice?: number;
      stopLossPrice?: number;
      tp1Price?: number;
      exitRule?: string | null;
      sourceLaneId?: string | null;
      sourcePaperOrderId?: string | null;
      sourceEnv?: string | null;
      idempotencyKey?: string | null;
    };
    const remoteAddress = request.ip ?? request.socket.remoteAddress ?? null;
    if (!isLoopbackAddress(remoteAddress)) {
      appendCopyAudit({
        stage: "RECEIVER",
        outcome: "REJECTED",
        reason: "non-loopback source",
        requestId: request.id,
        idempotencyKey: body.idempotencyKey ?? null,
        sourcePaperOrderId: body.sourcePaperOrderId ?? null,
        symbol: body.symbol ?? null,
        direction: body.direction ?? null,
        payloadSha256: copyPayloadSha256(body),
        remoteAddress,
      });
      reply.code(403);
      return { ok: false, reason: "copy receiver is private and accepts loopback relay traffic only" };
    }
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const authHeaders: Partial<CopyAuthHeaders> = {
      timestamp: copyHeader(request.headers, "x-kronos-copy-timestamp"),
      nonce: copyHeader(request.headers, "x-kronos-copy-nonce"),
      idempotencyKey: copyHeader(request.headers, "x-kronos-copy-idempotency-key"),
      signature: copyHeader(request.headers, "x-kronos-copy-signature"),
    };
    const verified = verifyCopyRequest({
      secret: copySecret(),
      body,
      headers: authHeaders,
      replayGuard: copyReplayGuard,
      nowMs: copyNowMs(),
    });
    if (!verified.ok) {
      appendCopyAudit({
        stage: "RECEIVER",
        outcome: "REJECTED",
        reason: verified.reason,
        requestId: request.id,
        idempotencyKey: authHeaders.idempotencyKey ?? null,
        sourcePaperOrderId: body.sourcePaperOrderId ?? null,
        symbol: body.symbol ?? null,
        direction: body.direction ?? null,
        payloadSha256: verified.payloadSha256,
        remoteAddress,
      });
      reply.code(verified.reason?.includes("secret") ? 503 : 401);
      return { ok: false, reason: verified.reason };
    }
    if (
      typeof body.idempotencyKey !== "string" ||
      body.idempotencyKey !== authHeaders.idempotencyKey
    ) {
      appendCopyAudit({
        stage: "RECEIVER",
        outcome: "REJECTED",
        reason: "body/header idempotency key mismatch",
        requestId: request.id,
        idempotencyKey: authHeaders.idempotencyKey ?? null,
        sourcePaperOrderId: body.sourcePaperOrderId ?? null,
        symbol: body.symbol ?? null,
        direction: body.direction ?? null,
        payloadSha256: verified.payloadSha256,
        remoteAddress,
      });
      reply.code(400);
      return { ok: false, reason: "body/header idempotency key mismatch" };
    }
    if (body.confirm !== "COPY") {
      appendCopyAudit({
        stage: "RECEIVER",
        outcome: "REJECTED",
        reason: "explicit COPY confirmation missing",
        requestId: request.id,
        idempotencyKey: body.idempotencyKey,
        sourcePaperOrderId: body.sourcePaperOrderId ?? null,
        symbol: body.symbol ?? null,
        direction: body.direction ?? null,
        payloadSha256: verified.payloadSha256,
        remoteAddress,
      });
      reply.code(400);
      return { ok: false, reason: 'copy requires body {"confirm":"COPY", ...spec} — this opens a REAL position' };
    }
    if (
      typeof body.symbol !== "string" ||
      (body.direction !== "LONG" && body.direction !== "SHORT") ||
      typeof body.qty !== "number" ||
      typeof body.entryPrice !== "number" ||
      typeof body.stopLossPrice !== "number" ||
      typeof body.tp1Price !== "number"
    ) {
      appendCopyAudit({
        stage: "RECEIVER",
        outcome: "REJECTED",
        reason: "invalid copy specification",
        requestId: request.id,
        idempotencyKey: body.idempotencyKey,
        sourcePaperOrderId: body.sourcePaperOrderId ?? null,
        symbol: body.symbol ?? null,
        direction: body.direction ?? null,
        payloadSha256: verified.payloadSha256,
        remoteAddress,
      });
      reply.code(400);
      return { ok: false, reason: "spec requires symbol, direction, qty, entryPrice, stopLossPrice, tp1Price" };
    }
    const acceptedAudit = appendCopyAudit({
      stage: "RECEIVER",
      outcome: "ACCEPTED",
      reason: null,
      requestId: request.id,
      idempotencyKey: body.idempotencyKey,
      sourcePaperOrderId: body.sourcePaperOrderId ?? null,
      symbol: body.symbol,
      direction: body.direction,
      payloadSha256: verified.payloadSha256,
      remoteAddress,
    });
    if (!acceptedAudit.ok) {
      reply.code(503);
      return { ok: false, reason: acceptedAudit.reason };
    }
    const result = await engine.copyExternalIntent({
      symbol: body.symbol,
      direction: body.direction,
      qty: body.qty,
      entryPrice: body.entryPrice,
      stopLossPrice: body.stopLossPrice,
      tp1Price: body.tp1Price,
      exitRule: (body.exitRule ?? null) as never,
      sourceLaneId: body.sourceLaneId ?? null,
      sourcePaperOrderId: body.sourcePaperOrderId ?? null,
      sourceEnv: body.sourceEnv ?? null,
      idempotencyKey: body.idempotencyKey,
    });
    appendCopyAudit({
      stage: "RECEIVER",
      outcome: result.reason?.startsWith("idempotent replay")
        ? "IDEMPOTENT_REPLAY"
        : result.ok
          ? "ACCEPTED"
          : "FAILED",
      reason: result.reason,
      requestId: request.id,
      idempotencyKey: body.idempotencyKey,
      sourcePaperOrderId: body.sourcePaperOrderId ?? null,
      symbol: body.symbol,
      direction: body.direction,
      payloadSha256: verified.payloadSha256,
      remoteAddress,
    });
    if (!result.ok) reply.code(409);
    return result;
  });

  // RELAY (runs on the TESTNET instance): the dashboard's per-position "copy to
  // live" button. Looks up the OPEN testnet intent and forwards its exact spec to
  // the mainnet instance (LIVE_COPY_TARGET_URL, default the local 3103 process).
  app.post("/api/live/copy-to-live", async (request, reply) => {
    const remoteAddress = request.ip ?? request.socket.remoteAddress ?? null;
    if (!isLoopbackAddress(remoteAddress)) {
      reply.code(403);
      return { ok: false, reason: "copy relay is reachable only through the local authenticated reverse proxy" };
    }
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { paperOrderId?: string; confirm?: string };
    if (body.confirm !== "COPY_TO_LIVE") {
      reply.code(400);
      return { ok: false, reason: 'copy relay requires {"confirm":"COPY_TO_LIVE","paperOrderId":"..."}' };
    }
    if (typeof body.paperOrderId !== "string" || body.paperOrderId.length === 0) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"paperOrderId":"<open intent id>"}' };
    }
    const lookup = engine.getOpenIntentCopySpec(body.paperOrderId);
    if (!lookup.ok || !lookup.spec) {
      reply.code(lookup.reason?.startsWith("no intent") ? 404 : 409);
      return { ok: false, reason: lookup.reason };
    }
    const target = process.env.LIVE_COPY_TARGET_URL ?? "http://127.0.0.1:3103";
    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      reply.code(503);
      return { ok: false, reason: "LIVE_COPY_TARGET_URL is invalid" };
    }
    if (
      targetUrl.protocol !== "http:" ||
      !isLoopbackAddress(targetUrl.hostname) ||
      targetUrl.username ||
      targetUrl.password
    ) {
      reply.code(503);
      return { ok: false, reason: "LIVE_COPY_TARGET_URL must be an unauthenticated loopback http URL" };
    }
    const secret = copySecret();
    if (secret.length < 32) {
      reply.code(503);
      return { ok: false, reason: "LIVE_COPY_SHARED_SECRET is missing or shorter than 32 characters" };
    }
    const idempotencyKey = `testnet:${body.paperOrderId}`;
    const spec = { confirm: "COPY", ...lookup.spec, sourceEnv: "testnet", idempotencyKey };
    const auth = signCopyRequest({
      secret,
      body: spec,
      idempotencyKey,
      nowMs: copyNowMs(),
    });
    const payloadSha256 = copyPayloadSha256(spec);
    const acceptedAudit = appendCopyAudit({
      stage: "RELAY",
      outcome: "ACCEPTED",
      reason: null,
      requestId: request.id,
      idempotencyKey,
      sourcePaperOrderId: body.paperOrderId,
      symbol: lookup.spec.symbol,
      direction: lookup.spec.direction,
      payloadSha256,
      remoteAddress,
    });
    if (!acceptedAudit.ok) {
      reply.code(503);
      return { ok: false, reason: acceptedAudit.reason };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`${target}/api/live/copy-intent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kronos-copy-timestamp": auth.timestamp,
          "x-kronos-copy-nonce": auth.nonce,
          "x-kronos-copy-idempotency-key": auth.idempotencyKey,
          "x-kronos-copy-signature": auth.signature,
        },
        body: JSON.stringify(spec),
        signal: controller.signal,
      });
      const responseText = await response.text();
      let payload: { ok?: boolean; reason?: string } = {};
      try {
        payload = responseText ? (JSON.parse(responseText) as { ok?: boolean; reason?: string }) : {};
      } catch {
        payload = { ok: false, reason: `live copy returned non-JSON HTTP ${response.status}` };
      }
      if (!response.ok || payload.ok === false) {
        appendCopyAudit({
          stage: "RELAY",
          outcome: "FAILED",
          reason: payload.reason ?? `live copy failed (${response.status})`,
          requestId: request.id,
          idempotencyKey,
          sourcePaperOrderId: body.paperOrderId,
          symbol: lookup.spec.symbol,
          direction: lookup.spec.direction,
          payloadSha256,
          remoteAddress,
        });
        reply.code(response.status === 200 ? 409 : response.status);
        return { ok: false, reason: payload.reason ?? `live copy failed (${response.status})`, spec };
      }
      appendCopyAudit({
        stage: "RELAY",
        outcome: payload.reason?.startsWith("idempotent replay") ? "IDEMPOTENT_REPLAY" : "ACCEPTED",
        reason: payload.reason ?? null,
        requestId: request.id,
        idempotencyKey,
        sourcePaperOrderId: body.paperOrderId,
        symbol: lookup.spec.symbol,
        direction: lookup.spec.direction,
        payloadSha256,
        remoteAddress,
      });
      return { ok: true, spec, live: payload };
    } catch (error) {
      appendCopyAudit({
        stage: "RELAY",
        outcome: "FAILED",
        reason: (error as Error).message,
        requestId: request.id,
        idempotencyKey,
        sourcePaperOrderId: body.paperOrderId,
        symbol: lookup.spec.symbol,
        direction: lookup.spec.direction,
        payloadSha256,
        remoteAddress,
      });
      reply.code(502);
      return { ok: false, reason: `live instance unreachable: ${(error as Error).message}`, spec };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  // Operator lane selection for the live mirror. Body:
  //   {"lanes": null}                          → all lanes allowed (default)
  //   {"lanes": []}                            → pause every new mirror
  //   {"lanes": ["CG_WIDE_FAST_SHORT", ...]}   → only these lanes may open new positions
  // Ids match a paper order's selectedLaneId as the full id or its variant suffix.
  // Affects NEW entries only — existing open positions keep managing/closing normally.
  app.post("/api/live/lanes", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { lanes?: unknown; confirm?: string };
    // 2026-07-12 fix: this mutates which lanes may open new real positions, with no confirmation
    // phrase — unlike every other state-changing action in this file. No known frontend caller
    // currently exists (superseded by /api/live/lane-allocations), so this closes the gap safely.
    if (body.confirm !== "SET_LANES") {
      reply.code(400);
      return { ok: false, reason: 'setting the lane allow-list requires body {"confirm":"SET_LANES"}' };
    }
    if (body.lanes !== null && !Array.isArray(body.lanes)) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"lanes": null | string[], "confirm":"SET_LANES"}' };
    }
    const result = engine.setAllowedLanes(
      body.lanes === null ? null : (body.lanes as unknown[]).map((v) => String(v)),
    );
    return { ok: true, ...result };
  });

  // Operator close of ONE open directional intent — the dashboard's per-position "Close" button
  // (2026-07-07: full manual control, bank early when the regime turns). Flattens only the
  // engine's own share of the netted position; basket legs on the same symbol stay open.
  app.post("/api/live/close-intent", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { paperOrderId?: string; confirm?: string };
    if (body.confirm !== "CLOSE") {
      reply.code(400);
      return { ok: false, reason: 'closing requires body {"confirm":"CLOSE","paperOrderId":"…"} — this places a REAL market order' };
    }
    if (typeof body.paperOrderId !== "string" || body.paperOrderId.length === 0) {
      reply.code(400);
      return { ok: false, reason: "paperOrderId required" };
    }
    const result = await engine.manualCloseIntent(body.paperOrderId);
    if (!result.ok) reply.code(409);
    return result;
  });

  // Flat per-lane-position list for the "Single-symbol executor — stop-protected" panel
  // (2026-07-10: operator wants to see and close each lane's OWN position on a symbol separately —
  // two lanes independently holding the same symbol net into one exchange position, but they can
  // have very different track records/risk profiles, e.g. a proven-ish trailing-protected lane vs
  // an unproven fixed-target lane with zero interim protection). One entry per open
  // SingleSymbolPosition, tagged with its owning laneId, merged with the current markPrice from the
  // account snapshot (never a second, possibly-stale price source).
  app.get("/api/live/single-symbol/positions", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      const snapshot = (await readDashboardAccountSnapshot!()).snapshot;
      const exchangeBySymbol = new Map<string, SingleSymbolExchangePositionContext>(
        snapshot.positions.map((p) => [p.symbol, {
          direction: p.direction,
          quantity: p.quantity,
          markPrice: p.markPrice,
          leverage: p.leverage,
          estimatedCloseCostUsd: p.estimatedCloseCostUsd,
        }]),
      );
      const rows = flattenSingleSymbolPositions(allSingleSymbolExecutors(), exchangeBySymbol);
      return { ok: true, positions: rows };
    } catch (err) {
      const failure = dashboardAccountFailure(err, "single-symbol positions fetch failed");
      reply.code(failure.statusCode);
      return failure.body;
    }
  });

  app.get("/api/live/lane-evaluation", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      const snapshot = (await readDashboardAccountSnapshot!()).snapshot;
      const execStatuses = allSingleSymbolExecutors().map((exec) => exec.getStatus());
      const measuredByLane = buildMeasuredLaneStats();
      const rows = buildLaneEvaluationRows(
        execStatuses,
        measuredByLane,
        snapshot.closedLanes.find((l) => l.laneId === PROFIT_CORE_SHORT_TRAIL_LANE_ID) ?? null,
        (laneId) => engine.laneSelectionWeightPctForLane(laneId),
      );
      return { ok: true, lanes: rows };
    } catch (err) {
      const failure = dashboardAccountFailure(err, "lane evaluation fetch failed");
      reply.code(failure.statusCode);
      return failure.body;
    }
  });

  // 2026-07-22 (CORTEX promoted-tilt audit): report-only visibility into what CORTEX's promotion
  // pipeline is CURRENTLY installing on this engine. Before this route existed, verifying "what is
  // CORTEX applying right now" required cross-referencing /api/live/lane-evaluation (single-symbol
  // lanes only), /api/live/cortex-real-attribution (historical, captured-at-open, not live), and the
  // raw decision journal (which only carries the β=0 operational and evaluationBeta counterfactual,
  // never the promoted value) — no single endpoint answered the question directly.
  app.get("/api/live/cortex-promoted-weights", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const weights = engine.getCortexPromotedWeights();
    return { ok: true, active: weights !== null, weights: weights ?? {} };
  });

  // Operator close of single-symbol-lane-executor position(s) — the "Single-symbol executor —
  // stop-protected" panel's per-row "Close now" button (2026-07-10, urgent operator ask). Body
  // {"positionId":"…","confirm":"CLOSE"} closes ONE specific lane's position — the operator asked
  // for this after noticing two lanes on the same symbol can have very different track
  // records/protection. Body {"symbol":"…","confirm":"CLOSE"} (legacy, still supported) closes ALL
  // open positions for that symbol across every single-symbol-lane-executor instance (SHORT_FADE_
  // EXHAUSTION_CROWDED, INTRADAY_MOMENTUM_BREAKOUT_LONG, REGIME_COMPOSITE_CONFIRMATION_LONG,
  // COMPOSITE_ESTIMATOR_BIDI_* x4, PANIC_WASHOUT_RECLAIM_LONG) — a symbol row is the SUM across
  // however many of these lanes independently hold that symbol (Binance nets same-symbol positions
  // per account). Either path reuses manualClosePosition()'s exact same reduceOnly-with-fallback
  // path the exit policy uses, sized to ONLY that lane's own tracked qty — never touches basket legs
  // or directional-intent qty on the same symbol from other books.
  app.post("/api/live/single-symbol/close", async (request, reply) => {
    // 2026-07-12 fix: the only mutating route in this file that never checked this — every
    // SingleSymbolLaneExecutor instance is constructed inside the SAME liveConfig.enabled guard as
    // `engine` itself (they share the same liveClient), so engine === null means these are ALL null
    // too. Without this check the route fell through to a less clear 404/"no open positions"
    // response instead of the consistent {enabled:false} contract every other route follows.
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { symbol?: string; positionId?: string; confirm?: string };
    if (body.confirm !== "CLOSE") {
      reply.code(400);
      return { ok: false, reason: 'closing requires body {"confirm":"CLOSE","positionId":"…"} or {"confirm":"CLOSE","symbol":"…"} — this places a REAL market order' };
    }
    if (typeof body.positionId === "string" && body.positionId.length > 0) {
      const owner = allSingleSymbolExecutors().find((exec) =>
        exec.getStatus().openPositions.some((p) => p.positionId === body.positionId),
      );
      if (!owner) {
        reply.code(404);
        return { ok: false, reason: `no open single-symbol-executor position ${body.positionId}` };
      }
      const result = await owner.manualClosePosition(body.positionId);
      if (!result.ok) reply.code(409);
      return result;
    }
    if (typeof body.symbol !== "string" || body.symbol.length === 0) {
      reply.code(400);
      return { ok: false, reason: "positionId or symbol required" };
    }
    const matches = allSingleSymbolExecutors().flatMap((exec) =>
      exec.getStatus().openPositions
        .filter((p) => p.symbol === body.symbol)
        .map((p) => ({ exec, positionId: p.positionId })),
    );
    if (matches.length === 0) {
      reply.code(404);
      return { ok: false, reason: `no open single-symbol-executor position for ${body.symbol}` };
    }
    const results: Array<{ ok: boolean; reason: string | null; netPnlUsd: number | null }> = [];
    for (const { exec, positionId } of matches) {
      results.push(await exec.manualClosePosition(positionId));
    }
    const anyFailed = results.some((r) => !r.ok);
    if (anyFailed) reply.code(409);
    return {
      ok: !anyFailed,
      reason: anyFailed ? (results.find((r) => !r.ok)?.reason ?? "one or more closes failed") : null,
      closedCount: results.filter((r) => r.ok).length,
      netPnlUsd: results.reduce((sum, r) => sum + (r.netPnlUsd ?? 0), 0),
      results,
    };
  });

  // Cross-sectional executor status (testnet-first basket execution of the measured lane).
  app.get("/api/live/cross-sectional-executor", async () => {
    const executor = opts.crossSectionalExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    // 2026-07-12 (profitability Stage 3): attach the report-only regime-skew counterfactual so the
    // operator can see whether CROSS_SECTIONAL_REGIME_SKEW's same-direction tilt is being rewarded.
    return {
      ...executor.getStatus(),
      regimeSkewCounterfactual: executor.getRegimeSkewCounterfactual(),
      symbolReliability: opts.symbolReliabilitySnapshotGetter?.() ?? null,
    };
  });

  // ── Daily 4h range-acceptance lane (Testnet-only, isolated from MOM36) ────
  // Read-only chart feed for a specific durable Daily Range trade.  Unlike the
  // generic basket review route, this intentionally takes the persisted range
  // from the trade, so an open trade keeps the exact 00:00-04:00 UTC reference
  // it was created with even after the calendar day changes.
  app.get("/api/live/daily-range-lane/chart", async (request, reply) => {
    const lane = opts.dailyRangeLane?.() ?? null;
    if (!lane) {
      reply.code(503);
      return { ok: false, reason: "daily range lane is unavailable outside Testnet" };
    }
    const query = (request.query ?? {}) as { tradeId?: unknown };
    const tradeId = typeof query.tradeId === "string" ? query.tradeId.trim() : "";
    if (!tradeId || tradeId.length > 160) {
      reply.code(400);
      return { ok: false, reason: "valid daily range tradeId is required" };
    }
    const trade = lane.findTrade(tradeId);
    if (!trade) {
      reply.code(404);
      return { ok: false, reason: "daily range trade not found" };
    }
    if (!validOpenBasketChartSymbol(trade.symbol)) {
      reply.code(422);
      return { ok: false, reason: "daily range trade has an invalid USD-M symbol" };
    }

    const referenceStartMs = utcDateStartMs(trade.dateUtc);
    const referenceValid = referenceStartMs !== null
      && Number.isFinite(trade.rangeHigh)
      && Number.isFinite(trade.rangeLow)
      && trade.rangeHigh > trade.rangeLow;
    try {
      const [dailyCandles, fiveMinuteCandles] = await Promise.all([
        readOpenBasketChartCandles(trade.symbol, "1d"),
        readOpenBasketChartCandles(trade.symbol, "5m"),
      ]);
      return {
        ok: true,
        chartKind: "DAILY_RANGE_TRADE" as const,
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        source: "BINANCE_USDM_PUBLIC" as const,
        completedOnly: true,
        asOf: new Date(openBasketChartNowMs()).toISOString(),
        daily: { interval: "1d" as const, candles: cleanOpenBasketChartCandles(dailyCandles) },
        fiveMinute: { interval: "5m" as const, candles: cleanOpenBasketChartCandles(fiveMinuteCandles) },
        reference4h: referenceValid
          ? {
            dateUtc: trade.dateUtc,
            fourHourOpenTime: referenceStartMs,
            fourHourCloseTime: referenceStartMs + FOUR_HOURS_MS,
            rangeHigh: trade.rangeHigh,
            rangeLow: trade.rangeLow,
            source: "TRADE_PERSISTED" as const,
          }
          : null,
        referenceReason: referenceValid ? null : "trade's persisted 00:00-04:00 UTC range is missing or invalid",
      };
    } catch (error) {
      reply.code(503);
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "public USD-M candle source unavailable",
      };
    }
  });

  app.get("/api/live/daily-range-lane/status", async () => {
    const lane = opts.dailyRangeLane?.() ?? null;
    if (!lane) {
      return { enabled: false, reason: "daily range lane is available only in the Testnet runtime" };
    }
    return {
      enabled: true,
      ...lane.getStatus(),
      autoPool: opts.dailyRangeAutoPoolSnapshot?.() ?? null,
    };
  });

  app.get("/api/live/daily-range-lane/history", async (request, reply) => {
    const lane = opts.dailyRangeLane?.() ?? null;
    if (!lane) {
      reply.code(503);
      return { ok: false, reason: "daily range lane is unavailable outside Testnet" };
    }
    const query = (request.query ?? {}) as { kind?: string; limit?: string | number };
    const kind = query.kind;
    if (kind !== "levels" && kind !== "signals" && kind !== "trades") {
      reply.code(400);
      return { ok: false, reason: "kind must be levels, signals, or trades" };
    }
    const parsedLimit = typeof query.limit === "number" ? query.limit : Number.parseInt(query.limit ?? "500", 10);
    return { ok: true, kind, rows: lane.history(kind, Number.isFinite(parsedLimit) ? parsedLimit : 500) };
  });

  app.get("/api/live/daily-range-lane/export/:kind", async (request, reply) => {
    const lane = opts.dailyRangeLane?.() ?? null;
    if (!lane) {
      reply.code(503);
      return { ok: false, reason: "daily range lane is unavailable outside Testnet" };
    }
    const params = request.params as { kind?: string };
    const kind = params.kind;
    if (kind !== "levels" && kind !== "signals" && kind !== "trades") {
      reply.code(400);
      return { ok: false, reason: "kind must be levels, signals, or trades" };
    }
    const query = (request.query ?? {}) as { format?: string };
    if (query.format === "csv") {
      reply.type("text/csv; charset=utf-8");
      return lane.exportCsv(kind);
    }
    return { ok: true, kind, rows: lane.history(kind, 10_000) };
  });

  app.post("/api/live/daily-range-lane/canary", async (request, reply) => {
    if (!isLoopbackAddress(request.ip) || process.env.LIVE_BINANCE_ENV !== "testnet") {
      reply.code(403);
      return { ok: false, reason: "Testnet loopback caller required" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "RUN_DAILY_RANGE_CANARY") {
      reply.code(400);
      return { ok: false, reason: 'canary requires body {"confirm":"RUN_DAILY_RANGE_CANARY"}' };
    }
    const lane = opts.dailyRangeLane?.() ?? null;
    if (!lane) {
      reply.code(503);
      return { ok: false, reason: "daily range lane is unavailable" };
    }
    const evidence = await lane.runCanary();
    if (evidence.status !== "PASSED") reply.code(409);
    return { ok: evidence.status === "PASSED", evidence };
  });

  app.post("/api/live/daily-range-lane/arm", async (request, reply) => {
    if (!isLoopbackAddress(request.ip) || process.env.LIVE_BINANCE_ENV !== "testnet") {
      reply.code(403);
      return { ok: false, reason: "Testnet loopback caller required" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "ARM_DAILY_RANGE_LANE") {
      reply.code(400);
      return { ok: false, reason: 'arm requires body {"confirm":"ARM_DAILY_RANGE_LANE"}' };
    }
    const lane = opts.dailyRangeLane?.() ?? null;
    if (!lane) {
      reply.code(503);
      return { ok: false, reason: "daily range lane is unavailable" };
    }
    const result = lane.arm();
    if (!result.ok) reply.code(409);
    return result;
  });

  app.post("/api/live/daily-range-lane/disarm", async (request, reply) => {
    if (!isLoopbackAddress(request.ip) || process.env.LIVE_BINANCE_ENV !== "testnet") {
      reply.code(403);
      return { ok: false, reason: "Testnet loopback caller required" };
    }
    const body = (request.body ?? {}) as { confirm?: string; reason?: string };
    if (body.confirm !== "DISARM_DAILY_RANGE_LANE") {
      reply.code(400);
      return { ok: false, reason: 'disarm requires body {"confirm":"DISARM_DAILY_RANGE_LANE"}' };
    }
    const lane = opts.dailyRangeLane?.() ?? null;
    if (!lane) {
      reply.code(503);
      return { ok: false, reason: "daily range lane is unavailable" };
    }
    return lane.disarm(typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "operator manual disarm");
  });

  app.post("/api/live/daily-range-lane/close", async (request, reply) => {
    if (!isLoopbackAddress(request.ip) || process.env.LIVE_BINANCE_ENV !== "testnet") {
      reply.code(403);
      return { ok: false, reason: "Testnet loopback caller required" };
    }
    const body = (request.body ?? {}) as { confirm?: string; tradeId?: string };
    if (body.confirm !== "CLOSE_DAILY_RANGE_TRADE" || typeof body.tradeId !== "string" || !body.tradeId.trim()) {
      reply.code(400);
      return { ok: false, reason: 'close requires body {"confirm":"CLOSE_DAILY_RANGE_TRADE","tradeId":"..."}' };
    }
    const lane = opts.dailyRangeLane?.() ?? null;
    if (!lane) {
      reply.code(503);
      return { ok: false, reason: "daily range lane is unavailable" };
    }
    const result = await lane.manualCloseTrade(body.tradeId.trim());
    if (!result.ok) reply.code(409);
    return result;
  });

  /**
   * Read-only continuation lifecycle health. This is deliberately independent of executor state:
   * a collector/trainer issue can surface here without pausing or changing a basket process.
   */
  app.get("/api/live/cross-sectional/continuation-lifecycle/status", async () => {
    const paths = continuationPaths();
    const status = readLifecycleStatus(paths);
    const collector = readCollectorHealth(paths);
    const labelMaturation = readLabelMaturationStatus(paths);
    return {
      configured: Boolean(process.env.CONTINUATION_LIFECYCLE_ROOT?.trim()),
      mode: status?.mode ?? "AUTO_PROMOTION_STRICT_GATE",
      lifecycle: status,
      collector: collector ?? status?.collector ?? null,
      labelMaturation,
      runtimeArtifact: dynamicMom36ContinuationArtifactStatus(),
      pendingCommands: queuedLifecycleCommands(paths).map((command) => ({
        commandId: command.commandId,
        command: command.command,
        requestedAt: command.requestedAt,
      })),
    };
  });

  /** Model detail stays compact: provenance/metrics only, never model-tree or raw-market data. */
  app.get("/api/live/cross-sectional/continuation-lifecycle/model", async () => {
    const paths = continuationPaths();
    return {
      ...continuationChampionDetail(paths),
      runtimeArtifact: dynamicMom36ContinuationArtifactStatus(),
    };
  });

  /**
   * Commands are local-only and asynchronous. The API writes a request for the low-priority
   * lifecycle owner; it cannot synchronously train, promote or rollback while serving traffic.
   */
  app.post("/api/live/cross-sectional/continuation-lifecycle/control", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      reply.code(403);
      return { ok: false, reason: "loopback caller required" };
    }
    const body = (request.body ?? {}) as { confirm?: string; command?: ContinuationLifecycleCommand };
    const allowed: ContinuationLifecycleCommand[] = [
      "PAUSE_TRAINING", "RESUME_TRAINING", "INTEGRITY_CHECK", "TRAIN_CHALLENGER",
      "DISABLE_AUTO_PROMOTION", "ENABLE_AUTO_PROMOTION", "ROLLBACK_CHAMPION",
    ];
    if (body.confirm !== "QUEUE_CONTINUATION_LIFECYCLE_COMMAND" || !body.command || !allowed.includes(body.command)) {
      reply.code(400);
      return {
        ok: false,
        reason: "requires {confirm:'QUEUE_CONTINUATION_LIFECYCLE_COMMAND',command:'PAUSE_TRAINING|RESUME_TRAINING|INTEGRITY_CHECK|TRAIN_CHALLENGER|DISABLE_AUTO_PROMOTION|ENABLE_AUTO_PROMOTION|ROLLBACK_CHAMPION'}",
      };
    }
    const queued = queueLifecycleCommand(body.command, continuationPaths());
    return { ok: true, queued };
  });

  // Emergency/operator close for the primary cross-basket executor in BOTH TESTNET and LIVE.
  // This is deliberately narrower than an account flatten: it requires a loopback caller,
  // an exact basket id, and exactly one live basket in THIS executor before it invokes the
  // executor's netting-aware reduce-only close path. It also drains NEW admissions first, so a
  // manual close cannot race an immediately-created replacement basket.
  app.post("/api/live/cross-sectional-close", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      reply.code(403);
      return { ok: false, reason: "loopback caller required" };
    }
    const body = (request.body ?? {}) as { confirm?: string; basketId?: string };
    if (body.confirm !== "CLOSE_ONLY_THIS_CROSS_SECTIONAL_BASKET" || !body.basketId) {
      reply.code(400);
      return {
        ok: false,
        reason: 'close requires body {"confirm":"CLOSE_ONLY_THIS_CROSS_SECTIONAL_BASKET","basketId":"..."}',
      };
    }
    const executor = opts.crossSectionalExecutor?.() ?? null;
    if (!executor) {
      reply.code(503);
      return { ok: false, reason: "cross-sectional executor disabled" };
    }
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution engine unavailable; cannot safely drain new admissions" };
    }

    const before = executor.getStatus();
    const liveBaskets = before.openBaskets;
    const target = liveBaskets.find((basket) => basket.basketId === body.basketId);
    if (!target) {
      reply.code(404);
      return { ok: false, reason: "target basket is not open in the market-neutral executor", basketId: body.basketId };
    }
    // closeAllBasketsOrderly is intentionally the executor's established safe close path, but
    // it closes every live basket owned by that executor. Refuse rather than accidentally widen
    // a request for one basket into a bulk close.
    if (liveBaskets.length !== 1) {
      reply.code(409);
      return {
        ok: false,
        reason: "refused: more than one market-neutral basket is open; no basket was closed",
        basketId: body.basketId,
        openBasketIds: liveBaskets.map((basket) => basket.basketId),
      };
    }

    const drain = engine.setNewEntriesPaused(true, `operator scoped cross-basket close: ${body.basketId}`);
    const result = await executor.closeAllBasketsOrderly(`OPERATOR_SCOPED_CLOSE:${body.basketId}`);
    const after = executor.getStatus();
    const stillOpen = after.openBaskets.some((basket) => basket.basketId === body.basketId);
    if (result.closed !== 1 || result.failed !== 0 || stillOpen) {
      reply.code(409);
      return {
        ok: false,
        reason: "close did not complete cleanly; inspect executor status before retrying",
        basketId: body.basketId,
        result,
        openBasketIds: after.openBaskets.map((basket) => basket.basketId),
      };
    }
    return {
      ok: true,
      laneId: before.laneId,
      basketId: body.basketId,
      newEntryDrain: drain,
      result,
      openBasketIds: after.openBaskets.map((basket) => basket.basketId),
    };
  });

  // Testnet-only operational probe: invokes the exact same executor tick used
  // by the scheduled loop. It never bypasses arm, market-neutral admission,
  // sizing, or all-leg abort safeguards.
  app.post("/api/live/cross-sectional-tick", async (request, reply) => {
    if (process.env.LIVE_BINANCE_ENV !== "testnet") {
      reply.code(403);
      return { ok: false, reason: "testnet only" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "TICK_CROSS_SECTIONAL") {
      reply.code(400);
      return { ok: false, reason: 'tick requires body {"confirm":"TICK_CROSS_SECTIONAL"}' };
    }
    const executor = opts.crossSectionalExecutor?.() ?? null;
    if (!executor) {
      reply.code(503);
      return { ok: false, reason: "cross-sectional executor disabled" };
    }
    await executor.tick();
    return { ok: true, ...executor.getStatus() };
  });

  // Testnet-only operational probe for the scanner-led directional companions.
  // It calls the same guarded tick used by the automatic scheduler; it cannot
  // bypass the arm, fresh-signal, stop, exposure, or reversal rules.
  app.post("/api/live/cross-sectional-directional-tick", async (request, reply) => {
    if (process.env.LIVE_BINANCE_ENV !== "testnet") {
      reply.code(403);
      return { ok: false, reason: "testnet only" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "TICK_DIRECTIONAL") {
      reply.code(400);
      return { ok: false, reason: 'tick requires body {"confirm":"TICK_DIRECTIONAL"}' };
    }
    const shortExecutor = opts.crossSectionalDirectionalShortExecutor?.() ?? null;
    const longExecutor = opts.crossSectionalDirectionalLongExecutor?.() ?? null;
    if (!shortExecutor && !longExecutor) {
      reply.code(503);
      return { ok: false, reason: "directional executors disabled" };
    }
    await shortExecutor?.tick();
    await longExecutor?.tick();
    return {
      ok: true,
      decision: opts.directionalRegimeDecision?.() ?? null,
      short: shortExecutor?.getStatus() ?? null,
      long: longExecutor?.getStatus() ?? null,
    };
  });

  /**
   * 2026-08-12 (operator request): every CLOSED cross-sectional basket with its realized P&L broken
   * out PER TOKEN, plus when it opened and closed.
   *
   * REAL FILLS ONLY. This reads the executor stores, not the measurement store — so a basket appears
   * here only once it has actually opened and closed on the exchange. An empty list is reported with
   * an explicit reason rather than as an empty success, because "no rows" here has historically been
   * misread as "the lane lost nothing" when it in fact meant "the lane never traded".
   * See closedBasketRealizedBreakdown for the two provenance caveats (fees are APPORTIONED per leg,
   * and an unconfirmed fill price makes that leg's figure unreliable) — both are in the payload.
   */
  /**
   * Shadow counterfactual for the XSEC directional lanes (REPORT-ONLY, 2026-08-15).
   *
   * For every position the regime overlay closed, replays the lane's OWN exits forward over real
   * 5m candles and reports what it would have returned instead. Places no orders, mutates no store,
   * and no execution path imports it. Cached 5 minutes so refreshing cannot hammer the exchange.
   */
  app.get("/api/live/directional-overlay-counterfactual", async () => buildOverlayCf());

  /**
   * Same data, rendered as a self-contained page (2026-08-15).
   *
   * Served BY THE API on purpose: the dashboard bundle under /root/kronos-web-current is built and
   * deployed by the other agent, and this repo's own rule is that a `dist/` deploy silently
   * overwrites whatever that agent shipped. Adding a route cannot collide with it — no bundle is
   * rebuilt, no file of theirs is touched. No external assets, so no CSP or CDN dependency.
   */
  /**
   * Honest view of the cross-sectional symbol pool (2026-08-16).
   *
   * The dashboard previously labelled this "POOL OPERATOR", which stopped being true the moment
   * the list became criteria-derived, and showed exclusions with no reason at all — BTC appeared
   * as "temporarily excluded" when in fact its minimum lot is 2.4x the leg, which is permanent for
   * as long as the leg stays this size. A pool view that cannot say WHY a symbol is in or out is
   * how a hand-picked list survives for months without anyone being able to question it.
   *
   * Served by the API, like the counterfactual page, so no dashboard bundle is rebuilt and nothing
   * the other agent deployed can be overwritten.
   */
  const buildPoolReport = async (): Promise<PoolReport> => {
    const now = Date.now();
    if (poolReportCache && now - poolReportCache.atMs < 15 * 60_000) return poolReportCache.report;
    const list = (k: string): string[] => (process.env[k] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const universe = list("CROSS_SECTIONAL_UNIVERSE");
    const configuredLong = list("CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST");
    const configuredShort = list("CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST");
    const shortBlock = new Set(list("CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST"));
    const baseLeg = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_LEG_USD ?? "") || 25;
    const mult = Number.parseFloat(process.env.CROSS_SECTIONAL_TESTNET_LEARNING_LEG_MULTIPLIER ?? "") || 1;
    const leg = effectiveLegUsd(baseLeg, mult);
    // Dynamic auto-pool is intentionally symmetric.  If a future operator chooses asymmetric
    // static sides, report that static policy honestly rather than inventing a side-aware rule.
    const symmetricConfiguredPool = configuredLong.length === configuredShort.length
      && configuredLong.every((symbol) => configuredShort.includes(symbol));
    const autoPoolInput = {
      candidateUniverse: universe,
      fallbackSymbols: configuredLong,
      baseLegUsd: baseLeg,
      sizeMultiplier: mult,
    };
    const autoPoolManager = symmetricConfiguredPool ? opts.crossSectionalAutoPool?.() ?? null : null;
    // The endpoint can safely await this bounded public-metadata refresh: it is cadence-gated and
    // gives the operator the actual membership immediately after a process restart, not a static
    // fallback that happens to be cached for fifteen minutes.
    const autoPool = autoPoolManager ? await autoPoolManager.refreshIfDue(autoPoolInput) : null;
    const runtimeSymbols = autoPool?.enabled && autoPool.activeSymbols.length > 0
      ? autoPool.activeSymbols
      : null;
    const longAllow = new Set(runtimeSymbols ?? configuredLong);
    const shortAllow = new Set(runtimeSymbols ?? configuredShort);

    const filters = new Map<string, { minNotional: number | null; stepSize: number | null; minQty: number | null }>();
    const ticks = new Map<string, { price: number; quoteVolume: number }>();
    let measured = false;
    try {
      const info = (await (await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo")).json()) as { symbols?: Array<Record<string, unknown>> };
      for (const sym of info.symbols ?? []) {
        const fs = (sym.filters as Array<Record<string, unknown>>) ?? [];
        const lot = fs.find((f) => f.filterType === "LOT_SIZE");
        const mn = fs.find((f) => f.filterType === "MIN_NOTIONAL");
        filters.set(String(sym.symbol), {
          minNotional: mn ? Number(mn.notional ?? mn.minNotional ?? 0) : null,
          stepSize: lot ? Number(lot.stepSize) : null,
          minQty: lot ? Number(lot.minQty) : null,
        });
      }
      const tk = (await (await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr")).json()) as Array<Record<string, unknown>>;
      for (const t of tk) ticks.set(String(t.symbol), { price: Number(t.lastPrice), quoteVolume: Number(t.quoteVolume) });
      measured = filters.size > 0 && ticks.size > 0;
    } catch { /* measured stays false — see PoolReport.measured for why that is not the same as failing */ }

    const verdicts: EligibilityVerdict[] = universe.map((symbol) => {
      const f = filters.get(symbol);
      const t = ticks.get(symbol);
      const input: SymbolEligibilityInput = {
        symbol,
        quoteVolume24hUsd: t ? t.quoteVolume : null,
        price: t ? t.price : null,
        minNotionalUsd: f ? f.minNotional : null,
        stepSize: f ? f.stepSize : null,
        minQty: f ? f.minQty : null,
        // C3/C4 butuh satu panggilan per simbol; tidak dievaluasi di tampilan ini dan
        // ditandai sebagai TIDAK DIUKUR, bukan diloloskan diam-diam.
        listedAtMs: null,
        medianAbsFundingRatePerPeriod: null,
        maxCorrelationToAccepted: null,
      };
      return evaluateSymbolEligibility(input, now, leg);
    });

    const c12Fail = (v: EligibilityVerdict) => v.failures.filter((x) => x.code === "C1_LIQUIDITY" || x.code === "C2_LOT_TOO_LARGE");
    const reportRows: PoolReportRow[] = verdicts.map((v) => {
      const fails = c12Fail(v);
      const inPool = longAllow.has(v.symbol);
      const passes = fails.length === 0;
      return {
        symbol: v.symbol,
        liquidityUsdPerHour: v.measured.liquidityUsdPerHour,
        oneLotUsd: v.measured.oneLotUsd,
        failures: fails.map((f) => ({ code: f.code, detail: f.detail })),
        passesEvaluated: passes,
        inPool,
        shortBlocked: shortBlock.has(v.symbol),
        // With no exchange read there is nothing to agree or disagree WITH, so an unmeasured run
        // must not manufacture 20 mismatches out of its own missing data.
        agreesWithCriteria: measured ? passes === inPool : true,
      };
    });

    const btcLot = measured && ticks.get("BTCUSDT")
      ? oneLotNotionalUsd({
          price: ticks.get("BTCUSDT")!.price,
          minNotionalUsd: filters.get("BTCUSDT")?.minNotional ?? null,
          stepSize: filters.get("BTCUSDT")?.stepSize ?? null,
          minQty: filters.get("BTCUSDT")?.minQty ?? null,
        })
      : null;

    const report: PoolReport = {
      generatedAt: new Date(now).toISOString(),
      measured,
      leg: {
        baseUsd: baseLeg,
        multiplier: mult,
        effectiveUsd: leg,
        oneLotCeilingUsd: leg === null ? null : leg * DEFAULT_ELIGIBILITY.maxLotFractionOfLeg,
      },
      thresholds: {
        minLiquidityUsdPerHour: DEFAULT_ELIGIBILITY.minLiquidityUsdPerHour,
        maxLotFractionOfLeg: DEFAULT_ELIGIBILITY.maxLotFractionOfLeg,
        minListedDays: DEFAULT_ELIGIBILITY.minListedDays,
        maxFundingCarryBps: DEFAULT_ELIGIBILITY.maxFundingCarryBps,
        maxCorrelation: DEFAULT_ELIGIBILITY.maxCorrelation,
      },
      counts: {
        universe: universe.length,
        passesEvaluated: reportRows.filter((r) => r.passesEvaluated).length,
        poolLong: longAllow.size,
        poolShort: shortAllow.size,
        shortBlocked: shortBlock.size,
        shortEligible: [...shortAllow].filter((s) => !shortBlock.has(s)).length,
      },
      rows: reportRows,
      mismatch: reportRows.filter((r) => !r.agreesWithCriteria).map((r) => r.symbol),
      blockedInPool: [...shortBlock].filter((s) => longAllow.has(s)),
      btc: {
        oneLotUsd: btcLot,
        legNeededUsd: btcLot === null ? null : btcLot / DEFAULT_ELIGIBILITY.maxLotFractionOfLeg,
      },
      reconciliation: (() => {
        const pl = poolReconciliationPlan(
          reportRows.map((r) => ({
            symbol: r.symbol, liquidityUsdPerHour: r.liquidityUsdPerHour,
            oneLotUsd: r.oneLotUsd, inPool: r.inPool, hasOpenPosition: false,
          })),
          {
            minLiquidityUsdPerHour: DEFAULT_ELIGIBILITY.minLiquidityUsdPerHour,
            maxOneLotUsd: leg === null ? Number.POSITIVE_INFINITY : leg * DEFAULT_ELIGIBILITY.maxLotFractionOfLeg,
            hysteresisFraction: 0.10,
            minPoolSize: 8,
          },
        );
        return {
          changed: pl.changed, adds: pl.adds, drops: pl.drops,
          held: pl.heldDespiteFailure.map((d) => ({ symbol: d.symbol, action: d.action, reason: d.reason })),
          unmeasured: pl.unmeasured,
        };
      })(),
      autoPool,
      automation: autoPool,
      unevaluatedCriteria: [
        { code: "C3_LISTING_AGE", why: "butuh satu panggilan riwayat per simbol" },
        { code: "C4_FUNDING_CARRY", why: "butuh riwayat funding per simbol" },
        { code: "C5_CORRELATION", why: "butuh riwayat harga seluruh pool" },
      ],
    };
    poolReportCache = { atMs: now, report };
    return report;
  };

  /** Same report as the page below, as JSON, so the dashboard panel renders MEASURED numbers rather
   *  than prose someone typed once and nobody re-checked. One cache, one source of truth. */
  app.get("/api/live/cross-sectional-pool", async () => buildPoolReport());

  // 2026-08-17: the two recorders installed today. Kept on their own page because both are
  // ACCUMULATING — nothing here is conclusive yet, and mixing them into an existing panel would
  // invite reading them as results.
  const readInstrumentation = () => {
    const readIf = (path: string): string => {
      try { return existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { return ""; }
    };
    const microDir = process.env.MICROSTRUCTURE_DIR ?? "/root/kronos-microstructure";
    let microText = "";
    try {
      // The recorder rotates monthly; read every month present so the page keeps full coverage.
      const files = existsSync(microDir)
        ? readdirSync(microDir).filter((f) => f.startsWith("micro-") && f.endsWith(".jsonl")).sort()
        : [];
      microText = files.map((f) => readIf(resolve(microDir, f))).join("\n");
    } catch { microText = ""; }
    return buildInstrumentationReport(readIf(rejectedBasketLogPath()), microText, {
      nowMs: Date.now(),
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
    });
  };

  app.get("/api/live/instrumentation", async () => ({ ok: true, report: readInstrumentation() }));

  app.get("/api/live/instrumentation/view", async (_request, reply) => {
    const r = readInstrumentation();
    const esc = (v: unknown): string => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
    const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
    const legs = (xs: Array<{ symbol: string; score: number }>) =>
      xs.map((x) => `<span class="sym">${esc(x.symbol.replace("USDT", ""))}</span> ${(x.score * 100 >= 0 ? "+" : "")}${(x.score * 100).toFixed(2)}%`).join(" &middot; ");
    const short = (iso: string | null) => (iso ? esc(iso.slice(0, 16).replace("T", " ")) : "&mdash;");

    const rejectedRows = r.rejected.rows.length === 0
      ? `<tr><td colspan="5" class="muted">Belum ada basket yang ditolak sejak pencatatan dipasang. Gerbang 2% menolak sekitar 0,2% basket, jadi ini bisa butuh berhari-hari.</td></tr>`
      : r.rejected.rows.map((x) => `<tr>
<td>${short(new Date(x.openedAtMs).toISOString())}</td>
<td class="num">${pct(x.scoreGap)}</td>
<td class="num ${x.shortfallPp <= 0.5 ? "bad" : "muted"}">&minus;${x.shortfallPp.toFixed(3)}pp</td>
<td>${legs(x.longs)}</td>
<td>${legs(x.shorts)}</td>
</tr>`).join("");

    const microRows = r.micro.latest.length === 0
      ? `<tr><td colspan="6" class="muted">Belum ada snapshot. Perekam jalan tiap jam di menit :47.</td></tr>`
      : r.micro.latest.map((m) => `<tr>
<td class="sym">${esc(m.sym.replace("USDT", ""))}</td>
<td class="num">${m.oi === null || m.oi === undefined ? "&mdash;" : m.oi.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
<td class="num">${m.spreadBps === null || m.spreadBps === undefined ? "&mdash;" : m.spreadBps.toFixed(2)}</td>
<td class="num">${m.bidUsd20 === undefined ? "&mdash;" : "$" + Math.round(m.bidUsd20).toLocaleString("en-US")}</td>
<td class="num">${m.askUsd20 === undefined ? "&mdash;" : "$" + Math.round(m.askUsd20).toLocaleString("en-US")}</td>
<td class="num ${(m.imb20 ?? 0) >= 0 ? "ok" : "bad"}">${m.imb20 === undefined ? "&mdash;" : (m.imb20 >= 0 ? "+" : "") + m.imb20.toFixed(3)}</td>
</tr>`).join("");

    const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pencatatan Baru</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--card:#f9fafb;--ok:#047857;--bad:#b91c1c;--warnbg:#fef3c7;--warnfg:#92400e}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--mut:#9ca3af;--line:#272b33;--card:#161a20;--ok:#34d399;--bad:#f87171;--warnbg:#3b2f0b;--warnfg:#fcd34d}}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto}h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px}
.muted{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.note{background:var(--warnbg);color:var(--warnfg);padding:10px 13px;border-radius:8px;font-size:13px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin:12px 0}
.grid div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
.grid span{display:block;color:var(--mut);font-size:11.5px;margin-bottom:3px}.grid b{font-size:16px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
.num{text-align:right;font-variant-numeric:tabular-nums}.sym{font-weight:600}
.wrapx{overflow-x:auto}code{background:var(--card);padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<h1>Pencatatan baru &mdash; dua pertanyaan yang tadinya tidak bisa dijawab</h1>
<p class="muted">Dipasang 17 Agu 2026. Keduanya masih <b>mengumpul</b> &mdash; tidak ada kesimpulan di halaman ini, dan angkanya belum boleh dipakai untuk mengubah aturan.</p>

<h2>1. Basket yang ditolak gerbang <code>minScoreGap</code></h2>
<p class="muted">Sebelum ini, basket yang ditolak <b>tidak ditulis ke mana pun</b>. Store hidup memuat <b>nol</b> observasi di bawah ambang 0,02 (minimum tercatat: 0,0202 FILTERED / 0,0315 RAW), jadi pertanyaan &ldquo;apakah ambang 2% ini benar?&rdquo; tidak akan pernah terjawab dari data hidup, berapa lama pun lane berjalan. Datanya bukan langka &mdash; datanya tidak pernah dibuat.</p>
<div class="grid">
<div><span>Tercatat</span><b>${r.rejected.count}</b></div>
<div><span>Selisih &le; 0,5pp</span><b>${r.rejected.nearMisses}</b></div>
<div><span>Horizon evaluasi</span><b>${Math.round(r.rejected.horizonMs / 3_600_000)} jam</b></div>
</div>
<p class="muted">Kolom <b>selisih</b> menunjukkan seberapa jauh di bawah ambang. Ditolak 0,05pp itu fakta yang sangat berbeda dari ditolak 1,5pp &mdash; log mentah tidak membedakannya.</p>
<div class="wrapx"><table><thead><tr><th>Waktu (UTC)</th><th class="num">Gap</th><th class="num">Selisih</th><th>Long yang batal</th><th>Short yang batal</th></tr></thead><tbody>${rejectedRows}</tbody></table></div>

<h2>2. Open interest + kedalaman orderbook</h2>
<p class="muted"><code>futures/data/*</code> hanya menyimpan ~30 hari (= 15 blok 48 jam) dan kedalaman orderbook tidak punya riwayat sama sekali, jadi keduanya <b>tidak bisa diuji retrospektif</b>. Satu-satunya jalan adalah mulai mencatat. Perekam berdiri di luar API trading, jadi nol risiko terhadap eksekusi.</p>
<div class="grid">
<div><span>Simbol</span><b>${r.micro.symbols}</b></div>
<div><span>Snapshot</span><b>${r.micro.snapshots.toLocaleString("en-US")}</b></div>
<div><span>Jam tercakup</span><b>${r.micro.hoursCovered.toFixed(1)}</b></div>
<div><span>Blok 48j terkumpul</span><b>${r.micro.blocks} / ${r.micro.blocksNeeded}</b></div>
</div>
<div class="note">Butuh sekitar <b>${r.micro.blocksNeeded} blok</b> (&asymp;90 hari) sebelum sinyal dari data ini bisa dinilai. Sekarang <b>${r.micro.blocks}</b>. Sampai itu tercapai, tabel di bawah cuma snapshot terakhir &mdash; bukan bukti apa pun.</div>
<p class="muted">Pertama: ${short(r.micro.firstAt)} &middot; terakhir: ${short(r.micro.lastAt)}. <code>imb20</code> positif = sisi beli lebih tebal pada 20 level teratas.</p>
<div class="wrapx"><table><thead><tr><th>Simbol</th><th class="num">Open interest</th><th class="num">Spread (bps)</th><th class="num">Bid 20 lvl</th><th class="num">Ask 20 lvl</th><th class="num">imb20</th></tr></thead><tbody>${microRows}</tbody></table></div>

<p class="muted" style="margin-top:22px">Dibuat ${esc(r.generatedAt)}. JSON: <code>/api/live/instrumentation</code></p>
</div></body></html>`;
    reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/api/live/cross-sectional-pool/view", async (_request, reply) => {
    const report = await buildPoolReport();
    const now = Date.parse(report.generatedAt);
    const esc = (v: unknown): string => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
    const { measured, leg: legInfo, counts, blockedInPool } = report;
    const autoPool = report.autoPool;
    const autoPoolEnabled = autoPool?.enabled === true;
    const leg = legInfo.effectiveUsd;
    const baseLeg = legInfo.baseUsd;
    const mult = legInfo.multiplier;
    const shortBlock = report.rows.filter((r) => r.shortBlocked).map((r) => r.symbol);
    const universe = report.rows.map((r) => r.symbol);
    const eligible = report.rows.filter((r) => r.passesEvaluated);
    // Computed once inside buildPoolReport and shared with the dashboard panel via JSON, so the
    // two surfaces cannot drift into disagreeing about the same symbol again.
    const plan = report.reconciliation;
    const actionFor = new Map(plan.held.map((d) => [d.symbol, d]));
    const needsAction = new Set([...plan.adds, ...plan.drops]);
    const rows = report.rows.map((r) => `<tr class="${r.passesEvaluated ? "" : "out"}">
        <td class="sym">${esc(r.symbol.replace("USDT", ""))}</td>
        <td class="num">${r.liquidityUsdPerHour === null ? "—" : "$" + Math.round(r.liquidityUsdPerHour / 1000) + "k"}</td>
        <td class="num">${r.oneLotUsd === null ? "—" : "$" + r.oneLotUsd.toFixed(2)}</td>
        <td>${!measured ? '<span class="muted">tidak terukur</span>' : r.failures.length ? `<span class="bad">${r.failures.map((f) => esc(f.detail)).join("; ")}</span>` : `<span class="ok">memenuhi C1 &amp; C2</span>`}</td>
        <td>${r.inPool ? "<b>di pool</b>" : "<span class=\"muted\">di luar</span>"}${
        needsAction.has(r.symbol) ? ' <span class="warn">&#9888; perlu diubah</span>'
        : (actionFor.get(r.symbol)?.action ?? "").startsWith("HOLD") ? ' <span class="muted">&#9679; dalam pita, dipertahankan</span>'
        : ""}</td>
        <td>${r.shortBlocked ? '<span class="warn">short diblokir</span>' : ""}</td>
      </tr>`).join("");

    const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pool Cross-Sectional</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--card:#f9fafb;--ok:#047857;--bad:#b91c1c;--warnbg:#fef3c7;--warnfg:#92400e}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--mut:#9ca3af;--line:#272b33;--card:#161a20;--ok:#34d399;--bad:#f87171;--warnbg:#3b2f0b;--warnfg:#fcd34d}}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto}h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px}
.muted{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warnfg)}
.note{background:var(--warnbg);color:var(--warnfg);padding:10px 13px;border-radius:8px;font-size:13px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin:12px 0}
.grid div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
.grid span{display:block;color:var(--mut);font-size:11.5px;margin-bottom:3px}.grid b{font-size:16px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
.num{text-align:right;font-variant-numeric:tabular-nums}.sym{font-weight:600}tr.out td{opacity:.62}
.wrapx{overflow-x:auto}code{background:var(--card);padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<h1>Pool Cross-Sectional — dari kriteria, bukan pilihan tangan</h1>
<p class="muted">Daftar ini <b>diturunkan dari kriteria objektif</b>, bukan dipilih manual. Tiap simbol di bawah menunjukkan angka terukurnya dan kriteria mana yang tidak dipenuhi. Sebelumnya panel ini berlabel &ldquo;POOL OPERATOR&rdquo; dan menampilkan pengecualian tanpa alasan apa pun.</p>

<div class="grid">
  <div><span>leg efektif</span><b>$${leg === null ? "—" : leg.toFixed(2)}</b></div>
  <div><span>base &times; pengali</span><b>$${baseLeg} &times; ${mult}</b></div>
  <div><span>plafon satu lot (C2)</span><b>$${leg === null ? "—" : (leg * DEFAULT_ELIGIBILITY.maxLotFractionOfLeg).toFixed(2)}</b></div>
  <div><span>universe</span><b>${universe.length}</b></div>
  <div><span>memenuhi C1 &amp; C2</span><b>${eligible.length}</b></div>
  <div><span>pool aktif (long)</span><b>${counts.poolLong}</b></div>
</div>

${!measured
  ? `<div class="note">&#9888; <b>Kriteria tidak bisa diukur sekarang</b> &mdash; pembacaan exchange gagal, jadi kolom likuiditas, satu lot dan status di bawah kosong. Ini BUKAN berarti simbol-simbol itu gagal kriteria; belum ada yang diuji. Pool aktif tetap ditampilkan apa adanya.</div>`
  : autoPool?.state === "STALE_FALLBACK"
    ? `<div class="note">&#9888; <b>Auto-pool belum memiliki snapshot C1/C2 yang valid.</b> Sementara memakai fallback terakhir dan tidak memperlebar universe. Refresh otomatis akan mencoba lagi; basket yang sudah terbuka tidak disentuh.</div>`
  : plan.changed
    ? `<div class="note">&#9888; <b>Pool auto akan merekonsiliasi</b>: ${[...plan.adds.map((x) => "tambah " + esc(x.replace("USDT", ""))), ...plan.drops.map((x) => "keluarkan " + esc(x.replace("USDT", "")))].join(" &middot; ")}. Berlaku otomatis pada refresh berikutnya untuk basket baru; basket terbuka tidak disentuh.</div>`
    : plan.held.length
      ? `<div class="note">&#9679; <b>Tidak ada yang perlu diubah.</b> ${plan.held.map((d) => esc(d.symbol.replace("USDT", ""))).join(", ")} berada di bawah ambang mentah tetapi <b>di dalam pita histeresis</b>, jadi keanggotaannya sengaja dipertahankan &mdash; tanpa pita, simbol di garis batas akan keluar-masuk tiap beberapa jam. Kolom status di bawah tetap menampilkan vonis kriteria mentahnya, karena itu memang fakta.</div>`
      : `<div class="note" style="background:transparent;color:var(--ok);padding-left:0">&#10003; ${autoPoolEnabled ? "Auto-pool aktif; " : ""}pool aktif sama persis dengan hasil kriteria.</div>`}

<h2>Per simbol</h2>
<div class="wrapx"><table><thead><tr>
<th>simbol</th><th class="num">likuiditas/jam</th><th class="num">satu lot</th><th>C1 &amp; C2</th><th>status</th><th>catatan</th>
</tr></thead><tbody>${rows}</tbody></table></div>

${(() => {
  const act = [...plan.adds.map((x) => ({ symbol: x, action: "ADD", reason: "melewati batas masuk" })), ...plan.drops.map((x) => ({ symbol: x, action: "DROP", reason: "di bawah batas keluar" })), ...plan.held];
  if (plan.unmeasured) return `<h2>Rekonsiliasi pool</h2><div class="note">Tidak ada simbol yang terukur — tidak ada keputusan yang bisa dipercaya, dan rencana ini TIDAK boleh diterapkan.</div>`;
  return `<h2>Rekonsiliasi pool</h2>
<p class="muted">Pita histeresis <b>&plusmn;10%</b>: masuk perlu &ge; $${Math.round(report.thresholds.minLiquidityUsdPerHour * 1.1).toLocaleString("en-US")}/jam, keluar baru di bawah $${Math.round(report.thresholds.minLiquidityUsdPerHour * 0.9).toLocaleString("en-US")}/jam. Simbol di antara keduanya <b>mempertahankan keanggotaannya</b>. ${autoPoolEnabled ? `Auto-pool menyegarkan C1/C2 tiap ${Math.round((autoPool?.refreshEveryMs ?? 900000) / 60000)} menit dari USD-M mainnet dan hanya berlaku untuk basket baru.` : "Auto-pool tidak aktif; daftar statis ditampilkan apa adanya."}</p>
${act.length ? `<div class="wrapx"><table><thead><tr><th>simbol</th><th>tindakan</th><th>alasan</th></tr></thead><tbody>${act.map((d) => `<tr><td class="sym">${esc(d.symbol.replace("USDT", ""))}</td><td class="mono">${esc(d.action)}</td><td class="muted">${esc(d.reason)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Tidak ada simbol yang butuh perhatian.</p>`}
`;
})()}

<h2>Kriteria</h2>
<table><tbody>
<tr><td><b>C1</b> likuiditas</td><td>&ge; $${(DEFAULT_ELIGIBILITY.minLiquidityUsdPerHour / 1000).toFixed(0)}k/jam</td><td class="muted">ongkos eksekusi; ambang yang sudah terpasang sebelumnya</td></tr>
<tr><td><b>C2</b> satu lot</td><td>&le; ${(DEFAULT_ELIGIBILITY.maxLotFractionOfLeg * 100).toFixed(0)}% leg efektif</td><td class="muted">sizing hanya membulatkan NAIK — lot yang lebih besar dari leg merusak netralitas</td></tr>
<tr><td><b>C3</b> umur listing</td><td>&ge; ${DEFAULT_ELIGIBILITY.minListedDays} hari</td><td class="muted">tidak dievaluasi di tampilan ini (butuh satu panggilan per simbol)</td></tr>
<tr><td><b>C4</b> carry funding</td><td>&le; ${DEFAULT_ELIGIBILITY.maxFundingCarryBps} bps/hold</td><td class="muted">tidak dievaluasi di tampilan ini</td></tr>
<tr><td><b>C5</b> korelasi</td><td>&le; ${DEFAULT_ELIGIBILITY.maxCorrelation}</td><td class="muted">tidak dievaluasi di tampilan ini (butuh riwayat harga)</td></tr>
</tbody></table>
<p class="muted">C3&ndash;C5 <b>tidak diukur di halaman ini</b> dan karenanya tidak ikut menentukan kolom status &mdash; itu dinyatakan, bukan disembunyikan. Pada universe saat ini ketiganya tidak menyaring siapa pun; yang membedakan hanya C1 dan C2.</p>

<h2>Blocklist short &mdash; satu-satunya daftar tangan yang tersisa</h2>
<p><code>${[...shortBlock].map((s) => esc(s.replace("USDT", ""))).join(", ") || "(kosong)"}</code></p>
<div class="note">Daftar ini <b>tidak punya kriteria</b>. Tidak ada alasan tercatat kenapa simbol-simbol ini tidak boleh di-short, dan tidak ada aturan yang bisa dipakai untuk menambah atau mengeluarkan anggotanya.
${blockedInPool.length ? ` Saat ini ${blockedInPool.length} di antaranya ada di pool aktif (${blockedInPool.map((s) => esc(s.replace("USDT", ""))).join(", ")}), jadi hanya boleh dipakai di sisi long.` : ""}
Diukur 2026-08-16 pada pool 20 simbol, biayanya <b>&minus;0,8 bps median</b> &mdash; jadi pertanyaannya bukan biaya, tapi konsistensi.</div>

<h2>Kenapa BTC di luar</h2>
<p>Bukan &ldquo;sementara&rdquo;. Satu lot minimum BTC adalah <b>$${report.btc.oneLotUsd === null ? "—" : report.btc.oneLotUsd.toFixed(2)}</b>,
sementara plafon C2 pada leg $${leg === null ? "—" : leg.toFixed(2)} adalah $${legInfo.oneLotCeilingUsd === null ? "—" : legInfo.oneLotCeilingUsd.toFixed(2)}. Itu berlaku selama leg-nya sebesar ini &mdash; BTC baru bisa masuk kalau leg dinaikkan ke sekitar $${report.btc.legNeededUsd === null ? "—" : Math.ceil(report.btc.legNeededUsd)}, dan itu keputusan ukuran posisi, bukan sesuatu yang hilang sendiri.</p>

<p class="muted" style="margin-top:26px;border-top:1px solid var(--line);padding-top:14px">
dibuat ${esc(new Date(now).toISOString())} &middot; di-cache 15 menit &middot; disajikan API, bukan dari <code>dist/</code>, supaya deploy dashboard tidak menimpanya
</p>
</div></body></html>`;

    reply.type("text/html; charset=utf-8");
    return html;
  });

  /**
   * Catatan trade lane CROSS_SECTIONAL_DIRECTIONAL — every position, open and closed (2026-08-17).
   *
   * REPURPOSED from the overlay counterfactual, which had frozen: the overlay's last close was
   * 2026-08-14T04:27 and every close since has been the lane's own exit, so the page it fed had
   * stopped accumulating rows and its question — "what would the lane's own exits have returned
   * instead" — stopped being a live decision. The counterfactual JSON endpoint is untouched for
   * anyone who still wants it; this URL now answers the question actually being asked of it, which
   * is what these lanes are doing and which exit is closing them.
   *
   * Reads the executor stores directly, so a row exists only once a position really opened on the
   * exchange. Numbers are FULLY COSTED via fullyCostedNetPnlUsd — 13 of the first 14 positions have
   * entryLegFoldedIntoPnl false, meaning their stored netPnlUsd excludes the entry leg and reads
   * about 0.027R too generous.
   */
  app.get("/api/live/directional-overlay-counterfactual/view", async (_request, reply) => {
    const esc = (v: unknown): string => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
    const r3 = (v: number | null | undefined): string => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(3));
    const usd = (v: number | null | undefined): string => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(4));

    interface LedgerRow {
      lane: string; symbol: string; direction: string; status: string;
      openedAt: string; closedAt: string | null; closeReason: string | null;
      entryPrice: number; exitPrice: number | null; stopPrice: number;
      stopPct: number | null; netUsd: number | null; netR: number | null; costR: number | null;
      peakR: number | null; holdHours: number | null; makerPct: number | null; qty: number;
      slipBps: number | null; spreadBps: number | null; quoteAgeMs: number | null; venueOk: boolean | null;
      geo: { armR: number; givebackFrac: number; profitLockR: number | null; staticTpR: number | null } | null;
    }

    const rows: LedgerRow[] = [];
    let unreadable: string | null = null;
    for (const [lane, file] of [
      ["SHORT", "data/cross-sectional-directional-short-executor.json"],
      ["LONG", "data/cross-sectional-directional-long-executor.json"],
    ] as const) {
      let positions: Array<Record<string, unknown>> = [];
      try {
        positions = (JSON.parse(readFileSync(file, "utf-8")) as { positions?: Array<Record<string, unknown>> }).positions ?? [];
      } catch { unreadable = `${unreadable ?? ""}${lane} `; continue; }
      for (const p of positions) {
        const entry = Number(p.entryPrice); const stop = Number(p.stopPrice); const qty = Number(p.qty);
        const riskUsd = Number.isFinite(entry) && Number.isFinite(stop) && Number.isFinite(qty) ? Math.abs(entry - stop) * qty : Number.NaN;
        const netUsd = fullyCostedNetPnlUsd(p as never);
        const feeUsd = fullyCostedFeeUsd(p as never);
        const openMs = Date.parse(String(p.openedAt ?? ""));
        const closeMs = p.closedAt ? Date.parse(String(p.closedAt)) : Number.NaN;
        const liq = p.entryLiquidity as { makerQty?: number; takerQty?: number } | undefined;
        const liqTotal = liq ? (liq.makerQty ?? 0) + (liq.takerQty ?? 0) : 0;
        rows.push({
          lane, symbol: String(p.symbol ?? "?"), direction: String(p.direction ?? "?"),
          status: String(p.status ?? "?"), openedAt: String(p.openedAt ?? ""),
          closedAt: p.closedAt ? String(p.closedAt) : null,
          closeReason: p.closeReason ? String(p.closeReason) : null,
          entryPrice: entry, exitPrice: p.exitPrice == null ? null : Number(p.exitPrice), stopPrice: stop,
          stopPct: Number.isFinite(entry) && entry > 0 ? Math.abs(entry - stop) / entry * 100 : null,
          netUsd, qty,
          netR: netUsd != null && riskUsd > 0 ? netUsd / riskUsd : null,
          // What the round trip costs as a share of the risk unit. This is the number the stop
          // floor exists to move: it is 8bps/stopWidth and nothing else.
          costR: Number.isFinite(feeUsd as number) && riskUsd > 0 ? (feeUsd as number) / riskUsd : null,
          peakR: typeof p.peakFavorableR === "number" ? p.peakFavorableR : null,
          holdHours: Number.isFinite(openMs) && Number.isFinite(closeMs) ? (closeMs - openMs) / 3600e3 : null,
          makerPct: liqTotal > 0 ? ((liq!.makerQty ?? 0) / liqTotal) * 100 : null,
          geo: (p.exitGeometryAtOpen as LedgerRow["geo"]) ?? null,
          // Entry quality, from the book quote captured immediately before the order went out.
          // SHORT sells into the bid, LONG buys the ask; anything worse than that touch is slippage.
          ...(() => {
            const sr = p.submitRef as { bid?: number; ask?: number; mid?: number; ageAtSubmitMs?: number; venueMatchesExecution?: boolean } | undefined;
            const bid = sr?.bid; const ask = sr?.ask; const mid = sr?.mid;
            const touch = String(p.direction) === "SHORT" ? bid : ask;
            const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
            return {
              slipBps: ok(touch) && ok(entry) && ok(mid)
                ? ((String(p.direction) === "SHORT" ? touch - entry : entry - touch) / mid) * 10000 : null,
              spreadBps: ok(bid) && ok(ask) && ok(mid) ? ((ask - bid) / mid) * 10000 : null,
              quoteAgeMs: typeof sr?.ageAtSubmitMs === "number" ? sr.ageAtSubmitMs : null,
              venueOk: typeof sr?.venueMatchesExecution === "boolean" ? sr.venueMatchesExecution : null,
            };
          })(),
        });
      }
    }
    rows.sort((a, b) => (b.openedAt > a.openedAt ? 1 : b.openedAt < a.openedAt ? -1 : 0));

    const closed = rows.filter((r) => r.status === "CLOSED" && r.netR != null);
    const open = rows.filter((r) => r.status !== "CLOSED");
    const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : Number.NaN);

    // Episodes, not rows. Signals fire in bursts from one market reading; counting rows as
    // independent is how every SE in this system ends up understated.
    const opens = rows.map((r) => Date.parse(r.openedAt)).filter(Number.isFinite).sort((a, b) => a - b);
    const episodes = opens.length ? 1 + opens.slice(1).filter((t, i) => t - opens[i]! >= 86400e3).length : 0;
    const spanDays = opens.length > 1 ? (opens[opens.length - 1]! - opens[0]!) / 86400e3 : 0;

    const byReason = new Map<string, LedgerRow[]>();
    for (const r of closed) {
      const k = (r.closeReason ?? "?").split(":")[0]!;
      byReason.set(k, [...(byReason.get(k) ?? []), r]);
    }
    const bySymbol = new Map<string, LedgerRow[]>();
    for (const r of closed) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);

    // Plain-language reading of each close reason. The enum names describe the MECHANISM; these say
    // what actually happened to the trade, which is what an operator is asking when they read the
    // table. Anything unrecognised falls through with the raw name rather than a made-up gloss.
    const REASON_PLAIN: Record<string, string> = {
      DIRECTIONAL_REVERSAL_CONFIRMED: "Dipotong overlay rezim. Dua scan berturut-turut memastikan arah pasar berbalik melawan posisi, jadi ditutup lebih awal — bukan karena kena target maupun stop.",
      MFE_PROFIT_LOCK: "Untung dikunci. Harga sempat melewati level kunci 0,50R lalu turun balik menembusnya, jadi laba diamankan sebelum sempat hilang.",
      MFE_GIVEBACK: "Untung menyusut. Puncaknya melewati 0,75R lalu harga mengembalikan 30% dari puncak itu, jadi ditutup supaya sisanya tidak ikut hilang.",
      MAX_HOLD_MTM: "Waktu habis. 24 jam berlalu tanpa kena target maupun stop, jadi ditutup di harga pasar apa adanya — untung atau rugi seadanya.",
      INITIAL_STOP: "Kena stop. Harga menembus batas rugi −1R.",
      STATIC_TP: "Kena target tetap.",
      PROFIT_BANK: "Diambil profit-bank saat laba bersih melewati ambang operator.",
    };
    const OWN = new Set(["MFE_PROFIT_LOCK", "MFE_GIVEBACK", "MAX_HOLD_MTM", "INITIAL_STOP", "STATIC_TP"]);
    const ownExits = closed.filter((r) => OWN.has((r.closeReason ?? "").split(":")[0]!));

    const groupRows = (m: Map<string, LedgerRow[]>, explain = false) => [...m.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k, v]) => `<tr><td class="mono">${esc(k)}${explain ? `<div class="plain">${esc(REASON_PLAIN[k] ?? "Alasan ini belum punya penjelasan awam — nama enumnya ditampilkan apa adanya.")}</div>` : ""}</td><td class="num">${v.length}</td>
        <td class="num ${mean(v.map((x) => x.netR!)) >= 0 ? "pos" : "neg"}">${r3(mean(v.map((x) => x.netR!)))}</td>
        <td class="num">${usd(v.reduce((a, x) => a + (x.netUsd ?? 0), 0))}</td>
        <td class="num">${mean(v.map((x) => x.holdHours ?? 0)).toFixed(1)}j</td></tr>`).join("");

    // Level harga dari geometri yang BERLAKU SEKARANG. The store keeps no per-position record of
    // the config it ran under, so a closed position's real levels cannot be reconstructed — these
    // are "where it would exit today", exact for the open position and a reference for the rest.
    // Labelled as such rather than presented as history.
    // Levels come from the geometry each position was OPENED under, frozen onto the record. A
    // position with no snapshot predates that field and its real levels are UNRECOVERABLE — it
    // renders "—" rather than borrowing today's config, which would read as fact and is not:
    // 2026-08-13/14 positions ran armR 0.20 with a price-denominated lock.
    const nowGeo = ownExitParamsFromEnv();
    const priceAtR = (r: LedgerRow, atR: number | null): number | null => {
      if (atR == null || !(atR > 0)) return null;
      if (!Number.isFinite(r.entryPrice) || !Number.isFinite(r.stopPrice)) return null;
      const risk = Math.abs(r.entryPrice - r.stopPrice);
      if (!(risk > 0)) return null;
      return r.direction === "SHORT" ? r.entryPrice - atR * risk : r.entryPrice + atR * risk;
    };
    const px = (v: number | null | undefined): string => {
      if (v == null || !Number.isFinite(v)) return "—";
      const abs = Math.abs(v);
      return abs >= 1000 ? v.toFixed(2) : abs >= 1 ? v.toFixed(4) : v.toPrecision(5);
    };

    const ledger = rows.map((r) => `<tr class="${r.status === "CLOSED" ? "" : "open"}">
      <td class="mono">${esc(r.openedAt.slice(0, 16))}</td>
      <td class="sym">${esc(r.symbol.replace("USDT", ""))}</td>
      <td class="${r.direction === "SHORT" ? "neg" : "pos"}">${esc(r.direction)}</td>
      <td class="num">${px(r.entryPrice)}</td>
      <td class="num">${r.exitPrice == null ? '<span class="muted">terbuka</span>' : px(r.exitPrice)}</td>
      <td class="num neg">${px(r.stopPrice)}</td>
      <td class="num pos">${r.geo ? px(priceAtR(r, r.geo.profitLockR)) : '<span class="muted" title="geometri saat posisi ini dibuka tidak tercatat">—</span>'}</td>
      <td class="num pos">${r.geo ? px(priceAtR(r, r.geo.armR)) : "—"}</td>
      <td class="num pos">${r.geo ? px(priceAtR(r, r.geo.staticTpR)) : "—"}</td>
      <td class="num">${r.stopPct == null ? "—" : r.stopPct.toFixed(2) + "%"}</td>
      <td class="num">${r.costR == null ? "—" : r.costR.toFixed(3)}</td>
      <td class="num">${r3(r.peakR)}</td>
      <td class="num ${(r.netR ?? 0) >= 0 ? "pos" : "neg"}">${r3(r.netR)}</td>
      <td class="num">${usd(r.netUsd)}</td>
      <td class="num">${r.holdHours == null ? "—" : r.holdHours.toFixed(1) + "j"}</td>
      <td>${r.status === "CLOSED" ? esc(r.closeReason ?? "—") : '<b class="warn">MASIH TERBUKA</b>'}</td>
      <td class="num">${r.makerPct == null ? '<span class="muted">taker</span>' : r.makerPct.toFixed(0) + "% mkr"}<span class="muted"> / taker</span></td>
    </tr>`).join("");

    // Per-position verdicts, one row per hypothesis an operator actually asks about. Every verdict
    // is derived from a stored field; where the store cannot separate two explanations, it says so
    // instead of picking the tidier one.
    const symbolMean = new Map<string, number>();
    for (const [sym, v] of bySymbol) symbolMean.set(sym, mean(v.map((x) => x.netR!)));
    const LOCK_R = 0.5;

    const verdict = (tag: "ya" | "tidak" | "abu", text: string) =>
      `<span class="v-${tag}">${tag === "ya" ? "YA" : tag === "tidak" ? "tidak" : "tak terpisah"}</span> ${esc(text)}`;

    const diagnose = (r: LedgerRow): string => {
      const out: Array<[string, string]> = [];
      const overlay = (r.closeReason ?? "").startsWith("DIRECTIONAL_REVERSAL_CONFIRMED");
      const peak = r.peakR ?? 0;

      out.push(["salah entry", r.slipBps == null
        ? verdict("abu", "submitRef tidak tercatat — kualitas entry tidak bisa dinilai untuk posisi ini")
        : Math.abs(r.slipBps) <= 0.5 && r.venueOk !== false
          ? verdict("tidak", `terisi ${r.slipBps >= 0 ? "tepat di" : "lebih buruk dari"} harga sentuh (slippage ${r.slipBps.toFixed(2)} bps, spread ${r.spreadBps?.toFixed(2) ?? "—"} bps, kutipan ${((r.quoteAgeMs ?? 0) / 1000).toFixed(1)} dtk)`)
          : verdict("ya", `slippage ${r.slipBps.toFixed(2)} bps dari harga sentuh${r.venueOk === false ? ", dan venue kutipan BEDA dari venue eksekusi" : ""}`)]);

      const symMean = symbolMean.get(r.symbol);
      const symN = (bySymbol.get(r.symbol) ?? []).length;
      out.push(["salah simbol", symN < 3
        ? verdict("abu", `${r.symbol.replace("USDT", "")} baru ${symN} posisi tertutup — terlalu sedikit untuk menyalahkan simbolnya`)
        : (symMean ?? 0) < -0.1
          ? verdict("ya", `${r.symbol.replace("USDT", "")} rata-rata ${r3(symMean)}R atas ${symN} posisi`)
          : verdict("tidak", `${r.symbol.replace("USDT", "")} rata-rata ${r3(symMean)}R atas ${symN} posisi`)]);

      out.push(["regime berbalik", overlay
        ? verdict("ya", `ditutup overlay setelah ${(r.holdHours ?? 0).toFixed(1)} jam — exit lane sendiri tidak pernah dapat giliran`)
        : verdict("tidak", "exit lane sendiri yang menutup, overlay tidak ikut campur")]);

      out.push(["masuk terlalu cepat / salah arah", peak <= 0.05
        ? verdict("abu", `harga tidak pernah bergerak ke arah kita (puncak ${r3(r.peakR)}R). Store hanya menyimpan puncaknya, bukan jalurnya — "arah salah" dan "masuk kepagian" tidak bisa dipisahkan dari data ini`)
        : verdict("tidak", `sempat untung ${r3(r.peakR)}R dulu, jadi arahnya sempat benar dan ini bukan pembalikan seketika`)]);

      out.push(["geometri TP", peak >= LOCK_R
        ? verdict("tidak", `puncak ${r3(r.peakR)}R melewati kunci ${LOCK_R}R — geometrinya benar-benar diuji di posisi ini`)
        : verdict("abu", `puncak ${r3(r.peakR)}R, kunci ada di ${LOCK_R}R — tidak pernah dekat, jadi geometri TP belum teruji di sini`)]);

      out.push(["ongkos", r.costR == null
        ? verdict("abu", "ongkos tidak tercatat")
        : r.costR >= 0.10
          ? verdict("ya", `${r.costR.toFixed(3)}R dimakan komisi — stop ${r.stopPct?.toFixed(2)}% terlalu sempit relatif ongkos`)
          : r.costR >= 0.05
            ? verdict("abu", `${r.costR.toFixed(3)}R, tidak kecil: sebanding ${(r.costR / Math.max(Math.abs(r.netR ?? 0), 1e-9) * 100).toFixed(0)}% dari hasil bersihnya`)
            : verdict("tidak", `${r.costR.toFixed(3)}R pada stop ${r.stopPct?.toFixed(2)}%`)]);

      return `<details class="diag"><summary><b>${esc(r.symbol.replace("USDT", ""))}</b> ${esc(r.direction)} · ${esc(r.openedAt.slice(0, 16))} · <span class="${(r.netR ?? 0) >= 0 ? "pos" : "neg"}">${r3(r.netR)}R</span> · ${esc((r.closeReason ?? "").split(":")[0] || "—")}</summary>
        <div class="plain" style="margin:6px 0 8px">${esc(REASON_PLAIN[(r.closeReason ?? "").split(":")[0]!] ?? "")}</div>
        <table><tbody>${out.map(([k, v]) => `<tr><td class="dk">${esc(k)}</td><td>${v}</td></tr>`).join("")}</tbody></table></details>`;
    };

    const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Catatan Trade Directional</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--card:#f9fafb;--pos:#047857;--neg:#b91c1c;--warnbg:#fef3c7;--warnfg:#92400e}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--mut:#9ca3af;--line:#272b33;--card:#161a20;--pos:#34d399;--neg:#f87171;--warnbg:#3b2f0b;--warnfg:#fcd34d}}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto}h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px}
.muted{color:var(--mut)}.pos{color:var(--pos)}.neg{color:var(--neg)}.warn{color:var(--warnfg)}
.note{background:var(--warnbg);color:var(--warnfg);padding:10px 13px;border-radius:8px;font-size:13px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:9px;margin:12px 0}
.grid div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
.grid span{display:block;color:var(--mut);font-size:11.5px;margin-bottom:3px}.grid b{font-size:16px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums}.sym{font-weight:600}.mono{font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
tr.open td{background:var(--card)}.wrapx{overflow-x:auto}
.plain{color:var(--mut);font-size:11.5px;line-height:1.5;font-weight:400;white-space:normal;max-width:52ch}
.diag{border:1px solid var(--line);border-radius:6px;padding:8px 11px;margin:6px 0;background:var(--card)}
.diag summary{cursor:pointer;font-size:13px}.diag td{border:0;padding:3px 6px;vertical-align:top}
.diag .dk{color:var(--mut);white-space:nowrap;width:1%;font-size:11.5px}
.v-ya{color:var(--neg);font-weight:600}.v-tidak{color:var(--pos);font-weight:600}.v-abu{color:var(--warnfg);font-weight:600}
</style></head><body><div class="wrap">
<h1>Catatan Trade — CROSS_SECTIONAL_DIRECTIONAL</h1>
<p class="muted">Setiap posisi yang benar-benar dibuka di exchange, terbuka maupun tertutup. Angka <b>sudah berongkos penuh</b>
(<code>fullyCostedNetPnlUsd</code>) — 13 dari 14 posisi pertama menyimpan <code>netPnlUsd</code> tanpa kaki masuk, kira-kira 0,027R terlalu murah hati.</p>

<div class="grid">
  <div><span>posisi</span><b>${rows.length}</b></div>
  <div><span>tertutup</span><b>${closed.length}</b></div>
  <div><span>terbuka</span><b>${open.length}</b></div>
  <div><span>episode independen</span><b>${episodes}</b></div>
  <div><span>rentang</span><b>${spanDays.toFixed(1)} hari</b></div>
  <div><span>mean netR</span><b class="${mean(closed.map((r) => r.netR!)) >= 0 ? "pos" : "neg"}">${r3(mean(closed.map((r) => r.netR!)))}</b></div>
  <div><span>total USD</span><b class="${closed.reduce((a, r) => a + (r.netUsd ?? 0), 0) >= 0 ? "pos" : "neg"}">${usd(closed.reduce((a, r) => a + (r.netUsd ?? 0), 0))}</b></div>
  <div><span>exit lane sendiri</span><b>${ownExits.length}/${closed.length}</b></div>
</div>

<div class="note">${episodes < 20
  ? `<b>Belum bisa disimpulkan.</b> ${episodes} episode independen atas ${spanDays.toFixed(1)} hari — sinyal menyala berkelompok dari satu pembacaan pasar, jadi ${closed.length} baris ini BUKAN ${closed.length} pengamatan bebas. Butuh ~20 episode lintas ≥7 hari sebelum mean di atas berarti apa pun.`
  : `${episodes} episode independen atas ${spanDays.toFixed(1)} hari.`}</div>

<h2>Ditutup oleh apa</h2>
<p class="muted">Pertanyaan yang paling sering ditanyakan ke lane ini. <code>DIRECTIONAL_REVERSAL_CONFIRMED</code> = overlay rezim memotong; sisanya exit lane sendiri.</p>
<div class="wrapx"><table><thead><tr><th>alasan tutup</th><th class="num">n</th><th class="num">mean netR</th><th class="num">total USD</th><th class="num">tahan</th></tr></thead>
<tbody>${groupRows(byReason, true) || '<tr><td colspan="5" class="muted">belum ada yang tertutup</td></tr>'}</tbody></table></div>

<h2>Per simbol</h2>
<div class="wrapx"><table><thead><tr><th>simbol</th><th class="num">n</th><th class="num">mean netR</th><th class="num">total USD</th><th class="num">tahan</th></tr></thead>
<tbody>${groupRows(bySymbol) || '<tr><td colspan="5" class="muted">belum ada</td></tr>'}</tbody></table></div>

<h2>Seluruh posisi</h2>
<p class="muted"><b>entry / close / stop</b> = harga sungguhan dari store. <b>lock / arm / TP</b> = level dari geometri yang <b>dibekukan saat posisi itu dibuka</b> — posisi sebelum 2026-08-17 tidak menyimpannya dan ditampilkan &mdash;, bukan dikira-kira dari config hari ini.
<br><b>Keempat exit menutup SELURUH posisi</b> — tidak ada penjualan bertahap dan tidak ada sisa. Mereka empat pintu alternatif, dan hanya satu yang pernah terpakai per posisi: <b>lock</b> menutup kalau puncak sempat melewatinya lalu harga kembali menembusnya; <b>giveback</b> mulai menjejak setelah puncak lewat arm dan menutup setelah harga mengembalikan ${Math.round(nowGeo.givebackFraction * 100)}% dari puncak — harganya bergantung puncak, jadi tidak bisa dipatok di kolom; <b>TP</b> menutup begitu tersentuh; <b>stop</b> di &minus;1R. Satu posisi = satu buka, satu tutup, satu ongkos bolak-balik.
<br><b>masuk / keluar</b> = likuiditas tiap sisi. Keluar SELALU taker: exit lane ini memakai MARKET dan stop-nya STOP_MARKET, yang menurut definisi tidak bisa pasif. <b>ongkos R</b> = komisi bolak-balik dibagi satuan risiko, yaitu 8bps/lebar-stop &mdash; makin sempit stop, makin besar porsi yang dimakan ongkos.</p>
<div class="wrapx"><table><thead><tr>
<th>dibuka</th><th>simbol</th><th>arah</th><th class="num">entry</th><th class="num">close</th><th class="num">stop</th><th class="num">lock</th><th class="num">arm</th><th class="num">TP</th><th class="num">stop%</th><th class="num">ongkos R</th><th class="num">peak R</th><th class="num">net R</th><th class="num">net USD</th><th class="num">tahan</th><th>ditutup oleh</th><th class="num">masuk / keluar</th>
</tr></thead><tbody>${ledger || '<tr><td colspan="11" class="muted">belum ada posisi</td></tr>'}</tbody></table></div>

<h2>Evaluasi per posisi</h2>
<p class="muted">Tiap posisi tertutup diuji terhadap dugaan yang sama. Verdict diturunkan dari field tersimpan; kalau store tidak bisa memisahkan dua penjelasan, ia mengatakannya alih-alih memilih yang lebih rapi.</p>
${closed.map(diagnose).join("") || '<p class="muted">belum ada posisi tertutup</p>'}

${unreadable ? `<div class="note">Store lane ${esc(unreadable)}tidak terbaca — baris lane itu HILANG dari halaman ini, bukan nol.</div>` : ""}
</div></body></html>`;

    reply.type("text/html; charset=utf-8");
    return html;
  });

  async function buildOverlayCf(): Promise<unknown> {
    const now = Date.now();
    if (overlayCfCache && now - overlayCfCache.atMs < 5 * 60_000) return overlayCfCache.payload;

    const params = ownExitParamsFromEnv();
    const costBps = Number.parseFloat(process.env.CROSS_SECTIONAL_MEASURED_COST_BPS ?? "") || 7.99;
    const lanes: Array<{ lane: string; file: string }> = [
      { lane: "SHORT", file: "data/cross-sectional-directional-short-executor.json" },
      { lane: "LONG", file: "data/cross-sectional-directional-long-executor.json" },
    ];

    const perLane: Record<string, unknown> = {};
    for (const { lane, file } of lanes) {
      let positions: DirectionalClosedPosition[] = [];
      try {
        positions = (JSON.parse(readFileSync(file, "utf-8")) as { positions?: DirectionalClosedPosition[] }).positions ?? [];
      } catch {
        perLane[lane] = { error: "store unreadable", rows: [], summary: null };
        continue;
      }
      const overlayClosed = positions.filter((p) => p.status === "CLOSED" && isOverlayClose(p.closeReason));
      const rows: CounterfactualRow[] = [];
      for (const p of overlayClosed) {
        const actual = realisedNetR(p);
        const costR = positionCostR(p, costBps);
        if (actual === null || costR === null) continue;
        const openMs = Date.parse(p.openedAt);
        if (!Number.isFinite(openMs)) continue;
        let bars: Bar[] = [];
        try {
          const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${p.symbol}&interval=5m&startTime=${openMs}&endTime=${openMs + params.maxHoldHours * 3600e3}&limit=500`;
          const raw = (await (await fetch(url)).json()) as unknown[];
          if (!Array.isArray(raw)) continue;
          bars = raw.map((k) => {
            const a = k as [number, string, string, string, string];
            return { openTimeMs: a[0], open: Number(a[1]), high: Number(a[2]), low: Number(a[3]), close: Number(a[4]) };
          });
        } catch { continue; }
        const sim = replayOwnExit(bars, p, params, costR);
        if (!sim) continue;
        rows.push({
          positionId: p.positionId, symbol: p.symbol, direction: p.direction,
          openedAt: p.openedAt, closedAt: p.closedAt,
          actualNetR: actual, counterfactualNetR: sim.netR, deltaR: sim.netR - actual,
          counterfactualExit: sim.exitReason, counterfactualHoldHours: sim.holdHours, stopHit: sim.stopHit,
        });
      }
      perLane[lane] = { summary: summariseCounterfactual(rows), rows };
    }

    const payload = {
      generatedAt: new Date(now).toISOString(),
      note: "REPORT-ONLY. The overlay still closes real positions; this records only what holding to the lane's own exit would have returned.",
      ownExitParams: params,
      measuredCostBps: costBps,
      lanes: perLane,
    };
    overlayCfCache = { atMs: now, payload };
    return payload;
  }

  app.get("/api/live/cross-sectional-closed-baskets", async () => {
    const reportSinceMs = getCrossSectionalReportSinceMs();
    const reportStartAt = reportSinceMs === undefined ? null : new Date(reportSinceMs).toISOString();
    const inReportEra = (openedAt: string): boolean => reportSinceMs === undefined || new Date(openedAt).getTime() >= reportSinceMs;
    const instances: Array<{ label: string; executor: CrossSectionalExecutor | null }> = [
      { label: "FILTERED", executor: opts.crossSectionalExecutor?.() ?? null },
      { label: "TREND_BETA_VOL", executor: opts.crossSectionalTrendExecutor?.() ?? null },
      { label: "MIXED_MEAN_REVERSION", executor: opts.crossSectionalMixedExecutor?.() ?? null },
      ...(opts.innovationBasketExecutors?.() ?? []).map((executor, i) => ({ label: `INNOVATION_${i + 1}`, executor })),
    ];
    const filteredExecutor = opts.crossSectionalExecutor?.() ?? null;
    const filteredStatus = filteredExecutor?.getStatus() ?? null;
    const filteredOpenBaskets = filteredStatus?.openBaskets.filter((basket) => inReportEra(basket.openedAt)) ?? [];
    const filteredClosedBaskets = filteredExecutor
      ? closedBasketRealizedBreakdown(filteredExecutor.getClosedBaskets()).filter((basket) => inReportEra(basket.openedAt))
      : [];
    // Cross-basket carries its OWN measured cost, not the system-wide 22bps blend — see
    // crossSectionalEstimatedCostPct's doc comment for the three-way measurement behind it.
    // Applying the global constant here overstated a basket's cost by ~1.9x.
    const estimatedCloseCostPct = crossSectionalEstimatedCostPct();
    let grossUnrealizedUsd: number | null = filteredOpenBaskets.length === 0 ? 0 : null;
    let unrealizedMarkNotionalUsd = 0;
    const openBasketUnrealized = new Map<string, { grossUsd: number; afterEstimatedCloseCostUsd: number }>();
    const openBasketLegs = new Map<string, Array<{
      symbol: string;
      side: "LONG" | "SHORT";
      qty: number;
      entryPrice: number;
      markPrice: number | null;
      grossUnrealizedUsd: number | null;
      afterEstimatedCloseCostUsd: number | null;
    }>>();
    if (filteredOpenBaskets.length > 0 && engine) {
      const account = (await readDashboardAccountSnapshot!()).snapshot;
      const markBySymbol = new Map(account.positions.flatMap((position) =>
        position.markPrice != null ? [[position.symbol, position.markPrice] as const] : [],
      ));
      // Binance omits a contract from account positions when independent basket legs net to zero
      // (the active book has BNB long in one basket and BNB short in another). Its market price is
      // still real and needed to value EACH basket from its own entry; fetch only those missing
      // symbols from the public mark-price endpoint rather than rendering the entire basket as —.
      const missingSymbols = [...new Set(filteredOpenBaskets.flatMap((basket) => basket.legs
        .filter((leg) => leg.exitOrderId === null && !markBySymbol.has(leg.symbol))
        .map((leg) => leg.symbol)))];
      if (missingSymbols.length) {
        const futuresBase = process.env.LIVE_BINANCE_ENV === "testnet"
          ? "https://testnet.binancefuture.com"
          : "https://fapi.binance.com";
        await Promise.allSettled(missingSymbols.map(async (symbol) => {
          const response = await fetch(`${futuresBase}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`);
          if (!response.ok) return;
          const payload = await response.json() as { markPrice?: unknown };
          const mark = Number(payload.markPrice);
          if (Number.isFinite(mark) && mark > 0) markBySymbol.set(symbol, mark);
        }));
        // A public price miss leaves only that leg unavailable; never fail the report route or
        // fabricate a zero P&L.
      }
      let gross = 0;
      let complete = true;
      for (const basket of filteredOpenBaskets) {
        let basketGross = 0;
        let basketMarkNotional = 0;
        let basketComplete = true;
        const legs: Array<{
          symbol: string;
          side: "LONG" | "SHORT";
          qty: number;
          entryPrice: number;
          markPrice: number | null;
          grossUnrealizedUsd: number | null;
          afterEstimatedCloseCostUsd: number | null;
          /** Entry liquidity split. null = leg predates maker entry, which by construction of the
           *  code at that time means it was filled entirely as taker — never "unknown". */
          entryLiquidity: { makerQty: number; takerQty: number; reason: string } | null;
        }> = [];
        for (const leg of basket.legs) {
          if (leg.exitOrderId !== null) continue;
          const mark = markBySymbol.get(leg.symbol);
          if (mark == null || !Number.isFinite(mark)) {
            complete = false;
            basketComplete = false;
            legs.push({
              symbol: leg.symbol,
              side: leg.side,
              qty: leg.qty,
              entryPrice: leg.entryPrice,
              markPrice: null,
              grossUnrealizedUsd: null,
              afterEstimatedCloseCostUsd: null,
                          entryLiquidity: (leg as { entryLiquidity?: { makerQty: number; takerQty: number; reason: string } | null }).entryLiquidity ?? null,
            });
            continue;
          }
          const direction = leg.side === "LONG" ? 1 : -1;
          const legGross = (mark - leg.entryPrice) * leg.qty * direction;
          legs.push({
            symbol: leg.symbol,
            side: leg.side,
            qty: leg.qty,
            entryPrice: leg.entryPrice,
            markPrice: mark,
            grossUnrealizedUsd: legGross,
            afterEstimatedCloseCostUsd: legGross - mark * leg.qty * Math.max(0, estimatedCloseCostPct),
                      entryLiquidity: (leg as { entryLiquidity?: { makerQty: number; takerQty: number; reason: string } | null }).entryLiquidity ?? null,
          });
          gross += legGross;
          basketGross += legGross;
          const markNotional = mark * leg.qty;
          unrealizedMarkNotionalUsd += markNotional;
          basketMarkNotional += markNotional;
        }
        if (basketComplete) {
          openBasketUnrealized.set(basket.basketId, {
            grossUsd: basketGross,
            afterEstimatedCloseCostUsd: basketGross - basketMarkNotional * Math.max(0, estimatedCloseCostPct),
          });
        }
        openBasketLegs.set(basket.basketId, legs);
      }
      grossUnrealizedUsd = complete ? gross : null;
    }
    const estimatedSlippageUsd = grossUnrealizedUsd == null ? null : unrealizedMarkNotionalUsd * Math.max(0, estimatedCloseCostPct);
    const nowIso = new Date().toISOString();
    const unrealizedExtremaByBasket = recordCrossSectionalUnrealizedExtrema(
      [...openBasketUnrealized.entries()].map(([basketId, value]) => ({
        basketId,
        ...value,
        legs: (openBasketLegs.get(basketId) ?? []).flatMap((leg) =>
          leg.grossUnrealizedUsd != null && leg.afterEstimatedCloseCostUsd != null
            ? [{
              symbol: leg.symbol,
              side: leg.side,
              grossUsd: leg.grossUnrealizedUsd,
              afterEstimatedCloseCostUsd: leg.afterEstimatedCloseCostUsd,
              entryAfterEstimatedCloseCostUsd: -leg.entryPrice * leg.qty * Math.max(0, estimatedCloseCostPct),
              entryAt: filteredOpenBaskets.find((basket) => basket.basketId === basketId)?.openedAt ?? nowIso,
            }]
            : [],
        ),
      })),
      filteredClosedBaskets.map((basket) => ({ basketId: basket.basketId, closedAt: basket.closedAt })),
      nowIso,
    );
    const withUnrealizedExtrema = <T extends { basketId: string; legs: Array<{ symbol: string; side: "LONG" | "SHORT" }> }>(basket: T) => ({
      ...basket,
      unrealizedExtrema: unrealizedExtremaByBasket[basket.basketId] ?? null,
      legs: basket.legs.map((leg) => ({
        ...leg,
        unrealizedExtrema: unrealizedExtremaByBasket[basket.basketId]?.legs?.[`${leg.side}:${leg.symbol}`] ?? null,
      })),
    });
    // Keep the active testnet cohort strictly cutoff-scoped, but do not make real, settled
    // pre-cutoff fills disappear from the operator's ledger.  This is an audit-only history:
    // it never feeds execution, edge filters, P&L *today*, or Four-Brain learning.  In
    // particular, OPERATOR_VOID remains excluded even here; its raw exchange audit is kept in
    // the executor store but must not be silently reinstated in normal reporting.
    const auditHistoryLanes = reportSinceMs === undefined
      ? []
      : instances
        .filter((row): row is { label: string; executor: CrossSectionalExecutor } => row.executor !== null)
        .map((row) => {
          const status = row.executor.getStatus();
          const baskets = closedBasketRealizedBreakdown(
            row.executor.getClosedBasketsForAudit().filter((basket) =>
              basket.accountingStatus !== "ACCOUNTING_INCOMPLETE" &&
              !isCrossSectionalBasketReportingExcluded(basket),
            ),
          )
            .filter((basket) => !inReportEra(basket.openedAt))
            .map(withUnrealizedExtrema);
          return {
            lane: row.label,
            laneId: status.laneId,
            closedBaskets: baskets.length,
            baskets,
          };
        })
        .filter((lane) => lane.closedBaskets > 0);
    const auditHistoryTotalNetPnlUsd = auditHistoryLanes
      .flatMap((lane) => lane.baskets)
      .reduce((sum, basket) => sum + (basket.netPnlUsd ?? 0), 0);
    // A basket must never briefly render in the old "no ATH/ATL yet" shape.
    // The durable path starts at the first report sample, but the entry point
    // itself is already known: gross P&L is zero and an immediate close has a
    // real (negative) estimated close cost.  Return that honest baseline until
    // the first durable observation is written.
    const responseOpenBaskets = filteredOpenBaskets.map((basket) => {
      const deadline = scheduledOpenBasketDeadline(basket, filteredStatus?.legacyExitPolicy);
      const current = openBasketUnrealized.get(basket.basketId) ?? null;
      const legs = (openBasketLegs.get(basket.basketId) ?? basket.legs
        .filter((leg) => leg.exitOrderId === null)
        .map((leg) => ({ symbol: leg.symbol, side: leg.side, qty: leg.qty, entryPrice: leg.entryPrice, markPrice: null, grossUnrealizedUsd: null, afterEstimatedCloseCostUsd: null })));
      const stored = unrealizedExtremaByBasket[basket.basketId] ?? null;
      const complete = current !== null && legs.every((leg) =>
        Number.isFinite(leg.grossUnrealizedUsd) && Number.isFinite(leg.afterEstimatedCloseCostUsd),
      );
      const entryAfterCostUsd = -legs.reduce((sum, leg) => sum + leg.entryPrice * leg.qty * Math.max(0, estimatedCloseCostPct), 0);
      const fallback = complete && current
        ? {
          grossHighUsd: Math.max(0, current.grossUsd),
          grossLowUsd: Math.min(0, current.grossUsd),
          afterEstimatedCloseCostHighUsd: Math.max(entryAfterCostUsd, current.afterEstimatedCloseCostUsd),
          afterEstimatedCloseCostLowUsd: Math.min(entryAfterCostUsd, current.afterEstimatedCloseCostUsd),
          firstRecordedAt: basket.openedAt,
          lastRecordedAt: nowIso,
          legs: Object.fromEntries(legs.map((leg) => {
            const entryAfterCost = -leg.entryPrice * leg.qty * Math.max(0, estimatedCloseCostPct);
            const gross = leg.grossUnrealizedUsd as number;
            const afterCost = leg.afterEstimatedCloseCostUsd as number;
            return [`${leg.side}:${leg.symbol}`, {
              grossHighUsd: Math.max(0, gross),
              grossLowUsd: Math.min(0, gross),
              afterEstimatedCloseCostHighUsd: Math.max(entryAfterCost, afterCost),
              afterEstimatedCloseCostLowUsd: Math.min(entryAfterCost, afterCost),
              entryAt: basket.openedAt,
              firstRecordedAt: basket.openedAt,
              lastRecordedAt: nowIso,
            }];
          })),
        }
        : null;
      const extrema = stored ?? fallback;
      return {
        basketId: basket.basketId,
        signal: basket.signal,
        variant: basket.variant,
        openedAt: basket.openedAt,
        scheduledCloseAtMs: deadline.scheduledCloseAtMs,
        executionCapHours: deadline.executionCapHours,
        deadlineSource: deadline.deadlineSource,
        mayExitEarlier: deadline.mayExitEarlier,
        grossUnrealizedUsd: current?.grossUsd ?? null,
        unrealizedAfterEstimatedCloseCostUsd: current?.afterEstimatedCloseCostUsd ?? null,
        unrealizedExtrema: extrema,
        legs: legs.map((leg) => ({
          ...leg,
          unrealizedExtrema: extrema?.legs?.[`${leg.side}:${leg.symbol}`] ?? null,
        })),
      };
    });
    const lanes = instances
      .filter((row): row is { label: string; executor: CrossSectionalExecutor } => row.executor !== null)
      .map((row) => {
        const status = row.executor.getStatus();
        const closed = closedBasketRealizedBreakdown(row.executor.getClosedBaskets()).filter((basket) => inReportEra(basket.openedAt));
        return {
          lane: row.label,
          laneId: status.laneId,
          /** Compatibility alias: this is deliberately report-window scoped. */
          closedBaskets: closed.length,
          closedBasketsInReportWindow: closed.length,
          closedBasketsInStore: status.closedCount,
          accountingCounts: status.accountingCounts,
          currentPolicyForwardCohort: status.currentPolicyForwardCohort,
          openBaskets: status.openBaskets?.filter((basket) => inReportEra(basket.openedAt)).length ?? 0,
          totalNetPnlUsd: closed.reduce((sum, b) => sum + (b.netPnlUsd ?? 0), 0),
          perToken: Object.entries(
            closed
              .flatMap((b) => b.legs)
              .reduce<Record<string, { legs: number; grossPnlUsd: number; feeAllocatedUsd: number; netPnlUsd: number }>>((acc, leg) => {
                const row = (acc[leg.symbol] ??= { legs: 0, grossPnlUsd: 0, feeAllocatedUsd: 0, netPnlUsd: 0 });
                row.legs += 1;
                row.grossPnlUsd += leg.grossPnlUsd;
                row.feeAllocatedUsd += leg.feeAllocatedUsd;
                row.netPnlUsd += leg.netPnlUsd;
                return acc;
              }, {}),
          )
            .map(([symbol, row]) => ({ symbol, ...row }))
            .sort((a, b) => a.netPnlUsd - b.netPnlUsd),
          baskets: closed.map(withUnrealizedExtrema),
        };
      });
    const realizedBeforeSlippageUsd = filteredClosedBaskets.reduce((sum, basket) => sum + (basket.grossPnlUsd ?? 0), 0);
    const netRealizedProfitUsd = filteredClosedBaskets.reduce((sum, basket) => sum + (basket.netPnlUsd ?? 0), 0);
    const totalClosedInReportWindow = lanes.reduce((sum, lane) => sum + lane.closedBasketsInReportWindow, 0);
    const totalClosedInStore = lanes.reduce((sum, lane) => sum + lane.closedBasketsInStore, 0);
    const cleanN = lanes.reduce((sum, lane) => sum + lane.accountingCounts.cleanN, 0);
    const quarantinedN = lanes.reduce((sum, lane) => sum + lane.accountingCounts.quarantinedN, 0);
    // The rejection journal is shared by the filtered signal lane, so it must never be summed once
    // per executor instance.
    const rejectedN = filteredExecutor?.getStatus().accountingCounts.rejectedN ?? 0;
    return {
      generatedAt: nowIso,
      reportStartAt,
      source: "executor stores (real exchange fills) — NOT the measurement store",
      feeCaveat: "per-leg fees are APPORTIONED from the basket total by notional touched, not measured per leg",
      /** Deprecated compatibility field. It is always the report-window count; use counts for totals. */
      totalClosed: totalClosedInReportWindow,
      counts: {
        reportWindowClosedN: totalClosedInReportWindow,
        totalStoreClosedN: totalClosedInStore,
        cleanN,
        quarantinedN,
        rejectedN,
      },
      reason: totalClosedInReportWindow === 0
        ? "no cross-sectional basket has opened AND closed on the exchange yet — an empty list here means the lane has not traded, not that it broke even"
        : null,
      crossSectionalPnl: {
        openBasketCount: filteredOpenBaskets.length,
        openLegCount: filteredOpenBaskets.reduce((sum, basket) => sum + basket.legs.filter((leg) => leg.exitOrderId === null).length, 0),
        grossUnrealizedUsd,
        unrealizedAfterSlippageUsd: grossUnrealizedUsd == null ? null : grossUnrealizedUsd - (estimatedSlippageUsd ?? 0),
        estimatedSlippageUsd,
        realizedBeforeSlippageUsd,
        netRealizedProfitUsd,
        estimatedCloseCostPct,
        slippageCaveat: "Slippage fill aktual tidak disimpan terpisah; unrealized after slippage memakai estimasi biaya close LIVE_ESTIMATED_CLOSE_COST_PCT.",
      },
      openBaskets: responseOpenBaskets,
      lanes,
      auditHistory: auditHistoryLanes.length > 0
        ? {
          excludedFromActiveCohort: true,
          reason: "Real exchange-filled baskets before the active cohort cutoff. Audit-only: excluded from active edge, learning, execution, and daily P&L.",
          totalClosed: auditHistoryLanes.reduce((sum, lane) => sum + lane.closedBaskets, 0),
          totalNetPnlUsd: auditHistoryTotalNetPnlUsd,
          lanes: auditHistoryLanes,
        }
        : null,
    };
  });

  // 2026-07-08: sibling status endpoints for the two additional variant-targeted instances (same
  // shape as the FILTERED endpoint above, just a different underlying executor).
  app.get("/api/live/cross-sectional-executor-trend", async () => {
    const executor = opts.crossSectionalTrendExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "TREND_BETA_VOL executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/cross-sectional-executor-mixed", async () => {
    const executor = opts.crossSectionalMixedExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "MIXED_MEAN_REVERSION executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/cross-sectional-directional-regime", async () => ({
    ...(opts.directionalRegimeDecision?.() ?? {
      enabled: false,
      mode: "NO_TRADE",
      marketRegime: null,
      scanBatchId: null,
      scanFinishedAt: null,
      longPicks: [],
      shortPicks: [],
      longAverageScore: null,
      shortAverageScore: null,
      reason: "Directional cross-sectional lane belum diaktifkan.",
    }),
    longExecutor: opts.crossSectionalDirectionalLongExecutor?.()?.getStatus() ?? null,
    shortExecutor: opts.crossSectionalDirectionalShortExecutor?.()?.getStatus() ?? null,
  }));

  // 2026-07-08: single-symbol executor status (SHORT_FADE_EXHAUSTION / INTRADAY_MOMENTUM_BREAKOUT).
  app.get("/api/live/short-fade-executor", async () => {
    const executor = opts.shortFadeExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "SHORT_FADE_EXHAUSTION executor disabled (set SHORT_FADE_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/intraday-momentum-executor", async () => {
    const executor = opts.intradayMomentumExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "INTRADAY_MOMENTUM_BREAKOUT executor disabled (set INTRADAY_MOMENTUM_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  // 2026-07-09: REGIME_COMPOSITE_CONFIRMATION_LONG executor status.
  app.get("/api/live/regime-composite-executor", async () => {
    const executor = opts.regimeCompositeExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "REGIME_COMPOSITE_CONFIRMATION_LONG executor disabled (set REGIME_COMPOSITE_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/regime-composite-short-executor", async () => {
    const executor = opts.regimeCompositeShortExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "REGIME_COMPOSITE_CONFIRMATION_SHORT executor disabled (set REGIME_COMPOSITE_SHORT_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/panic-washout-executor", async () => {
    const executor = opts.panicWashoutExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "PANIC_WASHOUT_RECLAIM_LONG executor disabled (set PANIC_WASHOUT_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  // 2026-07-09: COMPOSITE_ESTIMATOR_BIDI executor status, one per bucket.
  const compositeEstimatorBucketRoutes: Array<[string, () => SingleSymbolLaneExecutor | null]> = [
    ["wide-long", () => opts.compositeEstimatorWideLongExecutor?.() ?? null],
    ["wide-short", () => opts.compositeEstimatorWideShortExecutor?.() ?? null],
    ["fast-long", () => opts.compositeEstimatorFastLongExecutor?.() ?? null],
    ["fast-short", () => opts.compositeEstimatorFastShortExecutor?.() ?? null],
  ];
  for (const [slug, getExecutor] of compositeEstimatorBucketRoutes) {
    app.get(`/api/live/composite-estimator-${slug}-executor`, async () => {
      const executor = getExecutor();
      if (!executor) {
        return { enabled: false, reason: `COMPOSITE_ESTIMATOR_BIDI ${slug} executor disabled (set COMPOSITE_ESTIMATOR_EXEC_ENABLED=1 + live execution env)` };
      }
      return executor.getStatus();
    });
  }

  // CORTEX real-USDT attribution (2026-07-21): realized-dollar share attributable to CORTEX's
  // promoted weight tilt, per closed trade opened under an active tilt — see
  // cortex-real-attribution.ts for the definition (tiltShare captured at open, sign-honest).
  // Report-only reads of the shared singleton store both the engine's close sweep and every
  // SingleSymbolLaneExecutor write into; no engine/executor instance needed to serve it.
  app.get("/api/live/cortex-real-attribution", async () => getCortexRealAttributionStore().buildReport());

  // Regime auto-pilot status (Tier 1: auto-syncs allocation to detected regime, anti-whipsaw).
  app.get("/api/live/autopilot", async () => {
    const pilot = opts.regimeAutopilot?.() ?? null;
    if (!pilot) {
      return { enabled: false, reason: "auto-pilot disabled (set REGIME_AUTOPILOT_ENABLED=1 + REGIME_ENGINE_ENABLED=1)" };
    }
    return pilot.getStatus();
  });

  // 2026-07-09 fix: the "Regime Engine → Lane Tree" dashboard panel used to hardcode its own COPY
  // of REGIME_AUTOPILOT_PRESETS (apps/web's REGIME_TREE constant) so the "Apply preset" buttons
  // could prefill the allocation form — a real incident: editing the backend preset (removing
  // CG_WIDE_FAST_SHORT after it was proven a real-money loss driver) left the dashboard's copy
  // stale, so the button still showed/would-have-applied the OLD (cut) lane. Serving the actual
  // constant here (pure static data, no pilot instance needed) lets the frontend render the TRUE
  // current preset and eliminates the possibility of the two ever drifting apart again.
  app.get("/api/live/regime-presets", async () => REGIME_AUTOPILOT_PRESETS);

  // WEIGHTED lane allocation (manual intervention: e.g. lane1 70% / lane2 30%).
  // Takes precedence over /api/live/lanes while set. Body:
  //   {"allocations": null}   → off (back to allow-list / all lanes)
  //   {"allocations": [{"laneId":"CG_WIDE_FAST_SHORT","weightPct":70},
  //                    {"laneId":"CG_WIDE_FAST_LONG","weightPct":30}]}
  // Only listed lanes may open NEW positions; each entry's size is scaled by weightPct.
  // Operator toggle: RAW selector mode (bypass the 2b book overlay + regime direction-gate; trade
  // exactly the lane allocation selector). OFF = the current "smart" behavior. Hard safety rails
  // (kill-switch, cluster cap, risk size) are never affected.
  app.post("/api/live/manual-mode", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { enabled?: unknown; confirm?: string };
    // 2026-07-12 fix: this toggles the RAW selector bypass affecting real-money entries, with no
    // confirmation phrase — unlike every other state-changing action in this file.
    if (body.confirm !== "SET_MANUAL_MODE") {
      reply.code(400);
      return { ok: false, reason: 'toggling manual mode requires body {"enabled": true|false, "confirm":"SET_MANUAL_MODE"}' };
    }
    if (typeof body.enabled !== "boolean") {
      reply.code(400);
      return { ok: false, reason: 'body must be {"enabled": true | false, "confirm":"SET_MANUAL_MODE"}' };
    }
    return engine.setManualSelectorMode(body.enabled);
  });

  // Directional manual allocation: the long list is active only when the current scanner Entry
  // Decision says LONG, and the short list only when it says SHORT. This does not place an order by
  // itself; a fresh lane signal with valid stop/TP geometry is still required by the mirror.
  app.post("/api/live/manual-directional-allocations", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as {
      allocations?: unknown;
      confirm?: string;
    };
    if (body.confirm !== "SET_MANUAL_DIRECTIONAL_ALLOCATIONS") {
      reply.code(400);
      return { ok: false, reason: 'setting manual directional allocations requires confirm="SET_MANUAL_DIRECTIONAL_ALLOCATIONS"' };
    }
    if (body.allocations !== null && (typeof body.allocations !== "object" || Array.isArray(body.allocations))) {
      reply.code(400);
      return { ok: false, reason: 'allocations must be null or {long:[{laneId,weightPct}],short:[{laneId,weightPct}]}' };
    }
    const raw = body.allocations as { long?: unknown; short?: unknown } | null;
    if (raw !== null && (!Array.isArray(raw?.long) || !Array.isArray(raw?.short))) {
      reply.code(400);
      return { ok: false, reason: 'allocations.long and allocations.short must both be arrays' };
    }
    const toRows = (rows: unknown[]) => rows.map((row) => {
      const value = row && typeof row === "object" ? row as { laneId?: unknown; weightPct?: unknown } : {};
      return { laneId: String(value.laneId ?? ""), weightPct: Number(value.weightPct) };
    });
    const result = engine.setManualDirectionalLaneAllocations(raw === null ? null : {
      long: toRows(Array.isArray(raw.long) ? raw.long : []),
      short: toRows(Array.isArray(raw.short) ? raw.short : []),
    });
    if (!result.ok) reply.code(400);
    return result;
  });

  app.post("/api/live/lane-allocations", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { allocations?: unknown; confirm?: string };
    // 2026-07-12 fix: this mutates which lanes may open new real positions and at what size, with
    // no confirmation phrase — unlike every other state-changing action in this file.
    if (body.confirm !== "SET_ALLOCATIONS") {
      reply.code(400);
      return { ok: false, reason: 'setting lane allocations requires body {"allocations": …, "confirm":"SET_ALLOCATIONS"}' };
    }
    if (body.allocations !== null && !Array.isArray(body.allocations)) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"allocations": null | [{laneId, weightPct}], "confirm":"SET_ALLOCATIONS"}' };
    }
    // 2026-07-09: operator-explicit path — sets laneAllocationOperatorLock when applying a real
    // allocation so RegimeAutopilot's next tick can't silently revert it (see
    // setLaneAllocationsAsOperator's doc comment for the incident this closes; 2026-07-12 fix:
    // this comment previously named the wrong flag, manualSelectorMode — that was the ORIGINAL
    // mechanism before the 2026-07-09 lane-allocation-lock/raw-bypass conflation fix split it into
    // this dedicated field). Distinct from applyRegimeAutopilotAllocation, which is autopilot's OWN
    // apply path and clears the flag instead.
    const result = engine.setLaneAllocationsAsOperator(
      body.allocations === null
        ? null
        : (body.allocations as Array<{ laneId?: unknown; weightPct?: unknown }>).map((a) => ({
            laneId: String(a.laneId ?? ""),
            weightPct: Number(a.weightPct),
          })),
    );
    if (!result.ok) reply.code(400);
    return result;
  });

  app.post("/api/live/kill", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string; reason?: string };
    if (body.confirm !== "KILL") {
      reply.code(400);
      return { ok: false, reason: 'kill requires body {"confirm":"KILL"} — cancels ALL orders and FLATTENS all engine positions' };
    }
    await engine.kill(body.reason ?? "operator kill");
    return { ok: true, armed: engine.isArmed(), status: engine.getStatus() };
  });

  app.post("/api/live/flatten-exchange", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string; reason?: string };
    if (body.confirm !== "FLATTEN_BINANCE_ALL") {
      reply.code(400);
      return {
        ok: false,
        reason:
          'exchange flatten requires body {"confirm":"FLATTEN_BINANCE_ALL"} — cancels ALL visible Binance USD-M orders and MARKET reduce-only closes ALL exchange positions',
      };
    }
    const result = await engine.flattenAllExchangePositions(body.reason ?? "operator exchange flatten");
    if (!result.ok) reply.code(502);
    return { ...result, armed: engine.isArmed(), status: engine.getStatus() };
  });

  app.get("/api/live/balance", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      const balance = await engine.getUsdtBalance();
      if (!balance) return { ok: true, walletBalance: null, availableBalance: null };
      return { ok: true, ...balance };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "balance fetch failed" };
    }
  });

  app.get("/api/live/account", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      const dashboardSnapshot = await readDashboardAccountSnapshot!();
      let snapshot = cloneLiveAccountSnapshot(dashboardSnapshot.snapshot);
      for (const executor of allCrossSectionalExecutors()) {
        snapshot = annotateCrossSectionalAccount(snapshot, executor);
      }
      for (const executor of allSingleSymbolExecutors()) {
        snapshot = annotateSingleSymbolAccount(snapshot, executor);
      }
      snapshot = annotateDailyRangeAccount(snapshot, opts.dailyRangeLane?.() ?? null);
      // 2026-07-11: the dashboard's headline "Realized P&L (today/all-time)" summed only the
      // mirror ledger (status.totalRealizedPnlUsd) and the 3 cross-sectional lane ids — every
      // SingleSymbolLaneExecutor's real realized P&L (already correctly folded into closedLanes
      // above via annotateSingleSymbolAccount, just never summed for the headline) was invisible
      // there. Operator caught this live: a real +$1.39 BTC close via REGIME_COMPOSITE_CONFIRMATION_LONG
      // didn't move "all-time" at all. Expose the aggregate directly so the frontend doesn't have to
      // guess/hardcode lane ids that drift every time a new single-symbol lane is wired.
      // (Single-symbol only, deliberately — cross-sectional's own "baskets" total is a SEPARATE
      // frontend calc over the 3 CrossSectionalExecutor lane ids, so passing [] here avoids double-
      // counting; sumExternalRealizedPnlUsd is also reused as-is by the kill-switch and wallet-
      // reconciliation, which DO want the combined cross-sectional+single-symbol total.)
      const singleSymbolExecutorRealizedPnlUsd = sumExternalRealizedPnlUsd([], allSingleSymbolExecutors());
      const pnlEra = process.env.LIVE_BINANCE_ENV === "testnet" ? readTestnetPnlEra() : null;
      return {
        ok: true,
        ...snapshot,
        accountSnapshot: {
          source: dashboardSnapshot.source,
          fetchedAt: dashboardSnapshot.fetchedAt,
          ageMs: dashboardSnapshot.ageMs,
          stale: dashboardSnapshot.stale,
          retryAt: dashboardSnapshot.retryAt,
          lastFailure: dashboardSnapshot.lastFailure,
        },
        singleSymbolExecutorRealizedPnlUsd,
        testnetPnlEra: pnlEra && {
          ...pnlEra,
          unrealizedSinceStartUsd: snapshot.unrealizedPnl - pnlEra.carriedDirectionalUnrealizedUsd,
        },
      };
    } catch (err) {
      const failure = dashboardAccountFailure(err, "account snapshot failed");
      reply.code(failure.statusCode);
      return failure.body;
    }
  });

  // Report-only: compares the engine's internal daily realized-P&L ledger against Binance's own
  // /fapi/v1/income for the same UTC day. See wallet-reconciliation.ts's module doc for the full
  // safety rationale — this endpoint only reads and reports; it never corrects anything.
  app.get("/api/live/wallet-reconciliation", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const query = (request.query ?? {}) as { day?: string };
    try {
      const external = sumExternalRealizedPnlUsd(allCrossSectionalExecutors(), allSingleSymbolExecutors());
      // 2026-07-19 fix: this used to compute its own ad-hoc `query.day ?? new Date()...` fallback
      // here (for the fee sum) while separately handing the RAW, unvalidated query.day to
      // buildLiveWalletReconciliationReport (which resolves it internally via resolveDayUtc). A
      // malformed/non-existent day (e.g. "2026-04-31") is truthy, so it passed the `?? fallback`
      // unchanged into sumExternalClosedFeesUsd's startsWith() match — which then matched nothing
      // and silently returned 0 fees — while the report itself fell back to today via
      // resolveDayUtc's round-trip validation. The two halves of the response ended up describing
      // different days, and the mismatch always resolved to an artificially clean (zero-fee) report
      // rather than a rejected request. Resolving once, up front, and reusing that single validated
      // day for both the fee sum and the report keeps them consistent.
      const dayUtc = resolveDayUtc(query.day);
      const closedFees = engine.getClosedTodayFeesUsd() +
        sumExternalClosedFeesUsd(allCrossSectionalExecutors(), allSingleSymbolExecutors(), dayUtc);
      // FUNDING PERSISTENCE (2026-07-26, report-only — see lib/funding-fee-recorder.ts).
      //
      // This handler is the ONLY place in the process that ever fetches /fapi/v1/income. Every
      // FUNDING_FEE row for the day is already in memory inside the report builder, gets summed
      // into report.exchangeIncome.fundingFeeUsd, and is then discarded — funding, a real recurring
      // cash cost on every perp position, was persisted NOWHERE. withFundingFeeRecording decorates
      // the engine so those already-fetched rows are ALSO written to data/funding-fees.json on the
      // way past.
      //
      // WHY HERE AND NOT IN wallet-reconciliation.ts: that module's "never mutates, never writes"
      // contract is a stated safety property; decorating at the call site keeps it literally true
      // and puts the side effect where side effects already live. The decorator adds NO exchange
      // interaction (it observes the fetch immediately below), forwards arguments and the returned
      // rows byte-identically on the same promise, and is fail-open at every layer — a recorder
      // that threw on every call would leave `report` exactly as it is today.
      const report = await buildLiveWalletReconciliationReport(
        withFundingFeeRecording(engine),
        dayUtc,
        undefined,
        external.today,
        closedFees,
      );
      return { ok: true, report };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "wallet reconciliation failed" };
    }
  });

  // Report-only reader over the funding rows persisted by the wallet-reconciliation handler above
  // (see lib/funding-fee-recorder.ts). Touches no exchange endpoint and no engine state — it only
  // reads the local store, so it works even when live execution is disabled. Exists so the operator
  // can confirm funding is actually being captured without shelling into the box: a recorder nobody
  // can observe is the "measurement blocked by its own params" failure all over again.
  //
  // `coverage` is NOT decoration. Funding is only ever seen for UTC days the reconciliation ticker
  // actually ran on; a day missing from `coverage` contributes $0 to `totalUsd` and is
  // INDISTINGUISHABLE from a genuinely zero-funding day without it. Never present the total as
  // complete without checking coverage first.
  app.get("/api/live/funding-fees", async (request) => {
    const query = (request.query ?? {}) as { symbol?: string; days?: string; limit?: string };
    const recorder = getFundingFeeRecorder();
    const days = Math.min(400, Math.max(1, Math.floor(Number(query.days ?? 30)) || 30));
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(query.limit ?? 200)) || 200));
    const fromMs = Date.now() - days * 86_400_000;
    const symbol = typeof query.symbol === "string" && query.symbol.length > 0 ? query.symbol : undefined;
    const rows = recorder.listFundingRows({ ...(symbol ? { symbol } : {}), fromMs });
    const bySymbol = new Map<string, { symbol: string; rows: number; totalUsd: number }>();
    for (const r of rows) {
      const agg = bySymbol.get(r.symbol) ?? { symbol: r.symbol, rows: 0, totalUsd: 0 };
      agg.rows += 1;
      agg.totalUsd += r.income;
      bySymbol.set(r.symbol, agg);
    }
    return {
      ok: true,
      windowDays: days,
      symbol: symbol ?? null,
      // Binance's own sign convention is preserved end to end: negative = funding PAID.
      totalUsd: rows.reduce((sum, r) => sum + r.income, 0),
      rowCount: rows.length,
      bySymbol: Array.from(bySymbol.values()).sort((a, b) => a.totalUsd - b.totalUsd),
      coverage: recorder.getDayCoverage().filter((c) => c.dayUtc >= new Date(fromMs).toISOString().slice(0, 10)),
      rows: rows.slice(-limit), // newest `limit` rows; the store itself holds up to MAX_FUNDING_ROWS
      truncated: rows.length > limit,
    };
  });

  app.get("/api/live/lane-performance-series", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const query = (request.query ?? {}) as {
      view?: string;
      period?: string;
      anchor?: string;
      regime?: string;
      cohort?: string;
    };
    try {
      // The XRP/WLD MFE rollout is deliberately a fresh, symbol-scoped cohort. Do not blend it
      // with older CG_MFE_GIVEBACK orders from symbols that were never approved for this rollout.
      const mfeRollout = query.cohort === "testnet_mfe_giveback_xrp_wld";
      const configuredMfeRolloutStartAt = process.env.TESTNET_MFE_GIVEBACK_ROLLOUT_START_AT ?? null;
      let series = engine.getLanePerformanceSeries({
        view: query.view,
        period: query.period,
        anchor: query.anchor,
        regime: query.regime,
        ...(mfeRollout
          ? {
            laneIds: ["CG_VARIANT_MATRIX:CG_MFE_GIVEBACK"],
            symbols: ["XRPUSDT", "WLDUSDT"],
            since: configuredMfeRolloutStartAt,
          }
          : {}),
      });
      if (!mfeRollout) {
        for (const executor of allCrossSectionalExecutors()) {
          series = mergeCrossSectionalIntoLaneSeries(series, executor);
        }
        for (const executor of allSingleSymbolExecutors()) {
          series = mergeSingleSymbolIntoLaneSeries(series, executor);
        }
      }
      // The chart is intentionally calendar-scoped: a basket closed on 13 Aug must not be
      // painted into the 14 Aug hourly curve just to make the current view non-zero. Surface the
      // carried audit total separately so a zero current-day chart is never misread as lost
      // history; `getClosedBaskets()` keeps OPERATOR_VOID and incomplete rows out of both paths.
      const crossSectionalAuditBeforePeriod = !mfeRollout
        ? (() => {
          const sinceMs = Date.parse(series.since);
          if (!Number.isFinite(sinceMs)) return null;
          let closedBaskets = 0;
          let totalNetPnlUsd = 0;
          let lastClosedAt: string | null = null;
          for (const executor of allCrossSectionalExecutors()) {
            for (const basket of executor.getClosedBaskets()) {
              const closedMs = Date.parse(basket.closedAt ?? "");
              if (!Number.isFinite(closedMs) || closedMs >= sinceMs || basket.netPnlUsd === null) continue;
              closedBaskets += 1;
              totalNetPnlUsd += basket.netPnlUsd;
              if (lastClosedAt === null || (basket.closedAt ?? "") > lastClosedAt) lastClosedAt = basket.closedAt;
            }
          }
          return closedBaskets > 0 ? { closedBaskets, totalNetPnlUsd, lastClosedAt } : null;
        })()
        : null;
      return {
        ok: true,
        ...series,
        crossSectionalAuditBeforePeriod,
        cohort: mfeRollout
          ? {
            id: "testnet_mfe_giveback_xrp_wld",
            label: "CG_MFE_GIVEBACK — XRP/WLD rollout",
            rolloutStartAt: configuredMfeRolloutStartAt,
          }
          : null,
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, reason: err instanceof Error ? err.message : "lane performance series failed" };
    }
  });

  app.post("/api/live/sync-testnet", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    const status = engine.getStatus();
    if (status.env !== "testnet") {
      reply.code(409);
      return { ok: false, reason: "manual mirror sync is testnet-only" };
    }
    if (body.confirm !== "SYNC_TESTNET") {
      reply.code(400);
      return { ok: false, reason: 'sync requires body {"confirm":"SYNC_TESTNET"}' };
    }
    await engine.tick();
    return { ok: true, status: engine.getStatus(), account: await engine.getAccountSnapshot() };
  });

  app.post("/api/live/reset-kill", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "RESET") {
      reply.code(400);
      return { ok: false, reason: 'resetting a latched kill requires body {"confirm":"RESET"}' };
    }
    const result = engine.resetKill();
    if (!result.ok) {
      reply.code(409);
      return { ok: false, reason: result.reason };
    }
    return { ok: true, armed: engine.isArmed() };
  });
}

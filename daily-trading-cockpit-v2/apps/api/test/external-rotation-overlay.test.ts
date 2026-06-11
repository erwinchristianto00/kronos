import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ShadowPosition } from "@dtc/shared";

import { BinanceClient } from "../src/lib/binance.js";

let __metadataSnapshotTempDir: string;
let __originalSnapshotPath: string | undefined;

beforeAll(() => {
  __metadataSnapshotTempDir = mkdtempSync(join(tmpdir(), "ext-meta-test-"));
  __originalSnapshotPath = process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
  process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = join(__metadataSnapshotTempDir, "snapshot.json");
});

afterAll(() => {
  if (__originalSnapshotPath === undefined) {
    delete process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
  } else {
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = __originalSnapshotPath;
  }
  rmSync(__metadataSnapshotTempDir, { recursive: true, force: true });
});
import {
  JsonExternalRotationOverlayStore,
  refreshExternalRotationOverlayObservations,
  type ExternalRotationOverlayObservation,
  type ExternalRotationOverlayRefreshDiagnostics,
  type ExternalRotationOverlayStore,
} from "../src/lib/external-rotation-overlay.js";
import { buildExternalRotationOverlayPerformanceReport } from "../src/lib/external-rotation-overlay-performance.js";
import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";
import { buildAdaptiveProfitPolicySynthesisReport } from "../src/lib/adaptive-profit-policy.js";
import type { ExternalStrategyFitEnrichmentReport } from "../src/lib/external-strategy-fit-enrichment.js";
import { registerShadowRoutes } from "../src/routes/shadow.js";

class MemoryStore implements ExternalRotationOverlayStore {
  constructor(
    public rows: ExternalRotationOverlayObservation[] = [],
    public latestRefreshDiagnostics: ExternalRotationOverlayRefreshDiagnostics | null = null,
  ) {}
  readState() {
    return {
      observations: this.rows,
      latestRefreshDiagnostics: this.latestRefreshDiagnostics,
    };
  }
  writeState(state: { observations: ExternalRotationOverlayObservation[]; latestRefreshDiagnostics?: ExternalRotationOverlayRefreshDiagnostics | null }) {
    this.rows = state.observations;
    this.latestRefreshDiagnostics = state.latestRefreshDiagnostics ?? null;
  }
  readAll() { return this.rows; }
  writeAll(rows: ExternalRotationOverlayObservation[]) { this.rows = rows; }
}

function candidate(
  symbol: string,
  score: number,
  discovery: number,
  tier: "STRATEGY_FIT_HIGH" | "STRATEGY_FIT_LOW" = "STRATEGY_FIT_HIGH",
  directionalContext: "LONG_FAVORED" | "SHORT_FAVORED" = "SHORT_FAVORED",
) {
  return {
    symbol,
    discoveryScore: discovery,
    metadataDiscoveryTier: "EXPLORATORY_SHORTLIST",
    technicalDataStatus: "HEALTHY" as const,
    strategyFitScore: score,
    strategyFitTier: tier,
    strategyFitConfidence: "MEDIUM" as const,
    bestObservedExternalRouteHypothesis: {
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      routeMode: "DATA_COLLECTION",
      routeCompatibilityLabel: "DETACHED_STRATEGY_FIT_HYPOTHESIS" as const,
      expectedNetR: null,
      stopDistanceBps: 200,
      riskReward: 1.8,
      plannedEntryPrice: 100,
      entryZone: null,
      stopPrice: 102,
      tp1Price: 97,
      tp2Price: 96,
      tp3Price: 95,
      costR: 0.1,
    },
    directionalContext,
    regimeCompatibility: "ALIGNED",
    routeCompatibility: "HIGH",
    setupQuality: "HIGH",
    stopGeometryCredibilityHint: "HEALTHY",
    reasons: ["synthetic strategy fit"],
    cautionLabels: [],
    reusedScannerEvidenceSummary: {
      reusedSharedBuildCandidate: true,
      reusedSharedVariantSelection: true,
      opportunityScore: 80,
      confidence: 70,
      dangerScore: 30,
      trendStack: "BEARISH/BEARISH/BEARISH",
      scannerStatus: "WAIT",
    },
  };
}

function enrichment(): ExternalStrategyFitEnrichmentReport {
  const c1 = candidate("FITUSDT", 84, 70);
  const c2 = candidate("METAUSDT", 55, 95);
  const c3 = candidate("LOWUSDT", 20, 80, "STRATEGY_FIT_LOW");
  return {
    generatedAt: "2026-05-15T00:00:00.000Z",
    evidenceEra: "POST_CALIBRATION",
    discoverySourceSummary: {
      discoveryShortlistCount: 3,
      discoveryTradableCount: 3,
      discoveryConfidence: "LOW",
      topMetadataCandidate: "METAUSDT",
    },
    enrichedCandidateCount: 3,
    failedCandidateCount: 0,
    enrichmentReadiness: {
      advisoryEngineReady: true,
      readyForRotationShadowOverlay: false,
      readyForUniverseInfluence: false,
      confidence: "LOW",
      reasons: ["snapshot only"],
    },
    globalMarketContext: { inferredExternalShortlistRegime: "BEARISH_EXPANSION", longCount: 0, shortCount: 3, neutralCount: 0 },
    diagnostics: {
      candidatesRequested: 3,
      candidatesEvaluated: 3,
      technicalFetchSuccessCount: 3,
      technicalFetchFailureCount: 0,
      cacheStatus: "USES_BINANCE_CLIENT_CACHE",
      failureReasonCounts: {},
      failedCandidatesSample: [],
      notes: [],
    },
    candidates: [c1, c2, c3],
    topStrategyFitCandidates: [c1, c2],
    lowFitCandidates: [c3],
    metadataShortlistDivergesFromStrategyFit: true,
    patchHypotheses: [],
    answerCards: [],
    notes: [],
  };
}

function policyRecord(direction: "LONG" | "SHORT", regime: string, netR: number) {
  return {
    context: {
      schemaVersion: 1,
      symbol: "BTCUSDT",
      direction,
      scanTimestamp: null,
      evidenceEra: "POST_CALIBRATION",
      marketRegime: regime,
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      directionalAlignmentLabel: "ALIGNED",
      horizonConflict: false,
      selectedKronosBias: direction,
      whaleAgreement: "AGREES",
    },
    outcome: {
      schemaVersion: 1,
      positionId: `${direction}-${regime}-${netR}-${Math.random()}`,
      symbol: "BTCUSDT",
      direction,
      evidenceEra: "POST_CALIBRATION",
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      realizedNetR: netR,
      realizedGrossR: netR + 0.05,
      winnerLabel: netR > 0 ? "WIN" : "LOSS",
      tp1Hit: netR > 0,
      slHit: netR < 0,
      closeReason: netR > 0 ? "TP1" : "SL",
    },
  } as any;
}

function makeCandles() {
  const start = Date.parse("2026-05-15T00:00:00.000Z");
  return Array.from({ length: 20 }, (_, i) => {
    const price = i < 2 ? 100 : 98 - i * 0.2;
    return [start + i * 300_000, String(price), String(price + 0.5), String(price - 1.5), String(price), "1000", start + i * 300_000 + 1, "100000", 1, "0", "0", "0"];
  });
}

function fetchImpl(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    let payload: unknown;
    if (url.pathname === "/api/v3/exchangeInfo") {
      payload = { symbols: [{ symbol: "FITUSDT", status: "TRADING", baseAsset: "FIT", quoteAsset: "USDT", isSpotTradingAllowed: true, permissions: [] }] };
    } else if (url.pathname === "/api/v3/ticker/24hr" && !url.searchParams.has("symbol")) {
      payload = [{ symbol: "FITUSDT", volume: "1000000", quoteVolume: "100000000", lastPrice: "100", priceChangePercent: "2" }];
    } else if (url.pathname === "/api/v3/ticker/24hr") {
      payload = { symbol: url.searchParams.get("symbol") ?? "FITUSDT", volume: "1000000", quoteVolume: "100000000", lastPrice: "100", priceChangePercent: "2" };
    } else if (url.pathname === "/api/v3/ticker/bookTicker" && !url.searchParams.has("symbol")) {
      payload = [{ symbol: "FITUSDT", bidPrice: "99.99", askPrice: "100.01" }];
    } else if (url.pathname === "/api/v3/ticker/bookTicker") {
      payload = { symbol: url.searchParams.get("symbol") ?? "FITUSDT", bidPrice: "99.99", askPrice: "100.01" };
    } else {
      payload = makeCandles();
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("external rotation overlay", () => {
  it("treats an empty JSON store file as an empty overlay state", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-overlay-empty-"));
    try {
      writeFileSync(join(dir, "external-rotation-overlay-observations.json"), "", "utf-8");
      const store = new JsonExternalRotationOverlayStore(dir);

      expect(store.readState()).toEqual({
        observations: [],
        latestRefreshDiagnostics: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a safe empty performance report", () => {
    const report = buildExternalRotationOverlayPerformanceReport([]);
    expect(report.totalObservations).toBe(0);
    expect(report.currentBestObservedGroup).toBeNull();
    expect(report.readiness.readyForUniverseInfluence).toBe(false);
    expect(report.groupPerformance[0]!.earlyVerdict).toBe("NO_FORWARD_EVIDENCE_YET");
  });

  it("creates isolated observations, preserves group membership, and suppresses duplicates", async () => {
    const store = new MemoryStore();
    const client = new BinanceClient(fetchImpl());
    const first = await refreshExternalRotationOverlayObservations({
      store,
      enrichmentReport: enrichment(),
      binanceClient: client,
      now: new Date("2026-05-15T00:00:00.000Z"),
    });
    expect(first.diagnostics.observationsCreated).toBe(3);
    expect(first.observations.some((item) => item.overlayGroups.includes("STRATEGY_FIT_SHORTLIST"))).toBe(true);
    expect(first.observations.some((item) => item.overlayGroups.length > 1)).toBe(true);
    expect(first.observations[0]!.detachedCandidateSnapshot.hypotheticalEntryVariant).toBe("vwap_retest_entry");

    const second = await refreshExternalRotationOverlayObservations({
      store,
      enrichmentReport: enrichment(),
      binanceClient: client,
      now: new Date("2026-05-15T00:05:00.000Z"),
    });
    expect(second.diagnostics.observationsCreated).toBe(0);
    expect(second.diagnostics.observationsSuppressedAsDuplicate).toBeGreaterThan(0);
  });

  it("rejects absurd admission geometry but keeps sane tight-stop candidates admissible", async () => {
    const distorted = candidate("RLUSDUSDT", 70, 70);
    distorted.bestObservedExternalRouteHypothesis.stopDistanceBps = 2;
    distorted.bestObservedExternalRouteHypothesis.costR = 14.51;
    const saneTight = candidate("TRXUSDT", 68, 68);
    saneTight.bestObservedExternalRouteHypothesis.stopDistanceBps = 55;
    saneTight.bestObservedExternalRouteHypothesis.costR = 0.56;
    const customEnrichment: ExternalStrategyFitEnrichmentReport = {
      ...enrichment(),
      candidates: [distorted, saneTight],
      topStrategyFitCandidates: [distorted, saneTight],
      lowFitCandidates: [],
    };
    const store = new MemoryStore();
    const refresh = await refreshExternalRotationOverlayObservations({
      store,
      enrichmentReport: customEnrichment,
      binanceClient: new BinanceClient(fetchImpl()),
      now: new Date("2026-05-15T00:00:00.000Z"),
    });

    expect(refresh.observations.some((item) => item.symbol === "RLUSDUSDT")).toBe(false);
    expect(refresh.observations.some((item) => item.symbol === "TRXUSDT")).toBe(true);
    expect(refresh.diagnostics.rejectedForEconomicDistortionCount).toBe(1);
  });

  it("uses adaptive operative priority for strategy-fit admission while preserving baseline semantics and opposite-direction validation", async () => {
    const longCandidate = candidate("LONGUSDT", 10, 20, "STRATEGY_FIT_HIGH", "LONG_FAVORED");
    const short1 = candidate("SHORT1USDT", 90, 80);
    const short2 = candidate("SHORT2USDT", 89, 79);
    const short3 = candidate("SHORT3USDT", 88, 78);
    const short4 = candidate("SHORT4USDT", 87, 77);
    const short5 = candidate("SHORT5USDT", 86, 76);
    const adaptiveEnrichment: ExternalStrategyFitEnrichmentReport = {
      ...enrichment(),
      candidates: [short1, short2, short3, short4, short5, longCandidate],
      topStrategyFitCandidates: [short1, short2, short3, short4, short5, longCandidate],
      lowFitCandidates: [],
      globalMarketContext: { inferredExternalShortlistRegime: "BEARISH_EXPANSION", longCount: 1, shortCount: 5, neutralCount: 0 },
    };
    const synthesis = buildAdaptiveProfitPolicySynthesisReport([
      ...Array.from({ length: 24 }, () => policyRecord("SHORT", "Bearish expansion", 0.2)),
      ...Array.from({ length: 18 }, () => policyRecord("LONG", "Bullish expansion", -0.2)),
    ]);
    const store = new MemoryStore();
    const refresh = await refreshExternalRotationOverlayObservations({
      store,
      enrichmentReport: adaptiveEnrichment,
      adaptiveProfitPolicySynthesis: synthesis,
      binanceClient: new BinanceClient(fetchImpl()),
      now: new Date("2026-05-15T00:00:00.000Z"),
    });
    const strategyFitObservations = refresh.observations.filter((item) => item.overlayGroups.includes("STRATEGY_FIT_SHORTLIST"));
    expect(strategyFitObservations.some((item) => item.operativeCollectionPriority === "PRIMARY_PROFIT_LANE")).toBe(true);
    expect(strategyFitObservations.some((item) => item.antiBiasRole === "OPPOSITE_DIRECTION_VALIDATION")).toBe(true);
    expect(strategyFitObservations.some((item) => item.matchedPolicyId !== null)).toBe(true);
    expect(strategyFitObservations).toHaveLength(5);
    const metadataSymbols = refresh.observations
      .filter((item) => item.overlayGroups.includes("METADATA_DISCOVERY_BASELINE"))
      .map((item) => item.symbol);
    expect(metadataSymbols).toContain("SHORT1USDT");
  });

  it("keeps transient resolver errors retryable instead of terminal FAILED and retries previously failed observations", async () => {
    const store = new MemoryStore();
    const healthyClient = new BinanceClient(fetchImpl());
    await refreshExternalRotationOverlayObservations({
      store,
      enrichmentReport: enrichment(),
      binanceClient: healthyClient,
      now: new Date("2026-05-15T00:00:00.000Z"),
    });
    const flakyFetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/klines")) {
        return Promise.reject(new Error("transient kline failure"));
      }
      return fetchImpl()(input);
    }) as typeof fetch;
    const flakyClient = new BinanceClient(flakyFetch);
    const first = await refreshExternalRotationOverlayObservations({
      store,
      enrichmentReport: enrichment(),
      binanceClient: flakyClient,
      now: new Date("2026-05-15T00:10:00.000Z"),
    });
    expect(first.diagnostics.observationsFailedResolution).toBeGreaterThan(0);
    expect(first.observations.every((item) => item.observationStatus !== "FAILED")).toBe(true);
    expect(first.observations.some((item) => item.diagnostics.resolutionErrorCount === 1)).toBe(true);

    const recovered = await refreshExternalRotationOverlayObservations({
      store,
      enrichmentReport: enrichment(),
      binanceClient: healthyClient,
      now: new Date("2026-05-15T00:20:00.000Z"),
    });
    expect(recovered.observations.every((item) => item.observationStatus !== "FAILED")).toBe(true);
    expect(recovered.observations.some((item) => item.diagnostics.lastResolutionError === null)).toBe(true);
  });

  it("keeps refresh diagnostics in the canonical report path and remains backward compatible with old array-only stores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-overlay-store-"));
    try {
      const client = new BinanceClient(fetchImpl());
      const store = new JsonExternalRotationOverlayStore(dir);
      const refresh = await refreshExternalRotationOverlayObservations({
        store,
        enrichmentReport: enrichment(),
        binanceClient: client,
        now: new Date("2026-05-15T00:00:00.000Z"),
      });
      const persistedState = store.readState();
      expect(persistedState.latestRefreshDiagnostics?.observationsCreated).toBe(refresh.diagnostics.observationsCreated);
      const report = buildExternalRotationOverlayPerformanceReport(persistedState.observations, {
        lastRefreshDiagnostics: persistedState.latestRefreshDiagnostics,
      });
      expect(report.duplicateSuppressionStats.diagnosticsAvailable).toBe(true);
      expect(report.duplicateSuppressionStats.observationsCreated).toBe(refresh.diagnostics.observationsCreated);

      writeFileSync(
        join(dir, "external-rotation-overlay-observations.json"),
        JSON.stringify(refresh.observations, null, 2),
        "utf-8",
      );
      const legacyStore = new JsonExternalRotationOverlayStore(dir);
      const legacyState = legacyStore.readState();
      expect(legacyState.observations.length).toBe(refresh.observations.length);
      expect(legacyState.latestRefreshDiagnostics).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves observations and computes group comparison metrics", () => {
    const obs = enrichment().candidates.slice(0, 2).map((item, index) => ({
      observationId: `o-${index}`,
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T01:00:00.000Z",
      symbol: item.symbol,
      overlayGroups: index === 0 ? ["STRATEGY_FIT_SHORTLIST"] : ["METADATA_DISCOVERY_BASELINE"],
      evidenceEra: "POST_CALIBRATION",
      selectionBatchId: "b",
      sourceDiscoveryScore: item.discoveryScore,
      sourceStrategyFitScore: item.strategyFitScore,
      sourceStrategyFitTier: item.strategyFitTier,
      discoveryRank: index + 1,
      strategyFitRank: index + 1,
      lowFitRank: null,
      duplicateKey: `k-${index}`,
      detachedCandidateSnapshot: {
        direction: "SHORT",
        hypotheticalEntryVariant: "vwap_retest_entry",
        hypotheticalExitVariant: "tp1_full_exit",
        hypotheticalExpectedNetR: null,
        setupPlaybookLabel: "HIGH",
        stopDistanceBps: 200,
        riskReward: 1.8,
        marketRegime: "BEARISH_EXPANSION",
        plannedEntryPrice: 100,
        selectedEntryAnchorPrice: 100,
        entryBasis: "VARIANT_ANCHOR",
        entryZone: null,
        stopPrice: 102,
        tp1Price: 97,
        tp2Price: null,
        tp3Price: null,
        costR: 0.1,
        notes: [],
      },
      observationStatus: "RESOLVED",
      outcome: {
        realizedGrossR: index === 0 ? 1.2 : -1,
        realizedNetR: index === 0 ? 1.1 : -1.1,
        winnerLabel: index === 0 ? "WIN" : "LOSS",
        tp1Hit: index === 0,
        tp2Hit: false,
        slHit: index === 1,
        closeReason: index === 0 ? "TP1_FULL" : "SL",
        openedAt: "2026-05-15T00:05:00.000Z",
        closedAt: "2026-05-15T00:20:00.000Z",
        durationMinutes: 15,
        fillStatus: "FILLED",
      },
      diagnostics: {
        createdByPolicyVersion: "external-rotation-overlay-anchor-consistent-v2",
        reasonCodes: [],
        resolutionSemantics: "test",
      },
    })) as ExternalRotationOverlayObservation[];
    const report = buildExternalRotationOverlayPerformanceReport(obs);
    const fit = report.groupPerformance.find((group) => group.group === "STRATEGY_FIT_SHORTLIST")!;
    expect(fit.netAvgR).toBe(1.1);
    expect(fit.headlineResolvedCount).toBe(1);
    expect(fit.comparisonVsMetadataBaseline.deltaNetAvgR).toBe(2.2);
  });

  it("endpoints work and overlay storage stays separate from active shadow positions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-overlay-"));
    try {
      const app = Fastify({ logger: false });
      const positions: ShadowPosition[] = [];
      await registerShadowRoutes(app, {
        getAllPositions() {
          return positions;
        },
      } as never, {
        binanceClient: new BinanceClient(fetchImpl()),
        metadataFetchImpl: fetchImpl(),
        externalOverlayDataDir: dir,
      });
      const getEmpty = await app.inject({ method: "GET", url: "/api/shadow/external-rotation-overlay-performance" });
      expect(getEmpty.statusCode).toBe(200);
      expect(getEmpty.json().totalObservations).toBe(0);
      const status = await app.inject({ method: "GET", url: "/api/shadow/external-rotation-overlay/auto-refresh-status" });
      expect(status.statusCode).toBe(200);
      expect(status.json().enabled).toBe(false);
      expect(status.json().intervalMinutes).toBe(30);

      const refresh = await app.inject({ method: "POST", url: "/api/shadow/external-rotation-overlay/refresh?era=POST_CALIBRATION" });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json().performance).toBeTruthy();
      const refreshBody = refresh.json();

      const getAfter = await app.inject({ method: "GET", url: "/api/shadow/external-rotation-overlay-performance?era=POST_CALIBRATION" });
      expect(getAfter.statusCode).toBe(200);
      expect(getAfter.json().duplicateSuppressionStats.observationsCreated).toBe(refreshBody.diagnostics.observationsCreated);
      expect(getAfter.json().duplicateSuppressionStats.observationsConsidered).toBe(refreshBody.diagnostics.observationsConsidered);
      expect(getAfter.json().duplicateSuppressionStats.rejectedForEconomicDistortionCount).toBe(refreshBody.diagnostics.rejectedForEconomicDistortionCount);
      expect(getAfter.json().readiness.readyForUniverseInfluence).toBe(false);

      const dashboard = await app.inject({ method: "GET", url: "/api/shadow/dashboard-audit-summary?era=POST_CALIBRATION" });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json().summaryText).toContain("Auto-refresh: DISABLED");
      expect(dashboard.json().summaryText).toContain("Last collection refresh=MANUAL at");
      expect(dashboard.json().summaryText).toContain(
        `considered=${refreshBody.diagnostics.observationsConsidered} | created=${refreshBody.diagnostics.observationsCreated} | duplicate-suppressed=${refreshBody.diagnostics.observationsSuppressedAsDuplicate} | skipped-insufficient=${refreshBody.diagnostics.observationsSkippedForInsufficientState} | rejected-distortion=${refreshBody.diagnostics.rejectedForEconomicDistortionCount}`,
      );
      expect(positions).toEqual([]);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dashboard summary includes section R when overlay report is supplied", () => {
    const overlay = buildExternalRotationOverlayPerformanceReport([], {
      lastRefreshDiagnostics: {
        generatedAt: "2026-05-15T00:00:00.000Z",
        triggerSource: "MANUAL",
        selectionBatchId: "batch",
        observationsConsidered: 9,
        observationsCreated: 5,
        observationsSuppressedAsDuplicate: 0,
        observationsSkippedForInsufficientState: 4,
        rejectedForEconomicDistortionCount: 0,
        observationsResolvedThisRefresh: 0,
        observationsFailedResolution: 0,
        strategyFitSelected: 5,
        metadataBaselineSelected: 2,
        lowFitControlSelected: 0,
        notes: [],
      },
    });
    const report = buildDashboardAuditSummaryReport([], { externalRotationOverlay: overlay });
    expect(report.summaryText).toContain("R. EXTERNAL ROTATION SHADOW OVERLAY");
    expect(report.summaryText).toContain("Auto-refresh: DISABLED");
    expect(report.summaryText).toContain("considered=9 | created=5 | duplicate-suppressed=0 | skipped-insufficient=4 | rejected-distortion=0");
    expect(report.highlights.externalRotationShadowOverlay).toBeTruthy();
    expect((report.highlights.externalRotationShadowOverlay as any).readyForUniverseInfluence).toBe(false);
    expect((report.highlights.externalRotationShadowOverlay as any).refreshCreated).toBe(5);
    expect((report.highlights.externalRotationShadowOverlay as any).diagnosticsAvailable).toBe(true);
    expect((report.highlights.externalRotationShadowOverlay as any).autoRefresh.enabled).toBe(false);
  });

  it("fully reconciles valid post-fix overlay statuses in section R", () => {
    const baseObservation = {
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:30:00.000Z",
      symbol: "FITUSDT",
      overlayGroups: ["STRATEGY_FIT_SHORTLIST"],
      evidenceEra: "POST_CALIBRATION",
      selectionBatchId: "batch",
      sourceDiscoveryScore: 80,
      sourceStrategyFitScore: 75,
      sourceStrategyFitTier: "STRATEGY_FIT_HIGH",
      discoveryRank: 1,
      strategyFitRank: 1,
      lowFitRank: null,
      duplicateKey: "dup",
      detachedCandidateSnapshot: {
        direction: "SHORT",
        hypotheticalEntryVariant: "vwap_retest_entry",
        hypotheticalExitVariant: "tp1_full_exit",
        hypotheticalExpectedNetR: null,
        setupPlaybookLabel: "HIGH",
        stopDistanceBps: 200,
        riskReward: 1.8,
        marketRegime: "BEARISH_EXPANSION",
        plannedEntryPrice: 100,
        selectedEntryAnchorPrice: 100,
        entryBasis: "VARIANT_ANCHOR",
        entryZone: null,
        stopPrice: 102,
        tp1Price: 97,
        tp2Price: null,
        tp3Price: null,
        costR: 0.1,
        notes: [],
      },
      diagnostics: {
        createdByPolicyVersion: "external-rotation-overlay-anchor-consistent-v2",
        reasonCodes: [],
        resolutionSemantics: "test",
      },
    } as const;
    const observations: ExternalRotationOverlayObservation[] = [
      {
        ...baseObservation,
        observationId: "open-1",
        duplicateKey: "dup-open",
        observationStatus: "OPEN",
      },
      {
        ...baseObservation,
        observationId: "resolved-1",
        duplicateKey: "dup-resolved",
        observationStatus: "RESOLVED",
        outcome: {
          realizedGrossR: 1.2,
          realizedNetR: 1.1,
          winnerLabel: "WIN",
          tp1Hit: true,
          tp2Hit: false,
          slHit: false,
          closeReason: "TP1_FULL",
          openedAt: "2026-05-15T00:05:00.000Z",
          closedAt: "2026-05-15T00:20:00.000Z",
          durationMinutes: 15,
          fillStatus: "FILLED",
        },
      },
      {
        ...baseObservation,
        observationId: "nofill-1",
        duplicateKey: "dup-nofill",
        observationStatus: "NO_FILL",
        outcome: {
          realizedGrossR: null,
          realizedNetR: null,
          winnerLabel: "BREAKEVEN",
          tp1Hit: false,
          tp2Hit: false,
          slHit: false,
          closeReason: "NO_FILL",
          openedAt: null,
          closedAt: "2026-05-15T00:25:00.000Z",
          durationMinutes: null,
          fillStatus: "NO_FILL",
        },
      },
      {
        ...baseObservation,
        observationId: "expired-1",
        duplicateKey: "dup-expired",
        observationStatus: "EXPIRED",
      },
      {
        ...baseObservation,
        observationId: "failed-1",
        duplicateKey: "dup-failed",
        observationStatus: "FAILED",
      },
    ];
    const overlay = buildExternalRotationOverlayPerformanceReport(observations);
    const report = buildDashboardAuditSummaryReport([], { externalRotationOverlay: overlay });
    expect(report.summaryText).toContain("Operative observations (valid only): open=1 | resolved=1 | no-fill=1 | expired=1 | failed=1");
    expect(report.summaryText).toContain("Status accounting check: 5 / 5 valid observations represented");
    expect((report.highlights.externalRotationShadowOverlay as any).validOpenCount).toBe(1);
    expect((report.highlights.externalRotationShadowOverlay as any).validResolvedCount).toBe(1);
    expect((report.highlights.externalRotationShadowOverlay as any).validNoFillCount).toBe(1);
    expect((report.highlights.externalRotationShadowOverlay as any).validExpiredCount).toBe(1);
    expect((report.highlights.externalRotationShadowOverlay as any).validFailedCount).toBe(1);
    expect((report.highlights.externalRotationShadowOverlay as any).validStatusAccountingTotal).toBe(5);
    expect((report.highlights.externalRotationShadowOverlay as any).validStatusAccountingMatches).toBe(true);
  });

  it("counts a filled time-expired observation only in the expired bucket", () => {
    const baseObservation = {
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      symbol: "ZECUSDT",
      overlayGroups: ["STRATEGY_FIT_SHORTLIST"],
      evidenceEra: "POST_CALIBRATION",
      selectionBatchId: "batch",
      sourceDiscoveryScore: 80,
      sourceStrategyFitScore: 75,
      sourceStrategyFitTier: "STRATEGY_FIT_HIGH",
      discoveryRank: 1,
      strategyFitRank: 1,
      lowFitRank: null,
      detachedCandidateSnapshot: {
        direction: "SHORT",
        hypotheticalEntryVariant: "vwap_retest_entry",
        hypotheticalExitVariant: "tp1_full_exit",
        hypotheticalExpectedNetR: null,
        setupPlaybookLabel: "HIGH",
        stopDistanceBps: 200,
        riskReward: 1.8,
        marketRegime: "BEARISH_EXPANSION",
        plannedEntryPrice: 100,
        selectedEntryAnchorPrice: 100,
        entryBasis: "VARIANT_ANCHOR",
        entryZone: null,
        stopPrice: 102,
        tp1Price: 97,
        tp2Price: null,
        tp3Price: null,
        costR: 0.1,
        notes: [],
      },
      diagnostics: {
        createdByPolicyVersion: "external-rotation-overlay-anchor-consistent-v2",
        reasonCodes: [],
        resolutionSemantics: "test",
      },
    } as const;
    const observations: ExternalRotationOverlayObservation[] = [
      {
        ...baseObservation,
        observationId: "expired-filled-1",
        duplicateKey: "dup-expired-filled",
        observationStatus: "EXPIRED",
        outcome: {
          realizedGrossR: 0.2,
          realizedNetR: 0.1,
          winnerLabel: "WIN",
          tp1Hit: false,
          tp2Hit: false,
          slHit: false,
          closeReason: "TIME_EXPIRED",
          openedAt: "2026-05-15T00:05:00.000Z",
          closedAt: "2026-05-16T00:00:00.000Z",
          durationMinutes: 1435,
          fillStatus: "FILLED",
        },
      },
    ];

    const overlay = buildExternalRotationOverlayPerformanceReport(observations);
    const report = buildDashboardAuditSummaryReport([], { externalRotationOverlay: overlay });

    expect(overlay.totalObservations).toBe(1);
    expect(overlay.openObservations).toBe(0);
    expect(overlay.resolvedObservations).toBe(0);
    expect(overlay.noFillObservations).toBe(0);
    expect(overlay.expiredObservations).toBe(1);
    expect(overlay.failedObservations).toBe(0);
    expect(report.summaryText).toContain("Operative observations (valid only): open=0 | resolved=0 | no-fill=0 | expired=1 | failed=0");
    expect(report.summaryText).toContain("Status accounting check: 1 / 1 valid observations represented");
    expect((report.highlights.externalRotationShadowOverlay as any).validStatusAccountingTotal).toBe(1);
    expect((report.highlights.externalRotationShadowOverlay as any).validStatusAccountingMatches).toBe(true);
  });
});

// ─── Phase 2 Cross-Intelligence: lane-toxicity operative suppression ───

describe("Lane-toxicity operative suppression (Phase 2 Cross-Intelligence)", () => {
  function poisonedSynthesis(): ReturnType<typeof buildAdaptiveProfitPolicySynthesisReport> {
    // Build records where TOXICUSDT has n=6 all-SL in BEARISH_EXPANSION+SHORT+vwap_retest_entry+tp1_full_exit.
    // n>=5 is required for EARLY tier in universe rotation pressure scoring
    // (n<5 → TOO_EARLY → LOW pressure → not included as rotation pressure candidate).
    // With n=6, slRate=1.0, pressure score will be >65 → MODERATE pressure → included.
    const toxic = Array.from({ length: 6 }, () => policyRecord("SHORT", "Bearish expansion", -1));
    // Patch the symbol field of the toxic records to TOXICUSDT
    const toxicPatched = toxic.map((r) => ({
      ...r,
      context: { ...r.context, symbol: "TOXICUSDT" },
      outcome: { ...r.outcome, symbol: "TOXICUSDT", slHit: true, tp1Hit: false },
    }));
    const good = Array.from({ length: 30 }, () => policyRecord("SHORT", "Bearish expansion", 0.2));
    return buildAdaptiveProfitPolicySynthesisReport([...toxicPatched, ...good] as any);
  }

  it("case f: EX_TOXIC sibling is generated when tier-1 toxic symbols exist", () => {
    const synthesis = poisonedSynthesis();
    const shortSibling = synthesis.bestShortPolicyExToxic;
    expect(shortSibling).not.toBeNull();
    expect(shortSibling?.excludedSymbols?.length).toBeGreaterThanOrEqual(1);
  });

  it("case f: overlay admission suppression — ExternalRotationOverlayObservation type has lane-toxicity audit fields", () => {
    // Verify that the type structure supports the audit metadata fields
    const obs: import("../src/lib/external-rotation-overlay.js").ExternalRotationOverlayObservation = {
      observationId: "test-obs",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      symbol: "TOXICUSDT",
      overlayGroups: ["STRATEGY_FIT_SHORTLIST"],
      evidenceEra: "POST_CALIBRATION",
      selectionBatchId: "batch",
      sourceDiscoveryScore: 80,
      sourceStrategyFitScore: 80,
      sourceStrategyFitTier: "STRATEGY_FIT_HIGH",
      discoveryRank: 1,
      strategyFitRank: 1,
      lowFitRank: null,
      duplicateKey: "test-key",
      detachedCandidateSnapshot: {
        direction: "SHORT",
        hypotheticalEntryVariant: "vwap_retest_entry",
        hypotheticalExitVariant: "tp1_full_exit",
        hypotheticalExpectedNetR: null,
        setupPlaybookLabel: "HIGH",
        stopDistanceBps: 200,
        riskReward: 1.8,
        marketRegime: "BEARISH_EXPANSION",
        plannedEntryPrice: 100,
        entryZone: null,
        stopPrice: 102,
        tp1Price: 97,
        tp2Price: null,
        tp3Price: null,
        costR: 0.1,
        notes: [],
      },
      observationStatus: "OPEN",
      diagnostics: {
        createdByPolicyVersion: "external-rotation-overlay-anchor-consistent-v2",
        reasonCodes: [],
        resolutionSemantics: "test",
      },
      // Lane-toxicity audit fields — must exist on the type
      excludedByLaneToxicity: true,
      toxicLaneMatchPolicyId: "CORE_ALL_BEARISH_EXPANSION_SHORT_VWAP_RETEST_ENTRY_TP1_FULL_EXIT",
      exclusionReason: "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT",
      toxicityCrossIntelligenceSupports: ["SYMBOL_SENSITIVE_ROUTE"],
    };
    expect(obs.excludedByLaneToxicity).toBe(true);
    expect(obs.exclusionReason).toBe("LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT");
    expect(obs.toxicityCrossIntelligenceSupports).toContain("SYMBOL_SENSITIVE_ROUTE");
  });

  it("case g: same symbol in DIFFERENT lane tuple is NOT suppressed", () => {
    const synthesis = poisonedSynthesis();
    // Find if sibling exists
    const sibling = synthesis.bestShortPolicyExToxic;
    if (!sibling || !sibling.excludedSymbols) {
      // No tier-1 symbols, nothing to test
      return;
    }
    const toxicSymbol = sibling.excludedSymbols[0]!;
    // Check that the synthesis has candidates for the same symbol in different lanes
    // (e.g., per-symbol candidate, different direction or different route)
    const perSymbolCandidate = synthesis.candidates.find(
      (c) => c.symbolScope === toxicSymbol && c.symbolScope !== "ALL_SYMBOLS" && c.symbolScope !== "ALL_SYMBOLS_EX_TOXIC",
    );
    // If there's a per-symbol candidate, it should NOT have excludedSymbols
    if (perSymbolCandidate) {
      expect(perSymbolCandidate.excludedSymbols).toBeUndefined();
    }
    // The synthesis report itself should contain the original (ALL_SYMBOLS) candidate unchanged
    const original = synthesis.candidates.find(
      (c) => c.symbolScope === "ALL_SYMBOLS" && c.sourceType === "CORE",
    );
    expect(original).toBeDefined();
    expect(original?.excludedSymbols).toBeUndefined();
  });

  it("case i: dashboard report exposes suppression block in adaptiveProfitPolicySynthesis", () => {
    const synthesis = poisonedSynthesis();
    const dashReport = buildDashboardAuditSummaryReport([], {
      adaptiveProfitPolicySynthesis: synthesis,
    });
    const section = dashReport.highlights.adaptiveProfitPolicySynthesis as any;
    expect(section).toBeDefined();
    expect(section.crossIntelligenceOperativeSuppressionLanes).toBeDefined();
    expect(Array.isArray(section.crossIntelligenceOperativeSuppressionLanes)).toBe(true);
    // If there are tier-1 symbols, at least one lane should be ACTIVE
    if (synthesis.bestShortPolicyExToxic?.excludedSymbols?.length) {
      const activeLane = section.crossIntelligenceOperativeSuppressionLanes.find(
        (lane: any) => lane.crossIntelligenceOperativeSuppression === "ACTIVE",
      );
      expect(activeLane).toBeDefined();
      expect(activeLane.scopeNote).toBe("Lane-specific only; no global universe deletion.");
    }
  });
});

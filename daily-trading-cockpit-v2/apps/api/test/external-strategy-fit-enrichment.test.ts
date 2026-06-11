import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Candidate, ShadowPosition, VariantSelectionSnapshot } from "@dtc/shared";

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
  buildExternalStrategyFitEnrichmentReport,
  fetchExternalStrategyFitTechnicalEvaluations,
  type ExternalStrategyFitTechnicalEvaluation,
} from "../src/lib/external-strategy-fit-enrichment.js";
import type { ExternalCandidateDiscoveryIntelligenceReport } from "../src/lib/external-candidate-discovery-intelligence.js";
import { registerShadowRoutes } from "../src/routes/shadow.js";

function makeDiscovery(symbols = ["GOODUSDT", "WEAKUSDT"]): ExternalCandidateDiscoveryIntelligenceReport {
  const shortlist = symbols.map((symbol, index) => ({
    symbol,
    alreadyInCurrentUniverse: false,
    tradabilityVerdict: "TRADABLE" as const,
    discoveryScore: index === 0 ? 70 : 95,
    promisingSimilarityScore: index === 0 ? 70 : 95,
    toxicSimilarityPenalty: 0,
    netDiscoveryScore: index === 0 ? 70 : 95,
    discoveryTier: "EXPLORATORY_SHORTLIST" as const,
    reasons: [],
    matchedPromisingFingerprintFeatures: [],
    matchedToxicFingerprintFeatures: [],
    marketMetadataSummary: {
      quoteVolume24h: 100_000_000,
      spreadBps: 2,
      priceChangePct24h: 3,
      fundingRate: null,
      openInterest: null,
    },
    cautionLabels: [],
  }));
  return {
    generatedAt: "2026-05-15T00:00:00.000Z",
    evidenceEra: "POST_CALIBRATION",
    currentUniverseSymbolCount: 20,
    externalUniverseSymbolsConsidered: shortlist.length,
    externalUniverseSymbolsTradable: shortlist.length,
    externalUniverseSymbolsRejected: 0,
    metadataDiagnostics: {
      sourceStatus: "HEALTHY",
      generatedAt: "2026-05-15T00:00:00.000Z",
      cacheStatus: "MISS",
      servedFromCache: false,
      exchangeInfo: { ok: true, rawCount: 2 },
      ticker24h: { ok: true, rawCount: 2 },
      bookTicker: { ok: true, rawCount: 2 },
      join: { joinedMetadataCount: 2, missingTickerCount: 0, missingBookTickerCount: 0, finalMetadataCount: 2 },
      notes: [],
    },
    discoveryReadiness: {
      advisoryEngineReady: true,
      readyForUniverseExpansionInfluence: false,
      readyForRotationShadowOverlay: false,
      confidence: "LOW",
      reasons: ["All promising fingerprints are LOW confidence."],
    },
    sourceMetadata: {
      source: "test",
      instrumentTypeFilter: "SPOT",
      quoteAssetFilter: "USDT",
      minQuoteVolume24hUsd: 10_000_000,
      maxSpreadBps: 10,
    },
    tradabilityBreakdown: {
      TRADABLE: shortlist.length,
      LOW_LIQUIDITY: 0,
      EXCESSIVE_SPREAD: 0,
      NOT_SUPPORTED_INSTRUMENT: 0,
      STATUS_NOT_TRADING: 0,
      DATA_INCOMPLETE: 0,
      CURRENT_UNIVERSE_MEMBER: 0,
    },
    discoveryFingerprintBasis: {
      promisingFingerprintConfidence: "LOW",
      toxicFingerprintConfidence: "LOW",
      promisingFingerprintCount: 1,
      toxicFingerprintCount: 1,
      promisingFingerprintSummary: "LOW",
      toxicFingerprintSummary: "LOW",
      maturityWarning: "LOW",
    },
    shortlistedCandidates: shortlist,
    rejectedCandidatesSample: [],
    categoryBuckets: {
      highLiquidityExploratory: [],
      highVolatilityTradable: [],
      stableLiquidityCandidates: [],
      dataIncompleteCandidates: [],
    },
    patchHypotheses: [],
    answerCards: [],
    notes: [],
  };
}

function makeCandidate(symbol: string, overrides: Partial<Candidate> = {}): Candidate {
  const indicator = { trend: "BEARISH" };
  return {
    symbol,
    finalDirection: "SHORT",
    direction: "SHORT",
    status: "WAIT",
    opportunityScore: 78,
    confidence: 72,
    dangerScore: 32,
    trendScore: 80,
    riskReward: 1.8,
    indicators: {
      fiveMinute: indicator,
      fifteenMinute: indicator,
      oneHour: indicator,
    },
    ...overrides,
  } as Candidate;
}

function makePlan(overrides: Partial<VariantSelectionSnapshot> = {}): VariantSelectionSnapshot {
  return {
    selectedEntryVariant: "vwap_retest_entry",
    selectedExitVariant: "tp1_full_exit",
    routeMode: "DATA_COLLECTION",
    expectedNetR: null,
    stopDistanceBps: 220,
    costR: 0.15,
    ...overrides,
  } as VariantSelectionSnapshot;
}

function makeCandles(symbol: string) {
  const start = 1_700_000_000_000;
  return Array.from({ length: 150 }, (_, i) => {
    const base = symbol === "GOODUSDT" ? 100 - i * 0.05 : 100 + Math.sin(i / 4);
    return [start + i * 60_000, String(base + 0.1), String(base + 0.5), String(base - 0.5), String(base), "1000", start + i * 60_000 + 1, "100000", 1, "0", "0", "0"];
  });
}

function makeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const symbol = url.searchParams.get("symbol") ?? "GOODUSDT";
    let payload: unknown;
    if (url.pathname === "/api/v3/exchangeInfo") {
      payload = { symbols: [{ symbol: "GOODUSDT", status: "TRADING", baseAsset: "GOOD", quoteAsset: "USDT", isSpotTradingAllowed: true, permissions: [] }] };
    } else if (url.pathname === "/api/v3/ticker/24hr" && url.searchParams.has("symbol")) {
      payload = { symbol, volume: "1000000", quoteVolume: "100000000", lastPrice: "100", priceChangePercent: "2" };
    } else if (url.pathname === "/api/v3/ticker/24hr") {
      payload = [{ symbol: "GOODUSDT", volume: "1000000", quoteVolume: "100000000", lastPrice: "100", priceChangePercent: "2" }];
    } else if (url.pathname === "/api/v3/ticker/bookTicker" && url.searchParams.has("symbol")) {
      payload = { symbol, bidPrice: "99.99", askPrice: "100.01" };
    } else if (url.pathname === "/api/v3/ticker/bookTicker") {
      payload = [{ symbol: "GOODUSDT", bidPrice: "99.99", askPrice: "100.01" }];
    } else {
      payload = makeCandles(symbol);
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("external strategy-fit enrichment", () => {
  it("returns a safe empty report", () => {
    const report = buildExternalStrategyFitEnrichmentReport({ discoveryReport: makeDiscovery([]), technicalEvaluations: [] });
    expect(report.enrichedCandidateCount).toBe(0);
    expect(report.enrichmentReadiness.advisoryEngineReady).toBe(false);
    expect(report.enrichmentReadiness.readyForUniverseInfluence).toBe(false);
  });

  it("scores strong setup/regime/geometry above weak candidate even when weak has higher metadata score", () => {
    const evals: ExternalStrategyFitTechnicalEvaluation[] = [
      { symbol: "GOODUSDT", technicalDataStatus: "HEALTHY", candidate: makeCandidate("GOODUSDT"), detachedExecutionPlan: makePlan() },
      {
        symbol: "WEAKUSDT",
        technicalDataStatus: "HEALTHY",
        candidate: makeCandidate("WEAKUSDT", { finalDirection: "NEUTRAL", direction: "NEUTRAL", status: "SKIP", opportunityScore: 35, confidence: 30, dangerScore: 70, trendScore: 30, riskReward: 0.8 }),
        detachedExecutionPlan: makePlan({ selectedEntryVariant: "base_current_entry", stopDistanceBps: 70, costR: 0.7 }),
      },
    ];
    const report = buildExternalStrategyFitEnrichmentReport({ discoveryReport: makeDiscovery(), technicalEvaluations: evals });
    expect(report.topStrategyFitCandidates[0]?.symbol).toBe("GOODUSDT");
    expect(report.topStrategyFitCandidates[0]!.strategyFitScore).toBeGreaterThan(report.candidates.find((c) => c.symbol === "WEAKUSDT")!.strategyFitScore);
    expect(report.candidates.every((c) => c.strategyFitScore >= 0 && c.strategyFitScore <= 100)).toBe(true);
  });

  it("penalizes ultra-tight/fragile geometry", () => {
    const report = buildExternalStrategyFitEnrichmentReport({
      discoveryReport: makeDiscovery(["GOODUSDT"]),
      technicalEvaluations: [{ symbol: "GOODUSDT", technicalDataStatus: "HEALTHY", candidate: makeCandidate("GOODUSDT"), detachedExecutionPlan: makePlan({ stopDistanceBps: 80, costR: 0.6 }) }],
    });
    expect(report.candidates[0]!.stopGeometryCredibilityHint).toBe("FRAGILE");
    expect(report.candidates[0]!.reasons.some((r) => r.includes("fragile"))).toBe(true);
  });

  it("keeps per-candidate fetch failures contained and surfaces diagnostics", () => {
    const report = buildExternalStrategyFitEnrichmentReport({
      discoveryReport: makeDiscovery(["GOODUSDT"]),
      technicalEvaluations: [{ symbol: "GOODUSDT", technicalDataStatus: "FAILED", candidate: null, detachedExecutionPlan: null, errorMessage: "forced failure" }],
    });
    expect(report.failedCandidateCount).toBe(1);
    expect(report.candidates[0]!.strategyFitTier).toBe("NOT_EVALUABLE");
    expect(report.diagnostics.failureReasonCounts["forced failure"]).toBe(1);
    expect(report.diagnostics.failedCandidatesSample).toEqual([{ symbol: "GOODUSDT", errorMessage: "forced failure" }]);
    expect(report.patchHypotheses.every((h) => h.doesNotImplementNow)).toBe(true);
  });

  it("does not collapse enrichment just because discovery is operating from stale metadata", () => {
    const discovery = makeDiscovery(["GOODUSDT"]);
    discovery.metadataDiagnostics = {
      ...discovery.metadataDiagnostics,
      sourceStatus: "DEGRADED_USING_CACHE",
      cacheStatus: "STALE_FALLBACK",
      servedFromCache: true,
      exchangeInfo: { ok: false, rawCount: 0, errorMessage: "timeout" },
      ticker24h: { ok: true, rawCount: 1 },
      bookTicker: { ok: true, rawCount: 1 },
    };
    const report = buildExternalStrategyFitEnrichmentReport({
      discoveryReport: discovery,
      technicalEvaluations: [{
        symbol: "GOODUSDT",
        technicalDataStatus: "HEALTHY",
        candidate: makeCandidate("GOODUSDT"),
        detachedExecutionPlan: makePlan(),
      }],
    });
    expect(report.enrichedCandidateCount).toBe(1);
    expect(report.failedCandidateCount).toBe(0);
  });

  it("preserves partial-success: 5 symbols enrich while 5 fail on a flaky Binance", async () => {
    const failingSymbols = new Set(["SYMBOL1USDT", "SYMBOL2USDT", "SYMBOL3USDT", "SYMBOL4USDT", "SYMBOL5USDT"]);
    const allSymbols = [
      "SYMBOL1USDT", "SYMBOL2USDT", "SYMBOL3USDT", "SYMBOL4USDT", "SYMBOL5USDT",
      "SYMBOL6USDT", "SYMBOL7USDT", "SYMBOL8USDT", "SYMBOL9USDT", "SYMBOL10USDT",
    ];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const symbol = url.searchParams.get("symbol") ?? "";
      if (failingSymbols.has(symbol)) {
        throw new TypeError("fetch failed");
      }
      let payload: unknown;
      if (url.pathname === "/api/v3/ticker/24hr") {
        payload = { symbol, volume: "1000000", quoteVolume: "100000000" };
      } else if (url.pathname === "/api/v3/ticker/bookTicker") {
        payload = { symbol, bidPrice: "99.99", askPrice: "100.01" };
      } else {
        payload = makeCandles(symbol);
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const binanceClient = new BinanceClient(fetchImpl);
    const discoveryReport = makeDiscovery(allSymbols);
    const evaluations = await fetchExternalStrategyFitTechnicalEvaluations({ discoveryReport, binanceClient });
    const failed = evaluations.filter((e) => e.technicalDataStatus === "FAILED");
    const succeeded = evaluations.filter((e) => e.technicalDataStatus !== "FAILED");
    expect(evaluations).toHaveLength(10);
    expect(succeeded).toHaveLength(5);
    expect(failed).toHaveLength(5);
    expect(new Set(failed.map((e) => e.symbol))).toEqual(failingSymbols);
  }, 30_000);

  it("still enriches when primary spot host fails but fallback host succeeds", async () => {
    const requestedHosts: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedHosts.push(url.host);
      if (url.host === "api.binance.com") {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      const symbol = url.searchParams.get("symbol") ?? "GOODUSDT";
      let payload: unknown;
      if (url.pathname === "/api/v3/ticker/24hr") {
        payload = { symbol, volume: "1000000", quoteVolume: "100000000" };
      } else if (url.pathname === "/api/v3/ticker/bookTicker") {
        payload = { symbol, bidPrice: "99.99", askPrice: "100.01" };
      } else {
        payload = makeCandles(symbol);
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const evaluations = await fetchExternalStrategyFitTechnicalEvaluations({
      discoveryReport: makeDiscovery(["GOODUSDT"]),
      binanceClient: new BinanceClient(fetchImpl),
    });

    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.technicalDataStatus).not.toBe("FAILED");
    expect(requestedHosts).toContain("api.binance.com");
    expect(requestedHosts).toContain("api-gcp.binance.com");
  });

  it("endpoint works and does not mutate shadow state", async () => {
    const app = Fastify({ logger: false });
    const positions: ShadowPosition[] = [];
    let calls = 0;
    const fetchImpl = makeFetch();
    await registerShadowRoutes(app, {
      getAllPositions() {
        calls += 1;
        return positions;
      },
    } as never, { binanceClient: new BinanceClient(fetchImpl), metadataFetchImpl: fetchImpl });
    const response = await app.inject({ method: "GET", url: "/api/shadow/external-strategy-fit-enrichment?era=ALL_TIME" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.evidenceEra).toBe("ALL_TIME");
    expect(body.enrichmentReadiness.readyForUniverseInfluence).toBe(false);
    expect(body.topStrategyFitCandidates.length).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([]);
    expect(calls).toBeGreaterThan(0);
    await app.close();
  });
});

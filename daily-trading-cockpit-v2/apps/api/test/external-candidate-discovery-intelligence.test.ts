import { describe, it, expect } from "vitest";
import {
  buildExternalCandidateDiscoveryIntelligenceReport,
  type ExternalDiscoveryCandidateMetadata,
} from "../src/lib/external-candidate-discovery-intelligence.js";
import type { ExternalCandidateMetadataFetchDiagnostics } from "../src/lib/external-candidate-metadata-fetcher.js";
import type { RotationFingerprint } from "../src/lib/universe-rotation-intelligence.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeMeta(overrides: Partial<ExternalDiscoveryCandidateMetadata>): ExternalDiscoveryCandidateMetadata {
  // Use spread so explicit nulls in `overrides` are preserved.
  return {
    symbol: "ATOMUSDT",
    baseAsset: "ATOM",
    quoteAsset: "USDT",
    instrumentType: "SPOT",
    status: "TRADING",
    latestPrice: 8.0,
    quoteVolume24h: 80_000_000,
    priceChangePct24h: 3.2,
    spreadBps: 3,
    fundingRate: 0.01,
    openInterest: null,
    alreadyInCurrentUniverse: false,
    ...overrides,
  };
}

function makePromisingFingerprint(overrides: Partial<RotationFingerprint> = {}): RotationFingerprint {
  return {
    type: "PROMISING",
    pattern: "LONG trades on ADAUSDT show sustained positive R contribution",
    exampleSymbol: "ADAUSDT",
    exampleDirection: "LONG",
    exampleNetAvgR: 0.16,
    sampleCount: 7,
    confidence: "LOW",
    interpretation: "Early promising signal — directional only.",
    ...overrides,
  };
}

function makeToxicFingerprint(overrides: Partial<RotationFingerprint> = {}): RotationFingerprint {
  return {
    type: "TOXIC",
    pattern: "SHORT trades on SUIUSDT show consistent negative R contribution",
    exampleSymbol: "SUIUSDT",
    exampleDirection: "SHORT",
    exampleNetAvgR: -2.02,
    sampleCount: 7,
    confidence: "LOW",
    interpretation: "Persistent drag at small sample size.",
    ...overrides,
  };
}

const CURRENT_UNIVERSE = ["BTCUSDT", "ETHUSDT", "ADAUSDT", "SUIUSDT", "BNBUSDT"];

function makeDiagnostics(overrides: Partial<ExternalCandidateMetadataFetchDiagnostics> = {}): ExternalCandidateMetadataFetchDiagnostics {
  return {
    sourceStatus: "HEALTHY",
    generatedAt: "2026-05-15T00:00:00.000Z",
    cacheStatus: "MISS",
    servedFromCache: false,
    exchangeInfo: { ok: true, rawCount: 600 },
    ticker24h: { ok: true, rawCount: 600 },
    bookTicker: { ok: true, rawCount: 600 },
    join: {
      joinedMetadataCount: 580,
      missingTickerCount: 0,
      missingBookTickerCount: 0,
      finalMetadataCount: 580,
    },
    notes: [],
    ...overrides,
  };
}

// ─── Empty input ──────────────────────────────────────────────────────────────

describe("empty input", () => {
  it("returns a valid empty report with no crash", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: [],
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.externalUniverseSymbolsConsidered).toBe(0);
    expect(report.externalUniverseSymbolsTradable).toBe(0);
    expect(report.shortlistedCandidates).toHaveLength(0);
    expect(report.rejectedCandidatesSample).toHaveLength(0);
  });

  it("advisory engine not ready when no metadata loaded", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: [],
      externalCandidateMetadata: [],
      metadataDiagnostics: makeDiagnostics({ sourceStatus: "FAILED", exchangeInfo: { ok: false, rawCount: 0, errorMessage: "ticker failed" } }),
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.advisoryEngineReady).toBe(false);
  });

  it("readiness confidence is LOW for empty input", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: [],
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.confidence).toBe("LOW");
  });

  it("readyForUniverseExpansionInfluence is always false", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: [],
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.readyForUniverseExpansionInfluence).toBe(false);
  });

  it("readyForRotationShadowOverlay is always false", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: [],
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.readyForRotationShadowOverlay).toBe(false);
  });
});

describe("metadata diagnostics and readiness", () => {
  it("surfaces healthy metadata diagnostics and joined counts", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [makeMeta({ symbol: "ATOMUSDT" })],
      metadataDiagnostics: makeDiagnostics(),
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.metadataDiagnostics.sourceStatus).toBe("HEALTHY");
    expect(report.metadataDiagnostics.exchangeInfo.rawCount).toBe(600);
    expect(report.metadataDiagnostics.join.joinedMetadataCount).toBe(580);
  });

  it("uses source-specific readiness blocker when metadata fetch failed", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      metadataDiagnostics: makeDiagnostics({
        sourceStatus: "FAILED",
        exchangeInfo: { ok: false, rawCount: 0, errorMessage: "Binance fetch failed (451) for https://api.binance.com/api/v3/exchangeInfo" },
        ticker24h: { ok: false, rawCount: 0, errorMessage: "Binance fetch failed (451) for https://api.binance.com/api/v3/ticker/24hr" },
        bookTicker: { ok: false, rawCount: 0, errorMessage: "Binance fetch failed (451) for https://api.binance.com/api/v3/ticker/bookTicker" },
        join: { joinedMetadataCount: 0, missingTickerCount: 0, missingBookTickerCount: 0, finalMetadataCount: 0 },
      }),
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.reasons[0]).toContain("External candidate metadata fetch failed");
  });

  it("distinguishes healthy zero-survivor state from fetch failure", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      metadataDiagnostics: makeDiagnostics({
        sourceStatus: "HEALTHY",
        join: { joinedMetadataCount: 0, missingTickerCount: 0, missingBookTickerCount: 0, finalMetadataCount: 0 },
      }),
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.reasons[0]).toContain("Metadata loaded successfully");
    expect(report.discoveryReadiness.reasons[0]).not.toContain("fetch failed");
  });

  it("DEGRADED_USING_CACHE → advisoryEngineReady=true with stale-cache reason", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [makeMeta({ symbol: "ATOMUSDT" })],
      metadataDiagnostics: makeDiagnostics({
        sourceStatus: "DEGRADED_USING_CACHE",
        cacheStatus: "STALE_FALLBACK",
        servedFromCache: true,
        exchangeInfo: { ok: false, rawCount: 0, errorMessage: "timeout" },
        ticker24h: { ok: false, rawCount: 0, errorMessage: "timeout" },
        bookTicker: { ok: false, rawCount: 0, errorMessage: "timeout" },
        join: { joinedMetadataCount: 580, missingTickerCount: 0, missingBookTickerCount: 0, finalMetadataCount: 580 },
      }),
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.advisoryEngineReady).toBe(true);
    expect(report.discoveryReadiness.reasons.some((r) => r.includes("cached metadata"))).toBe(true);
    expect(report.discoveryReadiness.reasons.some((r) => r.includes("fetch failed"))).toBe(false);
  });

  it("HEALTHY fresh fetch → advisoryEngineReady=true, no stale-cache reason", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [makeMeta({ symbol: "ATOMUSDT" })],
      metadataDiagnostics: makeDiagnostics(),
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.advisoryEngineReady).toBe(true);
    expect(report.discoveryReadiness.reasons.every((r) => !r.includes("cached metadata"))).toBe(true);
    expect(report.metadataDiagnostics.sourceStatus).toBe("HEALTHY");
  });

  it("FAILED → advisoryEngineReady=false", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      metadataDiagnostics: makeDiagnostics({
        sourceStatus: "FAILED",
        cacheStatus: "MISS",
        servedFromCache: false,
        exchangeInfo: { ok: false, rawCount: 0, errorMessage: "connection refused" },
        ticker24h: { ok: false, rawCount: 0, errorMessage: "connection refused" },
        bookTicker: { ok: false, rawCount: 0, errorMessage: "connection refused" },
        join: { joinedMetadataCount: 0, missingTickerCount: 0, missingBookTickerCount: 0, finalMetadataCount: 0 },
      }),
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.advisoryEngineReady).toBe(false);
    expect(report.discoveryReadiness.reasons[0]).toContain("fetch failed");
  });
});

// ─── Tradability filters ──────────────────────────────────────────────────────

describe("tradability filters", () => {
  it("rejects LOW_LIQUIDITY candidates below the volume threshold", () => {
    const meta = makeMeta({ symbol: "TINYUSDT", quoteVolume24h: 1_000_000 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    const a = report.rejectedCandidatesSample.find((x) => x.symbol === "TINYUSDT");
    expect(a?.tradabilityVerdict).toBe("LOW_LIQUIDITY");
  });

  it("rejects non-USDT quote assets as NOT_SUPPORTED_INSTRUMENT", () => {
    const meta = makeMeta({ symbol: "ATOMBUSD", quoteAsset: "BUSD" });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.rejectedCandidatesSample.find((x) => x.symbol === "ATOMBUSD")?.tradabilityVerdict)
      .toBe("NOT_SUPPORTED_INSTRUMENT");
  });

  it("rejects inactive symbols as STATUS_NOT_TRADING", () => {
    const meta = makeMeta({ symbol: "DEADUSDT", status: "BREAK" });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.rejectedCandidatesSample.find((x) => x.symbol === "DEADUSDT")?.tradabilityVerdict)
      .toBe("STATUS_NOT_TRADING");
  });

  it("rejects wide-spread candidates as EXCESSIVE_SPREAD", () => {
    const meta = makeMeta({ symbol: "WIDEUSDT", spreadBps: 50 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.rejectedCandidatesSample.find((x) => x.symbol === "WIDEUSDT")?.tradabilityVerdict)
      .toBe("EXCESSIVE_SPREAD");
  });

  it("rejects DATA_INCOMPLETE candidates", () => {
    const meta = makeMeta({ symbol: "PARTIALUSDT", quoteVolume24h: null, latestPrice: null });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    const a = report.tradabilityBreakdown.DATA_INCOMPLETE;
    expect(a).toBe(1);
  });

  it("classifies current-universe members as CURRENT_UNIVERSE_MEMBER and excludes from shortlist", () => {
    const meta = makeMeta({ symbol: "BTCUSDT", alreadyInCurrentUniverse: true });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    expect(report.tradabilityBreakdown.CURRENT_UNIVERSE_MEMBER).toBe(1);
    expect(report.shortlistedCandidates.find((x) => x.symbol === "BTCUSDT")).toBeUndefined();
  });

  it("marks symbols in currentUniverseSymbols as members even if metadata says false", () => {
    const meta = makeMeta({ symbol: "BTCUSDT", alreadyInCurrentUniverse: false });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.tradabilityBreakdown.CURRENT_UNIVERSE_MEMBER).toBe(1);
  });

  it("allows tradable external symbols through to TRADABLE bucket", () => {
    const meta = makeMeta({ symbol: "ATOMUSDT", quoteVolume24h: 100_000_000, spreadBps: 2 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.tradabilityBreakdown.TRADABLE).toBe(1);
    expect(report.externalUniverseSymbolsTradable).toBe(1);
  });
});

// ─── Discovery scoring ────────────────────────────────────────────────────────

describe("discovery scoring", () => {
  it("healthier liquidity scores higher than marginal liquidity", () => {
    const healthy = makeMeta({ symbol: "HEALTHY", quoteVolume24h: 100_000_000, spreadBps: 3 });
    const marginal = makeMeta({ symbol: "MARGINAL", quoteVolume24h: 12_000_000, spreadBps: 3 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [healthy, marginal],
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    const h = [...report.shortlistedCandidates, ...report.rejectedCandidatesSample]
      .find((x) => x.symbol === "HEALTHY");
    const m = [...report.shortlistedCandidates, ...report.rejectedCandidatesSample]
      .find((x) => x.symbol === "MARGINAL");
    expect(h!.netDiscoveryScore).toBeGreaterThan(m!.netDiscoveryScore);
  });

  it("extreme volatility raises toxic similarity penalty", () => {
    const calm = makeMeta({ symbol: "CALM", quoteVolume24h: 100_000_000, priceChangePct24h: 5 });
    const wild = makeMeta({ symbol: "WILD", quoteVolume24h: 100_000_000, priceChangePct24h: 45 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [calm, wild],
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [makeToxicFingerprint()],
    });
    const c = [...report.shortlistedCandidates, ...report.rejectedCandidatesSample]
      .find((x) => x.symbol === "CALM");
    const w = [...report.shortlistedCandidates, ...report.rejectedCandidatesSample]
      .find((x) => x.symbol === "WILD");
    expect(w!.toxicSimilarityPenalty).toBeGreaterThan(c!.toxicSimilarityPenalty);
  });

  it("netDiscoveryScore is bounded to 0-100", () => {
    const meta = makeMeta({ symbol: "BOUND", quoteVolume24h: 100_000_000 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    const a = [...report.shortlistedCandidates, ...report.rejectedCandidatesSample]
      .find((x) => x.symbol === "BOUND");
    expect(a!.netDiscoveryScore).toBeGreaterThanOrEqual(0);
    expect(a!.netDiscoveryScore).toBeLessThanOrEqual(100);
  });

  it("symbol matching toxic fingerprint exampleSymbol receives extra penalty", () => {
    // toxic fingerprint says SUIUSDT. Even if SUIUSDT-like external metadata is tradable,
    // when it's the same symbol it gets a direct toxic feature match
    const meta = makeMeta({ symbol: "SUIUSDT", quoteVolume24h: 100_000_000, alreadyInCurrentUniverse: false });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: [],
      externalCandidateMetadata: [meta],
      promisingFingerprints: [],
      toxicFingerprints: [makeToxicFingerprint()],
    });
    const a = [...report.shortlistedCandidates, ...report.rejectedCandidatesSample]
      .find((x) => x.symbol === "SUIUSDT");
    expect(a!.matchedToxicFingerprintFeatures.some((f) => f.includes("toxic fingerprint set"))).toBe(true);
  });
});

// ─── Shortlist logic ──────────────────────────────────────────────────────────

describe("shortlist logic", () => {
  it("shortlist contains only tradable non-current-universe symbols", () => {
    const metas = [
      makeMeta({ symbol: "A1", quoteVolume24h: 100_000_000 }),
      makeMeta({ symbol: "BTCUSDT", quoteVolume24h: 1_000_000_000, alreadyInCurrentUniverse: true }),
      makeMeta({ symbol: "TINYUSDT", quoteVolume24h: 1_000_000 }), // LOW_LIQUIDITY
    ];
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: metas,
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    for (const c of report.shortlistedCandidates) {
      expect(c.alreadyInCurrentUniverse).toBe(false);
      expect(c.tradabilityVerdict).toBe("TRADABLE");
      expect(c.discoveryTier === "EXPLORATORY_SHORTLIST" || c.discoveryTier === "WATCHLIST_ONLY").toBe(true);
    }
  });

  it("shortlist is sorted by netDiscoveryScore descending", () => {
    const metas = [
      makeMeta({ symbol: "MID", quoteVolume24h: 60_000_000, spreadBps: 5 }),
      makeMeta({ symbol: "HIGH", quoteVolume24h: 100_000_000, spreadBps: 2, priceChangePct24h: 4 }),
      makeMeta({ symbol: "LOW", quoteVolume24h: 11_000_000, spreadBps: 8 }),
    ];
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: metas,
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    const scores = report.shortlistedCandidates.map((c) => c.netDiscoveryScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    }
  });

  it("shortlist is capped at 10 entries", () => {
    const metas = Array.from({ length: 25 }, (_, i) =>
      makeMeta({ symbol: `SYM${i}USDT`, quoteVolume24h: 100_000_000 }),
    );
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: metas,
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    expect(report.shortlistedCandidates.length).toBeLessThanOrEqual(10);
  });
});

// ─── Fingerprint maturity handling ────────────────────────────────────────────

describe("fingerprint maturity", () => {
  it("LOW-confidence fingerprints keep readiness confidence at LOW", () => {
    const meta = makeMeta({ symbol: "GOODUSDT", quoteVolume24h: 100_000_000 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [makePromisingFingerprint({ confidence: "LOW" })],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.confidence).toBe("LOW");
  });

  it("MEDIUM-confidence promising fingerprints with tradable candidates upgrade readiness to MEDIUM", () => {
    const meta = makeMeta({ symbol: "GOODUSDT", quoteVolume24h: 100_000_000 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [makePromisingFingerprint({ confidence: "MEDIUM" })],
      toxicFingerprints: [],
    });
    expect(report.discoveryReadiness.confidence).toBe("MEDIUM");
  });

  it("maturity warning is always present in fingerprint basis", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    expect(report.discoveryFingerprintBasis.maturityWarning).toContain("exploratory");
  });

  it("reflects fingerprint confidence levels in fingerprint basis", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      promisingFingerprints: [makePromisingFingerprint({ confidence: "LOW" })],
      toxicFingerprints: [makeToxicFingerprint({ confidence: "LOW" })],
    });
    expect(report.discoveryFingerprintBasis.promisingFingerprintConfidence).toBe("LOW");
    expect(report.discoveryFingerprintBasis.toxicFingerprintConfidence).toBe("LOW");
  });

  it("reports NONE when no fingerprints are available", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.discoveryFingerprintBasis.promisingFingerprintConfidence).toBe("NONE");
    expect(report.discoveryFingerprintBasis.toxicFingerprintConfidence).toBe("NONE");
  });
});

// ─── Rejected candidates sample ───────────────────────────────────────────────

describe("rejected candidates sample", () => {
  it("preserves reject reasons in the sample", () => {
    const metas = [
      makeMeta({ symbol: "TINYUSDT", quoteVolume24h: 1_000_000 }),
      makeMeta({ symbol: "WIDEUSDT", spreadBps: 50, quoteVolume24h: 100_000_000 }),
      makeMeta({ symbol: "DEADUSDT", status: "BREAK", quoteVolume24h: 100_000_000 }),
    ];
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: metas,
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    const verdicts = report.rejectedCandidatesSample.map((c) => c.tradabilityVerdict);
    expect(verdicts).toContain("LOW_LIQUIDITY");
    expect(verdicts).toContain("EXCESSIVE_SPREAD");
    expect(verdicts).toContain("STATUS_NOT_TRADING");
  });
});

// ─── Patch hypotheses ─────────────────────────────────────────────────────────

describe("patch hypotheses", () => {
  it("all hypotheses carry doesNotImplementNow=true", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [makeMeta({ symbol: "X", quoteVolume24h: 100_000_000 })],
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [makeToxicFingerprint()],
    });
    expect(report.patchHypotheses.every((h) => h.doesNotImplementNow === true)).toBe(true);
  });

  it("emits WAIT_FOR_MATURE_WINNER_FINGERPRINT when promising fingerprints are LOW confidence only", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [makeMeta({ symbol: "X", quoteVolume24h: 100_000_000 })],
      promisingFingerprints: [makePromisingFingerprint({ confidence: "LOW" })],
      toxicFingerprints: [],
    });
    expect(report.patchHypotheses.some((h) => h.likelyFutureAction === "WAIT_FOR_MATURE_WINNER_FINGERPRINT")).toBe(true);
  });

  it("emits PREPARE_ROTATION_SHADOW_OVERLAY when a shortlist exists", () => {
    const meta = makeMeta({ symbol: "GOODUSDT", quoteVolume24h: 100_000_000, spreadBps: 2 });
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [meta],
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    expect(report.shortlistedCandidates.length).toBeGreaterThan(0);
    expect(report.patchHypotheses.some((h) => h.likelyFutureAction === "PREPARE_ROTATION_SHADOW_OVERLAY")).toBe(true);
  });

  it("patchStatus is restricted to WATCH or AUDIT_DEEPER (no READY_FOR_PATCH_DISCUSSION)", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [makeMeta({ symbol: "X", quoteVolume24h: 100_000_000 })],
      promisingFingerprints: [makePromisingFingerprint({ confidence: "MEDIUM" })],
      toxicFingerprints: [makeToxicFingerprint()],
    });
    expect(report.patchHypotheses.every((h) => h.patchStatus === "WATCH" || h.patchStatus === "AUDIT_DEEPER")).toBe(true);
  });

  it("fallback NO_ACTION_YET hypothesis emits when there are no concerns", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      promisingFingerprints: [makePromisingFingerprint({ confidence: "MEDIUM" })],
      toxicFingerprints: [],
    });
    // No shortlist, fingerprint is mature: should produce only "no specific action" path
    expect(report.patchHypotheses.length).toBeGreaterThan(0);
    expect(report.patchHypotheses.some((h) => h.likelyFutureAction === "NO_ACTION_YET")).toBe(true);
  });
});

// ─── Category buckets ────────────────────────────────────────────────────────

describe("category buckets", () => {
  it("groups candidates into expected category buckets", () => {
    const metas = [
      makeMeta({ symbol: "MEGAUSDT", quoteVolume24h: 1_000_000_000, priceChangePct24h: 5 }),
      makeMeta({ symbol: "VOLATILEUSDT", quoteVolume24h: 80_000_000, priceChangePct24h: 22 }),
      makeMeta({ symbol: "STABLEUSDT", quoteVolume24h: 100_000_000, priceChangePct24h: 3 }),
      makeMeta({ symbol: "PARTIALUSDT", quoteVolume24h: null, latestPrice: null }),
    ];
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: metas,
      promisingFingerprints: [makePromisingFingerprint()],
      toxicFingerprints: [],
    });
    expect(report.categoryBuckets.highLiquidityExploratory).toContain("MEGAUSDT");
    expect(report.categoryBuckets.highVolatilityTradable).toContain("VOLATILEUSDT");
    expect(report.categoryBuckets.stableLiquidityCandidates).toContain("STABLEUSDT");
    expect(report.categoryBuckets.dataIncompleteCandidates).toContain("PARTIALUSDT");
  });
});

// ─── Answer cards ────────────────────────────────────────────────────────────

describe("answer cards", () => {
  it("always returns 5 answer cards", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.answerCards).toHaveLength(5);
  });

  it("phase 2E.3 answer card references rotation shadow overlay", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.answerCards[4]!.answer).toContain("Phase 2E.3");
    expect(report.answerCards[4]!.answer).toContain("rotation shadow overlay");
  });
});

// ─── Metadata fields ─────────────────────────────────────────────────────────

describe("report metadata fields", () => {
  it("generatedAt uses the provided now date", () => {
    const now = new Date("2026-05-14T12:00:00Z");
    const report = buildExternalCandidateDiscoveryIntelligenceReport(
      {
        currentUniverseSymbols: [],
        externalCandidateMetadata: [],
        promisingFingerprints: [],
        toxicFingerprints: [],
      },
      now,
    );
    expect(report.generatedAt).toBe("2026-05-14T12:00:00.000Z");
  });

  it("evidenceEra defaults to POST_CALIBRATION", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: [],
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.evidenceEra).toBe("POST_CALIBRATION");
  });

  it("currentUniverseSymbolCount reflects input", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: CURRENT_UNIVERSE,
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.currentUniverseSymbolCount).toBe(CURRENT_UNIVERSE.length);
  });

  it("sourceMetadata documents tradability thresholds", () => {
    const report = buildExternalCandidateDiscoveryIntelligenceReport({
      currentUniverseSymbols: [],
      externalCandidateMetadata: [],
      promisingFingerprints: [],
      toxicFingerprints: [],
    });
    expect(report.sourceMetadata.minQuoteVolume24hUsd).toBe(10_000_000);
    expect(report.sourceMetadata.maxSpreadBps).toBe(10);
    expect(report.sourceMetadata.quoteAssetFilter).toBe("USDT");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { buildFoundryArtifact } from "../../src/research/foundry/artifact-schema.js";
import { loadFoundryArtifact, persistFoundryArtifact } from "../../src/research/foundry/artifact-store.js";
import { canonicalizeFundingSettlements } from "../../src/research/foundry/funding-schedule.js";
import { assembleTier1Baseline, assertTier1AssemblyCanRun, loadTier1Artifacts, runTier1BaselineSmoke } from "../../src/research/foundry/tier1-assembler.js";
import { buildAuthoritativeTimelineArtifact, buildCanonicalEpisodeArtifact, generateMinimumHistoryEligibilityArtifact, generatePitPortfolioRiskArtifact } from "../../src/research/foundry/tier1-pit-artifacts.js";
import { FOUNDRY_SCHEMA_V1, validateFoundryRows } from "../../src/research/foundry/semantic-validators.js";
import { fixtureSourceProvenance, type FoundryDerivationIdentity } from "../../src/research/foundry/source-provenance.js";
import type { TournamentExperimentSpec } from "../../src/research/tournament-types.js";

const H = 3_600_000; const symbols = ["BTCUSDT"];
const expected = { startMs: 0, endMs: H, symbols, cadenceMs: H };
const schedule = { schemaVersion: "v1" as const, symbol: "BTCUSDT", kind: "EXPLICIT_HISTORICAL" as const, source: "historical-exchange-schedule", sourceHash: "schedule-source", alignmentToleranceMs: 60_000, settlementTimesMs: [0] };
const candle = (time: number, close: number) => ({ symbol: "BTCUSDT", openTimeMs: time, closeTimeMs: time + H - 1, open: close - 1, high: close + 1, low: close - 2, close, volume: 1, sourceHash: `candle-${time}` });
const build = (artifactKind: Parameters<typeof buildFoundryArtifact>[0]["artifactKind"], rows: unknown[], coverage = expected) => buildFoundryArtifact({ artifactKind, schemaVersion: FOUNDRY_SCHEMA_V1, source: `fixture:${artifactKind}`, sourceProvenance: fixtureSourceProvenance(`fixture:${artifactKind}`, "0000000"), units: { value: "fixture" }, generatedAtMs: 0, generationSha: "fixture", expectedCoverage: artifactKind === "FUNDING_SETTLEMENTS" ? { ...coverage, fundingSchedules: coverage.fundingSchedules ?? [schedule] } : artifactKind === "PORTFOLIO_RISK_SNAPSHOTS" ? { ...coverage, maxSnapshotAgeMs: H } : coverage, rows });
const derivation = (policyVersion: string): FoundryDerivationIdentity => ({ version: "foundry-derivation-v1", policyVersion, parameters: { fixture: true }, parentSemanticManifestHashes: ["a".repeat(64)] });

describe("Tier-1 artifact assembly", () => {
  it("canonicalizes jittered funding once and preserves the canonical identity through persistence", () => {
    const rows = canonicalizeFundingSettlements({ rows: [{ symbol: "BTCUSDT", observedSettlementTimeMs: 8, fundingIntervalMs: 8 * H, rate: 0.01, sourceHash: "funding-export" }], schedules: [schedule], startMs: 0, endMs: H });
    expect(rows[0]).toMatchObject({ canonicalSettlementTimeMs: 0, observedSettlementTimeMs: 8, alignmentOffsetMs: 8, scheduleSourceHash: "schedule-source" });
    expect(() => canonicalizeFundingSettlements({ rows: [...rows, { ...rows[0]!, observedSettlementTimeMs: 9 }], schedules: [schedule], startMs: 0, endMs: H })).toThrow("FOUNDRY_FUNDING_DUPLICATE_CANONICAL_SETTLEMENT");
    expect(() => canonicalizeFundingSettlements({ rows: [], schedules: [schedule], startMs: 0, endMs: H })).toThrow("FOUNDRY_FUNDING_SETTLEMENT_MISSING");
    const artifact = build("FUNDING_SETTLEMENTS", rows); const root = mkdtempSync(join(tmpdir(), "tier1-funding-"));
    try { persistFoundryArtifact({ rootDir: root, manifest: artifact.manifest, rows: artifact.canonicalRows }); expect(loadFoundryArtifact({ rootDir: root, semanticManifestHash: artifact.manifest.semanticManifestHash }).rows[0]).toMatchObject(rows[0]!); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires authoritative timeline events and derives minimum history from prior completed bars only", () => {
    expect(() => buildAuthoritativeTimelineArtifact({ artifactKind: "LISTING_DELISTING_TIMELINE", source: "current-exchange-state", sourceProvenance: fixtureSourceProvenance("current", "0000000"), generatedAtMs: 0, generationSha: "x", expectedCoverage: expected, rows: [{ symbol: "BTCUSDT", effectiveTimeMs: 0, status: "LISTED", sourceHash: "s" }] })).toThrow("FOUNDRY_TIMELINE_SOURCE_NOT_AUTHORITATIVE");
    const listing = validateFoundryRows("LISTING_DELISTING_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, status: "LISTED", sourceHash: "listing" }]);
    const futures = validateFoundryRows("FUTURES_AVAILABILITY_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, available: true, sourceHash: "futures" }]);
    const candles = validateFoundryRows("COMPLETED_CANDLES", FOUNDRY_SCHEMA_V1, [candle(0, 100), candle(H, 101)]);
    const minimum = generateMinimumHistoryEligibilityArtifact({ listingRows: listing, futuresRows: futures, candleRows: candles, expectedCoverage: { ...expected, endMs: 3 * H }, decisionTimesMs: [0, H, 2 * H], minimumCompletedBars: 1, source: "derived:prior-completed-bars", sourceProvenance: { ...fixtureSourceProvenance("minimum", "0000000"), provenanceType: "DERIVED_FROM_FOUNDRY_ARTIFACTS" }, derivation: derivation("minimum-v1"), generatedAtMs: 0, generationSha: "x" });
    expect(minimum.canonicalRows.map((row) => [row.asOfMs, row.eligible])).toEqual([[0, false], [H, true]]);
  });

  it("accepts only canonical Kronos episode evidence and uses strictly prior candles for PIT risk", () => {
    expect(() => buildCanonicalEpisodeArtifact({ source: "calendar-day", sourceProvenance: fixtureSourceProvenance("calendar", "0000000"), canonicalPolicy: { algorithmVersion: "v1", policyVersion: "v1", blockWidthMs: H }, generatedAtMs: 0, generationSha: "x", expectedCoverage: expected, events: [] })).toThrow("FOUNDRY_CANONICAL_EPISODE_SOURCE_INVALID");
    const episodes = buildCanonicalEpisodeArtifact({ source: "canonical-kronos:market-cause-export", sourceProvenance: { ...fixtureSourceProvenance("episodes", "0000000"), provenanceType: "KRONOS_CANONICAL_LEDGER" }, canonicalPolicy: { algorithmVersion: "v1", policyVersion: "v1", blockWidthMs: H }, generatedAtMs: 0, generationSha: "x", expectedCoverage: expected, events: [{ symbol: "BTCUSDT", decisionTimeMs: H - 1, marketEpisodeId: "cause-A", sourceHash: "event", canonicalAlgorithm: "PERSISTED_MARKET_CAUSE" }] });
    expect(episodes.canonicalRows.map((row) => row.episodeId)).toEqual(["cause-A"]);
    const candles = [candle(0, 100), candle(H, 110), candle(2 * H, 90), candle(3 * H, 120), candle(4 * H, 100)];
    const risk = generatePitPortfolioRiskArtifact({ candles, expectedCoverage: { startMs: 4 * H, endMs: 5 * H, symbols }, asOfTimesMs: [4 * H], lookbackBars: 3, minimumObservations: 2, closeIntervalMs: H, snapshotIntervalMs: H, source: "derived:strict-prior-candles", sourceProvenance: { ...fixtureSourceProvenance("risk", "0000000"), provenanceType: "DERIVED_FROM_FOUNDRY_ARTIFACTS" }, derivation: derivation("risk-v1"), generatedAtMs: 0, generationSha: "x" });
    const withFuture = generatePitPortfolioRiskArtifact({ candles: [...candles, candle(5 * H, 10_000)], expectedCoverage: { startMs: 4 * H, endMs: 5 * H, symbols }, asOfTimesMs: [4 * H], lookbackBars: 3, minimumObservations: 2, closeIntervalMs: H, snapshotIntervalMs: H, source: "derived:strict-prior-candles", sourceProvenance: { ...fixtureSourceProvenance("risk", "0000000"), provenanceType: "DERIVED_FROM_FOUNDRY_ARTIFACTS" }, derivation: derivation("risk-v1"), generatedAtMs: 0, generationSha: "x" });
    expect(risk.manifest.rowsHash).toBe(withFuture.manifest.rowsHash);
  });

  it("assembles only complete coherent artifacts and rejects conflicts or incomplete ranking", () => {
    const completeSchedule = { ...schedule, settlementTimesMs: [H] }; const completeExpected = { startMs: H, endMs: 2 * H, symbols, cadenceMs: H, fundingSchedules: [completeSchedule] };
    const funding = build("FUNDING_SETTLEMENTS", canonicalizeFundingSettlements({ rows: [{ symbol: "BTCUSDT", observedSettlementTimeMs: H, fundingIntervalMs: 8 * H, rate: 0, sourceHash: "funding" }], schedules: [completeSchedule], startMs: H, endMs: 2 * H }), completeExpected);
    const listing = build("LISTING_DELISTING_TIMELINE", [{ symbol: "BTCUSDT", effectiveTimeMs: H, status: "LISTED", sourceHash: "listing" }], completeExpected);
    const futures = build("FUTURES_AVAILABILITY_TIMELINE", [{ symbol: "BTCUSDT", effectiveTimeMs: H, available: true, sourceHash: "futures" }], completeExpected);
    const minimum = build("MINIMUM_HISTORY_ELIGIBILITY", [{ symbol: "BTCUSDT", asOfMs: H, eligible: true, sourceHash: "minimum" }], completeExpected);
    const liquidity = build("PIT_LIQUIDITY_SPREAD", [{ symbol: "BTCUSDT", asOfMs: H, validUntilMs: 2 * H - 1, volume: 100, liquidityNotional: 100, spreadBps: 1, sourceHash: "liquidity" }], { ...completeExpected, maxSnapshotAgeMs: H });
    const episodes = build("CANONICAL_EPISODES", [{ symbol: "BTCUSDT", decisionTimeMs: H, episodeId: "market-cause-1", sourceHash: "episode" }, { symbol: "BTCUSDT", decisionTimeMs: 2 * H - 1, episodeId: "market-cause-1", sourceHash: "episode" }], completeExpected);
    const risk = build("PORTFOLIO_RISK_SNAPSHOTS", [{ symbol: "BTCUSDT", asOfMs: H, validUntilMs: 2 * H - 1, alignedStartMs: 0, alignedEndMs: H - 1, alignedObservationCount: 2, alignedTimestampHash: "timestamps", alignedSourceHashes: ["risk-source"], btcBeta: 1, correlationCluster: "BTC", sourceHash: "risk" }], completeExpected);
    const candles = build("COMPLETED_CANDLES", [candle(H, 100)], completeExpected);
    const artifacts = [funding, listing, futures, minimum, liquidity, episodes, risk, candles].map(({ manifest, canonicalRows }) => ({ manifest, rows: canonicalRows }));
    const policy = { version: "tier1-liquidity-v1", minVolume: 1, minLiquidityNotional: 1, maxSpreadBps: 10, maxAgeMs: H };
    const assembled = assembleTier1Baseline({ artifacts, symbols, startMs: H, endMs: 2 * H, timeframeMs: H, liquidityPolicy: policy }); assertTier1AssemblyCanRun(assembled);
    expect(assembled.label).toBe("TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS"); expect(assembled.fundingSettlementScheduleBySymbol.get("BTCUSDT")).toEqual([H]);
    const smokeSpec: TournamentExperimentSpec = {
      tournamentVersion: "kronos-research-tournament-v1", gitCommit: "fixture", strategyVersion: "fixture", randomSeed: 1, capabilityTier: "TIER_1_BASELINE", researchMode: "FIXTURE_SMOKE",
      dataset: { provider: "fixture", dataRange: { startMs: H, endMs: 2 * H }, candlesHash: candles.manifest.rowsHash, fundingHash: funding.manifest.rowsHash, executionInputsHash: "conservative", historicalUniverseHash: assembled.universeSnapshots[0]!.sourceHash, canonicalEpisodeHash: episodes.manifest.semanticManifestHash, portfolioRiskHash: risk.manifest.semanticManifestHash, artifactSemanticManifestHashes: assembled.artifactSemanticHashes, artifactKinds: artifacts.map((artifact) => artifact.manifest.artifactKind), timeframe: "1h", timeframeMs: H, universeSnapshots: assembled.universeSnapshots },
      costs: { makerFeeBps: 0, takerFeeBps: 0, baseSlippageBps: 0, pessimisticSlippageMultiplier: 2, fundingEnabled: false, fillMode: "NEXT_OPEN", intrabarAmbiguity: "STOP_FIRST" },
      portfolio: { startingCapital: 10_000, riskPerTradeFraction: 0.01, maxPositions: 1, maxGrossExposureFraction: 1, maxNetExposureFraction: 1, maxBtcBetaFraction: 1, maxCorrelationClusterFraction: 1, liquidationBufferFraction: 0.2, initialMarginFraction: 0.1, maxPortfolioRiskSnapshotAgeMs: H },
      validation: { trainBars: 1, testBars: 1, stepBars: 1, purgeBars: 0, embargoBars: 0, sealedHoldoutStartMs: 3 * H, minIndependentEpisodes: 1, minOosProfitabilityFraction: 0 }, parameters: {},
    };
    const smoke = runTier1BaselineSmoke({ assembly: assembled, spec: smokeSpec, candles: candles.canonicalRows.map((row) => ({ symbol: row.symbol!, openTimeMs: row.openTimeMs as number, closeTimeMs: row.closeTimeMs as number, open: row.open as number, high: row.high as number, low: row.low as number, close: row.close as number, volume: row.volume as number })), fundingRows: funding.canonicalRows, createdAtMs: 0, randomReference: [], eligibleEntryTimesBySymbol: new Map([["BTCUSDT", []]]) });
    expect(smoke.label).toBe("TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS"); expect(smoke.result.runs).toHaveLength(8); expect(smoke.result.runs.every((run) => run.manifest.executionMode === "CONSERVATIVE" && run.manifest.strategyId !== "KRONOS_CURRENT")).toBe(true);
    const incomplete = assembleTier1Baseline({ artifacts: artifacts.filter((artifact) => artifact.manifest.artifactKind !== "CANONICAL_EPISODES"), symbols, startMs: H, endMs: 2 * H, timeframeMs: H, liquidityPolicy: policy });
    expect(() => assertTier1AssemblyCanRun(incomplete)).toThrow("FOUNDRY_TIER1_INCOMPLETE_CANNOT_RUN_OR_RANK");
    expect(() => assembleTier1Baseline({ artifacts: artifacts.map((artifact) => artifact.manifest.artifactKind === "FUTURES_AVAILABILITY_TIMELINE" ? { ...artifact, rows: validateFoundryRows("FUTURES_AVAILABILITY_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: H, available: false, sourceHash: "futures" }]) } : artifact), symbols, startMs: H, endMs: 2 * H, timeframeMs: H, liquidityPolicy: policy })).toThrow("FOUNDRY_ELIGIBILITY_TIMELINE_CONFLICT");
  });
});

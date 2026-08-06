import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { buildFoundryArtifact } from "../../src/research/foundry/artifact-schema.js";
import { loadFoundryArtifact, persistFoundryArtifact } from "../../src/research/foundry/artifact-store.js";
import { canonicalizeFundingSettlements } from "../../src/research/foundry/funding-schedule.js";
import { assembleTier1Baseline, assertTier1AssemblyCanRun, loadTier1Artifacts } from "../../src/research/foundry/tier1-assembler.js";
import { buildAuthoritativeTimelineArtifact, buildCanonicalEpisodeArtifact, generateMinimumHistoryEligibilityArtifact, generatePitPortfolioRiskArtifact } from "../../src/research/foundry/tier1-pit-artifacts.js";
import { FOUNDRY_SCHEMA_V1, validateFoundryRows } from "../../src/research/foundry/semantic-validators.js";

const H = 3_600_000; const symbols = ["BTCUSDT"];
const expected = { startMs: 0, endMs: H, symbols, cadenceMs: H };
const schedule = { schemaVersion: "v1" as const, symbol: "BTCUSDT", kind: "EXPLICIT_HISTORICAL" as const, source: "historical-exchange-schedule", sourceHash: "schedule-source", alignmentToleranceMs: 60_000, settlementTimesMs: [0] };
const candle = (time: number, close: number) => ({ symbol: "BTCUSDT", openTimeMs: time, closeTimeMs: time + H - 1, open: close - 1, high: close + 1, low: close - 2, close, volume: 1, sourceHash: `candle-${time}` });
const build = (artifactKind: Parameters<typeof buildFoundryArtifact>[0]["artifactKind"], rows: unknown[]) => buildFoundryArtifact({ artifactKind, schemaVersion: FOUNDRY_SCHEMA_V1, source: `fixture:${artifactKind}`, units: { value: "fixture" }, generatedAtMs: 0, generationSha: "fixture", expectedCoverage: artifactKind === "FUNDING_SETTLEMENTS" ? { ...expected, fundingSchedules: [schedule] } : artifactKind === "PORTFOLIO_RISK_SNAPSHOTS" ? { ...expected, maxSnapshotAgeMs: H } : expected, rows });

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
    expect(() => buildAuthoritativeTimelineArtifact({ artifactKind: "LISTING_DELISTING_TIMELINE", source: "current-exchange-state", generatedAtMs: 0, generationSha: "x", expectedCoverage: expected, rows: [{ symbol: "BTCUSDT", effectiveTimeMs: 0, status: "LISTED", sourceHash: "s" }] })).toThrow("FOUNDRY_TIMELINE_SOURCE_NOT_AUTHORITATIVE");
    const listing = validateFoundryRows("LISTING_DELISTING_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, status: "LISTED", sourceHash: "listing" }]);
    const futures = validateFoundryRows("FUTURES_AVAILABILITY_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, available: true, sourceHash: "futures" }]);
    const candles = validateFoundryRows("COMPLETED_CANDLES", FOUNDRY_SCHEMA_V1, [candle(0, 100), candle(H, 101)]);
    const minimum = generateMinimumHistoryEligibilityArtifact({ listingRows: listing, futuresRows: futures, candleRows: candles, expectedCoverage: { ...expected, endMs: 3 * H }, decisionTimesMs: [0, H, 2 * H], minimumCompletedBars: 1, source: "derived:prior-completed-bars", generatedAtMs: 0, generationSha: "x" });
    expect(minimum.canonicalRows.map((row) => [row.asOfMs, row.eligible])).toEqual([[0, false], [H, true]]);
  });

  it("accepts only canonical Kronos episode evidence and uses strictly prior candles for PIT risk", () => {
    expect(() => buildCanonicalEpisodeArtifact({ source: "calendar-day", generatedAtMs: 0, generationSha: "x", expectedCoverage: expected, events: [] })).toThrow("FOUNDRY_CANONICAL_EPISODE_SOURCE_INVALID");
    const episodes = buildCanonicalEpisodeArtifact({ source: "canonical-kronos:market-cause-export", generatedAtMs: 0, generationSha: "x", expectedCoverage: expected, events: [{ symbol: "BTCUSDT", decisionTimeMs: 0, marketEpisodeId: "cause-A", sourceHash: "event", canonicalAlgorithm: "PERSISTED_MARKET_CAUSE" }, { symbol: "BTCUSDT", decisionTimeMs: H - 1, marketEpisodeId: "cause-A", sourceHash: "event", canonicalAlgorithm: "PERSISTED_MARKET_CAUSE" }] });
    expect(episodes.canonicalRows.map((row) => row.episodeId)).toEqual(["cause-A", "cause-A"]);
    const candles = [candle(0, 100), candle(H, 110), candle(2 * H, 90), candle(3 * H, 120), candle(4 * H, 100)];
    const risk = generatePitPortfolioRiskArtifact({ candles, expectedCoverage: { startMs: 4 * H, endMs: 5 * H, symbols }, asOfTimesMs: [4 * H], lookbackBars: 3, minimumObservations: 2, snapshotIntervalMs: H, source: "derived:strict-prior-candles", generatedAtMs: 0, generationSha: "x" });
    const withFuture = generatePitPortfolioRiskArtifact({ candles: [...candles, candle(5 * H, 10_000)], expectedCoverage: { startMs: 4 * H, endMs: 5 * H, symbols }, asOfTimesMs: [4 * H], lookbackBars: 3, minimumObservations: 2, snapshotIntervalMs: H, source: "derived:strict-prior-candles", generatedAtMs: 0, generationSha: "x" });
    expect(risk.manifest.rowsHash).toBe(withFuture.manifest.rowsHash);
  });

  it("assembles only complete coherent artifacts and rejects conflicts or incomplete ranking", () => {
    const funding = build("FUNDING_SETTLEMENTS", canonicalizeFundingSettlements({ rows: [{ symbol: "BTCUSDT", observedSettlementTimeMs: 0, fundingIntervalMs: 8 * H, rate: 0, sourceHash: "funding" }], schedules: [schedule], startMs: 0, endMs: H }));
    const listing = build("LISTING_DELISTING_TIMELINE", [{ symbol: "BTCUSDT", effectiveTimeMs: 0, status: "LISTED", sourceHash: "listing" }]);
    const futures = build("FUTURES_AVAILABILITY_TIMELINE", [{ symbol: "BTCUSDT", effectiveTimeMs: 0, available: true, sourceHash: "futures" }]);
    const minimum = build("MINIMUM_HISTORY_ELIGIBILITY", [{ symbol: "BTCUSDT", asOfMs: 0, eligible: true, sourceHash: "minimum" }]);
    const episodes = build("CANONICAL_EPISODES", [{ symbol: "BTCUSDT", decisionTimeMs: 0, episodeId: "market-cause-1", sourceHash: "episode" }, { symbol: "BTCUSDT", decisionTimeMs: H - 1, episodeId: "market-cause-1", sourceHash: "episode" }]);
    const risk = build("PORTFOLIO_RISK_SNAPSHOTS", [{ symbol: "BTCUSDT", asOfMs: 0, validUntilMs: H - 1, btcBeta: 1, correlationCluster: "BTC", sourceHash: "risk" }]);
    const candles = build("COMPLETED_CANDLES", [candle(0, 100)]);
    const artifacts = [funding, listing, futures, minimum, episodes, risk, candles].map(({ manifest, canonicalRows }) => ({ manifest, rows: canonicalRows }));
    const assembled = assembleTier1Baseline({ artifacts, symbols, startMs: 0, endMs: H, timeframeMs: H, universeEvidenceSourceHash: "universe-evidence" }); assertTier1AssemblyCanRun(assembled);
    expect(assembled.label).toBe("TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS"); expect(assembled.fundingSettlementScheduleBySymbol.get("BTCUSDT")).toEqual([0]);
    const incomplete = assembleTier1Baseline({ artifacts: artifacts.filter((artifact) => artifact.manifest.artifactKind !== "CANONICAL_EPISODES"), symbols, startMs: 0, endMs: H, timeframeMs: H, universeEvidenceSourceHash: "u" });
    expect(() => assertTier1AssemblyCanRun(incomplete)).toThrow("FOUNDRY_TIER1_INCOMPLETE_CANNOT_RUN_OR_RANK");
    expect(() => assembleTier1Baseline({ artifacts: artifacts.map((artifact) => artifact.manifest.artifactKind === "FUTURES_AVAILABILITY_TIMELINE" ? { ...artifact, rows: validateFoundryRows("FUTURES_AVAILABILITY_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, available: false, sourceHash: "futures" }]) } : artifact), symbols, startMs: 0, endMs: H, timeframeMs: H, universeEvidenceSourceHash: "u" })).toThrow("FOUNDRY_ELIGIBILITY_TIMELINE_CONFLICT");
  });
});

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildRunManifest, registryEntry } from "../../src/research/contract/tournament-contract.js";
import { buildFoundryArtifact } from "../../src/research/foundry/artifact-schema.js";
import { readArchiveBundle, verifyArchiveBundle } from "../../src/research/foundry/archive-bundle.js";
import { buildExternalAcquisitionBlockerReport } from "../../src/research/foundry/external-acquisition-contracts.js";
import { loadFoundryArtifact, persistFoundryArtifact } from "../../src/research/foundry/artifact-store.js";
import { importLocalBinanceCandleArchive } from "../../src/research/foundry/local-binance-archive-adapter.js";
import { buildCanonicalEpisodeArtifact } from "../../src/research/foundry/tier1-pit-artifacts.js";
import { assertRealTier1ArtifactProvenance } from "../../src/research/foundry/tier1-assembler.js";
import { FOUNDRY_SCHEMA_V1 } from "../../src/research/foundry/semantic-validators.js";
import { fixtureSourceProvenance, type FoundryDerivationIdentity } from "../../src/research/foundry/source-provenance.js";
import { rankTournamentCandidates } from "../../src/research/reporting/governance.js";

const H = 3_600_000;
const expected = { startMs: 0, endMs: H, symbols: ["BTCUSDT"], cadenceMs: H };
const csv = "open_time,open,high,low,close,volume,close_time\n0,100,101,99,100,1,3599999\n";
const realProvenance = (rawFileHash: string, datasetId = "export") => ({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT" as const, provider: "archive-provider", exchange: "BINANCE", datasetId, retrievedAtMs: 1, rawFileHash, schemaVersion: "v1", generationToolSha: "abcdef0" });
const derived = (parent: string, parameter = 2): FoundryDerivationIdentity => ({ version: "foundry-derivation-v1", policyVersion: "prior-bars-v1", parameters: { parameter }, parentSemanticManifestHashes: [parent] });

describe("real Tier-1 provenance gate", () => {
  it("recomputes archive bundle identity and detects caller mismatch, mutation, addition, and removal", () => {
    const root = mkdtempSync(join(tmpdir(), "tier1-archive-")); const directory = join(root, "BTCUSDT", "1h"); const path = join(directory, "one.csv");
    try {
      mkdirSync(directory, { recursive: true }); writeFileSync(path, csv);
      const bundle = readArchiveBundle({ root, include: (relativePath) => relativePath.endsWith(".csv") });
      expect(() => importLocalBinanceCandleArchive({ root, expectedCoverage: expected, source: "archive", sourceProvenance: realProvenance("0".repeat(64)), generatedAtMs: 1, generationSha: "abcdef0" })).toThrow("FOUNDRY_ARCHIVE_BUNDLE_CALLER_HASH_MISMATCH");
      const imported = importLocalBinanceCandleArchive({ root, expectedCoverage: expected, source: "archive", sourceProvenance: realProvenance(bundle.archiveBundleHash), generatedAtMs: 1, generationSha: "abcdef0" });
      expect(imported.manifest.archiveBundle).toMatchObject({ fileCount: 1, archiveBundleHash: bundle.archiveBundleHash, files: [{ relativePath: "BTCUSDT/1h/one.csv" }] });
      const store = join(root, "foundry-store"); persistFoundryArtifact({ rootDir: store, manifest: imported.manifest, rows: imported.rows }); const reloaded = loadFoundryArtifact({ rootDir: store, semanticManifestHash: imported.manifest.semanticManifestHash });
      expect(() => assertRealTier1ArtifactProvenance([{ manifest: reloaded.manifest, rows: reloaded.rows as never[] }], { COMPLETED_CANDLES: root })).not.toThrow();
      writeFileSync(path, `${csv}\n`); expect(() => verifyArchiveBundle({ root, include: (relativePath) => relativePath.endsWith(".csv"), expected: bundle })).toThrow("FOUNDRY_ARCHIVE_BUNDLE_CHANGED");
      expect(() => assertRealTier1ArtifactProvenance([{ manifest: reloaded.manifest, rows: reloaded.rows as never[] }], { COMPLETED_CANDLES: root })).toThrow("FOUNDRY_ARCHIVE_BUNDLE_CHANGED");
      writeFileSync(path, csv); writeFileSync(join(directory, "added.csv"), csv); expect(() => verifyArchiveBundle({ root, include: (relativePath) => relativePath.endsWith(".csv"), expected: bundle })).toThrow("FOUNDRY_ARCHIVE_BUNDLE_CHANGED");
      unlinkSync(join(directory, "added.csv")); unlinkSync(path); expect(() => verifyArchiveBundle({ root, include: (relativePath) => relativePath.endsWith(".csv"), expected: bundle })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("binds parent semantic hashes and policy parameters into every derived identity", () => {
    const sourceProvenance = { ...fixtureSourceProvenance("derived", "abcdef0"), provenanceType: "DERIVED_FROM_FOUNDRY_ARTIFACTS" as const, rawFileHash: "b".repeat(64) };
    const base = (derivation: FoundryDerivationIdentity) => buildFoundryArtifact({ artifactKind: "MINIMUM_HISTORY_ELIGIBILITY", schemaVersion: FOUNDRY_SCHEMA_V1, source: "derived", sourceProvenance, derivation, units: { value: "x" }, generatedAtMs: 1, generationSha: "abcdef0", expectedCoverage: expected, rows: [{ symbol: "BTCUSDT", asOfMs: 0, eligible: true, sourceHash: "row" }] });
    const first = base(derived("a".repeat(64))); const parentChanged = base(derived("c".repeat(64))); const parameterChanged = base(derived("a".repeat(64), 3));
    expect(first.manifest.rowsHash).toBe(parentChanged.manifest.rowsHash); expect(first.manifest.semanticManifestHash).not.toBe(parentChanged.manifest.semanticManifestHash); expect(first.manifest.semanticManifestHash).not.toBe(parameterChanged.manifest.semanticManifestHash);
  });

  it("permanently isolates fixture artifacts, registries, and rankings from REAL_TIER1", () => {
    const fixture = buildFoundryArtifact({ artifactKind: "COMPLETED_CANDLES", schemaVersion: FOUNDRY_SCHEMA_V1, source: "fixture", sourceProvenance: fixtureSourceProvenance("fixture", "abcdef0"), units: { price: "USDT" }, generatedAtMs: 1, generationSha: "abcdef0", expectedCoverage: expected, rows: [{ symbol: "BTCUSDT", openTimeMs: 0, closeTimeMs: H - 1, open: 100, high: 101, low: 99, close: 100, volume: 1, sourceHash: "row" }] });
    expect(() => assertRealTier1ArtifactProvenance([{ manifest: fixture.manifest, rows: fixture.canonicalRows }], {})).toThrow("FOUNDRY_REAL_TIER1_FIXTURE_OR_PLACEHOLDER");
    const manifest = buildRunManifest({ spec: { tournamentVersion: "kronos-research-tournament-v1", gitCommit: "abcdef0", strategyVersion: "fixture", randomSeed: 1, capabilityTier: "TIER_1_BASELINE", researchMode: "FIXTURE_SMOKE", dataset: { provider: "fixture", dataRange: { startMs: 0, endMs: H }, candlesHash: "c", fundingHash: "f", executionInputsHash: "e", historicalUniverseHash: "u", canonicalEpisodeHash: "p", portfolioRiskHash: "r", artifactSemanticManifestHashes: ["a"], artifactKinds: ["COMPLETED_CANDLES", "FUNDING_SETTLEMENTS", "LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "PIT_LIQUIDITY_SPREAD", "CANONICAL_EPISODES", "PORTFOLIO_RISK_SNAPSHOTS"], timeframe: "1h", timeframeMs: H, universeSnapshots: [{ asOfMs: H - 1, eligibleSymbols: ["BTCUSDT"], sourceHash: "u", evidence: { listedThen: true, sufficientHistoryThen: true, liquidityVolumeEligibleThen: true, spreadEligibleThen: true, futuresAvailableThen: true, delistingCheckedThen: true } }] }, costs: { makerFeeBps: 0, takerFeeBps: 0, baseSlippageBps: 0, pessimisticSlippageMultiplier: 2, fundingEnabled: false, fillMode: "NEXT_OPEN", intrabarAmbiguity: "STOP_FIRST" }, portfolio: { startingCapital: 1, riskPerTradeFraction: 0.01, maxPositions: 1, maxGrossExposureFraction: 1, maxNetExposureFraction: 1, maxBtcBetaFraction: 1, maxCorrelationClusterFraction: 1, liquidationBufferFraction: 0.1, initialMarginFraction: 0.1, maxPortfolioRiskSnapshotAgeMs: H }, validation: { trainBars: 1, testBars: 1, stepBars: 1, purgeBars: 0, embargoBars: 0, sealedHoldoutStartMs: H, minIndependentEpisodes: 1, minOosProfitabilityFraction: 0 }, parameters: {} }, strategyId: "CASH", executionMode: "CONSERVATIVE", parameterSet: {}, createdAtMs: 1 });
    expect(manifest.empiricalClassification).toBe("TEST_ONLY_NON_EMPIRICAL"); expect(() => registryEntry(manifest, true)).toThrow("TOURNAMENT_EMPIRICAL_REGISTRY_FIXTURE_FORBIDDEN");
    expect(() => rankTournamentCandidates([{ strategyId: "CASH", researchMode: "FIXTURE_SMOKE", metrics: { tradeCount: 0, independentEpisodes: 0, expectancyAfterCost: 0, profitFactor: null, winRate: 0, payoffRatio: null, sharpe: null, calmar: null, maxDrawdown: 0, netPnl: 0, returnFraction: 0, profitableAssetRatio: null, concentration: { topSymbolNetPnlShare: null, topRegimeNetPnlShare: null, topYearNetPnlShare: null }, canonicalEpisodeProvenanceComplete: false }, conservativePass: true, plateauPass: true, sealedHoldoutPass: true }])).toThrow("TOURNAMENT_FIXTURE_RANKING_FORBIDDEN");
  });

  it("requires a complete persisted canonical map, shares market causes across symbols, and is deterministic", () => {
    const coverage = { startMs: 0, endMs: 2 * H, symbols: ["BTCUSDT", "ETHUSDT"], cadenceMs: H }; const sourceProvenance = { ...realProvenance("d".repeat(64), "market-causes"), provenanceType: "KRONOS_CANONICAL_LEDGER" as const };
    const events = ["BTCUSDT", "ETHUSDT"].flatMap((symbol) => [{ symbol, decisionTimeMs: H - 1, marketEpisodeId: "shared-cause", sourceHash: "cause-source", canonicalAlgorithm: "PERSISTED_MARKET_CAUSE" as const }, { symbol, decisionTimeMs: 2 * H - 1, marketEpisodeId: `${symbol}-next`, sourceHash: "cause-source", canonicalAlgorithm: "PERSISTED_MARKET_CAUSE" as const }]);
    const input = { source: "market-cause-export", sourceProvenance, canonicalPolicy: { algorithmVersion: "kronos-episode-v1", policyVersion: "width-v1", blockWidthMs: 6 * H }, generatedAtMs: 1, generationSha: "abcdef0", expectedCoverage: coverage, events };
    const first = buildCanonicalEpisodeArtifact(input); const second = buildCanonicalEpisodeArtifact(input);
    expect(first.manifest.semanticManifestHash).toBe(second.manifest.semanticManifestHash); expect(first.canonicalRows.filter((row) => row.decisionTimeMs === H - 1).map((row) => row.episodeId)).toEqual(["shared-cause", "shared-cause"]);
    expect(first.manifest.canonicalEpisodeCoverage).toMatchObject({ mode: "COMPLETE_SYMBOL_DECISION_MAP", decisionKeyCount: 4, algorithmVersion: "kronos-episode-v1" });
    expect(() => buildCanonicalEpisodeArtifact({ ...input, events: events.slice(1) })).toThrow("FOUNDRY_CANONICAL_EPISODE_COVERAGE_INCOMPLETE");
  });

  it("reports exact acquisition blockers instead of fabricating external history", () => {
    const report = buildExternalAcquisitionBlockerReport({ expectedCoverage: expected, availableArtifactKinds: [] });
    expect(report.canAssembleRealTier1).toBe(false); expect(report.blockers).toEqual(expect.arrayContaining(["EXTERNAL_EXPORT_REQUIRED:LISTING_DELISTING_TIMELINE:symbol listing and delisting events", "EXTERNAL_EXPORT_REQUIRED:PIT_LIQUIDITY_SPREAD:timestamped volume, liquidity notional, and spread"])); expect(report.contracts.every((contract) => contract.range.startMs === 0 && contract.range.endMs === H && contract.retrievalCommand)).toBe(true);
  });
});

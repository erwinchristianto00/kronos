import { describe, expect, it } from "vitest";

import { buildFoundryArtifact } from "../../src/research/foundry/artifact-schema.js";
import { PointInTimeLiquiditySpread } from "../../src/research/foundry/liquidity-eligibility.js";
import { canonicalizeFundingSettlements } from "../../src/research/foundry/funding-schedule.js";
import { assembleTier1Baseline, assertTier1AssemblyCanRun } from "../../src/research/foundry/tier1-assembler.js";
import { generatePitPortfolioRiskArtifact } from "../../src/research/foundry/tier1-pit-artifacts.js";
import { FOUNDRY_SCHEMA_V1, validateFoundryRows } from "../../src/research/foundry/semantic-validators.js";
import { fixtureSourceProvenance } from "../../src/research/foundry/source-provenance.js";

const H = 3_600_000; const symbols = ["BTCUSDT", "ETHUSDT"]; const policy = { version: "tier1-liquidity-v1", minVolume: 10, minLiquidityNotional: 100, maxSpreadBps: 5, maxAgeMs: H };
const schedule = (symbol: string) => ({ schemaVersion: "v1" as const, symbol, kind: "EXPLICIT_HISTORICAL" as const, source: "exchange-historical-schedule", sourceHash: `${symbol.toLowerCase().padEnd(64, "0")}`.slice(0, 64), alignmentToleranceMs: 60_000, settlementTimesMs: [H] });
const expected = { startMs: H, endMs: 2 * H, symbols, cadenceMs: H, fundingSchedules: symbols.map(schedule) };
const provenance = (id: string) => fixtureSourceProvenance(id, "0000000");
const build = (kind: Parameters<typeof buildFoundryArtifact>[0]["artifactKind"], rows: unknown[], sourceProvenance = provenance(kind)) => buildFoundryArtifact({ artifactKind: kind, schemaVersion: FOUNDRY_SCHEMA_V1, source: `fixture:${kind}`, sourceProvenance, units: { fixture: "v1" }, generatedAtMs: 0, generationSha: "fixture", expectedCoverage: kind === "PIT_LIQUIDITY_SPREAD" || kind === "PORTFOLIO_RISK_SNAPSHOTS" ? { ...expected, maxSnapshotAgeMs: H } : expected, rows });

function artifacts(ethSpreadBps = 2) {
  const funding = build("FUNDING_SETTLEMENTS", canonicalizeFundingSettlements({ rows: symbols.map((symbol) => ({ symbol, observedSettlementTimeMs: H + 8, fundingIntervalMs: 8 * H, rate: 0, sourceHash: `funding-${symbol}` })), schedules: symbols.map(schedule), startMs: H, endMs: 2 * H }));
  const listing = build("LISTING_DELISTING_TIMELINE", symbols.map((symbol) => ({ symbol, effectiveTimeMs: H, status: "LISTED", sourceHash: `listing-${symbol}` })));
  const futures = build("FUTURES_AVAILABILITY_TIMELINE", symbols.map((symbol) => ({ symbol, effectiveTimeMs: H, available: true, sourceHash: `futures-${symbol}` })));
  const history = build("MINIMUM_HISTORY_ELIGIBILITY", symbols.map((symbol) => ({ symbol, asOfMs: H, eligible: true, sourceHash: `history-${symbol}` })));
  const liquidity = build("PIT_LIQUIDITY_SPREAD", [{ symbol: "BTCUSDT", asOfMs: H, validUntilMs: 2 * H - 1, volume: 100, liquidityNotional: 1_000, spreadBps: 1, sourceHash: "liq-btc" }, { symbol: "ETHUSDT", asOfMs: H, validUntilMs: 2 * H - 1, volume: 100, liquidityNotional: 1_000, spreadBps: ethSpreadBps, sourceHash: "liq-eth" }]);
  const episodes = build("CANONICAL_EPISODES", [
    ...symbols.map((symbol) => ({ symbol, decisionTimeMs: H, episodeId: "cause", sourceHash: `episode-${symbol}` })),
    ...symbols.map((symbol) => ({ symbol, decisionTimeMs: 2 * H - 1, episodeId: "cause", sourceHash: `episode-${symbol}` })),
  ]);
  const risk = build("PORTFOLIO_RISK_SNAPSHOTS", symbols.map((symbol) => ({ symbol, asOfMs: H, validUntilMs: 2 * H - 1, alignedStartMs: 0, alignedEndMs: H - 1, alignedObservationCount: 2, alignedTimestampHash: `aligned-${symbol}`, alignedSourceHashes: [`risk-${symbol}`], btcBeta: symbol === "BTCUSDT" ? 1 : 0.8, correlationCluster: "BTC", sourceHash: `risk-${symbol}` })));
  const candles = build("COMPLETED_CANDLES", symbols.map((symbol) => ({ symbol, openTimeMs: H, closeTimeMs: 2 * H - 1, open: 100, high: 101, low: 99, close: 100, volume: 100, sourceHash: `candle-${symbol}` })));
  return [funding, listing, futures, history, liquidity, episodes, risk, candles].map(({ manifest, canonicalRows }) => ({ manifest, rows: canonicalRows }));
}

describe("Tier-1 provenance closure", () => {
  it("fails liquidity eligibility closed for missing and stale observations", () => {
    const rows = validateFoundryRows("PIT_LIQUIDITY_SPREAD", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", asOfMs: H, validUntilMs: H, volume: 100, liquidityNotional: 100, spreadBps: 1, sourceHash: "liq" }]);
    const evaluator = new PointInTimeLiquiditySpread(rows, policy);
    expect(evaluator.at("ETHUSDT", H).reason).toBe("MISSING"); expect(evaluator.at("BTCUSDT", 2 * H).reason).toBe("STALE");
  });

  it("binds every symbol result and exclusion reason into the universe snapshot hash", () => {
    const excluded = assembleTier1Baseline({ artifacts: artifacts(50), symbols, startMs: H, endMs: 2 * H, timeframeMs: H, liquidityPolicy: policy }); assertTier1AssemblyCanRun(excluded);
    expect(excluded.universeSnapshots[0]!.universeProvenance?.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: "ETHUSDT", eligible: false, reason: "WIDE_SPREAD" })]));
    const eligible = assembleTier1Baseline({ artifacts: artifacts(2), symbols, startMs: H, endMs: 2 * H, timeframeMs: H, liquidityPolicy: policy }); assertTier1AssemblyCanRun(eligible);
    expect(excluded.universeSnapshots[0]!.sourceHash).not.toBe(eligible.universeSnapshots[0]!.sourceHash);
    const noLiquidity = assembleTier1Baseline({ artifacts: artifacts(2).filter((artifact) => artifact.manifest.artifactKind !== "PIT_LIQUIDITY_SPREAD"), symbols, startMs: H, endMs: 2 * H, timeframeMs: H, liquidityPolicy: policy });
    expect(() => assertTier1AssemblyCanRun(noLiquidity)).toThrow("FOUNDRY_TIER1_INCOMPLETE_CANNOT_RUN_OR_RANK");
  });

  it("rejects prefix-only authority and binds structured source metadata into semantic identity", () => {
    const candle = { symbol: "BTCUSDT", openTimeMs: H, closeTimeMs: 2 * H - 1, open: 100, high: 101, low: 99, close: 100, volume: 1, sourceHash: "c" };
    expect(() => buildFoundryArtifact({ artifactKind: "COMPLETED_CANDLES", schemaVersion: FOUNDRY_SCHEMA_V1, source: "authoritative:fake", sourceProvenance: { ...provenance("fake"), provenanceType: "EXCHANGE_HISTORICAL_EXPORT", rawFileHash: "not-a-hash" }, units: { price: "USDT" }, generatedAtMs: 0, generationSha: "x", expectedCoverage: { startMs: H, endMs: 2 * H, symbols: ["BTCUSDT"], cadenceMs: H }, rows: [candle] })).toThrow("FOUNDRY_SOURCE_PROVENANCE_INVALID");
    const first = build("COMPLETED_CANDLES", [candle], provenance("one")); const second = build("COMPLETED_CANDLES", [candle], { ...provenance("two"), datasetId: "different-export" });
    expect(first.manifest.rowsHash).toBe(second.manifest.rowsHash); expect(first.manifest.semanticManifestHash).not.toBe(second.manifest.semanticManifestHash);
  });

  it("uses timestamp intersection, not array index, for PIT covariance", () => {
    const candles = [
      { symbol: "BTCUSDT", openTimeMs: 0, closeTimeMs: H - 1, open: 100, high: 101, low: 99, close: 100, volume: 1 }, { symbol: "BTCUSDT", openTimeMs: H, closeTimeMs: 2 * H - 1, open: 100, high: 111, low: 99, close: 110, volume: 1 }, { symbol: "BTCUSDT", openTimeMs: 2 * H, closeTimeMs: 3 * H - 1, open: 110, high: 111, low: 89, close: 90, volume: 1 },
      { symbol: "ETHUSDT", openTimeMs: 1, closeTimeMs: H, open: 100, high: 101, low: 99, close: 100, volume: 1 }, { symbol: "ETHUSDT", openTimeMs: H + 1, closeTimeMs: 2 * H, open: 100, high: 111, low: 99, close: 110, volume: 1 }, { symbol: "ETHUSDT", openTimeMs: 2 * H + 1, closeTimeMs: 3 * H, open: 110, high: 111, low: 89, close: 90, volume: 1 },
    ];
    expect(() => generatePitPortfolioRiskArtifact({ candles, expectedCoverage: { startMs: 3 * H, endMs: 4 * H, symbols }, asOfTimesMs: [3 * H + 1], lookbackBars: 2, minimumObservations: 2, closeIntervalMs: H, snapshotIntervalMs: H, source: "risk", sourceProvenance: { ...provenance("risk"), provenanceType: "DERIVED_FROM_FOUNDRY_ARTIFACTS" }, generatedAtMs: 0, generationSha: "x" })).toThrow("FOUNDRY_PIT_RISK_ALIGNED_OBSERVATIONS_INSUFFICIENT");
  });
});

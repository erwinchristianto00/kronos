import { tournamentHash } from "../contract/tournament-contract.js";
import type { TournamentCandle, PointInTimePortfolioRiskSnapshot } from "../tournament-types.js";
import { buildFoundryArtifact, type BuiltFoundryArtifact, type FoundryArtifactKind } from "./artifact-schema.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";
import { FOUNDRY_SCHEMA_V1, FOUNDRY_SCHEMA_V2, type FoundrySchemaVersion, type ValidatedFoundryRow } from "./semantic-validators.js";
import { futuresTimeline, listingTimeline } from "./stateful-timeline.js";
import { assertFoundrySourceProvenance, type FoundrySourceProvenance } from "./source-provenance.js";
import type { ArchiveBundleIdentity } from "./archive-bundle.js";

type TimelineKind = "LISTING_DELISTING_TIMELINE" | "FUTURES_AVAILABILITY_TIMELINE";
const finite = (value: number): boolean => Number.isFinite(value);

/** Imports only a named historical export; caller must retain its immutable source hash per event. */
export function buildAuthoritativeTimelineArtifact(input: { artifactKind: TimelineKind; schemaVersion?: FoundrySchemaVersion; source: string; sourceProvenance: FoundrySourceProvenance; archiveBundle?: ArchiveBundleIdentity; generatedAtMs: number; generationSha: string; expectedCoverage: FoundryExpectedCoverage; rows: readonly unknown[] }): BuiltFoundryArtifact {
  assertFoundrySourceProvenance(input.sourceProvenance);
  if (input.sourceProvenance.provenanceType !== "EXCHANGE_HISTORICAL_EXPORT") throw new Error("FOUNDRY_TIMELINE_SOURCE_NOT_AUTHORITATIVE");
  return buildFoundryArtifact({ ...input, schemaVersion: input.schemaVersion ?? FOUNDRY_SCHEMA_V2, units: { effectiveTimeMs: "unix_ms", validUntilMs: "unix_ms", state: "exchange_historical_event" } });
}

/** Eligibility is derived from prior completed bars plus source-backed listing/futures state only. */
export function generateMinimumHistoryEligibilityArtifact(input: {
  listingRows: readonly ValidatedFoundryRow[];
  futuresRows: readonly ValidatedFoundryRow[];
  candleRows: readonly ValidatedFoundryRow[];
  expectedCoverage: FoundryExpectedCoverage;
  decisionTimesMs: readonly number[];
  minimumCompletedBars: number;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  derivation: import("./source-provenance.js").FoundryDerivationIdentity;
  generatedAtMs: number;
  generationSha: string;
}): BuiltFoundryArtifact {
  if (!input.source || !Number.isInteger(input.minimumCompletedBars) || input.minimumCompletedBars < 1) throw new Error("FOUNDRY_MIN_HISTORY_CONTRACT_INVALID"); assertFoundrySourceProvenance(input.sourceProvenance);
  if (input.sourceProvenance.provenanceType !== "DERIVED_FROM_FOUNDRY_ARTIFACTS") throw new Error("FOUNDRY_MIN_HISTORY_SOURCE_INVALID");
  const listings = listingTimeline(input.listingRows); const futures = futuresTimeline(input.futuresRows); const rows: unknown[] = [];
  for (const symbol of input.expectedCoverage.symbols.slice().sort()) {
    let prior: boolean | undefined;
    for (const asOfMs of input.decisionTimesMs) {
      const listed = listings.at(symbol, asOfMs).value === "LISTED"; const available = futures.at(symbol, asOfMs).value === true;
      const completed = input.candleRows.filter((row) => row.symbol === symbol && (row.closeTimeMs as number) < asOfMs).length;
      const eligible = listed && available && completed >= input.minimumCompletedBars;
      if (prior === undefined || prior !== eligible) {
        rows.push({ symbol, asOfMs, eligible, sourceHash: tournamentHash({ source: input.source, symbol, asOfMs, listing: listings.at(symbol, asOfMs).sourceHash, futures: futures.at(symbol, asOfMs).sourceHash, priorCompletedBars: completed, minimumCompletedBars: input.minimumCompletedBars }) });
        prior = eligible;
      }
    }
  }
  return buildFoundryArtifact({ artifactKind: "MINIMUM_HISTORY_ELIGIBILITY", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, derivation: input.derivation, units: { asOfMs: "unix_ms", eligible: "boolean", completedBars: "count" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows });
}

/** Canonical episode IDs must already originate from Kronos clustering/market-cause evidence. */
export function buildCanonicalEpisodeArtifact(input: {
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  archiveBundle?: ArchiveBundleIdentity;
  canonicalPolicy: { algorithmVersion: string; policyVersion: string; blockWidthMs: number };
  generatedAtMs: number;
  generationSha: string;
  expectedCoverage: FoundryExpectedCoverage;
  events: readonly { symbol: string; decisionTimeMs: number; marketEpisodeId: string; sourceHash: string; canonicalAlgorithm: "KRONOS_EPISODE_ACCUMULATOR_V1" | "PERSISTED_MARKET_CAUSE" }[];
}): BuiltFoundryArtifact {
  assertFoundrySourceProvenance(input.sourceProvenance);
  if (input.sourceProvenance.provenanceType !== "KRONOS_CANONICAL_LEDGER") throw new Error("FOUNDRY_CANONICAL_EPISODE_SOURCE_INVALID");
  const expectedTimes: number[] = []; if (!input.expectedCoverage.cadenceMs) throw new Error("FOUNDRY_CANONICAL_EPISODE_CADENCE_REQUIRED"); for (let openTimeMs = input.expectedCoverage.startMs; openTimeMs < input.expectedCoverage.endMs; openTimeMs += input.expectedCoverage.cadenceMs) expectedTimes.push(openTimeMs + input.expectedCoverage.cadenceMs - 1);
  const expectedKeys = input.expectedCoverage.symbols.slice().sort().flatMap((symbol) => expectedTimes.map((decisionTimeMs) => `${symbol}:${decisionTimeMs}`)); const eventKeys = input.events.map((event) => `${event.symbol}:${event.decisionTimeMs}`).sort(); const events = input.events.slice().sort((a, b) => a.decisionTimeMs - b.decisionTimeMs || a.symbol.localeCompare(b.symbol));
  if (!input.canonicalPolicy.algorithmVersion || !input.canonicalPolicy.policyVersion || !Number.isInteger(input.canonicalPolicy.blockWidthMs) || input.canonicalPolicy.blockWidthMs <= 0 || events.some((event) => !event.marketEpisodeId || !event.sourceHash || !event.canonicalAlgorithm) || JSON.stringify(eventKeys) !== JSON.stringify(expectedKeys)) throw new Error("FOUNDRY_CANONICAL_EPISODE_COVERAGE_INCOMPLETE");
  const sourceHashes = [...new Set(events.map((event) => event.sourceHash))].sort();
  return buildFoundryArtifact({ artifactKind: "CANONICAL_EPISODES", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, ...(input.archiveBundle ? { archiveBundle: input.archiveBundle } : {}), canonicalEpisodeCoverage: { mode: "COMPLETE_SYMBOL_DECISION_MAP", canonicalAlgorithm: events[0]!.canonicalAlgorithm, algorithmVersion: input.canonicalPolicy.algorithmVersion, policyVersion: input.canonicalPolicy.policyVersion, blockWidthMs: input.canonicalPolicy.blockWidthMs, decisionKeyCount: expectedKeys.length, decisionKeysHash: tournamentHash(expectedKeys), sourceHashes }, units: { decisionTimeMs: "unix_ms", episodeId: "canonical_market_cause" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows: events.map((event) => ({ symbol: event.symbol, decisionTimeMs: event.decisionTimeMs, episodeId: event.marketEpisodeId, sourceHash: event.sourceHash })) });
}

function returnsBefore(candles: readonly TournamentCandle[], asOfMs: number, lookbackBars: number, closeIntervalMs: number, symbol: string): Map<number, { value: number; sourceHash: string }> {
  const closes = candles.filter((candle) => candle.closeTimeMs < asOfMs).sort((a, b) => a.closeTimeMs - b.closeTimeMs).slice(-(lookbackBars + 1)); const output = new Map<number, { value: number; sourceHash: string }>();
  for (let index = 1; index < closes.length; index += 1) {
    const prior = closes[index - 1]!; const current = closes[index]!;
    if (current.closeTimeMs - prior.closeTimeMs !== closeIntervalMs) throw new Error(`FOUNDRY_PIT_RISK_CANDLE_GAP_${symbol}_${current.closeTimeMs}`);
    output.set(current.closeTimeMs, { value: Math.log(current.close / prior.close), sourceHash: tournamentHash([prior.openTimeMs, prior.close, current.openTimeMs, current.close]) });
  }
  return output;
}
function covariance(a: readonly number[], b: readonly number[]): number { const meanA = a.reduce((sum, value) => sum + value, 0) / a.length; const meanB = b.reduce((sum, value) => sum + value, 0) / b.length; return a.reduce((sum, value, index) => sum + (value - meanA) * (b[index]! - meanB), 0) / a.length; }

/** Risk rows use data strictly before asOfMs; no future candle can influence beta or cluster. */
export function generatePitPortfolioRiskArtifact(input: {
  candles: readonly TournamentCandle[];
  expectedCoverage: FoundryExpectedCoverage;
  asOfTimesMs: readonly number[];
  lookbackBars: number;
  minimumObservations: number;
  closeIntervalMs: number;
  snapshotIntervalMs: number;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  derivation: import("./source-provenance.js").FoundryDerivationIdentity;
  generatedAtMs: number;
  generationSha: string;
}): BuiltFoundryArtifact {
  if (!input.source || input.lookbackBars < input.minimumObservations || input.minimumObservations < 2 || input.snapshotIntervalMs <= 0 || !Number.isInteger(input.closeIntervalMs) || input.closeIntervalMs <= 0) throw new Error("FOUNDRY_PIT_RISK_CONTRACT_INVALID"); assertFoundrySourceProvenance(input.sourceProvenance);
  if (input.sourceProvenance.provenanceType !== "DERIVED_FROM_FOUNDRY_ARTIFACTS") throw new Error("FOUNDRY_PIT_RISK_SOURCE_INVALID");
  const bySymbol = new Map(input.expectedCoverage.symbols.map((symbol) => [symbol, input.candles.filter((candle) => candle.symbol === symbol)])); const rows: unknown[] = [];
  for (const asOfMs of input.asOfTimesMs) {
    const btc = returnsBefore(bySymbol.get("BTCUSDT") ?? [], asOfMs, input.lookbackBars, input.closeIntervalMs, "BTCUSDT");
    if (btc.size < input.minimumObservations || [...btc.values()].some((value) => !finite(value.value))) throw new Error(`FOUNDRY_PIT_RISK_PRIOR_HISTORY_INSUFFICIENT_BTCUSDT_${asOfMs}`);
    const btcValues = [...btc.values()].map((value) => value.value);
    const btcVariance = covariance(btcValues, btcValues); if (!(btcVariance > 0)) throw new Error(`FOUNDRY_PIT_RISK_BTC_VARIANCE_INVALID_${asOfMs}`);
    for (const symbol of input.expectedCoverage.symbols.slice().sort()) {
      const asset = returnsBefore(bySymbol.get(symbol) ?? [], asOfMs, input.lookbackBars, input.closeIntervalMs, symbol); const timestamps = [...btc.keys()].filter((timestamp) => asset.has(timestamp)).sort((a, b) => a - b).slice(-input.lookbackBars);
      if (timestamps.length < input.minimumObservations) throw new Error(`FOUNDRY_PIT_RISK_ALIGNED_OBSERVATIONS_INSUFFICIENT_${symbol}_${asOfMs}`);
      const assetValues = timestamps.map((timestamp) => asset.get(timestamp)!.value); const alignedBtc = timestamps.map((timestamp) => btc.get(timestamp)!.value); const alignedVariance = covariance(alignedBtc, alignedBtc); if (!(alignedVariance > 0)) throw new Error(`FOUNDRY_PIT_RISK_BTC_VARIANCE_INVALID_${asOfMs}`);
      const cov = covariance(assetValues, alignedBtc); const corr = cov / Math.sqrt(covariance(assetValues, assetValues) * alignedVariance); if (!finite(corr)) throw new Error(`FOUNDRY_PIT_RISK_CORRELATION_INVALID_${symbol}_${asOfMs}`);
      const alignedSourceHashes = timestamps.flatMap((timestamp) => [btc.get(timestamp)!.sourceHash, asset.get(timestamp)!.sourceHash]).sort(); const alignedTimestampHash = tournamentHash(timestamps);
      rows.push({ symbol, asOfMs, validUntilMs: asOfMs + input.snapshotIntervalMs - 1, alignedStartMs: timestamps[0]!, alignedEndMs: timestamps.at(-1)!, alignedObservationCount: timestamps.length, alignedTimestampHash, alignedSourceHashes, btcBeta: cov / alignedVariance, correlationCluster: symbol === "BTCUSDT" ? "BTC" : corr >= 0.7 ? "BTC_CORRELATED" : "DIVERSIFIER", sourceHash: tournamentHash({ source: input.source, symbol, asOfMs, lookbackBars: input.lookbackBars, minimumObservations: input.minimumObservations, closeIntervalMs: input.closeIntervalMs, alignedTimestampHash, alignedSourceHashes }) });
    }
  }
  return buildFoundryArtifact({ artifactKind: "PORTFOLIO_RISK_SNAPSHOTS", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, derivation: input.derivation, units: { asOfMs: "unix_ms", validUntilMs: "unix_ms", btcBeta: "return_beta", correlationCluster: "derived_prior_return_cluster" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows });
}

export function riskSnapshotsFromArtifactRows(rows: readonly ValidatedFoundryRow[], symbols: readonly string[]): PointInTimePortfolioRiskSnapshot[] {
  const byTime = new Map<number, ValidatedFoundryRow[]>(); for (const row of rows) byTime.set(row.timestampMs, [...(byTime.get(row.timestampMs) ?? []), row]);
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([asOfMs, group]) => {
    if (group.length !== symbols.length || symbols.some((symbol) => !group.some((row) => row.symbol === symbol))) throw new Error(`FOUNDRY_PIT_RISK_SNAPSHOT_SYMBOL_COVERAGE_INVALID_${asOfMs}`);
    const validUntilMs = group[0]!.validUntilMs as number; if (group.some((row) => row.validUntilMs !== validUntilMs)) throw new Error(`FOUNDRY_PIT_RISK_SNAPSHOT_CONFLICT_${asOfMs}`);
    return { asOfMs, validUntilMs, sourceHash: tournamentHash(group.map((row) => row.sourceHash).sort()), btcBetaBySymbol: Object.fromEntries(group.map((row) => [row.symbol!, row.btcBeta as number])), correlationClusterBySymbol: Object.fromEntries(group.map((row) => [row.symbol!, row.correlationCluster as string])) };
  });
}

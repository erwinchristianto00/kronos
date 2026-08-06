import { tournamentHash } from "../contract/tournament-contract.js";
import type { TournamentCandle, PointInTimePortfolioRiskSnapshot } from "../tournament-types.js";
import { buildFoundryArtifact, type BuiltFoundryArtifact, type FoundryArtifactKind } from "./artifact-schema.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";
import { FOUNDRY_SCHEMA_V1, type ValidatedFoundryRow } from "./semantic-validators.js";
import { futuresTimeline, listingTimeline } from "./stateful-timeline.js";

type TimelineKind = "LISTING_DELISTING_TIMELINE" | "FUTURES_AVAILABILITY_TIMELINE";
const finite = (value: number): boolean => Number.isFinite(value);

/** Imports only a named historical export; caller must retain its immutable source hash per event. */
export function buildAuthoritativeTimelineArtifact(input: { artifactKind: TimelineKind; source: string; generatedAtMs: number; generationSha: string; expectedCoverage: FoundryExpectedCoverage; rows: readonly unknown[] }): BuiltFoundryArtifact {
  if (!/^authoritative:/i.test(input.source)) throw new Error("FOUNDRY_TIMELINE_SOURCE_NOT_AUTHORITATIVE");
  return buildFoundryArtifact({ ...input, schemaVersion: FOUNDRY_SCHEMA_V1, units: { effectiveTimeMs: "unix_ms", state: "exchange_historical_event" } });
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
  generatedAtMs: number;
  generationSha: string;
}): BuiltFoundryArtifact {
  if (!input.source || !Number.isInteger(input.minimumCompletedBars) || input.minimumCompletedBars < 1) throw new Error("FOUNDRY_MIN_HISTORY_CONTRACT_INVALID");
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
  return buildFoundryArtifact({ artifactKind: "MINIMUM_HISTORY_ELIGIBILITY", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, units: { asOfMs: "unix_ms", eligible: "boolean", completedBars: "count" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows });
}

/** Canonical episode IDs must already originate from Kronos clustering/market-cause evidence. */
export function buildCanonicalEpisodeArtifact(input: {
  source: string;
  generatedAtMs: number;
  generationSha: string;
  expectedCoverage: FoundryExpectedCoverage;
  events: readonly { symbol: string; decisionTimeMs: number; marketEpisodeId: string; sourceHash: string; canonicalAlgorithm: "KRONOS_EPISODE_ACCUMULATOR_V1" | "PERSISTED_MARKET_CAUSE" }[];
}): BuiltFoundryArtifact {
  if (!/^canonical-kronos:/i.test(input.source) || input.events.some((event) => !event.marketEpisodeId || !event.sourceHash || !event.canonicalAlgorithm)) throw new Error("FOUNDRY_CANONICAL_EPISODE_SOURCE_INVALID");
  return buildFoundryArtifact({ artifactKind: "CANONICAL_EPISODES", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, units: { decisionTimeMs: "unix_ms", episodeId: "canonical_market_cause" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows: input.events.map((event) => ({ symbol: event.symbol, decisionTimeMs: event.decisionTimeMs, episodeId: event.marketEpisodeId, sourceHash: event.sourceHash })) });
}

function returnsBefore(candles: readonly TournamentCandle[], asOfMs: number, lookbackBars: number): number[] {
  const closes = candles.filter((candle) => candle.closeTimeMs < asOfMs).sort((a, b) => a.closeTimeMs - b.closeTimeMs).slice(-(lookbackBars + 1)).map((candle) => candle.close);
  return closes.slice(1).map((close, index) => Math.log(close / closes[index]!));
}
function covariance(a: readonly number[], b: readonly number[]): number { const meanA = a.reduce((sum, value) => sum + value, 0) / a.length; const meanB = b.reduce((sum, value) => sum + value, 0) / b.length; return a.reduce((sum, value, index) => sum + (value - meanA) * (b[index]! - meanB), 0) / a.length; }

/** Risk rows use data strictly before asOfMs; no future candle can influence beta or cluster. */
export function generatePitPortfolioRiskArtifact(input: {
  candles: readonly TournamentCandle[];
  expectedCoverage: FoundryExpectedCoverage;
  asOfTimesMs: readonly number[];
  lookbackBars: number;
  minimumObservations: number;
  snapshotIntervalMs: number;
  source: string;
  generatedAtMs: number;
  generationSha: string;
}): BuiltFoundryArtifact {
  if (!input.source || input.lookbackBars < input.minimumObservations || input.minimumObservations < 2 || input.snapshotIntervalMs <= 0) throw new Error("FOUNDRY_PIT_RISK_CONTRACT_INVALID");
  const bySymbol = new Map(input.expectedCoverage.symbols.map((symbol) => [symbol, input.candles.filter((candle) => candle.symbol === symbol)])); const rows: unknown[] = [];
  for (const asOfMs of input.asOfTimesMs) {
    const btc = returnsBefore(bySymbol.get("BTCUSDT") ?? [], asOfMs, input.lookbackBars);
    if (btc.length < input.minimumObservations || btc.some((value) => !finite(value))) throw new Error(`FOUNDRY_PIT_RISK_PRIOR_HISTORY_INSUFFICIENT_BTCUSDT_${asOfMs}`);
    const btcVariance = covariance(btc, btc); if (!(btcVariance > 0)) throw new Error(`FOUNDRY_PIT_RISK_BTC_VARIANCE_INVALID_${asOfMs}`);
    for (const symbol of input.expectedCoverage.symbols.slice().sort()) {
      const asset = returnsBefore(bySymbol.get(symbol) ?? [], asOfMs, input.lookbackBars); if (asset.length !== btc.length || asset.length < input.minimumObservations || asset.some((value) => !finite(value))) throw new Error(`FOUNDRY_PIT_RISK_PRIOR_HISTORY_INSUFFICIENT_${symbol}_${asOfMs}`);
      const cov = covariance(asset, btc); const corr = cov / Math.sqrt(covariance(asset, asset) * btcVariance); if (!finite(corr)) throw new Error(`FOUNDRY_PIT_RISK_CORRELATION_INVALID_${symbol}_${asOfMs}`);
      rows.push({ symbol, asOfMs, validUntilMs: asOfMs + input.snapshotIntervalMs - 1, btcBeta: cov / btcVariance, correlationCluster: symbol === "BTCUSDT" ? "BTC" : corr >= 0.7 ? "BTC_CORRELATED" : "DIVERSIFIER", sourceHash: tournamentHash({ source: input.source, symbol, asOfMs, lookbackBars: input.lookbackBars, minimumObservations: input.minimumObservations, inputCandles: bySymbol.get(symbol)!.filter((candle) => candle.closeTimeMs < asOfMs).map((candle) => [candle.openTimeMs, candle.close]) }) });
    }
  }
  return buildFoundryArtifact({ artifactKind: "PORTFOLIO_RISK_SNAPSHOTS", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, units: { asOfMs: "unix_ms", validUntilMs: "unix_ms", btcBeta: "return_beta", correlationCluster: "derived_prior_return_cluster" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows });
}

export function riskSnapshotsFromArtifactRows(rows: readonly ValidatedFoundryRow[], symbols: readonly string[]): PointInTimePortfolioRiskSnapshot[] {
  const byTime = new Map<number, ValidatedFoundryRow[]>(); for (const row of rows) byTime.set(row.timestampMs, [...(byTime.get(row.timestampMs) ?? []), row]);
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([asOfMs, group]) => {
    if (group.length !== symbols.length || symbols.some((symbol) => !group.some((row) => row.symbol === symbol))) throw new Error(`FOUNDRY_PIT_RISK_SNAPSHOT_SYMBOL_COVERAGE_INVALID_${asOfMs}`);
    const validUntilMs = group[0]!.validUntilMs as number; if (group.some((row) => row.validUntilMs !== validUntilMs)) throw new Error(`FOUNDRY_PIT_RISK_SNAPSHOT_CONFLICT_${asOfMs}`);
    return { asOfMs, validUntilMs, sourceHash: tournamentHash(group.map((row) => row.sourceHash).sort()), btcBetaBySymbol: Object.fromEntries(group.map((row) => [row.symbol!, row.btcBeta as number])), correlationClusterBySymbol: Object.fromEntries(group.map((row) => [row.symbol!, row.correlationCluster as string])) };
  });
}

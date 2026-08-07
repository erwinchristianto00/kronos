/**
 * Builds the predeclared free Binance Vision BTCUSDT/ETHUSDT Tier-1 parents.
 *
 * Usage (from apps/api, only after every raw ZIP and .CHECKSUM is present):
 *   npx tsx scripts/ingest-free-tier1-binance-vision-bookticker.ts \
 *     /absolute/path/to/binance-vision-usdm-bookticker-free-walkforward-v1 \
 *     <source-retrieved-at-ms> <generated-at-ms>
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tournamentHash } from "../src/research/contract/tournament-contract.js";
import { persistFoundryArtifact } from "../src/research/foundry/artifact-store.js";
import { inspectArchiveBundle, readArchiveBundle } from "../src/research/foundry/archive-bundle.js";
import { buildAuthoritativeTimelineArtifact, generateMinimumHistoryEligibilityArtifact, generatePitPortfolioRiskArtifact } from "../src/research/foundry/tier1-pit-artifacts.js";
import { importBinanceVisionUsdMRawBookTickerLiquidityArchive, importBinanceVisionUsdMRawCandleArchive, importBinanceVisionUsdMRawFundingArchive } from "../src/research/foundry/binance-vision-usdm-raw-adapter.js";
import type { FoundryDerivationIdentity, FoundrySourceProvenance } from "../src/research/foundry/source-provenance.js";
import type { ValidatedFoundryRow } from "../src/research/foundry/semantic-validators.js";

const HOUR_MS = 3_600_000;
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const WARMUP_START_MS = Date.UTC(2023, 3, 1);
// Binance Vision's May bookTicker begins milliseconds after midnight, so the
// first source-complete one-hour PIT snapshot is 01:00 UTC.
const START_MS = Date.UTC(2023, 4, 1, 1);
const END_MS = Date.UTC(2024, 3, 1);
const archiveRoot = process.argv[2];
const sourceRetrievedAtMs = Number(process.argv[3]);
const generatedAtMs = Number(process.argv[4]);
if (!archiveRoot || !Number.isInteger(sourceRetrievedAtMs) || sourceRetrievedAtMs <= 0 || !Number.isInteger(generatedAtMs) || generatedAtMs <= 0) throw new Error("USAGE: ingest-free-tier1-binance-vision-bookticker.ts <archive-root> <source-retrieved-at-ms> <generated-at-ms>");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain", "--", "apps/api/src/research", "apps/api/scripts/ingest-free-tier1-binance-vision-bookticker.ts"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(gitCommit) || sourceStatus) throw new Error("REAL_TIER1_SOURCE_COMMIT_NOT_CLEAN");

const root = resolve(archiveRoot); const raw = resolve(root, "raw"); const foundryRoot = resolve(root, "foundry-artifacts");
const executionCoverage = { startMs: START_MS, endMs: END_MS, symbols: SYMBOLS, cadenceMs: HOUR_MS };
const warmupCoverage = { startMs: WARMUP_START_MS, endMs: START_MS, symbols: SYMBOLS, cadenceMs: HOUR_MS };
const archiveSource = (input: { path: string; include: (relativePath: string) => boolean; datasetId: string; schemaVersion: string }): FoundrySourceProvenance => {
  const bundle = inspectArchiveBundle({ root: input.path, include: input.include });
  return { provenanceType: "EXCHANGE_HISTORICAL_EXPORT", provider: "Binance Vision", exchange: "BINANCE_USD_M", datasetId: input.datasetId, retrievedAtMs: sourceRetrievedAtMs, rawFileHash: bundle.archiveBundleHash, schemaVersion: input.schemaVersion, generationToolSha: gitCommit };
};
const derived = (datasetId: string, parents: readonly string[], policyVersion: string, parameters: Record<string, string | number | boolean>): { sourceProvenance: FoundrySourceProvenance; derivation: FoundryDerivationIdentity } => {
  const parentSemanticManifestHashes = [...parents].sort(); const rawFileHash = tournamentHash({ parentSemanticManifestHashes, policyVersion, parameters });
  return { sourceProvenance: { provenanceType: "DERIVED_FROM_FOUNDRY_ARTIFACTS", provider: "Kronos Dataset Foundry", exchange: "BINANCE_USD_M", datasetId, retrievedAtMs: generatedAtMs, rawFileHash, schemaVersion: "foundry-derived-v1", generationToolSha: gitCommit }, derivation: { version: "foundry-derivation-v1", policyVersion, parameters, parentSemanticManifestHashes } };
};
const persist = (artifact: { rows: unknown[]; manifest: import("../src/research/foundry/artifact-schema.js").FoundryArtifactManifest }) => persistFoundryArtifact({ rootDir: foundryRoot, manifest: artifact.manifest, rows: artifact.rows });

const candleRoot = resolve(raw, "klines"); const candleSource = archiveSource({ path: candleRoot, include: (path) => path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM"), datasetId: "futures-um-monthly-klines-1h-btceth-2023-04_to_2024-03", schemaVersion: "binance-vision-kline-csv-v1" });
const warmup = importBinanceVisionUsdMRawCandleArchive({ root: candleRoot, expectedCoverage: warmupCoverage, source: "Binance Vision USD-M 1h immutable warm-up ZIP export", sourceProvenance: candleSource, generatedAtMs, generationSha: gitCommit }); persist(warmup);
const candles = importBinanceVisionUsdMRawCandleArchive({ root: candleRoot, expectedCoverage: executionCoverage, source: "Binance Vision USD-M 1h immutable execution ZIP export", sourceProvenance: candleSource, generatedAtMs, generationSha: gitCommit }); persist(candles);

const schedules = SYMBOLS.map((symbol) => ({ schemaVersion: "v1" as const, symbol, kind: "UTC_8H_BOUNDARIES" as const, source: "Binance Vision USD-M fundingRate calc_time aligned to validated UTC 00:00/08:00/16:00 boundaries", sourceHash: tournamentHash({ schedule: "binance-usdm-utc-8h-v1", symbol, rawBundle: archiveSource({ path: resolve(raw, "fundingRate"), include: (path) => path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM"), datasetId: "futures-um-monthly-fundingRate-btceth-2023-05_to_2024-03", schemaVersion: "binance-vision-fundingRate-csv-v1" }).rawFileHash }), alignmentToleranceMs: 60_000 }));
const fundingRoot = resolve(raw, "fundingRate"); const fundingSource = archiveSource({ path: fundingRoot, include: (path) => path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM"), datasetId: "futures-um-monthly-fundingRate-btceth-2023-05_to_2024-03", schemaVersion: "binance-vision-fundingRate-csv-v1" });
const funding = importBinanceVisionUsdMRawFundingArchive({ root: fundingRoot, expectedCoverage: { ...executionCoverage, fundingSchedules: schedules }, source: "Binance Vision USD-M funding settlement ZIP export", sourceProvenance: fundingSource, generatedAtMs, generationSha: gitCommit }); persist(funding);

const announcementRoot = resolve(raw, "binance-support-announcements"); const announcementBundle = readArchiveBundle({ root: announcementRoot, include: (path) => path.endsWith(".json") });
const article = JSON.parse(announcementBundle.contents.get("article-360036964392.json")?.toString("utf8") ?? "") as { data?: { code?: string; title?: string; publishDate?: number; body?: string } };
const btcSpecification = JSON.parse(announcementBundle.contents.get("article-360033161972.json")?.toString("utf8") ?? "") as { data?: { code?: string; title?: string; publishDate?: number; body?: string } };
const ethLaunchTimeMs = article.data?.publishDate; const btcSpecificationPublishedAtMs = btcSpecification.data?.publishDate; const body = article.data?.body ?? "";
const originalEnglishLaunchEvidence = [
  "Binance Futures has launched its second perpetual contract",
  "How to switch from BTC/USDT contract to ETH/USDT contract",
  "2019/11/29",
].every((phrase) => body.includes(phrase));
if (article.data?.code !== "360036964392" || article.data?.title !== "Binance Futures Launches ETH/USDT Perpetual Contract - Up to 50x Leverage" || !Number.isSafeInteger(ethLaunchTimeMs) || !originalEnglishLaunchEvidence) throw new Error("FOUNDRY_BINANCE_SUPPORT_ETH_LAUNCH_EVIDENCE_INVALID");
if (btcSpecification.data?.code !== "360033161972" || btcSpecification.data?.title !== "USDⓈ-Margined (USDⓈ-M) Perpetual Futures Contract Specifications" || !Number.isSafeInteger(btcSpecificationPublishedAtMs)) throw new Error("FOUNDRY_BINANCE_SUPPORT_BTC_SPECIFICATION_EVIDENCE_INVALID");
const announcementSource: FoundrySourceProvenance = { provenanceType: "EXCHANGE_HISTORICAL_EXPORT", provider: "Binance Support CMS", exchange: "BINANCE_USD_M", datasetId: "original-english-btc-specification-360033161972-and-eth-launch-360036964392", retrievedAtMs: sourceRetrievedAtMs, rawFileHash: announcementBundle.archiveBundleHash, schemaVersion: "binance-support-cms-json-v1", generationToolSha: gitCommit };
const ethLaunchSourceHash = tournamentHash({ articleFileHash: announcementBundle.files.find((file) => file.relativePath === "article-360036964392.json")?.fileHash, launchTimeMs: ethLaunchTimeMs });
// The ETH announcement proves BTC/USDT was already an active contract at this
// timestamp (it instructs users how to switch from it).  This is deliberately
// a source-proven pre-range availability state, not a fabricated BTC launch.
const btcPreRangeAvailabilitySourceHash = tournamentHash({ btcSpecificationFileHash: announcementBundle.files.find((file) => file.relativePath === "article-360033161972.json")?.fileHash, btcSpecificationPublishedAtMs, ethLaunchFileHash: announcementBundle.files.find((file) => file.relativePath === "article-360036964392.json")?.fileHash, btcKnownAvailableByMs: ethLaunchTimeMs });
const timelineRows = [
  { symbol: "BTCUSDT", effectiveTimeMs: ethLaunchTimeMs, sourceHash: btcPreRangeAvailabilitySourceHash },
  { symbol: "ETHUSDT", effectiveTimeMs: ethLaunchTimeMs, sourceHash: ethLaunchSourceHash },
];
const listing = buildAuthoritativeTimelineArtifact({ artifactKind: "LISTING_DELISTING_TIMELINE", source: "Binance original English BTC pre-range availability and ETH launch evidence", sourceProvenance: announcementSource, archiveBundle: (() => { const { contents: _contents, ...identity } = announcementBundle; return identity; })(), generatedAtMs, generationSha: gitCommit, expectedCoverage: executionCoverage, rows: timelineRows.map((row) => ({ ...row, status: "LISTED" })) }); persist({ rows: listing.canonicalRows, manifest: listing.manifest });
const futures = buildAuthoritativeTimelineArtifact({ artifactKind: "FUTURES_AVAILABILITY_TIMELINE", source: "Binance original English BTC pre-range availability and ETH launch evidence", sourceProvenance: announcementSource, archiveBundle: (() => { const { contents: _contents, ...identity } = announcementBundle; return identity; })(), generatedAtMs, generationSha: gitCommit, expectedCoverage: executionCoverage, rows: timelineRows.map((row) => ({ ...row, available: true })) }); persist({ rows: futures.canonicalRows, manifest: futures.manifest });

const allCandles = [...warmup.rows, ...candles.rows] as ValidatedFoundryRow[]; const decisionTimesMs = [...new Set(candles.rows.map((row) => (row as ValidatedFoundryRow).closeTimeMs as number))].sort((a, b) => a - b);
const minimumHistory = generateMinimumHistoryEligibilityArtifact({ listingRows: listing.canonicalRows, futuresRows: futures.canonicalRows, candleRows: allCandles, expectedCoverage: executionCoverage, decisionTimesMs, minimumCompletedBars: 168, source: "Derived only from source-backed timelines and strictly prior Binance Vision completed candles", ...derived("minimum-history-eligibility-btceth-2023-05_to_2024-03", [listing.manifest.semanticManifestHash, futures.manifest.semanticManifestHash, warmup.manifest.semanticManifestHash, candles.manifest.semanticManifestHash], "minimum-history-prior-completed-bars-v1", { minimumCompletedBars: 168 }), generatedAtMs, generationSha: gitCommit }); persist({ rows: minimumHistory.canonicalRows, manifest: minimumHistory.manifest });
const risk = generatePitPortfolioRiskArtifact({ candles: allCandles.map((row) => ({ symbol: row.symbol!, openTimeMs: row.openTimeMs as number, closeTimeMs: row.closeTimeMs as number, open: row.open as number, high: row.high as number, low: row.low as number, close: row.close as number, volume: row.volume as number })), expectedCoverage: executionCoverage, asOfTimesMs: [...new Set(candles.rows.map((row) => (row as ValidatedFoundryRow).openTimeMs as number))].sort((a, b) => a - b), lookbackBars: 168, minimumObservations: 120, closeIntervalMs: HOUR_MS, snapshotIntervalMs: HOUR_MS, source: "Derived from exact-timestamp aligned Binance Vision completed closes strictly before each executable open", ...derived("pit-beta-correlation-btceth-2023-05_to_2024-03", [warmup.manifest.semanticManifestHash, candles.manifest.semanticManifestHash], "pit-aligned-prior-return-risk-v1", { lookbackBars: 168, minimumObservations: 120, closeIntervalMs: HOUR_MS }), generatedAtMs, generationSha: gitCommit }); persist({ rows: risk.canonicalRows, manifest: risk.manifest });

const bboSource = archiveSource({ path: raw, include: (path) => (path.startsWith("bookTicker/") || path.startsWith("klines/")) && (path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM")), datasetId: "futures-um-monthly-bookTicker-plus-klines-btceth-2023-05_to_2024-03", schemaVersion: "binance-vision-bookTicker-and-kline-csv-v1" });
const liquidity = await importBinanceVisionUsdMRawBookTickerLiquidityArchive({ root: raw, expectedCoverage: executionCoverage, candleRows: allCandles, maxQuoteAgeMs: HOUR_MS, source: "Binance Vision USD-M bookTicker BBO plus prior completed volume", sourceProvenance: bboSource, generatedAtMs, generationSha: gitCommit }); persist(liquidity);

console.log(JSON.stringify({ scope: { symbols: SYMBOLS, warmupStartMs: WARMUP_START_MS, startMs: START_MS, endMs: END_MS, timeframeMs: HOUR_MS }, artifacts: [warmup, candles, funding, listing, futures, minimumHistory, risk, liquidity].map((artifact) => ({ artifactKind: artifact.manifest.artifactKind, semanticManifestHash: artifact.manifest.semanticManifestHash, rowsHash: artifact.manifest.rowsHash, archiveBundleHash: artifact.manifest.archiveBundle?.archiveBundleHash ?? null, parentSemanticManifestHashes: artifact.manifest.derivation?.parentSemanticManifestHashes ?? [], rowCount: artifact.manifest.rowCount, coverageGaps: artifact.manifest.missingDataReport })) }, null, 2));

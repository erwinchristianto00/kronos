#!/usr/bin/env node
/*
 * Cloud-only, non-empirical preprocessing for the frozen Binance Vision
 * BTCUSDT/ETHUSDT study.  This deliberately persists only source-backed
 * Foundry inputs.  It never runs an empirical tournament: a later, separate
 * assembly must reload these immutable artifacts and bind the frozen plan.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { tournamentHash } from "../../apps/api/dist/research/contract/tournament-contract.js";
import { inspectArchiveBundle } from "../../apps/api/dist/research/foundry/archive-bundle.js";
import {
  importBinanceVisionUsdMRawBookTickerLiquidityArchive,
  importBinanceVisionUsdMRawCandleArchive,
  importBinanceVisionUsdMRawFundingArchive,
} from "../../apps/api/dist/research/foundry/binance-vision-usdm-raw-adapter.js";
import { loadFoundryArtifact, persistFoundryArtifact } from "../../apps/api/dist/research/foundry/artifact-store.js";
import { importBinanceCmsBoundedUsdMLifecycle } from "../../apps/api/dist/research/foundry/binance-cms-lifecycle-adapter.js";
import { generateMinimumHistoryEligibilityArtifact, generatePitPortfolioRiskArtifact } from "../../apps/api/dist/research/foundry/tier1-pit-artifacts.js";

const HOUR_MS = 3_600_000;
// Binance Vision's first common BTCUSDT/ETHUSDT bookTicker observations are
// in the May files at 2023-05-16T11:49:47.214Z / .207Z respectively.  The
// original 2023-05-01 candidate is therefore not BBO-complete.  This is the
// first canonical hour with a source-backed BBO mark for both symbols.
const REQUESTED_STUDY_START_MS = Date.UTC(2023, 4, 1, 1);
const STUDY_START_MS = Date.UTC(2023, 4, 16, 12);
const STUDY_END_MS = Date.UTC(2024, 3, 1);
const WARMUP_START_MS = Date.UTC(2023, 3, 1);
const WARMUP_END_MS = STUDY_START_MS;
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const BBO_MAX_AGE_MS = HOUR_MS;
const RISK_LOOKBACK_BARS = 168;
const RISK_MINIMUM_OBSERVATIONS = 120;
const MINIMUM_COMPLETED_BARS = 168;
const BBO_SCOPE_SELECTION = {
  policyVersion: "binance-vision-usdm-bookticker-common-start-v1",
  requestedStartMs: REQUESTED_STUDY_START_MS,
  selectedStartMs: STUDY_START_MS,
  diagnostics: [
    { symbol: "BTCUSDT", rawObjectPath: "BTCUSDT/BTCUSDT-bookTicker-2023-05.zip", rawObjectSha256: "93a787d1c1f69118f04b40fcc99607ab1f6504cb790672725359a2b94509251e", firstObservedEventTimeMs: 1684237787214, diagnosticBuildId: "267e0406-459d-4b6f-9d40-86da4417b2c3" },
    { symbol: "ETHUSDT", rawObjectPath: "ETHUSDT/ETHUSDT-bookTicker-2023-05.zip", rawObjectSha256: "7c39ed37defad7b62df39f7a8c901dd5858a2db91f6dd28454e238977c5d0d61", firstObservedEventTimeMs: 1684237787207, diagnosticBuildId: "8936c795-9b7d-4ae5-878d-ead95cdcacb4" },
  ],
};
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{7,64}$/;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`FREE_TIER1_PRELIFECYCLE_ENV_REQUIRED_${name}`);
  return value;
}

function positiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`FREE_TIER1_PRELIFECYCLE_ENV_INVALID_${name}`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function writeJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function expectedBookTickerPaths() {
  const months = [
    ...Array.from({ length: 8 }, (_, index) => `2023-${String(index + 5).padStart(2, "0")}`),
    ...Array.from({ length: 3 }, (_, index) => `2024-${String(index + 1).padStart(2, "0")}`),
  ];
  return SYMBOLS.flatMap((symbol) => months.map((month) => `${symbol}/${symbol}-bookTicker-${month}.zip`)).sort();
}

function assertFrozenBookTickerManifest(input) {
  const raw = readFileSync(input.path, "utf8");
  if (!raw.endsWith("\n")) throw new Error("FREE_TIER1_BBO_RAW_MANIFEST_TERMINAL_NEWLINE_REQUIRED");
  const manifest = JSON.parse(raw);
  const paths = manifest.objects?.map((entry) => entry.relativePath) ?? [];
  if (
    manifest.schemaVersion !== "KronosFreeTier1RawAcquisition/v2"
    || manifest.scope?.objectCount !== 22
    || JSON.stringify(paths) !== JSON.stringify(expectedBookTickerPaths())
    || manifest.canonicalRawBookTickerBundleHash !== input.expectedBundleHash
    || manifest.inventoryPassHash !== input.expectedBundleHash
    || manifest.secondInventoryPassHash !== input.expectedBundleHash
    || sha256(Buffer.from(stable(manifest.objects))) !== input.expectedBundleHash
  ) throw new Error("FREE_TIER1_BBO_RAW_MANIFEST_INVALID");
  return manifest;
}

function expectedDailyRepairPaths() {
  return SYMBOLS.flatMap((symbol) => ["2023-05-16", "2023-05-17", "2023-09-22"].map((day) => `${symbol}/${symbol}-bookTicker-${day}.zip`)).sort();
}

function assertDailyBookTickerRepairManifest(input) {
  const raw = readFileSync(input.path, "utf8");
  if (!raw.endsWith("\n")) throw new Error("FREE_TIER1_BBO_DAILY_REPAIR_MANIFEST_TERMINAL_NEWLINE_REQUIRED");
  const manifest = JSON.parse(raw); const paths = manifest.objects?.map((entry) => entry.relativePath) ?? [];
  if (
    manifest.schemaVersion !== "KronosFreeTier1DailyBookTickerRepair/v1"
    || manifest.baseMonthlyRawBundleHash !== input.expectedMonthlyBundleHash
    || manifest.scope?.objectCount !== 6
    || JSON.stringify(paths) !== JSON.stringify(expectedDailyRepairPaths())
    || manifest.canonicalDailyRepairBundleHash !== input.expectedRepairBundleHash
    || sha256(Buffer.from(stable(manifest.objects))) !== input.expectedRepairBundleHash
    || manifest.baseMonthlyAcquisitionManifest?.uri !== `${input.study}/acquisition-manifests/v2/${input.expectedMonthlyBundleHash}.json`
    || !HASH.test(manifest.baseMonthlyAcquisitionManifest?.sha256 ?? "")
    || !/^[0-9]+$/.test(manifest.baseMonthlyAcquisitionManifest?.generation ?? "")
  ) throw new Error("FREE_TIER1_BBO_DAILY_REPAIR_MANIFEST_INVALID");
  return manifest;
}

function assertCmsCatalogManifest(input) {
  const raw = readFileSync(input.path, "utf8");
  if (!raw.endsWith("\n")) throw new Error("FREE_TIER1_CMS_MANIFEST_TERMINAL_NEWLINE_REQUIRED");
  const manifest = JSON.parse(raw);
  if (
    manifest.schemaVersion !== input.schemaVersion
    || manifest.status !== "RAW_CATALOG_ACQUIRED_NOT_A_TIMELINE"
    || manifest.provider !== "Binance"
    || manifest.exchange !== "BINANCE_USDM"
    || manifest.datasetId !== `binance-cms-public-announcements-catalog-${input.catalogId}`
    || manifest.catalog?.catalogId !== input.catalogId
    || manifest.archiveBundleHash !== input.expectedBundleHash
    || !Array.isArray(manifest.requests)
    || manifest.requests.length === 0
  ) throw new Error(`FREE_TIER1_CMS_MANIFEST_INVALID_${input.catalogId}`);
  return { manifest, manifestSha256: sha256(Buffer.from(raw, "utf8")) };
}

function coverage(startMs, endMs, extra = {}) {
  return { startMs, endMs, symbols: [...SYMBOLS], cadenceMs: HOUR_MS, ...extra };
}

function sourceProvenance(input) {
  if (!HASH.test(input.rawFileHash) || !HASH.test(input.inventoryHash) || !SHA.test(input.generationSha)) throw new Error("FREE_TIER1_PRELIFECYCLE_PROVENANCE_INVALID");
  return {
    provenanceType: input.provenanceType,
    provider: "Binance Vision",
    exchange: "BINANCE_USDM",
    datasetId: `${input.datasetId}:${input.inventoryHash}`,
    retrievedAtMs: input.generatedAtMs,
    rawFileHash: input.rawFileHash,
    schemaVersion: "v1",
    generationToolSha: input.generationSha,
  };
}

function derivedProvenance(input) {
  const parentSemanticManifestHashes = [...input.parentSemanticManifestHashes].sort();
  return {
    provenanceType: "DERIVED_FROM_FOUNDRY_ARTIFACTS",
    provider: "Kronos Dataset Foundry",
    exchange: "BINANCE_USDM",
    datasetId: input.datasetId,
    retrievedAtMs: input.generatedAtMs,
    rawFileHash: tournamentHash({ parentSemanticManifestHashes, policyVersion: input.policyVersion, parameters: input.parameters }),
    schemaVersion: "v1",
    generationToolSha: input.generationSha,
  };
}

function derivation(policyVersion, parameters, parentSemanticManifestHashes) {
  const parents = [...parentSemanticManifestHashes].sort();
  if (!parents.length || parents.some((hash) => !HASH.test(hash))) throw new Error("FREE_TIER1_PRELIFECYCLE_DERIVATION_PARENT_INVALID");
  return { version: "foundry-derivation-v1", policyVersion, parameters, parentSemanticManifestHashes: parents };
}

function artifactRecord(name, built) {
  return {
    name,
    artifactKind: built.manifest.artifactKind,
    semanticManifestHash: built.manifest.semanticManifestHash,
    rowsHash: built.manifest.rowsHash,
    rowCount: built.manifest.rowCount,
    missingDataReport: built.manifest.missingDataReport,
    archiveBundleHash: built.manifest.archiveBundle?.archiveBundleHash ?? null,
    parentSemanticManifestHashes: built.manifest.derivation?.parentSemanticManifestHashes ?? [],
  };
}

function asTournamentCandles(rows) {
  return rows.map((row) => ({
    symbol: row.symbol,
    openTimeMs: row.openTimeMs,
    closeTimeMs: row.closeTimeMs,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}

async function build() {
  const rawRoot = required("RAW_ROOT");
  const artifactRoot = required("ARTIFACT_ROOT");
  const reportPath = required("REPORT_PATH");
  const generatedAtMs = positiveInteger("GENERATED_AT_MS");
  const generationSha = required("GENERATION_SHA");
  const bboRawBundleHash = required("BBO_RAW_BUNDLE_HASH");
  const bboDailyRepairBundleHash = required("BBO_DAILY_REPAIR_BUNDLE_HASH");
  const lifecycleLaunchBundleHash = required("LIFECYCLE_LAUNCH_BUNDLE_HASH");
  const lifecycleDelistingBundleHash = required("LIFECYCLE_DELISTING_BUNDLE_HASH");
  if (!SHA.test(generationSha) || !HASH.test(bboRawBundleHash) || !HASH.test(bboDailyRepairBundleHash) || !HASH.test(lifecycleLaunchBundleHash) || !HASH.test(lifecycleDelistingBundleHash)) throw new Error("FREE_TIER1_PRELIFECYCLE_GENERATION_IDENTITY_INVALID");

  const gcsInventoryPath = resolve(rawRoot, "source-gcs-inventory.json");
  const inventoryBytes = readFileSync(gcsInventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  const inventoryHash = sha256(inventoryBytes);
  if (inventory.schemaVersion !== "KronosFreeTier1PrelifecycleGcsInventory/v1") throw new Error("FREE_TIER1_PRELIFECYCLE_GCS_INVENTORY_INVALID");
  const bboManifest = assertFrozenBookTickerManifest({ path: resolve(rawRoot, "bbo-raw-acquisition-manifest.json"), expectedBundleHash: bboRawBundleHash });
  const dailyRepairManifest = assertDailyBookTickerRepairManifest({ path: resolve(rawRoot, "bbo-daily-repair-acquisition-manifest.json"), study: inventory.study, expectedMonthlyBundleHash: bboRawBundleHash, expectedRepairBundleHash: bboDailyRepairBundleHash });
  const launchRoot = resolve(rawRoot, "lifecycle-binance-cms-catalog-48", "v1", lifecycleLaunchBundleHash);
  const delistingRoot = resolve(rawRoot, "lifecycle-binance-cms-catalog-161", "v2", lifecycleDelistingBundleHash);
  const launchCms = assertCmsCatalogManifest({ path: resolve(launchRoot, "acquisition-manifest.json"), schemaVersion: "KronosBinanceCmsLifecycleRaw/v1", catalogId: 48, expectedBundleHash: lifecycleLaunchBundleHash });
  const delistingCms = assertCmsCatalogManifest({ path: resolve(delistingRoot, "acquisition-manifest.json"), schemaVersion: "KronosBinanceCmsLifecycleRaw/v2", catalogId: 161, expectedBundleHash: lifecycleDelistingBundleHash });

  const warmupCoverage = coverage(WARMUP_START_MS, WARMUP_END_MS);
  const executionCoverage = coverage(STUDY_START_MS, STUDY_END_MS);
  const candleRoot = resolve(rawRoot, "klines");
  const fundingRoot = resolve(rawRoot, "fundingRate");
  const bboArchive = inspectArchiveBundle({ root: rawRoot, include: (relativePath) => (relativePath.startsWith("bookTicker/") || relativePath.startsWith("bookTicker-daily-repair/v1/") || relativePath.startsWith("klines/")) && (relativePath.endsWith(".zip") || relativePath.endsWith(".zip.CHECKSUM")) });
  const bboFiles = new Map(bboArchive.files.map((file) => [file.relativePath, file.fileHash]));
  for (const object of bboManifest.objects) {
    if (bboFiles.get(`bookTicker/${object.relativePath}`) !== object.canonical.sha256 || bboFiles.get(`bookTicker/${object.relativePath}.CHECKSUM`) !== object.companion.sha256 || object.officialChecksum !== object.canonical.sha256) throw new Error(`FREE_TIER1_BBO_STAGED_GENERATION_OR_HASH_MISMATCH_${object.relativePath}`);
  }
  for (const object of dailyRepairManifest.objects) {
    if (bboFiles.get(`bookTicker-daily-repair/v1/${object.relativePath}`) !== object.canonical.sha256 || bboFiles.get(`bookTicker-daily-repair/v1/${object.relativePath}.CHECKSUM`) !== object.companion.sha256 || object.officialChecksum !== object.canonical.sha256) throw new Error(`FREE_TIER1_BBO_DAILY_REPAIR_STAGED_GENERATION_OR_HASH_MISMATCH_${object.relativePath}`);
  }
  const mergedBboRawIdentity = tournamentHash({ monthlyRawBundleHash: bboRawBundleHash, dailyRepairBundleHash: bboDailyRepairBundleHash });
  const candleArchive = inspectArchiveBundle({ root: candleRoot, include: () => true });
  const fundingArchive = inspectArchiveBundle({ root: fundingRoot, include: () => true });

  const warmupCandles = importBinanceVisionUsdMRawCandleArchive({
    root: candleRoot,
    expectedCoverage: warmupCoverage,
    source: `Binance Vision USD-M 1h completed candles; GCS inventory ${inventoryHash}`,
    sourceProvenance: sourceProvenance({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT", datasetId: "binance-vision-usdm-1h-klines-prelifecycle-v1", rawFileHash: candleArchive.archiveBundleHash, inventoryHash, generatedAtMs, generationSha }),
    generatedAtMs,
    generationSha,
  });

  const executionCandles = importBinanceVisionUsdMRawCandleArchive({
    root: candleRoot,
    expectedCoverage: executionCoverage,
    source: `Binance Vision USD-M 1h completed candles; GCS inventory ${inventoryHash}`,
    sourceProvenance: sourceProvenance({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT", datasetId: "binance-vision-usdm-1h-klines-prelifecycle-v1", rawFileHash: candleArchive.archiveBundleHash, inventoryHash, generatedAtMs, generationSha }),
    generatedAtMs,
    generationSha,
  });

  const fundingScheduleSourceHash = fundingArchive.archiveBundleHash;
  const fundingSchedules = SYMBOLS.map((symbol) => ({ schemaVersion: "v1", symbol, kind: "UTC_8H_BOUNDARIES", source: "Binance Vision USD-M fundingRate historical schedule metadata: 00:00/08:00/16:00 UTC", sourceHash: fundingScheduleSourceHash, alignmentToleranceMs: 60_000 }));
  const funding = importBinanceVisionUsdMRawFundingArchive({
    root: fundingRoot,
    expectedCoverage: coverage(STUDY_START_MS, STUDY_END_MS, { fundingSchedules }),
    source: `Binance Vision USD-M funding settlements; GCS inventory ${inventoryHash}`,
    sourceProvenance: sourceProvenance({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT", datasetId: "binance-vision-usdm-fundingrate-prelifecycle-v1", rawFileHash: fundingArchive.archiveBundleHash, inventoryHash, generatedAtMs, generationSha }),
    generatedAtMs,
    generationSha,
  });

  const lifecycle = importBinanceCmsBoundedUsdMLifecycle({
    launchRoot,
    delistingRoot,
    expectedCoverage: executionCoverage,
    generatedAtMs,
    generationSha,
  });
  const allCandles = [...warmupCandles.rows, ...executionCandles.rows];
  const decisionTimesMs = executionCandles.rows.map((row) => row.closeTimeMs).sort((left, right) => left - right);
  const minimumHistoryParents = [
    lifecycle.listing.manifest.semanticManifestHash,
    lifecycle.futuresAvailability.manifest.semanticManifestHash,
    warmupCandles.manifest.semanticManifestHash,
    executionCandles.manifest.semanticManifestHash,
  ];
  const minimumHistoryDerivation = derivation(
    "free-binance-vision-prior-completed-bars-v1",
    { minimumCompletedBars: MINIMUM_COMPLETED_BARS, strictlyPrior: true, timeframeMs: HOUR_MS },
    minimumHistoryParents,
  );
  const minimumHistory = generateMinimumHistoryEligibilityArtifact({
    listingRows: lifecycle.listing.canonicalRows,
    futuresRows: lifecycle.futuresAvailability.canonicalRows,
    candleRows: allCandles,
    expectedCoverage: executionCoverage,
    decisionTimesMs,
    minimumCompletedBars: MINIMUM_COMPLETED_BARS,
    source: "Derived only from verified Binance CMS lifecycle state and strictly prior Binance Vision completed candles",
    sourceProvenance: derivedProvenance({ datasetId: "free-binance-vision-minimum-history-btceth-v1", parentSemanticManifestHashes: minimumHistoryParents, policyVersion: minimumHistoryDerivation.policyVersion, parameters: minimumHistoryDerivation.parameters, generatedAtMs, generationSha }),
    derivation: minimumHistoryDerivation,
    generatedAtMs,
    generationSha,
  });

  const liquidity = await importBinanceVisionUsdMRawBookTickerLiquidityArchive({
    root: rawRoot,
    expectedCoverage: executionCoverage,
    candleRows: allCandles,
    maxQuoteAgeMs: BBO_MAX_AGE_MS,
    source: `Binance Vision verified monthly bookTicker plus exact daily BBO repairs and prior completed volume; raw identity ${mergedBboRawIdentity}`,
    sourceProvenance: sourceProvenance({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT", datasetId: `binance-vision-usdm-bookticker-prelifecycle-v2:${mergedBboRawIdentity}`, rawFileHash: bboArchive.archiveBundleHash, inventoryHash, generatedAtMs, generationSha }),
    generatedAtMs,
    generationSha,
  });

  const riskParents = [warmupCandles.manifest.semanticManifestHash, executionCandles.manifest.semanticManifestHash];
  const riskDerivation = derivation("foundry-pit-risk-prelifecycle-v1", { lookbackBars: RISK_LOOKBACK_BARS, minimumObservations: RISK_MINIMUM_OBSERVATIONS, closeIntervalMs: HOUR_MS, snapshotIntervalMs: HOUR_MS, strictPrior: true }, riskParents);
  const risk = generatePitPortfolioRiskArtifact({
    candles: asTournamentCandles(allCandles),
    expectedCoverage: coverage(STUDY_START_MS, STUDY_END_MS, { maxSnapshotAgeMs: HOUR_MS }),
    asOfTimesMs: Array.from({ length: (STUDY_END_MS - STUDY_START_MS) / HOUR_MS }, (_, index) => STUDY_START_MS + index * HOUR_MS),
    lookbackBars: RISK_LOOKBACK_BARS,
    minimumObservations: RISK_MINIMUM_OBSERVATIONS,
    closeIntervalMs: HOUR_MS,
    snapshotIntervalMs: HOUR_MS,
    source: "Kronos Foundry strictly-prior aligned BTC/asset return risk snapshots",
    sourceProvenance: derivedProvenance({ datasetId: "foundry-pit-risk-prelifecycle-v1", parentSemanticManifestHashes: riskParents, policyVersion: riskDerivation.policyVersion, parameters: riskDerivation.parameters, generatedAtMs, generationSha }),
    derivation: riskDerivation,
    generatedAtMs,
    generationSha,
  });

  const artifacts = [
    { name: "warmup_candles", built: warmupCandles },
    { name: "execution_candles", built: executionCandles },
    { name: "funding_settlements", built: funding },
    { name: "listing_delisting_timeline", built: lifecycle.listing },
    { name: "futures_availability_timeline", built: lifecycle.futuresAvailability },
    { name: "minimum_history_eligibility", built: minimumHistory },
    { name: "pit_liquidity_spread", built: liquidity },
    { name: "pit_portfolio_risk", built: risk },
  ];
  for (const { built } of artifacts) persistFoundryArtifact({ rootDir: artifactRoot, manifest: built.manifest, rows: built.rows });
  for (const { built } of artifacts) {
    const loaded = loadFoundryArtifact({ rootDir: artifactRoot, semanticManifestHash: built.manifest.semanticManifestHash });
    if (loaded.manifest.rowsHash !== built.manifest.rowsHash || loaded.rows.length !== built.rows.length) throw new Error(`FREE_TIER1_PRELIFECYCLE_LOCAL_RELOAD_FAILED_${built.manifest.artifactKind}`);
  }

  const reportCore = {
    schemaVersion: "KronosFreeTier1FoundryArtifacts/v2",
    status: "COMPLETE_TIER1_ARTIFACTS_READY_FOR_IMMUTABLE_ASSEMBLY",
    study: { symbols: SYMBOLS, timeframeMs: HOUR_MS, startMs: STUDY_START_MS, endMs: STUDY_END_MS, scopeSelection: BBO_SCOPE_SELECTION },
    generation: { generatedAtMs, generationSha },
    sourceGcsInventoryHash: inventoryHash,
    frozenBookTicker: { rawManifestBundleHash: bboRawBundleHash, rawManifestSchemaVersion: bboManifest.schemaVersion, objectCount: bboManifest.objects.length, dailyRepairBundleHash: bboDailyRepairBundleHash, dailyRepairManifestSchemaVersion: dailyRepairManifest.schemaVersion, dailyRepairObjectCount: dailyRepairManifest.objects.length, mergedRawIdentityHash: mergedBboRawIdentity },
    frozenLifecycle: {
      launch: { catalogId: 48, rawBundleHash: lifecycleLaunchBundleHash, manifestSha256: launchCms.manifestSha256, requestCount: launchCms.manifest.requests.length },
      delisting: { catalogId: 161, rawBundleHash: lifecycleDelistingBundleHash, manifestSha256: delistingCms.manifestSha256, requestCount: delistingCms.manifest.requests.length },
      combinedSourceArchiveBundleHash: lifecycle.sourceArchiveBundle.archiveBundleHash,
    },
    policies: { bboMaxQuoteAgeMs: BBO_MAX_AGE_MS, minimumHistory: { minimumCompletedBars: MINIMUM_COMPLETED_BARS, strictlyPrior: true }, pitRisk: { lookbackBars: RISK_LOOKBACK_BARS, minimumObservations: RISK_MINIMUM_OBSERVATIONS, closeIntervalMs: HOUR_MS, snapshotIntervalMs: HOUR_MS, strictlyPrior: true } },
    artifacts: artifacts.map(({ name, built }) => artifactRecord(name, built)),
    localVerifiedReload: true,
    realTier1Blockers: [],
    empiricalExecutionForbidden: true,
  };
  const report = { ...reportCore, reportHash: tournamentHash(reportCore) };
  writeJson(reportPath, report);
  console.log(JSON.stringify({ status: "PASS", reportHash: report.reportHash, artifacts: report.artifacts.map((artifact) => ({ name: artifact.name, semanticManifestHash: artifact.semanticManifestHash, rowCount: artifact.rowCount })) }, null, 2));
}

function verify() {
  const reloadRoot = required("RELOAD_ROOT");
  const reportPath = required("REPORT_PATH");
  const finalReportPath = required("FINAL_REPORT_PATH");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  for (const artifact of report.artifacts) {
    const loaded = loadFoundryArtifact({ rootDir: reloadRoot, semanticManifestHash: artifact.semanticManifestHash });
    if (loaded.manifest.rowsHash !== artifact.rowsHash || loaded.manifest.rowCount !== artifact.rowCount) throw new Error(`FREE_TIER1_PRELIFECYCLE_GCS_RELOAD_FAILED_${artifact.name}`);
  }
  const finalCore = { ...report, reportHash: undefined, gcsVerifiedReload: true };
  delete finalCore.reportHash;
  const finalReport = { ...finalCore, reportHash: tournamentHash(finalCore) };
  writeJson(finalReportPath, finalReport);
  console.log(JSON.stringify({ status: "PASS", reportHash: finalReport.reportHash, gcsVerifiedReload: true, artifactCount: finalReport.artifacts.length }, null, 2));
}

const mode = process.argv[2];
if (mode === "build") await build();
else if (mode === "verify") verify();
else throw new Error("FREE_TIER1_PRELIFECYCLE_MODE_REQUIRED_build_or_verify");

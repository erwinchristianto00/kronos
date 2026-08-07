#!/usr/bin/env node
/*
 * Cloud-only, non-empirical preprocessing for the frozen Binance Vision
 * BTCUSDT/ETHUSDT study.  This deliberately persists only source-backed
 * Foundry inputs that do not require a historical instrument lifecycle.
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
import { generatePitPortfolioRiskArtifact } from "../../apps/api/dist/research/foundry/tier1-pit-artifacts.js";

const HOUR_MS = 3_600_000;
const STUDY_START_MS = Date.UTC(2023, 4, 1, 1);
const STUDY_END_MS = Date.UTC(2024, 3, 1);
const WARMUP_START_MS = Date.UTC(2023, 3, 1);
const WARMUP_END_MS = STUDY_START_MS;
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const BBO_MAX_AGE_MS = HOUR_MS;
const RISK_LOOKBACK_BARS = 168;
const RISK_MINIMUM_OBSERVATIONS = 120;
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
  if (!SHA.test(generationSha) || !HASH.test(bboRawBundleHash)) throw new Error("FREE_TIER1_PRELIFECYCLE_GENERATION_IDENTITY_INVALID");

  const gcsInventoryPath = resolve(rawRoot, "source-gcs-inventory.json");
  const inventoryBytes = readFileSync(gcsInventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  const inventoryHash = sha256(inventoryBytes);
  if (inventory.schemaVersion !== "KronosFreeTier1PrelifecycleGcsInventory/v1") throw new Error("FREE_TIER1_PRELIFECYCLE_GCS_INVENTORY_INVALID");
  const bboManifest = assertFrozenBookTickerManifest({ path: resolve(rawRoot, "bbo-raw-acquisition-manifest.json"), expectedBundleHash: bboRawBundleHash });

  const warmupCoverage = coverage(WARMUP_START_MS, WARMUP_END_MS);
  const executionCoverage = coverage(STUDY_START_MS, STUDY_END_MS);
  const candleRoot = resolve(rawRoot, "klines");
  const fundingRoot = resolve(rawRoot, "fundingRate");
  const bboArchive = inspectArchiveBundle({ root: rawRoot, include: (relativePath) => (relativePath.startsWith("bookTicker/") || relativePath.startsWith("klines/")) && (relativePath.endsWith(".zip") || relativePath.endsWith(".zip.CHECKSUM")) });
  const bboFiles = new Map(bboArchive.files.map((file) => [file.relativePath, file.fileHash]));
  for (const object of bboManifest.objects) {
    if (bboFiles.get(`bookTicker/${object.relativePath}`) !== object.canonical.sha256 || bboFiles.get(`bookTicker/${object.relativePath}.CHECKSUM`) !== object.companion.sha256 || object.officialChecksum !== object.canonical.sha256) throw new Error(`FREE_TIER1_BBO_STAGED_GENERATION_OR_HASH_MISMATCH_${object.relativePath}`);
  }
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

  const allCandles = [...warmupCandles.rows, ...executionCandles.rows];
  const liquidity = await importBinanceVisionUsdMRawBookTickerLiquidityArchive({
    root: rawRoot,
    expectedCoverage: executionCoverage,
    candleRows: allCandles,
    maxQuoteAgeMs: BBO_MAX_AGE_MS,
    source: `Binance Vision verified monthly bookTicker BBO plus prior completed volume; raw bundle ${bboRawBundleHash}`,
    sourceProvenance: sourceProvenance({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT", datasetId: `binance-vision-usdm-bookticker-prelifecycle-v1:${bboRawBundleHash}`, rawFileHash: bboArchive.archiveBundleHash, inventoryHash, generatedAtMs, generationSha }),
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
    { name: "pit_liquidity_spread", built: liquidity },
    { name: "pit_portfolio_risk", built: risk },
  ];
  for (const { built } of artifacts) persistFoundryArtifact({ rootDir: artifactRoot, manifest: built.manifest, rows: built.rows });
  for (const { built } of artifacts) {
    const loaded = loadFoundryArtifact({ rootDir: artifactRoot, semanticManifestHash: built.manifest.semanticManifestHash });
    if (loaded.manifest.rowsHash !== built.manifest.rowsHash || loaded.rows.length !== built.rows.length) throw new Error(`FREE_TIER1_PRELIFECYCLE_LOCAL_RELOAD_FAILED_${built.manifest.artifactKind}`);
  }

  const reportCore = {
    schemaVersion: "KronosFreeTier1PrelifecycleFoundry/v1",
    status: "PARTIAL_ARTIFACTS_READY_REAL_TIER1_EXECUTION_FORBIDDEN",
    study: { symbols: SYMBOLS, timeframeMs: HOUR_MS, startMs: STUDY_START_MS, endMs: STUDY_END_MS },
    generation: { generatedAtMs, generationSha },
    sourceGcsInventoryHash: inventoryHash,
    frozenBookTicker: { rawManifestBundleHash: bboRawBundleHash, rawManifestSchemaVersion: bboManifest.schemaVersion, objectCount: bboManifest.objects.length },
    policies: { bboMaxQuoteAgeMs: BBO_MAX_AGE_MS, pitRisk: { lookbackBars: RISK_LOOKBACK_BARS, minimumObservations: RISK_MINIMUM_OBSERVATIONS, closeIntervalMs: HOUR_MS, snapshotIntervalMs: HOUR_MS, strictlyPrior: true } },
    artifacts: artifacts.map(({ name, built }) => artifactRecord(name, built)),
    localVerifiedReload: true,
    realTier1Blockers: ["MISSING_ARTIFACT:LISTING_DELISTING_TIMELINE", "MISSING_ARTIFACT:FUTURES_AVAILABILITY_TIMELINE", "MISSING_ARTIFACT:MINIMUM_HISTORY_ELIGIBILITY"],
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

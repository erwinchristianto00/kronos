#!/usr/bin/env node
/*
 * Audits the immutable Binance Vision BBO bundle before any real Tier-1
 * artifact is made. This is deliberately a source-coverage report, not an
 * eligibility artifact: a stale BBO tick cannot become tradeable by virtue of
 * appearing in this report.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// This cloud diagnostic deliberately executes the Foundry source with `tsx`.
// Compiling the entire API after staging the 90 GB immutable corpus has proven
// unnecessarily fragile in Cloud Build; the diagnostic itself is JavaScript
// and does not create any runtime artifact. The Cloud Build invocation pins
// `tsx` through package-lock.json and still runs the exact source modules that
// the API build typechecks in CI.
import { tournamentHash } from "../../apps/api/src/research/contract/tournament-contract.ts";
import { inspectBinanceVisionUsdMRawBookTickerCoverage } from "../../apps/api/src/research/foundry/binance-vision-usdm-raw-adapter.ts";

const HOUR_MS = 3_600_000;
const STUDY_START_MS = Date.UTC(2023, 4, 16, 12);
const STUDY_END_MS = Date.UTC(2024, 3, 1);
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const BBO_MAX_AGE_MS = HOUR_MS;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{7,64}$/;

function required(name) { const value = process.env[name]; if (!value) throw new Error(`FREE_TIER1_BBO_COVERAGE_ENV_REQUIRED_${name}`); return value; }
function positiveInteger(name) { const value = Number(required(name)); if (!Number.isSafeInteger(value) || value < 0) throw new Error(`FREE_TIER1_BBO_COVERAGE_ENV_INVALID_${name}`); return value; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function writeJson(path, value) { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function expectedBookTickerPaths() {
  const months = [...Array.from({ length: 8 }, (_, index) => `2023-${String(index + 5).padStart(2, "0")}`), ...Array.from({ length: 3 }, (_, index) => `2024-${String(index + 1).padStart(2, "0")}`)];
  return SYMBOLS.flatMap((symbol) => months.map((month) => `${symbol}/${symbol}-bookTicker-${month}.zip`)).sort();
}

function assertFrozenBookTickerManifest(path, expectedBundleHash) {
  const bytes = readFileSync(path); const manifest = JSON.parse(bytes.toString("utf8")); const paths = manifest.objects?.map((entry) => entry.relativePath) ?? [];
  if (!bytes.toString("utf8").endsWith("\n") || manifest.schemaVersion !== "KronosFreeTier1RawAcquisition/v2" || manifest.scope?.objectCount !== 22 || JSON.stringify(paths) !== JSON.stringify(expectedBookTickerPaths()) || manifest.canonicalRawBookTickerBundleHash !== expectedBundleHash || manifest.inventoryPassHash !== expectedBundleHash || manifest.secondInventoryPassHash !== expectedBundleHash || sha256(Buffer.from(stable(manifest.objects))) !== expectedBundleHash) throw new Error("FREE_TIER1_BBO_COVERAGE_RAW_MANIFEST_INVALID");
  return manifest;
}

function expectedDailyRepairPaths() {
  return ["BTCUSDT", "ETHUSDT"].flatMap((symbol) => ["2023-05-16", "2023-05-17", "2023-09-21", "2023-09-22"].map((day) => `${symbol}/${symbol}-bookTicker-${day}.zip`)).sort();
}

function assertDailyRepairManifest(path, expectedBundleHash, expectedMonthlyBundleHash, study) {
  const bytes = readFileSync(path); const manifest = JSON.parse(bytes.toString("utf8")); const paths = manifest.objects?.map((entry) => entry.relativePath) ?? [];
  if (!bytes.toString("utf8").endsWith("\n") || manifest.schemaVersion !== "KronosFreeTier1DailyBookTickerRepair/v1" || manifest.baseMonthlyRawBundleHash !== expectedMonthlyBundleHash || manifest.scope?.objectCount !== 8 || JSON.stringify(paths) !== JSON.stringify(expectedDailyRepairPaths()) || manifest.canonicalDailyRepairBundleHash !== expectedBundleHash || sha256(Buffer.from(stable(manifest.objects))) !== expectedBundleHash) throw new Error("FREE_TIER1_BBO_DAILY_REPAIR_MANIFEST_INVALID");
  const base = manifest.baseMonthlyAcquisitionManifest;
  if (!base || base.uri !== `${study}/acquisition-manifests/v2/${expectedMonthlyBundleHash}.json` || !SHA.test(base.sha256) || !/^[0-9]+$/.test(base.generation)) throw new Error("FREE_TIER1_BBO_DAILY_REPAIR_PARENT_INVALID");
  return manifest;
}

function coalescedIntervals(samples) {
  const intervals = [];
  for (const sample of samples.sort((left, right) => left.asOfMs - right.asOfMs)) {
    const previous = intervals.at(-1);
    if (previous && previous.endMs === sample.asOfMs) { previous.endMs += HOUR_MS; previous.ticks += 1; previous.maxQuoteAgeMs = Math.max(previous.maxQuoteAgeMs, sample.quoteAgeMs); }
    else intervals.push({ startMs: sample.asOfMs, endMs: sample.asOfMs + HOUR_MS, ticks: 1, maxQuoteAgeMs: sample.quoteAgeMs });
  }
  return intervals;
}

async function main() {
  const rawRoot = required("RAW_ROOT"); const reportPath = required("REPORT_PATH"); const study = required("STUDY"); const generatedAtMs = positiveInteger("GENERATED_AT_MS"); const generationSha = required("GENERATION_SHA"); const bboRawBundleHash = required("BBO_RAW_BUNDLE_HASH"); const dailyRepairBundleHash = required("BBO_DAILY_REPAIR_BUNDLE_HASH");
  if (!HASH.test(bboRawBundleHash) || !HASH.test(dailyRepairBundleHash) || !SHA.test(generationSha)) throw new Error("FREE_TIER1_BBO_COVERAGE_IDENTITY_INVALID");
  const rawManifestPath = resolve(rawRoot, "bbo-raw-acquisition-manifest.json"); const rawManifestBytes = readFileSync(rawManifestPath); const rawManifest = assertFrozenBookTickerManifest(rawManifestPath, bboRawBundleHash);
  const dailyRepairManifestPath = resolve(rawRoot, "bbo-daily-repair-acquisition-manifest.json"); const dailyRepairManifestBytes = readFileSync(dailyRepairManifestPath); const dailyRepairManifest = assertDailyRepairManifest(dailyRepairManifestPath, dailyRepairBundleHash, bboRawBundleHash, study);
  const inspected = await inspectBinanceVisionUsdMRawBookTickerCoverage({ root: rawRoot, expectedCoverage: { startMs: STUDY_START_MS, endMs: STUDY_END_MS, symbols: SYMBOLS, cadenceMs: HOUR_MS }, maxQuoteAgeMs: BBO_MAX_AGE_MS });
  const byKey = new Map(inspected.samples.map((sample) => [`${sample.symbol}:${sample.asOfMs}`, sample]));
  const invalidBySymbol = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, inspected.samples.filter((sample) => sample.symbol === symbol && !sample.withinMaxQuoteAge).map((sample) => ({ asOfMs: sample.asOfMs, eventTimeMs: sample.eventTimeMs, quoteAgeMs: sample.quoteAgeMs, sourceHash: sample.sourceHash }))]));
  const commonInvalid = [];
  const commonWindows = [];
  let openWindowStartMs = null;
  for (let openTimeMs = STUDY_START_MS; openTimeMs < STUDY_END_MS; openTimeMs += HOUR_MS) {
    const asOfMs = openTimeMs + HOUR_MS - 1;
    const observations = SYMBOLS.map((symbol) => byKey.get(`${symbol}:${asOfMs}`));
    const valid = observations.every((sample) => sample?.withinMaxQuoteAge === true);
    if (valid) { if (openWindowStartMs === null) openWindowStartMs = asOfMs; continue; }
    if (openWindowStartMs !== null) { commonWindows.push({ startMs: openWindowStartMs, endMs: asOfMs, bars: (asOfMs - openWindowStartMs) / HOUR_MS }); openWindowStartMs = null; }
    commonInvalid.push({ asOfMs, observations: observations.map((sample, index) => sample ? { symbol: SYMBOLS[index], eventTimeMs: sample.eventTimeMs, quoteAgeMs: sample.quoteAgeMs, sourceHash: sample.sourceHash } : { symbol: SYMBOLS[index], missing: true }) });
  }
  if (openWindowStartMs !== null) commonWindows.push({ startMs: openWindowStartMs, endMs: STUDY_END_MS, bars: (STUDY_END_MS - openWindowStartMs) / HOUR_MS });
  const reportCore = {
    schemaVersion: "KronosFreeTier1BboCoverageAudit/v2",
    status: commonInvalid.length ? "BBO_COVERAGE_GAPS_DETECTED_REAL_TIER1_EXECUTION_FORBIDDEN" : "BBO_COVERAGE_COMPLETE_PENDING_FOUNDRY_INGEST",
    study: { symbols: SYMBOLS, timeframeMs: HOUR_MS, startMs: STUDY_START_MS, endMs: STUDY_END_MS },
    generation: { generatedAtMs, generationSha },
    policy: { version: "binance-vision-usdm-bookticker-hourly-v4", maxQuoteAgeMs: BBO_MAX_AGE_MS, decisionTimeRule: "completed_candle_close_ms", selectionRule: "latest event-time quote at or before each completed-candle close decision timestamp" },
    raw: {
      rawManifestSha256: sha256(rawManifestBytes), rawManifestBundleHash: rawManifest.canonicalRawBookTickerBundleHash, rawManifestObjectCount: rawManifest.objects.length,
      dailyRepairManifestSha256: sha256(dailyRepairManifestBytes), dailyRepairBundleHash: dailyRepairManifest.canonicalDailyRepairBundleHash, dailyRepairObjectCount: dailyRepairManifest.objects.length,
      mergedRawIdentityHash: tournamentHash({ monthlyRawBundleHash: rawManifest.canonicalRawBookTickerBundleHash, dailyRepairBundleHash: dailyRepairManifest.canonicalDailyRepairBundleHash }),
      inspectedArchiveBundleHash: inspected.archiveBundle.archiveBundleHash, inspectedArchiveFileCount: inspected.archiveBundle.fileCount,
    },
    coverage: {
      expectedTicksPerSymbol: (STUDY_END_MS - STUDY_START_MS) / HOUR_MS,
      invalidBySymbol: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, { count: invalidBySymbol[symbol].length, intervals: coalescedIntervals(invalidBySymbol[symbol]) }])),
      commonInvalidTicks: commonInvalid,
      commonCompleteWindows: commonWindows,
      longestCommonCompleteWindow: commonWindows.slice().sort((left, right) => right.bars - left.bars || left.startMs - right.startMs)[0] ?? null,
    },
    empiricalExecutionForbidden: true,
    nextStep: "Freeze a replacement validation scope only from an explicitly selected complete common window; do not treat this diagnostic as liquidity eligibility evidence.",
  };
  const report = { ...reportCore, reportHash: tournamentHash(reportCore) };
  writeJson(reportPath, report);
  console.log(JSON.stringify({ status: report.status, reportHash: report.reportHash, commonInvalidTicks: commonInvalid.length, longestCommonCompleteWindow: report.coverage.longestCommonCompleteWindow }, null, 2));
}

await main();

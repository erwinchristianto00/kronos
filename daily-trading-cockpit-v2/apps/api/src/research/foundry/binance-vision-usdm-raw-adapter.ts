import { execFileSync, spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";

import { tournamentHash } from "../contract/tournament-contract.js";
import { buildFoundryArtifact, type FoundryArtifactManifest } from "./artifact-schema.js";
import { inspectArchiveBundle, readArchiveBundle, type ArchiveBundleIdentity } from "./archive-bundle.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";
import { canonicalizeFundingSettlements, expectedFundingSettlementTimes } from "./funding-schedule.js";
import { FOUNDRY_SCHEMA_V1, type ValidatedFoundryRow } from "./semantic-validators.js";
import type { FoundrySourceProvenance } from "./source-provenance.js";

const HOUR_MS = 3_600_000;
const zip = (path: string): boolean => path.endsWith(".zip");
const checksum = (path: string): boolean => path.endsWith(".zip.CHECKSUM");
const archiveFile = (path: string): boolean => zip(path) || checksum(path);

interface BinanceVisionKline { symbol: string; openTimeMs: number; closeTimeMs: number; open: number; high: number; low: number; close: number; volume: number; sourceHash: string; }
interface BinanceVisionFunding { symbol: string; observedSettlementTimeMs: number; fundingIntervalMs: number; rate: number; sourceHash: string; }
interface BookTickerSample { symbol: string; asOfMs: number; eventTimeMs: number; bidPrice: number; bidQuantity: number; askPrice: number; askQuantity: number; sourceHash: string; }

function finite(value: string, field: string, path: string): number { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`FOUNDRY_BINANCE_VISION_VALUE_INVALID_${field}_${path}`); return parsed; }
function integer(value: string, field: string, path: string): number { const parsed = finite(value, field, path); if (!Number.isSafeInteger(parsed)) throw new Error(`FOUNDRY_BINANCE_VISION_TIMESTAMP_INVALID_${field}_${path}`); return parsed; }
function csv(path: string): string[] { return execFileSync("unzip", ["-p", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim().split(/\r?\n/).filter(Boolean); }
function parseRows(path: string, headers: readonly string[]): Array<Record<string, string>> {
  const lines = csv(path); const header = lines.shift()?.split(",") ?? [];
  if (header.length !== headers.length || header.some((value, index) => value !== headers[index])) throw new Error(`FOUNDRY_BINANCE_VISION_HEADERS_INVALID_${path}`);
  return lines.map((line) => { const values = line.split(","); if (values.length !== header.length) throw new Error(`FOUNDRY_BINANCE_VISION_COLUMNS_INVALID_${path}`); return Object.fromEntries(header.map((field, index) => [field, values[index]! ])); });
}

function exactChecksum(bundle: ArchiveBundleIdentity, root: string): void {
  const byPath = new Map(bundle.files.map((file) => [file.relativePath, file]));
  for (const file of bundle.files.filter((file) => zip(file.relativePath))) {
    const checksumPath = `${file.relativePath}.CHECKSUM`; const companion = byPath.get(checksumPath);
    if (!companion) throw new Error(`FOUNDRY_BINANCE_VISION_CHECKSUM_MISSING_${file.relativePath}`);
    const value = csvText(resolve(root, checksumPath)).trim().match(/^([a-f0-9]{64})\s+([^\s]+)$/i);
    if (!value || value[2] !== basename(file.relativePath) || value[1]!.toLowerCase() !== file.fileHash) throw new Error(`FOUNDRY_BINANCE_VISION_CHECKSUM_INVALID_${file.relativePath}`);
  }
  if (bundle.files.some((file) => checksum(file.relativePath) && !byPath.has(file.relativePath.slice(0, -".CHECKSUM".length)))) throw new Error("FOUNDRY_BINANCE_VISION_CHECKSUM_ORPHAN");
}
function csvText(path: string): string { return execFileSync("/bin/cat", [path], { encoding: "utf8", maxBuffer: 1024 * 1024 }); }
function symbolFromPath(relativePath: string, kind: "kline" | "funding" | "bookTicker"): string {
  const expression = kind === "kline" ? /^([A-Z0-9]+)\/1h\/\1-1h-\d{4}-\d{2}\.zip$/ : kind === "funding" ? /^([A-Z0-9]+)\/\1-fundingRate-\d{4}-\d{2}\.zip$/ : /^bookTicker\/([A-Z0-9]+)\/\1-bookTicker-\d{4}-\d{2}\.zip$/;
  const match = relativePath.match(expression); if (!match) throw new Error(`FOUNDRY_BINANCE_VISION_ARCHIVE_PATH_INVALID_${relativePath}`); return match[1]!;
}
function sourceHash(bundle: ArchiveBundleIdentity, relativePath: string): string { const value = bundle.files.find((file) => file.relativePath === relativePath)?.fileHash; if (!value) throw new Error(`FOUNDRY_BINANCE_VISION_ARCHIVE_FILE_MISSING_${relativePath}`); return value; }
function sourceArchive(input: { root: string; required: (relativePath: string) => boolean }): ArchiveBundleIdentity {
  const bundle = inspectArchiveBundle({ root: input.root, include: input.required }); exactChecksum(bundle, input.root); return bundle;
}

/** Imports direct Binance Vision 1h ZIP exports and their checksum companions. */
export function importBinanceVisionUsdMRawCandleArchive(input: { root: string; expectedCoverage: FoundryExpectedCoverage; source: string; sourceProvenance: FoundrySourceProvenance; generatedAtMs: number; generationSha: string }): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  if (input.expectedCoverage.cadenceMs !== HOUR_MS) throw new Error("FOUNDRY_BINANCE_VISION_CANDLE_TIMEFRAME_INVALID");
  const archiveBundle = sourceArchive({ root: input.root, required: archiveFile });
  const rows: BinanceVisionKline[] = archiveBundle.files.filter((file) => zip(file.relativePath)).flatMap((file) => {
    const symbol = symbolFromPath(file.relativePath, "kline"); const path = resolve(input.root, file.relativePath);
    return parseRows(path, ["open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume", "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore"]).map((row) => ({ symbol, openTimeMs: integer(row.open_time!, "OPEN_TIME_MS", file.relativePath), closeTimeMs: integer(row.close_time!, "CLOSE_TIME_MS", file.relativePath), open: finite(row.open!, "OPEN", file.relativePath), high: finite(row.high!, "HIGH", file.relativePath), low: finite(row.low!, "LOW", file.relativePath), close: finite(row.close!, "CLOSE", file.relativePath), volume: finite(row.volume!, "VOLUME", file.relativePath), sourceHash: sourceHash(archiveBundle, file.relativePath) }));
  }).filter((row) => row.openTimeMs >= input.expectedCoverage.startMs && row.openTimeMs < input.expectedCoverage.endMs).sort((a, b) => a.openTimeMs - b.openTimeMs || a.symbol.localeCompare(b.symbol));
  const built = buildFoundryArtifact({ artifactKind: "COMPLETED_CANDLES", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, archiveBundle, units: { price: "USDT", volume: "base_asset" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

/** Imports direct Binance Vision USD-M funding ZIP exports with source-backed 8h schedules. */
export function importBinanceVisionUsdMRawFundingArchive(input: { root: string; expectedCoverage: FoundryExpectedCoverage; source: string; sourceProvenance: FoundrySourceProvenance; generatedAtMs: number; generationSha: string }): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  const archiveBundle = sourceArchive({ root: input.root, required: archiveFile }); const schedules = input.expectedCoverage.fundingSchedules;
  if (!schedules?.length) throw new Error("FOUNDRY_BINANCE_VISION_FUNDING_SCHEDULE_REQUIRED");
  const observed: BinanceVisionFunding[] = archiveBundle.files.filter((file) => zip(file.relativePath)).flatMap((file) => {
    const symbol = symbolFromPath(file.relativePath, "funding");
    return parseRows(resolve(input.root, file.relativePath), ["calc_time", "funding_interval_hours", "last_funding_rate"]).map((row) => ({ symbol, observedSettlementTimeMs: integer(row.calc_time!, "CALC_TIME_MS", file.relativePath), fundingIntervalMs: finite(row.funding_interval_hours!, "FUNDING_INTERVAL_HOURS", file.relativePath) * HOUR_MS, rate: finite(row.last_funding_rate!, "FUNDING_RATE", file.relativePath), sourceHash: sourceHash(archiveBundle, file.relativePath) }));
  });
  const expected = new Map(schedules.map((schedule) => [schedule.symbol, new Set(expectedFundingSettlementTimes(schedule, input.expectedCoverage.startMs, input.expectedCoverage.endMs))]));
  const aligned = observed.filter((row) => [...(expected.get(row.symbol) ?? [])].some((time) => Math.abs(row.observedSettlementTimeMs - time) <= (schedules.find((schedule) => schedule.symbol === row.symbol)?.alignmentToleranceMs ?? -1)));
  const rows = canonicalizeFundingSettlements({ rows: aligned, schedules, startMs: input.expectedCoverage.startMs, endMs: input.expectedCoverage.endMs });
  const built = buildFoundryArtifact({ artifactKind: "FUNDING_SETTLEMENTS", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, archiveBundle, units: { rate: "fraction_per_settlement", interval: "ms" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: { ...input.expectedCoverage, fundingSchedules: schedules }, rows });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

function monthRange(relativePath: string): { startMs: number; endMs: number } {
  const date = relativePath.match(/-(\d{4})-(\d{2})\.zip$/); if (!date) throw new Error(`FOUNDRY_BINANCE_VISION_MONTH_INVALID_${relativePath}`);
  const year = Number(date[1]); const month = Number(date[2]); if (month < 1 || month > 12) throw new Error(`FOUNDRY_BINANCE_VISION_MONTH_INVALID_${relativePath}`);
  return { startMs: Date.UTC(year, month - 1, 1), endMs: Date.UTC(year, month, 1) };
}
function waitFor(child: ReturnType<typeof spawn>, label: string): Promise<void> { return new Promise((resolvePromise, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`FOUNDRY_BINANCE_VISION_PROCESS_FAILED_${label}_${code ?? "SIGNAL"}`))); }); }

async function bookTickerSamples(input: { path: string; relativePath: string; symbol: string; startMs: number; endMs: number; sourceHash: string; maxQuoteAgeMs: number }): Promise<BookTickerSample[]> {
  const awk = [
    'BEGIN { target = start; have = 0; prior = -1 }',
    'NR == 1 { if ($0 != "update_id,best_bid_price,best_bid_qty,best_ask_price,best_ask_qty,transaction_time,event_time") { print "HEADERS" > "/dev/stderr"; exit 2 } next }',
    '{ time = $7 + 0; if (time <= 0 || (prior >= 0 && time < prior)) { print "TIMESTAMP" > "/dev/stderr"; exit 3 } prior = time; while (target < end && time > target) { if (!have) { print "LEADING_GAP" > "/dev/stderr"; exit 4 } print target "\\t" lastTime "\\t" lastBidPrice "\\t" lastBidQty "\\t" lastAskPrice "\\t" lastAskQty; target += interval } lastTime = time; lastBidPrice = $2; lastBidQty = $3; lastAskPrice = $4; lastAskQty = $5; have = 1 }',
    'END { while (target < end) { if (!have) { print "TRAILING_GAP" > "/dev/stderr"; exit 5 } print target "\\t" lastTime "\\t" lastBidPrice "\\t" lastBidQty "\\t" lastAskPrice "\\t" lastAskQty; target += interval } }',
  ].join(" ");
  const unzip = spawn("unzip", ["-p", input.path], { stdio: ["ignore", "pipe", "pipe"] }); const sampler = spawn("awk", ["-F,", "-v", `start=${input.startMs}`, "-v", `end=${input.endMs}`, "-v", `interval=${HOUR_MS}`, awk], { stdio: ["pipe", "pipe", "pipe"] });
  const unzipDone = waitFor(unzip, `UNZIP_${input.relativePath}`); const samplerDone = waitFor(sampler, `AWK_${input.relativePath}`);
  const stderr: Buffer[] = []; const pipeErrors: Error[] = [];
  unzip.stderr.on("data", (value: Buffer) => stderr.push(value)); sampler.stderr.on("data", (value: Buffer) => stderr.push(value));
  sampler.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") pipeErrors.push(error); });
  unzip.stdout.pipe(sampler.stdin);
  const output: BookTickerSample[] = []; const lines = createInterface({ input: sampler.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    const values = line.split("\t"); if (values.length !== 6) throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_OUTPUT_INVALID_${input.relativePath}`);
    const [asOf, event, bidPrice, bidQuantity, askPrice, askQuantity] = values; const asOfMs = integer(asOf!, "AS_OF_MS", input.relativePath); const eventTimeMs = integer(event!, "EVENT_TIME_MS", input.relativePath); const parsedBidPrice = finite(bidPrice!, "BID_PRICE", input.relativePath); const parsedBidQuantity = finite(bidQuantity!, "BID_QUANTITY", input.relativePath); const parsedAskPrice = finite(askPrice!, "ASK_PRICE", input.relativePath); const parsedAskQuantity = finite(askQuantity!, "ASK_QUANTITY", input.relativePath);
    if (eventTimeMs > asOfMs || asOfMs - eventTimeMs > input.maxQuoteAgeMs || parsedBidPrice <= 0 || parsedAskPrice <= 0 || parsedBidQuantity < 0 || parsedAskQuantity < 0 || parsedAskPrice < parsedBidPrice) throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_PIT_INVALID_${input.symbol}_${asOfMs}`);
    output.push({ symbol: input.symbol, asOfMs, eventTimeMs, bidPrice: parsedBidPrice, bidQuantity: parsedBidQuantity, askPrice: parsedAskPrice, askQuantity: parsedAskQuantity, sourceHash: tournamentHash({ policyVersion: "binance-vision-usdm-bookticker-hourly-v1", archiveFileHash: input.sourceHash, eventTimeMs, bidPrice: parsedBidPrice, bidQuantity: parsedBidQuantity, askPrice: parsedAskPrice, askQuantity: parsedAskQuantity }) });
  }
  const [unzipResult, samplerResult] = await Promise.all([unzipDone.then(() => null, (error: Error) => error), samplerDone.then(() => null, (error: Error) => error)]);
  const parserDiagnostics = Buffer.concat(stderr).toString("utf8").trim();
  if (samplerResult || parserDiagnostics) throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_PARSE_INVALID_${input.relativePath}_${parserDiagnostics || samplerResult!.message}`);
  if (unzipResult) throw unzipResult;
  if (pipeErrors.length) throw pipeErrors[0]!;
  return output;
}

/** Streams official monthly bookTicker ZIPs into one exact BBO mark per canonical hourly decision tick. */
export async function importBinanceVisionUsdMRawBookTickerLiquidityArchive(input: { root: string; expectedCoverage: FoundryExpectedCoverage; candleRows: readonly ValidatedFoundryRow[]; maxQuoteAgeMs: number; source: string; sourceProvenance: FoundrySourceProvenance; generatedAtMs: number; generationSha: string }): Promise<{ rows: unknown[]; manifest: FoundryArtifactManifest }> {
  if (input.expectedCoverage.cadenceMs !== HOUR_MS || !Number.isInteger(input.maxQuoteAgeMs) || input.maxQuoteAgeMs < 0) throw new Error("FOUNDRY_BINANCE_VISION_BOOKTICKER_CONTRACT_INVALID");
  const archiveBundle = sourceArchive({ root: input.root, required: (path) => (path.startsWith("bookTicker/") || path.startsWith("klines/")) && archiveFile(path) });
  const samples: BookTickerSample[] = [];
  for (const file of archiveBundle.files.filter((file) => zip(file.relativePath) && file.relativePath.startsWith("bookTicker/")).sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const symbol = symbolFromPath(file.relativePath, "bookTicker"); const month = monthRange(file.relativePath); const startMs = Math.max(input.expectedCoverage.startMs, month.startMs); const endMs = Math.min(input.expectedCoverage.endMs, month.endMs);
    if (startMs < endMs) samples.push(...await bookTickerSamples({ path: resolve(input.root, file.relativePath), relativePath: file.relativePath, symbol, startMs, endMs, sourceHash: file.fileHash, maxQuoteAgeMs: input.maxQuoteAgeMs }));
  }
  const candles = new Map(input.candleRows.map((row) => [`${row.symbol}:${row.openTimeMs}`, row])); const rows = samples.map((sample) => {
    const candle = candles.get(`${sample.symbol}:${sample.asOfMs - HOUR_MS}`) as (ValidatedFoundryRow & { volume: number; closeTimeMs: number }) | undefined;
    if (!candle || candle.closeTimeMs !== sample.asOfMs - 1) throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_CANDLE_MISSING_${sample.symbol}_${sample.asOfMs}`);
    const midpoint = (sample.askPrice + sample.bidPrice) / 2;
    return { symbol: sample.symbol, asOfMs: sample.asOfMs, validUntilMs: sample.asOfMs + HOUR_MS - 1, volume: candle.volume, liquidityNotional: Math.min(sample.askPrice * sample.askQuantity, sample.bidPrice * sample.bidQuantity), spreadBps: ((sample.askPrice - sample.bidPrice) / midpoint) * 10_000, sourceHash: tournamentHash({ bookTicker: sample.sourceHash, candle: candle.sourceHash, eventTimeMs: sample.eventTimeMs }) };
  }).sort((a, b) => a.asOfMs - b.asOfMs || a.symbol.localeCompare(b.symbol));
  const built = buildFoundryArtifact({ artifactKind: "PIT_LIQUIDITY_SPREAD", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, archiveBundle, units: { asOfMs: "unix_ms", validUntilMs: "unix_ms", volume: "base_asset_prior_completed_1h", liquidityNotional: "USDT_min_best_bid_ask_notional", spreadBps: "inside_bbo_bps", policy: "binance-vision-usdm-bookticker-hourly-v1" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: { ...input.expectedCoverage, maxSnapshotAgeMs: input.maxQuoteAgeMs }, rows });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

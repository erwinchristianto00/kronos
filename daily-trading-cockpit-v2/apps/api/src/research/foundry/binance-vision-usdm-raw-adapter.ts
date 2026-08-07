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
// Binance Vision's first USD-M bookTicker monthly export has one verified
// boundary duplicate at the next month's first millisecond.  It is never a
// usable mark: accepting it as a carry would leak a future quote backwards.
const BOOK_TICKER_ARCHIVE_END_TAIL_TOLERANCE_MS = 1_000;
const BOOK_TICKER_HOURLY_POLICY_VERSION = "binance-vision-usdm-bookticker-hourly-v2";
const zip = (path: string): boolean => path.endsWith(".zip");
const checksum = (path: string): boolean => path.endsWith(".zip.CHECKSUM");
const archiveFile = (path: string): boolean => zip(path) || checksum(path);

interface BinanceVisionKline { symbol: string; openTimeMs: number; closeTimeMs: number; open: number; high: number; low: number; close: number; volume: number; sourceHash: string; }
interface BinanceVisionFunding { symbol: string; observedSettlementTimeMs: number; fundingIntervalMs: number; rate: number; sourceHash: string; }
interface BookTickerSample { symbol: string; asOfMs: number; eventTimeMs: number; bidPrice: number; bidQuantity: number; askPrice: number; askQuantity: number; sourceHash: string; }
interface BookTickerState { eventTimeMs: number; updateId: number; bidPrice: number; bidQuantity: number; askPrice: number; askQuantity: number; sourceHash: string; }

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

async function bookTickerSamples(input: { path: string; relativePath: string; symbol: string; startMs: number; endMs: number; sourceStartMs: number; sourceEndMs: number; sourceHash: string; maxQuoteAgeMs: number; initialState?: BookTickerState }): Promise<{ samples: BookTickerSample[]; carry: BookTickerState }> {
  const awk = [
    'BEGIN { baseTime = initialTime + 0; baseUpdate = initialUpdate + 0; baseBidPrice = initialBidPrice + 0; baseBidQty = initialBidQty + 0; baseAskPrice = initialAskPrice + 0; baseAskQty = initialAskQty + 0; baseOrigin = baseTime > 0 ? "P" : ""; carryTime = 0 }',
    'NR == 1 { if ($0 != "update_id,best_bid_price,best_bid_qty,best_ask_price,best_ask_qty,transaction_time,event_time") { print "HEADERS" > "/dev/stderr"; exit 2 } next }',
    '{ if (NF != 7) { print "COLUMNS" > "/dev/stderr"; exit 3 } update = $1 + 0; bidPrice = $2 + 0; bidQty = $3 + 0; askPrice = $4 + 0; askQty = $5 + 0; time = $7 + 0; if (update <= 0 || time <= 0 || bidPrice <= 0 || askPrice <= 0 || bidQty < 0 || askQty < 0 || askPrice < bidPrice) { print "VALUE" > "/dev/stderr"; exit 4 } if (time < sourceStart) { print "SOURCE_RANGE:" time > "/dev/stderr"; exit 5 } if (time >= sourceEnd) { if (time - sourceEnd <= archiveEndTail) next; print "SOURCE_RANGE:" time > "/dev/stderr"; exit 5 } if (time < start && (baseTime == 0 || time > baseTime || (time == baseTime && update > baseUpdate))) { baseTime = time; baseUpdate = update; baseBidPrice = bidPrice; baseBidQty = bidQty; baseAskPrice = askPrice; baseAskQty = askQty; baseOrigin = "C" } target = int((time + interval - 1) / interval) * interval; if (target >= start && target < end && (!(target in selectedTime) || time > selectedTime[target] || (time == selectedTime[target] && update > selectedUpdate[target]))) { selectedTime[target] = time; selectedUpdate[target] = update; selectedBidPrice[target] = bidPrice; selectedBidQty[target] = bidQty; selectedAskPrice[target] = askPrice; selectedAskQty[target] = askQty } if (carryTime == 0 || time > carryTime || (time == carryTime && update > carryUpdate)) { carryTime = time; carryUpdate = update; carryBidPrice = bidPrice; carryBidQty = bidQty; carryAskPrice = askPrice; carryAskQty = askQty } }',
    'END { if (carryTime == 0) { print "EMPTY" > "/dev/stderr"; exit 6 } activeTime = baseTime; activeUpdate = baseUpdate; activeBidPrice = baseBidPrice; activeBidQty = baseBidQty; activeAskPrice = baseAskPrice; activeAskQty = baseAskQty; activeOrigin = baseOrigin; for (target = start; target < end; target += interval) { if (target in selectedTime) { activeTime = selectedTime[target]; activeUpdate = selectedUpdate[target]; activeBidPrice = selectedBidPrice[target]; activeBidQty = selectedBidQty[target]; activeAskPrice = selectedAskPrice[target]; activeAskQty = selectedAskQty[target]; activeOrigin = "C" } if (activeTime == 0) { print "LEADING_GAP" > "/dev/stderr"; exit 7 } print "ROW\\t" target "\\t" activeOrigin "\\t" activeTime "\\t" activeUpdate "\\t" activeBidPrice "\\t" activeBidQty "\\t" activeAskPrice "\\t" activeAskQty } print "CARRY\\t" carryTime "\\t" carryUpdate "\\t" carryBidPrice "\\t" carryBidQty "\\t" carryAskPrice "\\t" carryAskQty }',
  ].join(" ");
  const initial = input.initialState;
  const unzip = spawn("unzip", ["-p", input.path], { stdio: ["ignore", "pipe", "pipe"] }); const sampler = spawn("awk", ["-F,", "-v", `start=${input.startMs}`, "-v", `end=${input.endMs}`, "-v", `sourceStart=${input.sourceStartMs}`, "-v", `sourceEnd=${input.sourceEndMs}`, "-v", `archiveEndTail=${BOOK_TICKER_ARCHIVE_END_TAIL_TOLERANCE_MS}`, "-v", `interval=${HOUR_MS}`, "-v", `initialTime=${initial?.eventTimeMs ?? 0}`, "-v", `initialUpdate=${initial?.updateId ?? 0}`, "-v", `initialBidPrice=${initial?.bidPrice ?? 0}`, "-v", `initialBidQty=${initial?.bidQuantity ?? 0}`, "-v", `initialAskPrice=${initial?.askPrice ?? 0}`, "-v", `initialAskQty=${initial?.askQuantity ?? 0}`, awk], { stdio: ["pipe", "pipe", "pipe"] });
  const unzipDone = waitFor(unzip, `UNZIP_${input.relativePath}`); const samplerDone = waitFor(sampler, `AWK_${input.relativePath}`);
  const stderr: Buffer[] = []; const pipeErrors: Error[] = [];
  unzip.stderr.on("data", (value: Buffer) => stderr.push(value)); sampler.stderr.on("data", (value: Buffer) => stderr.push(value));
  sampler.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") { pipeErrors.push(error); return; }
    // A fail-closed sampler rejection closes stdin before a multi-gigabyte ZIP
    // is exhausted. Stop its upstream reader too; otherwise unzip blocks forever
    // on the closed pipe and hides the actual parser diagnostic.
    unzip.stdout.unpipe(sampler.stdin);
    if (!unzip.killed) unzip.kill("SIGTERM");
  });
  unzip.stdout.pipe(sampler.stdin);
  const output: BookTickerSample[] = []; let carry: BookTickerState | undefined; const lines = createInterface({ input: sampler.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    const values = line.split("\t"); const kind = values.shift();
    if (kind === "ROW" && values.length === 8) {
      const [asOf, origin, event, updateId, bidPrice, bidQuantity, askPrice, askQuantity] = values; const asOfMs = integer(asOf!, "AS_OF_MS", input.relativePath); const eventTimeMs = integer(event!, "EVENT_TIME_MS", input.relativePath); const parsedUpdateId = integer(updateId!, "UPDATE_ID", input.relativePath); const parsedBidPrice = finite(bidPrice!, "BID_PRICE", input.relativePath); const parsedBidQuantity = finite(bidQuantity!, "BID_QUANTITY", input.relativePath); const parsedAskPrice = finite(askPrice!, "ASK_PRICE", input.relativePath); const parsedAskQuantity = finite(askQuantity!, "ASK_QUANTITY", input.relativePath); const rowSourceHash = origin === "P" ? initial?.sourceHash : origin === "C" ? input.sourceHash : undefined;
      if (!rowSourceHash || eventTimeMs > asOfMs || asOfMs - eventTimeMs > input.maxQuoteAgeMs || parsedUpdateId <= 0 || parsedBidPrice <= 0 || parsedAskPrice <= 0 || parsedBidQuantity < 0 || parsedAskQuantity < 0 || parsedAskPrice < parsedBidPrice) throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_PIT_INVALID_${input.symbol}_${asOfMs}`);
      output.push({ symbol: input.symbol, asOfMs, eventTimeMs, bidPrice: parsedBidPrice, bidQuantity: parsedBidQuantity, askPrice: parsedAskPrice, askQuantity: parsedAskQuantity, sourceHash: tournamentHash({ policyVersion: BOOK_TICKER_HOURLY_POLICY_VERSION, archiveEndTailToleranceMs: BOOK_TICKER_ARCHIVE_END_TAIL_TOLERANCE_MS, archiveFileHash: rowSourceHash, eventTimeMs, updateId: parsedUpdateId, bidPrice: parsedBidPrice, bidQuantity: parsedBidQuantity, askPrice: parsedAskPrice, askQuantity: parsedAskQuantity }) });
    } else if (kind === "CARRY" && values.length === 6) {
      const [event, updateId, bidPrice, bidQuantity, askPrice, askQuantity] = values; carry = { eventTimeMs: integer(event!, "EVENT_TIME_MS", input.relativePath), updateId: integer(updateId!, "UPDATE_ID", input.relativePath), bidPrice: finite(bidPrice!, "BID_PRICE", input.relativePath), bidQuantity: finite(bidQuantity!, "BID_QUANTITY", input.relativePath), askPrice: finite(askPrice!, "ASK_PRICE", input.relativePath), askQuantity: finite(askQuantity!, "ASK_QUANTITY", input.relativePath), sourceHash: input.sourceHash };
    } else throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_OUTPUT_INVALID_${input.relativePath}`);
  }
  const [unzipResult, samplerResult] = await Promise.all([unzipDone.then(() => null, (error: Error) => error), samplerDone.then(() => null, (error: Error) => error)]);
  const parserDiagnostics = Buffer.concat(stderr).toString("utf8").trim();
  if (samplerResult || parserDiagnostics) throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_PARSE_INVALID_${input.relativePath}_${parserDiagnostics || samplerResult!.message}`);
  if (unzipResult) throw unzipResult;
  if (pipeErrors.length) throw pipeErrors[0]!;
  if (!carry) throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_CARRY_MISSING_${input.relativePath}`);
  return { samples: output, carry };
}

/** Streams official monthly bookTicker ZIPs into one exact BBO mark per canonical hourly decision tick. */
export async function importBinanceVisionUsdMRawBookTickerLiquidityArchive(input: { root: string; expectedCoverage: FoundryExpectedCoverage; candleRows: readonly ValidatedFoundryRow[]; maxQuoteAgeMs: number; source: string; sourceProvenance: FoundrySourceProvenance; generatedAtMs: number; generationSha: string }): Promise<{ rows: unknown[]; manifest: FoundryArtifactManifest }> {
  if (input.expectedCoverage.cadenceMs !== HOUR_MS || !Number.isInteger(input.maxQuoteAgeMs) || input.maxQuoteAgeMs < 0) throw new Error("FOUNDRY_BINANCE_VISION_BOOKTICKER_CONTRACT_INVALID");
  const archiveBundle = sourceArchive({ root: input.root, required: (path) => (path.startsWith("bookTicker/") || path.startsWith("klines/")) && archiveFile(path) });
  const samples: BookTickerSample[] = []; const carryBySymbol = new Map<string, BookTickerState>();
  for (const file of archiveBundle.files.filter((file) => zip(file.relativePath) && file.relativePath.startsWith("bookTicker/")).sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const symbol = symbolFromPath(file.relativePath, "bookTicker"); const month = monthRange(file.relativePath); const startMs = Math.max(input.expectedCoverage.startMs, month.startMs); const endMs = Math.min(input.expectedCoverage.endMs, month.endMs);
    const establishesBoundaryCarry = month.endMs === input.expectedCoverage.startMs && !carryBySymbol.has(symbol);
    if (startMs < endMs || establishesBoundaryCarry) { const imported = await bookTickerSamples({ path: resolve(input.root, file.relativePath), relativePath: file.relativePath, symbol, startMs, endMs, sourceStartMs: month.startMs, sourceEndMs: month.endMs, sourceHash: file.fileHash, maxQuoteAgeMs: input.maxQuoteAgeMs, initialState: carryBySymbol.get(symbol) }); samples.push(...imported.samples); carryBySymbol.set(symbol, imported.carry); }
  }
  const candles = new Map(input.candleRows.map((row) => [`${row.symbol}:${row.openTimeMs}`, row])); const rows = samples.map((sample) => {
    const candle = candles.get(`${sample.symbol}:${sample.asOfMs - HOUR_MS}`) as (ValidatedFoundryRow & { volume: number; closeTimeMs: number }) | undefined;
    if (!candle || candle.closeTimeMs !== sample.asOfMs - 1) throw new Error(`FOUNDRY_BINANCE_VISION_BOOKTICKER_CANDLE_MISSING_${sample.symbol}_${sample.asOfMs}`);
    const midpoint = (sample.askPrice + sample.bidPrice) / 2;
    return { symbol: sample.symbol, asOfMs: sample.asOfMs, validUntilMs: sample.asOfMs + HOUR_MS - 1, volume: candle.volume, liquidityNotional: Math.min(sample.askPrice * sample.askQuantity, sample.bidPrice * sample.bidQuantity), spreadBps: ((sample.askPrice - sample.bidPrice) / midpoint) * 10_000, sourceHash: tournamentHash({ bookTicker: sample.sourceHash, candle: candle.sourceHash, eventTimeMs: sample.eventTimeMs }) };
  }).sort((a, b) => a.asOfMs - b.asOfMs || a.symbol.localeCompare(b.symbol));
  const built = buildFoundryArtifact({ artifactKind: "PIT_LIQUIDITY_SPREAD", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, archiveBundle, units: { asOfMs: "unix_ms", validUntilMs: "unix_ms", volume: "base_asset_prior_completed_1h", liquidityNotional: "USDT_min_best_bid_ask_notional", spreadBps: "inside_bbo_bps", policy: BOOK_TICKER_HOURLY_POLICY_VERSION, archiveEndTailToleranceMs: `${BOOK_TICKER_ARCHIVE_END_TAIL_TOLERANCE_MS}ms` }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: { ...input.expectedCoverage, maxSnapshotAgeMs: input.maxQuoteAgeMs }, rows });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createGunzip } from "node:zlib";

import { tournamentHash } from "../contract/tournament-contract.js";
import { buildFoundryArtifact, type FoundryArtifactManifest } from "./artifact-schema.js";
import { inspectArchiveBundle, type ArchiveBundleFile } from "./archive-bundle.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";
import { FOUNDRY_SCHEMA_V1 } from "./semantic-validators.js";
import type { FoundrySourceProvenance } from "./source-provenance.js";

const csv = (path: string): boolean => path.endsWith(".csv") || path.endsWith(".csv.gz");
const quotePath = /(?:^|\/)quotes\/([A-Z0-9]+)\//;
const candlePath = /(?:^|\/)candles\/([A-Z0-9]+)\/1h\//;
const QUOTE_HEADERS = ["exchange", "symbol", "timestamp", "local_timestamp", "ask_amount", "ask_price", "bid_price", "bid_amount"];
const CANDLE_HEADERS = ["open_time", "open", "high", "low", "close", "volume", "close_time"];

interface Quote { symbol: string; timestampUs: number; askAmount: number; askPrice: number; bidPrice: number; bidAmount: number; sourceHash: string; }
interface CandleVolume { symbol: string; closeTimeMs: number; volume: number; sourceHash: string; }

function finite(value: string, field: string, path: string): number { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_VALUE_INVALID_${field}_${path}`); return parsed; }
function safeInteger(value: string, field: string, path: string): number { const parsed = finite(value, field, path); if (!Number.isSafeInteger(parsed)) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_TIMESTAMP_INVALID_${field}_${path}`); return parsed; }

/**
 * Tardis exports are tick-level and can be hundreds of gigabytes.  Preserve the
 * exact CSV contract, but read one compressed file and one row at a time so a
 * Cloud Build worker never materialises the export in memory.
 */
async function* streamRows(input: { absolutePath: string; relativePath: string; headers: readonly string[]; exactHeaders: boolean }): AsyncGenerator<Record<string, string>> {
  const file = createReadStream(input.absolutePath); const decoded = input.absolutePath.endsWith(".gz") ? file.pipe(createGunzip()) : file;
  const lines = createInterface({ input: decoded, crlfDelay: Infinity }); let header: string[] | undefined;
  for await (const line of lines) {
    if (!line) continue;
    if (!header) {
      header = line.split(",");
      if ((input.exactHeaders && (header.length !== input.headers.length || header.some((value, index) => value !== input.headers[index]))) || (!input.exactHeaders && input.headers.some((value) => !header!.includes(value)))) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_HEADERS_INVALID_${input.relativePath}`);
      continue;
    }
    const cells = line.split(","); if (cells.length !== header.length) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_COLUMNS_INVALID_${input.relativePath}`);
    yield Object.fromEntries(header.map((key, index) => [key, cells[index]! ]));
  }
  if (!header) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_HEADERS_INVALID_${input.relativePath}`);
}

function artifactRow(input: { quote: Quote; candle: CandleVolume; asOfMs: number; cadenceMs: number }): Record<string, number | string> {
  const midpoint = (input.quote.askPrice + input.quote.bidPrice) / 2; const spreadBps = (input.quote.askPrice - input.quote.bidPrice) / midpoint * 10_000; const liquidityNotional = Math.min(input.quote.askPrice * input.quote.askAmount, input.quote.bidPrice * input.quote.bidAmount);
  return { symbol: input.quote.symbol, asOfMs: input.asOfMs, validUntilMs: input.asOfMs + input.cadenceMs - 1, volume: input.candle.volume, liquidityNotional, spreadBps, sourceHash: tournamentHash({ policyVersion: "tardis-bbo-min-side-notional-v1", asOfMs: input.asOfMs, quoteTimestampUs: input.quote.timestampUs, quoteSourceHash: input.quote.sourceHash, candleCloseTimeMs: input.candle.closeTimeMs, candleSourceHash: input.candle.sourceHash }) };
}

/** Builds decision-time PIT volume, BBO liquidity, and inside-spread evidence only from immutable Tardis quotes and Binance completed candles. */
export async function importLocalTardisQuoteLiquidityArchive(input: {
  root: string;
  expectedCoverage: FoundryExpectedCoverage;
  maxQuoteAgeMs: number;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  generatedAtMs: number;
  generationSha: string;
}): Promise<{ rows: unknown[]; manifest: FoundryArtifactManifest }> {
  if (!input.expectedCoverage.cadenceMs || !Number.isInteger(input.maxQuoteAgeMs) || input.maxQuoteAgeMs < 0 || input.sourceProvenance.provenanceType !== "EXCHANGE_HISTORICAL_EXPORT") throw new Error("FOUNDRY_TARDIS_LIQUIDITY_IMPORT_CONTRACT_INVALID");
  const cadenceMs = input.expectedCoverage.cadenceMs;
  const archiveBundle = inspectArchiveBundle({ root: input.root, include: csv }); const quoteFiles = new Map<string, ArchiveBundleFile[]>(); const candles = new Map<string, CandleVolume>(); const foundSymbols = new Set<string>();
  for (const file of archiveBundle.files) {
    const quoteSymbol = file.relativePath.match(quotePath)?.[1]; const candleSymbol = file.relativePath.match(candlePath)?.[1]; const absolutePath = resolve(input.root, file.relativePath);
    if (quoteSymbol) {
      quoteFiles.set(quoteSymbol, [...(quoteFiles.get(quoteSymbol) ?? []), file]); foundSymbols.add(quoteSymbol);
    } else if (candleSymbol) {
      foundSymbols.add(candleSymbol);
      for await (const row of streamRows({ absolutePath, relativePath: file.relativePath, headers: CANDLE_HEADERS, exactHeaders: false })) {
        const closeTimeMs = safeInteger(row.close_time!, "CANDLE_CLOSE_TIME_MS", file.relativePath); const volume = finite(row.volume!, "CANDLE_VOLUME", file.relativePath);
        if (volume < 0) throw new Error(`FOUNDRY_TARDIS_CANDLE_VOLUME_INVALID_${file.relativePath}_${closeTimeMs}`);
        const key = `${candleSymbol}:${closeTimeMs}`; if (candles.has(key)) throw new Error(`FOUNDRY_TARDIS_CANDLE_DUPLICATE_${key}`); candles.set(key, { symbol: candleSymbol, closeTimeMs, volume, sourceHash: file.fileHash });
      }
    } else throw new Error(`FOUNDRY_TARDIS_LIQUIDITY_ARCHIVE_PATH_INVALID_${file.relativePath}`);
  }
  const symbols = [...input.expectedCoverage.symbols].sort(); if (symbols.some((symbol) => !foundSymbols.has(symbol) || !quoteFiles.has(symbol))) throw new Error("FOUNDRY_TARDIS_LIQUIDITY_SYMBOL_COVERAGE_INVALID");
  const output: Array<Record<string, number | string>> = []; const decisionTimes = Array.from({ length: (input.expectedCoverage.endMs - input.expectedCoverage.startMs) / cadenceMs }, (_, index) => input.expectedCoverage.startMs + index * cadenceMs);
  for (const symbol of symbols) {
    let targetIndex = 0; let active: Quote | undefined; let previousTimestampUs = -1;
    const emit = (asOfMs: number) => {
      const candle = candles.get(`${symbol}:${asOfMs - 1}`);
      if (!active || !candle || asOfMs * 1_000 - active.timestampUs > input.maxQuoteAgeMs * 1_000) throw new Error(`FOUNDRY_TARDIS_LIQUIDITY_PIT_COVERAGE_MISSING_${symbol}_${asOfMs}`);
      output.push(artifactRow({ quote: active, candle, asOfMs, cadenceMs }));
    };
    for (const file of quoteFiles.get(symbol)!.slice().sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
      for await (const row of streamRows({ absolutePath: resolve(input.root, file.relativePath), relativePath: file.relativePath, headers: QUOTE_HEADERS, exactHeaders: true })) {
        const quoteSymbol = row.symbol!; const timestampUs = safeInteger(row.timestamp!, "QUOTE_TIMESTAMP_US", file.relativePath); const askAmount = finite(row.ask_amount!, "ASK_AMOUNT", file.relativePath); const askPrice = finite(row.ask_price!, "ASK_PRICE", file.relativePath); const bidPrice = finite(row.bid_price!, "BID_PRICE", file.relativePath); const bidAmount = finite(row.bid_amount!, "BID_AMOUNT", file.relativePath);
        if (quoteSymbol !== symbol || quoteSymbol !== quoteSymbol.toUpperCase() || timestampUs < previousTimestampUs || askAmount < 0 || bidAmount < 0 || askPrice <= 0 || bidPrice <= 0 || askPrice < bidPrice) throw new Error(`FOUNDRY_TARDIS_BBO_INVALID_${file.relativePath}_${timestampUs}`);
        while (targetIndex < decisionTimes.length && decisionTimes[targetIndex]! * 1_000 < timestampUs) emit(decisionTimes[targetIndex++]!);
        active = { symbol, timestampUs, askAmount, askPrice, bidPrice, bidAmount, sourceHash: file.fileHash }; previousTimestampUs = timestampUs;
      }
    }
    while (targetIndex < decisionTimes.length) emit(decisionTimes[targetIndex++]!);
  }
  output.sort((left, right) => Number(left.asOfMs) - Number(right.asOfMs) || String(left.symbol).localeCompare(String(right.symbol)));
  const built = buildFoundryArtifact({ artifactKind: "PIT_LIQUIDITY_SPREAD", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, archiveBundle, units: { asOfMs: "unix_ms", validUntilMs: "unix_ms", volume: "base_asset_prior_completed_1h", liquidityNotional: "USDT_min_best_bid_ask_notional", spreadBps: "inside_bbo_bps", policy: "tardis-bbo-min-side-notional-v1" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: { ...input.expectedCoverage, maxSnapshotAgeMs: input.maxQuoteAgeMs }, rows: output });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

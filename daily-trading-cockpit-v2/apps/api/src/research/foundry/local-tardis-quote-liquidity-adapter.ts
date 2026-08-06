import { gunzipSync } from "node:zlib";

import { tournamentHash } from "../contract/tournament-contract.js";
import { buildFoundryArtifact, type FoundryArtifactManifest } from "./artifact-schema.js";
import { readArchiveBundle } from "./archive-bundle.js";
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

function rows(bytes: Buffer, path: string, headers: readonly string[], exactHeaders: boolean): Array<Record<string, string>> {
  const decoded = path.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8"); const lines = decoded.trim().split(/\r?\n/); const header = lines.shift()?.split(",") ?? [];
  if ((exactHeaders && (header.length !== headers.length || header.some((value, index) => value !== headers[index]))) || (!exactHeaders && headers.some((value) => !header.includes(value)))) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_HEADERS_INVALID_${path}`);
  return lines.filter(Boolean).map((line) => { const cells = line.split(","); if (cells.length !== header.length) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_COLUMNS_INVALID_${path}`); return Object.fromEntries(header.map((key, index) => [key, cells[index]! ])); });
}
function finite(value: string, field: string, path: string): number { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_VALUE_INVALID_${field}_${path}`); return parsed; }
function safeInteger(value: string, field: string, path: string): number { const parsed = finite(value, field, path); if (!Number.isSafeInteger(parsed)) throw new Error(`FOUNDRY_TARDIS_OR_BINANCE_TIMESTAMP_INVALID_${field}_${path}`); return parsed; }

/** Builds decision-time PIT volume, BBO liquidity, and inside-spread evidence only from immutable Tardis quotes and Binance completed candles. */
export function importLocalTardisQuoteLiquidityArchive(input: {
  root: string;
  expectedCoverage: FoundryExpectedCoverage;
  maxQuoteAgeMs: number;
  source: string;
  sourceProvenance: FoundrySourceProvenance;
  generatedAtMs: number;
  generationSha: string;
}): { rows: unknown[]; manifest: FoundryArtifactManifest } {
  if (!input.expectedCoverage.cadenceMs || !Number.isInteger(input.maxQuoteAgeMs) || input.maxQuoteAgeMs < 0 || input.sourceProvenance.provenanceType !== "EXCHANGE_HISTORICAL_EXPORT") throw new Error("FOUNDRY_TARDIS_LIQUIDITY_IMPORT_CONTRACT_INVALID");
  const archiveBundle = readArchiveBundle({ root: input.root, include: csv }); const quotes: Quote[] = []; const candles: CandleVolume[] = [];
  for (const file of archiveBundle.files) {
    const content = archiveBundle.contents.get(file.relativePath)!; const quoteSymbol = file.relativePath.match(quotePath)?.[1]; const candleSymbol = file.relativePath.match(candlePath)?.[1];
    if (quoteSymbol) {
      for (const row of rows(content, file.relativePath, QUOTE_HEADERS, true)) {
        const symbol = row.symbol!; const timestampUs = safeInteger(row.timestamp!, "QUOTE_TIMESTAMP_US", file.relativePath); const askAmount = finite(row.ask_amount!, "ASK_AMOUNT", file.relativePath); const askPrice = finite(row.ask_price!, "ASK_PRICE", file.relativePath); const bidPrice = finite(row.bid_price!, "BID_PRICE", file.relativePath); const bidAmount = finite(row.bid_amount!, "BID_AMOUNT", file.relativePath);
        if (symbol !== quoteSymbol || symbol !== symbol.toUpperCase() || askAmount < 0 || bidAmount < 0 || askPrice <= 0 || bidPrice <= 0 || askPrice < bidPrice) throw new Error(`FOUNDRY_TARDIS_BBO_INVALID_${file.relativePath}_${timestampUs}`);
        quotes.push({ symbol, timestampUs, askAmount, askPrice, bidPrice, bidAmount, sourceHash: file.fileHash });
      }
    } else if (candleSymbol) {
      for (const row of rows(content, file.relativePath, CANDLE_HEADERS, false)) {
        const closeTimeMs = safeInteger(row.close_time!, "CANDLE_CLOSE_TIME_MS", file.relativePath); const volume = finite(row.volume!, "CANDLE_VOLUME", file.relativePath);
        if (volume < 0) throw new Error(`FOUNDRY_TARDIS_CANDLE_VOLUME_INVALID_${file.relativePath}_${closeTimeMs}`);
        candles.push({ symbol: candleSymbol, closeTimeMs, volume, sourceHash: file.fileHash });
      }
    } else throw new Error(`FOUNDRY_TARDIS_LIQUIDITY_ARCHIVE_PATH_INVALID_${file.relativePath}`);
  }
  const foundSymbols = new Set([...quotes, ...candles].map((row) => row.symbol)); if (input.expectedCoverage.symbols.some((symbol) => !foundSymbols.has(symbol))) throw new Error("FOUNDRY_TARDIS_LIQUIDITY_SYMBOL_COVERAGE_INVALID");
  const output: unknown[] = [];
  for (let asOfMs = input.expectedCoverage.startMs; asOfMs < input.expectedCoverage.endMs; asOfMs += input.expectedCoverage.cadenceMs) for (const symbol of [...input.expectedCoverage.symbols].sort()) {
    const quote = quotes.filter((row) => row.symbol === symbol && row.timestampUs <= asOfMs * 1_000).sort((a, b) => a.timestampUs - b.timestampUs).at(-1);
    const candle = candles.find((row) => row.symbol === symbol && row.closeTimeMs === asOfMs - 1);
    if (!quote || !candle || asOfMs * 1_000 - quote.timestampUs > input.maxQuoteAgeMs * 1_000) throw new Error(`FOUNDRY_TARDIS_LIQUIDITY_PIT_COVERAGE_MISSING_${symbol}_${asOfMs}`);
    const midpoint = (quote.askPrice + quote.bidPrice) / 2; const spreadBps = (quote.askPrice - quote.bidPrice) / midpoint * 10_000; const liquidityNotional = Math.min(quote.askPrice * quote.askAmount, quote.bidPrice * quote.bidAmount);
    output.push({ symbol, asOfMs, validUntilMs: asOfMs + input.expectedCoverage.cadenceMs - 1, volume: candle.volume, liquidityNotional, spreadBps, sourceHash: tournamentHash({ policyVersion: "tardis-bbo-min-side-notional-v1", asOfMs, quoteTimestampUs: quote.timestampUs, quoteSourceHash: quote.sourceHash, candleCloseTimeMs: candle.closeTimeMs, candleSourceHash: candle.sourceHash }) });
  }
  const { contents: _contents, ...archiveIdentity } = archiveBundle;
  const built = buildFoundryArtifact({ artifactKind: "PIT_LIQUIDITY_SPREAD", schemaVersion: FOUNDRY_SCHEMA_V1, source: input.source, sourceProvenance: input.sourceProvenance, archiveBundle: archiveIdentity, units: { asOfMs: "unix_ms", validUntilMs: "unix_ms", volume: "base_asset_prior_completed_1h", liquidityNotional: "USDT_min_best_bid_ask_notional", spreadBps: "inside_bbo_bps", policy: "tardis-bbo-min-side-notional-v1" }, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: { ...input.expectedCoverage, maxSnapshotAgeMs: input.maxQuoteAgeMs }, rows: output });
  return { rows: built.canonicalRows, manifest: built.manifest };
}

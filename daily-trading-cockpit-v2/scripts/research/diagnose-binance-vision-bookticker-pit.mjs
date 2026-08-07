#!/usr/bin/env node
/* Cloud-only single-tick reproduction for a fail-closed Binance Vision BBO mark. */
import { inspectArchiveBundle } from "../../apps/api/dist/research/foundry/archive-bundle.js";
import { importBinanceVisionUsdMRawBookTickerLiquidityArchive } from "../../apps/api/dist/research/foundry/binance-vision-usdm-raw-adapter.js";

const HOUR_MS = 3_600_000;
const asOfMs = 1_684_245_600_000;
const root = process.env.RAW_ROOT;
if (!root) throw new Error("BOOKTICKER_DIAGNOSTIC_RAW_ROOT_REQUIRED");
const archive = inspectArchiveBundle({ root, include: (path) => path.startsWith("bookTicker/") && (path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM")) });

try {
  const imported = await importBinanceVisionUsdMRawBookTickerLiquidityArchive({
    root,
    expectedCoverage: { startMs: asOfMs, endMs: asOfMs + HOUR_MS, symbols: ["BTCUSDT"], cadenceMs: HOUR_MS },
    candleRows: [{ symbol: "BTCUSDT", openTimeMs: asOfMs - HOUR_MS, closeTimeMs: asOfMs - 1, volume: 1, sourceHash: "diagnostic-prior-completed-candle" }],
    maxQuoteAgeMs: HOUR_MS,
    source: "Binance Vision source-backed one-tick diagnostic",
    sourceProvenance: { provenanceType: "EXCHANGE_HISTORICAL_EXPORT", provider: "Binance Vision", exchange: "BINANCE_USDM", datasetId: "binance-vision-bookticker-pit-diagnostic", retrievedAtMs: 0, rawFileHash: archive.archiveBundleHash, schemaVersion: "v1", generationToolSha: process.env.GENERATION_SHA ?? "unknown" },
    generatedAtMs: 0,
    generationSha: process.env.GENERATION_SHA ?? "unknown",
  });
  console.log(JSON.stringify({ status: "PASS", rows: imported.rows }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: "FAIL", name: error instanceof Error ? error.name : "Unknown", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}

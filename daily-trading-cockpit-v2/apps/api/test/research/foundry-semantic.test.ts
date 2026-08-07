import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { assertCandlesCoverCanonicalClock, buildCanonicalClock } from "../../src/research/foundry/canonical-clock.js";
import { assertCompleteFoundryArtifact, buildFoundryArtifactManifest } from "../../src/research/foundry/artifact-schema.js";
import { importLocalBinanceCandleArchive, importLocalBinanceFundingArchive } from "../../src/research/foundry/local-binance-archive-adapter.js";
import { importLocalTardisQuoteLiquidityArchive } from "../../src/research/foundry/local-tardis-quote-liquidity-adapter.js";
import { persistFoundryArtifact } from "../../src/research/foundry/artifact-store.js";
import { buildTier1CapabilityReport } from "../../src/research/foundry/tier1-capability.js";
import { FOUNDRY_SCHEMA_V1, validateFoundryRows } from "../../src/research/foundry/semantic-validators.js";
import { fixtureSourceProvenance } from "../../src/research/foundry/source-provenance.js";
import { PointInTimeUniverse } from "../../src/research/universe/point-in-time-universe.js";
import { assertEligibilityTimelineConsistency } from "../../src/research/foundry/cross-artifact-validator.js";
import { inspectArchiveBundle, readArchiveBundle } from "../../src/research/foundry/archive-bundle.js";
import { importBinanceVisionUsdMRawBookTickerLiquidityArchive, importBinanceVisionUsdMRawCandleArchive } from "../../src/research/foundry/binance-vision-usdm-raw-adapter.js";

const H = 3_600_000;
const expected = { startMs: 0, endMs: 2 * H, symbols: ["BTCUSDT"], cadenceMs: H };
const candle = (time: number) => ({ symbol: "BTCUSDT", openTimeMs: time, closeTimeMs: time + H - 1, open: 100, high: 101, low: 99, close: 100, volume: 1, sourceHash: "row-source" });
const base = (rows: unknown[], source = "fixture", coverage = expected) => buildFoundryArtifactManifest({ artifactKind: "COMPLETED_CANDLES", schemaVersion: FOUNDRY_SCHEMA_V1, source, sourceProvenance: fixtureSourceProvenance(source, "0000000"), units: { price: "USDT", volume: "base" }, generatedAtMs: 1, generationSha: "sha", expectedCoverage: coverage, rows });

describe("Foundry semantic strictness", () => {
  it("fails malformed rows for every artifact kind and unknown schema versions", () => {
    const kinds = ["COMPLETED_CANDLES", "FUNDING_SETTLEMENTS", "LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "PIT_LIQUIDITY_SPREAD", "FEE_ASSUMPTIONS", "CANONICAL_EPISODES", "PORTFOLIO_RISK_SNAPSHOTS", "KRONOS_DECISION_LEDGER"] as const;
    for (const kind of kinds) expect(() => validateFoundryRows(kind, FOUNDRY_SCHEMA_V1, [{ symbol: "btcusdt" }])).toThrow();
    expect(() => validateFoundryRows("COMPLETED_CANDLES", "v999", [candle(0)])).toThrow("FOUNDRY_SCHEMA_VERSION_UNSUPPORTED");
    expect(() => validateFoundryRows("COMPLETED_CANDLES", FOUNDRY_SCHEMA_V1, [{ ...candle(0), high: 1, low: 2 }])).toThrow("FOUNDRY_CANDLE_OHLC_INVALID");
  });

  it("derives gaps rather than trusting a declared complete claim and rejects duplicate/conflicting timestamps", () => {
    const incomplete = base([candle(0)]);
    expect(incomplete.missingDataReport).toContain(`INTERVAL:${H}-${2 * H}:BTCUSDT:CANDLE_GAP`);
    expect(() => assertCompleteFoundryArtifact(incomplete)).toThrow("FOUNDRY_DERIVED_COVERAGE_MISMATCH");
    expect(() => base([candle(0), { ...candle(0), close: 101 }])).toThrow("FOUNDRY_DUPLICATE_OR_CONFLICTING_ROW");
  });

  it("binds semantic identity to kind/schema/source/units/coverage as well as normalized rows", () => {
    const rows = [candle(0), candle(H)]; const first = base(rows); const sourceChanged = base(rows, "other-source"); const coverageChanged = base(rows, "fixture", { ...expected, endMs: 3 * H });
    expect(first.rowsHash).toBe(sourceChanged.rowsHash);
    expect(first.semanticManifestHash).not.toBe(sourceChanged.semanticManifestHash);
    expect(first.semanticManifestHash).not.toBe(coverageChanged.semanticManifestHash);
  });

  it("uses a fixed canonical clock and rejects missing or irregular marks", () => {
    const clock = buildCanonicalClock({ startMs: 0, endMs: 2 * H, timeframeMs: H });
    expect(clock.timestamps).toEqual([0, H]);
    const universe = new PointInTimeUniverse([{ asOfMs: 0, eligibleSymbols: ["BTCUSDT"], sourceHash: "u", evidence: { listedThen: true, sufficientHistoryThen: true, liquidityVolumeEligibleThen: true, spreadEligibleThen: true, futuresAvailableThen: true, delistingCheckedThen: true } }]);
    expect(() => assertCandlesCoverCanonicalClock({ clock, candles: [candle(0)], universe })).toThrow("FOUNDRY_CANONICAL_CLOCK_MARK_MISSING");
    expect(() => assertCandlesCoverCanonicalClock({ clock, candles: [{ ...candle(0), closeTimeMs: H }, candle(H)], universe })).toThrow("FOUNDRY_CANONICAL_CLOCK_CANDLE_IRREGULAR");
    expect(() => assertCandlesCoverCanonicalClock({ clock, candles: [candle(0), candle(H)], universe })).not.toThrow();
  });

  it("rejects conflicts between listing, futures availability, and eligibility timelines", () => {
    const listing = validateFoundryRows("LISTING_DELISTING_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, validUntilMs: H, status: "DELISTED", sourceHash: "s" }]);
    const futures = validateFoundryRows("FUTURES_AVAILABILITY_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, validUntilMs: H, available: false, sourceHash: "s" }]);
    const eligibility = validateFoundryRows("MINIMUM_HISTORY_ELIGIBILITY", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", asOfMs: 0, eligible: true, sourceHash: "s" }]);
    expect(() => assertEligibilityTimelineConsistency({ listingRows: listing, futuresRows: futures, minimumHistoryRows: eligibility })).toThrow("FOUNDRY_ELIGIBILITY_TIMELINE_CONFLICT");
  });

  it("imports local archive CSV deterministically and reports exact Tier-1 blockers", () => {
    const root = mkdtempSync(join(tmpdir(), "foundry-csv-")); const symbolDir = join(root, "BTCUSDT", "1h");
    try {
      mkdirSync(symbolDir, { recursive: true });
      const path = join(symbolDir, "fixture.csv"); writeFileSync(path, `open_time,open,high,low,close,volume,close_time\n0,100,101,99,100,1,3599999\n3600000,100,101,99,100,1,7199999\n`);
      const rawFileHash = readArchiveBundle({ root, include: (relativePath) => relativePath.endsWith(".csv") }).archiveBundleHash; const sourceProvenance = { ...fixtureSourceProvenance("local-fixture", "0000000"), rawFileHash };
      const first = importLocalBinanceCandleArchive({ root, expectedCoverage: expected, source: "local-fixture", sourceProvenance, generatedAtMs: 1, generationSha: "sha" }); const second = importLocalBinanceCandleArchive({ root, expectedCoverage: expected, source: "local-fixture", sourceProvenance, generatedAtMs: 1, generationSha: "sha" });
      expect(first.manifest.rowsHash).toBe(second.manifest.rowsHash); expect(first.manifest.semanticManifestHash).toBe(second.manifest.semanticManifestHash);
      expect(JSON.stringify(first.rows)).toBe(JSON.stringify(second.rows)); expect(JSON.stringify(first.manifest)).toBe(JSON.stringify(second.manifest));
      expect(persistFoundryArtifact({ rootDir: root, manifest: first.manifest, rows: first.rows })).toContain(first.manifest.semanticManifestHash);
      expect(buildTier1CapabilityReport([first.manifest])).toMatchObject({ canRun: false, blockers: expect.arrayContaining(["MISSING_ARTIFACT:FUNDING_SETTLEMENTS", "MISSING_ARTIFACT:PIT_LIQUIDITY_SPREAD"]) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("binds the whole raw archive while importing only the exact experiment window", () => {
    const root = mkdtempSync(join(tmpdir(), "foundry-windowed-")); const candleRoot = join(root, "candles"); const fundingRoot = join(root, "funding");
    try {
      const candleDirectory = join(candleRoot, "BTCUSDT", "1h"); const fundingDirectory = join(fundingRoot, "fundingRate", "BTCUSDT"); mkdirSync(candleDirectory, { recursive: true }); mkdirSync(fundingDirectory, { recursive: true });
      writeFileSync(join(candleDirectory, "source.csv"), `open_time,open,high,low,close,volume,close_time\n0,100,101,99,100,1,3599999\n3600000,101,102,100,101,2,7199999\n`);
      writeFileSync(join(fundingDirectory, "source.csv"), "calc_time,funding_interval_hours,last_funding_rate\n0,8,0.001\n3600008,8,0.002\n");
      const window = { startMs: H, endMs: 2 * H, symbols: ["BTCUSDT"], cadenceMs: H, fundingSchedules: [{ schemaVersion: "v1" as const, symbol: "BTCUSDT", kind: "EXPLICIT_HISTORICAL" as const, source: "fixture-schedule", sourceHash: "fixture-schedule-hash", alignmentToleranceMs: 60_000, settlementTimesMs: [H] }] };
      const candleRawFileHash = readArchiveBundle({ root: candleRoot, include: (relativePath) => relativePath.endsWith(".csv") }).archiveBundleHash; const fundingRawFileHash = readArchiveBundle({ root: fundingRoot, include: (relativePath) => relativePath.endsWith(".csv") }).archiveBundleHash;
      const candles = importLocalBinanceCandleArchive({ root: candleRoot, expectedCoverage: window, source: "windowed-candles", sourceProvenance: { ...fixtureSourceProvenance("windowed-candles", "0000000"), rawFileHash: candleRawFileHash }, generatedAtMs: 1, generationSha: "sha" });
      const funding = importLocalBinanceFundingArchive({ root: fundingRoot, expectedCoverage: window, source: "windowed-funding", sourceProvenance: { ...fixtureSourceProvenance("windowed-funding", "0000000"), rawFileHash: fundingRawFileHash }, generatedAtMs: 1, generationSha: "sha" });
      expect(candles.rows).toHaveLength(1); expect(candles.rows[0]).toMatchObject({ openTimeMs: H, close: 101 }); expect(candles.manifest.archiveBundle?.files).toHaveLength(1);
      expect(funding.rows).toHaveLength(1); expect(funding.rows[0]).toMatchObject({ canonicalSettlementTimeMs: H, observedSettlementTimeMs: H + 8 }); expect(funding.manifest.archiveBundle?.files).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("derives PIT BBO spread and prior completed volume without future-quote leakage", () => {
    const root = mkdtempSync(join(tmpdir(), "foundry-tardis-bbo-")); const symbols = ["BTCUSDT", "ETHUSDT"];
    const quoteCsv = (symbol: string, timestampUs: number) => `exchange,symbol,timestamp,local_timestamp,ask_amount,ask_price,bid_price,bid_amount\nbinance-futures,${symbol},${timestampUs},${timestampUs + 1},3,102,100,2\nbinance-futures,${symbol},${timestampUs + H * 1_000},${timestampUs + H * 1_000 + 1},4,103,101,3\n`;
    const candleCsv = "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n0,100,101,99,100,7,3599999,700,4,3,300,0\n3600000,100,102,99,101,8,7199999,800,5,4,400,0\n";
    const provenance = () => ({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT" as const, provider: "Tardis + Binance Vision", exchange: "BINANCE_USD_M", datasetId: "quotes-plus-prior-candle-volume", retrievedAtMs: 1, rawFileHash: readArchiveBundle({ root, include: (relativePath) => relativePath.endsWith(".csv") || relativePath.endsWith(".csv.gz") }).archiveBundleHash, schemaVersion: "tardis-quotes-v1", generationToolSha: "abcdef0" });
    const input = () => ({ root, expectedCoverage: { startMs: H, endMs: 3 * H, symbols, cadenceMs: H }, maxQuoteAgeMs: 60_000, source: "Tardis BBO plus Binance completed volume", sourceProvenance: provenance(), generatedAtMs: 1, generationSha: "abcdef0" });
    try {
      for (const symbol of symbols) { const quoteDirectory = join(root, "quotes", symbol); const candleDirectory = join(root, "candles", symbol, "1h"); mkdirSync(quoteDirectory, { recursive: true }); mkdirSync(candleDirectory, { recursive: true }); writeFileSync(join(quoteDirectory, "2026-01-01.csv.gz"), gzipSync(quoteCsv(symbol, H * 1_000 - 1_000))); writeFileSync(join(candleDirectory, "2026-01.csv"), candleCsv); }
      const first = importLocalTardisQuoteLiquidityArchive(input()); const second = importLocalTardisQuoteLiquidityArchive(input());
      expect(first.rows).toHaveLength(4); expect(first.rows[0]).toMatchObject({ symbol: "BTCUSDT", asOfMs: H, validUntilMs: 2 * H - 1, volume: 7, liquidityNotional: 200 }); expect(first.rows[2]).toMatchObject({ symbol: "BTCUSDT", asOfMs: 2 * H, volume: 8 }); expect(first.manifest.semanticManifestHash).toBe(second.manifest.semanticManifestHash);
      for (const symbol of symbols) writeFileSync(join(root, "quotes", symbol, "2026-01-01.csv.gz"), gzipSync(quoteCsv(symbol, H * 1_000 + 1)));
      expect(() => importLocalTardisQuoteLiquidityArchive(input())).toThrow("FOUNDRY_TARDIS_LIQUIDITY_PIT_COVERAGE_MISSING");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("streams checksum-verified Binance Vision bookTicker ZIPs into exact canonical hourly PIT marks", async () => {
    const root = mkdtempSync(join(tmpdir(), "foundry-binance-vision-bookticker-")); const monthStartMs = Date.UTC(2023, 4, 1); const startMs = Date.UTC(2023, 4, 16, 12); const endMs = startMs + 2 * H;
    const archive = (zipPath: string, body: string) => {
      const source = `${zipPath}.csv`; writeFileSync(source, body); execFileSync("zip", ["-j", zipPath, source], { stdio: "ignore" }); unlinkSync(source);
      const hash = createHash("sha256").update(readFileSync(zipPath)).digest("hex"); writeFileSync(`${zipPath}.CHECKSUM`, `${hash}  ${basename(zipPath)}\n`);
    };
    const provenance = (rawFileHash: string) => ({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT" as const, provider: "Binance Vision", exchange: "BINANCE_USD_M", datasetId: "futures-um-monthly-bookTicker-2023-05", retrievedAtMs: 1, rawFileHash, schemaVersion: "binance-vision-bookTicker-csv-v1", generationToolSha: "abcdef0" });
    try {
      const klineDirectory = join(root, "klines", "BTCUSDT", "1h"); const bboDirectory = join(root, "bookTicker", "BTCUSDT"); mkdirSync(klineDirectory, { recursive: true }); mkdirSync(bboDirectory, { recursive: true });
      archive(join(klineDirectory, "BTCUSDT-1h-2023-05.zip"), `open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n${startMs - H},100,101,99,100,7,${startMs - 1},700,4,3,300,0\n${startMs},100,102,99,101,8,${startMs + H - 1},800,5,4,400,0\n${startMs + H},101,103,100,102,9,${startMs + 2 * H - 1},900,6,5,500,0\n`);
      // Binance Vision's bookTicker exports are not guaranteed to be event-time
      // ordered. The sampler must choose the latest source quote per tick, not
      // depend on file row order.
      // This is the first BTCUSDT source mark in the real May-2023 archive:
      // its 13-digit event timestamp is 26 ms before the 12:00 canonical tick
      // and its 13-digit update ID must not be rounded by the awk wire format.
      archive(join(bboDirectory, "BTCUSDT-bookTicker-2023-05.zip"), `update_id,best_bid_price,best_bid_qty,best_ask_price,best_ask_qty,transaction_time,event_time\n3,102,6,103,7,${startMs + H + 1},${startMs + H + 1}\n1,100,2,101,3,${monthStartMs + 1},${monthStartMs + 1}\n2850015973062,100,2,101,3,${startMs - 26},${startMs - 26}\n2,101,4,102,5,${startMs + 1},${startMs + 1}\n`);
      const coverage = { startMs, endMs, symbols: ["BTCUSDT"], cadenceMs: H }; const candleRoot = join(root, "klines"); const candleBundle = inspectArchiveBundle({ root: candleRoot, include: (path) => path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM") });
      const candles = importBinanceVisionUsdMRawCandleArchive({ root: candleRoot, expectedCoverage: coverage, source: "Binance Vision kline", sourceProvenance: provenance(candleBundle.archiveBundleHash), generatedAtMs: 1, generationSha: "abcdef0" });
      const priorCandles = importBinanceVisionUsdMRawCandleArchive({ root: candleRoot, expectedCoverage: { ...coverage, startMs: monthStartMs }, source: "Binance Vision kline plus prior bar", sourceProvenance: provenance(candleBundle.archiveBundleHash), generatedAtMs: 1, generationSha: "abcdef0" });
      const bboBundle = inspectArchiveBundle({ root, include: (path) => (path.startsWith("bookTicker/") || path.startsWith("klines/")) && (path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM")) });
      const imported = await importBinanceVisionUsdMRawBookTickerLiquidityArchive({ root, expectedCoverage: coverage, candleRows: priorCandles.rows as never[], maxQuoteAgeMs: H, source: "Binance Vision BBO plus completed volume", sourceProvenance: provenance(bboBundle.archiveBundleHash), generatedAtMs: 1, generationSha: "abcdef0" });
      expect(imported.rows).toEqual(expect.arrayContaining([expect.objectContaining({ asOfMs: startMs, validUntilMs: startMs + H - 1, volume: 7, liquidityNotional: 200 }), expect.objectContaining({ asOfMs: startMs + H, volume: 8, liquidityNotional: 404 })]));
      expect(imported.manifest.archiveBundle?.archiveBundleHash).toBe(bboBundle.archiveBundleHash);
      await expect(importBinanceVisionUsdMRawBookTickerLiquidityArchive({ root, expectedCoverage: coverage, candleRows: priorCandles.rows as never[], maxQuoteAgeMs: 0, source: "Binance Vision BBO plus completed volume", sourceProvenance: provenance(bboBundle.archiveBundleHash), generatedAtMs: 1, generationSha: "abcdef0" })).rejects.toThrow("FOUNDRY_BINANCE_VISION_BOOKTICKER_PIT_INVALID");
      archive(join(bboDirectory, "BTCUSDT-bookTicker-2023-05.zip"), "unexpected,headers\n");
      const malformedBundle = inspectArchiveBundle({ root, include: (path) => (path.startsWith("bookTicker/") || path.startsWith("klines/")) && (path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM")) });
      await expect(importBinanceVisionUsdMRawBookTickerLiquidityArchive({ root, expectedCoverage: coverage, candleRows: priorCandles.rows as never[], maxQuoteAgeMs: H, source: "Binance Vision BBO plus completed volume", sourceProvenance: provenance(malformedBundle.archiveBundleHash), generatedAtMs: 1, generationSha: "abcdef0" })).rejects.toThrow("FOUNDRY_BINANCE_VISION_BOOKTICKER_PARSE_INVALID");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps distinct 13-digit hourly ticks out of AWK's low-precision array-key collisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "foundry-binance-vision-bookticker-exact-key-")); const monthStartMs = Date.UTC(2023, 4, 1); const startMs = Date.UTC(2023, 4, 16, 14); const endMs = startMs + 3 * H;
    const archive = (zipPath: string, body: string) => {
      const source = `${zipPath}.csv`; writeFileSync(source, body); execFileSync("zip", ["-j", zipPath, source], { stdio: "ignore" }); unlinkSync(source);
      const hash = createHash("sha256").update(readFileSync(zipPath)).digest("hex"); writeFileSync(`${zipPath}.CHECKSUM`, `${hash}  ${basename(zipPath)}\n`);
    };
    try {
      const bboDirectory = join(root, "bookTicker", "BTCUSDT"); mkdirSync(bboDirectory, { recursive: true });
      archive(join(bboDirectory, "BTCUSDT-bookTicker-2023-05.zip"), `update_id,best_bid_price,best_bid_qty,best_ask_price,best_ask_qty,transaction_time,event_time\n1,99,1,100,1,${monthStartMs + 1},${monthStartMs + 1}\n2,100,2,101,3,${startMs - 1},${startMs - 1}\n3,101,4,102,5,${startMs + 1},${startMs + 1}\n4,102,6,103,7,${startMs + H + 1},${startMs + H + 1}\n5,103,8,104,9,${startMs + 2 * H - 3},${startMs + 2 * H - 3}\n`);
      const bundle = inspectArchiveBundle({ root, include: (path) => path.startsWith("bookTicker/") && (path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM")) });
      const rows = (await importBinanceVisionUsdMRawBookTickerLiquidityArchive({ root, expectedCoverage: { startMs, endMs, symbols: ["BTCUSDT"], cadenceMs: H }, candleRows: [
        { symbol: "BTCUSDT", openTimeMs: startMs - H, closeTimeMs: startMs - 1, volume: 7, sourceHash: "prior-13" },
        { symbol: "BTCUSDT", openTimeMs: startMs, closeTimeMs: startMs + H - 1, volume: 8, sourceHash: "prior-14" },
        { symbol: "BTCUSDT", openTimeMs: startMs + H, closeTimeMs: startMs + 2 * H - 1, volume: 9, sourceHash: "prior-15" },
      ] as never[], maxQuoteAgeMs: H, source: "Binance Vision BBO exact-tick-key", sourceProvenance: { provenanceType: "EXCHANGE_HISTORICAL_EXPORT", provider: "Binance Vision", exchange: "BINANCE_USD_M", datasetId: "bookTicker-exact-tick-key-fixture", retrievedAtMs: 1, rawFileHash: bundle.archiveBundleHash, schemaVersion: "binance-vision-bookTicker-csv-v1", generationToolSha: "abcdef0" }, generatedAtMs: 1, generationSha: "abcdef0" })).rows as Array<{ asOfMs: number; liquidityNotional: number }>;
      expect(rows).toEqual([
        expect.objectContaining({ asOfMs: startMs, liquidityNotional: 200 }),
        expect.objectContaining({ asOfMs: startMs + H, liquidityNotional: 404 }),
        expect.objectContaining({ asOfMs: startMs + 2 * H, liquidityNotional: 824 }),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps parallel per-symbol bookTicker imports canonically deterministic", async () => {
    const root = mkdtempSync(join(tmpdir(), "foundry-binance-vision-bookticker-parallel-")); const monthStartMs = Date.UTC(2023, 4, 1); const startMs = monthStartMs + H; const endMs = startMs + H; const symbols = ["BTCUSDT", "ETHUSDT"];
    const archive = (zipPath: string, body: string) => {
      const source = `${zipPath}.csv`; writeFileSync(source, body); execFileSync("zip", ["-j", zipPath, source], { stdio: "ignore" }); unlinkSync(source);
      const hash = createHash("sha256").update(readFileSync(zipPath)).digest("hex"); writeFileSync(`${zipPath}.CHECKSUM`, `${hash}  ${basename(zipPath)}\n`);
    };
    try {
      for (const [index, symbol] of symbols.entries()) {
        const klineDirectory = join(root, "klines", symbol, "1h"); const bboDirectory = join(root, "bookTicker", symbol); mkdirSync(klineDirectory, { recursive: true }); mkdirSync(bboDirectory, { recursive: true });
        const bid = 100 + index; archive(join(klineDirectory, `${symbol}-1h-2023-05.zip`), `open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n${monthStartMs},${bid},${bid + 1},${bid - 1},${bid},7,${monthStartMs + H - 1},700,4,3,300,0\n${startMs},${bid},${bid + 1},${bid - 1},${bid},8,${startMs + H - 1},800,5,4,400,0\n`);
        archive(join(bboDirectory, `${symbol}-bookTicker-2023-05.zip`), `update_id,best_bid_price,best_bid_qty,best_ask_price,best_ask_qty,transaction_time,event_time\n${2850015973062 + index},${bid},2,${bid + 1},3,${startMs - 1},${startMs - 1}\n`);
      }
      const coverage = { startMs, endMs, symbols, cadenceMs: H }; const candleRoot = join(root, "klines"); const candleBundle = inspectArchiveBundle({ root: candleRoot, include: (path) => path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM") }); const allBundle = inspectArchiveBundle({ root, include: (path) => (path.startsWith("bookTicker/") || path.startsWith("klines/")) && (path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM")) }); const provenance = (rawFileHash: string) => ({ provenanceType: "EXCHANGE_HISTORICAL_EXPORT" as const, provider: "Binance Vision", exchange: "BINANCE_USD_M", datasetId: "parallel-monthly-bookticker-fixture", retrievedAtMs: 1, rawFileHash, schemaVersion: "binance-vision-bookTicker-csv-v1", generationToolSha: "abcdef0" });
      const candles = importBinanceVisionUsdMRawCandleArchive({ root: candleRoot, expectedCoverage: { ...coverage, startMs: monthStartMs }, source: "Binance Vision kline", sourceProvenance: provenance(candleBundle.archiveBundleHash), generatedAtMs: 1, generationSha: "abcdef0" });
      const input = () => ({ root, expectedCoverage: coverage, candleRows: candles.rows as never[], maxQuoteAgeMs: H, source: "Binance Vision BBO", sourceProvenance: provenance(allBundle.archiveBundleHash), generatedAtMs: 1, generationSha: "abcdef0" });
      const first = await importBinanceVisionUsdMRawBookTickerLiquidityArchive(input()); const second = await importBinanceVisionUsdMRawBookTickerLiquidityArchive(input());
      expect(first.rows).toEqual(second.rows); expect(first.manifest.semanticManifestHash).toBe(second.manifest.semanticManifestHash); expect(first.rows.map((row) => (row as { symbol: string }).symbol)).toEqual(symbols);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("carries the last source-backed BBO across a monthly boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "foundry-binance-vision-bbo-boundary-")); const mayStartMs = Date.UTC(2023, 4, 1); const juneStartMs = Date.UTC(2023, 5, 1);
    const archive = (zipPath: string, body: string) => {
      const source = `${zipPath}.csv`; writeFileSync(source, body); execFileSync("zip", ["-j", zipPath, source], { stdio: "ignore" }); unlinkSync(source);
      const hash = createHash("sha256").update(readFileSync(zipPath)).digest("hex"); writeFileSync(`${zipPath}.CHECKSUM`, `${hash}  ${basename(zipPath)}\n`);
    };
    try {
      const klineDirectory = join(root, "klines", "BTCUSDT", "1h"); const bboDirectory = join(root, "bookTicker", "BTCUSDT"); mkdirSync(klineDirectory, { recursive: true }); mkdirSync(bboDirectory, { recursive: true });
      archive(join(klineDirectory, "BTCUSDT-1h-2023-05.zip"), `open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n${juneStartMs - H},100,101,99,100,7,${juneStartMs - 1},700,4,3,300,0\n`);
      // The verified Binance Vision May-2023 archive has one boundary-tail row
      // at the next month's first millisecond. It must be ignored rather than
      // becoming a future carry for June's first canonical mark.
      archive(join(bboDirectory, "BTCUSDT-bookTicker-2023-05.zip"), `update_id,best_bid_price,best_bid_qty,best_ask_price,best_ask_qty,transaction_time,event_time\n1,100,2,101,3,${juneStartMs - 1_000},${juneStartMs - 1_000}\n99,1000,20,1001,20,${juneStartMs + 1},${juneStartMs + 1}\n`);
      archive(join(bboDirectory, "BTCUSDT-bookTicker-2023-06.zip"), `update_id,best_bid_price,best_bid_qty,best_ask_price,best_ask_qty,transaction_time,event_time\n2,101,4,102,5,${juneStartMs + 8},${juneStartMs + 8}\n`);
      const coverage = { startMs: juneStartMs, endMs: juneStartMs + H, symbols: ["BTCUSDT"], cadenceMs: H }; const bundle = inspectArchiveBundle({ root, include: (path) => (path.startsWith("bookTicker/") || path.startsWith("klines/")) && (path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM")) });
      const provenance = { provenanceType: "EXCHANGE_HISTORICAL_EXPORT" as const, provider: "Binance Vision", exchange: "BINANCE_USD_M", datasetId: "monthly-bookticker-boundary-fixture", retrievedAtMs: 1, rawFileHash: bundle.archiveBundleHash, schemaVersion: "binance-vision-bookTicker-csv-v1", generationToolSha: "abcdef0" };
      const [row] = (await importBinanceVisionUsdMRawBookTickerLiquidityArchive({ root, expectedCoverage: coverage, candleRows: [{ symbol: "BTCUSDT", openTimeMs: juneStartMs - H, closeTimeMs: juneStartMs - 1, volume: 7, sourceHash: "prior-candle" }] as never[], maxQuoteAgeMs: H, source: "Binance Vision BBO boundary", sourceProvenance: provenance, generatedAtMs: 1, generationSha: "abcdef0" })).rows;
      expect(row).toMatchObject({ asOfMs: juneStartMs, volume: 7, liquidityNotional: 200 });
      archive(join(bboDirectory, "BTCUSDT-bookTicker-2023-05.zip"), `update_id,best_bid_price,best_bid_qty,best_ask_price,best_ask_qty,transaction_time,event_time\n1,100,2,101,3,${juneStartMs - 1_000},${juneStartMs - 1_000}\n99,1000,20,1001,20,${juneStartMs + 1_001},${juneStartMs + 1_001}\n`);
      const invalidBundle = inspectArchiveBundle({ root, include: (path) => (path.startsWith("bookTicker/") || path.startsWith("klines/")) && (path.endsWith(".zip") || path.endsWith(".zip.CHECKSUM")) });
      await expect(importBinanceVisionUsdMRawBookTickerLiquidityArchive({ root, expectedCoverage: coverage, candleRows: [{ symbol: "BTCUSDT", openTimeMs: juneStartMs - H, closeTimeMs: juneStartMs - 1, volume: 7, sourceHash: "prior-candle" }] as never[], maxQuoteAgeMs: H, source: "Binance Vision BBO boundary", sourceProvenance: { ...provenance, rawFileHash: invalidBundle.archiveBundleHash }, generatedAtMs: 1, generationSha: "abcdef0" })).rejects.toThrow("FOUNDRY_BINANCE_VISION_BOOKTICKER_PARSE_INVALID");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

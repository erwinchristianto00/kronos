import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { importBinanceCmsBoundedUsdMLifecycle } from "../../src/research/foundry/binance-cms-lifecycle-adapter.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const writeJson = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value), "utf8"); };
const launchCode = "360036964392";

function writeCorpus(input: { root: string; catalogId: 48 | 161; name: string; schemaVersion: "KronosBinanceCmsLifecycleRaw/v1" | "KronosBinanceCmsLifecycleRaw/v2"; articles: Array<{ id: number; code: string; title: string; releaseDate: number; body?: string; }>; allDetails: boolean; }) {
  const pagePath = `pages/catalog-${input.catalogId}-page-0001.json`;
  writeJson(join(input.root, pagePath), { code: "000000", success: true, data: { catalogs: [{ catalogId: input.catalogId, catalogName: input.name, total: input.articles.length, articles: input.articles.map(({ body: _body, ...article }) => article) }] } });
  for (const article of input.articles) if (input.allDetails || article.body !== undefined) writeJson(join(input.root, `details/${article.code}.json`), { code: "000000", data: { id: article.id, title: article.title, body: article.body ?? "not relevant", publishDate: article.releaseDate } });
  const filePaths = [pagePath, ...input.articles.filter((article) => input.allDetails || article.body !== undefined).map((article) => `details/${article.code}.json`)].sort();
  const requests = filePaths.map((relativePath) => { const bytes = readFileSync(join(input.root, relativePath)); return { relativePath, url: `https://www.binance.com/bapi/${relativePath}`, httpStatus: 200, retrievedAtMs: 250, sizeBytes: bytes.length, fileHash: hash(bytes) }; });
  const archiveBundleHash = hash(JSON.stringify(requests.map(({ fileHash, relativePath }) => ({ fileHash, relativePath }))));
  writeJson(join(input.root, "acquisition-manifest.json"), { schemaVersion: input.schemaVersion, status: "RAW_CATALOG_ACQUIRED_NOT_A_TIMELINE", provider: "Binance", exchange: "BINANCE_USDM", datasetId: `binance-cms-public-announcements-catalog-${input.catalogId}`, catalog: { catalogId: input.catalogId, catalogName: input.name, articleCount: input.articles.length, pageCount: 1, pageSize: 10 }, generation: { generationToolSha: "abcdef0", generatedAtMs: 250 }, requests, archiveBundleHash, ...(input.schemaVersion === "KronosBinanceCmsLifecycleRaw/v2" ? { detailCoverage: { mode: input.allDetails ? "ALL_CATALOG_ARTICLES" : "FUTURES_TITLE_CANDIDATES", detailArticleCount: input.allDetails ? input.articles.length : 0 } } : {}) });
}

function fixture(input: { delistingBody?: string; allDelistingDetails?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cms-lifecycle-")); const launchRoot = join(root, "launch"); const delistingRoot = join(root, "delisting");
  writeCorpus({ root: launchRoot, catalogId: 48, name: "New Cryptocurrency Listing", schemaVersion: "KronosBinanceCmsLifecycleRaw/v1", allDetails: false, articles: [{ id: 19661, code: launchCode, title: "Binance Futures Launches ETH/USDT Perpetual Contract - Up to 50x Leverage", releaseDate: 10, body: "Binance Futures has launched its second perpetual contract, ETH/USDT. How to switch from BTC/USDT contract to ETH/USDT contract." }] });
  writeCorpus({ root: delistingRoot, catalogId: 161, name: "Delisting", schemaVersion: "KronosBinanceCmsLifecycleRaw/v2", allDetails: input.allDelistingDetails ?? true, articles: [{ id: 1, code: "delist-1", title: "Binance Will Delist Other Pair", releaseDate: 50, body: input.delistingBody ?? "unrelated pair only" }] });
  return { root, launchRoot, delistingRoot };
}

describe("Binance CMS bounded USD-M lifecycle adapter", () => {
  it("uses official launch plus full Delisting bodies without candle or current-state inference", () => {
    const source = fixture();
    try {
      const result = importBinanceCmsBoundedUsdMLifecycle({ launchRoot: source.launchRoot, delistingRoot: source.delistingRoot, expectedCoverage: { startMs: 100, endMs: 200, symbols: ["BTCUSDT", "ETHUSDT"], cadenceMs: 100 }, generatedAtMs: 250, generationSha: "abcdef0" });
      expect(result.listing.canonicalRows.map((row) => [row.symbol, row.status, row.effectiveTimeMs, row.validUntilMs])).toEqual([["BTCUSDT", "LISTED", 10, 199], ["ETHUSDT", "LISTED", 10, 199]]);
      expect(result.futuresAvailability.canonicalRows.map((row) => [row.symbol, row.available])).toEqual([["BTCUSDT", true], ["ETHUSDT", true]]);
      expect(result.listing.manifest.sourceProvenance.rawFileHash).toBe(result.sourceArchiveBundle.archiveBundleHash);
    } finally { rmSync(source.root, { recursive: true, force: true }); }
  });

  it("fails closed for incomplete full-detail evidence or a matching historical delisting body", () => {
    const missing = fixture({ allDelistingDetails: false }); const matching = fixture({ delistingBody: "The BTC/USDT perpetual contract will be delisted." });
    try {
      const input = (source: ReturnType<typeof fixture>) => ({ launchRoot: source.launchRoot, delistingRoot: source.delistingRoot, expectedCoverage: { startMs: 100, endMs: 200, symbols: ["BTCUSDT", "ETHUSDT"], cadenceMs: 100 }, generatedAtMs: 250, generationSha: "abcdef0" });
      expect(() => importBinanceCmsBoundedUsdMLifecycle(input(missing))).toThrow("FOUNDRY_BINANCE_CMS_FULL_DETAIL_COVERAGE_REQUIRED");
      expect(() => importBinanceCmsBoundedUsdMLifecycle(input(matching))).toThrow("FOUNDRY_BINANCE_CMS_DELISTING_EVENT_REQUIRES_INTERPRETATION_BTCUSDT_delist-1");
    } finally { rmSync(missing.root, { recursive: true, force: true }); rmSync(matching.root, { recursive: true, force: true }); }
  });
});

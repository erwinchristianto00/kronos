import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { tournamentHash } from "../contract/tournament-contract.js";
import { type ArchiveBundleFile, type ArchiveBundleIdentity, inspectArchiveBundle } from "./archive-bundle.js";
import { type FoundryExpectedCoverage } from "./derived-coverage.js";
import { buildAuthoritativeTimelineArtifact } from "./tier1-pit-artifacts.js";

const HASH = /^[a-f0-9]{64}$/;
const LAUNCH_ARTICLE_CODE = "360036964392";
const CMS_LIFECYCLE_POLICY_VERSION = "binance-cms-bounded-usdm-btc-eth-lifecycle-v1";

interface CmsRequest { relativePath: string; retrievedAtMs: number; sizeBytes: number; fileHash: string; }
interface CmsArticle { id: number; code: string; title: string; releaseDate: number; }
interface CmsRawManifest {
  schemaVersion: "KronosBinanceCmsLifecycleRaw/v1" | "KronosBinanceCmsLifecycleRaw/v2";
  status: "RAW_CATALOG_ACQUIRED_NOT_A_TIMELINE";
  provider: "Binance";
  exchange: "BINANCE_USDM";
  datasetId: string;
  catalog: { catalogId: number; catalogName: string; articleCount: number; pageCount: number; pageSize: number; };
  generation: { generationToolSha: string; generatedAtMs: number; };
  requests: CmsRequest[];
  archiveBundleHash: string;
  detailCoverage?: { mode: "ALL_CATALOG_ARTICLES" | "FUTURES_TITLE_CANDIDATES"; detailArticleCount: number; };
}
interface CmsCatalogPage { data?: { catalogs?: Array<{ catalogId?: number; catalogName?: string; total?: number; articles?: CmsArticle[]; }> }; }
interface CmsDetail { code?: string; data?: { id?: number; title?: string; body?: string; publishDate?: number; }; }
interface LoadedCmsCorpus { manifest: CmsRawManifest; manifestFileHash: string; rawBundle: ArchiveBundleIdentity; articleByCode: ReadonlyMap<string, CmsArticle>; detailByCode: ReadonlyMap<string, CmsDetail["data"]>; watermarkMs: number; }

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const cmsRawBundleHash = (files: readonly ArchiveBundleFile[]): string => sha256(JSON.stringify(files.slice().sort((left, right) => left.relativePath.localeCompare(right.relativePath)).map((file) => ({ fileHash: file.fileHash, relativePath: file.relativePath }))));

function canonicalBundle(files: readonly ArchiveBundleFile[]): ArchiveBundleIdentity {
  const sorted = files.slice().sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (!sorted.length || sorted.some((file, index) => !file.relativePath || !HASH.test(file.fileHash) || (index > 0 && sorted[index - 1]!.relativePath >= file.relativePath))) throw new Error("FOUNDRY_BINANCE_CMS_ARCHIVE_FILES_INVALID");
  return { version: "archive-bundle-v1", fileCount: sorted.length, files: sorted, archiveBundleHash: sha256(sorted.map((file) => `${file.relativePath}:${file.fileHash}`).join("\n")) };
}

function parsedFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`FOUNDRY_BINANCE_CMS_JSON_INVALID_${path}`); }
}

function assertRawManifest(value: unknown): asserts value is CmsRawManifest {
  const manifest = value as Partial<CmsRawManifest>;
  if (!manifest || (manifest.schemaVersion !== "KronosBinanceCmsLifecycleRaw/v1" && manifest.schemaVersion !== "KronosBinanceCmsLifecycleRaw/v2") || manifest.status !== "RAW_CATALOG_ACQUIRED_NOT_A_TIMELINE" || manifest.provider !== "Binance" || manifest.exchange !== "BINANCE_USDM" || !manifest.datasetId || !manifest.catalog || !Number.isInteger(manifest.catalog.catalogId) || !manifest.catalog.catalogName || !Number.isInteger(manifest.catalog.articleCount) || manifest.catalog.articleCount <= 0 || !Array.isArray(manifest.requests) || !HASH.test(manifest.archiveBundleHash ?? "") || !manifest.generation || !Number.isInteger(manifest.generation.generatedAtMs) || !manifest.generation.generationToolSha) throw new Error("FOUNDRY_BINANCE_CMS_MANIFEST_INVALID");
  const paths = new Set<string>();
  if (manifest.requests.some((entry) => !entry || !entry.relativePath || entry.relativePath === "acquisition-manifest.json" || paths.has(entry.relativePath) || (paths.add(entry.relativePath), !Number.isInteger(entry.retrievedAtMs) || entry.retrievedAtMs < 0 || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0 || !HASH.test(entry.fileHash)))) throw new Error("FOUNDRY_BINANCE_CMS_MANIFEST_REQUEST_INVALID");
}

function loadCmsCorpus(input: { root: string; catalogId: number; requireAllDetails: boolean }): LoadedCmsCorpus {
  const root = resolve(input.root); const manifestPath = resolve(root, "acquisition-manifest.json"); const manifest = parsedFile(manifestPath); assertRawManifest(manifest);
  if (manifest.catalog.catalogId !== input.catalogId || manifest.datasetId !== `binance-cms-public-announcements-catalog-${input.catalogId}`) throw new Error("FOUNDRY_BINANCE_CMS_CATALOG_IDENTITY_INVALID");
  const inspected = inspectArchiveBundle({ root, include: () => true }); const actualByPath = new Map(inspected.files.map((file) => [file.relativePath, file]));
  const expectedPaths = manifest.requests.map((entry) => entry.relativePath).sort(); const actualPayloadPaths = inspected.files.map((file) => file.relativePath).filter((path) => path !== "acquisition-manifest.json").sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPayloadPaths)) throw new Error("FOUNDRY_BINANCE_CMS_RAW_FILES_CONFLICT");
  const requestFiles = manifest.requests.map((entry) => {
    const actual = actualByPath.get(entry.relativePath); const bytes = readFileSync(resolve(root, entry.relativePath));
    if (!actual || actual.fileHash !== entry.fileHash || bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.fileHash) throw new Error(`FOUNDRY_BINANCE_CMS_RAW_FILE_HASH_INVALID_${entry.relativePath}`);
    return { relativePath: entry.relativePath, fileHash: entry.fileHash };
  });
  if (cmsRawBundleHash(requestFiles) !== manifest.archiveBundleHash) throw new Error("FOUNDRY_BINANCE_CMS_RAW_BUNDLE_HASH_INVALID");
  const rawBundle = canonicalBundle(requestFiles);
  const articleByCode = new Map<string, CmsArticle>(); const detailByCode = new Map<string, CmsDetail["data"]>();
  for (const request of manifest.requests) {
    if (request.relativePath.startsWith("pages/")) {
      const page = parsedFile(resolve(root, request.relativePath)) as CmsCatalogPage; const catalogs = page.data?.catalogs;
      if (!catalogs || catalogs.length !== 1 || catalogs[0]?.catalogId !== input.catalogId || catalogs[0]?.catalogName !== manifest.catalog.catalogName || catalogs[0]?.total !== manifest.catalog.articleCount || !Array.isArray(catalogs[0]?.articles)) throw new Error(`FOUNDRY_BINANCE_CMS_PAGE_INVALID_${request.relativePath}`);
      for (const article of catalogs[0].articles) {
        if (!Number.isInteger(article.id) || article.id <= 0 || !article.code || !article.title || !Number.isInteger(article.releaseDate) || article.releaseDate <= 0 || articleByCode.has(article.code)) throw new Error(`FOUNDRY_BINANCE_CMS_ARTICLE_INVALID_${request.relativePath}`);
        articleByCode.set(article.code, article);
      }
    }
  }
  if (articleByCode.size !== manifest.catalog.articleCount) throw new Error("FOUNDRY_BINANCE_CMS_PAGE_COVERAGE_INVALID");
  for (const request of manifest.requests) {
    if (!request.relativePath.startsWith("details/")) continue;
    const code = request.relativePath.slice("details/".length, -".json".length); const detail = parsedFile(resolve(root, request.relativePath)) as CmsDetail; const article = articleByCode.get(code); const data = detail.data;
    if (!article || detail.code !== "000000" || !data || data.id !== article.id || data.title !== article.title || typeof data.body !== "string" || detailByCode.has(code)) throw new Error(`FOUNDRY_BINANCE_CMS_DETAIL_INVALID_${request.relativePath}`);
    detailByCode.set(code, data);
  }
  if (input.requireAllDetails && (manifest.detailCoverage?.mode !== "ALL_CATALOG_ARTICLES" || manifest.detailCoverage.detailArticleCount !== manifest.catalog.articleCount || detailByCode.size !== articleByCode.size)) throw new Error("FOUNDRY_BINANCE_CMS_FULL_DETAIL_COVERAGE_REQUIRED");
  const watermarkMs = Math.max(...manifest.requests.map((request) => request.retrievedAtMs));
  if (!Number.isSafeInteger(watermarkMs)) throw new Error("FOUNDRY_BINANCE_CMS_WATERMARK_INVALID");
  const manifestFileHash = actualByPath.get("acquisition-manifest.json")?.fileHash; if (!manifestFileHash) throw new Error("FOUNDRY_BINANCE_CMS_MANIFEST_FILE_MISSING");
  return { manifest, manifestFileHash, rawBundle, articleByCode, detailByCode, watermarkMs };
}

function combinedArchive(launch: LoadedCmsCorpus, delisting: LoadedCmsCorpus): ArchiveBundleIdentity {
  const files = [
    { relativePath: "launch/acquisition-manifest.json", fileHash: launch.manifestFileHash },
    ...launch.rawBundle.files.map((file) => ({ relativePath: `launch/${file.relativePath}`, fileHash: file.fileHash })),
    { relativePath: "delisting/acquisition-manifest.json", fileHash: delisting.manifestFileHash },
    ...delisting.rawBundle.files.map((file) => ({ relativePath: `delisting/${file.relativePath}`, fileHash: file.fileHash })),
  ];
  return canonicalBundle(files);
}

function matchesSymbol(body: string, symbol: string): boolean {
  const expression = symbol === "BTCUSDT" ? /BTC[\s/_-]*USDT/i : /ETH[\s/_-]*USDT/i;
  return expression.test(body);
}

/** Builds only a bounded interval supported by official launch and full Delisting evidence. */
export function importBinanceCmsBoundedUsdMLifecycle(input: { launchRoot: string; delistingRoot: string; expectedCoverage: FoundryExpectedCoverage; generatedAtMs: number; generationSha: string }): { listing: ReturnType<typeof buildAuthoritativeTimelineArtifact>; futuresAvailability: ReturnType<typeof buildAuthoritativeTimelineArtifact>; sourceArchiveBundle: ArchiveBundleIdentity; } {
  const symbols = input.expectedCoverage.symbols.slice().sort(); if (JSON.stringify(symbols) !== JSON.stringify(["BTCUSDT", "ETHUSDT"])) throw new Error("FOUNDRY_BINANCE_CMS_SYMBOL_SCOPE_UNSUPPORTED");
  const launch = loadCmsCorpus({ root: input.launchRoot, catalogId: 48, requireAllDetails: false }); const delisting = loadCmsCorpus({ root: input.delistingRoot, catalogId: 161, requireAllDetails: true });
  const launchArticle = launch.articleByCode.get(LAUNCH_ARTICLE_CODE); const launchDetail = launch.detailByCode.get(LAUNCH_ARTICLE_CODE);
  const launchBody = launchDetail?.body;
  if (!launchArticle || !launchDetail || typeof launchBody !== "string" || launchArticle.title !== "Binance Futures Launches ETH/USDT Perpetual Contract - Up to 50x Leverage" || !launchBody.includes("has launched its second perpetual contract") || !matchesSymbol(launchBody, "ETHUSDT") || !matchesSymbol(launchBody, "BTCUSDT")) throw new Error("FOUNDRY_BINANCE_CMS_LAUNCH_EVIDENCE_INVALID");
  if (launchArticle.releaseDate > input.expectedCoverage.startMs || delisting.watermarkMs < input.expectedCoverage.endMs) throw new Error("FOUNDRY_BINANCE_CMS_RANGE_NOT_BOUNDED");
  for (const symbol of symbols) {
    for (const [code, detail] of delisting.detailByCode) {
      const article = delisting.articleByCode.get(code)!;
      if (article.releaseDate < input.expectedCoverage.endMs && matchesSymbol(`${article.title}\n${detail?.body ?? ""}`, symbol)) throw new Error(`FOUNDRY_BINANCE_CMS_DELISTING_EVENT_REQUIRES_INTERPRETATION_${symbol}_${code}`);
    }
  }
  const sourceArchiveBundle = combinedArchive(launch, delisting); const sourceProvenance = { provenanceType: "EXCHANGE_HISTORICAL_EXPORT" as const, provider: "Binance", exchange: "BINANCE_USDM", datasetId: CMS_LIFECYCLE_POLICY_VERSION, retrievedAtMs: Math.max(launch.watermarkMs, delisting.watermarkMs), rawFileHash: sourceArchiveBundle.archiveBundleHash, schemaVersion: `${launch.manifest.schemaVersion}+${delisting.manifest.schemaVersion}`, generationToolSha: input.generationSha };
  const sourceHash = tournamentHash({ policyVersion: CMS_LIFECYCLE_POLICY_VERSION, launchArticleCode: LAUNCH_ARTICLE_CODE, launchArticleReleaseDate: launchArticle.releaseDate, launchRawBundleHash: launch.rawBundle.archiveBundleHash, delistingRawBundleHash: delisting.rawBundle.archiveBundleHash, delistingWatermarkMs: delisting.watermarkMs, symbols });
  const rows = symbols.map((symbol) => ({ symbol, effectiveTimeMs: launchArticle.releaseDate, validUntilMs: input.expectedCoverage.endMs - 1, sourceHash }));
  return {
    listing: buildAuthoritativeTimelineArtifact({ artifactKind: "LISTING_DELISTING_TIMELINE", schemaVersion: "v2", source: "binance-cms-launch-plus-full-delisting", sourceProvenance, archiveBundle: sourceArchiveBundle, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows: rows.map((row) => ({ ...row, status: "LISTED" })) }),
    futuresAvailability: buildAuthoritativeTimelineArtifact({ artifactKind: "FUTURES_AVAILABILITY_TIMELINE", schemaVersion: "v2", source: "binance-cms-launch-plus-full-delisting", sourceProvenance, archiveBundle: sourceArchiveBundle, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha, expectedCoverage: input.expectedCoverage, rows: rows.map((row) => ({ ...row, available: true })) }),
    sourceArchiveBundle,
  };
}

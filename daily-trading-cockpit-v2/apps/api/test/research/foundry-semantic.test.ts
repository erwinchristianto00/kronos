import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertCandlesCoverCanonicalClock, buildCanonicalClock } from "../../src/research/foundry/canonical-clock.js";
import { assertCompleteFoundryArtifact, buildFoundryArtifactManifest } from "../../src/research/foundry/artifact-schema.js";
import { importLocalBinanceCandleArchive } from "../../src/research/foundry/local-binance-archive-adapter.js";
import { persistFoundryArtifact } from "../../src/research/foundry/artifact-store.js";
import { buildTier1CapabilityReport } from "../../src/research/foundry/tier1-capability.js";
import { FOUNDRY_SCHEMA_V1, validateFoundryRows } from "../../src/research/foundry/semantic-validators.js";
import { fixtureSourceProvenance } from "../../src/research/foundry/source-provenance.js";
import { PointInTimeUniverse } from "../../src/research/universe/point-in-time-universe.js";
import { assertEligibilityTimelineConsistency } from "../../src/research/foundry/cross-artifact-validator.js";
import { readArchiveBundle } from "../../src/research/foundry/archive-bundle.js";

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
    const listing = validateFoundryRows("LISTING_DELISTING_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, status: "DELISTED", sourceHash: "s" }]);
    const futures = validateFoundryRows("FUTURES_AVAILABILITY_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: 0, available: false, sourceHash: "s" }]);
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
});

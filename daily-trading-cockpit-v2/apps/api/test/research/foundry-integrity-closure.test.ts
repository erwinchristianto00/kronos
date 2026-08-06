import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { buildFoundryArtifact } from "../../src/research/foundry/artifact-schema.js";
import { loadFoundryArtifact, persistFoundryArtifact } from "../../src/research/foundry/artifact-store.js";
import { assertCandlesCoverCanonicalClock, buildCanonicalClock } from "../../src/research/foundry/canonical-clock.js";
import { deriveFoundryCoverage } from "../../src/research/foundry/derived-coverage.js";
import { alignFundingSettlements } from "../../src/research/foundry/funding-schedule.js";
import { EffectiveStateTimeline } from "../../src/research/foundry/stateful-timeline.js";
import { FOUNDRY_SCHEMA_V1, validateFoundryRows } from "../../src/research/foundry/semantic-validators.js";
import { PointInTimeUniverse } from "../../src/research/universe/point-in-time-universe.js";

const H = 3_600_000;
const schedule = { schemaVersion: "v1" as const, symbol: "BTCUSDT", kind: "UTC_8H_BOUNDARIES" as const, source: "exchange-schedule", sourceHash: "schedule", alignmentToleranceMs: 60_000 };
const coverage = { startMs: 0, endMs: 16 * H, symbols: ["BTCUSDT"], fundingSchedules: [schedule] };
const funding = (canonicalSettlementTimeMs: number, observedSettlementTimeMs = canonicalSettlementTimeMs) => ({ symbol: "BTCUSDT", canonicalSettlementTimeMs, observedSettlementTimeMs, alignmentOffsetMs: observedSettlementTimeMs - canonicalSettlementTimeMs, scheduleSourceHash: "schedule", fundingIntervalMs: 8 * H, rate: 0.001, sourceHash: "funding" });
const candle = (time: number) => ({ symbol: "BTCUSDT", openTimeMs: time, closeTimeMs: time + H - 1, open: 100, high: 101, low: 99, close: 100, volume: 1, sourceHash: "candle" });
const universe = new PointInTimeUniverse([{ asOfMs: 0, eligibleSymbols: ["BTCUSDT"], sourceHash: "universe", evidence: { listedThen: true, sufficientHistoryThen: true, liquidityVolumeEligibleThen: true, spreadEligibleThen: true, futuresAvailableThen: true, delistingCheckedThen: true } }]);

describe("Foundry integrity closure", () => {
  it("aligns real settlement boundary timestamps rather than anchoring generic cadence at first arrival", () => {
    const rows = validateFoundryRows("FUNDING_SETTLEMENTS", FOUNDRY_SCHEMA_V1, [funding(0, 8), funding(8 * H, 8 * H + 8)]);
    const aligned = alignFundingSettlements({ rows, metadata: schedule, startMs: 0, endMs: coverage.endMs });
    expect(aligned.missingSettlementTimesMs).toEqual([]);
    expect(aligned.excessSettlementTimesMs).toEqual([]);
    const completeRows = validateFoundryRows("FUNDING_SETTLEMENTS", FOUNDRY_SCHEMA_V1, [funding(0, 8)]);
    const partial = deriveFoundryCoverage("FUNDING_SETTLEMENTS", completeRows, { ...coverage, startMs: 0, endMs: 16 * H });
    expect(partial.missingIntervals).toHaveLength(1);
    expect(() => deriveFoundryCoverage("FUNDING_SETTLEMENTS", completeRows, { startMs: 0, endMs: 16 * H, symbols: ["BTCUSDT"], cadenceMs: 8 * H })).toThrow("FOUNDRY_FUNDING_SCHEDULE_METADATA_MISSING");
  });

  it("carries pre-range state forward and rejects missing or contradictory initial state", () => {
    const timeline = new EffectiveStateTimeline([{ symbol: "BTCUSDT", effectiveTimeMs: H, value: "LISTED" as const, sourceHash: "listing" }, { symbol: "BTCUSDT", effectiveTimeMs: 3 * H, value: "DELISTED" as const, sourceHash: "listing" }]);
    expect(timeline.at("BTCUSDT", 2 * H).value).toBe("LISTED");
    expect(() => timeline.at("ETHUSDT", 2 * H)).toThrow("FOUNDRY_TIMELINE_INITIAL_STATE_MISSING");
    expect(() => new EffectiveStateTimeline([{ symbol: "BTCUSDT", effectiveTimeMs: 0, value: true, sourceHash: "a" }, { symbol: "BTCUSDT", effectiveTimeMs: H, value: true, sourceHash: "b" }])).toThrow("FOUNDRY_TIMELINE_REDUNDANT_TRANSITION");
    expect(() => new EffectiveStateTimeline([{ symbol: "BTCUSDT", effectiveTimeMs: H, value: true, sourceHash: "a" }, { symbol: "BTCUSDT", effectiveTimeMs: H, value: false, sourceHash: "b" }])).toThrow("FOUNDRY_TIMELINE_CONTRADICTORY_TRANSITION");
    const listingRows = validateFoundryRows("LISTING_DELISTING_TIMELINE", FOUNDRY_SCHEMA_V1, [{ symbol: "BTCUSDT", effectiveTimeMs: H, status: "LISTED", sourceHash: "listing" }]);
    expect(deriveFoundryCoverage("LISTING_DELISTING_TIMELINE", listingRows, { startMs: 2 * H, endMs: 8 * H, symbols: ["BTCUSDT"] }).missingIntervals).toEqual([]);
    expect(deriveFoundryCoverage("LISTING_DELISTING_TIMELINE", listingRows, { startMs: 0, endMs: 8 * H, symbols: ["BTCUSDT"] }).missingIntervals[0]?.reason).toBe("BTCUSDT:INITIAL_STATE_MISSING");
  });

  it("persists canonical sorted rows only and detects row or manifest tampering", () => {
    const built = buildFoundryArtifact({ artifactKind: "COMPLETED_CANDLES", schemaVersion: FOUNDRY_SCHEMA_V1, source: "fixture", units: { price: "USDT", volume: "base" }, generatedAtMs: 1, generationSha: "sha", expectedCoverage: { startMs: 0, endMs: 2 * H, symbols: ["BTCUSDT"], cadenceMs: H }, rows: [candle(0), candle(H)] });
    const root = mkdtempSync(join(tmpdir(), "foundry-integrity-"));
    try {
      const directory = persistFoundryArtifact({ rootDir: root, manifest: built.manifest, rows: built.canonicalRows });
      expect(loadFoundryArtifact({ rootDir: root, semanticManifestHash: built.manifest.semanticManifestHash }).rows).toEqual(built.canonicalRows);
      expect(() => persistFoundryArtifact({ rootDir: root, manifest: built.manifest, rows: [...built.canonicalRows].reverse() })).toThrow("FOUNDRY_TIMESTAMPS_NOT_MONOTONIC");
      writeFileSync(join(directory, "rows.json"), "[]\n");
      expect(() => loadFoundryArtifact({ rootDir: root, semanticManifestHash: built.manifest.semanticManifestHash })).toThrow("FOUNDRY_ROWS_EMPTY_OR_INVALID");
      writeFileSync(join(directory, "rows.json"), `${JSON.stringify(built.canonicalRows)}\n`);
      const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { source: string };
      writeFileSync(join(directory, "manifest.json"), `${JSON.stringify({ ...manifest, source: "tampered" })}\n`);
      expect(() => loadFoundryArtifact({ rootDir: root, semanticManifestHash: built.manifest.semanticManifestHash })).toThrow("FOUNDRY_ARTIFACT_SEMANTIC_IDENTITY_MISMATCH");
      writeFileSync(join(directory, "manifest.json"), `${JSON.stringify({ ...built.manifest, missingDataReport: ["tampered"] })}\n`);
      expect(() => loadFoundryArtifact({ rootDir: root, semanticManifestHash: built.manifest.semanticManifestHash })).toThrow("FOUNDRY_ARTIFACT_MANIFEST_DATA_REPORT_MISMATCH");
      expect(existsSync(directory)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("makes absence semantics fail closed while halt marks retain every NAV clock tick", () => {
    const clock = buildCanonicalClock({ startMs: 0, endMs: 2 * H, timeframeMs: H });
    expect(() => assertCandlesCoverCanonicalClock({ clock, candles: [candle(0), candle(H)], universe, absences: [{ symbol: "BTCUSDT", openTimeMs: H, reason: "HALTED", sourceHash: "halt", markPrice: 100, markPolicy: "LAST_VALID_CLOSE" }] })).toThrow("CANDLE_ABSENCE_CONFLICT");
    expect(() => assertCandlesCoverCanonicalClock({ clock, candles: [candle(0)], universe, absences: [{ symbol: "BTCUSDT", openTimeMs: H, reason: "NOT_LISTED", sourceHash: "absence" }] })).toThrow("NOT_LISTED_CONTRADICTS_UNIVERSE");
    expect(() => assertCandlesCoverCanonicalClock({ clock, candles: [candle(0)], universe, absences: [{ symbol: "BTCUSDT", openTimeMs: H, reason: "DATA_UNAVAILABLE", sourceHash: "absence" }] })).toThrow("DATA_UNAVAILABLE");
    expect(() => assertCandlesCoverCanonicalClock({ clock, candles: [candle(0)], universe, absences: [{ symbol: "BTCUSDT", openTimeMs: H, reason: "HALTED", sourceHash: "halt", markPrice: 100, markPolicy: "LAST_VALID_CLOSE" }] })).not.toThrow();
  });

  it("rejects zero prices and exact-duration violations", () => {
    expect(() => validateFoundryRows("COMPLETED_CANDLES", FOUNDRY_SCHEMA_V1, [{ ...candle(0), open: 0 }])).toThrow("FOUNDRY_INVALID_OPEN");
    expect(() => assertCandlesCoverCanonicalClock({ clock: buildCanonicalClock({ startMs: 0, endMs: H, timeframeMs: H }), candles: [{ ...candle(0), closeTimeMs: H - 2 }], universe })).toThrow("FOUNDRY_CANONICAL_CLOCK_CANDLE_IRREGULAR");
  });
});

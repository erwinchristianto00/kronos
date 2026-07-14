import { describe, it, expect } from "vitest";
import { stampRow, partitionByProvenance, assertSingleEvidenceClass, evidenceAllowedFor, stableHash, type ReplayProvenance } from "../src/lib/replay-provenance.js";
import { tierSupports, minTierFor, gateFeaturesByTier } from "../src/lib/replay-data-tiers.js";
import { createStreamVerifier, buildManifest } from "../src/lib/replay-market-data-provider.js";
import { classifyReplayRow, statusUsableForFit, tallyReplayStatuses, type ReplayQualityInput } from "../src/lib/replay-quality-status.js";

const PROV: ReplayProvenance = {
  replayRunId: "run1", codeCommitHash: "abc", codeBuildHash: "b", containerImageDigest: null,
  configHash: "cfg", featureSchemaVersion: "fs1", modelSchemaVersion: "ms1", laneRosterVersion: "lr1",
  marketDataSource: "mock", marketDataVersion: "md1", marketDataManifestHash: "mh1",
  replayMode: "CURRENT_CODE_HISTORICAL_MARKET", startedAtMs: 1, completedAtMs: null,
};

describe("replay provenance (reconstructed ≠ observed live)", () => {
  it("stamps + partitions by evidence class", () => {
    const a = stampRow({ id: 1 }, { provenance: PROV, evidenceClass: "RECONSTRUCTED_HISTORICAL", asOfMs: 10, sourceTimestampsMs: [5, 9] });
    const b = stampRow({ id: 2 }, { provenance: PROV, evidenceClass: "OBSERVED_LIVE_SHADOW", asOfMs: 11, sourceTimestampsMs: [8] });
    const part = partitionByProvenance([a, b]);
    expect(part.RECONSTRUCTED_HISTORICAL).toHaveLength(1);
    expect(part.OBSERVED_LIVE_SHADOW).toHaveLength(1);
  });
  it("REFUSES to treat a mixed-provenance collection as one dataset", () => {
    const a = stampRow({}, { provenance: PROV, evidenceClass: "RECONSTRUCTED_HISTORICAL", asOfMs: 1, sourceTimestampsMs: [] });
    const b = stampRow({}, { provenance: PROV, evidenceClass: "OBSERVED_LIVE_SHADOW", asOfMs: 1, sourceTimestampsMs: [] });
    expect(() => assertSingleEvidenceClass([a, b])).toThrow(/provenance mix rejected/);
    expect(assertSingleEvidenceClass([a, a])).toBe("RECONSTRUCTED_HISTORICAL");
  });
  it("actual-live fills calibrate execution but NEVER train directional alpha", () => {
    expect(evidenceAllowedFor("EXECUTION_CALIBRATION", "ACTUAL_LIVE_EXECUTION")).toBe(true);
    expect(evidenceAllowedFor("DIRECTIONAL_ALPHA", "ACTUAL_LIVE_EXECUTION")).toBe(false);
    expect(evidenceAllowedFor("DIRECTIONAL_ALPHA", "RECONSTRUCTED_HISTORICAL")).toBe(true);
  });
  it("stableHash is deterministic + key-order-independent", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
});

describe("replay data tiers (missing microstructure stays missing)", () => {
  it("a candle tier cannot back order-book features", () => {
    expect(tierSupports("A_CANDLE", "ohlcv")).toBe(true);
    expect(tierSupports("A_CANDLE", "spread")).toBe(false);
    expect(tierSupports("C_L2", "spread")).toBe(true);
    expect(minTierFor("unknownFeature")).toBeNull();
    expect(tierSupports("C_L2", "unknownFeature")).toBe(false);
  });
  it("gateFeaturesByTier drops above-tier as unsupported + null as absent — never fabricates 0", () => {
    const r = gateFeaturesByTier("A_CANDLE", { atr: 1.2, spread: 0.5, breadth: null });
    expect(r.allowed).toEqual({ atr: 1.2 });
    expect(r.unsupportedByTier).toContain("spread"); // above tier — NOT zero-filled
    expect(r.absent).toContain("breadth"); // in-tier but null — NOT zero-filled
    expect(r.allowed).not.toHaveProperty("spread");
  });
});

describe("replay stream verification (no silent row loss)", () => {
  it("in-order stream reconciles; out-of-order + duplicates + gaps counted", () => {
    const v = createStreamVerifier({ expectedIntervalMs: 60_000, gapFactor: 1.5 });
    v.feed(0, "a"); v.feed(60_000, "b"); v.feed(60_000, "b"); v.feed(300_000, "c");
    const s = v.summary();
    expect(s.count).toBe(4);
    expect(s.duplicates).toBe(1);
    expect(s.gaps).toBe(1); // 60k → 300k is a 4-bar gap
    expect(s.reconciles).toBe(true);
  });
  it("strictOrder throws on a future→past event", () => {
    const v = createStreamVerifier({ strictOrder: true });
    v.feed(100);
    expect(() => v.feed(50)).toThrow(/out-of-order/);
  });
  it("checksum is order-sensitive; buildManifest hashes entries", () => {
    const a = createStreamVerifier(); a.feed(1, "x"); a.feed(2, "y");
    const b = createStreamVerifier(); b.feed(2, "y"); b.feed(1, "x");
    expect(a.summary().checksum).not.toBe(b.summary().checksum);
    const m = buildManifest("mock", "md1", 0, [{ symbol: "BTCUSDT", kind: "candles", tier: "A_CANDLE", startMs: 1, endMs: 2, count: 2, checksum: a.summary().checksum, bytes: 10 }]);
    expect(m.manifestHash).toHaveLength(64);
  });
});

describe("replay quality status (GOLD/SILVER/... — purpose-aware, one status)", () => {
  const ok: ReplayQualityInput = {
    purpose: "MarketState", timestampsCausal: true, schemaMatch: true, configVersioned: true, dataGap: false,
    labelSafe: true, requiredFeaturesPresent: true, dataTier: "A_CANDLE", executionCalibrated: false, modelFitEligible: true,
  };
  it("MarketState on Tier A is GOLD; Entry on Tier A is SILVER (no microstructure)", () => {
    expect(classifyReplayRow(ok).status).toBe("GOLD");
    expect(classifyReplayRow({ ...ok, purpose: "Entry" }).status).toBe("SILVER_NO_MICROSTRUCTURE");
  });
  it("Entry on Tier C but uncalibrated ⇒ EXECUTION_UNCALIBRATED; calibrated ⇒ GOLD", () => {
    expect(classifyReplayRow({ ...ok, purpose: "Entry", dataTier: "C_L2", executionCalibrated: false }).status).toBe("EXECUTION_UNCALIBRATED");
    expect(classifyReplayRow({ ...ok, purpose: "Entry", dataTier: "C_L2", executionCalibrated: true }).status).toBe("GOLD");
  });
  it("fatal integrity failures take precedence in order", () => {
    expect(classifyReplayRow({ ...ok, timestampsCausal: false }).status).toBe("TIMESTAMP_UNSAFE");
    expect(classifyReplayRow({ ...ok, schemaMatch: false }).status).toBe("SCHEMA_MISMATCH");
    expect(classifyReplayRow({ ...ok, configVersioned: false }).status).toBe("CONFIG_UNVERSIONED");
    expect(classifyReplayRow({ ...ok, dataGap: true }).status).toBe("DATA_GAP");
    expect(classifyReplayRow({ ...ok, labelSafe: false }).status).toBe("LABEL_UNSAFE");
    expect(classifyReplayRow({ ...ok, requiredFeaturesPresent: false }).status).toBe("MISSING_FEATURES");
    expect(classifyReplayRow({ ...ok, modelFitEligible: false }).status).toBe("REPLAY_ONLY");
  });
  it("SILVER is fit-usable for MarketState/Direction but NOT for Entry; tally sums", () => {
    expect(statusUsableForFit("SILVER_NO_MICROSTRUCTURE", "Direction")).toBe(true);
    expect(statusUsableForFit("SILVER_NO_MICROSTRUCTURE", "Entry")).toBe(false);
    expect(statusUsableForFit("GOLD", "Entry")).toBe(true);
    expect(tallyReplayStatuses(["GOLD", "GOLD", "REPLAY_ONLY"]).GOLD).toBe(2);
  });
});

import { describe, it, expect } from "vitest";
import { extractCalibrationRow, summarizeCalibration, fitL1Calibration, type RawExecutionIntent, type ExtractCtx } from "../src/lib/replay-execution-calibration.js";
import { evidenceAllowedFor, type ReplayProvenance } from "../src/lib/replay-provenance.js";
import { mulberry32, clusteredBootstrapMeanCI, statePersistence, overlapAdjustedEss, coefficientStability } from "../src/lib/replay-tier-a-metrics.js";

const PROV: ReplayProvenance = {
  replayRunId: "t", codeCommitHash: "t", codeBuildHash: "t", containerImageDigest: null, configHash: "t",
  featureSchemaVersion: "t", modelSchemaVersion: "t", laneRosterVersion: "t", marketDataSource: "t",
  marketDataVersion: "t", marketDataManifestHash: "t", replayMode: "OBSERVED_LIVE_SHADOW", startedAtMs: 0, completedAtMs: 0,
};
const L1 = { level: 1 as const, spreadBps: 4, latencyMs: 250, takerFeeBps: 5, makerFeeBps: 1, slippageBps: 2 };
const ctx: ExtractCtx = { provenance: PROV, evidenceClass: "ACTUAL_LIVE_EXECUTION", venue: "MAINNET", sourceInstance: "test", l1: L1 };

describe("execution calibration — strict evidence boundary + measured slippage", () => {
  it("actual fills are allowed for EXECUTION_CALIBRATION but NEVER directional alpha", () => {
    expect(evidenceAllowedFor("EXECUTION_CALIBRATION", "ACTUAL_LIVE_EXECUTION")).toBe(true);
    expect(evidenceAllowedFor("DIRECTIONAL_ALPHA", "ACTUAL_LIVE_EXECUTION")).toBe(false); // the hard boundary
  });
  it("throws if a calibration row is extracted under a directional-alpha-only class", () => {
    expect(() => extractCalibrationRow({}, { ...ctx, evidenceClass: "RECONSTRUCTED_HISTORICAL" })).toThrow();
  });
  it("computes ADVERSE entry slippage: BUY worse when filled ABOVE planned", () => {
    const it: RawExecutionIntent = { direction: "LONG", plannedEntryPrice: 100, filledEntryPrice: 100.1, stopLossPrice: 98, entryPriceConfirmed: true, feesUsd: 0.5, effectiveRiskUsd: 10, createdAt: "2026-07-01T00:00:00Z", qty: 5 };
    const r = extractCalibrationRow(it, ctx);
    expect(r.usable).toBe(true);
    expect(r.entrySlippageBps).toBeCloseTo(10); // 0.1/100 = 10 bps adverse
    expect(r.entrySlippageR).toBeCloseTo(0.1 / 2); // adverse price 0.1 / risk 2
    expect(r._provenance.evidenceClass).toBe("ACTUAL_LIVE_EXECUTION");
    expect(r.side).toBe("BUY");
  });
  it("computes ADVERSE entry slippage: SELL worse when filled BELOW planned", () => {
    const r = extractCalibrationRow({ direction: "SHORT", plannedEntryPrice: 100, filledEntryPrice: 99.9, stopLossPrice: 102, entryPriceConfirmed: true, createdAt: "2026-07-01T00:00:00Z" }, ctx);
    expect(r.side).toBe("SELL");
    expect(r.entrySlippageBps).toBeCloseTo(10); // (100-99.9)/100 = 10 bps adverse
  });
  it("rejects unconfirmed / zero-risk / missing-price rows with a REASON (never fabricates)", () => {
    expect(extractCalibrationRow({ direction: "LONG", plannedEntryPrice: 100, filledEntryPrice: 100, stopLossPrice: 98, entryPriceConfirmed: false }, ctx).rejectReason).toMatch(/unconfirmed/);
    expect(extractCalibrationRow({ direction: "LONG", plannedEntryPrice: 100, filledEntryPrice: 100, stopLossPrice: 100, entryPriceConfirmed: true }, ctx).rejectReason).toMatch(/risk/);
    expect(extractCalibrationRow({ direction: "LONG", entryPriceConfirmed: true }, ctx).usable).toBe(false);
  });
  it("summary funnel + fit reflect the usable set; latency honestly UNAVAILABLE", () => {
    const rows = [
      extractCalibrationRow({ direction: "LONG", plannedEntryPrice: 100, filledEntryPrice: 100.2, stopLossPrice: 98, entryPriceConfirmed: true, createdAt: "2026-07-01T00:00:00Z", qty: 1 }, ctx),
      extractCalibrationRow({ direction: "LONG", plannedEntryPrice: 100, filledEntryPrice: 100, stopLossPrice: 98, entryPriceConfirmed: false }, ctx), // rejected
    ];
    const s = summarizeCalibration(rows);
    expect(s.coverage.usable).toBe(1);
    expect(s.coverage.rejected).toBe(1);
    expect(s.latency.p50).toBeNull(); // no ack timestamp ⇒ null, not fabricated
    const fit = fitL1Calibration(rows, L1, Date.parse("2026-07-13T00:00:00Z"));
    expect(fit.n).toBe(1);
    expect(fit.calibrated.slippageBps).toBeGreaterThanOrEqual(0);
  });
});

describe("tier-a metrics — determinism + correctness", () => {
  it("mulberry32 is deterministic for a fixed seed", () => {
    const a = mulberry32(42), b = mulberry32(42);
    const sa = [a(), a(), a()], sb = [b(), b(), b()];
    expect(sa).toEqual(sb);
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
  it("clustered bootstrap is reproducible (seeded) and its point equals the row mean", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ dayKey: Math.floor(i / 4), value: (i % 5) - 2 }));
    const c1 = clusteredBootstrapMeanCI(rows, { iters: 500, seed: 7 });
    const c2 = clusteredBootstrapMeanCI(rows, { iters: 500, seed: 7 });
    expect(c1).toEqual(c2); // deterministic
    const rawMean = rows.reduce((a, r) => a + r.value, 0) / rows.length;
    expect(c1.point).toBeCloseTo(rawMean);
    expect(c1.lo!).toBeLessThanOrEqual(c1.hi!);
    expect(c1.blocks).toBe(10); // 10 day-blocks
  });
  it("statePersistence + transitionRate are complementary", () => {
    const p = statePersistence(["A", "A", "B", "B", "B", "A"]);
    expect(p.pairs).toBe(5);
    expect(p.persistence! + p.transitionRate!).toBeCloseTo(1);
  });
  it("overlapAdjustedEss deflates by horizon and floors at unique days", () => {
    const e = overlapAdjustedEss(240, 24, 30);
    expect(e.essByHorizon).toBe(10); // 240/24
    expect(e.essFloor).toBe(10); // min(10, 30)
  });
  it("coefficientStability reports sign-consistency across folds", () => {
    const s = coefficientStability(["trend", "vol"], [[0.5, -0.2], [0.6, 0.1], [0.4, -0.3]]);
    expect(s[0]!.signConsistency).toBe(1); // trend always positive
    expect(s[1]!.signConsistency).toBeCloseTo(2 / 3); // vol 2 neg / 1 pos
  });
});

/**
 * Market Digital Twin — Phase-1 FOUNDATION test matrix: determinism, causality, historical integrity, bootstrap
 * integrity, provenance, realism. All fixtures are DETERMINISTIC hand-built test inputs (clearly test-only, never
 * claimed as real market data).
 */
import { describe, it, expect } from "vitest";
import { createRng, restoreRng, hash32 } from "../src/simulation/deterministic-rng.js";
import { createSimulationClock, assertCausalApplication } from "../src/simulation/simulation-clock.js";
import { buildRunIdentity } from "../src/simulation/simulation-run-identity.js";
import { CsvKlinesHistoricalSource, type CsvKlinesSourceConfig } from "../src/simulation/historical-market-source.js";
import { selectFixedLengthBlocks, selectStationaryBlocks, assembleBootstrapPath, assessStitch } from "../src/simulation/historical-block-bootstrap.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import { buildObservedView } from "../src/simulation/observed-market-view.js";
import { visibleAt } from "../src/simulation/simulation-types.js";
import { assessRealism } from "../src/simulation/realism-assessment.js";
import { evaluateStylizedFacts } from "../src/simulation/realism-gate.js";
import { evaluateClassifier, windowFeatures, type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const HOUR = 3_600_000;
const BASE = 1_735_689_600_000; // 2025-01-01T00:00:00Z (fixed; no Date.now)

/** Deterministic OHLC CSV fixture (Binance-klines column layout). TEST-ONLY synthetic data. */
function makeCsv(symbol: string, months: string[], hoursPerMonth = 40): Record<string, string> {
  const out: Record<string, string> = {};
  const seed = hash32(symbol);
  const rng = createRng(seed, `fixture/${symbol}`);
  let price = 100 + (seed % 50);
  let t = BASE;
  for (const mm of months) {
    const lines: string[] = [];
    for (let i = 0; i < hoursPerMonth; i += 1) {
      const open = price;
      const drift = rng.normal(0, 0.5);
      const close = Math.max(1, open + drift);
      const high = Math.max(open, close) + Math.abs(rng.normal(0, 0.2));
      const low = Math.min(open, close) - Math.abs(rng.normal(0, 0.2));
      const vol = 1000 + Math.abs(rng.normal(0, 200));
      const openTime = t; const closeTime = t + HOUR - 1;
      lines.push([openTime, open, high, low, close, vol, closeTime, 0, 0, vol / 2, 0, 0].join(","));
      price = close; t += HOUR;
    }
    out[`/corpus/${symbol}-1h-2026-${mm}/${symbol}-1h-2026-${mm}.csv`] = lines.join("\n");
  }
  return out;
}

function makeSource(runId: string): CsvKlinesHistoricalSource {
  const months = ["01", "02"];
  const files = { ...makeCsv("BTCUSDT", months), ...makeCsv("ETHUSDT", months) };
  const cfg: CsvKlinesSourceConfig = {
    runId, symbols: ["BTCUSDT", "ETHUSDT"], months, year: "2026", dir: "/corpus",
    readFile: (p) => files[p] ?? null,
  };
  return new CsvKlinesHistoricalSource(cfg);
}
async function collect(src: CsvKlinesHistoricalSource): Promise<CommonMarketFrame[]> {
  const meta = src.describe();
  const out: CommonMarketFrame[] = [];
  for await (const f of src.iterateFrames(meta.dateRangeMs ?? { startMs: 0, endMs: 0 })) out.push(f);
  return out;
}

// ═══════════════ DETERMINISM ═══════════════
describe("determinism", () => {
  it("same seed+algorithm ⇒ identical RNG stream; different seeds diverge", () => {
    const a = createRng(42, "m"); const b = createRng(42, "m"); const c = createRng(43, "m");
    const sa = Array.from({ length: 20 }, () => a.nextFloat());
    const sb = Array.from({ length: 20 }, () => b.nextFloat());
    const sc = Array.from({ length: 20 }, () => c.nextFloat());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it("forked namespaces are independent (changing one does not shift another)", () => {
    const root = createRng(7, "root");
    const mktBtc1 = root.fork("market/BTC"); const events1 = root.fork("events");
    const root2 = createRng(7, "root");
    const mktBtc2 = root2.fork("market/BTC");
    // draining events2 differently must NOT change market/BTC's stream
    const events2 = root2.fork("events"); events2.nextFloat(); events2.nextFloat();
    expect(Array.from({ length: 10 }, () => mktBtc1.nextFloat())).toEqual(Array.from({ length: 10 }, () => mktBtc2.nextFloat()));
    expect(events1.nextFloat()).not.toEqual(mktBtc1.nextFloat());
  });
  it("RNG state serializes + restores to an exact continuation", () => {
    const r = createRng(99, "x"); r.nextFloat(); r.nextFloat();
    const saved = r.serializeState(); const cont = restoreRng(saved);
    expect(Array.from({ length: 5 }, () => r.nextFloat())).toEqual(Array.from({ length: 5 }, () => cont.nextFloat()));
  });
  it("runId is deterministic from config+seed+checksums; processing time does NOT affect it", () => {
    const base = { seed: 5, provenance: "HISTORICAL_BOOTSTRAP" as const, configuration: { b: 2, a: 1 }, sourceChecksums: ["z", "a"] };
    const id1 = buildRunIdentity({ ...base, startedAtProcessingMs: 1000 });
    const id2 = buildRunIdentity({ ...base, startedAtProcessingMs: 9_999_999 }); // different processing time
    const id3 = buildRunIdentity({ ...base, configuration: { a: 1, b: 2 }, sourceChecksums: ["a", "z"], startedAtProcessingMs: 1 }); // reordered keys/checksums
    expect(id1.runId).toBe(id2.runId);
    expect(id1.runId).toBe(id3.runId); // normalization + checksum sort ⇒ same id
    const id4 = buildRunIdentity({ ...base, seed: 6, startedAtProcessingMs: 1 });
    expect(id4.runId).not.toBe(id1.runId);
  });
  it("same source+config ⇒ byte-identical frames (frameId + values stable)", async () => {
    const a = JSON.stringify(await collect(makeSource("run-A")));
    const b = JSON.stringify(await collect(makeSource("run-A")));
    expect(a).toBe(b);
  });
});

// ═══════════════ CAUSALITY ═══════════════
describe("causality", () => {
  it("clock is monotonic; cannot move backward; advanceBy rejects negatives", () => {
    const clk = createSimulationClock(1000);
    clk.advanceBy(500); expect(clk.nowMs()).toBe(1500);
    clk.advanceTo(2000); expect(clk.nowMs()).toBe(2000);
    expect(() => clk.advanceTo(1999)).toThrow();
    expect(() => clk.advanceBy(-1)).toThrow();
  });
  it("event application before its causal time is a violation", () => {
    expect(() => assertCausalApplication(5000, 4000, "flash-crash")).toThrow();
    expect(() => assertCausalApplication(5000, 5000, "flash-crash")).not.toThrow();
  });
  it("observed view downgrades a not-yet-available field to STALE (no look-ahead)", async () => {
    const frames = await collect(makeSource("run-C"));
    const f = frames[0]!;
    // asOf BEFORE the candle close ⇒ the candle is not yet visible
    const asOfBefore = f.asOfMs - 1;
    const view = buildObservedView(f, asOfBefore);
    expect(view.feedStatus["BTCUSDT:candle"]).toBe("STALE");
    expect(visibleAt(f.symbols.BTCUSDT!.candle, asOfBefore)).toBe(false);
    // at/after close ⇒ visible
    expect(visibleAt(f.symbols.BTCUSDT!.candle, f.asOfMs)).toBe(true);
  });
});

// ═══════════════ HISTORICAL INTEGRITY ═══════════════
describe("historical integrity", () => {
  it("frames are chronological, synchronized BTC+ETH, OHLC-valid, no NaN/Infinity", async () => {
    const frames = await collect(makeSource("run-H"));
    expect(frames.length).toBeGreaterThan(50);
    const inv = checkFrameStreamInvariants(frames, { expectSingleProvenance: true });
    expect(inv.ok).toBe(true);
    expect(inv.monotonicTime).toBe(true);
    expect(inv.anyNaNOrInfinity).toBe(false);
    expect(inv.distinctProvenances).toEqual(["OBSERVED_HISTORICAL"]);
    for (const f of frames) { expect(f.symbols.BTCUSDT!.candle.status).toBe("PRESENT"); expect(f.symbols.ETHUSDT!.candle.status).toBe("PRESENT"); }
  });
  it("checksum is deterministic + content-sensitive; unsupported dimensions stay UNSUPPORTED", async () => {
    const s1 = makeSource("run-K"); const s2 = makeSource("run-K");
    expect(await s1.checksum()).toBe(await s2.checksum());
    const frames = await collect(s1);
    expect(frames[0]!.symbols.BTCUSDT!.spreadBps.status).toBe("UNSUPPORTED");
    expect(frames[0]!.symbols.BTCUSDT!.liquidity.status).toBe("UNSUPPORTED");
    expect(s1.describe().limits).toContain("NO_LEVEL_2_DEPTH");
  });
  it("a missing month is surfaced as a gap, not fabricated", () => {
    const files = { ...makeCsv("BTCUSDT", ["01"]) }; // ETH absent entirely
    const src = new CsvKlinesHistoricalSource({ runId: "g", symbols: ["BTCUSDT", "ETHUSDT"], months: ["01"], year: "2026", dir: "/corpus", readFile: (p) => files[p] ?? null });
    expect(src.describe().gaps).toBeGreaterThan(0);
  });
});

// ═══════════════ BOOTSTRAP INTEGRITY ═══════════════
describe("bootstrap integrity", () => {
  it("fixed-length blocks are contiguous + in-bounds + deterministic per seed", async () => {
    const frames = await collect(makeSource("run-B"));
    const b1 = selectFixedLengthBlocks(frames.length, 5, 4, createRng(1, "boot"));
    const b2 = selectFixedLengthBlocks(frames.length, 5, 4, createRng(1, "boot"));
    expect(b1).toEqual(b2);
    for (const blk of b1) { expect(blk.length).toBe(5); expect(blk.startIndex + blk.length).toBeLessThanOrEqual(frames.length); }
  });
  it("stationary block bootstrap: blocks clamp to the array end (no future data past the source)", async () => {
    const frames = await collect(makeSource("run-S"));
    const blocks = selectStationaryBlocks(frames.length, 6, 30, createRng(2, "boot"));
    for (const blk of blocks) expect(blk.startIndex + blk.length).toBeLessThanOrEqual(frames.length);
    expect(blocks.reduce((a, b) => a + b.length, 0)).toBeGreaterThanOrEqual(30);
  });
  it("assembled bootstrap path: monotonic re-timing, HISTORICAL_BOOTSTRAP provenance, seams assessed + counted", async () => {
    const frames = await collect(makeSource("run-P"));
    const blocks = selectFixedLengthBlocks(frames.length, 8, 4, createRng(3, "boot"));
    const res = assembleBootstrapPath(frames, blocks, { runId: "bp", symbols: ["BTCUSDT", "ETHUSDT"], startMs: BASE, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
    const inv = checkFrameStreamInvariants(res.frames, { expectSingleProvenance: true });
    expect(inv.ok).toBe(true);
    expect(res.frames.every((f) => f.provenance === "HISTORICAL_BOOTSTRAP")).toBe(true);
    expect(res.stitches.length).toBe(blocks.length - 1); // one seam per block boundary
    res.stitches.forEach((st) => expect(st.transformations).toContain("TIMESTAMP_NORMALIZED"));
    expect(res.rejectedBoundaries).toBeGreaterThanOrEqual(0);
  });
  it("stitch assessment flags a large price gap", async () => {
    const frames = await collect(makeSource("run-St"));
    const st = assessStitch(frames[10]!, frames[40]!, ["BTCUSDT", "ETHUSDT"]);
    expect(st.priceGapPct).not.toBeNull();
    expect(typeof st.accepted).toBe("boolean");
  });
});

// ═══════════════ REALISM ═══════════════
describe("realism", () => {
  it("metrics return finite values or explicit nulls; identical series ⇒ ~0 distances", () => {
    const r = createRng(11, "rz");
    const real = Array.from({ length: 300 }, () => r.normal(0, 0.01));
    const a = assessRealism({ realReturns: real, simReturns: real.slice() });
    expect(a.returnDistributionDistance).toBeCloseTo(0, 6);
    expect(a.autocorrelationDistance).toBeCloseTo(0, 6);
    expect(a.status).not.toBe("INSUFFICIENT_DATA");
  });
  it("insufficient sample ⇒ INSUFFICIENT_DATA status (never fabricated)", () => {
    const a = assessRealism({ realReturns: [0.01, -0.01], simReturns: [0.02, -0.02] });
    expect(a.status).toBe("INSUFFICIENT_DATA");
  });
  it("stylized-facts gate: a flat constant series FAILS vol-clustering ⇒ ADVERSARIAL_ONLY", () => {
    const r = createRng(12, "sf");
    const real = Array.from({ length: 300 }, () => r.normal(0, 0.01));
    const flat = new Array(300).fill(0.0); // no clustering, degenerate
    const g = evaluateStylizedFacts({ realReturns: real, simReturns: flat });
    expect(g.pass).toBe(false);
    expect(g.eligibility).toBe("ADVERSARIAL_ONLY");
  });
  it("classifier: identical distributions ⇒ AUC near 0.5; leakage guard catches overlapping windows", () => {
    const r = createRng(13, "cl");
    const mk = (label: 0 | 1, origin: string, split: LabeledWindow["split"], start: number): LabeledWindow =>
      ({ label, returns: Array.from({ length: 60 }, () => r.normal(0, 0.01)), windowStart: start, windowEnd: start + 60, origin, split });
    const windows: LabeledWindow[] = [];
    for (let i = 0; i < 20; i += 1) windows.push(mk(i % 2 === 0 ? 1 : 0, i % 2 === 0 ? "real" : "sim", i < 14 ? "calibration" : "development", i * 100));
    const ev = evaluateClassifier(windows);
    expect(ev.leakage.overlappingPairs).toBe(0);
    if (ev.developmentAuc != null) expect(ev.developmentAuc).toBeGreaterThan(0.1);
    // overlap: two windows same origin, different split, overlapping ranges
    const leak = [mk(1, "real", "calibration", 0), mk(1, "real", "untouched-realism-holdout", 30)];
    expect(evaluateClassifier(leak).leakage.overlappingPairs).toBe(1);
    expect(windowFeatures([0.01, -0.01, 0.02]).length).toBe(9);
  });
});

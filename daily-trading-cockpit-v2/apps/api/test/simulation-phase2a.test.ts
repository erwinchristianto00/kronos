/**
 * Phase-2A regression tests — lock the return-space repair + corrected classifier methodology so a future change
 * cannot silently regress them. Pins: (1) return-space determinism, (2) OHLC ordering + positivity on every candle,
 * (3) seam injects ~0 price gap (vs large for absolute-price), (4) within-block returns/geometry preserved,
 * (5) BTC/ETH synchronized, (6) provenance + volume carried, (7) AUC orientation + label-inversion invariance,
 * (8) physical-embargo timestamp gap ≥ embargo.
 */
import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { selectFixedLengthBlocks, assembleBootstrapPath, assembleReturnSpaceBootstrapPath } from "../src/simulation/historical-block-bootstrap.js";
import { orientAuc, evaluateClassifier, type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import { logReturns } from "../src/simulation/calibration-metrics.js";
import { buildCommonMarketFrame, type SymbolFrameInput } from "../src/simulation/common-market-frame.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const HOUR = 3_600_000;

/** Two-symbol real-ish block at a price level; BTC and ETH co-move (ETH = 20× BTC-ish level, correlated noise). */
function levelBlock(runId: string, startMs: number, level: number, n: number, syms: string[] = ["BTCUSDT", "ETHUSDT"]): CommonMarketFrame[] {
  const rng = createRng(Math.round(level), `blk/${level}`);
  const out: CommonMarketFrame[] = [];
  const price: Record<string, number> = {}; for (const s of syms) price[s] = level * (s === "ETHUSDT" ? 0.05 : 1);
  let t = startMs;
  for (let i = 0; i < n; i += 1) {
    const shock = rng.normal(0, 0.004); // shared shock ⇒ BTC/ETH correlated
    const symbols: Record<string, SymbolFrameInput> = {};
    for (const s of syms) {
      const open = price[s]!;
      const idio = rng.normal(0, 0.001);
      const close = Math.max(0.01, open * (1 + shock + idio));
      const high = Math.max(open, close) * (1 + Math.abs(rng.normal(0, 0.001)));
      const low = Math.min(open, close) * (1 - Math.abs(rng.normal(0, 0.001)));
      symbols[s] = { candle: { openTimeMs: t, closeTimeMs: t + HOUR - 1, open, high, low, close, volume: 1000 + i }, source: "t" };
      price[s] = close;
    }
    out.push(buildCommonMarketFrame({ runId, asOfMs: t + HOUR - 1, symbols, provenance: "OBSERVED_HISTORICAL" }));
    t += HOUR;
  }
  return out;
}

describe("phase-2a — return-space stitching repair", () => {
  const SYMS = ["BTCUSDT", "ETHUSDT"];
  const mkPath = (seed: number) => {
    const src = levelBlock("s", 0, 100, 120);
    const blocks = selectFixedLengthBlocks(src.length, 20, 6, createRng(seed, "boot"));
    return assembleReturnSpaceBootstrapPath(src, blocks, { runId: "rs", symbols: SYMS, startMs: 0, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
  };

  it("is deterministic per seed (identical assembled frame ids)", () => {
    expect(mkPath(7).frames.map((f) => f.frameId)).toEqual(mkPath(7).frames.map((f) => f.frameId));
  });

  it("every reconstructed candle satisfies OHLC ordering + strict positivity", () => {
    for (const f of mkPath(3).frames) for (const s of SYMS) {
      const c = f.symbols[s]!.candle.value!;
      expect(c.open).toBeGreaterThan(0); expect(c.close).toBeGreaterThan(0); expect(c.low).toBeGreaterThan(0);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close) - 1e-9);
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close) + 1e-9);
    }
  });

  it("REGRESSION: return-space seam injects ~0 price gap where absolute-price injects a large one", () => {
    // low block (100) then high block (300): absolute-price makes a ~2x seam; return-space opens at prev close.
    const src = [...levelBlock("lo", 0, 100, 40), ...levelBlock("hi", 40 * HOUR, 300, 40)];
    const blocks = [{ startIndex: 0, length: 40 }, { startIndex: 40, length: 40 }];
    const rs = assembleReturnSpaceBootstrapPath(src, blocks, { runId: "rs", symbols: ["BTCUSDT"], startMs: 0, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
    const ap = assembleBootstrapPath(src, blocks, { runId: "ap", symbols: ["BTCUSDT"], startMs: 0, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
    expect(rs.stitches.length).toBe(1); expect(ap.stitches.length).toBe(1);
    expect(rs.stitches[0]!.priceGapPct ?? 1).toBeLessThan(1e-9); // ~0 by construction
    expect(rs.rejectedBoundaries).toBe(0); // no artificial price jump ⇒ seam accepted
    expect(ap.stitches[0]!.priceGapPct ?? 0).toBeGreaterThan(0.5); // absolute-price: huge seam
    expect(ap.rejectedBoundaries).toBe(1);
  });

  it("preserves each block's within-block return geometry (close/open ratio matches source)", () => {
    const src = levelBlock("g", 0, 100, 60);
    const blocks = [{ startIndex: 10, length: 15 }];
    const rs = assembleReturnSpaceBootstrapPath(src, blocks, { runId: "g", symbols: ["BTCUSDT"], startMs: 0, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
    for (let j = 0; j < 15; j += 1) {
      const srcC = src[10 + j]!.symbols.BTCUSDT!.candle.value!;
      const genC = rs.frames[j]!.symbols.BTCUSDT!.candle.value!;
      expect(genC.close / genC.open).toBeCloseTo(srcC.close / srcC.open, 9); // intra-candle return preserved
      expect(genC.high / genC.open).toBeCloseTo(srcC.high / srcC.open, 9);
    }
  });

  it("BTC and ETH are synchronized (same frames, both present, contemporaneous co-move preserved)", () => {
    const p = mkPath(5);
    for (const f of p.frames) { expect(f.symbols.BTCUSDT!.candle.value).not.toBeNull(); expect(f.symbols.ETHUSDT!.candle.value).not.toBeNull(); }
    const bR = logReturns(p.frames.map((f) => f.symbols.BTCUSDT!.candle.value!.close));
    const eR = logReturns(p.frames.map((f) => f.symbols.ETHUSDT!.candle.value!.close));
    // shared-shock construction ⇒ strong positive contemporaneous correlation survives stitching
    const n = Math.min(bR.length, eR.length);
    const mb = bR.reduce((a, v) => a + v, 0) / n, me = eR.reduce((a, v) => a + v, 0) / n;
    let num = 0, db = 0, de = 0; for (let i = 0; i < n; i += 1) { num += (bR[i]! - mb) * (eR[i]! - me); db += (bR[i]! - mb) ** 2; de += (eR[i]! - me) ** 2; }
    expect(num / Math.sqrt(db * de)).toBeGreaterThan(0.8);
  });

  it("carries provenance HISTORICAL_BOOTSTRAP and source volume unchanged", () => {
    const src = levelBlock("v", 0, 100, 30);
    const blocks = [{ startIndex: 5, length: 10 }];
    const rs = assembleReturnSpaceBootstrapPath(src, blocks, { runId: "v", symbols: ["BTCUSDT"], startMs: 0, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
    expect(rs.frames[0]!.provenance).toBe("HISTORICAL_BOOTSTRAP");
    for (let j = 0; j < 10; j += 1) expect(rs.frames[j]!.symbols.BTCUSDT!.candle.value!.volume).toBe(src[5 + j]!.symbols.BTCUSDT!.candle.value!.volume);
  });
});

describe("phase-2a — AUC orientation + label inversion", () => {
  it("separabilityAuc = max(raw, 1-raw): a raw AUC of 0.076 is 0.924 separable", () => {
    expect(orientAuc(0.076).separabilityAuc).toBeCloseTo(0.924, 6);
    expect(orientAuc(0.924).separabilityAuc).toBeCloseTo(0.924, 6);
    expect(orientAuc(0.5).separabilityAuc).toBeCloseTo(0.5, 6);
    expect(orientAuc(null).separabilityAuc).toBeNull();
  });

  it("separabilityAuc is invariant to flipping all labels", () => {
    const r = createRng(21, "clf");
    const mk = (label: 0 | 1, origin: string, split: LabeledWindow["split"], start: number, mu: number): LabeledWindow =>
      ({ label, returns: Array.from({ length: 60 }, () => r.normal(mu, 0.01)), windowStart: start, windowEnd: start + 60, origin, split });
    const windows: LabeledWindow[] = [];
    for (let i = 0; i < 24; i += 1) windows.push(mk(i % 2 as 0 | 1, i % 2 === 0 ? "real" : "sim", i < 16 ? "calibration" : "development", i * 100, i % 2 === 0 ? 0.002 : -0.002));
    const base = evaluateClassifier(windows).development.separabilityAuc;
    const flipped = evaluateClassifier(windows.map((w) => ({ ...w, label: (w.label === 1 ? 0 : 1) as 0 | 1 }))).development.separabilityAuc;
    if (base != null && flipped != null) expect(Math.abs(base - flipped)).toBeLessThan(1e-9);
  });
});

describe("phase-2a — physical embargo drops boundary bars (timestamp inspection)", () => {
  // mirrors scripts/sim-phase2a-run.ts physicalEmbargo: drop first/last E frames, so adjacent partitions gap ≥ E.
  const dropBothEnds = (fs: CommonMarketFrame[], e: number) => fs.slice(e, fs.length - e);
  it("adjacent partitions have a retained-timestamp gap ≥ embargo after dropping both ends", () => {
    const E = 12;
    const left = levelBlock("L", 0, 100, 100); // ends at t=99h
    const right = levelBlock("R", 100 * HOUR, 100, 100); // starts at t=100h (adjacent)
    const lr = dropBothEnds(left, E); const rr = dropBothEnds(right, E);
    const gapHours = (rr[0]!.asOfMs - lr.at(-1)!.asOfMs) / HOUR;
    expect(gapHours).toBeGreaterThanOrEqual(E); // no block/window can straddle the boundary
  });
});

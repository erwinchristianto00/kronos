/**
 * Phase-1B regression tests — lock the honest realism findings so a future change cannot silently hide them.
 * These pin: (1) bootstrap determinism, (2) that absolute-price seam stitching IS detectable (high seam-reject +
 * stylized-facts fail) — the exact deficiency the Phase-1B run surfaced, and (3) the classifier leakage guard.
 * If a later "fix" makes seams pass WITHOUT actually improving realism, these must be revisited deliberately.
 */
import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { selectFixedLengthBlocks, assembleBootstrapPath } from "../src/simulation/historical-block-bootstrap.js";
import { evaluateStylizedFacts } from "../src/simulation/realism-gate.js";
import { evaluateClassifier, type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import { logReturns } from "../src/simulation/calibration-metrics.js";
import { buildCommonMarketFrame, type SymbolFrameInput } from "../src/simulation/common-market-frame.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const HOUR = 3_600_000;
// Two contiguous real-ish blocks at DIFFERENT price levels (100 vs 300) — concatenating them creates a big seam.
function levelBlock(runId: string, startMs: number, level: number, n: number): CommonMarketFrame[] {
  const rng = createRng(Math.round(level), `blk/${level}`);
  const out: CommonMarketFrame[] = [];
  let price = level; let t = startMs;
  for (let i = 0; i < n; i += 1) {
    const open = price; const close = Math.max(1, open + rng.normal(0, 0.5));
    const high = Math.max(open, close) + Math.abs(rng.normal(0, 0.2)); const low = Math.min(open, close) - Math.abs(rng.normal(0, 0.2));
    const sym: Record<string, SymbolFrameInput> = { BTCUSDT: { candle: { openTimeMs: t, closeTimeMs: t + HOUR - 1, open, high, low, close, volume: 1000 }, source: "t" } };
    out.push(buildCommonMarketFrame({ runId, asOfMs: t + HOUR - 1, symbols: sym, provenance: "OBSERVED_HISTORICAL" }));
    price = close; t += HOUR;
  }
  return out;
}

describe("phase-1b regression — seam artifacts are detectable, determinism holds", () => {
  it("bootstrap is deterministic per seed (identical assembled frame ids)", () => {
    const src = [...levelBlock("s", 0, 100, 60)];
    const mk = () => {
      const blocks = selectFixedLengthBlocks(src.length, 10, 4, createRng(7, "boot"));
      return assembleBootstrapPath(src, blocks, { runId: "d", symbols: ["BTCUSDT"], startMs: 0, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" }).frames.map((f) => f.frameId);
    };
    expect(mk()).toEqual(mk());
  });

  it("REGRESSION: absolute-price seam stitching between different levels ⇒ boundary rejected + stylized-facts fail", () => {
    // low-level block then high-level block: the seam is a huge artificial jump.
    const src = [...levelBlock("lo", 0, 100, 40), ...levelBlock("hi", 40 * HOUR, 300, 40)];
    const blocks = [{ startIndex: 0, length: 40 }, { startIndex: 40, length: 40 }];
    const res = assembleBootstrapPath(src, blocks, { runId: "seam", symbols: ["BTCUSDT"], startMs: 0, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
    expect(res.stitches.length).toBe(1);
    expect(res.rejectedBoundaries).toBe(1); // the 100→300 seam is a >5% gap ⇒ REJECTED (not smoothed)
    expect(res.stitches[0]!.transformations).toContain("TIMESTAMP_NORMALIZED");
    // the stitched path's returns fail stylized facts (a giant seam return corrupts the distribution)
    const simR = logReturns(res.frames.map((f) => f.symbols.BTCUSDT!.candle.value!.close));
    const realR = logReturns(levelBlock("real", 0, 100, 300).map((f) => f.symbols.BTCUSDT!.candle.value!.close));
    const gate = evaluateStylizedFacts({ realReturns: realR, simReturns: simR });
    expect(gate.eligibility).toBe("ADVERSARIAL_ONLY"); // NOT research-eligible — the honest verdict
  });

  it("classifier leakage guard rejects overlapping same-origin windows across splits (no silent leakage)", () => {
    const w = (start: number, split: LabeledWindow["split"]): LabeledWindow => ({ label: 1, returns: new Array(48).fill(0.001), windowStart: start, windowEnd: start + 48, origin: "real", split });
    const leaky = [w(0, "calibration"), w(24, "untouched-realism-holdout")]; // overlap 0..48 ∩ 24..72
    expect(evaluateClassifier(leaky).leakage.overlappingPairs).toBe(1);
  });
});

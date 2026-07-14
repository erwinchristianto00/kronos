/**
 * Phase-2C ROBUSTNESS regression tests. Locks (a) the independent Method-B2 successor selector's core guarantees
 * (determinism, its own replay bounds, genuine independence from Method B), (b) that the longest-unchanged-run metric
 * is a REAL measurement and not a clamp to the cap (the adversarial "is 144h==cap a tautology?" question), and
 * (c) CODIFIES the confirmed harness limitation the adversarial review surfaced: the leave-one-month-out /
 * remove-a-month diagnostics are packing-constrained by `maxMonthFraction`, so their 100%-insufficient outcome is an
 * arithmetic property of the month cap — NOT evidence about cross-month generalization. See ADVERSARIAL_REVIEW.md.
 */
import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { buildCommonMarketFrame, type SymbolFrameInput } from "../src/simulation/common-market-frame.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";
import { computeCalibrationVolumeBaseline, computeTerminalState, TERMINAL_LOOKBACK } from "../src/simulation/block-transition-state.js";
import { buildCompatibilityNormalizer } from "../src/simulation/block-compatibility.js";
import { buildContinuationLibrary } from "../src/simulation/historical-continuation-library.js";
import { selectObservedTransitionBlocks, DEFAULT_REPLAY_CONSTRAINTS } from "../src/simulation/observed-transition-selection.js";
import { selectB2SuccessorBlocks, DEFAULT_B2_CONSTRAINTS } from "../src/simulation/observed-successor-b2.js";

const HOUR = 3_600_000;
function synthCorpus(n: number, seed = 5): CommonMarketFrame[] {
  const rng = createRng(seed, "corpus"); const out: CommonMarketFrame[] = [];
  const price: Record<string, number> = { BTCUSDT: 60000, ETHUSDT: 3000 }; let t = 0;
  for (let i = 0; i < n; i += 1) {
    const shock = rng.normal(0, 0.004); const symbols: Record<string, SymbolFrameInput> = {};
    for (const s of ["BTCUSDT", "ETHUSDT"]) { const open = price[s]!; const close = Math.max(1, open * (1 + shock + rng.normal(0, 0.001))); const high = Math.max(open, close) * (1 + Math.abs(rng.normal(0, 0.001))); const low = Math.min(open, close) * (1 - Math.abs(rng.normal(0, 0.001))); symbols[s] = { candle: { openTimeMs: t, closeTimeMs: t + HOUR - 1, open, high, low, close, volume: 1000 + (i % 40) }, source: "t" }; price[s] = close; }
    out.push(buildCommonMarketFrame({ runId: "c", asOfMs: t + HOUR - 1, symbols, provenance: "OBSERVED_HISTORICAL" })); t += HOUR;
  }
  return out;
}

describe("phase-2c-robustness — independent Method B2 successor selector", () => {
  const frames = synthCorpus(600);
  const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
  const calStates = Array.from({ length: 600 - 48 }, (_, i) => computeTerminalState(frames, i, 48, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK));
  const norm = buildCompatibilityNormalizer(calStates);
  const lib = buildContinuationLibrary(frames, { lookback: TERMINAL_LOOKBACK, successorLen: 48, sourcePartition: "cal", baseline, btc: "BTCUSDT", eth: "ETHUSDT" });
  const b2 = (seed: number, cap = 144) => selectB2SuccessorBlocks({ source: frames, library: lib, normalizer: norm, baseline, btc: "BTCUSDT", eth: "ETHUSDT", lookback: TERMINAL_LOOKBACK, targetLen: frames.length, rng: createRng(seed, "b2/INDEPENDENT_SUCCESSOR"), constraints: { ...DEFAULT_B2_CONSTRAINTS, maxUnchangedRunHours: cap } });
  const b1 = (seed: number, cap = 144) => selectObservedTransitionBlocks({ method: "ONE_STEP_SUCCESSOR", source: frames, library: lib, normalizer: norm, baseline, btc: "BTCUSDT", eth: "ETHUSDT", lookback: TERMINAL_LOOKBACK, blockLen: 48, targetLen: frames.length, rng: createRng(seed, "obs/B_ONE_STEP_SUCCESSOR"), constraints: { ...DEFAULT_REPLAY_CONSTRAINTS, maxUnchangedRunHours: cap } });

  it("is deterministic per seed (identical block sequence + memoization across two calls)", () => {
    expect(b2(3).blocks.map((b) => `${b.startIndex}:${b.length}`)).toEqual(b2(3).blocks.map((b) => `${b.startIndex}:${b.length}`));
    expect(b2(3).memoization.longestUnchangedRunHours).toBe(b2(3).memoization.longestUnchangedRunHours);
  });

  it("respects ITS OWN replay bounds (longest run ≤ cap, successor reuse ≤ constraint)", () => {
    const res = b2(7);
    expect(res.memoization.longestUnchangedRunHours).toBeLessThanOrEqual(DEFAULT_B2_CONSTRAINTS.maxUnchangedRunHours);
    expect(res.memoization.maxSuccessorReuse).toBeLessThanOrEqual(DEFAULT_B2_CONSTRAINTS.maxSuccessorReuse);
  });

  it("never selects a candidate outside its support radius (except a forced SEED_START / fallback)", () => {
    for (const s of res_seams(b2(11))) if (s.matchDistance != null && s.fallbackLevel !== "SEED_START") expect(s.matchDistance).toBeLessThanOrEqual(DEFAULT_B2_CONSTRAINTS.supportRadius + 1e-9);
  });

  it("is GENUINELY INDEPENDENT of Method B — produces a different block sequence on at least one seed", () => {
    // Same fixture, same normalizer, same terminal-state descriptor, but B2's RMS distance + regime×vol bucket index +
    // BUCKET→REGIME→ALL fallback + continuationId tie-break is a different selection rule than B's mean-abs +
    // per-component support gate + RELAX ladder. A coupled copy would match on every seed; independence ⇒ divergence.
    const differs = [1, 2, 3, 4, 5].some((s) => {
      const a = b1(s).blocks.map((b) => `${b.startIndex}:${b.length}`).join(",");
      const c = b2(s).blocks.map((b) => `${b.startIndex}:${b.length}`).join(",");
      return a !== c;
    });
    expect(differs).toBe(true);
  });

  it("longest-unchanged-run is a REAL measurement, NOT a clamp to the cap", () => {
    // Blocks are 48h. A source-contiguous run can only be 48, 96, 144 … At cap=72 an extension to 96 is forbidden
    // (96 > 72), so the true longest run is exactly 48. A clamp (min(run, cap)) would instead report 72. It reports 48
    // ⇒ the metric tracks the true granular contiguity that the selector bounds, it does not echo the cap.
    const r72 = b2(7, 72);
    expect(r72.memoization.longestUnchangedRunHours).toBe(48);
    expect(r72.memoization.longestUnchangedRunHours).not.toBe(72);
  });
});

// helper: expose the seam diagnostics array without widening the public type surface in the assertion above
function res_seams(r: ReturnType<typeof selectB2SuccessorBlocks>) { return r.seams; }

describe("phase-2c-robustness — CONFIRMED harness limitation: month-cap packing constraint (Defect A)", () => {
  // Adversarial finding: with maxMonthFraction=0.5, a set of source months can contribute at most 0.5*targetLen HOURS
  // PER MONTH. So if the reachable months cannot jointly cover targetLen under that cap, the selector MUST end
  // insufficient — by arithmetic, independent of realism. This is exactly why leave-one-month-out (2 months, 0.5 cap,
  // 3-month-length target ⇒ max 2*0.5*len < len) is 100% insufficient for EVERY seed. This test pins the mechanism so
  // the LOPO/remove-month diagnostics are never misread as a cross-month generalization failure.
  it("a single-month source cannot fill a full-length target under maxMonthFraction=0.5 ⇒ insufficient", () => {
    const frames = synthCorpus(300); // ~12.5 days ⇒ all within one calendar month (1970-01)
    const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
    const calStates = Array.from({ length: 300 - 48 }, (_, i) => computeTerminalState(frames, i, 48, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK));
    const norm = buildCompatibilityNormalizer(calStates);
    const lib = buildContinuationLibrary(frames, { lookback: TERMINAL_LOOKBACK, successorLen: 48, sourcePartition: "cal", baseline, btc: "BTCUSDT", eth: "ETHUSDT" });
    // monthDurationCap = 0.5 * 300 = 150h; a single month can supply ≤150h but targetLen=300h ⇒ must go insufficient.
    const res = selectObservedTransitionBlocks({ method: "ONE_STEP_SUCCESSOR", source: frames, library: lib, normalizer: norm, baseline, btc: "BTCUSDT", eth: "ETHUSDT", lookback: TERMINAL_LOOKBACK, blockLen: 48, targetLen: frames.length, rng: createRng(1, "obs/B_ONE_STEP_SUCCESSOR"), constraints: { ...DEFAULT_REPLAY_CONSTRAINTS, maxMonthFraction: 0.5 } });
    expect(res.insufficientSeams).toBeGreaterThan(0);
    // and the placed hours are bounded by the month cap (≈150h), well short of the 300h target — the packing wall.
    const placed = res.blocks.reduce((a, b) => a + b.length, 0);
    expect(placed).toBeLessThan(frames.length);
    expect(placed).toBeLessThanOrEqual(0.5 * frames.length + 48);
  });

  it("relaxing the month cap (2.0, headroom above the 48h-block overshoot) lets the SAME single-month source fill the target — confirms the cap is the cause", () => {
    const frames = synthCorpus(300);
    const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
    const calStates = Array.from({ length: 300 - 48 }, (_, i) => computeTerminalState(frames, i, 48, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK));
    const norm = buildCompatibilityNormalizer(calStates);
    const lib = buildContinuationLibrary(frames, { lookback: TERMINAL_LOOKBACK, successorLen: 48, sourcePartition: "cal", baseline, btc: "BTCUSDT", eth: "ETHUSDT" });
    // cap 2.0 ⇒ monthDurationCap=600h, comfortably above the ~336h (7×48) the run must place; the ONLY change from the
    // insufficient case above is the month cap, so a sufficient outcome here proves the cap — not realism — is the wall.
    const res = selectObservedTransitionBlocks({ method: "ONE_STEP_SUCCESSOR", source: frames, library: lib, normalizer: norm, baseline, btc: "BTCUSDT", eth: "ETHUSDT", lookback: TERMINAL_LOOKBACK, blockLen: 48, targetLen: frames.length, rng: createRng(1, "obs/B_ONE_STEP_SUCCESSOR"), constraints: { ...DEFAULT_REPLAY_CONSTRAINTS, maxMonthFraction: 2.0 } });
    expect(res.insufficientSeams).toBe(0);
  });
});

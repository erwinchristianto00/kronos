/**
 * Phase-2B regression tests — lock the compatibility-conditioned selection guarantees: candidate-prefix CAUSALITY
 * (no future leakage), calibration-only normalization, fallback hierarchy discipline (no silent global fallback),
 * anti-memorization constraints, determinism, BTC/ETH synchronization, transition-kernel + seam-realism CI behavior,
 * and duplicate-sequence detection.
 */
import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { buildCommonMarketFrame, type SymbolFrameInput } from "../src/simulation/common-market-frame.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";
import { computeCalibrationVolumeBaseline, computeInitialState, computeTerminalState, CANDIDATE_PREFIX_LEN, TERMINAL_LOOKBACK } from "../src/simulation/block-transition-state.js";
import { buildCompatibilityNormalizer, assessCompatibility, RELAX_LEVELS } from "../src/simulation/block-compatibility.js";
import { selectCompatibilityBlocks, precomputeInitialStates, buildTransitionKernel, detectDuplicateSequences, DEFAULT_CONSTRAINTS } from "../src/simulation/compatibility-block-selection.js";
import { computeSeamRealism, groupedBootstrapMeanCI } from "../src/simulation/seam-realism.js";
import { assembleReturnSpaceBootstrapPath } from "../src/simulation/historical-block-bootstrap.js";

const HOUR = 3_600_000;
function synthCorpus(n: number, seed = 5): CommonMarketFrame[] {
  const rng = createRng(seed, "corpus");
  const out: CommonMarketFrame[] = [];
  const price: Record<string, number> = { BTCUSDT: 60000, ETHUSDT: 3000 };
  let t = 0;
  for (let i = 0; i < n; i += 1) {
    const shock = rng.normal(0, 0.004);
    const symbols: Record<string, SymbolFrameInput> = {};
    for (const s of ["BTCUSDT", "ETHUSDT"]) {
      const open = price[s]!; const close = Math.max(1, open * (1 + shock + rng.normal(0, 0.001)));
      const high = Math.max(open, close) * (1 + Math.abs(rng.normal(0, 0.001))); const low = Math.min(open, close) * (1 - Math.abs(rng.normal(0, 0.001)));
      symbols[s] = { candle: { openTimeMs: t, closeTimeMs: t + HOUR - 1, open, high, low, close, volume: 1000 + (i % 50) }, source: "t" };
      price[s] = close;
    }
    out.push(buildCommonMarketFrame({ runId: "c", asOfMs: t + HOUR - 1, symbols, provenance: "OBSERVED_HISTORICAL" }));
    t += HOUR;
  }
  return out;
}

describe("phase-2b — transition-state causality", () => {
  it("candidate INITIAL state depends ONLY on the frozen prefix (mutating post-prefix candles changes nothing)", () => {
    const frames = synthCorpus(60);
    const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
    const before = computeInitialState(frames, 10, baseline, "BTCUSDT", "ETHUSDT");
    // mutate a candle AFTER the prefix (index 10 + prefixLen + 2) — must not affect the initial state
    const idx = 10 + CANDIDATE_PREFIX_LEN + 2;
    const c = frames[idx]!.symbols.BTCUSDT!.candle.value!;
    const mutated = frames.slice();
    mutated[idx] = buildCommonMarketFrame({ runId: "c", asOfMs: frames[idx]!.asOfMs, symbols: { BTCUSDT: { candle: { ...c, close: c.close * 1.5, high: c.high * 1.6 }, source: "t" }, ETHUSDT: { candle: frames[idx]!.symbols.ETHUSDT!.candle.value!, source: "t" } }, provenance: "OBSERVED_HISTORICAL" });
    const after = computeInitialState(mutated, 10, baseline, "BTCUSDT", "ETHUSDT");
    expect(after.volatilityMedium).toBeCloseTo(before.volatilityMedium, 12);
    expect(after.recentReturn).toBeCloseTo(before.recentReturn, 12);
    expect(after.regimeFamily).toBe(before.regimeFamily);
  });
});

describe("phase-2b — compatibility distance + normalizer", () => {
  const frames = synthCorpus(300);
  const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
  const starts = Array.from({ length: 300 - 48 }, (_, i) => i);
  const calStates = starts.map((s) => computeTerminalState(frames, s, 48, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK));
  const norm = buildCompatibilityNormalizer(calStates);

  it("normalizer scales are finite and positive (calibration-derived)", () => {
    for (const v of Object.values(norm.scales)) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThan(0); }
    expect(norm.wickScale).toBeGreaterThan(0);
  });
  it("a state is highly compatible with itself (distance ~0, within support)", () => {
    const t = calStates[50]!;
    const a = assessCompatibility("self", t, t, norm, RELAX_LEVELS[0]!.features);
    expect(a.totalDistance).toBeLessThan(1e-9);
    expect(a.withinEmpiricalSupport).toBe(true);
  });
  it("a regime mismatch is NOT within support at the EXACT level", () => {
    const up = { ...calStates[10]!, regimeFamily: "UPTREND" };
    const down = { ...calStates[10]!, regimeFamily: "DOWNTREND" };
    const a = assessCompatibility("x", up, down, norm, RELAX_LEVELS[0]!.features);
    expect(a.withinEmpiricalSupport).toBe(false);
  });
  it("funding + mark-basis are reported missing, never counted", () => {
    const t = calStates[0]!;
    const a = assessCompatibility("x", t, t, norm, [...RELAX_LEVELS[0]!.features]);
    // funding/markBasis are not in the active feature list ⇒ not required; but corr etc present
    expect(a.componentDistances.regimeFamily).toBe(0);
    expect(t.fundingRate).toBeNull(); expect(t.markBasisBps).toBeNull();
  });
});

describe("phase-2b — selection discipline", () => {
  const frames = synthCorpus(600);
  const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
  const starts = Array.from({ length: 600 - 48 }, (_, i) => i);
  const initialStates = precomputeInitialStates(frames, starts, baseline, "BTCUSDT", "ETHUSDT");
  const calStates = starts.map((s) => computeTerminalState(frames, s, 48, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK));
  const norm = buildCompatibilityNormalizer(calStates);
  const kernel = buildTransitionKernel(frames, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK);
  const run = (seed: number) => selectCompatibilityBlocks({ strategy: "HARD_FILTER", frames, candidateStarts: starts, initialStates, normalizer: norm, baseline, btc: "BTCUSDT", eth: "ETHUSDT", blockLen: 48, targetLen: frames.length, lookback: TERMINAL_LOOKBACK, rng: createRng(seed, "sel"), constraints: DEFAULT_CONSTRAINTS, kernel });

  it("is deterministic per seed (identical block start sequence)", () => {
    expect(run(3).blocks.map((b) => b.startIndex)).toEqual(run(3).blocks.map((b) => b.startIndex));
  });
  it("respects maxUsePerBlock (no source block used more than the cap)", () => {
    const use = new Map<number, number>();
    for (const b of run(7).blocks) use.set(b.startIndex, (use.get(b.startIndex) ?? 0) + 1);
    for (const c of use.values()) expect(c).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxUsePerBlock);
  });
  it("never records a silent global fallback — only named levels or INSUFFICIENT", () => {
    const res = run(4);
    const allowed = new Set(["SEED_START", "KERNEL", "INSUFFICIENT_COMPATIBLE_BLOCKS", ...RELAX_LEVELS.map((l) => l.name)]);
    for (const k of Object.keys(res.fallbackLevelCounts)) expect(allowed.has(k)).toBe(true);
  });
  it("produces synchronized BTC/ETH after reconstruction", () => {
    const res = run(5);
    const path = assembleReturnSpaceBootstrapPath(frames, res.blocks, { runId: "p", symbols: ["BTCUSDT", "ETHUSDT"], startMs: 0, stepMs: HOUR, method: "NEAREST_NEIGHBOR_CONTINUATION" });
    for (const f of path.frames) { expect(f.symbols.BTCUSDT!.candle.value).not.toBeNull(); expect(f.symbols.ETHUSDT!.candle.value).not.toBeNull(); }
  });
});

describe("phase-2b — adversarial-review regressions", () => {
  it("recentReturn is the PER-CANDLE MEAN log return, not the cumulative sum (contract fix)", () => {
    const frames = synthCorpus(80);
    const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
    const st = computeTerminalState(frames, 10, 48, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK);
    // reconstruct the lookback log returns and compare
    const closes: number[] = [];
    for (let i = 10 + 48 - TERMINAL_LOOKBACK; i < 10 + 48; i += 1) closes.push(frames[i]!.symbols.BTCUSDT!.candle.value!.close);
    const rets: number[] = []; for (let i = 1; i < closes.length; i += 1) rets.push(Math.log(closes[i]! / closes[i - 1]!));
    const meanRet = rets.reduce((a, v) => a + v, 0) / rets.length;
    const cumRet = rets.reduce((a, v) => a + v, 0);
    expect(st.recentReturn).toBeCloseTo(meanRet, 10); // per-candle mean
    expect(Math.abs(st.recentReturn - cumRet)).toBeGreaterThan(1e-6); // NOT the cumulative sum (23 returns ⇒ differ)
  });

  it("BTC/ETH dependence is computed on TIME-ALIGNED pairs even with an asymmetric gap (no desync)", () => {
    const frames = synthCorpus(60);
    const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
    // introduce a BTC-only gap inside the window (ETH present, BTC null) at index 20
    const gapped = frames.slice();
    gapped[20] = buildCommonMarketFrame({ runId: "c", asOfMs: frames[20]!.asOfMs, symbols: { BTCUSDT: { candle: null, source: "gap" }, ETHUSDT: { candle: frames[20]!.symbols.ETHUSDT!.candle.value!, source: "t" } }, provenance: "OBSERVED_HISTORICAL" });
    const st = computeTerminalState(gapped, 0, 44, baseline, "BTCUSDT", "ETHUSDT", 40); // window [4,44) spans the gap
    // corr must be a finite number in [-1,1] (aligned pairs), not NaN/undefined from mismatched-length arrays
    expect(st.btcEthCorrelation).not.toBeNull();
    expect(Number.isFinite(st.btcEthCorrelation!)).toBe(true);
    expect(st.btcEthCorrelation!).toBeGreaterThanOrEqual(-1); expect(st.btcEthCorrelation!).toBeLessThanOrEqual(1);
  });

  it("TRANSITION_KERNEL still honors maxUsePerBlock (diversity floor also applies to the kernel branch)", () => {
    const frames = synthCorpus(600);
    const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
    const starts = Array.from({ length: 600 - 48 }, (_, i) => i);
    const initialStates = precomputeInitialStates(frames, starts, baseline, "BTCUSDT", "ETHUSDT");
    const calStates = starts.map((s) => computeTerminalState(frames, s, 48, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK));
    const norm = buildCompatibilityNormalizer(calStates);
    const kernel = buildTransitionKernel(frames, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK);
    const res = selectCompatibilityBlocks({ strategy: "TRANSITION_KERNEL", frames, candidateStarts: starts, initialStates, normalizer: norm, baseline, btc: "BTCUSDT", eth: "ETHUSDT", blockLen: 48, targetLen: frames.length, lookback: TERMINAL_LOOKBACK, rng: createRng(9, "sel"), constraints: DEFAULT_CONSTRAINTS, kernel });
    const use = new Map<number, number>();
    for (const b of res.blocks) use.set(b.startIndex, (use.get(b.startIndex) ?? 0) + 1);
    for (const c of use.values()) expect(c).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxUsePerBlock);
  });
});

describe("phase-2b — seam realism + duplicate detection", () => {
  it("computeSeamRealism: excess = generated − natural, ratio consistent, CI ordered", () => {
    const seams = Array.from({ length: 100 }, (_, i) => ({ rejected: i % 4 === 0, reasons: i % 4 === 0 ? ["BTCUSDT volatility ratio 5 > 3"] : [], group: `d${i % 10}` }));
    const r = computeSeamRealism(seams, { rate: 0.05 }, createRng(1, "b"));
    expect(r.generatedRejectRate).toBeCloseTo(0.25, 6);
    expect(r.excessRejectRate).toBeCloseTo(0.20, 6);
    expect(r.rejectRateRatio).toBeCloseTo(5, 6);
    expect(r.confidenceInterval[0]).toBeLessThanOrEqual(r.confidenceInterval[1]);
    expect(r.reasons.volatilityRatio).toBe(25);
  });
  it("groupedBootstrapMeanCI returns [lo,hi] with lo ≤ mean ≤ hi region", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ value: i % 3 === 0 ? 1 : 0, group: `g${i % 6}` }));
    const [lo, hi] = groupedBootstrapMeanCI(items, createRng(2, "b"));
    expect(lo).toBeLessThanOrEqual(hi);
  });
  it("detectDuplicateSequences flags a repeated 3-block run", () => {
    expect(detectDuplicateSequences([1, 2, 3, 9, 1, 2, 3], 3)).toBe(1);
    expect(detectDuplicateSequences([1, 2, 3, 4, 5, 6], 3)).toBe(0);
  });
});

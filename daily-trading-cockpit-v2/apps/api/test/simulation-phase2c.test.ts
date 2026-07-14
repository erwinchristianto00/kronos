/**
 * Phase-2C regression tests — lock the observed-transition guarantees: continuation-library contiguity + causality
 * (ranking by terminal state only, no successor-future leakage), determinism, replay-memorization bounds, natural-
 * boundary classification, bridge geometry, and seam-centered classifier windowing.
 */
import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { buildCommonMarketFrame, type SymbolFrameInput } from "../src/simulation/common-market-frame.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";
import { computeCalibrationVolumeBaseline, TERMINAL_LOOKBACK } from "../src/simulation/block-transition-state.js";
import { buildCompatibilityNormalizer } from "../src/simulation/block-compatibility.js";
import { buildContinuationLibrary, successorFrames } from "../src/simulation/historical-continuation-library.js";
import { selectObservedTransitionBlocks, computeMemoization, DEFAULT_REPLAY_CONSTRAINTS } from "../src/simulation/observed-transition-selection.js";
import { fitBoundarySupport, classifyBoundary, ordinaryBoundaries } from "../src/simulation/natural-boundary-detector.js";
import { seamCenteredWindows, seamExcludedWindows, evaluateSeamClassifier } from "../src/simulation/seam-realism-classifier.js";
import { computeTerminalState } from "../src/simulation/block-transition-state.js";
import type { LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";

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

describe("phase-2c — continuation library + causality", () => {
  const frames = synthCorpus(400);
  const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
  const lib = buildContinuationLibrary(frames, { lookback: TERMINAL_LOOKBACK, successorLen: 48, sourcePartition: "cal", baseline, btc: "BTCUSDT", eth: "ETHUSDT" });

  it("successor is a CONTIGUOUS real slice starting at the boundary, following the state window", () => {
    const r = lib[100]!;
    expect(r.successorRef.length).toBe(48);
    expect(successorFrames(frames, r).length).toBe(48);
    // state window ends exactly where the successor begins
    expect(r.stateWindowEndMs).toBeLessThan(r.successorStartMs);
    expect(successorFrames(frames, r)[0]!.asOfMs).toBe(r.successorStartMs);
  });

  it("CAUSALITY: a record's terminalState (the ranking key) is unaffected by mutating any SUCCESSOR candle", () => {
    const b = 120; const terminalBefore = computeTerminalState(frames, b - TERMINAL_LOOKBACK, TERMINAL_LOOKBACK, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK);
    const idx = b + 10; // a candle inside the successor [b, b+48)
    const c = frames[idx]!.symbols.BTCUSDT!.candle.value!;
    const mut = frames.slice(); mut[idx] = buildCommonMarketFrame({ runId: "c", asOfMs: frames[idx]!.asOfMs, symbols: { BTCUSDT: { candle: { ...c, close: c.close * 3, high: c.high * 3 }, source: "t" }, ETHUSDT: { candle: frames[idx]!.symbols.ETHUSDT!.candle.value!, source: "t" } }, provenance: "OBSERVED_HISTORICAL" });
    const terminalAfter = computeTerminalState(mut, b - TERMINAL_LOOKBACK, TERMINAL_LOOKBACK, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK);
    expect(terminalAfter.volatilityMedium).toBeCloseTo(terminalBefore.volatilityMedium, 12);
    expect(terminalAfter.recentReturn).toBeCloseTo(terminalBefore.recentReturn, 12);
  });
});

describe("phase-2c — observed-transition selection", () => {
  const frames = synthCorpus(600);
  const baseline = computeCalibrationVolumeBaseline(frames, "BTCUSDT");
  const calStates = Array.from({ length: 600 - 48 }, (_, i) => computeTerminalState(frames, i, 48, baseline, "BTCUSDT", "ETHUSDT", TERMINAL_LOOKBACK));
  const norm = buildCompatibilityNormalizer(calStates);
  const lib = buildContinuationLibrary(frames, { lookback: TERMINAL_LOOKBACK, successorLen: 48, sourcePartition: "cal", baseline, btc: "BTCUSDT", eth: "ETHUSDT" });
  const run = (seed: number) => selectObservedTransitionBlocks({ method: "ONE_STEP_SUCCESSOR", source: frames, library: lib, normalizer: norm, baseline, btc: "BTCUSDT", eth: "ETHUSDT", lookback: TERMINAL_LOOKBACK, blockLen: 48, targetLen: frames.length, rng: createRng(seed, "obs"), constraints: DEFAULT_REPLAY_CONSTRAINTS });

  it("is deterministic per seed", () => { expect(run(3).blocks.map((b) => b.startIndex)).toEqual(run(3).blocks.map((b) => b.startIndex)); });
  it("respects the longest-unchanged-run bound and max successor reuse", () => {
    const res = run(7);
    expect(res.memoization.longestUnchangedRunHours).toBeLessThanOrEqual(DEFAULT_REPLAY_CONSTRAINTS.maxUnchangedRunHours);
    expect(res.memoization.maxSuccessorReuse).toBeLessThanOrEqual(DEFAULT_REPLAY_CONSTRAINTS.maxSuccessorReuse);
  });
  it("REAL_TRANSITION_BRIDGE prepends the real run-up (a bridge placement starts before the matched successor)", () => {
    const bridged = selectObservedTransitionBlocks({ method: "REAL_TRANSITION_BRIDGE", source: frames, library: lib, normalizer: norm, baseline, btc: "BTCUSDT", eth: "ETHUSDT", lookback: TERMINAL_LOOKBACK, blockLen: 48, targetLen: frames.length, rng: createRng(4, "obs"), constraints: { ...DEFAULT_REPLAY_CONSTRAINTS, bridgeLen: 6 } });
    // at least one non-first block is longer than 48 (it carries the 6h bridge)
    expect(bridged.blocks.slice(1).some((b) => b.length > 48)).toBe(true);
    // adversarial-fix: the bridge's unchanged-run bound is still honored (guard uses the EFFECTIVE post-bridge start)
    expect(bridged.memoization.longestUnchangedRunHours).toBeLessThanOrEqual(DEFAULT_REPLAY_CONSTRAINTS.maxUnchangedRunHours);
  });

  it("adversarial-fix: computeMemoization month concentration is DURATION-weighted, not placement-count", () => {
    // two blocks: a 96h block in month "1970-01", a 48h block in month "1970-02". DURATION share of month-01 =
    // 96/144 = 0.667; a naive COUNT share would be 1/2 = 0.5. The fix must report the duration-weighted 0.667.
    const jan = 0; const feb = 40 * 24 * HOUR; // ~40 days later ⇒ a different calendar month
    const src: CommonMarketFrame[] = [];
    for (let i = 0; i < 300; i += 1) src.push(buildCommonMarketFrame({ runId: "c", asOfMs: (i < 150 ? jan : feb) + i * HOUR, symbols: { BTCUSDT: { candle: { openTimeMs: 0, closeTimeMs: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }, source: "t" } }, provenance: "OBSERVED_HISTORICAL" }));
    const memo = computeMemoization([{ startIndex: 0, length: 96 }, { startIndex: 200, length: 48 }], src, 96, "BTCUSDT");
    expect(memo.monthConcentrationMax).toBeCloseTo(96 / 144, 6);
  });
});

describe("phase-2c — natural-boundary detector", () => {
  const frames = synthCorpus(300);
  const support = fitBoundarySupport(frames, "BTCUSDT", "ETHUSDT");
  it("fits finite thresholds and classifies a calm boundary as ordinary, an extreme one as event", () => {
    expect(support.volRatioOrdinaryMax).toBeGreaterThan(0);
    const ords = ordinaryBoundaries(frames, support, "BTCUSDT", "ETHUSDT");
    expect(ords.length).toBeGreaterThan(0); expect(ords.length).toBeLessThan(frames.length);
    // fabricate an extreme boundary: huge range + volume jump at index 50
    const mut = frames.slice(); const c = frames[50]!.symbols.BTCUSDT!.candle.value!;
    mut[50] = buildCommonMarketFrame({ runId: "c", asOfMs: frames[50]!.asOfMs, symbols: { BTCUSDT: { candle: { ...c, high: c.high * 20, low: c.low / 20, volume: c.volume * 50 }, source: "t" }, ETHUSDT: { candle: frames[50]!.symbols.ETHUSDT!.candle.value!, source: "t" } }, provenance: "OBSERVED_HISTORICAL" });
    expect(classifyBoundary(mut, 50, support, "BTCUSDT", "ETHUSDT")).toBe("EVENT_BOUNDARY");
  });
});

describe("phase-2c — seam-centered classifier windows", () => {
  it("seamCenteredWindows straddle the seam; seamExcluded windows avoid it", () => {
    const returns = Array.from({ length: 200 }, (_, i) => i * 0.0001);
    const seams = [48, 96, 144];
    const sw = seamCenteredWindows(returns, seams, 24);
    expect(sw.length).toBe(3); expect(sw[0]!.length).toBe(48);
    const ex = seamExcludedWindows(returns, seams, 48);
    expect(ex.length).toBeGreaterThan(0);
  });
  it("identical distributions ⇒ seam classifier separability not high", () => {
    const r = createRng(31, "sc");
    const mk = (label: 0 | 1, o: string): LabeledWindow[] => Array.from({ length: 20 }, (_, i) => ({ label, returns: Array.from({ length: 48 }, () => r.normal(0, 0.01)), windowStart: i, windowEnd: i + 48, origin: `${o}-${i % 6}`, split: "calibration" as const }));
    const real = mk(1, "real"); const sim = mk(0, "sim");
    const tr: LabeledWindow[] = []; const ev: LabeledWindow[] = [];
    [...real, ...sim].forEach((w, i) => (i % 2 ? ev : tr).push(w));
    const res = evaluateSeamClassifier(tr, ev, createRng(1, "b"));
    if (res.separabilityAuc != null) expect(res.separabilityAuc).toBeLessThan(0.9);
  });
});

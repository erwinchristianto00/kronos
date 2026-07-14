/**
 * Phase-2C runner — replace arbitrary block joins with historically-observed continuation / transition-bridge / real
 * adjacent-pair / natural-boundary methods, and test whether the residual seam artifact was caused by joining
 * INDEPENDENTLY-selected blocks. Offline, deterministic, report-only. No deploy, no CORTEX training, no VPS, no holdout
 * opened. The return-space reconstruction + the Phase-2B nearest-K baseline are frozen controls.
 *
 * Pipeline: load 2026 corpus + physical embargo → compatibility normalizer + continuation libraries + boundary support
 * (calibration only) → run A(2B baseline)/B/C/D/E/F × 20 seeds through the FROZEN return-space reconstruction → seam
 * realism (grouped CI + natural-baseline bootstrap) + replay-memoization + whole-path realism + PERIOD-MATCHED
 * seam-centered classifier + whole-path classifier → development acceptance gate.
 *
 * Usage: npx tsx scripts/sim-phase2c-run.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stableHash } from "../src/lib/replay-provenance.js";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { CsvKlinesHistoricalSource } from "../src/simulation/historical-market-source.js";
import { selectFixedLengthBlocks, assembleReturnSpaceBootstrapPath, type BlockRef, type BootstrapResult } from "../src/simulation/historical-block-bootstrap.js";
import { selectCompatibilityBlocks, precomputeInitialStates, buildTransitionKernel, DEFAULT_CONSTRAINTS } from "../src/simulation/compatibility-block-selection.js";
import { computeCalibrationVolumeBaseline, computeTerminalState, TERMINAL_LOOKBACK, type BlockTransitionState } from "../src/simulation/block-transition-state.js";
import { buildCompatibilityNormalizer } from "../src/simulation/block-compatibility.js";
import { buildContinuationLibrary, type HistoricalContinuationRecord } from "../src/simulation/historical-continuation-library.js";
import { selectObservedTransitionBlocks, DEFAULT_REPLAY_CONSTRAINTS, type ObservedMethod } from "../src/simulation/observed-transition-selection.js";
import { fitBoundarySupport, ordinaryBoundaries, boundaryClassCounts } from "../src/simulation/natural-boundary-detector.js";
import { naturalAdjacencyReject, computeSeamRealism } from "../src/simulation/seam-realism.js";
import { seamCenteredWindows, seamExcludedWindows, realTransitionWindows, evaluateSeamClassifier } from "../src/simulation/seam-realism-classifier.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import { assessRealism } from "../src/simulation/realism-assessment.js";
import { evaluateStylizedFacts } from "../src/simulation/realism-gate.js";
import { type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import { logReturns, mean, std } from "../src/simulation/calibration-metrics.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const API = join(import.meta.dirname, "..");
const KLINES_DIR = join(API, "artifacts/simulation/data/extracted/klines_1h");
const OUT = join(API, "artifacts/simulation/phase2c");
const SYMBOLS = ["BTCUSDT", "ETHUSDT"]; const BTC = "BTCUSDT"; const ETH = "ETHUSDT"; const HOUR = 3_600_000;
const PARTITIONS = { calibration: ["01", "02", "03"], development: ["04"], diagnostic: ["05"] };
const EMBARGO_HOURS = 48; const BLOCK_LEN = 48; const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1); const WINDOW = 48; const SEAM_HALF = 24;
// pre-registered gates (frozen, unchanged from 2B for seam; +seam-centered classifier is period-matched so a stricter 0.65 bar)
const GATES = { seamExcessMax: 0.10, seamRatioMax: 2.0, seamExcessCiLowerMax: 0.10, seamClassifierMax: 0.65, minStylizedPassRate: 0.5, depDistMax: 0.08, maxUnchangedRunHours: 144, minUniqueContinuation: 0.3, maxDupSeqRate: 0.05 };
const BRIDGE_LEN = 6; // pre-registered on cal+dev (see report); the bridge-length sweep is reported, not seed-selected.

function readFileOrNull(p: string): string | null { return existsSync(p) ? readFileSync(p, "utf8") : null; }
function sourceFor(runId: string, months: string[]): CsvKlinesHistoricalSource {
  return new CsvKlinesHistoricalSource({ runId, symbols: SYMBOLS, months, year: "2026", dir: join(KLINES_DIR, "__by_interval__"),
    readFile: (path) => { const m = path.match(/([A-Z]+)-1h-2026-(\d\d)/); if (!m) return null; const [, sym, mm] = m; return readFileOrNull(join(KLINES_DIR, sym!, "1h", `${sym}-1h-2026-${mm}`, `${sym}-1h-2026-${mm}.csv`)); } });
}
async function collect(src: CsvKlinesHistoricalSource): Promise<CommonMarketFrame[]> { const meta = src.describe(); const out: CommonMarketFrame[] = []; for await (const f of src.iterateFrames(meta.dateRangeMs ?? { startMs: 0, endMs: 0 })) out.push(f); return out; }
const closes = (frames: CommonMarketFrame[], sym: string): number[] => frames.map((f) => f.symbols[sym]?.candle.value?.close).filter((x): x is number => typeof x === "number");
const wicks = (frames: CommonMarketFrame[], sym: string): number[] => frames.map((f) => { const c = f.symbols[sym]?.candle.value; if (!c) return null; const r = c.high - c.low; return r > 0 ? (c.high - Math.max(c.open, c.close)) / r : 0; }).filter((x): x is number => x != null);
const volumes = (frames: CommonMarketFrame[], sym: string): number[] => frames.map((f) => f.symbols[sym]?.candle.value?.volume).filter((x): x is number => typeof x === "number");
function physicalEmbargo(frames: CommonMarketFrame[], hours: number): CommonMarketFrame[] { return frames.length <= 2 * hours ? [] : frames.slice(hours, frames.length - hours); }
function pearson(a: number[], b: number[]): number | null { const n = Math.min(a.length, b.length); if (n < 3) return null; const ma = mean(a.slice(0, n))!, mb = mean(b.slice(0, n))!; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i += 1) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; } return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null; }
const median = (xs: (number | null | undefined)[]): number | null => { const v = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };
function pushWindows(out: LabeledWindow[], returns: number[], label: 0 | 1, origin: string, split: LabeledWindow["split"]): void { for (let s = 0; s + WINDOW <= returns.length; s += WINDOW) out.push({ label, returns: returns.slice(s, s + WINDOW), windowStart: s, windowEnd: s + WINDOW, origin, split }); }

/** Natural-boundary continuation library: variable-length blocks (≥ minLen) that both START and END at ORDINARY
 *  (low-discontinuity) boundaries, so the artificial join happens where the real market had an ordinary transition. */
function buildNaturalLibrary(cal: CommonMarketFrame[], support: ReturnType<typeof fitBoundarySupport>, baseline: ReturnType<typeof computeCalibrationVolumeBaseline>, minLen: number, maxLen: number): HistoricalContinuationRecord[] {
  const ords = ordinaryBoundaries(cal, support, BTC, ETH); const ordSet = new Set(ords);
  const out: HistoricalContinuationRecord[] = [];
  for (const b of ords) {
    if (b < TERMINAL_LOOKBACK) continue;
    // extend to the first ORDINARY boundary that gives length ≥ minLen (cap at maxLen)
    let end = b + minLen; while (end < cal.length && end - b < maxLen && !ordSet.has(end)) end += 1;
    if (!ordSet.has(end) && end - b >= maxLen) end = b + maxLen; // fall back to a fixed cap if no ordinary boundary in range
    const len = end - b; if (len < minLen || b + len > cal.length) continue;
    const terminalState = computeTerminalState(cal, b - TERMINAL_LOOKBACK, TERMINAL_LOOKBACK, baseline, BTC, ETH, TERMINAL_LOOKBACK);
    out.push({ continuationId: `nat:${b}`, stateWindowStartMs: cal[b - TERMINAL_LOOKBACK]?.asOfMs ?? 0, stateWindowEndMs: cal[b - 1]?.asOfMs ?? 0, terminalState, successorStartMs: cal[b]?.asOfMs ?? 0, successorEndMs: cal[b + len - 1]?.asOfMs ?? 0, successorRef: { startIndex: b, length: len }, sourceMonth: new Date(cal[b]?.asOfMs ?? 0).toISOString().slice(0, 7), sourcePartition: "calibration", regimeBefore: terminalState.regimeFamily, regimeAfter: null, transitionMetrics: { volatilityRatio: null, volumeRatio: null, fundingJump: null, markBasisJump: null, btcEthVectorDiscontinuity: null } });
  }
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const cal = physicalEmbargo(await collect(sourceFor("cal", PARTITIONS.calibration)), EMBARGO_HOURS);
  const calBtcReal = logReturns(closes(cal, BTC)); const calEthReal = logReturns(closes(cal, ETH)); const calWickReal = wicks(cal, BTC); const calVolReal = volumes(cal, BTC);
  const baseline = computeCalibrationVolumeBaseline(cal, BTC);
  // normalizer + libraries + boundary support — CALIBRATION only
  const calTerminalStates: BlockTransitionState[] = []; for (let s = 0; s + BLOCK_LEN <= cal.length; s += 1) calTerminalStates.push(computeTerminalState(cal, s, BLOCK_LEN, baseline, BTC, ETH, TERMINAL_LOOKBACK));
  const normalizer = buildCompatibilityNormalizer(calTerminalStates);
  const lib48 = buildContinuationLibrary(cal, { lookback: TERMINAL_LOOKBACK, successorLen: 48, sourcePartition: "calibration", baseline, btc: BTC, eth: ETH });
  const lib96 = buildContinuationLibrary(cal, { lookback: TERMINAL_LOOKBACK, successorLen: 96, sourcePartition: "calibration", baseline, btc: BTC, eth: ETH });
  const boundarySupport = fitBoundarySupport(cal, BTC, ETH);
  const libNatural = buildNaturalLibrary(cal, boundarySupport, baseline, 24, 96);
  const boundaryCounts = boundaryClassCounts(cal, boundarySupport, BTC, ETH);
  // Phase-2B nearest-K infra (frozen control A)
  const candidateStarts: number[] = []; for (let s = 0; s + BLOCK_LEN <= cal.length; s += 1) candidateStarts.push(s);
  const initialStates = precomputeInitialStates(cal, candidateStarts, baseline, BTC, ETH);
  const kernel = buildTransitionKernel(cal, baseline, BTC, ETH, TERMINAL_LOOKBACK);

  const natural = naturalAdjacencyReject(cal, SYMBOLS);
  const seamRng = createRng(777, "seam-boot");
  const clfRng = createRng(888, "clf-boot");
  const realTransWindows = realTransitionWindows(calBtcReal, SEAM_HALF, WINDOW); // period-matched real transitions, NON-overlapping (stride=window) so train/eval never share samples

  const METHODS: { key: string; kind: "BASELINE" | ObservedMethod; lib?: HistoricalContinuationRecord[]; bridgeLen?: number }[] = [
    { key: "A_PHASE2B_NEAREST_K", kind: "BASELINE" },
    { key: "B_ONE_STEP_SUCCESSOR", kind: "ONE_STEP_SUCCESSOR", lib: lib48 },
    { key: "C_TOPK_SUCCESSOR", kind: "TOPK_SUCCESSOR", lib: lib48 },
    { key: "D_REAL_TRANSITION_BRIDGE", kind: "REAL_TRANSITION_BRIDGE", lib: lib48, bridgeLen: BRIDGE_LEN },
    { key: "E_ADJACENT_PAIR", kind: "ADJACENT_PAIR", lib: lib96 },
    { key: "F_NATURAL_BOUNDARY", kind: "NATURAL_BOUNDARY", lib: libNatural },
  ];

  const measurePath = (res: BootstrapResult) => {
    const inv = checkFrameStreamInvariants(res.frames, { expectSingleProvenance: true });
    const simBtc = logReturns(closes(res.frames, BTC)); const simEth = logReturns(closes(res.frames, ETH));
    const realism = assessRealism({ realReturns: calBtcReal, simReturns: simBtc, realWick: calWickReal, simWick: wicks(res.frames, BTC), realVolume: calVolReal, simVolume: volumes(res.frames, BTC) });
    const sf = evaluateStylizedFacts({ realReturns: calBtcReal, simReturns: simBtc });
    const depReal = pearson(calBtcReal, calEthReal); const depSim = pearson(simBtc, simEth);
    return { inv: inv.ok, simBtc, realism, sf, depDist: depReal != null && depSim != null ? Math.abs(depReal - depSim) : null };
  };
  const seamRecords = (res: BootstrapResult) => res.stitches.map((st, k) => ({ rejected: !st.accepted, reasons: st.reasons, group: new Date(cal[res.blocks[k]?.startIndex ?? 0]?.asOfMs ?? 0).toISOString().slice(0, 10) }));
  const seamReturnIndices = (blocks: BlockRef[]): number[] => { const idx: number[] = []; let cum = 0; for (let k = 0; k < blocks.length - 1; k += 1) { cum += blocks[k]!.length; idx.push(cum - 1); } return idx; };

  const methodResults: Record<string, unknown> = {};
  for (const m of METHODS) {
    const perSeed: Array<Record<string, unknown>> = []; const allSeamRecords: { rejected: boolean; reasons: string[]; group: string }[] = [];
    // seam-centered classifier windows POOLED across ALL 20 seeds (not seed-1 only — that would be a single arbitrary
    // draw / seed-selection bias). Each window's origin clusters adjacent windows (seed + chunk) for the grouped CI.
    const allSeamWins: { returns: number[]; origin: string }[] = []; const allExclWins: { returns: number[]; origin: string }[] = []; const allFullWins: { returns: number[]; origin: string }[] = [];
    for (const seed of SEEDS) {
      let res: BootstrapResult; let selDiag: Record<string, unknown> = {};
      if (m.kind === "BASELINE") {
        const sel = selectCompatibilityBlocks({ strategy: "NEAREST_K", frames: cal, candidateStarts, initialStates, normalizer, baseline, btc: BTC, eth: ETH, blockLen: BLOCK_LEN, targetLen: cal.length, lookback: TERMINAL_LOOKBACK, rng: createRng(seed, "sel/C_NEAREST_K"), constraints: DEFAULT_CONSTRAINTS, kernel });
        res = assembleReturnSpaceBootstrapPath(cal, sel.blocks, { runId: `${m.key}-${seed}`, symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "NEAREST_NEIGHBOR_CONTINUATION" });
        selDiag = { status: sel.status, insufficientSeams: sel.insufficientSeams, memoization: null };
      } else {
        const constraints = { ...DEFAULT_REPLAY_CONSTRAINTS, bridgeLen: m.bridgeLen ?? DEFAULT_REPLAY_CONSTRAINTS.bridgeLen, maxUnchangedRunHours: GATES.maxUnchangedRunHours };
        const sel = selectObservedTransitionBlocks({ method: m.kind, source: cal, library: m.lib!, normalizer, baseline, btc: BTC, eth: ETH, lookback: TERMINAL_LOOKBACK, blockLen: BLOCK_LEN, targetLen: cal.length, rng: createRng(seed, `obs/${m.key}`), constraints });
        res = assembleReturnSpaceBootstrapPath(cal, sel.blocks, { runId: `${m.key}-${seed}`, symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "NEAREST_NEIGHBOR_CONTINUATION" });
        selDiag = { status: sel.status, insufficientSeams: sel.insufficientSeams, memoization: sel.memoization };
      }
      const meas = measurePath(res); allSeamRecords.push(...seamRecords(res));
      const idx = seamReturnIndices(res.blocks);
      seamCenteredWindows(meas.simBtc, idx, SEAM_HALF).forEach((w, i) => allSeamWins.push({ returns: w, origin: `simseam-s${seed}-c${Math.floor(i / 4)}` }));
      seamExcludedWindows(meas.simBtc, idx, WINDOW).forEach((w, i) => allExclWins.push({ returns: w, origin: `simexcl-s${seed}-c${Math.floor(i / 4)}` }));
      for (let s = 0, c = 0; s + WINDOW <= meas.simBtc.length; s += WINDOW, c += 1) allFullWins.push({ returns: meas.simBtc.slice(s, s + WINDOW), origin: `simfull-s${seed}-c${Math.floor(c / 4)}` });
      perSeed.push({ seed, invariantsOk: meas.inv, hash: stableHash(res.frames.map((f) => f.frameId)).slice(0, 12), seamRejectRate: res.stitches.length ? res.rejectedBoundaries / res.stitches.length : 0, stylizedFactsPass: meas.sf.pass, depDist: meas.depDist, wasserstein: meas.realism.returnDistributionDistance, ...selDiag });
    }
    const seamRealism = computeSeamRealism(allSeamRecords, natural, seamRng);
    // period-matched seam-centered classifier (calibration real transitions vs POOLED sim seams from all 20 seeds).
    const mkLWpairs = (pairs: { returns: number[]; origin: string }[], label: 0 | 1): LabeledWindow[] => pairs.map((p, i) => ({ label, returns: p.returns, windowStart: i, windowEnd: i + p.returns.length, origin: p.origin, split: "calibration" as const }));
    const realLW: LabeledWindow[] = realTransWindows.map((w, i) => ({ label: 1, returns: w, windowStart: i, windowEnd: i + w.length, origin: `realtrans-c${Math.floor(i / 4)}`, split: "calibration" as const }));
    const splitEvalTrain = (real: LabeledWindow[], sim: LabeledWindow[]) => { const tr: LabeledWindow[] = []; const ev: LabeledWindow[] = []; real.forEach((w, i) => (i % 2 ? ev : tr).push(w)); sim.forEach((w, i) => (i % 2 ? ev : tr).push(w)); return { tr, ev }; };
    const seamClf = (() => { const { tr, ev } = splitEvalTrain(realLW, mkLWpairs(allSeamWins, 0)); return evaluateSeamClassifier(tr, ev, clfRng); })();
    const exclClf = (() => { const { tr, ev } = splitEvalTrain(realLW, mkLWpairs(allExclWins, 0)); return evaluateSeamClassifier(tr, ev, clfRng); })();
    const fullClf = (() => { const { tr, ev } = splitEvalTrain(realLW, mkLWpairs(allFullWins, 0)); return evaluateSeamClassifier(tr, ev, clfRng); })();
    // memoization aggregate (worst seed)
    const memos = perSeed.map((s) => s.memoization as ReturnType<typeof selectObservedTransitionBlocks>["memoization"] | null).filter(Boolean) as NonNullable<ReturnType<typeof selectObservedTransitionBlocks>["memoization"]>[];
    const memoWorst = memos.length ? { longestUnchangedRunHours: Math.max(...memos.map((x) => x.longestUnchangedRunHours)), maxSuccessorReuse: Math.max(...memos.map((x) => x.maxSuccessorReuse)), uniqueContinuationCoverage: Math.min(...memos.map((x) => x.uniqueContinuationCoverage)), monthConcentrationMax: Math.max(...memos.map((x) => x.monthConcentrationMax)), duplicateNHourSequenceRate: Math.max(...memos.map((x) => x.duplicateNHourSequenceRate)), returnVectorFingerprintDuplicates: Math.max(...memos.map((x) => x.returnVectorFingerprintDuplicates)) } : null;
    const seamRejects = perSeed.map((s) => s.seamRejectRate as number);
    methodResults[m.key] = {
      kind: m.kind, seeds: SEEDS.length,
      medianSeamRejectRate: median(seamRejects), meanSeamRejectRate: seamRejects.reduce((a, v) => a + v, 0) / seamRejects.length, worstSeamRejectRate: Math.max(...seamRejects), betweenSeedDispersion: std(seamRejects),
      seamRealism, stylizedFactsPassRate: perSeed.filter((s) => s.stylizedFactsPass).length / perSeed.length, allDeterministic: perSeed.every((s) => s.invariantsOk), medianDepDist: median(perSeed.map((s) => s.depDist as number | null)),
      seamClassifier: seamClf, seamExcludedClassifier: exclClf, fullPathClassifier: fullClf,
      memoizationWorst: memoWorst, insufficientSeamsTotal: perSeed.reduce((a, s) => a + (s.insufficientSeams as number ?? 0), 0), anyInsufficient: perSeed.some((s) => s.status === "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT"),
    };
  }

  // ── development acceptance gate ──
  const acceptance: Record<string, { pass: boolean; failures: string[] }> = {};
  for (const m of METHODS) {
    const r = methodResults[m.key] as Record<string, unknown>; const sr = r.seamRealism as ReturnType<typeof computeSeamRealism>; const memo = r.memoizationWorst as Record<string, number> | null; const sc = r.seamClassifier as ReturnType<typeof evaluateSeamClassifier>;
    const failures: string[] = [];
    if (!(r.allDeterministic as boolean)) failures.push("non-deterministic/invariant-fail");
    if ((r.stylizedFactsPassRate as number) < GATES.minStylizedPassRate) failures.push(`stylized-facts ${(r.stylizedFactsPassRate as number).toFixed(2)}<${GATES.minStylizedPassRate}`);
    if (sr.excessRejectRate > GATES.seamExcessMax) failures.push(`seam excess ${sr.excessRejectRate.toFixed(3)}>${GATES.seamExcessMax}`);
    if (sr.rejectRateRatio > GATES.seamRatioMax) failures.push(`seam ratio ${sr.rejectRateRatio.toFixed(2)}>${GATES.seamRatioMax}`);
    if (sr.excessConfidenceInterval[0] > GATES.seamExcessCiLowerMax) failures.push(`seam excess CI lower ${sr.excessConfidenceInterval[0].toFixed(3)}>${GATES.seamExcessCiLowerMax} (material systematic excess)`);
    if (sc.separabilityAuc != null && sc.separabilityAuc > GATES.seamClassifierMax) failures.push(`seam-centered classifier ${sc.separabilityAuc.toFixed(3)}>${GATES.seamClassifierMax}`);
    const dd = r.medianDepDist as number | null; if (dd != null && dd > GATES.depDistMax) failures.push(`dep dist ${dd.toFixed(3)}>${GATES.depDistMax}`);
    if (memo) { if (memo.longestUnchangedRunHours > GATES.maxUnchangedRunHours) failures.push(`unchanged run ${memo.longestUnchangedRunHours}h>${GATES.maxUnchangedRunHours}`); if (memo.uniqueContinuationCoverage < GATES.minUniqueContinuation) failures.push(`unique continuation ${memo.uniqueContinuationCoverage.toFixed(2)}<${GATES.minUniqueContinuation}`); if (memo.duplicateNHourSequenceRate > GATES.maxDupSeqRate) failures.push(`dup-seq ${memo.duplicateNHourSequenceRate.toFixed(3)}>${GATES.maxDupSeqRate}`); }
    if (r.anyInsufficient as boolean) failures.push("insufficient-transition-support on ≥1 seed");
    acceptance[m.key] = { pass: failures.length === 0, failures };
  }
  const anyPass = Object.values(acceptance).some((a) => a.pass);

  const results = {
    phase: "2C", generatedAtProcessingMs: t0, runtimeMs: Date.now() - t0, partitions: PARTITIONS, embargoHours: EMBARGO_HOURS, blockLen: BLOCK_LEN, seeds: SEEDS.length, gates: GATES, bridgeLen: BRIDGE_LEN,
    naturalAdjacency: { rate: natural.rate, n: natural.n }, boundaryClassCounts: boundaryCounts, librarySizes: { lib48: lib48.length, lib96: lib96.length, natural: libNatural.length }, ordinaryBoundaryCount: ordinaryBoundaries(cal, boundarySupport, BTC, ETH).length,
    methodResults, acceptance, anyMethodPassesDevelopment: anyPass,
    stopStatus: anyPass ? "DEVELOPMENT_REALISM_PASS_awaiting_freeze_then_unseen_holdout" : "NO_METHOD_PASSES_DEVELOPMENT_stop_no_holdout",
    determinismCheck: stableHash(methodResults).slice(0, 16),
  };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));

  console.log(`Phase-2C run OK. calFrames=${cal.length} natural adjacency reject=${(natural.rate * 100).toFixed(1)}% | libraries lib48=${lib48.length} lib96=${lib96.length} natural=${libNatural.length} ordinaryBoundaries=${results.ordinaryBoundaryCount}`);
  console.log(`boundary classes: ${JSON.stringify(boundaryCounts)}`);
  for (const m of METHODS) {
    const r = methodResults[m.key] as Record<string, unknown>; const sr = r.seamRealism as ReturnType<typeof computeSeamRealism>; const sc = r.seamClassifier as ReturnType<typeof evaluateSeamClassifier>; const memo = r.memoizationWorst as Record<string, number> | null;
    console.log(`  ${m.key}: excess=${sr.excessRejectRate.toFixed(3)} ratio=${sr.rejectRateRatio.toFixed(2)} excessCI=[${sr.excessConfidenceInterval[0].toFixed(3)},${sr.excessConfidenceInterval[1].toFixed(3)}] seamClf=${sc.separabilityAuc?.toFixed(3) ?? "na"} sfPass=${(r.stylizedFactsPassRate as number).toFixed(2)} unchRun=${memo?.longestUnchangedRunHours ?? "na"}h uniqCont=${memo?.uniqueContinuationCoverage?.toFixed(2) ?? "na"} insuff=${r.insufficientSeamsTotal} => ${acceptance[m.key]!.pass ? "PASS" : "FAIL[" + acceptance[m.key]!.failures.join("; ") + "]"}`);
  }
  console.log(`STOP: ${results.stopStatus}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

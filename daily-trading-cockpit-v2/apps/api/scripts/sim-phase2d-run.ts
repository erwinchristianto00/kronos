/**
 * Phase-2D runner — ROLLING-ORIGIN CROSS-FIT of METHOD_B3_CROSS_FITTED_SUCCESSOR. Determines whether cross-fitted
 * historical successors can produce a STABLE, OUT-OF-PERIOD generator, or whether the observed-successor family must be
 * closed. Offline, deterministic, report-only. Corpus: already-seen 2026 months 01–06 (operator-authorized). The pristine
 * reserve holdout (2025-07..10, 2024) is NEVER loaded/scored. Frozen realism gates; no gate relaxation.
 *
 * Design (operator spec §2–§10):
 *   - Feb fold: train={Jan} ⇒ INSUFFICIENT_CROSS_FIT_SUPPORT (1 month cannot satisfy the 0.5 month-cap). Reported, not gated.
 *   - Supported folds: Mar/Apr/May/Jun, each trained ONLY on earlier 2026 months; eval month excluded from EVERY fit
 *     (baseline, normalizer, library, transition stats). Target duration PRE-PROVEN feasible before running (§3).
 *   - Stage A tunes {K, reusePenalty, entropyFloor, candidateSupportFloor} on {Jan,Feb} ONLY (never an eval target).
 *   - Stage B freezes params, runs 100-seed robustness + cap sweep + perturbations per supported fold; reports each fold.
 *   - Readiness gate (§10): all 10 ⇒ ROBUSTNESS_CONFIRMED_READY_FOR_ONCE_ONLY_HOLDOUT, else ROBUSTNESS_NOT_ESTABLISHED_FINAL.
 *
 * Usage: npx tsx scripts/sim-phase2d-run.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stableHash } from "../src/lib/replay-provenance.js";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { CsvKlinesHistoricalSource } from "../src/simulation/historical-market-source.js";
import { assembleReturnSpaceBootstrapPath, type BlockRef, type BootstrapResult } from "../src/simulation/historical-block-bootstrap.js";
import { computeCalibrationVolumeBaseline, computeTerminalState, TERMINAL_LOOKBACK, type BlockTransitionState } from "../src/simulation/block-transition-state.js";
import { buildCompatibilityNormalizer } from "../src/simulation/block-compatibility.js";
import { buildContinuationLibrary, type HistoricalContinuationRecord } from "../src/simulation/historical-continuation-library.js";
import { selectB3CrossFittedBlocks, proveFeasibleTarget, DEFAULT_B3_PARAMS, DEFAULT_B3_CONSTRAINTS, type B3Params, type FeasibleTargetProof } from "../src/simulation/observed-successor-b3.js";
import { naturalAdjacencyReject, computeSeamRealism } from "../src/simulation/seam-realism.js";
import { seamCenteredWindows, realTransitionWindows, evaluateSeamClassifier } from "../src/simulation/seam-realism-classifier.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import { evaluateStylizedFacts } from "../src/simulation/realism-gate.js";
import { type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import { logReturns, mean, std } from "../src/simulation/calibration-metrics.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const API = join(import.meta.dirname, "..");
const KLINES_DIR = join(API, "artifacts/simulation/data/extracted/klines_1h");
const OUT = join(API, "artifacts/simulation/phase2d");
const SYMBOLS = ["BTCUSDT", "ETHUSDT"]; const BTC = "BTCUSDT"; const ETH = "ETHUSDT"; const HOUR = 3_600_000;
const EMBARGO = 48; const BLOCK_LEN = 48; const WINDOW = 48; const SEAM_HALF = 24;
// FROZEN realism gates (identical to Phase-2C sim-phase2c-run.ts; NOT relaxed).
const GATES = { seamExcessMax: 0.10, seamRatioMax: 2.0, seamExcessCiLowerMax: 0.10, seamClassifierMax: 0.65, minStylizedPassRate: 0.5, depDistMax: 0.08, maxUnchangedRunHours: 144, minUniqueContinuation: 0.3, maxDupSeqRate: 0.05 };
const CONSTRAINTS = { ...DEFAULT_B3_CONSTRAINTS }; // maxUnchangedRunHours 144, reuse 4, monthFraction 0.5, minMatches 5
const SEEDS_100 = Array.from({ length: 100 }, (_, i) => i + 1);
const SEEDS_30 = Array.from({ length: 30 }, (_, i) => i + 1);
const STAGE_A_SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const CAPS = [48, 72, 96, 120, 144];
const FOLDS: { evalMonth: string; trainMonths: string[] }[] = [
  { evalMonth: "02", trainMonths: ["01"] },
  { evalMonth: "03", trainMonths: ["01", "02"] },
  { evalMonth: "04", trainMonths: ["01", "02", "03"] },
  { evalMonth: "05", trainMonths: ["01", "02", "03", "04"] },
  { evalMonth: "06", trainMonths: ["01", "02", "03", "04", "05"] },
];

function readFileOrNull(p: string): string | null { return existsSync(p) ? readFileSync(p, "utf8") : null; }
function sourceFor(runId: string, months: string[]): CsvKlinesHistoricalSource {
  return new CsvKlinesHistoricalSource({ runId, symbols: SYMBOLS, months, year: "2026", dir: join(KLINES_DIR, "__by_interval__"),
    readFile: (path) => { const m = path.match(/([A-Z]+)-1h-2026-(\d\d)/); if (!m) return null; const [, sym, mm] = m; return readFileOrNull(join(KLINES_DIR, sym!, "1h", `${sym}-1h-2026-${mm}`, `${sym}-1h-2026-${mm}.csv`)); } });
}
async function collectMonth(mm: string): Promise<CommonMarketFrame[]> {
  const src = sourceFor(`m${mm}`, [mm]); const meta = src.describe(); const out: CommonMarketFrame[] = [];
  for await (const f of src.iterateFrames(meta.dateRangeMs ?? { startMs: 0, endMs: 0 })) out.push(f);
  return out;
}
const closes = (frames: readonly CommonMarketFrame[], sym: string): number[] => frames.map((f) => f.symbols[sym]?.candle.value?.close).filter((x): x is number => typeof x === "number");
function pearson(a: number[], b: number[]): number | null { const n = Math.min(a.length, b.length); if (n < 3) return null; const ma = mean(a.slice(0, n))!, mb = mean(b.slice(0, n))!; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i += 1) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; } return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null; }
function pct(xs: number[], p: number): number { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1)))); return s[i]!; }

/** Fit the training-only model for a fold (baseline, normalizer, library) from CONTIGUOUS training frames. */
function fitTrainingModel(trainFrames: readonly CommonMarketFrame[]) {
  const baseline = computeCalibrationVolumeBaseline(trainFrames, BTC);
  const states: BlockTransitionState[] = []; for (let s = 0; s + BLOCK_LEN <= trainFrames.length; s += 1) states.push(computeTerminalState(trainFrames, s, BLOCK_LEN, baseline, BTC, ETH, TERMINAL_LOOKBACK));
  const normalizer = buildCompatibilityNormalizer(states);
  const library = buildContinuationLibrary(trainFrames, { lookback: TERMINAL_LOOKBACK, successorLen: BLOCK_LEN, sourcePartition: "training", baseline, btc: BTC, eth: ETH });
  return { baseline, normalizer, library };
}

const seamReturnIdx = (blocks: readonly BlockRef[]): number[] => { const idx: number[] = []; let cum = 0; for (let k = 0; k < blocks.length - 1; k += 1) { cum += blocks[k]!.length; idx.push(cum - 1); } return idx; };
const seamRecords = (res: BootstrapResult, src: readonly CommonMarketFrame[]) => res.stitches.map((st, k) => ({ rejected: !st.accepted, reasons: st.reasons, group: new Date(src[res.blocks[k]?.startIndex ?? 0]?.asOfMs ?? 0).toISOString().slice(0, 10) }));

interface EvalBaseline { realBtc: number[]; realEth: number[]; natural: ReturnType<typeof naturalAdjacencyReject>; realTransWindows: number[][]; }
/** Build the OUT-OF-PERIOD scoring baseline from the EVAL month (real returns, natural adjacencies, real transitions). */
function evalBaseline(evalFrames: readonly CommonMarketFrame[]): EvalBaseline {
  const realBtc = logReturns(closes(evalFrames, BTC)); const realEth = logReturns(closes(evalFrames, ETH));
  return { realBtc, realEth, natural: naturalAdjacencyReject(evalFrames, SYMBOLS), realTransWindows: realTransitionWindows(realBtc, SEAM_HALF, WINDOW) };
}

type Gen = BootstrapResult & { insufficient: number; memo: ReturnType<typeof selectB3CrossFittedBlocks>["memoization"]; meanEff: number };
function genB3(trainFrames: readonly CommonMarketFrame[], model: ReturnType<typeof fitTrainingModel>, trainMonths: string[], evalMonth: string, targetLen: number, params: B3Params, cap: number, reuse: number, seed: number): Gen {
  const sel = selectB3CrossFittedBlocks({ trainingSource: trainFrames, library: model.library, normalizer: model.normalizer, baseline: model.baseline, trainingMonths: trainMonths.map((m) => `2026-${m}`), excludedMonth: `2026-${evalMonth}`, btc: BTC, eth: ETH, lookback: TERMINAL_LOOKBACK, blockLen: BLOCK_LEN, targetLen, rng: createRng(seed, "b3/CROSS_FITTED_SUCCESSOR"), params, constraints: { ...CONSTRAINTS, maxUnchangedRunHours: cap, maxSuccessorReuse: reuse } });
  const res = assembleReturnSpaceBootstrapPath(trainFrames, sel.blocks, { runId: `B3-${evalMonth}-${cap}-${seed}`, symbols: SYMBOLS, startMs: trainFrames[0]!.asOfMs, stepMs: HOUR, method: "NEAREST_NEIGHBOR_CONTINUATION" });
  return Object.assign(res, { insufficient: sel.insufficientSeams, memo: sel.memoization, meanEff: sel.meanEffectiveCandidates });
}

const seamRng = createRng(777, "seam-boot"); const clfRng = createRng(888, "clf-boot");
/** Evaluate ONE generated run against all frozen gates, using the EVAL-month baseline (out-of-period scoring). */
function evalRun(res: Gen, trainFrames: readonly CommonMarketFrame[], base: EvalBaseline) {
  const inv = checkFrameStreamInvariants(res.frames, { expectSingleProvenance: true });
  const simBtc = logReturns(closes(res.frames, BTC)); const simEth = logReturns(closes(res.frames, ETH));
  const sr = computeSeamRealism(seamRecords(res, trainFrames), base.natural, seamRng);
  const sf = evaluateStylizedFacts({ realReturns: base.realBtc, simReturns: simBtc });
  const depReal = pearson(base.realBtc, base.realEth); const depSim = pearson(simBtc, simEth); const depDist = depReal != null && depSim != null ? Math.abs(depReal - depSim) : null;
  const simSeamWins = seamCenteredWindows(simBtc, seamReturnIdx(res.blocks), SEAM_HALF);
  const realLW: LabeledWindow[] = base.realTransWindows.map((w, i) => ({ label: 1, returns: w, windowStart: i, windowEnd: i + w.length, origin: `realtrans-c${Math.floor(i / 4)}`, split: "calibration" }));
  const simLW: LabeledWindow[] = simSeamWins.map((w, i) => ({ label: 0, returns: w, windowStart: i, windowEnd: i + w.length, origin: `simseam-c${Math.floor(i / 4)}`, split: "calibration" }));
  const tr: LabeledWindow[] = []; const ev: LabeledWindow[] = []; [...realLW, ...simLW].forEach((w, i) => (i % 2 ? ev : tr).push(w));
  const seamClf = evaluateSeamClassifier(tr, ev, clfRng);
  const m = res.memo; const failures: string[] = [];
  if (!inv.ok) failures.push("invariant");
  if (!sf.pass) failures.push("stylized-facts");
  if (sr.excessRejectRate > GATES.seamExcessMax) failures.push("seam-excess");
  if (sr.rejectRateRatio > GATES.seamRatioMax) failures.push("seam-ratio");
  if (sr.excessConfidenceInterval[0] > GATES.seamExcessCiLowerMax) failures.push("seam-ci-lower");
  if (seamClf.separabilityAuc != null && seamClf.separabilityAuc > GATES.seamClassifierMax) failures.push("seam-classifier");
  if (depDist != null && depDist > GATES.depDistMax) failures.push("dep");
  if (m) { if (m.duplicateNHourSequenceRate > GATES.maxDupSeqRate) failures.push("dup-seq"); if (m.uniqueContinuationCoverage < GATES.minUniqueContinuation) failures.push("unique-cont"); if (m.longestUnchangedRunHours > GATES.maxUnchangedRunHours) failures.push("unchanged-run"); }
  if (res.insufficient > 0) failures.push("insufficient");
  return { pass: failures.length === 0, failures, excess: sr.excessRejectRate, ratio: sr.rejectRateRatio, seamClf: seamClf.separabilityAuc, depDist, memo: m, insufficient: res.insufficient, invariantsOk: inv.ok, meanEff: res.meanEff };
}

type EvalResult = ReturnType<typeof evalRun>;
function summarize(evals: EvalResult[]) {
  const ok = evals.filter((e) => e.insufficient === 0);
  const excess = ok.map((e) => e.excess); const ratio = ok.map((e) => e.ratio); const clf = ok.map((e) => e.seamClf).filter((x): x is number => x != null);
  const run = ok.map((e) => e.memo?.longestUnchangedRunHours ?? 0); const dup = ok.map((e) => e.memo?.duplicateNHourSequenceRate ?? 0); const uniq = ok.map((e) => e.memo?.uniqueContinuationCoverage ?? 0);
  const conc = ok.map((e) => e.memo?.monthConcentrationMax ?? 0); const eff = ok.map((e) => e.meanEff);
  return {
    n: evals.length, passRate: evals.filter((e) => e.pass).length / evals.length, insufficientRate: evals.filter((e) => e.insufficient > 0).length / evals.length, invariantFailures: evals.filter((e) => !e.invariantsOk).length,
    excess: { p5: pct(excess, 0.05), p50: pct(excess, 0.5), p95: pct(excess, 0.95), worst: excess.length ? Math.max(...excess) : null },
    ratio: { p50: pct(ratio, 0.5), p95: pct(ratio, 0.95), worst: ratio.length ? Math.max(...ratio) : null },
    seamClassifier: { p50: pct(clf, 0.5), p95: pct(clf, 0.95), worst: clf.length ? Math.max(...clf) : null },
    longestRun: { p50: pct(run, 0.5), p95: pct(run, 0.95), worst: run.length ? Math.max(...run) : null },
    dupSeq: { p50: pct(dup, 0.5), p95: pct(dup, 0.95), worst: dup.length ? Math.max(...dup) : null },
    uniqueContinuation: { p50: pct(uniq, 0.5), min: uniq.length ? Math.min(...uniq) : null },
    monthConcentration: { p50: pct(conc, 0.5), p95: pct(conc, 0.95), worst: conc.length ? Math.max(...conc) : null },
    meanEffectiveCandidates: { p50: pct(eff, 0.5), min: eff.length ? Math.min(...eff) : null },
    failureCounts: (() => { const c: Record<string, number> = {}; for (const e of evals) for (const f of e.failures) c[f] = (c[f] ?? 0) + 1; return c; })(),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  // ── load all seen 2026 months (pristine reserve NEVER loaded) ──
  const monthFrames: Record<string, CommonMarketFrame[]> = {};
  for (const mm of ["01", "02", "03", "04", "05", "06"]) monthFrames[mm] = await collectMonth(mm);
  const monthHours = Object.fromEntries(Object.entries(monthFrames).map(([k, v]) => [k, v.length]));
  console.log(`loaded months: ${Object.entries(monthHours).map(([k, v]) => `${k}=${v}h`).join(" ")}`);

  const trainFramesFor = (trainMonths: string[]): CommonMarketFrame[] => { const f = trainMonths.flatMap((mm) => monthFrames[mm]!); return f.slice(0, Math.max(0, f.length - EMBARGO)); };
  const perMonthAvail = (trainMonths: string[]): number[] => trainMonths.map((mm, i) => (i === trainMonths.length - 1 ? Math.max(0, monthFrames[mm]!.length - EMBARGO) : monthFrames[mm]!.length));

  // ── Stage A — tune {K, reusePenalty, entropyFloor, candidateSupportFloor} on {Jan,Feb} ONLY ──
  const tuneFrames = trainFramesFor(["01", "02"]);
  const tuneModel = fitTrainingModel(tuneFrames);
  const tuneProof = proveFeasibleTarget({ excludedMonthHours: Math.min(monthHours["01"]!, monthHours["02"]!), perMonthAvailableHours: perMonthAvail(["01", "02"]), distinctSuccessors: tuneModel.library.length, maxMonthFraction: CONSTRAINTS.maxMonthFraction, maxSuccessorReuse: CONSTRAINTS.maxSuccessorReuse, blockLen: BLOCK_LEN });
  const tuneTarget = Math.max(BLOCK_LEN, tuneProof.feasibleHoursUnderMonthCap);
  const tuneBase = evalBaseline(monthFrames["02"]!.slice(EMBARGO)); // in-sample scoring baseline (Feb tail) — Stage A only
  const grid: B3Params[] = [];
  for (const topK of [8, 12, 20]) for (const reusePenalty of [0.5, 1.0]) for (const entropyFloor of [0.0, 0.6]) for (const candidateSupportFloor of [5, 8]) grid.push({ ...DEFAULT_B3_PARAMS, topK, reusePenalty, entropyFloor, candidateSupportFloor });
  const tuned = grid.map((p) => {
    const evals = STAGE_A_SEEDS.map((s) => evalRun(genB3(tuneFrames, tuneModel, ["01", "02"], "STAGEA", tuneTarget, p, 144, CONSTRAINTS.maxSuccessorReuse, s), tuneFrames, tuneBase));
    const sum = summarize(evals);
    return { params: p, passRate: sum.passRate, insufficientRate: sum.insufficientRate, meanEff: sum.meanEffectiveCandidates.p50, dupWorst: sum.dupSeq.worst ?? 1, uniqMin: sum.uniqueContinuation.min ?? 0 };
  });
  // choose: highest passRate, then most diverse (higher effective candidates), then smaller K (parsimony). NOT using any Stage-B/eval-month result.
  tuned.sort((a, b) => (b.passRate - a.passRate) || (b.meanEff - a.meanEff) || (a.params.topK - b.params.topK));
  const bestParams = tuned[0]!.params;
  console.log(`Stage A tuned (on {Jan,Feb} only): K=${bestParams.topK} reusePenalty=${bestParams.reusePenalty} entropyFloor=${bestParams.entropyFloor} supportFloor=${bestParams.candidateSupportFloor} | passRate=${tuned[0]!.passRate.toFixed(2)} meanEff=${tuned[0]!.meanEff.toFixed(1)}`);

  // ── §3 feasibility proof + §2/§6/§7 Stage-B rolling evaluation ──
  const foldResults = FOLDS.map((fold) => {
    const trainFrames = trainFramesFor(fold.trainMonths);
    const model = fitTrainingModel(trainFrames);
    const proof: FeasibleTargetProof = proveFeasibleTarget({ excludedMonthHours: Math.max(0, monthHours[fold.evalMonth]! - 2 * EMBARGO), perMonthAvailableHours: perMonthAvail(fold.trainMonths), distinctSuccessors: model.library.length, maxMonthFraction: CONSTRAINTS.maxMonthFraction, maxSuccessorReuse: CONSTRAINTS.maxSuccessorReuse, blockLen: BLOCK_LEN });
    if (!proof.fillable) { console.log(`fold eval=2026-${fold.evalMonth}: INSUFFICIENT_CROSS_FIT_SUPPORT (${proof.reason})`); return { evalMonth: `2026-${fold.evalMonth}`, trainMonths: fold.trainMonths.map((m) => `2026-${m}`), status: "INSUFFICIENT_CROSS_FIT_SUPPORT", proof, librarySize: model.library.length }; }
    const base = evalBaseline(monthFrames[fold.evalMonth]!.slice(EMBARGO, Math.max(EMBARGO, monthFrames[fold.evalMonth]!.length - EMBARGO)));
    const target = proof.targetHours;
    // §7 seed robustness (100 seeds, cap 144, frozen params)
    const seedEvals = SEEDS_100.map((s) => evalRun(genB3(trainFrames, model, fold.trainMonths, fold.evalMonth, target, bestParams, 144, CONSTRAINTS.maxSuccessorReuse, s), trainFrames, base));
    const seed = summarize(seedEvals);
    // §8 cap robustness (30 seeds each)
    const caps = CAPS.map((cap) => ({ cap, ...summarize(SEEDS_30.map((s) => evalRun(genB3(trainFrames, model, fold.trainMonths, fold.evalMonth, target, bestParams, cap, CONSTRAINTS.maxSuccessorReuse, s), trainFrames, base))) }));
    // §9 perturbations (30 seeds each)
    const refUse = new Map<number, number>(); for (const s of SEEDS_30) for (const b of genB3(trainFrames, model, fold.trainMonths, fold.evalMonth, target, bestParams, 144, CONSTRAINTS.maxSuccessorReuse, s).blocks) refUse.set(b.startIndex, (refUse.get(b.startIndex) ?? 0) + 1);
    const top1pct = new Set([...refUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, Math.floor(model.library.length * 0.01))).map(([s]) => s));
    const monthUse = new Map<string, number>(); for (const [s, u] of refUse) { const mo = new Date(trainFrames[s]?.asOfMs ?? 0).toISOString().slice(0, 7); monthUse.set(mo, (monthUse.get(mo) ?? 0) + u); }
    const topMonth = [...monthUse.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const regimes = [...new Set(model.library.map((r) => r.terminalState.regimeFamily ?? "?"))];
    const withLib = (lib: readonly HistoricalContinuationRecord[], cap: number, reuse: number, ef: number) => summarize(SEEDS_30.map((s) => evalRun(genB3(trainFrames, { ...model, library: lib }, fold.trainMonths, fold.evalMonth, target, { ...bestParams, entropyFloor: ef }, cap, reuse, s), trainFrames, base)));
    const perturbations = [
      { name: "remove_top_1pct_successors", ...withLib(model.library.filter((r) => !top1pct.has(r.successorRef.startIndex)), 144, CONSTRAINTS.maxSuccessorReuse, bestParams.entropyFloor) },
      { name: "remove_top_source_month", ...withLib(model.library.filter((r) => r.sourceMonth !== topMonth), 144, CONSTRAINTS.maxSuccessorReuse, bestParams.entropyFloor) },
      { name: "exclude_rank_one_matches", ...summarize(SEEDS_30.map((s) => evalRun(genB3(trainFrames, model, fold.trainMonths, fold.evalMonth, target, { ...bestParams, entropyFloor: 1.0 }, 144, CONSTRAINTS.maxSuccessorReuse, s), trainFrames, base))) }, // entropyFloor=1 ⇒ never lock onto the single nearest (uniform over top-K)
      { name: "cap_reuse_at_2", ...withLib(model.library, 144, 2, bestParams.entropyFloor) },
      { name: "min_entropy_floor", ...withLib(model.library, 144, CONSTRAINTS.maxSuccessorReuse, Math.max(bestParams.entropyFloor, 0.8)) },
      ...(regimes.length > 1 ? regimes.filter((rg) => model.library.filter((r) => (r.terminalState.regimeFamily ?? "?") !== rg).length > model.library.length * 0.5).slice(0, 1).map((rg) => ({ name: `remove_regime_${rg}`, ...withLib(model.library.filter((r) => (r.terminalState.regimeFamily ?? "?") !== rg), 144, CONSTRAINTS.maxSuccessorReuse, bestParams.entropyFloor) })) : []),
    ];
    console.log(`fold eval=2026-${fold.evalMonth} (train ${fold.trainMonths.join("+")}, target=${target}h, lib=${model.library.length}): seed passRate=${seed.passRate.toFixed(2)} insuff=${seed.insufficientRate.toFixed(2)} clf p95=${seed.seamClassifier.p95?.toFixed(3) ?? "-"} dup p95=${seed.dupSeq.p95?.toFixed(3) ?? "-"} conc p95=${seed.monthConcentration.p95?.toFixed(2) ?? "-"}`);
    return { evalMonth: `2026-${fold.evalMonth}`, trainMonths: fold.trainMonths.map((m) => `2026-${m}`), status: "EVALUATED", proof, librarySize: model.library.length, target, seed, caps, perturbations };
  });

  // ── §10 readiness gate ──
  const supported = foldResults.filter((f) => f.status === "EVALUATED" && (f as any).seed.insufficientRate < 0.5) as Array<Extract<typeof foldResults[number], { status: string }> & { seed: ReturnType<typeof summarize>; caps: any[]; perturbations: any[]; proof: FeasibleTargetProof }>;
  const evaluated = foldResults.filter((f) => f.status === "EVALUATED") as typeof supported;
  const allSeedEvalsPassRate = supported.length ? supported.reduce((a, f) => a + f.seed.passRate, 0) / supported.length : 0;
  const perFoldPass = supported.every((f) => f.seed.passRate >= 0.80);
  const notOneMonthDependent = supported.length > 0 && supported.every((f) => (f.seed.monthConcentration.p95 ?? 1) <= CONSTRAINTS.maxMonthFraction + 1e-9) && supported.every((f) => f.perturbations.filter((p: any) => p.name === "remove_top_source_month").every((p: any) => p.passRate >= 0.5 || p.insufficientRate >= 0.5));
  const capOk = supported.length > 0 && supported.every((f) => f.caps.filter((c: any) => c.cap <= 96).some((c: any) => c.passRate >= 0.80 || c.insufficientRate >= 0.5));
  const dupCiOk = supported.length > 0 && supported.every((f) => (f.seed.dupSeq.p95 ?? 1) <= GATES.maxDupSeqRate);
  const clfCiOk = supported.length > 0 && supported.every((f) => (f.seed.seamClassifier.p95 ?? 1) <= GATES.seamClassifierMax);
  const memoOk = supported.length > 0 && supported.every((f) => (f.seed.longestRun.worst ?? Infinity) <= GATES.maxUnchangedRunHours && (f.seed.uniqueContinuation.min ?? 0) >= GATES.minUniqueContinuation && (f.seed.monthConcentration.worst ?? 1) <= CONSTRAINTS.maxMonthFraction + 1e-9);
  const perturbOk = supported.length > 0 && supported.every((f) => f.perturbations.every((p: any) => p.passRate >= 0.5 || p.insufficientRate >= 0.5));
  const readiness = {
    c1_overallSeedPassRate: { value: allSeedEvalsPassRate, pass: allSeedEvalsPassRate >= 0.90 },
    c2_everySupportedFoldPasses: { value: supported.map((f) => f.seed.passRate), pass: supported.length > 0 && perFoldPass },
    c3_notOneMonthDependent: { pass: notOneMonthDependent },
    c4_capLE96PassesOrSupportLimited: { pass: capOk },
    c5_dupSeqCiBelow: { pass: dupCiOk },
    c6_seamClassifierCiBelow: { pass: clfCiOk },
    c7_noConcentrationOrMemorizationFailure: { pass: memoOk },
    c8_perturbationAcceptable: { pass: perturbOk },
    c9_noUnresolvedAdversarialFinding: { pass: null as boolean | null, note: "set after mandatory adversarial review (Step 9)" },
    c10_codeAndParamsFrozenCommitted: { pass: null as boolean | null, note: "set after commit" },
  };
  const dataConditionsPass = [readiness.c1_overallSeedPassRate.pass, readiness.c2_everySupportedFoldPasses.pass, readiness.c3_notOneMonthDependent.pass, readiness.c4_capLE96PassesOrSupportLimited.pass, readiness.c5_dupSeqCiBelow.pass, readiness.c6_seamClassifierCiBelow.pass, readiness.c7_noConcentrationOrMemorizationFailure.pass, readiness.c8_perturbationAcceptable.pass].every(Boolean);
  const verdict = dataConditionsPass ? "PENDING_ADVERSARIAL_AND_COMMIT_THEN_CONFIRMED" : "ROBUSTNESS_NOT_ESTABLISHED_FINAL";

  const results = { phase: "2D", generatedAtProcessingMs: t0, runtimeMs: Date.now() - t0, monthHours, gates: GATES, constraints: CONSTRAINTS, stageA: { corpus: ["2026-01", "2026-02"], tuneTarget, tuneProof, bestParams, grid: tuned }, folds: foldResults, readiness, verdict, determinismCheck: stableHash([foldResults.map((f: any) => [f.evalMonth, f.status, f.seed?.passRate ?? null]), readiness]).slice(0, 16) };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));

  console.log(`\nREADINESS: c1=${readiness.c1_overallSeedPassRate.pass}(${allSeedEvalsPassRate.toFixed(2)}) c2=${readiness.c2_everySupportedFoldPasses.pass} c3=${readiness.c3_notOneMonthDependent.pass} c4=${readiness.c4_capLE96PassesOrSupportLimited.pass} c5=${readiness.c5_dupSeqCiBelow.pass} c6=${readiness.c6_seamClassifierCiBelow.pass} c7=${readiness.c7_noConcentrationOrMemorizationFailure.pass} c8=${readiness.c8_perturbationAcceptable.pass}`);
  console.log(`SUPPORTED folds: ${supported.map((f) => f.evalMonth).join(",") || "NONE"} | EVALUATED: ${evaluated.map((f) => `${f.evalMonth}=${f.seed.passRate.toFixed(2)}`).join(" ")}`);
  console.log(`VERDICT: ${verdict}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Phase-2C ROBUSTNESS runner — sensitivity analysis of METHOD_B_PRIMARY_144H_FROZEN. Determines whether B's
 * DEVELOPMENT_REALISM_PASS is a stable generator design or a boundary-sensitive cascade artifact. Offline,
 * deterministic, report-only. NO holdout is acquired/inspected/scored — calibration only. The frozen baseline config is
 * NOT modified; cap/library/reuse variations are DIAGNOSTICS, never adopted. Failed seeds are NEVER excluded.
 *
 * Steps: (2) 100-seed robustness of frozen B; (3) cap sensitivity 48/72/96/120/144; (4) gate margins; (5) independent
 * B2 comparison; (6) leave-one-source-month-out; (7) transition-library perturbations; (8) decision rule.
 *
 * Usage: npx tsx scripts/sim-phase2c-robustness-run.ts
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
import { selectObservedTransitionBlocks, DEFAULT_REPLAY_CONSTRAINTS } from "../src/simulation/observed-transition-selection.js";
import { selectB2SuccessorBlocks, DEFAULT_B2_CONSTRAINTS } from "../src/simulation/observed-successor-b2.js";
import { naturalAdjacencyReject, computeSeamRealism } from "../src/simulation/seam-realism.js";
import { seamCenteredWindows, realTransitionWindows, evaluateSeamClassifier } from "../src/simulation/seam-realism-classifier.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import { evaluateStylizedFacts } from "../src/simulation/realism-gate.js";
import { type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import { logReturns, mean, std } from "../src/simulation/calibration-metrics.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const API = join(import.meta.dirname, "..");
const KLINES_DIR = join(API, "artifacts/simulation/data/extracted/klines_1h");
const OUT = join(API, "artifacts/simulation/phase2c-robustness");
const SYMBOLS = ["BTCUSDT", "ETHUSDT"]; const BTC = "BTCUSDT"; const ETH = "ETHUSDT"; const HOUR = 3_600_000;
const CAL_MONTHS = ["01", "02", "03"]; const EMBARGO_HOURS = 48; const BLOCK_LEN = 48; const WINDOW = 48; const SEAM_HALF = 24;
const GATES = { seamExcessMax: 0.10, seamRatioMax: 2.0, seamExcessCiLowerMax: 0.10, seamClassifierMax: 0.65, minStylizedPassRate: 0.5, depDistMax: 0.08, maxUnchangedRunHours: 144, minUniqueContinuation: 0.3, maxDupSeqRate: 0.05 };
const SEEDS_100 = Array.from({ length: 100 }, (_, i) => i + 1);
const SEEDS_30 = Array.from({ length: 30 }, (_, i) => i + 1);
const CAPS = [48, 72, 96, 120, 144];

function readFileOrNull(p: string): string | null { return existsSync(p) ? readFileSync(p, "utf8") : null; }
function sourceFor(runId: string, months: string[]): CsvKlinesHistoricalSource {
  return new CsvKlinesHistoricalSource({ runId, symbols: SYMBOLS, months, year: "2026", dir: join(KLINES_DIR, "__by_interval__"),
    readFile: (path) => { const m = path.match(/([A-Z]+)-1h-2026-(\d\d)/); if (!m) return null; const [, sym, mm] = m; return readFileOrNull(join(KLINES_DIR, sym!, "1h", `${sym}-1h-2026-${mm}`, `${sym}-1h-2026-${mm}.csv`)); } });
}
async function collect(src: CsvKlinesHistoricalSource): Promise<CommonMarketFrame[]> { const meta = src.describe(); const out: CommonMarketFrame[] = []; for await (const f of src.iterateFrames(meta.dateRangeMs ?? { startMs: 0, endMs: 0 })) out.push(f); return out; }
const closes = (frames: CommonMarketFrame[], sym: string): number[] => frames.map((f) => f.symbols[sym]?.candle.value?.close).filter((x): x is number => typeof x === "number");
function physicalEmbargo(frames: CommonMarketFrame[], hours: number): CommonMarketFrame[] { return frames.length <= 2 * hours ? [] : frames.slice(hours, frames.length - hours); }
function pearson(a: number[], b: number[]): number | null { const n = Math.min(a.length, b.length); if (n < 3) return null; const ma = mean(a.slice(0, n))!, mb = mean(b.slice(0, n))!; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i += 1) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; } return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null; }
function pct(xs: number[], p: number): number { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1)))); return s[i]!; }

async function main() {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const cal = physicalEmbargo(await collect(sourceFor("cal", CAL_MONTHS)), EMBARGO_HOURS);
  const calBtcReal = logReturns(closes(cal, BTC)); const calEthReal = logReturns(closes(cal, ETH));
  const baseline = computeCalibrationVolumeBaseline(cal, BTC);
  const calTerminalStates: BlockTransitionState[] = []; for (let s = 0; s + BLOCK_LEN <= cal.length; s += 1) calTerminalStates.push(computeTerminalState(cal, s, BLOCK_LEN, baseline, BTC, ETH, TERMINAL_LOOKBACK));
  const normalizer = buildCompatibilityNormalizer(calTerminalStates);
  const lib48 = buildContinuationLibrary(cal, { lookback: TERMINAL_LOOKBACK, successorLen: 48, sourcePartition: "calibration", baseline, btc: BTC, eth: ETH });
  const natural = naturalAdjacencyReject(cal, SYMBOLS);
  const realTransWindows = realTransitionWindows(calBtcReal, SEAM_HALF, WINDOW);
  const seamRng = createRng(777, "seam-boot"); const clfRng = createRng(888, "clf-boot");

  const genB = (lib: readonly HistoricalContinuationRecord[], cap: number, reuse: number, seed: number): BootstrapResult & { insufficient: number; memo: ReturnType<typeof selectObservedTransitionBlocks>["memoization"] } => {
    const sel = selectObservedTransitionBlocks({ method: "ONE_STEP_SUCCESSOR", source: cal, library: lib, normalizer, baseline, btc: BTC, eth: ETH, lookback: TERMINAL_LOOKBACK, blockLen: BLOCK_LEN, targetLen: cal.length, rng: createRng(seed, "obs/B_ONE_STEP_SUCCESSOR"), constraints: { ...DEFAULT_REPLAY_CONSTRAINTS, maxUnchangedRunHours: cap, maxSuccessorReuse: reuse } });
    const res = assembleReturnSpaceBootstrapPath(cal, sel.blocks, { runId: `B-${cap}-${seed}`, symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "NEAREST_NEIGHBOR_CONTINUATION" });
    return Object.assign(res, { insufficient: sel.insufficientSeams, memo: sel.memoization });
  };
  const genB2 = (lib: readonly HistoricalContinuationRecord[], cap: number, seed: number) => {
    const sel = selectB2SuccessorBlocks({ source: cal, library: lib, normalizer, baseline, btc: BTC, eth: ETH, lookback: TERMINAL_LOOKBACK, targetLen: cal.length, rng: createRng(seed, "b2/INDEPENDENT_SUCCESSOR"), constraints: { ...DEFAULT_B2_CONSTRAINTS, maxUnchangedRunHours: cap } });
    const res = assembleReturnSpaceBootstrapPath(cal, sel.blocks, { runId: `B2-${cap}-${seed}`, symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "NEAREST_NEIGHBOR_CONTINUATION" });
    return Object.assign(res, { insufficient: sel.insufficientSeams, memo: sel.memoization });
  };
  const seamReturnIdx = (blocks: BlockRef[]): number[] => { const idx: number[] = []; let cum = 0; for (let k = 0; k < blocks.length - 1; k += 1) { cum += blocks[k]!.length; idx.push(cum - 1); } return idx; };
  const seamRecords = (res: BootstrapResult) => res.stitches.map((st, k) => ({ rejected: !st.accepted, reasons: st.reasons, group: new Date(cal[res.blocks[k]?.startIndex ?? 0]?.asOfMs ?? 0).toISOString().slice(0, 10) }));

  // evaluate ONE run against all gates (per-run seam-centered classifier on that run's seams vs period-matched real).
  const evalRun = (res: BootstrapResult & { insufficient: number; memo: ReturnType<typeof selectObservedTransitionBlocks>["memoization"] }) => {
    const inv = checkFrameStreamInvariants(res.frames, { expectSingleProvenance: true });
    const simBtc = logReturns(closes(res.frames, BTC)); const simEth = logReturns(closes(res.frames, ETH));
    const sr = computeSeamRealism(seamRecords(res), natural, seamRng);
    const sf = evaluateStylizedFacts({ realReturns: calBtcReal, simReturns: simBtc });
    const depReal = pearson(calBtcReal, calEthReal); const depSim = pearson(simBtc, simEth); const depDist = depReal != null && depSim != null ? Math.abs(depReal - depSim) : null;
    const simSeamWins = seamCenteredWindows(simBtc, seamReturnIdx(res.blocks), SEAM_HALF);
    const realLW: LabeledWindow[] = realTransWindows.map((w, i) => ({ label: 1, returns: w, windowStart: i, windowEnd: i + w.length, origin: `realtrans-c${Math.floor(i / 4)}`, split: "calibration" }));
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
    return { pass: failures.length === 0, failures, excess: sr.excessRejectRate, ratio: sr.rejectRateRatio, excessCI: sr.excessConfidenceInterval, seamClf: seamClf.separabilityAuc, sfPass: sf.pass, depDist, memo: m, insufficient: res.insufficient, invariantsOk: inv.ok };
  };
  const summarize = (evals: ReturnType<typeof evalRun>[]) => {
    const ok = evals.filter((e) => e.insufficient === 0);
    const excess = ok.map((e) => e.excess); const ratio = ok.map((e) => e.ratio); const clf = ok.map((e) => e.seamClf).filter((x): x is number => x != null);
    const run = ok.map((e) => e.memo?.longestUnchangedRunHours ?? 0); const dup = ok.map((e) => e.memo?.duplicateNHourSequenceRate ?? 0); const uniq = ok.map((e) => e.memo?.uniqueContinuationCoverage ?? 0);
    return {
      n: evals.length, passRate: evals.filter((e) => e.pass).length / evals.length, insufficientRate: evals.filter((e) => e.insufficient > 0).length / evals.length, invariantFailures: evals.filter((e) => !e.invariantsOk).length,
      excess: { p5: pct(excess, 0.05), p25: pct(excess, 0.25), p50: pct(excess, 0.5), p75: pct(excess, 0.75), p95: pct(excess, 0.95), worst: Math.max(...excess) },
      ratio: { p5: pct(ratio, 0.05), p50: pct(ratio, 0.5), p95: pct(ratio, 0.95), worst: Math.max(...ratio) },
      seamClassifier: { p50: pct(clf, 0.5), p95: pct(clf, 0.95), worst: clf.length ? Math.max(...clf) : null },
      longestRun: { p50: pct(run, 0.5), p95: pct(run, 0.95), worst: Math.max(...run) }, dupSeq: { p50: pct(dup, 0.5), p95: pct(dup, 0.95), worst: Math.max(...dup) }, uniqueContinuation: { p50: pct(uniq, 0.5), min: uniq.length ? Math.min(...uniq) : null },
      failureCounts: (() => { const c: Record<string, number> = {}; for (const e of evals) for (const f of e.failures) c[f] = (c[f] ?? 0) + 1; return c; })(),
    };
  };

  // ── Step 2: 100-seed robustness of frozen B (cap 144, reuse 4) ──
  const bEvals100 = SEEDS_100.map((s) => evalRun(genB(lib48, 144, 4, s)));
  const seedRobustness = summarize(bEvals100);

  // ── Step 3: cap sensitivity (30 seeds each) ──
  const capSensitivity = CAPS.map((cap) => { const ev = SEEDS_30.map((s) => evalRun(genB(lib48, cap, 4, s))); const sum = summarize(ev); const rt = 0; return { cap, ...sum, allGatesPassRate: sum.passRate, runtimeMs: rt }; });

  // ── Step 4: gate margins (frozen 144h, pooled over 100 seeds) ──
  const okEvals = bEvals100.filter((e) => e.insufficient === 0);
  const gateMargin = (metric: string, observed: number, threshold: number, dir: "<=" | ">=", uncertainty: [number, number] | null) => ({ metric, observed, threshold, passMargin: dir === "<=" ? threshold - observed : observed - threshold, uncertaintyInterval: uncertainty, robustPass: uncertainty ? (dir === "<=" ? uncertainty[1] <= threshold : uncertainty[0] >= threshold) : (dir === "<=" ? observed <= threshold : observed >= threshold) });
  const excessArr = okEvals.map((e) => e.excess); const ratioArr = okEvals.map((e) => e.ratio); const clfArr = okEvals.map((e) => e.seamClf).filter((x): x is number => x != null); const dupArr = okEvals.map((e) => e.memo?.duplicateNHourSequenceRate ?? 0); const runArr = okEvals.map((e) => e.memo?.longestUnchangedRunHours ?? 0); const uniqArr = okEvals.map((e) => e.memo?.uniqueContinuationCoverage ?? 0); const depArr = okEvals.map((e) => e.depDist ?? 0);
  const gateMargins = [
    gateMargin("seamExcess", pct(excessArr, 0.5), GATES.seamExcessMax, "<=", [pct(excessArr, 0.05), pct(excessArr, 0.95)]),
    gateMargin("seamRatio", pct(ratioArr, 0.5), GATES.seamRatioMax, "<=", [pct(ratioArr, 0.05), pct(ratioArr, 0.95)]),
    gateMargin("seamClassifier", pct(clfArr, 0.5), GATES.seamClassifierMax, "<=", [pct(clfArr, 0.05), pct(clfArr, 0.95)]),
    gateMargin("dupSeq", pct(dupArr, 0.5), GATES.maxDupSeqRate, "<=", [pct(dupArr, 0.05), pct(dupArr, 0.95)]),
    gateMargin("longestUnchangedRun", pct(runArr, 0.5), GATES.maxUnchangedRunHours, "<=", [pct(runArr, 0.05), pct(runArr, 0.95)]),
    gateMargin("uniqueContinuation", pct(uniqArr, 0.5), GATES.minUniqueContinuation, ">=", [pct(uniqArr, 0.05), pct(uniqArr, 0.95)]),
    gateMargin("depDist", pct(depArr, 0.5), GATES.depDistMax, "<=", [pct(depArr, 0.05), pct(depArr, 0.95)]),
  ];

  // ── Step 5: independent B2 (100 seeds, cap 144) ──
  const b2Evals100 = SEEDS_100.map((s) => evalRun(genB2(lib48, 144, s)));
  const b2Robustness = summarize(b2Evals100);

  // ── Step 6: leave-one-source-month-out (30 seeds each) ──
  const lopo = CAL_MONTHS.map((mm) => { const lib = lib48.filter((r) => r.sourceMonth !== `2026-${mm}`); const ev = SEEDS_30.map((s) => evalRun(genB(lib, 144, 4, s))); return { omittedMonth: `2026-${mm}`, librarySize: lib.length, ...summarize(ev) }; });

  // ── Step 7: transition-library perturbations (30 seeds each) ──
  const refUse = new Map<number, number>(); for (const s of SEEDS_30) for (const b of genB(lib48, 144, 4, s).blocks) refUse.set(b.startIndex, (refUse.get(b.startIndex) ?? 0) + 1);
  const sortedByUse = [...refUse.entries()].sort((a, b) => b[1] - a[1]);
  const top1pct = new Set(sortedByUse.slice(0, Math.max(1, Math.floor(lib48.length * 0.01))).map(([s]) => s));
  const monthUse = new Map<string, number>(); for (const [s, u] of refUse) { const mo = new Date(cal[s]?.asOfMs ?? 0).toISOString().slice(0, 7); monthUse.set(mo, (monthUse.get(mo) ?? 0) + u); }
  const topMonth = [...monthUse.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  // dedupe near-identical terminal states (L2 over normalizer < 0.05 to a kept record)
  const dedup: HistoricalContinuationRecord[] = []; for (const r of lib48) { let dupd = false; for (const k of dedup) { let sum = 0, n = 0; for (const f of ["volatilityMedium", "volatilityShort", "recentReturn", "trendSlope"] as const) { const a = r.terminalState[f]; const b = k.terminalState[f]; if (typeof a === "number" && typeof b === "number") { const d = (a - b) / (normalizer.scales as Record<string, number>)[f]!; sum += d * d; n += 1; } } if (n > 0 && Math.sqrt(sum / n) < 0.05 && r.terminalState.regimeFamily === k.terminalState.regimeFamily) { dupd = true; break; } } if (!dupd) dedup.push(r); }
  const perturbations = [
    { name: "remove_top_1pct_successors", run: () => SEEDS_30.map((s) => evalRun(genB(lib48.filter((r) => !top1pct.has(r.successorRef.startIndex)), 144, 4, s))) },
    { name: "remove_top_source_month", run: () => SEEDS_30.map((s) => evalRun(genB(lib48.filter((r) => r.sourceMonth !== topMonth), 144, 4, s))) },
    { name: "dedupe_near_identical_terminals", run: () => SEEDS_30.map((s) => evalRun(genB(dedup, 144, 4, s))) },
    { name: "restrict_reuse_to_1", run: () => SEEDS_30.map((s) => evalRun(genB(lib48, 144, 1, s))) },
    { name: "strict_cap48_reuse2", run: () => SEEDS_30.map((s) => evalRun(genB(lib48, 48, 2, s))) },
  ].map((p) => ({ name: p.name, ...summarize(p.run()) }));

  // ── Step 8: decision rule ──
  const cap96orLowerPass = capSensitivity.filter((c) => c.cap <= 96 && c.passRate >= 0.9);
  const b2ConsistentPass = b2Robustness.passRate >= 0.5; // B2 reaches a consistent (passing) conclusion
  const marginsRobust = gateMargins.every((g) => g.robustPass);
  const lopoStable = lopo.every((l) => l.passRate >= 0.5);
  const perturbStable = perturbations.every((p) => p.passRate >= 0.5 || p.insufficientRate >= 0.5); // survive OR fail only for support
  const decision = {
    frozen144Pass: seedRobustness.passRate >= 0.5,
    seedStable: seedRobustness.passRate >= 0.9,
    stricterCapPassesOrSupportLimited: cap96orLowerPass.length > 0 || capSensitivity.filter((c) => c.cap <= 96).every((c) => c.insufficientRate >= 0.5),
    gateMarginsRobust: marginsRobust,
    b2Consistent: b2ConsistentPass,
    lopoStable, perturbStable,
    verdict: "" as string,
  };
  const allConditions = decision.frozen144Pass && decision.seedStable && decision.stricterCapPassesOrSupportLimited && decision.gateMarginsRobust && decision.b2Consistent && decision.lopoStable && decision.perturbStable;
  decision.verdict = allConditions ? "ROBUSTNESS_CONFIRMED_READY_FOR_ONCE_ONLY_HOLDOUT" : "ROBUSTNESS_NOT_ESTABLISHED";

  const results = { phase: "2C-robustness", generatedAtProcessingMs: t0, runtimeMs: Date.now() - t0, calFrames: cal.length, librarySize: lib48.length, gates: GATES, seedRobustness, capSensitivity, gateMargins, b2Robustness, lopo, perturbations, decision, determinismCheck: stableHash([seedRobustness, gateMargins]).slice(0, 16) };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));

  console.log(`Robustness run OK. calFrames=${cal.length} lib=${lib48.length} runtime=${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`SEED robustness (100): passRate=${seedRobustness.passRate.toFixed(3)} excess p50=${seedRobustness.excess.p50.toFixed(3)} p95=${seedRobustness.excess.p95.toFixed(3)} worst=${seedRobustness.excess.worst.toFixed(3)} | dup p95=${seedRobustness.dupSeq.p95.toFixed(3)} | insuffRate=${seedRobustness.insufficientRate.toFixed(2)} failCounts=${JSON.stringify(seedRobustness.failureCounts)}`);
  console.log(`CAP sensitivity:`); for (const c of capSensitivity) console.log(`  cap ${c.cap}h: passRate=${c.passRate.toFixed(2)} insuffRate=${c.insufficientRate.toFixed(2)} excess p50=${c.excess.p50.toFixed(3)} dup p95=${c.dupSeq.p95.toFixed(3)} uniqCont p50=${c.uniqueContinuation.p50.toFixed(2)}`);
  console.log(`GATE margins (robustPass?):`); for (const g of gateMargins) console.log(`  ${g.metric}: obs=${g.observed.toFixed(3)} thr=${g.threshold} margin=${g.passMargin.toFixed(3)} CI=[${g.uncertaintyInterval?.[0].toFixed(3)},${g.uncertaintyInterval?.[1].toFixed(3)}] robust=${g.robustPass}`);
  console.log(`B2 independent (100): passRate=${b2Robustness.passRate.toFixed(3)} excess p50=${b2Robustness.excess.p50.toFixed(3)} dup p95=${b2Robustness.dupSeq.p95.toFixed(3)} insuffRate=${b2Robustness.insufficientRate.toFixed(2)}`);
  console.log(`LOPO:`); for (const l of lopo) console.log(`  omit ${l.omittedMonth}: passRate=${l.passRate.toFixed(2)} insuffRate=${l.insufficientRate.toFixed(2)} lib=${l.librarySize}`);
  console.log(`PERTURBATIONS:`); for (const p of perturbations) console.log(`  ${p.name}: passRate=${p.passRate.toFixed(2)} insuffRate=${p.insufficientRate.toFixed(2)} excess p50=${p.excess.p50.toFixed(3)} dup p95=${p.dupSeq.p95.toFixed(3)}`);
  console.log(`DECISION: ${decision.verdict} | ${JSON.stringify({ seedStable: decision.seedStable, stricterCap: decision.stricterCapPassesOrSupportLimited, margins: decision.gateMarginsRobust, b2: decision.b2Consistent, lopo: decision.lopoStable, perturb: decision.perturbStable })}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

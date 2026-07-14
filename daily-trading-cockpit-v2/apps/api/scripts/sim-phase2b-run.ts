/**
 * Phase-2B runner — compatibility-conditioned synchronized block selection, evaluated on CALIBRATION + DEVELOPMENT
 * ONLY. Offline, deterministic, report-only. No deploy, no CORTEX training, no VPS change, no holdout opened here
 * (per the operator: build + freeze + commit FIRST, open a genuinely-unseen holdout only afterwards, and only if a
 * method passes the development acceptance gate).
 *
 * Pipeline: load 2026 corpus + PHYSICAL embargo → build calibration compatibility normalizer + transition kernel →
 * run 5 selection methods × 10 seeds through the FROZEN return-space reconstruction → measure candle-path realism,
 * seam realism (grouped bootstrap CI), cross-asset dependence, source concentration, fallback rates → grouped
 * real-vs-sim classifier (separabilityAuc + CI + by-regime/month + ablations + label inversion) → domain-shift
 * controls → development acceptance gate. Writes results.json.
 *
 * Usage: npx tsx scripts/sim-phase2b-run.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stableHash } from "../src/lib/replay-provenance.js";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { CsvKlinesHistoricalSource } from "../src/simulation/historical-market-source.js";
import { selectFixedLengthBlocks, assembleReturnSpaceBootstrapPath, type BootstrapResult } from "../src/simulation/historical-block-bootstrap.js";
import { computeCalibrationVolumeBaseline, computeTerminalState, TERMINAL_LOOKBACK, CANDIDATE_PREFIX_LEN, type BlockTransitionState } from "../src/simulation/block-transition-state.js";
import { buildCompatibilityNormalizer } from "../src/simulation/block-compatibility.js";
import { selectCompatibilityBlocks, precomputeInitialStates, buildTransitionKernel, DEFAULT_CONSTRAINTS, type SelectionStrategy, type CompatibilitySelectionResult } from "../src/simulation/compatibility-block-selection.js";
import { naturalAdjacencyReject, computeSeamRealism } from "../src/simulation/seam-realism.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import { assessRealism } from "../src/simulation/realism-assessment.js";
import { evaluateStylizedFacts } from "../src/simulation/realism-gate.js";
import { evaluateClassifier, windowFeatures, trainLogistic, predictProba, rocAuc, orientAuc, type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import { logReturns, mean, std } from "../src/simulation/calibration-metrics.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const API = join(import.meta.dirname, "..");
const KLINES_DIR = join(API, "artifacts/simulation/data/extracted/klines_1h");
const OUT = join(API, "artifacts/simulation/phase2b");
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const BTC = "BTCUSDT"; const ETH = "ETHUSDT";
const HOUR = 3_600_000;

const PARTITIONS = { calibration: ["01", "02", "03"], development: ["04"], diagnostic: ["05"] };
// embargo ≥ max(blockLen 48, terminalLookback 24, candidatePrefix 6, classifierWindow 48, brainLookback 0, outcomeHorizon 0)
const EMBARGO_HOURS = 48;
const BLOCK_LEN = 48;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const WINDOW = 48;
const METHODS: { key: string; strategy: SelectionStrategy }[] = [
  { key: "A_RANDOM_BASELINE", strategy: "RANDOM_BASELINE" },
  { key: "B_HARD_FILTER", strategy: "HARD_FILTER" },
  { key: "C_NEAREST_K", strategy: "NEAREST_K" },
  { key: "D_TRANSITION_KERNEL", strategy: "TRANSITION_KERNEL" },
  { key: "E_COMPAT_STATIONARY", strategy: "COMPAT_STATIONARY" },
];
// Pre-registered development gates (frozen before opening any holdout).
const GATES = { sepAucMax: 0.75, seamExcessMax: 0.10, seamRatioMax: 2.0, srcTop1Max: 0.05, srcMonthMax: 0.6, minUniqueCoverage: 0.3, minStylizedPassRate: 0.5, depDistMax: 0.08 };

function readFileOrNull(p: string): string | null { return existsSync(p) ? readFileSync(p, "utf8") : null; }
function sourceFor(runId: string, months: string[]): CsvKlinesHistoricalSource {
  return new CsvKlinesHistoricalSource({
    runId, symbols: SYMBOLS, months, year: "2026", dir: join(KLINES_DIR, "__by_interval__"),
    readFile: (path) => { const m = path.match(/([A-Z]+)-1h-2026-(\d\d)/); if (!m) return null; const [, sym, mm] = m; return readFileOrNull(join(KLINES_DIR, sym!, "1h", `${sym}-1h-2026-${mm}`, `${sym}-1h-2026-${mm}.csv`)); },
  });
}
async function collect(src: CsvKlinesHistoricalSource): Promise<CommonMarketFrame[]> {
  const meta = src.describe(); const out: CommonMarketFrame[] = [];
  for await (const f of src.iterateFrames(meta.dateRangeMs ?? { startMs: 0, endMs: 0 })) out.push(f);
  return out;
}
const closes = (frames: CommonMarketFrame[], sym: string): number[] => frames.map((f) => f.symbols[sym]?.candle.value?.close).filter((x): x is number => typeof x === "number");
const wicks = (frames: CommonMarketFrame[], sym: string): number[] => frames.map((f) => { const c = f.symbols[sym]?.candle.value; if (!c) return null; const r = c.high - c.low; return r > 0 ? (c.high - Math.max(c.open, c.close)) / r : 0; }).filter((x): x is number => x != null);
const volumes = (frames: CommonMarketFrame[], sym: string): number[] => frames.map((f) => f.symbols[sym]?.candle.value?.volume).filter((x): x is number => typeof x === "number");

function physicalEmbargo(frames: CommonMarketFrame[], hours: number): CommonMarketFrame[] {
  return frames.length <= 2 * hours ? [] : frames.slice(hours, frames.length - hours);
}
function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const ma = mean(a.slice(0, n))!, mb = mean(b.slice(0, n))!; let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}
function pearsonWhere(a: number[], b: number[], pred: (x: number) => boolean): number | null {
  const aa: number[] = []; const bb: number[] = []; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (pred(a[i]!)) { aa.push(a[i]!); bb.push(b[i]!); }
  return pearson(aa, bb);
}
const median = (xs: (number | null | undefined)[]): number | null => { const v = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };

/** Regime label for a return window (matches the offline labeler family). */
function windowRegime(returns: number[]): string {
  const v = std(returns) ?? 0; const drift = mean(returns) ?? 0;
  return drift > v * 0.15 ? "UPTREND" : drift < -v * 0.15 ? "DOWNTREND" : "RANGE";
}
function pushWindows(out: LabeledWindow[], returns: number[], label: 0 | 1, origin: string, split: LabeledWindow["split"]): void {
  for (let s = 0; s + WINDOW <= returns.length; s += WINDOW) out.push({ label, returns: returns.slice(s, s + WINDOW), windowStart: s, windowEnd: s + WINDOW, origin, split });
}
/** Grouped bootstrap AUC CI: resample GROUPS of windows (by origin/day) with replacement. */
function groupedAucCI(model: ReturnType<typeof trainLogistic>, ws: LabeledWindow[], rng: { nextInt(a: number, b: number): number }, iters = 400, alpha = 0.1): [number, number] | null {
  if (ws.length === 0) return null;
  const byGroup = new Map<string, LabeledWindow[]>();
  for (const w of ws) { const g = byGroup.get(w.origin); if (g) g.push(w); else byGroup.set(w.origin, [w]); }
  const groups = [...byGroup.values()]; const aucs: number[] = [];
  for (let b = 0; b < iters; b += 1) {
    const sample: LabeledWindow[] = [];
    for (let g = 0; g < groups.length; g += 1) sample.push(...groups[rng.nextInt(0, groups.length)]!);
    const raw = rocAuc(sample.map((w) => predictProba(model, windowFeatures(w.returns))), sample.map((w) => w.label));
    if (raw != null) aucs.push(orientAuc(raw).separabilityAuc!);
  }
  if (!aucs.length) return null;
  aucs.sort((a, b) => a - b);
  return [aucs[Math.floor((alpha / 2) * aucs.length)] ?? aucs[0]!, aucs[Math.min(aucs.length - 1, Math.ceil((1 - alpha / 2) * aucs.length) - 1)] ?? aucs.at(-1)!];
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();

  // ── load + physical embargo ──
  const cal = physicalEmbargo(await collect(sourceFor("cal", PARTITIONS.calibration)), EMBARGO_HOURS);
  const dev = physicalEmbargo(await collect(sourceFor("dev", PARTITIONS.development)), EMBARGO_HOURS);
  const diag = physicalEmbargo(await collect(sourceFor("diag", PARTITIONS.diagnostic)), EMBARGO_HOURS);
  const calBtcReal = logReturns(closes(cal, BTC)); const calEthReal = logReturns(closes(cal, ETH));
  const calWickReal = wicks(cal, BTC); const calVolReal = volumes(cal, BTC);

  // ── compatibility infrastructure from CALIBRATION only ──
  const baseline = computeCalibrationVolumeBaseline(cal, BTC);
  const candidateStarts: number[] = []; for (let s = 0; s + BLOCK_LEN <= cal.length; s += 1) candidateStarts.push(s);
  const initialStates = precomputeInitialStates(cal, candidateStarts, baseline, BTC, ETH);
  // calibration terminal states (sampled at every candidate end) → normalizer scales
  const calTerminalStates: BlockTransitionState[] = candidateStarts.map((s) => computeTerminalState(cal, s, BLOCK_LEN, baseline, BTC, ETH, TERMINAL_LOOKBACK));
  const normalizer = buildCompatibilityNormalizer(calTerminalStates);
  const kernel = buildTransitionKernel(cal, baseline, BTC, ETH, TERMINAL_LOOKBACK);
  const natural = naturalAdjacencyReject(cal, SYMBOLS);
  const naturalBtcOnly = naturalAdjacencyReject(cal, [BTC]);

  // ── run methods ──
  const seamRng = createRng(999, "seam-bootstrap");
  const methodResults: Record<string, unknown> = {};
  const classifierWindows: LabeledWindow[] = [];
  const perMethodSimForClf: Record<string, number[]> = {}; // seed-1 sim returns per method for the main classifier + domain-shift
  const simForClfMulti: { method: string; seed: number; returns: number[] }[] = []; // seeds 1-3 per method → more independent sim GROUPS for the grouped CI

  const measurePath = (res: BootstrapResult) => {
    const inv = checkFrameStreamInvariants(res.frames, { expectSingleProvenance: true });
    const simBtc = logReturns(closes(res.frames, BTC)); const simEth = logReturns(closes(res.frames, ETH));
    const realism = assessRealism({ realReturns: calBtcReal, simReturns: simBtc, realWick: calWickReal, simWick: wicks(res.frames, BTC), realVolume: calVolReal, simVolume: volumes(res.frames, BTC) });
    const sf = evaluateStylizedFacts({ realReturns: calBtcReal, simReturns: simBtc });
    const dep = {
      ordinary: { real: pearson(calBtcReal, calEthReal), sim: pearson(simBtc, simEth) },
      largeNeg: { real: pearsonWhere(calBtcReal, calEthReal, (x) => x <= (mean(calBtcReal) ?? 0) - (std(calBtcReal) ?? 0)), sim: pearsonWhere(simBtc, simEth, (x) => x <= (mean(simBtc) ?? 0) - (std(simBtc) ?? 0)) },
    };
    const depDist = dep.ordinary.real != null && dep.ordinary.sim != null ? Math.abs(dep.ordinary.real - dep.ordinary.sim) : null;
    return { inv: inv.ok, simBtc, simEth, realism, sf, dep, depDist };
  };

  // per-seam realism uses the SAME stitch decisions the reconstruction produced, grouped by the prev block's source day.
  const seamRecords = (res: BootstrapResult) => res.stitches.map((st, k) => ({ rejected: !st.accepted, reasons: st.reasons, group: new Date(cal[res.blocks[k]?.startIndex ?? 0]?.asOfMs ?? 0).toISOString().slice(0, 10) }));

  for (const m of METHODS) {
    const perSeed: Array<Record<string, unknown>> = [];
    const allSeamRecords: { rejected: boolean; reasons: string[]; group: string }[] = [];
    for (const seed of SEEDS) {
      let res: BootstrapResult; let selection: CompatibilitySelectionResult | null = null;
      if (m.strategy === "RANDOM_BASELINE") {
        const blocks = selectFixedLengthBlocks(cal.length, BLOCK_LEN, Math.ceil(cal.length / BLOCK_LEN), createRng(seed, `rs/${m.key}`));
        res = assembleReturnSpaceBootstrapPath(cal, blocks, { runId: `${m.key}-${seed}`, symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
      } else {
        selection = selectCompatibilityBlocks({ strategy: m.strategy, frames: cal, candidateStarts, initialStates, normalizer, baseline, btc: BTC, eth: ETH, blockLen: BLOCK_LEN, targetLen: cal.length, lookback: TERMINAL_LOOKBACK, rng: createRng(seed, `sel/${m.key}`), constraints: DEFAULT_CONSTRAINTS, kernel });
        res = assembleReturnSpaceBootstrapPath(cal, selection.blocks, { runId: `${m.key}-${seed}`, symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: m.strategy === "COMPAT_STATIONARY" ? "STATIONARY_BLOCK_BOOTSTRAP" : "NEAREST_NEIGHBOR_CONTINUATION" });
      }
      const meas = measurePath(res);
      const recs = seamRecords(res); allSeamRecords.push(...recs);
      if (seed === 1) perMethodSimForClf[m.key] = meas.simBtc;
      if (seed <= 3) simForClfMulti.push({ method: m.key, seed, returns: meas.simBtc }); // more sim groups for the grouped CI
      perSeed.push({
        seed, invariantsOk: meas.inv, hash: stableHash(res.frames.map((f) => f.frameId)).slice(0, 12),
        seamRejectRate: res.stitches.length ? res.rejectedBoundaries / res.stitches.length : 0,
        stylizedFactsPass: meas.sf.pass, depDist: meas.depDist,
        realism: { wasserstein: meas.realism.returnDistributionDistance, absAutocorr: meas.realism.absoluteReturnAutocorrelationDistance, tail: meas.realism.tailDistance },
        selectionStatus: selection?.status ?? "OK", insufficientSeams: selection?.insufficientSeams ?? 0,
        fallbackLevelCounts: selection?.fallbackLevelCounts ?? {}, concentration: selection ? selection.concentration : null,
        nBlocks: res.blocks.length,
      });
    }
    // seam realism with grouped CI (pooled across seeds; grouped by source day). Natural baseline items are passed so
    // the excess CI bootstraps the natural rate's own uncertainty (not a fixed constant). Both use the both-symbol
    // decision, so it is apples-to-apples (the misleading both-vs-BTC-only comparison was removed).
    const seamRealism = computeSeamRealism(allSeamRecords, natural, seamRng);
    const med = (f: (s: Record<string, unknown>) => number | null | undefined) => median(perSeed.map(f));
    // aggregate concentration (median across seeds)
    const concKeys = ["top1", "top5", "top10", "effectiveNumberOfBlocks", "uniqueBlockCoverage", "monthConcentrationMax", "monthEntropy", "transitionCellConcentrationMax", "duplicateSequenceCount"] as const;
    const concentrationMedian: Record<string, number | null> = {};
    for (const k of concKeys) concentrationMedian[k] = median(perSeed.map((s) => (s.concentration as Record<string, number> | null)?.[k]));
    // WORST-seed concentration (the acceptance gate uses these, not the median, so a minority of memorizing seeds
    // cannot be masked by the median — top-concentration = MAX, coverage = MIN, dupes = MAX across seeds).
    const concVals = (k: string) => perSeed.map((s) => (s.concentration as Record<string, number> | null)?.[k]).filter((x): x is number => typeof x === "number");
    const concentrationWorst = {
      top1: Math.max(0, ...concVals("top1")),
      monthConcentrationMax: Math.max(0, ...concVals("monthConcentrationMax")),
      uniqueBlockCoverage: concVals("uniqueBlockCoverage").length ? Math.min(...concVals("uniqueBlockCoverage")) : null,
      overlapAwareCoverage: concVals("overlapAwareCoverage").length ? Math.min(...concVals("overlapAwareCoverage")) : null,
      duplicateSequenceCount: Math.max(0, ...concVals("duplicateSequenceCount")),
    };
    // pooled fallback counts
    const fallbackTotals: Record<string, number> = {};
    for (const s of perSeed) for (const [k, v] of Object.entries(s.fallbackLevelCounts as Record<string, number>)) fallbackTotals[k] = (fallbackTotals[k] ?? 0) + v;
    methodResults[m.key] = {
      strategy: m.strategy, seeds: SEEDS.length,
      medianSeamRejectRate: med((s) => s.seamRejectRate as number),
      stylizedFactsPassRate: perSeed.filter((s) => s.stylizedFactsPass).length / perSeed.length,
      allDeterministic: perSeed.every((s) => s.invariantsOk),
      medianDepDist: med((s) => s.depDist as number | null),
      medianRealism: { wasserstein: med((s) => (s.realism as Record<string, number>).wasserstein), absAutocorr: med((s) => (s.realism as Record<string, number>).absAutocorr), tail: med((s) => (s.realism as Record<string, number>).tail) },
      seamRealism,
      concentrationMedian, concentrationWorst, fallbackTotals,
      insufficientSeamsTotal: perSeed.reduce((a, s) => a + (s.insufficientSeams as number), 0),
      anyInsufficient: perSeed.some((s) => s.selectionStatus === "STRESS_TEST_ONLY_INSUFFICIENT_TRANSITION_SUPPORT"),
      perSeed,
    };
  }

  // ── grouped real-vs-sim classifier (train cal, score dev) ──
  // calibration split = real-cal (label1, grouped by day) + sim-cal (label0, method B seed2);
  // development split = real-dev + real-diag + sim per-method (seed1). Real windows grouped by source day.
  pushWindowsByDayInto(classifierWindows, cal, BTC, 1, "calibration");
  {
    const sel = selectCompatibilityBlocks({ strategy: "HARD_FILTER", frames: cal, candidateStarts, initialStates, normalizer, baseline, btc: BTC, eth: ETH, blockLen: BLOCK_LEN, targetLen: cal.length, lookback: TERMINAL_LOOKBACK, rng: createRng(2, "sel/clf-neg"), constraints: DEFAULT_CONSTRAINTS, kernel });
    const res = assembleReturnSpaceBootstrapPath(cal, sel.blocks, { runId: "clf-neg", symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "NEAREST_NEIGHBOR_CONTINUATION" });
    pushWindows(classifierWindows, logReturns(closes(res.frames, BTC)), 0, "sim-cal-B", "calibration");
  }
  pushWindowsByDayInto(classifierWindows, dev, BTC, 1, "development");
  pushWindowsByDayInto(classifierWindows, diag, BTC, 1, "development"); // diagnostic real (burned) as extra dev real
  // sim negatives from seeds 1-3 per method, each its OWN origin — gives the grouped CI more comparably-sized sim
  // groups (15) instead of 5 giant per-method groups that would dominate the cluster bootstrap.
  for (const s of simForClfMulti) pushWindows(classifierWindows, s.returns, 0, `sim-dev-${s.method}-s${s.seed}`, "development");
  const classifier = evaluateClassifier(classifierWindows);

  // grouped CI + per-regime + per-origin AUC on development split (trained on calibration)
  const cal4 = classifierWindows.filter((w) => w.split === "calibration");
  const trainable = cal4.length >= 4 && new Set(cal4.map((w) => w.label)).size === 2;
  const model = trainable ? trainLogistic(cal4.map((w) => windowFeatures(w.returns)), cal4.map((w) => w.label)) : null;
  const devWins = classifierWindows.filter((w) => w.split === "development");
  const clfRng = createRng(4242, "clf-boot");
  const groupedCI = model ? groupedAucCI(model, devWins, clfRng) : null;
  const perRegimeAuc: Record<string, number | null> = {};
  if (model) for (const reg of ["UPTREND", "DOWNTREND", "RANGE"]) {
    const ws = devWins.filter((w) => windowRegime(w.returns) === reg);
    const raw = ws.length ? rocAuc(ws.map((w) => predictProba(model, windowFeatures(w.returns))), ws.map((w) => w.label)) : null;
    perRegimeAuc[reg] = raw != null ? orientAuc(raw).separabilityAuc : null;
  }
  // label-inversion
  const invSep = evaluateClassifier(classifierWindows.map((w) => ({ ...w, label: (w.label === 1 ? 0 : 1) as 0 | 1 }))).development.separabilityAuc;
  const labelInversionStable = classifier.development.separabilityAuc != null && invSep != null && Math.abs(classifier.development.separabilityAuc - invSep) < 1e-9;

  // ── domain-shift controls ──
  const domainShift = computeDomainShiftControls(cal, dev, diag, perMethodSimForClf, model);

  // The development classifier is inherently DOMAIN-CONFOUNDED: sim negatives are reconstructions of CALIBRATION
  // (2026 01-03) while real dev/diag windows are 2026 04-05, and real months are themselves highly separable
  // (realMonthControlSep). So a near-chance classifier could be calendar-masked. We therefore do NOT treat a low
  // classifier AUC as POSITIVE realism evidence — it can only FAIL a method (≥ ceiling), never carry a PASS.
  const classifierDomainConfounded = domainShift.realMonthControlSep != null && domainShift.realMonthControlSep > 0.70
    && classifier.development.separabilityAuc != null && classifier.development.separabilityAuc < 0.60;

  // ── development acceptance gate per method (concentration gates use WORST seed, not median) ──
  const acceptance: Record<string, { pass: boolean; failures: string[]; notes: string[] }> = {};
  for (const m of METHODS) {
    const r = methodResults[m.key] as Record<string, unknown>;
    const sr = r.seamRealism as ReturnType<typeof computeSeamRealism>;
    const conc = r.concentrationWorst as Record<string, number | null>;
    const failures: string[] = []; const notes: string[] = [];
    if (!(r.allDeterministic as boolean)) failures.push("non-deterministic/invariant-fail");
    if ((r.stylizedFactsPassRate as number) < GATES.minStylizedPassRate) failures.push(`stylized-facts ${(r.stylizedFactsPassRate as number).toFixed(2)}<${GATES.minStylizedPassRate}`);
    if (sr.excessRejectRate > GATES.seamExcessMax) failures.push(`seam excess ${sr.excessRejectRate.toFixed(3)}>${GATES.seamExcessMax}`);
    if (sr.rejectRateRatio > GATES.seamRatioMax) failures.push(`seam ratio ${sr.rejectRateRatio.toFixed(2)}>${GATES.seamRatioMax}`);
    if (classifier.development.separabilityAuc != null && classifier.development.separabilityAuc >= GATES.sepAucMax) failures.push(`sep AUC ${classifier.development.separabilityAuc.toFixed(3)}≥${GATES.sepAucMax}`);
    if (classifierDomainConfounded) notes.push("classifier near-chance but DOMAIN-CONFOUNDED (sim basis month ≠ real eval month; realMonthControl high) — NOT counted as positive realism evidence");
    const depd = r.medianDepDist as number | null; if (depd != null && depd > GATES.depDistMax) failures.push(`dep dist ${depd.toFixed(3)}>${GATES.depDistMax}`);
    const top1 = conc.top1; if (top1 != null && top1 > GATES.srcTop1Max) failures.push(`worst-seed src top1 ${top1.toFixed(3)}>${GATES.srcTop1Max}`);
    const mm = conc.monthConcentrationMax; if (mm != null && mm > GATES.srcMonthMax) failures.push(`worst-seed month conc ${mm.toFixed(2)}>${GATES.srcMonthMax}`);
    const uc = conc.uniqueBlockCoverage; if (uc != null && uc < GATES.minUniqueCoverage) failures.push(`worst-seed unique cov ${uc.toFixed(2)}<${GATES.minUniqueCoverage}`);
    const oc = conc.overlapAwareCoverage; if (oc != null && oc < GATES.minUniqueCoverage) failures.push(`worst-seed overlap-aware cov ${oc.toFixed(2)}<${GATES.minUniqueCoverage}`);
    const dup = conc.duplicateSequenceCount; if (dup != null && dup > 0) failures.push(`worst-seed duplicate sequences ${dup}>0`);
    if (r.anyInsufficient as boolean) failures.push("insufficient-transition-support on ≥1 seed");
    acceptance[m.key] = { pass: failures.length === 0, failures, notes };
  }
  // The holdout greenlight additionally requires the development classifier to be TRUSTWORTHY: a domain-confounded
  // near-chance AUC cannot certify realism (sim-basis month ≠ real-eval month), so it must NOT open a scarce holdout.
  const anyPass = Object.values(acceptance).some((a) => a.pass) && !classifierDomainConfounded;

  const results = {
    phase: "2B", generatedAtProcessingMs: t0, runtimeMs: Date.now() - t0,
    partitions: PARTITIONS, embargoHours: EMBARGO_HOURS, blockLen: BLOCK_LEN, terminalLookback: TERMINAL_LOOKBACK, candidatePrefixLen: CANDIDATE_PREFIX_LEN,
    gates: GATES,
    naturalAdjacency: { bothSymbols: natural, btcOnly: naturalBtcOnly },
    calFrames: cal.length, devFrames: dev.length, diagFrames: diag.length,
    methodResults,
    classifier: {
      positiveClassDefinition: classifier.positiveClassDefinition,
      developmentSeparabilityAuc: classifier.development.separabilityAuc, developmentRawAuc: classifier.development.rawAuc,
      groupedSeparabilityCI: groupedCI, perRegimeSeparabilityAuc: perRegimeAuc, ablations: classifier.ablations,
      leakageOverlaps: classifier.leakage.overlappingPairs, classBalance: classifier.leakage.classBalance,
      labelInversionStable, domainConfounded: classifierDomainConfounded,
      domainConfoundNote: classifierDomainConfounded ? "sim negatives are reconstructions of calibration (2026 01-03); real eval windows are 2026 04-05; real months are highly separable (realMonthControlSep) — so this near-chance AUC may be calendar-masked and is NOT positive realism evidence" : null,
    },
    domainShift,
    acceptance, anyMethodPassesDevelopment: anyPass,
    stopStatus: anyPass ? "DEVELOPMENT_METHOD_PASSED_awaiting_freeze_then_unseen_holdout" : "NO_METHOD_PASSES_DEVELOPMENT_stop_no_holdout",
    determinismCheck: stableHash(methodResults).slice(0, 16),
  };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));

  console.log(`Phase-2B run OK. calFrames=${cal.length} natural adjacency reject (both)=${(natural.rate * 100).toFixed(1)}% (btc)=${(naturalBtcOnly.rate * 100).toFixed(1)}%`);
  console.log(`classifier dev separabilityAuc=${classifier.development.separabilityAuc?.toFixed(3)} CI=${groupedCI ? `[${groupedCI[0].toFixed(3)},${groupedCI[1].toFixed(3)}]` : "null"} byRegime=${JSON.stringify(Object.fromEntries(Object.entries(perRegimeAuc).map(([k, v]) => [k, v?.toFixed(2)])))} labelInvStable=${labelInversionStable}`);
  console.log(`domain-shift realMonthControl=${domainShift.realMonthControlSep?.toFixed(3)} absPriceControl=${domainShift.absPriceControlSep?.toFixed(3)}`);
  for (const m of METHODS) {
    const r = methodResults[m.key] as Record<string, unknown>; const sr = r.seamRealism as ReturnType<typeof computeSeamRealism>; const conc = r.concentrationMedian as Record<string, number | null>;
    console.log(`  ${m.key}: seamReject=${(r.medianSeamRejectRate as number).toFixed(3)} excess=${sr.excessRejectRate.toFixed(3)} ratio=${sr.rejectRateRatio.toFixed(2)} CI=[${sr.confidenceInterval[0].toFixed(3)},${sr.confidenceInterval[1].toFixed(3)}] sfPass=${(r.stylizedFactsPassRate as number).toFixed(2)} depDist=${(r.medianDepDist as number ?? 0).toFixed(3)} top1=${conc.top1?.toFixed(3)} uniqCov=${conc.uniqueBlockCoverage?.toFixed(2)} insuff=${r.insufficientSeamsTotal} => ${acceptance[m.key]!.pass ? "PASS" : "FAIL[" + acceptance[m.key]!.failures.join("; ") + "]"}`);
  }
  console.log(`STOP: ${results.stopStatus}`);
}

// window helpers that group real windows by SOURCE DAY (origin = date) so the grouped bootstrap resamples by day.
function pushWindowsByDayInto(out: LabeledWindow[], frames: CommonMarketFrame[], sym: string, label: 0 | 1, split: LabeledWindow["split"]): void {
  const r = logReturns(closes(frames, sym));
  for (let s = 0; s + WINDOW <= r.length; s += WINDOW) {
    const day = new Date(frames[s]?.asOfMs ?? 0).toISOString().slice(0, 10);
    out.push({ label, returns: r.slice(s, s + WINDOW), windowStart: s, windowEnd: s + WINDOW, origin: `real-${day}`, split });
  }
}
/** Domain-shift controls (Step 13): does separability survive after matching calendar/regime? */
function computeDomainShiftControls(cal: CommonMarketFrame[], dev: CommonMarketFrame[], diag: CommonMarketFrame[], simByMethod: Record<string, number[]>, _model: ReturnType<typeof trainLogistic> | null) {
  // HELD-OUT separability: train on even-indexed windows, evaluate on odd-indexed (deterministic split) — avoids the
  // in-sample optimism that would otherwise inflate small-sample controls and mask the true domain-shift picture.
  const sepBetween = (aR: number[], bR: number[]): number | null => {
    const A: LabeledWindow[] = []; const B: LabeledWindow[] = [];
    pushWindows(A, aR, 1, "A", "calibration"); pushWindows(B, bR, 0, "B", "calibration");
    const trainW: LabeledWindow[] = []; const testW: LabeledWindow[] = [];
    A.forEach((w, i) => (i % 2 === 0 ? trainW : testW).push(w));
    B.forEach((w, i) => (i % 2 === 0 ? trainW : testW).push(w));
    if (new Set(trainW.map((w) => w.label)).size < 2 || testW.filter((w) => w.label === 1).length < 1 || testW.filter((w) => w.label === 0).length < 1) return null;
    const model = trainLogistic(trainW.map((w) => windowFeatures(w.returns)), trainW.map((w) => w.label));
    const raw = rocAuc(testW.map((w) => predictProba(model, windowFeatures(w.returns))), testW.map((w) => w.label));
    return raw != null ? orientAuc(raw).separabilityAuc : null;
  };
  const calR = logReturns(closes(cal, BTC)); const devR = logReturns(closes(dev, BTC)); const diagR = logReturns(closes(diag, BTC));
  // (1) real month vs real month (calendar effect magnitude)
  const realMonthControlSep = sepBetween(calR, devR);
  const realDiagControlSep = sepBetween(devR, diagR);
  // (4) regime-stratified: separability of sim-B vs real-dev WITHIN each regime bucket (matched regime)
  const simB = simByMethod.B_HARD_FILTER ?? [];
  const regimeStratified: Record<string, number | null> = {};
  for (const reg of ["UPTREND", "DOWNTREND", "RANGE"]) {
    const realReg: number[] = []; const simReg: number[] = [];
    for (let s = 0; s + WINDOW <= devR.length; s += WINDOW) if (windowRegime(devR.slice(s, s + WINDOW)) === reg) realReg.push(...devR.slice(s, s + WINDOW));
    for (let s = 0; s + WINDOW <= simB.length; s += WINDOW) if (windowRegime(simB.slice(s, s + WINDOW)) === reg) simReg.push(...simB.slice(s, s + WINDOW));
    regimeStratified[reg] = sepBetween(realReg, simReg);
  }
  // (5) negative control: absolute-price bootstrap would be trivially separable — recorded conceptually (Phase-2A showed 0.828)
  const absPriceControlSep = 0.828; // frozen Phase-2A negative-control reference (not recomputed here)
  return { realMonthControlSep, realDiagControlSep, regimeStratifiedSimVsReal: regimeStratified, absPriceControlSep, note: "sim vs real separability that SURVIVES regime matching is a simulator artifact; separability that vanishes was a regime/calendar effect." };
}

main().catch((e) => { console.error(e); process.exit(1); });

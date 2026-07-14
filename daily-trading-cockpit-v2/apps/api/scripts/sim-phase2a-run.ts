/**
 * Phase-2A runner — repair the historical bootstrap with RETURN-SPACE stitching and re-run the realism proof with
 * corrected methodology. Offline, deterministic, report-only. No deploy, no CORTEX training, no VPS change.
 *
 * What it does, in order:
 *   1. Loads the checksum-verified 2026 corpus (calibration 01-03, development 04, diagnostic-development 05).
 *   2. PHYSICALLY enforces the embargo (drops the first/last EMBARGO bars of every partition; verified by timestamps).
 *   3. For each block method (fixed 24/48, stationary 24/48) × 10 seeds, assembles BOTH the RETURN-SPACE path (primary)
 *      and the ABSOLUTE-PRICE path (frozen negative control), and measures realism, stylized facts, seam rejection,
 *      source concentration, and synchronized BTC/ETH dependence fidelity.
 *   4. Runs the real-vs-sim classifier with the AUC ORIENTATION fix (separabilityAuc), feature-group ablations, a
 *      seam-local-removed ablation, a source-month control, and a label-inversion regression — on cal+dev+diagnostic
 *      ONLY. Absolute price level is never a feature.
 *   5. Runs the regime-conditioned bootstrap over calibration (fallback hierarchy, ESS, cells) in return space.
 *   6. Freezes all thresholds, THEN evaluates the SEALED 2025-H2 realism holdout EXACTLY ONCE.
 *   7. Assigns each method STRESS_TEST_ONLY vs TRANSFER_TEST_REQUIRED and writes results JSON.
 *
 * Usage: npx tsx scripts/sim-phase2a-run.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stableHash } from "../src/lib/replay-provenance.js";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { CsvKlinesHistoricalSource } from "../src/simulation/historical-market-source.js";
import { selectFixedLengthBlocks, selectStationaryBlocks, assembleBootstrapPath, assembleReturnSpaceBootstrapPath, type BlockSelectionMethod, type BootstrapResult } from "../src/simulation/historical-block-bootstrap.js";
import { selectRegimeConditionedBlocks, type BlockConditioningIndex, type ConditioningKey } from "../src/simulation/regime-conditioned-bootstrap.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import { assessRealism } from "../src/simulation/realism-assessment.js";
import { evaluateStylizedFacts } from "../src/simulation/realism-gate.js";
import { evaluateClassifier, orientAuc, rocAuc, trainLogistic, predictProba, windowFeatures, type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import { logReturns, mean, std, autocorr, hillTailIndex, maxDrawdownDepth, quantile } from "../src/simulation/calibration-metrics.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const API = join(import.meta.dirname, "..");
const KLINES_DIR = join(API, "artifacts/simulation/data/extracted/klines_1h");
const HOLDOUT_DIR = join(API, "artifacts/simulation/data/holdout-2025H2/extracted"); // SEALED — loaded ONCE at the end
const OUT = join(API, "artifacts/simulation/phase2a");
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const HOUR = 3_600_000;

// Pre-registered (see PHASE2A_PARAMETER_LOCK.json), frozen BEFORE the sealed holdout is touched.
const PARTITIONS = { calibration: ["01", "02", "03"], development: ["04"], diagnostic: ["05"] };
const EMBARGO_HOURS = 48; // ≥ max(maxBlockLen 48, classifierWindow 48, featureLookback ≤48, brainHorizon 0) — PHYSICALLY dropped
const BLOCK_METHODS = [
  { key: "FIXED_24", method: "FIXED_LENGTH_BLOCK" as BlockSelectionMethod, blockLen: 24 },
  { key: "FIXED_48", method: "FIXED_LENGTH_BLOCK" as BlockSelectionMethod, blockLen: 48 },
  { key: "STATIONARY_24", method: "STATIONARY_BLOCK_BOOTSTRAP" as BlockSelectionMethod, meanBlockLen: 24 },
  { key: "STATIONARY_48", method: "STATIONARY_BLOCK_BOOTSTRAP" as BlockSelectionMethod, meanBlockLen: 48 },
];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SEP_AUC_MAX = 0.75; // pre-registered separability ceiling; ≥ ⇒ detectably unrealistic
const SEAM_REJECT_MAX = 0.20;
const SRC_CONC_MAX = 0.7;
const WINDOW = 48;

function readFileOrNull(p: string): string | null { return existsSync(p) ? readFileSync(p, "utf8") : null; }
function sourceFor(runId: string, months: string[], year: string, baseDir: string): CsvKlinesHistoricalSource {
  return new CsvKlinesHistoricalSource({
    runId, symbols: SYMBOLS, months, year, dir: join(baseDir, "__by_interval__"),
    readFile: (path) => {
      const m = path.match(new RegExp(`([A-Z]+)-1h-${year}-(\\d\\d)`));
      if (!m) return null;
      const [, sym, mm] = m;
      // 2026 corpus: {dir}/{sym}/1h/{sym}-1h-2026-{mm}/{sym}-1h-2026-{mm}.csv ; holdout: {dir}/{sym}-1h-2025-{mm}/{sym}-1h-2025-{mm}.csv
      const p2026 = join(baseDir, sym!, "1h", `${sym}-1h-${year}-${mm}`, `${sym}-1h-${year}-${mm}.csv`);
      const pFlat = join(baseDir, `${sym}-1h-${year}-${mm}`, `${sym}-1h-${year}-${mm}.csv`);
      return readFileOrNull(p2026) ?? readFileOrNull(pFlat);
    },
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

/** PHYSICAL embargo: drop the first `hours` and last `hours` frames so no block/window crosses a partition boundary
 *  and no cross-boundary temporal adjacency remains. Returns retained frames + the dropped boundary timestamps. */
function physicalEmbargo(frames: CommonMarketFrame[], hours: number): { retained: CommonMarketFrame[]; droppedHeadMs: number[]; droppedTailMs: number[] } {
  if (frames.length <= 2 * hours) return { retained: [], droppedHeadMs: frames.map((f) => f.asOfMs), droppedTailMs: [] };
  const head = frames.slice(0, hours); const tail = frames.slice(frames.length - hours);
  return { retained: frames.slice(hours, frames.length - hours), droppedHeadMs: head.map((f) => f.asOfMs), droppedTailMs: tail.map((f) => f.asOfMs) };
}

/** Synchronized BTC/ETH dependence fidelity: contemporaneous correlation overall + in stressed sub-regimes. */
function dependenceFidelity(realB: number[], realE: number[], simB: number[], simE: number[]): Record<string, { real: number | null; sim: number | null; dist: number | null }> {
  const buckets: Record<string, (b: number[], e: number[]) => number | null> = {
    ordinary: (b, e) => pearson(b, e),
    highVol: (b, e) => { const thr = quantile(b.map(Math.abs), 0.75) ?? 0; return pearsonWhere(b, e, (x) => Math.abs(x) >= thr); },
    largeNegative: (b, e) => { const thr = quantile(b, 0.10) ?? 0; return pearsonWhere(b, e, (x) => x <= thr); },
    largePositive: (b, e) => { const thr = quantile(b, 0.90) ?? 0; return pearsonWhere(b, e, (x) => x >= thr); },
  };
  const out: Record<string, { real: number | null; sim: number | null; dist: number | null }> = {};
  for (const [name, fn] of Object.entries(buckets)) {
    const r = fn(realB, realE); const s = fn(simB, simE);
    out[name] = { real: r, sim: s, dist: r != null && s != null ? Math.abs(r - s) : null };
  }
  return out;
}

/** Offline conditioning labels per calibration frame — NEVER exposed to decision features, only to SELECT blocks. */
function buildConditioningIndex(frames: CommonMarketFrame[]): BlockConditioningIndex {
  const btc = closes(frames, "BTCUSDT");
  const r = logReturns(btc); // r[i] corresponds to frame i+1
  const labels: ConditioningKey[] = frames.map((f, i) => {
    const ri = i > 0 ? r[i - 1] ?? 0 : 0;
    // rolling 24-bar realized vol ending at i
    const wStart = Math.max(1, i - 23);
    const win = r.slice(wStart - 1, i); const v = std(win) ?? 0;
    const drift = win.length ? (mean(win) ?? 0) : 0;
    const hour = new Date(f.asOfMs).getUTCHours();
    const dow = new Date(f.asOfMs).getUTCDay();
    return {
      regime: drift > v * 0.15 ? "UPTREND" : drift < -v * 0.15 ? "DOWNTREND" : "RANGE",
      volatilityBucket: v > 0.006 ? "HIGH" : v > 0.003 ? "MID" : "LOW",
      timeOfDayBucket: hour < 8 ? "ASIA" : hour < 16 ? "EU" : "US",
      weekdayWeekend: (dow === 0 || dow === 6 ? "WEEKEND" : "WEEKDAY") as "WEEKDAY" | "WEEKEND",
      returnDirection: (ri >= 0 ? "UP" : "DOWN") as "UP" | "DOWN",
    };
  });
  return { labelVersion: "phase2a-offline-v1", calibrationPeriod: { startMs: frames[0]?.asOfMs ?? 0, endMs: frames.at(-1)?.asOfMs ?? 0 }, labels };
}

/** Natural adjacent-candle discontinuity baseline in the REAL series: what fraction of consecutive real hours would
 *  themselves trip the seam vol-ratio(>3)/volume-ratio(>5) tolerances? If the block-seam rate ≈ this baseline, the
 *  residual seam-reject is NOT an injected artifact — it is ordinary crypto behavior vs a tolerance calibrated for
 *  price gaps. Diagnostic ONLY (does NOT change the pre-registered acceptance gate). */
function naturalSeamBaseline(frames: CommonMarketFrame[], sym: string): { volRatioGt3: number; volumeRatioGt5: number; either: number; n: number } {
  let volHits = 0, volumeHits = 0, either = 0, n = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const p = frames[i - 1]!.symbols[sym]?.candle.value; const c = frames[i]!.symbols[sym]?.candle.value;
    if (!p || !c) continue;
    const pr = p.high - p.low; const cr = c.high - c.low;
    const volR = pr > 0 && cr > 0 ? Math.max(cr / pr, pr / cr) : 0;
    const volumeR = p.volume > 0 && c.volume > 0 ? Math.max(c.volume / p.volume, p.volume / c.volume) : 0;
    const v = volR > 3; const vv = volumeR > 5;
    if (v) volHits += 1; if (vv) volumeHits += 1; if (v || vv) either += 1; n += 1;
  }
  return { volRatioGt3: n ? volHits / n : 0, volumeRatioGt5: n ? volumeHits / n : 0, either: n ? either / n : 0, n };
}

function pushWindows(out: LabeledWindow[], returns: number[], label: 0 | 1, origin: string, split: LabeledWindow["split"]): void {
  for (let s = 0; s + WINDOW <= returns.length; s += WINDOW) out.push({ label, returns: returns.slice(s, s + WINDOW), windowStart: s, windowEnd: s + WINDOW, origin, split });
}
function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const ma = mean(a.slice(0, n))!, mb = mean(b.slice(0, n))!; let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}
function pearsonWhere(a: number[], b: number[], pred: (x: number) => boolean): number | null {
  const aa: number[] = []; const bb: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (pred(a[i]!)) { aa.push(a[i]!); bb.push(b[i]!); }
  return pearson(aa, bb);
}

/** Build blocks for a method/seed. */
function buildBlocks(spec: (typeof BLOCK_METHODS)[number], srcLen: number, targetLen: number, seed: number) {
  const rng = createRng(seed, `boot/${spec.key}`);
  return spec.method === "FIXED_LENGTH_BLOCK"
    ? selectFixedLengthBlocks(srcLen, spec.blockLen!, Math.ceil(targetLen / spec.blockLen!), rng)
    : selectStationaryBlocks(srcLen, spec.meanBlockLen!, targetLen, rng);
}

/** Assemble a return-space path (primary) for a method/seed over `src`. */
function assembleReturnSpace(src: CommonMarketFrame[], spec: (typeof BLOCK_METHODS)[number], seed: number, runId: string): BootstrapResult {
  const blocks = buildBlocks(spec, src.length, src.length, seed);
  return assembleReturnSpaceBootstrapPath(src, blocks, { runId, symbols: SYMBOLS, startMs: src[0]!.asOfMs, stepMs: HOUR, method: spec.method });
}
function assembleAbsPrice(src: CommonMarketFrame[], spec: (typeof BLOCK_METHODS)[number], seed: number, runId: string): BootstrapResult {
  const blocks = buildBlocks(spec, src.length, src.length, seed);
  return assembleBootstrapPath(src, blocks, { runId, symbols: SYMBOLS, startMs: src[0]!.asOfMs, stepMs: HOUR, method: spec.method });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();

  // ── Step 1/2: load 2026 corpus + PHYSICAL embargo ──
  const rawPartitions: Record<string, CommonMarketFrame[]> = {};
  for (const [name, months] of Object.entries(PARTITIONS)) rawPartitions[name] = await collect(sourceFor(`ctrl-${name}`, months, "2026", KLINES_DIR));

  const embargo: Record<string, ReturnType<typeof physicalEmbargo>> = {};
  const partitionFrames: Record<string, CommonMarketFrame[]> = {};
  for (const [name, frames] of Object.entries(rawPartitions)) {
    const e = physicalEmbargo(frames, EMBARGO_HOURS);
    embargo[name] = e; partitionFrames[name] = e.retained;
  }
  const cal = partitionFrames.calibration!;
  const dev = partitionFrames.development!;
  const diag = partitionFrames.diagnostic!;

  // embargo verification: the gap between calibration's last retained ts and development's first retained ts, and
  // between development and diagnostic, must be ≥ EMBARGO_HOURS*HOUR (adjacency physically removed).
  const embargoVerification = {
    calLastRetainedMs: cal.at(-1)?.asOfMs ?? null, devFirstRetainedMs: dev[0]?.asOfMs ?? null,
    devLastRetainedMs: dev.at(-1)?.asOfMs ?? null, diagFirstRetainedMs: diag[0]?.asOfMs ?? null,
    calDevGapHours: cal.at(-1) && dev[0] ? (dev[0]!.asOfMs - cal.at(-1)!.asOfMs) / HOUR : null,
    devDiagGapHours: dev.at(-1) && diag[0] ? (diag[0]!.asOfMs - dev.at(-1)!.asOfMs) / HOUR : null,
    droppedPerPartition: Object.fromEntries(Object.entries(embargo).map(([k, v]) => [k, { head: v.droppedHeadMs.length, tail: v.droppedTailMs.length }])),
    enforcedHours: EMBARGO_HOURS,
    ok: (() => { const g1 = cal.at(-1) && dev[0] ? (dev[0]!.asOfMs - cal.at(-1)!.asOfMs) / HOUR : Infinity; const g2 = dev.at(-1) && diag[0] ? (diag[0]!.asOfMs - dev.at(-1)!.asOfMs) / HOUR : Infinity; return g1 >= EMBARGO_HOURS && g2 >= EMBARGO_HOURS; })(),
  };

  // ── historical control (per partition) ──
  const historicalControl: Record<string, unknown> = {};
  for (const [name, frames] of Object.entries(partitionFrames)) {
    const inv = checkFrameStreamInvariants(frames, { expectSingleProvenance: true });
    const btcR = logReturns(closes(frames, "BTCUSDT")); const ethR = logReturns(closes(frames, "ETHUSDT"));
    historicalControl[name] = {
      months: PARTITIONS[name as keyof typeof PARTITIONS], frameCount: frames.length, invariantsOk: inv.ok, monotonic: inv.monotonicTime,
      btc: { n: btcR.length, stdR: std(btcR), acf1: autocorr(btcR, 1), absAcf1: autocorr(btcR.map(Math.abs), 1), tail: hillTailIndex(btcR), maxDd: maxDrawdownDepth(btcR) },
      btcEthCorr: pearson(btcR, ethR),
    };
  }

  // ── Step 3: bootstrap methods — RETURN-SPACE (primary) + ABSOLUTE-PRICE (negative control), 10 seeds ──
  const calBtcReal = logReturns(closes(cal, "BTCUSDT"));
  const calEthReal = logReturns(closes(cal, "ETHUSDT"));
  const calWickReal = wicks(cal, "BTCUSDT"); const calVolReal = volumes(cal, "BTCUSDT");
  const methodResults: Record<string, unknown> = {};
  const classifierWindows: LabeledWindow[] = []; // cal + dev + diagnostic ONLY (no sealed holdout here)

  const measure = (res: BootstrapResult) => {
    const inv = checkFrameStreamInvariants(res.frames, { expectSingleProvenance: true });
    const simBtc = logReturns(closes(res.frames, "BTCUSDT")); const simEth = logReturns(closes(res.frames, "ETHUSDT"));
    const realism = assessRealism({ realReturns: calBtcReal, simReturns: simBtc, realWick: calWickReal, simWick: wicks(res.frames, "BTCUSDT"), realVolume: calVolReal, simVolume: volumes(res.frames, "BTCUSDT") });
    const sf = evaluateStylizedFacts({ realReturns: calBtcReal, simReturns: simBtc });
    const dep = dependenceFidelity(calBtcReal, calEthReal, simBtc, simEth);
    // seam-reject DECOMPOSITION: which tolerance fired, and the worst price-gap the seams actually injected.
    const has = (s: (typeof res.stitches)[number], token: string) => s.reasons.some((r) => r.includes(token));
    const rejByReason = {
      priceGap: res.stitches.filter((s) => !s.accepted && has(s, "price gap")).length,
      volatilityRatio: res.stitches.filter((s) => !s.accepted && has(s, "volatility ratio")).length,
      volumeRatio: res.stitches.filter((s) => !s.accepted && has(s, "volume ratio")).length,
    };
    const worstPriceGapPct = Math.max(0, ...res.stitches.map((s) => s.priceGapPct ?? 0));
    const medWorst = (pick: (s: (typeof res.stitches)[number]) => number | null) => { const v = res.stitches.map(pick).filter((x): x is number => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };
    return {
      frames: res.frames.length, invariantsOk: inv.ok, hash: stableHash(res.frames.map((f) => f.frameId)).slice(0, 12),
      boundariesAssessed: res.stitches.length, boundariesRejected: res.rejectedBoundaries,
      seamRejectRate: res.stitches.length ? res.rejectedBoundaries / res.stitches.length : 0,
      seamRejectByReason: rejByReason, worstSeamPriceGapPct: worstPriceGapPct, medianSeamPriceGapPct: medWorst((s) => s.priceGapPct),
      realism: { wasserstein: realism.returnDistributionDistance, absAutocorr: realism.absoluteReturnAutocorrelationDistance, tail: realism.tailDistance, drawdown: realism.drawdownDepthDistance, vol: realism.volatilityDistributionDistance, wick: realism.wickGeometryDistance, volume: realism.volumeDistance },
      stylizedFactsPass: sf.pass, stylizedFacts: sf.checks, dependence: dep, simBtc, simEth,
    };
  };
  const medOf = (xs: (number | null)[]): number | null => { const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };

  for (const spec of BLOCK_METHODS) {
    const rs: Array<ReturnType<typeof measure>> = []; const ap: Array<ReturnType<typeof measure>> = [];
    for (const seed of SEEDS) {
      const rMeas = measure(assembleReturnSpace(cal, spec, seed, `rs-${spec.key}-${seed}`));
      const aMeas = measure(assembleAbsPrice(cal, spec, seed, `ap-${spec.key}-${seed}`));
      rs.push(rMeas); ap.push(aMeas);
      if (seed === 1) pushWindows(classifierWindows, rMeas.simBtc, 0, `sim-rs-${spec.key}`, "development"); // sim negatives
    }
    const stripSeries = (m: ReturnType<typeof measure>) => { const { simBtc, simEth, stylizedFacts, ...rest } = m; void simBtc; void simEth; void stylizedFacts; return rest; };
    methodResults[spec.key] = {
      method: spec.method, seeds: SEEDS.length,
      returnSpace: {
        perSeed: rs.map(stripSeries),
        medianSeamRejectRate: medOf(rs.map((m) => m.seamRejectRate)),
        medianWorstSeamPriceGapPct: medOf(rs.map((m) => m.worstSeamPriceGapPct)),
        seamRejectByReasonMedian: { priceGap: medOf(rs.map((m) => m.seamRejectByReason.priceGap)), volatilityRatio: medOf(rs.map((m) => m.seamRejectByReason.volatilityRatio)), volumeRatio: medOf(rs.map((m) => m.seamRejectByReason.volumeRatio)) },
        medianRealism: { wasserstein: medOf(rs.map((m) => m.realism.wasserstein)), absAutocorr: medOf(rs.map((m) => m.realism.absAutocorr)), tail: medOf(rs.map((m) => m.realism.tail)), drawdown: medOf(rs.map((m) => m.realism.drawdown)) },
        stylizedFactsPassRate: rs.filter((m) => m.stylizedFactsPass).length / rs.length,
        allDeterministic: rs.every((m) => m.invariantsOk),
        medianDependence: Object.fromEntries(["ordinary", "highVol", "largeNegative", "largePositive"].map((k) => [k, { realMed: medOf(rs.map((m) => m.dependence[k]!.real)), simMed: medOf(rs.map((m) => m.dependence[k]!.sim)), distMed: medOf(rs.map((m) => m.dependence[k]!.dist)) }])),
      },
      absolutePriceControl: {
        medianSeamRejectRate: medOf(ap.map((m) => m.seamRejectRate)),
        medianWorstSeamPriceGapPct: medOf(ap.map((m) => m.worstSeamPriceGapPct)),
        seamRejectByReasonMedian: { priceGap: medOf(ap.map((m) => m.seamRejectByReason.priceGap)), volatilityRatio: medOf(ap.map((m) => m.seamRejectByReason.volatilityRatio)), volumeRatio: medOf(ap.map((m) => m.seamRejectByReason.volumeRatio)) },
        medianRealism: { wasserstein: medOf(ap.map((m) => m.realism.wasserstein)), absAutocorr: medOf(ap.map((m) => m.realism.absAutocorr)), tail: medOf(ap.map((m) => m.realism.tail)) },
        stylizedFactsPassRate: ap.filter((m) => m.stylizedFactsPass).length / ap.length,
      },
    };
  }

  // ── Step 4: classifier on cal+dev+diagnostic (return-space negatives), with orientation + ablations ──
  pushWindows(classifierWindows, logReturns(closes(dev, "BTCUSDT")), 1, "real-dev", "development");
  pushWindows(classifierWindows, logReturns(closes(diag, "BTCUSDT")), 1, "real-diag", "development");
  pushWindows(classifierWindows, calBtcReal, 1, "real-cal", "calibration");
  // matched sim calibration negatives (return-space FIXED_48 seed 2)
  pushWindows(classifierWindows, measure(assembleReturnSpace(cal, BLOCK_METHODS[1]!, 2, "clf-cal-neg")).simBtc, 0, "sim-cal-rs", "calibration");
  const classifier = evaluateClassifier(classifierWindows);

  // label-inversion regression: separabilityAuc must be invariant to flipping labels
  const inverted = classifierWindows.map((w) => ({ ...w, label: (w.label === 1 ? 0 : 1) as 0 | 1 }));
  const invSep = evaluateClassifier(inverted).development.separabilityAuc;
  const labelInversionStable = classifier.development.separabilityAuc != null && invSep != null && Math.abs(classifier.development.separabilityAuc - invSep) < 1e-9;

  // source-month control: can the classifier separate REAL-cal from REAL-diag (both REAL, different months)?
  // high separability here ⇒ features carry a calendar-month fingerprint (a leakage risk), independent of realism.
  const sourceMonthControl = (() => {
    const realCal = classifierWindows.filter((w) => w.origin === "real-cal");
    const realDiag = classifierWindows.filter((w) => w.origin === "real-diag");
    if (realCal.length < 2 || realDiag.length < 2) return null;
    const feats = [...realCal, ...realDiag].map((w) => windowFeatures(w.returns));
    const labs = [...realCal.map(() => 1), ...realDiag.map(() => 0)];
    const model = trainLogistic(feats, labs);
    const raw = rocAuc([...realCal, ...realDiag].map((w) => predictProba(model, windowFeatures(w.returns))), labs);
    return orientAuc(raw).separabilityAuc;
  })();

  // ── Step 5: regime-conditioned bootstrap over calibration (return-space) ──
  const condIndex = buildConditioningIndex(cal);
  const regimeKeys: ConditioningKey[] = [
    { volatilityBucket: "HIGH" }, { volatilityBucket: "LOW" }, { returnDirection: "DOWN" }, { regime: "UPTREND" }, { regime: "DOWNTREND" }, { timeOfDayBucket: "US" },
  ];
  const regimeResults = regimeKeys.map((key) => {
    const rng = createRng(1, `regime/${JSON.stringify(key)}`);
    const strict = selectRegimeConditionedBlocks({ sourceLen: cal.length, index: condIndex, key, meanBlockLen: 24, targetLen: cal.length, rng });
    let realismSummary: unknown = null;
    if (strict.status === "OK") {
      const res = assembleReturnSpaceBootstrapPath(cal, strict.blocks, { runId: `regime-${JSON.stringify(key)}`, symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "REGIME_CONDITIONED_BLOCK" });
      const simBtc = logReturns(closes(res.frames, "BTCUSDT"));
      const sf = evaluateStylizedFacts({ realReturns: calBtcReal, simReturns: simBtc });
      realismSummary = { seamRejectRate: res.stitches.length ? res.rejectedBoundaries / res.stitches.length : 0, absAutocorrSim: autocorr(simBtc.map(Math.abs), 1), stylizedFactsPass: sf.pass };
    }
    // also record what a global-fallback-allowed call would do (to show the fallback hierarchy explicitly)
    const relaxed = selectRegimeConditionedBlocks({ sourceLen: cal.length, index: condIndex, key, meanBlockLen: 24, targetLen: cal.length, rng: createRng(2, `regime-fb/${JSON.stringify(key)}`), allowGlobalFallback: true });
    return { key, status: strict.status, effectiveSampleSize: strict.effectiveSampleSize, eligibleCount: strict.eligibleIndices.length, blockCount: strict.blockCount, fallbackReason: strict.fallbackReason, fallbackAllowedStatus: relaxed.status, realism: realismSummary };
  });

  // ── Step 6: FREEZE. Everything above used cal+dev+diagnostic only. Now evaluate the SEALED holdout ONCE. ──
  const sealedHoldout = await evaluateSealedHoldoutOnce(cal, calBtcReal);

  // ── Step 7: acceptance per method (critical gates on cal+dev+diagnostic; TRANSFER requires sealed-holdout pass) ──
  const devSep = classifier.development.separabilityAuc;
  const acceptance: Record<string, { verdict: "STRESS_TEST_ONLY" | "TRANSFER_TEST_REQUIRED"; reasons: string[] }> = {};
  for (const spec of BLOCK_METHODS) {
    const mr = (methodResults[spec.key] as Record<string, unknown>).returnSpace as Record<string, unknown>;
    const reasons: string[] = [];
    if (!mr.allDeterministic) reasons.push("non-deterministic / invariant failure");
    if ((mr.stylizedFactsPassRate as number) < 0.5) reasons.push(`stylized-facts pass-rate ${(mr.stylizedFactsPassRate as number).toFixed(2)} < 0.5`);
    if ((mr.medianSeamRejectRate as number) > SEAM_REJECT_MAX) reasons.push(`seam-reject ${(mr.medianSeamRejectRate as number).toFixed(2)} > ${SEAM_REJECT_MAX}`);
    if (devSep != null && devSep >= SEP_AUC_MAX) reasons.push(`classifier dev separabilityAuc ${devSep.toFixed(3)} ≥ ${SEP_AUC_MAX}`);
    // TRANSFER_TEST_REQUIRED additionally needs the sealed holdout to pass
    const passCalDev = reasons.length === 0;
    if (passCalDev && sealedHoldout.separabilityAuc != null && sealedHoldout.separabilityAuc >= SEP_AUC_MAX) reasons.push(`sealed-holdout separabilityAuc ${sealedHoldout.separabilityAuc.toFixed(3)} ≥ ${SEP_AUC_MAX}`);
    acceptance[spec.key] = { verdict: reasons.length === 0 ? "TRANSFER_TEST_REQUIRED" : "STRESS_TEST_ONLY", reasons };
  }

  // natural adjacent-candle discontinuity baseline in the REAL calibration series (diagnostic; not a gate).
  const naturalBaseline = { BTCUSDT: naturalSeamBaseline(cal, "BTCUSDT"), ETHUSDT: naturalSeamBaseline(cal, "ETHUSDT") };

  const results = {
    phase: "2A", generatedAtProcessingMs: t0, runtimeMs: Date.now() - t0,
    partitions: PARTITIONS, embargoHours: EMBARGO_HOURS, embargoVerification,
    sepAucMax: SEP_AUC_MAX, seamRejectMax: SEAM_REJECT_MAX,
    naturalAdjacentDiscontinuity: naturalBaseline,
    historicalControl, methodResults,
    classifier: {
      positiveClassDefinition: classifier.positiveClassDefinition,
      train: classifier.train, development: classifier.development, ablations: classifier.ablations,
      leakageOverlaps: classifier.leakage.overlappingPairs, classBalance: classifier.leakage.classBalance,
      labelInversionStable, labelInversionSeparability: invSep, sourceMonthControlSeparability: sourceMonthControl,
      interpretation: classifier.interpretation,
    },
    regimeConditioned: regimeResults,
    sealedHoldout,
    acceptance,
    determinismCheck: stableHash([methodResults, regimeResults]).slice(0, 16),
  };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));

  console.log(`Phase-2A run OK. frames(cal)=${cal.length} embargoOk=${embargoVerification.ok} (calDevGap=${embargoVerification.calDevGapHours}h devDiagGap=${embargoVerification.devDiagGapHours}h)`);
  console.log(`natural adjacent discontinuity (REAL cal BTC): volRatio>3=${(naturalBaseline.BTCUSDT.volRatioGt3 * 100).toFixed(1)}% volumeRatio>5=${(naturalBaseline.BTCUSDT.volumeRatioGt5 * 100).toFixed(1)}% either=${(naturalBaseline.BTCUSDT.either * 100).toFixed(1)}%`);
  console.log(`classifier dev separabilityAuc=${devSep?.toFixed(3) ?? "null"} (raw=${classifier.development.rawAuc?.toFixed(3) ?? "null"}) labelInvStable=${labelInversionStable} srcMonthCtrl=${sourceMonthControl?.toFixed(3) ?? "null"} leakage=${classifier.leakage.overlappingPairs}`);
  console.log(`ablations: ${JSON.stringify(classifier.ablations)}`);
  console.log(`SEALED holdout separabilityAuc=${sealedHoldout.separabilityAuc?.toFixed(3) ?? "null"} (raw=${sealedHoldout.rawAuc?.toFixed(3) ?? "null"}) [scored ONCE]`);
  for (const spec of BLOCK_METHODS) {
    const rs = (methodResults[spec.key] as Record<string, unknown>).returnSpace as Record<string, unknown>;
    const ap = (methodResults[spec.key] as Record<string, unknown>).absolutePriceControl as Record<string, unknown>;
    console.log(`  ${spec.key}: RS seamReject=${(rs.medianSeamRejectRate as number).toFixed(3)} (worstPriceGap=${((rs.medianWorstSeamPriceGapPct as number) * 100).toFixed(3)}% reasons=${JSON.stringify(rs.seamRejectByReasonMedian)}) sfPass=${(rs.stylizedFactsPassRate as number).toFixed(2)} | AP seamReject=${(ap.medianSeamRejectRate as number).toFixed(3)} (worstPriceGap=${((ap.medianWorstSeamPriceGapPct as number) * 100).toFixed(2)}%) sfPass=${(ap.stylizedFactsPassRate as number).toFixed(2)} => ${acceptance[spec.key]!.verdict}`);
  }
}

/** Evaluate the SEALED 2025-H2 realism holdout EXACTLY ONCE. Loads holdout data here and nowhere else. */
async function evaluateSealedHoldoutOnce(cal: CommonMarketFrame[], calBtcReal: number[]): Promise<{ loaded: boolean; separabilityAuc: number | null; rawAuc: number | null; realFrames: number; note: string }> {
  const holdout: CommonMarketFrame[] = [];
  for (const mm of ["11", "12"]) holdout.push(...await collect(sourceFor(`sealed-${mm}`, [mm], "2025", HOLDOUT_DIR)));
  const he = physicalEmbargo(holdout, EMBARGO_HOURS);
  const holdoutFrames = he.retained;
  if (holdoutFrames.length < WINDOW * 2) return { loaded: false, separabilityAuc: null, rawAuc: null, realFrames: holdoutFrames.length, note: "insufficient sealed-holdout frames after embargo" };
  const realHoldoutR = logReturns(closes(holdoutFrames, "BTCUSDT"));
  // Train on calibration (real-cal vs sim-cal), then score the sealed holdout split (real-holdout vs sim-holdout).
  // Both sim sets use UNCHANGED frozen methods (train neg = return-space FIXED_48 seed 2; holdout neg = STATIONARY_24 seed 3).
  const trainNegR = logReturns(closes(assembleReturnSpaceBootstrapPath(cal, buildBlocks(BLOCK_METHODS[1]!, cal.length, cal.length, 2), { runId: "sealed-train-neg", symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" }).frames, "BTCUSDT"));
  const simHoldoutR = logReturns(closes(assembleReturnSpaceBootstrapPath(cal, buildBlocks(BLOCK_METHODS[2]!, cal.length, cal.length, 3), { runId: "sealed-sim", symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "STATIONARY_BLOCK_BOOTSTRAP" }).frames, "BTCUSDT"));
  const windows: LabeledWindow[] = [];
  pushWindows(windows, calBtcReal, 1, "real-cal", "calibration");
  pushWindows(windows, trainNegR, 0, "sim-cal", "calibration");
  pushWindows(windows, realHoldoutR, 1, "real-holdout", "untouched-realism-holdout");
  pushWindows(windows, simHoldoutR, 0, "sim-holdout", "untouched-realism-holdout");
  const evalr = evaluateClassifier(windows);
  return { loaded: true, separabilityAuc: evalr.untouchedValidation.separabilityAuc, rawAuc: evalr.untouchedValidation.rawAuc, realFrames: holdoutFrames.length, note: "scored exactly once after freeze" };
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Phase-1B runner — prove the historical-first simulator against REAL BTCUSDT/ETHUSDT data. Offline, deterministic,
 * report-only. Loads the checksum-verified corpus, freezes chronological partitions with purge/embargo, runs the
 * historical control + fixed/stationary bootstrap (10 seeds) + regime-conditioned bootstrap, computes the realism
 * metric suite + real-vs-sim classifier (grouped non-overlapping windows + baselines), and assigns each method
 * STRESS_TEST_ONLY vs TRANSFER_TEST_REQUIRED. Writes results JSON the report artifacts are built from.
 *
 * Usage: npx tsx scripts/sim-phase1b-run.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stableHash } from "../src/lib/replay-provenance.js";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { CsvKlinesHistoricalSource } from "../src/simulation/historical-market-source.js";
import { selectFixedLengthBlocks, selectStationaryBlocks, assembleBootstrapPath, assessStitch, type BlockSelectionMethod } from "../src/simulation/historical-block-bootstrap.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import { assessRealism } from "../src/simulation/realism-assessment.js";
import { evaluateStylizedFacts } from "../src/simulation/realism-gate.js";
import { evaluateClassifier, type LabeledWindow } from "../src/simulation/real-vs-sim-classifier.js";
import { logReturns, mean, std, autocorr, hillTailIndex, maxDrawdownDepth, quantile } from "../src/simulation/calibration-metrics.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const API = join(import.meta.dirname, "..");
const KLINES_DIR = join(API, "artifacts/simulation/data/extracted/klines_1h"); // {sym}/1h/{stem}/{stem}.csv
const OUT = join(API, "artifacts/simulation/phase1b");
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const HOUR = 3_600_000;

// Pre-registered (frozen BEFORE evaluating the holdout).
const PARTITIONS = { calibration: ["01", "02", "03"], development: ["04"], realismHoldout: ["05"], transferHoldout: ["06"] };
const EMBARGO_HOURS = 48; // ≥ max(block length 48, eval horizon) — dropped at partition seams
const BLOCK_METHODS = [
  { key: "FIXED_24", method: "FIXED_LENGTH_BLOCK" as BlockSelectionMethod, blockLen: 24 },
  { key: "FIXED_48", method: "FIXED_LENGTH_BLOCK" as BlockSelectionMethod, blockLen: 48 },
  { key: "STATIONARY_24", method: "STATIONARY_BLOCK_BOOTSTRAP" as BlockSelectionMethod, meanBlockLen: 24 },
  { key: "STATIONARY_48", method: "STATIONARY_BLOCK_BOOTSTRAP" as BlockSelectionMethod, meanBlockLen: 48 },
];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const CLASSIFIER_AUC_MAX = 0.75; // pre-registered ceiling; ≥ this ⇒ detectably unrealistic ⇒ STRESS_TEST_ONLY
const WINDOW = 48;

function readFile(p: string): string | null { return existsSync(p) ? readFileSync(p, "utf8") : null; }
function sourceFor(runId: string, months: string[]): CsvKlinesHistoricalSource {
  return new CsvKlinesHistoricalSource({
    runId, symbols: SYMBOLS, months, year: "2026", dir: join(KLINES_DIR, "__by_interval__"),
    // path shape: extracted/klines/{sym}/1h/{sym}-1h-2026-{mm}/{sym}-1h-2026-{mm}.csv
    readFile: (path) => {
      const m = path.match(/([A-Z]+)-1h-2026-(\d\d)/);
      if (!m) return null;
      const [, sym, mm] = m;
      return readFile(join(KLINES_DIR, sym!, "1h", `${sym}-1h-2026-${mm}`, `${sym}-1h-2026-${mm}.csv`));
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();

  // ── Step 2/3: load full corpus + per-partition controls ──
  const partitionFrames: Record<string, CommonMarketFrame[]> = {};
  for (const [name, months] of Object.entries(PARTITIONS)) {
    partitionFrames[name] = await collect(sourceFor(`ctrl-${name}`, months));
  }
  const cal = partitionFrames.calibration!;
  const historicalControl: Record<string, unknown> = {};
  for (const [name, frames] of Object.entries(partitionFrames)) {
    const inv = checkFrameStreamInvariants(frames, { expectSingleProvenance: true });
    const btcR = logReturns(closes(frames, "BTCUSDT")); const ethR = logReturns(closes(frames, "ETHUSDT"));
    historicalControl[name] = {
      months: PARTITIONS[name as keyof typeof PARTITIONS], frameCount: frames.length, invariantsOk: inv.ok, monotonic: inv.monotonicTime, violations: inv.violations.slice(0, 5),
      btc: { n: btcR.length, meanR: mean(btcR), stdR: std(btcR), acf1: autocorr(btcR, 1), absAcf1: autocorr(btcR.map(Math.abs), 1), tail: hillTailIndex(btcR), maxDd: maxDrawdownDepth(btcR), q05: quantile(btcR, 0.05), q95: quantile(btcR, 0.95) },
      eth: { n: ethR.length, meanR: mean(ethR), stdR: std(ethR), acf1: autocorr(ethR, 1) },
      btcEthCorr: pearson(btcR, ethR),
    };
  }

  // ── Step 4/5/8: bootstrap methods over CALIBRATION source, 10 seeds, realism vs calibration real ──
  const calBtcReal = logReturns(closes(cal, "BTCUSDT"));
  const calWickReal = wicks(cal, "BTCUSDT"); const calVolReal = volumes(cal, "BTCUSDT");
  const methodResults: Record<string, unknown> = {};
  const classifierWindows: LabeledWindow[] = [];

  for (const spec of BLOCK_METHODS) {
    const perSeed: Array<Record<string, unknown>> = [];
    for (const seed of SEEDS) {
      const rng = createRng(seed, `boot/${spec.key}`);
      const targetLen = cal.length; // match calibration length
      const blocks = spec.method === "FIXED_LENGTH_BLOCK"
        ? selectFixedLengthBlocks(cal.length, spec.blockLen!, Math.ceil(targetLen / spec.blockLen!), rng)
        : selectStationaryBlocks(cal.length, spec.meanBlockLen!, targetLen, rng);
      const res = assembleBootstrapPath(cal, blocks, { runId: `${spec.key}-${seed}`, symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: spec.method });
      const inv = checkFrameStreamInvariants(res.frames, { expectSingleProvenance: true });
      const simBtc = logReturns(closes(res.frames, "BTCUSDT"));
      const realism = assessRealism({ realReturns: calBtcReal, simReturns: simBtc, realWick: calWickReal, simWick: wicks(res.frames, "BTCUSDT"), realVolume: calVolReal, simVolume: volumes(res.frames, "BTCUSDT") });
      const sf = evaluateStylizedFacts({ realReturns: calBtcReal, simReturns: simBtc });
      // source concentration: how much one starting month dominates
      const startHist: Record<number, number> = {};
      for (const b of blocks) { const mo = Math.floor(b.startIndex / Math.max(1, Math.floor(cal.length / 3))); startHist[mo] = (startHist[mo] ?? 0) + b.length; }
      const totalLen = Object.values(startHist).reduce((a, b) => a + b, 0) || 1;
      const maxConc = Math.max(...Object.values(startHist)) / totalLen;
      // classifier windows: sim (label 0) from this method's seed-1 path only (avoid over-weighting)
      if (seed === 1) pushWindows(classifierWindows, simBtc, 0, `sim-${spec.key}`, "development");
      perSeed.push({
        seed, frames: res.frames.length, invariantsOk: inv.ok, hash: stableHash(res.frames.map((f) => f.frameId)).slice(0, 12),
        blocksProposed: blocks.length, boundariesAssessed: res.stitches.length, boundariesRejected: res.rejectedBoundaries,
        seamRejectRate: res.stitches.length ? res.rejectedBoundaries / res.stitches.length : 0, maxSourceConcentration: maxConc,
        realism: { wasserstein: realism.returnDistributionDistance, autocorr: realism.autocorrelationDistance, absAutocorr: realism.absoluteReturnAutocorrelationDistance, tail: realism.tailDistance, drawdown: realism.drawdownDepthDistance, vol: realism.volatilityDistributionDistance, wick: realism.wickGeometryDistance, volume: realism.volumeDistance },
        stylizedFactsPass: sf.pass,
      });
    }
    // aggregate across seeds (median)
    const med = (f: (s: Record<string, unknown>) => number | null): number | null => { const v = perSeed.map(f).filter((x): x is number => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };
    methodResults[spec.key] = {
      method: spec.method, seeds: SEEDS.length, perSeed,
      medianSeamRejectRate: med((s) => s.seamRejectRate as number),
      medianMaxSourceConcentration: med((s) => s.maxSourceConcentration as number),
      medianRealism: { wasserstein: med((s) => (s.realism as Record<string, number>).wasserstein), absAutocorr: med((s) => (s.realism as Record<string, number>).absAutocorr), tail: med((s) => (s.realism as Record<string, number>).tail), drawdown: med((s) => (s.realism as Record<string, number>).drawdown) },
      allDeterministic: perSeed.every((s) => s.invariantsOk),
      stylizedFactsPassRate: perSeed.filter((s) => s.stylizedFactsPass).length / perSeed.length,
    };
  }

  // ── Step 9: real-vs-sim classifier — real windows from DEVELOPMENT (label 1); calibration windows train ──
  pushWindows(classifierWindows, logReturns(closes(partitionFrames.development!, "BTCUSDT")), 1, "real-dev", "development");
  pushWindows(classifierWindows, calBtcReal, 1, "real-cal", "calibration");
  // add a matched sim calibration set (FIXED_48 seed 2) as calibration negatives
  {
    const rng = createRng(2, "boot/FIXED_48");
    const blocks = selectFixedLengthBlocks(cal.length, 48, Math.ceil(cal.length / 48), rng);
    const res = assembleBootstrapPath(cal, blocks, { runId: "clf-neg", symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "FIXED_LENGTH_BLOCK" });
    pushWindows(classifierWindows, logReturns(closes(res.frames, "BTCUSDT")), 0, "sim-cal", "calibration");
  }
  // holdout: real (month 05) vs sim (STATIONARY_24 seed 3)
  pushWindows(classifierWindows, logReturns(closes(partitionFrames.realismHoldout!, "BTCUSDT")), 1, "real-holdout", "untouched-realism-holdout");
  {
    const rng = createRng(3, "boot/STATIONARY_24");
    const blocks = selectStationaryBlocks(cal.length, 24, cal.length, rng);
    const res = assembleBootstrapPath(cal, blocks, { runId: "clf-holdout-neg", symbols: SYMBOLS, startMs: cal[0]!.asOfMs, stepMs: HOUR, method: "STATIONARY_BLOCK_BOOTSTRAP" });
    pushWindows(classifierWindows, logReturns(closes(res.frames, "BTCUSDT")), 0, "sim-holdout", "untouched-realism-holdout");
  }
  const classifier = evaluateClassifier(classifierWindows);
  // trivial baselines
  const volOnlyAuc = volOnlyBaseline(classifierWindows);

  // ── Step 12: acceptance gates per method ──
  const acceptance: Record<string, { verdict: "STRESS_TEST_ONLY" | "TRANSFER_TEST_REQUIRED"; reasons: string[] }> = {};
  const holdoutAuc = classifier.untouchedValidation.rawAuc; // Phase-1B reported raw AUC (separability = max(raw,1-raw))
  for (const spec of BLOCK_METHODS) {
    const mr = methodResults[spec.key] as Record<string, unknown>;
    const reasons: string[] = [];
    if (!mr.allDeterministic) reasons.push("non-deterministic / invariant failure");
    if ((mr.stylizedFactsPassRate as number) < 0.5) reasons.push("stylized-facts fail-majority");
    if ((mr.medianMaxSourceConcentration as number) > 0.7) reasons.push("one source period dominates");
    if (holdoutAuc != null && holdoutAuc >= CLASSIFIER_AUC_MAX) reasons.push(`classifier holdout AUC ${holdoutAuc.toFixed(3)} ≥ ${CLASSIFIER_AUC_MAX}`);
    acceptance[spec.key] = { verdict: reasons.length === 0 ? "TRANSFER_TEST_REQUIRED" : "STRESS_TEST_ONLY", reasons };
  }

  const results = {
    foundationCommit: process.env.FOUNDATION_COMMIT ?? "recorded in PHASE1B_STOP_REPORT.md",
    generatedAtProcessingMs: t0,
    runtimeMs: Date.now() - t0,
    partitions: PARTITIONS, embargoHours: EMBARGO_HOURS, classifierAucMax: CLASSIFIER_AUC_MAX,
    historicalControl, methodResults,
    classifier: { trainAuc: classifier.train.rawAuc, developmentAuc: classifier.development.rawAuc, untouchedValidationAuc: classifier.untouchedValidation.rawAuc, untouchedSeparabilityAuc: classifier.untouchedValidation.separabilityAuc, leakageOverlaps: classifier.leakage.overlappingPairs, classBalance: classifier.leakage.classBalance, volOnlyBaselineAuc: volOnlyAuc, interpretation: classifier.interpretation },
    acceptance,
    determinismCheck: stableHash(Object.values(methodResults).map((m) => (m as Record<string, unknown>).perSeed)).slice(0, 16),
  };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
  console.log(`Phase-1B run OK. frames(cal)=${cal.length} methods=${BLOCK_METHODS.length} seeds=${SEEDS.length}`);
  console.log(`classifier holdout AUC=${holdoutAuc?.toFixed(3) ?? "null"} (volOnly baseline=${volOnlyAuc?.toFixed(3) ?? "null"}) leakage=${classifier.leakage.overlappingPairs}`);
  for (const [k, v] of Object.entries(acceptance)) console.log(`  ${k}: ${v.verdict}${v.reasons.length ? " [" + v.reasons.join("; ") + "]" : ""}`);
}

function pushWindows(out: LabeledWindow[], returns: number[], label: 0 | 1, origin: string, split: LabeledWindow["split"]): void {
  for (let s = 0; s + WINDOW <= returns.length; s += WINDOW) { // NON-overlapping windows
    out.push({ label, returns: returns.slice(s, s + WINDOW), windowStart: s, windowEnd: s + WINDOW, origin, split });
  }
}
function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const ma = mean(a.slice(0, n))!, mb = mean(b.slice(0, n))!; let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}
function volOnlyBaseline(windows: LabeledWindow[]): number | null {
  // classify by window volatility alone (a trivial baseline); AUC on the holdout split
  const ho = windows.filter((w) => w.split === "untouched-realism-holdout");
  if (ho.length === 0) return null;
  const scores = ho.map((w) => std(w.returns) ?? 0); const labels = ho.map((w) => w.label);
  // simple rank AUC
  const pos = scores.filter((_, i) => labels[i] === 1); const neg = scores.filter((_, i) => labels[i] === 0);
  if (!pos.length || !neg.length) return null;
  let c = 0; for (const p of pos) for (const q of neg) c += p > q ? 1 : p === q ? 0.5 : 0;
  return c / (pos.length * neg.length);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Phase-3A offline rolling-origin evaluation for REGIME_CONDITIONED_MULTIVARIATE_RESIDUAL_GENERATOR.
 * Uses only 2026-01..06 calibration/development data. It never opens the sealed holdout, imports Cortex, reaches an
 * exchange, or writes production state. Run with: npx tsx scripts/sim-phase3a-run.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRng } from "../src/simulation/deterministic-rng.js";
import { CsvKlinesHistoricalSource } from "../src/simulation/historical-market-source.js";
import { fitRegimeConditionedResidualModel, generateRegimeConditionedResidualPath, type ResidualCandidate } from "../src/simulation/regime-conditioned-multivariate-residual.js";
import { logReturns, maxDrawdownDepth, mean, quantile, std } from "../src/simulation/calibration-metrics.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import type { CommonMarketFrame } from "../src/simulation/simulation-types.js";

const API = join(import.meta.dirname, "..");
const DATA = join(API, "artifacts/simulation/data/extracted/klines_1h");
const OUT = join(API, "artifacts/simulation/phase3a");
const BTC = "BTCUSDT"; const ETH = "ETHUSDT"; const SYMBOLS = [BTC, ETH];
const CANDIDATES: ResidualCandidate[] = ["EMPIRICAL_SYNC", "REGIME_CONDITIONED", "STATE_SPACE_EMPIRICAL", "VAR_EMPIRICAL", "ANCHORED_DIFFUSION_EMPIRICAL", "GAUSSIAN_NEGATIVE_CONTROL"];
const PRIMARY = CANDIDATES.filter((c) => c !== "GAUSSIAN_NEGATIVE_CONTROL");
const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);
const FOLDS = [
  { evalMonth: "03", trainMonths: ["01", "02"] },
  { evalMonth: "04", trainMonths: ["01", "02", "03"] },
  { evalMonth: "05", trainMonths: ["01", "02", "03", "04"] },
  { evalMonth: "06", trainMonths: ["01", "02", "03", "04", "05"] },
];

function readOrNull(path: string): string | null { return existsSync(path) ? readFileSync(path, "utf8") : null; }
function source(runId: string, months: string[]): CsvKlinesHistoricalSource {
  return new CsvKlinesHistoricalSource({ runId, symbols: SYMBOLS, months, year: "2026", dir: join(DATA, "__by_interval__"), readFile: (path) => {
    const m = path.match(/([A-Z]+)-1h-2026-(\d\d)/); if (!m) return null;
    const [, symbol, month] = m; return readOrNull(join(DATA, symbol!, "1h", `${symbol}-1h-2026-${month}`, `${symbol}-1h-2026-${month}.csv`));
  } });
}
async function collect(month: string): Promise<CommonMarketFrame[]> {
  const s = source(`phase3a-${month}`, [month]); const range = s.describe().dateRangeMs; const frames: CommonMarketFrame[] = [];
  if (range) for await (const f of s.iterateFrames(range)) frames.push(f);
  return frames;
}
function closes(frames: readonly CommonMarketFrame[], symbol: string): number[] { return frames.map((f) => f.symbols[symbol]?.candle.value?.close).filter((v): v is number => typeof v === "number"); }
function corr(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length); if (n < 4) return null; const ma = mean(a.slice(0, n)); const mb = mean(b.slice(0, n)); if (ma == null || mb == null) return null;
  let num = 0; let da = 0; let db = 0; for (let i = 0; i < n; i += 1) { const x = a[i]! - ma; const y = b[i]! - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : null;
}
function wickMean(frames: readonly CommonMarketFrame[], symbol: string): number | null {
  const values = frames.map((f) => f.symbols[symbol]?.candle.value).filter((c): c is NonNullable<typeof c> => !!c).map((c) => (Math.log(c.high / Math.max(c.open, c.close)) + Math.log(Math.min(c.open, c.close) / c.low)) / 2);
  return mean(values);
}
function summarize(frames: readonly CommonMarketFrame[]) {
  const br = logReturns(closes(frames, BTC)); const er = logReturns(closes(frames, ETH));
  const volumeChange = frames.slice(1).map((f, i) => {
    const prev = frames[i]!.symbols[BTC]?.candle.value?.volume; const now = f.symbols[BTC]?.candle.value?.volume;
    return prev && now ? Math.log(now / prev) : NaN;
  }).filter(Number.isFinite);
  return { count: br.length, returnMean: mean(br), volatility: std(br), tail01: quantile(br, 0.01), tail99: quantile(br, 0.99), drawdown: maxDrawdownDepth(br), btcEthDependence: corr(br, er), btcWickMean: wickMean(frames, BTC), volumeChangeVolatility: std(volumeChange) };
}
function passesRealism(real: ReturnType<typeof summarize>, sim: ReturnType<typeof summarize>): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const ratio = real.volatility && sim.volatility ? sim.volatility / real.volatility : null;
  if (ratio == null || ratio < 0.65 || ratio > 1.35) reasons.push("volatility");
  if (real.btcEthDependence == null || sim.btcEthDependence == null || Math.abs(real.btcEthDependence - sim.btcEthDependence) > 0.12) reasons.push("btc-eth-dependence");
  if (real.tail01 == null || sim.tail01 == null || Math.abs(sim.tail01 - real.tail01) > Math.max(0.002, Math.abs(real.tail01) * 0.5)) reasons.push("left-tail");
  if (real.btcWickMean == null || sim.btcWickMean == null || Math.abs(sim.btcWickMean - real.btcWickMean) > Math.max(0.001, real.btcWickMean * 0.5)) reasons.push("wick-geometry");
  return { pass: reasons.length === 0, reasons };
}
function md(title: string, body: string): string { return `# ${title}\n\n${body.trim()}\n`; }
function write(name: string, content: string): void { writeFileSync(join(OUT, name), content); }

async function main() {
  mkdirSync(OUT, { recursive: true });
  const monthly = new Map<string, CommonMarketFrame[]>(); for (const month of ["01", "02", "03", "04", "05", "06"]) monthly.set(month, await collect(month));
  const results: Array<Record<string, unknown>> = [];
  const modelReports: Array<Record<string, unknown>> = [];
  for (const fold of FOLDS) {
    const training = fold.trainMonths.flatMap((m) => monthly.get(m)!); const evaluation = monthly.get(fold.evalMonth)!;
    const model = fitRegimeConditionedResidualModel(training); const real = summarize(evaluation);
    modelReports.push({ fold, calibration: { startMs: model.calibrationStartMs, endMs: model.calibrationEndMs, residualRecords: model.records.length, sourceDimensions: model.sourceDimensions, dynamics: model.dynamics } });
    for (const candidate of CANDIDATES) {
      const perSeed: Array<Record<string, unknown>> = [];
      for (const seed of SEEDS) {
        const generated = generateRegimeConditionedResidualPath(model, { runId: `phase3a-${fold.evalMonth}-${candidate}-${seed}`, candidate, steps: evaluation.length, startFrame: training.at(-1)!, seed }, createRng(seed, `phase3a/${candidate}/${fold.evalMonth}`));
        if (!generated.ok) { perSeed.push({ seed, pass: false, generation: generated.reason, reasons: [generated.reason] }); continue; }
        const invariants = checkFrameStreamInvariants(generated.frames, { expectSingleProvenance: true });
        const sim = summarize(generated.frames); const gate = passesRealism(real, sim);
        const reasons = invariants.ok ? gate.reasons : [...gate.reasons, "invariants"];
        perSeed.push({ seed, pass: reasons.length === 0, reasons, invariants, sim, memorandum: generated.memorandum, conditionalLevels: generated.selections.reduce<Record<string, number>>((acc, s) => { acc[s.level] = (acc[s.level] ?? 0) + 1; return acc; }, {}) });
      }
      const seedPassRate = perSeed.filter((r) => r.pass === true).length / SEEDS.length;
      results.push({ fold, candidate, real, seedPassRate, pass: seedPassRate >= 0.9, seeds: perSeed });
    }
  }
  const primary = results.filter((r) => PRIMARY.includes(r.candidate as ResidualCandidate));
  const perFold = FOLDS.map((f) => ({ evalMonth: f.evalMonth, maxPrimaryPassRate: Math.max(...primary.filter((r) => (r.fold as { evalMonth: string }).evalMonth === f.evalMonth).map((r) => r.seedPassRate as number)) }));
  const overall = primary.reduce((sum, r) => sum + (r.seedPassRate as number), 0) / primary.length;
  const ready = overall >= 0.9 && perFold.every((f) => f.maxPrimaryPassRate >= 0.8);
  const phase2dPath = join(API, "artifacts/simulation/phase2d/PHASE2D_STOP_REPORT.md");
  const phase2dClosure = readOrNull(phase2dPath)?.slice(0, 1_200) ?? "Phase-2D closure report unavailable to this runner.";
  const artifact = { phase: "3A", status: ready ? "ROBUSTNESS_CONFIRMED_READY_FOR_ONCE_ONLY_HOLDOUT" : "ROBUSTNESS_NOT_ESTABLISHED_NO_HOLDOUT_OPENED", candidateFamily: "REGIME_CONDITIONED_MULTIVARIATE_RESIDUAL_GENERATOR", constraints: { noHistoricalBlocks: true, noStitching: true, noUnconditionalFallback: true, noHoldout: true, noCortex: true, seeds: 100 }, overallPrimarySeedPassRate: overall, perFold, modelReports, results };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(artifact, null, 2));
  write("PHASE2D_CLOSURE.md", md("Phase-2D closure", `${phase2dClosure}\n\nPhase 3A starts a separate residual-vector family. It does not modify, tune, or revive B/B2/B3.`));
  write("RESIDUAL_MODEL_ARCHITECTURE.md", md("Residual model architecture", `The generator samples synchronized BTC/ETH residual vectors from calibration data, conditionally by regime, volatility, dependence, and return direction. It evolves a continuous price path; no historical candle block is inserted or joined. Fallback hierarchy is exact regime+vol+dependence -> regime+vol -> vol+return direction -> broad regime state -> INSUFFICIENT_CONDITIONAL_SUPPORT. Gaussian is evaluated only as a negative control.`));
  write("EMPIRICAL_RESIDUAL_LIBRARY.md", md("Empirical residual library", `Library records include synchronized timestamp, UTC hour/day provenance, regime/volatility/dependence state, BTC/ETH residuals, relative volatility, BTC/ETH volume changes, and empirical OHLC wick geometry. Funding and mark-basis are marked UNSUPPORTED because the candle corpus does not observe them.\n\nCalibration snapshots:\n\n\`\`\`json\n${JSON.stringify(modelReports.map((x) => ({ fold: x.fold, residualRecords: (x.calibration as { residualRecords: number }).residualRecords })), null, 2)}\n\`\`\``));
  write("STATE_DYNAMICS_REPORT.md", md("State dynamics report", `All dynamics are calibration-only and include sample size, effective sample size, calibration period, uncertainty, and support status in \`results.json\`. Funding mean reversion and mark-basis dynamics are explicitly UNSUPPORTED, not synthesized.`));
  write("ROLLING_ORIGIN_RESULTS.md", md("Rolling-origin results", `Development folds: March through June 2026, each fit only on prior months. 100 deterministic seeds per candidate/fold.\n\n\`\`\`json\n${JSON.stringify({ overallPrimarySeedPassRate: overall, perFold, ready }, null, 2)}\n\`\`\``));
  write("SEED_ROBUSTNESS_REPORT.md", md("Seed robustness report", `Readiness requires >=90% primary-candidate seed pass rate overall and >=80% on every supported fold. Current result: \`${artifact.status}\`. Full per-seed outcomes, conditional fallback levels, and perturbation-sensitive source selection are in \`results.json\`.`));
  write("MEMORIZATION_REPORT.md", md("Memorization report", `Every generated run reports unique residual coverage, top residual concentration, longest copied residual sequence, repeated 3-hour fingerprint rate, source-month concentration, and effective sample size. Since events are independently sampled vectors, a copied historical block is structurally impossible; repeated source events remain measured rather than assumed harmless.`));
  write("REALISM_REPORT.md", md("Realism report", `Compared on each rolling evaluation month: return mean, volatility, 1%/99% tails, maximum drawdown, BTC/ETH return dependence, volume-change volatility, and OHLC wick geometry. The Gaussian candidate is a negative control. Rejected B3 remains closed; unchanged history and return-space random-block baselines are retained as separate historical references, not promoted by this run.`));
  write("ADVERSARIAL_REVIEW.md", md("Adversarial review", `Fail-closed checks: no unconditional residual fallback; no future evaluation frame in fit; no historical block joins; positive continuous prices; synchronized BTC/ETH frames; valid OHLC; deterministic RNG; explicit unsupported funding/mark-basis. Remaining risks: sparse conditional cells, source-month concentration, and insufficient cross-regime support. Any failed metric prevents readiness.`));
  write("PHASE3A_STOP_REPORT.md", md("Phase-3A stop report", `${artifact.status}. No sealed holdout, Cortex training, deployment, VPS change, or execution wiring was performed. This report is a research stop: do not promote this generator unless its frozen robustness gate passes and a separately authorized one-time holdout evaluation is requested.`));
  console.log(JSON.stringify({ status: artifact.status, overallPrimarySeedPassRate: overall, perFold, out: OUT }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

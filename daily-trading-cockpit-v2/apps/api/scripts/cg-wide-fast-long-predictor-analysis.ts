/**
 * CG_WIDE_FAST_LONG PREDICTOR RESEARCH (operator research brief item 3, 2026-07-10).
 * Pure, offline, read-only ANALYSIS script. Does NOT touch Binance, the live execution store, or
 * any live trading behavior — it consumes the already-computed per-trade classification records
 * that ../scripts/backfill-cg-wide-fast-long-mfe.ts (Task 2) persists to
 * scripts/output/cg-wide-fast-long-path-classification.json and asks: which ENTRY-TIME and
 * EARLY-PATH features (the only ones Task 2 was honestly able to reconstruct for these historical
 * trades) predict which of the 4 path classes (TRUE_EXPANSION / SCRATCHABLE / DEAD_ON_ARRIVAL /
 * TOXIC_REVERSAL) a trade ends up in.
 *
 * Usage (from repo root):
 *   cd apps/api && npx tsx scripts/cg-wide-fast-long-predictor-analysis.ts [pathToClassificationJson]
 * defaults to scripts/output/cg-wide-fast-long-path-classification.json (Task 2's own output path).
 *
 * IMPORTANT SAMPLE-SIZE HONESTY (operator brief, verbatim instruction): there are only ~79 real
 * CG_WIDE_FAST_LONG trades total, split across 4 classes — some classes may have single-digit
 * membership. EVERY bucket/correlation/model output below carries its own n and is flagged when
 * n < MIN_RELIABLE_N. Nothing here is a validated model — this is exploratory, small-sample
 * research, and every section says so explicitly rather than overstating confidence.
 *
 * METHOD 3 OF THE BRIEF (mutual information) IS DELIBERATELY SKIPPED: this codebase was searched
 * (`grep -ri "mutual information\|mutualInformation\|entropy"` across apps/api/src, apps/api/scripts,
 * packages/) and no existing mutual-information / entropy-based feature-scoring implementation was
 * found. Per the brief's own instruction ("if already available ... skip if none exists rather than
 * building a new estimator from scratch"), this method is not implemented here.
 *
 * A DELIBERATE CORRECTNESS DECISION worth flagging up front (see "MODEL_FEATURES" below): the two
 * early-path fields Task 2 reconstructed — timeToBreakevenTrigger and timeToMAE — are used in the
 * UNIVARIATE Spearman correlation section (method 2, exactly as the brief asks: "each numeric
 * entry-time/early-path feature"), but are DELIBERATELY EXCLUDED from the JOINT logistic-regression
 * and decision-tree models (methods 4/5). Reason: timeToBreakevenTrigger is null BY DEFINITION for
 * every single DEAD_ON_ARRIVAL trade (that IS the classification boundary — see
 * cg-wide-fast-long-path-classification.ts's precedence doc) — this is a structural, not
 * missing-at-random, null. Dropping null rows (the standard, necessary handling for a joint model
 * that needs every feature to have a value) would therefore silently exclude the ENTIRE
 * DEAD_ON_ARRIVAL population from training, badly biasing any multi-feature model without any
 * visible warning. The univariate Spearman correlation section is unaffected by this (pairwise-
 * complete correlation is standard practice and its printed n makes the exclusion visible), so
 * that field is reported there — just not fed into a joint model where the bias would be silent.
 *
 * Also deliberately excluded EVERYWHERE (not just from the joint models): timeToMFE and
 * timeToExpansion. Both are tautologically tied to the very quantities this analysis tries to
 * predict — timeToMFE is the timestamp AT WHICH maxMfeR (a regression target here) was reached, and
 * timeToExpansion is only ever non-null when the TRUE_EXPANSION threshold (a classification target
 * here) has already been crossed. "Correlating" either against its own defining outcome would be a
 * look-ahead artifact, not a predictor finding, so neither is a candidate feature anywhere below.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CgWideFastLongClassifiedTradeRecord, PathClass } from "../src/lib/cg-wide-fast-long-path-classification.js";
import {
  computeBucketStats,
  buildTercileBucketer,
  spearmanRho,
  trainLogisticRegression,
  predictLogisticProbaBatch,
  buildDecisionTree,
  predictTreeProbaBatch,
  describeTree,
  accuracy,
  logLoss,
  permutationImportance,
  permutationTestMeanDifference,
  mulberry32,
  mean,
  type BucketStats,
  type SpearmanResult,
} from "../src/lib/cg-wide-fast-long-predictor-stats.js";

const DEFAULT_INPUT_PATH = join(import.meta.dirname, "output", "cg-wide-fast-long-path-classification.json");
const OUTPUT_SUMMARY_PATH = join(import.meta.dirname, "output", "cg-wide-fast-long-predictor-analysis.json");
const MIN_RELIABLE_N = 8;
const PERMUTATIONS = 1000;

interface PersistedClassificationFile {
  generatedAt: string;
  lane: string;
  n: number;
  records: CgWideFastLongClassifiedTradeRecord[];
}

function fmt(n: number | null | undefined, digits = 4): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n.toFixed(digits);
}
function pct(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${(n * 100).toFixed(digits)}%`;
}
function smallSampleFlag(n: number): string {
  return n < MIN_RELIABLE_N ? `  [SAMPLE TOO SMALL — n=${n} < ${MIN_RELIABLE_N} — not a reliable estimate]` : "";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Derived per-trade features — ONLY entry-time / early-path fields Task 2 actually reconstructed.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface DerivedRow {
  rec: CgWideFastLongClassifiedTradeRecord;
  entryMs: number;
  entryHourUtc: number;
  entryATR: number | null;
  /** entryATR normalized by entryPrice — comparable across symbols with very different price
   *  scales (raw entryATR for e.g. BTCUSDT vs a low-price altcoin are not directly comparable). */
  entryATRPct: number | null;
  /** Early-path: minutes from entry to first covering round-trip cost. STRUCTURALLY null for
   *  every DEAD_ON_ARRIVAL trade — see module doc header. Univariate-correlation use only. */
  minutesToBreakevenTrigger: number | null;
  /** Early-path: minutes from entry to the MAE trough. Null only when the path never went
   *  adverse at all (rare, not tied to one specific pathClass) — still univariate-only, see doc. */
  minutesToMAE: number | null;
  realizedR: number | null;
  maxMfeR: number | null;
  minMaeR: number | null;
  isTrueExpansion: 0 | 1;
  isToxicReversal: 0 | 1;
}

function deriveRows(records: CgWideFastLongClassifiedTradeRecord[]): DerivedRow[] {
  return records.map((rec) => {
    const entryMs = Date.parse(rec.entryTimestamp);
    const validEntryMs = Number.isFinite(entryMs);
    return {
      rec,
      entryMs,
      entryHourUtc: rec.entryHourUtc,
      entryATR: rec.entryATR,
      entryATRPct: rec.entryATR !== null && rec.entryPrice > 0 ? rec.entryATR / rec.entryPrice : null,
      minutesToBreakevenTrigger:
        rec.timeToBreakevenTrigger !== null && validEntryMs ? (rec.timeToBreakevenTrigger - entryMs) / 60000 : null,
      minutesToMAE: rec.timeToMAE !== null && validEntryMs ? (rec.timeToMAE - entryMs) / 60000 : null,
      realizedR: rec.realizedR,
      maxMfeR: rec.maxMfeR,
      minMaeR: rec.minMaeR,
      isTrueExpansion: rec.pathClass === "TRUE_EXPANSION" ? 1 : 0,
      isToxicReversal: rec.pathClass === "TOXIC_REVERSAL" ? 1 : 0,
    };
  });
}

// Full candidate pool for the UNIVARIATE Spearman correlation section (method 2) — every numeric
// entry-time/early-path field Task 2 reconstructed, per the brief's own list.
const CORRELATION_FEATURES: Array<{ name: string; get: (r: DerivedRow) => number | null }> = [
  { name: "entryHourUtc", get: (r) => r.entryHourUtc },
  { name: "entryATR", get: (r) => r.entryATR },
  { name: "entryATRPct", get: (r) => r.entryATRPct },
  { name: "minutesToBreakevenTrigger", get: (r) => r.minutesToBreakevenTrigger },
  { name: "minutesToMAE", get: (r) => r.minutesToMAE },
];

// Restricted pool for the JOINT logistic-regression/decision-tree models (methods 4/5) — pure
// entry-time features only, no structural-null early-path fields. See module doc header for why.
const MODEL_FEATURES: Array<{ name: string; get: (r: DerivedRow) => number | null }> = [
  { name: "entryHourUtc", get: (r) => r.entryHourUtc },
  { name: "entryATRPct", get: (r) => r.entryATRPct },
];

function sessionOf(hourUtc: number): string {
  if (hourUtc < 6) return "00-05h UTC";
  if (hourUtc < 12) return "06-11h UTC";
  if (hourUtc < 18) return "12-17h UTC";
  return "18-23h UTC";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Printing helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function printBucketTable(title: string, stats: BucketStats[]): void {
  console.log(`\n-- ${title} --`);
  if (stats.length === 0) {
    console.log("  (no records had a usable value for this feature)");
    return;
  }
  console.log(
    `  ${"bucket".padEnd(16)} ${"n".padStart(3)}  ${"expansionRate".padStart(13)}  ${"scratchRate".padStart(11)}  ` +
      `${"toxicRate".padStart(9)}  ${"deadRate".padStart(8)}  ${"avgNetR".padStart(8)}  ${"medianNetR".padStart(10)}  ` +
      `${"avgMFE".padStart(7)}  ${"avgMAE".padStart(7)}`,
  );
  for (const b of stats) {
    console.log(
      `  ${b.bucket.padEnd(16)} ${String(b.n).padStart(3)}  ${pct(b.expansionRate).padStart(13)}  ${pct(b.scratchRate).padStart(11)}  ` +
        `${pct(b.toxicRate).padStart(9)}  ${pct(b.deadRate).padStart(8)}  ${fmt(b.avgNetR, 3).padStart(8)}  ${fmt(b.medianNetR, 3).padStart(10)}  ` +
        `${fmt(b.avgMFE, 3).padStart(7)}  ${fmt(b.avgMAE, 3).padStart(7)}${smallSampleFlag(b.n)}`,
    );
  }
}

interface CorrRow {
  feature: string;
  target: string;
  rho: number | null;
  n: number;
}

function computeCorr(feature: string, target: string, xs: Array<number | null>, ys: Array<number | null>): CorrRow {
  const { rho, n } = spearmanRho(xs, ys);
  return { feature, target, rho, n };
}

function printCorrTable(title: string, rows: CorrRow[]): void {
  console.log(`\n-- ${title} --`);
  const sorted = [...rows].sort((a, b) => Math.abs(b.rho ?? 0) - Math.abs(a.rho ?? 0));
  console.log(`  ${"feature".padEnd(26)} ${"target".padEnd(16)} ${"rho".padStart(8)}  ${"n".padStart(3)}`);
  for (const r of sorted) {
    console.log(`  ${r.feature.padEnd(26)} ${r.target.padEnd(16)} ${fmt(r.rho, 4).padStart(8)}  ${String(r.n).padStart(3)}${smallSampleFlag(r.n)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const inputPath = process.argv[2] ? process.argv[2] : DEFAULT_INPUT_PATH;
  console.log(`Reading path-classification records from: ${inputPath}`);

  if (!existsSync(inputPath)) {
    console.log(
      `\nNo classification file found at ${inputPath}.\n` +
        "This is expected on a local dev machine whose live-execution store is empty (see Task 2's own " +
        "report: apps/api/data/live-execution.json has intents: [] here). The real ~79-trade CG_WIDE_FAST_LONG " +
        "history lives on the live VPS instead.\n\n" +
        "To produce real findings, run BOTH of the following from repo root, in order:\n" +
        "  1) cd apps/api && npx tsx scripts/backfill-cg-wide-fast-long-mfe.ts /path/to/copied/vps/apps/api/data\n" +
        "     (this persists scripts/output/cg-wide-fast-long-path-classification.json)\n" +
        "  2) cd apps/api && npx tsx scripts/cg-wide-fast-long-predictor-analysis.ts\n" +
        "     (reads that file by default; pass an explicit path as argv[2] to point elsewhere)\n\n" +
        "Nothing below is fabricated — this script is stopping here rather than inventing findings.",
    );
    return;
  }

  const parsed = JSON.parse(readFileSync(inputPath, "utf-8")) as PersistedClassificationFile;
  const records = parsed.records ?? [];
  console.log(`Loaded ${records.length} classified trade records (generated ${parsed.generatedAt}, lane ${parsed.lane}).`);
  if (records.length === 0) {
    console.log("\nZero records in the file — nothing to analyze. Stopping (not fabricating findings).");
    return;
  }

  const rows = deriveRows(records);
  const n = rows.length;

  // ── pathClass distribution ──────────────────────────────────────────────────────────────────
  console.log("\n===== CG_WIDE_FAST_LONG PREDICTOR ANALYSIS (operator research brief item 3) =====");
  console.log(`n = ${n} real closed trades`);
  const pathClasses: PathClass[] = ["DEAD_ON_ARRIVAL", "SCRATCHABLE", "TRUE_EXPANSION", "TOXIC_REVERSAL"];
  console.log("\n-- pathClass distribution --");
  const classCounts = new Map<PathClass, number>();
  for (const pc of pathClasses) {
    const count = rows.filter((r) => r.rec.pathClass === pc).length;
    classCounts.set(pc, count);
    console.log(`  ${pc.padEnd(18)} n=${String(count).padStart(3)}  ${pct(count / n).padStart(6)}${smallSampleFlag(count)}`);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // METHOD 1 — bucket analysis
  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n\n===== METHOD 1 — BUCKET ANALYSIS =====");
  console.log(
    "(expansionRateByFeatureBucket / scratchRateByFeatureBucket / toxicRateByFeatureBucket / avgNetRByFeatureBucket / " +
      "medianNetRByFeatureBucket / avgMFEByFeatureBucket / avgMAEByFeatureBucket / sampleSizeByBucket — all columns " +
      `printed together per bucket below; any bucket with n < ${MIN_RELIABLE_N} is flagged inline, never hidden)`,
  );

  const bucketBase = {
    records: rows,
    getPathClass: (r: DerivedRow) => r.rec.pathClass,
    getNetR: (r: DerivedRow) => r.realizedR,
    getMFE: (r: DerivedRow) => r.maxMfeR,
    getMAE: (r: DerivedRow) => r.minMaeR,
    minReliableN: MIN_RELIABLE_N,
  };

  printBucketTable(
    "by symbol",
    computeBucketStats({ ...bucketBase, bucketOf: (r) => r.rec.symbol }),
  );
  printBucketTable(
    "by entryHourUtc (raw hour)",
    computeBucketStats({ ...bucketBase, bucketOf: (r) => `${String(r.entryHourUtc).padStart(2, "0")}h` }),
  );
  printBucketTable(
    "by entry session (coarser 6h UTC blocks)",
    computeBucketStats({ ...bucketBase, bucketOf: (r) => sessionOf(r.entryHourUtc) }),
  );
  printBucketTable(
    "by entryRegimeAlignment",
    computeBucketStats({ ...bucketBase, bucketOf: (r) => r.rec.entryRegimeAlignment }),
  );
  printBucketTable(
    "by entryRegime (raw, at entry)",
    computeBucketStats({ ...bucketBase, bucketOf: (r) => r.rec.entryRegime ?? "(null — pre-controller-hook intent)" }),
  );
  printBucketTable(
    "by entryControllerMode (raw, at entry)",
    computeBucketStats({ ...bucketBase, bucketOf: (r) => r.rec.entryControllerMode ?? "(null — pre-controller-hook intent)" }),
  );

  const atrPctBucketer = buildTercileBucketer(rows.map((r) => ({ record: r, value: r.entryATRPct })));
  const atrMissingCount = rows.filter((r) => r.entryATRPct === null).length;
  printBucketTable(
    `by entryATRPct tercile (ATR/entryPrice; ${atrMissingCount} trade(s) excluded — entryATR unavailable)`,
    computeBucketStats({ ...bucketBase, bucketOf: atrPctBucketer }),
  );

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // METHOD 2 — Spearman rank correlation
  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n\n===== METHOD 2 — SPEARMAN RANK CORRELATION =====");
  console.log(
    "(rank both variables — average rank for ties — then Pearson-correlate the ranks; implemented from scratch in " +
      "src/lib/cg-wide-fast-long-predictor-stats.ts, see its tests for a hand-computed sanity check)",
  );

  const corrVsRealizedR: CorrRow[] = CORRELATION_FEATURES.map((f) =>
    computeCorr(f.name, "realizedR", rows.map(f.get), rows.map((r) => r.realizedR)),
  );
  printCorrTable("vs realizedR (real $ P&L in R-multiples)", corrVsRealizedR);

  const corrVsMfe: CorrRow[] = CORRELATION_FEATURES.map((f) =>
    computeCorr(f.name, "maxMfeR", rows.map(f.get), rows.map((r) => r.maxMfeR)),
  );
  printCorrTable("vs maxMfeR (best favorable excursion reached)", corrVsMfe);

  // Extension (not explicitly required by method 2's literal wording, but used below to select
  // MODEL_FEATURES for methods 4/5 and to build topFeaturesForExpansion/topFeaturesForToxicReversal):
  // Spearman rho of each candidate feature against the two path-class BINARY indicators. Rank
  // correlation against a 0/1 variable is a valid (if less standard) form of point-biserial-style
  // association and is computed with the exact same spearmanRho function — no separate method.
  const corrVsTrueExpansion: CorrRow[] = CORRELATION_FEATURES.map((f) =>
    computeCorr(f.name, "isTrueExpansion", rows.map(f.get), rows.map((r) => r.isTrueExpansion)),
  );
  printCorrTable("vs isTrueExpansion indicator (extension, used to select model features below)", corrVsTrueExpansion);

  const toxicN = classCounts.get("TOXIC_REVERSAL") ?? 0;
  const corrVsToxicReversal: CorrRow[] = CORRELATION_FEATURES.map((f) =>
    computeCorr(f.name, "isToxicReversal", rows.map(f.get), rows.map((r) => r.isToxicReversal)),
  );
  printCorrTable(
    `vs isToxicReversal indicator (extension; TOXIC_REVERSAL n=${toxicN}${toxicN < MIN_RELIABLE_N ? " — READ AS ANECDOTAL, NOT A FINDING" : ""})`,
    corrVsToxicReversal,
  );

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // METHOD 3 — mutual information: explicitly skipped, see module doc header.
  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n\n===== METHOD 3 — MUTUAL INFORMATION: SKIPPED =====");
  console.log(
    "No existing mutual-information/entropy-based feature-scoring implementation was found in this codebase " +
      '(searched for "mutual information" / "mutualInformation" / "entropy" across apps/api/src, apps/api/scripts, ' +
      "packages/). Per the operator brief's own instruction, this method is skipped rather than building a new " +
      "estimator from scratch. Method 2's Spearman correlation above is the closest already-implemented substitute.",
  );

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // METHODS 4/5 — logistic regression + decision tree (TRUE_EXPANSION vs not)
  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n\n===== METHODS 4/5 — LOGISTIC REGRESSION + DECISION TREE (TRUE_EXPANSION vs not) =====");
  console.log(
    `Candidate feature pool restricted to pure entry-time fields (${MODEL_FEATURES.map((f) => f.name).join(", ")}) — ` +
      "see module doc header for why the early-path fields are excluded from these JOINT models specifically " +
      "(structural, definitional nulls that would silently bias training, not a missing-at-random gap).",
  );
  console.log(
    `*** EXPLICIT CAVEAT (operator brief): n=${n} total, TRUE_EXPANSION n=${classCounts.get("TRUE_EXPANSION")}. This is ` +
      "illustrative/exploratory only — no regularization, no train/test split or cross-validation, in-sample metrics " +
      "only. Do not treat this as a validated model. ***",
  );

  const completeModelRows = rows.filter((r) => MODEL_FEATURES.every((f) => f.get(r) !== null));
  console.log(
    `\nRows with ALL model features present: ${completeModelRows.length}/${n} ` +
      `(${n - completeModelRows.length} excluded — missing entryATR)`,
  );

  let logisticSection: {
    featuresUsed: string[];
    n: number;
    weights: number[];
    bias: number;
    finalLoss: number;
    accuracy: number;
  } | null = null;
  let treeSection: { featuresUsed: string[]; n: number; description: string[]; accuracy: number } | null = null;
  let permImportanceLogistic: ReturnType<typeof permutationImportance> = [];
  let permImportanceTree: ReturnType<typeof permutationImportance> = [];

  if (completeModelRows.length < MIN_RELIABLE_N) {
    console.log(
      `\n*** SKIPPING model fit: only ${completeModelRows.length} complete rows available, below the ` +
        `${MIN_RELIABLE_N}-observation reliability floor. Fitting a 2-feature logistic regression or decision tree ` +
        "on fewer observations than that would produce numbers not worth reporting as anything but noise. ***",
    );
  } else {
    const X = completeModelRows.map((r) => MODEL_FEATURES.map((f) => f.get(r)!));
    const y = completeModelRows.map((r) => r.isTrueExpansion);
    const featureNames = MODEL_FEATURES.map((f) => f.name);

    // -- logistic regression --
    const model = trainLogisticRegression(X, y, { iterations: 3000, learningRate: 0.3 });
    const probas = predictLogisticProbaBatch(model, X);
    const acc = accuracy(y, probas);
    const ll = logLoss(y, probas);
    console.log("\n-- logistic regression (method 4) --");
    console.log(`  features: ${featureNames.join(", ")}   n=${X.length}`);
    featureNames.forEach((name, i) => {
      const w = model.weights[i]!;
      console.log(
        `  weight[${name}] = ${fmt(w, 4)}  (standardized-feature space; sign = direction of effect: ` +
          `${w > 0 ? "higher value -> more likely TRUE_EXPANSION" : w < 0 ? "higher value -> less likely TRUE_EXPANSION" : "no discernible effect"})`,
      );
    });
    console.log(`  bias = ${fmt(model.bias, 4)}`);
    console.log(`  in-sample accuracy = ${pct(acc)}   in-sample log-loss = ${fmt(ll, 4)} (naive 50/50 baseline = ${fmt(Math.log(2), 4)})`);
    logisticSection = { featuresUsed: featureNames, n: X.length, weights: model.weights, bias: model.bias, finalLoss: ll, accuracy: acc };

    // -- decision tree (method 5) --
    const tree = buildDecisionTree(X, y, { maxDepth: 2, minLeafSize: 5 });
    const treeProbas = predictTreeProbaBatch(tree, X);
    const treeAcc = accuracy(y, treeProbas);
    console.log("\n-- decision tree, maxDepth=2 (method 5) --");
    console.log(`  features: ${featureNames.join(", ")}   n=${X.length}`);
    for (const line of describeTree(tree, featureNames)) console.log(`  ${line}`);
    console.log(`  in-sample accuracy = ${pct(treeAcc)}`);
    treeSection = { featuresUsed: featureNames, n: X.length, description: describeTree(tree, featureNames), accuracy: treeAcc };

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // METHOD 6 — permutation importance (for both models built above)
    // ═══════════════════════════════════════════════════════════════════════════════════════
    console.log("\n\n===== METHOD 6 — PERMUTATION IMPORTANCE =====");
    console.log(
      `*** With n=${X.length}, permutation-importance estimates are noisy — importanceStd below is typically large ` +
        "relative to the importance mean itself. Read these as directional hints, not precise rankings. ***",
    );

    permImportanceLogistic = permutationImportance(
      (Xin) => predictLogisticProbaBatch(model, Xin),
      X,
      y,
      { metric: accuracy, higherIsBetter: true, permutations: PERMUTATIONS, rng: mulberry32(20260710) },
    );
    console.log("\n-- permutation importance: logistic regression (metric = accuracy) --");
    for (const r of permImportanceLogistic) {
      console.log(
        `  ${featureNames[r.featureIndex]!.padEnd(20)} baseline=${fmt(r.baselineMetric, 4)}  ` +
          `meanAfterShuffle=${fmt(r.meanMetricAfterShuffle, 4)}  importance=${fmt(r.importance, 4)}  ` +
          `(std=${fmt(r.importanceStd, 4)}, ${r.permutations} permutations)`,
      );
    }

    permImportanceTree = permutationImportance(
      (Xin) => predictTreeProbaBatch(tree, Xin),
      X,
      y,
      { metric: accuracy, higherIsBetter: true, permutations: PERMUTATIONS, rng: mulberry32(20260711) },
    );
    console.log("\n-- permutation importance: decision tree (metric = accuracy) --");
    for (const r of permImportanceTree) {
      console.log(
        `  ${featureNames[r.featureIndex]!.padEnd(20)} baseline=${fmt(r.baselineMetric, 4)}  ` +
          `meanAfterShuffle=${fmt(r.meanMetricAfterShuffle, 4)}  importance=${fmt(r.importance, 4)}  ` +
          `(std=${fmt(r.importanceStd, 4)}, ${r.permutations} permutations)`,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // Permutation TEST (null-hypothesis top-vs-bottom) — the brief's separate "1,000 permutations
  // if sample size permits" ask, distinct from permutation importance above.
  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n\n===== PERMUTATION TEST — top-vs-bottom tercile, strongest realizedR correlate =====");
  const strongestVsRealizedR = [...corrVsRealizedR].sort((a, b) => Math.abs(b.rho ?? 0) - Math.abs(a.rho ?? 0))[0];
  let permutationTestSection: ReturnType<typeof permutationTestMeanDifference> & { feature: string } = {
    feature: "(none)",
    observedDiff: NaN,
    pValue: NaN,
    permutations: 0,
    groupASize: 0,
    groupBSize: 0,
  };
  if (strongestVsRealizedR && strongestVsRealizedR.rho !== null) {
    const featureSpec = CORRELATION_FEATURES.find((f) => f.name === strongestVsRealizedR.feature)!;
    const valued = rows.map((r) => ({ record: r, value: featureSpec.get(r) }));
    const tercileOf = buildTercileBucketer(valued);
    const topGroup = rows.filter((r) => tercileOf(r) === "HIGH").map((r) => r.realizedR).filter((v): v is number => v !== null);
    const bottomGroup = rows.filter((r) => tercileOf(r) === "LOW").map((r) => r.realizedR).filter((v): v is number => v !== null);
    console.log(
      `Feature: ${strongestVsRealizedR.feature} (|rho|=${fmt(Math.abs(strongestVsRealizedR.rho), 4)} vs realizedR, n=${strongestVsRealizedR.n})`,
    );
    console.log(`Top tercile realizedR: n=${topGroup.length}, mean=${fmt(mean(topGroup), 4)}`);
    console.log(`Bottom tercile realizedR: n=${bottomGroup.length}, mean=${fmt(mean(bottomGroup), 4)}`);
    if (topGroup.length < MIN_RELIABLE_N || bottomGroup.length < MIN_RELIABLE_N) {
      console.log(
        `*** At least one tercile group is below the ${MIN_RELIABLE_N}-observation floor — running the test anyway ` +
          "(it's cheap and honest to show), but treat the p-value as illustrative only, not a real hypothesis test. ***",
      );
    }
    const testResult = permutationTestMeanDifference(topGroup, bottomGroup, { permutations: PERMUTATIONS, rng: mulberry32(555) });
    console.log(
      `observedDiff (top-bottom mean realizedR) = ${fmt(testResult.observedDiff, 4)}   ` +
        `pValue = ${fmt(testResult.pValue, 4)} (${testResult.permutations} permutations)`,
    );
    permutationTestSection = { feature: strongestVsRealizedR.feature, ...testResult };
  } else {
    console.log("(no numeric feature had a computable correlation vs realizedR — skipping)");
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // Required synthesis outputs: topFeaturesForExpansion / topFeaturesForToxicReversal /
  // topFeatureInteractions
  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n\n===== topFeaturesForExpansion =====");
  console.log(
    `Ranked by |Spearman rho| vs the isTrueExpansion indicator (n=${n} total, TRUE_EXPANSION n=${classCounts.get("TRUE_EXPANSION")}), ` +
      "cross-referenced against permutation importance where a joint model was fit above.",
  );
  const topExpansion = [...corrVsTrueExpansion].sort((a, b) => Math.abs(b.rho ?? 0) - Math.abs(a.rho ?? 0)).slice(0, 4);
  for (const r of topExpansion) {
    const permMatch = permImportanceTree.length
      ? permImportanceTree.find((p) => MODEL_FEATURES[p.featureIndex]!.name === r.feature)
      : undefined;
    console.log(
      `  ${r.feature.padEnd(26)} rho=${fmt(r.rho, 4).padStart(7)}  n=${String(r.n).padStart(3)}` +
        (permMatch ? `  treeImportance=${fmt(permMatch.importance, 4)}` : "") +
        smallSampleFlag(r.n),
    );
  }
  console.log(
    `*** EXPLORATORY ONLY — n=${n}, single dataset, no held-out validation. Do not treat as a validated predictor list. ***`,
  );

  console.log("\n\n===== topFeaturesForToxicReversal =====");
  if (toxicN < MIN_RELIABLE_N) {
    console.log(
      `TOXIC_REVERSAL n=${toxicN}, below the ${MIN_RELIABLE_N}-observation reliability floor. No model was fit for this ` +
        "target (would be fitting noise). Reporting Spearman rank correlation + bucket toxicRate evidence only, " +
        "and explicitly flagging it as ANECDOTAL, not a finding:",
    );
  } else {
    console.log(`TOXIC_REVERSAL n=${toxicN} — ranked by |Spearman rho| vs the isToxicReversal indicator:`);
  }
  const topToxic = [...corrVsToxicReversal].sort((a, b) => Math.abs(b.rho ?? 0) - Math.abs(a.rho ?? 0)).slice(0, 4);
  for (const r of topToxic) {
    console.log(`  ${r.feature.padEnd(26)} rho=${fmt(r.rho, 4).padStart(7)}  n=${String(r.n).padStart(3)}${smallSampleFlag(r.n)}`);
  }

  console.log("\n\n===== topFeatureInteractions =====");
  console.log(
    `Joint two-dimension bucket scan (entryRegimeAlignment × ATR tercile, entryRegimeAlignment × session, ` +
      `ATR tercile × session) — only reporting a combination if its joint bucket n >= ${MIN_RELIABLE_N} AND its ` +
      "expansionRate diverges from BOTH marginal rates by a visible margin. No interaction is forced if nothing " +
      "meets that bar.",
  );
  const atrTercileOf = atrPctBucketer;
  const dims: Array<{ name: string; of: (r: DerivedRow) => string | null }> = [
    { name: "entryRegimeAlignment", of: (r) => r.rec.entryRegimeAlignment },
    { name: "ATRtercile", of: (r) => atrTercileOf(r) },
    { name: "session", of: (r) => sessionOf(r.entryHourUtc) },
  ];
  const marginalExpansionRate = classCounts.get("TRUE_EXPANSION")! / n;
  const interactionsFound: Array<{ dims: string; bucket: string; n: number; expansionRate: number }> = [];
  for (let i = 0; i < dims.length; i++) {
    for (let j = i + 1; j < dims.length; j++) {
      const a = dims[i]!;
      const b = dims[j]!;
      const joint = computeBucketStats({
        ...bucketBase,
        bucketOf: (r) => {
          const av = a.of(r);
          const bv = b.of(r);
          return av !== null && bv !== null ? `${av} × ${bv}` : null;
        },
      });
      for (const stat of joint) {
        if (stat.n >= MIN_RELIABLE_N && stat.expansionRate !== null && Math.abs(stat.expansionRate - marginalExpansionRate) >= 0.2) {
          interactionsFound.push({ dims: `${a.name} × ${b.name}`, bucket: stat.bucket, n: stat.n, expansionRate: stat.expansionRate });
        }
      }
    }
  }
  if (interactionsFound.length === 0) {
    console.log(
      `  None found. No joint bucket across the ${dims.length * (dims.length - 1) / 2} dimension-pairs checked reached ` +
        `n>=${MIN_RELIABLE_N} while also showing an expansionRate meaningfully different from the overall marginal ` +
        `rate (${pct(marginalExpansionRate)}). With n=${n} spread across these dimensions, this is the expected ` +
        "outcome, not a bug — reporting 'none found' honestly rather than forcing a spurious interaction.",
    );
  } else {
    for (const it of interactionsFound.slice(0, 5)) {
      console.log(`  ${it.dims}: "${it.bucket}"  n=${it.n}  expansionRate=${pct(it.expansionRate)} (marginal=${pct(marginalExpansionRate)})`);
    }
  }

  // ── persist a machine-readable summary (derived report artifact, mirrors Task 2's own
  //    precedent of persisting scripts/output/*.json) ────────────────────────────────────────
  try {
    mkdirSync(dirname(OUTPUT_SUMMARY_PATH), { recursive: true });
    writeFileSync(
      OUTPUT_SUMMARY_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sourceFile: inputPath,
          n,
          minReliableN: MIN_RELIABLE_N,
          pathClassCounts: Object.fromEntries(classCounts),
          spearman: { vsRealizedR: corrVsRealizedR, vsMaxMfeR: corrVsMfe, vsIsTrueExpansion: corrVsTrueExpansion, vsIsToxicReversal: corrVsToxicReversal },
          mutualInformation: "SKIPPED — no existing implementation found in this codebase (see method 3 note above)",
          logisticRegression: logisticSection,
          decisionTree: treeSection,
          permutationImportance: { logistic: permImportanceLogistic, tree: permImportanceTree },
          permutationTest: permutationTestSection,
          topFeaturesForExpansion: topExpansion,
          topFeaturesForToxicReversal: { toxicReversalN: toxicN, belowReliabilityFloor: toxicN < MIN_RELIABLE_N, features: topToxic },
          topFeatureInteractions: interactionsFound,
          caveat:
            "Exploratory, small-sample research over ~79 real trades split across 4 classes. No held-out " +
            "validation anywhere in this file. Do not treat any single number here as a validated finding.",
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`\nPersisted machine-readable summary to ${OUTPUT_SUMMARY_PATH}`);
  } catch (err) {
    console.warn(`\n[persist] failed to write ${OUTPUT_SUMMARY_PATH}: ${(err as Error).message}`);
  }

  console.log(
    "\n===== FINAL HONESTY NOTE =====\n" +
      `n=${n} across 4 classes. This entire report is exploratory/small-sample research, not a validated model. ` +
      "Any bucket, correlation, or model output flagged above with n below the reliability floor should be read as " +
      "a hint worth more data, not a decision-ready finding.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

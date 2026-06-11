#!/usr/bin/env node
/**
 * Top-Contributor Fingerprint Discrimination Audit (READ-ONLY).
 *
 * Reconstructs StrategyExperienceRecord analogs from shadow-positions.json,
 * filters to the BASE cohort (POST_CALIBRATION + BEAR-regime + SHORT +
 * vwap_retest_entry + tp1_full_exit), applies whale and horizon-conflict
 * filters, then computes per-symbol contribution buckets and per-feature
 * distributions across TOP / OTHER_POSITIVE / NEUTRAL / NEGATIVE groups.
 *
 * No production code is touched. Emits JSON + summary tables to stdout.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SHADOW_POSITIONS_PATH = path.join(REPO_ROOT, "data", "shadow-positions.json");

// ─── Load positions ────────────────────────────────────────────────────────
const rawPositions = JSON.parse(fs.readFileSync(SHADOW_POSITIONS_PATH, "utf8"));
const positions = Array.isArray(rawPositions) ? rawPositions : (rawPositions.positions ?? rawPositions);

// ─── Reconstruct StrategyExperienceRecord analogs ────────────────────────
function pickClosedVariant(position) {
  return (
    position.variants?.find(
      (v) => v.variant === position.selectedExitVariant && v.state === "CLOSED",
    ) ?? position.variants?.find((v) => v.state === "CLOSED") ?? null
  );
}

const records = [];
for (const p of positions) {
  const variant = pickClosedVariant(p);
  if (!variant) continue;
  const ctx = p.strategyContextSnapshot;
  if (!ctx) continue;
  records.push({
    context: ctx,
    outcome: {
      positionId: p.id,
      symbol: p.symbol,
      direction: p.direction,
      selectedEntryVariant: variant.variant ?? ctx.selectedEntryVariant ?? null,
      selectedExitVariant: variant.variant ?? ctx.selectedExitVariant ?? null,
      openedAt: p.entryFilledAt ?? variant.openedAt ?? p.scannedAt ?? null,
      closedAt: variant.closedAt ?? null,
      closeReason: variant.closeReason ?? null,
      realizedNetR: typeof variant.realizedNetR === "number" ? variant.realizedNetR : null,
      realizedGrossR: typeof variant.realizedGrossR === "number" ? variant.realizedGrossR : null,
      tp1Hit: variant.tp1Hit ?? null,
      slHit: variant.closeReason === "SL" || variant.closeReason === "BREAKEVEN",
    },
  });
}

// ─── BASE cohort filter ────────────────────────────────────────────────────
const isFinite = Number.isFinite;
function isPostCal(r) {
  return r.context.evidenceEra === "POST_CALIBRATION";
}
function isBearRegime(r) {
  const reg = r.context.marketRegime;
  if (!reg) return false;
  return String(reg).toUpperCase().includes("BEAR");
}
function isShort(r) {
  return r.context.direction === "SHORT";
}
function isVwapRetest(r) {
  return r.context.selectedEntryVariant === "vwap_retest_entry";
}
function isTp1Full(r) {
  return r.context.selectedExitVariant === "tp1_full_exit";
}

const base = records.filter(
  (r) => isPostCal(r) && isBearRegime(r) && isShort(r) && isVwapRetest(r) && isTp1Full(r),
);

const cohortA = base.filter((r) => r.context.whaleAgreement === "AGREES");
const cohortB = cohortA.filter((r) => r.context.horizonConflict === false);

// ─── Per-symbol grouping & bucketing ───────────────────────────────────────
function groupBySymbol(cohort) {
  const m = new Map();
  for (const r of cohort) {
    const list = m.get(r.context.symbol) ?? [];
    list.push(r);
    m.set(r.context.symbol, list);
  }
  return m;
}

function symbolStats(cohort) {
  const groups = groupBySymbol(cohort);
  const out = [];
  for (const [symbol, recs] of groups) {
    const rs = recs.map((r) => r.outcome.realizedNetR).filter((v) => isFinite(v));
    const netSumR = rs.reduce((a, b) => a + b, 0);
    const netAvgR = rs.length > 0 ? netSumR / rs.length : null;
    const wins = rs.filter((v) => v > 0).length;
    out.push({
      symbol,
      n: recs.length,
      netSumR: round4(netSumR),
      netAvgR: netAvgR === null ? null : round4(netAvgR),
      winRate: rs.length > 0 ? round4(wins / rs.length) : null,
    });
  }
  return out.sort((a, b) => b.netSumR - a.netSumR);
}

function round4(v) {
  return Math.round(v * 10_000) / 10_000;
}

function bucketSymbols(stats) {
  // TOP = top-2 by positive netSumR
  const positive = stats.filter((s) => s.netSumR > 0).sort((a, b) => b.netSumR - a.netSumR);
  const topSyms = new Set(positive.slice(0, 2).map((s) => s.symbol));
  const buckets = { TOP: [], OTHER_POSITIVE: [], NEUTRAL: [], NEGATIVE: [] };
  for (const s of stats) {
    if (topSyms.has(s.symbol)) buckets.TOP.push(s);
    else if (s.netSumR > 0) buckets.OTHER_POSITIVE.push(s);
    else if (Math.abs(s.netSumR) < 0.5) buckets.NEUTRAL.push(s);
    else buckets.NEGATIVE.push(s);
  }
  return buckets;
}

function assignRecordsToBuckets(cohort, buckets) {
  const symToBucket = new Map();
  for (const [bucket, syms] of Object.entries(buckets)) {
    for (const s of syms) symToBucket.set(s.symbol, bucket);
  }
  const out = { TOP: [], OTHER_POSITIVE: [], NEUTRAL: [], NEGATIVE: [] };
  for (const r of cohort) {
    const b = symToBucket.get(r.context.symbol);
    if (b) out[b].push(r);
  }
  return out;
}

// ─── Feature taxonomy ──────────────────────────────────────────────────────
// All decision-time safe. Picked from StrategyContextSnapshot.
const CATEGORICAL_FEATURES = [
  "marketRegime",
  "whaleAgreement",
  "horizonConflict",
  "directionalAlignmentLabel",
  "trend5m",
  "trend15m",
  "trend1h",
  "selectedKronosBias",
  "kronosBias1h",
  "kronosBias4h",
  "kronosConfidenceBucket",
  "selectedEntryVariant",
  "selectedExitVariant",
  "entryPlaybook",
  "routeMode",
  "chaseRisk",
  "calibrationVerdict",
  "calibrationConfidence",
  "variantConfidenceTier",
];
const NUMERIC_FEATURES = [
  "entryDriftPctOfZone",
  "entryDriftAtr",
  "stopDistanceBps",
  "riskReward",
  "costR",
  "spreadR",
  "feeSlippageR",
  "rawExpectedNetR",
  "rawExpectedGrossR",
  "calibratedExpectedNetR",
  "opportunityScore",
  "confidenceScore",
  "dangerScore",
  "directionGap",
  "routeScore",
  "volatilityAtrPercent5m",
  "volumeRatio5m",
  "spreadPercent",
];

function categoricalDist(records, feature) {
  const counts = new Map();
  let known = 0;
  for (const r of records) {
    const v = r.context[feature];
    if (v === null || v === undefined) continue;
    known++;
    const k = String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const dist = {};
  for (const [k, c] of counts) dist[k] = round4(c / Math.max(known, 1));
  return { n: known, totalRecords: records.length, dist };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function numericStats(records, feature) {
  const vals = records
    .map((r) => r.context[feature])
    .filter((v) => typeof v === "number" && isFinite(v))
    .sort((a, b) => a - b);
  if (vals.length === 0) return { n: 0, mean: null, median: null, p25: null, p75: null };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return {
    n: vals.length,
    mean: round4(mean),
    median: round4(quantile(vals, 0.5)),
    p25: round4(quantile(vals, 0.25)),
    p75: round4(quantile(vals, 0.75)),
    min: round4(vals[0]),
    max: round4(vals[vals.length - 1]),
  };
}

function featureDistByBucket(buckets) {
  const out = { categorical: {}, numeric: {} };
  for (const feat of CATEGORICAL_FEATURES) {
    out.categorical[feat] = {};
    for (const [bname, recs] of Object.entries(buckets)) {
      out.categorical[feat][bname] = categoricalDist(recs, feat);
    }
  }
  for (const feat of NUMERIC_FEATURES) {
    out.numeric[feat] = {};
    for (const [bname, recs] of Object.entries(buckets)) {
      out.numeric[feat][bname] = numericStats(recs, feat);
    }
  }
  return out;
}

// ─── Within-TOP coherence ──────────────────────────────────────────────────
function categoricalAgreement(symRecords) {
  // For each categorical feature, find dominant value within each TOP symbol;
  // agreement rate = fraction of TOP symbols sharing the most common dominant.
  const out = {};
  for (const feat of CATEGORICAL_FEATURES) {
    const dominants = [];
    for (const recs of symRecords) {
      const dist = categoricalDist(recs, feat);
      const top = Object.entries(dist.dist).sort((a, b) => b[1] - a[1])[0];
      dominants.push(top ? top[0] : null);
    }
    const counts = new Map();
    for (const d of dominants) {
      if (d === null) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const winner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    out[feat] = {
      dominantPerSymbol: dominants,
      agreementRate: winner ? round4(winner[1] / dominants.length) : null,
      consensusValue: winner ? winner[0] : null,
    };
  }
  return out;
}

function iqrOverlap(symRecords) {
  const out = {};
  for (const feat of NUMERIC_FEATURES) {
    const ranges = symRecords.map((recs) => {
      const s = numericStats(recs, feat);
      return s.n > 0 ? [s.p25, s.p75] : null;
    });
    const valid = ranges.filter((r) => r !== null);
    if (valid.length < 2) {
      out[feat] = { overlap: null, ranges };
      continue;
    }
    // pairwise overlap: count pairs whose IQR intervals overlap, over total pairs
    let overlapping = 0;
    let total = 0;
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        total++;
        const [a1, a2] = valid[i];
        const [b1, b2] = valid[j];
        if (Math.max(a1, b1) <= Math.min(a2, b2)) overlapping++;
      }
    }
    out[feat] = {
      pairOverlapRate: total > 0 ? round4(overlapping / total) : null,
      ranges,
    };
  }
  return out;
}

// ─── Build report per cohort ───────────────────────────────────────────────
function buildCohortReport(label, cohort) {
  const stats = symbolStats(cohort);
  const buckets = bucketSymbols(stats);
  const recordsByBucket = assignRecordsToBuckets(cohort, buckets);
  const featureDist = featureDistByBucket(recordsByBucket);

  // within-TOP coherence
  const topSymRecords = buckets.TOP.map((s) =>
    cohort.filter((r) => r.context.symbol === s.symbol),
  );
  const withinTopCategorical =
    topSymRecords.length >= 2 ? categoricalAgreement(topSymRecords) : null;
  const withinTopNumeric = topSymRecords.length >= 2 ? iqrOverlap(topSymRecords) : null;

  // cohort-level netAvgR
  const allR = cohort.map((r) => r.outcome.realizedNetR).filter(isFinite);
  const cohortNetAvgR = allR.length > 0 ? round4(allR.reduce((a, b) => a + b, 0) / allR.length) : null;

  return {
    label,
    n: cohort.length,
    netAvgR: cohortNetAvgR,
    symbolCount: stats.length,
    symbolStats: stats,
    buckets: {
      TOP: buckets.TOP,
      OTHER_POSITIVE: buckets.OTHER_POSITIVE,
      NEUTRAL: buckets.NEUTRAL,
      NEGATIVE: buckets.NEGATIVE,
    },
    bucketCounts: {
      TOP: { symbols: buckets.TOP.length, records: recordsByBucket.TOP.length },
      OTHER_POSITIVE: {
        symbols: buckets.OTHER_POSITIVE.length,
        records: recordsByBucket.OTHER_POSITIVE.length,
      },
      NEUTRAL: { symbols: buckets.NEUTRAL.length, records: recordsByBucket.NEUTRAL.length },
      NEGATIVE: { symbols: buckets.NEGATIVE.length, records: recordsByBucket.NEGATIVE.length },
    },
    featureDist,
    withinTop: {
      categorical: withinTopCategorical,
      numeric: withinTopNumeric,
    },
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  inputs: {
    totalPositions: positions.length,
    closedWithSnapshot: records.length,
    base: base.length,
    cohortA_WHALE_AGREES: cohortA.length,
    cohortB_WHALE_PLUS_NO_HC: cohortB.length,
  },
  cohortA: buildCohortReport("WHALE_AGREES", cohortA),
  cohortB: buildCohortReport("WHALE_AGREES + NO_HC", cohortB),
};

// ─── Summary tables ────────────────────────────────────────────────────────
function fmt(v, w = 8) {
  if (v === null || v === undefined) return "n/a".padStart(w);
  if (typeof v === "number") return v.toFixed(4).padStart(w);
  return String(v).padStart(w);
}

function printSymbolTable(rep) {
  console.log(`\n=== Cohort: ${rep.label} (n=${rep.n}, netAvgR=${rep.netAvgR}) ===`);
  console.log("Symbol      | n  | netSumR  | netAvgR  | winRate  | bucket");
  console.log("------------|----|----------|----------|----------|----------------");
  const bucketOf = (sym) => {
    for (const [b, list] of Object.entries(rep.buckets)) if (list.find((s) => s.symbol === sym)) return b;
    return "?";
  };
  for (const s of rep.symbolStats) {
    console.log(
      `${s.symbol.padEnd(11)} | ${String(s.n).padStart(2)} | ${fmt(s.netSumR)} | ${fmt(s.netAvgR)} | ${fmt(s.winRate)} | ${bucketOf(s.symbol)}`,
    );
  }
}

function printFeatureSummary(rep) {
  console.log(`\n--- Categorical feature dominant-value per bucket (${rep.label}) ---`);
  for (const feat of CATEGORICAL_FEATURES) {
    const d = rep.featureDist.categorical[feat];
    const dom = (b) => {
      const entries = Object.entries(d[b].dist);
      if (entries.length === 0) return "n/a";
      const top = entries.sort((a, b) => b[1] - a[1])[0];
      return `${top[0]}(${top[1]})`;
    };
    console.log(
      `${feat.padEnd(28)} | TOP=${dom("TOP").padEnd(28)} OTHER+=${dom("OTHER_POSITIVE").padEnd(28)} NEUT=${dom("NEUTRAL").padEnd(28)} NEG=${dom("NEGATIVE")}`,
    );
  }
  console.log(`\n--- Numeric feature median per bucket (${rep.label}) ---`);
  for (const feat of NUMERIC_FEATURES) {
    const d = rep.featureDist.numeric[feat];
    console.log(
      `${feat.padEnd(28)} | TOP=${fmt(d.TOP.median)} OTHER+=${fmt(d.OTHER_POSITIVE.median)} NEUT=${fmt(d.NEUTRAL.median)} NEG=${fmt(d.NEGATIVE.median)}`,
    );
  }
}

function printWithinTop(rep) {
  if (!rep.withinTop.categorical) {
    console.log(`\n[${rep.label}] within-TOP coherence: <2 top symbols, skipping`);
    return;
  }
  console.log(`\n--- Within-TOP coherence (${rep.label}) ---`);
  console.log("Categorical agreement rates (1.0 = all TOP symbols share dominant):");
  for (const [feat, info] of Object.entries(rep.withinTop.categorical)) {
    console.log(`  ${feat.padEnd(28)} agreement=${fmt(info.agreementRate)} consensus=${info.consensusValue}`);
  }
  console.log("Numeric pairwise IQR overlap rates:");
  for (const [feat, info] of Object.entries(rep.withinTop.numeric)) {
    console.log(`  ${feat.padEnd(28)} overlapRate=${fmt(info.pairOverlapRate)}`);
  }
}

console.log("=".repeat(80));
console.log("TOP-CONTRIBUTOR FINGERPRINT DISCRIMINATION AUDIT");
console.log("=".repeat(80));
console.log(JSON.stringify(report.inputs, null, 2));

for (const rep of [report.cohortA, report.cohortB]) {
  printSymbolTable(rep);
  console.log(
    `\nBucket counts: TOP=${rep.bucketCounts.TOP.symbols}s/${rep.bucketCounts.TOP.records}r, ` +
      `OTHER_POS=${rep.bucketCounts.OTHER_POSITIVE.symbols}s/${rep.bucketCounts.OTHER_POSITIVE.records}r, ` +
      `NEUT=${rep.bucketCounts.NEUTRAL.symbols}s/${rep.bucketCounts.NEUTRAL.records}r, ` +
      `NEG=${rep.bucketCounts.NEGATIVE.symbols}s/${rep.bucketCounts.NEGATIVE.records}r`,
  );
  printFeatureSummary(rep);
  printWithinTop(rep);
}

console.log("\n=== FULL REPORT JSON ===");
console.log(JSON.stringify(report, null, 2));

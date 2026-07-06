#!/usr/bin/env node
/**
 * READ-ONLY audit: Why is the base execution route losing money?
 *
 * Cohort scope (the "base route"):
 *   - evidenceEra = POST_CALIBRATION
 *   - selectedEntryVariant = "vwap_retest_entry"
 *   - selectedExitVariant  = "tp1_full_exit"
 *   - direction = "SHORT"
 *   - marketRegime contains "BEAR" (case-insensitive)
 *   - outcome present (resolved primary closed variant exists)
 */

import fs from "node:fs";
import path from "node:path";

// Run from the monorepo root: node apps/api/scripts/audit-base-execution.mjs
const ROOT = path.resolve(process.cwd());
const SHADOW_PATH = path.join(ROOT, "data/shadow-positions.json");
const DLOG_PATH_API = path.join(ROOT, "apps/api/data/decision-log.jsonl");
const DLOG_PATH_ROOT = path.join(ROOT, "data/decision-log.jsonl");

// ---------- helpers ----------
const r4 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);
const avg = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return null;
  return r4(v.reduce((s, x) => s + x, 0) / v.length);
};
const sum = (xs) => xs.filter((x) => typeof x === "number" && Number.isFinite(x)).reduce((s, x) => s + x, 0);
const quantile = (sortedNums, q) => {
  if (sortedNums.length === 0) return null;
  const idx = Math.floor((sortedNums.length - 1) * q);
  return r4(sortedNums[idx]);
};
const distStats = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, min: null, p25: null, p50: null, p75: null, max: null };
  return { n: v.length, min: r4(v[0]), p25: quantile(v, 0.25), p50: quantile(v, 0.5), p75: quantile(v, 0.75), max: r4(v[v.length - 1]) };
};
const profitFactor = (xs) => {
  const wins = xs.filter((x) => x > 0);
  const losses = xs.filter((x) => x < 0);
  const winSum = sum(wins);
  const lossAbs = Math.abs(sum(losses));
  if (lossAbs === 0) return winSum > 0 ? Infinity : null;
  return r4(winSum / lossAbs);
};

// ---------- locate canonical decision log ----------
const dlogExists = {
  apiPath: fs.existsSync(DLOG_PATH_API),
  rootPath: fs.existsSync(DLOG_PATH_ROOT),
  apiSize: fs.existsSync(DLOG_PATH_API) ? fs.statSync(DLOG_PATH_API).size : 0,
  rootSize: fs.existsSync(DLOG_PATH_ROOT) ? fs.statSync(DLOG_PATH_ROOT).size : 0,
};

// ---------- pick the primary closed variant for a position ----------
function primaryClosedVariant(position) {
  if (!position?.variants) return null;
  return (
    position.variants.find((v) => v.variant === position.selectedExitVariant && v.state === "CLOSED")
    ?? position.variants.find((v) => v.state === "CLOSED")
    ?? null
  );
}

// ---------- load + reconstruct experience records ----------
const positions = JSON.parse(fs.readFileSync(SHADOW_PATH, "utf-8"));

function evidenceEraOf(p) {
  return p.strategyContextSnapshot?.evidenceEra
    ?? p.variantSelection?.evidenceEra
    ?? null;
}
function selectedEntryOf(p) {
  return p.selectedEntryVariant
    ?? p.variantSelection?.selectedEntryVariant
    ?? p.strategyContextSnapshot?.selectedEntryVariant
    ?? null;
}
function selectedExitOf(p) {
  return p.selectedExitVariant
    ?? p.variantSelection?.selectedExitVariant
    ?? p.strategyContextSnapshot?.selectedExitVariant
    ?? null;
}
function marketRegimeOf(p) {
  return p.strategyContextSnapshot?.marketRegime ?? p.marketRegime ?? null;
}
function chaseRiskOf(p) {
  return p.variantSelection?.chaseRisk ?? p.strategyContextSnapshot?.chaseRisk ?? null;
}
function entryDriftPctOfZoneOf(p) {
  return p.variantSelection?.entryDriftPct ?? p.strategyContextSnapshot?.entryDriftPctOfZone ?? null;
}
function entryDriftAtrOf(p) {
  return p.variantSelection?.entryDriftAtr ?? p.strategyContextSnapshot?.entryDriftAtr ?? null;
}
function stopDistanceBpsOf(p) {
  return p.stopDistanceBps ?? p.strategyContextSnapshot?.stopDistanceBps ?? null;
}
function costROf(p) {
  return p.costR ?? p.strategyContextSnapshot?.costR ?? p.variantSelection?.costR ?? null;
}

// ---------- build cohort ----------
const cohort = [];
for (const p of positions) {
  const era = evidenceEraOf(p);
  if (era !== "POST_CALIBRATION") continue;
  const entry = selectedEntryOf(p);
  if (entry !== "vwap_retest_entry") continue;
  const exit = selectedExitOf(p);
  if (exit !== "tp1_full_exit") continue;
  if (p.direction !== "SHORT") continue;
  const regime = marketRegimeOf(p);
  if (!regime || !/bear/i.test(regime)) continue;

  const v = primaryClosedVariant(p);
  if (!v) continue;
  const realizedNetR = typeof v.realizedNetR === "number" && Number.isFinite(v.realizedNetR) ? v.realizedNetR : null;
  const realizedGrossR = typeof v.realizedGrossR === "number" && Number.isFinite(v.realizedGrossR) ? v.realizedGrossR : null;
  if (realizedNetR === null) continue; // outcome must be present

  const record = {
    id: p.id,
    symbol: p.symbol,
    closedAt: v.closedAt,
    openedAt: p.entryFilledAt ?? v.openedAt ?? p.scannedAt,
    closeReason: v.closeReason ?? null,
    tp1Hit: !!v.tp1Hit,
    slHit: v.closeReason === "SL" || v.closeReason === "BREAKEVEN",
    realizedNetR,
    realizedGrossR,
    costR: costROf(p),
    stopDistanceBps: stopDistanceBpsOf(p),
    chaseRisk: chaseRiskOf(p),
    entryDriftPctOfZone: entryDriftPctOfZoneOf(p),
    entryDriftAtr: entryDriftAtrOf(p),
    marketRegime: regime,
    mfeR: (typeof v.mfeR === "number" ? v.mfeR : (typeof p.maxFavorableExcursionR === "number" ? p.maxFavorableExcursionR : null)),
    maeR: (typeof v.maeR === "number" ? v.maeR : (typeof p.maxAdverseExcursionR === "number" ? p.maxAdverseExcursionR : null)),
  };
  cohort.push(record);
}

// ---------- Part A: cohort sanity ----------
function sortedClosedAts() {
  return cohort
    .map((c) => c.closedAt)
    .filter((x) => typeof x === "string" && x.length > 0)
    .slice()
    .sort();
}
function cohortMetrics(rows) {
  const netRs = rows.map((r) => r.realizedNetR);
  const grossRs = rows.map((r) => r.realizedGrossR);
  const wins = netRs.filter((x) => x > 0);
  const losses = netRs.filter((x) => x < 0);
  return {
    n: rows.length,
    netAvgR: avg(netRs),
    grossAvgR: avg(grossRs),
    avgWinR: avg(wins),
    avgLossR: avg(losses),
    pf: profitFactor(netRs),
    wr: rows.length > 0 ? r4(wins.length / rows.length) : null,
    netSumR: r4(sum(netRs)),
  };
}

const partA = cohortMetrics(cohort);
const dates = sortedClosedAts();
partA.firstClose = dates[0] ?? null;
partA.lastClose = dates[dates.length - 1] ?? null;
partA.distinctSymbols = new Set(cohort.map((r) => r.symbol)).size;

// ---------- Part B: entry quality ----------
const partB = {
  entryDriftPctDist: distStats(cohort.map((r) => r.entryDriftPctOfZone)),
  entryDriftAtrDist: distStats(cohort.map((r) => r.entryDriftAtr)),
  chaseRiskCounts: {},
  chaseRiskPerf: {},
  driftBucketPerf: {},
};
for (const r of cohort) {
  const k = r.chaseRisk ?? "NULL";
  partB.chaseRiskCounts[k] = (partB.chaseRiskCounts[k] || 0) + 1;
}
for (const k of Object.keys(partB.chaseRiskCounts)) {
  const rows = cohort.filter((r) => (r.chaseRisk ?? "NULL") === k);
  partB.chaseRiskPerf[k] = cohortMetrics(rows);
}
function driftBucket(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "UNKNOWN";
  if (x <= -0.5) return "<=-0.5";
  if (x <= -0.2) return "-0.5..-0.2";
  if (x <= 0) return "-0.2..0";
  return ">=0";
}
const driftBuckets = ["<=-0.5", "-0.5..-0.2", "-0.2..0", ">=0", "UNKNOWN"];
for (const b of driftBuckets) {
  const rows = cohort.filter((r) => driftBucket(r.entryDriftPctOfZone) === b);
  partB.driftBucketPerf[b] = cohortMetrics(rows);
}

// ---------- Part C: stop geometry ----------
const partC = {
  stopBpsDist: distStats(cohort.map((r) => r.stopDistanceBps)),
  bucketPerf: {},
  flipThreshold: null,
};
function stopBucket(x) {
  if (x === null || !Number.isFinite(x)) return "UNKNOWN";
  if (x <= 100) return "[0,100]";
  if (x <= 175) return "(100,175]";
  if (x <= 300) return "(175,300]";
  return "(300,+)";
}
for (const b of ["[0,100]", "(100,175]", "(175,300]", "(300,+)", "UNKNOWN"]) {
  const rows = cohort.filter((r) => stopBucket(r.stopDistanceBps) === b);
  partC.bucketPerf[b] = cohortMetrics(rows);
}
// flip threshold: rolling avg of net R as we cumulate by increasing stopDistanceBps
const stopSorted = cohort
  .filter((r) => typeof r.stopDistanceBps === "number" && Number.isFinite(r.stopDistanceBps))
  .slice()
  .sort((a, b) => a.stopDistanceBps - b.stopDistanceBps);
// scan from large stop downward — find threshold T such that subset {stopDistanceBps >= T} has netAvgR > 0
// AND threshold T-eps does not satisfy this. Equivalent: scan T thresholds from cohort percentiles.
let flipT = null;
for (let i = 0; i < stopSorted.length; i++) {
  const t = stopSorted[i].stopDistanceBps;
  const subset = stopSorted.slice(i);
  if (subset.length < 5) break;
  const a = avg(subset.map((r) => r.realizedNetR));
  if (a !== null && a > 0) {
    flipT = t;
    break;
  }
}
partC.flipThreshold = flipT;

// ---------- Part D: TP/exit anatomy ----------
const partD = { byCloseReason: {}, tp1NetNonPositivePct: null };
const closeReasons = new Set(cohort.map((r) => r.closeReason ?? "NULL"));
for (const cr of closeReasons) {
  const rows = cohort.filter((r) => (r.closeReason ?? "NULL") === cr);
  partD.byCloseReason[cr] = cohortMetrics(rows);
}
const tp1Rows = cohort.filter((r) => r.closeReason === "TP1_FULL");
if (tp1Rows.length > 0) {
  partD.tp1NetNonPositivePct = r4(tp1Rows.filter((r) => r.realizedNetR <= 0).length / tp1Rows.length);
}

// ---------- Part E: cost / friction ----------
const partE = {
  costDist: distStats(cohort.map((r) => r.costR)),
  costByReason: {},
  costDominatedTp1Frac: null,
  grossPosNetNonPosFrac: null,
};
for (const cr of closeReasons) {
  const rows = cohort.filter((r) => (r.closeReason ?? "NULL") === cr);
  partE.costByReason[cr] = avg(rows.map((r) => r.costR));
}
if (tp1Rows.length > 0) {
  partE.costDominatedTp1Frac = r4(tp1Rows.filter((r) => (r.realizedGrossR ?? 0) > 0 && (r.realizedNetR ?? 0) <= 0).length / tp1Rows.length);
}
{
  const denom = cohort.length;
  if (denom > 0) {
    partE.grossPosNetNonPosFrac = r4(cohort.filter((r) => (r.realizedGrossR ?? 0) > 0 && (r.realizedNetR ?? 0) <= 0).length / denom);
  }
}

// ---------- Part F: loss anatomy ----------
const lossRows = cohort.filter((r) => r.realizedNetR < 0);
const slLosses = lossRows.filter((r) => r.closeReason === "SL");
const beLosses = lossRows.filter((r) => r.closeReason === "BREAKEVEN");
const tp1Losses = lossRows.filter((r) => r.closeReason === "TP1_FULL");
const timeExpiredLosses = lossRows.filter((r) => r.closeReason === "TIME_EXPIRED");
const partF = {
  avgLossR: avg(lossRows.map((r) => r.realizedNetR)),
  countByReason: {},
  slMfeStats: { n: slLosses.length, withMfe: 0, mfeGte05Pct: null, mfeGte10Pct: null, anyMfeAvailable: false },
};
for (const cr of closeReasons) {
  partF.countByReason[cr] = lossRows.filter((r) => r.closeReason === cr).length;
}
const slWithMfe = slLosses.filter((r) => typeof r.mfeR === "number" && Number.isFinite(r.mfeR));
partF.slMfeStats.withMfe = slWithMfe.length;
partF.slMfeStats.anyMfeAvailable = slWithMfe.length > 0;
if (slWithMfe.length > 0) {
  partF.slMfeStats.mfeGte05Pct = r4(slWithMfe.filter((r) => r.mfeR >= 0.5).length / slWithMfe.length);
  partF.slMfeStats.mfeGte10Pct = r4(slWithMfe.filter((r) => r.mfeR >= 1.0).length / slWithMfe.length);
  partF.slMfeStats.avgSlMfe = avg(slWithMfe.map((r) => r.mfeR));
  partF.slMfeStats.medianSlMfe = quantile(slWithMfe.map((r) => r.mfeR).slice().sort((a, b) => a - b), 0.5);
}

// ---------- Part G: per-symbol contribution ----------
const symMap = new Map();
for (const r of cohort) {
  const arr = symMap.get(r.symbol) || [];
  arr.push(r);
  symMap.set(r.symbol, arr);
}
const symStats = [];
for (const [sym, rows] of symMap) {
  const netRs = rows.map((r) => r.realizedNetR);
  symStats.push({ symbol: sym, n: rows.length, netSumR: r4(sum(netRs)), netAvgR: avg(netRs) });
}
const losersSorted = symStats.slice().sort((a, b) => a.netSumR - b.netSumR);
const winnersSorted = symStats.slice().sort((a, b) => b.netSumR - a.netSumR);
const top5Losers = losersSorted.slice(0, 5);
const top5Winners = winnersSorted.slice(0, 5);
const totalNegativeNetSumR = symStats.filter((s) => s.netSumR < 0).reduce((s, x) => s + x.netSumR, 0);
const top3LoserShare = totalNegativeNetSumR < 0 ? r4(losersSorted.slice(0, 3).reduce((s, x) => s + x.netSumR, 0) / totalNegativeNetSumR) : null;

// ---------- Output ----------
const result = {
  meta: {
    cohortDef: "evidenceEra=POST_CALIBRATION, entry=vwap_retest_entry, exit=tp1_full_exit, direction=SHORT, regime~/bear/i",
    shadowPositionsPath: SHADOW_PATH,
    decisionLog: {
      apiPath: DLOG_PATH_API,
      rootPath: DLOG_PATH_ROOT,
      apiPathExists: dlogExists.apiPath,
      rootPathExists: dlogExists.rootPath,
      apiPathBytes: dlogExists.apiSize,
      rootPathBytes: dlogExists.rootSize,
      canonical: dlogExists.apiPath && dlogExists.apiSize > (dlogExists.rootSize || 0) ? "apps/api/data/decision-log.jsonl" : (dlogExists.rootPath ? "data/decision-log.jsonl" : "NONE"),
    },
  },
  partA,
  partB,
  partC,
  partD,
  partE,
  partF,
  partG: {
    top5Losers,
    top5Winners,
    totalNegativeNetSumR: r4(totalNegativeNetSumR),
    top3LoserShareOfNegSum: top3LoserShare,
  },
};

console.log(JSON.stringify(result, null, 2));

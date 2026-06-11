#!/usr/bin/env node
/**
 * TopContributorFingerprintV0 Robustness Audit (READ-ONLY).
 *
 * Reproduces the live dashboard buckets (MATCH / NEITHER / VETO) using the
 * exact live profile thresholds, then runs outlier / concentration / temporal /
 * episode / threshold-sensitivity / profile-derivation-stability analyses.
 *
 * No production code is touched. No threshold tuning. No symbol hardcoding.
 *
 * Live profile thresholds (from dashboard, source of truth):
 *   - matchThresholds.stopDistanceBpsMax       = 187
 *   - matchThresholds.entryDriftPctOfZoneMax   = -0.46
 *   - matchThresholds.supportingEntryDriftAtr  = 2.0
 *   - vetoThresholds.stopDistanceBpsMin        = 263
 *   - vetoThresholds.entryDriftPctOfZoneMin    = +0.01
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SHADOW_POSITIONS_PATH = path.join(REPO_ROOT, "data", "shadow-positions.json");

// ─── Live thresholds (DO NOT modify) ──────────────────────────────────────────
const LIVE = {
  matchStopBpsMax: 187,
  matchEntryDriftPctMax: -0.46,
  vetoStopBpsMin: 263,
  vetoEntryDriftPctMin: 0.01,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isFin = Number.isFinite;
function r4(v) {
  return v === null || v === undefined || !isFin(v) ? null : Math.round(v * 10_000) / 10_000;
}
function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.5);
}
function p75(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.75);
}
function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function trimmedMean(values, frac) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const drop = Math.floor(s.length * frac);
  const t = s.slice(drop, s.length - drop);
  if (t.length === 0) return null;
  return mean(t);
}

// ─── Load positions / reconstruct records ─────────────────────────────────────
const rawPositions = JSON.parse(fs.readFileSync(SHADOW_POSITIONS_PATH, "utf8"));
const positions = Array.isArray(rawPositions) ? rawPositions : (rawPositions.positions ?? rawPositions);

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
      openedAt: p.entryFilledAt ?? variant.openedAt ?? p.scannedAt ?? null,
      closedAt: variant.closedAt ?? null,
      closeReason: variant.closeReason ?? null,
      realizedNetR: typeof variant.realizedNetR === "number" ? variant.realizedNetR : null,
    },
  });
}

// ─── Cohort filter ────────────────────────────────────────────────────────────
function inCohort(r) {
  const ctx = r.context;
  if (ctx.evidenceEra !== "POST_CALIBRATION") return false;
  const reg = ctx.marketRegime;
  if (!reg || !String(reg).toUpperCase().includes("BEAR")) return false;
  if (ctx.direction !== "SHORT") return false;
  if (ctx.selectedEntryVariant !== "vwap_retest_entry") return false;
  if (ctx.selectedExitVariant !== "tp1_full_exit") return false;
  if (ctx.whaleAgreement !== "AGREES") return false;
  return true;
}
const cohort = records.filter(inCohort);

// ─── Bucket assignment using live thresholds ──────────────────────────────────
function bucketOf(r, thresh) {
  const ctx = r.context;
  const stopBps = ctx.stopDistanceBps;
  const drift = ctx.entryDriftPctOfZone;
  // Veto first
  if (isFin(stopBps) && stopBps >= thresh.vetoStopBpsMin) return "VETO";
  if (isFin(drift) && drift >= thresh.vetoEntryDriftPctMin) return "VETO";
  // Match
  const stopOk = isFin(stopBps) && stopBps <= thresh.matchStopBpsMax;
  const driftOk = isFin(drift) && drift <= thresh.matchEntryDriftPctMax;
  if (stopOk && driftOk) return "MATCH";
  return "NEITHER";
}

function partition(cohort, thresh) {
  const out = { MATCH: [], NEITHER: [], VETO: [] };
  for (const r of cohort) out[bucketOf(r, thresh)].push(r);
  return out;
}

// ─── Economics ────────────────────────────────────────────────────────────────
function economics(recs) {
  const rs = recs.map((r) => r.outcome.realizedNetR).filter(isFin);
  const n = recs.length;
  if (rs.length === 0) {
    return { n, netSumR: null, netAvgR: null, profitFactor: null, winRate: null, avgWinR: null, avgLossR: null, medianR: null };
  }
  const sum = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((v) => v > 0);
  const losses = rs.filter((v) => v < 0);
  const lossAbs = losses.reduce((a, b) => a + Math.abs(b), 0);
  const sortedR = [...rs].sort((a, b) => a - b);
  return {
    n,
    netSumR: r4(sum),
    netAvgR: r4(sum / rs.length),
    profitFactor: lossAbs === 0 ? null : r4(wins.reduce((a, b) => a + b, 0) / lossAbs),
    winRate: r4(wins.length / rs.length),
    avgWinR: wins.length === 0 ? null : r4(wins.reduce((a, b) => a + b, 0) / wins.length),
    avgLossR: losses.length === 0 ? null : r4(losses.reduce((a, b) => a + b, 0) / losses.length),
    medianR: r4(quantile(sortedR, 0.5)),
  };
}

// ─── Reproduce dashboard ──────────────────────────────────────────────────────
const live = partition(cohort, LIVE);
const econ = {
  MATCH: economics(live.MATCH),
  NEITHER: economics(live.NEITHER),
  VETO: economics(live.VETO),
};

console.log("=".repeat(80));
console.log("FINGERPRINT V0 ROBUSTNESS AUDIT");
console.log("=".repeat(80));
console.log(`\nTotal positions parsed: ${positions.length}`);
console.log(`Closed-with-snapshot records: ${records.length}`);
console.log(`Cohort (BASE + WHALE_AGREES): n=${cohort.length}`);
console.log(`Bucket counts (live thresholds): MATCH=${live.MATCH.length}, NEITHER=${live.NEITHER.length}, VETO=${live.VETO.length}`);

// Dashboard-truth comparison
const EXPECT = { cohort: 95, MATCH: 20, NEITHER: 28, VETO: 47, MATCH_netAvgR: 0.5007, NEITHER_netAvgR: 0.1637, VETO_netAvgR: -0.052 };
console.log("\n--- DASHBOARD REPRODUCTION CHECK ---");
console.log(`  cohort n: expected=${EXPECT.cohort}, got=${cohort.length}, match=${cohort.length === EXPECT.cohort}`);
console.log(`  MATCH n:  expected=${EXPECT.MATCH}, got=${live.MATCH.length}, match=${live.MATCH.length === EXPECT.MATCH}`);
console.log(`  NEITHER n:expected=${EXPECT.NEITHER}, got=${live.NEITHER.length}, match=${live.NEITHER.length === EXPECT.NEITHER}`);
console.log(`  VETO n:   expected=${EXPECT.VETO}, got=${live.VETO.length}, match=${live.VETO.length === EXPECT.VETO}`);
console.log(`  MATCH netAvgR:   expected=${EXPECT.MATCH_netAvgR}, got=${econ.MATCH.netAvgR}`);
console.log(`  NEITHER netAvgR: expected=${EXPECT.NEITHER_netAvgR}, got=${econ.NEITHER.netAvgR}`);
console.log(`  VETO netAvgR:    expected=${EXPECT.VETO_netAvgR}, got=${econ.VETO.netAvgR}`);

// ─── PART 1: Reconstruction ──────────────────────────────────────────────────
console.log("\n--- PART 1: Reconstructed bucket economics ---");
for (const b of ["MATCH", "NEITHER", "VETO"]) {
  const e = econ[b];
  console.log(`  ${b.padEnd(8)} n=${String(e.n).padStart(3)} netAvgR=${String(e.netAvgR).padStart(8)} PF=${String(e.profitFactor).padStart(7)} netSumR=${String(e.netSumR).padStart(9)} WR=${String(e.winRate).padStart(6)} avgWin=${String(e.avgWinR).padStart(7)} avgLoss=${String(e.avgLossR).padStart(7)}`);
}

// ─── PART 2: MATCH outlier robustness ────────────────────────────────────────
console.log("\n--- PART 2: MATCH outlier robustness ---");
const matchR = live.MATCH.map((r) => r.outcome.realizedNetR).filter(isFin).sort((a, b) => a - b);
function statsFromArr(rs) {
  if (rs.length === 0) return { n: 0, netAvgR: null, PF: null, netSumR: null };
  const sum = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const lossAbs = rs.filter((v) => v < 0).reduce((a, b) => a + Math.abs(b), 0);
  return { n: rs.length, netAvgR: r4(sum / rs.length), PF: lossAbs === 0 ? null : r4(wins / lossAbs), netSumR: r4(sum) };
}
const sortedDesc = [...matchR].sort((a, b) => b - a);
const scenarios = [
  ["original", matchR],
  ["ex-top1-win", sortedDesc.slice(1)],
  ["ex-top2-wins", sortedDesc.slice(2)],
  ["ex-top3-wins", sortedDesc.slice(3)],
  ["ex-worst1", matchR.slice(1)],
];
for (const [label, arr] of scenarios) {
  const s = statsFromArr(arr);
  console.log(`  ${label.padEnd(14)} n=${String(s.n).padStart(3)} netAvgR=${String(s.netAvgR).padStart(8)} PF=${String(s.PF).padStart(7)} netSumR=${String(s.netSumR).padStart(9)}`);
}
const totalSum = matchR.reduce((a, b) => a + b, 0);
console.log(`  median netR:        ${r4(quantile([...matchR].sort((a, b) => a - b), 0.5))}`);
console.log(`  trimmed mean (5%):  ${r4(trimmedMean(matchR, 0.05))}`);
console.log(`  top-1 share of sum: ${r4(sortedDesc[0] / totalSum)}`);
console.log(`  top-3 share of sum: ${r4((sortedDesc.slice(0, 3).reduce((a, b) => a + b, 0)) / totalSum)}`);

// ─── PART 3: Symbol concentration in MATCH ───────────────────────────────────
console.log("\n--- PART 3: MATCH symbol concentration ---");
function bySymbol(recs) {
  const m = new Map();
  for (const r of recs) {
    const sym = r.context.symbol;
    if (!m.has(sym)) m.set(sym, []);
    m.get(sym).push(r);
  }
  return m;
}
const matchBySym = bySymbol(live.MATCH);
const symRows = [];
for (const [sym, recs] of matchBySym) {
  const e = economics(recs);
  symRows.push({ symbol: sym, ...e });
}
symRows.sort((a, b) => (b.netSumR ?? 0) - (a.netSumR ?? 0));
const matchNetSum = symRows.reduce((a, b) => a + (b.netSumR ?? 0), 0);
console.log("  Symbol      | n  | netSumR  | netAvgR  | PF       | WR     | share");
for (const s of symRows) {
  const share = matchNetSum === 0 ? null : r4((s.netSumR ?? 0) / matchNetSum);
  console.log(`  ${String(s.symbol).padEnd(11)} | ${String(s.n).padStart(2)} | ${String(s.netSumR).padStart(8)} | ${String(s.netAvgR).padStart(8)} | ${String(s.profitFactor).padStart(8)} | ${String(s.winRate).padStart(6)} | ${share}`);
}
const positiveSyms = symRows.filter((s) => (s.netSumR ?? 0) > 0).length;
const negativeSyms = symRows.filter((s) => (s.netSumR ?? 0) < 0).length;
console.log(`  positive contributors: ${positiveSyms}`);
console.log(`  negative contributors: ${negativeSyms}`);
console.log(`  top-1 sym share: ${r4((symRows[0]?.netSumR ?? 0) / matchNetSum)}`);
console.log(`  top-2 sym share: ${r4(((symRows[0]?.netSumR ?? 0) + (symRows[1]?.netSumR ?? 0)) / matchNetSum)}`);
console.log(`  top-3 sym share: ${r4(((symRows[0]?.netSumR ?? 0) + (symRows[1]?.netSumR ?? 0) + (symRows[2]?.netSumR ?? 0)) / matchNetSum)}`);

console.log("\n  Remove-top-symbol robustness:");
function ecoExcl(excludeSet) {
  const recs = live.MATCH.filter((r) => !excludeSet.has(r.context.symbol));
  return economics(recs);
}
const topSymsList = symRows.map((s) => s.symbol);
for (let k = 0; k <= 3; k++) {
  const excl = new Set(topSymsList.slice(0, k));
  const e = ecoExcl(excl);
  console.log(`    ex-top${k}-syms (${[...excl].join(",") || "-"}): n=${e.n} netAvgR=${e.netAvgR} PF=${e.profitFactor} netSumR=${e.netSumR}`);
}

// ─── PART 4: Temporal stability ──────────────────────────────────────────────
console.log("\n--- PART 4: Temporal stability (MATCH) ---");
const matchWithTime = live.MATCH
  .filter((r) => r.outcome.openedAt)
  .map((r) => ({ r, t: new Date(r.outcome.openedAt).getTime() }))
  .filter((x) => isFin(x.t))
  .sort((a, b) => a.t - b.t);
console.log(`  records with openedAt: ${matchWithTime.length} / ${live.MATCH.length}`);
if (matchWithTime.length > 0) {
  console.log(`  earliest: ${new Date(matchWithTime[0].t).toISOString()}`);
  console.log(`  latest:   ${new Date(matchWithTime[matchWithTime.length - 1].t).toISOString()}`);
}
const halfIdx = Math.floor(matchWithTime.length / 2);
const earlyHalf = matchWithTime.slice(0, halfIdx).map((x) => x.r);
const lateHalf = matchWithTime.slice(halfIdx).map((x) => x.r);
const eEarly = economics(earlyHalf);
const eLate = economics(lateHalf);
console.log(`  early-half: n=${eEarly.n} netAvgR=${eEarly.netAvgR} PF=${eEarly.profitFactor} WR=${eEarly.winRate}`);
console.log(`  late-half:  n=${eLate.n} netAvgR=${eLate.netAvgR} PF=${eLate.profitFactor} WR=${eLate.winRate}`);

// Pre/post 2026-05-19 burst
const BURST = new Date("2026-05-19T00:00:00Z").getTime();
const preBurst = matchWithTime.filter((x) => x.t < BURST).map((x) => x.r);
const postBurst = matchWithTime.filter((x) => x.t >= BURST).map((x) => x.r);
const ePre = economics(preBurst);
const ePost = economics(postBurst);
console.log(`  pre-2026-05-19:  n=${ePre.n} netAvgR=${ePre.netAvgR} PF=${ePre.profitFactor} WR=${ePre.winRate}`);
console.log(`  post-2026-05-19: n=${ePost.n} netAvgR=${ePost.netAvgR} PF=${ePost.profitFactor} WR=${ePost.winRate}`);

// ─── PART 5: Episode concentration ───────────────────────────────────────────
console.log("\n--- PART 5: Episode concentration (MATCH) ---");
const HOUR_MS = 60 * 60 * 1000;
const epMap = new Map();
for (const r of live.MATCH) {
  const t = r.outcome.openedAt ? new Date(r.outcome.openedAt).getTime() : null;
  const hourBucket = t === null ? "unknown" : Math.floor(t / HOUR_MS);
  const key = `${r.context.symbol}@${hourBucket}`;
  if (!epMap.has(key)) epMap.set(key, []);
  epMap.get(key).push(r);
}
const epList = [];
for (const [key, recs] of epMap) {
  const sum = recs.map((r) => r.outcome.realizedNetR).filter(isFin).reduce((a, b) => a + b, 0);
  epList.push({ key, n: recs.length, netSumR: r4(sum) });
}
epList.sort((a, b) => (b.netSumR ?? 0) - (a.netSumR ?? 0));
const matchSum = epList.reduce((a, b) => a + (b.netSumR ?? 0), 0);
console.log(`  raw n: ${live.MATCH.length}`);
console.log(`  episode count: ${epList.length}`);
const top1Ep = (epList[0]?.netSumR ?? 0) / matchSum;
const top3Ep = (epList.slice(0, 3).reduce((a, b) => a + (b.netSumR ?? 0), 0)) / matchSum;
console.log(`  top-1 episode share: ${r4(top1Ep)} (${epList[0]?.key})`);
console.log(`  top-3 episode share: ${r4(top3Ep)}`);
console.log("  Top-5 episodes:");
for (const ep of epList.slice(0, 5)) {
  console.log(`    ${ep.key.padEnd(28)} n=${ep.n} netSumR=${ep.netSumR}`);
}
let classification;
if (top1Ep < 0.35 && top3Ep < 0.6) classification = "HEALTHY_MULTI_EPISODE_SUPPORT";
else if (top1Ep < 0.6) classification = "SOME_EPISODE_CONCENTRATION";
else classification = "ONE_BURST_DOMINATED";
console.log(`  classification: ${classification}`);

// ─── PART 6: Cross-bucket comparison ─────────────────────────────────────────
console.log("\n--- PART 6: Cross-bucket comparison ---");
function topSymShare(recs) {
  const m = bySymbol(recs);
  let totalSum = 0;
  const symSums = [];
  for (const [sym, rs] of m) {
    const s = rs.map((r) => r.outcome.realizedNetR).filter(isFin).reduce((a, b) => a + b, 0);
    symSums.push({ sym, s });
    totalSum += s;
  }
  symSums.sort((a, b) => Math.abs(b.s) - Math.abs(a.s));
  return totalSum === 0 ? null : r4((symSums[0]?.s ?? 0) / totalSum);
}
for (const b of ["MATCH", "NEITHER", "VETO"]) {
  const recs = live[b];
  const rs = recs.map((r) => r.outcome.realizedNetR).filter(isFin);
  const sortedDescB = [...rs].sort((a, b2) => b2 - a);
  const orig = statsFromArr(rs);
  const exTop1 = statsFromArr(sortedDescB.slice(1));
  const exTop2 = statsFromArr(sortedDescB.slice(2));
  const tShare = topSymShare(recs);
  console.log(`  ${b.padEnd(8)} orig.netSumR=${String(orig.netSumR).padStart(8)} ex1=${String(exTop1.netSumR).padStart(8)} ex2=${String(exTop2.netSumR).padStart(8)} topSymShare=${tShare}`);
}

// ─── PART 7: Threshold sensitivity ───────────────────────────────────────────
console.log("\n--- PART 7: Threshold sensitivity (what-if) ---");
const variants = [
  { label: "live",                      thresh: { ...LIVE } },
  { label: "stopBpsMax=200 (looser)",   thresh: { ...LIVE, matchStopBpsMax: 200 } },
  { label: "stopBpsMax=175 (tighter)",  thresh: { ...LIVE, matchStopBpsMax: 175 } },
  { label: "entryDriftMax=-0.40 (looser)", thresh: { ...LIVE, matchEntryDriftPctMax: -0.40 } },
  { label: "entryDriftMax=-0.50 (tighter)", thresh: { ...LIVE, matchEntryDriftPctMax: -0.50 } },
];
for (const v of variants) {
  const part = partition(cohort, v.thresh);
  const e = economics(part.MATCH);
  console.log(`  ${v.label.padEnd(28)} MATCH n=${String(e.n).padStart(3)} netAvgR=${String(e.netAvgR).padStart(8)} PF=${e.profitFactor}`);
}

// ─── PART 8: Profile-derivation stability ────────────────────────────────────
console.log("\n--- PART 8: Profile-derivation stability ---");
function deriveProfile(cohortRecs) {
  // Mirror top-contributor-fingerprint-v0.ts: top-2 symbols by positive netSum,
  // negative = symbols with netSum < 0. p75 of TOP for match-max; median of NEG for veto-floor.
  const symMap = bySymbol(cohortRecs);
  const symStats = [];
  for (const [sym, recs] of symMap) {
    const s = recs.map((r) => r.outcome.realizedNetR).filter(isFin).reduce((a, b) => a + b, 0);
    symStats.push({ sym, recs, netSum: s });
  }
  const positive = symStats.filter((s) => s.netSum > 0).sort((a, b) => b.netSum - a.netSum);
  const topSyms = new Set(positive.slice(0, 2).map((s) => s.sym));
  const topRecs = [];
  const negRecs = [];
  for (const s of symStats) {
    if (topSyms.has(s.sym)) topRecs.push(...s.recs);
    else if (s.netSum < 0) negRecs.push(...s.recs);
  }
  const MIN_TOP = 10, MIN_NEG = 3;
  const ready = topRecs.length >= MIN_TOP && negRecs.length >= MIN_NEG;
  const topStop = topRecs.map((r) => r.context.stopDistanceBps).filter(isFin);
  const topDrift = topRecs.map((r) => r.context.entryDriftPctOfZone).filter(isFin);
  const negStop = negRecs.map((r) => r.context.stopDistanceBps).filter(isFin);
  const negDrift = negRecs.map((r) => r.context.entryDriftPctOfZone).filter(isFin);
  return {
    ready,
    topRecords: topRecs.length,
    negRecords: negRecs.length,
    topSyms: [...topSyms],
    matchStopBpsMax: r4(p75(topStop)),
    matchEntryDriftPctMax: r4(p75(topDrift)),
    vetoStopBpsMin: r4(median(negStop)),
    vetoEntryDriftPctMin: r4(median(negDrift)),
  };
}
// Per-symbol netSum within cohort (NOT just MATCH bucket) to remove "top symbol from cohort"
const cohortSymStats = [];
for (const [sym, recs] of bySymbol(cohort)) {
  const s = recs.map((r) => r.outcome.realizedNetR).filter(isFin).reduce((a, b) => a + b, 0);
  cohortSymStats.push({ sym, netSum: s });
}
cohortSymStats.sort((a, b) => b.netSum - a.netSum);
const positiveCohortSyms = cohortSymStats.filter((s) => s.netSum > 0).map((s) => s.sym);
const scenarios8 = [
  { label: "original (95)", excl: new Set() },
  { label: `drop top-1 sym (${positiveCohortSyms.slice(0, 1).join(",")})`, excl: new Set(positiveCohortSyms.slice(0, 1)) },
  { label: `drop top-2 syms (${positiveCohortSyms.slice(0, 2).join(",")})`, excl: new Set(positiveCohortSyms.slice(0, 2)) },
];
for (const sc of scenarios8) {
  const sub = cohort.filter((r) => !sc.excl.has(r.context.symbol));
  const prof = deriveProfile(sub);
  console.log(`  ${sc.label}: cohort=${sub.length} READY=${prof.ready} topSyms=[${prof.topSyms.join(",")}]`);
  console.log(`    matchStopBpsMax=${prof.matchStopBpsMax} matchEntryDriftMax=${prof.matchEntryDriftPctMax} vetoStopBpsMin=${prof.vetoStopBpsMin} vetoEntryDriftMin=${prof.vetoEntryDriftPctMin}`);
}

console.log("\n" + "=".repeat(80));
console.log("DONE");
console.log("=".repeat(80));

// READ-ONLY AUDIT — WHALE_AGREES + NO_HORIZON_CONFLICT on
// BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit
//
// Reconstructs cohorts directly from data/shadow-positions.json
// Does not modify any file or live behavior.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const DATA = path.join(ROOT, "data", "shadow-positions.json");

const raw = fs.readFileSync(DATA, "utf8");
const positions = JSON.parse(raw);

// ---- evidence-era classification (matches packages/shared/src/evidence-era.ts) ----
function classifyEvidenceEra(position) {
  const sel = position?.variantSelection ?? null;
  if (!sel) return "LEGACY_PRE_ROUTING";
  if (sel.evidenceEra) return sel.evidenceEra;
  const hasRouteMode = typeof sel.routeMode === "string" && sel.routeMode.length > 0;
  const hasCalibration =
    sel.calibratedExpectedNetR !== undefined || sel.calibrationVerdict !== undefined;
  if (!hasRouteMode && !hasCalibration) return "LEGACY_PRE_ROUTING";
  if (hasRouteMode && !hasCalibration) return "POST_ROUTING_PRE_CALIBRATION";
  if (hasCalibration) return "POST_CALIBRATION";
  return "UNKNOWN";
}

// ---- regime normalization (matches deriveMarketRegime in adaptive-gate-intelligence) ----
function normalizeRegime(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).toUpperCase();
  if (s.includes("BULL")) return "BULLISH_EXPANSION";
  if (s.includes("BEAR")) return "BEARISH_EXPANSION";
  if (s.includes("SIDE") || s.includes("RANGE") || s.includes("CHOP")) return "SIDEWAYS";
  if (s.includes("MIX")) return "MIXED";
  return s;
}

// ---- whale alignment ----
function whaleAlignment(rec) {
  const agreement = rec.context.whaleAgreement;
  if (agreement === null || agreement === undefined) return null;
  if (agreement === "AGREES") return "WHALE_AGREES";
  if (agreement === "DISAGREES") return "WHALE_DISAGREES";
  return "WHALE_UNAVAILABLE";
}
function horizonConflictBucket(rec) {
  const v = rec.context.horizonConflict;
  if (v === null || v === undefined) return null;
  return v ? "HORIZON_CONFLICT_TRUE" : "HORIZON_CONFLICT_FALSE";
}
function kronosAlignment(rec) {
  const bias = rec.context.selectedKronosBias ?? rec.context.kronosBias1h;
  if (bias === null || bias === undefined) return null;
  if (bias === "UNAVAILABLE") return "KRONOS_UNAVAILABLE";
  return bias === rec.context.direction ? "KRONOS_ALIGNED" : "KRONOS_DISAGREES";
}
function directionalAlignmentBucket(rec) {
  const v = rec.context.directionalAlignmentLabel;
  if (v === null || v === undefined) return null;
  if (v === "ALIGNED") return "TREND_ALIGNED";
  if (v === "MIXED") return "MIXED";
  if (v === "CONFLICTED") return "CONFLICTING";
  return null;
}
function sourceConflictBucket(rec) {
  const bias = rec.context.selectedKronosBias ?? rec.context.kronosBias1h;
  const whale = rec.context.whaleAgreement;
  if (bias === null || bias === undefined) return null;
  if (whale === null || whale === undefined) return null;
  if (bias === "UNAVAILABLE" || whale === "UNAVAILABLE") return null;
  const kronosOk = bias === rec.context.direction;
  const whaleOk = whale === "AGREES";
  if (kronosOk === whaleOk) return "SOURCE_CONFLICT_FALSE";
  return "SOURCE_CONFLICT_TRUE";
}

// ---- build StrategyExperienceRecord-like objects from positions ----
function primaryClosedVariant(p) {
  return (
    p.variants.find((v) => v.variant === p.selectedExitVariant && v.state === "CLOSED") ??
    p.variants.find((v) => v.state === "CLOSED") ??
    null
  );
}
function buildRecord(p) {
  const variant = primaryClosedVariant(p);
  if (!variant) return null;
  const ctx = p.strategyContextSnapshot ?? null;
  if (!ctx) return null;
  const realizedNetR = Number.isFinite(variant.realizedNetR) ? variant.realizedNetR : null;
  const realizedGrossR = Number.isFinite(variant.realizedGrossR) ? variant.realizedGrossR : null;
  const openedAt = p.entryFilledAt ?? variant.openedAt ?? p.scannedAt ?? null;
  const closedAt = variant.closedAt ?? null;
  return {
    positionId: p.id,
    // context.direction is NOT overridden with position.direction — matches
    // production's buildStrategyExperienceRecords (packages/shared/src/strategy-
    // intelligence.ts), which spreads strategyContextSnapshot verbatim. outcome.direction
    // below legitimately stays position.direction (the real executed direction).
    context: {
      ...ctx,
      symbol: p.symbol,
      evidenceEra: ctx.evidenceEra ?? p.variantSelection?.evidenceEra ?? null,
    },
    outcome: {
      symbol: p.symbol,
      direction: p.direction,
      selectedEntryVariant: p.selectedEntryVariant ?? p.variantSelection?.selectedEntryVariant ?? null,
      selectedExitVariant: variant.variant ?? p.selectedExitVariant ?? null,
      openedAt,
      closedAt,
      closeReason: variant.closeReason ?? null,
      realizedGrossR,
      realizedNetR,
      tp1Hit: variant.tp1Hit ?? null,
      slHit: variant.closeReason === "SL" || variant.closeReason === "BREAKEVEN",
      evidenceEra: p.variantSelection?.evidenceEra ?? null,
      mfeR: variant.mfeR ?? p.maxFavorableExcursionR ?? null,
      maeR: variant.maeR ?? p.maxAdverseExcursionR ?? null,
    },
    position: p,
    variant,
  };
}

const allRecords = positions.map(buildRecord).filter(Boolean);

// Filter to POST_CALIBRATION era — same definition as adaptive-gate-intelligence
function isPostCalibration(rec) {
  return (rec.context.evidenceEra ?? rec.outcome.evidenceEra) === "POST_CALIBRATION";
}
const postCal = allRecords.filter(isPostCalibration);

console.log(`Total positions:                 ${positions.length}`);
console.log(`With closed variant + ctx:       ${allRecords.length}`);
console.log(`POST_CALIBRATION resolved:       ${postCal.length}`);

// ---- Cohort filters ----
function isBase(rec) {
  return (
    normalizeRegime(rec.context.marketRegime) === "BEARISH_EXPANSION" &&
    rec.context.direction === "SHORT" &&
    rec.context.selectedEntryVariant === "vwap_retest_entry" &&
    rec.outcome.selectedExitVariant === "tp1_full_exit"
  );
}
function isWhaleAgrees(rec) {
  return whaleAlignment(rec) === "WHALE_AGREES";
}
function isNoHorizonConflict(rec) {
  return horizonConflictBucket(rec) === "HORIZON_CONFLICT_FALSE";
}

const base = postCal.filter(isBase);
const baseWhale = base.filter(isWhaleAgrees);
const baseNoHC = base.filter(isNoHorizonConflict);
const baseBoth = base.filter((r) => isWhaleAgrees(r) && isNoHorizonConflict(r));

// ---- Metrics ----
function sum(arr) {
  return arr.reduce((s, v) => s + v, 0);
}
function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function metricsOf(cohort) {
  const n = cohort.length;
  if (n === 0) {
    return {
      n: 0, consNetAvgR: null, realisticNetAvgR: null, grossAvgR: null, PF: null,
      winRate: null, avgWinR: null, avgLossR: null, netSumR: 0,
      tp1Rate: null, slRate: null, otherRate: null, medianNetR: null,
    };
  }
  const netRs = cohort.map((r) => r.outcome.realizedNetR).filter((v) => Number.isFinite(v));
  const grossRs = cohort.map((r) => r.outcome.realizedGrossR).filter((v) => Number.isFinite(v));
  const wins = netRs.filter((v) => v > 0);
  const losses = netRs.filter((v) => v < 0);
  const winSum = sum(wins);
  const lossAbs = Math.abs(sum(losses));
  const netSumR = sum(netRs);
  const grossAvgR = grossRs.length ? sum(grossRs) / grossRs.length : null;
  const consNetAvgR = netRs.length ? netSumR / netRs.length : null;
  // "realistic" subtracts modest slippage in the rest of the system; we approximate
  // by reporting gross-only assumption (no extra haircut) since the dashboard's
  // "realistic" is internally derived. We report both raw consNetAvgR (post-cost)
  // and a "realistic" estimate = consNetAvgR + half of (gross-cons) drift, i.e. PF-symmetric.
  const realisticNetAvgR = null; // not directly recoverable without policy module; left null
  const tp1Count = cohort.filter((r) => r.outcome.tp1Hit === true).length;
  const slCount = cohort.filter((r) =>
    r.outcome.closeReason === "SL" || r.outcome.closeReason === "BREAKEVEN"
  ).length;
  const otherCount = n - tp1Count - slCount;
  return {
    n,
    consNetAvgR: round4(consNetAvgR),
    realisticNetAvgR,
    grossAvgR: grossAvgR === null ? null : round4(grossAvgR),
    PF: lossAbs === 0 ? null : round4(winSum / lossAbs),
    winRate: round4(wins.length / n),
    avgWinR: wins.length ? round4(winSum / wins.length) : null,
    avgLossR: losses.length ? round4(sum(losses) / losses.length) : null,
    netSumR: round4(netSumR),
    tp1Rate: round4(tp1Count / n),
    slRate: round4(slCount / n),
    otherRate: round4(otherCount / n),
    medianNetR: round4(median(netRs)),
  };
}

function round4(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return v;
  return Math.round(v * 10_000) / 10_000;
}

// ---- Multiplicity (effective N) ----
const FIFTEEN_MIN_MS = 15 * 60_000;
function bucketOpenedAt(epochMs) {
  return Math.floor(epochMs / FIFTEEN_MIN_MS);
}
function bucketEntryPrice(price) {
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.floor(Math.log(price) / 0.0005);
}
let nullCnt = 0;
function multiplicity(cohort) {
  const nRaw = cohort.length;
  const seen = new Set();
  for (const rec of cohort) {
    const symbol = rec.context.symbol;
    const direction = rec.context.direction;
    const entry = rec.context.selectedEntryVariant ?? "UNKNOWN_ENTRY";
    const exit = rec.outcome.selectedExitVariant ?? "UNKNOWN_EXIT";
    const openedAtRaw = rec.outcome.openedAt ?? rec.context.scanTimestamp ?? null;
    const epochMs = openedAtRaw ? new Date(openedAtRaw).getTime() : NaN;
    const timeBucket = Number.isFinite(epochMs) ? bucketOpenedAt(epochMs) : `t_null_${nullCnt++}`;
    const price = rec.context.entryPrice ?? null;
    const pb = price !== null ? bucketEntryPrice(price) : null;
    const priceBucket = pb !== null ? pb : `p_null_${nullCnt++}`;
    seen.add(`${symbol}|${direction}|${entry}|${exit}|${timeBucket}|${priceBucket}`);
  }
  const nEff = seen.size;
  return {
    nRaw,
    nEffective: nEff,
    multiplicityRatio: nRaw === 0 ? 1 : round4(nEff / nRaw),
    warning: nRaw >= 3 && nEff / nRaw <= 0.5,
  };
}

console.log("\n=== Cohort sizes ===");
console.log(`BASE                         = ${base.length}`);
console.log(`BASE + WHALE_AGREES          = ${baseWhale.length}`);
console.log(`BASE + NO_HORIZON_CONFLICT   = ${baseNoHC.length}`);
console.log(`BASE + BOTH                  = ${baseBoth.length}`);

console.log("\n=== Section 2: Four-cohort economics ===");
const cohorts = {
  BASE: base,
  "BASE+WHALE": baseWhale,
  "BASE+NO_HC": baseNoHC,
  "BASE+BOTH": baseBoth,
};
const metricsByName = {};
for (const [name, c] of Object.entries(cohorts)) {
  const m = metricsOf(c);
  const mult = multiplicity(c);
  metricsByName[name] = { ...m, nRaw: mult.nRaw, nEffective: mult.nEffective, multRatio: mult.multiplicityRatio, multWarning: mult.warning };
}
console.log(JSON.stringify(metricsByName, null, 2));

console.log("\n=== Section 3: Incremental uplift ===");
const baseMetrics = metricsByName.BASE;
function delta(a, b) { if (a === null || b === null) return null; return round4(a - b); }
for (const [name, m] of Object.entries(metricsByName)) {
  const ret = baseMetrics.n > 0 ? round4(m.n / baseMetrics.n) : null;
  console.log(`${name.padEnd(14)} n=${String(m.n).padStart(3)}  nEff=${String(m.nEffective).padStart(3)}  ret=${ret}  netAvgR=${m.consNetAvgR}  Δ=${delta(m.consNetAvgR, baseMetrics.consNetAvgR)}  PF=${m.PF}  WR=${m.winRate}  SL=${m.slRate}`);
}

// ---- Section 4: outlier robustness on BOTH cohort ----
console.log("\n=== Section 4: BOTH outlier robustness ===");
const bothNets = baseBoth.map((r) => ({ id: r.positionId, symbol: r.context.symbol, netR: r.outcome.realizedNetR })).filter((x) => Number.isFinite(x.netR));
const sortedByNet = [...bothNets].sort((a, b) => b.netR - a.netR);
const top3Names = sortedByNet.slice(0, 3);
const bottom3Names = sortedByNet.slice(-3);
console.log("Top 3 winners:", top3Names);
console.log("Bottom 3 losers:", bottom3Names);

function recomputeOnRemoval(removalIds) {
  const sub = baseBoth.filter((r) => !removalIds.has(r.positionId));
  const m = metricsOf(sub);
  return { n: sub.length, netAvgR: m.consNetAvgR, PF: m.PF, netSumR: m.netSumR };
}
const sortedAsc = [...bothNets].sort((a, b) => a.netR - b.netR);
console.log("After removing best 1:", recomputeOnRemoval(new Set([sortedByNet[0]?.id])));
console.log("After removing best 2:", recomputeOnRemoval(new Set(sortedByNet.slice(0,2).map(x => x.id))));
console.log("After removing worst 1:", recomputeOnRemoval(new Set([sortedAsc[0]?.id])));

const baseBothNetSum = sum(bothNets.map(x => x.netR));
const top1Share = bothNets.length ? sortedByNet[0]?.netR / baseBothNetSum : null;
const top3Share = bothNets.length ? sum(sortedByNet.slice(0,3).map(x=>x.netR)) / baseBothNetSum : null;
console.log("Top-1 share of netSumR:", round4(top1Share));
console.log("Top-3 share of netSumR:", round4(top3Share));
console.log("Mean netR vs Median netR:", round4(baseBothNetSum / (bothNets.length || 1)), "vs", round4(median(bothNets.map(x=>x.netR))));

// ---- Section 5: Symbol diversification on BOTH ----
console.log("\n=== Section 5: BOTH symbol diversification ===");
const bySym = new Map();
for (const r of baseBoth) {
  const sym = r.context.symbol;
  const lst = bySym.get(sym) ?? [];
  lst.push(r);
  bySym.set(sym, lst);
}
const symRows = [...bySym.entries()].map(([sym, recs]) => {
  const m = metricsOf(recs);
  return { symbol: sym, n: m.n, netAvgR: m.consNetAvgR, netSumR: m.netSumR, PF: m.PF, winRate: m.winRate };
}).sort((a, b) => b.n - a.n);
console.log(JSON.stringify(symRows, null, 2));

// ---- Section 6: temporal / multiplicity already above ----
console.log("\n=== Section 6: BOTH multiplicity ===");
console.log(JSON.stringify(multiplicity(baseBoth), null, 2));
// biggest single-episode share
const epMap = new Map();
nullCnt = 0;
for (const rec of baseBoth) {
  const symbol = rec.context.symbol;
  const direction = rec.context.direction;
  const entry = rec.context.selectedEntryVariant ?? "UNKNOWN_ENTRY";
  const exit = rec.outcome.selectedExitVariant ?? "UNKNOWN_EXIT";
  const openedAtRaw = rec.outcome.openedAt ?? rec.context.scanTimestamp ?? null;
  const epochMs = openedAtRaw ? new Date(openedAtRaw).getTime() : NaN;
  const timeBucket = Number.isFinite(epochMs) ? bucketOpenedAt(epochMs) : `t_null_${nullCnt++}`;
  const price = rec.context.entryPrice ?? null;
  const pb = price !== null ? bucketEntryPrice(price) : null;
  const priceBucket = pb !== null ? pb : `p_null_${nullCnt++}`;
  const key = `${symbol}|${direction}|${entry}|${exit}|${timeBucket}|${priceBucket}`;
  const lst = epMap.get(key) ?? [];
  lst.push(rec.outcome.realizedNetR);
  epMap.set(key, lst);
}
let maxEpisodeSum = 0;
for (const [k, lst] of epMap) {
  const s = sum(lst);
  if (Math.abs(s) > Math.abs(maxEpisodeSum)) maxEpisodeSum = s;
}
const bothNetSumAll = sum(baseBoth.map(r => r.outcome.realizedNetR).filter(Number.isFinite));
console.log("Biggest single-episode share of netSumR (BOTH):", round4(maxEpisodeSum / (bothNetSumAll || 1)));

// ---- Section 7: Coverage bias / recency ----
console.log("\n=== Section 7: Coverage / recency bias ===");
const baseCovered = base.filter((r) => r.context.whaleAgreement !== null && r.context.whaleAgreement !== undefined && r.context.horizonConflict !== null && r.context.horizonConflict !== undefined);
const baseUncovered = base.filter((r) => !(r.context.whaleAgreement !== null && r.context.whaleAgreement !== undefined && r.context.horizonConflict !== null && r.context.horizonConflict !== undefined));
console.log("BASE with whale+horizon coverage:", metricsOf(baseCovered));
console.log("BASE WITHOUT whale+horizon coverage:", metricsOf(baseUncovered));
console.log("BOTH cohort (already covered):", metricsOf(baseBoth));

// Pre / post by openedAt halves (a proxy for recency without a hard cutover marker)
const baseTimes = base.map(r => ({ rec: r, t: new Date(r.outcome.openedAt ?? r.context.scanTimestamp ?? 0).getTime() })).filter(x => Number.isFinite(x.t)).sort((a,b)=>a.t-b.t);
const half = Math.floor(baseTimes.length/2);
const earlyHalf = baseTimes.slice(0, half).map(x=>x.rec);
const lateHalf = baseTimes.slice(half).map(x=>x.rec);
console.log(`BASE early half (n=${earlyHalf.length}, opened before ${new Date(baseTimes[half-1]?.t || 0).toISOString()}):`, metricsOf(earlyHalf));
console.log(`BASE late half (n=${lateHalf.length}):`, metricsOf(lateHalf));

// BOTH split by recency
const bothTimes = baseBoth.map(r => ({ rec: r, t: new Date(r.outcome.openedAt ?? r.context.scanTimestamp ?? 0).getTime() })).filter(x => Number.isFinite(x.t)).sort((a,b)=>a.t-b.t);
const bothHalf = Math.floor(bothTimes.length/2);
console.log(`BOTH early half (n=${bothHalf}):`, metricsOf(bothTimes.slice(0,bothHalf).map(x=>x.rec)));
console.log(`BOTH late half (n=${bothTimes.length-bothHalf}):`, metricsOf(bothTimes.slice(bothHalf).map(x=>x.rec)));

// ---- Section 9: Comparison against other context filters ----
console.log("\n=== Section 9: Comparison vs other filters ===");
const filters = {
  "TREND_ALIGNED": (r) => directionalAlignmentBucket(r) === "TREND_ALIGNED",
  "SOURCE_CONFLICT_FALSE + TREND_ALIGNED": (r) => sourceConflictBucket(r) === "SOURCE_CONFLICT_FALSE" && directionalAlignmentBucket(r) === "TREND_ALIGNED",
  "WHALE_AGREES only": isWhaleAgrees,
  "NO_HORIZON_CONFLICT only": isNoHorizonConflict,
  "WHALE_AGREES + NO_HORIZON_CONFLICT": (r) => isWhaleAgrees(r) && isNoHorizonConflict(r),
  "KRONOS_ALIGNED": (r) => kronosAlignment(r) === "KRONOS_ALIGNED",
  "KRONOS_ALIGNED + WHALE_AGREES": (r) => kronosAlignment(r) === "KRONOS_ALIGNED" && isWhaleAgrees(r),
  "KRONOS_ALIGNED + NO_HORIZON_CONFLICT": (r) => kronosAlignment(r) === "KRONOS_ALIGNED" && isNoHorizonConflict(r),
};
for (const [name, pred] of Object.entries(filters)) {
  const sub = base.filter(pred);
  const m = metricsOf(sub);
  console.log(`${name.padEnd(45)} n=${String(m.n).padStart(3)}  netAvgR=${m.consNetAvgR}  Δ=${delta(m.consNetAvgR, baseMetrics.consNetAvgR)}  PF=${m.PF}  WR=${m.winRate}  SL=${m.slRate}`);
}

// ---- Section 10: Phase 3.1 instrumentation (BOTH MFE/MAE) ----
console.log("\n=== Section 10: Phase 3.1 instrumentation (BOTH MFE/MAE) ===");
const bothInst = baseBoth.filter(r => Number.isFinite(r.outcome.mfeR) && Number.isFinite(r.outcome.maeR));
const winners = bothInst.filter(r => r.outcome.realizedNetR > 0);
const losers = bothInst.filter(r => r.outcome.realizedNetR < 0);
function avg(xs){ return xs.length ? round4(sum(xs)/xs.length) : null; }
console.log("Instrumented count:", bothInst.length, " / total BOTH:", baseBoth.length);
console.log("Avg MFE R (all):", avg(bothInst.map(r=>r.outcome.mfeR)));
console.log("Avg MAE R (all):", avg(bothInst.map(r=>r.outcome.maeR)));
console.log("Avg MFE R winners:", avg(winners.map(r=>r.outcome.mfeR)));
console.log("Avg MFE R losers:", avg(losers.map(r=>r.outcome.mfeR)));
console.log("Avg MAE R winners:", avg(winners.map(r=>r.outcome.maeR)));
console.log("Avg MAE R losers:", avg(losers.map(r=>r.outcome.maeR)));

// ---- Coverage summary on BASE ----
console.log("\n=== Coverage summary on BASE ===");
const whaleKnownBase = base.filter(r => r.context.whaleAgreement !== null && r.context.whaleAgreement !== undefined).length;
const horizonKnownBase = base.filter(r => r.context.horizonConflict !== null && r.context.horizonConflict !== undefined).length;
console.log(`BASE n=${base.length}; whale coverage=${round4(whaleKnownBase/base.length)}; horizon coverage=${round4(horizonKnownBase/base.length)}`);

// List all BOTH records for transparency
console.log("\n=== All BOTH records (id, symbol, openedAt, closeReason, netR) ===");
for (const r of baseBoth.sort((a,b) => (a.outcome.openedAt > b.outcome.openedAt ? 1 : -1))) {
  console.log(`${r.positionId}  ${r.context.symbol.padEnd(10)}  ${r.outcome.openedAt}  ${String(r.outcome.closeReason).padEnd(14)}  netR=${round4(r.outcome.realizedNetR)}  whale=${r.context.whaleAgreement} hc=${r.context.horizonConflict}`);
}

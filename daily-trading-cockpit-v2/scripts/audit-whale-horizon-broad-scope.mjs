// READ-ONLY AUDIT — WHALE_AGREES + NO_HORIZON_CONFLICT on the BROAD Section K cohort:
// BEARISH_EXPANSION + SHORT (ALL entry/exit variants), POST_CALIBRATION only.
//
// Mirrors scripts/audit-whale-horizon-cohorts.mjs predicates / accessors,
// but removes the route filter (vwap_retest_entry + tp1_full_exit).
// Reconstructs cohorts directly from data/shadow-positions.json. No writes.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const DATA = path.join(ROOT, "data", "shadow-positions.json");
const raw = fs.readFileSync(DATA, "utf8");
const positions = JSON.parse(raw);

// ---- evidence era (matches packages/shared/src/evidence-era.ts) ----
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

function normalizeRegime(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).toUpperCase();
  if (s.includes("BULL")) return "BULLISH_EXPANSION";
  if (s.includes("BEAR")) return "BEARISH_EXPANSION";
  if (s.includes("SIDE") || s.includes("RANGE") || s.includes("CHOP")) return "SIDEWAYS";
  if (s.includes("MIX")) return "MIXED";
  return s;
}

function whaleAlignment(rec) {
  const v = rec.context.whaleAgreement;
  if (v === null || v === undefined) return null;
  if (v === "AGREES") return "WHALE_AGREES";
  if (v === "DISAGREES") return "WHALE_DISAGREES";
  return "WHALE_UNAVAILABLE";
}
function horizonConflictBucket(rec) {
  const v = rec.context.horizonConflict;
  if (v === null || v === undefined) return null;
  return v ? "HORIZON_CONFLICT_TRUE" : "HORIZON_CONFLICT_FALSE";
}

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
      evidenceEra: ctx.evidenceEra ?? p.variantSelection?.evidenceEra ?? classifyEvidenceEra(p),
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
function isPostCalibration(rec) {
  return (rec.context.evidenceEra ?? rec.outcome.evidenceEra) === "POST_CALIBRATION";
}
const postCal = allRecords.filter(isPostCalibration);

console.log(`Total positions:                 ${positions.length}`);
console.log(`With closed variant + ctx:       ${allRecords.length}`);
console.log(`POST_CALIBRATION resolved:       ${postCal.length}`);

// ---- BROAD predicate (Section K canonical) ----
function isBaseBroad(rec) {
  return (
    normalizeRegime(rec.context.marketRegime) === "BEARISH_EXPANSION" &&
    rec.context.direction === "SHORT"
  );
}
// ---- STRICT predicate (route-locked) for comparison only ----
function isBaseStrict(rec) {
  return (
    isBaseBroad(rec) &&
    rec.context.selectedEntryVariant === "vwap_retest_entry" &&
    rec.outcome.selectedExitVariant === "tp1_full_exit"
  );
}
function isWhaleAgrees(rec) { return whaleAlignment(rec) === "WHALE_AGREES"; }
function isNoHorizonConflict(rec) { return horizonConflictBucket(rec) === "HORIZON_CONFLICT_FALSE"; }

const baseBroad = postCal.filter(isBaseBroad);
const broadWhale = baseBroad.filter(isWhaleAgrees);
const broadNoHC = baseBroad.filter(isNoHorizonConflict);
const broadBoth = baseBroad.filter((r) => isWhaleAgrees(r) && isNoHorizonConflict(r));

const baseStrict = postCal.filter(isBaseStrict);
const strictWhale = baseStrict.filter(isWhaleAgrees);
const strictNoHC = baseStrict.filter(isNoHorizonConflict);
const strictBoth = baseStrict.filter((r) => isWhaleAgrees(r) && isNoHorizonConflict(r));

// ---- Helpers ----
function sum(arr){return arr.reduce((s,v)=>s+v,0);}
function median(arr){if(!arr.length)return null;const s=[...arr].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function round4(v){if(v==null||!Number.isFinite(v))return v;return Math.round(v*10000)/10000;}
function metricsOf(cohort) {
  const n = cohort.length;
  if (!n) return { n:0, netAvgR:null, grossAvgR:null, PF:null, winRate:null, tp1Rate:null, slRate:null, medianNetR:null, netSumR:0 };
  const netRs = cohort.map(r=>r.outcome.realizedNetR).filter(Number.isFinite);
  const grossRs = cohort.map(r=>r.outcome.realizedGrossR).filter(Number.isFinite);
  const wins = netRs.filter(v=>v>0), losses = netRs.filter(v=>v<0);
  const winSum = sum(wins), lossAbs = Math.abs(sum(losses));
  const netSumR = sum(netRs);
  const tp1 = cohort.filter(r=>r.outcome.tp1Hit===true).length;
  const sl = cohort.filter(r=>r.outcome.closeReason==="SL"||r.outcome.closeReason==="BREAKEVEN").length;
  return {
    n,
    netAvgR: netRs.length ? round4(netSumR/netRs.length) : null,
    grossAvgR: grossRs.length ? round4(sum(grossRs)/grossRs.length) : null,
    PF: lossAbs===0 ? null : round4(winSum/lossAbs),
    winRate: round4(wins.length/n),
    tp1Rate: round4(tp1/n),
    slRate: round4(sl/n),
    medianNetR: round4(median(netRs)),
    netSumR: round4(netSumR),
  };
}

// Multiplicity (episode/effective n)
const FIFTEEN_MIN_MS = 15*60_000;
function bucketOpenedAt(ms){return Math.floor(ms/FIFTEEN_MIN_MS);}
function bucketEntryPrice(p){if(!Number.isFinite(p)||p<=0)return null;return Math.floor(Math.log(p)/0.0005);}
let nullCnt = 0;
function episodeKey(rec){
  const symbol = rec.context.symbol;
  const direction = rec.context.direction;
  const entry = rec.context.selectedEntryVariant ?? "UNKNOWN_ENTRY";
  const exit = rec.outcome.selectedExitVariant ?? "UNKNOWN_EXIT";
  const openedAtRaw = rec.outcome.openedAt ?? rec.context.scanTimestamp ?? null;
  const epochMs = openedAtRaw ? new Date(openedAtRaw).getTime() : NaN;
  const tb = Number.isFinite(epochMs) ? bucketOpenedAt(epochMs) : `t_null_${nullCnt++}`;
  const price = rec.context.entryPrice ?? null;
  const pb = price !== null ? bucketEntryPrice(price) : null;
  const pbk = pb !== null ? pb : `p_null_${nullCnt++}`;
  return `${symbol}|${direction}|${entry}|${exit}|${tb}|${pbk}`;
}
function multiplicity(cohort){
  const seen = new Set();
  for (const rec of cohort) seen.add(episodeKey(rec));
  return { nRaw: cohort.length, nEffective: seen.size, ratio: cohort.length ? round4(seen.size/cohort.length) : null };
}

// ---- Section 2: BROAD four-cohort ----
console.log("\n=== Section 2: BROAD four-cohort economics ===");
const broadCohorts = { BASE_BROAD: baseBroad, "+WHALE": broadWhale, "+NO_HC": broadNoHC, "+BOTH": broadBoth };
const broadMetrics = {};
for (const [n,c] of Object.entries(broadCohorts)) {
  const m = metricsOf(c); const mult = multiplicity(c);
  broadMetrics[n] = { ...m, nEff: mult.nEffective, multRatio: mult.ratio, retentionPct: baseBroad.length ? round4(c.length/baseBroad.length) : null };
}
console.log(JSON.stringify(broadMetrics, null, 2));

// ---- Section 3: Incremental uplift (BROAD) ----
console.log("\n=== Section 3: BROAD incremental uplift ===");
const baseBM = broadMetrics.BASE_BROAD;
for (const [n,m] of Object.entries(broadMetrics)) {
  const delta = (m.netAvgR!=null && baseBM.netAvgR!=null) ? round4(m.netAvgR - baseBM.netAvgR) : null;
  console.log(`${n.padEnd(12)} n=${String(m.n).padStart(3)}  ret=${m.retentionPct}  netAvgR=${m.netAvgR}  Δ=${delta}  PF=${m.PF}  WR=${m.winRate}  SL=${m.slRate}`);
}

// ---- Section 4: Route-mix decomposition for BROAD BOTH ----
console.log("\n=== Section 4: Route-mix decomposition (BROAD BOTH) ===");
const routeMap = new Map();
for (const r of broadBoth) {
  const k = `${r.outcome.selectedEntryVariant} + ${r.outcome.selectedExitVariant}`;
  const lst = routeMap.get(k) ?? [];
  lst.push(r); routeMap.set(k, lst);
}
const broadBothSumNet = sum(broadBoth.map(r=>r.outcome.realizedNetR).filter(Number.isFinite));
const routeRows = [...routeMap.entries()].map(([k,recs])=>{
  const m = metricsOf(recs);
  return { route: k, n: m.n, netAvgR: m.netAvgR, PF: m.PF, winRate: m.winRate, netSumR: m.netSumR, sharePct: broadBothSumNet ? round4(m.netSumR/broadBothSumNet) : null };
}).sort((a,b)=>b.n-a.n);
console.log(JSON.stringify(routeRows, null, 2));

// Same routes inside BASE_BROAD (for comparison — does uplift hold per-route?)
console.log("\n=== Section 4b: Per-route uplift inside BASE_BROAD (Filter=BOTH) ===");
const routeKeys = new Set([...routeMap.keys()]);
// Also include all routes in base_broad to compute base per route
const baseRouteMap = new Map();
for (const r of baseBroad) {
  const k = `${r.outcome.selectedEntryVariant} + ${r.outcome.selectedExitVariant}`;
  const lst = baseRouteMap.get(k) ?? [];
  lst.push(r); baseRouteMap.set(k, lst);
}
const perRoute = [];
for (const [route, baseRecs] of baseRouteMap.entries()) {
  const bothRecs = baseRecs.filter(r => isWhaleAgrees(r) && isNoHorizonConflict(r));
  const mb = metricsOf(baseRecs);
  const mboth = metricsOf(bothRecs);
  perRoute.push({
    route,
    base_n: mb.n,
    base_netAvgR: mb.netAvgR,
    base_PF: mb.PF,
    both_n: mboth.n,
    both_netAvgR: mboth.netAvgR,
    both_PF: mboth.PF,
    delta_netAvgR: (mb.netAvgR!=null && mboth.netAvgR!=null) ? round4(mboth.netAvgR - mb.netAvgR) : null,
  });
}
perRoute.sort((a,b)=>b.base_n-a.base_n);
console.log(JSON.stringify(perRoute, null, 2));

// ---- Section 5: STRICT vs BROAD ----
console.log("\n=== Section 5: STRICT vs BROAD comparison ===");
function row(scope, label, c, baseNet) {
  const m = metricsOf(c);
  const delta = (m.netAvgR!=null && baseNet!=null) ? round4(m.netAvgR-baseNet) : null;
  return { scope, label, n: m.n, netAvgR: m.netAvgR, PF: m.PF, delta };
}
const strictBaseNet = metricsOf(baseStrict).netAvgR;
const broadBaseNet = metricsOf(baseBroad).netAvgR;
const rows5 = [
  row("STRICT","BASE", baseStrict, strictBaseNet),
  row("STRICT","+WHALE", strictWhale, strictBaseNet),
  row("STRICT","+NO_HC", strictNoHC, strictBaseNet),
  row("STRICT","+BOTH", strictBoth, strictBaseNet),
  row("BROAD","BASE", baseBroad, broadBaseNet),
  row("BROAD","+WHALE", broadWhale, broadBaseNet),
  row("BROAD","+NO_HC", broadNoHC, broadBaseNet),
  row("BROAD","+BOTH", broadBoth, broadBaseNet),
];
console.log(JSON.stringify(rows5, null, 2));

// ---- Section 6: Recency (BROAD) ----
console.log("\n=== Section 6: BROAD recency bias ===");
function withT(arr){return arr.map(r=>({rec:r,t:new Date(r.outcome.openedAt??r.context.scanTimestamp??0).getTime()})).filter(x=>Number.isFinite(x.t)).sort((a,b)=>a.t-b.t);}
const broadT = withT(baseBroad);
const half = Math.floor(broadT.length/2);
const early = broadT.slice(0,half).map(x=>x.rec);
const late = broadT.slice(half).map(x=>x.rec);
const splitAt = broadT[half-1]?.t ? new Date(broadT[half-1].t).toISOString() : null;
console.log(`Split openedAt: ${splitAt}`);
console.log(`BASE_BROAD early (n=${early.length}):`, metricsOf(early));
console.log(`BASE_BROAD late  (n=${late.length}):`,  metricsOf(late));

// Late 2026-05-19 window: positions opened on or after 2026-05-19T00:00Z
const LATE_CUT = new Date("2026-05-19T00:00:00Z").getTime();
const lateWindow = baseBroad.filter(r => {
  const t = new Date(r.outcome.openedAt ?? 0).getTime();
  return Number.isFinite(t) && t >= LATE_CUT;
});
const nonLate = baseBroad.filter(r => {
  const t = new Date(r.outcome.openedAt ?? 0).getTime();
  return Number.isFinite(t) && t < LATE_CUT;
});
console.log(`BASE_BROAD late-2026-05-19+ (n=${lateWindow.length}):`, metricsOf(lateWindow));
console.log(`BASE_BROAD pre-2026-05-19   (n=${nonLate.length}):`, metricsOf(nonLate));

// Same split for BOTH
const bothLate = broadBoth.filter(r => {
  const t = new Date(r.outcome.openedAt ?? 0).getTime();
  return Number.isFinite(t) && t >= LATE_CUT;
});
const bothNonLate = broadBoth.filter(r => {
  const t = new Date(r.outcome.openedAt ?? 0).getTime();
  return Number.isFinite(t) && t < LATE_CUT;
});
console.log(`BROAD_BOTH late-2026-05-19+ (n=${bothLate.length}):`, metricsOf(bothLate));
console.log(`BROAD_BOTH pre-2026-05-19   (n=${bothNonLate.length}):`, metricsOf(bothNonLate));

// ---- Section 7: Symbol concentration in BROAD BOTH ----
console.log("\n=== Section 7: Symbol concentration (BROAD BOTH) ===");
const bySym = new Map();
for (const r of broadBoth) {
  const s = r.context.symbol;
  const lst = bySym.get(s) ?? []; lst.push(r); bySym.set(s, lst);
}
const symRows = [...bySym.entries()].map(([s,recs])=>{
  const m = metricsOf(recs);
  return { symbol: s, n: m.n, netAvgR: m.netAvgR, netSumR: m.netSumR, PF: m.PF, winRate: m.winRate };
}).sort((a,b)=>Math.abs(b.netSumR)-Math.abs(a.netSumR));
console.log(JSON.stringify(symRows, null, 2));
const totalNetSum = sum(symRows.map(r=>r.netSumR));
const top1Share = symRows.length ? symRows[0].netSumR/(totalNetSum||1) : null;
const top2Share = symRows.length>=2 ? sum(symRows.slice(0,2).map(r=>r.netSumR))/(totalNetSum||1) : null;
const positives = symRows.filter(r=>r.netSumR>0).length;
const negatives = symRows.filter(r=>r.netSumR<0).length;
console.log(`positive contributors: ${positives}  negative: ${negatives}  top1 share: ${round4(top1Share)}  top2 share: ${round4(top2Share)}`);

// ---- Section 8: Episode concentration (BROAD BOTH) ----
console.log("\n=== Section 8: Episode concentration (BROAD BOTH) ===");
const epMap = new Map();
nullCnt = 0;
for (const rec of broadBoth) {
  const k = episodeKey(rec);
  const lst = epMap.get(k) ?? [];
  lst.push(rec.outcome.realizedNetR);
  epMap.set(k, lst);
}
const episodeSums = [...epMap.entries()].map(([k,v])=>({k, s: sum(v.filter(Number.isFinite))})).sort((a,b)=>Math.abs(b.s)-Math.abs(a.s));
const broadBothNetSumAll = sum(broadBoth.map(r=>r.outcome.realizedNetR).filter(Number.isFinite));
console.log(`raw n: ${broadBoth.length}`);
console.log(`distinct episodes: ${epMap.size}`);
console.log(`largest episode netSumR share: ${episodeSums.length ? round4(episodeSums[0].s/(broadBothNetSumAll||1)) : null}`);
console.log(`top 3 episodes share: ${episodeSums.length ? round4(sum(episodeSums.slice(0,3).map(e=>e.s))/(broadBothNetSumAll||1)) : null}`);

// ---- Section 9: Decision-time persistence check ----
console.log("\n=== Section 9: Decision-time persistence ===");
const broadBothWithCtxFields = broadBoth.filter(r => {
  const cs = r.position.strategyContextSnapshot ?? {};
  return ("whaleAgreement" in cs) && ("horizonConflict" in cs);
});
console.log(`BROAD BOTH with persisted whaleAgreement + horizonConflict in strategyContextSnapshot: ${broadBothWithCtxFields.length}/${broadBoth.length}`);

// ---- Section 10: Phase 3.1 MFE/MAE on BROAD BOTH ----
console.log("\n=== Section 10: Phase 3.1 instrumentation (BROAD BOTH) ===");
const inst = broadBoth.filter(r => Number.isFinite(r.outcome.mfeR) && Number.isFinite(r.outcome.maeR));
const winners = inst.filter(r=>r.outcome.realizedNetR>0);
const losers = inst.filter(r=>r.outcome.realizedNetR<0);
const avg = xs => xs.length ? round4(sum(xs)/xs.length) : null;
console.log("Instrumented count:", inst.length, " / total BROAD BOTH:", broadBoth.length);
console.log("Avg MFE R (all):", avg(inst.map(r=>r.outcome.mfeR)));
console.log("Avg MAE R (all):", avg(inst.map(r=>r.outcome.maeR)));
console.log("Avg MFE R winners:", avg(winners.map(r=>r.outcome.mfeR)));
console.log("Avg MFE R losers:", avg(losers.map(r=>r.outcome.mfeR)));
console.log("Avg MAE R winners:", avg(winners.map(r=>r.outcome.maeR)));
console.log("Avg MAE R losers:", avg(losers.map(r=>r.outcome.maeR)));

// ---- Coverage on BASE_BROAD ----
console.log("\n=== Coverage on BASE_BROAD ===");
const whaleKnown = baseBroad.filter(r => r.context.whaleAgreement!=null).length;
const hcKnown = baseBroad.filter(r => r.context.horizonConflict!=null).length;
console.log(`n=${baseBroad.length}  whale coverage=${round4(whaleKnown/baseBroad.length)}  horizon coverage=${round4(hcKnown/baseBroad.length)}`);

// ---- Listing BOTH records ----
console.log("\n=== All BROAD BOTH records (id, symbol, route, openedAt, closeReason, netR) ===");
for (const r of [...broadBoth].sort((a,b)=> (a.outcome.openedAt>b.outcome.openedAt?1:-1))) {
  const route = `${r.outcome.selectedEntryVariant}+${r.outcome.selectedExitVariant}`;
  console.log(`${r.positionId}  ${String(r.context.symbol).padEnd(10)}  ${route.padEnd(40)}  ${r.outcome.openedAt}  ${String(r.outcome.closeReason).padEnd(14)}  netR=${round4(r.outcome.realizedNetR)}  whale=${r.context.whaleAgreement} hc=${r.context.horizonConflict}`);
}

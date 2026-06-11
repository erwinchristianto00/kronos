// READ-ONLY: Reconcile Section K cohort vs strict-lane audit cohort.
// Source of truth: data/shadow-positions.json

import fs from "node:fs";
import path from "node:path";

const positions = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "shadow-positions.json"), "utf8"));

function classifyEra(p) {
  const sel = p?.variantSelection ?? null;
  if (!sel) return "LEGACY_PRE_ROUTING";
  if (sel.evidenceEra) return sel.evidenceEra;
  const hasRouteMode = typeof sel.routeMode === "string" && sel.routeMode.length > 0;
  const hasCalibration = sel.calibratedExpectedNetR !== undefined || sel.calibrationVerdict !== undefined;
  if (!hasRouteMode && !hasCalibration) return "LEGACY_PRE_ROUTING";
  if (hasRouteMode && !hasCalibration) return "POST_ROUTING_PRE_CALIBRATION";
  if (hasCalibration) return "POST_CALIBRATION";
  return "UNKNOWN";
}
function normalizeRegime(v) {
  if (v == null || v === "") return null;
  const s = String(v).toUpperCase();
  if (s.includes("BULL")) return "BULLISH_EXPANSION";
  if (s.includes("BEAR")) return "BEARISH_EXPANSION";
  if (s.includes("SIDE") || s.includes("RANGE") || s.includes("CHOP")) return "SIDEWAYS";
  if (s.includes("MIX")) return "MIXED";
  return s;
}
function primaryClosed(p) {
  return p.variants.find((v) => v.variant === p.selectedExitVariant && v.state === "CLOSED")
    ?? p.variants.find((v) => v.state === "CLOSED") ?? null;
}

// ---- Era / status distribution ----
console.log(`Total positions in file: ${positions.length}`);
const eraCounts = new Map();
const statusCounts = new Map();
for (const p of positions) {
  eraCounts.set(classifyEra(p), (eraCounts.get(classifyEra(p)) ?? 0) + 1);
  statusCounts.set(p.status ?? "null", (statusCounts.get(p.status ?? "null") ?? 0) + 1);
}
console.log("Era distribution:", Object.fromEntries(eraCounts));
console.log("Status distribution:", Object.fromEntries(statusCounts));

// How many positions have a CLOSED variant?
const positionsWithClosed = positions.filter(p => primaryClosed(p));
console.log("Positions with CLOSED variant:", positionsWithClosed.length);

// How many of those have strategyContextSnapshot? (= what records buildStrategyExperienceRecords returns)
const positionsWithClosedAndCtx = positionsWithClosed.filter(p => p.strategyContextSnapshot);
console.log("Positions with CLOSED + ctxSnapshot:", positionsWithClosedAndCtx.length);

// Records used by Section K (POST_CALIBRATION era)
const postCalRecs = positionsWithClosedAndCtx.filter(p => classifyEra(p) === "POST_CALIBRATION");
console.log("POST_CALIBRATION records (Section K input):", postCalRecs.length);

// Section K "Keep only bearish expansion and short" filter
// IMPORTANT: Section K reads context.marketRegime and context.direction.
// In TS, the record's context is spread from strategyContextSnapshot.
// buildStrategyExperienceRecords does: ctx = position.strategyContextSnapshot ?? buildStrategyContextSnapshot(...).
// It does NOT override context.direction with position.direction (unlike audit script).
// Need to check both interpretations.

const dashByCtx = postCalRecs.filter(p => {
  const ctx = p.strategyContextSnapshot;
  return normalizeRegime(ctx.marketRegime) === "BEARISH_EXPANSION" && ctx.direction === "SHORT";
});
const dashByPos = postCalRecs.filter(p => {
  const ctx = p.strategyContextSnapshot;
  return normalizeRegime(ctx.marketRegime) === "BEARISH_EXPANSION" && p.direction === "SHORT";
});
console.log(`Section K (ctx.direction):       ${dashByCtx.length}`);
console.log(`Section K (position.direction):  ${dashByPos.length}`);

// Strict audit cohort
const audit = postCalRecs.filter(p => {
  const ctx = p.strategyContextSnapshot;
  const variant = primaryClosed(p);
  const exitVar = variant.variant ?? p.selectedExitVariant;
  const entryVar = p.selectedEntryVariant ?? p.variantSelection?.selectedEntryVariant ?? null;
  return normalizeRegime(ctx.marketRegime) === "BEARISH_EXPANSION" &&
         p.direction === "SHORT" &&
         entryVar === "vwap_retest_entry" &&
         exitVar === "tp1_full_exit";
});
console.log(`Strict audit cohort:             ${audit.length}`);

// Show direction agreement
let ctxMismatch = 0;
for (const p of postCalRecs) {
  if (p.strategyContextSnapshot.direction !== p.direction) ctxMismatch++;
}
console.log(`ctx.direction != position.direction count: ${ctxMismatch}`);

// Variant breakdown inside dashboard cohort (using position.direction interpretation)
const variantsInDash = new Map();
for (const p of dashByPos) {
  const variant = primaryClosed(p);
  const exitVar = variant.variant ?? p.selectedExitVariant;
  const entryVar = p.selectedEntryVariant ?? p.variantSelection?.selectedEntryVariant ?? null;
  const k = `${entryVar} + ${exitVar}`;
  variantsInDash.set(k, (variantsInDash.get(k) ?? 0) + 1);
}
console.log("\nVariant (entry+exit) breakdown inside DASHBOARD_SET (position.direction):");
for (const [k, n] of [...variantsInDash.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${k}: ${n}`);

// ID-set diff
const dashSet = new Set(dashByPos.map(p => p.id));
const auditSet = new Set(audit.map(p => p.id));
const intersection = [...dashSet].filter(id => auditSet.has(id));
const dashOnly = [...dashSet].filter(id => !auditSet.has(id));
const auditOnly = [...auditSet].filter(id => !dashSet.has(id));
console.log("\n=== ID-set comparison ===");
console.log(`Intersection:    ${intersection.length}`);
console.log(`Dashboard-only:  ${dashOnly.length}`);
console.log(`Audit-only:      ${auditOnly.length}`);
console.log(`Audit ⊆ Dashboard? ${auditOnly.length === 0}`);

// Economics
function round4(v){ if(v==null||!Number.isFinite(v)) return v; return Math.round(v*10000)/10000; }
function median(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }
function metrics(cohort){
  const recs = cohort.map(p => {
    const v = primaryClosed(p);
    return {
      realizedNetR: v.realizedNetR,
      realizedGrossR: v.realizedGrossR,
      tp1Hit: v.tp1Hit === true,
      slHit: v.closeReason === "SL" || v.closeReason === "BREAKEVEN",
    };
  });
  const n = recs.length;
  if (!n) return { n:0 };
  const nets = recs.map(r=>r.realizedNetR).filter(Number.isFinite);
  const gross = recs.map(r=>r.realizedGrossR).filter(Number.isFinite);
  const wins = nets.filter(v=>v>0), losses = nets.filter(v=>v<0);
  const winSum = wins.reduce((s,v)=>s+v,0), lossAbs = Math.abs(losses.reduce((s,v)=>s+v,0));
  return {
    n,
    grossAvgR: gross.length ? round4(gross.reduce((s,v)=>s+v,0)/gross.length) : null,
    netAvgR:   nets.length  ? round4(nets.reduce((s,v)=>s+v,0)/nets.length)   : null,
    PF: lossAbs ? round4(winSum/lossAbs) : null,
    winRate: round4(wins.length/n),
    tp1Rate: round4(recs.filter(r=>r.tp1Hit).length/n),
    slRate:  round4(recs.filter(r=>r.slHit).length/n),
    medianNetR: round4(median(nets)),
    netSumR: round4(nets.reduce((s,v)=>s+v,0)),
  };
}
console.log("\n=== Economics ===");
const dashOnlyRecs = dashByPos.filter(p => !auditSet.has(p.id));
console.log(`DASHBOARD_SET (N=${dashByPos.length}):`, metrics(dashByPos));
console.log(`AUDIT_SET     (N=${audit.length}):`, metrics(audit));
console.log(`DASHBOARD_ONLY(N=${dashOnlyRecs.length}):`, metrics(dashOnlyRecs));

// Extra slices: time-bucket concentration and dashboard reconciliation
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
function normalizeRegime(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).toUpperCase();
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
function build(p) {
  const v = primaryClosed(p);
  if (!v) return null;
  const ctx = p.strategyContextSnapshot ?? null;
  if (!ctx) return null;
  return { id: p.id, position: p, variant: v, context: { ...ctx, direction: p.direction, symbol: p.symbol, evidenceEra: ctx.evidenceEra ?? p.variantSelection?.evidenceEra ?? null }, outcome: { closeReason: v.closeReason, realizedNetR: v.realizedNetR, realizedGrossR: v.realizedGrossR, openedAt: p.entryFilledAt ?? v.openedAt ?? p.scannedAt, selectedExitVariant: v.variant, evidenceEra: p.variantSelection?.evidenceEra ?? null } };
}
const recs = positions.map(build).filter(Boolean).filter(r => (r.context.evidenceEra ?? r.outcome.evidenceEra) === "POST_CALIBRATION");

const base = recs.filter(r =>
  normalizeRegime(r.context.marketRegime) === "BEARISH_EXPANSION" &&
  r.context.direction === "SHORT" &&
  r.context.selectedEntryVariant === "vwap_retest_entry" &&
  r.outcome.selectedExitVariant === "tp1_full_exit"
);
const both = base.filter(r => r.context.whaleAgreement === "AGREES" && r.context.horizonConflict === false);

// Group BOTH by 5-minute time bucket to see episode concentration
const FIVE_MIN = 5 * 60_000;
const groups = new Map();
for (const r of both) {
  const t = new Date(r.outcome.openedAt).getTime();
  const bucket = Math.floor(t / FIVE_MIN);
  const k = `${bucket}|${r.context.symbol}`;
  const lst = groups.get(k) ?? [];
  lst.push(r);
  groups.set(k, lst);
}
const groupRows = [...groups.entries()].map(([k, lst]) => ({
  key: k,
  n: lst.length,
  symbol: lst[0].context.symbol,
  openedAt: lst[0].outcome.openedAt,
  netSum: lst.reduce((s, r) => s + (r.outcome.realizedNetR || 0), 0),
})).sort((a,b) => b.n - a.n || Math.abs(b.netSum) - Math.abs(a.netSum));
console.log("BOTH per-(5min,symbol) groups (sorted by clustering):");
console.log(JSON.stringify(groupRows, null, 2));

// Count episodes (groups) vs records
const totalEpisodes = groupRows.length;
const totalNet = groupRows.reduce((s,g)=>s+g.netSum,0);
console.log("\nDistinct 5-min episode groups:", totalEpisodes, " for", both.length, "raw records");
console.log("netSum total:", Math.round(totalNet*10000)/10000);
const topEp = groupRows[0];
console.log(`Largest single episode: ${topEp.symbol} @ ${topEp.openedAt}, n=${topEp.n}, netSum=${Math.round(topEp.netSum*10000)/10000}, share=${Math.round(topEp.netSum/totalNet*10000)/10000}`);

// Reconstruct BASE if we relax entry/exit variant — to try to reconcile with dashboard N=156
console.log("\n--- Reconciliation with dashboard N=156 ---");
const baseLooseRegimeShort = recs.filter(r =>
  normalizeRegime(r.context.marketRegime) === "BEARISH_EXPANSION" &&
  r.context.direction === "SHORT"
);
console.log("regime+short only (no variant filter):", baseLooseRegimeShort.length);
const variantCombos = new Map();
for (const r of baseLooseRegimeShort) {
  const k = `${r.context.selectedEntryVariant} + ${r.outcome.selectedExitVariant}`;
  variantCombos.set(k, (variantCombos.get(k) ?? 0) + 1);
}
console.log("variant breakdown in BEARISH+SHORT:");
for (const [k, n] of [...variantCombos.entries()].sort((a,b) => b[1]-a[1])) console.log("  ", k, ":", n);

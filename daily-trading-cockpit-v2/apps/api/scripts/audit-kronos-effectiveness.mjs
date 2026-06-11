// READ-ONLY: Audit Kronos predictive value on POST_CALIBRATION resolved trades.
// Source: data/shadow-positions.json (relative to repo root)

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const dataPath = path.join(repoRoot, "data", "shadow-positions.json");
const positions = JSON.parse(fs.readFileSync(dataPath, "utf8"));

function normalizeRegime(v) {
  if (v == null || v === "") return null;
  const s = String(v).toUpperCase();
  if (s.includes("BULL")) return "BULLISH_EXPANSION";
  if (s.includes("BEAR")) return "BEARISH_EXPANSION";
  if (s.includes("SIDE") || s.includes("RANGE") || s.includes("CHOP")) return "SIDEWAYS";
  if (s.includes("MIX")) return "MIXED";
  return s;
}
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
function primaryClosed(p) {
  return (p.variants ?? []).find((v) => v.variant === p.selectedExitVariant && v.state === "CLOSED")
    ?? (p.variants ?? []).find((v) => v.state === "CLOSED") ?? null;
}

// Build flat record list: POST_CAL + has ctxSnapshot + has CLOSED variant + realizedNetR finite.
const recs = [];
for (const p of positions) {
  if (classifyEra(p) !== "POST_CALIBRATION") continue;
  const ctx = p.strategyContextSnapshot;
  if (!ctx) continue;
  const v = primaryClosed(p);
  if (!v) continue;
  if (!Number.isFinite(v.realizedNetR)) continue;
  const entryVar = p.selectedEntryVariant ?? p.variantSelection?.selectedEntryVariant ?? null;
  const exitVar = v.variant ?? p.selectedExitVariant ?? null;
  recs.push({
    id: p.id,
    symbol: p.symbol ?? ctx.symbol ?? null,
    direction: p.direction ?? ctx.direction,
    openedAt: p.openedAt ?? ctx.openedAt ?? v.openedAt ?? null,
    entryVar,
    exitVar,
    regime: normalizeRegime(ctx.marketRegime),
    selectedKronosBias: ctx.selectedKronosBias ?? null,
    kronosBias1h: ctx.kronosBias1h ?? null,
    kronosConfidenceBucket: ctx.kronosConfidenceBucket ?? null,
    horizonConflict: ctx.horizonConflict ?? null,
    whaleAgreement: ctx.whaleAgreement ?? null,
    directionalAlignmentLabel: ctx.directionalAlignmentLabel ?? null,
    realizedNetR: v.realizedNetR,
    closeReason: v.closeReason ?? null,
  });
}

// Reconstructed sourceConflict per evidence-consensus.ts deriveSourceConflict
function reconSourceConflict(r) {
  const bias = r.selectedKronosBias ?? r.kronosBias1h;
  const whale = r.whaleAgreement;
  if (!bias || !whale || bias === "UNAVAILABLE" || whale === "UNAVAILABLE") return null;
  const kronosAligned = bias === r.direction;
  const whaleAligned = whale === "AGREES";
  return kronosAligned !== whaleAligned;
}
for (const r of recs) r.sourceConflict = reconSourceConflict(r);

function round4(v){ if(v==null||!Number.isFinite(v)) return null; return Math.round(v*10000)/10000; }
function round2(v){ if(v==null||!Number.isFinite(v)) return null; return Math.round(v*100)/100; }
function metrics(arr) {
  const n = arr.length;
  if (!n) return { n:0, netAvgR:null, PF:null, WR:null, slRate:null };
  const nets = arr.map(r=>r.realizedNetR);
  const wins = nets.filter(v=>v>0);
  const losses = nets.filter(v=>v<0);
  const sl = arr.filter(r => r.closeReason === "SL" || r.closeReason === "BREAKEVEN" || r.realizedNetR <= -0.5);
  const winSum = wins.reduce((s,v)=>s+v,0);
  const lossAbs = Math.abs(losses.reduce((s,v)=>s+v,0));
  return {
    n,
    netAvgR: round4(nets.reduce((s,v)=>s+v,0)/n),
    PF: lossAbs > 0 ? round2(winSum/lossAbs) : null,
    WR: Math.round(100*wins.length/n),
    slRate: Math.round(100*sl.length/n),
  };
}

// ============================================================
// COHORTS
// ============================================================
const ALL = recs;
const CORE = ALL.filter(r => r.regime === "BEARISH_EXPANSION" && r.direction === "SHORT" && r.entryVar === "vwap_retest_entry" && r.exitVar === "tp1_full_exit");
const CORE_WHALE = CORE.filter(r => r.whaleAgreement === "AGREES");
const CORE_WHALE_NOHC = CORE_WHALE.filter(r => r.horizonConflict === false);

// Coverage helper
function withKronos(arr){ return arr.filter(r => r.selectedKronosBias && r.selectedKronosBias !== "UNAVAILABLE"); }

console.log(`# Kronos Effectiveness Audit\n`);
console.log(`- Total POST_CAL resolved records: **${ALL.length}**`);
const kCov = withKronos(ALL).length;
console.log(`- Kronos coverage (selectedKronosBias populated): **${kCov} (${(100*kCov/ALL.length).toFixed(2)}%)**`);
console.log(`- Core cohort (BEAR+SHORT+vwap_retest+tp1_full): **${CORE.length}**`);
console.log(`- Core + WHALE_AGREES: **${CORE_WHALE.length}**`);
console.log(`- Core + WHALE_AGREES + NO_HC: **${CORE_WHALE_NOHC.length}**\n`);

// ============================================================
// A. Coverage table
// ============================================================
console.log(`## A. Coverage\n`);
console.log(`| Cohort | Total n | With Kronos | Coverage % |`);
console.log(`|---|---:|---:|---:|`);
for (const [label, arr] of [
  ["ALL POST_CAL resolved", ALL],
  ["BEAR+SHORT+vwap_retest+tp1_full (core)", CORE],
  ["Core + WHALE_AGREES", CORE_WHALE],
  ["Core + WHALE_AGREES + NO_HC", CORE_WHALE_NOHC],
]) {
  const k = withKronos(arr).length;
  console.log(`| ${label} | ${arr.length} | ${k} | ${arr.length ? (100*k/arr.length).toFixed(2) : "0.00"}% |`);
}

// ============================================================
// B. Direct Kronos signal economics
// ============================================================
function reportSplits(label, base) {
  const baseM = metrics(base);
  console.log(`\n### ${label} (baseline n=${baseM.n}, netAvgR=${baseM.netAvgR}, PF=${baseM.PF}, WR=${baseM.WR}%)\n`);
  console.log(`| Kronos condition | n | netAvgR | PF | WR% | ΔnetAvgR vs baseline |`);
  console.log(`|---|---:|---:|---:|---:|---:|`);
  const splits = [
    ["Kronos aligned (bias==direction)", base.filter(r => r.selectedKronosBias && r.selectedKronosBias !== "UNAVAILABLE" && r.selectedKronosBias === r.direction)],
    ["Kronos opposed (bias opposite direction)", base.filter(r => r.selectedKronosBias && r.selectedKronosBias !== "UNAVAILABLE" && r.selectedKronosBias !== "NEUTRAL" && r.selectedKronosBias !== r.direction)],
    ["Kronos NEUTRAL/null/UNAVAILABLE", base.filter(r => !r.selectedKronosBias || r.selectedKronosBias === "NEUTRAL" || r.selectedKronosBias === "UNAVAILABLE")],
    ["Confidence STRONG", base.filter(r => r.kronosConfidenceBucket === "STRONG")],
    ["Confidence MEDIUM", base.filter(r => r.kronosConfidenceBucket === "MEDIUM")],
    ["Confidence WEAK", base.filter(r => r.kronosConfidenceBucket === "WEAK")],
  ];
  for (const [name, arr] of splits) {
    const m = metrics(arr);
    if (m.n < 10) { console.log(`| ${name} | ${m.n} | n<10 | – | – | – |`); continue; }
    const delta = (m.netAvgR != null && baseM.netAvgR != null) ? round4(m.netAvgR - baseM.netAvgR) : null;
    console.log(`| ${name} | ${m.n} | ${m.netAvgR} | ${m.PF} | ${m.WR}% | ${delta} |`);
  }
}
console.log(`\n## B. Direct Kronos signal economics`);
reportSplits("Full POST_CAL universe", ALL);
reportSplits("BEAR+SHORT core cohort", CORE);

// ============================================================
// C. HorizonConflict economics
// ============================================================
console.log(`\n## C. HorizonConflict economics\n`);
console.log(`| Cohort | horizonConflict | n | netAvgR | PF | WR% | Δ vs cohort baseline |`);
console.log(`|---|---|---:|---:|---:|---:|---:|`);
for (const [label, base] of [["ALL POST_CAL", ALL], ["Core (BEAR+SHORT)", CORE], ["Core + WHALE_AGREES", CORE_WHALE]]) {
  const baseM = metrics(base);
  for (const flag of [true, false, null]) {
    const arr = base.filter(r => r.horizonConflict === flag);
    const m = metrics(arr);
    const tag = flag === null ? "null/unknown" : String(flag);
    if (m.n < 10) { console.log(`| ${label} | ${tag} | ${m.n} | n<10 | – | – | – |`); continue; }
    const delta = (m.netAvgR != null && baseM.netAvgR != null) ? round4(m.netAvgR - baseM.netAvgR) : null;
    console.log(`| ${label} | ${tag} | ${m.n} | ${m.netAvgR} | ${m.PF} | ${m.WR}% | ${delta} |`);
  }
}

// ============================================================
// D. SourceConflict economics (reconstructed)
// ============================================================
console.log(`\n## D. SourceConflict economics (reconstructed from selectedKronosBias vs whaleAgreement+direction)\n`);
const TREND_ALIGNED = ALL.filter(r => r.directionalAlignmentLabel === "ALIGNED");
console.log(`| Cohort | sourceConflict | n | netAvgR | PF | WR% | Δ vs cohort baseline |`);
console.log(`|---|---|---:|---:|---:|---:|---:|`);
for (const [label, base] of [["ALL POST_CAL", ALL], ["Core (BEAR+SHORT)", CORE], ["TREND_ALIGNED", TREND_ALIGNED], ["Core + WHALE_AGREES", CORE_WHALE]]) {
  const baseM = metrics(base);
  for (const flag of [true, false, null]) {
    const arr = base.filter(r => r.sourceConflict === flag);
    const m = metrics(arr);
    const tag = flag === null ? "null/unknown" : String(flag);
    if (m.n < 10) { console.log(`| ${label} | ${tag} | ${m.n} | n<10 | – | – | – |`); continue; }
    const delta = (m.netAvgR != null && baseM.netAvgR != null) ? round4(m.netAvgR - baseM.netAvgR) : null;
    console.log(`| ${label} | ${tag} | ${m.n} | ${m.netAvgR} | ${m.PF} | ${m.WR}% | ${delta} |`);
  }
}

// ============================================================
// E. Incremental value ladder on CORE
// ============================================================
console.log(`\n## E. Incremental value ladder (Core BEAR+SHORT cohort, n=${CORE.length})\n`);
console.log(`| # | Condition | n | netAvgR | PF | Δ vs parent |`);
console.log(`|---:|---|---:|---:|---:|---:|`);
const ladder = [
  { k: "1", label: "TREND_ALIGNED", arr: CORE.filter(r => r.directionalAlignmentLabel === "ALIGNED"), parent: CORE },
  { k: "2", label: "TREND_ALIGNED + NO_HC", arr: CORE.filter(r => r.directionalAlignmentLabel === "ALIGNED" && r.horizonConflict === false), parentLabel: "row1" },
  { k: "3", label: "TREND_ALIGNED + sourceConflict=false", arr: CORE.filter(r => r.directionalAlignmentLabel === "ALIGNED" && r.sourceConflict === false), parentLabel: "row1" },
  { k: "4", label: "WHALE_AGREES", arr: CORE_WHALE, parent: CORE },
  { k: "5", label: "WHALE_AGREES + NO_HC", arr: CORE_WHALE.filter(r => r.horizonConflict === false), parentLabel: "row4" },
  { k: "6", label: "WHALE_AGREES + sourceConflict=false", arr: CORE_WHALE.filter(r => r.sourceConflict === false), parentLabel: "row4" },
  { k: "7", label: "WHALE_AGREES + TREND_ALIGNED", arr: CORE_WHALE.filter(r => r.directionalAlignmentLabel === "ALIGNED"), parent: CORE_WHALE },
  { k: "8", label: "WHALE_AGREES + TREND_ALIGNED + NO_HC", arr: CORE_WHALE.filter(r => r.directionalAlignmentLabel === "ALIGNED" && r.horizonConflict === false), parentLabel: "row7" },
];
const rowM = {};
for (const row of ladder) {
  const m = metrics(row.arr);
  rowM[row.k] = m;
  let parentMetrics = null;
  if (row.parent) parentMetrics = metrics(row.parent);
  else if (row.parentLabel === "row1") parentMetrics = rowM["1"];
  else if (row.parentLabel === "row4") parentMetrics = rowM["4"];
  else if (row.parentLabel === "row7") parentMetrics = rowM["7"];
  if (m.n < 10) { console.log(`| ${row.k} | ${row.label} | ${m.n} | n<10 | – | – |`); continue; }
  const delta = (m.netAvgR != null && parentMetrics?.netAvgR != null) ? round4(m.netAvgR - parentMetrics.netAvgR) : null;
  console.log(`| ${row.k} | ${row.label} | ${m.n} | ${m.netAvgR} | ${m.PF} | ${delta} |`);
}

// ============================================================
// F. Veto vs selector
// ============================================================
console.log(`\n## F. Veto vs selector check (Core BEAR+SHORT cohort)\n`);
console.log(`| Signal | n_true(downside?) | netAvgR_true | n_false(upside?) | netAvgR_false | |Δ| true vs false |`);
console.log(`|---|---:|---:|---:|---:|---:|`);
function vetoRow(name, predTrue, predFalse, base) {
  const aT = base.filter(predTrue); const aF = base.filter(predFalse);
  const mT = metrics(aT); const mF = metrics(aF);
  const delta = (mT.netAvgR != null && mF.netAvgR != null) ? round4(Math.abs(mT.netAvgR - mF.netAvgR)) : null;
  const showT = mT.n < 10 ? `n=${mT.n}` : mT.netAvgR;
  const showF = mF.n < 10 ? `n=${mF.n}` : mF.netAvgR;
  console.log(`| ${name} | ${mT.n} | ${showT} | ${mF.n} | ${showF} | ${delta} |`);
}
vetoRow("horizonConflict (true downside / false upside)", r=>r.horizonConflict===true, r=>r.horizonConflict===false, CORE);
vetoRow("sourceConflict",
  r=>r.sourceConflict===true, r=>r.sourceConflict===false, CORE);
vetoRow("Kronos opposed (true) / aligned (false)",
  r=>r.selectedKronosBias && r.selectedKronosBias !== "UNAVAILABLE" && r.selectedKronosBias !== "NEUTRAL" && r.selectedKronosBias !== r.direction,
  r=>r.selectedKronosBias && r.selectedKronosBias !== "UNAVAILABLE" && r.selectedKronosBias === r.direction,
  CORE);

// ============================================================
// G. Temporal stability
// ============================================================
console.log(`\n## G. Temporal stability\n`);
function temporalSplit(label, arr) {
  if (arr.length < 10) { console.log(`| ${label} | (n=${arr.length}, skip) | – | – | – | – |`); return; }
  const sorted = [...arr].filter(r => r.openedAt).sort((a,b)=>new Date(a.openedAt) - new Date(b.openedAt));
  const mid = Math.floor(sorted.length/2);
  const early = sorted.slice(0, mid);
  const late = sorted.slice(mid);
  const eM = metrics(early); const lM = metrics(late);
  let verdict = "stable";
  if (eM.netAvgR != null && lM.netAvgR != null) {
    const drift = lM.netAvgR - eM.netAvgR;
    if (Math.abs(drift) > 0.3) verdict = drift > 0 ? `improving (+${round4(drift)})` : `degrading (${round4(drift)})`;
    else verdict = `stable (Δ=${round4(drift)})`;
  }
  console.log(`| ${label} | ${eM.n} | ${eM.netAvgR} | ${lM.n} | ${lM.netAvgR} | ${verdict} |`);
}
console.log(`| Signal | Early n | Early netAvgR | Late n | Late netAvgR | Verdict |`);
console.log(`|---|---:|---:|---:|---:|---|`);
temporalSplit("Core + WHALE_AGREES + NO_HC", CORE_WHALE_NOHC);
temporalSplit("Core + TREND_ALIGNED + sourceConflict=false", CORE.filter(r => r.directionalAlignmentLabel === "ALIGNED" && r.sourceConflict === false));
temporalSplit("Core + WHALE_AGREES + TREND_ALIGNED", CORE_WHALE.filter(r => r.directionalAlignmentLabel === "ALIGNED"));

// ============================================================
// H. Symbol concentration
// ============================================================
console.log(`\n## H. Symbol concentration (positive netSumR contribution)\n`);
function symbolConc(label, arr) {
  const bySym = new Map();
  for (const r of arr) bySym.set(r.symbol, (bySym.get(r.symbol) ?? 0) + r.realizedNetR);
  const positive = [...bySym.entries()].filter(([_,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const posSum = positive.reduce((s,[_,v])=>s+v, 0);
  const top1 = positive[0]; const top2 = positive[1];
  const top1Share = posSum>0 && top1 ? Math.round(100*top1[1]/posSum) : 0;
  const top2Share = posSum>0 && top1 && top2 ? Math.round(100*(top1[1]+top2[1])/posSum) : top1Share;
  console.log(`| ${label} | ${arr.length} | ${[...bySym.keys()].length} | ${top1?`${top1[0]} (${round4(top1[1])})`:"–"} | ${top1Share}% | ${top2?`+${top2[0]}`:""} ${top2Share}% |`);
}
console.log(`| Signal | n trades | unique symbols | Top-1 (sym, netSumR) | Top-1 % of positive netSum | Top-2 cumul. % |`);
console.log(`|---|---:|---:|---|---:|---:|`);
symbolConc("Core + WHALE_AGREES + NO_HC", CORE_WHALE_NOHC);
symbolConc("Core + TREND_ALIGNED + sourceConflict=false", CORE.filter(r => r.directionalAlignmentLabel === "ALIGNED" && r.sourceConflict === false));
symbolConc("Core + WHALE_AGREES + TREND_ALIGNED", CORE_WHALE.filter(r => r.directionalAlignmentLabel === "ALIGNED"));

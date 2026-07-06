// Episode-collapsed view: each (symbol, 5-min openedAt) becomes 1 average,
// to remove duplicate "same scan tick" multiplicity bias.
import fs from "node:fs";
import path from "node:path";
const positions = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "shadow-positions.json"), "utf8"));
function classifyEra(p){const sel=p?.variantSelection??null;if(!sel)return"LEGACY_PRE_ROUTING";if(sel.evidenceEra)return sel.evidenceEra;const hasRouteMode=typeof sel.routeMode==="string"&&sel.routeMode.length>0;const hasCalibration=sel.calibratedExpectedNetR!==undefined||sel.calibrationVerdict!==undefined;if(!hasRouteMode&&!hasCalibration)return"LEGACY_PRE_ROUTING";if(hasRouteMode&&!hasCalibration)return"POST_ROUTING_PRE_CALIBRATION";if(hasCalibration)return"POST_CALIBRATION";return"UNKNOWN";}
function normalizeRegime(v){if(v==null||v==="")return null;const s=String(v).toUpperCase();if(s.includes("BULL"))return"BULLISH_EXPANSION";if(s.includes("BEAR"))return"BEARISH_EXPANSION";if(s.includes("SIDE")||s.includes("RANGE")||s.includes("CHOP"))return"SIDEWAYS";if(s.includes("MIX"))return"MIXED";return s;}
function primaryClosed(p){return p.variants.find((v)=>v.variant===p.selectedExitVariant&&v.state==="CLOSED")??p.variants.find((v)=>v.state==="CLOSED")??null;}
// context.direction is NOT overridden with position.direction — matches production's
// buildStrategyExperienceRecords (packages/shared/src/strategy-intelligence.ts), which
// spreads strategyContextSnapshot verbatim.
function build(p){const v=primaryClosed(p);if(!v)return null;const ctx=p.strategyContextSnapshot??null;if(!ctx)return null;return{id:p.id,context:{...ctx,symbol:p.symbol,evidenceEra:ctx.evidenceEra??p.variantSelection?.evidenceEra??null},outcome:{closeReason:v.closeReason,realizedNetR:v.realizedNetR,realizedGrossR:v.realizedGrossR,openedAt:p.entryFilledAt??v.openedAt??p.scannedAt,selectedExitVariant:v.variant,evidenceEra:p.variantSelection?.evidenceEra??null}};}
const recs=positions.map(build).filter(Boolean).filter(r=>(r.context.evidenceEra??r.outcome.evidenceEra)==="POST_CALIBRATION");
const base=recs.filter(r=>normalizeRegime(r.context.marketRegime)==="BEARISH_EXPANSION"&&r.context.direction==="SHORT"&&r.context.selectedEntryVariant==="vwap_retest_entry"&&r.outcome.selectedExitVariant==="tp1_full_exit");

function collapse(cohort, bucketMs){
  const m = new Map();
  for(const r of cohort){
    const t = new Date(r.outcome.openedAt).getTime();
    const k = `${r.context.symbol}|${Math.floor(t/bucketMs)}`;
    const lst = m.get(k) ?? [];
    lst.push(r.outcome.realizedNetR);
    m.set(k, lst);
  }
  const reps = [];
  for(const [k, lst] of m){
    const avg = lst.reduce((s,v)=>s+v,0)/lst.length;
    reps.push({k, n: lst.length, avgNet: avg});
  }
  return reps;
}
function summarize(reps, label){
  const nets = reps.map(x=>x.avgNet);
  const wins = nets.filter(v=>v>0); const losses = nets.filter(v=>v<0);
  const sum = nets.reduce((s,v)=>s+v,0);
  const lossAbs = Math.abs(losses.reduce((s,v)=>s+v,0));
  const winSum = wins.reduce((s,v)=>s+v,0);
  const sorted = [...nets].sort((a,b)=>a-b);
  const med = sorted.length ? (sorted.length%2 ? sorted[Math.floor(sorted.length/2)] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2) : null;
  console.log(`${label}: nEpisodes=${reps.length}  netAvgR(epi)=${reps.length?(sum/reps.length).toFixed(4):"n/a"}  PF=${lossAbs?(winSum/lossAbs).toFixed(3):"n/a"}  WR=${reps.length?(wins.length/reps.length).toFixed(3):"n/a"}  median=${med?.toFixed(4)}  sum=${sum.toFixed(4)}`);
}
const FIVE_MIN = 5*60_000;
const FIFTEEN_MIN = 15*60_000;
const ONE_HOUR = 60*60_000;
for(const [label, ms] of [["5min",FIVE_MIN],["15min",FIFTEEN_MIN],["1h",ONE_HOUR]]){
  console.log(`\n--- Episode collapse @ ${label} (one rep per symbol per bucket) ---`);
  summarize(collapse(base, ms), "BASE              ");
  summarize(collapse(base.filter(r=>r.context.whaleAgreement==="AGREES"), ms), "BASE+WHALE        ");
  summarize(collapse(base.filter(r=>r.context.horizonConflict===false), ms), "BASE+NO_HC        ");
  summarize(collapse(base.filter(r=>r.context.whaleAgreement==="AGREES"&&r.context.horizonConflict===false), ms), "BASE+BOTH         ");
}

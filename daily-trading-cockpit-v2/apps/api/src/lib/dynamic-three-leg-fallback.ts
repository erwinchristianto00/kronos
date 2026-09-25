import { THREE_LEG_BALANCED_POLICY, THREE_LEG_BALANCED_LIMITS, assessBalancedThreeLegSymbol, type BalancedSymbolQuality } from "./three-leg-balanced-quality.js";
import { createHash } from "node:crypto";
import type { Candle } from "@dtc/shared";
import { THREE_LEG_QUALITY_POLICY, THREE_LEG_QUALITY_LIMITS, assessThreeLegSymbol, threeLegPortfolioQuality, type SymbolQuality } from "./three-leg-symbol-quality.js";
import { getCanonicalMarketRegimeSnapshot } from "./canonical-market-regime-engine.js";
import { selectDynamicMom36Legs, type DynamicMom36Formation, type DynamicMom36Allocation } from "./dynamic-mom36-shock-strategy.js";

export const THREE_LEG_POLICY = "testnet-three-leg-trend-fallback-v1" as const;
export type ThreeLegContext = {
  enabled: boolean; venue: string; nowMs: number; qualityV2?: boolean; qualityV3?: boolean;
  regime: { atMs: number; projection: string; status: string; coverageStatus: string; panic?: boolean; highStress?: boolean; lowCoverage?: boolean };
};
export type ThreeLegAudit = {
  policyId: typeof THREE_LEG_POLICY | typeof THREE_LEG_QUALITY_POLICY | typeof THREE_LEG_BALANCED_POLICY; allowed: boolean; reason: string;
  direction: "LONG" | "SHORT" | null; oppositeAlignedCount: number;
  slowBreadth: number; fastBreadth: number; hourBreadth: number;
  regime: ThreeLegContext["regime"]; checkedAtMs: number;
  quality?: { cutoffMs: number; candidates: SymbolQuality[]; portfolio: ReturnType<typeof threeLegPortfolioQuality> | null;
    rejectedCombinations: Record<string,number>; limits: typeof THREE_LEG_QUALITY_LIMITS | typeof THREE_LEG_BALANCED_LIMITS; seal: string };
  selectedSymbols: string[]; expectedLegCount: 3; legNotionalUsd: 25;
};
export function threeLegRuntimeContext(nowMs: number, env: NodeJS.ProcessEnv = process.env): ThreeLegContext {
  const enabled = env.CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK === "1";
  const regime = enabled ? getCanonicalMarketRegimeSnapshot("data", nowMs, env) : null;
  return { enabled, qualityV3: env.CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V3 === "1", qualityV2: env.CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V2 === "1", venue: env.LIVE_BINANCE_ENV ?? "mainnet", nowMs,
    regime: { atMs: regime?.atMs ?? 0, projection: regime?.projection ?? "MIXED",
      status: regime?.status ?? "MISSING", coverageStatus: regime?.coverage.status ?? "INVALID", panic: regime?.overlays?.panic, highStress: regime?.overlays?.highStress, lowCoverage: regime?.overlays?.lowCoverage } };
}
export function threeLegRegimeReason(context: ThreeLegContext, direction: "LONG" | "SHORT", policyId: string = THREE_LEG_POLICY): string | null {
  if (!context.enabled || context.venue !== "testnet") return "THREE_LEG_TESTNET_ONLY_DISABLED";
  if (context.regime.status !== "VALID" || context.regime.coverageStatus !== "VALID"
    || !Number.isFinite(context.regime.atMs) || context.regime.atMs > context.nowMs
    || context.nowMs - context.regime.atMs > 20 * 60_000) return "THREE_LEG_REGIME_UNAVAILABLE_OR_STALE";
  if (policyId === THREE_LEG_QUALITY_POLICY || policyId === THREE_LEG_BALANCED_POLICY) {
    if (policyId === THREE_LEG_BALANCED_POLICY && !context.qualityV3) return "THREE_LEG_QUALITY_V3_DISABLED";
    if (!context.qualityV2) return "THREE_LEG_QUALITY_V2_DISABLED";
    const r = context.regime;
    if (![r.panic,r.highStress,r.lowCoverage].every(v=>typeof v === "boolean")) return "THREE_LEG_REGIME_OVERLAYS_UNAVAILABLE";
    if (r.panic || r.highStress || r.lowCoverage) return "THREE_LEG_PANIC_STRESS_OR_BAD_DATA";
    if (r.projection === "MIXED") return null;
  }
  if (context.regime.projection !== (direction === "LONG" ? "BULLISH" : "BEARISH")) return "THREE_LEG_REGIME_MIXED_OR_OPPOSITE";
  return null;
}
/** Explicit frozen contract. All other baskets retain their historical six-leg invariant. */
export function dynamicExpectedLegCount(value: { finalAllocation: DynamicMom36Allocation; threeLegFallback?: ThreeLegAudit }): number {
  const a = value.finalAllocation, p = value.threeLegFallback;
  return p && [THREE_LEG_POLICY,THREE_LEG_QUALITY_POLICY,THREE_LEG_BALANCED_POLICY].includes(p.policyId) && p.allowed && p.expectedLegCount === 3
    && (a.longCount === 3 && a.shortCount === 0 && a.label === "3L0S" && p.direction === "LONG"
      || a.longCount === 0 && a.shortCount === 3 && a.label === "0L3S" && p.direction === "SHORT") ? 3 : 6;
}
export function buildThreeLegFallback(baseline: DynamicMom36Formation, context: ThreeLegContext, maxPerCluster: number, candlesBySymbol?: Readonly<Record<string,readonly Candle[]>>, cutoffMs = context.nowMs): { formation: DynamicMom36Formation; audit: ThreeLegAudit } {
  const rows = baseline.activeUniverse;
  const aligned = (side: number) => rows.filter(r => side * r.mom36 > 0 && Number.isFinite(r.fastReturn) && side * r.fastReturn! > 0);
  const longs = aligned(1), shorts = aligned(-1);
  const direction = shorts.length === 0 && longs.length >= 3 ? "LONG" : longs.length === 0 && shorts.length >= 3 ? "SHORT" : null;
  const sign = direction === "SHORT" ? -1 : 1;
  const audit: ThreeLegAudit = { policyId: context.qualityV3 ? THREE_LEG_BALANCED_POLICY : context.qualityV2 ? THREE_LEG_QUALITY_POLICY : THREE_LEG_POLICY, allowed: false, reason: "THREE_LEG_NO_EMPTY_OPPOSITE_SIDE", direction,
    oppositeAlignedCount: direction === "SHORT" ? longs.length : shorts.length,
    slowBreadth: rows.filter(r => sign*r.mom36>0).length / Math.max(1,rows.length),
    fastBreadth: rows.filter(r => Number.isFinite(r.fastReturn) && sign*r.fastReturn!>0).length / Math.max(1,rows.length),
    hourBreadth: rows.filter(r => Number.isFinite(r.oneHourReturn) && sign*r.oneHourReturn!>0).length / Math.max(1,rows.length),
    regime: context.regime, checkedAtMs: context.nowMs, selectedSymbols: [], expectedLegCount: 3, legNotionalUsd: 25 };
  const reject = (reason: string) => { audit.reason=reason; return { formation:baseline, audit }; };
  if (!context.enabled || context.venue !== "testnet") return reject("THREE_LEG_TESTNET_ONLY_DISABLED");
  if (!direction) return reject(audit.reason);
  const regimeReason = threeLegRegimeReason(context,direction,audit.policyId); if(regimeReason) return reject(regimeReason);
  // Missing opposite-side evidence must not be mistaken for an empty side.
  if (rows.length < 6 || rows.some(r => !Number.isFinite(r.mom36) || !Number.isFinite(r.fastReturn) || !Number.isFinite(r.oneHourReturn) || r.slowFastDataValid === false)) return reject("THREE_LEG_INCOMPLETE_UNIVERSE_DATA");
  if (context.qualityV2 || context.qualityV3) return buildQualityFallback(baseline, context, audit, maxPerCluster, candlesBySymbol, cutoffMs);
  if (audit.slowBreadth < .8 || audit.fastBreadth < .7 || audit.hourBreadth < .6) return reject("THREE_LEG_FAST_BREADTH_WEAK_OR_REVERSING");
  const c=baseline.continuation;
  if (!c?.available || c.decision !== (direction === "LONG" ? "CONFIRM_LONG" : "CONFIRM_SHORT")
    || c.topPath !== (direction === "LONG" ? "PERSISTENT_UP" : "PERSISTENT_DOWN")
    || c.featureAtMs === null || !Number.isFinite(c.featureAtMs) || c.featureAtMs > context.nowMs
    || context.nowMs-c.featureAtMs > 65*60_000) return reject("THREE_LEG_CONTINUATION_UNCONFIRMED_OR_TRANSITION");
  const allocation: DynamicMom36Allocation = direction === "LONG" ? {longCount:3,shortCount:0,label:"3L0S"} : {longCount:0,shortCount:3,label:"0L3S"};
  // Require positive last completed hour on each leg; preserve every original strict/cluster guard.
  const eligibleRows=rows.map(r => ({...r,
    longEligible:r.longEligible && sign*r.oneHourReturn!>0,
    shortEligible:r.shortEligible && sign*r.oneHourReturn!>0 }));
  const selection=selectDynamicMom36Legs(eligibleRows,allocation,maxPerCluster,{slowFastApplied:true});
  if(selection.insufficientReason) return reject("THREE_LEG_INSUFFICIENT_FRESH_STRICT_LEGS");
  audit.selectedSymbols=[...selection.selectedLongs,...selection.selectedShorts].map(r=>r.symbol);
  audit.allowed=true; audit.reason="THREE_LEG_ADMISSION_PASSED";
  return {audit,formation:{...baseline,preference:null,requestedAllocation:allocation,finalAllocation:allocation,
    selection,selectionSource:"STRICT_SLOW_FAST",threeLegFallback:audit}};
}

export function threeLegQualitySeal(audit: ThreeLegAudit): string {
  const q=audit.quality;
  return createHash("sha256").update(JSON.stringify({direction:audit.direction,selectedSymbols:audit.selectedSymbols,
    quality:q ? {...q,seal:undefined} : null})).digest("hex");
}
export function validThreeLegQualityAudit(audit:ThreeLegAudit):boolean {
  if(audit.policyId!==THREE_LEG_QUALITY_POLICY && audit.policyId!==THREE_LEG_BALANCED_POLICY)return true;
  const balanced=audit.policyId===THREE_LEG_BALANCED_POLICY;
  const q=audit.quality;
  if(!q || q.seal!==threeLegQualitySeal(audit) || !q.portfolio?.allowed || audit.selectedSymbols.length!==3
    || JSON.stringify(q.limits)!==JSON.stringify(balanced ? THREE_LEG_BALANCED_LIMITS : THREE_LEG_QUALITY_LIMITS)) return false;
  const selected=audit.selectedSymbols.map(s=>q.candidates.find(c=>c.symbol===s));
  return selected.every(c=>c?.allowed && c.direction===audit.direction && c.cutoffMs===q.cutoffMs && (!balanced || (c as BalancedSymbolQuality).profileId===THREE_LEG_BALANCED_POLICY))
    && threeLegPortfolioQuality(selected as SymbolQuality[]).allowed;
}
function buildQualityFallback(baseline:DynamicMom36Formation, context:ThreeLegContext, audit:ThreeLegAudit,
  maxPerCluster:number, candlesBySymbol:Readonly<Record<string,readonly Candle[]>>|undefined, cutoffMs:number):{formation:DynamicMom36Formation;audit:ThreeLegAudit} {
  const reject=(reason:string)=>{audit.reason=reason;return {formation:baseline,audit};};
  const direction=audit.direction!,sign=direction==="LONG"?1:-1;
  const c=baseline.continuation;
  if(!c?.available || c.featureAtMs===null || !Number.isFinite(c.featureAtMs) || c.featureAtMs>context.nowMs || context.nowMs-c.featureAtMs>65*60_000)
    return reject("THREE_LEG_CONTINUATION_UNAVAILABLE_OR_STALE");
  if(c.decision===(direction==="LONG"?"CONFIRM_SHORT":"CONFIRM_LONG") || c.topPath===(direction==="LONG"?"PERSISTENT_DOWN":"PERSISTENT_UP")
    || c.reversalRiskBand==="HIGH" || c.topPath==="UP_THEN_REVERSAL" || c.topPath==="DOWN_THEN_REVERSAL")return reject("THREE_LEG_CONTINUATION_REVERSAL");
  const canonical=[...baseline.activeUniverse].sort((a,b)=>sign*(b.mom36-a.mom36)||a.symbol.localeCompare(b.symbol));
  const rows=canonical.filter(r=>sign*r.mom36>0 && sign*(r.fastReturn??0)>0
    && (direction==="LONG"?r.longEligible:r.shortEligible)).sort((a,b)=>sign*(b.mom36-a.mom36)||a.symbol.localeCompare(b.symbol));
  const assess=context.qualityV3 ? assessBalancedThreeLegSymbol : assessThreeLegSymbol;
  const candidates=rows.map(r=>assess(r.symbol,direction,candlesBySymbol?.[r.symbol],cutoffMs));
  audit.quality={cutoffMs,candidates,portfolio:null,rejectedCombinations:{},limits:context.qualityV3 ? THREE_LEG_BALANCED_LIMITS : THREE_LEG_QUALITY_LIMITS,seal:""};
  const eligible=rows.filter(r=>candidates.find(c=>c.symbol===r.symbol)!.allowed);
  if(eligible.length<3)return reject("THREE_LEG_INSUFFICIENT_QUALITY_SYMBOLS");
  const allocation:DynamicMom36Allocation=direction==="LONG"?{longCount:3,shortCount:0,label:"3L0S"}:{longCount:0,shortCount:3,label:"0L3S"};
  let best:ReturnType<typeof selectDynamicMom36Legs>|null=null,bestScore=Infinity;
  for(let i=0;i<eligible.length-2;i++)for(let j=i+1;j<eligible.length-1;j++)for(let k=j+1;k<eligible.length;k++) {
    const subset=[eligible[i]!,eligible[j]!,eligible[k]!];
    const selected=selectDynamicMom36Legs(subset,allocation,maxPerCluster,{slowFastApplied:true});
    const portfolio=threeLegPortfolioQuality(subset.map(r=>candidates.find(c=>c.symbol===r.symbol)!));
    const reason=selected.insufficientReason?"QUALITY_CLUSTER_OR_STRICT_GUARD":portfolio.reason;
    if(reason){audit.quality.rejectedCombinations[reason]=(audit.quality.rejectedCombinations[reason]??0)+1;continue;}
    const score=subset.reduce((sum,r)=>sum+canonical.indexOf(r),0);
    if(score<bestScore){bestScore=score;best=selected;audit.quality.portfolio=portfolio;}
  }
  if(!best)return reject("THREE_LEG_NO_DIVERSIFIED_QUALITY_COMBINATION");
  // Re-run strict selection over the full universe with only the winning three executable.
  const symbols=new Set([...best.selectedLongs,...best.selectedShorts].map(r=>r.symbol));
  const selection=selectDynamicMom36Legs(baseline.activeUniverse.map(r=>({...r,longEligible:r.longEligible&&symbols.has(r.symbol),shortEligible:r.shortEligible&&symbols.has(r.symbol)})),allocation,maxPerCluster,{slowFastApplied:true});
  if(selection.insufficientReason)return reject("THREE_LEG_FINAL_QUALITY_SELECTION_INVALID");
  audit.selectedSymbols=[...selection.selectedLongs,...selection.selectedShorts].map(r=>r.symbol);
  audit.allowed=true;audit.reason="THREE_LEG_ADMISSION_PASSED";audit.quality.seal=threeLegQualitySeal(audit);
  return {audit,formation:{...baseline,preference:null,requestedAllocation:allocation,finalAllocation:allocation,selection,selectionSource:"STRICT_SLOW_FAST",threeLegFallback:audit}};
}

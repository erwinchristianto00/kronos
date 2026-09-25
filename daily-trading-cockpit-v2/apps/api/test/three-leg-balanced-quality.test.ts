import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import type {Candle} from "@dtc/shared";
import {assessBalancedThreeLegSymbol as assess, balancedThreeLegPriceReason as priceReason,THREE_LEG_BALANCED_POLICY,THREE_LEG_BALANCED_LIMITS} from "../src/lib/three-leg-balanced-quality.js";
import {assessThreeLegSymbol,THREE_LEG_QUALITY_POLICY} from "../src/lib/three-leg-symbol-quality.js";
import {qualityCandles,qualityInput} from "./three-leg-quality-fixture.js";
import {evaluateDynamicMom36Formation,validateDynamicMom36FormationAdmissionParity} from "../src/lib/cross-sectional-edge.js";
import {threeLegQualitySeal,threeLegRegimeReason} from "../src/lib/dynamic-three-leg-fallback.js";
import {crossSectionalSelectionRuntime} from "../src/lib/cross-sectional-policy.js";
const cut=Date.parse("2026-09-06T14:00:00Z");
const mirror=(cs:Candle[],side:"LONG"|"SHORT")=>side==="LONG"?cs:cs.map(c=>({...c,open:10000/c.open,close:10000/c.close,high:10000/c.low,low:10000/c.high}));
const input=(direction:"LONG"|"SHORT"="LONG")=>{const i=qualityInput(cut,direction);i.threeLegContext!.qualityV3=true;return i;};
describe("balanced quality v3",()=>{
 it.each(["LONG","SHORT"] as const)("accepts a small %s pullback with continuing trend, while v2 remains frozen",side=>{
  const cs=qualityCandles(cut,0);cs[47]!.close=cs[47]!.open*.999;cs[47]!.high=cs[47]!.open*1.001;
  const mapped=mirror(cs,side),q=assess("A",side,mapped,cut);
  expect(q.allowed,JSON.stringify(q)).toBe(true);expect(q.warnings).toContain("QUALITY_SMALL_PULLBACK");
  expect(assessThreeLegSymbol("A",side,mapped,cut).allowed).toBe(false);
 });
 it.each(["LONG","SHORT"] as const)("records slower %s momentum without declaring it a reversal",side=>{
  const cs=qualityCandles(cut,0);cs[44]!.close*=1.004;cs[44]!.high=Math.max(cs[44]!.high,cs[44]!.close);
  const q=assess("A",side,mirror(cs,side),cut);expect(q.allowed,JSON.stringify(q)).toBe(true);expect(q.warnings).toContain("QUALITY_MOMENTUM_DECELERATING");
 });
 it.each(["missing","gap","future","largePullback","twoAdverseHours","spike","extension","rejection","failedBreakout"].flatMap(f=>["LONG","SHORT"].map(d=>[d,f] as const)))("blocks %s %s",(side,f)=>{
  const cs=qualityCandles(cut,0);
  if(f==="missing")cs.pop();if(f==="gap")cs[20]!.openTime-=1;if(f==="future")cs[47]!.openTime+=3600000;
  if(f==="largePullback"){cs[47]!.close=cs[47]!.open*.992;cs[47]!.low=Math.min(cs[47]!.low,cs[47]!.close);}
  if(f==="twoAdverseHours"){for(const i of [46,47]){cs[i]!.close=cs[i-1]!.close*.999;cs[i]!.low=Math.min(cs[i]!.low,cs[i]!.close);}}
  if(f==="spike")cs[47]!.high*=1.05;
  if(f==="extension")for(let j=44;j<48;j++)for(const k of ["open","high","low","close"] as const)cs[j]![k]*=1.05;
  if(f==="rejection"||f==="failedBreakout")cs[47]!.high=cs[47]!.close*1.012;
  expect(assess("A",side as "LONG"|"SHORT",mirror(cs,side as "LONG"|"SHORT"),cut).allowed).toBe(false);
 });
 it.each(["LONG","SHORT"] as const)("distinguishes a weak %s pivot from a significant nearby barrier",side=>{
  const cs=qualityCandles(cut,0);cs[40]!.high=cs[47]!.close*1.001;
  for(const i of [38,39,41,42]){cs[i]!.close=cs[40]!.high*.9975;cs[i]!.high=Math.max(cs[i]!.high,cs[i]!.close);}
  const weak=assess("A",side,mirror(cs,side),cut);expect(weak.significantPivots).toHaveLength(0);expect(weak.allowed).toBe(true);
  for(const i of [38,39,41,42]){cs[i]!.close=cs[40]!.high*.98;cs[i]!.low=Math.min(cs[i]!.low,cs[i]!.close);}
  const strong=assess("A",side,mirror(cs,side),cut);expect(strong.significantPivots.length).toBeGreaterThan(0);expect(strong.targetSource).toBe("PRIOR_SWING");expect(strong.reasons).toContain("QUALITY_INSUFFICIENT_ROOM_AFTER_COSTS");
 });
 it.each(["LONG","SHORT"] as const)("checks fresh %s price, deterioration, room and multiplier scale",side=>{
  const q=assess("A",side,qualityCandles(cut,0,side),cut),sign=side==="LONG"?1:-1;
  expect(priceReason(q,q.entry)).toBeNull();expect(priceReason(q,q.entry*1000,1000)).toBeNull();
  expect(priceReason(q,q.entry-sign*.36*q.atr)).toBe("THREE_LEG_PRICE_PULLBACK_EXCEEDED");
  expect(priceReason(q,q.target)).not.toBeNull();expect(priceReason(q,q.invalidation)).toBe("THREE_LEG_PRICE_REVERSAL");
 });
 it.each(["LONG","SHORT"] as const)("combines the existing %s pullback with post-formation deterioration",side=>{
  const cs=qualityCandles(cut,0);cs[47]!.close=cs[47]!.open*.999;cs[47]!.high=cs[47]!.open*1.001;
  const q=assess("A",side,mirror(cs,side),cut),sign=side==="LONG"?1:-1;
  expect(q.allowed).toBe(true);expect(q.latestHourAtr).toBeLessThan(0);
  expect(priceReason(q,q.entry-sign*.26*q.atr)).toBe("THREE_LEG_PRICE_PULLBACK_EXCEEDED");
 });
 it.each(["LONG","SHORT"] as const)("persists %s selection and blocks forged profile or thresholds",side=>{
  const r=evaluateDynamicMom36Formation(input(side));expect(r.basket).not.toBeNull();expect(r.snapshot!.threeLegFallback!.policyId).toBe(THREE_LEG_BALANCED_POLICY);
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(true);
  const audit=r.snapshot!.threeLegFallback!;audit.quality!.limits={...THREE_LEG_BALANCED_LIMITS,minNetRewardRisk:.5};audit.quality!.seal=threeLegQualitySeal(audit);
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(false);
 });
 it("rejects a v2 contract relabeled as v3 even with a recomputed seal",()=>{
  const r=evaluateDynamicMom36Formation(qualityInput(cut)),a=r.snapshot!.threeLegFallback!;a.policyId=THREE_LEG_BALANCED_POLICY;a.quality!.limits=THREE_LEG_BALANCED_LIMITS;a.quality!.seal=threeLegQualitySeal(a);
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(false);
 });
 it.each(["panic","highStress","lowCoverage","missing","stale","opposite","mainnet"])("keeps %s blocked with v3",failure=>{
  const i=input(),c=i.threeLegContext!;
  if(failure==="panic"||failure==="highStress"||failure==="lowCoverage")c.regime[failure]=true;
  if(failure==="missing")delete c.regime.panic;if(failure==="stale")c.regime.atMs-=21*60000;
  if(failure==="opposite")c.regime.projection="BEARISH";if(failure==="mainnet")c.venue="mainnet";
  expect(evaluateDynamicMom36Formation(i).basket).toBeNull();
 });
 it.each(["UP_THEN_REVERSAL","PERSISTENT_DOWN"] as const)("blocks explicit continuation %s",path=>{
  const i=input();i.continuationRuntime!.trajectory!.topPath=path;expect(evaluateDynamicMom36Formation(i).basket).toBeNull();
 });
 it("requires opt-in v3 and leaves v2 policy identity intact when off",()=>{
  const i=input(),env={LIVE_BINANCE_ENV:"testnet",CROSS_SECTIONAL_STRATEGY_VERSION:i.strategyVersion,CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK:"1",CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V2:"1",CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V3:"1"};
  expect(crossSectionalSelectionRuntime(env).allocationPolicy.threeLegFallback.policyId).toBe(THREE_LEG_BALANCED_POLICY);
  for(const bad of [{LIVE_BINANCE_ENV:"mainnet"},{CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V2:"0"},{CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V3:"invalid"}])expect(crossSectionalSelectionRuntime({...env,...bad}).state).toBe("CONFIG_INEFFECTIVE");
  expect(crossSectionalSelectionRuntime({...env,CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V3:"0"}).allocationPolicy.threeLegFallback.policyId).toBe(THREE_LEG_QUALITY_POLICY);
  i.threeLegContext!.qualityV3=false;expect(threeLegRegimeReason(i.threeLegContext!,"LONG",THREE_LEG_BALANCED_POLICY)).toBe("THREE_LEG_QUALITY_V3_DISABLED");
 });
 it("removes SOL momentum veto but respects its significant resistance; keeps NEAR, TAO and WLD rejected",()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/three-leg-quality-20260906.json',import.meta.url),'utf8'));
  const q=(s:string)=>assess(s,"LONG",fixture.candles[s],fixture.cutoffMs);
  expect(q("SOLUSDT").warnings).toContain("QUALITY_MOMENTUM_DECELERATING");
  expect(q("SOLUSDT").reasons).toEqual(["QUALITY_INSUFFICIENT_ROOM_AFTER_COSTS"]);
  expect(q("SOLUSDT").significantPivots).toContain(107.3);
  for(const s of ["NEARUSDT","TAOUSDT","WLDUSDT"])expect(q(s).allowed,s).toBe(false);
 });
});

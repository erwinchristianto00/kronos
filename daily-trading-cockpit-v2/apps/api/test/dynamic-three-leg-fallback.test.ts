import {describe,it,expect} from "vitest";
import {evaluateDynamicMom36Formation,validateDynamicMom36FormationAdmissionParity} from "../src/lib/cross-sectional-edge.js";
import {crossSectionalSelectionRuntime} from "../src/lib/cross-sectional-policy.js";
import {threeInput,THREE_VERSION} from "./three-leg-fixture.js";
const cut=Date.parse("2026-09-06T12:00:00Z");
describe("Testnet three-leg trend fallback",()=>{
 it.each(["LONG","SHORT"] as const)("forms exactly three equal-notional %s legs",direction=>{
  const r=evaluateDynamicMom36Formation(threeInput(cut,direction));
  expect(r.noEntryReason).toBeNull();expect(r.snapshot?.threeLegFallback).toMatchObject({allowed:true,direction,oppositeAlignedCount:0});
  expect(r.snapshot?.finalAllocation).toMatchObject({longCount:direction==="LONG"?3:0,shortCount:direction==="SHORT"?3:0});
  const legs=[...r.basket!.longLeg,...r.basket!.shortLeg];expect(legs).toHaveLength(3);expect(legs.every(l=>l.weight===1/3)).toBe(true);
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(true);
 });
 it.each(["MIXED","BEARISH"])("blocks LONG when canonical projection is %s",projection=>{
  const input=threeInput(cut,"LONG");input.threeLegContext!.regime.projection=projection;
  const r=evaluateDynamicMom36Formation(input);expect(r.basket).toBeNull();expect(r.snapshot?.threeLegFallback?.reason).toBe("THREE_LEG_REGIME_MIXED_OR_OPPOSITE");
 });
 it.each(["disabled","mainnet","staleRegime","futureRegime","missingCoverage","noModel","weakHour","weakFast","missingData","oppositeExists","cluster","external","staleLeg"])("blocks fallback for %s",failure=>{
  const input=threeInput(cut,"LONG");
  if(failure==="disabled")input.threeLegContext!.enabled=false;
  if(failure==="mainnet")input.threeLegContext!.venue="mainnet";
  if(failure==="staleRegime")input.threeLegContext!.regime.atMs=cut-21*60_000;
  if(failure==="futureRegime")input.threeLegContext!.regime.atMs=cut+1;
  if(failure==="missingCoverage")input.threeLegContext!.regime.coverageStatus="INVALID";
  if(failure==="noModel")input.continuationRuntime=null;
  if(failure==="weakHour")input.activeUniverse.forEach(r=>r.oneHourReturn=-.01);
  if(failure==="weakFast")input.activeUniverse.slice(0,3).forEach(r=>r.fastReturn=-.01);
  if(failure==="missingData")input.activeUniverse[5]!.oneHourReturn=null;
  if(failure==="oppositeExists"){input.activeUniverse[5]!.mom36=-.01;input.activeUniverse[5]!.fastReturn=-.01;input.activeUniverse[5]!.shortEligible=false;input.activeUniverse[5]!.shortBlocked=true;}
  if(failure==="cluster"){input.maxPerCluster=1;input.activeUniverse.forEach((r,i)=>r.symbol=`UNKNOWN${i}`);}
  if(failure==="external")input.admissionExternalReason="PAUSED";
  if(failure==="staleLeg")input.activeUniverse.forEach(r=>r.fastSourceTimestampMs=cut-1);
  const r=evaluateDynamicMom36Formation(input);expect(r.basket).toBeNull();
 });
 it("does not replace an admissible mixed basket",()=>{
  const input=threeInput(cut,"LONG");input.activeUniverse.slice(3).forEach(r=>{r.mom36=-.1;r.fastReturn=-.04;r.oneHourReturn=-.01;});
  const r=evaluateDynamicMom36Formation(input);expect(r.basket).not.toBeNull();expect(r.snapshot?.threeLegFallback).toBeUndefined();expect(r.basket?.longK).toBe(3);expect(r.basket?.shortK).toBe(3);
 });
 it("rejects a forged three-leg plan without its frozen fallback contract",()=>{
  const r=evaluateDynamicMom36Formation(threeInput(cut,"LONG"));delete r.snapshot!.threeLegFallback;
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(false);
 });
 it("exposes Testnet-only configuration and rejects accidental Mainnet activation",()=>{
  const env={CROSS_SECTIONAL_STRATEGY_VERSION:THREE_VERSION,CROSS_SECTIONAL_EXEC_VARIANT:"DYNAMIC_MOM36_SHOCK",LIVE_BINANCE_ENV:"testnet",CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK:"1"};
  expect(crossSectionalSelectionRuntime(env).allocationPolicy.threeLegFallback.enabled).toBe(true);
  expect(crossSectionalSelectionRuntime({...env,LIVE_BINANCE_ENV:"mainnet"}).state).toBe("CONFIG_INEFFECTIVE");
 });
});

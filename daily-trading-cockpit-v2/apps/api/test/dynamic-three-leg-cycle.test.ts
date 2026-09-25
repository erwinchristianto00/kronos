import {describe,it,expect,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {threeInput,THREE_VERSION,THREE_SYMBOLS} from "./three-leg-fixture.js";
const cut=Date.parse("2026-09-06T12:00:00Z");
describe("three-leg production cycle",()=>{
 it.each(["LONG","SHORT","MIXED"] as const)("persists the actual %s cycle decision",async direction=>{
  const side=direction==="SHORT"?"SHORT":"LONG",fixture=threeInput(cut,side);
  const overrides={LIVE_BINANCE_ENV:"testnet",CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK:"1",CROSS_SECTIONAL_STRATEGY_VERSION:THREE_VERSION,
   CROSS_SECTIONAL_DYNAMIC_ALLOWED_ALLOCATIONS:"1L5S,2L4S,3L3S,4L2S,5L1S",CROSS_SECTIONAL_DYNAMIC_ALLOCATION_SELECTION_MODE:"RANK_ALL_QUALIFIED",
   CROSS_SECTIONAL_DYNAMIC_SKEW_REQUIRE_CONTINUATION_CONFIRMATION:"0",CROSS_SECTIONAL_INTERVAL:"1h",CROSS_SECTIONAL_MOMENTUM_BARS:"36",CROSS_SECTIONAL_K:"3",
   CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER:"0",CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST:THREE_SYMBOLS.join(","),CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST:THREE_SYMBOLS.join(","),
   CROSS_SECTIONAL_SHORT_BLOCKLIST:"",CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED:"0",CROSS_SECTIONAL_REGIME_SKEW_ENABLED:"0",CROSS_SECTIONAL_SMART_FORMATION_RERANK:"0",CROSS_SECTIONAL_STAND_DOWN_14D_PCT:"0",CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR:"0",CROSS_SECTIONAL_EDGE_DISABLED:"0"};
  const prior={...process.env};const dir=mkdtempSync(join(tmpdir(),"three-cycle-"));
  try{
   Object.assign(process.env,overrides);vi.resetModules();
   vi.doMock("../src/lib/canonical-market-regime-engine.js",()=>({getCanonicalMarketRegimeSnapshot:()=>({atMs:cut,projection:direction==="MIXED"?"MIXED":side==="LONG"?"BULLISH":"BEARISH",status:"VALID",coverage:{status:"VALID"}})}));
   vi.doMock("../src/lib/dynamic-mom36-continuation-runtime.js",async importOriginal=>({...await importOriginal<typeof import("../src/lib/dynamic-mom36-continuation-runtime.js")>(),evaluateDynamicMom36Continuation:()=>fixture.continuationRuntime}));
   const edge=await import("../src/lib/cross-sectional-edge.js");const store=new edge.CrossSectionalStore(dir);
   const result=await edge.runCrossSectionalCycle({store,universe:THREE_SYMBOLS,now:cut+20_000,fetchCandles:async symbol=>{
    const ret=fixture.activeUniverse.find(r=>r.symbol===symbol)!.mom36;
    return Array.from({length:37},(_,i)=>({openTime:cut-(37-i)*3600_000,open:100*(1+ret*i/36),high:100*(1+ret*i/36),low:100*(1+ret*i/36),close:100*(1+ret*i/36),volume:100_000}));
   }});
   expect(store.latestDynamicMom36Formation?.threeLegFallback?.allowed).toBe(direction!=="MIXED");
   if(direction==="MIXED")expect(result.openedDynamicMom36Shock ?? 0).toBe(0);
   else{expect(result.openedDynamicMom36Shock).toBe(1);const o=store.all.find(o=>o.variant==="DYNAMIC_MOM36_SHOCK")!;expect(o.longLeg.length+o.shortLeg.length).toBe(3);expect(o.dynamicMom36).toEqual(store.latestDynamicMom36Formation);}
  }finally{for(const k of Object.keys(overrides)){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}vi.doUnmock("../src/lib/canonical-market-regime-engine.js");vi.doUnmock("../src/lib/dynamic-mom36-continuation-runtime.js");vi.resetModules();rmSync(dir,{recursive:true,force:true});}
 });
});

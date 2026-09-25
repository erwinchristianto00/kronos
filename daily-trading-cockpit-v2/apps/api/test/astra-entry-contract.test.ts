import { describe, it, expect } from "vitest";
import { finalEntryGate, AstraEntryGateError } from "../src/lib/astra-entry-contract.js";
import type { AstraDecision } from "../src/lib/astra-hermes-lane.js";
const now=1800000000000;
function fixture(side: "LONG"|"SHORT"="LONG"): AstraDecision {
  const d:AstraDecision={id:"contract_open_001",action:"OPEN",reason:"synthetic frozen economics",symbol:"DOGEUSDT",side,
    notionalUsd:6,stopPrice:side==="LONG"?9.8:10.2,targetPrice:side==="LONG"?10.4:9.6,maxHoldMs:600000,slippageBps:5};
  d.entryContract={version:1,planId:"frozen_plan_001",validatedAt:now,expiresAt:now+300000,symbol:d.symbol!,side,
    notionalUsd:6,stopPrice:d.stopPrice!,targetPrice:d.targetPrice!,maxHoldMs:600000,triggerPrice:10,entryMin:9.97,entryMax:10.03,
    maxSpreadBps:10,maxCostBps:40,entrySlippageBps:5,exitSlippageBps:10,fundingAllowanceBps:5,takerRate:.0005};return d;
}
const book={bid:9.999,ask:10,time:now};
describe("final frozen economics contract",()=>{
  it.each(["LONG","SHORT"] as const)("accepts unchanged %s geometry",side=>{
    const r=finalEntryGate(fixture(side),book,.001,now);expect(r.riskInflation).toBeLessThanOrEqual(1.25);
  });
  it.each(["LONG","SHORT"] as const)("clamps %s toward safe tick without widening IOC",side=>{
    const d=fixture(side); d.entryContract!.entryMin=9.9977; d.entryContract!.entryMax=10.0027;
    const r=finalEntryGate(d,book,.001,now);
    expect(r.limitPrice).toBe(side==="LONG"?10.002:9.998);
    expect(r.bandClamped).toBe(true);
  });
  it.each(["LONG","SHORT"] as const)("rejects historical-like %s one-tick band breach",side=>{
    const d=fixture(side);const b=side==="LONG"?{bid:10.03,ask:10.031,time:now}:{bid:9.969,ask:9.97,time:now};
    expect(()=>finalEntryGate(d,b,.001,now)).toThrow("entryBand");
  });
  it("cost uses the final spread and both taker legs",()=>{
    const d=fixture();d.entryContract!.maxCostBps=30;
    expect(()=>finalEntryGate(d,book,.001,now)).toThrow("cost");
  });
  it.each(["LONG","SHORT"] as const)("checks %s risk at worst permitted IOC price, not only touch",side=>{
    const d=fixture(side);d.slippageBps=100;d.entryContract!.entrySlippageBps=100;d.entryContract!.maxCostBps=150;
    d.entryContract!.entryMin=9.8;d.entryContract!.entryMax=10.2;
    expect(()=>finalEntryGate(d,book,.001,now)).toThrow("riskEnvelope");
  });
  it("rejects economics that do not cover costs",()=>{
    const d=fixture();d.targetPrice=10.02;d.entryContract!.targetPrice=10.02;
    expect(()=>finalEntryGate(d,book,.001,now)).toThrow("targetCoversCost");
  });
  it.each([-1,120001,300000])("rejects future/stale/expired contract at delta %s",delta=>{
    expect(()=>finalEntryGate(fixture(),{...book,time:now+delta},.001,now+delta)).toThrow("contractFresh");
  });
  it("rejects expiry reached while the gateway was awaiting account reads",()=>{
    const d=fixture();d.entryContract!.expiresAt=now+1000;
    expect(()=>finalEntryGate(d,{...book,time:now+1001},.001,now+1001)).toThrow("contractFresh");
  });
  it.each([NaN,Infinity,-1])("rejects invalid fee %s",fee=>{
    const d=fixture();d.entryContract!.takerRate=fee;expect(()=>finalEntryGate(d,book,.001,now)).toThrow("takerRate");
  });
  it("does not allow a changed stop or size to detach from frozen contract",()=>{
    const d=fixture(); d.stopPrice=9.7;expect(()=>finalEntryGate(d,book,.001,now)).toThrow("frozen.stopPrice");
    d.stopPrice=9.8;d.notionalUsd=25;expect(()=>finalEntryGate(d,book,.001,now)).toThrow("frozen.notionalUsd");
  });
  it("produces structured rejection details",()=>{
    const d=fixture();d.entryContract!.maxSpreadBps=.1;
    try {finalEntryGate(d,book,.001,now);throw Error("unexpected pass");}
    catch(e){expect(e).toBeInstanceOf(AstraEntryGateError);expect((e as AstraEntryGateError).diagnostic).toMatchObject({failedPredicate:"spread",threshold:.1,planId:"frozen_plan_001"});}
  });
});

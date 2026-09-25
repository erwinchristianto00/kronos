import {describe,it,expect,afterEach} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Dual4hForwardStudy} from '../src/lib/dual4h-forward-study.js';
import {DUAL4H_IMPROVEMENT} from '../src/lib/dual4h-improvement.js';
import type {MomentumFeature} from '../src/lib/daily-momentum4h.js';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const T=Date.UTC(2026,8,21,8);
function fixture(side:'LONG'|'SHORT'='LONG'){
 const dir=mkdtempSync(join(tmpdir(),'dual-study-'));dirs.push(dir);let now=T;
 const path=join(dir,'study.json');const study=new Dual4hForwardStudy(path,()=>now);
 const bar={openTime:T-14400000,closeTime:T-1,open:100,high:101,low:99,close:100,volume:1,quoteVolume:1e7};
 const feature:MomentumFeature={symbol:'TESTUSDT',decisionTime:T,direction:side,ret4d:.05,ret7d:.06,btcRet7d:.04,atr:0,close:100,rawStop:98,volume:1e7,lastBar:bar,fundingRateReserve:0,dual:{family:'FADE',sourceBoundary:T,thesisLevel:99,score:1,signalBar:bar,exitKind:'TIME_6H',stopPct:2,maxHoldHours:6,targetR:null,improvementId:DUAL4H_IMPROVEMENT.id}};
 study.observe(feature,'CONFIRMED_V2');
 return {study,feature,path,setTime:(t:number)=>{now=t;},now:()=>now,tick:(price:number)=>{now+=1000;study.quote('TESTUSDT',price,price,now,now);}};
}
describe('paired forward study, never exchange authority',()=>{
 it('compares identical entry across arms and follows baseline after earlier candidates exit',()=>{
  const f=fixture();f.tick(100);const r=f.study.rows[0]!;expect(r.route).toBe('FADE_PROFILE_SHADOW_ONLY');
  f.tick(101.1);expect(r.variants.find(v=>v.arm===.75)!.floor).toBeGreaterThan(0);expect(r.variants.find(v=>v.arm===2)!.floor).toBeNull();
  f.tick(100.5);expect(r.variants.find(v=>v.arm===.75)!.reason).toBe('GIVEBACK_PROXY');expect(r.status).toBe('OPEN');
  f.tick(103);f.tick(101.4);expect(r.status).toBe('CLOSED');expect(r.variants.every(v=>v.netUsd!==null)).toBe(true);expect(f.study.status().pairedClosed).toBe(1);
  f.study.observe(f.feature,'CONFIRMED_V2');expect(f.study.rows).toHaveLength(1);
 });
 it('uses short executable side and preserves all variant outcomes across restart',()=>{
  const f=fixture('SHORT');f.tick(100);f.tick(98.5);f.tick(99.6);f.study.flush(true);
  const reopened=new Dual4hForwardStudy(f.path,f.now);expect(reopened.rows[0]!.variants).toEqual(f.study.rows[0]!.variants);
  expect(reopened.rows[0]!.gaps).toContain('PROCESS_RESTART');expect(reopened.status().pairedClosed).toBe(0);
 });
 it('rejects stale and out-of-order quotes, marks missing path and does not invent late fills',()=>{
  const f=fixture();f.setTime(T+6000);f.study.quote('TESTUSDT',100,100,T,T);expect(f.study.rows[0]!.status).toBe('WAITING_QUOTE');
  f.setTime(T+96000);f.study.advanceTime(f.now(),{});expect(f.study.rows[0]!.status).toBe('NO_FILL');
  f.tick(100);expect(f.study.rows[0]!.entry).toBeNull();
  const g=fixture();g.tick(100);g.setTime(T+62000);g.study.advanceTime(g.now(),{});expect(g.study.rows[0]!.gaps).toContain('QUOTE_GAP_OVER_60S');
 });
 it('applies stop and deadline to every still-open alternative, excluding gaps from headline',()=>{
  const f=fixture();f.tick(100);f.tick(97);expect(f.study.rows[0]!.variants.every(v=>v.reason==='STOP_PROXY')).toBe(true);
  const g=fixture();g.tick(100);g.setTime(T+6*3600000+1000);g.tick(100);expect(g.study.rows[0]!.variants.every(v=>v.reason==='TIME_CAP_PROXY')).toBe(true);expect(g.study.status().pairedClosed).toBe(0);
 });
 it('does not apply a completed structural bar from before entry or future bar',()=>{
  const f=fixture();f.feature.dual!.exitKind='THESIS_12H';f.study.rows[0]!.feature.dual!.exitKind='THESIS_12H';f.tick(100);
  const b={...f.feature.lastBar,close:98};f.study.advanceTime(f.now(),{TESTUSDT:[b,{...b,closeTime:T+10000}]});expect(f.study.rows[0]!.pendingExit).toBeNull();
  f.setTime(T+12000);f.study.advanceTime(f.now(),{TESTUSDT:[{...b,closeTime:T+10000}]});f.tick(99);expect(f.study.rows[0]!.variants.every(v=>v.reason==='STRUCTURE_INVALIDATION')).toBe(true);
 });
});

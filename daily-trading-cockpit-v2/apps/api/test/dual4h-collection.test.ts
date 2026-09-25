import {describe,it,expect,afterEach} from 'vitest';
import {dualFeatures,dualWindow,dualArtifactValid} from '../src/lib/dual4h-collection.js';
import {DUAL4H_UNIVERSE,type Dual4hProfile} from '../src/lib/dual4h-universe.js';
import type {MomentumSnapshot,MomentumBar} from '../src/lib/daily-momentum4h.js';
const H=3600000,Q=900000,T=Date.UTC(2026,8,6,8),saved=DUAL4H_UNIVERSE.groups;
afterEach(()=>{DUAL4H_UNIVERSE.groups=saved;});
function profile(family:'MOMENTUM'|'FADE',entryKind:Dual4hProfile['entryKind']):Dual4hProfile{return {...saved.MOMENTUM[0]!,symbol:'TESTUSDT',family,entryKind,stopPct:1,exitKind:'TIME_6H',maxHoldHours:6,targetR:null};}
function make(t:number,p:Dual4hProfile){
 DUAL4H_UNIVERSE.groups={MOMENTUM:p.family==='MOMENTUM'?[p]:[],FADE:p.family==='FADE'?[p]:[]};
 const bars=Array.from({length:49},(_,i)=>{const close=95+i*5/48,openTime=T-(49-i)*4*H;return {openTime,closeTime:openTime+4*H-1,open:close,high:close+.5,low:close-.5,close,volume:1,quoteVolume:1e7};});
 const snap:MomentumSnapshot={candles:{TESTUSDT:bars,BTCUSDT:structuredClone(bars)},funding:{TESTUSDT:[24,16,8].map(h=>({fundingTime:T-h*H,fundingRate:.0001}))}};
 const a:MomentumBar[]=Array.from({length:40},(_,i)=>{const openTime=t-(40-i)*Q;return {openTime,closeTime:openTime+Q-1,open:100,high:100.4,low:99.6,close:100,volume:1,quoteVolume:1e6};});return {snap,a};
}
describe('profile collector causal features',()=>{
 it('direct profile enters only08UTC and retains its own stop/exit/holding reserve',()=>{
  const {snap,a}=make(T,profile('MOMENTUM','MOMENTUM_DIRECT'));const f=dualFeatures(snap,{TESTUSDT:a},T)[0]!;expect(f).toBeDefined();expect(f.dual).toMatchObject({entryKind:'MOMENTUM_DIRECT',stopPct:1,maxHoldHours:6,targetR:null});expect(f.fundingRateReserve).toBeCloseTo(.00015);expect(dualFeatures(snap,{TESTUSDT:a},T+Q)).toHaveLength(0);
 });
 it('confirm waits for first completed15m break; later closes cannot repeat it',()=>{
  const {snap,a}=make(T+Q,profile('MOMENTUM','MOMENTUM_CONFIRM'));expect(dualFeatures(snap,{TESTUSDT:a},T+Q)).toHaveLength(0);Object.assign(a.at(-1)!,{close:100.9,high:101});expect(dualFeatures(snap,{TESTUSDT:a},T+Q)).toHaveLength(1);
  a.push({...a.at(-1)!,openTime:T+Q,closeTime:T+2*Q-1,close:102,high:102});expect(dualFeatures(snap,{TESTUSDT:a},T+2*Q)).toHaveLength(0);
 });
 it('fade requires outside then inside; uses firstreentry and frozen4hrange',()=>{
  const {snap,a}=make(T+2*Q,profile('FADE','BREAKOUT_FADE'));expect(dualFeatures(snap,{TESTUSDT:a},T+2*Q)).toHaveLength(0);Object.assign(a.at(-2)!,{close:101,high:101});const f=dualFeatures(snap,{TESTUSDT:a},T+2*Q)[0]!;expect(f.direction).toBe('SHORT');expect(f.dual!.sourceBoundary).toBe(T);expect(f.dual!.thesisLevel).toBe(100.5);
 });
 it('future candles and futurefunding cannot alter decision, missing completedhistory fails closed',()=>{
  const {snap,a}=make(T+Q,profile('MOMENTUM','MOMENTUM_CONFIRM'));Object.assign(a.at(-1)!,{close:100.9,high:101});const expected=dualFeatures(snap,{TESTUSDT:a},T+Q);
  a.push({...a.at(-1)!,openTime:T+Q,closeTime:T+2*Q-1,close:999,high:999});snap.funding.TESTUSDT!.push({fundingTime:T,fundingRate:99});snap.candles.TESTUSDT!.push({...snap.candles.TESTUSDT!.at(-1)!,openTime:T,closeTime:T+4*H-1,close:999,high:999});expect(dualFeatures(snap,{TESTUSDT:a},T+Q)).toEqual(expected);
  snap.candles.TESTUSDT![20]!.openTime+=1;expect(dualFeatures(snap,{TESTUSDT:a},T+Q)).toHaveLength(0);
 });
 it('fresh windows and cohort expiry never allow late replay',()=>{expect(dualWindow(T+95001,T-1)).toBe(false);expect(dualWindow(T+1,T+2)).toBe(false);expect(dualArtifactValid(Date.UTC(2026,9,1))).toBe(false);});
});

describe('v2 confirmation and trend gates',()=>{
 it('replaces direct entry with two causal closes; limits extension and does not replay',()=>{
  const {snap,a}=make(T+2*Q,profile('MOMENTUM','MOMENTUM_DIRECT'));
  Object.assign(a.at(-2)!,{close:100.5,high:100.6});Object.assign(a.at(-1)!,{close:100.7,high:100.8});
  expect(dualFeatures(snap,{TESTUSDT:a},T+Q,true)).toHaveLength(0);
  const f=dualFeatures(snap,{TESTUSDT:a},T+2*Q,true)[0]!;expect(f.dual!.confirmationLevel).toBe(100.4);
  expect(f.dual!.improvementId).toContain('v2');
  Object.assign(a.at(-1)!,{close:102,high:103});expect(dualFeatures(snap,{TESTUSDT:a},T+2*Q,true)).toHaveLength(0);
  Object.assign(a.at(-1)!,{close:100.3,high:100.8});expect(dualFeatures(snap,{TESTUSDT:a},T+2*Q,true)).toHaveLength(0);
 });
 it('requires two inside closes for fade and rejects strong BTC continuation',()=>{
  const {snap,a}=make(T+3*Q,profile('FADE','BREAKOUT_FADE'));
  Object.assign(a.at(-3)!,{close:101,high:101.1});
  expect(dualFeatures(snap,{TESTUSDT:a},T+2*Q,true)).toHaveLength(0);
  expect(dualFeatures(snap,{TESTUSDT:a},T+3*Q,true)).toHaveLength(1);
  const btc=snap.candles.BTCUSDT!;Object.assign(btc.at(-1)!,{close:104,high:105});
  expect(dualFeatures(snap,{TESTUSDT:a},T+3*Q,true)).toHaveLength(0);
 });
 it('rejects a missing second candle and cannot look at future candles',()=>{
  const {snap,a}=make(T+2*Q,profile('MOMENTUM','MOMENTUM_CONFIRM'));
  Object.assign(a.at(-2)!,{close:100.5,high:100.6});Object.assign(a.at(-1)!,{close:100.7,high:100.8});
  expect(dualFeatures(snap,{TESTUSDT:a},T+Q,true)).toHaveLength(0);
  a.at(-1)!.openTime+=1;expect(dualFeatures(snap,{TESTUSDT:a},T+2*Q,true)).toHaveLength(0);
 });
});

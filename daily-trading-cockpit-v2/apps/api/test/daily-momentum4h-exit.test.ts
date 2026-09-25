import {describe,it,expect} from 'vitest';
import {newMomentumExitState,advanceMomentumExit,momentumNativeTp,momentumExitNetPct} from '../src/lib/daily-momentum4h-exit.js';
const t=1788681600000;
function tick(s:ReturnType<typeof newMomentumExitState>,price:number,n:number,side:'LONG'|'SHORT'='LONG'){return advanceMomentumExit(s,100,side,price,price,t+n,t+n,t+n);}
describe('momentum net profit ladder',()=>{
 it('arms after costs and reserves; retains70percent rounded to5bps; exits on giveback',()=>{const s=newMomentumExitState(t,t,.0024);tick(s,100.9,1);expect(s.floorNetPct).toBeNull();tick(s,101,2);expect(s.peakNetPct).toBeCloseTo(.61);expect(s.floorNetPct).toBe(.4);expect(tick(s,100.8,3).exitReason).toBeNull();expect(tick(s,100.78,4).exitReason).toBe('MOMENTUM_MFE_GIVEBACK');});
 it('floors never decrease, including persisted-state restart',()=>{let s=newMomentumExitState(t,t,0);tick(s,101.5,1);const floor=s.floorNetPct; s=JSON.parse(JSON.stringify(s));tick(s,101.3,2);expect(s.floorNetPct).toBe(floor);tick(s,102.5,3);expect(s.floorNetPct).toBeGreaterThan(floor!);});
 it('uses executable ask forSHORT and bid forLONG, symmetrically',()=>{const s=newMomentumExitState(t,t,0);expect(tick(s,98.9,1,'SHORT').exitReason).toBeNull();expect(s.floorNetPct).toBe(.65);expect(tick(s,99.3,2,'SHORT').exitReason).toBe('MOMENTUM_MFE_GIVEBACK');});
 it('rejects stale, pre-policy and future quotes; stale quotes cannot raise the peak',()=>{const s=newMomentumExitState(t,t,0);expect(advanceMomentumExit(s,100,'LONG',105,105,t,t,t+6000).changed).toBe(false);expect(tick(s,105,-1).changed).toBe(false);expect(advanceMomentumExit(s,100,'LONG',105,105,t+2000,t,t).changed).toBe(false);expect(s.peakNetPct).toBeNull();});
 it('nativeTP includes conservative costs and reserve andtimecap is48hours',()=>{const s=newMomentumExitState(t,t,.0024);expect(s.deadline).toBe(t+48*3600000);expect(momentumNativeTp(53.9,'LONG',.0024,.01)).toBe(55.73);expect(momentumExitNetPct(53.9,55.73,'LONG',.0024)).toBeGreaterThanOrEqual(3);expect(tick(s,103.4,1).exitReason).toBe('MOMENTUM_LADDER_TP');});
});

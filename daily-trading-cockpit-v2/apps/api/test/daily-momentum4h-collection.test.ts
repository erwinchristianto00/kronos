import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Momentum4hCollection} from '../src/lib/daily-momentum4h-collection.js';
import {fetchMomentumSnapshot,MOMENTUM4H_UNIVERSE,momentumFeature} from '../src/lib/daily-momentum4h.js';
const T=Date.UTC(2026,8,6,8),H4=14400000,DAY=86400000,dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'momentum-collection-'));dirs.push(dir);const file=join(dir,'state.json');let now=T-3600000,stale=false,fail=false;const urls:string[]=[];
 const get=async(url:string)=>{urls.push(url);if(fail)throw new Error('transient');const u=new URL(url),end=Number(u.searchParams.get('endTime'))+1;
 if(u.pathname.endsWith('klines')){const n=Number(u.searchParams.get('limit')),boundary=stale&&end===T?T-H4:end;return new Response(JSON.stringify(Array.from({length:n},(_,i)=>{const open=boundary-(n-i)*H4,price=100+(open-T)/H4*.1;return[open,price,price+1,price-1,price,1,open+H4-1,20000000];})));}
 return new Response(JSON.stringify([24,16,8].map(h=>({fundingTime:end-h*3600000,fundingRate:.0001}))));};
 return {file,get,urls,collection:new Momentum4hCollection(file,get,()=>now),setNow:(v:number)=>now=v,setStale:(v:boolean)=>stale=v,setFail:(v:boolean)=>fail=v};
}
describe('Momentum collection before the daily boundary',()=>{
 it('prepares all20 histories without a forming candle, then appends exactly one final bar with fresh funding',async()=>{
  const f=fixture();await f.collection.maintain();expect(f.collection.status()).toMatchObject({state:'HISTORY_READY_WAITING_FINAL_CLOSE',symbolsReady:20,historyBarsPerSymbol:49,decisionBarsPerSymbol:0,historyThrough:new Date(T-H4-1).toISOString()});expect(f.urls).toHaveLength(40);
  f.urls.length=0;f.setNow(T+1000);const result=await f.collection.read(T);expect(f.urls).toHaveLength(40);expect(f.urls.filter(u=>u.includes('klines')).every(u=>u.endsWith('limit=1'))).toBe(true);
  for(const symbol of MOMENTUM4H_UNIVERSE){expect(result.candles[symbol]).toHaveLength(49);expect(result.candles[symbol]!.at(-1)!.closeTime).toBe(T-1);expect(momentumFeature(symbol,result,T)).not.toBeNull();}
  expect(result).toEqual(await fetchMomentumSnapshot(T,f.get));expect(f.collection.status()).toMatchObject({state:'COMPLETE',symbolsReady:20,decisionBarsPerSymbol:49});
 });
 it('never accepts the final snapshot before its close time',async()=>{const f=fixture();await f.collection.maintain();const n=f.urls.length;await expect(f.collection.read(T)).rejects.toThrow('NOT_CLOSED');expect(f.urls).toHaveLength(n);});
 it('restores prepared history after restart and shares concurrent final reads',async()=>{
  const f=fixture();await f.collection.maintain();const restarted=new Momentum4hCollection(f.file,f.get,()=>T+1000);f.urls.length=0;const[a,b]=await Promise.all([restarted.read(T),restarted.read(T)]);expect(a).toBe(b);expect(f.urls).toHaveLength(40);
  const again=new Momentum4hCollection(f.file,f.get,()=>T+2000);f.urls.length=0;expect(await again.read(T)).toEqual(a);expect(f.urls).toHaveLength(0);
 });
 it('rejects a stale last candle then recovers on a later read without changing signal rules',async()=>{
  const f=fixture();await f.collection.maintain();f.setNow(T+1000);f.setStale(true);await expect(f.collection.read(T)).rejects.toThrow('INCOMPLETE');expect(f.collection.status().state).not.toBe('COMPLETE');f.setStale(false);f.setNow(T+10000);await f.collection.read(T);expect(f.collection.status().state).toBe('COMPLETE');
 });
 it('backs off failed warmup and retries without touching execution',async()=>{
  const f=fixture();f.setFail(true);await expect(f.collection.maintain()).rejects.toThrow('transient');expect(f.urls).toHaveLength(4);await f.collection.maintain();expect(f.urls).toHaveLength(4);f.setNow(T-3500000);f.setFail(false);await f.collection.maintain();expect(f.collection.status().state).toBe('HISTORY_READY_WAITING_FINAL_CLOSE');
 });
 it('off-schedule probe reads preserve the upcoming prepared daily snapshot',async()=>{const f=fixture();await f.collection.maintain();await f.collection.read(T-H4);expect(f.collection.status()).toMatchObject({state:'HISTORY_READY_WAITING_FINAL_CLOSE',decisionAt:new Date(T).toISOString(),symbolsReady:20});});
 it('cold start falls back to49 closed bars and old-day cache cannot satisfy a new day',async()=>{
  const f=fixture();f.setNow(T+1000);await f.collection.read(T);expect(f.urls.filter(u=>u.includes('klines')).every(u=>u.endsWith('limit=49'))).toBe(true);f.setNow(T+DAY-3600000);expect(f.collection.status().state).toBe('NOT_READY');await f.collection.maintain();expect(f.collection.status().state).toBe('HISTORY_READY_WAITING_FINAL_CLOSE');
 });
});

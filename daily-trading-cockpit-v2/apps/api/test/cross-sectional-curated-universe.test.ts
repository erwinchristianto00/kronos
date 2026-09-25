import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { crossSectionalCuratedUniverse } from '../src/lib/cross-sectional-curated-universe.js';
import { CrossSectionalAutoPool } from '../src/lib/cross-sectional-auto-pool.js';

const kept = ['SOLUSDT','DOGEUSDT','AVAXUSDT','SUIUSDT','OPUSDT','INJUSDT','WLDUSDT','APTUSDT','NEARUSDT','BNBUSDT','XRPUSDT','ADAUSDT','FETUSDT','WIFUSDT','TAOUSDT','ARKMUSDT','UNIUSDT','LDOUSDT','SEIUSDT','AAVEUSDT'];
const retired = ['1000PEPEUSDT','ARBUSDT'];
const oldPool = [...kept,...retired];
const measurement = [...oldPool,'ETHUSDT','LINKUSDT','RNDRUSDT'];
const input = (symbols: string[]) => ({candidateUniverse:symbols,fallbackSymbols:kept,baseLegUsd:25,sizeMultiplier:1});
describe('curated cross-sectional execution ceiling', () => {
  it('keeps only the operator pool while preserving the measurement list', () => {
    expect(crossSectionalCuratedUniverse(measurement,kept,kept)).toEqual(kept);
    expect(measurement).toContain('1000PEPEUSDT');
    expect(crossSectionalCuratedUniverse(measurement,[],kept)).toEqual([]);
    expect(crossSectionalCuratedUniverse(measurement,kept,[])).toEqual([]);
  });
  it.each(['DISABLED','OUTAGE','FRESH'] as const)('cannot restore retired symbols after restart: %s', async mode => {
    const dataDir=mkdtempSync(join(tmpdir(),'curated-pool-'));
    const response=(body: unknown)=>({ok:true,json:async()=>body});
    const fetchImpl=async (url:string)=>response(url.includes('exchangeInfo') ? {symbols:measurement.map(symbol=>({symbol,filters:[{filterType:'LOT_SIZE',stepSize:'1',minQty:'1'},{filterType:'MIN_NOTIONAL',notional:'5'}]}))} : measurement.map(symbol=>({symbol,lastPrice:'5',quoteVolume:'999999999'})));
    const previous=new CrossSectionalAutoPool({dataDir,env:{CROSS_SECTIONAL_AUTO_POOL_ENABLED:'1'},fetchImpl,nowMs:()=>1_000_000});
    const old=await previous.refreshIfDue(input(oldPool));
    expect(old.activeSymbols).toEqual(expect.arrayContaining(retired));
    const current=new CrossSectionalAutoPool({dataDir,env:{CROSS_SECTIONAL_AUTO_POOL_ENABLED:mode==='DISABLED'?'0':'1'},fetchImpl:mode==='OUTAGE'?async()=>{throw Error('fixture outage');}:fetchImpl,nowMs:()=>3_000_000});
    const bounded=input(crossSectionalCuratedUniverse(measurement,kept,kept));
    const initial=current.getSnapshot(bounded);
    const refreshed=await current.refreshIfDue(bounded);
    for(const snapshot of [initial,refreshed]) {
      expect(snapshot.candidateUniverse).toHaveLength(20);
      expect(snapshot.activeSymbols).toHaveLength(20);
      for(const symbol of [...retired,'ETHUSDT','LINKUSDT','RNDRUSDT']) expect(snapshot.activeSymbols).not.toContain(symbol);
    }
  });
});

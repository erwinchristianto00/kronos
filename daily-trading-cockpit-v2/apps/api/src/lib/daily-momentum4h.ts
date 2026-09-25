/** Frozen research candidate MOMENTUM / 24 / 96 / BTC=true. Testnet only. */
import type { FuturesKline, FuturesSymbolFilters } from './binance-futures-private.js';
export const MOMENTUM4H_VERSION = 'dual4h-momentum-fade-net2-give50-v1' as const;
export const MOMENTUM4H_UNIVERSE = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','BCHUSDT','DOTUSDT','1000PEPEUSDT','1000SHIBUSDT','UNIUSDT','APTUSDT','SUIUSDT','WLDUSDT','NEARUSDT','TRXUSDT'];
export const MOMENTUM4H_POLICY = { id: MOMENTUM4H_VERSION, scope: 'TESTNET_ONLY', schedule: '08:00 UTC DAILY', maxEntryDelayMs: 95_000,
  returnBars: [24,42], btcReturnBars: 42, atr: 'SIMPLE_MEAN_TRUE_RANGE_14_COMPLETED_UTC_4H', stopATR: 2,
  stopFloorPct: .005, maxStopPct: .10, maxHoldHours: 48, takeProfit: 'NET_3_PERCENT', trailingStop: 'NET_LADDER_MFE_30_PERCENT',
  riskUsd: .25, maxNotionalUsd: 25, maxPositions: 4, maxSameSide: 3, maxEntriesPerSymbolUtcDay: 1,
  dailyRealizedLossStopUsd: 1, minPrior24hQuoteVolumeUsd: 50_000_000, feeBpsPerSide: 5, slippageBpsPerSide: 5,
  fundingReserve: '2 * prior24h sum(abs(rate)) * 4 days * entry * quantity',
  signalVenue: 'USD_M_MAINNET_PUBLIC', executionVenue: 'USD_M_TESTNET', maxVenueBasisBps: 50,
  allocation: 'PRIOR_24H_QUOTE_VOLUME_DESC_THEN_SYMBOL', universe: MOMENTUM4H_UNIVERSE } as const;
const H4=14_400_000, DAY=86_400_000;
export interface MomentumBar extends FuturesKline { quoteVolume: number }
export interface MomentumFunding { fundingTime: number; fundingRate: number }
export interface MomentumSnapshot { dualFeatures?: MomentumFeature[]; candles: Record<string,MomentumBar[]>; funding: Record<string,MomentumFunding[]> }
export interface MomentumFeature { dual?: {improvementId?:string;confirmationLevel?:number;entryEvidence?:Record<string,number|string>;family:"MOMENTUM"|"FADE";sourceBoundary:number;thesisLevel:number;score:number;signalBar:MomentumBar;entryKind?:string;stopPct?:number;exitKind?:string;maxHoldHours?:number;targetR?:number|null}; symbol:string; decisionTime:number; direction:'LONG'|'SHORT'; ret4d:number;ret7d:number;btcRet7d:number;atr:number;close:number;rawStop:number;volume:number;lastBar:MomentumBar; fundingRateReserve:number }
export interface MomentumPlan extends MomentumFeature { executionProbe?: { id: string; sourceBoundary: number }; policyId:typeof MOMENTUM4H_VERSION; expectedEntry:number; stop:number; qty:number; plannedLoss:number; fundingReserve:number; notional:number; decisionBid:number; decisionAsk:number; quoteCapturedAt:number; deadline:number }
export interface MomentumSizingEvidence {
 reason: string; evaluatedAt: number; executionVenue: 'USD_M_TESTNET';
 riskCapUsd: number; notionalCapUsd: number;
 minNotionalUsd: number; minQty: number; stepSize: number; tickSize: number;
 basisBps?: number; expectedEntry?: number; stop?: number; lossPerUnit?: number;
 rawQty?: number; roundedQty?: number; notionalUsd?: number; plannedLossUsd?: number;
 limitingFactor?: 'RISK_BUDGET'|'NOTIONAL_CAP';
}
export interface MomentumCandidateReadiness {
 sizing?: boolean; admission?: boolean; entryAttempted?: boolean;
 executionVenue: 'USD_M_TESTNET'; evaluatedAt: number; minNotionalUsd?: number;
 quoteAt?: number; quoteAgeMs?: number; sizingEvidence?: MomentumSizingEvidence;
}
export interface MomentumBatch { decisionTime:number; status:string; observedAt:string; candidates:Array<{symbol:string; reason:string|null; feature?:MomentumFeature; readiness?:MomentumCandidateReadiness}>; error?:string }
export function momentumDecisionTime(now:number):number {return Math.floor(now/DAY)*DAY+8*3_600_000;}
export function momentumWindow(now:number, armedAt:number):boolean {const t=momentumDecisionTime(now);return Number.isFinite(armedAt)&&armedAt<=t&&now>=t&&now-t<=95_000;}
export function momentumBarsValid(b:MomentumBar[], t:number):boolean {
 return b.length>=49 && b.at(-1)!.closeTime===t-1 && b.every((x,i)=>x.openTime%H4===0&&x.closeTime===x.openTime+H4-1&&x.closeTime<t&&[x.open,x.high,x.low,x.close].every(v=>Number.isFinite(v)&&v>0)&&Number.isFinite(x.quoteVolume)&&x.quoteVolume>=0&&x.high>=Math.max(x.open,x.close)&&x.low<=Math.min(x.open,x.close)&&x.high>=x.low&&(!i||x.openTime===b[i-1]!.openTime+H4));
}
export function momentumFeature(symbol:string, snapshot:MomentumSnapshot, t:number):MomentumFeature|null {
 const b=snapshot.candles[symbol],btc=snapshot.candles.BTCUSDT;
 if(!b||!btc||!momentumBarsValid(b,t)||!momentumBarsValid(btc,t))throw new Error('MOMENTUM_INCOMPLETE_4H_HISTORY:'+symbol);
 const i=b.length-1, last=b[i]!,ret4d=last.close/b[i-24]!.close-1,ret7d=last.close/b[i-42]!.close-1;
 const btcRet7d=btc.at(-1)!.close/btc[btc.length-43]!.close-1,side=Math.sign(ret4d);
 if(ret4d*ret7d<=0||side*btcRet7d<=0)return null;
 const volume=b.slice(-6).reduce((s,x)=>s+x.quoteVolume,0);if(volume<50_000_000)return null;
 const atr=b.slice(-14).reduce((s,x,j)=>s+Math.max(x.high-x.low,Math.abs(x.high-b[i-14+j]!.close),Math.abs(x.low-b[i-14+j]!.close)),0)/14;
 if(!(atr>0))throw new Error('MOMENTUM_INVALID_ATR');
 const f=snapshot.funding[symbol]?.filter(x=>x.fundingTime>=t-DAY&&x.fundingTime<t).sort((a,b)=>a.fundingTime-b.fundingTime);
 if(!f?.length||t-f.at(-1)!.fundingTime>8*3_600_000+60_000||f[0]!.fundingTime-(t-DAY)>8*3_600_000+60_000||f.some((x,j)=>!Number.isFinite(x.fundingRate)||(j>0&&(x.fundingTime<=f[j-1]!.fundingTime||x.fundingTime-f[j-1]!.fundingTime>8*3_600_000+60_000))))throw new Error('MOMENTUM_FUNDING_HISTORY_UNAVAILABLE:'+symbol);
 return {symbol,decisionTime:t,direction:side>0?'LONG':'SHORT',ret4d,ret7d,btcRet7d,atr,close:last.close,rawStop:last.close-side*2*atr,volume,lastBar:last,fundingRateReserve:8*f.reduce((s,x)=>s+Math.abs(x.fundingRate),0)};
}
function round(x:number,tick:number,up:boolean){return Number(((up?Math.ceil(x/tick-1e-8):Math.floor(x/tick+1e-8))*tick).toPrecision(14));}
export function momentumLoss(plan:Pick<MomentumPlan,'direction'|'stop'|'fundingRateReserve'>,entry:number,qty:number,tick:number):number {
 const side=plan.direction==='LONG'?1:-1,stopFill=round(plan.stop*(1-side*.0005),tick,side<0);
 return qty*(side*(entry-stopFill)+(entry+stopFill)*.0005+plan.fundingRateReserve*entry);
}
export function momentumPlan(f:MomentumFeature,filter:FuturesSymbolFilters,bid:number,ask:number,at:number,observe?:(e:MomentumSizingEvidence)=>void):MomentumPlan|null {
 // Observe the exact calculation used by entry. No second sizing model or market request.
 const evidence:MomentumSizingEvidence={reason:'NOT_EVALUATED',evaluatedAt:at,executionVenue:'USD_M_TESTNET',riskCapUsd:.25,notionalCapUsd:25,minNotionalUsd:filter.minNotional,minQty:filter.minQty,stepSize:filter.stepSize,tickSize:filter.tickSize};
 const reject=(reason:string):null=>{evidence.reason=reason;observe?.(evidence);return null;};
 if(![bid,ask,filter.tickSize,filter.stepSize].every(x=>Number.isFinite(x)&&x>0)||ask<bid)return reject('INVALID_QUOTE_OR_FILTER');
 if(at<f.decisionTime||at-f.decisionTime>95_000)return reject('ENTRY_WINDOW_EXPIRED');
 const side=f.direction==='LONG'?1:-1,quote=side>0?ask:bid;
 // Mainnet signals cannot authorize a materially different Testnet market.
 evidence.basisBps=(quote/f.close-1)*10_000;
 if(Math.abs(quote/f.close-1)>.005)return reject('VENUE_BASIS_EXCEEDED');
 const entry=round(quote*(1+side*.0005),filter.tickSize,side>0);
 if(f.dual?.improvementId && f.dual.family==='MOMENTUM') {
  const level=f.dual.confirmationLevel;
  if(!level || side*(entry-level)<=0 || side*(entry-level)/entry>((f.dual.stopPct??2)/100)*.5+1e-10) return reject('MOMENTUM_EXTENSION_OR_LOST_BREAKOUT');
 }
 const stop=round(f.dual?entry*(1-side*(f.dual.stopPct??2)/100):side>0?Math.min(f.rawStop,entry*.995):Math.max(f.rawStop,entry*1.005),filter.tickSize,side<0);
 evidence.expectedEntry=entry;evidence.stop=stop;
 const risk=side*(entry-stop);if(!(stop>0&&risk>0&&risk/entry<=.10))return reject('STOP_DISTANCE_INVALID');
 const perUnit=momentumLoss({...f,stop},entry,1,filter.tickSize);
 const qty=round(Math.min(25/entry,.25/perUnit),filter.stepSize,false);
 Object.assign(evidence,{lossPerUnit:perUnit,rawQty:Math.min(25/entry,.25/perUnit),roundedQty:qty,notionalUsd:qty*entry,plannedLossUsd:qty*perUnit,limitingFactor:.25/perUnit<25/entry?'RISK_BUDGET':'NOTIONAL_CAP'});
 if(!(qty>0))return reject('QUANTITY_ROUNDED_TO_ZERO');
 if(!(qty>=filter.minQty))return reject('BELOW_MIN_QUANTITY');
 if(!(qty*entry>=filter.minNotional-1e-8))return reject('BELOW_MIN_NOTIONAL');
 evidence.reason='SIZING_PASSED';observe?.(evidence);
 return {...f,policyId:MOMENTUM4H_VERSION,expectedEntry:entry,stop,qty,plannedLoss:qty*perUnit,fundingReserve:qty*f.fundingRateReserve*entry,notional:qty*entry,decisionBid:bid,decisionAsk:ask,quoteCapturedAt:at,deadline:f.decisionTime+(f.dual?(f.dual.maxHoldHours??(f.dual.family==='MOMENTUM'?12:24)):48)*3_600_000};
}
/** Bounded public snapshot. Reuse validated historical bars, but always fetch final candle and funding. */
export async function fetchMomentumSnapshot(t:number, get:(url:string)=>Promise<Response>, prepared?:MomentumSnapshot):Promise<MomentumSnapshot>{
 const result:MomentumSnapshot={candles:{},funding:{}};
 for(let i=0;i<MOMENTUM4H_UNIVERSE.length;i+=4){
  const chunk=await Promise.allSettled(MOMENTUM4H_UNIVERSE.slice(i,i+4).map(async symbol=>{
   const base=prepared?.candles[symbol];
   const warm=base&&momentumBarsValid(base,t-H4)?base.slice(-48):[];
   const kr=await get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&endTime=${t-1}&limit=${warm.length?1:49}`);
   if(!kr.ok)throw new Error(`MOMENTUM_KLINES_HTTP_${kr.status}:${symbol}`);
   const rows:unknown=await kr.json();if(!Array.isArray(rows))throw new Error('MOMENTUM_KLINES_FORMAT');
   result.candles[symbol]=warm.concat(rows.map((r:any)=>({openTime:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),closeTime:Number(r[6]),quoteVolume:Number(r[7])})));
   const fr=await get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${t-DAY}&endTime=${t-1}&limit=100`);
   if(!fr.ok)throw new Error(`MOMENTUM_FUNDING_HTTP_${fr.status}:${symbol}`);
   const fs:unknown=await fr.json();if(!Array.isArray(fs))throw new Error('MOMENTUM_FUNDING_FORMAT');
   result.funding[symbol]=fs.map((r:any)=>({fundingTime:Number(r.fundingTime),fundingRate:Number(r.fundingRate)}));
  }));
  const failed=chunk.find(x=>x.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
 }
 return result;
}

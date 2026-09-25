import {DUAL4H_IMPROVEMENT} from './dual4h-improvement.js';
import {Dual4hForwardStudy} from './dual4h-forward-study.js';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {DUAL4H_UNIVERSE,DUAL4H_SYMBOLS} from './dual4h-universe.js';
import {momentumBarsValid,type MomentumBar,type MomentumFeature,type MomentumSnapshot,type MomentumFunding} from './daily-momentum4h.js';
const Q=900000,H4=14400000,DAY=86400000;
export const DUAL4H_VERSION='dual4h-momentum-fade-net2-give50-v1';
export function dualWindow(now:number,armed:number){return Number.isFinite(armed)&&armed<=now&&now%Q<=95000;}
export function dualArtifactValid(now:number){return now>=Date.parse(DUAL4H_UNIVERSE.asOf)&&now<Date.parse(DUAL4H_UNIVERSE.expiresAt);}
export function dualFeatures(snapshot:MomentumSnapshot,bars15:Record<string,MomentumBar[]>,t:number,improved=false):MomentumFeature[]{
 if(t%Q||!dualArtifactValid(t))return [];
 const out:MomentumFeature[]=[];
 for(const family of ['MOMENTUM','FADE'] as const)for(const member of DUAL4H_UNIVERSE.groups[family]){
  const direct=member.entryKind==='MOMENTUM_DIRECT'&&!improved;
  const boundary=direct?t:Math.floor((t-1)/H4)*H4;
  if(direct&&(t/3600000)%24!==8)continue;
  const btc=(snapshot.candles.BTCUSDT??[]).filter(z=>z.closeTime<boundary).slice(-49);
  const s=member.symbol,b=(snapshot.candles[s]??[]).filter(z=>z.closeTime<boundary).slice(-49),a=(bars15[s]??[]).filter(z=>z.closeTime<t);
  if(!momentumBarsValid(b,boundary)||a.length<5||a.at(-1)!.closeTime!==t-1)continue;
  const segment=a.filter(z=>z.openTime>=boundary-Q*4);
  if(segment.length<(direct?4:5)||segment.some((z,i)=>i>0&&z.openTime!==segment[i-1]!.openTime+Q))continue;
  if(improved&&segment.some(z=>z.closeTime!==z.openTime+Q-1||![z.open,z.high,z.low,z.close].every(v=>Number.isFinite(v)&&v>0)||z.high<Math.max(z.open,z.close)||z.low>Math.min(z.open,z.close)))continue;
  const last=b.at(-1)!,volume=b.slice(-6).reduce((n,z)=>n+z.quoteVolume,0);if(volume<1e7)continue;
  const funds=(snapshot.funding[s]??[]).filter(z=>z.fundingTime>=boundary-DAY&&z.fundingTime<boundary).sort((a,b)=>a.fundingTime-b.fundingTime);
  if(!funds.length||boundary-funds.at(-1)!.fundingTime>8*3600000+60000||funds[0]!.fundingTime-(boundary-DAY)>8*3600000+60000||funds.some((z,i)=>!Number.isFinite(z.fundingRate)||(i>0&&z.fundingTime-funds[i-1]!.fundingTime>8*3600000+60000)))continue;
  const r4=last.close/b[b.length-25]!.close-1,r7=last.close/b[b.length-43]!.close-1;
  const br=momentumBarsValid(btc,boundary)?btc.at(-1)!.close/btc[btc.length-43]!.close-1:0;
  let side=0,signal:MomentumBar|undefined,confirmationLevel:number|undefined;
  if(family==='MOMENTUM'){
   if((boundary/3600000)%24!==8||t>boundary+3600000||r4*r7<=0||Math.sign(r4)*br<=0)continue;
   side=Math.sign(r4);
   if(direct)signal=last;
   for(let i=0;!signal&&i<a.length;i++){
    const z=a[i]!;if(z.openTime<boundary||z.openTime>=boundary+3600000||i<4)continue;
    const prev=a.slice(i-4,i),level=side>0?Math.max(...prev.map(z=>z.high)):Math.min(...prev.map(z=>z.low));
    if(side*(z.close-level)>0){
     if(!improved){signal=z;break;}
     const next=a[i+1];
     if(next&&next.openTime===z.openTime+Q&&next.openTime<boundary+3600000&&side*(next.close-level)>0){
      signal=next;confirmationLevel=level;break;
     }
    }
   }
  }else{
   let outside=0;
   for(const z of a.filter(z=>z.openTime>=boundary&&z.openTime<boundary+H4)){
    if(outside&&z.close>=last.low&&z.close<=last.high){
     if(!improved){side=-outside;signal=z;break;}
     const next=a.find(n=>n.openTime===z.openTime+Q);
     if(next&&next.openTime<boundary+H4&&next.close>=last.low&&next.close<=last.high){side=-outside;signal=next;break;}
    }
    if(z.close>last.high)outside=1;else if(z.close<last.low)outside=-1;
   }
  }
  if(!signal||signal.closeTime!==t-1)continue;
  if(improved){
   if(family==='MOMENTUM'&&(!confirmationLevel||side*(signal.close-confirmationLevel)/signal.close>(member.stopPct/100)*DUAL4H_IMPROVEMENT.momentum.maxExtensionR))continue;
   if(family==='FADE'){
    if(!momentumBarsValid(btc,boundary))continue;
    const move=last.close/b[b.length-7]!.close-1,btcMove=btc.at(-1)!.close/btc[btc.length-7]!.close-1;
    const distance=b.slice(-6).reduce((n,z,i)=>n+Math.abs(z.close-b[b.length-7+i]!.close),0);
    const efficiency=distance>0?Math.abs(last.close-b[b.length-7]!.close)/distance:0;
    if((-side*btcMove>=DUAL4H_IMPROVEMENT.fade.strongBtc24hPct/100)||(-side*move>=DUAL4H_IMPROVEMENT.fade.strongCoin24hPct/100&&efficiency>=DUAL4H_IMPROVEMENT.fade.efficiencyMin))continue;
   }
  }
  out.push({symbol:s,decisionTime:t,direction:side>0?'LONG':'SHORT',ret4d:r4,ret7d:r7,btcRet7d:br,atr:0,close:signal.close,rawStop:signal.close*(1-side*member.stopPct/100),volume,lastBar:last,
   fundingRateReserve:2*funds.reduce((n,z)=>n+Math.abs(z.fundingRate),0)*member.maxHoldHours/24,dual:{...(improved?{improvementId:DUAL4H_IMPROVEMENT.id,confirmationLevel,entryEvidence:{confirmationCloses:2,maxExtensionR:.5}}:{}),family,entryKind:member.entryKind,stopPct:member.stopPct,exitKind:member.exitKind,maxHoldHours:member.maxHoldHours,targetR:member.targetR,sourceBoundary:boundary,thesisLevel:side>0?last.low:last.high,score:member.score,signalBar:signal}});
 }
 return out.sort((a,b)=>(b.dual!.score-a.dual!.score)||a.symbol.localeCompare(b.symbol)||a.dual!.family.localeCompare(b.dual!.family));
}
/** Persistent completed-candle cache. Stream supplies closes; paced REST only warms/repairs and refreshes funding. */
export class Dual4hCollection{
 private state:{candles:Record<string,MomentumBar[]>;bars15:Record<string,MomentumBar[]>;funding:Record<string,MomentumFunding[]>;fundAt:Record<string,number>}={candles:{},bars15:{},funding:{},fundAt:{}};
 readonly study: Dual4hForwardStudy;
 private bookSocket:WebSocket|null=null;private bookConnected=false;private lastBookAt=0;private bookOpenedAt=0;private bookSymbols=new Set<string>();private bookSubscriptionAt=0;
 private socket:WebSocket|null=null;private connected=false;private busy=false;private retryAt=0;private closed=false;
 private errors:Record<string,string>={};private lastSave=0;private lastStreamAt:number|null=null;
 readonly symbols=[...new Set(['BTCUSDT',...DUAL4H_SYMBOLS])];
 constructor(private file:string,private get:(url:string)=>Promise<Response>,private now:()=>number=Date.now){this.study=new Dual4hForwardStudy(file.replace(/\.json$/, '-forward-v2.json'),now);try{const d=JSON.parse(readFileSync(file,'utf8'));if(d.version===DUAL4H_VERSION)this.state=d.state;}catch{}}
 private save(){mkdirSync(dirname(this.file),{recursive:true});writeFileSync(this.file+'.tmp',JSON.stringify({version:DUAL4H_VERSION,state:this.state}));renameSync(this.file+'.tmp',this.file);this.lastSave=this.now();}
 private merge(symbol:string,interval:string,rows:MomentumBar[]){const map=interval==='4h'?this.state.candles:this.state.bars15;const by=new Map((map[symbol]??[]).map(z=>[z.openTime,z]));for(const z of rows)if(z.closeTime<this.now())by.set(z.openTime,z);map[symbol]=[...by.values()].sort((a,b)=>a.openTime-b.openTime).slice(interval==='4h'?-54:-40);}
 private connect(){
  if(this.socket||this.closed||typeof WebSocket==='undefined')return;
  const socket=new WebSocket('wss://fstream.binance.com/market/ws');this.socket=socket;
  socket.addEventListener('open',()=>{socket.send(JSON.stringify({method:'SUBSCRIBE',params:this.symbols.flatMap(s=>[s.toLowerCase()+'@kline_15m',s.toLowerCase()+'@kline_4h']),id:1}));});
  socket.addEventListener('message',event=>{try{const z=JSON.parse(String(event.data));if(z.id===1&&z.result===null){this.connected=true;delete this.errors.STREAM;return;}if(z.error){this.errors.STREAM=JSON.stringify(z.error);return;}const k=z.k;if(z.e!=='kline'||!k?.x||!this.symbols.includes(z.s)||!['15m','4h'].includes(k.i))return;
   const b={openTime:Number(k.t),closeTime:Number(k.T),open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c),volume:Number(k.v),quoteVolume:Number(k.q)};
   if(!Object.values(b).every(Number.isFinite)||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.low<=0||b.closeTime!==b.openTime+(k.i==='4h'?H4:Q)-1)return;
   this.merge(z.s,k.i,[b]);this.lastStreamAt=this.now();this.observeResearch();if(this.now()-this.lastSave>5000)this.save();
  }catch(error){this.errors.STREAM=String(error);}});
  socket.addEventListener('error',()=>{this.errors.STREAM='stream error; REST repair required';socket.close();});
  socket.addEventListener('close',()=>{this.connected=false;this.socket=null;this.study.markGap('STREAM_DISCONNECTED');});
 }
 private researchBookSymbols(){
  // Subscribe only to pending/open research paths; idle research needs no BBO traffic.
  // All-universe high-frequency BBO floods can backlog and make every quote stale.
  return [...new Set([...this.study.rows.filter(r=>r.status==='OPEN'||r.status==='WAITING_QUOTE').map(r=>r.feature.symbol)])];
 }
 private refreshBooks(){
  if(!this.bookSocket||!this.bookConnected||this.now()-this.bookSubscriptionAt<1000)return;
  const desired=new Set(this.researchBookSymbols()),added=[...desired].filter(s=>!this.bookSymbols.has(s)),removed=[...this.bookSymbols].filter(s=>!desired.has(s));
  if(!added.length&&!removed.length)return;
  if(added.length)this.bookSocket.send(JSON.stringify({method:'SUBSCRIBE',params:added.map(s=>s.toLowerCase()+'@bookTicker'),id:3}));
  if(removed.length)this.bookSocket.send(JSON.stringify({method:'UNSUBSCRIBE',params:removed.map(s=>s.toLowerCase()+'@bookTicker'),id:4}));
  if(added.length)this.bookOpenedAt=this.now();this.bookSymbols=desired;this.bookSubscriptionAt=this.now();
 }
 private connectBooks(){
  if(this.closed||typeof WebSocket==='undefined')return;
  if(this.bookSocket){if(this.bookSymbols.size&&this.now()-Math.max(this.study.status().lastMarketQuoteAt??0,this.bookOpenedAt)>60000)this.bookSocket.close();else this.refreshBooks();return;}
  // bookTicker belongs to /public/ws; /market/ws may ACK but never emit it.
  const socket=new WebSocket('wss://fstream.binance.com/public/ws');this.bookSocket=socket;this.lastBookAt=this.now();this.bookOpenedAt=this.now();
  socket.addEventListener('open',()=>{this.bookSymbols=new Set(this.researchBookSymbols());this.bookSubscriptionAt=this.now();socket.send(JSON.stringify(this.bookSymbols.size?{method:'SUBSCRIBE',params:[...this.bookSymbols].map(s=>s.toLowerCase()+'@bookTicker'),id:2}:{method:'LIST_SUBSCRIPTIONS',id:2}));});
  socket.addEventListener('message',event=>{try{
   const z=JSON.parse(String(event.data));if(z.id===2&&(z.result===null||Array.isArray(z.result))){this.bookConnected=true;return;}
   if(z.error){this.errors.RESEARCH_BOOK=JSON.stringify(z.error);return;}
   if(z.e==='bookTicker'&&this.symbols.includes(z.s)&&+z.B>0&&+z.A>0){this.lastBookAt=this.now();this.study.quote(z.s,+z.b,+z.a,+(z.T??z.E),this.now());delete this.errors.RESEARCH_BOOK;}
  }catch(error){this.errors.RESEARCH_BOOK=String(error);}});
  socket.addEventListener('error',()=>{this.errors.RESEARCH_BOOK='book stream error';socket.close();});
  socket.addEventListener('close',()=>{this.bookConnected=false;this.bookSocket=null;this.bookSymbols.clear();this.study.markGap('BOOK_STREAM_DISCONNECTED');});
 }
 async maintain(){
  this.observeResearch();this.connect();this.connectBooks();if(this.busy||this.now()<this.retryAt||this.closed)return;this.busy=true;
  try{for(const s of this.symbols){
   if(this.closed)break;const now=this.now(),h=Math.floor(now/H4)*H4,q=Math.floor(now/Q)*Q;
   try{
    for(const [interval,end,limit] of [['4h',h,54],['15m',q,40]] as const){
     const cache=interval==='4h'?this.state.candles[s]:this.state.bars15[s];
     if(cache?.at(-1)?.closeTime===end-1&&(interval==='15m'?cache.length>=20:momentumBarsValid(cache.slice(-49),end)))continue;
     const r=await this.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${interval}&endTime=${end-1}&limit=${limit}`);if(!r.ok)throw new Error('KLINE_HTTP_'+r.status);
     const raw=await r.json();if(!Array.isArray(raw))throw new Error('KLINE_FORMAT');this.merge(s,interval,raw.map((z:any)=>({openTime:+z[0],open:+z[1],high:+z[2],low:+z[3],close:+z[4],volume:+z[5],closeTime:+z[6],quoteVolume:+z[7]})));
    }
    if((this.state.fundAt[s]??0)<h){const r=await this.get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${h-DAY-H4}&endTime=${h-1}&limit=100`);if(!r.ok)throw new Error('FUNDING_HTTP_'+r.status);const raw=await r.json();if(!Array.isArray(raw))throw new Error('FUNDING_FORMAT');this.state.funding[s]=raw.map((z:any)=>({fundingTime:+z.fundingTime,fundingRate:+z.fundingRate}));this.state.fundAt[s]=h;}
    delete this.errors[s];this.observeResearch();this.save();
   }catch(error){this.errors[s]=String(error);if(/418|429|cooldown|rate.limit/i.test(String(error))){this.retryAt=this.now()+60000;break;}}
  }}finally{this.busy=false;}
 }
 private observeResearch(){
  const now=this.now(),t=Math.floor(now/Q)*Q;
  this.study.advanceTime(now,this.state.candles);
  if(now-t<=95000&&dualArtifactValid(t)){
   for(const improved of [false,true])for(const f of dualFeatures(this.state,this.state.bars15,t,improved))this.study.observe(f,improved?'CONFIRMED_V2':'BASELINE_V1');
  }
  this.refreshBooks();this.study.flush();
 }
 async read(t:number):Promise<MomentumSnapshot>{if(this.now()<t)throw new Error('DUAL_CANDLE_NOT_CLOSED');this.observeResearch();return {...this.state,dualFeatures:dualFeatures(this.state,this.state.bars15,t,true)};}
 status(){const now=this.now(),h=Math.floor(now/H4)*H4,q=Math.floor(now/Q)*Q;return {policyId:DUAL4H_VERSION,improvement:DUAL4H_IMPROVEMENT,forwardStudy:this.study.status(),universe:DUAL4H_UNIVERSE,artifactValid:dualArtifactValid(now),requiredSymbols:this.symbols.length,streamConnected:this.connected,bookStreamConnected:this.bookConnected,bookStreamMode:this.researchBookSymbols().length?'TRACKING_SIGNALS':'IDLE_WAITING_SIGNAL',lastBookReceivedAt:this.lastBookAt||null,bookSubscribedSymbols:[...this.bookSymbols],lastStreamAt:this.lastStreamAt,collecting:this.busy,errors:this.errors,symbols:this.symbols.map(symbol=>({symbol,historyReady:momentumBarsValid((this.state.candles[symbol]??[]).slice(-49),h),last15mClose:this.state.bars15[symbol]?.at(-1)?.closeTime??null,signalDataReady:this.state.bars15[symbol]?.at(-1)?.closeTime===q-1,fundingThrough:this.state.fundAt[symbol]??null}))};}
 close(){this.study.flush(true);this.closed=true;this.socket?.close();this.bookSocket?.close();}
}

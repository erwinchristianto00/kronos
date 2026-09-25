import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchMomentumSnapshot, momentumBarsValid, momentumDecisionTime, momentumFeature, MOMENTUM4H_UNIVERSE, MOMENTUM4H_VERSION, type MomentumSnapshot } from './daily-momentum4h.js';
const H4=14_400_000, DAY=86_400_000;
interface CollectionState {
 version: string; decisionTime: number; preparedAt?: string; completedAt?: string;
 prepared?: MomentumSnapshot; completed?: MomentumSnapshot; lastError?: string; lastAttemptAt?: string;
}
/** Read-only collector. Historical warmup never blocks operational reconciliation or permits entry. */
export class Momentum4hCollection {
 private state: CollectionState | null=null;
 private pending: Promise<MomentumSnapshot> | null=null;
 private pendingTarget: number | null=null;
 private warming: Promise<void> | null=null;
 private retryAt=0;
 constructor(private readonly file:string, private readonly get:(url:string)=>Promise<Response>, private readonly now:()=>number=Date.now) {
  try {const s=JSON.parse(readFileSync(file,'utf8')) as CollectionState;if(s.version===MOMENTUM4H_VERSION)this.state=s;}catch {/* No usable cache: collect fresh. */}
 }
 private valid(snapshot:MomentumSnapshot|undefined,boundary:number):snapshot is MomentumSnapshot {
  return !!snapshot&&MOMENTUM4H_UNIVERSE.every(symbol=>Array.isArray(snapshot.candles?.[symbol])&&momentumBarsValid(snapshot.candles[symbol]!,boundary));
 }
 private save(){mkdirSync(dirname(this.file),{recursive:true});const temp=this.file+'.tmp';writeFileSync(temp,JSON.stringify(this.state));renameSync(temp,this.file);}
 status():Record<string,unknown>{
  const now=this.now(),t=now<=momentumDecisionTime(now)+95_000?momentumDecisionTime(now):momentumDecisionTime(now)+DAY;
  const s=this.state?.decisionTime===t?this.state:null;
  const ready=this.valid(s?.prepared,t-H4),complete=this.valid(s?.completed,t);
  return {decisionAt:new Date(t).toISOString(),state:complete?'COMPLETE':this.pending?'FINALIZING':ready?'HISTORY_READY_WAITING_FINAL_CLOSE':this.warming?'PREPARING':'NOT_READY',
   symbolsReady:complete||ready?20:0,requiredSymbols:20,historyBarsPerSymbol:ready?49:0,decisionBarsPerSymbol:complete?49:0,
   historyThrough:ready?new Date(t-H4-1).toISOString():null,requiredFinalClose:new Date(t-1).toISOString(),
   preparedAt:s?.preparedAt??null,completedAt:s?.completedAt??null,lastError:s?.lastError??null,lastAttemptAt:s?.lastAttemptAt??null,
   lastCollection:this.state?{decisionAt:new Date(this.state.decisionTime).toISOString(),preparedAt:this.state.preparedAt??null,completedAt:this.state.completedAt??null,lastError:this.state.lastError??null}:null};
 }
 async maintain():Promise<void>{
  const now=this.now(),t=momentumDecisionTime(now);
  if(now>=t&&now<=t+95_000){if(now>=this.retryAt)await this.read(t);return;}
  if(now<t-H4||now>=t||now<this.retryAt||this.warming||this.valid(this.state?.decisionTime===t?this.state.prepared:undefined,t-H4))return;
  this.state={version:MOMENTUM4H_VERSION,decisionTime:t,lastAttemptAt:new Date(now).toISOString()};this.save();
  this.warming=(async()=>{
   try {
    const snapshot=await fetchMomentumSnapshot(t-H4,this.get);
    if(!this.valid(snapshot,t-H4))throw new Error('MOMENTUM_WARMUP_HISTORY_INCOMPLETE');
    // Do not replace a final snapshot if the boundary passed while warming.
    if(this.state?.decisionTime===t){this.state.prepared=snapshot;this.state.preparedAt=new Date(this.now()).toISOString();delete this.state.lastError;this.save();}
   } catch(error){this.retryAt=this.now()+60_000;if(this.state?.decisionTime===t){this.state.lastError=error instanceof Error?error.message:String(error);this.save();}throw error;}
  })();
  try {await this.warming;}finally{this.warming=null;}
 }
 async read(t:number):Promise<MomentumSnapshot>{
  if(this.now()<t)throw new Error('MOMENTUM_FINAL_CANDLE_NOT_CLOSED');
  // An off-schedule execution probe must not evict the upcoming daily warmup.
  if(t!==momentumDecisionTime(t))return fetchMomentumSnapshot(t,this.get);
  if(this.state?.decisionTime===t&&this.valid(this.state.completed,t)){
   for(const symbol of MOMENTUM4H_UNIVERSE)momentumFeature(symbol,this.state.completed,t);
   return this.state.completed;
  }
  if(this.pending&&this.pendingTarget===t)return this.pending;
  // A manual read at another boundary cannot overwrite an in-flight scheduled snapshot.
  if(this.pending)throw new Error('MOMENTUM_COLLECTION_BUSY');
  const prepared=this.state?.decisionTime===t&&this.valid(this.state.prepared,t-H4)?this.state.prepared:undefined;
  this.state={...((this.state?.decisionTime===t)?this.state:{}),version:MOMENTUM4H_VERSION,decisionTime:t,lastAttemptAt:new Date(this.now()).toISOString()};this.save();
  this.pendingTarget=t;
  this.pending=(async()=>{
   try {
    const snapshot=await fetchMomentumSnapshot(t,this.get,prepared);
    for(const symbol of MOMENTUM4H_UNIVERSE)momentumFeature(symbol,snapshot,t);
    this.state!.completed=snapshot;this.state!.completedAt=new Date(this.now()).toISOString();delete this.state!.lastError;this.save();return snapshot;
   }catch(error){this.retryAt=this.now()+5_000;this.state!.lastError=error instanceof Error?error.message:String(error);this.save();throw error;}
  })();
  try{return await this.pending;}finally{this.pending=null;this.pendingTarget=null;}
 }
}

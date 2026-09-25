import type { Candle } from "@dtc/shared";

export const THREE_LEG_QUALITY_POLICY = "testnet-three-leg-symbol-quality-v2" as const;
/** Initial Testnet limits, not optimized or a forecast of realized returns. */
export const THREE_LEG_QUALITY_LIMITS = Object.freeze({
  candles: 48, correlationHours: 24, maxAbsCorrelation: 0.85, maxRiskShare: 0.5,
  minAlignedHoursOf3: 2, minMomentumRetention: 0.5,
  maxExtensionAtr: 2.5, maxRangeAtr: 2.5, maxBodyAtr: 1.5,
  maxRejectionWickFraction: 0.55, maxInvalidationAtr: 2,
  minNetRewardRisk: 1.25, minRewardCostMultiple: 3,
  roundtripCostRate: 0.0015, maxQuoteAgeMs: 5_000, maxSpreadBps: 10,
});
export type SymbolQuality = {
  symbol: string; direction: "LONG" | "SHORT"; cutoffMs: number;
  allowed: boolean; reasons: string[]; entry: number; atr: number; ema: number;
  extensionAtr: number; alignedHours: number; recent3Return: number; prior3Return: number;
  maxRangeAtr: number; maxBodyAtr: number; rejectionWickFraction: number;
  failedBreakout: boolean; invalidation: number; target: number;
  targetSource: "PRIOR_SWING" | "TWO_ATR_SCENARIO" | "BALANCED_ATR_SCENARIO";
  riskPct: number; rewardPct: number; netRewardRisk: number;
  returns: number[];
};
const HOUR = 3_600_000;
const mean = (a: number[]) => a.reduce((s,v)=>s+v,0)/a.length;
export function assessThreeLegSymbol(symbol: string, direction: "LONG"|"SHORT", candles: readonly Candle[] | undefined, cutoffMs: number): SymbolQuality {
  const q: SymbolQuality = {symbol,direction,cutoffMs,allowed:false,reasons:[],entry:0,atr:0,ema:0,extensionAtr:0,
    alignedHours:0,recent3Return:0,prior3Return:0,maxRangeAtr:0,maxBodyAtr:0,rejectionWickFraction:0,failedBreakout:false,
    invalidation:0,target:0,targetSource:"TWO_ATR_SCENARIO",riskPct:0,rewardPct:0,netRewardRisk:0,returns:[]};
  const reject=(r:string)=>{q.reasons.push(r);return q;};
  const cs=(candles??[]).slice(-THREE_LEG_QUALITY_LIMITS.candles);
  if(cs.length!==48 || !Number.isFinite(cutoffMs) || cs.some((c,i)=>
    c.openTime!==cutoffMs-(48-i)*HOUR || ![c.open,c.high,c.low,c.close].every(v=>Number.isFinite(v)&&v>0)
    || c.high<Math.max(c.open,c.close) || c.low>Math.min(c.open,c.close) || c.high<c.low)) return reject("QUALITY_CANDLES_MISSING_STALE_OR_INVALID");
  const sign=direction==="LONG"?1:-1, last=cs[47]!;
  q.entry=last.close;
  const trs=cs.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-cs[i]!.close),Math.abs(c.low-cs[i]!.close)));
  // Prior ATR avoids letting the current spike normalize away its own warning.
  q.atr=mean(trs.slice(-15,-1));
  q.ema=cs.reduce((ema,c)=>ema+(2/21)*(c.close-ema),cs[0]!.close);
  if(!(q.atr>0))return reject("QUALITY_VOLATILITY_UNAVAILABLE");
  const returns=cs.slice(1).map((c,i)=>Math.log(c.close/cs[i]!.close));
  q.returns=returns.slice(-24);
  q.alignedHours=returns.slice(-3).filter(v=>sign*v>0).length;
  q.recent3Return=sign*Math.log(last.close/cs[44]!.close);
  q.prior3Return=sign*Math.log(cs[44]!.close/cs[41]!.close);
  q.extensionAtr=sign*(q.entry-q.ema)/q.atr;
  q.maxRangeAtr=Math.max(...trs.slice(-3))/q.atr;
  q.maxBodyAtr=Math.max(...cs.slice(-3).map(c=>Math.abs(c.close-c.open)))/q.atr;
  const range=last.high-last.low;
  const wick=direction==="LONG"?last.high-Math.max(last.open,last.close):Math.min(last.open,last.close)-last.low;
  q.rejectionWickFraction=range>0?wick/range:0;
  const prior=cs.slice(-9,-1), priorLevel=direction==="LONG"?Math.max(...prior.map(c=>c.high)):Math.min(...prior.map(c=>c.low));
  q.failedBreakout=q.rejectionWickFraction>.5 && (direction==="LONG"?last.high>priorLevel&&last.close<priorLevel&&wick/q.atr>.35:last.low<priorLevel&&last.close>priorLevel&&wick/q.atr>.35);
  q.invalidation=direction==="LONG"?Math.min(...cs.slice(-3).map(c=>c.low))-.1*q.atr:Math.max(...cs.slice(-3).map(c=>c.high))+.1*q.atr;
  // Nearest completed pivot ahead of entry caps the scenario, never the current bar's high/low.
  const pivots=cs.flatMap((c,i)=>i>0&&i<cs.length-3&&(
    direction==="LONG"?c.high>cs[i-1]!.high&&c.high>=cs[i+1]!.high&&c.high>q.entry:
      c.low<cs[i-1]!.low&&c.low<=cs[i+1]!.low&&c.low<q.entry)?[direction==="LONG"?c.high:c.low]:[]);
  const cap=q.entry+sign*2*q.atr;
  const nearest=pivots.length?(direction==="LONG"?Math.min(...pivots):Math.max(...pivots)):null;
  q.target=nearest!==null&&sign*(nearest-q.entry)<2*q.atr?nearest:cap;
  q.targetSource=q.target===nearest?"PRIOR_SWING":"TWO_ATR_SCENARIO";
  q.riskPct=sign*(q.entry-q.invalidation)/q.entry;
  q.rewardPct=sign*(q.target-q.entry)/q.entry;
  q.netRewardRisk=(q.rewardPct-THREE_LEG_QUALITY_LIMITS.roundtripCostRate)/(q.riskPct+THREE_LEG_QUALITY_LIMITS.roundtripCostRate);
  if(q.alignedHours<2 || sign*returns.at(-1)!<=0 || q.recent3Return<=0 || q.extensionAtr<0)q.reasons.push("QUALITY_TREND_REVERSING");
  if(q.prior3Return>0&&q.recent3Return<.5*q.prior3Return)q.reasons.push("QUALITY_MOMENTUM_DECELERATING");
  if(q.extensionAtr>2.5)q.reasons.push("QUALITY_OVEREXTENDED");
  if(q.maxRangeAtr>2.5||q.maxBodyAtr>1.5)q.reasons.push("QUALITY_EXTREME_SPIKE");
  if(q.rejectionWickFraction>.55&&range/q.atr>=.8)q.reasons.push("QUALITY_REJECTION");
  if(q.failedBreakout)q.reasons.push("QUALITY_FAILED_BREAKOUT");
  if(!(q.riskPct>0)||q.riskPct*q.entry/q.atr>2)q.reasons.push("QUALITY_INVALIDATION_TOO_FAR");
  if(q.netRewardRisk<1.25||q.rewardPct<3*THREE_LEG_QUALITY_LIMITS.roundtripCostRate)q.reasons.push("QUALITY_INSUFFICIENT_ROOM_AFTER_COSTS");
  q.allowed=q.reasons.length===0;return q;
}
export function absoluteReturnCorrelation(a:number[],b:number[]):number|null {
  if(a.length!==24||b.length!==24||![...a,...b].every(Number.isFinite))return null;
  const ma=mean(a),mb=mean(b);let va=0,vb=0,cov=0;
  for(let i=0;i<a.length;i++){const da=a[i]!-ma,db=b[i]!-mb;va+=da*da;vb+=db*db;cov+=da*db;}
  return va>1e-16&&vb>1e-16?Math.min(1,Math.abs(cov/Math.sqrt(va*vb))):null;
}
export function threeLegPortfolioQuality(rows:SymbolQuality[]):{allowed:boolean;reason:string|null;maxAbsCorrelation:number|null;maxRiskShare:number|null} {
  if(rows.length!==3||rows.some(q=>!q.allowed||!Number.isFinite(q.riskPct)||q.riskPct<=0))return {allowed:false,reason:"QUALITY_INVALID_PORTFOLIO",maxAbsCorrelation:null,maxRiskShare:null};
  const correlations=[absoluteReturnCorrelation(rows[0]!.returns,rows[1]!.returns),absoluteReturnCorrelation(rows[0]!.returns,rows[2]!.returns),absoluteReturnCorrelation(rows[1]!.returns,rows[2]!.returns)];
  const max=correlations.some(c=>c===null)?null:Math.max(...correlations as number[]);
  const riskSum=rows.reduce((s,q)=>s+q.riskPct,0),share=Math.max(...rows.map(q=>q.riskPct/riskSum));
  const reason=max===null?"QUALITY_CORRELATION_UNAVAILABLE":max>.85?"QUALITY_CORRELATION_TOO_HIGH":share>.5?"QUALITY_RISK_CONCENTRATED":null;
  return {allowed:reason===null,reason,maxAbsCorrelation:max,maxRiskShare:share};
}
/** Re-evaluate frozen geometry at the current executable touch before every POST. */
export function threeLegPriceReason(q:SymbolQuality|undefined,price:number,formationPriceScale=1):string|null {
  if(!Number.isFinite(formationPriceScale)||formationPriceScale<=0)return "THREE_LEG_QUALITY_SCALE_INVALID";
  price/=formationPriceScale;
  if(!q?.allowed||![price,q.entry,q.atr,q.ema,q.target,q.invalidation].every(Number.isFinite)||price<=0||q.atr<=0)return "THREE_LEG_QUALITY_UNAVAILABLE";
  const sign=q.direction==="LONG"?1:-1,risk=sign*(price-q.invalidation)/price,reward=sign*(q.target-price)/price;
  if(risk<=0||sign*(price-q.ema)<0)return "THREE_LEG_PRICE_REVERSAL";
  if(sign*(price-q.ema)/q.atr>2.5)return "THREE_LEG_PRICE_OVEREXTENDED";
  if((reward-.0015)/(risk+.0015)<1.25||reward<3*.0015)return "THREE_LEG_PRICE_ROOM_EXHAUSTED";
  return null;
}

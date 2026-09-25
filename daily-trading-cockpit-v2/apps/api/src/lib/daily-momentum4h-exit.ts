export const MOMENTUM_EXIT_POLICY = {
 id:'momentum4h-net-ladder-mfe30-tp3-cap48-v1',
 activationNetPct:0.60, minimumNetFloorPct:0.20, retainedPeakFraction:0.70,
 floorStepNetPct:0.05, hardTakeProfitNetPct:3.0, maxHoldHours:48,
 roundTripFeeBps:10, exitSlippageBps:5,
 fundingReserve:'original full planned funding reserve retained conservatively',
 triggerSource:'FRESH_EXECUTABLE_BBO', exitQuantity:'FULL_OWNED_POSITION',
 nativeProtection:'ORIGINAL_ATR_STOP_PLUS_FIXED_TP',
} as const;
export interface MomentumExitState {
 policyId:string;nativeTpRequired?:boolean;adoptedAt:number;deadline:number;
 fundingReserveRate:number;peakNetPct:number|null;floorNetPct:number|null;
 lastNetPct:number|null;lastQuoteAt:number|null;lastSourceAt:number|null;
 nativeTpVerified:boolean;tpSubmitAttempted:boolean;tpSubmissionError:string|null;
 exitIntentAt:number|null;exitReason:string|null;exitQuote:number|null;
}
export function newMomentumExitState(now:number,decisionTime:number,fundingReserveRate:number):MomentumExitState {
 return {policyId:MOMENTUM_EXIT_POLICY.id,adoptedAt:now,deadline:decisionTime+48*3600000,fundingReserveRate,
 peakNetPct:null,floorNetPct:null,lastNetPct:null,lastQuoteAt:null,lastSourceAt:null,nativeTpVerified:false,tpSubmitAttempted:false,tpSubmissionError:null,exitIntentAt:null,exitReason:null,exitQuote:null};
}
export function momentumExitNetPct(entry:number,quote:number,direction:'LONG'|'SHORT',reserveRate:number):number {
 return 100*((direction==='LONG'?1:-1)*(quote-entry)/entry-.0015-reserveRate);
}
export function momentumNativeTp(entry:number,direction:'LONG'|'SHORT',reserveRate:number,tick:number):number {
 const raw=entry*(1+(direction==='LONG'?1:-1)*(.03+.0015+reserveRate));
 return Number(((direction==='LONG'?Math.ceil(raw/tick-1e-8):Math.floor(raw/tick+1e-8))*tick).toPrecision(14));
}
export function advanceMomentumExit(state:MomentumExitState,entry:number,direction:'LONG'|'SHORT',bid:number,ask:number,sourceAt:number,receivedAt:number,now:number):{changed:boolean;floorChanged:boolean;exitReason:string|null} {
 if(![sourceAt,receivedAt,now].every(Number.isFinite)||state.exitIntentAt!==null||![entry,bid,ask].every(x=>Number.isFinite(x)&&x>0)||bid>ask||sourceAt<state.adoptedAt||now<receivedAt||now-receivedAt>5000||receivedAt-sourceAt>5000||sourceAt-receivedAt>1000||sourceAt<(state.lastSourceAt??0))return {changed:false,floorChanged:false,exitReason:null};
 const quote=direction==='LONG'?bid:ask,net=momentumExitNetPct(entry,quote,direction,state.fundingReserveRate),oldFloor=state.floorNetPct;
 state.lastNetPct=net;state.lastQuoteAt=now;state.lastSourceAt=sourceAt;state.peakNetPct=Math.max(state.peakNetPct??-Infinity,net);
 if(state.peakNetPct>=(state.policyId==='dual4h-net2-give50-v1'?2:MOMENTUM_EXIT_POLICY.activationNetPct)-1e-9){
  const floor=Math.floor((state.peakNetPct*(state.policyId==='dual4h-net2-give50-v1'?.5:MOMENTUM_EXIT_POLICY.retainedPeakFraction)+1e-9)/MOMENTUM_EXIT_POLICY.floorStepNetPct)*MOMENTUM_EXIT_POLICY.floorStepNetPct;
  state.floorNetPct=Math.max(oldFloor??-Infinity,MOMENTUM_EXIT_POLICY.minimumNetFloorPct,Number(floor.toFixed(8)));
 }
 const reason=state.policyId!=='dual4h-net2-give50-v1'&&net>=MOMENTUM_EXIT_POLICY.hardTakeProfitNetPct-1e-9?'MOMENTUM_LADDER_TP':state.floorNetPct!==null&&net<=state.floorNetPct+1e-9?(state.policyId==='dual4h-net2-give50-v1'?'DUAL4H_PROFIT_GIVEBACK':'MOMENTUM_MFE_GIVEBACK'):null;
 return {changed:true,floorChanged:oldFloor!==state.floorNetPct,exitReason:reason};
}

export function newDualExitState(now:number,reserve:number,family:"MOMENTUM"|"FADE",hours=family==="MOMENTUM"?12:24,nativeTpRequired=family==="FADE"):MomentumExitState { return {...newMomentumExitState(now,now,reserve),policyId:"dual4h-net2-give50-v1",deadline:now+hours*3600000,nativeTpRequired}; }

import {qualityInput,qualityContext} from './three-leg-quality-fixture.js';
export const LIVE_THREE_VERSION='dynamic-mom36-cont-slowfast-bounded-skew-sl2-mfe30-36h-v6.4';
export function liveQualityContext(cut:number,side:'LONG'|'SHORT'='LONG') {
 return {...qualityContext(cut,side),venue:'mainnet',liveBalanced:true,qualityV2:false,qualityV3:false};
}
export function liveQualityInput(cut:number,side:'LONG'|'SHORT'='LONG') {
 const i=qualityInput(cut,side);i.strategyVersion=LIVE_THREE_VERSION;i.allowedLongCounts=[2,3,4];i.requireSkewContinuationConfirmation=true;i.threeLegContext=liveQualityContext(cut,side);return i;
}

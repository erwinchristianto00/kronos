import type { DynamicMom36FormationInput } from "../src/lib/cross-sectional-edge.js";
import type { ThreeLegContext } from "../src/lib/dynamic-three-leg-fallback.js";
export const THREE_VERSION="dynamic-mom36-cont-slowfast-testnet-wide-skew-sl2-mfe30-36h-v6.5";
export const THREE_SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT"];
export function threeContext(cut:number, direction:"LONG"|"SHORT"):ThreeLegContext {
 return {enabled:true,venue:"testnet",nowMs:cut,regime:{atMs:cut,projection:direction==="LONG"?"BULLISH":"BEARISH",status:"VALID",coverageStatus:"VALID"}};
}
export function threeInput(cut:number,direction:"LONG"|"SHORT"):DynamicMom36FormationInput {
 const up=direction==="LONG",sign=up?1:-1;
 return {activeUniverse:THREE_SYMBOLS.map((symbol,i)=>({symbol,mom36:sign*(.10-i*.005),price:100+i*10,volatility:.01,extensionVol:0,
  oneHourReturn:sign*.01,fastReturn:sign*.04,longEligible:true,shortEligible:true,shortBlocked:false,
  slowSourceTimestampMs:cut,slowStartTimestampMs:cut-36*3600_000,fastSourceTimestampMs:cut,fastStartTimestampMs:cut-4*3600_000,
  oneHourStartTimestampMs:cut-3600_000,slowFastDataValid:true})),
  now:new Date(cut).toISOString(),openedAtMs:cut,horizonMs:36*3600_000,featureTimestampMs:cut,decisionInformationCutoffMs:cut,maxPerCluster:0,
  allowedLongCounts:[1,2,3,4,5],allocationSelectionMode:"RANK_ALL_QUALIFIED",admissionScoreGapFloor:.058,strategyVersion:THREE_VERSION,
  threeLegContext:threeContext(cut,direction),continuationRuntime:{
   available:true,artifactId:"dm-36h-v4-20260824T153338Z:sha256:test",artifactSha256:"test",schemaVersion:4,
   featureVersion:"direction-model-features-v4-975c996",calibrationVersion:"temperature-1.1",
   runtimeFunction:"DirectionModelService.evaluate -> DirectionTrajectory.predict",featureAtMs:cut,fallbackReason:null,rawOutput:{test:true},
   trajectory:{pathProbabilities:{PERSISTENT_UP:up?.6:.1,PERSISTENT_DOWN:up?.1:.6,UP_THEN_REVERSAL:.05,DOWN_THEN_REVERSAL:.05,EARLY_UP_THEN_FLAT:.05,EARLY_DOWN_THEN_FLAT:.05,CHOP:.05,TRANSITION:.05},
    topPath:up?"PERSISTENT_UP":"PERSISTENT_DOWN",topPathProbability:.6,persistenceScore:sign*.5,reversalRisk:.1,
    horizons:[6,12,24,36].map(horizon=>({horizon,pStrongUp:up?.6:.2,pNeutral:.2,pStrongDown:up?.2:.6,expectedReturn:0,q10:-.01,q50:0,q90:.01,expectedVol:.01})),
    earlyLean:0,lateLean:0,reversalAxis:0,expectedReturn:0,q10:-.01,q50:0,q90:.01,expectedVol:.01,confidence:.5,horizonAgreement:1,modelVersion:"dm-36h-v4-20260824T153338Z",schemaVersion:4} as never}};
}

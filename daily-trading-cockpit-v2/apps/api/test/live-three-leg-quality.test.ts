import {describe,it,expect} from 'vitest';
import {liveQualityInput,LIVE_THREE_VERSION} from './live-three-leg-fixture.js';
import {qualityCandles} from './three-leg-quality-fixture.js';
import {assessBalancedThreeLegSymbol,balancedThreeLegPriceReason,LIVE_THREE_LEG_BALANCED_POLICY,THREE_LEG_BALANCED_LIMITS} from '../src/lib/three-leg-balanced-quality.js';
import {evaluateDynamicMom36Formation,validateDynamicMom36FormationAdmissionParity} from '../src/lib/cross-sectional-edge.js';
import {threeLegRegimeReason,threeLegQualitySeal} from '../src/lib/dynamic-three-leg-fallback.js';
import {crossSectionalSelectionRuntime} from '../src/lib/cross-sectional-policy.js';
const cut=Date.parse('2026-09-06T14:00:00Z');
const env={LIVE_BINANCE_ENV:'mainnet',CROSS_SECTIONAL_STRATEGY_VERSION:LIVE_THREE_VERSION,CROSS_SECTIONAL_LIVE_THREE_LEG_BALANCED:'1',CROSS_SECTIONAL_DYNAMIC_ALLOWED_ALLOCATIONS:'2L4S,3L3S,4L2S',CROSS_SECTIONAL_DYNAMIC_ALLOCATION_SELECTION_MODE:'RANK_ALL_QUALIFIED',CROSS_SECTIONAL_DYNAMIC_SKEW_REQUIRE_CONTINUATION_CONFIRMATION:'1'};
describe('LIVE balanced three-leg contract',()=>{
 it.each(['LONG','SHORT'] as const)('uses exactly the researched balanced %s thresholds with separate LIVE identity',side=>{
  for(let seed=0;seed<6;seed++){
   const cs=qualityCandles(cut,seed,side),tn=assessBalancedThreeLegSymbol('A',side,cs,cut),live=assessBalancedThreeLegSymbol('A',side,cs,cut,LIVE_THREE_LEG_BALANCED_POLICY);
   expect({...live,profileId:tn.profileId}).toEqual(tn);expect(balancedThreeLegPriceReason(live,live.entry,1,LIVE_THREE_LEG_BALANCED_POLICY)).toBeNull();
   expect(balancedThreeLegPriceReason(live,live.entry)).toBe('THREE_LEG_QUALITY_UNAVAILABLE');
  }
 });
 it.each(['LONG','SHORT'] as const)('persists qualified %s alternatives with LIVE v6.4 and MIXED',side=>{
  const i=liveQualityInput(cut,side);i.threeLegCandlesBySymbol={...i.threeLegCandlesBySymbol,ETHUSDT:i.threeLegCandlesBySymbol!.BTCUSDT!};
  const r=evaluateDynamicMom36Formation(i);expect(r.noEntryReason,JSON.stringify(r.snapshot?.threeLegFallback)).toBeNull();
  expect(r.snapshot!.threeLegFallback!.policyId).toBe(LIVE_THREE_LEG_BALANCED_POLICY);
  expect(r.snapshot!.threeLegFallback!.quality!.limits).toEqual(THREE_LEG_BALANCED_LIMITS);
  expect([...r.snapshot!.selectedLongs,...r.snapshot!.selectedShorts]).not.toEqual(['BTCUSDT','ETHUSDT','SOLUSDT']);
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(true);
 });
 it.each(['panic','stress','lowCoverage','stale','opposite','wrongVenue','disabled','wrongStrategy'])('blocks %s',reason=>{
  const i=liveQualityInput(cut),c=i.threeLegContext!;
  if(reason==='panic')c.regime.panic=true;if(reason==='stress')c.regime.highStress=true;if(reason==='lowCoverage')c.regime.lowCoverage=true;
  if(reason==='stale')c.regime.atMs-=21*60000;if(reason==='opposite')c.regime.projection='BEARISH';if(reason==='wrongVenue')c.venue='testnet';
  if(reason==='disabled'){c.liveBalanced=false;c.enabled=false;}if(reason==='wrongStrategy')i.strategyVersion='dynamic-mom36-cont-slowfast-testnet-wide-skew-sl2-mfe30-36h-v6.5';
  expect(evaluateDynamicMom36Formation(i).basket).toBeNull();
 });
 it('rejects a forged LIVE quality threshold even when resealed',()=>{
  const r=evaluateDynamicMom36Formation(liveQualityInput(cut)),a=r.snapshot!.threeLegFallback!;
  a.quality!.limits={...THREE_LEG_BALANCED_LIMITS,minNetRewardRisk:.2};a.quality!.seal=threeLegQualitySeal(a);
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(false);
 });
 it('keeps existing LIVE mixed allocations and continuation setting',()=>{
  const p=crossSectionalSelectionRuntime(env).allocationPolicy;
  expect(p.threeLegFallback.enabled).toBe(true);expect(p.threeLegFallback.policyId).toBe(LIVE_THREE_LEG_BALANCED_POLICY);
  expect(p.allowedAllocations).toEqual(['2L4S','3L3S','4L2S']);expect(p.qualifiedAlternativeAllocations).toEqual(p.allowedAllocations);expect(p.skewContinuationConfirmationRequired).toBe(true);
  expect(crossSectionalSelectionRuntime({...env,CROSS_SECTIONAL_LIVE_THREE_LEG_BALANCED:'0'}).allocationPolicy.threeLegFallback.enabled).toBe(false);
 });
 it.each([{LIVE_BINANCE_ENV:'testnet'},{CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK:'1'},{CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V3:'1'},{CROSS_SECTIONAL_LIVE_THREE_LEG_BALANCED:'oops'},{CROSS_SECTIONAL_STRATEGY_VERSION:'dynamic-mom36-cont-slowfast-testnet-wide-skew-sl2-mfe30-36h-v6.5'}])('fails invalid activation %j',bad=>{
  expect(crossSectionalSelectionRuntime({...env,...bad}).state).toBe('CONFIG_INEFFECTIVE');
 });
 it('does not allow Testnet policy to enter a LIVE runtime',()=>{
  const i=liveQualityInput(cut);expect(threeLegRegimeReason(i.threeLegContext!,'LONG','testnet-three-leg-balanced-quality-v3')).toBe('THREE_LEG_TESTNET_ONLY_DISABLED');
 });
});

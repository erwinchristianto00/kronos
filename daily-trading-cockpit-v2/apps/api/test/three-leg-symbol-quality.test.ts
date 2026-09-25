import {describe,it,expect} from "vitest";
import {assessThreeLegSymbol,absoluteReturnCorrelation,threeLegPortfolioQuality,threeLegPriceReason,THREE_LEG_QUALITY_POLICY} from "../src/lib/three-leg-symbol-quality.js";
import {evaluateDynamicMom36Formation,validateDynamicMom36FormationAdmissionParity} from "../src/lib/cross-sectional-edge.js";
import {qualityCandles,qualityInput} from "./three-leg-quality-fixture.js";
import {threeLegRegimeReason} from "../src/lib/dynamic-three-leg-fallback.js";
import {crossSectionalSelectionRuntime} from "../src/lib/cross-sectional-policy.js";
const cut=Date.parse("2026-09-06T13:00:00Z");
describe("three-leg symbol quality v2",()=>{
 it.each(["LONG","SHORT"] as const)("admits a valid MIXED %s portfolio through actual formation",direction=>{
  const input=qualityInput(cut,direction),r=evaluateDynamicMom36Formation(input);
  expect(r.snapshot?.threeLegFallback?.quality?.candidates).toBeDefined();
  expect(r.noEntryReason,JSON.stringify(r.snapshot?.threeLegFallback)).toBeNull();
  expect(r.basket!.longLeg.length+r.basket!.shortLeg.length).toBe(3);
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(true);
 });
 it.each(["panic","highStress","lowCoverage","missingOverlay","stale","opposite","mainnet"])("blocks %s despite good selected symbols",failure=>{
  const i=qualityInput(cut),c=i.threeLegContext!;
  if(failure==="panic"||failure==="highStress"||failure==="lowCoverage")c.regime[failure]=true;
  if(failure==="missingOverlay")delete c.regime.panic;
  if(failure==="stale")c.regime.atMs=cut-21*60_000;
  if(failure==="opposite")c.regime.projection="BEARISH";
  if(failure==="mainnet")c.venue="mainnet";
  expect(evaluateDynamicMom36Formation(i).basket).toBeNull();
 });
 it("allows broad NO_EDGE/TRANSITION only when symbol and portfolio evidence passes",()=>{
  const i=qualityInput(cut);const t=i.continuationRuntime!.trajectory!;t.topPath="TRANSITION";t.pathProbabilities={...t.pathProbabilities,PERSISTENT_UP:.1,TRANSITION:.6};t.persistenceScore=0;
  const r=evaluateDynamicMom36Formation(i);expect(r.snapshot?.continuation?.decision).toBe("NO_EDGE");expect(r.basket).not.toBeNull();
 });
 it.each(["UP_THEN_REVERSAL","PERSISTENT_DOWN"] as const)("rejects explicit model %s",path=>{
  const i=qualityInput(cut);const t=i.continuationRuntime!.trajectory!;t.topPath=path;
  expect(evaluateDynamicMom36Formation(i).basket).toBeNull();
 });
 it.each(["missing","gap","future","reversal","deceleration","spike","extension","rejection","failedBreakout","nearResistance"].flatMap(failure=>["LONG","SHORT"].map(direction=>[direction,failure] as const)))("rejects %s symbol with %s",(direction,failure)=>{
  const cs=qualityCandles(cut,0);
  if(failure==="missing")cs.pop();
  if(failure==="gap")cs[20]!.openTime-=1;
  if(failure==="future")cs[47]!.openTime+=3600_000;
  if(failure==="reversal"){const c=cs[47]!;c.close=c.open*.999;c.low=Math.min(c.low,c.close);}
  if(failure==="deceleration"){const c=cs[44]!;c.close*=1.004;c.high=Math.max(c.high,c.close);}
  if(failure==="spike"){cs[47]!.high*=1.05;}
  if(failure==="extension"){for(let j=44;j<48;j++){cs[j]!.open*=1.05;cs[j]!.close*=1.05;cs[j]!.high*=1.05;cs[j]!.low*=1.05;}}
  if(failure==="rejection"||failure==="failedBreakout")cs[47]!.high=cs[47]!.close*1.012;
  if(failure==="nearResistance")cs[40]!.high=cs[47]!.close*1.001;
  const mapped=direction==="LONG"?cs:cs.map(c=>({...c,open:10000/c.open,close:10000/c.close,high:10000/c.low,low:10000/c.high}));
  const q=assessThreeLegSymbol("BTCUSDT",direction as "LONG"|"SHORT",mapped,cut);expect(q.allowed,JSON.stringify(q)).toBe(false);
 });
 it("rejects zero variance or highly correlated combinations",()=>{
  expect(absoluteReturnCorrelation(Array(24).fill(.01),Array(24).fill(.01))).toBeNull();
  const q=assessThreeLegSymbol("A","LONG",qualityCandles(cut,0),cut);expect(threeLegPortfolioQuality([q,q,q]).reason).toBe("QUALITY_CORRELATION_TOO_HIGH");
 });
 it("filters the strongest MOM36 candidate when its recent candle reverses and ranks alternatives",()=>{
  const i=qualityInput(cut),cs=i.threeLegCandlesBySymbol![i.activeUniverse[0]!.symbol]! as ReturnType<typeof qualityCandles>;
  cs[47]!.close=cs[47]!.open*.999;
  const r=evaluateDynamicMom36Formation(i);expect(r.basket).not.toBeNull();expect(r.snapshot!.selectedLongs).not.toContain(i.activeUniverse[0]!.symbol);
 });
 it("skips a correlated higher-ranked alternative and finds a complete lower-ranked trio",()=>{
  const i=qualityInput(cut);i.threeLegCandlesBySymbol={...i.threeLegCandlesBySymbol,ETHUSDT:i.threeLegCandlesBySymbol!.BTCUSDT!};
  const r=evaluateDynamicMom36Formation(i);expect(r.basket).not.toBeNull();expect(r.snapshot!.selectedLongs).not.toEqual(["BTCUSDT","ETHUSDT","SOLUSDT"]);
 });
 it("rejects a mutated quality contract at final persisted plan parity",()=>{
  const r=evaluateDynamicMom36Formation(qualityInput(cut));r.snapshot!.threeLegFallback!.quality!.candidates[0]!.target*=2;
  expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(false);
 });
 it.each(["LONG","SHORT"] as const)("blocks %s when executable price consumes room or crosses invalidation",direction=>{
  const q=assessThreeLegSymbol("A",direction,qualityCandles(cut,0,direction),cut);
  expect(threeLegPriceReason(q,q.entry)).toBeNull();expect(threeLegPriceReason(q,q.target)).not.toBeNull();expect(threeLegPriceReason(q,q.invalidation)).toBe("THREE_LEG_PRICE_REVERSAL");
 });
 it("keeps the v1 MIXED gate frozen and requires both Testnet flags for v2",()=>{
  const i=qualityInput(cut);expect(threeLegRegimeReason(i.threeLegContext!,"LONG")).toBe("THREE_LEG_REGIME_MIXED_OR_OPPOSITE");
  const env={LIVE_BINANCE_ENV:"testnet",CROSS_SECTIONAL_STRATEGY_VERSION:i.strategyVersion,CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK:"1",CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V2:"1"};
  expect(crossSectionalSelectionRuntime(env).allocationPolicy.threeLegFallback.policyId).toBe(THREE_LEG_QUALITY_POLICY);
  expect(crossSectionalSelectionRuntime({...env,LIVE_BINANCE_ENV:"mainnet"}).state).toBe("CONFIG_INEFFECTIVE");
  expect(crossSectionalSelectionRuntime({...env,CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK:"0"}).state).toBe("CONFIG_INEFFECTIVE");
 });
 it("normalizes multiplier contract prices before evaluating room",()=>{
  const q=assessThreeLegSymbol("1000PEPEUSDT","LONG",qualityCandles(cut,0),cut);
  expect(threeLegPriceReason(q,q.entry*1000,1000)).toBeNull();
  expect(threeLegPriceReason(q,q.entry*1000)).not.toBeNull();
 });
 it("rejects concentrated technical invalidation risk despite low correlation",()=>{
  const qs=[0,1,2].map(i=>assessThreeLegSymbol(String(i),"LONG",qualityCandles(cut,i),cut));qs[0]!.riskPct*=5;
  expect(threeLegPortfolioQuality(qs).reason).toBe("QUALITY_RISK_CONCENTRATED");
 });

});

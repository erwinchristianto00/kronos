import type { Candle } from "@dtc/shared";
import {threeInput,THREE_SYMBOLS,threeContext} from "./three-leg-fixture.js";
export function qualityCandles(cut:number,seed:number,direction:"LONG"|"SHORT"="LONG"):Candle[] {
  let price=100,state=seed+11;
  return Array.from({length:48},(_,i)=>{
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    const ret=i<42?.0002+(state/4294967296)*.0016:[.001,.0012,.0013,.0014,.0015,.0016][i-42]!;
    const open=price;price*=Math.exp(ret);const c={openTime:cut-(48-i)*3600_000,open,close:price,high:price*1.004,low:open*.996,volume:1_000_000};
    return direction==="LONG"?c:{...c,open:10000/c.open,close:10000/c.close,high:10000/c.low,low:10000/c.high};
  });
}
export function qualityContext(cut:number,direction:"LONG"|"SHORT"="LONG") {
  const c=threeContext(cut,direction);c.qualityV2=true;c.regime={...c.regime,projection:"MIXED",panic:false,highStress:false,lowCoverage:false};return c;
}
export function qualityInput(cut:number,direction:"LONG"|"SHORT"="LONG") {
  const input=threeInput(cut,direction);input.threeLegContext=qualityContext(cut,direction);
  input.threeLegCandlesBySymbol=Object.fromEntries(THREE_SYMBOLS.map((s,i)=>[s,qualityCandles(cut,i,direction)]));
  input.activeUniverse.forEach(r=>{const cs=input.threeLegCandlesBySymbol![r.symbol]!;r.price=cs.at(-1)!.close;r.oneHourReturn=cs.at(-1)!.close/cs.at(-2)!.close-1;});
  return input;
}

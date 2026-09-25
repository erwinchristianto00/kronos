import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Dual4hCollection} from '../apps/api/src/lib/dual4h-collection.js';
async function main(){
const dir=mkdtempSync(join(tmpdir(),'dual4h-stream-proof-'));
const c=new Dual4hCollection(join(dir,'cache.json'),async()=>{throw new Error('REST disabled for stream proof');});
(c as any).researchBookSymbols=()=>['BTCUSDT'];
(c as any).connectBooks();
try{await new Promise<void>((resolve,reject)=>{const began=Date.now();const timer=setInterval(()=>{const s=c.status();if(Date.now()-began>20000&&s.forwardStudy.lastMarketQuoteAt!==null&&Date.now()-s.forwardStudy.lastMarketQuoteAt<2000){clearInterval(timer);console.log(JSON.stringify({ok:true,bookStreamConnected:s.bookStreamConnected,lastMarketQuoteAt:s.forwardStudy.lastMarketQuoteAt,subscribedSymbols:s.bookSubscribedSymbols,observedForMs:Date.now()-began,orderAuthority:false}));resolve();}else if(Date.now()-began>30000){clearInterval(timer);reject(new Error('No public BBO received within30seconds'));}},250);});}finally{c.close();rmSync(dir,{recursive:true,force:true});}

}
main().catch(error=>{console.error(String(error));process.exitCode=1;});

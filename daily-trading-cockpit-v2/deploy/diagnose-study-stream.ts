import {Dual4hCollection} from '../apps/api/src/lib/dual4h-collection.js';
const c=new Dual4hCollection('/tmp/dual-stream-diagnostic-only.json',async()=>{throw Error('no REST')});
let count=0,last:any=null;const original=c.study.quote.bind(c.study);c.study.quote=(...args:any[])=>{count++;last={source:args[3],received:args[4],lag:Date.now()-args[3],symbol:args[0]};return (original as any)(...args);};
(c as any).connectBooks();const started=Date.now();const timer=setInterval(()=>{console.log(JSON.stringify({elapsed:Date.now()-started,count,last,status:c.study.status().lastMarketQuoteAt}));if(Date.now()-started>16000){clearInterval(timer);c.close();}},4000);

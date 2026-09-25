import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Dual4hCollection} from '../src/lib/dual4h-collection.js';
afterEach(()=>vi.unstubAllGlobals());
describe('research book stream routing',()=>{
 it('uses public endpoint and accepts fresh BBO into study health, not the candle endpoint',()=>{
  const sockets:any[]=[];let now=Date.UTC(2026,8,21,8);
  class Socket{handlers:any={};sent:any[]=[];constructor(public url:string){sockets.push(this);}addEventListener(n:string,f:any){this.handlers[n]=f;}send(x:string){this.sent.push(JSON.parse(x));}close(){this.handlers.close?.();}}
  vi.stubGlobal('WebSocket',Socket);const dir=mkdtempSync(join(tmpdir(),'dual-book-'));
  try{const c=new Dual4hCollection(join(dir,'cache.json'),async()=>{throw Error('no REST in test')},()=>now);
   (c as any).connect();(c as any).connectBooks();expect(sockets.map(s=>s.url)).toEqual(['wss://fstream.binance.com/market/ws','wss://fstream.binance.com/public/ws']);
   for(const s of sockets)s.handlers.open();expect(sockets[1].sent[0]).toEqual({method:'LIST_SUBSCRIPTIONS',id:2});expect(c.status().bookStreamMode).toBe('IDLE_WAITING_SIGNAL');expect(sockets[0].sent[0].params.some((s:string)=>s.includes('bookTicker'))).toBe(false);
   sockets[1].handlers.message({data:JSON.stringify({id:2,result:[]})});
   sockets[1].handlers.message({data:JSON.stringify({e:'bookTicker',s:'BTCUSDT',b:'100',a:'100.01',B:'1',A:'1',T:now})});
   expect(c.status().bookStreamConnected).toBe(true);expect(c.status().forwardStudy.lastMarketQuoteAt).toBe(now);
   (c.study.rows as any[]).push({status:'WAITING_QUOTE',feature:{symbol:'ETHUSDT'},gaps:[]});now+=1001;(c as any).refreshBooks();expect(sockets[1].sent.at(-1).params).toEqual(['ethusdt@bookTicker']);
   now+=61000;(c as any).connectBooks();expect(c.status().bookStreamConnected).toBe(false);(c as any).connectBooks();sockets[2].handlers.open();sockets[2].handlers.message({data:JSON.stringify({id:2,result:null})});(c as any).connectBooks();expect(c.status().bookStreamConnected).toBe(true);expect(c.status().bookStreamMode).toBe('TRACKING_SIGNALS');c.study.rows.length=0;now+=1001;(c as any).refreshBooks();expect(sockets[2].sent.at(-1)).toEqual({method:'UNSUBSCRIBE',params:['ethusdt@bookTicker'],id:4});now+=120000;(c as any).connectBooks();expect(c.status().bookStreamConnected).toBe(true);c.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});

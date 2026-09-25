import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BinanceFuturesPrivateError,
  type FuturesAlgoOrder,
  type FuturesExecutionBookTicker,
  type FuturesIncomeEntry,
  type FuturesKline,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
  type PlaceAlgoOrderParams,
  type PlaceOrderParams,
} from "../src/lib/binance-futures-private.js";
import {
  DailyRangeAcceptanceLane,
  DailyRangeLaneStore,
  DAILY_RANGE_AUTO_ROUTE_V4_FIXED_2R_FADE_STRATEGY_VERSION,
  DAILY_RANGE_FADE_SWEEP_STOP_BUFFER_FRACTION,
  DAILY_RANGE_FADE_SWEEP_STOP_FLOOR_BPS,
  DAILY_RANGE_FADE_SWEEP_STOP_POLICY_ID,
  inDailyRangeEntryWindow,
  newYorkDailyRangeWindow,
  roundDailyRangeBracket,
  structuralStopForDailyRangeFilledTrade,
  structuralStopForDailyRangeSignal,
  structuralStopForAcceptance,
  type DailyRangeCandle,
  type DailyRangeCanaryEvidence,
  type DailyRangeDayState,
  type DailyRangeExecClient,
  type DailyRangeLevel,
  type DailyRangeSignal,
  type DailyRangeStrategyMode,
  type DailyRangeSymbolState,
  type DailyRangeTrade,
} from "../src/lib/daily-4h-range-acceptance-lane.js";
import type { DailyRangePoolEvidence } from "../src/lib/daily-range-auto-pool.js";
import type { DailyRangeAutoRouteEntryMode } from "../src/lib/daily-range-auto-route.js";
import type { DailyRangeMainnetControls } from "../src/lib/daily-range-mainnet-policy.js";
import { dailyRangeRouteExitPolicyForSignal } from "../src/lib/daily-range-route-exit.js";
import { conservativeFallbackFrictionModel, prepareDailyRangeEconomics } from "../src/lib/daily-range-economics.js";
import { DAILY_RANGE_FADE_OPPOSITE_RANGE_TARGET_POLICY_ID } from "../src/lib/daily-range-structural-sr.js";
import {
  createDailyRangeFadeGenuineBreakoutFilterSnapshot,
  evaluateDailyRangeFadeGenuineBreakoutFilter,
} from "../src/lib/daily-range-fade-genuine-breakout-filter.js";
import {
  bindDailyRangeFadeRTrail,
  createDailyRangeFadeRTrailState,
} from "../src/lib/daily-range-fade-r-trail.js";


import { MOMENTUM4H_UNIVERSE, MOMENTUM4H_VERSION, momentumFeature, momentumPlan, momentumWindow, type MomentumSnapshot } from "../src/lib/daily-momentum4h.js";
const DAY = Date.UTC(2026,8,6);
const AT_0410=DAY+8*3_600_000;
const symbols=MOMENTUM4H_UNIVERSE;
function filter(symbol:string):FuturesSymbolFilters{return {symbol,tickSize:.01,stepSize:.001,minQty:.001,minNotional:5,pricePrecision:2,quantityPrecision:3};}
class FakeDailyClient implements DailyRangeExecClient {
  now = AT_0410;
  readonly placed: PlaceOrderParams[] = [];
  readonly algoPlaced: PlaceAlgoOrderParams[] = [];
  readonly cancelledAlgos: string[] = [];
  readonly cancelledOrders: string[] = [];
  readonly klines = new Map<string, FuturesKline[]>();
  readonly positions = new Map<string, FuturesPosition>();
  readonly orders = new Map<string, FuturesOrder>();
  readonly ordersByClientId = new Map<string, FuturesOrder>();
  readonly algos = new Map<string, FuturesAlgoOrder>();
  readonly algoHistory = new Map<string, FuturesAlgoOrder>();
  readonly fills: FuturesUserTrade[] = [];
  readonly fiveMinuteReadSymbols = new Set<string>();
  readonly entryCoverageSnapshots: string[][] = [];
  readonly eventLog: string[] = [];
  beforeEntry: (() => void) | null = null;
  failNextEntry = false;
  bookTimeOffsetMs = 0;
  /** A native exit may settle between Binance's separate position and algo-book reads. */
  nativeExitOnNextOpenAlgoRead: string | null = null;
  /** The initial-bracket variant: the disappearing native orders remain
   * queryable as terminal exchange history. */
  nativeTerminalExitOnNextOpenAlgoRead: string | null = null;
  /** Simulates a terminal partial MARKET fill: safe handling must bracket the
   * actual quantity rather than treating the requested quantity as fact. */
  nextEntryPartialFill: { qty: number; status: "CANCELED" | "EXPIRED" } | null = null;
  /** Deliberately differs from the decision BBO for post-fill bracket tests. */
  nextEntryFillPrice: number | null = null;
  private orderNo = 1;
  private algoNo = 1;

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    const known = new Set([
      ...symbols,
      ...[...this.klines.keys()].map((key) => key.split("|")[0]!),
      ...this.positions.keys(),
    ]);
    return new Map([...known].map((symbol) => [symbol, filter(symbol)]));
  }
  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    // Real REST responses are snapshots. Returning clones matters for the
    // native-exit race fixture below: an algo read can settle a position after
    // this call has already returned its earlier non-zero observation.
    const rows = [...this.positions.values()].map((row) => ({ ...row }));
    return symbol ? rows.filter((row) => row.symbol === symbol) : rows;
  }
  async getOpenOrders(_symbol?: string): Promise<FuturesOrder[]> { return []; }
  async getOpenAlgoOrders(symbol?: string): Promise<FuturesAlgoOrder[]> {
    const terminalExiting = this.nativeTerminalExitOnNextOpenAlgoRead;
    if (terminalExiting && (symbol === undefined || symbol === terminalExiting)
      && [...this.algos.values()].some((algo) => algo.symbol === terminalExiting)) {
      this.nativeTerminalExitOnNextOpenAlgoRead = null;
      this.positions.delete(terminalExiting);
      for (const [algoId, algo] of this.algos) {
        if (algo.symbol !== terminalExiting) continue;
        this.algos.delete(algoId);
        this.algoHistory.set(algoId, { ...algo, algoStatus: "FINISHED", actualOrderId: `native-${algoId}` });
      }
    }
    const exiting = this.nativeExitOnNextOpenAlgoRead;
    if (exiting && (symbol === undefined || symbol === exiting)) {
      this.nativeExitOnNextOpenAlgoRead = null;
      this.positions.delete(exiting);
      for (const [algoId, algo] of this.algos) {
        if (algo.symbol === exiting) this.algos.delete(algoId);
      }
    }
    const rows = [...this.algos.values()];
    return symbol ? rows.filter((row) => row.symbol === symbol) : rows;
  }
  async getBookTicker(symbol: string): Promise<FuturesExecutionBookTicker> {
    this.eventLog.push(`book:${symbol}`);
    return { bid: 100, ask: 100, bidQty: 100, askQty: 100, time: this.now + this.bookTimeOffsetMs };
  }
  async getKlines(symbol: string, interval: "1m" | "5m" | "1h" | "4h", opts: { startTime?: number; endTime?: number } = {}): Promise<FuturesKline[]> {
    if (interval === "5m") this.fiveMinuteReadSymbols.add(symbol);
    return (this.klines.get(`${symbol}|${interval}`) ?? []).filter((row) =>
      (opts.startTime === undefined || row.openTime >= opts.startTime) && (opts.endTime === undefined || row.openTime <= opts.endTime),
    );
  }
  async isHedgeMode(): Promise<boolean> { return false; }
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const current = this.positions.get(symbol);
    if (current) current.leverage = leverage;
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    if (!params.reduceOnly) {
      this.eventLog.push(`entry:${params.symbol}`);
      this.entryCoverageSnapshots.push([...this.fiveMinuteReadSymbols].sort());
      this.beforeEntry?.();
      if (this.failNextEntry) {
        this.failNextEntry = false;
        throw new BinanceFuturesPrivateError("binance_error", "synthetic selected-entry rejection");
      }
    }
    this.placed.push(params);
    const price = !params.reduceOnly && this.nextEntryFillPrice !== null
      ? this.nextEntryFillPrice
      : 100;
    const partial = !params.reduceOnly ? this.nextEntryPartialFill : null;
    this.nextEntryPartialFill = null;
    if (!params.reduceOnly) this.nextEntryFillPrice = null;
    const executedQty = partial ? Math.min(params.quantity, partial.qty) : params.quantity;
    const order: FuturesOrder = {
      symbol: params.symbol, orderId: String(this.orderNo++), clientOrderId: params.newClientOrderId ?? "",
      status: partial?.status ?? "FILLED", type: params.type, side: params.side, reduceOnly: Boolean(params.reduceOnly),
      price: 0, stopPrice: 0, origQty: params.quantity, executedQty, avgPrice: price, updateTime: this.now,
    };
    this.orders.set(order.orderId, order);
    this.ordersByClientId.set(order.clientOrderId, order);
    const existing = this.positions.get(params.symbol) ?? {
      symbol: params.symbol, positionAmt: 0, entryPrice: price, markPrice: price, liquidationPrice: 0,
      unRealizedProfit: 0, leverage: 1, marginType: "CROSSED",
    };
    if (params.reduceOnly) {
      existing.positionAmt = 0;
      this.fills.push({ symbol: params.symbol, orderId: order.orderId, price, qty: executedQty, realizedPnl: 1, commission: -0.01, commissionAsset: "USDT", time: this.now });
    } else {
      existing.positionAmt += params.side === "BUY" ? executedQty : -executedQty;
      existing.entryPrice = price;
      this.fills.push({ symbol: params.symbol, orderId: order.orderId, price, qty: executedQty, realizedPnl: 0, commission: -0.01, commissionAsset: "USDT", time: this.now });
    }
    this.positions.set(params.symbol, existing);
    return order;
  }
  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    this.algoPlaced.push(params);
    const algo: FuturesAlgoOrder = {
      symbol: params.symbol, algoId: `a${this.algoNo++}`, clientAlgoId: params.clientAlgoId ?? "", algoStatus: "WORKING",
      orderType: params.type, side: params.side, quantity: params.quantity, triggerPrice: params.triggerPrice, actualOrderId: null,
    };
    this.algos.set(algo.algoId, algo);
    return algo;
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    const order = this.orders.get(orderId);
    if (!order || order.symbol !== symbol) throw new Error("order not found");
    return order;
  }
  async queryOrderByClientId(symbol: string, clientOrderId: string): Promise<FuturesOrder> {
    const order = this.ordersByClientId.get(clientOrderId);
    if (!order || order.symbol !== symbol) throw new Error("order not found");
    return order;
  }
  async queryAlgoOrder(algoId: string): Promise<FuturesAlgoOrder> {
    const algo = this.algos.get(algoId) ?? this.algoHistory.get(algoId);
    if (!algo) throw new Error("algo not found");
    return algo;
  }
  async cancelOrder(_symbol: string, orderId: string): Promise<void> { this.cancelledOrders.push(orderId); }
  async cancelAlgoOrder(algoId: string): Promise<void> { this.cancelledAlgos.push(algoId); this.algos.delete(algoId); }
  async getUserTrades(symbol: string): Promise<FuturesUserTrade[]> { return this.fills.filter((fill) => fill.symbol === symbol); }
  async getIncomeHistory(): Promise<FuturesIncomeEntry[]> { return []; }
}

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function snapshot(t=AT_0410):MomentumSnapshot{
 const candles:MomentumSnapshot['candles']={},funding:MomentumSnapshot['funding']={};
 for(const symbol of symbols){
  candles[symbol]=Array.from({length:49},(_,i)=>{const c=95+i*5/48,openTime=t-(49-i)*14_400_000;return {openTime,closeTime:openTime+14_400_000-1,open:c,high:c+.5,low:c-.5,close:c,volume:1,quoteVolume:(30_000_000-symbols.indexOf(symbol)*100_000)};});
  funding[symbol]=[24,16,8].map(h=>({fundingTime:t-h*3_600_000,fundingRate:.0001}));
 }
 return {candles,funding};
}
function fixture(options: {gate?:()=>boolean;snapshot?:()=>Promise<MomentumSnapshot>;environment?:'testnet'|'mainnet'}={}){
 const dir=mkdtempSync(join(tmpdir(),'momentum4h-'));dirs.push(dir);const client=new FakeDailyClient();let now=AT_0410-60_000;client.now=now;
 const store=new DailyRangeLaneStore(dir,'state.json',now);
 const lane=new DailyRangeAcceptanceLane({client,store,getUniverse:()=>({symbols,source:'TEST'}),getShortBlocklist:()=>new Set(),entryClaims:{tryClaimEntrySymbol:()=>true,releaseEntrySymbol:()=>{}},environment:options.environment??'testnet',strategyMode:'MOMENTUM_4H_V1',testnetMaxOpenTrades:4,readMomentumSnapshot:options.snapshot??(async()=>snapshot()),nowMs:()=>now,confirmRetryMs:0,entryGate:()=>({allowed:options.gate?.()??true,reason:'fixture gate'})});
 return {client,store,lane,dir,setTime(t:number){now=t;client.now=t;},async activate(){await lane.tick();store.arm(new Date(now).toISOString());now=AT_0410+1000;client.now=now;await lane.tick();}};
}
describe('frozen 4H momentum',()=>{
 it('rejects Mainnet construction',()=>{expect(()=>fixture({environment:'mainnet'})).toThrow(/Testnet/);});
 it('requires completed contiguous bars and uses exactly4d7d, SMA ATR and past funding',()=>{
  const s=snapshot();const f=momentumFeature('SOLUSDT',s,AT_0410)!;expect(f.atr).toBeCloseTo(1,12);expect(f.ret4d).toBeCloseTo(100/97.5-1,12);expect(f.ret7d).toBeCloseTo(100/95.625-1,12);expect(f.fundingRateReserve).toBeCloseTo(.0024,12);
  s.funding.SOLUSDT!.push({fundingTime:AT_0410,fundingRate:99});expect(momentumFeature('SOLUSDT',s,AT_0410)!.fundingRateReserve).toBeCloseTo(.0024,12);
  s.candles.SOLUSDT![30]!.openTime+=1;expect(()=>momentumFeature('SOLUSDT',s,AT_0410)).toThrow(/INCOMPLETE/);
 });
 it('cannot enter on conflicting4d7d orBTC direction',()=>{const s=snapshot();s.candles.SOLUSDT![24]!.close=101;s.candles.SOLUSDT![24]!.high=102;expect(momentumFeature('SOLUSDT',s,AT_0410)).toBeNull();});
 it('applies friction-inclusive risk, lot floors andBTC minNotional without increasing budget',()=>{
  const f=momentumFeature('SOLUSDT',snapshot(),AT_0410)!;const p=momentumPlan(f,filter('SOLUSDT'),100,100,AT_0410+1000)!;
  expect(p.qty).toBeGreaterThan(0);expect(p.plannedLoss).toBeLessThanOrEqual(.25);expect(p.notional).toBeLessThanOrEqual(25);expect(p.stop).toBe(98);
  expect(momentumPlan(f,{...filter('BTCUSDT'),minNotional:50},100,100,AT_0410+1000)).toBeNull();expect(momentumPlan(f,filter('SOLUSDT'),102,102,AT_0410+1000)).toBeNull();
 });
 it('does not replay a missed or pre-arm schedule',()=>{expect(momentumWindow(AT_0410+96_000,AT_0410-1)).toBe(false);expect(momentumWindow(AT_0410+1000,AT_0410+1)).toBe(false);});
 it('freezesvolume priority, max3 same side, nativeSL andTP, restart has no duplicate entry',async()=>{
  const f=fixture();await f.activate();expect(f.client.placed.filter(x=>!x.reduceOnly).map(x=>x.symbol)).toEqual(symbols.slice(0,3));expect(f.client.algoPlaced).toHaveLength(6);expect(f.client.algoPlaced.every(x=>x.reduceOnly&&x.workingType==='CONTRACT_PRICE')).toBe(true);expect(f.client.algoPlaced.filter(x=>x.type==='TAKE_PROFIT_MARKET')).toHaveLength(3);
  expect(f.store.getState().trades.every(x=>x.takeProfitPrice!>x.entryFillPrice!&&x.fadeRTrail===null&&x.entryQty===x.momentum?.qty)).toBe(true);
  await f.lane.tick();expect(f.client.placed).toHaveLength(3);expect(f.store.getState().control.mode).toBe('ARMED');
  const restarted=new DailyRangeAcceptanceLane({client:f.client,store:new DailyRangeLaneStore(f.dir,'state.json'),getUniverse:()=>({symbols,source:'TEST'}),getShortBlocklist:()=>new Set(),entryClaims:{tryClaimEntrySymbol:()=>true,releaseEntrySymbol:()=>{}},environment:'testnet',strategyMode:'MOMENTUM_4H_V1',testnetMaxOpenTrades:4,readMomentumSnapshot:async()=>snapshot(),nowMs:()=>AT_0410+2000,confirmRetryMs:0});await restarted.tick();expect(f.client.placed).toHaveLength(3);
 });
 it('honours account drain and skips late enabling',async()=>{let allowed=false;const f=fixture({gate:()=>allowed});await f.activate();expect(f.client.placed).toHaveLength(0);allowed=true;f.setTime(AT_0410+96_000);await f.lane.tick();expect(f.client.placed).toHaveLength(0);});
 it('missing BTC/funding retries only collection before any entry and recovers within the original window',async()=>{const s=snapshot();s.funding.SOLUSDT=[];const f=fixture({snapshot:async()=>s});await f.activate();expect(f.client.placed).toHaveLength(0);expect(f.store.getState().runtime.momentumBatch?.status).toBe('DATA_RETRY_PENDING');s.funding.SOLUSDT=snapshot().funding.SOLUSDT!;f.setTime(AT_0410+10000);await f.lane.tick();expect(f.store.getState().runtime.momentumBatch?.status).toBe('COMPLETE');expect(f.client.placed.length).toBeGreaterThan(0);});
 it('data retries expire with the original95second window and cannot become late entries',async()=>{const s=snapshot();s.funding.SOLUSDT=[];const f=fixture({snapshot:async()=>s});await f.activate();expect(f.store.getState().runtime.momentumBatch?.status).toBe('DATA_RETRY_PENDING');f.setTime(AT_0410+96000);await f.lane.tick();expect(f.store.getState().runtime.momentumBatch?.status).toBe('FAILED_DATA_WINDOW_EXPIRED');expect(f.client.placed).toHaveLength(0);});
 it('keeps stop protection whiledisarmed and exits exactlyowned quantity at48h',async()=>{const f=fixture();await f.activate();f.lane.disarm('test');f.setTime(AT_0410+48*3_600_000);await f.lane.tick();const exits=f.client.placed.filter(x=>x.reduceOnly);expect(exits).toHaveLength(3);expect(exits.map(x=>x.quantity)).toEqual(f.store.getState().trades.map(x=>x.entryQty));expect(f.store.getState().trades.every(x=>x.exitReason==='MOMENTUM_48H_TIME_CAP'&&x.status==='CLOSED')).toBe(true);expect(f.client.algos.size).toBe(0);});
 it('rejects a worse actual fill without widening frozenstop oroversizing',async()=>{const f=fixture();f.client.nextEntryFillPrice=110;await f.activate();const t=f.store.getState().trades[0]!;expect(t.status).toBe('ENTRY_ABORT_POST_FILL_RISK_FAIL');expect(t.stopPrice).toBe(98);expect(f.client.placed.some(x=>x.reduceOnly&&x.symbol===t.symbol)).toBe(true);});
 it('ownership mismatch stops timeexit fromclosing anotherlane',async()=>{const f=fixture();await f.activate();const p=f.client.positions.get(symbols[0]!)!;p.positionAmt+=1;f.setTime(AT_0410+48*3_600_000);await f.lane.tick();expect(f.client.placed.filter(x=>x.reduceOnly&&x.symbol===symbols[0])).toHaveLength(0);expect(f.store.getState().control.mode).toBe('DISARMED');});
});
describe('momentum exchange failures',()=>{
 it('rejects stale venue BBO before any order',async()=>{const f=fixture();f.client.bookTimeOffsetMs=-31_000;await f.activate();expect(f.client.placed).toHaveLength(0);});
 it('native stop missing causes exact-owned unwind, no accidental TP requirement',async()=>{const f=fixture();await f.activate();const t=f.store.getState().trades[0]!;f.client.algos.delete(t.stopAlgoOrderId!);await f.lane.tick();expect(f.client.placed.some(x=>x.reduceOnly&&x.symbol===t.symbol)).toBe(true);expect(f.store.getState().control.mode).toBe('DISARMED');});
 it('does not duplicate an unknown timed exit POST',async()=>{const f=fixture();await f.activate();const original=f.client.placeOrder.bind(f.client);let exitAttempts=0;f.client.placeOrder=async p=>{if(p.reduceOnly){exitAttempts++;throw new Error('network ambiguous');}return original(p);};f.setTime(AT_0410+48*3_600_000);await f.lane.tick();expect(exitAttempts).toBe(3);await f.lane.tick();expect(exitAttempts).toBe(3);expect(f.client.algos.size).toBe(6);});
});
describe('explicit Testnet momentum execution proof',()=>{
 async function ready(){const f=fixture();await f.lane.tick();f.store.arm(new Date(AT_0410-60_000).toISOString());f.setTime(AT_0410+3_600_000);return f;}
 it('uses real entry/stop/close machinery outside schedule and excludes probe from forward PnL',async()=>{
  const f=await ready();const r=await f.lane.runMomentumExecutionProbe();expect(r.ok).toBe(true);expect(r.nativeStopVerified).toBe(true);expect(r.flatVerified).toBe(true);expect(f.client.placed).toHaveLength(2);expect(f.client.algoPlaced).toHaveLength(1);expect(f.client.algoPlaced[0]!.type).toBe('STOP_MARKET');expect(f.client.placed[1]!.reduceOnly).toBe(true);expect(f.client.algos.size).toBe(0);
  expect(f.lane.getStatus().performance).toMatchObject({executedTrades:0,closedTrades:0,netPnlUsd:0});expect(f.store.getState().runtime.momentumBatch).toBeUndefined();await f.lane.tick();expect(f.client.placed).toHaveLength(2);expect(f.store.getState().control.mode).toBe('ARMED');
 });
 it('cannot bypass an account drain even when explicitly invoked',async()=>{const f=fixture({gate:()=>false});await f.lane.tick();f.store.arm(new Date(AT_0410-60_000).toISOString());f.setTime(AT_0410+3_600_000);await expect(f.lane.runMomentumExecutionProbe()).rejects.toThrow(/not ready/);expect(f.client.placed).toHaveLength(0);});
 it('restart closes a persisted OPEN probe promptly rather than holding it96hours',async()=>{
  const f=await ready();const original=(f.lane as any).emergencyFlatten;(f.lane as any).emergencyFlatten=async()=>{throw new Error('synthetic interruption before cleanup');};const r=await f.lane.runMomentumExecutionProbe();expect(r.ok).toBe(false);expect(f.store.getState().trades[0]!.status).toBe('OPEN');(f.lane as any).emergencyFlatten=original;
  const restarted=new DailyRangeAcceptanceLane({client:f.client,store:new DailyRangeLaneStore(f.dir,'state.json'),getUniverse:()=>({symbols,source:'TEST'}),getShortBlocklist:()=>new Set(),entryClaims:{tryClaimEntrySymbol:()=>true,releaseEntrySymbol:()=>{}},environment:'testnet',strategyMode:'MOMENTUM_4H_V1',testnetMaxOpenTrades:4,readMomentumSnapshot:async()=>snapshot(),nowMs:()=>AT_0410+3_600_000,confirmRetryMs:0});await restarted.tick();expect(f.client.placed.filter(x=>x.reduceOnly)).toHaveLength(1);expect(f.client.algos.size).toBe(0);
 });
});

describe('momentum ladder integration',()=>{
 it('captures one durable exit from fresh BBO, closes exact quantity, andcleans both native orders',async()=>{
  const f=fixture();await f.activate();const trade=f.store.getState().trades[0]!;const symbol=trade.symbol;
  f.setTime(AT_0410+2000);f.lane.ingestExecutableBookTicker({symbol,bestBid:101,bestAsk:101.01,eventTimeMs:AT_0410+2000,receivedAtMs:AT_0410+2000,updateId:1});expect(trade.momentumExit!.floorNetPct).toBe(.4);
  f.setTime(AT_0410+3000);const event={symbol,bestBid:100.7,bestAsk:100.71,eventTimeMs:AT_0410+3000,receivedAtMs:AT_0410+3000,updateId:2};f.lane.ingestExecutableBookTicker(event);f.lane.ingestExecutableBookTicker({...event,updateId:3});
  for(let i=0;i<100&&trade.status!=='CLOSED';i++)await new Promise(r=>setTimeout(r,1));
  expect(trade.status).toBe('CLOSED');expect(trade.exitReason).toBe('MOMENTUM_MFE_GIVEBACK');expect(f.client.placed.filter(x=>x.symbol===symbol&&x.reduceOnly)).toHaveLength(1);expect([...f.client.algos.values()].filter(x=>x.symbol===symbol)).toHaveLength(0);
 });
 it('migrates an existing protected momentum position by addingTP without changing its entry orSL',async()=>{
  const f=fixture();await f.activate();const trade=f.store.getState().trades[0]!;const stop=trade.stopAlgoOrderId,entry=trade.entryOrderId;
  f.client.algos.delete(trade.takeProfitAlgoOrderId!);trade.takeProfitAlgoOrderId=null;trade.takeProfitPrice=null;delete trade.momentumExit;f.store.save();f.setTime(AT_0410+10000);await f.lane.tick();expect(trade.status).toBe('OPEN');expect(trade.stopAlgoOrderId).toBe(stop);expect(trade.entryOrderId).toBe(entry);expect(trade.momentumExit!.nativeTpVerified).toBe(true);expect(trade.takeProfitAlgoOrderId).not.toBeNull();
 });
 it('defers first adoption during cutover drain but keeps adopted profit exits active while drained',async()=>{
  let allowed=true;const f=fixture({gate:()=>allowed});await f.activate();const trade=f.store.getState().trades[0]!;
  f.client.algos.delete(trade.takeProfitAlgoOrderId!);trade.takeProfitAlgoOrderId=null;trade.takeProfitPrice=null;delete trade.momentumExit;f.store.save();
  allowed=false;f.setTime(AT_0410+10000);await f.lane.tick();expect(trade.momentumExit).toBeUndefined();expect(trade.takeProfitAlgoOrderId).toBeNull();
  allowed=true;await f.lane.tick();expect(trade.momentumExit!.nativeTpVerified).toBe(true);
  allowed=false;f.setTime(AT_0410+11000);f.lane.ingestExecutableBookTicker({symbol:trade.symbol,bestBid:101,bestAsk:101.01,eventTimeMs:AT_0410+11000,receivedAtMs:AT_0410+11000,updateId:1});expect(trade.momentumExit!.floorNetPct).toBe(.4);
  f.setTime(AT_0410+12000);f.lane.ingestExecutableBookTicker({symbol:trade.symbol,bestBid:100.7,bestAsk:100.71,eventTimeMs:AT_0410+12000,receivedAtMs:AT_0410+12000,updateId:2});
  for(let i=0;i<100&&trade.status!=='CLOSED';i++)await new Promise(r=>setTimeout(r,1));expect(trade.status).toBe('CLOSED');
 });
 it('does not repeat an ambiguous TP POST and still processes profit exits',async()=>{
  const f=fixture();await f.activate();const trade=f.store.getState().trades[0]!;
  f.client.algos.delete(trade.takeProfitAlgoOrderId!);trade.takeProfitAlgoOrderId=null;trade.takeProfitPrice=null;delete trade.momentumExit;f.store.save();
  const original=f.client.placeAlgoOrder.bind(f.client);let attempts=0;f.client.placeAlgoOrder=async p=>{if(p.type==='TAKE_PROFIT_MARKET'&&p.symbol===trade.symbol){attempts++;throw new Error('ambiguous TP network response');}return original(p);};
  f.setTime(AT_0410+10000);await f.lane.tick();await f.lane.tick();expect(attempts).toBe(1);expect(trade.momentumExit!.nativeTpVerified).toBe(false);expect(trade.stopAlgoOrderId).not.toBeNull();
  f.setTime(AT_0410+11000);f.lane.ingestExecutableBookTicker({symbol:trade.symbol,bestBid:104,bestAsk:104.01,eventTimeMs:AT_0410+11000,receivedAtMs:AT_0410+11000,updateId:1});
  for(let i=0;i<100&&trade.status!=='CLOSED';i++)await new Promise(r=>setTimeout(r,1));expect(trade.status).toBe('CLOSED');expect(trade.exitReason).toBe('MOMENTUM_LADDER_TP');expect(attempts).toBe(1);
 });
 it('recovers a persisted profit-exit intent afterrestart without waiting48hours',async()=>{
  const f=fixture();await f.activate();const trade=f.store.getState().trades[0]!;trade.momentumExit!.exitIntentAt=AT_0410+2000;trade.momentumExit!.exitReason='MOMENTUM_MFE_GIVEBACK';trade.momentumExit!.exitQuote=100.7;f.store.save();
  const restarted=new DailyRangeAcceptanceLane({client:f.client,store:new DailyRangeLaneStore(f.dir,'state.json'),getUniverse:()=>({symbols,source:'TEST'}),getShortBlocklist:()=>new Set(),entryClaims:{tryClaimEntrySymbol:()=>true,releaseEntrySymbol:()=>{}},environment:'testnet',strategyMode:'MOMENTUM_4H_V1',testnetMaxOpenTrades:4,readMomentumSnapshot:async()=>snapshot(),nowMs:()=>AT_0410+3000,confirmRetryMs:0});await restarted.tick();expect(f.client.placed.filter(x=>x.symbol===trade.symbol&&x.reduceOnly)).toHaveLength(1);
 });
});

describe('momentum transport readiness and cooldown recovery',()=>{
 const ban=()=>new BinanceFuturesPrivateError('429','rate limited (HTTP 418); cooldown',{httpStatus:418,retryAt:new Date(AT_0410+60000).toISOString()});
 it('never labels startup reconciled when the account read was blocked',async()=>{
  const f=fixture();await f.activate();const original=f.client.getPositions.bind(f.client);f.client.getPositions=async()=>{throw ban();};
  const restarted=new DailyRangeAcceptanceLane({client:f.client,store:f.store,getUniverse:()=>({symbols,source:'TEST'}),getShortBlocklist:()=>new Set(),entryClaims:{tryClaimEntrySymbol:()=>true,releaseEntrySymbol:()=>{}},environment:'testnet',strategyMode:'MOMENTUM_4H_V1',readMomentumSnapshot:async()=>snapshot(),nowMs:()=>AT_0410+2000,confirmRetryMs:0});
  await restarted.tick();expect(restarted.getStatus().reconciled).toBe(false);expect(f.client.placed).toHaveLength(3);expect(f.store.getState().runtime.reconciliationError).toContain('418');
  f.client.getPositions=original;await restarted.tick();expect(restarted.getStatus().reconciled).toBe(true);
 });
 it('reports global cooldown despite ARMED control and keeps a giveback intent without sending until recovery',async()=>{
  const f=fixture();await f.activate();const t=f.store.getState().trades[0]!;let cooling=false;
  (f.client as any).getRateLimitStatus=()=>({coolingDown:cooling,lastHttpStatus:418,retryAt:cooling?new Date(AT_0410+60000).toISOString():null});
  f.setTime(AT_0410+2000);f.lane.ingestExecutableBookTicker({symbol:t.symbol,bestBid:101,bestAsk:101.01,eventTimeMs:AT_0410+2000,receivedAtMs:AT_0410+2000,updateId:1});
  cooling=true;expect(f.lane.getStatus()).toMatchObject({reconciled:false,control:{mode:'ARMED'},exitExecution:{canSubmit:false,state:'BLOCKED_COOLDOWN'}});
  f.setTime(AT_0410+3000);f.lane.ingestExecutableBookTicker({symbol:t.symbol,bestBid:100.7,bestAsk:100.71,eventTimeMs:AT_0410+3000,receivedAtMs:AT_0410+3000,updateId:2});
  expect(t.momentumExit!.exitIntentAt).toBe(AT_0410+3000);expect(t.status).toBe('OPEN');expect(f.client.placed.filter(x=>x.reduceOnly)).toHaveLength(0);
  cooling=false;await f.lane.tick();expect(t.status).toBe('CLOSED');expect(f.client.placed.filter(x=>x.symbol===t.symbol&&x.reduceOnly)).toHaveLength(1);
 });
 it('retains an unsent exit when cooldown begins between position verification and POST',async()=>{
  const f=fixture();await f.activate();const t=f.store.getState().trades[0]!;const original=f.client.placeOrder.bind(f.client);
  f.client.placeOrder=async p=>{if(p.reduceOnly)throw ban();return original(p);};t.momentumExit!.exitIntentAt=AT_0410+2000;t.momentumExit!.exitReason='MOMENTUM_MFE_GIVEBACK';t.momentumExit!.exitQuote=100.7;
  await (f.lane as any).emergencyFlatten(t,'CLOSED','MOMENTUM_MFE_GIVEBACK');expect(t.status).toBe('OPEN');expect(t.lastReconcileError).toContain('not sent');
  f.client.placeOrder=original;await f.lane.tick();expect(t.status).toBe('CLOSED');expect(f.client.placed.filter(x=>x.symbol===t.symbol&&x.reduceOnly)).toHaveLength(1);
 });
 it('does not replay a dispatched exit with an uncertain exchange result',async()=>{
  const f=fixture();await f.activate();const t=f.store.getState().trades[0]!;let attempts=0;const original=f.client.placeOrder.bind(f.client);
  f.client.placeOrder=async p=>{if(p.reduceOnly){attempts++;p.onDispatch?.(AT_0410+2000);throw ban();}return original(p);};t.momentumExit!.exitIntentAt=AT_0410+2000;t.momentumExit!.exitReason='MOMENTUM_MFE_GIVEBACK';t.momentumExit!.exitQuote=100.7;
  await (f.lane as any).emergencyFlatten(t,'CLOSED','MOMENTUM_MFE_GIVEBACK');expect(t.status).toBe('EXIT_RECONCILING');await f.lane.tick();expect(attempts).toBe(1);
 });
 it('scopes a single owned position read to its symbol without inspecting unrelated orders',async()=>{
  const f=fixture();await f.activate();const [t,...others]=f.store.getState().trades;for(const row of others)row.status='CLOSED';
  const requested:Array<string|undefined>=[];const original=f.client.getOpenAlgoOrders.bind(f.client);f.client.getOpenAlgoOrders=async symbol=>{requested.push(symbol);return original(symbol);};
  await(f.lane as any).reconcileOpenTrades();expect(requested).toEqual([t!.symbol]);expect(t!.status).toBe('OPEN');
 });
});

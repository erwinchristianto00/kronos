import {DUAL4H_IMPROVEMENT} from '../src/lib/dual4h-improvement.js';
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
 const lane=new DailyRangeAcceptanceLane({client,store,getUniverse:()=>({symbols,source:'TEST'}),getShortBlocklist:()=>new Set(),entryClaims:{tryClaimEntrySymbol:()=>true,releaseEntrySymbol:()=>{}},environment:options.environment??'testnet',strategyMode:'MOMENTUM_4H_V1',structuralSrPolicyEnabled:true,testnetMaxOpenTrades:4,readMomentumSnapshot:options.snapshot??(async()=>snapshot()),nowMs:()=>now,confirmRetryMs:0,entryGate:()=>({allowed:options.gate?.()??true,reason:'fixture gate'})});
 return {client,store,lane,dir,setTime(t:number){now=t;client.now=t;},async activate(){await lane.tick();store.arm(new Date(now).toISOString());now=AT_0410+1000;client.now=now;await lane.tick();}};
}

function profileSnapshot():MomentumSnapshot{
 const s=snapshot();s.dualFeatures=[['ADAUSDT','MOMENTUM',1,'THESIS_12H',12,null],['LTCUSDT','FADE',2,'TIME_6H',6,null],['LINKUSDT','FADE',2,'FIXED_1_5R_24H',24,1.5]].map(([symbol,family,stopPct,exitKind,maxHoldHours,targetR],index)=>{
  const f=momentumFeature(symbol as string,s,AT_0410)!;f.fundingRateReserve=.0003;
  f.dual={improvementId:DUAL4H_IMPROVEMENT.id,confirmationLevel:99.8,family:family as 'MOMENTUM'|'FADE',sourceBoundary:AT_0410,thesisLevel:95,score:3-index,signalBar:f.lastBar,entryKind:family==='MOMENTUM'?'MOMENTUM_DIRECT':'BREAKOUT_FADE',stopPct:stopPct as number,exitKind:exitKind as string,maxHoldHours:maxHoldHours as number,targetR:targetR as number|null};return f;
 });return s;
}
describe('v2 execution authority',()=>{
 it('routes only Momentum to orders, preserving risk and brackets',async()=>{
  const f=fixture({snapshot:async()=>profileSnapshot()});await f.activate();const tr=f.store.getState().trades;
  expect(tr.map(t=>t.symbol)).toEqual(['ADAUSDT']);expect(tr.every(t=>t.status==='OPEN')).toBe(true);
  expect(tr.every(t=>t.momentum!.plannedLoss<=.25)).toBe(true);
  expect(f.client.placed.filter(o=>!o.reduceOnly)).toHaveLength(1);
  expect((f.lane.getStatus() as any).experiment.improvement.executableFamilies).toEqual(['MOMENTUM']);
  expect((f.lane.getStatus() as any).lastDecision.candidates.find((x:any)=>x.symbol==='LINKUSDT').reason).toBe('FADE_PROFILE_SHADOW_ONLY');
  expect((f.lane.getStatus() as any).lastDecision.candidates.find((x:any)=>x.symbol==='LTCUSDT').reason).toBe('FADE_PROFILE_SHADOW_ONLY');
  await f.lane.tick();expect(f.client.placed.filter(o=>!o.reduceOnly)).toHaveLength(1);
 });
 it('allows confirmed entry at08:30UTC instead of requiring the old08:00 instant',async()=>{
  let ready=false;const snap=profileSnapshot();for(const x of snap.dualFeatures!)x.decisionTime=AT_0410+1800000;
  const f=fixture({snapshot:async()=>ready?snap:{...snap,dualFeatures:[]}});await f.activate();expect(f.client.placed).toHaveLength(0);
  ready=true;f.setTime(AT_0410+1800000+1000);await f.lane.tick();
  expect(f.store.getState().trades.map(t=>t.symbol)).toEqual(['ADAUSDT']);
 });
 it('cannot open until operator arm; restart does not arm the lane',async()=>{
  const f=fixture({snapshot:async()=>profileSnapshot()});f.setTime(AT_0410+1000);await f.lane.tick();
  expect(f.client.placed).toHaveLength(0);expect(f.store.getState().control.mode).toBe('DISARMED');
 });
 it('rejects old policy features and direct calls to shadow-only execution',async()=>{
  const snap=profileSnapshot();for(const f of snap.dualFeatures!)delete f.dual!.improvementId;
  const f=fixture({snapshot:async()=>snap});await f.activate();expect(f.client.placed).toHaveLength(0);
  const feature=profileSnapshot().dualFeatures![1]!;
  const plan=momentumPlan(feature,filter(feature.symbol),100,100.01,AT_0410+1000)!;
  await (f.lane as any).executeFreshSignal({signalId:'shadow-test',strategyVersion:MOMENTUM4H_VERSION,symbol:feature.symbol,momentum:plan});
  expect(f.client.placed).toHaveLength(0);expect(f.store.getState().trades).toHaveLength(0);
 });
 it('manages inherited shadow-only positions while disarmed without rewriting exit policy',async()=>{
  const f=fixture({snapshot:async()=>profileSnapshot()});await f.activate();
  const t=f.store.getState().trades.find(t=>t.symbol==='ADAUSDT')!;
  t.momentum!.dual!.family='FADE';
  t.momentum!.dual!.exitKind='TIME_6H';t.momentum!.dual!.maxHoldHours=6;delete t.momentum!.dual!.improvementId;
  t.momentumExit!.deadline=AT_0410+6*3600000;f.store.save();f.lane.disarm('manual');
  f.setTime(AT_0410+6*3600000+1001);await f.lane.tick();
  expect(t.status).toBe('CLOSED');expect(t.exitReason).toBe('DUAL4H_6H_TIME_CAP');
  expect(f.client.placed.filter(o=>!o.reduceOnly)).toHaveLength(1);
 });
 it('baseline net2 trailing still closes once while entry is disarmed',async()=>{
  const f=fixture({snapshot:async()=>profileSnapshot()});await f.activate();f.lane.disarm('manual');
  const t=f.store.getState().trades.find(t=>t.symbol==='ADAUSDT')!;f.setTime(AT_0410+3000);
  f.lane.ingestExecutableBookTicker({symbol:t.symbol,bestBid:102.3,bestAsk:102.31,eventTimeMs:AT_0410+3000,receivedAtMs:AT_0410+3000,updateId:1});expect(t.momentumExit!.floorNetPct).toBeGreaterThanOrEqual(1);
  f.setTime(AT_0410+4000);f.lane.ingestExecutableBookTicker({symbol:t.symbol,bestBid:101,bestAsk:101.01,eventTimeMs:AT_0410+4000,receivedAtMs:AT_0410+4000,updateId:2});
  for(let i=0;i<100&&t.status!=='CLOSED';i++)await new Promise(r=>setTimeout(r,1));
  expect(t.status).toBe('CLOSED');expect(f.client.placed.filter(o=>o.reduceOnly&&o.symbol===t.symbol)).toHaveLength(1);
 });
});

it('blocks every Fade exit profile even through execution probes before any order',async()=>{
 for(const exitKind of ['THESIS_12H','TIME_6H','FIXED_1_5R_24H']){
  const f=fixture({snapshot:async()=>({...profileSnapshot(),dualFeatures:[]})});await f.activate();
  const feature=profileSnapshot().dualFeatures![2]!;feature.dual!.exitKind=exitKind;
  const plan=momentumPlan(feature,filter(feature.symbol),100,100.01,AT_0410+1000)!;
  (plan as any).executionProbe=true;
  await (f.lane as any).executeFreshSignal({signalId:'fade-probe',strategyVersion:MOMENTUM4H_VERSION,symbol:feature.symbol,momentum:plan});
  expect(f.client.placed).toHaveLength(0);expect(f.store.getState().trades).toHaveLength(0);
 }
});

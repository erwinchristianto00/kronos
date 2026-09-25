import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AstraHermesLane, validateAstraDecision, type AstraDecision, type AstraDeps } from "../src/lib/astra-hermes-lane.js";
import { AccountExposureCoordinator, AccountExposureReservationStore } from "../src/lib/account-exposure-coordinator.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const decision = (x: Partial<AstraDecision> = {}): AstraDecision => {
  const d: AstraDecision = { id: "test_order_001", action: "OPEN", reason: "Measured test hypothesis",
    symbol: "DOGEUSDT", side: "LONG", notionalUsd: 20, stopPrice: 8, targetPrice: 12, maxHoldMs: 3600000, slippageBps: 20, ...x };
  if (!("entryContract" in x)) d.entryContract = {
    version: 1, planId: "test_frozen_plan", validatedAt: 1800000000000, expiresAt: 1800003600000,
    symbol: d.symbol!, side: d.side!, notionalUsd: d.notionalUsd!, stopPrice: d.stopPrice!, targetPrice: d.targetPrice!,
    maxHoldMs: d.maxHoldMs!, triggerPrice: 10, entryMin: 9.8, entryMax: 10.2,
    maxSpreadBps: 30, maxCostBps: 80, entrySlippageBps: d.slippageBps!, exitSlippageBps: 10,
    fundingAllowanceBps: 5, takerRate: 0.0005,
  };
  return d;
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "astra-test-")); dirs.push(dir);
  let now = 1800000000000, net = 0, serial = 0;
  let entryFraction = 1, exitFraction = 1, lostEntry = false, lostClose = false;
  const orders = new Map<string, any>(), fills: any[] = [], algos: any[] = [];
  const client = {
    getExchangeFilters: vi.fn(async () => new Map([["DOGEUSDT", { symbol: "DOGEUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 }]])),
    getBookTicker: vi.fn(async () => ({ bid: 9.99, ask: 10, time: now })),
    getExecutionBookTickers: vi.fn(async (symbols: readonly string[]) => new Map(symbols.map(symbol => [symbol, { bid: 9.99, ask: 10, time: now }]))),
    getPositions: vi.fn(async () => net === 0 ? [] : [{ symbol: "DOGEUSDT", positionAmt: net, entryPrice: 10, markPrice: 10, unRealizedProfit: 0, leverage: 1 }]),
    getBalances: vi.fn(async () => [{ asset: "USDT", balance: 10000, availableBalance: 10000 }]),
    getOpenOrders: vi.fn(async () => []),
    getOpenAlgoOrders: vi.fn(async () => algos.filter(a => a.algoStatus === "NEW")),
    setLeverage: vi.fn(async () => {}),
    placeOrder: vi.fn(async (p: any) => {
      const executedQty = p.quantity * (p.reduceOnly ? exitFraction : entryFraction);
      const order = { symbol: p.symbol, clientOrderId: p.newClientOrderId, orderId: String(++serial),
        origQty: p.quantity, executedQty, avgPrice: 10, status: "EXPIRED", updateTime: now };
      orders.set(p.newClientOrderId, order);
      if (executedQty > 0) {
        net += (p.side === "BUY" ? 1 : -1) * executedQty;
        if (Math.abs(net) < 1e-9) net = 0;
        fills.push({ symbol: p.symbol, orderId: order.orderId, tradeId: order.orderId, qty: executedQty,
          price: 10, realizedPnl: 0, commission: executedQty * 10 * 0.0004, commissionAsset: "USDT", time: now, maker: false });
      }
      if ((!p.reduceOnly && lostEntry) || (p.reduceOnly && lostClose)) throw new Error("response lost after accepted order");
      return order;
    }),
    queryOrderByClientId: vi.fn(async (_s: string, id: string) => { if (!orders.has(id)) throw new Error("-2013 unknown order"); return orders.get(id); }),
    placeAlgoOrder: vi.fn(async (p: any) => { const a = { ...p, algoId: String(++serial), algoStatus: "NEW", actualOrderId: null }; algos.push(a); return a; }),
    queryAlgoOrder: vi.fn(async (id: string) => algos.find(a => a.algoId === id)),
    cancelAlgoOrder: vi.fn(async (id: string) => { algos.find(a => a.algoId === id).algoStatus = "CANCELED"; }),
    getUserTrades: vi.fn(async () => fills),
    getIncomeHistory: vi.fn(async () => []), getKlines: vi.fn(async () => []),
  };
  const exposure = { reserve: vi.fn(() => ({ ok: true, reservationId: "reservation" })), commitReservation: vi.fn(), releaseReservation: vi.fn(), updatePositionSnapshot: vi.fn() };
  const deps: AstraDeps = { environment: "testnet", file: join(dir, "ledger.json"), client: client as unknown as AstraDeps["client"], now: () => now,
    exposure, entryBlock: () => null, foreignSymbols: () => [], tryClaim: () => true, releaseClaim: vi.fn() };
  const lane = new AstraHermesLane(deps);
  return { lane, deps, client, exposure, orders, fills, algos,
    setNet: (n: number) => { net = n; }, advance: (ms: number) => { now += ms; },
    fraction: (entry: number, exit = 1) => { entryFraction = entry; exitFraction = exit; },
    loseResponse: (entry: boolean, close = false) => { lostEntry = entry; lostClose = close; } };
}

describe("Astra Testnet authority, real fills and durable ownership", () => {
  it("coalesces overlapping protection ticks without queuing stale work ahead of decisions", async () => {
    const x = setup();
    const opened: any = await x.lane.decide(decision());
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const query = x.client.queryAlgoOrder.getMockImplementation()!;
    x.client.queryAlgoOrder.mockClear();
    x.client.queryAlgoOrder.mockImplementationOnce(async id => {
      entered(); await blocked; return query(id);
    });
    const first = x.lane.tick(); await started;
    const repeated = Array.from({length: 20}, () => x.lane.tick());
    const hold = {id: 'hold_after_slow_tick', action: 'WAIT' as const, reason: 'Keep protected ownership'};
    const receipt = x.lane.decide(hold);
    release(); await Promise.all([first, ...repeated]);
    expect(await receipt).toEqual({status: 'WAIT_RECORDED'});
    expect(x.client.queryAlgoOrder).toHaveBeenCalledTimes(1);
    expect(x.client.placeOrder).toHaveBeenCalledTimes(1);
    expect(x.client.cancelAlgoOrder).not.toHaveBeenCalled();
    expect(x.lane.status().active[0].stopId).toBe(opened.stopId);
    await x.lane.tick();
    expect(x.client.queryAlgoOrder).toHaveBeenCalledTimes(2);
    expect(await x.lane.decide(hold)).toEqual({status: 'WAIT_RECORDED'});
  });
  it("releases the tick latch after a read failure and preserves native protection", async () => {
    const x=setup(); await x.lane.decide(decision());
    x.client.getUserTrades.mockRejectedValueOnce(new Error('temporary accounting read failure'));
    await x.lane.tick();
    expect(x.lane.status().active[0].error).toContain('temporary accounting');
    await x.lane.tick();
    expect(x.lane.status().active[0].error).toBeNull();
    expect(x.client.placeOrder).toHaveBeenCalledTimes(1);
    expect(x.client.cancelAlgoOrder).not.toHaveBeenCalled();
  });
  it("formation metadata skips duplicate history and BBO but retains authenticated filters and wallet", async () => {
    const x = setup();
    const r = await x.lane.market(['DOGEUSDT'], 0, 'FORMATION_METADATA_V1');
    expect(r.contextMode).toBe('FORMATION_METADATA_V1');
    expect(r.marketDataComplete).toBe(false); expect(r.orderAuthority).toBe(false);
    expect(r.rows[0].candles).toEqual([]); expect(r.rows[0].book).toBeNull();
    expect(r.rows[0].filters?.minNotional).toBe(5);
    expect(r.status.environment).toBe('testnet');
    expect(x.client.getBalances).toHaveBeenCalledTimes(1);
    expect(x.client.getKlines).not.toHaveBeenCalled();
    expect(x.client.getExecutionBookTickers).not.toHaveBeenCalled();
    expect(x.client.placeOrder).not.toHaveBeenCalled();
    await x.lane.market(['DOGEUSDT']);
    expect(x.client.getKlines).toHaveBeenCalledTimes(1);
    expect(x.client.getExecutionBookTickers).toHaveBeenCalledTimes(1);
  });
  it("metadata rejects unknown modes and unbounded, duplicate or unlisted symbols", async () => {
    const x = setup();
    await expect(x.lane.market(['DOGEUSDT'], 0, 'FAST_UNGUARDED')).rejects.toThrow('Unknown context mode');
    for (const symbols of [[], ['DOGEUSDT','DOGEUSDT'], Array(7).fill('DOGEUSDT')]) {
      await expect(x.lane.market(symbols, 0, 'FORMATION_METADATA_V1')).rejects.toThrow('1..6 unique');
    }
    await expect(x.lane.market(['UNKNOWNUSDT'], 0, 'FORMATION_METADATA_V1')).rejects.toThrow('not executable');
    expect(x.client.getKlines).not.toHaveBeenCalled(); expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("rejects missing contracts but still replays a legacy durable decision without resubmitting", async () => {
    const x = setup();
    const d = decision({entryContract: undefined});
    const rejected: any = await x.lane.decide(d);
    expect(rejected.entryGate.failedPredicate).toBe("entryContract");
    expect(x.client.placeOrder).not.toHaveBeenCalled();
    expect(x.client.setLeverage).not.toHaveBeenCalled();
    const legacy = { ...d, id: "legacy_open_0001" };
    writeFileSync(x.deps.file, JSON.stringify({version:1,initialEquity:25,trades:[],
      decisions:[{at:1800000000000,decision:legacy,result:{status:"LEGACY_ALREADY_DONE"}}],funding:[],fundingThrough:1800000000000,lastError:null}));
    const restored = new AstraHermesLane(x.deps);
    expect(await restored.decide(legacy)).toEqual({status:"LEGACY_ALREADY_DONE"});
    expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it.each(["LONG", "SHORT"] as const)("rejects %s final-book drift after earlier approval and persists the predicate across retry", async side => {
    const x=setup(); const d=decision({side,stopPrice:side==="LONG"?8:12,targetPrice:side==="LONG"?12:8});
    x.client.getBookTicker.mockResolvedValue({bid:10.3,ask:10.31,time:1800000000000});
    const r:any=await x.lane.decide(d);
    expect(r.entryGate.failedPredicate).toBe("entryBand");
    expect(x.client.placeOrder).not.toHaveBeenCalled(); expect(x.exposure.reserve).not.toHaveBeenCalled();
    x.client.getBookTicker.mockResolvedValue({bid:9.99,ask:10,time:1800000000000});
    expect(await x.lane.decide(d)).toEqual(r);
    expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("rejects spread/cost drift on final book before reservation/order",async()=>{
    const x=setup(); const d=decision(); d.entryContract!.maxSpreadBps=5;
    const r:any=await x.lane.decide(d);
    expect(r.entryGate.failedPredicate).toBe("spread"); expect(x.exposure.reserve).not.toHaveBeenCalled();
    expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("passes the inward-rounded band limit into the actual IOC order and preserves sizing",async()=>{
    const x=setup();const d=decision(); d.entryContract!.entryMax=10.009;
    const r:any=await x.lane.decide(d);
    expect(r.state).toBe("OPEN");expect(r.entryGate.bandClamped).toBe(true);
    expect(x.client.placeOrder.mock.calls[0][0]).toMatchObject({price:10,timeInForce:"IOC",quantity:1.996});
    expect(r.decision.entryContract).toEqual(d.entryContract);
    expect(r.entryGate.limitPrice).toBe(r.limitPrice);
    expect(x.client.placeAlgoOrder.mock.calls[0][0]).toMatchObject({triggerPrice:8,reduceOnly:true,workingType:"MARK_PRICE"});
  });
  it("adopts and protects terminal fills whose initial avgPrice is zero, then queries the same order", async () => {
    const x = setup(); const submit = x.client.placeOrder.getMockImplementation()!;
    x.client.placeOrder.mockImplementation(async (p: any) => ({ ...await submit(p), avgPrice: 0 }));
    const query = x.client.queryOrderByClientId.getMockImplementation()!;
    x.client.queryOrderByClientId.mockImplementation(async (s: string, id: string) => {
      expect(x.algos).toHaveLength(1); // Native protection already exists before the price GET.
      return query(s,id);
    });
    const t: any = await x.lane.decide(decision());
    expect(t.state).toBe("OPEN"); expect(t.entryPrice).toBe(10); expect(t.stopId).not.toBeNull();
    expect(x.client.placeOrder).toHaveBeenCalledTimes(1); expect(x.client.queryOrderByClientId).toHaveBeenCalledTimes(1);
  });
  it("retains actual quantity and native stop if average-price recovery is temporarily unavailable", async () => {
    const x = setup(); const submit = x.client.placeOrder.getMockImplementation()!;
    x.client.placeOrder.mockImplementation(async (p: any) => ({ ...await submit(p), avgPrice: 0 }));
    x.client.queryOrderByClientId.mockRejectedValue(new Error("price read unavailable"));
    await x.lane.decide(decision());
    const t = x.lane.status().active[0];
    expect(t.qty).toBeGreaterThan(0); expect(t.state).toBe("OPEN"); expect(t.stopId).not.toBeNull();
    expect(t.error).toBe("price read unavailable"); expect(x.client.placeOrder).toHaveBeenCalledTimes(1);
  });
  it("delivers venue fee and funding through the final context without touching execution", async () => {
    const x = setup();
    Object.assign(x.client, {
      getAstraTicker24h: vi.fn(async () => [{ symbol: "DOGEUSDT", priceChangePercent: 3, quoteVolume: 100000, highPrice: 11, lowPrice: 9, lastPrice: 10, closeTime: 1800000000000 }]),
      getAstraCommissionRate: vi.fn(async () => ({ symbol: "DOGEUSDT", makerCommissionRate: 0.0002, takerCommissionRate: 0.0005 })),
      getAstraPremiumIndexes: vi.fn(async () => [{ symbol: "DOGEUSDT", markPrice: 10, indexPrice: 10, lastFundingRate: 0.0001, nextFundingTime: 1800000100000, time: 1800000000000 }]),
    });
    const full = await x.lane.market([]);
    expect(full.overview?.[0]).toMatchObject({ change24hPct: 3, quoteVolume24h: 100000 });
    expect(full.screening?.highestQuoteVolume24h).toEqual(["DOGEUSDT"]);
    const selected = await x.lane.market(["DOGEUSDT"]);
    expect(selected.contextVersion).toBe("ASTRA_EXPERIMENT_CONTEXT_V2");
    expect(selected.rows[0].economics.commission.takerRate).toBe(0.0005);
    expect(selected.rows[0].economics.roundTripTakerFeeBps).toBe(10);
    expect(selected.rows[0].economics.funding.nextSettlementCostBpsIfRateUnchanged).toEqual({ LONG: 1, SHORT: -1 });
    expect(x.client.placeOrder).not.toHaveBeenCalled(); expect(x.client.setLeverage).not.toHaveBeenCalled();
  });
  it("keeps reason classification compatible with legacy decisions but validates new action/code pairs", async () => {
    const x = setup();
    const result = await x.lane.decide({ id: "new_wait_0001", action: "WAIT", reason: "Trigger absent", reasonCode: "NO_SETUP" });
    expect(result).toEqual({ status: "WAIT_RECORDED" });
    expect(x.lane.status().decisions[0].decision.reasonCode).toBe("NO_SETUP");
    expect(() => validateAstraDecision(decision({ reasonCode: "NO_SETUP" }))).toThrow("Reason code");
    expect(() => validateAstraDecision(decision({ reasonCode: "EXPERIMENT_OPEN" }))).not.toThrow();
    expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  function markets(count = 47) {
    const x = setup();
    const symbols = Array.from({ length: count }, (_, i) => `COIN${i}USDT`);
    const filter = { symbol: "", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 };
    x.client.getExchangeFilters.mockResolvedValue(new Map(symbols.map(symbol => [symbol, { ...filter, symbol }])));
    return { ...x, symbols };
  }
  it("shows every eligible contract in one overview with missing books explicit and foreign ownership visible", async () => {
    const x = markets(); x.deps.foreignSymbols = () => [x.symbols[46]];
    x.client.getExecutionBookTickers.mockResolvedValue(new Map());
    const result = await x.lane.market([]);
    expect(result.universe).toEqual(x.symbols); expect(result.overview).toHaveLength(47);
    expect(result.overview?.[46]).toMatchObject({ symbol: x.symbols[46], book: null, unavailableForNewEntry: true });
    expect(x.client.getExecutionBookTickers).toHaveBeenCalledExactlyOnceWith(x.symbols);
    expect(x.client.getKlines).not.toHaveBeenCalled(); expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("accepts more than five histories and returns every requested symbol across pages", async () => {
    const x = markets(); let offset: number | null = 0; const seen: string[] = [];
    do {
      const result = await x.lane.market(x.symbols, offset);
      expect(result.historyPage.requested).toBe(47);
      seen.push(...result.rows.map(r => r.symbol)); offset = result.historyPage.nextOffset;
    } while (offset !== null);
    expect(seen).toEqual(x.symbols); expect(x.client.getKlines).toHaveBeenCalledTimes(47);
    expect(x.client.getExecutionBookTickers).toHaveBeenCalledTimes(3);
    expect(x.client.getBookTicker).not.toHaveBeenCalled(); expect(x.client.placeOrder).not.toHaveBeenCalled();
    const six = await x.lane.market(x.symbols.slice(0, 6)); expect(six.rows).toHaveLength(6);
    expect(six.historyPage.nextOffset).toBeNull();
  });
  it("deduplicates requested symbols and rejects malformed requests before market reads", async () => {
    const x = markets(6);
    expect((await x.lane.market([...x.symbols, ...x.symbols])).rows).toHaveLength(6);
    x.client.getKlines.mockClear();
    for (const offset of [-1, 0.5, NaN, 7]) await expect(x.lane.market(x.symbols, offset)).rejects.toThrow();
    await expect(x.lane.market(["UNKNOWNUSDT"])).rejects.toThrow("not executable");
    await expect(x.lane.market([null] as any)).rejects.toThrow("symbol list");
    expect(x.client.getKlines).not.toHaveBeenCalled();
  });
  it("provides exact continuation when paced reads consume the page time budget", async () => {
    const x = markets(6);
    x.client.getKlines.mockImplementation(async () => { x.advance(31000); return []; });
    const first = await x.lane.market(x.symbols); expect(first.rows).toHaveLength(1);
    expect(first.historyPage.nextOffset).toBe(1);
    const next = await x.lane.market(x.symbols, 1); expect(next.rows[0].symbol).toBe(x.symbols[1]);
    expect(next.historyPage.nextOffset).toBe(2);
  });
  it.each(["TUSDT", "4USDT", "币安人生USDT"])("allows exchange-listed %s to reach the actual order plan", async symbol => {
    const x = setup();
    const filter = (await x.client.getExchangeFilters()).get("DOGEUSDT")!;
    x.client.getExchangeFilters.mockResolvedValue(new Map([[symbol, { ...filter, symbol }]]));
    const result: any = await x.lane.decide(decision({ symbol }));
    expect(result.state).toBe("OPEN");
    expect(x.client.placeOrder.mock.calls[0][0].symbol).toBe(symbol);
    expect(x.client.placeAlgoOrder.mock.calls[0][0].symbol).toBe(symbol);
  });
  it("still rejects unlisted names and foreign-owned contracts before orders", async () => {
    const x = setup();
    expect((await x.lane.decide(decision({ symbol: "FAKEUSDT" })) as any).reason).toContain("Inactive");
    x.deps.foreignSymbols = () => ["DOGEUSDT"];
    expect((await x.lane.decide(decision({ id: "foreign_symbol_test" })) as any).reason).toContain("already owned");
    expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("refuses mainnet and corrupt state without resetting history", () => {
    const x = setup(); expect(() => new AstraHermesLane({ ...x.deps, environment: "mainnet" })).toThrow("TESTNET ONLY");
    writeFileSync(x.deps.file, "{corrupt"); expect(() => new AstraHermesLane(x.deps)).toThrow();
  });
  it("rejects malformed sizes and arbitrary action paths", () => {
    for (const d of [decision({ notionalUsd: NaN }), decision({ stopPrice: 0 }), decision({ action: "DEPLOY" as any }), decision({ symbol: "https://example.com" })])
      expect(() => validateAstraDecision(d)).toThrow();
  });
  it("caps each OPEN at 25 notional while using the actual wallet, not virtual equity", async () => {
    const x = setup();
    await expect(x.lane.decide(decision({ notionalUsd: 25.00001 }))).rejects.toThrow("Maximum entry notional");
    expect(x.client.placeOrder).not.toHaveBeenCalled();
    const t: any = await x.lane.decide(decision({ notionalUsd: 25 }));
    expect(t.state).toBe("OPEN"); expect(t.requestedQty * t.limitPrice).toBeLessThanOrEqual(25);
    expect(x.lane.status()).toMatchObject({ capital: { mode: "BINANCE_TESTNET_WALLET", maxEntryNotionalUsd: 25, maxOpenPositions: null, totalLaneAllocationUsd: null },
      wallet: { fresh: true, snapshot: { walletBalance: 10000, availableBalance: 10000 } }, dailyLossCap: null, leverage: 1 });
    expect(x.lane.status()).not.toHaveProperty("cashEquity");
  });
  it("allows multiple protected positions totaling more than 25, without subtracting margin twice", async () => {
    const x = setup(); const symbols = ["DOGEUSDT", "XRPUSDT", "ADAUSDT", "LTCUSDT"];
    const filter = (await x.client.getExchangeFilters()).get("DOGEUSDT")!;
    x.client.getExchangeFilters.mockResolvedValue(new Map(symbols.map(symbol => [symbol, { ...filter, symbol }])));
    x.client.getOpenAlgoOrders.mockImplementation(async (symbol?: string) => x.algos.filter(a => a.algoStatus === "NEW" && (!symbol || a.symbol === symbol)));
    x.client.getPositions.mockImplementation(async () => x.lane.status().active.map(t => ({ symbol: t.symbol, positionAmt: t.qty, entryPrice: 10, markPrice: 10, unRealizedProfit: 0, leverage: 1 })));
    x.client.getBalances.mockResolvedValue([{ asset: "USDT", balance: 10000, availableBalance: 30 }]);
    for (const symbol of symbols) {
      const t: any = await x.lane.decide(decision({ id: `multi_open_${symbol}`, symbol, notionalUsd: 25 }));
      expect(t.state).toBe("OPEN"); expect(t.stopId).not.toBeNull();
    }
    expect(x.lane.status().active).toHaveLength(4);
    expect(x.lane.openExposure().reduce((s,t) => s + t.qty * t.entryPrice, 0)).toBeGreaterThan(90);
    expect(x.client.placeOrder).toHaveBeenCalledTimes(4);
  });
  it("fails entry closed on insufficient or unavailable wallet without blocking management exits", async () => {
    const x = setup();
    x.client.getBalances.mockResolvedValue([{ asset: "USDT", balance: 10000, availableBalance: 20 }]);
    expect((await x.lane.decide(decision()) as any).reason).toContain("Testnet available balance");
    expect(x.client.placeOrder).not.toHaveBeenCalled();
    x.client.getBalances.mockResolvedValue([{ asset: "USDT", balance: 10000, availableBalance: 30 }]);
    const t: any = await x.lane.decide(decision({ id: "good_wallet_entry" }));
    x.client.getBalances.mockRejectedValue(new Error("wallet unavailable"));
    x.advance(31000); await x.lane.tick();
    expect(x.lane.report().wallet).toMatchObject({ fresh: false, error: "wallet unavailable", snapshot: { walletBalance: 10000 } });
    expect(x.lane.status().lastError).toBeNull();
    await x.lane.decide({ id: "wallet_down_close", action: "CLOSE", reason: "invalidated", reasonCode: "CUT_LOSS", tradeId: t.id });
    expect(x.lane.status().active).toHaveLength(0);
    expect(x.lane.report().closed[0].exitReason).toBe("CUT_LOSS");
  });
  it("does not spend a formerly valid cached balance when the mandatory pre-entry read fails", async () => {
    const x = setup(); await x.lane.market([]);
    expect(x.lane.status().wallet.fresh).toBe(true);
    x.client.getBalances.mockRejectedValue(new Error("balance read failed"));
    expect((await x.lane.decide(decision()) as any).reason).toContain("Fresh Testnet wallet required");
    expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("keeps dashboard reads pure, marks old wallet stale and recovers history across restart", async () => {
    const x = setup(); await x.lane.decide(decision());
    const calls = x.client.getBalances.mock.calls.length;
    x.advance(120001);
    expect(x.lane.report().wallet.fresh).toBe(false);
    x.lane.report(); x.lane.status();
    expect(x.client.getBalances).toHaveBeenCalledTimes(calls);
    const restored = new AstraHermesLane(x.deps);
    expect(restored.status().active[0].stopId).toBe(x.lane.status().active[0].stopId);
    expect(restored.status().fees).toBe(x.lane.status().fees);
    expect(restored.report().wallet.snapshot).toBeNull();
  });
  it("holds the symbol and protects only the actual partial entry fill", async () => {
    const x = setup(); x.fraction(0.5);
    const t: any = await x.lane.decide(decision());
    expect(t.qty).toBe(t.requestedQty / 2); expect(t.state).toBe("OPEN");
    expect(x.client.placeAlgoOrder.mock.calls[0][0]).toMatchObject({ quantity: t.qty, reduceOnly: true });
    expect(x.lane.managedNetQty().get("DOGEUSDT")).toBe(t.qty);
    expect(x.exposure.commitReservation).toHaveBeenCalledWith("reservation", { qty: t.qty, avgPrice: 10 });
    expect(x.deps.releaseClaim).toHaveBeenCalled();
  });
  it("protects fill before accounting retrieval", async () => {
    const x = setup(); x.client.getUserTrades.mockRejectedValue(new Error("history unavailable"));
    await x.lane.decide(decision());
    expect(x.client.placeAlgoOrder).toHaveBeenCalledTimes(1); expect(x.lane.leasedSymbols()).toEqual(["DOGEUSDT"]);
  });
  it("does not increase sub-minimum orders", async () => {
    const x = setup(); await x.lane.decide(decision({ notionalUsd: 2 })); expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("reduces an unprotected actual fill without removing the post-fill safety boundary", async () => {
    const x = setup(); x.client.placeAlgoOrder.mockRejectedValue(new Error("invalid stop"));
    await x.lane.decide(decision());
    expect(x.client.placeOrder).toHaveBeenCalledTimes(2);
    expect(x.client.placeOrder.mock.calls[1][0].reduceOnly).toBe(true);
    expect(x.lane.status().closed[0].safetyExitReason).toBe("NATIVE_PROTECTION_UNAVAILABLE");
  });
  it("rejects stale quotes and failed leverage before submission", async () => {
    const x = setup(); x.client.getBookTicker.mockResolvedValue({ bid: 10, ask: 10, time: 1 });
    await x.lane.decide(decision()); expect(x.client.placeOrder).not.toHaveBeenCalled();
    x.client.setLeverage.mockRejectedValue(new Error("not allowed"));
    await x.lane.decide(decision({ id: "second_test_order" })); expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("refuses another lane's position, order, or failed symbol claim", async () => {
    const x = setup(); x.setNet(3); await x.lane.decide(decision()); expect(x.client.placeOrder).not.toHaveBeenCalled();
    x.setNet(0); x.deps.tryClaim = () => false;
    await x.lane.decide(decision({ id: "another_test_order" })); expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent identical requests and rejects conflicting id reuse", async () => {
    const x = setup(); await Promise.all([x.lane.decide(decision()), x.lane.decide(decision())]);
    expect(x.client.placeOrder).toHaveBeenCalledTimes(1);
    await expect(x.lane.decide(decision({ notionalUsd: 15 }))).rejects.toThrow("Idempotency");
  });
  it("recovers an accepted entry with lost response after restart without resubmitting", async () => {
    const x = setup(); x.loseResponse(true); await x.lane.decide(decision());
    expect(x.lane.pendingEntryNetQty().get("DOGEUSDT")).toBeGreaterThan(0);
    const restarted = new AstraHermesLane(x.deps); await restarted.tick();
    expect(x.client.placeOrder).toHaveBeenCalledTimes(1); expect(restarted.status().active[0].stopId).not.toBeNull();
    expect(restarted.status().active[0].qty).toBeGreaterThan(0);
  });
  it("retains unresolved order ownership and never blind-retries", async () => {
    const x = setup(); x.client.placeOrder.mockRejectedValue(new Error("timeout before evidence"));
    await x.lane.decide(decision()); await x.lane.tick(); await x.lane.tick();
    expect(x.client.placeOrder).toHaveBeenCalledTimes(1); expect(x.lane.leasedSymbols()).toEqual(["DOGEUSDT"]);
  });
  it("records zero-fill IOC with no native stop and releases reservation", async () => {
    const x = setup(); x.fraction(0); const r: any = await x.lane.decide(decision());
    expect(r.state).toBe("NO_FILL"); expect(x.client.placeAlgoOrder).not.toHaveBeenCalled(); expect(x.lane.leasedSymbols()).toEqual([]);
  });
  it("closes only owned quantities reduce-only and books both actual commissions", async () => {
    const x = setup(); const t: any = await x.lane.decide(decision()); x.advance(1000);
    await x.lane.decide({ id: "close_test_001", action: "CLOSE", reason: "hypothesis invalidated", tradeId: t.id });
    expect(x.client.placeOrder.mock.calls[1][0]).toMatchObject({ reduceOnly: true, quantity: t.qty, type: "MARKET" });
    const status = x.lane.status(); expect(status.active).toHaveLength(0); expect(status.closed[0].settlementComplete).toBe(true);
    expect(status.fees).toBeCloseTo(t.qty * 10 * 0.0008); expect(status.net).toBeCloseTo(-status.fees);
  });
  it("does not resend a close accepted before a lost response", async () => {
    const x = setup(); const t: any = await x.lane.decide(decision()); x.loseResponse(false, true);
    await x.lane.decide({ id: "close_test_001", action: "CLOSE", reason: "exit", tradeId: t.id }); await x.lane.tick();
    expect(x.client.placeOrder).toHaveBeenCalledTimes(2); expect(x.lane.status().active).toHaveLength(0);
  });
  it("keeps partial close remainder owned, never claims full settlement", async () => {
    const x = setup(); const t: any = await x.lane.decide(decision()); x.fraction(1, 0.5);
    await x.lane.decide({ id: "close_test_001", action: "CLOSE", reason: "exit", tradeId: t.id });
    expect(x.lane.status().active[0].qty).toBeCloseTo(t.qty / 2); expect(x.lane.status().closed).toHaveLength(0);
  });
  it("refuses foreign trade ids and mismatched exchange netting", async () => {
    const x = setup(); const r: any = await x.lane.decide({ id: "close_foreign_001", action: "CLOSE", reason: "exit", tradeId: "someone_else" });
    expect(r.reason).toContain("owned by Astra");
    const t: any = await x.lane.decide(decision()); x.setNet(8);
    await x.lane.decide({ id: "close_test_001", action: "CLOSE", reason: "exit", tradeId: t.id });
    expect(x.client.placeOrder).toHaveBeenCalledTimes(1);
  });
  it("keeps lease when accounting is incomplete rather than learning a fabricated PnL", async () => {
    const x = setup(); const t: any = await x.lane.decide(decision());
    x.client.getUserTrades.mockResolvedValue([]);
    await x.lane.decide({ id: "close_test_001", action: "CLOSE", reason: "exit", tradeId: t.id });
    expect(x.lane.status().active[0].settlementComplete).toBe(false); expect(x.lane.leasedSymbols()).toEqual(["DOGEUSDT"]);
  });
  it("settles native stop fills, attributes funding once and never counts transfers", async () => {
    const x = setup(); const t: any = await x.lane.decide(decision());
    x.advance(20000); x.setNet(0);
    x.algos[0].algoStatus = "FINISHED"; x.algos[0].actualOrderId = "native-exit";
    x.fills.push({ ...x.fills[0], orderId: "native-exit", tradeId: "native-exit", time: t.createdAt + 20000, realizedPnl: -2 });
    x.client.getIncomeHistory.mockResolvedValue([
      { symbol: "DOGEUSDT", incomeType: "FUNDING_FEE", asset: "USDT", tranId: "fund1", income: -0.01, time: t.createdAt + 10000 },
      { symbol: "DOGEUSDT", incomeType: "TRANSFER", asset: "USDT", tranId: "transfer1", income: 100, time: t.createdAt + 10000 },
    ] as any);
    x.advance(50000); await x.lane.tick(); x.advance(70000); await x.lane.tick();
    expect(x.lane.status().active).toHaveLength(0); expect(x.lane.status().gross).toBe(-2);
    expect(x.lane.status().funding).toBe(-0.01); expect(x.lane.status().net).toBeLessThan(-2);
  });
  it("preserves the operator drain without installing a daily loss breaker", async () => {
    const x = setup(); x.deps.entryBlock = () => "Operator drain";
    const r: any = await x.lane.decide(decision()); expect(r.reason).toBe("Operator drain"); expect(x.client.placeOrder).not.toHaveBeenCalled();
  });
  it("includes external lane exposure immediately and avoids double-counting against exchange", () => {
    const x = setup(); const coordinator = new AccountExposureCoordinator({
      store: new AccountExposureReservationStore(dirnameOf(x.deps.file), "reservations.json"),
      getSingleSymbolExecutors: () => [], getCrossSectionalExecutors: () => [],
      getAdditionalOpenPositions: () => [{ symbol: "DOGEUSDT", direction: "LONG", qty: 2, entryPrice: 10 }],
      maxGrossExposureUsd: () => 30,
    });
    coordinator.updatePositionSnapshot([{ symbol: "DOGEUSDT", positionAmt: 2, entryPrice: 10, markPrice: 10 } as any]);
    expect(coordinator.reserve({ executorId: "OTHER", symbol: "XRPUSDT", direction: "LONG", requestedNotionalUsd: 9, clientOrderId: "test-budget" }).ok).toBe(true);
    expect(coordinator.reserve({ executorId: "OTHER", symbol: "ADAUSDT", direction: "LONG", requestedNotionalUsd: 2, clientOrderId: "test-budget2" }).ok).toBe(false);
  });
});
function dirnameOf(path: string) { return path.slice(0, path.lastIndexOf("/")); }

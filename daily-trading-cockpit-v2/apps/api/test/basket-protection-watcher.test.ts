import { beforeAll, afterAll } from "vitest";
let savedFetch: typeof fetch;
beforeAll(() => { savedFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("Protection simulation forbids real network"); }; });
afterAll(() => { globalThis.fetch = savedFetch; });
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { basketSelectionEvidence } from "../src/lib/basket-selection-report.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FuturesOrder, FuturesPosition, FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
import { CrossSectionalExecutor, CrossSectionalExecutorStore, type CrossSectionalExecClient, type ExecutorBasket, } from "../src/lib/cross-sectional-executor.js";
import type { CrossSectionalDynamicEntryIntegrity } from "../src/lib/cross-sectional-policy.js";
import { CrossSectionalStore, evaluateDynamicMom36Formation, type CrossSectionalObservation, } from "../src/lib/cross-sectional-edge.js";
import type { FuturesMarketReference } from "../src/lib/futures-market-reference-cache.js";
import { DYNAMIC_MOM36_HORIZON_MS, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4, DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3, DYNAMIC_MOM36_SHOCK_36H_V1, DYNAMIC_MOM36_SHOCK_SIGNAL, DYNAMIC_MOM36_SHOCK_VARIANT, type DynamicMom36StrategyVersion, } from "../src/lib/dynamic-mom36-shock-strategy.js";
const T0 = Date.parse("2026-08-25T00:00:00.000Z");
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"] as const;
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
function tempDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `${label}-`));
    dirs.push(dir);
    return dir;
}
function withDynamicEnv<T>(fn: () => Promise<T>, strategyVersion: DynamicMom36StrategyVersion = DYNAMIC_MOM36_SHOCK_36H_V1): Promise<T> {
    const overrides: Record<string, string> = {
        CROSS_SECTIONAL_STRATEGY_VERSION: strategyVersion,
        CROSS_SECTIONAL_POLICY_VERSION: strategyVersion,
        CROSS_SECTIONAL_EXEC_TP_DISABLED: "1",
        CROSS_SECTIONAL_MAKER_ENTRY_ENABLED: "0",
        CROSS_SECTIONAL_MAKER_EXIT_ENABLED: "0",
        CROSS_SECTIONAL_ENTRY_TRAFFIC_LIGHT: "0",
        CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS: "1",
        CROSS_SECTIONAL_EXEC_LEG_USD: "25",
        CROSS_SECTIONAL_EXEC_LEVERAGE: "1",
        CROSS_SECTIONAL_LEGACY_EXEC_LEG_USD: "25",
        CROSS_SECTIONAL_LEGACY_EXEC_LEVERAGE: "3",
        CROSS_SECTIONAL_LEGACY_EXEC_MAX_OPEN_BASKETS: "1",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides))
        process.env[key] = value;
    return fn().finally(() => {
        for (const [key, value] of before) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    });
}
class DynamicFakeClient {
    readonly orders: Array<{
        symbol: string;
        side: string;
        quantity: number;
        reduceOnly?: boolean;
        newClientOrderId?: string;
    }> = [];
    readonly leverageCalls: Array<{
        symbol: string;
        leverage: number;
    }> = [];
    readonly marks = new Map<string, number>();
    readonly positions = new Map<string, number>();
    /** One injected close failure proves a v3 protective intent survives partial settlement. */
    readonly failNextReduceFor = new Set<string>();
    private sequence = 0;
    constructor() {
        for (const [index, symbol] of SYMBOLS.entries())
            this.marks.set(symbol, 100 + index * 10);
    }
    async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
        const filter = { stepSize: 0.001, minQty: 0.001, tickSize: 0.001, minNotional: 5 } as unknown as FuturesSymbolFilters;
        return new Map(SYMBOLS.map((symbol) => [symbol, filter]));
    }
    async setLeverage(symbol: string, leverage: number): Promise<void> {
        this.leverageCalls.push({ symbol, leverage });
    }
    async getPositions(): Promise<FuturesPosition[]> {
        return Array.from(this.marks, ([symbol, markPrice]) => ({
            symbol,
            positionAmt: this.positions.get(symbol) ?? 0,
            entryPrice: markPrice,
            markPrice,
            liquidationPrice: 0,
            unRealizedProfit: 0,
            leverage: 1,
            marginType: "ISOLATED",
        }));
    }
    async placeOrder(params: {
        symbol: string;
        side: string;
        quantity: number;
        reduceOnly?: boolean;
        newClientOrderId?: string;
    }): Promise<FuturesOrder> {
        if (params.reduceOnly && this.failNextReduceFor.delete(params.symbol)) {
            throw new Error(`injected temporary reduce-only failure for ${params.symbol}`);
        }
        this.orders.push(params);
        const delta = params.side === "BUY" ? params.quantity : -params.quantity;
        this.positions.set(params.symbol, (this.positions.get(params.symbol) ?? 0) + delta);
        const price = this.marks.get(params.symbol) ?? 0;
        return {
            symbol: params.symbol,
            orderId: String(++this.sequence),
            clientOrderId: params.newClientOrderId ?? "",
            status: "FILLED",
            type: "MARKET",
            side: params.side === "BUY" ? "BUY" : "SELL",
            reduceOnly: Boolean(params.reduceOnly),
            price: 0,
            stopPrice: 0,
            origQty: params.quantity,
            executedQty: params.quantity,
            avgPrice: price,
            updateTime: T0,
        };
    }
    async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
        const price = this.marks.get(symbol) ?? 0;
        return {
            symbol,
            orderId,
            clientOrderId: "",
            status: "FILLED",
            type: "MARKET",
            side: "BUY",
            reduceOnly: false,
            price: 0,
            stopPrice: 0,
            origQty: 1,
            executedQty: 1,
            avgPrice: price,
            updateTime: T0,
        };
    }
    async getUserTrades(): Promise<[
    ]> {
        return [];
    }
}
function dynamicSignal(id: string, longCount: number, openedAtMs = T0 - 60000, strategyVersion: DynamicMom36StrategyVersion = DYNAMIC_MOM36_SHOCK_36H_V1): CrossSectionalObservation {
    const leg = (symbol: string, index: number) => ({
        symbol,
        entryPrice: 100 + index * 10,
        exitPrice: null,
        weight: 1 / 6,
        scoreAtOpen: longCount > 3 ? 0.05 - index / 10000 : -0.05 + index / 10000,
        volatilityAtOpen: 0.01,
    });
    const longLeg = SYMBOLS.slice(0, longCount).map(leg);
    const shortLeg = SYMBOLS.slice(longCount).map(leg);
    return {
        observationId: id,
        openedAt: new Date(openedAtMs).toISOString(),
        openedAtMs,
        horizonMs: DYNAMIC_MOM36_HORIZON_MS,
        signal: DYNAMIC_MOM36_SHOCK_SIGNAL,
        variant: DYNAMIC_MOM36_SHOCK_VARIANT,
        strategyFamily: "MOMENTUM_DISPERSION",
        k: 3,
        longK: longCount,
        shortK: 6 - longCount,
        longLeg,
        shortLeg,
        status: "OPEN",
        scoreGap: 0.1,
        regimeContext: null,
        regimeClassAtOpen: null,
        longCapitalWeight: longCount / 6,
        shortCapitalWeight: (6 - longCount) / 6,
        weightingModel: "EQUAL_NOTIONAL",
        takeProfitReturn: null,
        stopLossReturn: null,
        riskDistanceAtOpen: 0.02,
        regimeFlipExit: false,
        formationMode: "PLAIN_MOM36",
        smartFormation: null,
        dynamicMom36: {
            strategyVersion,
            formationTimestamp: new Date(openedAtMs).toISOString(),
            featureTimestamp: new Date(openedAtMs).toISOString(),
            decisionInformationCutoff: new Date(openedAtMs).toISOString(),
            activeUniverse: SYMBOLS.map((symbol, index) => ({
                symbol,
                mom36: longCount > 3 ? 0.05 - index / 1000 : -0.05 + index / 1000,
                price: 100 + index * 10,
                longEligible: true,
                shortEligible: true,
                shortBlocked: false,
            })),
            positiveCount: longCount,
            negativeCount: 6 - longCount,
            zeroCount: 0,
            baseAllocation: { longCount, shortCount: 6 - longCount, label: (["0L6S", "1L5S", "2L4S", "3L3S", "4L2S", "5L1S", "6L0S"] as const)[longCount]! },
            shockModelArtifact: "NO_FROZEN_RUNTIME_SHOCK_MAPPING",
            shockRawOutput: { artifactPresent: false, mappingPresent: false, fallback: "NO_EDGE" },
            shockState: "NO_EDGE",
            shockReason: "test",
            continuation: null,
            finalAllocation: { longCount, shortCount: 6 - longCount, label: (["0L6S", "1L5S", "2L4S", "3L3S", "4L2S", "5L1S", "6L0S"] as const)[longCount]! },
            selectedLongs: longLeg.map((item) => item.symbol),
            selectedShorts: shortLeg.map((item) => item.symbol),
            blockedShortsSkipped: [],
            admission: { scoreGap: 0.1, scoreGapFloor: 0.058, clusterCap: 2, passed: true },
        },
        grossReturn: null,
        costReturn: null,
        netReturn: null,
        longLegReturn: null,
        shortLegReturn: null,
        resolvedAt: null,
    };
}
function v6_1BearishSignal(openedAtMs = T0 - 60000): CrossSectionalObservation {
    const evaluated = evaluateDynamicMom36Formation({
        activeUniverse: SYMBOLS.map((symbol, index) => ({
            symbol,
            mom36: -0.10 + index / 1000,
            price: 100 + index * 10,
            volatility: 0.01,
            fastReturn: -0.01,
            extensionVol: 0,
            longEligible: true,
            shortEligible: true,
            shortBlocked: false,
            slowSourceTimestampMs: openedAtMs,
            slowStartTimestampMs: openedAtMs - 36 * 3600000,
            fastSourceTimestampMs: openedAtMs,
            fastStartTimestampMs: openedAtMs - 4 * 3600000,
            slowFastDataValid: true,
        })),
        now: new Date(openedAtMs).toISOString(),
        openedAtMs,
        horizonMs: DYNAMIC_MOM36_HORIZON_MS,
        featureTimestampMs: openedAtMs,
        decisionInformationCutoffMs: openedAtMs,
        maxPerCluster: 0,
        admissionScoreGapFloor: 0.058,
        admissionScoreBySymbol: Object.fromEntries(SYMBOLS.map((symbol, index) => [symbol, -0.10 + index / 1000])),
        strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
        continuationRuntime: null,
    });
    if (!evaluated.basket)
        throw new Error(`V6.1 fixture formation failed: ${evaluated.noEntryReason ?? "unknown"}`);
    return { ...evaluated.basket, observationId: "dynamic-v6.1-bearish" };
}
function runner(longCount: number, opts: {
    siblingOpenBasketCount?: () => number;
    warmFuturesMarketReference?: (symbol: string) => Promise<FuturesMarketReference | null>;
    dynamicEntryIntegrity?: () => CrossSectionalDynamicEntryIntegrity;
    strategyVersion?: DynamicMom36StrategyVersion;
    signal?: CrossSectionalObservation;
} = {}) {
    let nowMs = T0;
    const dataDir = tempDir("dynamic-mom36-executor");
    const signalStore = new CrossSectionalStore(dataDir);
    const store = new CrossSectionalExecutorStore(dataDir, "executor.json", T0 - 2 * 60000);
    const client = new DynamicFakeClient();
    signalStore.add(opts.signal ?? dynamicSignal(`dynamic-${longCount}`, longCount, T0 - 60000, opts.strategyVersion));
    const executor = new CrossSectionalExecutor({
        client: client as unknown as CrossSectionalExecClient,
        signalStore,
        store,
        enabled: () => true,
        isAllowed: () => true,
        targetVariant: DYNAMIC_MOM36_SHOCK_VARIANT,
        legUsd: () => 25,
        leverage: () => 1,
        maxOpenBaskets: () => 1,
        ...(opts.dynamicEntryIntegrity ? { dynamicEntryIntegrity: opts.dynamicEntryIntegrity } : {}),
        ...(opts.siblingOpenBasketCount ? { siblingOpenBasketCount: opts.siblingOpenBasketCount } : {}),
        ...(opts.warmFuturesMarketReference ? { warmFuturesMarketReference: opts.warmFuturesMarketReference } : {}),
        entryHealthGate: () => ({ allowed: true, reason: null }),
        entryTrafficLightEnabled: () => false,
        nowIso: () => new Date(nowMs).toISOString(),
        fillConfirmRetryDelayMs: 0,
    });
    return {
        client,
        executor,
        store,
        signalStore,
        dataDir,
        setNow(ms: number) { nowMs = ms; },
    };
}
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { selectDynamicMom36Legs, selectPreferredDynamicMom36Combination } from "../src/lib/dynamic-mom36-shock-strategy.js";
import { BinanceFuturesPrivateClient } from "../src/lib/binance-futures-private.js";
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const artifact = process.env.LATENCY_ARTIFACT ?? "/tmp/kronos-latency-results.json";
function formationInput() {
    const strategyVersion = DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4;
    const cut = T0 - 60000;
    // Distinct prices, scores and volatilities expose stale baseline occupants/metadata. Both
    // sides must swap: either AAA's or VVV's last-hour reversal disqualifies that combination.
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE", "VVV", "WWW", "XXX", "YYY", "ZZZ"];
    const marks = [401, 50, 80, 125, 251, 501, 40, 100, 200, 301];
    const mom36 = [0.10, 0.09, 0.08, 0.07, 0.06, -0.10, -0.09, -0.08, -0.07, -0.06];
    const admissionScores = [0.9, 0.3, 0.27, 0.24, 0.21, -0.9, -0.3, -0.27, -0.24, -0.21];
    const rows = symbols.map((symbol, index) => ({
        symbol,
        mom36: mom36[index]!,
        price: marks[index]! / 1.001,
        volatility: (index + 1) / 100,
        fastReturn: index < 5 ? 0.02 : -0.02,
        oneHourReturn: index === 0 ? -1 : index === 5 ? 1 : index < 5 ? 0.02 : -0.02,
        extensionVol: index / 10,
        longEligible: true, shortEligible: true, shortBlocked: false,
        slowSourceTimestampMs: cut, slowStartTimestampMs: cut - 36 * 3600000,
        fastSourceTimestampMs: cut, fastStartTimestampMs: cut - 4 * 3600000,
        slowFastDataValid: true,
    }));
    const input = {
        activeUniverse: rows, now: new Date(cut).toISOString(), openedAtMs: cut,
        horizonMs: DYNAMIC_MOM36_HORIZON_MS, featureTimestampMs: cut,
        decisionInformationCutoffMs: cut, maxPerCluster: 0, allowedLongCounts: [3],
        admissionScoreGapFloor: 0.058,
        admissionScoreBySymbol: Object.fromEntries(symbols.map((symbol, index) => [symbol, admissionScores[index]!])),
        strategyVersion, continuationRuntime: null,
    };
    return { input, symbols, marks };
}
import { BasketProtectionWatcher } from "../src/lib/basket-protection-watcher.js";
const measured: Record<string, unknown> = { venue: "SIMULATED_NO_EXCHANGE_ORDERS" };
async function protectedRun() {
    const fixture = formationInput(), full = evaluateDynamicMom36Formation(fixture.input);
    const r = runner(3, { strategyVersion: fixture.input.strategyVersion, signal: full.basket! });
    r.client.marks.clear();
    fixture.symbols.forEach((s, i) => r.client.marks.set(s, fixture.marks[i]!));
    r.client.getExchangeFilters = async () => new Map(fixture.symbols.map(s => [s, { stepSize: .001, minQty: .001, tickSize: .001, minNotional: 5 } as FuturesSymbolFilters]));
    await r.executor.tick();
    const b = r.store.getState().baskets[0]!;
    expect(b.status).toBe("COMPLETE");
    r.executor.enableProtectionWatcher();
    let now = T0;
    const setTime = (value: number) => { now = value; r.setNow(now); };
    const profit = (f: number) => b.legs.forEach(l => r.client.marks.set(l.symbol, l.entryPrice * (1 + (l.side === "LONG" ? 1 : -1) * f)));
    const snapshot = (withMarks = true) => ({ quotes: new Map(b.legs.map(l => { const p = r.client.marks.get(l.symbol)!; return [l.symbol, { symbol: l.symbol, bidPrice: p, askPrice: p, bidQty: 1e6, askQty: 1e6, observedAtMs: now }]; })), marks: new Map(withMarks ? b.legs.map(l => [l.symbol, { price: r.client.marks.get(l.symbol)!, observedAtMs: now }]) : []) });
    const arm = async () => { setTime(T0 + 2000); profit(.02); await r.executor.evaluateProtectionSnapshot(snapshot()); expect(b.crossProfitProtection?.armed).toBe(true); setTime(T0 + 4000); };
    return { ...r, b, setTime, profit, snapshot, arm };
}
const version = DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4;
it("frozen legacy C retains its original fee model; correction never retrofits old policy", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    expect(r.b.feeEstimateUsd).toBeNull();
    r.setTime(T0 + 2000);
    r.profit(.0057);
    await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
    const n0 = r.b.legs.reduce((sum, l) => sum + l.entryPrice * l.qty, 0);
    const reported = r.b.lastProtectionDiagnostic!.netPnlUsd!;
    // Current production caller charges 6bps remaining costs, but zero entry fees.
    expect(reported / n0).toBeCloseTo(.0051, 9);
    expect(r.b.crossProfitProtection!.armed).toBe(true);
    // Explicit cost scenario, not a claim about exchange fills: 4bps paid at entry.
    expect((reported - n0 * .0004) / n0).toBeCloseTo(.0047, 9);
    expect((reported - n0 * .0004) / n0).toBeLessThan(.005);
}, version));
it.each(["mainnet", "testnet"])("new %s production basket requires actual cost coverage and persists full trigger evidence", async (environment) => withDynamicEnv(async () => {
    const prior = process.env.LIVE_BINANCE_ENV;
    process.env.LIVE_BINANCE_ENV = environment;
    try {
        const r = await protectedRun();
        expect(r.b.netLiqAccountingVersion).toBe("fill-slices-actual-costs-v2");
        r.client.getUserTrades = async (symbol: string) => r.b.legs.filter(l => l.symbol === symbol).map(l => ({
            symbol, orderId: l.entryOrderId, tradeId: `entry-${symbol}`, price: l.entryPrice, qty: l.qty,
            commission: l.qty * l.entryPrice * .0004, commissionAsset: "USDT", realizedPnl: 0, time: T0 + 1000,
        }));
        (r.client as any).getIncomeHistory = async () => [];
        r.setTime(T0 + 2000); r.profit(.0057);
        await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
        expect(r.b.crossProfitProtection!.armed).toBe(false);
        expect(r.b.lastProtectionDiagnostic!.usable).toBe(false);
        await Promise.all([...(r.executor as any).costRefreshes.values()]);
        expect(r.b.protectionCosts!.complete).toBe(true);
        r.setTime(T0 + 4000);
        await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
        expect(r.b.lastProtectionDiagnostic!.usable).toBe(true);
        expect(r.b.crossProfitProtection!.armed).toBe(false); // paid entry fees keep real net below .5%
        r.setTime(T0 + 6000); r.profit(.02);
        await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
        expect(r.b.crossProfitProtection!.armed).toBe(true);
        r.setTime(T0 + 8000); r.profit(.005);
        await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
        expect(r.b.closeIntent!.reason).toBe("NET_PROFIT_FLOOR_EXIT");
        expect(r.b.exitAudit!.quotes!.every(q => q.bidQty === 1e6 && q.remainingQty === q.qty)).toBe(true);
        expect(r.b.exitAudit!.netLiquidationDiagnostic!.paidFeesUsd).toBeGreaterThan(0);
        expect(r.b.exitAudit!.costSnapshot!.complete).toBe(true);
        expect(r.b.closeRecovery!.residuals.every(l => l.remainingQty === 0)).toBe(true);
    } finally {
        if (prior === undefined) delete process.env.LIVE_BINANCE_ENV; else process.env.LIVE_BINANCE_ENV = prior;
    }
}, version));
it.each(["mainnet", "testnet"])("new %s cohort missing costs cannot arm but still reaches the native hard cut", async (environment) => withDynamicEnv(async () => {
    const prior = process.env.LIVE_BINANCE_ENV;
    process.env.LIVE_BINANCE_ENV = environment;
    try {
        const r = await protectedRun();
        r.setTime(T0 + 2000); r.profit(.02);
        await r.executor.evaluateProtectionSnapshot(r.snapshot());
        expect(r.b.lastProtectionDiagnostic!.usable).toBe(false);
        expect(r.b.crossProfitProtection!.armed).toBe(false);
        expect(r.b.closeIntent).toBeUndefined();
        r.setTime(T0 + 4000); r.profit(-.03);
        await r.executor.evaluateProtectionSnapshot(r.snapshot());
        expect(r.b.closeIntent!.reason).toBe("HARD_CUT_LOSS_2");
        expect(r.b.status).toBe("CLOSED");
        expect(r.b.exitAudit!.netLiquidationDiagnostic!.degradedReasons!.length).toBeGreaterThan(0);
    } finally {
        if (prior === undefined) delete process.env.LIVE_BINANCE_ENV; else process.env.LIVE_BINANCE_ENV = prior;
    }
}, version));
it("forms and executes a fresh floor intent while the main tick remains held for seconds", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(x => release = x), ready = new Promise<void>(x => entered = x);
    (r.executor as any).ensureOpenBasketLeverage = async () => { entered(); await held; };
    const start = performance.now();
    let mainFinished = false;
    const main = r.executor.tick().then(() => { mainFinished = true; });
    await ready;
    try {
        r.profit(.005);
        r.setTime(T0 + 6000);
        const t = performance.now();
        let intentAt: number | null = null, flatAt: number | null = null;
        const save = r.store.save.bind(r.store), order = r.client.placeOrder.bind(r.client);
        r.store.save = () => { if (r.b.closeIntent && intentAt === null) intentAt = performance.now() - t; save(); };
        r.client.placeOrder = async params => { const result = await order(params); if ([...r.client.positions.values()].every(q => Math.abs(q) < 1e-9)) flatAt = performance.now() - t; return result; };
        const watcher = new BasketProtectionWatcher({
            environment: "mainnet", symbols: () => r.executor.protectionSymbols(), nowMs: () => T0 + 6000,
            createWebSocket: () => new FakeSocket() as unknown as WebSocket,
            evaluate: snapshot => r.executor.evaluateProtectionSnapshot(snapshot),
        });
        const getPositions = r.client.getPositions.bind(r.client);
        r.client.getPositions = async () => { expect(r.b.closeIntent).toBeTruthy(); return getPositions(); };
        watcher.start();
        try {
            for (const leg of r.b.legs) {
                const price = r.client.marks.get(leg.symbol)!;
                watcher.accept({e:"bookTicker",s:leg.symbol,T:T0+6000,u:1,b:String(price),a:String(price),B:"1000000",A:"1000000"},"book");
            }
            await watcher.requestEvaluation();
        } finally { watcher.stop(); }
        expect(r.b.closeIntent?.reason).toBe("NET_PROFIT_FLOOR_EXIT");
        expect(mainFinished).toBe(false);
        expect(r.b.status).toBe("CLOSED");
        measured.heldTick = { intentPersistedMs: intentAt, positionsFlatMs: flatAt, evaluationCompleteMs: performance.now() - t, mainStillHeld: true };
        await pause(Math.max(0, 2200 - (performance.now() - start)));
    }
    finally {
        release();
        await main;
    }
}, version), 10000);
it("starts the other five legs before a 600 ms first order finishes, bounded to two with no reverse", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    r.profit(.005);
    const orig = r.client.placeOrder.bind(r.client), submitted: {
        symbol: string;
        at: number;
        id: string;
    }[] = [];
    let active = 0, maxActive = 0, firstDone = 0, positionsFlatAt: number | null = null;
    const start = performance.now();
    r.client.placeOrder = async (p) => { const i = submitted.length; submitted.push({ symbol: p.symbol, at: performance.now() - start, id: p.newClientOrderId! }); active++; maxActive = Math.max(active, maxActive); try {
        await pause(i === 0 ? 600 : 10);
        const result = await orig(p);
        if ([...r.client.positions.values()].every(q => Math.abs(q) < 1e-9)) positionsFlatAt = performance.now() - start;
        if (i === 0)
            firstDone = performance.now() - start;
        return result;
    }
    finally {
        active--;
    } };
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    expect(submitted).toHaveLength(6);
    expect(new Set(submitted.map(x => x.id)).size).toBe(6);
    expect(maxActive).toBe(2);
    expect(submitted.slice(1).every(x => x.at < firstDone)).toBe(true);
    expect([...r.client.positions.values()].every(q => Math.abs(q) < 1e-9)).toBe(true);
    expect(r.client.orders.slice(-6).every(o => o.reduceOnly)).toBe(true);
    expect(r.b.status).toBe("CLOSED");
    measured.concurrentClose = { submitted, firstDoneMs: firstDone, maxActive, positionsFlatMs: positionsFlatAt, closeAndReconciliationCompleteMs: performance.now() - start };
}, version), 10000);
it("racing floor and hard cut persist one intent and finish all residuals exactly once", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    r.profit(-.03);
    let intentWrites = 0;
    let prior: unknown;
    const save = r.store.save.bind(r.store);
    r.store.save = () => { if (r.b.closeIntent && r.b.closeIntent !== prior) {
        intentWrites++;
        prior = r.b.closeIntent;
    } save(); };
    const before = r.client.orders.length;
    await Promise.all([r.executor.evaluateProtectionSnapshot(r.snapshot()), r.executor.tick(), r.executor.evaluateProtectionSnapshot(r.snapshot())]);
    expect(intentWrites).toBe(1);
    expect(r.b.status).toBe("CLOSED");
    expect(r.client.orders.length - before).toBe(6);
    expect([...r.client.positions.values()].every(q => Math.abs(q) < 1e-9)).toBe(true);
    measured.floorHardCutRace = { intentWrites, orders: r.client.orders.length - before, reason: r.b.closeIntent!.reason };
}, version));
it("after timeout and restart queries the saved order, continuing intent even with no quotes and no new breach", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    r.profit(.005);
    const orig = r.client.placeOrder.bind(r.client), byId = new Map<string, FuturesOrder>();
    let first = true, posts = 0, queries = 0;
    r.client.placeOrder = async (p) => { posts++; const o = await orig(p); byId.set(p.newClientOrderId!, o); if (first) {
        first = false;
        throw new Error("execution status UNKNOWN: timeout after exchange fill");
    } return o; };
    (r.client as any).queryOrderByClientId = async (_s: string, id: string) => { queries++; const o = byId.get(id); if (!o)
        throw new Error("-2013 Order does not exist"); return o; };
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    expect(r.b.status).toBe("COMPLETE");
    expect(r.b.legs.filter(l => l.protectiveExitAttempt)).toHaveLength(1);
    const store = new CrossSectionalExecutorStore(r.dataDir, "executor.json", T0);
    const executor = new CrossSectionalExecutor({ client: r.client as unknown as CrossSectionalExecClient, signalStore: r.signalStore, store, enabled: () => false, isAllowed: () => false, nowIso: () => new Date(T0 + 8000).toISOString(), fillConfirmRetryDelayMs: 0 });
    executor.enableProtectionWatcher();
    await executor.evaluateProtectionSnapshot({ quotes: new Map(), marks: new Map() });
    expect(store.getState().baskets[0]!.status).toBe("CLOSED");
    expect(posts).toBe(6);
    expect(queries).toBe(1);
    measured.restartUnknown = { posts, queries, status: store.getState().baskets[0]!.status };
}, version));
it("an unresolved timeout with order-not-found never blindly sends a duplicate", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    r.profit(.005);
    const orig = r.client.placeOrder.bind(r.client);
    let posts = 0;
    r.client.placeOrder = async (p) => { posts++; if (posts === 1)
        throw new Error("request timed out; execution unknown"); return orig(p); };
    (r.client as any).queryOrderByClientId = async () => { throw new Error("-2013 Order does not exist"); };
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    r.setTime(T0 + 8000);
    await r.executor.evaluateProtectionSnapshot({ quotes: new Map(), marks: new Map() });
    expect(posts).toBe(6);
    expect(r.b.status).toBe("COMPLETE");
    expect(r.b.legs.filter(l => l.protectiveExitAttempt)).toHaveLength(1);
    const restored = new CrossSectionalExecutorStore(r.dataDir, "executor.json", T0).getState().baskets[0]!;
    expect(restored.closeRecovery!.state).toBe("OPERATOR_RECONCILIATION_REQUIRED");
    expect(restored.closeRecovery!.residuals.filter(l => l.remainingQty > 0)).toHaveLength(1);
    expect(restored.closeRecovery!.residuals.find(l => l.clientOrderId)?.error).toContain("-2013");
    expect(restored.lastCloseOwnershipCheck!.rows).toHaveLength(6);
}, version));
it("persists six owned residuals and keeps intent if the exchange position read fails", async () => withDynamicEnv(async () => {
    const r = await protectedRun(); await r.arm(); r.profit(.005);
    r.client.getPositions = async () => { throw new Error("position transport unavailable"); };
    const orders = r.client.orders.length;
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    const saved = new CrossSectionalExecutorStore(r.dataDir, "executor.json", T0).getState().baskets[0]!;
    expect(saved.closeIntent!.reason).toBe("NET_PROFIT_FLOOR_EXIT");
    expect(saved.closeRecovery!.residuals.filter(l => l.remainingQty > 0)).toHaveLength(6);
    expect(r.client.orders.length).toBe(orders);
    expect(saved.status).toBe("COMPLETE");
}, version));
it("missing or stale book legs cannot form a quote floor intent", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    r.profit(.005);
    const before = r.client.orders.length;
    const missing = r.snapshot(false);
    missing.quotes.delete(r.b.legs[0]!.symbol);
    await r.executor.evaluateProtectionSnapshot(missing);
    r.setTime(T0 + 6000);
    const stale = r.snapshot(false);
    stale.quotes.get(r.b.legs[0]!.symbol)!.observedAtMs -= 16000;
    await r.executor.evaluateProtectionSnapshot(stale);
    expect(r.b.closeIntent).toBeUndefined();
    expect(r.client.orders.length).toBe(before);
}, version));
it("an ownership quantity mismatch blocks that leg without inventing a quantity", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    r.profit(.005);
    const leg = r.b.legs[0]!;
    r.client.positions.set(leg.symbol, 999);
    const before = r.client.orders.length;
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    expect(r.b.status).toBe("COMPLETE");
    expect(r.client.orders.slice(before).some(o => o.symbol === leg.symbol)).toBe(false);
    expect(r.client.positions.get(leg.symbol)).toBe(999);
}, version));
class FakeSocket extends EventTarget {
    readyState = 1;
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
it("coalesces a thousand updates into one latest-snapshot follow-up", async () => {
    let now = T0 + 1000, release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
    const seen: number[] = [];
    const watcher = new BasketProtectionWatcher({ environment: "mainnet", symbols: () => ["BTCUSDT"], nowMs: () => now, createWebSocket: () => new FakeSocket() as unknown as WebSocket, evaluate: async (s) => { seen.push(s.quotes.get("BTCUSDT")?.bidPrice ?? 0); if (seen.length === 1) {
            entered();
            await held;
        } } });
    watcher.start();
    watcher.accept({ e: "bookTicker", s: "BTCUSDT", T: now, u: 1, b: "100", a: "101", B: "10", A: "10" }, "book");
    await ready;
    for (let i = 2; i <= 1001; i++) {
        now++;
        watcher.accept({ e: "bookTicker", s: "BTCUSDT", T: now, u: i, b: String(i), a: String(i + 1), B: "10", A: "10" }, "book");
        void watcher.requestEvaluation();
    }
    release();
    await watcher.requestEvaluation();
    watcher.stop();
    expect(seen).toEqual([100, 1001]);
    measured.coalescing = { updates: 1000, evaluations: seen.length, latestBid: seen.at(-1) };
});
it("deterioration counts two completed consecutive minutes, never quote bursts", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    r.b.crossProfitProtection!.armFraction = 10;
    for (let m = 0; m <= 30; m++) {
        r.setTime(T0 + m * 60000 + 59900);
        r.profit(.02 - m * .0005);
        await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
    }
    r.setTime(T0 + 31 * 60000 + 1100);
    r.profit(.0045);
    await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
    expect(r.b.crossProfitProtection!.breakdownConfirmations).toBe(1);
    for (let i = 1; i <= 100; i++) {
        r.setTime(T0 + 31 * 60000 + 1100 + i * 10);
        await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
    }
    expect(r.b.crossProfitProtection!.breakdownConfirmations).toBe(1);
    expect(r.b.closeIntent).toBeUndefined();
    r.setTime(T0 + 31 * 60000 + 59900);
    await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
    r.setTime(T0 + 32 * 60000 + 1100);
    await r.executor.evaluateProtectionSnapshot(r.snapshot(false));
    expect(r.b.closeIntent?.reason).toBe("RELATIVE_EDGE_BREAKDOWN");
    expect(r.b.status).toBe("CLOSED");
}, version));
afterEach(() => { if (process.env.PROTECTION_TEST_ARTIFACT)
    writeFileSync(process.env.PROTECTION_TEST_ARTIFACT, JSON.stringify(measured, null, 2)); });
it("a terminal partial fill closes only its confirmed residual with a new identity", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    r.profit(.005);
    const orig = r.client.placeOrder.bind(r.client);
    const sent: {
        symbol: string;
        qty: number;
        id: string;
    }[] = [];
    let first = true;
    r.client.placeOrder = async (p) => { sent.push({ symbol: p.symbol, qty: p.quantity, id: p.newClientOrderId! }); if (first) {
        first = false;
        const o = await orig({ ...p, quantity: p.quantity / 2 });
        return { ...o, status: "CANCELED", origQty: p.quantity };
    } return orig(p); };
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    expect(r.b.status).toBe("COMPLETE");
    expect(sent).toHaveLength(6);
    r.setTime(T0 + 8000);
    await r.executor.evaluateProtectionSnapshot({ quotes: new Map(), marks: new Map() });
    expect(r.b.status).toBe("CLOSED");
    expect(sent).toHaveLength(7);
    expect(sent[6]!.qty).toBeCloseTo(sent[0]!.qty / 2, 10);
    expect(sent[6]!.id).not.toBe(sent[0]!.id);
    expect([...r.client.positions.values()].every(q => Math.abs(q) < 1e-9)).toBe(true);
}, version));
it("rejects out-of-order/future/invalid quotes and discards cache on stream interruption", async () => {
    const sockets: FakeSocket[] = [], urls: string[] = [];
    let latest: any;
    const watcher = new BasketProtectionWatcher({ environment: "mainnet", symbols: () => ["BTCUSDT"], nowMs: () => T0 + 2000, createWebSocket: url => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s as unknown as WebSocket; }, evaluate: async (s) => { latest = s; } });
    watcher.start();
    const q = { e: "bookTicker", s: "BTCUSDT", T: T0 + 1000, u: 10, b: "100", a: "101", B: "10", A: "10" };
    expect(watcher.accept(q, "book")).toBe(true);
    expect(watcher.accept({ ...q, u: 9 }, "book")).toBe(false);
    expect(watcher.accept({ ...q, u: 11, T: T0 + 3000 }, "book")).toBe(false);
    expect(watcher.accept({ ...q, u: 11, b: "NaN" }, "book")).toBe(false);
    expect(watcher.accept({ ...q, u: 11, st: 2 }, "book")).toBe(false);
    await watcher.requestEvaluation();
    expect(latest.quotes.size).toBe(1);
    sockets[0]!.close();
    await watcher.requestEvaluation();
    expect(latest.quotes.size).toBe(0);
    watcher.stop();
    expect(urls[0]).toContain("/public/stream?streams=btcusdt@bookTicker");
    expect(urls[1]).toContain("/market/stream?streams=btcusdt@markPrice@1s");
});
it("shared-symbol ownership blocks that symbol even when net quantity happens to match", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    r.profit(.005);
    const leg = r.b.legs[0]!;
    (r.executor as any).siblingOpenLegs = () => [{ symbol: leg.symbol, side: leg.side, qty: 1 }];
    const before = r.client.orders.length;
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    expect(r.client.orders.slice(before)).toHaveLength(5);
    expect(r.client.orders.slice(before).some(o => o.symbol === leg.symbol)).toBe(false);
    expect(r.b.status).toBe("COMPLETE");
    expect(r.b.closeIntent).toBeTruthy();
}, version));
it("persists legacy mark-floor observations without waiting for the main tick", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    r.b.crossProfitProtection = null;
    r.store.save();
    r.setTime(T0 + 2000);
    r.profit(.02);
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    const restored = new CrossSectionalExecutorStore(r.dataDir, "executor.json", T0).getState().baskets[0]!;
    expect(restored.dynamicMom36NetLadderExit!.peakNetPnlUsd).toBe(r.b.dynamicMom36NetLadderExit!.peakNetPnlUsd);
    expect(restored.dynamicMom36NetLadderExit!.lastObservedAt).toBe(new Date(T0 + 2000).toISOString());
}, version));

import { basketProtectionSummary } from "../src/lib/basket-protection-audit.js";
it("reports frozen per-basket arm independently of new-entry config and never guesses missing policy", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    r.b.crossProfitProtection!.armFraction = .005;
    const before = JSON.stringify(r.b);
    const c = basketProtectionSummary(r.b);
    expect(c.effectiveArmUsd).toBeCloseTo(r.b.crossProfitProtection!.entryNotionalUsd * .005);
    expect(c.trailArmed).toBe(false);
    expect(c.floorUsd).toBeNull();
    expect(JSON.stringify(r.b)).toBe(before);
    r.b.crossProfitProtection = null;
    r.b.dynamicMom36NetLadderExit!.armNetPnlUsd = 1.5;
    const legacy = basketProtectionSummary(r.b);
    expect(legacy.effectiveArmUsd).toBe(1.5);
    expect(legacy.policyFingerprint).not.toBe(c.policyFingerprint);
    r.b.dynamicMom36NetLadderExit = null; r.b.dynamicMom36V3Exit = null;
    const unknown = basketProtectionSummary(r.b);
    expect(unknown.effectiveArmUsd).toBeNull();
    expect(unknown.trailArmed).toBeNull();
}, version));

it("persists the first trigger quote, per-leg submit/response, flat confirmation and explicitly incomplete accounting", async () => withDynamicEnv(async () => {
    const r = await protectedRun();
    await r.arm();
    const floor = basketProtectionSummary(r.b).floorUsd;
    r.profit(.005);
    const snapshot = r.snapshot();
    await r.executor.evaluateProtectionSnapshot(snapshot);
    const a = r.b.exitAudit!;
    expect(a.origin).toBe("WATCHER");
    expect(a.reason).toBe("NET_PROFIT_FLOOR_EXIT");
    expect(a.protection.floorUsd).toBe(floor);
    expect(a.quotes).toHaveLength(6);
    for (const q of a.quotes!) expect(q.bid).toBe(snapshot.quotes.get(q.symbol)!.bidPrice);
    expect(a.events.filter(e => e.kind === "GATEWAY_SUBMIT_START")).toHaveLength(6);
    expect(a.events.filter(e => e.kind === "ORDER_RESPONSE")).toHaveLength(6);
    expect(a.flatConfirmedAt).toBeTruthy();
    expect(a.settlement!.actualNetExcludingFundingUsd).toBeNull(); // stub has no exchange userTrades
    expect(a.settlement!.funding).toBe("NOT_INCLUDED");
    expect(a.settlement!.fillPagesComplete).toBe(false);
    const saved = new CrossSectionalExecutorStore(r.dataDir, "executor.json", T0).getState().baskets[0]!.exitAudit;
    expect(saved).toEqual(a);
    const snapshotOfAudit = JSON.stringify(a);
    await r.executor.evaluateProtectionSnapshot(snapshot);
    expect(JSON.stringify(r.b.exitAudit)).toBe(snapshotOfAudit);
}, version));
it("keeps actual exchange fill times and only labels fully covered userTrades net as actual", async () => withDynamicEnv(async () => {
    const r = await protectedRun(); await r.arm(); r.profit(.005);
    (r.client as any).getUserTrades = async (symbol: string) => {
      const leg = r.b.legs.find(l => l.symbol === symbol)!;
      return [
        { symbol, orderId: leg.entryOrderId, tradeId: `entry-${symbol}`, qty: leg.qty, price: leg.entryPrice, commission: .01, commissionAsset: "USDT", realizedPnl: 0, time: T0 - 60000 },
        { symbol, orderId: leg.exitOrderId, tradeId: `exit-${symbol}`, qty: leg.qty, price: leg.exitPrice, commission: .02, commissionAsset: "USDT", realizedPnl: (leg.side === "LONG" ? 1 : -1) * (leg.exitPrice! - leg.entryPrice) * leg.qty, time: T0 + 6001 },
      ];
    };
    await r.executor.evaluateProtectionSnapshot(r.snapshot());
    const s = r.b.exitAudit!.settlement!;
    expect(s.fillPagesComplete).toBe(true);
    expect(s.fills).toHaveLength(12);
    expect(s.fills.filter(t => t.role === "EXIT").map(t => t.time)).toEqual(Array(6).fill(T0 + 6001));
    expect(s.actualNetExcludingFundingUsd).toBeCloseTo(s.grossPnlUsd - .18);
    expect(s.actualDeltaToTriggerFloorUsd).toBeCloseTo(s.actualNetExcludingFundingUsd! - r.b.exitAudit!.protection.floorUsd!);
}, version));
it("observes the actual HTTP dispatch once without serializing or trusting the recording callback", async () => {
    const events: string[] = [];
    const client = new BinanceFuturesPrivateClient({ apiKey: "test", apiSecret: "test", env: "testnet", nowMs: () => T0,
      fetchImpl: (async (url, init) => { expect(String(url)).not.toContain("onDispatch"); expect(init?.method).toBe("POST"); events.push("fetch"); return new Response(JSON.stringify({ orderId: "10", symbol: "BTCUSDT", status: "FILLED", side: "SELL", executedQty: "1", avgPrice: "100", updateTime: T0 })); }) as typeof fetch });
    await client.placeOrder({ symbol: "BTCUSDT", side: "SELL", type: "MARKET", quantity: 1, reduceOnly: true, newClientOrderId: "audit-test",
      onDispatch: at => { expect(at).toBe(T0); events.push("dispatch"); throw new Error("recorder failure must not stop exit"); } });
    expect(events).toEqual(["dispatch", "fetch"]);
});

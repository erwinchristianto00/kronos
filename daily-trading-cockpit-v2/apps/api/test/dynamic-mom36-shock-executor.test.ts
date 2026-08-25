import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FuturesOrder, FuturesPosition, FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
import {
  CrossSectionalExecutor,
  CrossSectionalExecutorStore,
  type CrossSectionalExecClient,
  type ExecutorBasket,
} from "../src/lib/cross-sectional-executor.js";
import { CrossSectionalStore, type CrossSectionalObservation } from "../src/lib/cross-sectional-edge.js";
import {
  DYNAMIC_MOM36_HORIZON_MS,
  DYNAMIC_MOM36_SHOCK_36H_V1,
  DYNAMIC_MOM36_SHOCK_SIGNAL,
  DYNAMIC_MOM36_SHOCK_VARIANT,
} from "../src/lib/dynamic-mom36-shock-strategy.js";

const T0 = Date.parse("2026-08-25T00:00:00.000Z");
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"] as const;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  dirs.push(dir);
  return dir;
}

function withDynamicEnv<T>(fn: () => Promise<T>): Promise<T> {
  const overrides: Record<string, string> = {
    CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_SHOCK_36H_V1,
    CROSS_SECTIONAL_POLICY_VERSION: DYNAMIC_MOM36_SHOCK_36H_V1,
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
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  return fn().finally(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

class DynamicFakeClient {
  readonly orders: Array<{ symbol: string; side: string; quantity: number; reduceOnly?: boolean; newClientOrderId?: string }> = [];
  readonly leverageCalls: Array<{ symbol: string; leverage: number }> = [];
  readonly marks = new Map<string, number>();
  readonly positions = new Map<string, number>();
  private sequence = 0;

  constructor() {
    for (const [index, symbol] of SYMBOLS.entries()) this.marks.set(symbol, 100 + index * 10);
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

  async placeOrder(params: { symbol: string; side: string; quantity: number; reduceOnly?: boolean; newClientOrderId?: string }): Promise<FuturesOrder> {
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

  async getUserTrades(): Promise<[]> {
    return [];
  }
}

function dynamicSignal(
  id: string,
  longCount: number,
  openedAtMs = T0 - 60_000,
): CrossSectionalObservation {
  const leg = (symbol: string, index: number) => ({
    symbol,
    entryPrice: 100 + index * 10,
    exitPrice: null,
    weight: 1 / 6,
    scoreAtOpen: longCount > 3 ? 0.05 - index / 10_000 : -0.05 + index / 10_000,
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
      strategyVersion: DYNAMIC_MOM36_SHOCK_36H_V1,
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

function runner(longCount: number, opts: { siblingOpenBasketCount?: () => number } = {}) {
  let nowMs = T0;
  const dataDir = tempDir("dynamic-mom36-executor");
  const signalStore = new CrossSectionalStore(dataDir);
  const store = new CrossSectionalExecutorStore(dataDir, "executor.json", T0 - 2 * 60_000);
  const client = new DynamicFakeClient();
  signalStore.add(dynamicSignal(`dynamic-${longCount}`, longCount));
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
    ...(opts.siblingOpenBasketCount ? { siblingOpenBasketCount: opts.siblingOpenBasketCount } : {}),
    entryHealthGate: () => ({ allowed: true, reason: null }),
    entryTrafficLightEnabled: () => false,
    nowIso: () => new Date(nowMs).toISOString(),
    fillConfirmRetryDelayMs: 0,
  });
  return {
    client,
    executor,
    store,
    dataDir,
    setNow(ms: number) { nowMs = ms; },
  };
}

describe("Dynamic MOM36 executor — asymmetric live lifecycle", () => {
  it("opens a 6L0S basket at six equal $25 legs, ignores ordinary TP, then closes exactly at 36h", async () => withDynamicEnv(async () => {
    const run = runner(6);
    await run.executor.tick();
    const basket = run.store.getState().baskets[0]!;

    expect(basket).toMatchObject({ status: "COMPLETE", strategyVersion: DYNAMIC_MOM36_SHOCK_36H_V1 });
    expect(basket.legs).toHaveLength(6);
    expect(basket.legs.every((leg) => leg.side === "LONG")).toBe(true);
    expect(basket.legs.every((leg) => Math.abs((leg.targetNotionalUsd ?? 0) - 25) < 0.1)).toBe(true);
    expect(basket.policyFingerprint?.execution).toMatchObject({ legNotionalUsd: 25, leverage: 1, maxOpenBaskets: 1, takeProfitEnabled: false, stopLossEnabled: false });
    expect(basket.horizonExitAtMs).toBe(T0 + DYNAMIC_MOM36_HORIZON_MS);
    expect(run.client.leverageCalls.every((call) => call.leverage === 1)).toBe(true);
    expect(run.executor.getStatus().dynamicMom36Status).toMatchObject({
      mode: "ARMED",
      hardBasketStop: "NONE",
      ordinaryTakeProfitEnabled: false,
      ordinaryMfeGivebackEnabled: false,
      ordinaryContextInvalidationEnabled: false,
      openBasketId: basket.basketId,
      horizonExitAtMs: T0 + DYNAMIC_MOM36_HORIZON_MS,
    });

    for (const [symbol, mark] of run.client.marks) run.client.marks.set(symbol, mark * 1.25);
    await run.executor.tick();
    expect(basket.status).toBe("COMPLETE");
    expect(run.client.orders.filter((order) => order.reduceOnly).length).toBe(0);
    expect(basket.mfeNetReturn).toBeGreaterThan(0);

    run.setNow(T0 + DYNAMIC_MOM36_HORIZON_MS - 60_000);
    await run.executor.tick();
    expect(basket.status).toBe("COMPLETE");

    run.setNow(T0 + DYNAMIC_MOM36_HORIZON_MS);
    await run.executor.tick();
    expect(basket.status).toBe("CLOSED");
    expect(basket.closeReason).toBe("HORIZON");
    expect(run.client.orders.filter((order) => order.reduceOnly)).toHaveLength(6);

    await run.executor.tick();
    expect(run.client.orders.filter((order) => order.reduceOnly)).toHaveLength(6);
  }));

  it("opens and manually closes the bearish 0L6S mirror through the same reconciliation path", async () => withDynamicEnv(async () => {
    const run = runner(0);
    await run.executor.tick();
    const basket = run.store.getState().baskets[0]!;

    expect(basket.status).toBe("COMPLETE");
    expect(basket.legs).toHaveLength(6);
    expect(basket.legs.every((leg) => leg.side === "SHORT")).toBe(true);
    for (const [symbol, mark] of run.client.marks) run.client.marks.set(symbol, mark * 0.8);
    await run.executor.tick();
    expect(basket.lastGrossPnlUsd).toBeGreaterThan(0);
    expect(basket.status).toBe("COMPLETE");

    const closed = await run.executor.closeAllBasketsOrderly("OPERATOR_SCOPED_CLOSE:test");
    expect(closed).toEqual({ closed: 1, failed: 0 });
    expect(basket).toMatchObject({ status: "CLOSED", closeReason: "OPERATOR_SCOPED_CLOSE:test" });
    expect(run.client.orders.filter((order) => order.reduceOnly)).toHaveLength(6);
    expect(Array.from(run.client.positions.values()).every((qty) => Math.abs(qty) < 1e-9)).toBe(true);
  }));

  it("accounts for asymmetric 5L1S P&L by actual leg dollars and preserves its frozen horizon across restart", async () => withDynamicEnv(async () => {
    const run = runner(5);
    await run.executor.tick();
    const basket = run.store.getState().baskets[0]!;
    for (const leg of basket.legs) {
      const mark = run.client.marks.get(leg.symbol)!;
      run.client.marks.set(leg.symbol, leg.side === "LONG" ? mark * 1.1 : mark * 0.9);
    }
    await run.executor.tick();

    const grossFromLegs = basket.legs.reduce((sum, leg) => {
      const mark = run.client.marks.get(leg.symbol)!;
      return sum + (leg.side === "LONG" ? mark - leg.entryPrice : leg.entryPrice - mark) * leg.qty;
    }, 0);
    expect(basket.lastGrossPnlUsd).toBeCloseTo(grossFromLegs, 8);
    expect(basket.lastLongPnlUsd).toBeGreaterThan(basket.lastShortPnlUsd ?? 0);
    expect(basket.lastNetReturn).toBeGreaterThan(0);

    const frozenDeadline = basket.horizonExitAtMs;
    const reloaded = new CrossSectionalExecutorStore(run.dataDir, "executor.json", T0 - 2 * 60_000);
    expect(reloaded.getState().baskets[0]).toMatchObject({
      strategyVersion: DYNAMIC_MOM36_SHOCK_36H_V1,
      horizonExitAtMs: frozenDeadline,
      dynamicMom36: { finalAllocation: { label: "5L1S" } },
    });
  }));

  it("never opens a second Dynamic basket while another cross-basket executor owns the global slot", async () => withDynamicEnv(async () => {
    const run = runner(6, { siblingOpenBasketCount: () => 1 });
    await run.executor.tick();
    expect(run.store.getState().baskets).toHaveLength(0);
    expect(run.client.orders).toHaveLength(0);
  }));

  it("keeps a pre-cutover fingerprint without sizing fields on its legacy 3x contract", async () => withDynamicEnv(async () => {
    const run = runner(6);
    run.store.getState().baskets.push({
      basketId: "legacy-open",
      sourceObservationId: "legacy-source",
      signal: "MOM36_FILTERED",
      variant: "FILTERED",
      strategyVersion: "full-tp6-entry-integrity-v1",
      openedAt: new Date(T0).toISOString(),
      closesAtMs: T0 + 36 * 3_600_000,
      legs: [{
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.25,
        entryPrice: 100,
        entryOrderId: "old-entry",
        entryPriceConfirmed: true,
        exitPrice: null,
        exitOrderId: null,
        exitPriceConfirmed: null,
      }],
      status: "COMPLETE",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
      policyFingerprint: {
        schemaVersion: "CURRENT_POLICY_FORWARD_COHORT_V3",
        policyId: "legacy-test",
        capturedAt: new Date(T0).toISOString(),
        forwardCohortStartedAt: null,
        strategy: {
          strategyVersion: "full-tp6-entry-integrity-v1",
          signal: "MOM36_FILTERED",
          sourceSha: "old",
          gitHash: "old",
          configHash: "old",
          modelArtifactId: "NOT_APPLICABLE_LEGACY",
          deploymentTimestamp: null,
          policyVersion: "full-tp6-entry-integrity-v1",
          variant: "FILTERED",
          momentumBars: 36,
          legsPerSide: 3,
        },
        universe: { longPool: [], shortPool: [], shortBlocklist: [] },
        formation: {
          scoreGap: 0.058,
          clusterCap: 2,
          weighting: "CAPPED_SCORE_RANK",
          formationMode: "PLAIN_MOM36",
          smartFormationRerank: false,
          entryRevalidationEnabled: true,
          entryHealthBypassed: false,
        },
        reliability: { enabled: false, version: "SYMBOL_RELIABILITY_V1", configHash: "legacy" },
        // Intentionally no legNotionalUsd/leverage/maxOpenBaskets: this is the migration shape
        // that must fall back to the explicitly pinned legacy contract, not the new 1x default.
        execution: {
          measurementHorizonBars: 48,
          measurementInterval: "1h",
          executionCapHours: 36,
          takeProfitEnabled: true,
          takeProfitNetReturn: 0.06,
          stopLossEnabled: false,
          stopLossNetReturn: null,
          adaptiveExitsEnabled: false,
          adaptiveExitMode: "OFF",
          makerEntryEnabled: false,
          makerExitEnabled: false,
          makerExitWaitMs: null,
          executorTickMs: 60_000,
        },
      },
    } as ExecutorBasket);
    run.store.save();

    await run.executor.tick();
    expect(run.store.getState().baskets[0]).toMatchObject({ status: "COMPLETE", strategyVersion: "full-tp6-entry-integrity-v1" });
    expect(run.client.leverageCalls).toContainEqual({ symbol: "BTCUSDT", leverage: 3 });
    expect(run.client.leverageCalls).not.toContainEqual({ symbol: "BTCUSDT", leverage: 1 });
  }));
});

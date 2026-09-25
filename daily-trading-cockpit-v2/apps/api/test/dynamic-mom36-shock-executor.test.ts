import {qualityInput,qualityContext} from "./three-leg-quality-fixture.js";
import { costRevision, BASKET_ACCOUNTING_V2 } from "../src/lib/basket-cost-ledger.js";
import type { CrossSectionalExecutorOptions } from "../src/lib/cross-sectional-executor.js";
import {threeInput,threeContext,THREE_VERSION} from "./three-leg-fixture.js";
import type { ThreeLegContext } from "../src/lib/dynamic-three-leg-fallback.js";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { basketSelectionEvidence } from "../src/lib/basket-selection-report.js";
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
import type { CrossSectionalDynamicEntryIntegrity } from "../src/lib/cross-sectional-policy.js";
import {
  CrossSectionalStore,
  evaluateDynamicMom36Formation,
  type CrossSectionalObservation,
} from "../src/lib/cross-sectional-edge.js";
import type { FuturesMarketReference } from "../src/lib/futures-market-reference-cache.js";
import {
  DYNAMIC_MOM36_HORIZON_MS,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4,
  DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3,
  DYNAMIC_MOM36_SHOCK_36H_V1,
  DYNAMIC_MOM36_SHOCK_SIGNAL,
  DYNAMIC_MOM36_SHOCK_VARIANT,
  type DynamicMom36StrategyVersion,
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

function withDynamicEnv<T>(
  fn: () => Promise<T>,
  strategyVersion: DynamicMom36StrategyVersion = DYNAMIC_MOM36_SHOCK_36H_V1,
): Promise<T> {
  const overrides: Record<string, string> = {
    CROSS_SECTIONAL_STRATEGY_VERSION: strategyVersion,
    CROSS_SECTIONAL_POLICY_VERSION: strategyVersion,
    CROSS_SECTIONAL_EXEC_TP_DISABLED: "1",
    CROSS_SECTIONAL_MAKER_ENTRY_ENABLED: "0",
    CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK: "0",
    CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V2: "0",
    CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V3: "0",
    CROSS_SECTIONAL_MAKER_WAIT_MS: "1000",
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
  /** One injected close failure proves a v3 protective intent survives partial settlement. */
  readonly failNextReduceFor = new Set<string>();
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

  async getUserTrades(): Promise<[]> {
    return [];
  }
}

function dynamicSignal(
  id: string,
  longCount: number,
  openedAtMs = T0 - 60_000,
  strategyVersion: DynamicMom36StrategyVersion = DYNAMIC_MOM36_SHOCK_36H_V1,
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

function v6_1BearishSignal(openedAtMs = T0 - 60_000): CrossSectionalObservation {
  const evaluated = evaluateDynamicMom36Formation({
    activeUniverse: SYMBOLS.map((symbol, index) => ({
      symbol,
      mom36: -0.10 + index / 1_000,
      price: 100 + index * 10,
      volatility: 0.01,
      fastReturn: -0.01,
      extensionVol: 0,
      longEligible: true,
      shortEligible: true,
      shortBlocked: false,
      slowSourceTimestampMs: openedAtMs,
      slowStartTimestampMs: openedAtMs - 36 * 3_600_000,
      fastSourceTimestampMs: openedAtMs,
      fastStartTimestampMs: openedAtMs - 4 * 3_600_000,
      slowFastDataValid: true,
    })),
    now: new Date(openedAtMs).toISOString(),
    openedAtMs,
    horizonMs: DYNAMIC_MOM36_HORIZON_MS,
    featureTimestampMs: openedAtMs,
    decisionInformationCutoffMs: openedAtMs,
    maxPerCluster: 0,
    admissionScoreGapFloor: 0.058,
    admissionScoreBySymbol: Object.fromEntries(SYMBOLS.map((symbol, index) => [symbol, -0.10 + index / 1_000])),
    strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
    continuationRuntime: null,
  });
  if (!evaluated.basket) throw new Error(`V6.1 fixture formation failed: ${evaluated.noEntryReason ?? "unknown"}`);
  return { ...evaluated.basket, observationId: "dynamic-v6.1-bearish" };
}

function runner(longCount: number, opts: {
  threeLegContext?: () => ThreeLegContext;
  readPublicQuote?: CrossSectionalExecutorOptions["readPublicQuote"];
  warmPublicQuote?: CrossSectionalExecutorOptions["warmPublicQuote"];
  siblingOpenBasketCount?: () => number;
  warmFuturesMarketReference?: (symbol: string) => Promise<FuturesMarketReference | null>;
  dynamicEntryIntegrity?: () => CrossSectionalDynamicEntryIntegrity;
  strategyVersion?: DynamicMom36StrategyVersion;
  signal?: CrossSectionalObservation;
} = {}) {
  let nowMs = T0;
  const dataDir = tempDir("dynamic-mom36-executor");
  const signalStore = new CrossSectionalStore(dataDir);
  const store = new CrossSectionalExecutorStore(dataDir, "executor.json", T0 - 2 * 60_000);
  const client = new DynamicFakeClient();
  signalStore.add(opts.signal ?? dynamicSignal(`dynamic-${longCount}`, longCount, T0 - 60_000, opts.strategyVersion));
  const executor = new CrossSectionalExecutor({
    client: client as unknown as CrossSectionalExecClient,
    threeLegContext: opts.threeLegContext,
    readPublicQuote: opts.readPublicQuote,
    warmPublicQuote: opts.warmPublicQuote,
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

describe("Dynamic MOM36 executor — asymmetric live lifecycle", () => {
  it.each(["missing", "mixed", "scoreGap"])("preserves the EXACT baseline through the durable order plan on %s fallback", async (mode) => withDynamicEnv(async () => {
    const strategyVersion = DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5;
    const cut = T0 - 60_000;
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE", "VVV", "WWW", "XXX", "YYY", "ZZZ"];
    const scores = [.10, .09, .08, .07, .06, -.10, -.09, -.08, -.07, -.06];
    const rows = symbols.map((symbol, i) => ({
      symbol, mom36: scores[i]!, price: 100 / 1.001, volatility: .01, extensionVol: 0,
      fastReturn: i < 5 ? .02 : -.02,
      oneHourReturn: mode === "missing" ? null : mode === "mixed" ? (i < 5 ? -.02 : .02) : i === 0 ? -.20 : i < 5 ? .02 : -.02,
      longEligible: true, shortEligible: true, shortBlocked: false, slowFastDataValid: true,
      slowSourceTimestampMs: cut, slowStartTimestampMs: cut - 36 * 3600_000,
      fastSourceTimestampMs: cut, fastStartTimestampMs: cut - 4 * 3600_000,
      oneHourStartTimestampMs: cut - 3600_000,
    }));
    const request = { activeUniverse: rows, now: new Date(cut).toISOString(), openedAtMs: cut,
      horizonMs: DYNAMIC_MOM36_HORIZON_MS, featureTimestampMs: cut, decisionInformationCutoffMs: cut,
      maxPerCluster: 0, allowedLongCounts: [3], admissionScoreGapFloor: mode === "scoreGap" ? .175 : .058,
      strategyVersion, continuationRuntime: null };
    const baseline = evaluateDynamicMom36Formation({ ...request, activeUniverse: rows.map(r => ({ ...r, oneHourReturn: null })) });
    const selected = evaluateDynamicMom36Formation(request);
    expect(selected.noEntryReason).toBeNull();
    expect(selected.basket!.longLeg).toEqual(baseline.basket!.longLeg);
    expect(selected.basket!.shortLeg).toEqual(baseline.basket!.shortLeg);
    const run = runner(3, { strategyVersion, signal: selected.basket! });
    for (const symbol of symbols) run.client.marks.set(symbol, 100);
    run.client.getExchangeFilters = async () => new Map(symbols.map(symbol => [symbol, {
      stepSize: .001, minQty: .001, tickSize: .001, minNotional: 5,
    } as FuturesSymbolFilters]));
    await run.executor.tick();
    const baskets = new CrossSectionalExecutorStore(run.dataDir, "executor.json", T0 - 2 * 60_000).getState().baskets;
    expect(baskets).toHaveLength(1);
    const basket = baskets[0]!;
    expect(basket.plan?.map(l => ({ symbol: l.symbol, weight: l.signalWeight, qty: l.requestedQty })))
      .toEqual(["AAA", "BBB", "CCC", "VVV", "WWW", "XXX"].map(symbol => ({ symbol, weight: 1 / 6, qty: .25 })));
    expect(basketSelectionEvidence(basket)?.selectionMode).toBe("BASELINE");
    expect(basket.crossProfitProtection?.armFraction).toBe(.005);
  }, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5));

  it.each([
    { strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1, longCount: 3 },
    ...[2, 3, 4].map(longCount => ({ strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4, longCount })),
    ...[1, 2, 3, 4, 5].map(longCount => ({ strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5, longCount })),
  ])("carries a preference swap through all six persisted execution legs and sizing metadata ($longCount longs, $strategyVersion)", async ({ strategyVersion, longCount }) => withDynamicEnv(async () => {
    const cut = T0 - 60_000;
    // Distinct prices, scores and volatilities expose stale baseline occupants/metadata. Both
    // sides must swap: either AAA's or VVV's last-hour reversal disqualifies that combination.
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "VVV", "WWW", "XXX", "YYY", "ZZZ", "UUU"];
    const marks = [401, 50, 80, 125, 251, 151, 501, 40, 100, 200, 301, 351];
    const mom36 = [0.10, 0.09, 0.08, 0.07, 0.06, 0.05, -0.10, -0.09, -0.08, -0.07, -0.06, -0.05];
    const admissionScores = [0.9, 0.3, 0.27, 0.24, 0.21, 0.18, -0.9, -0.3, -0.27, -0.24, -0.21, -0.18];
    const rows = symbols.map((symbol, index) => ({
      symbol,
      mom36: mom36[index]!,
      price: marks[index]! / 1.001,
      volatility: (index + 1) / 100,
      fastReturn: index < 6 ? 0.02 : -0.02,
      oneHourReturn: index === 0 ? -1 : index === 6 ? 1 : index < 6 ? 0.02 : -0.02,
      extensionVol: index / 10,
      longEligible: true, shortEligible: true, shortBlocked: false,
      slowSourceTimestampMs: cut, slowStartTimestampMs: cut - 36 * 3_600_000,
      fastSourceTimestampMs: cut, fastStartTimestampMs: cut - 4 * 3_600_000,
      slowFastDataValid: true,
    }));
    const input = {
      activeUniverse: rows, now: new Date(cut).toISOString(), openedAtMs: cut,
      horizonMs: DYNAMIC_MOM36_HORIZON_MS, featureTimestampMs: cut,
      decisionInformationCutoffMs: cut, maxPerCluster: 0, allowedLongCounts: [longCount],
      allocationSelectionMode: "RANK_ALL_QUALIFIED" as const,
      admissionScoreGapFloor: 0.058,
      admissionScoreBySymbol: Object.fromEntries(symbols.map((symbol, index) => [symbol, admissionScores[index]!])),
      strategyVersion, continuationRuntime: null,
    };
    const baseline = evaluateDynamicMom36Formation({
      ...input, activeUniverse: rows.map((row) => ({ ...row, oneHourReturn: null })),
    });
    const preferred = evaluateDynamicMom36Formation(input);
    expect(baseline.noEntryReason).toBeNull();
    expect(preferred.noEntryReason).toBeNull();
    const shortCount = 6 - longCount;
    const expectedLongs = symbols.slice(1, 1 + longCount), expectedShorts = symbols.slice(7, 7 + shortCount);
    expect(baseline.snapshot?.selectedLongs).toEqual(symbols.slice(0, longCount));
    expect(baseline.snapshot?.selectedShorts).toEqual(symbols.slice(6, 6 + shortCount));
    expect(preferred.snapshot?.recentStrengthPreference).toMatchObject({
      selectionMode: "PREFERRED", reason: "PREFERRED_RECENT_STRENGTH_ALIGNED",
      baselineLongs: symbols.slice(0, longCount), baselineShorts: symbols.slice(6, 6 + shortCount),
      actualLongs: expectedLongs, actualShorts: expectedShorts,
    });
    expect(preferred.snapshot?.recentStrengthPreference?.s1h).toBeGreaterThan(0);
    expect(preferred.snapshot?.recentStrengthPreference?.s4h).toBeGreaterThan(0);

    const signal = preferred.basket!;
    expect(signal.scoreGap).toBeCloseTo(0.54, 12);
    expect(baseline.basket?.scoreGap).toBeCloseTo(
      admissionScores.slice(0, longCount).reduce((a,b) => a+b,0)/longCount
      - admissionScores.slice(6,6+shortCount).reduce((a,b) => a+b,0)/shortCount, 12);
    expect(signal).toMatchObject({
      longK: longCount, shortK: shortCount, longCapitalWeight: longCount / 6, shortCapitalWeight: shortCount / 6,
      weightingModel: "EQUAL_NOTIONAL",
    });
    const expected = [...expectedLongs, ...expectedShorts].map(symbol => {
      const i = symbols.indexOf(symbol), refPrice = marks[i]!;
      return { symbol, side: i < 6 ? "LONG" : "SHORT", refPrice,
        requestedQty: Number((Math.ceil(25 / refPrice / .001 - 1e-10) * .001).toFixed(3)),
        scoreAtOpen: mom36[i]!, volatilityAtOpen: (i+1)/100 };
    });
    // Inspect the real signal as well as the executor; do not rebuild or patch its selected legs.
    expect([...signal.longLeg, ...signal.shortLeg].map((leg) => ({
      symbol: leg.symbol, entryPrice: leg.entryPrice, weight: leg.weight,
      scoreAtOpen: leg.scoreAtOpen, volatilityAtOpen: leg.volatilityAtOpen,
    }))).toEqual(expected.map((leg) => ({
      symbol: leg.symbol, entryPrice: leg.refPrice / 1.001, weight: 1 / 6,
      scoreAtOpen: leg.scoreAtOpen, volatilityAtOpen: leg.volatilityAtOpen,
    })));

    const run = runner(3, { strategyVersion, signal });
    run.client.marks.clear();
    for (const [index, symbol] of symbols.entries()) run.client.marks.set(symbol, marks[index]!);
    run.client.getExchangeFilters = async () => new Map(symbols.map((symbol) => [symbol, {
      stepSize: 0.001, minQty: 0.001, tickSize: 0.001, minNotional: 5,
    } as FuturesSymbolFilters]));
    await run.executor.tick();

    // Reload from disk: these assertions reach the durable order plan, beyond formation.selection.
    const persisted = new CrossSectionalExecutorStore(run.dataDir, "executor.json", T0 - 2 * 60_000).getState();
    expect(persisted.baskets).toHaveLength(1);
    const basket = persisted.baskets[0]!;
    expect(basket.status).toBe("COMPLETE");
    expect(basket.plan?.map((leg) => ({
      symbol: leg.symbol, side: leg.side, requestedQty: leg.requestedQty, refPrice: leg.refPrice,
      signalWeight: leg.signalWeight, targetNotionalUsd: leg.targetNotionalUsd,
      scoreAtOpen: leg.scoreAtOpen, volatilityAtOpen: leg.volatilityAtOpen,
    }))).toEqual(expected.map((leg) => ({ ...leg, signalWeight: 1 / 6, targetNotionalUsd: 25 })));
    expect(run.client.orders.map((order) => ({
      symbol: order.symbol, side: order.side, quantity: order.quantity,
    }))).toEqual(expected.map((leg) => ({
      symbol: leg.symbol, side: leg.side === "LONG" ? "BUY" : "SELL", quantity: leg.requestedQty,
    })));
    expect(basket.legs.map((leg) => ({ symbol: leg.symbol, side: leg.side, qty: leg.qty })))
      .toEqual(expected.map((leg) => ({ symbol: leg.symbol, side: leg.side, qty: leg.requestedQty })));
    expect(persisted.entryAttempts?.find((attempt) => attempt.stage === "BASKET_RESERVED")?.referencePrices)
      .toEqual(Object.fromEntries(expected.map((leg) => [leg.symbol, leg.refPrice])));
    expect(basket.dynamicMom36).toEqual(preferred.snapshot);
    expect(basketSelectionEvidence(basket)).toMatchObject({
      selectionMode: "PREFERRED", reason: "PREFERRED_RECENT_STRENGTH_ALIGNED",
    });
    expect(basket.dynamicMom36?.admission.scoreGap).toBeCloseTo(0.54, 12);
    expect(basket.entryAdmission?.sizeMultiplier).toBe(1);
    const candidateHash = createHash("sha256").update(JSON.stringify({
      long: expectedLongs, short: expectedShorts,
    })).digest("hex");
    expect(basket.dynamicMom36?.selectedCandidateHash).toBe(candidateHash);
    expect(basket.dynamicMom36?.admission.selectedCandidateHash).toBe(candidateHash);
    expect(basket.formationId).toBe(preferred.snapshot?.formationId);
    expect(basket.formationId).not.toBe(baseline.snapshot?.formationId);
    expect(basket.crossProfitProtection).toMatchObject({
      version: "CROSS_PROFIT_PROTECTION_V1", armFraction: 0.005, keepFraction: 0.70,
    });

    // Model an incumbent basket from before this rollout: a persisted row without the new
    // dispatch marker must retain its old exit policy on subsequent ticks.
    const incumbent = run.store.getState().baskets[0]!;
    delete incumbent.crossProfitProtection;
    const frozenPolicy = JSON.parse(JSON.stringify(incumbent.policyFingerprint));
    run.store.save();
    run.setNow(T0 + 60_000);
    await run.executor.tick();
    const afterTick = new CrossSectionalExecutorStore(run.dataDir, "executor.json", T0 - 2 * 60_000).getState().baskets[0]!;
    expect(afterTick.crossProfitProtection).toBeUndefined();
    expect(afterTick.policyFingerprint).toEqual(frozenPolicy);
    expect(afterTick.status).toBe("COMPLETE");
    expect(run.client.orders).toHaveLength(6);
  }, strategyVersion));

  it("executes a V6.1 signal only when the frozen formation, admission, and execution plans are identical", async () => withDynamicEnv(async () => {
    const signal = v6_1BearishSignal();
    const run = runner(0, {
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
      signal,
    });

    await run.executor.tick();

    expect(run.client.orders).toHaveLength(6);
    expect(run.store.getState().baskets[0]).toMatchObject({
      status: "COMPLETE",
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
      formationId: signal.dynamicMom36?.formationId,
      dynamicMom36: {
        formationId: signal.dynamicMom36?.formationId,
        admission: { formationId: signal.dynamicMom36?.formationId, passed: true },
      },
    });
  }, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1));

  it("fails closed before any order when a V6.1 execution signal no longer matches its admitted plan", async () => withDynamicEnv(async () => {
    const signal = v6_1BearishSignal();
    signal.dynamicMom36 = {
      ...signal.dynamicMom36!,
      admission: { ...signal.dynamicMom36!.admission, selectedCandidateHash: "mutated" },
    };
    const run = runner(0, {
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
      signal,
    });

    await run.executor.tick();

    expect(run.client.orders).toHaveLength(0);
    expect(run.store.getState().baskets).toHaveLength(0);
    expect(run.store.getState().entryAttempts?.at(-1)).toMatchObject({
      stage: "ENTRY_ADMISSION",
      outcome: "SKIPPED",
      reason: expect.stringContaining("FORMATION_ADMISSION_PLAN_MISMATCH"),
    });
  }, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1));

  it("does not retroactively apply V6.2 one-sided quality to an already-open V6.1 basket", async () => withDynamicEnv(async () => {
    const signal = v6_1BearishSignal();
    const run = runner(0, {
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
      signal,
    });
    await run.executor.tick();
    const basket = run.store.getState().baskets[0]!;
    const frozenVersion = basket.strategyVersion;
    const frozenPolicyVersion = basket.policyFingerprint?.strategy.strategyVersion;

    // A later process policy change applies only to fresh formation. This existing basket keeps
    // its own frozen V6.1 identity and exit state; no V6.2 quality re-evaluation is permitted.
    process.env.CROSS_SECTIONAL_STRATEGY_VERSION = DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2;
    process.env.CROSS_SECTIONAL_POLICY_VERSION = DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2;
    await run.executor.tick();

    expect(basket).toMatchObject({
      status: "COMPLETE",
      strategyVersion: frozenVersion,
      dynamicMom36: { strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1 },
      policyFingerprint: { strategy: { strategyVersion: frozenPolicyVersion } },
    });
    expect(run.client.orders.filter((order) => order.reduceOnly)).toHaveLength(0);
  }, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1));

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

  it("defers a fresh Dynamic signal while a USD-M mark is unavailable, then opens it once the mark returns", async () => withDynamicEnv(async () => {
    const run = runner(3);
    const signal = run.signalStore.all[0]!;
    const watermarkBefore = run.store.getState().lastSeenSignalMs;
    run.client.marks.delete("AVAXUSDT");

    await run.executor.tick();

    expect(run.store.getState().baskets).toHaveLength(0);
    expect(run.client.orders).toHaveLength(0);
    expect(run.store.getState().lastSeenSignalMs).toBe(watermarkBefore);
    expect(run.store.getState().entryAttempts?.at(-1)).toMatchObject({
      sourceObservationId: signal.observationId,
      stage: "SMART_ENTRY_REVALIDATION",
      outcome: "DEFERRED",
      reason: "dynamic entry reconciliation missing a fresh USD-M mark for AVAXUSDT",
      watermarkAdvanced: false,
    });

    run.client.marks.set("AVAXUSDT", 140);
    await run.executor.tick();

    expect(run.store.getState().baskets).toHaveLength(1);
    expect(run.store.getState().baskets[0]).toMatchObject({ status: "COMPLETE", sourceObservationId: signal.observationId });
    expect(run.client.orders).toHaveLength(6);
  }));

  it("rejects a queued Dynamic observation when its frozen feature cutoff, not its write time, is stale", async () => withDynamicEnv(async () => {
    const signal = dynamicSignal("dynamic-stale-feature-cutoff", 3, T0 - 60_000);
    signal.dynamicMom36 = {
      ...signal.dynamicMom36!,
      // Observation is only one minute old, but it was formed from an old hourly feature.
      featureTimestamp: new Date(T0 - 6 * 60_000).toISOString(),
      decisionInformationCutoff: new Date(T0 - 6 * 60_000).toISOString(),
    };
    const run = runner(3, {
      signal,
      dynamicEntryIntegrity: () => ({
        featureMaxAgeMs: 5 * 60_000,
        entryRevalidationEnabled: false,
        maxAdverseEntryDriftVol: 1.25,
        minAdverseEntryDriftPct: 0.005,
      }),
    });

    await run.executor.tick();

    expect(run.client.orders).toHaveLength(0);
    expect(run.store.getState().baskets).toHaveLength(0);
    expect(run.store.getState().lastSeenSignalMs).toBe(signal.openedAtMs);
    expect(run.store.getState().entryAttempts?.at(-1)).toMatchObject({
      stage: "DYNAMIC_FEATURE_FRESHNESS",
      outcome: "SKIPPED",
      watermarkAdvanced: true,
      reason: expect.stringContaining("exceeds 300000ms"),
    });
    expect(run.executor.getStatus().signalObservability.executableSignal).toMatchObject({
      ageMs: 60_000,
      fresh: false,
      featureAgeMs: 6 * 60_000,
      featureMaxAgeMs: 5 * 60_000,
      featureFresh: false,
    });
  }));

  it("keeps the exact five-minute Dynamic feature boundary executable", async () => withDynamicEnv(async () => {
    const signal = dynamicSignal("dynamic-feature-boundary", 3, T0 - 60_000);
    signal.dynamicMom36 = {
      ...signal.dynamicMom36!,
      featureTimestamp: new Date(T0 - 5 * 60_000).toISOString(),
      decisionInformationCutoff: new Date(T0 - 5 * 60_000).toISOString(),
    };
    const run = runner(3, {
      signal,
      dynamicEntryIntegrity: () => ({
        featureMaxAgeMs: 5 * 60_000,
        entryRevalidationEnabled: false,
        maxAdverseEntryDriftVol: 1.25,
        minAdverseEntryDriftPct: 0.005,
      }),
    });

    await run.executor.tick();

    expect(run.store.getState().baskets).toHaveLength(1);
    expect(run.client.orders).toHaveLength(6);
  }));

  it("rejects only a material Dynamic adverse chase and leaves sub-threshold drift executable", async () => withDynamicEnv(async () => {
    const integrity = () => ({
      featureMaxAgeMs: 5 * 60_000,
      entryRevalidationEnabled: true,
      maxAdverseEntryDriftVol: 1.25,
      minAdverseEntryDriftPct: 0.005,
    });
    const blocked = runner(3, { dynamicEntryIntegrity: integrity });
    blocked.client.marks.set("BTCUSDT", 101.5); // +1.5%, 1.5σ adverse for the first long.

    await blocked.executor.tick();

    expect(blocked.client.orders).toHaveLength(0);
    expect(blocked.store.getState().entryAttempts?.at(-1)).toMatchObject({
      stage: "SMART_ENTRY_REVALIDATION",
      outcome: "SKIPPED",
      reason: expect.stringContaining("1.50σ"),
      referencePrices: { BTCUSDT: 101.5 },
    });

    const allowed = runner(3, { dynamicEntryIntegrity: integrity });
    allowed.client.marks.set("BTCUSDT", 100.5); // 0.5σ: price threshold alone cannot block.

    await allowed.executor.tick();

    expect(allowed.store.getState().baskets).toHaveLength(1);
    expect(allowed.client.orders).toHaveLength(6);
  }));

  it("recovers a missing flat Dynamic leg mark only from an exact-symbol USD-M reference", async () => withDynamicEnv(async () => {
    const run = runner(3, {
      warmFuturesMarketReference: async (symbol) => symbol === "AVAXUSDT"
        ? { symbol, price: 140, atMs: T0, source: "USD_M_MARK_PRICE" }
        : null,
    });
    run.client.marks.delete("AVAXUSDT");

    await run.executor.tick();

    const basket = run.store.getState().baskets[0]!;
    expect(basket).toMatchObject({ status: "COMPLETE" });
    expect(run.client.orders).toHaveLength(6);
    expect(basket.legs.find((leg) => leg.symbol === "AVAXUSDT")?.entryPrice).toBe(140);
    expect(run.store.getState().entryAttempts?.at(-1)).toMatchObject({
      stage: "BASKET_RESERVED",
      outcome: "ADMITTED",
      referencePrices: expect.objectContaining({ AVAXUSDT: 140 }),
    });
  }));

  it("recovers only a still-fresh Dynamic signal consumed by the pre-fix transient-mark skip", async () => withDynamicEnv(async () => {
    const run = runner(3);
    const signal = run.signalStore.all[0]!;
    const state = run.store.getState();
    state.lastSeenSignalMs = signal.openedAtMs;
    state.entryAttempts?.push({
      at: new Date(T0).toISOString(),
      sourceObservationId: signal.observationId,
      sourceOpenedAtMs: signal.openedAtMs,
      variant: DYNAMIC_MOM36_SHOCK_VARIANT,
      signal: DYNAMIC_MOM36_SHOCK_SIGNAL,
      longSymbols: signal.longLeg.map((leg) => leg.symbol),
      shortSymbols: signal.shortLeg.map((leg) => leg.symbol),
      stage: "SMART_ENTRY_REVALIDATION",
      outcome: "SKIPPED",
      reason: "dynamic entry reconciliation missing a fresh USD-M mark for AVAXUSDT",
      referencePrices: {},
      watermarkAdvanced: true,
    });
    run.store.save();

    await run.executor.tick();

    expect(run.store.getState().baskets).toHaveLength(1);
    expect(run.store.getState().baskets[0]).toMatchObject({ status: "COMPLETE", sourceObservationId: signal.observationId });
    expect(run.client.orders).toHaveLength(6);
    expect(run.store.getState().entryAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcome: "DEFERRED",
        watermarkAdvanced: false,
      }),
      expect.objectContaining({
        stage: "PRE_SUBMIT_LATCH",
        outcome: "IN_PROGRESS",
        watermarkAdvanced: true,
      }),
    ]));
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

  it("applies the net-ladder -2% basket hard cut identically to 6L0S and 0L6S actual-notional baskets", async () => withDynamicEnv(async () => {
    for (const longCount of [6, 0]) {
      const run = runner(longCount, { strategyVersion: DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3 });
      await run.executor.tick();
      const basket = run.store.getState().baskets[0]!;
      expect(basket).toMatchObject({
        status: "COMPLETE",
        strategyVersion: DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3,
        dynamicMom36NetLadderExit: { hardCutLossThreshold: -0.02, armNetPnlUsd: 1.5, givebackFraction: 0.30 },
      });
      for (const leg of basket.legs) {
        const mark = run.client.marks.get(leg.symbol)!;
        run.client.marks.set(leg.symbol, leg.side === "LONG" ? mark * 0.975 : mark * 1.025);
      }
      await run.executor.tick();
      expect(basket.status, `${longCount}L${6 - longCount}S`).toBe("CLOSED");
      expect(basket.closeReason).toBe("HARD_CUT_LOSS_2");
      expect(basket.dynamicMom36NetLadderExit?.exitTrigger).toMatchObject({ reason: "HARD_CUT_LOSS_2" });
      expect(basket.dynamicMom36NetLadderExit?.exitTrigger?.observedNetReturn ?? 0).toBeLessThan(-0.02);
      expect(run.client.orders.filter((order) => order.reduceOnly)).toHaveLength(6);
    }
  }, DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3));

  it("uses the frozen net-ladder / 36h dispatcher for new V4, V5, and V6 baskets", async () => {
    for (const strategyVersion of [
      DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4,
      DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
      DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6,
    ] as const) {
      await withDynamicEnv(async () => {
        const run = runner(5, { strategyVersion });
        await run.executor.tick();
        const basket = run.store.getState().baskets[0]!;
        expect(basket).toMatchObject({
          status: "COMPLETE",
          strategyVersion,
          dynamicMom36NetLadderExit: { hardCutLossThreshold: -0.02, armNetPnlUsd: 1.5, givebackFraction: 0.30 },
        });
        for (const leg of basket.legs) {
          const mark = run.client.marks.get(leg.symbol)!;
          run.client.marks.set(leg.symbol, leg.side === "LONG" ? mark * 0.975 : mark * 1.025);
        }
        await run.executor.tick();
        expect(basket).toMatchObject({ status: "CLOSED", closeReason: "HARD_CUT_LOSS_2" });
      }, strategyVersion);
    }
  });

  it("surfaces a newer durable v4 no-entry formation instead of hiding it behind an older executable signal", async () => withDynamicEnv(async () => {
    const run = runner(5, { strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4 });
    const older = run.signalStore.all[0]!;
    const noEntry = {
      ...older.dynamicMom36!,
      formationTimestamp: new Date(T0 + 60_000).toISOString(),
      noEntryReason: "INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS",
      rawV3SelectedLongs: older.longLeg.map((leg) => leg.symbol),
      selectedLongs: older.longLeg.slice(0, 4).map((leg) => leg.symbol),
      selectionInsufficientReason: "INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS",
    };
    run.signalStore.recordDynamicMom36Formation(noEntry);

    const status = run.executor.getStatus();
    expect(status.dynamicMom36Status?.latestFormation).toMatchObject({
      formationTimestamp: new Date(T0 + 60_000).toISOString(),
      noEntryReason: "INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS",
      selectionInsufficientReason: "INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS",
    });
  }, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4));

  it("uses actual six-leg net P&L for the ladder trail and labels the 36h cap distinctly", async () => withDynamicEnv(async () => {
    const run = runner(5, { strategyVersion: DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3 });
    await run.executor.tick();
    const basket = run.store.getState().baskets[0]!;
    for (const leg of basket.legs) {
      const mark = run.client.marks.get(leg.symbol)!;
      run.client.marks.set(leg.symbol, leg.side === "LONG" ? mark * 1.05 : mark * 0.95);
    }
    await run.executor.tick();
    expect(basket.status).toBe("COMPLETE");
    expect(basket.dynamicMom36NetLadderExit).toMatchObject({ trailArmed: true });
    const peak = basket.dynamicMom36NetLadderExit?.peakNetPnlUsd ?? 0;
    expect(peak).toBeGreaterThan(7);
    expect(basket.dynamicMom36NetLadderExit?.trailingFloorNetUsd ?? 0).toBeCloseTo(peak * 0.70, 12);

    for (const leg of basket.legs) {
      const mark = 100 + SYMBOLS.indexOf(leg.symbol as (typeof SYMBOLS)[number]) * 10;
      run.client.marks.set(leg.symbol, leg.side === "LONG" ? mark * 1.034 : mark * 0.966);
    }
    await run.executor.tick();
    expect(basket).toMatchObject({ status: "CLOSED", closeReason: "NET_LADDER_GIVEBACK_30" });
    expect(basket.dynamicMom36NetLadderExit?.exitTrigger).toMatchObject({ reason: "NET_LADDER_GIVEBACK_30" });

    const horizonRun = runner(0, { strategyVersion: DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3 });
    await horizonRun.executor.tick();
    const horizonBasket = horizonRun.store.getState().baskets[0]!;
    horizonRun.setNow(T0 + DYNAMIC_MOM36_HORIZON_MS);
    await horizonRun.executor.tick();
    expect(horizonBasket).toMatchObject({ status: "CLOSED", closeReason: "HORIZON_36H" });
    expect(horizonBasket.dynamicMom36NetLadderExit?.exitTrigger).toMatchObject({ reason: "HORIZON_36H" });
  }, DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3));

  it("retries a persisted net-ladder hard-cut intent after a partial close even when the remaining leg mark recovers", async () => withDynamicEnv(async () => {
    const run = runner(6, { strategyVersion: DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3 });
    await run.executor.tick();
    const basket = run.store.getState().baskets[0]!;
    const residual = basket.legs[0]!.symbol;
    run.client.failNextReduceFor.add(residual);
    for (const leg of basket.legs) {
      const mark = run.client.marks.get(leg.symbol)!;
      run.client.marks.set(leg.symbol, mark * 0.97);
    }

    await run.executor.tick();
    expect(basket.status).toBe("COMPLETE");
    expect(basket.dynamicMom36NetLadderExit?.exitTrigger).toMatchObject({ reason: "HARD_CUT_LOSS_2" });
    expect(run.client.orders.filter((order) => order.reduceOnly)).toHaveLength(5);

    // Only the residual leg remains.  Its mark now looks harmless, so retry must come from the
    // persisted protective intent rather than a new threshold crossing.
    run.client.marks.set(residual, basket.legs[0]!.entryPrice);
    await run.executor.tick();

    expect(basket).toMatchObject({ status: "CLOSED", closeReason: "HARD_CUT_LOSS_2" });
    const reduceOrders = run.client.orders.filter((order) => order.reduceOnly);
    expect(reduceOrders).toHaveLength(6);
    expect(reduceOrders.filter((order) => order.symbol === residual)).toHaveLength(1);
    expect(Array.from(run.client.positions.values()).every((qty) => Math.abs(qty) < 1e-9)).toBe(true);
  }, DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3));

  it("settles a fully exited persisted V3 hard-cut even when the next flat exchange read has no marks, without another order", async () => withDynamicEnv(async () => {
    const run = runner(6, { strategyVersion: DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3 });
    await run.executor.tick();
    const basket = run.store.getState().baskets[0]!;

    // Reproduce the post-fill race observed in LIVE: all exit fills are durable and the original
    // protective intent exists, but the immediate position reconciliation was stale.  By the next
    // tick the exchange is flat and therefore returns neither a position nor a fresh mark.
    // Simulate an already-open basket from the previous policy. Removing only
    // the new dispatch marker is intentional: its frozen V3 state must remain
    // executable after a later release introduces the net ladder.
    basket.dynamicMom36NetLadderExit = undefined;
    basket.dynamicMom36V3Exit = {
      version: "DYNAMIC_MOM36_V3_EXIT",
      hardCutLossThreshold: -0.02,
      mfeArmThreshold: 0.03,
      mfeGivebackFraction: 0.30,
      mfeTrailingFraction: 0.70,
      mfeTrailArmed: false,
      peakMfeReturn: null,
      mfeTrailingFloor: null,
      lastObservedReturn: -0.021,
      lastObservedAt: new Date(T0 + 60_000).toISOString(),
      mfeFloorWasBreached: false,
      exitTrigger: null,
      realizedNetReturn: null,
      forwardCounterfactual: { sourceObservationId: basket.sourceObservationId, horizonAtMs: basket.horizonExitAtMs ?? null, status: "PENDING_CANONICAL_36H" },
    };
    basket.dynamicMom36V3Exit.exitTrigger = {
      reason: "HARD_CUT_LOSS_2",
      observedReturn: -0.021,
      observedAt: new Date(T0 + 60_000).toISOString(),
      peakMfeReturn: null,
      mfeTrailingFloor: null,
      mfeFloorWasBreached: false,
    };
    for (const [index, leg] of basket.legs.entries()) {
      leg.exitOrderId = `settled-exit-${index}`;
      leg.exitOrderIds = [leg.exitOrderId];
      leg.exitPrice = leg.side === "LONG" ? leg.entryPrice * 0.97 : leg.entryPrice * 1.03;
      leg.exitPriceConfirmed = true;
    }
    run.store.save();
    run.client.positions.clear();
    run.client.marks.clear();
    const ordersBeforeRetry = run.client.orders.length;

    await run.executor.tick();

    expect(basket).toMatchObject({ status: "CLOSED", closeReason: "HARD_CUT_LOSS_2" });
    expect(basket.exitReconciliation?.state).toBe("CONFIRMED");
    // Every leg had a durable exit order already. The retry must be reconciliation/finalization
    // only, never another reduce-only submit against a flat exchange account.
    expect(run.client.orders).toHaveLength(ordersBeforeRetry);
    expect(run.client.orders.filter((order) => order.reduceOnly)).toHaveLength(0);
  }, DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3));

  it("does not retrofit a v1 Dynamic basket with the v3 hard cut", async () => withDynamicEnv(async () => {
    const run = runner(6);
    await run.executor.tick();
    const basket = run.store.getState().baskets[0]!;
    for (const leg of basket.legs) {
      const mark = run.client.marks.get(leg.symbol)!;
      run.client.marks.set(leg.symbol, mark * 0.97);
    }
    await run.executor.tick();
    expect(basket.status).toBe("COMPLETE");
    expect(basket.dynamicMom36V3Exit).toBeUndefined();
    expect(run.client.orders.filter((order) => order.reduceOnly)).toHaveLength(0);
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

describe("three-leg Testnet executor and cutoff",()=>{
 it.each(["LONG","SHORT"] as const)("persists exactly three $25 %s orders and closes all three", async direction=>withDynamicEnv(async()=>{
  const signal=evaluateDynamicMom36Formation(threeInput(T0-60_000,direction)).basket!;
  expect(signal).not.toBeNull();let context=threeContext(T0,direction);
  const run=runner(3,{strategyVersion:THREE_VERSION,signal,threeLegContext:()=>context});
  await run.executor.tick();
  const persisted=new CrossSectionalExecutorStore(run.dataDir,"executor.json",0).getState();
  const basket=persisted.baskets[0]!;expect(basket?.status).toBe("COMPLETE");expect(basket.plan).toHaveLength(3);
  expect(basket.plan?.map(p=>p.targetNotionalUsd)).toEqual([25,25,25]);expect(basket.plan?.map(p=>p.signalWeight)).toEqual([1/3,1/3,1/3]);
  expect(run.client.orders).toHaveLength(3);expect(run.client.orders.every(o=>o.side===(direction==="LONG"?"BUY":"SELL"))).toBe(true);
  expect(basket.plan?.map(p=>({symbol:p.symbol,quantity:p.requestedQty}))).toEqual(run.client.orders.map(o=>({symbol:o.symbol,quantity:o.quantity})));
  expect(basket.dynamicMom36?.threeLegFallback?.allowed).toBe(true);
  // MIXED blocks new entry but must never disable closing already-filled positions.
  context={...context,regime:{...context.regime,projection:"MIXED"}};
  expect(await run.executor.closeAllBasketsOrderly("TEST_THREE_LEG_CLOSE")).toEqual({closed:1,failed:0});
  expect(run.client.orders.filter(o=>o.reduceOnly)).toHaveLength(3);
  expect([...run.client.positions.values()].every(q=>Math.abs(q)<1e-9)).toBe(true);
 },THREE_VERSION));
 it.each(["MIXED","STALE","MAINNET"])("rejects a previously qualified signal when entry context changes to %s",async failure=>withDynamicEnv(async()=>{
  const signal=evaluateDynamicMom36Formation(threeInput(T0-60_000,"LONG")).basket!;
  const context=threeContext(T0,"LONG");if(failure==="MIXED")context.regime.projection="MIXED";if(failure==="STALE")context.regime.atMs=T0-21*60_000;if(failure==="MAINNET")context.venue="mainnet";
  const run=runner(3,{strategyVersion:THREE_VERSION,signal,threeLegContext:()=>context});await run.executor.tick();expect(run.client.orders).toHaveLength(0);expect(run.store.getState().entryAttempts?.at(-1)?.reason).toContain("THREE_LEG");
 },THREE_VERSION));
 it("rechecks regime after asynchronous quote/filter work before the first exchange submit",async()=>withDynamicEnv(async()=>{
  const signal=evaluateDynamicMom36Formation(threeInput(T0-60_000,"LONG")).basket!;const context=threeContext(T0,"LONG");
  const run=runner(3,{strategyVersion:THREE_VERSION,signal,threeLegContext:()=>context});const read=run.client.getExchangeFilters.bind(run.client);run.client.getExchangeFilters=async()=>{const r=await read();context.regime.projection="MIXED";return r;};
  await run.executor.tick();expect(run.client.orders).toHaveLength(0);
 },THREE_VERSION));
});

describe("three-leg protective lifecycle",()=>{
 it.each(["LONG","SHORT"] as const)("uses actual three-leg capital for %s hard cut",async direction=>withDynamicEnv(async()=>{
  const signal=evaluateDynamicMom36Formation(threeInput(T0-60_000,direction)).basket!;
  const run=runner(3,{strategyVersion:THREE_VERSION,signal,threeLegContext:()=>threeContext(T0,direction)});await run.executor.tick();
  const b=run.store.getState().baskets[0]!;for(const l of b.legs)run.client.marks.set(l.symbol,l.entryPrice*(direction==="LONG"?.97:1.03));
  await run.executor.tick();expect(b.status).toBe("CLOSED");expect(b.closeReason).toBe("HARD_CUT_LOSS_2");
  expect(b.lastGrossCapitalUsd).toBeGreaterThanOrEqual(75);expect(b.lastGrossCapitalUsd).toBeLessThan(76);
  expect(run.client.orders.filter(o=>o.reduceOnly)).toHaveLength(3);expect([...run.client.positions.values()].every(q=>Math.abs(q)<1e-9)).toBe(true);
 },THREE_VERSION));
 it("rolls back a partial directional open when regime changes before the next order",async()=>withDynamicEnv(async()=>{
  const signal=evaluateDynamicMom36Formation(threeInput(T0-60_000,"LONG")).basket!;const context=threeContext(T0,"LONG");
  const run=runner(3,{strategyVersion:THREE_VERSION,signal,threeLegContext:()=>context});const place=run.client.placeOrder.bind(run.client);
  run.client.placeOrder=async p=>{const order=await place(p);if(!p.reduceOnly)context.regime.projection="MIXED";return order;};
  await run.executor.tick();expect(run.client.orders.filter(o=>!o.reduceOnly)).toHaveLength(1);expect([...run.client.positions.values()].every(q=>Math.abs(q)<1e-9)).toBe(true);
 },THREE_VERSION));
});

describe("three-leg executable quote protection",()=>{
 it.each(["LONG","SHORT"] as const)("uses three-leg net liquidation for %s profit lock",async direction=>withDynamicEnv(async()=>{
  const signal=evaluateDynamicMom36Formation(threeInput(T0-60_000,direction)).basket!;
  const run=runner(3,{strategyVersion:THREE_VERSION,signal,threeLegContext:()=>threeContext(T0,direction)});await run.executor.tick();const b=run.store.getState().baskets[0]!;
  b.protectionCosts={version:BASKET_ACCOUNTING_V2,revision:costRevision(b.legs),observedAtMs:T0,complete:true,reasons:[],feesUsd:0,fundingUsd:0,trades:[],funding:[],ownership:[]};
  const quotes=(move:number)=>new Map(b.legs.map(l=>{const p=l.entryPrice*(1+(direction==="LONG"?move:-move));return [l.symbol,{symbol:l.symbol,bidPrice:p,bidQty:100,askPrice:p,askQty:100,observedAtMs:T0}];}));
  const internal=run.executor as any;
  internal.evaluateQuoteProtection(b,quotes(.01),new Date(T0).toISOString());
  expect(b.lastProtectionDiagnostic?.usable).toBe(true);expect(b.lastProtectionDiagnostic?.netPnlUsd).toBeGreaterThan(.6);expect(b.lastProtectionDiagnostic?.netPnlUsd).toBeLessThan(.8);
  expect(internal.evaluateQuoteProtection(b,quotes(.005),new Date(T0+1000).toISOString())).toBe("NET_PROFIT_FLOOR_EXIT");
 },THREE_VERSION));
 it("preserves maker order identities and flattens known fills on a mid-submit cutoff",async()=>withDynamicEnv(async()=>{
  process.env.CROSS_SECTIONAL_MAKER_ENTRY_ENABLED="1";
  const signal=evaluateDynamicMom36Formation(threeInput(T0-60_000,"LONG")).basket!;const context=threeContext(T0,"LONG");
  const run=runner(3,{strategyVersion:THREE_VERSION,signal,threeLegContext:()=>context,readPublicQuote:symbol=>{const p=100+SYMBOLS.indexOf(symbol as any)*10;return {bid:p-.01,ask:p+.01,mid:p,atMs:T0,venue:"BINANCE_USDM"};}});
  const placed=new Map<string,FuturesOrder>();const place=run.client.placeOrder.bind(run.client);
  run.client.placeOrder=async p=>{const o=await place(p);placed.set(o.orderId,o);if(!p.reduceOnly)context.regime.projection="MIXED";return o;};
  Object.assign(run.client,{cancelOrder:async()=>{},cancelOrderAndRead:async(_s:string,id:string)=>placed.get(id)!,queryOrder:async(_s:string,id:string)=>placed.get(id)!});
  await run.executor.tick();
  expect(run.client.orders.filter(o=>!o.reduceOnly)).toHaveLength(1);
  expect([...run.client.positions.values()].every(q=>Math.abs(q)<1e-9)).toBe(true);
  expect(run.store.getState().baskets[0]?.status).toBe("ABORTED");
 },THREE_VERSION));
 it("rolls back a partial maker fill without posting its taker remainder after cutoff",async()=>withDynamicEnv(async()=>{
  process.env.CROSS_SECTIONAL_MAKER_ENTRY_ENABLED="1";
  const signal=evaluateDynamicMom36Formation(threeInput(T0-60_000,"LONG")).basket!;const context=threeContext(T0,"LONG");
  const run=runner(3,{strategyVersion:THREE_VERSION,signal,threeLegContext:()=>context,readPublicQuote:symbol=>{const p=100+SYMBOLS.indexOf(symbol as any)*10;return {bid:p-.01,ask:p+.01,mid:p,atMs:T0,venue:"BINANCE_USDM"};}});
  const placed=new Map<string,FuturesOrder>();const place=run.client.placeOrder.bind(run.client);
  run.client.placeOrder=async p=>{const o=await place(p.reduceOnly?p:{...p,quantity:p.quantity/2});if(!p.reduceOnly){o.status="CANCELED";o.origQty=p.quantity;context.regime.projection="MIXED";}placed.set(o.orderId,o);return o;};
  Object.assign(run.client,{cancelOrderAndRead:async(_s:string,id:string)=>placed.get(id)!,queryOrder:async(_s:string,id:string)=>placed.get(id)!});
  delete (run.client as any).cancelOrder;
  await run.executor.tick();
  expect(run.client.orders.filter(o=>!o.reduceOnly)).toHaveLength(1);
  expect([...run.client.positions.values()].every(q=>Math.abs(q)<1e-9)).toBe(true);
  expect(run.store.getState().baskets[0]?.status).toBe("ABORTED");
 },THREE_VERSION));
});

describe.each([false,true])("three-leg quality final execution balanced=%s",balanced=>{
 const makeInput=(cut:number,direction:"LONG"|"SHORT"="LONG")=>{const input=qualityInput(cut,direction);input.threeLegContext!.qualityV3=balanced;return input;};
 const makeContext=(cut:number,direction:"LONG"|"SHORT"="LONG")=>({...qualityContext(cut,direction),qualityV3:balanced});
 function qualityRunner(direction:"LONG"|"SHORT"="LONG") {
  const input=makeInput(T0-60_000,direction),selected=evaluateDynamicMom36Formation(input);
  const context=makeContext(T0,direction),prices=new Map(input.activeUniverse.map(r=>[r.symbol,r.price]));
  const run=runner(3,{strategyVersion:THREE_VERSION,signal:selected.basket!,threeLegContext:()=>context,
   readPublicQuote:symbol=>({bid:prices.get(symbol)!*.99995,ask:prices.get(symbol)!*1.00005,mid:prices.get(symbol)!,atMs:T0,venue:"BINANCE_USDM_BOOK_TICKER"}),
   warmPublicQuote:async()=>null});
  for(const [symbol,price] of prices)run.client.marks.set(symbol,price);
  return {run,context,prices,selected};
 }
 function enableQuality(){process.env.CROSS_SECTIONAL_TESTNET_THREE_LEG_FALLBACK="1";process.env.CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V2="1";process.env.CROSS_SECTIONAL_TESTNET_THREE_LEG_QUALITY_V3=balanced?"1":"0";}
 it.each(["LONG","SHORT"] as const)("persists and executes three equal-notional %s legs in MIXED, then closes after flag disabled",async direction=>withDynamicEnv(async()=>{
  enableQuality();const {run,context,selected}=qualityRunner(direction);await run.executor.tick();
  const b=run.store.getState().baskets[0]!;expect(b?.status).toBe("COMPLETE");
  expect(run.client.orders.filter(o=>!o.reduceOnly)).toHaveLength(3);expect(b.plan?.every(p=>p.targetNotionalUsd===25)).toBe(true);
  expect(b.dynamicMom36?.threeLegFallback?.quality).toEqual(selected.snapshot!.threeLegFallback!.quality);
  const persisted=new CrossSectionalExecutorStore(run.dataDir,"executor.json",T0).getState().baskets[0]!;
  expect(persisted.dynamicMom36?.threeLegFallback?.quality).toEqual(b.dynamicMom36!.threeLegFallback!.quality);
  expect(persisted.plan?.map(p=>p.requestedQty)).toEqual(run.client.orders.filter(o=>!o.reduceOnly).map(o=>o.quantity));
  context.qualityV2=false;context.qualityV3=false;context.enabled=false;
  await run.executor.closeBasketOrderly(b.basketId,"MANUAL_CLOSE");expect(run.client.orders.filter(o=>o.reduceOnly)).toHaveLength(3);
 },THREE_VERSION));
 it("blocks before the first POST if room is consumed during quote refresh",async()=>withDynamicEnv(async()=>{
  enableQuality();const {run,prices,selected}=qualityRunner();
  const q=selected.snapshot!.threeLegFallback!.quality!.candidates.find(c=>selected.snapshot!.selectedLongs.includes(c.symbol))!;
  (run.executor as any).warmPublicQuoteFn=async()=>{prices.set(q.symbol,q.target);};
  await run.executor.tick();expect(run.client.orders).toHaveLength(0);
 },THREE_VERSION));
 it("rolls back a partial opening if panic arrives after the first fill",async()=>withDynamicEnv(async()=>{
  enableQuality();const {run,context}=qualityRunner(),place=run.client.placeOrder.bind(run.client);
  run.client.placeOrder=async args=>{const o=await place(args);if(!args.reduceOnly)context.regime.panic=true;return o;};
  await run.executor.tick();expect(run.client.orders.filter(o=>!o.reduceOnly)).toHaveLength(1);
  expect([...run.client.positions.values()].every(q=>Math.abs(q)<1e-9)).toBe(true);
  expect(run.store.getState().baskets[0]!.status).toBe("ABORTED");
 },THREE_VERSION));
 it("blocks a stale or cross-venue execution quote without orders",async()=>withDynamicEnv(async()=>{
  enableQuality();const {run}=qualityRunner();(run.executor as any).readPublicQuoteFn=()=>({bid:100,ask:100.01,mid:100,atMs:T0-6000,venue:"SPOT"});
  await run.executor.tick();expect(run.client.orders).toHaveLength(0);
 },THREE_VERSION));
 it("adopts and rolls back a partial maker fill when the remainder loses price room",async()=>withDynamicEnv(async()=>{
  enableQuality();process.env.CROSS_SECTIONAL_MAKER_ENTRY_ENABLED="1";
  const {run,prices,selected}=qualityRunner(),placed=new Map<string,FuturesOrder>(),place=run.client.placeOrder.bind(run.client);
  run.client.placeOrder=async args=>{
   const o=await place(args.reduceOnly?args:{...args,quantity:args.quantity/2});
   if(!args.reduceOnly){o.status="CANCELED";o.origQty=args.quantity;prices.set(args.symbol,selected.snapshot!.threeLegFallback!.quality!.candidates.find(c=>c.symbol===args.symbol)!.target);}
   placed.set(o.orderId,o);return o;
  };
  Object.assign(run.client,{cancelOrderAndRead:async(_s:string,id:string)=>placed.get(id)!,queryOrder:async(_s:string,id:string)=>placed.get(id)!});
  await run.executor.tick();expect(run.client.orders.filter(o=>!o.reduceOnly)).toHaveLength(1);
  expect([...run.client.positions.values()].every(q=>Math.abs(q)<1e-9)).toBe(true);
  const b=run.store.getState().baskets[0]!;expect(b.status).toBe("ABORTED");expect(b.plan![0]!.takerFallbackNeverAttempted).toBe(true);
 },THREE_VERSION));
 it("uses USD-M scale and actual rounded quantity for a multiplier quality leg",async()=>withDynamicEnv(async()=>{
  enableQuality();const input=makeInput(T0-60_000),ctx=makeContext(T0);
  const pepecandles=input.threeLegCandlesBySymbol!.BTCUSDT!.map(c=>({...c,open:c.open/1e7,close:c.close/1e7,high:c.high/1e7,low:c.low/1e7}));
  input.threeLegCandlesBySymbol={...input.threeLegCandlesBySymbol,"1000PEPEUSDT":pepecandles};
  input.activeUniverse[0]!.symbol="1000PEPEUSDT";input.activeUniverse[0]!.price/=1e7;
  const selected=evaluateDynamicMom36Formation(input);expect(selected.snapshot!.selectedLongs).toContain("1000PEPEUSDT");
  const prices=new Map(input.activeUniverse.map(r=>[r.symbol,r.price*(r.symbol==="1000PEPEUSDT"?1000:1)]));
  const run=runner(3,{strategyVersion:THREE_VERSION,signal:selected.basket!,threeLegContext:()=>ctx,
   readPublicQuote:symbol=>({bid:prices.get(symbol)!*.99995,ask:prices.get(symbol)!*1.00005,mid:prices.get(symbol)!,atMs:T0,venue:"BINANCE_USDM_BOOK_TICKER"})});
  for(const [symbol,price] of prices)run.client.marks.set(symbol,price);
  const filters=await run.client.getExchangeFilters();filters.set("1000PEPEUSDT",filters.get("BTCUSDT")!);run.client.getExchangeFilters=async()=>filters;
  await run.executor.tick();const b=run.store.getState().baskets[0]!;expect(b?.status).toBe("COMPLETE");
  const leg=b.legs.find(l=>l.symbol==="1000PEPEUSDT")!;expect(leg.qty*leg.entryPrice).toBeGreaterThanOrEqual(25);expect(leg.qty*leg.entryPrice).toBeLessThan(25.01);
  expect(b.plan!.find(p=>p.symbol===leg.symbol)!.requestedQty).toBe(run.client.orders.find(o=>o.symbol===leg.symbol)!.quantity);
 },THREE_VERSION));

});

import { describe, expect, it } from "vitest";

import type { FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
import {
  DAILY_RANGE_MAX_COST_RATIO,
  buildEmpiricalFrictionModel,
  conservativeFallbackFrictionModel,
  evaluateActualFillEconomics,
  prepareDailyRangeEconomics,
} from "../src/lib/daily-range-economics.js";

const filter: FuturesSymbolFilters = {
  symbol: "AAAUSDT",
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
  pricePrecision: 2,
  quantityPrecision: 3,
};

const at = "2026-08-27T10:05:00.000Z";

function baseInput(overrides: Partial<Parameters<typeof prepareDailyRangeEconomics>[0]> = {}) {
  return {
    side: "LONG" as const,
    route: "CONTINUATION",
    symbol: "AAAUSDT",
    batchTimestampMs: Date.parse(at) - 1_000,
    rawStructuralStop: 98,
    bbo: { bid: 99.99, ask: 100, observedAt: at, receivedAt: at, sourceTime: Date.parse(at) },
    filter,
    frictionModel: conservativeFallbackFrictionModel(at),
    bboMaxAgeMs: 30_000,
    allocationAtMs: Date.parse(at) + 2_000,
    ...overrides,
  };
}

describe("Daily Range V3 economics", () => {
  it("uses causal ask/bid, a capped $25 / $0.25 plan, and never zero friction", () => {
    const result = prepareDailyRangeEconomics(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.economics.expectedEntryPrice).toBeGreaterThan(100);
    expect(result.economics.requestedQty).toBeLessThanOrEqual(0.125);
    expect(result.economics.plannedNotionalUsd).toBeLessThanOrEqual(25);
    expect(result.economics.plannedRiskUsd).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(result.economics.safeLossFrictionBps).toBeGreaterThan(0);
    expect(result.economics.costRatio).toBeLessThanOrEqual(DAILY_RANGE_MAX_COST_RATIO);
    expect(result.economics.breakEvenWinRate).toBeGreaterThan(0);
    expect(result.economics.breakEvenWinRate).toBeLessThan(1);
  });

  it("rejects a too-tight structural stop instead of widening it", () => {
    const result = prepareDailyRangeEconomics(baseInput({ rawStructuralStop: 99.9 }));
    expect(result).toEqual({ ok: false, reason: "STOP_ECONOMICS_FAIL" });
  });

  it("fails closed when the capped risk plan cannot meet min notional", () => {
    const result = prepareDailyRangeEconomics(baseInput({
      filter: { ...filter, minNotional: 20 },
      rawStructuralStop: 50,
    }));
    expect(result).toEqual({ ok: false, reason: "RISK_BUDGET_UNEXECUTABLE" });
  });

  it("refuses a quote that is post-allocation or stale", () => {
    const result = prepareDailyRangeEconomics(baseInput({ allocationAtMs: Date.parse(at) + 31_000 }));
    expect(result).toEqual({ ok: false, reason: "BBO_STALE" });
  });

  it("flags an adverse actual fill without changing the structural stop", () => {
    const actual = evaluateActualFillEconomics({
      side: "LONG",
      entryPrice: 98.1,
      quantity: 0.125,
      stopPrice: 98,
      expectedCostRatio: 0.15,
      expectedPlannedRiskUsd: 0.25,
      safeLossFrictionBps: 33,
    });
    expect(actual?.materialViolation).toBe(true);
    expect(actual?.violation).toBe("POST_FILL_ECONOMICS_FAIL");
    expect(actual?.actualCostRatio).toBeGreaterThan(DAILY_RANGE_MAX_COST_RATIO);
  });

  it("flags a fill whose dollar risk materially exceeds its frozen plan", () => {
    const actual = evaluateActualFillEconomics({
      side: "LONG",
      entryPrice: 101,
      quantity: 0.1,
      stopPrice: 98,
      expectedCostRatio: 0.10,
      expectedPlannedRiskUsd: 0.25,
      safeLossFrictionBps: 10,
    });
    expect(actual?.actualInitialRiskUsd).toBeCloseTo(0.3, 10);
    expect(actual?.materialViolation).toBe(true);
    expect(actual?.violation).toBe("POST_FILL_RISK_FAIL");
  });

  it("creates empirical models only from enough terminal observations", () => {
    const sample = {
      tradeId: "t",
      closedAt: at,
      entryFeeBps: 4,
      exitFeeBps: 4,
      entryAdverseBps: 1,
      takeProfitExitAdverseBps: 2,
      stopExitAdverseBps: 3,
      stopGapBps: 2,
      exitReason: "TAKE_PROFIT" as const,
      feeEvidence: "EXACT_FILL_COMMISSION" as const,
    };
    expect(buildEmpiricalFrictionModel({ samples: [sample], createdAt: at, cutoffAt: at, environment: "testnet" })).toBeNull();
    const model = buildEmpiricalFrictionModel({
      samples: Array.from({ length: 12 }, (_, index) => ({ ...sample, tradeId: `t${index}`, exitReason: index % 2 ? "STOP_LOSS" as const : "TAKE_PROFIT" as const })),
      createdAt: at,
      cutoffAt: at,
      environment: "mainnet",
    });
    expect(model).toMatchObject({ source: "EMPIRICAL_LEDGER", sampleCount: 12, environment: "mainnet", sourceTradeCount: 12 });
    expect(model?.id).toMatch(/^daily-friction-v1-/);
  });

  it("uses one pointwise all-in loss path, so entry adverse execution is neither omitted nor double counted", () => {
    const samples = Array.from({ length: 12 }, (_, index) => ({
      tradeId: `loss-${index}`,
      closedAt: new Date(Date.parse(at) - (12 - index) * 1_000).toISOString(),
      entryFeeBps: 5,
      exitFeeBps: 5,
      // The high entry and high stop-gap observations occur on different loss
      // paths. Summing standalone p95s would invent a loss that never occurred.
      entryAdverseBps: index % 2 ? 10 : 0,
      takeProfitExitAdverseBps: null,
      stopExitAdverseBps: 0,
      stopGapBps: index % 2 ? 0 : 20,
      exitReason: "STOP_LOSS" as const,
      feeEvidence: "EXACT_FILL_COMMISSION" as const,
      sourceFillCount: 2,
    }));
    const model = buildEmpiricalFrictionModel({ samples, createdAt: at, cutoffAt: at, environment: "mainnet" });
    expect(model).not.toBeNull();
    expect(model?.entryAdverseP95Bps).toBe(10);
    expect(model?.stopGapP95Bps).toBe(20);
    // Each actual loss had 10 or 20 bps all-in, therefore p95 is 20 — never 30.
    expect(model?.lossAdverseP95Bps).toBe(20);
    const result = prepareDailyRangeEconomics(baseInput({ frictionModel: model }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.economics.safeLossEntryFeeComponentBps).toBe(5);
    expect(result.economics.safeLossExitFeeComponentBps).toBe(5);
    expect(result.economics.safeLossPathAdverseComponentBps).toBe(25);
    expect(result.economics.safeLossFrictionBps).toBe(35);
  });
});

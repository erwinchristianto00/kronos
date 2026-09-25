import { describe, expect, it } from "vitest";

import type { FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
import { DAILY_RANGE_FADE_OPPOSITE_RANGE_TARGET_POLICY_ID } from "../src/lib/daily-range-structural-sr.js";
import {
  DAILY_RANGE_MAX_COST_RATIO,
  buildEmpiricalFrictionModel,
  calculateCausalAtr14,
  conservativeFallbackFrictionModel,
  evaluateDailyRangeTradeGeometry,
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
    stopSource: "FLIPPED_RANGE_RETEST" as const,
    structuralTarget: {
      target: 104,
      targetSource: "CONFIRMED_1H_SWING_HIGH" as const,
      targetLevelType: "SWING_HIGH" as const,
      targetSourceTimeframe: "1h" as const,
      confirmedAt: "2026-08-27T09:00:00.000Z",
      sourceOpenTime: Date.parse("2026-08-27T07:00:00.000Z"),
    },
    bbo: { bid: 99.99, ask: 100, observedAt: at, receivedAt: at, sourceTime: Date.parse(at) },
    filter,
    frictionModel: conservativeFallbackFrictionModel(at),
    bboMaxAgeMs: 30_000,
    allocationAtMs: Date.parse(at) + 2_000,
    atr4hFeature: {
      atr4h: 2.5,
      atrSourceLastClosedAt: "2026-08-27T08:00:00.000Z",
      atrFeatureTimestamp: at,
    },
    ...overrides,
  };
}

describe("Daily Range V3 economics", () => {
  it("forms a fixed 2R target from the breakout-extreme stop without inventing a structural S/R target", () => {
    const result = prepareDailyRangeEconomics(baseInput({
      route: "FADE",
      rawStructuralStop: 98,
      structuralTarget: null,
      fixedTpMultipleR: 2,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.economics.targetMode).toBe("FIXED_R");
    expect(result.economics.targetPolicyId).toBeNull();
    expect(result.economics.targetSource).toBe("FIXED_2R");
    expect(result.economics.tpMultipleR).toBeCloseTo(2);
    expect(result.economics.expectedTakeProfitPrice - result.economics.expectedEntryPrice)
      .toBeCloseTo(2 * result.economics.stopRiskPrice, 8);
  });

  it("uses causal ask/bid, a capped $25 / $0.25 plan, and never zero friction", () => {
    const result = prepareDailyRangeEconomics(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.economics.expectedEntryPrice).toBeGreaterThan(100);
    expect(result.economics.requestedQty).toBeLessThanOrEqual(0.125);
    expect(result.economics.plannedNotionalUsd).toBeLessThanOrEqual(25);
    expect(result.economics.plannedRiskUsd).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(result.economics.safeLossFrictionBps).toBeGreaterThan(0);
    expect(result.economics.costRatio).toBeGreaterThan(0);
    expect(result.economics.breakEvenWinRate).toBeGreaterThan(0);
    expect(result.economics.breakEvenWinRate).toBeLessThan(1);
  });

  it("uses the frozen structural target in geometry and economic payoff instead of a global 2R proxy", () => {
    const continuation = prepareDailyRangeEconomics(baseInput({
      route: "CONTINUATION",
      structuralTarget: {
        target: 102,
        targetSource: "CONFIRMED_1H_SWING_HIGH",
        targetLevelType: "SWING_HIGH",
        targetSourceTimeframe: "1h",
        confirmedAt: "2026-08-27T09:00:00.000Z",
        sourceOpenTime: Date.parse("2026-08-27T07:00:00.000Z"),
      },
    }));
    const fade = prepareDailyRangeEconomics(baseInput({
      route: "FADE",
      structuralTarget: {
        target: 104,
        targetSource: "RANGE_OPPOSITE_BOUNDARY",
        targetLevelType: "RANGE_HIGH",
        targetSourceTimeframe: "RANGE",
        confirmedAt: "2026-08-27T04:00:00.000Z",
        sourceOpenTime: null,
      },
      structuralTargetPolicyId: DAILY_RANGE_FADE_OPPOSITE_RANGE_TARGET_POLICY_ID,
    }));
    expect(continuation.ok).toBe(true);
    expect(fade.ok).toBe(true);
    if (!continuation.ok || !fade.ok) return;
    expect(continuation.economics.grossStructuralRR).toBeLessThan(1);
    expect(fade.economics.grossStructuralRR).toBeGreaterThan(1.5);
    expect(fade.economics.targetPolicyId).toBe(DAILY_RANGE_FADE_OPPOSITE_RANGE_TARGET_POLICY_ID);
    const continuationRiskPct = continuation.economics.geometry.stopDistancePct!;
    expect(continuation.economics.geometry.tpDistancePct).toBeLessThan(continuationRiskPct);
    expect(fade.economics.geometry.tpDistancePct).toBeGreaterThan(continuationRiskPct);
    expect(continuation.economics.netWinR).toBeLessThan(fade.economics.netWinR);
    expect(continuation.economics.breakEvenWinRate).toBeGreaterThan(fade.economics.breakEvenWinRate);
  });

  it("keeps a narrow structural stop and sizes it with friction rather than applying a minimum-stop gate", () => {
    const result = prepareDailyRangeEconomics(baseInput({ rawStructuralStop: 99.9 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.economics.stopPct).toBeLessThan(0.005);
    expect(result.economics.effectiveLossRate).toBeGreaterThan(result.economics.stopPct);
  });

  it("keeps the retired percentage and ATR bands diagnostic-only across narrow, wide, far-target, and 2.5x-ATR structures", () => {
    const lowStop = prepareDailyRangeEconomics(baseInput({ rawStructuralStop: 98.8, structuralTarget: { ...baseInput().structuralTarget, target: 103 } }));
    const wideStop = prepareDailyRangeEconomics(baseInput({
      rawStructuralStop: 96.5,
      structuralTarget: { ...baseInput().structuralTarget, target: 110 },
      filter: { ...filter, minNotional: 1 },
    }));
    const farTarget = prepareDailyRangeEconomics(baseInput({
      rawStructuralStop: 98,
      structuralTarget: { ...baseInput().structuralTarget, target: 107 },
    }));
    const atrTarget = prepareDailyRangeEconomics(baseInput({
      rawStructuralStop: 98,
      structuralTarget: { ...baseInput().structuralTarget, target: 105 },
      atr4hFeature: { atr4h: 2, atrSourceLastClosedAt: "2026-08-27T08:00:00.000Z", atrFeatureTimestamp: at },
    }));
    for (const result of [lowStop, wideStop, farTarget, atrTarget]) expect(result.ok).toBe(true);
    if (!wideStop.ok || !farTarget.ok || !atrTarget.ok) return;
    expect(wideStop.economics.stopPct).toBeGreaterThan(0.03);
    expect(wideStop.economics.plannedNotionalUsd).toBeLessThan(25);
    expect(farTarget.economics.rewardPct).toBeGreaterThan(0.06);
    expect(farTarget.economics.geometry).toMatchObject({ admissionAuthority: "DIAGNOSTIC_ONLY", legacyDiagnosticReason: "TARGET_DISTANCE_TOO_WIDE" });
    expect(atrTarget.economics.geometry).toMatchObject({ admissionAuthority: "DIAGNOSTIC_ONLY", legacyDiagnosticReason: "TARGET_REACHABILITY_FAIL" });
  });

  it("rejects only mechanically when the structural reward cannot cover expected win friction", () => {
    const result = prepareDailyRangeEconomics(baseInput({
      structuralTarget: { ...baseInput().structuralTarget, target: 100.1 },
    }));
    expect(result).toMatchObject({ ok: false, reason: "NET_REWARD_NON_POSITIVE" });
  });

  it("fails closed when the capped risk plan cannot meet min notional", () => {
    const result = prepareDailyRangeEconomics(baseInput({
      filter: { ...filter, minNotional: 20 },
    }));
    expect(result).toEqual({ ok: false, reason: "RISK_BUDGET_UNEXECUTABLE" });
  });

  it("refuses a quote that is post-allocation or stale", () => {
    const result = prepareDailyRangeEconomics(baseInput({ allocationAtMs: Date.parse(at) + 31_000 }));
    expect(result).toEqual({ ok: false, reason: "BBO_STALE" });
  });

  it("keeps cost ratio diagnostic-only after an actual fill", () => {
    const actual = evaluateActualFillEconomics({
      side: "LONG",
      entryPrice: 98.1,
      quantity: 0.125,
      stopPrice: 98,
      expectedCostRatio: 0.15,
      expectedPlannedRiskUsd: 0.25,
      safeLossFrictionBps: 33,
    });
    expect(actual?.materialViolation).toBe(false);
    expect(actual?.violation).toBeNull();
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

  it("keeps the absolute stop and target boundaries inclusive, then rejects the next tick", () => {
    const geometry = (stopPct: number, targetPct: number) => evaluateDailyRangeTradeGeometry({
      expectedEntryPrice: 100,
      expectedStopPrice: 100 * (1 - stopPct),
      expectedTakeProfitPrice: 100 * (1 + targetPct),
      atr4hFeature: {
        atr4h: 4,
        atrSourceLastClosedAt: "2026-08-27T08:00:00.000Z",
        atrFeatureTimestamp: at,
      },
    });
    expect(geometry(0.025, 0.05)).toMatchObject({ geometryPass: true });
    expect(geometry(0.03, 0.06)).toMatchObject({ geometryPass: true });
    expect(geometry(0.0301, 0.05)).toMatchObject({ geometryPass: false, geometryRejectReason: "STRUCTURAL_STOP_TOO_WIDE" });
    expect(geometry(0.025, 0.0601)).toMatchObject({ geometryPass: false, geometryRejectReason: "TARGET_DISTANCE_TOO_WIDE" });
  });

  it("requires a target no farther than two completed-4h ATRs", () => {
    const geometry = (targetPct: number) => evaluateDailyRangeTradeGeometry({
      expectedEntryPrice: 100,
      expectedStopPrice: 98,
      expectedTakeProfitPrice: 100 * (1 + targetPct),
      atr4hFeature: {
        atr4h: 2,
        atrSourceLastClosedAt: "2026-08-27T08:00:00.000Z",
        atrFeatureTimestamp: at,
      },
    });
    expect(geometry(0.03)).toMatchObject({ geometryPass: true, targetAtrMultiple: 1.5 });
    expect(geometry(0.04)).toMatchObject({ geometryPass: true, targetAtrMultiple: 2 });
    const tooFar = geometry(0.042);
    expect(tooFar).toMatchObject({ geometryPass: false, geometryRejectReason: "TARGET_REACHABILITY_FAIL" });
    expect(tooFar.targetAtrMultiple).toBeCloseTo(2.1, 10);
  });

  it("sizes down a wide structural stop instead of rejecting it at the retired 3% band", () => {
    const bmtFilter: FuturesSymbolFilters = {
      symbol: "BMTUSDT", tickSize: 0.00001, stepSize: 1, minQty: 1, minNotional: 1, pricePrecision: 5, quantityPrecision: 0,
    };
    const result = prepareDailyRangeEconomics(baseInput({
      symbol: "BMTUSDT",
      rawStructuralStop: 0.02012,
      structuralTarget: {
        target: 0.023,
        targetSource: "CONFIRMED_1H_SWING_HIGH",
        targetLevelType: "SWING_HIGH",
        targetSourceTimeframe: "1h",
        confirmedAt: "2026-08-27T09:00:00.000Z",
        sourceOpenTime: Date.parse("2026-08-27T07:00:00.000Z"),
      },
      bbo: { bid: 0.02113, ask: 0.02114, observedAt: at, receivedAt: at, sourceTime: Date.parse(at) },
      filter: bmtFilter,
      atr4hFeature: {
        atr4h: 0.0015,
        atrSourceLastClosedAt: "2026-08-27T08:00:00.000Z",
        atrFeatureTimestamp: at,
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.economics.stopPct).toBeGreaterThan(0.03);
    expect(result.economics.plannedNotionalUsd).toBeLessThan(25);
    expect(result.economics.expectedLossUsd).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it("calculates ATR only from a continuous tail of completed 4h candles", () => {
    const decisionAtMs = Date.UTC(2026, 7, 27, 12, 5);
    const firstOpen = Date.UTC(2026, 7, 24, 20);
    const rows = Array.from({ length: 16 }, (_, index) => {
      const openTime = firstOpen + index * 4 * 60 * 60_000;
      const close = 100 + index;
      return { openTime, closeTime: openTime + 4 * 60 * 60_000 - 1, high: close + 1, low: close - 1, close };
    });
    const atr = calculateCausalAtr14({ candles: rows, decisionAtMs });
    expect(atr?.atr4h).toBeCloseTo(2, 10);
    expect(atr?.atrSourceLastClosedAt).toBe(new Date(rows.at(-1)!.closeTime + 1).toISOString());
    expect(calculateCausalAtr14({ candles: rows.filter((row) => row.openTime !== rows.at(-2)!.openTime), decisionAtMs })).toBeNull();
  });
});

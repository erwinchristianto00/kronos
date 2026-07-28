import { describe, expect, it } from "vitest";

import {
  EXECUTABLE_INNOVATION_LANE_IDS,
  INNOVATION_POLICY_ONLY_IDS,
  fundingCarryBaskets,
  hedgedResidualBaskets,
  isInnovationTestnetExecutionEnabled,
  singleSignalsForDirection,
} from "../src/lib/innovation-testnet-execution.js";
import type { BtcLeadLagObservation } from "../src/lib/btc-leadlag-snap-edge.js";
import type { FundingCarryObservation } from "../src/lib/funding-carry-edge.js";
import type { HedgedResidualShortObservation } from "../src/lib/hedged-residual-short-v2.js";
import type { QueueImbalanceToxicFlowObservation } from "../src/lib/queue-imbalance-toxic-flow-edge.js";

describe("innovation testnet execution adapters", () => {
  it("is structurally testnet-only and keeps policy layers out of the executable roster", () => {
    expect(isInnovationTestnetExecutionEnabled("testnet", {})).toBe(true);
    expect(isInnovationTestnetExecutionEnabled("mainnet", {})).toBe(false);
    expect(isInnovationTestnetExecutionEnabled("testnet", { INNOVATION_TESTNET_EXEC_DISABLED: "1" })).toBe(false);
    expect(EXECUTABLE_INNOVATION_LANE_IDS).toHaveLength(8);
    for (const policyId of INNOVATION_POLICY_ONLY_IDS) {
      expect(EXECUTABLE_INNOVATION_LANE_IDS).not.toContain(policyId);
    }
  });

  it("preserves single-symbol direction, structural stop, target, and horizon", () => {
    const btc = {
      observationId: "btc-1",
      symbol: "ETHUSDT",
      direction: "LONG",
      entryPrice: 100,
      initialStop: 98,
      convergenceTarget: 101,
      openedAtMs: 10,
      status: "OPEN",
    } as BtcLeadLagObservation;
    const queue = {
      observationId: "queue-1",
      symbol: "SOLUSDT",
      direction: "SHORT",
      entryMid: 200,
      openedAtMs: 20,
      markoutHorizonMs: 300_000,
      status: "OPEN",
    } as QueueImbalanceToxicFlowObservation;

    const longSignals = singleSignalsForDirection([btc], "LONG");
    expect(longSignals).toMatchObject([
      { symbol: "ETHUSDT", entryPrice: 100, stopPrice: 98, targetPrice: 101 },
    ]);
    expect(singleSignalsForDirection([btc], "SHORT")).toEqual([]);

    const shortSignals = singleSignalsForDirection([queue], "SHORT");
    expect(shortSignals[0]!.stopPrice).toBeGreaterThan(queue.entryMid);
    expect(shortSignals[0]!.maxHoldMs).toBe(300_000);
  });

  it("maps funding and residual observations into atomic long/short baskets", () => {
    const funding = {
      observationId: "funding-1",
      openedAt: "2026-07-28T00:00:00.000Z",
      openedAtMs: 100,
      longSymbol: "ETHUSDT",
      shortSymbol: "SOLUSDT",
      longEntryPrice: 2_000,
      shortEntryPrice: 200,
      divergenceStopReturn: 0.004,
      status: "OPEN",
    } as FundingCarryObservation;
    const carryBasket = fundingCarryBaskets([funding])[0]!;
    expect(carryBasket.longLeg.map((leg) => leg.symbol)).toEqual(["ETHUSDT"]);
    expect(carryBasket.shortLeg.map((leg) => leg.symbol)).toEqual(["SOLUSDT"]);
    expect(carryBasket.stopLossReturn).toBe(0.004);

    const residual = {
      observationId: "residual-1",
      openedAt: "2026-07-28T00:00:00.000Z",
      openedAtMs: 200,
      benchmarkSymbol: "BTCUSDT",
      benchmarkEntryPrice: 100_000,
      hedgeBeta: 0.8,
      shortLegs: [
        { symbol: "DOGEUSDT", entryPrice: 0.1, weight: 0.6 },
        { symbol: "WLDUSDT", entryPrice: 1, weight: 0.4 },
      ],
      takeProfitReturn: 0.005,
      stopReturn: 0.0035,
      maxHoldBars: 12,
      status: "OPEN",
    } as HedgedResidualShortObservation;
    const residualBasket = hedgedResidualBaskets([residual])[0]!;
    expect(residualBasket.longLeg.map((leg) => leg.symbol)).toEqual(["BTCUSDT"]);
    expect(residualBasket.shortLeg.map((leg) => leg.symbol)).toEqual(["DOGEUSDT", "WLDUSDT"]);
    expect(residualBasket.takeProfitReturn).toBe(0.005);
    expect(residualBasket.stopLossReturn).toBe(0.0035);
    expect(residualBasket.horizonMs).toBe(12 * 3_600_000);
  });
});

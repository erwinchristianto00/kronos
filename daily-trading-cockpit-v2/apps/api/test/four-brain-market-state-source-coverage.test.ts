import { describe, expect, it } from "vitest";

import {
  buildFourBrainGatherInput,
  marketLiquidityScoreFromExecutionCost,
  type FourBrainBindingDeps,
} from "../src/lib/four-brain-live-gather-bindings.js";

const NOW = 1_800_000_000_000;
const edge = {
  lookup: () => ({ avgNetR: 0, n: 0 }),
  verdict: () => ({ decision: "ALLOW_PROVEN" }),
  hasPositiveLane: () => true,
};

function deps(overrides: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
  return {
    instanceId: "3102",
    nowMs: NOW,
    axisScore: 0.1,
    axisAtMs: NOW,
    axisSlopePerHour: 0,
    btcAtrPercentile: 50,
    atrAtMs: NOW,
    advancersPct: 0.5,
    breadthAtMs: NOW,
    sentiment: 0,
    sentimentAtMs: NOW,
    safetyEvents: [],
    regimeRaw: "MIXED",
    edgeMemory: edge,
    controllerBias: "MIXED",
    convictionScore: 0.5,
    allowsLong: true,
    allowsShort: true,
    bestLaneReportForDirection: () => null,
    crowdAlignLong: 0,
    crowdAtMs: NOW,
    kronosAgree: null,
    kronosAtMs: null,
    openSignals: [],
    maxSignalAgeMs: 50 * 60_000,
    openPositions: [],
    markPriceForSymbol: () => ({ price: null, atMs: null }),
    laneEligibleIncumbent: () => true,
    killLatched: false,
    killReason: null,
    ...overrides,
  };
}

describe("Four-Brain Market State source coverage", () => {
  it("uses a real BTC execution-cost proxy only when a complete depth snapshot exists", () => {
    const score = marketLiquidityScoreFromExecutionCost({
      spreadBps: 2,
      expectedSlippageBpsBuy: 6,
      expectedSlippageBpsSell: 4,
    });
    expect(score).toBeCloseTo(0.76, 12); // max(2, 6, 4) against the explicit 25bps reference threshold
    expect(marketLiquidityScoreFromExecutionCost({ spreadBps: 2, expectedSlippageBpsBuy: null, expectedSlippageBpsSell: 4 })).toBe(0);
    expect(marketLiquidityScoreFromExecutionCost({ spreadBps: null, expectedSlippageBpsBuy: 1, expectedSlippageBpsSell: 1 })).toBeNull();

    const input = buildFourBrainGatherInput(deps({ marketLiquidityScore: score, marketLiquidityAtMs: NOW }));
    expect(input.marketState.liquidity).toMatchObject({
      sourceId: "btc-usdm-execution-cost-liquidity-proxy",
      normalized: score,
      observedAtMs: NOW,
      missingReason: null,
    });
  });

  it("keeps an unavailable source MISSING and preserves the actual conflict-news provider identity", () => {
    const missing = buildFourBrainGatherInput(deps());
    expect(missing.marketState.liquidity.normalized).toBeNull();
    expect(missing.marketState.liquidity.missingReason).toContain("unavailable");
    expect(missing.marketState.eventRisk.normalized).toBeNull();

    const input = buildFourBrainGatherInput(deps({ eventRiskScore: 0.72, eventRiskAtMs: NOW }));
    expect(input.marketState.eventRisk).toMatchObject({
      sourceId: "gdelt-conflict-news-volume-risk",
      normalized: 0.72,
      observedAtMs: NOW,
      missingReason: null,
    });

    const fallback = buildFourBrainGatherInput(deps({
      eventRiskScore: 0,
      eventRiskAtMs: NOW,
      eventRiskSourceId: "google-news-rss-conflict-volume-risk",
    }));
    expect(fallback.marketState.eventRisk).toMatchObject({
      sourceId: "google-news-rss-conflict-volume-risk",
      normalized: 0,
      observedAtMs: NOW,
      missingReason: null,
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Candle } from "@dtc/shared";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHedgedResidualShortObservation,
  resolveHedgedResidualShortObservation,
  selectHedgedResidualShortCandidates,
  type HedgedResidualCandidate,
} from "../src/lib/hedged-residual-short-v2.js";
import {
  passesFundingCarryCrowdingV2,
} from "../src/lib/funding-carry-crowding-v2.js";
import type {
  FundingCarryCandidate,
  FundingCarrySymbolSnapshot,
} from "../src/lib/funding-carry-edge.js";
import {
  evaluateStrictReclaim,
} from "../src/lib/liq-recoil-strict-reclaim-v2.js";
import type {
  LiquidationCascadeEvent,
  LqrFlowSample,
} from "../src/lib/liq-recoil-edge.js";
import {
  evaluateCompressionRetest,
} from "../src/lib/compression-retest-v2.js";
import type {
  CompressionExpansionObservation,
} from "../src/lib/compression-expansion-edge.js";
import {
  assessQueueImbalanceToxicFlow,
  resolveQueueImbalanceToxicFlowObservation,
  type QueueImbalanceToxicFlowObservation,
} from "../src/lib/queue-imbalance-toxic-flow-edge.js";
import type { MicrostructureSnapshot } from "../src/lib/order-flow-microstructure.js";

const HOUR = 3_600_000;

function candle(
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  return { openTime, open, high, low, close, volume };
}

describe("innovation V2 shadow lanes", () => {
  it("selects persistent bottom residuals for SHORT continuation, never residual winners", () => {
    const ranked = [
      { symbol: "WINNER", price: 100, beta: 1, symbolReturn: 0.05, btcReturn: 0.01, residualReturn: 0.04, rank: 1 },
      { symbol: "MID", price: 100, beta: 1, symbolReturn: 0.01, btcReturn: 0.01, residualReturn: 0, rank: 2 },
      { symbol: "WEAK1", price: 100, beta: 1, symbolReturn: 0, btcReturn: 0.01, residualReturn: -0.01, rank: 3 },
      { symbol: "WEAK2", price: 100, beta: 1, symbolReturn: -0.01, btcReturn: 0.01, residualReturn: -0.02, rank: 4 },
    ];
    const selected = selectHedgedResidualShortCandidates({
      ranked,
      volatilityBySymbol: new Map([
        ["WINNER", 0.02],
        ["MID", 0.02],
        ["WEAK1", 0.02],
        ["WEAK2", 0.02],
      ]),
      rankHistoryFor: (symbol) => symbol === "WEAK1" ? [3, 3, 3] : symbol === "WEAK2" ? [4, 4, 4] : [1, 1, 1],
      k: 2,
      maxResidualReturn: -0.002,
      minPersistence: 0.5,
    });

    expect(selected.map((candidate) => candidate.ranked.symbol)).toEqual(["WEAK1", "WEAK2"]);
    expect(selected.some((candidate) => candidate.ranked.symbol === "WINNER")).toBe(false);
  });

  it("resolves a beta-hedged residual-short basket after costs without intrabar fill assumptions", () => {
    const now = Date.UTC(2026, 6, 28, 0, 0, 0);
    const candidates: HedgedResidualCandidate[] = [
      {
        ranked: {
          symbol: "ALT1",
          price: 100,
          beta: 1,
          symbolReturn: -0.01,
          btcReturn: 0,
          residualReturn: -0.01,
          rank: 3,
        },
        persistence: 1,
        volatility: 0.02,
      },
      {
        ranked: {
          symbol: "ALT2",
          price: 200,
          beta: 1,
          symbolReturn: -0.02,
          btcReturn: 0,
          residualReturn: -0.02,
          rank: 4,
        },
        persistence: 1,
        volatility: 0.02,
      },
    ];
    const observation = buildHedgedResidualShortObservation({
      candidates,
      benchmarkEntryPrice: 100,
      regimeAtEntry: "Bearish pressure",
      now,
    });
    expect(observation).not.toBeNull();
    const patch = resolveHedgedResidualShortObservation(
      observation!,
      new Map([
        ["BTCUSDT", [candle(now + HOUR, 100, 100, 100, 100)]],
        ["ALT1", [candle(now + HOUR, 98, 98, 98, 98)]],
        ["ALT2", [candle(now + HOUR, 196, 196, 196, 196)]],
      ]),
      now + HOUR,
    );

    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.exitReason).toBe("BASKET_TAKE_PROFIT");
    expect(patch?.netR).toBeGreaterThan(0);
  });

  it("expires a residual basket that can no longer obtain enough synchronized leg candles", () => {
    const now = Date.UTC(2026, 6, 28, 0, 0, 0);
    const observation = buildHedgedResidualShortObservation({
      candidates: [
        {
          ranked: {
            symbol: "ALT1",
            price: 100,
            beta: 1,
            symbolReturn: -0.01,
            btcReturn: 0,
            residualReturn: -0.01,
            rank: 3,
          },
          persistence: 1,
          volatility: 0.02,
        },
        {
          ranked: {
            symbol: "ALT2",
            price: 100,
            beta: 1,
            symbolReturn: -0.01,
            btcReturn: 0,
            residualReturn: -0.01,
            rank: 4,
          },
          persistence: 1,
          volatility: 0.02,
        },
      ],
      benchmarkEntryPrice: 100,
      regimeAtEntry: null,
      now,
    })!;
    const oneSharedBar = new Map([
      ["BTCUSDT", [candle(now + HOUR, 100, 100, 100, 100)]],
      ["ALT1", [candle(now + HOUR, 100, 100, 100, 100)]],
      ["ALT2", [candle(now + HOUR, 100, 100, 100, 100)]],
    ]);

    expect(
      resolveHedgedResidualShortObservation(observation, oneSharedBar, now + HOUR),
    ).toBeNull();
    const patch = resolveHedgedResidualShortObservation(
      observation,
      oneSharedBar,
      now + observation.maxHoldBars * HOUR * 3 + 1,
    );
    expect(patch?.status).toBe("EXPIRED");
  });

  it("requires the funding receiver to be absolutely and cross-sectionally crowded", () => {
    const snapshots = new Map<string, FundingCarrySymbolSnapshot>([
      ["A", { symbol: "A", fundingRate: -0.0001, markPrice: 100 }],
      ["B", { symbol: "B", fundingRate: 0, markPrice: 100 }],
      ["C", { symbol: "C", fundingRate: 0.0001, markPrice: 100 }],
      ["D", { symbol: "D", fundingRate: 0.0005, markPrice: 100 }],
    ]);
    const crowded: FundingCarryCandidate = {
      cluster: "TEST",
      longSymbol: "A",
      shortSymbol: "D",
      longFundingRate: -0.0001,
      shortFundingRate: 0.0005,
      diffPerInterval: 0.0006,
      longMarkPrice: 100,
      shortMarkPrice: 100,
    };
    const notCrowded = { ...crowded, shortSymbol: "C", shortFundingRate: 0.0001, diffPerInterval: 0.0002 };

    expect(passesFundingCarryCrowdingV2(crowded, snapshots)).toBe(true);
    expect(passesFundingCarryCrowdingV2(notCrowded, snapshots)).toBe(false);
  });

  it("requires event-VWAP, retrace, candle confirmation, and taker-flow flip for liquidation reclaim", () => {
    const start = Date.UTC(2026, 6, 28, 0, 0, 0);
    const event: LiquidationCascadeEvent = {
      cascadeDirection: "DOWN",
      recoilDirection: "LONG",
      windowStartMs: start,
      extremeBarOpenTime: start + 5 * 60_000,
      lastBarOpenTime: start + 15 * 60_000,
      preCascadeClose: 100,
      extremePrice: 90,
      cascadeRange: 10,
      cascadeReturn: -0.1,
      atrMultiple: 5,
      stallBars: 3,
      lastClose: 96,
    };
    const candles = [
      candle(start, 100, 100, 94, 95),
      candle(start + 5 * 60_000, 95, 95, 90, 91),
      candle(start + 10 * 60_000, 91, 94, 91, 93),
      candle(start + 15 * 60_000, 93, 97, 93, 96),
    ];
    const flow: LqrFlowSample[] = [
      { atMs: start + 5 * 60_000, oiChangePercent: -2, takerBuySellRatio: 0.7, fundingBps: 1 },
      { atMs: start + 15 * 60_000, oiChangePercent: -0.2, takerBuySellRatio: 1.2, fundingBps: 1 },
    ];
    const passes = evaluateStrictReclaim({ candles, event, flowSamples: flow });
    const noFlip = evaluateStrictReclaim({
      candles,
      event,
      flowSamples: flow.map((sample) => ({ ...sample, takerBuySellRatio: 0.8 })),
    });

    expect(passes.passes).toBe(true);
    expect(noFlip.passes).toBe(false);
    expect(noFlip.reasons).toContain("TAKER_FLOW_NOT_FLIPPED_LONG");
  });

  it("accepts a bounded compression range retest and rejects a chased close", () => {
    const parent: CompressionExpansionObservation = {
      observationId: "parent",
      symbol: "BTCUSDT",
      direction: "LONG",
      openedAt: new Date(0).toISOString(),
      openedAtMs: 0,
      entryPrice: 100.5,
      initialStop: 99,
      targetPrice: 112.5,
      stopDistanceBps: 149.25,
      atrAtBreakout: 1,
      compressionRangeHigh: 100,
      compressionRangeLow: 99,
      atrPercentileAtCompression: 10,
      bbWidthPercentileAtCompression: 10,
      volumeRatio: 2,
      takerBuyRatio: 0.7,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      maxFavorableR: null,
      exitReason: null,
      resolvedAt: null,
    };

    expect(evaluateCompressionRetest(parent, candle(HOUR, 100.05, 100.3, 99.95, 100.2)).passes).toBe(true);
    const chased = evaluateCompressionRetest(parent, candle(HOUR, 100.5, 101.3, 99.95, 101));
    expect(chased.passes).toBe(false);
    expect(chased.reasons).toContain("RETEST_CLOSE_TOO_EXTENDED");
  });

  it("records queue/flow agreement only when liquidity is measurable, then resolves next-snapshot markout", () => {
    const snapshot: MicrostructureSnapshot = {
      symbol: "BTCUSDT",
      capturedAtMs: 0,
      bestBid: 99.99,
      bestAsk: 100.01,
      spreadBps: 2,
      depthImbalance: {
        imbalance: 0.3,
        bidDepthWithinWindow: 130,
        askDepthWithinWindow: 70,
        midPrice: 100,
      },
      takerFlow: {
        takerBuyRatio: 0.65,
        signedVolume: 30,
        buyVolume: 65,
        sellVolume: 35,
        totalVolume: 100,
        tradeCount: 100,
        tradeIntensityPerSec: 10,
      },
      expectedSlippageBpsBuy: 1,
      expectedSlippageBpsSell: 1,
    };
    const assessment = assessQueueImbalanceToxicFlow(snapshot);
    expect(assessment.passes).toBe(true);
    expect(assessment.direction).toBe("LONG");

    const observation: QueueImbalanceToxicFlowObservation = {
      observationId: "qitf",
      symbol: "BTCUSDT",
      direction: "LONG",
      openedAt: new Date(0).toISOString(),
      openedAtMs: 0,
      entryMid: 100,
      depthImbalance: 0.3,
      takerBuyRatio: 0.65,
      tradeCount: 100,
      spreadBps: 2,
      expectedSlippageBps: 1,
      toxicityProxy: assessment.toxicityProxy!,
      markoutHorizonMs: 300_000,
      exitMid: null,
      directionalReturn: null,
      netReturn: null,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      exitReason: null,
      resolvedAt: null,
    };
    const patch = resolveQueueImbalanceToxicFlowObservation(observation, 101, 300_000);
    expect(patch?.status).toBe("CLOSED_WIN");
    expect(patch?.netR).toBeGreaterThan(0);
  });
});

describe("innovation V2 wiring remains report-only", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const routeSource = readFileSync(resolve(testDir, "../src/routes/shadow.ts"), "utf-8");
  const moduleNames = [
    "hedged-residual-short-v2.ts",
    "funding-carry-crowding-v2.ts",
    "liq-recoil-strict-reclaim-v2.ts",
    "compression-retest-v2.ts",
    "queue-imbalance-toxic-flow-edge.ts",
  ];

  it("registers every report endpoint and scheduler cycle", () => {
    const endpoints = [
      "hedged-residual-short-v2",
      "funding-carry-crowding-v2",
      "liq-recoil-strict-reclaim-v2",
      "compression-retest-v2",
      "queue-imbalance-toxic-flow",
    ];
    const cycleFunctions = [
      "runHedgedResidualShortV2CycleGuarded",
      "runFundingCarryCrowdingV2CycleGuarded",
      "runLiqRecoilStrictReclaimV2CycleGuarded",
      "runCompressionRetestV2CycleGuarded",
      "runQueueImbalanceToxicFlowCycleGuarded",
    ];

    for (const endpoint of endpoints) {
      expect(routeSource).toContain(`/api/shadow/${endpoint}`);
    }
    for (const cycleFunction of cycleFunctions) {
      expect(routeSource).toContain(cycleFunction);
    }
  });

  it("does not import execution, private-order, or allocation authority", () => {
    for (const moduleName of moduleNames) {
      const source = readFileSync(resolve(testDir, `../src/lib/${moduleName}`), "utf-8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
      expect(imports.join("\n")).not.toMatch(
        /live-execution|live-executor|binance-futures-private|lane-allocation|regime-autopilot/,
      );
    }
  });
});

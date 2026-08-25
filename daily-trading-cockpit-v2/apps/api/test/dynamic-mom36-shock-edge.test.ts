import { describe, expect, it } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  buildDynamicMom36ShockBasket,
  completedCandlesForDynamicMom36,
} from "../src/lib/cross-sectional-edge.js";
import { DYNAMIC_MOM36_HORIZON_MS } from "../src/lib/dynamic-mom36-shock-strategy.js";

const HOUR = 3_600_000;
const cutoff = Date.parse("2026-08-25T12:00:00.000Z");

function candles(): Candle[] {
  return [
    { openTime: cutoff - 3 * HOUR, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { openTime: cutoff - 2 * HOUR, open: 101, high: 101, low: 101, close: 101, volume: 1 },
    { openTime: cutoff - HOUR, open: 102, high: 102, low: 102, close: 102, volume: 1 },
    // This bar is in progress at cutoff and must never become a Dynamic feature.
    { openTime: cutoff, open: 103, high: 103, low: 103, close: 999, volume: 1 },
  ];
}

function universe() {
  return [
    ["BTCUSDT", 0.09], ["ETHUSDT", 0.08], ["SOLUSDT", 0.07], ["DOGEUSDT", 0.06],
    ["AVAXUSDT", -0.01], ["LINKUSDT", -0.02],
  ].map(([symbol, mom36], index) => ({
    symbol: String(symbol),
    mom36: Number(mom36),
    price: 100 + index,
    volatility: 0.01,
    fastReturn: 0,
    extensionVol: 0,
    longEligible: true,
    shortEligible: true,
    shortBlocked: false,
  }));
}

describe("Dynamic MOM36 formation timestamp and frozen snapshot", () => {
  it("uses only fully closed candles and refuses a future/in-progress feature", () => {
    const complete = completedCandlesForDynamicMom36(candles(), cutoff);
    expect(complete?.featureTimestampMs).toBe(cutoff);
    expect(complete?.candles.at(-1)?.close).toBe(102);
    const oneMillisecondEarlier = completedCandlesForDynamicMom36(candles(), cutoff - 1);
    expect(oneMillisecondEarlier?.featureTimestampMs).toBe(cutoff - HOUR);
    expect(oneMillisecondEarlier?.candles.at(-1)?.close).toBe(101);
    expect(completedCandlesForDynamicMom36([candles().at(-1)!], cutoff)).toBeNull();
  });

  it("forms an equal-$25 4L2S observation only after current admission and freezes all audit inputs", () => {
    const observation = buildDynamicMom36ShockBasket({
      activeUniverse: universe(),
      now: new Date(cutoff).toISOString(),
      openedAtMs: cutoff,
      horizonMs: DYNAMIC_MOM36_HORIZON_MS,
      featureTimestampMs: cutoff,
      decisionInformationCutoffMs: cutoff,
      maxPerCluster: 0,
      admissionScoreGap: 0.058,
      admissionScoreGapFloor: 0.058,
      admissionPassed: true,
    })!;

    expect(observation).toMatchObject({
      horizonMs: DYNAMIC_MOM36_HORIZON_MS,
      longK: 4,
      shortK: 2,
      weightingModel: "EQUAL_NOTIONAL",
      takeProfitReturn: null,
      stopLossReturn: null,
      riskDistanceAtOpen: null,
      regimeFlipExit: false,
      dynamicMom36: {
        featureTimestamp: new Date(cutoff).toISOString(),
        decisionInformationCutoff: new Date(cutoff).toISOString(),
        positiveCount: 4,
        negativeCount: 2,
        zeroCount: 0,
        baseAllocation: { label: "4L2S" },
        baseSelectedLongs: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"],
        baseSelectedShorts: ["LINKUSDT", "AVAXUSDT"],
        finalAllocation: { label: "4L2S" },
      },
    });
    expect(observation.dynamicMom36?.activeUniverse.every((row) => typeof row.cluster === "string" && row.cluster.length > 0)).toBe(true);
    expect([...observation.longLeg, ...observation.shortLeg].every((leg) => leg.weight === 1 / 6)).toBe(true);
    expect(observation.dynamicMom36?.activeUniverse).toHaveLength(6);
    expect(buildDynamicMom36ShockBasket({
      activeUniverse: universe(),
      now: new Date(cutoff).toISOString(),
      openedAtMs: cutoff,
      horizonMs: DYNAMIC_MOM36_HORIZON_MS,
      featureTimestampMs: cutoff + 1,
      decisionInformationCutoffMs: cutoff,
      maxPerCluster: 0,
      admissionScoreGap: null,
      admissionScoreGapFloor: 0.058,
      admissionPassed: true,
    })).toBeNull();
  });
});

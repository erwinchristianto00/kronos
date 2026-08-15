import type { Candidate } from "@dtc/shared";
import { describe, expect, it } from "vitest";
import {
  buildCrossSectionalDirectionalRegimeDecision,
  confirmCrossSectionalDirectionalRegime,
  crossSectionalDirectionalOpenSignals,
  evaluateDirectionalReversal,
} from "../src/lib/cross-sectional-directional-regime.js";
import { isTestnetCrossSectionalHorizonLaneAllowed } from "../src/lib/live-executor-wiring.js";

function candidate(
  symbol: string,
  direction: "LONG" | "SHORT",
  score: number,
  oppositeScore = 60,
): Candidate {
  const longScore = direction === "LONG" ? score : oppositeScore;
  const shortScore = direction === "SHORT" ? score : oppositeScore;
  return {
    symbol,
    finalDirection: direction,
    direction,
    finalStatus: "TRADE_NOW",
    status: "TRADE_NOW",
    longScore,
    shortScore,
    confidence: 82,
    dataQualityScore: 90,
    liquidityScore: 90,
    sourceConflict: false,
    directionConflict: false,
    horizonConflict: false,
    kronosBias: direction,
    currentPrice: 100,
    stopLoss: direction === "LONG" ? 95 : 105,
    selectedExecutionPlan: {
      routeMode: "PROFIT_CANDIDATE",
      primaryProfitEligible: true,
    },
    candidateFingerprint: { value: `${symbol}-${direction}` },
  } as Candidate;
}

function snapshot(marketRegime: string, candidates: Candidate[]) {
  return {
    marketRegime,
    candidates,
    scanBatchId: "2026-08-12T14:00:00.000Z",
    scanFinishedAt: "2026-08-12T14:00:00.000Z",
  };
}

describe("cross-sectional directional regime selector", () => {
  it("keeps every non-cross-sectional lane locked on testnet", () => {
    const env = {
      TESTNET_ONLY_CROSS_SECTIONAL_HORIZON: "1",
      CROSS_SECTIONAL_DIRECTIONAL_REGIME_EXEC_ENABLED: "1",
    } as NodeJS.ProcessEnv;
    expect(isTestnetCrossSectionalHorizonLaneAllowed("testnet", "CROSS_SECTIONAL_MARKET_NEUTRAL", env)).toBe(true);
    expect(isTestnetCrossSectionalHorizonLaneAllowed("testnet", "CROSS_SECTIONAL_DIRECTIONAL_LONG", env)).toBe(true);
    expect(isTestnetCrossSectionalHorizonLaneAllowed("testnet", "CROSS_SECTIONAL_DIRECTIONAL_SHORT", env)).toBe(true);
    expect(isTestnetCrossSectionalHorizonLaneAllowed("testnet", "SHORT_FADE_EXHAUSTION", env)).toBe(false);
    expect(isTestnetCrossSectionalHorizonLaneAllowed("testnet", "CROSS_SECTIONAL_TREND", env)).toBe(false);
  });

  it("opens exactly the three highest eligible shorts in explicit bearish pressure", () => {
    const s = snapshot("Bearish pressure", [
      candidate("XRPUSDT", "SHORT", 91),
      candidate("NEARUSDT", "SHORT", 86),
      candidate("BTCUSDT", "SHORT", 84),
      candidate("SOLUSDT", "SHORT", 82),
      { ...candidate("BADUSDT", "SHORT", 99), directionConflict: true },
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("BEAR_SHORT_3");
    expect(decision.shortPicks.map((pick) => pick.symbol)).toEqual(["XRPUSDT", "NEARUSDT", "BTCUSDT"]);
    expect(crossSectionalDirectionalOpenSignals(s, "SHORT").map((signal) => signal.symbol)).toEqual(["XRPUSDT", "NEARUSDT", "BTCUSDT"]);
    expect(crossSectionalDirectionalOpenSignals(s, "LONG")).toEqual([]);
  });

  it("opens only longs when the bullish score pack dominates a neutral regime", () => {
    const s = snapshot("Neutral recovery", [
      candidate("ETHUSDT", "LONG", 93),
      candidate("SOLUSDT", "LONG", 90),
      candidate("LINKUSDT", "LONG", 86),
      candidate("XRPUSDT", "SHORT", 78),
      candidate("NEARUSDT", "SHORT", 77),
      candidate("DOGEUSDT", "SHORT", 76),
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("BULL_LONG_3");
    expect(crossSectionalDirectionalOpenSignals(s, "LONG")).toHaveLength(3);
    expect(crossSectionalDirectionalOpenSignals(s, "SHORT")).toEqual([]);
  });

  it("keeps the existing 3x3 basket path only when both qualified packs are balanced", () => {
    const s = snapshot("Mixed rotation", [
      candidate("ETHUSDT", "LONG", 85),
      candidate("SOLUSDT", "LONG", 83),
      candidate("LINKUSDT", "LONG", 81),
      candidate("XRPUSDT", "SHORT", 84),
      candidate("NEARUSDT", "SHORT", 82),
      candidate("DOGEUSDT", "SHORT", 80),
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("BALANCED_3X3");
    expect(crossSectionalDirectionalOpenSignals(s, "LONG")).toEqual([]);
    expect(crossSectionalDirectionalOpenSignals(s, "SHORT")).toEqual([]);
  });

  it("opens only the one fully qualified pick in an explicit regime", () => {
    const s = snapshot("Bullish continuation", [
      candidate("ETHUSDT", "LONG", 92),
      { ...candidate("SOLUSDT", "LONG", 91), confidence: 60 },
      candidate("XRPUSDT", "SHORT", 94),
      candidate("NEARUSDT", "SHORT", 90),
      candidate("DOGEUSDT", "SHORT", 89),
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("BULL_LONG_3");
    expect(decision.longPicks.map((pick) => pick.symbol)).toEqual(["ETHUSDT"]);
    expect(crossSectionalDirectionalOpenSignals(s, "LONG")).toHaveLength(1);
  });

  it("does not execute a scanner-led WAIT candidate with direction conflict", () => {
    const s = snapshot("Bullish expansion", [
      { ...candidate("ETHUSDT", "LONG", 92), finalStatus: "WAIT", status: "WAIT", directionConflict: true },
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("NO_TRADE");
    expect(decision.longPicks).toEqual([]);
  });

  it("does not execute a scanner-led WAIT candidate routed for data collection", () => {
    const s = snapshot("Bullish expansion", [
      {
        ...candidate("ETHUSDT", "LONG", 92),
        finalStatus: "WAIT",
        status: "WAIT",
        selectedExecutionPlan: { routeMode: "DATA_COLLECTION", primaryProfitEligible: false },
      },
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("NO_TRADE");
    expect(decision.longPicks).toEqual([]);
  });

  it("permits a clean profit-routable scanner-led WAIT candidate in an explicit regime", () => {
    const s = snapshot("Bullish expansion", [
      { ...candidate("ETHUSDT", "LONG", 92), finalStatus: "WAIT", status: "WAIT" },
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("BULL_LONG_3");
    expect(decision.longPicks.map((pick) => pick.symbol)).toEqual(["ETHUSDT"]);
  });

  it("sizes a scanner-led short down to two slots when canonical is MIXED", () => {
    const s = snapshot("Bearish pressure", [
      candidate("XRPUSDT", "SHORT", 91),
      candidate("NEARUSDT", "SHORT", 86),
      candidate("BTCUSDT", "SHORT", 84),
    ]);
    const raw = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(raw.mode).toBe("BEAR_SHORT_3");
    const confirmed = confirmCrossSectionalDirectionalRegime(raw, {
      allowed: true,
      requireRetest: false,
      regimeFamily: "MIXED",
      reason: null,
    });
    expect(confirmed.mode).toBe("BEAR_SHORT_3");
    expect(confirmed.shortPicks.map((pick) => pick.symbol)).toEqual(["XRPUSDT", "NEARUSDT"]);
    expect(crossSectionalDirectionalOpenSignals(s, "SHORT", confirmed).map((signal) => signal.symbol)).toEqual(["XRPUSDT", "NEARUSDT"]);
  });

  it("still vetoes a short when canonical is explicitly bullish", () => {
    const s = snapshot("Bearish pressure", [
      candidate("XRPUSDT", "SHORT", 91),
      candidate("NEARUSDT", "SHORT", 86),
      candidate("BTCUSDT", "SHORT", 84),
    ]);
    const raw = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(confirmCrossSectionalDirectionalRegime(raw, {
      allowed: true,
      requireRetest: false,
      regimeFamily: "BULLISH",
      reason: null,
    }).mode).toBe("NO_TRADE");
  });
});

describe("directional reversal confirmation", () => {
  const nowMs = Date.parse("2026-08-14T04:00:00.000Z");

  it("does not close a short just because two fresh scans say NO_TRADE", () => {
    const first = evaluateDirectionalReversal(null, "BEAR_SHORT_3", {
      mode: "NO_TRADE",
      scanBatchId: "scan-no-trade-1",
    }, nowMs);
    const second = evaluateDirectionalReversal(first.next, "BEAR_SHORT_3", {
      mode: "NO_TRADE",
      scanBatchId: "scan-no-trade-2",
    }, nowMs + 60_000);

    expect(first.shouldExit).toBe(false);
    expect(second.shouldExit).toBe(false);
    expect(second.next.invalidatingScanCount).toBe(0);
  });

  it("does not treat a balanced 3x3 decision as an opposite directional reversal", () => {
    const result = evaluateDirectionalReversal(null, "BULL_LONG_3", {
      mode: "BALANCED_3X3",
      scanBatchId: "scan-balanced",
    }, nowMs);

    expect(result.shouldExit).toBe(false);
    expect(result.next.invalidatingScanCount).toBe(0);
  });

  it("requires two distinct consecutive opposite-direction scans before closing", () => {
    const first = evaluateDirectionalReversal(null, "BEAR_SHORT_3", {
      mode: "BULL_LONG_3",
      scanBatchId: "scan-bull-1",
    }, nowMs);
    const repeat = evaluateDirectionalReversal(first.next, "BEAR_SHORT_3", {
      mode: "BULL_LONG_3",
      scanBatchId: "scan-bull-1",
    }, nowMs + 30_000);
    const confirmed = evaluateDirectionalReversal(repeat.next, "BEAR_SHORT_3", {
      mode: "BULL_LONG_3",
      scanBatchId: "scan-bull-2",
    }, nowMs + 60_000);

    expect(first.shouldExit).toBe(false);
    expect(repeat.shouldExit).toBe(false);
    expect(confirmed.shouldExit).toBe(true);
    expect(confirmed.reason).toBe("DIRECTIONAL_REVERSAL_CONFIRMED:BULL_LONG_3");
  });
});

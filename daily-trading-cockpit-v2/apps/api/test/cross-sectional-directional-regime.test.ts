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

  it("fails closed when an explicit regime lacks three fully qualified picks", () => {
    const s = snapshot("Bullish continuation", [
      candidate("ETHUSDT", "LONG", 92),
      { ...candidate("SOLUSDT", "LONG", 91), confidence: 60 },
      candidate("XRPUSDT", "SHORT", 94),
      candidate("NEARUSDT", "SHORT", 90),
      candidate("DOGEUSDT", "SHORT", 89),
    ]);
    expect(buildCrossSectionalDirectionalRegimeDecision(s).mode).toBe("NO_TRADE");
  });

  it("does not short when the independent canonical regime disagrees", () => {
    const s = snapshot("Bearish pressure", [
      candidate("XRPUSDT", "SHORT", 91),
      candidate("NEARUSDT", "SHORT", 86),
      candidate("BTCUSDT", "SHORT", 84),
    ]);
    const raw = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(raw.mode).toBe("BEAR_SHORT_3");
    expect(confirmCrossSectionalDirectionalRegime(raw, {
      allowed: true,
      requireRetest: false,
      regimeFamily: "MIXED",
      reason: null,
    }).mode).toBe("NO_TRADE");
  });

  it("requires two distinct invalidating scans before closing a directional position", () => {
    const active = { mode: "BEAR_SHORT_3", scanBatchId: "scan-1" } as const;
    const invalid1 = { mode: "NO_TRADE", scanBatchId: "scan-2" } as const;
    const invalid2 = { mode: "BULL_LONG_3", scanBatchId: "scan-3" } as const;
    const first = evaluateDirectionalReversal(null, "BEAR_SHORT_3", active, 1_000);
    const second = evaluateDirectionalReversal(first.next, "BEAR_SHORT_3", invalid1, 2_000);
    const repeated = evaluateDirectionalReversal(second.next, "BEAR_SHORT_3", invalid1, 3_000);
    const confirmed = evaluateDirectionalReversal(repeated.next, "BEAR_SHORT_3", invalid2, 4_000);
    expect(second.shouldExit).toBe(false);
    expect(repeated.shouldExit).toBe(false);
    expect(confirmed).toMatchObject({ shouldExit: true, reason: "DIRECTIONAL_REVERSAL_CONFIRMED:BULL_LONG_3" });
  });
});

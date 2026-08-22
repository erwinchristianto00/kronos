import type { Candidate } from "@dtc/shared";
import { describe, expect, it } from "vitest";
import {
  DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS,
  buildCrossSectionalDirectionalRegimeDecision,
  confirmCrossSectionalDirectionalRegime,
  crossSectionalDirectionalOpenSignals,
  evaluateDirectionalReversal,
  isCrossSectionalDirectionalRegimeExecEnabled,
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-18 MERGE NOTE — the five cases below asserted the OPPOSITE before the
// merge with research/phase3a-residual-generator, and were flipped on purpose.
//
// The two branches encoded two coherent, incompatible designs for this lane:
//   this branch  — neutral/partial evidence means "trade smaller, keep holding"
//   phase3a      — neutral/partial evidence means "do not open, and get out"
//
// phase3a won on evidence, not on seniority. Its reversal rule is the only one
// with field data: DIRECTIONAL_REVERSAL_CONFIRMED:NO_TRADE appears in 9 real
// testnet closes, and that string can only be produced by its variant — the
// variant here had never executed once. It is also uniformly the safer side, and
// a mode literally named BEAR_SHORT_3 / BULL_LONG_3 opening on a single pick made
// its own name false. The lane's measured edge is t=0.71 on 13 independent
// episodes, i.e. indistinguishable from zero, so the conservative reading costs
// nothing it can be shown to earn.
//
// To restore the old design: revert the three functions in
// cross-sectional-directional-regime.ts and flip these five back.
// ─────────────────────────────────────────────────────────────────────────────
describe("cross-sectional directional regime selector", () => {
  it("treats 0, 1, and 2 directional slots as a hard-disabled state", () => {
    expect(DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS({} as NodeJS.ProcessEnv)).toBe(0);
    expect(DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS({ CROSS_SECTIONAL_DIRECTIONAL_MAX_OPEN_POSITIONS: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS({ CROSS_SECTIONAL_DIRECTIONAL_MAX_OPEN_POSITIONS: "1" } as NodeJS.ProcessEnv)).toBe(0);
    expect(DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS({ CROSS_SECTIONAL_DIRECTIONAL_MAX_OPEN_POSITIONS: "2" } as NodeJS.ProcessEnv)).toBe(0);
    expect(DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS({ CROSS_SECTIONAL_DIRECTIONAL_MAX_OPEN_POSITIONS: "3" } as NodeJS.ProcessEnv)).toBe(3);
    expect(DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS({ CROSS_SECTIONAL_DIRECTIONAL_MAX_OPEN_POSITIONS: "9" } as NodeJS.ProcessEnv)).toBe(3);
  });

  it("requires an explicit mainnet opt-in after the exact-three gate passes", () => {
    const shared = {
      CROSS_SECTIONAL_DIRECTIONAL_REGIME_EXEC_ENABLED: "1",
      CROSS_SECTIONAL_DIRECTIONAL_MAX_OPEN_POSITIONS: "3",
    } as NodeJS.ProcessEnv;
    expect(isCrossSectionalDirectionalRegimeExecEnabled({ ...shared, LIVE_BINANCE_ENV: "testnet" })).toBe(true);
    expect(isCrossSectionalDirectionalRegimeExecEnabled({ ...shared, LIVE_BINANCE_ENV: "mainnet" })).toBe(false);
    expect(isCrossSectionalDirectionalRegimeExecEnabled({
      ...shared,
      LIVE_BINANCE_ENV: "mainnet",
      CROSS_SECTIONAL_DIRECTIONAL_REGIME_MAINNET_ENABLED: "1",
    })).toBe(true);
  });

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

  it("fails closed in an explicit regime that cannot field three qualified picks", () => {
    const s = snapshot("Bullish continuation", [
      candidate("ETHUSDT", "LONG", 92),
      { ...candidate("SOLUSDT", "LONG", 91), confidence: 60 },
      candidate("XRPUSDT", "SHORT", 94),
      candidate("NEARUSDT", "SHORT", 90),
      candidate("DOGEUSDT", "SHORT", 89),
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("NO_TRADE");
    expect(decision.longPicks.length).toBeLessThan(3);
    expect(crossSectionalDirectionalOpenSignals(s, "LONG")).toHaveLength(0);
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

  it("still fails closed when only a scanner-led WAIT candidate qualifies", () => {
    const s = snapshot("Bullish expansion", [
      { ...candidate("ETHUSDT", "LONG", 92), finalStatus: "WAIT", status: "WAIT" },
    ]);
    const decision = buildCrossSectionalDirectionalRegimeDecision(s);
    expect(decision.mode).toBe("NO_TRADE");
    expect(decision.longPicks.length).toBeLessThan(3);
  });

  it("refuses the short outright when canonical is MIXED, rather than sizing down", () => {
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
    expect(confirmed.mode).toBe("NO_TRADE");
    // picks are retained for display; MODE is what gates execution.
      expect(confirmed.shortPicks.length).toBe(3);
    expect(crossSectionalDirectionalOpenSignals(s, "SHORT", confirmed)).toHaveLength(0);
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

  it("closes a short after two distinct scans stop confirming it, NO_TRADE included", () => {
    const first = evaluateDirectionalReversal(null, "BEAR_SHORT_3", {
      mode: "NO_TRADE",
      scanBatchId: "scan-no-trade-1",
    }, nowMs);
    const second = evaluateDirectionalReversal(first.next, "BEAR_SHORT_3", {
      mode: "NO_TRADE",
      scanBatchId: "scan-no-trade-2",
    }, nowMs + 60_000);

    expect(first.shouldExit).toBe(false);
    expect(second.shouldExit).toBe(true);
    expect(second.next.invalidatingScanCount).toBe(2);
  });

  it("counts a balanced 3x3 decision as one invalidating scan", () => {
    const result = evaluateDirectionalReversal(null, "BULL_LONG_3", {
      mode: "BALANCED_3X3",
      scanBatchId: "scan-balanced",
    }, nowMs);

    expect(result.shouldExit).toBe(false);
    expect(result.next.invalidatingScanCount).toBe(1);
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

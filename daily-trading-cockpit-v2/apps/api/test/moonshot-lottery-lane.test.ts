import { describe, it, expect } from "vitest";
import {
  computeMoonshotScore,
  computeMoonshotRiskScore,
  selectMoonshotLeverage,
  evaluateMoonshot,
  emptyMoonshotDailyState,
  MOONSHOT_MAX_TRADES_PER_DAY,
  type MoonshotFeatures,
  type MoonshotDailyState,
} from "../src/lib/moonshot-lottery-lane.js";

// A clean, high-conviction burst: passes the universal gate at the ~50x tier (score 90–93).
function goodFeatures(over: Partial<MoonshotFeatures> = {}): MoonshotFeatures {
  return {
    symbol: "WIFUSDT",
    priceChange1mPct: 2.2,
    priceChange3mPct: 2.6,
    priceChange5mPct: 3.0, // not over-pumped
    volumeRatio1m: 7.5,
    takerBuySellRatio: 2.4,
    oiDelta3mPct: 3.7,
    fundingRate: 0.0003,
    spreadBps: 3,
    depth05PctUsd: 60_000,
    depth1PctUsd: 90_000,
    btc1mPct: 0.1, // BTC calm/up
    markVsLastDivergenceBps: 4,
    minNotionalUsd: 5,
    maxLeverage: 75,
    ...over,
  };
}
// A textbook sniper: score >= 97, risk <= 20, very tight + deep + strong flow.
function sniperFeatures(over: Partial<MoonshotFeatures> = {}): MoonshotFeatures {
  return goodFeatures({
    priceChange1mPct: 2.4,
    priceChange3mPct: 3.0,
    priceChange5mPct: 3.4,
    volumeRatio1m: 9,
    takerBuySellRatio: 2.4,
    oiDelta3mPct: 4.5,
    spreadBps: 1.5,
    depth05PctUsd: 120_000,
    depth1PctUsd: 200_000,
    markVsLastDivergenceBps: 2,
    maxLeverage: 125,
    ...over,
  });
}
const daily = (over: Partial<MoonshotDailyState> = {}): MoonshotDailyState => ({ ...emptyMoonshotDailyState("2099-01-02"), ...over });

describe("moonshot-lottery-lane — sniper slot machine with a seatbelt", () => {
  it("[SCORE] a strong burst scores high, a dead tape scores low", () => {
    expect(computeMoonshotScore(goodFeatures()).score).toBeGreaterThanOrEqual(82);
    const flat = computeMoonshotScore(goodFeatures({ volumeRatio1m: 1, takerBuySellRatio: 1, oiDelta3mPct: 0, priceChange1mPct: 0, priceChange3mPct: 0, priceChange5mPct: 0 }));
    expect(flat.score).toBeLessThan(82);
  });

  it("[LEVERAGE-TIERS] maps score → tiered leverage per spec", () => {
    expect(selectMoonshotLeverage(83, 125).finalLeverage).toBe(20);
    expect(selectMoonshotLeverage(87, 125).finalLeverage).toBe(35);
    expect(selectMoonshotLeverage(91, 125).finalLeverage).toBe(50);
    expect(selectMoonshotLeverage(95, 125).finalLeverage).toBe(75);
    expect(selectMoonshotLeverage(98, 125).finalLeverage).toBe(100);
    expect(selectMoonshotLeverage(70, 125).tier).toBeNull(); // below the lane minimum
  });

  it("[SYMBOL-CAP] final leverage = min(requested, Binance symbol max)", () => {
    const r = selectMoonshotLeverage(98, 25); // wants 100x, symbol caps 25
    expect(r.requestedLeverage).toBe(100);
    expect(r.finalLeverage).toBe(25);
    expect(r.cappedBySymbol).toBe(true);
  });

  it("[CONTRACT] a passing signal is LONG / 1 USDT / ISOLATED / LIMIT_IOC with a tp plan", () => {
    const e = evaluateMoonshot(goodFeatures(), daily());
    expect(e.decision).toBe("SIGNAL");
    const s = e.signal!;
    expect(s.lane).toBe("MOONSHOT_LOTTERY");
    expect(s.side).toBe("LONG");
    expect(s.marginUsdt).toBe(1);
    expect(s.marginMode).toBe("ISOLATED");
    expect(s.entryPolicy.type).toBe("LIMIT_IOC");
    expect([20, 35, 50, 75]).toContain(s.finalLeverage); // a valid non-sniper tier
    expect(s.maxHoldSeconds).toBe(90); // non-sniper hold
    expect(s.tpPlan.tp1Roe).toBe(100); // non-sniper tp plan
    expect(s.reason.length).toBeGreaterThan(0);
  });

  it("[GATE-SCORE/RISK] rejects below score floor or above risk ceiling", () => {
    expect(evaluateMoonshot(goodFeatures({ volumeRatio1m: 1, takerBuySellRatio: 1, oiDelta3mPct: 0, priceChange1mPct: 0.1 }), daily()).decision).toBe("REJECT");
    // jack risk via thin depth + wide-ish spread + extreme funding
    const risky = evaluateMoonshot(goodFeatures({ depth05PctUsd: 5_000, depth1PctUsd: 6_000, fundingRate: 0.004 }), daily());
    expect(risky.decision).toBe("REJECT");
    expect(risky.rejectReasons.join(" ")).toMatch(/risk|depth/i);
  });

  it("[GATE-BUDGET] enforces 1 active position, 10 trades/day, 10 USDT daily loss", () => {
    expect(evaluateMoonshot(goodFeatures(), daily({ activePositions: 1 })).rejectReasons).toContain("existing moonshot position open");
    expect(evaluateMoonshot(goodFeatures(), daily({ tradesToday: MOONSHOT_MAX_TRADES_PER_DAY })).decision).toBe("REJECT");
    expect(evaluateMoonshot(goodFeatures(), daily({ dailyRealizedLossUsdt: 10 })).decision).toBe("REJECT");
  });

  it("[GATE-BTC/MARK] rejects when BTC is dumping or mark diverges dangerously", () => {
    expect(evaluateMoonshot(goodFeatures({ btc1mPct: -0.6 }), daily()).rejectReasons).toContain("BTC dumping");
    expect(evaluateMoonshot(goodFeatures({ markVsLastDivergenceBps: 40 }), daily()).rejectReasons).toContain("mark price divergence dangerous");
  });

  it("[GATE-MINNOTIONAL] rejects when 1 USDT margin × final leverage can't clear minNotional", () => {
    // score→50x, margin 1 → notional 50; minNotional 100 → reject
    const e = evaluateMoonshot(goodFeatures({ minNotionalUsd: 100 }), daily());
    expect(e.decision).toBe("REJECT");
    expect(e.rejectReasons.join(" ")).toMatch(/minNotional/);
  });

  it("[SNIPER] 100x requires the stricter gate and the 2/day cap", () => {
    const ok = evaluateMoonshot(sniperFeatures(), daily());
    expect(ok.isSniper).toBe(true);
    expect(ok.decision).toBe("SIGNAL");
    expect(ok.signal!.finalLeverage).toBe(100);
    expect(ok.signal!.maxHoldSeconds).toBe(45);
    expect(ok.signal!.tpPlan.tp1Roe).toBe(90);
    // 2/day cap on 100x
    expect(evaluateMoonshot(sniperFeatures(), daily({ trades100xToday: 2 })).decision).toBe("REJECT");
    // a sniper-score burst but with a loose spread fails the sniper sub-gate
    expect(evaluateMoonshot(sniperFeatures({ spreadBps: 5 }), daily()).rejectReasons.join(" ")).toMatch(/sniper/i);
  });

  it("[RISK-OI-TRAP] OI spiking with no price/volume follow-through reads as risky", () => {
    const trap = computeMoonshotRiskScore(goodFeatures({ oiDelta3mPct: 7, priceChange3mPct: 0.2, volumeRatio1m: 1.5 }));
    expect(trap.components.oiSpikeNoFollowThrough).toBeGreaterThan(5);
  });
});

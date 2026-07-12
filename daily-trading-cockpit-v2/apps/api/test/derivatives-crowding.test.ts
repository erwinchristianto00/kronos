import { describe, it, expect } from "vitest";
import {
  classifyCrowding,
  classifyOiTrend,
  classifyCrowdingState,
  classifyCrowdingStateWithFlow,
  isCrowdedAgainstFreshEntry,
  summarizeCrowding,
  fetchCrowdingSnapshot,
  type CrowdingSnapshot,
  type CrowdingLevel,
  type OiTrend,
} from "../src/lib/derivatives-crowding.js";

const snap = (over: Partial<CrowdingSnapshot>): CrowdingSnapshot => ({
  symbol: "X",
  fundingRate: 0,
  fundingBps: 0,
  oiChangePercent: 0,
  oiTrend: "FLAT",
  takerBuySellRatio: 1,
  longShortRatio: 1,
  crowdSide: "NEUTRAL",
  crowdingLevel: "NEUTRAL",
  crowdingState: "NEUTRAL",
  flowConfirmed: null,
  fetchedAt: "t",
  ...over,
});

describe("derivatives-crowding", () => {
  it("[CLASSIFY] funding sign → crowd side, magnitude → level", () => {
    expect(classifyCrowding(0.0001)).toEqual({ crowdSide: "NEUTRAL", crowdingLevel: "NEUTRAL" });
    expect(classifyCrowding(0.0003)).toEqual({ crowdSide: "LONG", crowdingLevel: "ELEVATED" });
    expect(classifyCrowding(-0.0004)).toEqual({ crowdSide: "SHORT", crowdingLevel: "ELEVATED" });
    expect(classifyCrowding(0.0008)).toEqual({ crowdSide: "LONG", crowdingLevel: "EXTREME" });
    expect(classifyCrowding(null)).toEqual({ crowdSide: "NEUTRAL", crowdingLevel: "NEUTRAL" });
  });

  it("[OI-TREND] OI change % → rising/falling/flat", () => {
    expect(classifyOiTrend(2.5)).toBe("RISING");
    expect(classifyOiTrend(-1.2)).toBe("FALLING");
    expect(classifyOiTrend(0.3)).toBe("FLAT");
    expect(classifyOiTrend(null)).toBe("FLAT");
  });

  it("[STATE] combines crowding level × OI trend", () => {
    // OI falling ⇒ unwinding (flush) — regardless of funding level
    expect(classifyCrowdingState("EXTREME", "FALLING")).toBe("UNWINDING");
    expect(classifyCrowdingState("NEUTRAL", "FALLING")).toBe("UNWINDING");
    // extreme funding + OI still building ⇒ exhausting (exit territory)
    expect(classifyCrowdingState("EXTREME", "RISING")).toBe("EXHAUSTING");
    // elevated + building ⇒ healthy continuation
    expect(classifyCrowdingState("ELEVATED", "RISING")).toBe("BUILDING");
    // nothing notable ⇒ neutral
    expect(classifyCrowdingState("NEUTRAL", "FLAT")).toBe("NEUTRAL");
    expect(classifyCrowdingState("ELEVATED", "FLAT")).toBe("NEUTRAL");
  });

  it("[VETO] flags a fresh entry into a crowd already EXTREME on that side", () => {
    const longExtreme = snap({ crowdSide: "LONG", crowdingLevel: "EXTREME" });
    expect(isCrowdedAgainstFreshEntry(longExtreme, "LONG")).toBe(true); // adding to exhausted long crowd
    expect(isCrowdedAgainstFreshEntry(longExtreme, "SHORT")).toBe(false); // shorting INTO it = the fade
  });

  it("[SUMMARY] counts crowding states + extremes", () => {
    const s = summarizeCrowding([
      snap({ crowdingState: "BUILDING" }),
      snap({ crowdingState: "EXHAUSTING", crowdingLevel: "EXTREME" }),
      snap({ crowdingState: "UNWINDING" }),
      snap({ crowdingState: "NEUTRAL" }),
    ]);
    expect(s).toEqual({ building: 1, exhausting: 1, unwinding: 1, neutral: 1, extreme: 1 });
  });

  // ---------------------------------------------------------------------------------------------
  // Tier-1 audit item 1 (2026-07-10): taker-flow confirmation. classifyCrowdingState() itself must
  // stay byte-identical for every existing caller — this is the regression proof.
  // ---------------------------------------------------------------------------------------------
  it("[REGRESSION] classifyCrowdingState() output is unchanged across the full (level × oiTrend) matrix", () => {
    const levels: CrowdingLevel[] = ["NEUTRAL", "ELEVATED", "EXTREME"];
    const oiTrends: OiTrend[] = ["RISING", "FALLING", "FLAT"];
    // Locked-in expectations captured from the pre-change implementation. If this matrix ever
    // fails, classifyCrowdingState()'s behavior has drifted for an input some live caller depends
    // on (short-fade-edge.ts, panic-washout-reclaim-edge.ts, regime-composite-edge.ts,
    // live-execution-engine.ts's crowdingExitRecommendation + entry veto).
    const expected: Record<string, string> = {
      "NEUTRAL,RISING": "NEUTRAL",
      "NEUTRAL,FALLING": "UNWINDING",
      "NEUTRAL,FLAT": "NEUTRAL",
      "ELEVATED,RISING": "BUILDING",
      "ELEVATED,FALLING": "UNWINDING",
      "ELEVATED,FLAT": "NEUTRAL",
      "EXTREME,RISING": "EXHAUSTING",
      "EXTREME,FALLING": "UNWINDING",
      "EXTREME,FLAT": "NEUTRAL",
    };
    for (const level of levels) {
      for (const oiTrend of oiTrends) {
        expect(classifyCrowdingState(level, oiTrend)).toBe(expected[`${level},${oiTrend}`]);
      }
    }
  });

  it("[REGRESSION] classifyCrowdingStateWithFlow's crowdingState matches classifyCrowdingState() exactly for every input, regardless of taker flow", () => {
    const levels: CrowdingLevel[] = ["NEUTRAL", "ELEVATED", "EXTREME"];
    const oiTrends: OiTrend[] = ["RISING", "FALLING", "FLAT"];
    const ratios: Array<number | null | undefined> = [0.4, 1, 2.5, null, undefined, NaN];
    for (const level of levels) {
      for (const oiTrend of oiTrends) {
        const want = classifyCrowdingState(level, oiTrend);
        for (const crowdSide of ["LONG", "SHORT", "NEUTRAL"] as const) {
          for (const ratio of ratios) {
            const { crowdingState } = classifyCrowdingStateWithFlow(level, oiTrend, crowdSide, ratio);
            expect(crowdingState).toBe(want);
          }
        }
      }
    }
  });

  it("[FLOW] BUILDING + LONG crowd: confirmed when taker buy volume dominates, not when sell dominates", () => {
    expect(classifyCrowdingStateWithFlow("ELEVATED", "RISING", "LONG", 1.8).flowConfirmed).toBe(true);
    expect(classifyCrowdingStateWithFlow("ELEVATED", "RISING", "LONG", 0.6).flowConfirmed).toBe(false);
  });

  it("[FLOW] BUILDING + SHORT crowd: confirmed when taker sell volume dominates, not when buy dominates", () => {
    expect(classifyCrowdingStateWithFlow("ELEVATED", "RISING", "SHORT", 0.6).flowConfirmed).toBe(true);
    expect(classifyCrowdingStateWithFlow("ELEVATED", "RISING", "SHORT", 1.8).flowConfirmed).toBe(false);
  });

  it("[FLOW] UNWINDING + LONG crowd (longs closing/liquidated): confirmed by sell-dominant flow, not buy-dominant", () => {
    expect(classifyCrowdingStateWithFlow("EXTREME", "FALLING", "LONG", 0.5).flowConfirmed).toBe(true);
    expect(classifyCrowdingStateWithFlow("EXTREME", "FALLING", "LONG", 1.5).flowConfirmed).toBe(false);
  });

  it("[FLOW] UNWINDING + SHORT crowd (shorts covering): confirmed by buy-dominant flow, not sell-dominant", () => {
    expect(classifyCrowdingStateWithFlow("EXTREME", "FALLING", "SHORT", 1.5).flowConfirmed).toBe(true);
    expect(classifyCrowdingStateWithFlow("EXTREME", "FALLING", "SHORT", 0.5).flowConfirmed).toBe(false);
  });

  it("[FLOW edge] UNWINDING with a NEUTRAL crowd side (no prior crowd to check the flush against) stays null", () => {
    expect(classifyCrowdingStateWithFlow("NEUTRAL", "FALLING", "NEUTRAL", 1.8).flowConfirmed).toBeNull();
    expect(classifyCrowdingStateWithFlow("NEUTRAL", "FALLING", "NEUTRAL", 0.4).flowConfirmed).toBeNull();
  });

  it("[FLOW edge] EXHAUSTING and NEUTRAL crowdingState have no directional rule ⇒ always null", () => {
    expect(classifyCrowdingStateWithFlow("EXTREME", "RISING", "LONG", 2).flowConfirmed).toBeNull();
    expect(classifyCrowdingStateWithFlow("EXTREME", "RISING", "SHORT", 0.3).flowConfirmed).toBeNull();
    expect(classifyCrowdingStateWithFlow("NEUTRAL", "FLAT", "NEUTRAL", 2).flowConfirmed).toBeNull();
    expect(classifyCrowdingStateWithFlow("ELEVATED", "FLAT", "LONG", 2).flowConfirmed).toBeNull();
  });

  it("[FLOW edge] balanced taker flow (ratio === 1) does not count as dominant in either direction", () => {
    expect(classifyCrowdingStateWithFlow("ELEVATED", "RISING", "LONG", 1).flowConfirmed).toBe(false);
    expect(classifyCrowdingStateWithFlow("ELEVATED", "RISING", "SHORT", 1).flowConfirmed).toBe(false);
    expect(classifyCrowdingStateWithFlow("EXTREME", "FALLING", "LONG", 1).flowConfirmed).toBe(false);
  });

  it("[FLOW edge] missing/invalid takerBuySellRatio fails open to null, never throws", () => {
    expect(() => classifyCrowdingStateWithFlow("ELEVATED", "RISING", "LONG", null)).not.toThrow();
    expect(classifyCrowdingStateWithFlow("ELEVATED", "RISING", "LONG", null).flowConfirmed).toBeNull();
    expect(classifyCrowdingStateWithFlow("ELEVATED", "RISING", "LONG", undefined).flowConfirmed).toBeNull();
    expect(classifyCrowdingStateWithFlow("EXTREME", "FALLING", "SHORT", Number.NaN).flowConfirmed).toBeNull();
    expect(classifyCrowdingStateWithFlow("EXTREME", "FALLING", "SHORT", Number.POSITIVE_INFINITY).flowConfirmed).toBeNull();
  });

  it("[SNAPSHOT] fetchCrowdingSnapshot wires flowConfirmed through end-to-end (BUILDING + LONG crowd + dominant taker buy)", async () => {
    // fundingRate 0.0003 → 3bps → ELEVATED, LONG crowd; oiChangePercent 2 → RISING ⇒ BUILDING.
    const client = { getFuturesFlow: async () => ({ fundingRate: 0.0003, openInterestChangePercent: 2, takerBuySellRatio: 1.9, longShortRatio: 1.2 }) };
    const s = await fetchCrowdingSnapshot(client, "TESTUSDT", "2026-07-10T00:00:00.000Z");
    expect(s.crowdingState).toBe("BUILDING");
    expect(s.crowdSide).toBe("LONG");
    expect(s.flowConfirmed).toBe(true);
  });

  it("[SNAPSHOT] fetchCrowdingSnapshot: BUILDING + LONG crowd + taker-sell-dominant ⇒ flowConfirmed false", async () => {
    const client = { getFuturesFlow: async () => ({ fundingRate: 0.0003, openInterestChangePercent: 2, takerBuySellRatio: 0.4, longShortRatio: 1.2 }) };
    const s = await fetchCrowdingSnapshot(client, "TESTUSDT", "2026-07-10T00:00:00.000Z");
    expect(s.crowdingState).toBe("BUILDING");
    expect(s.crowdSide).toBe("LONG");
    expect(s.flowConfirmed).toBe(false);
  });

  it("[SNAPSHOT edge] fetchCrowdingSnapshot: Binance fetch failure ⇒ nulls throughout, flowConfirmed null, never throws", async () => {
    const client = { getFuturesFlow: async () => { throw new Error("network blip"); } };
    const s = await fetchCrowdingSnapshot(client, "TESTUSDT", "2026-07-10T00:00:00.000Z");
    expect(s.crowdingState).toBe("NEUTRAL");
    expect(s.takerBuySellRatio).toBeNull();
    expect(s.flowConfirmed).toBeNull();
  });

  it("[SNAPSHOT edge] fetchCrowdingSnapshot: taker ratio null but funding/OI still BUILDING ⇒ flowConfirmed null (not false, not thrown)", async () => {
    const client = { getFuturesFlow: async () => ({ fundingRate: 0.0003, openInterestChangePercent: 2, takerBuySellRatio: null, longShortRatio: null }) };
    const s = await fetchCrowdingSnapshot(client, "TESTUSDT", "2026-07-10T00:00:00.000Z");
    expect(s.crowdingState).toBe("BUILDING");
    expect(s.flowConfirmed).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  classifyCrowding,
  classifyOiTrend,
  classifyCrowdingState,
  isCrowdedAgainstFreshEntry,
  summarizeCrowding,
  type CrowdingSnapshot,
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
});

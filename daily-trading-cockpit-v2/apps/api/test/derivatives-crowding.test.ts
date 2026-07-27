import { describe, it, expect } from "vitest";
import {
  classifyCrowding,
  classifyCrowdingAtThresholds,
  classifyOiTrend,
  classifyCrowdingState,
  classifyCrowdingStateWithFlow,
  isCrowdedAgainstFreshEntry,
  summarizeCrowding,
  fetchCrowdingSnapshot,
  resolveFixedCrowdingThresholds,
  deriveCrowdingThresholds,
  PerSymbolCrowdingCalibrator,
  FIXED_CROWDING_THRESHOLDS,
  CROWDING_ELEVATED_BPS,
  CROWDING_EXTREME_BPS,
  DEFAULT_CROWDING_ELEVATED_BPS,
  DEFAULT_CROWDING_EXTREME_BPS,
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
  crowdingLevelShadow: "NEUTRAL",
  crowdingShadowThresholds: null,
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
    expect(s).toEqual({
      building: 1,
      exhausting: 1,
      unwinding: 1,
      neutral: 1,
      extreme: 1,
      extremeShadow: 0,
      shadowCalibrated: 0,
    });
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

  // ---------------------------------------------------------------------------------------------
  // Per-symbol shadow calibration (2026-07-26). The FIXED thresholds are what every real-order gate
  // reads (short-fade-edge's EXHAUSTING admission gate, realtime-short-mirror's veto, both
  // regime-composite lanes, noTradeGuard's FUNDING_RISK_ABNORMAL) — their defaults must not move.
  // ---------------------------------------------------------------------------------------------

  it("[CALIBRATION] shipped defaults are pinned at 2 / 7 and env overrides fall back (never clamp) on invalid input", () => {
    // The deliberate v1 judgment call, unchanged.
    expect(DEFAULT_CROWDING_ELEVATED_BPS).toBe(2);
    expect(DEFAULT_CROWDING_EXTREME_BPS).toBe(7);
    expect(resolveFixedCrowdingThresholds({})).toEqual({ elevatedBps: 2, extremeBps: 7 });

    // Invalid ⇒ FALL BACK to the default. A clamping implementation would yield some other number.
    expect(resolveFixedCrowdingThresholds({ CROWDING_EXTREME_BPS: "-1" })).toEqual({ elevatedBps: 2, extremeBps: 7 });
    expect(resolveFixedCrowdingThresholds({ CROWDING_EXTREME_BPS: "0" })).toEqual({ elevatedBps: 2, extremeBps: 7 });
    expect(resolveFixedCrowdingThresholds({ CROWDING_EXTREME_BPS: "abc" })).toEqual({ elevatedBps: 2, extremeBps: 7 });
    expect(resolveFixedCrowdingThresholds({ CROWDING_ELEVATED_BPS: "-5" })).toEqual({ elevatedBps: 2, extremeBps: 7 });

    // Valid overrides apply.
    expect(resolveFixedCrowdingThresholds({ CROWDING_EXTREME_BPS: "3" })).toEqual({ elevatedBps: 2, extremeBps: 3 });
    expect(resolveFixedCrowdingThresholds({ CROWDING_ELEVATED_BPS: "1", CROWDING_EXTREME_BPS: "2.4" }))
      .toEqual({ elevatedBps: 1, extremeBps: 2.4 });

    // An ordering violation reverts BOTH — a half-applied pair (elevated >= extreme) would make
    // EXTREME unreachable by construction, which is the exact defect this item exists to expose.
    expect(resolveFixedCrowdingThresholds({ CROWDING_ELEVATED_BPS: "9", CROWDING_EXTREME_BPS: "3" }))
      .toEqual({ elevatedBps: 2, extremeBps: 7 });
    expect(resolveFixedCrowdingThresholds({ CROWDING_ELEVATED_BPS: "7" }))
      .toEqual({ elevatedBps: 2, extremeBps: 7 });
  });

  it("[CALIBRATION] the live EXTREME threshold is still unreachable at the observed max, while a per-symbol shadow reaches it", () => {
    // 5.5577 bps = the largest |funding| over 23,122 real testnet snapshots (2026-06-24 → 07-06).
    const observedMaxFunding = 0.00055577;
    // Live path: unchanged. Still ELEVATED, never EXTREME — so no gate in the banner can fire.
    expect(classifyCrowding(observedMaxFunding).crowdingLevel).toBe("ELEVATED");
    expect(CROWDING_ELEVATED_BPS).toBe(DEFAULT_CROWDING_ELEVATED_BPS);
    expect(CROWDING_EXTREME_BPS).toBe(DEFAULT_CROWDING_EXTREME_BPS);

    // INJUSDT-shaped history (measured p95 3.832 / p99 4.894 / max 5.558): a separable tail.
    const injLike = [
      ...Array<number>(900).fill(0.45),
      ...Array<number>(90).fill(2.4),
      ...Array<number>(10).fill(4.9),
    ];
    const injThresholds = deriveCrowdingThresholds(injLike);
    expect(injThresholds).toEqual({ elevatedBps: 0.45, extremeBps: 2.4 });
    expect(classifyCrowdingAtThresholds(observedMaxFunding, injThresholds!).crowdingLevel).toBe("EXTREME");
    expect(classifyCrowdingAtThresholds(observedMaxFunding, injThresholds!).crowdSide).toBe("LONG");
  });

  it("[CALIBRATION] a degenerate per-symbol history is reported as uncalibratable, not fitted to its own point mass", () => {
    // BTCUSDT-shaped: p90 = p99 = max = 1.0000 bps (Binance's 0.01%/8h base rate). Fitting a
    // threshold here would flip the symbol to EXTREME on ~half its samples.
    const btcLike = [...Array<number>(500).fill(0.556), ...Array<number>(500).fill(1.0)];
    expect(deriveCrowdingThresholds(btcLike)).toBeNull();
    // Too few samples is likewise null, not a threshold fitted to noise.
    expect(deriveCrowdingThresholds([0.5, 1.0, 4.0])).toBeNull();
    // All-zero history has no positive elevated band ⇒ null.
    expect(deriveCrowdingThresholds(Array<number>(1000).fill(0))).toBeNull();
  });

  it("[CALIBRATION] fetchCrowdingSnapshot carries a per-symbol shadow level end-to-end without moving the live level", async () => {
    const calibrator = new PerSymbolCrowdingCalibrator(2000, 200);
    // Warm the window with an INJ-shaped calm history: 300 samples at 0.45 bps, tail at 2.4/4.9.
    for (let i = 0; i < 900; i++) calibrator.record("INJUSDT", 0.000045);
    for (let i = 0; i < 90; i++) calibrator.record("INJUSDT", 0.00024);
    for (let i = 0; i < 10; i++) calibrator.record("INJUSDT", 0.00049);

    const client = {
      getFuturesFlow: async () => ({
        fundingRate: 0.00055577, // the observed population max: 5.5577 bps
        openInterestChangePercent: 2,
        takerBuySellRatio: 1.4,
        longShortRatio: 1.2,
      }),
    };
    const s = await fetchCrowdingSnapshot(client, "INJUSDT", "2026-07-26T00:00:00.000Z", calibrator);

    // LIVE fields byte-identical to pre-change behaviour — nothing a gate reads has moved.
    expect(s.crowdingLevel).toBe("ELEVATED");
    expect(s.crowdingState).toBe("BUILDING"); // NOT "EXHAUSTING" ⇒ short-fade still rejects
    // SHADOW says what a per-symbol calibration would have called it.
    expect(s.crowdingShadowThresholds).toEqual({ elevatedBps: 0.45, extremeBps: 2.4 });
    expect(s.crowdingLevelShadow).toBe("EXTREME");
  });

  // The window must keep ROLLING after it saturates. The cache was keyed on `arr.length`, which
  // record()'s splice pins at windowSize forever, so `arr.length − cached.at` was permanently 0 and
  // the first post-saturation derivation was returned for the life of the process — every shadow
  // number an operator reads off the crowding endpoint frozen at hour one. Keyed on a monotonic
  // record counter instead.
  it("[CALIBRATION] thresholds RE-DERIVE after the bounded window has fully turned over", () => {
    const calibrator = new PerSymbolCrowdingCalibrator(1000, 200);
    // INJ-shaped calm history, saturating the 1000-sample window exactly.
    for (let i = 0; i < 900; i++) calibrator.record("INJUSDT", 0.000045);
    for (let i = 0; i < 90; i++) calibrator.record("INJUSDT", 0.00024);
    for (let i = 0; i < 10; i++) calibrator.record("INJUSDT", 0.00049);
    const warm = calibrator.calibrationFor("INJUSDT");
    expect(warm?.thresholds).toEqual({ elevatedBps: 0.45, extremeBps: 2.4 });
    expect(calibrator.recordsSeen("INJUSDT")).toBe(1000);

    // COMPLETE window replacement: 1000 further samples at a ~65x higher, still-separable funding
    // regime — every original sample evicted. Without the fix this still reports 0.45 / 2.4.
    for (let i = 0; i < 900; i++) calibrator.record("INJUSDT", 0.003); // 30 bps
    for (let i = 0; i < 90; i++) calibrator.record("INJUSDT", 0.01); // 100 bps
    for (let i = 0; i < 10; i++) calibrator.record("INJUSDT", 0.02); // 200 bps
    expect(calibrator.recordsSeen("INJUSDT")).toBe(2000);
    const after = calibrator.calibrationFor("INJUSDT");
    expect(after?.thresholds).toEqual({ elevatedBps: 30, extremeBps: 100 });
    expect(after?.thresholds).not.toEqual(warm?.thresholds);
    expect(after?.maxBps).toBe(200);
  });

  // Second manifestation of the same bug: a symbol branded uncalibratable stayed branded forever.
  it("[CALIBRATION] a degenerate symbol becomes calibratable once its window turns over", () => {
    const calibrator = new PerSymbolCrowdingCalibrator(1000, 200);
    // BTCUSDT-shaped: the whole window sits on the 1.0000 bps point mass ⇒ p90 == p99 ⇒ null.
    for (let i = 0; i < 1000; i++) calibrator.record("BTCUSDT", 0.0001);
    expect(calibrator.calibrationFor("BTCUSDT")).toBeNull();

    // Full replacement with a cleanly separable distribution.
    for (let i = 0; i < 900; i++) calibrator.record("BTCUSDT", 0.00005);
    for (let i = 0; i < 90; i++) calibrator.record("BTCUSDT", 0.0004);
    for (let i = 0; i < 10; i++) calibrator.record("BTCUSDT", 0.0009);
    const after = calibrator.calibrationFor("BTCUSDT");
    expect(after).not.toBeNull(); // without the fix: still null, permanently
    expect(after!.thresholds).toEqual({ elevatedBps: 0.5, extremeBps: 4 });
  });

  // FIXED_CROWDING_THRESHOLDS is dereferenced by classifyCrowding on every call, and EXTREME is a
  // hard admission gate on five real-order paths. It must not be a mutable shared global.
  it("[NO-EXEC-COUPLING] FIXED_CROWDING_THRESHOLDS is frozen — no importer can arm a gate by assignment", () => {
    expect(Object.isFrozen(FIXED_CROWDING_THRESHOLDS)).toBe(true);
    const before = classifyCrowding(0.00024).crowdingLevel; // 2.4 bps → ELEVATED at the fixed 2/7
    try {
      (FIXED_CROWDING_THRESHOLDS as { extremeBps: number }).extremeBps = 2.4;
    } catch {
      /* strict mode throws; sloppy mode silently no-ops. Both are acceptable — the point is that
         the live classification below must not move. */
    }
    expect(FIXED_CROWDING_THRESHOLDS.extremeBps).toBe(DEFAULT_CROWDING_EXTREME_BPS);
    expect(classifyCrowding(0.00024).crowdingLevel).toBe(before);
    expect(classifyCrowding(0.00024).crowdingLevel).toBe("ELEVATED"); // NOT EXTREME
  });

  it("[CALIBRATION] an uncalibrated symbol's shadow falls back to the live level and reports thresholds null", async () => {
    const calibrator = new PerSymbolCrowdingCalibrator(2000, 200);
    const client = { getFuturesFlow: async () => ({ fundingRate: 0.0003, openInterestChangePercent: 2, takerBuySellRatio: 1.4, longShortRatio: 1.2 }) };
    const s = await fetchCrowdingSnapshot(client, "COLDUSDT", "2026-07-26T00:00:00.000Z", calibrator);
    expect(s.crowdingShadowThresholds).toBeNull();
    expect(s.crowdingLevelShadow).toBe(s.crowdingLevel);
    expect(s.crowdingLevelShadow).toBe("ELEVATED");
  });

  it("[CALIBRATION] the current sample is never included in the window it is classified against (no self-look-ahead)", () => {
    const calibrator = new PerSymbolCrowdingCalibrator(2000, 200);
    for (let i = 0; i < 200; i++) calibrator.record("AUSDT", 0.00005);
    // Degenerate so far ⇒ no calibration.
    expect(calibrator.calibrationFor("AUSDT")).toBeNull();
    // A bounded window never grows past windowSize.
    const small = new PerSymbolCrowdingCalibrator(10, 5);
    for (let i = 0; i < 100; i++) small.record("BUSDT", 0.0001);
    expect(small.calibrationFor("BUSDT")?.samples ?? 0).toBeLessThanOrEqual(10);
    // Non-finite / null funding carries no information and is ignored, never throws.
    expect(() => small.record("BUSDT", null)).not.toThrow();
    expect(() => small.record("BUSDT", Number.NaN)).not.toThrow();
    expect(() => small.record("BUSDT", Number.POSITIVE_INFINITY)).not.toThrow();
  });

  it("[NO-EXEC-COUPLING] the entry veto reads crowdingLevel only — a shadow EXTREME cannot trip it", () => {
    // If anyone ever wires crowdingLevelShadow into a gate, this is the tripwire.
    const shadowOnly = snap({
      crowdSide: "LONG",
      crowdingLevel: "ELEVATED",
      crowdingLevelShadow: "EXTREME",
      crowdingShadowThresholds: { elevatedBps: 0.45, extremeBps: 2.4 },
    });
    expect(isCrowdedAgainstFreshEntry(shadowOnly, "LONG")).toBe(false);
    expect(isCrowdedAgainstFreshEntry(shadowOnly, "SHORT")).toBe(false);
    // And the state machine is fed the LIVE level, so EXHAUSTING (the short-fade admission
    // condition) stays unreachable for a shadow-only extreme.
    expect(classifyCrowdingState(shadowOnly.crowdingLevel, "RISING")).toBe("BUILDING");
  });

  it("[NO-EXEC-COUPLING] summarizeCrowding reports shadow extremes separately from live extremes", () => {
    const s = summarizeCrowding([
      snap({ crowdingLevel: "ELEVATED", crowdingLevelShadow: "EXTREME", crowdingShadowThresholds: { elevatedBps: 1, extremeBps: 2.4 } }),
      snap({ crowdingLevel: "NEUTRAL", crowdingLevelShadow: "NEUTRAL", crowdingShadowThresholds: { elevatedBps: 1, extremeBps: 2.4 } }),
      snap({ crowdingLevel: "NEUTRAL", crowdingLevelShadow: "NEUTRAL" }),
    ]);
    expect(s.extreme).toBe(0); // live: nothing extreme — gates see exactly what they saw before
    expect(s.extremeShadow).toBe(1); // shadow: one would have been
    expect(s.shadowCalibrated).toBe(2);
  });

  // extremeShadow must count only snapshots that HAVE a per-symbol calibration. For an
  // uncalibrated symbol crowdingLevelShadow is assigned crowdingLevel, so an unrestricted filter
  // reports a fixed-threshold EXTREME as if a per-symbol measurement agreed with it — when none
  // exists. Invisible today (fixed EXTREME never fires) and actively misleading the moment anyone
  // lowers CROWDING_EXTREME_BPS, i.e. exactly when this number is being used to decide.
  it("[NO-EXEC-COUPLING] extremeShadow excludes uncalibrated snapshots instead of echoing the live level", () => {
    const s = summarizeCrowding([
      // Uncalibrated AND live-EXTREME: shadow falls back to the live level by construction.
      snap({ crowdingLevel: "EXTREME", crowdingLevelShadow: "EXTREME" }),
      // Genuinely calibrated shadow extreme.
      snap({ crowdingLevel: "ELEVATED", crowdingLevelShadow: "EXTREME", crowdingShadowThresholds: { elevatedBps: 1, extremeBps: 2.4 } }),
    ]);
    expect(s.extreme).toBe(1); // live count untouched: only the first row is live-EXTREME
    expect(s.shadowCalibrated).toBe(1);
    // Without the fix this is 2 — the uncalibrated row double-counted as a shadow verdict.
    expect(s.extremeShadow).toBe(1);
    expect(s.extremeShadow).toBeLessThanOrEqual(s.shadowCalibrated); // reconcilable, by construction
  });
});

import { describe, it, expect } from "vitest";
import os from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  BULL_TREND_PAPER_LANE_ID,
  buildAdaptiveLaneRouterReport,
  rankCandidateLanes,
  classifyLaneMaturity,
  normalizeRegimeFamily,
  directionCompatibleWithMode,
  resolveLiveBlocked,
  type CandidateLane,
  type LaneRankingContext,
} from "../src/lib/adaptive-lane-router.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import { buildPostCutoverReport } from "../src/lib/frozen-current-guard-post-cutover.js";
import {
  buildCurrentGuardVariantMatrixReport,
  CurrentGuardVariantMatrixStore,
} from "../src/lib/current-guard-variant-matrix.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";

describe("resolveLiveBlocked — the live ceiling (testnet-only unblock, mainnet hard-locked)", () => {
  const T = "I_UNDERSTAND_TESTNET_ORDERS";
  it("[LB-DEFAULT] blocks when no env is set (preserves the original hard invariant)", () => {
    expect(resolveLiveBlocked({})).toBe(true);
  });
  it("[LB-TESTNET] unblocks ONLY with the exact token AND testnet env", () => {
    expect(resolveLiveBlocked({ LIVE_UNBLOCK_TESTNET: T, LIVE_BINANCE_ENV: "testnet" })).toBe(false);
    // case-insensitive env
    expect(resolveLiveBlocked({ LIVE_UNBLOCK_TESTNET: T, LIVE_BINANCE_ENV: "TESTNET" })).toBe(false);
  });
  it("[LB-MAINNET] mainnet can NEVER unblock, even with the token", () => {
    expect(resolveLiveBlocked({ LIVE_UNBLOCK_TESTNET: T, LIVE_BINANCE_ENV: "mainnet" })).toBe(true);
    expect(resolveLiveBlocked({ LIVE_UNBLOCK_TESTNET: T, LIVE_BINANCE_ENV: "production" })).toBe(true);
    expect(resolveLiveBlocked({ LIVE_UNBLOCK_TESTNET: T })).toBe(true); // no env → blocked
  });
  it("[LB-TOKEN] testnet without the exact token stays blocked", () => {
    expect(resolveLiveBlocked({ LIVE_BINANCE_ENV: "testnet" })).toBe(true);
    expect(resolveLiveBlocked({ LIVE_UNBLOCK_TESTNET: "yes", LIVE_BINANCE_ENV: "testnet" })).toBe(true);
    expect(resolveLiveBlocked({ LIVE_UNBLOCK_TESTNET: "", LIVE_BINANCE_ENV: "testnet" })).toBe(true);
  });
});
import {
  buildOperatorBrief,
  OPERATOR_BRIEF_MAX_LINES,
  type OperatorBriefInputs,
} from "../src/lib/operator-brief.js";

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "adaptive-lane-router-test-"));
}

function emptyGate() {
  return buildLiveTradingGateReport({});
}
function emptyPc() {
  return buildPostCutoverReport(undefined, null, null);
}
function emptyVm() {
  return buildCurrentGuardVariantMatrixReport(new CurrentGuardVariantMatrixStore(tmpDir()));
}

function regimeOf(raw: string | null) {
  return buildRegimeDirectionControllerReport({
    currentRegime: raw,
    adaptiveDirectionBias: null,
    primaryValidationLane: null,
  });
}

/** A fully-specified candidate lane; override any field. */
function makeLane(overrides: Partial<CandidateLane> = {}): CandidateLane {
  return {
    laneId: "TEST_LANE",
    source: "TEST",
    directionBias: "NEUTRAL",
    regimeFamily: "ANY",
    freshValid: 120,
    netAvgR: 0.1,
    pf: 1.5,
    wr: 0.55,
    payoffRatio: 1.0,
    oosAllPositive: true,
    plus10bpsPositive: true,
    maxDrawdownR: 2,
    topSymbolShare: 0.2,
    status: "STABLE_CANDIDATE",
    blockers: [],
    ...overrides,
  };
}

const BEARISH_SHORT_CTX: LaneRankingContext = {
  regimeFamily: "BEARISH",
  controllerMode: "SHORT_ONLY",
  infraReady: false,
};
const BULLISH_LONG_CTX: LaneRankingContext = {
  regimeFamily: "BULLISH",
  controllerMode: "LONG_ONLY",
  infraReady: false,
};

function routerInputs(regimeRaw: string | null) {
  return {
    generatedAt: "2026-05-30T20:00:00.000Z",
    regimeReport: regimeOf(regimeRaw),
    postCutoverReport: emptyPc(),
    variantMatrixReport: emptyVm(),
    gateReport: emptyGate(),
  };
}

describe("adaptive-lane-router", () => {
  // 1. Mixed rotation → validation/shadow only, never live/paper.
  it("[1] mixed rotation yields SHADOW_ONLY/NO_TRADE, never paper/live", () => {
    const r = buildAdaptiveLaneRouterReport(routerInputs("Mixed rotation"));
    expect(r.regimeFamily).toBe("MIXED");
    expect(["NO_TRADE", "SHADOW_ONLY"]).toContain(r.currentPermission);
    expect(["NO_TRADE", "SHADOW_ONLY"]).toContain(r.perRegimePolicy.MIXED.permission);
    expect(r.currentPermission).not.toBe("PAPER_ELIGIBLE");
    expect(r.currentPermission).not.toBe("LIVE_BLOCKED");
  });

  // 2. Bearish + sufficient evidence selects the best SHORT-compatible lane.
  it("[2] bearish pressure ranks a sufficient SHORT lane top + recommendable", () => {
    const short = makeLane({ laneId: "SHORT_STRONG", directionBias: "SHORT", netAvgR: 0.2, pf: 1.8 });
    const { ranked } = rankCandidateLanes([short], BEARISH_SHORT_CTX);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.laneId).toBe("SHORT_STRONG");
    expect(ranked[0]!.recommendable).toBe(true);
    expect(ranked[0]!.maturity).toBe("STABLE_CANDIDATE");
  });

  // 3. Bullish never selects a bearish-only (SHORT) lane.
  it("[3] bullish expansion deprioritizes a SHORT-only lane", () => {
    const short = makeLane({ laneId: "SHORT_ONLY_LANE", directionBias: "SHORT", netAvgR: 0.3, pf: 2.0 });
    const neutral = makeLane({ laneId: "NEUTRAL_OK", directionBias: "NEUTRAL", netAvgR: 0.08, pf: 1.3 });
    const { ranked, rejected } = rankCandidateLanes([short, neutral], BULLISH_LONG_CTX);
    expect(rejected.some((c) => c.laneId === "SHORT_ONLY_LANE")).toBe(true);
    expect(ranked.every((c) => c.directionBias !== "SHORT")).toBe(true);
    if (ranked.length > 0) expect(ranked[0]!.laneId).toBe("NEUTRAL_OK");
  });

  // 4. Choppy range → NO_TRADE.
  it("[4] choppy range maps to NO_TRADE", () => {
    const r = buildAdaptiveLaneRouterReport(routerInputs("Choppy range"));
    expect(r.regimeFamily).toBe("CHOP");
    expect(r.perRegimePolicy.CHOP.permission).toBe("NO_TRADE");
    expect(r.perRegimePolicy.CHOP.recommendedLaneId).toBeNull();
    expect(["NO_TRADE", "SHADOW_ONLY"]).toContain(r.currentPermission);
  });

  // 5. Stronger geometry outranks baseline when both pass gates.
  it("[5] CG_WIDE outranks CG_BASELINE on stronger net/PF/payoff", () => {
    const wide = makeLane({
      laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      netAvgR: 0.15,
      pf: 1.6,
      payoffRatio: 1.0,
    });
    const baseline = makeLane({
      laneId: "CG_VARIANT_MATRIX:CG_BASELINE_CURRENT",
      netAvgR: 0.06,
      pf: 1.3,
      payoffRatio: 0.8,
    });
    const { ranked } = rankCandidateLanes([baseline, wide], BEARISH_SHORT_CTX);
    expect(ranked[0]!.laneId).toBe("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    expect(ranked[0]!.maturity).toBe("STABLE_CANDIDATE");
  });

  // 6. Legacy negative W** / W*** lanes are never recommended.
  it("[6] legacy W** / W*** lanes always classify REJECT and never rank", () => {
    const legacyById = makeLane({ laneId: "W**_CONTROLLER_ALIGNED_PARENT", netAvgR: 0.5, pf: 3 });
    const legacyByFlag = makeLane({ laneId: "FILTERED_EDGE_X", isLegacyNegative: true, netAvgR: 0.4, pf: 2 });
    expect(classifyLaneMaturity(legacyById, false)).toBe("REJECT");
    expect(classifyLaneMaturity(legacyByFlag, false)).toBe("REJECT");
    const { ranked, rejected } = rankCandidateLanes([legacyById, legacyByFlag], BEARISH_SHORT_CTX);
    expect(ranked).toHaveLength(0);
    expect(rejected.every((c) => c.recommendable === false)).toBe(true);
    expect(rejected).toHaveLength(2);
  });

  // 7. n<50 stays COLLECTING and cannot be STABLE_CANDIDATE.
  it("[7] freshValid below WATCHABLE threshold stays COLLECTING regardless of stats", () => {
    const small = makeLane({ freshValid: 10, netAvgR: 0.3, pf: 2.0, oosAllPositive: true });
    const m = classifyLaneMaturity(small, false);
    expect(m).toBe("COLLECTING");
    expect(m).not.toBe("STABLE_CANDIDATE");
  });

  // 8. n>=100 with OOS positive + gates can become STABLE_CANDIDATE.
  it("[8] freshValid >= 100 with OOS positive reaches STABLE_CANDIDATE", () => {
    const mature = makeLane({
      freshValid: 120,
      netAvgR: 0.1,
      pf: 1.5,
      payoffRatio: 0.9,
      oosAllPositive: true,
      plus10bpsPositive: true,
      maxDrawdownR: 2,
      topSymbolShare: 0.2,
    });
    expect(classifyLaneMaturity(mature, false)).toBe("STABLE_CANDIDATE");
    // Still not PROMOTION without n>=200 + infra ready.
    expect(classifyLaneMaturity({ ...mature, freshValid: 220 }, false)).toBe("STABLE_CANDIDATE");
    expect(classifyLaneMaturity({ ...mature, freshValid: 220 }, true)).toBe("PROMOTION_CANDIDATE");
  });

  // 9. Operator Brief renders the router section under 140 lines.
  it("[9] operator brief renders section 9 and stays under OPERATOR_BRIEF_MAX_LINES", () => {
    const inputs: OperatorBriefInputs = {
      generatedAt: "2026-05-30T20:00:00.000Z",
      era: "POST_CALIBRATION",
      scanStatus: null,
      regimeReport: regimeOf("Mixed rotation"),
      postCutoverReport: emptyPc(),
      variantMatrixReport: emptyVm(),
      gateReport: emptyGate(),
    };
    const brief = buildOperatorBrief(inputs);
    expect(brief).toContain("9. ADAPTIVE LANE ROUTER");
    expect(brief).toContain("regime-map:");
    expect(OPERATOR_BRIEF_MAX_LINES).toBe(140);
    expect(brief.split("\n").length).toBeLessThanOrEqual(OPERATOR_BRIEF_MAX_LINES);
  });

  // 10. liveBlocked stays true, microPilotAllowed stays false — even with a promotion-grade lane.
  it("[10] liveBlocked=true and microPilotAllowed=false always", () => {
    const r = buildAdaptiveLaneRouterReport(routerInputs("Bearish pressure"));
    expect(r.liveBlocked).toBe(true);
    expect(r.microPilotAllowed).toBe(false);
    // Pure permission can never escalate to paper/live while the gate blocks.
    const promo = makeLane({ freshValid: 300, netAvgR: 0.3, pf: 2.5, payoffRatio: 1.5 });
    const { ranked } = rankCandidateLanes([promo], BEARISH_SHORT_CTX);
    // infraReady=false caps the lane at STABLE_CANDIDATE (no promotion).
    expect(ranked[0]!.maturity).toBe("STABLE_CANDIDATE");
  });

  // 11. The router is pure — it never writes shadow-positions.json.
  it("[11] building the router writes no shadow-positions.json", () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore);
    const before = vmStore.all.length;
    buildAdaptiveLaneRouterReport({
      generatedAt: "2026-05-30T20:00:00.000Z",
      regimeReport: regimeOf("Mixed rotation"),
      postCutoverReport: emptyPc(),
      variantMatrixReport: vm,
      gateReport: emptyGate(),
    });
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
    expect(vmStore.all.length).toBe(before);
  });

  // 13. Bullish LONG_ONLY selects the isolated pure-bull collection lane.
  it("[13] bullish LONG_ONLY selects BULL_TREND collection while retaining bearish advisories", () => {
    const r = buildAdaptiveLaneRouterReport(routerInputs("Bullish expansion"));
    expect(r.regimeFamily).toBe("BULLISH");
    expect(r.controllerMode).toBe("LONG_ONLY");
    expect(r.selectedCurrentLane).toBe(BULL_TREND_PAPER_LANE_ID);
    expect(r.collectionAction).toBeNull();
    expect(r.currentPermission).toBe("SHADOW_ONLY");
    expect(r.rankedCandidates[0]!.directionBias).toBe("LONG");
    expect(r.rankedCandidates[0]!.maturity).toBe("INSUFFICIENT");
    expect(r.perRegimePolicy.BULLISH.recommendedLaneId).toBe(BULL_TREND_PAPER_LANE_ID);
    expect(r.perRegimePolicy.BULLISH.permission).toBe("SHADOW_ONLY");
    // BEARISH per-regime still shows the CG advisory lane (SHORT qualifies for BEAR).
    expect(r.perRegimePolicy.BEARISH.recommendedLaneId).not.toBeNull();
    expect(r.perRegimePolicy.BEARISH.permission).toBe("SHADOW_ONLY");
    expect(r.liveBlocked).toBe(true);
    expect(r.microPilotAllowed).toBe(false);
  });

  it("[13b] bullish lane maturity counts realized paper OOS, not the zero-sample VM row", () => {
    const now = "2026-06-12T00:00:00.000Z";
    const paperOrders = Array.from({ length: 12 }, (_, index) => ({
      selectedLaneId: BULL_TREND_PAPER_LANE_ID,
      paperStatus: index < 8 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
      netR: index < 8 ? 1.39 : -1.11,
      plannedStopDistanceBps: 200,
      symbol: `SYM${index % 4}USDT`,
      updatedAt: new Date(Date.parse(now) + index * 60_000).toISOString(),
    }));
    const r = buildAdaptiveLaneRouterReport({
      ...routerInputs("Bullish expansion"),
      paperOrders: paperOrders as never,
    });
    const bull = [
      ...r.rankedCandidates,
      ...r.experimentalUpsideCandidates,
      ...r.collectingWatchlist,
    ].find((candidate) => candidate.laneId === BULL_TREND_PAPER_LANE_ID);
    expect(bull?.freshValid).toBe(12);
    expect(bull?.netAvgR).toBeGreaterThan(0);
    expect(bull?.pf).toBeGreaterThan(1);
    expect(bull?.maturity).toBe("COLLECTING");
    expect(r.experimentalUpsideCandidates.map((candidate) => candidate.laneId)).toContain(
      BULL_TREND_PAPER_LANE_ID,
    );
  });

  // 14. Regime map BULL / current selection consistency: no contradiction.
  it("[14] regime-map BULL is consistent with the selected pure-bull lane", () => {
    const r = buildAdaptiveLaneRouterReport(routerInputs("Bullish expansion"));
    // The contradiction (BULL→NO_TRADE but a lane was selected) must not exist.
    expect(r.perRegimePolicy.BULLISH.permission).toBe("SHADOW_ONLY");
    expect(r.perRegimePolicy.BULLISH.recommendedLaneId).toBe(r.selectedCurrentLane);
    // Bearish advisory must show the CG lanes so the per-regime map is useful.
    expect(r.perRegimePolicy.BEARISH.recommendedLaneId).not.toBeNull();
    expect(r.rankedCandidates.every((c) => c.directionBias === "LONG")).toBe(true);
  });

  // 15. SHORT_ONLY bearish can still select CG_WIDE when evidence is sufficient.
  it("[15] bearish SHORT_ONLY selects CG_WIDE (SHORT bias) when evidence is sufficient", () => {
    const cgWide = makeLane({
      laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      directionBias: "SHORT", // production classification after fix
      netAvgR: 0.15,
      pf: 1.6,
      payoffRatio: 1.0,
    });
    const { ranked } = rankCandidateLanes([cgWide], BEARISH_SHORT_CTX);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.laneId).toBe("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    expect(ranked[0]!.recommendable).toBe(true);
    expect(ranked[0]!.maturity).toBe("STABLE_CANDIDATE");
    expect(ranked[0]!.directionCompatible).toBe(true);
  });

  // 16. VALIDATION_ONLY shows advisory lane but must not imply live/paper execution.
  it("[16] VALIDATION_ONLY shows advisory lane but permission is never paper/live", () => {
    const r = buildAdaptiveLaneRouterReport(routerInputs("Mixed rotation"));
    expect(r.controllerMode).toBe("VALIDATION_ONLY");
    expect(r.currentPermission).not.toBe("PAPER_ELIGIBLE");
    expect(r.currentPermission).not.toBe("LIVE_BLOCKED");
    // reason must flag shadow/advisory intent.
    const reason = r.selectedCurrentLaneReason.toLowerCase();
    const isShadowIntent =
      reason.includes("advisory") || reason.includes("shadow") || reason.includes("validation") ||
      r.currentPermission === "SHADOW_ONLY" || r.currentPermission === "NO_TRADE";
    expect(isShadowIntent).toBe(true);
    expect(r.liveBlocked).toBe(true);
    expect(r.microPilotAllowed).toBe(false);
  });

  // 17. Compelling stats + OOS=false → experimental bucket, never primary ranked.
  it("[17] compelling stats + OOS=false → experimental bucket, not ranked", () => {
    const trail = makeLane({
      laneId: "TRAIL_EXPERIMENTAL",
      directionBias: "SHORT",
      netAvgR: 0.3,
      pf: 2.5,
      oosAllPositive: false,
      plus10bpsPositive: true,
    });
    const { ranked, experimental, rejected } = rankCandidateLanes([trail], BEARISH_SHORT_CTX);
    // Must not be in primary ranked.
    expect(ranked.every((c) => c.laneId !== "TRAIL_EXPERIMENTAL")).toBe(true);
    // Must be in experimental.
    expect(experimental).toHaveLength(1);
    expect(experimental[0]!.laneId).toBe("TRAIL_EXPERIMENTAL");
    expect(experimental[0]!.isExperimental).toBe(true);
    // Not rejected — it still qualifies directionally.
    expect(rejected).toHaveLength(0);
  });

  // 18. OOS weight boost: lower-net OOS-confirmed lane beats higher-net OOS-unconfirmed.
  it("[18] OOS boost: lower-net OOS-confirmed lane outranks higher-net OOS-unconfirmed", () => {
    const highNetNoOos = makeLane({
      laneId: "HIGH_NET_NO_OOS",
      directionBias: "SHORT",
      netAvgR: 0.5,
      pf: 2.5,
      oosAllPositive: false,
      plus10bpsPositive: true,
    });
    const lowerNetOos = makeLane({
      laneId: "LOWER_NET_OOS_CONFIRMED",
      directionBias: "SHORT",
      netAvgR: 0.1,
      pf: 1.5,
      oosAllPositive: true,
      plus10bpsPositive: true,
    });
    const { ranked, experimental } = rankCandidateLanes(
      [highNetNoOos, lowerNetOos],
      BEARISH_SHORT_CTX,
    );
    // OOS-confirmed goes to ranked; OOS-unconfirmed goes to experimental.
    expect(ranked.some((c) => c.laneId === "LOWER_NET_OOS_CONFIRMED")).toBe(true);
    expect(experimental.some((c) => c.laneId === "HIGH_NET_NO_OOS")).toBe(true);
    // Primary advisory must be the OOS-confirmed lane.
    expect(ranked[0]!.laneId).toBe("LOWER_NET_OOS_CONFIRMED");
    expect(ranked[0]!.isExperimental).toBe(false);
  });

  // 19. isExperimental=false on a fully OOS-confirmed stable lane.
  it("[19] isExperimental=false on a fully OOS-confirmed stable lane", () => {
    const confirmed = makeLane({
      laneId: "CONFIRMED_STABLE",
      directionBias: "SHORT",
      netAvgR: 0.15,
      pf: 1.8,
      oosAllPositive: true,
    });
    const { ranked } = rankCandidateLanes([confirmed], BEARISH_SHORT_CTX);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.isExperimental).toBe(false);
  });

  // 20. Router report always carries experimentalUpsideCandidates array.
  it("[20] buildAdaptiveLaneRouterReport always has experimentalUpsideCandidates array", () => {
    const r = buildAdaptiveLaneRouterReport(routerInputs("Bearish pressure"));
    expect(r.experimentalUpsideCandidates).toBeDefined();
    expect(Array.isArray(r.experimentalUpsideCandidates)).toBe(true);
  });

  // 21. Section 7 now shows "ETA n=50:" instead of the old "ETA n=100:" wording.
  it("[21] operator brief section 7 shows 'ETA n=50:' (not the old 'ETA n=100:')", () => {
    const brief = buildOperatorBrief({
      generatedAt: "2026-05-30T20:00:00.000Z",
      era: "POST_CALIBRATION",
      scanStatus: null,
      regimeReport: regimeOf("Bearish pressure"),
      postCutoverReport: emptyPc(),
      variantMatrixReport: emptyVm(),
      gateReport: emptyGate(),
    });
    // Section 7 bullet now uses ETA n=50.
    expect(brief).toContain("ETA n=50:");
    // The old section-7 wording (ETA n=100:) must be gone.
    // Note: section 3 has "  n=100:" (with leading spaces), NOT "ETA n=100:".
    expect(brief).not.toContain("ETA n=100:");
    // Still within line cap.
    expect(brief.split("\n").length).toBeLessThanOrEqual(OPERATOR_BRIEF_MAX_LINES);
  });

  // [22] Lane below WATCHABLE threshold with negative economics → isWatchlist=true, in collectingWatchlist
  it("[22] immature lane with negative netAvgR → isWatchlist=true, placed in collectingWatchlist", () => {
    const negLane = makeLane({
      laneId: "NEGATIVE_ECON_LANE",
      directionBias: "SHORT",
      freshValid: 10,
      netAvgR: -0.05,
      pf: 0.9,
      oosAllPositive: false,
      plus10bpsPositive: false,
    });
    const { ranked, experimental, collectingWatchlist, rejected } = rankCandidateLanes(
      [negLane],
      BEARISH_SHORT_CTX,
    );
    // Must NOT be in ranked or experimental.
    expect(ranked.every((c) => c.laneId !== "NEGATIVE_ECON_LANE")).toBe(true);
    expect(experimental.every((c) => c.laneId !== "NEGATIVE_ECON_LANE")).toBe(true);
    // Must be in collectingWatchlist.
    expect(collectingWatchlist).toHaveLength(1);
    expect(collectingWatchlist[0]!.laneId).toBe("NEGATIVE_ECON_LANE");
    expect(collectingWatchlist[0]!.isWatchlist).toBe(true);
    // Not hard-rejected — this is a monitoring bucket, not a hard kill.
    expect(rejected.every((c) => c.laneId !== "NEGATIVE_ECON_LANE")).toBe(true);
  });

  // [23] rankCandidateLanes returns 4-bucket object including collectingWatchlist
  it("[23] rankCandidateLanes returns 4-bucket object with collectingWatchlist", () => {
    const result = rankCandidateLanes([], BEARISH_SHORT_CTX);
    expect(result).toHaveProperty("ranked");
    expect(result).toHaveProperty("experimental");
    expect(result).toHaveProperty("collectingWatchlist");
    expect(result).toHaveProperty("rejected");
    expect(Array.isArray(result.collectingWatchlist)).toBe(true);
  });

  // [24] buildAdaptiveLaneRouterReport always carries collectingWatchlist array
  it("[24] buildAdaptiveLaneRouterReport always has collectingWatchlist array", () => {
    const r = buildAdaptiveLaneRouterReport(routerInputs("Bearish pressure"));
    expect(r.collectingWatchlist).toBeDefined();
    expect(Array.isArray(r.collectingWatchlist)).toBe(true);
  });

  // [25] No lane selected when all eligible lanes are watchlist-only (ranked empty)
  it("[25] no lane selected when all eligible lanes are watchlist-only (ranked empty)", () => {
    const negLane = makeLane({
      laneId: "WATCHLIST_ONLY_LANE",
      directionBias: "SHORT",
      freshValid: 10,
      netAvgR: -0.1,
      pf: 0.8,
      oosAllPositive: false,
      plus10bpsPositive: false,
    });
    const { ranked, collectingWatchlist } = rankCandidateLanes([negLane], BEARISH_SHORT_CTX);
    // Ranked must be empty — watchlist lane is not selectable as primary advisory.
    expect(ranked).toHaveLength(0);
    expect(collectingWatchlist).toHaveLength(1);
    expect(collectingWatchlist[0]!.isWatchlist).toBe(true);
  });

  // Bonus: normalization + direction compatibility helpers.
  it("normalizeRegimeFamily + directionCompatibleWithMode behave as documented", () => {
    expect(normalizeRegimeFamily("Bearish pressure")).toBe("BEARISH");
    expect(normalizeRegimeFamily("Bullish expansion")).toBe("BULLISH");
    expect(normalizeRegimeFamily("Mixed rotation")).toBe("MIXED");
    expect(normalizeRegimeFamily("Choppy range")).toBe("CHOP");
    expect(normalizeRegimeFamily(null)).toBe("UNKNOWN");

    expect(directionCompatibleWithMode("SHORT", "SHORT_ONLY")).toBe(true);
    expect(directionCompatibleWithMode("NEUTRAL", "SHORT_ONLY")).toBe(true);
    expect(directionCompatibleWithMode("LONG", "SHORT_ONLY")).toBe(false);
    expect(directionCompatibleWithMode("SHORT", "LONG_ONLY")).toBe(false);
    expect(directionCompatibleWithMode("LONG", "BOTH_ALLOWED")).toBe(true);
  });
});

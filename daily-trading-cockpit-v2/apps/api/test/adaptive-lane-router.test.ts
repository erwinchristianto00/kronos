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
  type CurrentGuardVariantMatrixReport,
  type ExactLaneContext,
  type VariantContextEvidenceRow,
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

  it("keeps exact-context candidates isolated from the current regime and from each other", () => {
    const bullishCollecting = makeLane({
      laneId: "CONTEXT_LANE",
      exactContext: "LONG_BULLISH",
      directionBias: "LONG",
      regimeFamily: "BULLISH",
      status: "COLLECTING",
      freshValid: 5,
      netAvgR: 0.02,
      pf: 1.05,
    });
    const mixedStable = makeLane({
      laneId: "CONTEXT_LANE",
      exactContext: "LONG_MIXED",
      directionBias: "LONG",
      regimeFamily: "MIXED",
      status: "STABLE_CANDIDATE",
      freshValid: 200,
      netAvgR: 0.8,
      pf: 4,
    });
    const bullish = rankCandidateLanes([bullishCollecting, mixedStable], BULLISH_LONG_CTX);
    expect(bullish.rejected.map((candidate) => candidate.laneId)).toContain("CONTEXT_LANE:LONG_MIXED");
    expect(bullish.ranked.map((candidate) => candidate.laneId)).not.toContain("CONTEXT_LANE:LONG_MIXED");
    expect(bullish.collectingWatchlist.map((candidate) => candidate.laneId)).toContain("CONTEXT_LANE:LONG_BULLISH");

    const mixed = rankCandidateLanes([bullishCollecting, mixedStable], {
      regimeFamily: "MIXED",
      controllerMode: "BOTH_ALLOWED",
      infraReady: false,
    });
    expect(mixed.rejected.map((candidate) => candidate.laneId)).toContain("CONTEXT_LANE:LONG_BULLISH");
    expect(mixed.ranked.map((candidate) => candidate.laneId)).toContain("CONTEXT_LANE:LONG_MIXED");
  });

  it("does not let a rejected mixed cohort veto a stable bullish cohort", () => {
    const bullishStable = makeLane({
      laneId: "SPLIT_LANE",
      exactContext: "LONG_BULLISH",
      directionBias: "LONG",
      regimeFamily: "BULLISH",
    });
    const mixedRejected = makeLane({
      laneId: "SPLIT_LANE",
      exactContext: "LONG_MIXED",
      directionBias: "LONG",
      regimeFamily: "MIXED",
      status: "REJECT",
      netAvgR: -0.5,
      pf: 0.2,
    });
    const { ranked, rejected } = rankCandidateLanes([bullishStable, mixedRejected], BULLISH_LONG_CTX);
    expect(ranked.map((candidate) => candidate.laneId)).toContain("SPLIT_LANE:LONG_BULLISH");
    expect(rejected.map((candidate) => candidate.laneId)).toContain("SPLIT_LANE:LONG_MIXED");
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
    expect(r.selectedCurrentLane).toBe(`${BULL_TREND_PAPER_LANE_ID}:LONG_BULLISH`);
    expect(r.collectionAction).toBeNull();
    expect(r.currentPermission).toBe("SHADOW_ONLY");
    expect(r.rankedCandidates[0]!.directionBias).toBe("LONG");
    expect(r.rankedCandidates[0]!.maturity).toBe("INSUFFICIENT");
    expect(r.perRegimePolicy.BULLISH.recommendedLaneId).toBe(`${BULL_TREND_PAPER_LANE_ID}:LONG_BULLISH`);
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
      direction: "LONG",
      regime: "Bullish expansion",
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
    ].find((candidate) => candidate.laneId === `${BULL_TREND_PAPER_LANE_ID}:LONG_BULLISH`);
    expect(bull?.freshValid).toBe(12);
    expect(bull?.netAvgR).toBeGreaterThan(0);
    expect(bull?.pf).toBeGreaterThan(1);
    expect(bull?.maturity).toBe("COLLECTING");
    expect(r.experimentalUpsideCandidates.map((candidate) => candidate.laneId)).toContain(
      `${BULL_TREND_PAPER_LANE_ID}:LONG_BULLISH`,
    );
  });

  it("does not copy long paper evidence across exact contexts or admit unknown context", () => {
    const laneId = "CG_LONG_VARIANT_MATRIX:LG_R12_STOP250_FULL";
    const paperOrders = [
      { selectedLaneId: laneId, paperStatus: "PAPER_CLOSED_WIN", netR: 0.4, plannedStopDistanceBps: 250, symbol: "ETHUSDT", direction: "LONG", regime: "Bullish expansion", updatedAt: "2026-07-30T00:00:00.000Z" },
      { selectedLaneId: laneId, paperStatus: "PAPER_CLOSED_WIN", netR: 0.3, plannedStopDistanceBps: 250, symbol: "SOLUSDT", direction: "LONG", regime: "Bullish expansion", updatedAt: "2026-07-30T00:01:00.000Z" },
      { selectedLaneId: laneId, paperStatus: "PAPER_CLOSED_LOSS", netR: -0.6, plannedStopDistanceBps: 250, symbol: "ETHUSDT", direction: "LONG", regime: "Mixed rotation", updatedAt: "2026-07-30T00:02:00.000Z" },
      { selectedLaneId: laneId, paperStatus: "PAPER_CLOSED_WIN", netR: 9, plannedStopDistanceBps: 250, symbol: "BTCUSDT", direction: "LONG", regime: "unclassified", updatedAt: "2026-07-30T00:03:00.000Z" },
    ];
    const r = buildAdaptiveLaneRouterReport({
      ...routerInputs("Bullish expansion"),
      paperOrders: paperOrders as never,
    });
    const all = [
      ...r.rankedCandidates,
      ...r.experimentalUpsideCandidates,
      ...r.collectingWatchlist,
      ...r.rejectedOrDeprioritizedLanes,
    ];
    const bull = all.find((candidate) => candidate.laneId === `${laneId}:LONG_BULLISH`);
    const mixed = all.find((candidate) => candidate.laneId === `${laneId}:LONG_MIXED`);
    expect(bull?.freshValid).toBe(2);
    expect(bull?.netAvgR).toBeGreaterThan(0);
    expect(mixed?.freshValid).toBe(1);
    expect(mixed?.netAvgR).toBeLessThan(0);
    expect(r.rankedCandidates.map((candidate) => candidate.laneId)).not.toContain(`${laneId}:LONG_MIXED`);
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

// ── maturityCeiling ────────────────────────────────────────────────────────────
//
// TWO LADDERS, ONE VOCABULARY. `classifyLaneMaturity` runs the router's own COARSE ladder: raw
// `freshValid` against WATCHABLE_MIN_FRESH / STABLE_MIN_FRESH / PROMOTION_MIN_FRESH plus the
// economics gates. The variant matrix runs the AUTHORITATIVE one: immutable, episode-aligned stage
// proof windows with independent-episode floors and a holdout. They emit the same five status
// names, so without a cap the router can print `maturity=STABLE_CANDIDATE` for a lane the
// authoritative ladder has not granted — an operator-visible falsehood in the brief and in
// `currentPermission`. `CandidateLane.maturityCeiling` is that cap.
//
// WHY THIS BLOCK EXISTS. The mechanism shipped with ZERO tests: `grep -rn maturityCeiling
// apps/api/test` returned nothing, and deleting the cap from `classifyLaneMaturity` left the entire
// suite green and byte-identical. It is live-adjacent — `classifyLaneMaturity` drives rejection, the
// mature-lane pick (maturityRank >= 2) and the PAPER_ELIGIBLE gate (>= 3), and this module is
// imported by paper-execution-router.ts and paper-opportunity-allocator.ts.
//
// Every case below goes through the real exported `classifyLaneMaturity`, or through the real
// `lanesFromVariantMatrix` wiring via `buildAdaptiveLaneRouterReport`. Nothing here re-implements
// the ladder or the cap.
describe("maturityCeiling — the authoritative ladder caps the router's raw-row ladder", () => {
  /** freshValid=220 with every economics gate passing: PROMOTION_CANDIDATE when infraReady. */
  const promotionGrade = () =>
    makeLane({
      laneId: "MC_PROMOTION_GRADE",
      freshValid: 220,
      netAvgR: 0.3,
      pf: 2.5,
      payoffRatio: 1.5,
      oosAllPositive: true,
      plus10bpsPositive: true,
      maxDrawdownR: 1,
      topSymbolShare: 0.2,
      status: "STABLE_CANDIDATE",
    });

  it("[MC-PASSTHROUGH] with no ceiling every rung of the router's own ladder is returned unchanged", () => {
    // Absent AND explicitly-undefined both have to pass through: the guard is `ceiling === undefined`.
    const rungs: Array<[string, CandidateLane, boolean, string]> = [
      ["INSUFFICIENT", makeLane({ freshValid: 0 }), false, "INSUFFICIENT"],
      ["COLLECTING", makeLane({ freshValid: 10 }), false, "COLLECTING"],
      // fv in [WATCHABLE_MIN_FRESH, STABLE_MIN_FRESH): economics pass, stable floor not reached.
      ["WATCHABLE", makeLane({ freshValid: 60 }), false, "WATCHABLE"],
      ["STABLE_CANDIDATE", promotionGrade(), false, "STABLE_CANDIDATE"],
      ["PROMOTION_CANDIDATE", promotionGrade(), true, "PROMOTION_CANDIDATE"],
      ["REJECT", makeLane({ freshValid: 120, netAvgR: -0.2, pf: 0.7 }), false, "REJECT"],
    ];
    for (const [name, lane, infraReady, expected] of rungs) {
      expect(`${name}:${classifyLaneMaturity(lane, infraReady)}`).toBe(`${name}:${expected}`);
      expect(`${name}:${classifyLaneMaturity({ ...lane, maturityCeiling: undefined }, infraReady)}`).toBe(
        `${name}:${expected}`,
      );
    }
  });

  it("[MC-CAP-EXACT] a promotion-grade lane lands exactly on its ceiling, never one rung above it", () => {
    // infraReady=true so the UNCAPPED verdict is PROMOTION_CANDIDATE for every row below — each
    // assertion is then purely about where the ceiling puts it.
    const ceilings = ["INSUFFICIENT", "COLLECTING", "WATCHABLE", "STABLE_CANDIDATE", "PROMOTION_CANDIDATE"] as const;
    for (const ceiling of ceilings) {
      const lane = { ...promotionGrade(), maturityCeiling: ceiling };
      // Encoding the input in the assertion makes a failure name the offending ceiling directly.
      expect(`${ceiling}=>${classifyLaneMaturity(lane, true)}`).toBe(`${ceiling}=>${ceiling}`);
    }
    // The top ceiling is the control: it must NOT downgrade anything (cap, not clamp-to-lower).
    expect(classifyLaneMaturity({ ...promotionGrade(), maturityCeiling: "PROMOTION_CANDIDATE" }, true)).toBe(
      "PROMOTION_CANDIDATE",
    );
    // INSUFFICIENT is reachable through the FIELD's type but is not produced by
    // maturityCeilingForContextStatus today; it is pinned so a future mapping cannot land on it
    // silently with undefined behaviour.
  });

  it("[MC-CEILING-REJECT] a REJECT ceiling rejects a lane the router itself would promote", () => {
    expect(classifyLaneMaturity({ ...promotionGrade(), maturityCeiling: "REJECT" }, true)).toBe("REJECT");
    expect(classifyLaneMaturity({ ...promotionGrade(), maturityCeiling: "REJECT" }, false)).toBe("REJECT");
  });

  it("[MC-REJECT-ABSORBING] REJECT survives capping in BOTH directions", () => {
    // Router says REJECT, matrix says promotable → REJECT. The cap must never launder a rejection.
    const routerReject = makeLane({
      laneId: "MC_ROUTER_REJECT",
      freshValid: 220,
      netAvgR: -0.4,
      pf: 0.5,
      maturityCeiling: "PROMOTION_CANDIDATE",
    });
    expect(classifyLaneMaturity(routerReject, true)).toBe("REJECT");
    // Same, via the status string branch rather than the economics branch.
    const statusReject = { ...promotionGrade(), status: "REJECT", maturityCeiling: "PROMOTION_CANDIDATE" as const };
    expect(classifyLaneMaturity(statusReject, true)).toBe("REJECT");
    // A legacy-negative lane cannot be rescued by a ceiling either.
    const legacy = { ...promotionGrade(), isLegacyNegative: true, maturityCeiling: "PROMOTION_CANDIDATE" as const };
    expect(classifyLaneMaturity(legacy, true)).toBe("REJECT");
    // Matrix says REJECT, router says promotable → REJECT (the other direction).
    expect(classifyLaneMaturity({ ...promotionGrade(), maturityCeiling: "REJECT" }, true)).toBe("REJECT");
  });

  it("[MC-NEVER-UPGRADES] the ceiling only ever downgrades — a weak lane is never lifted to it", () => {
    const promotionCeiling = { maturityCeiling: "PROMOTION_CANDIDATE" } as const;
    expect(classifyLaneMaturity({ ...makeLane({ freshValid: 0 }), ...promotionCeiling }, true)).toBe("INSUFFICIENT");
    expect(classifyLaneMaturity({ ...makeLane({ freshValid: 10 }), ...promotionCeiling }, true)).toBe("COLLECTING");
    expect(classifyLaneMaturity({ ...makeLane({ freshValid: 60 }), ...promotionCeiling }, true)).toBe("WATCHABLE");
    // infraReady=false keeps the router at STABLE_CANDIDATE; a PROMOTION ceiling must not fill that gap.
    expect(classifyLaneMaturity({ ...promotionGrade(), ...promotionCeiling }, false)).toBe("STABLE_CANDIDATE");
    // A WATCHABLE lane under a STABLE ceiling stays WATCHABLE.
    expect(classifyLaneMaturity({ ...makeLane({ freshValid: 60 }), maturityCeiling: "STABLE_CANDIDATE" }, true)).toBe(
      "WATCHABLE",
    );
  });

  // ── the real lanesFromVariantMatrix wiring ───────────────────────────────────
  //
  // These build a REAL report (`buildCurrentGuardVariantMatrixReport` over an empty store) and
  // replace ONE exact-context evidence row, then push it through the real
  // `buildAdaptiveLaneRouterReport`. The candidate's `maturityCeiling` is not on `RankedCandidate`,
  // so the ceiling is observed the only way an operator ever sees it: through the published
  // `maturity`.
  function vmWithContextRow(
    variantId: string,
    context: ExactLaneContext,
    patch: Partial<VariantContextEvidenceRow> & { status: VariantContextEvidenceRow["status"] },
  ): CurrentGuardVariantMatrixReport {
    const vm = emptyVm();
    const rows = vm.rows.map((row) => {
      if (row.variantId !== variantId) return row;
      const existing = row.contextRows?.[context];
      if (!existing) throw new Error(`fixture error: ${variantId} has no ${context} context row`);
      return { ...row, contextRows: { ...row.contextRows, [context]: { ...existing, ...patch } } };
    });
    return { ...vm, rows };
  }

  /** Evidence that makes the router's OWN ladder say STABLE_CANDIDATE (fv >= STABLE_MIN_FRESH=100,
   *  every economics gate passing). Whatever comes back is then the ceiling's doing, not the data's. */
  const stableGradeEvidence = {
    freshValid: 220,
    effectiveN: 40,
    netAvgR: 0.3,
    pf: 2.5,
    wr: 0.6,
    payoffRatio: 1.5,
    allThreeOosPositive: true,
    plus10bpsStillPositive: true,
    approxMaxDrawdownR: 1,
    topSymbolPnlShare: 0.2,
    blockers: [],
  } as const;

  function maturityOfCandidate(report: ReturnType<typeof buildAdaptiveLaneRouterReport>, laneId: string) {
    const all = [
      ...report.rankedCandidates,
      ...report.experimentalUpsideCandidates,
      ...report.collectingWatchlist,
      ...report.rejectedOrDeprioritizedLanes,
    ];
    const found = all.find((candidate) => candidate.laneId === laneId);
    if (!found) throw new Error(`candidate ${laneId} not present in any bucket`);
    return found.maturity;
  }

  it("[MC-WIRING] a matrix-sourced candidate is capped at its own exact-context evidence status", () => {
    const laneId = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE:SHORT_BEARISH";
    // Each row: the matrix's authoritative verdict → the maturity the router is allowed to print.
    // The evidence numbers are identical in all three; only `status` moves.
    const cases = [
      ["COLLECTING", "COLLECTING"],
      ["WATCHABLE", "WATCHABLE"],
      // Ceiling equal to the router's own verdict: must not downgrade.
      ["STABLE_CANDIDATE", "STABLE_CANDIDATE"],
      // PROMOTION ceiling above the router's verdict (infraReady=false): must not upgrade.
      ["PROMOTION_CANDIDATE", "STABLE_CANDIDATE"],
    ] as const;
    for (const [status, expected] of cases) {
      const report = buildAdaptiveLaneRouterReport({
        ...routerInputs("Bearish pressure"),
        variantMatrixReport: vmWithContextRow("CG_WIDE_STOP_TP_WIDE", "SHORT_BEARISH", {
          ...stableGradeEvidence,
          status,
        }),
      });
      expect(`${status}=>${maturityOfCandidate(report, laneId)}`).toBe(`${status}=>${expected}`);
    }
    // NOT included above on purpose: status "REJECT". The router's own ladder already returns REJECT
    // for it via the `status` string branch of classifyLaneMaturityUncapped, so that row would pass
    // with the ceiling deleted and would prove nothing. [MC-CEILING-REJECT] covers the REJECT
    // ceiling against a lane whose own status is not REJECT.
  });

  it("[MC-WIRING-NOT-APPLICABLE] a NOT_APPLICABLE evidence status caps at COLLECTING, not REJECT and not uncapped", () => {
    // NOT_APPLICABLE is a value of ContextLaneStatus. `buildContextEvidenceRow` does not emit it
    // today — it is produced by `laneStatusForContext` when a context is outside a lane's
    // applicability map, and `lanesFromVariantMatrix` only walks `definition.applicableContexts` —
    // so this branch is defensive. The test therefore hands the router a report carrying that
    // status directly, which is exactly what a future producer would do. Pinning it matters in two
    // directions: mapping it to REJECT would silently kill candidates the matrix never judged, and
    // leaving it uncapped would let an out-of-scope context advertise STABLE_CANDIDATE.
    const report = buildAdaptiveLaneRouterReport({
      ...routerInputs("Bearish pressure"),
      variantMatrixReport: vmWithContextRow("CG_WIDE_STOP_TP_WIDE", "SHORT_BEARISH", {
        ...stableGradeEvidence,
        status: "NOT_APPLICABLE",
      }),
    });
    const maturity = maturityOfCandidate(report, "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE:SHORT_BEARISH");
    expect(maturity).toBe("COLLECTING");
    expect(maturity).not.toBe("REJECT");
    expect(maturity).not.toBe("STABLE_CANDIDATE");
  });

  it("[MC-PAPER-NO-CEILING] paper-derived candidates carry NO ceiling, while their matrix-derived sibling in the same report still does", () => {
    // LG_R12_STOP250_FULL is longOnly, so `lanesFromVariantMatrix` looks for paper evidence per
    // context. LONG_BULLISH gets 120 closed paper orders (numbers come from the paper book, so the
    // matrix status is not the authority and no ceiling applies). LONG_MIXED gets none, so it falls
    // back to matrix evidence and IS capped. Same lane, same report, one ceiling each way — so a
    // green LONG_BULLISH cannot be explained by "ceilings never fire in this fixture".
    const laneBase = "CG_LONG_VARIANT_MATRIX:LG_R12_STOP250_FULL";
    const base = Date.parse("2026-06-01T00:00:00.000Z");
    // i%4 !== 3 wins +1.0, else loses -0.5 → net 0.625R, PF 6, payoff 2, drawdown 0.5R, all three
    // OOS thirds positive, top-symbol share 0.2 across 5 symbols. 120 rows clears STABLE_MIN_FRESH
    // (100) and stays under PROMOTION_MIN_FRESH (200).
    const paperOrders = Array.from({ length: 120 }, (_, index) => ({
      selectedLaneId: laneBase,
      paperStatus: index % 4 === 3 ? "PAPER_CLOSED_LOSS" : "PAPER_CLOSED_WIN",
      netR: index % 4 === 3 ? -0.5 : 1.0,
      plannedStopDistanceBps: 200,
      symbol: `MC${index % 5}USDT`,
      direction: "LONG",
      regime: "Bullish expansion",
      updatedAt: new Date(base + index * 60_000).toISOString(),
    }));
    const report = buildAdaptiveLaneRouterReport({
      ...routerInputs("Bullish expansion"),
      // The matrix's own verdict for BOTH contexts is COLLECTING; only LONG_MIXED should feel it.
      variantMatrixReport: vmWithContextRow("LG_R12_STOP250_FULL", "LONG_MIXED", {
        ...stableGradeEvidence,
        status: "COLLECTING",
      }),
      paperOrders: paperOrders as never,
    });
    // Paper-derived: reaches the router's own STABLE_CANDIDATE despite a COLLECTING matrix row.
    expect(maturityOfCandidate(report, `${laneBase}:LONG_BULLISH`)).toBe("STABLE_CANDIDATE");
    // Matrix-derived sibling with identical-strength numbers: capped at COLLECTING.
    expect(maturityOfCandidate(report, `${laneBase}:LONG_MIXED`)).toBe("COLLECTING");
  });
});

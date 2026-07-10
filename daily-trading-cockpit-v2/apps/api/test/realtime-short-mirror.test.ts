import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperExecutionRouterStore } from "../src/lib/paper-execution-router.js";
import {
  runRealtimeShortMirror,
  isRealtimeShortMirrorEnabled,
  makeRealtimeShortPaperOrderId,
  realtimeShortSelectedLaneId,
  REALTIME_SHORT_ALLOWED_VARIANT_IDS,
  FORCE_ELIGIBLE_SHORT_VARIANT_IDS,
  FORCE_ELIGIBLE_LONG_VARIANT_IDS,
  PROFIT_CORE_SHORT_TRAIL_LANE_ID,
  profitCoreShortRejectionReason,
  type RealtimeShortCandidate,
  type RealtimeShortMirrorInputs,
} from "../src/lib/realtime-short-mirror.js";

function freshStore(): PaperExecutionRouterStore {
  return new PaperExecutionRouterStore(mkdtempSync(join(tmpdir(), "rtshort-")));
}

// A valid SHORT candidate: stop ABOVE entry, tp1 BELOW entry.
function shortCand(symbol: string, over: Partial<RealtimeShortCandidate> = {}): RealtimeShortCandidate {
  return {
    symbol,
    direction: "SHORT",
    currentPrice: 100,
    stopLoss: 103,
    takeProfitLevels: [94, 90],
    stopDistanceBps: 300,
    ...over,
  };
}

function profitCoreCand(symbol = "BTCUSDT", over: Partial<RealtimeShortCandidate> = {}): RealtimeShortCandidate {
  return shortCand(symbol, {
    stopLoss: 110,
    takeProfitLevels: [95],
    stopDistanceBps: 1000,
    selectedEntryVariant: "base_current_entry",
    selectedExitVariant: "trail_after_tp1",
    routeMode: "PROFIT_CANDIDATE",
    chaseRisk: "LOW",
    riskReward: 6,
    calibratedExpectedNetR: 0.4,
    calibrationVerdict: "CALIBRATED_POSITIVE",
    whaleSignal: "BEARISH",
    sourceConflict: false,
    horizonConflict: false,
    ...over,
  });
}

function inputs(
  candidates: RealtimeShortCandidate[],
  over: Partial<RealtimeShortMirrorInputs> = {},
): RealtimeShortMirrorInputs {
  return {
    candidates,
    regime: "Bearish pressure",
    controllerMode: "SHORT_ONLY",
    stableShortLaneActive: false,
    stableShortLanes: [
      { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.3, pf: 1.3 },
      { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.25, pf: 1.2 },
      { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.2, pf: 1.4 },
    ],
    now: "2026-06-25T04:00:00.000Z",
    ...over,
  };
}

describe("realtime-short-mirror — fresh short live-mirror source (mode 2)", () => {
  it("[PROFIT-CORE] emits only the strict bearish no-chase fingerprint and uses executable scaleout+trail", () => {
    const store = freshStore();
    const result = runRealtimeShortMirror(
      inputs([profitCoreCand()], {
        controllerConfidence: "MEDIUM",
        stableShortLanes: [],
        rotationShortlist: null,
        profitCoreShortEnabled: true,
      }),
      store,
    );
    expect(result.emitted).toBe(1);
    expect(store.all[0]!.selectedLaneId).toBe(PROFIT_CORE_SHORT_TRAIL_LANE_ID);
    expect(store.all[0]!.variantExitRule).toBe("scaleout_tp1_trail");
    expect(store.all[0]!.stopLoss).toBe(110);
    expect(store.all[0]!.takeProfitLevels).toEqual([95]);
  });

  it("[PROFIT-CORE] cannot be forced outside the evidence fingerprint", () => {
    const estimated = {
      posture: "EXTENDED_TREND" as const,
      direction: "SHORT" as const,
      policy: "WIDE_TREND" as const,
      reason: "test",
    };
    expect(profitCoreShortRejectionReason(
      profitCoreCand("SOLUSDT"),
      { regime: "Bearish pressure", controllerMode: "SHORT_ONLY" },
      estimated,
    )).toBe("symbol_not_profit_core");
    expect(profitCoreShortRejectionReason(
      profitCoreCand("BTCUSDT", { chaseRisk: "HIGH" }),
      { regime: "Bearish pressure", controllerMode: "SHORT_ONLY" },
      estimated,
    )).toBe("entry_chase_not_low");
    expect(profitCoreShortRejectionReason(
      profitCoreCand("BTCUSDT"),
      { regime: "Bullish expansion", controllerMode: "LONG_ONLY" },
      { ...estimated, direction: "LONG" },
    )).toBe("controller_not_short_only");
  });

  it("[PROFIT-CORE] uses the unmodified controller even when manual selector widens generic lanes", () => {
    const store = freshStore();
    const result = runRealtimeShortMirror(
      inputs([profitCoreCand()], {
        controllerMode: "BOTH_ALLOWED",
        controllerConfidence: "MEDIUM",
        estimatedRegime: {
          posture: "TACTICAL_OR_MIXED",
          direction: "MIXED",
          policy: "TACTICAL_70_30",
          reason: "manual selector",
        },
        profitCoreControllerMode: "SHORT_ONLY",
        profitCoreEstimatedRegime: {
          posture: "EXTENDED_TREND",
          direction: "SHORT",
          policy: "WIDE_TREND",
          reason: "real controller",
        },
        stableShortLanes: [],
        rotationShortlist: null,
        profitCoreShortEnabled: true,
      }),
      store,
    );
    expect(result.emitted).toBe(1);
    expect(store.all[0]!.controllerMode).toBe("SHORT_ONLY");
  });

  it("[CROWDING-VETO] skips a short into a SHORT-extreme crowd, still fires into a LONG-extreme crowd", () => {
    // SHORT into a SHORT-crowded-EXTREME book ⇒ vetoed (don't add to the over-short crowd).
    const vetoed = runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT")], {
        crowdingVetoEnabled: true,
        crowdingBySymbol: { BTCUSDT: { crowdSide: "SHORT", crowdingLevel: "EXTREME" } },
      }),
      freshStore(),
    );
    expect(vetoed.emitted).toBe(0);
    expect(vetoed.reasons.some((r) => r.startsWith("crowded_extreme_same_side:BTCUSDT"))).toBe(true);

    // SHORT into a LONG-crowded-EXTREME book ⇒ NOT vetoed — that's the fade we want.
    const fade = runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT")], {
        crowdingVetoEnabled: true,
        crowdingBySymbol: { BTCUSDT: { crowdSide: "LONG", crowdingLevel: "EXTREME" } },
      }),
      freshStore(),
    );
    expect(fade.emitted).toBe(1);

    // Veto disabled ⇒ no effect even on a same-side extreme crowd.
    const off = runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT")], {
        crowdingBySymbol: { BTCUSDT: { crowdSide: "SHORT", crowdingLevel: "EXTREME" } },
      }),
      freshStore(),
    );
    expect(off.emitted).toBe(1);
  });

  it("[FORCE] CG_WIDE_FAST_SHORT emits even when only WATCHABLE; CG_WIDE_STOP_TP_WIDE stays gated", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT")], {
        forceFastShort: true,
        // Neither short lane is STABLE — CG_WIDE_FAST_SHORT is only WATCHABLE, CG_WIDE_STOP_TP_WIDE COLLECTING.
        stableShortLanes: [
          { variantId: "CG_WIDE_STOP_TP_WIDE", status: "COLLECTING", freshValid: 285, netAvgR: 0.02, pf: 1.05 },
          { variantId: "CG_WIDE_FAST_SHORT", status: "WATCHABLE", freshValid: 378, netAvgR: 0.11, pf: 1.4 },
        ],
      }),
      store,
    );
    expect(res.emitted).toBe(1);
    expect(store.all[0]!.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_FAST_SHORT"));
  });

  it("[ROTATION-SHORTLIST] can emit a non-stable lane only for an allowed bearish symbol", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("INJUSDT")], {
        stableShortLaneActive: false,
        stableShortLanes: [
          {
            variantId: "CG_WIDE_STOP_TP_WIDE",
            status: "REJECT",
            freshValid: 50,
            netAvgR: -0.2,
            pf: 0.7,
            byAxisSymbol: [{ key: "SHORT_BEARISH|INJUSDT", n: 18, netAvgR: 0.22 }],
          },
        ],
        rotationShortlist: {
          generatedAt: "2026-07-05T04:00:00.000Z",
          minAllowSample: 10,
          minWatchSample: 5,
          bearishGlobal: [],
          bullishGlobal: [],
          lanes: [
            {
              laneId: realtimeShortSelectedLaneId("CG_WIDE_STOP_TP_WIDE"),
              variantId: "CG_WIDE_STOP_TP_WIDE",
              label: "Wide",
              bullish: [],
              bearish: [
                {
                  symbol: "INJUSDT",
                  n: 18,
                  netAvgR: 0.22,
                  pf: 2.1,
                  wr: 0.78,
                  score: 30,
                  verdict: "ALLOW",
                  reason: "test allow",
                },
              ],
            },
          ],
        },
      }),
      store,
    );
    expect(res.emitted).toBe(1);
    expect(store.all[0]!.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_STOP_TP_WIDE"));
  });

  it("[DIRECTION-GATE] emits candidates only when controller allows their direction", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([
        shortCand("BTCUSDT"),
        { symbol: "ETHUSDT", direction: "LONG", currentPrice: 100, stopLoss: 97, takeProfitLevels: [110] },
      ]),
      store,
    );
    expect(res.emitted).toBe(1);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.symbol).toBe("BTCUSDT");
    expect(store.all[0]!.direction).toBe("SHORT");
    // The long is rejected by the controller-direction gate (default inputs aren't a WIDE_TREND bull).
    expect(res.reasons.some((r) => r.startsWith("controller_blocks_LONG:ETHUSDT"))).toBe(true);
  });

  it("[FRESH] emitted order is born fresh (openedAt === createdAt === now) so it passes the no-stale gate", () => {
    const store = freshStore();
    runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { now: "2026-06-25T04:00:00.000Z" }), store);
    const o = store.all[0]!;
    expect(o.openedAt).toBe("2026-06-25T04:00:00.000Z");
    expect(o.createdAt).toBe("2026-06-25T04:00:00.000Z");
    expect(o.openedAt).toBe(o.createdAt);
  });

  it("[TAGGING] order is HEADLINE/CREATED, stable short lane, no diagnosticLabel, REALTIME_SHORT_MIRROR source, tp1_full", () => {
    const store = freshStore();
    runRealtimeShortMirror(inputs([shortCand("BTCUSDT")]), store);
    const o = store.all[0]!;
    expect(o.paperOrderMode).toBe("HEADLINE");
    expect(o.paperStatus).toBe("CREATED"); // MIRRORABLE
    expect(o.diagnosticLabel).toBeNull();
    expect(o.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_FAST_SHORT"));
    expect(o.sourceType).toBe("REALTIME_SHORT_MIRROR");
    expect(o.variantExitRule).toBe("tp1_full"); // bank 100% at TP1
    expect(o.entryPrice).toBe(100);
  });

  it("[SELECTOR] applies policy before score-only stable candidates (CG_WIDE_STOP_TP_WIDE cut from the split 2026-07-01)", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT", { currentPrice: 100, stopLoss: 104 })], {
        stableShortLaneActive: false,
        stableShortLanes: [
          { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.25, pf: 1.2 },
          { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.3, pf: 1.3 },
          { variantId: "CG_MFE_GIVEBACK", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.6, pf: 1.1 },
        ],
      }),
      store,
    );
    expect(res.emitted).toBe(1);
    const o = store.all[0]!;
    // CG_WIDE_FAST_SHORT wins even though CG_MFE_GIVEBACK and CG_WIDE_STOP_TP_WIDE score higher —
    // it is the sole SHORT policy target now, full stop, regardless of score.
    expect(o.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_FAST_SHORT"));
    expect(o.variantExitRule).toBe("tp1_full");
    expect(o.takeProfitLevels[0]).toBeCloseTo(98, 6); // 0.5R against a 4% wide stop
  });

  it("[EXP-MFE-DISABLED] ignores disabled EXP 10x MFE SHORT — CG_WIDE_FAST_SHORT is picked regardless", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("APTUSDT", { currentPrice: 100, stopLoss: 104 })], {
        stableShortLaneActive: false,
        controllerConfidence: "LOW",
        stableShortLanes: [
          { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "REJECT", freshValid: 38, netAvgR: -0.002, pf: 0.98 },
          { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.3, pf: 1.3 },
          { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.25, pf: 1.2 },
        ],
      }),
      store,
    );
    expect(res.emitted).toBe(1);
    const o = store.all[0]!;
    expect(o.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_FAST_SHORT"));
    expect(o.variantExitRule).toBe("tp1_full");
    expect(o.controllerConfidence).toBe("LOW");
  });

  it("[EXP-MFE-DISABLED] keeps EXP 10x MFE SHORT disabled (extended regime, CG_WIDE_FAST_SHORT picked)", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("DOGEUSDT", { currentPrice: 100, stopLoss: 104 })], {
        stableShortLaneActive: false,
        controllerConfidence: "MEDIUM",
        stableShortLanes: [
          { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "REJECT", freshValid: 38, netAvgR: -0.002, pf: 0.98 },
          { variantId: "CG_WIDE_STOP_TP_WIDE", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.3, pf: 1.3 },
          { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.25, pf: 1.2 },
        ],
      }),
      store,
    );
    expect(res.emitted).toBe(1);
    const o = store.all[0]!;
    expect(o.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_FAST_SHORT"));
  });

  it("[MANUAL-SHORTLIST] allows manual-only EXP 10x MFE SHORT when explicitly selected and symbol-shortlisted", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("SEIUSDT", { currentPrice: 0.5, stopLoss: 0.515 })], {
        stableShortLaneActive: false,
        stableShortLanes: [
          { variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X", status: "QUARANTINED", freshValid: 64, netAvgR: -0.3, pf: 0.9 },
        ],
        manualEnabledVariantIds: new Set(["CG_EXP_SHORT_MFE_GIVEBACK_10X"]),
        rotationShortlist: {
          generatedAt: "2026-07-05T04:00:00.000Z",
          minAllowSample: 10,
          minWatchSample: 5,
          bearishGlobal: [],
          bullishGlobal: [],
          lanes: [
            {
              laneId: realtimeShortSelectedLaneId("CG_EXP_SHORT_MFE_GIVEBACK_10X"),
              variantId: "CG_EXP_SHORT_MFE_GIVEBACK_10X",
              label: "EXP MFE",
              bullish: [],
              bearish: [
                {
                  symbol: "SEIUSDT",
                  n: 18,
                  netAvgR: 0.18,
                  pf: 2.4,
                  wr: 0.72,
                  score: 25,
                  verdict: "ALLOW",
                  reason: "test allow",
                },
              ],
            },
          ],
        },
      }),
      store,
    );
    expect(res.emitted).toBe(1);
    const o = store.all[0]!;
    expect(o.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_EXP_SHORT_MFE_GIVEBACK_10X"));
    expect(o.variantExitRule).toBe("mfe_giveback");
  });

  it("[ALLOWLIST] refuses downgraded lanes and maker-only lanes even when telemetry says stable", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT")], {
        stableShortLaneActive: false,
        stableShortLanes: [
          { variantId: "CG_MAKER_LIMIT_SIM", status: "STABLE_CANDIDATE", freshValid: 999, netAvgR: 9, pf: 9 },
          { variantId: "CG_WIDE_FAST_SHORT", status: "COLLECTING", freshValid: 999, netAvgR: 9, pf: 9 },
        ],
      }),
      store,
    );
    expect(res.emitted).toBe(0);
    expect(store.all).toHaveLength(0);
    expect(res.reasons).toContain("stable_lane_inactive");
    expect(REALTIME_SHORT_ALLOWED_VARIANT_IDS).toContain("CG_WIDE_FAST_SHORT");
    expect(REALTIME_SHORT_ALLOWED_VARIANT_IDS).toContain("CG_WIDE_STOP_TP_WIDE");
    expect(REALTIME_SHORT_ALLOWED_VARIANT_IDS).toContain("CG_MFE_GIVEBACK");
    expect(REALTIME_SHORT_ALLOWED_VARIANT_IDS).toContain("CG_TIGHT_FAST_05");
    expect(REALTIME_SHORT_ALLOWED_VARIANT_IDS).not.toContain("CG_EXP_LONG_MFE_GIVEBACK_10X");
    expect(REALTIME_SHORT_ALLOWED_VARIANT_IDS).not.toContain("CG_EXP_SHORT_MFE_GIVEBACK_10X");
    expect(REALTIME_SHORT_ALLOWED_VARIANT_IDS).not.toContain("CG_MAKER_LIMIT_SIM");
  });

  it("[STABLE-ONLY] refuses a previously allowed lane as soon as status is downgraded", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT")], {
        stableShortLaneActive: false,
        stableShortLanes: [
          { variantId: "CG_WIDE_FAST_SHORT", status: "WATCHABLE", freshValid: 999, netAvgR: 9, pf: 9 },
          { variantId: "CG_MFE_GIVEBACK", status: "HEADLINE_ACTIVE", freshValid: 999, netAvgR: 9, pf: 9 },
        ],
      }),
      store,
    );
    expect(res.emitted).toBe(0);
    expect(store.all).toHaveLength(0);
    expect(res.reasons).toContain("stable_lane_inactive");
  });

  it("[MIXED-SYMBOL-GATE] skips NEARUSDT in mixed regimes", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("NEARUSDT")], {
        regime: "Mixed rotation",
        controllerMode: "VALIDATION_ONLY",
        controllerConfidence: "LOW",
      }),
      store,
    );
    expect(res.emitted).toBe(0);
    expect(store.all).toHaveLength(0);
    expect(res.reasons).toContain("mixed_symbol_blocked:NEARUSDT");
  });

  it("[LONG] emits CG_WIDE_FAST_LONG (0.5R) long in a WIDE_TREND bull", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs(
        [{ symbol: "ETHUSDT", direction: "LONG", currentPrice: 100, stopLoss: 97, takeProfitLevels: [110] }],
        {
          regime: "Bullish expansion",
          controllerMode: "LONG_ONLY",
          controllerConfidence: "MEDIUM",
          stableShortLaneActive: false,
          stableShortLanes: [
            { variantId: "CG_WIDE_FAST_SHORT", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 9, pf: 9 },
          ],
        },
      ),
      store,
    );
    expect(res.emitted).toBe(1);
    const o = store.all[0]!;
    expect(o.direction).toBe("LONG");
    expect(o.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_FAST_LONG"));
    expect(o.stopLoss).toBeCloseTo(97, 6); // 300bps wide stop
    expect(o.takeProfitLevels[0]).toBeCloseTo(101.5, 6); // 0.5R target
  });

  it("[FORCE-LONG] without the force flag, FAST_LONG stays gated outside the strict WIDE_TREND+LONG estimate", () => {
    // 2026-07-07 operator ("buka akses CG_WIDE_FAST_LONG, gw mau trade di saat regime bullish"):
    // a plain bullish regime whose estimate still reads tactical produced ZERO long candidates.
    const tacticalBull = {
      regime: "Bullish expansion",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "MEDIUM",
      estimatedRegime: { posture: "TACTICAL_OR_MIXED", direction: "MIXED", policy: "TACTICAL_70_30", reason: "test" } as const,
      stableShortLaneActive: false,
      stableShortLanes: [],
    };
    const longCand = { symbol: "ETHUSDT", direction: "LONG" as const, currentPrice: 100, stopLoss: 97, takeProfitLevels: [110] };

    const gated = runRealtimeShortMirror(inputs([longCand], tacticalBull), freshStore());
    expect(gated.emitted).toBe(0);

    const store = freshStore();
    const forced = runRealtimeShortMirror(inputs([longCand], { ...tacticalBull, forceFastLong: true }), store);
    expect(forced.emitted).toBe(1);
    expect(store.all[0]!.direction).toBe("LONG");
    expect(store.all[0]!.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_FAST_LONG"));
  });

  it("[FORCE-LONG] the forced lane still respects the controller direction gate (no longs in SHORT_ONLY)", () => {
    const res = runRealtimeShortMirror(
      inputs(
        [{ symbol: "ETHUSDT", direction: "LONG", currentPrice: 100, stopLoss: 97, takeProfitLevels: [110] }],
        {
          regime: "Bearish pressure",
          controllerMode: "SHORT_ONLY",
          controllerConfidence: "MEDIUM",
          estimatedRegime: { posture: "TACTICAL_OR_MIXED", direction: "SHORT", policy: "TACTICAL_70_30", reason: "test" },
          forceFastLong: true,
          stableShortLaneActive: false,
          stableShortLanes: [],
        },
      ),
      freshStore(),
    );
    expect(res.emitted).toBe(0);
  });

  it("[GEOMETRY-COHERENT] derives stop + 0.5R TP from the live entry, ignoring the scanner's tp1", () => {
    const store = freshStore();
    // entry 100, stop 105 (5% > 300bps floor). scanner tp1 of 99.9 must be IGNORED.
    runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT", { currentPrice: 100, stopLoss: 105, takeProfitLevels: [99.9] })], {
        controllerConfidence: "MEDIUM",
      }),
      store,
    );
    const o = store.all[0]!;
    expect(o.stopLoss).toBeCloseTo(105, 6); // 100 * (1 + 0.05)
    expect(o.takeProfitLevels[0]).toBeCloseTo(97.5, 6); // 0.5R = 100 * (1 - 0.5*0.05)
    expect(o.plannedStopDistanceBps).toBeCloseTo(500, 3);
    // TP below entry, stop above entry — correct short geometry
    expect(o.takeProfitLevels[0]).toBeLessThan(o.entryPrice);
    expect(o.stopLoss).toBeGreaterThan(o.entryPrice);
  });

  it("[GEOMETRY-FLOOR] floors a too-tight stop to >=300bps (lane stopFloorBps)", () => {
    const store = freshStore();
    // raw stop only 0.5% away — must floor to 3% (300bps)
    runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT", { currentPrice: 100, stopLoss: 100.5 })], {
        controllerConfidence: "MEDIUM",
      }),
      store,
    );
    const o = store.all[0]!;
    expect(o.stopLoss).toBeCloseTo(103, 6); // floored to 3%
    expect(o.takeProfitLevels[0]).toBeCloseTo(98.5, 6); // 0.5 * 3%
  });

  it("[STABLE-GATE] emits nothing when the stable short lane is inactive", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { stableShortLaneActive: false, stableShortLanes: [] }), store);
    expect(res.emitted).toBe(0);
    expect(store.all).toHaveLength(0);
    expect(res.reasons).toContain("stable_lane_inactive");
  });

  it("[CONTROLLER-GATE] emits only when the controller allows shorts", () => {
    for (const mode of ["LONG_ONLY", "NO_TRADE_CHOP", "UNKNOWN"]) {
      const store = freshStore();
      const res = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { controllerMode: mode }), store);
      expect(res.emitted, `mode=${mode} must block`).toBe(0);
    }
    for (const mode of ["SHORT_ONLY", "BOTH_ALLOWED", "VALIDATION_ONLY"]) {
      const store = freshStore();
      const res = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { controllerMode: mode }), store);
      expect(res.emitted, `mode=${mode} must allow`).toBe(1);
    }
  });

  it("[GEOMETRY] drops candidates without valid executable geometry", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([
        shortCand("PASTSTOP", { currentPrice: 100, stopLoss: 97 }), // price already through the short stop
        shortCand("NOPRICE", { currentPrice: null }),
        shortCand("NOSTOP", { stopLoss: null }),
      ]),
      store,
    );
    expect(res.emitted).toBe(0);
    expect(store.all).toHaveLength(0);
    expect(res.reasons.some((r) => r.startsWith("CG_WIDE_STOP_TP_WIDE:geometry_failed:PASTSTOP"))).toBe(true);
    expect(res.reasons.some((r) => r.startsWith("bad_geometry:NOPRICE"))).toBe(true);
    expect(res.reasons.some((r) => r.startsWith("no_stop:NOSTOP"))).toBe(true);
  });

  it("[DEDUPE] does not emit the same symbol twice within the same minute bucket", () => {
    const store = freshStore();
    const first = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")]), store);
    const second = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")]), store);
    expect(first.emitted).toBe(1);
    expect(second.emitted).toBe(0);
    expect(second.reasons.some((r) => r.startsWith("duplicate:BTCUSDT"))).toBe(true);
    expect(store.all).toHaveLength(1);
  });

  it("[DEDUPE] re-emits the same symbol in a later minute bucket (fresh setup)", () => {
    const store = freshStore();
    runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { now: "2026-06-25T04:00:00.000Z" }), store);
    const later = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { now: "2026-06-25T04:07:00.000Z" }), store);
    expect(later.emitted).toBe(1);
    expect(store.all).toHaveLength(2);
  });

  it("[CAP] respects maxPerCycle", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(
      inputs([shortCand("A"), shortCand("B"), shortCand("C"), shortCand("D"), shortCand("E")], { maxPerCycle: 2 }),
      store,
    );
    expect(res.emitted).toBe(2);
    expect(store.all).toHaveLength(2);
    expect(res.reasons.some((r) => r.startsWith("cap_reached:"))).toBe(true);
  });

  it("[CLIENTID-SAFE] paperOrderId is short, charset-safe, and has a UNIQUE last-18 tail per symbol in the same cycle", () => {
    // Regression: the live engine builds Binance clientOrderIds from paperOrderId.slice(-18).
    // Two shorts in the SAME cycle must not share that tail, or the stop order fails with
    // -4116 "ClientOrderId is duplicated" → emergency flatten → loss.
    const now = "2026-06-25T04:30:00.000Z";
    const ids = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"].map((s) =>
      makeRealtimeShortPaperOrderId(s, now),
    );
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]{1,18}$/); // charset-safe, short, no colons
      expect(id.length).toBeLessThanOrEqual(18);
    }
    const tails = ids.map((id) => id.slice(-18));
    expect(new Set(tails).size).toBe(ids.length); // all tails distinct → no clientOrderId collision
  });

  it("[CLIENTID-SAFE] emitted orders in one cycle carry distinct slice(-18) tails", () => {
    const store = freshStore();
    runRealtimeShortMirror(inputs([shortCand("SOLUSDT"), shortCand("ETHUSDT"), shortCand("LINKUSDT")]), store);
    const tails = store.all.map((o) => o.paperOrderId.slice(-18));
    expect(new Set(tails).size).toBe(store.all.length);
    expect(store.all.every((o) => /^[a-z0-9-]{1,18}$/.test(o.paperOrderId))).toBe(true);
  });

  it("[ENABLED] env flag is read strictly", () => {
    expect(isRealtimeShortMirrorEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isRealtimeShortMirrorEnabled({ REALTIME_SHORT_MIRROR_ENABLED: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isRealtimeShortMirrorEnabled({ REALTIME_SHORT_MIRROR_ENABLED: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  // 2026-07-08 (operator: "wire lane baru ke allocation selection") — CG_WIDE_LONG_RUNNER and
  // CG_MFE_GIVEBACK need to be force-liftable to STABLE_CANDIDATE the same way FAST_SHORT/FAST_LONG
  // already are, or the regime-autopilot's new preset entries would allocate a lane that can never
  // actually emit a real-time signal.
  it("[FORCE-ELIGIBLE] the default sets are UNCHANGED — only FAST_SHORT/FAST_LONG, exactly as before", () => {
    // 2026-07-08: deliberately did NOT add new lanes here directly — see [ALLOCATION-FORCE] below
    // for why (it regressed the FORCE-LONG guarantee when tried). manualEnabledVariantIds is the
    // mechanism instead, gated on an ACTUAL operator/preset allocation being active.
    expect([...FORCE_ELIGIBLE_SHORT_VARIANT_IDS]).toEqual(["CG_WIDE_FAST_SHORT"]);
    expect([...FORCE_ELIGIBLE_LONG_VARIANT_IDS]).toEqual(["CG_WIDE_FAST_LONG"]);
  });

  it("[ALLOCATION-FORCE] a lane with no allocation active stays gated even outside WIDE_TREND+LONG (unchanged default)", () => {
    const tacticalBull = {
      regime: "Bullish expansion",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "MEDIUM",
      estimatedRegime: { posture: "TACTICAL_OR_MIXED", direction: "MIXED", policy: "TACTICAL_70_30", reason: "test" } as const,
      stableShortLaneActive: false,
      stableShortLanes: [],
    };
    const longCand = { symbol: "ETHUSDT", direction: "LONG" as const, currentPrice: 100, stopLoss: 97, takeProfitLevels: [110] };
    const result = runRealtimeShortMirror(inputs([longCand], tacticalBull), freshStore());
    expect(result.emitted).toBe(0); // CG_WIDE_LONG_RUNNER never force-lifted without an explicit allocation
  });

  it("[ALLOCATION-FORCE] an explicit manualEnabledVariantIds allocation force-lifts + wins the slot for that variant", () => {
    const tacticalBull = {
      regime: "Bullish expansion",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "MEDIUM",
      estimatedRegime: { posture: "TACTICAL_OR_MIXED", direction: "MIXED", policy: "TACTICAL_70_30", reason: "test" } as const,
      stableShortLaneActive: false,
      stableShortLanes: [],
    };
    const longCand = { symbol: "ETHUSDT", direction: "LONG" as const, currentPrice: 100, stopLoss: 97, takeProfitLevels: [110] };
    const store = freshStore();
    const result = runRealtimeShortMirror(
      inputs([longCand], { ...tacticalBull, manualEnabledVariantIds: new Set(["CG_WIDE_LONG_RUNNER"]) }),
      store,
    );
    expect(result.emitted).toBe(1);
    expect(store.all[0]!.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_LONG_RUNNER"));
  });

  it("[ALLOCATION-FORCE] does NOT disturb the existing FAST_LONG force-flag guarantee when both are active", () => {
    // Regression guard: adding manualEnabledVariantIds force-lifting must not make an unrelated
    // allocated lane steal FAST_LONG's forced slot when FAST_LONG's OWN force flag is what's set.
    const tacticalBull = {
      regime: "Bullish expansion",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "MEDIUM",
      estimatedRegime: { posture: "TACTICAL_OR_MIXED", direction: "MIXED", policy: "TACTICAL_70_30", reason: "test" } as const,
      stableShortLaneActive: false,
      stableShortLanes: [],
      forceFastLong: true,
    };
    const longCand = { symbol: "ETHUSDT", direction: "LONG" as const, currentPrice: 100, stopLoss: 97, takeProfitLevels: [110] };
    const store = freshStore();
    const result = runRealtimeShortMirror(inputs([longCand], tacticalBull), store);
    expect(result.emitted).toBe(1);
    expect(store.all[0]!.selectedLaneId).toBe(realtimeShortSelectedLaneId("CG_WIDE_FAST_LONG"));
  });

  // 2026-07-08 audit fix: allowTacticalLongs used to be a blanket "manualEnabledVariantIds is
  // non-empty" check — allocating an unrelated SHORT-only lane (e.g. CG_WIDE_FAST_SHORT) would
  // incidentally ALSO unlock tactical longs the operator never asked for. Must stay scoped to an
  // allocation that actually contains a LONG-capable variant.
  it("[ALLOCATION-FORCE] a SHORT-only allocation does NOT unlock tactical longs outside WIDE_TREND", () => {
    // CG_WIDE_FAST_LONG is ALREADY naturally STABLE_CANDIDATE here (not force-lifted) — isolates
    // the test to policyBlockReason's tactical-longs check specifically: with the buggy blanket
    // "manualEnabledVariantIds.size > 0" version this lane would still get selected (the block
    // lifts even though nothing LONG-capable was allocated); with the fix it must stay blocked.
    const tacticalBull = {
      regime: "Bullish expansion",
      controllerMode: "LONG_ONLY",
      controllerConfidence: "MEDIUM",
      estimatedRegime: { posture: "TACTICAL_OR_MIXED", direction: "MIXED", policy: "TACTICAL_70_30", reason: "test" } as const,
      stableShortLaneActive: false,
      stableShortLanes: [{ variantId: "CG_WIDE_FAST_LONG", status: "STABLE_CANDIDATE", freshValid: 200, netAvgR: 0.28, pf: 1.5 }],
      manualEnabledVariantIds: new Set(["CG_WIDE_FAST_SHORT"]), // SHORT-only — no LONG-capable variant allocated
    };
    const longCand = { symbol: "ETHUSDT", direction: "LONG" as const, currentPrice: 100, stopLoss: 97, takeProfitLevels: [110] };
    const result = runRealtimeShortMirror(inputs([longCand], tacticalBull), freshStore());
    expect(result.emitted).toBe(0); // tactical-longs block stays in place — nothing LONG-capable was allocated
  });
});

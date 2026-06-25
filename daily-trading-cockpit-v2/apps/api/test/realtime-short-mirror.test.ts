import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperExecutionRouterStore } from "../src/lib/paper-execution-router.js";
import {
  runRealtimeShortMirror,
  isRealtimeShortMirrorEnabled,
  makeRealtimeShortPaperOrderId,
  REALTIME_SHORT_SELECTED_LANE_ID,
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

function inputs(
  candidates: RealtimeShortCandidate[],
  over: Partial<RealtimeShortMirrorInputs> = {},
): RealtimeShortMirrorInputs {
  return {
    candidates,
    regime: "Bearish pressure",
    controllerMode: "SHORT_ONLY",
    stableShortLaneActive: true,
    now: "2026-06-25T04:00:00.000Z",
    ...over,
  };
}

describe("realtime-short-mirror — fresh short live-mirror source (mode 2)", () => {
  it("[SHORT-ONLY] emits SHORT candidates and drops LONG ones", () => {
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
    expect(res.reasons.some((r) => r.startsWith("not_short:ETHUSDT"))).toBe(true);
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
    expect(o.selectedLaneId).toBe(REALTIME_SHORT_SELECTED_LANE_ID);
    expect(o.sourceType).toBe("REALTIME_SHORT_MIRROR");
    expect(o.variantExitRule).toBe("tp1_full"); // bank 100% at TP1
    expect(o.entryPrice).toBe(100);
  });

  it("[GEOMETRY-COHERENT] derives stop + 0.5R TP from the live entry, ignoring the scanner's tp1", () => {
    const store = freshStore();
    // entry 100, stop 105 (5% > 300bps floor). scanner tp1 of 99.9 must be IGNORED.
    runRealtimeShortMirror(
      inputs([shortCand("BTCUSDT", { currentPrice: 100, stopLoss: 105, takeProfitLevels: [99.9] })]),
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
      inputs([shortCand("BTCUSDT", { currentPrice: 100, stopLoss: 100.5 })]),
      store,
    );
    const o = store.all[0]!;
    expect(o.stopLoss).toBeCloseTo(103, 6); // floored to 3%
    expect(o.takeProfitLevels[0]).toBeCloseTo(98.5, 6); // 0.5 * 3%
  });

  it("[STABLE-GATE] emits nothing when the stable short lane is inactive", () => {
    const store = freshStore();
    const res = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { stableShortLaneActive: false }), store);
    expect(res.emitted).toBe(0);
    expect(store.all).toHaveLength(0);
    expect(res.reasons).toContain("stable_short_lane_inactive");
  });

  it("[CONTROLLER-GATE] emits only when the controller allows shorts", () => {
    for (const mode of ["LONG_ONLY", "NO_TRADE_CHOP", "VALIDATION_ONLY", "UNKNOWN"]) {
      const store = freshStore();
      const res = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { controllerMode: mode }), store);
      expect(res.emitted, `mode=${mode} must block`).toBe(0);
    }
    for (const mode of ["SHORT_ONLY", "BOTH_ALLOWED"]) {
      const store = freshStore();
      const res = runRealtimeShortMirror(inputs([shortCand("BTCUSDT")], { controllerMode: mode }), store);
      expect(res.emitted, `mode=${mode} must allow`).toBe(1);
    }
  });

  it("[GEOMETRY] drops shorts without a valid stop above the live price", () => {
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
    expect(res.reasons.some((r) => r.startsWith("no_short_stop:PASTSTOP"))).toBe(true);
    expect(res.reasons.some((r) => r.startsWith("bad_geometry:NOPRICE"))).toBe(true);
    expect(res.reasons.some((r) => r.startsWith("no_short_stop:NOSTOP"))).toBe(true);
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
});

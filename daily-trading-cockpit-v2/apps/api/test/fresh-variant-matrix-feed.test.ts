import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import {
  CurrentGuardVariantMatrixStore,
  buildVariantMatrixObservationsForSignal,
  type VariantMatrixSignal,
} from "../src/lib/current-guard-variant-matrix.js";
import {
  runFreshVariantMatrixFeed,
  buildFreshVariantMatrixReport,
  freshFeedRegimeContext,
  type FreshFeedCandidate,
} from "../src/lib/fresh-variant-matrix-feed.js";

const dirs: string[] = [];
let n = 0;
function tmpStore(): CurrentGuardVariantMatrixStore {
  const dir = resolve(os.tmpdir(), `fresh-feed-${process.pid}-${++n}`);
  dirs.push(dir);
  return new CurrentGuardVariantMatrixStore(dir);
}
afterEach(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

const NOW = "2026-06-29T14:30:42.000Z";
const shortCand = (symbol: string): FreshFeedCandidate => ({
  symbol, direction: "SHORT", entryPrice: 100, stopLoss: 103, takeProfitLevels: [98.5], stopDistanceBps: 300,
});
const longCand = (symbol: string): FreshFeedCandidate => ({
  symbol, direction: "LONG", entryPrice: 100, stopLoss: 97, takeProfitLevels: [101.5], stopDistanceBps: 300,
});

describe("fresh-variant-matrix-feed", () => {
  it("[FRESH] entries are stamped fresh — isFreshValid true, entryLag ≈ 0", () => {
    const store = tmpStore();
    runFreshVariantMatrixFeed({ candidates: [shortCand("BTCUSDT")], regime: "Bearish pressure", controllerMode: "SHORT_ONLY", controllerConfidence: "MEDIUM", now: NOW }, store);
    const open = store.all.filter((o) => o.status === "OPEN");
    expect(open.length).toBeGreaterThan(0);
    for (const o of open) {
      expect(o.isFreshValid).toBe(true);
      expect(o.entryLagMinutes).not.toBeNull();
      expect(o.entryLagMinutes!).toBeLessThanOrEqual(10);
    }
  });

  it("[BOTH-DIRECTIONS + POSTURE] longs AND shorts accrue, tagged with posture + regimeDirection", () => {
    const store = tmpStore();
    const res = runFreshVariantMatrixFeed({ candidates: [shortCand("BTCUSDT"), longCand("ETHUSDT")], regime: "Bearish pressure", controllerMode: "SHORT_ONLY", controllerConfidence: "MEDIUM", now: NOW }, store);
    expect(res.signalsCreated).toBe(2); // long no longer dropped at the measurement layer
    const dirs = new Set(store.all.map((o) => o.direction));
    expect(dirs.has("LONG")).toBe(true);
    expect(dirs.has("SHORT")).toBe(true);
    // Bearish pressure + MEDIUM confidence ⇒ EXTENDED / SHORT regime context, stamped on every obs.
    expect(res.posture).toBe("EXTENDED");
    expect(res.regimeDirection).toBe("SHORT");
    for (const o of store.all) {
      expect(o.posture).toBe("EXTENDED");
      expect(o.regimeDirection).toBe("SHORT");
    }
  });

  it("[POSTURE] mixed/low-confidence regime ⇒ TACTICAL / MIXED", () => {
    expect(freshFeedRegimeContext("Mixed rotation", "VALIDATION_ONLY", "LOW")).toEqual({ posture: "TACTICAL", regimeDirection: "MIXED" });
    expect(freshFeedRegimeContext("Bullish expansion", "LONG_ONLY", "HIGH")).toEqual({ posture: "EXTENDED", regimeDirection: "LONG" });
  });

  it("[GEOMETRY-GATE] rejects candidates whose stop/tp don't match the direction", () => {
    const store = tmpStore();
    const bad: FreshFeedCandidate = { symbol: "X", direction: "SHORT", entryPrice: 100, stopLoss: 97, takeProfitLevels: [101.5] }; // short with stop BELOW entry
    const res = runFreshVariantMatrixFeed({ candidates: [bad], regime: "Bearish pressure", controllerMode: "SHORT_ONLY", now: NOW }, store);
    expect(res.signalsCreated).toBe(0);
    expect(res.reasons.some((r) => r.startsWith("bad_geometry:X"))).toBe(true);
  });

  it("[DEDUPE] same symbol|direction within a minute is not duplicated", () => {
    const store = tmpStore();
    runFreshVariantMatrixFeed({ candidates: [shortCand("BTCUSDT")], regime: "Bearish pressure", controllerMode: "SHORT_ONLY", now: NOW }, store);
    const before = store.all.length;
    const res2 = runFreshVariantMatrixFeed({ candidates: [shortCand("BTCUSDT")], regime: "Bearish pressure", controllerMode: "SHORT_ONLY", now: "2026-06-29T14:30:58.000Z" }, store);
    expect(res2.signalsCreated).toBe(0);
    expect(res2.reasons.some((r) => r.startsWith("duplicate:BTCUSDT"))).toBe(true);
    expect(store.all.length).toBe(before);
  });

  it("[FRESHVALID-HONEST] a STALE entry yields isFreshValid=false (not the old hardcoded true)", () => {
    const stale: VariantMatrixSignal = {
      sourceSignalId: "s", symbol: "BTCUSDT", direction: "SHORT", entryPrice: 100, stopLoss: 103, tp1: 98.5,
      tp2: null, tp3: null, stopDistanceBps: 300, regime: "Bearish pressure", entryVariant: null,
      openedAt: "2026-06-29T08:30:00.000Z", closedAt: null, // 6h before NOW
    };
    const obs = buildVariantMatrixObservationsForSignal(stale, NOW).filter((o) => o.status === "OPEN");
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) {
      expect(o.entryLagMinutes!).toBeGreaterThanOrEqual(360); // ~6h stale
      expect(o.isFreshValid).toBe(false);
    }
  });

  it("[REPORT] fresh-only buckets by direction×posture with risk-normalized dollars", () => {
    const store = tmpStore();
    // hand-place resolved fresh obs of both directions/postures
    const mk = (variantId: string, direction: "LONG" | "SHORT", posture: "TACTICAL" | "EXTENDED", netR: number) => ({
      observationId: `${variantId}-${direction}-${posture}-${netR}-${Math.abs(netR)}`,
      variantId, variantVersion: undefined as never, sourceSignalId: "s", sourceObservationKey: `${direction}|${posture}`,
      symbol: "BTCUSDT", direction, regime: "x", entryVariant: null, createdAt: NOW, openedAt: NOW, resolvedAt: NOW,
      originalEntryPrice: 100, originalStopLoss: 103, originalTakeProfitLevels: [98.5],
      simulatedEntryPrice: 100, simulatedStopLoss: 103, simulatedTakeProfitLevels: [98.5], stopDistanceBps: 300,
      exitRule: "tp1_full" as const, fillMode: "taker" as const, costModel: "taker" as const,
      costR: 0.07, grossR: netR + 0.07, netR, status: "CLOSED_WIN" as const, maxMfeR: null, minMaeR: null,
      durationMinutes: 120, resolutionSource: "x", intrabarResolutionStatus: "VALID_5M_ORDERED" as never,
      entryLagMinutes: 1, isFreshValid: true, posture, regimeDirection: "SHORT" as const,
      reportOnly: true as const, laneVersion: undefined as never,
    });
    store.addMany([
      mk("CG_WIDE_FAST_SHORT", "SHORT", "EXTENDED", 0.2),
      mk("CG_WIDE_FAST_SHORT", "SHORT", "TACTICAL", 0.1),
      mk("CG_WIDE_FAST_LONG", "LONG", "EXTENDED", -0.1),
    ] as never);
    const rep = buildFreshVariantMatrixReport(store);
    expect(rep.freshValid).toBe(3);
    const shortExt = rep.byBucket.find((b) => b.tradeDirection === "SHORT" && b.posture === "EXTENDED")!;
    expect(shortExt.n).toBe(1);
    expect(shortExt.netUsdPer100Risk).toBeCloseTo(20, 6); // 0.2R × $100
    const longExt = rep.byBucket.find((b) => b.tradeDirection === "LONG" && b.posture === "EXTENDED")!;
    expect(longExt.netUsdPer100Risk).toBeCloseTo(-10, 6);
  });
});

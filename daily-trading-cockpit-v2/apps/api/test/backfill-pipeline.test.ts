import { describe, it, expect } from "vitest";
import { reconstructAsOf, projectVector } from "../src/lib/backfill-asof.js";
import { computeOutcomeR, CORTEX_WIN_HURDLE_R } from "../src/lib/backfill-outcome.js";
import { attributeHistorical } from "../src/lib/backfill-attribution.js";
import { classifyObservation } from "../src/lib/backfill-classify.js";
import { exitTarget, directionTarget, entryTarget, assembleFamily } from "../src/lib/backfill-datasets.js";
import { planWalkForward, brierScore, maxDrawdownR, concentration, decisionAlpha, realityGapProxy } from "../src/lib/backfill-walkforward.js";
import { fitLogisticL2, predictLogistic, warmStartGuards, LIVE_SHADOW_FLOOR_DAYS } from "../src/lib/backfill-warmstart.js";
import { buildReconciliation } from "../src/lib/backfill-reconciliation.js";
import { encodeBias, encodeConfidence, paperExecutionAdapter, xsecAdapter, kronosCounterfactualAdapter, regimeSnapshotAdapter, XSEC_BASKET_STOP_FRACTION } from "../src/lib/backfill-adapters.js";
import { preRegisteredDecisionMetrics, quantile } from "../src/lib/backfill-walkforward.js";
import type { HistoricalDecision, HistoricalOutcome } from "../src/lib/backfill-schema.js";

const T = 1_700_000_000_000;
const MIN = 60_000;

describe("backfill: as-of reconstruction (no look-ahead)", () => {
  it("rejects a feature observed AFTER the decision (future leak)", () => {
    const r = reconstructAsOf([{ key: "a", value: 1, observedAtMs: T + MIN }], T);
    expect(r.present.a).toBeUndefined();
    expect(r.futureLeak).toEqual([{ key: "a", observedAtMs: T + MIN }]);
  });
  it("rejects a feature with unknown provenance (observedAt null)", () => {
    const r = reconstructAsOf([{ key: "a", value: 1, observedAtMs: null }], T);
    expect(r.unknownProvenance).toContain("a");
    expect(r.present.a).toBeUndefined();
  });
  it("keeps a feature knowable at/before the decision; drops null-valued", () => {
    const r = reconstructAsOf([{ key: "a", value: 2, observedAtMs: T - MIN }, { key: "b", value: null, observedAtMs: T - MIN }], T);
    expect(r.present.a).toBe(2);
    expect(r.nullValue).toContain("b");
  });
  it("projectVector returns null when a required feature is absent (⇒ MISSING_FEATURES)", () => {
    const r = reconstructAsOf([{ key: "a", value: 2, observedAtMs: T - MIN }], T);
    expect(projectVector(r, ["a", "b"])).toBeNull();
    expect(projectVector(r, ["a"])).toEqual([2]);
  });
});

describe("backfill: outcome (netR + hurdle + risk denominator)", () => {
  const base = { sourceId: "s", schemaVersion: 1, outcomeId: "o", laneId: "L", symbolOrBasket: null, side: "LONG" as const, openedAtMs: T, resolvedAtMs: T + MIN };
  it("native-R: uses netR and applies the 0.03R win hurdle", () => {
    expect(computeOutcomeR({ ...base, netR: 0.5, grossR: null, costR: null, riskDistanceAtOpen: null })).toMatchObject({ ok: true, y: 1 });
    expect(computeOutcomeR({ ...base, netR: 0.02, grossR: null, costR: null, riskDistanceAtOpen: null })).toMatchObject({ ok: true, y: 0 }); // fee-scratch < hurdle
    expect(CORTEX_WIN_HURDLE_R).toBe(0.03);
  });
  it("return-based: divides (gross−cost) by riskDistanceAtOpen", () => {
    const r = computeOutcomeR({ ...base, netR: null, grossR: 0.01, costR: 0.001, riskDistanceAtOpen: 0.003 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.netR).toBeCloseTo((0.01 - 0.001) / 0.003);
  });
  it("rejects a missing / non-finite / ≤0 risk denominator on the return-based path", () => {
    expect(computeOutcomeR({ ...base, netR: null, grossR: 0.01, costR: 0, riskDistanceAtOpen: null })).toMatchObject({ ok: false, reason: "risk-denominator-missing" });
    expect(computeOutcomeR({ ...base, netR: null, grossR: 0.01, costR: 0, riskDistanceAtOpen: 0 })).toMatchObject({ ok: false, reason: "risk-denominator-nonpositive" });
    expect(computeOutcomeR({ ...base, netR: null, grossR: 0.01, costR: 0, riskDistanceAtOpen: -1 })).toMatchObject({ ok: false, reason: "risk-denominator-nonpositive" });
  });
  it("rejects missing or non-finite execution cost instead of assuming zero cost", () => {
    expect(computeOutcomeR({ ...base, netR: null, grossR: 0.01, costR: null, riskDistanceAtOpen: 0.003 })).toMatchObject({ ok: false, reason: "cost-missing" });
    expect(computeOutcomeR({ ...base, netR: null, grossR: 0.01, costR: Number.NaN, riskDistanceAtOpen: 0.003 })).toMatchObject({ ok: false, reason: "cost-nonfinite" });
  });
});

function dec(o: Partial<HistoricalDecision>): HistoricalDecision {
  return { sourceId: "d", schemaVersion: 1, decisionId: "d", atMs: T, laneId: "L", symbolOrBasket: "BTC", side: "LONG", regimeFamily: "TREND", eligible: true, features: [], ...o };
}
function out(o: Partial<HistoricalOutcome>): HistoricalOutcome {
  return { sourceId: "o", schemaVersion: 1, outcomeId: "o1", laneId: "L", symbolOrBasket: "BTC", side: "LONG", openedAtMs: T + MIN, resolvedAtMs: T + 10 * MIN, netR: 0.5, grossR: null, costR: null, riskDistanceAtOpen: null, ...o };
}

describe("backfill: strict attribution", () => {
  it("attributes an outcome to the LATEST eligible pre-open decision within TTL", () => {
    const decisions = [dec({ decisionId: "old", atMs: T - 40 * MIN }), dec({ decisionId: "new", atMs: T })];
    const r = attributeHistorical(decisions, [out({})], { schemaVersion: 1, ttlMsForLane: () => 50 * MIN });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.decision.decisionId).toBe("new");
  });
  it("a decision AFTER the open can never own it", () => {
    const r = attributeHistorical([dec({ atMs: T + 5 * MIN })], [out({ openedAtMs: T })], { schemaVersion: 1 });
    expect(r.counts.attributed).toBe(0);
    expect(r.counts.noDecision).toBe(1);
  });
  it("consumes an outcomeId only once (duplicate dropped, counted)", () => {
    const o = out({});
    const r = attributeHistorical([dec({})], [o, o], { schemaVersion: 1 });
    expect(r.counts.attributed).toBe(1);
    expect(r.counts.duplicate).toBe(1);
  });
  it("counts a stale-schema-only owner as schema-mismatch (not a silent drop)", () => {
    const r = attributeHistorical([dec({ schemaVersion: 99 })], [out({})], { schemaVersion: 1 });
    expect(r.counts.attributed).toBe(0);
    expect(r.counts.schemaMismatch).toBe(1);
  });
  it("matchLane:false lets a market-wide decision own a per-lane outcome by time", () => {
    const r = attributeHistorical([dec({ laneId: "MARKET", symbolOrBasket: null, side: null })], [out({ laneId: "SOME_LANE" })], { schemaVersion: 1, matchLane: false, matchSymbol: false, matchSide: false });
    expect(r.counts.attributed).toBe(1);
  });
  it("rejects an outcome whose resolvedAt precedes its openedAt (bad timestamps)", () => {
    const r = attributeHistorical([dec({})], [out({ openedAtMs: T + 10 * MIN, resolvedAtMs: T })], { schemaVersion: 1 });
    expect(r.counts.badTimestamps).toBe(1);
  });
});

describe("backfill: classification (one class per row, strict precedence)", () => {
  const b = { ownerFound: true, schemaMismatchOnly: false, labelSafe: true, trainingVectorComplete: true, replayOnly: false };
  it("VALID_FOR_TRAINING when all sound", () => { expect(classifyObservation(b).klass).toBe("VALID_FOR_TRAINING"); });
  it("LABEL_UNSAFE when outcome label rejected", () => { expect(classifyObservation({ ...b, labelSafe: false }).klass).toBe("LABEL_UNSAFE"); });
  it("SCHEMA_MISMATCH when only a stale-schema owner existed", () => { expect(classifyObservation({ ...b, ownerFound: false, schemaMismatchOnly: true }).klass).toBe("SCHEMA_MISMATCH"); });
  it("LABEL_UNSAFE when no owner at all", () => { expect(classifyObservation({ ...b, ownerFound: false }).klass).toBe("LABEL_UNSAFE"); });
  it("MISSING_FEATURES when the training vector is incomplete", () => { expect(classifyObservation({ ...b, trainingVectorComplete: false }).klass).toBe("MISSING_FEATURES"); });
  it("VALID_FOR_REPLAY_ONLY when sound but withheld", () => { expect(classifyObservation({ ...b, replayOnly: true }).klass).toBe("VALID_FOR_REPLAY_ONLY"); });
});

describe("backfill: dataset targets", () => {
  const o = out({});
  it("exitTarget maps resolver state to HOLD/SCALE_OUT/TRAIL/EXIT; null when no state", () => {
    expect(exitTarget({ ...o, exitReason: "stop_hit" })).toBe("EXIT");
    expect(exitTarget({ ...o, tp1Hit: true, exitReason: null })).toBe("SCALE_OUT");
    expect(exitTarget({ ...o, slToBreakeven: true, exitReason: null })).toBe("TRAIL");
    expect(exitTarget({ ...o, tp1Hit: false, tp2Hit: false, slToBreakeven: false, exitReason: "natural" })).toBe("HOLD");
    expect(exitTarget({ ...o })).toBeNull(); // no resolver state at all
  });
  it("directionTarget/entryTarget", () => {
    expect(directionTarget("LONG", null)).toBe("LONG");
    expect(directionTarget(null, "FLAT")).toBe("FLAT");
    expect(entryTarget(null, true)).toBe("ENTER_NOW");
    expect(entryTarget("SKIP", false)).toBe("SKIP");
  });
  it("assembleFamily tallies classes + carries unsupported honestly", () => {
    const fam = assembleFamily("EXIT", ["a"], ["HOLD", "EXIT"], [{ tMs: T, laneId: "L", symbolOrBasket: null, side: null, x: [1], netR: 0.1, y: "HOLD", klass: "VALID_FOR_TRAINING" }], ["mfe unavailable"]);
    expect(fam.trainableRows).toBe(1);
    expect(fam.unsupported).toContain("mfe unavailable");
  });
});

describe("backfill: walk-forward + metrics", () => {
  it("splits chronologically with NO leak (every train time < its test times) and reserves a final holdout", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ tMs: T + i * MIN, id: i }));
    const plan = planWalkForward(rows, 3, 0.25);
    expect(plan.holdoutIdx.length).toBeGreaterThan(0);
    for (const f of plan.folds) {
      const maxTrain = Math.max(...f.trainIdx.map((i) => plan.sorted[i]!.tMs));
      const minTest = Math.min(...f.testIdx.map((i) => plan.sorted[i]!.tMs));
      expect(maxTrain).toBeLessThan(minTest); // strictly past→future
    }
    // holdout is never in any fold's train or test
    const used = new Set(plan.folds.flatMap((f) => [...f.trainIdx, ...f.testIdx]));
    for (const h of plan.holdoutIdx) expect(used.has(h)).toBe(false);
  });
  it("brier / drawdown / concentration / decision-alpha compute", () => {
    expect(brierScore([{ p: 1, y: 1 }, { p: 0, y: 0 }])).toBe(0);
    expect(maxDrawdownR([1, -3, 1])).toBe(3);
    expect(concentration(new Map([["a", 9], ["b", 1]])).topShare).toBeCloseTo(0.9);
    expect(decisionAlpha([1, 1], [0, 0])).toBe(1);
    expect(realityGapProxy([{ grossR: 1, costR: 0.1 }]).meanCostR).toBeCloseTo(0.1);
  });
});

describe("backfill: warm-start (shadow-only, floor honored)", () => {
  it("learns a separable pattern and predicts it", () => {
    const X = [[-2], [-1], [1], [2], [-3], [3]];
    const y: Array<0 | 1> = [0, 0, 1, 1, 0, 1];
    const m = fitLogisticL2(X, y, ["f"], { l2: 0.01, iters: 2000 });
    expect(predictLogistic(m, [3])!).toBeGreaterThan(predictLogistic(m, [-3])!);
  });
  it("60-day floor is NEVER met by short history; candidate is never promotable", () => {
    const g = warmStartGuards(21 * 86_400_000);
    expect(g.daysOfData).toBeCloseTo(21);
    expect(g.sixtyDayFloorMet).toBe(false);
    expect(g.promotable).toBe(false);
    expect(g.liveBetaUnchanged).toBe(true);
    expect(warmStartGuards((LIVE_SHADOW_FLOOR_DAYS + 1) * 86_400_000).sixtyDayFloorMet).toBe(true);
    // even when the floor IS met, history alone never auto-promotes (needs separate approval)
    expect(warmStartGuards((LIVE_SHADOW_FLOOR_DAYS + 1) * 86_400_000).promotable).toBe(false);
  });
});

describe("backfill: reconciliation funnel (arithmetic self-check)", () => {
  it("reconciles when every row is accounted for", () => {
    const f = buildReconciliation({
      rawRows: 100, parseDrops: { bad: 10 },
      attributionDrops: { "no-eligible-decision": 20 },
      attributedClassCounts: { VALID_FOR_TRAINING: 50, VALID_FOR_REPLAY_ONLY: 5, MISSING_FEATURES: 10, LABEL_UNSAFE: 5, SCHEMA_MISMATCH: 0 },
    });
    expect(f.eligible).toBe(90);
    expect(f.attributed).toBe(70);
    expect(f.trainingValid).toBe(50);
    expect(f.reconciles).toBe(true);
  });
  it("flags a discrepancy when class counts do not sum to attributed", () => {
    const f = buildReconciliation({ rawRows: 10, parseDrops: {}, attributionDrops: {}, attributedClassCounts: { VALID_FOR_TRAINING: 3, VALID_FOR_REPLAY_ONLY: 0, MISSING_FEATURES: 0, LABEL_UNSAFE: 0, SCHEMA_MISMATCH: 0 } });
    expect(f.reconciles).toBe(false);
  });
});

describe("backfill: source adapters", () => {
  it("encodeBias keeps MIXED (→0), drops UNKNOWN (→null); encodeConfidence ordinal", () => {
    expect(encodeBias("LONG")).toBe(1);
    expect(encodeBias("MIXED")).toBe(0);
    expect(encodeBias("UNKNOWN")).toBeNull();
    expect(encodeConfidence("MEDIUM")).toBeCloseTo(0.66);
    expect(encodeConfidence("LOW")).toBeCloseTo(0.33);
  });
  it("paper-execution adapter yields a native-R outcome only when resolved", () => {
    const ok = paperExecutionAdapter.toOutcome!({ paperOrderId: "p1", openedAt: T, updatedAt: T + MIN, netR: 0.4, direction: "LONG", symbol: "BTCUSDT" });
    expect(ok).toMatchObject({ outcomeId: "p1", netR: 0.4, side: "LONG" });
    expect(paperExecutionAdapter.toOutcome!({ paperOrderId: "p2", openedAt: T, netR: null })).toBeNull(); // unresolved
  });
  it("XSEC adapter falls back to the fixed basket stop as the frozen denominator (not fabricated)", () => {
    const o = xsecAdapter.toOutcome!({ observationId: "x1", openedAtMs: T, resolvedAt: T + MIN, grossReturn: -0.007, costReturn: 0.0012 });
    expect(o?.riskDistanceAtOpen).toBeCloseTo(XSEC_BASKET_STOP_FRACTION);
    expect(o?.netR).toBeNull(); // return-based ⇒ divided downstream
  });
  it("regime snapshot adapter emits a market-wide decision with as-of features", () => {
    const d = regimeSnapshotAdapter.toDecision!({ capturedAt: T, currentRegime: "Bullish expansion", directionalBias: "LONG", confidence: "MEDIUM", allowsLong: true, allowsShort: false, allowsNewEntries: true });
    expect(d?.laneId).toBe("MARKET");
    expect(d?.features.every((f) => f.observedAtMs === T)).toBe(true);
    expect(d?.directionAction).toBe("LONG");
  });
  it("regime snapshot emits ONE-HOT confidence (default) + ordinal (sensitivity)", () => {
    const d = regimeSnapshotAdapter.toDecision!({ capturedAt: T, directionalBias: "LONG", confidence: "MEDIUM", allowsLong: true, allowsShort: false });
    const keys = new Set(d!.features.map((f) => f.key));
    expect(keys.has("confidence_MEDIUM")).toBe(true);
    expect(keys.has("confidence_ord")).toBe(true);
    expect(d!.features.find((f) => f.key === "confidence_MEDIUM")!.value).toBe(1);
    expect(d!.features.find((f) => f.key === "confidence_LOW")!.value).toBe(0);
  });
  it("kronos adapter emits NATIVE-R netR = realizedGrossR − costR (never ÷ riskDistanceAtOpen)", () => {
    // Regression: realizedGrossR/costR are already in R; routing them through the return-based ÷risk path
    // inflated netR ~333× and made every kronos row a fabricated win. netR must be native (0.5 − 0.1 = 0.4R).
    const o = kronosCounterfactualAdapter.toOutcome!({
      observationId: "k1", lane: "KRONOS_DISAGREEMENT_COUNTERFACTUAL",
      resolverState: { openedAt: T, lastEvaluatedAt: T + MIN, realizedGrossR: 0.5 },
      outcome: { closedAt: T + MIN }, snapshot: { costR: 0.1, direction: "LONG", stopDistanceBps: 30 },
    });
    expect(o?.netR).toBeCloseTo(0.4); // NATIVE, not 0.4/0.003 ≈ 133
    const label = computeOutcomeR(o!);
    expect(label.ok && label.netR).toBeCloseTo(0.4);
  });
});

describe("backfill: sign-off locks (pre-registered metrics + denominator provenance)", () => {
  it("pre-registered decision metrics use TRAIN-only thresholds + always report coverage", () => {
    const train = [0.2, 0.4, 0.6, 0.8]; // train score distribution → thresholds frozen from here
    const test = [{ score: 0.9, netR: 1 }, { score: 0.5, netR: -1 }, { score: 0.1, netR: -1 }];
    const metrics = preRegisteredDecisionMetrics(test, train, 0.4);
    const names = metrics.map((m) => m.name);
    expect(names).toEqual(["all-rows", "top-10%", "top-25%", "top-50%", "fixed-hurdle"]);
    for (const m of metrics) { expect(m.coverage).toBeGreaterThanOrEqual(0); expect(m.coverage).toBeLessThanOrEqual(1); }
    expect(metrics[0]!.coverage).toBe(1); // all-rows = full coverage baseline
    expect(quantile(train, 0.5)).toBe(0.6); // threshold derived from TRAIN, not test
  });
  it("computeOutcomeR sensitivity override applies ONLY to assumed-constant denominators", () => {
    const base = { sourceId: "x", schemaVersion: 1, outcomeId: "o", laneId: "L", symbolOrBasket: null, side: null, openedAtMs: T, resolvedAtMs: T + MIN, netR: null, grossR: 0.01, costR: 0.001, tp1Hit: null, tp2Hit: null, slToBreakeven: null };
    const assumed = computeOutcomeR({ ...base, riskDistanceAtOpen: 0.003, riskDenominatorSource: "GLOBAL_CONSTANT_ASSUMED" }, { assumedDenominatorOverride: 0.002 });
    expect(assumed.ok && assumed.netR).toBeCloseTo(0.009 / 0.002); // override applied
    const recorded = computeOutcomeR({ ...base, riskDistanceAtOpen: 0.003, riskDenominatorSource: "RECORDED_AT_OPEN" }, { assumedDenominatorOverride: 0.002 });
    expect(recorded.ok && recorded.netR).toBeCloseTo(0.009 / 0.003); // override IGNORED for recorded
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_LABEL_DIM,
  META_LABEL_REFIT_MAX_JUMP,
  META_LABEL_FEATURE_NAMES,
  META_LABEL_FEATURE_SCHEMA_VERSION,
  META_LABEL_MAX_STORED_SETTLED,
  META_LABEL_SWEEP_LOOKBACK_MS,
  META_LABEL_TAUS,
  MetaLabelStore,
  buildMetaLabelCohortTable,
  buildMetaLabelFeatureSnapshot,
  buildMetaLabelReport,
  controllerConfFeature,
  crowdingAlignFromSnapshot,
  effectiveFeatureVector,
  fitMetaLabelLogistic,
  hourFeatures,
  kronosAlignFeature,
  modelForSignal,
  regimeAlignFeature,
  runMetaLabelCycle,
  runMetaLabelCycleGuarded,
  scoreWithModel,
  type MetaLabelFeatureSources,
  type MetaLabelFeatures,
  type MetaLabelModelVersion,
  type MetaLabelOrderLike,
  type MetaLabelRecord,
} from "../src/lib/meta-label-gate.js";

const T0 = Date.parse("2026-07-22T00:00:00.000Z");
const MIN = 60_000;

function tmpStorePath(tag: string): string {
  return join(mkdtempSync(join(tmpdir(), "meta-label-test-")), `${tag}.json`);
}

/** All-null features except bias — the "every source missing" snapshot. */
function nullFeatures(overrides: Partial<MetaLabelFeatures> = {}): MetaLabelFeatures {
  const f = Object.fromEntries(META_LABEL_FEATURE_NAMES.map((n) => [n, null])) as MetaLabelFeatures;
  f.bias = 1;
  return { ...f, ...overrides };
}

function makeOrder(overrides: Partial<MetaLabelOrderLike> & { paperOrderId: string }): MetaLabelOrderLike {
  return {
    createdAt: new Date(T0).toISOString(),
    symbol: "ETHUSDT",
    direction: "LONG",
    regime: "Bullish Expansion",
    controllerConfidence: "MEDIUM",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    paperStatus: "PAPER_SUBMITTED",
    netR: null,
    provenance: null,
    ...overrides,
  };
}

const NULL_SOURCES: MetaLabelFeatureSources = {
  atrPct: () => null,
  edgeMem: () => null,
  crowdingAlign: () => null,
  bookEdgeNetAvgR: () => null,
  laneHistNetAvgR: () => null,
};

function makeModel(overrides: Partial<MetaLabelModelVersion> = {}): MetaLabelModelVersion {
  return {
    version: 1,
    weights: new Array(META_LABEL_DIM).fill(0),
    featureSchemaVersion: META_LABEL_FEATURE_SCHEMA_VERSION,
    fittedAtIso: new Date(T0).toISOString(),
    fittedAtMs: T0,
    nTrain: 100,
    ...overrides,
  };
}

function labeledRecord(
  signalId: string,
  score: number | null,
  netR: number | null,
  overrides: Partial<MetaLabelRecord> = {},
): MetaLabelRecord {
  return {
    signalId,
    atIso: new Date(T0).toISOString(),
    signalCreatedAtIso: new Date(T0).toISOString(),
    laneId: "LANE_A",
    symbol: "ETHUSDT",
    direction: "LONG",
    features: nullFeatures(),
    featureSchemaVersion: META_LABEL_FEATURE_SCHEMA_VERSION,
    score,
    modelVersion: score === null ? null : 1,
    label: netR === null ? null : { netR, win: netR > 0 },
    labeledAtIso: netR === null ? null : new Date(T0).toISOString(),
    ...overrides,
  };
}

// ── feature transforms ───────────────────────────────────────────────────────

describe("feature transforms", () => {
  it("regimeAlignFeature: direction sign × family sign; null regime is missing, mixed is 0", () => {
    expect(regimeAlignFeature("Bullish Expansion", "LONG")).toBe(1);
    expect(regimeAlignFeature("Bullish Expansion", "SHORT")).toBe(-1);
    expect(regimeAlignFeature("BEARISH_BREAKDOWN", "SHORT")).toBe(1);
    expect(regimeAlignFeature("Mixed Rotation", "LONG")).toBe(0);
    expect(regimeAlignFeature(null, "LONG")).toBeNull();
    expect(regimeAlignFeature("", "LONG")).toBeNull();
  });

  it("controllerConfFeature maps the graduated labels and nulls the unknown", () => {
    expect(controllerConfFeature("HIGH")).toBe(0.7);
    expect(controllerConfFeature("MEDIUM")).toBe(0.2);
    expect(controllerConfFeature("LOW")).toBe(-0.3);
    expect(controllerConfFeature("DEGRADED")).toBe(-0.7);
    expect(controllerConfFeature("whatever")).toBeNull();
    expect(controllerConfFeature(null)).toBeNull();
  });

  it("crowdingAlignFromSnapshot: extreme same-side crowd is the −1 exhausted condition", () => {
    expect(crowdingAlignFromSnapshot({ crowdSide: "LONG", crowdingLevel: "EXTREME" }, "LONG")).toBe(-1);
    expect(crowdingAlignFromSnapshot({ crowdSide: "LONG", crowdingLevel: "EXTREME" }, "SHORT")).toBe(0.5);
    expect(crowdingAlignFromSnapshot({ crowdSide: "SHORT", crowdingLevel: "ELEVATED" }, "SHORT")).toBe(-0.5);
    expect(crowdingAlignFromSnapshot({ crowdSide: "SHORT", crowdingLevel: "ELEVATED" }, "LONG")).toBe(0.25);
    expect(crowdingAlignFromSnapshot({ crowdSide: "NEUTRAL", crowdingLevel: "NEUTRAL" }, "LONG")).toBe(0);
  });

  it("kronosAlignFeature: agreement × confidence on the producer's 0-100 scale", () => {
    // 80 on the 0-100 scale tracker.ts's buckets define (<45 WEAK / <70 MEDIUM / >=70 STRONG).
    expect(kronosAlignFeature("LONG", 80, "LONG")).toBeCloseTo(0.8);
    expect(kronosAlignFeature("SHORT", 60, "LONG")).toBeCloseTo(-0.6);
    // A NEUTRAL bias IS a reading ("no directional view") — 0, the schema's own neutral, not null.
    expect(kronosAlignFeature("NEUTRAL", 90, "LONG")).toBe(0);
    expect(kronosAlignFeature("UNAVAILABLE", 90, "LONG")).toBeNull();
    expect(kronosAlignFeature(null, 90, "LONG")).toBeNull();
    // An absent or zero confidence is an absent reading — never a fabricated 0.5 magnitude.
    expect(kronosAlignFeature("LONG", null, "LONG")).toBeNull();
    expect(kronosAlignFeature("LONG", 0, "LONG")).toBeNull();
    expect(kronosAlignFeature("LONG", Number.NaN, "LONG")).toBeNull();
  });

  // ── the saturation regression ───────────────────────────────────────────────
  // WHY (2026-07-28): `provenance.kronosConfidence` is 0-100 — the allocator copies the scan
  // candidate's field through verbatim, and tracker.ts buckets it at <45 / <70 / >=70. The old
  // `clamp(kronosConfidence, 0, 1)` therefore SATURATED every non-zero confidence to exactly 1.0.
  // Measured in the deployed stores that day, `kronosAlign` held exactly two values across every
  // record ever written — +1 and -1 (research 114/114, testnet 17,386/19,261). Each assertion below
  // fails against that clamp.
  it("[SCALE] distinguishes a WEAK confidence from a STRONG one instead of saturating both to 1", () => {
    const weak = kronosAlignFeature("LONG", 46, "LONG")!;
    const strong = kronosAlignFeature("LONG", 99, "LONG")!;
    expect(weak).toBeCloseTo(0.46, 10);
    expect(strong).toBeCloseTo(0.99, 10);
    expect(weak).toBeLessThan(strong); // the old clamp made these identical (1 and 1)
    expect(weak).toBeLessThan(1);
    expect(strong).toBeLessThan(1);
    // …and the sign still comes from agreement, at the same reduced magnitudes.
    expect(kronosAlignFeature("SHORT", 46, "LONG")).toBeCloseTo(-0.46, 10);
  });

  it("[SCALE] maps the producer's actual value (100) to 1, so no stored training row changes", () => {
    // Every kronosConfidence that has ever reached the meta-label store was exactly 100 (testnet
    // 17,025/17,025, distinct=1). 100 -> 1.0 is also what the saturating clamp produced, which is
    // precisely why the persisted weights survive this fix and featureSchemaVersion stays at 1.
    expect(kronosAlignFeature("LONG", 100, "LONG")).toBe(1);
    expect(kronosAlignFeature("SHORT", 100, "LONG")).toBe(-1);
    // Out-of-range input still clamps rather than exploding the feature past the [-1,1] contract.
    expect(kronosAlignFeature("LONG", 400, "LONG")).toBe(1);
    expect(kronosAlignFeature("LONG", -20, "LONG")).toBeNull();
  });

  it("[SCALE] a 0-1-scaled value understates rather than saturating (the safe direction)", () => {
    // No producer sends 0..1 today. If one ever does, 0.8 reads as a near-zero opinion — visible as
    // weak, instead of masquerading as certainty the way the old clamp did.
    expect(kronosAlignFeature("LONG", 0.8, "LONG")).toBeCloseTo(0.008, 10);
  });

  it("[SCALE] carries the real magnitude end-to-end through the snapshot builder", async () => {
    // The path production actually uses: provenance -> buildMetaLabelFeatureSnapshot -> features.
    // 30.83 is a real value observed in the research paper store's provenance.
    const snap = await buildMetaLabelFeatureSnapshot(
      makeOrder({
        paperOrderId: "kronos-scale",
        direction: "LONG",
        provenance: { kronosBias: "LONG", kronosConfidence: 30.83 },
      }),
      NULL_SOURCES,
    );
    expect(snap.kronosAlign).toBeCloseTo(0.3083, 10);
    expect(snap.kronosAlign).not.toBe(1);

    // And a missing confidence stays an explicit null through the same path — the store's own
    // "MISSING FEATURES ARE EXPLICIT NULLS" contract, which the old 0.5 default violated.
    const absent = await buildMetaLabelFeatureSnapshot(
      makeOrder({
        paperOrderId: "kronos-absent",
        provenance: { kronosBias: "LONG", kronosConfidence: null },
      }),
      NULL_SOURCES,
    );
    expect(absent.kronosAlign).toBeNull();
  });

  it("hourFeatures encode UTC hour-of-day on the unit circle", () => {
    const midnight = hourFeatures("2026-07-22T00:00:00.000Z");
    expect(midnight.hourSin).toBeCloseTo(0, 10);
    expect(midnight.hourCos).toBeCloseTo(1, 10);
    const six = hourFeatures("2026-07-22T06:00:00.000Z");
    expect(six.hourSin).toBeCloseTo(1, 10);
    expect(six.hourCos).toBeCloseTo(0, 10);
    expect(hourFeatures("not a date").hourSin).toBeNull();
  });
});

// ── null handling (skip + renormalize) ──────────────────────────────────────

describe("null-feature handling", () => {
  it("skips nulls and renormalizes the present non-bias features (hand-computed)", () => {
    const features = nullFeatures({
      regimeAlign: 0.5,
      crowdingAlign: -1,
      hourSin: 0.3,
      hourCos: 0.4,
      laneHist: 0.2,
    });
    // 5 of 10 non-bias present → renorm = 10/5 = 2 (below the cap of 3).
    const x = effectiveFeatureVector(features);
    const byName = Object.fromEntries(META_LABEL_FEATURE_NAMES.map((n, i) => [n, x[i]]));
    expect(byName.bias).toBe(1);
    expect(byName.regimeAlign).toBeCloseTo(1.0);
    expect(byName.crowdingAlign).toBeCloseTo(-2.0);
    expect(byName.hourSin).toBeCloseTo(0.6);
    expect(byName.hourCos).toBeCloseTo(0.8);
    expect(byName.laneHist).toBeCloseTo(0.4);
    expect(byName.controllerConf).toBe(0);
    expect(byName.kronosAlign).toBe(0);
    expect(byName.bookEdge).toBe(0);
    expect(byName.atrCentered).toBe(0);
    expect(byName.edgeMem).toBe(0);
  });

  it("caps the renormalization so one surviving feature is never amplified past ×3", () => {
    const x = effectiveFeatureVector(nullFeatures({ regimeAlign: 1 }));
    expect(x[META_LABEL_FEATURE_NAMES.indexOf("regimeAlign")]).toBeCloseTo(3); // min(3, 10/1)
  });

  it("all-null non-bias falls back to bias only, and scoring stays finite (base rate)", () => {
    const x = effectiveFeatureVector(nullFeatures());
    expect(x[0]).toBe(1);
    expect(x.slice(1).every((v) => v === 0)).toBe(true);
    const weights = new Array(META_LABEL_DIM).fill(0.5);
    weights[0] = 0.4;
    const score = scoreWithModel(makeModel({ weights }), nullFeatures());
    expect(score).toBeCloseTo(1 / (1 + Math.exp(-0.4)));
    expect(Number.isFinite(score)).toBe(true);
  });

  it("feature snapshot records explicit nulls for every missing source and never throws", async () => {
    const throwingSources: MetaLabelFeatureSources = {
      atrPct: () => {
        throw new Error("cache exploded");
      },
      edgeMem: () => null,
      crowdingAlign: async () => {
        throw new Error("network down");
      },
      bookEdgeNetAvgR: () => null,
      laneHistNetAvgR: () => null,
    };
    const snap = await buildMetaLabelFeatureSnapshot(makeOrder({ paperOrderId: "p1", regime: null }), throwingSources);
    expect(snap.bias).toBe(1);
    expect(snap.atrCentered).toBeNull();
    expect(snap.crowdingAlign).toBeNull();
    expect(snap.regimeAlign).toBeNull();
    expect(snap.kronosAlign).toBeNull();
    expect(snap.bookEdge).toBeNull();
    expect(snap.edgeMem).toBeNull();
    expect(snap.laneHist).toBeNull();
    // hour-of-day comes from the order itself — always present
    expect(snap.hourSin).not.toBeNull();
    expect(snap.hourCos).not.toBeNull();
  });
});

// ── logistic sanity ─────────────────────────────────────────────────────────

describe("logistic fit", () => {
  it("converges on a separable fixture to discriminating weights", () => {
    const examples = Array.from({ length: 200 }, (_, i) => {
      const win = i % 2 === 0;
      return { features: nullFeatures({ regimeAlign: win ? 1 : -1 }), y: (win ? 1 : 0) as 0 | 1 };
    });
    const fit = fitMetaLabelLogistic(examples, { minExamples: 100 });
    expect(fit.status).toBe("ACCEPTED");
    expect(fit.nTrain).toBe(200);
    const wRegime = fit.weights[META_LABEL_FEATURE_NAMES.indexOf("regimeAlign")]!;
    expect(wRegime).toBeGreaterThan(0);
    expect(fit.weights.every((v) => Number.isFinite(v))).toBe(true);
    const model = makeModel({ weights: fit.weights });
    const winScore = scoreWithModel(model, nullFeatures({ regimeAlign: 1 }));
    const lossScore = scoreWithModel(model, nullFeatures({ regimeAlign: -1 }));
    expect(winScore).toBeGreaterThan(0.6);
    expect(lossScore).toBeLessThan(0.4);
  });

  it("enforces the min-examples gate", () => {
    const examples = Array.from({ length: 99 }, (_, i) => ({
      features: nullFeatures({ regimeAlign: i % 2 === 0 ? 1 : -1 }),
      y: (i % 2 === 0 ? 1 : 0) as 0 | 1,
    }));
    const fit = fitMetaLabelLogistic(examples, { minExamples: 100 });
    expect(fit.status).toBe("REJECTED_MIN_EXAMPLES");
    expect(fit.nTrain).toBe(99);
  });
});

// ── walk-forward model selection ────────────────────────────────────────────

describe("walk-forward model selection", () => {
  it("modelForSignal picks the newest model that predates the signal — never a future one", () => {
    const v1 = makeModel({ version: 1, fittedAtMs: T0 });
    const v2 = makeModel({ version: 2, fittedAtMs: T0 + 10 * MIN });
    expect(modelForSignal([v1, v2], T0 - 1)).toBeNull(); // created before any model
    expect(modelForSignal([v1, v2], T0 + 5 * MIN)?.version).toBe(1);
    expect(modelForSignal([v1, v2], T0 + 10 * MIN)?.version).toBe(2);
    expect(modelForSignal([], T0)).toBeNull();
  });

  it("a signal scored under model v1 keeps v1's score after refit to v2 (frozen score)", async () => {
    const store = new MetaLabelStore(tmpStorePath("walk-forward"));
    const minExamples = 50;

    // 60 signals, separable by regime alignment: bullish LONG wins, bearish LONG loses.
    const trainingOrders: MetaLabelOrderLike[] = Array.from({ length: 60 }, (_, i) =>
      makeOrder({
        paperOrderId: `train-${i}`,
        regime: i % 2 === 0 ? "Bullish Expansion" : "Bearish Expansion",
        createdAt: new Date(T0).toISOString(),
      }),
    );

    // Cycle 1 (t0): scores all 60 with NO model → null scores, counted honestly.
    const c1 = await runMetaLabelCycle({
      store,
      orders: trainingOrders,
      sources: NULL_SOURCES,
      now: T0 + MIN,
      minExamples,
      maxNewScores: 100,
    });
    expect(c1.scored).toBe(60);
    expect(c1.scoredModelNotReady).toBe(60);
    expect(c1.fit.ran).toBe(false); // nothing labeled yet
    expect(store.models.length).toBe(0);

    // Resolve them all; cycle 2 (t1) labels 60 and fits model v1 (min gate met).
    const t1 = T0 + 10 * MIN;
    const resolvedOrders = trainingOrders.map((o, i) => ({
      ...o,
      paperStatus: i % 2 === 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
      netR: i % 2 === 0 ? 1.2 : -1,
    }));
    const c2 = await runMetaLabelCycle({
      store,
      orders: resolvedOrders,
      sources: NULL_SOURCES,
      now: t1,
      minExamples,
      maxNewScores: 100,
    });
    expect(c2.labeled).toBe(60);
    expect(c2.fit.ran).toBe(true);
    expect(c2.fit.status).toBe("ACCEPTED");
    expect(store.models.length).toBe(1);
    expect(store.models[0]!.fittedAtMs).toBe(t1);
    // Training signals were created BEFORE v1 existed — their null scores must stay null.
    expect(store.get("train-0")!.score).toBeNull();
    expect(store.get("train-0")!.modelVersion).toBeNull();

    // Cycle 3 (t2): a fresh signal created AFTER v1's fittedAt scores under v1.
    const t2 = t1 + MIN;
    const fresh = makeOrder({
      paperOrderId: "fresh-1",
      regime: "Bullish Expansion",
      createdAt: new Date(t2).toISOString(),
    });
    // Plus a signal created BEFORE v1 existed — must score null even though v1 is installed now.
    const preModel = makeOrder({
      paperOrderId: "pre-model-1",
      regime: "Bullish Expansion",
      createdAt: new Date(t1 - 1000).toISOString(),
    });
    await runMetaLabelCycle({
      store,
      orders: [...resolvedOrders, fresh, preModel],
      sources: NULL_SOURCES,
      now: t2 + MIN,
      minExamples,
      maxNewScores: 100,
    });
    const freshRecord = store.get("fresh-1")!;
    expect(freshRecord.modelVersion).toBe(1);
    expect(freshRecord.score).not.toBeNull();
    expect(freshRecord.score!).toBeGreaterThan(0.5); // bullish-aligned context, v1 learned that
    const v1Score = freshRecord.score!;
    expect(store.get("pre-model-1")!.score).toBeNull();
    expect(store.get("pre-model-1")!.modelVersion).toBeNull();

    // Cycle 4 (t3 = t1 + 25h): refit due → v2 installed. The fresh-1 record is FROZEN on v1.
    const t3 = t1 + 25 * 60 * MIN;
    const c4 = await runMetaLabelCycle({
      store,
      orders: resolvedOrders,
      sources: NULL_SOURCES,
      now: t3,
      minExamples,
      maxNewScores: 100,
    });
    expect(c4.fit.ran).toBe(true);
    expect(store.models.length).toBe(2);
    expect(store.models[1]!.version).toBe(2);
    const after = store.get("fresh-1")!;
    expect(after.modelVersion).toBe(1);
    expect(after.score).toBe(v1Score);
  });

  it("does not refit again inside the refit interval", async () => {
    const store = new MetaLabelStore(tmpStorePath("refit-throttle"));
    for (let i = 0; i < 120; i += 1) {
      store.add(labeledRecord(`r-${i}`, null, i % 2 === 0 ? 1 : -1, {
        features: nullFeatures({ regimeAlign: i % 2 === 0 ? 1 : -1 }),
        modelVersion: null,
      }));
    }
    const c1 = await runMetaLabelCycle({ store, orders: [], sources: NULL_SOURCES, now: T0, minExamples: 100 });
    expect(c1.fit.ran).toBe(true);
    expect(store.models.length).toBe(1);
    const c2 = await runMetaLabelCycle({ store, orders: [], sources: NULL_SOURCES, now: T0 + MIN, minExamples: 100 });
    expect(c2.fit.ran).toBe(false); // inside the 24h default interval
    expect(store.models.length).toBe(1);
  });
});

// ── exactly-once labeling ───────────────────────────────────────────────────

describe("exactly-once labeling", () => {
  it("labels a resolved signal once and freezes the first label", async () => {
    const store = new MetaLabelStore(tmpStorePath("label-once"));
    const open = makeOrder({ paperOrderId: "sig-1" });
    await runMetaLabelCycle({ store, orders: [open], sources: NULL_SOURCES, now: T0 + MIN });
    expect(store.get("sig-1")!.label).toBeNull();

    const resolved = { ...open, paperStatus: "PAPER_CLOSED_WIN", netR: 0.8 };
    const c2 = await runMetaLabelCycle({ store, orders: [resolved], sources: NULL_SOURCES, now: T0 + 2 * MIN });
    expect(c2.labeled).toBe(1);
    const rec = store.get("sig-1")!;
    expect(rec.label).toEqual({ netR: 0.8, win: true });
    const firstLabeledAt = rec.labeledAtIso;

    // Re-sweep the same resolved order — and even a MUTATED netR — must be a no-op.
    const mutated = { ...resolved, netR: -5 };
    const c3 = await runMetaLabelCycle({ store, orders: [mutated], sources: NULL_SOURCES, now: T0 + 3 * MIN });
    expect(c3.labeled).toBe(0);
    expect(store.get("sig-1")!.label).toEqual({ netR: 0.8, win: true });
    expect(store.get("sig-1")!.labeledAtIso).toBe(firstLabeledAt);
    expect(store.label("sig-1", 99, new Date().toISOString())).toBe(false);
  });

  it("labels a pending signal whose order is far older than the SCORE pass's sweep lookback window", async () => {
    // The LABEL pass's own order lookup must never be scoped by META_LABEL_SWEEP_LOOKBACK_MS —
    // that bound belongs to the SCORE pass only. A position can legitimately stay open for days
    // (paper orders expire at 7d), so its underlying order can be far older than the lookback
    // window by the time it finally resolves and needs labeling.
    const store = new MetaLabelStore(tmpStorePath("label-ignores-lookback"));
    const openOrder = makeOrder({ paperOrderId: "long-held", createdAt: new Date(T0).toISOString() });
    await runMetaLabelCycle({ store, orders: [openOrder], sources: NULL_SOURCES, now: T0 + MIN });
    expect(store.get("long-held")!.label).toBeNull();

    const resolvedMuchLater = T0 + META_LABEL_SWEEP_LOOKBACK_MS + 60 * MIN;
    const resolved = { ...openOrder, paperStatus: "PAPER_CLOSED_WIN", netR: 0.6 };
    const c = await runMetaLabelCycle({ store, orders: [resolved], sources: NULL_SOURCES, now: resolvedMuchLater });
    expect(c.labeled).toBe(1);
    expect(store.get("long-held")!.label).toEqual({ netR: 0.6, win: true });
  });

  it("voids a terminal signal without usable netR instead of labeling it", async () => {
    const store = new MetaLabelStore(tmpStorePath("void"));
    const open = makeOrder({ paperOrderId: "sig-v" });
    await runMetaLabelCycle({ store, orders: [open], sources: NULL_SOURCES, now: T0 + MIN });
    const noFill = { ...open, paperStatus: "PAPER_NO_FILL", netR: null };
    const c = await runMetaLabelCycle({ store, orders: [noFill], sources: NULL_SOURCES, now: T0 + 2 * MIN });
    expect(c.voided).toBe(1);
    expect(c.labeled).toBe(0);
    const rec = store.get("sig-v")!;
    expect(rec.voided).toBe(true);
    expect(rec.label).toBeNull();
    // a voided record never accepts a later label
    expect(store.label("sig-v", 1, new Date().toISOString())).toBe(false);
  });
});

// ── sweep honesty gates ─────────────────────────────────────────────────────

describe("sweep scoring gates", () => {
  it("never scores a signal first seen already-resolved, and counts it", async () => {
    const store = new MetaLabelStore(tmpStorePath("already-resolved"));
    const resolved = makeOrder({ paperOrderId: "late", paperStatus: "PAPER_CLOSED_WIN", netR: 1 });
    const c = await runMetaLabelCycle({ store, orders: [resolved], sources: NULL_SOURCES, now: T0 + MIN });
    expect(c.scored).toBe(0);
    expect(c.skippedAlreadyResolved).toBe(1);
    expect(store.has("late")).toBe(false);
  });

  it("never scores a signal older than the at-signal-time honesty window", async () => {
    const store = new MetaLabelStore(tmpStorePath("too-old"));
    const stale = makeOrder({ paperOrderId: "stale", createdAt: new Date(T0 - 60 * MIN).toISOString() });
    const c = await runMetaLabelCycle({ store, orders: [stale], sources: NULL_SOURCES, now: T0 });
    expect(c.scored).toBe(0);
    expect(c.skippedTooOld).toBe(1);
    expect(store.has("stale")).toBe(false);
  });

  it("defers past the per-cycle cap (newest first) instead of dropping", async () => {
    const store = new MetaLabelStore(tmpStorePath("cap"));
    const orders = Array.from({ length: 5 }, (_, i) =>
      makeOrder({ paperOrderId: `o-${i}`, createdAt: new Date(T0 + i * 1000).toISOString() }),
    );
    const c = await runMetaLabelCycle({ store, orders, sources: NULL_SOURCES, now: T0 + MIN, maxNewScores: 3 });
    expect(c.scored).toBe(3);
    expect(c.deferredByCap).toBe(2);
    // newest three were taken first
    expect(store.has("o-4")).toBe(true);
    expect(store.has("o-3")).toBe(true);
    expect(store.has("o-2")).toBe(true);
    expect(store.has("o-1")).toBe(false);
    const c2 = await runMetaLabelCycle({ store, orders, sources: NULL_SOURCES, now: T0 + 2 * MIN, maxNewScores: 3 });
    expect(c2.scored).toBe(2); // deferred ones picked up next cycle
  });

  it("stops re-examining (and re-counting) a permanently-dead signal once it falls outside the sweep lookback window", async () => {
    const store = new MetaLabelStore(tmpStorePath("lookback-resolved"));
    const ancient = makeOrder({ paperOrderId: "ancient", paperStatus: "PAPER_CLOSED_WIN", netR: 1 });
    // First look, well within the lookback window: counted once, correctly — matches the existing
    // "never scores an already-resolved signal" behavior.
    const c1 = await runMetaLabelCycle({ store, orders: [ancient], sources: NULL_SOURCES, now: T0 + MIN });
    expect(c1.skippedAlreadyResolved).toBe(1);
    expect(store.has("ancient")).toBe(false);

    // Same order, same inputs — but "now" has moved past the sweep lookback window. Without the
    // fix this order (still !store.has, still terminal) gets swept into `unseen` and re-counted on
    // every single cycle forever; with the fix it falls outside sweepDeadlineMs and is left alone.
    const farFuture = T0 + META_LABEL_SWEEP_LOOKBACK_MS + 10 * MIN;
    const c2 = await runMetaLabelCycle({ store, orders: [ancient], sources: NULL_SOURCES, now: farFuture });
    expect(c2.skippedAlreadyResolved).toBe(0);
    expect(c2.scored).toBe(0);
  });

  it("stops re-examining a too-old-to-score signal once it falls outside the sweep lookback window", async () => {
    const store = new MetaLabelStore(tmpStorePath("lookback-too-old"));
    const stale = makeOrder({ paperOrderId: "stale-forever", createdAt: new Date(T0).toISOString() });
    const c1 = await runMetaLabelCycle({ store, orders: [stale], sources: NULL_SOURCES, now: T0 + 60 * MIN });
    expect(c1.skippedTooOld).toBe(1);
    expect(store.has("stale-forever")).toBe(false);

    const farFuture = T0 + META_LABEL_SWEEP_LOOKBACK_MS + 10 * MIN;
    const c2 = await runMetaLabelCycle({ store, orders: [stale], sources: NULL_SOURCES, now: farFuture });
    expect(c2.skippedTooOld).toBe(0);
  });

  it("still scores a genuinely fresh signal even when 'now' is far past the epoch used elsewhere in these tests", async () => {
    const store = new MetaLabelStore(tmpStorePath("lookback-fresh"));
    const laterNow = T0 + META_LABEL_SWEEP_LOOKBACK_MS + 10 * MIN;
    const fresh = makeOrder({ paperOrderId: "fresh-late", createdAt: new Date(laterNow - MIN).toISOString() });
    const c = await runMetaLabelCycle({ store, orders: [fresh], sources: NULL_SOURCES, now: laterNow });
    expect(c.scored).toBe(1);
    expect(store.has("fresh-late")).toBe(true);
  });

  it("guarded cycle records the error and never throws", async () => {
    const store = new MetaLabelStore(tmpStorePath("guarded"));
    const result = await runMetaLabelCycleGuarded({
      store,
      orders: null as unknown as MetaLabelOrderLike[],
      sources: NULL_SOURCES,
      now: T0,
    });
    expect(result).toBeNull();
    expect(store.cycleMeta.lastCycleError).toBeTruthy();
    expect(store.cycleMeta.lastCycleAt).toBe(new Date(T0).toISOString());
  });
});

// ── cohort math (hand-computed fixture) ─────────────────────────────────────

describe("cohort counterfactual table", () => {
  it("matches the hand-computed retention/netAvgR/PF/lift", () => {
    const records: MetaLabelRecord[] = [
      labeledRecord("a", 0.72, 2.0),
      labeledRecord("b", 0.66, -1.0),
      labeledRecord("c", 0.58, 0.5),
      labeledRecord("d", 0.52, -1.0),
      labeledRecord("e", 0.45, 1.5),
      labeledRecord("f", 0.4, -1.0),
      // labeled but UNSCORED (model wasn't ready) — excluded from the gate population entirely
      labeledRecord("g", null, 10),
      // scored but unlabeled — excluded too
      labeledRecord("h", 0.9, null),
      // voided — excluded
      labeledRecord("i", 0.9, null, { voided: true }),
    ];
    const table = buildMetaLabelCohortTable(records, [0.5, 0.6, 0.7]);
    expect(table).toHaveLength(3);

    const ungated = 1 / 6; // (2 − 1 + 0.5 − 1 + 1.5 − 1) / 6
    for (const row of table) {
      expect(row.n).toBe(6);
      expect(row.ungatedNetAvgR).toBeCloseTo(ungated, 10);
      expect(row.ungatedPF).toBeCloseTo(4 / 3, 10); // (2+0.5+1.5)/(1+1+1)
      expect(row.ungatedWr).toBeCloseTo(0.5, 10);
    }

    const t50 = table[0]!;
    expect(t50.retained).toBe(4);
    expect(t50.retainedPct).toBeCloseTo((4 / 6) * 100, 10);
    expect(t50.gatedNetAvgR).toBeCloseTo(0.125, 10); // (2 − 1 + 0.5 − 1)/4
    expect(t50.gatedPF).toBeCloseTo(1.25, 10); // 2.5 / 2
    expect(t50.lift).toBeCloseTo(0.125 - ungated, 10);

    const t60 = table[1]!;
    expect(t60.retained).toBe(2);
    expect(t60.gatedNetAvgR).toBeCloseTo(0.5, 10); // (2 − 1)/2
    expect(t60.gatedPF).toBeCloseTo(2, 10);
    expect(t60.lift).toBeCloseTo(0.5 - ungated, 10);
    expect(t60.gatedWr).toBeCloseTo(0.5, 10);

    const t70 = table[2]!;
    expect(t70.retained).toBe(1);
    expect(t70.retainedPct).toBeCloseTo((1 / 6) * 100, 10);
    expect(t70.gatedNetAvgR).toBeCloseTo(2, 10);
    expect(t70.gatedPF).toBe(999); // no losses retained → sentinel, same as sibling reports
  });

  it("is empty-safe (no labeled+scored population)", () => {
    const table = buildMetaLabelCohortTable([labeledRecord("only-open", 0.7, null)]);
    expect(table).toHaveLength(META_LABEL_TAUS.length);
    expect(table[0]!.n).toBe(0);
    expect(table[0]!.retainedPct).toBeNull();
    expect(table[0]!.gatedNetAvgR).toBeNull();
    expect(table[0]!.lift).toBeNull();
  });
});

// ── bounded store + persistence ─────────────────────────────────────────────

describe("bounded store", () => {
  it("prunes stale unlabeled records but keeps fresh pending ones", () => {
    const store = new MetaLabelStore(tmpStorePath("prune-unlabeled"));
    store.add(
      labeledRecord("stale-open", 0.6, null, {
        signalCreatedAtIso: new Date(T0 - 15 * 86_400_000).toISOString(),
      }),
    );
    store.add(labeledRecord("fresh-open", 0.6, null, { signalCreatedAtIso: new Date(T0 - 1000).toISOString() }));
    store.add(labeledRecord("old-labeled", 0.6, 1, { signalCreatedAtIso: new Date(T0 - 20 * 86_400_000).toISOString() }));
    const pruned = store.prune(T0);
    expect(pruned).toBe(1);
    expect(store.has("stale-open")).toBe(false);
    expect(store.has("fresh-open")).toBe(true);
    expect(store.has("old-labeled")).toBe(true); // labeled records are capped by count, not age
  });

  it("caps settled records, dropping oldest-created first", () => {
    const store = new MetaLabelStore(tmpStorePath("prune-settled"));
    const total = META_LABEL_MAX_STORED_SETTLED + 5;
    for (let i = 0; i < total; i += 1) {
      store.add(
        labeledRecord(`s-${i}`, 0.6, 1, { signalCreatedAtIso: new Date(T0 + i * 1000).toISOString() }),
      );
    }
    store.prune(T0 + total * 1000);
    expect(store.all.length).toBe(META_LABEL_MAX_STORED_SETTLED);
    expect(store.has("s-0")).toBe(false);
    expect(store.has("s-4")).toBe(false);
    expect(store.has("s-5")).toBe(true);
    expect(store.has(`s-${total - 1}`)).toBe(true);
  });

  it("persists atomically and reloads records + models + cycle meta", async () => {
    const file = tmpStorePath("roundtrip");
    const store = new MetaLabelStore(file);
    const order = makeOrder({ paperOrderId: "persist-1" });
    await runMetaLabelCycle({ store, orders: [order], sources: NULL_SOURCES, now: T0 + MIN });
    store.addModel({
      weights: new Array(META_LABEL_DIM).fill(0.1),
      featureSchemaVersion: META_LABEL_FEATURE_SCHEMA_VERSION,
      fittedAtIso: new Date(T0).toISOString(),
      fittedAtMs: T0,
      nTrain: 123,
    });
    store.save();
    const reloaded = new MetaLabelStore(file);
    expect(reloaded.has("persist-1")).toBe(true);
    expect(reloaded.models.length).toBe(1);
    expect(reloaded.models[0]!.nTrain).toBe(123);
    expect(reloaded.cycleMeta.cycles).toBe(1);
    expect(reloaded.cycleMeta.scoredTotal).toBe(1);
  });
});

// ── report ──────────────────────────────────────────────────────────────────

describe("report", () => {
  it("surfaces model status, named weights, feature coverage and honest counts", async () => {
    const store = new MetaLabelStore(tmpStorePath("report"));
    for (let i = 0; i < 120; i += 1) {
      store.add(
        labeledRecord(`r-${i}`, null, i % 2 === 0 ? 1 : -1, {
          features: nullFeatures({ regimeAlign: i % 2 === 0 ? 1 : -1 }),
          modelVersion: null,
        }),
      );
    }
    await runMetaLabelCycle({ store, orders: [], sources: NULL_SOURCES, now: T0, minExamples: 100 });
    const report = buildMetaLabelReport(store);
    expect(report.reportOnly).toBe(true);
    expect(report.model.ready).toBe(true);
    expect(report.model.version).toBe(1);
    expect(report.model.nTrain).toBe(120);
    expect(report.model.weights).toHaveLength(META_LABEL_DIM);
    expect(report.model.weights![0]!.feature).toBe("bias");
    expect(report.counts.records).toBe(120);
    expect(report.counts.labeled).toBe(120);
    expect(report.counts.scored).toBe(0); // all were scored before any model existed → null
    expect(report.counts.scoredModelNotReady).toBe(120);
    expect(report.counts.labeledAndScored).toBe(0);
    const regimeCoverage = report.featureCoverage.find((f) => f.feature === "regimeAlign")!;
    expect(regimeCoverage.presentPct).toBeCloseTo(100);
    const kronosCoverage = report.featureCoverage.find((f) => f.feature === "kronosAlign")!;
    expect(kronosCoverage.presentPct).toBeCloseTo(0);
    expect(report.cohorts).toHaveLength(META_LABEL_TAUS.length);
    expect(report.cycleMeta.cycles).toBe(1);
  });
});

describe("[REFIT-STABILITY] wPrior anchoring + coefficient-jump rejection (2026-07-26)", () => {
  // WHY: before this, every nightly refit was an unanchored from-scratch fit with L2 pulling toward
  // ZERO, and the only rejections were min-examples / non-convergence / non-finite. Nothing stopped
  // a refit from landing somewhere completely different from the last healthy model. Measured on
  // real testnet data: successive versions swung between predictive and ANTI-predictive (v3 cohort
  // lift +0.0853R at tau=0.70; v4 cohort -0.2125R on its own walk-forward cohort), so any reported
  // lift was a function of which version happened to be live. cortex-brain.ts already solved exactly
  // this with CORTEX_REFIT_MAX_JUMP + a wPrior-anchored ridge; this mirrors it.
  const separable = () =>
    Array.from({ length: 200 }, (_, i) => {
      const win = i % 2 === 0;
      return { features: nullFeatures({ regimeAlign: win ? 1 : -1 }), y: (win ? 1 : 0) as 0 | 1 };
    });
  const idx = META_LABEL_FEATURE_NAMES.indexOf("regimeAlign");

  it("BACKWARD COMPAT: omitting wPrior reproduces the unanchored fit exactly", () => {
    const a = fitMetaLabelLogistic(separable(), { minExamples: 100 });
    const b = fitMetaLabelLogistic(separable(), { minExamples: 100, wPrior: new Array(META_LABEL_DIM).fill(0) });
    expect(a.status).toBe("ACCEPTED");
    expect(b.status).toBe("ACCEPTED");
    // An all-zero prior IS the old behavior, so the two must agree bit-for-bit.
    expect(b.weights).toEqual(a.weights);
  });

  it("anchors toward the previous model: same data lands closer to wPrior than the unanchored fit", () => {
    const unanchored = fitMetaLabelLogistic(separable(), { minExamples: 100 });
    const prior = new Array(META_LABEL_DIM).fill(0);
    prior[idx] = -2; // a previous model that disagreed with this data
    const anchored = fitMetaLabelLogistic(separable(), { minExamples: 100, wPrior: prior });
    expect(anchored.status).toBe("ACCEPTED");
    // Continuity: the anchored fit must not jump as far from the prior as the unanchored one does.
    expect(Math.abs(anchored.weights[idx]! - prior[idx]!)).toBeLessThan(
      Math.abs(unanchored.weights[idx]! - prior[idx]!),
    );
  });

  it("REJECTS a converged fit that lands further from the prior than META_LABEL_REFIT_MAX_JUMP", () => {
    // Weak shrinkage + a prior on the opposite side: the fit converges (so this is NOT the
    // non-convergence guard) but lands ~1.68, i.e. ~8.7 away from a prior of -7 — past the budget.
    const prior = new Array(META_LABEL_DIM).fill(0);
    prior[idx] = -7;
    const fit = fitMetaLabelLogistic(separable(), { minExamples: 100, lambda: 0.5, wPrior: prior });
    expect(fit.status).toBe("REJECTED_COEFFICIENT_JUMP");
    // On rejection the caller must not install these — mirrors every other rejection path.
    expect(fit.weights.every((v) => v === 0)).toBe(true);
  });

  it("ACCEPTS the same fit one notch inside the budget (the guard is a real boundary, not a blanket)", () => {
    const prior = new Array(META_LABEL_DIM).fill(0);
    prior[idx] = -6; // fit lands ~1.68 => jump ~7.68 < 8
    const fit = fitMetaLabelLogistic(separable(), { minExamples: 100, lambda: 0.5, wPrior: prior });
    expect(fit.status).toBe("ACCEPTED");
    const jump = Math.max(...fit.weights.map((w, k) => Math.abs(w - prior[k]!)));
    expect(jump).toBeLessThanOrEqual(META_LABEL_REFIT_MAX_JUMP);
  });

  it("a diverging (separable, unshrunk) fit is still caught by the pre-existing non-convergence guard", () => {
    // Ordering matters: non-convergence is checked BEFORE the jump budget, so a blown-up fit keeps
    // reporting the more specific existing status rather than being relabelled by the new one.
    const fit = fitMetaLabelLogistic(separable(), { minExamples: 100, lambda: 0 });
    expect(fit.status).toBe("REJECTED_NON_CONVERGENCE");
  });

  it("a far-away prior on saturated data holds the fit AT the prior (documented, not a jump)", () => {
    // Worth pinning: when the prior is extreme, z saturates the sigmoid, the likelihood gradient
    // vanishes and the anchored fit converges immediately at the prior — so this is ACCEPTED with a
    // zero jump, not a rejection. Safe in practice because a prior can only ever be a previously
    // ACCEPTED fit, which this same guard already bounded.
    const prior = new Array(META_LABEL_DIM).fill(0);
    prior[idx] = META_LABEL_REFIT_MAX_JUMP * 10;
    const fit = fitMetaLabelLogistic(separable(), { minExamples: 100, wPrior: prior });
    expect(fit.status).toBe("ACCEPTED");
    expect(fit.weights[idx]!).toBeCloseTo(prior[idx]!, 6);
  });

  it("a malformed wPrior (wrong length / non-finite) degrades to unanchored rather than corrupting the fit", () => {
    const baseline = fitMetaLabelLogistic(separable(), { minExamples: 100 });
    for (const bad of [[1, 2], new Array(META_LABEL_DIM).fill(Number.NaN)] as number[][]) {
      const fit = fitMetaLabelLogistic(separable(), { minExamples: 100, wPrior: bad });
      expect(fit.status).toBe("ACCEPTED");
      expect(fit.weights).toEqual(baseline.weights);
    }
  });
});

describe("[COHORT-PER-MODEL] the sweep must not pool signals scored by different models (2026-07-26)", () => {
  // The pooled table mixes cohorts frozen by different model versions and can therefore report a
  // sign that describes NEITHER. Real measured example: pooled lift at tau=0.70 read +0.0118R while
  // the same records split by cohort were +0.0853R (v3) and -0.2125R (v4, then-current).
  const rows = (): MetaLabelRecord[] => [
    // v1 cohort: high score => good outcome (predictive)
    labeledRecord("v1a", 0.9, 2.0, { modelVersion: 1 }),
    labeledRecord("v1b", 0.8, 1.5, { modelVersion: 1 }),
    labeledRecord("v1c", 0.2, -1.0, { modelVersion: 1 }),
    labeledRecord("v1d", 0.1, -1.5, { modelVersion: 1 }),
    // v2 cohort: high score => bad outcome (anti-predictive)
    labeledRecord("v2a", 0.9, -2.0, { modelVersion: 2 }),
    labeledRecord("v2b", 0.8, -1.5, { modelVersion: 2 }),
    labeledRecord("v2c", 0.2, 1.0, { modelVersion: 2 }),
    labeledRecord("v2d", 0.1, 1.5, { modelVersion: 2 }),
  ];

  it("filtering by modelVersion isolates that cohort's population", () => {
    const pooled = buildMetaLabelCohortTable(rows(), [0.5]);
    const v1 = buildMetaLabelCohortTable(rows(), [0.5], { modelVersion: 1 });
    const v2 = buildMetaLabelCohortTable(rows(), [0.5], { modelVersion: 2 });
    expect(pooled[0]!.n).toBe(8);
    expect(v1[0]!.n).toBe(4);
    expect(v2[0]!.n).toBe(4);
  });

  it("the two cohorts have OPPOSITE lift while the pooled figure hides it", () => {
    const v1 = buildMetaLabelCohortTable(rows(), [0.5], { modelVersion: 1 })[0]!;
    const v2 = buildMetaLabelCohortTable(rows(), [0.5], { modelVersion: 2 })[0]!;
    const pooled = buildMetaLabelCohortTable(rows(), [0.5])[0]!;
    expect(v1.lift!).toBeGreaterThan(0);
    expect(v2.lift!).toBeLessThan(0);
    // The pooled number sits between them and therefore describes neither cohort — the exact
    // failure mode this split exists to prevent.
    expect(Math.abs(pooled.lift!)).toBeLessThan(Math.abs(v1.lift!));
    expect(Math.abs(pooled.lift!)).toBeLessThan(Math.abs(v2.lift!));
  });
});

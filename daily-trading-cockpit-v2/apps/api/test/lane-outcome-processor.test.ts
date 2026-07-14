import { describe, it, expect } from "vitest";
import {
  planResolutions, emptyCheckpoint, parseCheckpoint, resolutionIdFor, rebuildConsumedFromRecords, SingleFlight,
  RESOLUTION_CHECKPOINT_SCHEMA, type ClosedOutcomeInput, type ResolutionCheckpoint,
} from "../src/lib/lane-outcome-processor.js";
import { buildLaneContextSnapshot, type LaneContextSnapshot, LANE_CONTEXT_SCHEMA_VERSION } from "../src/lib/lane-context-journal.js";

const MIN = 60_000;
const outcome = (over: Partial<ClosedOutcomeInput> = {}): ClosedOutcomeInput => ({
  outcomeId: over.outcomeId ?? "o1", laneId: over.laneId ?? "CG_LONG", symbolOrBasketId: over.symbolOrBasketId ?? "BTCUSDT",
  direction: over.direction ?? "LONG", openedAtMs: over.openedAtMs ?? 2000, closedAtMs: over.closedAtMs === undefined ? 5000 : over.closedAtMs,
  resolvedAtMs: over.resolvedAtMs === undefined ? 6000 : over.resolvedAtMs, grossR: 0.55, costR: -0.05, netR: over.netR ?? 0.5,
  closeReason: over.closeReason ?? "TP1_HIT", closeIntrabarAmbiguous: over.closeIntrabarAmbiguous ?? false,
  featureSchemaVersion: over.featureSchemaVersion ?? LANE_CONTEXT_SCHEMA_VERSION, terminal: over.terminal ?? true,
});
const snap = (over: Partial<LaneContextSnapshot> = {}): LaneContextSnapshot => buildLaneContextSnapshot({
  decisionId: over.decisionId ?? "d1", asOfMs: over.asOfMs ?? 1000, instanceId: "3102", laneId: over.laneId ?? "CG_LONG",
  symbolOrBasketId: over.symbolOrBasketId ?? "BTCUSDT", direction: over.direction ?? "LONG", regimeFamily: "TREND",
  axisScore: 0.4, transitionRisk: 0.2, longEdge: 0.05, shortEdge: null, edgeMemory: 0.05, edgeMemoryN: 42, conviction: 0.6,
  controllerMode: "GRADUATED", incumbentEligible: true, vetoed: false, vetoReason: null, staticWeightPct: 25, cortexFinalPct: null,
  sourceStatuses: { edge: "FRESH" }, featureSchemaVersion: over.featureSchemaVersion ?? LANE_CONTEXT_SCHEMA_VERSION,
});
const OPTS = { ttlMs: 30 * MIN, reprocessWindowMs: 60 * MIN, maxConsumed: 1000, instanceId: "3102", nowMs: 10_000 };
const noDecisions = () => [] as LaneContextSnapshot[];

describe("resolution processor — dedup, watermark, legacy, determinism", () => {
  it("a LEGACY close (resolvedAtMs null) is NEVER emitted", () => {
    const r = planResolutions([outcome({ resolvedAtMs: null })], noDecisions, emptyCheckpoint("3102"), OPTS);
    expect(r.emit).toHaveLength(0);
    expect(r.metrics.skippedLegacyNoResolvedAt).toBe(1);
  });
  it("resolution id is DETERMINISTIC across runs (retried append dedupes)", () => {
    expect(resolutionIdFor("o1", 6000)).toBe(resolutionIdFor("o1", 6000));
    expect(resolutionIdFor("o1", 6000)).not.toBe(resolutionIdFor("o1", 6001));
    const a = planResolutions([outcome()], noDecisions, emptyCheckpoint("3102"), OPTS);
    const b = planResolutions([outcome()], noDecisions, emptyCheckpoint("3102"), OPTS);
    expect(a.emit[0]!.resolutionId).toBe(b.emit[0]!.resolutionId);
  });
  it("one outcome resolves EXACTLY once — a second scan with the updated checkpoint emits nothing", () => {
    const first = planResolutions([outcome()], noDecisions, emptyCheckpoint("3102"), OPTS);
    expect(first.emit).toHaveLength(1);
    const second = planResolutions([outcome()], noDecisions, first.nextCheckpoint, OPTS);
    expect(second.emit).toHaveLength(0);
    expect(second.metrics.skippedAlreadyConsumed).toBe(1);
  });
  it("CRASH after append before checkpoint: rebuild consumed from journal ⇒ no duplicate on the old checkpoint", () => {
    const oldCkpt = emptyCheckpoint("3102");
    const first = planResolutions([outcome()], noDecisions, oldCkpt, OPTS); // journal appended...
    expect(first.emit).toHaveLength(1);
    // ...but checkpoint NOT persisted (crash). On restart, rebuild consumed (by resolvedAtMs ≥ floor) from the journal tail.
    const floor = oldCkpt.highWatermarkResolvedAtMs - OPTS.reprocessWindowMs;
    const recovered: ResolutionCheckpoint = { ...oldCkpt, consumed: rebuildConsumedFromRecords(first.emit.map((r) => ({ outcomeId: r.outcomeId, resolvedAtMs: r.resolvedAtMs })), floor) };
    const rescan = planResolutions([outcome()], noDecisions, recovered, OPTS);
    expect(rescan.emit).toHaveLength(0); // recovered — no duplicate semantic record
  });
  it("CRASH before append (nothing persisted): a re-plan re-emits the SAME deterministic record (no loss, dedupable)", () => {
    const a = planResolutions([outcome()], noDecisions, emptyCheckpoint("3102"), OPTS);
    const b = planResolutions([outcome()], noDecisions, emptyCheckpoint("3102"), OPTS);
    expect(b.emit).toHaveLength(1);
    expect(b.emit[0]!.resolutionId).toBe(a.emit[0]!.resolutionId); // same id ⇒ the append layer dedupes the retry
  });
  it("below-watermark-window outcome is not re-emitted even if dropped from the consumed set", () => {
    const ckpt: ResolutionCheckpoint = { ...emptyCheckpoint("3102"), highWatermarkResolvedAtMs: 100 * MIN, consumedOutcomeIds: [] };
    const old = planResolutions([outcome({ outcomeId: "ancient", resolvedAtMs: 10 * MIN })], noDecisions, ckpt, { ...OPTS, reprocessWindowMs: 5 * MIN });
    expect(old.emit).toHaveLength(0);
    expect(old.metrics.skippedBelowWatermarkWindow).toBe(1);
  });
  it("REGRESSION (findings 1/2): tied resolvedAtMs at the watermark are NOT re-emitted even when count > maxConsumed", () => {
    const os = [outcome({ outcomeId: "a", resolvedAtMs: 6000 }), outcome({ outcomeId: "b", resolvedAtMs: 6000 }), outcome({ outcomeId: "c", resolvedAtMs: 6000 })];
    const r1 = planResolutions(os, noDecisions, emptyCheckpoint("3102"), { ...OPTS, maxConsumed: 2 });
    expect(r1.emit).toHaveLength(3);
    expect(r1.nextCheckpoint.consumed).toHaveLength(3); // in-window ids are RETAINED, not evicted by count
    expect(r1.metrics.consumedOverflow).toBe(true); // surfaced tripwire (window population > maxConsumed)
    const r2 = planResolutions(os, noDecisions, r1.nextCheckpoint, { ...OPTS, maxConsumed: 2 }); // rescan the SAME tied batch
    expect(r2.emit).toHaveLength(0); // NONE re-emitted (the old count-FIFO would have dropped an id ⇒ duplicate)
  });
  it("consumed set is TIME-bounded: an entry falls out only once its resolvedAtMs drops below the floor", () => {
    const r1 = planResolutions([outcome({ outcomeId: "old", resolvedAtMs: 6000 })], noDecisions, emptyCheckpoint("3102"), OPTS);
    expect(r1.nextCheckpoint.consumed.map((c) => c.id)).toEqual(["old"]);
    // a far-future outcome advances the watermark; with a SMALL window, 'old' is now below floor ⇒ pruned.
    const r2 = planResolutions([outcome({ outcomeId: "new", resolvedAtMs: 6000 + 100 * MIN })], noDecisions, r1.nextCheckpoint, { ...OPTS, reprocessWindowMs: 10 * MIN });
    expect(r2.nextCheckpoint.consumed.map((c) => c.id)).toEqual(["new"]); // 'old' pruned by TIME, not count
  });
});

describe("resolution processor — attribution + checkpoint safety + single-flight", () => {
  it("attributes to the LATEST eligible pre-open snapshot; records lag; sets ATTRIBUTED", () => {
    const decisions = [snap({ decisionId: "old", asOfMs: 500 }), snap({ decisionId: "latest", asOfMs: 1900 }), snap({ decisionId: "afterOpen", asOfMs: 2500 })];
    const r = planResolutions([outcome({ openedAtMs: 2000 })], () => decisions, emptyCheckpoint("3102"), OPTS);
    expect(r.emit[0]!.attributionStatus).toBe("ATTRIBUTED");
    expect(r.emit[0]!.attributedDecisionId).toBe("latest");
    expect(r.emit[0]!.attributionLagMs).toBe(2000 - 1900);
  });
  it("no snapshot yet ⇒ NO_ELIGIBLE_DECISION (still emitted, honestly)", () => {
    const r = planResolutions([outcome()], noDecisions, emptyCheckpoint("3102"), OPTS);
    expect(r.emit[0]!.attributionStatus).toBe("NO_ELIGIBLE_DECISION");
  });
  it("a MISSING market close ts ⇒ MISSING_CLOSE_TIMESTAMP (excluded from gold)", () => {
    const r = planResolutions([outcome({ closedAtMs: null })], () => [snap()], emptyCheckpoint("3102"), OPTS);
    expect(r.emit[0]!.attributionStatus).toBe("MISSING_CLOSE_TIMESTAMP");
  });
  it("corrupt / wrong-instance checkpoint FAILS OPEN to empty + flagged", () => {
    expect(parseCheckpoint("not json", "3102").corrupt).toBe(true);
    expect(parseCheckpoint(JSON.stringify({ schemaVersion: "wrong" }), "3102").corrupt).toBe(true);
    // a valid checkpoint for a DIFFERENT instance is rejected (isolation) — never cross-applied.
    const other = JSON.stringify({ ...emptyCheckpoint("3101"), schemaVersion: RESOLUTION_CHECKPOINT_SCHEMA });
    expect(parseCheckpoint(other, "3102").corrupt).toBe(true);
    expect(parseCheckpoint(null, "3102").corrupt).toBe(false); // absent is fine, not corrupt
  });
  it("single-flight skips an overlapping scan", async () => {
    const sf = new SingleFlight();
    let running = 0, maxConcurrent = 0;
    const task = async () => { running += 1; maxConcurrent = Math.max(maxConcurrent, running); await Promise.resolve(); running -= 1; return "ok"; };
    const [a, b] = await Promise.all([sf.run(task), sf.run(task)]);
    expect([a, b].filter((x) => x === "ok")).toHaveLength(1); // one ran, one was skipped (null)
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
    expect(maxConcurrent).toBe(1);
  });
});

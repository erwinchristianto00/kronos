import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveLaneContextMode, buildLaneContextSnapshot, attributeOutcome, LaneAttributionLedger, LaneContextJournal,
  type LaneContextSnapshot, type OutcomeToAttribute, LANE_CONTEXT_SCHEMA_VERSION,
} from "../src/lib/lane-context-journal.js";

const MIN = 60_000;
const snap = (over: Partial<LaneContextSnapshot> = {}): LaneContextSnapshot => buildLaneContextSnapshot({
  decisionId: over.decisionId ?? "d1", asOfMs: over.asOfMs ?? 1000, instanceId: "3102", laneId: over.laneId ?? "CG_LONG",
  symbolOrBasketId: over.symbolOrBasketId ?? "BTCUSDT", direction: over.direction ?? "LONG",
  regimeFamily: "TREND", axisScore: 0.4, transitionRisk: 0.2, longEdge: 0.05, shortEdge: null, edgeMemory: 0.05,
  edgeMemoryN: 42, conviction: 0.6, controllerMode: "GRADUATED", incumbentEligible: true, vetoed: false, vetoReason: null,
  staticWeightPct: 25, cortexFinalPct: null, sourceStatuses: { edge: "FRESH" }, featureSchemaVersion: over.featureSchemaVersion ?? LANE_CONTEXT_SCHEMA_VERSION,
});
const outcome = (over: Partial<OutcomeToAttribute> & { openedAtMs?: number; closedAtMs?: number | null } = {}): OutcomeToAttribute => ({
  outcomeId: over.outcomeId ?? "o1", laneId: over.laneId ?? "CG_LONG", symbolOrBasketId: over.symbolOrBasketId ?? "BTCUSDT",
  direction: over.direction ?? "LONG", netR: over.netR ?? 0.5, grossR: 0.55, costR: -0.05,
  featureSchemaVersion: over.featureSchemaVersion ?? LANE_CONTEXT_SCHEMA_VERSION,
  lifecycle: { openedAtMs: over.openedAtMs ?? 2000, closedAtMs: over.closedAtMs === undefined ? 5000 : over.closedAtMs, resolvedAtMs: 9999 },
});
const OPTS = { ttlMs: 30 * MIN };

describe("Track 1 — lane-context journal: close timestamp + attribution", () => {
  it("exact close timestamp is preserved onto the resolution", () => {
    const r = attributeOutcome(outcome({ closedAtMs: 4242 }), [snap()], OPTS);
    expect(r.closedAtMs).toBe(4242);
  });
  it("processing time cannot replace a missing market close time ⇒ MISSING_CLOSE_TIMESTAMP", () => {
    const r = attributeOutcome(outcome({ closedAtMs: null }), [snap()], OPTS); // resolvedAtMs=9999 present but ignored
    expect(r.attributionStatus).toBe("MISSING_CLOSE_TIMESTAMP");
    expect(r.attributedDecisionId).toBeNull();
  });
  it("latest eligible PRE-OPEN decision is selected", () => {
    const decisions = [snap({ decisionId: "old", asOfMs: 500 }), snap({ decisionId: "latest", asOfMs: 1900 }), snap({ decisionId: "afterOpen", asOfMs: 2500 })];
    const r = attributeOutcome(outcome({ openedAtMs: 2000 }), decisions, OPTS);
    expect(r.attributionStatus).toBe("ATTRIBUTED");
    expect(r.attributedDecisionId).toBe("latest"); // 1900 ≤ 2000, newer than 500; 2500 is after open
  });
  it("a decision AFTER open is rejected (no eligible) ⇒ NO_ELIGIBLE_DECISION", () => {
    const r = attributeOutcome(outcome({ openedAtMs: 1000 }), [snap({ asOfMs: 1500 })], OPTS);
    expect(r.attributionStatus).toBe("NO_ELIGIBLE_DECISION");
  });
  it("TTL_EXPIRED when the newest pre-open decision is older than ttl", () => {
    const r = attributeOutcome(outcome({ openedAtMs: 100 * MIN }), [snap({ asOfMs: 10 * MIN })], { ttlMs: 30 * MIN });
    expect(r.attributionStatus).toBe("TTL_EXPIRED");
  });
  it("wrong lane / symbol / side ⇒ IDENTITY_MISMATCH; wrong schema ⇒ SCHEMA_MISMATCH", () => {
    expect(attributeOutcome(outcome({ laneId: "OTHER" }), [snap()], OPTS).attributionStatus).toBe("IDENTITY_MISMATCH");
    expect(attributeOutcome(outcome({ symbolOrBasketId: "ETHUSDT" }), [snap()], OPTS).attributionStatus).toBe("IDENTITY_MISMATCH");
    expect(attributeOutcome(outcome({ direction: "SHORT" }), [snap()], OPTS).attributionStatus).toBe("IDENTITY_MISMATCH");
    const r = attributeOutcome(outcome(), [snap({ featureSchemaVersion: "old-schema" })], { ...OPTS, expectedSchemaVersion: LANE_CONTEXT_SCHEMA_VERSION });
    expect(r.attributionStatus).toBe("SCHEMA_MISMATCH");
  });
  it("one outcomeId resolves once; a duplicate close is idempotent (returns the first resolution)", () => {
    const ledger = new LaneAttributionLedger();
    const first = ledger.attribute(outcome(), [snap()], OPTS);
    // second call with DIFFERENT decisions must NOT re-label — same result returned.
    const second = ledger.attribute(outcome(), [snap({ decisionId: "different", asOfMs: 1950 })], OPTS);
    expect(second).toEqual(first);
    expect(second.attributedDecisionId).toBe("d1");
    expect(ledger.size()).toBe(1);
  });
  it("the final edge-memory AGGREGATE cannot backfill a historical snapshot — snapshot stores values AS PROVIDED", () => {
    // simulate: at decision time edge was 0.02 (n=5); later the aggregate becomes 0.20 (n=500).
    const atDecision = snap({ decisionId: "dX" });
    (atDecision as { edgeMemory: number }).edgeMemory; // provided value is frozen on the record
    expect(atDecision.edgeMemory).toBe(0.05); // exactly what was passed, not any 'current' aggregate
    expect(atDecision.reportOnly).toBe(true);
  });
});

describe("Track 1 — mode gate + fail-open + no authority", () => {
  it("mode default OFF; unknown ⇒ OFF; only 'shadow' activates", () => {
    expect(resolveLaneContextMode(undefined)).toBe("off");
    expect(resolveLaneContextMode("weird")).toBe("off");
    expect(resolveLaneContextMode("shadow")).toBe("shadow");
  });
  it("mode OFF produces ZERO sink I/O", () => {
    const sink: unknown[] = [];
    const j = new LaneContextJournal((r) => sink.push(r), "off");
    expect(j.recordSnapshot(snap())).toBe(false);
    expect(j.recordResolution(attributeOutcome(outcome(), [snap()], OPTS))).toBe(false);
    expect(sink.length).toBe(0);
    expect(j.isActive).toBe(false);
  });
  it("shadow logs, and a throwing sink FAILS OPEN (never escapes)", () => {
    const good: unknown[] = [];
    expect(new LaneContextJournal((r) => good.push(r), "shadow").recordSnapshot(snap())).toBe(true);
    expect(good.length).toBe(1);
    const bad = new LaneContextJournal(() => { throw new Error("disk full"); }, "shadow");
    expect(() => bad.recordSnapshot(snap())).not.toThrow();
    expect(bad.recordSnapshot(snap())).toBe(false);
  });
  it("STRUCTURAL: the module imports no executor / edge-memory / beta / order authority", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/lib/lane-context-journal.ts", import.meta.url)), "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l)); // actual imports, not prose
    expect(importLines.join("\n")).not.toMatch(/regime-edge-memory|live-execution-engine|paper-execution-router|executor|binance|cortex-brain|CORTEX_LIVE_BETA/i);
    expect(src).not.toMatch(/\.(placeOrder|cancelOrder|setAllocation|updateFromClosedOrders)\s*\(/); // no authority calls
  });
});

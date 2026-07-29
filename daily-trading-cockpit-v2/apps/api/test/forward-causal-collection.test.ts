import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  deterministicOutcomeId,
  forwardCausalJournalPath,
  prepareForwardCausalIdentity,
  recordForwardOpportunity,
  recordForwardOutcome,
  recordForwardOutcomes,
  resolveCausalCollectionActivation,
  withResolvedCausalIdentity,
  type ForwardPaperOrderLike,
} from "../src/experience-engine/forward-causal-collection.js";
import { auditForwardCausalEvents, type ForwardCausalEvent } from "../src/experience-engine/forward-causal-auditor.js";
import { buildCortexExperienceBridge } from "../src/experience-engine/cortex-experience-bridge.js";
import { CORTEX_FEATURE_SCHEMA_VERSION } from "../src/lib/cortex-brain.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function order(): ForwardPaperOrderLike {
  return {
    paperOrderId: "paper-semantic-1", sourceCandidateId: "candidate-semantic-1", sourceObservationId: "observation-1",
    openedAt: new Date(1_000).toISOString(), selectedLaneId: "CG_WIDE_FAST_LONG", symbol: "BTCUSDT", direction: "LONG",
    regime: "BULLISH", controllerMode: "LONG_ONLY", entryPrice: 100, stopLoss: 95, takeProfitLevels: [110],
    plannedStopDistanceBps: 500, provenance: { routeScore: 0.8, expectedNetR: 0.4, costR: -0.02, feeSlippageR: -0.01, spreadR: -0.01 },
    provenanceFieldMissing: [], paperStatus: "PAPER_SUBMITTED",
  };
}
function shadowEnv(dir: string): NodeJS.ProcessEnv {
  return { PORT: "3102", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir };
}

describe("forward causal collection", () => {
  it("is default-off and hard-blocks 3103 without filesystem I/O", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-off-")); dirs.push(dir);
    const env = { PORT: "3102", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir };
    const o = order();
    expect(resolveCausalCollectionActivation(env).reason).toBe("mode-off");
    expect(prepareForwardCausalIdentity(o, env)).toBeNull();
    expect(recordForwardOpportunity(o, env)).toBe(false);
    expect(existsSync(join(dir, "causal-experience"))).toBe(false);
    expect(resolveCausalCollectionActivation({ ...env, PORT: "3103", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow" }).reason).toBe("live-3103-blocked");
  });

  it("preserves exact IDs across decision, open, resolution, duplicate calls, and restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-shadow-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order();
    const identity = prepareForwardCausalIdentity(o, env);
    expect(identity).not.toBeNull();
    o.causalIdentity = identity;
    expect(prepareForwardCausalIdentity(o, env)).toEqual(identity); // restart reads persisted identity, never remints it
    expect(recordForwardOpportunity(o, env)).toBe(true);
    expect(recordForwardOpportunity(o, env)).toBe(false);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.3; o.costR = -0.02; o.netR = 0.28; o.closeReason = "TP1_HIT";
    const outcomeId = deterministicOutcomeId(o);
    expect(outcomeId).toBe(deterministicOutcomeId({ ...o }));
    o.causalIdentity = withResolvedCausalIdentity(o);
    expect(o.causalIdentity?.outcomeId).toBe(outcomeId);
    expect(recordForwardOutcome(o, env)).toBe(true);
    expect(recordForwardOutcome(o, env)).toBe(false);
    const path = forwardCausalJournalPath(env)!;
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ForwardCausalEvent);
    expect(events.map((event) => event.eventType)).toEqual(["DECISION_SNAPSHOT", "OPPORTUNITY_OPEN", "OUTCOME_RESOLUTION"]);
    const audit = auditForwardCausalEvents(events);
    expect(audit.completeChains).toBe(1);
    expect(audit.directChains).toBe(1);
    expect(auditForwardCausalEvents(events).auditHash).toBe(audit.auditHash);
  });

  it("invalidates its event-id cache after an external append", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-cache-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order();
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    expect(recordForwardOpportunity(o, env)).toBe(true);
    const path = forwardCausalJournalPath(env)!;
    appendFileSync(path, `${JSON.stringify({ eventId: "external-event" })}\n`);
    expect(recordForwardOpportunity(o, env)).toBe(false);
    const ids = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line).eventId);
    expect(ids.filter((id) => id === o.causalIdentity!.decisionId)).toHaveLength(1);
    expect(ids).toContain("external-event");
  });

  it("appends a resolver batch once and deduplicates repeated outcomes", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-batch-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order();
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    expect(recordForwardOpportunity(o, env)).toBe(true);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.2; o.costR = -0.02; o.netR = 0.18;
    o.causalIdentity = withResolvedCausalIdentity(o);
    expect(recordForwardOutcomes([o, { ...o }], env)).toBe(true);
    expect(recordForwardOutcomes([o], env)).toBe(false);
    const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.eventType === "OUTCOME_RESOLUTION")).toHaveLength(1);
  });

  it("never substitutes process time for market open or close timestamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-time-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order(); o.causalIdentity = prepareForwardCausalIdentity(o, env);
    expect(recordForwardOpportunity(o, env)).toBe(true);
    o.paperStatus = "PAPER_CLOSED_LOSS"; o.resolvedAtMs = 3_000; o.grossR = -1; o.costR = -0.02; o.netR = -1.02;
    expect(deterministicOutcomeId(o)).toBeNull();
    expect(recordForwardOutcome(o, env)).toBe(false);
    expect(readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("uses direct opportunity linkage, not a nearby alternative decision", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-exact-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order(); o.causalIdentity = prepareForwardCausalIdentity(o, env);
    recordForwardOpportunity(o, env);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.1; o.costR = -0.01; o.netR = 0.09; o.causalIdentity = withResolvedCausalIdentity(o);
    recordForwardOutcome(o, env);
    const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ForwardCausalEvent);
    const real = events.find((event) => event.eventType === "DECISION_SNAPSHOT")! as Extract<ForwardCausalEvent, { eventType: "DECISION_SNAPSHOT" }>;
    events.push({ ...real, eventId: "nearby-but-not-linked", identity: { ...real.identity, decisionId: "nearby-decision" }, asOfMs: 999 } as ForwardCausalEvent);
    const audit = auditForwardCausalEvents(events);
    expect(audit.audits[0]?.selectedDecisionId).toBe(real.identity.decisionId);
    expect(audit.completeChains).toBe(1);
  });

  it("emits a CORTEX sample only from an exact persisted CORTEX snapshot and direct three-id chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-cortex-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order();
    o.cortexDecisionSnapshot = {
      decisionId: "cortex-decision:900:1:CG_WIDE_FAST_LONG",
      atMs: 900,
      laneId: "CG_WIDE_FAST_LONG",
      direction: "LONG",
      featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
      featureVector: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0.5],
      regimeFamily: "BULL",
      eligible: true,
      finalPct: 0,
      evalFinalPct: 0,
    };
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    recordForwardOpportunity(o, env);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.2; o.costR = -0.02; o.netR = 0.18;
    o.causalIdentity = withResolvedCausalIdentity(o);
    recordForwardOutcome(o, env);
    const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ForwardCausalEvent);
    const bridge = buildCortexExperienceBridge(events);
    expect(bridge.experiences).toHaveLength(1);
    expect(bridge.outcomes).toHaveLength(1);
    expect(bridge.outcomes[0]?.decisionId).toBe(o.cortexDecisionSnapshot.decisionId);
    expect(bridge.rejected).toEqual({});
  });

  it("rejects legacy, identity-mismatched, schema-mismatched, and future-decision chains", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-reject-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order(); o.causalIdentity = prepareForwardCausalIdentity(o, env);
    recordForwardOpportunity(o, env);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.1; o.costR = -0.01; o.netR = 0.09; o.causalIdentity = withResolvedCausalIdentity(o);
    recordForwardOutcome(o, env);
    const base = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ForwardCausalEvent);
    const outcome = base.find((event) => event.eventType === "OUTCOME_RESOLUTION")! as Extract<ForwardCausalEvent, { eventType: "OUTCOME_RESOLUTION" }>;
    const decision = base.find((event) => event.eventType === "DECISION_SNAPSHOT")! as Extract<ForwardCausalEvent, { eventType: "DECISION_SNAPSHOT" }>;
    expect(auditForwardCausalEvents(base.filter((event) => event.eventType !== "DECISION_SNAPSHOT")).completeChains).toBe(0); // legacy/unlinked cannot borrow history
    const schemaMismatch = base.map((event) => event === outcome ? { ...outcome, identity: { ...outcome.identity, featureSchemaVersion: "other-schema" } } : event) as ForwardCausalEvent[];
    expect(auditForwardCausalEvents(schemaMismatch).audits[0]?.rejectionReason).toBe("SCHEMA_MISMATCH");
    const laneMismatch = base.map((event) => event === outcome ? { ...outcome, identity: { ...outcome.identity, laneId: "OTHER_LANE" } } : event) as ForwardCausalEvent[];
    expect(auditForwardCausalEvents(laneMismatch).audits[0]?.rejectionReason).toBe("LANE_MISMATCH");
    const futureDecision = base.map((event) => event === decision ? { ...decision, asOfMs: 1_500 } : event) as ForwardCausalEvent[];
    expect(auditForwardCausalEvents(futureDecision).audits[0]?.rejectionReason).toBe("FUTURE_FEATURE_LEAKAGE");
  });

  it("rejects a pre-hardening journal row without cortexTraining instead of aborting the refit", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-legacy-cortex-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order();
    o.cortexDecisionSnapshot = {
      decisionId: "cortex-decision:900:1:CG_WIDE_FAST_LONG", atMs: 900, laneId: "CG_WIDE_FAST_LONG", direction: "LONG",
      featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION, featureVector: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0.5],
      regimeFamily: "BULL", eligible: true, finalPct: 0, evalFinalPct: 0,
    };
    o.causalIdentity = prepareForwardCausalIdentity(o, env); recordForwardOpportunity(o, env);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.2; o.costR = -0.02; o.netR = 0.18;
    o.causalIdentity = withResolvedCausalIdentity(o); recordForwardOutcome(o, env);
    const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ForwardCausalEvent);
    const legacy = events.map((event) => event.eventType === "DECISION_SNAPSHOT"
      ? (() => { const { cortexTraining: _removed, ...row } = event; return row as ForwardCausalEvent; })()
      : event);
    expect(buildCortexExperienceBridge(legacy).outcomes).toEqual([]);
    expect(buildCortexExperienceBridge(legacy).rejected).toMatchObject({ missing_or_incompatible_cortex_snapshot: 1 });
  });

  it("fails open on journal failure without mutating the incumbent order", () => {
    const o = order(); const env = shadowEnv("/dev/null");
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    const before = JSON.parse(JSON.stringify(o));
    expect(recordForwardOpportunity(o, env)).toBe(false);
    expect(o).toEqual(before);
  });
});

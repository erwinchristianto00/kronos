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
  readForwardCausalEventsStrict,
  resolveCanonicalPolicyContext,
  resolveCausalCollectionActivation,
  withResolvedCausalIdentity,
  type ForwardPaperOrderLike,
} from "../src/experience-engine/forward-causal-collection.js";
import { auditForwardCausalEvents, type ForwardCausalEvent } from "../src/experience-engine/forward-causal-auditor.js";
import { buildCortexExperienceBridge } from "../src/experience-engine/cortex-experience-bridge.js";
import { CORTEX_FEATURE_SCHEMA_VERSION } from "../src/lib/cortex-brain.js";
import { CURRENT_DECISION_POLICY_VERSION, CURRENT_EVIDENCE_ERA, EVIDENCE_POLICY_VERSION, EXECUTION_POLICY_VERSION } from "@dtc/shared";

const DEPLOYMENT_AT = "1970-01-01T00:00:00.500Z";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function order(): ForwardPaperOrderLike {
  return {
    paperOrderId: "paper-semantic-1", sourceCandidateId: "candidate-semantic-1", sourceObservationId: "observation-1",
    openedAt: new Date(1_000).toISOString(), createdAt: new Date(900).toISOString(), firstSeenAt: new Date(900).toISOString(), selectedLaneId: "CG_WIDE_FAST_LONG", symbol: "BTCUSDT", direction: "LONG",
    regime: "BULLISH", controllerMode: "LONG_ONLY", entryPrice: 100, stopLoss: 95, takeProfitLevels: [110],
    plannedStopDistanceBps: 500, provenance: { routeScore: 0.8, expectedNetR: 0.4, costR: -0.02, feeSlippageR: -0.01, spreadR: -0.01 },
    provenanceFieldMissing: [], paperStatus: "PAPER_SUBMITTED",
    decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    evidenceEra: CURRENT_EVIDENCE_ERA,
    policyDeploymentAt: DEPLOYMENT_AT,
  };
}
function shadowEnv(dir: string): NodeJS.ProcessEnv {
  return { PORT: "3102", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir, END_TO_END_CORRECTNESS_DEPLOYED_AT: DEPLOYMENT_AT };
}

describe("forward causal collection", () => {
  it("strict reader accepts one torn final append tail but blocks malformed historical rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-strict-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order();
    o.scanBatchId = "cortex-batch-1";
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    expect(recordForwardOpportunity(o, env)).toBe(true);
    const journal = forwardCausalJournalPath(env)!;
    appendFileSync(journal, "{torn");
    expect(readForwardCausalEventsStrict(journal)).toMatchObject({ status: "VALID", ignoredTornTail: true });
    appendFileSync(journal, "\n{bad}\n");
    expect(readForwardCausalEventsStrict(journal).status).toBe("FORWARD_CAUSAL_JOURNAL_CORRUPTED");
  });
  it("strict reader rejects structurally incomplete decision/open rows and conflicting event IDs", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-strict-schema-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order();
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    expect(recordForwardOpportunity(o, env)).toBe(true);
    const journal = forwardCausalJournalPath(env)!;
    const rows = readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    rows[0].cortexTraining = { ...rows[0].cortexTraining, status: "PRESENT", featureVector: [Number.NaN] };
    appendFileSync(journal, `${JSON.stringify(rows[0])}\n`);
    expect(readForwardCausalEventsStrict(journal).status).toBe("FORWARD_CAUSAL_SCHEMA_MISMATCH");

    const clean = join(dir, "clean.jsonl");
    const first = JSON.parse(readFileSync(journal, "utf8").split("\n")[0]!);
    appendFileSync(clean, `${JSON.stringify(first)}\n${JSON.stringify({ ...first, marketState: { regime: "OTHER", status: "PRESENT" } })}\n`);
    expect(readForwardCausalEventsStrict(clean).status).toBe("FORWARD_CAUSAL_DUPLICATE_CONFLICT");
  });
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

  // 2026-08-05 (identity-spoofing fix): the ONLY correct way to authorize an isolated staging mirror
  // physically running on a non-3101/3102 port is an explicit FOUR_BRAIN_LOGICAL_ROLE grant — never
  // FOUR_BRAIN_INSTANCE_ID=3101/3102, which makes resolveFourBrainInstanceId LIE and propagates a
  // false identity into the journal permanently. See CausalIdentity.logicalRole's own doc comment.
  describe("staging identity — role-based authorization, never relabeled instanceId", () => {
    it("[fail-closed] instanceId=3111, no role grant: activation fails closed, never mints, never emits instanceId=3101", () => {
      const dir = mkdtempSync(join(tmpdir(), "causal-role-none-")); dirs.push(dir);
      const env: NodeJS.ProcessEnv = { PORT: "3111", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir, END_TO_END_CORRECTNESS_DEPLOYED_AT: DEPLOYMENT_AT };
      const activation = resolveCausalCollectionActivation(env);
      expect(activation).toMatchObject({ active: false, instanceId: "3111", logicalRole: null, reason: "unknown-instance-fail-closed" });
      expect(prepareForwardCausalIdentity(order(), env)).toBeNull();
      expect(recordForwardOpportunity(order(), env)).toBe(false);
      expect(existsSync(join(dir, "causal-experience"))).toBe(false);
    });

    it("[research-staging] instanceId=3111 + FOUR_BRAIN_LOGICAL_ROLE=RESEARCH: activates, and every emitted identity/journal event carries instanceId=3111 — NEVER 3101", () => {
      const dir = mkdtempSync(join(tmpdir(), "causal-role-research-")); dirs.push(dir);
      const env: NodeJS.ProcessEnv = { PORT: "3111", FOUR_BRAIN_LOGICAL_ROLE: "RESEARCH", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir, END_TO_END_CORRECTNESS_DEPLOYED_AT: DEPLOYMENT_AT };
      const activation = resolveCausalCollectionActivation(env);
      expect(activation).toMatchObject({ active: true, instanceId: "3111", logicalRole: "RESEARCH", reason: "shadow-active" });
      const identity = prepareForwardCausalIdentity(order(), env);
      expect(identity).toMatchObject({ instanceId: "3111", logicalRole: "RESEARCH" });
      expect(identity!.instanceId).not.toBe("3101");
      const o = order(); o.causalIdentity = identity;
      expect(recordForwardOpportunity(o, env)).toBe(true);
      const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.identity.instanceId).toBe("3111");
        expect(event.identity.instanceId).not.toBe("3101");
        expect(event.identity.logicalRole).toBe("RESEARCH");
      }
    });

    it("[testnet-staging] instanceId=3112 + FOUR_BRAIN_LOGICAL_ROLE=TESTNET: activates, and every emitted identity/journal event carries instanceId=3112 — NEVER 3102", () => {
      const dir = mkdtempSync(join(tmpdir(), "causal-role-testnet-")); dirs.push(dir);
      const env: NodeJS.ProcessEnv = { PORT: "3112", FOUR_BRAIN_LOGICAL_ROLE: "TESTNET", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir, END_TO_END_CORRECTNESS_DEPLOYED_AT: DEPLOYMENT_AT };
      const activation = resolveCausalCollectionActivation(env);
      expect(activation).toMatchObject({ active: true, instanceId: "3112", logicalRole: "TESTNET", reason: "shadow-active" });
      const identity = prepareForwardCausalIdentity(order(), env);
      expect(identity).toMatchObject({ instanceId: "3112", logicalRole: "TESTNET" });
      expect(identity!.instanceId).not.toBe("3102");
      const o = order(); o.causalIdentity = identity;
      expect(recordForwardOpportunity(o, env)).toBe(true);
      const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.identity.instanceId).toBe("3112");
        expect(event.identity.instanceId).not.toBe("3102");
        expect(event.identity.logicalRole).toBe("TESTNET");
      }
    });

    it("[fail-closed, 3103 survives a role grant] a role grant can never reach the live instance — instanceId=3103 stays hard-blocked even with FOUR_BRAIN_LOGICAL_ROLE set, and even when PORT alone (id unset) says 3103", () => {
      const dir = mkdtempSync(join(tmpdir(), "causal-role-3103-")); dirs.push(dir);
      const base = { CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir, END_TO_END_CORRECTNESS_DEPLOYED_AT: DEPLOYMENT_AT } as const;
      expect(resolveCausalCollectionActivation({ ...base, PORT: "3103", FOUR_BRAIN_LOGICAL_ROLE: "RESEARCH" } as NodeJS.ProcessEnv))
        .toMatchObject({ active: false, reason: "live-3103-blocked" });
      expect(resolveCausalCollectionActivation({ ...base, PORT: "3103", FOUR_BRAIN_LOGICAL_ROLE: "TESTNET" } as NodeJS.ProcessEnv))
        .toMatchObject({ active: false, reason: "live-3103-blocked" });
      expect(prepareForwardCausalIdentity(order(), { ...base, PORT: "3103", FOUR_BRAIN_LOGICAL_ROLE: "RESEARCH" } as NodeJS.ProcessEnv)).toBeNull();
    });

    it("[fail-closed, unknown role string] an unrecognized FOUR_BRAIN_LOGICAL_ROLE value is treated as no grant at all — never a silent wildcard authorization", () => {
      const dir = mkdtempSync(join(tmpdir(), "causal-role-unknown-")); dirs.push(dir);
      const env: NodeJS.ProcessEnv = { PORT: "3111", FOUR_BRAIN_LOGICAL_ROLE: "ADMIN", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir, END_TO_END_CORRECTNESS_DEPLOYED_AT: DEPLOYMENT_AT };
      expect(resolveCausalCollectionActivation(env)).toMatchObject({ active: false, reason: "unknown-instance-fail-closed" });
    });

    it("[restart, role-based] a persisted role-authorized identity is re-validated on every read, exactly like the 3101/3102 path — a role that has since been revoked or changed invalidates it, never silently reused", () => {
      const dir = mkdtempSync(join(tmpdir(), "causal-role-restart-")); dirs.push(dir);
      const env: NodeJS.ProcessEnv = { PORT: "3111", FOUR_BRAIN_LOGICAL_ROLE: "RESEARCH", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir, END_TO_END_CORRECTNESS_DEPLOYED_AT: DEPLOYMENT_AT };
      const o = order();
      o.causalIdentity = prepareForwardCausalIdentity(o, env);
      expect(o.causalIdentity).not.toBeNull();
      // "Restart" with the exact same role: identity is reused byte-for-byte, never re-minted.
      expect(prepareForwardCausalIdentity(o, env)).toEqual(o.causalIdentity);
      // "Restart" with the role since revoked (operator turned the grant off): the persisted identity
      // is now stale and must not be reused — mirrors the existing policy-version staleness behavior.
      const { FOUR_BRAIN_LOGICAL_ROLE: _drop, ...revoked } = env;
      expect(prepareForwardCausalIdentity(o, revoked as NodeJS.ProcessEnv)).toBeNull();
      // "Restart" with the role changed to TESTNET: also stale, never silently migrated to the new role.
      expect(prepareForwardCausalIdentity(o, { ...env, FOUR_BRAIN_LOGICAL_ROLE: "TESTNET" })).toBeNull();
    });
  });

  it("refuses to mint a forward identity without all exact current policy stamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-policy-")); dirs.push(dir);
    const env = shadowEnv(dir);
    expect(prepareForwardCausalIdentity({ ...order(), executionPolicyVersion: "stale" }, env)).toBeNull();
  });

  it("rejects decisions and opens before the actual deployment boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-boundary-")); dirs.push(dir);
    const env = shadowEnv(dir);
    expect(prepareForwardCausalIdentity({ ...order(), firstSeenAt: new Date(400).toISOString() }, env)).toBeNull();
    expect(prepareForwardCausalIdentity({ ...order(), openedAt: new Date(400).toISOString() }, env)).toBeNull();
    expect(prepareForwardCausalIdentity(order(), env)).not.toBeNull();
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

  it("rejects an arithmetically inconsistent gross/cost/net outcome", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-cost-invariant-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order(); o.causalIdentity = prepareForwardCausalIdentity(o, env);
    expect(recordForwardOpportunity(o, env)).toBe(true);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000;
    o.grossR = 0.3; o.costR = -0.02; o.netR = 0.3; // must be 0.28
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
    o.scanBatchId = "cortex-batch-1";
    o.cortexDecisionSnapshot = {
      decisionId: "cortex-decision:900:1:CG_WIDE_FAST_LONG",
      allocationSnapshotId: "cortex-allocation:cortex-decision:900:1:CG_WIDE_FAST_LONG",
      atMs: 900,
      laneId: "CG_WIDE_FAST_LONG",
      direction: "LONG",
      featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
      featureVector: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0.5],
      regimeFamily: "BULL",
      eligible: true,
      finalPct: 0,
      evalFinalPct: 0,
      scanBatchId: "cortex-batch-1", sourceScanBatchId: "cortex-batch-1",
    };
    o.cortexDecisionId = o.cortexDecisionSnapshot.decisionId;
    o.cortexAllocationSnapshotId = o.cortexDecisionSnapshot.allocationSnapshotId;
    o.canonicalCortexLaneId = o.cortexDecisionSnapshot.laneId;
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    expect(o.causalIdentity).toMatchObject({
      cortexDecisionId: o.cortexDecisionSnapshot.decisionId,
      allocationSnapshotId: o.cortexDecisionSnapshot.allocationSnapshotId,
    });
    recordForwardOpportunity(o, env);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.2; o.costR = -0.02; o.netR = 0.18;
    o.causalIdentity = withResolvedCausalIdentity(o);
    recordForwardOutcome(o, env);
    const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ForwardCausalEvent);
    const bridge = buildCortexExperienceBridge(events, resolveCanonicalPolicyContext(env)!);
    expect(bridge.experiences).toHaveLength(1);
    expect(bridge.outcomes).toHaveLength(1);
    expect(bridge.outcomes[0]?.decisionId).toBe(o.cortexDecisionSnapshot.decisionId);
    expect(bridge.rejected).toEqual({});
    const decision = events.find((event) => event.eventType === "DECISION_SNAPSHOT") as Extract<ForwardCausalEvent, { eventType: "DECISION_SNAPSHOT" }>;
    expect(decision.cortexTraining.snapshotAtMs).toBe(o.cortexDecisionSnapshot.atMs);
    expect(decision.cortexTraining.snapshotAtMs).toBeLessThanOrEqual(decision.asOfMs);
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
      decisionId: "cortex-decision:900:1:CG_WIDE_FAST_LONG", allocationSnapshotId: "cortex-allocation:cortex-decision:900:1:CG_WIDE_FAST_LONG", atMs: 900, laneId: "CG_WIDE_FAST_LONG", direction: "LONG",
      featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION, featureVector: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0.5],
      regimeFamily: "BULL", eligible: true, finalPct: 0, evalFinalPct: 0,
    };
    o.cortexDecisionId = o.cortexDecisionSnapshot.decisionId;
    o.cortexAllocationSnapshotId = o.cortexDecisionSnapshot.allocationSnapshotId;
    o.causalIdentity = prepareForwardCausalIdentity(o, env); recordForwardOpportunity(o, env);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.2; o.costR = -0.02; o.netR = 0.18;
    o.causalIdentity = withResolvedCausalIdentity(o); recordForwardOutcome(o, env);
    const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ForwardCausalEvent);
    const legacy = events.map((event) => event.eventType === "DECISION_SNAPSHOT"
      ? (() => { const { cortexTraining: _removed, ...row } = event; return row as ForwardCausalEvent; })()
      : event);
    const expectedPolicy = resolveCanonicalPolicyContext(env)!;
    expect(buildCortexExperienceBridge(legacy, expectedPolicy).outcomes).toEqual([]);
    expect(buildCortexExperienceBridge(legacy, expectedPolicy).rejected).toMatchObject({ missing_or_incompatible_cortex_snapshot: 1 });
  });

  it("fails open on journal failure without mutating the incumbent order", () => {
    const o = order(); const env = shadowEnv("/dev/null");
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    const before = JSON.parse(JSON.stringify(o));
    expect(recordForwardOpportunity(o, env)).toBe(false);
    expect(o).toEqual(before);
  });
});

// Closes the bypass where `if (order.causalIdentity) return order.causalIdentity;` reused a
// persisted identity unconditionally. Every case here starts from a MINTED, valid identity so a
// failure necessarily comes from the currently-valid check, not from an incidentally-malformed
// fixture.
describe("closes the stale-identity-reuse bypass", () => {
  it("rejects a persisted identity minted under an earlier decision-policy / evidence-era generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-v1-identity-")); dirs.push(dir);
    const env = shadowEnv(dir);
    const current = prepareForwardCausalIdentity(order(), env)!;
    expect(current).not.toBeNull();
    const v1Identity = { ...current, decisionPolicyVersion: "policy-v1-legacy", evidenceEra: "POST_END_TO_END_CORRECTNESS_FIX_V1" };
    expect(prepareForwardCausalIdentity({ ...order(), causalIdentity: v1Identity }, env)).toBeNull();
  });

  it("rejects a persisted identity stamped with a deployment boundary that is no longer current", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-stale-cutover-")); dirs.push(dir);
    const env = shadowEnv(dir);
    const current = prepareForwardCausalIdentity(order(), env)!;
    const staleDeployment = { ...current, policyDeploymentAt: "1970-01-01T00:00:00.100Z" };
    expect(prepareForwardCausalIdentity({ ...order(), causalIdentity: staleDeployment }, env)).toBeNull();
  });

  it("rejects a persisted identity whose instance, lane, symbol, or direction no longer matches the order", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-mismatch-")); dirs.push(dir);
    const env = shadowEnv(dir);
    const current = prepareForwardCausalIdentity(order(), env)!;
    expect(prepareForwardCausalIdentity({ ...order(), causalIdentity: { ...current, instanceId: "some-other-instance" } }, env)).toBeNull();
    expect(prepareForwardCausalIdentity({ ...order(), causalIdentity: { ...current, laneId: "OTHER_LANE" } }, env)).toBeNull();
    expect(prepareForwardCausalIdentity({ ...order(), causalIdentity: { ...current, symbolOrBasketId: "ETHUSDT" } }, env)).toBeNull();
    expect(prepareForwardCausalIdentity({ ...order(), causalIdentity: { ...current, direction: "SHORT" } }, env)).toBeNull();
  });

  it("reuses an exact current identity by reference instead of minting a replacement", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-reuse-")); dirs.push(dir);
    const env = shadowEnv(dir);
    const identity = prepareForwardCausalIdentity(order(), env)!;
    const rehydrated = { ...order(), causalIdentity: identity };
    expect(prepareForwardCausalIdentity(rehydrated, env)).toBe(identity); // same object: never re-minted
  });

  it("never mints a V2 identity for an order whose decision predates the deployment boundary, even on repeated calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-precutover-")); dirs.push(dir);
    const env = shadowEnv(dir);
    const preCutover: ForwardPaperOrderLike = {
      ...order(),
      firstSeenAt: new Date(100).toISOString(), createdAt: new Date(100).toISOString(), openedAt: new Date(200).toISOString(),
    };
    expect(prepareForwardCausalIdentity(preCutover, env)).toBeNull();
    expect(prepareForwardCausalIdentity(preCutover, env)).toBeNull(); // not a one-shot fluke
    expect(preCutover.causalIdentity).toBeUndefined(); // never silently attached
  });

  it("refuses to emit open or outcome events for a stale identity attached to a rehydrated order", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-stale-events-")); dirs.push(dir);
    const env = shadowEnv(dir);
    const current = prepareForwardCausalIdentity(order(), env)!;
    const stale = { ...current, decisionPolicyVersion: "policy-v1-legacy", evidenceEra: "POST_END_TO_END_CORRECTNESS_FIX_V1" };
    // Simulates a persisted/rehydrated order exactly as it would be read back from a store after a
    // restart: the identity is already attached and never re-derived via prepareForwardCausalIdentity.
    const o: ForwardPaperOrderLike = { ...order(), causalIdentity: stale };
    expect(recordForwardOpportunity(o, env)).toBe(false);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.2; o.costR = -0.02; o.netR = 0.18;
    expect(recordForwardOutcome(o, env)).toBe(false);
    expect(existsSync(join(dir, "causal-experience"))).toBe(false);
  });

  it("rejects a self-consistent but stale-policy forged event chain at the CORTEX bridge boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-forged-")); dirs.push(dir);
    const env = shadowEnv(dir); const o = order();
    o.cortexDecisionSnapshot = {
      decisionId: "cortex-decision:900:1:CG_WIDE_FAST_LONG", allocationSnapshotId: "cortex-allocation:cortex-decision:900:1:CG_WIDE_FAST_LONG",
      atMs: 900, laneId: "CG_WIDE_FAST_LONG", direction: "LONG", featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
      featureVector: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0.5], regimeFamily: "BULL", eligible: true, finalPct: 0, evalFinalPct: 0,
    };
    o.cortexDecisionId = o.cortexDecisionSnapshot.decisionId;
    o.cortexAllocationSnapshotId = o.cortexDecisionSnapshot.allocationSnapshotId;
    o.causalIdentity = prepareForwardCausalIdentity(o, env);
    recordForwardOpportunity(o, env);
    o.paperStatus = "PAPER_CLOSED_WIN"; o.closedAtMs = 2_000; o.resolvedAtMs = 3_000; o.grossR = 0.2; o.costR = -0.02; o.netR = 0.18;
    o.causalIdentity = withResolvedCausalIdentity(o);
    recordForwardOutcome(o, env);
    const events = readFileSync(forwardCausalJournalPath(env)!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ForwardCausalEvent);
    // Forge: every event's embedded identity is downgraded to a stale policy generation while the
    // decisionId/opportunityId linkage between decision/opportunity/outcome stays self-consistent.
    const forged = events.map((event) => ({
      ...event,
      identity: { ...event.identity, decisionPolicyVersion: "policy-v1-legacy", evidenceEra: "POST_END_TO_END_CORRECTNESS_FIX_V1" },
    })) as ForwardCausalEvent[];
    const bridge = buildCortexExperienceBridge(forged, resolveCanonicalPolicyContext(env)!);
    expect(bridge.experiences).toEqual([]);
    expect(bridge.outcomes).toEqual([]);
    expect(bridge.rejected).toMatchObject({ stale_or_mismatched_policy_identity: 1 });
  });

  it("keeps 3103 blocked even when the order already carries an exact-current-looking identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-3103-")); dirs.push(dir);
    const shadow = shadowEnv(dir);
    const identity = prepareForwardCausalIdentity(order(), shadow)!;
    const liveEnv = { ...shadow, PORT: "3103" };
    const o: ForwardPaperOrderLike = { ...order(), causalIdentity: { ...identity, instanceId: "3103" } };
    expect(prepareForwardCausalIdentity(o, liveEnv)).toBeNull();
    expect(recordForwardOpportunity(o, liveEnv)).toBe(false);
    expect(existsSync(join(dir, "causal-experience"))).toBe(false);
  });

  it("writes nothing in mode-off even when the order already carries an existing identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "causal-modeoff-")); dirs.push(dir);
    const shadow = shadowEnv(dir);
    const identity = prepareForwardCausalIdentity(order(), shadow)!;
    const modeOffEnv = { ...shadow, CAUSAL_EXPERIENCE_COLLECTION_MODE: "" };
    const o: ForwardPaperOrderLike = { ...order(), causalIdentity: identity };
    expect(resolveCausalCollectionActivation(modeOffEnv).reason).toBe("mode-off");
    expect(prepareForwardCausalIdentity(o, modeOffEnv)).toBeNull();
    expect(recordForwardOpportunity(o, modeOffEnv)).toBe(false);
    expect(existsSync(join(dir, "causal-experience"))).toBe(false);
  });
});

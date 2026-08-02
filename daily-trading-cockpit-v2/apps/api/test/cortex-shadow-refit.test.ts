import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { emptyCortexState } from "../src/lib/cortex-brain.js";
import {
  CORTEX_SHADOW_REFIT_DEFAULT_EPOCH,
  CORTEX_SHADOW_REFIT_HYPERPARAMETERS,
  CortexShadowRefitRegistryStore,
  buildCortexShadowTrainingDataset,
  compareCortexShadowPrediction,
  cortexShadowRefitReadiness,
  planCortexShadowRefit,
  runCortexShadowRefit,
} from "../src/lib/cortex-shadow-refit.js";
import type { ExecutiveReviewOutcome } from "../src/lib/executive-review-store.js";
import type { CanonicalPolicyContext, ForwardEvent } from "../src/experience-engine/forward-causal-collection.js";
import {
  _resetCortexProductionChainDiagnosticsForTests,
  cortexProductionChainDiagnostics,
} from "../src/lib/cortex-production-chain-diagnostics.js";

const epochMs = Date.parse(CORTEX_SHADOW_REFIT_DEFAULT_EPOCH);
const policy: CanonicalPolicyContext & { instanceId: "3102"; fourBrainPolicyVersion: string } = {
  instanceId: "3102", decisionPolicyVersion: "decision/v1", executionPolicyVersion: "execution/v1",
  evidencePolicyVersion: "evidence/v1", evidenceEra: "era/v1", fourBrainPolicyVersion: "four/v1",
  policyDeploymentAt: CORTEX_SHADOW_REFIT_DEFAULT_EPOCH,
};
const dirs: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), "cortex-shadow-refit-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function x(index: number): number[] { return [1, index % 2 ? 0.4 : -0.4, 0.1, 0.2, 0.6, 0.1, 0.2, 0, 0, 0.7]; }

function row(index: number, overrides: Partial<ExecutiveReviewOutcome> = {}): { outcome: ExecutiveReviewOutcome; events: ForwardEvent[] } {
  const decisionTimeMs = epochMs + index * 60_000;
  const openedTimeMs = decisionTimeMs + 1_000;
  const closedTimeMs = openedTimeMs + 1_000;
  const cortexId = `cortex-${index}`;
  const opportunityId = `opp-${index}`;
  const outcomeId = `executive-out-${index}`;
  const paperOutcomeId = `paper-out-${index}`;
  const allocationSnapshotId = `allocation-${index}`;
  const identity = {
    lineageSchemaVersion: "causal-lineage-1" as const, decisionId: `paper-${index}`, opportunityId, outcomeId: null,
    instanceId: policy.instanceId, laneId: "CG_WIDE_FAST_LONG", symbolOrBasketId: index % 3 ? "BTCUSDT" : "ETHUSDT", direction: "LONG" as const,
    featureSchemaVersion: "1", decisionRuleVersion: "rule", attributionRuleVersion: "attr", cortexDecisionId: cortexId,
    allocationSnapshotId, canonicalCortexLaneId: "CG_WIDE_FAST_LONG", cortexFeatureSchemaVersion: 1, decisionPolicyVersion: policy.decisionPolicyVersion,
    executionPolicyVersion: policy.executionPolicyVersion, evidencePolicyVersion: policy.evidencePolicyVersion,
    evidenceEra: policy.evidenceEra, policyDeploymentAt: policy.policyDeploymentAt,
  };
  const outcome = {
    executiveReviewOutcomeId: `review-out-${index}`, executiveReviewId: `review-${index}`, tier: "TIER_1_REAL",
    candidateId: `candidate-${index}`, opportunityId, executionIntentId: `intent-${index}`, orderId: `order-${index}`,
    positionId: `position-${index}`, outcomeId, marketContextSnapshotId: `market-${index}`, allocationSnapshotId, canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    laneId: "CG_WIDE_FAST_LONG", direction: "LONG", marketState: "BULLISH", evidenceEra: policy.evidenceEra,
    strategyAction: "ENTER", advisoryVerdict: "VALID", incumbentAction: "ENTERED", advisoryOnly: true,
    entryAtMs: openedTimeMs, resolvedAtMs: closedTimeMs + 1_000, originalRisk: 100, grossR: index % 2 ? 0.32 : -0.18,
    costR: 0.02, executionCostProvenance: "EXCHANGE_MEASURED", settlementFetchComplete: true,
    requiredOrderIds: [`order-${index}`], matchedRequiredOrderIds: [`order-${index}`], missingRequiredOrderIds: [],
    netR: index % 2 ? 0.30 : -0.20, decisionPipelinePolicyVersion: policy.decisionPolicyVersion,
    executionPolicyVersion: policy.executionPolicyVersion, evidencePolicyVersion: policy.evidencePolicyVersion,
    fourBrainPolicyVersion: policy.fourBrainPolicyVersion, eligibleForFourBrainEvaluation: true, eligibleForCortexLearning: false,
    executiveDecisionId: `exec-${index}`, instanceId: policy.instanceId, symbolOrBasketId: identity.symbolOrBasketId,
    policyDeploymentAt: policy.policyDeploymentAt, executiveDecisionTimeMs: openedTimeMs,
    marketStateDecision: { decisionId: `ms-${index}` }, directionDecision: { decisionId: `dir-${index}`, marketDirection: "LONG" },
    entryDecision: { decisionId: `entry-${index}`, action: "ENTER_NOW", side: "LONG", targetEntry: 100, initialStopPrice: 90 },
    brainFeatureSnapshot: { cycle: index }, brainFeatureSchemaVersions: { executive: "four/v1" },
    sourceStatuses: { marketState: { candle: "FRESH" }, direction: { candle: "FRESH" }, entry: { candle: "FRESH" } },
    entryDecisionId: `entry-${index}`, paperOrderId: `paper-order-${index}`, decidedSide: "LONG", decidedTargetEntry: 100,
    decidedInitialStop: 90, entryFilledAtMs: openedTimeMs, confirmedEntryFillOrderIds: [`order-${index}`],
    confirmedEntryTradeIds: [`trade-${index}`], actualEntryPrice: 100, marketClosedAtMs: closedTimeMs,
    settlementResolvedAtMs: closedTimeMs + 1_000, exactCloseTimeMs: closedTimeMs,
    ...overrides,
  } as unknown as ExecutiveReviewOutcome;
  const resolvedIdentity = { ...identity, outcomeId: paperOutcomeId };
  const events = [
    {
      eventType: "DECISION_SNAPSHOT", eventId: `decision-event-${index}`, identity, asOfMs: decisionTimeMs, reportOnly: true,
      codeVersion: "test", marketState: { regime: "BULLISH", status: "PRESENT" },
      directionDecision: { direction: "LONG", controllerMode: "LONG" }, entryDecision: { entryPrice: 100, stopLoss: 90, takeProfitLevels: [110], plannedStopDistanceBps: 100 },
      cortexRecommendation: { status: "MISSING", value: null }, incumbentDecision: { status: "PRESENT", value: "incumbent" },
      features: { names: [], values: [], availableAtMs: [], sourceStatuses: { candle: "FRESH" } },
      cortexTraining: { status: "PRESENT", decisionId: cortexId, featureSchemaVersion: 1, featureVector: x(index), snapshotAtMs: decisionTimeMs - 1, regimeFamily: "BULLISH", eligible: true, finalPct: 0, evalFinalPct: 0 },
      provenance: { originKey: `origin-${index}`, sourceObservationId: `source-${index}`, missingFields: [] },
    },
    { eventType: "OPPORTUNITY_OPEN", eventId: `open-event-${index}`, identity, decisionId: identity.decisionId, openedAtMs: openedTimeMs, entryPrice: 100, stopDistance: 10, expectedCostAssumptions: { costR: 0.02, feeSlippageR: 0.02, spreadR: 0 }, provenance: { sourceObservationId: `source-${index}`, originKey: `origin-${index}` }, reportOnly: true },
    // Forward causal records use signed costR (gross + negative cost = net); Executive Review uses
    // the canonical positive cost magnitude. Both are exact representations of the same settlement.
    { eventType: "OUTCOME_RESOLUTION", eventId: `out-event-${index}`, identity: resolvedIdentity, outcomeId: paperOutcomeId, opportunityId, decisionId: identity.decisionId, openedAtMs: openedTimeMs, closedAtMs: closedTimeMs, resolvedAtMs: closedTimeMs + 1_000, grossR: outcome.grossR, costR: -outcome.costR, netR: outcome.netR, exitReason: "TP", intrabarAmbiguous: false, outcomeQuality: "RESOLVED_VALID", directAttribution: "DIRECT_CAUSAL_LINK", reportOnly: true },
  ] as unknown as ForwardEvent[];
  return { outcome, events };
}

function dataset(count = 1, mutate?: (outcome: ExecutiveReviewOutcome, events: ForwardEvent[]) => void) {
  const rows = Array.from({ length: count }, (_, index) => row(index + 1));
  for (const item of rows) mutate?.(item.outcome, item.events);
  return { outcomes: rows.map((item) => item.outcome), forwardEvents: rows.flatMap((item) => item.events) };
}
function build(count = 1, mutate?: (outcome: ExecutiveReviewOutcome, events: ForwardEvent[]) => void) {
  const input = dataset(count, mutate);
  return buildCortexShadowTrainingDataset({ ...input, policy, nowMs: epochMs + 99_999_999 });
}

describe("CORTEX shadow refit learner v1", () => {
  it("keeps pre-reset, Tier-2, evaluation-only, incomplete, unknown, duplicate, stale, and missing-feature records out", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const pre = row(1, { executiveDecisionTimeMs: epochMs - 1 });
    const tier2 = row(2, { tier: "TIER_2_COUNTERFACTUAL" });
    const missingFeature = row(3); (missingFeature.events[0] as any).cortexTraining.featureVector = null;
    const incomplete = row(4, { missingRequiredOrderIds: ["order-4"] as [] });
    const unknown = row(5); (unknown.events[0] as any).cortexTraining.regimeFamily = "UNKNOWN_CONTEXT";
    const stale = row(6, { evidencePolicyVersion: "old" });
    const valid = row(7);
    const result = buildCortexShadowTrainingDataset({ outcomes: [pre.outcome, tier2.outcome, missingFeature.outcome, incomplete.outcome, unknown.outcome, stale.outcome, valid.outcome, valid.outcome], forwardEvents: [...pre.events, ...tier2.events, ...missingFeature.events, ...incomplete.events, ...unknown.events, ...stale.events, ...valid.events], policy, nowMs: epochMs + 99_999_999 });
    expect(result.examples).toHaveLength(1);
    expect(result.archivedPreEpoch).toBe(1);
    expect(result.rejected.PRE_RESET_EPOCH).toBe(1);
    expect(result.rejected.FOUR_BRAIN_NOT_DIRECT).toBeGreaterThanOrEqual(2);
    expect(result.rejected.INVALID_OR_INCOMPLETE_COST).toBe(1);
    expect(result.rejected.UNKNOWN_CONTEXT).toBe(1);
    expect(result.rejected.DUPLICATE_OUTCOME).toBe(1);
    // Point 11: report-only — recorded exactly once, matching the single accepted example, never
    // once per rejected/duplicate/pre-epoch row.
    expect(cortexProductionChainDiagnostics().CORTEX_LEARNER_ELIGIBLE).toBe(1);
  });

  it("fails closed with separate stable reasons for a missing or incompatible CORTEX feature schema", () => {
    const missing = build(1, (_outcome, events) => { (events[0] as any).cortexTraining.featureVector = null; });
    const incompatible = build(1, (_outcome, events) => { (events[0] as any).cortexTraining.featureSchemaVersion = 99; });
    expect(missing.examples).toHaveLength(0);
    expect(missing.rejected.MISSING_EXACT_CORTEX_SNAPSHOT).toBe(1);
    expect(incompatible.examples).toHaveLength(0);
    expect(Object.values(incompatible.rejected).reduce((total, count) => total + count, 0)).toBeGreaterThan(0);
  });

  it("is deterministic, hashes exact examples, and uses the original event-time snapshot", () => {
    const first = build(3); const second = build(3);
    expect(first.datasetHash).toBe(second.datasetHash);
    expect(first.examples).toEqual(second.examples);
    expect(first.examples[0]!.x).toEqual(x(1));
    expect(first.examples[0]!.cortexDecisionTimeMs).toBe(epochMs + 60_000 - 1);
    expect(first.examples[0]!.paperAdmissionTimeMs).toBe(epochMs + 60_000);
    expect(first.examples[0]!.decisionTimeMs).toBeLessThan(first.examples[0]!.openedTimeMs);
  });

  it("returns a healthy no-refit audit for an empty fresh epoch with both betas exactly zero", () => {
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const report = runCortexShadowRefit({ ...dataset(0), policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 1 });
    expect(report.status).toBe("NO_REFIT");
    expect(report.beta).toEqual({ evaluationBeta: 0, liveBeta: 0 });
    expect(cortexShadowRefitReadiness(registry.get()).directLearningEligible).toBe(0);
  });

  it("persists a candidate atomically, never changes incumbent, and is idempotent for the same data", () => {
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const incumbent = emptyCortexState(); const before = JSON.stringify(incumbent);
    const input = dataset(44);
    const first = runCortexShadowRefit({ ...input, policy, incumbent, registry, nowMs: epochMs + 200_000_000, codeVersion: "test" });
    expect(first.status).toBe("CANDIDATE_CREATED");
    expect(registry.get().candidates).toHaveLength(1);
    expect(JSON.stringify(incumbent)).toBe(before);
    const second = runCortexShadowRefit({ ...input, policy, incumbent, registry, nowMs: epochMs + 200_000_000, codeVersion: "test" });
    expect(second.status).toBe("NO_NEW_ELIGIBLE_DATA");
    expect(registry.get().candidates).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "registry.json"), "utf8")).candidates).toHaveLength(1);
  });

  it("freezes full-fit candidate content at the evidence cutoff, not invocation wall time", () => {
    const input = dataset(44); const incumbent = emptyCortexState();
    const first = planCortexShadowRefit({ ...input, policy, incumbent, registry: new CortexShadowRefitRegistryStore(join(temp(), "registry.json")), nowMs: epochMs + 200_000_000, codeVersion: "test" });
    const second = planCortexShadowRefit({ ...input, policy, incumbent, registry: new CortexShadowRefitRegistryStore(join(temp(), "registry.json")), nowMs: epochMs + 900_000_000, codeVersion: "test" });
    expect(first.report.candidate).toEqual(second.report.candidate);
  });

  it("creates a new candidate only when eligible data changes and rejects corrupted stored registry", () => {
    const dir = temp(); const file = join(dir, "registry.json"); const registry = new CortexShadowRefitRegistryStore(file);
    const first = dataset(44); const incumbent = emptyCortexState();
    runCortexShadowRefit({ ...first, policy, incumbent, registry, nowMs: epochMs + 200_000_000 });
    const second = dataset(45);
    runCortexShadowRefit({ ...second, policy, incumbent, registry, nowMs: epochMs + 210_000_000 });
    expect(registry.get().candidates).toHaveLength(2);
    writeFileSync(file, "{not-json");
    const recovered = new CortexShadowRefitRegistryStore(file).get();
    expect(recovered.integrityStatus).toBe("REGISTRY_CORRUPTED");
    expect(recovered.candidates).toHaveLength(2); // recovered from the last known valid .bak
  });

  it("fails closed when raw, bridge, and reconstructed CORTEX vectors do not match exactly", () => {
    const input = dataset(1);
    const conflicting = structuredClone(input.forwardEvents[0] as any);
    conflicting.cortexTraining.featureVector[1] += 0.001;
    input.forwardEvents.push(conflicting);
    const result = buildCortexShadowTrainingDataset({ ...input, policy, nowMs: epochMs + 99_999_999 });
    expect(result.examples).toHaveLength(0);
    expect(Object.values(result.rejected).reduce((total, count) => total + count, 0)).toBeGreaterThan(0);
  });

  it("rejects mismatched CORTEX identity and policy lineage rather than falling back", () => {
    const identityMismatch = dataset(1);
    const duplicate = structuredClone(identityMismatch.forwardEvents[0] as any);
    duplicate.identity.cortexDecisionId = "another-cortex-decision";
    identityMismatch.forwardEvents.push(duplicate);
    expect(buildCortexShadowTrainingDataset({ ...identityMismatch, policy, nowMs: epochMs + 99_999_999 }).examples).toHaveLength(0);

    const policyMismatch = dataset(1);
    (policyMismatch.forwardEvents[0] as any).identity.executionPolicyVersion = "wrong-policy";
    expect(buildCortexShadowTrainingDataset({ ...policyMismatch, policy, nowMs: epochMs + 99_999_999 }).examples).toHaveLength(0);
  });

  it("joins one exact economic chain while retaining the independent paper outcome namespace", () => {
    const input = dataset(1);
    const forwardOutcome = input.forwardEvents.find((event) => event.eventType === "OUTCOME_RESOLUTION") as any;
    // Deliberately make the paper economics wildly different. The canonical example must retain
    // the Executive Review net R, not substitute the paper resolver's accounting.
    forwardOutcome.grossR = 9; forwardOutcome.costR = -1; forwardOutcome.netR = 8;
    const accepted = buildCortexShadowTrainingDataset({ ...input, policy, nowMs: epochMs + 99_999_999 });
    expect(accepted.examples).toHaveLength(1);
    expect(accepted.examples[0]?.outcomeId).toBe(input.outcomes[0]?.outcomeId);
    expect(accepted.examples[0]?.netR).toBe(input.outcomes[0]?.netR);
    expect((input.forwardEvents[0] as any).identity.outcomeId).toBeNull();
    expect((input.forwardEvents[1] as any).identity.outcomeId).toBeNull();
    expect(forwardOutcome.outcomeId).not.toBe(input.outcomes[0]?.outcomeId);

    const noPaperResolution = buildCortexShadowTrainingDataset({
      ...input,
      forwardEvents: input.forwardEvents.filter((event) => event.eventType !== "OUTCOME_RESOLUTION"),
      policy,
      nowMs: epochMs + 99_999_999,
    });
    expect(noPaperResolution.examples).toHaveLength(1);
    expect(noPaperResolution.examples[0]?.netR).toBe(input.outcomes[0]?.netR);

    for (const mutate of [
      (row: any) => { row.opportunityId = "other-opportunity"; },
      (row: any) => { row.allocationSnapshotId = "other-allocation"; },
    ]) {
      const mismatched = dataset(1);
      mutate(mismatched.outcomes[0]);
      const rejected = buildCortexShadowTrainingDataset({ ...mismatched, policy, nowMs: epochMs + 99_999_999 });
      expect(rejected.examples).toHaveLength(0);
      // The upstream direct-outcome guard may reject first; either way this cannot borrow the
      // original opportunity/allocation chain through a similarity fallback.
      expect(Object.values(rejected.rejected).reduce((total, count) => total + count, 0)).toBeGreaterThan(0);
    }
  });

  it("keeps independent symbol opportunities eligible when they share one immutable allocation snapshot", () => {
    const first = row(1);
    const second = row(2);
    const sharedAllocation = "allocation-shared";
    for (const item of [first, second]) {
      item.outcome.allocationSnapshotId = sharedAllocation;
      for (const event of item.events) (event as any).identity.allocationSnapshotId = sharedAllocation;
    }
    const result = buildCortexShadowTrainingDataset({
      outcomes: [first.outcome, second.outcome],
      forwardEvents: [...first.events.filter((event) => event.eventType !== "OUTCOME_RESOLUTION"), ...second.events.filter((event) => event.eventType !== "OUTCOME_RESOLUTION")],
      policy,
      nowMs: epochMs + 99_999_999,
    });
    expect(result.examples).toHaveLength(2);
    expect(new Set(result.examples.map((example) => example.opportunityId))).toEqual(new Set([first.outcome.opportunityId, second.outcome.opportunityId]));
  });

  it("rejects a CORTEX chain whose snapshot, admission, fill, close, and settlement clocks are out of order", () => {
    const input = dataset(1);
    const outcome = input.outcomes[0]!;
    outcome.marketClosedAtMs = outcome.entryAtMs - 1;
    const rejected = buildCortexShadowTrainingDataset({ ...input, policy, nowMs: epochMs + 99_999_999 });
    expect(rejected.examples).toHaveLength(0);
    expect(rejected.rejected.CORTEX_CAUSAL_CLOCK_ORDER_INVALID).toBe(1);
  });

  it("requires the exact lane, symbol, direction, and instance identity rather than a nearest snapshot", () => {
    for (const [field, value] of [
      ["laneId", "CG_WIDE_FAST_SHORT"],
      ["symbolOrBasketId", "SOLUSDT"],
      ["direction", "SHORT"],
    ] as const) {
      const input = dataset(1);
      const conflicting = structuredClone(input.forwardEvents[0] as any);
      conflicting.identity[field] = value;
      input.forwardEvents.push(conflicting);
      const result = buildCortexShadowTrainingDataset({ ...input, policy, nowMs: epochMs + 99_999_999 });
      expect(result.examples).toHaveLength(0);
      expect(Object.values(result.rejected).reduce((total, count) => total + count, 0)).toBeGreaterThan(0);
    }
    const wrongInstance = dataset(1);
    const conflicting = structuredClone(wrongInstance.forwardEvents[0] as any);
    conflicting.identity.instanceId = "3101";
    wrongInstance.forwardEvents.push(conflicting);
    expect(buildCortexShadowTrainingDataset({ ...wrongInstance, policy, nowMs: epochMs + 99_999_999 }).examples).toHaveLength(0);
  });

  it("uses purged chronological OOS folds without opportunity overlap or future training", () => {
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const report = runCortexShadowRefit({ ...dataset(44), policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 200_000_000 });
    const folds = report.candidate!.archetypes[0]!.folds;
    expect(folds).toHaveLength(3);
    for (const fold of folds) {
      expect(fold.trainEndMs).toBeLessThan(fold.oosStartMs!);
      expect(fold.trainN).toBeGreaterThanOrEqual(20);
      expect(fold.oosN).toBeGreaterThanOrEqual(8);
      expect(fold.trainExampleIds).toHaveLength(fold.trainN);
      expect(new Set(fold.heldOut.map((row) => row.exampleId)).size).toBe(fold.heldOut.length);
      expect(fold.heldOut.some((row) => fold.trainExampleIds.includes(row.exampleId))).toBe(false);
    }
    const heldOut = folds.flatMap((fold) => fold.heldOut);
    expect(report.candidate!.archetypes[0]!.oos.n).toBe(heldOut.length);
    expect(new Set(heldOut.map((row) => row.exampleId)).size).toBe(heldOut.length);
    const predicted = heldOut.filter((row) => row.candidatePrediction != null);
    const expectedCandidateMae = predicted.reduce((total, row) => total + Math.abs(row.candidatePrediction! - row.netR), 0) / predicted.length;
    expect(report.candidate!.archetypes[0]!.oos.calibrationMae).toBeCloseTo(expectedCandidateMae);
  });

  it("freezes fold recency weighting at the training cutoff, not the held-out end time", () => {
    const baselineInput = dataset(44);
    const delayedInput = structuredClone(baselineInput);
    const delayMs = 365 * 86_400_000;
    for (let index = 20; index < delayedInput.outcomes.length; index += 1) {
      const outcome = delayedInput.outcomes[index]! as any;
      outcome.marketClosedAtMs += delayMs;
      outcome.settlementResolvedAtMs += delayMs;
      outcome.exactCloseTimeMs += delayMs;
      outcome.resolvedAtMs += delayMs;
    }
    for (let index = 20 * 3; index < delayedInput.forwardEvents.length; index += 3) {
      const outcome = delayedInput.forwardEvents[index + 2] as any;
      outcome.closedAtMs += delayMs;
      outcome.resolvedAtMs += delayMs;
    }
    const hyperparameters = { ...CORTEX_SHADOW_REFIT_HYPERPARAMETERS, halfLifeDays: 1, minEffectiveN: 1 } as any;
    const baseline = runCortexShadowRefit({ ...baselineInput, policy, incumbent: emptyCortexState(), registry: new CortexShadowRefitRegistryStore(join(temp(), "baseline.json")), nowMs: epochMs + 400_000_000, hyperparameters });
    const delayed = runCortexShadowRefit({ ...delayedInput, policy, incumbent: emptyCortexState(), registry: new CortexShadowRefitRegistryStore(join(temp(), "delayed.json")), nowMs: epochMs + 800_000_000, hyperparameters });
    const baselineFold = baseline.candidate!.archetypes[0]!.folds[0]!;
    const delayedFold = delayed.candidate!.archetypes[0]!.folds[0]!;
    expect(baselineFold.trainingCutoffMs).toBe(baselineFold.trainEndMs);
    expect(delayedFold.trainingCutoffMs).toBe(delayedFold.trainEndMs);
    expect(baselineFold.trainingCutoffMs).toBeLessThan(baselineFold.oosStartMs!);
    expect(delayedFold.trainingCutoffMs).toBeLessThan(delayedFold.oosStartMs!);
    expect(delayedFold.heldOut.map((row) => row.candidatePrediction)).toEqual(baselineFold.heldOut.map((row) => row.candidatePrediction));
  });

  it("applies purgeMs to held-out membership instead of leaving it as unused configuration", () => {
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const report = runCortexShadowRefit({
      ...dataset(44), policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 200_000_000,
      hyperparameters: { ...CORTEX_SHADOW_REFIT_HYPERPARAMETERS, purgeMs: 60_001 },
    });
    for (const fold of report.candidate!.archetypes[0]!.folds) expect(fold.oosN).toBe(7);
  });

  it("derives the dataset-wide training cutoff from the true max resolvedTimeMs, not the last-decided example (point 8)", () => {
    // dataset.examples is sorted by cortexDecisionTimeMs. Row 5 is decided early (5th) but given an
    // overlapping, very long hold; row 44 is decided last but resolves on the normal short schedule.
    // If the cutoff were naively taken from the last-by-decision-order example (the old bug), it
    // would read row 44's (early) resolvedTimeMs and completely miss row 5's later resolution.
    const overlapDelayMs = 2_500_000; // long enough that row 5's resolution lands after row 44's
    const input = dataset(44, (outcome, events) => {
      if (outcome.opportunityId !== "opp-5") return;
      (outcome as any).marketClosedAtMs += overlapDelayMs;
      (outcome as any).settlementResolvedAtMs += overlapDelayMs;
      (outcome as any).exactCloseTimeMs += overlapDelayMs;
      (outcome as any).resolvedAtMs += overlapDelayMs;
      const resolution = events.find((event) => event.eventType === "OUTCOME_RESOLUTION") as any;
      resolution.closedAtMs += overlapDelayMs;
      resolution.resolvedAtMs += overlapDelayMs;
    });
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const report = runCortexShadowRefit({ ...input, policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 900_000_000 });
    const row5 = report.dataset.examples.find((example) => example.opportunityId === "opp-5")!;
    const lastDecided = report.dataset.examples.at(-1)!; // row 44 — last by cortexDecisionTimeMs sort
    const trueMaxResolvedTimeMs = Math.max(...report.dataset.examples.map((example) => example.resolvedTimeMs));
    // Sanity: the scenario genuinely inverts decision order vs. resolution order.
    expect(lastDecided.opportunityId).toBe("opp-44");
    expect(row5.resolvedTimeMs).toBeGreaterThan(lastDecided.resolvedTimeMs);
    expect(trueMaxResolvedTimeMs).toBe(row5.resolvedTimeMs);
    expect(report.candidate!.trainingCutoffMs).toBe(trueMaxResolvedTimeMs);
    expect(report.candidate!.trainingCutoffMs).not.toBe(lastDecided.resolvedTimeMs);
  });

  it("orders fold membership by decision time but gates training inclusion by resolution time, with no leak into an earlier fold (point 7)", () => {
    // Row 5 is decided early (falls inside every fold's decision-time training window by index) but
    // given a long overlapping hold; row 44 is decided last (never falls inside any fold's training
    // window) and resolves on the normal short schedule — decided later, resolved earlier.
    const overlapDelayMs = 1_900_000; // resolves after fold 0/1's cutoff and after row 36's normal
    // resolution, but before fold 2's evidence cutoff — late enough to become fold 2's true max.
    const input = dataset(44, (outcome, events) => {
      if (outcome.opportunityId !== "opp-5") return;
      (outcome as any).marketClosedAtMs += overlapDelayMs;
      (outcome as any).settlementResolvedAtMs += overlapDelayMs;
      (outcome as any).exactCloseTimeMs += overlapDelayMs;
      (outcome as any).resolvedAtMs += overlapDelayMs;
      const resolution = events.find((event) => event.eventType === "OUTCOME_RESOLUTION") as any;
      resolution.closedAtMs += overlapDelayMs;
      resolution.resolvedAtMs += overlapDelayMs;
    });
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const report = runCortexShadowRefit({ ...input, policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 900_000_000 });
    const row5 = report.dataset.examples.find((example) => example.opportunityId === "opp-5")!;
    const row44 = report.dataset.examples.find((example) => example.opportunityId === "opp-44")!;
    const folds = report.candidate!.archetypes[0]!.folds;
    expect(folds).toHaveLength(3);
    // Chronology follows decision time: row 5's decision places it inside every fold's training
    // window (it is never held out), while row 44's decision is too late to ever enter a training
    // window (it is never a training candidate for any fold).
    for (const fold of folds) {
      expect(fold.trainExampleIds).not.toContain(row44.exampleId);
      expect(fold.heldOut.some((held) => held.exampleId === row5.exampleId)).toBe(false);
    }
    // Evidence availability follows resolution time: row 5 is excluded from the first two folds
    // because it had not yet resolved by their evidence cutoffs — no future-resolved outcome leaks
    // into an earlier fold — and becomes trainable once the third fold's cutoff passes its actual
    // resolution.
    expect(folds[0]!.trainExampleIds).not.toContain(row5.exampleId);
    expect(folds[1]!.trainExampleIds).not.toContain(row5.exampleId);
    expect(folds[2]!.trainExampleIds).toContain(row5.exampleId);
    // The fold's reported trainingCutoffMs must be the true max resolvedTimeMs among the rows it
    // actually trained on — never accidentally taken from whichever row happens to be last by
    // decision order inside the window (row 5 sits early in decision order yet, once included,
    // dominates fold 2's true cutoff).
    for (const fold of folds) {
      if (fold.trainN === 0) continue;
      const trainRows = fold.trainExampleIds.map((id) => report.dataset.examples.find((example) => example.exampleId === id)!);
      const trueCutoff = Math.max(...trainRows.map((row) => row.resolvedTimeMs));
      expect(fold.trainingCutoffMs).toBe(trueCutoff);
    }
    expect(folds[2]!.trainingCutoffMs).toBe(row5.resolvedTimeMs);
  });

  it("fingerprints incumbent generation, coefficient state, hyperparameters, and code version", () => {
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const input = dataset(44); const base = emptyCortexState();
    const first = runCortexShadowRefit({ ...input, policy, incumbent: base, incumbentGeneration: 7, registry, nowMs: epochMs + 200_000_000, codeVersion: "a" });
    const shifted = structuredClone(base); shifted.archetypes.BREADTH.w[1] = 0.2;
    const second = runCortexShadowRefit({ ...input, policy, incumbent: shifted, incumbentGeneration: 8, registry, nowMs: epochMs + 201_000_000, codeVersion: "a" });
    const third = runCortexShadowRefit({ ...input, policy, incumbent: shifted, incumbentGeneration: 8, registry, nowMs: epochMs + 202_000_000, codeVersion: "b", hyperparameters: { ...CORTEX_SHADOW_REFIT_HYPERPARAMETERS, ridge: 2 } });
    expect(first.candidate!.generationId).not.toBe(second.candidate!.generationId);
    expect(second.candidate!.generationId).not.toBe(third.candidate!.generationId);
    expect(third.candidate!.parentIncumbentGeneration).toBe(8);
  });

  it("updates audit freshness for new rejected rows without making another candidate", () => {
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const firstInput = dataset(44); const incumbent = emptyCortexState();
    runCortexShadowRefit({ ...firstInput, policy, incumbent, registry, nowMs: epochMs + 200_000_000 });
    const rejected = row(99, { executiveDecisionTimeMs: epochMs - 1 });
    const second = runCortexShadowRefit({ outcomes: [...firstInput.outcomes, rejected.outcome], forwardEvents: [...firstInput.forwardEvents, ...rejected.events], policy, incumbent, registry, nowMs: epochMs + 201_000_000 });
    expect(second.status).toBe("NO_NEW_ELIGIBLE_DATA");
    expect(registry.get().candidates).toHaveLength(1);
    expect(registry.get().lastAudit!.dataset.examined).toBe(45);
    expect(registry.get().lastAudit!.dataset.rejected.PRE_RESET_EPOCH).toBe(1);
  });

  it("detects modified candidate contents and exposes an explicit corrupted registry blocker", () => {
    const dir = temp(); const file = join(dir, "registry.json"); const registry = new CortexShadowRefitRegistryStore(file);
    const input = dataset(44);
    runCortexShadowRefit({ ...input, policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 200_000_000 });
    const tampered = JSON.parse(readFileSync(file, "utf8")); tampered.candidates[0].archetypes[0].coefficients[0] += 1;
    writeFileSync(file, JSON.stringify(tampered));
    const recovered = new CortexShadowRefitRegistryStore(file);
    expect(recovered.get().integrityStatus).toBe("REGISTRY_CORRUPTED");
    expect(recovered.get().candidates).toHaveLength(1);
    const blocked = runCortexShadowRefit({ ...input, policy, incumbent: emptyCortexState(), registry: recovered, nowMs: epochMs + 201_000_000 });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockers).toContain("REGISTRY_CORRUPTED");
  });

  it("detects tampered audit/readiness fields even when every candidate remains intact", () => {
    const dir = temp(); const file = join(dir, "registry.json"); const registry = new CortexShadowRefitRegistryStore(file);
    const input = dataset(44);
    runCortexShadowRefit({ ...input, policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 200_000_000 });
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.lastAudit.dataset.examined += 100;
    tampered.lastAudit.status = "NO_NEW_ELIGIBLE_DATA";
    writeFileSync(file, JSON.stringify(tampered));
    const recovered = new CortexShadowRefitRegistryStore(file);
    expect(recovered.get().integrityStatus).toBe("REGISTRY_CORRUPTED");
    expect(recovered.get().candidates).toHaveLength(1);
    expect(recovered.get().lastAudit!.dataset.examined).toBe(44); // valid .bak, not forged readiness
  });

  it("fails closed for insufficient effective evidence instead of inventing zero coefficients", () => {
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const report = runCortexShadowRefit({ ...dataset(4), policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 200_000_000 });
    expect(report.status).toBe("NO_REFIT");
    expect(report.candidate!.archetypes[0]!.fitStatus).toBe("INSUFFICIENT_DATA");
    expect(report.candidate!.archetypes[0]!.coefficients).toEqual(emptyCortexState().archetypes.BREADTH.w);
  });

  it("keeps an extreme target bounded by the robust fit movement cap", () => {
    const input = dataset(44);
    input.outcomes[43] = { ...input.outcomes[43]!, grossR: 100, netR: 99.98 };
    const dir = temp(); const registry = new CortexShadowRefitRegistryStore(join(dir, "registry.json"));
    const report = runCortexShadowRefit({ ...input, policy, incumbent: emptyCortexState(), registry, nowMs: epochMs + 200_000_000 });
    const breadth = report.candidate!.archetypes[0]!;
    expect(breadth.coefficientMaxDelta).toBeLessThanOrEqual(8);
    expect(breadth.coefficients.every(Number.isFinite)).toBe(true);
  });

  it("reports comparison only and keeps scheduler/promotion/authority off", () => {
    const comparison = compareCortexShadowPrediction({ x: [1, 2], incumbent: [0, 0], candidate: [0.1, 0.2], context: "BULLISH" });
    expect(comparison).toMatchObject({ reportOnly: true, incumbentPrediction: 0, candidatePrediction: 0.5, decisionDelta: 0.5 });
    expect(process.env.CORTEX_SHADOW_REFIT_SCHEDULER_ENABLED).not.toBe("1");
  });
});
